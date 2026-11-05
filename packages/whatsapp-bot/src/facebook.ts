/**
 * Cliente Facebook Pages — Fase 1 (Conexiones).
 *
 * Comparte la misma OAuth Meta que Instagram: al callback `/admin/auth/meta/callback`
 * con platform=ig|fb, se llama a `/me/accounts` y se guardan las Pages en
 * `meta.fbAccounts` (JSON cifrado). Cada entrada lleva `pageId`, `name`,
 * `pageToken` (long-lived), `pictureUrl`, `addedAt`.
 *
 * Phase 2 (Messenger Inbox) añadirá scope `pages_messaging` y handlers webhook.
 * Phase 3 (Métricas Page) usará `pages_read_engagement` (ya incluido en el scope IG).
 */
import { get, set } from "./settings.js";
import { withKeyLock } from "./cerrojo-clave.js";
import { logActivity } from "./activity.js";
import { saveMetricSnapshot, getSnapshotSeries } from "./snapshots.js";
import { currentWorkspaceId } from "./workspace.js";

const BASE = "https://graph.facebook.com/v21.0";

// ============================================================
// Telemetría de los envíos a la Graph API (espejo de instagram.ts:270-284)
// ============================================================
//
// SOURCE = 'meta-api'. NO inventar 'fb-send': el CHECK de app_activity_log
// (db.ts) solo admite 11 valores y uno nuevo reventaría el INSERT — logActivity
// se traga el fallo con un console.warn, así que la telemetría quedaría MUDA
// justo en los errores que más importan.

/** Nunca guardamos el PSID/comment_id entero en el log. */
function maskRecipient(id: string): string {
  const s = String(id || "");
  if (!s) return "";
  return s.length > 7 ? s.slice(0, 4) + "***" + s.slice(-3) : s.slice(0, 4) + "***";
}

/** Pista accionable a partir del error de Meta (lo que hay que hacer, no el código). */
function fbErrHint(msg: string): string {
  // Meta prefija el mensaje con el código entre paréntesis: "(#200) …". Se
  // buscan CON paréntesis para no confundir (#100) con (#10).
  if (msg.includes("(#200)")) {
    return "Al token de la Página le falta pages_manage_engagement: reconecta la Página desde Conexiones → Facebook.";
  }
  if (/pages_messaging/i.test(msg)) {
    return "Al token de la Página le falta pages_messaging (Messenger): reconecta la Página desde Conexiones → Facebook.";
  }
  if (msg.includes("(#10)") || /outside.{0,20}window/i.test(msg)) {
    return "Fuera de la ventana de mensajería de Meta: solo se puede escribir dentro de las 24h siguientes al último mensaje de esa persona.";
  }
  return "";
}

/** Fire-and-forget: la telemetría NUNCA rompe ni retrasa el envío. */
function fbLogSendError(fn: string, pageId: string, recipientId: string, msg: string): void {
  logActivity({
    source: "meta-api",
    level: "error",
    summary: "Facebook · " + fn + ": " + msg.slice(0, 140),
    payload: {
      file: "facebook.ts",
      fn,
      pageId,
      recipientId: maskRecipient(recipientId),
      error: msg.slice(0, 400),
      hint: fbErrHint(msg),
    },
  }).catch(() => { /* la telemetría nunca rompe el envío */ });
}

export interface FbAccount {
  pageId: string;
  name: string;
  token: string;        // page_access_token (long-lived)
  pictureUrl?: string;  // CDN URL de la foto de perfil
  addedAt: number;      // timestamp ms
  // Quién autorizó esta Page — útil con multi-cuenta Meta (varias personas conectan
  // sus respectivas Pages desde el mismo panel). Se rellena en el callback OAuth
  // leyendo /me?fields=id,name antes de iterar las páginas.
  metaUserId?: string;
  metaUserName?: string;
  // IG Business Account ID conectado a esta Page (si lo hay). Permite resolver
  // page_token desde igId sin tener que volver a /me/accounts cada vez (lo necesita
  // sendIgText: POST /{pageId}/messages con page token).
  igBusinessAccountId?: string;
}

/** Versión pública (sin token) para el front. */
export type FbAccountPublic = Omit<FbAccount, "token">;

function readArray(): FbAccount[] {
  const raw = get("meta.fbAccounts") || "[]";
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((a) => a && a.pageId && a.token).map((a) => ({
      pageId: String(a.pageId),
      name: String(a.name || a.pageId),
      token: String(a.token),
      pictureUrl: a.pictureUrl ? String(a.pictureUrl) : undefined,
      addedAt: Number(a.addedAt) || Date.now(),
      metaUserId: a.metaUserId ? String(a.metaUserId) : undefined,
      metaUserName: a.metaUserName ? String(a.metaUserName) : undefined,
      igBusinessAccountId: a.igBusinessAccountId ? String(a.igBusinessAccountId) : undefined,
    }));
  } catch {
    return [];
  }
}

async function writeArray(arr: FbAccount[]): Promise<void> {
  await set("meta.fbAccounts", JSON.stringify(arr));
}

// CUENTAS-ATOMICO-1 · Todas las páginas viven en UNA clave de ajustes, así que
// cualquier cambio es leer-todo / modificar / escribir-todo con un await en medio.
// Esta es la clave que serializa esos tríos (ver cerrojo-clave.ts).
const CLAVE_FB = "meta.fbAccounts";

export function listFbAccounts(): FbAccount[] {
  return readArray();
}

export function listFbAccountsPublic(): FbAccountPublic[] {
  return readArray().map(({ token: _t, ...rest }) => rest);
}

export function getFbAccount(pageId: string): FbAccount | null {
  return readArray().find((a) => a.pageId === pageId) || null;
}

/** Primera Page conectada — equivalente a "principal" hasta que añadamos UI de selección. */
export function getActiveFbAccount(): FbAccount | null {
  const arr = readArray();
  return arr[0] || null;
}

export interface FbAccountInput {
  pageId: string;
  name: string;
  token: string;
  pictureUrl?: string;
  metaUserId?: string;
  metaUserName?: string;
  igBusinessAccountId?: string;
}

/**
 * Upsert idempotente de VARIAS páginas en UNA sola pasada de leer-modificar-escribir.
 *
 * CUENTAS-ATOMICO-1 · El alta de Facebook trae N páginas de golpe. Guardarlas de una
 * en una abría N ventanas seguidas en las que otra petición (desconectar una página,
 * por ejemplo) podía colarse entre la lectura y la escritura y perder trabajo. Con un
 * único upsert por lote, y con el trío entero dentro del cerrojo de la clave, esas
 * ventanas desaparecen.
 */
export async function upsertFbAccounts(inputs: FbAccountInput[]): Promise<{ added: number; updated: number }> {
  if (!inputs.length) return { added: 0, updated: 0 };
  return withKeyLock(CLAVE_FB, async () => {
    const arr = readArray();
    let added = 0, updated = 0;
    for (const input of inputs) {
      const idx = arr.findIndex((a) => a.pageId === input.pageId);
      if (idx >= 0) {
        // Preserve metaUser/igBusinessAccountId previo si el reauth no lo trae.
        arr[idx] = {
          ...arr[idx],
          name: input.name,
          token: input.token,
          pictureUrl: input.pictureUrl ?? arr[idx].pictureUrl,
          metaUserId: input.metaUserId ?? arr[idx].metaUserId,
          metaUserName: input.metaUserName ?? arr[idx].metaUserName,
          igBusinessAccountId: input.igBusinessAccountId ?? arr[idx].igBusinessAccountId,
        };
        updated++;
      } else {
        arr.push({
          pageId: input.pageId,
          name: input.name,
          token: input.token,
          pictureUrl: input.pictureUrl,
          addedAt: Date.now(),
          metaUserId: input.metaUserId,
          metaUserName: input.metaUserName,
          igBusinessAccountId: input.igBusinessAccountId,
        });
        added++;
      }
    }
    await writeArray(arr);
    return { added, updated };
  });
}

