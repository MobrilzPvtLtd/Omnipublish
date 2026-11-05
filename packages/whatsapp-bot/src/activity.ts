/**
 * logs-cola FASE-2: Centro de actividad — helpers de alto nivel.
 *
 * Esta capa es la API "user-friendly" que el resto del backend usa para
 * registrar eventos cross-sistema en app_activity_log (creada en FASE-1).
 * Aporta:
 *
 *   1. `logActivity()`   — wrap silencioso de dbInsertActivity con:
 *        - tenant_id auto desde currentWorkspaceId() (workspace ALS).
 *        - dedup in-memory (60s) — evita ruido por reintentos/loops.
 *        - try/catch total — si la BD está caída NO rompe al caller.
 *
 *   2. Mappers puros (table-row → ActivityEvent[]) para fuentes que ya
 *      tienen su propio histórico (autopost_history, scheduled_posts,
 *      broadcasts, mcp_jobs, lead_jobs). El consumidor (panel) puede
 *      unificar varias fuentes en un mismo feed sin tener que conocer
 *      los esquemas internos de cada tabla.
 *
 * NO crea hooks/triggers aquí — eso es FASE-3 (cablear los call-sites).
 */
import { currentWorkspaceId } from "./workspace.js";
import {
  dbInsertActivity,
  type ActivityRow,
  type ActivitySource as DbActivitySource,
  type ActivityLevel as DbActivityLevel,
} from "./db.js";
// dbListActivity / dbCountActivity / dbActivityCounters se reexportan para
// que el resto del bot tenga una única superficie ("./activity.js") sin
// volver a tocar "./db.js" para queries de actividad.
export {
  dbListActivity,
  dbCountActivity,
  dbActivityCounters,
  // ACTIVIDAD-BORRAR-1 · borrado del registro desde el panel (uno suelto y vaciado).
  // Viven en db.ts como todo el acceso a datos; aquí solo se reexportan, que es por
  // donde admin.ts consume la actividad.
  dbDeleteActivity,
  dbPurgeActivity,
} from "./db.js";

// ---- Tipos públicos ----------------------------------------------------

/**
 * Union literal de las 13 fuentes que reconoce el CHECK de app_activity_log
 * (CREATE TABLE en db.ts initDb()). Cualquier valor fuera de aquí lo rechaza
 * Postgres con CHECK constraint violation — por eso lo retipamos aquí con
 * el mismo set y forzamos el contrato a nivel TS.
 */
export type ActivitySource =
  | "autopost"
  | "scheduled-post"
  | "broadcast"
  | "mcp-job"
  | "lead-job"
  | "webhook"
  | "llm"
  | "meta-api"
  | "wa-send"
  | "ig-send"
  | "fb-send"
  | "yt-send"
  | "newsletter"
  | "app";

/** Niveles canónicos del log. Coinciden 1:1 con el CHECK de la tabla. */
export type ActivityLevel = "info" | "warn" | "error";

/**
 * Evento normalizado server-side. Es exactamente lo que devuelve
 * dbListActivity() (alias estructural de ActivityRow): id + tenant + source
 * + level + status + summary + payload + created_at (epoch ms).
 *
 * Los mappers de abajo devuelven arrays de este tipo para que el panel pueda
 * "fundirlos" con filas reales de app_activity_log sin diferencias de shape.
 */
export interface ActivityEvent {
  id: string;
  tenant_id: string;
  source: ActivitySource;
  level: ActivityLevel;
  status: string | null;
  summary: string;
  payload: Record<string, unknown> | null;
  created_at: number; // epoch ms
}

// Sanity check estructural: si ActivitySource o ActivityLevel divergen de los
// tipos de db.ts, este alias falla en compile-time. Mantiene ambos contratos
// alineados sin esfuerzo manual.
const _checkSource: ActivitySource = "app" as DbActivitySource;
const _checkLevel: ActivityLevel = "info" as DbActivityLevel;
void _checkSource;
void _checkLevel;

