import { crearCacheSegmentos } from "./cache-segmentos.js";
/**
 * Base de analítica del stack. Reúne, de forma DEFENSIVA (cada fuente puede fallar
 * o no estar configurada sin tumbar el resto), las métricas de todos los canales:
 * Instagram, Web (píxel + enlaces), Leads/CRM, Automatización, Contenido y Ads.
 *
 * Lo consumen: los endpoints por segmento (vista Métricas), el "Razonar resultados"
 * (LLM gratis interpreta el embudo entero) y el export para otro LLM (JSON+Markdown).
 */
import { accountMetrics, topPosts, followerSeries, bestTimes, audienceDemographics, audienceReach } from "./metrics.js";
import { audienciaPorHora, rendimientoPorHora, type DiaAudiencia } from "./cuando-publicar.js";
import { listContacts } from "./contacts.js";
import { listFlows } from "./flows.js";
import {
  dbContactStats,
  dbFlowStatsAllWindow,
  dbFlowsDentroAhora,
  dbFlowRunsDaily,
  dbFlowRunPhonesWindow,
  dbFlowEntradasWindow,
  dbGetContactsByIds,
  dbVentasDeFlujos,
  dbComprasFilasDeContactos,
  dbListAutopostHistory,
  dbCountAutopostHistory,
  dbListAutopostHistoryRange,
  dbCountConversationsInRange,
  dbWaEventsHourly,
  dbWaEventsDaily,
  dbWaEventsByTemplate,
  dbEntregaAlertas,
  dbDifusionesRanking,
  dbWaResponseTimeAvg,
  type Contact,
  waPidList,
  dbConversacionesTurnosLigeros,
  dbFichasEnFlujos,
  dbVentasWebEnlazadas,
  dbLeadAttributionRows,
} from "./db.js";
import { coberturaEntreCanales } from "./identidad.js";
import { medirAutomacionB } from "./auto-medicion-b.js";
import { listWaAutomations, listSequences } from "./waflows.js";
import { listLinks, linkClickStats, purchaseLinks } from "./links.js";
import { resumenDeVentas, gastoDeCompras, gastoPorPersona } from "./sio-ventas.js";
import { tiempoDeCompra, cargarCompradores, miembrosDeCohorte, type TiempoDeCompra, type BaseCompradores } from "./tiempo-compra.js";
import { accionesAntesDeComprar, type AccionesDeCompra } from "./acciones-compra.js"; // ACCIONES-COMPRA-1 (MET-LEADS-03)
import { canalesPorCompra, type CanalesPorCompra } from "./canales-compra.js"; // CANALES-COMPRA-1 (MET-LEADS-04)
import { compararCompradores, type CompararCompra } from "./comparar-compra.js"; // MET-LEADS-06-FIN
import crypto from "node:crypto";
import { pageViewStats, listPixelSites, pixelSiteTenant, type WebFilters } from "./web-analytics.js";
import { platformOf, paidOrganicOf } from "./attribution.js";
import { leerMapa, resolverAmbito, webEnAmbito, normalizarRuta, mapaVacio } from "./web-negocios.js";
import { listAccounts as siWebAccounts } from "./systemeio-accounts.js";
import { listDrafts as listPageDrafts } from "./page-builder.js";
import { adsSummary, daysToPreset } from "./metaAds.js";
import { chat } from "./llm.js";
import { runWithWorkspace, listWorkspacesCached, currentWorkspaceId } from "./workspace.js";
import { watchedWorkspaces, PRESENCE_TTL_MS, WARM_ALWAYS } from "./presence.js";
import { listWaNumbers } from "./whatsapp.js";
import { getFbAccount, getActiveFbAccount, listFbAccounts } from "./facebook.js";
import { activeIgCreds, listIgAccounts, resolveAccount, runWithAccount } from "./instagram.js";
import { youtubeListAccounts, youtubeChannel, youtubeRecentVideos, youtubeAnalyticsBundle, youtubeAnalyticsReport, rangoYoutube } from "./youtube.js";
import { metaAdsAccountsList, runWithAdsAccount, pickPurchaseValue, activeAdsAccountId } from "./metaAds.js";
import { graphGet } from "./metaAdsGraph.js";
import { getSparkline } from "./snapshots.js";
import { logActivity } from "./activity.js";

const DAY = 86400000;
function clampDays(days: number): number {
  return Math.max(1, Math.min(365, Math.floor(days || 30)));
}
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

// ---------- Segmentos ----------
// Cache memoización por (segmento, days) — los segmentos se llaman desde varios sitios
// (gatherAll, endpoint por seg, export markdown, razonar IA). Memoizar a este nivel
// evita re-hacer las Promise.all internas con sub-funciones (que también van memoizadas
// más abajo). TTL 3min combinado con el cliente SWR + el cache HTTP da revisits 0ms.
const cacheSegmentos = crearCacheSegmentos();
const segMemo = cacheSegmentos.leer;

/** Invalida sólo el prefijo solicitado, incluidas las lecturas antiguas en vuelo. */
export function invalidateSegCache(prefix: string): number {
  return cacheSegmentos.invalidar(prefix);
}
// ---------- Pre-warm en background · SOLO con alguien delante ----------
// Llena el cache de los segmentos pesados (segInstagram, segAds y por tanto
// gatherAll) para que, cuando el user abre el Dashboard, los datos ya estén
// listos: cold 5s → 0ms.
//
// PRESENCIA · antes esto corría cada 2 min las 24 h, calentando cachés que
// nadie iba a leer de madrugada y quemando cuota de la Graph API de Meta y
// consultas a Postgres a cambio de nada. Ahora la ronda solo atiende a los
// workspaces con alguien MIRANDO el panel (ver presence.ts), y el warm de un
// workspace lo dispara además su primer latido, así que quien llega tampoco
// paga la cuenta entera. Sin nadie delante, la ronda cuesta una comprobación
// en memoria. Escotilla: WARM_ALWAYS=1 restaura la conducta anterior.

/**
 * Calienta las cachés pesadas de UN workspace.
 *
 * Extraída del tick para poder invocarla también desde el latido de presencia
 * (calentar en cuanto alguien abre el panel, no dos minutos después).
 */
export async function warmAnalyticsWorkspace(wsId: string): Promise<void> {
  await runWithWorkspace(wsId, async () => {
    // INT-1: ademas de IG/Ads, pre-warmeamos segWhatsApp para que la
    // pestaña Metricas → WhatsApp PRO no pague el cold-fetch a Postgres
    // (dbWaEventsHourly + dbWaEventsByTemplate + dbWaResponseTimeAvg
    // ~300-800ms cada uno) en la primera carga tras deploy. Detallado:
    //   - Llamamos segWhatsApp(30, undefined) → agregado del workspace.
    //   - Si hay multi-WABA (varios phoneNumberId), iteramos cada uno
    //     con cap 4 simultaneos para no spamear Postgres en workspaces
    //     con muchos numeros.
    //   - NO añadimos segWhatsApp a gatherAll() — el dashboard usa
    //     gatherAll para el resumen cross-canal, y meter Postgres ahi
    //     suma 300ms al cold dashboard sin necesidad (WhatsApp PRO es
    //     pestaña aparte).
    const waPids = listWaNumbers().map((n) => n.phoneNumberId).filter(Boolean);
    const waWarms: Promise<unknown>[] = [
      segWhatsApp(30, undefined).catch(() => null),
    ];
    // Cap 4 numeros para no spamear (workspaces con >4 WABAs son raros).
    for (const pid of waPids.slice(0, 4)) {
      waWarms.push(segWhatsApp(30, pid).catch(() => null));
    }
    // Promise.all para que ambos segs corran en paralelo;
    // cada uno por dentro ya paraleliza sus sub-fetches.
    await Promise.all([
      segInstagram(30).catch(() => null),
      segAds(30).catch(() => null),
      gatherAll(30).catch(() => null),
      ...waWarms,
    ]);
  });
}

let _warmStarted = false;
export function startAnalyticsWarmer(): void {
  if (_warmStarted) return;
  _warmStarted = true;
  // Multi-tenant W8: como los segmentos dependen de settings PER-WS
  // (meta.adAccountId, meta.igBusinessId, etc.), iteramos workspaces y
  // abrimos scope para cada uno. Sin BD/workspaces → solo 'default' (regresión zero).
  const tick = async () => {
    try {
      let workspaces: { id: string }[] = [{ id: "default" }];
      try {
        const wss = await listWorkspacesCached();
        if (wss.length) workspaces = wss.map((w) => ({ id: w.id }));
      } catch {
        // BD no disponible o tabla aún no creada → solo 'default'.
      }
      // El filtro de presencia. Si no hay nadie mirando, `activos` viene
      // vacío y la ronda entera se salta sin tocar Meta ni Postgres.
      for (const ws of watchedWorkspaces(workspaces)) {
        await warmAnalyticsWorkspace(ws.id);
      }
    } catch { /* nunca tira el worker */ }
    setTimeout(tick, 2 * 60 * 1000); // cada 2min (TTL es 3min, margen de seguridad)
  };
  setTimeout(tick, 5000); // primer intento a los 5s del arranque
  console.log(
    WARM_ALWAYS
      ? "[analytics-warmer] cada 2min SIEMPRE (WARM_ALWAYS=1)"
      : "[analytics-warmer] cada 2min, solo con alguien mirando (presencia " +
          Math.round(PRESENCE_TTL_MS / 1000) + "s)",
  );
}

export async function segInstagram(days: number, igId?: string) {
  const d = clampDays(days);
  // HARD-4: cacheKey incluye wsId — sin esto, el warmer multi-WS (itera todos
  // los workspaces cada 2min) sobrescribe la entrada del anterior y el primer
  // visitante de un ws ve datos del último warmed (cross-tenant leak silencioso).
  // La clave incluye también la cuenta IG efectiva (mismo patrón que segAdsPro
  // con actId): sin ella, al cambiar de cuenta con ?ig_id= el segMemo servía
  // las métricas de la primera cuenta consultada.
  // SEG-IG-CUENTA-1 · gatherAll llama sin igId pero DENTRO de la cuenta de ?ig_id= (ALS): con
  // «main» fijo servía a cualquier cuenta elegida el resumen de la principal durante 3 min.
  // La clave es la cuenta EFECTIVA, como en segInstagramPro.
  const tenant = currentWorkspaceId();
  const cuenta = igId || activeIgCreds().igId || "main";
  return segMemo(`segInstagram:${tenant}:${cuenta}:${d}`, () => _segInstagramRaw(d));
}
async function _segInstagramRaw(d: number) {
  const [account, posts, series, best, demographics, reachBreakdown] = await Promise.all([
    safe(() => accountMetrics(), { configured: false } as any),
    safe(() => topPosts(30, true), [] as any[]),
    safe(() => followerSeries(), [] as { date: string; value: number }[]),
    safe(() => bestTimes(), { byDay: [], byHour: [] } as any),
    safe(() => audienceDemographics(), { countries: [], cities: [], age: [], gender: [] } as any),
    safe(() => audienceReach(), {} as any),
  ]);
  const s = (series || []).slice(-d);
  // La serie es "nuevos seguidores POR DÍA" (insight follower_count). El crecimiento
  // del rango = SUMA de todos los días, no último−primero (eso restaba las altas de
  // un día menos las de otro → daba negativos sin sentido, p.ej. -106).
  const growth = s.length ? s.reduce((acc, x) => acc + (Number(x.value) || 0), 0) : null;
  // Rendimiento por TIPO de contenido (Reels vs Carrusel vs Imagen) — insight clave.
  const typeName = (t: string) => {
    const u = (t || "").toUpperCase();
    if (u.includes("CAROUSEL")) return "Carrusel";
    if (u.includes("REEL") || u.includes("VIDEO")) return "Reel / Vídeo";
    if (u.includes("IMAGE") || u.includes("PHOTO")) return "Imagen";
    return t || "Otro";
  };
  // COUNCIL-FIX: MISMA fórmula de engagement que la tabla de publicaciones
  // (likes+comentarios+guardados+COMPARTIDOS ÷ alcance) — antes esta card omitía los
  // shares y sus % no eran comparables con los de la tabla. Y los posts SIN dato de
  // alcance quedan fuera del ratio (un null inflaba el engagement del formato).
  const tm = new Map<string, { count: number; reach: number; eng: number; engN: number; follows: number; followsN: number }>();
  for (const p of posts || []) {
    const k = typeName(p.type);
    const o = tm.get(k) || { count: 0, reach: 0, eng: 0, engN: 0, follows: 0, followsN: 0 };
    o.count++;
    if (p.reach != null) {
      o.reach += p.reach || 0;
      o.eng += (p.likes || 0) + (p.comments || 0) + (p.saved || 0) + (p.shares || 0);
      o.engN++;
    }
    // PULIDO-IG-1 · de los reels Instagram no da los seguidores ganados: si ninguna publicación del
    // formato trae el dato, la cifra es null («—»), no un 0 que parece medido.
    if (p.follows != null) { o.follows += Number(p.follows) || 0; o.followsN++; }
    tm.set(k, o);
  }
  // PULIDO-IG-1 · `n` = publicaciones del formato CON alcance conocido (la muestra real de las
  // medias). Sin ninguna, las medias son null («—»), no un 0 que parece medido.
  const contentTypes = [...tm.entries()].map(([type, o]) => ({
    type, count: o.count, n: o.engN,
    avgReach: o.engN ? Math.round(o.reach / o.engN) : null,
    avgEng: o.engN ? Math.round(o.eng / o.engN) : null,
    engRate: o.reach ? Math.round((o.eng / o.reach) * 1000) / 10 : null,
    follows: o.followsN ? o.follows : null, // seguidores conseguidos por ese formato (muestra reciente)
  })).sort((a, b) => (b.avgReach ?? -1) - (a.avgReach ?? -1));
  // Etiqueta de tipo legible para la tabla por publicación (evita VIDEO/CAROUSEL_ALBUM en crudo).
  const display = (posts || []).slice(0, 12).map((p: any) => ({ ...p, typeLabel: typeName(p.type) }));
  return { account, posts: display, allPosts: posts, contentTypes, series: s, best, demographics, reachBreakdown, growth, rangeDays: d };
}

export type Win = { sinceMs: number; untilMs: number };
// JERARQUIA-RES-1 (MET-RES-06) · el periodo con el que se hizo un informe: con un rango
// personalizado, «últimos 30 días» era mentira. Fechas en la hora del negocio.
export function etiquetaRango(days: number, win?: Win): string {
  if (!win) return `últimos ${days} días`;
  const f = (ms: number) => new Date(ms).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Madrid" });
  return `del ${f(win.sinceMs)} al ${f(win.untilMs)}`;
}
function windowOf(days: number, win?: Win): Win {
  if (win && win.sinceMs) return { sinceMs: win.sinceMs, untilMs: win.untilMs || Date.now() };
  return { sinceMs: Date.now() - clampDays(days) * DAY, untilMs: Date.now() };
}

// Nombre de píxel de una web de Conexiones, DERIVADO del dominio con la MISMA regla que
// el cliente (admin.ts pxName) y el endpoint pixel-snippet: subdominio propio si hay 3+
// niveles (leadmatch-lab), o el dominio unido con guiones (systeme-io). Así el chip de la
// web de Conexiones y los datos que su píxel ya grabó caen en el MISMO id de sitio.
function pixelSlugOfDomain(panelBaseUrl: string): string {
  // COUNCIL-FIX: sin puerto (example.com:8443 derivaba 'example-com-8443' aquí pero
  // 'example-com' en el cliente y el chip nunca casaba con sus datos).
  const host = String(panelBaseUrl || "").replace(/^https?:\/\//, "").split("/")[0].split(":")[0].replace(/^www\./, "").toLowerCase();
  const parts = host.split(".").filter(Boolean);
  const name = (parts.length >= 3 ? parts[0] : parts.join("-")) || host;
  return name.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sitio";
}
function hostOfUrl(u: string): string {
  const s = String(u || "");
  try { return new URL(s).hostname.replace(/^www\./, ""); } catch { return s.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, ""); }
}

