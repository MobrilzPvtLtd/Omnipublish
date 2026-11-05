/**
 * meta-ads-pro FASE A1 — Cliente HTTP compartido para Meta Graph (Marketing API).
 *
 * Antes vivían 2 implementaciones casi-idénticas de fetch a Graph: metaAds.ts
 * (lectura, función `g`) y metaAdsManage.ts (read+write, `graphGet`/`graphPost`),
 * cada una con su propio manejo de errores y SIN reintentos. Las nuevas piezas
 * del módulo (audiences, creatives, experiments, alerts) lo iban a duplicar
 * por tercera vez. Esto centraliza el cliente:
 *
 *   - graphGet / graphPost / graphDelete con el MISMO contrato { ok, data, error }.
 *   - Bearer token resuelto desde `opts.token` o, si no, desde el creds() ws-aware
 *     del módulo metaAds.ts (que ya respeta runWithAdsAccount ALS de BIG-3).
 *   - Retry exponencial 2 reintentos para 429 + 5xx (back-off 250ms→500ms con
 *     jitter). 4xx ≠ 429 NO se reintentan (errores de cliente, no recuperables).
 *   - logActivity({ source:'meta-api', level:'error' }) en cada fallo final, con
 *     payload mínimo (path + status) y SIN incluir el bearer token (filtramos
 *     access_token de path y body antes de loguear).
 *
 * No-objetivos:
 *   - NO cambia la versión de la Graph API: usa la misma que el resto del repo
 *     (v21.0). El spec original mencionaba v22.0 pero el repo no tiene una sola
 *     referencia a v22.0 — cambiar versión silenciosamente rompería contratos
 *     con tokens emitidos contra v21.0. Si en el futuro queremos bump global,
 *     se hace en un commit dedicado a tocar TODOS los call-sites.
 *   - NO sustituye los call-sites del repo legacy (admin.ts, leadsAds.ts,
 *     instagram.ts, etc.): esos viven fuera del scope de meta-ads-pro y se
 *     refactorizarán en su propia pieza si procede. Aquí solo cubrimos
 *     metaAds.ts y los nuevos módulos que añade meta-ads-pro.
 */
import { logActivity } from "./activity.js";

/**
 * Versión de la Graph API. ÚNICA fuente de verdad para los módulos de
 * meta-ads-pro. Cambiar aquí afecta a todos los nuevos consumidores
 * (audiences/creatives/experiments/alerts) en bloque.
 */
export const GRAPH_VERSION = "v21.0";
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** Resultado unificado de toda llamada Graph: nunca lanza, siempre devuelve esto. */
export interface GraphResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /** HTTP status del último intento (0 = error de red sin respuesta). */
  status?: number;
}

/** Opciones comunes a graphGet/graphPost/graphDelete. */
export interface GraphOpts {
  /** Bearer (access_token) explícito. Si se omite, lo resuelve creds() del módulo metaAds.ts. */
  token?: string;
  /** Override de versión (p.ej. `v18.0` para endpoints legacy). Default: GRAPH_VERSION. */
  version?: string;
  /** Timeout en ms por intento individual (default 15s). */
  timeoutMs?: number;
}

// ---- Resolución del bearer token ---------------------------------------
//
// Para no crear dependencia circular metaAdsGraph ↔ metaAds, el resolver del
// token se inyecta en ARRANQUE desde metaAds.ts (que conoce el AsyncLocalStorage
// adsAccALS y la cascada creds() ws-aware). Si nadie lo inyectó (tests
// unitarios aislados, scripts), cae a "" y el caller debe pasar opts.token.

type TokenResolver = () => string;
let resolveToken: TokenResolver = () => "";

/**
 * Registra el resolver de token. Lo llama metaAds.ts al cargar el módulo
 * para que graphGet/graphPost respeten runWithAdsAccount ALS sin tener que
 * importar AsyncLocalStorage aquí.
 */
export function _setTokenResolver(fn: TokenResolver): void {
  resolveToken = fn;
}

function pickToken(opts?: GraphOpts): string {
  if (opts?.token) return opts.token;
  try {
    return resolveToken() || "";
  } catch {
    return "";
  }
}

function baseFor(opts?: GraphOpts): string {
  const v = (opts?.version || GRAPH_VERSION).trim();
  return `https://graph.facebook.com/${v}`;
}

// ---- Retry + back-off --------------------------------------------------
//
// Política conservadora: 2 reintentos extra (3 intentos totales) y SOLO para
// errores transitorios — 429 (rate limit) y 5xx (server side de Meta). 4xx
// distintos de 429 son errores de cliente (token inválido, permisos, parámetro
// mal formado) y reintentarlos solo malgasta cuota.

const MAX_ATTEMPTS = 3;          // 1 inicial + 2 reintentos
const BASE_BACKOFF_MS = 250;     // crece exponencial: 250 → 500 → 1000
const MAX_BACKOFF_MS = 2000;

function isRetryableStatus(status: number): boolean {
  // 429 (rate limit) NO se reintenta: reintentar un rate-limit contra Meta solo
  // multiplica ×3 las llamadas fallidas que cuentan en el error rate. Solo 5xx.
  if (status >= 500 && status < 600) return true;
  return false;
}

