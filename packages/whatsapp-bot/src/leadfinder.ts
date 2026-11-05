/**
 * Buscador de leads. Descubre negocios por nicho + ciudad usando OpenStreetMap
 * (Nominatim geocodifica la ciudad; Overpass devuelve los negocios) y extrae
 * emails / redes de sus webs. Los resultados se pueden importar al CRM.
 *
 * Sin claves de API. Los jobs se persisten en Postgres (app_lead_jobs); el
 * progreso en vivo se mantiene en memoria mientras corren.
 */
import crypto from "node:crypto";
import { currentWorkspaceId } from "./workspace.js";
import {
  dbSaveLeadJob,
  dbGetLeadJob,
  dbListLeadJobs,
  type Lead,
  type LeadJob,
} from "./db.js";
import { touchContact, enrichContact, setStage } from "./contacts.js";
import { logActivity } from "./activity.js";

const NOMINATIM = "https://nominatim.openstreetmap.org";
// Se prueban en orden; el primero que responde JSON válido gana.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 LeadFinder/1.0";
const SCRAPE_CONCURRENCY = Number(process.env.LEADFINDER_CONCURRENCY || 6);
const FETCH_TIMEOUT_MS = 12000;
const DISCOVERY_TIMEOUT_MS = 25000;
const MAX_LIMIT = 80;

// fetch con corte por tiempo: un mirror muerto no debe colgar la búsqueda.
async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Nichos comunes → filtros de etiquetas OSM. Si no hay match, busca por nombre.
const NICHE_FILTERS: Record<string, string[]> = {
  restaurant: ["amenity=restaurant"], restaurante: ["amenity=restaurant"], restaurantes: ["amenity=restaurant"],
  cafe: ["amenity=cafe"], cafeteria: ["amenity=cafe"],
  bar: ["amenity=bar", "amenity=pub"], pub: ["amenity=pub", "amenity=bar"],
  hotel: ["tourism=hotel"], hoteles: ["tourism=hotel"],
  dentist: ["amenity=dentist", "healthcare=dentist"], dentista: ["amenity=dentist", "healthcare=dentist"], dentistas: ["amenity=dentist", "healthcare=dentist"],
  clinica: ["amenity=clinic", "healthcare=clinic"],
  gym: ["leisure=fitness_centre"], gimnasio: ["leisure=fitness_centre"], gimnasios: ["leisure=fitness_centre"],
  pharmacy: ["amenity=pharmacy"], farmacia: ["amenity=pharmacy"], farmacias: ["amenity=pharmacy"],
  hairdresser: ["shop=hairdresser"], peluqueria: ["shop=hairdresser"], peluquerias: ["shop=hairdresser"],
  bakery: ["shop=bakery"], panaderia: ["shop=bakery"],
  lawyer: ["office=lawyer"], abogado: ["office=lawyer"], abogados: ["office=lawyer"],
  realestate: ["office=estate_agent"], inmobiliaria: ["office=estate_agent"], inmobiliarias: ["office=estate_agent"],
  veterinary: ["amenity=veterinary"], veterinario: ["amenity=veterinary"],
  spa: ["leisure=spa", "shop=beauty"], beauty: ["shop=beauty"], estetica: ["shop=beauty"],
};

// ---------------- Descubrimiento (OpenStreetMap) ----------------

interface Bbox { s: number; n: number; w: number; e: number; }