/**
 * Upsert idempotente de UNA página: si ya existe una Page con ese pageId actualiza
 * token+name+picture (preserva addedAt original). Si no existe, la añade con
 * addedAt=Date.now(). Para varias a la vez, usa upsertFbAccounts (una sola escritura).
 */
export async function upsertFbAccount(input: FbAccountInput): Promise<{ added: number; updated: number }> {
  return upsertFbAccounts([input]);
}

/** Busca la Page que tiene este IG Business Account conectado. */
export function getFbAccountByIgId(igBusinessAccountId: string): FbAccount | null {
  return readArray().find((a) => a.igBusinessAccountId === igBusinessAccountId) || null;
}

/** Pages agrupadas por metaUser — para el header "vía Alexander Deroui" en la UI. */
export interface FbMetaUserGroup {
  metaUserId: string;
  metaUserName: string;
  pages: FbAccountPublic[];
}
export function listFbAccountsGrouped(): FbMetaUserGroup[] {
  const groups = new Map<string, FbMetaUserGroup>();
  for (const a of readArray()) {
    const k = a.metaUserId || "_legacy_";
    if (!groups.has(k)) {
      groups.set(k, {
        metaUserId: a.metaUserId || "",
        metaUserName: a.metaUserName || "Cuenta Meta",
        pages: [],
      });
    }
    const { token: _t, ...pub } = a;
    groups.get(k)!.pages.push(pub);
  }
  return [...groups.values()];
}

export async function removeFbAccount(pageId: string): Promise<boolean> {
  // CUENTAS-ATOMICO-1 · dentro del cerrojo, lectura incluida: si esto corría a la vez
  // que un alta, la página recién borrada volvía a aparecer (el alta reescribía una
  // copia leída antes del borrado).
  return withKeyLock(CLAVE_FB, async () => {
    const arr = readArray();
    const next = arr.filter((a) => a.pageId !== pageId);
    if (next.length === arr.length) return false;
    await writeArray(next);
    return true;
  });
}

// ============================================================
// Fase 3 — Métricas Page (Graph API Insights)
// ============================================================
//
// Permisos necesarios: pages_read_engagement (incluido en el scope `fb` de la OAuth).
// NO requiere App Review extra — disponible al instante para todas las Pages que
// administres.
//
// Endpoints usados:
//   /{pageId}?fields=name,picture,fan_count,followers_count                       (snapshot)
//   /{pageId}/insights?metric=...&period=day&since=...&until=...                  (series)
//   /{pageId}/posts?fields=...&limit=10                                           (top posts)

export interface FbDailyPoint { date: string; value: number }
export interface FbTopPost {
  id: string;
  message: string;
  createdAt: string;
  permalink: string;
  thumbnail?: string;
  format: "photo" | "video" | "album" | "link" | "status";
  likes: number;
  comments: number;
  shares: number;
  reactions: number;
  reach?: number;        // post_impressions (vía insights anidados)
  engaged?: number;      // post_engaged_users
  engagementRate?: number; // engagements / reach × 100
}
// PERIODO-FB-1 (MET-FB-04) · reach null = Meta no dio impresiones de ninguna publicación (≠ 0 medido).
// CIFRAS-FB-1 · measured = las publicaciones de este formato CON impresiones medidas, y engagementMeasured = las
// interacciones de ESAS mismas publicaciones: la media de impresiones (reach / measured) y la tasa (engagementMeasured / reach)
// salen de un solo conjunto. count y engagement siguen siendo de todas las publicaciones leídas.
export interface FbFormatBreakdown { format: string; label: string; count: number; reach: number | null; engagement: number; measured: number; engagementMeasured: number }
export interface FbDayOfWeekStats { dow: number; dowLabel: string; posts: number; engagement: number; avgEngagement: number }
export interface FbReactionBreakdown { type: string; label: string; emoji: string; count: number | null } // null = Meta no respondió (≠ 0 real)
export interface FbDemoEntry { label: string; value: number }
export interface FbDemographics {
  countries: FbDemoEntry[];
  cities: FbDemoEntry[];
  age: FbDemoEntry[];
  gender: FbDemoEntry[];
}

export interface FbPageMetrics {
  page: { pageId: string; name: string; pictureUrl?: string; fanCount: number; followersCount: number; link: string; category?: string; websiteUrl?: string };
  // null ≠ 0 en TODOS los campos: null = «no medible» (fuente caída o bloqueada por
  // Meta), 0 = cero REAL medido. La UI pinta '—' u oculta la card ante null; pintar
  // 0 fabricado era el «mar de ceros» que el owner prohibió.
  totals: {
    reach: number | null;              // IMPRESIONES (suma de post_impressions por día) — null si los posts no se pudieron leer
    pageViews: number | null;          // page_views_total sum — null si la métrica falló
    pageReactionsTotal: number | null; // derivado de posts — null sin posts legibles
    consumptions: number | null;       // métrica ELIMINADA por Meta — siempre null (nunca 0 fake)
    postsCount: number | null;
    // CIFRAS-FB-1 · de las postsCount publicaciones leídas, cuántas tienen impresiones medidas (Meta sólo se pregunta por las
    // 20 más recientes y puede no responder por alguna). postReach, avgReachPerPost y engagementRate son de ESAS publicaciones.
    postsMedidas: number | null;
    postReach: number | null;
    postEngagements: number | null;    // reactions + comments + shares (de TODAS las publicaciones leídas)
    postReactions: number | null;
    postComments: number | null;
    postShares: number | null;
    avgReachPerPost: number | null;    // postReach / postsMedidas
    avgEngagementPerPost: number | null;
    engagementRate: number | null;     // interacciones de las publicaciones medidas / postReach
    fanGrowthPct: number | null;       // sin fuente viva en la API (page_fan_adds eliminada) — null
  };
  series: {
    reach: FbDailyPoint[];                // post_impressions agregadas por día (impresiones, no alcance único)
    pageViews: FbDailyPoint[];            // page_views_total
    reactionsTotal: FbDailyPoint[];       // page_actions_post_reactions_total
    consumptions: FbDailyPoint[];         // page_consumptions
  };
  bestPost: FbTopPost | null;
  topPosts: FbTopPost[];
  formatMix: FbFormatBreakdown[];
  dayOfWeekBest: FbDayOfWeekStats[];
  reactionsBreakdown: FbReactionBreakdown[];
  demographics: FbDemographics;
  // Serie PROPIA (snapshots diarios del panel) — independiente de permisos Meta.
  own: { fansSeries: FbDailyPoint[]; followersSeries: FbDailyPoint[] };
  warnings: string[];
  // Hint para el front: si el token no tiene pages_read_engagement, sugerimos reconectar.
  needsReconnect: boolean;
  // Hint distinto: el token tiene el scope, pero la App está en Development tier y
  // el user no es Tester/Dev/Admin de la App. Se arregla añadiendo el user en Meta
  // App → Roles, NO reconectando.
  needsAppRole: boolean;
  // PERIODO-FB-1 (MET-FB-04) · el periodo REAL que se pidió a Meta (YYYY-MM-DD, hora del negocio)
  // y qué fuentes respondieron: la pestaña distingue «0 medido» de «Meta no lo da» sin adivinar.
  periodo: { desde: string; hasta: string };
  medido: { publicaciones: boolean; impresiones: boolean; visitasPagina: boolean };
}