// ---- Dedup cache in-memory (60s) ---------------------------------------
//
// Muchas fuentes (workers, schedulers, reintentos) emiten el MISMO evento
// varias veces en pocos segundos (p.ej. "broadcast X falló" tras 3 retries).
// Sin dedup el feed se vuelve ilegible. Política:
//
//   - level = 'error'  → NO se deduplica NUNCA. Los errores son señal valiosa
//     (cada ocurrencia importa para diagnóstico), incluso si comparten
//     summary. Antes 5 errores idénticos en 60s aparecían como 1 → falso
//     "todo bien" → ahora cada error se persiste.
//   - level = 'info' | 'warn' → key = source:level:summary:tenant_id:payloadHash
//     donde payloadHash es 8 hex chars del JSON.stringify(payload) truncado a
//     100 chars (suficiente para discriminar payloads distintos sin reventar
//     el tamaño de la key). Si payload es null/undefined → no hay hash y la
//     key queda como antes (source:level:summary:tenant_id).
//   - Ventana = 60_000 ms (estándar JS Date.now()).
//   - Si la key existe y delta<60s → skip insert (return silencioso).
//   - Si delta>=60s o key nueva → refresh timestamp + insert.
//
// Motivación del payloadHash: antes "Sync MCP fallo en PUT /contacts" con phone
// A y phone B se colapsaban en 1 sola entrada (mismo summary) — perdíamos
// visibilidad de QUÉ contacto falló. Con el hash, summaries iguales pero
// payloads distintos sí se persisten ambos.
//
// El Map se va auto-limpiando: cada inserción nueva refresca su key, y como
// las keys son acotadas (13 sources × 3 levels × N summaries únicos) no
// crece sin control en condiciones normales. Aún así hacemos un sweep
// oportunista para no dejar entradas eternas si una key deja de emitirse.
const DEDUP_WINDOW_MS = 60_000;
const dedupCache = new Map<string, number>();

// Counter monotónico module-level para keys de errores. Antes usábamos
// Math.random() para garantizar unicidad (errores nunca se deduplican), pero
// con suficiente volumen Math.random() puede colisionar dentro del mismo ms
// (paradoja del cumpleaños: ~50% colisión a ~77k errores/ms en base36-6).
// Counter monotónico = id único determinista por proceso, cero colisiones,
// reproducible para debug. Se incrementa con ++_errorCounter antes de leerlo.
let _errorCounter = 0;

/**
 * Sweep oportunista: si el cache supera SWEEP_TRIGGER entries borra las
 * que ya superaron la ventana. Se llama 1 de cada SWEEP_PROB veces para
 * amortizar el coste. No es estrictamente necesario, pero es cinturón y
 * tirantes ante summaries muy variables (p.ej. errores con stack trace).
 */
const SWEEP_TRIGGER = 1000;
function maybeSweepDedup(now: number): void {
  if (dedupCache.size < SWEEP_TRIGGER) return;
  for (const [k, t] of dedupCache) {
    if (now - t >= DEDUP_WINDOW_MS) dedupCache.delete(k);
  }
}

/**
 * Hash corto (8 hex chars) determinístico del payload. Hecho a mano para no
 * añadir dependencia de `crypto.createHash` en el hot-path de telemetría
 * (logActivity se llama muchas veces). Algoritmo: FNV-1a 32-bit sobre el JSON
 * COMPLETO del payload (estable, rapidísimo, sin truncado). No es crypto-seguro
 * — sólo para discriminar payloads distintos en dedup.
 *
 * SEC-FIX 2026-06: antes truncábamos a 100 chars para amortizar el coste,
 * pero eso colapsaba payloads cuyo discriminante (id, phone, slug) caía
 * detrás del char 100 — la dedup los trataba como iguales aunque fueran
 * eventos distintos. Hash sobre payload completo: tradeoff aceptable
 * (payloads >10KB son raros y FNV-1a es lineal y barato).
 */
function shortPayloadHash(payload: Record<string, unknown> | null | undefined): string {
  if (payload == null) return "";
  let s: string;
  try {
    s = JSON.stringify(payload);
  } catch {
    return ""; // payload no serializable (cíclico, BigInt suelto, etc.) → no discriminar
  }
  // FNV-1a 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // toString(16) puede dar <8 hex chars si el hash es pequeño — padStart fija longitud.
  return (h >>> 0).toString(16).padStart(8, "0");
}