async function geocodeCity(city: string): Promise<{ bbox: Bbox; displayName: string }> {
  const url = `${NOMINATIM}/search?` + new URLSearchParams({ q: city, format: "json", limit: "1" });
  const res = await fetchTimeout(url, { headers: { "User-Agent": UA } }, DISCOVERY_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = (await res.json()) as Array<{ boundingbox: string[]; display_name: string }>;
  if (!data.length) throw new Error(`Ciudad no encontrada: "${city}"`);
  const [s, n, w, e] = data[0].boundingbox.map(Number);
  return { bbox: { s, n, w, e }, displayName: data[0].display_name };
}

function buildOverpassQuery(niche: string, bbox: Bbox, limit: number): string {
  const box = `(${bbox.s},${bbox.w},${bbox.n},${bbox.e})`;
  const key = niche.toLowerCase().trim();
  const filters = NICHE_FILTERS[key];
  let body: string;
  if (filters) {
    body = filters
      .map((f) => { const [k, v] = f.split("="); return `  nwr["${k}"="${v}"]${box};`; })
      .join("\n");
  } else {
    const kw = key.replace(/["\\]/g, "\\$&");
    body = ["shop", "amenity", "office", "craft", "leisure", "tourism", "healthcare"]
      .map((cat) => `  nwr["name"~"${kw}",i]["${cat}"]${box};`)
      .join("\n");
  }
  return `[out:json][timeout:30];\n(\n${body}\n);\nout center tags ${limit};`;
}

async function runOverpass(query: string): Promise<any> {
  const body = new URLSearchParams({ data: query }).toString();
  let lastErr = "sin respuesta";
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchTimeout(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": UA,
        },
        body,
      }, DISCOVERY_TIMEOUT_MS);
      if (!res.ok) { lastErr = `${endpoint} → ${res.status}`; continue; }
      return await res.json();
    } catch (err) {
      lastErr = `${endpoint} → ${(err as Error).message}`;
    }
  }
  throw new Error(`Overpass no disponible (${lastErr})`);
}

function normalizeBusiness(el: any): {
  osmId: string; name: string | null; website: string | null;
  osmEmail: string | null; phone: string | null; address: string | null;
} {
  const t = el.tags || {};
  const website = t.website || t["contact:website"] || t.url || t["contact:url"] || null;
  const email = t.email || t["contact:email"] || null;
  const phone = t.phone || t["contact:phone"] || t["contact:mobile"] || null;
  return {
    osmId: `${el.type}/${el.id}`,
    name: t.name || t["name:en"] || null,
    website: website ? String(website).split(";")[0].trim() : null,
    osmEmail: email ? String(email).split(";")[0].trim() : null,
    phone: phone ? String(phone).split(";")[0].trim() : null,
    address: [t["addr:street"], t["addr:housenumber"], t["addr:city"]].filter(Boolean).join(" ") || null,
  };
}

async function discover(niche: string, city: string, limit: number) {
  const geo = await geocodeCity(city);
  const data = await runOverpass(buildOverpassQuery(niche, geo.bbox, limit));
  const seen = new Set<string>();
  const businesses: ReturnType<typeof normalizeBusiness>[] = [];
  for (const el of data.elements || []) {
    const b = normalizeBusiness(el);
    if (!b.name) continue;
    const dk = (b.name + (b.website || "")).toLowerCase();
    if (seen.has(dk)) continue;
    seen.add(dk);
    businesses.push(b);
    if (businesses.length >= limit) break;
  }
  return { area: geo.displayName, businesses };
}

// ---------------- Scraper de webs (emails + redes, sin dependencias) -------

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const JUNK_EMAIL = [
  "example.com", "example.org", "sentry.io", "wixpress.com", "wix.com",
  "yourdomain", "domain.com", "email.com", "googleapis", "schema.org",
  "w3.org", "@2x", "@3x", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  "core-js", "polyfill",
];
const SOCIAL_HOSTS: Record<string, RegExp> = {
  instagram: /instagram\.com\/([A-Za-z0-9_.]+)/i,
  facebook: /facebook\.com\/([A-Za-z0-9_.\-]+)/i,
  twitter: /(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i,
  linkedin: /linkedin\.com\/(?:company|in)\/([A-Za-z0-9_\-%.]+)/i,
  tiktok: /tiktok\.com\/@([A-Za-z0-9_.]+)/i,
  youtube: /youtube\.com\/(?:@|channel\/|c\/|user\/)?([A-Za-z0-9_\-]+)/i,
};

export function normalizeUrl(raw: string): string | null {
  if (!raw) return null;
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return null; }
}