// Códigos ISO de países más frecuentes → nombre legible (subset; el resto cae a code crudo).
const COUNTRY_LABELS: Record<string, string> = {
  ES: "España", MX: "México", AR: "Argentina", CO: "Colombia", CL: "Chile", PE: "Perú",
  VE: "Venezuela", US: "Estados Unidos", BR: "Brasil", FR: "Francia", IT: "Italia",
  DE: "Alemania", GB: "Reino Unido", PT: "Portugal", EC: "Ecuador", UY: "Uruguay",
  DO: "Rep. Dominicana", GT: "Guatemala", CR: "Costa Rica", PA: "Panamá", BO: "Bolivia",
  PY: "Paraguay", CU: "Cuba", HN: "Honduras", SV: "El Salvador", NI: "Nicaragua",
};

// Convierte un objeto map {ES:1200, MX:340,...} a un array ordenado descendente.
function mapToSortedEntries(obj: Record<string, number>, transformer?: (k: string) => string): FbDemoEntry[] {
  return Object.entries(obj || {})
    .map(([k, v]) => ({ label: transformer ? transformer(k) : k, value: Number(v) || 0 }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value);
}

function sum(arr: FbDailyPoint[]): number {
  return arr.reduce((a, b) => a + (Number(b.value) || 0), 0);
}

function toDailyPoints(insightItem: any): FbDailyPoint[] {
  const values: any[] = insightItem?.values || [];
  return values.map((v) => ({
    date: String(v.end_time || "").slice(0, 10),
    value: Number(v.value) || 0,
  }));
}

// Etiquetas legibles + emojis para reacciones por tipo (orden estándar Meta).
const REACTION_TYPES: { type: string; label: string; emoji: string }[] = [
  { type: "LIKE",   label: "Me gusta",   emoji: "👍" },
  { type: "LOVE",   label: "Me encanta", emoji: "❤️" },
  { type: "HAHA",   label: "Me divierte", emoji: "😂" },
  { type: "WOW",    label: "Me asombra",  emoji: "😮" },
  { type: "SORRY",  label: "Me entristece", emoji: "😢" },
  { type: "ANGER",  label: "Me enfada",   emoji: "😡" },
];

// Detecta el formato real del post a partir de attachments (Meta no tiene un único campo).
function detectFormat(att: any): FbTopPost["format"] {
  const a0 = att?.data?.[0] || {};
  const t = String(a0.type || "").toLowerCase();
  const mt = String(a0.media_type || "").toLowerCase();
  if (t.includes("video") || mt.includes("video")) return "video";
  if (t.includes("album")) return "album";
  if (t.includes("photo") || mt.includes("photo") || mt.includes("image")) return "photo";
  if (t.includes("share") || t.includes("link")) return "link";
  return "status";
}

const DOW_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

/**
 * Métricas Page PRO para el rango pedido (default 28d).
 * Tolerante: si una métrica concreta falla, devuelve serie vacía + warning.
 * Usa SOLO métricas válidas en Meta API v22+ (las antiguas page_impressions_unique,
 * page_engaged_users, page_post_engagements, page_fan_adds están deprecadas — calculamos
 * lo equivalente a partir de los posts).
 */
export async function getFbPageMetrics(pageId: string, days = 28, win?: { sinceMs: number; untilMs: number } | null): Promise<FbPageMetrics> {
  const a = getFbAccount(pageId);
  if (!a) throw new Error(`Page ${pageId} no encontrada (¿desconectada?)`);

  // PERIODO-FB-1 (MET-FB-04) · con un rango del calendario se piden ESAS fechas a Meta; antes
  // siempre eran «los últimos N días hasta hoy» y la pestaña tenía que avisar del desfase.
  const until = win && win.sinceMs ? Math.floor((win.untilMs || Date.now()) / 1000) : Math.floor(Date.now() / 1000);
  const since = win && win.sinceMs ? Math.floor(win.sinceMs / 1000) : until - days * 86400;
  const warnings: string[] = [];
  let needsReconnect = false;
  let needsAppRole = false;

  // 1) Snapshot Page — pedimos también category, website, link público.
  let page = {
    pageId,
    name: a.name,
    pictureUrl: a.pictureUrl,
    fanCount: 0,
    followersCount: 0,
    link: `https://www.facebook.com/${pageId}`,
    category: "" as string | undefined,
    websiteUrl: "" as string | undefined,
  };
  try {
    const pr = await fetch(
      `${BASE}/${pageId}?fields=name,picture{url},fan_count,followers_count,link,category,website&access_token=${encodeURIComponent(a.token)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const pj: any = await pr.json();
    if (pj?.error) warnings.push(`Page info: ${pj.error.message}`);
    else {
      page = {
        pageId,
        name: pj.name || a.name,
        pictureUrl: pj.picture?.data?.url || a.pictureUrl,
        fanCount: Number(pj.fan_count) || 0,
        followersCount: Number(pj.followers_count) || 0,
        link: pj.link || `https://www.facebook.com/${pageId}`,
        category: pj.category || undefined,
        websiteUrl: pj.website || undefined,
      };
    }
  } catch (e) {
    warnings.push(`Page info: ${(e as Error).message}`);
  }

  // 1-bis) Serie PROPIA de fans/seguidores («jugar con lo que tenemos», orden del
  // owner): Meta no da histórico sin App Review, así que guardamos un snapshot
  // diario idempotente cada vez que se cargan las métricas y devolvemos la serie
  // acumulada. Crece sola día a día sin pedirle nada más a Meta.
  const tenant = currentWorkspaceId() || "default";
  const own: { fansSeries: FbDailyPoint[]; followersSeries: FbDailyPoint[] } = { fansSeries: [], followersSeries: [] };
  try {
    if (page.fanCount > 0 || page.followersCount > 0) {
      await saveMetricSnapshot(`fb_fans_${pageId}`, page.fanCount, tenant);
      await saveMetricSnapshot(`fb_followers_${pageId}`, page.followersCount, tenant);
    }
    own.fansSeries = await getSnapshotSeries(`fb_fans_${pageId}`, Math.max(days, 90), tenant);
    // COBERTURA-FB-1 (MET-FB-03) · los seguidores van con TODA su historia (un registro al día como mucho):
    // la vista dice «registrados desde [fecha]» y con 90 días esa fecha sería mentira en cuanto hubiera más.
    own.followersSeries = await getSnapshotSeries(`fb_followers_${pageId}`, 3650, tenant);
  } catch { /* serie propia opcional — sin DB cae a memoria */ }

  // 2) Insights series — Meta deprecó TODAS las métricas de alcance/engagement a nivel
  //    Page en v22+ (page_impressions, page_engaged_users, page_post_engagements, etc.).
  //    Pedimos UNA POR UNA con try/catch para que las que sigan vivas (page_views_total,
  //    page_total_actions, page_fans*) no se vean afectadas si otra falla.
  //    El alcance/engagement se calcula desde los posts (sección 3+8).
  const series = {
    reach: [] as FbDailyPoint[],            // se rellenará agregando post_impressions por día
    pageViews: [] as FbDailyPoint[],
    reactionsTotal: [] as FbDailyPoint[],   // se rellenará agregando reacciones de posts por día
    consumptions: [] as FbDailyPoint[],     // deprecated → vacío salvo que Meta lo restaure
  };
  // Métricas Page-level que SIGUEN VIVAS en v22+ — pedimos cada una aislada.
  let pageViewsOk = false; // distingue «0 visitas reales» de «métrica caída» (null ≠ 0)
  const livePageMetrics = ["page_views_total", "page_total_actions"];
  for (const m of livePageMetrics) {
    try {
      const r = await fetch(`${BASE}/${pageId}/insights?metric=${m}&period=day&since=${since}&until=${until}&access_token=${encodeURIComponent(a.token)}`, { signal: AbortSignal.timeout(8000) });
      const j: any = await r.json();
      if (j?.error) {
        if (String(j.error.message).includes("pages_read_engagement")) needsReconnect = true;
        // COUNCIL-FIX: la deprecación ya NO se silencia del todo — sin warning la
        // muerte de una métrica pasa desapercibida durante meses (lección IG/FB).
        warnings.push(`${m}: ${j.error.message}`);
        continue;
      }
      const item = j?.data?.[0];
      if (m === "page_views_total" && item) { series.pageViews = toDailyPoints(item); pageViewsOk = true; }
      // page_total_actions no lo mostramos directamente — reserva para futuras KPIs.
    } catch (e) {
      warnings.push(`${m}: ${(e as Error).message}`);
    }
  }

  // 3a) Posts del rango con FALLBACK a /published_posts y /feed.
  //
  // FIX 2026-06-05: el endpoint /{page-id}/posts en Meta v22+ exige el feature
  // "Page Public Content Access" (App Review) incluso para Admins de la Page en
  // Development tier. /{page-id}/published_posts no lo requiere (solo necesita
  // pages_read_engagement + ser admin), y es lo correcto para lo que queremos
  // mostrar (posts publicados por la Page, no menciones de terceros).
  //
  // Estrategia: probar /published_posts primero (lo que la mayoría de apps
  // deberían usar). Si falla, probar /feed. Si los DOS fallan, recurrir a
  // /posts (modo legacy) y reportar warning de PPCA si Meta lo cita.
  const postsRaw: any[] = [];
  let postsCallOk = false;
  const postFields = [
    "created_time",
    "message",
    "permalink_url",
    "full_picture",
    "attachments{media_type,type,subattachments}",
    "reactions.summary(true)",
    "likes.summary(true)",
    "comments.summary(true)",
    "shares",
  ].join(",");
  const tryPostsEndpoint = async (path: string): Promise<{ ok: boolean; data: any[]; err?: string }> => {
    const url = `${BASE}/${pageId}/${path}?fields=${encodeURIComponent(postFields)}&limit=50&since=${since}&until=${until}&access_token=${encodeURIComponent(a.token)}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const j: any = await r.json();
      if (j?.error) return { ok: false, data: [], err: String(j.error.message || "") };
      return { ok: true, data: j?.data || [] };
    } catch (e) {
      return { ok: false, data: [], err: (e as Error).message };
    }
  };
  for (const endpoint of ["published_posts", "feed", "posts"]) {
    const res = await tryPostsEndpoint(endpoint);
    if (res.ok) {
      postsRaw.push(...res.data);
      postsCallOk = true;
      break;
    }
    // Si fue el ultimo intento, registrar warning y heuristica.
    if (endpoint === "posts" && res.err) {
      warnings.push(`Posts (/${endpoint}): ${res.err}`);
      if (res.err.includes("Page Public Content Access") || res.err.includes("PAGES_ACCESS")) {
        needsAppRole = true;
      } else if (res.err.includes("pages_read_engagement")) {
        needsReconnect = true;
      }
    }
  }
  // SEÑAL CANÓNICA: si los posts se leyeron sin error (por cualquier endpoint),
  // el token está OK aunque alguna métrica Page individual haya disparado el flag.
  if (postsCallOk) { needsReconnect = false; needsAppRole = false; }

  // 3b) Per-post insights — request aislado por post (max 20 para no abusar Meta).
  //     Antes iba anidado en /posts → si Meta deprecaba una métrica post_*, toda la
  //     respuesta de /posts fallaba en cadena y dejaba postsCallOk=false, manteniendo
  //     el banner falso positivo. Ahora va separado.
  const postIdsToEnrich = postsRaw.slice(0, 20).map((p) => String(p.id));
  const postInsightsMap = new Map<string, { reach: number }>();
  // COUNCIL-FIX: post_engaged_users está MUERTA (misma ola que page_engaged_users) y
  // pedirla JUNTO a post_impressions hacía fallar la llamada ENTERA con #100 — se
  // perdía también el reach (clase exacta del incidente clips_replays_count de IG).
  // Ahora: post_impressions SOLA, con fallback a post_media_views (su sustituta) si
  // Meta ya la retiró, y warning deduplicado en vez del return mudo.
  const postInsightsWarned = new Set<string>();
  if (postIdsToEnrich.length > 0) {
    await Promise.all(postIdsToEnrich.map(async (pid) => {
      try {
        for (const metric of ["post_impressions", "post_media_views"]) {
          const r = await fetch(`${BASE}/${pid}/insights?metric=${metric}&access_token=${encodeURIComponent(a.token)}`, { signal: AbortSignal.timeout(6000) });
          const j: any = await r.json();
          if (j?.error || !Array.isArray(j?.data) || !j.data[0]) {
            if (j?.error && !postInsightsWarned.has(metric)) { postInsightsWarned.add(metric); warnings.push(`Post insights (${metric}): ${j.error.message}`); }
            continue; // prueba la siguiente candidata
          }
          postInsightsMap.set(pid, { reach: Number(j.data[0]?.values?.[0]?.value) || 0 });
          return;
        }
      } catch { /* silent per-post skip */ }
    }));
  }
  // Inyectamos el resultado en cada post como insights.data — el enrichment de abajo
  // espera ese shape (era la forma del nested original).
  for (const r of postsRaw) {
    const ins = postInsightsMap.get(String(r.id));
    if (!ins) continue;
    r.insights = {
      data: [
        { name: "post_impressions", values: [{ value: ins.reach }] },
      ],
    };
  }

  // 4) Top posts + agregados desde la lista de posts.
  const enrichedPosts = postsRaw.map((r) => {
    const likes = Number(r?.likes?.summary?.total_count) || 0;
    const comments = Number(r?.comments?.summary?.total_count) || 0;
    const shares = Number(r?.shares?.count) || 0;
    const reactions = Number(r?.reactions?.summary?.total_count) || likes;
    // Insights anidados: extraemos post_impressions, post_engaged_users si están.
    const insArr: any[] = r?.insights?.data || [];
    const reach = Number(insArr.find((x) => x.name === "post_impressions")?.values?.[0]?.value) || 0;
    const engaged = Number(insArr.find((x) => x.name === "post_engaged_users")?.values?.[0]?.value) || 0;
    const format = detectFormat(r?.attachments);
    const engagementsTotal = reactions + comments + shares;
    const engagementRate = reach > 0 ? Math.round((engagementsTotal / reach) * 1000) / 10 : 0;
    return {
      id: String(r.id),
      message: String(r.message || ""),
      createdAt: String(r.created_time || ""),
      permalink: String(r.permalink_url || ""),
      thumbnail: r.full_picture ? String(r.full_picture) : undefined,
      format,
      likes, comments, shares, reactions,
      reach: reach || undefined,
      engaged: engaged || undefined,
      engagementRate: engagementRate || undefined,
      _score: engagementsTotal + (reach ? reach / 100 : 0),
      _engagements: engagementsTotal,
      // CIFRAS-FB-1 · Meta dio una cifra de impresiones para esta publicación (también si fue 0): es lo que la deja entrar
      // en las medias y en la tasa. Sin ella, sus interacciones cuentan en «Interacciones» pero no en lo que se divide por impresiones.
      _medida: postInsightsMap.has(String(r.id)),
    };
  });
  enrichedPosts.sort((x, y) => y._score - x._score);
  const topPosts: FbTopPost[] = enrichedPosts.slice(0, 10).map(({ _score: _a, _engagements: _b, _medida: _c, ...rest }) => rest);
  const bestPost = topPosts[0] || null;

  // PERIODO-FB-1 (MET-FB-04) · ¿Meta dio impresiones de AL MENOS una publicación? Sin ninguna,
  // la serie, el reparto por formato y los totales de alcance eran ceros fabricados (p.reach||0).
  const insOk = postInsightsMap.size > 0;

  // 4-bis) Series diarias agregadas DESDE LOS POSTS (Meta nos quitó page_impressions
  //        en v22+, así que reconstruimos el equivalente sumando post_impressions por día).
  const reachByDay = new Map<string, number>();
  const reactionsByDay = new Map<string, number>();
  for (const p of enrichedPosts) {
    if (!p.createdAt) continue;
    const date = p.createdAt.slice(0, 10);
    reachByDay.set(date, (reachByDay.get(date) || 0) + (p.reach || 0));
    reactionsByDay.set(date, (reactionsByDay.get(date) || 0) + p.reactions);
  }
  series.reach = insOk ? [...reachByDay.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((x, y) => x.date.localeCompare(y.date)) : [];
  series.reactionsTotal = [...reactionsByDay.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((x, y) => x.date.localeCompare(y.date));

  // 5) Format mix (cuántos posts y cuánto reach/engagement por formato).
  const fmtMap = new Map<string, { count: number; reach: number; engagement: number; measured: number; engagementMeasured: number }>();
  for (const p of enrichedPosts) {
    const f = p.format;
    if (!fmtMap.has(f)) fmtMap.set(f, { count: 0, reach: 0, engagement: 0, measured: 0, engagementMeasured: 0 });
    const e = fmtMap.get(f)!;
    e.count += 1;
    e.engagement += p._engagements || 0;
    // CIFRAS-FB-1 · impresiones e interacciones «medidas» salen del MISMO conjunto de publicaciones.
    if (p._medida) {
      e.measured += 1;
      e.reach += p.reach || 0;
      e.engagementMeasured += p._engagements || 0;
    }
  }
  const fmtLabels: Record<string, string> = {
    photo: "Foto",
    video: "Vídeo",
    album: "Álbum",
    link: "Link",
    status: "Texto",
  };
  const formatMix: FbFormatBreakdown[] = [...fmtMap.entries()]
    .map(([f, v]) => ({ format: f, label: fmtLabels[f] || f, count: v.count, reach: insOk ? v.reach : null, engagement: v.engagement, measured: v.measured, engagementMeasured: v.engagementMeasured }))
    .sort((x, y) => y.count - x.count);

  // 6) Day of week — calcula posts y engagement por día de semana (0=Dom).
  const dowMap = new Map<number, { posts: number; engagement: number }>();
  for (const p of enrichedPosts) {
    if (!p.createdAt) continue;
    const dow = new Date(p.createdAt).getDay();
    if (!dowMap.has(dow)) dowMap.set(dow, { posts: 0, engagement: 0 });
    const e = dowMap.get(dow)!;
    e.posts += 1;
    e.engagement += p._engagements || 0;
  }
  const dayOfWeekBest: FbDayOfWeekStats[] = [];
  for (let d = 0; d < 7; d++) {
    const e = dowMap.get(d) || { posts: 0, engagement: 0 };
    dayOfWeekBest.push({
      dow: d,
      dowLabel: DOW_LABELS[d],
      posts: e.posts,
      engagement: e.engagement,
      avgEngagement: e.posts > 0 ? Math.round(e.engagement / e.posts) : 0,
    });
  }

  // 7) Reactions breakdown — pedimos cada tipo aislado (Meta deprecó algunas variantes
  //    sin avisar; si una falla, las demás siguen). Si todas fallan, usamos posts.
  const reactionsBreakdown: FbReactionBreakdown[] = [];
  for (const t of REACTION_TYPES) {
    // COUNCIL-FIX null ≠ 0: si Meta no responde la métrica, el count es null (no
    // medible), NO un 0 fabricado — seis cards de ceros falsos era el síntoma.
    let count: number | null = null;
    try {
      const m = `page_actions_post_reactions_${t.type.toLowerCase()}_total`;
      const r = await fetch(`${BASE}/${pageId}/insights?metric=${m}&period=day&since=${since}&until=${until}&access_token=${encodeURIComponent(a.token)}`, { signal: AbortSignal.timeout(6000) });
      const j: any = await r.json();
      if (!j?.error && j?.data?.[0]) count = sum(toDailyPoints(j.data[0]));
    } catch { /* silently skip per type */ }
    reactionsBreakdown.push({ type: t.type, label: t.label, emoji: t.emoji, count });
  }
  // Fallback SOLO con posts realmente leídos: derivamos likes/otras desde los posts.
  // Sin posts legibles y sin métricas → todo null y la UI oculta la sección.
  if (postsCallOk && reactionsBreakdown.every((r) => !r.count)) {
    const totalLikes = enrichedPosts.reduce((acc, p) => acc + p.likes, 0);
    const totalReactions = enrichedPosts.reduce((acc, p) => acc + p.reactions, 0);
    const others = Math.max(0, totalReactions - totalLikes);
    reactionsBreakdown[0] = { ...REACTION_TYPES[0], count: totalLikes };
    if (others > 0) reactionsBreakdown[1] = { ...REACTION_TYPES[1], count: others };
  }

  // 7-bis) Demographics (lifetime — distribución de fans por país/ciudad/edad/género).
  // Estos metrics son LIFETIME (no aceptan rango), por eso devuelven el último valor.
  const demographics: FbDemographics = { countries: [], cities: [], age: [], gender: [] };
  // COUNCIL-FIX: page_fans_gender_age fue ELIMINADA por Meta (2024) y pedirla en la
  // llamada COMBINADA hacía fallar la petición ENTERA — arrastraba también países y
  // ciudades, que SÍ siguen vivas (prod: demographics 100% vacío con 8.578 fans).
  // Una llamada AISLADA por métrica viva (patrón del fix IG); edad/género quedan
  // vacíos porque Meta ya no los expone — la UI no pinta esas cards.
  for (const dm of ["page_fans_country", "page_fans_city"]) {
    try {
      const dr = await fetch(`${BASE}/${pageId}/insights?metric=${dm}&period=lifetime&access_token=${encodeURIComponent(a.token)}`, { signal: AbortSignal.timeout(10000) });
      const dj: any = await dr.json();
      // Sin warning si falla (Meta a veces oculta demographics para Pages pequeñas).
      const item = (dj?.data || [])[0];
      const vals: any[] = item?.values || [];
      const lastValue: Record<string, number> = vals[vals.length - 1]?.value || {};
      if (dm === "page_fans_country") demographics.countries = mapToSortedEntries(lastValue, (code) => COUNTRY_LABELS[code] || code).slice(0, 10);
      else demographics.cities = mapToSortedEntries(lastValue, (k) => String(k).split(",")[0].trim()).slice(0, 10);
    } catch { /* demographics opcionales */ }
  }

  // 8) Totales calculados desde posts (sustituye las métricas Page deprecadas).
  // COUNCIL-FIX null ≠ 0: si los posts NO se pudieron leer (bloqueo #10 de Meta),
  // los totales derivados de posts son null («no medible»), no 0. La UI decide
  // qué pinta — pintar ceros fabricados era el «mar de ceros» prohibido.
  const postsCount = enrichedPosts.length;
  const totalReach = sum(series.reach);
  const totalPageViews = sum(series.pageViews);
  const totalPageReactions = sum(series.reactionsTotal);
  // CIFRAS-FB-1 · Meta sólo da impresiones de las publicaciones por las que se le pregunta (las 20 más recientes) y puede
  // callar alguna: lo que se divide entre impresiones (impresiones por publicación y tasa de interacción) usa SÓLO las
  // publicaciones medidas, numerador y denominador del mismo conjunto. Antes las interacciones iban de TODAS las leídas
  // (hasta 50) entre las impresiones de unas pocas, y la tasa salía inflada; y la media dividía entre todas, y salía baja.
  const medidas = enrichedPosts.filter((p) => p._medida);
  const postsMedidas = medidas.length;
  const postReach = medidas.reduce((acc, p) => acc + (p.reach || 0), 0);
  const engagementsMedidas = medidas.reduce((acc, p) => acc + (p._engagements || 0), 0);
  const postReactions = enrichedPosts.reduce((acc, p) => acc + p.reactions, 0);
  const postComments = enrichedPosts.reduce((acc, p) => acc + p.comments, 0);
  const postShares = enrichedPosts.reduce((acc, p) => acc + p.shares, 0);
  const postEngagements = postReactions + postComments + postShares;
  const avgReachPerPost = postsMedidas > 0 ? Math.round(postReach / postsMedidas) : 0;
  const avgEngagementPerPost = postsCount > 0 ? Math.round(postEngagements / postsCount) : 0;
  const engagementRate = postReach > 0 ? Math.round((engagementsMedidas / postReach) * 1000) / 10 : 0;
  const pOk = postsCallOk; // posts legibles → sus totales son medibles (0 puede ser real)
  // PERIODO-FB-1 · lo que depende de las impresiones exige además que Meta las haya dado.
  const iOk = pOk && insOk;
  const ymd = (s: number) => new Date(s * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });

  return {
    page,
    totals: {
      reach: iOk ? totalReach : null,
      pageViews: pageViewsOk ? totalPageViews : null,
      pageReactionsTotal: pOk ? totalPageReactions : null,
      consumptions: null, // métrica eliminada por Meta — nunca 0 fake
      postsCount: pOk ? postsCount : null,
      postsMedidas: pOk ? postsMedidas : null,
      postReach: iOk ? postReach : null,
      postEngagements: pOk ? postEngagements : null,
      postReactions: pOk ? postReactions : null,
      postComments: pOk ? postComments : null,
      postShares: pOk ? postShares : null,
      avgReachPerPost: iOk ? avgReachPerPost : null,
      avgEngagementPerPost: pOk ? avgEngagementPerPost : null,
      engagementRate: iOk ? engagementRate : null,
      fanGrowthPct: null, // sin fuente viva (page_fan_adds eliminada) — nunca 0 fake
    },
    series,
    bestPost,
    topPosts,
    formatMix,
    dayOfWeekBest,
    reactionsBreakdown,
    demographics,
    own,
    warnings,
    needsReconnect,
    needsAppRole,
    periodo: { desde: ymd(since), hasta: ymd(until) },
    medido: { publicaciones: pOk, impresiones: iOk, visitasPagina: pageViewsOk },
  };
}

// ============================================================
// Fase 2 — Messenger Inbox (Send API + perfiles + subscripción webhook)
// ============================================================
//
// Permisos necesarios:
//   pages_messaging         — REQUIERE App Review (avanzado, Meta lo evalúa caso a caso)
//   pages_manage_metadata   — ya incluido (lo necesita /subscribed_apps)
//
// Funciona idéntico a la API de Instagram (mismo endpoint /{pageId}/messages,
// mismo formato Graph Messaging). El webhook de Meta es uno solo (/webhook/facebook):
// para cada entry.id (pageId) buscamos el Page token y enviamos la respuesta.

/** Page Send API — texto. Lanza si Meta devuelve != 2xx (caller decide loguear).
 *  Con `humanAgent:true` usa la etiqueta HUMAN_AGENT (un agente humano puede
 *  responder hasta 7 días tras el último mensaje del cliente). Solo para
 *  respuestas de una persona, no del bot. */
export async function sendFbText(psid: string, text: string, pageId: string, opts: { humanAgent?: boolean } = {}): Promise<void> {
  const a = getFbAccount(pageId);
  if (!a) throw new Error(`Page ${pageId} no encontrada (¿desconectada?)`);
  const res = await fetch(`${BASE}/${pageId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: psid },
      message: { text: String(text || "").slice(0, 1990) },
      ...(opts.humanAgent
        ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
        : { messaging_type: "RESPONSE" }),
      access_token: a.token,
    }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as any));
    const msg = `FB send ${res.status}: ${JSON.stringify(d)}`;
    fbLogSendError("sendFbText", pageId, psid, msg);
    throw new Error(msg);
  }
}