// NEGOCIO-EMBUDO-1 (MET-WEB-01) · ambitoQ: negocio (`biz`; «auto» = el de la web elegida o el
// primero), embudo (`fun`) y «Comparar negocios» (`cmp`) de la pestaña Web. Sin él, todo el
// workspace, como siempre (Resumen, informes de otras pestañas…).
export async function segWeb(days: number, win?: Win, siteId = "", wf?: WebFilters, ambitoQ?: { biz?: string; fun?: string; cmp?: boolean }) {
  const d = clampDays(days);
  const w = windowOf(days, win);
  const since = w.sinceMs;
  // Multi-tenant: pageViewStats con el tenant del workspace activo (antes iba
  // hardcodeado "default" → un workspace no-default veía analítica web ajena).
  const tenant = currentWorkspaceId() || "default";
  const mapa = ambitoQ ? leerMapa() : null;
  const ambito = mapa && ambitoQ ? resolverAmbito(mapa, ambitoQ, siteId) : null;
  // Catálogo de sitios del workspace: las WEBS de Conexiones (cuentas systeme.io),
  // las PÁGINAS publicadas del page-builder y los píxeles ya registrados. La vista Web
  // los muestra todos — también los que aún no tienen visitas — para que las métricas
  // se separen por web y se vea qué web falta por medir.
  const [siAccs, drafts, pixelSlugs] = await Promise.all([
    safe(() => siWebAccounts(), [] as Awaited<ReturnType<typeof siWebAccounts>>),
    safe(() => listPageDrafts(), [] as Awaited<ReturnType<typeof listPageDrafts>>),
    safe(() => listPixelSites(tenant), [] as { slug: string; label: string }[]),
  ]);
  const [web, links, clickRows] = await Promise.all([
    safe(() => pageViewStats(d, tenant, w, siteId, wf, ambito), (() => { const z = { users: 0, sessions: 0, views: 0, avgEngagementMs: 0, avgSessionMs: 0, engagementRate: 0, bounceRate: 0, pagesPerSession: 0, conv: 0 }; return { ...z, newPct: 0, prev: z, channels: [], sources: [], channelStats: [], recentSessions: [], campaigns: [], sourceMedium: [], newVsReturning: { newUsers: 0, returning: 0 }, filterOptions: { channels: [], sources: [], campaigns: [], devices: [], countries: [], paths: [] }, prevSeries: [], heat: [], scrollDist: [], contents: [], scroll: { avg: 0, reach90: 0, sampled: 0 }, speed: { avg: 0, p75: 0, sampled: 0, slow: [] }, paths: [], devices: [], browsers: [], os: [], languages: [], countries: [], conversions: { total: 0, rate: 0, byEvent: [], byPage: [] }, sites: [], pages: [], landing: [], exits: [], siteStats: [], series: [], hourly: [], configured: false }; })() as any),
    safe(() => listLinks(200), [] as any[]),
    safe(() => linkClickStats(w.sinceMs, w.untilMs), [] as Awaited<ReturnType<typeof linkClickStats>>),
  ]);
  const recentLinks = (links || []).filter((l: any) => !l.last_click_at || l.last_click_at >= since);
  // total/byContext/top salen del agregado POR VENTANA (linkClickStats, sin el
  // cap 200 de listLinks): antes sumaban el contador acumulado l.clicks (histórico
  // de vida del enlace) y cambiar el rango no movía estos números mientras
  // Visitas/Visitantes sí. listLinks queda solo para clicks.links (enlaces recientes).
  // (total/byContext/top se calculan tras el catálogo, para poder acotarlos a la web
  //  seleccionada por su dominio — ver justo antes del return.)
  // CATÁLOGO DE WEBS (`pv.webs`, modelo de vista del conmutador): UNA card por cuenta
  // de Conexiones — SIEMPRE, sin dedupe silencioso que se trague webs — más las Páginas
  // publicadas y los píxeles registrados. `sites`/`siteStats` siguen siendo el modelo de
  // DATOS (por page_id) y se completan con ceros para lo que aún no mide.
  let catalogo: { id: string; label: string; kind: string; domain: string }[] = [];
  try {
    // COUNCIL-FIX (slug sufijado): el endpoint pixel-snippet añade `-<hash4(tenant)>` al
    // slug cuando el base ya es de OTRO workspace y el píxel graba con el id sufijado —
    // la card debe apuntar al slug EFECTIVO del tenant o quedaría a cero para siempre.
    const tenantSuffix = crypto.createHash("sha256").update(tenant).digest("hex").slice(0, 4);
    const ownSlugs = new Set((pixelSlugs || []).map((p) => p.slug));
    type CatW = { key: string; id: string; label: string; kind: string; domain: string };
    const webs: CatW[] = [];
    const seenKeys = new Set<string>();
    const coveredSlugs = new Set<string>();
    const pushWeb = (w: CatW) => { if (!w.id || seenKeys.has(w.key) || coveredSlugs.has(w.id)) return; seenKeys.add(w.key); webs.push(w); coveredSlugs.add(w.id); };
    const slugifyName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    // UNA card por WEB de Conexiones. Identidad de la web, en orden de confianza:
    // 1) el dominio del panel si es propio (panel.sudominio.com);
    // 2) si el panel es el genérico systeme.io, el DOMINIO DEL EMAIL de la cuenta
    //    cuando no es un correo de consumo (ana@sudominio.com → la web es
    //    sudominio.com) — es la web real del cliente en el modelo de reventa;
    // 3) último recurso: etiqueta de la cuenta o parte local del email, con slug
    //    estable por cuenta (sio-<id>). El menú es SOLO webs: nada de Páginas.
    const FREEMAIL = /(^|\.)(gmail|googlemail|outlook|hotmail|live|msn|yahoo|icloud|me|proton|protonmail|gmx|aol)\.[a-z.]+$/;
    // PASADA 1 — identidad BASE de cada cuenta. La etiqueta personalizada (Conexiones →
    // Editar) manda; después el dominio del panel si es propio; después el dominio del
    // email (cuentas en el panel genérico); último recurso, slug estable por cuenta.
    const accMeta = (siAccs || []).map((a) => {
      const dom = hostOfUrl(a.panelBaseUrl);
      const generic = !dom || dom === "systeme.io";
      const emailDom = String(a.accountEmail || "").split("@")[1]?.toLowerCase() || "";
      const custom = (a.label && a.label !== a.accountEmail) ? String(a.label).trim() : "";
      const customDom = custom && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(custom) ? custom.toLowerCase().replace(/^www\./, "") : "";
      let label = "", base = "", cardDom = "", adoptable = false;
      if (custom) { label = customDom || custom; base = slugifyName(customDom || custom); cardDom = customDom || (!generic ? dom : (FREEMAIL.test(emailDom) ? "" : emailDom)); }
      else if (!generic) { label = dom; base = pixelSlugOfDomain(a.panelBaseUrl); cardDom = dom; }
      else if (emailDom && !FREEMAIL.test(emailDom)) { label = emailDom; base = slugifyName(emailDom); cardDom = emailDom; adoptable = true; }
      else { label = String(a.accountEmail || "cuenta").split("@")[0]; base = `sio-${a.id}`; cardDom = ""; }
      return { a, emailDom, label, base, cardDom, adoptable };
    });
    // Identidades reclamadas por TODAS las cuentas: un píxel que ES la identidad de otra
    // cuenta jamás cuenta como candidato de adopción de esta.
    const accountBaseSlugs = new Set(accMeta.map((m) => m.base));
    // PASADA 2 — AUTO-ADOPCIÓN: si el workspace registró UN píxel (y solo uno, tras
    // excluir los de otras cuentas) cuyo slug es subdominio del dominio del email de una
    // cuenta genérica (formacion-sudominio-com bajo sudominio-com), esa ES
    // la web de la cuenta: una sola card con el nombre real, recibiendo sus datos.
    for (const m of accMeta) {
      if (m.adoptable) {
        const eSlug = m.base;
        const subs = (pixelSlugs || []).filter((p) => p.slug !== eSlug && !accountBaseSlugs.has(p.slug) && p.slug.length > eSlug.length + 1 && p.slug.endsWith(eSlug) && p.slug[p.slug.length - eSlug.length - 1] === "-");
        if (subs.length === 1) {
          const ps = subs[0];
          m.label = ps.label || (ps.slug.slice(0, ps.slug.length - eSlug.length - 1).replace(/-/g, ".") + "." + m.emailDom);
          m.base = ps.slug;
          m.cardDom = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(m.label) ? m.label.toLowerCase() : m.emailDom;
        }
      }
      const suffixed = `${m.base}-${tenantSuffix}`;
      let eff = m.base;
      if (!ownSlugs.has(m.base)) {
        if (ownSlugs.has(suffixed)) eff = suffixed;
        else {
          const owner = await pixelSiteTenant(m.base).catch(() => null);
          if (owner && owner !== tenant) eff = suffixed;
        }
      }
      pushWeb({ key: `cx:${m.a.id}`, id: eff, label: m.label, kind: "conexion", domain: m.cardDom });
    }
    const draftIds = new Set((drafts || []).map((dr) => dr.id));
    for (const p of pixelSlugs || []) {
      if (coveredSlugs.has(p.slug)) continue;   // ya representado por una web de Conexiones
      if (p.slug === "mi-sitio") continue;       // placeholder del instalador, no es una web
      if (p.slug === "systeme-io") continue;     // píxel compartido LEGACY: fuera del menú (orden del owner)
      if (draftIds.has(p.slug)) continue;        // las Páginas no van en el menú de webs
      const pxLbl = p.label || p.slug;
      pushWeb({ key: `px:${p.slug}`, id: p.slug, label: pxLbl, kind: "pixel", domain: /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(pxLbl) ? pxLbl.toLowerCase() : "" });
    }
    // NEGOCIO-EMBUDO-1 · con un negocio (o un embudo) elegido, el conmutador, la comparativa y
    // los clics sólo enseñan SUS webs. El catálogo COMPLETO viaja aparte (webScope.catalogo):
    // lo usa el editor del mapa para asignar webs, también las que hoy son de otro negocio.
    if (ambito) {
      for (const s of (((web as any).sitesTodos || []) as any[])) {
        if (coveredSlugs.has(s.id) || s.id === "systeme-io" || draftIds.has(s.id) || (s.id === "mi-sitio" && !(s.views > 0))) continue;
        pushWeb({ key: `dt:${s.id}`, id: s.id, label: s.label || s.id, kind: "pixel", domain: "" });
      }
      catalogo = webs.map((x) => ({ id: x.id, label: x.label, kind: x.kind, domain: x.domain }));
      const dentro = webs.filter((x) => webEnAmbito(ambito, x.id));
      webs.length = 0;
      webs.push(...dentro);
    }
    // Datos → sites/siteStats se completan con el catálogo (ceros para webs sin medir).
    const byId = new Map<string, any>((web.sites || []).map((s: any) => [s.id, s]));
    for (const w of webs) {
      const ex = byId.get(w.id);
      if (ex) { if (!ex.kind) ex.kind = w.kind; if (w.domain && !ex.domain) ex.domain = w.domain; if (w.kind === "conexion") ex.label = w.label; }
      else { const ns = { id: w.id, label: w.label, views: 0, kind: w.kind, domain: w.domain }; web.sites.push(ns); byId.set(w.id, ns); }
    }
    // Sitios con datos que no están en el catálogo (píxeles antiguos) también son webs —
    // salvo el placeholder 'mi-sitio' sin visitas y las Páginas (no van en el menú).
    for (const s of web.sites || []) {
      if (coveredSlugs.has(s.id)) continue;
      if (s.id === "mi-sitio" && !(s.views > 0)) continue;
      if (s.id === "systeme-io") continue;   // píxel compartido legacy: sus datos cuentan en «Todas», sin card
      if (draftIds.has(s.id)) continue;
      pushWeb({ key: `dt:${s.id}`, id: s.id, label: s.label || s.id, kind: "pixel", domain: "" });
    }
    const viewsById = new Map<string, number>((web.sites || []).map((s: any) => [s.id, Number(s.views) || 0]));
    (web as any).webs = webs.map((w) => ({ ...w, views: viewsById.get(w.id) || 0 }));
    const stById = new Map<string, any>((web.siteStats || []).map((s: any) => [s.id, s]));
    for (const s of web.sites || []) {
      const st = stById.get(s.id);
      if (!st) web.siteStats.push({ id: s.id, label: s.label, users: 0, sessions: 0, views: 0, bounceRate: 0, avgSessionMs: 0, conv: 0, convSessions: 0 });
      else if (s.label && st.label !== s.label) st.label = s.label;
    }
    web.siteStats.sort((a: any, b: any) => b.views - a.views);
  } catch { /* el catálogo nunca tumba la vista */ }
  // Clics COHERENTES con la web seleccionada: dentro de una web solo tienen sentido los
  // enlaces cuyo DESTINO es esa web (match por dominio, www incluido). Sin filtro de web,
  // el workspace completo, como siempre. scope viaja a la UI para etiquetar la tabla.
  let cRows = clickRows || [];
  let clicksScope = "";
  if (siteId) {
    const selW = ((web as any).webs || []).find((w: any) => w.id === siteId);
    const selDom = String(selW?.domain || "").toLowerCase();
    if (selDom) {
      cRows = cRows.filter((l: any) => {
        try { const h = new URL(String(l.url || "")).hostname.toLowerCase().replace(/^www\./, ""); return h === selDom || h.endsWith("." + selDom); } catch { return false; }
      });
      clicksScope = selDom;
    } else { cRows = []; clicksScope = "-"; }
  }
  // NEGOCIO-EMBUDO-1 · sin web concreta, los clics se acotan a los dominios del negocio; con un
  // embudo, además, a los enlaces que llevan a una de sus páginas EXCLUSIVAS (dominio + ruta):
  // una página compartida no dice de qué embudo viene quien hace clic.
  let clicksScopeFun = "";
  if (ambito && !ambito.comparar) {
    const websCat = (((web as any).webs || []) as any[]);
    if (!siteId) {
      const doms = [...new Set(websCat.map((x) => String(x.domain || "").toLowerCase()).filter(Boolean))];
      if (doms.length) {
        cRows = cRows.filter((l: any) => {
          try { const h = new URL(String(l.url || "")).hostname.toLowerCase().replace(/^www\./, ""); return doms.some((dm) => h === dm || h.endsWith("." + dm)); } catch { return false; }
        });
        clicksScope = doms.join(", ");
      } else { cRows = []; clicksScope = "-"; }
    }
    if (ambito.embudo) {
      const domDe = new Map<string, string>(websCat.map((x) => [String(x.id), String(x.domain || "").toLowerCase()]));
      const destinos = new Set<string>();
      for (const k of ambito.embudo.propias) {
        const i = k.indexOf("|");
        const dom = domDe.get(k.slice(0, i));
        if (dom) destinos.add(dom + k.slice(i + 1));
      }
      cRows = cRows.filter((l: any) => {
        try { const u = new URL(String(l.url || "")); return destinos.has(u.hostname.toLowerCase().replace(/^www\./, "") + normalizarRuta(u.pathname)); } catch { return false; }
      });
      clicksScopeFun = ambito.funNombre;
    }
  }
  const totalClicks = cRows.reduce((a: number, r: any) => a + (r.clicks || 0), 0);
  const byContext: Record<string, number> = {};
  for (const r of cRows) byContext[r.context_kind || "otro"] = (byContext[r.context_kind || "otro"] || 0) + (r.clicks || 0);
  const topLinks = [...cRows].sort((a: any, b: any) => (b.clicks || 0) - (a.clicks || 0)).slice(0, 10)
    .map((l: any) => ({ label: l.label || l.url, clicks: l.clicks || 0, kind: l.context_kind || "" }));
  // NEGOCIO-EMBUDO-1 · lo que la pestaña Web necesita para pintar Negocio → Embudo y el editor
  // del mapa. Sólo cuando la petición lo pide (biz o cmp en la consulta).
  let webScope: any = undefined;
  if (ambitoQ) {
    const cat = ambito ? catalogo : ((((web as any).webs || []) as any[]).map((x) => ({ id: x.id, label: x.label, kind: x.kind, domain: x.domain })));
    const asignadas = new Set((mapa || mapaVacio()).negocios.flatMap((n) => n.webs));
    webScope = {
      mapa: mapa || mapaVacio(),
      biz: ambito ? ambito.biz : "",
      bizNombre: ambito ? ambito.nombre : "",
      fun: ambito ? ambito.fun : "",
      funNombre: ambito ? ambito.funNombre : "",
      objetivo: ambito ? ambito.objetivo : "",
      comparar: !!(ambito && ambito.comparar),
      aviso: ambito ? ambito.aviso : "",
      propias: ambito && ambito.embudo ? ambito.embudo.propias.length : 0,
      compartidas: ambito && ambito.embudo ? ambito.embudo.compartidas.length : 0,
      catalogo: cat,
      sinAsignar: cat.filter((x: any) => !asignadas.has(x.id)).map((x: any) => x.id),
    };
  }
  return {
    pageviews: web,
    clicks: { total: totalClicks, byContext, top: topLinks, links: recentLinks.length, scope: clicksScope, scopeFun: clicksScopeFun },
    rangeDays: d,
    webScope,
  };
}

// LEADS PRO (2026-08-13, orden del owner): además de los agregados históricos,
// desgloses del RANGO (fuente/canal/dueño/tags/score/UTM), comparación con el
// período anterior, accionables (próximas acciones vencidas, leads calientes) y
// la lista de nuevos para la tabla clicable. extras llega del route (admin.ts):
// orden real de etapas del pipeline + etiquetas de dueños y canales.
// BASE-LEADS-1 (MET-LEADS-08) · fuentes por las que una ficha PUEDE llegar con la campaña o
// publicación marcada: enlace del panel, formulario, registro web o boletín. Quien escribe por
// Instagram o WhatsApp no la trae ni podría traerla: sobre él no es un 0 %, es «no aplica».
const FUENTES_MARCABLES = new Set(["web", "form", "formulario", "typeform", "webhook", "systemeio", "newsletter", "landing"]);
export async function segLeads(
  days: number,
  win?: Win,
  extras?: { stages?: string[]; ownerLabels?: Record<string, string>; channelLabels?: Record<string, string>; channelsDown?: string[]; tiempo?: boolean; acciones?: boolean },
) {
  const d = clampDays(days);
  const w = windowOf(days, win);
  const since = w.sinceMs, until = w.untilMs;
  const spanMs = Math.max(1, until - since);
  const prevSince = since - spanMs, prevUntil = since - 1;
  const contacts = await safe(() => listContacts(5000), [] as Contact[]);
  const byStage: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byOwnerAll: Record<string, number> = {};
  let newInRange = 0, prevNew = 0;
  const newPerDay: Record<string, number> = {};
  const srcNew: Record<string, number> = {};
  const srcPrev: Record<string, number> = {};
  const chNew: Record<string, number> = {};
  const chPrev: Record<string, number> = {};
  const ownNew: Record<string, number> = {};
  const tagNew: Record<string, number> = {};
  let utmNew = 0, scoreSumNew = 0, scoreCntNew = 0;
  // BASE-LEADS-1 (MET-LEADS-08) · cuántos nuevos podían traer la marca de campaña (FUENTES_MARCABLES
  // o ya la traen) y cuántos tienen correo: las ventas de la web se cruzan por correo, así que
  // sin correo en la ficha una compra no se puede ver. Los dos números acotan lo que se afirma.
  let marcableNew = 0, conCorreoNew = 0;
  const newLeads: Array<Record<string, unknown>> = [];
  const now = Date.now();
  let overdue = 0, withNext = 0, assigned = 0;
  const hot: Array<Record<string, unknown>> = [];
  // «Cuándo entran»: 168 cubetas UTC (dow*24+hora) — el cliente rota a la zona
  // horaria del que mira, mismo patrón que el heatmap de WhatsApp.
  const hourDow = new Array<number>(168).fill(0);
  let coldNew = 0; // nuevos del rango que NUNCA han escrito (sin inbound)
  const newPhones: string[] = []; // COMPRAS-CONTACTO-1 · todos los nuevos del rango, no solo los 300 de la tabla
  // PORTADA-LEADS-1 (MET-LEADS-01) · el recorrido de cada fuente: cuántas fichas nuevas entraron por
  // ella y cuántas llegaron a escribir; más abajo, con las mismas compras, cuántas compraron.
  const recSrc: Record<string, { n: number; escribieron: number }> = {};
  const srcDePhone = new Map<string, string>();
  for (const c of contacts) {
    const src = c.source || "desconocido";
    byStage[c.stage || "(sin etapa)"] = (byStage[c.stage || "(sin etapa)"] || 0) + 1;
    bySource[src] = (bySource[src] || 0) + 1;
    byOwnerAll[c.owner || ""] = (byOwnerAll[c.owner || ""] || 0) + 1;
    if (c.owner) assigned++;
    if (c.next_action_at) { withNext++; if (c.next_action_at < now) overdue++; }
    if ((c.score || 0) >= 60) hot.push({ phone: c.phone, name: c.name || "", score: c.score || 0, stage: c.stage || "", owner: c.owner || "", lastInbound: c.last_inbound || 0 });
    const t = c.created_at || 0;
    // MET-LEADS-05/06/07 · srcDePhone debe cubrir todos los contactos, no solo del período,
    // para que compradores que llegaron antes del rango tengan su fuente de origen
    if (c.phone) srcDePhone.set(c.phone, src);
    if (t >= prevSince && t <= prevUntil) { prevNew++; srcPrev[src] = (srcPrev[src] || 0) + 1; chPrev[c.channel_account || ""] = (chPrev[c.channel_account || ""] || 0) + 1; }
    if (t >= since && t <= until) {
      newInRange++;
      if (c.phone) newPhones.push(c.phone);
      const dt = new Date(t);
      const day = dt.toISOString().slice(0, 10);
      newPerDay[day] = (newPerDay[day] || 0) + 1;
      hourDow[dt.getUTCDay() * 24 + dt.getUTCHours()]++;
      if (!c.last_inbound) coldNew++;
      srcNew[src] = (srcNew[src] || 0) + 1;
      const rs = recSrc[src] || (recSrc[src] = { n: 0, escribieron: 0 }); // PORTADA-LEADS-1
      rs.n++; if (c.last_inbound) rs.escribieron++;
      chNew[c.channel_account || ""] = (chNew[c.channel_account || ""] || 0) + 1;
      ownNew[c.owner || ""] = (ownNew[c.owner || ""] || 0) + 1;
      for (const tg of (c.tags || [])) tagNew[tg] = (tagNew[tg] || 0) + 1;
      if (c.utm_source) utmNew++;
      if (c.utm_source || FUENTES_MARCABLES.has(src)) marcableNew++; // BASE-LEADS-1
      if (c.email) conCorreoNew++; // BASE-LEADS-1
      if ((c.score || 0) > 0) { scoreSumNew += c.score || 0; scoreCntNew++; }
      if (newLeads.length < 300) newLeads.push({
        phone: c.phone, name: c.name || "", email: c.email || "", source: src,
        stage: c.stage || "", score: c.score || 0, owner: c.owner || "",
        channel: c.channel_account || "", utmSource: c.utm_source || "",
        utmCampaign: c.utm_campaign || "", createdAt: t, lastInbound: c.last_inbound || 0,
      });
    }
  }
  hot.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  // COMPRAS-CONTACTO-1 · de los nuevos del rango, cuántos han comprado ya (en las webs o por un
  // enlace de pago) y cuánto han pagado. El total se agrega sobre las filas y no persona a persona:
  // dos fichas con el mismo email verían la misma venta y la sumarían dos veces.
  const compras = await safe(async () => {
    const filas = await dbComprasFilasDeContactos(newPhones);
    const catalogo = purchaseLinks();
    const porPersona = gastoPorPersona(filas, catalogo);
    const todo = gastoDeCompras(filas, catalogo);
    let compraron = 0;
    const porFuente: Record<string, number> = {}; // PORTADA-LEADS-1 · compradores por fuente de entrada
    for (const [phone, g] of porPersona) {
      if (!(g.compras > 0)) continue;
      compraron++;
      const fu = srcDePhone.get(phone);
      if (fu) porFuente[fu] = (porFuente[fu] || 0) + 1;
    }
    for (const l of newLeads) {
      const g = porPersona.get(String(l.phone || ""));
      if (!g || !g.compras) continue;
      l.buys = g.compras;
      l.spent = g.total[0]?.importe || 0;
      l.spentCur = g.total[0]?.currency || "";
      l.spentEst = g.estimado;
    }
    return { compraron, de: newInRange, total: todo.total, estimado: todo.estimado, sinImporte: todo.sinImporte, conCorreo: conCorreoNew, porFuente };
  }, null as { compraron: number; de: number; total: Array<{ currency: string; importe: number }>; estimado: boolean; sinImporte: number; conCorreo: number; porFuente: Record<string, number> } | null);
  // TIEMPO-COMPRA-1 (MET-LEADS-02) · cuánto tardan en comprar. Solo lo pide la vista Leads (el Resumen
  // no lo paga). null si no se pudo calcular: «no se sabe» no es «nadie».
  // ACCIONES-COMPRA-1 (MET-LEADS-03) · «Qué hacen antes de comprar» comparte la lectura de compradores con
  // «Cuánto tardan» (se carga una vez) y también cae a null si falla: «no se pudo calcular» no es «nadie».
  const baseCompr = (extras?.tiempo || extras?.acciones) ? await safe(() => cargarCompradores({ since, until, nuevos: newPhones }), null as BaseCompradores | null) : null;
  const tiempo = extras?.tiempo ? (baseCompr ? await safe(() => tiempoDeCompra({ since, until, now, nuevos: newPhones }, baseCompr), null as TiempoDeCompra | null) : null) : null;
  const acciones = extras?.acciones ? (baseCompr ? await safe(() => accionesAntesDeComprar({ since, until, now }, baseCompr, srcDePhone), null as AccionesDeCompra | null) : null) : null;
  // CANALES-COMPRA-1 (MET-LEADS-04) · los canales de entrada comparados por volumen, proporción que compra
  // y rapidez. Reutiliza la cohorte de «Fichas nuevas» ya cargada (cero consultas nuevas); la fuente de
  // cada ficha es la misma que cuenta la portada (srcDePhone). null si no se pudo calcular.
  const canales = (extras?.tiempo && baseCompr)
    ? await safe(async () => canalesPorCompra(miembrosDeCohorte(baseCompr.nuevos.map(baseCompr.persona), since, now, baseCompr.cat)
      .map((m) => ({ src: srcDePhone.get(m.phone) || "desconocido", edad: m.edad, dt: m.dt }))), null as CanalesPorCompra | null)
    : null;
  // MET-LEADS-06-FIN · compradores frente a quienes aún no compraron, con la misma ventana de observación.
  // null si no se pudo calcular.
  const comparar = (extras?.acciones && baseCompr) ? await safe(() => compararCompradores({ since, now }, baseCompr), null as CompararCompra | null) : null;
  // Conversaciones DEL RANGO elegido (COUNT en BD, sin cap) + período anterior
  // para el delta. total real del CRM y byStage agregados en SQL sin cap;
  // bySource/series/desgloses del rango salen de la muestra (5000 recientes).
  const convCount = await safe(() => dbCountConversationsInRange(since, until), 0);
  const convPrev = await safe(() => dbCountConversationsInRange(prevSince, prevUntil), 0);
  const cstats = await safe(() => dbContactStats(), null as { total: number; inWindow: number; human: number; byStage: Record<string, number> } | null);
  const stageCounts = cstats && cstats.byStage ? cstats.byStage : byStage;
  const toArr = (m: Record<string, number>): Array<{ label: string; count: number }> =>
    Object.entries(m).map(([k, v]) => ({ label: k, count: v })).sort((a, b) => b.count - a.count);
  return {
    total: cstats ? cstats.total : contacts.length,
    newInRange,
    // LECTURA-JUSTIFICADA-1 (MET-RES-04) · la muestra son los 5000 contactos con
    // mensaje más reciente: si el CRM es mayor, los altas del periodo anterior que
    // no han vuelto a escribir se quedan fuera y la comparación inventaría un
    // crecimiento. Sin muestra completa no hay periodo anterior.
    prevNew: (!cstats || cstats.total <= contacts.length) ? prevNew : null,
    conversations: convCount,
    conversationsPrev: convPrev,
    inWindow24h: cstats ? cstats.inWindow : null,
    humanCount: cstats ? cstats.human : null,
    byStage: toArr(stageCounts),
    stageOrder: extras?.stages ?? [],
    bySource: toArr(bySource),
    bySourceNew: toArr(srcNew),
    bySourcePrev: toArr(srcPrev),
    byChannelNew: toArr(chNew),
    byChannelPrev: toArr(chPrev),
    byOwnerNew: toArr(ownNew),
    byOwnerAll: toArr(byOwnerAll),
    ownerLabels: extras?.ownerLabels ?? {},
    channelLabels: extras?.channelLabels ?? {},
    tagsTopNew: toArr(tagNew).slice(0, 12),
    utmCoverageNew: { withUtm: utmNew, of: newInRange, ofMarcable: marcableNew }, // BASE-LEADS-1
    channelsDown: extras?.channelsDown ?? [], // BASE-LEADS-1 · cuentas desconectadas ahora: sus leads son datos históricos
    scoreNew: { avg: scoreCntNew ? Math.round(scoreSumNew / scoreCntNew) : null, scored: scoreCntNew },
    actionable: { overdue, withNext, assigned, sampleSize: contacts.length, coldNew },
    hourDowUtc: hourDow,
    hotLeads: hot.slice(0, 10),
    newLeads,
    compras,
    tiempo, // TIEMPO-COMPRA-1
    acciones, // ACCIONES-COMPRA-1 (MET-LEADS-03)
    comparar, // MET-LEADS-06-FIN · null si no se pudo calcular; sin la clave = respuesta antigua en caché
    canales, // CANALES-COMPRA-1 (MET-LEADS-04) · null si no se pudo calcular; sin la clave = respuesta antigua en caché
    sampled: contacts.length >= 5000,
    series: Object.entries(newPerDay).map(([date, count]) => ({ date, value: count })).sort((a, b) => a.date.localeCompare(b.date)),
    win: { since, until }, // PORTADA-LEADS-1 (MET-LEADS-01) · el periodo exacto, para abrir el mismo grupo en Contactos
    // PORTADA-LEADS-1 · por dónde entró cada ficha nueva, cuántas escribieron y cuántas compraron
    // (null si las compras no se pudieron consultar: «no se sabe» no es «ninguna»).
    recorridos: Object.entries(recSrc)
      .map(([src, r]) => ({ src, n: r.n, escribieron: r.escribieron, compraron: compras ? (compras.porFuente[src] || 0) : null }))
      .sort((a, b) => b.n - a.n),
    rangeDays: d,
  };
}