export async function fetchHtml(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isJunkEmail(email: string): boolean {
  if (email.length > 80) return true;
  return JUNK_EMAIL.some((j) => email.includes(j));
}

export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  const mailtoRe = /mailto:([^"'?>\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRe.exec(html))) {
    const e = decodeURIComponent(m[1]).toLowerCase();
    if (!isJunkEmail(e)) found.add(e);
  }
  for (const raw of html.match(EMAIL_RE) || []) {
    const e = raw.toLowerCase();
    if (!isJunkEmail(e)) found.add(e);
  }
  return [...found];
}

export function extractSocials(html: string): Record<string, string> {
  const socials: Record<string, string> = {};
  for (const [name, re] of Object.entries(SOCIAL_HOSTS)) {
    const match = html.match(re);
    if (match) {
      const handle = match[1];
      if (handle && !["sharer", "share", "intent", "home"].includes(handle))
        socials[name] = match[0].startsWith("http") ? match[0] : "https://" + match[0];
    }
  }
  return socials;
}

// Busca un enlace de contacto (regex, sin parser). Devuelve URL absoluta.
function findContactLink(html: string, baseUrl: string): string | null {
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const kws = ["contact", "contacto", "about", "nosotros", "aviso", "legal"];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").toLowerCase();
    const hay = (href + " " + text).toLowerCase();
    if (kws.some((k) => hay.includes(k))) {
      try { return new URL(href, baseUrl).toString(); } catch { /* ignore */ }
    }
  }
  return null;
}

export async function scrapeSite(rawUrl: string): Promise<{ emails: string[]; socials: Record<string, string> }> {
  const url = normalizeUrl(rawUrl);
  if (!url) return { emails: [], socials: {} };
  const homeHtml = await fetchHtml(url);
  if (!homeHtml) return { emails: [], socials: {} };

  const emails = new Set(extractEmails(homeHtml));
  const socials = extractSocials(homeHtml);

  if (emails.size === 0) {
    const contactUrl = findContactLink(homeHtml, url);
    if (contactUrl && contactUrl !== url) {
      const contactHtml = await fetchHtml(contactUrl);
      if (contactHtml) {
        for (const e of extractEmails(contactHtml)) emails.add(e);
        Object.assign(socials, extractSocials(contactHtml));
      }
    }
  }
  return { emails: [...emails], socials };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------- Runner de jobs ----------------

/** LEADFINDER-TENANT-1 · Trabajos en curso, cada uno atado al workspace que lo lanzó.
 * La BD ya filtra por tenant; este mapa en memoria no lo hacía y devolvía el progreso
 * (y los resultados) de otro negocio a quien adivinara el id. */
export class TrabajosVivos {
  private m = new Map<string, { ws: string; job: LeadJob }>();
  set(id: string, job: LeadJob): void { this.m.set(id, { ws: currentWorkspaceId(), job }); }
  get(id: string): LeadJob | undefined {
    const e = this.m.get(id);
    return e && e.ws === currentWorkspaceId() ? e.job : undefined;
  }
  delete(id: string): void { this.m.delete(id); }
}

// Jobs en curso (progreso en vivo). Al terminar se persisten y se sueltan.
const active = new TrabajosVivos();

async function runJob(job: LeadJob): Promise<void> {
  try {
    job.status = "discovering";
    await dbSaveLeadJob(job);
    const { area, businesses } = await discover(job.niche, job.city, job.total || 40);
    job.area = area;
    job.total = businesses.length;
    if (businesses.length === 0) {
      job.status = "done";
      await dbSaveLeadJob(job);
      active.delete(job.id);
      return;
    }
    job.status = "scraping";
    await dbSaveLeadJob(job);

    const withSites = businesses.filter((b) => b.website);
    let scraped = 0;
    const scrapedByOsm = new Map<string, { emails: string[]; socials: Record<string, string> }>();
    await mapLimit(withSites, SCRAPE_CONCURRENCY, async (b) => {
      const r = await scrapeSite(b.website as string);
      scrapedByOsm.set(b.osmId, r);
      job.scraped = ++scraped;
    });

    job.results = businesses.map((b): Lead => {
      const sc = scrapedByOsm.get(b.osmId) || { emails: [], socials: {} };
      const emails = new Set(sc.emails);
      if (b.osmEmail) emails.add(b.osmEmail.toLowerCase());
      return {
        name: b.name, website: b.website, emails: [...emails],
        phone: b.phone, address: b.address, socials: sc.socials,
      };
    });
    job.with_email = job.results.filter((r) => r.emails.length > 0).length;
    job.status = "done";
    await dbSaveLeadJob(job);
  } catch (err) {
    job.status = "error";
    job.error = (err as Error).message || String(err);
    await dbSaveLeadJob(job);
    // FASE-5: telemetría — la búsqueda de leads reventó (Nominatim/Overpass/scrape/BD…).
    // tenant_id auto desde workspace ALS. NO logueamos emails ni results crudos.
    await logActivity({
      source: "lead-job",
      level: "error",
      status: "error",
      summary: `Búsqueda leads ${job.niche}/${job.city} falló: ${(job.error || "").slice(0, 160)}`,
      payload: {
        file: "leadfinder.ts",
        fn: "runJob",
        jobId: job.id,
        niche: job.niche,
        city: job.city,
        scraped: job.scraped,
        total: job.total,
        error: (job.error || "").slice(0, 400),
      },
    });
  } finally {
    active.delete(job.id);
  }
}

export function startLeadSearch(niche: string, city: string, limit: number): string {
  const job: LeadJob = {
    id: crypto.randomUUID().slice(0, 12),
    niche: niche.trim(),
    city: city.trim(),
    status: "queued",
    area: "",
    total: Math.max(1, Math.min(MAX_LIMIT, limit || 40)),
    scraped: 0,
    with_email: 0,
    results: [],
    error: "",
    created_at: Date.now(),
  };
  active.set(job.id, job);
  void runJob(job);
  return job.id;
}

export async function getLeadJob(id: string): Promise<LeadJob | null> {
  const live = active.get(id);
  if (live) return live;
  const stored = await dbGetLeadJob(id);
  if (!stored) return null;
  // Job que quedó "en curso" en BD pero ya no corre (reinicio del proceso).
  if (stored.status === "queued" || stored.status === "discovering" || stored.status === "scraping") {
    stored.status = "error";
    stored.error = "Búsqueda interrumpida por un reinicio del servidor. Vuelve a lanzarla.";
  }
  return stored;
}

export async function listLeadJobs(limit = 30): Promise<LeadJob[]> {
  const stored = await dbListLeadJobs(limit);
  // Superpone el progreso en vivo de los que aún corren.
  return stored.map((j) => active.get(j.id) ?? j);
}

// ---------------- Import al CRM ----------------

function sanitizePhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, "");
  return digits.length >= 8 ? digits : null;
}

