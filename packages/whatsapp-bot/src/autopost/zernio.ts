/**
 * Proveedor de publicación: Zernio (SaaS gestionado, ex-"Late").
 * El usuario crea una cuenta en zernio.com, copia su API key y conecta sus redes
 * (OAuth alojado por Zernio) DESDE el business-stack. Publicaciones ilimitadas en
 * el plan gratis para 2 cuentas; 14+ redes.
 *
 * API (docs.zernio.com): base https://zernio.com/api/v1 · auth Authorization: Bearer <key>
 *   - GET  /profiles                      → perfiles (workspaces); usamos el primero
 *   - GET  /accounts                      → cuentas sociales conectadas
 *   - GET  /connect/{platform}?profileId= → URL OAuth para conectar una red
 *   - POST /posts                         → publica {content, publishNow, platforms[], media[]}
 *
 * Devolvemos las MISMAS formas que upload.ts (ConnectedAccount / UploadResult)
 * para que el orquestador y la UI traten todos los proveedores igual.
 */
import { fetchConReintentos } from "../net-retry.js";
import { utmTagUrls } from "../links.js";
import { get as getAjuste } from "../settings.js";
import { captionWarnings, type ConnectedAccount, type PerPlatform, type UploadResult } from "./upload.js";

const API_BASE = "https://zernio.com/api/v1";

// Nuestra plataforma → identificador de Zernio (X usa "twitter" en Zernio).
const TO_ZERNIO: Record<string, string> = {
  instagram: "instagram", facebook: "facebook", linkedin: "linkedin",
  // LinkedIn PÁGINA: la misma red en Zernio, pero otra cuenta (bloque 3) → nombre propio nuestro.
  linkedin_pagina: "linkedin",
  x: "twitter", tiktok: "tiktok", youtube: "youtube", threads: "threads",
  pinterest: "pinterest", bluesky: "bluesky", reddit: "reddit",
  telegram: "telegram", discord: "discord", whatsapp: "whatsapp",
  google_business: "google",
};
// Reverso para etiquetar lo que devuelve Zernio.
const FROM_ZERNIO: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [ours, z] of Object.entries(TO_ZERNIO)) if (ours !== "linkedin_pagina") m[z] = ours;
  m["twitter"] = "x"; m["google"] = "google_business";
  return m;
})();

const authHeader = (key: string) => ({ Authorization: `Bearer ${key}` });
const norm = (p: string) => FROM_ZERNIO[String(p).toLowerCase()] || String(p).toLowerCase();

/**
 * RECONECTAR-RED-2 · el plan gratis (2 redes por cuenta) bloquea TODA llamada de conexión en
 * una cuenta llena, también la de renovar una red que ya está dentro (402 free_tier_exceeded).
 */
function esPlanLleno(status: number, raw: string): boolean {
  if (status !== 402) return false;
  try { const j = JSON.parse(raw); return String(j?.reason || "").toLowerCase() === "free_tier_exceeded" || String(j?.code || "").toUpperCase() === "PAYMENT_REQUIRED"; }
  catch { return true; }
}

