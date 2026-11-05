/**
 * PIEZAS-FB-1 (MET-FB-02) · Lo que se puede DEMOSTRAR de cada publicación de una
 * Página de Facebook, además de sus cifras (que siguen en facebook.ts):
 *
 *   1) Si se promocionó con un anuncio. Se mira en las cuentas publicitarias
 *      conectadas: un anuncio cuya creatividad apunta a la publicación
 *      (`effective_object_story_id` = "{pageId}_{postId}") y que llegó a mostrarse
 *      (impresiones > 0). Un anuncio creado y nunca activado no la convierte en
 *      promocionada. El campo `promotion_status` de la publicación ya no está en la
 *      referencia de Graph: no se usa.
 *      · Sin cuentas publicitarias → `promo: null` (no se sabe; no se pinta nada).
 *      · Lectura fallida o cortada → `completo: false`: se marcan las promocionadas
 *        que sí se vieron, pero NADIE se declara «orgánica».
 *      El gasto y los resultados de pago se quedan en Ads: aquí sólo se dice qué
 *      publicación tuvo anuncio, nunca se suman sus resultados a los de Facebook.
 *
 *   2) Quién llegó a una conversación desde ella. Dos fuentes, sin duplicar:
 *      · app_fb_entradas (dbFbEntradasPorPublicacion): el webhook anota la publicación
 *        cuando el comentario hizo nacer un run de flujo. Es la buena, pero sólo existe
 *        desde que se despliega PIEZAS-FB-1: lo anterior no se puede reconstruir.
 *      · runs que aún conservan __cid (dbFbEntradasPorComentario): el id del comentario
 *        es «{postId}_{commentId}» y su prefijo identifica la publicación. El motor borra
 *        __cid tras la primera respuesta privada, así que aporta poco; no estorba.
 */
import { get } from "./settings.js";
import { metaAdsAccountsList } from "./metaAds.js";
import { graphGet } from "./metaAdsGraph.js";
import { dbFbEntradasPorComentario, dbFbEntradasPorPublicacion } from "./db.js";
import { currentWorkspaceId } from "./workspace.js";

export interface FbPromo {
  /** true sólo si TODAS las cuentas se leyeron enteras: entonces lo no marcado es orgánico. */
  completo: boolean;
  /** postId completo ("{pageId}_{postId}") → anuncios que la mostraron. */
  posts: Record<string, { anuncios: number }>;
}
export interface FbConversacion { phone: string; name: string; at: number }
export interface FbPiezas {
  promo: FbPromo | null;
  /** id corto de la publicación (la parte tras "{pageId}_") → personas, la más reciente primero. */
  conversaciones: Record<string, FbConversacion[]>;
  /** Hay flujos que arrancan con comentarios de esta Página: el vínculo se puede reconstruir. */
  conVinculo: boolean;
  /**
   * PIEZAS-PERMISOS-FB-1 · false = quien pregunta no ve Contactos ni la Bandeja: las listas de
   * `conversaciones` sólo valen para CONTAR (teléfono y nombre vacíos). Ausente o true = datos completos.
   */
  personas?: boolean;
}

const TTL_MS = 30 * 60 * 1000;
const MAX_PAGINAS = 5; // 5 × 200 anuncios por cuenta; más → lectura incompleta
const MAX_CUENTAS = 5;
const cache = new Map<string, { at: number; v: FbPromo | null }>();

/** Id corto de una publicación: "{pageId}_{postId}" → "{postId}". */
export function fbPostCorto(id: string): string {
  const s = String(id || "");
  const i = s.indexOf("_");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Publicación de un comentario: "{postId}_{commentId}" → "{postId}"; otro formato → "". */
export function fbPostDeComentario(cid: string): string {
  const m = /^(\d+)_(\d+)$/.exec(String(cid || "").trim());
  return m ? m[1] : "";
}

async function leerPromo(pageId: string): Promise<FbPromo | null> {
  const cuentas = metaAdsAccountsList().slice(0, MAX_CUENTAS);
  if (!cuentas.length) return null;
  const posts: Record<string, { anuncios: number }> = {};
  let completo = metaAdsAccountsList().length <= MAX_CUENTAS;
  for (const c of cuentas) {
    const acc = String(c.adAccountId || "").replace(/^act_/, "");
    const token = c.token || get("meta.adsToken");
    if (!acc || !token) { completo = false; continue; }
    let after = "";
    let leida = false;
    for (let p = 0; p < MAX_PAGINAS; p++) {
      const r = await graphGet<any>(`act_${acc}/ads`, {
        fields: "creative{effective_object_story_id},insights.date_preset(maximum){impressions}",
        limit: 200,
        after: after || undefined,
      }, { token, timeoutMs: 10000 });
      if (!r.ok) { completo = false; break; }
      for (const ad of (r.data?.data || []) as any[]) {
        const sid = String(ad?.creative?.effective_object_story_id || "");
        if (!sid.startsWith(pageId + "_")) continue;
        const imp = Number(ad?.insights?.data?.[0]?.impressions || 0);
        if (!(imp > 0)) continue;
        posts[sid] = { anuncios: (posts[sid]?.anuncios || 0) + 1 };
      }
      after = String(r.data?.paging?.cursors?.after || "");
      if (!r.data?.paging?.next || !after) { leida = true; break; }
    }
    if (!leida) completo = false;
  }
  return { completo, posts };
}

export async function fbPiezas(pageId: string): Promise<FbPiezas> {
  const k = currentWorkspaceId() + "|" + pageId;
  let promo: FbPromo | null;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) promo = hit.v;
  else {
    promo = await leerPromo(pageId).catch(() => ({ completo: false, posts: {} }));
    cache.set(k, { at: Date.now(), v: promo });
  }
  const anotadas = await dbFbEntradasPorPublicacion(pageId).catch(() => []);
  const porRun = await dbFbEntradasPorComentario(pageId).catch(() => []);
  const filas = [
    ...anotadas.map((f) => ({ post: fbPostCorto(f.postId), phone: f.phone, name: f.name, at: f.at })),
    ...porRun.map((f) => ({ post: fbPostDeComentario(f.cid), phone: f.phone, name: f.name, at: f.at })),
  ].sort((a, b) => b.at - a.at);
  const conversaciones: Record<string, FbConversacion[]> = {};
  for (const f of filas) {
    const post = f.post;
    if (!post) continue;
    const l = (conversaciones[post] ||= []);
    // La misma persona en dos flujos desde la misma publicación es UNA conversación.
    if (!l.some((x) => x.phone === f.phone)) l.push({ phone: f.phone, name: f.name, at: f.at });
  }
  return { promo, conversaciones, conVinculo: Object.keys(conversaciones).length > 0, personas: true };
}

/**
 * PIEZAS-PERMISOS-FB-1 · lo que ve quien tiene Métricas pero NO Contactos ni la Bandeja: el mismo
 * resultado con cada conversación reducida a una casilla vacía. Conserva el NÚMERO de personas por
 * publicación (la cifra de la tabla) y quita quiénes son (teléfono, nombre y fecha de entrada).
 * Función pura: se aplica DESPUÉS de deduplicar por teléfono, así los contadores no cambian.
 */
export function fbPiezasSinPersonas(p: FbPiezas): FbPiezas {
  const conversaciones: Record<string, FbConversacion[]> = {};
  for (const k of Object.keys(p.conversaciones || {})) {
    conversaciones[k] = (p.conversaciones[k] || []).map(() => ({ phone: "", name: "", at: 0 }));
  }
  return { promo: p.promo, conversaciones, conVinculo: p.conVinculo, personas: false };
}
