/**
 * Métricas de Instagram (estilo Metricool, versión panel):
 *  - Resumen de cuenta: seguidores, nº de publicaciones, alcance,
 *    visitas al perfil, cuentas alcanzadas/engaged (Insights API).
 *  - Rendimiento por publicación: likes, comentarios, alcance, guardados.
 *
 * La API de Insights de Instagram es quisquillosa y cambia entre
 * versiones; cada llamada va aislada y degrada con elegancia (nunca
 * lanza): si una métrica no está disponible, simplemente no aparece.
 */
import { quickReply } from "./brain.js";
import { activeIgCreds } from "./instagram.js";
import { currentWorkspaceId } from "./workspace.js";

const BASE = "https://graph.facebook.com/v21.0";

// Cuenta IG activa (respeta el selector multi-cuenta vía AsyncLocalStorage).
function creds(): { token: string; igId: string } {
  return activeIgCreds();
}

// Cache nivel función (memoización con TTL + dedup inflight) por igId.
// Las llamadas a accountMetrics/topPosts/followerSeries/bestTimes son las
// más lentas del backend (1-4s cada una porque llaman a Graph API de Meta);
// memoizar por (function, igId) reduce drásticamente la latencia percibida
// porque varios endpoints HTTP llaman a las mismas funciones internas.
const FN_CACHE = new Map<string, { data: unknown; ts: number }>();
const FN_INFLIGHT = new Map<string, Promise<unknown>>();
const FN_TTL_MS = 3 * 60 * 1000; // 3 min
// CACHE-PODA-1 · el TTL solo se miraba AL LEER una clave, así que una entrada que
// nadie vuelve a pedir (una cuenta de Instagram que se desconectó, un workspace que
// se archivó) se quedaba en el Map para siempre con su respuesta entera dentro: el
// proceso es de vida larga y la clave lleva workspace + igId, así que el número de
// claves distintas solo crece. Ahora cada escritura barre lo caducado y aplica un
// tope duro, y el Map se reordena (borrar antes de escribir) para que lo que salga
// al tocar el tope sea lo más viejo.
const FN_CACHE_MAX = 500;
function podarFnCache(): void {
  const ahora = Date.now();
  for (const [k, v] of FN_CACHE) if (ahora - v.ts >= FN_TTL_MS) FN_CACHE.delete(k);
  let sobran = FN_CACHE.size - FN_CACHE_MAX;
  if (sobran <= 0) return;
  for (const k of FN_CACHE.keys()) {
    if (sobran-- <= 0) break;
    FN_CACHE.delete(k);
  }
}
async function memo<T>(rawKey: string, fn: () => Promise<T>): Promise<T> {
  // CACHE-TENANT (T05 2026-08-25) · la clave lleva SIEMPRE el workspace: por
  // igId a secas, un tenant que declarase el igId de otro podía servirse las
  // métricas cacheadas del dueño (el hit de caché no re-valida credenciales).
  const key = `${currentWorkspaceId()}|${rawKey}`;
  const c = FN_CACHE.get(key);
  if (c && Date.now() - c.ts < FN_TTL_MS) return c.data as T;
  const inflight = FN_INFLIGHT.get(key);
  if (inflight) return inflight as Promise<T>;
  const p = (async () => {
    try {
      const data = await fn();
      // CACHE-PODA-1 · barrido de caducadas + tope ANTES de guardar; el delete previo
      // reordena la clave al final (Map conserva el orden de inserción).
      FN_CACHE.delete(key);
      podarFnCache();
      FN_CACHE.set(key, { data, ts: Date.now() });
      return data;
    } finally {
      FN_INFLIGHT.delete(key);
    }
  })();
  FN_INFLIGHT.set(key, p);
  return p;
}
export function invalidateMetricsCache(igId?: string): void {
  if (igId) {
    for (const k of [...FN_CACHE.keys()]) if (k.includes(igId)) FN_CACHE.delete(k);
  } else {
    FN_CACHE.clear();
  }
}