function dedupKey(
  source: ActivitySource,
  level: ActivityLevel,
  summary: string,
  tenantId: string,
  payload: Record<string, unknown> | null | undefined,
): string {
  // Errores: NO se deduplican (return key única por timestamp+rand para que
  // nunca colisione con otra). Conservamos el formato general por trazabilidad
  // del cache (debug humano del Map). El timestamp+random hace que la key
  // sea efectivamente única → siempre se inserta.
  if (level === "error") {
    return `${source}:${level}:${summary}:${tenantId}:err-${Date.now()}-${++_errorCounter}`;
  }
  // Info/warn: discriminamos por hash del payload si lo hay (summary+payload
  // distintos = eventos distintos, no se colapsan). Si no hay payload, key
  // legacy (source:level:summary:tenant).
  const hash = shortPayloadHash(payload);
  return hash
    ? `${source}:${level}:${summary}:${tenantId}:${hash}`
    : `${source}:${level}:${summary}:${tenantId}`;
}

// ---- SEC: stripSecrets (defense in depth) ------------------------------
//
// Aunque los call-sites NO deberían inyectar tokens / credenciales en
// `payload`, no podemos confiar 100% — un caller nuevo puede meter un
// access_token de Graph "por debug" y filtrarlo a app_activity_log para
// siempre. Esta función recorre el payload entero (objetos y arrays
// anidados) y reemplaza el VALOR de cualquier clave cuyo nombre matchee
// el set de "claves sensibles" por la cadena '__redacted__'.
//
// Reglas:
//   - Regex aplicada al NOMBRE de la propiedad (case-insensitive).
//   - Sólo se redactan los valores (no se borra la clave) — así el panel
//     ve "access_token: __redacted__" y queda claro que existía pero se
//     anonimizó. Es información útil para depurar sin filtrar el secreto.
//   - Se preservan tipos / estructura: objetos siguen siendo objetos,
//     arrays siguen siendo arrays, no-objetos no se tocan.
//   - Anti loop: WeakSet para no recursar sobre referencias cíclicas.
//
// SEC-AMPLIACIÓN 2026-06: añadimos cookie / sessioncookie / session_cookie /
// phpsessid (sesión Systeme.io), authorization / set_cookie / bearer / auth
// (headers HTTP típicos), csrf / xsrf (anti-CSRF tokens) y client_secret
// (OAuth). Antes un payload con `{cookie: "PHPSESSID=abc..."}` o
// `{authorization: "Bearer eyJ..."}` se persistía en claro en
// app_activity_log — fuga grave si el panel se compromete o se exporta el log.
// Además detectamos valores con prefijo "Bearer " dentro de strings sueltos
// (campos string que arrastran un token sin el name match), redactando el
// trozo del token y conservando el resto del valor para debug.
// ALTA-SELFSERVE-1 · `pin` entra en la lista: el PIN de verificación en dos pasos
// de WhatsApp son SEIS dígitos, y maskPhoneLike se rinde por debajo de siete, así
// que sin esto un pin viajaría legible a app_activity_log y a la vista Actividad.
// SECRETO-CAMEL-1 · el patrón iba anclado al principio de la clave, así que solo
// cazaba el nombre EXACTO (o con el prefijo `x-`). Las claves camelCase que usa medio
// código de integraciones — `appSecret`, `verifyToken`, `pageToken`, `accessToken` de
// un objeto anidado — caían fuera y viajaban EN CLARO a app_activity_log y a la vista
// Actividad. Ahora la clave se normaliza (minúsculas, sin guiones ni guiones bajos) y
// se admite CUALQUIER prefijo antes del término sensible, que es lo que convierte
// `appsecret` en `secret` y `verifytoken` en `token`. El final sigue anclado a
// propósito: sin ese ancla, `author` cazaría por `auth` y se redactaría el autor de
// cada nota.
function claveNormalizada(k: string): string {
  return k.toLowerCase().replace(/[-_\s]/g, "");
}
const SECRET_KEY_RE =
  /^[a-z0-9]*(accesstoken|refreshtoken|pagetoken|token|password|secret|apikey|cookie|sessioncookie|phpsessid|authorization|setcookie|bearer|auth|csrf|xsrf|clientsecret|proxyauthorization|pin|registerpins?|twosteppin)$/;
/** ¿El nombre de este campo delata un secreto? (clave normalizada, ver arriba). */
function esClaveSecreta(k: string): boolean {
  return SECRET_KEY_RE.test(claveNormalizada(k));
}

// Detecta "Bearer <token>" dentro de cualquier string del payload. El token
// se considera "todo lo no-whitespace" tras el literal Bearer. Reemplaza solo
// esa parte (no el string entero) para no perder contexto del mensaje.
const BEARER_VALUE_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]+/gi;

