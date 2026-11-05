/**
 * meta-ads-pro FASE A3 — Creative Library (Marketing API).
 *
 * Tabla `app_ads_creatives` guarda los assets (imagen/video/carousel/copy) en
 * estado `draft` con URL local (mientras no se han subido) o `synced` con
 * `meta_id` (ad image hash o video id) tras llegar a la cuenta publicitaria.
 *
 * Este modulo cubre 3 operaciones contra Graph (Marketing API):
 *   1) uploadImageToMeta  → multipart POST a /act_X/adimages
 *      Devuelve { hash, url } para que la podamos referenciar luego al crear
 *      un adcreative (BIG-4 / pieza futura).
 *   2) uploadVideoToMeta  → POST /act_X/advideos (async)
 *      Sube el binario y luego hace polling cada 2s al endpoint
 *      /<video_id>?fields=status hasta status.video_status='ready' o
 *      tiempo agotado (90s).
 *   3) syncCreativeToMeta → toma una row draft de app_ads_creatives, descarga
 *      el binario desde el URL local guardado, llama a la API correcta segun
 *      el type (image/video) y actualiza meta_id+status='synced' o
 *      status='failed' en caso de error.
 *
 * Convencion comun:
 *   - Cada helper recibe `adAccountId` (sin prefijo). Internamente prefijamos
 *     `act_` (igual que metaAdsAudiences). El caller (endpoint REST) ya validó
 *     ownership contra el WS activo via `adAccountBelongsToWorkspace`.
 *   - Errores se TRAGAN aqui y se devuelven como `{ ok:false, error }` +
 *     `logActivity({ source:"meta-api", level:"error" })`. NUNCA bearer en el
 *     payload — lo dejamos en `_redacted:["access_token"]` por trazabilidad.
 *
 * NO objetivo de A3:
 *   - Crear adcreatives finales (el objeto en Graph que une imagen + copy +
 *     CTA + page) — eso es la pieza A4. Aqui solo gestionamos el "raw asset
 *     hash" o "video id" que A4 referenciara.
 */
import { logActivity } from "./activity.js";
import { graphGet, GRAPH_BASE } from "./metaAdsGraph.js";
import { get as getSetting } from "./settings.js";
import {
  dbGetCreative,
  dbUpdateCreativeStatus,
  type AdsCreativeRow,
} from "./db.js";

/** Resultado uniforme: { ok, data?, error? }. */
export interface CreativesResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Limite de subida por type. 30 MB imagen, 4 GB video (Meta lo permite). */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Prefija `act_` si no esta y lo blinda contra `act_act_X` (el caller suele
 * pasar el id desnudo). Devuelve null si no hay nada utilizable.
 */
function actPath(adAccountId?: string): string | null {
  const id = String(adAccountId || "").trim() || getSetting("meta.adAccountId");
  if (!id) return null;
  const clean = id.startsWith("act_") ? id.slice(4) : id;
  return `act_${clean}`;
}

/**
 * Resuelve el bearer Meta del WS activo. Identico patron a metaAdsAudiences:
 * sin token no llamamos a la red — devolvemos error claro.
 */
function tokenFromSettings(): string {
  return String(getSetting("meta.adsToken") || "");
}

// ---- uploadImageToMeta -------------------------------------------------

/**
 * Sube una imagen al endpoint /act_X/adimages. Multipart (no JSON): Meta
 * exige un campo con el filename como key. La respuesta tiene la forma:
 *
 *   { images: { "<filename>": { hash, url, width, height } } }
 *
 * Extraemos la primera entrada (sólo subimos un fichero por llamada).
 *
 * NO usamos graphPost porque ese es JSON; aqui necesitamos FormData nativo.
 * Pero seguimos la misma politica:
 *   - timeout 60s (subidas grandes 4-30 MB tardan mas que un GET).
 *   - logActivity en fallo.
 *   - NUNCA bearer en el payload del log.
 */
