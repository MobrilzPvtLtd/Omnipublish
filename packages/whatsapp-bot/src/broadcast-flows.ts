/**
 * difusion-flow D3 — Motor del Broadcast Flow Builder.
 *
 * Toma la definición JSON del flow (BcFlowData → nodos+edges+startId) y la
 * ejecuta en 4 fases independientes pero coordinadas:
 *
 *   1. simulateFlow()  — dry-run para el panel: resuelve audiencia, valida
 *                        el grafo y estima coste sin tocar BD ni mandar
 *                        nada. Se usa antes de "ejecutar de verdad".
 *   2. runBroadcastFlow() — materializa el run: crea fila en
 *                           app_broadcasts_runs, encola N jobs en
 *                           app_broadcasts_jobs (uno por destinatario ×
 *                           canal) con payload ya interpolado.
 *   3. tickBroadcastJobs() — worker periódico (15 s). Toma lote de jobs
 *                            con dbDueJobs (FOR UPDATE SKIP LOCKED → multi
 *                            replica safe), routea a sendByChannel() y
 *                            marca sent/failed/skipped. Backoff exponencial
 *                            (2/4/8 min) en fail recuperable.
 *   4. tickFollowups()    — worker periódico (60 s). Busca jobs 'sent' con
 *                           nodo followup vinculado y dispara onReply /
 *                           onNoReply según replied_at.
 *
 * Multi-tenant strict: TODO se ejecuta dentro de runWithWorkspace(tenant_id)
 * por job/run. Telemetría (logActivity) llamada DENTRO del ALS scope para
 * que el tenant_id de la traza coincida con el del job que falla, no con
 * 'default' fallback (memoria pieza-129).
 *
 * Concurrencia: dbDueJobs garantiza no-doble-envío via SELECT FOR UPDATE
 * SKIP LOCKED. El worker NO usa transacción explícita aquí (autocommit) —
 * acepta que un crash post-envío-pre-mark podría dejar el job 'queued' y
 * ser reenviado por otro tick. Ese tradeoff es consciente: mejor doble
 * envío raro que perder un envío. (Para at-most-once habría que mover
 * todo el send+mark a una transacción larga, lo cual rompe el patrón de
 * fetch HTTP fuera de trans en pg.)
 */
import {
  dbGetBroadcastFlow,
  dbGetBroadcastRun,
  dbCreateBroadcastRun,
  dbUpdateBroadcastRunStatus,
  dbCancelBroadcastRun,
  dbEnqueueJobs,
  dbDueJobs,
  dbFindUnrepliedJobsByRecipient,
  dbGetClient,
  dbMarkJobSent,
  dbMarkFollowupFired,
  dbMarkJobFailed,
  dbMarkJobReplied,
  dbRequeueJobNoAttempt,
  dbCountJobsByStatus,
  dbListBroadcastJobs,
  dbSearchContacts,
  dbGetContact,
  dbContactByEmail,
  dbUpdateBroadcastFlowSim,
  hasDb,
  type Contact,
  type BroadcastJobInput,
} from "./db.js";
import type {
  BroadcastFlow,
  BroadcastRun,
  BroadcastJob,
  BcAudienceNode,
  BcAudienceSpec,
  BcChannel,
  BcEdge,
  BcFlowData,
  BcFollowupNode,
  BcMessageNode,
  BcNode,
  BcNodeId,
} from "./broadcast-flows-types.js";
import {
  currentWorkspaceId,
  runWithWorkspace,
  listWorkspacesCached,
  DEFAULT_WORKSPACE_ID,
} from "./workspace.js";
import { logActivity } from "./activity.js";
import { substituteVars } from "./templating.js";
import {
  resolveWaNumber,
  runWithWaNumber,
  sendText,
  sendImage,
  sendButtons,
  sendTemplate,
  MOTIVO_QR_SIN_DIFUSION,
} from "./whatsapp.js";
import { esNumeroRetirado } from "./wa-retired.js";
import { sendIgText, resolveAccount, runWithAccount } from "./instagram.js";
import { sendFbText } from "./facebook.js";
import { autoReplyOn } from "./settings.js";
import { hasOptedOut, inWindowFor } from "./contacts.js";

// ============================================================
// Constantes operativas — los lotes y delays son conservadores
// para no saturar Meta Graph en el primer envío masivo del WS.
// ============================================================

/** Lote por tick — caben sobradamente sin tocar rate limit (200/s WA). */
const TICK_BATCH_SIZE = 50;

/** Backoff exponencial 2/4/8 min hasta 3 intentos. */
const RETRY_DELAYS_MS = [2 * 60_000, 4 * 60_000, 8 * 60_000];

/** Cuántos intentos máximos antes de marcar 'failed' definitivo. */
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1; // 1er envío + 3 retries

/** Ventana de 24 h de WhatsApp para mensajes libres (no templates). */
const WA_FREE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Sample max para el panel (preview "se enviará a estos 5"). */
const SAMPLE_SIZE = 5;

/** TTL para que el reply hook empareje un inbound con un job (7 días). */
const REPLY_HOOK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * REG-3: cap por phoneNumberId — máx envíos por segundo por número WABA
 * (Meta limita por número, no por app). Token bucket en memoria por
 * réplica; al exceder reagendamos el job con next_run +200ms y NO
 * incrementamos attempts (no consume retry, es throttle no fallo).
 */
const WA_PER_NUMBER_CAP_PER_SECOND = 50;
const WA_THROTTLE_REQUEUE_DELAY_MS = 200;
const waSendBucket = new Map<string, { count: number; windowStart: number }>();

/**
 * REG-3: comprueba si podemos enviar por este phoneNumberId en la ventana
 * actual. Devuelve true si entra (y consume el slot); false si está lleno
 * (caller debe reagendar +200ms).
 */
function tryAcquireWaSlot(phoneNumberId: string): boolean {
  const id = String(phoneNumberId || "").trim();
  if (!id) return true; // sin pid → bucket global desactivado
  const now = Date.now();
  const slot = waSendBucket.get(id);
  if (!slot || now - slot.windowStart >= 1000) {
    waSendBucket.set(id, { count: 1, windowStart: now });
    return true;
  }
  if (slot.count < WA_PER_NUMBER_CAP_PER_SECOND) {
    slot.count++;
    return true;
  }
  return false;
}

/**
 * Pricing aproximado WA Marketing (céntimos USD × 100 = "milicéntimos")
 * por prefijo E.164. Solo orientativo para mostrar al operador antes de
 * lanzar: Meta factura por conversación 24h no por mensaje, pero el panel
 * necesita un número para "esto costará ~X €".
 *
 * Fuente: precios publicados Meta WA Marketing 2026-Q2. Si el prefijo no
 * está mapeado el estimate devuelve null (NO inventamos un default — sigue
 * el patrón "never fake metrics"). El operador ve "Coste no disponible"
 * en el panel en vez de un número falso que puede leer como contable.
 */
const WA_PRICING_CENTS_BY_PREFIX: Record<string, number> = {
  "34": 7, // ES
  "1": 3, // US/CA (rangos similares)
  "44": 5, // UK
  "52": 1, // MX
  "55": 1, // BR
  "57": 1, // CO
  "54": 1, // AR
  "51": 1, // PE
  "33": 7, // FR
  "49": 8, // DE
  "39": 4, // IT
  "351": 7, // PT
};

/**
 * SEC-2: estima el coste en céntimos para un destinatario por prefijo
 * E.164. Itera la tabla buscando el match más largo (351 PT antes que 35;
 * 1 US es 1 char, 34 ES es 2 chars...). Devuelve null si no hay match
 * conocido — el caller suma null como "sin estimación" y el panel lo
 * pinta como "no disponible" en lugar de inventarse un número.
 */
function estimateCostForRecipient(recipient: string): number | null {
  const clean = String(recipient || "").replace(/[+\s\-()]/g, "");
  if (!clean) return null;
  // Match más largo primero — un prefijo "351" gana a "35"/"3".
  const prefixes = Object.keys(WA_PRICING_CENTS_BY_PREFIX).sort(
    (a, b) => b.length - a.length,
  );
  for (const pre of prefixes) {
    if (clean.startsWith(pre)) {
      const v = WA_PRICING_CENTS_BY_PREFIX[pre];
      return typeof v === "number" ? v : null;
    }
  }
  return null;
}