// Detecta asignaciones embebidas tipo `cookie=...`, `phpsessid: ...`,
// `api_key=...`, `session=...`, `token: ...`, `secret=...` dentro de strings
// sueltos (URLs con query, headers serializados, mensajes de error que
// arrastran credenciales). Sólo matchea el VALOR pegado a `=` o `:` (asignación
// inmediata, sin espacio opcional permitido antes del separador) para no
// destrozar URLs HTTP normales tipo `http://host/path?foo=bar` (foo no es
// clave sensible) ni paths que casualmente contengan la palabra "token".
const EMBEDDED_SECRET_VALUE_RE =
  /((?:cookie|phpsessid|session|api[_-]?key|token|secret)[=:]\s*)\S+/gi;

function redactString(s: string): string {
  let out = s.replace(BEARER_VALUE_RE, "Bearer __redacted__");
  out = out.replace(EMBEDDED_SECRET_VALUE_RE, "$1__redacted__");
  return out;
}

export function stripSecrets<T>(input: T, seen: WeakSet<object> = new WeakSet()): T {
  if (input == null) return input;
  if (typeof input === "string") {
    return redactString(input) as unknown as T;
  }
  if (typeof input !== "object") return input;
  const obj = input as unknown as object;
  if (seen.has(obj)) return input; // cycle guard — devuelve tal cual para no romper
  seen.add(obj);
  if (Array.isArray(input)) {
    return (input.map((v) => stripSecrets(v, seen)) as unknown) as T;
  }
  const src = input as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (esClaveSecreta(k)) {
      out[k] = "__redacted__";
    } else if (typeof v === "string") {
      out[k] = redactString(v);
    } else if (v !== null && typeof v === "object") {
      out[k] = stripSecrets(v, seen);
    } else {
      out[k] = v;
    }
  }
  return out as unknown as T;
}

// ---- Redacción EN LECTURA (T06) ----------------------------------------
//
// stripSecrets protege la ruta de ESCRITURA de logActivity, pero el feed del
// panel también sirve payloads que nunca pasaron por ahí: los 5 mappers
// sintéticos copian campos crudos de sus tablas (mcp_jobs.result, errores de
// proveedores…) y dbInsertActivity directo tampoco redacta. Esta función se
// aplica en el endpoint de LECTURA a cada payload antes de responder, para
// que nada sensible viaje al navegador aunque se hubiera persistido en claro.
//
// Además enmascara PII de contacto (teléfonos/emails) SOLO por nombre de
// clave: un match por patrón sobre cualquier dígito rompería ids y
// timestamps (un epoch ms parece un teléfono largo). El summary NO se toca
// aquí: es el texto curado que el admin necesita leer.

const CONTACT_KEY_RE =
  /^(phone|tel|telefono|telephone|msisdn|wa[-_]?id|to[-_]?phone|from[-_]?phone|recipient[-_]?phone|e?[-_]?mail|correo)$/i;

/** '+34612345678' → '+34•••••678' (conserva prefijo y últimos 3 dígitos). */
function maskPhoneLike(v: string): string {
  const digits = v.replace(/\D/g, "");
  if (digits.length < 7) return v; // demasiado corto para ser un teléfono
  let seen = 0;
  const keep = digits.length - 3;
  return v.replace(/\d/g, (d) => (seen++ < keep ? "•" : d));
}

/** 'nombre.apellido@dominio.com' → 'n•••@dominio.com'. */
function maskEmailLike(v: string): string {
  return v.replace(
    /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    "$1•••$2",
  );
}

function maskContactValue(key: string, v: string): string {
  if (/mail|correo/i.test(key)) return maskEmailLike(v);
  return maskPhoneLike(v);
}

function maskContactKeys<T>(input: T, seen: WeakSet<object> = new WeakSet()): T {
  if (input == null || typeof input !== "object") return input;
  const obj = input as unknown as object;
  if (seen.has(obj)) return input;
  seen.add(obj);
  if (Array.isArray(input)) {
    return (input.map((v) => maskContactKeys(v, seen)) as unknown) as T;
  }
  const src = input as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (typeof v === "string" && CONTACT_KEY_RE.test(k)) {
      out[k] = maskContactValue(k, v);
    } else if (v !== null && typeof v === "object") {
      out[k] = maskContactKeys(v, seen);
    } else {
      out[k] = v;
    }
  }
  return out as unknown as T;
}

/**
 * Redacción completa para RESPUESTAS del panel: secretos + PII de contacto.
 * Aplicar sobre el payload de cada evento justo antes de serializarlo.
 */