/** Respuesta PÚBLICA a un comentario de una publicación de Página. */
export async function fbReplyToComment(commentId: string, message: string, pageId: string): Promise<void> {
  const a = getFbAccount(pageId);
  if (!a) throw new Error(`Page ${pageId} no encontrada (¿desconectada?)`);
  const res = await fetch(`${BASE}/${commentId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: String(message || "").slice(0, 8000), access_token: a.token }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as any));
    const msg = `FB reply ${res.status}: ${JSON.stringify(d)}`;
    fbLogSendError("fbReplyToComment", pageId, commentId, msg);
    throw new Error(msg);
  }
}

/**
 * DM privado a quien comentó (private reply). Solo 1 por comentario y dentro de
 * la ventana de Meta. Con link+botón manda plantilla de botón; si no, texto plano.
 * Usa el Send API con recipient.comment_id (espejo del private reply de Instagram).
 */
export async function fbSendDmFromComment(opts: {
  commentId: string;
  text: string;
  link?: string;
  buttonText?: string;
  pageId: string;
}): Promise<void> {
  const a = getFbAccount(opts.pageId);
  if (!a) throw new Error(`Page ${opts.pageId} no encontrada (¿desconectada?)`);
  // Nunca vacío: Meta rechaza con 400 una plantilla de botón con texto "" y un
  // paso con enlace+botón pero SIN texto es perfectamente creable en el editor.
  // Mismo fallback que sendDmFromComment de Instagram (instagram.ts:218).
  const body = opts.text || "👇";
  const message =
    opts.link && opts.buttonText
      ? {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: body.slice(0, 640),
              buttons: [{ type: "web_url", url: opts.link, title: opts.buttonText.slice(0, 20) }],
            },
          },
        }
      : { text: (opts.link ? `${body}\n\n${opts.link}` : body).slice(0, 1990) };
  const res = await fetch(`${BASE}/${opts.pageId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { comment_id: opts.commentId }, message, access_token: a.token }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as any));
    const msg = `FB private reply ${res.status}: ${JSON.stringify(d)}`;
    fbLogSendError("fbSendDmFromComment", opts.pageId, opts.commentId, msg);
    throw new Error(msg);
  }
}

