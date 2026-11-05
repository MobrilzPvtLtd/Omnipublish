/**
 * IDs de anuncio/campaña de Meta → NOMBRE legible.
 *
 * Los enlaces de anuncios llegan con utm_content/utm_campaign = ID numérico de Meta
 * (p.ej. utm_content=120248632964570447). En el panel eso es ilegible: nadie sabe
 * qué anuncio es. Con el token de Meta Ads ya conectado resolvemos
 * GET graph.facebook.com/<id>?fields=name y cacheamos (los nombres no cambian casi
 * nunca; la caché persiste en settings para sobrevivir redeploys).
 *
 * Best-effort SIEMPRE: sin token, o si Meta falla, se devuelve una etiqueta corta
 * («anuncio …0447») y la vista sigue funcionando.
 */
import { get as getSetting, set as setSetting } from "./settings.js";
import { metaAdsAccountsList } from "./metaAds.js";

const CACHE_KEY = "meta.adNamesCache";
let mem: Record<string, string> | null = null;

function loadCache(): Record<string, string> {
  if (mem) return mem;
  try { mem = JSON.parse(getSetting(CACHE_KEY) || "{}") as Record<string, string>; }
  catch { mem = {}; }
  return mem!;
}

async function saveCache(): Promise<void> {
  try { await setSetting(CACHE_KEY, JSON.stringify(mem || {})); } catch { /* best-effort */ }
}

/** ¿Parece un ID de objeto de Meta Ads? (los ids de ads/campaigns son de 15-20 dígitos) */
export function looksLikeMetaAdId(v: string): boolean {
  return /^\d{13,20}$/.test(String(v || "").trim());
}

/** Etiqueta corta de reserva cuando no hay nombre. */
export function shortAdLabel(id: string, kind: "anuncio" | "campaña" = "anuncio"): string {
  return kind + " …" + String(id).slice(-6);
}

/**
 * Resuelve un lote de IDs a nombres. Devuelve mapa id→nombre SOLO con los resueltos
 * (caché incluida). Los fallos se cachean como "" para no repetir la llamada.
 */
export async function resolveMetaAdNames(ids: string[]): Promise<Record<string, string>> {
  const cache = loadCache();
  const uniq = [...new Set(ids.filter(looksLikeMetaAdId))];
  const pending = uniq.filter((id) => cache[id] === undefined);
  if (pending.length) {
    const token = metaAdsAccountsList()[0]?.token || getSetting("meta.adsToken") || getSetting("whatsapp.accessToken");
    if (token) {
      // Secuencial con tope: pocas ids nuevas por vista; no queremos ráfagas a Graph.
      for (const id of pending.slice(0, 25)) {
        try {
          const res = await fetch(`https://graph.facebook.com/v21.0/${id}?fields=name`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8_000),
          });
          const j = (await res.json().catch(() => ({}))) as { name?: string };
          cache[id] = res.ok && j.name ? String(j.name).slice(0, 80) : "";
        } catch {
          cache[id] = "";
        }
      }
      await saveCache();
    }
  }
  const out: Record<string, string> = {};
  for (const id of uniq) if (cache[id]) out[id] = cache[id];
  return out;
}
