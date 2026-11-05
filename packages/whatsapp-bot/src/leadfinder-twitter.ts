/**
 * Búsqueda de leads en X / Twitter sin login: usamos Startpage (Google proxy)
 * con site:x.com OR site:twitter.com + dominio de email común + keyword del
 * nicho. Mismo patrón que leadfinder-ig-search pero adaptado a X/Twitter:
 *  - X tiene mejor index en Google que IG (más bios indexadas).
 *  - Yield esperado en niche tech/AI: alto (los devs viven en X).
 *  - 100% dato público y voluntariamente publicado por el dueño.
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

const EMAIL_DOMAINS = [
  "@gmail.com", "@hotmail.com", "@outlook.com", "@yahoo.com",
  "@yahoo.es", "@hotmail.es", "@protonmail.com", "@icloud.com",
  "@fastmail.com", "@me.com",
];

interface SearchHit {
  url: string;
  text: string;
}

export function deobfuscateEmails(text: string): string {
  return text
    .replace(/([A-Za-z0-9._%+-]+)@\s+([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1@$2")
    .replace(/([A-Za-z0-9._%+-]+)\s+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1@$2")
    .replace(
      /([A-Za-z0-9._%+-]+)\s*[\(\[\{]\s*at\s*[\)\]\}]\s*([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi,
      "$1@$2",
    );
}

async function startpageSearch(query: string): Promise<SearchHit[]> {
  const url =
    "https://www.startpage.com/do/search?query=" + encodeURIComponent(query);
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
    return parseStartpageX(await res.text());
  } catch {
    return [];
  }
}

export function parseStartpageX(html: string): SearchHit[] {
  // Buscamos anchors tanto a x.com como a twitter.com (legacy).
  const re =
    /<a [^>]*href=["'](https?:\/\/[^"']*(?:x\.com|twitter\.com)\/[^"']+)["'][^>]*>/gi;
  const out: SearchHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
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

export function xHandleFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (!["x.com", "twitter.com"].includes(host)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) return null;
    const handle = parts[0].toLowerCase();
    if (
      ["search", "explore", "i", "home", "tos", "privacy", "settings",
       "messages", "notifications", "compose", "intent", "share", "hashtag",
       "login", "signup", "about", "download"].includes(handle)
    )
      return null;
    if (!/^[a-z0-9_]{2,30}$/.test(handle)) return null;
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
  const sites = `(site:x.com OR site:twitter.com)`;
  const list = EMAIL_DOMAINS.map((d) => `${sites} "${d}" "${q}"`);
  list.push(`${sites} "contact" "${q}" "@"`);
  list.push(`${sites} "contacto" "${q}" "@"`);
  list.push(`${sites} "DM" "${q}" "@"`);
  return list;
}

export function startTwitterSearch(seed: string, opts: { limit?: number } = {}): string {
  const id = crypto.randomUUID().slice(0, 12);
  const cleanSeed = (seed || "").trim();
  const job: LeadJob = {
    id,
    niche: "x-search:" + cleanSeed.slice(0, 60),
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
  void runTwitterJob(job, cleanSeed).catch(async (e) => {
    job.status = "error";
    job.error = (e as Error).message || String(e);
    await dbSaveLeadJob(job);
    active.delete(id);
  });
  return id;
}

async function runTwitterJob(job: LeadJob, seed: string): Promise<void> {
  try {
    if (!seed) {
      job.status = "error";
      job.error = "Keyword vacía.";
      await dbSaveLeadJob(job);
      return;
    }
    job.status = "scraping";
    await dbSaveLeadJob(job);

    const queries = buildQueries(seed);
    const allHits: SearchHit[] = [];
    await mapLimit(queries, 2, async (q) => {
      const hits = await startpageSearch(q);
      allHits.push(...hits);
      job.scraped = Math.min(allHits.length, job.total);
      await dbSaveLeadJob(job);
    });

    const byUrl = new Map<string, SearchHit>();
    for (const h of allHits) if (h.url && !byUrl.has(h.url)) byUrl.set(h.url, h);

    // Dedup por handle. Cuando hay varios hits del mismo handle, preferimos
    // los snippets de la URL de PERFIL (sin /status/) si los hay; si no,
    // el de mayor longitud (más probable que contenga la bio o un tweet
    // con email).
    const byHandle = new Map<string, SearchHit>();
    for (const hit of byUrl.values()) {
      const handle = xHandleFromUrl(hit.url);
      if (!handle) continue;
      const isProfile = !/\/status\//.test(hit.url);
      const prev = byHandle.get(handle);
      const prevIsProfile = prev ? !/\/status\//.test(prev.url) : false;
      const replace =
        !prev ||
        (isProfile && !prevIsProfile) ||
        (isProfile === prevIsProfile && hit.text.length > prev.text.length);
      if (replace) byHandle.set(handle, { ...hit, url: `https://x.com/${handle}` });
    }

    const byEmail = new Map<string, Lead>();
    for (const [handle, hit] of byHandle) {
      const text = deobfuscateEmails(hit.text);
      const emails = extractEmails(text);
      if (!emails.length) continue;
      const primary = emails[0].toLowerCase();
      if (byEmail.has(primary)) continue;
      const niceName =
        (hit.text || "")
          .split(/[·•|]|\s+\/\s+X\b|\s+on\s+X\b/i)[0]
          .replace(/\s*\(@?[a-z0-9_]+\)\s*/i, "")
          .trim()
          .slice(0, 80) || handle;
      byEmail.set(primary, {
        name: niceName,
        website: `https://x.com/${handle}`,
        emails,
        phone: null,
        address: null,
        socials: { twitter: `https://x.com/${handle}` },
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

export async function getTwitterJob(id: string): Promise<LeadJob | null> {
  return active.get(id) ?? (await dbGetLeadJob(id));
}

export async function listTwitterJobs(limit = 30): Promise<LeadJob[]> {
  const all = await dbListLeadJobs(limit * 3);
  return all
    .filter((j) => j.niche.startsWith("x-search:"))
    .slice(0, limit)
    .map((j) => active.get(j.id) ?? j);
}

export async function importTwitterLeads(
  jobId: string,
  indices: number[],
  stage: string,
): Promise<{ imported: number; withEmail: number }> {
  const job = await getTwitterJob(jobId);
  if (!job) throw new Error("Búsqueda no encontrada");
  const tags = ["lead", "x-search", "src:" + (job.area || "x")];
  let imported = 0;
  let withEmail = 0;
  const wanted = new Set(indices);
  for (let i = 0; i < job.results.length; i++) {
    if (!wanted.has(i)) continue;
    const lead = job.results[i];
    const email = lead.emails[0] || "";
    const identity = lead.website || lead.name || `idx:${i}`;
    const key = email
      ? `lead:${email}`
      : `lead:tw:${crypto.createHash("sha1").update(identity).digest("hex").slice(0, 12)}`;
    const fields: Record<string, string> = { fuente: "x-search" };
    if (email) fields.email = email;
    if (lead.emails.length > 1) fields.emails = lead.emails.join(", ");
    if (lead.website) fields.twitter = lead.website;
    for (const [k, vv] of Object.entries(lead.socials)) fields[k] = vv;
    await touchContact(key, lead.name || "", "");
    await enrichContact(key, { tags, fields });
    if (stage) await setStage(key, stage, { origin: "buscar-leads", reason: "Etapa elegida al importar una búsqueda de leads" });
    imported++;
    if (email) withEmail++;
  }
  return { imported, withEmail };
}
