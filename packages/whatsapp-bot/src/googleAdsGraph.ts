/**
 * Cliente HTTP compartido para la Google Ads API (REST + GAQL searchStream).
 * Mismo contrato que metaAdsGraph/linkedinAdsGraph: nunca lanza, { ok, data,
 * error, status }, retry 429 + 5xx, log sin bearer.
 *
 * Google Ads NO es query-string tipo Graph: se consulta con GAQL vía POST a
 * customers/{id}/googleAds:searchStream. Requiere 3 credenciales:
 *   - Authorization: Bearer <access token OAuth> (scope adwords, refrescado)
 *   - developer-token: <token del operador, aprobado por Google>
 *   - login-customer-id: <MCC sin guiones> (cuando la cuenta cuelga de un manager)
 */
import { logActivity } from "./activity.js";

/** Versión de la Google Ads API. Google deja de servir versiones antiguas cada ~year
 *  (deprecación por trimestres) → hay que fijar una VIGENTE al activar. Se lee de env
 *  GOOGLE_ADS_API_VERSION para actualizarla SIN redeploy cuando el owner apruebe el
 *  developer token (el default se quedará viejo con el tiempo). */
export const GOOGLE_ADS_VERSION = (process.env.GOOGLE_ADS_API_VERSION || "v17").trim();
export const GOOGLE_ADS_BASE = "https://googleads.googleapis.com";

export interface GaResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
}

export interface GaOpts {
  accessToken: string;
  developerToken: string;
  /** MCC sin guiones. Opcional (solo cuentas bajo un manager). */
  loginCustomerId?: string;
  version?: string;
  timeoutMs?: number;
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2000;

function isRetryableStatus(s: number): boolean {
  return s === 429 || (s >= 500 && s < 600);
}
function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 100);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function headers(opts: GaOpts): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${opts.accessToken}`,
    "developer-token": opts.developerToken,
    "Content-Type": "application/json",
  };
  const login = (opts.loginCustomerId || "").replace(/[^0-9]/g, "");
  if (login) h["login-customer-id"] = login;
  return h;
}

function base(opts: GaOpts): string {
  return `${GOOGLE_ADS_BASE}/${(opts.version || GOOGLE_ADS_VERSION).trim()}`;
}

/** Mensaje de error legible del cuerpo Google Ads (error.message / details). */
function errMsg(d: any, status: number): string {
  const m = d?.error?.message || d?.[0]?.error?.message || d?.error_description || d?.error;
  return m ? String(m) : `HTTP ${status}`;
}

/** GET (para customers:listAccessibleCustomers). */
export async function gaGet<T = unknown>(path: string, opts: GaOpts): Promise<GaResult<T>> {
  const url = `${base(opts)}/${path}`;
  const timeoutMs = opts.timeoutMs ?? 15000;
  let lastStatus = 0, lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, { headers: headers(opts), signal: AbortSignal.timeout(timeoutMs) });
      lastStatus = r.status;
      const d: any = await r.json().catch(() => ({}));
      if (r.ok && !d?.error) return { ok: true, data: d as T, status: r.status };
      const msg = errMsg(d, r.status);
      lastErr = msg;
      if (!isRetryableStatus(r.status) || attempt === MAX_ATTEMPTS) {
        await _logFailure("GET", path, r.status, msg);
        return { ok: false, error: msg, status: r.status };
      }
      await sleep(backoffMs(attempt));
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt === MAX_ATTEMPTS) { await _logFailure("GET", path, lastStatus, lastErr); return { ok: false, error: lastErr, status: lastStatus }; }
      await sleep(backoffMs(attempt));
    }
  }
  return { ok: false, error: lastErr || "gaGet exhausted", status: lastStatus };
}

/**
 * Ejecuta una consulta GAQL vía searchStream y devuelve las filas aplanadas.
 * searchStream responde un ARRAY de batches [{results:[...]}]; lo aplanamos.
 */
export async function gaSearch(customerId: string, query: string, opts: GaOpts): Promise<GaResult<any[]>> {
  const cid = String(customerId || "").replace(/[^0-9]/g, "");
  const path = `customers/${cid}/googleAds:searchStream`;
  const url = `${base(opts)}/${path}`;
  const timeoutMs = opts.timeoutMs ?? 20000;
  let lastStatus = 0, lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: headers(opts),
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = r.status;
      const d: any = await r.json().catch(() => ({}));
      if (r.ok && !d?.error && !(Array.isArray(d) && d[0]?.error)) {
        const batches = Array.isArray(d) ? d : (d?.results ? [d] : []);
        const rows = batches.flatMap((b: any) => (b?.results ?? []));
        return { ok: true, data: rows, status: r.status };
      }
      const msg = errMsg(d, r.status);
      lastErr = msg;
      if (!isRetryableStatus(r.status) || attempt === MAX_ATTEMPTS) {
        await _logFailure("POST", path, r.status, msg);
        return { ok: false, error: msg, status: r.status };
      }
      await sleep(backoffMs(attempt));
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt === MAX_ATTEMPTS) { await _logFailure("POST", path, lastStatus, lastErr); return { ok: false, error: lastErr, status: lastStatus }; }
      await sleep(backoffMs(attempt));
    }
  }
  return { ok: false, error: lastErr || "gaSearch exhausted", status: lastStatus };
}

export async function _logFailure(method: "GET" | "POST", path: string, status: number, error: string): Promise<void> {
  try {
    await logActivity({
      // source 'app' (el CHECK de app_activity_log no incluye 'googleads-api').
      source: "app",
      level: "error",
      status: status ? String(status) : null,
      summary: `GoogleAds ${method} ${path.slice(0, 120)} → ${error || "error"}`.slice(0, 200),
      payload: { method, path: path.slice(0, 160), status, provider: "google-ads", _redacted: ["access_token", "developer-token"] },
    });
  } catch {
    /* telemetría jamás propaga */
  }
}
