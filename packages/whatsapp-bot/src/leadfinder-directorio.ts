/**
 * Directorios — buscador de negocios B2B local con telefono + web + ubicacion.
 *
 * Estrategia 100% datos publicos:
 *   1. OpenStreetMap Nominatim (no Google Maps directo — riesgo TOS): mismo
 *      patron de leadfinder.ts via Nominatim + Overpass para descubrir
 *      negocios por nicho+ciudad. NO usamos Google Maps directo (riesgo TOS).
 *   2. (Opcional) Yelp Fusion: si el tenant tiene una API key en settings
 *      (`leads.yelp.apiKey`, NO global), enriquecemos con rating + categorias.
 *      Si no hay API key, solo Nominatim/scrape.
 *   3. Scrape ligero de la web del negocio (cuando OSM la trae) para extraer
 *      email/redes, reutilizando scrapeSite() de leadfinder.ts.
 *
 * Persistencia: dbSaveLeadJob (misma tabla app_lead_jobs) → multi-tenant via
 * tenant_id auto desde workspace ALS. Estado/progreso identico al patron de
 * leadfinder.ts (queued → discovering → scraping → done/error).
 */
import crypto from "node:crypto";
import { TrabajosVivos } from "./leadfinder.js";
import {
  dbSaveLeadJob,
  dbGetLeadJob,
  dbListLeadJobs,
  type Lead,
  type LeadJob,
} from "./db.js";
import { scrapeSite, mapLimit } from "./leadfinder.js";
import { touchContact, enrichContact, setStage } from "./contacts.js";
import { logActivity } from "./activity.js";
import { get as getSetting } from "./settings.js";

const NOMINATIM = "https://nominatim.openstreetmap.org";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 DirectorioFinder/1.0";
const FETCH_TIMEOUT_MS = 15_000;
const SCRAPE_CONCURRENCY = Number(process.env.LEADFINDER_CONCURRENCY || 6);
const MAX_LIMIT = 80;

// Nichos comunes → filtros OSM. Subconjunto del de leadfinder.ts (los mas
// pedidos en B2B local). Cualquier valor no listado cae a busqueda por nombre.
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
};

interface Bbox { s: number; n: number; w: number; e: number; }
interface DirectorioRow {
  osmId: string;
  name: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  rating: number | null;     // viene de Yelp si esta enriquecido
  categories: string[];      // viene de Yelp si esta enriquecido
}

async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function geocodeCity(city: string): Promise<{ bbox: Bbox; displayName: string }> {
  const url = `${NOMINATIM}/search?` + new URLSearchParams({ q: city, format: "json", limit: "1" });
  const res = await fetchTimeout(url, { headers: { "User-Agent": UA } }, FETCH_TIMEOUT_MS);
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
      }, FETCH_TIMEOUT_MS);
      if (!res.ok) { lastErr = `${endpoint} -> ${res.status}`; continue; }
      return await res.json();
    } catch (err) {
      lastErr = `${endpoint} -> ${(err as Error).message}`;
    }
  }
  throw new Error(`Overpass no disponible (${lastErr})`);
}

function normalizeOsm(el: any): DirectorioRow | null {
  const t = el.tags || {};
  if (!t.name) return null;
  const website = t.website || t["contact:website"] || t.url || t["contact:url"] || null;
  const email = t.email || t["contact:email"] || null;
  const phone = t.phone || t["contact:phone"] || t["contact:mobile"] || null;
  const address = [t["addr:street"], t["addr:housenumber"], t["addr:city"]].filter(Boolean).join(" ") || null;
  return {
    osmId: `${el.type}/${el.id}`,
    name: String(t.name).slice(0, 200),
    website: website ? String(website).split(";")[0].trim() : null,
    email: email ? String(email).split(";")[0].trim().toLowerCase() : null,
    phone: phone ? String(phone).split(";")[0].trim() : null,
    address,
    rating: null,
    categories: [],
  };
}