/** Quick replies nativos de Messenger (tappables), espejo de sendIgQuickReplies
 * de instagram.ts. Con commentId van dentro de la respuesta privada al
 * comentario (la única vía de primer contacto); sin él, mensaje normal al PSID. */
export async function sendFbQuickReplies(opts: {
  psid?: string;
  commentId?: string;
  text: string;
  replies: string[];
  pageId: string;
}): Promise<void> {
  const a = getFbAccount(opts.pageId);
  if (!a) throw new Error(`Page ${opts.pageId} no encontrada (¿desconectada?)`);
  const quick_replies = (opts.replies || [])
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .slice(0, 13)
    .map((t, i) => ({ content_type: "text", title: t.slice(0, 20), payload: "QR_" + i }));
  const message: Record<string, unknown> = { text: opts.text.slice(0, 640) };
  if (quick_replies.length) message.quick_replies = quick_replies;
  const recipient = opts.commentId ? { comment_id: opts.commentId } : { id: opts.psid };
  const res = await fetch(`${BASE}/${opts.pageId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient,
      message,
      ...(opts.commentId ? {} : { messaging_type: "RESPONSE" }),
      access_token: a.token,
    }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(`FB quick replies ${res.status}: ${JSON.stringify(d)}`);
  }
}

/** Publicaciones recientes de una Página (para elegir el post en una automatización). */
export async function listFbPosts(pageId: string, limit = 25): Promise<
  { id: string; caption: string; type: string; thumb: string; permalink: string; timestamp: string }[]
> {
  const a = getFbAccount(pageId);
  if (!a) return [];
  const url = `${BASE}/${pageId}/published_posts?fields=id,message,full_picture,permalink_url,created_time&limit=${limit}&access_token=${encodeURIComponent(a.token)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(d.data)) return [];
    return d.data.map((p: any) => ({
      id: String(p.id || ""),
      caption: (p.message || "").replace(/\s+/g, " ").slice(0, 120),
      type: "POST",
      thumb: p.full_picture || "",
      permalink: p.permalink_url || "",
      timestamp: p.created_time || "",
    }));
  } catch {
    return [];
  }
}

