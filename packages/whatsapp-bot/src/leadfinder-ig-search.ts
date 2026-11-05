/**
 * Búsqueda de leads en Instagram **sin login**: aprovecha lo que Google ya
 * indexó de bios públicas. Buscamos perfiles site:instagram.com cuya bio
 * contenga un email visible y una keyword del nicho del competidor.
 *
 * No tocamos la cuenta de Instagram del user: no hay sesión IG, no hay
 * scraping de followers, no hay riesgo de baneo. Es lo único legítimamente
 * gratis que devuelve emails reales de personas interesadas en el nicho.
 *
 * Diferencia con leadfinder-competitor: aquél extrae emails de webs
 * enlazadas desde el competidor (≈ empresas relacionadas). Éste extrae
 * emails de PERSONAS/cuentas IG cuya bio menciona la keyword.
 *
 * Backend: Startpage (que es proxy anónimo de Google). DDG Lite, Bing y
 * Mojeek nos echan con captcha/cáscara vacía desde cualquier IP que no
 * parezca residencial. Startpage acepta nuestras queries sin login ni key.
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
import { extractEmails, mapLimit } from "./leadfinder.js";
import { touchContact, enrichContact, setStage } from "./contacts.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_LIMIT = 200;

// Dominios de email más comunes en ES + LATAM + algunos B2B. Cada dominio se
// usa como literal en la query para que el buscador devuelva snippets que YA
// contienen un email (no hace falta visitar el perfil IG).
const EMAIL_DOMAINS = [
  "@gmail.com",
  "@hotmail.com",
  "@outlook.com",
  "@yahoo.com",
  "@yahoo.es",
  "@hotmail.es",
  "@protonmail.com",
  "@icloud.com",
];

interface SearchHit {
  url: string;
  /** Texto plano con título + snippet de la página resultado. Aquí dentro
   *  ya buscamos emails. */
  text: string;
}

/**
 * Normaliza ofuscaciones suaves de emails que Google/Startpage insertan en
 * sus snippets (espacios alrededor de la @, "(at)", " at ", etc.) y separa
 * por espacios para que el regex de extractEmails coja el email entero.
 */