// AUTOMATIZACION-CANAL-1 · para no mezclar métricas de distintos orígenes: el
// disparador de cada flujo dice su canal (trigger.type) y, si el flujo está
// limitado a una cuenta concreta (appliesTo/emAccountId), esa es su cuenta.
// Vacío = se aplica a TODAS las cuentas de ese canal (misma convención que
// fbScopeChip en el cliente). "booking"/"recordatorio" no tienen canal
// externo: se cuentan siempre en la vista sin filtrar, y se excluyen en
// cuanto se filtra por un canal concreto (no pertenecen a ninguno).
export type AutomationChannel = "wa" | "ig" | "fb" | "yt" | "li" | "email";
export interface AutomationScope { channel: AutomationChannel; account?: string }
function flowChannel(f: { trigger?: { type?: string } }): AutomationChannel | null {
  const t = f.trigger?.type;
  if (t === "wa_keyword" || t === "wa_any") return "wa";
  if (t === "ig_comment" || t === "ig_story" || t === "ig_dm") return "ig";
  if (t === "fb_comment") return "fb";
  if (t === "yt_comment") return "yt";
  if (t === "li_comment") return "li";
  if (t === "email") return "email";
  return null;
}
function flowAccount(f: { trigger?: { type?: string; emAccountId?: string }; appliesTo?: string }): string {
  return f.trigger?.type === "email" ? f.trigger.emAccountId || "" : f.appliesTo || "";
}
function matchesScope(f: { trigger?: { type?: string; emAccountId?: string }; appliesTo?: string }, scope?: AutomationScope): boolean {
  if (!scope) return true;
  if (flowChannel(f) !== scope.channel) return false;
  if (!scope.account) return true;
  const acc = flowAccount(f);
  return !acc || acc === scope.account; // sin cuenta propia = aplica a todas
}

// CLASIFICA-FLUJOS-1 (MET-AUTO-02) · cada flujo se clasifica por cómo ARRANCA (tipo de inicio),
// por lo que HACE (función) y por su canal, para que la pestaña compare flujos que persiguen
// lo mismo y no mezcle una respuesta a un comentario con una confirmación de cita. Las tres
// dimensiones salen de la configuración del flujo: no hay que etiquetar nada a mano.
//   inicio   · comentario (Instagram, Facebook o YouTube → mensaje privado) · peticion (la persona
//              escribe: palabra clave, cualquier mensaje, mensaje directo, respuesta a historia) ·
//              correo (seguimiento de un correo) · cita (confirmación y recordatorio) ·
//              formulario (formulario propio o Typeform).
//   funcion  · vender · agendar · captar (pide datos o sincroniza la ficha) · cualificar (deriva,
//              avisa, cambia etapa o puntuación) · entregar (manda un enlace o un archivo) ·
//              conversar (todo lo demás). Gana la primera que aparece en este orden.
// «Difusión» y «Secuencia de correo» no son flujos: viven en «Piezas», así que no son tipos aquí.
export type FlowInicio = "comentario" | "peticion" | "correo" | "cita" | "formulario";
export type FlowFuncion = "vender" | "agendar" | "captar" | "cualificar" | "entregar" | "conversar";
export type FuenteCaptacion = "organica" | "pago" | "identificar";
export const FLOW_INICIOS: FlowInicio[] = ["comentario", "peticion", "correo", "cita", "formulario"];
export const FLOW_FUNCIONES: FlowFuncion[] = ["vender", "agendar", "captar", "cualificar", "entregar", "conversar"];
export const FUENTES_CAPTACION: FuenteCaptacion[] = ["organica", "pago", "identificar"];
export interface AutomationFiltros { inicio?: FlowInicio; funcion?: FlowFuncion; fuente?: FuenteCaptacion }
export function flowInicio(f: { trigger?: { type?: string } }): FlowInicio | null {
  const t = f.trigger?.type;
  if (t === "ig_comment" || t === "fb_comment" || t === "yt_comment" || t === "li_comment") return "comentario";
  if (t === "wa_keyword" || t === "wa_any" || t === "ig_dm" || t === "ig_story") return "peticion";
  if (t === "email") return "correo";
  if (t === "booking" || t === "recordatorio") return "cita";
  if (t === "typeform" || t === "formulario") return "formulario";
  return null;
}
function urlClave(u: string): string {
  return String(u || "").trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").split(/[?#]/)[0].replace(/\/+$/, "");
}
export function flowFuncion(f: { nodes?: Record<string, any> | any[] }, urlsCompra: Set<string>): FlowFuncion {
  const raw = f.nodes || {};
  const nodes: any[] = Array.isArray(raw) ? raw : Object.values(raw);
  const alguno = (p: (n: any) => boolean) => nodes.some((n) => n && typeof n === "object" && p(n));
  if (alguno((n) => (n.type === "condition" && n.source === "purchased") || (n.type === "message" && n.link && urlsCompra.has(urlClave(n.link))))) return "vender";
  if (alguno((n) => n.type === "action" && (n.kind === "book" || n.bookingUrl))) return "agendar";
  if (alguno((n) => n.type === "ask" || (n.type === "action" && n.kind === "sync"))) return "captar";
  if (alguno((n) => n.type === "action" && (["escalate", "notify", "stage", "score", "tobot"].includes(String(n.kind || "")) || n.escalate || n.notify || n.setStage || n.setPipeline || n.setScore != null))) return "cualificar";
  if (alguno((n) => n.type === "message" && (n.link || (n.media && n.media.id)))) return "entregar";
  return "conversar";
}
// MET-AUTO-12-FIN · ¿escribe la IA en algún paso? Un mensaje con IA activada o un paso que pasa la
// conversación al bot. El resto es automatización guiada (mensajes fijos).
export function flowUsaIa(f: { nodes?: Record<string, any> | any[] }): boolean {
  const raw = f.nodes || {};
  const nodes: any[] = Array.isArray(raw) ? raw : Object.values(raw);
  return nodes.some((n) => n && typeof n === "object" && (n.ai === true || (n.type === "action" && n.kind === "tobot")));
}
export function urlsDeCompra(): Set<string> {
  const out = new Set<string>();
  for (const l of purchaseLinks()) if (l && l.url) out.add(urlClave(l.url));
  return out;
}
// CLASIFICA-FLUJOS-1 · fuente de captación de UNA persona: orgánica, de pago o por identificar.
// Es la ÚNICA función que la decide: cuando llegue la regla común de atribución (MET-ORIGEN-07)
// se sustituye aquí y toda la pestaña la hereda. Mira de dónde vino la persona (su ficha:
// anuncio de WhatsApp/Instagram, utm), NUNCA qué mensajes recibió: una plantilla facturable no
// hace «de pago» a nadie. Sin ficha o sin señal → por identificar, no «orgánica».
export function fuenteCaptacion(c?: { utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_content?: string; fields?: Record<string, string> } | null): FuenteCaptacion {
  if (!c) return "identificar";
  const medium = String(c.utm_medium || "").toLowerCase();
  if (medium === "paid-ctwa" || medium === "paid-social" || (c.fields && c.fields.ctwa_clid)) return "pago";
  const po = paidOrganicOf({ utm_source: c.utm_source, utm_medium: c.utm_medium, utm_campaign: c.utm_campaign, utm_content: c.utm_content });
  return po === "pago" ? "pago" : po === "organico" ? "organica" : "identificar";
}

export async function segAutomation(days: number, win?: Win, scope?: AutomationScope, filtros?: AutomationFiltros) {
  const d = clampDays(days);
  // FIX id76: (1) las stats ahora se acotan a la ventana del date-picker
  // (updated_at de los runs / created_at de los clics) en UNA query agregada —
  // antes dbFlowStats sumaba histórico de toda la vida bajo «Últimos N días»;
  // (2) desaparece el slice(0,30) PREVIO al orden: stats de TODOS los flujos,
  // totales sobre todos, y solo la TABLA se recorta a 30 tras ordenar.
  const w = windowOf(days, win);
  // AUTOMATIZACIÓN PRO: también el PERÍODO ANTERIOR (deltas por flujo y
  // globales) y la serie diaria de entradas a flujos.
  const spanMs = Math.max(1, w.untilMs - w.sinceMs);
  const [flowsAll, waAutsAll, seqsAll] = await Promise.all([
    safe(() => listFlows(), [] as any[]),
    safe(() => listWaAutomations(), [] as any[]),
    safe(() => listSequences(), [] as any[]),
  ]);
  const flowsScope = scope ? (flowsAll || []).filter((f: any) => matchesScope(f, scope)) : (flowsAll || []);
  const flowIdsScope = scope ? flowsScope.map((f: any) => f.id) : undefined;
  // CLASIFICA-FLUJOS-1 (MET-AUTO-02) · fuente de captación de quien pasó por los flujos (del canal
  // filtrado) en la ventana: se clasifica a la PERSONA por su ficha y, si se filtra por fuente,
  // todo lo de abajo (runs, serie, dentro ahora, recaudado) se acota a ese subconjunto.
  const personas = await safe(() => dbFlowRunPhonesWindow(w.sinceMs, w.untilMs, flowIdsScope), { phones: [] as string[], parcial: false });
  const fichas = personas.phones.length ? await safe(() => dbGetContactsByIds(personas.phones), new Map<string, Contact>()) : new Map<string, Contact>();
  const fuente = { organica: 0, pago: 0, identificar: 0, personas: personas.phones.length, parcial: personas.parcial };
  const porFuente: Record<FuenteCaptacion, string[]> = { organica: [], pago: [], identificar: [] };
  for (const ph of personas.phones) {
    const k = fuenteCaptacion(fichas.get(ph));
    fuente[k]++;
    porFuente[k].push(ph);
  }
  const phonesF = filtros?.fuente ? porFuente[filtros.fuente] : undefined;
  const [statsMap, statsPrevMap, dentroMap, entradasMap] = await Promise.all([
    safe(() => dbFlowStatsAllWindow(w.sinceMs, w.untilMs, phonesF), new Map() as Awaited<ReturnType<typeof dbFlowStatsAllWindow>>),
    // Con el filtro de fuente no hay periodo anterior: las personas se clasificaron con los runs
    // de ESTA ventana y aplicarles la ventana previa compararía gente distinta con la misma etiqueta.
    phonesF ? Promise.resolve(new Map() as Awaited<ReturnType<typeof dbFlowStatsAllWindow>>) : safe(() => dbFlowStatsAllWindow(w.sinceMs - spanMs, w.sinceMs - 1), new Map() as Awaited<ReturnType<typeof dbFlowStatsAllWindow>>),
    safe(() => dbFlowsDentroAhora(phonesF), new Map<string, number>()),
    safe(() => dbFlowEntradasWindow(w.sinceMs, w.untilMs, phonesF), new Map() as Awaited<ReturnType<typeof dbFlowEntradasWindow>>),
  ]);
  const urlsCompra = urlsDeCompra();
  const clasificacion = { inicio: {} as Record<string, number>, funcion: {} as Record<string, number> };
  for (const k of FLOW_INICIOS) clasificacion.inicio[k] = 0;
  for (const k of FLOW_FUNCIONES) clasificacion.funcion[k] = 0;
  const clasePorFlujo = new Map<string, { inicio: FlowInicio | null; funcion: FlowFuncion }>();
  for (const f of flowsScope as any[]) {
    const c = { inicio: flowInicio(f), funcion: flowFuncion(f, urlsCompra) };
    clasePorFlujo.set(f.id, c);
    if (c.inicio) clasificacion.inicio[c.inicio]++;
    clasificacion.funcion[c.funcion]++;
  }
  const flows = (flowsScope as any[]).filter((f: any) => {
    const c = clasePorFlujo.get(f.id);
    if (filtros?.inicio && (!c || c.inicio !== filtros.inicio)) return false;
    if (filtros?.funcion && (!c || c.funcion !== filtros.funcion)) return false;
    return true;
  });
  const flowIdsFiltered = scope || filtros?.inicio || filtros?.funcion ? flows.map((f: any) => f.id) : undefined;
  const runsDaily = await safe(() => dbFlowRunsDaily(w.sinceMs, w.untilMs, flowIdsFiltered, phonesF), [] as Array<{ date: string; value: number }>);
  // Los disparadores WA y las secuencias sólo existen en el canal "whatsapp"
  // (waflows.ts es exclusivamente WA pese a su nombre genérico); las
  // secuencias no llevan número propio, así que ante un filtro de cuenta
  // concreta se cuentan igual que un flujo "aplica a todas" (no hay forma de
  // saber a qué número pertenecen).
  const waAuts = !scope ? waAutsAll : scope.channel !== "wa" ? [] : !scope.account ? waAutsAll : (waAutsAll || []).filter((a: any) => !a.phoneNumberId || a.phoneNumberId === scope.account);
  const seqs = !scope ? seqsAll : scope.channel === "wa" ? seqsAll : [];
  const flowStats = (flows || []).map((f: any) => {
    const st = statsMap.get(f.id) || { flow_id: f.id, contacts: 0, active: 0, waiting: 0, done: 0, cancelled: 0, clicks: 0, clickers: 0, sinEntregar: 0 };
    const stPrev = statsPrevMap.get(f.id);
    const completion = st.contacts ? Math.round((st.done / st.contacts) * 100) : 0;
    return {
      id: f.id, name: f.name || f.id, enabled: f.enabled !== false,
      contacts: st.contacts, done: st.done, active: st.active, waiting: st.waiting, cancelled: st.cancelled,
      // Los de dentro AHORA no salen del rango: ver dbFlowsDentroAhora.
      dentro: dentroMap.get(f.id) || 0,
      clicks: st.clicks, completion,
      prevContacts: stPrev ? stPrev.contacts : null,
      // METRICAS-1 · personas que pulsaron entre personas que entraron (no pulsaciones): no pasa de 100.
      clickRate: st.contacts ? Math.min(100, Math.round(((st.clickers ?? st.clicks) / st.contacts) * 1000) / 10) : null,
      sinEntregar: st.sinEntregar || 0, // MEJORA-1
      // CLASIFICA-FLUJOS-1 · cómo arranca, qué hace, por qué canal y por dónde entró la gente.
      inicio: clasePorFlujo.get(f.id)?.inicio || null,
      funcion: clasePorFlujo.get(f.id)?.funcion || "conversar",
      canal: flowChannel(f),
      ia: flowUsaIa(f),
      entradas: entradasMap.get(f.id) || [],
    };
  });
  // VENTAS-SIO-1 · lo recaudado en el rango por la gente de los flujos (webs de systeme.io y, desde
  // COMPRAS-CONTACTO-1, enlaces de pago del panel; cada venta al último flujo en el que entró antes de pagar).
  const ventasTodas = await safe(() => dbVentasDeFlujos({ sinceMs: w.sinceMs, untilMs: w.untilMs, flowIds: flowIdsFiltered }), []);
  const phonesFSet = phonesF ? new Set(phonesF) : null;
  const ventas = resumenDeVentas(phonesFSet ? ventasTodas.filter((v) => phonesFSet.has(String(v.phone || ""))) : ventasTodas, purchaseLinks());
  // IDENTIDAD-COMUN-1 (MET-AUTO-09) · a cuántas de las personas que entraron en los flujos podríamos
  // seguir si cambian de canal (regla común de src/identidad.ts) y cuántas ventas de la web enlazan
  // con una ficha por su correo. null si la base no responde: la tarjeta no se pinta.
  // CLASIFICA-FLUJOS-1 (MET-AUTO-02) · con el filtro «por dónde entraron», la cobertura se mide solo
  // sobre esa gente (mismas personas que las cifras de arriba).
  const cobertura = await safe(async () => {
    const [fichasTodas, ventasWeb] = await Promise.all([
      dbFichasEnFlujos({ sinceMs: w.sinceMs, untilMs: w.untilMs, flowIds: flowIdsFiltered }),
      dbVentasWebEnlazadas({ sinceMs: w.sinceMs, untilMs: w.untilMs }),
    ]);
    const fichas = phonesFSet ? fichasTodas.filter((x) => phonesFSet.has(String(x.phone || ""))) : fichasTodas;
    return { ...coberturaEntreCanales(fichas), ventasWeb };
  }, null);
  // DIVISA-1 · `recaudado` sigue siendo el neto en la moneda principal; `recaudadoMonedas` lleva
  // todas ([{moneda, importe}]) para que el panel las sume al cambio del día.
  for (const f of flowStats as Array<Record<string, unknown>>) { f.recaudado = ventas.porFlujo.get(String(f.id)) || 0; f.recaudadoMonedas = ventas.porFlujoMonedas.get(String(f.id)) || []; }
  flowStats.sort((a, b) => b.contacts - a.contacts);
  const totals = flowStats.reduce(
    (acc, f) => ({ contacts: acc.contacts + f.contacts, done: acc.done + f.done, clicks: acc.clicks + f.clicks, active: acc.active + (f.active || 0), waiting: acc.waiting + (f.waiting || 0), cancelled: acc.cancelled + (f.cancelled || 0), dentro: acc.dentro + (f.dentro || 0) }),
    { contacts: 0, done: 0, clicks: 0, active: 0, waiting: 0, cancelled: 0, dentro: 0 },
  );
  let prevContacts = 0, prevDone = 0, prevClicks = 0, prevCancelled = 0;
  const idSetFiltered = flowIdsFiltered ? new Set(flowIdsFiltered) : null;
  for (const [flowId, st] of statsPrevMap.entries()) {
    if (idSetFiltered && !idSetFiltered.has(flowId)) continue;
    prevContacts += st.contacts; prevDone += st.done; prevClicks += st.clicks; prevCancelled += st.cancelled || 0;
  }
  return {
    flows: flowStats.slice(0, 60),
    totals,
    totalsPrev: { contacts: prevContacts, done: prevDone, clicks: prevClicks, cancelled: prevCancelled },
    series: runsDaily,
    triggers: (waAuts || []).length,
    triggersActive: (waAuts || []).filter((a: any) => a.enabled).length,
    triggersList: (waAuts || []).slice(0, 40).map((a: any) => ({ name: a.name || a.keyword || a.id, keyword: a.keyword || "", enabled: !!a.enabled, sequence: !!a.startSequence, phone: a.phoneNumberId || "" })),
    sequences: (seqs || []).length,
    sequencesList: (seqs || []).slice(0, 40).map((s: any) => ({ name: s.name || s.id, enabled: s.enabled !== false, steps: (s.steps || []).length })),
    cobertura,
    // AUTO-MEDICION-B-1 (MET-AUTO-05/06/07/08/10/11) · objetivo, pasos, seguimiento y difusiones; null sin base persistente.
    medicion: await safe(() => medirAutomacionB(w, flows as any[], flowIdsFiltered, !scope || scope.channel === "wa"), null),
    recaudado: { total: ventas.total, compradores: ventas.compradores.length, estimado: ventas.estimado, sinImporte: ventas.sinImporte },
    // CLASIFICA-FLUJOS-1 · cuántos flujos hay de cada tipo (al alcance del canal filtrado), cuánta
    // gente de cada fuente pasó por ellos en la ventana, y qué filtros se aplicaron.
    clasificacion,
    fuente,
    filtros: { inicio: filtros?.inicio || "", funcion: filtros?.funcion || "", fuente: filtros?.fuente || "" },
    rangeDays: d,
  };
}