export async function uploadImageToMeta(input: {
  adAccountId: string;
  fileBuffer: Buffer;
  filename: string;
  contentType?: string;
}): Promise<CreativesResult<{ hash: string; url: string; width?: number; height?: number }>> {
  const act = actPath(input.adAccountId);
  if (!act) return { ok: false, error: "meta_ads_account_missing" };
  const token = tokenFromSettings();
  if (!token) return { ok: false, error: "meta_ads_not_configured" };
  if (!input.fileBuffer || input.fileBuffer.length === 0) {
    return { ok: false, error: "file_empty" };
  }
  if (input.fileBuffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: "file_too_large" };
  }

  const filename = String(input.filename || "image.jpg").replace(/[^\w.\-]/g, "_");
  const contentType = String(input.contentType || "image/jpeg");

  // FormData nativo de Node 18+ (autopost/upload.ts ya lo usa contra
  // Upload-Post). Meta acepta el field-name = filename.
  const fd = new FormData();
  // Usamos Uint8Array clonado del Buffer para que Blob no lance error
  // si el caller reutiliza el buffer (defensivo, mismo patron que upload.ts).
  const blob = new Blob([new Uint8Array(input.fileBuffer)], { type: contentType });
  fd.append(filename, blob, filename);
  // access_token como query (multipart no permite mezclar) para no inyectarlo
  // en el body (donde igual quedaria en el log si Meta lo eco-pintase).
  const url = `${GRAPH_BASE}/${act}/adimages?access_token=${encodeURIComponent(token)}`;

  try {
    const r = await fetch(url, {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(60_000),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok || d?.error) {
      const msg = d?.error?.message || `HTTP ${r.status}`;
      await logActivity({
        source: "meta-api",
        level: "error",
        summary: `creatives:image upload failed — ${msg}`.slice(0, 200),
        payload: {
          adAccountId: input.adAccountId,
          filename,
          size: input.fileBuffer.length,
          status: r.status,
          _redacted: ["access_token"],
        },
      });
      return { ok: false, error: msg };
    }
    // Meta devuelve { images: { "<filename>": { hash, url, width, height } } }
    const imgs: Record<string, any> = (d?.images || {}) as Record<string, any>;
    const first = Object.values(imgs)[0];
    if (!first || !first.hash) {
      await logActivity({
        source: "meta-api",
        level: "error",
        summary: `creatives:image upload — respuesta sin hash`,
        payload: { adAccountId: input.adAccountId, filename, _redacted: ["access_token"] },
      });
      return { ok: false, error: "graph_response_missing_hash" };
    }
    return {
      ok: true,
      data: {
        hash: String(first.hash),
        url: String(first.url || ""),
        width: first.width != null ? Number(first.width) : undefined,
        height: first.height != null ? Number(first.height) : undefined,
      },
    };
  } catch (e) {
    const msg = (e as Error).message || "fetch failed";
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `creatives:image upload exception — ${msg}`.slice(0, 200),
      payload: { adAccountId: input.adAccountId, filename, _redacted: ["access_token"] },
    });
    return { ok: false, error: msg };
  }
}

// ---- uploadVideoToMeta -------------------------------------------------

/**
 * Sube un video a /act_X/advideos. Devuelve `{ id }` inmediatamente (Meta lo
 * encola en su pipeline de transcoding); el video NO es usable como creative
 * hasta status.video_status='ready'.
 *
 * Polling: 2s entre intentos, max 45 ciclos (~90s). Si pasa de 90s lo
 * dejamos en `processing` y devolvemos `ok:true` con `videoId` + flag —
 * el caller decide si reintentar (sync manual) o aceptar el estado parcial.
 *
 * NO subimos en chunks (resumable upload session) en esta version: para
 * <500 MB Meta acepta single-shot. La pieza A3.b (futura) puede añadir
 * resumable si subimos videos largos de >500 MB.
 */