export function deobfuscateEmails(text: string): string {
  return text
    // "foo@ gmail.com" → "foo@gmail.com" (caso más común en Google)
    .replace(/([A-Za-z0-9._%+-]+)@\s+([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1@$2")
    // "foo @gmail.com"
    .replace(/([A-Za-z0-9._%+-]+)\s+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1@$2")
    // "foo (at) gmail.com" / "foo[at]gmail.com" / "foo {at} gmail.com"
    .replace(
      /([A-Za-z0-9._%+-]+)\s*[\(\[\{]\s*at\s*[\)\]\}]\s*([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi,
      "$1@$2",
    )
    // "foo (dot) gmail (dot) com" → "foo.gmail.com" (luego extractEmails
    // requerirá @, así que esto solo ayuda si el "(dot)" está después de
    // un dominio ya con @)
    .replace(
      /([A-Za-z0-9._%+-]+)\s*[\(\[\{]\s*dot\s*[\)\]\}]\s*([A-Za-z0-9.-]+)/gi,
      "$1.$2",
    );
}

/**
 * Startpage devuelve resultados de Google sin necesidad de API key ni login,
 * con UA estándar. Devuelve HTML denso (~350KB) con bloques `div.result`.
 * Vez de parsear bloques (clases con hashes que cambian), barremos cada
 * anchor a instagram.com y capturamos una ventana de ~2.5KB tras él, donde
 * típicamente cae el snippet con el email.
 */
async function startpageSearch(query: string): Promise<SearchHit[]> {
  const url =
    "https://www.startpage.com/do/search?query=" + encodeURIComponent(query);
  let html: string;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  }
  return parseStartpage(html);
}

/**
 * Parser ventana-céntrico: para cada anchor `<a href="https://...instagram.com/...">`
 * captura los siguientes ~2.5KB de HTML, limpia tags/estilos y devuelve el
 * texto plano resultante (donde estarán título + snippet del resultado).
 */
export function parseStartpage(html: string): SearchHit[] {
  const anchorRe =
    /<a [^>]*href=["'](https?:\/\/[^"']*instagram\.com\/[^"']+)["'][^>]*>/gi;
  const out: SearchHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) {
    const url = m[1];
    const start = m.index;
    const window = html.slice(start, Math.min(html.length, start + 2800));
    const text = window
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1200);
    out.push({ url, text });
  }
  return out;
}

/** Extrae el @handle de IG desde la URL de perfil. Filtra rutas no-perfil. */
export function igHandleFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "instagram.com" && !host.endsWith(".instagram.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) return null;
    const handle = parts[0].toLowerCase();
    // Rutas que NO son perfiles de usuario.
    if (
      [
        "p", "reel", "reels", "explore", "stories", "tv", "accounts",
        "developer", "about", "press", "directory", "web", "legal",
        "help", "fragment", "embed", "challenge",
      ].includes(handle)
    )
      return null;
    // Handles válidos según IG: letras, dígitos, _ y .
    if (!/^[a-z0-9._]{2,30}$/.test(handle)) return null;
    return handle;
  } catch {
    return null;
  }
}

// LEADFINDER-TENANT-1: el progreso en vivo solo lo ve el workspace que lo lanzó.
const active = new TrabajosVivos();

function buildQueries(seed: string): string[] {
  const q = seed.replace(/"/g, " ").trim();
  if (!q) return [];
  const list = EMAIL_DOMAINS.map(
    (d) => `site:instagram.com "${d}" "${q}"`,
  );
  // Genéricas: a veces el email cae bajo "contacto:" / "contact:" sin
  // dominio típico (custom domains, proton, fastmail, etc.).
  list.push(`site:instagram.com "contacto" "${q}" "@"`);
  list.push(`site:instagram.com "contact" "${q}" "@"`);
  list.push(`site:instagram.com "info" "${q}" "@"`);
  return list;
}

export function startIgSearch(
  seed: string,
  opts: { limit?: number } = {},
): string {
  const id = crypto.randomUUID().slice(0, 12);
  const cleanSeed = (seed || "").trim();
  const job: LeadJob = {
    id,
    niche: "ig-search:" + cleanSeed.slice(0, 60),
    city: cleanSeed.slice(0, 200),
    status: "queued",
    area: cleanSeed,
    total: Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? 50)),
    scraped: 0,
    with_email: 0,
    results: [],
    error: "",
    created_at: Date.now(),
  };
  active.set(id, job);
  void runIgSearchJob(job, cleanSeed).catch(async (e) => {
    job.status = "error";
    job.error = (e as Error).message || String(e);
    await dbSaveLeadJob(job);
    active.delete(id);
  });
  return id;
}

async function runIgSearchJob(job: LeadJob, seed: string): Promise<void> {
  try {
    if (!seed) {
      job.status = "error";
      job.error = "Keyword vacía. Pon un nicho, competidor o tema (p.ej. 'fitness coach Madrid').";
      await dbSaveLeadJob(job);
      return;
    }
    job.status = "discovering";
    await dbSaveLeadJob(job);

    const queries = buildQueries(seed);
    const allHits: SearchHit[] = [];
    job.status = "scraping";
    // Concurrencia 2: Startpage tolera bien volumen moderado pero un burst
    // de 11 queries instantáneas te puede meter en su rate-limit.
    await mapLimit(queries, 2, async (q) => {
      const hits = await startpageSearch(q);
      allHits.push(...hits);
      job.scraped = Math.min(allHits.length, job.total);
      await dbSaveLeadJob(job);
    });

    // Dedup por URL primero (Startpage repite el mismo perfil entre queries
    // distintas si matchea varios dominios de email).
    const byUrl = new Map<string, SearchHit>();
    for (const h of allHits) if (h.url && !byUrl.has(h.url)) byUrl.set(h.url, h);

    // Agrupamos primero por handle: en Startpage la misma cuenta aparece
    // varias veces (link título + link displayURL); cogemos el texto con
    // más caracteres como representante (más probable que tenga el snippet
    // con el email).
    const byHandle = new Map<string, SearchHit>();
    for (const hit of byUrl.values()) {
      const handle = igHandleFromUrl(hit.url);
      if (!handle) continue;
      const prev = byHandle.get(handle);
      if (!prev || hit.text.length > prev.text.length)
        byHandle.set(handle, { ...hit, url: `https://instagram.com/${handle}/` });
    }

    // Construimos leads. Dedup por email primario.
    const byEmail = new Map<string, Lead>();
    for (const [handle, hit] of byHandle) {
      const text = deobfuscateEmails(hit.text);
      const emails = extractEmails(text);
      if (!emails.length) continue;
      const primary = emails[0].toLowerCase();
      if (byEmail.has(primary)) continue;
      // Display name: en Startpage el snippet típico es
      // "Title - Instagram (descripción · bio · contacto...)". Cogemos lo
      // de antes del primer "·" o "(" como nombre amigable.
      const niceName =
        (hit.text || "")
          .split(/[·•|]|\s+-\s+Instagram/)[0]
          .replace(/\s*\(@?[a-z0-9._]+\)\s*/i, "")
          .trim()
          .slice(0, 80) || handle;
      byEmail.set(primary, {
        name: niceName,
        website: `https://instagram.com/${handle}/`,
        emails,
        phone: null,
        address: null,
        socials: { instagram: `https://instagram.com/${handle}/` },
      });
    }

    job.results = [...byEmail.values()].slice(0, job.total);
    job.scraped = job.results.length;
    job.with_email = job.results.length;
    job.total = Math.max(job.results.length, job.total);
    job.status = "done";
    await dbSaveLeadJob(job);
  } finally {
    active.delete(job.id);
  }
}

export async function getIgSearchJob(id: string): Promise<LeadJob | null> {
  const live = active.get(id);
  if (live) return live;
  return await dbGetLeadJob(id);
}

export async function listIgSearchJobs(limit = 30): Promise<LeadJob[]> {
  const all = await dbListLeadJobs(limit * 3);
  return all
    .filter((j) => j.niche.startsWith("ig-search:"))
    .slice(0, limit)
    .map((j) => active.get(j.id) ?? j);
}

export async function importIgSearchLeads(
  jobId: string,
  indices: number[],
  stage: string,
): Promise<{ imported: number; withEmail: number }> {
  const job = await getIgSearchJob(jobId);
  if (!job) throw new Error("Búsqueda no encontrada");
  const tags = ["lead", "ig-search", "src:" + (job.area || "ig")];
  let imported = 0;
  let withEmail = 0;
  const wanted = new Set(indices);
  for (let i = 0; i < job.results.length; i++) {
    if (!wanted.has(i)) continue;
    const lead = job.results[i];
    const email = lead.emails[0] || "";
    const key = email
      ? `lead:${email}`
      : `lead:${lead.website || crypto.randomUUID().slice(0, 8)}`;
    const fields: Record<string, string> = { fuente: "ig-search" };
    if (email) fields.email = email;
    if (lead.emails.length > 1) fields.emails = lead.emails.join(", ");
    if (lead.website) fields.instagram = lead.website;
    for (const [k, vv] of Object.entries(lead.socials)) fields[k] = vv;
    await touchContact(key, lead.name || "", "");
    await enrichContact(key, { tags, fields });
    if (stage) await setStage(key, stage, { origin: "buscar-leads", reason: "Etapa elegida al importar una búsqueda de leads" });
    imported++;
    if (email) withEmail++;
  }
  return { imported, withEmail };
}