export async function segContent(days: number, win?: Win) {
  const d = clampDays(days);
  const w = windowOf(days, win);
  // FIX id77: (a) filas del rango SIN el cap 100 de dbListAutopostHistory(100);
  // (b) total histórico con COUNT real en BD (el tile nunca podía superar 100);
  // (c) el historial guarda INTENTOS (autopost inserta aunque fallen todas las
  // plataformas) — «publicados» = intentos con ALGUNA plataforma ok.
  const [inRange, histCount, hist] = await Promise.all([
    safe(() => dbListAutopostHistoryRange(w.sinceMs, w.untilMs), [] as any[]),
    safe(() => dbCountAutopostHistory(), 0),
    safe(() => dbListAutopostHistory(8), [] as any[]),
  ]);
  const platformOk: Record<string, { ok: number; fail: number }> = {};
  for (const h of inRange || []) {
    for (const s of h.status || []) {
      const p = platformOk[s.platform] || { ok: 0, fail: 0 };
      if (s.ok) p.ok++; else p.fail++;
      platformOk[s.platform] = p;
    }
  }
  const okOf = (h: any) => (h.status || []).some((s: any) => s.ok);
  const attempted = (inRange || []).length;
  const published = (inRange || []).filter(okOf).length;
  return {
    published,
    attempted,
    failedAttempts: attempted - published,
    publishedTotal: histCount,
    byPlatform: Object.entries(platformOk).map(([k, v]) => ({ platform: k, ok: v.ok, fail: v.fail })).sort((a, b) => (b.ok + b.fail) - (a.ok + a.fail)),
    recent: (hist || []).slice(0, 8).map((h: any) => ({ ts: h.ts, idea: h.idea, platforms: h.platforms || [], ok: (h.status || []).filter((s: any) => s.ok).length, total: (h.status || []).length })),
    rangeDays: d,
  };
}

// metricas-pro M3 — segmento WhatsApp PRO.
//
// Lee app_wa_events (envíos + recibidos) y devuelve los KPIs y agregados que
// pinta la pestaña Métricas → WhatsApp PRO: totales sent/received, tiempo
// medio/p95 de respuesta del cliente al bot, heatmap por hora x día de la
// semana, y calidad por plantilla (sent/delivered%/read%/failed%).
//
// filtros: days obligatorio (rango), phoneId opcional (multi-número).
// Sin Postgres: las helpers de db caen al fallback en memoria (mem.waEvents).
// Sin eventos en el rango: devolvemos arrays vacíos y nulls — la UI muestra
// estado vacío en lugar de NaN.
// ATENCION-HUMANA-1 (MET-WA-06) · quién atiende las conversaciones de WhatsApp, con
// denominadores separados. «Personas» son contactos distintos (no mensajes); «contestadas
// por el equipo» son conversaciones con al menos una respuesta de una persona (panel o
// móvil); el tiempo del equipo va desde el primer mensaje del cliente que ninguna PERSONA
// había contestado hasta la respuesta de una persona: lo que conteste la IA o un flujo en
// medio no lo para (la IA no atiende por el equipo). Solo turnos sellados con un número de
// WhatsApp elegido: los antiguos sin número no se pueden atribuir y se cuentan aparte.
export function waAtencion(
  convs: Array<{ user_id: string; n: number; t: Array<{ r: string; at: number; a: string; b: string; ai: boolean }> }>,
  accts: Set<string>, sinceMs: number, untilMs: number,
) {
  const enRango = (at: number) => at >= sinceMs && at <= untilMs;
  const personas = new Set<string>();
  const nuevas = new Set<string>();
  const contestadas = new Set<string>();
  const porAutor = { equipo: 0, ia: 0, flujo: 0, sinMarca: 0 };
  const esperas: number[] = [];
  for (const cv of convs) {
    // Una conversación puede tener turnos de varios números: cada uno es su propio hilo.
    const hilos = new Map<string, typeof cv.t>();
    for (const x of cv.t) {
      if (!x.at || !accts.has(x.a)) continue;
      (hilos.get(x.a) || hilos.set(x.a, []).get(x.a)!).push(x);
    }
    for (const [acct, turnos] of hilos) {
      const clave = cv.user_id + "|" + acct;
      turnos.sort((p, q) => p.at - q.at);
      // 400 = MAX_GUARDADO de memory.ts: un hilo recortado no dice cuándo empezó.
      const primero = turnos.find((x) => x.r === "user");
      if (primero && enRango(primero.at) && cv.n < 400) nuevas.add(clave);
      let esperaDesde = 0;
      for (const x of turnos) {
        if (x.r === "user") {
          if (enRango(x.at)) personas.add(clave);
          if (!esperaDesde) esperaDesde = x.at;
          continue;
        }
        const humano = x.b === "equipo" || x.b === "movil";
        if (enRango(x.at)) {
          if (humano) porAutor.equipo++;
          else if (x.ai || x.b === "bot") porAutor.ia++;
          else if (x.b === "flujo" || x.b === "difusion") porAutor.flujo++;
          else porAutor.sinMarca++;
        }
        if (!humano) continue;
        if (enRango(x.at)) {
          contestadas.add(clave);
          if (esperaDesde) esperas.push(x.at - esperaDesde);
        }
        esperaDesde = 0;
      }
    }
  }
  esperas.sort((p, q) => p - q);
  const mediana = esperas.length ? esperas[Math.floor((esperas.length - 1) / 2)] : null;
  return {
    personas: personas.size,
    nuevas: nuevas.size,
    contestadasEquipo: contestadas.size,
    equipoMedianaMs: mediana,
    equipoMuestras: esperas.length,
    porAutor,
  };
}

export async function segWhatsApp(days: number, phoneId?: string, win?: Win) {
  const d = clampDays(days);
  const tenant = currentWorkspaceId() || "default";
  // NUMEROS-NEGOCIO-1 · uno o varios números («a,b»), siempre de ESTE workspace: uno ajeno
  // se descarta aquí también (el PDF llama sin pasar por la ruta que da 403).
  const propios = new Set(listWaNumbers(true).map((n) => n.phoneNumberId));
  const elegidos = waPidList(phoneId).filter((p) => propios.has(p)).sort();
  const pid = elegidos.length ? elegidos.join(",") : undefined;
  // COUNCIL-FIX: el rango custom del calendario (win) se ignoraba en silencio —
  // el chip decía «rango personalizado» pero los datos eran de últimos N días.
  // Ahora la ventana viaja a las 4 consultas y ENTRA en la cacheKey.
  const sinceMs = win?.sinceMs;
  const untilMs = win?.untilMs;
  const cacheKey = `segWhatsApp:${tenant}:${pid || "all"}:${d}:${sinceMs || 0}:${untilMs || 0}`;
  return segMemo(cacheKey, async () => {
    const [hourly, byTemplate, rt, daily] = await Promise.all([
      safe(
        () => dbWaEventsHourly({ tenant_id: tenant, phone_number_id: pid, days: d, sinceMs, untilMs }),
        [] as Array<{ hour: number; dow: number; count_in: number; count_out: number }>,
      ),
      safe(
        () => dbWaEventsByTemplate({ tenant_id: tenant, phone_number_id: pid, days: d, sinceMs, untilMs }),
        [] as Awaited<ReturnType<typeof dbWaEventsByTemplate>>,
      ),
      safe(
        () => dbWaResponseTimeAvg({ tenant_id: tenant, phone_number_id: pid, days: d, sinceMs, untilMs }),
        { avg_ms: null, p95_ms: null, sample: 0 } as { avg_ms: number | null; p95_ms: number | null; sample: number },
      ),
      safe(
        () => dbWaEventsDaily({ tenant_id: tenant, phone_number_id: pid, days: d, sinceMs, untilMs }),
        [] as Array<{ date: string; count_in: number; count_out: number }>,
      ),
    ]);
    // ATENCION-HUMANA-1 · misma ventana que las consultas de eventos.
    const desde = sinceMs || Date.now() - d * 86400000;
    const hasta = untilMs || Date.now();
    const accts = new Set((elegidos.length ? elegidos : [...propios]).map((p) => "wa:" + p));
    const atencion = await safe(
      async () => waAtencion(await dbConversacionesTurnosLigeros(desde), accts, desde, hasta),
      null as ReturnType<typeof waAtencion> | null,
    );
    // ENTREGA-WA-1 · difusiones del rango (y de los números elegidos) con fallos de entrega
    // comprobados; Métricas › WhatsApp las señala con un acceso a su ficha.
    const entregaAlertas = await safe(
      () => dbEntregaAlertas(desde, hasta, elegidos),
      [] as Awaited<ReturnType<typeof dbEntregaAlertas>>,
    );
    // RESULTADO-DIFUSION-1 · cada difusión del rango (y de los números elegidos) como campaña.
    const difusiones = await safe(
      () => dbDifusionesRanking(desde, hasta, elegidos),
      [] as Awaited<ReturnType<typeof dbDifusionesRanking>>,
    );
    let sent = 0;
    let received = 0;
    for (const cell of hourly) {
      sent += cell.count_out;
      received += cell.count_in;
    }
    return {
      sent,
      received,
      response_time_avg_ms: rt.avg_ms,
      response_time_p95_ms: rt.p95_ms,
      response_time_sample: rt.sample,
      by_hour: hourly,
      by_template: byTemplate,
      daily,
      rangeDays: d,
      phoneId: pid || null,
      phoneIds: elegidos,
      atencion,
      entregaAlertas,
      difusiones,
    };
  });
}