async function g(path: string, timeoutMs = 12_000): Promise<any> {
  const { token } = creds();
  const sep = path.includes("?") ? "&" : "?";
  try {
    // SEGUIDORES-DASH-1: con tope; sin él, una llamada colgada dejaba el Panel de control en blanco.
    const r = await fetch(`${BASE}/${path}${sep}access_token=${token}`, { signal: AbortSignal.timeout(timeoutMs) });
    const d = await r.json().catch(() => ({}));
    return r.ok ? d : { _error: d?.error?.message || `HTTP ${r.status}` };
  } catch (e) {
    return { _error: (e as Error).message };
  }
}

export interface AccountMetrics {
  configured: boolean;
  username?: string;
  name?: string;
  profilePictureUrl?: string;
  biography?: string;
  followers?: number;
  follows?: number;
  mediaCount?: number;
  reach?: number;
  profileViews?: number;
  accountsEngaged?: number;
  // Métricas premium (28 días) — degradan a undefined si la API no las da.
  interactions?: number;
  likes?: number;
  comments?: number;
  saves?: number;
  shares?: number;
  views?: number;
  profileLinksTaps?: number;
  engagementRate?: number; // % = interacciones / alcance
  engagementRateBasis?: "reach" | "followers"; // denominador REAL usado (la UI lo etiqueta)
  // COMUNIDAD-IG-1 (MET-IG-06): Graph entrega varias cifras de 28 días como CAMBIO NETO y pueden
  // llegar negativas (me gusta retirados, publicaciones borradas). No se ocultan ni se ponen a
  // cero: `ajustes` lista qué claves llegaron así y `cifrasDudosas` avisa a la UI (también cuando
  // el total de interacciones es menor que la suma de sus partes) para que no derive
  // porcentajes, consejos ni colores de una cifra que no es un recuento.
  ajustes?: string[];
  cifrasDudosas?: boolean;
  note?: string;
}

export async function accountMetrics(): Promise<AccountMetrics> {
  const { token, igId } = creds();
  if (!token || !igId)
    return { configured: false, note: "Instagram no está conectado." };
  return memo(`accountMetrics:${igId}`, () => _accountMetricsRaw(token, igId));
}
async function _accountMetricsRaw(_token: string, igId: string): Promise<AccountMetrics> {
  const prof = await g(
    `${igId}?fields=username,name,profile_picture_url,biography,followers_count,follows_count,media_count`,
  );
  const out: AccountMetrics = {
    configured: true,
    username: prof.username,
    name: prof.name,
    profilePictureUrl: prof.profile_picture_url,
    biography: prof.biography,
    followers: prof.followers_count,
    follows: prof.follows_count,
    mediaCount: prof.media_count,
  };

  // Insights de cuenta (últimos 28 días). Métricas modernas piden
  // metric_type=total_value; si la versión no las da, se ignoran.
  const ins = await g(
    `${igId}/insights?metric=reach,profile_views&period=day&metric_type=total_value&since=${Math.floor(Date.now() / 1000) - 28 * 86400}&until=${Math.floor(Date.now() / 1000)}`,
  );
  for (const m of ins?.data ?? []) {
    const v = m?.total_value?.value ?? m?.values?.[0]?.value;
    if (m.name === "reach" && typeof v === "number") out.reach = v;
    if (m.name === "profile_views" && typeof v === "number") out.profileViews = v;
  }
  const since = Math.floor(Date.now() / 1000) - 28 * 86400;
  const until = Math.floor(Date.now() / 1000);
  // Familia de interacción (28d). Va en grupos para resistir si la API rechaza alguna.
  const grab = async (metrics: string) => {
    const r = await g(`${igId}/insights?metric=${metrics}&period=day&metric_type=total_value&since=${since}&until=${until}`);
    const map: Record<string, number> = {};
    for (const m of r?.data ?? []) {
      const v = m?.total_value?.value ?? m?.values?.[0]?.value;
      if (typeof v === "number") map[m.name] = v;
    }
    return map;
  };
  const a1 = await grab("accounts_engaged,total_interactions,views");
  const a2 = await grab("likes,comments,saves,shares");
  const a3 = await grab("profile_links_taps");
  out.accountsEngaged = a1.accounts_engaged;
  out.interactions = a1.total_interactions;
  out.views = a1.views;
  out.likes = a2.likes;
  out.comments = a2.comments;
  out.saves = a2.saves;
  out.shares = a2.shares;
  out.profileLinksTaps = a3.profile_links_taps;
  // COMUNIDAD-IG-1 (MET-IG-06): una cifra negativa es un cambio neto, no un recuento; un total
  // de interacciones menor que la suma de sus partes es un recuento imposible. Se declaran.
  const claves: (keyof AccountMetrics)[] = ["likes", "comments", "saves", "shares", "interactions", "views", "accountsEngaged", "reach", "profileViews", "profileLinksTaps"];
  const negativas = claves.filter((k) => typeof out[k] === "number" && (out[k] as number) < 0);
  const partes = [out.likes, out.comments, out.saves, out.shares];
  const sumaPartes = partes.every((v) => typeof v === "number" && v >= 0) ? partes.reduce((s, v) => s + (v as number), 0) : null;
  const noCuadra = sumaPartes != null && typeof out.interactions === "number" && out.interactions >= 0 && out.interactions < sumaPartes;
  if (negativas.length) out.ajustes = negativas;
  if (negativas.length || noCuadra) out.cifrasDudosas = true;
  // Tasa de engagement = interacciones / alcance. Si Meta no da alcance, cae a
  // /seguidores — pero AVISANDO: engagementRateBasis dice el denominador real para
  // que la UI no etiquete igual dos ratios inconmensurables (COUNCIL-FIX).
  // Con cifra dudosa no se calcula: el porcentaje saldría falso (COMUNIDAD-IG-1).
  if (out.cifrasDudosas) { /* sin tasa: la UI lo dice */ }
  else if (out.interactions != null && out.reach) { out.engagementRate = Math.round((out.interactions / out.reach) * 1000) / 10; out.engagementRateBasis = "reach"; }
  else if (out.interactions != null && out.followers) { out.engagementRate = Math.round((out.interactions / out.followers) * 1000) / 10; out.engagementRateBasis = "followers"; }

  if (ins?._error && !out.reach)
    out.note =
      "Algunas métricas de Insights no están disponibles todavía (la cuenta necesita actividad reciente o permisos de insights).";
  return out;
}

