/**
 * Reddit — buscador de leads via search publico de reddit.com.
 *
 * Estrategia 100% datos publicos:
 *   1. https://www.reddit.com/search.json?q=<kw>&type=user → usuarios.
 *      No requiere auth para la busqueda basica (UA recomendado).
 *   2. Por cada usuario: GET /user/USER/about.json → extrae bio
 *      (subreddit.public_description) + url externa (subreddit.url o icon_img
 *      no sirven; usamos `subreddit.public_description` + scrap del JSON
 *      'subreddit.url' que apunta al reddit /r/u_USER, asi que cogemos
 *      `subreddit.banner_img`/`subreddit.over_18` solo si util... lo que
 *      necesitamos de verdad es 'url' externa: viene en
 *      `data.subreddit.public_description` + `data.subreddit.title`).
 *   3. Si la bio contiene un email, lo extraemos via regex EMAIL_RE.
 *      Si tambien hay una URL externa, hacemos 1 fetch ligero a esa web
 *      para enriquecer (opcional, mismo scrap ligero que leadfinder).
 *
 * Rate limit: como mucho 60 req/min contra reddit.com (sleep 1s entre
 * fetches). Reddit aplica 100 req/min con UA bonafide; 60 nos deja margen.
 *
 * Multi-tenant via dbSaveLeadJob (mismo patron de leadfinder.ts/-twitter.ts).
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
import { extractEmails, scrapeSite, mapLimit } from "./leadfinder.js";
import { touchContact, enrichContact, setStage } from "./contacts.js";
import { logActivity } from "./activity.js";

const UA = "leadmatch-lab/1.0 (Reddit lead finder; +https://leadmatch.app)";
const FETCH_TIMEOUT_MS = 15_000;
const RATE_SLEEP_MS = 1_000; // 60 req/min hacia reddit.com
const MAX_LIMIT = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface RedditUserHit { name: string; }

async function searchRedditUsers(keyword: string, limit: number): Promise<RedditUserHit[]> {
  const kw = keyword.trim();
  if (!kw) return [];
  const url = "https://www.reddit.com/search.json?" + new URLSearchParams({
    q: kw,
    type: "user",
    limit: String(Math.min(100, Math.max(1, limit))),
    sort: "relevance",
  });
  const data = await fetchJson<{
    data?: { children?: Array<{ kind?: string; data?: { name?: string } }> };
  }>(url);
  const out: RedditUserHit[] = [];
  const seen = new Set<string>();
  for (const ch of data?.data?.children || []) {
    const name = String(ch?.data?.name || "").trim();
    if (!name) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name });
    if (out.length >= limit) break;
  }
  return out;
}

interface RedditAbout {
  username: string;
  bio: string;
  externalUrl: string | null;
  email: string | null;
}

function pickExternalUrl(about: any): string | null {
  // reddit pone la URL del subreddit como /r/u_USER (no util) y la url externa
  // del perfil suele estar en subreddit.public_description en texto libre. Como
  // primera aproximacion: buscamos http(s)://... en el public_description.
  const desc = String(about?.subreddit?.public_description || "");
  const m = desc.match(/https?:\/\/[^\s)]+/);
  if (m) return m[0];
  return null;
}

async function fetchAbout(user: string): Promise<RedditAbout | null> {
  const data = await fetchJson<{ data?: any }>(
    `https://www.reddit.com/user/${encodeURIComponent(user)}/about.json`,
  );
  const d = data?.data;
  if (!d) return null;
  const bio = String(d?.subreddit?.public_description || "");
  const email = (extractEmails(bio)[0] || "").toLowerCase() || null;
  return {
    username: user,
    bio,
    externalUrl: pickExternalUrl(d),
    email,
  };
}

// LEADFINDER-TENANT-1: el progreso en vivo solo lo ve el workspace que lo lanzó.
const active = new TrabajosVivos();

export function startRedditSearch(
  keyword: string,
  opts: { limit?: number } = {},
): string {
  const id = crypto.randomUUID().slice(0, 12);
  const cleanKw = (keyword || "").trim();
  const job: LeadJob = {
    id,
    niche: "rdt:" + cleanKw.slice(0, 60),
    city: cleanKw.slice(0, 200),
    status: "queued",
    area: cleanKw,
    total: Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? 40)),
    scraped: 0,
    with_email: 0,
    results: [],
    error: "",
    created_at: Date.now(),
  };
  active.set(id, job);
  void runJob(job, cleanKw).catch(async (e) => {
    job.status = "error";
    job.error = (e as Error).message || String(e);
    await dbSaveLeadJob(job);
    active.delete(id);
  });
  return id;
}

async function runJob(job: LeadJob, keyword: string): Promise<void> {
  try {
    if (!keyword) {
      job.status = "error";
      job.error = "Keyword vacia.";
      await dbSaveLeadJob(job);
      return;
    }
    job.status = "discovering";
    await dbSaveLeadJob(job);

    const users = await searchRedditUsers(keyword, job.total);
    job.total = users.length;
    if (!users.length) {
      job.status = "done";
      await dbSaveLeadJob(job);
      return;
    }
    job.status = "scraping";
    await dbSaveLeadJob(job);

    // Sequential con sleep 1s para respetar 60 req/min (Reddit corta a ~100).
    // mapLimit con concurrencia=1 + sleep entre items emula el rate limit.
    const abouts: RedditAbout[] = [];
    let scraped = 0;
    await mapLimit(users, 1, async (u) => {
      const a = await fetchAbout(u.name);
      if (a) abouts.push(a);
      scraped++;
      job.scraped = scraped;
      await sleep(RATE_SLEEP_MS);
    });

    // Para los que tienen url externa pero NO email en la bio, hacemos 1 scrap
    // ligero (mismo helper que el resto del leadfinder) — opcional, solo si
    // la url externa parece web propia (no twitter/x/instagram/github).
    const toScrape = abouts.filter((a) => !a.email && a.externalUrl && !/instagram\.com|twitter\.com|x\.com|github\.com|reddit\.com/i.test(a.externalUrl));
    if (toScrape.length) {
      await mapLimit(toScrape, 3, async (a) => {
        const r = await scrapeSite(a.externalUrl as string);
        if (r.emails.length) a.email = r.emails[0].toLowerCase();
      });
    }

    const byEmail = new Map<string, Lead>();
    for (const a of abouts) {
      if (!a.email) continue;
      if (byEmail.has(a.email)) continue;
      byEmail.set(a.email, {
        name: a.username,
        website: a.externalUrl || `https://reddit.com/user/${a.username}`,
        emails: [a.email],
        phone: null,
        address: null,
        socials: { reddit: `https://reddit.com/user/${a.username}` },
      });
    }

    job.results = [...byEmail.values()].slice(0, job.total);
    job.with_email = job.results.length;
    job.scraped = scraped;
    job.status = "done";
    await dbSaveLeadJob(job);

    await logActivity({
      source: "lead-job",
      level: "info",
      status: "done",
      summary: `Reddit "${keyword}": ${users.length} usuarios, ${job.with_email} con email`,
      payload: { file: "leadfinder-reddit.ts", fn: "runJob", jobId: job.id, keyword },
    });
  } catch (err) {
    job.status = "error";
    job.error = (err as Error).message || String(err);
    await dbSaveLeadJob(job);
    await logActivity({
      source: "lead-job",
      level: "error",
      status: "error",
      summary: `Reddit "${keyword}" fallo: ${(job.error || "").slice(0, 160)}`,
      payload: {
        file: "leadfinder-reddit.ts",
        fn: "runJob",
        jobId: job.id,
        keyword,
        scraped: job.scraped,
        total: job.total,
        error: (job.error || "").slice(0, 400),
      },
    });
  } finally {
    active.delete(job.id);
  }
}

export async function getRedditJob(id: string): Promise<LeadJob | null> {
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

export async function listRedditJobs(limit = 30, opts?: { tenantId?: string }): Promise<LeadJob[]> {
  // SEC-1bis: misma propagacion tenantId que listDirectorioJobs. Si admin.ts
  // no pasa opts, dbListLeadJobs sin filtro, pero todas las inserciones desde
  // 8 leadfinder modules pasan tenant_id auto via dbSaveLeadJob+ALS.
  const stored = await dbListLeadJobs(limit * 3, opts);
  return stored
    .filter((j) => (j.niche || "").startsWith("rdt:"))
    .slice(0, limit)
    .map((j) => active.get(j.id) ?? j);
}

function tagify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9aeiounes ]/gi, "").replace(/\s+/g, "-").slice(0, 30);
}

export async function importRedditLeads(
  jobId: string,
  indices: number[],
  stage: string,
): Promise<{ imported: number; withEmail: number }> {
  const job = await getRedditJob(jobId);
  if (!job) throw new Error("Busqueda no encontrada");
  const tags = ["lead", "reddit", tagify((job.area || "").slice(0, 40))].filter(Boolean);
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
      : `lead:rdt:${crypto.createHash("sha1").update(identity).digest("hex").slice(0, 12)}`;
    const fields: Record<string, string> = { fuente: "reddit" };
    if (email) fields.email = email;
    if (lead.website) fields.web = lead.website;
    for (const [k, vv] of Object.entries(lead.socials)) fields[k] = vv;
    await touchContact(key, lead.name || "", "");
    await enrichContact(key, { tags, fields });
    if (stage) await setStage(key, stage, { origin: "buscar-leads", reason: "Etapa elegida al importar una búsqueda de leads" });
    imported++;
    if (email) withEmail++;
  }
  return { imported, withEmail };
}
