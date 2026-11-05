/**
 * Radar de Tendencias: trae titulares de varias fuentes (RSS/Atom) y los etiqueta por
 * POTENCIAL DE HOOK (alto/medio/bajo) + categoría con el LLM, para inspirar contenido.
 *
 * Fuentes configurables en settings `trends.feeds` (una por línea o separadas por coma);
 * si no hay, usa un conjunto por defecto de IA/tech/marketing. Degrada con elegancia:
 * un feed caído no rompe el resto, y sin LLM cae a "medio".
 */
import crypto from "node:crypto";
import { get } from "./settings.js";
import { quickReply } from "./brain.js";
import { dbUpsertTrends, dbListTrends, type Trend } from "./db.js";

const DEFAULT_FEEDS = [
  "https://techcrunch.com/category/artificial-intelligence/feed/",
  "https://www.theverge.com/rss/index.xml",
  "https://openai.com/news/rss.xml",
  "https://news.ycombinator.com/rss",
];

function feeds(): string[] {
  const cfg = (get("trends.feeds") || "").trim();
  if (cfg) return cfg.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  return DEFAULT_FEEDS;
}

type RawItem = { title: string; url: string; published: number | null; source: string };

function clean(s: string): string {
  return s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
}

function parseFeed(xml: string, source: string): RawItem[] {
  const out: RawItem[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks.slice(0, 15)) {
    const title = clean(b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
    let url = b.match(/<link[^>]*href="([^"]+)"/i)?.[1] || b.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || "";
    url = clean(url);
    const dateStr = b.match(/<(pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/\1>/i)?.[2] || "";
    const t = dateStr ? new Date(dateStr.trim()).getTime() : NaN;
    if (title) out.push({ title, url, published: isNaN(t) ? null : t, source });
  }
  return out;
}

export async function refreshTrends(tenantId = "default"): Promise<Trend[]> {
  const all: RawItem[] = [];
  await Promise.all(
    feeds().map(async (f) => {
      try {
        const r = await fetch(f, { headers: { "user-agent": "Mozilla/5.0 (compatible; LeadMatchBot/1.0)" } });
        if (!r.ok) return;
        const xml = await r.text();
        let host = f;
        try { host = new URL(f).hostname.replace(/^www\./, ""); } catch { /* deja la url */ }
        for (const it of parseFeed(xml, host)) all.push(it);
      } catch { /* feed caído → siguiente */ }
    }),
  );
  const seen = new Set<string>();
  const items = all
    .filter((it) => { const k = it.url || it.title; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.published || 0) - (a.published || 0))
    .slice(0, 24);
  if (!items.length) return await dbListTrends(tenantId);

  // Etiqueta TODO en una sola llamada al LLM (barato).
  let tags: { potencial?: string; categoria?: string }[] = [];
  try {
    const sys =
      "Eres estratega de contenido viral. Para cada titular, evalúa su POTENCIAL DE HOOK (capacidad de generar un reel/post viral) como 'alto', 'medio' o 'bajo', y asígnale una CATEGORÍA corta (IA, Marketing, Negocios, Producto, Tecnología). " +
      'Devuelve SOLO un array JSON en el MISMO orden, sin texto extra: [{"potencial":"alto|medio|bajo","categoria":"..."}]';
    const raw = await quickReply(sys, items.map((it, i) => `${i + 1}. ${it.title}`).join("\n"));
    const m = (raw || "").match(/\[[\s\S]*\]/);
    if (m) tags = JSON.parse(m[0]);
  } catch { /* sin IA → medio por defecto */ }

  const now = Date.now();
  const trends: Trend[] = items.map((it, i) => {
    const pot = String(tags[i]?.potencial || "").toLowerCase();
    return {
      id: crypto.createHash("sha1").update(it.url || it.title).digest("hex").slice(0, 16),
      title: it.title,
      url: it.url,
      source: it.source,
      category: tags[i]?.categoria || "",
      hook_potential: (["alto", "medio", "bajo"].includes(pot) ? pot : "medio") as Trend["hook_potential"],
      published_at: it.published,
      fetched_at: now,
    };
  });
  await dbUpsertTrends(trends, tenantId);
  return await dbListTrends(tenantId);
}