// Convierte epoch ms → YYYY-MM-DD (día de MADRID) para la Marketing API.
// METRICAS-1 · antes UTC: la medianoche de Madrid del toolbar caía el día anterior y el rango de Ads arrancaba un día antes.
function toYMD(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

export async function segAds(days?: number, win?: Win) {
  const range = win && win.sinceMs
    ? { since: toYMD(win.sinceMs), until: toYMD(win.untilMs || Date.now()) }
    : daysToPreset(days);
  // Cache por rango (since-until) — Meta Ads insights tarda 300-500ms cada llamada.
  // HARD-4: cacheKey incluye wsId — adAccountId vive en settings PER-WS, así
  // que dos workspaces con distinto Ads connect deben tener entradas separadas
  // (sin esto, el warmer pisaría la cache del anterior cada ronda).
  const tenant = currentWorkspaceId();
  // FIX id78: la cuenta efectiva (override ALS del selector → settings) entra
  // en la clave ANTES del memo. Sin ella, el selector multi-cuenta servía el
  // gasto/leads/ROAS cacheados de otra cuenta para el mismo tenant+rango.
  const acct = activeAdsAccountId() || "main";
  const rangeKey = typeof range === "string" ? range : `${range.since}:${range.until}`;
  return segMemo(`segAds:${tenant}:${acct}:${rangeKey}:${days || ''}`, () =>
    safe(() => adsSummary(range), { configured: false, note: "Meta Ads no conectado" } as any),
  );
}

// ---------- Bundle completo + Overview ----------
export interface AnalyticsBundle {
  generatedAt: number;
  rangeDays: number;
  // UNIFICACION 2026-06-05: secciones por canal (PRO fusionado en cada una).
  // El bundle ya no separa instagramPro/facebookPro/youtubePro como ramas
  // aparte. Cada seccion combina datos basicos + datos avanzados que antes
  // estaban en el sub-tab PRO de la UI. Tambien incluye WhatsApp (antes
  // excluido por coste +300ms, aceptado tras unificacion).
  instagram: any;
  facebook: any | null;
  youtube: any | null;
  whatsapp: any | null;
  web: any;
  leads: any;
  automation: any;
  content: any;
  ads: any;
  overview: any;
  // CONTRIBUCION-FB-1 (MET-FB-01) · lo que Facebook trajo al negocio: sólo en las exportaciones (lo añade admin, no gatherAll).
  facebookAporte?: FbAporte | null;
}

// ALCANCE-MULTI-1 · El KPI «Alcance Instagram» del Inicio leía sólo la cuenta principal
// (sin cuenta en el ALS, creds() cae en meta.igBusinessId): con @leadmatch.co y
// @ingenierobinario conectadas enseñaba el alcance de una. Esto suma el de TODAS las cuentas
// del workspace; `cuentas` dice cuántas respondieron de las `de` conectadas. Meta no
// deduplica entre cuentas: quien vio las dos cuenta dos veces (lo avisa el title= del KPI).
// accountMetrics() va memoizado por cuenta: la principal no repite llamada a Meta.
async function alcanceTodasLasCuentas(): Promise<{ total: number; cuentas: number; de: number } | null> {
  const lista = listIgAccounts();
  if (!lista.length) return null;
  const vals = await Promise.all(lista.map(async (a) => {
    const c = resolveAccount(a.igId);
    if (!c) return null;
    try {
      const m = await runWithAccount(c, () => accountMetrics());
      return typeof m.reach === "number" ? m.reach : null;
    } catch { return null; }
  }));
  const ok = vals.filter((v): v is number => v != null);
  return ok.length ? { total: ok.reduce((s, v) => s + v, 0), cuentas: ok.length, de: lista.length } : null;
}

// NUMEROS-NEGOCIO-1 (MET-WA-01) · waPhone: los números de WhatsApp elegidos en la vista («a,b»),
// para que el informe exportado diga lo mismo que la pantalla. Sin él, todos los del negocio.
// CONTRIBUCION-FB-1 (MET-FB-01) · fbPage: la Página que se ve en la pestaña Facebook. Sin ella, la primera del negocio.
// NEGOCIO-EMBUDO-1 (MET-WEB-01) · webAmbito: el negocio y el embudo elegidos en la pestaña Web,
// para que el informe exportado desde ella hable del mismo negocio. Sin él, todo el workspace.
export async function gatherAll(days: number, win?: Win, waPhone?: string, fbPage?: string, webAmbito?: { biz?: string; fun?: string; cmp?: boolean }): Promise<AnalyticsBundle> {
  const d = clampDays(days);
  const [instagramBase, instagramPro, facebookPro, youtubePro, whatsapp, web, leads, automation, content, ads, alcance] = await Promise.all([
    // DISENO-1 · METRIC-10: era el único segmento sin catch — un fallo de Meta tumbaba el
    // informe entero (Resumen, exportar y «Razonar»). Un canal caído es un canal a null.
    segInstagram(d).catch(() => null),
    segInstagramPro(d).catch(() => null),
    segFacebookPro(d, fbPage, win).catch(() => null), // CONTRIBUCION-FB-1 · la Página elegida, no siempre la primera · PERIODO-FB-1 · y el rango elegido
    segYouTubePro(d).catch(() => null),
    segWhatsApp(d, waPhone, win).catch(() => null), // ATENCION-HUMANA-1 · misma ventana que el resto
    segWeb(d, win, "", undefined, webAmbito && (webAmbito.biz || webAmbito.cmp) ? { biz: webAmbito.biz, fun: webAmbito.fun, cmp: webAmbito.cmp } : undefined),
    segLeads(d, win),
    segAutomation(d, win),
    segContent(d, win),
    // FIX id80: sin argumentos, segAds caía SIEMPRE a last_30d (daysToPreset
    // (undefined)) y el Resumen mostraba gasto/leads de 30 días con 7d/90d o
    // rango custom seleccionados, desincronizado de la pestaña Ads.
    segAds(d, win),
    alcanceTodasLasCuentas().catch(() => null),
  ]);
  // Fusiones por canal: PRO se integra en su canal base. Si el PRO es null
  // (cuenta no Business / scope falta / etc.) los campos PRO quedan null pero
  // el canal sigue presente con sus datos basicos.
  const instagram: Record<string, any> = { ...(instagramBase || { account: { configured: false } }), pro: instagramPro };
  const facebook = facebookPro; // FB no tiene "base" segregada, todo viene del PRO. Renombrado.
  const youtube = youtubePro;   // Idem YT.
  // YouTube total views del rango = suma del viewsDailySeries (la API publica no da
  // un total agregado por rango directamente; lo derivamos de la serie diaria).
  const ytViewsRange = youtubePro?.range ? youtubePro.range.views : youtubePro && Array.isArray(youtubePro.viewsDailySeries)
    ? youtubePro.viewsDailySeries.reduce((acc: number, x: any) => acc + (Number(x?.views) || 0), 0)
    : null;
  const overview = {
    // Instagram
    followers: instagram.account?.followers ?? null,
    reach28d: instagram.account?.reach ?? null,
    // ALCANCE-MULTI-1 · reach28d sigue siendo el de la cuenta en curso (la pestaña de Métricas
    // la elige con ig_id); estos tres son la suma de todas las cuentas, para el Inicio.
    reachAll28d: alcance?.total ?? null,
    reachAccounts: alcance?.cuentas ?? 0,
    reachAccountsTotal: alcance?.de ?? 0,
    profileViews28d: instagram.account?.profileViews ?? null,
    accountsEngaged28d: instagram.account?.accountsEngaged ?? null,
    igViews28d: instagram.account?.views ?? null,
    igInteractions28d: instagram.account?.interactions ?? null,
    // PULIDO-IG-1 · con una cifra dudosa la tasa no se enseña en ningún sitio (portada, detalle e informe).
    igEngagementRate28d: igCifrasDudosas(instagram.account) ? null : (instagram.account?.engagementRate ?? null),
    // PULIDO-IG-1 · sobre qué se calcula la tasa («reach» o «followers»): el Resumen lo rotula.
    igEngagementRateBasis28d: instagram.account?.engagementRateBasis ?? null,
    igProfileLinksTaps28d: instagram.account?.profileLinksTaps ?? null,
    // YouTube
    ytSubscribers: youtubePro?.subscribersNow ?? null,
    ytViewsRange,
    // segYouTubePro es de UN canal (el primero si no se especifica): con varios
    // canales conectados, el título evita que estos números pasen por «todo YouTube».
    ytChannelTitle: youtubePro?.channelTitle ?? null,
    // Facebook
    fbReach: facebookPro?.reach28d ?? null,
    fbEngagedUsers: facebookPro?.engagedUsers ?? null,
    fbInteractions: facebookPro?.postEngagements ?? null, // PERIODO-FB-1 · interacciones (no personas)
    fbReachDeltaPct: facebookPro?.reachDeltaPct ?? null,
    fbReachKind: facebookPro?.reachKind ?? null,     // 'views' → la UI etiqueta «Visualizaciones», no «Alcance»
    fbPostsTotal: facebookPro?.postsTotal ?? null,     // CIFRAS-FB-1 · con reachKind «posts», la cifra es de las publicaciones MEDIDAS:
    fbPostsMedidas: facebookPro?.postsMedidas ?? null, // estas dos dicen cuántas son de cuántas leídas
    fbBlocked: facebookPro?.needsAppRole ?? false,   // posts bloqueados por Meta App Review
    // WhatsApp (NUEVO 2026-06-05)
    waSent: whatsapp?.sent ?? null,
    waReceived: whatsapp?.received ?? null,
    waResponseTimeMs: whatsapp?.response_time_avg_ms ?? null,
    waResponseP95Ms: whatsapp?.response_time_p95_ms ?? null,
    // ATENCION-HUMANA-1 · personas distintas y mediana de respuesta de una PERSONA del equipo.
    waPersonas: whatsapp?.atencion?.personas ?? null,
    waEquipoMs: whatsapp?.atencion?.equipoMedianaMs ?? null,
    // Web
    webViews: web.pageviews?.views ?? 0,
    webVisitors: web.pageviews?.users ?? 0,
    linkClicks: web.clicks?.total ?? 0,
    // CRM/Leads
    leadsTotal: leads.total,
    leadsNew: leads.newInRange,
    leadsNewPrev: leads.prevNew,
    conversations: leads.conversations,
    conversationsPrev: leads.conversationsPrev,
    flowsRun: automation.totals?.contacts ?? 0,
    carousels: content.published,
    // Ads
    adSpend: ads.configured ? ads.spend ?? 0 : null,
    adLeads: ads.configured ? ads.leads ?? 0 : null,
    adRoas: ads.configured ? ads.roas ?? null : null,
    adCurrency: ads.configured ? ads.currency || "EUR" : null,
    channels: {
      instagram: instagram.account?.configured !== false,
      facebook: !!facebookPro,
      youtube: !!youtubePro,
      whatsapp: !!whatsapp,
      web: (web.pageviews?.views ?? 0) > 0 || (web.clicks?.total ?? 0) > 0,
      ads: !!ads.configured,
    },
  };
  return { generatedAt: Date.now(), rangeDays: d, instagram, facebook, youtube, whatsapp, web, leads, automation, content, ads, overview };
}

// ---------- Export para otro LLM (Markdown) ----------
function num(n: unknown): string {
  return n == null ? "—" : typeof n === "number" ? n.toLocaleString("es-ES") : String(n);
}
// PULIDO-IG-1 · zona del informe: la del negocio si es válida; si no, Madrid.
function zonaInforme(z?: string): string {
  const s = String(z || "").trim();
  if (!s) return "Europe/Madrid";
  try { new Intl.DateTimeFormat("es-ES", { timeZone: s }); return s; } catch { return "Europe/Madrid"; }
}
function tipoHistoria(t: string): string {
  const u = String(t || "").toUpperCase();
  return u === "VIDEO" ? "Vídeo" : u === "IMAGE" ? "Imagen" : "Historia";
}
// Mismo criterio que el panel (COMUNIDAD-IG-1, igDud): un ajuste neto negativo, partes que suman
// más que el total o el aviso del servidor dejan la tasa de interacción sin calcular.
function igCifrasDudosas(a: any): boolean {
  if (!a) return false;
  const neg = (v: unknown) => typeof v === "number" && v < 0;
  const partes = [a.likes, a.comments, a.saves, a.shares];
  const noCuadra = typeof a.interactions === "number" && a.interactions >= 0
    && partes.every((v) => typeof v === "number" && v >= 0)
    && partes.reduce((s: number, v: number) => s + v, 0) > a.interactions;
  return noCuadra || !!a.cifrasDudosas
    || partes.concat([a.interactions]).some(neg)
    || [a.views, a.accountsEngaged, a.reach, a.profileViews, a.profileLinksTaps].some(neg);
}
// NEGOCIO-EMBUDO-1 · « (negocio «X» · embudo «Y»)» cuando el informe sale acotado.
function ambitoWebMd(b: AnalyticsBundle): string {
  const s: any = (b && b.web && (b.web as any).webScope) || null;
  if (!s || !s.bizNombre) return "";
  return ` (negocio «${s.bizNombre}»${s.funNombre ? ` · embudo «${s.funNombre}»` : ""})`;
}
export function toMarkdown(b: AnalyticsBundle, negocio?: string, rango?: string, zona?: string): string {
  const o = b.overview;
  const L: string[] = [];
  // NEGOCIO-VISIBLE-1 (MET-RES-01) · el informe dice de qué negocio es.
  L.push(negocio ? `# Informe de analítica · ${negocio}` : `# Informe de analítica`);
  L.push(`Rango: ${rango || `últimos ${b.rangeDays} días`} · generado: ${new Date(b.generatedAt).toISOString()}`);
  L.push(``);
  L.push(`## Resumen (cross-canal)`);
  L.push(`- Instagram: ${num(o.followers)} seguidores · Alcance 28d ${num(o.reach28d)} · Vistas 28d ${num(o.igViews28d)} · Visitas al perfil 28d ${num(o.profileViews28d)} · Cuentas que interactuaron 28d ${num(o.accountsEngaged28d)}`);
  // PULIDO-IG-1 · la tasa dice sobre qué base está calculada y no sale si las cifras no cuadran.
  if (o.igEngagementRate28d != null && !igCifrasDudosas(b.instagram?.account)) L.push(`  · Interacciones por cada 100 ${o.igEngagementRateBasis28d === "followers" ? "seguidores" : "cuentas alcanzadas"} (28d): ${num(o.igEngagementRate28d)}`);
  if (o.ytSubscribers != null) L.push(`- YouTube${o.ytChannelTitle ? ` («${o.ytChannelTitle}»)` : ""}: ${num(o.ytSubscribers)} suscriptores · Visualizaciones (${b.rangeDays}d): ${num(o.ytViewsRange)}`);
  // CONTRIBUCION-FB-1 (MET-FB-01) · nombrada por lo que mide (veces o personas), con su periodo real y sin «usuarios engaged» vacío.
  // PERIODO-FB-1 (MET-FB-04) · el periodo que de verdad se midió y las interacciones con su nombre (no «personas»).
  if (o.fbReach != null) L.push(`- Facebook${b.facebook?.pageName ? ` («${b.facebook.pageName}»)` : ""}: ${fbAlcanceNombre(o.fbReachKind)} ${num(o.fbReach)} (${b.facebook?.personalizado ? `del ${b.facebook.desde} al ${b.facebook.hasta}` : `últimos ${num(b.facebook?.rangeDays ?? b.rangeDays)} días`})${o.fbReachKind === "posts" ? fbCoberturaTxt(o.fbPostsMedidas, o.fbPostsTotal) : ""}${o.fbReachDeltaPct != null ? ` · Δ ${num(o.fbReachDeltaPct)}% vs periodo anterior` : ""}${o.fbInteractions != null ? ` · interacciones en publicaciones ${num(o.fbInteractions)}` : ""}`);
  if (o.waSent != null || o.waReceived != null) L.push(`- WhatsApp: ${num(o.waSent)} enviados · ${num(o.waReceived)} recibidos · ${num(o.waPersonas)} personas · respuesta del equipo (mediana) ${o.waEquipoMs != null ? Math.round(o.waEquipoMs / 1000) + "s" : "—"}`); // ATENCION-HUMANA-1
  L.push(`- Web${ambitoWebMd(b)}: ${num(o.webViews)} páginas vistas · ${num(o.webVisitors)} visitantes · ${num(o.linkClicks)} clics de enlaces`);
  L.push(`- Leads: ${num(o.leadsTotal)} totales · ${num(o.leadsNew)} nuevos en el rango · ${num(o.conversations)} conversaciones en el rango`);
  L.push(`- Automatización: ${num(o.flowsRun)} contactos pasaron por flujos`);
  L.push(`- Contenido: ${num(o.carousels)} carruseles publicados`);
  if (o.adSpend != null) L.push(`- Ads Meta: ${num(o.adSpend)} gasto · ${num(o.adLeads)} leads · ROAS ${num(o.adRoas)}`);
  L.push(``);
  // UNIFICACION 2026-06-05: una sola seccion '## Instagram' con account + PRO juntos.
  // PULIDO-IG-1 (MET-IG-08) · mismas definiciones que el panel: personas frente a veces, toques
  // en botones de contacto (no el enlace de la bio), hora del negocio, consejos sólo con muestra
  // y sin avisos crudos de Meta (llevaban nombres de permisos a un informe que lee el cliente).
  const a = b.instagram.account || {};
  const z = zonaInforme(zona);
  L.push(`## Instagram${a.username ? ` · @${a.username}` : ""}`);
  L.push(`- Cómo leer estas cifras: el alcance y las cuentas que interactuaron son personas distintas; las vistas, las visitas al perfil y los toques son veces (una persona puede contar varias). Las cifras de la cuenta son de los últimos 28 días e incluyen lo promocionado.`);
  const esNeg = (v: unknown) => typeof v === "number" && v < 0;
  const dudosa = igCifrasDudosas(a);
  const aj = (v: unknown) => (esNeg(v) ? " (ajuste neto: Instagram da el cambio de estos 28 días, no un recuento)" : "");
  L.push(`- Seguidores ahora: ${num(a.followers)} · Publicaciones: ${num(a.mediaCount)}`);
  if (a.reach != null) L.push(`- Alcance 28d (cuentas distintas): ${num(a.reach)}${aj(a.reach)}`);
  if (a.accountsEngaged != null) L.push(`- Cuentas que interactuaron 28d: ${num(a.accountsEngaged)}${aj(a.accountsEngaged)}`);
  if (a.views != null) L.push(`- Vistas 28d (veces, historias incluidas): ${num(a.views)}${aj(a.views)}`);
  if (a.profileViews != null) L.push(`- Visitas al perfil 28d (veces): ${num(a.profileViews)}${aj(a.profileViews)}`);
  if (a.profileLinksTaps != null) L.push(`- Toques en botones de contacto 28d (llamar, correo, cómo llegar o mensaje; Instagram no da los clics en el enlace de la biografía): ${num(a.profileLinksTaps)}`);
  if (a.interactions != null) L.push(`- Interacciones 28d: ${num(a.interactions)}${aj(a.interactions)} (me gusta ${num(a.likes)} · comentarios ${num(a.comments)} · guardados ${num(a.saves)} · compartidos ${num(a.shares)})`);
  if (a.engagementRate != null) {
    const base = a.engagementRateBasis === "followers" ? "seguidores" : "cuentas alcanzadas";
    L.push(dudosa
      ? `- Interacciones por cada 100 ${base}: sin calcular (hay cifras de ajuste neto o que no cuadran entre sí y el porcentaje saldría falso)`
      : `- Interacciones por cada 100 ${base} (28d): ${num(a.engagementRate)}`);
  }
  const gd = (b.instagram.series || []).length;
  // PORTADA-IG-1 · follower_count son las altas de cada día: Instagram no da las bajas, no es un neto.
  if (b.instagram.growth != null && gd) L.push(`- Seguidores nuevos (cuentas que empezaron a seguirte; Instagram no da las bajas) en los últimos ${gd} días: ${num(b.instagram.growth)}`);
  // CUANDO-PUBLICAR-1 · MISMO cálculo que «Cómo rindieron tus publicaciones según la hora» del panel:
  // mediana de me gusta + comentarios por franja de 3 horas, en la hora de quien mira y con un mínimo
  // de publicaciones. Con pocas no se señala ninguna hora, y nada de lo dicho es una promesa de alcance.
  const hhmm = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const pct = (v: number | null) => (v == null ? "" : `${v > 0 ? "+" : ""}${v} %`);
  const fechaCorta = (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: z }));
  const rend = rendimientoPorHora(b.instagram.allPosts, z);
  if (rend.estado === "sin-datos") {
    L.push(`- Cómo rindieron tus publicaciones según la hora: no hay publicaciones que comparar.`);
  } else if (rend.estado === "pocas") {
    L.push(`- Cómo rindieron tus publicaciones según la hora: sólo hay ${rend.n} publicaciones (hacen falta ${rend.minTotal} para compararlas), así que no se señala ninguna hora.`);
  } else {
    const dest = rend.franjas.filter((f) => f.destacada);
    const cab = `- Cómo rindieron tus publicaciones según la hora (hora de ${rend.zonaTexto}; ${rend.n} publicaciones comparadas, del ${fechaCorta(rend.desde)} al ${fechaCorta(rend.hasta)}; mediana de ${num(rend.mediana)} me gusta + comentarios por publicación):`;
    L.push(dest.length
      ? `${cab} ${dest.map((f) => `${hhmm(f.desde)}-${hhmm(f.hasta)} (${f.n} publicaciones, ${pct(f.vs)} sobre la mediana)`).join(", ")}. Es lo que pasó con esas publicaciones: no garantiza el mismo resultado ni el alcance de las próximas.`
      : `${cab} ninguna franja se distingue del resto.`);
    const dd = rend.dias.filter((x) => x.destacado);
    if (dd.length) L.push(`- Días con mejor respuesta (mismas publicaciones; sólo días con ${rend.minFranja} o más): ${dd.map((x) => `${x.nombre} (${x.n} publicaciones, ${pct(x.vs)} sobre la mediana)`).join(", ")}`);
  }
  (b.instagram.contentTypes || []).forEach((t: any) => L.push(`- Formato «${t.type}»: ${num(t.count)} publicaciones (${num(t.n)} con alcance) · alcance medio ${num(t.avgReach)} · interacciones medias ${num(t.avgEng)} · ${t.engRate != null ? `${num(t.engRate)} interacciones por cada 100 cuentas alcanzadas` : "sin tasa"}`));
  // Cuántas hay de verdad: con dos publicaciones, «(5)» prometía cinco.
  const ultimas = (b.instagram.posts || []).slice(0, 5);
  L.push(ultimas.length
    ? `- ${ultimas.length === 1 ? "Última publicación · cifras acumuladas desde que se publicó" : `Últimas ${ultimas.length} publicaciones · cifras acumuladas desde que se publicaron`}:`
    : `- Últimas publicaciones: ninguna que mostrar.`);
  ultimas.forEach((p: any) => {
    const f = p.timestamp ? new Date(p.timestamp).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: z }) : "—";
    const v = p.views != null ? ` · vistas ${num(p.views)}` : "";
    L.push(`  - [${p.typeLabel || p.type}] ${f} · «${(p.caption || "").slice(0, 60)}» · alcance ${num(p.reach)}${v} · me gusta ${num(p.likes)} · comentarios ${num(p.comments)} · guardados ${num(p.saved)}`);
  });
  if (b.instagram.pro) {
    const ip = b.instagram.pro;
    // CUANDO-PUBLICAR-1 · audiencia conectada (dato de Instagram) por separado del rendimiento de las publicaciones.
    const aud = audienciaPorHora(ip.onlineFollowersDiario, z);
    const dia = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "UTC" }) : "—");
    if (aud.estado === "ok") {
      L.push(`- Cuándo está conectada tu audiencia (hora de ${aud.zonaTexto}; media de ${aud.dias} días, del ${dia(aud.desdeDia)} al ${dia(aud.hastaDia)}; Instagram no indica en qué zona da estas horas y se leen como hora universal, UTC): ${aud.franjas.map((f) => `${hhmm(f.desde)}-${hhmm(f.hasta)} (${pct(f.vsMedia)} sobre la media)`).join(", ")}`);
    } else if (aud.estado === "pareja") {
      L.push(`- Cuándo está conectada tu audiencia: en ${aud.dias} días ninguna franja destaca sobre el resto.`);
    } else if (aud.estado === "pocos-dias") {
      L.push(`- Cuándo está conectada tu audiencia: con sólo ${aud.dias} días de datos aún no se puede decir qué franjas destacan.`);
    } else if ((ip.warnings || []).some((w: string) => /^online_followers/.test(String(w)))) {
      L.push(`- Cuándo está conectada tu audiencia: Instagram no devolvió las horas en esta consulta.`);
    }
    const est = ip.storiesEstado;
    if (est === "ok" && Array.isArray(ip.recentStories) && ip.recentStories.length) {
      L.push(`- Historias activas (últimas 24 horas): ${ip.recentStories.length}`);
      ip.recentStories.slice(0, 3).forEach((s: any) => L.push(`  - ${tipoHistoria(s.mediaType)} · alcance ${num(s.reach)} · vistas ${num(s.views)} · respuestas ${num(s.replies)}`));
    } else if (est === "sin-historias") L.push(`- Historias: ninguna activa ahora (Instagram sólo da las de las últimas 24 horas).`);
    else if (est === "sin-permiso") L.push(`- Historias: Instagram no dejó leerlas; se arregla volviendo a conectar la cuenta en Conexiones.`);
    else if (est === "error") L.push(`- Historias: Instagram no respondió al pedirlas (no es un cero).`);
    const he = ip.hashtagEstado;
    if (he === "ok" && Array.isArray(ip.hashtagPerf) && ip.hashtagPerf.length) {
      L.push(`- Tus hashtags más usados y su popularidad pública (me gusta + comentarios de sus 10 publicaciones destacadas, de cualquier cuenta): ${ip.hashtagPerf.slice(0, 5).map((h: any) => `${h.tag} (${num(h.engagement ?? h.reach)})`).join(", ")}`);
    } else if (he === "sin-hashtags") L.push(`- Hashtags: tus últimas publicaciones no usan ninguno.`);
    else if (he === "sin-permiso") L.push(`- Hashtags: Instagram no permite a este panel consultar hashtags públicos.`);
    else if (he === "sin-datos") L.push(`- Hashtags: Instagram no devolvió datos en esta consulta.`);
  }
  L.push(``);
  // CONTRIBUCION-FB-1 (MET-FB-01) · lo mismo que la portada de la pestaña: qué Página, qué fechas, qué mide cada cifra (veces
  // o personas) y lo que Facebook trajo al negocio con datos propios. Sin Página conectada, sólo si Facebook trajo algo.
  const apFb: FbAporte | null | undefined = b.facebookAporte;
  const apFbVale = !!apFb && ((apFb.web?.visitas || 0) > 0 || (apFb.contactos?.total || 0) > 0);
  if (b.facebook || apFbVale) {
    const fp = b.facebook || {};
    const fFb = (ms: number) => new Date(ms).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: z });
    L.push(`## Facebook${b.facebook ? ` · ${fp.pageName || fp.pageId}` : ""}`);
    if (apFb) {
      L.push(`- Periodo: ${fFb(apFb.desde)} – ${fFb(apFb.hasta)}`);
      // PERIODO-FB-1 (MET-FB-04) · las cifras de la Página ya siguen el mismo periodo: se quitó el aviso de desfase.
      const w = apFb.web;
      if (!w) L.push(`- Visitas a tus webs desde Facebook: no disponible ahora.`);
      else if (!w.webs && !w.visitasTotales) L.push(`- Visitas a tus webs desde Facebook: sin medir (ninguna web mide visitas todavía).`);
      else L.push(`- Visitas a tus webs desde Facebook: ${num(w.visitas)} de ${num(w.visitasTotales)} (visitas = sesiones, no personas)${w.deAnuncios ? ` · ${num(w.deAnuncios)} desde anuncios marcados` : ""}`);
      const c = apFb.contactos;
      if (!c) L.push(`- Contactos identificados con origen Facebook: no disponible ahora.`);
      else {
        L.push(`- Contactos identificados con origen Facebook: ${num(c.total)} de ${num(c.totalNegocio)} contactos nuevos${c.deAnuncios ? ` · ${num(c.deAnuncios)} de anuncios` : ""} (Messenger, comentarios en tu Página con un flujo activo, enlaces marcados como Facebook y formularios de anuncios recibidos al momento)`);
        if (!c.total) L.push(`  - Último con origen Facebook: ${c.ultimo ? fFb(c.ultimo) : "ninguno en los últimos 12 meses"}`);
      }
    }
    // PERIODO-FB-1 (MET-FB-04) · el periodo real de las cifras de la Página (el del calendario si se eligió).
    const perFb = fp.personalizado && fp.desde ? `del ${fFb(Date.parse(fp.desde + "T12:00:00Z"))} al ${fFb(Date.parse(fp.hasta + "T12:00:00Z"))}` : `últimos ${num(fp.rangeDays)} días`;
    if (fp.reach28d != null) L.push(`- ${fbAlcanceNombre(fp.reachKind)} (${perFb}): ${num(fp.reach28d)}${fp.reachKind === "posts" ? fbCoberturaTxt(fp.postsMedidas, fp.postsTotal) : ""}${fp.reachPrev != null ? ` · periodo anterior: ${num(fp.reachPrev)} · Δ ${num(fp.reachDeltaPct)}%` : ""}`);
    else if (b.facebook) L.push(`- Alcance e impresiones (${perFb}): Meta no los da para esta Página ahora mismo (no es un cero).`);
    if (fp.engagedUsers != null) L.push(`- Personas que interactuaron: ${num(fp.engagedUsers)}`);
    if (fp.postEngagements != null) L.push(`- Interacciones en publicaciones (reacciones + comentarios + compartidos, ${perFb}): ${num(fp.postEngagements)}`);
    if (fp.engagementRate != null) L.push(`- Engagement rate: ${num(fp.engagementRate)}%${fp.reachKind === "posts" ? " (interacciones entre impresiones de las mismas publicaciones medidas)" : ""}`);
    if (Array.isArray(fp.postTypes)) fp.postTypes.forEach((t: any) => L.push(`  - ${t.label || t.type}: ${num(t.count)} posts${t.impressions != null ? ` · impresiones ${num(t.impressions)} (${num(t.pct)}%)${t.medidas != null && t.medidas < t.count ? ` medidas en ${num(t.medidas)} de ${num(t.count)}` : ""}` : " · impresiones no disponibles"}`));
    if (Array.isArray(fp.warnings) && fp.warnings.length) L.push(`- ⚠ Meta: ${fp.warnings.join("; ")}`);
    L.push(``);
  }
  if (b.youtube) {
    const yp = b.youtube;
    // LECTURAS-YT-1 (MET-YT-06) · antes: «Subs netos últimos 14d» (de las fotos diarias, fuera cual
    // fuera el rango) y «Top vídeos recientes» con 0 vistas para todo reciente que no estuviera entre
    // los 10 más vistos. Ahora, las cifras del rango que enseña Métricas → YouTube.
    const rg = yp.range;
    L.push(`## YouTube`);
    L.push(`- Canal: ${yp.channelTitle || ""}`);
    L.push(`- Suscriptores actuales: ${num(yp.subscribersNow)}`);
    if (rg) {
      L.push(`- Rango de la analítica: del ${rg.from} al ${rg.to}${rg.lastDataDate ? ` (datos hasta el ${rg.lastDataDate})` : ""}`);
      L.push(`- Visualizaciones del rango: ${num(rg.views)} (reproducciones, no personas)`);
      L.push(`- Suscriptores netos del rango: ${rg.subsNet >= 0 ? "+" : ""}${num(rg.subsNet)}`);
      if (rg.top.length) {
        L.push(`- Vídeos con más visualizaciones del rango:`);
        rg.top.forEach((v: any) => L.push(`  - "${v.title.slice(0, 60)}" · ${num(v.views)} visualizaciones · ${num(v.subsGained)} suscriptores nuevos`));
      }
    } else L.push(`- Analítica del rango: YouTube no la ha devuelto`);
    if (Array.isArray(yp.warnings) && yp.warnings.length) L.push(`- ⚠ YouTube: ${yp.warnings.join("; ")}`);
    L.push(``);
  }
  if (b.whatsapp) {
    const w = b.whatsapp;
    L.push(`## WhatsApp`);
    L.push(`- Enviados (rango): ${num(w.sent)} · Recibidos: ${num(w.received)}`);
    if (w.response_time_avg_ms != null) L.push(`- Tiempo medio de respuesta del bot al cliente: ${Math.round(w.response_time_avg_ms / 1000)}s`);
    if (w.response_time_p95_ms != null) L.push(`- P95 de respuesta: ${Math.round(w.response_time_p95_ms / 1000)}s`);
    if (Array.isArray(w.by_hour) && w.by_hour.length) {
      const peak = [...w.by_hour].sort((x: any, y: any) => ((y.count_in || 0) + (y.count_out || 0)) - ((x.count_in || 0) + (x.count_out || 0)))[0];
      if (peak) L.push(`- Hora pico (más tráfico in+out): ${peak.dow}h${peak.hour}:00`);
    }
    if (Array.isArray(w.by_template) && w.by_template.length) {
      L.push(`- Top 3 plantillas por envío:`);
      w.by_template.slice(0, 3).forEach((t: any) => L.push(`  - "${t.name}": ${num(t.sent)} enviados${t.delivered_pct != null ? ` · ${t.delivered_pct}% delivered` : ""}${t.read_pct != null ? ` · ${t.read_pct}% read` : ""}`));
    }
    L.push(``);
  }
  L.push(`## Web (analítica propia, estilo GA)${ambitoWebMd(b)}`);
  const w = b.web.pageviews || {};
  L.push(`- Usuarios ${num(w.users)} · Sesiones ${num(w.sessions)} · Páginas vistas ${num(w.views)} · Tiempo medio ${num(Math.round((w.avgEngagementMs || 0) / 1000))}s · Engagement ${num(w.engagementRate)}% · Nuevos ${num(w.newPct)}%`);
  // channels ahora cuenta SESIONES por canal (atribución GA4), no vistas — la unidad va
  // explícita para que el razonador IA no lo mezcle con el total de páginas vistas.
  (w.channels || []).slice(0, 5).forEach((s: any) => L.push(`  - Canal ${s.label}: ${num(s.value)} sesiones`));
  (w.pages || []).slice(0, 5).forEach((p: any) => L.push(`  - Página ${p.label}: ${num(p.views)} vistas, ${num(p.visitors)} únicos`));
  (b.web.clicks?.top || []).slice(0, 5).forEach((l: any) => L.push(`  - Enlace "${l.label}" (${l.kind}): ${num(l.clicks)} clics`));
  L.push(``);
  L.push(`## Leads / CRM`);
  {
    // LEADS PRO: el razonador IA se quejaba (con razón) de no tener datos
    // comparativos — ahora segLeads los trae y el informe los expone todos.
    const lb = b.leads as Record<string, any>;
    L.push(`- Total ${num(lb.total)} · Nuevos en rango ${num(lb.newInRange)}${lb.prevNew != null ? ` (periodo anterior: ${num(lb.prevNew)})` : ""} · Conversaciones en rango ${num(lb.conversations)}${lb.conversationsPrev != null ? ` (anterior: ${num(lb.conversationsPrev)})` : ""}`);
    L.push(`- Por etapa${(lb.stageOrder || []).length ? " (orden real del pipeline)" : ""}: ${(lb.byStage || []).map((s: any) => `${s.label} (${s.count})`).join(", ")}`);
    L.push(`- Por origen (todo el CRM): ${(lb.bySource || []).map((s: any) => `${s.label} (${s.count})`).join(", ")}`);
    if ((lb.bySourceNew || []).length) {
      const pm: Record<string, number> = {};
      (lb.bySourcePrev || []).forEach((s: any) => { pm[s.label] = s.count; });
      L.push(`- Origen de los NUEVOS del rango: ${(lb.bySourceNew || []).map((s: any) => `${s.label} (${s.count}${pm[s.label] != null ? `, antes ${pm[s.label]}` : ""})`).join(", ")}`);
    }
    if ((lb.byChannelNew || []).length) {
      const cl = lb.channelLabels || {};
      L.push(`- Canal de entrada de los nuevos: ${(lb.byChannelNew || []).slice(0, 6).map((c: any) => `${cl[c.label] || c.label || "sin canal"} (${c.count})`).join(", ")}`);
    }
    if (lb.actionable) {
      const a = lb.actionable;
      L.push(`- Accionables: ${num(a.overdue)} seguimientos vencidos · ${num(a.coldNew)} nuevos que nunca han escrito · ${num(a.assigned)}/${num(a.sampleSize)} con dueño asignado`);
    }
    // BASE-LEADS-1 (MET-LEADS-08) · la campaña sólo la pueden traer los que entraron por enlace,
    // formulario o registro; sobre el resto no es un 0 %, es «no aplica».
    if (lb.utmCoverageNew?.of) {
      const u = lb.utmCoverageNew;
      if (u.ofMarcable) L.push(`- Campaña identificada: ${Math.round((u.withUtm || 0) / u.ofMarcable * 100)}% de los ${num(u.ofMarcable)} nuevos que entraron por enlace, formulario o registro (${num(u.withUtm)}); los demás escribieron directamente o se dieron de alta desde el panel y no pueden traerla`);
      else L.push(`- Campaña identificada: no aplica, ningún nuevo entró por enlace, formulario o registro (se sabe la cuenta por la que entraron, no la publicación)`);
    }
    if ((lb.hotLeads || []).length) L.push(`- Leads calientes (score≥60): ${num((lb.hotLeads || []).length)}`);
    if (lb.inWindow24h != null) L.push(`- En ventana de 24h de WhatsApp: ${num(lb.inWindow24h)}`);
  }
  L.push(``);
  L.push(`## Automatización`);
  L.push(`- Disparadores ${num(b.automation.triggers)} (${num(b.automation.triggersActive)} activos) · Secuencias ${num(b.automation.sequences)}`);
  (b.automation.flows || []).slice(0, 6).forEach((f: any) => L.push(`  - Flujo "${f.name}": ${num(f.contacts)} contactos · ${num(f.completion)}% completado · ${num(f.clicks)} clics`));
  L.push(``);
  L.push(`## Contenido`);
  L.push(`- Carruseles publicados (rango) ${num(b.content.published)} · intentos fallidos (rango) ${num(b.content.failedAttempts)} · intentos (histórico) ${num(b.content.publishedTotal)}`);
  (b.content.byPlatform || []).forEach((p: any) => L.push(`  - ${p.platform}: ${num(p.ok)} OK / ${num(p.fail)} fallos`));
  L.push(``);
  if (b.ads?.configured) {
    L.push(`## Ads (Meta)`);
    L.push(`- Gasto ${num(b.ads.spend)} ${b.ads.currency || ""} · Leads ${num(b.ads.leads)} · CPL ${num(b.ads.cpl)} · ROAS ${num(b.ads.roas)}`);
    L.push(``);
  }
  L.push(`---`);
  L.push(`Datos crudos en el JSON adjunto. Analiza el embudo Contenido→Alcance→Web→Lead→Conversación y prioriza acciones.`);
  L.push(`Si el user pregunta por una métrica específica de un canal, busca primero en la sección del canal (Instagram / Facebook / YouTube / WhatsApp / Web / Ads) y compara periodos cuando esté disponible (Δ% indica cambio vs periodo anterior).`);
  return L.join("\n");
}