// ============================================================
// Tipos públicos del simulate y la ejecución.
// ============================================================

/** Resumen mínimo de un contacto para el preview de simulate. */
export interface AudienceContactSummary {
  /** Identificador en el canal (phone E.164 sin +, igsid, psid, email). */
  recipient: string;
  name: string;
  channel: BcChannel;
  /** true si el contacto recibió/escribió en los últimos 24 h (válido para WA libre). */
  in_window_24h: boolean;
  /** Identidad de la ficha y cuenta propietaria del hilo; nunca son credenciales. */
  contact_phone?: string;
  channel_account?: string;
}

/** Resultado de resolveAudience — datos crudos consumidos por simulate y run. */
export interface ResolvedAudience {
  contacts: AudienceContactSummary[];
  total: number;
}

/** Validation errors y warnings devueltos por simulate. */
export interface SimulateValidation {
  errors: string[];
  warnings: string[];
}

/** Resultado completo del simulate (lo consume el panel y se guarda en last_sim_result). */
export interface SimulateResult {
  audience: {
    total: number;
    inWindow24h: number;
    outWindow24h: number;
    byChannel: Record<BcChannel, number>;
    sample: AudienceContactSummary[];
  };
  validation: SimulateValidation;
  /**
   * Coste estimado en céntimos USD si el flow envía templates Marketing
   * WA. SEC-2: null si CUALQUIER destinatario WA carece de prefijo
   * mapeado — el panel lo pinta como "no disponible" en lugar de
   * inventar un número (patrón "never fake metrics"). En ese caso
   * además se añade un warning explícito a validation.warnings.
   */
  estimatedCost?: number | null;
}

/** Opts para runBroadcastFlow — todo opcional, defaults conservadores. */
export interface RunBroadcastFlowOpts {
  /** Si llega, se reutiliza el run existente (re-trigger idempotente). */
  runId?: string;
  /** Si llega, scheduled_for de la fila (epoch ms). Si no, run inmediato. */
  scheduledFor?: number;
}

// ============================================================
// Utilidades internas — manipulación del grafo.
// ============================================================

/** Construye un Map<nodeId, BcNode> para lookups O(1). */
function nodeMap(data: BcFlowData): Map<BcNodeId, BcNode> {
  const m = new Map<BcNodeId, BcNode>();
  for (const n of data.nodes || []) m.set(n.id, n);
  return m;
}

/** Devuelve todos los edges con `from` = nodeId, con su label opcional. */
function outgoingEdges(data: BcFlowData, from: BcNodeId): BcEdge[] {
  return (data.edges || []).filter((e) => e.from === from);
}

/** Devuelve los nodos de tipo dado en el flow (helper para simulate). */
function nodesByType<T extends BcNode["type"]>(
  data: BcFlowData,
  type: T,
): Extract<BcNode, { type: T }>[] {
  return (data.nodes || []).filter((n): n is Extract<BcNode, { type: T }> => n.type === type);
}

/**
 * Encuentra el primer nodo "message" alcanzable desde audienceNode siguiendo
 * edges hacia delante. Útil para extraer el payload del envío principal
 * en runBroadcastFlow sin recorrer todo el grafo. Profundidad max 10
 * (los flows reales son cortos; protege de ciclos accidentales).
 */
function firstMessageAfter(data: BcFlowData, audienceId: BcNodeId): BcMessageNode | null {
  const map = nodeMap(data);
  const visited = new Set<BcNodeId>();
  const queue: BcNodeId[] = [audienceId];
  let depth = 0;
  while (queue.length && depth < 10) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const node = map.get(id);
    if (node?.type === "message") return node;
    for (const e of outgoingEdges(data, id)) queue.push(e.to);
    depth++;
  }
  return null;
}

/**
 * Encuentra un nodo "followup" enlazado desde un nodo message dado.
 * Si existe → el motor agendará followup tras sentX + wait_for_reply_ms.
 */
function followupAfter(data: BcFlowData, messageId: BcNodeId): BcFollowupNode | null {
  const map = nodeMap(data);
  for (const e of outgoingEdges(data, messageId)) {
    const n = map.get(e.to);
    if (n?.type === "followup") return n;
  }
  return null;
}

// ============================================================
// resolveAudience — del BcAudienceSpec a la lista de contactos.
// ============================================================

/**
 * Resuelve una audiencia (modo tags/segment/explicit/csv) a la lista de
 * destinatarios reales en el WS activo. NO interpola payload — solo decide
 * a quién.
 *
 * Filtros aplicados (todos AND):
 *   - mode='tags'    → contiene TODOS los tags listados (AND, no OR).
 *   - mode='segment' → stage + source + tags.
 *   - mode='explicit'→ los recipients vienen ya resueltos en spec.recipients.
 *   - mode='csv'     → idem; el parse del CSV vive en el endpoint de upload.
 *
 * Para mode 'tags'/'segment': filtra app_contacts del WS activo (vía
 * dbSearchContacts CON tenantId) y descarta los que no tengan el campo
 * del canal (phone para wa/sms, email para email, etc.). Para mode
 * 'explicit'/'csv': la lista llega ya resuelta — solo validamos formato.
 *
 * SEC-1: dbSearchContacts SIEMPRE recibe tenantId (defensa cross-WS).
 * Antes (legacy) caía a single-tenant y un flow podía resolver contactos
 * de otro workspace si compartían infra. Ahora resolveAudience exige
 * tenantId explícito y se lo propaga a todas las llamadas internas.
 */
/** REVISION-DIFUSION-1 · Una búsqueda parcial con limit:1 puede ocultar la ficha
 * exacta (y su baja). Las identidades se resuelven por igualdad dentro del workspace. */
async function contactForRecipient(recipient: string, channel: BcChannel, tenantId: string): Promise<Contact | null> {
  return runWithWorkspace(tenantId, async () => {
    const exact = await dbGetContact(recipient);
    if (exact) return exact;
    if (channel === "email") return dbContactByEmail(recipient);
    const prefix = channel === "ig_dm" ? "ig:" : channel === "fb_msg" ? "fb:" : "";
    return prefix ? dbGetContact(prefix + recipient) : null;
  });
}

/** REVISION-DIFUSION-1 · Meta guarda IGSID/PSID numéricos en phone. El canal
 * vive en channel_account; los prefijos en phone solo cubren fichas antiguas. */
function recipientForChannel(c: Contact, channel: BcChannel): string | null {
  const account = c.channel_account || "";
  const ig = account ? account.startsWith("ig:") : c.phone.startsWith("ig:") || c.source === "instagram";
  const fb = account ? account.startsWith("fb:") : c.phone.startsWith("fb:") || c.source === "facebook";
  if (channel === "email") return c.email || null;
  if (channel === "ig_dm") return ig ? c.phone.replace(/^ig:/, "") : null;
  if (channel === "fb_msg") return fb ? c.phone.replace(/^fb:/, "") : null;
  return !ig && !fb && /^\+?\d[\d ()-]*$/.test(c.phone) ? c.phone : null;
}

