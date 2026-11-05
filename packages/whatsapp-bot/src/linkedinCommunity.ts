/**
 * Conector LinkedIn COMMUNITY MANAGEMENT (orgánico de la Página de empresa).
 *
 * Qué hace: (1) métricas orgánicas de la Página (seguidores, visitas, impresiones,
 * interacción, posts top) y (2) leer + responder comentarios en NUESTROS propios
 * posts de la Página. NO gestiona DMs (LinkedIn no expone API de mensajes de página)
 * ni páginas de terceros — solo las páginas que el usuario administra.
 *
 * APP SEPARADA de LinkedIn Ads. La Community Management API sale EN GRIS si la misma
 * app ya lleva la Advertising API, así que es una app distinta ("LeadMatch Insights").
 * Por eso todo vive en un namespace propio, aislado del conector de Ads:
 *   Credenciales app (GLOBAL, del stack):  linkedin.cmClientId / linkedin.cmClientSecret
 *                                          (env fallback LINKEDIN_CM_CLIENT_ID / _SECRET)
 *   Token OAuth (per-WS, cifrado):         linkedin.cm.accessToken / .refreshToken / .tokenExpiry
 *   Páginas (per-WS, cifrado):             linkedin.cm.orgs (JSON) / linkedin.cm.orgId (activa)
 *
 * Reutiliza el cliente HTTP versionado liGet/liPost (linkedinAdsGraph.ts): misma base
 * api.linkedin.com/rest, mismo header LinkedIn-Version (env LINKEDIN_API_VERSION), mismo
 * contrato {ok,data,error,status} que nunca lanza. NO toca el token de Ads (r_ads).
 *
 * NOTA: la Community Management API es versionada (Rest.li 2.0). El formato exacto de
 * algunos campos/URNs puede requerir ajuste fino contra la versión aprobada por el owner;
 * todo degrada con elegancia (configured:false / warnings[]) y jamás lanza hacia el panel.
 */
import { get, set } from "./settings.js";
import { liGet, liPost } from "./linkedinAdsGraph.js";
import { saveMetricSnapshot, getSnapshotSeries } from "./snapshots.js";
import { currentWorkspaceId } from "./workspace.js";
import { enlacesDeTexto, tokenDeEnlaceCorto, redirectUrl } from "./links.js";
import { esWebConPixel } from "./web-analytics.js";

// ============================ Credenciales + OAuth ============================

/** Scopes de Community Management. La app "LeadMatch Insights" debe tener añadido el
 *  producto "Community Management API" Y estos scopes habilitados en OAuth 2.0 scopes.
 *  Configurable por env LINKEDIN_CM_SCOPES (separados por espacio/coma) para poder
 *  ajustarlos SIN redeploy si LinkedIn rechaza alguno (unauthorized_scope_error).
 *  Default = solo lectura de admin (analítica) + social (leer/responder comentarios):
 *    r_organization_social  → leer posts/comentarios/reacciones de la Página
 *    w_organization_social  → comentar/responder como la Página
 *    r_organization_admin   → analítica de Página (page/share/follower statistics)
 *  (rw_organization_admin da también ESCRITURA de la página; no lo necesitamos y con
 *   frecuencia no está autorizado en Development Tier → fuera del default.) */
export const LINKEDIN_CM_SCOPES = (
  process.env.LINKEDIN_CM_SCOPES ||
  "r_organization_social w_organization_social rw_organization_admin r_organization_social_feed w_organization_social_feed"
)
  .split(/[\s,]+/)
  .filter(Boolean);

/** Credenciales de la app CM del stack (una para todos los workspaces). Separadas de Ads. */
export function linkedinCmCreds(): { clientId: string; clientSecret: string } {
  return {
    clientId: get("linkedin.cmClientId") || process.env.LINKEDIN_CM_CLIENT_ID || "",
    clientSecret: get("linkedin.cmClientSecret") || process.env.LINKEDIN_CM_CLIENT_SECRET || "",
  };
}

/** ¿Hay app OAuth de Community Management configurada (paso único del owner)? */
export function linkedinCmConfigured(): boolean {
  const { clientId, clientSecret } = linkedinCmCreds();
  return !!clientId && !!clientSecret;
}

/** ¿Este workspace tiene una conexión CM activa (token + Página elegida)? */
export function linkedinCmConnected(): boolean {
  return !!get("linkedin.cm.accessToken") && (!!get("linkedin.cm.orgId") || linkedinCmOrgsList().length > 0);
}

export function linkedinCmAuthUrl(redirectUri: string, state: string): string {
  const { clientId } = linkedinCmCreds();
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: LINKEDIN_CM_SCOPES.join(" "),
    state,
  });
  return "https://www.linkedin.com/oauth/v2/authorization?" + p.toString();
}

/** Página de empresa administrada por el usuario autenticado. */
export interface LinkedInOrgEntry {
  orgId: string;       // id numérico (sin urn)
  name: string;
  vanityName?: string;
  addedAt?: number;
}

/** Lista de Páginas conectadas del workspace (per-WS). */
export function linkedinCmOrgsList(): LinkedInOrgEntry[] {
  const raw = get("linkedin.cm.orgs");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((o: any): LinkedInOrgEntry | null => {
        const id = String(o?.orgId || o?.id || "").trim();
        if (!id) return null;
        return {
          orgId: id,
          name: String(o?.name || id),
          vanityName: o?.vanityName ? String(o.vanityName) : undefined,
          addedAt: typeof o?.addedAt === "number" ? o.addedAt : undefined,
        };
      })
      .filter((x): x is LinkedInOrgEntry => x !== null);
  } catch {
    return [];
  }
}

/** Página activa: linkedin.cm.orgId → primera de la lista. */
function activeOrgId(): string {
  const cur = get("linkedin.cm.orgId");
  if (cur) return cur;
  const list = linkedinCmOrgsList();
  return list.length ? list[0].orgId : "";
}

/**
 * Access token fresco para el workspace activo. Refresca proactivamente si caduca en
 * <60s. LinkedIn emite access ~60 días; el refresh token (si la app lo entrega) dura
 * ~1 año. Si no hay refresh disponible, devuelve el token vigente (que puede seguir
 * siendo válido hasta ~60 días) — la reconexión manual la avisa el banner del panel.
 */
export async function linkedinCmFreshToken(): Promise<string> {
  const at = get("linkedin.cm.accessToken");
  const exp = Number(get("linkedin.cm.tokenExpiry") || 0);
  if (at && Date.now() < exp - 60000) return at;
  const rt = get("linkedin.cm.refreshToken");
  const { clientId, clientSecret } = linkedinCmCreds();
  if (!rt || !clientId || !clientSecret) return at || "";
  try {
    const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: rt,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const d: Record<string, unknown> = await res.json().catch(() => ({}));
    if (res.ok && d.access_token) {
      const newAt = String(d.access_token);
      await set("linkedin.cm.accessToken", newAt);
      await set("linkedin.cm.tokenExpiry", String(Date.now() + (Number(d.expires_in) || 5184000) * 1000));
      if (d.refresh_token) await set("linkedin.cm.refreshToken", String(d.refresh_token));
      return newAt;
    }
  } catch {
    /* best-effort: si el refresh falla devolvemos el token viejo (puede seguir válido) */
  }
  return at || "";
}