export interface PostMetric {
  id: string;
  caption: string;
  type: string;
  permalink: string;
  timestamp: string;
  likes: number;
  comments: number;
  reach?: number;
  saved?: number;
  // Enriquecidas por publicación (familia "discovery"; degradan a undefined
  // si el tipo de medio no las soporta — se piden en llamada aislada).
  follows?: number; // seguidores conseguidos gracias a esta publicación
  profileVisits?: number; // visitas al perfil desde esta publicación
  shares?: number; // veces compartida
  views?: number; // reproducciones / visualizaciones (impresiones unificadas)
  engRate?: number; // % engagement de la publicación = interacciones / alcance
  thumbnailUrl?: string; // portada (para la vista premium)
  mediaProductType?: string; // FEED | REELS | STORY | AD
  avgWatchTime?: number; // Reels: tiempo medio de visionado (segundos)
  replays?: number; // Reels: reproducciones repetidas
}

/**
 * Publicaciones recientes con sus métricas. Con `withDiscovery` enriquece las
 * primeras 12 con follows/visitas-al-perfil/compartidos por publicación (la
 * API los rechaza en algunos tipos de medio, así que van en llamada aislada
 * que degrada con elegancia post a post).
 */
export async function topPosts(limit = 12, withDiscovery = false): Promise<PostMetric[]> {
  const { token, igId } = creds();
  if (!token || !igId) return [];
  return memo(`topPosts:${igId}:${limit}:${withDiscovery ? 1 : 0}`, () => _topPostsRaw(igId, limit, withDiscovery));
}
async function _topPostsRaw(igId: string, limit: number, withDiscovery: boolean): Promise<PostMetric[]> {
  const d = await g(
    `${igId}/media?fields=id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url,children{media_url,thumbnail_url},insights.metric(reach,saved)&limit=${limit}`,
  );
  const base: PostMetric[] = (d?.data ?? []).map((m: any) => {
    const ins: Record<string, number> = {};
    // PULIDO-IG-1 (MET-IG-08) · Una métrica que Instagram no entrega queda sin valor, no en 0:
    // el `?? 0` de antes pintaba «alcance 0» en publicaciones con miles de vistas.
    for (const i of m?.insights?.data ?? []) {
      const v = i?.values?.[0]?.value ?? i?.total_value?.value;
      if (typeof v === "number") ins[i.name] = v;
    }
    const child = m?.children?.data?.[0] || {};
    return {
      id: m.id,
      caption: (m.caption || "").replace(/\s+/g, " ").slice(0, 90),
      type: m.media_type || "POST",
      mediaProductType: m.media_product_type || "",
      permalink: m.permalink || "",
      timestamp: m.timestamp || "",
      likes: m.like_count ?? 0,
      comments: m.comments_count ?? 0,
      reach: ins.reach,
      saved: ins.saved,
      thumbnailUrl: m.thumbnail_url || m.media_url || child.thumbnail_url || child.media_url || "",
    };
  });
  if (withDiscovery) {
    // COUNCIL-FIX: se enriquecen las 12 que el panel MUESTRA (antes 8): con muestras
    // distintas, las medias, el ranking por engagement y los follows por formato
    // mezclaban posts con y sin discovery en la misma card sin decirlo.
    await Promise.all(
      base.slice(0, 12).map(async (p) => {
        const apply = (r: any) => {
          for (const m of r?.data ?? []) {
            const v = m?.total_value?.value ?? m?.values?.[0]?.value;
            if (typeof v !== "number") continue;
            if (m.name === "follows") p.follows = v;
            else if (m.name === "profile_visits") p.profileVisits = v;
            else if (m.name === "shares") p.shares = v;
            else if (m.name === "views") p.views = v;
            else if (m.name === "clips_replays_count") p.replays = v;
            else if (m.name === "ig_reels_avg_watch_time") p.avgWatchTime = Math.round(v / 100) / 10; // ms → s
          }
        };
        // Feed (imagen/carrusel): follows + profile_visits + shares + views en una sola llamada.
        let main = await g(`${p.id}/insights?metric=follows,profile_visits,shares,views&metric_type=total_value`);
        if (main?._error) {
          // Reels: Instagram NO expone follows/profile_visits a nivel de medio. Pide lo
          // que sí hay (shares, views) + las métricas propias de Reels. Cada una degrada sola.
          // COUNCIL-FIX: ig_reels_avg_watch_time va SOLA — clips_replays_count fue
          // eliminada por Meta (2025-04) para TODAS las versiones y el #100 de la
          // llamada conjunta mataba también el watch time (9/9 reels sin dato en prod).
          apply(await g(`${p.id}/insights?metric=shares,views&metric_type=total_value`));
          apply(await g(`${p.id}/insights?metric=ig_reels_avg_watch_time&metric_type=total_value`));
        } else {
          apply(main);
        }
        // % engagement de la publicación (interacciones / alcance).
        if (p.reach) {
          const inter = (p.likes || 0) + (p.comments || 0) + (p.saved || 0) + (p.shares || 0);
          p.engRate = Math.round((inter / p.reach) * 1000) / 10;
        }
      }),
    );
  }
  // PULIDO-IG-1 · Alcance 0 con vistas, me gusta, comentarios, guardados o compartidos no es un
  // cero medido (en producción: alcance 0 y 57.555 vistas): es un dato que no llegó → «—».
  for (const p of base) {
    const senales = (p.likes || 0) + (p.comments || 0) + (p.saved || 0) + (p.shares || 0) + (p.views || 0);
    if (p.reach === 0 && senales > 0) p.reach = undefined;
  }
  return base;
}