function backoffMs(attempt: number): number {
  // attempt = 1 → 250+jitter, 2 → 500+jitter. Capado a MAX_BACKOFF_MS.
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
  const jitter = Math.floor(Math.random() * 100);
  return exp + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ---- Filtros anti-leak del token ---------------------------------------
//
// El path y los bodies pueden contener `access_token=...` (legacy) o un campo
// `access_token` en el JSON (graphPost). Antes de loguear filtramos.

function safePath(path: string): string {
  if (!path) return "";
  return path.replace(/access_token=[^&]+/gi, "access_token=__REDACTED__");
}

// ---- Error-rate guard (Marketing API) ----------------------------------
//
// Meta deniega el "Marketing API standard access tier" si el error rate de la app
// en sus últimas ~500 llamadas a la Ads API es demasiado alto. La fuente nº1 de
// llamadas fallidas es el trabajo en SEGUNDO PLANO (warmer de analítica cada 2 min
// por TODOS los workspaces + alertas) que pega a Graph aunque el WS no tenga token
// de ads o el token esté caducado → 400 OAuthException garantizado por tick.
//
// Estrategia (cero-regresión: solo evita llamadas que IBAN a fallar):
//   1) Preflight: si NO hay token, o el path apunta a `act_/` (cuenta vacía), o el
//      token está en cooldown de 'muerto', CORTOCIRCUITAR sin fetch y sin loguear
//      (no cuenta como error en Meta).
//   2) Circuit-breaker: un token que devuelve OAuthException (190/104/102/463/467/
//      2500 = inválido/caducado/permiso) se marca 'muerto' un rato; sus llamadas se
//      saltan hasta que el operador reconecte. Corta el goteo permanente de 190.

// ERROR-RATE 2026-07-12 · 30 min era demasiado corto: un token invalidado de forma
// PERMANENTE (p.ej. el owner cambió su contraseña de Facebook → código 190) volvía a
// fallar en cada expiración del cooldown = ~88 llamadas fallidas/día alimentando el
// error-rate que Meta mira para el Marketing API tier — y con el token muerto no hay
// llamadas exitosas que lo diluyan (rate ≈ 100%). markTokenDead solo se dispara con
// errores de credencial permanentes (isAuthError), así que 24h es seguro: un falso
// positivo se auto-sana en 1 día, y al reconectar (token NUEVO) la clave hash cambia
// y las llamadas se reanudan al instante sin esperar el cooldown.
const DEAD_TOKEN_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 h
const deadTokens = new Map<string, number>();  // hash(token) → expiry ts (no guardamos el token en claro)

function tokKey(t: string): string {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return String(h);
}
function isTokenDead(t: string): boolean {
  if (!t) return false;
  const exp = deadTokens.get(tokKey(t));
  if (exp == null) return false;
  if (Date.now() > exp) { deadTokens.delete(tokKey(t)); return false; }
  return true;
}
function markTokenDead(t: string): void {
  if (t) deadTokens.set(tokKey(t), Date.now() + DEAD_TOKEN_COOLDOWN_MS);
}
const AUTH_ERROR_CODES = new Set([190, 102, 104, 463, 467, 2500]);
function isAuthError(d: any, status: number): boolean {
  const code = Number(d?.error?.code);
  if (AUTH_ERROR_CODES.has(code)) return true;
  if (status === 400 && String(d?.error?.type || "") === "OAuthException") return true;
  return false;
}

/** Decide si NO llamar a Graph (evita el fetch que contaría como error en Meta). */
function preflight<T>(path: string, token: string): GraphResult<T> | null {
  if (!token) return { ok: false, error: "no-credentials", status: 0 };
  if (/(^|\/)act_(\/|\?|$)/.test(path)) return { ok: false, error: "no-ad-account", status: 0 };
  if (isTokenDead(token)) return { ok: false, error: "credentials-cooldown", status: 0 };
  return null;
}

// ---- graphGet ----------------------------------------------------------

/**
 * GET a Graph. `path` puede ser ya con query (`act_X/insights?fields=...`) o
 * sin query si se pasa el objeto `query`. NUNCA lanza: devuelve GraphResult.
 *
 * Reintentos: solo 429 + 5xx. 4xx distintos de 429 fallan al primer intento.
 */
export async function graphGet<T = unknown>(
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>,
  opts?: GraphOpts,
): Promise<GraphResult<T>> {
  const token = pickToken(opts);
  const pf = preflight<T>(path, token);
  if (pf) return pf; // sin token/cuenta/token muerto → no llamamos (no cuenta como error)
  const base = baseFor(opts);
  // Construye URL con query si la hay. Mantiene el `?` que ya pudiera estar
  // en path (algunos call-sites lo pasan así para conservar el formato Graph).
  let url = `${base}/${path}`;
  if (query && Object.keys(query).length) {
    const sep = path.includes("?") ? "&" : "?";
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qs) url += `${sep}${qs}`;
  }
  if (token) {
    const sep = url.includes("?") ? "&" : "?";
    url += `${sep}access_token=${encodeURIComponent(token)}`;
  }
  const timeoutMs = opts?.timeoutMs ?? 15000;

  let lastStatus = 0;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      lastStatus = r.status;
      const d: any = await r.json().catch(() => ({}));
      if (r.ok && !d?.error) return { ok: true, data: d as T, status: r.status };
      // Meta devuelve a veces 200 con d.error → tratar como error.
      const msg = d?.error?.message || `HTTP ${r.status}`;
      lastErr = msg;
      if (isAuthError(d, r.status)) markTokenDead(token);
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
  // Defensivo: el loop siempre debería haber retornado antes.
  return { ok: false, error: lastErr || "graphGet exhausted retries", status: lastStatus };
}