/** Quita una cuenta de Zernio (DELETE /v1/accounts/{id}). true si la quitó o ya no estaba. */
export async function zernioDisconnectAccount(key: string, accountId: string): Promise<boolean> {
  if (!key || !accountId) return false;
  try {
    const res = await fetchConReintentos(`${API_BASE}/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE", headers: authHeader(key) });
    return res.ok || res.status === 404;
  } catch { return false; }
}

/** Convierte un error de la API de Zernio en un mensaje claro en español para el panel. */
function zernioFriendlyError(status: number, raw: string): string {
  let j: any = {};
  try { j = JSON.parse(raw); } catch { /* no-JSON */ }
  const code = String(j?.code || "").toUpperCase();
  const reason = String(j?.reason || "").toLowerCase();
  if (status === 402 || code === "PAYMENT_REQUIRED" || reason === "free_tier_exceeded") {
    return "El plan gratis de Zernio permite solo 2 cuentas conectadas. Para conectar más redes, añade un método de pago en tu cuenta de Zernio (o desconecta una red para liberar hueco).";
  }
  if (status === 401 || status === 403) {
    return "La API key de Zernio no es válida o no tiene permisos. Revísala en zernio.com → API Keys.";
  }
  if (j && typeof j.error === "string" && j.error.trim()) return j.error.trim();
  return `Zernio devolvió ${status}${raw ? ": " + raw.slice(0, 160) : ""}`;
}

// --- Reparto de redes en bloques (= cuentas Zernio) ---
// Cada cuenta Zernio gratis admite ≤2 redes, así que repartimos las redes en bloques
// para que todo quede en plan gratis. El panel lo presenta como UNA sola integración
// (sin mencionar Zernio ni los bloques): por dentro cada red usa la clave de su bloque.
//   bloque 0 → autopost.zernioApiKey   (Facebook, Instagram)
//   bloque 1 → autopost.zernioKey2     (LinkedIn, TikTok)
//   bloque 2 → autopost.zernioKey3     (YouTube, LinkedIn PÁGINA)
// «linkedin_pagina» es la Página de empresa de LinkedIn: en Zernio es la red `linkedin`, pero
// conectada en la cuenta del bloque 2 (la del bloque 1 lleva el perfil personal). Cada bloque
// solo tiene UNA cuenta de LinkedIn, así que publicar con la clave del bloque elige la correcta.
// Instagram publica por la Graph API nativa (autopost/index.ts y scheduler.ts); su plaza en el
// bloque 0 queda como RESPALDO si Meta rechaza la publicación. X NO va por Zernio: se publica
// por Upload-Post (autopost/xpublish.ts).
export const ZERNIO_BLOCKS: string[][] = [
  ["facebook", "instagram"],
  ["linkedin", "tiktok"],
  ["youtube", "linkedin_pagina"],
];
/** Clave de settings de cada bloque (índice → setting key). */
export const ZERNIO_BLOCK_SETTING: string[] = ["autopost.zernioApiKey", "autopost.zernioKey2", "autopost.zernioKey3"];
/** Índice de bloque (0..2) que gestiona una plataforma, o -1 si no está repartida. */
export function platformBlock(platform: string): number {
  const p = String(platform).toLowerCase();
  return ZERNIO_BLOCKS.findIndex((b) => b.includes(p));
}
/** Todas las plataformas cubiertas por la distribución de bloques. */
export const ZERNIO_PLATFORMS: string[] = ZERNIO_BLOCKS.flat();

export interface ZernioAccount { accountId: string; platform: string; name: string; image?: string; }

function pickArray(j: any): any[] {
  if (Array.isArray(j)) return j;
  return j?.accounts || j?.data || j?.profiles || j?.results || [];
}

/** Primer profileId (workspace) de la cuenta Zernio — necesario para conectar redes. */
export async function zernioDefaultProfile(key: string): Promise<string | null> {
  try {
    const res = await fetchConReintentos(`${API_BASE}/profiles`, { headers: authHeader(key) });
    if (!res.ok) return null;
    const arr = pickArray(await res.json());
    const p = arr[0];
    return p ? String(p.id ?? p.profileId ?? "") || null : null;
  } catch { return null; }
}

const profileIdOf = (p: any): string => String(p?.id ?? p?.profileId ?? p?._id ?? "");
const profileNameOf = (p: any): string => String(p?.name ?? p?.title ?? p?.label ?? "").trim().toLowerCase();

/** Lista los profiles de la cuenta Zernio (best-effort, [] si falla). */
async function listProfiles(key: string): Promise<any[]> {
  try {
    const r = await fetchConReintentos(`${API_BASE}/profiles`, { headers: authHeader(key) });
    if (!r.ok) return [];
    return pickArray(await r.json());
  } catch { return []; }
}

/**
 * Garantiza un profile de Zernio para este workspace. NO crea a ciegas: primero
 * REUTILIZA el que ya exista (por id guardado, por nombre, o el primero/default de
 * la cuenta) y solo crea uno si la cuenta no tiene ninguno. Con el modelo "1 cuenta
 * Zernio por workspace", lo normal es reutilizar el profile por defecto de la cuenta.
 * (Antes intentaba crear siempre → 400 "A profile with this name already exists".)
 */
export async function ensureProfile(
  key: string,
  name: string,
  existingId?: string,
): Promise<{ ok: boolean; profileId?: string; error?: string }> {
  if (!key) return { ok: false, error: "Falta la API key de Zernio" };
  const wanted = (name || "").trim().toLowerCase();
  try {
    const list = await listProfiles(key);
    // 1) id guardado y sigue presente → úsalo.
    if (existingId && list.some((p) => profileIdOf(p) === existingId)) return { ok: true, profileId: existingId };
    // 2) ya hay un profile con ese nombre → reutilízalo (no recrear).
    const byName = wanted ? list.find((p) => profileNameOf(p) === wanted) : undefined;
    if (byName && profileIdOf(byName)) return { ok: true, profileId: profileIdOf(byName) };
    // 3) cuenta dedicada por workspace → reutiliza su primer profile (default).
    if (list.length && profileIdOf(list[0])) return { ok: true, profileId: profileIdOf(list[0]) };
    // 4) cuenta sin profiles → crea uno.
    const res = await fetchConReintentos(`${API_BASE}/profiles`, {
      method: "POST",
      headers: { ...authHeader(key), "Content-Type": "application/json" },
      body: JSON.stringify({ name: name || "Negocio" }),
    });
    const raw = await res.text();
    let j: any = {}; try { j = JSON.parse(raw); } catch { /* */ }
    if (res.ok) {
      const id = profileIdOf(j) || profileIdOf(j?.profile);
      if (id) return { ok: true, profileId: id };
    }
    // 5) Falló el create (p. ej. "already exists" por carrera) o no devolvió id →
    //    re-lista y usa el que matchee por nombre o el primero.
    const after = await listProfiles(key);
    const m = (wanted ? after.find((p) => profileNameOf(p) === wanted) : undefined) || after[0];
    if (m && profileIdOf(m)) return { ok: true, profileId: profileIdOf(m) };
    return { ok: false, error: `Zernio /profiles devolvió ${res.status}${raw ? ": " + raw.slice(0, 140) : ""}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** Lista las cuentas sociales conectadas en Zernio (forma ConnectedAccount del panel). */
export async function listZernioAccounts(
  key: string,
  profileId?: string,
  blk?: number,
): Promise<{ accounts: ConnectedAccount[]; degraded: boolean }> {
  if (!key) return { accounts: [], degraded: true };
  try {
    const qs = profileId ? `?profileId=${encodeURIComponent(profileId)}` : "";
    const res = await fetchConReintentos(`${API_BASE}/accounts${qs}`, { headers: authHeader(key) });
    if (!res.ok) return { accounts: [], degraded: true };
    const arr = pickArray(await res.json());
    // RECONECTAR-RED-1 · Zernio sigue listando la cuenta cuando la red retira el permiso
    // (cambio de contraseña, caducidad): lo dice con needsReconnection o isActive=false.
    // Las cuentas de LinkedIn del bloque que lleva «linkedin_pagina» SON la Página.
    const esPagina = blk !== undefined && !!ZERNIO_BLOCKS[blk] && ZERNIO_BLOCKS[blk].includes("linkedin_pagina");
    const accounts: ConnectedAccount[] = arr.map((a: any) => ({
      platform: ((p) => (esPagina && p === "linkedin" ? "linkedin_pagina" : p))(norm(a.platform ?? a.provider ?? a.type ?? "")),
      displayName: String(a.name ?? a.username ?? a.handle ?? a.displayName ?? a.platform ?? "cuenta"),
      image: a.avatar ?? a.image ?? a.picture ?? a.profilePicture ?? undefined,
      accountId: String(a._id ?? a.id ?? a.accountId ?? "") || undefined,
      needsReconnect: a.needsReconnection === true || a.isActive === false,
    }));
    return { accounts, degraded: false };
  } catch { return { accounts: [], degraded: true }; }
}

/** Test de conexión: ¿la API key es válida? */
export async function testZernio(key: string): Promise<{ ok: boolean; channels: number; error?: string }> {
  if (!key) return { ok: false, channels: 0, error: "Falta la API key de Zernio" };
  try {
    const res = await fetchConReintentos(`${API_BASE}/accounts`, { headers: authHeader(key) });
    if (!res.ok) { const raw = await res.text().catch(() => ""); return { ok: false, channels: 0, error: zernioFriendlyError(res.status, raw) }; }
    return { ok: true, channels: pickArray(await res.json()).length };
  } catch (e) { return { ok: false, channels: 0, error: (e as Error).message }; }
}

/**
 * Genera la URL OAuth para conectar una red en Zernio desde el business-stack.
 * Con `reconnectAccountId` renueva el permiso de ESA cuenta (conserva su id y su historial)
 * en vez de añadir otra de la misma red.
 */
export async function zernioConnectUrl(
  key: string,
  platform: string,
  profileId?: string,
  opts: { reconnectAccountId?: string } = {},
): Promise<{ ok: boolean; url?: string; error?: string; code?: "free_tier" }> {
  if (!key) return { ok: false, error: "Falta la API key de Zernio" };
  const z = TO_ZERNIO[platform] || platform;
  try {
    const pid = profileId || (await zernioDefaultProfile(key));
    const q = new URLSearchParams();
    if (pid) q.set("profileId", pid);
    if (opts.reconnectAccountId) q.set("reconnectAccountId", opts.reconnectAccountId);
    const qs = q.toString() ? "?" + q.toString() : "";
    const res = await fetchConReintentos(`${API_BASE}/connect/${encodeURIComponent(z)}${qs}`, { headers: authHeader(key) });
    const raw = await res.text();
    if (!res.ok) return { ok: false, error: zernioFriendlyError(res.status, raw), code: esPlanLleno(res.status, raw) ? "free_tier" : undefined };
    let j: any = {}; try { j = JSON.parse(raw); } catch { /* podría ser texto/redirect */ }
    const url = j.url || j.authUrl || j.redirectUrl || (raw.startsWith("http") ? raw.trim() : "");
    if (!url) return { ok: false, error: "Zernio no devolvió la URL OAuth" };
    return { ok: true, url };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export interface ZernioPublishOpts {
  key: string;
  platforms: string[];          // nuestras plataformas elegidas (instagram, x, ...)
  caption: string;
  mediaUrls: string[];          // URLs públicas de los medios (por URL)
  profileId?: string;           // profile (workspace) del que tomar las cuentas
  // T04 · tipo real del medio. Antes se declaraba SIEMPRE 'image': un Reel
  // programado hacia TikTok/YouTube viajaba etiquetado como imagen y YouTube
  // (que solo acepta vídeo) no podía publicarse nunca.
  mediaType?: "image" | "video";
  // HISTORIAS-1 · "story" = historia de Facebook (24 h). Las demás redes no la admiten por API.
  contentType?: "story";
  // PORTADA-1 · portada propia (URL pública) o fotograma en ms. Cada red la toma de un sitio:
  // TikTok en sus ajustes; Facebook, LinkedIn y YouTube (vídeos normales, no Shorts) en el medio.
  coverUrl?: string;
  coverOffsetMs?: number;
  // TEXTO-POR-RED-1 · texto de cada red (nuestros nombres: instagram, facebook…). La que lo
  // trae distinto del general lo recibe como customContent de su destino.
  captions?: Record<string, string>;
  // YT-PRIMER-COMENTARIO-1 · YouTube: primer comentario que Zernio publica y fija
  // (platformSpecificData.firstComment, máx. 10.000 caracteres).
  ytFirstComment?: string;
  // COMENTARIO-FIJADO-1 · primer comentario por red de Zernio (youtube, linkedin, facebook). Sustituye a
  // ytFirstComment cuando viene; el enlace lleva utm_source=<red> salvo <red>.utm=off.
  firstComments?: Record<string, string>;
}

/**
 * Publica AHORA en Zernio. Resuelve las cuentas conectadas que matchean las
 * plataformas pedidas y crea un post inmediato con las imágenes (por URL).
 */
export async function zernioPublish(opts: ZernioPublishOpts): Promise<UploadResult> {
  const { key, platforms, caption, mediaUrls, profileId, mediaType, contentType, coverUrl, coverOffsetMs, captions, ytFirstComment, firstComments } = opts;
  if (!key) throw new Error("Falta la API key de Zernio");
  if (!platforms.length) throw new Error("No hay plataformas activas");

  const wantZ = new Set(platforms.map((p) => TO_ZERNIO[p] || p));

  // ZERNIO-ACCID-2026-06-04: extraer el id de la cuenta probando MUCHOS campos.
  // Zernio devuelve la cuenta pero antes solo miraba a.id / a.accountId; si el
  // schema usa _id / socialId / connectionId / uid / etc. quedaba "" y el
  // filter la rechazaba (-> targets=0 aunque la platform matchease).
  const extractAccId = (a: any): string => {
    const candidates = [a?.id, a?.accountId, a?._id, a?.socialId, a?.connectionId, a?.uid, a?.userId, a?.accId, a?.providerAccountId, a?.profileId, a?.externalId];
    for (const c of candidates) {
      const s = c == null ? "" : String(c).trim();
      if (s) return s;
    }
    return "";
  };
  // Helper: lee /accounts y filtra por platform match.
  const fetchAccs = async (pid: string | undefined): Promise<{ accs: any[]; targets: Array<{ z: string; id: string }>; status: number; rawSample: string }> => {
    const qs = pid ? `?profileId=${encodeURIComponent(pid)}` : "";
    const res = await fetchConReintentos(`${API_BASE}/accounts${qs}`, { headers: authHeader(key) });
    if (!res.ok) return { accs: [], targets: [], status: res.status, rawSample: "" };
    const rawText = await res.text();
    let parsed: any = {};
    try { parsed = JSON.parse(rawText); } catch { /* no-JSON */ }
    const accs = pickArray(parsed);
    const targets = accs
      .map((a: any) => ({ z: String(a.platform ?? a.provider ?? a.type ?? "").toLowerCase(), id: extractAccId(a) }))
      .filter((t) => t.id && wantZ.has(t.z));
    return { accs, targets, status: res.status, rawSample: rawText.slice(0, 400) };
  };

  // 1) Intento principal con el profileId guardado.
  let { accs, targets, status: accStatus, rawSample } = await fetchAccs(profileId);
  if (accStatus !== 200 && accStatus !== 0) {
    throw new Error(`Zernio /accounts devolvio ${accStatus}`);
  }
  console.log(`[ZERNIO accounts] profile=${profileId || "default"} accountsInProfile=${accs.length} want=${[...wantZ].join(",")} matched=${JSON.stringify(targets)}`);

  const warnings = captionWarnings(caption, platforms);

  // Si Zernio devolvio cuentas pero ninguna matched, comprobar si es por id vacio.
  // El platform si esta en wantZ pero el extract id devolvio "". Eso significa
  // que Zernio uso otro campo desconocido para el id. Listamos las keys del
  // primer objeto para que el user/dev vea el schema real.
  const platformMatched = accs.some((a: any) => wantZ.has(String(a.platform ?? a.provider ?? a.type ?? "").toLowerCase()));
  if (!targets.length && platformMatched && accs.length) {
    const sample = accs.find((a: any) => wantZ.has(String(a.platform ?? a.provider ?? a.type ?? "").toLowerCase())) || accs[0];
    const sampleKeys = Object.keys(sample || {}).join(", ");
    warnings.push(`Zernio devolvio la cuenta de ${[...wantZ].join(",")} pero su id no esta en los campos esperados. Keys del objeto: [${sampleKeys}]. Sample: ${JSON.stringify(sample).slice(0, 240)}`);
  }

  // 2) Fallback diagnostico: si profileId nos dio 0 matches pero teniamos profileId,
  //    reintenta SIN profileId. Si ASI aparece la cuenta, sabemos que el profileId
  //    guardado en business-stack apunta a un profile distinto al que tiene la red
  //    conectada (caso comun: el user creo varios profiles en Zernio).
  let fallbackUsed = false;
  if (!targets.length && profileId) {
    try {
      const r2 = await fetchAccs(undefined);
      if (r2.targets.length) {
        accs = r2.accs;
        targets = r2.targets;
        fallbackUsed = true;
        warnings.push("Esta red estaba enlazada en otro espacio de tu cuenta de publicación. Pulsa «Reconectar» en esta red, en Conexiones › Redes sociales, para dejarla en el sitio correcto.");
      } else {
        // Tampoco sin profileId. Lista lo que SI hay para ayudar al diagnostico.
        accs = r2.accs;
      }
    } catch (e) {
      console.warn(`[ZERNIO accounts fallback] err: ${(e as Error).message}`);
    }
  }

  if (!targets.length) {
    // Diagnostico explicito: el user vera EXACTAMENTE que cuentas devolvio Zernio
    // y que estamos buscando. Asi puede ver si es problema de profileId, de
    // platform-name mismatch, o de que la API key no esta autorizada al profile.
    const availablePlats = [...new Set(accs.map((a: any) => String(a.platform ?? a.provider ?? a.type ?? "").toLowerCase()).filter(Boolean))];
    const diag = `Zernio devolvio ${accs.length} cuenta(s) en profile=${profileId || "default"}: [${availablePlats.join(", ") || "ninguna"}]. Buscabamos: [${[...wantZ].join(", ")}]. Verifica que la API key es de la misma cuenta que tiene esta red, y que el profile elegido en el panel es donde esta conectada.`;
    return { ok: false, status: 0, perPlatform: [], warnings: warnings.concat(diag), raw: "" };
  }

  // Ajustes propios de cada red (platformSpecificData de cada destino).
  const esVideo = mediaType === "video";
  const ajustes = (z: string): Record<string, unknown> | undefined => {
    const a: Record<string, unknown> = {};
    if (z === "facebook" && contentType === "story") a.contentType = "story";
    if (z === "tiktok" && esVideo) {
      if (coverUrl) a.videoCoverImageUrl = coverUrl;
      else if (coverOffsetMs && coverOffsetMs > 0) a.videoCoverTimestampMs = Math.round(coverOffsetMs);
    }
    {
      // ORIGEN-FIJADO-1 · el enlace del comentario fijado lleva utm_source=<red> (dominio real a la vista,
      // sin acortador): así el píxel de la web sabe de dónde viene quien lo pulsa. Se apaga con <red>.utm=off.
      const fc = String((firstComments && firstComments[z]) || (z === "youtube" ? ytFirstComment : "") || "").trim();
      if (fc && contentType !== "story" && (z === "youtube" || z === "linkedin" || z === "facebook")) {
        a.firstComment = (getAjuste(z + ".utm") === "off" ? fc : utmTagUrls(fc, { utm_source: z })).slice(0, 10000);
      }
    }
    return Object.keys(a).length ? a : undefined;
  };
  const body: any = {
    content: caption,
    publishNow: true,
    platforms: targets.map((t: any) => {
      const psd = ajustes(t.z);
      const tg: Record<string, unknown> = { platform: t.z, accountId: t.id };
      if (psd) tg.platformSpecificData = psd;
      const propio = captions ? captions[norm(t.z)] : undefined;
      if (typeof propio === "string" && propio !== caption) tg.customContent = propio;
      return tg;
    }),
  };
  // TIKTOK-MUSICA-1 · carrusel de fotos en TikTok: que TikTok añada música recomendada (auto_add_music).
  // Zernio exige estos campos en tiktokSettings (nivel superior, no en platformSpecificData).
  // Con marca de contenido de marca/comercial TikTok no añade nada: se publica igual, sin música.
  if (mediaType !== "video" && contentType !== "story" && mediaUrls && mediaUrls.length > 1 && targets.some((t: any) => t.z === "tiktok")) {
    body.tiktokSettings = {
      privacy_level: "PUBLIC_TO_EVERYONE", allow_comment: true, media_type: "photo", photo_cover_index: 0,
      auto_add_music: true, content_preview_confirmed: true, express_consent_given: true,
    };
  }
  if (mediaUrls && mediaUrls.length) {
    body.mediaItems = mediaUrls.map((u) => {
      const it: Record<string, unknown> = { type: mediaType || "image", url: u };
      // Portada del vídeo para Facebook, LinkedIn y YouTube (YouTube la ignora en Shorts).
      if (esVideo && coverUrl && contentType !== "story") it.thumbnail = coverUrl;
      return it;
    });
  }

  const pr = await fetchConReintentos(`${API_BASE}/posts`, {
    method: "POST",
    headers: { ...authHeader(key), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await pr.text();
  console.log(`[ZERNIO posts] platforms=${JSON.stringify(body.platforms)} media=${(body.mediaItems || []).length} → HTTP ${pr.status}${pr.ok ? "" : " · error=" + JSON.stringify(String((() => { try { const j = JSON.parse(raw); return j.error || j.message || j.detail || ""; } catch { return ""; } })()).slice(0, 300))}`); // PII-LOGS-1: la respuesta trae el texto del post
  let pj: any = {}; try { pj = JSON.parse(raw); } catch { /* respuesta no-JSON */ }
  // Si Zernio devuelve estado por plataforma, lo usamos (no fingimos "ok").
  const resultArr: any[] = Array.isArray(pj.results) ? pj.results : Array.isArray(pj.platforms) ? pj.platforms : [];
  const topErr = pj.error || pj.message || pj.detail;
  const statusFor = (z: string) => resultArr.find((r) => String(r.platform ?? r.provider ?? r.type ?? "").toLowerCase() === z);
  const perPlatform: PerPlatform[] = targets.map((t: any) => {
    const st = statusFor(t.z);
    if (st) {
      const okp = st.ok === true || st.success === true || /ok|success|publish|queued|scheduled|pending/i.test(String(st.status ?? ""));
      return { platform: norm(t.z), ok: okp, message: okp ? String(st.status || "encolado en Zernio") : String(st.error || st.message || st.status || "falló en la red") };
    }
    if (!pr.ok) return { platform: norm(t.z), ok: false, message: topErr ? String(topErr).slice(0, 160) : `Zernio devolvió ${pr.status}` };
    // 2xx sin desglose: Zernio publica en diferido → "encolado", no garantiza que ya esté.
    return { platform: norm(t.z), ok: true, message: "Encolado en Zernio (la publicación real puede tardar unos minutos)" };
  });
  return { ok: pr.ok && !topErr, status: pr.status, perPlatform, warnings, raw: raw.slice(0, 2000) };
}