/**
 * Alcance de los últimos 28 días desglosado por tipo de cuenta
 * (seguidores vs no seguidores). El % de no-seguidores es la tasa de
 * descubrimiento — clave para saber si el contenido llega fuera de tu base.
 * Degrada a {} si la API no da el breakdown.
 */
export async function audienceReach(): Promise<{ followers?: number; nonFollowers?: number; total?: number }> {
  const { token, igId } = creds();
  if (!token || !igId) return {};
  return memo(`audienceReach:${igId}`, () => _audienceReachRaw(igId));
}
async function _audienceReachRaw(igId: string): Promise<{ followers?: number; nonFollowers?: number; total?: number }> {
  const since = Math.floor(Date.now() / 1000) - 28 * 86400;
  const until = Math.floor(Date.now() / 1000);
  const r = await g(
    `${igId}/insights?metric=reach&breakdown=follow_type&period=day&metric_type=total_value&since=${since}&until=${until}`,
  );
  const tv = r?.data?.[0]?.total_value;
  if (!tv) return {};
  const out: { followers?: number; nonFollowers?: number; total?: number } = { total: tv.value };
  for (const bd of tv.breakdowns ?? [])
    for (const res of bd.results ?? []) {
      const key = String(res?.dimension_values?.[0] || "").toUpperCase();
      if (typeof res.value !== "number") continue;
      if (key === "FOLLOWER") out.followers = res.value;
      else if (key === "NON_FOLLOWER") out.nonFollowers = res.value;
    }
  return out;
}