// ---- graphPost ---------------------------------------------------------

/**
 * POST JSON a Graph. `body` se serializa con JSON.stringify y se le añade
 * `access_token`. Si el caller ya puso `access_token` en body, gana el suyo.
 *
 * Reintentos: igual que graphGet — solo 429+5xx.
 *
 * El mensaje de error compone message + error_user_title + error_user_msg,
 * que es lo que metaAdsManage.ts ya hacía y nos da pistas accionables a
 * nivel UI (p.ej. "tu cuenta está bloqueada por política X").
 */
export async function graphPost<T = unknown>(
  path: string,
  body: Record<string, unknown>,
  opts?: GraphOpts,
): Promise<GraphResult<T>> {
  const token = pickToken(opts);
  const pf = preflight<T>(path, token);
  if (pf) return pf;
  const base = baseFor(opts);
  const url = `${base}/${path}`;
  const payload: Record<string, unknown> = { ...body };
  if (token && payload.access_token == null) payload.access_token = token;
  const timeoutMs = opts?.timeoutMs ?? 15000;

  let lastStatus = 0;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = r.status;
      const d: any = await r.json().catch(() => ({}));
      if (r.ok && !d?.error) return { ok: true, data: d as T, status: r.status };
      const e = d?.error || {};
      const msg = [e.message, e.error_user_title, e.error_user_msg]
        .filter(Boolean)
        .join(" · ") || `HTTP ${r.status}`;
      lastErr = msg;
      if (isAuthError(d, r.status)) markTokenDead(token);
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
  return { ok: false, error: lastErr || "graphPost exhausted retries", status: lastStatus };
}

// ---- graphDelete -------------------------------------------------------

/**
 * DELETE a Graph (usado por adcreatives/customaudiences cuando el módulo
 * tenga que limpiar entidades creadas). Marketing API acepta DELETE en el
 * id-as-path con `access_token` por query. Mismas reglas de retry.
 */
export async function graphDelete<T = unknown>(
  path: string,
  opts?: GraphOpts,
): Promise<GraphResult<T>> {
  const token = pickToken(opts);
  const pf = preflight<T>(path, token);
  if (pf) return pf;
  const base = baseFor(opts);
  let url = `${base}/${path}`;
  if (token) {
    const sep = url.includes("?") ? "&" : "?";
    url += `${sep}access_token=${encodeURIComponent(token)}`;
  }
  const timeoutMs = opts?.timeoutMs ?? 15000;

  let lastStatus = 0;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, {
        method: "DELETE",
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = r.status;
      const d: any = await r.json().catch(() => ({}));
      if (r.ok && !d?.error) return { ok: true, data: d as T, status: r.status };
      const msg = d?.error?.message || `HTTP ${r.status}`;
      lastErr = msg;
      if (isAuthError(d, r.status)) markTokenDead(token);
      if (!isRetryableStatus(r.status) || attempt === MAX_ATTEMPTS) {
        await _logFailure("DELETE", path, r.status, msg);
        return { ok: false, error: msg, status: r.status };
      }
      await sleep(backoffMs(attempt));
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt === MAX_ATTEMPTS) {
        await _logFailure("DELETE", path, lastStatus, lastErr);
        return { ok: false, error: lastErr, status: lastStatus };
      }
      await sleep(backoffMs(attempt));
    }
  }
  return { ok: false, error: lastErr || "graphDelete exhausted retries", status: lastStatus };
}

// ---- Logging unificado de fallos ---------------------------------------
//
// Se exporta como `_logFailure` (con underscore = uso interno) para que los
// tests puedan stubear el sink si hace falta. NO loguea bearer NUNCA: solo
// método, path saneado y status.

export async function _logFailure(
  method: "GET" | "POST" | "DELETE",
  path: string,
  status: number,
  error: string,
): Promise<void> {
  try {
    await logActivity({
      source: "meta-api",
      level: "error",
      status: status ? String(status) : null,
      summary: `Graph ${method} ${safePath(path).slice(0, 120)} → ${error || "error"}`.slice(0, 200),
      payload: {
        method,
        path: safePath(path),
        status,
        // NUNCA bearer aquí. Lo recordamos en payload para que un auditor lo vea.
        _redacted: ["access_token"],
      },
    });
  } catch {
    /* telemetría jamás propaga */
  }
}