export async function resolveAudience(
  audienceNode: BcAudienceNode,
  tenantId: string = currentWorkspaceId() || DEFAULT_WORKSPACE_ID,
): Promise<ResolvedAudience> {
  const channel = audienceNode.channel;
  const spec = audienceNode.audience || ({} as BcAudienceSpec);
  const now = Date.now();
  const ws = (tenantId || "").trim() || DEFAULT_WORKSPACE_ID;

  // ---- Modo explicit/csv: la lista viene preformada ----
  if (spec.mode === "explicit" || spec.mode === "csv") {
    const recipients = Array.isArray(spec.recipients)
      ? [...new Set(spec.recipients.map((r) => String(r || "").trim()).filter(Boolean))]
      : [];
    // Intentamos enriquecer con name+in_window24h si el contact existe.
    const map: AudienceContactSummary[] = [];
    for (const r of recipients) {
      const match = await contactForRecipient(r, channel, ws);
      // BAJA: quien pidió no recibir más mensajes queda fuera, incluso si viene en una
      // lista pegada a mano o en un CSV. La petición de baja manda sobre la audiencia.
      if (hasOptedOut(match)) continue;
      const recipient = match ? recipientForChannel(match, channel) : r;
      if (!recipient) continue;
      map.push({
        recipient,
        name: match?.name || "",
        channel,
        in_window_24h: match ? (now - (match.last_inbound || 0)) < WA_FREE_WINDOW_MS : false,
        contact_phone: match?.phone,
        channel_account: match?.channel_account,
      });
    }
    return { contacts: map, total: map.length };
  }

  // ---- Modo tags/segment: filtramos app_contacts ----
  // AND de etiquetas EN SQL, ANTES del LIMIT (ContactFilter.tags): antes el filtro
  // de tags se aplicaba en memoria SOBRE la página traída y contactos que SÍ tenían
  // la etiqueta quedaban fuera del simulate y del envío, sin aviso. El límite
  // declara 2000 (el clamp real de dbSearchContacts): el 5000 anterior era
  // engañoso incluso como intención — db.ts lo recortaba a 2000 en silencio.
  const tags = Array.isArray(spec.tags) ? spec.tags.map((t) => String(t)).filter(Boolean) : [];
  const filter: { stage?: string; source?: string; tags?: string[]; limit: number; tenantId: string } = { limit: 2000, tenantId: ws };
  if (spec.stage) filter.stage = String(spec.stage);
  if (spec.source) filter.source = String(spec.source);
  if (tags.length) filter.tags = tags;

  let arr: Contact[] = await dbSearchContacts(filter);

  // BAJA: quien ha pedido no recibir más mensajes queda FUERA de cualquier audiencia, se
  // filtre como se filtre. Va antes que nada: ninguna combinación de etiquetas, etapa u
  // origen puede volver a meterlo en una difusión.
  arr = arr.filter((c) => !hasOptedOut(c));

  // AND de tags (cinturón: ya vienen filtradas en SQL antes del LIMIT).
  if (tags.length) {
    arr = arr.filter((c) => tags.every((t) => (c.tags || []).includes(t)));
  }

  const summaries: AudienceContactSummary[] = [];
  for (const c of arr) {
    const recipient = recipientForChannel(c, channel);
    if (!recipient) continue;
    summaries.push({
      recipient,
      name: c.name || "",
      channel,
      in_window_24h: (now - (c.last_inbound || 0)) < WA_FREE_WINDOW_MS,
      contact_phone: c.phone,
      channel_account: c.channel_account,
    });
  }
  return { contacts: summaries, total: summaries.length };
}

// ============================================================
// simulateFlow — dry-run para el panel ("¿qué pasaría si lanzo?").
// ============================================================

/**
 * Valida el grafo y resuelve la audiencia sin tocar BD ni enviar nada.
 * Útil para que el operador vea antes:
 *   - "tiene 1.234 destinatarios"
 *   - "813 están dentro de ventana 24h (envío libre)"
 *   - "estimado: 28 USD si lanzas la template Marketing"
 *   - "WARNING: el flow no tiene followup tras 7 días"
 *
 * Errors = fallo bloqueante (el panel no debería dejar 'Lanzar').
 * Warnings = no bloquea pero el operador debería verlo.
 */
export async function simulateFlow(flow: BroadcastFlow): Promise<SimulateResult> {
  const data = flow.data || { nodes: [], edges: [], startId: "" };
  const validation: SimulateValidation = { errors: [], warnings: [] };
  // SEC-1: el simulate corre en el WS dueño del flow. Se propaga a
  // resolveAudience y a la rama de pricing por prefijo.
  const tenantId = (flow.tenant_id || currentWorkspaceId() || DEFAULT_WORKSPACE_ID).trim() || DEFAULT_WORKSPACE_ID;

  // ---- Validation: estructura mínima ----
  if (!Array.isArray(data.nodes) || data.nodes.length === 0) {
    validation.errors.push("El flow no tiene nodos.");
  }
  if (!data.startId) {
    validation.errors.push("Falta el startId (nodo raíz).");
  } else if (!data.nodes.some((n) => n.id === data.startId)) {
    validation.errors.push(`startId '${data.startId}' no apunta a ningún nodo del flow.`);
  }

  const audienceNodes = nodesByType(data, "audience");
  if (audienceNodes.length === 0) {
    validation.errors.push("El flow necesita al menos un nodo 'audience'.");
  }

  const messageNodes = nodesByType(data, "message");
  if (messageNodes.length === 0) {
    validation.warnings.push("El flow no tiene nodos 'message' — no enviará nada al ejecutarse.");
  }
  // LIENZO-1 · El motor manda UN mensaje por audiencia (firstMessageAfter) más
  // su seguimiento. Encadenar dos mensajes se dibuja y se guarda, pero el
  // segundo no sale nunca: es un paso decorativo, igual que lo eran «Espera» y
  // «Condición» antes de retirarlas de la paleta. Se dice en la validación en
  // vez de dejar que el dueño lo descubra cuando no llegue.
  if (messageNodes.length > 1) {
    validation.warnings.push(
      `Esta difusión tiene ${messageNodes.length} mensajes, pero solo se envía el primero. ` +
      "Para escribir otra vez a quien no conteste, usa un paso «Seguimiento».",
    );
  }

  // Validación de canal soportado.
  const validChannels: ReadonlySet<BcChannel> = new Set(["wa", "ig_dm", "fb_msg", "email", "sms"]);
  for (const a of audienceNodes) {
    if (!validChannels.has(a.channel)) {
      validation.errors.push(`Nodo audience '${a.id}': canal '${a.channel}' no soportado.`);
    }
  }

  // Edges huérfanos (apuntan a un nodo inexistente).
  const knownIds = new Set(data.nodes.map((n) => n.id));
  for (const e of data.edges || []) {
    if (!knownIds.has(e.from)) {
      validation.errors.push(`Edge desde nodo desconocido '${e.from}'.`);
    }
    if (!knownIds.has(e.to)) {
      validation.errors.push(`Edge a nodo desconocido '${e.to}'.`);
    }
  }

  // ---- Audience: sumamos por audience node ----
  const byChannel: Record<BcChannel, number> = {
    wa: 0, ig_dm: 0, fb_msg: 0, email: 0, sms: 0,
  };
  let total = 0;
  let inWindow = 0;
  const sample: AudienceContactSummary[] = [];

  // SEC-2: recolectamos recipients WA para estimar coste por prefijo.
  const waRecipients: string[] = [];

  for (const a of audienceNodes) {
    let resolved: ResolvedAudience = { contacts: [], total: 0 };
    try {
      resolved = await resolveAudience(a, tenantId);
    } catch (e) {
      validation.errors.push(
        `Nodo audience '${a.id}': no se pudo resolver (${(e as Error).message.slice(0, 100)}).`,
      );
      continue;
    }
    total += resolved.total;
    byChannel[a.channel] = (byChannel[a.channel] || 0) + resolved.total;
    for (const c of resolved.contacts) {
      if (c.in_window_24h) inWindow++;
      if (sample.length < SAMPLE_SIZE) sample.push(c);
      if (a.channel === "wa") waRecipients.push(c.recipient);
    }
  }

  // ---- SEC-2: coste estimado por prefijo E.164. Solo si hay 'message'
  //      con template_name y canal wa. Si CUALQUIER destinatario WA no
  //      tiene prefijo mapeado, devolvemos null + warning explícito
  //      ("X de Y sin tarifa") — patrón "never fake metrics": el panel
  //      verá "Coste no disponible" en lugar de un número falso.
  let estimatedCost: number | null | undefined;
  const hasWaTemplate = messageNodes.some((m) => m.template_name);
  const waAudienceCount = byChannel.wa || 0;
  if (hasWaTemplate && waAudienceCount > 0) {
    let sum = 0;
    let unknown = 0;
    for (const r of waRecipients) {
      const c = estimateCostForRecipient(r);
      if (c == null) unknown++;
      else sum += c;
    }
    if (unknown > 0) {
      estimatedCost = null;
      validation.warnings.push(
        `Coste estimado no disponible: ${unknown} de ${waRecipients.length} destinatarios WA sin tarifa conocida por prefijo. Verifica E.164 o añade el prefijo a WA_PRICING_CENTS_BY_PREFIX.`,
      );
    } else {
      estimatedCost = sum;
    }
  }

  // ---- Followup sanity check ----
  for (const m of messageNodes) {
    const fu = followupAfter(data, m.id);
    if (fu && fu.wait_for_reply_ms <= 0) {
      validation.warnings.push(
        `Nodo followup tras '${m.id}': wait_for_reply_ms<=0 → se disparará de inmediato.`,
      );
    }
  }

  return {
    audience: {
      total,
      inWindow24h: inWindow,
      outWindow24h: Math.max(0, total - inWindow),
      byChannel,
      sample,
    },
    validation,
    estimatedCost,
  };
}

