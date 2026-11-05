/**
 * YouTube vía Google OAuth (proveedor distinto a Meta). MULTI-CUENTA: cada canal
 * conectado guarda sus propios tokens en `youtube.accounts` (JSON). Los tokens se
 * refrescan solos por cuenta con su refresh_token. El alta única (OAuth client +
 * APIs habilitadas en Google Cloud) la hace el owner; aquí solo consumimos.
 */
import { get, set } from "./settings.js";
import { notificar } from "./notifications.js";
import { withKeyLock } from "./cerrojo-clave.js";
import { logActivity } from "./activity.js";

// fetch con timeout: evita que una llamada lenta a Google (OAuth/YouTube/Analytics)
// cuelgue el endpoint de Métricas indefinidamente (Fastify no tiene request timeout).
async function ytFetch(input: string, init: Parameters<typeof fetch>[1] = {}): Promise<Response> {
  return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(8000) });
}

/**
 * force-ssl es el scope de ESCRITURA (responder/moderar comentarios). Es
 * "sensible" para Google: la app OAuth debe estar en publishing status
 * "In production" (aunque sin verificar) — en "Testing" el refresh_token
 * caduca a los 7 días y el poller se cae solo cada semana.
 *
 * Los canales conectados ANTES de este cambio tienen tokens sin force-ssl:
 * seguirán funcionando para métricas, pero no podrán responder hasta que el
 * owner los reconecte. Por eso guardamos los scopes concedidos por cuenta
 * (`scopes`) y `youtubeCanWrite()` lo comprueba antes de gastar cuota.
 */
const SCOPE_WRITE = "https://www.googleapis.com/auth/youtube.force-ssl";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  SCOPE_WRITE,
].join(" ");

function creds(): { clientId: string; clientSecret: string } {
  return {
    clientId: get("youtube.clientId") || process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: get("youtube.clientSecret") || process.env.GOOGLE_CLIENT_SECRET || "",
  };
}
/** ¿Hay OAuth client configurado (paso único del owner)? */
export function youtubeConfigured(): boolean {
  const { clientId, clientSecret } = creds();
  return !!clientId && !!clientSecret;
}

export interface YtAccount {
  id: string;
  channelId: string;
  title: string;
  thumb: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: number;
  /** Scopes concedidos por Google en el consentimiento (string separado por espacios).
   *  Ausente = canal conectado antes del scope de escritura → solo lectura. */
  scopes?: string;
  /** YT-RECONECTAR-1 · El permiso de Google ya no vale: el dueño lo retiró desde su
   *  cuenta, cambió la contraseña, o el proyecto OAuth seguía en pruebas y Google
   *  caduca el permiso a los 7 días. Google lo dice con `invalid_grant` al refrescar.
   *  Se persiste porque si no, cada lectura fallaba en silencio y la tarjeta se
   *  quedaba vacía sin decir NUNCA que había que volver a conectar. */
  accesoCaducado?: boolean;
  /** Cuándo se detectó (para poder contarlo en el aviso). */
  caducadoEn?: number;
}

/** ¿Este canal puede responder comentarios (tiene force-ssl)? */
export function youtubeCanWrite(acc: YtAccount): boolean {
  // CANAL-OBLIGATORIO-1 · Sin channelId la cuenta es inservible aunque tenga el
  // permiso de escritura: la lectura de comentarios (allThreadsRelatedToChannelId)
  // no puede ni construir la consulta, así que el poller nunca vería nada que
  // responder. Cuentas legacy migradas o conexiones que fallaron al identificar el
  // canal caen aquí y el panel las lista en "reconecta estos canales", en vez de
  // aparentar que están bien y no hacer nada.
  if (!acc.channelId) return false;
  return String(acc.scopes || "").includes(SCOPE_WRITE);
}

/** Canales conectados que NO pueden escribir → el panel pide reconectarlos. */
export function youtubeAccountsNeedingReconnect(): YtAccount[] {
  return youtubeListAccounts().filter((a) => !youtubeCanWrite(a));
}

function randId(): string {
  // Sin Date.now()/Math.random aleatorio fuerte: basta un id corto único por canal.
  return "yt" + Math.abs(hashStr(String(get("youtube.accounts") || "") + ":" + Date.now())).toString(36).slice(0, 8);
}
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Lista de canales conectados. Migra el formato legacy (1 canal en claves sueltas). */
export function youtubeListAccounts(): YtAccount[] {
  const raw = get("youtube.accounts");
  let accts: YtAccount[] = [];
  if (raw) {
    try { accts = JSON.parse(raw) as YtAccount[]; } catch { accts = []; }
  }
  if (!Array.isArray(accts)) accts = [];
  // Migración legacy: si no hay array pero existen los tokens sueltos antiguos.
  if (accts.length === 0) {
    const rt = get("youtube.refreshToken");
    const at = get("youtube.accessToken");
    if (rt || at) {
      accts = [{
        id: "yt-legacy",
        channelId: get("youtube.channelId") || "",
        title: get("youtube.channelTitle") || "",
        thumb: get("youtube.channelThumb") || "",
        accessToken: at || "",
        refreshToken: rt || "",
        tokenExpiry: Number(get("youtube.tokenExpiry") || 0),
      }];
    }
  }
  return accts;
}

async function saveAccounts(accts: YtAccount[]): Promise<void> {
  await set("youtube.accounts", JSON.stringify(accts));
  // Limpia las claves legacy una vez migrado al array (evita doble fuente).
  if (get("youtube.refreshToken") || get("youtube.accessToken")) {
    for (const k of ["youtube.accessToken", "youtube.refreshToken", "youtube.tokenExpiry", "youtube.channelId", "youtube.channelTitle", "youtube.channelThumb"]) await set(k, "");
  }
}

// CUENTAS-ATOMICO-1 · Todos los canales viven en UNA clave de ajustes: cualquier
// cambio es leer-todo / modificar / escribir-todo. Con dos refrescos de token a la
// vez (el sondeo de comentarios, la vista de analítica y una petición del panel
// pueden coincidir), el segundo escribía su copia vieja y borraba el token del
// primero. Esta es la clave que serializa esos tríos (ver cerrojo-clave.ts).
const CLAVE_YT = "youtube.accounts";

/**
 * CUENTAS-ATOMICO-1 · Lee el array, deja que `mutar` lo cambie y lo guarda, todo
 * dentro del cerrojo. La lectura tiene que quedar DENTRO: leer fuera es justo el
 * fallo que esto arregla.
 */
async function conCuentas<T>(mutar: (accts: YtAccount[]) => T | Promise<T>): Promise<T> {
  return withKeyLock(CLAVE_YT, async () => {
    const accts = youtubeListAccounts();
    const r = await mutar(accts);
    await saveAccounts(accts);
    return r;
  });
}

/** ¿Hay al menos un canal conectado? */
export function youtubeConnected(): boolean {
  return youtubeListAccounts().length > 0;
}

export function youtubeAuthUrl(redirectUri: string, state: string): string {
  const { clientId } = creds();
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    // select_account: permite elegir OTRA cuenta de Google → añadir otro canal.
    prompt: "select_account consent",
    include_granted_scopes: "true",
    state,
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}

