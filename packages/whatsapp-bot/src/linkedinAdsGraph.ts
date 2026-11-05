/**
 * Cliente HTTP compartido para la LinkedIn Marketing API (REST versionada).
 * Calca el contrato de metaAdsGraph.ts: nunca lanza, devuelve { ok, data, error,
 * status }, reintenta solo 429 + 5xx, y loguea fallos SIN el bearer token.
 *
 * Diferencias vs Meta Graph:
 *   - Base: https://api.linkedin.com/rest/ (versionada por HEADER, no por path).
 *   - Auth: header `Authorization: Bearer <token>` (NO en query string).
 *   - Headers obligatorios: `LinkedIn-Version: YYYYMM` + `X-Restli-Protocol-Version: 2.0.0`.
 *   - El token se PASA explícito por opts.token (linkedinAds.ts lo refresca antes
 *     de cada llamada; a diferencia de Meta, el token de LinkedIn caduca y se
 *     refresca, así que no usamos un resolver síncrono inyectado).
 *   - Rest.li usa sintaxis estructurada en la query (List(...), (key:value)) que
 *     NO se percent-encodea en sus partes estructurales; los call-sites construyen
 *     el path ya listo y aquí no lo tocamos.
 */
import { logActivity } from "./activity.js";

/** Versión de la LinkedIn Marketing API (formato YYYYMM). LinkedIn hace SUNSET duro
 *  de cada versión a los ~12 meses → hay que fijar una VIGENTE al activar. Se lee de
 *  env LINKEDIN_API_VERSION para poder actualizarla SIN redeploy el día que el owner
 *  apruebe la app (el default se quedará viejo con el tiempo). */
export const LINKEDIN_VERSION = (process.env.LINKEDIN_API_VERSION || "202606").trim();
export const LINKEDIN_BASE = "https://api.linkedin.com/rest";

/** Resultado unificado de toda llamada LinkedIn: nunca lanza, siempre devuelve esto. */
export interface LiResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /** HTTP status del último intento (0 = error de red sin respuesta). */
  status?: number;
}

export interface LiOpts {
  /** Bearer (access token) — obligatorio en la práctica; lo resuelve linkedinAds.ts. */
  token?: string;
  /** Override de versión LinkedIn-Version. Default: LINKEDIN_VERSION. */
  version?: string;
  /** Timeout en ms por intento individual (default 15s). */
  timeoutMs?: number;
}

const MAX_ATTEMPTS = 3;          // 1 inicial + 2 reintentos
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2000;

function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}
function backoffMs(attempt: number): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
  const jitter = Math.floor(Math.random() * 100);
  return exp + jitter;
}
function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function headers(opts?: LiOpts): Record<string, string> {
  const h: Record<string, string> = {
    "LinkedIn-Version": (opts?.version || LINKEDIN_VERSION).trim(),
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };
  if (opts?.token) h["Authorization"] = `Bearer ${opts.token}`;
  return h;
}

/** El path nunca lleva token; el bearer va en header → el log del path es seguro. */
function safePath(path: string): string {
  return (path || "").slice(0, 160);
}

/** Extrae un mensaje de error legible del cuerpo LinkedIn (message/serviceErrorCode). */
function errMsg(d: any, status: number): string {
  if (!d) return `HTTP ${status}`;
  const m = d.message || d.error_description || d.error;
  const code = d.serviceErrorCode ? ` (code ${d.serviceErrorCode})` : "";
  return m ? `${m}${code}` : `HTTP ${status}`;
}

export async function liGet<T = unknown>(path: string, opts?: LiOpts): Promise<LiResult<T>> {
  const url = `${LINKEDIN_BASE}/${path}`;
  const timeoutMs = opts?.timeoutMs ?? 15000;
  let lastStatus = 0;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, { headers: headers(opts), signal: AbortSignal.timeout(timeoutMs) });
      lastStatus = r.status;
      const d: any = await r.json().catch(() => ({}));
      if (r.ok && !d?.serviceErrorCode) return { ok: true, data: d as T, status: r.status };
      const msg = errMsg(d, r.status);
      lastErr = msg;
      if (!isRetryableStatus(r.status) || attempt === MAX_ATTEMPTS) {
        await _logFailure("GET", path, r.status, msg);
        return { ok: false, error: msg, status: r.status };
      }
      await sleep(backoffMs(attempt));
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt === MAX_ATTEMPTS) {
        await _logFailure("GET", path, lastStatus, lastErr);
        return { ok: false, error: lastErr, status: lastStatus };
      }
      await sleep(backoffMs(attempt));
    }
  }
  return { ok: false, error: lastErr || "liGet exhausted retries", status: lastStatus };
}

export async function liPost<T = unknown>(path: string, body: Record<string, unknown>, opts?: LiOpts): Promise<LiResult<T>> {
  const url = `${LINKEDIN_BASE}/${path}`;
  const timeoutMs = opts?.timeoutMs ?? 15000;
  let lastStatus = 0;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: headers(opts),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = r.status;
      const d: any = await r.json().catch(() => ({}));
      if (r.ok && !d?.serviceErrorCode) return { ok: true, data: d as T, status: r.status };
      const msg = errMsg(d, r.status);
      lastErr = msg;
      if (!isRetryableStatus(r.status) || attempt === MAX_ATTEMPTS) {
        await _logFailure("POST", path, r.status, msg);
        return { ok: false, error: msg, status: r.status };
      }
      await sleep(backoffMs(attempt));
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt === MAX_ATTEMPTS) {
        await _logFailure("POST", path, lastStatus, lastErr);
        return { ok: false, error: lastErr, status: lastStatus };
      }
      await sleep(backoffMs(attempt));
    }
  }
  return { ok: false, error: lastErr || "liPost exhausted retries", status: lastStatus };
}

export async function _logFailure(method: "GET" | "POST", path: string, status: number, error: string): Promise<void> {
  try {
    // source 'app' (el CHECK de app_activity_log no incluye 'linkedin-api'); el
    // summary ya identifica la plataforma. Nunca logueamos el bearer.
    await logActivity({
      source: "app",
      level: "error",
      status: status ? String(status) : null,
      summary: `LinkedIn ${method} ${safePath(path)} → ${error || "error"}`.slice(0, 200),
      payload: { method, path: safePath(path), status, provider: "linkedin", _redacted: ["access_token"] },
    });
  } catch {
    /* telemetría jamás propaga */
  }
}