// ============================================================
// runBroadcastFlow — materializa el run + encola los jobs.
// ============================================================

/**
 * Encola un flow para envío. Pasos:
 *   1. simulate() para validar y traer audiencia.
 *   2. Si errors: tira (el caller responde 400 con la lista).
 *   3. Crea/reutiliza app_broadcasts_runs (status='queued').
 *   4. Por cada destinatario × canal: construye payload con vars
 *      interpoladas y encola en app_broadcasts_jobs.
 *   5. Si opts.scheduledFor → next_run=scheduledFor (drip-respect).
 *   6. logActivity con el resumen.
 *
 * Devuelve el BroadcastRun creado. La ejecución real (el envío) la hace
 * tickBroadcastJobs en background.
 *
 * Importante: este método NO envuelve en runWithWorkspace — asume que el
 * caller (endpoint admin.ts) ya abrió scope ALS vía guard().
 */
export async function runBroadcastFlow(
  flow: BroadcastFlow,
  opts: RunBroadcastFlowOpts = {},
): Promise<BroadcastRun> {
  const tenant_id = flow.tenant_id || currentWorkspaceId() || DEFAULT_WORKSPACE_ID;
  const data = flow.data;

  // 1) Simulate para conocer la audiencia.
  const sim = await simulateFlow(flow);
  if (sim.validation.errors.length) {
    throw new Error(
      `Flow no válido: ${sim.validation.errors.slice(0, 3).join(" · ")}`,
    );
  }

  // 2) Crear o reutilizar run.
  let run: BroadcastRun;
  if (opts.runId) {
    const existing = await dbGetBroadcastRun(opts.runId, tenant_id);
    if (!existing) {
      // RunId ajeno (otro WS) o inexistente → creamos uno nuevo. Patrón
      // ownership-sentinel: NO revelamos cross-WS, simplemente reabrimos.
      run = await dbCreateBroadcastRun({
        tenant_id,
        flow_id: flow.id,
        scheduled_for: opts.scheduledFor ?? null,
        audience_total: sim.audience.total,
      });
    } else {
      run = existing;
    }
  } else {
    run = await dbCreateBroadcastRun({
      tenant_id,
      flow_id: flow.id,
      scheduled_for: opts.scheduledFor ?? null,
      audience_total: sim.audience.total,
    });
  }

  // 3) Construir lista de jobs a encolar.
  // Para cada audience node, resolvemos los contactos y los unimos al nodo
  // message inmediatamente después. El payload del job incluye el contenido
  // interpolado y referencia al messageNode para que el followup pueda
  // re-leer su config en tickFollowups.
  const audienceNodes = nodesByType(data, "audience");
  const jobInputs: BroadcastJobInput[] = [];
  const scheduledFor = opts.scheduledFor ?? null;

  for (const a of audienceNodes) {
    const msgNode = firstMessageAfter(data, a.id);
    if (!msgNode) {
      // Sin message → no hay nada que encolar para esta rama. Marcamos
      // warning silencioso en logs; el simulate ya lo habrá pintado.
      continue;
    }
    let resolved: ResolvedAudience;
    try {
      resolved = await resolveAudience(a, tenant_id);
    } catch {
      continue; // simulate ya lo reportó como error; aquí solo skip.
    }
    const fu = followupAfter(data, msgNode.id);

    for (const c of resolved.contacts) {
      // Resolve vars del payload. Si el contacto tiene perfil en BD, lo
      // usamos para que {{name}}/{{tag.X}} funcionen. Si no, solo se
      // substituye con el recipient como fallback minimal.
      // SEC-1: tenantId obligatorio en cada lookup (evita fuga cross-WS).
      const ctxContact = await contactForRecipient(c.contact_phone || c.recipient, a.channel, tenant_id);

      // Sustitución de vars: si falla (strict-mode + var sin fallback),
      // saltamos este destinatario y dejamos warning en log.
      let text = msgNode.text || "";
      try {
        if (text) text = substituteVars(text, ctxContact, { strict: false });
      } catch {
        text = msgNode.text || "";
      }

      const payload: Record<string, unknown> = {
        contact_phone: c.contact_phone || null,
        ig_account_id: a.channel === "ig_dm" && c.channel_account?.startsWith("ig:") ? c.channel_account.slice(3) : null,
        fb_page_id: a.channel === "fb_msg" && c.channel_account?.startsWith("fb:") ? c.channel_account.slice(3) : null,
        message_node_id: msgNode.id,
        text,
        image_url: msgNode.image_url || null,
        template_name: msgNode.template_name || null,
        template_components: msgNode.template_components || null,
        buttons: Array.isArray(msgNode.buttons) ? msgNode.buttons : null,
        // REG-3: cap por phoneNumberId. Si el nodo message lo trae
        // explícito, sendByChannel hará runWithWaNumber para que creds()
        // resuelva ese número (multi-WABA). Si vacío, fallback al
        // principal del WS.
        wa_phone_number_id: msgNode.wa_phone_number_id || null,
        // Followup info para tickFollowups — embebido para evitar releer flow:
        followup: fu
          ? {
              node_id: fu.id,
              wait_for_reply_ms: fu.wait_for_reply_ms,
              text: fu.text || null,
              image_url: fu.image_url || null,
              template_name: fu.template_name || null,
            }
          : null,
      };

      jobInputs.push({
        tenant_id,
        run_id: run.id,
        flow_id: flow.id,
        recipient: c.recipient,
        channel: a.channel,
        payload,
        next_run: scheduledFor ?? Date.now(),
      });
    }
  }

  const enqueued = await dbEnqueueJobs(jobInputs);

  // 4) Marcar run en running si no es programado.
  if (!scheduledFor) {
    await dbUpdateBroadcastRunStatus(run.id, tenant_id, "running", {
      started_at: Date.now(),
    });
  }

  // 5) Persistir el resultado del simulate como last_sim_result (audit trail).
  await dbUpdateBroadcastFlowSim(flow.id, tenant_id, {
    audience: sim.audience,
    estimatedCost: sim.estimatedCost ?? null,
    ranAt: Date.now(),
    runId: run.id,
  }).catch(() => {/* sim trail no debe romper run */});

  // 6) Telemetría — un solo evento por run, no por job (volumen).
  await logActivity({
    source: "broadcast",
    level: "info",
    summary: `Flow "${flow.name}" encolado, ${enqueued} jobs (run ${run.id})`,
    payload: {
      file: "broadcast-flows.ts",
      fn: "runBroadcastFlow",
      flow_id: flow.id,
      run_id: run.id,
      audience_total: sim.audience.total,
      jobs_enqueued: enqueued,
      scheduled: scheduledFor != null,
    },
  });

  return run;
}

/**
 * Cancela un run + sus jobs aún en cola. Wrapper alrededor de
 * dbCancelBroadcastRun con telemetría. Requiere tenant_id explícito (lo
 * pasa el endpoint, no asume currentWorkspaceId — el call-site valida
 * ownership antes).
 */
export async function cancelBroadcastRun(runId: string, tenantId: string): Promise<void> {
  await dbCancelBroadcastRun(runId, tenantId);
  await logActivity({
    source: "broadcast",
    level: "info",
    summary: `Run ${runId} cancelado`,
    payload: {
      file: "broadcast-flows.ts",
      fn: "cancelBroadcastRun",
      run_id: runId,
    },
  });
}

// ============================================================
// sendByChannel — routea el envío al canal apropiado.
// ============================================================