// ---------- Razonar resultados (LLM gratis) ----------
const REASON_SYSTEM = `Eres un analista SENIOR de growth y revenue operations para un negocio digital que capta
leads por Instagram, WhatsApp, email y páginas web. Te paso un informe de métricas multi-canal
COMPLETO con una sección por canal: Instagram + Facebook + YouTube + WhatsApp + Web + Leads/CRM + Automatización + Contenido + Ads.

Analiza el EMBUDO completo (Contenido → Alcance → Tráfico web → Lead → Conversación → Venta),
en español de España, claro y directo, sin paja. Nivel consultor caro: cada afirmación con su cifra.

REGLAS DE ANÁLISIS:
- Cuando el informe traiga comparativas («periodo anterior: N», «antes N», «Δ%»), CALCULA el cambio y úsalo. La sección Leads/CRM trae comparativas de nuevos, conversaciones y fuente a fuente.
- Cruza canales: si los leads suben/bajan, busca la causa en la fuente dominante (¿cambió su alcance, su contenido publicado, su tráfico web?).
- Detecta concentración de riesgo (una sola fuente >70% de la captación) y cuellos de botella (etapa del pipeline que acumula, correos de flujo con caída, leads nuevos que nunca escriben).
- Los accionables del CRM (seguimientos vencidos, leads sin activar, % sin dueño) son dinero parado: úsalos.
- No inventes datos que no estén en el informe. Si falta un canal o una métrica, dilo en UNA línea y sigue.

Si el usuario hace una PREGUNTA CONCRETA:
1. PRIMERO respóndela directamente con cifras y comparativas del informe (sección y dato).
2. Si el dato no está, dilo claro y propón qué conectar o etiquetar (p.ej. UTM) para poder responderla.
3. LUEGO añade un DIAGNÓSTICO breve y las ACCIONES.

Si NO hay pregunta concreta, devuelve EXACTAMENTE estas secciones:
DIAGNÓSTICO EXPRESS: (2-3 frases: la foto del período con los cambios clave en cifras)
QUÉ FUNCIONA: (2-4 viñetas con cifras concretas)
QUÉ NO FUNCIONA: (2-4 viñetas: cuellos de botella del embudo, con el dato que lo prueba)
ACCIONES PRIORIZADAS: (3-5, cada una con [P1]/[P2], el resultado esperado y sobre qué métrica)
VIGILAR ESTA SEMANA: (2-3 métricas concretas y por qué)`;

export async function reasonAnalytics(days: number, question?: string, win?: Win): Promise<string> {
  const bundle = await gatherAll(days, win);
  const md = toMarkdown(bundle);
  const user = question && question.trim()
    ? `Informe:\n\n${md}\n\nPregunta concreta del usuario: ${question.trim()}\nResponde a la pregunta Y luego da las 3 secciones.`
    : `Informe:\n\n${md}`;
  return await chat(
    [{ role: "system", content: REASON_SYSTEM }, { role: "user", content: user }],
    // BUG 2026-06-04: maxTokens 1200 truncaba la respuesta a mitad de frase
    // (cuando hay pregunta concreta + 3 secciones la respuesta no cabe en 1200).
    // Subido a 2400 para que haya margen.
    { maxTokens: 2400, temperature: 0.4 },
  );
}

// ============================================================
// metricas-pro #15 — Segmentos PRO (Facebook / Instagram / Ads / YouTube)
// ============================================================
//
// Cada segPRO devuelve datos REALES fetcheados a las APIs nativas:
//   - segMemo TTL 3min con cacheKey que incluye wsId (no cross-tenant leak)
//   - Si falta credencial: null + warning (NUNCA invento métricas — never fake)
//   - logActivity en catches con payload _redacted:['access_token']
//
// La UI los consume vía endpoints GET /admin/api/analytics/{fb|ig|ads|yt}-pro
// y, si null, muestra empty state con CTA "Conectar".

const FB_GRAPH = "https://graph.facebook.com/v21.0";

