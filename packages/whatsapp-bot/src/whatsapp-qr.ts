/**
 * WhatsApp Web mediante Baileys. No es la API oficial de Meta.
 * Las credenciales y claves Signal nunca se escriben en ficheros ni se exponen
 * al panel. Un lease de Postgres permite un único socket por sesión.
 */
import { randomUUID, createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import makeWASocket, {
  Browsers, BufferJSON, DisconnectReason, getMediaKeys, initAuthCreds,
  jidDecode, normalizeMessageContent, proto,
  type AuthenticationCreds, type AuthenticationState, type Contact,
  type SignalDataSet, type SignalDataTypeMap, type UserFacingSocketConfig,
  type WAMessage, type WAMessageKey, type WASocket, type AnyMessageContent,
} from "baileys";
import QRCode from "qrcode";
import { encrypt, decrypt, isProd, appEncKeyPresent } from "./crypto.js";
import { dbGetClient, hasDb } from "./db.js";
import { currentWorkspaceId, listWorkspacesCached, runWithWorkspace } from "./workspace.js";

export type QrStatus = "connecting" | "qr" | "connected" | "reconnecting" | "disconnected" | "error";
export interface QrMetadata { id: string; label: string; phone: string; status: QrStatus; error?: string; historyProgress?: number }
export interface QrMedia { buffer: Buffer; mime: string; filename?: string; kind: "image" | "video" | "audio" | "document" | "sticker" }
export interface QrIncoming {
  workspaceId: string; sessionId: string; phone: string; name: string;
  text: string; id: string; ts: number; fromMe: boolean; media?: QrMedia;
  /** ADJUNTO-REINTENTO-1 · había adjunto pero no se pudo bajar: viaja como dato, no
   *  como texto metido en el mensaje (eso lo leía el bot y lo pintaba la Bandeja). */
  mediaFailed?: { kind: QrMedia["kind"]; mime?: string; filename?: string; reason: string };
}
/** WA-QR-HIST-1 · Conversación que YA existía en el móvil, traída al vincular.
 *  Va por su propio canal, separado de QrIncoming, justamente para que no pueda
 *  colarse en el pipeline de atención: son mensajes viejos y el bot NO debe
 *  contestarlos ni disparar flujos con ellos. */
export interface QrHistoryItem { phone: string; name: string; text: string; id: string; ts: number; fromMe: boolean }
export interface QrHistory {
  workspaceId: string; sessionId: string; items: QrHistoryItem[];
  /** 0-100. `done` marca el último lote: el panel deja de enseñar la barra. */
  progress: number; done: boolean;
}
/** NUM-RETIRADO-1 · La sesión acaba de quedar vinculada y ya sabe su teléfono. Es la
 *  señal que permite reconocer un número que VUELVE por otra vía y re-adoptar su
 *  histórico. Se emite una sola vez por vinculación, no en cada reconexión. */
export interface QrLinked { workspaceId: string; sessionId: string; phone: string }
/** NOMBRE-ECO-1 · El nombre de perfil del teléfono VINCULADO (el nuestro), tal como lo
 *  publica WhatsApp. Se emite al abrir la conexión porque es justo el nombre con el que
 *  el eco de nuestros propios mensajes venía bautizando fichas de contacto ajenas:
 *  tenerlo aquí es lo que permite limpiar las que ya quedaron mal. */
export interface QrSelf { workspaceId: string; sessionId: string; phone: string; selfName: string }
/** NUM-RETIRADO-1 · La sesión murió por logout/sesión inválida y no se va a reintentar:
 *  el teléfono está a punto de borrarse de la fila. Es la mitad "se va" de QrLinked —
 *  sin apuntarlo antes de que se borre, el número vuelve sin que nadie lo reconozca. */
export interface QrDisabled { workspaceId: string; sessionId: string; phone: string; label: string }
export interface QrAck {
  workspaceId: string; sessionId: string; phone: string; id: string;
  status: "sent" | "delivered" | "read" | "failed"; ts: number;
}
/** REACCIONES-1 · Reacción con emoji a un mensaje ya existente. fromMe dice quién
 *  reaccionó (no de quién es el mensaje reaccionado): true si se reaccionó desde el
 *  propio teléfono vinculado, false si fue el contacto. emoji='' es una reacción retirada. */
export interface QrReaction {
  workspaceId: string; sessionId: string; phone: string;
  messageId: string; emoji: string; fromMe: boolean; ts: number;
}
/** El caller debe respetar retryable=false: el servidor puede haber aceptado el envío. */
/** WA-QR-ANTERIORES-2 · lo que contestó el móvil: respuestas 0 = no contestó. */
export type QrHistoryAnswer = { pedidas: number; respuestas: number; mensajes: number; utiles: number; chats: string[] };
/** WA-QR-ANTERIORES-1 · la petición de histórico se rechaza para no retrasar un envío. */
export class QrHistoryBusy extends Error {
  readonly code = "WA_QR_HISTORY_BUSY";
}
export class QrSendError extends Error {
  readonly retryable = false;
  readonly code = "WA_QR_SEND_UNCONFIRMED";
  /** QR-ENVIO-CAUSA-1 · el motivo real (error de Baileys o «timeout»), sólo para el log:
   *  antes se tiraba y un «no enviado» no dejaba ningún rastro de por qué. */
  readonly causa: string;
  constructor(causa = "") {
    super("WhatsApp no confirmó el resultado del mensaje. Comprueba el chat antes de repetir el envío");
    this.name = "QrSendError";
    this.causa = causa;
  }
}
/** QR-SIN-WHATSAPP-1 · el destinatario no tiene cuenta de WhatsApp: no se envía nada. */
export class QrSinWhatsAppError extends Error {
  readonly retryable = false;
  readonly code = "WA_QR_NOT_ON_WHATSAPP";
  constructor(phone: string) {
    super(`El número +${phone} no tiene WhatsApp. Revisa que esté bien escrito y con el prefijo del país: el mensaje no se ha enviado`);
    this.name = "QrSinWhatsAppError";
  }
}
type Row =Omit<QrMetadata, "historyProgress"> & {
  workspaceId: string; enabled: boolean; credsEnc: string | null;
  qrEnc: string | null; expiresAt: number | null; owner: string | null; leaseUntil: number;
  historyProgress: number | null;
};
type Patch = Partial<Pick<Row, "phone" | "status" | "error" | "credsEnc" | "qrEnc" | "expiresAt" | "historyProgress">>;
type KeyEntry = { kind: string; id: string; value: string | null };

/** Interfaz inyectable: los tests ejercitan leases y cifrado sin abrir sockets. */
export interface QrStore {
  list(workspaceId?: string): Promise<Row[]>;
  get(workspaceId: string, id: string): Promise<Row | null>;
  create(row: Row): Promise<void>;
  enable(workspaceId: string, id: string, label: string): Promise<boolean>;
  claim(workspaceId: string, id: string, owner: string, leaseMs: number): Promise<boolean>;
  renew(workspaceId: string, id: string, owner: string, leaseMs: number): Promise<boolean>;
  patch(workspaceId: string, id: string, owner: string, patch: Patch): Promise<boolean>;
  release(workspaceId: string, id: string, owner: string): Promise<void>;
  disable(workspaceId: string, id: string, owner?: string): Promise<boolean>;
  /** QR-FANTASMA-1 · borrado definitivo. `disable` deja la fila (para que un cierre
   *  remoto siga siendo visible); esto la quita cuando lo pide el dueño. */
  remove(workspaceId: string, id: string): Promise<void>;
  keysGet(workspaceId: string, id: string, kind: string, ids: string[]): Promise<Record<string, string>>;
  keysSet(workspaceId: string, id: string, owner: string, values: KeyEntry[]): Promise<void>;
}

export function createQrMemoryStore(now: () => number = Date.now): QrStore {
  const rows = new Map<string, Row>();
  const keys = new Map<string, Map<string, string>>();
  const key = (ws: string, id: string) => JSON.stringify([ws, id]);
  const owns = (r: Row | undefined, owner: string) => !!r?.enabled && r.owner === owner && r.leaseUntil > now();
  return {
    async list(ws) { return [...rows.values()].filter(r => ws === undefined || r.workspaceId === ws).map(r => ({ ...r })); },
    async get(ws, id) { const r = rows.get(key(ws, id)); return r ? { ...r } : null; },
    async create(r) { const k = key(r.workspaceId, r.id); if (rows.has(k)) throw new Error("La sesión ya existe"); rows.set(k, { ...r }); },
    async enable(ws, id, label) { const r = rows.get(key(ws, id)); if (!r) return false; r.enabled = true; r.label = label; return true; },
    async claim(ws, id, owner, ms) { const r = rows.get(key(ws, id)); if (!r?.enabled || (r.owner && r.owner !== owner && r.leaseUntil > now())) return false; r.owner = owner; r.leaseUntil = now() + ms; return true; },
    async renew(ws, id, owner, ms) { const r = rows.get(key(ws, id)); if (!owns(r, owner)) return false; r!.leaseUntil = now() + ms; return true; },
    async patch(ws, id, owner, p) { const r = rows.get(key(ws, id)); if (!owns(r, owner)) return false; Object.assign(r!, p); return true; },
    async release(ws, id, owner) { const r = rows.get(key(ws, id)); if (r?.owner === owner) { r.owner = null; r.leaseUntil = 0; } },
    async disable(ws, id, owner) {
      const k = key(ws, id), r = rows.get(k); if (!r || (owner && !owns(r, owner))) return false;
      Object.assign(r, { enabled: false, status: "disconnected", error: undefined, phone: "", credsEnc: null, qrEnc: null, expiresAt: null, historyProgress: null, owner: null, leaseUntil: 0 });
      keys.delete(k); return true;
    },
    async remove(ws, id) { const k = key(ws, id); rows.delete(k); keys.delete(k); },
    async keysGet(ws, id, kind, ids) { const result: Record<string, string> = Object.create(null); const values = keys.get(key(ws, id)); for (const id of ids) { const v = values?.get(JSON.stringify([kind, id])); if (v) result[id] = v; } return result; },
    async keysSet(ws, id, owner, values) {
      const k = key(ws, id); if (!owns(rows.get(k), owner)) throw new Error("La sesión perdió el permiso de conexión");
      let map = keys.get(k); if (!map) { map = new Map(); keys.set(k, map); }
      for (const v of values) { const kk = JSON.stringify([v.kind, v.id]); if (v.value === null) map.delete(kk); else map.set(kk, v.value); }
    },
  };
}

function createSqlStore(): QrStore {
  let initialized: Promise<void> | undefined;
  async function client() {
    const c = await dbGetClient();
    if (!c) throw new Error("WhatsApp QR necesita almacenamiento disponible");
    return c;
  }
  async function ready() {
    if (!initialized) initialized = (async () => {
      const c = await client();
      try {
        // Serializa el DDL inicial incluso si arrancan varias réplicas a la vez.
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(74018261)");
        await c.query(`CREATE TABLE IF NOT EXISTS app_wa_qr_sessions (
          workspace_id text NOT NULL, id text NOT NULL, label text NOT NULL,
          phone text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'disconnected',
          error text, enabled boolean NOT NULL DEFAULT true, creds_enc text,
          qr_enc text, expires_at timestamptz, lease_owner text, lease_until timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id,id))`);
        await c.query(`CREATE TABLE IF NOT EXISTS app_wa_qr_keys (
          workspace_id text NOT NULL, session_id text NOT NULL, kind text NOT NULL,
          key_id text NOT NULL, value_enc text NOT NULL,
          PRIMARY KEY (workspace_id,session_id,kind,key_id),
          FOREIGN KEY (workspace_id,session_id) REFERENCES app_wa_qr_sessions(workspace_id,id) ON DELETE CASCADE)`);
        // WA-QR-HIST-1 · aditivo: las sesiones ya vinculadas siguen valiendo, con NULL.
        await c.query("ALTER TABLE app_wa_qr_sessions ADD COLUMN IF NOT EXISTS history_progress smallint");
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
      finally { c.release(); }
    })().catch(e => { initialized = undefined; throw e; });
    await initialized;
  }
  async function query(sql: string, params: unknown[] = []) {
    await ready(); const c = await client();
    try { return await c.query(sql, params); } finally { c.release(); }
  }
  function row(r: Record<string, any>): Row {
    return { workspaceId: r.workspace_id, id: r.id, label: r.label, phone: r.phone, status: r.status,
      error: r.error || undefined, enabled: r.enabled, credsEnc: r.creds_enc, qrEnc: r.qr_enc,
      expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
      owner: r.lease_owner, leaseUntil: r.lease_until ? new Date(r.lease_until).getTime() : 0,
      historyProgress: r.history_progress == null ? null : Number(r.history_progress) };
  }
  const owned = "workspace_id=$1 AND id=$2 AND lease_owner=$3 AND enabled=true AND lease_until>now()";
  return {
    async list(ws) { return (await query(`SELECT * FROM app_wa_qr_sessions${ws === undefined ? "" : " WHERE workspace_id=$1"}`, ws === undefined ? [] : [ws])).rows.map(row); },
    async get(ws, id) { const r = (await query("SELECT * FROM app_wa_qr_sessions WHERE workspace_id=$1 AND id=$2", [ws, id])).rows[0]; return r ? row(r) : null; },
    async create(r) { await query("INSERT INTO app_wa_qr_sessions(workspace_id,id,label,status,enabled) VALUES($1,$2,$3,$4,$5)", [r.workspaceId,r.id,r.label,r.status,r.enabled]); },
    async enable(ws, id, label) { return !!(await query("UPDATE app_wa_qr_sessions SET enabled=true,label=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2", [ws,id,label])).rowCount; },
    async claim(ws, id, owner, ms) { return !!(await query(`UPDATE app_wa_qr_sessions SET lease_owner=$3,lease_until=now()+($4::double precision * interval '1 millisecond') WHERE workspace_id=$1 AND id=$2 AND enabled=true AND (lease_owner IS NULL OR lease_owner=$3 OR lease_until<=now())`, [ws,id,owner,ms])).rowCount; },
    async renew(ws, id, owner, ms) { return !!(await query(`UPDATE app_wa_qr_sessions SET lease_until=now()+($4::double precision * interval '1 millisecond') WHERE ${owned}`, [ws,id,owner,ms])).rowCount; },
    async patch(ws, id, owner, p) {
      const columns = { phone: "phone", status: "status", error: "error", credsEnc: "creds_enc", qrEnc: "qr_enc", expiresAt: "expires_at", historyProgress: "history_progress" };
      const values: unknown[] = [ws,id,owner]; const sets: string[] = [];
      for (const k of Object.keys(p) as (keyof Patch)[]) {
        let v: unknown = p[k] ?? null;
        if (k === "expiresAt" && typeof v === "number") v = new Date(v);
        values.push(v); sets.push(`${columns[k]}=$${values.length}`);
      }
      if (!sets.length) return true;
      return !!(await query(`UPDATE app_wa_qr_sessions SET ${sets.join(",")},updated_at=now() WHERE ${owned}`, values)).rowCount;
    },
    async release(ws, id, owner) { await query("UPDATE app_wa_qr_sessions SET lease_owner=NULL,lease_until=NULL WHERE workspace_id=$1 AND id=$2 AND lease_owner=$3", [ws,id,owner]); },
    async disable(ws, id, owner) {
      await ready(); const c = await client();
      try {
        await c.query("BEGIN");
        const r = await c.query(`UPDATE app_wa_qr_sessions SET enabled=false,phone='',status='disconnected',error=NULL,creds_enc=NULL,qr_enc=NULL,expires_at=NULL,history_progress=NULL,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2${owner ? " AND lease_owner=$3 AND lease_until>now()" : ""}`, owner ? [ws,id,owner] : [ws,id]);
        if (r.rowCount) await c.query("DELETE FROM app_wa_qr_keys WHERE workspace_id=$1 AND session_id=$2", [ws,id]);
        await c.query("COMMIT"); return !!r.rowCount;
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
      finally { c.release(); }
    },
    async remove(ws, id) {
      await ready(); const c = await client();
      try {
        await c.query("BEGIN");
        await c.query("DELETE FROM app_wa_qr_keys WHERE workspace_id=$1 AND session_id=$2", [ws,id]);
        await c.query("DELETE FROM app_wa_qr_sessions WHERE workspace_id=$1 AND id=$2", [ws,id]);
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
      finally { c.release(); }
    },
    async keysGet(ws, id, kind, ids) {
      if (!ids.length) return {};
      const r = await query("SELECT key_id,value_enc FROM app_wa_qr_keys WHERE workspace_id=$1 AND session_id=$2 AND kind=$3 AND key_id=ANY($4::text[])", [ws,id,kind,ids]);
      return Object.fromEntries(r.rows.map(v => [v.key_id,v.value_enc]));
    },
    async keysSet(ws, id, owner, values) {
      if (!values.length) return;
      await ready(); const c = await client();
      try {
        await c.query("BEGIN");
        // El bloqueo de la sesión ordena escritura de claves frente a logout/takeover.
        const lock = await c.query(`SELECT id FROM app_wa_qr_sessions WHERE ${owned} FOR UPDATE`, [ws,id,owner]);
        if (!lock.rowCount) throw new Error("La sesión perdió el permiso de conexión");
        for (const v of values) {
          if (v.value === null) await c.query("DELETE FROM app_wa_qr_keys WHERE workspace_id=$1 AND session_id=$2 AND kind=$3 AND key_id=$4", [ws,id,v.kind,v.id]);
          else await c.query("INSERT INTO app_wa_qr_keys(workspace_id,session_id,kind,key_id,value_enc) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,session_id,kind,key_id) DO UPDATE SET value_enc=EXCLUDED.value_enc", [ws,id,v.kind,v.id,v.value]);
        }
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
      finally { c.release(); }
    },
  };
}

type QrSocket = Pick<WASocket, "ev" | "sendMessage" | "end" | "logout" | "user"> & {
  signalRepository?: Pick<WASocket["signalRepository"], "lidMapping">;
  /** ADJUNTO-REINTENTO-1 · pide al móvil que vuelva a subir un adjunto caducado. */
  updateMediaMessage?: WASocket["updateMediaMessage"];
  /** WA-QR-BAJO-DEMANDA-1 · pide al móvil los mensajes anteriores de un chat. */
  fetchMessageHistory?: WASocket["fetchMessageHistory"];
  /** QR-SIN-WHATSAPP-1 · pregunta a WhatsApp si un teléfono tiene cuenta. */
  onWhatsApp?: WASocket["onWhatsApp"];
};
type Handler<T> = (event: T) => void | Promise<void>;
export interface QrServiceOptions {
  store?: QrStore;
  socketFactory?: (config: UserFacingSocketConfig) => QrSocket;
  qrEncode?: (raw: string) => Promise<string>;
  downloadMedia?: (message: WAMessage, kind: QrMedia["kind"]) => Promise<Buffer>;
  activeWorkspaceIds?: () => Promise<string[]>;
  now?: () => number;
  leaseMs?: number; heartbeatMs?: number; reconnectBaseMs?: number;
  maxRetries?: number; refreshMs?: number; sendTimeoutMs?: number;
  /** QR-RELEVO-1 · cuánto espera un envío a que la conexión esté lista (despliegue, reconexión). */
  readyWaitMs?: number;
  /** WA-QR-ANTERIORES-1 · pausa mínima entre dos peticiones de histórico del mismo número. */
  historyGapMs?: number;
  /** WA-QR-ANTERIORES-2 · cuánto se espera a que el móvil conteste la petición. */
  historyWaitMs?: number;
  /** QR-LOG-1 · destino de los avisos de Baileys (por defecto, una línea JSON en stdout). */
  baileysLog?: (line: QrBaileysLog) => void;
}
/** QR-LOG-1 · un aviso de Baileys ya depurado: sin JID, sin XML y sin contenido de mensajes. */
export type QrBaileysLog = { level: "info" | "warn" | "error"; session: string; msg: string; err?: string; code?: number; hist?: { syncType?: number; chunkOrder?: number; progress?: number; onDemand?: boolean } };
type Runtime = {
  row: Row; owner: string; socket?: QrSocket; auth?: AuthenticationState; generation: number;
  queue: Promise<unknown>; retries: number; stopped: boolean;
  ended?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>; heartbeat?: ReturnType<typeof setInterval>;
  leaseTimer?: ReturnType<typeof setTimeout>;
  lids: Map<string, string>; seen: Set<string>;
  /** NOMBRE-ECO-1 · último nombre de perfil propio ya anunciado: evita repetir el
   *  aviso en cada reconexión (que en una red mala son muchas). */
  selfName?: string;
  /** WA-QR-ANTERIORES-1 · Baileys hace pasar TODO lo que sale de un número por un
   *  mismo candado (authState.keys.transaction(..., meId)): una petición de histórico
   *  en vuelo retrasa los envíos. Se cuentan los envíos en curso y sólo se deja UNA
   *  petición al móvil a la vez, espaciada, y nunca mientras sale un mensaje. */
  sending: number; histBusy?: boolean; histAt?: number;
  /** WA-QR-ANTERIORES-2 · quien espera la contestación del móvil (una petición a la vez). */
  histWait?: (r: { mensajes: number; utiles: number }) => void;
  /** QR-SIN-WHATSAPP-1 · teléfonos que WhatsApp ya confirmó que tienen cuenta. */
  conWhatsApp?: Set<string>;
  /** QR-SIN-WHATSAPP-2 · teléfonos sin cuenta y cuándo se supo: se recuerda 10 min. */
  sinWhatsApp?: Map<string, number>;
};
const MAX_MEDIA = 20 * 1024 * 1024;
// WA-QR-HIST-1 · con syncFullHistory:true y browser identificado como Desktop, WhatsApp
// manda el histórico completo que conserve (antes, con syncFullHistory:false, sólo
// mandaba el tramo "Hoy": WhatsApp trata cualquier browser no-Desktop como WEB_BROWSER
// y le da la versión corta). Ya no se acota aquí por edad: acotar undercutiría justo lo
// que se pidió sincronizar completo.
// El histórico NO descarga adjuntos (serían miles): se representa el tipo en cristiano.
const HISTORY_MEDIA: Record<string, string> = { image: "[Foto]", video: "[Vídeo]", audio: "[Audio]", document: "[Documento]", sticker: "[Adhesivo]" };
const NO_SESSION = "No se encontró esta conexión de WhatsApp en el espacio activo";
const LOST = "La conexión se atiende en otra instancia o ha sido desconectada. Vuelve a intentarlo desde la instancia que la gestiona";
// QR-AUTORRECUPERA-1 · un fallo pasajero (Postgres que no contesta un latido, la red que
// agota los reintentos rápidos) ya NO deja la sesión en "error" para siempre: queda en
// "reconnecting" y refreshAll la vuelve a levantar en la siguiente vuelta. Sólo es final
// lo que no se arregla reintentando: 440 (abierta en otro sitio), 403 y credenciales
// que no se pueden descifrar. Antes, un solo latido fallido tumbaba el número hasta que
// alguien pulsaba «Reconectar», y el envío respondía LOST.
const TRANSITORIO = "Se perdió la conexión con WhatsApp un momento. Se está restableciendo sola";
// Textos que escribía la versión anterior para esos mismos fallos pasajeros: las filas que
// se quedaron así se recuperan también, sin que nadie tenga que volver a vincular.
const TRANSITORIOS_ANTIGUOS = new Set(["No se pudo mantener la conexión de forma segura. Revisa el almacenamiento y vuelve a conectar",
  "No se pudo restablecer WhatsApp. Revisa el teléfono y vuelve a conectar"]);
class CredencialIlegible extends Error {}
// QR-LOG-1 · Antes todo lo de Baileys iba a un logger mudo: el móvil decía «No se pudo
// terminar la sincronización» o no contestaba a «Cargar anteriores» y en producción no
// quedaba NI UNA línea para saber por qué. Ahora pasan los avisos y errores, y de los
// informativos sólo los de sincronización del histórico. Nunca el objeto crudo: lleva
// JID, nodos XML y a veces el mensaje entero; sólo el texto y campos numéricos.
const LOG_INFO_UTIL = /history|sync|on.?demand|peer data|pdo/i;
function baileysLogger(session: string, out: (line: QrBaileysLog) => void) {
  const emit = (level: QrBaileysLog["level"]) => (a: unknown, b?: unknown) => {
    const msg = String(typeof a === "string" ? a : typeof b === "string" ? b : "").slice(0,200);
    if (level === "info" && !LOG_INFO_UTIL.test(msg)) return;
    const o = (a && typeof a === "object" ? a : {}) as Record<string, any>;
    const e = o.err || o.error || (a instanceof Error ? a : undefined);
    const line: QrBaileysLog = { level, session, msg };
    if (e) { line.err = String(e.message || e).replace(/\d{6,}/g,"…").slice(0,200); const c = e.output?.statusCode ?? e.data?.code; if (Number.isFinite(Number(c))) line.code = Number(c); }
    const h = o.histNotification;
    if (h && typeof h === "object") line.hist = { syncType: h.syncType ?? undefined, chunkOrder: h.chunkOrder ?? undefined, progress: h.progress ?? undefined, onDemand: !!h.peerDataRequestSessionId };
    try { out(line); } catch { /* un log nunca tumba la conexión */ }
  };
  const logger = { level: "info", child() { return logger; }, trace() {}, debug() {}, info: emit("info"), warn: emit("warn"), error: emit("error"), fatal: emit("error") };
  return logger;
}
const stdoutLog = (line: QrBaileysLog) => { console.log(JSON.stringify({ src: "baileys", ...line })); };
function seal(value: unknown) { return encrypt(JSON.stringify(value, BufferJSON.replacer)); }
function unseal(value: string) { return JSON.parse(decrypt(value), BufferJSON.reviver); }
function phoneJid(jid?: string | null): string | undefined {
  if (!jid) return undefined;
  const decoded = jidDecode(jid);
  return decoded?.server === "s.whatsapp.net" && /^[1-9]\d{6,14}$/.test(decoded.user) ? decoded.user : undefined;
}
function directJid(jid?: string | null) { return !!jid && /@(s\.whatsapp\.net|lid)$/.test(jid); }
function cleanName(value: string) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100); }
function publicRow(r: Row): QrMetadata { return { id: r.id, label: r.label, phone: r.phone, status: r.status, ...(r.error ? { error: r.error } : {}), ...(r.historyProgress == null ? {} : { historyProgress: r.historyProgress }) }; }
function validId(id: string) { if (!/^qr_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error(NO_SESSION); }

async function defaultDownload(message: WAMessage, kind: QrMedia["kind"]): Promise<Buffer> {
  const content = normalizeMessageContent(message.message);
  const media = content?.[`${kind}Message` as keyof typeof content] as proto.Message.IImageMessage | undefined;
  if (!media || Number(media.fileLength || 0) > MAX_MEDIA) throw new Error("El archivo supera 20 MB");
  // rc14 no propaga signal/redirect en su downloader. El transporte propio
  // usa exclusivamente el CDN fijo y valida MAC/hash antes de devolver bytes.
  if (!media.directPath?.startsWith("/") || media.directPath.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(media.directPath)) throw new Error("No se pudo localizar el archivo de WhatsApp");
  const response = await fetch(`https://mmg.whatsapp.net${media.directPath}`, { signal: AbortSignal.timeout(30_000), redirect: "error", headers: { Origin: "https://web.whatsapp.com" } });
  if (!response.ok || !response.body) throw new Error("WhatsApp no pudo descargar el archivo");
  const reader = response.body.getReader();
  const chunks: Buffer[] = []; let size = 0;
  try {
    if (Number(response.headers.get("content-length") || 0) > MAX_MEDIA + 32) throw new Error("El archivo supera 20 MB");
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      const buffer = Buffer.from(chunk.value); size += buffer.length;
      if (size > MAX_MEDIA + 32) throw new Error("El archivo supera 20 MB");
      chunks.push(buffer);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const encrypted = Buffer.concat(chunks);
  if (encrypted.length < 26) throw new Error("El archivo está incompleto");
  const keys = await getMediaKeys(media.mediaKey!,kind);
  if (!keys.macKey) throw new Error("Falta la clave de integridad del archivo");
  const ciphertext = encrypted.subarray(0,-10), mac = encrypted.subarray(-10);
  const expected = createHmac("sha256",keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0,10);
  if (!timingSafeEqual(mac,expected)) throw new Error("El archivo no supera la verificación de integridad");
  const aes = createDecipheriv("aes-256-cbc",keys.cipherKey,keys.iv);
  const plain = Buffer.concat([aes.update(ciphertext),aes.final()]);
  if (plain.length > MAX_MEDIA) throw new Error("El archivo supera 20 MB");
  if (media.fileSha256 && !createHash("sha256").update(plain).digest().equals(Buffer.from(media.fileSha256))) throw new Error("El archivo no supera la verificación de integridad");
  return plain;
}

export function createQrService(options: QrServiceOptions = {}) {
  const store = options.store ?? (hasDb ? createSqlStore() : createQrMemoryStore());
  const factory = options.socketFactory ?? makeWASocket;
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 60_000;
  const encode = options.qrEncode ?? (raw => QRCode.toDataURL(raw, { width: 320, margin: 2, errorCorrectionLevel: "M" }));
  const cache = new Map<string, Row>(), live = new Map<string, Runtime>(), locks = new Map<string, Promise<unknown>>();
  const messages = new Set<Handler<QrIncoming>>(), acks = new Set<Handler<QrAck>>(), history = new Set<Handler<QrHistory>>(), linked = new Set<Handler<QrLinked>>(), disabled = new Set<Handler<QrDisabled>>(), reactions = new Set<Handler<QrReaction>>(), selves = new Set<Handler<QrSelf>>();
  let closing = false, refresh: ReturnType<typeof setInterval> | undefined, refreshing = false;
  const key = (ws: string, id: string) => JSON.stringify([ws,id]);
  const activeIds = options.activeWorkspaceIds ?? (async () => (await listWorkspacesCached()).map(w => w.id));
  function remember(row: Row) { cache.set(key(row.workspaceId,row.id), { ...row }); }
  function serial<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
    const result = rt.queue.then(fn); rt.queue = result.catch(() => {}); return result;
  }
  async function locked<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const prior = locks.get(k) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(fn); locks.set(k,task);
    try { return await task; } finally { if (locks.get(k) === task) locks.delete(k); }
  }
  function stop(rt: Runtime, endSocket = true) {
    rt.stopped = true; rt.generation++;
    clearTimeout(rt.timer); clearTimeout(rt.leaseTimer); clearInterval(rt.heartbeat); rt.timer = undefined; rt.heartbeat = undefined;
    const socket = rt.socket; rt.socket = undefined;
    if (endSocket && socket) { try { rt.ended = Promise.resolve(socket.end(undefined)).catch(() => {}); } catch { /* Cierre local idempotente. */ } }
  }
  async function patch(rt: Runtime, p: Patch) {
    if (rt.stopped || live.get(key(rt.row.workspaceId,rt.row.id)) !== rt || !await store.patch(rt.row.workspaceId,rt.row.id,rt.owner,p)) { stop(rt); throw new Error(LOST); }
    if (rt.stopped || live.get(key(rt.row.workspaceId,rt.row.id)) !== rt) throw new Error(LOST);
    Object.assign(rt.row,p); remember(rt.row);
  }
  async function eventError(rt: Runtime, final = false) {
    if (live.get(key(rt.row.workspaceId,rt.row.id)) !== rt || closing) return;
    // Los errores originales pueden contener JID, URL o claves: no se publican.
    stop(rt);
    // QR-AUTORRECUPERA-1 · sólo lo final se queda en "error"; lo demás lo retoma refreshAll.
    await store.patch(rt.row.workspaceId,rt.row.id,rt.owner,final
      ? { status: "error", error: "Las credenciales guardadas de esta conexión no se pueden leer. Desconecta y vuelve a vincular", qrEnc: null, expiresAt: null }
      : { status: "reconnecting", error: TRANSITORIO, qrEnc: null, expiresAt: null }).catch(() => false);
    const row = await store.get(rt.row.workspaceId,rt.row.id).catch(() => null); if (row) remember(row);
    await store.release(rt.row.workspaceId,rt.row.id,rt.owner).catch(() => {});
  }
  function handle(rt: Runtime, generation: number, fn: () => Promise<void>) {
    void serial(rt, async () => { if (!closing && !rt.stopped && rt.generation === generation) await fn(); }).catch(() => { if (rt.generation === generation) return eventError(rt); });
  }
  async function requireLease(rt: Runtime) {
    const requestedAt = now();
    if (closing || rt.stopped || !await store.renew(rt.row.workspaceId,rt.row.id,rt.owner,leaseMs)) { stop(rt); throw new Error(LOST); }
    if (closing || rt.stopped) throw new Error(LOST);
    // Si Postgres queda bloqueado, un watchdog local cierra el socket antes
    // de que otra réplica pueda adquirir el lease. No espera al query pendiente.
    const remaining = requestedAt + leaseMs - Math.min(1_000,leaseMs / 10) - now();
    if (remaining <= 0) { stop(rt); throw new Error(LOST); }
    clearTimeout(rt.leaseTimer);
    rt.leaseTimer = setTimeout(() => stop(rt),remaining); rt.leaseTimer.unref();
  }
  function mapping(rt: Runtime, lid?: string | null, pn?: string | null) {
    const phone = phoneJid(pn); const decoded = lid && jidDecode(lid);
    if (decoded && decoded.server === "lid" && phone) {
      if (rt.lids.size >= 10_000) rt.lids.delete(rt.lids.keys().next().value!);
      rt.lids.set(decoded.user,phone);
    }
  }
  // QR-LID-HIST-1 · `avisar`: el aviso rojo de «contacto (LID)» es para un mensaje EN VIVO
  // que se pierde. En la carga del histórico salía por cualquier chat antiguo sin
  // teléfono conocido y dejaba la tarjeta en rojo con la conexión perfecta.
  async function resolvePhone(rt: Runtime, msgKey: WAMessageKey, avisar = true): Promise<string | undefined> {
    if (!directJid(msgKey.remoteJid)) return undefined;
    const pn = phoneJid(msgKey.remoteJid);
    if (pn) { mapping(rt,msgKey.remoteJidAlt,msgKey.remoteJid); return pn; }
    mapping(rt,msgKey.remoteJid,msgKey.remoteJidAlt);
    const lid = jidDecode(msgKey.remoteJid!)?.user;
    let phone = lid && rt.lids.get(lid);
    if (!phone) {
      const resolved = await rt.socket?.signalRepository?.lidMapping.getPNForLID(msgKey.remoteJid!);
      mapping(rt,msgKey.remoteJid,resolved); phone = lid && rt.lids.get(lid);
    }
    if (!phone && avisar) await patch(rt,{ error: "WhatsApp todavía no facilitó el teléfono de un contacto (LID). Se omitió el mensaje para evitar asignarlo a otra persona" });
    return phone || undefined;
  }
  async function dispatch<T>(handlers: Set<Handler<T>>, event: T, rt: Runtime) {
    for (const handler of handlers) {
      try { await runWithWorkspace(rt.row.workspaceId, () => handler(event)); }
      catch { await patch(rt,{ error: "Se recibió un evento de WhatsApp, pero no se pudo guardar en la bandeja. Revisa el servicio" }); }
    }
  }
  function messageText(content: proto.IMessage): string {
    return content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || content.documentMessage?.caption || content.buttonsResponseMessage?.selectedDisplayText || content.listResponseMessage?.title || "";
  }
  async function incoming(rt: Runtime, message: WAMessage) {
    if (!message.key.id || !directJid(message.key.remoteJid) || !message.message) return;
    const dedupe = `${message.key.remoteJid}:${message.key.id}`;
    if (rt.seen.has(dedupe)) return;
    await requireLease(rt);
    const phone = await resolvePhone(rt,message.key); if (!phone) return;
    const content = normalizeMessageContent(message.message); if (!content) return;
    let text = messageText(content);
    let media: QrMedia | undefined;
    let mediaFailed: QrIncoming["mediaFailed"];
    const kind = (["image","video","audio","document","sticker"] as const).find(k => content[`${k}Message`]);
    if (kind) {
      const data = content[`${kind}Message`] as proto.Message.IDocumentMessage;
      const bajar = options.downloadMedia ?? defaultDownload;
      try {
        if (Number(data.fileLength || 0) > MAX_MEDIA) throw new Error("Archivo demasiado grande");
        let buffer: Buffer;
        try { buffer = await bajar(message,kind); }
        catch (e) {
          // ADJUNTO-REINTENTO-1 · el enlace del CDN caduca: el móvil puede volver a
          // subirlo (lo mismo que hace WhatsApp Web al abrir un adjunto viejo).
          const upd = rt.socket?.updateMediaMessage;
          if (!upd || (e as Error).message === "El archivo supera 20 MB") throw e;
          buffer = await bajar(await upd(message),kind);
        }
        if (buffer.length > MAX_MEDIA) throw new Error("Archivo demasiado grande");
        media = { buffer, kind, mime: data.mimetype || "application/octet-stream", filename: data.fileName ? cleanName(data.fileName) : undefined };
      } catch (e) {
        mediaFailed = { kind, mime: data.mimetype || undefined, filename: data.fileName ? cleanName(data.fileName) : undefined, reason: (e as Error).message || "descarga fallida" };
      }
    }
    if (!text && !media && !mediaFailed) return; // Protocolos, reacciones y sincronización no crean contactos.
    await requireLease(rt); // Logout remoto también se respeta después de descargar.
    rt.seen.add(dedupe); if (rt.seen.size > 2_000) rt.seen.delete(rt.seen.values().next().value!);
    if (rt.row.error) await patch(rt,{ error: undefined }).catch(() => {});
    const ts = Number(message.messageTimestamp || 0) * 1000;
    await dispatch(messages,{ workspaceId: rt.row.workspaceId, sessionId: rt.row.id, phone, name: cleanName(message.pushName || ""), text, id: message.key.id, ts: Number.isFinite(ts) && ts > 0 ? ts : now(), fromMe: !!message.key.fromMe, ...(media ? { media } : {}), ...(mediaFailed ? { mediaFailed } : {}) },rt);
  }
  async function connect(rt: Runtime): Promise<void> {
    if (closing || rt.stopped) return;
    await requireLease(rt);
    const row = await store.get(rt.row.workspaceId,rt.row.id); if (!row) throw new Error(NO_SESSION);
    rt.row = row;
    const generation = ++rt.generation;
    let creds: AuthenticationCreds;
    try { creds = row.credsEnc ? unseal(row.credsEnc) : initAuthCreds(); } catch { throw new CredencialIlegible(); }
    const auth: AuthenticationState = { creds, keys: {
      async get<T extends keyof SignalDataTypeMap>(kind: T, ids: string[]) {
        const values = await store.keysGet(row.workspaceId,row.id,kind,ids);
        const result: { [id: string]: SignalDataTypeMap[T] } = Object.create(null);
        for (const id of ids) if (values[id]) {
          let value = unseal(values[id]);
          if (kind === "app-state-sync-key") value = proto.Message.AppStateSyncKeyData.fromObject(value);
          result[id] = value;
        }
        return result;
      },
      async set(data: SignalDataSet) {
        if (rt.stopped || closing || rt.generation !== generation) throw new Error(LOST);
        const entries: KeyEntry[] = [];
        for (const [kind, values] of Object.entries(data)) for (const [id,value] of Object.entries(values || {})) entries.push({ kind,id,value: value == null ? null : seal(value) });
        await store.keysSet(row.workspaceId,row.id,rt.owner,entries);
      },
    } };
    rt.auth = auth;
    await patch(rt,{ status: rt.retries ? "reconnecting" : "connecting", error: undefined, credsEnc: seal(creds), qrEnc: null, expiresAt: null });
    if (closing || rt.stopped || rt.generation !== generation) return;
    // QR-428-1 (23-sep-2026) · WhatsApp CORTA al instante (428 «Connection Terminated»,
    // tras el ClientPayload) toda conexión que se anuncia como Desktop (webSubPlatform
    // DARWIN/WIN32): ni sale el QR ni reconecta una sesión vinculada — bucle «Reconectando».
    // Medido con Baileys rc14 contra WhatsApp real: Desktop 8/8 cortes; Chrome con
    // syncFullHistory 6/6 QR. Se deja de anunciar Desktop.
    // QR-SYNC-1 (23-sep-2026) · y tampoco se pide ya el histórico completo (requireFullSync):
    // a un Chrome WhatsApp no se lo manda nunca (sonda real: arranque 473 + reciente 1.148
    // mensajes al 100 %, y 0 lotes FULL en 15 min), y el móvil marca el dispositivo con
    // «No se pudo terminar la sincronización». Es lo mismo que pide WhatsApp Web. Lo
    // antiguo de un chat se pide con «Cargar mensajes anteriores». shouldSyncHistoryMessage
    // sigue en true: sin él Baileys descarta también el tramo reciente.
    // Lo que se pierde: el histórico al vincular vuelve a ser el tramo "reciente".
    // Nota histórica de WA-QR-HIST-1 · WhatsApp sólo manda el histórico completo si nos anunciamos como
    // Desktop (browser[0] "Mac OS"/"Windows" y browser[1] literal "Desktop") Y
    // syncFullHistory:true a la vez; si falta cualquiera de las dos, trata la sesión
    // como WEB_BROWSER y sólo manda el tramo "reciente" (de ahí el "solo Hoy").
    const socket = factory({ auth, logger: baileysLogger(row.id.slice(-8),options.baileysLog ?? stdoutLog) as any, browser: Browsers.macOS("Chrome"),
      syncFullHistory: false, shouldSyncHistoryMessage: () => true, markOnlineOnConnect: false,
      shouldIgnoreJid: jid => !directJid(jid), connectTimeoutMs: 30_000, defaultQueryTimeoutMs: 30_000,
      qrTimeout: 60_000, getMessage: async () => undefined });
    if (closing || rt.stopped || rt.generation !== generation) { void Promise.resolve(socket.end(undefined)).catch(() => {}); return; }
    rt.socket = socket;
    socket.ev.on("creds.update", update => {
      if (rt.stopped || closing || rt.generation !== generation) return;
      Object.assign(creds,update);
      const snapshot = seal(creds);
      handle(rt,generation,async () => { await patch(rt,{ credsEnc: snapshot }); });
    });
    socket.ev.on("connection.update", update => handle(rt,generation,async () => {
      if (update.qr) {
        const qr = await encode(update.qr);
        if (rt.stopped || rt.generation !== generation) return;
        await patch(rt,{ status: "qr", qrEnc: seal(qr), expiresAt: now() + 55_000, error: undefined });
      }
      if (update.connection === "open") {
        const phone = phoneJid(socket.user?.id) || phoneJid(creds.me?.id) || "";
        const eraOtro = rt.row.phone !== phone;
        rt.retries = 0;
        await patch(rt,{ status: "connected", phone, qrEnc: null, expiresAt: null,
          error: phone ? undefined : "La sesión está vinculada, pero WhatsApp aún no facilitó el número de teléfono" });
        // Sólo al aprender el teléfono (no en cada reconexión con el mismo).
        if (phone && eraOtro) await dispatch(linked,{ workspaceId: rt.row.workspaceId, sessionId: rt.row.id, phone },rt);
        // NOMBRE-ECO-1 · nuestro propio nombre de perfil, una vez por conexión (o si cambia).
        const selfName = cleanName(socket.user?.name || "");
        if (selfName && rt.selfName !== selfName) {
          rt.selfName = selfName;
          await dispatch(selves,{ workspaceId: rt.row.workspaceId, sessionId: rt.row.id, phone, selfName },rt);
        }
      }
      if (update.connection === "close") {
        rt.socket = undefined;
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession || code === DisconnectReason.multideviceMismatch) {
          stop(rt);
          // NUM-RETIRADO-1 · store.disable() va a borrar row.phone: apuntarlo antes,
          // si no el número vuelve por QR sin que nadie lo reconozca.
          if (row.phone) await dispatch(disabled,{ workspaceId: row.workspaceId, sessionId: row.id, phone: row.phone, label: row.label },rt);
          await store.disable(row.workspaceId,row.id,rt.owner);
          const fresh = await store.get(row.workspaceId,row.id); if (fresh) remember(fresh);
          return;
        }
        if (code === DisconnectReason.connectionReplaced || code === DisconnectReason.forbidden) {
          await patch(rt,{ status: "error", qrEnc: null, expiresAt: null,
            error: code === DisconnectReason.connectionReplaced ? "WhatsApp abrió esta sesión en otro lugar. Desconecta y vuelve a vincular" : "WhatsApp no permite usar esta conexión. Revisa el teléfono y vuelve a vincular" });
          stop(rt); await store.release(row.workspaceId,row.id,rt.owner); return;
        }
        // QR-AUTORRECUPERA-1 · agotados los reintentos rápidos se suelta el socket, pero la
        // sesión sigue viva: refreshAll la vuelve a intentar a su ritmo (25 s), sin bucle.
        if (rt.retries >= (options.maxRetries ?? 6)) {
          await patch(rt,{ status: "reconnecting", qrEnc: null, expiresAt: null, error: TRANSITORIO });
          stop(rt); await store.release(row.workspaceId,row.id,rt.owner); return;
        }
        rt.retries++;
        await patch(rt,{ status: "reconnecting", qrEnc: null, expiresAt: null, error: undefined });
        rt.generation++; // Descarta eventos pendientes del socket cerrado.
        const delay = code === DisconnectReason.restartRequired ? 250 : Math.min(30_000,(options.reconnectBaseMs ?? 1_000) * 2 ** (rt.retries - 1));
        rt.timer = setTimeout(() => { void locked(key(row.workspaceId,row.id), () => connect(rt)).catch(() => eventError(rt)); },delay);
        rt.timer.unref();
      }
    }));
    socket.ev.on("lid-mapping.update", pair => mapping(rt,pair.lid,pair.pn));
    const contacts = (list: Partial<Contact>[]) => { if (rt.generation !== generation || rt.stopped) return; for (const c of list) mapping(rt,c.lid || c.id,c.phoneNumber || c.id); };
    socket.ev.on("contacts.upsert", contacts); socket.ev.on("contacts.update",contacts);
    socket.ev.on("messaging-history.set", event => handle(rt,generation,async () => {
      await requireLease(rt);
      // WA-QR-HIST-1 · los contactos y el mapa LID→teléfono del lote llegan en el MISMO
      // evento que los mensajes: se resuelven ANTES de iterar mensajes, si no un LID que
      // el propio lote trae se descarta como "no resuelto" sólo por procesarse al revés.
      contacts(event.contacts || []);
      for (const m of event.lidPnMappings || []) mapping(rt,m.lid,m.pn);
      const items: QrHistoryItem[] = [];
      for (const message of event.messages || []) {
        if (!message.key?.id || !directJid(message.key.remoteJid) || !message.message) continue;
        const ts = Number(message.messageTimestamp || 0) * 1000;
        if (!Number.isFinite(ts) || ts <= 0) continue;
        const content = normalizeMessageContent(message.message); if (!content) continue;
        const kind = (["image","video","audio","document","sticker"] as const).find(k => content[`${k}Message`]);
        const cuerpo = messageText(content);
        const text = kind ? (cuerpo ? `${HISTORY_MEDIA[kind]}\n${cuerpo}` : HISTORY_MEDIA[kind]) : cuerpo;
        if (!text) continue; // protocolos, reacciones y claves de sincronización
        const phone = await resolvePhone(rt,message.key,false); if (!phone) continue;
        items.push({ phone, name: cleanName(message.pushName || ""), text, id: message.key.id, ts, fromMe: !!message.key.fromMe });
      }
      items.sort((a,b) => a.ts - b.ts);
      // WA-QR-BAJO-DEMANDA-1 · lo pedido para UN chat (qrFetchHistory) llega por este
      // mismo evento, pero no es la sincronización al vincular: no toca su progreso.
      if (event.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
        if (items.length) await dispatch(history,{ workspaceId: rt.row.workspaceId, sessionId: rt.row.id, items, progress: rt.row.historyProgress ?? 100, done: false },rt);
        // WA-QR-ANTERIORES-2 · se avisa DESPUÉS de fundir: quien espera ya ve los mensajes.
        rt.histWait?.({ mensajes: (event.messages || []).length, utiles: items.length });
        return;
      }
      const bruto = Number(event.progress ?? 0);
      const pct = Number.isFinite(bruto) ? Math.max(0,Math.min(100,Math.round(bruto))) : 0;
      const done = event.isLatest === true || pct >= 100;
      await patch(rt,{ historyProgress: done ? 100 : pct });
      if (items.length || done) await dispatch(history,{ workspaceId: rt.row.workspaceId, sessionId: rt.row.id, items, progress: done ? 100 : pct, done },rt);
    }));
    socket.ev.on("messages.upsert", event => {
      if (event.type !== "notify") return;
      handle(rt,generation,async () => { for (const message of event.messages) await incoming(rt,message); });
    });
    socket.ev.on("messages.update", events => handle(rt,generation,async () => {
      await requireLease(rt);
      for (const event of events) {
        if (!event.key.fromMe || !event.key.id || event.update.status == null || !directJid(event.key.remoteJid)) continue;
        const phone = await resolvePhone(rt,event.key); if (!phone) continue;
        const n = event.update.status;
        const status = n === 0 ? "failed" : n >= 4 ? "read" : n === 3 ? "delivered" : n === 2 ? "sent" : undefined;
        if (status) await dispatch(acks,{ workspaceId: row.workspaceId, sessionId: row.id, phone, id: event.key.id, status, ts: now() },rt);
      }
    }));
    socket.ev.on("messages.reaction", events => handle(rt,generation,async () => {
      await requireLease(rt);
      for (const event of events) {
        if (!event.key.id || !directJid(event.key.remoteJid)) continue;
        const phone = await resolvePhone(rt,event.key); if (!phone) continue;
        const emoji = String(event.reaction.text || "");
        const ts = Number(event.reaction.senderTimestampMs || 0);
        await dispatch(reactions,{ workspaceId: row.workspaceId, sessionId: row.id, phone, messageId: event.key.id, emoji, fromMe: !!event.reaction.key?.fromMe, ts: Number.isFinite(ts) && ts > 0 ? ts : now() },rt);
      }
    }));
    if (!rt.heartbeat) {
      let beating = false;
      rt.heartbeat = setInterval(() => {
        if (beating || rt.stopped) return; beating = true;
        void requireLease(rt).catch(() => eventError(rt)).finally(() => { beating = false; });
      },options.heartbeatMs ?? 20_000);
      rt.heartbeat.unref();
    }
  }
  async function startRow(row: Row) {
    const k = key(row.workspaceId,row.id);
    const existing = live.get(k);
    if (existing && !existing.stopped) { await requireLease(existing); return; }
    const runtimeOwner = randomUUID();
    if (!await store.claim(row.workspaceId,row.id,runtimeOwner,leaseMs)) return;
    const rt: Runtime = { row, owner: runtimeOwner, generation: 0, queue: Promise.resolve(), retries: 0, stopped: false, lids: new Map(), seen: new Set(), sending: 0 };
    live.set(k,rt);
    try { await connect(rt); } catch (e) { await eventError(rt,e instanceof CredencialIlegible); throw new Error("No se pudo iniciar WhatsApp. Revisa el almacenamiento y vuelve a conectar"); }
  }
  // QR-RELEVO-1 · En cada despliegue la instancia nueva arranca con la conexión aún en
  // manos de la vieja: no la toma hasta su siguiente vuelta de refreshAll (hasta 25 s) y
  // luego tarda en conectar. Un envío en ese hueco fallaba AL INSTANTE («no enviado»),
  // y lo mismo en cualquier reconexión breve. Ahora espera, acotado, y si la vieja ya la
  // soltó la toma en el acto. Lo que NO se hace: saltarse el lease de otra instancia viva.
  async function ready(ws: string, id: string): Promise<Runtime> {
    const k = key(ws,id), hasta = Date.now() + (options.readyWaitMs ?? 25_000);
    for (;;) {
      const row = await store.get(ws,id); if (!row) throw new Error(NO_SESSION);
      const rt = live.get(k);
      if (rt && !rt.stopped && row.owner === rt.owner && rt.socket && row.status === "connected") return rt;
      // Sólo se espera a lo que va a volver solo: un número vinculado y activo.
      const volvera = row.enabled && !!row.phone && row.status !== "qr" && row.status !== "disconnected" && (row.status !== "error" || TRANSITORIOS_ANTIGUOS.has(row.error || ""));
      if (!volvera || closing || Date.now() >= hasta) {
        if (!rt || row.owner !== rt.owner) throw new Error(LOST);
        throw new Error("Vincula WhatsApp y espera a que la conexión esté lista");
      }
      if (!rt || rt.stopped) await locked(k,() => startRow(row)).catch(() => {});
      await new Promise(r => setTimeout(r,250));
    }
  }
  async function refreshAll() {
    if (refreshing || closing) return; refreshing = true;
    try {
      const allowed = new Set(await activeIds());
      const rows = await store.list();
      const present = new Set<string>();
      for (const row of rows) {
        const k = key(row.workspaceId,row.id); present.add(k); remember(row);
        if (!allowed.has(row.workspaceId)) { const rt = live.get(k); if (rt) { stop(rt); await store.release(row.workspaceId,row.id,rt.owner); } cache.delete(k); continue; }
        const vivo = row.status !== "error" || TRANSITORIOS_ANTIGUOS.has(row.error || "");
        if (row.enabled && vivo && row.status !== "disconnected") await locked(k, () => startRow(row)).catch(() => {});
        else { const rt = live.get(k); if (rt && !rt.stopped) stop(rt); }
      }
      for (const [k,rt] of live) if (!present.has(k)) { stop(rt); live.delete(k); cache.delete(k); }
    } finally { refreshing = false; }
  }
  // QR-SIN-WHATSAPP-1 · a un número sin WhatsApp, Baileys cifra sólo para nuestros propios
  // dispositivos, el servidor lo acepta sin error y jamás llega acuse: la Bandeja se quedaba
  // con el reloj para siempre y el mensaje no llegaba a nadie. Se pregunta a WhatsApp.
  // true/false es su respuesta; null, que no se pudo saber (falló, tardó o no hay consulta):
  // quien llama NUNCA bloquea con null. El «sí» se recuerda mientras viva la conexión; el
  // «no», 10 min (QR-SIN-WHATSAPP-2: el panel pregunta al abrir el chat y al comprobar).
  async function tieneWhatsApp(rt: Runtime, socket: QrSocket, phone: string): Promise<boolean | null> {
    if (rt.conWhatsApp?.has(phone)) return true;
    const no = rt.sinWhatsApp?.get(phone);
    if (no !== undefined && now() - no < 600_000) return false;
    if (!socket.onWhatsApp) return null;
    let espera: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([socket.onWhatsApp(phone).catch(() => undefined),new Promise<undefined>(resolve => { espera = setTimeout(() => resolve(undefined),10_000); espera.unref(); })]).finally(() => clearTimeout(espera));
    if (!Array.isArray(r)) return null;
    if (r.some(x => x.exists)) { (rt.conWhatsApp ??= new Set()).add(phone); rt.sinWhatsApp?.delete(phone); return true; }
    (rt.sinWhatsApp ??= new Map()).set(phone,now());
    return false;
  }
  function safety() {
    if (closing) throw new Error("El servicio de WhatsApp se está cerrando");
    if (process.env.NODE_ENV === "test" && !options.socketFactory) throw new Error("Los tests deben inyectar una fábrica de sockets sin red");
    if (isProd() && (!appEncKeyPresent() || (!hasDb && !options.store))) throw new Error("Configura APP_ENC_KEY y Postgres antes de vincular WhatsApp");
  }
  return {
    qrList(): QrMetadata[] { const ws = currentWorkspaceId(); return [...cache.values()].filter(r => r.workspaceId === ws).map(publicRow); },
    // NUM-RETIRADO-1 · Sesiones muertas (logout) de ANTES de que existiera el evento
    // `disabled`: se quedaron sin registro de retirado y su teléfono ya está borrado de
    // la fila. Es sólo lectura para un backfill de arranque en index.ts, que es quien
    // sabe recuperar el teléfono (caché BANDEJA-FIX-1) y escribir el registro.
    async qrHuerfanas(): Promise<{ workspaceId: string; sessionId: string; label: string }[]> {
      return (await store.list()).filter(r => !r.enabled && !r.phone).map(r => ({ workspaceId: r.workspaceId, sessionId: r.id, label: r.label }));
    },
    async qrStart(label: string, id?: string): Promise<QrMetadata> {
      safety(); const ws = currentWorkspaceId(); label = cleanName(label).slice(0,80);
      if (!label) throw new Error("Escribe un nombre para esta conexión");
      const suppliedId = !!id;
      if (id) validId(id); else id = `qr_${randomUUID()}`;
      const sessionId = id;
      return locked(key(ws,sessionId),async () => {
        let row = await store.get(ws,sessionId);
        if (!row) {
          // Los ids recibidos nunca crean ni trasladan una sesión de otro tenant.
          if (suppliedId) throw new Error(NO_SESSION);
          if ((await store.list(ws)).filter(r => r.enabled).length >= 10) throw new Error("Este espacio ya tiene 10 conexiones de WhatsApp activas");
          row = { workspaceId: ws, id: sessionId,label,phone: "",status: "connecting",enabled: true,credsEnc: null,qrEnc: null,expiresAt: null,historyProgress: null,owner: null,leaseUntil: 0 };
          await store.create(row);
        } else { await store.enable(ws,sessionId,label); row.label = label; row.enabled = true; }
        remember(row); await startRow(row);
        const fresh = await store.get(ws,sessionId); if (!fresh) throw new Error(NO_SESSION); remember(fresh); return publicRow(fresh);
      });
    },
    async qrStatus(id: string): Promise<QrMetadata & { qrDataUrl?: string; expiresAt?: number }> {
      validId(id); const row = await store.get(currentWorkspaceId(),id); if (!row) throw new Error(NO_SESSION); remember(row);
      return { ...publicRow(row), ...(row.enabled && row.status === "qr" && row.qrEnc && (row.expiresAt || 0) > now() ? { qrDataUrl: unseal(row.qrEnc) as string, expiresAt: row.expiresAt! } : {}) };
    },
    async qrDisconnect(id: string): Promise<void> {
      validId(id); const ws = currentWorkspaceId();
      await locked(key(ws,id),async () => {
        if (!await store.get(ws,id)) throw new Error(NO_SESSION);
        const rt = live.get(key(ws,id)), socket = rt?.socket;
        // Revoca primero en SQL para que ninguna escritura tardía restaure claves.
        await store.disable(ws,id);
        if (rt) stop(rt,false);
        if (socket) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([socket.logout(),new Promise<void>(resolve => { timer = setTimeout(resolve,3_000); timer.unref(); })]); }
          catch { /* La revocación local ya es efectiva. */ }
          finally { clearTimeout(timer); try { await socket.end(undefined); } catch {} }
        }
        // El socket ya está cerrado y las claves revocadas: ahora sí, fuera la fila y
        // fuera de la caché, que es de donde lee qrList().
        await store.remove(ws,id);
        live.delete(key(ws,id));
        cache.delete(key(ws,id));
      });
    },
    async qrSend(id: string, to: string, text: string, media?: QrMedia): Promise<{ id: string }> {
      safety(); validId(id);
      const ws = currentWorkspaceId();
      if (!await store.get(ws,id)) throw new Error(NO_SESSION);
      const phone = String(to || "").replace(/[+\s()-]/g, "");
      if (!/^[1-9]\d{6,14}$/.test(phone)) throw new Error("El destinatario debe ser un teléfono internacional válido");
      if (typeof text !== "string" || text.length > 16_000 || (!text.trim() && !media)) throw new Error("Escribe un mensaje de hasta 16.000 caracteres o adjunta un archivo");
      let content: AnyMessageContent = { text, linkPreview: null };
      if (media) {
        if (!Buffer.isBuffer(media.buffer) || !media.buffer.length || media.buffer.length > MAX_MEDIA || !["image","video","audio","document","sticker"].includes(media.kind)) throw new Error("El archivo debe ser válido y ocupar como máximo 20 MB");
        if ((media.kind === "audio" || media.kind === "sticker") && text.trim()) throw new Error("Envía el texto separado del audio o sticker");
        content = media.kind === "document" ? { document: media.buffer, mimetype: media.mime || "application/octet-stream", fileName: cleanName(media.filename || "archivo"), caption: text }
          : media.kind === "audio" ? { audio: media.buffer, mimetype: media.mime, ptt: false }
          : media.kind === "sticker" ? { sticker: media.buffer, mimetype: media.mime }
          : media.kind === "video" ? { video: media.buffer, mimetype: media.mime, caption: text }
          : { image: media.buffer, mimetype: media.mime, caption: text };
      }
      const rt = await ready(ws,id);
      const socket = rt.socket;
      await requireLease(rt);
      if (rt.socket !== socket || !socket || rt.row.status !== "connected") throw new Error("La conexión cambió durante el envío. Espera a que vuelva a estar lista");
      // No hay reintentos automáticos: un timeout puede ocultar un envío aceptado.
      let timer: ReturnType<typeof setTimeout> | undefined;
      rt.sending++;
      try {
        // QR-SIN-WHATSAPP-1 · sólo un «no» explícito bloquea: si no se pudo saber, se envía.
        if (await tieneWhatsApp(rt,socket,phone) === false) throw new QrSinWhatsAppError(phone);
        const result = await Promise.race([socket.sendMessage(`${phone}@s.whatsapp.net`,content),new Promise<never>((_,reject) => {
          timer = setTimeout(() => reject(new QrSendError(`timeout ${options.sendTimeoutMs ?? 45_000} ms (envíos en cola: ${rt.sending}, pidiendo histórico: ${!!rt.histBusy})`)),options.sendTimeoutMs ?? 45_000); timer.unref();
        })]);
        if (!result?.key.id) throw new QrSendError("WhatsApp no devolvió id de mensaje");
        return { id: result.key.id };
      } catch (e) {
        if (e instanceof QrSendError || e instanceof QrSinWhatsAppError) throw e;
        const err = e as { message?: string; output?: { statusCode?: number } };
        throw new QrSendError(`${String(err?.message || e).slice(0,300)}${err?.output?.statusCode ? " (" + err.output.statusCode + ")" : ""}`);
      }
      finally { clearTimeout(timer); rt.sending--; }
    },
    /** QR-SIN-WHATSAPP-2 · ¿tiene WhatsApp este teléfono? Para avisar ANTES de escribir.
     *  null = no se sabe ahora (número sin conectar en esta réplica, consulta fallida): no bloquear. */
    async qrHasWhatsApp(id: string, to: string): Promise<boolean | null> {
      safety(); validId(id);
      const ws = currentWorkspaceId();
      if (!await store.get(ws,id)) throw new Error(NO_SESSION);
      const phone = String(to || "").replace(/[+\s()-]/g, "");
      if (!/^[1-9]\d{6,14}$/.test(phone)) throw new Error("El destinatario debe ser un teléfono internacional válido");
      // No espera a que conecte (eso es cosa del envío): sin conexión viva, no se sabe.
      const rt = live.get(key(ws,id)), socket = rt?.socket;
      if (!rt || rt.stopped || !socket || rt.row.status !== "connected") return null;
      return tieneWhatsApp(rt,socket,phone);
    },
    async qrReact(id: string, to: string, messageId: string, messageFromMe: boolean, emoji: string): Promise<void> {
      safety(); validId(id);
      const ws = currentWorkspaceId();
      if (!await store.get(ws,id)) throw new Error(NO_SESSION);
      const phone = String(to || "").replace(/[+\s()-]/g, "");
      if (!/^[1-9]\d{6,14}$/.test(phone)) throw new Error("El destinatario debe ser un teléfono internacional válido");
      const msgId = String(messageId || "").trim();
      if (!msgId) throw new Error("Falta el mensaje al que reaccionar");
      if (typeof emoji !== "string" || emoji.length > 32) throw new Error("La reacción no es válida");
      const rt = await ready(ws,id);
      const socket = rt.socket;
      await requireLease(rt);
      if (rt.socket !== socket || !socket || rt.row.status !== "connected") throw new Error("La conexión cambió durante el envío. Espera a que vuelva a estar lista");
      const msgKey: WAMessageKey = { remoteJid: `${phone}@s.whatsapp.net`, fromMe: !!messageFromMe, id: msgId };
      // No hay reintentos automáticos: un timeout puede ocultar un envío aceptado.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([socket.sendMessage(`${phone}@s.whatsapp.net`,{ react: { text: emoji, key: msgKey } }),new Promise<never>((_,reject) => {
          timer = setTimeout(() => reject(new QrSendError()),options.sendTimeoutMs ?? 45_000); timer.unref();
        })]);
      } catch { throw new QrSendError(); }
      finally { clearTimeout(timer); }
    },
    // WA-QR-BAJO-DEMANDA-1 · WhatsApp solo manda el histórico completo una vez, al
    // vincular. Esto le pide al móvil los mensajes ANTERIORES a `oldest` de un chat;
    // la respuesta llega luego por messaging-history.set (ON_DEMAND) y se funde allí.
    async qrFetchHistory(id: string, to: string, oldest: { id: string; fromMe: boolean; ts: number }, count = 50): Promise<QrHistoryAnswer> {
      safety(); validId(id);
      const ws = currentWorkspaceId(), row = await store.get(ws,id); if (!row) throw new Error(NO_SESSION);
      const rt = live.get(key(ws,id));
      if (!rt || row.owner !== rt.owner) throw new Error(LOST);
      if (!rt?.socket || row.status !== "connected") throw new Error("Vincula WhatsApp y espera a que la conexión esté lista");
      const phone = String(to || "").replace(/[+\s()-]/g, "");
      if (!/^[1-9]\d{6,14}$/.test(phone)) throw new Error("El destinatario debe ser un teléfono internacional válido");
      const msgId = String(oldest?.id || "").trim();
      const ts = Number(oldest?.ts);
      if (!msgId || !Number.isFinite(ts) || ts <= 0) throw new Error("Falta el mensaje desde el que pedir el histórico");
      if (rt.sending > 0) throw new QrHistoryBusy("Se está enviando un mensaje por este número. Pide los anteriores en unos segundos");
      if (rt.histBusy || now() - (rt.histAt || 0) < (options.historyGapMs ?? 10_000)) throw new QrHistoryBusy("Ya se han pedido los mensajes anteriores al móvil. Espera unos segundos");
      rt.histBusy = true; rt.histAt = now();
      try {
        const socket = rt.socket;
        await requireLease(rt);
        if (rt.socket !== socket || !socket || rt.row.status !== "connected") throw new Error("La conexión cambió. Espera a que vuelva a estar lista");
        // En el móvil el chat puede ir por teléfono o por LID: se pide por los dos; lo que
        // llegue repetido se descarta al fundir por id de mensaje.
        const pnJid = `${phone}@s.whatsapp.net`;
        const jids = new Set([pnJid]);
        for (const [lid,pn] of rt.lids) if (pn === phone) jids.add(`${lid}@lid`);
        const lid = await socket.signalRepository?.lidMapping?.getLIDForPN(pnJid).catch(() => null);
        if (lid) jids.add(lid);
        const n = Math.max(1,Math.min(50,Math.floor(count) || 50));
        if (!socket.fetchMessageHistory) throw new Error("Esta conexión no permite pedir el histórico");
        // WA-QR-ANTERIORES-2 · antes se pedía y se olvidaba: el botón decía «pedido» y, si el
        // móvil no contestaba, nadie se enteraba. Ahora se espera su contestación (una por
        // chat pedido) y se devuelve lo que llegó. Esperar NO retiene el candado de Baileys:
        // fetchMessageHistory ya volvió, así que los envíos salen mientras tanto.
        const res = { pedidas: 0, respuestas: 0, mensajes: 0, utiles: 0, chats: [...jids] };
        let fin!: () => void;
        const listo = new Promise<void>(r => { fin = r; });
        let gracia: ReturnType<typeof setTimeout> | undefined;
        const tope = setTimeout(() => fin(), options.historyWaitMs ?? 20_000);
        rt.histWait = r => {
          res.respuestas++; res.mensajes += r.mensajes; res.utiles += r.utiles;
          if (res.respuestas >= res.pedidas) fin();
          // Llegó algo por un chat y el otro (teléfono/LID) calla: no se espera al tope.
          else if (res.utiles && !gracia) gracia = setTimeout(() => fin(), 2_000);
        };
        try {
          // WhatsApp Web manda la fecha en segundos exactos (t * 1000).
          const tsWa = Math.floor(ts / 1000) * 1000;
          for (const jid of jids) {
            // Entre una petición y otra puede haber empezado un envío: se le cede el paso.
            if (rt.sending > 0) break;
            res.pedidas++;
            await socket.fetchMessageHistory(n,{ remoteJid: jid, fromMe: !!oldest.fromMe, id: msgId },tsWa);
          }
          if (!res.pedidas) throw new QrHistoryBusy("Se está enviando un mensaje por este número. Pide los anteriores en unos segundos");
          await listo;
        } finally { clearTimeout(tope); if (gracia) clearTimeout(gracia); rt.histWait = undefined; }
        return res;
      } finally { rt.histBusy = false; }
    },
    qrOnMessage(handler: Handler<QrIncoming>) { messages.add(handler); return () => { messages.delete(handler); }; },
    qrOnAck(handler: Handler<QrAck>) { acks.add(handler); return () => { acks.delete(handler); }; },
    qrOnHistory(handler: Handler<QrHistory>) { history.add(handler); return () => { history.delete(handler); }; },
    qrOnLinked(handler: Handler<QrLinked>) { linked.add(handler); return () => { linked.delete(handler); }; },
    qrOnSelf(handler: Handler<QrSelf>) { selves.add(handler); return () => { selves.delete(handler); }; },
    qrOnDisabled(handler: Handler<QrDisabled>) { disabled.add(handler); return () => { disabled.delete(handler); }; },
    qrOnReaction(handler: Handler<QrReaction>) { reactions.add(handler); return () => { reactions.delete(handler); }; },
    async qrRestoreAll() {
      safety();
      if (!refresh) { refresh = setInterval(() => { void refreshAll().catch(() => {}); },options.refreshMs ?? 25_000); refresh.unref(); }
      await refreshAll();
    },
    async qrCloseAll() {
      closing = true; clearInterval(refresh);
      for (const rt of live.values()) stop(rt);
      await Promise.all([...locks.values()].map(p => p.catch(() => {})));
      await Promise.all([...live.values()].map(async rt => { await rt.queue.catch(() => {}); await rt.ended; await store.release(rt.row.workspaceId,rt.row.id,rt.owner); }));
    },
  };
}