async function discover(niche: string, city: string, limit: number): Promise<{ area: string; rows: DirectorioRow[] }> {
  const geo = await geocodeCity(city);
  const data = await runOverpass(buildOverpassQuery(niche, geo.bbox, limit));
  const seen = new Set<string>();
  const rows: DirectorioRow[] = [];
  for (const el of (data.elements || []) as any[]) {
    const r = normalizeOsm(el);
    if (!r) continue;
    const dk = (r.name + (r.website || "")).toLowerCase();
    if (seen.has(dk)) continue;
    seen.add(dk);
    rows.push(r);
    if (rows.length >= limit) break;
  }
  return { area: geo.displayName, rows };
}

// ----------- Yelp Fusion (opcional) -----------
// API key SOLO por tenant via getSetting('leads.yelp.apiKey'). NO leemos
// process.env aqui — la key vive en settings por workspace.
async function enrichWithYelp(rows: DirectorioRow[], city: string, niche: string): Promise<void> {
  const key = getSetting("leads.yelp.apiKey", "");
  if (!key) return; // sin API key opcional → omitir enriquecimiento sin error
  try {
    const url = "https://api.yelp.com/v3/businesses/search?" + new URLSearchParams({
      term: niche, location: city, limit: "50",
    });
    const res = await fetchTimeout(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    }, FETCH_TIMEOUT_MS);
    if (!res.ok) return;
    const data = (await res.json()) as { businesses?: Array<{ name?: string; rating?: number; phone?: string; categories?: Array<{ title?: string }> }> };
    const byName = new Map<string, { rating?: number; phone?: string; categories: string[] }>();
    for (const b of data.businesses || []) {
      if (!b.name) continue;
      byName.set(String(b.name).toLowerCase(), {
        rating: typeof b.rating === "number" ? b.rating : undefined,
        phone: b.phone || undefined,
        categories: (b.categories || []).map((c) => c.title || "").filter(Boolean),
      });
    }
    for (const r of rows) {
      const m = byName.get(r.name.toLowerCase());
      if (!m) continue;
      if (typeof m.rating === "number") r.rating = m.rating;
      if (!r.phone && m.phone) r.phone = m.phone;
      if (m.categories.length) r.categories = m.categories.slice(0, 4);
    }
  } catch {
    // Yelp es enriquecimiento opcional — un fallo NO debe parar el job.
  }
}

// ----------- Runner de jobs -----------
// LEADFINDER-TENANT-1: el progreso en vivo solo lo ve el workspace que lo lanzó.
const active = new TrabajosVivos();

function rowToLead(r: DirectorioRow, scrape: { emails: string[]; socials: Record<string, string> }): Lead {
  const emails = new Set(scrape.emails);
  if (r.email) emails.add(r.email);
  return {
    name: r.name,
    website: r.website,
    emails: [...emails],
    phone: r.phone,
    address: r.address,
    socials: scrape.socials,
  };
}

async function runJob(job: LeadJob, niche: string, city: string): Promise<void> {
  try {
    job.status = "discovering";
    await dbSaveLeadJob(job);
    const { area, rows } = await discover(niche, city, job.total || 40);
    job.area = area;
    job.total = rows.length;
    if (rows.length === 0) {
      job.status = "done";
      await dbSaveLeadJob(job);
      active.delete(job.id);
      return;
    }
    // Enriquece con Yelp si hay API key — best effort.
    await enrichWithYelp(rows, city, niche);

    job.status = "scraping";
    await dbSaveLeadJob(job);

    const withSites = rows.filter((r) => r.website);
    let scraped = 0;
    const scrapedByOsm = new Map<string, { emails: string[]; socials: Record<string, string> }>();
    await mapLimit(withSites, SCRAPE_CONCURRENCY, async (r) => {
      const sc = await scrapeSite(r.website as string);
      scrapedByOsm.set(r.osmId, sc);
      job.scraped = ++scraped;
    });

    job.results = rows.map((r) => rowToLead(r, scrapedByOsm.get(r.osmId) || { emails: [], socials: {} }));
    job.with_email = job.results.filter((r) => r.emails.length > 0).length;
    job.status = "done";
    await dbSaveLeadJob(job);

    await logActivity({
      source: "lead-job",
      level: "info",
      status: "done",
      summary: `Directorios ${niche}/${city}: ${job.total} encontrados (${job.with_email} con email)`,
      payload: { file: "leadfinder-directorio.ts", fn: "runJob", jobId: job.id, niche, city },
    });
  } catch (err) {
    job.status = "error";
    job.error = (err as Error).message || String(err);
    await dbSaveLeadJob(job);
    await logActivity({
      source: "lead-job",
      level: "error",
      status: "error",
      summary: `Directorios ${niche}/${city} fallo: ${(job.error || "").slice(0, 160)}`,
      payload: {
        file: "leadfinder-directorio.ts",
        fn: "runJob",
        jobId: job.id,
        niche,
        city,
        scraped: job.scraped,
        total: job.total,
        error: (job.error || "").slice(0, 400),
      },
    });
  } finally {
    active.delete(job.id);
  }
}