export function redactPayloadForRead(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (payload == null) return payload;
  try {
    return maskContactKeys(stripSecrets(payload));
  } catch {
    // Ante un payload patológico, mejor no servirlo que servirlo en claro.
    return { __redacted__: "payload no serializable" };
  }
}

// ---- logActivity (API principal) ---------------------------------------

/**
 * Registra un evento en app_activity_log de forma segura para el caller.
 *
 * Contrato:
 *   - tenant_id se infiere automáticamente del workspace ALS activo
 *     (currentWorkspaceId()). Si no hay scope abierto, cae a 'default'.
 *   - level por defecto: 'info'.
 *   - Dedup 60s aplicado ANTES de tocar BD: si la misma combinación
 *     (source+level+summary+tenant) se vio hace <60s, se descarta.
 *   - try/catch total: cualquier error de BD/log se traga con console.warn.
 *     PROHIBIDO que esto rompa el flow del caller (es telemetría, no negocio).
 *
 * Devuelve Promise<void> — al caller no le interesa el row creado; si lo
 * necesita, use dbInsertActivity() directamente.
 */
export async function logActivity(args: {
  source: ActivitySource;
  level?: ActivityLevel;
  status?: string | null;
  summary: string;
  payload?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    const source = args.source;
    const level: ActivityLevel = args.level || "info";
    const summary = String(args.summary || "").trim();
    if (!summary) return; // sin summary no hay evento legible — skip silencioso

    const tenant_id = currentWorkspaceId(); // siempre devuelve string ('default' fail-safe)
    const now = Date.now();
    // Para errores la key incorpora timestamp+random → siempre única → siempre
    // se inserta (sin dedup). Para info/warn la key incluye un hash corto del
    // payload para que summaries iguales con payloads distintos se persistan.
    const key = dedupKey(source, level, summary, tenant_id, args.payload);

    if (level !== "error") {
      // Sólo aplicamos la ventana de 60s a info/warn — errores siempre pasan.
      const prev = dedupCache.get(key);
      if (prev !== undefined && now - prev < DEDUP_WINDOW_MS) {
        // Mismo evento dentro de la ventana → silencioso, NO insert.
        return;
      }
      dedupCache.set(key, now);
      maybeSweepDedup(now);
    }

    // SEC defense in depth: aunque ningún call-site debería pasar tokens en
    // payload, los redactamos server-side antes de tocar BD. Así un caller
    // descuidado (o un valor envenenado por upstream) no contamina el log
    // de forma persistente. Ver stripSecrets() arriba.
    const safePayload =
      args.payload != null ? stripSecrets(args.payload) : null;

    await dbInsertActivity({
      tenant_id,
      source,
      level,
      status: args.status ?? null,
      summary,
      payload: safePayload,
    });
  } catch (e) {
    // Telemetría no debe propagar nunca. Log a stderr y seguimos.
    try {
      console.warn(`[activity] logActivity falló: ${(e as Error).message}`);
    } catch {
      /* noop — ni console disponible, abandonamos sin ruido */
    }
  }
}

// ---- Mappers puros (table-row → ActivityEvent[]) -----------------------
//
// Cada mapper:
//   - Recibe un array de filas de su tabla origen (shape laxo: any[]).
//   - Devuelve ActivityEvent[] ordenado tal cual venga la entrada
//     (NO re-sortea: el caller controla el ORDER BY de la query).
//   - Es PURO: no toca BD, no muta el input, no lanza.
//   - Si una fila no tiene los campos mínimos, se omite (no rompe el lote).
//
// El id del evento sintético usa el prefijo `${source}:${rowId}` para no
// chocar con UUIDs reales de app_activity_log.

/** Convierte un valor "fecha" (Date | number | string ISO) a epoch ms. */
function toEpochMs(v: unknown): number {
  if (v == null) return Date.now();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e12) return n; // ya parece epoch ms
  const d = new Date(String(v));
  const t = d.getTime();
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * SEC-1: lee tenant_id real de la fila. Si la fila NO trae tenant_id
 * (regresión cero / mem mode legacy), devuelve 'default'. El antiguo
 * fallback global a 'default' era la fuente del carve-out cross-tenant
 * en filterEvents — ahora el SQL ya garantiza que las filas devuelven
 * su tenant real.
 */
function pickTenant(r: { tenant_id?: unknown } | Record<string, unknown>): string {
  const t = (r as Record<string, unknown>).tenant_id;
  if (typeof t === "string" && t.trim()) return t;
  return "default";
}

