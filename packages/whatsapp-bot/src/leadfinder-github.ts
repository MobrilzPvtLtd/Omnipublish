/**
 * Búsqueda de leads en GitHub vía su API oficial REST. Datos 100% públicos:
 * el campo `email` del perfil es opt-in del propio usuario.
 *
 *  1. GET /search/users?q=<query>+followers:>=N → primeros 100 usuarios.
 *  2. Por cada user: GET /users/{login} → email + bio + blog (1 call cada uno).
 *  3. Si email vacío pero hay blog/website, fetch 1-hop a la web y regex.
 *
 *  Auth: token PAT opcional en settings (`leads.github.token`).
 *   - Sin token: 60 req/h, OK para 1-2 búsquedas.
 *   - Con token: 5000 req/h, OK para barridos diarios.
 *  GitHub búsqueda devuelve máx 1000 resultados por query (paginables de 100).
 *
 *  Yield esperado: 10-30% de los devs tienen email público → 10-30 leads / 100.
 *  Mejor canal para nichos tech (frontend, backend, ML, infra, etc.).
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
import { extractEmails, mapLimit, fetchHtml } from "./leadfinder.js";
import { touchContact, enrichContact, setStage } from "./contacts.js";
import { get as getSetting } from "./settings.js";

const BASE = "https://api.github.com";
const UA = "leadmatch-lab/1.0";
const MAX_LIMIT = 300;

interface GhSearchUser {
  login: string;
  id: number;
  avatar_url?: string;
  html_url?: string;
}
interface GhUser {
  login: string;
  name?: string | null;
  email?: string | null;
  bio?: string | null;
  blog?: string | null;
  twitter_username?: string | null;
  followers?: number;
  location?: string | null;
  html_url?: string;
  hireable?: boolean | null;
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const tok = getSetting("leads.github.token");
  if (tok) h.Authorization = `Bearer ${tok}`;
  return h;
}

async function ghFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: ghHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function searchUsers(q: string, limit: number): Promise<GhSearchUser[]> {
  const out: GhSearchUser[] = [];
  let page = 1;
  while (out.length < limit && page <= 10) {
    const r = await ghFetch<{ items: GhSearchUser[] }>(
      `/search/users?q=${encodeURIComponent(q)}&per_page=100&page=${page}`,
    );
    if (!r?.items?.length) break;
    out.push(...r.items);
    if (r.items.length < 100) break;
    page++;
  }
  return out.slice(0, limit);
}

export function startGithubJob(
  q: string,
  opts: { limit?: number } = {},
): string {
  const id = crypto.randomUUID().slice(0, 12);
  const cleanQ = q.trim();
  const job: LeadJob = {
    id,
    niche: "gh-search:" + cleanQ.slice(0, 60),
    city: cleanQ.slice(0, 200),
    status: "queued",
    area: cleanQ,
    total: Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? 100)),
    scraped: 0,
    with_email: 0,
    results: [],
    error: "",
    created_at: Date.now(),
  };
  active.set(id, job);
  void runGithubJob(job, cleanQ).catch(async (e) => {
    job.status = "error";
    job.error = (e as Error).message || String(e);
    await dbSaveLeadJob(job);
    active.delete(id);
  });
  return id;
}

// LEADFINDER-TENANT-1: el progreso en vivo solo lo ve el workspace que lo lanzó.
const active = new TrabajosVivos();

async function runGithubJob(job: LeadJob, q: string): Promise<void> {
  try {
    if (!q) {
      job.status = "error";
      job.error = "Query vacía. Ej: 'location:Spain language:javascript' o 'machine learning location:Madrid'.";
      await dbSaveLeadJob(job);
      return;
    }
    job.status = "discovering";
    await dbSaveLeadJob(job);
    const users = await searchUsers(q, job.total);
    if (!users.length) {
      job.status = "error";
      job.error = "Sin resultados. Prueba con sintaxis GitHub: 'topic:ai location:Spain' o 'language:python followers:>50'.";
      await dbSaveLeadJob(job);
      return;
    }
    job.total = users.length;
    job.status = "scraping";
    await dbSaveLeadJob(job);

    const leads: Lead[] = [];
    let done = 0;
    await mapLimit(users, 5, async (u) => {
      const full = await ghFetch<GhUser>(`/users/${u.login}`);
      done++;
      job.scraped = done;
      if ((done & 7) === 0) await dbSaveLeadJob(job);
      if (!full) return;
      let emails: string[] = [];
      if (full.email) emails.push(full.email.toLowerCase());
      // Algunas bios incluyen email aunque el campo email esté vacío.
      const bioText = [full.bio, full.name].filter(Boolean).join(" ");
      emails.push(...extractEmails(bioText));
      // 1-hop al blog si aún no hay email.
      if (!emails.length && full.blog) {
        const blogUrl =
          /^https?:\/\//.test(full.blog) ? full.blog : `https://${full.blog}`;
        const html = await fetchHtml(blogUrl).catch(() => null);
        if (html) emails = extractEmails(html).slice(0, 3);
      }
      // Dedup local + filtrar emails noreply de GitHub.
      emails = [...new Set(emails)].filter(
        (e) =>
          !/@(users\.)?noreply\.github\.com$/i.test(e) &&
          !/^noreply@github\.com$/i.test(e),
      );
      if (!emails.length) return;
      const socials: Record<string, string> = {
        github: full.html_url || u.html_url || `https://github.com/${u.login}`,
      };
      if (full.twitter_username) socials.twitter = `https://x.com/${full.twitter_username}`;
      if (full.blog) socials.web = /^https?:\/\//.test(full.blog) ? full.blog : `https://${full.blog}`;
      leads.push({
        name: full.name || u.login,
        website: socials.web || socials.github,
        emails,
        phone: null,
        address: full.location || null,
        socials,
      });
    });

    // Dedup por email primario.
    const byEmail = new Map<string, Lead>();
    for (const l of leads) {
      const k = l.emails[0]?.toLowerCase() || "";
      if (k && !byEmail.has(k)) byEmail.set(k, l);
    }
    job.results = [...byEmail.values()];
    job.with_email = job.results.length;
    job.status = "done";
    await dbSaveLeadJob(job);
  } finally {
    active.delete(job.id);
  }
}

export async function getGithubJob(id: string): Promise<LeadJob | null> {
  return active.get(id) ?? (await dbGetLeadJob(id));
}

export async function listGithubJobs(limit = 30): Promise<LeadJob[]> {
  const all = await dbListLeadJobs(limit * 3);
  return all
    .filter((j) => j.niche.startsWith("gh-search:"))
    .slice(0, limit)
    .map((j) => active.get(j.id) ?? j);
}

export async function importGithubLeads(
  jobId: string,
  indices: number[],
  stage: string,
): Promise<{ imported: number; withEmail: number }> {
  const job = await getGithubJob(jobId);
  if (!job) throw new Error("Búsqueda no encontrada");
  const tags = ["lead", "github", "src:" + (job.area || "github")];
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
      : `lead:gh:${crypto.createHash("sha1").update(identity).digest("hex").slice(0, 12)}`;
    const fields: Record<string, string> = { fuente: "github" };
    if (email) fields.email = email;
    if (lead.emails.length > 1) fields.emails = lead.emails.join(", ");
    for (const [k, vv] of Object.entries(lead.socials)) fields[k] = vv;
    if (lead.address) fields.location = lead.address;
    await touchContact(key, lead.name || "", "");
    await enrichContact(key, { tags, fields });
    if (stage) await setStage(key, stage, { origin: "buscar-leads", reason: "Etapa elegida al importar una búsqueda de leads" });
    imported++;
    if (email) withEmail++;
  }
  return { imported, withEmail };
}