export function startDirectorioSearch(
  niche: string,
  city: string,
  opts: { limit?: number } = {},
): string {
  const id = crypto.randomUUID().slice(0, 12);
  const cleanNiche = (niche || "").trim();
  const cleanCity = (city || "").trim();
  const job: LeadJob = {
    id,
    niche: "dir:" + cleanNiche.slice(0, 60),
    city: cleanCity.slice(0, 200),
    status: "queued",
    area: "",
    total: Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? 40)),
    scraped: 0,
    with_email: 0,
    results: [],
    error: "",
    created_at: Date.now(),
  };
  active.set(id, job);
  void runJob(job, cleanNiche, cleanCity).catch(async (e) => {
    job.status = "error";
    job.error = (e as Error).message || String(e);
    await dbSaveLeadJob(job);
    active.delete(id);
  });
  return id;
}

export async function getDirectorioJob(id: string): Promise<LeadJob | null> {
  const live = active.get(id);
  if (live) return live;
  const stored = await dbGetLeadJob(id);
  if (!stored) return null;
  if (stored.status === "queued" || stored.status === "discovering" || stored.status === "scraping") {
    stored.status = "error";
    stored.error = "Busqueda interrumpida por un reinicio del servidor. Vuelve a lanzarla.";
  }
  return stored;
}

export async function listDirectorioJobs(limit = 30, opts?: { tenantId?: string }): Promise<LeadJob[]> {
  // SEC-1bis: propaga tenantId al store (filtra app_lead_jobs por tenant_id en SQL).
  // Backward-compat: si caller no pasa opts, dbListLeadJobs filtra por undefined
  // (sin WHERE tenant_id) — el guard del admin igual abre scope ALS y al
  // insertar via dbSaveLeadJob ya queda marcado el tenant correcto.
  const stored = await dbListLeadJobs(limit * 3, opts);
  return stored
    .filter((j) => (j.niche || "").startsWith("dir:"))
    .slice(0, limit)
    .map((j) => active.get(j.id) ?? j);
}

function sanitizePhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, "");
  return digits.length >= 8 ? digits : null;
}

function tagify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9aeiounes ]/gi, "").replace(/\s+/g, "-").slice(0, 30);
}

export async function importDirectorioLeads(
  jobId: string,
  indices: number[],
  stage: string,
): Promise<{ imported: number; withPhone: number }> {
  const job = await getDirectorioJob(jobId);
  if (!job) throw new Error("Busqueda no encontrada");
  const nicheLabel = (job.niche || "").replace(/^dir:/, "");
  const tags = [tagify(nicheLabel), tagify(job.city), "lead", "directorio"].filter(Boolean);
  let imported = 0;
  let withPhone = 0;
  const wanted = new Set(indices);
  for (let i = 0; i < job.results.length; i++) {
    if (!wanted.has(i)) continue;
    const lead = job.results[i];
    const phone = sanitizePhone(lead.phone);
    const email = lead.emails[0] || "";
    const key = phone || `lead:${email || lead.website || lead.name || crypto.randomUUID().slice(0, 8)}`;
    const fields: Record<string, string> = { fuente: "directorio" };
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