/**
 * Routea un job al canal correcto. Devuelve un descriptor del resultado:
 *   - status: 'sent' | 'failed' | 'skipped'
 *   - reason: motivo (solo skip/fail).
 *   - messageId: id devuelto por la plataforma (wamid/mid).
 *   - retryable: si el fail es recuperable (network/5xx) → backoff.
 *
 * Reglas especiales WA (canal 'wa'):
 *   - Si el job no tiene template_name Y el contacto NO está en ventana
 *     24h → 'skipped' (no consume retry; no tiene sentido seguir).
 *   - Si tiene template_name → sendTemplate (válido fuera de 24h).
 *
 * Email/SMS: stubs por ahora — devolvemos 'skipped' con reason claro
 * para que la UI muestre "canal no implementado".
 */
async function sendByChannel(job: BroadcastJob): Promise<{
  status: "sent" | "failed" | "skipped" | "throttled";
  reason?: string;
  message_id?: string;
  retryable?: boolean;
  /** NUM-RETIRADO-1 · cuánto esperar antes de reconsiderarlo, para un 'throttled' que no
   *  es el cupo por segundo sino una espera larga (el número aún no ha vuelto). */
  retryInMs?: number;
}> {
  const p = job.payload || {};
  const text = String((p as { text?: unknown }).text || "");
  const imageUrl = (p as { image_url?: unknown }).image_url
    ? String((p as { image_url?: unknown }).image_url)
    : "";
  const buttons = Array.isArray((p as { buttons?: unknown }).buttons)
    ? ((p as { buttons?: unknown }).buttons as unknown[]).map((b) => String(b)).filter(Boolean)
    : [];
  const templateName = (p as { template_name?: unknown }).template_name
    ? String((p as { template_name?: unknown }).template_name)
    : "";
  const templateComponents = (p as { template_components?: unknown }).template_components as
    | Record<string, unknown>
    | undefined;
  // REG-3: phoneNumberId explícito propagado por runBroadcastFlow desde
  // BcMessageNode.wa_phone_number_id. Si null/undefined, fallback al
  // número principal del WS (creds() sin scope ALS).
  const waPhoneNumberId = (p as { wa_phone_number_id?: unknown }).wa_phone_number_id
    ? String((p as { wa_phone_number_id?: unknown }).wa_phone_number_id)
    : "";

  // REVISION-DIFUSION-1 · La audiencia es una foto al programar. La baja se
  // comprueba de nuevo justo antes de enviar, también en plantillas y seguimientos.
  let contact: Contact | null;
  try {
    contact = await contactForRecipient(String(p.contact_phone || job.recipient), job.channel, job.tenant_id);
  } catch {
    // REVISION-DIFUSION-2 · Una lectura temporalmente fallida no permite
    // enviar, pero tampoco debe agotar el trabajo antes del primer intento.
    return { status: "failed", reason: "No se pudo comprobar el estado actual del contacto", retryable: true };
  }
  if (hasOptedOut(contact)) {
    return { status: "skipped", reason: "Pidió no recibir mensajes antes de que le tocara el turno" };
  }

  switch (job.channel) {
    case "wa": {
      // Ventana 24h: si NO template y el último inbound fue hace >24h → skip.
      // Buscamos el contact por phone para chequear last_inbound.
      if (!templateName) {
        const account = waPhoneNumberId && contact && (contact.channel_account || Object.keys(contact.last_inbound_by || {}).length) ? "wa:" + waPhoneNumberId : "";
        const inWindow = contact && inWindowFor(contact, account);
        if (!inWindow) {
          return {
            status: "skipped",
            reason: "fuera de ventana 24h y sin template",
          };
        }
      }

      // REG-3: resolver número WABA + creds. Si el nodo trae phoneNumberId
      // explícito y existe en listWaNumbers, runWithWaNumber empuja sus
      // creds al ALS; sino, fallback al principal del WS.
      const resolved = waPhoneNumberId ? resolveWaNumber(waPhoneNumberId) : null;
      const effectivePid = resolved?.phoneNumberId || waPhoneNumberId;

      // T02 · SIN fallback silencioso: si el nodo eligió un número emisor y ese
      // número ya no está conectado, el job FALLA con causa — no reintentable
      // (reintentar no lo reconecta) y jamás sale por el principal a escondidas.
      // Antes este caso caía a doSend() con las credenciales principales y una
      // difusión segmentada por número podía salir entera por el principal.
      if (waPhoneNumberId && !resolved) {
        if (esNumeroRetirado(waPhoneNumberId)) {
          // 'throttled' no consume intentos: espera indefinidamente a que vuelva, que es
          // lo que el dueño pidió. Un minuto entre miradas es de sobra.
          return {
            status: "throttled",
            reason: "el número emisor está desconectado; el envío espera a que vuelva",
            retryInMs: 60_000,
          };
        }
        return {
          status: "failed",
          reason: `el número emisor elegido (${waPhoneNumberId}) ya no está conectado en este workspace`,
          retryable: false,
        };
      }

      // DIFUSION-QR-1 · red de seguridad del MOTOR. Los endpoints ya rechazan un emisor
      // por QR, pero una difusión programada ANTES de este cambio puede llevar uno
      // guardado en su fila y se ejecutaría igual al llegar su hora. No se envía, y no
      // se reintenta: reintentar no convierte un QR en un número de Meta.
      if (resolved?.transport === "qr") {
        return { status: "failed", reason: MOTIVO_QR_SIN_DIFUSION, retryable: false };
      }

      // REG-3: token bucket per-phoneNumberId. Si está lleno → "throttled"
      // (caller reagenda +200ms SIN tocar attempts → no consume retry).
      if (effectivePid && !tryAcquireWaSlot(effectivePid)) {
        return {
          status: "throttled",
          reason: `cap ${WA_PER_NUMBER_CAP_PER_SECOND}/s alcanzado en ${effectivePid}`,
        };
      }

      // DIFUSION-FIX-5 · sendText/sendImage/sendButtons devuelven un BOOLEANO
      // (false = Meta lo rechazó o no hay credenciales); no lanzan. Se estaba
      // tirando, así que el catch de abajo nunca se enteraba y el job se marcaba
      // 'sent'. Resultado: «enviados: 300 · fallos: 0» sin que saliera nada, y
      // sin reintento, porque para el motor no había fallado nada.
      const doSend = async (): Promise<boolean> => {
        if (templateName) {
          // bodyParams: extraemos array si template_components trae `body_params`.
          const bodyParams: string[] = Array.isArray(
            (templateComponents as { body_params?: unknown })?.body_params,
          )
            ? ((templateComponents as { body_params: unknown[] }).body_params).map((x) =>
                String(x || ""),
              )
            : [];
          const lang = String((templateComponents as { lang?: unknown })?.lang || "es");
          // sendTemplate lanza en caso de fallo (lo recoge el catch de abajo).
          await sendTemplate(job.recipient, templateName, lang, bodyParams);
          return true;
        } else if (imageUrl && buttons.length) {
          return await sendButtons(job.recipient, text, buttons, undefined, imageUrl);
        } else if (imageUrl) {
          return await sendImage(job.recipient, imageUrl, text);
        } else if (buttons.length) {
          return await sendButtons(job.recipient, text, buttons);
        } else {
          return await sendText(job.recipient, text);
        }
      };

      try {
        let entregado = false;
        if (resolved) {
          entregado = await runWithWaNumber(
            { token: resolved.token, phoneId: resolved.phoneNumberId },
            doSend,
          );
        } else {
          // Sin pid explícito (nodo sin emisor elegido): número principal del WS
          // (contrato REG-3). El caso "pid elegido pero no conectado" ya NO llega
          // aquí: falla arriba con causa (T02, sin fallback silencioso).
          entregado = await doSend();
        }
        if (!entregado)
          return {
            status: "failed",
            reason: "WhatsApp no aceptó el mensaje (revisa la conexión del número o el contenido)",
            retryable: true,
          };
        return { status: "sent" };
      } catch (e) {
        return {
          status: "failed",
          reason: (e as Error).message.slice(0, 200),
          retryable: (e as { retryable?: boolean }).retryable !== false,
        };
      }
    }
    case "ig_dm": {
      const igId = String(p.ig_account_id || (contact?.channel_account?.startsWith("ig:") ? contact.channel_account.slice(3) : ""));
      const account = igId ? resolveAccount(igId) : null;
      if (igId && !account) return { status: "failed", reason: "La cuenta de Instagram de esta conversación ya no está conectada", retryable: false };
      try {
        if (account) await runWithAccount(account, () => sendIgText(job.recipient, text));
        else await sendIgText(job.recipient, text);
        return { status: "sent" };
      } catch (e) {
        return {
          status: "failed",
          reason: (e as Error).message.slice(0, 200),
          retryable: true,
        };
      }
    }
    case "fb_msg": {
      // La página queda fijada al encolar; los trabajos antiguos la leen de la ficha.
      const pageId = String(p.fb_page_id || (contact?.channel_account?.startsWith("fb:") ? contact.channel_account.slice(3) : ""));
      if (!pageId) {
        return { status: "skipped", reason: "fb_msg sin fb_page_id en payload" };
      }
      try {
        await sendFbText(job.recipient, text, pageId);
        return { status: "sent" };
      } catch (e) {
        return {
          status: "failed",
          reason: (e as Error).message.slice(0, 200),
          retryable: true,
        };
      }
    }
    case "email":
      return { status: "skipped", reason: "canal email no implementado en este release" };
    case "sms":
      return { status: "skipped", reason: "canal sms no implementado en este release" };
    default:
      return { status: "skipped", reason: `canal desconocido: ${job.channel}` };
  }
}