/** MEDIA-SNAP-1 · UNA publicación de Página por su id («pageId_postId»), sin paginar. */
export async function getFbPost(
  pageId: string,
  postId: string,
): Promise<{ id: string; caption: string; type: string; thumb: string; permalink: string; timestamp: string } | null> {
  const a = getFbAccount(pageId);
  if (!a) return null;
  const url = `${BASE}/${encodeURIComponent(postId)}?fields=id,message,full_picture,permalink_url,created_time&access_token=${encodeURIComponent(a.token)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const p: any = await res.json().catch(() => ({}));
    if (!res.ok || !p?.id) return null;
    return {
      id: String(p.id),
      caption: (p.message || "").replace(/\s+/g, " ").slice(0, 120),
      type: "POST",
      thumb: p.full_picture || "",
      permalink: p.permalink_url || "",
      timestamp: p.created_time || "",
    };
  } catch {
    return null;
  }
}

/**
 * Comentarios de UNA publicación de Página. Es el equivalente de listComments()
 * de Instagram, y sin él Facebook no podía tener red de recuperación: su ingesta
 * dependía al 100% del webhook 'feed', así que un reinicio, una entrega fallida de
 * Meta o una firma rechazada durante un despliegue perdían el comentario PARA
 * SIEMPRE y sin rastro (YouTube se autorrepara porque sondea con marca de agua de
 * 48 h, e Instagram tiene backfillIgCommentDrops).
 *
 * `filter=stream` trae también las respuestas anidadas, igual que hace el backfill
 * de Instagram con includeReplies. `sinceMs` recorta por fecha en cliente (el
 * parámetro `since` de la Graph API no es fiable en el edge de comentarios) y
 * corta la paginación en cuanto la página entera es más vieja que el corte.
 *
 * Devuelve [] ante cualquier fallo: es una red de seguridad, nunca puede romper a
 * quien la llama.
 */
export async function listFbComments(
  pageId: string,
  postId: string,
  sinceMs = 0,
  maxPages = 5,
): Promise<{ id: string; text: string; fromId: string; fromName: string; ts: number }[]> {
  const a = getFbAccount(pageId);
  if (!a || !postId) return [];
  const out: { id: string; text: string; fromId: string; fromName: string; ts: number }[] = [];
  let url =
    `${BASE}/${encodeURIComponent(postId)}/comments` +
    `?fields=id,message,from,created_time,parent&filter=stream&limit=100` +
    `&access_token=${encodeURIComponent(a.token)}`;
  for (let page = 0; page < maxPages && url; page++) {
    let d: any;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      d = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(d.data)) return out;
    } catch {
      return out;
    }
    let allOld = d.data.length > 0;
    for (const c of d.data as any[]) {
      const ts = Date.parse(String(c.created_time || "")) || 0;
      if (ts >= sinceMs) allOld = false;
      if (ts < sinceMs) continue;
      const id = String(c.id || "");
      if (!id) continue;
      out.push({
        id,
        text: String(c.message || ""),
        // `from` puede venir vacío: la Page necesita el permiso de lectura de
        // comentarios y, aun con él, Meta lo omite para algunos usuarios.
        fromId: String(c.from?.id || ""),
        fromName: String(c.from?.name || ""),
        ts,
      });
    }
    if (allOld) return out; // la página entera es anterior al corte: no hay más recientes detrás
    url = String(d.paging?.next || "");
  }
  return out;
}

/**
 * Envía un adjunto (image/video/audio/file) por URL pública vía Messenger. La URL
 * debe ser accesible por Meta (el panel la sirve desde una ruta pública efímera).
 */
export async function sendFbMedia(
  psid: string,
  pageId: string,
  type: "image" | "video" | "audio" | "file",
  url: string,
  opts: { humanAgent?: boolean } = {},
): Promise<void> {
  const a = getFbAccount(pageId);
  if (!a) throw new Error(`Page ${pageId} no encontrada (¿desconectada?)`);
  const res = await fetch(`${BASE}/${pageId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: psid },
      message: { attachment: { type, payload: { url, is_reusable: false } } },
      ...(opts.humanAgent
        ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
        : { messaging_type: "RESPONSE" }),
      access_token: a.token,
    }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as any));
    const msg = `FB media ${res.status}: ${JSON.stringify(d)}`;
    fbLogSendError("sendFbMedia", pageId, psid, msg);
    throw new Error(msg);
  }
}