export function tagify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9áéíóúñ ]/gi, "").replace(/\s+/g, "-").slice(0, 30);
}

export async function importLeads(
  jobId: string,
  indices: number[],
  stage: string,
): Promise<{ imported: number; withPhone: number }> {
  const job = await getLeadJob(jobId);
  if (!job) throw new Error("Búsqueda no encontrada");
  const tags = [tagify(job.niche), tagify(job.city), "lead"].filter(Boolean);
  let imported = 0;
  let withPhone = 0;
  const wanted = new Set(indices);
  for (let i = 0; i < job.results.length; i++) {
    if (!wanted.has(i)) continue;
    const lead = job.results[i];
    const phone = sanitizePhone(lead.phone);
    const email = lead.emails[0] || "";
    // Clave del contacto: teléfono real si lo hay; si no, sintética por email/web.
    const key = phone || `lead:${email || lead.website || lead.name || crypto.randomUUID().slice(0, 8)}`;
    const fields: Record<string, string> = { fuente: "buscador-leads" };
    if (email) fields.email = email;
    if (lead.emails.length > 1) fields.emails = lead.emails.join(", ");
    if (lead.website) fields.web = lead.website;
    if (lead.address) fields.direccion = lead.address;
    if (lead.phone) fields.telefono = lead.phone;
    for (const [k, vv] of Object.entries(lead.socials)) fields[k] = vv;

    await touchContact(key, lead.name || "", "");
    await enrichContact(key, { tags, fields });
    if (stage) await setStage(key, stage, { origin: "buscar-leads", reason: "Etapa elegida al importar una búsqueda de leads" });
    imported++;
    if (phone) withPhone++;
  }
  return { imported, withPhone };
}
