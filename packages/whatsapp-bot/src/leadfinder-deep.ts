/**
 * Crawler profundo para extraer TODOS los emails de un dominio sin depender
 * de servicios externos de pago.
 *
 * Estrategia (toda gratis, sólo HTTP público):
 *
 *  1. `robots.txt` → muchas webs declaran `Sitemap: ...` ahí. Lo leemos para
 *     descubrir los sitemaps reales (sin tener que adivinar la ruta).
 *  2. Si no hay sitemap en robots, probamos rutas comunes: `/sitemap.xml`,
 *     `/sitemap_index.xml`, `/sitemap-index.xml`, `/sitemap1.xml`.
 *  3. Si el sitemap es un índice (otros sitemaps anidados), los seguimos
 *     hasta profundidad 2.
 *  4. Para cada URL del sitemap, fetcheamos su HTML y extraemos emails con
 *     las mismas heurísticas del leadfinder original.
 *
 * Límites duros para no colgar la app ni saturar el servidor del competidor:
 *   - Máximo N URLs por crawl (configurable, defecto 80).
 *   - Concurrencia limitada (default 6 — mismo que el leadfinder).
 *   - Timeout de 12s por petición (heredado del fetcher).
 *
 * Si el dominio NO publica sitemap, hacemos fallback al scrape de slugs
 * comunes que ya hace el leadfinder (home + contact + about + ...).
 *
 * Sin API keys. Sin proxies. Sin scraping de redes sociales.
 */
import { fetchHtml, extractEmails, mapLimit } from "./leadfinder.js";

const SITEMAP_FALLBACKS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/sitemap1.xml",
];

// Patrones de páginas que es absurdo scrapear (binarios, descargas):
const IGNORE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|ico|pdf|zip|tar|gz|mp4|mp3|wav|mov|avi|woff2?|ttf|eot|css|js|map)(?:\?|$)/i;

/** Resuelve la URL absoluta de un host base. */
function homeOf(domain: string): string {
  const clean = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return "https://" + clean.replace(/^www\./, "") + "/";
}

/** Parsea robots.txt y devuelve URLs absolutas de Sitemap: declaradas. */
async function sitemapsFromRobots(domain: string): Promise<string[]> {
  const url = new URL("/robots.txt", homeOf(domain)).toString();
  const txt = await fetch(url, {
    headers: { Accept: "text/plain" },
    redirect: "follow",
    // robots.txt es chico; un timeout corto basta.
    signal: AbortSignal.timeout(8000),
  })
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  if (!txt) return [];
  const out: string[] = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*Sitemap:\s*(\S+)\s*$/i);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Recupera el cuerpo de un sitemap (XML); admite gzip transparente porque
 * `fetch` ya lo decomprime cuando el Content-Encoding está bien. Devuelve
 * "" si no es texto/XML.
 */
async function fetchSitemapXml(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/xml, text/xml, */*" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return "";
    const ct = res.headers.get("content-type") || "";
    // Aceptamos xml y text (algunos servidores devuelven text/plain).
    if (!/xml|text\/plain|application\/octet-stream/i.test(ct)) return "";
    const txt = await res.text();
    return txt.slice(0, 5_000_000); // tope absurdo para que un sitemap fugado no nos vuele la RAM
  } catch {
    return "";
  }
}

/** Extrae todas las `<loc>...</loc>` de un sitemap. */
function locsFromSitemap(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const u = m[1].trim();
    if (u) out.push(u);
  }
  return out;
}

/** Detecta si el XML es un "sitemap index" (lista otros sitemaps). */
function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex\b/i.test(xml);
}

/**
 * Devuelve URLs descubiertas vía sitemap (siguiendo índices anidados con
 * profundidad limitada a 2). Vacío si el dominio no publica sitemap.
 */
async function discoverFromSitemap(domain: string, maxUrls: number): Promise<string[]> {
  let candidates = await sitemapsFromRobots(domain);
  if (candidates.length === 0) {
    candidates = SITEMAP_FALLBACKS.map((p) => new URL(p, homeOf(domain)).toString());
  }

  const collected = new Set<string>();
  const queue: string[] = [...candidates];
  const visitedSitemaps = new Set<string>();
  let depth = 0;
  while (queue.length && collected.size < maxUrls && depth < 4) {
    depth++;
    const batch = queue.splice(0, queue.length);
    const xmls = await mapLimit(batch, 4, async (sm) => {
      if (visitedSitemaps.has(sm)) return { sm, xml: "" };
      visitedSitemaps.add(sm);
      const xml = await fetchSitemapXml(sm);
      return { sm, xml };
    });
    for (const { xml } of xmls) {
      if (!xml) continue;
      const locs = locsFromSitemap(xml);
      if (isSitemapIndex(xml)) {
        // Sub-sitemaps a procesar en la siguiente vuelta.
        for (const l of locs) queue.push(l);
      } else {
        for (const l of locs) {
          if (IGNORE_EXT_RE.test(l)) continue;
          collected.add(l);
          if (collected.size >= maxUrls) break;
        }
      }
    }
  }
  return [...collected].slice(0, maxUrls);
}

export interface DeepScrapeResult {
  /** Cuántas URLs nos publicó el sitemap (antes de scrapear). */
  discovered: number;
  /** Cuántas hemos podido fetchear. */
  visited: number;
  /** Emails únicos hallados en cualquier página del dominio. */
  emails: string[];
  /** ¿Usamos sitemap (true) o tuvimos que caer al modo "slugs comunes" (false)? */
  usedSitemap: boolean;
}

export interface DeepScrapeOpts {
  maxUrls?: number;
  concurrency?: number;
  /**
   * Callback opcional: se llama por cada página visitada con su HTML. Permite
   * al caller extraer enlaces externos / metadatos sin tener que re-fetchear
   * la página. Evita duplicar tráfico.
   */
  onPage?: (url: string, html: string) => void;
}

/**
 * Scrape PROFUNDO de un dominio: descubre todas las páginas vía sitemap y
 * extrae emails de todas. Si no hay sitemap, devuelve `usedSitemap=false` y
 * la lista de emails que haya en la home (luego el caller decide si combina
 * con el scrape de slugs comunes).
 */
export async function deepScrape(
  domain: string,
  opts: DeepScrapeOpts = {},
): Promise<DeepScrapeResult> {
  const maxUrls = Math.max(1, Math.min(300, opts.maxUrls ?? 80));
  const concurrency = Math.max(1, Math.min(12, opts.concurrency ?? 6));
  const onPage = opts.onPage;
  const urls = await discoverFromSitemap(domain, maxUrls);

  if (urls.length === 0) {
    // Sin sitemap: al menos sacamos los emails que estén en la home y
    // marcamos que no hubo crawl profundo, para que el caller decida si
    // hace fallback a los slugs comunes del leadfinder original.
    const home = homeOf(domain);
    const html = (await fetchHtml(home)) || "";
    if (html && onPage) onPage(home, html);
    return {
      discovered: 0,
      visited: html ? 1 : 0,
      emails: html ? extractEmails(html) : [],
      usedSitemap: false,
    };
  }

  const emails = new Set<string>();
  let visited = 0;
  await mapLimit(urls, concurrency, async (u) => {
    const html = await fetchHtml(u);
    if (!html) return;
    visited++;
    for (const e of extractEmails(html)) emails.add(e);
    if (onPage) {
      try {
        onPage(u, html);
      } catch {
        /* el callback no debe romper el crawl */
      }
    }
  });
  return {
    discovered: urls.length,
    visited,
    emails: [...emails],
    usedSitemap: true,
  };
}