// Helper: dispara una llamada Graph y devuelve JSON crudo (defensivo).
// timeoutMs por defecto 8s — Page insights tarda 300-1500ms normalmente.
async function fbGraph(path: string, token: string, timeoutMs = 8000): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  try {
    const r = await fetch(`${FB_GRAPH}/${path}${sep}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(timeoutMs) });
    return await r.json().catch(() => ({}));
  } catch (e) {
    return { error: { message: (e as Error).message } };
  }
}

// Suma el value de un /insights item de Graph (Meta devuelve arrays por día).
function sumInsightValues(item: any): number {
  const values: any[] = item?.values || [];
  return values.reduce((acc, v) => acc + (Number(v?.value) || 0), 0);
}

export interface FacebookProBundle {
  configured: boolean;
  pageId: string;
  pageName: string;
  rangeDays: number;
  desde: string;                    // PERIODO-FB-1 (MET-FB-04) · YYYY-MM-DD, primer día medido
  hasta: string;                    // YYYY-MM-DD, último día medido
  personalizado: boolean;           // true = rango del calendario; false = últimos rangeDays días
  reach28d: number | null;          // según reachKind; null si ninguna fuente vive
  reachPrev: number | null;         // periodo anterior (mismo nº de días); null si Graph error
  reachDeltaPct: number | null;
  reachKind: "views" | "unique" | "posts" | null; // QUÉ se midió: page_media_view / legacy unique / derivado de posts
  engagedUsers: number | null;      // PERSONAS que interactuaron: Meta ya no lo da → null (PERIODO-FB-1: antes se rellenaba con interacciones)
  postEngagements: number | null;   // page_post_engagements o sum(reactions+comments+shares); null si no se pudo
  engagementRate: number | null;    // (engagedUsers ?? postEngagements) / reach28d * 100; null si falta base. CIFRAS-FB-1: con reachKind «posts», las interacciones son las de las publicaciones MEDIDAS
  postsTotal: number | null;        // CIFRAS-FB-1 · publicaciones del periodo que se leyeron (hasta 50); null = no se pudieron leer
  postsMedidas: number | null;      // CIFRAS-FB-1 · de ellas, las que tienen impresiones (sólo se pregunta por las 30 más recientes y Meta puede callar alguna)
  postTypes: Array<{ type: string; label: string; impressions: number | null; count: number; medidas: number; pct: number | null }>; // impressions/pct null = Meta sin impresiones; medidas = publicaciones de ese formato CON impresiones (las impresiones y el % son sólo de ellas)
  warnings: string[];
  needsAppRole: boolean;            // posts bloqueados por Meta App Review (#10) → la UI muestra CTA
}

// CONTRIBUCION-FB-1 (MET-FB-01) · Lo que Facebook trajo al NEGOCIO en el periodo, con datos PROPIOS (píxel y contactos), sin Meta:
//  · web: visitas = SESIONES (no personas) cuya fuente es Facebook: la etiqueta de la vista Web («Facebook») y las de
//    utm_source como «facebook_ads» o «fb». «deAnuncios» sólo con utm_medium de pago: fbclid va en TODOS los clics que salen
//    de Facebook, también los orgánicos. Si la tabla fuente/medio (top 30) no cuadra con el total, deAnuncios = null: no se
//    inventa un cero.
//  · contactos: creados en el periodo con origen Facebook, MISMA regla que Origen de leads (platformOf): Messenger,
//    comentarios que dispararon un flujo, enlaces marcados como Facebook y Lead Ads por webhook (meta-lead-ad). Con cero,
//    «ultimo» dice cuándo entró el último (12 meses).
//  · null = no se pudo medir (≠ 0). Es del negocio entero: ni el píxel ni el contacto guardan la Página. pageViewStats va
//    aparte de segWeb a propósito: segWeb rellena con ceros si falla.
export interface FbAporte {
  rangeDays: number; desde: number; hasta: number; personalizado: boolean;
  web: { visitas: number; deAnuncios: number | null; visitasTotales: number; webs: number } | null;
  contactos: { total: number; deAnuncios: number; totalNegocio: number; ultimo: number | null } | null;
}
// = PAID_MEDIUM de web-analytics.ts (no exportado).
const FB_PAGO_MEDIO = /^(cpc|ppc|paidsearch|paid|paid_social|paid-social|paidsocial|cpm|cpv|cpa|display|banner|retargeting|remarketing|interstitial)$/;
const esFuenteFb = (l: string): boolean => /facebook/i.test(l) || /^fb([^a-z]|$)/i.test(l);
export async function segFbAporte(days: number, win?: Win): Promise<FbAporte> {
  const d = clampDays(days);
  const w = windowOf(days, win);
  const tenant = currentWorkspaceId() || "default";
  let web: FbAporte["web"] = null;
  try {
    const [pv, sitios] = await Promise.all([pageViewStats(d, tenant, w), listPixelSites(tenant)]);
    const visitas = (pv.sources || []).filter((s) => esFuenteFb(String(s.label || ""))).reduce((a, s) => a + (Number(s.value) || 0), 0);
    const filas = (pv.sourceMedium || []).filter((r) => esFuenteFb(String(r.source || "")));
    const cuadra = filas.reduce((a, r) => a + (Number(r.sessions) || 0), 0) === visitas;
    const deAnuncios = cuadra ? filas.filter((r) => FB_PAGO_MEDIO.test(String(r.medium || "").toLowerCase())).reduce((a, r) => a + (Number(r.sessions) || 0), 0) : null;
    web = { visitas, deAnuncios, visitasTotales: Number(pv.sessions) || 0, webs: (sitios || []).length };
  } catch { web = null; }
  let contactos: FbAporte["contactos"] = null;
  try {
    const esFb = (r: { utm_source: string; source: string }) => platformOf(r.utm_source, r.source) === "facebook";
    const filas = await dbLeadAttributionRows(w.sinceMs, w.untilMs);
    const fb = filas.filter(esFb);
    const deAnuncios = fb.filter((r) => r.source === "meta-lead-ad" || paidOrganicOf({ utm_source: r.utm_source, utm_medium: r.utm_medium, utm_campaign: r.utm_campaign, utm_content: r.utm_content }) === "pago").length;
    let ultimo: number | null = null;
    if (!fb.length) {
      const ahora = Date.now();
      for (const r of await dbLeadAttributionRows(ahora - 365 * DAY, ahora)) {
        const t = Number(r.created_at) || 0;
        if (esFb(r) && t > (ultimo || 0)) ultimo = t;
      }
    }
    contactos = { total: fb.length, deAnuncios, totalNegocio: filas.length, ultimo };
  } catch { contactos = null; }
  return { rangeDays: d, desde: w.sinceMs, hasta: w.untilMs, personalizado: !!(win && win.sinceMs), web, contactos };
}
// CONTRIBUCION-FB-1 · el nombre de la cifra de la Página según lo que Meta midió de verdad (reachKind): veces frente a personas.
export function fbAlcanceNombre(kind: unknown): string {
  return kind === "views" ? "Visualizaciones de la Página (veces, no personas)"
    : kind === "posts" ? "Impresiones de tus publicaciones (veces, no personas)"
    : kind === "unique" ? "Alcance de la Página (personas)"
    : "Alcance de la Página";
}
// CIFRAS-FB-1 · cuando las impresiones salen de las publicaciones (reachKind «posts») y no son de todas las leídas, lo dice:
// «medidas en N de M publicaciones». Vacío si son todas o si no se sabe (nunca un recuento inventado).
export function fbCoberturaTxt(medidas: unknown, total: unknown): string {
  if (medidas == null || total == null) return "";
  const m = Number(medidas);
  const t = Number(total);
  if (!Number.isFinite(m) || !Number.isFinite(t) || !(m < t)) return "";
  return ` · medidas en ${m.toLocaleString("es-ES")} de ${t.toLocaleString("es-ES")} publicaciones`;
}

// segFacebookPro — KPIs PRO para una Page concreta del workspace activo.
//   - reach 28d (page_impressions_unique con fallback a sum(post_impressions))
//   - engagement rate (page_engaged_users / reach * 100)
//   - post types breakdown (impresiones por type: text/photo/video/link)
//
// Returns null si:
//   - meta.fbAccounts vacío
//   - pageId no es propiedad del workspace (cross-tenant guard server-side)
export async function segFacebookPro(days: number, pageId?: string, win?: Win): Promise<FacebookProBundle | null> {
  const d = clampDays(days);
  const tenant = currentWorkspaceId();
  const accounts = listFbAccounts();
  if (!accounts.length) return null;
  const pid = (pageId && pageId.trim()) || accounts[0].pageId;
  const acc = accounts.find((a) => a.pageId === pid);
  if (!acc) return null; // pageId no es del workspace
  // PERIODO-FB-1 (MET-FB-04) · con rango del calendario se miden ESAS fechas (y la caché las
  // distingue); sin él, los últimos d días como siempre. El periodo anterior mide lo mismo de largo.
  const w = win && win.sinceMs ? windowOf(d, win) : null;
  const cacheKey = `segFacebookPro:${tenant}:${pid}:${d}${w ? `:${w.sinceMs}-${w.untilMs}` : ""}`;
  return segMemo<FacebookProBundle>(cacheKey, async () => {
    const warnings: string[] = [];
    const until = w ? Math.floor(w.untilMs / 1000) : Math.floor(Date.now() / 1000);
    const since = w ? Math.floor(w.sinceMs / 1000) : until - d * 86400;
    const sincePrev = since - (until - since);
    const untilPrev = since;

    // 1) Reach/visualizaciones — Meta ELIMINÓ page_impressions_unique (#100 real en
    // prod, nov-2025). CADENA de candidatas: page_media_view (sustituta anunciada,
    // period=day sumable) y la legacy por si alguna Page la conserva. Si ninguna
    // vive → fallback a posts (abajo). reachKind dice QUÉ se midió para que la UI
    // etiquete con honestidad («Visualizaciones» ≠ «Alcance único»).
    let reach28d: number | null = null;
    let reachPrev: number | null = null;
    let reachKind: "views" | "unique" | "posts" | null = null;
    try {
      const chain: Array<{ m: string; kind: "views" | "unique" }> = [
        { m: "page_media_view", kind: "views" },
        { m: "page_impressions_unique", kind: "unique" },
      ];
      for (const c of chain) {
        const r = await fbGraph(`${pid}/insights?metric=${c.m}&period=day&since=${since}&until=${until}`, acc.token);
        if (r?.error) { warnings.push(`reach (${c.m}): ${r.error.message}`); continue; }
        const item = Array.isArray(r?.data) ? r.data[0] : null;
        if (!item) continue;
        reach28d = sumInsightValues(item);
        reachKind = c.kind;
        const rp = await fbGraph(`${pid}/insights?metric=${c.m}&period=day&since=${sincePrev}&until=${untilPrev}`, acc.token);
        const ip = Array.isArray(rp?.data) ? rp.data[0] : null;
        if (ip) reachPrev = sumInsightValues(ip);
        break;
      }
    } catch (e) {
      warnings.push(`reach: ${(e as Error).message}`);
    }

    // 2) page_engaged_users fue ELIMINADA por Meta (#100 permanente en prod): ya NO
    // se pide — solo latencia y ruido. El engagement sale de page_post_engagements
    // (abajo) o del derivado de posts.
    let engagedUsers: number | null = null;

    // 3) page_post_engagements. Si falla, sumamos reactions+comments+shares de los
    // posts del rango. COUNCIL-FIX: el error ya no se traga en silencio.
    let postEngagements: number | null = null;
    let postEngagementsGraphFailed = false;
    try {
      const r = await fbGraph(`${pid}/insights?metric=page_post_engagements&period=day&since=${since}&until=${until}`, acc.token);
      if (r?.error) { warnings.push(`post_engagements: ${r.error.message}`); postEngagementsGraphFailed = true; }
      else if (Array.isArray(r?.data) && r.data[0]) postEngagements = sumInsightValues(r.data[0]);
      else postEngagementsGraphFailed = true;
    } catch (e) { warnings.push(`post_engagements: ${(e as Error).message}`); postEngagementsGraphFailed = true; }

    // 4) Posts del rango — para post types breakdown + fallback engagement.
    //    Recogemos hasta 50 posts; cada uno con insights individuales para impresiones.
    const postTypeAgg = new Map<string, { impressions: number; count: number; medidas: number }>();
    let postsInsOk = false; // PERIODO-FB-1 · Meta dio impresiones de al menos una publicación
    let derivedEng = 0;
    let derivedReach = 0;
    // CIFRAS-FB-1 · las impresiones sólo existen de las publicaciones por las que se pregunta (las 30 más recientes) y Meta
    // puede callar alguna: lo que se divide entre impresiones usa SÓLO las publicaciones medidas, y se dice cuántas son.
    let postsLeidas = false;     // la lista de publicaciones se leyó (0 puede ser un cero de verdad)
    let postsTotal = 0;
    let postsMedidas = 0;
    let derivedEngMedidas = 0;   // interacciones de las publicaciones medidas: el numerador de una tasa sobre sus impresiones
    let fbProNeedsAppRole = false;
    try {
      const fields = "created_time,message,attachments{media_type,type},reactions.summary(true),comments.summary(true),shares";
      // COUNCIL-FIX: cadena published_posts→feed→posts (la que ya usa facebook.ts) —
      // /posts a secas exige Page Public Content Access incluso para admins. Si los
      // tres fallan, propagamos needsAppRole para que la UI muestre el CTA de App
      // Review en vez de cards vacías.
      let posts: any[] = [];
      let lastErr = "";
      for (const ep of ["published_posts", "feed", "posts"]) {
        const pr = await fbGraph(`${pid}/${ep}?fields=${encodeURIComponent(fields)}&limit=50&since=${since}&until=${until}`, acc.token, 15000);
        if (pr?.error) { lastErr = String(pr.error.message || ""); continue; }
        posts = pr?.data || [];
        lastErr = "";
        break;
      }
      if (lastErr) {
        warnings.push(`posts: ${lastErr}`);
        if (lastErr.includes("Page Public Content Access") || lastErr.includes("PAGES_ACCESS") || lastErr.includes("pages_read_user_content")) fbProNeedsAppRole = true;
      } else postsLeidas = true;
      // Per-post insights (top 30 para no abusar de Meta). Cadena post_impressions →
      // post_media_views (sustituta si Meta retiró la primera).
      const enrichIds = posts.slice(0, 30).map((p) => String(p.id));
      const insMap = new Map<string, number>();
      await Promise.all(enrichIds.map(async (postId) => {
        try {
          for (const pm of ["post_impressions", "post_media_views"]) {
            const ir = await fbGraph(`${postId}/insights?metric=${pm}`, acc.token, 6000);
            if (!ir?.error && Array.isArray(ir?.data) && ir.data[0]) {
              insMap.set(postId, Number(ir.data[0]?.values?.[0]?.value) || 0);
              break;
            }
          }
        } catch { /* silent per-post */ }
      }));
      postsInsOk = insMap.size > 0;
      // Tipo del post a partir de attachments (Meta lo expone en .attachments.data[0].media_type).
      for (const p of posts) {
        const att = p?.attachments?.data?.[0] || {};
        const rawType = String(att.media_type || att.type || "status").toLowerCase();
        let type: "photo" | "video" | "link" | "text" = "text";
        if (rawType.includes("video")) type = "video";
        else if (rawType.includes("photo") || rawType.includes("image") || rawType.includes("album")) type = "photo";
        else if (rawType.includes("share") || rawType.includes("link")) type = "link";
        // CIFRAS-FB-1 · «medida» = Meta dio una cifra de impresiones para ella (también si fue 0); sin cifra no entra en lo que se divide.
        const medida = insMap.has(String(p.id));
        const impressions = medida ? (insMap.get(String(p.id)) || 0) : 0;
        const cur = postTypeAgg.get(type) || { impressions: 0, count: 0, medidas: 0 };
        cur.count += 1;
        if (medida) { cur.impressions += impressions; cur.medidas += 1; }
        postTypeAgg.set(type, cur);
        derivedReach += impressions;
        const reactions = Number(p?.reactions?.summary?.total_count) || 0;
        const comments = Number(p?.comments?.summary?.total_count) || 0;
        const shares = Number(p?.shares?.count) || 0;
        derivedEng += reactions + comments + shares;
        postsTotal += 1;
        if (medida) { postsMedidas += 1; derivedEngMedidas += reactions + comments + shares; }
      }
    } catch (e) {
      warnings.push(`posts: ${(e as Error).message}`);
      logActivity({
        source: "meta-api",
        level: "warn",
        summary: "segFacebookPro: posts fetch failed",
        payload: { pageId: pid, error: (e as Error).message, _redacted: ["access_token"] },
      }).catch(() => null);
    }

    // Fallbacks (Meta eliminó las métricas nativas de reach/engagement de Page).
    // Si tenemos derivado desde posts, lo usamos — reachKind='posts' para que la UI
    // etiquete el origen real. Si no hay nada, null (nunca 0 fabricado).
    if (reach28d == null && derivedReach > 0) { reach28d = derivedReach; reachKind = "posts"; }
    // PERIODO-FB-1 (MET-FB-04) · engagedUsers ya NO se rellena con derivedEng: eso son
    // interacciones (reacciones+comentarios+compartidos), no personas, y el informe decía
    // «Personas que interactuaron». Las interacciones viven en postEngagements.
    if (postEngagements == null) {
      if (derivedEng > 0) postEngagements = derivedEng;
      else if (!postEngagementsGraphFailed) postEngagements = 0; // Graph respondió 0 real
      // else: null
    }

    // post types breakdown con etiqueta legible + % sobre total impresiones.
    // PERIODO-FB-1 · sin impresiones de NINGUNA publicación, impresiones y % son null (no 0 medido).
    const totalImpr = [...postTypeAgg.values()].reduce((a, x) => a + x.impressions, 0) || 1;
    const labels: Record<string, string> = { photo: "Foto", video: "Vídeo", link: "Enlace", text: "Texto" };
    const postTypes = [...postTypeAgg.entries()]
      .map(([type, v]) => ({
        type,
        label: labels[type] || type,
        impressions: postsInsOk ? v.impressions : null,
        count: v.count,
        medidas: v.medidas, // CIFRAS-FB-1 · las impresiones y el % son sólo de estas
        pct: postsInsOk ? Math.round((v.impressions / totalImpr) * 1000) / 10 : null,
      }))
      .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0) || b.count - a.count);

    // engagement rate = interacciones / reach. Base: engagedUsers (derivado) o
    // page_post_engagements — lo que haya vivo. null si no hay numerador o denominador.
    // CIFRAS-FB-1 · numerador y denominador, del MISMO conjunto: con el alcance derivado de las publicaciones (reachKind
    // «posts») sólo cuentan las interacciones de las publicaciones medidas; antes eran las de todas las leídas entre las
    // impresiones de unas pocas, y la tasa salía inflada.
    const engBase = reachKind === "posts"
      ? (postsMedidas > 0 ? derivedEngMedidas : null)
      : (engagedUsers ?? postEngagements);
    const engagementRate: number | null = (reach28d && reach28d > 0 && engBase != null)
      ? Math.round((engBase / reach28d) * 1000) / 10
      : null;

    // Delta % vs periodo anterior (Meta-nativo si lo dio; null si no).
    const reachDeltaPct = (reach28d != null && reachPrev != null && reachPrev > 0)
      ? Math.round(((reach28d - reachPrev) / reachPrev) * 1000) / 10
      : null;

    const ymd = (s: number) => new Date(s * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
    return {
      configured: true,
      pageId: pid,
      pageName: acc.name,
      rangeDays: d,
      desde: ymd(since), // PERIODO-FB-1 · el periodo real medido (hora del negocio)
      hasta: ymd(until),
      personalizado: !!w,
      reach28d,
      reachPrev,
      reachDeltaPct,
      reachKind,
      engagedUsers,
      postEngagements,
      engagementRate,
      postsTotal: postsLeidas ? postsTotal : null,
      postsMedidas: postsLeidas ? postsMedidas : null,
      postTypes,
      warnings,
      needsAppRole: fbProNeedsAppRole,
    };
  });
}

// ============================================================
// segInstagramPro — IG Business KPIs PRO
// ============================================================
//
// Devuelve:
//   - online_followers (heatmap 24h, breakdown por hora del día)
//   - bestPostingTimes (top 6 horas con más online followers)
//   - storyReach28d + sample de las últimas N stories con sus insights
//   - top hashtag perf (opcional — IG Hashtag Search puede fallar)
export interface InstagramProBundle {
  configured: boolean;
  igBusinessId: string;
  rangeDays: number;
  // FIX #15: null cuando Graph falla (NO [0,0,...]). UI muestra mensaje
  // "Audiencia online no disponible" en lugar de heatmap de ceros falso.
  onlineFollowersByHour: number[] | null;   // length 24 (índice = clave de hora de Instagram; no documenta su zona)
  bestPostingTimes: Array<{ hour: number; followers: number; label: string }>;
  // Alcance de las stories ACTIVAS (suma del reach de las últimas 24h — Meta no expone
  // más histórico a nivel de story). El nombre conserva «28d» por compat de campo,
  // pero la UI lo etiqueta como 24h. null = sin stories con dato (nunca 0 engañoso).
  storyReach28d: number | null;
  // PULIDO-IG-1 · `impressions` ya no existe para historias (Meta la retiró el 21-abr-2025):
  // ahora `views`. null = Instagram no dio esa cifra (nunca un 0 inventado).
  recentStories: Array<{ id: string; mediaType: string; permalink: string; reach: number | null; views: number | null; replies: number | null; thumb?: string }>;
  /** PULIDO-IG-1 · por qué hay o no historias: ok · ninguna activa · sin permiso (se arregla
   *  volviendo a conectar) · error de Instagram. El panel no confunde un error con un cero. */
  storiesEstado: "ok" | "sin-historias" | "sin-permiso" | "error";
  // Semántica REAL del valor: likes + comentarios del top_media PÚBLICO del
  // hashtag (posts de cualquier cuenta IG) — es señal de demanda del hashtag,
  // NO alcance de la cuenta. `reach` se mantiene por compat con consumidores
  // del bundle; `engagement` es el alias honesto (mismo número).
  hashtagPerf: Array<{ tag: string; reach: number; engagement: number }> | null; // null = no disponible (scope)
  /** AVISOS-META-1 · true = Meta no concede la lectura de hashtags. El panel lo lee de aqui, no
   *  del texto del aviso (que ahora esta en cristiano y no lleva el nombre del scope). */
  hashtagScopeMissing: boolean;
  /** PULIDO-IG-1 · ok · sin-hashtags (tus publicaciones no usan) · sin-permiso (Meta no concede
   *  la búsqueda de hashtags a la app: volver a conectar NO lo arregla) · sin-datos. */
  hashtagEstado: "ok" | "sin-hashtags" | "sin-permiso" | "sin-datos";
  /** PULIDO-IG-1 · días que promedia la audiencia conectada (0 = sin datos). */
  onlineFollowersDays: number;
  /** CUANDO-PUBLICAR-1 · un punto por día (instante `end_time` + 24 horas; null = esa hora sin cifra) para
   *  convertir a la zona de quien mira con la regla horaria de CADA día. [] = sin datos. */
  onlineFollowersDiario: DiaAudiencia[];
  warnings: string[];
}

export async function segInstagramPro(days: number, igBusinessId?: string): Promise<InstagramProBundle | null> {
  const d = clampDays(days);
  const tenant = currentWorkspaceId();
  const accounts = listIgAccounts();
  if (!accounts.length) return null;
  // Si llega un igBusinessId concreto, validamos que sea del workspace.
  let igId = igBusinessId && igBusinessId.trim() ? igBusinessId.trim() : "";
  if (igId) {
    const ok = accounts.some((a) => a.igId === igId);
    if (!ok) return null;
  } else {
    igId = activeIgCreds().igId || accounts[0].igId;
  }
  const acc = accounts.find((a) => a.igId === igId);
  if (!acc) return null;
  const token = acc.token;
  const cacheKey = `segInstagramPro:${tenant}:${igId}:${d}`;
  return segMemo<InstagramProBundle>(cacheKey, async () => {
    const warnings: string[] = [];

    // 1) online_followers — breakdown por hora del día (insight legacy aún vivo).
    //    Meta lo devuelve como { "00": x, "01": y, ... "23": z } en el .values[0].value
    // FIX #15: si Graph falla, dejamos null (NO [0]*24) → UI muestra
    // "Audiencia online no disponible". Solo si llegó respuesta válida llenamos.
    let onlineFollowersByHour: number[] | null = null;
    let onlineFollowersDays = 0;
    let onlineFollowersDiario: DiaAudiencia[] = [];
    try {
      // COUNCIL-FIX: sin since/until Graph devuelve solo ~2 días y el «promedio 28d»
      // de la etiqueta era mentira. Meta conserva online_followers 30 días como máximo.
      const ofDays = Math.min(d, 30);
      const ofSince = Math.floor(Date.now() / 1000) - ofDays * 86400;
      const ofUntil = Math.floor(Date.now() / 1000);
      const r = await fbGraph(`${igId}/insights?metric=online_followers&period=lifetime&since=${ofSince}&until=${ofUntil}`, token, 8000);
      if (r?.error) warnings.push(`online_followers: ${r.error.message}`);
      else {
        // Meta devuelve un punto por día. Para el heatmap promediamos los últimos d días.
        const values: any[] = r?.data?.[0]?.values || [];
        if (values.length) {
          const arr = new Array(24).fill(0);
          const lastN = values.slice(-d);
          const counts = new Array(24).fill(0);
          const sums = new Array(24).fill(0);
          for (const v of lastN) {
            const map: Record<string, number> = v?.value || {};
            for (const [hr, n] of Object.entries(map)) {
              const h = Number(hr);
              if (h >= 0 && h < 24) {
                sums[h] += Number(n) || 0;
                counts[h] += 1;
              }
            }
          }
          for (let h = 0; h < 24; h++) {
            arr[h] = counts[h] > 0 ? Math.round(sums[h] / counts[h]) : 0;
          }
          // PULIDO-IG-1 · todo a cero (cuentas pequeñas) no es una audiencia: se queda sin datos.
          if (arr.some((v) => v > 0)) {
            onlineFollowersByHour = arr;
            onlineFollowersDays = lastN.length;
            // CUANDO-PUBLICAR-1 · el dato por día, sin promediar: la zona se aplica día a día.
            onlineFollowersDiario = lastN.map((v: any) => {
              const map: Record<string, number> = v?.value || {};
              const horas: Array<number | null> = new Array(24).fill(null);
              for (const [hr, n] of Object.entries(map)) {
                const hh = Number(hr);
                if (Number.isInteger(hh) && hh >= 0 && hh < 24 && Number.isFinite(Number(n))) horas[hh] = Number(n);
              }
              return { t: Date.parse(String(v?.end_time || "")), h: horas };
            });
          }
        }
      }
    } catch (e) {
      warnings.push(`online_followers: ${(e as Error).message}`);
    }
    // Best posting times: top 6 horas con más online followers (con label legible).
    // Si online no disponible → array vacío (no fake top).
    const bestPostingTimes = onlineFollowersByHour
      ? onlineFollowersByHour
          .map((followers, hour) => ({ hour, followers, label: `${String(hour).padStart(2, "0")}:00` }))
          .filter((x) => x.followers > 0)
          .sort((a, b) => b.followers - a.followers)
          .slice(0, 6)
      : [];

    // 2) Alcance de stories — COUNCIL-FIX: la llamada anterior
    //    (metric=reach&period=days_28) era DOBLEMENTE errónea: Graph rechaza days_28
    //    para reach (#100 en cada carga, warning real de producción) y, aunque
    //    funcionara, era alcance de CUENTA, no de stories. El dato honesto: suma del
    //    reach de las stories activas (Meta solo expone las últimas 24h) — se calcula
    //    de recentStories tras obtenerlas, sin llamada extra.
    let storyReach28d: number | null = null;

    // 3) Stories recientes con sus insights (last 24h Meta-side).
    const recentStories: InstagramProBundle["recentStories"] = [];
    let storiesEstado: InstagramProBundle["storiesEstado"] = "error";
    try {
      // COUNCIL-FIX: limit=50 (antes 5) — el alcance de stories se SUMA sobre todas
      // las activas; con 5 se truncaba en cuentas que publican muchas. La lista
      // visual sigue enseñando 5 (slice en la UI).
      // PULIDO-IG-1 · sin `impressions` (retirada por Meta: daba un 0 falso junto a alcances de 989).
      const sr = await fbGraph(`${igId}/stories?fields=id,media_type,permalink,thumbnail_url,media_url,insights.metric(reach,replies)&limit=50`, token, 10000);
      if (sr?.error) {
        warnings.push(`stories: ${sr.error.message}`);
        // 10 / 190 / 2xx = permiso o sesión de Instagram: se arregla volviendo a conectar.
        const code = Number(sr.error.code);
        storiesEstado = code === 10 || code === 190 || (code >= 200 && code < 300) ? "sin-permiso" : "error";
      }
      const list: any[] = sr?.data || [];
      for (const s of list) {
        const ins: any[] = s?.insights?.data || [];
        const m = (name: string): number | null => {
          const x = ins.find((y) => y.name === name);
          const v = x?.values?.[0]?.value ?? x?.total_value?.value;
          return typeof v === "number" ? v : null;
        };
        recentStories.push({
          id: String(s.id),
          mediaType: String(s.media_type || ""),
          permalink: String(s.permalink || ""),
          reach: m("reach"),
          views: null,
          replies: m("replies"),
          thumb: s.thumbnail_url || s.media_url || undefined,
        });
      }
      // `views` va aparte y sólo en las 5 que enseña el panel: si una historia no la admite,
      // ese error no se lleva por delante el alcance y las respuestas de las demás.
      await Promise.all(recentStories.slice(0, 5).map(async (st) => {
        const vr: any = await fbGraph(`${st.id}/insights?metric=views`, token, 6000).catch(() => null);
        const x = vr?.data?.[0];
        const v = x?.values?.[0]?.value ?? x?.total_value?.value;
        if (typeof v === "number") st.views = v;
      }));
      if (!sr?.error) storiesEstado = recentStories.length ? "ok" : "sin-historias";
    } catch (e) {
      storiesEstado = "error";
      warnings.push(`stories: ${(e as Error).message}`);
      logActivity({
        source: "meta-api",
        level: "warn",
        summary: "segInstagramPro: stories fetch failed",
        payload: { igId, error: (e as Error).message, _redacted: ["access_token"] },
      }).catch(() => null);
    }
    // Alcance real de stories = suma del reach de las stories ACTIVAS (Meta solo expone
    // las últimas 24h). null cuando no hay stories con dato — nunca 0 engañoso.
    // PULIDO-IG-1 · sólo si TODAS traen alcance: una suma parcial pasaría por el total.
    if (recentStories.length && recentStories.every((s) => s.reach != null)) {
      storyReach28d = recentStories.reduce((a, s) => a + (s.reach || 0), 0);
    }

    // 4) Hashtag perf (opcional). Requiere IG Hashtag Search API + permisos
    //    (instagram_basic + ig_hashtag_search). Estos scopes faltan en muchas
    //    apps Meta no-aprobadas y Graph responde con:
    //      - status 400 "Permissions error" (code 200 / subcode 33 — unsupported)
    //      - o silencio con error.code en el JSON
    //    FIX #15 ig: clasificamos robusto. Si scope falla → hashtagPerf=null +
    //    warning ESPECÍFICO ("Permiso instagram_basic+ig_hashtag_search
    //    requerido") para que la UI muestre mensaje correcto al operador en
    //    lugar de "sin datos" genérico o tabla vacía falsa. NO retry, NO fake.
    let hashtagPerf: InstagramProBundle["hashtagPerf"] = null;
    let hashtagScopeMissing = false;
    let hashtagEstado: InstagramProBundle["hashtagEstado"] = "sin-datos";
    try {
      // Extraemos hashtags de los últimos posts del rango.
      const mr = await fbGraph(`${igId}/media?fields=caption&limit=25`, token, 8000);
      if (mr?.error) warnings.push(`hashtag_perf: ${mr.error.message}`);
      const captions: string[] = (mr?.data || []).map((m: any) => String(m.caption || ""));
      const tagCount = new Map<string, number>();
      for (const c of captions) {
        const matches = c.match(/#[\p{L}\p{N}_]+/gu) || [];
        for (const m of matches) {
          const t = m.slice(1).toLowerCase();
          if (t.length > 1) tagCount.set(t, (tagCount.get(t) || 0) + 1);
        }
      }
      const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
      if (!topTags.length && !mr?.error) hashtagEstado = "sin-hashtags";
      if (topTags.length) {
        const results: Array<{ tag: string; reach: number; engagement: number }> = [];
        for (const tag of topTags) {
          try {
            const sr = await fbGraph(`ig_hashtag_search?user_id=${encodeURIComponent(igId)}&q=${encodeURIComponent(tag)}`, token, 5000);
            // FIX #15 ig: Graph devuelve error.code en JSON sin tirar excepción.
            // Códigos típicos por scope ausente:
            //  - code 10 (permission denied)
            //  - code 200 (Unsupported_post_request) subcode 33
            //  - code 4   (rate limit) — no es scope, NO marcamos missing
            if (sr?.error) {
              const code = Number(sr.error.code);
              const sub = Number(sr.error.error_subcode);
              if (code === 10 || (code === 200 && sub === 33) || code === 100) {
                hashtagScopeMissing = true;
                break; // ningún tag servirá si falta el scope
              }
              continue; // otro error → siguiente tag
            }
            const hashId = sr?.data?.[0]?.id;
            if (!hashId) continue;
            const tm = await fbGraph(`${hashId}/top_media?user_id=${encodeURIComponent(igId)}&fields=id,like_count,comments_count&limit=10`, token, 6000);
            if (tm?.error) {
              const code = Number(tm.error.code);
              const sub = Number(tm.error.error_subcode);
              if (code === 10 || (code === 200 && sub === 33) || code === 100) {
                hashtagScopeMissing = true;
                break;
              }
              continue;
            }
            // OJO semántica: esto NO es alcance ni es de la cuenta — es la suma
            // de likes+comentarios del top_media público del hashtag. `reach`
            // se conserva por compat; `engagement` es el alias honesto.
            const reach = (tm?.data || []).reduce((acc: number, x: any) => acc + (Number(x.like_count) || 0) + (Number(x.comments_count) || 0), 0);
            results.push({ tag: "#" + tag, reach, engagement: reach });
          } catch (e) {
            // Errores HTTP no-JSON (timeout, network). NO marcamos missing.
            // Anotamos en warnings y seguimos con el siguiente tag.
            warnings.push(`hashtag '${tag}': ${(e as Error).message}`);
          }
        }
        if (results.length) hashtagPerf = results.sort((a, b) => b.reach - a.reach);
      }
      if (hashtagScopeMissing) {
        // hashtagPerf queda null (semántica: "no disponible") + warning explícito.
        warnings.push("Rendimiento de hashtags no disponible: Meta no concede la lectura de hashtags a esta app (scopes instagram_basic + ig_hashtag_search).");
      }
      if (hashtagScopeMissing) hashtagEstado = "sin-permiso";
      else if (hashtagPerf) hashtagEstado = "ok";
    } catch (e) {
      // Outer catch: si /media falla (no es scope hashtag), no marcamos
      // hashtagScopeMissing. Solo logueamos el error para diagnóstico.
      warnings.push(`hashtag_perf: ${(e as Error).message}`);
      logActivity({
        source: "meta-api",
        level: "warn",
        summary: "segInstagramPro: hashtag perf fetch failed",
        payload: { igId, error: (e as Error).message, _redacted: ["access_token"] },
      }).catch(() => null);
    }

    return {
      configured: true,
      igBusinessId: igId,
      rangeDays: d,
      onlineFollowersByHour,
      bestPostingTimes,
      storyReach28d,
      recentStories,
      hashtagPerf,
      hashtagScopeMissing,
      hashtagEstado,
      storiesEstado,
      onlineFollowersDays,
      onlineFollowersDiario,
      warnings,
    };
  });
}

// ============================================================
// segAdsPro — Meta Ads Marketing API KPIs PRO
// ============================================================
//
// Devuelve:
//   - cpcByAdset: ad sets con su CPC medio + benchmark color (verde/rojo)
//   - roas: ROAS global (revenue / spend) con delta vs periodo anterior
//   - frequencyWarnings: ad sets con frequency > 3.0 (fatiga)
export interface AdsProBundle {
  configured: boolean;
  adAccountId: string;
  currency: string;
  rangeDays: number;
  cpcByAdset: Array<{ adsetId: string; adsetName: string; cpc: number; spend: number; clicks: number; bm: "good" | "ok" | "bad" }>;
  roas: number | null;
  roasPrev: number | null;
  roasDeltaPct: number | null;
  spend: number;
  conversionValue: number;
  frequencyWarnings: Array<{ adsetId: string; adsetName: string; frequency: number; spend: number }>;
  warnings: string[];
}

function adsRangeDates(days: number, win?: Win): { since: string; until: string; sincePrev: string; untilPrev: string } {
  const fmt = toYMD;
  // Con ventana explícita (?from=&to= del toolbar) se respeta ese rango; el
  // periodo anterior es el tramo de la MISMA longitud inmediatamente previo.
  // Sin ventana explícita comparamos ventanas MADURAS: until = ayer. Incluir
  // HOY parcial en el periodo actual frente a un previo completo sesgaba el
  // delta del ROAS sistemáticamente a la baja.
  const until = win && win.sinceMs ? (win.untilMs || Date.now()) : Date.now() - 86400000;
  const since = win && win.sinceMs ? win.sinceMs : until - days * 86400000;
  // time_range de Meta es inclusivo en AMBOS extremos: untilPrev retrocede un
  // día respecto a since para que el día frontera no cuente en los dos periodos.
  const untilPrev = since - 86400000;
  const sincePrev = untilPrev - (until - since);
  return { since: fmt(since), until: fmt(until), sincePrev: fmt(sincePrev), untilPrev: fmt(untilPrev) };
}

export async function segAdsPro(days: number, adAccountId?: string, win?: Win): Promise<AdsProBundle | null> {
  const d = clampDays(days);
  const tenant = currentWorkspaceId();
  const accounts = metaAdsAccountsList();
  if (!accounts.length) return null;
  // Si llega override, validamos ownership.
  let actId = adAccountId && adAccountId.trim() ? adAccountId.trim() : "";
  if (actId) {
    const ok = accounts.some((a) => a.adAccountId === actId);
    if (!ok) return null;
  } else {
    actId = accounts[0].adAccountId;
  }
  const entry = accounts.find((a) => a.adAccountId === actId)!;
  // La ventana explícita entra en la clave del memo: sin ella, un rango
  // personalizado («Mes pasado») serviría datos cacheados de «últimos N días».
  const cacheKey = `segAdsPro:${tenant}:${actId}:${d}` + (win && win.sinceMs ? `:${win.sinceMs}-${win.untilMs || 0}` : "");
  return segMemo<AdsProBundle>(cacheKey, async () => {
    return await runWithAdsAccount({ adAccountId: entry.adAccountId, token: entry.token }, async () => {
      const warnings: string[] = [];
      const { since, until, sincePrev, untilPrev } = adsRangeDates(d, win);
      const tr = (s: string, u: string) => `time_range=${encodeURIComponent(JSON.stringify({ since: s, until: u }))}`;

      // Moneda REAL de la cuenta — JAMÁS inventar EUR: las entries sintetizadas
      // para instalaciones legacy pre-M2 traen currency:"" y el fallback "EUR"
      // mostraba una cuenta USD/MXN como euros. Si falta, se resuelve con un
      // GET a la cuenta (una llamada, dentro del segMemo ya cacheado); si el
      // GET falla, cadena vacía — la UI la tolera y renderiza sin sufijo.
      let currency = entry.currency || "";
      if (!currency) {
        try {
          const curRes = await graphGet<any>(`act_${actId}?fields=currency`);
          if (curRes.ok) currency = String(curRes.data?.currency || "");
        } catch { /* best effort: sin sufijo de moneda */ }
      }

      // 1) Insights a nivel adset con métricas PRO.
      const adsetFields = "adset_id,adset_name,spend,clicks,cpc,impressions,frequency,actions,action_values";
      const insRes = await graphGet<any>(`act_${actId}/insights?level=adset&fields=${encodeURIComponent(adsetFields)}&${tr(since, until)}&limit=100`);
      if (!insRes.ok) {
        warnings.push(`insights: ${insRes.error || "graph error"}`);
        logActivity({
          source: "meta-api",
          level: "warn",
          summary: "segAdsPro: insights fetch failed",
          payload: { adAccountId: actId, error: insRes.error, _redacted: ["access_token"] },
        }).catch(() => null);
        return {
          configured: true,
          adAccountId: actId,
          currency,
          rangeDays: d,
          cpcByAdset: [],
          roas: null,
          roasPrev: null,
          roasDeltaPct: null,
          spend: 0,
          conversionValue: 0,
          frequencyWarnings: [],
          warnings,
        };
      }
      const rows: any[] = insRes.data?.data || [];

      // Valor de compras para ROAS: pickPurchaseValue (metaAds.ts) toma el
      // agregado O un subtipo, NUNCA la suma — action_values trae omni_purchase
      // + purchase + fb_pixel_purchase para LA MISMA conversión y sumarlos
      // inflaba ROAS/valor hasta 3x. Misma fuente que Resumen y pestaña Ads.
      const valueOf = (actionValues: any[]): number => pickPurchaseValue(actionValues);

      // Importe del periodo actual a NIVEL CUENTA — la MISMA fuente que el
      // periodo anterior (más abajo). Sumar level=adset con limit=100 truncaba
      // el actual con >100 ad sets mientras el previo (nivel cuenta) no,
      // comparando magnitudes distintas. level=adset queda reservado para
      // cpcByAdset/frequencyWarnings.
      let totalSpend = 0;
      let totalConvValue = 0;
      try {
        const insNow = await graphGet<any>(`act_${actId}/insights?fields=spend,action_values&${tr(since, until)}`);
        if (insNow.ok) {
          const nowRow = insNow.data?.data?.[0] || {};
          totalSpend = Number(nowRow.spend) || 0;
          totalConvValue = valueOf(nowRow.action_values);
        } else {
          warnings.push(`insights_now: ${insNow.error || "graph error"}`);
        }
      } catch (e) {
        warnings.push(`insights_now: ${(e as Error).message}`);
      }
      const cpcByAdset: AdsProBundle["cpcByAdset"] = [];
      const frequencyWarnings: AdsProBundle["frequencyWarnings"] = [];

      // Calcular CPC medio de la cuenta para fijar benchmark verde/rojo.
      let weightedCpcNum = 0;
      let weightedCpcDen = 0;
      for (const row of rows) {
        const sp = Number(row.spend) || 0;
        const cl = Number(row.clicks) || 0;
        if (cl > 0) {
          weightedCpcNum += sp;
          weightedCpcDen += cl;
        }
      }
      const accountCpc = weightedCpcDen > 0 ? weightedCpcNum / weightedCpcDen : 0;
      for (const row of rows) {
        const cpc = Number(row.cpc) || 0;
        const sp = Number(row.spend) || 0;
        const cl = Number(row.clicks) || 0;
        const freq = Number(row.frequency) || 0;
        const adsetId = String(row.adset_id || "");
        const adsetName = String(row.adset_name || adsetId);
        if (cl > 0) {
          // Benchmark: <= 80% acc = good, > 130% acc = bad, mid = ok.
          let bm: "good" | "ok" | "bad" = "ok";
          if (accountCpc > 0) {
            if (cpc <= accountCpc * 0.8) bm = "good";
            else if (cpc > accountCpc * 1.3) bm = "bad";
          }
          cpcByAdset.push({ adsetId, adsetName, cpc: +cpc.toFixed(2), spend: +sp.toFixed(2), clicks: cl, bm });
        }
        if (freq > 3.0 && sp > 0) {
          frequencyWarnings.push({ adsetId, adsetName, frequency: +freq.toFixed(2), spend: +sp.toFixed(2) });
        }
      }
      cpcByAdset.sort((a, b) => a.cpc - b.cpc);

      // 2) ROAS periodo anterior.
      let prevSpend = 0;
      let prevConvValue = 0;
      try {
        const insPrev = await graphGet<any>(`act_${actId}/insights?fields=spend,action_values&${tr(sincePrev, untilPrev)}`);
        if (insPrev.ok) {
          const row = insPrev.data?.data?.[0] || {};
          prevSpend = Number(row.spend) || 0;
          prevConvValue = valueOf(row.action_values);
        }
      } catch (e) {
        warnings.push(`insights_prev: ${(e as Error).message}`);
      }

      const roas = totalSpend > 0 ? +(totalConvValue / totalSpend).toFixed(2) : null;
      const roasPrev = prevSpend > 0 ? +(prevConvValue / prevSpend).toFixed(2) : null;
      const roasDeltaPct = (roas != null && roasPrev != null && roasPrev > 0)
        ? Math.round(((roas - roasPrev) / roasPrev) * 1000) / 10
        : null;

      return {
        configured: true,
        adAccountId: actId,
        currency,
        rangeDays: d,
        cpcByAdset: cpcByAdset.slice(0, 10),
        roas,
        roasPrev,
        roasDeltaPct,
        spend: +totalSpend.toFixed(2),
        conversionValue: +totalConvValue.toFixed(2),
        frequencyWarnings,
        warnings,
      };
    });
  });
}

// ============================================================
// segYouTubePro — YouTube Data + Analytics API KPIs PRO
// ============================================================
//
// Devuelve:
//   - viewsHourly: SIEMPRE null. YouTube Analytics API publica NO expone la
//     dimensión `hour` para reports de canal (sólo Real-Time API la tiene,
//     y requiere otro scope + tier). Antes inventábamos distribuyendo views
//     diarios entre 12-21h "porque sí" — ahora seguimos la regla never-fake:
//     dato no disponible → null + warning explícito.
//   - viewsDailySeries: serie REAL de views/día (los últimos d días desde
//     YouTube Analytics). La UI la pinta como sparkline en lugar del heatmap.
//   - topVideos: top 10 vídeos recientes con stats
//   - subSparkline: serie histórica de suscriptores desde app_daily_snapshots
export interface YouTubeProBundle {
  configured: boolean;
  channelId: string;
  channelTitle: string;
  rangeDays: number;
  // FIX #15 yt: heatmap 24h NO disponible en YT Analytics pública.
  // viewsHourly siempre null → UI muestra sparkline 30d en su lugar.
  viewsHourly: number[] | null;
  // Serie real de views/día (length = rangeDays). Reemplaza el heatmap fake.
  viewsDailySeries: Array<{ date: string; views: number }>;
  topVideos: Array<{ id: string; title: string; thumb: string; views: number | null; likes: number | null; published: string }>;
  subSparkline: number[];               // últimos 14 días
  // LECTURAS-YT-1 (MET-YT-06) · las cifras del rango tal como las pinta Métricas → YouTube (misma
  // analítica y misma ventana), para que el informe no las reinterprete. null si no llegó.
  range: { views: number; subsNet: number; from: string; to: string; lastDataDate: string | null; top: Array<{ title: string; views: number; subsGained: number }> } | null;
  subscribersNow: number;
  warnings: string[];
}

export async function segYouTubePro(days: number, ytChannelId?: string, win?: { sinceMs: number; untilMs: number }): Promise<YouTubeProBundle | null> {
  const d = clampDays(days);
  const tenant = currentWorkspaceId();
  const accounts = youtubeListAccounts();
  if (!accounts.length) return null;
  let chanId = ytChannelId && ytChannelId.trim() ? ytChannelId.trim() : "";
  if (chanId) {
    const ok = accounts.some((a) => a.channelId === chanId);
    if (!ok) return null;
  } else {
    chanId = accounts[0].channelId;
  }
  const acc = accounts.find((a) => a.channelId === chanId);
  if (!acc) return null;
  const cacheKey = `segYouTubePro:${tenant}:${chanId}:${d}` + (win ? `:${win.sinceMs}-${win.untilMs}` : "");
  return segMemo<YouTubeProBundle>(cacheKey, async () => {
    const warnings: string[] = [];

    // 1) Channel snapshot (subscriberCount actual + uploads playlist).
    const ch = await safe(() => youtubeChannel(acc.id), null as any);
    if (!ch) {
      warnings.push("channel: no se pudo leer (¿token caducado?)");
    }
    const channelTitle = ch?.title || acc.title || "Tu canal";
    const subscribersNow = Number(ch?.subscribers || 0);

    // 2) Top videos (últimos publicados + stats).
    const recent = await safe(() => youtubeRecentVideos(ch?.uploads || "", 10, acc.id), [] as any[]);
    // METRICAS-1 · las cifras de los recientes se piden por id (recentIds) y se cruzan con
    // videoStats: antes se cruzaban con el top 10 por vistas y un reciente fuera del top salía a 0.
    // Si la analítica no llegó, null («sin dato»), no 0.
    const an = await safe(() => youtubeAnalyticsBundle(acc.id, d, recent.map((v: any) => v.id), win), null as any);
    const medidos = !!an?.recentMeasured;
    const topVideos = recent.map((v: any) => {
      const stat = an?.videoStats?.[v.id];
      return {
        id: v.id,
        title: v.title || "",
        thumb: v.thumb || "",
        views: medidos ? Number(stat?.views) || 0 : null,
        likes: medidos ? Number(stat?.likes) || 0 : null,
        published: v.published || "",
      };
    });

    // 3) viewsHourly + viewsDailySeries.
    //    YouTube Analytics API publica NO acepta `dimensions=hour` para reports
    //    de canal (sólo dimensiones documentadas: day, video, country, device,
    //    insightTrafficSourceType, ageGroup, gender, etc.). El heatmap por hora
    //    real requiere la Real-Time Analytics API, que está en beta cerrada y
    //    pide otro scope. Antes inventábamos distribuyendo views/dia entre
    //    12-21h "porque sí" → violaba la regla never-fake-metrics.
    //
    //    Solución honesta:
    //      - viewsHourly = null + warning ("YT no expone dim hour pública").
    //      - viewsDailySeries = serie REAL de views/día (lo que YT sí da).
    //    La UI degrada el heatmap a sparkline 30d con label "Vistas últimos Nd".
    const viewsHourly: number[] | null = null;
    warnings.push("Heatmap por hora no disponible en YouTube Analytics pública (mostramos sparkline diaria en su lugar).");
    const viewsDailySeries: Array<{ date: string; views: number }> = [];
    try {
      // METRICAS-1 · los mismos días que el bundle (N, en Madrid), no N+1 en UTC.
      const { base: rb } = rangoYoutube(d, win);
      const rep = await youtubeAnalyticsReport(acc.id, rb.startDate, rb.endDate, "views", "day", "day");
      if (rep && Array.isArray(rep.rows)) {
        const dayIdx = rep.cols.indexOf("day");
        const viewsIdx = rep.cols.indexOf("views");
        for (const row of rep.rows) {
          const date = dayIdx >= 0 ? String(row[dayIdx] || "") : "";
          const views = viewsIdx >= 0 ? Number(row[viewsIdx]) || 0 : 0;
          if (date) viewsDailySeries.push({ date, views });
        }
      }
    } catch (e) {
      warnings.push(`viewsDailySeries: ${(e as Error).message}`);
    }

    // 4) Sparkline subscribers (14d) — desde app_daily_snapshots, métrica
    //    `yt_subs_${channelId}` si snapshots la registra; si no, array vacío.
    const subSparkline = await safe(() => getSparkline(`yt_subs_${chanId}`, 14, tenant), [] as number[]);

    return {
      configured: true,
      channelId: chanId,
      channelTitle,
      rangeDays: d,
      viewsHourly,
      viewsDailySeries,
      topVideos,
      subSparkline,
      subscribersNow,
      range: an ? {
        views: Number(an.period?.views) || 0, subsNet: Number(an.period?.subsNet) || 0,
        from: String(an.window?.from || ""), to: String(an.window?.to || ""), lastDataDate: an.lastDataDate || null,
        top: (an.topVideos || []).slice(0, 5).map((v: any) => ({ title: String(v.title || ""), views: Number(v.views) || 0, subsGained: Number(v.subsGained) || 0 })),
      } : null,
      warnings,
    };
  });
}