/** URN de organización a partir del id numérico. */
function orgUrn(orgId: string): string {
  return `urn:li:organization:${orgId}`;
}
function orgIdFromUrn(urn: string): string {
  const m = String(urn || "").match(/organization:(\d+)/);
  return m ? m[1] : "";
}

/**
 * Descubre las Páginas que el usuario administra (rol ADMINISTRATOR, estado APPROVED)
 * vía organizationAcls, y resuelve el nombre de cada una. Best-effort, N+1 acotado.
 */
async function discoverOrgs(token: string): Promise<LinkedInOrgEntry[]> {
  const acls = await liGet<any>("organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED", { token });
  if (!acls.ok) return [];
  const ids = new Set<string>();
  for (const e of (acls.data?.elements ?? [])) {
    // El campo es `organization` (urn:li:organization:ID) en la Community Management
    // API versionada; se dejan alias por si otra versión usa `organizationalTarget`.
    const id = orgIdFromUrn(String(e?.organization || e?.organizationalTarget || ""));
    if (id) ids.add(id);
  }
  const out: LinkedInOrgEntry[] = [];
  let i = 0;
  for (const id of ids) {
    if (i++ >= 20) break;
    const info = await liGet<any>(`organizations/${encodeURIComponent(id)}`, { token });
    const name = info.ok ? String(info.data?.localizedName || info.data?.name?.localized?.en_US || id) : id;
    const vanity = info.ok ? String(info.data?.vanityName || "") : "";
    out.push({ orgId: id, name, vanityName: vanity || undefined, addedAt: Date.now() });
  }
  return out;
}

/** Intercambia el code por tokens, persiste, y descubre Páginas. Espejo de linkedinExchangeCode. */
export async function linkedinCmExchangeCode(code: string, redirectUri: string): Promise<{ ok: boolean; error?: string; orgsFound?: number }> {
  const { clientId, clientSecret } = linkedinCmCreds();
  if (!clientId || !clientSecret) return { ok: false, error: "Falta la LinkedIn App de Community Management (linkedin.cmClientId / linkedin.cmClientSecret)." };
  let d: Record<string, unknown> = {};
  try {
    const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(12000),
    });
    d = await res.json().catch(() => ({}));
    if (!res.ok || !d.access_token) return { ok: false, error: String(d.error_description || d.error || "token exchange falló") };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const accessToken = String(d.access_token);
  try {
    await set("linkedin.cm.accessToken", accessToken);
    await set("linkedin.cm.tokenExpiry", String(Date.now() + (Number(d.expires_in) || 5184000) * 1000));
    if (d.refresh_token) await set("linkedin.cm.refreshToken", String(d.refresh_token));
    let orgs: LinkedInOrgEntry[] = [];
    try { orgs = await discoverOrgs(accessToken); } catch { orgs = []; }
    if (orgs.length) {
      await set("linkedin.cm.orgs", JSON.stringify(orgs));
      if (!get("linkedin.cm.orgId")) await set("linkedin.cm.orgId", orgs[0].orgId);
    }
    return { ok: true, orgsFound: orgs.length };
  } catch (e) {
    return { ok: false, error: `No se pudo guardar la conexión: ${(e as Error).message}` };
  }
}

/** Fija la Página activa (debe estar en la lista descubierta del workspace). */
export async function linkedinCmSelectOrg(orgId: string): Promise<boolean> {
  const id = String(orgId || "").trim();
  if (!id) return false;
  if (!linkedinCmOrgsList().some((o) => o.orgId === id)) return false;
  await set("linkedin.cm.orgId", id);
  return true;
}

/** Desconecta Community Management del workspace (borra token + Páginas). No toca Ads. */
export async function linkedinCmDisconnect(): Promise<void> {
  for (const k of ["linkedin.cm.accessToken", "linkedin.cm.refreshToken", "linkedin.cm.tokenExpiry", "linkedin.cm.orgId", "linkedin.cm.orgs"]) {
    await set(k, "");
  }
}

// ============================ Analítica orgánica ============================

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface LiDailyPoint {
  date: string;   // YYYY-MM-DD
  value: number;
}

export interface LiTopPost {
  urn: string;
  text: string;
  title: string;
  link: string;
  thumb: string;   // URL de la miniatura (media.licdn.com) o ""
  createdAt: number;
  impressions: number;
  clicks: number;
  likes: number;
  comments: number;
  shares: number;
  engagementRate: number | null;
  /** PORTADA-LI-1: fecha de publicación, si es anuncio (DSC) y si LinkedIn dio sus cifras. */
  publishedAt?: number;
  dsc?: boolean;
  statsOk?: boolean;
  /** CLICS-LI-1 (MET-LI-05): la primera dirección web del texto COMPLETO (text va recortado);
   *  adónde lleva de verdad (un enlace corto de este panel, por su destino; "" = a ninguna web)
   *  y si esa web tiene el píxel del negocio. Los dos últimos los pone liAdondeLleva. */
  textLink?: string;
  linkTo?: string;
  linkPixel?: boolean;
  /** PUBLICACIONES-LI-1 (MET-LI-02): formato de la pieza (liFormatoDe), personas distintas que la
   *  vieron (uniqueImpressionsCount; null si LinkedIn no lo da para esa publicación) y en qué estado
   *  llegaron sus cifras (liEstadoCifras). statsOk se queda como estaba: «LinkedIn dio su fila». */
  format?: string;
  reach?: number | null;
  statsState?: LiEstadoCifras;
  /** DESTACADA-LI-1 (MET-LI-03): es la publicación fijada arriba en la Página (pinnedPost de la
   *  Página). Si no está entre las 10 últimas se añade igualmente, para poder enseñarla. */
  pinned?: boolean;
}

/** PUBLICACIONES-LI-1 (MET-LI-02) · El formato de una publicación de la Posts API, por su content. */
export function liFormatoDe(p: any): string {
  if (p?.reshareContext) return "reshare";
  const c = p?.content || {};
  if (c.article) return "article";
  if (c.multiImage) return "multiImage";
  if (c.poll) return "poll";
  if (c.carousel) return "carousel";
  if (c.celebration) return "celebration";
  const m = String(c.media?.id || "");
  if (m.startsWith("urn:li:video:")) return "video";
  if (m.startsWith("urn:li:document:")) return "document";
  if (m.startsWith("urn:li:image:")) return "image";
  return "text";
}

/** PUBLICACIONES-LI-1 (MET-LI-02) · En qué estado llegan las cifras de UNA publicación.
 *  Según la documentación de organizationalEntityShareStatistics: lo que no trae fila «puede
 *  asumirse con todas sus cifras a 0», y sólo hay datos de los últimos 12 meses. Así un cero
 *  real (ok sin fila) no se confunde con una petición fallida ni con una publicación antigua.
 *  ok = LinkedIn dio su fila · cero = respondió sin ella · antigua = sin fila y con más de
 *  12 meses · error = la petición falló. */
export type LiEstadoCifras = "ok" | "cero" | "antigua" | "error";
export function liEstadoCifras(peticionOk: boolean, conFila: boolean, publicada: number, ahora = Date.now()): LiEstadoCifras {
  if (!peticionOk) return "error";
  if (conFila) return "ok";
  return publicada > 0 && ahora - publicada > 365 * 86400000 ? "antigua" : "cero";
}