export async function youtubeExchangeCode(code: string, redirectUri: string): Promise<{ ok: boolean; error?: string; channelTitle?: string }> {
  const { clientId, clientSecret } = creds();
  if (!clientId || !clientSecret) return { ok: false, error: "Falta el OAuth client de Google (youtube.clientId / youtube.clientSecret)." };
  const res = await ytFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }).toString(),
  });
  const d: Record<string, unknown> = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) return { ok: false, error: String(d.error_description || d.error || "token exchange falló") };
  const accessToken = String(d.access_token);
  const tokenExpiry = Date.now() + (Number(d.expires_in) || 3500) * 1000;
  // Google devuelve los scopes REALMENTE concedidos (el usuario puede desmarcar
  // permisos en la pantalla de consentimiento). Los guardamos para no intentar
  // escribir con un token que solo tiene lectura.
  const granted = String(d.scope || "");
  let channelId = "", title = "", thumb = "";
  let chError = "";
  try {
    const ch = await channelRaw(accessToken);
    if (ch) { channelId = String(ch.id || ""); title = String(ch.snippet?.title || ""); thumb = String(ch.snippet?.thumbnails?.default?.url || ""); }
    else chError = "la cuenta de Google no tiene ningún canal de YouTube asociado";
  } catch (e) { chError = ((e as Error).message || "no se pudo consultar el canal").slice(0, 160); }
  // CANAL-OBLIGATORIO-1 · SIN channelId no se guarda NADA. Antes se persistía la
  // cuenta igualmente y el callback cantaba «conectado», pero esa cuenta quedaba
  // inservible: youtubeListRecentComments filtra los comentarios propios comparando
  // contra acc.channelId y sin él devuelve siempre vacío, así que el dueño veía un
  // canal conectado que jamás respondía a nadie. Mejor fallar aquí y que reconecte.
  if (!channelId) {
    return { ok: false, error: "No se pudo identificar tu canal de YouTube" + (chError ? ": " + chError : "") + ". Vuelve a conectar y elige una cuenta de Google que tenga canal." };
  }
  // CUENTAS-ATOMICO-1 · leer-modificar-escribir dentro del cerrojo. Las llamadas a
  // Google ya han terminado aquí arriba: dentro sólo queda trabajo en memoria y el
  // guardado, sin esperas de red que alarguen el turno de los demás.
  await conCuentas((accts) => {
    // Si el canal ya está conectado → actualiza (reconexión). Si no → añade.
    const existing = channelId ? accts.find((a) => a.channelId === channelId) : undefined;
    if (existing) {
      existing.accessToken = accessToken;
      existing.tokenExpiry = tokenExpiry;
      if (d.refresh_token) existing.refreshToken = String(d.refresh_token);
      existing.title = title || existing.title;
      existing.thumb = thumb || existing.thumb;
      if (granted) existing.scopes = granted;
      // YT-RECONECTAR-1 · acaba de reconectar: se retira el aviso ámbar.
      existing.accesoCaducado = false;
      existing.caducadoEn = 0;
    } else {
      accts.push({
        id: randId(),
        channelId, title, thumb,
        accessToken,
        refreshToken: d.refresh_token ? String(d.refresh_token) : "",
        tokenExpiry,
        scopes: granted,
      });
    }
  });
  return { ok: true, channelTitle: title };
}

/** YT-RECONECTAR-1 · Marca (o desmarca) el canal como «hay que volver a conectarlo» y
 *  lo GUARDA. Sin persistirlo, el aviso se perdía en cuanto respondía otra petición. */
async function marcarCaducado(acc: YtAccount, caducado: boolean): Promise<void> {
  if (!!acc.accesoCaducado === caducado) return;
  acc.accesoCaducado = caducado;
  acc.caducadoEn = caducado ? Date.now() : 0;
  // CUENTAS-ATOMICO-1 · misma regla que el resto: lectura y escritura dentro del cerrojo,
  // tocando SOLO este canal. Si no, una marca de caducidad podía pisar el token que otro
  // canal acababa de refrescar.
  await conCuentas((accts) => {
    const i = accts.findIndex((a) => a.id === acc.id);
    if (i < 0) return;
    accts[i].accesoCaducado = caducado;
    accts[i].caducadoEn = acc.caducadoEn;
    if (caducado) { accts[i].accessToken = ""; accts[i].tokenExpiry = 0; }
  });
  // NOTIFICACIONES-1 · conexion: el canal dejó de estar autorizado (una vez por caída).
  if (caducado) notificar({ kind: "conexion", title: "YouTube desconectado" + (acc.title ? ": " + acc.title : ""), body: "Google ha retirado el permiso del canal. Vuelve a conectarlo para seguir publicando y respondiendo comentarios.", channel: "youtube", link: "connections", dedup: "conexion:yt:" + acc.id + ":" + acc.caducadoEn });
}

async function refreshAccess(acc: YtAccount): Promise<string> {
  if (acc.accessToken && Date.now() < acc.tokenExpiry - 60000) return acc.accessToken;
  const { clientId, clientSecret } = creds();
  if (!acc.refreshToken || !clientId || !clientSecret) return acc.accessToken;
  const res = await ytFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: acc.refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" }).toString(),
  });
  const d: Record<string, unknown> = await res.json().catch(() => ({}));
  if (d.access_token) {
    acc.accessToken = String(d.access_token);
    acc.tokenExpiry = Date.now() + (Number(d.expires_in) || 3500) * 1000;
    // CUENTAS-ATOMICO-1 · Persistir el token refrescado tocando SOLO su canal, y con
    // la lectura dentro del cerrojo. Antes se leía el array fuera y se reescribía
    // entero: dos refrescos simultáneos de canales distintos y el segundo guardaba su
    // copia vieja, borrando el token que el primero acababa de renovar.
    await conCuentas((accts) => {
      const i = accts.findIndex((a) => a.id === acc.id);
      if (i >= 0) { accts[i].accessToken = acc.accessToken; accts[i].tokenExpiry = acc.tokenExpiry; }
    });
    // Volvió a funcionar (p.ej. Google tuvo un 500 hace un rato): se retira el aviso.
    if (acc.accesoCaducado) await marcarCaducado(acc, false);
    return acc.accessToken;
  }
  // YT-RECONECTAR-1 · CAUSA RAÍZ: aquí se devolvía `acc.accessToken` — el acceso VIEJO y
  // ya caducado. Con él, cada lectura posterior se comía un 401 y devolvía null o lista
  // vacía sin decir nada, así que la tarjeta de YouTube se quedaba en blanco para
  // siempre y el dueño no tenía forma de enterarse de que debía reconectar.
  // `invalid_grant` (o un 400/401 del endpoint de Google) significa que el permiso ya
  // no existe: no se arregla reintentando, lo arregla el dueño reconectando.
  const errGoogle = String(d.error || "").toLowerCase();
  const permisoMuerto = errGoogle === "invalid_grant" || errGoogle === "invalid_client" || res.status === 400 || res.status === 401;
  if (permisoMuerto) {
    await marcarCaducado(acc, true);
    acc.accessToken = "";
    acc.tokenExpiry = 0;
    return "";
  }
  // Fallo pasajero (corte de red, 5xx de Google): NO se marca nada, pero tampoco se
  // devuelve un acceso caducado que fingiría que todo va bien.
  return Date.now() < acc.tokenExpiry - 60000 ? acc.accessToken : "";
}

