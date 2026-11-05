/**
 * Buscador de leads basado en la COMPETENCIA.
 *
 * Idea: das un competidor (URL, dominio o @handle de Instagram) y la app intenta
 * descubrir negocios "alrededor" — clientes mencionados, testimonios, partners,
 * empresas enlazadas — y les saca emails con las mismas heurísticas que el
 * leadfinder por nicho/ciudad. Sin API key, todo es scraping de webs públicas.
 *
 * Realismo honesto (esto NO es magia):
 *  - IG no expone followers de terceros públicamente: con un @handle solo
 *    resolvemos su web (link en bio) y, a partir de ahí, tiramos del hilo
 *    de su site. Para enriquecimiento profundo de IG, hace falta API privada
 *    o herramientas de pago, fuera de scope.
 *  - "Competidores parecidos" usamos heurísticas: enlaces externos en la web
 *    del competidor (testimonios/partners/portfolio), no un buscador caro.
 *
 * Reutiliza app_lead_jobs (BD) marcando `niche="competidor:<dominio>"`.
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
import {
  normalizeUrl,
  fetchHtml,
  extractEmails,
  extractSocials,
  scrapeSite,
  mapLimit,
} from "./leadfinder.js";
import { deepScrape } from "./leadfinder-deep.js";
import { touchContact, enrichContact, setStage } from "./contacts.js";

const MAX_LIMIT = 60;
const SCRAPE_CONCURRENCY = Number(process.env.LEADFINDER_CONCURRENCY || 6);

// Páginas internas que más leads dan: clientes, equipo, testimonios, contacto.
// Probamos varios slugs habituales en español e inglés.
const INTERNAL_HINTS = [
  "clientes", "clients", "customers", "case-studies", "casos",
  "testimonios", "testimonials", "partners", "portfolio", "trabajos",
  "team", "equipo", "about", "nosotros", "sobre-nosotros",
  "contact", "contacto", "press", "media", "prensa",
];

// Hosts que NO queremos seguir como "lead externo": son ruido (CDN, redes,
// boilerplate, canales de contacto). Si el enlace apunta a uno de estos lo
// descartamos.
const HOST_BLACKLIST = [
  "instagram.com", "facebook.com", "twitter.com", "x.com", "linkedin.com",
  "tiktok.com", "youtube.com", "youtu.be", "vimeo.com",
  // Canales de contacto / mensajería (no son leads, son enlaces a tu propio bot).
  "whatsapp.com", "wa.me", "t.me", "telegram.me", "telegram.org",
  "discord.com", "discord.gg", "messenger.com", "m.me",
  // Buscadores, CDNs, infra.
  "google.com", "googleapis.com", "gstatic.com", "googletagmanager.com",
  "wikipedia.org", "wordpress.org", "wordpress.com", "wix.com", "wixsite.com",
  "squarespace.com", "shopify.com", "godaddy.com", "namecheap.com",
  "github.com", "gitlab.com", "bitbucket.org",
  "amazonaws.com", "cloudfront.net", "cdn.", "static.",
  "fonts.gstatic.com", "fonts.googleapis.com",
  "schema.org", "w3.org", "ogp.me",
];

/**
 * Raíz "registrable" aproximada del host: quita www y subdominios obvios
 * (las 2 últimas etiquetas separadas por punto). Suficiente para tratar
 * `training.empresa.com` y `empresa.com` como el mismo dominio en la
 * inmensa mayoría de casos sin necesidad de listas de eTLD reales.
 */
function registrableRoot(host: string): string {
  const clean = host.toLowerCase().replace(/^www\./, "");
  const parts = clean.split(".");
  if (parts.length <= 2) return clean;
  // Para hosts tipo "sub.empresa.com" → "empresa.com".
  // Para "sub.empresa.co.uk" devuelve "co.uk" (falso positivo aceptable
  // dado el coste de mantener listas eTLD; en el peor caso descarta más
  // de la cuenta, nunca menos).
  return parts.slice(-2).join(".");
}

/** Saca el "host base" (eTLD+1 aproximado) de una URL. */
function rootHost(u: string): string {
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
    // No descomponemos eTLD real (sin librería); con el host completo nos vale
    // para deduplicar webs distintas razonablemente.
    return h;
  } catch {
    return "";
  }
}

function isBlacklisted(host: string): boolean {
  if (!host) return true;
  for (const bad of HOST_BLACKLIST) {
    if (host === bad || host.endsWith("." + bad) || host.includes(bad)) return true;
  }
  return false;
}