/**
 * Mapea app_autopost_history → ActivityEvent[] (source='autopost').
 *
 * Esquema origen (AutopostHistory): id, ts (epoch ms), idea, cta_keyword,
 * caption, platforms[], status[{platform, ok, message}].
 *
 * Reglas:
 *   - level='error' si alguna entrada en status tiene ok=false; si no 'info'.
 *   - summary = `Autopost ${plataformas} — ${idea}` truncado a 200 chars.
 *   - payload conserva idea, platforms, status crudo y caption recortado.
 */
export function mapAutopostHistoryToActivity(rows: unknown[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  if (!Array.isArray(rows)) return out;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = String(r.id ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const platforms = Array.isArray(r.platforms) ? (r.platforms as unknown[]).map(String) : [];
    const statusArr = Array.isArray(r.status) ? (r.status as Array<Record<string, unknown>>) : [];
    const anyFail = statusArr.some((s) => s && s.ok === false);
    const level: ActivityLevel = anyFail ? "error" : "info";
    const idea = String(r.idea ?? "").trim();
    const plats = platforms.length ? platforms.join("+") : "—";
    const summary = `Autopost ${plats}${idea ? ` — ${idea}` : ""}`.slice(0, 200);
    out.push({
      id: `autopost:${id}`,
      tenant_id: pickTenant(r),
      source: "autopost",
      level,
      status: anyFail ? "error" : "ok",
      summary,
      payload: {
        idea,
        platforms,
        status: statusArr,
        caption: String(r.caption ?? "").slice(0, 280),
        cta_keyword: r.cta_keyword ?? null,
      },
      created_at: toEpochMs(r.ts ?? r.created_at),
    });
  }
  return out;
}

/**
 * Mapea app_scheduled_posts → ActivityEvent[] (source='scheduled-post').
 *
 * Esquema origen (ScheduledPost): id, ig_id, kind, media_url, caption,
 * scheduled_at, status (pending|published|error|partial), result, platforms[].
 *
 * Reglas:
 *   - level: 'error' si status='error', 'warn' si 'partial', si no 'info'.
 *   - summary = «Imagen programada en LinkedIn · pendiente» (DISENO-1: en español y sin
 *     valores crudos; antes era `Programado ${kind} ${platforms} — ${status}`).
 *   - timestamp = scheduled_at (el evento conceptual es "cuándo toca/tocó").
 */
// DISENO-1 · diccionarios del resumen humano de una publicación programada.
// DISENO-1 R3 · el género viaja EN el diccionario. Antes la plantilla fijaba «programada» y salían
// «Reel programada», «Carrusel programada», «Vídeo programada» — y lo mismo con «publicada» — en la
// primera columna que lee el cliente en Actividad.
type SchedKind = { n: string; g: "m" | "f" };
const SCHED_KIND_ES: Record<string, SchedKind> = { image: { n: "Imagen", g: "f" }, reel: { n: "Reel", g: "m" }, carousel: { n: "Carrusel", g: "m" }, post: { n: "Publicación", g: "f" }, video: { n: "Vídeo", g: "m" }, story: { n: "Historia", g: "f" } };
const SCHED_PLATFORM_ES: Record<string, string> = { ig: "Instagram", instagram: "Instagram", fb: "Facebook", facebook: "Facebook", linkedin: "LinkedIn", tiktok: "TikTok", yt: "YouTube", youtube: "YouTube", x: "X", twitter: "X", threads: "Threads" };
// «pendiente», «con fallo» y «parcial» son invariables; solo el participio concuerda.
const SCHED_STATUS_ES: Record<string, { m: string; f: string }> = { pending: { m: "pendiente", f: "pendiente" }, published: { m: "publicado", f: "publicada" }, error: { m: "con fallo", f: "con fallo" }, partial: { m: "parcial", f: "parcial" }, draft: { m: "borrador", f: "borrador" }, cancelled: { m: "cancelado", f: "cancelada" } };
function schedSummaryHuman(kind: string, platforms: string[], status: string): string {
  const k = SCHED_KIND_ES[kind.toLowerCase()] ?? { n: "Publicación", g: "f" as const };
  const plats = platforms.map((p) => SCHED_PLATFORM_ES[p.toLowerCase()] ?? p).join(" + ");
  const stPair = SCHED_STATUS_ES[status.toLowerCase()];
  const st = stPair ? stPair[k.g] : status;
  return `${k.n} programad${k.g === "f" ? "a" : "o"}${plats ? ` en ${plats}` : ""} · ${st}`;
}
export function mapScheduledPostsToActivity(rows: unknown[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  if (!Array.isArray(rows)) return out;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = String(r.id ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const status = String(r.status ?? "pending");
    const level: ActivityLevel =
      status === "error" ? "error" : status === "partial" ? "warn" : "info";
    const kind = String(r.kind ?? "post");
    const platforms = Array.isArray(r.platforms) ? (r.platforms as unknown[]).map(String) : [];
    // DISENO-1 · sin plataformas explícitas la publicación es de Instagram (ig_id): no se enseña el identificador.
    const summary = schedSummaryHuman(kind, platforms.length ? platforms : ["ig"], status).slice(0, 200);
    out.push({
      id: `scheduled-post:${id}`,
      tenant_id: pickTenant(r),
      source: "scheduled-post",
      level,
      status,
      summary,
      payload: {
        kind,
        platforms,
        ig_id: r.ig_id ?? null,
        result: r.result ?? null,
        caption: String(r.caption ?? "").slice(0, 280),
      },
      created_at: toEpochMs(r.scheduled_at ?? r.created_at),
    });
  }
  return out;
}

/**
 * Mapea app_broadcasts → ActivityEvent[] (source='broadcast').
 *
 * Esquema origen (BroadcastRec): id, created_at, text, segment, recipients,
 * sent, failed, out_window, status (sent|scheduled|sending|error|canceled),
 * scheduled_at.
 *
 * Reglas:
 *   - level: 'error' si status='error' o failed>0 con sent=0, 'warn' si
 *     failed>0 pero sent>0 (entrega parcial), si no 'info'.
 *   - summary = `Difusión ${status}: ${sent}/${recipients} (failed=${failed})`.
 *   - timestamp = scheduled_at si es programada futura, si no created_at.
 */
export function mapBroadcastsToActivity(rows: unknown[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  if (!Array.isArray(rows)) return out;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = String(r.id ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const status = String(r.status ?? "sent");
    const recipients = Number(r.recipients ?? 0) || 0;
    const sent = Number(r.sent ?? 0) || 0;
    const failed = Number(r.failed ?? 0) || 0;
    const level: ActivityLevel =
      status === "error" || (failed > 0 && sent === 0)
        ? "error"
        : failed > 0
          ? "warn"
          : "info";
    const text = String(r.text ?? "").trim();
    const summary =
      `Difusión ${status}: ${sent}/${recipients} (failed=${failed})${text ? ` — ${text}` : ""}`.slice(
        0,
        200,
      );
    const ts =
      r.scheduled_at != null && status === "scheduled"
        ? toEpochMs(r.scheduled_at)
        : toEpochMs(r.created_at ?? r.scheduled_at);
    out.push({
      id: `broadcast:${id}`,
      tenant_id: pickTenant(r),
      source: "broadcast",
      level,
      status,
      summary,
      payload: {
        recipients,
        sent,
        failed,
        out_window: Number(r.out_window ?? 0) || 0,
        segment: r.segment ?? null,
        text: text.slice(0, 280),
      },
      created_at: ts,
    });
  }
  return out;
}

/**
 * Mapea app_mcp_jobs → ActivityEvent[] (source='mcp-job').
 *
 * Esquema origen (db.ts initDb CREATE TABLE app_mcp_jobs): id, tenant_id,
 * kind, payload, status (queued|running|done|error), result, error,
 * attempts, next_run, created_at, updated_at.
 *
 * Reglas:
 *   - level: 'error' si status='error', 'warn' si attempts>=3, si no 'info'.
 *   - summary = `MCP ${kind}: ${status}` + sufijo error si lo hay.
 *   - timestamp = updated_at si está, si no created_at.
 */
export function mapMcpJobsToActivity(rows: unknown[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  if (!Array.isArray(rows)) return out;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = String(r.id ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const status = String(r.status ?? "queued");
    const attempts = Number(r.attempts ?? 0) || 0;
    const level: ActivityLevel =
      status === "error" ? "error" : attempts >= 3 ? "warn" : "info";
    const kind = String(r.kind ?? "job");
    const errStr = String(r.error ?? "").trim();
    const summary = `MCP ${kind}: ${status}${errStr ? ` — ${errStr}` : ""}`.slice(0, 200);
    out.push({
      id: `mcp-job:${id}`,
      tenant_id: pickTenant(r),
      source: "mcp-job",
      level,
      status,
      summary,
      payload: {
        kind,
        attempts,
        error: errStr || null,
        result: r.result ?? null,
        next_run: r.next_run ?? null,
      },
      created_at: toEpochMs(r.updated_at ?? r.created_at),
    });
  }
  return out;
}

/**
 * Mapea app_lead_jobs → ActivityEvent[] (source='lead-job').
 *
 * Esquema origen (LeadJob): id, niche, city, status (queued|discovering|
 * scraping|done|error), area, total, scraped, with_email, results, error,
 * created_at.
 *
 * Reglas:
 *   - level: 'error' si status='error', 'warn' si total>0 && with_email===0
 *     (job ejecutó pero no encontró emails — vale la pena revisar), si no
 *     'info'.
 *   - summary = `Leads ${niche}/${city} ${status}: ${scraped}/${total}
 *     (emails=${with_email})`.
 */
export function mapLeadJobsToActivity(rows: unknown[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  if (!Array.isArray(rows)) return out;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = String(r.id ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const status = String(r.status ?? "queued");
    const total = Number(r.total ?? 0) || 0;
    const scraped = Number(r.scraped ?? 0) || 0;
    const withEmail = Number(r.with_email ?? 0) || 0;
    const level: ActivityLevel =
      status === "error"
        ? "error"
        : status === "done" && total > 0 && withEmail === 0
          ? "warn"
          : "info";
    const niche = String(r.niche ?? "").trim();
    const city = String(r.city ?? "").trim();
    const summary =
      `Leads ${niche}/${city} ${status}: ${scraped}/${total} (emails=${withEmail})`.slice(
        0,
        200,
      );
    out.push({
      id: `lead-job:${id}`,
      tenant_id: pickTenant(r),
      source: "lead-job",
      level,
      status,
      summary,
      payload: {
        niche,
        city,
        area: r.area ?? null,
        total,
        scraped,
        with_email: withEmail,
        error: r.error ?? null,
      },
      created_at: toEpochMs(r.created_at),
    });
  }
  return out;
}

/**
 * Mapea filas crudas de app_activity_log → ActivityEvent[] (identity).
 *
 * Útil cuando el caller hace una query directa y quiere homogeneizar el
 * shape (saneando tipos / fallbacks) sin reinventarlo en cada consumidor.
 * Acepta tanto ActivityRow (el shape que devuelve dbListActivity) como
 * filas pg crudas con created_at como string/Date.
 */
export function mapAppActivityToActivity(
  rows: ReadonlyArray<ActivityRow | Record<string, unknown>>,
): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  if (!Array.isArray(rows)) return out;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const sourceStr = String(r.source ?? "app");
    const levelStr = String(r.level ?? "info");
    const source: ActivitySource = isActivitySource(sourceStr) ? sourceStr : "app";
    const level: ActivityLevel = isActivityLevel(levelStr) ? levelStr : "info";
    out.push({
      id: String(r.id ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      tenant_id: pickTenant(r),
      source,
      level,
      status: r.status == null ? null : String(r.status),
      summary: String(r.summary ?? ""),
      payload: (r.payload as Record<string, unknown> | null) ?? null,
      created_at: toEpochMs(r.created_at),
    });
  }
  return out;
}

// ---- Type guards usados por mapAppActivityToActivity -------------------

const VALID_SOURCES: ReadonlySet<string> = new Set<ActivitySource>([
  "autopost",
  "scheduled-post",
  "broadcast",
  "mcp-job",
  "lead-job",
  "webhook",
  "llm",
  "meta-api",
  "wa-send",
  "ig-send",
  "fb-send",
  "yt-send",
  "newsletter",
  "app",
]);

function isActivitySource(s: string): s is ActivitySource {
  return VALID_SOURCES.has(s);
}

function isActivityLevel(s: string): s is ActivityLevel {
  return s === "info" || s === "warn" || s === "error";
}

// ---- Test seam ---------------------------------------------------------
//
// Exporto el cache y la constante de ventana SOLO para que los tests puedan
// inspeccionar/limpiar entre casos. NO usar desde lógica de negocio.
export const __internal = {
  dedupCache,
  DEDUP_WINDOW_MS,
  clearDedup(): void {
    dedupCache.clear();
  },
};