// ============================================================
// tickBroadcastJobs — worker periódico (15 s).
// ============================================================

/**
 * Procesa hasta TICK_BATCH_SIZE jobs vencidos. Devuelve cuántos procesó
 * (sent + failed + skipped). El caller (registerBroadcastFlowsWorker)
 * lo llama vía setInterval; pero también lo puede invocar el endpoint
 * "Forzar tick" del panel para pruebas.
 *
 * Loop:
 *   1. dbDueJobs(50) → lote con FOR UPDATE SKIP LOCKED.
 *   2. Por cada job:
 *      a. runWithWorkspace(job.tenant_id) — telemetría y settings ws-aware.
 *      b. try sendByChannel(job).
 *      c. switch status:
 *         - sent    → dbMarkJobSent.
 *         - skipped → dbMarkJobFailed con retryDelay=0 (status='failed').
 *                     Nota: el contrato del helper no tiene 'skipped'
 *                     directo; lo registramos con last_error claro y
 *                     attempts+=1 — el panel los pinta como skip vía UI.
 *         - failed  → retry si attempts < MAX. Backoff 2/4/8 min.
 *   3. Tras cada job, actualizamos contadores del run cada 10 jobs (no
 *      hot-path para no martillear PG con UPDATE por cada envío).
 *
 * NO usa transacción larga: el lock de dbDueJobs() se suelta al volver
 * (autocommit). Es un tradeoff: si dos réplicas hacen el mismo tick al
 * mismo instante, podrían coger jobs solapados. SKIP LOCKED mitiga
 * dentro de la misma query; en lapsus entre queries, el dedup parcial
 * de app_broadcasts_jobs evita el doble envío (UNIQUE PARCIAL en queued/sent).
 */
export async function tickBroadcastJobs(): Promise<number> {
  let processed = 0;
  let due: BroadcastJob[] = [];

  // REG-1: abrimos un cliente dedicado y hacemos BEGIN. dbDueJobs ejecuta
  // SELECT FOR UPDATE SKIP LOCKED DENTRO de esta transacción — el lock se
  // mantiene hasta el COMMIT. Esto evita que otra réplica de Railway
  // re-procese los mismos jobs (autocommit los soltaba al volver de la
  // query, dejando una ventana entre SELECT y dbMarkJobSent).
  //
  // Tradeoff conocido: la transacción permanece abierta mientras se
  // ejecutan los sendByChannel (HTTP a Meta Graph). Si la red lenta tira
  // un job a 5s, la conexión queda ocupada esos 5s. Aceptable porque:
  //   - pool max=5 y batch=50 → throughput suficiente para los volúmenes
  //     de broadcast típicos (millares no millones).
  //   - El lock es la única garantía at-most-once multi-replica.
  //   - Si el proceso muere a media tx, PG hace ROLLBACK automático y
  //     los jobs vuelven a 'queued' → el siguiente tick los recoge.
  const client = await dbGetClient().catch((e) => {
    console.error("[broadcast-flows] tickBroadcastJobs:getClient:", (e as Error).message);
    return null;
  });

  // REVISION-DIFUSION-1 · Sin conexión no se puede mantener el bloqueo de los
  // trabajos. Solo el almacén en memoria admite la ruta sin transacción.
  if (!client && hasDb) return 0;

  // En memoria no hay réplicas ni transacciones de Postgres.
  if (!client) {
    try {
      due = await dbDueJobs({ limit: TICK_BATCH_SIZE });
    } catch (e) {
      console.error("[broadcast-flows] tickBroadcastJobs:dueQuery:", (e as Error).message);
      await logActivity({
        source: "broadcast",
        level: "error",
        summary: `tickBroadcastJobs dueQuery falló: ${(e as Error).message.slice(0, 160)}`,
        payload: {
          file: "broadcast-flows.ts",
          fn: "tickBroadcastJobs.dueQuery",
          error: (e as Error).message.slice(0, 400),
        },
      });
      return 0;
    }
    if (!due.length) return 0;
    processed = await processDueJobsBatch(due, null);
    await updateRunCounters(due);
    return processed;
  }

  try {
    await client.query("BEGIN");
    try {
      due = await dbDueJobs({ limit: TICK_BATCH_SIZE, client });
    } catch (e) {
      console.error("[broadcast-flows] tickBroadcastJobs:dueQuery:", (e as Error).message);
      await client.query("ROLLBACK").catch(() => {/* mejor esfuerzo */});
      await logActivity({
        source: "broadcast",
        level: "error",
        summary: `tickBroadcastJobs dueQuery falló: ${(e as Error).message.slice(0, 160)}`,
        payload: {
          file: "broadcast-flows.ts",
          fn: "tickBroadcastJobs.dueQuery",
          error: (e as Error).message.slice(0, 400),
        },
      });
      return 0;
    }
    if (!due.length) {
      await client.query("COMMIT").catch(() => {/* mejor esfuerzo */});
      return 0;
    }
    processed = await processDueJobsBatch(due, client);
    await client.query("COMMIT");
  } catch (e) {
    console.error("[broadcast-flows] tickBroadcastJobs:tx:", (e as Error).message);
    await client.query("ROLLBACK").catch(() => {/* mejor esfuerzo */});
    return processed;
  } finally {
    client.release();
  }

  await updateRunCounters(due);
  return processed;
}

/**
 * REG-1: extrae la rama de procesamiento del lote (envío + mark sent/failed)
 * para que tickBroadcastJobs pueda invocarla tanto en modo transaccional
 * (multi-replica safe) como en mem-mode fallback. `client` propaga el
 * mismo PoolClient para que el UPDATE viva en la misma tx.
 */