/** Convierte el input del usuario en un host raíz "competidor" y una URL home. */
async function resolveSeed(seed: string): Promise<{ home: string; host: string } | null> {
  const raw = (seed || "").trim();
  if (!raw) return null;

  // 1) @handle o instagram.com/handle → resolver via la página pública de IG
  //    (Instagram suele incluir el link de bio en el HTML público vía meta og:url o JSON-LD).
  const igHandle = raw.startsWith("@")
    ? raw.slice(1)
    : raw.match(/instagram\.com\/([A-Za-z0-9_.]+)/i)?.[1];
  if (igHandle && !raw.includes(".")) {
    const igUrl = `https://www.instagram.com/${igHandle}/`;
    const html = await fetchHtml(igUrl);
    const bioLink = html ? extractIgBioLink(html) : null;
    if (bioLink) {
      const u = normalizeUrl(bioLink);
      if (u) return { home: u, host: rootHost(u) };
    }
    // Sin link de bio extraíble → no hay forma de continuar.
    return null;
  }

  // 2) URL o dominio: normalizamos.
  const home = normalizeUrl(raw);
  if (!home) return null;
  return { home, host: rootHost(home) };
}

/** Intenta extraer el "link de bio" desde el HTML público de Instagram. */
function extractIgBioLink(html: string): string | null {
  // Caso 1: meta og:url apunta a IG; buscar URL externa dentro del JSON
  // embebido en <script>. Instagram embebe state como "external_url":"https://..."
  const m1 = html.match(/"external_url":"(https?:\\\/\\\/[^"]+)"/);
  if (m1) return m1[1].replace(/\\\//g, "/");
  // Caso 2: alguna variante con doble escape.
  const m2 = html.match(/"external_url"\s*:\s*"([^"]+)"/);
  if (m2 && /^https?:/.test(m2[1])) return m2[1];
  // Caso 3: link directo en bio renderizado (raro pero por si acaso).
  const m3 = html.match(/href="(https?:\/\/[^"]+)"[^>]*rel="me"/i);
  if (m3) return m3[1];
  return null;
}