/**
 * Análisis IA de la cuenta: a partir del resumen + posts, el LLM explica
 * qué funciona, qué no, y da recomendaciones accionables (en español).
 */
export async function analyzeMetrics(): Promise<string> {
  const [a, posts] = await Promise.all([accountMetrics(), topPosts(12)]);
  if (!a.configured) return "Configura Instagram en Ajustes para ver el análisis.";

  const score = (p: PostMetric) =>
    p.likes + p.comments * 3 + (p.saved ?? 0) * 5;
  const ranked = [...posts].sort((x, y) => score(y) - score(x));
  const fmt = (p: PostMetric) =>
    `[${p.type}] "${p.caption || p.id}" — ${p.likes} likes, ${p.comments} coment., ${p.reach ?? "?"} alcance, ${p.saved ?? "?"} guardados`;

  const data = [
    `Cuenta: @${a.username} · ${a.followers} seguidores · ${a.mediaCount} publicaciones`,
    `28 días: alcance ${a.reach ?? "?"}, visitas perfil ${a.profileViews ?? "?"}, cuentas activas ${a.accountsEngaged ?? "?"}`,
    "",
    "TOP publicaciones (mejor a peor por engagement):",
    ...ranked.slice(0, 6).map((p, i) => `${i + 1}. ${fmt(p)}`),
    "",
    "PEORES:",
    ...ranked.slice(-3).map((p) => `- ${fmt(p)}`),
  ].join("\n");

  const sys =
    "Eres analista de redes sociales. Analiza estos datos reales de una cuenta de Instagram y responde en español, conciso y accionable, con esta estructura exacta usando estos encabezados en MAYÚSCULAS:\n" +
    "QUÉ FUNCIONA: (2-3 puntos: formatos, temas o ganchos que rinden, con el dato que lo respalda)\n" +
    "QUÉ NO FUNCIONA: (1-2 puntos)\n" +
    "RECOMENDACIONES: (3 acciones concretas para la próxima semana)\n" +
    "Sin relleno, sin markdown, frases cortas. Basa todo en los números dados, no inventes.";

  const out = await quickReply(sys, data);
  return out || "No se pudo generar el análisis ahora mismo. Reinténtalo en un momento.";
}

/** Serie temporal de nuevos seguidores por día (Insights, ~30 días). */
export async function followerSeries(): Promise<{ date: string; value: number }[]> {
  const { token, igId } = creds();
  if (!token || !igId) return [];
  return memo(`followerSeries:${igId}`, () => _followerSeriesRaw(igId));
}
async function _followerSeriesRaw(igId: string): Promise<{ date: string; value: number }[]> {
  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const until = Math.floor(Date.now() / 1000);
  const d = await g(
    `${igId}/insights?metric=follower_count&period=day&since=${since}&until=${until}`,
  );
  const m = (d?.data ?? []).find((x: any) => x.name === "follower_count");
  // COUNCIL-FIX: end_time de Graph Insights es el FIN (exclusivo) del bucket diario:
  // etiquetarlo tal cual corría toda la serie +1 día (y el growth sumaba una ventana
  // desplazada). Restamos 24h para que cada punto lleve el día que realmente mide.
  // METRICAS-1 · un día sin `value` es dato ausente, no 0 seguidores: se descarta (un 0 inventado
  // se leía luego como una caída de todos los seguidores y una recuperación al día siguiente).
  return (m?.values ?? []).filter((v: any) => typeof v.value === "number").map((v: any) => {
    const t = Date.parse(v.end_time || "");
    return {
      date: isNaN(t) ? String(v.end_time || "").slice(0, 10) : new Date(t - 86400000).toISOString().slice(0, 10),
      value: v.value as number,
    };
  });
}