/** YT-RECONECTAR-1 · ¿Este canal necesita que el dueño lo vuelva a conectar? */
export function youtubeCaducado(acc: YtAccount): boolean {
  return !!acc.accesoCaducado;
}

async function channelRaw(token: string): Promise<any> {
  const res = await ytFetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true",
    { headers: { Authorization: "Bearer " + token } },
  );
  const d: any = await res.json().catch(() => ({}));
  return (d.items && d.items[0]) || null;
}

export interface YtChannel {
  id: string; title: string; thumb: string;
  subscribers: number; views: number; videos: number; uploads: string;
}

/** Canal + stats de UNA cuenta (por id). Sin id → la primera (compat). */
export async function youtubeChannel(accountId?: string): Promise<YtChannel | null> {
  const accts = youtubeListAccounts();
  const acc = accountId ? accts.find((a) => a.id === accountId) : accts[0];
  if (!acc) return null;
  const token = await refreshAccess(acc);
  if (!token) return null;
  const ch = await channelRaw(token);
  if (!ch) return null;
  return {
    id: ch.id, title: ch.snippet?.title || "", thumb: ch.snippet?.thumbnails?.default?.url || "",
    subscribers: Number(ch.statistics?.subscriberCount || 0),
    views: Number(ch.statistics?.viewCount || 0),
    videos: Number(ch.statistics?.videoCount || 0),
    uploads: ch.contentDetails?.relatedPlaylists?.uploads || "",
  };
}

export async function youtubeRecentVideos(uploads: string, n = 6, accountId?: string): Promise<{ id: string; title: string; thumb: string; published: string }[]> {
  if (!uploads) return [];
  const accts = youtubeListAccounts();
  const acc = accountId ? accts.find((a) => a.id === accountId) : accts[0];
  if (!acc) return [];
  const token = await refreshAccess(acc);
  if (!token) return [];
  const res = await ytFetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${n}&playlistId=${encodeURIComponent(uploads)}`,
    { headers: { Authorization: "Bearer " + token } },
  );
  const d: any = await res.json().catch(() => ({}));
  return (d.items || []).map((it: any) => ({
    id: it.snippet?.resourceId?.videoId || "",
    title: it.snippet?.title || "",
    thumb: it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url || "",
    published: it.snippet?.publishedAt || "",
  }));
}

/**
 * ¿De qué canal es este vídeo? Devuelve el channelId de su dueño, "" si YouTube no
 * conoce el id (vídeo borrado, privado o inventado) y null cuando NO se ha podido
 * comprobar (cuenta inexistente, sin token, red o cuota) — así el que llama puede
 * distinguir "es de otro canal" de "no lo sé" y no bloquear por un fallo nuestro.
 * Coste: 1 unidad de cuota (videos.list part=snippet).
 */
export async function youtubeVideoChannelId(accountId: string, videoId: string): Promise<string | null> {
  const acc = youtubeListAccounts().find((a) => a.id === accountId);
  if (!acc || !videoId) return null;
  const token = await refreshAccess(acc);
  if (!token) return null;
  try {
    const res = await ytFetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
      { headers: { Authorization: "Bearer " + token } },
    );
    if (!res.ok) return null;
    const d: any = await res.json().catch(() => ({}));
    const it = (d.items || [])[0];
    if (!it) return "";
    return String(it.snippet?.channelId || "");
  } catch {
    return null;
  }
}

/**
 * YT-SHORTS-TAG-1 · marca como Short un vídeo YA subido: le pone «#Shorts» al final del título (o de la
 * descripción si el título no cabe en 100 caracteres). YouTube solo clasifica así un vídeo vertical
 * cuando lo lleva, y el reproductor normal no es lo que se busca en la pestaña Shorts.
 * Cuesta ~51 unidades de cuota (list 1 + update 50). Necesita el permiso de escritura (force-ssl).
 */
export async function youtubeMarcarShort(accountId: string | undefined, videoId: string): Promise<{ ok: boolean; title?: string; ya?: boolean; error?: string }> {
  const accts = youtubeListAccounts();
  const acc = accountId ? accts.find((a) => a.id === accountId) : accts[0];
  if (!acc) return { ok: false, error: "canal de YouTube no encontrado" };
  if (!videoId || !/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return { ok: false, error: "id de vídeo no válido" };
  if (!youtubeCanWrite(acc)) return { ok: false, error: "el canal está conectado solo para lectura: reconéctalo en Conexiones → YouTube" };
  const token = await refreshAccess(acc);
  if (!token) return { ok: false, error: "sin token de YouTube" };
  const r = await ytFetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}`, { headers: { Authorization: "Bearer " + token } });
  const d: any = await r.json().catch(() => ({}));
  const it = (d.items || [])[0];
  if (!r.ok || !it) return { ok: false, error: r.ok ? "YouTube no conoce ese vídeo" : `videos.list ${r.status}: ${d?.error?.message || "error"}` };
  if (acc.channelId && it.snippet?.channelId && it.snippet.channelId !== acc.channelId) return { ok: false, error: "ese vídeo no es de este canal" };
  const sn = it.snippet || {};
  const title = String(sn.title || "");
  const desc = String(sn.description || "");
  if (/#shorts\b/i.test(title) || /#shorts\b/i.test(desc)) return { ok: true, ya: true, title };
  let nTitle = title, nDesc = desc;
  if (title.length + 8 <= 100) nTitle = title + " #Shorts";
  else nDesc = desc.replace(/\s+$/, "") + "\n\n#Shorts";
  const snippet: Record<string, unknown> = { title: nTitle, description: nDesc, categoryId: sn.categoryId };
  if (Array.isArray(sn.tags)) snippet.tags = sn.tags;
  if (sn.defaultLanguage) snippet.defaultLanguage = sn.defaultLanguage;
  const u = await ytFetch("https://www.googleapis.com/youtube/v3/videos?part=snippet", {
    method: "PUT",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ id: videoId, snippet }),
  });
  if (!u.ok) {
    const e: any = await u.json().catch(() => ({}));
    return { ok: false, error: `videos.update ${u.status}: ${String(e?.error?.message || "error").slice(0, 160)}` };
  }
  return { ok: true, title: nTitle };
}

// OFERTA-YT-1 (MET-YT-05) · la descripción de UN vídeo, para sacar sus enlaces en la ficha.
// null = no se ha podido leer (sin cuenta, sin permiso o Google no responde); "" = no tiene.
export async function youtubeVideoDescription(accountId: string | undefined, videoId: string): Promise<string | null> {
  const accts = youtubeListAccounts();
  const acc = accountId ? accts.find((a) => a.id === accountId) : accts[0];
  if (!acc || !videoId) return null;
  const token = await refreshAccess(acc);
  if (!token) return null;
  try {
    const res = await ytFetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
      { headers: { Authorization: "Bearer " + token } },
    );
    if (!res.ok) return null;
    const d: any = await res.json().catch(() => ({}));
    const it = (d.items || [])[0];
    return it ? String(it.snippet?.description || "") : null;
  } catch {
    return null;
  }
}