// Importar este módulo no abre sockets, tablas ni conexiones de red.
let singleton = createQrService();
let singletonStarted = false;
/** Solo para fixtures HTTP; debe ejecutarse antes de arrancar el servicio. */
export function configureQrForTests(options: QrServiceOptions) {
  if (process.env.NODE_ENV !== "test" || singletonStarted || !options.socketFactory || !options.store) throw new Error("La configuración de prueba requiere NODE_ENV=test, store y socketFactory, antes del arranque");
  singleton = createQrService(options);
}
export const qrList = () => singleton.qrList();
export const qrHuerfanas = () => singleton.qrHuerfanas();
export const qrStatus = (id: string) => singleton.qrStatus(id);
export const qrStart = (label: string,id?: string) => { singletonStarted = true; return singleton.qrStart(label,id); };
export const qrDisconnect = (id: string) => singleton.qrDisconnect(id);
export const qrSend = (id: string,to: string,text: string,media?: QrMedia) => singleton.qrSend(id,to,text,media);
export const qrHasWhatsApp = (id: string,to: string) => singleton.qrHasWhatsApp(id,to);
export const qrReact = (id: string,to: string,messageId: string,messageFromMe: boolean,emoji: string) => singleton.qrReact(id,to,messageId,messageFromMe,emoji);
export const qrFetchHistory = (id: string,to: string,oldest: { id: string; fromMe: boolean; ts: number },count?: number) => singleton.qrFetchHistory(id,to,oldest,count);
export const qrOnMessage = (handler: Handler<QrIncoming>) => singleton.qrOnMessage(handler);
export const qrOnHistory = (handler: Handler<QrHistory>) => singleton.qrOnHistory(handler);
export const qrOnLinked = (handler: Handler<QrLinked>) => singleton.qrOnLinked(handler);
export const qrOnSelf = (handler: Handler<QrSelf>) => singleton.qrOnSelf(handler);
export const qrOnDisabled = (handler: Handler<QrDisabled>) => singleton.qrOnDisabled(handler);
export const qrOnAck = (handler: Handler<QrAck>) => singleton.qrOnAck(handler);
export const qrOnReaction = (handler: Handler<QrReaction>) => singleton.qrOnReaction(handler);
export const qrRestoreAll = () => { singletonStarted = true; return singleton.qrRestoreAll(); };
export const qrCloseAll = () => singleton.qrCloseAll();