/**
 * Mejores momentos para publicar: cruza fecha de cada post con su
 * engagement y devuelve ranking de día de la semana y franja horaria.
 */
export async function bestTimes(): Promise<{
  byDay: { label: string; score: number; n: number }[];
  byHour: { label: string; score: number; n: number }[];
}> {
  const { igId } = creds();
  return memo(`bestTimes:${igId || "main"}`, () => _bestTimesRaw());
}
async function _bestTimesRaw(): Promise<{
  byDay: { label: string; score: number; n: number }[];
  byHour: { label: string; score: number; n: number }[];
}> {
  const posts = await topPosts(25);
  const dayNames = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const dAcc: Record<number, { s: number; n: number }> = {};
  const hAcc: Record<number, { s: number; n: number }> = {};
  for (const p of posts) {
    if (!p.timestamp) continue;
    const t = new Date(p.timestamp);
    if (isNaN(+t)) continue;
    const eng = p.likes + p.comments * 3 + (p.saved ?? 0) * 5;
    // Contrato explícito: byHour SIEMPRE en UTC (la UI rota a la zona del viewer).
    // getHours() dependía de la TZ del servidor: en Railway es UTC y coincide, pero
    // en local no — y el cliente rota asumiendo UTC.
    const dk = t.getUTCDay();
    const hk = t.getUTCHours();
    (dAcc[dk] ??= { s: 0, n: 0 }), (dAcc[dk].s += eng), dAcc[dk].n++;
    (hAcc[hk] ??= { s: 0, n: 0 }), (hAcc[hk].s += eng), hAcc[hk].n++;
  }
  // PULIDO-IG-1 · `n` = publicaciones detrás de cada día u hora: con menos de 3 no hay
  // patrón y el panel no da el consejo (una sola publicación disparada decidía «tu mejor hora»).
  const rank = (acc: Record<number, { s: number; n: number }>, fmt: (k: number) => string) =>
    Object.entries(acc)
      .map(([k, v]) => ({ label: fmt(+k), score: Math.round(v.s / v.n), n: v.n }))
      .sort((a, b) => b.score - a.score);
  return {
    byDay: rank(dAcc, (k) => dayNames[k]),
    byHour: rank(hAcc, (k) => `${String(k).padStart(2, "0")}:00`),
  };
}

export interface Demographics {
  countries: { label: string; value: number }[];
  cities: { label: string; value: number }[];
  age: { label: string; value: number }[];
  gender: { label: string; value: number }[];
}

/** Demografía de seguidores (países, ciudades, edad, género). Requiere ≥100
 *  seguidores + permiso de insights; degrada a vacío si la API no lo da. */
export async function audienceDemographics(): Promise<Demographics> {
  const { token, igId } = creds();
  const empty: Demographics = { countries: [], cities: [], age: [], gender: [] };
  if (!token || !igId) return empty;
  return memo(`audienceDemographics:${igId}`, () => _audienceDemographicsRaw(igId, empty));
}
async function _audienceDemographicsRaw(igId: string, empty: Demographics): Promise<Demographics> {
  const fetchBreak = async (breakdown: string) => {
    const r = await g(
      `${igId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=${breakdown}`,
    );
    const m = (r?.data ?? []).find((x: any) => x.name === "follower_demographics");
    const results = m?.total_value?.breakdowns?.[0]?.results ?? [];
    return (results as any[])
      .map((x) => ({ label: (x.dimension_values || []).join(" "), value: x.value || 0 }))
      .filter((x) => x.label)
      .sort((a, b) => b.value - a.value);
  };
  const [countries, cities, age, gender] = await Promise.all([
    fetchBreak("country"),
    fetchBreak("city"),
    fetchBreak("age"),
    fetchBreak("gender"),
  ]);
  return { countries: countries.slice(0, 8), cities: cities.slice(0, 8), age, gender };
}