/**
 * Helper público para llamar a YouTube Analytics v2 reports desde otros módulos
 * (p.ej. analytics.ts segYouTubePro) sin duplicar lógica de OAuth + refresh.
 * Devuelve filas crudas + columnas; null si no hay cuenta o el scope falla.
 *
 * Nota: YouTube Analytics NO expone la dimensión `hour` para reports de canal
 * (sólo Real-Time API la tiene y requiere otro scope). Por eso este helper
 * sólo acepta dimensiones documentadas (day, video, country, etc.) y los
 * callers que quieran un heatmap por hora deben degradar a sparkline por día.
 */
export async function youtubeAnalyticsReport(
  accountId: string | undefined,
  startDate: string,
  endDate: string,
  metrics: string,
  dimensions?: string,
  sort?: string,
): Promise<{ cols: string[]; rows: any[][] } | null> {
  const accts = youtubeListAccounts();
  const acc = accountId ? accts.find((a) => a.id === accountId) : accts[0];
  if (!acc) return null;
  const token = await refreshAccess(acc);
  if (!token) return null;
  const params: Record<string, string> = { startDate, endDate, metrics };
  if (dimensions) params.dimensions = dimensions;
  if (sort) params.sort = sort;
  return await ytaReport(token, params);
}

// ===== YouTube Analytics API (métricas por rango de fechas, nivel Instagram) =====
async function ytaReport(token: string, params: Record<string, string>): Promise<{ cols: string[]; rows: any[][] }> {
  const qs = new URLSearchParams({ ids: "channel==MINE", ...params }).toString();
  try {
    const res = await ytFetch(`https://youtubeanalytics.googleapis.com/v2/reports?${qs}`, { headers: { Authorization: "Bearer " + token } });
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(d.columnHeaders)) return { cols: [], rows: [] };
    return { cols: d.columnHeaders.map((c: any) => c.name), rows: Array.isArray(d.rows) ? d.rows : [] };
  } catch { return { cols: [], rows: [] }; }
}

const YT_TRAFFIC: Record<string, string> = {
  YT_SEARCH: "Búsqueda de YouTube", RELATED_VIDEO: "Vídeos sugeridos", SUBSCRIBER: "Feed / Suscripciones",
  EXT_URL: "Sitios externos", PLAYLIST: "Listas de reproducción", YT_PLAYLIST_PAGE: "Página de lista",
  YT_CHANNEL: "Página del canal", NOTIFICATION: "Notificaciones", SHORTS: "Feed de Shorts",
  NO_LINK_EMBEDDED: "Reproductor insertado", NO_LINK_OTHER: "Directo / otro", YT_OTHER_PAGE: "Otras páginas de YT",
  END_SCREEN: "Pantallas finales", ANNOTATION: "Tarjetas / anotaciones", HASHTAGS: "Hashtags", ADVERTISING: "Publicidad", CAMPAIGN_CARD: "Campañas",
};
const YT_DEVICE: Record<string, string> = { MOBILE: "Móvil", DESKTOP: "Ordenador", TABLET: "Tablet", TV: "TV", GAME_CONSOLE: "Consola", UNKNOWN_PLATFORM: "Otro" };

// VIDEOS-YT-1 · «PT1H2M5S» → segundos; null si no se entiende.
function ytDuracion(iso: string): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m || !iso) return null;
  return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0);
}