/**
 * Perfil del usuario Messenger (PSID-scoped). Solo es accesible con el page_token
 * de la Page que recibió el mensaje, y solo dentro de la ventana 24h estándar de Meta.
 * Devuelve null silenciosamente si Meta deniega (perfil cerrado).
 */
export async function fetchFbUserProfile(psid: string, pageId: string): Promise<{ name?: string; profilePic?: string } | null> {
  const a = getFbAccount(pageId);
  if (!a) return null;
  try {
    const url = `${BASE}/${psid}?fields=name,first_name,last_name,profile_pic&access_token=${encodeURIComponent(a.token)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    return {
      name: j.name || [j.first_name, j.last_name].filter(Boolean).join(" ") || undefined,
      profilePic: j.profile_pic || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Suscribe la Page a los webhooks de Meta (idempotente). Tras OAuth callback,
 * recorremos las Pages nuevas y las suscribimos a `messages,messaging_postbacks,
 * message_reactions,message_deliveries` para que entren DMs a /webhook/facebook.
 * Si la app no tiene aún `pages_messaging` aprobada, Meta puede devolver 200 OK
 * pero los webhooks llegarán solo de usuarios de prueba — eso es por diseño.
 */
// Set ampliado (TIER 1 + TIER 2) — cubre Inbox bidireccional, attribution y compliance
// sin meter ruido innecesario (calls, games, grupos, commerce vienen aparte si los activas).
const DEFAULT_SUBSCRIBED_FIELDS = [
  // TIER 1 · Inbox y bot funcionando
  "messages",
  "messaging_postbacks",
  "message_reactions",
  "messaging_optins",
  "feed",
  "message_deliveries",
  "message_reads",
  "message_edits",
  // TIER 2 · futuro cercano (echo sync, attribution, compliance)
  "message_echoes",
  "messaging_referrals",
  "messaging_optouts",
  "business_integrity",
  "messaging_integrity",
  "messaging_policy_enforcement",
  "messaging_feedback",
  "inbox_labels",
  "marketing_message_delivery_failed",
].join(",");
export async function subscribePageWebhook(
  pageId: string,
): Promise<{ ok: boolean; error?: string; degraded?: boolean; fields?: string[] }> {
  const a = getFbAccount(pageId);
  if (!a) return { ok: false, error: "Page no encontrada" };
  const post = async (fields: string[]) => {
    const res = await fetch(`${BASE}/${pageId}/subscribed_apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscribed_fields: fields.join(","), access_token: a.token }),
    });
    const j: any = await res.json().catch(() => ({}));
    return { ok: res.ok && !j?.error, error: j?.error?.message || (res.ok ? "" : `HTTP ${res.status}`) };
  };
  const allFields = DEFAULT_SUBSCRIBED_FIELDS.split(",");
  try {
    const full = await post(allFields);
    if (full.ok) return { ok: true, fields: allFields };
    // DIAG-IG-1 · Meta valida la lista EN BLOQUE: si el page token no tiene
    // pages_messaging (token viejo, anterior a la aprobación del App Review), rechaza
    // TODO — incluidos los comentarios, que ese token SÍ puede suscribir. Reintentamos
    // con el subconjunto no-messaging para que al menos los comentarios fluyan, y se
    // devuelve degraded:true para DECIRLE al dueño que reconecte y no fingir un OK.
    if (/pages_messaging/i.test(full.error || "")) {
      const basic = allFields.filter((f) => !/^messag|^message|^inbox_labels$|^marketing_message|^business_integrity$/.test(f));
      // NO PISAR UNA SUSCRIPCIÓN QUE YA RECIBE MENSAJERÍA. POST /subscribed_apps
      // REEMPLAZA la lista entera, no la suma. Si la Página ya estaba suscrita a
      // `messages` (la creó un token anterior, o el propio flujo de conexión de Meta),
      // degradar aquí la dejaría en solo-comentarios y los DMs de esa cuenta dejarían
      // de llegar a partir de ese clic... reportado como éxito. Antes de degradar,
      // miramos qué hay suscrito de verdad y, si hay mensajería, no tocamos nada.
      try {
        const cur = await listPageSubscriptions(pageId);
        const live = (cur.apps || []).flatMap((x) => x.fields || []);
        if (live.some((f) => /^messag|^message/.test(f))) {
          return {
            ok: false,
            error:
              "esta Página YA está recibiendo mensajes y el token guardado no permite renovar esa suscripción (le falta pages_messaging). No se ha tocado nada a propósito: re-suscribir ahora la habría dejado solo con comentarios y habrías dejado de recibir DMs. Reconecta la cuenta de Instagram desde Conexiones para renovar el token y vuelve a pulsar.",
          };
        }
      } catch { /* si no se puede consultar, seguimos con la degradación de siempre */ }
      const partial = await post(basic.length ? basic : ["feed"]);
      if (partial.ok) return { ok: true, degraded: true, fields: basic.length ? basic : ["feed"], error: "el token de la Página no permite los campos de mensajería (pages_messaging): suscritos solo los de comentarios. Reconecta la cuenta para renovar el token y recuperar los DMs." };
      return { ok: false, error: partial.error || full.error };
    }
    return { ok: false, error: full.error };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** DIAG-IG-1 · Lista las apps suscritas a los webhooks de una Página (solo lectura).
 *  Es la comprobación definitiva de "¿me llegan los comentarios/DMs de esta cuenta IG?":
 *  sin la app suscrita a la Página vinculada, Meta no entrega NADA de esa cuenta. */
export async function listPageSubscriptions(
  pageId: string,
): Promise<{ ok: boolean; apps?: Array<{ id: string; name: string; fields: string[] }>; error?: string }> {
  const a = getFbAccount(pageId);
  if (!a) return { ok: false, error: "Page no encontrada" };
  try {
    const res = await fetch(`${BASE}/${pageId}/subscribed_apps?access_token=${encodeURIComponent(a.token)}`);
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || j?.error) return { ok: false, error: j?.error?.message || `HTTP ${res.status}` };
    const apps = (j.data || []).map((x: any) => ({
      id: String(x.id || ""),
      name: String(x.name || x.id || "app"),
      fields: Array.isArray(x.subscribed_fields) ? x.subscribed_fields.map(String) : [],
    }));
    return { ok: true, apps };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function unsubscribePageWebhook(pageId: string): Promise<{ ok: boolean; error?: string }> {
  const a = getFbAccount(pageId);
  if (!a) return { ok: false, error: "Page no encontrada" };
  try {
    const res = await fetch(`${BASE}/${pageId}/subscribed_apps?access_token=${encodeURIComponent(a.token)}`, { method: "DELETE" });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || j?.error) return { ok: false, error: j?.error?.message || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Re-fetch info de la Page directamente a Graph (nombre + foto actualizada).
 * Útil para refrescar el avatar cuando el user cambia la foto en Facebook.
 * Cachea el resultado en disco actualizando la entrada.
 */
export async function refreshFbAccountInfo(pageId: string): Promise<FbAccount | null> {
  const a = getFbAccount(pageId);
  if (!a) return null;
  try {
    const url = `${BASE}/${pageId}?fields=name,picture{url}&access_token=${encodeURIComponent(a.token)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return a;
    const j: any = await r.json();
    const name = j.name || a.name;
    const pictureUrl = j.picture?.data?.url || a.pictureUrl;
    if (name === a.name && pictureUrl === a.pictureUrl) return a;
    await upsertFbAccount({ pageId, name, token: a.token, pictureUrl });
    return getFbAccount(pageId);
  } catch {
    return a;
  }
}