async function processDueJobsBatch(
  due: BroadcastJob[],
  client: import("pg").PoolClient | null,
): Promise<number> {
  let processed = 0;
  for (const job of due) {
    const tenant = job.tenant_id || DEFAULT_WORKSPACE_ID;
    await runWithWorkspace(tenant, async () => {
      try {
        const r = await sendByChannel(job);
        if (r.status === "sent") {
          await dbMarkJobSent(job.id, tenant, r.message_id ?? null, undefined, client ?? undefined);
        } else if (r.status === "throttled") {
          // REG-3: bucket per-phoneNumberId lleno. Reagendar +200ms SIN
          // tocar attempts (no consume retry). El siguiente tick lo
          // reconsidera; cuando la ventana de 1s pase, el slot se libera.
          await dbRequeueJobNoAttempt(
            job.id,
            tenant,
            r.retryInMs ?? WA_THROTTLE_REQUEUE_DELAY_MS,
            client ?? undefined,
          );
        } else if (r.status === "skipped") {
          // Marcamos failed con error="skip: <reason>" y SIN retry. El
          // panel reconoce el prefijo "skip:" para pintarlo como skip
          // (gris) en lugar de error (rojo).
          await dbMarkJobFailed(
            job.id,
            tenant,
            `skip: ${r.reason || "n/a"}`,
            0,
            client ?? undefined,
          );
        } else {
          // failed → retry si quedan intentos.
          const nextAttempt = (job.attempts || 0) + 1;
          if (r.retryable && nextAttempt < MAX_ATTEMPTS) {
            const delay = RETRY_DELAYS_MS[nextAttempt - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
            await dbMarkJobFailed(
              job.id,
              tenant,
              r.reason || "send failed",
              delay,
              client ?? undefined,
            );
          } else {
            await dbMarkJobFailed(
              job.id,
              tenant,
              r.reason || "send failed",
              0,
              client ?? undefined,
            );
            // Telemetría solo en el fail definitivo (no en cada retry).
            await logActivity({
              source: "broadcast",
              level: "error",
              summary: `Job ${job.id} (${job.channel}) falló definitivamente: ${(r.reason || "").slice(0, 100)}`,
              payload: {
                file: "broadcast-flows.ts",
                fn: "tickBroadcastJobs.sendByChannel",
                job_id: job.id,
                run_id: job.run_id,
                flow_id: job.flow_id,
                channel: job.channel,
                recipient_masked: job.recipient.slice(0, 3) + "***" + job.recipient.slice(-3),
                attempts: nextAttempt,
                error: (r.reason || "").slice(0, 400),
              },
            });
          }
        }
      } catch (e) {
        // Excepción no controlada del send (NO debería pasar — sendByChannel
        // captura todo). Cerramos el job como failed para no dejarlo zombi.
        console.error("[broadcast-flows] job", job.id, "uncaught:", (e as Error).message);
        await dbMarkJobFailed(
          job.id,
          tenant,
          `uncaught: ${(e as Error).message.slice(0, 200)}`,
          0,
          client ?? undefined,
        );
        await logActivity({
          source: "broadcast",
          level: "error",
          summary: `tickBroadcastJobs uncaught en job ${job.id}: ${(e as Error).message.slice(0, 160)}`,
          payload: {
            file: "broadcast-flows.ts",
            fn: "tickBroadcastJobs.uncaught",
            job_id: job.id,
            error: (e as Error).message.slice(0, 400),
          },
        });
      }
      processed++;
    });
  }
  return processed;
}

/**
 * REG-1: actualiza contadores del run tras COMMIT. Se ejecuta FUERA de
 * la transacción del batch para no extender el lock — los UPDATE a
 * app_broadcasts_runs no compiten con el SKIP LOCKED de jobs y pueden
 * vivir en autocommit. Una query agregada por run distinto del lote
 * (no por job → evita N updates).
 */
async function updateRunCounters(due: BroadcastJob[]): Promise<void> {
  const runIds = Array.from(new Set(due.map((j) => `${j.tenant_id}::${j.run_id}`)));
  for (const key of runIds) {
    const [tenant, runId] = key.split("::");
    try {
      const counts = await dbCountJobsByStatus(runId, tenant);
      const run = await dbGetBroadcastRun(runId, tenant);
      if (!run || run.status === "cancelled" || run.status === "failed") continue;
      // Si ya no quedan queued → run completado.
      const allDone = counts.queued === 0;
      await runWithWorkspace(tenant, async () => {
        await dbUpdateBroadcastRunStatus(
          runId,
          tenant,
          allDone ? "completed" : "running",
          {
            jobs_sent: counts.sent,
            jobs_failed: counts.failed + counts.skipped,
            jobs_replied: counts.replied,
            ...(allDone ? { ended_at: Date.now() } : {}),
          },
        );
      });
    } catch {/* run-status update best-effort */}
  }
}

// ============================================================
// tickFollowups — worker periódico (60 s).
// ============================================================

/**
 * Busca jobs 'sent' con followup vinculado donde:
 *   - sent_at + wait_for_reply_ms <= now
 *   - replied_at IS NULL                          → rama onNoReply
 *   - replied_at IS NOT NULL                      → rama onReply
 *
 * Para 'onNoReply': encola un nuevo job (mismo recipient/channel) con el
 * payload del followup. Marcamos un flag `followup_fired:true` en el job
 * original para no re-evaluar (idempotencia en re-tick).
 *
 * Para 'onReply': de momento no encola nada extra (la rama onReply suele
 * ser tag/stage change → eso lo hace el hook D5 directamente). El followup
 * solo cierra el ciclo.
 *
 * Limita el lote para no pelear con el tickJobs principal. Devuelve cuántos
 * followups disparó.
 */
export async function tickFollowups(): Promise<number> {
  // Lectura: jobs 'sent' del WS activo con payload.followup ≠ null y aún
  // no marcados followup_fired. Buscamos solo los últimos 500 sent (el
  // followup_fired flag idempotente evita reprocesos).
  //
  // No tenemos pool exportado para hacer query directa — iteramos por
  // workspaces no es viable aquí. Estrategia simple: el tick saca todos
  // los sent recientes vía dbListBroadcastJobs SIN filtrar por tenant
  // (cross-tenant tolerated en lectura interna), y por cada uno entra
  // a runWithWorkspace(job.tenant_id). Como dbListBroadcastJobs sí filtra
  // por tenantId, llamamos sin parámetros (= 'default') para single-WS
  // y dejamos el multi-WS para una iteración posterior cuando exportemos
  // pool desde db.ts.

  // El almacén en memoria soporta lo que este worker necesita (listar jobs
  // 'sent', encolar y marcar el flag), así que ya no se corta en seco: sin esa
  // salida no había forma de probar los seguimientos fuera de producción, y
  // llevaban rotos desde que se escribieron precisamente por eso.
  let fired = 0;

  // Iteración multi-tenant: para evitar dependencia de pool, en este
  // primer release iteramos sólo el tenant activo (currentWorkspaceId).
  // El cron-tick general no abre scope → cae a 'default', que es el seed.
  // FOLLOWUP-3 · Un tick recorre TODOS los workspaces, no solo el que
  // currentWorkspaceId() devuelve fuera de scope (que es siempre 'default').
  // Cada uno se procesa dentro de su propio runWithWorkspace, igual que hacen
  // el scheduler de avisos y el resto de workers del repo.
  let workspaces: Array<{ id: string }>;
  try { workspaces = await listWorkspacesCached(); }
  catch { workspaces = [{ id: currentWorkspaceId() || "default" }]; }
  let sentJobs: BroadcastJob[] = [];
  for (const ws of workspaces) {
    if (!ws.id || ws.id === "_global_") continue;
    try {
      // REVISION-DIFUSION-1 · Los 500 envíos recientes pueden no tener
      // seguimiento o haberlo disparado ya. Hay que alcanzar las páginas
      // siguientes para que las difusiones antiguas no queden olvidadas.
      const vistos = new Set<string>();
      for (let offset = 0; ; offset += 500) {
        const suyos = await dbListBroadcastJobs({ tenantId: ws.id, status: "sent", limit: 500, offset });
        for (const j of suyos) {
          if (vistos.has(j.id)) continue;
          vistos.add(j.id);
          if (j.payload?.followup && !j.payload?.followup_fired) sentJobs.push(j);
        }
        if (suyos.length < 500) break;
      }
    } catch (e) {
      // Un workspace con la BD en mal momento no puede dejar sin seguimiento a
      // los demás: se anota y se sigue con el siguiente.
      console.error("[broadcast-flows] tickFollowups:list:" + ws.id + ":", (e as Error).message);
    }
  }
  if (!sentJobs.length) return 0;

  const now = Date.now();
  for (const job of sentJobs) {
    const p = job.payload || {};
    const followup = (p as { followup?: unknown }).followup as
      | {
          node_id?: string;
          wait_for_reply_ms?: number;
          text?: string | null;
          image_url?: string | null;
          template_name?: string | null;
        }
      | null
      | undefined;
    if (!followup || !followup.wait_for_reply_ms) continue;
    const fired_before = (p as { followup_fired?: unknown }).followup_fired;
    if (fired_before === true) continue;

    const due_at = (job.sent_at || 0) + Number(followup.wait_for_reply_ms || 0);
    if (due_at > now) continue;

    await runWithWorkspace(job.tenant_id, async () => {
      try {
        // REVISION-DIFUSION-1 · Cancelar incluye el seguimiento todavía no
        // encolado. El mensaje principal enviado permanece en el historial.
        const run = await dbGetBroadcastRun(job.run_id, job.tenant_id);
        if (!run || run.status === "cancelled" || run.status === "failed") {
          await dbMarkFollowupFired(job.id, job.tenant_id);
          return;
        }
        if (job.replied_at != null) {
          // Rama onReply: el destinatario contestó. El followup queda
          // como "no necesario" — se marca fired para no re-evaluar.
          // (Las acciones tag/stage/startFlow las dispara el hook D5.)
          await dbMarkFollowupFired(job.id, job.tenant_id);
        } else {
          // INTERRUPTOR DEL CANAL: un seguimiento ("si no contesta en 2 días, mándale
          // esto") es un mensaje DIFERIDO y automático. La difusión original la lanzó el
          // dueño a propósito; este de después, no. Si el canal está apagado no se
          // encola, y salimos SIN contarlo como disparado: al reencender el canal, el
          // siguiente tick vuelve a considerarlo en lugar de haberlo perdido.
          // Explícito por canal, sin catch-all: email y sms NO los gobierna este
          // interruptor (no son canales de bot), y con un ternario "todo lo demás →
          // whatsapp" acabarían bloqueados por el interruptor de WhatsApp el día que se
          // implementen.
          const chanOff =
            job.channel === "wa" ? !autoReplyOn("whatsapp")
            : job.channel === "ig_dm" ? !autoReplyOn("instagram")
            : job.channel === "fb_msg" ? !autoReplyOn("facebook")
            : false;
          if (chanOff) return;

          // Rama onNoReply: encolamos un nuevo job con el payload del followup.
          const newPayload: Record<string, unknown> = {
            contact_phone: p.contact_phone || null,
            ig_account_id: p.ig_account_id || null,
            fb_page_id: p.fb_page_id || null,
            text: followup.text || "",
            image_url: followup.image_url || null,
            template_name: followup.template_name || null,
            // T02 · El seguimiento HEREDA el número emisor del mensaje principal:
            // antes salía siempre por el principal aunque el mensaje original
            // hubiera salido por un número secundario (emisor distinto a mitad de
            // hilo, sin ventana abierta con ese número → rechazo de Meta).
            wa_phone_number_id: (p as { wa_phone_number_id?: unknown }).wa_phone_number_id || null,
            // Importante: NO traemos otro followup encadenado para evitar
            // cascadas infinitas. Si el operador quiere followups en serie
            // los define con varios nodos en el grafo.
            followup: null,
            followup_of_job_id: job.id,
          };
          await dbEnqueueJobs([
            {
              tenant_id: job.tenant_id,
              run_id: job.run_id,
              flow_id: job.flow_id,
              recipient: job.recipient,
              channel: job.channel,
              payload: newPayload,
              next_run: now, // followup va sin delay extra
              // FOLLOWUP-1 · El seguimiento es OTRO paso, no un duplicado del
              // mensaje: con su propia identidad ya no choca con el índice.
              step_key: "fu:" + String(followup.node_id || "seguimiento"),
            },
          ]);
          // Y se marca DESPUÉS de encolar: si el encolado revienta, salta al
          // catch sin marcar y el siguiente tick vuelve a intentarlo.
          await dbMarkFollowupFired(job.id, job.tenant_id);
        }
        fired++;
      } catch (e) {
        await logActivity({
          source: "broadcast",
          level: "error",
          summary: `tickFollowups falló para job ${job.id}: ${(e as Error).message.slice(0, 160)}`,
          payload: {
            file: "broadcast-flows.ts",
            fn: "tickFollowups",
            job_id: job.id,
            error: (e as Error).message.slice(0, 400),
          },
        });
      }
    });
  }
  return fired;
}

// ============================================================
// onBroadcastInboundReply — hook que dispara el webhook al recibir
// un inbound del destinatario.
// ============================================================

/**
 * Llamado por el webhook WA/IG/FB cuando llega un inbound de un contacto.
 * Busca jobs 'sent' al que respondió ese contacto en el WS dado dentro
 * de los últimos 7 días, marca replied_at y actualiza contadores.
 *
 * El TTL de 7 días impide que un inbound a las semanas de un broadcast
 * cuente como "respuesta". También respeta la regla de Meta WA: la
 * ventana 24h de respuesta libre solo opera dentro de las 24 h del último
 * inbound — nuestra señal de "respondió al broadcast" no tiene por qué
 * coincidir, así que damos margen pero acotamos.
 */
export async function onBroadcastInboundReply(
  recipient: string,
  channel: BcChannel,
  wsId: string,
): Promise<void> {
  if (!recipient || !channel) return;
  const tenant = (wsId || "").trim() || DEFAULT_WORKSPACE_ID;

  let affected: BroadcastJob[] = [];
  try {
    // REG-2: lookup directo por SQL con WHERE recipient=$ + indice parcial
    // idx_bcjobs_unreplied (status='sent' AND replied_at IS NULL). Antes
    // cargabamos 500 jobs sent del WS y filtrabamos en memoria — O(N) por
    // webhook. Ahora es O(log N) y el resultado es exacto sin filtrar.
    affected = await dbFindUnrepliedJobsByRecipient({
      tenantId: tenant,
      recipient,
      channel,
      sinceDays: Math.ceil(REPLY_HOOK_TTL_MS / (24 * 60 * 60 * 1000)),
    });
  } catch (e) {
    console.error("[broadcast-flows] onBroadcastInboundReply:list:", (e as Error).message);
    return;
  }

  if (!affected.length) return;

  await runWithWorkspace(tenant, async () => {
    const runIds = new Set<string>();
    for (const j of affected) {
      try {
        await dbMarkJobReplied(j.id, tenant);
        runIds.add(j.run_id);
      } catch {/* per-job best-effort */}
    }
    // Recompute jobs_replied per run afectado.
    for (const runId of runIds) {
      try {
        const counts = await dbCountJobsByStatus(runId, tenant);
        const run = await dbGetBroadcastRun(runId, tenant);
        if (!run) continue;
        // Una respuesta modifica las métricas, nunca reabre una ejecución.
        await dbUpdateBroadcastRunStatus(runId, tenant, run.status, {
          jobs_sent: counts.sent,
          jobs_failed: counts.failed + counts.skipped,
          jobs_replied: counts.replied,
        });
      } catch {/* run counter update best-effort */}
    }
  });
}

// ============================================================
// registerBroadcastFlowsWorker — arranque del worker.
// ============================================================

let jobsTimer: ReturnType<typeof setInterval> | null = null;
let followupsTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Arranca los dos workers de broadcast-flows. Idempotente: si ya están
 * arrancados, no duplica timers. Lo llama index.ts en el boot, junto con
 * los demás schedulers (startPostScheduler, startFlowScheduler, etc.).
 *
 * Cadencias:
 *   - jobs: 15 s (responsive sin overload; el lote es de 50 → 200 jobs/min
 *           por replica, suficiente para los broadcasts típicos).
 *   - followups: 60 s (no necesita ser fino; un minuto de granularidad
 *                en "envío de seguimiento tras 2 h" es invisible al user).
 *
 * Ambos ticks están envueltos en try/catch interno para que NUNCA tiren
 * el process.
 */
export function registerBroadcastFlowsWorker(): void {
  if (jobsTimer || followupsTimer) return;

  // DIFUSION-SOLAPE-1 · tickBroadcastJobs abre un cliente dedicado del pool (max 5) y mantiene
  // la transacción abierta mientras manda hasta 50 trabajos a Meta en serie. Si una tanda
  // dura más de 15 s, el siguiente tick abría OTRO cliente (SKIP LOCKED le daba los 50
  // siguientes) y así hasta dejar al panel sin conexiones. Un tick a la vez; el que llega
  // mientras otro trabaja no hace nada, y el siguiente ya ve las filas libres.
  let jobsBusy = false;
  jobsTimer = setInterval(() => {
    if (jobsBusy) return;
    jobsBusy = true;
    tickBroadcastJobs()
      .catch((e) => {
        console.error("[broadcast-flows] jobs tick:", (e as Error).message);
      })
      .finally(() => { jobsBusy = false; });
  }, 15_000);

  followupsTimer = setInterval(() => {
    tickFollowups().catch((e) => {
      console.error("[broadcast-flows] followups tick:", (e as Error).message);
    });
  }, 60_000);

  console.log("[broadcast-flows] worker activo (jobs 15s · followups 60s)");
}

// (re-exports de tipos vendrán en la integración admin.ts si hacen falta)