type YtMeta = { title: string; thumb: string; published: string; durationSec: number | null };
async function youtubeVideoMeta(token: string, ids: string[]): Promise<Record<string, YtMeta>> {
  const out: Record<string, YtMeta> = {};
  if (!ids.length) return out;
  try {
    // VIDEOS-YT-1 · contentDetails trae la duración (misma unidad de cuota). videos.list acepta 50 ids.
    const res = await ytFetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(ids.slice(0, 50).join(","))}`, { headers: { Authorization: "Bearer " + token } });
    const d: any = await res.json().catch(() => ({}));
    for (const it of d.items || []) out[it.id] = { title: it.snippet?.title || "", thumb: it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url || "", published: it.snippet?.publishedAt || "", durationSec: ytDuracion(it.contentDetails?.duration || "") };
  } catch { /* best effort */ }
  return out;
}

// RETENCION-YT-1 (MET-YT-04) · la curva de permanencia de UN vídeo en el rango: en cada punto del
// vídeo (YouTube lo parte en 100 tramos), qué parte de las reproducciones seguía viéndolo
// (audienceWatchRatio: pasa de 1 si la gente repite un trozo o el Short vuelve a empezar solo) y
// cómo aguanta ese tramo frente a los vídeos de YouTube de duración parecida
// (relativeRetentionPerformance: 0,5 es la mediana). Si Google no da la comparación se pide sólo
// la curva; si no da nada, puntos vacíos y el panel lo dice.
export async function youtubeVideoRetention(accountId: string | undefined, videoId: string, startDate: string, endDate: string): Promise<{ durationSec: number | null; points: { x: number; w: number; r: number | null }[] } | null> {
  const accts = youtubeListAccounts();
  const acc = accountId ? accts.find((a) => a.id === accountId) : accts[0];
  if (!acc) return null;
  const token = await refreshAccess(acc);
  if (!token) return null;
  const base = { startDate, endDate, dimensions: "elapsedVideoTimeRatio", filters: "video==" + videoId, sort: "elapsedVideoTimeRatio" };
  const [rep0, meta] = await Promise.all([
    ytaReport(token, { ...base, metrics: "audienceWatchRatio,relativeRetentionPerformance" }),
    youtubeVideoMeta(token, [videoId]),
  ]);
  const rep = rep0.cols.length ? rep0 : await ytaReport(token, { ...base, metrics: "audienceWatchRatio" });
  const ix = rep.cols.indexOf("elapsedVideoTimeRatio"), iw = rep.cols.indexOf("audienceWatchRatio"), ir = rep.cols.indexOf("relativeRetentionPerformance");
  const points = ix < 0 || iw < 0 ? [] : rep.rows
    .map((row) => ({ x: Number(row[ix]), w: Number(row[iw]), r: ir < 0 || row[ir] == null ? null : Number(row[ir]) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.w));
  return { durationSec: meta[videoId]?.durationSec ?? null, points };
}

/** Analítica del canal por rango de días (YouTube Analytics API). Degrada a null si
 *  no hay scope/datos. Devuelve totales del periodo + serie + breakdowns + top vídeos. */
/** METRICAS-1 · días del rango de YouTube en el calendario de Madrid. N días = N días contando hoy
 *  (antes salían N+1, y el periodo anterior también); con rango elegido (ms del toolbar), esos días. */
const DIA_YT = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" });
const sumarDiasYmd = (s: string, n: number) => new Date(Date.parse(s + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export function rangoYoutube(days: number, rango?: { sinceMs: number; untilMs: number }, ahora = Date.now()) {
  let d = Math.max(1, Math.min(365, Math.floor(days || 30)));
  let endDate = DIA_YT.format(new Date(ahora)), startDate = sumarDiasYmd(endDate, -(d - 1));
  if (rango && rango.untilMs > rango.sinceMs) {
    startDate = DIA_YT.format(new Date(rango.sinceMs)); endDate = DIA_YT.format(new Date(rango.untilMs));
    d = Math.max(1, Math.min(365, Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1));
    startDate = sumarDiasYmd(endDate, -(d - 1));
  }
  return { d, base: { startDate, endDate }, prevBase: { startDate: sumarDiasYmd(startDate, -d), endDate: sumarDiasYmd(startDate, -1) } };
}

export async function youtubeAnalyticsBundle(accountId: string | undefined, days: number, recentIds: string[] = [], rango?: { sinceMs: number; untilMs: number }): Promise<any | null> {
  const accts = youtubeListAccounts();
  const acc = accountId ? accts.find((a) => a.id === accountId) : accts[0];
  if (!acc) return null;
  const token = await refreshAccess(acc);
  if (!token) return null;
  const { d, base, prevBase } = rangoYoutube(days, rango);
  // PORTADA-YT-1 (MET-YT-01) · los mismos días justo antes del rango, por día: la comparación se
  // hace luego sólo con tantos días como tenga el rango con datos consolidados (YouTube va 2-3 días
  // por detrás; comparar 28 días con 31 completos vendería una bajada que no existe).
  const VMET = "views,estimatedMinutesWatched,averageViewPercentage,likes,comments,shares,subscribersGained";
  const recientes = recentIds.filter(Boolean).slice(0, 50);
  const [tot, ser, traf, dev, geo, demo, subs, vids, eng, vEng, prevSer, vSubs, vWatch, vShorts, vRec] = await Promise.all([
    ytaReport(token, { ...base, metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares" }),
    ytaReport(token, { ...base, metrics: "views", dimensions: "day", sort: "day" }),
    // ORIGEN-YT-1 (MET-YT-02) · todas las fuentes, no sólo diez: la lista completa vive en segundo nivel.
    ytaReport(token, { ...base, metrics: "views", dimensions: "insightTrafficSourceType", sort: "-views" }),
    ytaReport(token, { ...base, metrics: "views", dimensions: "deviceType", sort: "-views" }),
    ytaReport(token, { ...base, metrics: "views", dimensions: "country", sort: "-views", maxResults: "8" }),
    ytaReport(token, { ...base, metrics: "viewerPercentage", dimensions: "ageGroup,gender" }),
    ytaReport(token, { ...base, metrics: "views", dimensions: "subscribedStatus" }),
    ytaReport(token, { ...base, metrics: "views,estimatedMinutesWatched,averageViewPercentage,likes,comments,shares,subscribersGained", dimensions: "video", sort: "-views", maxResults: "10" }),
    // CONCILIAR-YT-1 (MET-YT-07) · engagedViews (visionados con tiempo de visión) va en informes
    // APARTE: ytaReport devuelve vacío ante cualquier error, y una métrica que Google no acepte en
    // una petición combinada dejaría en blanco el informe entero. Así, si falla, sólo falta ella.
    ytaReport(token, { ...base, metrics: "engagedViews" }),
    ytaReport(token, { ...base, metrics: "views,engagedViews", dimensions: "video", sort: "-views", maxResults: "10" }),
    ytaReport(token, { ...prevBase, metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost", dimensions: "day", sort: "day" }),
    // PORTADA-YT-1 · el vídeo que más suscriptores trajo, pedido aparte: entre los 10 más vistos
    // podría no estar, y entonces el «destacado» nombraría a otro.
    // VIDEOS-YT-1 (MET-YT-03) · ahora los 10 primeros: son también el ranking «más suscriptores».
    ytaReport(token, { ...base, metrics: VMET, dimensions: "video", sort: "-subscribersGained", maxResults: "10" }),
    // VIDEOS-YT-1 · ranking «más tiempo de visualización».
    ytaReport(token, { ...base, metrics: VMET, dimensions: "video", sort: "-estimatedMinutesWatched", maxResults: "10" }),
    // VIDEOS-YT-1 · qué vídeos son Shorts según YouTube (creatorContentType). Si el informe falla,
    // el formato se deduce de la duración y se dice que es deducido.
    ytaReport(token, { ...base, metrics: "views", dimensions: "video", filters: "creatorContentType==SHORTS", sort: "-views", maxResults: "200" }),
    // VIDEOS-YT-1 · los últimos vídeos publicados, con sus cifras DEL RANGO (antes iban sin ninguna).
    recientes.length
      ? ytaReport(token, { ...base, metrics: VMET, dimensions: "video", filters: "video==" + recientes.join(","), maxResults: String(recientes.length) })
      : Promise.resolve({ cols: [] as string[], rows: [] as any[][] }),
  ]);
  const ci = (r: { cols: string[]; rows: any[][] }, name: string) => r.cols.indexOf(name);
  const period: Record<string, number> = {};
  if (tot.rows[0]) for (const c of tot.cols) period[c] = Number(tot.rows[0][ci(tot, c)]) || 0;
  const series = ser.rows.map((row) => ({ date: String(row[ci(ser, "day")]), views: Number(row[ci(ser, "views")]) || 0 }));
  // CONCILIAR-YT-1 · hasta qué día hay datos de verdad (YouTube consolida con 2-3 días de retraso):
  // el último día de la serie con reproducciones. Sin él, «hasta hoy» sería mentira.
  const conDatos = series.filter((x) => x.views > 0);
  const lastDataDate = conDatos.length ? conDatos[conDatos.length - 1].date : null;
  const engagedViews = eng.rows[0] && ci(eng, "engagedViews") >= 0 ? Number(eng.rows[0][ci(eng, "engagedViews")]) || 0 : null;
  const vEngMap = new Map<string, number>();
  if (ci(vEng, "video") >= 0 && ci(vEng, "engagedViews") >= 0) for (const row of vEng.rows) vEngMap.set(String(row[ci(vEng, "video")]), Number(row[ci(vEng, "engagedViews")]) || 0);
  const bd = (r: { cols: string[]; rows: any[][] }, dim: string, map?: Record<string, string>) =>
    r.rows.map((row) => { const k = String(row[ci(r, dim)]); return { key: k, label: (map && map[k]) || k, views: Number(row[ci(r, "views")]) || 0 }; });
  const traffic = bd(traf, "insightTrafficSourceType", YT_TRAFFIC);
  const devices = bd(dev, "deviceType", YT_DEVICE);
  const geography = bd(geo, "country");
  let subYes = 0, subNo = 0;
  for (const row of subs.rows) { const k = String(row[ci(subs, "subscribedStatus")]); const v = Number(row[ci(subs, "views")]) || 0; if (k === "SUBSCRIBED") subYes += v; else subNo += v; }
  const ageMap = new Map<string, number>(), genMap = new Map<string, number>();
  const gName: Record<string, string> = { female: "Mujeres", male: "Hombres", user_specified: "Otro", gender_other: "Otro" };
  for (const row of demo.rows) {
    const ag = String(row[ci(demo, "ageGroup")] || "").replace(/^age/, "");
    const gn = String(row[ci(demo, "gender")] || "");
    const vp = Number(row[ci(demo, "viewerPercentage")]) || 0;
    if (ag) ageMap.set(ag, (ageMap.get(ag) || 0) + vp);
    if (gn) genMap.set(gn, (genMap.get(gn) || 0) + vp);
  }
  const age = [...ageMap.entries()].map(([label, value]) => ({ label, value: Math.round(value * 10) / 10 })).sort((a, b) => a.label.localeCompare(b.label));
  const gender = [...genMap.entries()].map(([k, value]) => ({ label: gName[k] || k, value: Math.round(value * 10) / 10 }));
  const vidIds = vids.rows.map((row) => String(row[ci(vids, "video")])).filter(Boolean);
  const subsRow = vSubs.rows[0] && ci(vSubs, "video") >= 0 && (Number(vSubs.rows[0][ci(vSubs, "subscribersGained")]) || 0) > 0 ? vSubs.rows[0] : null;
  const subsId = subsRow ? String(subsRow[ci(vSubs, "video")]) : "";
  // PORTADA-YT-1 · periodo anterior equivalente: tantos días como tenga el rango con datos
  // (del inicio al último día consolidado), justo antes del rango. Sin días con datos, no hay.
  let prev: any = null;
  if (lastDataDate && ci(prevSer, "day") >= 0) {
    const nDias = Math.round((Date.parse(lastDataDate) - Date.parse(base.startDate)) / 86400000) + 1;
    const desde = sumarDiasYmd(base.startDate, -nDias);
    const filas = prevSer.rows.filter((row) => String(row[ci(prevSer, "day")]) >= desde);
    if (nDias > 0 && filas.length) {
      const sum = (c: string) => filas.reduce((a, row) => a + (Number(row[ci(prevSer, c)]) || 0), 0);
      prev = {
        days: nDias, from: desde, to: prevBase.endDate,
        views: sum("views"),
        watchHours: Math.round(sum("estimatedMinutesWatched") / 60),
        subsNet: sum("subscribersGained") - sum("subscribersLost"),
      };
    }
  }
  // ORIGEN-YT-1 (MET-YT-02) · segunda vuelta, en paralelo con los títulos. Para que «20.529 desde
  // búsqueda» responda «¿qué buscaban y qué vídeo vieron?»:
  //   · qué se buscó (YT_SEARCH) y desde qué webs (EXT_URL): insightTrafficSourceDetail, que YouTube
  //     sólo da para algunas fuentes, con un máximo de 25 filas;
  //   · qué vídeos sumó cada fuente: las fuentes de cada uno de los 10 vídeos más vistos (YouTube no
  //     cruza vídeo × fuente en un solo informe). Del resto de vídeos no se sabe y se dice;
  //   · las mismas fuentes en el periodo anterior equivalente, para su comparación.
  // Un informe que falla vuelve con cols vacías: entonces ese dato es null («no lo ha devuelto»),
  // distinto de una lista vacía («no hubo»).
  const VACIO = { cols: [] as string[], rows: [] as any[][] };
  const claves = traffic.map((t) => t.key);
  const top10 = vidIds.slice(0, 10);
  const detalleDe = (tipo: string) => claves.includes(tipo)
    ? ytaReport(token, { ...base, metrics: "views", dimensions: "insightTrafficSourceDetail", filters: "insightTrafficSourceType==" + tipo, sort: "-views", maxResults: "25" })
    : Promise.resolve(VACIO);
  const [meta, qBus, qExt, prevTraf, porVid] = await Promise.all([
    // VIDEOS-YT-1 · títulos y duración de todo vídeo que salga en alguna lista (≤ 50 ids).
    youtubeVideoMeta(token, [...new Set([...vidIds, ...[vSubs, vWatch, vRec].flatMap((r) => ci(r, "video") < 0 ? [] : r.rows.map((row) => String(row[ci(r, "video")]))), ...recientes])].filter(Boolean)),
    detalleDe("YT_SEARCH"),
    detalleDe("EXT_URL"),
    prev ? ytaReport(token, { startDate: prev.from, endDate: prev.to, metrics: "views", dimensions: "insightTrafficSourceType" }) : Promise.resolve(VACIO),
    Promise.all(top10.map((id) => ytaReport(token, { ...base, metrics: "views", dimensions: "insightTrafficSourceType", filters: "video==" + id }))),
  ]);
  const detalle = (r: { cols: string[]; rows: any[][] }) => ci(r, "insightTrafficSourceDetail") < 0 ? null
    : r.rows.map((row) => ({ label: String(row[ci(r, "insightTrafficSourceDetail")] || ""), views: Number(row[ci(r, "views")]) || 0 })).filter((x) => x.label);
  const prevPor = new Map<string, number>();
  const prevOk = ci(prevTraf, "insightTrafficSourceType") >= 0;
  if (prevOk) for (const row of prevTraf.rows) prevPor.set(String(row[ci(prevTraf, "insightTrafficSourceType")]), Number(row[ci(prevTraf, "views")]) || 0);
  const vidPor = new Map<string, { id: string; views: number }[]>();
  let trafficVideos = 0;
  porVid.forEach((r, i) => {
    if (ci(r, "insightTrafficSourceType") < 0) return;
    trafficVideos++;
    for (const row of r.rows) {
      const k = String(row[ci(r, "insightTrafficSourceType")]), v = Number(row[ci(r, "views")]) || 0;
      if (v > 0) { const l = vidPor.get(k) || []; l.push({ id: top10[i], views: v }); vidPor.set(k, l); }
    }
  });
  for (const t of traffic as any[]) {
    t.prevViews = prev && prevOk ? (prevPor.get(t.key) || 0) : null;
    t.videos = trafficVideos ? (vidPor.get(t.key) || []).sort((a, b) => b.views - a.views) : null;
    if (t.key === "YT_SEARCH") t.detail = detalle(qBus);
    if (t.key === "EXT_URL") t.detail = detalle(qExt);
  }
  // VIDEOS-YT-1 · formato: «short» o «largo». Con el informe de Shorts, un vídeo que está en él es
  // Short; uno que tuvo visualizaciones y no está es largo — sólo si el informe vino completo (menos
  // de 200 filas). Sin informe, por duración: más de 3 min no puede ser Short; hasta 60 s se toma
  // por Short, deducido (formatSure=false). Entre medias y sin informe: null, no se sabe.
  const shortsOk = ci(vShorts, "video") >= 0;
  const shortsSet = new Set(shortsOk ? vShorts.rows.map((row) => String(row[ci(vShorts, "video")])) : []);
  const shortsCompleto = shortsOk && vShorts.rows.length < 200;
  const formatoDe = (id: string, views: number): { format: "short" | "largo" | null; formatSure: boolean } => {
    if (shortsSet.has(id)) return { format: "short", formatSure: true };
    if (shortsCompleto && views > 0) return { format: "largo", formatSure: true };
    const s = meta[id]?.durationSec;
    if (s == null) return { format: null, formatSure: false };
    if (s > 180) return { format: "largo", formatSure: true };
    if (s <= 60) return { format: "short", formatSure: false };
    return { format: null, formatSure: false };
  };
  const vidOf = (r: { cols: string[]; rows: any[][] }, row: any[]) => {
    const id = String(row[ci(r, "video")]);
    const views = Number(row[ci(r, "views")]) || 0;
    return {
      id, title: meta[id]?.title || id, thumb: meta[id]?.thumb || "", published: meta[id]?.published || "",
      durationSec: meta[id]?.durationSec ?? null, ...formatoDe(id, views), // VIDEOS-YT-1
      views: Number(row[ci(r, "views")]) || 0,
      watchMinutes: Number(row[ci(r, "estimatedMinutesWatched")]) || 0,
      avgViewPct: Math.round((Number(row[ci(r, "averageViewPercentage")]) || 0) * 10) / 10,
      likes: Number(row[ci(r, "likes")]) || 0,
      comments: Number(row[ci(r, "comments")]) || 0,
      shares: Number(row[ci(r, "shares")]) || 0,
      subsGained: Number(row[ci(r, "subscribersGained")]) || 0,
      engagedViews: vEngMap.has(id) ? vEngMap.get(id) : null, // CONCILIAR-YT-1
    };
  };
  const topVideos = vids.rows.map((row) => vidOf(vids, row));
  const topSubs = subsRow ? vidOf(vSubs, subsRow) : null;
  // VIDEOS-YT-1 (MET-YT-03) · «Qué vídeos funcionan»: el orden de cada ranking (ids) y las cifras
  // DEL RANGO de cada vídeo que sale en alguno. Un ranking cuyo informe falló es null (≠ vacío).
  const lista = (r: { cols: string[]; rows: any[][] }) => ci(r, "video") < 0 ? null : r.rows.map((row) => vidOf(r, row));
  const porTiempo = lista(vWatch);
  const porSubs = lista(vSubs)?.filter((v) => v.subsGained > 0) ?? null;
  // Un reciente sin fila en el informe no tuvo visualizaciones en el rango: cero, no «sin datos».
  const recOk = recientes.length > 0 && ci(vRec, "video") >= 0;
  const recMap = new Map(recOk ? vRec.rows.map((row) => [String(row[ci(vRec, "video")]), vidOf(vRec, row)] as const) : []);
  const recentStats = recOk ? recientes.map((id) => recMap.get(id) || vidOf({ cols: ["video"], rows: [] }, [id])) : null;
  const videoRank = { views: topVideos.map((v) => v.id), watch: porTiempo ? porTiempo.map((v) => v.id) : null, subs: porSubs ? porSubs.map((v) => v.id) : null };
  const videoStats: Record<string, any> = {};
  for (const v of [...(recentStats || []), ...(porSubs || []), ...(porTiempo || []), ...topVideos]) videoStats[v.id] = v;
  return {
    days: d,
    period: {
      views: period.views || 0,
      watchHours: Math.round((period.estimatedMinutesWatched || 0) / 60),
      avgViewDuration: Math.round(period.averageViewDuration || 0),
      avgViewPct: Math.round((period.averageViewPercentage || 0) * 10) / 10,
      subsGained: period.subscribersGained || 0,
      subsLost: period.subscribersLost || 0,
      subsNet: (period.subscribersGained || 0) - (period.subscribersLost || 0),
      likes: period.likes || 0,
      comments: period.comments || 0,
      shares: period.shares || 0,
      engagedViews, // CONCILIAR-YT-1 · null si Google no lo devolvió: el panel no pinta un 0 falso
    },
    // CONCILIAR-YT-1 · ventana pedida, último día con datos y cuándo se consultó, para que cada
    // cifra pueda decir su fecha de actualización.
    window: { from: base.startDate, to: base.endDate },
    lastDataDate,
    prev, // PORTADA-YT-1 · null si no hay periodo anterior comparable
    topSubs, // PORTADA-YT-1 · null si ningún vídeo trajo suscriptores en el rango
    fetchedAt: Date.now(),
    series, traffic, devices, geography, age, gender,
    subscribed: { subscribed: subYes, notSubscribed: subNo },
    trafficVideos, // ORIGEN-YT-1 · de cuántos vídeos (de los 10 más vistos) se sabe qué fuentes sumaron
    topVideos,
    videoRank, videoStats, // VIDEOS-YT-1
    recentMeasured: recOk, // VIDEOS-YT-1 · false: las cifras de los recientes no han llegado
    shortsKnown: shortsOk, // VIDEOS-YT-1 · false: el formato se ha deducido por la duración
  };
}

// ===== Comentarios (lectura + respuesta pública) =====
//
// YouTube NO tiene webhooks de comentarios: WebSub/PubSubHubbub solo avisa de
// vídeos nuevos. El único patrón posible es POLLING (ver youtube-comments.ts).
//
// Cuota (bucket general de 10.000 unidades/día, compartido por proyecto):
//   commentThreads.list =  1 unidad · comments.insert = 50 unidades
// → techo teórico ~200 respuestas/día. Responder comentarios NO requiere la
//   compliance audit de YouTube (esa restricción es exclusiva de videos.insert).

export interface YtComment {
  /** Id del hilo = id del comentario de nivel superior. Es el `parentId` al responder. */
  id: string;
  text: string;
  author: string;
  /** Canal del autor. Sirve para NO respondernos a nosotros mismos. */
  authorChannelId: string;
  videoId: string;
  publishedAt: number;
}

/** Páginas como mucho por lectura: tope duro de cuota (1 unidad por página). */
const YT_COMMENTS_MAX_PAGES = 5;
/** Comentarios como mucho por lectura, sumando todas las páginas. */
const YT_COMMENTS_HARD_CAP = 100;

/**
 * Comentarios de nivel superior más recientes del canal (todos sus vídeos).
 * `allThreadsRelatedToChannelId` cubre el canal entero con 1 sola llamada
 * (1 unidad) en vez de una por vídeo. La API NO tiene filtro `publishedAfter`:
 * pedimos por fecha descendente y el filtrado por fecha lo hace el caller.
 *
 * PAGINACIÓN (YT-INGESTA-1) · Con una sola página, un canal con más comentarios
 * nuevos que `max` entre dos polls pierde los MÁS ANTIGUOS para siempre: caen
 * de la lista antes de que el poller los vea y nunca se responden. Por eso
 * seguimos `nextPageToken` hasta que:
 *   · aparece un comentario con publishedAt <= sinceMs (order=time es
 *     descendente → a partir de ahí todo es viejo; el corte va DENTRO del
 *     bucle, si no gastaríamos las 5 páginas siempre),
 *   · o se agotan las páginas / el tope duro de comentarios.
 * Coste: 1 unidad de cuota por página (máx. 5). Esto solo amplía lo que se LEE:
 * las RESPUESTAS las siguen limitando PER_TICK_CAP y dailyCap del poller.
 *
 * @param sinceMs Marca de agua en epoch ms; 0 = sin corte por fecha (una página).
 */
export async function youtubeListRecentComments(accountId: string, max = 20, sinceMs = 0): Promise<YtComment[]> {
  const acc = youtubeListAccounts().find((a) => a.id === accountId);
  if (!acc) return [];
  // DIAGNOSTICO-YT-1 · Un canal sin channelId devolvía [] EN SILENCIO: el dueño veía
  // el canal conectado, el poller "no hacía nada" y no había ni una línea con la que
  // diagnosticarlo. Ahora queda en Actividad y el canal ya no pasa youtubeCanWrite().
  if (!acc.channelId) {
    console.warn(`[youtube] el canal "${acc.title || acc.id}" no tiene channelId: no se pueden leer sus comentarios.`);
    await logActivity({
      source: "yt-send",
      level: "warn",
      summary: "Canal de YouTube conectado sin identificar (falta channelId): no se pueden leer sus comentarios, hay que reconectarlo",
      payload: { file: "youtube.ts", fn: "youtubeListRecentComments", accountId: acc.id, title: acc.title || "" },
    }).catch(() => { /* la telemetría nunca rompe la lectura */ });
    return [];
  }
  const token = await refreshAccess(acc);
  if (!token) return [];
  const perPage = Math.max(1, Math.min(100, max));
  const out: YtComment[] = [];
  let pageToken = "";
  let pages = 0;
  let hitOld = false;

  while (pages < YT_COMMENTS_MAX_PAGES && out.length < YT_COMMENTS_HARD_CAP && !hitOld) {
    const params: Record<string, string> = {
      part: "snippet",
      allThreadsRelatedToChannelId: acc.channelId,
      order: "time",
      maxResults: String(perPage),
      textFormat: "plainText",
    };
    if (pageToken) params.pageToken = pageToken;
    const qs = new URLSearchParams(params).toString();
    const res = await ytFetch(`https://www.googleapis.com/youtube/v3/commentThreads?${qs}`, {
      headers: { Authorization: "Bearer " + token },
    });
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`commentThreads.list ${res.status}: ${d?.error?.message || "error"}`);
    }
    pages++;
    for (const it of (d.items || []) as any[]) {
      const s = it.snippet?.topLevelComment?.snippet || {};
      const c: YtComment = {
        id: String(it.snippet?.topLevelComment?.id || it.id || ""),
        text: String(s.textOriginal || s.textDisplay || ""),
        author: String(s.authorDisplayName || ""),
        authorChannelId: String(s.authorChannelId?.value || ""),
        videoId: String(it.snippet?.videoId || s.videoId || ""),
        publishedAt: Date.parse(String(s.publishedAt || "")) || 0,
      };
      if (!c.id) continue;
      // Corte por fecha DENTRO del bucle: en cuanto vemos uno igual o más
      // viejo que la marca de agua, el resto también lo es (order=time).
      // publishedAt===0 es una fecha ilegible: no corta (el caller ya lo filtra).
      if (sinceMs > 0 && c.publishedAt > 0 && c.publishedAt <= sinceMs) { hitOld = true; break; }
      out.push(c);
      if (out.length >= YT_COMMENTS_HARD_CAP) break;
    }
    pageToken = String(d.nextPageToken || "");
    if (!pageToken) break;
  }
  return out;
}