/** PUBLICACIONES-LI-1 (MET-LI-02) · Las publicaciones creadas como urn:li:ugcPost se piden con
 *  ugcPosts=List(...), no con shares=List(...): mezclarlas hacía fallar la petición. */
export function liParamCifras(urn: string): string {
  return (String(urn).startsWith("urn:li:ugcPost:") ? "ugcPosts" : "shares") + "=List(" + encodeURIComponent(String(urn)) + ")";
}

/** CLICS-LI-1 (MET-LI-05) · La primera dirección web del texto completo de una publicación.
 *  LinkedIn devuelve el texto en su «little text format», que escapa con barra invertida
 *  caracteres como _ ( ) #: sin quitarla, «utm\_source» partiría la dirección. */
export function liEnlaceDelTexto(commentary: string): string {
  const limpio = String(commentary || "").replace(/\\([\\|{}@[\]()<>#*_~])/g, "$1");
  return enlacesDeTexto(limpio, 1)[0] || "";
}

/** CLICS-LI-1 (MET-LI-05) · Adónde lleva cada publicación (el artículo enlazado o la primera
 *  dirección de su texto; un enlace corto de este panel, por su destino) y si esa web tiene el
 *  píxel del negocio. LinkedIn no da los clics hacia fuera de lo publicado sin pagar —su «clics»
 *  incluye el contenido, el nombre y el logotipo—, así que sin el píxel en el destino un cero en
 *  las visitas medidas no es un cero en los clics hacia la web. */
export async function liAdondeLleva(posts: LiTopPost[], tenant: string): Promise<LiTopPost[]> {
  const pixel = new Map<string, Promise<boolean>>();
  return Promise.all(posts.map(async (p) => {
    let u = String(p.link || p.textLink || "");
    if (!/^https?:\/\//i.test(u)) return { ...p, linkTo: "", linkPixel: false };
    const tok = tokenDeEnlaceCorto(u);
    if (tok) {
      const r = await redirectUrl(tok).catch(() => null);
      if (r && r.tenant_id === tenant && /^https?:\/\//i.test(r.url)) u = r.url;
    }
    let host = "";
    try { host = new URL(u).hostname.toLowerCase(); } catch { /* dirección rota: sin píxel */ }
    if (host && !pixel.has(host)) pixel.set(host, esWebConPixel(tenant, u).catch(() => false));
    return { ...p, linkTo: u, linkPixel: host ? await pixel.get(host)! : false };
  }));
}

/** Resuelve un urn:li:image:... a su URL descargable (media.licdn.com). "" si falla. */
const _imgCache = new Map<string, { url: string; ts: number }>();
async function resolveImageUrl(urn: string, token: string): Promise<string> {
  if (!urn || !urn.startsWith("urn:li:image:")) return "";
  const c = _imgCache.get(urn);
  if (c && Date.now() - c.ts < 6 * 3600 * 1000) return c.url; // downloadUrl caduca ~7 días
  try {
    const r = await liGet<any>(`images/${encodeURIComponent(urn)}`, { token });
    const url = r.ok ? String(r.data?.downloadUrl || "") : "";
    if (url) _imgCache.set(urn, { url, ts: Date.now() });
    return url;
  } catch { return ""; }
}

/** Logo de una Página (media.licdn.com) para la miniatura de las tarjetas de flujos. Caché 6 h
 *  por Página (también el fallo, 10 min); "" si no hay token o LinkedIn no lo da. */
const _logoCache = new Map<string, { url: string; ts: number }>();
export async function linkedinCmOrgLogo(orgId: string): Promise<string> {
  const c = _logoCache.get(orgId);
  if (c && Date.now() - c.ts < (c.url ? 6 * 3600 * 1000 : 600_000)) return c.url;
  let url = "";
  try {
    const token = await linkedinCmFreshToken();
    if (token) {
      const rl = await liGet<any>(`organizations/${orgId}`, { token });
      const lv2 = (rl.data?.logoV2 || {}) as { cropped?: string; original?: string };
      const id = String(lv2.cropped || lv2.original || "").replace(/^urn:li:(?:digitalmediaAsset|image):/, "");
      if (id) url = await resolveImageUrl("urn:li:image:" + id, token);
    }
  } catch { url = ""; }
  _logoCache.set(orgId, { url, ts: Date.now() });
  return url;
}

export interface LinkedInPageAnalytics {
  configured: boolean;
  note?: string;
  org?: {
    id: string; name: string; vanityName?: string; followers: number | null; logoUrl?: string;
    /** DESTACADA-LI-1 (MET-LI-03): publicación fijada arriba en la Página, según LinkedIn. */
    pinned?: "ok" | "none" | "error"; pinnedUrn?: string;
  };
  rangeDays: number;
  totals: {
    impressions: number | null;
    uniqueImpressions: number | null;
    clicks: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    engagementRate: number | null;
    pageViews: number | null;
    followerGain: number | null;
    /** PORTADA-LI-1: algún neto (me gusta, comentarios…) salió negativo en el rango. */
    netNegative?: boolean;
  };
  series: {
    impressions: LiDailyPoint[];
    engagement: LiDailyPoint[];
    pageViews: LiDailyPoint[];
  };
  // Serie PROPIA de seguidores (snapshots diarios del panel) — LinkedIn no da
  // histórico de totales, así que lo construimos nosotros (patrón FB).
  own?: { followersSeries: LiDailyPoint[] };
  topPosts: LiTopPost[];
  /** PORTADA-LI-1: qué se publicó en el rango, contado sobre las últimas publicaciones. */
  postsInRange?: { checked: number; organic: number; ads: number; lastOrganicAt: number; lastAdAt: number; capped: boolean };
  warnings: string[];
  needsReconnect: boolean;
}

/** timeIntervals=(timeRange:(start:ms,end:ms),timeGranularityType:DAY) — sin encodear la estructura. */
function timeIntervals(startMs: number, endMs: number): string {
  return `timeIntervals=(timeRange:(start:${startMs},end:${endMs}),timeGranularityType:DAY)`;
}

/** ms → YYYY-MM-DD (UTC). */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Métricas orgánicas de la Página en los últimos `days` días. Mismo espíritu que
 * getFbPageMetrics: cada fuente se pide por separado con su propio try/catch, los
 * fallos blandos van a warnings[] y jamás tumban el resto. Todos los KPIs son
 * number|null (never-fake-metrics): si una llamada falla, el panel muestra "—".
 */
export async function getLinkedInPageAnalytics(orgIdIn?: string, days = 28): Promise<LinkedInPageAnalytics> {
  const rangeDays = Math.max(1, Math.min(365, Math.floor(days) || 28));
  const empty: LinkedInPageAnalytics = {
    configured: false,
    rangeDays,
    totals: { impressions: null, uniqueImpressions: null, clicks: null, likes: null, comments: null, shares: null, engagementRate: null, pageViews: null, followerGain: null },
    series: { impressions: [], engagement: [], pageViews: [] },
    topPosts: [],
    warnings: [],
    needsReconnect: false,
  };

  const orgId = (orgIdIn && orgIdIn.trim()) || activeOrgId();
  if (!orgId) return { ...empty, note: "Conecta tu Página de LinkedIn con el botón «Conectar Página de LinkedIn»." };
  // Guard multi-tenant: la Página debe pertenecer a este workspace.
  if (!linkedinCmOrgsList().some((o) => o.orgId === orgId)) {
    return { ...empty, note: "Esa Página no pertenece a este workspace." };
  }
  const token = await linkedinCmFreshToken();
  if (!token) return { ...empty, note: "Falta el token de LinkedIn (reconecta la Página en Conexiones).", needsReconnect: true };

  const urn = orgUrn(orgId);
  const encUrn = encodeURIComponent(urn);
  const end = Date.now();
  const start = end - rangeDays * 86400000;
  const warnings: string[] = [];
  let needsReconnect = false;
  const flagAuth = (status?: number) => { if (status === 401 || status === 403) needsReconnect = true; };

  const orgEntry = linkedinCmOrgsList().find((o) => o.orgId === orgId);
  const out: LinkedInPageAnalytics = { ...empty, configured: true, org: { id: orgId, name: orgEntry?.name || orgId, vanityName: orgEntry?.vanityName, followers: null } };

  // 0) Logo de la Página → foto de perfil en Métricas (antes SIEMPRE salía la inicial:
  // ni el backend lo traía ni el frontend lo intentaba). logoV2.cropped/original es un
  // urn:li:image:… que resolveImageUrl (el mismo de las miniaturas de posts, ya probado)
  // convierte en URL de media.licdn.com. Best-effort: si falla, se muestra la inicial.
  try {
    const rl = await liGet<any>(`organizations/${orgId}`, { token });
    // DESTACADA-LI-1 (MET-LI-03): la publicación fijada arriba en la Página (campo sólo para
    // administradores). Es lo único que LinkedIn dice de sus destacados: no dice desde dónde la abrió
    // cada persona. Si no responde, no se sabe y no se deduce. LinkedIn omite los campos vacíos y
    // también los de administrador cuando no deja verlos: «ninguna» sólo si la respuesta trae campos
    // de administrador (versionTag) y no trae pinnedPost; si no, no se sabe.
    const rd = rl.ok && rl.data && typeof rl.data === "object" ? rl.data : null;
    const pin = typeof rd?.pinnedPost === "string" ? rd.pinnedPost.trim() : "";
    if (/^urn:li:/.test(pin)) { out.org!.pinned = "ok"; out.org!.pinnedUrn = pin; }
    else if (rd && rd.pinnedPost == null && rd.versionTag != null) out.org!.pinned = "none";
    else out.org!.pinned = "error";
    const lv2 = (rl.data?.logoV2 || {}) as { cropped?: string; original?: string };
    const asset = String(lv2.cropped || lv2.original || "");
    // logoV2 llega como urn:li:image: (nuevo) o urn:li:digitalmediaAsset: (viejo — es el caso
    // de esta Página). El ID subyacente es el MISMO, así que lo resolvemos con el images API
    // usando urn:li:image:{id} (resolveImageUrl → media.licdn.com, el mismo mecanismo de las
    // miniaturas de posts). Confirmado en vivo que devuelve la URL del logo.
    const id = asset.replace(/^urn:li:(?:digitalmediaAsset|image):/, "");
    if (id) {
      const url = await resolveImageUrl("urn:li:image:" + id, token);
      if (url) out.org!.logoUrl = url;
    }
    if (!rl.ok) flagAuth(rl.status);
  } catch { /* best-effort: sin logo se muestra la inicial */ if (!out.org!.pinned) out.org!.pinned = "error"; }

  // 1) Seguidores totales (networkSizes, lifetime).
  try {
    const r = await liGet<any>(`networkSizes/${encUrn}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, { token });
    if (r.ok) out.org!.followers = num(r.data?.firstDegreeSize);
    else { warnings.push(`seguidores: ${r.error}`); flagAuth(r.status); }
  } catch (e) { warnings.push(`seguidores: ${(e as Error).message}`); }

  // 1-bis) Serie PROPIA de seguidores (snapshot diario idempotente, patrón FB):
  // LinkedIn solo da la ganancia del rango, nunca el histórico de totales. OJO
  // tenant explícito — sin él las series de todos los workspaces se mezclarían
  // bajo "default" (aviso del consejo).
  try {
    const tenant = currentWorkspaceId() || "default";
    if (out.org?.followers != null && out.org.followers > 0) {
      await saveMetricSnapshot(`li_followers_${orgId}`, out.org.followers, tenant);
    }
    out.own = { followersSeries: await getSnapshotSeries(`li_followers_${orgId}`, Math.max(rangeDays, 90), tenant) };
  } catch { /* serie propia opcional */ }

  // 2) Ganancia de seguidores en el rango (organizationalEntityFollowerStatistics).
  try {
    const r = await liGet<any>(`organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${encUrn}&${timeIntervals(start, end)}`, { token });
    if (r.ok) {
      let gain = 0;
      for (const el of (r.data?.elements ?? [])) {
        const g = el?.followerGains || {};
        gain += num(g.organicFollowerGain) + num(g.paidFollowerGain);
      }
      out.totals.followerGain = gain;
    } else { warnings.push(`ganancia seguidores: ${r.error}`); flagAuth(r.status); }
  } catch (e) { warnings.push(`ganancia seguidores: ${(e as Error).message}`); }

  // 3) Estadísticas de shares/posts (impresiones, clics, interacción) + serie diaria.
  try {
    const r = await liGet<any>(`organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encUrn}&${timeIntervals(start, end)}`, { token });
    if (r.ok) {
      let imp = 0, uniq = 0, clk = 0, lk = 0, cm = 0, sh = 0, engSum = 0, engN = 0;
      const impSeries: LiDailyPoint[] = [];
      const engSeries: LiDailyPoint[] = [];
      for (const el of (r.data?.elements ?? [])) {
        const s = el?.totalShareStatistics || {};
        const dImp = num(s.impressionCount);
        imp += dImp; uniq += num(s.uniqueImpressionsCount); clk += num(s.clickCount);
        lk += num(s.likeCount); cm += num(s.commentCount); sh += num(s.shareCount);
        if (s.engagement != null) { engSum += num(s.engagement); engN++; }
        const t = num(el?.timeRange?.start);
        if (t) {
          impSeries.push({ date: dayKey(t), value: dImp });
          if (num(s.engagement) >= 0) engSeries.push({ date: dayKey(t), value: +(num(s.engagement) * 100).toFixed(2) });
        }
      }
      out.totals.impressions = imp;
      out.totals.uniqueImpressions = uniq;
      out.totals.clicks = clk;
      out.totals.likes = lk;
      out.totals.comments = cm;
      out.totals.shares = sh;
      // COUNCIL-FIX: la media de tasas DIARIAS diluía el engagement real — los días
      // con 0 impresiones (ratio 0) entraban en la media (prod: 10,95% publicado vs
      // 26,32% real del rango, 2,4× infravalorado). Tasa AGREGADA del rango:
      // interacciones totales ÷ impresiones totales. La serie diaria sigue intacta.
      // PORTADA-LI-1: con netos negativos (me gusta retirados) la tasa sale negativa: sin tasa.
      const neg = lk < 0 || cm < 0 || sh < 0 || clk < 0;
      if (neg) out.totals.netNegative = true;
      out.totals.engagementRate = imp && !neg ? +(((lk + cm + sh + clk) / imp) * 100).toFixed(2) : null;
      void engSum; void engN;
      out.series.impressions = impSeries.sort((a, b) => a.date.localeCompare(b.date));
      out.series.engagement = engSeries.sort((a, b) => a.date.localeCompare(b.date));
    } else { warnings.push(`estadísticas de posts: ${r.error}`); flagAuth(r.status); }
  } catch (e) { warnings.push(`estadísticas de posts: ${(e as Error).message}`); }

  // 4) Visitas a la Página (organizationPageStatistics) + serie diaria.
  try {
    const r = await liGet<any>(`organizationPageStatistics?q=organization&organization=${encUrn}&${timeIntervals(start, end)}`, { token });
    if (r.ok) {
      let views = 0;
      const viewSeries: LiDailyPoint[] = [];
      for (const el of (r.data?.elements ?? [])) {
        const v = el?.totalPageStatistics?.views?.allPageViews?.pageViews;
        const dv = num(v);
        views += dv;
        const t = num(el?.timeRange?.start);
        if (t) viewSeries.push({ date: dayKey(t), value: dv });
      }
      out.totals.pageViews = views;
      out.series.pageViews = viewSeries.sort((a, b) => a.date.localeCompare(b.date));
    } else { warnings.push(`visitas de página: ${r.error}`); flagAuth(r.status); }
  } catch (e) { warnings.push(`visitas de página: ${(e as Error).message}`); }

  // 5) Posts top: lista de posts de la Página + estadísticas por post (acotado).
  try {
    const posts = await liGet<any>(`posts?q=author&author=${encUrn}&count=10&sortBy=LAST_MODIFIED`, { token });
    if (posts.ok) {
      const els = (posts.data?.elements ?? []).filter((p: any) => p?.id).slice(0, 10);
      // PORTADA-LI-1: qué se publicó en el rango (sin pagar / anuncios) sobre estas publicaciones.
      const liWhen = (p: any) => num(p?.publishedAt || p?.createdAt || p?.created?.time);
      const liIsAd = (p: any) => p?.adContext?.isDsc === true || p?.distribution?.feedDistribution === "NONE";
      const pr = { checked: els.length, organic: 0, ads: 0, lastOrganicAt: 0, lastAdAt: 0, capped: false };
      for (const p of els) {
        if (p?.lifecycleState && p.lifecycleState !== "PUBLISHED") continue;
        const w = liWhen(p);
        if (liIsAd(p)) { if (w > pr.lastAdAt) pr.lastAdAt = w; if (w >= start) pr.ads++; }
        else { if (w > pr.lastOrganicAt) pr.lastOrganicAt = w; if (w >= start) pr.organic++; }
      }
      pr.capped = els.length >= 10 && els.every((p: any) => num(p?.lastModifiedAt) >= start);
      out.postsInRange = pr;
      // DESTACADA-LI-1: la fijada, aunque no esté entre las 10 últimas.
      const pinUrn = out.org?.pinnedUrn || "";
      const lista: any[] = els.slice();
      let pinEl: any = lista.find((p: any) => String(p?.id) === pinUrn) || null;
      if (pinUrn && !pinEl) {
        const pp = await liGet<any>(`posts/${encodeURIComponent(pinUrn)}`, { token }).catch(() => ({ ok: false } as any));
        if (pp.ok && pp.data?.id) { pinEl = pp.data; lista.push(pinEl); }
      }
      // Cada post en paralelo: estadísticas + resolución de miniatura del artículo.
      const top: LiTopPost[] = await Promise.all(lista.map(async (p: any): Promise<LiTopPost> => {
        const purn = String(p?.id || "");
        const art = p?.content?.article || {};
        const text = String(p?.commentary || art.title || p?.specificContent?.["com.linkedin.ugc.ShareContent"]?.shareCommentary?.text || "").slice(0, 280);
        const tp: LiTopPost = {
          urn: purn, text, title: String(art.title || ""), link: String(art.source || ""), thumb: "",
          createdAt: num(p?.createdAt || p?.created?.time), impressions: 0, clicks: 0, likes: 0, comments: 0, shares: 0, engagementRate: null,
          publishedAt: liWhen(p), dsc: liIsAd(p), format: liFormatoDe(p),
          textLink: liEnlaceDelTexto(String(p?.commentary || p?.specificContent?.["com.linkedin.ugc.ShareContent"]?.shareCommentary?.text || "")),
        };
        if (pinEl && p === pinEl) tp.pinned = true;
        const [st, thumb] = await Promise.all([
          liGet<any>(`organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encUrn}&${liParamCifras(purn)}`, { token }).catch(() => ({ ok: false } as any)),
          // PUBLICACIONES-LI-1: también la imagen de una publicación de imagen (o la primera de varias).
          resolveImageUrl(String(art.thumbnail || p?.content?.media?.id || p?.content?.multiImage?.images?.[0]?.id || ""), token),
        ]);
        const s = st.ok ? (st.data?.elements?.[0]?.totalShareStatistics || {}) : {};
        tp.statsOk = !!st.ok && !!st.data?.elements?.[0];
        tp.statsState = liEstadoCifras(!!st.ok, !!tp.statsOk, tp.publishedAt || tp.createdAt);
        tp.reach = tp.statsOk ? (s.uniqueImpressionsCount != null ? num(s.uniqueImpressionsCount) : null) : (tp.statsState === "cero" ? 0 : null);
        tp.impressions = num(s.impressionCount);
        tp.clicks = num(s.clickCount);
        tp.likes = num(s.likeCount);
        tp.comments = num(s.commentCount);
        tp.shares = num(s.shareCount);
        tp.engagementRate = s.engagement != null ? +(num(s.engagement) * 100).toFixed(2) : (tp.impressions ? +(((tp.likes + tp.comments + tp.shares + tp.clicks) / tp.impressions) * 100).toFixed(2) : null);
        tp.thumb = thumb;
        return tp;
      }));
      out.topPosts = top.sort((a, b) => b.impressions - a.impressions);
    } else { warnings.push(`posts: ${posts.error}`); flagAuth(posts.status); }
  } catch (e) { warnings.push(`posts: ${(e as Error).message}`); }

  out.warnings = warnings;
  out.needsReconnect = needsReconnect;
  return out;
}

// ============================ Audiencia / Demografía ============================

const SENIORITY_ES: Record<string, string> = {
  "1": "Sin remunerar", "2": "En formación", "3": "Junior", "4": "Senior", "5": "Manager",
  "6": "Director/a", "7": "VP", "8": "Alta dirección", "9": "Socio/a", "10": "Propietario/a",
};
const FUNCTION_ES: Record<string, string> = {
  "1": "Contabilidad", "2": "Administración", "3": "Arte y diseño", "4": "Desarrollo de negocio",
  "5": "Servicios sociales", "6": "Consultoría", "7": "Educación", "8": "Ingeniería",
  "9": "Emprendimiento", "10": "Finanzas", "11": "Salud", "12": "RR. HH.", "13": "Tecnología (IT)",
  "14": "Legal", "15": "Marketing", "16": "Medios y comunicación", "17": "Militar y protección",
  "18": "Operaciones", "19": "Product Management", "20": "Gestión de proyectos", "21": "Compras",
  "22": "Calidad (QA)", "23": "Inmobiliario", "24": "Investigación", "25": "Ventas", "26": "Soporte",
};
const STAFF_ES: Record<string, string> = {
  SIZE_1: "1 empleado", SIZE_2_TO_10: "2-10", SIZE_11_TO_50: "11-50", SIZE_51_TO_200: "51-200",
  SIZE_201_TO_500: "201-500", SIZE_501_TO_1000: "501-1.000", SIZE_1001_TO_5000: "1.001-5.000",
  SIZE_5001_TO_10000: "5.001-10.000", SIZE_10001_OR_MORE: "10.001+",
};
const PAGEVIEW_ES: Array<[string, string]> = [
  ["overviewPageViews", "Inicio"], ["aboutPageViews", "Información"], ["peoplePageViews", "Personas"],
  ["jobsPageViews", "Empleos"], ["careersPageViews", "Carreras"], ["lifeAtPageViews", "Vida en la empresa"],
  ["productsPageViews", "Productos"], ["insightsPageViews", "Estadísticas"],
];

export interface LiSeg { label: string; count: number; }
export interface LinkedInAudience {
  configured: boolean;
  /** AUDIENCIA-LI-1 (MET-LI-06) · true sólo si LinkedIn respondió a esa lectura (seguidores / visitas): así el panel
   *  distingue «LinkedIn aún no da el perfil» de «no se pudo leer». Ausente = respuesta antigua o sin conexión. */
  followersOk?: boolean;
  viewsOk?: boolean;
  demographics: { seniority: LiSeg[]; jobFunction: LiSeg[]; companySize: LiSeg[]; country: LiSeg[]; industry: LiSeg[] };
  pageViews: {
    byType: LiSeg[]; byDevice: { desktop: number; mobile: number };
    /** AUDIENCIA-LI-1 (MET-LI-06) · Perfil de quien visita la Página (lifetime, en VISITAS, no personas). */
    byProfile?: { seniority: LiSeg[]; jobFunction: LiSeg[]; companySize: LiSeg[]; country: LiSeg[]; industry: LiSeg[] };
  };
  growth: LiDailyPoint[];
}

function segCount(e: any): number {
  const f = e?.followerCounts || {};
  return num(f.organicFollowerCount) + num(f.paidFollowerCount);
}
function idOf(urn: string): string {
  const m = String(urn || "").match(/:(\d+)$/);
  return m ? m[1] : "";
}
function topSegs(arr: any[], field: string, resolve: (id: string) => string, limit = 8): LiSeg[] {
  return (arr || [])
    .map((e: any) => ({ label: resolve(idOf(String(e?.[field] || ""))), count: segCount(e) }))
    .filter((s) => s.count > 0 && !!s.label)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
/** Resuelve N ids a nombres (GET individual, best-effort en paralelo). Cachea PARA
 *  SIEMPRE (nombres de país/sector nunca cambian) → tras la 1ª vez, 0 llamadas. */
const _nameCache = new Map<string, string>();
async function resolveNames(ids: string[], ns: string, path: (id: string) => string, extract: (d: any) => string, token: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const miss: string[] = [];
  for (const id of ids) {
    const cached = _nameCache.get(ns + ":" + id);
    if (cached) out[id] = cached; else miss.push(id);
  }
  await Promise.all(miss.map(async (id) => {
    try {
      const r = await liGet<any>(path(id), { token });
      if (r.ok) { const nm = extract(r.data) || ""; if (nm) { _nameCache.set(ns + ":" + id, nm); out[id] = nm; } }
    } catch { /* skip */ }
  }));
  return out;
}

/**
 * Audiencia + demografía de la Página (datos "lifetime", no dependen del rango salvo
 * el crecimiento). Etiquetas en español; país/sector se resuelven vía GET individual.
 * Todo best-effort: cualquier fallo deja esa sección vacía, nunca lanza.
 */
export async function getLinkedInAudience(orgIdIn?: string, days = 90): Promise<LinkedInAudience> {
  const empty: LinkedInAudience = {
    configured: false,
    demographics: { seniority: [], jobFunction: [], companySize: [], country: [], industry: [] },
    pageViews: { byType: [], byDevice: { desktop: 0, mobile: 0 } }, growth: [],
  };
  const orgId = (orgIdIn && orgIdIn.trim()) || activeOrgId();
  if (!orgId || !linkedinCmOrgsList().some((o) => o.orgId === orgId)) return empty;
  const token = await linkedinCmFreshToken();
  if (!token) return empty;
  const enc = encodeURIComponent(orgUrn(orgId));
  const out: LinkedInAudience = {
    configured: true, followersOk: false, viewsOk: false,
    demographics: { seniority: [], jobFunction: [], companySize: [], country: [], industry: [] },
    pageViews: { byType: [], byDevice: { desktop: 0, mobile: 0 } }, growth: [],
  };

  // 1) Demografía de seguidores (lifetime): seniority, función, tamaño, país, sector.
  try {
    const r = await liGet<any>(`organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${enc}`, { token });
    out.followersOk = !!r.ok;
    const el = r.ok ? (r.data?.elements?.[0] || {}) : {};
    out.demographics.seniority = topSegs(el.followerCountsBySeniority, "seniority", (id) => SENIORITY_ES[id] || `Nivel ${id}`);
    out.demographics.jobFunction = topSegs(el.followerCountsByFunction, "function", (id) => FUNCTION_ES[id] || `Función ${id}`);
    out.demographics.companySize = (el.followerCountsByStaffCountRange || [])
      .map((e: any) => ({ label: STAFF_ES[String(e?.staffCountRange || "")] || String(e?.staffCountRange || ""), count: segCount(e) }))
      .filter((s: LiSeg) => s.count > 0 && !!s.label).sort((a: LiSeg, b: LiSeg) => b.count - a.count).slice(0, 9);
    const topCountry = topSegs(el.followerCountsByGeoCountry, "geo", (id) => id, 6);
    const topIndustry = topSegs(el.followerCountsByIndustry, "industry", (id) => id, 6);
    const geoNames = await resolveNames(topCountry.map((s) => s.label), "geo", (id) => `geo/${id}`, (d) => String(d?.defaultLocalizedName?.value || ""), token);
    const indNames = await resolveNames(topIndustry.map((s) => s.label), "ind", (id) => `industries/${id}`, (d) => String(d?.name?.localized?.en_US || Object.values((d?.name?.localized || {}) as Record<string, string>)[0] || ""), token);
    out.demographics.country = topCountry.map((s) => ({ label: geoNames[s.label] || `País ${s.label}`, count: s.count }));
    out.demographics.industry = topIndustry.map((s) => ({ label: indNames[s.label] || `Sector ${s.label}`, count: s.count }));
  } catch { /* best-effort */ }

  // 2) Crecimiento de seguidores (serie diaria de ganancia).
  try {
    const end = Date.now();
    const start = end - Math.max(7, Math.min(365, Math.floor(days) || 90)) * 86400000;
    const r = await liGet<any>(`organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${enc}&${timeIntervals(start, end)}`, { token });
    out.growth = (r.data?.elements ?? []).map((e: any) => {
      const g = e?.followerGains || {}; const t = num(e?.timeRange?.start);
      return { date: dayKey(t), value: num(g.organicFollowerGain) + num(g.paidFollowerGain) };
    }).filter((p: LiDailyPoint) => p.date).sort((a: LiDailyPoint, b: LiDailyPoint) => a.date.localeCompare(b.date));
  } catch { /* best-effort */ }

  // 3) Desglose de visitas a la Página (lifetime): por sección + por dispositivo.
  try {
    const r = await liGet<any>(`organizationPageStatistics?q=organization&organization=${enc}`, { token });
    out.viewsOk = !!r.ok;
    const views: any = r.ok ? (r.data?.elements?.[0]?.totalPageStatistics?.views || {}) : {};
    const vv = (k: string): number => { const x = views[k]; return num(x && typeof x === "object" ? x.pageViews : x); };
    out.pageViews.byType = PAGEVIEW_ES.map(([k, label]) => ({ label, count: vv(k) })).filter((s) => s.count > 0).sort((a, b) => b.count - a.count);
    out.pageViews.byDevice = { desktop: vv("allDesktopPageViews"), mobile: vv("allMobilePageViews") };
    // AUDIENCIA-LI-1 (MET-LI-06) · La misma llamada trae el reparto de las visitas por cargo, función,
    // sector, país y tamaño de empresa de quien visita. Son visitas, no personas, y sin fechas.
    const e0: any = r.ok ? (r.data?.elements?.[0] || {}) : {};
    const pvN = (e: any): number => { const x = e?.pageStatistics?.views?.allPageViews; return num(x && typeof x === "object" ? x.pageViews : x); };
    const pvSegs = (arr: any[], campos: string[], resolve: (id: string) => string, limit = 8): LiSeg[] => (arr || [])
      .map((e: any) => { const c = campos.find((k) => e?.[k] != null); const raw = String(c ? e[c] : ""); const id = idOf(raw) || raw; return { label: id ? resolve(id) : "", count: pvN(e) }; })
      .filter((x: LiSeg) => x.count > 0 && !!x.label).sort((a: LiSeg, b: LiSeg) => b.count - a.count).slice(0, limit);
    const vCountry = pvSegs(e0.pageStatisticsByGeoCountry, ["geo"], (id) => id, 6);
    const vIndustry = pvSegs(e0.pageStatisticsByIndustryV2 || e0.pageStatisticsByIndustry, ["industryV2", "industry"], (id) => id, 6);
    const [vGeo, vInd] = await Promise.all([
      resolveNames(vCountry.map((x) => x.label), "geo", (id) => `geo/${id}`, (d) => String(d?.defaultLocalizedName?.value || ""), token),
      resolveNames(vIndustry.map((x) => x.label), "ind", (id) => `industries/${id}`, (d) => String(d?.name?.localized?.en_US || Object.values((d?.name?.localized || {}) as Record<string, string>)[0] || ""), token),
    ]);
    const prof = {
      seniority: pvSegs(e0.pageStatisticsBySeniority, ["seniority"], (id) => SENIORITY_ES[id] || `Nivel ${id}`),
      jobFunction: pvSegs(e0.pageStatisticsByFunction, ["function"], (id) => FUNCTION_ES[id] || `Función ${id}`),
      companySize: pvSegs(e0.pageStatisticsByStaffCountRange, ["staffCountRange"], (id) => STAFF_ES[id] || id, 9),
      country: vCountry.map((x) => ({ label: vGeo[x.label] || `País ${x.label}`, count: x.count })),
      industry: vIndustry.map((x) => ({ label: vInd[x.label] || `Sector ${x.label}`, count: x.count })),
    };
    if (Object.values(prof).some((a) => a.length)) out.pageViews.byProfile = prof;
  } catch { /* best-effort */ }

  return out;
}

/** AUDIENCIA-LI-1 (MET-LI-06) · ¿LinkedIn dejó sin leer seguidores o visitas? Una lectura así no se guarda en la
 *  caché de 10 minutos del panel: el siguiente refresco vuelve a preguntar en vez de repetir el fallo. */
export function audienciaIncompleta(a: LinkedInAudience): boolean {
  return !!a.configured && (a.followersOk === false || a.viewsOk === false);
}

// ============================ Comentarios (leer + responder) ============================

export interface LiComment {
  /** URN del comentario (es el parentComment al responder). */
  id: string;
  text: string;
  /** Nombre del autor si se puede resolver; si no, el urn. */
  author: string;
  /** URN del autor (persona u organización). Sirve para NO respondernos a nosotros. */
  authorUrn: string;
  /** URN del post/share dueño del comentario (el `object` al responder). */
  objectUrn: string;
  createdAt: number;
}

/**
 * Comentarios recientes en los posts de NUESTRA Página. Recorre los últimos `maxPosts`
 * posts y saca hasta `perPost` comentarios de cada uno; los aplana y ordena por fecha.
 * Best-effort: si un post no tiene socialActions o falla, se salta.
 *
 * CONFIG-LI-1 · Con `{ lanzar: true }` (lo usa el panel) un fallo de LinkedIn LANZA en vez de
 * devolver []: sin acceso, sin publicaciones, o con TODAS las lecturas de comentarios fallidas.
 * Antes el panel no distinguía «nadie ha comentado» de «LinkedIn no nos deja leer» y pintaba
 * lo segundo como lo primero. El poller llama sin opciones: para él nada cambia.
 */
/**
 * LI-CUOTA-1 · LinkedIn corta con «Resource level throttle … DAY limit (code 101)» cuando se agota la
 * cuota diaria de la API. Mientras dure no se insiste (cada intento solo gasta más y el panel se
 * quedaba en «no hay comentarios» sin decir por qué): se anota hasta la medianoche UTC.
 */
function liEsCuota(msg: string): boolean {
  return /throttle|code 101|429|rate.?limit/i.test(String(msg || ""));
}
async function liMarcarCuota(): Promise<void> {
  const d = new Date();
  const fin = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5, 0);
  await set("linkedin.cm.throttledUntil", String(fin));
}
export function linkedinCmCuotaHasta(): number {
  const t = Number(get("linkedin.cm.throttledUntil") || 0);
  return t > Date.now() ? t : 0;
}

export async function listLinkedInComments(orgIdIn?: string, maxPosts = 10, perPost = 10, opts: { lanzar?: boolean; urns?: string[] } = {}): Promise<LiComment[]> {
  const orgId = (orgIdIn && orgIdIn.trim()) || activeOrgId();
  if (!orgId) return [];
  if (linkedinCmCuotaHasta()) {
    if (opts.lanzar) throw new Error("LinkedIn ha agotado el límite diario de llamadas de la API; se reanuda a medianoche UTC (02:00 en España). Los comentarios de hoy se leerán entonces.");
    return [];
  }
  const token = await linkedinCmFreshToken();
  if (!token) {
    if (opts.lanzar) throw new Error("LinkedIn no ha dado acceso a la Página");
    console.warn("[li-comments] sin token de LinkedIn: no se pueden leer comentarios (reconecta la Página)");
    return [];
  }
  const encUrn = encodeURIComponent(orgUrn(orgId));

  // Con «urns» (los posts que un flujo escucha) no hace falta listar los posts de la Página.
  const posts = opts.urns && opts.urns.length
    ? { ok: true as const, data: { elements: opts.urns.map((id) => ({ id })) }, error: "" }
    : await liGet<any>(`posts?q=author&author=${encUrn}&count=${Math.max(1, Math.min(20, maxPosts))}&sortBy=LAST_MODIFIED`, { token });
  if (!posts.ok) {
    if (liEsCuota(posts.error || "")) await liMarcarCuota();
    if (opts.lanzar) throw new Error(posts.error || "LinkedIn no devolvió las publicaciones");
    // LI-DIAG-1 · antes el poller se quedaba mudo: si LinkedIn rechazaba la lista, «no hay comentarios».
    console.warn("[li-comments] posts?q=author falló:", String(posts.error || "").slice(0, 200));
    return [];
  }
  const out: LiComment[] = [];
  let pedidos = 0;
  let fallidos = 0;
  let ultimoError = "";
  for (const p of (posts.data?.elements ?? []).slice(0, maxPosts)) {
    const objectUrn = String(p?.id || "");
    if (!objectUrn) continue;
    // SIN sortBy · el endpoint socialActions/{urn}/comments de la REST versionada (202606)
    // rechaza `sortBy` con HTTP 400 "Invalid param" para CUALQUIER valor (CREATED, CHRONOLOGICAL,
    // RELEVANCE — verificado en vivo contra la API). Antes iba con sortBy=CREATED y fallaba en
    // CADA post → cientos de errores por tick (629 el 2026-07-23). Sin el parámetro devuelve 200.
    const c = await liGet<any>(`socialActions/${encodeURIComponent(objectUrn)}/comments?count=${Math.max(1, Math.min(50, perPost))}`, { token });
    pedidos++;
    if (!c.ok) {
      fallidos++;
      ultimoError = c.error || "";
      if (liEsCuota(ultimoError)) { await liMarcarCuota(); break; }
      console.warn(`[li-comments] comentarios de ${objectUrn} no legibles:`, String(c.error || "").slice(0, 200));
      continue;
    }
    for (const el of (c.data?.elements ?? [])) {
      const id = String(el?.["$URN"] || el?.id || el?.commentUrn || "");
      if (!id) continue;
      const authorUrn = String(el?.actor || el?.commenter || "");
      out.push({
        id,
        text: String(el?.message?.text || el?.comment || "").slice(0, 1000),
        author: authorUrn,
        authorUrn,
        objectUrn,
        createdAt: num(el?.created?.time || el?.createdAt),
      });
    }
  }
  // CONFIG-LI-1 · si LinkedIn no dejó leer los comentarios de NINGUNA publicación, no es «no hay».
  if (opts.lanzar && pedidos > 0 && fallidos === pedidos) throw new Error(ultimoError || "LinkedIn no devolvió los comentarios");
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Una publicación de la Página, lo justo para elegirla en el constructor de Flujos. */
export interface LiPostLite {
  /** URN del post (`urn:li:share|ugcPost|…`): es el `object` de sus comentarios. */
  id: string;
  caption: string;
  thumb: string;
  createdAt: number;
}

/**
 * Últimas publicaciones de la Página (las MISMAS que recorre el poller de comentarios:
 * `posts?q=author` ordenado por última modificación). Es la lista del selector «un post
 * concreto» de un flujo li_comment: un post que no esté aquí no lo mira el poller, así
 * que ofrecerlo sería ofrecer un flujo que nunca dispara.
 * Best-effort: sin token o con error devuelve [].
 */
export async function listLinkedInPosts(orgIdIn?: string, max = 10): Promise<LiPostLite[]> {
  const orgId = (orgIdIn && orgIdIn.trim()) || activeOrgId();
  if (!orgId) return [];
  const token = await linkedinCmFreshToken();
  if (!token) return [];
  const encUrn = encodeURIComponent(orgUrn(orgId));
  const posts = await liGet<any>(`posts?q=author&author=${encUrn}&count=${Math.max(1, Math.min(20, max))}&sortBy=LAST_MODIFIED`, { token });
  if (!posts.ok) return [];
  const els: any[] = (posts.data?.elements ?? []).filter((p: any) => p?.id).slice(0, max);
  return await Promise.all(els.map((p: any) => liPostLite(p, token)));
}

/** MEDIA-SNAP-1 · portada de un vídeo de LinkedIn (`urn:li:video:…`): la API de vídeos la da
 *  en `thumbnail`. Antes solo se resolvían imágenes, así que los posts de VÍDEO salían sin
 *  portada. "" si LinkedIn no la da (vídeo aún procesando, o sin permiso de lectura). */
const _vidCache = new Map<string, { url: string; ts: number }>();
async function resolveVideoThumb(urn: string, token: string): Promise<string> {
  if (!urn || !urn.startsWith("urn:li:video:")) return "";
  const c = _vidCache.get(urn);
  if (c && Date.now() - c.ts < (c.url ? 6 * 3600 * 1000 : 600_000)) return c.url;
  let url = "";
  try {
    const r = await liGet<any>(`videos/${encodeURIComponent(urn)}`, { token });
    url = r.ok ? String(r.data?.thumbnail || "") : "";
  } catch { url = ""; }
  _vidCache.set(urn, { url, ts: Date.now() });
  return url;
}

async function liPostLite(p: any, token: string): Promise<LiPostLite> {
  const art = p?.content?.article || {};
  const caption = String(p?.commentary || art.title || p?.specificContent?.["com.linkedin.ugc.ShareContent"]?.shareCommentary?.text || "").slice(0, 140);
  const mediaUrn = String(art.thumbnail || p?.content?.media?.id || p?.content?.multiImage?.images?.[0]?.id || "");
  const thumb = (await resolveImageUrl(mediaUrn, token).catch(() => "")) || (await resolveVideoThumb(mediaUrn, token).catch(() => ""));
  return { id: String(p.id), caption, thumb: thumb || "", createdAt: num(p?.publishedAt || p?.createdAt || p?.created?.time) };
}

/** MEDIA-SNAP-1 · UN post de la Página por su URN (aunque ya no esté entre los 10 últimos).
 *  null si LinkedIn no lo devuelve (borrado, o sin token). */
export async function getLinkedInPost(urn: string): Promise<LiPostLite | null> {
  if (!urn) return null;
  const token = await linkedinCmFreshToken();
  if (!token) return null;
  const r = await liGet<any>(`posts/${encodeURIComponent(urn)}`, { token });
  if (!r.ok || !r.data?.id) return null;
  return await liPostLite(r.data, token);
}

/**
 * Responde públicamente a un comentario en un post de nuestra Página (como la Página).
 * Lanza si LinkedIn devuelve error (el poller lo captura y loguea).
 */
export async function replyToLinkedInComment(orgId: string, objectUrn: string, parentCommentUrn: string, text: string): Promise<void> {
  const token = await linkedinCmFreshToken();
  if (!token) throw new Error("sin token de LinkedIn (reconecta la Página)");
  const body: Record<string, unknown> = {
    actor: orgUrn(orgId),
    object: objectUrn,
    message: { text: (text || "").slice(0, 3000) },
  };
  if (parentCommentUrn) body.parentComment = parentCommentUrn;
  const r = await liPost(`socialActions/${encodeURIComponent(objectUrn)}/comments`, body, { token });
  if (!r.ok) throw new Error(`socialActions/comments ${r.status}: ${r.error}`);
}
