/**
 * Búsqueda de leads vía **Instagram Graph API oficial** (hashtag + business
 * discovery). Es ToS-compliant, no requiere burner, no toca tu cuenta más
 * allá de hacer llamadas a la API con tu token.
 *
 *  1. ig_hashtag_search?q=programacion → hashtag_id
 *  2. /{hashtag_id}/top_media + recent_media → ~80 usernames de creators
 *     business activos posteando en ese hashtag.
 *  3. Por cada username único:
 *       /{my_ig_id}?fields=business_discovery.username(X){biography,website,name,followers_count}
 *     → bio + web pública. Regex sobre bio + sobre HTML de la web (1-hop) → email.
 *
 *  Permisos: instagram_basic + (pages_read_engagement | instagram_manage_insights).
 *  Rate-limit duro de Meta: máx 200 hashtags únicos por IG-account cada 7 días.
 *  Por eso cacheamos hashtag_id en RAM y warning al user si pide >20 hashtags.
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

const BASE = "https://graph.facebook.com/v21.0";
const MAX_HASHTAGS = 12; // por barrido. Conserva la cuota Meta (200 / 7 días).
const MAX_AUTHORS = 200;

interface GraphParams {
  token: string;
  igId: string;
}

function getMetaCreds(): GraphParams {
  return {
    token: getSetting("meta.igAccessToken"),
    igId: getSetting("meta.igBusinessId"),
  };
}

async function graph<T = unknown>(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<T> {
  const qs = new URLSearchParams({ ...params, access_token: token }).toString();
  const url = `${BASE}/${path}?${qs}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Graph: ${msg}`);
  }
  return data as T;
}

// Cache de hashtag_id por nombre (en RAM): cada lookup consume 1/200 de la
// cuota de 7 días, así que cacheamos agresivamente. Reset al reiniciar el
// proceso → cualquier reintento llama a Meta de nuevo.
const hashtagIdCache = new Map<string, string>();

async function resolveHashtagId(tag: string, c: GraphParams): Promise<string | null> {
  const clean = tag.replace(/^#/, "").toLowerCase().trim();
  if (!clean) return null;
  if (hashtagIdCache.has(clean)) return hashtagIdCache.get(clean) ?? null;
  try {
    const r = await graph<{ data: { id: string }[] }>("ig_hashtag_search", {
      user_id: c.igId,
      q: clean,
    }, c.token);
    const id = r.data?.[0]?.id;
    if (id) {
      hashtagIdCache.set(clean, id);
      return id;
    }
    return null;
  } catch {
    return null;
  }
}

interface MediaItem {
  id: string;
  username?: string;
  caption?: string;
  permalink?: string;
}

async function hashtagMedia(
  hashtagId: string,
  kind: "top_media" | "recent_media",
  c: GraphParams,
): Promise<MediaItem[]> {
  try {
    const r = await graph<{ data: MediaItem[] }>(`${hashtagId}/${kind}`, {
      user_id: c.igId,
      fields: "id,username,caption,permalink",
      limit: "50",
    }, c.token);
    return r.data ?? [];
  } catch {
    return [];
  }
}

interface BizDiscovery {
  biography?: string;
  website?: string;
  name?: string;
  username?: string;
  followers_count?: number;
}

async function businessDiscovery(
  username: string,
  c: GraphParams,
): Promise<BizDiscovery | null> {
  try {
    const fields = `business_discovery.username(${username}){biography,website,name,username,followers_count}`;
    const r = await graph<{ business_discovery?: BizDiscovery }>(c.igId, {
      fields,
    }, c.token);
    return r.business_discovery ?? null;
  } catch {
    // Si la cuenta NO es business/creator, Meta devuelve error; ignoramos.
    return null;
  }
}

export function startHashtagJob(
  seedRaw: string,
  opts: { limit?: number } = {},
): string {
  const id = crypto.randomUUID().slice(0, 12);
  const hashtags = seedRaw
    .split(/[,\s\n]+/)
    .map((s) => s.replace(/^#/, "").trim().toLowerCase())
    .filter(Boolean);
  const limited = hashtags.slice(0, MAX_HASHTAGS);
  const job: LeadJob = {
    id,
    niche: "ig-hashtag:" + limited.join(","),
    city: limited.join(", "),
    status: "queued",
    area: limited.join(","),
    total: Math.max(1, Math.min(MAX_AUTHORS, opts.limit ?? 80)),
    scraped: 0,
    with_email: 0,
    results: [],
    error: "",
    created_at: Date.now(),
  };
  active.set(id, job);
  void runHashtagJob(job, limited).catch(async (e) => {
    job.status = "error";
    job.error = (e as Error).message || String(e);
    await dbSaveLeadJob(job);
    active.delete(id);
  });
  return id;
}

// LEADFINDER-TENANT-1: el progreso en vivo solo lo ve el workspace que lo lanzó.
const active = new TrabajosVivos();

async function runHashtagJob(job: LeadJob, tags: string[]): Promise<void> {
  try {
    const c = getMetaCreds();
    if (!c.token || !c.igId) {
      job.status = "error";
      job.error = "Falta token / IG business ID en Ajustes › Credenciales (meta.igAccessToken, meta.igBusinessId).";
      await dbSaveLeadJob(job);
      return;
    }
    if (!tags.length) {
      job.status = "error";
      job.error = "Pon al menos un hashtag (separa con comas o espacios).";
      await dbSaveLeadJob(job);
      return;
    }
    job.status = "discovering";
    await dbSaveLeadJob(job);

    // 1. Resolver hashtags → IDs
    const ids: { tag: string; id: string }[] = [];
    for (const t of tags) {
      const id = await resolveHashtagId(t, c);
      if (id) ids.push({ tag: t, id });
    }
    if (!ids.length) {
      job.status = "error";
      job.error = "Ningún hashtag se pudo resolver (cuota Meta 200/7-días agotada o hashtag inválido).";
      await dbSaveLeadJob(job);
      return;
    }

    // 2. Por cada hashtag: top + recent media → autores únicos
    const authorSet = new Set<string>();
    await mapLimit(ids, 2, async ({ id }) => {
      const [top, recent] = await Promise.all([
        hashtagMedia(id, "top_media", c),
        hashtagMedia(id, "recent_media", c),
      ]);
      for (const m of [...top, ...recent]) {
        if (m.username) authorSet.add(m.username.toLowerCase());
      }
    });
    const authors = [...authorSet].slice(0, job.total);
    job.total = authors.length;
    job.status = "scraping";
    await dbSaveLeadJob(job);

    // 3. Business discovery por autor → bio + web. Regex → email.
    //    Fallback: si bio no tiene email pero tiene website, fetch + regex
    //    (1 hop, mismo motor que leadfinder genérico).
    const leads: Lead[] = [];
    let done = 0;
    await mapLimit(authors, 4, async (username) => {
      const bd = await businessDiscovery(username, c);
      done++;
      job.scraped = done;
      if ((done & 7) === 0) await dbSaveLeadJob(job);
      if (!bd) return;
      const text = [bd.biography, bd.website, bd.name].filter(Boolean).join(" ");
      let emails = extractEmails(text);
      // 1-hop a la web si no hay email en bio pero hay website.
      if (!emails.length && bd.website) {
        const html = await fetchHtml(bd.website).catch(() => null);
        if (html) emails = extractEmails(html).slice(0, 3);
      }
      if (!emails.length) return;
      leads.push({
        name: bd.name || username,
        website: bd.website || `https://instagram.com/${username}/`,
        emails,
        phone: null,
        address: null,
        socials: { instagram: `https://instagram.com/${username}/` },
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

export async function getHashtagJob(id: string): Promise<LeadJob | null> {
  return active.get(id) ?? (await dbGetLeadJob(id));
}

export async function listHashtagJobs(limit = 30): Promise<LeadJob[]> {
  const all = await dbListLeadJobs(limit * 3);
  return all
    .filter((j) => j.niche.startsWith("ig-hashtag:"))
    .slice(0, limit)
    .map((j) => active.get(j.id) ?? j);
}

export async function importHashtagLeads(
  jobId: string,
  indices: number[],
  stage: string,
): Promise<{ imported: number; withEmail: number }> {
  const job = await getHashtagJob(jobId);
  if (!job) throw new Error("Búsqueda no encontrada");
  const tags = ["lead", "ig-hashtag", "src:" + (job.area || "hashtag")];
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
    const fields: Record<string, string> = { fuente: "ig-hashtag" };
    if (email) fields.email = email;
    if (lead.emails.length > 1) fields.emails = lead.emails.join(", ");
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