/** Responde públicamente a un comentario (como el canal). 50 unidades de cuota. */
export async function youtubeReplyToComment(accountId: string, parentId: string, text: string): Promise<void> {
  const acc = youtubeListAccounts().find((a) => a.id === accountId);
  if (!acc) throw new Error("canal de YouTube no encontrado");
  if (!acc.channelId) {
    throw new Error(`el canal "${acc.title || acc.id}" quedó conectado sin identificar (falta su channelId) — reconéctalo en Conexiones → YouTube`);
  }
  if (!youtubeCanWrite(acc)) {
    throw new Error(`el canal "${acc.title || acc.channelId}" está conectado solo para lectura — reconéctalo para poder responder comentarios`);
  }
  const token = await refreshAccess(acc);
  if (!token) throw new Error("sin token de YouTube");
  const res = await ytFetch("https://www.googleapis.com/youtube/v3/comments?part=snippet", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ snippet: { parentId, textOriginal: text } }),
  });
  if (!res.ok) {
    const d: any = await res.json().catch(() => ({}));
    // CUOTA-YT-1 · Google pone el motivo REAL en error.errors[0].reason
    // (quotaExceeded, commentsDisabled, forbidden, processingFailure...). Sin
    // él, quien llama no puede distinguir "este vídeo no admite comentarios"
    // (saltar y seguir) de "la cuota del proyecto está agotada" (parar el
    // poller: cada claim que consuma después se pierde para siempre). Lo
    // prefijamos como 'yt:<reason>: ' para que el caller clasifique sin volver
    // a hablar con Google.
    const reason = String(d?.error?.errors?.[0]?.reason || "");
    const msg = `comments.insert ${res.status}: ${d?.error?.message || "error"}`;
    const hint =
      reason === "quotaExceeded"
        ? "La cuota diaria del proyecto de Google (10.000 unidades/día) está agotada; se restablece a medianoche. Cada respuesta cuesta 50 unidades: baja el tope diario del flujo de YouTube en Flujos."
        : reason === "commentsDisabled"
          ? "Ese vídeo tiene los comentarios desactivados en YouTube: no se puede responder ahí."
          : reason === "forbidden"
            ? "El canal no tiene permiso de escritura. Reconéctalo en Conexiones → YouTube para conceder force-ssl."
            : "";
    await logActivity({
      source: "yt-send",
      level: "error",
      summary: "No se pudo responder al comentario de YouTube: " + msg.slice(0, 140),
      payload: {
        file: "youtube.ts",
        fn: "youtubeReplyToComment",
        accountId,
        parentId,
        textPreview: String(text || "").slice(0, 120),
        error: msg.slice(0, 400),
        hint,
      },
    }).catch(() => { /* la telemetría nunca rompe el envío */ });
    // RELANZAR: el poller necesita el fallo (lo clasifica por el prefijo 'yt:').
    // Si lo tragáramos aquí, el comentario quedaría dado por respondido.
    throw new Error(reason ? "yt:" + reason + ": " + msg : msg);
  }
  await logActivity({
    source: "yt-send",
    level: "info",
    summary: "Respuesta publicada en YouTube",
    payload: {
      file: "youtube.ts",
      fn: "youtubeReplyToComment",
      accountId,
      parentId,
      textPreview: String(text || "").slice(0, 120),
    },
  }).catch(() => { /* la telemetría nunca rompe el envío */ });
}

/** Desconecta UN canal (por id) o TODOS si no se pasa id. */
export async function youtubeDisconnect(accountId?: string): Promise<void> {
  // CUENTAS-ATOMICO-1 · también dentro del cerrojo: desconectar mientras se refrescaba
  // un token devolvía a la vida el canal desconectado (el refresco reescribía el array
  // entero desde una copia leída antes del borrado).
  if (!accountId) {
    await withKeyLock(CLAVE_YT, async () => {
      await set("youtube.accounts", "");
      for (const k of ["youtube.accessToken", "youtube.refreshToken", "youtube.tokenExpiry", "youtube.channelId", "youtube.channelTitle", "youtube.channelThumb"]) await set(k, "");
    });
    return;
  }
  await conCuentas((accts) => {
    const i = accts.findIndex((a) => a.id === accountId);
    if (i >= 0) accts.splice(i, 1);
  });
}