export async function uploadVideoToMeta(input: {
  adAccountId: string;
  fileBuffer: Buffer;
  filename: string;
  contentType?: string;
}): Promise<CreativesResult<{ videoId: string; ready: boolean }>> {
  const act = actPath(input.adAccountId);
  if (!act) return { ok: false, error: "meta_ads_account_missing" };
  const token = tokenFromSettings();
  if (!token) return { ok: false, error: "meta_ads_not_configured" };
  if (!input.fileBuffer || input.fileBuffer.length === 0) {
    return { ok: false, error: "file_empty" };
  }
  if (input.fileBuffer.length > MAX_VIDEO_BYTES) {
    return { ok: false, error: "file_too_large" };
  }

  const filename = String(input.filename || "video.mp4").replace(/[^\w.\-]/g, "_");
  const contentType = String(input.contentType || "video/mp4");

  const fd = new FormData();
  const blob = new Blob([new Uint8Array(input.fileBuffer)], { type: contentType });
  // /advideos espera el campo `source`.
  fd.append("source", blob, filename);
  const url = `${GRAPH_BASE}/${act}/advideos?access_token=${encodeURIComponent(token)}`;

  let videoId = "";
  try {
    // Subidas grandes — timeout largo (10 min).
    const r = await fetch(url, {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok || d?.error) {
      const msg = d?.error?.message || `HTTP ${r.status}`;
      await logActivity({
        source: "meta-api",
        level: "error",
        summary: `creatives:video upload failed — ${msg}`.slice(0, 200),
        payload: {
          adAccountId: input.adAccountId,
          filename,
          size: input.fileBuffer.length,
          status: r.status,
          _redacted: ["access_token"],
        },
      });
      return { ok: false, error: msg };
    }
    videoId = String(d?.id || "");
    if (!videoId) return { ok: false, error: "graph_response_missing_video_id" };
  } catch (e) {
    const msg = (e as Error).message || "fetch failed";
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `creatives:video upload exception — ${msg}`.slice(0, 200),
      payload: { adAccountId: input.adAccountId, filename, _redacted: ["access_token"] },
    });
    return { ok: false, error: msg };
  }

  // Polling status.video_status hasta ready o timeout 90s.
  const POLL_INTERVAL_MS = 2000;
  const POLL_MAX_TRIES = 45;
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
    const s = await graphGet<{ status?: { video_status?: string } }>(videoId, {
      fields: "status",
    });
    if (!s.ok) {
      // Errores transitorios pueden venir mientras Meta procesa. Si no
      // recuperable, salimos con ready:false (el caller puede reintentar).
      continue;
    }
    const vs = String(s.data?.status?.video_status || "").toLowerCase();
    if (vs === "ready") return { ok: true, data: { videoId, ready: true } };
    if (vs === "error") {
      await logActivity({
        source: "meta-api",
        level: "error",
        summary: `creatives:video transcoding error videoId=${videoId}`,
        payload: { adAccountId: input.adAccountId, videoId, _redacted: ["access_token"] },
      });
      return { ok: false, error: "video_transcoding_error" };
    }
    // processing/upload/expired/etc → seguimos esperando.
  }
  // Timeout sin ready: aun asi devolvemos el id (parcialmente sincronizado).
  return { ok: true, data: { videoId, ready: false } };
}

// ---- syncCreativeToMeta ------------------------------------------------

/**
 * Sincroniza una row `app_ads_creatives` (status='draft') hacia Meta.
 * Flujo:
 *   1) Lee la row por id.
 *   2) Marca status='syncing' (idempotente — si vuelve a entrar antes de
 *      acabar, la transicion sigue siendo coherente).
 *   3) Descarga el binario desde row.url (tipicamente storage local /uploads
 *      del propio servicio; si es S3/CDN, el fetch resuelve igual).
 *   4) Segun row.type:
 *        - 'image'    → uploadImageToMeta → guarda hash en meta_id.
 *        - 'video'    → uploadVideoToMeta → guarda video_id en meta_id.
 *        - 'carousel' → POR DEFINIR (cada item se sube por separado en A3.b).
 *                       Aqui marcamos 'failed' con error claro.
 *        - 'copy'     → no requiere upload (no hay binario). Lo marcamos
 *                       'synced' sin meta_id — el copy vive en row.body.
 *   5) UpdateStatus a 'synced' (con meta_id) o 'failed'.
 *
 * El caller (endpoint POST /sync) puede llamar await directamente: devuelve
 * el row final actualizado. Para no bloquear UI, el endpoint REST lo dispara
 * con `void` y responde 202 + job_id (que aqui es el creativeId).
 */