/** Lista de candidatos a páginas internas (slug homing) que valen la pena visitar. */
function buildInternalCandidates(homeUrl: string): string[] {
  const out: string[] = [];
  for (const hint of INTERNAL_HINTS) {
    try {
      out.push(new URL("/" + hint, homeUrl).toString());
      out.push(new URL("/" + hint + "/", homeUrl).toString());
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Extrae enlaces externos (a otros dominios) desde el HTML — son los candidatos
 * a "lead externo": clientes, testimonios, partners mencionados con su web.
 */
function extractExternalLinks(html: string, baseUrl: string, ownHost: string): string[] {
  const out = new Set<string>();
  const ownRoot = registrableRoot(ownHost);
  const re = /<a\b[^>]*href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:"))
      continue;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    const host = rootHost(abs);
    if (!host) continue;
    // Filtra el propio competidor Y todos sus subdominios.
    if (registrableRoot(host) === ownRoot) continue;
    if (isBlacklisted(host)) continue;
    out.add("https://" + host + "/");
  }
  return [...out];
}

interface CompetitorOpts {
  limit?: number;
}

/** Crea un LeadJob "competidor" y lanza la búsqueda en background. */
export function startCompetitorSearch(seed: string, opts: CompetitorOpts = {}): string {
  const id = crypto.randomUUID().slice(0, 12);
  const job: LeadJob = {
    id,
    niche: "competidor:" + (seed || "").trim().slice(0, 60),
    city: (seed || "").trim().slice(0, 200),
    status: "queued",
    area: "",
    total: Math.max(1, Math.min(MAX_LIMIT, opts.limit || 30)),
    scraped: 0,
    with_email: 0,
    results: [],
    error: "",
    created_at: Date.now(),
  };
  active.set(id, job);
  void runCompetitorJob(job, seed).catch((e) => {
    job.status = "error";
    job.error = (e as Error).message || String(e);
    void dbSaveLeadJob(job);
    active.delete(id);
  });
  return id;
}

// LEADFINDER-TENANT-1: el progreso en vivo solo lo ve el workspace que lo lanzó.
const active = new TrabajosVivos();

async function runCompetitorJob(job: LeadJob, seed: string): Promise<void> {
  try {
    job.status = "discovering";
    await dbSaveLeadJob(job);

    const resolved = await resolveSeed(seed);
    if (!resolved) {
      job.status = "error";
      job.error =
        "No pude resolver el competidor. Prueba con una URL completa (https://...) " +
        "o un @handle de Instagram que tenga link en la bio.";
      await dbSaveLeadJob(job);
      return;
    }
    job.area = resolved.host;

    // 1) DEEP CRAWL del competidor: leemos su sitemap.xml (o robots.txt → sitemap)
    //    y visitamos hasta 60 páginas. De cada página recogemos:
    //      (a) emails del propio competidor (para el lead "self" al inicio)
    //      (b) enlaces externos a OTRAS empresas (candidatos a lead).
    //    Esto multiplica brutalmente la cobertura vs visitar 30 slugs hechos
    //    a mano. Si el competidor no publica sitemap, deepScrape devuelve la
    //    home y caemos al fallback con slugs comunes del leadfinder original.
    const externalHosts = new Set<string>();
    const onPage = (url: string, html: string) => {
      for (const link of extractExternalLinks(html, url, resolved.host))
        externalHosts.add(link);
    };
    const competitorScrape = await deepScrape(resolved.host, {
      maxUrls: 60,
      onPage,
    });

    // Fallback: si no había sitemap, complementamos con los slugs hechos a mano
    //           del leadfinder original (contacto / nosotros / clientes / ...).
    const competitorSocials: Record<string, string> = {};
    if (!competitorScrape.usedSitemap) {
      const homeHtml = (await fetchHtml(resolved.home)) || "";
      if (homeHtml) onPage(resolved.home, homeHtml);
      const candidates = buildInternalCandidates(resolved.home);
      const internalHtmls = await mapLimit(candidates, 6, async (u) => ({
        url: u,
        html: await fetchHtml(u),
      }));
      for (const { url, html } of internalHtmls) if (html) onPage(url, html);
      // Sumamos emails residuales que la home tenga y la home/contacto socials.
      if (homeHtml) {
        for (const e of extractEmails(homeHtml)) competitorScrape.emails.push(e);
        Object.assign(competitorSocials, extractSocials(homeHtml));
      }
    } else {
      // Aún con sitemap, queremos los socials del competidor (van en la home).
      const homeHtml = (await fetchHtml(resolved.home)) || "";
      if (homeHtml) Object.assign(competitorSocials, extractSocials(homeHtml));
    }

    // 2) "self": el propio competidor como primer lead (sus emails generales).
    const selfLead: Lead = {
      name: resolved.host,
      website: resolved.home,
      emails: [...new Set(competitorScrape.emails)],
      phone: null,
      address: null,
      socials: competitorSocials,
    };

    // 3) Limitamos los candidatos externos al `total` pedido por el usuario.
    const candidatesArr = [...externalHosts].slice(0, job.total);
    job.total = candidatesArr.length + 1; // +1 por el self
    if (candidatesArr.length === 0) {
      // Solo el competidor cuenta como resultado.
      job.results = [selfLead];
      job.with_email = selfLead.emails.length > 0 ? 1 : 0;
      job.scraped = 1;
      job.status = "done";
      await dbSaveLeadJob(job);
      return;
    }

    job.status = "scraping";
    await dbSaveLeadJob(job);

    // 4) Scrapeamos cada dominio externo (light) para emails/redes.
    let scraped = 1; // ya hicimos el competitor
    job.scraped = scraped;
    const scrapedByHost = new Map<string, { emails: string[]; socials: Record<string, string> }>();
    await mapLimit(candidatesArr, SCRAPE_CONCURRENCY, async (url) => {
      const r = await scrapeSite(url);
      scrapedByHost.set(url, r);
      job.scraped = ++scraped;
    });

    const externalLeads = candidatesArr.map((url): Lead => {
      const sc = scrapedByHost.get(url) || { emails: [], socials: {} };
      return {
        name: rootHost(url) || url,
        website: url,
        emails: sc.emails,
        phone: null,
        address: null,
        socials: sc.socials,
      };
    });
    job.results = [selfLead, ...externalLeads];
    job.with_email = job.results.filter((r) => r.emails.length > 0).length;
    job.status = "done";
    await dbSaveLeadJob(job);
  } finally {
    active.delete(job.id);
  }
}

export async function getCompetitorJob(id: string): Promise<LeadJob | null> {
  const live = active.get(id);
  if (live) return live;
  return await dbGetLeadJob(id);
}

export async function listCompetitorJobs(limit = 30): Promise<LeadJob[]> {
  // Filtra solo los jobs cuyo `niche` empieza por "competidor:".
  const all = await dbListLeadJobs(limit * 3);
  return all
    .filter((j) => j.niche.startsWith("competidor:"))
    .slice(0, limit)
    .map((j) => active.get(j.id) ?? j);
}

// --- Import al CRM local (mismo patrón que leadfinder por nicho) ---

export async function importCompetitorLeads(
  jobId: string,
  indices: number[],
  stage: string,
): Promise<{ imported: number; withEmail: number }> {
  const job = await getCompetitorJob(jobId);
  if (!job) throw new Error("Búsqueda no encontrada");
  const tags = ["lead", "competencia", "src:" + (job.area || "competidor")];
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
    const fields: Record<string, string> = { fuente: "competencia" };
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