export async function syncCreativeToMeta(
  creativeId: string,
  tenantId: string,
): Promise<CreativesResult<{ meta_id: string | null; status: string }>> {
  const id = String(creativeId || "").trim();
  if (!id) return { ok: false, error: "creativeId_required" };
  const tenant = String(tenantId || "").trim() || "default";

  const row = await dbGetCreative({ id, tenantId: tenant });
  if (!row) return { ok: false, error: "creative_not_found" };
  if (!row.ad_account_id) return { ok: false, error: "creative_missing_ad_account" };

  // Estado intermedio para que la UI pueda mostrar spinner; idempotente.
  await dbUpdateCreativeStatus({ id, tenantId: tenant, status: "syncing" });

  try {
    // copy: nada que subir.
    if (row.type === "copy") {
      await dbUpdateCreativeStatus({ id, tenantId: tenant, status: "synced", meta_id: null });
      return { ok: true, data: { meta_id: null, status: "synced" } };
    }

    if (row.type === "carousel") {
      // En A3 los carousels se construyen como adcreative agregando varias
      // imagenes ya subidas (cada child es un creative type=image). Aqui no
      // sabemos como son los hijos — la pieza A3.b lo modelara.
      await dbUpdateCreativeStatus({
        id,
        tenantId: tenant,
        status: "failed",
        error: "carousel_sync_not_implemented",
      });
      return { ok: false, error: "carousel_sync_not_implemented" };
    }

    if (!row.url) {
      await dbUpdateCreativeStatus({
        id,
        tenantId: tenant,
        status: "failed",
        error: "missing_url",
      });
      return { ok: false, error: "missing_url" };
    }

    // Descarga el binario desde la URL guardada en storage.
    let buf: Buffer;
    try {
      const dl = await fetch(row.url, { signal: AbortSignal.timeout(120_000) });
      if (!dl.ok) {
        await dbUpdateCreativeStatus({
          id,
          tenantId: tenant,
          status: "failed",
          error: `download_${dl.status}`,
        });
        return { ok: false, error: `download_failed_${dl.status}` };
      }
      const ab = await dl.arrayBuffer();
      buf = Buffer.from(ab);
    } catch (e) {
      const msg = (e as Error).message || "download exception";
      await dbUpdateCreativeStatus({
        id,
        tenantId: tenant,
        status: "failed",
        error: msg.slice(0, 200),
      });
      return { ok: false, error: msg };
    }

    if (row.type === "image") {
      const out = await uploadImageToMeta({
        adAccountId: row.ad_account_id,
        fileBuffer: buf,
        filename: row.name || "image.jpg",
      });
      if (!out.ok) {
        await dbUpdateCreativeStatus({
          id,
          tenantId: tenant,
          status: "failed",
          error: (out.error || "upload_failed").slice(0, 200),
        });
        return { ok: false, error: out.error };
      }
      await dbUpdateCreativeStatus({
        id,
        tenantId: tenant,
        status: "synced",
        meta_id: out.data!.hash,
      });
      return { ok: true, data: { meta_id: out.data!.hash, status: "synced" } };
    }

    if (row.type === "video") {
      const out = await uploadVideoToMeta({
        adAccountId: row.ad_account_id,
        fileBuffer: buf,
        filename: row.name || "video.mp4",
      });
      if (!out.ok) {
        await dbUpdateCreativeStatus({
          id,
          tenantId: tenant,
          status: "failed",
          error: (out.error || "upload_failed").slice(0, 200),
        });
        return { ok: false, error: out.error };
      }
      // Aunque ready=false, guardamos el videoId — el panel puede mostrar
      // "procesando en Meta" y reintentar mas tarde si hace falta.
      await dbUpdateCreativeStatus({
        id,
        tenantId: tenant,
        status: "synced",
        meta_id: out.data!.videoId,
      });
      return { ok: true, data: { meta_id: out.data!.videoId, status: "synced" } };
    }

    // type desconocido (defensivo — el CHECK de la tabla deberia haberlo
    // rechazado al insertar).
    await dbUpdateCreativeStatus({
      id,
      tenantId: tenant,
      status: "failed",
      error: `unknown_type_${row.type}`,
    });
    return { ok: false, error: "unknown_type" };
  } catch (e) {
    const msg = (e as Error).message || "sync exception";
    await dbUpdateCreativeStatus({
      id,
      tenantId: tenant,
      status: "failed",
      error: msg.slice(0, 200),
    });
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `creatives:sync exception — ${msg}`.slice(0, 200),
      payload: { creativeId: id, _redacted: ["access_token"] },
    });
    return { ok: false, error: msg };
  }
}

// ---- Re-export type para callers ---------------------------------------

export type { AdsCreativeRow };
