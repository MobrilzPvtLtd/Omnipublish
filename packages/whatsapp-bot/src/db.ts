/**
 * Capa de datos. Con DATABASE_URL usa Postgres (Railway). Sin él, usa un
 * almacén en memoria (solo dev: NO persiste entre reinicios) y avisa.
 *
 * Tablas: app_settings, app_conversations, app_automations,
 * app_automation_log, app_contacts (CRM), app_sequences (drip),
 * app_sequence_runs (scheduler de secuencias).
 */
import { emailLog } from "./pii-log.js";
import pg from "pg";
import { pgSsl } from "./pg-ssl.js";
import { currentWorkspaceId } from "./workspace.js";
import type { FichaIdentidad } from "./identidad.js";
import { hechosUnaVez } from "./identidad.js";
import type { CampanaDef, EventoCampana, HitosExternos } from "./campanas.js"; // CAMPANAS-1
import type {
  BroadcastFlow,
  BroadcastRun,
  BroadcastRunStatus,
  BroadcastJob,
  BroadcastJobStatus,
  BcChannel,
  BcFlowData,
} from "./broadcast-flows-types.js";
export type {
  BcNode,
  BcEdge,
  BcFlowData,
  BcChannel,
  BcAudienceSpec,
  BroadcastFlow,
  BroadcastRun,
  BroadcastRunStatus,
  BroadcastJob,
  BroadcastJobStatus,
} from "./broadcast-flows-types.js";

const url = process.env.DATABASE_URL;
export const hasDb = !!url;

const pool = url
  ? new pg.Pool({
      connectionString: url,
      ssl: pgSsl(),
      max: 5,
    })
  : null;
// POOL-ERROR-1 · un cliente ocioso que pierde la conexión (reinicio de Postgres en Railway)
// emite 'error' en el Pool; sin oyente llega como excepción no capturada y sin contexto.
// pg ya descarta ese cliente por su cuenta: aquí solo se deja constancia.
pool?.on("error", (e) => console.error("[db] pool: cliente ocioso caído:", (e as Error)?.message || e));

/**
 * REG-1: helper para abrir un PoolClient dedicado a un trabajo transaccional
 * (BEGIN/COMMIT). Lo usa tickBroadcastJobs para mantener vivo el lock
 * SELECT FOR UPDATE SKIP LOCKED durante todo el procesamiento del lote
 * (sin esto la otra réplica podría re-coger los mismos jobs entre el
 * autocommit y dbMarkJobSent). Devuelve null si no hay pool (mem mode).
 *
 * Caller obligado a release() del cliente al terminar — typicamente en
 * un try/finally con ROLLBACK on error.
 */
export async function dbGetClient(): Promise<pg.PoolClient | null> {
  if (!pool) return null;
  return pool.connect();
}

/**
 * logs-cola FASE-1: una entrada del log unificado de actividad cross-sistema
 * (app_activity_log). Cada origen (autopost, broadcast, scheduled-post, etc.)
 * escribe aquí con summary humano + payload técnico opcional. Lo consumen los
 * dashboards/badges del panel (centro de actividad).
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

export type ActivityLevel = "info" | "warn" | "error";

export interface ActivityRow {
  id: string;
  tenant_id: string;
  source: ActivitySource;
  level: ActivityLevel;
  status: string | null;
  summary: string;
  payload: Record<string, unknown> | null;
  created_at: number; // epoch ms
}

// NOTIFICACIONES-1 · una notificación de negocio (ver app_notifications en initDb).
export interface NotificationRow {
  id: number;
  tenant_id: string;
  kind: string;
  title: string;
  body: string;
  phone: string | null;
  channel: string | null;
  link: string | null;
  dedup_key: string | null;
  payload: Record<string, unknown> | null;
  created_at: number; // epoch ms
  read?: boolean; // calculado por persona al listar
}

// ---- Fallback en memoria (solo dev sin Postgres) ----
// settings: clave compuesta `${tenant_id}|${key}` para soportar multi-tenant
// (cada workspace tiene su propio scope de settings) sin perder retro-compat
// con los helpers legacy (que asumen tenant='default').
const mem = {
  settings: new Map<string, { value: string; is_secret: boolean; tenant_id: string }>(),
  conversations: new Map<string, { user_id: string; tenant_id: string; bot_id: string; turns: unknown[]; accts: Record<string, ConvAcctSummary>; updated_at: number }>(),
  automations: new Map<string, Record<string, unknown>>(),
  log: new Set<string>(),
  contacts: new Map<string, Contact>(),
  sequences: new Map<string, Record<string, unknown>>(),
  runs: new Map<string, SequenceRun>(),
  flows: new Map<string, Record<string, unknown>>(),
  flowRuns: new Map<string, FlowRun>(), // key `${phone}:${flowId}`
  modoEvents: [] as Array<{ tenant_id: string; phone: string; modo: string; at: number }>, // BAN-04-FIN (ring, cap 5000)
  flowEvents: [] as Array<{ tenant_id: string; flow_id: string; phone: string; event: string; node_id: string; detail: string; at: number }>, // FLOW-LOGS (ring, cap 5000)
  // SIO-LEADS-TENANT-1 · el workspace va DELANTE en la clave (antes `${accountId}:${sioContactId}`).
  sioLeads: new Map<string, SioLead>(), // key `${tenantId}:${accountId}:${sioContactId}`
  sioBookings: new Map<string, SioBooking>(), // key `${accountId}:${bookingId}`
  drip: new Map<string, { tenant_id: string; comment_id: string; media_id: string; ig_id: string; author: string; status: string; error?: string }>(), // key `${tenant}:${commentId}`
  scheduledPosts: new Map<string, ScheduledPost>(),
  // NEWSLETTER-1 · boletines en modo memoria (arneses y arranque sin base).
  newsletters: new Map<string, NewsletterRec>(),
  // NEWSLETTER-RUTINA-1 · los encargos que generan esos boletines.
  newsletterRoutines: new Map<string, NewsletterRoutineRec>(),
  leadJobs: new Map<string, LeadJob>(),
  autopostHistory: [] as AutopostHistory[],
  broadcasts: [] as BroadcastRec[],
  // DIFUSION-DETALLE-1 · impacto por destinatario de cada difusión/lote (modo memoria)
  broadcastHits: new Map<string, BroadcastHit[]>(),
  // PLANTILLA-CABECERA-1 · medios de flujo/plantilla en modo memoria: sin esto, los
  // arneses no podían recorrer ninguna cadena que pase por flow-media.
  // BANDEJA-FIX-1 · el tenant viaja con la fila también en memoria: dbGetInboxMedia
  // ahora sirve desde aquí y sin él un arnés multi-negocio leería adjuntos ajenos.
  inboxMedia: new Map<string, InboxMedia & { source: string; tenant: string }>(),
  hooks: [] as Hook[],
  trends: [] as Trend[],
  workspaces: new Map<string, Workspace>(),
  workspaceMembers: [] as WorkspaceMember[],
  businessGroups: new Map<string, BusinessGroup>(),
  // logs-cola FASE-1: log de actividad cross-sistema. Tope blando (sin DB
  // realmente no rota — el setInterval también está apagado sin pool).
  activity: [] as ActivityRow[],
  // NOTIFICACIONES-1 · espejo en memoria de app_notifications / _reads / _seen.
  notifications: [] as NotificationRow[],
  notifSeq: 0,
  notifReads: new Set<string>(), // `${tenant}|${actor}|${id}`
  notifSeen: new Map<string, number>(), // `${tenant}|${actor}` → epoch ms
  // BANDEJA-LEIDOS-1 · espejo en memoria de app_inbox_reads: `${tenant}|${actor}` → {clave → epoch ms}.
  inboxReads: new Map<string, Record<string, number>>(),
  // metricas-pro M3: eventos WA (out/in) para la tab WhatsApp PRO.
  // Tope blando: 5000 filas en dev (sin DB), suficiente para muestreo local.
  waEvents: [] as WaEventRow[],
  // Estado asíncrono real de cada mensaje saliente (wamid). Separado del
  // historial para que un webhook de Meta no tenga que reescribir la conversación.
  waMessageStatuses: new Map<string, WaMessageStatusRow>(),
  // REACCIONES-1: reacción vigente (contacto/agente) por mensaje. Mismo motivo
  // que waMessageStatuses: un webhook tardío no debe reescribir el historial.
  waReactions: new Map<string, WaReactionRow>(),
  // meta-ads-pro A3: Creative Library (image/video/carousel/copy).
  // Tope blando: 2000 filas en dev (sin DB).
  adsCreatives: [] as AdsCreativeRow[],
  // meta-ads-pro A4: A/B testing experiments (clone-campaign + variants).
  // Tope blando: 500 filas en dev (un experimento son 2-4 anuncios; 500
  // experimentos = 1000-2000 ad ids cacheados — sobrado para muestreo local).
  adsExperiments: [] as AdsExperimentRow[],
  // meta-ads-pro A5: alertas configurables sobre KPIs de Meta Ads + log
  // de disparos. Tope blando: 500 alertas + 2000 disparos en dev.
  adsAlerts: [] as AdsAlertRow[],
  adsAlertLog: [] as AdsAlertLogRow[],
  // difusion-flow D1: flows (definicion) + runs (ejecucion) + jobs (cola por
  // destinatario × canal). Tope blando: 500 flows, 2000 runs, 50k jobs en dev.
  // Sin DB no persiste — el scheduler real se monta solo con pool.
  broadcastFlows: [] as BroadcastFlow[],
  broadcastRuns: [] as BroadcastRun[],
  broadcastJobs: [] as BroadcastJob[],
  // T03-CORREOS: eventos de correo (etiqueta puente) con dedupe semántico.
  // key `${tenant}:${accountId}:${dedupeKey}` — el Map ES el índice único.
  emailEvents: new Map<string, EmailEventRow>(),
  // FORMULARIOS-1 · formularios propios, contadores por día y respuestas.
  forms: new Map<string, FormRec>(),
  formDays: new Map<string, FormDayRow>(), // key JSON [tenant, formId, day]
  formResponses: [] as FormResponseRec[],
  // MCP-1 · claves de conexión de IA (id → fila). Solo el hash, nunca la clave.
  mcpKeys: new Map<string, McpKeyRec>(),
};

// MEMORIA-TENANT-1 · Igual que la PK de Postgres: el mismo contacto puede
// pertenecer a varios negocios. JSON evita colisiones entre ids con separadores.
const contactMemKey = (id: string, tenantId = currentWorkspaceId()): string => JSON.stringify([tenantId, id]);

/**
 * Workspace = tenant del stack (un negocio gestionado por el operador).
 * 'default' es el workspace original (single-tenant retro-compatible).
 */
export interface Workspace {
  id: string;
  label: string;
  slug: string;
  brand_color: string;
  logo_url: string;
  timezone: string;
  archived: boolean;
  created_by: string;
  group_id: string; // Business Group dueño (aislamiento raíz). 'default' = grupo principal.
  created_at: number; // epoch ms
  updated_at: number; // epoch ms
  /**
   * WS-LIFECYCLE · epoch ms en que se archivó (= se suspendió). Es el inicio del
   * periodo de retención antes de que la purga sea posible.
   *   number → archivado en esa fecha.
   *   null   → nunca archivado / desarchivado (reloj parado).
   *   undefined → la consulta NO pidió la columna. NO significa "nunca archivado".
   */
  archived_at?: number | null;
}

/** Business Group: contenedor raíz de aislamiento (posee workspaces + usuarios). */
export interface BusinessGroup {
  id: string;
  label: string;
  slug: string;
  brand_color: string;
  archived: boolean;
  created_by: string;
  created_at: number; // epoch ms
  updated_at: number; // epoch ms
}

/** Rol del miembro dentro de un workspace concreto. */
export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

/** Vínculo user ↔ workspace con su role en ese workspace. */
export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: number; // epoch ms
}

/** Hook viral guardado en el Hook Vault, reutilizable en el contenido. */
export interface Hook {
  id: string;
  text: string;
  category: string;
  views: number;
  source: string;
  used_count: number;
  created_at: number;
}

/** Noticia/tema del Radar de Tendencias, etiquetada por potencial de hook. */
export interface Trend {
  id: string;
  title: string;
  url: string;
  source: string;
  category: string;
  hook_potential: "alto" | "medio" | "bajo";
  published_at: number | null;
  fetched_at: number;
}

/** Una difusión (enviada o programada): historial + métricas + payload para envío diferido. */
export interface BroadcastRec {
  id: string;
  created_at: number;
  text: string;
  segment: { tags?: string[]; stage?: string; source?: string };
  buttons: string[];
  recipients: number; // a cuántos se envió de verdad (dentro de ventana 24 h)
  sent: number;
  failed: number;
  out_window: number; // del segmento, cuántos quedaron fuera de 24 h
  image_url?: string; // imagen opcional adjunta
  scheduled_at?: number | null; // si es programada, cuándo se debe enviar (ms)
  status?: string; // sent | scheduled | sending | error | canceled | blocked
  // Multi-tenant W8: workspace dueño de la difusión. Default 'default'.
  tenant_id?: string;
  /** T02 · phone_number_id del número emisor ELEGIDO. '' = fila anterior a la
   *  feature (comportamiento legado: número principal del workspace). */
  sender_pid?: string;
  /** T02 · si status='blocked': por qué no se envió (emisor desconectado…). */
  block_reason?: string;
  /** RITMO-DIFUSION-1 · segundos entre contactos elegidos por el dueño (10..21600).
   *  0 = ritmo estándar anti rate-limit del motor. Persistido para que una difusión
   *  programada respete el ritmo el día que salga. */
  pace_seconds?: number;
  /** DIFUSION-MARCA-1 · marca de agua: todo lo que hace falta para RETOMAR el envío donde
   *  estaba si el proceso se reinicia a mitad (Railway redespliega, un crash…). Antes la
   *  lista de destinatarios y el cursor vivían solo en memoria: un reinicio dejaba la fila
   *  en 'sending' para siempre y el resto de la gente no recibía nada. Quién ya se tocó
   *  está en app_broadcast_hits. {} en filas anteriores a la mejora (no se retoman). */
  plan?: BroadcastPlan;
  /** DIFUSION-MARCA-1 · último latido del bucle de envío (ms). Un 'sending' con latido
   *  viejo es una difusión huérfana de un proceso que murió: el scheduler la retoma. */
  heartbeat_at?: number | null;
  /** DIFUSION-MARCA-1 · veces que se retomó tras un reinicio (el panel lo dice). */
  resumed?: number;
  /** DIFUSION-RECORTE-1 · el segmento llenó la página de 2000 al lanzarla: se envió a
   *  los 2000 más recientes y el resto se quedó fuera. Antes esto solo se avisaba en la
   *  previsualización y se perdía al enviar, así que la ficha de resultados decía
   *  «enviada a 2000» sin que nadie supiera que faltaban miles. */
  seg_truncated?: boolean;
  /** DIFUSION-RECORTE-1 · cuántos contactos cumplían el filtro DE VERDAD (sin el corte).
   *  0 en filas anteriores a la mejora. */
  seg_total?: number;
}

/** CSV-CAMPOS-1 · un destinatario de un lote, con lo que su fila del listado traía. Sin ningún
 *  campo opcional es exactamente lo que había antes: teléfono y nombre. */
export interface LoteObjetivo {
  phone: string;
  name: string;
  /** Correo de la ficha (se guarda al enviarle). */
  email?: string;
  /** Etiquetas propias de ESA persona (además de las del lote entero). */
  tags?: string[];
  /** Datos sueltos del listado tal como venían («SCORE», «Clics», «Días sin abrir»…). */
  fields?: Record<string, string>;
  /** Nota que se añade a su ficha (el «ángulo», observaciones…). */
  notes?: string;
}

/** DIFUSION-MARCA-1 · lo que el motor necesita para ejecutar (o retomar) una difusión sin
 *  depender de nada que viviera en la petición HTTP que la lanzó. */
export interface BroadcastPlan {
  /** libre = texto/imagen/botones al segmento · plantilla = plantilla al segmento ·
   *  lote = plantilla a teléfonos sueltos (Nueva conversación → Varios). */
  kind?: "libre" | "plantilla" | "lote";
  /** Lista COMPLETA de destinatarios resuelta al lanzarla (en 'libre' programada, al empezar).
   *  CSV-CAMPOS-1 · en un lote, cada destinatario puede traer lo que venía en el listado
   *  (correo, etiquetas propias, notas y datos sueltos como puntuación o clics). */
  targets?: LoteObjetivo[];
  /** Plantilla tal cual se resolvió al lanzar (el catálogo puede cambiar después). */
  tpl?: { name: string; language: string; hasVar?: boolean; body?: string; buttons?: { t: string; u?: string }[] };
  /** Variables del cuerpo ({{nombre}} se sustituye por destinatario). */
  params?: string[];
  /** LOTE-ETIQUETAS-1 · etiquetas que se añaden a cada destinatario del lote. */
  tags?: string[];
  /** «Guardar como contactos» del lote. */
  save?: boolean;
  /** Teléfonos descartados al validar el lote (solo para el resumen de Actividad). */
  omitidos?: number;
}

export interface AutopostHistory {
  id?: string;
  ts: number;
  idea: string;
  cta_keyword: string;
  caption: string;
  platforms: string[];
  status: { platform: string; ok: boolean; message: string }[];
  // Multi-tenant W8: workspace dueño del item. Default 'default' (regresión zero).
  tenant_id?: string;
}

export interface Lead {
  name: string | null;
  website: string | null;
  emails: string[];
  phone: string | null;
  address: string | null;
  socials: Record<string, string>;
}

export interface LeadJob {
  id: string;
  niche: string;
  city: string;
  status: "queued" | "discovering" | "scraping" | "done" | "error";
  area: string;
  total: number;
  scraped: number;
  with_email: number;
  results: Lead[];
  error: string;
  created_at: number;
  // Multi-tenant W8: workspace dueño del job. Default 'default' (regresión zero).
  tenant_id?: string;
}

export interface ScheduledPost {
  id: string;
  ig_id: string; // cuenta IG destino (multi-cuenta) — usado si platforms incluye "instagram"
  kind: "image" | "reel" | "video" | "carousel" | "story"; // HISTORIAS-1 · story: Instagram y Facebook
  media_url: string; // URL principal (o JSON con varias para carousel)
  caption: string;
  scheduled_at: number; // epoch ms
  status: "pending" | "sending" | "published" | "error" | "partial" | "draft";
  result: string; // id de la publicación o mensaje de error (o JSON con resultado por plataforma)
  // Multi-plataforma (Metricool-style): por defecto ["instagram"] si vacío.
  platforms: string[];
  // Etiquetado (Niveles 1+2): mentions + hashtags se concatenan al caption;
  // igCollab pasa como collaborators[] en la Graph API de IG (Reels y Feed).
  tags: {
    mentions?: string[];      // ["@otracuenta"] o ["otracuenta"]; normalizamos antes de pegar
    hashtags?: string[];      // ["#palabra"] o ["palabra"]
    igCollab?: string;        // 1 username sin @
    // Nivel 3 (UI pendiente): tags clickables sobre foto IG.
    igUserTags?: { username: string; x: number; y: number }[];
    // PORTADA-1 · portada de Reels / vídeos / TikTok: imagen propia (URL pública) o, sin ella,
    // el fotograma del segundo coverOffsetMs. YouTube solo la usa en vídeos normales (no Shorts).
    cover?: string;
    /** MINIATURA-CONGELADA-1 · miniatura (data: URI, ~160 px) sacada AL PUBLICAR. El calendario la pinta
     *  aunque el archivo original se borre o caduque. No se edita a mano. */
    thumb?: string;
    coverOffsetMs?: number;
    // YT-PRIMER-COMENTARIO-1 · YouTube: primer comentario que Zernio publica y FIJA al publicar
    // el vídeo (máx. 10.000 caracteres). Aquí va el enlace de la landing.
    ytFirstComment?: string;
    // COMENTARIO-FIJADO-1 · primer comentario por red: youtube, linkedin, linkedin_pagina, facebook, instagram.
    firstComments?: Record<string, string>;
    // TEXTO-POR-RED-1 · texto propio de una red; la que no tiene usa el caption general.
    captions?: Record<string, string>;
    // HILO-X-2 · X con más de 4 imágenes sale como hilo: texto propio de cada tuit a partir
    // del 2.º (el 1.º lleva el caption). Faltan o sobran → el publicador pone uno por defecto.
    xHilo?: string[];
    // SHORT-DURACION-MUSICA-1 · Foto o Carrusel hacia YouTube (se publica como Short):
    // duración total del vídeo en segundos y música de fondo (/a/<id> del panel o URL https).
    shortSecs?: number;
    shortMusic?: string;
    shortMusicName?: string; // nombre del archivo, para enseñarlo al editar
    // YOUTUBE-NORMAL-1 · formato en YouTube: ausente = Short vertical; «normal» = vídeo 16:9 de
    // YouTube; «ambos» = los dos (el Short y el vídeo normal, dos envíos).
    ytFormato?: "normal" | "ambos";
    // REEL-PRUEBA-1 · Foto o Carrusel → en Instagram sale como Reel (el mismo vídeo que el Short:
    // shortSecs/shortMusic). igTrial: el Reel sale como reel de prueba (solo no seguidores).
    igComoReel?: boolean;
    igTrial?: "MANUAL" | "SS_PERFORMANCE";
    // REEL-PRUEBA-2 · veces que el scheduler lo ha aplazado por el tope de reels de prueba de Meta (lo escribe SOLO el servidor).
    igTrialAplazos?: number;
    // FLUJO-AL-PUBLICAR-1 · ids de flujos (yt_comment / ig_comment) que se ASIGNAN a esta publicación
    // y se ENCIENDEN solos cuando sale: el sistema busca su vídeo/post publicado y lo pone en el
    // disparador (mediaId). flujosListos lo escribe SOLO el servidor (nunca viene del formulario).
    flujos?: string[];
    flujosListos?: Record<string, unknown>;
  };
  // Multi-cuenta Upload-Post: id de la cuenta UP a usar para publicar este post.
  // Si vacío/null → primera cuenta disponible (compat).
  uploadPostAccountId?: string;
  // Multi-tenant W8: workspace dueño del post. Default 'default' (regresión zero).
  tenant_id?: string;
}

/**
 * NEWSLETTER-1 · Un boletín de correo. Esta fila es el BORRADOR y la memoria;
 * el envío lo hace la web conectada, y `sio_id` es el hilo entre las dos.
 *
 * `include_tags` / `exclude_tags` guardan el NOMBRE de la etiqueta, no su id
 * numérico de la web, a propósito: los ids son de una cuenta concreta, así que
 * un borrador escrito para una cuenta quedaría apuntando a etiquetas ajenas si
 * se cambia de cuenta antes de enviar. El id se resuelve por nombre en el envío
 * (ensureTagId), que es exactamente lo que ya hace el resto del panel.
 */
export interface NewsletterRec {
  id: string;
  tenant_id?: string;
  account_id: string;      // cuenta web (systeme.io / leadmatch-lab) que envía
  sio_id: number;          // id del boletín EN LA WEB; 0 = aún no existe allí
  subject: string;
  preview_text: string;
  body_html: string;
  sender_name: string;
  sender_email: string;
  prompt: string;          // la instrucción con la que la IA lo redactó
  include_tags: string[];  // nombres de etiqueta de la web: a quién SÍ
  exclude_tags: string[];  // nombres de etiqueta de la web: a quién NO
  contacts: string[];      // correos sueltos elegidos a mano (van por etiqueta puente)
  bridge_tag: string;      // la etiqueta puente creada para esos correos sueltos
  status: "draft" | "scheduled" | "sending" | "sent" | "error" | "cancelled";
  scheduled_at: number | null; // epoch ms; null = sin programar
  sent_at: number | null;      // epoch ms
  recipients: number;      // destinatarios estimados al enviar
  result: string;          // motivo del error, o resumen de lo que pasó
  routine_id: string;      // NEWSLETTER-RUTINA-1 · rutina que lo generó; '' = suelto
  mailing_id: number;      // id en la lista de estadísticas de la web; 0 = sin resolver
  created_by: string;
  created_at: number;
  updated_at: number;
}

/**
 * NEWSLETTER-RUTINA-1 · un encargo de correo que se ejecuta solo.
 *
 * No contiene un correo escrito: contiene `prompt`, la instrucción con la que
 * la IA redacta uno DISTINTO en cada ejecución. Por eso una rutina no se
 * «envía» —se activa y se pausa, como un flujo— y cada ejecución deja su
 * propia fila en app_newsletters con el texto que salió ese día.
 *
 * La hora se guarda partida (at_hour/at_min + tz) y no como epoch: un epoch
 * fijo se desfasa una hora al cambiar el horario de verano, y «todos los
 * martes a las 9:00» tiene que seguir siendo a las 9:00 en marzo y en agosto.
 */
export interface NewsletterRoutineRec {
  id: string;
  tenant_id?: string;
  account_id: string;      // cuenta web que envía
  name: string;            // cómo la llama el cliente en el listado
  prompt: string;          // el encargo a la IA, lo único que de verdad define la rutina
  sender_name: string;
  sender_email: string;
  include_tags: string[];
  exclude_tags: string[];
  contacts: string[];      // correos sueltos añadidos a mano
  freq: "daily" | "weekly" | "monthly";
  weekdays: number[];      // 0=domingo … 6=sábado. Sólo cuenta si freq='weekly'
  monthday: number;        // 1..28. Sólo si freq='monthly' (28 para que exista en febrero)
  at_hour: number;         // 0..23, en la zona tz
  at_min: number;          // 0..59
  tz: string;              // zona IANA del negocio
  ai_model: string;        // IA-POTENCIA-1 · modelo que redacta; '' = el del panel
  signature: { despedida: string; cargo: string; web: string }; // FIRMA-2 · la firma la monta el código
  active: boolean;         // en pausa = false; no se borra, se apaga
  next_run_at: number | null; // epoch ms ya calculado; null = no tiene próxima
  last_run_at: number | null;
  runs: number;            // cuántas veces se ha ejecutado
  last_result: string;     // qué pasó la última vez, en cristiano
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface FlowRun {
  phone: string;
  flow_id: string;
  node_id: string;
  vars: Record<string, string>;
  status: "active" | "waiting" | "done" | "cancelled";
  next_run: number; // epoch ms (para delays)
  /** DOBLE-ARRANQUE-1 · cuándo se tocó por última vez (epoch ms). La columna existía desde
   *  siempre; ahora también viaja en el objeto, porque la reserva de entrada la consulta. */
  updated_at?: number;
  // Multi-tenant W8: workspace dueño del run. Default 'default'.
  tenant_id?: string;
}

export interface FlowStats {
  contacts: number; // contactos únicos que entraron al flujo
  active: number;
  waiting: number;
  done: number;
  cancelled: number;
  clicks: number; // clics en enlaces enviados por este flujo (link tracker)
  daily: { d: string; c: number }[]; // actividad últimos 7 días
}

export interface Contact {
  phone: string;
  name: string;
  email: string;
  tags: string[];
  fields: Record<string, string>;
  bot_id: string;
  stage: string; // etapa del pipeline
  human: boolean; // true = handoff humano (bot en silencio)
  owner: string; // closer dueño del lead: '' = pool sin asignar | 'env-admin' | 'u:<id>'
  channel_account: string; // en qué número/cuenta entró: 'wa:<phoneNumberId>' | 'ig:<igId>' | ''
  source: string; // 'panel' | 'whatsapp' | 'instagram' | 'leadfinder' | 'systemeio' | 'import' | ...
  avatar_url: string; // foto de perfil (IG: profile_pic vía Graph; WhatsApp no expone)
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  notes: string; // últimas anotaciones, las históricas viven en app_contact_notes
  next_action_at: number | null; // epoch ms o null
  next_action_label: string;
  next_action_account: string; // id de la cuenta web (Conexiones) asociada a la reunión manual, o ''
  next_action_by: string; // quién la apuntó: '' (histórico) | 'panel' | 'flujo:<nombre>'
  /** Estado REAL del envío del contacto a la web de la reunión. '' = no pedido;
   *  'pending' (encolado) | 'processing' | 'synced' | 'failed' | 'needs_config'
   *  (credencial inválida/falta API key) | 'disconnected' (esa web ya no está
   *  entre las Conexiones del workspace). Lo escribe el worker MCP al terminar. */
  next_action_sync_status: string;
  /** Detalle humano del último fallo de esa sincronización, o ''. */
  next_action_sync_error: string;
  score: number; // lead score 0-100
  systemeio_contact_id: string;
  /** Id de la cuenta de systeme.io/leadmatch-lab donde vive (systemeio.accounts). */
  systemeio_account: string;
  last_inbound: number; // epoch ms
  /** CHAT-POR-NUMERO-1 · última entrada POR NÚMERO ('wa:<pid>' → epoch ms): la ventana
   *  de 24 h de Meta es por par (número, cliente), no por contacto. */
  last_inbound_by: Record<string, number>;
  created_at: number;
  updated_at: number;
  tenant_id?: string; // workspace al que pertenece el contacto (multi-tenant)
}

/** Plantilla con todos los campos por defecto. Úsalo cada vez que crees un Contact en memoria. */
export function defaultContact(phone: string, name = "", botId = ""): Contact {
  const t = Date.now();
  return {
    phone, name, email: "",
    tags: [], fields: {},
    bot_id: botId, stage: "", human: false, owner: "", channel_account: "",
    source: "", avatar_url: "", utm_source: "", utm_medium: "", utm_campaign: "", utm_content: "",
    notes: "", next_action_at: null, next_action_label: "", next_action_account: "", next_action_by: "",
    next_action_sync_status: "", next_action_sync_error: "",
    score: 0, systemeio_contact_id: "", systemeio_account: "",
    last_inbound: t, last_inbound_by: {}, created_at: t, updated_at: t,
  };
}
export interface SequenceRun {
  id: string;
  phone: string;
  sequence_id: string;
  step: number;
  next_run: number; // epoch ms
  status: "active" | "done" | "cancelled";
  // Multi-tenant W8: workspace dueño del run. Default 'default'.
  tenant_id?: string;
}

// ============================================================
// meta-ads-pro A3 — Creative Library types.
//
// `app_ads_creatives` guarda los assets de creatividad publicitaria (imagen,
// video, carousel, copy). El alta empieza en status='draft' con `url` apuntando
// al storage local del servicio (Railway disk + /uploads o S3 si esta
// configurado); el `meta_id` se rellena al ejecutar syncCreativeToMeta y la
// fila pasa a status='synced' (o 'failed' con error en payload). El estado
// 'syncing' es intermedio para que la UI muestre spinner.
//
// Multi-tenant: tenant_id NOT NULL DEFAULT 'default' — todas las queries
// filtran por tenant_id ANTES de exponer la row al panel.
// ============================================================

export type AdsCreativeType = "image" | "video" | "carousel" | "copy";
export type AdsCreativeStatus = "draft" | "syncing" | "synced" | "failed";

export interface AdsCreativeRow {
  id: string;
  tenant_id: string;
  ad_account_id: string | null;
  /** Hash (image) o video_id de Meta tras sync; null mientras draft/failed. */
  meta_id: string | null;
  type: AdsCreativeType;
  name: string;
  /** URL en storage propio (Railway/CDN/S3); null para type='copy'. */
  url: string | null;
  thumb_url: string | null;
  /**
   * Copy del creative — objeto plano { headline?, body?, description?,
   * cta_text?, link? } serializado a JSON en BD. NULL si no aplica.
   */
  body: Record<string, unknown> | null;
  status: AdsCreativeStatus;
  /** Mensaje de error de Meta cuando status='failed'. */
  error: string | null;
  created_at: number; // epoch ms
  updated_at: number; // epoch ms
}

// ============================================================
// meta-ads-pro A4 — A/B testing experiments.
//
// `app_ads_experiments` modela un test A/B/n a nivel de creative usando una
// receta KISS: en vez de la Experiments API oficial de Meta (que no es
// soportada en todas las cuentas + requiere structured tests), clonamos un
// adset y creamos N variants Ad con creativos distintos dentro de la misma
// campaña base. KPI insights se piden ad por ad y se comparan side-by-side.
//
// Convencion:
//   - `variants` JSONB array: [{ ad_id, label, creative_id? }]. La primera
//     entrada SIEMPRE es la "control" (el control suele ser la creative que
//     ya tenia el adset base). El resto son alternativas (B, C, D).
//   - `winner_ad_id` se rellena cuando el operador declara ganador desde la
//     UI (pausa el resto y deja solo este ad activo).
//   - `status`: running (test corriendo), completed (ganador declarado o
//     terminado), failed (clonado no completo, error en Graph).
//
// Multi-tenant: tenant_id NOT NULL DEFAULT 'default' (en todas las queries).
// ============================================================

export type AdsExperimentStatus = "running" | "completed" | "failed";

export interface AdsExperimentVariant {
  /** Id del Ad de Meta clonado para esta variant. */
  ad_id: string;
  /** Label legible: "A · control", "B", "C", etc. */
  label: string;
  /** Id del adcreative en Meta (opcional — para variants creadas en bulk). */
  creative_id?: string;
  /** Id del adset al que pertenece este ad (puede ser el base o uno clonado). */
  adset_id?: string;
}

export interface AdsExperimentRow {
  id: string;
  tenant_id: string;
  ad_account_id: string;
  name: string;
  /** Campaign id base (los variants viven dentro de esta campaign clonada). */
  base_campaign_id: string;
  variants: AdsExperimentVariant[];
  started_at: number; // epoch ms
  ended_at: number | null; // epoch ms — null mientras running
  winner_ad_id: string | null;
  status: AdsExperimentStatus;
  error: string | null;
  created_at: number; // epoch ms
  updated_at: number; // epoch ms
}

// ============================================================
// meta-ads-pro A5 — Alertas configurables sobre KPIs Meta Ads.
//
// `app_ads_alerts` describe la regla: cuando la métrica X (cpc/ctr/
// conversions/spend/reach) del scope Y (account/campaign/adset/ad) cruza
// el threshold con el operador Z (>/</=...), dispara la alerta por
// `channel` (panel/whatsapp/email). El worker `evaluateAllAlerts` (cada
// 15min en scheduler) consulta insights de Meta con cache 5min, dispara
// `dbInsertAlertLog` + `logActivity` cuando se cumple la condicion.
//
// `app_ads_alert_log` es el historico de disparos — la UI muestra "ult.
// disparo" y un drilldown a la metrica concreta que disparo cada vez.
//
// Multi-tenant: tenant_id NOT NULL DEFAULT 'default' (en todas las
// queries). Ownership cruzado: cada alert tiene ad_account_id que el
// caller debe validar contra adAccountBelongsToWorkspace ANTES de
// insertar/leer.
// ============================================================

export type AdsAlertMetric =
  | "cpc"
  | "ctr"
  | "conversions"
  | "spend"
  | "reach";

export type AdsAlertOperator = ">" | "<" | "=" | ">=" | "<=";

export type AdsAlertScope = "campaign" | "adset" | "ad" | "account";

export type AdsAlertChannel = "panel" | "whatsapp" | "email";

export interface AdsAlertRow {
  id: string;
  tenant_id: string;
  ad_account_id: string;
  name: string;
  metric: AdsAlertMetric;
  operator: AdsAlertOperator;
  threshold: number;
  scope: AdsAlertScope;
  /** id de la entidad scoped (campaign/adset/ad). null si scope='account'. */
  scope_id: string | null;
  channel: AdsAlertChannel;
  enabled: boolean;
  last_fired_at: number | null; // epoch ms — null si nunca dispara
  created_at: number; // epoch ms
  updated_at: number; // epoch ms
}

export type AdsAlertLogStatus = "fired" | "snoozed" | "dismissed";

export interface AdsAlertLogRow {
  id: string;
  tenant_id: string;
  alert_id: string;
  /** Valor real de la metrica que cumplio la condicion (para drilldown). */
  value: number;
  fired_at: number; // epoch ms
  status: AdsAlertLogStatus;
}

export async function initDb(): Promise<void> {
  if (!pool) {
    console.warn("[db] DATABASE_URL no definida — almacén en memoria (no persiste).");
    seedDefaultBusinessGroupInMem();
    seedDefaultWorkspaceInMem();
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      is_secret BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE TABLE IF NOT EXISTS app_conversations (
      user_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL,
      turns JSONB NOT NULL DEFAULT '[]',
      accts JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_conversations_updated ON app_conversations (updated_at DESC);
    -- CHAT-POR-NUMERO-1 · resumen por número emisor/receptor de los turns (clave
    -- 'wa:<pid>' o '' para turnos sin sellar). Lo mantiene dbSaveConversation en cada
    -- escritura; la Bandeja lo usa para partir la lista en un chat por número SIN traer
    -- la columna turns entera (que es justo lo que la variante LIGHT evita por coste).
    ALTER TABLE app_conversations ADD COLUMN IF NOT EXISTS accts JSONB NOT NULL DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS app_automations (
      id TEXT PRIMARY KEY, data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE TABLE IF NOT EXISTS app_automation_log (
      automation_id TEXT NOT NULL, user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (automation_id, user_id) );
    -- DRIP-1 · cola de respuestas a comentarios (goteo). Una fila por comentario a
    -- responder. status: pending -> done | error | skipped. author sirve para no
    -- responder dos veces a la misma persona.
    CREATE TABLE IF NOT EXISTS app_comment_drip (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      comment_id TEXT NOT NULL,
      media_id TEXT NOT NULL DEFAULT '',
      ig_id TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, comment_id) );
    CREATE INDEX IF NOT EXISTS idx_drip_status ON app_comment_drip (tenant_id, status);
    CREATE TABLE IF NOT EXISTS app_fb_entradas (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      comment_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, comment_id) );
    CREATE INDEX IF NOT EXISTS idx_fb_entradas_page ON app_fb_entradas (tenant_id, page_id);
    CREATE TABLE IF NOT EXISTS app_contacts (
      phone TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      tags JSONB NOT NULL DEFAULT '[]',
      fields JSONB NOT NULL DEFAULT '{}',
      bot_id TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL DEFAULT '',
      human BOOLEAN NOT NULL DEFAULT false,
      last_inbound TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_inbound_by JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS human BOOLEAN NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS app_sequences (
      id TEXT PRIMARY KEY, data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE TABLE IF NOT EXISTS app_sequence_runs (
      id TEXT PRIMARY KEY, phone TEXT NOT NULL, sequence_id TEXT NOT NULL,
      step INT NOT NULL DEFAULT 0,
      next_run TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'active' );
    CREATE INDEX IF NOT EXISTS idx_runs_due ON app_sequence_runs (status, next_run);
    CREATE TABLE IF NOT EXISTS app_flows (
      id TEXT PRIMARY KEY, data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE TABLE IF NOT EXISTS app_flow_runs (
      phone TEXT NOT NULL, flow_id TEXT NOT NULL,
      node_id TEXT NOT NULL DEFAULT '',
      vars JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      next_run TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (phone, flow_id) );
    CREATE INDEX IF NOT EXISTS idx_flowruns_due ON app_flow_runs (status, next_run);
    CREATE TABLE IF NOT EXISTS app_scheduled_posts (
      id TEXT PRIMARY KEY, ig_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'image', media_url TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'pending', result TEXT NOT NULL DEFAULT '',
      platforms JSONB NOT NULL DEFAULT '["instagram"]'::jsonb,
      tags JSONB NOT NULL DEFAULT '{}'::jsonb );
    CREATE INDEX IF NOT EXISTS idx_sched_due ON app_scheduled_posts (status, scheduled_at);
    ALTER TABLE app_scheduled_posts ADD COLUMN IF NOT EXISTS platforms JSONB NOT NULL DEFAULT '["instagram"]'::jsonb;
    ALTER TABLE app_scheduled_posts ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE app_scheduled_posts ADD COLUMN IF NOT EXISTS up_account_id TEXT NOT NULL DEFAULT '';
    -- ============================================================
    -- NEWSLETTER-1 · Boletines de correo. La fila de aquí es el BORRADOR y la
    -- memoria (quién lo escribió, con qué instrucción para la IA, a qué
    -- etiquetas va, cuándo se programó); el envío lo hace la web conectada
    -- (systeme.io / leadmatch-lab) por su API oficial, y sio_id es el hilo
    -- que une las dos. Se guarda aquí y no solo allí porque la web no tiene
    -- sitio para el prompt, ni para los contactos sueltos elegidos, ni sabe de
    -- workspaces: sin esta tabla, un boletín a medias se perdería al recargar.
    --
    -- Estados: draft → scheduled → sent, y las dos salidas de emergencia
    -- (error, cancelled). 'sending' es el claim atómico del latido, igual que
    -- en app_scheduled_posts: existe para que dos réplicas no envíen dos veces.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_newsletters (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      account_id TEXT NOT NULL DEFAULT '',
      sio_id BIGINT NOT NULL DEFAULT 0,
      subject TEXT NOT NULL DEFAULT '',
      preview_text TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      sender_email TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      include_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      exclude_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      contacts JSONB NOT NULL DEFAULT '[]'::jsonb,
      bridge_tag TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      scheduled_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      recipients INT NOT NULL DEFAULT 0,
      result TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_newsletters_ws ON app_newsletters (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_newsletters_due ON app_newsletters (status, scheduled_at);
    -- NEWSLETTER-RUTINA-1 · de qué rutina salió este envío ('' = suelto, escrito
    -- a mano) y con qué envío de la web se corresponde para leer sus aperturas.
    -- mailing_id NO es sio_id: el id del boletín en la API oficial y el de la
    -- lista de estadísticas son numeraciones distintas y la relación entre las
    -- dos no está documentada (systemeio-internal-api.ts la resuelve por asunto).
    -- Se guarda resuelto para no repetir esa búsqueda en cada visita a la ficha.
    ALTER TABLE app_newsletters ADD COLUMN IF NOT EXISTS routine_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_newsletters ADD COLUMN IF NOT EXISTS mailing_id BIGINT NOT NULL DEFAULT 0;
    -- El índice va aquí, DESPUÉS del ALTER que crea la columna. Al revés
    -- arranca bien en local (tabla nueva, con la columna ya en el CREATE) y
    -- revienta en producción, donde la tabla existe desde antes.
    CREATE INDEX IF NOT EXISTS idx_newsletters_rut ON app_newsletters (tenant_id, routine_id, created_at DESC);
    -- NEWSLETTER-RUTINA-1 · el encargo permanente. No guarda un correo: guarda
    -- la INSTRUCCIÓN con la que la IA escribe uno distinto en cada ejecución, a
    -- quién va y cada cuánto. Es el equivalente por correo de un flujo: se deja
    -- corriendo y se pausa, no se «envía».
    CREATE TABLE IF NOT EXISTS app_newsletter_routines (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      account_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      sender_email TEXT NOT NULL DEFAULT '',
      include_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      exclude_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      contacts JSONB NOT NULL DEFAULT '[]'::jsonb,
      freq TEXT NOT NULL DEFAULT 'weekly',
      weekdays JSONB NOT NULL DEFAULT '[]'::jsonb,
      monthday INT NOT NULL DEFAULT 1,
      at_hour INT NOT NULL DEFAULT 9,
      at_min INT NOT NULL DEFAULT 0,
      tz TEXT NOT NULL DEFAULT 'Europe/Madrid',
      active BOOLEAN NOT NULL DEFAULT false,
      next_run_at TIMESTAMPTZ,
      last_run_at TIMESTAMPTZ,
      runs INT NOT NULL DEFAULT 0,
      last_result TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_nlrut_ws ON app_newsletter_routines (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nlrut_due ON app_newsletter_routines (active, next_run_at);
    ALTER TABLE app_newsletter_routines ADD COLUMN IF NOT EXISTS ai_model TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_newsletter_routines ADD COLUMN IF NOT EXISTS signature JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE TABLE IF NOT EXISTS app_lead_jobs (
      id TEXT PRIMARY KEY, niche TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued', area TEXT NOT NULL DEFAULT '',
      total INT NOT NULL DEFAULT 0, scraped INT NOT NULL DEFAULT 0,
      with_email INT NOT NULL DEFAULT 0, results JSONB NOT NULL DEFAULT '[]',
      error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_leadjobs_created ON app_lead_jobs (created_at DESC);
    CREATE TABLE IF NOT EXISTS app_autopost_history (
      id TEXT PRIMARY KEY, idea TEXT NOT NULL DEFAULT '',
      cta_keyword TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '',
      platforms JSONB NOT NULL DEFAULT '[]', status JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_autopost_created ON app_autopost_history (created_at DESC);
    CREATE TABLE IF NOT EXISTS app_broadcasts (
      id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '',
      segment JSONB NOT NULL DEFAULT '{}', buttons JSONB NOT NULL DEFAULT '[]',
      recipients INT NOT NULL DEFAULT 0, sent INT NOT NULL DEFAULT 0,
      failed INT NOT NULL DEFAULT 0, out_window INT NOT NULL DEFAULT 0,
      image_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'sent',
      scheduled_at TIMESTAMPTZ,
      sender_pid TEXT NOT NULL DEFAULT '',
      block_reason TEXT NOT NULL DEFAULT '',
      pace_seconds INT NOT NULL DEFAULT 0,
      plan JSONB NOT NULL DEFAULT '{}',
      heartbeat_at TIMESTAMPTZ,
      resumed INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_broadcasts_created ON app_broadcasts (created_at DESC);
    -- OJO: el índice (status, scheduled_at) NO va aquí. En una DB preexistente la tabla
    -- app_broadcasts ya existe SIN esas columnas (CREATE TABLE IF NOT EXISTS es no-op),
    -- así que el índice se crea más abajo, DESPUÉS del ALTER ADD COLUMN que las añade.

    -- ============================================================
    -- Multi-tenant preparation (ALTER aditivos, no rompen data).
    -- tenant_id='default' para todo lo preexistente.
    -- ============================================================
    ALTER TABLE app_settings           ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE app_conversations      ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE app_automations        ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE app_automation_log     ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE app_contacts           ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE app_sequences          ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE app_sequence_runs      ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE app_flows              ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    -- Fecha de creación (2026-08-20). A los flujos ya existentes se les da su
    -- última modificación: es la fecha más antigua que se conoce de ellos.
    ALTER TABLE app_flows              ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    UPDATE app_flows SET created_at = updated_at WHERE created_at > updated_at;
    ALTER TABLE app_flow_runs          ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    -- FLOW-DETAIL: cuándo ENTRÓ cada contacto al flujo (updated_at se pisa en cada paso).
    -- Backfill honesto: para filas viejas, updated_at es la mejor aproximación disponible.
    ALTER TABLE app_flow_runs          ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
    UPDATE app_flow_runs SET created_at=updated_at WHERE created_at IS NULL;
    ALTER TABLE app_flow_runs          ALTER COLUMN created_at SET DEFAULT now();

    -- ============================================================
    -- FLOW-LOGS · Registro de actividad por flujo («Ver Logs»): cada movimiento
    -- REAL de un contacto dentro de una automatización (entró, mensaje, espera,
    -- respondió, condición, etiqueta, aviso, completó, cancelado, salió-por-compra,
    -- error). Append-only; lo escriben los hooks de flows.ts en fire-and-forget
    -- (JAMÁS bloquean ni rompen el motor). La vista Flujos lo consulta como una
    -- base de datos (orden/filtro/paginación con pgTable).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_flow_events (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      flow_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      event TEXT NOT NULL,
      node_id TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_flowevents_flow ON app_flow_events (tenant_id, flow_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_flowevents_phone ON app_flow_events (tenant_id, phone, at DESC);
    -- BAN-04-FIN · cambios de «quién atiende» hechos a mano («Atender yo» on/off). Tabla aparte:
    -- en app_flow_events contaminarían las métricas que agregan por flujo. Por tenant; 90 días.
    CREATE TABLE IF NOT EXISTS app_modo_events (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      phone TEXT NOT NULL,
      modo TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_modoevents_phone ON app_modo_events (tenant_id, phone, at DESC);
    -- CAMPANAS-1 (MET-AUTO-01) · una campaña agrupa flujos SIN fusionarlos (los flujos conservan su
    -- identidad, canal y disparador). Aditivo e idempotente; por tenant; los flujos van en JSONB.
    CREATE TABLE IF NOT EXISTS app_campaigns (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      offer TEXT NOT NULL DEFAULT '',
      objective TEXT NOT NULL DEFAULT 'completar',
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      flow_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, id) );
    ALTER TABLE app_scheduled_posts    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE app_lead_jobs          ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE app_autopost_history   ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE app_broadcasts         ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE app_broadcasts         ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_broadcasts         ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sent';
    ALTER TABLE app_broadcasts         ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
    -- T02 · Número EMISOR elegido para la difusión (phone_number_id de WhatsApp) y
    -- motivo de bloqueo cuando el emisor deja de estar disponible al ejecutarla.
    -- ''=filas anteriores a la feature (salían por el número principal del WS).
    ALTER TABLE app_broadcasts         ADD COLUMN IF NOT EXISTS sender_pid TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_broadcasts         ADD COLUMN IF NOT EXISTS block_reason TEXT NOT NULL DEFAULT '';
    -- RITMO-DIFUSION-1 · segundos entre contactos (0 = ritmo estándar del motor).
    ALTER TABLE app_broadcasts         ADD COLUMN IF NOT EXISTS pace_seconds INT NOT NULL DEFAULT 0;
    -- DIFUSION-MARCA-1 · marca de agua para retomar un envío tras un reinicio: el plan
    -- (destinatarios + plantilla + variables), el latido del bucle y cuántas veces se retomó.
    -- Las filas anteriores quedan con plan '{}' (no se retoman: no hay con qué).
    ALTER TABLE app_broadcasts         ADD COLUMN IF NOT EXISTS plan JSONB NOT NULL DEFAULT '{}';
    ALTER TABLE app_broadcasts         ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
    ALTER TABLE app_broadcasts         ADD COLUMN IF NOT EXISTS resumed INT NOT NULL DEFAULT 0;
    -- DIFUSION-RECORTE-1 · el recorte del segmento a 2000 se queda escrito en la fila:
    -- es lo que le permite a la ficha de resultados decir «se ha enviado a 2000 de N».
    ALTER TABLE app_broadcasts         ADD COLUMN IF NOT EXISTS seg_truncated BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE app_broadcasts         ADD COLUMN IF NOT EXISTS seg_total INT NOT NULL DEFAULT 0;
    -- DIFUSION-DETALLE-1 · impacto por destinatario de cada difusión/lote: quién, cuándo,
    -- resultado y motivo legible. Tabla NUEVA con su índice (columnas propias del CREATE,
    -- no aplica la trampa del índice-tras-ALTER).
    CREATE TABLE IF NOT EXISTS app_broadcast_hits (
      broadcast_id TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      ok BOOLEAN NOT NULL DEFAULT true,
      error TEXT NOT NULL DEFAULT '',
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      tenant_id TEXT NOT NULL DEFAULT 'default' );
    CREATE INDEX IF NOT EXISTS idx_bhits_bc ON app_broadcast_hits (tenant_id, broadcast_id, at);
    -- ENTREGA-WA-1 · id del mensaje que devolvió WhatsApp: enlaza cada envío de la difusión
    -- con la confirmación de entrega/lectura/fallo que llega después por webhook. Sin índice
    -- propio: se cruza contra uq_wa_events_ws_message.
    ALTER TABLE app_broadcast_hits ADD COLUMN IF NOT EXISTS mid TEXT NOT NULL DEFAULT '';
    -- RESULTADO-DIFUSION-1 · qué hizo cada persona después de recibir la difusión. resp_seg
    -- marca los envíos que ya nacen con este seguimiento: en los anteriores «0 respuestas»
    -- sería mentira (no se sabe), y la vista pone «—». Los índices van DESPUÉS de los ALTER.
    ALTER TABLE app_broadcast_hits ADD COLUMN IF NOT EXISTS resp_seg BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE app_broadcast_hits ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
    ALTER TABLE app_broadcast_hits ADD COLUMN IF NOT EXISTS button_at TIMESTAMPTZ;
    ALTER TABLE app_broadcast_hits ADD COLUMN IF NOT EXISTS button_text TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS idx_bhits_phone ON app_broadcast_hits (tenant_id, phone, "at" DESC);
    CREATE INDEX IF NOT EXISTS idx_bhits_mid ON app_broadcast_hits (tenant_id, mid) WHERE mid<>'';
    -- Ahora SÍ: las columnas status/scheduled_at ya existen (recién creadas o por ALTER).
    CREATE INDEX IF NOT EXISTS idx_broadcasts_due ON app_broadcasts (status, scheduled_at);

    -- ============================================================
    -- Contactos: nuevos campos para CRM enterprise.
    -- ============================================================
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS utm_source TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS utm_medium TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS utm_campaign TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS utm_content TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ;
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS next_action_label TEXT NOT NULL DEFAULT '';
    -- Reunión manual: con qué cuenta web se asocia/sincroniza y quién la apuntó
    -- ('panel' | 'flujo:<nombre>'). Vacío en datos históricos = panel.
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS next_action_account TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS next_action_by TEXT NOT NULL DEFAULT '';
    -- Estado REAL del envío del contacto a la web de la reunión ('' | pending |
    -- processing | synced | failed | needs_config | disconnected) + último error.
    -- Lo escribe el worker MCP al terminar el job; la UI solo lo enseña.
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS next_action_sync_status TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS next_action_sync_error TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS score INT NOT NULL DEFAULT 0;
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS channel_account TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS systemeio_contact_id TEXT NOT NULL DEFAULT '';
    -- CUENTA-SIO-1 · En CUÁL de las cuentas de systeme.io/leadmatch-lab vive este
    -- contacto (id de systemeio.accounts). Antes solo se guardaba su id remoto, que
    -- por sí solo no dice de qué cuenta es → no se podía agrupar por cuenta.
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS systemeio_account TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    -- CHAT-POR-NUMERO-1 · última entrada POR NÚMERO ('wa:<pid>' → epoch ms). La ventana
    -- de 24 h de Meta es por par (número, cliente); last_inbound a secas no distingue a
    -- cuál de tus números escribió el cliente y daba por abierta la ventana del otro.
    ALTER TABLE app_contacts ADD COLUMN IF NOT EXISTS last_inbound_by JSONB NOT NULL DEFAULT '{}';
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON app_contacts (email) WHERE email <> '';
    CREATE INDEX IF NOT EXISTS idx_contacts_next_action ON app_contacts (next_action_at) WHERE next_action_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_contacts_score ON app_contacts (score DESC);
    CREATE INDEX IF NOT EXISTS idx_contacts_source ON app_contacts (source);
    CREATE INDEX IF NOT EXISTS idx_contacts_owner ON app_contacts (owner) WHERE owner <> '';

    -- ============================================================
    -- Link tracker: shortlinks /r/{token} + clicks por contacto.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_short_links (
      token TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      url TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      context_kind TEXT NOT NULL DEFAULT '',
      context_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    -- Ocultar un enlace de la lista de "LIVE · Asistencia" sin borrar sus datos
    -- (para que con muchas lives la lista no crezca infinita). Reversible.
    ALTER TABLE app_short_links ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
    -- PAGO-1 · Qué producto vende este enlace. Sin esta columna, dos productos
    -- de la misma web (que comparten base de URL) eran la misma fila para el
    -- deduplicador y el segundo nunca llegaba a generarse.
    ALTER TABLE app_short_links ADD COLUMN IF NOT EXISTS product_id TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS idx_shortlinks_tenant ON app_short_links (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shortlinks_prod ON app_short_links (tenant_id, product_id);
    -- PAGO-1 · Ventas. Antes no existía NINGUNA tabla de ventas: la compra se
    -- marcaba como un campo suelto en el contacto (fields.purchased_at) que
    -- además cortaba en la primera, así que una segunda compra se descartaba en
    -- silencio. Sin esto, «compras», «conversión» e «ingresos» por producto son
    -- literalmente incalculables.
    CREATE TABLE IF NOT EXISTS app_purchases (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      phone TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL DEFAULT '',
      token TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT '',
      amount NUMERIC NOT NULL DEFAULT 0,
      via TEXT NOT NULL DEFAULT '',
      external_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_purch_tenant ON app_purchases (tenant_id, created_at DESC);
    -- Idempotencia: el mismo pago no se cuenta dos veces aunque el webhook
    -- reintente. Con external_id vacío cae al par (teléfono, producto).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_purch_uniq ON app_purchases (tenant_id, phone, product_id, external_id);
    -- METRICAS-1 · lo devuelto de esa compra (NULL = nada). Una devolución completa la saca del
    -- recuento de compras y su importe deja de sumar en ingresos.
    ALTER TABLE app_purchases ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC;
    CREATE TABLE IF NOT EXISTS app_link_clicks (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      token TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      ref TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_clicks_token ON app_link_clicks (token, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_clicks_phone ON app_link_clicks (phone, created_at DESC);

    -- ============================================================
    -- Leads de systeme.io / leadmatch-lab con su URL DE ORIGEN (atribución).
    -- Copia local de los contactos de cada cuenta (API pública, sync incremental
    -- por cursor id): registered_at + source_url + utm_* parseados. Alimenta la
    -- vista Métricas → Origen (sección "Registros en la web").
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_sio_leads (
      account_id TEXT NOT NULL,
      sio_contact_id BIGINT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      email TEXT NOT NULL DEFAULT '',
      registered_at TIMESTAMPTZ,
      source_url TEXT NOT NULL DEFAULT '',
      utm_source TEXT NOT NULL DEFAULT '',
      utm_medium TEXT NOT NULL DEFAULT '',
      utm_campaign TEXT NOT NULL DEFAULT '',
      utm_content TEXT NOT NULL DEFAULT '',
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, sio_contact_id) );
    CREATE INDEX IF NOT EXISTS idx_sio_leads_reg ON app_sio_leads (account_id, registered_at DESC);
    -- SIO-LEADS-TENANT-1 · la PK dejó el workspace FUERA y las tres lecturas filtraban
    -- solo por account_id, que se generaba con 8 hex (systemeio-accounts.ts). Dos
    -- workspaces con el mismo account_id se veían los leads. La PK no se toca (cambiarla
    -- no es aditivo ni idempotente); este índice único, con el workspace DELANTE, es el
    -- que sirve las lecturas ya acotadas por tenant.
    -- El ALTER va DELANTE del índice a propósito: en una base creada antes de que
    -- existiera la columna, el CREATE TABLE IF NOT EXISTS es un no-op y el índice
    -- tumbaría el arranque por columna inexistente — y solo en producción.
    ALTER TABLE app_sio_leads ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sio_leads_ws ON app_sio_leads (tenant_id, account_id, sio_contact_id);
    -- TIEMPO-COMPRA-1 · el primer registro de una persona se busca por su email (después del ALTER de tenant_id).
    CREATE INDEX IF NOT EXISTS idx_sio_leads_email ON app_sio_leads (tenant_id, lower(email));
    -- ORIGEN-VISITA-1 · plataforma de la que llegó un alta SIN utm, deducida de la visita de quien
    -- rellenó el formulario (web-analytics.ts · origenDeVisitaDeUnAlta). '' = aún sin mirar;
    -- 'ninguno' = mirada y sin origen claro (no se vuelve a mirar: sus visitas ya no cambian).
    ALTER TABLE app_sio_leads ADD COLUMN IF NOT EXISTS origen_visita TEXT NOT NULL DEFAULT '';

    -- VENTAS-SIO-1 · ventas de los checkouts de systeme.io (el listado de Ventas de su panel),
    -- con importe, divisa y email del comprador. El email las cruza con la ficha del lead y
    -- así se sabe cuánto ha recaudado cada flujo. kind = 'sale' | 'refund' (la devolución
    -- es una fila aparte y resta). Se copia desde sio-ventas.ts; tabla nueva, sin ALTER.
    CREATE TABLE IF NOT EXISTS app_sio_sales (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      account_id TEXT NOT NULL,
      tx_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'sale',
      email TEXT NOT NULL DEFAULT '',
      amount NUMERIC NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT '',
      product TEXT NOT NULL DEFAULT '',
      paid_at TIMESTAMPTZ,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, account_id, tx_id) );
    CREATE INDEX IF NOT EXISTS idx_sio_sales_email ON app_sio_sales (tenant_id, lower(email));
    CREATE INDEX IF NOT EXISTS idx_sio_sales_paid ON app_sio_sales (tenant_id, paid_at DESC);

    -- FUNNELS-1 · estructura de los funnels de cada web conectada (funnels y sus pasos), copia
    -- local que lee sio-funnels.ts: por la conexión oficial si la cuenta tiene clave, por el
    -- puente si no. active NULL = la fuente no dice si está activo. Tablas nuevas, sin ALTER.
    CREATE TABLE IF NOT EXISTS app_sio_funnels (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      account_id TEXT NOT NULL,
      funnel_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      active BOOLEAN,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, account_id, funnel_id) );
    -- web = dominio del paso (sin www, en minusculas) y path = su ruta normalizada: con eso se
    -- cruza con app_page_views (page_id del sitio de ese dominio + path) y con el source_url de
    -- app_sio_leads. offer_id = oferta que se cobra en el paso ('' si no cobra nada).
    CREATE TABLE IF NOT EXISTS app_sio_funnel_steps (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      account_id TEXT NOT NULL,
      funnel_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '',
      page_id TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      web TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      position INT NOT NULL DEFAULT 0,
      offer_id TEXT NOT NULL DEFAULT '',
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, account_id, step_id) );
    CREATE INDEX IF NOT EXISTS idx_sio_funnel_steps_funnel ON app_sio_funnel_steps (tenant_id, account_id, funnel_id);
    -- En que funnel y en que paso se hizo cada venta. NULL = fila copiada antes de FUNNELS-1, aun
    -- sin mirar; '' = mirada y la venta no trae funnel. offer_id = la oferta cobrada: segunda
    -- clave para dar con el paso cuando la venta no trae el suyo. Los indices, DESPUES del ALTER.
    ALTER TABLE app_sio_sales ADD COLUMN IF NOT EXISTS funnel_id TEXT;
    ALTER TABLE app_sio_sales ADD COLUMN IF NOT EXISTS step_id TEXT;
    ALTER TABLE app_sio_sales ADD COLUMN IF NOT EXISTS offer_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_sio_sales_funnel ON app_sio_sales (tenant_id, account_id, funnel_id);
    CREATE INDEX IF NOT EXISTS idx_sio_sales_step ON app_sio_sales (tenant_id, account_id, step_id);
    -- VENTAS-WEBHOOK-1 (SIO-API-F2/F8) · ventas que avisa systeme.io por webhook (SALE_NEW /
    -- SALE_CANCELED). Tabla SOMBRA: nadie suma de aqui todavia, asi no se cuenta dos veces lo que
    -- ya trae la copia por sesion (app_sio_sales). Sirve para medir la paridad antes del corte.
    -- payload = el aviso entero, para comprobar id, importe y divisa con ventas reales.
    CREATE TABLE IF NOT EXISTS app_sio_webhook_sales (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      account_id TEXT NOT NULL,
      sale_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'sale',
      email TEXT NOT NULL DEFAULT '',
      amount NUMERIC,
      currency TEXT NOT NULL DEFAULT '',
      product TEXT NOT NULL DEFAULT '',
      at TIMESTAMPTZ,
      payload JSONB,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, account_id, sale_id, kind) );
    CREATE INDEX IF NOT EXISTS idx_sio_wh_sales_at ON app_sio_webhook_sales (tenant_id, account_id, received_at DESC);
    -- VENTAS-CORTE-1 (SIO-API-F8) · corte: las ventas las trae el aviso, no el sondeo por sesión.
    -- origen = 'cookie' (copia por sesión, lo anterior al corte) | 'webhook'. Los avisos ya
    -- guardados pasan a app_sio_sales salvo los que la sesión ya copió (mismo email y día UTC).
    ALTER TABLE app_sio_sales ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'cookie';
    ${sqlVentasDesdeAvisos("TRUE")};

    -- ============================================================
    -- Reservas del calendario de booking de cada web conectada. Copia local
    -- vía API pública oficial (/booking-calendar/bookings, sync sio-bookings.ts);
    -- la vista Reuniones las pinta junto a las reuniones de los contactos.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_sio_bookings (
      account_id TEXT NOT NULL,
      booking_id BIGINT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      booked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ,
      event_name TEXT NOT NULL DEFAULT '',
      duration_min INT,
      status TEXT NOT NULL DEFAULT '',
      payment_status TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, booking_id) );
    CREATE INDEX IF NOT EXISTS idx_sio_bookings_at ON app_sio_bookings (tenant_id, booked_at);
    -- RESERVA-WA-3 · la ficha a la que se unió la reserva (la API no trae correo ni teléfono:
    -- se une por la respuesta del formulario). El upsert del sync no la toca.
    ALTER TABLE app_sio_bookings ADD COLUMN IF NOT EXISTS contact_key TEXT NOT NULL DEFAULT '';

    -- ============================================================
    -- Analítica web: visitas de páginas publicadas (píxel propio /pv).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_page_views (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      page_id TEXT NOT NULL DEFAULT '',
      page_label TEXT NOT NULL DEFAULT '',
      ref TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT '',
      visitor TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    -- Columnas GA-grade (añadidas idempotentemente para BDs ya creadas).
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS path TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS browser TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS os TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS nonce TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS duration_ms BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS event TEXT NOT NULL DEFAULT '';
    -- GA-grade v2: atribución de campaña (UTM + click-ids de ads), profundidad de
    -- scroll, velocidad de carga y zona horaria del visitante (para la hora local).
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS utm_source TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS utm_medium TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS utm_campaign TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS utm_term TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS utm_content TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS click_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS scroll_pct SMALLINT NOT NULL DEFAULT 0;
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS load_ms INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS tz_min SMALLINT;
    -- EMBUDO-PAGINAS-1 · contacto (dígitos) al que se atribuye la visita por la marca lmc_ que
    -- /r/ añade a los enlaces de flujo hacia webs con píxel. Vacío = visita anónima (lo normal).
    ALTER TABLE app_page_views ADD COLUMN IF NOT EXISTS contact TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS idx_pageviews_tenant ON app_page_views (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pageviews_page ON app_page_views (page_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pageviews_nonce ON app_page_views (nonce);
    -- Índice DESPUÉS del ALTER que crea «contact» (si no, tumba el arranque en producción).
    CREATE INDEX IF NOT EXISTS idx_pageviews_contact ON app_page_views (tenant_id, contact, created_at DESC) WHERE contact <> '';
    -- EMBUDO-PAGINAS-1 · marca anónima por contacto que viaja en utm_content (lmc_…).
    CREATE TABLE IF NOT EXISTS app_visit_refs (
      token TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      phone TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_visit_refs_contact ON app_visit_refs (tenant_id, phone);

    -- Sitios del píxel EXTERNO: slug (p=<slug> en /pv) → workspace dueño. Se registra al
    -- generar/copiar el snippet en el panel; primer registro gana (ON CONFLICT DO NOTHING)
    -- para que otro workspace no pueda apropiarse de un slug ya en uso.
    CREATE TABLE IF NOT EXISTS app_pixel_sites (
      slug TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    -- Nombre legible con el que se generó el píxel (el slug es su forma normalizada):
    -- el menú de webs lo usa como etiqueta en vez del slug crudo.
    ALTER TABLE app_pixel_sites ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';

    -- BACKFILL de país (idempotente: solo filas sin país). Inferencia por idioma
    -- dominante del huso (~90% acierto, aproximación asumida — misma tabla que
    -- countryOf en web-analytics.ts). Repara vistas antiguas sin origen.
    UPDATE app_page_views SET country=CASE lang
        WHEN 'es' THEN 'ES' WHEN 'fr' THEN 'FR' WHEN 'de' THEN 'DE'
        WHEN 'it' THEN 'IT' WHEN 'nl' THEN 'NL' WHEN 'pl' THEN 'PL' END
     WHERE country='' AND lang IN ('es','fr','de','it','nl','pl') AND tz_min IN (-60,-120);
    UPDATE app_page_views SET country='GB' WHERE country='' AND lang='en' AND tz_min IN (0,-60);
    UPDATE app_page_views SET country='PT' WHERE country='' AND lang='pt' AND tz_min IN (0,-60);

    -- ============================================================
    -- Notas y log de actividad por contacto.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_contact_notes (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      phone TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      body TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_notes_phone ON app_contact_notes (phone, created_at DESC);

    -- ============================================================
    -- Page builder: templates + drafts (HTML cliente puede personalizar).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_page_templates (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'landing',
      slots JSONB NOT NULL DEFAULT '{}',
      html TEXT NOT NULL,
      preview_url TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE TABLE IF NOT EXISTS app_page_drafts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      template_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      data JSONB NOT NULL DEFAULT '{}',
      rendered_html TEXT NOT NULL DEFAULT '',
      target_platform TEXT NOT NULL DEFAULT 'systemeio',
      target_funnel_id TEXT NOT NULL DEFAULT '',
      target_step_id TEXT NOT NULL DEFAULT '',
      target_page_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      published_url TEXT NOT NULL DEFAULT '',
      published_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_drafts_tenant ON app_page_drafts (tenant_id, updated_at DESC);

    -- ============================================================
    -- Assets de páginas (imágenes adjuntas en el editor).
    -- Servidos públicamente vía /a/:id con UUID inguessable.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_page_assets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      draft_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_assets_draft ON app_page_assets (draft_id, created_at DESC);
    -- MEDIA-CADUCA-1 · política de retención de los medios del Programador (draft __sched__).
    -- Pasado el plazo se BORRAN los bytes (data = vacío) pero la fila se queda para el historial:
    -- nombre, tipo y tamaño, y una miniatura (poster, ~20 KB) para que el historial siga viéndose.
    -- expired_at != NULL ⇒ el original ya no se sirve (410 en /a/:id).
    ALTER TABLE app_page_assets ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;
    ALTER TABLE app_page_assets ADD COLUMN IF NOT EXISTS poster BYTEA;
    CREATE INDEX IF NOT EXISTS idx_assets_sched_viva ON app_page_assets (created_at)
      WHERE draft_id='__sched__' AND expired_at IS NULL;
    -- MEDIA-BANDEJA-1 · Adjuntos ENTRANTES (foto/audio/vídeo/doc que manda el cliente).
    -- Guardamos los BYTES, no la URL de Meta: esas URLs son CDN firmado que CADUCA
    -- (403 a los días) y un adjunto de DM no se puede volver a pedir. El webhook es el
    -- único instante en que la URL está viva con certeza.
    -- data puede ser NULL: si la descarga falla, la fila se crea igual con fail_reason
    -- para poder DECIR por qué no está la foto en vez de dejar un hueco mudo.
    CREATE TABLE IF NOT EXISTS app_inbox_media (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      data BYTEA,
      fail_reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_inbox_media_tenant ON app_inbox_media (tenant_id, created_at DESC);
    -- ADJUNTO-REINTENTO-1 · con qué volver a pedir un adjunto cuya descarga falló
    -- (JSON: {mid, acct} en WhatsApp, {url} en Instagram/Facebook). Vacío = no hay
    -- nada con qué reintentar. Sin índice: se lee siempre por id.
    ALTER TABLE app_inbox_media ADD COLUMN IF NOT EXISTS retry_ref TEXT NOT NULL DEFAULT '';

    -- ============================================================
    -- Bridge MCP: cola de jobs que se envían a systemeio-mcp (MCP-DESTINO-1:
    -- NO al MCP del curso, y sin LLM en medio — decía «Claude API + leadmatch-mcp»).
    -- (publicación páginas, sync contactos, sync workflows systeme.io...)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_mcp_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      kind TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued',
      result JSONB NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      attempts INT NOT NULL DEFAULT 0,
      next_run TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_mcpjobs_due ON app_mcp_jobs (status, next_run);
    CREATE INDEX IF NOT EXISTS idx_mcpjobs_tenant ON app_mcp_jobs (tenant_id, created_at DESC);
    -- Idempotencia de la cola: un mismo guardado (doble clic, reintento de red)
    -- no puede encolar DOS jobs iguales. El índice único parcial solo vigila los
    -- 'queued': un job ya en marcha o terminado no bloquea encolar el siguiente.
    ALTER TABLE app_mcp_jobs ADD COLUMN IF NOT EXISTS dedupe_key TEXT NOT NULL DEFAULT '';
    -- SIO-API-F4 · el tipo workflow-run nunca se implementó y se retira: sus pendientes se cierran.
    UPDATE app_mcp_jobs SET status='error', error='Tarea retirada: este tipo ya no existe', updated_at=now()
      WHERE kind='workflow-run' AND status IN ('queued','running','awaiting_config');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcpjobs_dedupe ON app_mcp_jobs (tenant_id, kind, dedupe_key)
      WHERE status='queued' AND dedupe_key <> '';

    -- ============================================================
    -- Snapshots diarios para tendencia % en tiles del dashboard.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_daily_snapshots (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      snap_date DATE NOT NULL,
      metric TEXT NOT NULL,
      value BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, snap_date, metric) );
    CREATE INDEX IF NOT EXISTS idx_snapshots_metric ON app_daily_snapshots (metric, snap_date DESC);

    -- ============================================================
    -- Usuarios del panel (auth multi-user). env-admin sigue funcionando
    -- como fallback owner sin entrada en esta tabla (ID virtual 'env-admin').
    -- password_hash: 's$<salt-hex>$<scrypt-hex>' (scrypt N=16384, r=8, p=1, 64 bytes).
    -- role: 'admin' (gestiona usuarios + todo) | 'member' (panel sin user mgmt).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      active BOOLEAN NOT NULL DEFAULT true,
      session_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ );
    -- BIZGROUPS · el índice único de email lo gestiona la migración 'bizgroups_v1'
    -- (crea idx_users_email_global UNIQUE(LOWER(email)) y dropea el antiguo
    -- idx_users_email (tenant_id,email)). NO lo recreamos aquí para no oscilar cada
    -- boot ni mover el CREATE UNIQUE fuera de la transacción/skip de la migración.
    CREATE INDEX IF NOT EXISTS idx_users_role ON app_users (tenant_id, role);
    -- RBAC por vista: claves del NAV que este usuario puede ver. NULL = TODAS
    -- (default · usuarios existentes · admin). [] = solo dashboard. SIN DEFAULT → cero backfill.
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS allowed_views JSONB;
    -- SESION-REVOCABLE-1 · sube al cambiar la contraseña: la cookie lleva la versión con
    -- la que se firmó y las anteriores dejan de valer (admin.ts credentialVersion).
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;
    -- SESION-REVOCABLE-1 · nonces de las cookies cerradas con «salir», hasta que caduquen.
    -- Clave global a propósito: la sesión es de la persona, no del negocio (el login
    -- resuelve el email cross-group, D14), y ningún endpoint lee esta tabla.
    CREATE TABLE IF NOT EXISTS app_sesiones_revocadas (
      nonce TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      exp BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );

    -- ============================================================
    -- Content Studio: Hook Vault (banco de hooks virales reutilizables)
    -- y Radar de Tendencias (noticias etiquetadas por potencial de hook).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_hooks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      views BIGINT NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '',
      used_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_hooks_tenant ON app_hooks (tenant_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS app_trends (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      hook_potential TEXT NOT NULL DEFAULT 'medio',
      published_at TIMESTAMPTZ,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_trends_tenant ON app_trends (tenant_id, fetched_at DESC);

    -- ============================================================
    -- Workspaces (multi-tenant). Cada workspace = un negocio gestionado
    -- desde la misma instalación del stack. tenant_id de TODAS las
    -- tablas anteriores apunta a app_workspaces.id (FK lógica, no
    -- enforced en BD para no romper la migración aditiva).
    -- id='default' = workspace original — comportamiento single-tenant.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_workspaces (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      brand_color TEXT NOT NULL DEFAULT '#3b82f6',
      logo_url TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'Europe/Madrid',
      archived BOOLEAN NOT NULL DEFAULT false,
      created_by TEXT NOT NULL DEFAULT 'env-admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON app_workspaces (slug) WHERE archived=false;

    -- ============================================================
    -- WS-LIFECYCLE 2026-08-07 · ciclo de vida EXPLICITO del workspace:
    --   activo      -> archived=false.
    --   suspendido  -> archived=true. Ya lo aplican los schedulers via
    --                  wsNotArchivedSql() (no envian) y el routing de canales
    --                  (webhooks al sumidero). Los datos siguen INTACTOS.
    --   recuperable -> mientras corre la retencion, unarchive lo devuelve entero.
    --   purgado     -> cero filas con ese tenant_id en TODA la base.
    -- archived_at marca el INICIO del periodo de retencion: hasta que no vence,
    -- dbPurgeWorkspace() rechaza la purga. Al desarchivar se pone a NULL (el
    -- reloj se para y se reinicia si se vuelve a archivar).
    -- Backfill honesto: para los workspaces ya archivados antes de existir esta
    -- columna, updated_at es la mejor aproximacion disponible (fue su ultimo
    -- cambio de estado). Solo se rellena una vez (WHERE archived_at IS NULL).
    -- ============================================================
    ALTER TABLE app_workspaces ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
    UPDATE app_workspaces SET archived_at=updated_at WHERE archived=true AND archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_workspaces_archived_at
      ON app_workspaces (archived_at) WHERE archived=true;

    -- Seed idempotente del workspace 'default'. Debe existir ANTES
    -- de cualquier FK posterior (app_workspace_members, etc.).
    INSERT INTO app_workspaces (id, label, slug)
    VALUES ('default', 'Negocio principal', 'default')
    ON CONFLICT (id) DO NOTHING;

    -- ============================================================
    -- Membership workspace ↔ user. Cada user pertenece a 1..N
    -- workspaces con un role distinto en cada uno (owner/admin/
    -- editor/viewer). PK compuesta (workspace_id, user_id).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_workspace_members (
      workspace_id TEXT NOT NULL REFERENCES app_workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'admin'
        CHECK (role IN ('owner','admin','editor','viewer')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, user_id) );
    CREATE INDEX IF NOT EXISTS idx_wsmembers_ws ON app_workspace_members (workspace_id);
    CREATE INDEX IF NOT EXISTS idx_wsmembers_user ON app_workspace_members (user_id);

    -- WS-USER-ISOLATION 2026-06-20 · NO se siembra a los usuarios en 'default'.
    -- 'default' es el negocio del OWNER (env-admin, acceso global). Cada usuario-DB
    -- es un tenant aislado: su PROPIO Business Group + workspace (POST /admin/api/users
    -- y la migración ws_user_isolation_v1). La siembra anterior metía a TODOS los
    -- usuarios en el negocio del owner → fuga de aislamiento. Eliminada.

    -- ============================================================
    -- Business Groups (BG): contenedor raíz de aislamiento. Cada grupo posee
    -- SUS workspaces y SUS usuarios. El env-admin (super-admin del stack) es
    -- cross-group y NO tiene fila aquí. id='default' = grupo raíz retro-compat
    -- (todo lo preexistente vive aquí). Bloque BARATO/IDEMPOTENTE; el backfill,
    -- los FK y el swap del índice de email van en la migración tracked
    -- 'bizgroups_v1' (transaccional, más abajo).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_business_groups (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      brand_color TEXT NOT NULL DEFAULT '#6366f1',
      archived BOOLEAN NOT NULL DEFAULT false,
      created_by TEXT NOT NULL DEFAULT 'env-admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_bizgroups_slug ON app_business_groups (slug) WHERE archived=false;

    -- Seed idempotente del grupo 'default'. DEBE existir ANTES del FK (migración).
    INSERT INTO app_business_groups (id, label, slug)
    VALUES ('default', 'Grupo principal', 'default')
    ON CONFLICT (id) DO NOTHING;

    -- Columnas de grupo: aditivas, con DEFAULT 'default' (fail-safe). El backfill
    -- de filas preexistentes y el FK RESTRICT van en la migración tracked.
    ALTER TABLE app_workspaces ADD COLUMN IF NOT EXISTS group_id TEXT DEFAULT 'default';
    ALTER TABLE app_users      ADD COLUMN IF NOT EXISTS group_id TEXT DEFAULT 'default';

    -- Índices de listados calientes (grupo → sus WS / sus users).
    CREATE INDEX IF NOT EXISTS idx_workspaces_bizgroup ON app_workspaces (group_id) WHERE archived=false;
    CREATE INDEX IF NOT EXISTS idx_users_bizgroup      ON app_users (group_id);
    CREATE INDEX IF NOT EXISTS idx_users_bg_role       ON app_users (group_id, role);

    -- ============================================================
    -- Índices compuestos (tenant_id, columna_filtro) para queries
    -- calientes multi-tenant. Sin estos, al activar el filtro por
    -- tenant las queries hacen full-scan + filter en memoria. Solo
    -- los que faltan — los ya existentes (idx_shortlinks_tenant,
    -- idx_pageviews_tenant, idx_drafts_tenant, idx_mcpjobs_tenant,
    -- idx_hooks_tenant, idx_trends_tenant) no se duplican.
    -- ============================================================
    CREATE INDEX IF NOT EXISTS idx_contacts_ws_created
      ON app_contacts (tenant_id, created_at DESC);
    -- CONTACTOS-PAGINA-1 · el orden por defecto del listado de Contactos, que
    -- ahora se pagina en la base de datos (ORDER BY ... LIMIT/OFFSET). Va
    -- DESPUÉS del ALTER que añade tenant_id (línea ~755): al revés tumbaría el
    -- arranque solo en la base de producción.
    CREATE INDEX IF NOT EXISTS idx_contacts_ws_last_inbound
      ON app_contacts (tenant_id, last_inbound DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_ws_updated
      ON app_conversations (tenant_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_posts_ws_due
      ON app_scheduled_posts (tenant_id, scheduled_at) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS idx_flow_runs_ws_due
      ON app_flow_runs (tenant_id, next_run) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS idx_sequence_runs_ws_due
      ON app_sequence_runs (tenant_id, next_run) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS idx_automation_log_ws_created
      ON app_automation_log (tenant_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_ws_key
      ON app_settings (tenant_id, key);
    -- ============================================================
    -- Migración idempotente de PK app_settings: de (key) a (tenant_id, key).
    -- W7 hace que settings.ts escriba con tenant_id real (per-WS o '_global_'),
    -- así que la PK singleton (key) ya no vale (cada WS escribe su propio
    -- whatsapp.accessToken, etc.). El UNIQUE INDEX W3 (tenant_id, key)
    -- garantiza la integridad mientras swappeamos la PK.
    -- ============================================================
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='app_settings_pkey' AND contype='p'
        AND pg_get_constraintdef(oid) = 'PRIMARY KEY (key)'
      ) THEN
        ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
        ALTER TABLE app_settings ADD PRIMARY KEY (tenant_id, key);
      END IF;
    END $$;
    -- ============================================================
    -- Multi-tenant: PK de contactos/conversaciones → (tenant_id, X) para AISLAR
    -- por workspace (antes phone/user_id eran PK GLOBAL → un workspace pisaba el
    -- contacto/hilo de otro con el mismo identificador). Idempotente. ENSANCHA la
    -- PK: no puede fallar por duplicados (phone/user_id ya eran únicos globales).
    -- Todas las lecturas ya filtran por tenant_id (auditado).
    -- ============================================================
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='app_contacts_pkey' AND contype='p'
        AND pg_get_constraintdef(oid) = 'PRIMARY KEY (phone)'
      ) THEN
        ALTER TABLE app_contacts DROP CONSTRAINT app_contacts_pkey;
        ALTER TABLE app_contacts ADD PRIMARY KEY (tenant_id, phone);
      END IF;
    END $$;
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='app_conversations_pkey' AND contype='p'
        AND pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id)'
      ) THEN
        ALTER TABLE app_conversations DROP CONSTRAINT app_conversations_pkey;
        ALTER TABLE app_conversations ADD PRIMARY KEY (tenant_id, user_id);
      END IF;
    END $$;
    -- ============================================================
    -- TENANT-CLAIM-1 · PK de app_automation_log: de (automation_id, user_id) a
    -- (tenant_id, automation_id, user_id). La fila YA guardaba tenant_id, pero la
    -- PK no lo incluía, así que el ON CONFLICT DO NOTHING de dbClaimOnce() era
    -- GLOBAL: el primer workspace que reclamaba un id se lo quedaba para TODOS.
    -- Con los claims sintéticos ('_ig_comment', '_fb_comment', '__ytpoll',
    -- '__lipoll', cuyo user_id es el id del comentario) basta con que dos tenants
    -- vean el mismo id para que el segundo dé el comentario por procesado y no lo
    -- responda NUNCA — y con oncePerUser pasa igual si coinciden automation_id y
    -- user_id. Además el modo memoria sí separa por tenant (clave
    -- "tenantId:automationId:userId"), o sea que BD y memoria no coincidían.
    -- ENSANCHA la PK: no puede fallar por duplicados. Idempotente.
    -- ============================================================
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='app_automation_log_pkey' AND contype='p'
        AND pg_get_constraintdef(oid) = 'PRIMARY KEY (automation_id, user_id)'
      ) THEN
        ALTER TABLE app_automation_log DROP CONSTRAINT app_automation_log_pkey;
        ALTER TABLE app_automation_log ADD PRIMARY KEY (tenant_id, automation_id, user_id);
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_lead_jobs_ws_created
      ON app_lead_jobs (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_autopost_history_ws_created
      ON app_autopost_history (tenant_id, created_at DESC);

    -- ============================================================
    -- logs-cola FASE-1: log unificado de actividad cross-sistema.
    -- Todos los orígenes (autopost, broadcast, scheduled-post, mcp-jobs,
    -- lead-jobs, webhooks, llamadas LLM, envíos WA/IG, errores app...)
    -- escriben una fila aquí. Lo consumen los dashboards/badges.
    -- Retención: 30 días vía dbDeleteActivityOlderThan (setInterval).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_activity_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL DEFAULT 'default',
      source TEXT NOT NULL CHECK (source IN ('autopost','scheduled-post','broadcast','mcp-job','lead-job','webhook','llm','meta-api','wa-send','ig-send','fb-send','yt-send','newsletter','app')),
      level TEXT NOT NULL CHECK (level IN ('info','warn','error')) DEFAULT 'info',
      status TEXT,
      summary TEXT NOT NULL,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_activity_ws_created
      ON app_activity_log (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_source_created
      ON app_activity_log (source, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_error
      ON app_activity_log (tenant_id, created_at DESC) WHERE level='error';
    -- ============================================================
    -- Migración idempotente del CHECK de app_activity_log.source.
    -- El CREATE TABLE de arriba es IF NOT EXISTS: en las BD ya creadas
    -- sigue vigente el CHECK antiguo (11 valores, sin 'yt-send') y
    -- RECHAZA cada insert de YouTube. logActivity() se traga el error
    -- en silencio (es telemetría, no propaga) → cero trazas y nadie se
    -- entera. Recreamos la constraint con los 14 valores SOLO si la
    -- definición actual todavía no admite el último añadido (idempotente).
    -- El centinela es el valor MÁS NUEVO ('newsletter', NEWSLETTER-1): con
    -- 'fb-send' de centinela, una base que ya lo tuviera se saltaba la
    -- migración y seguía rechazando los orígenes posteriores en silencio.
    -- El nombre app_activity_log_source_check es el que autogenera
    -- Postgres para un CHECK de columna sin CONSTRAINT explícito;
    -- si no existe, el guard no hace nada (no puede romper nada).
    -- ============================================================
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='app_activity_log_source_check' AND contype='c'
        AND pg_get_constraintdef(oid) NOT LIKE '%newsletter%'
      ) THEN
        ALTER TABLE app_activity_log DROP CONSTRAINT app_activity_log_source_check;
        ALTER TABLE app_activity_log ADD CONSTRAINT app_activity_log_source_check
          CHECK (source IN ('autopost','scheduled-post','broadcast','mcp-job','lead-job','webhook','llm','meta-api','wa-send','ig-send','fb-send','yt-send','newsletter','app'));
      END IF;
    END $$;

    -- ============================================================
    -- NOTIFICACIONES-1 · lo que le pasa al NEGOCIO (lead nuevo, alguien
    -- contestó y salió de un flujo, pide una persona, pago, reunión…), no
    -- la telemetría de app_activity_log. Alimenta la campana de la cabecera
    -- y la pestaña Notificaciones de Actividad.
    --  · kind: TEXT sin CHECK a propósito (el catálogo crece; un CHECK viejo
    --    en una base ya creada rechazaría los tipos nuevos en silencio, que
    --    es justo lo que le pasó a app_activity_log.source).
    --  · dedup_key: una misma cosa no avisa dos veces (reintentos de Meta,
    --    o «un aviso por contacto cada 30 min»). Índice único PARCIAL.
    --  · Leído es POR PERSONA: marca «visto hasta» (seen) + leídas sueltas.
    -- Retención: 90 días (setInterval de initDb).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_notifications (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      phone TEXT,
      channel TEXT,
      link TEXT,
      dedup_key TEXT,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_notif_ws_created
      ON app_notifications (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notif_ws_kind_created
      ON app_notifications (tenant_id, kind, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_ws_dedup
      ON app_notifications (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS app_notification_reads (
      tenant_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      notification_id BIGINT NOT NULL,
      read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, actor, notification_id) );
    CREATE TABLE IF NOT EXISTS app_notification_seen (
      tenant_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, actor) );
    -- BANDEJA-LEIDOS-1 · qué ha leído cada persona del equipo en la Bandeja. Una fila
    -- por marca: 'c:<contacto>|<cuenta>' (abrió ese chat), 'ch:<canal>' / 'ac:<cuenta>'
    -- («marcar como leídas» de un canal o de un número), '*' (todo) y 'base' (primera
    -- vez que se calculó: lo anterior no cuenta como nuevo). read_ms = epoch ms, igual
    -- que el 'at' de los turnos: se comparan sin conversiones de zona horaria.
    CREATE TABLE IF NOT EXISTS app_inbox_reads (
      tenant_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      k TEXT NOT NULL,
      read_ms BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, actor, k) );

    -- ============================================================
    -- metricas-pro M3: app_wa_events — eventos crudos de WhatsApp
    -- (envíos + recibidos) usados para la pestaña Métricas → WhatsApp PRO:
    --   - direction='out': cada envío que hace el bot (text/template/...)
    --   - direction='in' : cada mensaje recibido por el webhook
    --   - response_time_ms (solo en 'in'): ms transcurridos desde el último
    --     'out' al mismo número en los últimos 60min — sirve para el tiempo
    --     medio de respuesta del cliente al bot.
    -- Multi-tenant: tenant_id NOT NULL DEFAULT 'default'. Multi-número
    -- per-WS: phone_number_id permite filtrar la vista por número activo.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_wa_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL DEFAULT 'default',
      phone_number_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      msg_type TEXT,
      status TEXT,
      template_name TEXT,
      response_time_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_wa_events_ws_phone_created
      ON app_wa_events (tenant_id, phone_number_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wa_events_template_status_created
      ON app_wa_events (template_name, status, created_at DESC) WHERE template_name IS NOT NULL;
    ALTER TABLE app_wa_events ADD COLUMN IF NOT EXISTS message_id TEXT;
    ALTER TABLE app_wa_events ADD COLUMN IF NOT EXISTS user_id TEXT;
    ALTER TABLE app_wa_events ADD COLUMN IF NOT EXISTS status_at TIMESTAMPTZ;
    ALTER TABLE app_wa_events ADD COLUMN IF NOT EXISTS error_code TEXT;
    ALTER TABLE app_wa_events ADD COLUMN IF NOT EXISTS error_detail TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_events_ws_message
      ON app_wa_events (tenant_id, message_id)
      WHERE message_id IS NOT NULL AND message_id <> '';

    -- ============================================================
    -- REACCIONES-1: app_wa_reactions — reacción vigente por mensaje y lado
    -- (contacto/agente). Estado actual, no historial: un upsert por
    -- (tenant_id, message_id, from_role). emoji='' significa reacción
    -- retirada. Se resuelve por reacted_at (no por rango como el estado de
    -- entrega): una reacción se puede quitar, no solo avanzar, así que un
    -- webhook desordenado no debe resucitarla.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_wa_reactions (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      message_id TEXT NOT NULL,
      from_role TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '',
      reacted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, message_id, from_role) );
    CREATE INDEX IF NOT EXISTS idx_wa_reactions_msg
      ON app_wa_reactions (tenant_id, message_id);

    -- ============================================================
    -- meta-ads-pro A3 — Creative Library.
    -- Cada fila = un asset publicitario del workspace:
    --   - type='image'    → subido como ad image (hash en meta_id).
    --   - type='video'    → subido como ad video (video_id en meta_id).
    --   - type='carousel' → coleccion logica de imagenes (sin meta_id propio;
    --                       cada item es un row image y el carousel se
    --                       compone al crear el adcreative final).
    --   - type='copy'     → solo texto (headline/body/cta) sin binario.
    -- status: draft → syncing → synced (con meta_id) | failed (con error).
    -- ad_account_id: id sin prefijo act_ (igual que metaAdsAccountsList).
    -- Multi-tenant: tenant_id NOT NULL DEFAULT 'default'.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_ads_creatives (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL DEFAULT 'default',
      ad_account_id TEXT,
      meta_id TEXT,
      type TEXT NOT NULL CHECK (type IN ('image','video','carousel','copy')),
      name TEXT NOT NULL DEFAULT '',
      url TEXT,
      thumb_url TEXT,
      body JSONB,
      status TEXT NOT NULL CHECK (status IN ('draft','syncing','synced','failed')) DEFAULT 'draft',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_ads_creatives_ws_acc_created
      ON app_ads_creatives (tenant_id, ad_account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ads_creatives_ws_status
      ON app_ads_creatives (tenant_id, status);

    -- ============================================================
    -- meta-ads-pro A4 — A/B testing experiments.
    -- variants JSONB array de { ad_id, label, creative_id?, adset_id? }.
    -- status: running → completed (con winner_ad_id) | failed (con error).
    -- ad_account_id sin prefijo act_.
    -- Multi-tenant: tenant_id NOT NULL DEFAULT 'default'.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_ads_experiments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL DEFAULT 'default',
      ad_account_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      base_campaign_id TEXT NOT NULL,
      variants JSONB NOT NULL DEFAULT '[]',
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ,
      winner_ad_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('running','completed','failed')) DEFAULT 'running',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_ads_experiments_ws_acc_created
      ON app_ads_experiments (tenant_id, ad_account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ads_experiments_ws_status
      ON app_ads_experiments (tenant_id, status);

    -- ============================================================
    -- meta-ads-pro A5 — Alertas configurables sobre KPIs Meta Ads.
    --
    -- app_ads_alerts: regla configurada por el operador.
    -- app_ads_alert_log: historico de disparos (auditoria + UI).
    --
    -- ad_account_id sin prefijo act_.
    -- scope_id NULL si scope='account' (toda la cuenta).
    -- threshold NUMERIC para soportar decimales (cpc=0.45, ctr=2.5%).
    -- channel ∈ panel/whatsapp/email — panel = solo logActivity, los
    -- otros dos requieren config per-WS (ads.alerts.ownerPhone/Email).
    -- Multi-tenant: tenant_id NOT NULL DEFAULT 'default' en TODAS las
    -- queries (filtramos en cada SELECT).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_ads_alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL DEFAULT 'default',
      ad_account_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      metric TEXT NOT NULL CHECK (metric IN ('cpc','ctr','conversions','spend','reach')),
      operator TEXT NOT NULL CHECK (operator IN ('>','<','=','>=','<=')),
      threshold NUMERIC NOT NULL DEFAULT 0,
      scope TEXT NOT NULL CHECK (scope IN ('campaign','adset','ad','account')) DEFAULT 'account',
      scope_id TEXT,
      channel TEXT NOT NULL CHECK (channel IN ('panel','whatsapp','email')) DEFAULT 'panel',
      enabled BOOLEAN NOT NULL DEFAULT true,
      last_fired_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_ads_alerts_ws_acc
      ON app_ads_alerts (tenant_id, ad_account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ads_alerts_ws_enabled
      ON app_ads_alerts (tenant_id, enabled);

    CREATE TABLE IF NOT EXISTS app_ads_alert_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL DEFAULT 'default',
      alert_id UUID NOT NULL REFERENCES app_ads_alerts(id) ON DELETE CASCADE,
      value NUMERIC NOT NULL DEFAULT 0,
      fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL CHECK (status IN ('fired','snoozed','dismissed')) DEFAULT 'fired' );
    CREATE INDEX IF NOT EXISTS idx_ads_alert_log_ws_fired
      ON app_ads_alert_log (tenant_id, fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ads_alert_log_alert
      ON app_ads_alert_log (alert_id, fired_at DESC);

    -- ============================================================
    -- difusion-flow D1 — Broadcast Flow Builder.
    --
    -- 3 tablas que modelan un grafo de difusion multi-paso:
    --   - app_broadcasts_flows: definicion del flow (JSON nodes+edges).
    --   - app_broadcasts_runs:  cada ejecucion del flow (1..N por flow).
    --   - app_broadcasts_jobs:  envios concretos (1 por destinatario × canal).
    --
    -- Multi-tenant strict: tenant_id NOT NULL DEFAULT 'default' en TODAS;
    -- TODAS las queries filtran por tenant_id antes de exponer rows.
    --
    -- Ownership wiring:
    --   - app_broadcasts_runs.flow_id REFERENCES app_broadcasts_flows
    --     (ON DELETE CASCADE) — al borrar un flow, sus runs caen.
    --   - app_broadcasts_jobs.run_id REFERENCES app_broadcasts_runs
    --     (ON DELETE CASCADE) — al borrar un run, sus jobs caen.
    --   - El UNIQUE (run_id, recipient, channel) WHERE status IN ('queued',
    --     'sent') es la dedup: el mismo run no encola dos veces al mismo
    --     destinatario por el mismo canal (cancelled/failed/skipped no
    --     cuentan para que el operador pueda re-encolar tras un fail).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_broadcasts_flows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT false,
      last_sim_at TIMESTAMPTZ,
      last_sim_result JSONB,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_bcflows_ws_updated
      ON app_broadcasts_flows (tenant_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS app_broadcasts_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL DEFAULT 'default',
      flow_id UUID NOT NULL REFERENCES app_broadcasts_flows(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','completed','cancelled','failed')),
      scheduled_for TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      audience_total INTEGER NOT NULL DEFAULT 0,
      jobs_sent INTEGER NOT NULL DEFAULT 0,
      jobs_failed INTEGER NOT NULL DEFAULT 0,
      jobs_replied INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    -- Indice del scheduler: solo runs vivos (queued/running) — el WHERE parcial
    -- mantiene el indice pequeno y barato de escanear cada tick.
    CREATE INDEX IF NOT EXISTS idx_bcruns_ws_due
      ON app_broadcasts_runs (tenant_id, status, scheduled_for)
      WHERE status IN ('queued','running');
    CREATE INDEX IF NOT EXISTS idx_bcruns_flow_created
      ON app_broadcasts_runs (flow_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS app_broadcasts_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL DEFAULT 'default',
      run_id UUID NOT NULL REFERENCES app_broadcasts_runs(id) ON DELETE CASCADE,
      flow_id UUID NOT NULL,
      recipient TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('wa','ig_dm','fb_msg','email','sms')),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','sent','failed','cancelled','skipped')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_run TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      replied_at TIMESTAMPTZ,
      message_id TEXT,
      last_error TEXT,
      cost_cents INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    -- idx_bcjobs_due: indice parcial sobre status='queued' para que el tick
    -- del scheduler escanee solo lo que falta por enviar.
    CREATE INDEX IF NOT EXISTS idx_bcjobs_due
      ON app_broadcasts_jobs (tenant_id, status, next_run)
      WHERE status='queued';
    CREATE INDEX IF NOT EXISTS idx_bcjobs_run_channel_status
      ON app_broadcasts_jobs (run_id, channel, status);
    -- Dedup: el mismo run no encola dos veces al mismo recipient por el mismo
    -- canal. Solo cuentan estados "vivos" (queued/sent) — si el job fallo o
    -- fue cancelado, el operador puede re-encolar.
    -- FOLLOWUP-1 · El seguimiento NO se enviaba NUNCA por culpa de este índice.
    -- El job de seguimiento se encola con el mismo (run_id, recipient, channel)
    -- que el mensaje original, y ese original está justamente en 'sent' (es el
    -- requisito para que haya seguimiento): el índice ya estaba ocupado, el
    -- ON CONFLICT DO NOTHING devolvía 0 filas y nadie se enteraba — ni excepción
    -- ni traza. La función entera llevaba muerta desde que se escribió.
    -- La identidad correcta incluye QUÉ PASO del flujo es: el mensaje y su
    -- seguimiento son dos envíos distintos a la misma persona, no un duplicado.
    ALTER TABLE app_broadcasts_jobs ADD COLUMN IF NOT EXISTS step_key TEXT NOT NULL DEFAULT 'main';
    DROP INDEX IF EXISTS idx_bcjobs_dedup;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bcjobs_dedup_step
      ON app_broadcasts_jobs (run_id, recipient, channel, step_key)
      WHERE status IN ('queued','sent');
    -- REG-2: lookup caliente del webhook inbound — para cada mensaje
    -- entrante buscamos jobs 'sent' sin replied_at de ese recipient en
    -- el canal. Indice parcial (solo filas 'sent' sin replied) mantiene
    -- el tamaño minusculo y el plan es Index Scan O(log N) en lugar de
    -- cargar 500 filas y filtrar en memoria.
    CREATE INDEX IF NOT EXISTS idx_bcjobs_unreplied
      ON app_broadcasts_jobs (tenant_id, recipient, channel, sent_at DESC)
      WHERE status='sent' AND replied_at IS NULL;

    -- ============================================================
    -- T03-CORREOS · Eventos de correo de cuentas web conectadas
    -- (systeme.io / leadmatch-lab). Cada fila = UNA ocurrencia
    -- semántica («la web asignó la etiqueta X al contacto Y»), venga
    -- por webhook o por la reconciliación de la API pública: la clave
    -- de dedupe es la MISMA por las dos vías, así el índice único hace
    -- de claim (ON CONFLICT DO NOTHING) y un evento repetido —reintento
    -- del webhook, webhook+poll, reinicio, dos workers— no reprocesa.
    -- Sin cuerpo del correo ni payload crudo: solo lo mínimo normalizado.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_email_events (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      account_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      event TEXT NOT NULL DEFAULT 'tag_added',
      tag TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'webhook',
      occurred_at TIMESTAMPTZ,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'new',
      attempts INT NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      flows_started INT NOT NULL DEFAULT 0 );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_events_dedupe
      ON app_email_events (tenant_id, account_id, dedupe_key);
    -- Listados de observabilidad (últimos eventos de la cuenta) — es la única
    -- consulta caliente además del claim.
    CREATE INDEX IF NOT EXISTS idx_email_events_recent
      ON app_email_events (tenant_id, account_id, received_at DESC);

    -- ============================================================
    -- FORMULARIOS-1 · formularios propios del panel (página pública /f/<slug>).
    -- El slug es ÚNICO EN TODA LA PLATAFORMA: es lo único que trae la visita
    -- pública, y de él sale el workspace. Todo lo demás se lee acotado por tenant.
    -- app_form_days: visitas y envíos por día (métricas y sparkline).
    -- app_form_responses: cada envío, también los de Typeform (form_id 'tf:<id>'),
    -- para que la ficha del contacto y la vista enseñen las dos fuentes igual.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_forms (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      slug TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      intro TEXT NOT NULL DEFAULT '',
      questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      opts JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_forms_slug ON app_forms (slug);
    CREATE INDEX IF NOT EXISTS idx_forms_ws ON app_forms (tenant_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS app_form_days (
      tenant_id TEXT NOT NULL,
      form_id TEXT NOT NULL,
      day DATE NOT NULL,
      views INT NOT NULL DEFAULT 0,
      submissions INT NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, form_id, day) );
    CREATE TABLE IF NOT EXISTS app_form_responses (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      form_id TEXT NOT NULL,
      form_title TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'web',
      contact_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      answers JSONB NOT NULL DEFAULT '[]'::jsonb,
      sync TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
    CREATE INDEX IF NOT EXISTS idx_form_resp_form ON app_form_responses (tenant_id, form_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_form_resp_contact ON app_form_responses (tenant_id, contact_id, created_at DESC);

    -- ============================================================
    -- OPORTUNIDADES-1 (PIP-01) · posibles ventas. Una persona vive en
    -- app_contacts; una oportunidad es UNA gestión comercial con ella, en un
    -- pipeline y una etapa. Una persona puede tener cero, una o varias (dos
    -- compras distintas no se funden). outcome '' = abierta, 'won' / 'lost' =
    -- desenlace. origin/reason dicen quién o qué regla la abrió, para poder
    -- corregir una regla errónea. owner/value/next_* las usan PIP-02..04.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS app_opportunities (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      phone TEXT NOT NULL,
      pipeline_id TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT '',
      value NUMERIC,
      next_action TEXT NOT NULL DEFAULT '',
      next_at BIGINT NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at TIMESTAMPTZ );
    CREATE INDEX IF NOT EXISTS idx_opps_pipe ON app_opportunities (tenant_id, pipeline_id, outcome);
    CREATE INDEX IF NOT EXISTS idx_opps_phone ON app_opportunities (tenant_id, phone);
    -- OPPS-HUERFANAS-1 · oportunidades de contactos ya borrados (antes borrar el contacto no
    -- las borraba). Idempotente; la hora de margen evita pisar una recién abierta por un flujo.
    DELETE FROM app_opportunities o WHERE o.created_at < now() - interval '1 hour'
      AND NOT EXISTS (SELECT 1 FROM app_contacts c WHERE c.tenant_id=o.tenant_id AND c.phone=o.phone);

    -- ============================================================
    -- Histórico de migraciones aplicadas. Cada fila = una migración
    -- ya corrida. Permite ejecutarlas una sola vez aunque el proceso
    -- arranque cien veces.
    -- ============================================================
    -- MCP-1 · claves de conexión de IA (servidor /mcp). Se guarda SOLO el sha256 de la
    -- clave: la clave en claro se enseña una vez al crearla y no se puede recuperar.
    -- Tabla nueva con todas sus columnas en el CREATE: los índices van detrás sin ALTER.
    CREATE TABLE IF NOT EXISTS app_mcp_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      user_uid TEXT NOT NULL,
      user_label TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL,
      prefix TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'completo',
      uses INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      via TEXT NOT NULL DEFAULT 'clave',
      client_id TEXT NOT NULL DEFAULT '',
      client_name TEXT NOT NULL DEFAULT '',
      refresh_hash TEXT,
      refresh_prev_hash TEXT,
      expires_at TIMESTAMPTZ,
      refresh_expires_at TIMESTAMPTZ );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_keys_hash ON app_mcp_keys (token_hash);
    CREATE INDEX IF NOT EXISTS idx_mcp_keys_ws ON app_mcp_keys (tenant_id, created_at DESC);
    -- MCP-2 · conexiones por inicio de sesión (OAuth): la IA recibe un pase de 1 h (token_hash)
    -- y otro para renovarlo (refresh_hash). Las filas de MCP-1 quedan via='clave', sin caducidad.
    -- El índice de refresh_hash va DESPUÉS de su ALTER: en la base de producción la tabla ya existe.
    ALTER TABLE app_mcp_keys ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'clave';
    ALTER TABLE app_mcp_keys ADD COLUMN IF NOT EXISTS client_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_mcp_keys ADD COLUMN IF NOT EXISTS client_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_mcp_keys ADD COLUMN IF NOT EXISTS refresh_hash TEXT;
    ALTER TABLE app_mcp_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    ALTER TABLE app_mcp_keys ADD COLUMN IF NOT EXISTS refresh_expires_at TIMESTAMPTZ;
    ALTER TABLE app_mcp_keys ADD COLUMN IF NOT EXISTS refresh_prev_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_keys_refresh ON app_mcp_keys (refresh_hash) WHERE refresh_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mcp_keys_refresh_prev ON app_mcp_keys (refresh_prev_hash) WHERE refresh_prev_hash IS NOT NULL;

    CREATE TABLE IF NOT EXISTS app_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now() );
  `);

  // FLOW-LOGS · BACKFILL del HISTÓRICO (una sola vez, cuando la tabla está vacía):
  // reconstruye desde app_flow_runs lo que se puede saber del pasado — cuándo ENTRÓ
  // cada contacto (created_at) y su ESTADO actual (updated_at). Marcado como
  // «histórico reconstruido» para distinguirlo del registro vivo. Best-effort: si
  // falla, el arranque sigue (el registro vivo empieza igual desde ya).
  try {
    const hasEvents = await pool.query("SELECT 1 FROM app_flow_events LIMIT 1");
    if (!hasEvents.rowCount) {
      await pool.query(`
        INSERT INTO app_flow_events (tenant_id, flow_id, phone, event, node_id, detail, at)
        SELECT COALESCE(tenant_id,'default'), flow_id, phone, 'entró', '', 'histórico reconstruido', COALESCE(created_at, updated_at)
          FROM app_flow_runs
        UNION ALL
        SELECT COALESCE(tenant_id,'default'), flow_id, phone,
               CASE status WHEN 'done' THEN 'completó' WHEN 'cancelled' THEN 'cancelado'
                           WHEN 'waiting' THEN 'esperando respuesta' ELSE 'en curso' END,
               node_id, 'histórico reconstruido', updated_at
          FROM app_flow_runs
         WHERE updated_at IS DISTINCT FROM COALESCE(created_at, updated_at) OR status IN ('done','cancelled')`);
      console.log("[db] flow-logs: histórico reconstruido desde app_flow_runs");
    }
  } catch (e) {
    console.warn("[db] flow-logs backfill:", (e as Error).message);
  }

  // ============================================================
  // Migración 'workspaces_v1_global_keys' (idempotente).
  //
  // Tras W7 settings.ts escribe en tenant_id='_global_' las keys
  // compartidas (admin/meta/whatsapp/key.*/llm/chatfuel/mcp). Pero
  // todas las instalaciones existentes tienen esas filas con
  // tenant_id='default' (lo que sembró el código pre-W7). Esta
  // migración las MUEVE a '_global_' UNA SOLA VEZ.
  //
  // Diseño:
  //  - INSERT INTO app_migrations con ON CONFLICT DO NOTHING +
  //    RETURNING id. Si devuelve fila → no estaba aplicada → corremos
  //    el UPDATE. Si NO devuelve fila → ya estaba aplicada → skip.
  //  - Todo dentro de una transacción para atomicidad: si el UPDATE
  //    falla, el rollback retira también el insert de app_migrations,
  //    así no quedamos marcados como "aplicada" sin haber movido nada.
  //  - ENV var WORKSPACES_SKIP_GLOBALS_MIGRATION='true' como escape:
  //    permite saltarla sin tocar código si surge un problema en
  //    Railway durante el boot.
  //
  // Lista de GLOBAL_KEYS (FINAL — sincronizada con settings.ts W7).
  // NUNCA loguear los valores (son secretos).
  // ============================================================
  if (process.env.WORKSPACES_SKIP_GLOBALS_MIGRATION === "true") {
    console.log("[db] migración workspaces_v1_global_keys SALTADA (WORKSPACES_SKIP_GLOBALS_MIGRATION=true).");
  } else {
    const GLOBAL_KEYS = [
      "admin.user", "admin.pass", "admin.credentialsPin",
      "meta.appId", "meta.appSecret", "meta.waEmbeddedConfigId",
      "whatsapp.verifyToken", "whatsapp.appSecret",
      "key.groq", "key.gemini", "key.openrouter", "key.anthropic", "key.openai",
      "llm.provider", "llm.model", "llm.fallbackProvider", "llm.fallbackModel",
      "chatfuel.jsonSecret",
      "mcp.token", "mcp.url", "mcp.authHeader", "mcp.authPrefix",
    ];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        "INSERT INTO app_migrations (id) VALUES ('workspaces_v1_global_keys') ON CONFLICT (id) DO NOTHING RETURNING id",
      );
      if (ins.rowCount && ins.rowCount > 0) {
        // No estaba aplicada — promueve las filas existentes.
        // W11: guard NOT EXISTS para idempotencia ante re-deploys.
        // Evita que el UPDATE colisione con la PK (tenant_id, key) si
        // ya existe una fila '_global_' para esa key (por rollback
        // parcial, segundo deploy, u operator que la insertó a mano).
        const upd = await client.query(
          `UPDATE app_settings
             SET tenant_id='_global_'
           WHERE tenant_id='default'
             AND key = ANY($1::text[])
             AND NOT EXISTS (
               SELECT 1 FROM app_settings g
               WHERE g.tenant_id='_global_' AND g.key=app_settings.key
             )`,
          [GLOBAL_KEYS],
        );
        await client.query("COMMIT");
        // Solo loguea contadores + lista de KEYS — nunca el VALOR.
        console.log(
          `[db] migración workspaces_v1_global_keys aplicada: ${upd.rowCount ?? 0} filas movidas a tenant_id='_global_'. keys=${GLOBAL_KEYS.join(",")}`,
        );
      } else {
        // Ya estaba aplicada — rollback simbólico (no había nada que
        // commitear) y log informativo.
        await client.query("ROLLBACK");
        console.log("[db] migración workspaces_v1_global_keys ya aplicada — skip.");
      }
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* best effort */ }
      // Re-tira para que se vea en logs Railway y el operador pueda
      // decidir si saltarla con WORKSPACES_SKIP_GLOBALS_MIGRATION=true.
      throw new Error(`[db] migración workspaces_v1_global_keys FALLÓ: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }

  // ============================================================
  // Migración 'bizgroups_v1' (idempotente, transaccional).
  // Backfill de group_id en filas preexistentes + FK RESTRICT + swap del índice
  // de email a UNIQUE GLOBAL (login por email determinista cross-group). Se separa
  // del query monolítico para poder saltarla con BIZGROUPS_SKIP_MIGRATION y no
  // re-correr el UPDATE masivo en cada boot. Mismo patrón que workspaces_v1.
  //
  // CUIDADO (orden seguro): CREATE UNIQUE GLOBAL primero — si hubiera dos emails
  // iguales (dato sucio) lanza y la TX entera hace ROLLBACK dejando intacto el
  // idx_users_email viejo; el DROP del viejo solo corre tras verificar que el
  // nuevo existe. Pre-check antes de desplegar: no debe haber LOWER(email) repetidos.
  // ============================================================
  if (process.env.BIZGROUPS_SKIP_MIGRATION === "true") {
    console.log("[db] migración bizgroups_v1 SALTADA (BIZGROUPS_SKIP_MIGRATION=true).");
  } else {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        "INSERT INTO app_migrations (id) VALUES ('bizgroups_v1') ON CONFLICT (id) DO NOTHING RETURNING id",
      );
      if (ins.rowCount && ins.rowCount > 0) {
        // (1) Backfill: TODO ws/user preexistente sin grupo → 'default'.
        await client.query("UPDATE app_workspaces SET group_id='default' WHERE group_id IS NULL");
        await client.query("UPDATE app_users      SET group_id='default' WHERE group_id IS NULL");
        // (2) FK RESTRICT idempotente (guard pg_constraint).
        await client.query(`
          DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_workspaces_bizgroup') THEN
              ALTER TABLE app_workspaces ADD CONSTRAINT fk_workspaces_bizgroup
                FOREIGN KEY (group_id) REFERENCES app_business_groups(id) ON DELETE RESTRICT;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_users_bizgroup') THEN
              ALTER TABLE app_users ADD CONSTRAINT fk_users_bizgroup
                FOREIGN KEY (group_id) REFERENCES app_business_groups(id) ON DELETE RESTRICT;
            END IF;
          END $$;`);
        // (3) Swap del índice de email a UNIQUE GLOBAL (login determinista).
        await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_global ON app_users (LOWER(email))");
        await client.query(`
          DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_users_email_global') THEN
              DROP INDEX IF EXISTS idx_users_email;
            END IF;
          END $$;`);
        await client.query("COMMIT");
        console.log("[db] migración bizgroups_v1 aplicada: backfill group_id + FK RESTRICT + email-unique-global.");
      } else {
        await client.query("ROLLBACK");
        console.log("[db] migración bizgroups_v1 ya aplicada — skip.");
      }
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* best effort */ }
      throw new Error(`[db] migración bizgroups_v1 FALLÓ: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }

  console.log("[db] Postgres listo (multi-tenant ready, contacto enriquecido, page builder, link tracker, mcp bridge, users, workspaces, broadcast flows).");

  // ============================================================
  // SEC-ORPHAN-WS 2026-08-07 · el boot YA NO auto-cura workspaces sin
  // miembros. Aquello ascendía a owner a TODOS los users del grupo
  // (viewers y editors incluidos) en cada reinicio: escalada silenciosa.
  // Ahora solo se detecta y se deja alerta; el workspace huérfano queda
  // bloqueado y se recupera asignando un owner concreto (auditado).
  // ============================================================
  try {
    const r = await healOrphanWorkspaces();
    if (r.orphans.length > 0) {
      console.warn(`[ws-orphan] boot: ${r.orphans.length} workspace(s) huérfanos — NO se auto-curan (ver alerta en Actividad).`);
    } else {
      console.log("[ws-orphan] boot: sin workspaces huérfanos.");
    }
  } catch (e) {
    console.warn(`[ws-orphan] boot: detección falló: ${(e as Error).message}`);
  }

  // ============================================================
  // BIZGROUPS · reconcilia memberships cruzadas (user de un grupo ↔ ws de otro).
  // Idempotente. Hoy (todo en 'default') = 0 filas; su valor real es la pasada
  // previa al flip de BIZGROUPS_ENFORCE=on, una vez existan grupos no-default.
  // ============================================================
  try {
    const rc = await dbReconcileCrossGroupMemberships();
    if (rc.removed > 0) console.warn(`[bizgroups] reconcile: ${rc.removed} membership(s) cruzadas borradas.`);
    else console.log("[bizgroups] reconcile: sin memberships cruzadas.");
  } catch (e) {
    console.warn(`[bizgroups] reconcile error: ${(e as Error).message}`);
  }

  // ============================================================
  // WS-USER-ISOLATION 2026-06-20 · cada usuario-DB = tenant aislado.
  // Provisioning idempotente (grupo + workspace propios por usuario) + retiro
  // one-shot (marker) de todos los users-DB del 'default' del owner. Compone
  // con Business Groups: el ws propio vive en el grupo propio del usuario, así
  // userAuthorizedForWs deniega el 'default' del owner incluso con el flag OFF.
  // ============================================================
  try {
    await migrateUserIsolationV1();
  } catch (e) {
    console.warn(`[db] ws_user_isolation_v1 error (no bloquea boot): ${(e as Error).message}`);
  }

  // ============================================================
  // WS-USER-ISOLATION 2026-06-22 · modelo 3 niveles: un usuario que es el ÚNICO
  // de su business group (≠'default') y sigue como 'member' = es el DUEÑO de su
  // grupo (cliente creado antes del modelo) → promover a 'admin' (group-admin).
  // Idempotente y seguro cada boot: si ya es admin, o el grupo tiene >1 usuario
  // (admin + sub-usuarios), NO toca. Así el owner no tiene que cambiar roles a mano.
  // ============================================================
  if (pool) {
    try {
      const r = await pool.query(
        `UPDATE app_users u SET role='admin'
          WHERE u.role='member'
            AND u.group_id IS NOT NULL AND u.group_id <> 'default'
            AND (SELECT COUNT(*) FROM app_users x WHERE x.group_id = u.group_id) = 1`,
      );
      if ((r.rowCount ?? 0) > 0) console.log(`[db] promote-group-owner: ${r.rowCount} usuario(s) único(s) de su grupo → admin (dueños de su business group).`);
    } catch (e) {
      console.warn(`[db] promote-group-owner error (no bloquea boot): ${(e as Error).message}`);
    }
  }

  // WS-USER-ISOLATION 2026-06-22 · barre chatarra del bucle de provisioning previo al
  // fix de orden (grupos+workspaces huérfanos sin miembros) + dedupe one-shot. Cada boot.
  try {
    await cleanupProvisioningGarbageV1();
  } catch (e) {
    console.warn(`[db] cleanup-garbage error (no bloquea boot): ${(e as Error).message}`);
  }

  // ============================================================
  // logs-cola FASE-1: retention scheduler app_activity_log (30 días).
  // setInterval estándar JS — cada 24h borra filas con created_at <
  // now() - 30 días. Solo se monta una vez (initDb se llama una vez
  // al boot). Sin DB no hace falta: el array en mem no rota.
  // ============================================================
  setInterval(async () => {
    try {
      const removed = await dbDeleteActivityOlderThan(30);
      if (removed > 0) {
        console.log(`[db] activity-log retention: ${removed} filas > 30 días borradas.`);
      }
    } catch (e) {
      console.warn(`[db] activity-log retention falló: ${(e as Error).message}`);
    }
    // NOTIFICACIONES-1 · las notificaciones duran 90 días (más que el registro técnico:
    // «¿quién me escribió el mes pasado?» es una pregunta de negocio).
    try {
      const removed = await dbDeleteNotificationsOlderThan(90);
      if (removed > 0) console.log(`[db] notificaciones: ${removed} filas > 90 días borradas.`);
    } catch (e) {
      console.warn(`[db] retención de notificaciones falló: ${(e as Error).message}`);
    }
    // Purga del dedup de comentarios entrantes (_ig_comment/_fb_comment de los
    // webhooks de Meta + __ytpoll/__lipoll de los pollers de YouTube/LinkedIn):
    // los reintentos de Meta ocurren en minutos/horas y los pollers solo miran
    // comentarios de las últimas 48h, así que >30 días es basura. Sin esto los
    // pollers dejaban una fila por comentario visto, para siempre.
    // NO toca el dedup real oncePerUser (automation_id = UUID de la automatización).
    try {
      const rc = await dbPurgeCommentDedup(30);
      if (rc > 0) console.log(`[db] comment-dedup retention: ${rc} filas > 30 días borradas.`);
    } catch (e) {
      console.warn(`[db] comment-dedup retention falló: ${(e as Error).message}`);
    }
    // FLOW-LOGS · retención 90 días: el registro es por-paso-por-contacto y sin tope
    // crecería para siempre. 90 días cubre de sobra cualquier análisis de campaña.
    try {
      const fe = await pool!.query("DELETE FROM app_flow_events WHERE at < now() - interval '90 days'");
      await pool!.query("DELETE FROM app_modo_events WHERE at < now() - interval '90 days'"); // BAN-04-FIN
      if ((fe.rowCount ?? 0) > 0) console.log(`[db] flow-logs retention: ${fe.rowCount} eventos > 90 días borrados.`);
    } catch (e) {
      console.warn(`[db] flow-logs retention falló: ${(e as Error).message}`);
    }
    // ANALÍTICA WEB · retención 13 meses (criterio AEPD/CNIL para medición de audiencia):
    // permite comparar año contra año y no acumular datos de visitantes para siempre.
    try {
      const pv = await pool!.query("DELETE FROM app_page_views WHERE created_at < now() - interval '13 months'");
      if ((pv.rowCount ?? 0) > 0) console.log(`[db] web-analytics retention: ${pv.rowCount} vistas > 13 meses borradas.`);
    } catch (e) {
      console.warn(`[db] web-analytics retention falló: ${(e as Error).message}`);
    }
    // ============================================================
    // WS-LIFECYCLE · PURGA PROGRAMADA de workspaces archivados cuya retención
    // ya venció. APAGADA por defecto: borrar los datos de un cliente jamás debe
    // pasar por sorpresa. Con WORKSPACE_AUTO_PURGE=1 el operador la enciende.
    // Aun encendida respeta TODOS los gates de dbPurgeWorkspace (archivado,
    // retención vencida y export previo): si falta alguno, no purga y lo dice.
    // ============================================================
    if (String(process.env.WORKSPACE_AUTO_PURGE || "").trim() === "1") {
      try {
        const pend = await dbListWorkspacesPendingPurge();
        for (const w of pend) {
          const res = await dbPurgeWorkspace(w.id, { actor: "auto-purge", requireExport: true });
          if (res.ok) console.warn(`[db] auto-purga ws=${w.id} "${w.label}": ${res.total ?? 0} filas borradas.`);
          else console.warn(`[db] auto-purga ws=${w.id} "${w.label}" NO ejecutada: ${res.error ?? "motivo desconocido"}`);
        }
      } catch (e) {
        console.warn(`[db] auto-purga falló: ${(e as Error).message}`);
      }
    }
  }, 24 * 3600 * 1000);
}

/** Borra el dedup de comentarios entrantes más viejo que `days` días: el de los
 *  webhooks de Meta (_ig_comment/_fb_comment) y el de los pollers de YouTube y
 *  LinkedIn (__ytpoll/__lipoll). No afecta al dedup oncePerUser (que usa el UUID real). */
export async function dbPurgeCommentDedup(days: number): Promise<number> {
  if (!pool) return 0;
  const r = await pool.query(
    "DELETE FROM app_automation_log WHERE automation_id IN ('_ig_comment','_fb_comment','__ytpoll','__lipoll') AND created_at < now() - ($1 || ' days')::interval",
    [String(Math.max(1, Math.floor(days)))],
  );
  return r.rowCount ?? 0;
}

// ---- Settings ----
// Tras W7 settings.ts vive en namespaces: '_global_' (keys compartidas por
// todos los workspaces) + tenant_id real para keys per-workspace. Los
// helpers legacy (dbGetSetting/dbAllSettings/dbSetSetting) mantienen la
// semántica original (tenant_id='default') para que cualquier caller que
// no se haya migrado aún no se rompa. Los nuevos helpers terminados en
// "WithTenant" / "ForTenant" son los que usa settings.ts ya ws-aware.
/**
 * W11 fix: ORDER BY prioritario para namespace '_global_'.
 *
 * Tras la migración workspaces_v1_global_keys (W10), las GLOBAL_KEYS viven
 * en tenant_id='_global_'. Pero el guard NOT EXISTS de la migración deja
 * intacta cualquier fila previa con tenant_id='default' si '_global_' ya
 * existía (rollback parcial, re-deploy, insert manual). Resultado: dos
 * filas para la misma key — una en 'default' y otra en '_global_'.
 *
 * Antes esto era invisible porque dbGetSetting/dbAllSettings filtraban
 * solo por tenant_id='default' → la fila '_global_' (la correcta tras
 * W10) quedaba ignorada y el caller leía el valor stale de 'default'.
 *
 * Fix: aceptamos ambos namespaces en el SELECT y ordenamos con CASE
 * WHEN tenant_id='_global_' THEN 0 ELSE 1 END → '_global_' siempre
 * gana. LIMIT 1 (dbGetSetting) o DISTINCT ON (dbAllSettings) garantizan
 * que solo veamos un valor por key.
 *
 * Semántica preservada para callers actuales (que ya usaban estos
 * helpers contra GLOBAL_KEYS sin saberlo): siguen leyendo el mismo
 * valor que loadSettings() cachea internamente.
 */
export async function dbGetSetting(key: string) {
  if (!pool) {
    // mem: prioriza '_global_' sobre 'default' si ambos existen.
    const g = mem.settings.get(`_global_|${key}`);
    if (g) return { value: g.value, is_secret: g.is_secret };
    const v = mem.settings.get(`default|${key}`);
    return v ? { value: v.value, is_secret: v.is_secret } : null;
  }
  const r = await pool.query(
    `SELECT value, is_secret FROM app_settings
     WHERE key=$1 AND tenant_id IN ('_global_','default')
     ORDER BY CASE WHEN tenant_id='_global_' THEN 0 ELSE 1 END
     LIMIT 1`,
    [key],
  );
  return (r.rows[0] as { value: string; is_secret: boolean }) ?? null;
}
export async function dbAllSettings() {
  if (!pool) {
    // mem: si la misma key existe en 'default' y '_global_', gana '_global_'.
    const merged = new Map<string, { value: string; is_secret: boolean }>();
    // Primero default (cae como fallback), luego _global_ (gana).
    for (const [k, v] of mem.settings) {
      if (v.tenant_id !== "default") continue;
      const key = k.split("|").slice(1).join("|");
      merged.set(key, { value: v.value, is_secret: v.is_secret });
    }
    for (const [k, v] of mem.settings) {
      if (v.tenant_id !== "_global_") continue;
      const key = k.split("|").slice(1).join("|");
      merged.set(key, { value: v.value, is_secret: v.is_secret });
    }
    return [...merged.entries()].map(([key, v]) => ({ key, value: v.value, is_secret: v.is_secret }));
  }
  // SQL: DISTINCT ON (key) + ORDER BY prioridad '_global_' → 1 fila por key.
  const r = await pool.query(
    `SELECT DISTINCT ON (key) key, value, is_secret
       FROM app_settings
      WHERE tenant_id IN ('_global_','default')
      ORDER BY key, CASE WHEN tenant_id='_global_' THEN 0 ELSE 1 END`,
  );
  return r.rows as { key: string; value: string; is_secret: boolean }[];
}
export async function dbSetSetting(key: string, value: string, isSecret: boolean) {
  if (!pool) return void mem.settings.set(`default|${key}`, { value, is_secret: isSecret, tenant_id: "default" });
  await pool.query(
    `INSERT INTO app_settings (tenant_id,key,value,is_secret,updated_at) VALUES ('default',$1,$2,$3,now())
     ON CONFLICT (tenant_id,key) DO UPDATE SET value=$2, is_secret=$3, updated_at=now()`,
    [key, value, isSecret],
  );
}

/**
 * Settings (multi-tenant, vista cruda). Devuelve TODAS las filas con su
 * tenant_id para que settings.ts pueda llenar la cache global vs per-ws
 * en una sola query. Incluye filas del namespace pseudo-tenant '_global_'.
 */
export async function dbAllSettingsWithTenant() {
  if (!pool) {
    return [...mem.settings].map(([k, v]) => ({
      key: k.split("|").slice(1).join("|"),
      value: v.value,
      is_secret: v.is_secret,
      tenant_id: v.tenant_id,
    }));
  }
  const r = await pool.query(
    "SELECT key, value, is_secret, tenant_id FROM app_settings ORDER BY tenant_id, key",
  );
  return r.rows as { key: string; value: string; is_secret: boolean; tenant_id: string }[];
}

/**
 * Settings (multi-tenant, escritura por tenant explícito). Usado por
 * settings.ts cuando ya conoce el namespace ('_global_' para keys globales,
 * tenant_id real para las per-ws). Idempotente vía ON CONFLICT (tenant_id, key).
 */
export async function dbSetSettingForTenant(
  tenantId: string,
  key: string,
  value: string,
  isSecret: boolean,
) {
  const tid = (tenantId || "").trim() || "default";
  if (!pool) return void mem.settings.set(`${tid}|${key}`, { value, is_secret: isSecret, tenant_id: tid });
  await pool.query(
    `INSERT INTO app_settings (tenant_id,key,value,is_secret,updated_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (tenant_id,key) DO UPDATE SET value=$3, is_secret=$4, updated_at=now()`,
    [tid, key, value, isSecret],
  );
}

// ---- Conversations ----
/* ============================================================
 * MEDIA-BANDEJA-1 · Adjuntos entrantes (bytes re-hospedados).
 * El aislamiento va en el SQL (tenant_id), como dbGetConversation: nunca a mano
 * en el handler.
 * ============================================================ */
export interface InboxMedia {
  id: string;
  kind: string;
  content_type: string;
  size_bytes: number;
  data: Buffer | null;
  fail_reason: string;
  /** ADJUNTO-REINTENTO-1 · ver la columna en initDb. */
  retry_ref?: string;
}

export async function dbPutInboxMedia(m: {
  id: string;
  user_id: string;
  source: string;
  kind: string;
  content_type: string;
  data: Buffer | null;
  fail_reason?: string;
  retry_ref?: string;
}): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    // PLANTILLA-CABECERA-1 · en memoria también se guarda: los arneses recorren la cadena.
    mem.inboxMedia.set(m.id, { id: m.id, kind: m.kind, content_type: m.content_type, size_bytes: m.data?.length || 0, data: m.data, fail_reason: m.fail_reason || "", retry_ref: m.retry_ref || "", source: m.source, tenant: tenantId, user_id: m.user_id } as any);
    if (mem.inboxMedia.size > 200) { const k = mem.inboxMedia.keys().next().value; if (k) mem.inboxMedia.delete(k); }
    return;
  }
  await pool.query(
    `INSERT INTO app_inbox_media (id,tenant_id,user_id,source,kind,content_type,size_bytes,data,fail_reason,retry_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO NOTHING`,
    [
      m.id,
      tenantId,
      m.user_id,
      m.source,
      m.kind,
      m.content_type || "application/octet-stream",
      m.data ? m.data.length : 0,
      m.data,
      m.fail_reason || "",
      m.retry_ref || "",
    ],
  );
}

/** ADJUNTO-REINTENTO-1 · Rellena un adjunto cuya descarga falló al llegar. Con
 *  fail_reason (sin bytes) sólo apunta el motivo nuevo y, si se pasa, cambia
 *  retry_ref (vacío = ya no se puede reintentar). Acotado por tenant, como la lectura. */
export async function dbFillInboxMedia(
  id: string,
  r: { data: Buffer; content_type: string } | { fail_reason: string; retry_ref?: string },
): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const m = mem.inboxMedia.get(id);
    if (!m || m.tenant !== tenantId) return;
    if ("data" in r) Object.assign(m, { data: r.data, content_type: r.content_type, size_bytes: r.data.length, fail_reason: "", retry_ref: "" });
    else Object.assign(m, { fail_reason: r.fail_reason, ...(r.retry_ref !== undefined ? { retry_ref: r.retry_ref } : {}) });
    return;
  }
  if ("data" in r)
    await pool.query(
      `UPDATE app_inbox_media SET data=$3, content_type=$4, size_bytes=$5, fail_reason='', retry_ref=''
        WHERE id=$1 AND tenant_id=$2`,
      [id, tenantId, r.data, r.content_type || "application/octet-stream", r.data.length],
    );
  else
    await pool.query(
      `UPDATE app_inbox_media SET fail_reason=$3, retry_ref=COALESCE($4, retry_ref)
        WHERE id=$1 AND tenant_id=$2 AND data IS NULL`,
      [id, tenantId, r.fail_reason, r.retry_ref ?? null],
    );
}

/** FOTO-PERFIL-1 · Guarda los BYTES de la foto de perfil de un contacto.
 *  Las URLs de foto de Meta son CDN firmado que CADUCA (horas): si solo
 *  guardábamos la URL, el avatar acababa roto y salía el monograma. Aquí se
 *  reutiliza app_inbox_media con un id determinista por contacto, y se ACTUALIZA
 *  (no DO NOTHING) para poder refrescarla cuando el usuario cambie de foto. */
// FOTO-CONTACTO-1 · manual=true es la foto que sube una persona desde la ficha: va con
// source='manual' y el refresco automático desde Meta ya no la pisa (dbAvatarAge la da
// por recién puesta y el UPDATE de abajo no toca una fila manual con una foto de Meta).
export async function dbPutAvatar(userId: string, data: Buffer, contentType: string, manual = false): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) return false;
  const id = 'av:' + tenantId + ':' + userId;
  await pool.query(
    `INSERT INTO app_inbox_media (id,tenant_id,user_id,source,kind,content_type,size_bytes,data,fail_reason)
     VALUES ($1,$2,$3,$7,'avatar',$4,$5,$6,'')
     ON CONFLICT (id) DO UPDATE SET source=EXCLUDED.source, content_type=EXCLUDED.content_type, size_bytes=EXCLUDED.size_bytes, data=EXCLUDED.data, created_at=now()
     WHERE app_inbox_media.tenant_id=EXCLUDED.tenant_id AND (EXCLUDED.source='manual' OR app_inbox_media.source<>'manual')`,
    [id, tenantId, userId, contentType || 'image/jpeg', data.length, data, manual ? 'manual' : 'profile'],
  );
  return true;
}
/** FOTO-CONTACTO-1 · quita la foto guardada de un contacto (manual o de Meta). */
export async function dbDeleteAvatar(userId: string): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) return;
  await pool.query(`DELETE FROM app_inbox_media WHERE id=$1 AND tenant_id=$2 AND kind='avatar'`, ['av:' + tenantId + ':' + userId, tenantId]);
}
// ── MARCA-EDITABLE-1 · logo del negocio, por tenant ────────────────────────────────
// Mismo almacén binario que las fotos de contacto. El id lleva el tenant y todas las
// consultas lo acotan: el logo de un negocio jamás se ve desde otro.
const logoId = (tenantId: string) => "logo:" + tenantId;

/** Guarda (o sustituye) el logo del workspace activo. Devuelve la versión (ms) para
 *  romper la caché del navegador. En memoria (tests) se guarda en un mapa. */
const memLogos = new Map<string, { data: Buffer; content_type: string; at: number }>();
export async function dbPutLogo(data: Buffer, contentType: string): Promise<number> {
  const tenantId = currentWorkspaceId();
  const at = Date.now();
  if (!pool) { memLogos.set(tenantId, { data, content_type: contentType, at }); return at; }
  await pool.query(
    `INSERT INTO app_inbox_media (id,tenant_id,user_id,source,kind,content_type,size_bytes,data,fail_reason)
     VALUES ($1,$2,'','brand','logo',$3,$4,$5,'')
     ON CONFLICT (id) DO UPDATE SET content_type=EXCLUDED.content_type, size_bytes=EXCLUDED.size_bytes, data=EXCLUDED.data, created_at=now()`,
    [logoId(tenantId), tenantId, contentType || "image/png", data.length, data],
  );
  return at;
}
export async function dbGetLogo(): Promise<{ data: Buffer; content_type: string; at: number } | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) return memLogos.get(tenantId) || null;
  const r = await pool.query(
    "SELECT data, content_type, EXTRACT(EPOCH FROM created_at)*1000 AS at FROM app_inbox_media WHERE id=$1 AND tenant_id=$2 AND kind='logo'",
    [logoId(tenantId), tenantId],
  );
  const row = r.rows[0];
  return row ? { data: row.data as Buffer, content_type: String(row.content_type || "image/png"), at: Number(row.at || 0) } : null;
}
export async function dbDeleteLogo(): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) { memLogos.delete(tenantId); return; }
  await pool.query("DELETE FROM app_inbox_media WHERE id=$1 AND tenant_id=$2 AND kind='logo'", [logoId(tenantId), tenantId]);
}
// ── AVATAR-USUARIO-1 · foto de la PERSONA que entra al panel ─────────────────────────
// Es de la persona, no del negocio: la misma en todos sus workspaces. Por eso el tenant es
// fijo y la clave lleva el id del usuario (o «env-admin»), que sale siempre de la sesión.
const AVATAR_TENANT = "__usuario__";
const avatarId = (uid: string) => "uavatar:" + uid;
const memAvatars = new Map<string, { data: Buffer; content_type: string; at: number }>();
export async function dbPutUserAvatar(uid: string, data: Buffer, contentType: string): Promise<number> {
  const at = Date.now();
  if (!pool) { memAvatars.set(uid, { data, content_type: contentType, at }); return at; }
  await pool.query(
    `INSERT INTO app_inbox_media (id,tenant_id,user_id,source,kind,content_type,size_bytes,data,fail_reason)
     VALUES ($1,$2,$3,'user','user_avatar',$4,$5,$6,'')
     ON CONFLICT (id) DO UPDATE SET content_type=EXCLUDED.content_type, size_bytes=EXCLUDED.size_bytes, data=EXCLUDED.data, created_at=now()`,
    [avatarId(uid), AVATAR_TENANT, uid, contentType || "image/jpeg", data.length, data],
  );
  return at;
}
export async function dbGetUserAvatar(uid: string): Promise<{ data: Buffer; content_type: string; at: number } | null> {
  if (!pool) return memAvatars.get(uid) || null;
  const r = await pool.query(
    "SELECT data, content_type, EXTRACT(EPOCH FROM created_at)*1000 AS at FROM app_inbox_media WHERE id=$1 AND tenant_id=$2 AND kind='user_avatar'",
    [avatarId(uid), AVATAR_TENANT],
  );
  const row = r.rows[0];
  return row ? { data: row.data as Buffer, content_type: String(row.content_type || "image/jpeg"), at: Number(row.at || 0) } : null;
}
/** Solo la versión (sin los bytes): para pintar la cabecera sin descargar la foto. */
export async function dbGetUserAvatarVersion(uid: string): Promise<number> {
  if (!pool) return memAvatars.get(uid)?.at || 0;
  const r = await pool.query(
    "SELECT EXTRACT(EPOCH FROM created_at)*1000 AS at FROM app_inbox_media WHERE id=$1 AND tenant_id=$2 AND kind='user_avatar'",
    [avatarId(uid), AVATAR_TENANT],
  );
  return Number(r.rows[0]?.at || 0);
}
export async function dbDeleteUserAvatar(uid: string): Promise<void> {
  if (!pool) { memAvatars.delete(uid); return; }
  await pool.query("DELETE FROM app_inbox_media WHERE id=$1 AND tenant_id=$2 AND kind='user_avatar'", [avatarId(uid), AVATAR_TENANT]);
}
/** Versión del logo de CADA tenant que tenga uno, para pintarla en la página sin esperar
 *  a la base de datos (page() es síncrona). Se lee una vez al arrancar y se actualiza al
 *  subir o quitar; ver logoVersions en admin.ts. */
export async function dbListLogoVersions(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!pool) { for (const [t, v] of memLogos) out.set(t, v.at); return out; }
  const r = await pool.query("SELECT tenant_id, EXTRACT(EPOCH FROM created_at)*1000 AS at FROM app_inbox_media WHERE kind='logo'");
  for (const row of r.rows) out.set(String(row.tenant_id), Number(row.at || 0));
  return out;
}

/** Foto cacheada de un contacto (o null si nunca se pudo guardar). */
export async function dbGetAvatar(userId: string): Promise<{ data: Buffer; content_type: string } | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) return null;
  const r = await pool.query(
    `SELECT content_type, data FROM app_inbox_media WHERE id=$1 AND tenant_id=$2`,
    ['av:' + tenantId + ':' + userId, tenantId],
  );
  const row = r.rows[0];
  return row && row.data ? { data: row.data as Buffer, content_type: String(row.content_type || 'image/jpeg') } : null;
}
/** ¿De cuándo es la foto cacheada? (para refrescarla de vez en cuando). */
export async function dbAvatarAge(userId: string): Promise<number | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) return null;
  const r = await pool.query(
    `SELECT extract(epoch from created_at)*1000 AS ts, source FROM app_inbox_media WHERE id=$1 AND tenant_id=$2`,
    ['av:' + tenantId + ':' + userId, tenantId],
  );
  const row = r.rows[0];
  if (row && row.source === 'manual') return 0; // FOTO-CONTACTO-1 · la puesta a mano nunca «caduca»
  return row ? Date.now() - Number(row.ts) : null;
}
export async function dbGetInboxMedia(id: string): Promise<InboxMedia | null> {
  const tenantId = currentWorkspaceId();
  // BANDEJA-FIX-1 · dbPutInboxMedia SÍ guardaba en memoria y esto devolvía null: la
  // mitad de la cadena estaba muerta y ningún arnés podía comprobar que un adjunto se
  // descarga por su ruta. Mismo filtro por tenant que la consulta SQL.
  if (!pool) {
    const m = mem.inboxMedia.get(id);
    return m && m.tenant === tenantId ? m : null;
  }
  const r = await pool.query(
    `SELECT id, kind, content_type, size_bytes, data, fail_reason, retry_ref
       FROM app_inbox_media WHERE id=$1 AND tenant_id=$2`,
    [id, tenantId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    kind: String(row.kind || ""),
    content_type: String(row.content_type || "application/octet-stream"),
    size_bytes: Number(row.size_bytes || 0),
    data: row.data ?? null,
    fail_reason: String(row.fail_reason || ""),
    retry_ref: String(row.retry_ref || ""),
  };
}

/** Adjunto de un PASO DE FLUJO. Sin tenant a propósito: lo descarga Meta sin
 *  cookie y lo carga el motor fuera de una request; el control de acceso es la
 *  entropía del id (UUID v4), el mismo modelo que el hosting efímero del inbox.
 *  SOLO sirve filas source='flow': los adjuntos de la Bandeja siguen detrás de
 *  su ruta con sesión. */
export async function dbGetFlowMedia(id: string): Promise<InboxMedia | null> {
  if (!pool) {
    const m = mem.inboxMedia.get(id);
    return m && m.source === "flow" ? m : null;
  }
  const r = await pool.query(
    `SELECT id, kind, content_type, size_bytes, data, fail_reason
       FROM app_inbox_media WHERE id=$1 AND source='flow'`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    kind: String(row.kind || ""),
    content_type: String(row.content_type || "application/octet-stream"),
    size_bytes: Number(row.size_bytes || 0),
    data: row.data ?? null,
    fail_reason: String(row.fail_reason || ""),
  };
}

/** FORMULARIOS-8 · imagen o vídeo de una pregunta de formulario. Sin tenant, como el adjunto
 *  de flujo: lo pide el navegador de quien responde, sin sesión; el control de acceso es la
 *  entropía del id (UUID v4). SOLO sirve filas source='form'. */
export async function dbGetFormMedia(id: string): Promise<InboxMedia | null> {
  if (!pool) {
    const m = mem.inboxMedia.get(id);
    return m && m.source === "form" ? m : null;
  }
  const r = await pool.query(
    "SELECT id, kind, content_type, size_bytes, data, fail_reason FROM app_inbox_media WHERE id=$1 AND source='form'",
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    kind: String(row.kind || ""),
    content_type: String(row.content_type || "application/octet-stream"),
    size_bytes: Number(row.size_bytes || 0),
    data: row.data ?? null,
    fail_reason: String(row.fail_reason || ""),
  };
}

/** FORM-ARCHIVO-1 · archivo que adjuntó quien responde (source='form-resp', user_id = id del
 *  formulario). Sin ámbito de workspace: lo pide /f/a/<id> y el envío lo cruza con su formulario. */
export async function dbGetFormRespMedia(id: string): Promise<(InboxMedia & { form_id: string; tenant: string }) | null> {
  if (!pool) {
    const m = mem.inboxMedia.get(id) as any;
    return m && m.source === "form-resp" ? { ...m, form_id: String(m.user_id || ""), tenant: String(m.tenant || "") } : null;
  }
  const r = await pool.query(
    "SELECT id, tenant_id, user_id, kind, content_type, size_bytes, data FROM app_inbox_media WHERE id=$1 AND source='form-resp'",
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: String(row.id), kind: String(row.kind || ""), content_type: String(row.content_type || "application/octet-stream"),
    size_bytes: Number(row.size_bytes || 0), data: row.data ?? null, fail_reason: "",
    form_id: String(row.user_id || ""), tenant: String(row.tenant_id || ""),
  };
}

/** Purga adjuntos viejos: los turnos se recortan a MAX_TURNS y dejan filas huérfanas. */
export async function dbPurgeInboxMedia(days = 90): Promise<number> {
  if (!pool) return 0;
  const r = await pool.query(
    // source='flow' NO se purga: es el adjunto de un paso de flujo y tiene que
    // seguir ahí mientras el flujo viva — un flujo de hace 4 meses sigue enviando.
    // MARCA-EDITABLE-1 · source='brand' es el logo del negocio: tampoco se purga.
    // FORMULARIOS-8 · source='form' es la imagen o el vídeo de una pregunta: vive lo que el formulario.
    // FORM-ARCHIVO-1 · source='form-resp' es lo que adjuntó quien responde: vive lo que su respuesta.
    `DELETE FROM app_inbox_media WHERE created_at < now() - ($1 || ' days')::interval AND source NOT IN ('flow','brand','form','form-resp')`,
    [String(Math.max(1, days))],
  );
  return r.rowCount ?? 0;
}

/**
 * CHAT-ABRIR-1 (CTO-02) · De una página de contactos, quiénes tienen conversación de
 * verdad (al menos un mensaje) en el negocio activo. Contactos decide con esto si la
 * fila ofrece «Abrir conversación» o «Enviar mensaje»: last_inbound no basta, porque
 * un hilo borrado deja la fecha y un primer mensaje nuestro deja hilo sin fecha.
 */
export async function dbConConversacion(userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.map((x) => String(x || "")).filter(Boolean))];
  const out = new Set<string>();
  if (!ids.length) return out;
  const tenantId = currentWorkspaceId();
  if (!pool) {
    for (const id of ids) {
      const c = mem.conversations.get(contactMemKey(id));
      if (!c || ((c as { tenant_id?: string }).tenant_id || "default") !== tenantId) continue;
      if (Array.isArray((c as { turns?: unknown[] }).turns) && (c as { turns: unknown[] }).turns.length) out.add(id);
    }
    return out;
  }
  const r = await pool.query(
    "SELECT user_id FROM app_conversations WHERE tenant_id=$1 AND user_id = ANY($2::text[]) AND jsonb_array_length(turns) > 0",
    [tenantId, ids],
  );
  for (const row of r.rows) out.add(String(row.user_id));
  return out;
}

export async function dbGetConversation(userId: string) {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const c = mem.conversations.get(contactMemKey(userId));
    if (!c) return null;
    return ((c as { tenant_id?: string }).tenant_id || "default") === tenantId ? c : null;
  }
  const r = await pool.query(
    "SELECT bot_id, turns, extract(epoch from updated_at)*1000 AS updated_at FROM app_conversations WHERE user_id=$1 AND tenant_id=$2",
    [userId, tenantId],
  );
  if (!r.rows[0]) return null;
  return { bot_id: r.rows[0].bot_id, turns: r.rows[0].turns, updated_at: Number(r.rows[0].updated_at) };
}
/** CHAT-POR-NUMERO-1 · resumen por cuenta ('wa:<pid>' | '' sin sellar) de una conversación:
 *  cuántos turnos, el último turno y el último turno DEL CLIENTE de cada grupo. */
export interface ConvAcctSummary { n: number; at: number; role: string; text: string; uat: number; utext: string }
/** Recorta SIN partir un emoji: .slice() corta por unidades UTF-16 y un par
 *  sustituto partido genera un escape \uD8xx suelto que el jsonb de Postgres
 *  RECHAZA — el INSERT de la conversación entera fallaría SOLO en producción
 *  (en memoria no hay jsonb). Cazado por la revisión adversaria del 2-sep. */
function cortaSeguro(s: string, n: number): string {
  const out = s.slice(0, n);
  const c = out.charCodeAt(out.length - 1);
  return c >= 0xd800 && c <= 0xdbff ? out.slice(0, -1) : out;
}
export function acctsSummary(turns: unknown[]): Record<string, ConvAcctSummary> {
  const out: Record<string, ConvAcctSummary> = {};
  for (const raw of Array.isArray(turns) ? turns : []) {
    const t = (raw || {}) as { acct?: unknown; at?: unknown; role?: unknown; content?: unknown };
    const key = String(t.acct || "");
    const g = out[key] || (out[key] = { n: 0, at: 0, role: "", text: "", uat: 0, utext: "" });
    g.n++;
    g.at = Number(t.at || 0) || g.at;
    g.role = String(t.role || "");
    g.text = cortaSeguro(String(t.content || ""), 140);
    if (g.role === "user") { g.uat = g.at; g.utext = g.text; }
  }
  return out;
}
/** CHAT-POR-NUMERO-1 · Backfill ÚNICO del resumen accts para las conversaciones de
 *  ANTES del despliegue: sus turnos ya llevan acct (T02 lo sella desde el 26-ago) pero
 *  su columna accts nació vacía, así que la Bandeja no podía partirlas en un chat por
 *  número hasta que recibieran un mensaje nuevo — visto en producción con Iskandar.
 *
 *  Reglas duras:
 *  - SOLO Postgres: en memoria no existen filas viejas (la BD nace vacía en cada boot).
 *  - Corre DESPUÉS de app.listen, fire-and-forget: jamás toca el arranque ni el
 *    healthcheck (la trampa clásica de las migraciones que tumban solo producción).
 *  - Cruza tenants A PROPÓSITO pero solo recalcula la columna derivada de cada fila
 *    con SUS propios turns: ningún dato sale de su fila ni de su tenant.
 *  - Idempotente y auto-terminante: la fila actualizada deja de casar con el WHERE
 *    (si el resumen saliera vacío por turns malformados, se escribe un centinela
 *    inofensivo para no re-escanearla en cada boot).
 *  - Sin dbNotify ni updated_at: no reordena la Bandeja ni dispara 2.000 SSE. */
export async function dbBackfillConvAccts(): Promise<{ updated: number }> {
  if (!pool) return { updated: 0 };
  let updated = 0;
  for (let guard = 0; guard < 60; guard++) {
    const r = await pool.query(
      `SELECT tenant_id, user_id, turns FROM app_conversations
       WHERE accts = '{}'::jsonb AND turns::text LIKE '%"acct"%' LIMIT 100`,
    );
    if (!r.rows.length) break;
    for (const row of r.rows) {
      const accts = acctsSummary(Array.isArray(row.turns) ? row.turns : []);
      const val = Object.keys(accts).length ? accts : { "": { n: 0, at: 0, role: "", text: "", uat: 0, utext: "" } };
      // AND accts='{}': si un mensaje llegó ENTRE el SELECT y este UPDATE,
      // dbSaveConversation ya escribió un resumen más fresco — no se pisa.
      await pool.query(
        "UPDATE app_conversations SET accts=$3 WHERE tenant_id=$1 AND user_id=$2 AND accts='{}'::jsonb",
        [row.tenant_id, row.user_id, JSON.stringify(val)],
      );
      convInvalidar(String(row.tenant_id)); // BANDEJA-CACHE-1
      updated++;
    }
    await new Promise((res) => setTimeout(res, 100)); // pacing: no acaparar el pool
  }
  return { updated };
}
/** PLANTILLA-REPARA-1 · Conversaciones con turnos del formato legacy
 *  «🧩 Plantilla · nombre» (guardados ANTES de PLANTILLA-BANDEJA-1, cuando el texto
 *  real de la plantilla no se persistía). Solo Postgres: en memoria no hay legado. */
export async function dbScanLegacyTplConvs(cap = 3000): Promise<Array<{ tenant_id: string; user_id: string }>> {
  if (!pool) return [];
  const r = await pool.query(
    "SELECT tenant_id, user_id FROM app_conversations WHERE turns::text LIKE '%🧩 Plantilla · %' LIMIT $1",
    [cap],
  );
  return r.rows.map((x) => ({ tenant_id: String(x.tenant_id), user_id: String(x.user_id) }));
}

/** PLANTILLA-REPARA-1 · Reescritura de los turns de UNA conversación con bloqueo
 *  optimista por updated_at: si alguien escribió entre la lectura y el UPDATE, no se
 *  toca nada (el barrido lo reintenta en el próximo arranque). El tenant va EXPLÍCITO
 *  a propósito — el barrido cruza tenants, pero cada fila se transforma solo con sus
 *  propios turns y el resumen accts se recalcula del resultado. El rewriter devuelve
 *  null para «sin cambios». */
export async function dbRewriteConversationTurns(
  tenantId: string,
  userId: string,
  rewriter: (turns: unknown[]) => unknown[] | null,
): Promise<boolean> {
  // BANDEJA-FIX-2 · el modo en memoria (sin DATABASE_URL: dev local, y los arneses de
  // prueba que arrancan un servidor real "sin red") se había quedado sin este camino
  // de escritura — devolvía false siempre, así que PLANTILLA-REPARA-1 y cualquier
  // barrido que reutilice este rewriter no hacían NADA fuera de Postgres. Mismo
  // contrato que la rama de pool: bloqueo optimista por `updated_at` (aquí, que no
  // haya cambiado el objeto entre leer y escribir) y SIN tocar `updated_at`: no
  // reordena la Bandeja ni dispara notificaciones por una reescritura de fondo.
  if (!pool) {
    const key = contactMemKey(userId, tenantId);
    const cv = mem.conversations.get(key);
    if (!cv || ((cv as { tenant_id?: string }).tenant_id || "default") !== tenantId) return false;
    const turnsPrevios = Array.isArray(cv.turns) ? (cv.turns as unknown[]) : [];
    const marcaPrevia = cv.updated_at;
    const nuevos = rewriter(turnsPrevios);
    if (!nuevos) return false;
    const actual = mem.conversations.get(key);
    if (!actual || actual.updated_at !== marcaPrevia) return false; // alguien escribió entre medias
    actual.turns = nuevos;
    actual.accts = acctsSummary(nuevos);
    return true;
  }
  const r = await pool.query(
    "SELECT turns, updated_at::text AS ua FROM app_conversations WHERE tenant_id=$1 AND user_id=$2",
    [tenantId, userId],
  );
  if (!r.rows[0]) return false;
  const turns = Array.isArray(r.rows[0].turns) ? (r.rows[0].turns as unknown[]) : [];
  const nuevos = rewriter(turns);
  if (!nuevos) return false;
  const u = await pool.query(
    "UPDATE app_conversations SET turns=$3, accts=$4 WHERE tenant_id=$1 AND user_id=$2 AND updated_at=$5::timestamptz",
    [tenantId, userId, JSON.stringify(nuevos), JSON.stringify(acctsSummary(nuevos)), r.rows[0].ua],
  );
  return (u.rowCount || 0) > 0;
}

/**
 * NUM-RETIRADO-1 · Re-adopta el histórico de un número retirado por el número NUEVO que
 * atiende ese mismo teléfono. Es lo que hace limpia la transición de Meta a QR (o al
 * revés): sin esto, las conversaciones de antes se quedan atadas a un identificador que
 * ya no existe y la vista por número parte el hilo en dos.
 *
 * Toca las tres cosas que guardan la cuenta: el contacto, su registro de ventanas por
 * número y el `acct` sellado dentro de cada turno. Va acotada al workspace activo.
 */
export async function dbAdoptarCuenta(
  oldAcct: string,
  newAcct: string,
  /** ECO-UNIFICADO-3 · deduplicador (memory.ts → depurarDuplicadosDeTurnos) que se aplica
   *  ANTES de re-sellar: parte de la señal de «mismo mensaje por dos vías» es que el acct
   *  difiera, y re-sellar primero la borraba. Sin él, dos copias del mismo mensaje que
   *  vivían en filas distintas (retirado y vivo) quedaban pegadas en el hilo reunido. */
  depurar?: (turns: unknown[]) => unknown[],
): Promise<{ contactos: number; conversaciones: number }> {
  const tenantId = currentWorkspaceId();
  if (!oldAcct || !newAcct || oldAcct === newAcct) return { contactos: 0, conversaciones: 0 };
  let contactos = 0;
  let conversaciones = 0;
  // Devuelve null si no hay nada que cambiar: así no se reescribe una fila por gusto.
  const reescribe = (turns: unknown[]): unknown[] | null => {
    const lista = Array.isArray(turns) ? turns : [];
    const base = depurar ? depurar(lista) : lista;
    let tocado = base.length !== lista.length;
    const nuevos = base.map((t) => {
      const x = (t || {}) as { acct?: unknown };
      if (String(x.acct || "") !== oldAcct) return t;
      tocado = true;
      return { ...(t as Record<string, unknown>), acct: newAcct };
    });
    return tocado ? nuevos : null;
  };
  if (!pool) {
    for (const c of mem.contacts.values()) {
      if (c.tenant_id !== tenantId) continue;
      let cambia = false;
      if (c.channel_account === oldAcct) { c.channel_account = newAcct; cambia = true; }
      const by = c.last_inbound_by || {};
      if (by[oldAcct] != null) {
        // Si por lo que sea ya hubiera ventana del número nuevo, gana la más reciente.
        by[newAcct] = Math.max(Number(by[newAcct] || 0), Number(by[oldAcct] || 0));
        delete by[oldAcct];
        c.last_inbound_by = by;
        cambia = true;
      }
      if (cambia) contactos++;
    }
    for (const cv of mem.conversations.values()) {
      if (cv.tenant_id !== tenantId) continue;
      const nuevos = reescribe(cv.turns);
      if (!nuevos) continue;
      cv.turns = nuevos;
      cv.accts = acctsSummary(nuevos);
      conversaciones++;
    }
    return { contactos, conversaciones };
  }
  const rc = await pool.query(
    "UPDATE app_contacts SET channel_account=$3, updated_at=now() WHERE tenant_id=$1 AND channel_account=$2",
    [tenantId, oldAcct, newAcct],
  );
  contactos = rc.rowCount || 0;
  await pool.query(
    `UPDATE app_contacts
        SET last_inbound_by = (last_inbound_by - $2::text)
              || jsonb_build_object($3::text, GREATEST(
                   COALESCE((last_inbound_by->>$3)::bigint, 0),
                   COALESCE((last_inbound_by->>$2)::bigint, 0))),
            updated_at = now()
      WHERE tenant_id=$1 AND last_inbound_by ? $2::text`,
    [tenantId, oldAcct, newAcct],
  );
  // El resumen `accts` es justo el índice que evita leer todas las conversaciones.
  const r = await pool.query(
    "SELECT user_id FROM app_conversations WHERE tenant_id=$1 AND accts ? $2::text",
    [tenantId, oldAcct],
  );
  for (const row of r.rows) {
    if (await dbRewriteConversationTurns(tenantId, String(row.user_id), reescribe)) conversaciones++;
  }
  return { contactos, conversaciones };
}

/**
 * ECO-UNIFICADO-2 · Cuentas `wa:<id>` que aparecen selladas en alguna conversación del
 * workspace. Sale del resumen `accts`, no de leer los turnos. La Bandeja lo usa para
 * detectar identificadores que ya no están dados de alta y fundirlos con el número vivo.
 */
export async function dbCuentasWaEnConversaciones(): Promise<string[]> {
  const tenantId = currentWorkspaceId();
  const out = new Set<string>();
  if (!pool) {
    for (const cv of mem.conversations.values()) {
      if ((cv.tenant_id || "default") !== tenantId) continue;
      for (const k of Object.keys(cv.accts || acctsSummary(cv.turns))) if (k.startsWith("wa:")) out.add(k);
    }
    return [...out];
  }
  const r = await pool.query(
    "SELECT DISTINCT jsonb_object_keys(accts) AS k FROM app_conversations WHERE tenant_id=$1 AND accts IS NOT NULL",
    [tenantId],
  );
  for (const row of r.rows) { const k = String(row.k || ""); if (k.startsWith("wa:")) out.add(k); }
  return [...out];
}

/**
 * ECO-UNIFICADO-2 · Borra las burbujas «[reaction]» que dejaron los ecos del móvil antes
 * de ECO-UNIFICADO-1 (hoy una reacción del dueño se guarda como reacción, no como turno).
 * Solo toca turnos del asistente con ese texto exacto; devuelve conversaciones tocadas.
 */
export async function dbBorrarBurbujasReaccion(): Promise<number> {
  const tenantId = currentWorkspaceId();
  const esBasura = (t: unknown): boolean => {
    const x = (t || {}) as { role?: unknown; content?: unknown };
    return String(x.role || "") === "assistant" && String(x.content || "").trim() === "[reaction]";
  };
  const limpia = (turns: unknown[]): unknown[] | null => {
    const lista = Array.isArray(turns) ? turns : [];
    const nuevos = lista.filter((t) => !esBasura(t));
    return nuevos.length === lista.length ? null : nuevos;
  };
  let tocadas = 0;
  const ids: string[] = [];
  if (!pool) {
    for (const cv of mem.conversations.values()) {
      if ((cv.tenant_id || "default") !== tenantId) continue;
      if ((Array.isArray(cv.turns) ? cv.turns : []).some(esBasura)) ids.push(String(cv.user_id));
    }
  } else {
    const r = await pool.query(
      `SELECT user_id FROM app_conversations
        WHERE tenant_id=$1
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(turns) t
                       WHERE t->>'role'='assistant' AND btrim(t->>'content')='[reaction]')`,
      [tenantId],
    );
    for (const row of r.rows) ids.push(String(row.user_id));
  }
  for (const id of ids) {
    if (await dbRewriteConversationTurns(tenantId, id, limpia)) tocadas++;
  }
  return tocadas;
}

const guardadosConv = new Map<string, Promise<unknown>>();
export async function dbSaveConversation(userId: string, botId: string, turns: unknown[]) {
  const tenantId = currentWorkspaceId();
  // CHAT-POR-NUMERO-1 · el resumen por cuenta se recalcula del array COMPLETO en cada
  // escritura (≤400 turnos, un solo pase): así una conversación antigua se "cura" sola
  // en cuanto recibe un mensaje nuevo, sin backfill.
  const accts = acctsSummary(turns);
  dbTocarBandeja(tenantId); // UNREAD-PROPIO-1
  if (!pool) {
    mem.conversations.set(contactMemKey(userId), { user_id: userId, bot_id: botId, turns, accts, updated_at: Date.now(), tenant_id: tenantId });
    return;
  }
  // SESION-CARRERA-1 (CTO-02) · los guardados de UNA conversación van en fila: dos
  // mensajes seguidos lanzaban dos escrituras por conexiones distintas del pool y podía
  // confirmarse la vieja después de la nueva (un mensaje perdido). Cada escritura toma la
  // foto del array al ejecutarse, así que la última de la fila lleva todo lo añadido.
  const clave = tenantId + ":" + userId;
  const job = (guardadosConv.get(clave) || Promise.resolve()).catch(() => {}).then(() => pool!.query(
    `INSERT INTO app_conversations (user_id,bot_id,turns,accts,tenant_id,updated_at) VALUES ($1,$2,$3,$5,$4,now())
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET bot_id=$2, turns=$3, accts=$5, tenant_id=$4, updated_at=now()`,
    [userId, botId, JSON.stringify(turns), tenantId, JSON.stringify(acctsSummary(turns))],
  ));
  guardadosConv.set(clave, job);
  try { await job; } finally { convInvalidar(tenantId); /* BANDEJA-CACHE-1 */ if (guardadosConv.get(clave) === job) guardadosConv.delete(clave); }
  // SSE-TENANT (T05 2026-08-25) · el payload lleva el tenant para que el
  // broadcast SSE del panel pueda filtrar por workspace (antes iba el teléfono
  // a secas y /admin/api/events lo reemitía a TODOS los navegadores conectados,
  // fuera cual fuera su workspace: un tenant veía los números de otro).
  void dbNotify("bstack_inbox", JSON.stringify({ tenant_id: tenantId, phone: userId }));
}

/** Emite un NOTIFY de Postgres → llega a TODAS las réplicas que escuchan (pub/sub real). */
export async function dbNotify(channel: string, payload = ""): Promise<void> {
  if (!pool) return;
  try { await pool.query("SELECT pg_notify($1,$2)", [channel, payload.slice(0, 7000)]); } catch { /* best effort */ }
}

/**
 * Conexión DEDICADA que escucha un canal y reconecta si cae (no usa el pool, que rota).
 *
 * SEC-3: devuelve una función `cleanup()` que el caller DEBE invocar al cerrar
 * para liberar la conexión `pg.Client`. Sin cleanup la conexión vive eternamente
 * (1 por cliente SSE) → agota el pool Postgres en horas (regresión observada
 * por council). El cleanup:
 *   - marca disposed=true (cancela cualquier reconnect en curso).
 *   - llama client.end() (best effort, no throw).
 * Backwards-compat: ignorar el valor devuelto sigue funcionando (caller que no
 * limpia se comporta como antes — fugaba). El call-site bstack_inbox vive el
 * proceso entero, así que NO necesita limpieza explícita.
 */
export function dbListen(channel: string, onMessage: (payload: string) => void): () => void {
  if (!url) return () => {}; // sin Postgres no hay pub/sub → noop cleanup
  let client: pg.Client | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    if (disposed) return;
    client = new pg.Client({
      connectionString: url,
      ssl: pgSsl(),
    });
    client.on("notification", (msg) => { if (msg.channel === channel) try { onMessage(msg.payload || ""); } catch { /* noop */ } });
    client.on("error", () => {
      try { client?.end().catch(() => {}); } catch { /* noop */ }
      client = null;
      if (disposed) return;
      reconnectTimer = setTimeout(connect, 3000);
    });
    client.connect()
      .then(() => client!.query(`LISTEN ${channel}`)) // channel = literal fijo (no user input)
      .catch(() => {
        client = null;
        if (disposed) return;
        reconnectTimer = setTimeout(connect, 3000);
      });
  };
  connect();
  return () => {
    if (disposed) return;
    disposed = true;
    if (reconnectTimer) { try { clearTimeout(reconnectTimer); } catch { /* noop */ } reconnectTimer = null; }
    if (client) { try { client.end().catch(() => {}); } catch { /* noop */ } client = null; }
  };
}
export async function dbRecentConversations(limit = 50) {
  const tenantId = currentWorkspaceId();
  if (!pool)
    return [...mem.conversations.values()]
      .filter((c) => ((c as { tenant_id?: string }).tenant_id || "default") === tenantId)
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, limit);
  const r = await pool.query(
    "SELECT user_id, bot_id, turns, extract(epoch from updated_at)*1000 AS updated_at FROM app_conversations WHERE tenant_id=$2 ORDER BY updated_at DESC LIMIT $1",
    [limit, tenantId],
  );
  return r.rows.map((x) => ({ ...x, updated_at: Number(x.updated_at) }));
}

/** COUNT de conversaciones del workspace, sin traer la columna turns.
 *  (El dashboard traía 1000 conversaciones CON su JSON entero solo para
 *  hacer convs.length — mismo anti-patrón que ya se arregló con contactos.) */
export async function dbCountConversations(): Promise<number> {
  const tenantId = currentWorkspaceId();
  if (!pool)
    return [...mem.conversations.values()]
      .filter((c) => ((c as { tenant_id?: string }).tenant_id || "default") === tenantId).length;
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM app_conversations WHERE tenant_id=$1",
    [tenantId],
  );
  return Number(r.rows[0]?.n || 0);
}

/** COUNT de conversaciones del workspace dentro de una ventana temporal
 *  (updated_at entre sinceMs y untilMs). Calcada de dbCountConversations:
 *  el KPI «Conversaciones · Nd» del panel necesita respetar el rango elegido
 *  (antes pintaba el total histórico capado a 2000). */
export async function dbCountConversationsInRange(sinceMs: number, untilMs: number): Promise<number> {
  const tenantId = currentWorkspaceId();
  if (!pool)
    return [...mem.conversations.values()]
      .filter((c) => ((c as { tenant_id?: string }).tenant_id || "default") === tenantId)
      .filter((c) => {
        const u = (c as { updated_at?: number }).updated_at || 0;
        return u >= sinceMs && u <= untilMs;
      }).length;
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM app_conversations WHERE tenant_id=$1 AND updated_at BETWEEN to_timestamp($2/1000.0) AND to_timestamp($3/1000.0)",
    [tenantId, sinceMs, untilMs],
  );
  return Number(r.rows[0]?.n || 0);
}

/** Variante LIGERA para la bandeja: solo el último turno + nº de turnos por
 *  conversación (la lista solo pinta el último mensaje). La columna turns
 *  completa —miles de mensajes × todas las conversaciones × poll cada 6-15s—
 *  era el mayor coste recurrente del server. El ORDER BY + LIMIT va sobre el
 *  índice (tenant_id, updated_at DESC), así que un límite alto no cuesta más. */
/** BANDEJA-CACHE-1 · cada clic en un filtro de la Bandeja (Negocios/Canales/Cuentas) pide el listado entero y el 85 % de la
 *  petición (340 de 400 ms con 3.000 chats; crece con la base) es esta lectura. Se reutiliza 5 s por workspace y límite, con
 *  una sola consulta en vuelo, y cualquier escritura de conversaciones del workspace la invalida (versión). Otra réplica solo
 *  puede dejarla desfasada esos 5 s. Los errores no se cachean. */
const CONV_LIGERA_TTL_MS = 5000;
const convVersion = new Map<string, number>();
const convLigeraCache = new Map<string, { t: number; v: number; p: Promise<Array<Record<string, unknown>>> }>();
function convInvalidar(tenantId: string): void {
  convVersion.set(tenantId, (convVersion.get(tenantId) || 0) + 1);
}
export async function dbRecentConversationsLight(limit = 50) {
  const tenantId = currentWorkspaceId();
  if (pool) {
    const clave = tenantId + "|" + limit;
    const v = convVersion.get(tenantId) || 0;
    const hit = convLigeraCache.get(clave);
    if (hit && hit.v === v && Date.now() - hit.t < CONV_LIGERA_TTL_MS) {
      return (await hit.p).map((x) => ({ ...x })) as Awaited<ReturnType<typeof dbRecentConversationsLightSql>>;
    }
    const p = dbRecentConversationsLightSql(limit, tenantId) as Promise<Array<Record<string, unknown>>>;
    convLigeraCache.set(clave, { t: Date.now(), v, p });
    p.catch(() => { if (convLigeraCache.get(clave)?.p === p) convLigeraCache.delete(clave); });
    return (await p).map((x) => ({ ...x })) as Awaited<ReturnType<typeof dbRecentConversationsLightSql>>;
  }
  return dbRecentConversationsLightSql(limit, tenantId);
}
async function dbRecentConversationsLightSql(limit: number, tenantId: string) {
  if (!pool)
    return [...mem.conversations.values()]
      .map((v) => {
        const turns = ((v as { turns?: { role?: string }[] }).turns || []);
        const lastUserIdx = turns.map((t) => t?.role).lastIndexOf("user");
        const keep = turns
          .map((t, i) => ({ t, i }))
          .filter(({ i }) => i === turns.length - 1 || i === lastUserIdx)
          .map(({ t }) => t);
        return { ...v, turns: keep, n_turns: turns.length };
      })
      .filter((c) => ((c as { tenant_id?: string }).tenant_id || "default") === tenantId)
      .sort((a, b) => (b as { updated_at: number }).updated_at - (a as { updated_at: number }).updated_at)
      .slice(0, limit);
  // Devolvemos el ÚLTIMO turno (lo que pinta la fila) y además el último turno
  // DEL USUARIO: la búsqueda de la bandeja indexa lo que escribió el cliente, y
  // sin él dejaba de encontrar conversaciones cuyo último mensaje es del bot.
  // BANDEJA-LINEAL-1 · la anterior reevaluaba max(i) de los turnos 'user' por elemento: cuadrática (3.000 conversaciones de
  // 50/150/300 turnos: 1,2/13,0/26,8 s; ahora 0,21/0,32/0,42 s). La cola de 20 da los dos turnos y sólo sin cliente en ella se
  // recorre el array. OFFSET 0 evita que el planner repita la descompresión; strict, que desenvuelva arrays. Arnés: t-bandeja-lineal.
  const r = await pool.query(
    `SELECT c.user_id, c.bot_id, c.accts,
       CASE WHEN l.n = 0 THEN '[]'::jsonb
            WHEN l.u IS NULL OR l.u = l.ult THEN jsonb_build_array(l.ult)
            ELSE jsonb_build_array(l.u, l.ult) END AS turns,
       l.n AS n_turns, extract(epoch from c.updated_at)*1000 AS updated_at
     FROM app_conversations c
     CROSS JOIN LATERAL (
       SELECT b.n, b.ult,
              CASE WHEN b.n = 0 THEN NULL
                   ELSE coalesce(jsonb_path_query_array(b.cola, 'strict $[*] ? (@.role == "user")') -> -1,
                                 jsonb_path_query_array(c.turns, 'strict $[*] ? (@.role == "user")') -> -1) END AS u
         FROM (SELECT a.n, a.cola, a.cola -> -1 AS ult
                 FROM (SELECT coalesce((jsonb_path_query_first(c.turns, 'strict $.size()', '{}', true))::int, 0) AS n,
                              jsonb_path_query_array(c.turns, 'lax $[last-19 to last]') AS cola OFFSET 0) a OFFSET 0) b
        OFFSET 0) l
     WHERE c.tenant_id=$2 ORDER BY c.updated_at DESC LIMIT $1`,
    [limit, tenantId],
  );
  return r.rows.map((x) => ({ ...x, updated_at: Number(x.updated_at), n_turns: Number(x.n_turns) }));
}

/** UNREAD-PROPIO-1 · filas para el contador de «sin leer»: las mismas que dbRecentConversationsLight
 *  pero sin texto (rol del último turno y rol+hora del último del cliente), que es todo lo que mira
 *  inboxSinLeer. El bucle de la Bandeja es el mismo: no hay réplica de la regla. */
export async function dbInboxUnreadRows(limit = 50) {
  const tenantId = currentWorkspaceId();
  if (!pool) return dbRecentConversationsLight(limit);
  const r = await pool.query(
    `SELECT c.user_id, c.bot_id, c.accts,
       CASE WHEN l.n = 0 THEN '[]'::jsonb
            WHEN l.u IS NULL OR l.u = l.ult THEN jsonb_build_array(l.pu)
            ELSE jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('role', 'user', 'at', l.u -> 'at')), l.pu) END AS turns,
       l.n AS n_turns, extract(epoch from c.updated_at)*1000 AS updated_at
     FROM app_conversations c
     CROSS JOIN LATERAL (
       SELECT b.n, b.ult, CASE WHEN jsonb_typeof(b.ult) = 'object' THEN b.ult - 'content' - 'text' - 'media' ELSE b.ult END AS pu,
              CASE WHEN b.n = 0 THEN NULL
                   ELSE coalesce(jsonb_path_query_array(b.cola, 'strict $[*] ? (@.role == "user")') -> -1,
                                 jsonb_path_query_array(c.turns, 'strict $[*] ? (@.role == "user")') -> -1) END AS u
         FROM (SELECT a.n, a.cola, a.cola -> -1 AS ult
                 FROM (SELECT coalesce((jsonb_path_query_first(c.turns, 'strict $.size()', '{}', true))::int, 0) AS n,
                              jsonb_path_query_array(c.turns, 'lax $[last-19 to last]') AS cola OFFSET 0) a OFFSET 0) b
        OFFSET 0) l
     WHERE c.tenant_id=$2 ORDER BY c.updated_at DESC LIMIT $1`,
    [limit, tenantId],
  );
  return r.rows.map((x) => ({ ...x, updated_at: Number(x.updated_at), n_turns: Number(x.n_turns) }));
}

/** UNREAD-PROPIO-1 · versión de la Bandeja por workspace: sube con cada escritura de conversación
 *  (y con cada NOTIFY bstack_inbox, que cubre otras réplicas). La caché del contador la compara. */
/** HEALTH-BD-1 · ¿responde la base? SELECT 1 con tope de tiempo. Sin base (modo memoria): true. */
export async function dbPing(ms = 2000): Promise<boolean> {
  if (!pool) return true;
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pool.query("SELECT 1").then(() => true, () => false),
      new Promise<boolean>((res) => { t = setTimeout(() => res(false), ms); }),
    ]);
  } finally { if (t) clearTimeout(t); }
}

const versionBandeja = new Map<string, number>();
export function dbVersionBandeja(tenantId = currentWorkspaceId()): number { return versionBandeja.get(tenantId) || 0; }
export function dbTocarBandeja(tenantId = currentWorkspaceId()): void {
  versionBandeja.set(tenantId, dbVersionBandeja(tenantId) + 1);
}

/** ATENCION-HUMANA-1 (MET-WA-06) · turnos LIGEROS (rol, hora, número, autor; sin texto) de las
 *  conversaciones del workspace con actividad desde `sinceMs`. Con ellos Métricas separa la
 *  atención humana de lo automático: personas que escribieron, conversaciones nuevas,
 *  contestadas por el equipo y su tiempo de respuesta. Se traen TODOS los turnos guardados de
 *  esas conversaciones (no solo los del rango): una espera puede empezar antes del rango. */
export interface WaTurnoLigero { r: string; at: number; a: string; b: string; ai: boolean }
export async function dbConversacionesTurnosLigeros(sinceMs: number): Promise<Array<{ user_id: string; n: number; t: WaTurnoLigero[] }>> {
  const tenantId = currentWorkspaceId();
  const ligero = (v: Record<string, unknown>): WaTurnoLigero => ({
    r: String(v?.role || ""), at: Number(v?.at || 0) || 0, a: String(v?.acct || ""), b: String(v?.by || ""),
    ai: !!(v?.ai || v?.notice),
  });
  if (!pool)
    return [...mem.conversations.values()]
      .filter((cv) => ((cv as { tenant_id?: string }).tenant_id || "default") === tenantId)
      .filter((cv) => Number((cv as { updated_at?: number }).updated_at || 0) >= sinceMs)
      .map((cv) => {
        const turns = ((cv as { turns?: unknown[] }).turns || []) as Record<string, unknown>[];
        return { user_id: String((cv as { user_id?: string }).user_id || ""), n: turns.length, t: turns.map(ligero) };
      });
  const r = await pool.query(
    `SELECT user_id,
       CASE WHEN jsonb_typeof(turns)='array' THEN jsonb_array_length(turns) ELSE 0 END AS n,
       CASE WHEN jsonb_typeof(turns)='array' AND jsonb_array_length(turns)>0
            THEN (SELECT jsonb_agg(jsonb_build_object('r', v->>'role', 'at', v->'at', 'a', v->>'acct', 'b', v->>'by',
                                                      'ai', (v ? 'ai' OR v ? 'notice')) ORDER BY i)
                    FROM jsonb_array_elements(turns) WITH ORDINALITY AS e(v,i)
                   WHERE v->>'role' IN ('user','assistant'))
            ELSE '[]'::jsonb END AS t
     FROM app_conversations WHERE tenant_id=$1 AND updated_at >= to_timestamp($2/1000.0)`,
    [tenantId, sinceMs],
  );
  return r.rows.map((x) => ({
    user_id: String(x.user_id), n: Number(x.n) || 0,
    t: ((x.t || []) as Record<string, unknown>[]).map((v) => ({ r: String(v.r || ""), at: Number(v.at || 0) || 0, a: String(v.a || ""), b: String(v.b || ""), ai: !!v.ai })),
  }));
}

/** Borra una conversación de la bandeja (sus mensajes). El contacto, si existe, permanece. */
export async function dbDeleteConversation(userId: string): Promise<void> {
  // Borrar la conversación = empezar de cero: además de quitar el hilo, reactivamos el
  // bot (human=false). Si no, el "Atender yo" del contacto se queda pegado y el bot
  // sigue callado en la próxima conversación, aunque parezca nueva.
  const tenantId = currentWorkspaceId();
  dbTocarBandeja(tenantId); // UNREAD-PROPIO-1
  if (!pool) {
    const c = mem.conversations.get(contactMemKey(userId));
    if (c && ((c as { tenant_id?: string }).tenant_id || "default") === tenantId) mem.conversations.delete(contactMemKey(userId));
    const ct = mem.contacts.get(contactMemKey(userId));
    if (ct && (ct.tenant_id || "default") === tenantId) { ct.human = false; ct.updated_at = Date.now(); }
    return;
  }
  await pool.query("DELETE FROM app_conversations WHERE user_id=$1 AND tenant_id=$2", [userId, tenantId]);
  convInvalidar(tenantId); // BANDEJA-CACHE-1
  await pool.query("UPDATE app_contacts SET human=false, updated_at=now() WHERE phone=$1 AND tenant_id=$2", [userId, tenantId]);
}

// ---- Automations (IG + WhatsApp; filtran por data.platform) ----
export async function dbListAutomations(): Promise<Record<string, unknown>[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return [...mem.automations.entries()]
      .filter(([_, v]) => ((v as { tenant_id?: string }).tenant_id || "default") === tenantId)
      .map(([_, v]) => v);
  }
  const r = await pool.query(
    "SELECT data FROM app_automations WHERE tenant_id=$1 ORDER BY updated_at DESC",
    [tenantId],
  );
  return r.rows.map((x) => x.data);
}
export async function dbUpsertAutomation(id: string, data: Record<string, unknown>) {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    mem.automations.set(id, { ...data, tenant_id: tenantId });
    return;
  }
  await pool.query(
    // SECURITY 2026-07-07 · el PK es (id) global; sin el WHERE, un tenant que
    // enviara el UUID de una automatización ajena la sobrescribiría y le
    // reasignaría tenant_id. La barrera solo actualiza si la fila YA es de este
    // tenant; una colisión cross-tenant queda como no-op (no overwrite).
    `INSERT INTO app_automations (id,data,tenant_id,updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (id) DO UPDATE SET data=$2, tenant_id=$3, updated_at=now()
     WHERE app_automations.tenant_id = EXCLUDED.tenant_id`,
    [id, JSON.stringify(data), tenantId],
  );
}
export async function dbDeleteAutomation(id: string) {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const v = mem.automations.get(id);
    if (v && ((v as { tenant_id?: string }).tenant_id || "default") === tenantId) mem.automations.delete(id);
    return;
  }
  await pool.query("DELETE FROM app_automations WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
}
// ---- Goteo de respuestas a comentarios (DRIP-1) ----
export interface DripRow { comment_id: string; media_id: string; ig_id: string; author: string; }

/** Encola comentarios pendientes (uno por comentario). ON CONFLICT DO NOTHING: si ya
 *  estaba (aunque fuera done/error), no lo re-encola → nunca se responde dos veces. */
export async function dbDripEnqueue(rows: DripRow[]): Promise<number> {
  const tenantId = currentWorkspaceId();
  if (!rows.length) return 0;
  if (!pool) {
    let n = 0;
    for (const r of rows) {
      const k = `${tenantId}:${r.comment_id}`;
      if (!mem.drip.has(k)) { mem.drip.set(k, { ...r, tenant_id: tenantId, status: "pending" }); n++; }
    }
    return n;
  }
  let n = 0;
  for (const r of rows) {
    const res = await pool.query(
      `INSERT INTO app_comment_drip (tenant_id,comment_id,media_id,ig_id,author)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,comment_id) DO NOTHING`,
      [tenantId, r.comment_id, r.media_id, r.ig_id, r.author],
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

/** Conjunto de autores que YA están en la cola (en cualquier estado): para responder
 *  una sola vez por PERSONA, no una por comentario. */
export async function dbDripAuthors(): Promise<Set<string>> {
  const tenantId = currentWorkspaceId();
  if (!pool) return new Set([...mem.drip.values()].filter((x) => x.tenant_id === tenantId).map((x) => x.author.toLowerCase()));
  const r = await pool.query(`SELECT DISTINCT author FROM app_comment_drip WHERE tenant_id=$1`, [tenantId]);
  return new Set(r.rows.map((x) => String(x.author || "").toLowerCase()));
}

/** El siguiente pendiente (el más antiguo). null si no hay. */
export async function dbDripNext(): Promise<DripRow | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    for (const x of mem.drip.values()) if (x.tenant_id === tenantId && x.status === "pending") return x;
    return null;
  }
  const r = await pool.query(
    `SELECT comment_id,media_id,ig_id,author FROM app_comment_drip
     WHERE tenant_id=$1 AND status='pending' ORDER BY created_at ASC LIMIT 1`,
    [tenantId],
  );
  return r.rows[0] || null;
}

export async function dbDripMark(commentId: string, status: "done" | "error" | "skipped", error = ""): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const x = mem.drip.get(`${tenantId}:${commentId}`);
    if (x) { x.status = status; x.error = error; }
    return;
  }
  await pool.query(
    `UPDATE app_comment_drip SET status=$3, error=$4, sent_at=CASE WHEN $3='done' THEN now() ELSE sent_at END
     WHERE tenant_id=$1 AND comment_id=$2`,
    [tenantId, commentId, status, error.slice(0, 300)],
  );
}

export async function dbDripCounts(): Promise<{ pending: number; done: number; error: number; skipped: number; total: number }> {
  const tenantId = currentWorkspaceId();
  const z = { pending: 0, done: 0, error: 0, skipped: 0, total: 0 };
  if (!pool) {
    for (const x of mem.drip.values()) if (x.tenant_id === tenantId) { (z as Record<string, number>)[x.status] = ((z as Record<string, number>)[x.status] || 0) + 1; z.total++; }
    return z;
  }
  const r = await pool.query(`SELECT status, COUNT(*)::int n FROM app_comment_drip WHERE tenant_id=$1 GROUP BY status`, [tenantId]);
  for (const row of r.rows) { (z as Record<string, number>)[row.status] = Number(row.n); z.total += Number(row.n); }
  return z;
}

/** El último comentario que dio error (para saber POR QUÉ se paró el goteo). */
export async function dbDripLastError(): Promise<{ author: string; error: string } | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const errs = [...mem.drip.values()].filter((x) => x.tenant_id === tenantId && x.status === "error");
    const last = errs[errs.length - 1];
    return last ? { author: last.author, error: last.error || "" } : null;
  }
  const r = await pool.query(
    `SELECT author, error FROM app_comment_drip WHERE tenant_id=$1 AND status='error' ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  );
  return r.rows[0] ? { author: String(r.rows[0].author || ""), error: String(r.rows[0].error || "") } : null;
}

/** Devuelve a 'pending' los comentarios que quedaron en error (para reintentarlos). */
export async function dbDripRetryErrors(): Promise<number> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    let n = 0;
    for (const x of mem.drip.values()) if (x.tenant_id === tenantId && x.status === "error") { x.status = "pending"; x.error = ""; n++; }
    return n;
  }
  const r = await pool.query(`UPDATE app_comment_drip SET status='pending', error='' WHERE tenant_id=$1 AND status='error'`, [tenantId]);
  return r.rowCount ?? 0;
}

export async function dbDripClear(): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) { for (const k of [...mem.drip.keys()]) if (k.startsWith(tenantId + ":")) mem.drip.delete(k); return; }
  await pool.query(`DELETE FROM app_comment_drip WHERE tenant_id=$1`, [tenantId]);
}

export async function dbClaimOnce(automationId: string, userId: string): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const k = `${tenantId}:${automationId}:${userId}`;
    if (mem.log.has(k)) return false;
    mem.log.add(k);
    return true;
  }
  // TENANT-CLAIM-1 · El ON CONFLICT resuelve contra la PK, que initDb() migra a
  // (tenant_id, automation_id, user_id): el claim es POR WORKSPACE, igual que en el
  // modo memoria de arriba. Se deja sin target explícito a propósito, para que una
  // BD que aún no haya corrido la migración siga funcionando (peor: como antes) en
  // vez de reventar cada dedupe.
  const r = await pool.query(
    `INSERT INTO app_automation_log (automation_id,user_id,tenant_id) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING RETURNING 1`,
    [automationId, userId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** TYPEFORM-1 · Deshace un dbClaimOnce cuya escritura falló, para que el reintento del
 *  proveedor pueda volver a entrar. Acotado al workspace activo. */
export async function dbReleaseClaim(automationId: string, userId: string): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) { mem.log.delete(`${tenantId}:${automationId}:${userId}`); return; }
  await pool.query(`DELETE FROM app_automation_log WHERE tenant_id=$1 AND automation_id=$2 AND user_id=$3`, [tenantId, automationId, userId]);
}

/**
 * CONVERSOR · Hereda las marcas de «una vez por persona» de un disparador al flujo que
 * lo sustituye. Sin esto, el flujo recién convertido volvería a escribir desde cero a
 * todo el que ya había recibido el mensaje.
 *
 * `prefijo` existe porque las dos familias no llaman igual a la misma persona: en
 * YouTube los Disparadores reclaman con el id del canal a secas y los Flujos con
 * 'yt:' delante. Copiar sin traducir dejaría marcas que no bloquean nada.
 *
 * Idempotente (ON CONFLICT DO NOTHING) y acotado al workspace activo. Devuelve cuántas
 * marcas ha heredado.
 */
export async function dbCopyClaims(desdeId: string, haciaId: string, prefijo = ""): Promise<number> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    let n = 0;
    const pref = `${tenantId}:${desdeId}:`;
    for (const k of [...mem.log]) {
      if (!k.startsWith(pref)) continue;
      const user = k.slice(pref.length);
      const nueva = `${tenantId}:${haciaId}:${prefijo}${user}`;
      if (!mem.log.has(nueva)) { mem.log.add(nueva); n++; }
    }
    return n;
  }
  const r = await pool.query(
    `INSERT INTO app_automation_log (automation_id,user_id,tenant_id)
     SELECT $2, $4 || user_id, tenant_id FROM app_automation_log
     WHERE tenant_id=$3 AND automation_id=$1
     ON CONFLICT DO NOTHING`,
    [desdeId, haciaId, tenantId, prefijo],
  );
  return r.rowCount ?? 0;
}

/** Qué claves de dedupe existen ya, en UNA consulta. Lo usa la vista Reuniones
 *  para decir con verdad qué recordatorios han salido (el claim ES el envío). */
export async function dbClaimsExisting(automationId: string, userIds: string[]): Promise<string[]> {
  if (!userIds.length) return [];
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return userIds.filter((u) => mem.log.has(`${tenantId}:${automationId}:${u}`));
  }
  const r = await pool.query(
    `SELECT user_id FROM app_automation_log WHERE tenant_id=$1 AND automation_id=$2 AND user_id = ANY($3)`,
    [tenantId, automationId, userIds],
  );
  return r.rows.map((x) => String(x.user_id));
}

/**
 * Versión SOLO LECTURA de dbClaimOnce: ¿ya se reclamó este (automation,user)?
 * No escribe nada. La usa el BACKFILL de comentarios de IG para saber, sin
 * consumir el claim, qué comentarios NUNCA llegaron por webhook (= no reclamados
 * = se cayeron en un reinicio). true = ya procesado; false = nunca procesado.
 */
export async function dbWasClaimed(automationId: string, userId: string): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return mem.log.has(`${tenantId}:${automationId}:${userId}`);
  }
  const r = await pool.query(
    "SELECT 1 FROM app_automation_log WHERE automation_id=$1 AND user_id=$2 AND tenant_id=$3",
    [automationId, userId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---- Contacts (CRM) ----
function rowToContact(r: any): Contact {
  return {
    phone: r.phone, name: r.name ?? "", email: r.email ?? "",
    tags: r.tags ?? [], fields: r.fields ?? {},
    bot_id: r.bot_id ?? "", stage: r.stage ?? "", human: !!r.human,
    owner: r.owner ?? "",
    channel_account: r.channel_account ?? "",
    source: r.source ?? "",
    avatar_url: r.avatar_url ?? "",
    utm_source: r.utm_source ?? "",
    utm_medium: r.utm_medium ?? "",
    utm_campaign: r.utm_campaign ?? "",
    utm_content: r.utm_content ?? "",
    notes: r.notes ?? "",
    // Math.round: extract(epoch)*1000 llega como float y en PG viejos (double
    // precision) puede traer ...415.9999 — la comparación de idempotencia del
    // worker (naStatusFromJob) casa por igualdad de ms y no casaría jamás.
    next_action_at: r.next_action_at ? Math.round(Number(r.next_action_at)) : null,
    next_action_label: r.next_action_label ?? "",
    next_action_account: r.next_action_account ?? "",
    next_action_by: r.next_action_by ?? "",
    next_action_sync_status: r.next_action_sync_status ?? "",
    next_action_sync_error: r.next_action_sync_error ?? "",
    score: Number(r.score ?? 0),
    systemeio_contact_id: r.systemeio_contact_id ?? "",
    systemeio_account: r.systemeio_account ?? "",
    last_inbound: Number(r.last_inbound),
    last_inbound_by: r.last_inbound_by ?? {},
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at ?? r.created_at),
  };
}
const CFIELDS =
  "phone,name,email,tags,fields,bot_id,stage,human,owner,channel_account,source,avatar_url," +
  "utm_source,utm_medium,utm_campaign,utm_content,notes," +
  "next_action_label,next_action_account,next_action_by,next_action_sync_status,next_action_sync_error," +
  "score,systemeio_contact_id,systemeio_account,last_inbound_by," +
  "extract(epoch from last_inbound)*1000 last_inbound," +
  "extract(epoch from created_at)*1000 created_at," +
  "extract(epoch from next_action_at)*1000 next_action_at," +
  "extract(epoch from updated_at)*1000 updated_at";

/** `source` marca el CANAL de origen. Por defecto "whatsapp" para no cambiar el
 *  comportamiento de las llamadas de siempre, pero quien crea un contacto de
 *  Instagram DEBE pasar "instagram": si no, el IGSID se guarda como si fuera un
 *  telefono y entra en las audiencias de difusion de WhatsApp, donde cada envio
 *  falla contra la Cloud API y hunde la tasa de entrega sin causa visible. */
// NOTIFICACIONES-1 · devuelve true si la ficha NACE con este mensaje (lead nuevo).
export async function dbTouchContact(phone: string, name: string, botId: string, account = "", source = ""): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  // CHAT-POR-NUMERO-1 · channel_account pasa a SET-ONCE (antes cada entrante lo pisaba
  // con el último número que recibió: la etiqueta «vía X» del hilo cambiaba
  // retroactivamente). Ahora los turnos nuevos llevan su acct propio y este campo solo
  // atribuye el HISTÓRICO sin sellar, así que congelarlo es lo que mantiene esa
  // atribución estable. La ventana por par vive en last_inbound_by, que sí se
  // actualiza en cada entrante.
  if (!pool) {
    let c = mem.contacts.get(contactMemKey(phone));
    const nueva = !c;
    if (!c) c = defaultContact(phone, name, botId);
    c.last_inbound = Date.now();
    c.updated_at = Date.now();
    if (name) c.name = name;
    if (botId) c.bot_id = botId;
    if (account && !c.channel_account) c.channel_account = account;
    if (account) c.last_inbound_by = { ...(c.last_inbound_by || {}), [account]: Date.now() };
    if (!c.source) c.source = source || "whatsapp";
    if (!c.tenant_id) c.tenant_id = tenantId;
    mem.contacts.set(contactMemKey(phone), c);
    return nueva;
  }
  const r = await pool.query(
    `INSERT INTO app_contacts (phone,name,bot_id,channel_account,last_inbound,last_inbound_by,source,tenant_id,updated_at)
     VALUES ($1,$2,$3,$4,now(),
       CASE WHEN $4<>'' THEN jsonb_build_object($4, round(extract(epoch from now())*1000)) ELSE '{}'::jsonb END,
       $6,$5,now())
     ON CONFLICT (tenant_id, phone) DO UPDATE SET
       last_inbound=now(),
       updated_at=now(),
       name=CASE WHEN $2<>'' THEN $2 ELSE app_contacts.name END,
       bot_id=CASE WHEN $3<>'' THEN $3 ELSE app_contacts.bot_id END,
       channel_account=CASE WHEN app_contacts.channel_account='' AND $4<>'' THEN $4 ELSE app_contacts.channel_account END,
       last_inbound_by=CASE WHEN $4<>'' THEN coalesce(app_contacts.last_inbound_by,'{}'::jsonb) || jsonb_build_object($4, round(extract(epoch from now())*1000)) ELSE coalesce(app_contacts.last_inbound_by,'{}'::jsonb) END,
       source=CASE WHEN app_contacts.source='' THEN $6 ELSE app_contacts.source END
     RETURNING (xmax = 0) AS nueva`,
    [phone, name || "", botId || "", account || "", tenantId, source || "whatsapp"],
  );
  return !!r.rows[0]?.nueva;
}
/**
 * NOMBRE-ECO-1 · Retira el nombre de las fichas que quedaron bautizadas con el nombre
 * de perfil del teléfono vinculado. Pasaba con cualquier persona a la que el dueño
 * escribiera primero desde el móvil: el eco de su propio mensaje traía SU pushName y
 * la ficha nacía con su nombre. Sin nombre, la bandeja enseña el teléfono, que es lo
 * honesto cuando no sabemos cómo se llama.
 *
 * Acotado al workspace activo, a contactos de WhatsApp, EXCLUYENDO la ficha del propio
 * número vinculado (chat con uno mismo: ahí ese nombre sí es el suyo) y EXCLUYENDO a
 * quien alguna vez nos haya escrito: si hay un entrante suyo, el nombre que tenga se lo
 * dio él, y esta limpieza no puede tocarlo. Por eso no puede llevarse por delante un
 * nombre legítimo ni aunque el dueño se ponga de perfil un nombre corriente.
 * Devuelve cuántas fichas se limpiaron.
 */
export async function dbLimpiarNombresDeEco(selfName: string, selfPhone: string): Promise<number> {
  const nombre = String(selfName || "").trim();
  if (!nombre) return 0;
  const tenantId = currentWorkspaceId();
  const propios = new Set([selfPhone, "+" + String(selfPhone || "").replace(/\D/g, "")].filter(Boolean));
  if (!pool) {
    let n = 0;
    for (const c of mem.contacts.values()) {
      if ((c.tenant_id || "default") !== tenantId) continue;
      if (String(c.name || "").trim() !== nombre) continue;
      if ((c.source || "") !== "whatsapp") continue;
      if ((c.last_inbound||0) > 0) continue; // ya nos escribió: su nombre no se toca
      if (propios.has(c.phone)) continue;
      c.name = ""; c.updated_at = Date.now(); n++;
    }
    return n;
  }
  const r = await pool.query(
    `UPDATE app_contacts SET name='', updated_at=now()
      WHERE tenant_id=$1 AND source='whatsapp' AND btrim(name)=$2
        AND last_inbound <= to_timestamp(0)
        AND NOT (phone = ANY($3::text[]))`,
    [tenantId, nombre, [...propios]],
  );
  return r.rowCount || 0;
}
/** Contacto del workspace activo con ese email EXACTO (case-insensitive), o null.
 *  Para el alta unificada: antes de crear ficha desde la web, mirar si ya existe. */
export async function dbContactByEmail(email: string): Promise<Contact | null> {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const tenantId = currentWorkspaceId();
  if (!pool) {
    for (const c of mem.contacts.values())
      if ((c.tenant_id || "default") === tenantId && String(c.email || "").trim().toLowerCase() === e) return c;
    return null;
  }
  const r = await pool.query(`SELECT ${CFIELDS} FROM app_contacts WHERE tenant_id=$2 AND lower(email)=$1 LIMIT 1`, [e, tenantId]);
  return r.rows.length ? rowToContact(r.rows[0]) : null;
}
/** MET-AUTO-07-FIN · Claves (phone) de las fichas de este negocio con el mismo correo: la misma
 *  persona en otros canales (regla IDENTIDAD-COMUN-1). Incluye la ficha «email:<correo>». */
export async function dbClavesPorEmail(email: string): Promise<string[]> {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return [];
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const out: string[] = [];
    for (const c of mem.contacts.values())
      if ((c.tenant_id || "default") === tenantId && String(c.email || "").trim().toLowerCase() === e) out.push(c.phone);
    return out;
  }
  const r = await pool.query(`SELECT phone FROM app_contacts WHERE tenant_id=$2 AND lower(email)=$1 LIMIT 20`, [e, tenantId]);
  return r.rows.map((x) => String(x.phone));
}
/** MET-AUTO-07-FIN · Fichas de WhatsApp de este negocio cuyo número es `tel` (ya normalizado con
 *  normalizarTelefono: sólo dígitos, México 521→52). Une por el MISMO teléfono (IDENTIDAD-COMUN-1)
 *  a quien reserva en la web dejando su móvil pero su ficha de WhatsApp no tiene correo. */
export async function dbClavesPorTelefono(tel: string): Promise<string[]> {
  const d = String(tel || "").replace(/\D+/g, "");
  if (d.length < 8 || d.length > 15) return [];
  const variantes = [d, "+" + d];
  if (d.length === 12 && d.startsWith("52")) variantes.push("521" + d.slice(2), "+521" + d.slice(2)); // MX-521-1
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const out: string[] = [];
    for (const c of mem.contacts.values())
      if ((c.tenant_id || "default") === tenantId && variantes.includes(String(c.phone || ""))) out.push(c.phone);
    return out;
  }
  const r = await pool.query(`SELECT phone FROM app_contacts WHERE tenant_id=$1 AND phone = ANY($2::text[]) LIMIT 5`, [tenantId, variantes]);
  return r.rows.map((x) => String(x.phone));
}
export async function dbGetContact(phone: string): Promise<Contact | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const c = mem.contacts.get(contactMemKey(phone));
    if (!c) return null;
    return (c.tenant_id || "default") === tenantId ? c : null;
  }
  const r = await pool.query(`SELECT ${CFIELDS} FROM app_contacts WHERE phone=$1 AND tenant_id=$2`, [phone, tenantId]);
  return r.rows[0] ? rowToContact(r.rows[0]) : null;
}
/** Resuelve MUCHOS contactos por phone en una sola query → Map phone→Contact. Evita N+1
 *  (la bandeja resolvía un getContact por conversación = hasta 200 queries por request). */
export async function dbGetContactsByIds(ids: string[]): Promise<Map<string, Contact>> {
  const m = new Map<string, Contact>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return m;
  const tenantId = currentWorkspaceId();
  if (!pool) {
    for (const id of uniq) {
      const c = mem.contacts.get(contactMemKey(id));
      if (c && (c.tenant_id || "default") === tenantId) m.set(id, c);
    }
    return m;
  }
  const r = await pool.query(
    `SELECT ${CFIELDS} FROM app_contacts WHERE phone = ANY($1) AND tenant_id=$2`,
    [uniq, tenantId],
  );
  for (const row of r.rows) { const c = rowToContact(row); m.set(c.phone, c); }
  return m;
}
/** Conteos agregados para el dashboard SIN traer las filas (antes: listContacts(5000) + bucle). */
export async function dbContactStats(): Promise<{ total: number; inWindow: number; human: number; byStage: Record<string, number> }> {
  const byStage: Record<string, number> = {};
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const arr = [...mem.contacts.values()].filter((c) => (c.tenant_id || "default") === tenantId);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const c of arr) byStage[c.stage || "(sin etapa)"] = (byStage[c.stage || "(sin etapa)"] || 0) + 1;
    return { total: arr.length, inWindow: arr.filter((c) => c.last_inbound >= cutoff).length, human: arr.filter((c) => c.human).length, byStage };
  }
  const agg = await pool.query(
    `SELECT COUNT(*)::int total,
       COUNT(*) FILTER (WHERE last_inbound >= now()-interval '24 hours')::int in_window,
       COUNT(*) FILTER (WHERE human)::int human
     FROM app_contacts WHERE tenant_id=$1`,
    [tenantId],
  );
  const st = await pool.query(
    `SELECT COALESCE(NULLIF(stage,''),'(sin etapa)') AS stage, COUNT(*)::int n FROM app_contacts WHERE tenant_id=$1 GROUP BY 1`,
    [tenantId],
  );
  for (const row of st.rows) byStage[row.stage] = Number(row.n);
  const a = agg.rows[0] || {};
  return { total: Number(a.total || 0), inWindow: Number(a.in_window || 0), human: Number(a.human || 0), byStage };
}
export async function dbSetContactStage(phone: string, stage: string) {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const c = mem.contacts.get(contactMemKey(phone));
    if (c && (c.tenant_id || "default") === tenantId) { c.stage = stage; c.updated_at = Date.now(); }
    return;
  }
  await pool.query("UPDATE app_contacts SET stage=$2,updated_at=now() WHERE phone=$1 AND tenant_id=$3", [phone, stage, tenantId]);
}
export async function dbSetContactHuman(phone: string, human: boolean) {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const c = mem.contacts.get(contactMemKey(phone));
    if (c && (c.tenant_id || "default") === tenantId) { c.human = human; c.updated_at = Date.now(); }
    return;
  }
  await pool.query("UPDATE app_contacts SET human=$2,updated_at=now() WHERE phone=$1 AND tenant_id=$3", [phone, human, tenantId]);
}
/** Asigna el dueño (closer) del lead. owner='' = devuelve al pool sin asignar. */
export async function dbSetContactOwner(phone: string, owner: string) {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const c = mem.contacts.get(contactMemKey(phone));
    if (c && (c.tenant_id || "default") === tenantId) { c.owner = owner; c.updated_at = Date.now(); }
    return;
  }
  await pool.query("UPDATE app_contacts SET owner=$2,updated_at=now() WHERE phone=$1 AND tenant_id=$3", [phone, owner, tenantId]);
}
export async function dbPatchContact(phone: string, tags: string[], fields: Record<string, string>) {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const c = mem.contacts.get(contactMemKey(phone));
    if (!c || (c.tenant_id || "default") !== tenantId) return;
    c.tags = [...new Set([...c.tags, ...tags])];
    c.fields = { ...c.fields, ...fields };
    c.updated_at = Date.now();
    return;
  }
  await pool.query(
    `UPDATE app_contacts SET
       tags = COALESCE((SELECT jsonb_agg(DISTINCT e) FROM jsonb_array_elements(coalesce(tags,'[]') || $2::jsonb) e), '[]'::jsonb),
       fields = coalesce(fields,'{}') || $3::jsonb,
       updated_at = now()
     WHERE phone=$1 AND tenant_id=$4`,
    [phone, JSON.stringify(tags), JSON.stringify(fields), tenantId],
  );
}
/** Conteos por etiqueta de TODO el tenant, agregados en SQL (antes: listContacts(5000)
 * + bucle — con >5000 contactos el conteo de la muestra se presentaba como total).
 * excludePrefix (p.ej. el prefijo de etapa) se compara por prefijo EXACTO con left(),
 * sin metacaracteres LIKE.
 * ETQ-04 · RECUENTO-ETIQUETA-1 · Cuenta CONTACTOS, no apariciones: un contacto con la
 * misma etiqueta repetida en su array contaba dos veces, y la cifra no casaba con la
 * lista filtrada de Contactos (`tags @> '["x"]'`, una fila por contacto). Solo cuentan
 * elementos de texto y solo arrays, que es lo único que ese filtro puede encontrar
 * (y un `tags` que no sea array ya no tumba la consulta entera). */
export async function dbTagCounts(excludePrefix?: string): Promise<Map<string, number>> {
  const tenantId = currentWorkspaceId();
  const counts = new Map<string, number>();
  if (!pool) {
    for (const c of mem.contacts.values()) {
      if ((c.tenant_id || "default") !== tenantId) continue;
      const propias = new Set((Array.isArray(c.tags) ? c.tags : []).filter((t): t is string => typeof t === "string"));
      for (const t of propias)
        if (t && !(excludePrefix && t.startsWith(excludePrefix)))
          counts.set(t, (counts.get(t) || 0) + 1);
    }
    return counts;
  }
  const r = await pool.query(
    `SELECT x.t AS tag, COUNT(*)::int n
       FROM app_contacts ct
       CROSS JOIN LATERAL (
         SELECT DISTINCT e #>> '{}' AS t
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ct.tags)='array' THEN ct.tags ELSE '[]'::jsonb END) e
          WHERE jsonb_typeof(e)='string'
       ) x
      WHERE ct.tenant_id=$1 AND x.t <> ''
        AND ($2::text IS NULL OR left(x.t, char_length($2::text)) <> $2::text)
      GROUP BY x.t`,
    [tenantId, excludePrefix ?? null],
  );
  for (const row of r.rows) counts.set(String(row.tag), Number(row.n) || 0);
  return counts;
}
/** Quita una etiqueta de TODOS los contactos del tenant en un solo UPDATE (el bucle
 * anterior sobre listContacts(5000) cubría menos alcance del que el confirm promete).
 * Devuelve cuántos contactos la tenían. */
export async function dbRemoveTagEverywhere(tag: string): Promise<number> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    let touched = 0;
    for (const c of mem.contacts.values()) {
      if ((c.tenant_id || "default") !== tenantId) continue;
      if ((c.tags || []).includes(tag)) {
        c.tags = (c.tags || []).filter((t) => t !== tag);
        c.updated_at = Date.now();
        touched++;
      }
    }
    return touched;
  }
  const r = await pool.query(
    `UPDATE app_contacts
        SET tags = COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements_text(tags) e WHERE e <> $2), '[]'::jsonb),
            updated_at = now()
      WHERE tenant_id=$1 AND tags @> jsonb_build_array($2::text)`,
    [tenantId, tag],
  );
  return r.rowCount || 0;
}
/** Renombra una etiqueta en TODOS los contactos del tenant (dedupe si el nombre nuevo
 * ya existía en el mismo contacto). Devuelve cuántos contactos la tenían. */
export async function dbRenameTagEverywhere(from: string, to: string): Promise<number> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    let touched = 0;
    for (const c of mem.contacts.values()) {
      if ((c.tenant_id || "default") !== tenantId) continue;
      const ts = c.tags || [];
      if (ts.includes(from)) {
        c.tags = [...new Set(ts.map((t) => (t === from ? to : t)))];
        c.updated_at = Date.now();
        touched++;
      }
    }
    return touched;
  }
  const r = await pool.query(
    `UPDATE app_contacts
        SET tags = COALESCE((SELECT jsonb_agg(DISTINCT v) FROM (
              SELECT CASE WHEN e = $2 THEN $3 ELSE e END AS v
                FROM jsonb_array_elements_text(tags) e
            ) s), '[]'::jsonb),
            updated_at = now()
      WHERE tenant_id=$1 AND tags @> jsonb_build_array($2::text)`,
    [tenantId, from, to],
  );
  return r.rowCount || 0;
}
export async function dbListContacts(limit = 500): Promise<Contact[]> {
  const tenantId = currentWorkspaceId();
  if (!pool)
    return [...mem.contacts.values()]
      .filter((c) => (c.tenant_id || "default") === tenantId)
      .sort((a, b) => b.last_inbound - a.last_inbound)
      .slice(0, limit);
  const r = await pool.query(
    `SELECT ${CFIELDS} FROM app_contacts WHERE tenant_id=$2 ORDER BY last_inbound DESC LIMIT $1`,
    [limit, tenantId],
  );
  return r.rows.map(rowToContact);
}

/** Filas mínimas para la ATRIBUCIÓN de leads: un lead = un contacto creado en el rango.
 *  Devuelve solo lo necesario (utm_* + source + created_at) para agregar por origen sin
 *  traer el contacto entero. El endpoint /admin/api/analytics/attribution clasifica. */
export async function dbLeadAttributionRows(
  sinceMs: number,
  untilMs: number,
): Promise<Array<{ utm_source: string; utm_medium: string; utm_campaign: string; utm_content: string; source: string; created_at: number; flow_id: string; channel_account: string; phone: string; name: string }>> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return [...mem.contacts.values()]
      .filter((c) => (c.tenant_id || "default") === tenantId && c.created_at >= sinceMs && c.created_at <= untilMs)
      .map((c) => {
        // Primer flujo por el que entró (mem: el run más antiguo de ese phone).
        let flowId = "";
        let best = Infinity;
        for (const r of mem.flowRuns.values()) {
          if (r.phone === c.phone && (r.next_run || 0) < best) { best = r.next_run || 0; flowId = r.flow_id; }
        }
        return {
          utm_source: c.utm_source || "",
          utm_medium: c.utm_medium || "",
          utm_campaign: c.utm_campaign || "",
          utm_content: c.utm_content || "",
          source: c.source || "",
          created_at: c.created_at,
          flow_id: flowId,
          channel_account: c.channel_account || "",
          phone: c.phone || "",
          name: c.name || "",
        };
      });
  }
  // flow_id = el PRIMER flujo que captó a ese contacto. Es la atribución fina de los
  // leads que NO entran por un enlace (comentario en post de IG, palabra clave de
  // WhatsApp): no hay URL ni utm_*, pero el flujo — y su post/keyword — sí se conoce.
  const r = await pool.query(
    `SELECT COALESCE(c.utm_source,'') utm_source, COALESCE(c.utm_medium,'') utm_medium,
            COALESCE(c.utm_campaign,'') utm_campaign, COALESCE(c.utm_content,'') utm_content,
            COALESCE(c.source,'') source, extract(epoch from c.created_at)*1000 created_at,
            COALESCE(fr.flow_id,'') flow_id, COALESCE(c.channel_account,'') channel_account,
            c.phone phone, COALESCE(c.name,'') name
     FROM app_contacts c
     LEFT JOIN LATERAL (
       SELECT r.flow_id FROM app_flow_runs r
       WHERE r.phone=c.phone AND r.tenant_id=$1
       ORDER BY COALESCE(r.created_at,r.updated_at) ASC LIMIT 1
     ) fr ON true
     WHERE c.tenant_id=$1 AND c.created_at >= to_timestamp($2/1000.0) AND c.created_at <= to_timestamp($3/1000.0)`,
    [tenantId, sinceMs, untilMs],
  );
  return r.rows.map((x: any) => ({
    utm_source: x.utm_source || "",
    utm_medium: x.utm_medium || "",
    utm_campaign: x.utm_campaign || "",
    utm_content: x.utm_content || "",
    source: x.source || "",
    created_at: Number(x.created_at),
    flow_id: x.flow_id || "",
    channel_account: x.channel_account || "",
    phone: x.phone || "",
    name: x.name || "",
  }));
}

/**
 * RECORRIDO-PUB-IG-1 (MET-IG-05) · las personas que entraron en los flujos atados a publicaciones y
 * stories de Instagram, con lo que pasó después de cada entrada. Acotado por tenant. Una fila por
 * (persona, flujo): la entrada cae en las fechas o la ficha de la persona nació en ellas (así los
 * contactos nuevos de una pieza siempre están). Por fila:
 *  · `mensaje`: el flujo le envió al menos un mensaje = nodos de envío distintos (mensaje, pregunta,
 *    opciones, pedir seguir) menos los que fallaron (paso NO entregado). null = no se puede saber: el
 *    historial de eventos se poda a los 90 días y la entrada es más antigua de ~89.
 *  · `contesto`: escribió DESPUÉS de entrar (un turno del usuario con fecha posterior a la entrada);
 *    el comentario o la respuesta a la story que dispara el flujo no se guarda como turno.
 * `hayVentas`: existe alguna venta registrada (panel o web); sin ninguna, las ventas son «sin medir».
 * En memoria no hay historial de flujos ni ventas: `medido: false`.
 */
export async function dbRecorridoPublicacionesIg(o: { sinceMs: number; untilMs: number; flowIds: string[]; tope?: number }): Promise<{
  medido: boolean;
  parcial: boolean;
  hayVentas: boolean;
  entradas: Array<{ phone: string; flow_id: string; entro: number; mensaje: boolean | null; contesto: boolean; alta: number | null; nombre: string }>;
}> {
  if (!pool) return { medido: false, parcial: false, hayVentas: false, entradas: [] };
  const tenantId = currentWorkspaceId();
  const tope = Math.max(1, Math.min(20000, Math.round(Number(o.tope) || 5000)));
  const flowIds = [...new Set((o.flowIds || []).map((x) => String(x || "")).filter(Boolean))];
  const hay = await pool.query(
    `SELECT (EXISTS (SELECT 1 FROM app_purchases WHERE tenant_id=$1) OR EXISTS (SELECT 1 FROM app_sio_sales WHERE tenant_id=$1)) AS hay`,
    [tenantId],
  );
  const hayVentas = !!hay.rows[0]?.hay;
  if (!flowIds.length) return { medido: true, parcial: false, hayVentas, entradas: [] };
  const r = await pool.query(
    `WITH e AS (
       SELECT r.phone, r.flow_id, COALESCE(r.created_at, r.updated_at) AS entro, c.created_at AS alta, COALESCE(c.name,'') AS nombre
         FROM app_flow_runs r
         LEFT JOIN app_contacts c ON c.tenant_id=r.tenant_id AND c.phone=r.phone
        WHERE r.tenant_id=$1 AND r.flow_id = ANY($2::text[])
          AND ((COALESCE(r.created_at, r.updated_at) >= $3 AND COALESCE(r.created_at, r.updated_at) <= $4)
               OR (c.created_at >= $3 AND c.created_at <= $4))
        ORDER BY COALESCE(r.created_at, r.updated_at) DESC NULLS LAST
        LIMIT $5
     )
     SELECT e.phone, e.flow_id, extract(epoch from e.entro)*1000 AS entro, extract(epoch from e.alta)*1000 AS alta, e.nombre,
            CASE WHEN e.entro IS NULL OR e.entro < now() - interval '89 days' THEN NULL ELSE
              (SELECT count(DISTINCT x.node_id) FROM app_flow_events x
                WHERE x.tenant_id=$1 AND x.phone=e.phone AND x.flow_id=e.flow_id AND x.at >= e.entro - interval '60 seconds'
                  AND x.event IN ('mensaje','pregunta','opciones','pedir seguir'))
              - (SELECT count(DISTINCT x.node_id) FROM app_flow_events x
                  WHERE x.tenant_id=$1 AND x.phone=e.phone AND x.flow_id=e.flow_id AND x.at >= e.entro - interval '60 seconds'
                    AND (x.event='paso NO entregado' OR (x.event='error' AND x.detail LIKE 'paso NO entregado%')))
            END AS enviados,
            EXISTS (
              SELECT 1 FROM app_conversations v
              CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.turns)='array' THEN v.turns ELSE '[]'::jsonb END) t
               WHERE v.tenant_id=$1 AND v.user_id=e.phone AND t->>'role'='user'
                 AND jsonb_typeof(t->'at')='number' AND (t->>'at')::float8 >= extract(epoch from e.entro)*1000
            ) AS contesto
       FROM e`,
    [tenantId, flowIds, new Date(o.sinceMs), new Date(o.untilMs), tope + 1],
  );
  const filas = r.rows.slice(0, tope);
  return {
    medido: true,
    parcial: r.rows.length > tope,
    hayVentas,
    entradas: filas.map((x: any) => ({
      phone: String(x.phone || ""),
      flow_id: String(x.flow_id || ""),
      entro: Number(x.entro) || 0,
      mensaje: x.enviados == null ? null : Number(x.enviados) > 0,
      contesto: !!x.contesto,
      alta: x.alta == null ? null : Number(x.alta) || null,
      nombre: String(x.nombre || ""),
    })),
  };
}

/**
 * Alta explícita de un contacto: panel, importación, sincronización o lead de
 * formulario. NINGUNA de esas cosas es un mensaje de esa persona.
 *
 * last_inbound se queda a 0 a propósito. Antes se ponía `now`, contradiciendo el
 * comentario que ya había aquí, y el panel acababa enseñando el distintivo verde
 * de «escribió hace menos de 24h» a gente que no había escrito nunca — es decir,
 * le decía a la closer que podía contestarle gratis cuando Meta iba a rechazar
 * el mensaje. Un mensaje de verdad entra por dbTouchContact, que sí lo fija.
 */
export async function dbCreateContact(c: Partial<Contact> & { phone: string }): Promise<Contact> {
  const now = Date.now();
  const tenantId = c.tenant_id || currentWorkspaceId();
  const full: Contact = { ...defaultContact(c.phone), ...c, tenant_id: tenantId, last_inbound: c.last_inbound ?? 0, created_at: c.created_at ?? now, updated_at: now };
  if (!full.source) full.source = "panel";
  if (!pool) {
    // IG-NEGOCIO-1 · igual que en PostgreSQL: la cuenta de entrada se pone una vez y no se pisa.
    const prev = mem.contacts.get(contactMemKey(full.phone, tenantId));
    if (prev?.channel_account) full.channel_account = prev.channel_account;
    mem.contacts.set(contactMemKey(full.phone, tenantId), full);
    return full;
  }
  await pool.query(
    `INSERT INTO app_contacts
      (phone,name,email,tags,fields,bot_id,stage,human,source,
       utm_source,utm_medium,utm_campaign,utm_content,notes,
       next_action_at,next_action_label,next_action_account,next_action_by,
       next_action_sync_status,next_action_sync_error,score,systemeio_contact_id,
       last_inbound,created_at,updated_at,tenant_id,channel_account)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,
             $10,$11,$12,$13,$14,
             $15::timestamptz,$16,$17,$18,$19,$20,$21,$22,
             to_timestamp($23/1000.0),to_timestamp($24/1000.0),to_timestamp($25/1000.0),$26,$27)
     ON CONFLICT (tenant_id, phone) DO UPDATE SET
       name=EXCLUDED.name,email=EXCLUDED.email,tags=EXCLUDED.tags,fields=EXCLUDED.fields,
       bot_id=COALESCE(NULLIF(EXCLUDED.bot_id,''),app_contacts.bot_id),
       stage=EXCLUDED.stage,human=EXCLUDED.human,
       source=COALESCE(NULLIF(EXCLUDED.source,''),app_contacts.source),
       utm_source=EXCLUDED.utm_source,utm_medium=EXCLUDED.utm_medium,
       utm_campaign=EXCLUDED.utm_campaign,utm_content=EXCLUDED.utm_content,
       notes=EXCLUDED.notes,next_action_at=EXCLUDED.next_action_at,
       next_action_label=EXCLUDED.next_action_label,
       next_action_account=EXCLUDED.next_action_account,next_action_by=EXCLUDED.next_action_by,
       next_action_sync_status=EXCLUDED.next_action_sync_status,
       next_action_sync_error=EXCLUDED.next_action_sync_error,
       score=EXCLUDED.score,
       systemeio_contact_id=COALESCE(NULLIF(EXCLUDED.systemeio_contact_id,''),app_contacts.systemeio_contact_id),
       channel_account=CASE WHEN app_contacts.channel_account='' THEN EXCLUDED.channel_account ELSE app_contacts.channel_account END,
       updated_at=now()`,
    // IG-NEGOCIO-1 · channel_account no estaba en este INSERT: un contacto creado con su cuenta
    // (p. ej. el eco de Instagram) la perdía EN SILENCIO y la Bandeja lo atribuía a la cuenta
    // por defecto (otro negocio). SET-ONCE igual que touchContact: nunca pisa una ya puesta.
    [
      full.phone, full.name, full.email,
      JSON.stringify(full.tags), JSON.stringify(full.fields),
      full.bot_id, full.stage, full.human, full.source,
      full.utm_source, full.utm_medium, full.utm_campaign, full.utm_content, full.notes,
      full.next_action_at ? new Date(full.next_action_at).toISOString() : null,
      full.next_action_label, full.next_action_account, full.next_action_by,
      full.next_action_sync_status, full.next_action_sync_error, full.score, full.systemeio_contact_id,
      full.last_inbound, full.created_at, full.updated_at, tenantId, full.channel_account || "",
    ],
  );
  return full;
}

/**
 * T02 · Contacto cuyo teléfono, PELADO A DÍGITOS, coincide con `digits`. Cubre las
 * fichas guardadas con otro formato ('+34 600 11 22 33' del alta del panel) para
 * que Nueva conversación no cree un duplicado por diferencia de formato. Acotado
 * al workspace activo. Excluye los pseudo-teléfonos 'email:<...>'.
 */
export async function dbFindContactByPhoneDigits(digits: string): Promise<Contact | null> {
  const d = String(digits || "").replace(/\D/g, "");
  if (!d) return null;
  const tenantId = currentWorkspaceId();
  if (!pool) {
    for (const c of mem.contacts.values()) {
      if ((c.tenant_id || "default") !== tenantId) continue;
      if (c.phone.startsWith("email:")) continue;
      if (c.phone.replace(/\D/g, "") === d) return c;
    }
    return null;
  }
  const r = await pool.query(
    `SELECT ${CFIELDS} FROM app_contacts
      WHERE tenant_id=$2 AND phone NOT LIKE 'email:%'
        AND regexp_replace(phone, '[^0-9]', '', 'g') = $1
      LIMIT 1`,
    [d, tenantId],
  );
  return r.rows[0] ? rowToContact(r.rows[0]) : null;
}

/** Update parcial de un contacto. */
export async function dbUpdateContact(phone: string, upd: Partial<Contact>): Promise<void> {
  if (!pool) {
    // Guard de workspace, como en todas sus hermanas (dbGetContact, dbSetContactStage…).
    // Sin el, la rama en memoria escribia en el contacto de CUALQUIER workspace que
    // tuviera ese mismo telefono.
    const tenantId = currentWorkspaceId();
    const c = mem.contacts.get(contactMemKey(phone));
    if (!c || (c.tenant_id || "default") !== tenantId) return;
    Object.assign(c, upd, { phone, tenant_id: tenantId });
    c.updated_at = Date.now();
    return;
  }
  const set: string[] = [];
  const args: unknown[] = [phone];
  const push = (col: string, val: unknown) => { args.push(val); set.push(`${col}=$${args.length}`); };
  if (upd.name !== undefined) push("name", upd.name);
  if (upd.email !== undefined) push("email", upd.email);
  if (upd.tags !== undefined) { args.push(JSON.stringify(upd.tags)); set.push(`tags=$${args.length}::jsonb`); }
  if (upd.fields !== undefined) { args.push(JSON.stringify(upd.fields)); set.push(`fields=$${args.length}::jsonb`); }
  if (upd.bot_id !== undefined) push("bot_id", upd.bot_id);
  if (upd.stage !== undefined) push("stage", upd.stage);
  if (upd.human !== undefined) push("human", upd.human);
  if (upd.owner !== undefined) push("owner", upd.owner);
  if (upd.channel_account !== undefined) push("channel_account", upd.channel_account);
  if (upd.source !== undefined) push("source", upd.source);
  if (upd.avatar_url !== undefined) push("avatar_url", upd.avatar_url);
  if (upd.utm_source !== undefined) push("utm_source", upd.utm_source);
  if (upd.utm_medium !== undefined) push("utm_medium", upd.utm_medium);
  if (upd.utm_campaign !== undefined) push("utm_campaign", upd.utm_campaign);
  if (upd.utm_content !== undefined) push("utm_content", upd.utm_content);
  if (upd.notes !== undefined) push("notes", upd.notes);
  if (upd.next_action_label !== undefined) push("next_action_label", upd.next_action_label);
  if (upd.next_action_account !== undefined) push("next_action_account", upd.next_action_account);
  if (upd.next_action_by !== undefined) push("next_action_by", upd.next_action_by);
  if (upd.next_action_sync_status !== undefined) push("next_action_sync_status", upd.next_action_sync_status);
  if (upd.next_action_sync_error !== undefined) push("next_action_sync_error", upd.next_action_sync_error);
  if (upd.next_action_at !== undefined) {
    args.push(upd.next_action_at ? new Date(upd.next_action_at).toISOString() : null);
    set.push(`next_action_at=$${args.length}::timestamptz`);
  }
  if (upd.score !== undefined) push("score", upd.score);
  if (upd.systemeio_contact_id !== undefined) push("systemeio_contact_id", upd.systemeio_contact_id);
  if (upd.systemeio_account !== undefined) push("systemeio_account", upd.systemeio_account);
  if (!set.length) return;
  set.push("updated_at=now()");
  args.push(currentWorkspaceId());
  await pool.query(`UPDATE app_contacts SET ${set.join(",")} WHERE phone=$1 AND tenant_id=$${args.length}`, args);
}

/** Borra un contacto (hard delete). Borra también notas/clicks asociados por integridad. */
export async function dbDeleteContact(phone: string): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const c = mem.contacts.get(contactMemKey(phone));
    if (c && (c.tenant_id || "default") === tenantId) { mem.contacts.delete(contactMemKey(phone)); mem.conversations.delete(contactMemKey(phone)); }
    // SUPRESION-FB-1 · las entradas por comentario de Facebook (app_fb_entradas) guardan el teléfono: se van con el contacto,
    // haya o no ficha (la entrada sobrevive a una ficha ya borrada).
    for (const [k, x] of [...memFbEntradas.entries()]) if (x.tenant_id === tenantId && x.phone === phone) memFbEntradas.delete(k);
    // OPPS-HUERFANAS-1 · sus oportunidades se van con él: si no, seguían contando en el pipeline sin nadie detrás.
    for (let i = memOpps.length - 1; i >= 0; i--) if (memOpps[i].tenant_id === tenantId && memOpps[i].phone === phone) memOpps.splice(i, 1);
    return;
  }
  await pool.query("DELETE FROM app_contact_notes WHERE phone=$1 AND tenant_id=$2", [phone, tenantId]);
  // SUPRESION-FB-1 · RGPD: la entrada «este comentario abrió esta conversación» es un dato personal (teléfono + publicación):
  // sin esto, tras «eliminar mis datos» la persona seguía en la lista de conversaciones de la publicación.
  await pool.query("DELETE FROM app_fb_entradas WHERE phone=$1 AND tenant_id=$2", [phone, tenantId]);
  // OPPS-HUERFANAS-1 · las oportunidades de la persona se van con ella (antes quedaban contando en el pipeline).
  await pool.query("DELETE FROM app_opportunities WHERE phone=$1 AND tenant_id=$2", [phone, tenantId]);
  // RGPD: borra también el HILO (las preferencias/datos citados en el chat viven en
  // app_conversations) → supresión real tras "eliminar mis datos".
  await pool.query("DELETE FROM app_conversations WHERE user_id=$1 AND tenant_id=$2", [phone, tenantId]);
  convInvalidar(tenantId); // BANDEJA-CACHE-1
  await pool.query("DELETE FROM app_contacts WHERE phone=$1 AND tenant_id=$2", [phone, tenantId]);
}

/** Búsqueda + filtros para bandeja/contactos. */
export interface ContactFilter {
  q?: string;         // busca por nombre, tel, email, tag
  stage?: string;
  source?: string;
  human?: boolean;
  owner?: string;       // dueño exacto; '' = sin asignar (pool)
  inWindow24h?: boolean;
  minScore?: number;
  /** Contención AND: el contacto debe tener TODAS estas etiquetas. Se aplica
   *  en SQL (tags @> jsonb) ANTES del LIMIT — filtrar por etiquetas en memoria
   *  sobre una página ya recortada dejaba fuera contactos válidos (difusión). */
  tags?: string[];
  /** Exclusión OR: el contacto no debe tener NINGUNA de estas etiquetas. Es el
   *  complemento de `tags`, y el filtro que faltaba para poder decir «a todos
   *  menos a los que ya compraron» sin ir desmarcándolos a mano. También en SQL,
   *  antes del LIMIT, por el mismo motivo. */
  excludeTags?: string[];
  /** Respondió hace MENOS de N días. En días y no en epoch a propósito: el
   *  segmento de una difusión programada se guarda y se vuelve a resolver el día
   *  del envío, así que tiene que significar «los últimos 30 días» entonces, no
   *  el rango congelado del día que se programó. */
  activeWithinDays?: number;
  /** Lleva MÁS de N días sin responder (dormidos, para reenganche). */
  inactiveForDays?: number;
  /** Versiones MULTIVALOR de stage/owner/source: el contacto vale si coincide con
   *  CUALQUIERA de la lista (OR). Conviven con las de un solo valor —que siguen
   *  usando otras vistas— y se aplican además de ellas, nunca en su lugar.
   *  En `owners`, la cadena vacía significa «sin asignar»; en `pipelines`, «sin
   *  pipeline», así que ninguna de las dos puede tratarse como «no filtres». */
  stages?: string[];
  owners?: string[];
  sources?: string[];
  /** Pipeline al que pertenece el contacto (fields.pipeline_id). */
  pipelines?: string[];
  /** DIFUSION-UNIVERSO-1 · deja SOLO a quien una difusión puede alcanzar de verdad:
   *  fuera quien pidió no-molestar y fuera quien no es de WhatsApp. Va en SQL, ANTES
   *  del LIMIT, por dos motivos que se pagaron caros:
   *   1) el COUNT y el listado cuentan el MISMO universo — si estos dos descartes se
   *      hacen después, en memoria, el «cumplen el segmento N contactos» que se le
   *      enseña al dueño incluye a miles que jamás iban a recibir el mensaje, y el
   *      «X no la recibieron» se los apunta al recorte;
   *   2) la página de 2000 se llena con 2000 ALCANZABLES. Filtrando después, de los
   *      2000 traídos se caían los de baja y los de Instagram y la difusión salía a
   *      1700 habiendo 7000 candidatos esperando. */
  alcanzablePorDifusion?: boolean;
  /* CONTACTOS-PAGINA-1 · Los filtros que ANTES se resolvían en memoria dentro de
   * /admin/api/contacts. Estaban ahí porque la etiqueta legible de la cuenta se
   * calcula en el handler; pero el DATO por el que se filtra (channel_account,
   * systemeio_contact_id, systemeio_account, etapa vacía) sí es una columna, así
   * que puede ir en SQL. Sin ellos no hay paginación de verdad: había que
   * traerse el listado entero antes de poder filtrar. */
  /** Cuenta por la que entró el contacto. La cadena vacía significa «sin cuenta
   *  asignada», que es un valor elegible: no puede leerse como «no filtres». */
  channelAccount?: string;
  /** Si está copiado en una web conectada: 'none' = no lo está; 'sinCuenta' = lo
   *  está pero no sabemos en cuál. */
  sioState?: "none" | "sinCuenta";
  /** Copiado en ESTA web conectada. */
  sioAccount?: string;
  /** Solo los que NO tienen etapa. Igual que arriba: la etapa vacía es un valor,
   *  y `stage: ''` se leería como «sin filtro». */
  stageNone?: boolean;
  /** Rango de fechas del listado, en milisegundos. `dateField` dice sobre qué
   *  fecha se aplica; sin él no se filtra por fecha. */
  dateField?: "last_inbound" | "created_at";
  dateFrom?: number;
  dateTo?: number;
  /** PORTADA-LEADS-1 (MET-LEADS-01) · solo estos teléfonos; [] = nadie, nunca «no filtres». */
  phones?: string[];
  /** PORTADA-LEADS-1 · true = escribió alguna vez por un canal conectado; false = nunca (last_inbound en la época). */
  conMensajes?: boolean;
  /** Orden del listado. Sin esto el orden era SIEMPRE last_inbound DESC y la
   *  tabla reordenaba en el navegador solo las filas cargadas: pedir «los de más
   *  interés» devolvía los de más interés ENTRE los mil más recientes. */
  orderBy?: "last_inbound" | "created_at" | "name" | "stage" | "score";
  orderDir?: "asc" | "desc";
  /** Cuántas filas saltar. Con `limit`, la página que se pide. */
  offset?: number;
  limit?: number;
  /**
   * SEC-1: workspace dueño del filtro. Si llega, SIEMPRE se aplica como
   * primer WHERE en SQL y como primer filtro en memoria. El caller que
   * no lo pase queda en modo legacy single-tenant (compatibilidad), pero
   * todos los call-sites multi-tenant (broadcast-flows, broadcasts.ts)
   * DEBEN pasarlo para evitar fuga cross-WS.
   */
  tenantId?: string;
}
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * DIFUSION-UNIVERSO-1 · la etiqueta de baja, EN UN SOLO SITIO.
 *
 * Vive en la capa de datos, y no donde se etiqueta, porque el filtro SQL de contactos
 * la necesita y `contacts.ts` ya importa de este módulo (al revés sería un ciclo).
 * `contacts.ts` la reexporta como `OPT_OUT_TAG`, que es el nombre con el que la conoce
 * el resto del código: una sola cadena, un solo sitio. Si se escribiera dos veces, una
 * de las dos copias acabaría excluyendo a gente que la otra sigue enviando.
 *
 * Se llama "no-molestar" y no "baja" a propósito: "baja" es una palabra demasiado común
 * en español (baja laboral, tramitar una baja) y muchos negocios ya la usan como
 * etiqueta con otro sentido. Si reutilizáramos ese nombre, esos contactos dejarían de
 * recibir difusiones sin haberlo pedido nunca, y en silencio.
 */
export const ETIQUETA_NO_MOLESTAR = "no-molestar";

/**
 * DIFUSION-UNIVERSO-1 · ¿puede una difusión llegar a este contacto?
 *
 * Dos descartes, y los dos son de los que hunden un informe sin dejar rastro:
 *  · quien pidió no recibir más mensajes queda fuera se filtre como se filtre;
 *  · quien no es de WhatsApp. Un contacto de Instagram/Facebook guarda su IGSID/PSID
 *    en `phone`, así que pasaba cualquier filtro y se le intentaba enviar por la Cloud
 *    API: el envío falla SIEMPRE (ese "número" no existe) y hunde la tasa de entrega
 *    sin causa visible. `channel_account` es el dato fiable: lo escriben ig:/fb: al
 *    crear el contacto.
 *
 * Esta función es la versión en memoria; `contactSqlWhere` tiene la MISMA condición en
 * SQL. Las dos ramas se escriben juntas a propósito: el día que se separen, el contador
 * dirá un número y el envío usará otro.
 */
export function contactoAlcanzablePorDifusion(c: {
  phone?: string | null;
  tags?: string[] | null;
  channel_account?: string | null;
  source?: string | null;
}): boolean {
  if ((c.tags || []).includes(ETIQUETA_NO_MOLESTAR)) return false;
  const tel = c.phone || "";
  if (!tel || /^(email|ig|fb):/.test(tel)) return false;
  const cuenta = c.channel_account || "";
  if (cuenta.startsWith("ig:") || cuenta.startsWith("fb:")) return false;
  if (!cuenta.startsWith("wa:") && (c.source === "instagram" || c.source === "facebook")) return false;
  return true;
}

/** El filtro de contactos, EN UN SOLO SITIO (rama memoria).
 *
 *  Antes esta lista de condiciones estaba copiada en dbSearchContacts y en
 *  dbCountContacts. Cada filtro nuevo había que escribirlo dos veces y, si se
 *  olvidaba una, el contador decía un número y el envío usaba otro — que es
 *  exactamente el fallo que se pagó caro en Difusión. Ahora se escribe una vez. */
function contactMemMatch(f: ContactFilter, c: Contact): boolean {
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!(c.phone.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q)))) return false;
  }
  if (f.stage && c.stage !== f.stage) return false;
  if (f.source && c.source !== f.source) return false;
  if (f.human !== undefined && c.human !== f.human) return false;
  if (f.owner !== undefined && (c.owner || "") !== f.owner) return false;
  if (f.inWindow24h !== undefined && (c.last_inbound >= Date.now() - DIA_MS) !== f.inWindow24h) return false;
  if (f.minScore !== undefined && c.score < f.minScore) return false;
  if (f.tags && f.tags.length && !f.tags.every((t) => (c.tags || []).includes(t))) return false;
  if (f.excludeTags && f.excludeTags.length && f.excludeTags.some((t) => (c.tags || []).includes(t))) return false;
  if (f.activeWithinDays !== undefined && c.last_inbound < Date.now() - f.activeWithinDays * DIA_MS) return false;
  if (f.inactiveForDays !== undefined && c.last_inbound >= Date.now() - f.inactiveForDays * DIA_MS) return false;
  if (f.stages && f.stages.length && !f.stages.includes(c.stage || "")) return false;
  if (f.owners && f.owners.length && !f.owners.includes(c.owner || "")) return false;
  if (f.sources && f.sources.length && !f.sources.includes(c.source || "")) return false;
  if (f.pipelines && f.pipelines.length &&
      !f.pipelines.includes(String(((c.fields || {}) as Record<string, unknown>).pipeline_id || ""))) return false;
  // DIFUSION-UNIVERSO-1 · el mismo universo que la rama SQL, para que el conteo y el
  // envío no puedan discrepar según haya o no base de datos.
  if (f.alcanzablePorDifusion === true && !contactoAlcanzablePorDifusion(c)) return false;
  // CONTACTOS-PAGINA-1 · Las mismas condiciones que la rama SQL, una por una: si
  // aquí falta alguna, el panel en memoria enseña filas que Postgres no enseñaría.
  if (f.channelAccount !== undefined && (c.channel_account || "") !== f.channelAccount) return false;
  if (f.sioState === "none" && (c.systemeio_contact_id || "")) return false;
  if (f.sioState === "sinCuenta" && !((c.systemeio_contact_id || "") && !(c.systemeio_account || ""))) return false;
  if (f.sioAccount !== undefined && (c.systemeio_account || "") !== f.sioAccount) return false;
  if (f.stageNone && (c.stage || "")) return false;
  // PORTADA-LEADS-1 (MET-LEADS-01) · gemelas de la rama SQL.
  if (f.phones !== undefined && !f.phones.includes(c.phone)) return false;
  if (f.conMensajes !== undefined && ((c.last_inbound || 0) > 0) !== f.conMensajes) return false;
  if (f.dateField) {
    const v = f.dateField === "created_at" ? c.created_at : c.last_inbound;
    if (f.dateFrom && v < f.dateFrom) return false;
    if (f.dateTo && v > f.dateTo) return false;
  }
  return true;
}

/** CONTACTOS-PAGINA-1 · El orden del listado, rama memoria. Mismo criterio que la
 *  rama SQL: los textos se comparan sin distinguir mayúsculas, y el desempate
 *  siempre es la actividad más reciente para que dos páginas seguidas no se
 *  solapen ni se salten a nadie. */
function contactMemSort(f: ContactFilter, a: Contact, b: Contact): number {
  const dir = f.orderDir === "asc" ? 1 : -1;
  const col = f.orderBy || "last_inbound";
  let d = 0;
  if (col === "name") d = (a.name || "").toLowerCase().localeCompare((b.name || "").toLowerCase(), "es");
  else if (col === "stage") d = (a.stage || "").toLowerCase().localeCompare((b.stage || "").toLowerCase(), "es");
  else if (col === "score") d = (a.score || 0) - (b.score || 0);
  else if (col === "created_at") d = a.created_at - b.created_at;
  else d = a.last_inbound - b.last_inbound;
  if (d !== 0) return d * dir;
  return b.last_inbound - a.last_inbound || a.phone.localeCompare(b.phone);
}

/** El mismo filtro, rama SQL. Devuelve las condiciones y sus argumentos ya
 *  numerados; el llamador solo compone el SELECT. */
function contactSqlWhere(f: ContactFilter, tenantId: string | undefined): { where: string[]; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  const push = (clause: string, val?: unknown) => {
    if (val !== undefined) args.push(val);
    where.push(clause.replace(/\$\?/g, "$" + args.length));
  };
  // SEC-1: tenant_id SIEMPRE como primera condición.
  push("tenant_id=$?", tenantId);
  if (f.q) push(`(name ILIKE $? OR phone ILIKE $? OR email ILIKE $? OR tags::text ILIKE $?)`, `%${f.q}%`);
  if (f.stage !== undefined) push("stage=$?", f.stage);
  if (f.source !== undefined) push("source=$?", f.source);
  if (f.human !== undefined) push("human=$?", f.human);
  if (f.owner !== undefined) push("coalesce(owner,'')=$?", f.owner);
  if (f.inWindow24h === true) where.push("last_inbound>=now()-interval '24 hours'");
  if (f.inWindow24h === false) where.push("last_inbound<now()-interval '24 hours'");
  if (f.minScore !== undefined) push("score>=$?", f.minScore);
  if (f.tags && f.tags.length) push("tags @> $?::jsonb", JSON.stringify(f.tags));
  // Una condición por etiqueta excluida: `tags @> '[a,b]'` significa «las tiene
  // TODAS», así que negarlo dejaría pasar a quien tuviera solo una de ellas.
  if (f.excludeTags) for (const t of f.excludeTags) push("NOT (tags @> $?::jsonb)", JSON.stringify([t]));
  if (f.activeWithinDays !== undefined) push("last_inbound >= now() - make_interval(days => $?::int)", Math.round(f.activeWithinDays));
  if (f.inactiveForDays !== undefined) push("last_inbound < now() - make_interval(days => $?::int)", Math.round(f.inactiveForDays));
  // Multivalor = OR dentro del filtro (= ANY), AND con los demás. coalesce en los
  // tres que pueden venir vacíos: '' es un valor elegible («sin asignar», «sin
  // pipeline»), y sin el coalesce un NULL nunca casaría con él.
  if (f.stages && f.stages.length) push("stage = ANY($?::text[])", f.stages);
  if (f.owners && f.owners.length) push("coalesce(owner,'') = ANY($?::text[])", f.owners);
  if (f.sources && f.sources.length) push("coalesce(source,'') = ANY($?::text[])", f.sources);
  if (f.pipelines && f.pipelines.length) push("coalesce(fields->>'pipeline_id','') = ANY($?::text[])", f.pipelines);
  // DIFUSION-UNIVERSO-1 · gemela de contactoAlcanzablePorDifusion, en SQL y ANTES del
  // LIMIT. La baja va con `push` porque lleva argumento; el resto son comparaciones con
  // literales y no consumen ninguno.
  if (f.alcanzablePorDifusion === true) {
    push("NOT (tags @> $?::jsonb)", JSON.stringify([ETIQUETA_NO_MOLESTAR]));
    where.push(
      "coalesce(phone,'') <> '' AND coalesce(phone,'') !~ '^(email|ig|fb):'" +
        " AND coalesce(channel_account,'') NOT LIKE 'ig:%'" +
        " AND coalesce(channel_account,'') NOT LIKE 'fb:%'" +
        " AND (coalesce(channel_account,'') LIKE 'wa:%'" +
        " OR coalesce(source,'') NOT IN ('instagram','facebook'))",
    );
  }
  // CONTACTOS-PAGINA-1 · coalesce en los cuatro: la cadena vacía es un valor
  // elegible («sin cuenta», «sin etapa») y un NULL nunca casaría con ella.
  if (f.channelAccount !== undefined) push("coalesce(channel_account,'')=$?", f.channelAccount);
  if (f.sioState === "none") where.push("coalesce(systemeio_contact_id,'')=''");
  if (f.sioState === "sinCuenta") where.push("coalesce(systemeio_contact_id,'')<>'' AND coalesce(systemeio_account,'')=''");
  if (f.sioAccount !== undefined) push("coalesce(systemeio_account,'')=$?", f.sioAccount);
  if (f.stageNone) where.push("coalesce(stage,'')=''");
  // PORTADA-LEADS-1 (MET-LEADS-01) · «no escribió nunca» = last_inbound en la época:
  // las fichas creadas desde el panel la guardan así (la columna no admite NULL).
  if (f.phones !== undefined) push("phone = ANY($?::text[])", f.phones);
  if (f.conMensajes === true) where.push("last_inbound > to_timestamp(0)");
  if (f.conMensajes === false) where.push("last_inbound <= to_timestamp(0)");
  if (f.dateField) {
    const col = f.dateField === "created_at" ? "created_at" : "last_inbound";
    if (f.dateFrom) push(col + ">=to_timestamp($?::bigint/1000.0)", Math.round(f.dateFrom));
    if (f.dateTo) push(col + "<=to_timestamp($?::bigint/1000.0)", Math.round(f.dateTo));
  }
  return { where, args };
}

/** CONTACTOS-PAGINA-1 · El ORDER BY del listado. Lista blanca cerrada: la columna
 *  llega de la URL y se interpola en el SQL, así que nunca puede salir de aquí.
 *  El desempate por last_inbound y phone es obligatorio: sin un orden total, dos
 *  páginas consecutivas pueden repetir a alguien y saltarse a otro. */
function contactOrderBy(f: ContactFilter): string {
  const dir = f.orderDir === "asc" ? "ASC" : "DESC";
  const col = f.orderBy === "name" ? "lower(coalesce(name,''))"
    : f.orderBy === "stage" ? "lower(coalesce(stage,''))"
    : f.orderBy === "score" ? "score"
    : f.orderBy === "created_at" ? "created_at"
    : "last_inbound";
  return `ORDER BY ${col} ${dir}, last_inbound DESC, phone ASC`;
}

export async function dbSearchContacts(f: ContactFilter = {}): Promise<Contact[]> {
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 2000);
  // CONTACTOS-PAGINA-1 · el salto de página. Entero y nunca negativo: llega de la URL.
  const offset = Math.max(0, Math.round(Number(f.offset) || 0));
  // WS-ISOLATION 2026-06-04: si no se pasa tenantId explicito, defaultear al ws
  // activo. El caller que necesite cross-WS debe pasar tenantId:'__all__' (no soportado
  // hoy, exigirlo deliberadamente).
  const effectiveTenantId = f.tenantId !== undefined ? f.tenantId : currentWorkspaceId();
  if (!pool) {
    let arr = [...mem.contacts.values()];
    if (effectiveTenantId !== undefined) {
      arr = arr.filter((c) => ((c as unknown as { tenant_id?: string }).tenant_id || "default") === effectiveTenantId);
    }
    arr = arr.filter((c) => contactMemMatch(f, c));
    // CONTACTOS-PAGINA-1 · mismo orden y mismo salto que la rama SQL.
    return arr.sort((a, b) => contactMemSort(f, a, b)).slice(offset, offset + limit);
  }
  // WS-ISOLATION 2026-06-04: default al workspace activo si no se pasa explicito.
  const { where, args } = contactSqlWhere(f, effectiveTenantId);
  const sql = `SELECT ${CFIELDS} FROM app_contacts ${where.length ? "WHERE " + where.join(" AND ") : ""} ${contactOrderBy(f)} LIMIT ${limit}${offset ? ` OFFSET ${offset}` : ""}`;
  // Hack para $?: reescribimos con índices secuenciales.
  let i = 0;
  const finalSql = sql.replace(/\$\?/g, () => "$" + (++i));
  const r = await pool.query(finalSql, args);
  return r.rows.map(rowToContact);
}

/**
 * COUNT real de contactos que cumplen el filtro: MISMOS WHERE que
 * dbSearchContacts pero SIN LIMIT. Lo usa /admin/api/contacts para que
 * «Total» sea el total del workspace y no el tamaño de la página traída
 * (con >1000 contactos el panel decía «Total: 1000» — página contada
 * como total).
 */
export async function dbCountContacts(f: ContactFilter = {}): Promise<number> {
  const effectiveTenantId = f.tenantId !== undefined ? f.tenantId : currentWorkspaceId();
  if (!pool) {
    let arr = [...mem.contacts.values()];
    if (effectiveTenantId !== undefined) {
      arr = arr.filter((c) => ((c as unknown as { tenant_id?: string }).tenant_id || "default") === effectiveTenantId);
    }
    arr = arr.filter((c) => contactMemMatch(f, c));
    return arr.length;
  }
  const { where, args } = contactSqlWhere(f, effectiveTenantId);
  const r = await pool.query(
    `SELECT COUNT(*)::int n FROM app_contacts ${where.length ? "WHERE " + where.join(" AND ") : ""}`,
    args,
  );
  return Number(r.rows[0]?.n || 0);
}

/**
 * MUDANZA-ETAPA-1 (PIP-03) · Pasa a la etapa `a` a TODOS los contactos que cumplen el
 * filtro (en la práctica: una etapa de un pipeline), en UNA sola sentencia. Hace lo
 * mismo que setStageWithTag contacto a contacto —etapa nueva y la etiqueta «📍» de la
 * etapa sustituida, el resto de etiquetas intactas y en su orden— pero sin ir y volver
 * a la base por cada uno: así, 2.300 contactos tardaban 108 s, dentro del guardado del
 * editor, y el proxy podía cortar la petición a medias. Al ser una sola sentencia,
 * además, o se mudan todos o ninguno, y lee las etiquetas en el momento de escribir
 * (no pisa una etiqueta que otro proceso haya puesto entretanto).
 * Acotado al workspace activo por el mismo constructor que el listado (tenant_id va
 * siempre primero). Devuelve cuántos contactos ha movido.
 * Con `pipelineId`, su ficha pasa además a señalar ese pipeline (`fields.pipeline_id`),
 * como hace setStageWithTag cuando se le pasa.
 */
export async function dbMoverEtapaContactos(f: ContactFilter, a: string, prefijoEtiqueta: string, pipelineId?: string): Promise<number> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    let n = 0;
    for (const c of mem.contacts.values()) {
      if ((c.tenant_id || "default") !== tenantId || !contactMemMatch(f, c)) continue;
      const base = (c.tags || []).filter((t) => !String(t).startsWith(prefijoEtiqueta));
      c.tags = a ? [...base, prefijoEtiqueta + a] : base;
      c.stage = a;
      if (pipelineId !== undefined) c.fields = { ...(c.fields || {}), pipeline_id: pipelineId };
      c.updated_at = Date.now();
      n++;
    }
    return n;
  }
  const { where, args } = contactSqlWhere(f, tenantId);
  args.push(a, prefijoEtiqueta);
  const pA = "$" + (args.length - 1) + "::text", pP = "$" + args.length + "::text";
  let setPipe = "";
  if (pipelineId !== undefined) {
    args.push(pipelineId);
    setPipe = ` fields=(CASE WHEN jsonb_typeof(fields)='object' THEN fields ELSE '{}'::jsonb END) || jsonb_build_object('pipeline_id', $${args.length}::text),`;
  }
  const r = await pool.query(
    `UPDATE app_contacts SET stage=${pA},` +
      ` tags=coalesce((SELECT jsonb_agg(e.t ORDER BY e.o) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(tags)='array' THEN tags ELSE '[]'::jsonb END) WITH ORDINALITY AS e(t,o)` +
      ` WHERE NOT (jsonb_typeof(e.t)='string' AND left(e.t #>> '{}', char_length(${pP}))=${pP})),'[]'::jsonb)` +
      ` || (CASE WHEN ${pA}='' THEN '[]'::jsonb ELSE jsonb_build_array(${pP} || ${pA}) END),` +
      setPipe +
      ` updated_at=now() WHERE ${where.join(" AND ")}`,
    args,
  );
  return r.rowCount || 0;
}

/**
 * CONTACTOS-PAGINA-1 · Catálogo de etiquetas del workspace, con cuántos contactos
 * tiene cada una, de más usada a menos y filtrable por texto EN LA CONSULTA.
 *
 * El selector de etiquetas de Contactos recibía las 120 más usadas y buscaba
 * sobre esa lista en el navegador: a una etiqueta poco frecuente respondía
 * «no existe» cuando sí existía. Ahora la búsqueda baja a la base de datos.
 *
 * `prefijoOculto` deja fuera las etiquetas «📍 <etapa>», que las pone y las quita
 * el panel solo: son una convención interna, no etiquetas del usuario.
 */
export async function dbContactTagCounts(
  q: string,
  limit: number,
  prefijoOculto: string,
): Promise<Array<{ tag: string; count: number }>> {
  const tenantId = currentWorkspaceId();
  const lim = Math.min(Math.max(Math.round(limit) || 50, 1), 500);
  const needle = String(q || "").trim().toLowerCase();
  if (!pool) {
    const cuenta = new Map<string, number>();
    for (const c of mem.contacts.values()) {
      if (((c as unknown as { tenant_id?: string }).tenant_id || "default") !== tenantId) continue;
      for (const t of (c.tags || [])) {
        const k = String(t).trim();
        if (!k || (prefijoOculto && k.startsWith(prefijoOculto))) continue;
        if (needle && !k.toLowerCase().includes(needle)) continue;
        cuenta.set(k, (cuenta.get(k) || 0) + 1);
      }
    }
    return [...cuenta.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "es"))
      .slice(0, lim);
  }
  const r = await pool.query(
    `SELECT t AS tag, COUNT(*)::int n
       FROM app_contacts c, LATERAL jsonb_array_elements_text(c.tags) t
      WHERE c.tenant_id=$1
        AND btrim(t) <> ''
        AND ($2 = '' OR t NOT LIKE $2 || '%')
        AND ($3 = '' OR position($3 in lower(t)) > 0)
      GROUP BY t
      ORDER BY n DESC, t ASC
      LIMIT ${lim}`,
    [tenantId, prefijoOculto || "", needle],
  );
  return r.rows.map((x: { tag: string; n: number }) => ({ tag: String(x.tag), count: Number(x.n || 0) }));
}

/**
 * CONTEO-FILTROS-1 (CTO-04) · Los números de los desplegables de Contactos, contados
 * en la base de datos sobre TODOS los contactos del negocio que cumplen el filtro.
 *
 * Antes salían de un barrido en memoria capado a los 1.000 más recientes, y el panel
 * tenía que poner una nota diciendo que no eran el total. Cada dimensión se agrupa
 * con el MISMO WHERE que la página (contactSqlWhere / contactMemMatch): el llamador
 * decide qué filtros quitar para cada desplegable (el suyo propio).
 *
 *  - "stage":    clave = etapa ('' = sin etapa)
 *  - "pipeline": clave = pipeline_id ('' = sin pipeline)
 *  - "account":  clave = channel_account ('' = sin cuenta), con un bot_id, source y
 *                phone de muestra para resolver el nombre legible de la cuenta
 *  - "sio":      clave = systemeio_account, sub = '1' si está sincronizado
 *  - "tags":     clave = etiqueta (sin las «📍 etapa» internas), filtrable por texto
 *                y con tope; de más usada a menos.
 */
export type ContactFacetDim = "stage" | "pipeline" | "account" | "sio" | "tags";
export interface ContactFacetRow { key: string; sub: string; n: number; bot_id: string; source: string; phone: string }
export async function dbContactFacetCounts(
  f: ContactFilter,
  dim: ContactFacetDim,
  opts: { q?: string; limit?: number; prefijoOculto?: string } = {},
): Promise<ContactFacetRow[]> {
  const effectiveTenantId = f.tenantId !== undefined ? f.tenantId : currentWorkspaceId();
  const lim = Math.min(Math.max(Math.round(opts.limit || 500), 1), 2000);
  const needle = String(opts.q || "").trim().toLowerCase();
  const prefijo = opts.prefijoOculto || "";
  if (!pool) {
    let arr = [...mem.contacts.values()];
    if (effectiveTenantId !== undefined) {
      arr = arr.filter((c) => ((c as unknown as { tenant_id?: string }).tenant_id || "default") === effectiveTenantId);
    }
    arr = arr.filter((c) => contactMemMatch(f, c));
    const m = new Map<string, ContactFacetRow>();
    const suma = (key: string, sub: string, c: Contact) => {
      const id = key + "\u0000" + sub;
      const cur = m.get(id);
      if (cur) { cur.n++; return; }
      m.set(id, { key, sub, n: 1, bot_id: c.bot_id || "", source: c.source || "", phone: c.phone || "" });
    };
    for (const c of arr) {
      if (dim === "stage") suma(c.stage || "", "", c);
      else if (dim === "pipeline") suma(String(((c.fields || {}) as Record<string, unknown>).pipeline_id || ""), "", c);
      else if (dim === "account") suma(c.channel_account || "", "", c);
      else if (dim === "sio") suma(c.systemeio_account || "", (c.systemeio_contact_id || "") ? "1" : "", c);
      else {
        for (const t of new Set(c.tags || [])) {
          const k = String(t);
          if (!k.trim() || (prefijo && k.startsWith(prefijo))) continue;
          if (needle && !k.toLowerCase().includes(needle)) continue;
          suma(k, "", c);
        }
      }
    }
    const out = [...m.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key, "es"));
    return dim === "tags" ? out.slice(0, lim) : out;
  }
  const { where, args } = contactSqlWhere(f, effectiveTenantId);
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  let sql: string;
  if (dim === "tags") {
    args.push(prefijo);
    const pPref = "$" + args.length;
    args.push(needle);
    const pQ = "$" + args.length;
    // DISTINCT por contacto: una etiqueta repetida en el mismo contacto cuenta una vez,
    // igual que la contención @> con la que se filtra.
    sql = `SELECT e.tag AS key, '' AS sub, COUNT(DISTINCT app_contacts.phone)::int n, '' AS bot_id, '' AS source, '' AS phone
             FROM app_contacts, LATERAL jsonb_array_elements_text(app_contacts.tags) AS e(tag)
             ${W}${W ? " AND" : "WHERE"} btrim(e.tag) <> ''
              AND (${pPref} = '' OR e.tag NOT LIKE ${pPref} || '%')
              AND (${pQ} = '' OR position(${pQ} in lower(e.tag)) > 0)
            GROUP BY e.tag
            ORDER BY n DESC, e.tag ASC
            LIMIT ${lim}`;
  } else {
    const col = dim === "stage" ? "coalesce(stage,'')"
      : dim === "pipeline" ? "coalesce(fields->>'pipeline_id','')"
      : dim === "account" ? "coalesce(channel_account,'')"
      : "coalesce(systemeio_account,'')";
    const subCol = dim === "sio" ? "(CASE WHEN coalesce(systemeio_contact_id,'')<>'' THEN '1' ELSE '' END)" : "''";
    sql = `SELECT ${col} AS key, ${subCol} AS sub, COUNT(*)::int n,
                  coalesce(min(bot_id),'') AS bot_id, coalesce(min(source),'') AS source, coalesce(min(phone),'') AS phone
             FROM app_contacts ${W}
            GROUP BY 1, 2
            ORDER BY n DESC, 1 ASC`;
  }
  const r = await pool.query(sql, args);
  return r.rows.map((x: Record<string, unknown>) => ({
    key: String(x.key ?? ""), sub: String(x.sub ?? ""), n: Number(x.n || 0),
    bot_id: String(x.bot_id ?? ""), source: String(x.source ?? ""), phone: String(x.phone ?? ""),
  }));
}

// ---- Notas por contacto (historial) ----
export interface ContactNote {
  id: number;
  tenant_id: string;
  phone: string;
  kind: string; // 'note' | 'system' | 'next-action' | 'systemeio-sync'
  body: string;
  author: string;
  created_at: number;
}
export async function dbAddContactNote(n: Omit<ContactNote, "id" | "created_at">): Promise<void> {
  if (!pool) return; // memoria no almacena historial, lo deja en contact.notes
  await pool.query(
    "INSERT INTO app_contact_notes (tenant_id,phone,kind,body,author) VALUES ($1,$2,$3,$4,$5)",
    [n.tenant_id || "default", n.phone, n.kind, n.body, n.author],
  );
}
export async function dbListContactNotes(phone: string, limit = 50, tenantId?: string): Promise<ContactNote[]> {
  if (!pool) return [];
  // Multi-tenant: sin el filtro, un mismo teléfono presente en dos workspaces
  // mezclaba las notas de ambos (fuga cross-tenant). tenantId opcional para
  // compat: sin él, comportamiento previo.
  const r = tenantId
    ? await pool.query(
        "SELECT id,tenant_id,phone,kind,body,author, extract(epoch from created_at)*1000 created_at FROM app_contact_notes WHERE phone=$1 AND tenant_id=$3 ORDER BY created_at DESC LIMIT $2",
        [phone, limit, tenantId],
      )
    : await pool.query(
        "SELECT id,tenant_id,phone,kind,body,author, extract(epoch from created_at)*1000 created_at FROM app_contact_notes WHERE phone=$1 ORDER BY created_at DESC LIMIT $2",
        [phone, limit],
      );
  return r.rows.map((x: any) => ({ ...x, id: Number(x.id), created_at: Number(x.created_at) }));
}

// ---- OPORTUNIDADES-1 (PIP-01) · posibles ventas ----
export interface Opportunity {
  id: number;
  tenant_id: string;
  phone: string;
  pipeline_id: string;
  stage: string;
  outcome: "" | "won" | "lost";
  owner: string;
  value: number | null;
  next_action: string;
  next_at: number;
  origin: string;
  reason: string;
  created_at: number;
  updated_at: number;
  closed_at: number;
  // Datos de la persona (unidos al leer, nunca guardados aquí).
  name?: string;
  last_inbound?: number;
  contact_created_at?: number;
  source?: string;
  channel_account?: string;
  avatar_url?: string;
}
export type OpportunityPatch = Partial<Pick<Opportunity, "pipeline_id" | "stage" | "outcome" | "owner" | "value" | "next_action" | "next_at">>;
const memOpps: Opportunity[] = [];
let memOppSeq = 0;
const OPP_COLS = "o.id,o.tenant_id,o.phone,o.pipeline_id,o.stage,o.outcome,o.owner,o.value,o.next_action,o.next_at,o.origin,o.reason," +
  "extract(epoch from o.created_at)*1000 created_at, extract(epoch from o.updated_at)*1000 updated_at, coalesce(extract(epoch from o.closed_at)*1000,0) closed_at";
const OPP_FROM = ", c.name, extract(epoch from c.last_inbound)*1000 last_inbound, extract(epoch from c.created_at)*1000 contact_created_at," +
  " c.source, c.channel_account, c.avatar_url" +
  " FROM app_opportunities o LEFT JOIN app_contacts c ON c.phone=o.phone AND c.tenant_id=o.tenant_id";
function oppRow(x: any): Opportunity {
  return {
    ...x, id: Number(x.id), value: x.value == null ? null : Number(x.value), next_at: Number(x.next_at || 0),
    created_at: Number(x.created_at || 0), updated_at: Number(x.updated_at || 0), closed_at: Number(x.closed_at || 0),
    name: x.name || "", last_inbound: x.last_inbound == null ? 0 : Number(x.last_inbound),
    contact_created_at: x.contact_created_at == null ? 0 : Number(x.contact_created_at),
    source: x.source || "", channel_account: x.channel_account || "", avatar_url: x.avatar_url || "",
  };
}
function memOppJoin(o: Opportunity): Opportunity {
  const c = mem.contacts.get(contactMemKey(o.phone, o.tenant_id));
  return { ...o, name: c?.name || "", last_inbound: Number(c?.last_inbound || 0), contact_created_at: Number(c?.created_at || 0),
    source: c?.source || "", channel_account: c?.channel_account || "", avatar_url: c?.avatar_url || "" };
}
/** Oportunidades del workspace activo. El tablero cuenta con dbOpportunityCounts, no con esto. */
export async function dbListOpportunities(f: { pipelineId?: string; phone?: string; open?: boolean; closed?: boolean; limit?: number } = {}): Promise<Opportunity[]> {
  const tenantId = currentWorkspaceId();
  const limit = Math.max(1, Math.min(5000, f.limit || 2000));
  if (!pool) {
    return memOpps
      .filter((o) => o.tenant_id === tenantId
        && (f.pipelineId === undefined || o.pipeline_id === f.pipelineId)
        && (f.phone === undefined || o.phone === f.phone)
        && (!f.open || !o.outcome) && (!f.closed || !!o.outcome))
      .sort((a, b) => b.updated_at - a.updated_at || b.id - a.id).slice(0, limit).map(memOppJoin);
  }
  const w: string[] = ["o.tenant_id=$1"]; const p: unknown[] = [tenantId];
  if (f.pipelineId !== undefined) { p.push(f.pipelineId); w.push("o.pipeline_id=$" + p.length); }
  if (f.phone !== undefined) { p.push(f.phone); w.push("o.phone=$" + p.length); }
  if (f.open) w.push("o.outcome=''");
  if (f.closed) w.push("o.outcome<>''");
  p.push(limit);
  const r = await pool.query(
    "SELECT " + OPP_COLS + OPP_FROM + " WHERE " + w.join(" AND ") + " ORDER BY o.updated_at DESC, o.id DESC LIMIT $" + p.length, p);
  return r.rows.map(oppRow);
}
/** Recuento de TODAS las oportunidades por pipeline, etapa y desenlace (sin muestra ni tope). */
export async function dbOpportunityCounts(): Promise<{ pipeline_id: string; stage: string; outcome: string; n: number }[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const m = new Map<string, { pipeline_id: string; stage: string; outcome: string; n: number }>();
    for (const o of memOpps) {
      if (o.tenant_id !== tenantId) continue;
      const k = JSON.stringify([o.pipeline_id, o.stage, o.outcome]);
      const e = m.get(k) || { pipeline_id: o.pipeline_id, stage: o.stage, outcome: o.outcome, n: 0 };
      e.n++; m.set(k, e);
    }
    return [...m.values()];
  }
  const r = await pool.query(
    "SELECT pipeline_id, stage, outcome, count(*)::int n FROM app_opportunities WHERE tenant_id=$1 GROUP BY 1,2,3",
    [tenantId]);
  return r.rows.map((x: any) => ({ pipeline_id: x.pipeline_id, stage: x.stage, outcome: x.outcome, n: Number(x.n) }));
}
export async function dbGetOpportunity(id: number): Promise<Opportunity | null> {
  const tenantId = currentWorkspaceId();
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (!pool) { const o = memOpps.find((x) => x.id === id && x.tenant_id === tenantId); return o ? memOppJoin(o) : null; }
  const r = await pool.query("SELECT " + OPP_COLS + OPP_FROM + " WHERE o.id=$1 AND o.tenant_id=$2", [id, tenantId]);
  return r.rows[0] ? oppRow(r.rows[0]) : null;
}
export async function dbCreateOpportunity(o: { phone: string; pipeline_id: string; stage: string; outcome?: "" | "won" | "lost"; owner?: string; value?: number | null; next_action?: string; next_at?: number; origin: string; reason: string }): Promise<Opportunity> {
  const tenantId = currentWorkspaceId();
  const outcome = o.outcome || "";
  if (!pool) {
    const now = Date.now();
    const n: Opportunity = { id: ++memOppSeq, tenant_id: tenantId, phone: o.phone, pipeline_id: o.pipeline_id, stage: o.stage, outcome,
      owner: o.owner || "", value: o.value ?? null, next_action: o.next_action || "", next_at: o.next_at || 0, origin: o.origin, reason: o.reason,
      created_at: now, updated_at: now, closed_at: outcome ? now : 0 };
    memOpps.push(n);
    return memOppJoin(n);
  }
  const r = await pool.query(
    "INSERT INTO app_opportunities (tenant_id,phone,pipeline_id,stage,outcome,owner,value,next_action,next_at,origin,reason,closed_at)" +
    " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $5<>'' THEN now() END) RETURNING id",
    [tenantId, o.phone, o.pipeline_id, o.stage, outcome, o.owner || "", o.value ?? null, o.next_action || "", o.next_at || 0, o.origin, o.reason]);
  return (await dbGetOpportunity(Number(r.rows[0].id)))!;
}
/** OPPS-HUERFANAS-1 · borra UNA oportunidad del workspace activo. Devuelve si existía. */
export async function dbDeleteOpportunity(id: number): Promise<boolean> {
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const i = memOpps.findIndex((x) => x.id === id && x.tenant_id === tenantId);
    if (i < 0) return false;
    memOpps.splice(i, 1);
    return true;
  }
  const r = await pool.query("DELETE FROM app_opportunities WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
  return (r.rowCount || 0) > 0;
}
export async function dbUpdateOpportunity(id: number, patch: OpportunityPatch): Promise<Opportunity | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const tenantId = currentWorkspaceId();
  const keys = (["pipeline_id", "stage", "outcome", "owner", "value", "next_action", "next_at"] as const).filter((k) => patch[k] !== undefined);
  if (!pool) {
    const o = memOpps.find((x) => x.id === id && x.tenant_id === tenantId);
    if (!o) return null;
    const antes = o.outcome;
    for (const k of keys) (o as any)[k] = patch[k];
    if (patch.outcome !== undefined && patch.outcome !== antes) o.closed_at = patch.outcome ? Date.now() : 0;
    o.updated_at = Date.now();
    return memOppJoin(o);
  }
  if (keys.length) {
    const p: unknown[] = [id, tenantId];
    const sets = keys.map((k) => { p.push(patch[k]); return k + "=$" + p.length; });
    // El cierre se fecha al pasar a ganada/perdida y se borra al reabrir; si el
    // desenlace no cambia, la fecha de cierre original se conserva. Postgres evalúa
    // el CASE con la fila ANTERIOR, así que «outcome» aquí es el desenlace de antes.
    if (patch.outcome !== undefined) {
      const n = "$" + (keys.indexOf("outcome") + 3);
      sets.push("closed_at = CASE WHEN outcome = " + n + " THEN closed_at WHEN " + n + "<>'' THEN now() END");
    }
    await pool.query("UPDATE app_opportunities SET " + sets.join(",") + ", updated_at=now() WHERE id=$1 AND tenant_id=$2", p);
  }
  return dbGetOpportunity(id);
}
/** Traslada TODAS las oportunidades de una etapa a otra (al renombrar o quitar una etapa
 *  en el editor), también las cerradas: el tablero las enseña en su columna, y renombrar
 *  «Ganado» no puede dejarlas «por colocar». `outcome` es el desenlace de la etapa nueva;
 *  la fecha de cierre se conserva si no cambia. Devuelve a quién afectó, para reponer su
 *  etiqueta «📍». */
export async function dbMoveOpportunitiesStage(pipelineId: string, from: string, to: string, outcome: "" | "won" | "lost"): Promise<string[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const phones: string[] = [];
    for (const o of memOpps) if (o.tenant_id === tenantId && o.pipeline_id === pipelineId && o.stage === from) {
      if (o.outcome !== outcome) o.closed_at = outcome ? Date.now() : 0;
      o.stage = to; o.outcome = outcome; o.updated_at = Date.now(); phones.push(o.phone);
    }
    return [...new Set(phones)];
  }
  const r = await pool.query(
    "UPDATE app_opportunities SET stage=$4, outcome=$5, closed_at = CASE WHEN outcome=$5 THEN closed_at WHEN $5<>'' THEN now() END, updated_at=now()" +
    " WHERE tenant_id=$1 AND pipeline_id=$2 AND stage=$3 RETURNING phone",
    [tenantId, pipelineId, from, to, outcome]);
  return [...new Set(r.rows.map((x: any) => String(x.phone)))];
}
/** Migración de una sola vez por workspace: SÓLO los contactos que ya tenían etapa o
 *  pipeline puestos pasan a tener una oportunidad. Los demás (gente que escribió o se
 *  importó) siguen siendo sólo contactos. Idempotente: no duplica a quien ya tiene una.
 *  `colocar` decide en qué pipeline cae quien no tenía ninguno y si su etapa es un
 *  desenlace (Ganado/Perdido). */
export async function dbMigrateOpportunitiesFromContacts(
  colocar: (pipelineId: string, stage: string) => { pipeline_id: string; outcome: "" | "won" | "lost" },
): Promise<{ creadas: number; contactos: number; conEtapa: number }> {
  const tenantId = currentWorkspaceId();
  let candidatos: Array<{ phone: string; pipeline_id: string; stage: string; owner: string }> = [];
  let contactos = 0;
  if (!pool) {
    for (const c of mem.contacts.values()) {
      if ((c.tenant_id || "default") !== tenantId) continue;
      contactos++;
      const pid = String(((c.fields || {}) as Record<string, unknown>).pipeline_id || "");
      if (!c.stage && !pid) continue;
      candidatos.push({ phone: c.phone, pipeline_id: pid, stage: c.stage || "", owner: c.owner || "" });
    }
    candidatos = candidatos.filter((c) => !memOpps.some((o) => o.tenant_id === tenantId && o.phone === c.phone));
  } else {
    const t = await pool.query("SELECT count(*)::int n FROM app_contacts WHERE tenant_id=$1", [tenantId]);
    contactos = Number(t.rows[0]?.n || 0);
    const r = await pool.query(
      "SELECT c.phone, coalesce(c.fields->>'pipeline_id','') pipeline_id, coalesce(c.stage,'') stage, coalesce(c.owner,'') owner" +
      " FROM app_contacts c WHERE c.tenant_id=$1 AND (coalesce(c.stage,'')<>'' OR coalesce(c.fields->>'pipeline_id','')<>'')" +
      " AND NOT EXISTS (SELECT 1 FROM app_opportunities o WHERE o.tenant_id=c.tenant_id AND o.phone=c.phone)",
      [tenantId]);
    candidatos = r.rows.map((x: any) => ({ phone: String(x.phone), pipeline_id: String(x.pipeline_id), stage: String(x.stage), owner: String(x.owner) }));
  }
  const reason = "Ya estaba en el pipeline antes de separar personas y posibles ventas";
  const colocados = candidatos.map((c) => ({ ...c, ...colocar(c.pipeline_id, c.stage) }));
  if (!pool) {
    for (const c of colocados) await dbCreateOpportunity({ ...c, origin: "migracion", reason });
  } else if (colocados.length) {
    // Un solo INSERT por lotes: un workspace puede traer miles de personas con etapa.
    for (let i = 0; i < colocados.length; i += 500) {
      const lote = colocados.slice(i, i + 500);
      const vals: string[] = []; const p: unknown[] = [tenantId, reason];
      for (const c of lote) {
        p.push(c.phone, c.pipeline_id, c.stage, c.outcome, c.owner);
        const b = p.length - 4;
        vals.push("($1,$" + b + ",$" + (b + 1) + ",$" + (b + 2) + ",$" + (b + 3) + ",$" + (b + 4) + ",'migracion',$2, CASE WHEN $" + (b + 3) + "<>'' THEN now() END)");
      }
      await pool.query(
        "INSERT INTO app_opportunities (tenant_id,phone,pipeline_id,stage,outcome,owner,origin,reason,closed_at) VALUES " + vals.join(","), p);
    }
  }
  return { creadas: candidatos.length, contactos, conEtapa: candidatos.filter((c) => !!c.stage).length };
}

// ---- Sequences (drip) ----
export async function dbListSequences(): Promise<Record<string, unknown>[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return [...mem.sequences.values()]
      .filter((v) => ((v as { tenant_id?: string }).tenant_id || "default") === tenantId);
  }
  const r = await pool.query(
    "SELECT data FROM app_sequences WHERE tenant_id=$1 ORDER BY updated_at DESC",
    [tenantId],
  );
  return r.rows.map((x) => x.data);
}
export async function dbUpsertSequence(id: string, data: Record<string, unknown>) {
  const tenantId = currentWorkspaceId();
  // UPSERT-TENANT-GUARD (T05 2026-08-25) · el ON CONFLICT anterior actualizaba
  // data Y tenant_id sin mirar de quién era la fila: mandar un id ajeno
  // sobrescribía y SE APROPIABA de la secuencia de otro workspace (IDOR de
  // escritura). Ahora el UPDATE solo aplica si la fila es del tenant activo, y
  // el tenant_id jamás se reasigna por upsert.
  if (!pool) {
    const prev = mem.sequences.get(id) as { tenant_id?: string } | undefined;
    if (prev && (prev.tenant_id || "default") !== tenantId) throw new Error("id en uso: elige otro id");
    mem.sequences.set(id, { ...data, tenant_id: tenantId });
    return;
  }
  const r = await pool.query(
    `INSERT INTO app_sequences (id,data,tenant_id,updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=now()
     WHERE app_sequences.tenant_id=$3`,
    [id, JSON.stringify(data), tenantId],
  );
  if (Number(r.rowCount ?? 0) === 0) throw new Error("id en uso: elige otro id");
}
export async function dbDeleteSequence(id: string) {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const s = mem.sequences.get(id);
    if (s && ((s as { tenant_id?: string }).tenant_id || "default") === tenantId) mem.sequences.delete(id);
    return;
  }
  await pool.query("DELETE FROM app_sequences WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
}
export async function dbScheduleRun(id: string, phone: string, seqId: string, step: number, nextRunMs: number) {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    mem.runs.set(id, { id, phone, sequence_id: seqId, step, next_run: nextRunMs, status: "active", tenant_id: tenantId });
    return;
  }
  const r = await pool.query(
    `INSERT INTO app_sequence_runs (id,phone,sequence_id,step,next_run,status,tenant_id)
     VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),'active',$6)
     ON CONFLICT (id) DO UPDATE SET step=$4, next_run=to_timestamp($5/1000.0), status='active'
     WHERE app_sequence_runs.tenant_id=$6`,
    [id, phone, seqId, step, nextRunMs, tenantId],
  );
  // UPSERT-TENANT-GUARD · un id de run que colisione con otro tenant no se toca
  // (los ids son internos: si pasa, es un bug o un ataque — se avisa, no se pisa).
  if (Number(r.rowCount ?? 0) === 0) console.warn(`[db] dbScheduleRun ${id}: colisión de id con otro tenant — no se programa`);
}
// WS-ARCHIVED 2026-08-07 · un negocio SUSPENDIDO no sigue escribiendo a sus
// contactos. Esta cola (secuencias/drip de WhatsApp) se saltaba el filtro que ya
// aplicaban posts, difusiones y jobs de flujo: el run se quedaba 'active' y
// waflows.ts lo enviaba igual con las credenciales del ws archivado. El run NO se
// cancela: queda 'active' y revive intacto si se desarchiva.
export async function dbDueRuns(): Promise<SequenceRun[]> {
  if (!pool)
    return [...mem.runs.values()].filter(
      (r) => r.status === "active" && r.next_run <= Date.now() && !memTenantArchived(r.tenant_id),
    );
  const r = await pool.query(
    "SELECT id,phone,sequence_id,step, extract(epoch from next_run)*1000 next_run, status, tenant_id FROM app_sequence_runs WHERE status='active' AND next_run<=now() AND " +
      wsNotArchivedSql("app_sequence_runs.tenant_id") + " LIMIT 50",
  );
  return r.rows.map((x) => ({ ...x, next_run: Number(x.next_run), tenant_id: x.tenant_id || "default" })) as SequenceRun[];
}
export async function dbFinishRun(id: string, status: "done" | "cancelled") {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const x = mem.runs.get(id);
    if (x && ((x as { tenant_id?: string }).tenant_id || "default") === tenantId) x.status = status;
    return;
  }
  await pool.query("UPDATE app_sequence_runs SET status=$2 WHERE id=$1 AND tenant_id=$3", [id, status, tenantId]);
}
export async function dbCancelRunsForPhone(phone: string) {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    for (const x of mem.runs.values()) if (x.phone === phone && x.status === "active" && (((x as { tenant_id?: string }).tenant_id || "default") === tenantId)) x.status = "cancelled";
    return;
  }
  await pool.query("UPDATE app_sequence_runs SET status='cancelled' WHERE phone=$1 AND status='active' AND tenant_id=$2", [phone, tenantId]);
}

// ---- Flows (flow builder) ----
export async function dbListFlows(): Promise<Record<string, unknown>[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return [...mem.flows.values()]
      .filter((v) => ((v as { tenant_id?: string }).tenant_id || "default") === tenantId);
  }
  const r = await pool.query(
    "SELECT data, created_at, updated_at FROM app_flows WHERE tenant_id=$1 ORDER BY updated_at DESC",
    [tenantId],
  );
  // Las fechas viven en columnas, no dentro del JSON: se inyectan al vuelo
  // y dbUpsertFlow las quita antes de guardar, para que nunca se queden
  // copias viejas congeladas dentro del dato.
  return r.rows.map((x) => ({ ...x.data, createdAt: +new Date(x.created_at), updatedAt: +new Date(x.updated_at) }));
}
export async function dbUpsertFlow(id: string, data: Record<string, unknown>) {
  // Ver dbListFlows: las fechas son columnas, no parte del dato.
  delete data.createdAt;
  delete data.updatedAt;
  const tenantId = currentWorkspaceId();
  // UPSERT-TENANT-GUARD (T05 2026-08-25) · ver dbUpsertSequence: un id ajeno
  // sobrescribía y se apropiaba del flujo de otro workspace. El UPDATE solo
  // aplica sobre filas del tenant activo; tenant_id nunca se reasigna.
  if (!pool) {
    const prev = mem.flows.get(id) as { tenant_id?: string } | undefined;
    if (prev && (prev.tenant_id || "default") !== tenantId) throw new Error("id en uso: elige otro id");
    mem.flows.set(id, { ...data, tenant_id: tenantId });
    return;
  }
  const r = await pool.query(
    `INSERT INTO app_flows (id,data,tenant_id,updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=now()
     WHERE app_flows.tenant_id=$3`,
    [id, JSON.stringify(data), tenantId],
  );
  if (Number(r.rowCount ?? 0) === 0) throw new Error("id en uso: elige otro id");
}
/** ETIQUETA-USO-1 · ETQ-05 · Reescribe el dato de un flujo EXISTENTE del workspace activo
 *  SIN tocar `updated_at`. Lo usa el renombrado de etiquetas: en Instagram y Facebook el
 *  desempate entre flujos depende de ORDER BY updated_at DESC, así que un cambio hecho por
 *  el sistema no debe reordenarlos como si el dueño hubiera guardado el flujo. Nunca crea
 *  filas. Devuelve si escribió. */
export async function dbReescribirFlujo(id: string, data: Record<string, unknown>): Promise<boolean> {
  delete data.createdAt;
  delete data.updatedAt;
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const prev = mem.flows.get(id) as { tenant_id?: string } | undefined;
    if (!prev || (prev.tenant_id || "default") !== tenantId) return false;
    mem.flows.set(id, { ...data, tenant_id: tenantId });
    return true;
  }
  const r = await pool.query("UPDATE app_flows SET data=$1 WHERE id=$2 AND tenant_id=$3", [JSON.stringify(data), id, tenantId]);
  return Number(r.rowCount ?? 0) > 0;
}
export async function dbDeleteFlow(id: string): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  // WS-ISOLATION: solo borra si pertenece al workspace activo (defensa). En memoria también
  // (antes borraba el de cualquier negocio). Devuelve si borró algo.
  if (!pool) {
    const prev = mem.flows.get(id) as { tenant_id?: string } | undefined;
    if (!prev || (prev.tenant_id || "default") !== tenantId) return false;
    return mem.flows.delete(id);
  }
  const r = await pool.query("DELETE FROM app_flows WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
  return !!r.rowCount;
}
export async function dbSaveFlowRun(r: FlowRun) {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    mem.flowRuns.set(`${r.phone}:${r.flow_id}`, { ...r, tenant_id: tenantId, updated_at: Date.now() });
    return;
  }
  await pool.query(
    // created_at = cuándo ENTRÓ al flujo. En cada paso se preserva; solo se re-sella
    // cuando un run TERMINADO (done/cancelled) vuelve a arrancar (re-entrada real:
    // misma persona dispara el flujo otra vez → cuenta como entrada nueva en la serie).
    `INSERT INTO app_flow_runs (phone,flow_id,node_id,vars,status,next_run,tenant_id,updated_at)
     VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7,now())
     ON CONFLICT (phone,flow_id) DO UPDATE SET node_id=$3, vars=$4, status=$5, next_run=to_timestamp($6/1000.0), tenant_id=$7, updated_at=now(),
       created_at = CASE WHEN app_flow_runs.status IN ('done','cancelled') AND $5='active' THEN now() ELSE app_flow_runs.created_at END`,
    [r.phone, r.flow_id, r.node_id, JSON.stringify(r.vars), r.status, r.next_run, tenantId],
  );
}
/** DOBLE-ARRANQUE-1 · Reserva la ENTRADA a un flujo. Devuelve true si este llamante es quien
 *  debe ejecutarlo, y false si ese contacto YA acaba de entrar en ese mismo flujo.
 *
 *  El problema que resuelve: la tabla tiene clave (phone, flow_id), así que dos entradas
 *  seguidas no crean dos filas — pero startFlow guardaba y acto seguido ejecutaba EN MEMORIA.
 *  Si el mismo paso disparaba dos veces con segundos de diferencia (carrera entre el barrido
 *  de 30 s y el webhook), la segunda pisaba la fila y lanzaba una SEGUNDA ejecución en
 *  paralelo: dos hilos recorriendo los mismos pasos y el contacto recibiendo cada mensaje por
 *  duplicado. Medido en producción el 3-sep-2026: 22 contactos con doble entrada, separadas
 *  entre 0 y 11 segundos.
 *
 *  La reserva se pierde pasados `ventanaMs`: volver a disparar el flujo horas o días después
 *  (re-entrada legítima: la persona escribe otra vez la palabra clave) sigue funcionando
 *  igual, y un run que se quedó a medias no bloquea al contacto para siempre. */
export async function dbClaimFlowStart(r: FlowRun, ventanaMs: number): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  const corte = Date.now() - Math.max(1000, ventanaMs);
  if (!pool) {
    const key = `${r.phone}:${r.flow_id}`;
    const cur = mem.flowRuns.get(key);
    const mio = cur && (cur.tenant_id || "default") === tenantId;
    if (mio && (cur.updated_at || 0) > corte) return false;
    mem.flowRuns.set(key, { ...r, tenant_id: tenantId, updated_at: Date.now() });
    return true;
  }
  // Mismo INSERT que dbSaveFlowRun, con la condición en el DO UPDATE: si ya hay un run VIVO
  // tocado hace menos de la ventana, el WHERE no casa, no se escribe y no vuelve fila.
  const res = await pool.query(
    `INSERT INTO app_flow_runs (phone,flow_id,node_id,vars,status,next_run,tenant_id,updated_at)
     VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7,now())
     ON CONFLICT (phone,flow_id) DO UPDATE SET node_id=$3, vars=$4, status=$5, next_run=to_timestamp($6/1000.0), tenant_id=$7, updated_at=now(),
       created_at = CASE WHEN app_flow_runs.status IN ('done','cancelled') AND $5='active' THEN now() ELSE app_flow_runs.created_at END
     WHERE app_flow_runs.updated_at < to_timestamp($8/1000.0)
     RETURNING phone`,
    [r.phone, r.flow_id, r.node_id, JSON.stringify(r.vars), r.status, r.next_run, tenantId, corte],
  );
  return (res.rowCount || 0) > 0;
}
/** Guardado CAS del motor para pasos de AVANCE (parkWaiting, nodo espera, completar,
 *  marcar respuesta): solo escribe si el run sigue VIVO en BD (active/waiting) o si aún
 *  no existe (primer guardado). Devuelve false si el run fue cancelado por fuera (botón
 *  Stop/Detener del panel) mientras la cadena estaba en vuelo — el motor NO debe
 *  resucitarlo pisando el 'cancelled' con su copia en memoria. Las ENTRADAS de flujo
 *  (re-disparo por keyword/comentario) siguen usando dbSaveFlowRun sin guarda: pisar un
 *  run terminado ahí es la re-entrada legítima de siempre. En modo memoria el cancel
 *  BORRA la fila, así que un run desaparecido tampoco se re-crea aquí (guarda por
 *  marca __seen del propio run). */
export async function dbSaveFlowRunIfLive(r: FlowRun): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const key = `${r.phone}:${r.flow_id}`;
    const cur = mem.flowRuns.get(key);
    // Sin fila: o primer guardado de un run recién creado (el creador la puso — entonces
    // sí existe), o cancel-por-borrado en vuelo → no resucitar. Distinguimos por si la
    // fila existe: el creador SIEMPRE persiste antes de avanzar (triggerFlows y cía).
    if (!cur || cur.status === "done" || cur.status === "cancelled") return false;
    if ((cur.tenant_id || "default") !== tenantId) return false;
    mem.flowRuns.set(key, { ...r, tenant_id: tenantId, updated_at: Date.now() });
    return true;
  }
  const res = await pool.query(
    // Misma forma que dbSaveFlowRun pero con guarda de estado en el DO UPDATE: si la
    // fila ya no está viva (Stop/Detener la canceló), el WHERE falla → rowCount 0.
    // created_at se preserva siempre (la guarda garantiza que no es una re-entrada).
    `INSERT INTO app_flow_runs (phone,flow_id,node_id,vars,status,next_run,tenant_id,updated_at)
     VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7,now())
     ON CONFLICT (phone,flow_id) DO UPDATE SET node_id=$3, vars=$4, status=$5, next_run=to_timestamp($6/1000.0), tenant_id=$7, updated_at=now()
     WHERE app_flow_runs.status IN ('active','waiting')`,
    [r.phone, r.flow_id, r.node_id, JSON.stringify(r.vars), r.status, r.next_run, tenantId],
  );
  return (res.rowCount ?? 0) > 0;
}
/** PIEZAS-FB-1 (MET-FB-02) · Quién llegó a una conversación desde un comentario en una
 *  publicación de esta Página de Facebook. La relación se RECONSTRUYE del run del flujo:
 *  al comentar, startFlowFb guarda __cid (id del comentario, «{postId}_{commentId}») y
 *  __fbpage. Un comentario que no disparó ningún flujo no deja run → no hay vínculo y no
 *  se inventa. Hay un run por (contacto, flujo): si la misma persona volvió a entrar al
 *  mismo flujo desde otra publicación, sólo queda la última — se queda corto, nunca
 *  vincula de más. Acotado por workspace como todo lo demás. SUPRESION-FB-1: sólo cuenta a
 *  quien conserva su ficha (JOIN, no LEFT JOIN): al eliminar un contacto su run no lo devuelve. */
export async function dbFbEntradasPorComentario(pageId: string): Promise<Array<{ phone: string; name: string; cid: string; at: number }>> {
  const tenantId = currentWorkspaceId();
  if (!pageId) return [];
  if (!pool) {
    const out: Array<{ phone: string; name: string; cid: string; at: number }> = [];
    for (const r of mem.flowRuns.values()) {
      if ((r.tenant_id || "default") !== tenantId) continue;
      const v = r.vars || {};
      if (v.__ch !== "fb" || String(v.__fbpage || "") !== pageId || !v.__cid) continue;
      const ct = mem.contacts.get(contactMemKey(r.phone, tenantId));
      // SUPRESION-FB-1 · startFlowFb crea la ficha antes del run: sin ficha, la persona se borró («eliminar mis datos»)
      // y el run viejo no la devuelve a la lista de la publicación.
      if (!ct) continue;
      out.push({ phone: r.phone, name: String(ct.name || ""), cid: String(v.__cid), at: Number(r.updated_at || 0) });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, 2000);
  }
  const r = await pool.query(
    `SELECT r.phone, COALESCE(ct.name,'') AS name, r.vars->>'__cid' AS cid,
            extract(epoch from COALESCE(r.created_at,r.updated_at))*1000 AS at
     FROM app_flow_runs r
     JOIN app_contacts ct ON ct.phone=r.phone AND ct.tenant_id=r.tenant_id
     WHERE r.tenant_id=$1 AND r.vars->>'__ch'='fb' AND r.vars->>'__fbpage'=$2
       AND COALESCE(r.vars->>'__cid','')<>''
     ORDER BY COALESCE(r.created_at,r.updated_at) DESC
     LIMIT 2000`,
    [tenantId, pageId],
  );
  return r.rows.map((x: any) => ({ phone: String(x.phone), name: String(x.name || ""), cid: String(x.cid || ""), at: Number(x.at) || 0 }));
}
/** PIEZAS-FB-1 (MET-FB-02) · modo memoria de app_fb_entradas. */
const memFbEntradas = new Map<string, { tenant_id: string; comment_id: string; page_id: string; post_id: string; phone: string; at: number }>();

/** PIEZAS-FB-1 · Anota que el comentario `commentId` en la publicación `postId` abrió una
 *  conversación por Messenger, SOLO si al procesarlo nació un run de flujo de Facebook
 *  para esa persona en esa Página (created_at ≥ `desde`). Lo llama el webhook justo
 *  después de procesar el comentario: es el único momento en que la relación se puede
 *  demostrar, porque el motor borra __cid del run tras la primera respuesta privada.
 *  Sin run nuevo no se anota nada: el vínculo no se inventa. */
export async function dbFbAnotarEntrada(e: { pageId: string; postId: string; commentId: string; phone: string; desde: number }): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!e.pageId || !e.postId || !e.commentId || !e.phone) return false;
  if (!pool) {
    let nace = false;
    for (const r of mem.flowRuns.values()) {
      if ((r.tenant_id || "default") !== tenantId || r.phone !== e.phone) continue;
      const v = r.vars || {};
      if (v.__ch === "fb" && String(v.__fbpage || "") === e.pageId && Number(r.updated_at || 0) >= e.desde) { nace = true; break; }
    }
    if (!nace) return false;
    const k = tenantId + ":" + e.commentId;
    if (!memFbEntradas.has(k)) memFbEntradas.set(k, { tenant_id: tenantId, comment_id: e.commentId, page_id: e.pageId, post_id: e.postId, phone: e.phone, at: Date.now() });
    return true;
  }
  const r = await pool.query(
    `INSERT INTO app_fb_entradas (tenant_id, comment_id, page_id, post_id, phone)
     SELECT $1, $2, $3, $4, $5
     WHERE EXISTS (SELECT 1 FROM app_flow_runs r WHERE r.tenant_id=$1 AND r.phone=$5
       AND r.vars->>'__ch'='fb' AND r.vars->>'__fbpage'=$3
       AND r.created_at >= to_timestamp($6/1000.0) - interval '5 seconds')
     ON CONFLICT (tenant_id, comment_id) DO NOTHING`,
    [tenantId, e.commentId, e.pageId, e.postId, e.phone, e.desde],
  );
  return (r.rowCount ?? 0) > 0;
}

/** PIEZAS-FB-1 · Conversaciones anotadas por dbFbAnotarEntrada para una Página, la más reciente primero. */
export async function dbFbEntradasPorPublicacion(pageId: string): Promise<Array<{ phone: string; name: string; postId: string; at: number }>> {
  const tenantId = currentWorkspaceId();
  if (!pageId) return [];
  if (!pool) {
    return [...memFbEntradas.values()]
      .filter((x) => x.tenant_id === tenantId && x.page_id === pageId)
      .map((x) => ({ phone: x.phone, name: String(mem.contacts.get(contactMemKey(x.phone, tenantId))?.name || ""), postId: x.post_id, at: x.at }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 2000);
  }
  const r = await pool.query(
    `SELECT e.phone, COALESCE(ct.name,'') AS name, e.post_id, extract(epoch from e.at)*1000 AS at
     FROM app_fb_entradas e
     LEFT JOIN app_contacts ct ON ct.phone=e.phone AND ct.tenant_id=e.tenant_id
     WHERE e.tenant_id=$1 AND e.page_id=$2
     ORDER BY e.at DESC
     LIMIT 2000`,
    [tenantId, pageId],
  );
  return r.rows.map((x: any) => ({ phone: String(x.phone), name: String(x.name || ""), postId: String(x.post_id || ""), at: Number(x.at) || 0 }));
}

export async function dbWaitingFlowRun(phone: string): Promise<FlowRun | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    for (const x of mem.flowRuns.values())
      if (x.phone === phone && x.status === "waiting" && (x.tenant_id || "default") === tenantId) return x;
    return null;
  }
  const r = await pool.query(
    "SELECT phone,flow_id,node_id,vars,status, extract(epoch from next_run)*1000 next_run FROM app_flow_runs WHERE phone=$1 AND status='waiting' AND tenant_id=$2 ORDER BY updated_at DESC LIMIT 1",
    [phone, tenantId],
  );
  return r.rows[0] ? ({ ...r.rows[0], next_run: Number(r.rows[0].next_run) } as FlowRun) : null;
}
/** Como dbWaitingFlowRun pero acotado a UN flujo concreto: «¿sigue ESTE run esperando?».
 *  El seguimiento por inactividad lo necesita porque un contacto puede tener varios runs en
 *  espera a la vez (en WhatsApp arrancan todos los flujos que casan); usar «el más reciente
 *  del teléfono» dejaría huérfanos a los flujos más antiguos (nunca reenganche ni derivación). */
export async function dbWaitingFlowRunFor(phone: string, flowId: string): Promise<FlowRun | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const x = mem.flowRuns.get(`${phone}:${flowId}`);
    return x && x.status === "waiting" && (x.tenant_id || "default") === tenantId ? x : null;
  }
  const r = await pool.query(
    "SELECT phone,flow_id,node_id,vars,status, extract(epoch from next_run)*1000 next_run FROM app_flow_runs WHERE phone=$1 AND flow_id=$2 AND status='waiting' AND tenant_id=$3 LIMIT 1",
    [phone, flowId, tenantId],
  );
  return r.rows[0] ? ({ ...r.rows[0], next_run: Number(r.rows[0].next_run) } as FlowRun) : null;
}
/** Compare-and-set del seguimiento por inactividad: avanza el run SOLO si sigue en el mismo
 *  nodo Y con el mismo marcador de reenganche (__fu) que leímos. Si el contacto responde
 *  durante el envío (resumeFlow mueve el nodo) o dos ticks/réplicas coinciden (el primero ya
 *  cambió __fu), la escritura NO pisa el avance ni duplica. Devuelve true si escribió. */
export async function dbAdvanceWaitingIfUnchanged(
  phone: string,
  flowId: string,
  expectedNode: string,
  expectedFu: string,
  next: { vars: Record<string, unknown>; status: FlowRun["status"]; nextRun: number },
): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const key = `${phone}:${flowId}`;
    const x = mem.flowRuns.get(key);
    if (!x || x.status !== "waiting" || x.node_id !== expectedNode || String((x.vars as Record<string, unknown>)?.__fu || "") !== expectedFu || (x.tenant_id || "default") !== tenantId) return false;
    mem.flowRuns.set(key, { ...x, vars: next.vars as FlowRun["vars"], status: next.status, next_run: next.nextRun, tenant_id: tenantId, updated_at: Date.now() });
    return true;
  }
  const r = await pool.query(
    `UPDATE app_flow_runs SET vars=$4, status=$5, next_run=to_timestamp($6/1000.0), updated_at=now()
     WHERE phone=$1 AND flow_id=$2 AND status='waiting' AND node_id=$3
       AND COALESCE(vars->>'__fu','') = $7 AND tenant_id=$8`,
    [phone, flowId, expectedNode, JSON.stringify(next.vars), next.status, next.nextRun, expectedFu, tenantId],
  );
  return (r.rowCount || 0) > 0;
}
/** MÉTRICAS · QUIÉN clicó cada enlace del flujo: una fila por (URL base, teléfono) con nº de
 *  clics y último clic. Para la vista de métricas completas («4 clics al Zoom: estos números»). */
export async function dbFlowLinkClickers(flowId: string): Promise<{ urlBase: string; phone: string; n: number; lastAt: number }[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) return [];
  const r = await pool.query(
    `SELECT split_part(sl.url,'?',1) urlbase, c.phone, COUNT(*)::int n, extract(epoch from MAX(c.created_at))*1000 last_at
     FROM app_link_clicks c JOIN app_short_links sl ON sl.token=c.token
     WHERE sl.context_kind='flow' AND sl.context_id=$1 AND sl.tenant_id=$2 AND COALESCE(c.phone,'')<>''
     GROUP BY 1,2 ORDER BY last_at DESC LIMIT 2000`,
    [flowId, tenantId],
  );
  return r.rows.map((x: any) => ({ urlBase: String(x.urlbase || ""), phone: String(x.phone || ""), n: Number(x.n) || 0, lastAt: Number(x.last_at) || 0 }));
}
/** RAMAS-WA-1 (MET-WA-05) · quién, tras PULSAR un enlace del flujo, llegó de verdad a la web:
 *  una visita atribuida a su teléfono (marca lmc_ que /r/ añade, app_page_views.contact) desde
 *  10 min antes de su primer clic en ESE enlace (los relojes no son el mismo). medible=false si el
 *  negocio no tiene ni una visita atribuida: sin píxel no se sabe, y no es un cero. */
export async function dbVisitasTrasClicFlujo(flowId: string): Promise<{ medible: boolean; visitas: Array<{ urlBase: string; phone: string }> }> {
  const tenantId = currentWorkspaceId();
  if (!pool) return { medible: false, visitas: [] };
  const hay = await pool.query(`SELECT EXISTS(SELECT 1 FROM app_page_views WHERE tenant_id=$1 AND contact<>'') AS x`, [tenantId]);
  if (!hay.rows[0]?.x) return { medible: false, visitas: [] };
  const r = await pool.query(
    `WITH cl AS (
       SELECT split_part(sl.url,'?',1) urlbase, c.phone, regexp_replace(c.phone,'[^0-9]','','g') d, MIN(c.created_at) t
         FROM app_link_clicks c JOIN app_short_links sl ON sl.token=c.token
        WHERE sl.context_kind='flow' AND sl.context_id=$1 AND sl.tenant_id=$2 AND COALESCE(c.phone,'')<>''
        GROUP BY 1,2,3)
     SELECT cl.urlbase, cl.phone FROM cl
      WHERE EXISTS (SELECT 1 FROM app_page_views v
                     WHERE v.tenant_id=$2 AND v.contact=cl.d AND v.created_at >= cl.t - interval '10 minutes')
      LIMIT 5000`,
    [flowId, tenantId],
  );
  return { medible: true, visitas: r.rows.map((x: any) => ({ urlBase: String(x.urlbase || ""), phone: String(x.phone || "") })) };
}
/** SEGUIMIENTO-WA-1 (MET-WA-04) · eventos de un flujo DESDE una fecha, en orden de llegada.
 *  El embudo de seguimiento necesita la historia completa de cada persona que entró en el
 *  periodo, no los últimos N eventos del flujo (que cortarían a los primeros en entrar). */
export async function dbFlowEventsDesde(flowId: string, sinceMs: number, cap = 20000): Promise<FlowEventRow[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return mem.flowEvents
      .filter((e) => e.flow_id === flowId && e.tenant_id === tenantId && e.at >= sinceMs)
      .sort((a, b) => a.at - b.at)
      .slice(0, cap)
      .map((e) => ({ at: e.at, phone: e.phone, event: e.event, node_id: e.node_id, detail: e.detail }));
  }
  const r = await pool.query(
    `SELECT extract(epoch from at)*1000 AS at, phone, event, node_id, detail
       FROM app_flow_events WHERE tenant_id=$1 AND flow_id=$2 AND app_flow_events.at >= to_timestamp($3/1000.0)
      ORDER BY app_flow_events.at ASC, id ASC LIMIT $4`,
    [tenantId, flowId, sinceMs, cap],
  );
  return r.rows.map((x) => ({ at: Number(x.at), phone: x.phone, event: x.event, node_id: x.node_id, detail: x.detail }));
}

/** SEGUIMIENTO-WA-1 · flujos con PERSONAS de WhatsApp (teléfono numérico; fuera ig:/fb:/email:)
 *  que entraron en el periodo, con cuántas. Alimenta el selector del embudo de seguimiento. */
export async function dbFlowsConEntradasWa(sinceMs: number, untilMs: number): Promise<Array<{ flow_id: string; n: number }>> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const m = new Map<string, Set<string>>();
    for (const e of mem.flowEvents) {
      if (e.tenant_id !== tenantId || e.event !== "entró" || e.at < sinceMs || e.at > untilMs || !/^[0-9]+$/.test(e.phone)) continue;
      (m.get(e.flow_id) || m.set(e.flow_id, new Set()).get(e.flow_id)!).add(e.phone);
    }
    return [...m].map(([flow_id, ph]) => ({ flow_id, n: ph.size }));
  }
  const r = await pool.query(
    `SELECT flow_id, COUNT(DISTINCT phone)::int n FROM app_flow_events
      WHERE tenant_id=$1 AND event='entró' AND phone ~ '^[0-9]+$'
        AND app_flow_events.at BETWEEN to_timestamp($2/1000.0) AND to_timestamp($3/1000.0)
      GROUP BY flow_id`,
    [tenantId, sinceMs, untilMs],
  );
  return r.rows.map((x: any) => ({ flow_id: String(x.flow_id), n: Number(x.n) || 0 }));
}

/** SEGUIMIENTO-WA-1 · reservas HECHAS (no celebradas) desde una fecha, por email, y si el
 *  negocio tiene alguna reserva sincronizada alguna vez (sin ninguna, la agenda no está
 *  conectada y el dato es «sin medición», no un cero). Sin fecha de creación se usa null:
 *  la reserva existe pero no se puede situar antes o después de un mensaje. */
export async function dbReservasDesde(sinceMs: number): Promise<{ conectada: boolean; repetidas: number; filas: Array<{ email: string; nombre: string; creada: number | null; cita: number | null; estado: string }> }> {
  const tenantId = currentWorkspaceId();
  type Fila = { cuenta: string; id: string; email: string; nombre: string; creada: number | null; cita: number | null; estado: string };
  let crudas: Fila[];
  if (!pool) {
    const todas = [...mem.sioBookings.values()].filter((b) => (b.tenant_id || "default") === tenantId);
    if (!todas.length) return { conectada: false, repetidas: 0, filas: [] };
    crudas = todas
      .filter((b) => (b.created_at ?? b.booked_at ?? 0) >= sinceMs)
      .map((b) => ({ cuenta: String(b.account_id || ""), id: String(b.booking_id ?? ""), email: String(b.email || "").trim().toLowerCase(), nombre: String(b.contact_name || ""), creada: b.created_at ?? null, cita: b.booked_at ?? null, estado: String(b.status || "") }));
  } else {
    const hay = await pool.query("SELECT 1 FROM app_sio_bookings WHERE tenant_id=$1 LIMIT 1", [tenantId]);
    if (!hay.rows.length) return { conectada: false, repetidas: 0, filas: [] };
    const r = await pool.query(
      `SELECT account_id, booking_id::text booking_id, lower(trim(email)) email, contact_name, extract(epoch from created_at)*1000 creada,
              extract(epoch from booked_at)*1000 cita, status
         FROM app_sio_bookings
        WHERE tenant_id=$1 AND COALESCE(created_at, booked_at) >= to_timestamp($2/1000.0)`,
      [tenantId, sinceMs],
    );
    crudas = r.rows.map((x: any) => ({ cuenta: String(x.account_id || ""), id: String(x.booking_id ?? ""), email: String(x.email || ""), nombre: String(x.contact_name || ""), creada: x.creada != null ? Number(x.creada) : null, cita: x.cita != null ? Number(x.cita) : null, estado: String(x.status || "") }));
  }
  // MET-AUTO-09-FIN · una reserva confirmada desde varios enlaces es UNA reserva (regla común de
  // src/identidad.ts). Las vivas van delante: si una copia se canceló y otra sigue, cuenta la que sigue;
  // entre copias vivas, la más antigua. Todos los contadores de reservas leen de aquí.
  const viva = (x: Fila) => (/cancel/i.test(x.estado) ? 1 : 0);
  crudas.sort((a, b) => viva(a) - viva(b) || (a.creada ?? Infinity) - (b.creada ?? Infinity));
  const u = hechosUnaVez(crudas.map((x) => ({ ...x, tipo: "reserva" as const, cuando: x.creada })));
  const filas = [...u.unicos, ...u.sinClave].map((x) => ({ email: x.email, nombre: x.nombre, creada: x.creada, cita: x.cita, estado: x.estado }));
  return { conectada: true, repetidas: u.repetidos, filas };
}
/** MET-CORREO-10-FIN · el origen (source, utm_source) de la ficha de cada correo, para repartir las
 *  reservas por canal con la misma ficha que las ventas (dbDashSioSalesDaily: la más reciente con ese
 *  correo). Acotado por tenant. Un correo sin ficha no sale en el mapa. */
export async function dbDashOrigenPorEmail(emails: string[]): Promise<Map<string, { source: string; utm_source: string }>> {
  const tenantId = currentWorkspaceId();
  const lista = [...new Set(emails.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  const out = new Map<string, { source: string; utm_source: string }>();
  if (!lista.length) return out;
  if (!pool) {
    const quiero = new Set(lista);
    const ts = new Map<string, number>();
    for (const c of mem.contacts.values()) {
      if ((c.tenant_id || "default") !== tenantId) continue;
      const e = String((c as any).email || "").trim().toLowerCase();
      if (!e || !quiero.has(e)) continue;
      const t = Number((c as any).created_at) || 0;
      if (ts.has(e) && (ts.get(e) as number) >= t) continue;
      ts.set(e, t);
      out.set(e, { source: String((c as any).source || ""), utm_source: String((c as any).utm_source || "") });
    }
    return out;
  }
  const r = await pool.query(
    `SELECT DISTINCT ON (lower(email)) lower(email) email, COALESCE(source,'') source, COALESCE(utm_source,'') utm_source
       FROM app_contacts
      WHERE tenant_id=$1 AND lower(email) = ANY($2::text[])
      ORDER BY lower(email), created_at DESC`,
    [tenantId, lista],
  );
  for (const x of r.rows as any[]) out.set(String(x.email), { source: String(x.source || ""), utm_source: String(x.utm_source || "") });
  return out;
}
/** VACIAR DATOS de un flujo (tenant-scoped): borra sus runs, su registro de actividad y los
 *  clics de sus enlaces — el DISEÑO del flujo y los enlaces cortos ya enviados quedan
 *  intactos (los links viejos siguen redirigiendo). Para limpiar pruebas antes de un
 *  lanzamiento y medir solo gente real. Devuelve cuánto borró. */
/** «Vaciar datos» de un flujo. Borra TAMBIÉN las marcas de «una vez por persona»
 *  (ONCE-FLOW-1): sin eso, el dueño solo podría probar su propio flujo una vez en la
 *  vida y el botón no lo arreglaría — parecería que el flujo está roto. El purgado
 *  periódico (dbPurgeCommentDedup) tampoco las toca: solo barre los dedups de webhook. */
export async function dbResetFlowData(flowId: string): Promise<{ runs: number; events: number; clicks: number; marcas: number }> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    let runs = 0;
    for (const [k, x] of [...mem.flowRuns]) {
      if (x.flow_id === flowId && (x.tenant_id || "default") === tenantId) { mem.flowRuns.delete(k); runs++; }
    }
    const before = mem.flowEvents.length;
    const kept = mem.flowEvents.filter((e) => !(e.flow_id === flowId && (e.tenant_id || "default") === tenantId));
    mem.flowEvents.length = 0; mem.flowEvents.push(...kept);
    let marcas = 0;
    const pref = `${tenantId}:${flowId}:`;
    for (const k of [...mem.log]) if (k.startsWith(pref)) { mem.log.delete(k); marcas++; }
    return { runs, events: before - kept.length, clicks: 0, marcas };
  }
  const ev = await pool.query("DELETE FROM app_flow_events WHERE tenant_id=$1 AND flow_id=$2", [tenantId, flowId]);
  const rn = await pool.query("DELETE FROM app_flow_runs WHERE tenant_id=$1 AND flow_id=$2", [tenantId, flowId]);
  // ONCE-FLOW-1 · las marcas de «una vez por persona» se guardan con el id del flujo
  // como automation_id (dbClaimOnce es genérico: la clave es texto libre).
  let marcas = 0;
  try {
    const oc = await pool.query("DELETE FROM app_automation_log WHERE tenant_id=$1 AND automation_id=$2", [tenantId, flowId]);
    marcas = oc.rowCount || 0;
  } catch { /* la tabla existe desde initDb; si fallara, vaciar el resto sigue siendo útil */ }
  let clicks = 0;
  try {
    const cl = await pool.query(
      "DELETE FROM app_link_clicks c USING app_short_links sl WHERE sl.token=c.token AND sl.context_kind='flow' AND sl.context_id=$2 AND sl.tenant_id=$1",
      [tenantId, flowId],
    );
    clicks = cl.rowCount || 0;
  } catch { /* tablas de links opcionales */ }
  return { runs: rn.rowCount || 0, events: ev.rowCount || 0, clicks, marcas };
}
/** DERIVACIÓN INMEDIATA · Cierra (done) un run APARCADO EN UNA ESPERA solo si sigue en ese
 *  delay Y el temporizador AÚN NO ha vencido (next_run > now). La condición de no-vencido
 *  elimina la carrera con flowTick: el tick solo procesa runs VENCIDOS (next_run<=now) y esta
 *  escritura solo toca runs SIN vencer → nunca los dos sobre la misma fila. Si el temporizador
 *  acaba de vencer, la derivación NO gana y el flujo avanza por su camino normal (que ya iba
 *  a contestar). Devuelve true solo si cerró el run (→ ejecutar los efectos de derivación). */
export async function dbDeriveActiveDelayRun(
  phone: string,
  flowId: string,
  expectedNode: string,
  vars: Record<string, unknown>,
): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const key = `${phone}:${flowId}`;
    const x = mem.flowRuns.get(key);
    if (!x || x.status !== "active" || x.node_id !== expectedNode || x.next_run <= Date.now() || (x.tenant_id || "default") !== tenantId) return false;
    mem.flowRuns.set(key, { ...x, vars: vars as FlowRun["vars"], status: "done", updated_at: Date.now() });
    return true;
  }
  const r = await pool.query(
    `UPDATE app_flow_runs SET vars=$4, status='done', updated_at=now()
     WHERE phone=$1 AND flow_id=$2 AND status='active' AND node_id=$3 AND next_run > now() AND tenant_id=$5`,
    [phone, flowId, expectedNode, JSON.stringify(vars), tenantId],
  );
  return (r.rowCount || 0) > 0;
}
/** Reprograma un run en espera para más tarde SIN avanzar la cadencia (p.ej. el número/cuenta
 *  de origen no resuelve ahora mismo): evita reintentar cada 2 min y evita derivar en falso.
 *  No toca updated_at para no alterar la antigüedad usada por otros sondeos. */
export async function dbDeferWaiting(phone: string, flowId: string, expectedNode: string, nextRun: number): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const key = `${phone}:${flowId}`;
    const x = mem.flowRuns.get(key);
    if (x && x.status === "waiting" && x.node_id === expectedNode && (x.tenant_id || "default") === tenantId) mem.flowRuns.set(key, { ...x, next_run: nextRun });
    return;
  }
  await pool.query(
    "UPDATE app_flow_runs SET next_run=to_timestamp($4/1000.0) WHERE phone=$1 AND flow_id=$2 AND status='waiting' AND node_id=$3 AND tenant_id=$5",
    [phone, flowId, expectedNode, nextRun, tenantId],
  );
}
/** Al ACTIVAR el seguimiento por inactividad en un flujo, rearma los runs que ya estaban
 *  aparcados «para siempre» (next_run≈FU_FAR, puestos cuando el seguimiento estaba OFF) para
 *  que el reenganche 1 les llegue tras el silencio configurado. Idempotente: solo toca los
 *  FU_FAR (umbral +30 días); los ya armados o los nuevos no se tocan. Borra __fu para que
 *  entren como reenganche 1. Devuelve cuántos rearmó. */
export async function dbRearmWaitingForFlow(flowId: string, fuT1Mins: number): Promise<number> {
  const tenantId = currentWorkspaceId();
  const when = Date.now() + Math.max(1, fuT1Mins) * 60_000;
  // Umbral MUY por encima de cualquier cadencia real (una cadencia son minutos/días → como
  // mucho ~1e13) y por debajo de FU_FAR (8.64e15 ≈ año 275760): así captura SOLO los aparcados
  // «para siempre», nunca un fuT2/fuT3 grande que un owner ponga (aunque sean 30+ días).
  const farThreshold = 4.32e15;
  if (!pool) {
    let n = 0;
    for (const [key, x] of mem.flowRuns) {
      // REPESCA-3-1 · __fu='3' = ya recibió su tercer y ÚLTIMO aviso (modo «mensaje»):
      // rearmarlo le duplicaría la cadencia entera después de un «cierro por hoy».
      if (x.flow_id === flowId && x.status === "waiting" && (x.tenant_id || "default") === tenantId && x.next_run > farThreshold && String((x.vars as Record<string, unknown>).__fu || "") !== "3") {
        const nv = { ...(x.vars as Record<string, unknown>) }; delete nv.__fu;
        mem.flowRuns.set(key, { ...x, vars: nv as FlowRun["vars"], next_run: when }); n++;
      }
    }
    return n;
  }
  const r = await pool.query(
    `UPDATE app_flow_runs SET next_run=to_timestamp($3/1000.0), vars = vars - '__fu'
     WHERE flow_id=$1 AND status='waiting' AND tenant_id=$2 AND next_run > to_timestamp($4/1000.0)
       AND COALESCE(vars->>'__fu','') <> '3'`,
    [flowId, tenantId, when, farThreshold],
  );
  return r.rowCount || 0;
}
/** Flujos de este contacto que están en espera POR DELAY (status='active': esperando a
 *  que el scheduler venza el next_run), en el workspace activo. A diferencia de
 *  dbWaitingFlowRun (status='waiting', esperan una respuesta a un botón/pregunta), estos
 *  no reciben la respuesta del contacto por resumeFlow — un flujo message→delay→condición
 *  nunca entra en 'waiting'. Los usa noteReplyToActiveRuns para dejar constancia de que el
 *  contacto respondió, y que una condición posterior "¿respondió?" lo detecte. */
export async function dbActiveFlowRunsForPhone(phone: string): Promise<FlowRun[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return [...mem.flowRuns.values()].filter(
      (x) => x.phone === phone && x.status === "active" && (x.tenant_id || "default") === tenantId,
    );
  }
  const r = await pool.query(
    "SELECT phone,flow_id,node_id,vars,status, extract(epoch from next_run)*1000 next_run, tenant_id FROM app_flow_runs WHERE phone=$1 AND status='active' AND tenant_id=$2",
    [phone, tenantId],
  );
  return r.rows.map((x) => ({ ...x, next_run: Number(x.next_run), tenant_id: x.tenant_id || "default" })) as FlowRun[];
}
/** FU-CANCEL-1 · TODOS los runs en espera de un teléfono (no solo el más reciente,
 *  que es lo único que mira dbWaitingFlowRun): cualquier mensaje entrante debe poder
 *  reiniciar la cadencia de reenganche de cada uno. */
export async function dbWaitingFlowRunsForPhone(phone: string): Promise<FlowRun[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return [...mem.flowRuns.values()].filter(
      (x) => x.phone === phone && x.status === "waiting" && (x.tenant_id || "default") === tenantId,
    );
  }
  const r = await pool.query(
    "SELECT phone,flow_id,node_id,vars,status, extract(epoch from next_run)*1000 next_run, tenant_id FROM app_flow_runs WHERE phone=$1 AND status='waiting' AND tenant_id=$2",
    [phone, tenantId],
  );
  return r.rows.map((x) => ({ ...x, next_run: Number(x.next_run), tenant_id: x.tenant_id || "default" })) as FlowRun[];
}
/** FICHA-AUTOM-1 · Automatizaciones EN CURSO de un contacto (para su ficha): runs en
 *  'active' (avanzando o en espera por delay) o 'waiting' (esperando su respuesta),
 *  con fechas para pintar "desde cuándo". SOLO lectura; workspace activo. */
export async function dbCurrentFlowRunsForPhone(
  phone: string,
): Promise<Array<FlowRun & { started_at: number; last_at: number }>> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return [...mem.flowRuns.values()]
      .filter((x) => x.phone === phone && (x.status === "active" || x.status === "waiting") && (x.tenant_id || "default") === tenantId)
      .map((x) => ({ ...x, started_at: 0, last_at: 0 }));
  }
  const r = await pool.query(
    `SELECT phone,flow_id,node_id,vars,status, extract(epoch from next_run)*1000 next_run, tenant_id,
        extract(epoch from created_at)*1000 started_at, extract(epoch from updated_at)*1000 last_at
     FROM app_flow_runs WHERE phone=$1 AND status IN ('active','waiting') AND tenant_id=$2 ORDER BY updated_at DESC`,
    [phone, tenantId],
  );
  return r.rows.map((x) => ({
    ...x,
    next_run: Number(x.next_run),
    started_at: Number(x.started_at || 0),
    last_at: Number(x.last_at || 0),
    tenant_id: x.tenant_id || "default",
  })) as Array<FlowRun & { started_at: number; last_at: number }>;
}
/** REUNIONES-FLUJO-1 · Automatizaciones EN CURSO de VARIOS contactos en UNA consulta.
 *  La vista Reuniones enseña en qué paso del flujo está cada contacto con cita: una
 *  query por contacto eran N viajes a la base para pintar una lista. Mismo criterio
 *  que dbCurrentFlowRunsForPhone (active/waiting, workspace activo), sin fechas:
 *  la vista solo necesita flujo + paso + estado. */
export async function dbCurrentFlowRunsForPhones(phones: string[]): Promise<FlowRun[]> {
  if (!phones.length) return [];
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return [...mem.flowRuns.values()].filter(
      (x) => phones.includes(x.phone) && (x.status === "active" || x.status === "waiting") && (x.tenant_id || "default") === tenantId,
    );
  }
  const r = await pool.query(
    "SELECT phone,flow_id,node_id,vars,status, extract(epoch from next_run)*1000 next_run, tenant_id FROM app_flow_runs WHERE phone = ANY($1) AND status IN ('active','waiting') AND tenant_id=$2 ORDER BY updated_at DESC",
    [phones, tenantId],
  );
  return r.rows.map((x) => ({ ...x, next_run: Number(x.next_run), tenant_id: x.tenant_id || "default" })) as FlowRun[];
}
/** MODO-BANDEJA-1 (BAN-04) · Contactos del workspace activo con una automatización EN
 *  CURSO (active/waiting). La Bandeja dice en cada fila quién atiende ahora: si hay un
 *  flujo guiando la conversación, es el flujo (corre ANTES que el «Atender yo»). Una sola
 *  consulta para toda la lista. */
export async function dbPhonesEnFlujo(): Promise<Set<string>> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return new Set(
      [...mem.flowRuns.values()]
        .filter((x) => (x.status === "active" || x.status === "waiting") && (x.tenant_id || "default") === tenantId)
        .map((x) => x.phone),
    );
  }
  const r = await pool.query(
    "SELECT DISTINCT phone FROM app_flow_runs WHERE status IN ('active','waiting') AND tenant_id=$1",
    [tenantId],
  );
  return new Set(r.rows.map((x) => String(x.phone)));
}
/** FICHA-AUTOM-2 · Automatizaciones ya TERMINADAS de un contacto (done/cancelled),
 *  recientes primero. Para que la ficha de alguien que ACABA de salir de un flujo no
 *  aparezca vacía y engañe ("no está en ninguna" cuando en realidad acaba de salir).
 *  Solo lectura; workspace activo. */
export async function dbEndedFlowRunsForPhone(
  phone: string,
  limit = 8,
): Promise<Array<FlowRun & { started_at: number; last_at: number }>> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return [...mem.flowRuns.values()]
      .filter((x) => x.phone === phone && (x.status === "done" || x.status === "cancelled") && (x.tenant_id || "default") === tenantId)
      .map((x) => ({ ...x, started_at: 0, last_at: 0 }))
      .slice(0, limit);
  }
  const r = await pool.query(
    `SELECT phone,flow_id,node_id,vars,status, extract(epoch from next_run)*1000 next_run, tenant_id,
        extract(epoch from created_at)*1000 started_at, extract(epoch from updated_at)*1000 last_at
     FROM app_flow_runs WHERE phone=$1 AND status IN ('done','cancelled') AND tenant_id=$2
     ORDER BY updated_at DESC LIMIT $3`,
    [phone, tenantId, limit],
  );
  return r.rows.map((x) => ({
    ...x,
    next_run: Number(x.next_run),
    started_at: Number(x.started_at || 0),
    last_at: Number(x.last_at || 0),
    tenant_id: x.tenant_id || "default",
  })) as Array<FlowRun & { started_at: number; last_at: number }>;
}
/** SONDEO-IG-1 · Todos los flujos de INSTAGRAM que están esperando respuesta, de TODOS
 *  los workspaces (como dbDueFlowRuns, que también corre fuera de un webhook).
 *
 *  Existe porque los webhooks de mensajería de Instagram no siempre llegan: si la
 *  Página no está suscrita a los campos de mensajes, Meta sencillamente NO entrega el
 *  tap del botón ni el DM, y el flujo se queda parado para siempre. Con esta lista, el
 *  sondeo pregunta por API "¿ha contestado esta persona?" y lo reanuda igualmente.
 *
 *  Se acota por antigüedad para no sondear runs viejos eternamente: pasadas unas horas
 *  sin respuesta, esa persona ya no va a contestar y no merece gastar llamadas. */
/** Ventana que el sondeo de Instagram vigila un run en espera antes de dejar de mirarlo.
 *  RECIBIR una respuesta tardía NO está limitado por la ventana de 24 h de Meta (esa solo
 *  aplica a ENVIAR, y además el propio mensaje del usuario la reinicia); el muro real de
 *  lectura es que a los 30 días la conversación de la carpeta Requests deja de ser legible
 *  por API. 7 días = vida útil de conversación que Meta reconoce (Human Agent) y tope
 *  natural del conjunto vigilado (un waiting sin seguimiento nunca se cierra, así que sin
 *  tope crecería sin fin). Antes eran 6 h: si el webhook de `messages` no llegaba, una
 *  respuesta pasada ese margen no se rescataba NUNCA y el flujo quedaba congelado.
 *  Override por env IG_WAIT_WINDOW_DAYS (def 7): para el rescate puntual de un backlog viejo
 *  se sube a 30 en UN despliegue (barre hasta el muro de lectura de Meta) y se revierte. */
const _igWaitDays = Number(process.env.IG_WAIT_WINDOW_DAYS);
export const IG_WAIT_WINDOW_MS = (Number.isFinite(_igWaitDays) && _igWaitDays > 0 ? _igWaitDays : 7) * 24 * 3600_000;
// Runs que UN tick del sondeo procesa (los más recientes por updated_at). En reposo 200
// sobra. Para rescatar cientos de colgados de golpe se sube por env IG_WAIT_POLL_LIMIT en el
// mismo despliegue del barrido ancho, y se revierte después. Entero validado (interpolable).
const _igPollLimit = Number(process.env.IG_WAIT_POLL_LIMIT);
const IG_WAIT_POLL_LIMIT = Number.isFinite(_igPollLimit) && _igPollLimit > 0 ? Math.min(2000, Math.floor(_igPollLimit)) : 200;
export async function dbWaitingIgRuns(maxAgeMs = IG_WAIT_WINDOW_MS): Promise<FlowRun[]> {
  const since = Date.now() - maxAgeMs;
  if (!pool)
    return [...mem.flowRuns.values()].filter(
      // En memoria (sin Postgres) no se guarda updated_at: next_run es la marca de
      // tiempo más reciente que tenemos del run, y sirve igual para acotar.
      // WS-ARCHIVED (T05 2026-08-25) · un negocio suspendido tampoco reanuda flujos IG.
      (x) => x.status === "waiting" && x.vars?.__ch === "ig" && (x.next_run || Date.now()) >= since
        && !memTenantArchived((x as { tenant_id?: string }).tenant_id),
    );
  // waiting_since = CUÁNDO entró en espera. Sin este dato el sondeo no puede
  // distinguir la respuesta que estaba esperando de un mensaje que esa persona escribió
  // ANTES, y reanudaría el flujo con texto viejo (ver el filtro en igPollRun).
  const r = await pool.query(
    // waiting_since = «esperando su respuesta DESDE». Se toma de vars.__since (lo fija parkWaiting
    // al aparcar y el reenganche por inactividad NO lo mueve), con updated_at como reserva para
    // runs viejos sin __since. Antes usaba updated_at directo, pero el reenganche re-sella
    // updated_at=now() → el corte avanzaba y una respuesta previa del lead se descartaba para
    // siempre (se derivaba como «no respondió»). La frescura (aún merece sondeo) sí usa updated_at.
    // El ::bigint va guardado por un regex de hasta 15 dígitos: un __since corrupto (edición
    // manual, migración, dato raro) devolvería NULL en vez de lanzar «invalid input syntax» y
    // abortar TODA la query (mataría el sondeo IG de los 200 runs en cada tick). Hoy nadie
    // escribe un __since no numérico (parkWaiting = String(Date.now())), pero el coste de
    // blindarlo es una línea y el radio de fallo sería severo. Acotar también la longitud
    // impide que una cadena numérica enorme desborde bigint y aborte todo el sondeo.
    // La ventana usa double precision: 30 días son 2.592.000.000 ms, fuera de int32.
    `SELECT phone,flow_id,node_id,vars,status, extract(epoch from next_run)*1000 next_run,
            COALESCE(CASE WHEN vars->>'__since' ~ '^[0-9]{1,15}$' THEN (vars->>'__since')::bigint END, extract(epoch from updated_at)*1000) waiting_since, tenant_id
     FROM app_flow_runs
     WHERE status='waiting' AND vars->>'__ch'='ig' AND updated_at > now() - ($1::double precision * interval '1 millisecond')
       AND ` + wsNotArchivedSql("app_flow_runs.tenant_id") + `
     ORDER BY updated_at DESC LIMIT ${IG_WAIT_POLL_LIMIT}`,
    [maxAgeMs],
  );
  return r.rows.map((x) => ({
    ...x,
    next_run: Number(x.next_run),
    waiting_since: Number(x.waiting_since) || 0,
    tenant_id: x.tenant_id || "default",
  })) as FlowRun[];
}
// ============================================================
// FLOW-LOGS · registro de actividad por flujo («Ver Logs»).
// ============================================================
export interface FlowEventRow {
  at: number; // epoch ms
  phone: string;
  event: string;
  node_id: string;
  detail: string;
}

/** Añade un evento al registro del flujo. NUNCA lanza: el registro jamás puede romper
 *  el motor de flujos (se llama en fire-and-forget desde cada movimiento). */
export async function dbFlowEventAdd(flowId: string, phone: string, event: string, nodeId = "", detail = ""): Promise<void> {
  try {
    const tenantId = currentWorkspaceId();
    const det = String(detail || "").slice(0, 300);
    if (!pool) {
      mem.flowEvents.push({ tenant_id: tenantId, flow_id: flowId, phone, event, node_id: nodeId, detail: det, at: Date.now() });
      if (mem.flowEvents.length > 5000) mem.flowEvents.splice(0, mem.flowEvents.length - 5000);
      return;
    }
    await pool.query(
      "INSERT INTO app_flow_events (tenant_id, flow_id, phone, event, node_id, detail) VALUES ($1,$2,$3,$4,$5,$6)",
      [tenantId, flowId, phone, event, nodeId, det],
    );
  } catch (e) {
    console.warn("[flow-logs] no se pudo registrar:", (e as Error).message);
  }
}

/** Eventos de un flujo, más recientes primero (para la vista «Ver Logs»). */
export async function dbFlowEvents(flowId: string, limit = 1500): Promise<FlowEventRow[]> {
  const tenantId = currentWorkspaceId();
  const cap = Math.min(5000, Math.max(1, limit));
  if (!pool) {
    return mem.flowEvents
      .filter((e) => e.flow_id === flowId && e.tenant_id === tenantId)
      .sort((a, b) => b.at - a.at)
      .slice(0, cap)
      .map((e) => ({ at: e.at, phone: e.phone, event: e.event, node_id: e.node_id, detail: e.detail }));
  }
  // ORDER BY CUALIFICADO (app_flow_events.at): el alias de salida también se llama "at" y
  // un ORDER BY pelado se resolvería contra la EXPRESIÓN del alias → el índice
  // idx_flowevents_flow no serviría el orden y cada consulta re-ordenaría todo el flujo.
  const r = await pool.query(
    `SELECT extract(epoch from at)*1000 AS at, phone, event, node_id, detail
       FROM app_flow_events WHERE tenant_id=$1 AND flow_id=$2
      ORDER BY app_flow_events.at DESC, id DESC LIMIT $3`,
    [tenantId, flowId, cap],
  );
  return r.rows.map((x) => ({ at: Number(x.at), phone: x.phone, event: x.event, node_id: x.node_id, detail: x.detail }));
}

/** BAN-04-FIN · Registra un cambio manual de quién atiende (equipo / ia). Nunca rompe al caller. */
export async function dbModoEventAdd(phone: string, modo: string): Promise<void> {
  try {
    const tenantId = currentWorkspaceId();
    if (!pool) {
      mem.modoEvents.push({ tenant_id: tenantId, phone, modo, at: Date.now() });
      if (mem.modoEvents.length > 5000) mem.modoEvents.splice(0, mem.modoEvents.length - 5000);
      return;
    }
    await pool.query("INSERT INTO app_modo_events (tenant_id, phone, modo) VALUES ($1,$2,$3)", [tenantId, phone, modo]);
  } catch (e) {
    console.warn("[modo-events] no se pudo registrar:", (e as Error).message);
  }
}
/** BAN-04-FIN · Cambios manuales de quién atiende de UN contacto, workspace activo, ascendente. */
export async function dbModoEventsForPhone(phone: string, limit = 200): Promise<Array<{ at: number; modo: string }>> {
  const tenantId = currentWorkspaceId();
  const cap = Math.min(1000, Math.max(1, limit));
  if (!pool) {
    return mem.modoEvents.filter((e) => e.phone === phone && e.tenant_id === tenantId)
      .sort((a, b) => a.at - b.at).slice(-cap).map((e) => ({ at: e.at, modo: e.modo }));
  }
  const r = await pool.query(
    `SELECT * FROM (SELECT extract(epoch from at)*1000 AS at, modo, id FROM app_modo_events
       WHERE tenant_id=$1 AND phone=$2 ORDER BY app_modo_events.at DESC, id DESC LIMIT $3) t ORDER BY t.at ASC, t.id ASC`,
    [tenantId, phone, cap],
  );
  return r.rows.map((x) => ({ at: Number(x.at), modo: String(x.modo) }));
}

/** RECORRIDO-BANDEJA · Eventos de UN contacto a través de TODOS los flujos, en orden
 *  cronológico ascendente (se lee de arriba a abajo, como un chat). Es la fuente del
 *  panel «Recorrido» del chat: la conversación de la Bandeja está capada por MAX_TURNS
 *  y pierde lo antiguo, pero este registro guarda 90 días de cada paso real. Usa el
 *  índice idx_flowevents_phone; la subconsulta DESC toma los ÚLTIMOS `limit` eventos. */
export async function dbFlowEventsForPhone(phone: string, limit = 800): Promise<Array<FlowEventRow & { flow_id: string }>> {
  const tenantId = currentWorkspaceId();
  const cap = Math.min(2000, Math.max(1, limit));
  if (!pool) {
    return mem.flowEvents
      .filter((e) => e.phone === phone && e.tenant_id === tenantId)
      .sort((a, b) => a.at - b.at)
      .slice(-cap)
      .map((e) => ({ at: e.at, phone: e.phone, event: e.event, node_id: e.node_id, detail: e.detail, flow_id: e.flow_id }));
  }
  const r = await pool.query(
    `SELECT * FROM (
       SELECT extract(epoch from at)*1000 AS at, phone, event, node_id, detail, flow_id, id
         FROM app_flow_events WHERE tenant_id=$1 AND phone=$2
        ORDER BY app_flow_events.at DESC, id DESC LIMIT $3
     ) t ORDER BY t.at ASC, t.id ASC`,
    [tenantId, phone, cap],
  );
  return r.rows.map((x) => ({ at: Number(x.at), phone: x.phone, event: x.event, node_id: x.node_id, detail: x.detail, flow_id: x.flow_id }));
}

export async function dbHasActiveFlowRun(phone: string, flowId: string): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const x = mem.flowRuns.get(`${phone}:${flowId}`);
    return !!x && (x.status === "active" || x.status === "waiting") && ((x.tenant_id || "default") === tenantId);
  }
  const r = await pool.query(
    "SELECT 1 FROM app_flow_runs WHERE phone=$1 AND flow_id=$2 AND tenant_id=$3 AND status IN ('active','waiting')",
    [phone, flowId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}
/** Cancela los flujos en curso (activos o esperando) de un contacto. Lo usa el reinicio
 *  por palabra clave: si el cliente vuelve a mandar el disparador, se libera cualquier
 *  flujo atascado para poder arrancar de cero. */
/** Devuelve las filas realmente canceladas (RETURNING): el UPDATE es la ÚNICA fuente de
 *  verdad, sin ventana listar-y-cancelar — así la constancia en «Ver Logs» y el contador
 *  del botón Stop reflejan lo que de verdad pasó, no una foto previa. */
export async function dbCancelFlowRunsForPhone(phone: string, flowId?: string): Promise<Array<{ flow_id: string; node_id: string }>> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const out: Array<{ flow_id: string; node_id: string }> = [];
    for (const [k, x] of mem.flowRuns)
      if (
        x.phone === phone &&
        (!flowId || x.flow_id === flowId) &&
        (x.status === "active" || x.status === "waiting") &&
        ((x.tenant_id || "default") === tenantId)
      ) {
        out.push({ flow_id: x.flow_id, node_id: x.node_id });
        mem.flowRuns.delete(k);
      }
    return out;
  }
  // flowId → cancela SOLO ese flujo (re-disparo por comentario de IG); sin él, todos
  // los del contacto (reset por palabra clave de WhatsApp).
  const params: unknown[] = [phone, tenantId];
  let sql = "UPDATE app_flow_runs SET status='cancelled' WHERE phone=$1 AND status IN ('active','waiting') AND tenant_id=$2";
  if (flowId) { params.push(flowId); sql += ` AND flow_id=$${params.length}`; }
  sql += " RETURNING flow_id, node_id";
  const r = await pool.query(sql, params);
  return r.rows.map((x) => ({ flow_id: String(x.flow_id), node_id: String(x.node_id || "") }));
}
// WS-ARCHIVED 2026-08-07 · igual que las secuencias: un flujo de un workspace
// archivado no reanuda ni envía. El run se queda 'active' con su next_run vencido
// y continúa donde estaba en cuanto se desarchive (no se pierde ni se cancela).
/** BARRIDO-UNO-1 · Runs vencidos, RECLAMADOS: quien los recibe es el único que los ejecuta.
 *
 *  Antes esto era un SELECT a secas y dos barridos que coincidieran devolvían LOS MISMOS runs:
 *  los dos ejecutaban el mismo paso y el contacto recibía el mensaje dos veces. Y coincidir es
 *  fácil, porque hay dos relojes — el de cada 30 s y el barrido extra que se pide al vencer una
 *  espera corta (flowTickSoon). Medido en producción el 3-sep-2026 a las 20:31:17: el mismo paso
 *  enviado dos veces con un segundo de diferencia, con UNA sola entrada al flujo.
 *
 *  Al reclamarlos se les aparta el reloj (RUN_GRACE_MS, los 15 min que ya usa el motor al crear
 *  un run): si este proceso muere a mitad, el run no se pierde — vuelve a estar disponible pasado
 *  ese rato. Es el mismo patrón del claim de las difusiones programadas. */
export async function dbDueFlowRuns(): Promise<FlowRun[]> {
  const graciaMs = 15 * 60_000;
  if (!pool) {
    const ahora = Date.now();
    const out: FlowRun[] = [];
    for (const [k, x] of mem.flowRuns) {
      if (out.length >= 50) break;
      if (x.status !== "active" || x.next_run > ahora || memTenantArchived(x.tenant_id)) continue;
      out.push({ ...x });
      // Mismo apartado que en Postgres: un segundo barrido ya no lo ve.
      mem.flowRuns.set(k, { ...x, next_run: ahora + graciaMs });
    }
    return out;
  }
  const r = await pool.query(
    `UPDATE app_flow_runs SET next_run = now() + make_interval(secs => $1::double precision)
       WHERE (phone, flow_id) IN (
         SELECT phone, flow_id FROM app_flow_runs
          WHERE status='active' AND next_run<=now() AND ${wsNotArchivedSql("app_flow_runs.tenant_id")}
          ORDER BY next_run LIMIT 50 FOR UPDATE SKIP LOCKED
       )
     RETURNING phone,flow_id,node_id,vars,status, extract(epoch from next_run)*1000 next_run, tenant_id`,
    [graciaMs / 1000],
  );
  return r.rows.map((x) => ({ ...x, next_run: Number(x.next_run), tenant_id: x.tenant_id || "default" })) as FlowRun[];
}
/** SEGUIMIENTO SI NO RESPONDE · runs en ESPERA cuyo reloj de reenganche ha vencido. Solo
 *  los que un flujo con seguimiento activo armó (next_run real); los no armados llevan
 *  next_run="nunca" (8.64e15) y no salen. */
export async function dbDueWaitingFlowRuns(): Promise<FlowRun[]> {
  if (!pool)
    return [...mem.flowRuns.values()].filter(
      (x) => x.status === "waiting" && x.next_run <= Date.now() && !memTenantArchived(x.tenant_id),
    );
  // WS-ARCHIVED 2026-08-07 · el reenganche «si no responde» es un mensaje saliente
  // más: un negocio suspendido no lo manda. Se queda armado para cuando vuelva.
  const r = await pool.query(
    "SELECT phone,flow_id,node_id,vars,status, extract(epoch from next_run)*1000 next_run, tenant_id FROM app_flow_runs WHERE status='waiting' AND next_run<=now() AND " +
      wsNotArchivedSql("app_flow_runs.tenant_id") + " LIMIT 100",
  );
  return r.rows.map((x) => ({ ...x, next_run: Number(x.next_run), tenant_id: x.tenant_id || "default" })) as FlowRun[];
}
/** Métricas reales de un flujo (Insights). Todo se deriva de datos persistidos. */
export async function dbFlowStats(flowId: string): Promise<FlowStats> {
  // SECURITY-FIX 2026-06-20 · acotar TODAS las queries por tenant_id. Antes
  // agregaba app_flow_runs por flow_id sin filtrar tenant (cross-tenant). En
  // single-tenant el tenant es 'default' → cifras idénticas a antes.
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const runs = [...mem.flowRuns.values()].filter(
      (x) => x.flow_id === flowId && (x.tenant_id || "default") === tenantId,
    );
    const by = (s: string) => runs.filter((r) => r.status === s).length;
    return {
      contacts: runs.length,
      active: by("active"),
      waiting: by("waiting"),
      done: by("done"),
      cancelled: by("cancelled"),
      clicks: 0,
      daily: [],
    };
  }
  const agg = await pool.query(
    "SELECT status, COUNT(*)::int n FROM app_flow_runs WHERE flow_id=$1 AND tenant_id=$2 GROUP BY status",
    [flowId, tenantId],
  );
  const m: Record<string, number> = {};
  for (const row of agg.rows) m[row.status] = Number(row.n);
  const daily = await pool.query(
    `SELECT to_char(date_trunc('day',updated_at),'YYYY-MM-DD') d, COUNT(*)::int c
     FROM app_flow_runs WHERE flow_id=$1 AND tenant_id=$2 AND updated_at > now() - interval '7 days'
     GROUP BY 1 ORDER BY 1`,
    [flowId, tenantId],
  );
  let clicks = 0;
  try {
    const clk = await pool.query(
      `SELECT COUNT(*)::int n FROM app_link_clicks c
       JOIN app_short_links sl ON sl.token=c.token
       WHERE sl.context_kind='flow' AND sl.context_id=$1 AND sl.tenant_id=$2`,
      [flowId, tenantId],
    );
    clicks = Number(clk.rows[0]?.n || 0);
  } catch {
    /* tablas de links opcionales */
  }
  return {
    contacts: (m.active || 0) + (m.waiting || 0) + (m.done || 0) + (m.cancelled || 0),
    active: m.active || 0,
    waiting: m.waiting || 0,
    done: m.done || 0,
    cancelled: m.cancelled || 0,
    clicks,
    daily: daily.rows.map((x: any) => ({ d: x.d, c: Number(x.c) })),
  };
}

/** FIX id76 · Stats de TODOS los flujos del tenant en UNA pasada, acotadas por
 *  ventana temporal [sinceMs, untilMs]: runs por updated_at, clics por el
 *  created_at del clic. Sustituye al fan-out dbFlowStats(flowId) por flujo en
 *  segAutomation, que agregaba histórico de toda la vida bajo un date-picker
 *  que decía «Últimos N días» y además capaba a 30 flujos ANTES de ordenar. */
export interface FlowStatsWindowRow {
  flow_id: string;
  contacts: number;
  active: number;
  waiting: number;
  done: number;
  cancelled: number;
  clicks: number;
  /** METRICAS-1 · personas distintas (con teléfono) que pulsaron: base de la tasa de clic. */
  clickers?: number;
  /** MEJORA-1 · personas DISTINTAS a las que el flujo no pudo entregar algún mensaje o adjunto
   *  en la ventana (eventos «paso NO entregado» / «adjunto NO entregado» del registro). */
  sinEntregar: number;
}
// Cuánta gente hay AHORA en cada flujo. Sin ventana a propósito: «ahora» es una
// foto del presente, no un recuento del rango. Quien lleva esperando desde antes
// del rango sigue dentro, y con la ventana puesta se caía de la cuenta — con el
// rango en «hoy», un flujo con gente esperando de la semana pasada salía a cero.
// CLASIFICA-FLUJOS-1 (MET-AUTO-02) · `phones` opcional: acota la foto a un subconjunto
// de personas (el filtro «fuente de captación» de la pestaña). Un array vacío = nadie.
export async function dbFlowsDentroAhora(phones?: string[]): Promise<Map<string, number>> {
  const tenantId = currentWorkspaceId();
  const out = new Map<string, number>();
  const phoneSet = phones ? new Set(phones) : null;
  if (!pool) {
    for (const r of mem.flowRuns.values()) {
      if (((r as unknown as { tenant_id?: string }).tenant_id || "default") !== tenantId) continue;
      if (r.status !== "active" && r.status !== "waiting") continue;
      if (phoneSet && !phoneSet.has(r.phone)) continue;
      out.set(r.flow_id, (out.get(r.flow_id) || 0) + 1);
    }
    return out;
  }
  const q = await pool.query(
    `SELECT flow_id, COUNT(*)::int n
       FROM app_flow_runs
      WHERE tenant_id=$1 AND status IN ('active','waiting')
        ${phoneSet ? "AND phone = ANY($2)" : ""}
      GROUP BY 1`,
    phoneSet ? [tenantId, [...phoneSet]] : [tenantId],
  );
  for (const x of q.rows) out.set(String(x.flow_id), Number(x.n) || 0);
  return out;
}
// CLASIFICA-FLUJOS-1 (MET-AUTO-02) · `phones` opcional: misma acotación por personas que
// dbFlowsDentroAhora (runs, clics y entregas fallidas de ese subconjunto).
export async function dbFlowStatsAllWindow(sinceMs: number, untilMs: number, phones?: string[]): Promise<Map<string, FlowStatsWindowRow>> {
  const tenantId = currentWorkspaceId();
  const out = new Map<string, FlowStatsWindowRow>();
  const phoneSet = phones ? new Set(phones) : null;
  const porPhone = phoneSet ? [...phoneSet] : null;
  const mk = (id: string): FlowStatsWindowRow => {
    const cur = out.get(id);
    if (cur) return cur;
    const fresh: FlowStatsWindowRow = { flow_id: id, contacts: 0, active: 0, waiting: 0, done: 0, cancelled: 0, clicks: 0, sinEntregar: 0 };
    out.set(id, fresh);
    return fresh;
  };
  // MEJORA-1 · un mensaje que no salió no es falta de interés: se cuenta aparte para que el
  // Resumen no lo lea como «la gente no contesta». Mismas marcas que escribe flows.ts.
  const noEntregado = (event: string, detail: string) =>
    event === "paso NO entregado" || (event === "error" && (detail.startsWith("paso NO entregado") || detail.startsWith("adjunto NO entregado")));
  if (!pool) {
    for (const r of mem.flowRuns.values()) {
      if (((r as unknown as { tenant_id?: string }).tenant_id || "default") !== tenantId) continue;
      // CLASIFICA-FLUJOS-1 · en memoria el run lleva updated_at al guardarse; next_run nace
      // 15 min en el futuro (CARRERA-TICK-1) y dejaba fuera de «hasta ahora» los runs recientes.
      // Runs sin marca se incluyen (mejor sobre-contar en el fallback de tests que ocultar actividad).
      const at = (r as unknown as { updated_at?: number }).updated_at || r.next_run || 0;
      if (at && (at < sinceMs || at > untilMs)) continue;
      if (phoneSet && !phoneSet.has(r.phone)) continue;
      const row = mk(r.flow_id);
      row.contacts++;
      if (r.status === "active") row.active++;
      else if (r.status === "waiting") row.waiting++;
      else if (r.status === "done") row.done++;
      else if (r.status === "cancelled") row.cancelled++;
    }
    const fallos = new Map<string, Set<string>>();
    for (const e of mem.flowEvents) {
      if ((e.tenant_id || "default") !== tenantId || e.at < sinceMs || e.at > untilMs) continue;
      if (phoneSet && !phoneSet.has(e.phone)) continue;
      if (!noEntregado(e.event, e.detail || "")) continue;
      const set = fallos.get(e.flow_id) || new Set<string>();
      set.add(e.phone);
      fallos.set(e.flow_id, set);
    }
    for (const [fid, set] of fallos) mk(fid).sinEntregar = set.size;
    return out;
  }
  const params = porPhone ? [tenantId, sinceMs, untilMs, porPhone] : [tenantId, sinceMs, untilMs];
  const agg = await pool.query(
    `SELECT flow_id, status, COUNT(*)::int n
       FROM app_flow_runs
      WHERE tenant_id=$1 AND updated_at BETWEEN to_timestamp($2/1000.0) AND to_timestamp($3/1000.0)
        ${porPhone ? "AND phone = ANY($4)" : ""}
      GROUP BY 1,2`,
    params,
  );
  for (const x of agg.rows) {
    const row = mk(String(x.flow_id));
    const n = Number(x.n) || 0;
    row.contacts += n;
    if (x.status === "active") row.active += n;
    else if (x.status === "waiting") row.waiting += n;
    else if (x.status === "done") row.done += n;
    else if (x.status === "cancelled") row.cancelled += n;
  }
  try {
    const clk = await pool.query(
      `SELECT sl.context_id AS flow_id, COUNT(*)::int n, COUNT(DISTINCT NULLIF(c.phone,''))::int p
         FROM app_link_clicks c
         JOIN app_short_links sl ON sl.token=c.token
        WHERE sl.context_kind='flow' AND sl.tenant_id=$1
          AND c.created_at BETWEEN to_timestamp($2/1000.0) AND to_timestamp($3/1000.0)
          ${porPhone ? "AND c.phone = ANY($4)" : ""}
        GROUP BY 1`,
      params,
    );
    for (const x of clk.rows) {
      const r = mk(String(x.flow_id));
      r.clicks += Number(x.n) || 0;
      r.clickers = (r.clickers || 0) + (Number(x.p) || 0);
    }
  } catch {
    /* tablas de links opcionales */
  }
  try {
    const fal = await pool.query(
      `SELECT flow_id, COUNT(DISTINCT phone)::int n
         FROM app_flow_events
        WHERE tenant_id=$1 AND at BETWEEN to_timestamp($2/1000.0) AND to_timestamp($3/1000.0)
          AND (event='paso NO entregado'
               OR (event='error' AND (detail LIKE 'paso NO entregado%' OR detail LIKE 'adjunto NO entregado%')))
          ${porPhone ? "AND phone = ANY($4)" : ""}
        GROUP BY 1`,
      params,
    );
    for (const x of fal.rows) mk(String(x.flow_id)).sinEntregar = Number(x.n) || 0;
  } catch {
    /* el registro de flujos es opcional: sin él no se afirma nada sobre entregas */
  }
  return out;
}

// CLASIFICA-FLUJOS-1 (MET-AUTO-02) · personas DISTINTAS con algún run tocado en la ventana
// (mismo criterio que dbFlowStatsAllWindow: updated_at / next_run en memoria). Sirve para
// clasificar la fuente de captación de quien pasó por los flujos sin traerse los runs.
// Tope de 20.000 personas: por encima se devuelve `parcial` y la pestaña lo declara en
// vez de inventar un reparto. `flowIds` acota a los flujos del canal filtrado.
export async function dbFlowRunPhonesWindow(sinceMs: number, untilMs: number, flowIds?: string[]): Promise<{ phones: string[]; parcial: boolean }> {
  const tenantId = currentWorkspaceId();
  const idSet = flowIds ? new Set(flowIds) : null;
  const TOPE = 20000;
  if (!pool) {
    const set = new Set<string>();
    for (const r of mem.flowRuns.values()) {
      if (((r as unknown as { tenant_id?: string }).tenant_id || "default") !== tenantId) continue;
      if (idSet && !idSet.has(r.flow_id)) continue;
      const at = (r as unknown as { updated_at?: number }).updated_at || r.next_run || 0;
      if (at && (at < sinceMs || at > untilMs)) continue;
      set.add(r.phone);
    }
    const phones = [...set];
    return { phones: phones.slice(0, TOPE), parcial: phones.length > TOPE };
  }
  const q = await pool.query(
    `SELECT DISTINCT phone FROM app_flow_runs
      WHERE tenant_id=$1 AND updated_at BETWEEN to_timestamp($2/1000.0) AND to_timestamp($3/1000.0)
        ${idSet ? "AND flow_id = ANY($4)" : ""}
      LIMIT ${TOPE + 1}`,
    idSet ? [tenantId, sinceMs, untilMs, [...idSet]] : [tenantId, sinceMs, untilMs],
  );
  const phones = q.rows.map((x: { phone: string }) => String(x.phone));
  return { phones: phones.slice(0, TOPE), parcial: phones.length > TOPE };
}

/** CLASIFICA-FLUJOS-1 (MET-AUTO-02) · por dónde entró la gente a cada flujo en la ventana:
 *  las entradas («entró» del registro) agrupadas por punto de entrada, con personas
 *  distintas. Un flujo que arranca por un comentario y por una palabra escrita se desglosa
 *  sin duplicar su ficha. Fuera: las entradas en modo prueba («PRUEBA · …») y el histórico
 *  reconstruido del arranque. El detalle se normaliza para que el «de @usuario» de los
 *  comentarios o el asunto del correo no fabriquen un punto de entrada por persona;
 *  la CASE del SQL es el espejo exacto de normalizarEntrada. */
export function normalizarEntrada(detail: string): string {
  const d = String(detail || "");
  if (d.startsWith("Instagram · comentario")) return "Instagram · comentario";
  if (d.startsWith("Facebook · comentario")) return "Facebook · comentario";
  if (d.startsWith("Reserva en tu web")) return "Reserva en tu web";
  if (d.startsWith("Aviso de reunión")) return "Aviso de reunión";
  if (d.startsWith("Correo · ")) return d.split(" · «")[0];
  return d.slice(0, 120);
}
export interface FlowEntradaRow { detalle: string; entradas: number; personas: number }
const ENTRADAS_POR_FLUJO = 12;
export async function dbFlowEntradasWindow(sinceMs: number, untilMs: number, phones?: string[]): Promise<Map<string, FlowEntradaRow[]>> {
  const tenantId = currentWorkspaceId();
  const phoneSet = phones ? new Set(phones) : null;
  const out = new Map<string, FlowEntradaRow[]>();
  const excluida = (d: string) => d.startsWith("PRUEBA · ") || d === "histórico reconstruido";
  if (!pool) {
    const acc = new Map<string, Map<string, { n: number; p: Set<string> }>>();
    for (const e of mem.flowEvents) {
      if ((e.tenant_id || "default") !== tenantId || e.event !== "entró" || e.at < sinceMs || e.at > untilMs) continue;
      if (phoneSet && !phoneSet.has(e.phone)) continue;
      const d = String(e.detail || "");
      if (excluida(d)) continue;
      const k = normalizarEntrada(d);
      const porFlujo = acc.get(e.flow_id) || new Map<string, { n: number; p: Set<string> }>();
      const cur = porFlujo.get(k) || { n: 0, p: new Set<string>() };
      cur.n++;
      cur.p.add(e.phone);
      porFlujo.set(k, cur);
      acc.set(e.flow_id, porFlujo);
    }
    for (const [fid, porFlujo] of acc) {
      const rows = [...porFlujo].map(([detalle, v]) => ({ detalle, entradas: v.n, personas: v.p.size }));
      rows.sort((a, b) => b.entradas - a.entradas);
      out.set(fid, rows.slice(0, ENTRADAS_POR_FLUJO));
    }
    return out;
  }
  try {
    const q = await pool.query(
      `SELECT flow_id,
              CASE WHEN detail LIKE 'Instagram · comentario%' THEN 'Instagram · comentario'
                   WHEN detail LIKE 'Facebook · comentario%' THEN 'Facebook · comentario'
                   WHEN detail LIKE 'Reserva en tu web%' THEN 'Reserva en tu web'
                   WHEN detail LIKE 'Aviso de reunión%' THEN 'Aviso de reunión'
                   WHEN detail LIKE 'Correo · %' THEN split_part(detail, ' · «', 1)
                   ELSE left(detail, 120) END AS detalle,
              COUNT(*)::int n, COUNT(DISTINCT phone)::int p
         FROM app_flow_events
        WHERE tenant_id=$1 AND event='entró'
          AND at BETWEEN to_timestamp($2/1000.0) AND to_timestamp($3/1000.0)
          AND detail NOT LIKE 'PRUEBA · %' AND detail <> 'histórico reconstruido'
          ${phoneSet ? "AND phone = ANY($4)" : ""}
        GROUP BY 1,2 ORDER BY 1, 3 DESC`,
      phoneSet ? [tenantId, sinceMs, untilMs, [...phoneSet]] : [tenantId, sinceMs, untilMs],
    );
    for (const x of q.rows) {
      const fid = String(x.flow_id);
      const list = out.get(fid) || [];
      if (list.length < ENTRADAS_POR_FLUJO) list.push({ detalle: String(x.detalle), entradas: Number(x.n) || 0, personas: Number(x.p) || 0 });
      out.set(fid, list);
    }
  } catch {
    /* el registro de flujos es opcional: sin él no se desglosa nada */
  }
  return out;
}

/** EMBUDO de un flujo (eficiencia post-live). Devuelve, acotado por tenant:
 *  - contacts: contactos únicos que entraron (una fila por persona por la PK phone+flow_id)
 *  - clickers: PERSONAS distintas que clicaron algún enlace del flujo (no clics totales)
 *  - tags: [{tag, n}] cada etiqueta presente entre los contactos del flujo con nº de contactos
 *    distintos que la tienen (tag en minúsculas; el endpoint las normaliza y cruza con las
 *    etiquetas que el propio flujo aplica para armar las etapas). Todo server-side, sin cap. */
export interface FlowFunnel {
  contacts: number;
  clickers: number;
  tags: { tag: string; n: number }[];
}
export async function dbFlowFunnel(flowId: string): Promise<FlowFunnel> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const runs = [...mem.flowRuns.values()].filter((r) => r.flow_id === flowId && (r.tenant_id || "default") === tenantId);
    const tagMap = new Map<string, number>();
    for (const r of runs) {
      const c = mem.contacts.get(contactMemKey(r.phone));
      const seen = new Set<string>();
      for (const t of (c?.tags || [])) {
        const k = String(t || "").toLowerCase().trim();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        tagMap.set(k, (tagMap.get(k) || 0) + 1);
      }
    }
    return { contacts: runs.length, clickers: 0, tags: [...tagMap].map(([tag, n]) => ({ tag, n })) };
  }
  const cRes = await pool.query("SELECT COUNT(*)::int n FROM app_flow_runs WHERE flow_id=$1 AND tenant_id=$2", [flowId, tenantId]);
  let clickers = 0;
  try {
    const clk = await pool.query(
      "SELECT COUNT(DISTINCT NULLIF(c.phone,''))::int n FROM app_link_clicks c JOIN app_short_links sl ON sl.token=c.token WHERE sl.context_kind='flow' AND sl.context_id=$1 AND sl.tenant_id=$2",
      [flowId, tenantId],
    );
    clickers = clk.rows[0]?.n || 0;
  } catch { /* tablas de links opcionales */ }
  let tags: { tag: string; n: number }[] = [];
  try {
    // Una fila por (contacto, etiqueta): COUNT(DISTINCT phone) por etiqueta = personas con ella.
    const tRes = await pool.query(
      `SELECT lower(t) tag, COUNT(DISTINCT r.phone)::int n
       FROM app_flow_runs r
       JOIN app_contacts ct ON ct.phone = r.phone AND ct.tenant_id = r.tenant_id
       CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(ct.tags, '[]'::jsonb)) t
       WHERE r.flow_id = $1 AND r.tenant_id = $2
       GROUP BY lower(t)`,
      [flowId, tenantId],
    );
    tags = tRes.rows.map((x: any) => ({ tag: String(x.tag || ""), n: Number(x.n) || 0 }));
  } catch { /* app_contacts sin tags o sin filas */ }
  return { contacts: cRes.rows[0]?.n || 0, clickers, tags };
}

/** OBJETIVO-FLUJO-1 · compra registrada (webhook de ventas: fields.purchased_at /
 *  last_purchase_at) de estos contactos, en epoch ms: la más reciente de las dos. Una consulta. */
export async function dbComprasDeContactos(phones: string[]): Promise<Map<string, number>> {
  const tenantId = currentWorkspaceId();
  const out = new Map<string, number>();
  const ts = (f: Record<string, unknown> | undefined) => Math.max(0, ...[f?.purchased_at, f?.last_purchase_at].map((x) => Date.parse(String(x || ""))).filter((n) => n > 0));
  if (!phones.length) return out;
  if (!pool) {
    for (const p of phones) { const t = ts(mem.contacts.get(contactMemKey(p))?.fields as Record<string, unknown>); if (t > 0) out.set(p, t); }
    return out;
  }
  try {
    const r = await pool.query(
      `SELECT phone, fields->>'purchased_at' AS a, fields->>'last_purchase_at' AS b FROM app_contacts
        WHERE tenant_id=$1 AND phone = ANY($2::text[]) AND (fields ? 'purchased_at' OR fields ? 'last_purchase_at')`,
      [tenantId, phones],
    );
    for (const x of r.rows as { phone: string; a: string; b: string }[]) { const t = ts({ purchased_at: x.a, last_purchase_at: x.b }); if (t > 0) out.set(x.phone, t); }
  } catch { /* sin fichas */ }
  return out;
}

/* ============================================================
 * DETALLE de un flujo (drill-down de «Rendimiento por flujo»).
 * Todo acotado por tenant_id. Devuelve datos CRUDOS por contacto/paso/enlace;
 * el endpoint agrega (cruce systeme.io, origen/UTM, embudo por paso).
 * ============================================================ */
export interface FlowDetailRunRow {
  phone: string;
  run_status: string;
  node_id: string;
  entered_at: number; // epoch ms (COALESCE(created_at,updated_at))
  /** AVANCE-FLUJO-1 · epoch ms del próximo disparo programado (espera o recordatorio);
   *  null si no hay nada programado (el centinela «nunca» FU_FAR se filtra aquí). */
  next_at: number | null;
  name: string;
  email: string;
  systemeio_contact_id: string;
  tags: string[];
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  source: string;
  stage: string;
  /** ETQ-07-FIN · medido por EVENTOS, no por el nombre de una etiqueta: abrió un enlace de
   *  registro/webinar repartido en este negocio (app_link_clicks) y systeme.io confirmó su
   *  registro (fields.sio_registered_at, que escribe el webhook). */
  clicked_reg: boolean;
  sio_registered: boolean;
}
export interface FlowDetailLinkRow {
  /** URL base SIN query (?ref=… es una variante POR PERSONA para atribución: sin
   *  agrupar, un flujo con 240 contactos pintaba 240 filas del mismo enlace). */
  url: string;
  label: string;
  clicks: number;
  people: number;
  last_click_at: number | null;
  /** Cuántos short-links personalizados (uno por persona) agrupa esta fila. */
  variants: number;
}
export interface FlowDetail {
  nodeNow: Array<{ node_id: string; status: string; n: number }>;
  daily: Array<{ d: string; c: number }>;
  runs: FlowDetailRunRow[];
  links: FlowDetailLinkRow[];
}

export async function dbFlowDetail(flowId: string, maxRuns = 500): Promise<FlowDetail> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const runs = [...mem.flowRuns.values()].filter(
      (x) => x.flow_id === flowId && (x.tenant_id || "default") === tenantId,
    );
    return {
      nodeNow: [],
      daily: [],
      runs: runs.slice(0, maxRuns).map((r) => {
        const c = mem.contacts.get(contactMemKey(r.phone));
        return {
          phone: r.phone, run_status: r.status, node_id: r.node_id,
          entered_at: r.next_run || Date.now(),
          next_at: r.next_run && r.next_run < 4e15 ? r.next_run : null,
          name: c?.name || "", email: c?.email || "",
          systemeio_contact_id: c?.systemeio_contact_id || "",
          tags: c?.tags || [],
          utm_source: c?.utm_source || "", utm_medium: c?.utm_medium || "",
          utm_campaign: c?.utm_campaign || "", utm_content: c?.utm_content || "",
          source: c?.source || "", stage: c?.stage || "",
          clicked_reg: false,
          sio_registered: !!((c?.fields || {}) as Record<string, unknown>).sio_registered_at,
        };
      }),
      links: [],
    };
  }
  // Dónde está la gente AHORA (solo runs vivos: active=en curso/espera de delay,
  // waiting=esperando respuesta). Los done/cancelled no tienen "paso actual" útil.
  const nodeNow = await pool.query(
    `SELECT node_id, status, COUNT(*)::int n FROM app_flow_runs
     WHERE flow_id=$1 AND tenant_id=$2 AND status IN ('active','waiting')
     GROUP BY node_id, status`,
    [flowId, tenantId],
  );
  // Entradas por día (30d) por fecha de ENTRADA al flujo.
  const daily = await pool.query(
    `SELECT to_char(date_trunc('day',COALESCE(created_at,updated_at)),'YYYY-MM-DD') d, COUNT(*)::int c
     FROM app_flow_runs WHERE flow_id=$1 AND tenant_id=$2
       AND COALESCE(created_at,updated_at) > now() - interval '30 days'
     GROUP BY 1 ORDER BY 1`,
    [flowId, tenantId],
  );
  // Cada run con su contacto (para cruce systeme.io + origen/UTM + lista).
  const runs = await pool.query(
    `SELECT r.phone, r.status run_status, r.node_id,
            extract(epoch from COALESCE(r.created_at,r.updated_at))*1000 entered_at,
            extract(epoch from r.next_run)*1000 next_at,
            COALESCE(ct.name,'') name, COALESCE(ct.email,'') email,
            COALESCE(ct.systemeio_contact_id,'') systemeio_contact_id,
            COALESCE(ct.tags,'[]'::jsonb) tags,
            COALESCE(ct.utm_source,'') utm_source, COALESCE(ct.utm_medium,'') utm_medium,
            COALESCE(ct.utm_campaign,'') utm_campaign, COALESCE(ct.utm_content,'') utm_content,
            COALESCE(ct.source,'') source, COALESCE(ct.stage,'') stage,
            -- ETQ-07-FIN · el clic sale del registro de clics (misma regla que /r/: URL de
            -- registro o webinar), no de la etiqueta clico-*, que cualquiera puede poner a mano.
            EXISTS (SELECT 1 FROM app_link_clicks lc JOIN app_short_links sl ON sl.token=lc.token
                    WHERE lc.phone=r.phone AND lc.tenant_id=$2 AND sl.tenant_id=$2
                      AND (sl.url ~* 'registro' OR sl.url ~* 'webinar')) clicked_reg,
            -- ETQ-07-FIN · registro = lo confirmó systeme.io (sio_registered_at). Los anteriores a
            -- este campo cuentan sólo si además están sincronizados con systeme.io: la etiqueta
            -- sola, puesta a mano, ya no basta.
            (COALESCE(ct.fields->>'sio_registered_at','')<>''
              OR (COALESCE(ct.systemeio_contact_id,'')<>'' AND COALESCE(ct.tags,'[]'::jsonb) ? 'sio-registrado')) sio_registered
     FROM app_flow_runs r
     LEFT JOIN app_contacts ct ON ct.phone=r.phone AND ct.tenant_id=$2
     WHERE r.flow_id=$1 AND r.tenant_id=$2
     ORDER BY COALESCE(r.created_at,r.updated_at) DESC
     LIMIT $3`,
    [flowId, tenantId, maxRuns],
  );
  // Enlaces repartidos por ESTE flujo, con clics totales y personas únicas.
  let links: FlowDetailLinkRow[] = [];
  try {
    // AGRUPADO por URL base (sin query): el flujo genera un short-link POR PERSONA
    // (la URL lleva ?ref=<contacto> para que el webhook de systeme.io correlacione).
    // Sin agrupar, la tabla pintaba una fila por persona — mismo enlace 240 veces.
    const lr = await pool.query(
      `SELECT split_part(sl.url,'?',1) url,
              COALESCE(MAX(NULLIF(sl.label,'')),'') label,
              COUNT(c.id)::int clicks,
              COUNT(DISTINCT NULLIF(c.phone,''))::int people,
              extract(epoch from MAX(c.created_at))*1000 last_click_at,
              COUNT(DISTINCT sl.token)::int variants
       FROM app_short_links sl
       LEFT JOIN app_link_clicks c ON c.token=sl.token
       WHERE sl.context_kind='flow' AND sl.context_id=$1 AND sl.tenant_id=$2
       GROUP BY 1
       ORDER BY clicks DESC`,
      [flowId, tenantId],
    );
    links = lr.rows.map((x: any) => ({
      url: x.url || "", label: x.label || "",
      clicks: Number(x.clicks) || 0, people: Number(x.people) || 0,
      last_click_at: x.last_click_at ? Number(x.last_click_at) : null,
      variants: Number(x.variants) || 0,
    }));
  } catch { /* tablas de links opcionales */ }
  return {
    nodeNow: nodeNow.rows.map((x: any) => ({ node_id: x.node_id, status: x.status, n: Number(x.n) })),
    daily: daily.rows.map((x: any) => ({ d: x.d, c: Number(x.c) })),
    runs: runs.rows.map((x: any) => ({
      phone: x.phone, run_status: x.run_status, node_id: x.node_id,
      entered_at: Number(x.entered_at) || 0,
      // AVANCE-FLUJO-1 · el centinela «nunca» (FU_FAR ≈ 8.64e15) no es un avance real.
      next_at: (Number(x.next_at) || 0) > 0 && Number(x.next_at) < 4e15 ? Number(x.next_at) : null,
      name: x.name, email: x.email, systemeio_contact_id: x.systemeio_contact_id,
      tags: Array.isArray(x.tags) ? x.tags : [],
      utm_source: x.utm_source, utm_medium: x.utm_medium,
      utm_campaign: x.utm_campaign, utm_content: x.utm_content,
      source: x.source, stage: x.stage,
      clicked_reg: !!x.clicked_reg, sio_registered: !!x.sio_registered,
    })),
    links,
  };
}

/* ============================================================
 * Leads de systeme.io / leadmatch-lab con URL de origen (app_sio_leads).
 * Copia local por cuenta, sincronizada vía API pública (sio-leads.ts).
 * ============================================================ */
export interface SioLead {
  account_id: string;
  sio_contact_id: number;
  email: string;
  registered_at: number | null; // epoch ms
  source_url: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  tenant_id?: string;
  /** ORIGEN-VISITA-1 · ver la columna en initDb. */
  origen_visita?: string;
}

/**
 * SIO-RUIDO-1 · devuelve cuántas filas eran NUEVAS de verdad. La sincronización horaria
 * relee siempre la página más reciente (100 contactos) para ver si hay altas; sin este
 * dato, quien la llama solo sabe cuántas MIRÓ, y el registro de actividad acababa
 * diciendo «100 leads copiados» cada hora aunque no hubiera entrado ni uno.
 * `xmax = 0` es la forma estándar en Postgres de distinguir, dentro de un upsert, la fila
 * insertada de la actualizada.
 */
export async function dbSioLeadsUpsert(rows: SioLead[]): Promise<number> {
  if (!rows.length) return 0;
  const tenantId = currentWorkspaceId();
  if (!pool) {
    // SIO-LEADS-TENANT-1 · la clave lleva el workspace DELANTE, igual que el índice
    // único de Postgres: sin él, dos workspaces con el mismo account_id se pisaban
    // las filas en memoria (y el arnés nunca reproducía lo que pasaba en producción).
    let nuevas = 0;
    for (const r of rows) {
      const k = `${tenantId}:${r.account_id}:${r.sio_contact_id}`;
      if (!mem.sioLeads.has(k)) nuevas++;
      mem.sioLeads.set(k, { ...r, tenant_id: tenantId });
    }
    return nuevas;
  }
  // Batch por VALUES multi-fila (≤100 por página de sync → 1 query por página).
  // SIO-LEADS-TENANT-1 · el DO UPDATE lleva `WHERE app_sio_leads.tenant_id =
  // EXCLUDED.tenant_id`: la PK heredada no incluye el workspace, así que sin ese
  // WHERE una cuenta cuyo id chocara con la de otro workspace le SOBRESCRIBÍA sus
  // leads (y el tenant_id se quedaba en el del dueño original, o sea: datos de un
  // negocio dentro de la ficha de otro). Con el WHERE, la fila ajena no se toca y
  // tampoco cuenta como nueva.
  const vals: string[] = [];
  const args: unknown[] = [];
  let i = 0;
  for (const r of rows) {
    vals.push(`($${++i},$${++i},$${++i},$${++i},to_timestamp($${++i}/1000.0),$${++i},$${++i},$${++i},$${++i},$${++i},now())`);
    args.push(r.account_id, r.sio_contact_id, tenantId, r.email, r.registered_at ?? null,
      r.source_url, r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content);
  }
  const r = await pool.query(
    `INSERT INTO app_sio_leads (account_id,sio_contact_id,tenant_id,email,registered_at,source_url,utm_source,utm_medium,utm_campaign,utm_content,synced_at)
     VALUES ${vals.join(",")}
     ON CONFLICT (account_id,sio_contact_id) DO UPDATE SET
       email=EXCLUDED.email, registered_at=EXCLUDED.registered_at, source_url=EXCLUDED.source_url,
       utm_source=EXCLUDED.utm_source, utm_medium=EXCLUDED.utm_medium,
       utm_campaign=EXCLUDED.utm_campaign, utm_content=EXCLUDED.utm_content, synced_at=now()
     WHERE app_sio_leads.tenant_id = EXCLUDED.tenant_id
     RETURNING (xmax = 0) AS nueva`,
    args,
  );
  return r.rows.reduce((n, x) => n + (x.nueva ? 1 : 0), 0);
}

/* ============================================================
 * Reservas del calendario de booking (app_sio_bookings). Copia local por
 * cuenta, sincronizada vía API pública oficial (sio-bookings.ts).
 * ============================================================ */
export interface SioBooking {
  account_id: string;
  booking_id: number;
  booked_at: number | null; // epoch ms
  created_at: number | null; // epoch ms
  event_name: string;
  duration_min: number | null;
  status: string; // SCHEDULED | UPCOMING | PAST | RESCHEDULED | CANCELLED
  payment_status: string;
  event_type: string;
  contact_name: string;
  email: string;
  contact_key?: string; // RESERVA-WA-3 · ficha unida ('' sin unir)
  tenant_id?: string;
}

export async function dbSioBookingsUpsert(rows: SioBooking[]): Promise<void> {
  if (!rows.length) return;
  const tenantId = currentWorkspaceId();
  if (!pool) {
    for (const r of rows) {
      const k = `${r.account_id}:${r.booking_id}`;
      mem.sioBookings.set(k, { ...r, contact_key: mem.sioBookings.get(k)?.contact_key || r.contact_key || "", tenant_id: tenantId });
    }
    return;
  }
  // Batch multi-fila como el sync de leads. El DO UPDATE es lo que hace que una
  // reserva reprogramada o cancelada se corrija sola en la siguiente pasada.
  const vals: string[] = [];
  const args: unknown[] = [];
  let i = 0;
  for (const r of rows) {
    vals.push(`($${++i},$${++i},$${++i},to_timestamp($${++i}/1000.0),to_timestamp($${++i}/1000.0),$${++i},$${++i},$${++i},$${++i},$${++i},$${++i},$${++i},now())`);
    args.push(r.account_id, r.booking_id, tenantId, r.booked_at ?? null, r.created_at ?? null,
      r.event_name, r.duration_min ?? null, r.status, r.payment_status, r.event_type, r.contact_name, r.email);
  }
  await pool.query(
    `INSERT INTO app_sio_bookings (account_id,booking_id,tenant_id,booked_at,created_at,event_name,duration_min,status,payment_status,event_type,contact_name,email,synced_at)
     VALUES ${vals.join(",")}
     ON CONFLICT (account_id,booking_id) DO UPDATE SET
       booked_at=EXCLUDED.booked_at, event_name=EXCLUDED.event_name, duration_min=EXCLUDED.duration_min,
       status=EXCLUDED.status, payment_status=EXCLUDED.payment_status, event_type=EXCLUDED.event_type,
       contact_name=EXCLUDED.contact_name, email=EXCLUDED.email, synced_at=now()`,
    args,
  );
}

/**
 * FORM-CITA-2 · cómo estaban estas reservas ANTES de la pasada (fecha y estado), para
 * saber cuáles se han reprogramado o cancelado desde la anterior. Las que no están, son nuevas.
 */
export async function dbSioBookingsPrevios(accountId: string, ids: number[]): Promise<Map<number, { booked_at: number | null; status: string; contact_key: string }>> {
  const out = new Map<number, { booked_at: number | null; status: string; contact_key: string }>();
  if (!ids.length) return out;
  const tenantId = currentWorkspaceId();
  if (!pool) {
    for (const id of ids) {
      const r = mem.sioBookings.get(`${accountId}:${id}`);
      if (r && (r.tenant_id || "default") === tenantId) out.set(id, { booked_at: r.booked_at ?? null, status: r.status, contact_key: r.contact_key || "" });
    }
    return out;
  }
  const r = await pool.query(
    `SELECT booking_id::bigint booking_id, extract(epoch from booked_at)*1000 booked_at, status, contact_key
     FROM app_sio_bookings WHERE account_id=$1 AND tenant_id=$2 AND booking_id = ANY($3::bigint[])`,
    [accountId, tenantId, ids],
  );
  for (const x of r.rows) out.set(Number(x.booking_id), { booked_at: x.booked_at == null ? null : Number(x.booked_at), status: String(x.status || ""), contact_key: String(x.contact_key || "") });
  return out;
}

/** RESERVA-WA-3 · une la reserva a la ficha de quien la hizo (vacío: la desune). */
export async function dbSioBookingSetContacto(accountId: string, bookingId: number, clave: string): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const r = mem.sioBookings.get(`${accountId}:${bookingId}`);
    if (r && (r.tenant_id || "default") === tenantId) r.contact_key = clave;
    return;
  }
  await pool.query(`UPDATE app_sio_bookings SET contact_key=$4 WHERE account_id=$1 AND booking_id=$2 AND tenant_id=$3`, [accountId, bookingId, tenantId, clave.slice(0, 200)]);
}

/** Reservas del workspace en un rango de fechas (para la vista Reuniones). */
export async function dbSioBookingsRange(fromMs: number, toMs: number): Promise<SioBooking[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return [...mem.sioBookings.values()]
      .filter((r) => (r.tenant_id || "default") === tenantId && r.booked_at != null && r.booked_at >= fromMs && r.booked_at <= toMs)
      .sort((a, b) => (a.booked_at || 0) - (b.booked_at || 0));
  }
  const r = await pool.query(
    `SELECT account_id, booking_id::bigint booking_id, tenant_id,
        extract(epoch from booked_at)*1000 booked_at, extract(epoch from created_at)*1000 created_at,
        event_name, duration_min, status, payment_status, event_type, contact_name, email, contact_key
     FROM app_sio_bookings
     WHERE tenant_id=$1 AND booked_at IS NOT NULL AND booked_at >= to_timestamp($2/1000.0) AND booked_at <= to_timestamp($3/1000.0)
     ORDER BY booked_at ASC`,
    [tenantId, fromMs, toMs],
  );
  return r.rows.map((x) => ({
    ...x,
    booking_id: Number(x.booking_id),
    booked_at: x.booked_at != null ? Number(x.booked_at) : null,
    created_at: x.created_at != null ? Number(x.created_at) : null,
    duration_min: x.duration_min != null ? Number(x.duration_min) : null,
    tenant_id: x.tenant_id || "default",
  })) as SioBooking[];
}

/** Cursor incremental del sync: el id de contacto MÁS ALTO ya copiado de esa cuenta.
 *  SIO-LEADS-TENANT-1 · acotado al workspace activo: con el filtro solo por cuenta, dos
 *  workspaces que compartieran account_id se robaban el cursor entre ellos y el sync de
 *  uno se saltaba los leads del otro. */
export async function dbSioLeadsMaxId(accountId: string): Promise<number> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    let max = 0;
    for (const r of mem.sioLeads.values()) if (r.account_id === accountId && (r.tenant_id || "default") === tenantId && r.sio_contact_id > max) max = r.sio_contact_id;
    return max;
  }
  const r = await pool.query("SELECT COALESCE(MAX(sio_contact_id),0)::bigint m FROM app_sio_leads WHERE account_id=$1 AND tenant_id=$2", [accountId, tenantId]);
  return Number(r.rows[0]?.m || 0);
}

/** SIO-LEADS-TENANT-1 · acotado al workspace activo (antes solo por account_id). */
export async function dbSioLeadsStats(accountId: string): Promise<{ total: number; withUrl: number; withUtm: number }> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const rows = [...mem.sioLeads.values()].filter((r) => r.account_id === accountId && (r.tenant_id || "default") === tenantId);
    return {
      total: rows.length,
      withUrl: rows.filter((r) => r.source_url).length,
      withUtm: rows.filter((r) => r.utm_source || r.utm_medium || r.utm_content || r.utm_campaign).length,
    };
  }
  const r = await pool.query(
    `SELECT COUNT(*)::int total,
            COUNT(*) FILTER (WHERE source_url<>'')::int with_url,
            COUNT(*) FILTER (WHERE utm_source<>'' OR utm_medium<>'' OR utm_campaign<>'' OR utm_content<>'')::int with_utm
     FROM app_sio_leads WHERE account_id=$1 AND tenant_id=$2`,
    [accountId, tenantId],
  );
  return { total: Number(r.rows[0]?.total || 0), withUrl: Number(r.rows[0]?.with_url || 0), withUtm: Number(r.rows[0]?.with_utm || 0) };
}

/** Filas del rango para agregar atribución (el endpoint clasifica con attribution.ts).
 *  SIO-LEADS-TENANT-1 · acotado al workspace activo (antes solo por account_id). */
export async function dbSioLeadsRows(
  accountId: string,
  sinceMs: number,
  untilMs: number,
  limit = 5000,
): Promise<SioLead[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return [...mem.sioLeads.values()]
      .filter((r) => r.account_id === accountId && (r.tenant_id || "default") === tenantId && (r.registered_at || 0) >= sinceMs && (r.registered_at || 0) <= untilMs)
      .slice(0, limit);
  }
  const r = await pool.query(
    `SELECT account_id, sio_contact_id::bigint sio_contact_id, email,
            extract(epoch from registered_at)*1000 registered_at,
            source_url, utm_source, utm_medium, utm_campaign, utm_content
     FROM app_sio_leads
     WHERE account_id=$1 AND tenant_id=$2 AND registered_at >= to_timestamp($3/1000.0) AND registered_at <= to_timestamp($4/1000.0)
     ORDER BY registered_at DESC LIMIT $5`,
    [accountId, tenantId, sinceMs, untilMs, limit],
  );
  return r.rows.map((x: any) => ({
    account_id: x.account_id, sio_contact_id: Number(x.sio_contact_id), email: x.email,
    registered_at: x.registered_at ? Number(x.registered_at) : null,
    source_url: x.source_url, utm_source: x.utm_source, utm_medium: x.utm_medium,
    utm_campaign: x.utm_campaign, utm_content: x.utm_content,
  }));
}

/** ORIGEN-VISITA-1 · altas de la cuenta sin utm cuyo origen por la visita aún no se ha mirado, de
 *  más de `minEdadMs` (para que sus visitas y su duración ya hayan llegado). Acotado al workspace. */
export async function dbSioLeadsSinOrigen(accountId: string, minEdadMs: number, limit = 500): Promise<SioLead[]> {
  const tenantId = currentWorkspaceId();
  const tope = Date.now() - minEdadMs;
  if (!pool) {
    return [...mem.sioLeads.values()]
      .filter((r) => r.account_id === accountId && (r.tenant_id || "default") === tenantId && !r.utm_source && !r.origen_visita
        && r.source_url && r.registered_at && r.registered_at <= tope)
      .slice(0, limit);
  }
  const r = await pool.query(
    `SELECT account_id, sio_contact_id::bigint sio_contact_id, email, extract(epoch from registered_at)*1000 registered_at, source_url
       FROM app_sio_leads
      WHERE account_id=$1 AND tenant_id=$2 AND utm_source='' AND origen_visita='' AND source_url<>''
        AND registered_at IS NOT NULL AND registered_at <= to_timestamp($3/1000.0)
      ORDER BY registered_at DESC LIMIT $4`,
    [accountId, tenantId, tope, limit],
  );
  return r.rows.map((x: any) => ({
    account_id: x.account_id, sio_contact_id: Number(x.sio_contact_id), email: x.email,
    registered_at: Number(x.registered_at), source_url: x.source_url,
    utm_source: "", utm_medium: "", utm_campaign: "", utm_content: "",
  }));
}
/** ORIGEN-VISITA-1 · apunta el origen deducido (o 'ninguno') de un alta. Nunca pisa un utm ni un
 *  origen ya apuntado. Acotado al workspace. */
export async function dbSioLeadSetOrigenVisita(accountId: string, sioContactId: number, origen: string): Promise<void> {
  const tenantId = currentWorkspaceId();
  const v = origen || "ninguno";
  if (!pool) {
    const l = mem.sioLeads.get(`${tenantId}:${accountId}:${sioContactId}`);
    if (l && !l.utm_source && !l.origen_visita) l.origen_visita = v;
    return;
  }
  await pool.query(
    `UPDATE app_sio_leads SET origen_visita=$4
      WHERE tenant_id=$1 AND account_id=$2 AND sio_contact_id=$3 AND utm_source='' AND origen_visita=''`,
    [tenantId, accountId, sioContactId, v],
  );
}

/* ============================================================
 * VENTAS-SIO-1 · ventas de los checkouts de systeme.io (app_sio_sales).
 * Sin Postgres no hay ventas: en modo memoria todo devuelve vacío.
 * ============================================================ */
export interface SioVenta {
  account_id: string;
  tx_id: string;
  kind: "sale" | "refund";
  email: string;
  amount: number; // en unidades de la divisa (97.5), no en céntimos
  currency: string; // minúsculas: eur, usd…
  product: string;
  paid_at: number | null; // epoch ms
  /** FUNNELS-1 · funnel y paso en los que se hizo la venta, y la oferta cobrada. '' = la
   *  transacción no lo trae. */
  funnel_id?: string;
  step_id?: string;
  offer_id?: string;
}
/** Guarda ventas sin duplicar. Devuelve cuántas son NUEVAS.
 *  FUNNELS-1 · una venta ya copiada recibe su funnel, su paso y su oferta si la transacción los
 *  trae ahora; un valor vacío nunca pisa uno ya guardado (y el NULL de «aún sin mirar» se queda
 *  hasta que la pasada entera acaba: dbSioSalesCerrarSinFunnel). */
export async function dbSioSalesUpsert(rows: SioVenta[]): Promise<number> {
  if (!pool || !rows.length) return 0;
  const tenantId = currentWorkspaceId();
  // La misma transacción dos veces en una tanda rompería el ON CONFLICT … DO UPDATE.
  const unicas = [...new Map(rows.map((r) => [r.account_id + "\u0000" + r.tx_id, r] as const)).values()];
  const vals: string[] = [];
  const args: unknown[] = [];
  let i = 0;
  for (const r of unicas) {
    vals.push(`($${++i},$${++i},$${++i},$${++i},$${++i},$${++i},$${++i},$${++i},to_timestamp($${++i}/1000.0),$${++i},$${++i},$${++i})`);
    args.push(tenantId, r.account_id, r.tx_id, r.kind, r.email, r.amount, r.currency, r.product.slice(0, 200), r.paid_at ?? null,
      String(r.funnel_id || ""), String(r.step_id || ""), String(r.offer_id || ""));
  }
  const q = await pool.query(
    `INSERT INTO app_sio_sales (tenant_id,account_id,tx_id,kind,email,amount,currency,product,paid_at,funnel_id,step_id,offer_id)
     VALUES ${vals.join(",")}
     ON CONFLICT (tenant_id,account_id,tx_id) DO UPDATE SET
       funnel_id = CASE WHEN EXCLUDED.funnel_id <> '' THEN EXCLUDED.funnel_id ELSE app_sio_sales.funnel_id END,
       step_id = CASE WHEN EXCLUDED.step_id <> '' THEN EXCLUDED.step_id ELSE app_sio_sales.step_id END,
       offer_id = CASE WHEN EXCLUDED.offer_id <> '' THEN EXCLUDED.offer_id ELSE app_sio_sales.offer_id END
     WHERE (EXCLUDED.funnel_id <> '' AND app_sio_sales.funnel_id IS DISTINCT FROM EXCLUDED.funnel_id)
        OR (EXCLUDED.step_id <> '' AND app_sio_sales.step_id IS DISTINCT FROM EXCLUDED.step_id)
        OR (EXCLUDED.offer_id <> '' AND app_sio_sales.offer_id IS DISTINCT FROM EXCLUDED.offer_id)
     RETURNING (xmax = 0) AS nueva`,
    args,
  );
  return q.rows.filter((x: { nueva: boolean }) => x.nueva).length;
}
/** FUNNELS-1 · ventas de la cuenta copiadas antes de guardar el funnel (funnel_id NULL) y que
 *  todavía se pueden releer: pagadas desde `desdeMs` o sin fecha. */
export async function dbSioSalesSinMirarFunnel(accountId: string, desdeMs: number): Promise<number> {
  if (!pool) return 0;
  const r = await pool.query(
    `SELECT COUNT(*)::int n FROM app_sio_sales
      WHERE tenant_id=$1 AND account_id=$2 AND funnel_id IS NULL AND (paid_at IS NULL OR paid_at >= to_timestamp($3/1000.0))`,
    [currentWorkspaceId(), accountId, desdeMs],
  );
  return Number(r.rows[0]?.n) || 0;
}
/** FUNNELS-1 · tras una pasada COMPLETA desde `desdeMs`: lo que siga sin funnel en esa ventana ya
 *  se ha mirado y no lo trae. Pasa a '' para no volver a recorrer el año entero. */
export async function dbSioSalesCerrarSinFunnel(accountId: string, desdeMs: number): Promise<number> {
  if (!pool) return 0;
  const r = await pool.query(
    `UPDATE app_sio_sales SET funnel_id='', step_id=COALESCE(step_id,''), offer_id=COALESCE(offer_id,'')
      WHERE tenant_id=$1 AND account_id=$2 AND funnel_id IS NULL AND (paid_at IS NULL OR paid_at >= to_timestamp($3/1000.0))`,
    [currentWorkspaceId(), accountId, desdeMs],
  );
  return r.rowCount || 0;
}
/** ATRIBUCION-CORREO-1 (MET-CORREO-04) · ventas de systeme.io pagadas en la ventana, con su email
 *  y kind — para cruzar en memoria contra los destinatarios que pulsaron un correo concreto. Sin
 *  modo memoria: app_sio_sales no lo tiene (igual que el resto de funciones de esta tabla). */
export async function dbSioSalesRange(fromMs: number, toMs: number): Promise<Array<{ email: string; paid_at: number; kind: string; amount: number }>> {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT email, extract(epoch from paid_at)*1000 paid_at, kind, amount
       FROM app_sio_sales
      WHERE tenant_id=$1 AND email<>'' AND paid_at IS NOT NULL AND paid_at >= to_timestamp($2/1000.0) AND paid_at <= to_timestamp($3/1000.0)
      ORDER BY paid_at ASC`,
    [currentWorkspaceId(), fromMs, toMs],
  );
  return r.rows.map((x) => ({ email: String(x.email || ""), paid_at: Number(x.paid_at) || 0, kind: String(x.kind || "sale"), amount: Number(x.amount) || 0 }));
}
/** VENTAS-WEBHOOK-1 · guarda un aviso de venta o de cancelación de systeme.io. El mismo aviso
 *  repetido (systeme.io reintenta) no duplica. Devuelve true si es nuevo. */
export async function dbSioWebhookSaleInsert(r: {
  account_id: string; sale_id: string; kind: "sale" | "canceled"; email: string;
  amount: number | null; currency: string; product: string; at: number | null; payload: unknown;
}): Promise<boolean> {
  if (!pool) return false;
  const q = await pool.query(
    `INSERT INTO app_sio_webhook_sales (tenant_id,account_id,sale_id,kind,email,amount,currency,product,at,payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0),$10::jsonb)
     ON CONFLICT (tenant_id,account_id,sale_id,kind) DO NOTHING`,
    [currentWorkspaceId(), r.account_id, r.sale_id, r.kind, r.email, r.amount, r.currency, r.product.slice(0, 200), r.at ?? null,
      JSON.stringify(r.payload ?? null).slice(0, 60000)],
  );
  return (q.rowCount || 0) > 0;
}
/** VENTAS-CORTE-1 (SIO-API-F8) · copia los avisos de `app_sio_webhook_sales` que cumplan `filtro`
 *  (sobre el alias w) a app_sio_sales con origen='webhook': la venta con su id (`oi:…`), la
 *  cancelación como devolución (`oi:…:c`, resta; sin importe en el aviso, el de su venta). Se salta
 *  lo que la copia por sesión ya tiene (mismo email, día UTC y tipo): así ni el relleno del arranque
 *  ni un aviso de una venta anterior al corte cuentan dos veces. Idempotente. */
function sqlVentasDesdeAvisos(filtro: string): string {
  return `INSERT INTO app_sio_sales (tenant_id,account_id,tx_id,kind,email,amount,currency,product,paid_at,origen)
    SELECT w.tenant_id, w.account_id,
           CASE WHEN w.kind='sale' THEN w.sale_id ELSE w.sale_id || ':c' END,
           CASE WHEN w.kind='sale' THEN 'sale' ELSE 'refund' END,
           w.email,
           COALESCE(w.amount, (SELECT v.amount FROM app_sio_webhook_sales v WHERE v.tenant_id=w.tenant_id AND v.account_id=w.account_id
                                 AND v.sale_id=w.sale_id AND v.kind='sale'), 0),
           w.currency, w.product, COALESCE(w.at, w.received_at), 'webhook'
      FROM app_sio_webhook_sales w
     WHERE (${filtro})
       AND NOT EXISTS (SELECT 1 FROM app_sio_sales s
                        WHERE s.tenant_id=w.tenant_id AND s.account_id=w.account_id AND s.origen='cookie'
                          AND s.kind = CASE WHEN w.kind='sale' THEN 'sale' ELSE 'refund' END
                          AND w.email<>'' AND lower(s.email)=w.email
                          AND (s.paid_at AT TIME ZONE 'UTC')::date = (COALESCE(w.at, w.received_at) AT TIME ZONE 'UTC')::date)
    ON CONFLICT (tenant_id,account_id,tx_id) DO NOTHING`;
}
/** VENTAS-CORTE-1 · pasa un aviso ya guardado a las ventas que suman. true si entró. */
export async function dbSioSalesDesdeAviso(accountId: string, saleId: string, kind: "sale" | "canceled"): Promise<boolean> {
  if (!pool) return false;
  const q = await pool.query(sqlVentasDesdeAvisos("w.tenant_id=$1 AND w.account_id=$2 AND w.sale_id=$3 AND w.kind=$4"),
    [currentWorkspaceId(), accountId, saleId, kind]);
  return (q.rowCount || 0) > 0;
}
/** VENTAS-WEBHOOK-1 · paridad desde `desdeMs`: cada venta por webhook se casa con la copia por
 *  sesión por email y día (el id de systeme.io puede no ser el mismo en los dos sitios). */
export async function dbSioVentasParidad(accountId: string, desdeMs: number): Promise<{
  webhook: number; sesion: number; casadas: number; soloWebhook: string[]; soloSesion: string[]; ultimoAviso: number;
}> {
  const vacio = { webhook: 0, sesion: 0, casadas: 0, soloWebhook: [] as string[], soloSesion: [] as string[], ultimoAviso: 0 };
  if (!pool) return vacio;
  const ws = currentWorkspaceId();
  const w = await pool.query(
    `SELECT sale_id, lower(email) email, to_char(COALESCE(at, received_at) AT TIME ZONE 'UTC','YYYY-MM-DD') dia,
            extract(epoch from received_at)*1000 rec
       FROM app_sio_webhook_sales WHERE tenant_id=$1 AND account_id=$2 AND kind='sale'
        AND COALESCE(at, received_at) >= to_timestamp($3/1000.0)`,
    [ws, accountId, desdeMs],
  );
  const c = await pool.query(
    `SELECT tx_id, lower(email) email, to_char(paid_at AT TIME ZONE 'UTC','YYYY-MM-DD') dia
       FROM app_sio_sales WHERE tenant_id=$1 AND account_id=$2 AND kind='sale' AND origen='cookie' AND paid_at >= to_timestamp($3/1000.0)`,
    [ws, accountId, desdeMs],
  );
  const pend = new Map<string, string[]>();
  for (const x of c.rows) {
    const k = x.email + "|" + x.dia;
    pend.set(k, [...(pend.get(k) || []), String(x.tx_id)]);
  }
  const soloWebhook: string[] = [];
  let casadas = 0, ultimoAviso = 0;
  for (const x of w.rows) {
    ultimoAviso = Math.max(ultimoAviso, Number(x.rec) || 0);
    const l = pend.get(x.email + "|" + x.dia);
    if (l && l.length) { l.pop(); casadas++; } else soloWebhook.push(String(x.sale_id));
  }
  const soloSesion = [...pend.values()].flat();
  return { webhook: w.rows.length, sesion: c.rows.length, casadas, soloWebhook: soloWebhook.slice(0, 50), soloSesion: soloSesion.slice(0, 50), ultimoAviso };
}
/** Fecha de la venta más reciente copiada de esa cuenta (epoch ms), o 0 si ninguna. */
export async function dbSioSalesUltima(accountId: string): Promise<number> {
  if (!pool) return 0;
  const r = await pool.query(
    `SELECT COALESCE(extract(epoch from MAX(paid_at))*1000,0) t FROM app_sio_sales WHERE tenant_id=$1 AND account_id=$2`,
    [currentWorkspaceId(), accountId],
  );
  return Number(r.rows[0]?.t) || 0;
}

/* ============================================================
 * FUNNELS-1 · estructura de los funnels de las webs de systeme.io (app_sio_funnels y
 * app_sio_funnel_steps) y lo que se cruza con ella: ventas (app_sio_sales) y altas
 * (app_sio_leads). Todo acotado al workspace activo. Sólo Postgres: en modo memoria no se
 * guardan funnels y todo devuelve vacío.
 * ============================================================ */
export interface SioFunnelFila {
  account_id: string; funnel_id: string; name: string;
  /** null = la fuente no dice si está activo. */
  active: boolean | null;
  synced_at: number; pasos: number;
}
export interface SioFunnelPaso {
  account_id: string; funnel_id: string; step_id: string; name: string; type: string; page_id: string;
  url: string; web: string; path: string; position: number; offer_id: string; synced_at: number;
}
/** Guarda los funnels leídos de una cuenta. `retirarAusentes` sólo tras una lectura COMPLETA y
 *  correcta del listado: borra los funnels de esa cuenta que ya no están, con sus pasos. */
export async function dbSioFunnelsGuardar(
  accountId: string,
  funnels: Array<{ funnel_id: string; name: string; active: boolean | null }>,
  retirarAusentes: boolean,
): Promise<void> {
  if (!pool) return;
  const tenantId = currentWorkspaceId();
  const unicos = [...new Map(funnels.filter((f) => f.funnel_id).map((f) => [f.funnel_id, f] as const)).values()];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let k = 0; k < unicos.length; k += 200) {
      const tanda = unicos.slice(k, k + 200);
      const vals: string[] = [];
      const args: unknown[] = [];
      let i = 0;
      for (const f of tanda) {
        vals.push(`($${++i},$${++i},$${++i},$${++i},$${++i},now())`);
        args.push(tenantId, accountId, f.funnel_id, String(f.name || "").slice(0, 200), f.active);
      }
      await client.query(
        `INSERT INTO app_sio_funnels (tenant_id,account_id,funnel_id,name,active,synced_at) VALUES ${vals.join(",")}
         ON CONFLICT (tenant_id,account_id,funnel_id) DO UPDATE SET name=EXCLUDED.name, active=EXCLUDED.active, synced_at=now()`,
        args,
      );
    }
    if (retirarAusentes) {
      const ids = unicos.map((f) => f.funnel_id);
      await client.query(`DELETE FROM app_sio_funnel_steps WHERE tenant_id=$1 AND account_id=$2 AND NOT (funnel_id = ANY($3::text[]))`, [tenantId, accountId, ids]);
      await client.query(`DELETE FROM app_sio_funnels WHERE tenant_id=$1 AND account_id=$2 AND NOT (funnel_id = ANY($3::text[]))`, [tenantId, accountId, ids]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
/** Guarda los pasos leídos de UN funnel. `retirarAusentes` sólo tras una lectura completa y
 *  correcta de ese funnel. `oficial` = la fuente trae la oferta de cada paso: si no la trae (el
 *  puente), una oferta ya guardada no se pisa con vacío. */
export async function dbSioFunnelPasosGuardar(
  accountId: string,
  funnelId: string,
  pasos: Array<Omit<SioFunnelPaso, "account_id" | "funnel_id" | "synced_at">>,
  opts: { retirarAusentes: boolean; oficial: boolean },
): Promise<void> {
  if (!pool) return;
  const tenantId = currentWorkspaceId();
  const unicos = [...new Map(pasos.filter((p) => p.step_id).map((p) => [p.step_id, p] as const)).values()];
  const oferta = opts.oficial
    ? "EXCLUDED.offer_id"
    : "CASE WHEN EXCLUDED.offer_id <> '' THEN EXCLUDED.offer_id ELSE app_sio_funnel_steps.offer_id END";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let k = 0; k < unicos.length; k += 200) {
      const tanda = unicos.slice(k, k + 200);
      const vals: string[] = [];
      const args: unknown[] = [];
      let i = 0;
      for (const p of tanda) {
        vals.push(`($${++i},$${++i},$${++i},$${++i},$${++i},$${++i},$${++i},$${++i},$${++i},$${++i},$${++i},$${++i},now())`);
        args.push(tenantId, accountId, funnelId, p.step_id, String(p.name || "").slice(0, 200), String(p.type || "").slice(0, 80),
          String(p.page_id || ""), String(p.url || "").slice(0, 1000), String(p.web || "").slice(0, 255), String(p.path || "").slice(0, 300),
          Math.trunc(Number(p.position)) || 0, String(p.offer_id || ""));
      }
      await client.query(
        `INSERT INTO app_sio_funnel_steps (tenant_id,account_id,funnel_id,step_id,name,type,page_id,url,web,path,position,offer_id,synced_at)
         VALUES ${vals.join(",")}
         ON CONFLICT (tenant_id,account_id,step_id) DO UPDATE SET funnel_id=EXCLUDED.funnel_id, name=EXCLUDED.name, type=EXCLUDED.type,
           page_id=EXCLUDED.page_id, url=EXCLUDED.url, web=EXCLUDED.web, path=EXCLUDED.path, position=EXCLUDED.position,
           offer_id=${oferta}, synced_at=now()`,
        args,
      );
    }
    if (opts.retirarAusentes) {
      await client.query(
        `DELETE FROM app_sio_funnel_steps WHERE tenant_id=$1 AND account_id=$2 AND funnel_id=$3 AND NOT (step_id = ANY($4::text[]))`,
        [tenantId, accountId, funnelId, unicos.map((p) => p.step_id)],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
/** Funnels guardados del workspace (de una cuenta, o de todas con accountId vacío), con cuántos pasos tienen. */
export async function dbSioFunnels(accountId = ""): Promise<SioFunnelFila[]> {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT f.account_id, f.funnel_id, f.name, f.active, extract(epoch from f.synced_at)*1000 AS synced_at,
            (SELECT COUNT(*) FROM app_sio_funnel_steps p
              WHERE p.tenant_id=f.tenant_id AND p.account_id=f.account_id AND p.funnel_id=f.funnel_id)::int AS pasos
       FROM app_sio_funnels f
      WHERE f.tenant_id=$1 AND ($2 = '' OR f.account_id=$2)
      ORDER BY lower(f.name), f.funnel_id`,
    [currentWorkspaceId(), accountId],
  );
  return r.rows.map((x: any): SioFunnelFila => ({
    account_id: String(x.account_id), funnel_id: String(x.funnel_id), name: String(x.name || ""),
    active: x.active === null || x.active === undefined ? null : !!x.active,
    synced_at: Number(x.synced_at) || 0, pasos: Number(x.pasos) || 0,
  }));
}
/** Pasos guardados (de una cuenta o de todas; de un funnel o de todos), en el orden del funnel. */
export async function dbSioFunnelPasos(accountId = "", funnelId = ""): Promise<SioFunnelPaso[]> {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT account_id, funnel_id, step_id, name, type, page_id, url, web, path, position, offer_id,
            extract(epoch from synced_at)*1000 AS synced_at
       FROM app_sio_funnel_steps
      WHERE tenant_id=$1 AND ($2 = '' OR account_id=$2) AND ($3 = '' OR funnel_id=$3)
      ORDER BY account_id, funnel_id, position, step_id`,
    [currentWorkspaceId(), accountId, funnelId],
  );
  return r.rows.map((x: any): SioFunnelPaso => ({
    account_id: String(x.account_id), funnel_id: String(x.funnel_id), step_id: String(x.step_id), name: String(x.name || ""),
    type: String(x.type || ""), page_id: String(x.page_id || ""), url: String(x.url || ""), web: String(x.web || ""),
    path: String(x.path || ""), position: Number(x.position) || 0, offer_id: String(x.offer_id || ""), synced_at: Number(x.synced_at) || 0,
  }));
}
/** Por cuenta: cuántos funnels hay guardados y cuándo se guardó el último. */
export async function dbSioFunnelsPorCuenta(): Promise<Array<{ account_id: string; funnels: number; synced_at: number }>> {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT account_id, COUNT(*)::int AS funnels, extract(epoch from MAX(synced_at))*1000 AS synced_at
       FROM app_sio_funnels WHERE tenant_id=$1 GROUP BY account_id`,
    [currentWorkspaceId()],
  );
  return r.rows.map((x: any) => ({ account_id: String(x.account_id), funnels: Number(x.funnels) || 0, synced_at: Number(x.synced_at) || 0 }));
}
/**
 * Cada venta del workspace con su funnel y su paso ya resueltos (columnas `funnel` y `paso`, ''
 * si no tiene). Por orden: 1) el paso que trae la propia transacción (y, si sólo trae el paso,
 * el funnel al que ese paso pertenece); 2) si la transacción no trae ni paso ni funnel, el paso
 * de esa cuenta que cobra la misma oferta — sólo si es UNO: con dos pasos cobrando la misma
 * oferta no se adivina y la venta se queda sin funnel. Al resolverse en la consulta, una venta
 * copiada antes de leer la estructura queda atribuida en cuanto la estructura existe.
 * $1 = workspace. Devuelve el cuerpo de un CTE; `filtro` acota las ventas (alias `s`).
 */
const sqlVentasConFunnel = (filtro: string): string => `
  SELECT s.account_id, s.tx_id, s.kind, s.email, s.amount, s.currency, s.product, s.paid_at,
         COALESCE(NULLIF(s.step_id,''), u.step_id, '') AS paso,
         COALESCE(NULLIF(s.funnel_id,''), p.funnel_id, u.funnel_id, '') AS funnel
    FROM app_sio_sales s
    LEFT JOIN app_sio_funnel_steps p
           ON p.tenant_id=s.tenant_id AND p.account_id=s.account_id AND p.step_id=s.step_id AND COALESCE(s.step_id,'') <> ''
    LEFT JOIN (SELECT account_id, offer_id, MIN(step_id) AS step_id, MIN(funnel_id) AS funnel_id
                 FROM app_sio_funnel_steps
                WHERE tenant_id=$1 AND offer_id <> ''
                GROUP BY account_id, offer_id HAVING COUNT(*) = 1) u
           ON u.account_id=s.account_id AND u.offer_id=s.offer_id
          AND COALESCE(s.step_id,'') = '' AND COALESCE(s.funnel_id,'') = ''
   WHERE s.tenant_id=$1 AND ${filtro}`;
/** La ficha (teléfono y nombre) de quien tiene ese email en este workspace; sin ficha, vacío. `de` = alias con `.email`. */
const sqlFichaDeEmail = (de: string): string => `LEFT JOIN LATERAL (
    SELECT x.phone, x.name FROM app_contacts x
     WHERE x.tenant_id=$1 AND x.email <> '' AND ${de}.email <> '' AND lower(x.email)=lower(${de}.email)
     ORDER BY x.created_at ASC LIMIT 1) c ON true`;
/** ¿Hay alguna venta copiada de esa cuenta? (para distinguir «no se pueden medir» de «cero»). */
export async function dbSioSalesHay(accountId: string): Promise<boolean> {
  if (!pool) return false;
  const r = await pool.query(`SELECT 1 FROM app_sio_sales WHERE tenant_id=$1 AND account_id=$2 LIMIT 1`, [currentWorkspaceId(), accountId]);
  return r.rows.length > 0;
}
/** Ventas y devoluciones de la cuenta en el rango, agrupadas por funnel, paso, tipo y divisa. */
export async function dbFunnelVentasAgregadas(accountId: string, sinceMs: number, untilMs: number): Promise<Array<{
  funnel: string; paso: string; kind: "sale" | "refund"; currency: string; n: number; amount: number; ultima: number;
}>> {
  if (!pool) return [];
  const r = await pool.query(
    `WITH v AS (${sqlVentasConFunnel("s.account_id=$2 AND s.paid_at IS NOT NULL AND s.paid_at >= to_timestamp($3/1000.0) AND s.paid_at <= to_timestamp($4/1000.0)")})
     SELECT funnel, paso, kind, lower(currency) AS currency, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float8 AS amount,
            extract(epoch from MAX(paid_at))*1000 AS ultima
       FROM v WHERE funnel <> '' GROUP BY 1, 2, 3, 4`,
    [currentWorkspaceId(), accountId, sinceMs, untilMs],
  );
  return r.rows.map((x: any) => ({
    funnel: String(x.funnel), paso: String(x.paso || ""), kind: x.kind === "refund" ? "refund" : "sale",
    currency: String(x.currency || ""), n: Number(x.n) || 0, amount: Number(x.amount) || 0, ultima: Number(x.ultima) || 0,
  }));
}
export interface FunnelVentaFila {
  account_id: string; funnel: string; paso: string; email: string; phone: string; name: string; at: number;
  product: string; amount: number; currency: string; kind: "sale" | "refund";
}
const filaDeVentaDeFunnel = (x: any): FunnelVentaFila => ({
  account_id: String(x.account_id || ""), funnel: String(x.funnel || ""), paso: String(x.paso || ""),
  email: String(x.email || ""), phone: String(x.phone || ""), name: String(x.name || ""), at: Number(x.at) || 0,
  product: String(x.product || ""), amount: Number(x.amount) || 0, currency: String(x.currency || ""),
  kind: x.kind === "refund" ? "refund" : "sale",
});
/** Las ventas y devoluciones de UN funnel en el rango, una a una y lo último primero, con la ficha del comprador si la tiene. */
export async function dbFunnelVentasFilas(accountId: string, funnelId: string, sinceMs: number, untilMs: number, limit = 500): Promise<FunnelVentaFila[]> {
  if (!pool) return [];
  const r = await pool.query(
    `WITH v AS (${sqlVentasConFunnel("s.account_id=$2 AND s.paid_at IS NOT NULL AND s.paid_at >= to_timestamp($3/1000.0) AND s.paid_at <= to_timestamp($4/1000.0)")})
     SELECT v.account_id, v.funnel, v.paso, v.email, COALESCE(c.phone,'') AS phone, COALESCE(c.name,'') AS name,
            extract(epoch from v.paid_at)*1000 AS at, COALESCE(v.product,'') AS product, COALESCE(v.amount,0)::float8 AS amount,
            lower(v.currency) AS currency, v.kind
       FROM v ${sqlFichaDeEmail("v")}
      WHERE v.funnel=$5 ORDER BY v.paid_at DESC, v.tx_id DESC LIMIT $6`,
    [currentWorkspaceId(), accountId, sinceMs, untilMs, funnelId, limit],
  );
  return r.rows.map(filaDeVentaDeFunnel);
}
/** Ventas y devoluciones de la cuenta por día (hora de Madrid), funnel, tipo y divisa: lo que
 *  dibujan los gráficos de Funnels, con el dinero de cada día en su moneda (DIVISA-1). */
export async function dbFunnelVentasDiaDivisa(accountId: string, sinceMs: number, untilMs: number): Promise<Array<{
  dia: string; funnel: string; kind: "sale" | "refund"; currency: string; n: number; amount: number;
}>> {
  if (!pool) return [];
  const r = await pool.query(
    `WITH v AS (${sqlVentasConFunnel("s.account_id=$2 AND s.paid_at IS NOT NULL AND s.paid_at >= to_timestamp($3/1000.0) AND s.paid_at <= to_timestamp($4/1000.0)")})
     SELECT to_char(paid_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD') AS dia, funnel, kind, lower(currency) AS currency,
            COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float8 AS amount
       FROM v WHERE funnel <> '' GROUP BY 1, 2, 3, 4`,
    [currentWorkspaceId(), accountId, sinceMs, untilMs],
  );
  return r.rows.map((x: any) => ({
    dia: String(x.dia), funnel: String(x.funnel), kind: x.kind === "refund" ? "refund" : "sale",
    currency: String(x.currency || ""), n: Number(x.n) || 0, amount: Number(x.amount) || 0,
  }));
}
/** Todo lo que ha comprado (y devuelto) en algún funnel quien tiene ese email, en cualquier web del workspace. */
export async function dbFunnelVentasDeEmail(email: string, limit = 500): Promise<FunnelVentaFila[]> {
  const e = String(email || "").trim();
  if (!pool || !e) return [];
  const r = await pool.query(
    `WITH v AS (${sqlVentasConFunnel("s.email <> '' AND lower(s.email)=lower($2) AND s.paid_at IS NOT NULL")})
     SELECT v.account_id, v.funnel, v.paso, v.email, '' AS phone, '' AS name, extract(epoch from v.paid_at)*1000 AS at,
            COALESCE(v.product,'') AS product, COALESCE(v.amount,0)::float8 AS amount, lower(v.currency) AS currency, v.kind
       FROM v WHERE v.funnel <> '' ORDER BY v.paid_at DESC, v.tx_id DESC LIMIT $3`,
    [currentWorkspaceId(), e, limit],
  );
  return r.rows.map(filaDeVentaDeFunnel);
}
/** Altas de la cuenta en el rango, agrupadas por la dirección donde se registraron (tal cual se guardó). */
export async function dbSioLeadsPorUrl(accountId: string, sinceMs: number, untilMs: number): Promise<Array<{ source_url: string; n: number; ultima: number }>> {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT source_url, COUNT(*)::int AS n, extract(epoch from MAX(registered_at))*1000 AS ultima
       FROM app_sio_leads
      WHERE tenant_id=$1 AND account_id=$2 AND source_url <> ''
        AND registered_at >= to_timestamp($3/1000.0) AND registered_at <= to_timestamp($4/1000.0)
      GROUP BY source_url`,
    [currentWorkspaceId(), accountId, sinceMs, untilMs],
  );
  return r.rows.map((x: any) => ({ source_url: String(x.source_url), n: Number(x.n) || 0, ultima: Number(x.ultima) || 0 }));
}
/** Altas por día (hora de Madrid) de las que se registraron en esas direcciones. */
export async function dbSioLeadsPorDia(accountId: string, sinceMs: number, untilMs: number, urls: string[]): Promise<Array<{ dia: string; n: number }>> {
  if (!pool || !urls.length) return [];
  const r = await pool.query(
    `SELECT to_char(registered_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD') AS dia, COUNT(*)::int AS n
       FROM app_sio_leads
      WHERE tenant_id=$1 AND account_id=$2 AND source_url = ANY($5::text[])
        AND registered_at >= to_timestamp($3/1000.0) AND registered_at <= to_timestamp($4/1000.0)
      GROUP BY 1`,
    [currentWorkspaceId(), accountId, sinceMs, untilMs, urls],
  );
  return r.rows.map((x: any) => ({ dia: String(x.dia), n: Number(x.n) || 0 }));
}
/** Las altas que se registraron en esas direcciones, una a una y lo último primero, con su ficha si la tienen. */
export async function dbSioLeadsDeUrls(accountId: string, sinceMs: number, untilMs: number, urls: string[], limit = 500): Promise<Array<{
  email: string; phone: string; name: string; at: number; source_url: string;
}>> {
  if (!pool || !urls.length) return [];
  const r = await pool.query(
    `SELECT l.email, COALESCE(c.phone,'') AS phone, COALESCE(c.name,'') AS name,
            extract(epoch from l.registered_at)*1000 AS at, l.source_url
       FROM app_sio_leads l ${sqlFichaDeEmail("l")}
      WHERE l.tenant_id=$1 AND l.account_id=$2 AND l.source_url = ANY($5::text[])
        AND l.registered_at >= to_timestamp($3/1000.0) AND l.registered_at <= to_timestamp($4/1000.0)
      ORDER BY l.registered_at DESC, l.sio_contact_id DESC LIMIT $6`,
    [currentWorkspaceId(), accountId, sinceMs, untilMs, urls, limit],
  );
  return r.rows.map((x: any) => ({
    email: String(x.email || ""), phone: String(x.phone || ""), name: String(x.name || ""), at: Number(x.at) || 0, source_url: String(x.source_url || ""),
  }));
}
/** Las altas de quien tiene ese email, en cualquier web del workspace (una por web), con la dirección donde se registró. */
export async function dbSioLeadsDeEmail(email: string): Promise<Array<{ account_id: string; source_url: string; at: number }>> {
  const e = String(email || "").trim();
  if (!pool || !e) return [];
  const r = await pool.query(
    `SELECT account_id, source_url, extract(epoch from registered_at)*1000 AS at
       FROM app_sio_leads
      WHERE tenant_id=$1 AND email <> '' AND lower(email)=lower($2) AND source_url <> '' AND registered_at IS NOT NULL
      ORDER BY registered_at ASC LIMIT 200`,
    [currentWorkspaceId(), e],
  );
  return r.rows.map((x: any) => ({ account_id: String(x.account_id), source_url: String(x.source_url || ""), at: Number(x.at) || 0 }));
}
export interface VentaDeFlujo {
  tx_id: string; kind: string; amount: number; currency: string; product: string; paid_at: number;
  phone: string; name: string; source: string; flow_id: string;
  /** COMPRAS-CONTACTO-1 · 'panel' = enlace de pago o webhook de ventas (app_purchases): trae el
   *  producto del catálogo en `product_id` y puede venir sin importe (0). Sin él, venta de la web. */
  origen?: "panel" | "web"; product_id?: string;
}
/**
 * Ventas hechas por gente de los flujos. Las de las webs de systeme.io se cruzan por el email de
 * la ficha (FORMULARIO-A-LEAD-1 lo pone al rellenar el checkout); las del panel (enlace de pago,
 * webhook de ventas) por el teléfono, y sólo si no están ya en la copia de las webs
 * (COMPRAS-CONTACTO-1). Cada venta va al ÚLTIMO flujo en el que entró esa persona ANTES de pagar:
 * así una venta no se cuenta dos veces aunque la persona pasara por varios flujos, y lo que
 * compró antes de entrar no es mérito del flujo.
 */
export async function dbVentasDeFlujos(o: { sinceMs?: number; untilMs?: number; flowIds?: string[] } = {}): Promise<VentaDeFlujo[]> {
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT * FROM (
         (SELECT DISTINCT ON (s.account_id, s.tx_id)
                'web' origen, s.tx_id, s.kind, s.amount, s.currency, s.product, '' product_id,
                extract(epoch from s.paid_at)*1000 paid_at,
                c.phone, c.name, c.source, fr.flow_id, fr.t entered
           FROM app_sio_sales s
           JOIN app_contacts c ON c.tenant_id=s.tenant_id AND c.email<>'' AND lower(c.email)=lower(s.email)
           JOIN LATERAL (
             SELECT r.flow_id, COALESCE(r.created_at, r.updated_at) t FROM app_flow_runs r
              WHERE r.tenant_id=s.tenant_id AND r.phone=c.phone AND COALESCE(r.created_at, r.updated_at) <= s.paid_at
              ORDER BY COALESCE(r.created_at, r.updated_at) DESC LIMIT 1) fr ON true
          WHERE s.tenant_id=$1 AND s.email<>'' AND s.paid_at IS NOT NULL
            AND ($2::timestamptz IS NULL OR s.paid_at >= $2) AND ($3::timestamptz IS NULL OR s.paid_at < $3)
          ORDER BY s.account_id, s.tx_id, fr.t DESC)
         UNION ALL
         (SELECT 'panel' origen, 'p' || p.id tx_id, 'sale' kind, (COALESCE(p.amount,0) - LEAST(COALESCE(p.amount,0), COALESCE(p.refunded_amount,0))) amount, lower(p.currency) currency,
                '' product, p.product_id, extract(epoch from p.created_at)*1000 paid_at,
                p.phone, COALESCE(c.name,'') name, COALESCE(c.source,'') source, fr.flow_id, fr.t entered
           FROM app_purchases p
           LEFT JOIN app_contacts c ON c.tenant_id=p.tenant_id AND c.phone=p.phone
           JOIN LATERAL (
             SELECT r.flow_id, COALESCE(r.created_at, r.updated_at) t FROM app_flow_runs r
              WHERE r.tenant_id=p.tenant_id AND r.phone=p.phone AND COALESCE(r.created_at, r.updated_at) <= p.created_at
              ORDER BY COALESCE(r.created_at, r.updated_at) DESC LIMIT 1) fr ON true
          WHERE NOT (p.refunded_amount IS NOT NULL AND p.refunded_amount >= p.amount) AND p.tenant_id=$1
            AND ($2::timestamptz IS NULL OR p.created_at >= $2) AND ($3::timestamptz IS NULL OR p.created_at < $3)
            AND NOT (${SQL_COMPRA_YA_EN_LA_WEB}))) v
        WHERE ($4::text[] IS NULL OR v.flow_id = ANY($4))
        ORDER BY v.paid_at DESC LIMIT 5000`,
      [currentWorkspaceId(), o.sinceMs ? new Date(o.sinceMs) : null, o.untilMs ? new Date(o.untilMs) : null, o.flowIds ?? null],
    );
    return r.rows.map((x: Record<string, unknown>) => ({
      tx_id: String(x.tx_id), kind: String(x.kind || "sale"), amount: Number(x.amount) || 0,
      currency: String(x.currency || ""), product: String(x.product || ""), paid_at: Number(x.paid_at) || 0,
      phone: String(x.phone || ""), name: String(x.name || ""), source: String(x.source || ""), flow_id: String(x.flow_id || ""),
      origen: x.origen === "panel" ? "panel" : "web", product_id: String(x.product_id || ""),
    }));
  } catch (e) {
    console.warn("[ventas-sio] cruce:", (e as Error).message);
    return [];
  }
}

/** phone → PRIMER flujo que lo captó (batch, para el cruce ref= de la atribución sio). */
/**
 * IDENTIDAD-COMUN-1 (MET-AUTO-09) · las fichas de quienes ENTRARON en algún flujo del workspace en
 * la ventana (misma fecha de entrada que dbVentasDeFlujos: created_at del run, o updated_at en las
 * filas viejas), con los datos que acreditan identidad: teléfono, correo, cuenta social, referencia
 * de systeme.io y el teléfono dado en un formulario. Las funde y las mide src/identidad.ts.
 */
export async function dbFichasEnFlujos(o: { sinceMs: number; untilMs: number; flowIds?: string[] | null }): Promise<FichaIdentidad[]> {
  const tenantId = currentWorkspaceId();
  const ficha = (c: Contact): FichaIdentidad => ({
    phone: c.phone, email: c.email, channel_account: c.channel_account, source: c.source,
    systemeio_contact_id: c.systemeio_contact_id, systemeio_account: c.systemeio_account,
    fields: { telefono: c.fields?.telefono ?? "", formulario: c.fields?.formulario ?? "", typeform_formulario: c.fields?.typeform_formulario ?? "" },
    created_at: c.created_at,
  });
  if (!pool) {
    const phones = new Set<string>();
    for (const r of mem.flowRuns.values()) {
      if ((r.tenant_id || "default") !== tenantId) continue;
      if (o.flowIds && o.flowIds.length && !o.flowIds.includes(r.flow_id)) continue;
      const t = Number((r as { created_at?: number }).created_at ?? r.updated_at ?? 0);
      if (t >= o.sinceMs && t < o.untilMs) phones.add(r.phone);
    }
    const out: FichaIdentidad[] = [];
    for (const p of phones) { const c = mem.contacts.get(contactMemKey(p, tenantId)); if (c) out.push(ficha(c)); }
    return out;
  }
  const r = await pool.query(
    `SELECT c.phone, c.email, c.channel_account, c.source, c.systemeio_contact_id, c.systemeio_account,
            c.fields->>'telefono' tel_form, c.fields->>'formulario' form_1, c.fields->>'typeform_formulario' form_2,
            extract(epoch from c.created_at)*1000 created_at
       FROM (SELECT DISTINCT r.phone FROM app_flow_runs r
              WHERE r.tenant_id=$1
                AND COALESCE(r.created_at, r.updated_at) >= $2 AND COALESCE(r.created_at, r.updated_at) < $3
                AND ($4::text[] IS NULL OR r.flow_id = ANY($4))) g
       JOIN app_contacts c ON c.tenant_id=$1 AND c.phone=g.phone
      LIMIT 20000`,
    [tenantId, new Date(o.sinceMs), new Date(o.untilMs), o.flowIds && o.flowIds.length ? o.flowIds : null],
  );
  return r.rows.map((x: Record<string, unknown>) => ({
    phone: String(x.phone ?? ""), email: String(x.email ?? ""), channel_account: String(x.channel_account ?? ""),
    source: String(x.source ?? ""), systemeio_contact_id: String(x.systemeio_contact_id ?? ""), systemeio_account: String(x.systemeio_account ?? ""),
    fields: { telefono: String(x.tel_form ?? ""), formulario: String(x.form_1 ?? ""), typeform_formulario: String(x.form_2 ?? "") },
    created_at: Number(x.created_at) || 0,
  }));
}
/**
 * IDENTIDAD-COMUN-1 (MET-AUTO-09) · de las ventas de las webs de systeme.io pagadas en la ventana,
 * cuántas enlazan con una ficha del workspace por el correo (la única unión acreditada que hay
 * entre una venta de la web y una persona del panel). Las que no, son el tramo «de la web a los
 * flujos» que no podemos seguir. En memoria no hay copia de ventas: 0 / 0.
 */
export async function dbVentasWebEnlazadas(o: { sinceMs: number; untilMs: number }): Promise<{ total: number; conFicha: number }> {
  if (!pool) return { total: 0, conFicha: 0 };
  const r = await pool.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM app_contacts c WHERE c.tenant_id=s.tenant_id AND c.email<>'' AND lower(c.email)=lower(s.email)))::int con_ficha
       FROM app_sio_sales s
      WHERE s.tenant_id=$1 AND s.kind='sale' AND s.paid_at IS NOT NULL AND s.paid_at >= $2 AND s.paid_at < $3`,
    [currentWorkspaceId(), new Date(o.sinceMs), new Date(o.untilMs)],
  );
  return { total: Number(r.rows[0]?.total) || 0, conFicha: Number(r.rows[0]?.con_ficha) || 0 };
}
/**
 * RECORRIDO-LI-1 (MET-LI-04) · las filas del recorrido de LinkedIn hasta la reserva, acotadas por
 * tenant: las reservas y las ventas de la web de estos días, y los registros de origen (fichas del
 * panel y registros en la web) de las personas que importan: las que reservaron o compraron estos
 * días y las que llegaron desde LinkedIn estos días (con correo o, si no lo dejaron, por teléfono).
 * La regla vive en recorrido-li.ts. En memoria no hay registros de la web ni ventas: «sin medir».
 */
export async function dbRecorridoLinkedIn(o: { sinceMs: number; untilMs: number }): Promise<{
  origenes: Array<{ tipo: "ficha" | "registro"; email: string; phone: string; at: number | null; source: string; utm_source: string; utm_content: string }>;
  reservas: Array<{ cuenta: string; id: string; email: string; creada: number | null; estado: string }>;
  ventas: Array<{ cuenta: string; id: string; kind: string; email: string; pagada: number | null }>;
  agenda: boolean;
  ventasWeb: boolean;
  medido: boolean;
}> {
  if (!pool) return { origenes: [], reservas: [], ventas: [], agenda: false, ventasWeb: false, medido: false };
  const tenantId = currentWorkspaceId();
  const a = [tenantId, new Date(o.sinceMs), new Date(o.untilMs)];
  const ms = (v: unknown): number | null => (v == null ? null : Number(v) || null);
  const [hay, rs, vs, og] = await Promise.all([
    pool.query(
      `SELECT EXISTS (SELECT 1 FROM app_sio_bookings WHERE tenant_id=$1) agenda,
              EXISTS (SELECT 1 FROM app_sio_sales WHERE tenant_id=$1) ventas`,
      [tenantId],
    ),
    pool.query(
      `SELECT account_id, booking_id::text id, email, extract(epoch from created_at)*1000 creada, status
         FROM app_sio_bookings
        WHERE tenant_id=$1 AND COALESCE(created_at, booked_at) >= $2 AND COALESCE(created_at, booked_at) < $3`,
      a,
    ),
    pool.query(
      `SELECT account_id, tx_id, kind, email, extract(epoch from paid_at)*1000 pagada
         FROM app_sio_sales
        WHERE tenant_id=$1 AND paid_at >= $2 AND paid_at < $3`,
      a,
    ),
    pool.query(
      `WITH em AS (
         SELECT lower(trim(email)) e FROM app_sio_bookings
          WHERE tenant_id=$1 AND COALESCE(created_at, booked_at) >= $2 AND COALESCE(created_at, booked_at) < $3 AND trim(email)<>''
         UNION SELECT lower(trim(email)) FROM app_sio_sales
          WHERE tenant_id=$1 AND paid_at >= $2 AND paid_at < $3 AND trim(email)<>''
         UNION SELECT lower(trim(email)) FROM app_contacts
          WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3 AND trim(email)<>''
            AND (COALESCE(utm_source,'') ILIKE '%linkedin%' OR COALESCE(source,'') ILIKE '%linkedin%')
         UNION SELECT lower(trim(email)) FROM app_sio_leads
          WHERE tenant_id=$1 AND registered_at >= $2 AND registered_at < $3 AND trim(email)<>''
            AND COALESCE(utm_source,'') ILIKE '%linkedin%'
       )
       SELECT 'ficha' tipo, lower(trim(c.email)) email, c.phone, extract(epoch from c.created_at)*1000 AS at,
              COALESCE(c.source,'') source, COALESCE(c.utm_source,'') utm_source, COALESCE(c.utm_content,'') utm_content
         FROM app_contacts c JOIN em ON lower(trim(c.email)) = em.e
        WHERE c.tenant_id=$1
       UNION ALL
       SELECT 'registro', lower(trim(l.email)), '', extract(epoch from l.registered_at)*1000,
              '', COALESCE(l.utm_source,''), COALESCE(l.utm_content,'')
         FROM app_sio_leads l JOIN em ON lower(trim(l.email)) = em.e
        WHERE l.tenant_id=$1
       UNION ALL
       SELECT 'ficha', '', c.phone, extract(epoch from c.created_at)*1000,
              COALESCE(c.source,''), COALESCE(c.utm_source,''), COALESCE(c.utm_content,'')
         FROM app_contacts c
        WHERE c.tenant_id=$1 AND c.created_at >= $2 AND c.created_at < $3 AND trim(COALESCE(c.email,''))=''
          AND (COALESCE(c.utm_source,'') ILIKE '%linkedin%' OR COALESCE(c.source,'') ILIKE '%linkedin%')`,
      a,
    ),
  ]);
  return {
    origenes: og.rows.map((x: any) => ({ tipo: x.tipo === "registro" ? "registro" as const : "ficha" as const, email: String(x.email || ""), phone: String(x.phone || ""), at: ms(x.at), source: String(x.source || ""), utm_source: String(x.utm_source || ""), utm_content: String(x.utm_content || "") })),
    reservas: rs.rows.map((x: any) => ({ cuenta: String(x.account_id || ""), id: String(x.id || ""), email: String(x.email || ""), creada: ms(x.creada), estado: String(x.status || "") })),
    ventas: vs.rows.map((x: any) => ({ cuenta: String(x.account_id || ""), id: String(x.tx_id || ""), kind: String(x.kind || "sale"), email: String(x.email || ""), pagada: ms(x.pagada) })),
    agenda: !!hay.rows[0]?.agenda,
    ventasWeb: !!hay.rows[0]?.ventas,
    medido: true,
  };
}
/**
 * ORIGEN-ATRIBUCION-1 (MET-ORIGEN-07) · las ventas del rango una a una (enlaces de pago del panel y
 * webs de systeme.io, devoluciones incluidas) con lo que se sabe de cómo llegó cada persona: su ficha
 * (origen guardado, alta y primer flujo), su primer registro en la web y si reservó una llamada antes
 * de pagar. Acotado por workspace. Una compra del panel que ya está en la copia de las webs es la
 * misma venta (SQL_COMPRA_YA_EN_LA_WEB, como en COMPRAS-CONTACTO-1). La regla vive en origen-cierre.ts.
 * Sólo Postgres: en modo memoria no se guardan ventas («sin medir», no 0).
 */
export interface FichaDeVenta { at: number | null; source: string; utm_source: string; utm_medium: string; utm_campaign: string; utm_content: string; flow_id: string; flow_at: number | null }
export interface RegistroDeVenta { at: number | null; utm_source: string; utm_campaign: string; utm_content: string }
export interface VentaConLlegada {
  ref: string; fuente: "panel" | "web"; kind: "sale" | "refund"; currency: string; amount: number; at: number;
  ficha: FichaDeVenta | null; registro: RegistroDeVenta | null; reservoAntes: boolean;
  /** MET-ORIGEN-07-FIN · quién compra (correo, o teléfono si no hay) y si ya había pagado antes. */
  persona: string; recompra: boolean;
}
export async function dbOrigenCierre(sinceMs: number, untilMs: number, limit = 5000): Promise<{ medido: boolean; ventas: VentaConLlegada[]; truncado?: boolean }> {
  if (!pool) return { medido: false, ventas: [] };
  const tenantId = currentWorkspaceId();
  const ms = (v: unknown): number | null => (v == null ? null : Number(v) || null);
  const ficha = (x: any): FichaDeVenta | null =>
    x.alta == null && !x.flow_id ? null : {
      at: ms(x.alta), source: String(x.source || ""), utm_source: String(x.utm_source || ""), utm_medium: String(x.utm_medium || ""),
      utm_campaign: String(x.utm_campaign || ""), utm_content: String(x.utm_content || ""), flow_id: String(x.flow_id || ""), flow_at: ms(x.flow_at),
    };
  const registro = (x: any): RegistroDeVenta | null =>
    x.reg_at == null ? null : { at: ms(x.reg_at), utm_source: String(x.l_utm_source || ""), utm_campaign: String(x.l_utm_campaign || ""), utm_content: String(x.l_utm_content || "") };
  const [rp, rs] = await Promise.all([
    pool.query(
      `SELECT p.id, extract(epoch from p.created_at)*1000 AS at, lower(p.currency) AS currency, (COALESCE(p.amount,0) - LEAST(COALESCE(p.amount,0), COALESCE(p.refunded_amount,0)))::float8 AS amount,
              extract(epoch from c.created_at)*1000 AS alta, COALESCE(c.source,'') AS source, COALESCE(c.utm_source,'') AS utm_source,
              COALESCE(c.utm_medium,'') AS utm_medium, COALESCE(c.utm_campaign,'') AS utm_campaign, COALESCE(c.utm_content,'') AS utm_content,
              COALESCE(fr.flow_id,'') AS flow_id, extract(epoch from fr.flow_ts)*1000 AS flow_at,
              extract(epoch from l.registered_at)*1000 AS reg_at, COALESCE(l.utm_source,'') AS l_utm_source,
              COALESCE(l.utm_campaign,'') AS l_utm_campaign, COALESCE(l.utm_content,'') AS l_utm_content,
              EXISTS (SELECT 1 FROM app_sio_bookings b
                       WHERE b.tenant_id=p.tenant_id AND COALESCE(c.email,'')<>'' AND lower(b.email)=lower(c.email)
                         AND lower(COALESCE(b.status,'')) NOT LIKE '%cancel%'
                         AND COALESCE(b.created_at, b.booked_at) < p.created_at) AS reservo,
              COALESCE(NULLIF(lower(trim(COALESCE(c.email,''))),''), p.phone, '') AS persona,
              (EXISTS (SELECT 1 FROM app_purchases q WHERE q.tenant_id=p.tenant_id AND q.phone=p.phone AND q.created_at < p.created_at)
               OR EXISTS (SELECT 1 FROM app_sio_sales z WHERE z.tenant_id=p.tenant_id AND COALESCE(c.email,'')<>'' AND lower(z.email)=lower(c.email)
                           AND z.kind<>'refund' AND z.paid_at < p.created_at)) AS recompra
         FROM app_purchases p
         LEFT JOIN app_contacts c ON c.tenant_id=p.tenant_id AND c.phone=p.phone
         LEFT JOIN LATERAL (
           SELECT r.flow_id, COALESCE(r.created_at, r.updated_at) AS flow_ts FROM app_flow_runs r
            WHERE r.tenant_id=p.tenant_id AND r.phone=p.phone
              AND COALESCE(r.created_at, r.updated_at) < p.created_at
            ORDER BY COALESCE(r.created_at, r.updated_at) ASC LIMIT 1) fr ON true
         LEFT JOIN LATERAL (
           SELECT y.registered_at, y.utm_source, y.utm_campaign, y.utm_content FROM app_sio_leads y
            WHERE y.tenant_id=p.tenant_id AND COALESCE(c.email,'')<>'' AND lower(y.email)=lower(c.email)
            ORDER BY y.registered_at ASC LIMIT 1) l ON true
        WHERE NOT (p.refunded_amount IS NOT NULL AND p.refunded_amount >= p.amount) AND p.tenant_id=$1 AND p.created_at >= to_timestamp($2/1000.0) AND p.created_at <= to_timestamp($3/1000.0)
          AND NOT (${SQL_COMPRA_YA_EN_LA_WEB})
        ORDER BY p.created_at DESC LIMIT $4`,
      [tenantId, sinceMs, untilMs, limit + 1],
    ),
    pool.query(
      `SELECT s.account_id, s.tx_id, extract(epoch from s.paid_at)*1000 AS at, s.kind, lower(s.currency) AS currency, COALESCE(s.amount,0)::float8 AS amount,
              extract(epoch from c.created_at)*1000 AS alta, COALESCE(c.source,'') AS source, COALESCE(c.utm_source,'') AS utm_source,
              COALESCE(c.utm_medium,'') AS utm_medium, COALESCE(c.utm_campaign,'') AS utm_campaign, COALESCE(c.utm_content,'') AS utm_content,
              COALESCE(fr.flow_id,'') AS flow_id, extract(epoch from fr.flow_ts)*1000 AS flow_at,
              extract(epoch from l.registered_at)*1000 AS reg_at, COALESCE(l.utm_source,'') AS l_utm_source,
              COALESCE(l.utm_campaign,'') AS l_utm_campaign, COALESCE(l.utm_content,'') AS l_utm_content,
              EXISTS (SELECT 1 FROM app_sio_bookings b
                       WHERE b.tenant_id=s.tenant_id AND s.email<>'' AND lower(b.email)=lower(s.email)
                         AND lower(COALESCE(b.status,'')) NOT LIKE '%cancel%'
                         AND COALESCE(b.created_at, b.booked_at) < s.paid_at) AS reservo,
              lower(trim(COALESCE(s.email,''))) AS persona,
              (EXISTS (SELECT 1 FROM app_sio_sales z WHERE z.tenant_id=s.tenant_id AND s.email<>'' AND lower(z.email)=lower(s.email)
                        AND z.kind<>'refund' AND z.paid_at < s.paid_at)
               OR EXISTS (SELECT 1 FROM app_purchases q WHERE q.tenant_id=s.tenant_id AND c.phone IS NOT NULL AND q.phone=c.phone
                           AND q.created_at < s.paid_at)) AS recompra
         FROM app_sio_sales s
         LEFT JOIN LATERAL (
           SELECT x.phone, x.created_at, x.source, x.utm_source, x.utm_medium, x.utm_campaign, x.utm_content FROM app_contacts x
            WHERE x.tenant_id=s.tenant_id AND s.email<>'' AND lower(x.email)=lower(s.email)
            ORDER BY x.created_at ASC LIMIT 1) c ON true
         LEFT JOIN LATERAL (
           SELECT r.flow_id, COALESCE(r.created_at, r.updated_at) AS flow_ts FROM app_flow_runs r
            WHERE r.tenant_id=s.tenant_id AND c.phone IS NOT NULL AND r.phone=c.phone
              AND COALESCE(r.created_at, r.updated_at) < s.paid_at
            ORDER BY COALESCE(r.created_at, r.updated_at) ASC LIMIT 1) fr ON true
         LEFT JOIN LATERAL (
           SELECT y.registered_at, y.utm_source, y.utm_campaign, y.utm_content FROM app_sio_leads y
            WHERE y.tenant_id=s.tenant_id AND s.email<>'' AND lower(y.email)=lower(s.email)
            ORDER BY y.registered_at ASC LIMIT 1) l ON true
        WHERE s.tenant_id=$1 AND s.paid_at IS NOT NULL
          AND s.paid_at >= to_timestamp($2/1000.0) AND s.paid_at <= to_timestamp($3/1000.0)
        ORDER BY s.paid_at DESC LIMIT $4`,
      [tenantId, sinceMs, untilMs, limit + 1],
    ),
  ]);
  // METRICAS-1 · se pide una fila de más: si llega, hay más ventas de las que se leen y la cifra es parcial.
  const truncado = rp.rows.length > limit || rs.rows.length > limit;
  if (truncado) { rp.rows.length = Math.min(rp.rows.length, limit); rs.rows.length = Math.min(rs.rows.length, limit); }
  const ventas: VentaConLlegada[] = [
    ...rp.rows.map((x: any): VentaConLlegada => ({
      ref: "panel:" + x.id, fuente: "panel", kind: "sale", currency: String(x.currency || ""), amount: Number(x.amount) || 0,
      at: Number(x.at) || 0, ficha: ficha(x), registro: registro(x), reservoAntes: !!x.reservo,
      persona: String(x.persona || ""), recompra: !!x.recompra,
    })),
    ...rs.rows.map((x: any): VentaConLlegada => ({
      ref: "web:" + x.account_id + ":" + x.tx_id, fuente: "web", kind: x.kind === "refund" ? "refund" : "sale",
      currency: String(x.currency || ""), amount: Number(x.amount) || 0,
      at: Number(x.at) || 0, ficha: ficha(x), registro: registro(x), reservoAntes: !!x.reservo,
      persona: String(x.persona || ""), recompra: !!x.recompra,
    })),
  ];
  return { medido: true, ventas, truncado };
}
export async function dbFirstFlowForPhones(phones: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!phones.length) return out;
  const tenantId = currentWorkspaceId();
  if (!pool) {
    for (const ph of phones) {
      let best = Infinity, fid = "";
      for (const r of mem.flowRuns.values()) if (r.phone === ph && (r.next_run || 0) < best) { best = r.next_run || 0; fid = r.flow_id; }
      if (fid) out.set(ph, fid);
    }
    return out;
  }
  const r = await pool.query(
    `SELECT DISTINCT ON (phone) phone, flow_id FROM app_flow_runs
     WHERE phone = ANY($1) AND tenant_id=$2
     ORDER BY phone, COALESCE(created_at,updated_at) ASC`,
    [phones, tenantId],
  );
  for (const x of r.rows) out.set(x.phone, x.flow_id);
  return out;
}

export interface LinkAttendee {
  phone: string;
  name: string;
  stage: string;
  clicks: number;
  first_click: number;
  last_click: number;
}
export interface LinkAttendance {
  attendees: LinkAttendee[]; // clics identificados (con phone), agrupados por contacto
  received: Array<{ phone: string; name: string; stage: string }>; // a quién repartió el enlace el flujo de origen
  fromFlow: boolean; // el enlace nació de un flujo → hay denominador "recibieron" para el embudo
  timeline: number[]; // epoch ms de TODOS los clics (identificados o no), para agrupar por hora en el cliente
  totalClicks: number;
  anonClicks: number; // clics sin phone (webs / enlaces pre-atribución)
  // ENLACE-DESPUES-1 · qué hicieron DESPUÉS de abrirlo los que lo abrieron: páginas de la web
  // del negocio que vieron (landing → checkout → gracias, por la marca lmc_) y lo que compraron.
  pages: Array<{ path: string; label: string; people: number; views: number }>;
  buyers: Array<{ phone: string; name: string; origen: string; kind: string; amount: number; currency: string; product: string; paid_at: number }>;
  // ENL-04-PASOS-1 · reservas hechas (no canceladas) por quien lo abrió, después de abrirlo.
  reservas: Array<{ phone: string; name: string; estado: string; cita: number | null; hecha: number | null }>;
  // ¿Hay alguna reserva sincronizada alguna vez? Sin ninguna, «0 reservas» sería falso: es «sin medición».
  agendaConectada: boolean;
}
/** ENL-04-PASOS-1 · qué pasos POSTERIORES al clic tiene sentido contar, según a dónde lleva el enlace:
 *  - "web" (por defecto): una web del negocio con el píxel → páginas que vieron, reservas y compras;
 *  - "pago": el enlace personal de pago de UN producto → solo las compras confirmadas de ESE producto;
 *  - "clics": lleva fuera (un directo, un documento, un grupo, una agenda ajena) → el sistema no ve nada
 *    después del clic y no se cuenta nada. */
export interface LinkPasosOpts {
  pasos?: "web" | "pago" | "clics";
  productId?: string;
}

/**
 * Asistencia de un enlace acortado (una "live"/recurso): quién lo abrió (cruzando
 * app_link_clicks.phone con app_contacts) + a quién se lo REPARTIÓ el flujo que lo
 * generó (app_flow_runs por su context_id), para el embudo recibieron→abrieron.
 * Todo scoped al workspace activo. Sin flujo de origen, `received` va vacío y el
 * panel muestra solo clics (sin embudo). El denominador es automático y por-evento
 * (no una etiqueta global): cada enlace mide su propia audiencia.
 */
/** Detalle de un enlace o, si se le pasa `tokens`, del GRUPO entero (todos
 *  los enlaces personales del mismo enlace real). Agregar dentro de la consulta
 *  y no sumando por fuera es lo que evita contar dos veces a quien abrió dos de
 *  ellos: las personas salen de un COUNT(DISTINCT phone) sobre el conjunto. */
export async function dbLinkAttendance(token: string, tokens?: string[], opts?: LinkPasosOpts): Promise<LinkAttendance> {
  const tenantId = currentWorkspaceId();
  const empty: LinkAttendance = { attendees: [], received: [], fromFlow: false, timeline: [], totalClicks: 0, anonClicks: 0, pages: [], buyers: [], reservas: [], agendaConectada: false };
  if (!token || !pool) return empty;
  const lista = tokens && tokens.length ? tokens : [token];
  // 0) Contexto del enlace: si nació de un flujo, su context_id es el flow_id → nos
  //    da la audiencia "recibieron" sin necesidad de etiquetas manuales.
  const ctxq = await pool.query(
    `SELECT context_kind, context_id FROM app_short_links WHERE token = ANY($1::text[]) AND tenant_id=$2 LIMIT 1`,
    [lista, tenantId],
  );
  const ctx = ctxq.rows[0] as { context_kind?: string; context_id?: string } | undefined;
  // 1) Asistentes: clics con phone, agrupados por contacto (JOIN opcional a app_contacts).
  const att = await pool.query(
    `SELECT c.phone,
            COALESCE(ct.name,'') name,
            COALESCE(ct.stage,'') stage,
            COUNT(*)::int clicks,
            extract(epoch from MIN(c.created_at))*1000 first_click,
            extract(epoch from MAX(c.created_at))*1000 last_click
       FROM app_link_clicks c
       LEFT JOIN app_contacts ct ON ct.phone=c.phone AND ct.tenant_id=$2
      WHERE c.token = ANY($1::text[]) AND c.tenant_id=$2 AND c.phone<>''
      GROUP BY c.phone, ct.name, ct.stage
      ORDER BY first_click ASC`,
    [lista, tenantId],
  );
  // 2) Conteos globales (identificados + anónimos).
  const tot = await pool.query(
    `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE phone='')::int anon
       FROM app_link_clicks WHERE token = ANY($1::text[]) AND tenant_id=$2`,
    [lista, tenantId],
  );
  // 3) Línea de tiempo: timestamps de todos los clics (se agrupan por hora en el cliente).
  const tl = await pool.query(
    `SELECT extract(epoch from created_at)*1000 t FROM app_link_clicks
      WHERE token = ANY($1::text[]) AND tenant_id=$2 ORDER BY created_at`,
    [lista, tenantId],
  );
  // 4) RECIBIERON: a quién repartió este enlace el flujo de origen (distinct phone en
  //    app_flow_runs de ese flow). Es el denominador honesto del embudo, por-evento.
  let received: Array<{ phone: string; name: string; stage: string }> = [];
  const fromFlow = !!(ctx && ctx.context_kind === "flow" && ctx.context_id);
  if (fromFlow) {
    const rc = await pool.query(
      `SELECT DISTINCT r.phone,
              COALESCE(ct.name,'') name,
              COALESCE(ct.stage,'') stage
         FROM app_flow_runs r
         LEFT JOIN app_contacts ct ON ct.phone=r.phone AND ct.tenant_id=$2
        WHERE r.flow_id=$1 AND r.tenant_id=$2 AND r.phone<>''`,
      [ctx!.context_id, tenantId],
    );
    received = rc.rows.map((x: any) => ({ phone: x.phone, name: x.name, stage: x.stage }));
  }
  // 5) ENLACE-DESPUES-1 · lo que pasó después del primer clic de cada uno. El checkout no es
  //    un enlace del flujo (lo abre la persona dentro de la web), así que se ve por las visitas
  //    atribuidas (app_page_views.contact, en dígitos) y por las ventas. Margen de 10 min antes
  //    del clic: el reloj de la visita y el del clic no son el mismo.
  //    ENL-04-PASOS-1 · y solo lo que el sistema REGISTRA para ese tipo de enlace (opts.pasos):
  //    a una persona que pulsó un enlace a Zoom no se le puede atribuir la compra de otra cosa.
  const abrieron = `SELECT phone, regexp_replace(phone,'[^0-9]','','g') d, MIN(created_at) - interval '10 minutes' t
                      FROM app_link_clicks WHERE token = ANY($1::text[]) AND tenant_id=$2 AND phone<>'' GROUP BY phone`;
  const modo = opts?.pasos || "web";
  let pages: LinkAttendance["pages"] = [];
  let buyers: LinkAttendance["buyers"] = [];
  let reservas: LinkAttendance["reservas"] = [];
  let agendaConectada = false;
  const aCompra = (x: any): LinkAttendance["buyers"][number] => ({
    phone: x.phone, name: x.name, origen: String(x.origen || ""), kind: String(x.kind || "sale"), amount: Number(x.amount) || 0,
    currency: String(x.currency || ""), product: String(x.product || ""), paid_at: Number(x.paid_at) || 0,
  });
  if (modo === "pago") {
    // Enlace personal de pago de UN producto: lo que pasa después es la compra CONFIRMADA de ESE
    // producto (app_purchases la guarda una sola vez por pago, aunque el enlace se abra cien veces)
    // hecha por quien lo abrió. Nada de visitas ni de compras de otros productos.
    if (opts?.productId) {
      try {
        const ps = await pool.query(
          `SELECT p.phone, COALESCE(c.name,'') name, 'panel' origen, 'sale' kind, (COALESCE(p.amount,0) - LEAST(COALESCE(p.amount,0), COALESCE(p.refunded_amount,0))) amount, lower(p.currency) currency,
                  p.product_id product, extract(epoch from p.created_at)*1000 paid_at
             FROM app_purchases p
             LEFT JOIN app_contacts c ON c.tenant_id=p.tenant_id AND c.phone=p.phone
             JOIN (${abrieron}) o ON o.phone=p.phone AND p.created_at >= o.t
            WHERE NOT (p.refunded_amount IS NOT NULL AND p.refunded_amount >= p.amount) AND p.tenant_id=$2 AND p.product_id=$3
            ORDER BY paid_at DESC LIMIT 500`,
          [lista, tenantId, opts.productId],
        );
        buyers = ps.rows.map(aCompra);
      } catch (e) {
        console.warn("[enlaces] compras del producto:", (e as Error).message);
      }
    }
  } else if (modo === "web") {
    try {
      const pv = await pool.query(
        `SELECT v.path, MAX(v.page_label) label, COUNT(DISTINCT v.contact)::int people, COUNT(*)::int views
           FROM app_page_views v JOIN (${abrieron}) o ON o.d=v.contact AND v.created_at >= o.t
          WHERE v.tenant_id=$2 AND v.contact<>''
          GROUP BY v.path ORDER BY people DESC, views DESC LIMIT 12`,
        [lista, tenantId],
      );
      pages = pv.rows.map((x: any) => ({ path: String(x.path || "/"), label: String(x.label || ""), people: Number(x.people), views: Number(x.views) }));
      const vs = await pool.query(
        `SELECT * FROM (
           (SELECT DISTINCT ON (s.account_id, s.tx_id) o.phone, COALESCE(c.name,'') name, 'web' origen, s.kind, s.amount, s.currency, s.product,
                   extract(epoch from s.paid_at)*1000 paid_at
              FROM app_sio_sales s
              JOIN app_contacts c ON c.tenant_id=s.tenant_id AND c.email<>'' AND lower(c.email)=lower(s.email)
              JOIN (${abrieron}) o ON o.phone=c.phone AND s.paid_at >= o.t
             WHERE s.tenant_id=$2 AND s.paid_at IS NOT NULL
             ORDER BY s.account_id, s.tx_id)
           UNION ALL
           (SELECT p.phone, COALESCE(c.name,'') name, 'panel' origen, 'sale' kind, (COALESCE(p.amount,0) - LEAST(COALESCE(p.amount,0), COALESCE(p.refunded_amount,0))) amount, lower(p.currency) currency,
                   p.product_id product, extract(epoch from p.created_at)*1000 paid_at
              FROM app_purchases p
              LEFT JOIN app_contacts c ON c.tenant_id=p.tenant_id AND c.phone=p.phone
              JOIN (${abrieron}) o ON o.phone=p.phone AND p.created_at >= o.t
             WHERE NOT (p.refunded_amount IS NOT NULL AND p.refunded_amount >= p.amount) AND p.tenant_id=$2 AND NOT (${SQL_COMPRA_YA_EN_LA_WEB}))) v
         ORDER BY paid_at DESC LIMIT 500`,
        [lista, tenantId],
      );
      buyers = vs.rows.map(aCompra);
    } catch (e) {
      console.warn("[enlaces] qué pasó después:", (e as Error).message);
    }
    // ENL-04-PASOS-1 · reservas HECHAS (no canceladas) por quien lo abrió, después de abrirlo, desde la
    // agenda sincronizada (por el email de su ficha). `agendaConectada` distingue «ninguna reserva» de
    // «el panel no ve ninguna agenda»: sin agenda sincronizada un cero sería mentira.
    try {
      const hay = await pool.query("SELECT 1 FROM app_sio_bookings WHERE tenant_id=$1 LIMIT 1", [tenantId]);
      agendaConectada = hay.rows.length > 0;
      if (agendaConectada) {
        const rv = await pool.query(
          `SELECT * FROM (
             SELECT DISTINCT ON (b.account_id, b.booking_id) o.phone, COALESCE(c.name,'') name, b.status estado,
                    extract(epoch from b.booked_at)*1000 cita,
                    extract(epoch from COALESCE(b.created_at, b.booked_at))*1000 hecha
               FROM app_sio_bookings b
               JOIN app_contacts c ON c.tenant_id=b.tenant_id AND c.email<>'' AND lower(c.email)=lower(b.email)
               JOIN (${abrieron}) o ON o.phone=c.phone AND COALESCE(b.created_at, b.booked_at) >= o.t
              WHERE b.tenant_id=$2 AND upper(b.status) <> 'CANCELLED'
              ORDER BY b.account_id, b.booking_id) r
           ORDER BY hecha DESC LIMIT 200`,
          [lista, tenantId],
        );
        reservas = rv.rows.map((x: any) => ({
          phone: String(x.phone || ""), name: String(x.name || ""), estado: String(x.estado || ""),
          cita: x.cita != null ? Number(x.cita) : null, hecha: x.hecha != null ? Number(x.hecha) : null,
        }));
      }
    } catch (e) {
      console.warn("[enlaces] reservas después:", (e as Error).message);
    }
  }
  return {
    pages,
    buyers,
    reservas,
    agendaConectada,
    attendees: att.rows.map((x: any) => ({
      phone: x.phone,
      name: x.name,
      stage: x.stage,
      clicks: Number(x.clicks),
      first_click: Number(x.first_click),
      last_click: Number(x.last_click),
    })),
    received,
    fromFlow,
    timeline: tl.rows.map((x: any) => Number(x.t)),
    totalClicks: Number(tot.rows[0]?.total || 0),
    anonClicks: Number(tot.rows[0]?.anon || 0),
  };
}

/** Personas únicas (clics con phone) por token, para la lista de enlaces. Scoped al workspace. */
export async function dbLinkPeople(): Promise<Record<string, number>> {
  const tenantId = currentWorkspaceId();
  if (!pool) return {};
  const r = await pool.query(
    `SELECT token, COUNT(DISTINCT phone)::int people
       FROM app_link_clicks WHERE tenant_id=$1 AND phone<>'' GROUP BY token`,
    [tenantId],
  );
  const out: Record<string, number> = {};
  for (const row of r.rows) out[row.token] = Number(row.people);
  return out;
}

/**
 * Personas únicas GLOBALES del workspace (COUNT DISTINCT phone sin agrupar por token):
 * la misma persona que abrió 3 enlaces distintos cuenta UNA vez. Es el número honesto
 * para el tile «Personas» del sumario de LIVE · Asistencia (dbLinkPeople da únicos POR
 * enlace y sumarlos duplica personas).
 */
export async function dbLinkUniquePeople(): Promise<number> {
  const tenantId = currentWorkspaceId();
  if (!pool) return 0;
  const r = await pool.query(
    `SELECT COUNT(DISTINCT phone)::int people
       FROM app_link_clicks WHERE tenant_id=$1 AND phone<>''`,
    [tenantId],
  );
  return Number(r.rows[0]?.people || 0);
}

/**
 * Tenant dueño de un page draft por su id. UNSCOPED a propósito: lo usa el píxel
 * público /pv (sin scope de workspace) para atribuir la visita al tenant correcto.
 * El id es un UUID inguessable (capability). null si no existe (HTML standalone).
 */
export async function dbDraftTenantById(pageId: string): Promise<string | null> {
  if (!pool || !pageId) return null;
  try {
    const r = await pool.query("SELECT tenant_id FROM app_page_drafts WHERE id=$1", [pageId]);
    return (r.rows[0]?.tenant_id as string) ?? null;
  } catch {
    return null;
  }
}

// ---- Publicaciones programadas (calendario tipo Metricool) ----
function rowToSched(r: any): ScheduledPost {
  let plats: string[] = ["instagram"];
  if (r.platforms) {
    try {
      const v = typeof r.platforms === "string" ? JSON.parse(r.platforms) : r.platforms;
      if (Array.isArray(v) && v.length) plats = v.filter((x: any) => typeof x === "string");
    } catch { /* ignore */ }
  }
  let tags: ScheduledPost["tags"] = {};
  if (r.tags) {
    try {
      const v = typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags;
      if (v && typeof v === "object") tags = v;
    } catch { /* ignore */ }
  }
  return {
    id: r.id, ig_id: r.ig_id ?? "", kind: r.kind ?? "image",
    media_url: r.media_url ?? "", caption: r.caption ?? "",
    scheduled_at: Number(r.scheduled_at), status: r.status ?? "pending",
    result: r.result ?? "",
    platforms: plats,
    tags,
    uploadPostAccountId: r.up_account_id || "",
    tenant_id: r.tenant_id || "default",
  };
}
export async function dbListScheduledPosts(opts?: { tenantId?: string; allTenants?: boolean }): Promise<ScheduledPost[]> {
  // WS-ISOLATION 2026-06-04: por defecto filtramos por workspace activo (ALS).
  // opts.allTenants=true es escape hatch para flows tipo cron worker que ven todo.
  // opts.tenantId override explicito permite forzar otro ws (admin tools).
  const tenantId = opts?.tenantId ?? (opts?.allTenants ? undefined : currentWorkspaceId());
  if (!pool) {
    let rows = [...mem.scheduledPosts.values()];
    if (tenantId) rows = rows.filter((p) => (p.tenant_id || "default") === tenantId);
    return rows.sort((a, b) => a.scheduled_at - b.scheduled_at);
  }
  const params: unknown[] = [];
  let where = "";
  if (tenantId) { params.push(tenantId); where = ` WHERE tenant_id=$${params.length}`; }
  const r = await pool.query(
    `SELECT id,ig_id,kind,media_url,caption, extract(epoch from scheduled_at)*1000 scheduled_at, status,result,platforms,tags,up_account_id,tenant_id FROM app_scheduled_posts${where} ORDER BY scheduled_at ASC`,
    params,
  );
  return r.rows.map(rowToSched);
}
/** FLUJO-AL-PUBLICAR-1 · publicaciones ya publicadas con flujos asignados que aún no se han activado. */
export async function dbListPostsConFlujosPendientes(): Promise<ScheduledPost[]> {
  if (!pool) {
    return [...mem.scheduledPosts.values()].filter((p) =>
      (p.status === "published" || p.status === "partial") && Array.isArray(p.tags?.flujos) && p.tags.flujos.length && !p.tags.flujosListos);
  }
  const r = await pool.query(
    `SELECT id,ig_id,kind,media_url,caption, extract(epoch from scheduled_at)*1000 scheduled_at, status,result,platforms,tags,up_account_id,tenant_id
       FROM app_scheduled_posts
      WHERE status IN ('published','partial') AND tags ? 'flujos' AND NOT (tags ? 'flujosListos')
        AND scheduled_at > now() - interval '3 days'
      ORDER BY scheduled_at ASC LIMIT 50`,
  );
  return r.rows.map(rowToSched);
}
/** FLUJO-AL-PUBLICAR-1 · deja constancia (por flujo) de lo que se hizo; con ello el tick no la repite. */
export async function dbMarcarFlujosListos(id: string, tenantId: string, valor: Record<string, unknown>): Promise<void> {
  if (!pool) {
    const p = mem.scheduledPosts.get(id);
    if (p) p.tags = { ...(p.tags || {}), flujosListos: valor };
    return;
  }
  await pool.query(
    `UPDATE app_scheduled_posts SET tags = tags || jsonb_build_object('flujosListos', $3::jsonb) WHERE id=$1 AND tenant_id=$2`,
    [id, tenantId, JSON.stringify(valor)],
  );
}
export async function dbUpsertScheduledPost(p: ScheduledPost): Promise<void> {
  const tenantId = p.tenant_id || currentWorkspaceId();
  if (!pool) {
    mem.scheduledPosts.set(p.id, { ...p, tenant_id: tenantId });
    return;
  }
  const plats = JSON.stringify(p.platforms && p.platforms.length ? p.platforms : ["instagram"]);
  const tags = JSON.stringify(p.tags || {});
  const upId = p.uploadPostAccountId || "";
  await pool.query(
    `INSERT INTO app_scheduled_posts (id,ig_id,kind,media_url,caption,scheduled_at,status,result,platforms,tags,up_account_id,tenant_id)
     VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7,$8,$9::jsonb,$10::jsonb,$11,$12)
     ON CONFLICT (id) DO UPDATE SET ig_id=$2,kind=$3,media_url=$4,caption=$5,scheduled_at=to_timestamp($6/1000.0),status=$7,result=$8,platforms=$9::jsonb,tags=$10::jsonb,up_account_id=$11,tenant_id=$12`,
    [p.id, p.ig_id, p.kind, p.media_url, p.caption, p.scheduled_at, p.status, p.result, plats, tags, upId, tenantId],
  );
}
// PROG-EDIT-1 · Editar o reintentar desde el panel: sólo si SIGUE pendiente, en borrador o
// fallida, comprobado en la misma sentencia que escribe. Mirar antes y escribir después con
// el upsert ciego dejaba una ventana: si el scheduler la reclamaba ('sending') en medio, el
// upsert la devolvía a 'pending' y salía dos veces (lo mismo que PROG-CAL-1 cerró al arrastrar).
export async function dbEditScheduledPost(p: ScheduledPost): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  const EDITABLE = ["pending", "error", "draft"];
  if (!pool) {
    const cur = mem.scheduledPosts.get(p.id);
    if (!cur || (cur.tenant_id || "default") !== tenantId || EDITABLE.indexOf(cur.status) < 0) return false;
    mem.scheduledPosts.set(p.id, { ...p, tenant_id: tenantId });
    return true;
  }
  const plats = JSON.stringify(p.platforms && p.platforms.length ? p.platforms : ["instagram"]);
  const r = await pool.query(
    `UPDATE app_scheduled_posts
        SET ig_id=$2,kind=$3,media_url=$4,caption=$5,scheduled_at=to_timestamp($6/1000.0),status=$7,result=$8,platforms=$9::jsonb,tags=$10::jsonb,up_account_id=$11
      WHERE id=$1 AND tenant_id=$12 AND status = ANY($13::text[])`,
    [p.id, p.ig_id, p.kind, p.media_url, p.caption, p.scheduled_at, p.status, p.result, plats, JSON.stringify(p.tags || {}), p.uploadPostAccountId || "", tenantId, EDITABLE],
  );
  return (r.rowCount || 0) > 0;
}
// PROG-EDIT-1 · El scheduler cierra SÓLO estado y resultado. Reescribir la fila entera desde
// la copia del lote pisaba lo que hubiera cambiado mientras publicaba y resucitaba una
// publicación borrada a mitad de envío.
export async function dbFinishScheduledPost(id: string, tenantId: string, status: ScheduledPost["status"], result: string): Promise<void> {
  if (!pool) {
    const cur = mem.scheduledPosts.get(id);
    if (cur && (cur.tenant_id || "default") === tenantId) { cur.status = status; cur.result = result; }
    return;
  }
  await pool.query("UPDATE app_scheduled_posts SET status=$3, result=$4 WHERE id=$1 AND tenant_id=$2", [id, tenantId, status, result]);
}
/** MINIATURA-CONGELADA-1 · guarda la miniatura congelada en tags.thumb SIN tocar el resto de la fila
 *  (ni estado, ni fecha, ni el resto de tags). Solo si el negocio es el dueño del post. */
export async function dbCongelarMiniatura(id: string, tenantId: string, thumb: string): Promise<void> {
  if (!pool) {
    const cur = mem.scheduledPosts.get(id);
    if (cur && (cur.tenant_id || "default") === tenantId) cur.tags = { ...(cur.tags || {}), thumb };
    return;
  }
  await pool.query(
    `UPDATE app_scheduled_posts SET tags = tags || jsonb_build_object('thumb', $3::text) WHERE id=$1 AND tenant_id=$2`,
    [id, tenantId, thumb],
  );
}
/** Devuelve si borró algo: un id que no existe (o de otro negocio) no es un «ok». */
export async function dbDeleteScheduledPost(id: string): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const p = mem.scheduledPosts.get(id);
    if (!p || (p.tenant_id || "default") !== tenantId) return false;
    return mem.scheduledPosts.delete(id);
  }
  const r = await pool.query("DELETE FROM app_scheduled_posts WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
  return !!r.rowCount;
}
// PROG-CAL-1 · arrastrar una publicación a otro día desde el calendario del Programador.
// Sólo se mueve una PENDIENTE (o un BORRADOR, BORRADOR-1) y bajo bloqueo de fila: el scheduler la reclama con
// FOR UPDATE SKIP LOCKED y la pasa a 'sending'; si ya la cogió, esto relee 'sending' y
// no toca nada (un upsert ciego la devolvía a 'pending' y salía dos veces).
// Con `platforms` (parte de sus redes) se PARTE en la misma transacción: esas redes se
// van a una fila nueva con la fecha nueva y el resto se queda donde estaba — ninguna
// red puede quedar publicada dos veces ni perderse.
export type SchedMoveResult = { ok: true; id: string } | { ok: false; error: string };
export async function dbMoveScheduledPost(id: string, at: number, platforms: string[] | null, newId: string): Promise<SchedMoveResult> {
  const tenantId = currentWorkspaceId();
  const NO_EXISTE = "esa publicación no existe";
  const NO_PEND = "esa publicación ya no está pendiente: se está publicando o ya salió";
  const NO_RED = "esa red no está en la publicación";
  if (!pool) {
    const p = mem.scheduledPosts.get(id);
    if (!p || (p.tenant_id || "default") !== tenantId) return { ok: false, error: NO_EXISTE };
    if (p.status !== "pending" && p.status !== "draft") return { ok: false, error: NO_PEND };
    const cur = p.platforms && p.platforms.length ? p.platforms : ["instagram"];
    const sub = platforms ? cur.filter((x) => platforms.indexOf(x) >= 0) : cur;
    if (!sub.length) return { ok: false, error: NO_RED };
    if (sub.length === cur.length) { p.scheduled_at = at; return { ok: true, id }; }
    p.platforms = cur.filter((x) => sub.indexOf(x) < 0);
    mem.scheduledPosts.set(newId, { ...p, id: newId, platforms: sub, scheduled_at: at, status: p.status, result: "", tags: { ...(p.tags || {}) } });
    return { ok: true, id: newId };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      "SELECT status, platforms FROM app_scheduled_posts WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [id, tenantId],
    );
    const row = r.rows[0] as { status: string; platforms: unknown } | undefined;
    if (!row) { await client.query("ROLLBACK"); return { ok: false, error: NO_EXISTE }; }
    if (row.status !== "pending" && row.status !== "draft") { await client.query("ROLLBACK"); return { ok: false, error: NO_PEND }; }
    const cur = rowToSched({ platforms: row.platforms }).platforms;
    const sub = platforms ? cur.filter((x) => platforms.indexOf(x) >= 0) : cur;
    if (!sub.length) { await client.query("ROLLBACK"); return { ok: false, error: NO_RED }; }
    if (sub.length === cur.length) {
      await client.query(
        "UPDATE app_scheduled_posts SET scheduled_at=to_timestamp($3/1000.0) WHERE id=$1 AND tenant_id=$2",
        [id, tenantId, at],
      );
      await client.query("COMMIT");
      return { ok: true, id };
    }
    const rest = cur.filter((x) => sub.indexOf(x) < 0);
    await client.query(
      "UPDATE app_scheduled_posts SET platforms=$3::jsonb WHERE id=$1 AND tenant_id=$2",
      [id, tenantId, JSON.stringify(rest)],
    );
    await client.query(
      `INSERT INTO app_scheduled_posts (id,ig_id,kind,media_url,caption,scheduled_at,status,result,platforms,tags,up_account_id,tenant_id)
       SELECT $1,ig_id,kind,media_url,caption,to_timestamp($4/1000.0),status,'',$5::jsonb,tags,up_account_id,tenant_id
         FROM app_scheduled_posts WHERE id=$2 AND tenant_id=$3`,
      [newId, id, tenantId, at, JSON.stringify(sub)],
    );
    await client.query("COMMIT");
    return { ok: true, id: newId };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}
// ============================================================
// WS-ARCHIVED 2026-08-07 · archivar un workspace tiene que PARAR su trabajo.
// Antes, "archivar" solo lo escondía del selector: sus posts programados,
// difusiones y jobs de flujo seguían saliendo a nombre del negocio archivado.
// Los dos helpers de abajo se aplican en el CLAIM (no después): un trabajo de
// un tenant archivado ni se reclama ni se marca — se queda 'pending'/'queued'
// y revive intacto si el workspace se desarchiva.
// Fail-open deliberado: si el tenant no existe en app_workspaces (fila
// huérfana, 'default', mem-mode sin seed) NO se bloquea nada.
// ============================================================
function wsNotArchivedSql(tenantCol: string): string {
  return `NOT EXISTS (SELECT 1 FROM app_workspaces w_arch WHERE w_arch.id = ${tenantCol} AND w_arch.archived = true)`;
}
function memTenantArchived(tenantId: string | null | undefined): boolean {
  const id = (tenantId || "default").trim() || "default";
  if (id === "default") return false;
  const w = mem.workspaces.get(id);
  return !!w && !!w.archived;
}
// T04 · un post reclamado ('sending') cuyo proceso murió antes de cerrar estado
// quedaba 'sending' para siempre (el claim solo relee 'pending') y la UI lo
// enseñaba como pendiente eterno. Barrido: sending con >30 min desde su hora
// programada → 'error' con motivo explícito. Un publish legítimo (incluido el
// processing de un Reel largo) no vive tanto en 'sending'.
export async function dbSweepStuckSendingPosts(): Promise<number> {
  const cutoff = Date.now() - 30 * 60_000;
  const msg = "Interrumpida: el servidor se reinició mientras se publicaba. Puede haberse publicado en alguna red — compruébalo antes de reintentar.";
  if (!pool) {
    let n = 0;
    for (const p of mem.scheduledPosts.values()) {
      if (p.status === "sending" && p.scheduled_at <= cutoff) { p.status = "error"; p.result = msg; n++; }
    }
    return n;
  }
  const r = await pool.query(
    `UPDATE app_scheduled_posts SET status='error', result=$1
      WHERE status='sending' AND scheduled_at <= to_timestamp($2/1000.0)`,
    [msg, cutoff],
  );
  return r.rowCount || 0;
}
export async function dbDueScheduledPosts(): Promise<ScheduledPost[]> {
  if (!pool) {
    // PROG-EDIT-1 · el mismo claim que en Postgres: pasa a 'sending' y devuelve una copia.
    const due = [...mem.scheduledPosts.values()].filter(
      (x) =>
        x.status === "pending" &&
        x.scheduled_at <= Date.now() &&
        !memTenantArchived(x.tenant_id),
    ).sort((a, b) => a.scheduled_at - b.scheduled_at).slice(0, 10);
    for (const x of due) x.status = "sending";
    return due.map((x) => ({ ...x, platforms: [...(x.platforms || [])], tags: { ...(x.tags || {}) } }));
  }
  // Claim ATÓMICO: flip 'pending'→'sending' con FOR UPDATE SKIP LOCKED para que,
  // con varias réplicas, cada post lo procese UNA sola (evita doble publicación).
  // El filtro de workspace archivado va DENTRO del SELECT del claim: así el post
  // sigue 'pending' (no queda colgado en 'sending') hasta que se desarchive.
  const r = await pool.query(
    `UPDATE app_scheduled_posts SET status='sending'
       WHERE id IN (
         SELECT id FROM app_scheduled_posts
          WHERE status='pending' AND scheduled_at<=now()
            AND ${wsNotArchivedSql("app_scheduled_posts.tenant_id")}
         ORDER BY scheduled_at LIMIT 10 FOR UPDATE SKIP LOCKED
       )
     RETURNING id,ig_id,kind,media_url,caption, extract(epoch from scheduled_at)*1000 scheduled_at, status,result,platforms,tags,up_account_id,tenant_id`,
  );
  return r.rows.map(rowToSched);
}

/**
 * REEL-PRUEBA-2 · instantes (epoch ms, ascendente) de los reels de prueba que YA salieron en Instagram
 * para esa cuenta desde `sinceMs`. Meta limita cuántos reels de prueba admite la API por cuenta en
 * 24 h (subcode 2207078): con esto el scheduler sabe cuándo toca esperar.
 */
export async function dbReelsPruebaRecientes(tenantId: string, igId: string, sinceMs: number): Promise<number[]> {
  const okIg = (p: ScheduledPost): boolean => /"platform":"instagram","ok":true/.test(p.result || "");
  if (!pool) {
    return [...mem.scheduledPosts.values()]
      .filter((p) => (p.tenant_id || "default") === tenantId && (p.ig_id || "") === (igId || "") &&
        (p.status === "published" || p.status === "partial") && !!p.tags?.igTrial &&
        (p.platforms || []).indexOf("instagram") >= 0 && p.scheduled_at >= sinceMs && okIg(p))
      .map((p) => p.scheduled_at).sort((a, b) => a - b);
  }
  const r = await pool.query(
    `SELECT extract(epoch from scheduled_at)*1000 AS t FROM app_scheduled_posts
      WHERE tenant_id=$1 AND ig_id=$2 AND status IN ('published','partial')
        AND tags ? 'igTrial' AND platforms ? 'instagram'
        AND result LIKE '%"platform":"instagram","ok":true%'
        AND scheduled_at >= to_timestamp($3/1000.0)
      ORDER BY scheduled_at ASC`,
    [tenantId, igId || "", sinceMs],
  );
  return r.rows.map((x: { t: string | number }) => Number(x.t));
}
/**
 * REEL-PRUEBA-2 · devuelve a 'pending' (con otra hora) un post que el scheduler acababa de reclamar
 * ('sending') y NO ha publicado. Sólo toca estado, hora, motivo y el contador de aplazamientos.
 */
export async function dbAplazarPost(id: string, tenantId: string, nuevaHoraMs: number, motivo: string, aplazos: number): Promise<boolean> {
  if (!pool) {
    const cur = mem.scheduledPosts.get(id);
    if (!cur || (cur.tenant_id || "default") !== tenantId || cur.status !== "sending") return false;
    cur.status = "pending"; cur.scheduled_at = nuevaHoraMs; cur.result = motivo;
    cur.tags = { ...(cur.tags || {}), igTrialAplazos: aplazos };
    return true;
  }
  const r = await pool.query(
    `UPDATE app_scheduled_posts
        SET status='pending', scheduled_at=to_timestamp($3/1000.0), result=$4,
            tags = tags || jsonb_build_object('igTrialAplazos', $5::int)
      WHERE id=$1 AND tenant_id=$2 AND status='sending'`,
    [id, tenantId, nuevaHoraMs, motivo.slice(0, 300), aplazos],
  );
  return (r.rowCount || 0) > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// NEWSLETTER-1 · Boletines. Mismo molde que los posts programados: lectura
// acotada al workspace activo por ALS, escritura con upsert idempotente, y un
// claim ATÓMICO para el latido (dos réplicas jamás envían el mismo boletín).
// ════════════════════════════════════════════════════════════════════════════
const NL_COLS =
  "id,tenant_id,account_id,sio_id,subject,preview_text,body_html,sender_name,sender_email," +
  "prompt,include_tags,exclude_tags,contacts,bridge_tag,status," +
  "extract(epoch from scheduled_at)*1000 scheduled_at, extract(epoch from sent_at)*1000 sent_at," +
  "recipients,result,routine_id,mailing_id,created_by, extract(epoch from created_at)*1000 created_at," +
  "extract(epoch from updated_at)*1000 updated_at";

/** Las columnas JSONB vuelven como array ya parseado o como texto según el driver. */
function nlArr(v: unknown): string[] {
  try {
    const x = typeof v === "string" ? JSON.parse(v) : v;
    return Array.isArray(x) ? x.map((s) => String(s)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function rowToNewsletter(r: Record<string, unknown>): NewsletterRec {
  const st = String(r.status || "draft");
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id || "default"),
    account_id: String(r.account_id || ""),
    sio_id: Number(r.sio_id) || 0,
    subject: String(r.subject ?? ""),
    preview_text: String(r.preview_text ?? ""),
    body_html: String(r.body_html ?? ""),
    sender_name: String(r.sender_name ?? ""),
    sender_email: String(r.sender_email ?? ""),
    prompt: String(r.prompt ?? ""),
    include_tags: nlArr(r.include_tags),
    exclude_tags: nlArr(r.exclude_tags),
    contacts: nlArr(r.contacts),
    bridge_tag: String(r.bridge_tag ?? ""),
    status: (["draft", "scheduled", "sending", "sent", "error", "cancelled"].includes(st)
      ? st
      : "draft") as NewsletterRec["status"],
    scheduled_at: r.scheduled_at != null ? Number(r.scheduled_at) : null,
    sent_at: r.sent_at != null ? Number(r.sent_at) : null,
    recipients: Number(r.recipients) || 0,
    result: String(r.result ?? ""),
    routine_id: String(r.routine_id ?? ""),
    mailing_id: Number(r.mailing_id) || 0,
    created_by: String(r.created_by ?? ""),
    created_at: Number(r.created_at) || 0,
    updated_at: Number(r.updated_at) || 0,
  };
}

export async function dbListNewsletters(opts?: { tenantId?: string; allTenants?: boolean }): Promise<NewsletterRec[]> {
  const tenantId = opts?.tenantId ?? (opts?.allTenants ? undefined : currentWorkspaceId());
  if (!pool) {
    let rows = [...mem.newsletters.values()];
    if (tenantId) rows = rows.filter((n) => (n.tenant_id || "default") === tenantId);
    return rows.slice().sort((a, b) => b.created_at - a.created_at);
  }
  const params: unknown[] = [];
  let where = "";
  if (tenantId) { params.push(tenantId); where = ` WHERE tenant_id=$${params.length}`; }
  const r = await pool.query(`SELECT ${NL_COLS} FROM app_newsletters${where} ORDER BY created_at DESC`, params);
  return r.rows.map(rowToNewsletter);
}

/** Una ficha, SIEMPRE acotada al workspace activo: sin el filtro, un id adivinado
 *  de otro negocio devolvería su boletín entero (cuerpo y destinatarios incluidos). */
export async function dbGetNewsletter(id: string): Promise<NewsletterRec | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const n = mem.newsletters.get(id);
    return n && (n.tenant_id || "default") === tenantId ? n : null;
  }
  const r = await pool.query(`SELECT ${NL_COLS} FROM app_newsletters WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  return r.rows.length ? rowToNewsletter(r.rows[0]) : null;
}

export async function dbUpsertNewsletter(n: NewsletterRec): Promise<void> {
  const tenantId = n.tenant_id || currentWorkspaceId();
  const ahora = Date.now();
  if (!pool) {
    mem.newsletters.set(n.id, { ...n, tenant_id: tenantId, updated_at: ahora });
    return;
  }
  await pool.query(
    `INSERT INTO app_newsletters
       (id,tenant_id,account_id,sio_id,subject,preview_text,body_html,sender_name,sender_email,
        prompt,include_tags,exclude_tags,contacts,bridge_tag,status,scheduled_at,sent_at,
        recipients,result,created_by,routine_id,mailing_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,
             CASE WHEN $16::double precision IS NULL THEN NULL ELSE to_timestamp($16/1000.0) END,
             CASE WHEN $17::double precision IS NULL THEN NULL ELSE to_timestamp($17/1000.0) END,
             $18,$19,$20,$21,$22,to_timestamp($23/1000.0),to_timestamp($24/1000.0))
     ON CONFLICT (id) DO UPDATE SET
       account_id=$3,sio_id=$4,subject=$5,preview_text=$6,body_html=$7,sender_name=$8,sender_email=$9,
       prompt=$10,include_tags=$11::jsonb,exclude_tags=$12::jsonb,contacts=$13::jsonb,bridge_tag=$14,
       status=$15,
       scheduled_at=CASE WHEN $16::double precision IS NULL THEN NULL ELSE to_timestamp($16/1000.0) END,
       sent_at=CASE WHEN $17::double precision IS NULL THEN NULL ELSE to_timestamp($17/1000.0) END,
       recipients=$18,result=$19,routine_id=$21,mailing_id=$22,updated_at=to_timestamp($24/1000.0)`,
    [
      n.id, tenantId, n.account_id || "", n.sio_id || 0, n.subject || "", n.preview_text || "",
      n.body_html || "", n.sender_name || "", n.sender_email || "", n.prompt || "",
      JSON.stringify(n.include_tags || []), JSON.stringify(n.exclude_tags || []),
      JSON.stringify(n.contacts || []), n.bridge_tag || "", n.status || "draft",
      n.scheduled_at ?? null, n.sent_at ?? null, n.recipients || 0, (n.result || "").slice(0, 1500),
      n.created_by || "", n.routine_id || "", n.mailing_id || 0, n.created_at || ahora, ahora,
    ],
  );
}

export async function dbDeleteNewsletter(id: string): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const n = mem.newsletters.get(id);
    if (n && (n.tenant_id || "default") === tenantId) mem.newsletters.delete(id);
    return;
  }
  await pool.query("DELETE FROM app_newsletters WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
}

/**
 * Boletines que TOCA revisar: programados cuya hora ya pasó. Envía la WEB (es
 * su reloj el que dispara), así que esto no es un envío: es la RECONCILIACIÓN
 * —preguntarle a la web si ya salió— y la red de seguridad para el caso en que
 * la programación remota no llegara a cuajar.
 *
 * Claim atómico 'scheduled'→'sending' con FOR UPDATE SKIP LOCKED: con varias
 * réplicas, cada boletín lo mira UNA sola. El filtro de workspace archivado va
 * DENTRO del SELECT para que el boletín de un negocio archivado se quede
 * 'scheduled' intacto en vez de colgarse en 'sending'.
 */
export async function dbClaimDueNewsletters(): Promise<NewsletterRec[]> {
  if (!pool) {
    const due = [...mem.newsletters.values()].filter(
      (n) => n.status === "scheduled" && n.scheduled_at != null && n.scheduled_at <= Date.now() && !memTenantArchived(n.tenant_id),
    );
    for (const n of due) mem.newsletters.set(n.id, { ...n, status: "sending" });
    return due.map((n) => ({ ...n, status: "sending" as const }));
  }
  const r = await pool.query(
    `UPDATE app_newsletters SET status='sending', updated_at=now()
       WHERE id IN (
         SELECT id FROM app_newsletters
          WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at<=now()
            AND ${wsNotArchivedSql("app_newsletters.tenant_id")}
          ORDER BY scheduled_at LIMIT 10 FOR UPDATE SKIP LOCKED
       )
     RETURNING ${NL_COLS}`,
  );
  return r.rows.map(rowToNewsletter);
}

/**
 * Un boletín reclamado cuyo proceso murió antes de cerrar estado se quedaría en
 * 'sending' para siempre (el claim solo relee 'scheduled') y la vista lo
 * enseñaría «enviándose» eternamente. A los 30 min de su hora, se cierra como
 * error con motivo visible. NO se reintenta el envío: reintentar a ciegas un
 * boletín que quizá ya salió es duplicarlo en la bandeja de todo el mundo.
 */
export async function dbSweepStuckNewsletters(): Promise<number> {
  // El corte va por updated_at, NO por scheduled_at: un boletín enviado a mano
  // no tiene hora programada, y filtrando por ella se quedaba «Enviando» para
  // siempre — sin poder reenviarlo, editarlo ni borrarlo, porque los tres
  // caminos responden 409 mientras está en ese estado. Toda entrada en
  // 'sending' escribe updated_at (el claim del latido y dbUpsertNewsletter),
  // así que la antigüedad se cuenta desde que empezó el envío de verdad, no
  // desde la hora a la que estaba previsto.
  const ahora = Date.now();
  if (!pool) {
    let n = 0;
    for (const x of mem.newsletters.values()) {
      if (x.status === "sending" && (x.updated_at || 0) < ahora - 30 * 60 * 1000) {
        mem.newsletters.set(x.id, { ...x, status: "error", result: "Se interrumpió a mitad de envío: comprueba en tu web si llegó a salir antes de volver a enviarlo.", updated_at: ahora });
        n++;
      }
    }
    return n;
  }
  const r = await pool.query(
    `UPDATE app_newsletters SET status='error',
       result='Se interrumpió a mitad de envío: comprueba en tu web si llegó a salir antes de volver a enviarlo.',
       updated_at=now()
     WHERE status='sending' AND updated_at < now() - interval '30 minutes'`,
  );
  return r.rowCount || 0;
}

// ---- NEWSLETTER-RUTINA-1 · rutinas de correo ----

const NLR_COLS =
  "id,tenant_id,account_id,name,prompt,sender_name,sender_email," +
  "include_tags,exclude_tags,contacts,freq,weekdays,monthday,at_hour,at_min,tz,ai_model,signature,active," +
  "extract(epoch from next_run_at)*1000 next_run_at, extract(epoch from last_run_at)*1000 last_run_at," +
  "runs,last_result,created_by, extract(epoch from created_at)*1000 created_at," +
  "extract(epoch from updated_at)*1000 updated_at";

/** Los días de la semana llegan como JSONB; se saneen a 0..6 sin repetidos. */
function nlrDias(x: unknown): number[] {
  const crudo = typeof x === "string" ? (() => { try { return JSON.parse(x); } catch { return []; } })() : x;
  if (!Array.isArray(crudo)) return [];
  const vistos = new Set<number>();
  for (const v of crudo) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n <= 6) vistos.add(n);
  }
  return [...vistos].sort((a, b) => a - b);
}

/** FIRMA-2 · la firma llega como JSONB; sin «despedida» guardada (rutinas de antes) vale «Un abrazo,». */
function nlrFirma(x: unknown): NewsletterRoutineRec["signature"] {
  const o = (typeof x === "string" ? (() => { try { return JSON.parse(x); } catch { return {}; } })() : x) as Record<string, unknown> | null;
  const f = o && typeof o === "object" ? o : {};
  return {
    despedida: f.despedida === undefined ? "Un abrazo," : String(f.despedida ?? "").slice(0, 60),
    cargo: String(f.cargo ?? "").slice(0, 120),
    web: String(f.web ?? "").slice(0, 200),
  };
}

function rowToRoutine(r: Record<string, unknown>): NewsletterRoutineRec {
  const f = String(r.freq || "weekly");
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id || "default"),
    account_id: String(r.account_id || ""),
    name: String(r.name ?? ""),
    prompt: String(r.prompt ?? ""),
    sender_name: String(r.sender_name ?? ""),
    sender_email: String(r.sender_email ?? ""),
    include_tags: nlArr(r.include_tags),
    exclude_tags: nlArr(r.exclude_tags),
    contacts: nlArr(r.contacts),
    freq: (["daily", "weekly", "monthly"].includes(f) ? f : "weekly") as NewsletterRoutineRec["freq"],
    weekdays: nlrDias(r.weekdays),
    monthday: Math.min(28, Math.max(1, Number(r.monthday) || 1)),
    at_hour: Math.min(23, Math.max(0, Number(r.at_hour) || 0)),
    at_min: Math.min(59, Math.max(0, Number(r.at_min) || 0)),
    tz: String(r.tz || "Europe/Madrid"),
    ai_model: String(r.ai_model ?? ""),
    signature: nlrFirma(r.signature),
    active: r.active === true || r.active === "t" || r.active === 1,
    next_run_at: r.next_run_at != null ? Number(r.next_run_at) : null,
    last_run_at: r.last_run_at != null ? Number(r.last_run_at) : null,
    runs: Number(r.runs) || 0,
    last_result: String(r.last_result ?? ""),
    created_by: String(r.created_by ?? ""),
    created_at: Number(r.created_at) || 0,
    updated_at: Number(r.updated_at) || 0,
  };
}

export async function dbListNewsletterRoutines(opts?: { tenantId?: string; allTenants?: boolean }): Promise<NewsletterRoutineRec[]> {
  const tenantId = opts?.tenantId ?? (opts?.allTenants ? undefined : currentWorkspaceId());
  if (!pool) {
    let rows = [...mem.newsletterRoutines.values()];
    if (tenantId) rows = rows.filter((x) => (x.tenant_id || "default") === tenantId);
    return rows.slice().sort((a, b) => b.created_at - a.created_at);
  }
  const params: unknown[] = [];
  let where = "";
  if (tenantId) { params.push(tenantId); where = ` WHERE tenant_id=$${params.length}`; }
  const r = await pool.query(`SELECT ${NLR_COLS} FROM app_newsletter_routines${where} ORDER BY created_at DESC`, params);
  return r.rows.map(rowToRoutine);
}

export async function dbGetNewsletterRoutine(id: string): Promise<NewsletterRoutineRec | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const x = mem.newsletterRoutines.get(id);
    return x && (x.tenant_id || "default") === tenantId ? x : null;
  }
  const r = await pool.query(`SELECT ${NLR_COLS} FROM app_newsletter_routines WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  return r.rows.length ? rowToRoutine(r.rows[0]) : null;
}

export async function dbUpsertNewsletterRoutine(x: NewsletterRoutineRec): Promise<void> {
  const tenantId = x.tenant_id || currentWorkspaceId();
  const ahora = Date.now();
  if (!pool) {
    mem.newsletterRoutines.set(x.id, { ...x, tenant_id: tenantId, updated_at: ahora });
    return;
  }
  await pool.query(
    `INSERT INTO app_newsletter_routines
       (id,tenant_id,account_id,name,prompt,sender_name,sender_email,
        include_tags,exclude_tags,contacts,freq,weekdays,monthday,at_hour,at_min,tz,active,
        next_run_at,last_run_at,runs,last_result,created_by,created_at,updated_at,ai_model,signature)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14,$15,$16,$17,
             CASE WHEN $18::double precision IS NULL THEN NULL ELSE to_timestamp($18/1000.0) END,
             CASE WHEN $19::double precision IS NULL THEN NULL ELSE to_timestamp($19/1000.0) END,
             $20,$21,$22,to_timestamp($23/1000.0),to_timestamp($24/1000.0),$25,$26::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       account_id=$3,name=$4,prompt=$5,sender_name=$6,sender_email=$7,
       include_tags=$8::jsonb,exclude_tags=$9::jsonb,contacts=$10::jsonb,
       freq=$11,weekdays=$12::jsonb,monthday=$13,at_hour=$14,at_min=$15,tz=$16,active=$17,
       next_run_at=CASE WHEN $18::double precision IS NULL THEN NULL ELSE to_timestamp($18/1000.0) END,
       last_run_at=CASE WHEN $19::double precision IS NULL THEN NULL ELSE to_timestamp($19/1000.0) END,
       runs=$20,last_result=$21,ai_model=$25,signature=$26::jsonb,updated_at=to_timestamp($24/1000.0)
     WHERE app_newsletter_routines.tenant_id=EXCLUDED.tenant_id`,
    [
      x.id, tenantId, x.account_id || "", (x.name || "").slice(0, 200), x.prompt || "",
      x.sender_name || "", x.sender_email || "",
      JSON.stringify(x.include_tags || []), JSON.stringify(x.exclude_tags || []),
      JSON.stringify(x.contacts || []), x.freq || "weekly", JSON.stringify(x.weekdays || []),
      x.monthday || 1, x.at_hour || 0, x.at_min || 0, x.tz || "Europe/Madrid", !!x.active,
      x.next_run_at ?? null, x.last_run_at ?? null, x.runs || 0,
      (x.last_result || "").slice(0, 1000), x.created_by || "", x.created_at || ahora, ahora,
      x.ai_model || "",
      JSON.stringify(x.signature || {}),
    ],
  );
}

/** Cierra una ejecución sin restaurar una configuración antigua ni recrear una rutina borrada. */
export async function dbFinishNewsletterRoutine(
  id: string,
  result: { at: number; message: string; expectedNext: number | null; next: number | null; manual: boolean },
): Promise<void> {
  const tenant = currentWorkspaceId();
  const message = result.message.slice(0, 1000);
  if (!pool) {
    const r = mem.newsletterRoutines.get(id);
    if (!r || (r.tenant_id || "default") !== tenant) return;
    const latest = (r.last_run_at || 0) <= result.at;
    mem.newsletterRoutines.set(id, {
      ...r, runs: (r.runs || 0) + 1,
      last_run_at: latest ? result.at : r.last_run_at,
      last_result: latest ? message : r.last_result,
      next_run_at: !result.manual && r.active && r.next_run_at === result.expectedNext ? result.next : r.next_run_at,
      updated_at: Date.now(),
    });
    return;
  }
  await pool.query(
    `UPDATE app_newsletter_routines SET
       runs = runs + 1,
       last_result = CASE WHEN last_run_at IS NULL OR last_run_at <= to_timestamp($3/1000.0) THEN $4 ELSE last_result END,
       last_run_at = GREATEST(last_run_at, to_timestamp($3/1000.0)),
       next_run_at = CASE WHEN NOT $7::boolean AND active
         AND next_run_at IS NOT DISTINCT FROM to_timestamp($5::double precision/1000.0)
         THEN to_timestamp($6::double precision/1000.0) ELSE next_run_at END,
       updated_at = now()
     WHERE id=$1 AND tenant_id=$2`,
    [id, tenant, result.at, message, result.expectedNext, result.next, result.manual],
  );
}

export async function dbDeleteNewsletterRoutine(id: string): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const x = mem.newsletterRoutines.get(id);
    if (x && (x.tenant_id || "default") === tenantId) mem.newsletterRoutines.delete(id);
    return;
  }
  await pool.query("DELETE FROM app_newsletter_routines WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
}

/**
 * Rutinas a las que les ha llegado la hora.
 *
 * El claim NO marca un estado aparte (no hay 'ejecutándose'): empuja
 * next_run_at diez minutos por delante mientras devuelve la fila. Así, con
 * varias réplicas, cada rutina la coge UNA sola, y si el proceso muere a
 * mitad la rutina se reintenta en diez minutos en vez de quedarse colgada o
 * de dispararse en bucle. Al terminar, el motor recalcula next_run_at a la
 * ocurrencia de verdad y ese margen desaparece.
 *
 * El filtro de workspace archivado va DENTRO del SELECT: la rutina de un
 * negocio archivado se queda quieta con su hora intacta, no se consume.
 */
export async function dbClaimDueNewsletterRoutines(): Promise<NewsletterRoutineRec[]> {
  const ahora = Date.now();
  const margen = 10 * 60 * 1000;
  if (!pool) {
    const due = [...mem.newsletterRoutines.values()].filter(
      (x) => x.active && x.next_run_at != null && x.next_run_at <= ahora && !memTenantArchived(x.tenant_id),
    );
    // Devolver la fila reclamada, igual que UPDATE ... RETURNING en PostgreSQL.
    return due.map((x) => {
      const claimed = { ...x, next_run_at: ahora + margen, updated_at: ahora };
      mem.newsletterRoutines.set(x.id, claimed);
      return { ...claimed };
    });
  }
  const r = await pool.query(
    `UPDATE app_newsletter_routines SET next_run_at=now() + interval '10 minutes', updated_at=now()
       WHERE id IN (
         SELECT id FROM app_newsletter_routines
          WHERE active AND next_run_at IS NOT NULL AND next_run_at<=now()
            AND ${wsNotArchivedSql("app_newsletter_routines.tenant_id")}
          ORDER BY next_run_at LIMIT 10 FOR UPDATE SKIP LOCKED
       )
     RETURNING ${NLR_COLS}`,
  );
  return r.rows.map(rowToRoutine);
}

/** Los envíos que ha hecho una rutina, paginados: el historial de su ficha. */
export async function dbListNewslettersDeRutina(
  routineId: string,
  limit = 20,
  offset = 0,
): Promise<{ items: NewsletterRec[]; total: number }> {
  const tenantId = currentWorkspaceId();
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const off = Math.max(0, Number(offset) || 0);
  if (!pool) {
    const todas = [...mem.newsletters.values()]
      .filter((n) => (n.tenant_id || "default") === tenantId && n.routine_id === routineId)
      .sort((a, b) => b.created_at - a.created_at);
    return { items: todas.slice(off, off + lim), total: todas.length };
  }
  const [pag, cnt] = await Promise.all([
    pool.query(
      `SELECT ${NL_COLS} FROM app_newsletters WHERE tenant_id=$1 AND routine_id=$2
         ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [tenantId, routineId, lim, off],
    ),
    pool.query("SELECT count(*)::int n FROM app_newsletters WHERE tenant_id=$1 AND routine_id=$2", [tenantId, routineId]),
  ]);
  return { items: pag.rows.map(rowToNewsletter), total: Number(cnt.rows[0]?.n) || 0 };
}
// ---- Difusiones (historial + métricas + programadas) ----
function rowToBroadcast(r: any): BroadcastRec {
  let segment: BroadcastRec["segment"] = {};
  let buttons: string[] = [];
  try { segment = typeof r.segment === "string" ? JSON.parse(r.segment) : (r.segment || {}); } catch { /* ignore */ }
  try { buttons = typeof r.buttons === "string" ? JSON.parse(r.buttons) : (r.buttons || []); } catch { /* ignore */ }
  return {
    id: r.id, created_at: Number(r.created_at), text: r.text ?? "", segment, buttons,
    recipients: Number(r.recipients ?? 0), sent: Number(r.sent ?? 0),
    failed: Number(r.failed ?? 0), out_window: Number(r.out_window ?? 0),
    image_url: r.image_url ?? "", status: r.status ?? "sent",
    scheduled_at: r.scheduled_at != null ? Number(r.scheduled_at) : null,
    tenant_id: r.tenant_id || "default",
    sender_pid: r.sender_pid ?? "", block_reason: r.block_reason ?? "",
    pace_seconds: Number(r.pace_seconds ?? 0) || 0,
    // DIFUSION-MARCA-1 · el plan solo viene en las consultas que lo piden (es grande: hasta
    // 500 destinatarios); el listado del panel no lo trae.
    ...(r.plan !== undefined ? { plan: planDe(r.plan) } : {}),
    heartbeat_at: r.heartbeat_at != null ? Number(r.heartbeat_at) : null,
    resumed: Number(r.resumed ?? 0) || 0,
    // DIFUSION-RECORTE-1 · va en BROADCAST_COLS: si faltara en el SELECT, el panel lo
    // leería como false/0 SOLO contra Postgres (en memoria se devuelve el objeto entero).
    seg_truncated: !!r.seg_truncated,
    seg_total: Number(r.seg_total ?? 0) || 0,
  };
}
function planDe(v: unknown): BroadcastPlan {
  try { const p = typeof v === "string" ? JSON.parse(v) : v; return p && typeof p === "object" ? (p as BroadcastPlan) : {}; } catch { return {}; }
}
// DIFUSION-MARCA-1 · UNA lista de columnas para las cuatro consultas: cada vez que una columna
// nueva faltó en un SELECT/RETURNING el panel la leyó como 0 SOLO en producción (en memoria
// se devuelve el objeto entero). El plan va aparte porque el listado no debe traerlo.
const BROADCAST_COLS = `id,text,segment,buttons,recipients,sent,failed,out_window,image_url,status,pace_seconds, extract(epoch from scheduled_at)*1000 scheduled_at, extract(epoch from created_at)*1000 created_at,tenant_id,sender_pid,block_reason, extract(epoch from heartbeat_at)*1000 heartbeat_at, resumed, seg_truncated, seg_total`;
// DIFUSION-DETALLE-1 · impacto por destinatario. El alta es best-effort a propósito:
// informar del detalle jamás tumba (ni frena) el envío real.
export interface BroadcastHit {
  phone: string; name: string; ok: boolean; error: string; at: number; mid?: string;
  // RESULTADO-DIFUSION-1 · lo que hizo después (ver dbBroadcastMarcarRespuesta).
  resp_seg?: boolean; replied_at?: number; button_at?: number; button_text?: string;
}
export async function dbAddBroadcastHit(broadcastId: string, h: { phone: string; name?: string; ok: boolean; error?: string; mid?: string }): Promise<void> {
  try {
    const tenantId = currentWorkspaceId();
    if (!pool) {
      const arr = mem.broadcastHits.get(broadcastId) || [];
      arr.push({ phone: h.phone, name: h.name || "", ok: !!h.ok, error: String(h.error || "").slice(0, 300), at: Date.now(), mid: String(h.mid || ""), resp_seg: true });
      if (arr.length > 5000) arr.shift();
      mem.broadcastHits.set(broadcastId, arr);
      return;
    }
    await pool.query(
      `INSERT INTO app_broadcast_hits (broadcast_id,phone,name,ok,error,tenant_id,mid,resp_seg) VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
      [broadcastId, h.phone, h.name || "", !!h.ok, String(h.error || "").slice(0, 300), tenantId, String(h.mid || "").slice(0, 200)],
    );
  } catch { /* best-effort */ }
}
export async function dbListBroadcastHits(broadcastId: string, limit = 3000): Promise<BroadcastHit[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) return (mem.broadcastHits.get(broadcastId) || []).slice(0, limit);
  // «at» es palabra clave de Postgres (AT TIME ZONE): como alias pelado rompía el SELECT
  // con 42601 «syntax error at or near FROM» — SOLO en producción (en memoria no hay SQL).
  // Siempre AS y la columna entrecomillada.
  const r = await pool.query(
    `SELECT phone,name,ok,error,mid,extract(epoch from "at")*1000 AS at,
            resp_seg, extract(epoch from replied_at)*1000 AS replied_at,
            extract(epoch from button_at)*1000 AS button_at, button_text
       FROM app_broadcast_hits
     WHERE tenant_id=$1 AND broadcast_id=$2 ORDER BY "at" ASC LIMIT $3`,
    [tenantId, broadcastId, limit],
  );
  return r.rows.map((x: any) => ({ phone: x.phone, name: x.name || "", ok: !!x.ok, error: x.error || "", at: Number(x.at) || 0, mid: x.mid || "",
    resp_seg: !!x.resp_seg, replied_at: Number(x.replied_at) || 0, button_at: Number(x.button_at) || 0, button_text: x.button_text || "" }));
}
/** RESULTADO-DIFUSION-1 · apunta una respuesta de WhatsApp a la difusión que la provocó.
 *  - Si el mensaje cita a otro (un botón de plantilla SIEMPRE lo hace, y una respuesta
 *    citando también), se casa con ESE envío por su id: exacto. Si cita algo que no es una
 *    difusión, no cuenta para ninguna.
 *  - Si no cita nada, cuenta para la difusión más reciente que esa persona recibió desde
 *    el mismo número en las 72 h anteriores. Una sola: nunca suma en dos campañas.
 *  Solo la primera respuesta y el primer botón de cada persona: son personas, no mensajes. */
export const RESPUESTA_VENTANA_MS = 72 * 3600_000;
export async function dbBroadcastMarcarRespuesta(pid: string, phone: string, opts: { citaId?: string; boton?: string } = {}): Promise<boolean> {
  try {
    const tenantId = currentWorkspaceId();
    const dig = String(phone || "").replace(/\D/g, "");
    if (!dig) return false;
    const cita = String(opts.citaId || "").trim();
    const boton = String(opts.boton || "").trim().slice(0, 120);
    const pidS = String(pid || "");
    if (!pool) {
      const ahora = Date.now();
      let mejor: BroadcastHit | null = null;
      for (const b of mem.broadcasts) {
        if ((b.tenant_id || "default") !== tenantId) continue;
        if (!cita && pidS && b.sender_pid && b.sender_pid !== pidS) continue;
        for (const h of mem.broadcastHits.get(b.id) || []) {
          if (!h.ok || !h.resp_seg || String(h.phone).replace(/\D/g, "") !== dig) continue;
          if (cita ? h.mid !== cita : ahora - h.at > RESPUESTA_VENTANA_MS) continue;
          if (!mejor || h.at > mejor.at) mejor = h;
        }
      }
      if (!mejor) return false;
      if (!mejor.replied_at) mejor.replied_at = ahora;
      if (boton && !mejor.button_at) { mejor.button_at = ahora; mejor.button_text = boton; }
      return true;
    }
    const r = await pool.query(
      `WITH h AS (
         SELECT h.ctid AS c FROM app_broadcast_hits h
           JOIN app_broadcasts b ON b.id=h.broadcast_id AND b.tenant_id=h.tenant_id
          WHERE h.tenant_id=$1 AND h.ok AND h.resp_seg AND h.phone = ANY($2::text[])
            AND ( ($3<>'' AND h.mid=$3)
               OR ($3='' AND h."at" > now() - make_interval(secs => $5::int)
                   AND ($4='' OR b.sender_pid='' OR b.sender_pid=$4)) )
          ORDER BY h."at" DESC LIMIT 1)
       UPDATE app_broadcast_hits t
          SET replied_at = COALESCE(t.replied_at, now()),
              button_text = CASE WHEN $6<>'' AND t.button_at IS NULL THEN $6 ELSE t.button_text END,
              button_at = CASE WHEN $6<>'' THEN COALESCE(t.button_at, now()) ELSE t.button_at END
         FROM h WHERE t.ctid = h.c`,
      [tenantId, [dig, "+" + dig], cita, pidS, Math.round(RESPUESTA_VENTANA_MS / 1000), boton],
    );
    return (r.rowCount || 0) > 0;
  } catch { return false; }
}
/** RESULTADO-DIFUSION-1 · lo que pasó DESPUÉS de cada difusión, por personas (no mensajes):
 *  - respondieron / boton: ver dbBroadcastMarcarRespuesta. respSeg = personas con ese
 *    seguimiento (0 → la vista pone «—», no «0»).
 *  - enlace: personas que abrieron un enlace de ESTA difusión (cada enlace lleva su id).
 *    llevaEnlace=false → la difusión no llevaba enlaces y no aplica.
 *  - compradores: compras con enlace de pago del panel en los 7 días siguientes, y cada
 *    compra cuenta para la ÚLTIMA difusión que esa persona recibió antes de pagar: una
 *    venta nunca suma en dos campañas. Las de la web (systeme.io) no traen teléfono.
 *  En modo memoria enlaces y compras viven en otro módulo: quedan null (sin medir).
 *  DIVISA-1 · `importe`/`moneda` solo se rellenan cuando todas las compras son de UNA moneda
 *  (con dos quedaban null y ese dinero no salía en ningún total). `ingresos` lleva siempre el
 *  importe de cada moneda, de mayor a menor, para que el panel las sume al cambio del día;
 *  null = sin medir, [] = medido y sin importe. */
export const COMPRA_VENTANA_MS = 7 * 86400_000;
export interface BroadcastResultado {
  personas: number; mensajes: number; plantilla: string; respSeg: number; respondieron: number; boton: number;
  botones: Array<{ t: string; n: number }>; llevaEnlace: boolean | null; enlace: number | null; clics: number | null;
  compradores: number | null; importe: number | null; moneda: string;
  ingresos: Array<{ moneda: string; importe: number }> | null;
}
export async function dbDifusionesResultado(ids: string[]): Promise<Record<string, BroadcastResultado>> {
  const lista = [...new Set(ids.map((x) => String(x || "")).filter(Boolean))].slice(0, 500);
  const out: Record<string, BroadcastResultado> = {};
  if (!lista.length) return out;
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const propias = new Set(mem.broadcasts.filter((b) => (b.tenant_id || "default") === tenantId).map((b) => b.id));
    for (const id of lista) {
      if (!propias.has(id)) continue;
      const hs = mem.broadcastHits.get(id) || [];
      if (!hs.length) continue;
      const per = new Set<string>(), seg = new Set<string>(), resp = new Set<string>(), bot = new Set<string>();
      const botones: Record<string, Set<string>> = {};
      const tpl: Record<string, number> = {};
      for (const h of hs) {
        const k = String(h.phone).replace(/\D/g, "");
        per.add(k);
        if (h.ok && h.resp_seg) seg.add(k);
        if (h.replied_at) resp.add(k);
        if (h.button_at) { bot.add(k); (botones[h.button_text || ""] ||= new Set()).add(k); }
        const t = h.mid ? mem.waMessageStatuses.get(`${tenantId}|${h.mid}`)?.template_name : "";
        if (t) tpl[t] = (tpl[t] || 0) + 1;
      }
      out[id] = { personas: per.size, mensajes: hs.length, plantilla: Object.keys(tpl).sort((a, b) => tpl[b] - tpl[a])[0] || "",
        respSeg: seg.size, respondieron: resp.size, boton: bot.size,
        botones: Object.keys(botones).map((t) => ({ t, n: botones[t].size })).sort((a, b) => b.n - a.n),
        llevaEnlace: null, enlace: null, clics: null, compradores: null, importe: null, moneda: "", ingresos: null };
    }
    return out;
  }
  const r = await pool.query(
    `SELECT h.broadcast_id,
            count(DISTINCT h.phone)::int AS personas, count(*)::int AS mensajes,
            count(DISTINCT h.phone) FILTER (WHERE h.ok AND h.resp_seg)::int AS resp_seg,
            count(DISTINCT h.phone) FILTER (WHERE h.replied_at IS NOT NULL)::int AS respondieron,
            count(DISTINCT h.phone) FILTER (WHERE h.button_at IS NOT NULL)::int AS boton,
            mode() WITHIN GROUP (ORDER BY e.template_name) AS plantilla,
            extract(epoch from min(h."at"))*1000 AS desde
       FROM app_broadcast_hits h
       LEFT JOIN app_wa_events e ON h.mid<>'' AND e.tenant_id=h.tenant_id AND e.message_id=h.mid
                                AND e.message_id IS NOT NULL AND e.message_id<>''
      WHERE h.tenant_id=$1 AND h.broadcast_id = ANY($2::text[])
      GROUP BY h.broadcast_id`,
    [tenantId, lista],
  );
  let desde = Infinity;
  for (const x of r.rows) {
    out[String(x.broadcast_id)] = { personas: x.personas, mensajes: x.mensajes, plantilla: x.plantilla || "", respSeg: x.resp_seg,
      respondieron: x.respondieron, boton: x.boton, botones: [], llevaEnlace: false, enlace: 0, clics: 0, compradores: 0, importe: 0, moneda: "", ingresos: [] };
    const t = Number(x.desde);
    if (t && t < desde) desde = t;
  }
  const conHits = Object.keys(out);
  if (!conHits.length) return out;
  const [rb, rl, rc] = await Promise.all([
    pool.query(
      `SELECT broadcast_id, button_text, count(DISTINCT phone)::int AS n FROM app_broadcast_hits
        WHERE tenant_id=$1 AND broadcast_id = ANY($2::text[]) AND button_at IS NOT NULL
        GROUP BY 1,2 ORDER BY 3 DESC`, [tenantId, conHits]),
    pool.query(
      `SELECT sl.context_id AS id, count(DISTINCT sl.token)::int AS enlaces, count(c.id)::int AS clics,
              count(DISTINCT regexp_replace(c.phone,'[^0-9]','','g')) FILTER (WHERE c.phone<>'')::int AS personas
         FROM app_short_links sl LEFT JOIN app_link_clicks c ON c.token=sl.token
        WHERE sl.tenant_id=$1 AND sl.context_kind='broadcast' AND sl.context_id = ANY($2::text[])
        GROUP BY 1`, [tenantId, conHits]),
    pool.query(
      // DIVISA-1 · `m` reparte el mismo conjunto de compras (`x`, ya acotado por tenant) moneda a moneda.
      `WITH x AS (SELECT * FROM (SELECT (COALESCE(p.amount,0) - LEAST(COALESCE(p.amount,0), COALESCE(p.refunded_amount,0))) amount, p.currency, d.dig,
                      (SELECT h.broadcast_id FROM app_broadcast_hits h
                        WHERE h.tenant_id=p.tenant_id AND h.ok AND h.phone = ANY(ARRAY[d.dig, '+' || d.dig])
                          AND h."at" <= p.created_at AND h."at" > p.created_at - make_interval(secs => $4::int)
                        ORDER BY h."at" DESC LIMIT 1) AS broadcast_id
                 FROM app_purchases p
                 CROSS JOIN LATERAL (SELECT regexp_replace(p.phone,'[^0-9]','','g') AS dig) d
                WHERE NOT (p.refunded_amount IS NOT NULL AND p.refunded_amount >= p.amount) AND p.tenant_id=$1 AND p.phone<>'' AND p.created_at >= to_timestamp($3::bigint/1000.0)) c
        WHERE c.broadcast_id = ANY($2::text[]))
       SELECT a.broadcast_id, a.compradores, a.importe, a.monedas, a.moneda, m.ingresos
         FROM (SELECT broadcast_id, count(DISTINCT dig)::int AS compradores, COALESCE(sum(amount),0)::float AS importe,
                      count(DISTINCT currency)::int AS monedas, min(currency) AS moneda
                 FROM x GROUP BY 1) a
         LEFT JOIN (SELECT g.broadcast_id, json_agg(json_build_object('moneda', g.currency, 'importe', g.importe) ORDER BY g.importe DESC, g.currency) AS ingresos
                      FROM (SELECT broadcast_id, currency, round(sum(amount), 2)::float AS importe FROM x GROUP BY 1, 2) g
                     WHERE g.importe <> 0 GROUP BY 1) m ON m.broadcast_id = a.broadcast_id`, [tenantId, conHits, Number.isFinite(desde) ? Math.floor(desde) : Date.now(), Math.round(COMPRA_VENTANA_MS / 1000)]),
  ]);
  for (const x of rb.rows) out[String(x.broadcast_id)]?.botones.push({ t: x.button_text || "", n: x.n });
  for (const x of rl.rows) {
    const o = out[String(x.id)];
    if (o) { o.llevaEnlace = x.enlaces > 0; o.enlace = x.personas; o.clics = x.clics; }
  }
  for (const x of rc.rows) {
    const o = out[String(x.broadcast_id)];
    if (o) { o.compradores = x.compradores; o.importe = x.monedas === 1 ? Math.round(x.importe * 100) / 100 : null; o.moneda = x.monedas === 1 ? x.moneda || "" : "";
      o.ingresos = Array.isArray(x.ingresos) ? (x.ingresos as Array<{ moneda: unknown; importe: unknown }>).map((i) => ({ moneda: String(i.moneda || ""), importe: Number(i.importe) || 0 })) : []; }
  }
  return out;
}
/** ENTREGA-WA-1 · lo que WhatsApp confirmó de cada difusión, cruzando cada envío (su id de
 *  mensaje) con el estado que llegó por webhook. Por difusión, nunca por plantilla: dos
 *  difusiones con la misma plantilla no se mezclan. «pendientes» = aceptados sin
 *  confirmación todavía: NO son fallos. «sinSeguimiento» = aceptados sin id guardado
 *  (envíos anteriores a esta mejora). */
export interface BroadcastEntrega { hits: number; rechazados: number; conSeguimiento: number; entregados: number; leidos: number; fallidos: number; pendientes: number; sinSeguimiento: number }
export async function dbBroadcastsEntrega(ids: string[]): Promise<Record<string, BroadcastEntrega>> {
  const lista = [...new Set(ids.map((x) => String(x || "")).filter(Boolean))].slice(0, 500);
  const out: Record<string, BroadcastEntrega> = {};
  if (!lista.length) return out;
  const tenantId = currentWorkspaceId();
  const vacio = (): BroadcastEntrega => ({ hits: 0, rechazados: 0, conSeguimiento: 0, entregados: 0, leidos: 0, fallidos: 0, pendientes: 0, sinSeguimiento: 0 });
  if (!pool) {
    // En memoria los envíos van por id de difusión, sin workspace: solo las del workspace activo.
    const propias = new Set(mem.broadcasts.filter((b) => (b.tenant_id || "default") === tenantId).map((b) => b.id));
    for (const id of lista) {
      if (!propias.has(id)) continue;
      const e = vacio();
      for (const h of mem.broadcastHits.get(id) || []) {
        e.hits++;
        if (!h.ok) { e.rechazados++; continue; }
        if (!h.mid) { e.sinSeguimiento++; continue; }
        e.conSeguimiento++;
        const st = mem.waMessageStatuses.get(`${tenantId}|${h.mid}`)?.status;
        if (st === "delivered" || st === "read") e.entregados++;
        if (st === "read") e.leidos++;
        if (st === "failed") e.fallidos++;
      }
      e.pendientes = e.conSeguimiento - e.entregados - e.fallidos;
      if (e.hits) out[id] = e;
    }
    return out;
  }
  const r = await pool.query(
    `SELECT h.broadcast_id,
            count(*)::int AS hits,
            count(*) FILTER (WHERE NOT h.ok)::int AS rechazados,
            count(*) FILTER (WHERE h.ok AND h.mid<>'')::int AS con_seg,
            count(*) FILTER (WHERE h.ok AND h.mid='')::int AS sin_seg,
            count(*) FILTER (WHERE h.ok AND e.status IN ('delivered','read'))::int AS entregados,
            count(*) FILTER (WHERE h.ok AND e.status='read')::int AS leidos,
            count(*) FILTER (WHERE h.ok AND e.status='failed')::int AS fallidos
       FROM app_broadcast_hits h
       LEFT JOIN app_wa_events e ON h.mid<>'' AND e.tenant_id=h.tenant_id AND e.message_id=h.mid
                                AND e.message_id IS NOT NULL AND e.message_id<>''
      WHERE h.tenant_id=$1 AND h.broadcast_id = ANY($2::text[])
      GROUP BY h.broadcast_id`,
    [tenantId, lista],
  );
  for (const x of r.rows) {
    const e: BroadcastEntrega = { hits: x.hits, rechazados: x.rechazados, conSeguimiento: x.con_seg, entregados: x.entregados, leidos: x.leidos, fallidos: x.fallidos, pendientes: 0, sinSeguimiento: x.sin_seg };
    e.pendientes = Math.max(0, e.conSeguimiento - e.entregados - e.fallidos);
    out[String(x.broadcast_id)] = e;
  }
  return out;
}
/** ENTREGA-WA-1 · difusiones del rango con fallos de entrega COMPROBADOS: al menos uno y
 *  al menos el 10 % de los resueltos (entregados + fallos). Los pendientes no cuentan:
 *  un mensaje sin confirmar todavía no es un fallo. «fallos» suma lo que WhatsApp rechazó
 *  al enviar y lo que aceptó pero luego no pudo entregar. */
export async function dbEntregaAlertas(sinceMs: number, untilMs: number, pids?: string[]): Promise<Array<{ id: string; text: string; at: number; fallos: number; resueltos: number; entregados: number; pendientes: number }>> {
  const filtro = new Set((pids || []).filter(Boolean));
  const bcs = (await dbListBroadcasts(500)).filter((b) =>
    b.created_at >= sinceMs && b.created_at <= untilMs && (!filtro.size || filtro.has(String(b.sender_pid || ""))));
  if (!bcs.length) return [];
  const ent = await dbBroadcastsEntrega(bcs.map((b) => b.id));
  const out: Array<{ id: string; text: string; at: number; fallos: number; resueltos: number; entregados: number; pendientes: number }> = [];
  for (const b of bcs) {
    const e = ent[b.id];
    if (!e) continue;
    const fallos = e.rechazados + e.fallidos;
    const resueltos = e.entregados + fallos;
    if (fallos >= 1 && fallos / resueltos >= 0.1)
      out.push({ id: b.id, text: String(b.text || "").replace(/\s+/g, " ").trim().slice(0, 80), at: b.created_at, fallos, resueltos, entregados: e.entregados, pendientes: e.pendientes });
  }
  return out.sort((a, b) => b.fallos / b.resueltos - a.fallos / a.resueltos || b.fallos - a.fallos);
}
/** RESULTADO-DIFUSION-1 (MET-WA-03) · cada difusión del rango como campaña propia, aunque
 *  repita plantilla: su entrega (ENTREGA-WA-1) y lo que pasó después (dbDifusionesResultado).
 *  Solo las que ya salieron (con envíos registrados). La fecha es la de salida. */
export interface DifusionFila {
  id: string; text: string; at: number; sender_pid: string; plantilla: string;
  personas: number; mensajes: number; aceptados: number; entregados: number; conSeg: number;
  respSeg: number; respondieron: number; boton: number; llevaEnlace: boolean | null; enlace: number | null;
  clics: number | null; compradores: number | null; importe: number | null; moneda: string;
  /** DIVISA-1 · el importe de las compras en cada moneda (ver BroadcastResultado.ingresos). */
  ingresos: Array<{ moneda: string; importe: number }> | null;
}
export async function dbDifusionesRanking(sinceMs: number, untilMs: number, pids?: string[]): Promise<DifusionFila[]> {
  const filtro = new Set((pids || []).filter(Boolean));
  const salida = (b: BroadcastRec): number => Number(b.scheduled_at) || b.created_at;
  // CAMPANAS-RANGO-1 · filtrar antes de leer las filas: las 500 más recientes
  // podían ocultar por completo un periodo anterior con difusiones reales.
  const tenantId = currentWorkspaceId();
  const bcs: BroadcastRec[] = pool
    ? (await pool.query(`SELECT ${BROADCAST_COLS} FROM app_broadcasts
        WHERE tenant_id=$1 AND COALESCE(scheduled_at,created_at) >= to_timestamp($2::double precision/1000)
        AND COALESCE(scheduled_at,created_at) <= to_timestamp($3::double precision/1000)
        AND (cardinality($4::text[])=0 OR sender_pid=ANY($4::text[]))
        ORDER BY COALESCE(scheduled_at,created_at) DESC`, [tenantId, sinceMs, untilMs, [...filtro]])).rows.map(rowToBroadcast)
    : mem.broadcasts.filter(b => (b.tenant_id || "default") === tenantId &&
        salida(b) >= sinceMs && salida(b) <= untilMs && (!filtro.size || filtro.has(String(b.sender_pid || ""))));
  if (!bcs.length) return [];
  const ids = bcs.map((b) => b.id);
  const ent: Record<string, BroadcastEntrega> = {}, res: Record<string, BroadcastResultado> = {};
  // Los agregadores admiten 500 identificadores por consulta. Procesar todos los
  // lotes mantiene las cifras completas sin hacer consultas por cada difusión.
  for (let inicio = 0; inicio < ids.length; inicio += 500) {
    const lote = ids.slice(inicio, inicio + 500);
    const [e, r] = await Promise.all([dbBroadcastsEntrega(lote), dbDifusionesResultado(lote)]);
    Object.assign(ent, e); Object.assign(res, r);
  }
  const out: DifusionFila[] = [];
  for (const b of bcs) {
    const e = ent[b.id];
    const r = res[b.id];
    if (!e || !r) continue;
    out.push({
      id: b.id, text: String(b.text || "").replace(/\s+/g, " ").trim().slice(0, 90), at: salida(b), sender_pid: String(b.sender_pid || ""),
      plantilla: r.plantilla, personas: r.personas, mensajes: r.mensajes, aceptados: e.hits - e.rechazados, entregados: e.entregados,
      conSeg: e.conSeguimiento, respSeg: r.respSeg, respondieron: r.respondieron, boton: r.boton, llevaEnlace: r.llevaEnlace,
      enlace: r.enlace, clics: r.clics, compradores: r.compradores, importe: r.importe, moneda: r.moneda, ingresos: r.ingresos,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}
export async function dbSaveBroadcast(b: BroadcastRec): Promise<void> {
  const tenantId = b.tenant_id || currentWorkspaceId();
  if (!pool) {
    mem.broadcasts.unshift({ ...b, tenant_id: tenantId });
    if (mem.broadcasts.length > 200) mem.broadcasts.pop();
    return;
  }
  await pool.query(
    // RITMO-DIFUSION-1 · $11 va SIEMPRE referenciado (0 → NULL vía CASE): con la rama
    // "NULL" de antes, Postgres rechazaba el INSERT entero por no poder inferir el tipo
    // del parámetro sin usar (42P18) — SOLO en producción, porque los arneses corren en
    // modo memoria. Por eso el historial jamás registró difusiones sin fecha programada.
    // DIFUSION-MARCA-1 · $17 plan, $18 latido (mismo patrón CASE que $11: 0 → NULL, y el
    // parámetro SIEMPRE referenciado), $19 veces retomada.
    // DIFUSION-RECORTE-1 · $20 recorte del segmento, $21 total real que cumplía el filtro.
    `INSERT INTO app_broadcasts (id,text,segment,buttons,recipients,sent,failed,out_window,image_url,status,scheduled_at,created_at,tenant_id,sender_pid,block_reason,pace_seconds,plan,heartbeat_at,resumed,seg_truncated,seg_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $11::bigint > 0 THEN to_timestamp($11::bigint/1000.0) ELSE NULL END,to_timestamp($12/1000.0),$13,$14,$15,$16,$17::jsonb,CASE WHEN $18::bigint > 0 THEN to_timestamp($18::bigint/1000.0) ELSE NULL END,$19,$20,$21)`,
    [b.id, b.text, JSON.stringify(b.segment || {}), JSON.stringify(b.buttons || []), b.recipients, b.sent, b.failed, b.out_window,
     b.image_url || "", b.status || "sent", b.scheduled_at || 0, b.created_at, tenantId, b.sender_pid || "", b.block_reason || "",
     Math.max(0, Math.round(Number(b.pace_seconds) || 0)), JSON.stringify(b.plan || {}), Number(b.heartbeat_at) || 0, Math.max(0, Math.round(Number(b.resumed) || 0)),
     !!b.seg_truncated, Math.max(0, Math.round(Number(b.seg_total) || 0))],
  );
}
export async function dbListBroadcasts(limit = 50, opts?: { tenantId?: string; allTenants?: boolean }): Promise<BroadcastRec[]> {
  // WS-ISOLATION 2026-06-04: default a workspace activo si no se pasa.
  const tenantId = opts?.tenantId ?? (opts?.allTenants ? undefined : currentWorkspaceId());
  if (!pool) {
    let rows = mem.broadcasts.slice();
    if (tenantId) rows = rows.filter((b) => (b.tenant_id || "default") === tenantId);
    return rows.slice(0, limit);
  }
  const params: unknown[] = [];
  let where = "";
  if (tenantId) { params.push(tenantId); where = ` WHERE tenant_id=$${params.length}`; }
  params.push(limit);
  // RITMO-DIFUSION-1 · `pace_seconds` va en el SELECT. Faltaba, y rowToBroadcast lo leia
  // igualmente -> llegaba 0 SIEMPRE. Con eso el panel no podia decir "uno cada 10 minutos"
  // y estimaba lo pendiente a 0,7 s por mensaje: con 50 en cola decia "quedan ~35 s"
  // cuando la verdad eran 8 horas. En memoria no se veia (ahi se devuelve el objeto
  // entero); fallaba solo contra Postgres, o sea solo en produccion.
  const r = await pool.query(
    `SELECT ${BROADCAST_COLS} FROM app_broadcasts${where} ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(rowToBroadcast);
}
/** DIFUSION-MARCA-1 · UNA difusión del workspace activo, con su plan. Es lo que relee el
 *  motor antes de cada envío (¿la anularon?) en vez de traerse las 500 últimas filas. */
export async function dbGetBroadcast(id: string): Promise<BroadcastRec | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const b = mem.broadcasts.find((x) => x.id === id && (x.tenant_id || "default") === tenantId);
    return b ? { ...b } : null;
  }
  const r = await pool.query(`SELECT ${BROADCAST_COLS}, plan FROM app_broadcasts WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  return r.rowCount ? rowToBroadcast(r.rows[0]) : null;
}
/** BORRAR-ENLACE-1 · de estos ids, cuáles son difusiones que SIGUEN existiendo en el workspace
 *  activo. Una sola consulta para toda la lista de Enlaces: un enlace de una difusión viva no se
 *  puede eliminar (sus clics cuentan en ella), el de una difusión ya borrada sí. */
export async function dbBroadcastsExistentes(ids: string[]): Promise<Set<string>> {
  const tenantId = currentWorkspaceId();
  const pedidos = [...new Set(ids.map((x) => String(x || "")).filter(Boolean))];
  if (!pedidos.length) return new Set();
  if (!pool) {
    const quiero = new Set(pedidos);
    return new Set(mem.broadcasts.filter((x) => quiero.has(x.id) && (x.tenant_id || "default") === tenantId).map((x) => x.id));
  }
  const r = await pool.query(`SELECT id FROM app_broadcasts WHERE tenant_id=$1 AND id = ANY($2::text[])`, [tenantId, pedidos]);
  return new Set(r.rows.map((x: { id: string }) => String(x.id)));
}
/** ENL-03-USO-1 · de estos ids de difusión, el principio de su texto y su fecha (la programada si
 *  la tiene; si no, la de creación). Con eso la lista de Enlaces dice QUÉ difusión usa cada enlace
 *  en vez de un «Difusión» a secas. Solo las del workspace activo; las borradas no salen. */
export async function dbBroadcastsResumen(ids: string[]): Promise<Record<string, { texto: string; at: number }>> {
  const tenantId = currentWorkspaceId();
  const pedidos = [...new Set(ids.map((x) => String(x || "")).filter(Boolean))];
  const out: Record<string, { texto: string; at: number }> = {};
  if (!pedidos.length) return out;
  if (!pool) {
    const quiero = new Set(pedidos);
    for (const b of mem.broadcasts) {
      if (!quiero.has(b.id) || (b.tenant_id || "default") !== tenantId) continue;
      out[b.id] = { texto: String(b.text || "").slice(0, 160), at: Number(b.scheduled_at || b.created_at) || 0 };
    }
    return out;
  }
  const r = await pool.query(
    `SELECT id, LEFT(text, 160) texto, extract(epoch from COALESCE(scheduled_at, created_at))*1000 at
       FROM app_broadcasts WHERE tenant_id=$1 AND id = ANY($2::text[])`,
    [tenantId, pedidos],
  );
  for (const x of r.rows) out[String(x.id)] = { texto: String(x.texto || ""), at: Number(x.at) || 0 };
  return out;
}
/** DIFUSION-MARCA-1 · difusiones HUÉRFANAS: en 'sending' pero sin latido desde hace más de
 *  `staleMs` (el proceso que las enviaba murió). Claim ATÓMICO igual que dbDueBroadcasts:
 *  se les renueva el latido y se cuenta la reanudación en la misma sentencia, así ninguna
 *  otra réplica (ni el siguiente tick) la coge a la vez. `excluir` = las que ESTE proceso
 *  tiene vivas ahora mismo (un latido atrasado por una llamada lenta a Meta no debe hacer
 *  que se relance dentro del mismo proceso). Sin acotar por tenant a propósito: es una
 *  tarea de sistema; cada fila trae su tenant_id y el motor la ejecuta bajo él. */
export async function dbClaimOrphanBroadcasts(staleMs: number, excluir: string[] = []): Promise<BroadcastRec[]> {
  const corte = Date.now() - staleMs;
  if (!pool) {
    const out: BroadcastRec[] = [];
    for (const b of mem.broadcasts) {
      if (b.status !== "sending" || excluir.includes(b.id) || memTenantArchived(b.tenant_id)) continue;
      if ((b.heartbeat_at || 0) >= corte) continue;
      b.heartbeat_at = Date.now();
      b.resumed = (b.resumed || 0) + 1;
      out.push({ ...b });
      if (out.length >= 5) break;
    }
    return out;
  }
  const r = await pool.query(
    `UPDATE app_broadcasts SET heartbeat_at=now(), resumed=resumed+1
       WHERE id IN (
         SELECT id FROM app_broadcasts
          WHERE status='sending'
            AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $1::double precision))
            AND NOT (id = ANY($2::text[]))
            AND ${wsNotArchivedSql("app_broadcasts.tenant_id")}
          ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED
       )
     RETURNING ${BROADCAST_COLS}, plan`,
    [Math.max(1, staleMs) / 1000, excluir],
  );
  return r.rows.map(rowToBroadcast);
}
/** Difusiones programadas que ya toca enviar. */
export async function dbDueBroadcasts(): Promise<BroadcastRec[]> {
  if (!pool) return mem.broadcasts.filter((b) => b.status === "scheduled" && (b.scheduled_at || 0) <= Date.now() && !memTenantArchived(b.tenant_id));
  // Claim ATÓMICO: flip 'scheduled'→'sending' con FOR UPDATE SKIP LOCKED → cada
  // difusión la procesa UNA sola réplica (evita doble envío). runDueBroadcasts ya
  // cierra a 'sent'/'error', así que no quedan filas colgadas.
  // WS-ARCHIVED: un negocio archivado no envía difusiones; la fila se queda
  // 'scheduled' y se enviará si se desarchiva (no se pierde ni se marca error).
  // DIFUSION-MARCA-1 · el claim también arranca el latido: sin él, el tick siguiente la
  // vería como huérfana (latido NULL) y la relanzaría encima.
  // RITMO-DIFUSION-1 · el RETURNING trae pace_seconds (va dentro de BROADCAST_COLS): sin él
  // runDueBroadcasts recibía 0 y el motor caía a 700 ms, así que toda difusión PROGRAMADA
  // salía a ritmo máximo aunque el dueño hubiera elegido uno cada 10 minutos — justo el
  // rate-limit de WhatsApp que el ritmo existe para evitar.
  // SQL-COMENTARIO-1 · este comentario vive FUERA de la plantilla a propósito. Estas cuatro
  // líneas estaban DENTRO del literal, así que viajaban a Postgres como parte de la consulta:
  // «syntax error at or near "//"» en CADA tick del scheduler (1.384 errores en 24 h el
  // 3-sep-2026) y ni una sola difusión programada salió mientras duró. No se reproduce en
  // local: sin DATABASE_URL esta rama ni se ejecuta. Lo vigila check-sql-comentarios.mjs.
  const r = await pool.query(
    `UPDATE app_broadcasts SET status='sending', heartbeat_at=now()
       WHERE id IN (
         SELECT id FROM app_broadcasts
          WHERE status='scheduled' AND scheduled_at<=now()
            AND ${wsNotArchivedSql("app_broadcasts.tenant_id")}
         ORDER BY scheduled_at LIMIT 5 FOR UPDATE SKIP LOCKED
       )
     RETURNING ${BROADCAST_COLS}, plan`,
  );
  return r.rows.map(rowToBroadcast);
}
/** Actualiza estado/métricas de una difusión (programada → enviada, etc.). */
export async function dbUpdateBroadcast(id: string, f: Partial<BroadcastRec>): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const b = mem.broadcasts.find((x) => x.id === id && (x.tenant_id || "default") === tenantId);
    if (b) Object.assign(b, f);
    return;
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  // DIFUSION-RECORTE-1 · seg_truncated/seg_total entran aquí porque una difusión
  // PROGRAMADA no conoce su segmento hasta que sale: el motor los escribe al resolverlo.
  for (const k of ["status", "sent", "failed", "recipients", "out_window", "sender_pid", "block_reason", "resumed", "seg_truncated", "seg_total"] as const) {
    if (f[k] !== undefined) { args.push(f[k]); sets.push(`${k}=$${args.length}`); }
  }
  // DIFUSION-MARCA-1 · latido (ms → timestamptz; 0 = NULL) y plan (jsonb).
  if (f.heartbeat_at !== undefined) {
    args.push(Number(f.heartbeat_at) || 0);
    sets.push(`heartbeat_at=CASE WHEN $${args.length}::bigint > 0 THEN to_timestamp($${args.length}::bigint/1000.0) ELSE NULL END`);
  }
  if (f.plan !== undefined) { args.push(JSON.stringify(f.plan || {})); sets.push(`plan=$${args.length}::jsonb`); }
  if (!sets.length) return;
  args.push(id);
  args.push(tenantId);
  await pool.query(`UPDATE app_broadcasts SET ${sets.join(",")} WHERE id=$${args.length - 1} AND tenant_id=$${args.length}`, args);
}
/** ETIQUETA-USO-1 · ETQ-05 · Cambia el segmento de una difusión que SIGUE programada (el
 *  segmento se resuelve al salir, así que renombrar una etiqueta sin tocarlo la dejaría
 *  enviando a otra gente). El `status='scheduled'` del WHERE es la barrera: si el motor ya
 *  la reclamó ('sending'), no se toca. Devuelve si escribió. */
export async function dbSetSegmentoDifusionProgramada(id: string, segment: Record<string, unknown>): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const b = mem.broadcasts.find((x) => x.id === id && (x.tenant_id || "default") === tenantId && x.status === "scheduled");
    if (!b) return false;
    b.segment = segment as BroadcastRec["segment"];
    return true;
  }
  const r = await pool.query(
    "UPDATE app_broadcasts SET segment=$1::jsonb WHERE id=$2 AND tenant_id=$3 AND status='scheduled'",
    [JSON.stringify(segment), id, tenantId],
  );
  return Number(r.rowCount ?? 0) > 0;
}
// HISTORIAL-DIFUSION-1 · Los estados «vivos» no se borran nunca desde el historial.
const BROADCAST_VIVA = new Set(["scheduled", "sending", "queued", "running"]);
/** Borra UNA difusión terminada y su detalle uno a uno (acotado por tenant).
 *  motivo: "no-existe" | "viva". */
export async function dbDeleteBroadcast(id: string): Promise<{ ok: boolean; motivo?: string; hits: number }> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const i = mem.broadcasts.findIndex((x) => x.id === id && (x.tenant_id || "default") === tenantId);
    if (i < 0) return { ok: false, motivo: "no-existe", hits: 0 };
    if (BROADCAST_VIVA.has(String(mem.broadcasts[i].status || "sent"))) return { ok: false, motivo: "viva", hits: 0 };
    const hits = (mem.broadcastHits.get(id) || []).length;
    mem.broadcasts.splice(i, 1);
    mem.broadcastHits.delete(id);
    return { ok: true, hits };
  }
  const cur = await pool.query(`SELECT status FROM app_broadcasts WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  if (!cur.rowCount) return { ok: false, motivo: "no-existe", hits: 0 };
  if (BROADCAST_VIVA.has(String(cur.rows[0].status || "sent"))) return { ok: false, motivo: "viva", hits: 0 };
  const h = await pool.query(`DELETE FROM app_broadcast_hits WHERE broadcast_id=$1 AND tenant_id=$2`, [id, tenantId]);
  await pool.query(`DELETE FROM app_broadcasts WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  return { ok: true, hits: h.rowCount || 0 };
}
/** Vacía el historial TERMINADO del tenant (enviadas, canceladas, bloqueadas, con error),
 *  opcionalmente solo lo más antiguo que N días. Lo vivo se queda siempre. */
export async function dbPurgeBroadcasts(opts: { olderThanDays?: number } = {}): Promise<{ difusiones: number; hits: number }> {
  const tenantId = currentWorkspaceId();
  const dias = Math.max(0, Math.floor(Number(opts.olderThanDays) || 0));
  const limite = dias > 0 ? Date.now() - dias * 86_400_000 : Infinity;
  if (!pool) {
    let difusiones = 0, hits = 0;
    mem.broadcasts = mem.broadcasts.filter((x) => {
      const mia = (x.tenant_id || "default") === tenantId;
      const terminada = !BROADCAST_VIVA.has(String(x.status || "sent"));
      const vieja = (x.created_at || 0) < limite;
      if (mia && terminada && vieja) { difusiones++; hits += (mem.broadcastHits.get(x.id) || []).length; mem.broadcastHits.delete(x.id); return false; }
      return true;
    });
    return { difusiones, hits };
  }
  const cond = dias > 0 ? `AND created_at < now() - ($2 || ' days')::interval` : ``;
  const args: unknown[] = dias > 0 ? [tenantId, String(dias)] : [tenantId];
  const h = await pool.query(
    `DELETE FROM app_broadcast_hits WHERE tenant_id=$1 AND broadcast_id IN (SELECT id FROM app_broadcasts WHERE tenant_id=$1 AND status NOT IN ('scheduled','sending','queued','running') ${cond})`,
    args,
  );
  const d = await pool.query(`DELETE FROM app_broadcasts WHERE tenant_id=$1 AND status NOT IN ('scheduled','sending','queued','running') ${cond}`, args);
  return { difusiones: d.rowCount || 0, hits: h.rowCount || 0 };
}

// ---- Lead jobs (buscador de leads) ----
function rowToLeadJob(r: any): LeadJob {
  return {
    id: r.id, niche: r.niche ?? "", city: r.city ?? "",
    status: r.status ?? "queued", area: r.area ?? "",
    total: Number(r.total ?? 0), scraped: Number(r.scraped ?? 0),
    with_email: Number(r.with_email ?? 0),
    results: Array.isArray(r.results) ? r.results : [],
    error: r.error ?? "", created_at: Number(r.created_at),
    tenant_id: r.tenant_id || "default",
  };
}
export async function dbSaveLeadJob(j: LeadJob, tenantId?: string): Promise<void> {
  // SEC-1bis: tenant_id propagation. Si el caller no lo pasa explicito,
  // resolvemos en orden: j.tenant_id → currentWorkspaceId() (ALS) → 'default'.
  // Asi los 8 leadfinder modules (leadfinder, competitor, github, hashtag-ig,
  // ig-search, twitter, reddit, directorio) heredan tenant via scope sin tocar
  // su firma de llamada.
  const resolvedTenant = tenantId || j.tenant_id || currentWorkspaceId();
  if (!pool) {
    return void mem.leadJobs.set(j.id, { ...j, tenant_id: resolvedTenant });
  }
  await pool.query(
    `INSERT INTO app_lead_jobs (id,niche,city,status,area,total,scraped,with_email,results,error,created_at,tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11/1000.0),$12)
     ON CONFLICT (id) DO UPDATE SET status=$4,area=$5,total=$6,scraped=$7,with_email=$8,results=$9,error=$10`,
    [j.id, j.niche, j.city, j.status, j.area, j.total, j.scraped, j.with_email,
     JSON.stringify(j.results), j.error, j.created_at, resolvedTenant],
  );
}
export async function dbGetLeadJob(id: string): Promise<LeadJob | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const j = mem.leadJobs.get(id);
    if (!j) return null;
    return ((j as unknown as { tenant_id?: string }).tenant_id || "default") === tenantId ? j : null;
  }
  const r = await pool.query(
    "SELECT id,niche,city,status,area,total,scraped,with_email,results,error, extract(epoch from created_at)*1000 created_at,tenant_id FROM app_lead_jobs WHERE id=$1 AND tenant_id=$2",
    [id, tenantId],
  );
  return r.rows[0] ? rowToLeadJob(r.rows[0]) : null;
}
export async function dbListLeadJobs(limit = 30, opts?: { tenantId?: string; allTenants?: boolean }): Promise<LeadJob[]> {
  // WS-ISOLATION 2026-06-04: default a workspace activo si no se pasa.
  const tenantId = opts?.tenantId ?? (opts?.allTenants ? undefined : currentWorkspaceId());
  if (!pool) {
    let rows = [...mem.leadJobs.values()];
    if (tenantId) rows = rows.filter((j) => (((j as unknown as { tenant_id?: string }).tenant_id) || "default") === tenantId);
    return rows.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }
  const params: unknown[] = [];
  let where = "";
  if (tenantId) { params.push(tenantId); where = ` WHERE tenant_id=$${params.length}`; }
  params.push(limit);
  const r = await pool.query(
    `SELECT id,niche,city,status,area,total,scraped,with_email,'[]'::jsonb results,error, extract(epoch from created_at)*1000 created_at,tenant_id FROM app_lead_jobs${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(rowToLeadJob);
}
export async function dbDeleteLeadJob(id: string): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const j = mem.leadJobs.get(id);
    if (j && ((j as unknown as { tenant_id?: string }).tenant_id || "default") === tenantId) mem.leadJobs.delete(id);
    return;
  }
  await pool.query("DELETE FROM app_lead_jobs WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
}

// ---- Autopost (historial de carruseles publicados) ----
export async function dbAddAutopostHistory(h: AutopostHistory): Promise<void> {
  const id = h.id || Math.random().toString(36).slice(2, 12);
  const tenantId = currentWorkspaceId();
  if (!pool) {
    mem.autopostHistory.unshift({ ...h, id, tenant_id: tenantId } as AutopostHistory & { tenant_id: string });
    return;
  }
  await pool.query(
    `INSERT INTO app_autopost_history (id,idea,cta_keyword,caption,platforms,status,created_at,tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),$8)`,
    [id, h.idea, h.cta_keyword, h.caption, JSON.stringify(h.platforms), JSON.stringify(h.status), h.ts, tenantId],
  );
}
export async function dbListAutopostHistory(limit = 20, opts?: { tenantId?: string; allTenants?: boolean }): Promise<AutopostHistory[]> {
  // WS-ISOLATION 2026-06-04: default a workspace activo si no se pasa.
  const tenantId = opts?.tenantId ?? (opts?.allTenants ? undefined : currentWorkspaceId());
  if (!pool) {
    let rows = mem.autopostHistory.slice();
    if (tenantId) rows = rows.filter((h) => (((h as unknown as { tenant_id?: string }).tenant_id) || "default") === tenantId);
    return rows.slice(0, limit);
  }
  // SEC-1: filtro tenant_id en SQL + columna en SELECT para exponer al mapper.
  const params: unknown[] = [];
  let where = "";
  if (tenantId) { params.push(tenantId); where = ` WHERE tenant_id=$${params.length}`; }
  params.push(limit);
  const r = await pool.query(
    `SELECT id,idea,cta_keyword,caption,platforms,status, extract(epoch from created_at)*1000 ts,tenant_id FROM app_autopost_history${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((x: any) => ({
    id: x.id, ts: Number(x.ts), idea: x.idea, cta_keyword: x.cta_keyword,
    caption: x.caption,
    platforms: Array.isArray(x.platforms) ? x.platforms : [],
    status: Array.isArray(x.status) ? x.status : [],
    tenant_id: x.tenant_id || "default",
  }));
}

// FIX id77: total histórico REAL contado en BD — el tile «(histórico)» partía
// de dbListAutopostHistory(100) y nunca podía superar 100.
export async function dbCountAutopostHistory(): Promise<number> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return mem.autopostHistory.filter((h) => (((h as unknown as { tenant_id?: string }).tenant_id) || "default") === tenantId).length;
  }
  const r = await pool.query("SELECT COUNT(*)::int n FROM app_autopost_history WHERE tenant_id=$1", [tenantId]);
  return Number(r.rows[0]?.n) || 0;
}

// FIX id77: filas del RANGO exacto sin el cap 100 (que dejaba fuera intentos
// del rango en cuentas activas). LIMIT 2000 de seguridad.
export async function dbListAutopostHistoryRange(sinceMs: number, untilMs: number): Promise<AutopostHistory[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return mem.autopostHistory
      .filter((h) => (((h as unknown as { tenant_id?: string }).tenant_id) || "default") === tenantId)
      .filter((h) => (h.ts || 0) >= sinceMs && (h.ts || 0) <= untilMs)
      .slice(0, 2000);
  }
  const r = await pool.query(
    `SELECT id,idea,cta_keyword,caption,platforms,status, extract(epoch from created_at)*1000 ts,tenant_id
       FROM app_autopost_history
      WHERE tenant_id=$1 AND created_at BETWEEN to_timestamp($2/1000.0) AND to_timestamp($3/1000.0)
      ORDER BY created_at DESC LIMIT 2000`,
    [tenantId, sinceMs, untilMs],
  );
  return r.rows.map((x: any) => ({
    id: x.id, ts: Number(x.ts), idea: x.idea, cta_keyword: x.cta_keyword,
    caption: x.caption,
    platforms: Array.isArray(x.platforms) ? x.platforms : [],
    status: Array.isArray(x.status) ? x.status : [],
    tenant_id: x.tenant_id || "default",
  }));
}

// ============================================================
// Users (auth multi-user). Para tests sin Postgres (mem fallback),
// guardamos los registros en mem.users (en memoria, sin persistencia).
// ============================================================
export interface AppUser {
  id: string;
  tenant_id: string;
  group_id: string; // Business Group al que pertenece (aislamiento). 'default' = grupo principal.
  email: string;
  name: string;
  role: "admin" | "member";
  active: boolean;
  created_at: string;
  last_login_at: string | null;
  allowed_views: string[] | null; // null ⇒ todas las vistas; [] ⇒ solo dashboard
  session_version: number; // SESION-REVOCABLE-1 · sube al cambiar la contraseña; va en la firma de la cookie
}
export interface AppUserWithHash extends AppUser {
  password_hash: string;
}
const memUsers = new Map<string, AppUserWithHash>();

// Listado por GRUPO (group-admin ve solo su grupo). Bizgroups.
export async function dbListUsersByGroup(groupId = "default"): Promise<AppUser[]> {
  if (!pool) {
    return [...memUsers.values()]
      .filter((u) => (u.group_id || "default") === groupId)
      .map(({ password_hash: _h, ...rest }) => { void _h; return rest; })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  const r = await pool.query(
    "SELECT id, tenant_id, group_id, email, name, role, active, created_at, last_login_at, allowed_views, session_version FROM app_users WHERE group_id=$1 ORDER BY created_at ASC",
    [groupId],
  );
  return r.rows as AppUser[];
}

// Listado GLOBAL (solo super-admin / env). Bizgroups.
export async function dbListAllUsers(): Promise<AppUser[]> {
  if (!pool) {
    return [...memUsers.values()]
      .map(({ password_hash: _h, ...rest }) => { void _h; return rest; })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  const r = await pool.query(
    "SELECT id, tenant_id, group_id, email, name, role, active, created_at, last_login_at, allowed_views, session_version FROM app_users ORDER BY created_at ASC",
  );
  return r.rows as AppUser[];
}

// Retro-compat: listado por tenant (legacy, = 'default'). Conservado para callers antiguos.
export async function dbListUsers(tenantId = "default"): Promise<AppUser[]> {
  if (!pool) {
    return [...memUsers.values()]
      .filter((u) => u.tenant_id === tenantId)
      .map(({ password_hash: _h, ...rest }) => { void _h; return rest; })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  const r = await pool.query(
    "SELECT id, tenant_id, group_id, email, name, role, active, created_at, last_login_at, allowed_views, session_version FROM app_users WHERE tenant_id=$1 ORDER BY created_at ASC",
    [tenantId],
  );
  return r.rows as AppUser[];
}

// Login: resuelve por email CROSS-GROUP (email único global, D14). Determinista.
export async function dbGetUserByEmailGlobal(email: string): Promise<AppUserWithHash | null> {
  const lc = email.trim().toLowerCase();
  if (!pool) {
    for (const u of memUsers.values()) if (u.email.toLowerCase() === lc) return u;
    return null;
  }
  const r = await pool.query(
    "SELECT id, tenant_id, group_id, email, name, password_hash, role, active, created_at, last_login_at, allowed_views, session_version FROM app_users WHERE LOWER(email)=$1 LIMIT 1",
    [lc],
  );
  return (r.rows[0] as AppUserWithHash) ?? null;
}

export async function dbGetUserByEmail(email: string, tenantId = "default"): Promise<AppUserWithHash | null> {
  const lc = email.trim().toLowerCase();
  if (!pool) {
    for (const u of memUsers.values()) {
      if (u.tenant_id === tenantId && u.email.toLowerCase() === lc) return u;
    }
    return null;
  }
  const r = await pool.query(
    "SELECT id, tenant_id, group_id, email, name, password_hash, role, active, created_at, last_login_at, allowed_views, session_version FROM app_users WHERE tenant_id=$1 AND LOWER(email)=$2 LIMIT 1",
    [tenantId, lc],
  );
  return (r.rows[0] as AppUserWithHash) ?? null;
}

export async function dbGetUserById(id: string): Promise<AppUserWithHash | null> {
  if (!pool) return memUsers.get(id) ?? null;
  const r = await pool.query(
    "SELECT id, tenant_id, group_id, email, name, password_hash, role, active, created_at, last_login_at, allowed_views, session_version FROM app_users WHERE id=$1 LIMIT 1",
    [id],
  );
  return (r.rows[0] as AppUserWithHash) ?? null;
}

export async function dbCreateUser(input: {
  id: string; email: string; name: string; password_hash: string;
  role: "admin" | "member"; tenant_id?: string; group_id?: string;
}): Promise<void> {
  const tenant = input.tenant_id || "default";
  const group = input.group_id || "default";
  if (!pool) {
    // SEC-DUP-EMAIL · mismo chequeo síncrono que permWrite (ver comentario allí):
    // en memoria no hay índice único que frene una carrera de altas.
    const lcEmail = input.email.trim().toLowerCase();
    for (const u of memUsers.values()) {
      if (u.email.toLowerCase() === lcEmail) throw new Error("ya existe un usuario con ese nombre");
    }
    memUsers.set(input.id, {
      id: input.id, tenant_id: tenant, group_id: group, email: input.email.trim(), name: input.name.trim(),
      password_hash: input.password_hash, role: input.role, active: true,
      created_at: new Date().toISOString(), last_login_at: null, allowed_views: null, session_version: 1,
    });
    return;
  }
  await pool.query(
    `INSERT INTO app_users (id, tenant_id, group_id, email, name, password_hash, role, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
    [input.id, tenant, group, input.email.trim(), input.name.trim(), input.password_hash, input.role],
  );
}

export async function dbUpdateUser(id: string, patch: {
  email?: string; name?: string; password_hash?: string;
  role?: "admin" | "member"; active?: boolean; allowed_views?: string[] | null;
  // TEAM-EDITOR 2026-07-12 · mover a un usuario de business group (solo env-admin).
  // El caller DEBE purgar después las membresías de workspaces del grupo anterior
  // (INV-1: una membership solo vale dentro del mismo grupo).
  group_id?: string;
}): Promise<void> {
  if (!pool) {
    const u = memUsers.get(id); if (!u) return;
    if (patch.email !== undefined) u.email = patch.email.trim();
    if (patch.name !== undefined) u.name = patch.name.trim();
    if (patch.password_hash !== undefined) { u.password_hash = patch.password_hash; u.session_version = (u.session_version || 1) + 1; } // SESION-REVOCABLE-1
    if (patch.role !== undefined) u.role = patch.role;
    if (patch.active !== undefined) u.active = patch.active;
    if (patch.allowed_views !== undefined) u.allowed_views = patch.allowed_views;
    if (patch.group_id !== undefined) u.group_id = patch.group_id;
    return;
  }
  const sets: string[] = []; const vals: any[] = [];
  if (patch.email !== undefined) { sets.push(`email=$${sets.length + 2}`); vals.push(patch.email.trim()); }
  if (patch.name !== undefined) { sets.push(`name=$${sets.length + 2}`); vals.push(patch.name.trim()); }
  if (patch.password_hash !== undefined) { sets.push(`password_hash=$${sets.length + 2}`); vals.push(patch.password_hash); }
  if (patch.role !== undefined) { sets.push(`role=$${sets.length + 2}`); vals.push(patch.role); }
  if (patch.active !== undefined) { sets.push(`active=$${sets.length + 2}`); vals.push(patch.active); }
  if (patch.allowed_views !== undefined) { sets.push(`allowed_views=$${sets.length + 2}::jsonb`); vals.push(patch.allowed_views == null ? null : JSON.stringify(patch.allowed_views)); }
  if (patch.group_id !== undefined) { sets.push(`group_id=$${sets.length + 2}`); vals.push(patch.group_id); }
  if (!sets.length) return;
  // SESION-REVOCABLE-1 · cambiar la contraseña sube la versión de sesión: las cookies
  // firmadas con la anterior dejan de valer. Va fuera de `sets` para no mover los $n.
  const bump = patch.password_hash !== undefined ? ", session_version=session_version+1" : "";
  await pool.query(`UPDATE app_users SET ${sets.join(", ")}${bump} WHERE id=$1`, [id, ...vals]);
}

export async function dbDeleteUser(id: string): Promise<void> {
  if (!pool) { memUsers.delete(id); return; }
  await pool.query("DELETE FROM app_users WHERE id=$1", [id]);
}

export async function dbTouchUserLogin(id: string): Promise<void> {
  if (!pool) {
    const u = memUsers.get(id); if (u) u.last_login_at = new Date().toISOString();
    return;
  }
  await pool.query("UPDATE app_users SET last_login_at=now() WHERE id=$1", [id]);
}

// SESION-REVOCABLE-1 · cookies cerradas con «salir» (su nonce) hasta que caduquen.
// admin.ts guarda una réplica en memoria y la refresca cada pocos segundos: no hay
// consulta por petición. En modo memoria (sin DATABASE_URL) vive solo aquí.
const memSesionesRevocadas = new Map<string, { uid: string; exp: number }>();
export async function dbRevocarSesion(nonce: string, uid: string, exp: number): Promise<void> {
  if (!pool) { memSesionesRevocadas.set(nonce, { uid, exp }); return; }
  await pool.query(
    "INSERT INTO app_sesiones_revocadas (nonce, uid, exp) VALUES ($1, $2, $3) ON CONFLICT (nonce) DO NOTHING",
    [nonce, uid, exp],
  );
}
/** Nonces revocados aún vigentes; de paso purga los caducados. */
export async function dbCargarSesionesRevocadas(): Promise<Array<{ nonce: string; exp: number }>> {
  const ahora = Date.now();
  if (!pool) {
    for (const [n, s] of memSesionesRevocadas) if (s.exp < ahora) memSesionesRevocadas.delete(n);
    return [...memSesionesRevocadas].map(([nonce, s]) => ({ nonce, exp: s.exp }));
  }
  await pool.query("DELETE FROM app_sesiones_revocadas WHERE exp < $1", [ahora]);
  const r = await pool.query("SELECT nonce, exp FROM app_sesiones_revocadas");
  return r.rows.map((x: { nonce: string; exp: string | number }) => ({ nonce: x.nonce, exp: Number(x.exp) }));
}

// ROTACION-ENC-1 · las tablas del WhatsApp por QR (whatsapp-qr.ts) guardan credenciales
// y claves de señal cifradas con APP_ENC_KEY. Al rotar la clave hay que re-cifrarlas
// igual que los ajustes secretos. Las crea el propio servicio QR en su primer arranque:
// si aún no existen no hay nada que rotar. `rotar` viene de crypto.ts (rotarCifrado).
export async function dbRotarCifradoQr(
  rotar: (v: string) => { valor: string; cambiado: boolean } | null,
): Promise<{ total: number; rotados: number; ilegibles: string[] }> {
  const res = { total: 0, rotados: 0, ilegibles: [] as string[] };
  if (!pool) return res; // en memoria el QR no persiste nada
  const db = pool;
  const existe = async (t: string): Promise<boolean> => (await db.query("SELECT to_regclass($1) AS r", [t])).rows[0]?.r != null;
  if (await existe("app_wa_qr_sessions")) {
    const r = await db.query("SELECT workspace_id, id, creds_enc, qr_enc FROM app_wa_qr_sessions WHERE creds_enc IS NOT NULL OR qr_enc IS NOT NULL");
    for (const row of r.rows) {
      for (const col of ["creds_enc", "qr_enc"] as const) {
        const v = row[col];
        if (!v) continue;
        res.total++;
        const rot = rotar(String(v));
        if (!rot) { res.ilegibles.push(`WhatsApp por QR ${col} (negocio ${row.workspace_id}, sesión ${row.id})`); continue; }
        if (!rot.cambiado) continue;
        await db.query(`UPDATE app_wa_qr_sessions SET ${col}=$3 WHERE workspace_id=$1 AND id=$2`, [row.workspace_id, row.id, rot.valor]);
        res.rotados++;
      }
    }
  }
  if (await existe("app_wa_qr_keys")) {
    const r = await db.query("SELECT workspace_id, session_id, kind, key_id, value_enc FROM app_wa_qr_keys");
    for (const row of r.rows) {
      res.total++;
      const rot = rotar(String(row.value_enc));
      if (!rot) { res.ilegibles.push(`WhatsApp por QR clave ${row.kind}/${row.key_id} (negocio ${row.workspace_id}, sesión ${row.session_id})`); continue; }
      if (!rot.cambiado) continue;
      await db.query("UPDATE app_wa_qr_keys SET value_enc=$5 WHERE workspace_id=$1 AND session_id=$2 AND kind=$3 AND key_id=$4", [row.workspace_id, row.session_id, row.kind, row.key_id, rot.valor]);
      res.rotados++;
    }
  }
  return res;
}

export async function dbCountAdmins(groupId = "default"): Promise<number> {
  if (!pool) {
    return [...memUsers.values()].filter((u) => (u.group_id || "default") === groupId && u.role === "admin" && u.active).length;
  }
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM app_users WHERE group_id=$1 AND role='admin' AND active=true",
    [groupId],
  );
  return Number((r.rows[0] as { n: number })?.n || 0);
}

// ---- Hook Vault ----
function rowToHook(r: Record<string, unknown>): Hook {
  return {
    id: String(r.id), text: String(r.text || ""), category: String(r.category || ""),
    views: Number(r.views) || 0, source: String(r.source || ""), used_count: Number(r.used_count) || 0,
    created_at: r.created_at ? new Date(r.created_at as string).getTime() : 0,
  };
}
export async function dbListHooks(tenantId = "default"): Promise<Hook[]> {
  if (!pool) return mem.hooks.filter((h) => true).sort((a, b) => b.created_at - a.created_at);
  const r = await pool.query("SELECT * FROM app_hooks WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500", [tenantId]);
  return r.rows.map(rowToHook);
}
export async function dbCreateHook(h: Partial<Hook> & { id: string; text: string }, tenantId = "default"): Promise<Hook> {
  const full: Hook = { category: "", views: 0, source: "", used_count: 0, created_at: Date.now(), ...h };
  if (!pool) { mem.hooks.push(full); return full; }
  await pool.query(
    `INSERT INTO app_hooks (id,tenant_id,text,category,views,source,used_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET
       text=EXCLUDED.text,category=EXCLUDED.category,views=EXCLUDED.views,source=EXCLUDED.source`,
    [full.id, tenantId, full.text, full.category, full.views, full.source, full.used_count],
  );
  return full;
}
export async function dbDeleteHook(id: string, tenantId = "default"): Promise<void> {
  if (!pool) { mem.hooks = mem.hooks.filter((h) => h.id !== id); return; }
  await pool.query("DELETE FROM app_hooks WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
}
export async function dbUseHook(id: string, tenantId = "default"): Promise<Hook | null> {
  if (!pool) { const h = mem.hooks.find((x) => x.id === id); if (h) h.used_count++; return h ?? null; }
  const r = await pool.query("UPDATE app_hooks SET used_count=used_count+1 WHERE id=$1 AND tenant_id=$2 RETURNING *", [id, tenantId]);
  return r.rows[0] ? rowToHook(r.rows[0]) : null;
}

// ---- Radar de Tendencias ----
function rowToTrend(r: Record<string, unknown>): Trend {
  return {
    id: String(r.id), title: String(r.title || ""), url: String(r.url || ""), source: String(r.source || ""),
    category: String(r.category || ""), hook_potential: (String(r.hook_potential || "medio") as Trend["hook_potential"]),
    published_at: r.published_at ? new Date(r.published_at as string).getTime() : null,
    fetched_at: r.fetched_at ? new Date(r.fetched_at as string).getTime() : 0,
  };
}
export async function dbListTrends(tenantId = "default"): Promise<Trend[]> {
  if (!pool) return mem.trends.slice().sort((a, b) => (b.published_at || b.fetched_at) - (a.published_at || a.fetched_at));
  const r = await pool.query("SELECT * FROM app_trends WHERE tenant_id=$1 ORDER BY COALESCE(published_at,fetched_at) DESC LIMIT 120", [tenantId]);
  return r.rows.map(rowToTrend);
}
export async function dbUpsertTrends(items: Trend[], tenantId = "default"): Promise<void> {
  if (!pool) {
    for (const it of items) { const i = mem.trends.findIndex((t) => t.id === it.id); if (i >= 0) mem.trends[i] = it; else mem.trends.push(it); }
    if (mem.trends.length > 300) mem.trends = mem.trends.slice(-300);
    return;
  }
  for (const it of items) {
    await pool.query(
      `INSERT INTO app_trends (id,tenant_id,title,url,source,category,hook_potential,published_at,fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT (id) DO UPDATE SET
         hook_potential=EXCLUDED.hook_potential,category=EXCLUDED.category,fetched_at=now()`,
      [it.id, tenantId, it.title, it.url, it.source, it.category, it.hook_potential, it.published_at ? new Date(it.published_at) : null],
    );
  }
}

// ============================================================
// Workspaces (multi-tenant). Helpers idempotentes para crear/listar/
// archivar workspaces. El workspace 'default' siempre existe (seed en
// initDb tanto en Postgres como en memoria).
// ============================================================
function slugify(input: string): string {
  return input
    .toString()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "ws";
}

function rowToWorkspace(r: Record<string, unknown>): Workspace {
  const ws: Workspace = {
    id: String(r.id),
    label: String(r.label ?? ""),
    slug: String(r.slug ?? ""),
    brand_color: String(r.brand_color ?? "#3b82f6"),
    logo_url: String(r.logo_url ?? ""),
    timezone: String(r.timezone ?? "Europe/Madrid"),
    archived: !!r.archived,
    created_by: String(r.created_by ?? "env-admin"),
    group_id: String(r.group_id ?? "default"),
    created_at: r.created_at ? new Date(r.created_at as string).getTime() : 0,
    updated_at: r.updated_at ? new Date(r.updated_at as string).getTime() : 0,
  };
  // WS-LIFECYCLE · solo se rellena si la SELECT pidió la columna: así
  // "no consultado" (undefined) no se confunde con "nunca archivado" (null).
  if ("archived_at" in r) {
    ws.archived_at = r.archived_at ? new Date(r.archived_at as string).getTime() : null;
  }
  return ws;
}

function seedDefaultWorkspaceInMem(): void {
  if (mem.workspaces.has("default")) return;
  const now = Date.now();
  mem.workspaces.set("default", {
    id: "default",
    label: "Negocio principal",
    slug: "default",
    brand_color: "#3b82f6",
    logo_url: "",
    timezone: "Europe/Madrid",
    archived: false,
    created_by: "env-admin",
    group_id: "default",
    created_at: now,
    updated_at: now,
  });
}

// groupId opcional: undefined ⇒ todos (super-admin / routing); valor ⇒ solo ese grupo.
export async function dbListWorkspaces(includeArchived = false, groupId?: string): Promise<Workspace[]> {
  if (!pool) {
    seedDefaultWorkspaceInMem();
    return [...mem.workspaces.values()]
      .filter((w) => (includeArchived || !w.archived) && (groupId === undefined || (w.group_id || "default") === groupId))
      .sort((a, b) => a.created_at - b.created_at);
  }
  const cols = "id,label,slug,brand_color,logo_url,timezone,archived,archived_at,created_by,group_id,created_at,updated_at";
  const conds: string[] = [];
  const params: unknown[] = [];
  if (!includeArchived) conds.push("archived=false");
  if (groupId !== undefined) { params.push(groupId); conds.push(`group_id=$${params.length}`); }
  const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
  const r = await pool.query(`SELECT ${cols} FROM app_workspaces${where} ORDER BY created_at ASC`, params);
  return r.rows.map(rowToWorkspace);
}

export async function dbGetWorkspace(id: string): Promise<Workspace | null> {
  if (!id) return null;
  if (!pool) {
    seedDefaultWorkspaceInMem();
    return mem.workspaces.get(id) ?? null;
  }
  const r = await pool.query(
    "SELECT id,label,slug,brand_color,logo_url,timezone,archived,archived_at,created_by,group_id,created_at,updated_at FROM app_workspaces WHERE id=$1 LIMIT 1",
    [id],
  );
  return r.rows[0] ? rowToWorkspace(r.rows[0]) : null;
}

// QUERY-PARAM-FIX 2026-06-04 · resolver "idOrSlug" a un workspace.id real.
// El bug: el panel construye URLs como /admin?ws=<slug-humano> pero el
// backend (guard, assertWorkspaceExists) compara siempre contra el UUID.
// Si la URL trae el slug en vez del id, todo cae a 'default' silenciosamente.
//
// Estrategia (en orden, defensa en profundidad):
//   1) Match exacto contra id (UUID).
//   2) Match exacto contra slug (canónico, no archivado).
//   3) Match normalizado (lowercase + solo alfanumérico) contra slug O label,
//      para tolerar "ingeniero-binario" vs "ingenierobinario", caps, espacios.
//
// Devuelve el workspace.id real (UUID) o null si no encuentra nada vivo.
// No tira: el caller (guard / endpoint POST active) decide qué hacer si no
// resuelve (fallback a default / 404).
export async function dbResolveWorkspaceId(idOrSlug: string | null | undefined): Promise<string | null> {
  if (!idOrSlug) return null;
  const raw = String(idOrSlug).trim();
  if (!raw) return null;
  // 1) Match exacto por id.
  try {
    const byId = await dbGetWorkspace(raw);
    if (byId && !byId.archived) return byId.id;
  } catch { /* sigue al siguiente intento */ }
  // 2) Match exacto por slug (no archivado).
  if (pool) {
    try {
      const r = await pool.query(
        "SELECT id FROM app_workspaces WHERE slug=$1 AND archived=false LIMIT 1",
        [raw],
      );
      if (r.rows[0]) return String(r.rows[0].id);
    } catch { /* sigue al normalizado */ }
  }
  // 3) Match normalizado (slug O label) contra el listado vivo.
  // Lowercase + strip de cualquier carácter no alfanumérico (guiones,
  // espacios, acentos básicos): "ingeniero-binario" → "ingenierobinario".
  try {
    const list = await dbListWorkspaces(false);
    const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!normalized) return null;
    const match = list.find((w) => {
      const wSlug = String(w.slug || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const wLabel = String(w.label || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return wSlug === normalized || wLabel === normalized;
    });
    return match ? match.id : null;
  } catch {
    return null;
  }
}

// SEC-2 · validaciones canónicas de input de workspace (defense in depth).
// label: 1..80 chars seguros; brand_color: hex #RRGGBB.
const WS_LABEL_RE = /^[A-Za-z0-9 _\-.,:&()/+!?À-ſ]+$/;
const WS_HEX_RE = /^#[0-9A-Fa-f]{6}$/;
function assertValidWsLabel(label: string): void {
  if (!label || label.length > 80 || !WS_LABEL_RE.test(label)) {
    throw new Error("workspace.label invalido (1-80 chars, alfanumerico + espacios + acentos + . , - _ y signos seguros)");
  }
}
function assertValidBrandColor(c: string): void {
  if (!WS_HEX_RE.test(c)) {
    throw new Error("workspace.brand_color invalido (formato esperado #RRGGBB)");
  }
}

// WS-ISOLATION 2026-06-04 · dbCreateWorkspace NO copia ningun setting del
// workspace 'default' al nuevo. Esto es intencional: el nuevo WS arranca
// vacio y el operador conecta sus credenciales explicitamente. La cascada de
// lectura en settings.ts tampoco hereda bajo strict mode. Si necesitas seed
// inicial, hazlo despues con setWorkspaceSetting() explicito (auditable).
export async function dbCreateWorkspace(input: {
  id?: string;
  label: string;
  slug?: string;
  brand_color?: string;
  logo_url?: string;
  timezone?: string;
  created_by?: string;
  group_id?: string;
}): Promise<Workspace> {
  const label = (input.label || "").trim();
  if (!label) throw new Error("workspace.label requerido");
  assertValidWsLabel(label);
  if (input.brand_color !== undefined && input.brand_color !== "") assertValidBrandColor(input.brand_color);
  const id = (input.id || "").trim() || (globalThis.crypto?.randomUUID?.() ?? `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const baseSlug = (input.slug && slugify(input.slug)) || slugify(label);
  const brand_color = input.brand_color || "#3b82f6";
  const logo_url = input.logo_url || "";
  const timezone = input.timezone || "Europe/Madrid";
  const created_by = input.created_by || "env-admin";
  const group_id = input.group_id || "default";

  if (!pool) {
    seedDefaultWorkspaceInMem();
    // Unicidad de slug en memoria
    const taken = new Set([...mem.workspaces.values()].map((w) => w.slug));
    let slug = baseSlug; let n = 2;
    while (taken.has(slug)) { slug = `${baseSlug}-${n++}`; }
    if (mem.workspaces.has(id)) throw new Error(`workspace.id duplicado: ${id}`);
    const now = Date.now();
    const ws: Workspace = {
      id, label, slug, brand_color, logo_url, timezone,
      archived: false, created_by, group_id, created_at: now, updated_at: now,
    };
    mem.workspaces.set(id, ws);
    return ws;
  }
  // Resolver slug único en BD (best-effort: suffix incremental si colisiona).
  let slug = baseSlug; let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await pool.query("SELECT 1 FROM app_workspaces WHERE slug=$1 LIMIT 1", [slug]);
    if (!r.rows[0]) break;
    slug = `${baseSlug}-${n++}`;
    if (n > 9999) throw new Error("no se pudo derivar slug único");
  }
  const r = await pool.query(
    `INSERT INTO app_workspaces (id,label,slug,brand_color,logo_url,timezone,created_by,group_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
     RETURNING id,label,slug,brand_color,logo_url,timezone,archived,archived_at,created_by,group_id,created_at,updated_at`,
    [id, label, slug, brand_color, logo_url, timezone, created_by, group_id],
  );
  return rowToWorkspace(r.rows[0]);
}

export async function dbUpdateWorkspace(id: string, patch: {
  label?: string;
  slug?: string;
  brand_color?: string;
  logo_url?: string;
  timezone?: string;
  archived?: boolean;
  /** Business Group dueño. Mover un workspace de grupo cambia su frontera de
   *  aislamiento, así que el endpoint que lo use debe reservarlo al operador
   *  del sistema. */
  group_id?: string;
}): Promise<Workspace | null> {
  if (!id) return null;
  if (patch.label !== undefined) assertValidWsLabel(patch.label.trim());
  if (patch.brand_color !== undefined && patch.brand_color !== "") assertValidBrandColor(patch.brand_color);
  if (!pool) {
    seedDefaultWorkspaceInMem();
    const w = mem.workspaces.get(id);
    if (!w) return null;
    if (patch.label !== undefined) w.label = patch.label.trim() || w.label;
    if (patch.slug !== undefined) {
      const s = slugify(patch.slug);
      const taken = new Set([...mem.workspaces.values()].filter((x) => x.id !== id).map((x) => x.slug));
      if (taken.has(s)) throw new Error(`workspace.slug en uso: ${s}`);
      w.slug = s;
    }
    if (patch.brand_color !== undefined) w.brand_color = patch.brand_color;
    if (patch.logo_url !== undefined) w.logo_url = patch.logo_url;
    if (patch.timezone !== undefined) w.timezone = patch.timezone;
    if (patch.group_id !== undefined) w.group_id = patch.group_id;
    if (patch.archived !== undefined) {
      w.archived = !!patch.archived;
      // WS-LIFECYCLE · el reloj de retención arranca al archivar y se BORRA al
      // restaurar. Re-archivar tras desarchivar reinicia el periodo de gracia.
      w.archived_at = w.archived ? (w.archived_at || Date.now()) : null;
    }
    w.updated_at = Date.now();
    return w;
  }
  const sets: string[] = []; const vals: unknown[] = [];
  if (patch.label !== undefined) { sets.push(`label=$${sets.length + 2}`); vals.push(patch.label.trim()); }
  if (patch.slug !== undefined) { sets.push(`slug=$${sets.length + 2}`); vals.push(slugify(patch.slug)); }
  if (patch.brand_color !== undefined) { sets.push(`brand_color=$${sets.length + 2}`); vals.push(patch.brand_color); }
  if (patch.logo_url !== undefined) { sets.push(`logo_url=$${sets.length + 2}`); vals.push(patch.logo_url); }
  if (patch.timezone !== undefined) { sets.push(`timezone=$${sets.length + 2}`); vals.push(patch.timezone); }
  if (patch.group_id !== undefined) { sets.push(`group_id=$${sets.length + 2}`); vals.push(patch.group_id); }
  if (patch.archived !== undefined) {
    sets.push(`archived=$${sets.length + 2}`); vals.push(!!patch.archived);
    // WS-LIFECYCLE · archived_at va como literal SQL (sin placeholder). Es seguro
    // porque 'archived' es el ÚLTIMO campo parametrizado: nada posterior calcula
    // $N a partir de sets.length. Si añades otro campo con parámetro, ponlo ANTES.
    sets.push(patch.archived ? "archived_at=COALESCE(archived_at, now())" : "archived_at=NULL");
  }
  if (!sets.length) return dbGetWorkspace(id);
  sets.push("updated_at=now()");
  const r = await pool.query(
    `UPDATE app_workspaces SET ${sets.join(", ")} WHERE id=$1
     RETURNING id,label,slug,brand_color,logo_url,timezone,archived,archived_at,created_by,group_id,created_at,updated_at`,
    [id, ...vals],
  );
  return r.rows[0] ? rowToWorkspace(r.rows[0]) : null;
}

// ============================================================
// WS-MOVE-GROUP-TX (T05 2026-08-25) · mover un workspace de Business Group
// SIN dejar memberships cruzadas. Antes el endpoint hacía dbUpdateWorkspace
// ({group_id}) a secas: los miembros del grupo ORIGEN conservaban su
// membership sobre un workspace que ya vivía en otro grupo → seguían entrando
// (wsMembership la honraba) hasta el reconcile manual. INV-1 en datos.
// También bloquea mover a un grupo archivado (antes se aceptaba).
// ============================================================
export async function dbTxMoveWorkspaceToGroup(
  wsId: string,
  newGroupId: string,
): Promise<{ ok: boolean; error?: string; workspace?: Workspace; removed_memberships?: number }> {
  if (!wsId || !newGroupId) return { ok: false, error: "wsId y group_id requeridos" };
  if (wsId === "default") return { ok: false, error: "el workspace 'default' no se puede mover de grupo" };
  if (!pool) {
    const w = mem.workspaces.get(wsId);
    if (!w) return { ok: false, error: "workspace no encontrado" };
    const g = mem.businessGroups.get(newGroupId);
    if (!g || g.archived) return { ok: false, error: "grupo destino inválido o archivado" };
    w.group_id = newGroupId;
    w.updated_at = Date.now();
    let removed = 0;
    mem.workspaceMembers = mem.workspaceMembers.filter((m) => {
      if (m.workspace_id !== wsId) return true;
      const ug = memUsers.get(m.user_id)?.group_id || "default";
      if (ug === newGroupId) return true;
      removed++; return false;
    });
    return { ok: true, workspace: { ...w }, removed_memberships: removed };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const wr = await client.query("SELECT id FROM app_workspaces WHERE id=$1 FOR UPDATE", [wsId]);
    if (!wr.rows[0]) { await client.query("ROLLBACK"); return { ok: false, error: "workspace no encontrado" }; }
    const gr = await client.query("SELECT archived FROM app_business_groups WHERE id=$1", [newGroupId]);
    if (!gr.rows[0] || (gr.rows[0] as { archived: boolean }).archived) {
      await client.query("ROLLBACK");
      return { ok: false, error: "grupo destino inválido o archivado" };
    }
    const ur = await client.query(
      `UPDATE app_workspaces SET group_id=$2, updated_at=now() WHERE id=$1
       RETURNING id,label,slug,brand_color,logo_url,timezone,archived,archived_at,created_by,group_id,created_at,updated_at`,
      [wsId, newGroupId],
    );
    const del = await client.query(
      `DELETE FROM app_workspace_members m
        USING app_users u
        WHERE m.workspace_id=$1 AND m.user_id=u.id
          AND COALESCE(u.group_id,'default') <> $2`,
      [wsId, newGroupId],
    );
    await client.query("COMMIT");
    return { ok: true, workspace: rowToWorkspace(ur.rows[0]), removed_memberships: Number(del.rowCount ?? 0) };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* noop */ }
    return { ok: false, error: (e as Error).message };
  } finally {
    client.release();
  }
}

export async function dbArchiveWorkspace(id: string): Promise<Workspace | null> {
  return dbUpdateWorkspace(id, { archived: true });
}

// ============================================================
// WS-LIFECYCLE 2026-08-07 · ciclo de vida del workspace y PURGA.
//
// ANTES: dbDeleteWorkspace borraba SOLO la fila del workspace y sus
// memberships. Contactos, conversaciones, settings, notas, media, activity…
// se quedaban con el tenant_id colgando, sin dueño, sin ruta de exportación y
// sin forma de restaurar. En un producto vendido a terceros eso es datos
// personales huérfanos (RGPD art. 5.1.e limitación del plazo y art. 17
// supresión) y hace que "he borrado ese negocio" sea mentira.
//
// AHORA el ciclo es explícito:
//   activo       → archived=false.
//   suspendido   → archived=true. Ya lo respetan los schedulers (wsNotArchivedSql)
//                  y el routing de canales; los datos siguen intactos.
//   recuperable  → durante la retención, unarchive lo devuelve entero.
//   purga        → dbPurgeWorkspace(): exige archivado + retención vencida +
//                  export previo, cancela el trabajo pendiente del tenant y
//                  borra TODO lo tenant-scoped junto con la fila del workspace
//                  EN UNA SOLA TRANSACCIÓN (o todo, o nada).
//
// El export descargable es dbExportWorkspaceData(); el estado del reloj,
// dbWorkspacePurgeStatus().
// ============================================================

/** Días de retención por defecto entre archivar y poder purgar. */
export const WS_RETENTION_DEFAULT_DAYS = 30;
/** Tope de filas por tabla en el export (evita OOM). Se avisa si recorta. */
const WS_EXPORT_ROW_CAP = 20000;
/** Key (per-tenant) donde se sella el último export descargado del workspace. */
const WS_LAST_EXPORT_KEY = "workspace.lastExportAt";

/**
 * Tablas con columna tenant_id que NO entran en la purga:
 *   - app_users: es IDENTIDAD, no dato del tenant. Un usuario puede ser miembro
 *     de varios workspaces y borrar su fila cascadearía sus memberships en los
 *     OTROS. Se cuenta y se reporta (orphan_users) para que decida el operador.
 * app_settings del namespace reservado '_global_' nunca corre peligro: el filtro
 * es tenant_id = <id del ws>, y ese id jamás puede ser '_global_' ni 'default'.
 */
const WS_PURGE_SKIP_TABLES: ReadonlySet<string> = new Set(["app_users"]);

/** Identificador SQL seguro (defensa: los nombres vienen de information_schema). */
const SQL_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Descubre en la BD TODAS las tablas BASE con columna tenant_id (menos las de
 * WS_PURGE_SKIP_TABLES). Dinámico A PROPÓSITO: una tabla nueva con tenant_id
 * entra en la purga sola, sin que nadie tenga que acordarse de añadirla a una
 * lista — olvidarse de esa lista es exactamente como se fabrican los huérfanos.
 * El filtro BASE TABLE evita intentar un DELETE contra una vista.
 */
async function tenantScopedTables(c: pg.PoolClient): Promise<string[]> {
  const r = await c.query(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema()
        AND c.column_name = 'tenant_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name`,
  );
  return r.rows
    .map((x: Record<string, unknown>) => String(x.table_name))
    .filter((t: string) => SQL_IDENT_RE.test(t) && !WS_PURGE_SKIP_TABLES.has(t));
}

/**
 * Días de retención efectivos + de dónde salen. Configurable, en este orden:
 *   1) env WORKSPACE_RETENTION_DAYS
 *   2) setting 'workspace.retentionDays' (namespace '_global_'; se lee también
 *      'default' por si se grabó antes de que la key fuera global)
 *   3) WS_RETENTION_DEFAULT_DAYS
 * Se lee con SQL directo (no vía settings.ts) para no crear un ciclo de imports.
 */
export async function dbWorkspaceRetentionDays(): Promise<{ days: number; source: "env" | "settings" | "default" }> {
  const raw = String(process.env.WORKSPACE_RETENTION_DAYS || "").trim();
  const envN = Number(raw);
  if (raw && Number.isFinite(envN) && envN >= 0 && envN <= 3650) {
    return { days: Math.floor(envN), source: "env" };
  }
  if (pool) {
    try {
      const r = await pool.query(
        `SELECT value FROM app_settings
          WHERE key=$1 AND tenant_id IN ('_global_','default')
          ORDER BY CASE WHEN tenant_id='_global_' THEN 0 ELSE 1 END LIMIT 1`,
        ["workspace.retentionDays"],
      );
      const n = Number(String(r.rows[0]?.value ?? "").trim());
      if (Number.isFinite(n) && n >= 0 && n <= 3650) return { days: Math.floor(n), source: "settings" };
    } catch { /* cae al default */ }
  }
  return { days: WS_RETENTION_DEFAULT_DAYS, source: "default" };
}

/** Foto del reloj de retención de un workspace (lo que el operador necesita ver). */
export interface WorkspacePurgeStatus {
  id: string;
  exists: boolean;
  archived: boolean;
  /** epoch ms en que se archivó, o null si nunca (reloj sin arrancar). */
  archived_at: number | null;
  retention_days: number;
  retention_source: "env" | "settings" | "default";
  /** epoch ms a partir del cual se puede purgar; null si el reloj no arrancó. */
  purge_after: number | null;
  retention_elapsed: boolean;
  days_remaining: number;
  /** epoch ms del último export descargado, o null si NUNCA se exportó. */
  last_export_at: number | null;
  /**
   * true si nadie se ha descargado el export de este workspace. NO bloquea la
   * purga MANUAL (el operador es quien decide y quien la firma), pero sí la
   * PROGRAMADA: una purga desatendida sin copia previa es pérdida de datos.
   */
  export_missing: boolean;
  /** true si hoy mismo se puede purgar a mano sin force. */
  purgeable: boolean;
  /** motivo humano cuando purgeable=false. */
  blocked_by: string;
}

export async function dbWorkspacePurgeStatus(id: string): Promise<WorkspacePurgeStatus> {
  const ret = await dbWorkspaceRetentionDays();
  const base: WorkspacePurgeStatus = {
    id,
    exists: false,
    archived: false,
    archived_at: null,
    retention_days: ret.days,
    retention_source: ret.source,
    purge_after: null,
    retention_elapsed: false,
    days_remaining: ret.days,
    last_export_at: null,
    export_missing: true,
    purgeable: false,
    blocked_by: "workspace no encontrado",
  };
  if (!id || id === "default") {
    return { ...base, exists: id === "default", blocked_by: "el workspace 'default' no se puede purgar nunca" };
  }
  let archived = false;
  let archivedAt: number | null = null;
  let lastExport: number | null = null;
  if (!pool) {
    const ws = mem.workspaces.get(id);
    if (!ws) return base;
    archived = !!ws.archived;
    archivedAt = ws.archived_at ?? null;
    const s = mem.settings.get(`${id}|${WS_LAST_EXPORT_KEY}`);
    lastExport = s ? Date.parse(s.value) || null : null;
  } else {
    const r = await pool.query("SELECT archived, archived_at FROM app_workspaces WHERE id=$1 LIMIT 1", [id]);
    if (!r.rows[0]) return base;
    archived = !!r.rows[0].archived;
    archivedAt = r.rows[0].archived_at ? new Date(r.rows[0].archived_at as string).getTime() : null;
    const e = await pool.query("SELECT value FROM app_settings WHERE tenant_id=$1 AND key=$2 LIMIT 1", [id, WS_LAST_EXPORT_KEY]);
    lastExport = e.rows[0] ? (Date.parse(String(e.rows[0].value)) || null) : null;
  }
  const purgeAfter = archivedAt === null ? null : archivedAt + ret.days * 86400000;
  const elapsed = purgeAfter !== null && Date.now() >= purgeAfter;
  const remaining = purgeAfter === null ? ret.days : Math.max(0, Math.ceil((purgeAfter - Date.now()) / 86400000));
  let blocked = "";
  if (!archived) blocked = "el workspace está activo: archívalo primero (el archivado es reversible y arranca la retención)";
  else if (purgeAfter === null) blocked = "el reloj de retención no arrancó (archived_at vacío): desarchiva y vuelve a archivar";
  else if (!elapsed) blocked = `retención vigente: faltan ${remaining} día(s) de ${ret.days} (origen: ${ret.source})`;
  return {
    id,
    exists: true,
    archived,
    archived_at: archivedAt,
    retention_days: ret.days,
    retention_source: ret.source,
    purge_after: purgeAfter,
    retention_elapsed: elapsed,
    days_remaining: remaining,
    last_export_at: lastExport,
    export_missing: lastExport === null,
    purgeable: blocked === "",
    blocked_by: blocked,
  };
}

/** Workspaces archivados cuya retención ya venció: la cola de purga programada. */
export async function dbListWorkspacesPendingPurge(): Promise<Workspace[]> {
  const ret = await dbWorkspaceRetentionDays();
  if (!pool) {
    const cut = Date.now() - ret.days * 86400000;
    return [...mem.workspaces.values()].filter(
      (w) => w.id !== "default" && w.archived && typeof w.archived_at === "number" && (w.archived_at as number) <= cut,
    );
  }
  const r = await pool.query(
    `SELECT id,label,slug,brand_color,logo_url,timezone,archived,archived_at,created_by,group_id,created_at,updated_at
       FROM app_workspaces
      WHERE archived=true AND id <> 'default' AND archived_at IS NOT NULL
        AND archived_at <= now() - ($1 || ' days')::interval
      ORDER BY archived_at ASC`,
    [String(ret.days)],
  );
  return r.rows.map(rowToWorkspace);
}

/**
 * Cancela el TRABAJO PENDIENTE de un tenant: colas de jobs y envíos programados.
 * Se ejecuta y se COMMITEA antes de abrir la transacción de purga, para que un
 * worker que ya tenga el tick en marcha se encuentre la cola cancelada y no
 * intente enviar en nombre de un negocio que está a punto de dejar de existir.
 * Devuelve filas afectadas por tabla (solo las > 0).
 */
export async function dbCancelWorkspaceWork(id: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!id || id === "default" || !pool) return out;
  // Cada UPDATE toca SOLO estados "vivos": lo ya enviado/hecho no se reescribe
  // (sería falsear el histórico que el propio export acaba de llevarse).
  const stmts: Array<[string, string]> = [
    ["app_broadcasts_jobs", "UPDATE app_broadcasts_jobs SET status='cancelled' WHERE tenant_id=$1 AND status='queued'"],
    ["app_broadcasts_runs", "UPDATE app_broadcasts_runs SET status='cancelled', ended_at=now() WHERE tenant_id=$1 AND status IN ('queued','running')"],
    ["app_broadcasts", "UPDATE app_broadcasts SET status='cancelled' WHERE tenant_id=$1 AND status IN ('scheduled','sending')"],
    ["app_mcp_jobs", "UPDATE app_mcp_jobs SET status='cancelled', updated_at=now() WHERE tenant_id=$1 AND status IN ('queued','running')"],
    ["app_scheduled_posts", "UPDATE app_scheduled_posts SET status='cancelled' WHERE tenant_id=$1 AND status='pending'"],
    // NEWSLETTER-1 · un boletín programado de un negocio en purga no debe salir.
    // OJO: aquí solo se apaga NUESTRA fila; la programación que vive en la web
    // se retira aparte (el panel llama a scheduleNewsletter(id, null) al
    // cancelar), porque desde la purga no hay credenciales de esa cuenta.
    ["app_newsletters", "UPDATE app_newsletters SET status='cancelled', updated_at=now() WHERE tenant_id=$1 AND status IN ('draft','scheduled')"],
    ["app_sequence_runs", "UPDATE app_sequence_runs SET status='cancelled' WHERE tenant_id=$1 AND status='active'"],
    ["app_flow_runs", "UPDATE app_flow_runs SET status='cancelled', updated_at=now() WHERE tenant_id=$1 AND status IN ('active','waiting')"],
    ["app_comment_drip", "UPDATE app_comment_drip SET status='skipped', error='workspace en purga' WHERE tenant_id=$1 AND status='pending'"],
    // LeadJob no tiene estado 'cancelled' en su unión de tipos: se cierra como
    // 'error' con el motivo escrito, que es lo honesto y lo que la UI sabe pintar.
    ["app_lead_jobs", "UPDATE app_lead_jobs SET status='error', error='workspace en purga' WHERE tenant_id=$1 AND status IN ('queued','discovering','scraping')"],
    ["app_ads_alerts", "UPDATE app_ads_alerts SET enabled=false, updated_at=now() WHERE tenant_id=$1 AND enabled=true"],
    ["app_broadcasts_flows", "UPDATE app_broadcasts_flows SET enabled=false, updated_at=now() WHERE tenant_id=$1 AND enabled=true"],
  ];
  for (const [name, sql] of stmts) {
    // Aisladas: un fallo (tabla vieja sin esa columna) no debe abortar el resto,
    // y por eso NO se ejecuta dentro de la transacción de purga.
    try {
      const r = await pool.query(sql, [id]);
      if ((r.rowCount ?? 0) > 0) out[name] = r.rowCount ?? 0;
    } catch (e) {
      console.warn(`[ws-purge] cancelación ${name} falló: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Resultado de una purga (o del motivo por el que no se hizo). */
export interface WorkspacePurgeResult {
  ok: boolean;
  error?: string;
  /** filas borradas por tabla (solo las que borraron > 0). */
  deleted?: Record<string, number>;
  /** filas canceladas por tabla antes de borrar. */
  cancelled?: Record<string, number>;
  total?: number;
  /** usuarios cuyo tenant_id de origen era este ws. NO se borran: son identidad. */
  orphan_users?: number;
  /** epoch ms del export previo descargado, o null si se purgó sin copia. */
  export_previo?: number | null;
  /** aviso honesto cuando la purga no puede garantizar el barrido completo. */
  note?: string;
}

/**
 * PURGA del workspace: borrado permanente y COMPLETO.
 * Gates:
 *   1) nunca 'default' (ni con force);
 *   2) debe estar archivado — la suspensión reversible previa (ni con force);
 *   3) la retención debe haber vencido (force la salta, y queda en el log);
 *   4) export previo: obligatorio SOLO en la purga programada (requireExport).
 *      A mano no bloquea — el operador firma la decisión — pero el resultado
 *      dice sin adornos si se purgó sin copia (export_previo=null).
 * Después: cancela el trabajo pendiente y borra en UNA transacción todas las
 * filas de todas las tablas con tenant_id, las memberships y la fila del ws.
 */
export async function dbPurgeWorkspace(
  id: string,
  opts?: { force?: boolean; actor?: string; requireExport?: boolean },
): Promise<WorkspacePurgeResult> {
  if (!id || id === "default") return { ok: false, error: "no se puede purgar el workspace 'default'" };
  const force = !!opts?.force;
  const actor = String(opts?.actor || "env-admin");

  const st = await dbWorkspacePurgeStatus(id);
  if (!st.exists) return { ok: false, error: "workspace no encontrado" };
  if (!st.archived) {
    // Ni con force: purgar un workspace VIVO no es un descuido recuperable.
    return { ok: false, error: "archiva el workspace antes de purgarlo (el archivado es reversible y arranca la retención)" };
  }
  if (!st.purgeable && !force) return { ok: false, error: st.blocked_by };
  if (opts?.requireExport && st.export_missing && !force) {
    return { ok: false, error: `no consta export previo: descarga GET /admin/api/workspaces/${id}/export antes de purgar` };
  }

  if (!pool) {
    // Dev sin Postgres. El almacén en memoria no es superficie de cumplimiento
    // (no persiste), pero dejarlo sucio haría mentir a las pruebas locales.
    const ws = mem.workspaces.get(id);
    if (!ws) return { ok: false, error: "workspace no encontrado" };
    const deleted = memPurgeTenant(id);
    const before = mem.workspaceMembers.length;
    mem.workspaceMembers = mem.workspaceMembers.filter((m) => m.workspace_id !== id);
    if (before !== mem.workspaceMembers.length) deleted.app_workspace_members = before - mem.workspaceMembers.length;
    mem.workspaces.delete(id);
    deleted.app_workspaces = 1;
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    console.warn(`[ws-purge] MEMORIA actor=${actor} ws=${id} filas=${total} force=${force}`);
    return {
      ok: true, deleted, total, orphan_users: 0, export_previo: st.last_export_at,
      note: "almacén en memoria (dev): solo se purgan las colecciones que llevan tenant_id",
    };
  }

  const cancelled = await dbCancelWorkspaceWork(id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // FOR UPDATE: nadie desarchiva ni re-archiva a mitad de purga.
    const r = await client.query("SELECT id, archived FROM app_workspaces WHERE id=$1 FOR UPDATE", [id]);
    if (!r.rows[0]) { await client.query("ROLLBACK"); return { ok: false, error: "workspace no encontrado" }; }
    if (!r.rows[0].archived) { await client.query("ROLLBACK"); return { ok: false, error: "el workspace dejó de estar archivado durante la purga: abortada" }; }

    const orph = await client.query("SELECT count(*)::int AS n FROM app_users WHERE tenant_id=$1", [id]);
    const orphanUsers = Number(orph.rows[0]?.n ?? 0);

    const deleted: Record<string, number> = {};
    let total = 0;
    for (const t of await tenantScopedTables(client)) {
      const d = await client.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [id]);
      const n = d.rowCount ?? 0;
      if (n > 0) { deleted[t] = n; total += n; }
    }
    const mem2 = await client.query("DELETE FROM app_workspace_members WHERE workspace_id=$1", [id]);
    if ((mem2.rowCount ?? 0) > 0) { deleted.app_workspace_members = mem2.rowCount ?? 0; total += mem2.rowCount ?? 0; }
    const wsDel = await client.query("DELETE FROM app_workspaces WHERE id=$1", [id]);
    if ((wsDel.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, error: "no se pudo borrar la fila del workspace: purga revertida entera" };
    }
    deleted.app_workspaces = 1; total += 1;
    await client.query("COMMIT");
    console.warn(`[ws-purge] actor=${actor} ws=${id} filas=${total} tablas=${Object.keys(deleted).length} force=${force} export-previo=${st.last_export_at ? new Date(st.last_export_at).toISOString() : "NINGUNO"} usuarios-huerfanos=${orphanUsers}`);
    const avisos: string[] = [];
    if (st.last_export_at === null) avisos.push("se purgó SIN export previo: no queda copia descargable de estos datos");
    if (orphanUsers > 0) avisos.push(`${orphanUsers} usuario(s) tenían este workspace como tenant de origen. NO se borran (son identidad y pueden ser miembros de otros negocios): revísalos en Usuarios.`);
    return {
      ok: true,
      deleted,
      cancelled,
      total,
      orphan_users: orphanUsers,
      export_previo: st.last_export_at,
      note: avisos.length ? avisos.join(" · ") : undefined,
    };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* noop */ }
    return { ok: false, error: `purga revertida: ${(e as Error).message}` };
  } finally {
    client.release();
  }
}

/**
 * Purga best-effort del almacén en memoria (dev). Solo alcanza a las colecciones
 * cuyas filas llevan tenant_id — las que no lo llevan no se pueden atribuir a un
 * workspace y se dejan como están (y se dice, no se disimula).
 */
function memPurgeTenant(id: string): Record<string, number> {
  const out: Record<string, number> = {};
  const tid = (v: unknown): string => String((v as { tenant_id?: string } | null)?.tenant_id || "default");
  const purgeMap = (name: string, m: Map<string, unknown>): void => {
    let n = 0;
    for (const [k, v] of [...m.entries()]) if (tid(v) === id) { m.delete(k); n++; }
    if (n > 0) out[name] = n;
  };
  const purgeArr = (name: string, arr: unknown[]): void => {
    const kept = arr.filter((x) => tid(x) !== id);
    if (kept.length !== arr.length) { out[name] = arr.length - kept.length; arr.length = 0; arr.push(...kept); }
  };
  purgeMap("settings", mem.settings as unknown as Map<string, unknown>);
  purgeMap("conversations", mem.conversations as unknown as Map<string, unknown>);
  purgeMap("automations", mem.automations as unknown as Map<string, unknown>);
  purgeMap("contacts", mem.contacts as unknown as Map<string, unknown>);
  purgeMap("sequences", mem.sequences as unknown as Map<string, unknown>);
  purgeMap("sequenceRuns", mem.runs as unknown as Map<string, unknown>);
  purgeMap("flows", mem.flows as unknown as Map<string, unknown>);
  purgeMap("flowRuns", mem.flowRuns as unknown as Map<string, unknown>);
  purgeMap("drip", mem.drip as unknown as Map<string, unknown>);
  purgeMap("sioLeads", mem.sioLeads as unknown as Map<string, unknown>);
  purgeMap("scheduledPosts", mem.scheduledPosts as unknown as Map<string, unknown>);
  purgeMap("newsletters", mem.newsletters as unknown as Map<string, unknown>);
  purgeMap("leadJobs", mem.leadJobs as unknown as Map<string, unknown>);
  purgeMap("fbEntradas", memFbEntradas as unknown as Map<string, unknown>); // SUPRESION-FB-1
  purgeArr("flowEvents", mem.flowEvents);
  purgeArr("autopostHistory", mem.autopostHistory);
  purgeArr("broadcasts", mem.broadcasts);
  purgeArr("hooks", mem.hooks);
  purgeArr("trends", mem.trends);
  purgeArr("activity", mem.activity);
  purgeArr("waEvents", mem.waEvents);
  {
    let n = 0;
    for (const key of [...mem.waMessageStatuses.keys()]) {
      if (key.startsWith(id + "|")) { mem.waMessageStatuses.delete(key); n++; }
    }
    if (n) out.waMessageStatuses = n;
  }
  {
    let n = 0;
    for (const key of [...mem.waReactions.keys()]) {
      if (key.startsWith(id + "|")) { mem.waReactions.delete(key); n++; }
    }
    if (n) out.waReactions = n;
  }
  purgeArr("adsCreatives", mem.adsCreatives);
  purgeArr("adsExperiments", mem.adsExperiments);
  purgeArr("adsAlerts", mem.adsAlerts);
  purgeArr("adsAlertLog", mem.adsAlertLog);
  purgeArr("broadcastFlows", mem.broadcastFlows);
  purgeArr("broadcastRuns", mem.broadcastRuns);
  purgeArr("broadcastJobs", mem.broadcastJobs);
  // Dedup de automatizaciones: clave "tenantId:automationId:userId".
  let claims = 0;
  for (const k of [...mem.log]) if (k.startsWith(`${id}:`)) { mem.log.delete(k); claims++; }
  if (claims > 0) out.automationLog = claims;
  return out;
}

/** Export completo y descargable de un workspace, previo a la purga. */
export interface WorkspaceExport {
  format: "digital-business-stack/workspace-export";
  version: number;
  exported_at: string;
  workspace: Workspace | null;
  members: WorkspaceMember[];
  /** filas TOTALES por tabla (aunque el volcado se haya recortado). */
  counts: Record<string, number>;
  tables: Record<string, Record<string, unknown>[]>;
  /** tabla → aviso honesto: columnas omitidas, filas recortadas, datos enmascarados. */
  notes: Record<string, string>;
}

/**
 * Vuelca TODO lo tenant-scoped del workspace a un objeto JSON serializable.
 * Se lee en una transacción READ ONLY REPEATABLE READ: el export es una foto
 * coherente, no un mosaico de instantes distintos.
 * Salvedades (declaradas en `notes`, nunca escondidas):
 *   - columnas BYTEA (bytes de assets y de media entrante) NO viajan en el JSON;
 *   - los valores de settings marcados como secretos se enmascaran;
 *   - por encima de WS_EXPORT_ROW_CAP filas por tabla el volcado se recorta
 *     (counts sigue diciendo el total real);
 *   - app_users no se exporta: password_hash no sale de la base.
 * Sella 'workspace.lastExportAt' en el propio tenant: es lo que mira la purga
 * para saber si hubo export previo (y desaparece con la purga, como debe).
 */
export async function dbExportWorkspaceData(id: string): Promise<WorkspaceExport> {
  const out: WorkspaceExport = {
    format: "digital-business-stack/workspace-export",
    version: 1,
    exported_at: new Date().toISOString(),
    workspace: await dbGetWorkspace(id),
    members: await dbListWorkspaceMembers(id),
    counts: {},
    tables: {},
    notes: {},
  };
  if (!id || !pool) {
    out.notes._store = "almacén en memoria (dev): no hay volcado tabla a tabla";
    return out;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    for (const t of await tenantScopedTables(client)) {
      const colsR = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position`,
        [t],
      );
      const names = colsR.rows.map((c: Record<string, unknown>) => ({ name: String(c.column_name), type: String(c.data_type) }));
      const safe = names.filter((c) => c.type !== "bytea" && SQL_IDENT_RE.test(c.name));
      const binary = names.filter((c) => c.type === "bytea").map((c) => c.name);
      if (!safe.length) continue;
      const cnt = await client.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id=$1`, [id]);
      const n = Number(cnt.rows[0]?.n ?? 0);
      out.counts[t] = n;
      if (n === 0) continue;
      const rows = await client.query(
        `SELECT ${safe.map((c) => c.name).join(",")} FROM ${t} WHERE tenant_id=$1 LIMIT ${WS_EXPORT_ROW_CAP}`,
        [id],
      );
      out.tables[t] = rows.rows;
      const avisos: string[] = [];
      if (t === "app_settings") {
        for (const row of out.tables[t]) if (row.is_secret) row.value = "(secreto no exportado)";
        avisos.push("los valores de las claves secretas se enmascaran: las credenciales no salen en un fichero descargable");
      }
      if (binary.length) {
        avisos.push(`columnas binarias no exportadas: ${binary.join(", ")} (los bytes no caben en JSON; siguen en la base hasta la purga)`);
      }
      if (n > WS_EXPORT_ROW_CAP) avisos.push(`volcado recortado a ${WS_EXPORT_ROW_CAP} de ${n} filas`);
      if (avisos.length) out.notes[t] = avisos.join(" · ");
    }
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
  out.notes._identidad = "app_users no se exporta (password_hash nunca sale de la base); los usuarios del workspace van en 'members'";
  // Sello del export: es la prueba que exige la purga. Best-effort — si falla,
  // el export igual se entrega (pero la purga seguirá pidiendo uno).
  try {
    await dbSetSettingForTenant(id, WS_LAST_EXPORT_KEY, out.exported_at, false);
  } catch (e) {
    out.notes._sello = `no se pudo registrar el export (${(e as Error).message}): la purga seguirá pidiendo un export previo`;
  }
  return out;
}

/**
 * COMPAT · firma antigua booleana. Delega en dbPurgeWorkspace con los gates
 * puestos; devuelve solo si se purgó o no. Los llamantes nuevos deben usar
 * dbPurgeWorkspace() para enterarse del MOTIVO cuando devuelve false.
 */
export async function dbDeleteWorkspace(id: string): Promise<boolean> {
  const r = await dbPurgeWorkspace(id);
  return r.ok;
}

// ============================================================
// Workspace members (vínculo users ↔ workspaces con role).
// Seed: en initDb los users existentes pasan a admin del workspace
// 'default'. En memoria, lo simulamos en demanda.
// ============================================================
function seedDefaultWorkspaceMembersInMem(): void {
  // WS-USER-ISOLATION 2026-06-20 · NO-OP. Antes sembraba a TODOS los users-DB en
  // 'default' (path in-memory/dev), replicando la fuga del path Postgres. En el
  // modelo aislado nadie se siembra en 'default': cada user tiene su PROPIO grupo
  // y workspace. Se conserva la función (no su efecto) para no tocar call-sites.
}

export async function dbListWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  if (!workspaceId) return [];
  if (!pool) {
    seedDefaultWorkspaceMembersInMem();
    return mem.workspaceMembers
      .filter((m) => m.workspace_id === workspaceId)
      .sort((a, b) => a.created_at - b.created_at)
      .map((m) => ({ ...m }));
  }
  const r = await pool.query(
    "SELECT workspace_id, user_id, role, created_at FROM app_workspace_members WHERE workspace_id=$1 ORDER BY created_at ASC",
    [workspaceId],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    workspace_id: String(row.workspace_id),
    user_id: String(row.user_id),
    role: String(row.role) as WorkspaceRole,
    created_at: row.created_at ? new Date(row.created_at as string).getTime() : 0,
  }));
}

export async function dbListUserWorkspaces(userId: string): Promise<{ workspace: Workspace; role: WorkspaceRole }[]> {
  if (!userId) return [];
  if (!pool) {
    seedDefaultWorkspaceInMem();
    seedDefaultWorkspaceMembersInMem();
    const out: { workspace: Workspace; role: WorkspaceRole }[] = [];
    for (const m of mem.workspaceMembers) {
      if (m.user_id !== userId) continue;
      const w = mem.workspaces.get(m.workspace_id);
      if (w && !w.archived) out.push({ workspace: { ...w }, role: m.role });
    }
    return out.sort((a, b) => a.workspace.created_at - b.workspace.created_at);
  }
  const r = await pool.query(
    `SELECT w.id, w.label, w.slug, w.brand_color, w.logo_url, w.timezone,
            w.archived, w.created_by, w.created_at, w.updated_at, m.role
       FROM app_workspace_members m
       JOIN app_workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1 AND w.archived = false
      ORDER BY w.created_at ASC`,
    [userId],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    workspace: rowToWorkspace(row),
    role: String(row.role) as WorkspaceRole,
  }));
}

// INV-1 (Business Groups) · INCONDICIONAL: un usuario solo puede ser miembro de
// workspaces de SU MISMO grupo. Invariante de integridad de datos (no UX).
// INV1-ATOMIC (T05 2026-08-25) · antes era check-then-act (dos lecturas awaited
// y después el INSERT): mover al usuario de grupo en paralelo colaba una
// membership cruzada. Ahora: en Postgres el INSERT solo inserta si los grupos
// coinciden (INSERT..SELECT gateado en la MISMA sentencia); en memoria el
// chequeo es síncrono en el mismo bloque que la escritura. Además el rol por
// defecto pasa de 'admin' (fail-open) a 'viewer' (todos los call-sites reales
// pasan rol explícito) y un user/workspace inexistente falla con mensaje claro
// también en memoria (antes insertaba la membership fantasma).
export async function dbAddWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole = "viewer",
): Promise<void> {
  if (!workspaceId || !userId) throw new Error("workspaceId y userId requeridos");
  if (!pool) {
    seedDefaultWorkspaceInMem();
    seedDefaultWorkspaceMembersInMem();
    const u = memUsers.get(userId);
    const w = mem.workspaces.get(workspaceId);
    if (!u) throw new Error("user no encontrado");
    if (!w) throw new Error("workspace no encontrado");
    const ug = u.group_id || "default";
    const wg = w.group_id || "default";
    if (ug !== wg) throw new Error(`membership cross-group rechazada: user(${ug}) ≠ workspace(${wg})`);
    const i = mem.workspaceMembers.findIndex((m) => m.workspace_id === workspaceId && m.user_id === userId);
    if (i >= 0) { mem.workspaceMembers[i].role = role; return; }
    mem.workspaceMembers.push({ workspace_id: workspaceId, user_id: userId, role, created_at: Date.now() });
    return;
  }
  const r = await pool.query(
    `INSERT INTO app_workspace_members (workspace_id, user_id, role)
     SELECT w.id, u.id, $3
       FROM app_workspaces w, app_users u
      WHERE w.id=$1 AND u.id=$2
        AND COALESCE(u.group_id,'default') = COALESCE(w.group_id,'default')
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [workspaceId, userId, role],
  );
  if (Number(r.rowCount ?? 0) === 0) {
    // Solo para el mensaje de error: la decisión ya la tomó la sentencia atómica.
    const u = await dbGetUserById(userId);
    const w = await dbGetWorkspace(workspaceId);
    if (!u) throw new Error("user no encontrado");
    if (!w) throw new Error("workspace no encontrado");
    throw new Error(`membership cross-group rechazada: user(${u.group_id || "default"}) ≠ workspace(${w.group_id || "default"})`);
  }
}

export async function dbRemoveWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
  if (!workspaceId || !userId) return;
  if (!pool) {
    mem.workspaceMembers = mem.workspaceMembers.filter((m) => !(m.workspace_id === workspaceId && m.user_id === userId));
    return;
  }
  await pool.query(
    "DELETE FROM app_workspace_members WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, userId],
  );
}

export async function dbUpdateWorkspaceMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<void> {
  if (!workspaceId || !userId) return;
  if (!pool) {
    const m = mem.workspaceMembers.find((x) => x.workspace_id === workspaceId && x.user_id === userId);
    if (m) m.role = role;
    return;
  }
  await pool.query(
    "UPDATE app_workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, userId, role],
  );
}

// ============================================================
// SEC-LAST-OWNER-TX (T05 2026-08-25) · quitar/degradar a un miembro con la
// invariante del último propietario COMPROBADA DENTRO de la operación.
// ------------------------------------------------------------
// Los endpoints de miembros comprobaban dbCountWorkspaceOwners y DESPUÉS
// escribían (check-then-act con awaits en medio): dos peticiones simultáneas,
// cada una legal por separado ("quita a X, queda Y" / "quita a Y, queda X"),
// pasaban las dos y el workspace quedaba SIN propietario — y desde
// SEC-ORPHAN-WS un ws sin miembros queda bloqueado sin auto-curación.
//  · Postgres: transacción con SELECT ... FOR UPDATE de las filas de miembros
//    del workspace → la segunda operación espera a la primera y re-lee el
//    estado ya cometido → detecta que era el último owner y aborta.
//  · Memoria: bloque 100% síncrono (sin awaits entre mirar y escribir) → el
//    event loop no puede intercalar la segunda petición a mitad.
// ============================================================
export async function dbTxRemoveWorkspaceMember(
  workspaceId: string,
  userId: string,
): Promise<{ ok: boolean; error?: string; notMember?: boolean }> {
  if (!workspaceId || !userId) return { ok: false, error: "workspaceId y userId requeridos" };
  if (!pool) {
    const target = mem.workspaceMembers.find((m) => m.workspace_id === workspaceId && m.user_id === userId);
    if (!target) return { ok: false, notMember: true, error: "ese usuario no es miembro de este workspace" };
    if (target.role === "owner") {
      const owners = mem.workspaceMembers.filter((m) => m.workspace_id === workspaceId && m.role === "owner").length;
      if (owners <= 1) return { ok: false, error: "es el único propietario de este workspace: asigna otro propietario antes de quitarlo (si no, el workspace se queda sin dueño y bloqueado)" };
    }
    mem.workspaceMembers = mem.workspaceMembers.filter((m) => !(m.workspace_id === workspaceId && m.user_id === userId));
    return { ok: true };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query(
      "SELECT user_id, role FROM app_workspace_members WHERE workspace_id=$1 FOR UPDATE",
      [workspaceId],
    );
    const members = rows.rows as Array<{ user_id: string; role: string }>;
    const target = members.find((m) => m.user_id === userId);
    if (!target) {
      await client.query("ROLLBACK");
      return { ok: false, notMember: true, error: "ese usuario no es miembro de este workspace" };
    }
    if (target.role === "owner" && members.filter((m) => m.role === "owner").length <= 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: "es el único propietario de este workspace: asigna otro propietario antes de quitarlo (si no, el workspace se queda sin dueño y bloqueado)" };
    }
    await client.query("DELETE FROM app_workspace_members WHERE workspace_id=$1 AND user_id=$2", [workspaceId, userId]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* noop */ }
    return { ok: false, error: (e as Error).message };
  } finally {
    client.release();
  }
}

export async function dbTxSetWorkspaceMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<{ ok: boolean; error?: string; notMember?: boolean; role?: WorkspaceRole }> {
  if (!workspaceId || !userId) return { ok: false, error: "workspaceId y userId requeridos" };
  if (!pool) {
    const target = mem.workspaceMembers.find((m) => m.workspace_id === workspaceId && m.user_id === userId);
    if (!target) return { ok: false, notMember: true, error: "ese usuario no es miembro de este workspace" };
    if (target.role === "owner" && role !== "owner") {
      const owners = mem.workspaceMembers.filter((m) => m.workspace_id === workspaceId && m.role === "owner").length;
      if (owners <= 1) return { ok: false, error: "es el único propietario de este workspace: asciende a otro propietario antes de cambiarle el rol (si no, el workspace se queda sin dueño)" };
    }
    target.role = role;
    return { ok: true, role: target.role };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query(
      "SELECT user_id, role FROM app_workspace_members WHERE workspace_id=$1 FOR UPDATE",
      [workspaceId],
    );
    const members = rows.rows as Array<{ user_id: string; role: string }>;
    const target = members.find((m) => m.user_id === userId);
    if (!target) {
      await client.query("ROLLBACK");
      return { ok: false, notMember: true, error: "ese usuario no es miembro de este workspace" };
    }
    if (target.role === "owner" && role !== "owner" && members.filter((m) => m.role === "owner").length <= 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: "es el único propietario de este workspace: asciende a otro propietario antes de cambiarle el rol (si no, el workspace se queda sin dueño)" };
    }
    await client.query("UPDATE app_workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2", [workspaceId, userId, role]);
    await client.query("COMMIT");
    return { ok: true, role };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* noop */ }
    return { ok: false, error: (e as Error).message };
  } finally {
    client.release();
  }
}

// ============================================================
// PERM-TX 2026-08-07 · comandos TRANSACCIONALES de permisos.
// ------------------------------------------------------------
// ANTES: admin.ts modificaba las memberships EN BUCLE, con un .catch()
// por concesión, y respondía {ok:true} pasara lo que pasara. Un corte de
// BD a mitad del lote dejaba al usuario movido de grupo con roles
// parciales (o sin ningún acceso) mientras la UI cantaba éxito. El rol
// además se hardcodeaba a 'editor' dentro del propio bucle de escritura.
// AHORA: un comando por operación (crear usuario / mover usuario /
// reemplazar concesiones). Se VALIDA TODO antes de escribir (existencia,
// pertenencia al grupo, rol válido, último propietario) y se escribe en
// UNA transacción: se aplica entera o no se aplica nada. Se devuelve el
// ESTADO EFECTIVO releído de BD, nunca lo que pidió el llamante.
// ============================================================
export const PERM_WS_ROLES: WorkspaceRole[] = ["owner", "admin", "editor", "viewer"];

/** Concesión con ROL EXPLÍCITO. No hay rol implícito en la capa de escritura. */
export interface UserWsGrant {
  workspace_id: string;
  role: WorkspaceRole;
}

export interface PermTxOutcome {
  ok: boolean;
  error?: string;
  /** Estado EFECTIVO tras la operación (releído de BD), no lo solicitado. */
  grants: { workspace_id: string; label: string; role: WorkspaceRole }[];
  group_id: string;
}

/**
 * TODAS las memberships del usuario, incluidas las de workspaces archivados
 * (dbListUserWorkspaces las oculta). Reemplazar concesiones sin verlas dejaría
 * huérfanas las de los archivados.
 */
export async function dbListUserMemberships(userId: string): Promise<UserWsGrant[]> {
  if (!userId) return [];
  if (!pool) {
    return mem.workspaceMembers
      .filter((m) => m.user_id === userId)
      .map((m) => ({ workspace_id: m.workspace_id, role: m.role }));
  }
  const r = await pool.query(
    "SELECT workspace_id, role FROM app_workspace_members WHERE user_id=$1",
    [userId],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    workspace_id: String(row.workspace_id),
    role: String(row.role) as WorkspaceRole,
  }));
}

export async function dbCountWorkspaceOwners(workspaceId: string): Promise<number> {
  if (!workspaceId) return 0;
  if (!pool) {
    return mem.workspaceMembers.filter((m) => m.workspace_id === workspaceId && m.role === "owner").length;
  }
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM app_workspace_members WHERE workspace_id=$1 AND role='owner'",
    [workspaceId],
  );
  return Number((r.rows[0] as { n: number })?.n || 0);
}

/**
 * Workspaces donde este usuario es el ÚNICO propietario. Quitárselos (o borrar
 * su identidad) dejaría el ws sin dueño y, desde SEC-ORPHAN-WS, un ws sin
 * miembros queda BLOQUEADO (ya no se auto-cura). Se exige transferir antes.
 */
export async function dbUserLastOwnerWorkspaces(userId: string): Promise<{ id: string; label: string }[]> {
  if (!userId) return [];
  const out: { id: string; label: string }[] = [];
  if (!pool) {
    for (const m of mem.workspaceMembers) {
      if (m.user_id !== userId || m.role !== "owner") continue;
      const others = mem.workspaceMembers.filter(
        (x) => x.workspace_id === m.workspace_id && x.role === "owner" && x.user_id !== userId,
      ).length;
      if (others === 0) {
        const w = mem.workspaces.get(m.workspace_id);
        out.push({ id: m.workspace_id, label: (w && w.label) || m.workspace_id });
      }
    }
    return out;
  }
  const r = await pool.query(
    `SELECT w.id AS id, COALESCE(w.label,'') AS label
       FROM app_workspace_members m
       JOIN app_workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1 AND m.role = 'owner'
        AND NOT EXISTS (
          SELECT 1 FROM app_workspace_members o
           WHERE o.workspace_id = m.workspace_id AND o.role = 'owner' AND o.user_id <> $1
        )
      ORDER BY w.label ASC`,
    [userId],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    label: String(row.label || row.id),
  }));
}

interface PermPlan {
  toAdd: UserWsGrant[];
  toRemove: string[];
  /** SEC-LAST-OWNER-TX · ws donde este usuario DEJA de ser owner con este plan.
   *  El plan ya verificó que quedaba otro owner, pero eso fue check-then-act:
   *  permWrite lo re-valida DENTRO de la transacción (FOR UPDATE) para que dos
   *  retiradas simultáneas de los dos owners no dejen el ws sin dueño. */
  ownerGuard: string[];
}

/**
 * Valida el lote COMPLETO y devuelve el plan de escritura, o el motivo por el
 * que no se puede aplicar. Nada se escribe aquí.
 *  · purgeForeign=true (mover de grupo): se retiran TODAS las memberships que
 *    no estén en el grupo destino (INV-1: una membership solo vale en su grupo).
 *  · purgeForeign=false: las de otros grupos ni se miran ni se tocan.
 */
async function permPlan(
  userId: string,
  targetGroup: string,
  grants: UserWsGrant[],
  purgeForeign: boolean,
): Promise<{ err: string } | { plan: PermPlan }> {
  const groupWs = new Map((await dbListWorkspaces(true, targetGroup)).map((w) => [w.id, w] as const));
  const want = new Map<string, WorkspaceRole>();
  for (const g of grants) {
    const wid = String(g?.workspace_id || "").trim();
    const role = String(g?.role || "").trim() as WorkspaceRole;
    if (!wid) return { err: "hay una concesión sin workspace" };
    if (!PERM_WS_ROLES.includes(role)) return { err: "rol inválido (owner|admin|editor|viewer)" };
    const w = groupWs.get(wid);
    if (!w) return { err: "el workspace " + wid + " no existe o no pertenece al grupo del usuario" };
    want.set(wid, role);
  }
  const current = new Map((await dbListUserMemberships(userId)).map((m) => [m.workspace_id, m.role] as const));
  const toRemove: string[] = [];
  for (const wid of current.keys()) {
    if (want.has(wid)) continue;
    if (!purgeForeign && !groupWs.has(wid)) continue; // ws de otro grupo: no se toca
    toRemove.push(wid);
  }
  const toAdd: UserWsGrant[] = [];
  for (const [wid, role] of want) if (current.get(wid) !== role) toAdd.push({ workspace_id: wid, role });
  // ÚLTIMO PROPIETARIO · perder la única propiedad de un ws lo deja sin dueño.
  const losing: string[] = [];
  const ownerGuard: string[] = [];
  for (const [wid, role] of current) {
    if (role !== "owner") continue;
    const stillOwner = want.get(wid) === "owner";
    const touched = toRemove.indexOf(wid) >= 0 || (!stillOwner && want.has(wid));
    if (!touched) continue;
    ownerGuard.push(wid);
    if ((await dbCountWorkspaceOwners(wid)) <= 1) losing.push(wid);
  }
  if (losing.length) {
    const names: string[] = [];
    for (const wid of losing) {
      const w = groupWs.get(wid) || (await dbGetWorkspace(wid).catch(() => null));
      names.push((w && w.label) || wid);
    }
    return {
      err: "es el único propietario de: " + names.join(", ") +
        ". Asigna otro propietario a esos workspaces en Workspaces antes de retirarle el acceso.",
    };
  }
  return { plan: { toAdd, toRemove, ownerGuard } };
}

/** Estado efectivo (releído): lo que el usuario TIENE, con etiqueta legible. */
async function permEffective(userId: string): Promise<PermTxOutcome["grants"]> {
  const rows = await dbListUserMemberships(userId);
  const out: PermTxOutcome["grants"] = [];
  for (const r of rows) {
    const w = await dbGetWorkspace(r.workspace_id).catch(() => null);
    out.push({ workspace_id: r.workspace_id, label: (w && w.label) || r.workspace_id, role: r.role });
  }
  return out;
}

/**
 * Escritura ATÓMICA del plan. Con Postgres, una única transacción
 * BEGIN/COMMIT. Sin pool (dev en memoria) se emula con snapshot + restore,
 * para que el comportamiento observable sea el mismo en los dos caminos.
 */
async function permWrite(opts: {
  userId: string;
  createUser?: {
    id: string; email: string; name: string; password_hash: string;
    role: "admin" | "member"; tenant_id?: string; group_id: string;
    allowed_views?: string[] | null;
  };
  setGroup?: string;
  toRemove: string[];
  toAdd: UserWsGrant[];
  /** SEC-LAST-OWNER-TX · ws que deben conservar ≥1 owner tras esta escritura
   *  (los calcula permPlan). Se re-validan DENTRO de la transacción. */
  ownerGuard?: string[];
}): Promise<void> {
  if (!pool) {
    const snapMembers = mem.workspaceMembers.map((m) => ({ ...m }));
    const prev = memUsers.get(opts.userId);
    const snapUser: AppUserWithHash | null = prev ? { ...prev } : null;
    try {
      if (opts.createUser) {
        const c = opts.createUser;
        // SEC-DUP-EMAIL (T05 2026-08-25) · el dup-check del endpoint es
        // check-then-act con awaits en medio: dos altas simultáneas del mismo
        // email pasaban las dos (probado en P12 de test/tenancy) y quedaban dos
        // identidades con el mismo login. En Postgres lo frena el índice único
        // idx_users_email_global; este chequeo SÍNCRONO dentro del bloque de
        // escritura (sin await entre mirar y escribir) es el equivalente en
        // memoria. Mismo mensaje que el endpoint para no filtrar detalles.
        const lcEmail = c.email.trim().toLowerCase();
        for (const u of memUsers.values()) {
          if (u.email.toLowerCase() === lcEmail) throw new Error("ya existe un usuario con ese nombre");
        }
        // Colisión de id: sin este guard, un createUser con id existente
        // sobrescribía al usuario y el rollback del catch lo BORRABA del todo.
        if (memUsers.has(c.id)) throw new Error("user.id duplicado: " + c.id);
        memUsers.set(c.id, {
          id: c.id, tenant_id: c.tenant_id || "default", group_id: c.group_id,
          email: c.email.trim(), name: c.name.trim(), password_hash: c.password_hash,
          role: c.role, active: true, created_at: new Date().toISOString(),
          last_login_at: null, allowed_views: c.allowed_views ?? null, session_version: 1,
        });
      }
      if (opts.setGroup) { const u = memUsers.get(opts.userId); if (u) u.group_id = opts.setGroup; }
      for (const wid of opts.toRemove) {
        mem.workspaceMembers = mem.workspaceMembers.filter(
          (m) => !(m.workspace_id === wid && m.user_id === opts.userId),
        );
      }
      for (const g of opts.toAdd) {
        const i = mem.workspaceMembers.findIndex((m) => m.workspace_id === g.workspace_id && m.user_id === opts.userId);
        if (i >= 0) mem.workspaceMembers[i].role = g.role;
        else mem.workspaceMembers.push({ workspace_id: g.workspace_id, user_id: opts.userId, role: g.role, created_at: Date.now() });
      }
      // SEC-LAST-OWNER-TX · re-validación en el MISMO bloque síncrono que la
      // escritura: si otra operación intercalada retiró al otro owner, aquí el
      // recuento sale 0 y el snapshot del catch deshace todo.
      for (const wid of opts.ownerGuard || []) {
        const owners = mem.workspaceMembers.filter((m) => m.workspace_id === wid && m.role === "owner").length;
        if (owners < 1) throw new Error("el workspace se quedaría sin propietario (otro cambio simultáneo retiró al otro propietario)");
      }
    } catch (e) {
      mem.workspaceMembers = snapMembers;
      if (opts.createUser) memUsers.delete(opts.userId);
      else if (snapUser) memUsers.set(opts.userId, snapUser);
      throw e;
    }
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // SEC-LAST-OWNER-TX · bloquear las filas de miembros de los ws con riesgo de
    // quedarse sin owner ANTES de escribir: una segunda transacción concurrente
    // espera aquí y, al despertar, re-lee el estado YA cometido por la primera.
    for (const wid of opts.ownerGuard || []) {
      await client.query("SELECT user_id FROM app_workspace_members WHERE workspace_id=$1 FOR UPDATE", [wid]);
    }
    if (opts.createUser) {
      const c = opts.createUser;
      await client.query(
        `INSERT INTO app_users (id, tenant_id, group_id, email, name, password_hash, role, active, allowed_views)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb)`,
        [
          c.id, c.tenant_id || "default", c.group_id, c.email.trim(), c.name.trim(),
          c.password_hash, c.role, c.allowed_views == null ? null : JSON.stringify(c.allowed_views),
        ],
      );
    }
    if (opts.setGroup) {
      await client.query("UPDATE app_users SET group_id=$2 WHERE id=$1", [opts.userId, opts.setGroup]);
    }
    for (const wid of opts.toRemove) {
      await client.query("DELETE FROM app_workspace_members WHERE workspace_id=$1 AND user_id=$2", [wid, opts.userId]);
    }
    for (const g of opts.toAdd) {
      await client.query(
        `INSERT INTO app_workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [g.workspace_id, opts.userId, g.role],
      );
    }
    // SEC-LAST-OWNER-TX · re-recuento con las filas bloqueadas: 0 owners = abortar.
    for (const wid of opts.ownerGuard || []) {
      const oc = await client.query(
        "SELECT COUNT(*)::int AS n FROM app_workspace_members WHERE workspace_id=$1 AND role='owner'",
        [wid],
      );
      if (Number((oc.rows[0] as { n: number })?.n || 0) < 1) {
        throw new Error("el workspace se quedaría sin propietario (otro cambio simultáneo retiró al otro propietario)");
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* noop */ }
    // SEC-DUP-EMAIL · la violación del índice único global de email (carrera de
    // dos altas simultáneas) sale como el MISMO error que el dup-check del
    // endpoint, no como un volcado de constraint de Postgres.
    if ((e as { code?: string }).code === "23505" && /email/i.test(String((e as Error).message || ""))) {
      throw new Error("ya existe un usuario con ese nombre");
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Comando: el usuario queda con EXACTAMENTE estas concesiones en SU grupo. */
export async function dbTxReplaceUserGrants(userId: string, grants: UserWsGrant[]): Promise<PermTxOutcome> {
  const u = await dbGetUserById(userId);
  if (!u) return { ok: false, error: "usuario no encontrado", grants: [], group_id: "" };
  const gid = u.group_id || "default";
  const planned = await permPlan(userId, gid, grants, false);
  if ("err" in planned) return { ok: false, error: planned.err, grants: await permEffective(userId), group_id: gid };
  try {
    await permWrite({ userId, toRemove: planned.plan.toRemove, toAdd: planned.plan.toAdd, ownerGuard: planned.plan.ownerGuard });
  } catch (e) {
    console.error(`[perm-tx] replace grants ${userId} ABORTADO: ${(e as Error).message}`);
    return {
      ok: false,
      error: "no se pudo aplicar el cambio de accesos (no se ha cambiado nada): " + (e as Error).message,
      grants: await permEffective(userId).catch(() => []),
      group_id: gid,
    };
  }
  return { ok: true, grants: await permEffective(userId), group_id: gid };
}

/** Comando: mueve al usuario de business group Y fija sus concesiones allí. */
export async function dbTxMoveUserToGroup(
  userId: string,
  newGroupId: string,
  grants: UserWsGrant[],
): Promise<PermTxOutcome> {
  const u = await dbGetUserById(userId);
  if (!u) return { ok: false, error: "usuario no encontrado", grants: [], group_id: "" };
  const gid = String(newGroupId || "").trim();
  if (!gid) return { ok: false, error: "grupo destino requerido", grants: await permEffective(userId), group_id: u.group_id || "default" };
  if (gid !== "default") {
    const g = await dbGetBusinessGroup(gid).catch(() => null);
    if (!g || g.archived) {
      return { ok: false, error: "grupo destino inválido o archivado", grants: await permEffective(userId), group_id: u.group_id || "default" };
    }
  }
  const planned = await permPlan(userId, gid, grants, true);
  if ("err" in planned) {
    return { ok: false, error: planned.err, grants: await permEffective(userId), group_id: u.group_id || "default" };
  }
  try {
    await permWrite({ userId, setGroup: gid, toRemove: planned.plan.toRemove, toAdd: planned.plan.toAdd, ownerGuard: planned.plan.ownerGuard });
  } catch (e) {
    console.error(`[perm-tx] move ${userId} → ${gid} ABORTADO: ${(e as Error).message}`);
    return {
      ok: false,
      error: "no se pudo mover al usuario (no se ha cambiado nada): " + (e as Error).message,
      grants: await permEffective(userId).catch(() => []),
      group_id: u.group_id || "default",
    };
  }
  return { ok: true, grants: await permEffective(userId), group_id: gid };
}

/** Comando: alta de usuario + sus concesiones, todo o nada. */
export async function dbTxCreateUserWithGrants(input: {
  id: string; email: string; name: string; password_hash: string;
  role: "admin" | "member"; group_id: string; tenant_id?: string;
  allowed_views?: string[] | null;
  grants: UserWsGrant[];
}): Promise<PermTxOutcome> {
  const gid = input.group_id || "default";
  const planned = await permPlan(input.id, gid, input.grants, false);
  if ("err" in planned) return { ok: false, error: planned.err, grants: [], group_id: gid };
  try {
    await permWrite({
      userId: input.id,
      createUser: {
        id: input.id, email: input.email, name: input.name, password_hash: input.password_hash,
        role: input.role, tenant_id: input.tenant_id, group_id: gid, allowed_views: input.allowed_views ?? null,
      },
      toRemove: [],
      toAdd: planned.plan.toAdd,
      ownerGuard: planned.plan.ownerGuard,
    });
  } catch (e) {
    console.error(`[perm-tx] alta ${emailLog(input.email)} ABORTADA: ${(e as Error).message}`);
    return {
      ok: false,
      error: "no se pudo crear el usuario con sus accesos (no se ha creado nada): " + (e as Error).message,
      grants: [],
      group_id: gid,
    };
  }
  return { ok: true, grants: await permEffective(input.id), group_id: gid };
}

// ============================================================
// HEAL-ORPHAN-WS 2026-06-04 → SEC-ORPHAN-WS 2026-08-07 · YA NO CURA.
// ------------------------------------------------------------
// ANTES: en CADA boot (y por endpoint) detectaba workspaces activos SIN
// ningun member y anadia a TODOS los users del grupo como owner
// (INSERT ... CROSS JOIN). Eso era una escalada de privilegios
// silenciosa: bastaba con que un ws se quedara sin miembros (p.ej. al
// borrar al ultimo) para que cualquier viewer/editor del grupo pasara a
// owner en el siguiente reinicio, sin que nadie lo pidiera ni lo viera.
// El argumento que lo justificaba ("un ws sin members ya esta perdido")
// era FALSO: un group-admin alcanza cualquier ws de SU grupo sin
// membership explicita (ver wsMembership en admin.ts) y el env-admin
// tiene acceso global, asi que el ws seguia siendo recuperable por la
// via legitima.
// AHORA: solo DETECTA y AVISA. El workspace huerfano queda bloqueado
// (sin miembros = sin acceso por membership) y la recuperacion es
// explicita y auditada: un env-admin / group-admin asigna UN owner
// concreto via POST /admin/api/workspaces/:id/members (role=owner).
// Cero INSERTs aqui. Se sigue llamando:
//   - una vez al boot (initDb), tras seeds  → alerta si hay huerfanos.
//   - on-demand via GET /admin/api/_heal-orphan-workspaces (env-admin).
// Devuelve {healed:0, created:0, orphans:[...]} — healed/created se
// mantienen a 0 por compatibilidad con los dos callers.
// ============================================================
export interface OrphanWorkspaceInfo {
  id: string;
  label: string;
  group_id: string;
}
export async function healOrphanWorkspaces(): Promise<{
  healed: number;
  created: number;
  orphans: OrphanWorkspaceInfo[];
}> {
  const orphans: OrphanWorkspaceInfo[] = [];
  if (!pool) {
    for (const w of mem.workspaces.values()) {
      // WS-USER-ISOLATION: 'default' (negocio del owner/env-admin) nunca cuenta
      // como huerfano (env-admin tiene acceso global; default sin filas es correcto).
      if (w.archived || w.id === "default") continue;
      if (mem.workspaceMembers.some((m) => m.workspace_id === w.id)) continue;
      orphans.push({ id: w.id, label: w.label || "", group_id: w.group_id || "default" });
    }
  } else {
    const q = await pool.query(
      `SELECT w.id, w.label, COALESCE(w.group_id,'default') AS group_id
         FROM app_workspaces w
        WHERE w.archived = false
          AND w.id <> 'default'
          AND NOT EXISTS (
            SELECT 1 FROM app_workspace_members m WHERE m.workspace_id = w.id
          )
        ORDER BY w.created_at ASC`,
    );
    for (const r of q.rows) {
      orphans.push({
        id: String(r.id),
        label: String(r.label || ""),
        group_id: String(r.group_id || "default"),
      });
    }
  }
  if (orphans.length) {
    const detalle = orphans.map((o) => o.label + " (" + o.id + ")").join(", ");
    console.warn(
      "[ws-orphan] " + orphans.length + " workspace(s) SIN miembros → acceso BLOQUEADO (no se auto-curan). " +
      "Asigna un owner concreto desde el panel (Miembros del workspace): " + detalle,
    );
    // Alerta persistente para el env-admin: la escribimos en el tenant 'default'
    // (su negocio) porque el ws huerfano no tiene a nadie que pueda verla.
    try {
      await dbInsertActivity({
        tenant_id: "default",
        source: "app",
        level: "error",
        status: "orphan-workspace",
        summary:
          orphans.length + " workspace(s) sin miembros: acceso bloqueado hasta asignar un owner",
        payload: {
          file: "db.ts",
          fn: "healOrphanWorkspaces",
          orphans,
          fix: "POST /admin/api/workspaces/:id/members con role=owner (owner concreto, auditado)",
        },
      });
    } catch { /* la alerta nunca puede tumbar el boot */ }
  }
  return { healed: 0, created: 0, orphans };
}

// ============================================================
// WS-USER-ISOLATION 2026-06-20 · migración + provisioning.
//   Parte A (idempotente, cada boot): cada user-DB sin workspace propio (≠
//   'default') recibe su PROPIO Business Group (si aún estaba en 'default') y
//   su PROPIO workspace vacío (owner). Compone con bizgroups: el ws vive en el
//   grupo propio del usuario → userAuthorizedForWs deniega el 'default' del
//   owner incluso con BIZGROUPS_ENFORCE OFF.
//   Parte B (one-shot, marker app_migrations): retira a TODOS los users-DB del
//   workspace 'default' (negocio del owner). env-admin conserva acceso global.
// Kill-switch: WS_SKIP_USER_ISOLATION_MIGRATION=true.
// ============================================================
// WS-USER-ISOLATION 2026-06-21 · provisión IDEMPOTENTE del workspace de UN usuario,
// llamable en caliente desde el guard para auto-reparar a un huérfano en su próxima
// petición (sin esperar a un reboot). Si ya tiene un ws propio (≠default) lo devuelve;
// si no, crea su grupo (si falta/huérfano) + su workspace + membership owner.
export async function dbEnsureUserWorkspace(userId: string): Promise<string | null> {
  if (!userId) return null;
  const sane = (s: string): string =>
    (String(s || "").replace(/[^A-Za-z0-9 _\-.,:&()/+!?À-ſ]/g, "").trim() || "Mi negocio").slice(0, 80);
  if (!pool) {
    seedDefaultWorkspaceInMem();
    const existing = mem.workspaceMembers.find((m) => m.user_id === userId && m.workspace_id !== "default");
    if (existing) return existing.workspace_id;
    const u = memUsers.get(userId); if (!u) return null;
    // TEAM-HIJACK BACKSTOP 2026-07-12 · NUNCA auto-aislar a un usuario del grupo 'default'
    // (equipo del owner). Si un miembro de equipo queda sin workspace (p.ej. le quitaron
    // todas las membresías), self-heal-arlo lo SACARÍA del equipo (nuevo grupo) y el boot
    // lo ascendería a admin (secuestro silencioso). Devolvemos null → el guard responde
    // 403 "sin espacio, contacta con el admin" y el owner le reasigna un workspace.
    if ((u.group_id || "default") === "default") return null;
    // REVOKE-NO-RESURRECT (T05 2026-08-25) · mismo criterio que el backstop de
    // arriba, extendido a los grupos GESTIONADOS: si el grupo del usuario tiene
    // un group-admin activo (≠ él mismo), quedarse sin workspaces es una
    // DECISIÓN de ese admin (revocación), no un huérfano accidental. Antes, la
    // siguiente petición del revocado le auto-creaba un ws vacío en el mismo
    // grupo — la revocación «resucitaba» sola y nadie lo pedía (H-SELFHEAL de
    // test/tenancy). El cliente aislado (grupo propio sin admins) se sigue
    // auto-reparando igual que siempre.
    if (u.role !== "admin") {
      const gidU = u.group_id || "default";
      const hasAdmin = [...memUsers.values()].some(
        (x) => x.id !== userId && (x.group_id || "default") === gidU && x.role === "admin" && x.active,
      );
      if (hasAdmin) return null;
    }
    const label = sane(u.name || u.email);
    let gid = u.group_id || "default";
    if (gid === "default" || !mem.businessGroups.has(gid)) {
      const grp = await dbCreateBusinessGroup({ label, created_by: u.email || "env-admin" });
      gid = grp.id; u.group_id = gid;
    }
    const ws = await dbCreateWorkspace({ label, created_by: u.email || "env-admin", group_id: gid });
    mem.workspaceMembers.push({ workspace_id: ws.id, user_id: userId, role: "owner", created_at: Date.now() });
    return ws.id;
  }
  try {
    const ex = await pool.query("SELECT workspace_id FROM app_workspace_members WHERE user_id=$1 AND workspace_id<>'default' LIMIT 1", [userId]);
    if (ex.rows[0]) return String(ex.rows[0].workspace_id);
    const ur = await pool.query("SELECT id, email, name, group_id FROM app_users WHERE id=$1 LIMIT 1", [userId]);
    const u = ur.rows[0] as { id: string; email: string; name: string; group_id: string } | undefined;
    if (!u) return null;
    // TEAM-HIJACK BACKSTOP 2026-07-12 (ver rama in-memory): a un usuario del grupo 'default'
    // (equipo del owner) NUNCA se le crea un grupo/workspace propio ni se le mueve de grupo.
    // Evita que quitarle sus workspaces lo convierta solo en un cliente aislado + admin.
    if ((u.group_id || "default") === "default") return null;
    // REVOKE-NO-RESURRECT (T05 2026-08-25) · ver rama in-memory: en un grupo con
    // group-admin activo, la revocación total NO se auto-repara (403 dead-end
    // hasta que ese admin reasigne o desactive).
    const ur2 = await pool.query("SELECT role FROM app_users WHERE id=$1 LIMIT 1", [userId]);
    const roleU = String((ur2.rows[0] as { role?: string } | undefined)?.role || "member");
    if (roleU !== "admin") {
      const adm = await pool.query(
        "SELECT 1 FROM app_users WHERE COALESCE(group_id,'default')=COALESCE($1,'default') AND role='admin' AND active=true AND id<>$2 LIMIT 1",
        [u.group_id || "default", userId],
      );
      if (adm.rows[0]) return null;
    }
    const label = sane(u.name || u.email);
    let gid = u.group_id || "default";
    let needGroup = gid === "default";
    if (!needGroup) {
      const g = await pool.query("SELECT 1 FROM app_business_groups WHERE id=$1 AND archived=false LIMIT 1", [gid]);
      if (!g.rows[0]) needGroup = true;
    }
    let newGid = "";
    if (needGroup) {
      const grp = await dbCreateBusinessGroup({ label, created_by: u.email || "env-admin" });
      newGid = grp.id; gid = grp.id;
    }
    const ws = await dbCreateWorkspace({ label, created_by: u.email || "env-admin", group_id: gid });
    // INV-1: el usuario DEBE estar en el grupo del ws ANTES de la membership, o
    // dbAddWorkspaceMember rechaza cross-group. Mover grupo → luego membership.
    if (newGid) await pool.query("UPDATE app_users SET group_id=$1 WHERE id=$2", [newGid, userId]);
    await dbAddWorkspaceMember(ws.id, userId, "owner");
    return ws.id;
  } catch (e) {
    console.warn(`[db] dbEnsureUserWorkspace ${userId} falló: ${(e as Error).message}`);
    return null;
  }
}

async function migrateUserIsolationV1(): Promise<void> {
  if (!pool) return; // dev in-memory: no aplica (sin tenants reales)
  if (process.env.WS_SKIP_USER_ISOLATION_MIGRATION === "true") {
    console.log("[db] ws_user_isolation_v1 SALTADA (env).");
    return;
  }
  const saneLabel = (s: string): string =>
    (String(s || "").replace(/[^A-Za-z0-9 _\-.,:&()/+!?À-ſ]/g, "").trim() || "Mi negocio").slice(0, 80);
  // Parte A · provisioning idempotente y PER-USER ATÓMICO: a cada user HUÉRFANO (sin
  // NINGÚN workspace) se le crea su grupo (si seguía en 'default') + su ws (owner). El
  // UPDATE de group_id se hace SOLO tras crear el ws con éxito → si algo falla, el
  // user queda intacto en 'default' (acceso original, SIN lockout) y se reintenta en
  // el próximo boot. Cada user es independiente (sin transacción global).
  //
  // TEAM-MEMBER FIX 2026-07-12 (bug grave) · ANTES el filtro era
  //   `NOT EXISTS (… m.user_id = u.id AND m.workspace_id <> 'default')`
  // = "usuarios sin ningún workspace DISTINTO de 'default'". Eso arrastraba a los
  // MIEMBROS DE EQUIPO legítimos, cuyo único workspace es precisamente el del owner
  // ('default'): en el siguiente boot se les creaba un grupo propio, se les MOVÍA de
  // grupo (fuera del equipo), la Parte B les borraba la membresía de 'default' y la
  // rutina promote-group-owner los ascendía a admin de su grupo nuevo. Resultado: un
  // compañero de equipo se convertía solo en un cliente aislado y perdía todo acceso al
  // negocio del owner. Verificado en prod con un usuario de prueba.
  // AHORA solo se provisiona al HUÉRFANO REAL (cero membresías): si tiene acceso a algún
  // workspace —aunque sea el 'default' del owner porque es staff— ya tiene dónde trabajar
  // y NO se toca. Los CLIENTES nuevos siguen naciendo aislados en create-user (grupo +
  // workspace propios, nunca miembros de 'default'), así que el aislamiento no se debilita.
  let createdGroups = 0;
  let createdWs = 0;
  try {
    // REVOKE-NO-RESURRECT (T05 2026-08-25) · el boot tampoco re-provisiona a un
    // usuario cuyo grupo tiene un group-admin activo: su falta de workspaces es
    // una revocación deliberada (misma regla que dbEnsureUserWorkspace). Sin
    // este filtro, el revocado «resucitaba» en el siguiente reinicio aunque el
    // self-heal en caliente ya lo negara.
    const usersNoWs = (await pool.query(
      `SELECT u.id, u.email, u.name, u.group_id
         FROM app_users u
        WHERE NOT EXISTS (
          SELECT 1 FROM app_workspace_members m WHERE m.user_id = u.id
        )
          AND (u.role = 'admin' OR NOT EXISTS (
            SELECT 1 FROM app_users a
             WHERE COALESCE(a.group_id,'default') = COALESCE(u.group_id,'default')
               AND a.role='admin' AND a.active=true AND a.id <> u.id
          ))`,
    )).rows as Array<{ id: string; email: string; name: string; group_id: string }>;
    for (const u of usersNoWs) {
      try {
        const label = saneLabel(u.name || u.email);
        let gid = u.group_id || "default";
        let newGid = "";
        // El grupo es 'default' (negocio del owner) O un grupo HUÉRFANO/inexistente
        // (provisioning previo a medias) → en ambos casos hay que darle un grupo propio
        // VÁLIDO. Sin esto, dbCreateWorkspace(group_id inexistente) falla por FK y el
        // user queda SIN workspace → 403 del guard → (vía el bug de api()) ve todas las
        // vistas y Conexiones en blanco. SELF-HEAL del estado huérfano.
        let needGroup = gid === "default";
        if (!needGroup) {
          const g = await pool.query("SELECT 1 FROM app_business_groups WHERE id=$1 AND archived=false LIMIT 1", [gid]);
          if (!g.rows[0]) needGroup = true;
        }
        if (needGroup) {
          const grp = await dbCreateBusinessGroup({ label, created_by: u.email || "env-admin" });
          newGid = grp.id; gid = grp.id;
        }
        const ws = await dbCreateWorkspace({ label, created_by: u.email || "env-admin", group_id: gid });
        // INV-1: mover al usuario al grupo del ws ANTES de la membership (si no,
        // dbAddWorkspaceMember rechaza cross-group user(default)≠workspace(nuevo)).
        if (newGid) { await pool.query("UPDATE app_users SET group_id=$1 WHERE id=$2", [newGid, u.id]); createdGroups++; }
        await dbAddWorkspaceMember(ws.id, u.id, "owner");
        createdWs++;
      } catch (e) {
        console.warn(`[db] ws_user_isolation_v1 provisioning user=${u.id} falló (se reintenta próximo boot): ${(e as Error).message}`);
      }
    }
  } catch (e) {
    console.warn(`[db] ws_user_isolation_v1 provisioning error: ${(e as Error).message}`);
  }
  // Parte B · retiro de 'default' SOLO para users ya AISLADOS (grupo propio ≠'default'
  // Y con ws propio ≠'default'). Un user con provisioning fallido (sigue en 'default',
  // sin ws) conserva su acceso original → NUNCA lockout. No toca a staff legítimo del
  // grupo 'default'. Idempotente y seguro cada boot (sin marker).
  try {
    const del = await pool.query(
      `DELETE FROM app_workspace_members dm
        WHERE dm.workspace_id = 'default'
          AND EXISTS (SELECT 1 FROM app_users u WHERE u.id = dm.user_id AND COALESCE(u.group_id,'default') <> 'default')
          AND EXISTS (SELECT 1 FROM app_workspace_members m WHERE m.user_id = dm.user_id AND m.workspace_id <> 'default')`,
    );
    if ((del.rowCount ?? 0) > 0 || createdGroups > 0 || createdWs > 0) {
      console.log(`[db] ws_user_isolation_v1: ${createdGroups} grupos + ${createdWs} ws personales · ${del.rowCount ?? 0} membresías 'default' retiradas (solo users aislados; env-admin global).`);
    }
  } catch (e) {
    console.warn(`[db] ws_user_isolation_v1 retiro 'default' error: ${(e as Error).message}`);
  }
}

// ============================================================
// WS-USER-ISOLATION 2026-06-22 · LIMPIEZA de chatarra del bucle de provisioning
// PREVIO al fix de orden: cada intento creaba grupo+workspace y la membership
// fallaba cross-group (INV-1) → sin rollback → grupo+ws HUÉRFANOS. Con el fix de
// orden ya no se generan.
// SEC-ORPHAN-WS 2026-08-07 · esta función YA NO BORRA WORKSPACES sin miembros
// (ver punto 1): la premisa "un workspace legítimo SIEMPRE tiene ≥1 miembro" deja
// de valer en cuanto alguien borra al último miembro de un ws con datos reales.
// Quedan el dedupe one-shot de ws auto-generados y el barrido de grupos vacíos.
// ============================================================
async function cleanupProvisioningGarbageV1(): Promise<void> {
  if (!pool) return;
  // 1. RETIRADO · SEC-ORPHAN-WS 2026-08-07.
  //    Aquí había un DELETE permanente, en CADA boot, de TODO workspace sin
  //    miembros (archivados incluidos, sin pasar por el gate "solo archivados"
  //    del endpoint DELETE). Convivía con la auto-curación: healOrphanWorkspaces
  //    metía miembros justo antes y este barrido no encontraba nada. Al quitar
  //    la auto-curación (era una escalada de privilegios silenciosa), este DELETE
  //    pasaría a BORRAR el workspace huérfano y sus datos en el reinicio
  //    siguiente: cambiar una escalada por una pérdida de datos silenciosa.
  //    Ahora un workspace sin miembros queda BLOQUEADO y con alerta
  //    (healOrphanWorkspaces) hasta que un admin decida: asignarle un owner
  //    concreto, o archivarlo y borrarlo a mano (explícito y auditado).

  // 2. (ONE-SHOT, marker) Dedupe de workspaces AUTO-generados: si un usuario es owner de
  //    ≥2 workspaces cuyo label == su propio nombre/email (= los creó el provisioning, NO
  //    a propósito con nombre custom) → conserva el más antiguo y ARCHIVA el resto.
  //    One-shot: NO toca workspaces homónimos que el usuario cree en el futuro
  //    (modelo: un usuario PUEDE crear sus propios workspaces).
  //    WS-LIFECYCLE 2026-08-07 · antes era un DELETE de la fila del workspace, y por
  //    tanto la MISMA fuga que arregla dbPurgeWorkspace: si el duplicado tenía datos,
  //    sus contactos/conversaciones/settings quedaban con el tenant_id colgando y sin
  //    ruta de exportación. Un heurístico de label que se ejecuta solo en el arranque
  //    no puede ser quien destruya datos personales. Ahora los archiva: desaparecen de
  //    las listas activas igual, arrancan la retención y el operador decide (restaurar
  //    o purgar con export previo por el camino auditado).
  try {
    const m = await pool.query(
      "INSERT INTO app_migrations (id) VALUES ('cleanup_dup_autows_v1') ON CONFLICT (id) DO NOTHING RETURNING id",
    );
    if (m.rows[0]) {
      const d = await pool.query(
        `WITH auto AS (
           SELECT m.workspace_id,
                  ROW_NUMBER() OVER (PARTITION BY m.user_id ORDER BY w.created_at ASC, w.id ASC) AS rn
             FROM app_workspace_members m
             JOIN app_workspaces w ON w.id = m.workspace_id
             JOIN app_users u ON u.id = m.user_id
            WHERE m.role='owner' AND m.workspace_id <> 'default' AND w.archived=false
              AND LOWER(TRIM(w.label)) = LOWER(TRIM(COALESCE(NULLIF(u.name,''), u.email)))
         )
         UPDATE app_workspaces w
            SET archived=true,
                archived_at=COALESCE(w.archived_at, now()),
                updated_at=now()
           FROM auto a
          WHERE w.id = a.workspace_id AND a.rn > 1`,
      );
      if ((d.rowCount ?? 0) > 0) console.log(`[db] cleanup-garbage: ${d.rowCount} workspace(s) auto-duplicados ARCHIVADOS (se conserva el más antiguo por usuario). Sus datos siguen intactos: revísalos y púrgalos desde Workspaces si sobran.`);
    }
  } catch (e) { console.warn(`[db] cleanup-garbage dedupe: ${(e as Error).message}`); }

  // 3. (permanente, idempotente) Grupos huérfanos: sin workspaces NI usuarios (≠'default'). Borra.
  try {
    const r = await pool.query(
      `DELETE FROM app_business_groups g
        WHERE g.id <> 'default'
          AND NOT EXISTS (SELECT 1 FROM app_workspaces w WHERE w.group_id = g.id)
          AND NOT EXISTS (SELECT 1 FROM app_users u WHERE u.group_id = g.id)`,
    );
    if ((r.rowCount ?? 0) > 0) console.log(`[db] cleanup-garbage: ${r.rowCount} grupo(s) huérfano(s) borrados.`);
  } catch (e) { console.warn(`[db] cleanup-garbage grupos huérfanos: ${(e as Error).message}`); }
}

// ============================================================
// BIZGROUPS · reconcilia memberships cruzadas (user de un grupo vinculado a un
// workspace de OTRO grupo). Idempotente. Hoy (todo 'default') = 0 filas; su valor
// real es la pasada previa al flip de BIZGROUPS_ENFORCE=on. Destructivo sobre
// app_workspace_members (solo borra cruces, nunca memberships válidas).
// ============================================================
export async function dbReconcileCrossGroupMemberships(): Promise<{ removed: number }> {
  if (!pool) {
    const wsGroup = new Map([...mem.workspaces.values()].map((w) => [w.id, w.group_id || "default"]));
    let removed = 0;
    mem.workspaceMembers = mem.workspaceMembers.filter((m) => {
      const ug = memUsers.get(m.user_id)?.group_id || "default";
      const wg = wsGroup.get(m.workspace_id) || "default";
      if (ug !== wg) { removed++; return false; }
      return true;
    });
    return { removed };
  }
  const r = await pool.query(`
    DELETE FROM app_workspace_members m
     USING app_users u, app_workspaces w
     WHERE m.user_id=u.id AND m.workspace_id=w.id
       AND COALESCE(u.group_id,'default') <> COALESCE(w.group_id,'default')`);
  return { removed: Number(r.rowCount ?? 0) };
}

// ============================================================
// BUSINESS GROUPS · CRUD. El grupo 'default' es inmutable (no se renombra-id,
// no se archiva, no se borra). Borrar/archivar exige grupo VACÍO (0 workspaces
// incl. archivados AND 0 usuarios incl. inactivos) — el FK RESTRICT es la red.
// ============================================================
export interface BusinessGroupWithCounts extends BusinessGroup {
  workspaces: number;
  users: number;
}

function rowToBusinessGroup(r: Record<string, unknown>): BusinessGroup {
  return {
    id: String(r.id),
    label: String(r.label ?? ""),
    slug: String(r.slug ?? ""),
    brand_color: String(r.brand_color ?? "#6366f1"),
    archived: !!r.archived,
    created_by: String(r.created_by ?? "env-admin"),
    created_at: r.created_at ? new Date(r.created_at as string).getTime() : 0,
    updated_at: r.updated_at ? new Date(r.updated_at as string).getTime() : 0,
  };
}

function seedDefaultBusinessGroupInMem(): void {
  if (mem.businessGroups.has("default")) return;
  const now = Date.now();
  mem.businessGroups.set("default", {
    id: "default", label: "Grupo principal", slug: "default", brand_color: "#6366f1",
    archived: false, created_by: "env-admin", created_at: now, updated_at: now,
  });
}

export async function dbListBusinessGroups(includeArchived = false): Promise<BusinessGroupWithCounts[]> {
  if (!pool) {
    seedDefaultBusinessGroupInMem();
    return [...mem.businessGroups.values()]
      .filter((g) => includeArchived || !g.archived)
      .sort((a, b) => a.created_at - b.created_at)
      .map((g) => ({
        ...g,
        workspaces: [...mem.workspaces.values()].filter((w) => (w.group_id || "default") === g.id).length,
        users: [...memUsers.values()].filter((u) => (u.group_id || "default") === g.id).length,
      }));
  }
  const where = includeArchived ? "" : " WHERE g.archived=false";
  const r = await pool.query(`
    SELECT g.id,g.label,g.slug,g.brand_color,g.archived,g.created_by,g.created_at,g.updated_at,
      (SELECT COUNT(*)::int FROM app_workspaces w WHERE w.group_id=g.id) AS workspaces,
      (SELECT COUNT(*)::int FROM app_users u WHERE u.group_id=g.id) AS users
    FROM app_business_groups g${where} ORDER BY g.created_at ASC`);
  return r.rows.map((row) => ({ ...rowToBusinessGroup(row), workspaces: Number(row.workspaces || 0), users: Number(row.users || 0) }));
}

export async function dbGetBusinessGroup(id: string): Promise<BusinessGroup | null> {
  if (!id) return null;
  if (!pool) { seedDefaultBusinessGroupInMem(); return mem.businessGroups.get(id) ?? null; }
  const r = await pool.query(
    "SELECT id,label,slug,brand_color,archived,created_by,created_at,updated_at FROM app_business_groups WHERE id=$1 LIMIT 1",
    [id],
  );
  return r.rows[0] ? rowToBusinessGroup(r.rows[0]) : null;
}

export async function dbCreateBusinessGroup(input: {
  id?: string; label: string; slug?: string; brand_color?: string; created_by?: string;
}): Promise<BusinessGroup> {
  const label = (input.label || "").trim();
  if (!label) throw new Error("group.label requerido");
  assertValidWsLabel(label);
  if (input.brand_color !== undefined && input.brand_color !== "") assertValidBrandColor(input.brand_color);
  const id = (input.id || "").trim() || (globalThis.crypto?.randomUUID?.() ?? `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const baseSlug = (input.slug && slugify(input.slug)) || slugify(label);
  const brand_color = input.brand_color || "#6366f1";
  const created_by = input.created_by || "env-admin";
  if (!pool) {
    seedDefaultBusinessGroupInMem();
    const taken = new Set([...mem.businessGroups.values()].map((g) => g.slug));
    let slug = baseSlug; let n = 2;
    while (taken.has(slug)) { slug = `${baseSlug}-${n++}`; }
    if (mem.businessGroups.has(id)) throw new Error(`group.id duplicado: ${id}`);
    const now = Date.now();
    const g: BusinessGroup = { id, label, slug, brand_color, archived: false, created_by, created_at: now, updated_at: now };
    mem.businessGroups.set(id, g);
    return g;
  }
  let slug = baseSlug; let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await pool.query("SELECT 1 FROM app_business_groups WHERE slug=$1 LIMIT 1", [slug]);
    if (!r.rows[0]) break;
    slug = `${baseSlug}-${n++}`;
    if (n > 9999) throw new Error("no se pudo derivar slug único");
  }
  const r = await pool.query(
    `INSERT INTO app_business_groups (id,label,slug,brand_color,created_by,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,now(),now())
     RETURNING id,label,slug,brand_color,archived,created_by,created_at,updated_at`,
    [id, label, slug, brand_color, created_by],
  );
  return rowToBusinessGroup(r.rows[0]);
}

export async function dbUpdateBusinessGroup(id: string, patch: {
  label?: string; slug?: string; brand_color?: string; archived?: boolean;
}): Promise<BusinessGroup | null> {
  if (!id) return null;
  if (patch.label !== undefined) assertValidWsLabel(patch.label.trim());
  if (patch.brand_color !== undefined && patch.brand_color !== "") assertValidBrandColor(patch.brand_color);
  if (!pool) {
    seedDefaultBusinessGroupInMem();
    const g = mem.businessGroups.get(id); if (!g) return null;
    if (patch.label !== undefined) g.label = patch.label.trim() || g.label;
    if (patch.slug !== undefined) g.slug = slugify(patch.slug) || g.slug;
    if (patch.brand_color !== undefined) g.brand_color = patch.brand_color;
    if (patch.archived !== undefined && id !== "default") g.archived = !!patch.archived;
    g.updated_at = Date.now();
    return g;
  }
  const sets: string[] = []; const vals: unknown[] = [];
  if (patch.label !== undefined) { sets.push(`label=$${sets.length + 2}`); vals.push(patch.label.trim()); }
  if (patch.slug !== undefined) { sets.push(`slug=$${sets.length + 2}`); vals.push(slugify(patch.slug)); }
  if (patch.brand_color !== undefined) { sets.push(`brand_color=$${sets.length + 2}`); vals.push(patch.brand_color); }
  if (patch.archived !== undefined && id !== "default") { sets.push(`archived=$${sets.length + 2}`); vals.push(!!patch.archived); }
  if (!sets.length) return dbGetBusinessGroup(id);
  sets.push("updated_at=now()");
  const r = await pool.query(
    `UPDATE app_business_groups SET ${sets.join(", ")} WHERE id=$1
     RETURNING id,label,slug,brand_color,archived,created_by,created_at,updated_at`,
    [id, ...vals],
  );
  return r.rows[0] ? rowToBusinessGroup(r.rows[0]) : null;
}

/** ¿El grupo está vacío? 0 workspaces (incl. archivados) AND 0 usuarios (incl. inactivos). */
export async function dbBusinessGroupIsEmpty(id: string): Promise<boolean> {
  if (!pool) {
    const ws = [...mem.workspaces.values()].some((w) => (w.group_id || "default") === id);
    const us = [...memUsers.values()].some((u) => (u.group_id || "default") === id);
    return !ws && !us;
  }
  const r = await pool.query(
    `SELECT (SELECT COUNT(*) FROM app_workspaces WHERE group_id=$1)
          + (SELECT COUNT(*) FROM app_users WHERE group_id=$1) AS n`,
    [id],
  );
  return Number((r.rows[0] as { n: number })?.n || 0) === 0;
}

export async function dbDeleteBusinessGroup(id: string): Promise<boolean> {
  if (!id || id === "default") return false;
  if (!(await dbBusinessGroupIsEmpty(id))) return false;
  if (!pool) {
    const g = mem.businessGroups.get(id);
    if (!g || !g.archived) return false;
    mem.businessGroups.delete(id);
    return true;
  }
  const r = await pool.query("DELETE FROM app_business_groups WHERE id=$1 AND archived=true", [id]);
  return Number(r.rowCount ?? 0) > 0;
}

// ============================================================
// DIAG-WS-MEMBERS 2026-06-04 · listar workspaces no archivados con sus
// members (user_id, role, email) sin exponer secretos (password_hash,
// tokens). Sin auth · solo lectura · util para diagnosticar a quien le
// falta acceso a que ws antes de forzar-add.
// ============================================================
export interface WsMemberInfo {
  user_id: string;
  role: WorkspaceRole;
  email?: string;
  name?: string;
}

export interface WsWithMembers {
  id: string;
  label: string;
  slug: string;
  archived: boolean;
  members: WsMemberInfo[];
}

export async function dbListWorkspacesWithMembers(): Promise<WsWithMembers[]> {
  if (!pool) {
    seedDefaultWorkspaceInMem();
    seedDefaultWorkspaceMembersInMem();
    const out: WsWithMembers[] = [];
    for (const w of mem.workspaces.values()) {
      if (w.archived) continue;
      const members: WsMemberInfo[] = [];
      for (const m of mem.workspaceMembers) {
        if (m.workspace_id !== w.id) continue;
        const u = memUsers.get(m.user_id);
        members.push({
          user_id: m.user_id,
          role: m.role,
          email: u?.email,
          name: u?.name,
        });
      }
      out.push({
        id: w.id,
        label: w.label,
        slug: w.slug,
        archived: w.archived,
        members,
      });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }
  // Postgres path · 1 query con LEFT JOIN para traer todo de golpe.
  // No exponemos password_hash, tokens, ni created_at de membership.
  const r = await pool.query(
    `SELECT w.id AS ws_id,
            w.label AS ws_label,
            w.slug AS ws_slug,
            w.archived AS ws_archived,
            m.user_id AS m_user_id,
            m.role AS m_role,
            u.email AS u_email,
            u.name AS u_name
       FROM app_workspaces w
       LEFT JOIN app_workspace_members m ON m.workspace_id = w.id
       LEFT JOIN app_users u ON u.id = m.user_id
      WHERE w.archived = false
      ORDER BY w.label ASC, m.created_at ASC`,
  );
  const byWs = new Map<string, WsWithMembers>();
  for (const row of r.rows as Record<string, unknown>[]) {
    const wsId = String(row.ws_id);
    let entry = byWs.get(wsId);
    if (!entry) {
      entry = {
        id: wsId,
        label: String(row.ws_label ?? ""),
        slug: String(row.ws_slug ?? ""),
        archived: !!row.ws_archived,
        members: [],
      };
      byWs.set(wsId, entry);
    }
    if (row.m_user_id) {
      entry.members.push({
        user_id: String(row.m_user_id),
        role: String(row.m_role) as WorkspaceRole,
        email: row.u_email ? String(row.u_email) : undefined,
        name: row.u_name ? String(row.u_name) : undefined,
      });
    }
  }
  return [...byWs.values()];
}

// ============================================================
// FORCE-ADD-ALL-OWNERS 2026-06-04 · para CADA ws no archivado, anade
// a CADA user de app_users de SU MISMO grupo como owner (idempotente ·
// ON CONFLICT DO NOTHING).
//
// SEC-ORPHAN-WS 2026-08-07 · AVISO HONESTO: SI escala privilegios. El
// comentario anterior decia "no escala privilegios porque los users ya
// son admin/operator del stack" — es FALSO desde que existen roles por
// workspace: un viewer o un editor del grupo sale de aqui convertido en
// OWNER de todos los workspaces del grupo. Es exactamente la escalada
// masiva que se retiro del arranque (healOrphanWorkspaces). Se conserva
// solo como HERRAMIENTA DE RESCATE manual, explicita y env-admin-only,
// para el caso "el creador del workspace desaparecio y nadie puede
// entrar". La via normal y auditada es asignar UN owner concreto con
// POST /admin/api/workspaces/:id/members.
// Devuelve {inserted, total_users, total_workspaces}.
// ============================================================
export async function dbForceAddAllUsersAsOwners(): Promise<{
  inserted: number;
  total_users: number;
  total_workspaces: number;
}> {
  if (!pool) {
    seedDefaultWorkspaceInMem();
    let inserted = 0;
    const wsList = [...mem.workspaces.values()].filter((w) => !w.archived);
    const userList = [...memUsers.values()];
    for (const w of wsList) {
      // El path Postgres excluye 'default' (AND w.id <> 'default'): es el negocio
      // del owner/env-admin y sembrarlo con TODO el grupo es una fuga cross-tenant,
      // no un rescate. Aqui faltaba, asi que en dev el mismo rescate hacia
      // propietarios de 'default' a gente que no lo era. Mismo criterio en ambos.
      if (w.id === "default") continue;
      for (const u of userList) {
        // BIZGROUPS: solo mismo grupo (no cross-group).
        if ((u.group_id || "default") !== (w.group_id || "default")) continue;
        const exists = mem.workspaceMembers.some(
          (m) => m.workspace_id === w.id && m.user_id === u.id,
        );
        if (exists) continue;
        mem.workspaceMembers.push({
          workspace_id: w.id,
          user_id: u.id,
          role: "owner",
          created_at: Date.now(),
        });
        inserted += 1;
      }
    }
    return {
      inserted,
      total_users: userList.length,
      total_workspaces: wsList.length,
    };
  }
  // Postgres path · 1 INSERT...CROSS JOIN...ON CONFLICT DO NOTHING.
  const wsCountQ = await pool.query(
    "SELECT COUNT(*)::int AS n FROM app_workspaces WHERE archived = false",
  );
  const usersCountQ = await pool.query(
    "SELECT COUNT(*)::int AS n FROM app_users",
  );
  const ins = await pool.query(
    `INSERT INTO app_workspace_members (workspace_id, user_id, role)
     SELECT w.id, u.id, 'owner'
       FROM app_workspaces w
       CROSS JOIN app_users u
      WHERE w.archived = false
        AND w.id <> 'default'
        AND COALESCE(u.group_id,'default') = COALESCE(w.group_id,'default')
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
  );
  return {
    inserted: Number(ins.rowCount ?? 0),
    total_users: Number(usersCountQ.rows?.[0]?.n ?? 0),
    total_workspaces: Number(wsCountQ.rows?.[0]?.n ?? 0),
  };
}

// ============================================================
// logs-cola FASE-1: Activity log helpers.
// Todos los orígenes (autopost, broadcast, scheduled-post, mcp-jobs,
// lead-jobs, webhooks, llamadas LLM, envíos WA/IG, errores app...)
// escriben aquí con summary humano + payload técnico opcional.
// Lo consumen los dashboards/badges del panel.
// Retención: 30 días (setInterval en initDb).
// ============================================================

function genUuid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  );
}

/**
 * Inserta una entrada en app_activity_log.
 * - id: UUID auto si no se pasa.
 * - tenant_id: por defecto 'default'.
 * - level: 'info' por defecto.
 * - payload: opcional, JSONB.
 */
export async function dbInsertActivity(input: {
  tenant_id?: string;
  source: ActivitySource;
  level?: ActivityLevel;
  status?: string | null;
  summary: string;
  payload?: Record<string, unknown> | null;
}): Promise<ActivityRow> {
  const id = genUuid();
  const tenant_id = (input.tenant_id || "default").trim() || "default";
  const level: ActivityLevel = input.level || "info";
  const status = input.status ?? null;
  const summary = String(input.summary || "");
  const payload = input.payload ?? null;
  const created_at = Date.now();
  const row: ActivityRow = {
    id,
    tenant_id,
    source: input.source,
    level,
    status,
    summary,
    payload,
    created_at,
  };
  if (!pool) {
    // Tope blando en memoria para no crecer sin freno en dev.
    mem.activity.unshift(row);
    if (mem.activity.length > 2000) mem.activity.length = 2000;
    return row;
  }
  await pool.query(
    `INSERT INTO app_activity_log (id, tenant_id, source, level, status, summary, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8/1000.0))`,
    [id, tenant_id, input.source, level, status, summary, payload ? JSON.stringify(payload) : null, created_at],
  );
  // SEC-2: avisa a TODAS las réplicas con un payload JSON que TRAE tenant_id.
  // El SSE handler de cada cliente filtra por su tenant antes de reenviar al
  // navegador — sin esto un cliente ws=A vería notify de ws=B (cross-tenant).
  void dbNotify("bstack_activity", JSON.stringify({ tenant_id, id, source: input.source, level }));
  return row;
}

function rowToActivity(r: any): ActivityRow {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    source: r.source as ActivitySource,
    level: r.level as ActivityLevel,
    status: r.status ?? null,
    summary: String(r.summary || ""),
    payload: r.payload ?? null,
    created_at: Number(r.created_at_ms),
  };
}

/**
 * Lista filas del log con filtros opcionales. ORDER BY created_at DESC.
 * limit: cap a 500. offset: paginación.
 */
export async function dbListActivity(input: {
  tenant_id?: string;
  source?: ActivitySource;
  level?: ActivityLevel;
  /** Un status exacto o varios (OR). T06: la UI agrupa statuses afines. */
  status?: string | string[];
  /** T06: búsqueda textual (ILIKE) sobre summary, status y la clave del payload.
   *  ACTIVIDAD-CLAVE-1: el resumen dejó de llevar la clave cruda del ajuste
   *  (`ba6324d` la sustituyó por su nombre en castellano, y hacía bien: a 390 px
   *  «legal.entityRegAgent» partía a mitad de palabra). Pero la clave era lo único
   *  por lo que se podía localizar el rastro de un cambio de Ajustes, así que la
   *  búsqueda se quedó sin encontrarlo. Vuelve a la superficie de BÚSQUEDA sin
   *  volver a la superficie VISIBLE: el cliente sigue leyendo el nombre en
   *  castellano. Sólo se mira payload.key — nunca el payload entero, que lleva
   *  secretos y PII. */
  q?: string;
  dateFrom?: number; // epoch ms
  dateTo?: number;   // epoch ms
  /** T06: 'asc' para los más antiguos primero. Default 'desc'. */
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
} = {}): Promise<ActivityRow[]> {
  const limitRaw = Number(input.limit ?? 50);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 50));
  const offset = Math.max(0, Number(input.offset ?? 0) || 0);
  // WS-ISOLATION 2026-06-04: default a workspace activo si no se pasa.
  const effectiveTenant = input.tenant_id ?? currentWorkspaceId();
  const statusList = Array.isArray(input.status)
    ? input.status.filter((s) => s && typeof s === "string")
    : (input.status ? [input.status] : []);
  const qNorm = String(input.q || "").trim().toLowerCase();
  // Nunca interpolar input en el ORDER BY: mapeo a literal.
  const orderSql = input.order === "asc" ? "ASC" : "DESC";

  if (!pool) {
    let rows = mem.activity.slice();
    rows = rows.filter((r) => r.tenant_id === effectiveTenant);
    if (input.source) rows = rows.filter((r) => r.source === input.source);
    if (input.level) rows = rows.filter((r) => r.level === input.level);
    if (statusList.length) rows = rows.filter((r) => r.status != null && statusList.includes(r.status));
    if (qNorm) rows = rows.filter((r) =>
      String(r.summary || "").toLowerCase().includes(qNorm) ||
      String(r.status || "").toLowerCase().includes(qNorm) ||
      String(r.payload?.key ?? "").toLowerCase().includes(qNorm));
    if (input.dateFrom) rows = rows.filter((r) => r.created_at >= input.dateFrom!);
    if (input.dateTo) rows = rows.filter((r) => r.created_at <= input.dateTo!);
    rows.sort((a, b) => (input.order === "asc" ? a.created_at - b.created_at : b.created_at - a.created_at));
    return rows.slice(offset, offset + limit);
  }

  const where: string[] = [];
  const params: any[] = [];
  params.push(effectiveTenant); where.push(`tenant_id=$${params.length}`);
  if (input.source)    { params.push(input.source);    where.push(`source=$${params.length}`); }
  if (input.level)     { params.push(input.level);     where.push(`level=$${params.length}`); }
  if (statusList.length === 1) { params.push(statusList[0]); where.push(`status=$${params.length}`); }
  else if (statusList.length > 1) { params.push(statusList); where.push(`status = ANY($${params.length})`); }
  if (qNorm) {
    // ILIKE con comodines del usuario escapados (%_\) para que busque literal.
    params.push("%" + qNorm.replace(/[\\%_]/g, "\\$&") + "%");
    // ACTIVIDAD-CLAVE-1 · payload->>'key' es el nombre técnico del ajuste, no un
    // secreto; el resto del payload NO se busca (lleva valores redactados).
    where.push(`(summary ILIKE $${params.length} OR status ILIKE $${params.length} OR payload->>'key' ILIKE $${params.length})`);
  }
  if (input.dateFrom)  { params.push(input.dateFrom);  where.push(`created_at >= to_timestamp($${params.length}/1000.0)`); }
  if (input.dateTo)    { params.push(input.dateTo);    where.push(`created_at <= to_timestamp($${params.length}/1000.0)`); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  const r = await pool.query(
    `SELECT id, tenant_id, source, level, status, summary, payload,
            extract(epoch from created_at)*1000 AS created_at_ms
       FROM app_activity_log
       ${whereSql}
       ORDER BY created_at ${orderSql}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return r.rows.map(rowToActivity);
}

/**
 * Cuenta filas del log con filtros opcionales. Usado por badges del panel.
 */
export async function dbCountActivity(input: {
  tenant_id: string;
  source?: ActivitySource;
  level?: ActivityLevel;
  status?: string;
  sinceDays?: number;
}): Promise<number> {
  const sinceMs = input.sinceDays && input.sinceDays > 0
    ? Date.now() - input.sinceDays * 24 * 3600 * 1000
    : null;

  if (!pool) {
    let rows = mem.activity.slice();
    rows = rows.filter((r) => r.tenant_id === input.tenant_id);
    if (input.source) rows = rows.filter((r) => r.source === input.source);
    if (input.level) rows = rows.filter((r) => r.level === input.level);
    if (input.status) rows = rows.filter((r) => r.status === input.status);
    if (sinceMs !== null) rows = rows.filter((r) => r.created_at >= sinceMs);
    return rows.length;
  }

  const where: string[] = ["tenant_id=$1"];
  const params: any[] = [input.tenant_id];
  if (input.source) { params.push(input.source); where.push(`source=$${params.length}`); }
  if (input.level)  { params.push(input.level);  where.push(`level=$${params.length}`); }
  if (input.status) { params.push(input.status); where.push(`status=$${params.length}`); }
  if (sinceMs !== null) { params.push(sinceMs); where.push(`created_at >= to_timestamp($${params.length}/1000.0)`); }
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM app_activity_log WHERE ${where.join(" AND ")}`,
    params,
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Contadores agregados por level y source para un ws en ventana sinceHours.
 * Por defecto las últimas 24h. Usado por el resumen del panel.
 */
export async function dbActivityCounters(input: {
  tenant_id: string;
  sinceHours?: number;
}): Promise<{
  total: number;
  byLevel: { info: number; warn: number; error: number };
  bySource: Record<string, number>;
}> {
  const hours = input.sinceHours && input.sinceHours > 0 ? input.sinceHours : 24;
  const sinceMs = Date.now() - hours * 3600 * 1000;
  const out = {
    total: 0,
    byLevel: { info: 0, warn: 0, error: 0 } as { info: number; warn: number; error: number },
    bySource: {} as Record<string, number>,
  };

  if (!pool) {
    const rows = mem.activity.filter(
      (r) => r.tenant_id === input.tenant_id && r.created_at >= sinceMs,
    );
    out.total = rows.length;
    for (const r of rows) {
      out.byLevel[r.level] = (out.byLevel[r.level] || 0) + 1;
      out.bySource[r.source] = (out.bySource[r.source] || 0) + 1;
    }
    return out;
  }

  const r = await pool.query(
    `SELECT level, source, COUNT(*)::int AS n
       FROM app_activity_log
      WHERE tenant_id=$1
        AND created_at >= to_timestamp($2/1000.0)
      GROUP BY level, source`,
    [input.tenant_id, sinceMs],
  );
  for (const row of r.rows) {
    const n = Number(row.n) || 0;
    out.total += n;
    const lvl = row.level as ActivityLevel;
    if (lvl === "info" || lvl === "warn" || lvl === "error") {
      out.byLevel[lvl] += n;
    }
    const src = String(row.source);
    out.bySource[src] = (out.bySource[src] || 0) + n;
  }
  return out;
}

/**
 * Borra filas con created_at < now() - days. Devuelve el número de filas
 * eliminadas. Lo llama el setInterval de retención (cada 24h).
 */
export async function dbDeleteActivityOlderThan(days: number): Promise<number> {
  const d = Math.max(1, Number(days) || 30);
  const cutoffMs = Date.now() - d * 24 * 3600 * 1000;
  if (!pool) {
    const before = mem.activity.length;
    mem.activity = mem.activity.filter((r) => r.created_at >= cutoffMs);
    return before - mem.activity.length;
  }
  const r = await pool.query(
    `DELETE FROM app_activity_log WHERE created_at < to_timestamp($1/1000.0)`,
    [cutoffMs],
  );
  return r.rowCount ?? 0;
}

// ============================================================
// NOTIFICACIONES-1 · capa de datos de las notificaciones de negocio.
// Todo va acotado por tenant_id (el llamador lo saca de currentWorkspaceId()).
// «actor» es la persona que mira: 'env' (administrador del entorno) o 'u:<id>'.
// Una notificación está LEÍDA para esa persona si es anterior a su marca
// «visto hasta» o si la abrió suelta.
// ============================================================
function rowToNotification(r: any): NotificationRow {
  return {
    id: Number(r.id),
    tenant_id: String(r.tenant_id),
    kind: String(r.kind),
    title: String(r.title || ""),
    body: String(r.body || ""),
    phone: r.phone ?? null,
    channel: r.channel ?? null,
    link: r.link ?? null,
    dedup_key: r.dedup_key ?? null,
    payload: r.payload ?? null,
    created_at: r.created_at instanceof Date ? r.created_at.getTime() : Number(r.created_at) || 0,
    read: r.is_read === undefined ? undefined : !!r.is_read,
  };
}

/** Inserta una notificación. Devuelve null si su dedup_key ya existía en ese tenant. */
export async function dbInsertNotification(input: {
  tenant_id: string;
  kind: string;
  title: string;
  body?: string;
  phone?: string | null;
  channel?: string | null;
  link?: string | null;
  dedup_key?: string | null;
  payload?: Record<string, unknown> | null;
}): Promise<NotificationRow | null> {
  const tenant_id = (input.tenant_id || "default").trim() || "default";
  const dedup = input.dedup_key ? String(input.dedup_key).slice(0, 200) : null;
  const vals = {
    kind: String(input.kind).slice(0, 40),
    title: String(input.title || "").slice(0, 200),
    body: String(input.body || "").slice(0, 600),
    phone: input.phone ? String(input.phone).slice(0, 80) : null,
    channel: input.channel ? String(input.channel).slice(0, 20) : null,
    link: input.link ? String(input.link).slice(0, 300) : null,
    payload: input.payload ?? null,
  };
  if (!pool) {
    if (dedup && mem.notifications.some((n) => n.tenant_id === tenant_id && n.dedup_key === dedup)) return null;
    const row: NotificationRow = { id: ++mem.notifSeq, tenant_id, dedup_key: dedup, created_at: Date.now(), ...vals };
    mem.notifications.unshift(row);
    if (mem.notifications.length > 5000) mem.notifications.length = 5000;
    return row;
  }
  const r = await pool.query(
    `INSERT INTO app_notifications (tenant_id, kind, title, body, phone, channel, link, dedup_key, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [tenant_id, vals.kind, vals.title, vals.body, vals.phone, vals.channel, vals.link, dedup, vals.payload ? JSON.stringify(vals.payload) : null],
  );
  return r.rows[0] ? rowToNotification(r.rows[0]) : null;
}

export interface NotificationFilter {
  kinds?: string[];
  unread?: boolean;
  q?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

/** Listado paginado (más recientes primero) con el estado leído de ESA persona. */
export async function dbListNotifications(
  tenant: string,
  actor: string,
  f: NotificationFilter = {},
): Promise<{ items: NotificationRow[]; total: number }> {
  const limit = Math.max(1, Math.min(200, Number(f.limit) || 25));
  const offset = Math.max(0, Number(f.offset) || 0);
  const kinds = (f.kinds || []).filter(Boolean);
  const q = String(f.q || "").trim().toLowerCase();
  if (!pool) {
    const seen = mem.notifSeen.get(tenant + "|" + actor) || 0;
    const all = mem.notifications
      .filter((n) => n.tenant_id === tenant)
      .map((n) => ({ ...n, read: n.created_at <= seen || mem.notifReads.has(tenant + "|" + actor + "|" + n.id) }))
      .filter((n) => !kinds.length || kinds.includes(n.kind))
      .filter((n) => !f.unread || !n.read)
      .filter((n) => !q || (n.title + " " + n.body + " " + (n.phone || "")).toLowerCase().includes(q))
      .filter((n) => !f.from || n.created_at >= f.from)
      .filter((n) => !f.to || n.created_at <= f.to)
      .sort((a, b) => b.created_at - a.created_at || b.id - a.id);
    return { items: all.slice(offset, offset + limit), total: all.length };
  }
  const params: unknown[] = [tenant, actor];
  const where: string[] = ["n.tenant_id = $1"];
  if (kinds.length) { params.push(kinds); where.push(`n.kind = ANY($${params.length})`); }
  if (q) {
    params.push("%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%");
    const p = `$${params.length}`;
    where.push(`(n.title ILIKE ${p} OR n.body ILIKE ${p} OR COALESCE(n.phone,'') ILIKE ${p})`);
  }
  if (f.from) { params.push(f.from); where.push(`n.created_at >= to_timestamp($${params.length}/1000.0)`); }
  if (f.to) { params.push(f.to); where.push(`n.created_at <= to_timestamp($${params.length}/1000.0)`); }
  const leida = `(n.created_at <= COALESCE(s.seen_at, 'epoch'::timestamptz) OR r.notification_id IS NOT NULL)`;
  if (f.unread) where.push(`NOT ${leida}`);
  params.push(limit, offset);
  const r = await pool.query(
    `SELECT n.*, ${leida} AS is_read, count(*) OVER() AS total_rows
       FROM app_notifications n
       LEFT JOIN app_notification_seen s ON s.tenant_id = n.tenant_id AND s.actor = $2
       LEFT JOIN app_notification_reads r ON r.tenant_id = n.tenant_id AND r.actor = $2 AND r.notification_id = n.id
      WHERE ${where.join(" AND ")}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  let total = r.rows[0] ? Number(r.rows[0].total_rows) : 0;
  // Una página agotada conserva el total, también después de marcar avisos como leídos.
  if (!r.rows.length && offset > 0) {
    const count = await pool.query(
      `SELECT count(*) AS total FROM app_notifications n
       LEFT JOIN app_notification_seen s ON s.tenant_id = n.tenant_id AND s.actor = $2
       LEFT JOIN app_notification_reads r ON r.tenant_id = n.tenant_id AND r.actor = $2 AND r.notification_id = n.id
       WHERE ${where.join(" AND ")}`,
      params.slice(0, -2),
    );
    total = Number(count.rows[0]?.total || 0);
  }
  return { items: r.rows.map(rowToNotification), total };
}

/** No leídas de esa persona (tope 100: la campana enseña «99+») y el id más alto del tenant. */
export async function dbCountUnreadNotifications(tenant: string, actor: string): Promise<{ unread: number; lastId: number }> {
  if (!pool) {
    const seen = mem.notifSeen.get(tenant + "|" + actor) || 0;
    const mine = mem.notifications.filter((n) => n.tenant_id === tenant);
    const unread = mine.filter((n) => n.created_at > seen && !mem.notifReads.has(tenant + "|" + actor + "|" + n.id)).length;
    return { unread: Math.min(100, unread), lastId: mine.reduce((m, n) => Math.max(m, n.id), 0) };
  }
  const r = await pool.query(
    `SELECT
       (SELECT count(*) FROM (
          SELECT 1 FROM app_notifications n
           WHERE n.tenant_id = $1
             AND n.created_at > COALESCE((SELECT seen_at FROM app_notification_seen WHERE tenant_id = $1 AND actor = $2), 'epoch'::timestamptz)
             AND NOT EXISTS (SELECT 1 FROM app_notification_reads r WHERE r.tenant_id = $1 AND r.actor = $2 AND r.notification_id = n.id)
           LIMIT 100) x) AS unread,
       (SELECT COALESCE(max(id), 0) FROM app_notifications WHERE tenant_id = $1) AS last_id`,
    [tenant, actor],
  );
  return { unread: Number(r.rows[0]?.unread || 0), lastId: Number(r.rows[0]?.last_id || 0) };
}

/** Cuántas hay de cada tipo (y cuántas sin leer) en los últimos 90 días: los filtros por tipo. */
export async function dbNotificationKindCounts(tenant: string, actor: string): Promise<Array<{ kind: string; total: number; unread: number }>> {
  const cutoff = Date.now() - 90 * 86400000;
  if (!pool) {
    const seen = mem.notifSeen.get(tenant + "|" + actor) || 0;
    const m = new Map<string, { kind: string; total: number; unread: number }>();
    for (const n of mem.notifications) {
      if (n.tenant_id !== tenant || n.created_at < cutoff) continue;
      const e = m.get(n.kind) || { kind: n.kind, total: 0, unread: 0 };
      e.total++;
      if (n.created_at > seen && !mem.notifReads.has(tenant + "|" + actor + "|" + n.id)) e.unread++;
      m.set(n.kind, e);
    }
    return [...m.values()];
  }
  const r = await pool.query(
    `SELECT n.kind, count(*) AS total,
            count(*) FILTER (WHERE n.created_at > COALESCE(s.seen_at, 'epoch'::timestamptz) AND r.notification_id IS NULL) AS unread
       FROM app_notifications n
       LEFT JOIN app_notification_seen s ON s.tenant_id = n.tenant_id AND s.actor = $2
       LEFT JOIN app_notification_reads r ON r.tenant_id = n.tenant_id AND r.actor = $2 AND r.notification_id = n.id
      WHERE n.tenant_id = $1 AND n.created_at >= to_timestamp($3/1000.0)
      GROUP BY n.kind`,
    [tenant, actor, cutoff],
  );
  return r.rows.map((x: any) => ({ kind: String(x.kind), total: Number(x.total), unread: Number(x.unread) }));
}

/**
 * Marca como leídas: `ids` sueltas (solo las de ESE tenant, nunca ids ajenos a ciegas) o
 * todas (`all`), que mueve la marca «visto hasta» y limpia las sueltas que ya cubre.
 */
// BANDEJA-LEIDOS-1 · marcas de lectura de la Bandeja de UNA persona en el workspace
// actual. Si aún no tiene ninguna, siembra 'base' = ahora: el primer día no se le
// plantan miles de conversaciones antiguas como «sin leer».
export async function dbGetInboxReads(actor: string): Promise<Record<string, number>> {
  const tenant = currentWorkspaceId();
  if (!pool) {
    const k = tenant + "|" + actor;
    let r = mem.inboxReads.get(k);
    if (!r) { r = { base: Date.now() }; mem.inboxReads.set(k, r); }
    return { ...r };
  }
  const q = await pool.query(`SELECT k, read_ms FROM app_inbox_reads WHERE tenant_id = $1 AND actor = $2`, [tenant, actor]);
  const out: Record<string, number> = {};
  for (const row of q.rows) out[String(row.k)] = Number(row.read_ms) || 0;
  if (out.base == null) {
    const now = Date.now();
    const base = await pool.query(
      `INSERT INTO app_inbox_reads (tenant_id, actor, k, read_ms) VALUES ($1,$2,'base',$3)
       ON CONFLICT (tenant_id, actor, k) DO UPDATE SET read_ms = app_inbox_reads.read_ms
       RETURNING read_ms`,
      [tenant, actor, now],
    );
    // Dos primeras cargas simultáneas deben devolver la misma marca persistida.
    out.base = Number(base.rows[0].read_ms);
  }
  return out;
}
/** BANDEJA-LEIDOS-1 · marca como leídas (ahora) las claves dadas. '*' barre las marcas sueltas: ya sobran. */
export async function dbSetInboxReads(actor: string, keys: string[]): Promise<number> {
  const tenant = currentWorkspaceId();
  const now = Date.now();
  const ks = [...new Set(keys.filter((k) => typeof k === "string" && k && k !== "base" && k.length <= 300))].slice(0, 50);
  if (!ks.length) return now;
  if (!pool) {
    const mk = tenant + "|" + actor;
    const r = mem.inboxReads.get(mk) || { base: now };
    if (ks.includes("*")) for (const k of Object.keys(r)) if (k !== "base") delete r[k];
    for (const k of ks) r[k] = Math.max(r[k] || 0, now);
    mem.inboxReads.set(mk, r);
    return now;
  }
  if (ks.includes("*")) await pool.query(`DELETE FROM app_inbox_reads WHERE tenant_id = $1 AND actor = $2 AND k <> 'base'`, [tenant, actor]);
  await pool.query(
    `INSERT INTO app_inbox_reads (tenant_id, actor, k, read_ms)
     SELECT $1, $2, x, $4 FROM unnest($3::text[]) AS x
     ON CONFLICT (tenant_id, actor, k) DO UPDATE SET read_ms = GREATEST(app_inbox_reads.read_ms, EXCLUDED.read_ms)`,
    [tenant, actor, ks, now],
  );
  return now;
}
export async function dbMarkNotificationsRead(tenant: string, actor: string, sel: { ids?: number[]; all?: boolean }): Promise<number> {
  const ids = (sel.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  if (!pool) {
    if (sel.all) {
      mem.notifSeen.set(tenant + "|" + actor, Date.now());
      for (const k of [...mem.notifReads]) if (k.startsWith(tenant + "|" + actor + "|")) mem.notifReads.delete(k);
      return 1;
    }
    let n = 0;
    for (const id of ids) {
      if (mem.notifications.some((x) => x.tenant_id === tenant && x.id === id)) { mem.notifReads.add(tenant + "|" + actor + "|" + id); n++; }
    }
    return n;
  }
  if (sel.all) {
    await pool.query(
      `INSERT INTO app_notification_seen (tenant_id, actor, seen_at) VALUES ($1,$2,now())
       ON CONFLICT (tenant_id, actor) DO UPDATE SET seen_at = now()`,
      [tenant, actor],
    );
    await pool.query(`DELETE FROM app_notification_reads WHERE tenant_id = $1 AND actor = $2`, [tenant, actor]);
    return 1;
  }
  if (!ids.length) return 0;
  const r = await pool.query(
    `INSERT INTO app_notification_reads (tenant_id, actor, notification_id)
     SELECT $1, $2, id FROM app_notifications WHERE tenant_id = $1 AND id = ANY($3::bigint[])
     ON CONFLICT DO NOTHING`,
    [tenant, actor, ids],
  );
  return r.rowCount ?? 0;
}

export async function dbDeleteNotificationsOlderThan(days: number): Promise<number> {
  const cutoffMs = Date.now() - Math.max(1, Number(days) || 90) * 86400000;
  if (!pool) {
    const before = mem.notifications.length;
    mem.notifications = mem.notifications.filter((n) => n.created_at >= cutoffMs);
    return before - mem.notifications.length;
  }
  const r = await pool.query(`DELETE FROM app_notifications WHERE created_at < to_timestamp($1/1000.0)`, [cutoffMs]);
  await pool.query(
    `DELETE FROM app_notification_reads r
      WHERE NOT EXISTS (SELECT 1 FROM app_notifications n WHERE n.id = r.notification_id)`,
  );
  return r.rowCount ?? 0;
}

/**
 * ACTIVIDAD-BORRAR-1 · borra UN registro del Centro de Actividad. Acotado al tenant: un
 * workspace no puede borrar el registro de otro ni comprobando ids a ciegas.
 * Devuelve false si ese id no es suyo (o no existe): el panel lo cuenta como no-existe,
 * nunca como error del usuario.
 */
export async function dbDeleteActivity(id: string): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const i = mem.activity.findIndex((r) => r.id === id && (r.tenant_id || "default") === tenantId);
    if (i < 0) return false;
    mem.activity.splice(i, 1);
    return true;
  }
  const r = await pool.query(`DELETE FROM app_activity_log WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * ACTIVIDAD-BORRAR-1 · vacía el registro DEL TENANT, entero o solo lo anterior a N días.
 * Ojo con el vecino: dbDeleteActivityOlderThan (el barrido de retención, arriba) NO lleva
 * tenant a propósito —es mantenimiento del stack—, y esta sí. No se puede reutilizar aquel
 * para esto: vaciaría el registro de todos los negocios del panel.
 */
export async function dbPurgeActivity(opts: { olderThanDays?: number } = {}): Promise<number> {
  const tenantId = currentWorkspaceId();
  const dias = Math.max(0, Math.floor(Number(opts.olderThanDays) || 0));
  const cutoffMs = dias > 0 ? Date.now() - dias * 24 * 3600 * 1000 : 0;
  if (!pool) {
    const antes = mem.activity.length;
    mem.activity = mem.activity.filter((r) => {
      if ((r.tenant_id || "default") !== tenantId) return true;
      return cutoffMs > 0 && r.created_at >= cutoffMs;
    });
    return antes - mem.activity.length;
  }
  const r = cutoffMs > 0
    ? await pool.query(
        `DELETE FROM app_activity_log WHERE tenant_id=$1 AND created_at < to_timestamp($2/1000.0)`,
        [tenantId, cutoffMs],
      )
    : await pool.query(`DELETE FROM app_activity_log WHERE tenant_id=$1`, [tenantId]);
  return r.rowCount ?? 0;
}

// ============================================================
// metricas-pro M3 — WhatsApp PRO events.
//
// Cada envío (sendText/sendTemplate) e ingreso (webhook) crea una fila
// en app_wa_events. Lo usa la tab Métricas → WhatsApp PRO para:
//   - KPIs sent/received (totales en N días)
//   - tiempo medio de respuesta (avg/p95 sobre response_time_ms de las
//     filas IN que tuvieron una OUT previa al mismo número en <60min)
//   - heatmap por hora del día x day-of-week (24x7)
//   - tabla de calidad por plantilla (template, sent, delivered%, read%,
//     failed% — basado en status de las filas template).
// ============================================================

export type WaEventDirection = "in" | "out";

export interface WaEventRow {
  id: string;
  tenant_id: string;
  phone_number_id: string;
  direction: WaEventDirection;
  msg_type: string | null;
  status: string | null;
  template_name: string | null;
  response_time_ms: number | null;
  created_at: number; // epoch ms
}

export type WaMessageStatus = "accepted" | "sent" | "delivered" | "read" | "failed";

export interface WaMessageStatusRow {
  message_id: string;
  phone_number_id: string;
  user_id: string;
  status: WaMessageStatus;
  status_at: number;
  error_code?: string;
  error_detail?: string;
  // ENTREGA-WA-1 · plantilla del mensaje y primera vez que se vio (solo modo memoria;
  // en Postgres son template_name y created_at de la fila).
  template_name?: string;
  first_at?: number;
}

const waStatusRank: Record<WaMessageStatus, number> = {
  accepted: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 99,
};

/**
 * Guarda la confirmación asíncrona de Meta para un wamid. Los webhooks pueden
 * llegar desordenados, por lo que un estado anterior nunca pisa uno posterior.
 */
export async function dbUpsertWaMessageStatus(input: {
  tenant_id?: string;
  phone_number_id: string;
  message_id: string;
  user_id?: string;
  status: WaMessageStatus;
  status_at?: number;
  msg_type?: string;
  error_code?: string;
  error_detail?: string;
  template_name?: string; // ENTREGA-WA-1
}): Promise<WaMessageStatusRow> {
  const tenantId = (input.tenant_id || currentWorkspaceId() || "default").trim() || "default";
  const messageId = String(input.message_id || "").trim();
  if (!messageId) throw new Error("message_id requerido para guardar el estado de WhatsApp");
  const next: WaMessageStatusRow = {
    message_id: messageId,
    phone_number_id: String(input.phone_number_id || "").trim(),
    user_id: String(input.user_id || "").trim(),
    status: input.status,
    status_at: input.status_at || Date.now(),
    ...(input.error_code ? { error_code: String(input.error_code).slice(0, 80) } : {}),
    ...(input.error_detail ? { error_detail: String(input.error_detail).slice(0, 500) } : {}),
  };
  const tplName = String(input.template_name || "").trim();
  if (!pool) {
    const key = `${tenantId}|${messageId}`;
    const prev = mem.waMessageStatuses.get(key);
    // ENTREGA-WA-1 · el estado solo avanza, pero la plantilla y la primera vez que se vio el
    // mensaje se conservan siempre: un «aceptado» que llega tarde aún enlaza su plantilla.
    const base = !prev ? next
      : waStatusRank[next.status] >= waStatusRank[prev.status]
        ? { ...next, phone_number_id: next.phone_number_id || prev.phone_number_id, user_id: next.user_id || prev.user_id }
        : prev;
    const row: WaMessageStatusRow = { ...base, first_at: prev?.first_at || Date.now() };
    const tpl = prev?.template_name || tplName;
    if (tpl) row.template_name = tpl;
    mem.waMessageStatuses.set(key, row);
    return row;
  }
  const rankSql = `(CASE status WHEN 'accepted' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 99 ELSE -1 END)`;
  // ENTREGA-WA-1 · antes el UPDATE entero llevaba «WHERE rango nuevo >= rango viejo»: un
  // «aceptado» de sendTemplate que llegara después del webhook no podía dejar la plantilla
  // en la fila, y la entrega nunca se atribuía. Ahora el estado (y su hora y su error) solo
  // avanza, pero la plantilla se rellena siempre que falte.
  const avanza = `${rankSql.replace(/status/g, "EXCLUDED.status")} >= ${rankSql.replace(/status/g, "app_wa_events.status")}`;
  const r = await pool.query(
    `INSERT INTO app_wa_events
       (id, tenant_id, phone_number_id, direction, msg_type, status, message_id, user_id, status_at, error_code, error_detail, template_name, created_at)
     VALUES ($1,$2,$3,'out',$4,$5,$6,$7,to_timestamp($8/1000.0),$9,$10,$11,now())
     ON CONFLICT (tenant_id, message_id) WHERE message_id IS NOT NULL AND message_id <> ''
     DO UPDATE SET
       phone_number_id=CASE WHEN EXCLUDED.phone_number_id<>'' THEN EXCLUDED.phone_number_id ELSE app_wa_events.phone_number_id END,
       user_id=CASE WHEN EXCLUDED.user_id<>'' THEN EXCLUDED.user_id ELSE app_wa_events.user_id END,
       template_name=COALESCE(app_wa_events.template_name, EXCLUDED.template_name),
       msg_type=CASE WHEN app_wa_events.template_name IS NULL AND EXCLUDED.template_name IS NOT NULL THEN 'template' ELSE app_wa_events.msg_type END,
       status=CASE WHEN ${avanza} THEN EXCLUDED.status ELSE app_wa_events.status END,
       status_at=CASE WHEN ${avanza} THEN EXCLUDED.status_at ELSE app_wa_events.status_at END,
       error_code=CASE WHEN ${avanza} THEN EXCLUDED.error_code ELSE app_wa_events.error_code END,
       error_detail=CASE WHEN ${avanza} THEN EXCLUDED.error_detail ELSE app_wa_events.error_detail END
     RETURNING message_id, phone_number_id, COALESCE(user_id,'') AS user_id, status,
               extract(epoch from COALESCE(status_at,created_at))*1000 AS status_at,
               error_code, error_detail`,
    [genUuid(), tenantId, next.phone_number_id, tplName ? "template" : (input.msg_type || "text"), next.status, messageId,
      next.user_id, next.status_at, next.error_code || null, next.error_detail || null, tplName || null],
  );
  const row = r.rows[0];
  if (next.user_id) void dbNotify("bstack_inbox", JSON.stringify({ tenant_id: tenantId, phone: next.user_id }));
  return { ...row, status_at: Number(row.status_at) } as WaMessageStatusRow;
}

/** Devuelve el estado real conocido de los wamids pedidos, limitado al workspace activo. */
export async function dbWaMessageStatuses(messageIds: string[]): Promise<Record<string, WaMessageStatusRow>> {
  const ids = [...new Set(messageIds.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 500);
  if (!ids.length) return {};
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const out: Record<string, WaMessageStatusRow> = {};
    for (const id of ids) {
      const row = mem.waMessageStatuses.get(`${tenantId}|${id}`);
      if (row) out[id] = row;
    }
    return out;
  }
  const r = await pool.query(
    `SELECT message_id, phone_number_id, COALESCE(user_id,'') AS user_id, status,
            extract(epoch from COALESCE(status_at,created_at))*1000 AS status_at,
            error_code, error_detail
       FROM app_wa_events WHERE tenant_id=$1 AND message_id = ANY($2::text[])`,
    [tenantId, ids],
  );
  const out: Record<string, WaMessageStatusRow> = {};
  for (const row of r.rows) out[String(row.message_id)] = { ...row, status_at: Number(row.status_at) } as WaMessageStatusRow;
  return out;
}

export interface WaReactionRow {
  message_id: string;
  from_role: "contact" | "agent";
  emoji: string;
  reacted_at: number;
}

/**
 * Guarda la reacción vigente de un lado (contacto o agente) a un mensaje.
 * emoji='' retira la reacción. Los webhooks pueden llegar desordenados: a
 * diferencia del estado de entrega no hay rango de avance posible (una
 * reacción se quita, no solo progresa), así que el desempate es por
 * reacted_at — una marca de tiempo anterior nunca pisa una posterior.
 */
export async function dbUpsertWaReaction(input: {
  tenant_id?: string;
  message_id: string;
  from_role: "contact" | "agent";
  emoji: string;
  reacted_at?: number;
}): Promise<WaReactionRow> {
  const tenantId = (input.tenant_id || currentWorkspaceId() || "default").trim() || "default";
  const messageId = String(input.message_id || "").trim();
  if (!messageId) throw new Error("message_id requerido para guardar una reacción");
  const fromRole: "contact" | "agent" = input.from_role === "agent" ? "agent" : "contact";
  const next: WaReactionRow = {
    message_id: messageId,
    from_role: fromRole,
    emoji: String(input.emoji || "").slice(0, 32),
    reacted_at: input.reacted_at || Date.now(),
  };
  if (!pool) {
    const key = `${tenantId}|${messageId}|${fromRole}`;
    const prev = mem.waReactions.get(key);
    if (!prev || next.reacted_at >= prev.reacted_at) mem.waReactions.set(key, next);
    return mem.waReactions.get(key)!;
  }
  const r = await pool.query(
    `INSERT INTO app_wa_reactions (tenant_id, message_id, from_role, emoji, reacted_at)
     VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0))
     ON CONFLICT (tenant_id, message_id, from_role)
     DO UPDATE SET emoji=EXCLUDED.emoji, reacted_at=EXCLUDED.reacted_at
     WHERE EXCLUDED.reacted_at >= app_wa_reactions.reacted_at
     RETURNING message_id, from_role, emoji, extract(epoch from reacted_at)*1000 AS reacted_at`,
    [tenantId, messageId, fromRole, next.emoji, next.reacted_at],
  );
  let row = r.rows[0];
  if (!row) {
    const cur = await pool.query(
      `SELECT message_id, from_role, emoji, extract(epoch from reacted_at)*1000 AS reacted_at
         FROM app_wa_reactions WHERE tenant_id=$1 AND message_id=$2 AND from_role=$3`,
      [tenantId, messageId, fromRole],
    );
    row = cur.rows[0];
  }
  void dbNotify("bstack_inbox", JSON.stringify({ tenant_id: tenantId }));
  return { ...row, reacted_at: Number(row.reacted_at) } as WaReactionRow;
}

/** Devuelve las reacciones vigentes (contacto y/o agente) de los mensajes pedidos. */
export async function dbWaReactionsFor(messageIds: string[]): Promise<Record<string, WaReactionRow[]>> {
  const ids = [...new Set(messageIds.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 500);
  if (!ids.length) return {};
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const out: Record<string, WaReactionRow[]> = {};
    for (const id of ids) {
      for (const role of ["contact", "agent"] as const) {
        const row = mem.waReactions.get(`${tenantId}|${id}|${role}`);
        if (row && row.emoji) (out[id] ||= []).push(row);
      }
    }
    return out;
  }
  const r = await pool.query(
    `SELECT message_id, from_role, emoji, extract(epoch from reacted_at)*1000 AS reacted_at
       FROM app_wa_reactions WHERE tenant_id=$1 AND message_id = ANY($2::text[]) AND emoji <> ''`,
    [tenantId, ids],
  );
  const out: Record<string, WaReactionRow[]> = {};
  for (const row of r.rows) {
    const id = String(row.message_id);
    (out[id] ||= []).push({ ...row, reacted_at: Number(row.reacted_at) } as WaReactionRow);
  }
  return out;
}

/**
 * Inserta un evento WA en app_wa_events.
 * - direction='out' cuando el bot envía (text/template/...)
 * - direction='in' cuando llega un mensaje al webhook
 * - response_time_ms: calculado por el caller (solo en 'in' tras buscar
 *   el último 'out' al mismo número en los últimos 60min).
 */
export async function dbInsertWaEvent(input: {
  tenant_id?: string;
  phone_number_id: string;
  direction: WaEventDirection;
  msg_type?: string | null;
  status?: string | null;
  template_name?: string | null;
  response_time_ms?: number | null;
}): Promise<WaEventRow> {
  const id = genUuid();
  const tenant_id = (input.tenant_id || "default").trim() || "default";
  const phone_number_id = String(input.phone_number_id || "").trim();
  const row: WaEventRow = {
    id,
    tenant_id,
    phone_number_id,
    direction: input.direction,
    msg_type: input.msg_type ?? null,
    status: input.status ?? null,
    template_name: input.template_name ?? null,
    response_time_ms: input.response_time_ms ?? null,
    created_at: Date.now(),
  };
  if (!pool) {
    mem.waEvents.unshift(row);
    if (mem.waEvents.length > 5000) mem.waEvents.length = 5000;
    return row;
  }
  await pool.query(
    `INSERT INTO app_wa_events
       (id, tenant_id, phone_number_id, direction, msg_type, status, template_name, response_time_ms, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_timestamp($9/1000.0))`,
    [
      id,
      tenant_id,
      phone_number_id,
      input.direction,
      input.msg_type ?? null,
      input.status ?? null,
      input.template_name ?? null,
      input.response_time_ms ?? null,
      row.created_at,
    ],
  );
  return row;
}

/**
 * Busca el último 'out' al mismo número en los últimos windowMs (default 60min).
 * Devuelve el created_at en ms si existe, o null. Usado para calcular
 * response_time_ms al ingresar un 'in'.
 *
 * Hueco: el destinatario del out no se almacena (sólo phone_number_id, que
 * es el número EMISOR). La heurística "último out de este número" basta a
 * nivel agregado para tiempo medio: medimos cuánto tarda el cliente en
 * responder tras un envío del bot al MISMO número (sin distinguir por
 * destinatario individual). Buen señal cruda; afinable en M4 si hace falta.
 */
export async function dbWaLastOutTs(input: {
  tenant_id: string;
  phone_number_id: string;
  windowMs?: number;
}): Promise<number | null> {
  const windowMs = Math.max(1000, Number(input.windowMs) || 60 * 60 * 1000);
  const sinceMs = Date.now() - windowMs;
  if (!pool) {
    const r = mem.waEvents.find(
      (x) =>
        x.tenant_id === input.tenant_id &&
        x.phone_number_id === input.phone_number_id &&
        x.direction === "out" &&
        x.created_at >= sinceMs,
    );
    return r ? r.created_at : null;
  }
  const r = await pool.query(
    `SELECT extract(epoch from created_at)*1000 AS ts_ms
       FROM app_wa_events
      WHERE tenant_id=$1 AND phone_number_id=$2 AND direction='out'
        AND created_at >= to_timestamp($3/1000.0)
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.tenant_id, input.phone_number_id, sinceMs],
  );
  if (!r.rows.length) return null;
  return Number(r.rows[0].ts_ms) || null;
}

// NUMEROS-NEGOCIO-1 (MET-WA-01) · phone_number_id de las métricas de WhatsApp puede ser
// uno o varios números separados por comas («a,b»): el panel deja elegir varios del
// mismo negocio. Vacío = todos los del workspace. Quien llama ya validó que son suyos.
export function waPidList(v?: string): string[] {
  return [...new Set(String(v || "").split(",").map((s) => s.trim()).filter(Boolean))];
}
function waPidMatch(v: string | undefined, pid: string): boolean {
  const l = waPidList(v);
  return !l.length || l.includes(pid);
}

/**
 * Devuelve un array de buckets por hora del día (0-23) x día de la semana
 * (0-6, lunes=0) con count_in y count_out — alimenta el heatmap 24x7.
 * Rango: últimos `days` días en el tenant.
 */
export async function dbWaEventsHourly(input: {
  tenant_id: string;
  phone_number_id?: string;
  days: number;
  sinceMs?: number; // ventana custom del calendario (si no, últimos `days`)
  untilMs?: number;
}): Promise<Array<{ hour: number; dow: number; count_in: number; count_out: number }>> {
  const days = Math.max(1, Math.min(365, Number(input.days) || 30));
  const sinceMs = input.sinceMs ?? (Date.now() - days * 24 * 3600 * 1000);
  const untilMs = input.untilMs ?? Date.now();
  // Iniciamos el grid 24*7 a 0 para que la UI tenga celdas estables aunque
  // no haya datos en ese hueco.
  const grid = new Map<string, { hour: number; dow: number; count_in: number; count_out: number }>();
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      grid.set(`${dow}:${hour}`, { hour, dow, count_in: 0, count_out: 0 });
    }
  }
  const apply = (ts: number, direction: WaEventDirection) => {
    const d = new Date(ts);
    const hour = d.getHours();
    // JS getDay(): 0=domingo. Normalizamos a lunes=0..domingo=6 (es-ES).
    const dow = (d.getDay() + 6) % 7;
    const cell = grid.get(`${dow}:${hour}`);
    if (!cell) return;
    if (direction === "in") cell.count_in++;
    else cell.count_out++;
  };
  if (!pool) {
    const rows = mem.waEvents.filter(
      (r) =>
        r.tenant_id === input.tenant_id &&
        r.created_at >= sinceMs &&
        r.created_at <= untilMs &&
        waPidMatch(input.phone_number_id, r.phone_number_id),
    );
    for (const r of rows) apply(r.created_at, r.direction);
    return [...grid.values()];
  }
  const params: any[] = [input.tenant_id, sinceMs, untilMs];
  let pidWhere = "";
  if (input.phone_number_id) {
    params.push(waPidList(input.phone_number_id));
    pidWhere = ` AND phone_number_id = ANY($${params.length}::text[])`;
  }
  const r = await pool.query(
    `SELECT extract(epoch from created_at)*1000 AS ts_ms, direction
       FROM app_wa_events
      WHERE tenant_id=$1 AND created_at >= to_timestamp($2/1000.0) AND created_at <= to_timestamp($3/1000.0)${pidWhere}`,
    params,
  );
  for (const row of r.rows) {
    apply(Number(row.ts_ms) || 0, row.direction as WaEventDirection);
  }
  return [...grid.values()];
}

/**
 * Serie DIARIA de mensajes in/out en el rango (para gráficos «Mensajes por día»).
 * Días sin actividad se rellenan a 0 — aquí el 0 es real (no hubo mensajes).
 */
export async function dbWaEventsDaily(input: {
  tenant_id: string;
  phone_number_id?: string;
  days: number;
  sinceMs?: number;
  untilMs?: number;
}): Promise<Array<{ date: string; count_in: number; count_out: number }>> {
  const days = Math.max(1, Math.min(365, Number(input.days) || 30));
  const sinceMs = input.sinceMs ?? (Date.now() - days * 24 * 3600 * 1000);
  const untilMs = input.untilMs ?? Date.now();
  const key = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const map = new Map<string, { count_in: number; count_out: number }>();
  for (let t = sinceMs; t <= untilMs; t += 24 * 3600 * 1000) map.set(key(t), { count_in: 0, count_out: 0 });
  map.set(key(untilMs), map.get(key(untilMs)) || { count_in: 0, count_out: 0 });
  const apply = (ts: number, direction: WaEventDirection) => {
    const cell = map.get(key(ts));
    if (!cell) return;
    if (direction === "in") cell.count_in++;
    else cell.count_out++;
  };
  if (!pool) {
    for (const r of mem.waEvents) {
      if (r.tenant_id !== input.tenant_id) continue;
      if (r.created_at < sinceMs || r.created_at > untilMs) continue;
      if (!waPidMatch(input.phone_number_id, r.phone_number_id)) continue;
      apply(r.created_at, r.direction);
    }
  } else {
    const params: any[] = [input.tenant_id, sinceMs, untilMs];
    let pidWhere = "";
    if (input.phone_number_id) {
      params.push(waPidList(input.phone_number_id));
      pidWhere = ` AND phone_number_id = ANY($${params.length}::text[])`;
    }
    const r = await pool.query(
      `SELECT extract(epoch from created_at)*1000 AS ts_ms, direction
         FROM app_wa_events
        WHERE tenant_id=$1 AND created_at >= to_timestamp($2/1000.0) AND created_at <= to_timestamp($3/1000.0)${pidWhere}`,
      params,
    );
    for (const row of r.rows) apply(Number(row.ts_ms) || 0, row.direction as WaEventDirection);
  }
  return [...map.entries()]
    .map(([date, v]) => ({ date, count_in: v.count_in, count_out: v.count_out }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * ENTREGA-WA-1 · Entrega por plantilla en el rango. Antes el envío guardaba una fila sin id
 * de mensaje y las confirmaciones de Meta caían en OTRA fila sin plantilla: «Entregadas»
 * salía «—» siempre, y un rechazo suelto pintaba «0 % entregadas». Ahora cada mensaje es
 * UNA fila (por su id) con su plantilla y su último estado. Definiciones:
 *  - sent: envíos de la plantilla (todos, con o sin seguimiento).
 *  - tracked: envíos cuyo resultado se puede seguir = con id de mensaje + rechazados al enviar.
 *  - delivered: entregados (incluye leídos) · read: leídos · failed: rechazados al enviar o
 *    que WhatsApp no pudo entregar · pending: aceptados sin confirmación todavía (NO fallos).
 *  - untracked: envíos sin id guardado (anteriores a esta mejora): no se sabe qué pasó.
 *  - *_pct: sobre tracked; null si tracked = 0 (sin seguimiento ≠ 0 % real).
 */
export interface WaTemplateEntrega {
  name: string; sent: number; tracked: number; delivered: number; read: number; failed: number; pending: number; untracked: number;
  delivered_pct: number | null; read_pct: number | null; failed_pct: number | null; pending_pct: number | null;
}
export async function dbWaEventsByTemplate(input: {
  tenant_id: string;
  phone_number_id?: string;
  days: number;
  sinceMs?: number;
  untilMs?: number;
}): Promise<WaTemplateEntrega[]> {
  const days = Math.max(1, Math.min(365, Number(input.days) || 30));
  const sinceMs = input.sinceMs ?? (Date.now() - days * 24 * 3600 * 1000);
  const untilMs = input.untilMs ?? Date.now();
  const acc = new Map<string, WaTemplateEntrega>();
  const bump = (name: string, status: string | null, conId: boolean) => {
    const a = acc.get(name) || { name, sent: 0, tracked: 0, delivered: 0, read: 0, failed: 0, pending: 0, untracked: 0, delivered_pct: null, read_pct: null, failed_pct: null, pending_pct: null };
    a.sent++;
    const s = (status || "").toLowerCase();
    if (s === "failed") { a.tracked++; a.failed++; }
    else if (!conId) a.untracked++;
    else {
      a.tracked++;
      if (s === "delivered" || s === "read") a.delivered++;
      else a.pending++;
      if (s === "read") a.read++;
    }
    acc.set(name, a);
  };
  if (!pool) {
    for (const r of mem.waEvents) {
      if (r.tenant_id === input.tenant_id && r.template_name && r.created_at >= sinceMs && r.created_at <= untilMs &&
        waPidMatch(input.phone_number_id, r.phone_number_id)) bump(r.template_name, r.status, false);
    }
    const pref = input.tenant_id + "|";
    for (const [k, r] of mem.waMessageStatuses) {
      const t0 = r.first_at || r.status_at;
      if (k.startsWith(pref) && r.template_name && t0 >= sinceMs && t0 <= untilMs &&
        waPidMatch(input.phone_number_id, r.phone_number_id)) bump(r.template_name, r.status, true);
    }
  } else {
    const params: any[] = [input.tenant_id, sinceMs, untilMs];
    let pidWhere = "";
    if (input.phone_number_id) {
      params.push(waPidList(input.phone_number_id));
      pidWhere = ` AND phone_number_id = ANY($${params.length}::text[])`;
    }
    const r = await pool.query(
      `SELECT template_name, status, (message_id IS NOT NULL AND message_id<>'') AS con_id, count(*)::int AS n
         FROM app_wa_events
        WHERE tenant_id=$1 AND created_at >= to_timestamp($2/1000.0) AND created_at <= to_timestamp($3/1000.0)
          AND template_name IS NOT NULL AND direction='out'${pidWhere}
        GROUP BY 1, 2, 3`,
      params,
    );
    for (const row of r.rows) for (let i = 0; i < Number(row.n); i++) bump(String(row.template_name), row.status, !!row.con_id);
  }
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  const out = [...acc.values()].map((a) => ({
    ...a,
    delivered_pct: pct(a.delivered, a.tracked),
    read_pct: pct(a.read, a.tracked),
    failed_pct: pct(a.failed, a.tracked),
    pending_pct: pct(a.pending, a.tracked),
  }));
  out.sort((a, b) => b.sent - a.sent);
  return out;
}

/**
 * Tiempo de respuesta sobre filas 'in' con response_time_ms NOT NULL,
 * en los últimos `days` días. Devuelve avg y p95 en milisegundos
 * (null si no hay muestras). Lo consume la KPI "tiempo medio de respuesta".
 */
export async function dbWaResponseTimeAvg(input: {
  tenant_id: string;
  phone_number_id?: string;
  days: number;
  sinceMs?: number;
  untilMs?: number;
}): Promise<{ avg_ms: number | null; p95_ms: number | null; sample: number }> {
  const days = Math.max(1, Math.min(365, Number(input.days) || 30));
  const sinceMs = input.sinceMs ?? (Date.now() - days * 24 * 3600 * 1000);
  const untilMs = input.untilMs ?? Date.now();
  let samples: number[];
  if (!pool) {
    samples = mem.waEvents
      .filter(
        (r) =>
          r.tenant_id === input.tenant_id &&
          r.direction === "in" &&
          r.response_time_ms != null &&
          r.created_at >= sinceMs &&
          r.created_at <= untilMs &&
          waPidMatch(input.phone_number_id, r.phone_number_id),
      )
      .map((r) => Number(r.response_time_ms) || 0);
  } else {
    const params: any[] = [input.tenant_id, sinceMs, untilMs];
    let pidWhere = "";
    if (input.phone_number_id) {
      params.push(waPidList(input.phone_number_id));
      pidWhere = ` AND phone_number_id = ANY($${params.length}::text[])`;
    }
    const r = await pool.query(
      `SELECT response_time_ms
         FROM app_wa_events
        WHERE tenant_id=$1 AND created_at >= to_timestamp($2/1000.0) AND created_at <= to_timestamp($3/1000.0)
          AND direction='in' AND response_time_ms IS NOT NULL${pidWhere}`,
      params,
    );
    samples = r.rows.map((row: any) => Number(row.response_time_ms) || 0);
  }
  if (!samples.length) return { avg_ms: null, p95_ms: null, sample: 0 };
  const total = samples.reduce((a, b) => a + b, 0);
  const avg = Math.round(total / samples.length);
  const sorted = samples.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = sorted[idx] ?? null;
  return { avg_ms: avg, p95_ms: p95, sample: samples.length };
}

// ============================================================
// meta-ads-pro A3 — Creative Library helpers.
//
// CRUD sobre app_ads_creatives. Reglas comunes:
//   - tenant_id se pasa SIEMPRE explicito (el caller usa
//     currentWorkspaceId() dentro del guard). Si llegara vacio, fallback
//     'default' por seguridad.
//   - dbList filtra siempre por tenant_id ANTES de aplicar otros filtros
//     (multi-tenant strict).
//   - dbUpdateCreativeStatus solo permite transiciones de status (no toca
//     name/url/body — para eso un futuro dbUpdateCreative).
// ============================================================

function rowToAdsCreative(r: any): AdsCreativeRow {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    ad_account_id: r.ad_account_id ?? null,
    meta_id: r.meta_id ?? null,
    type: String(r.type) as AdsCreativeType,
    name: String(r.name || ""),
    url: r.url ?? null,
    thumb_url: r.thumb_url ?? null,
    body: r.body ?? null,
    status: String(r.status) as AdsCreativeStatus,
    error: r.error ?? null,
    created_at: Number(r.created_at_ms ?? r.created_at ?? 0),
    updated_at: Number(r.updated_at_ms ?? r.updated_at ?? 0),
  };
}

/**
 * Inserta un creative. Defaults: status='draft', body=null si no aplica.
 * Devuelve la row creada (con id generado).
 */
export async function dbInsertCreative(input: {
  tenant_id?: string;
  ad_account_id?: string | null;
  meta_id?: string | null;
  type: AdsCreativeType;
  name?: string;
  url?: string | null;
  thumb_url?: string | null;
  body?: Record<string, unknown> | null;
  status?: AdsCreativeStatus;
}): Promise<AdsCreativeRow> {
  const id = genUuid();
  const tenant_id = (input.tenant_id || "default").trim() || "default";
  const now = Date.now();
  const row: AdsCreativeRow = {
    id,
    tenant_id,
    ad_account_id: input.ad_account_id ?? null,
    meta_id: input.meta_id ?? null,
    type: input.type,
    name: String(input.name || ""),
    url: input.url ?? null,
    thumb_url: input.thumb_url ?? null,
    body: input.body ?? null,
    status: input.status || "draft",
    error: null,
    created_at: now,
    updated_at: now,
  };
  if (!pool) {
    mem.adsCreatives.unshift(row);
    if (mem.adsCreatives.length > 2000) mem.adsCreatives.length = 2000;
    return row;
  }
  await pool.query(
    `INSERT INTO app_ads_creatives
       (id, tenant_id, ad_account_id, meta_id, type, name, url, thumb_url, body, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, to_timestamp($11/1000.0), to_timestamp($11/1000.0))`,
    [
      id,
      tenant_id,
      row.ad_account_id,
      row.meta_id,
      row.type,
      row.name,
      row.url,
      row.thumb_url,
      row.body ? JSON.stringify(row.body) : null,
      row.status,
      now,
    ],
  );
  return row;
}

/**
 * Lista creatives del WS con filtros opcionales (adAccountId/type/status).
 * Order by created_at DESC. Cap limit a 500.
 */
export async function dbListCreatives(input: {
  tenantId: string;
  adAccountId?: string;
  type?: AdsCreativeType;
  status?: AdsCreativeStatus;
  limit?: number;
  offset?: number;
}): Promise<AdsCreativeRow[]> {
  const tenantId = (input.tenantId || "default").trim() || "default";
  const limitRaw = Number(input.limit ?? 100);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 100));
  const offset = Math.max(0, Number(input.offset ?? 0) || 0);

  if (!pool) {
    let rows = mem.adsCreatives.filter((r) => r.tenant_id === tenantId);
    if (input.adAccountId) rows = rows.filter((r) => r.ad_account_id === input.adAccountId);
    if (input.type) rows = rows.filter((r) => r.type === input.type);
    if (input.status) rows = rows.filter((r) => r.status === input.status);
    rows.sort((a, b) => b.created_at - a.created_at);
    return rows.slice(offset, offset + limit);
  }

  const where: string[] = ["tenant_id=$1"];
  const params: any[] = [tenantId];
  if (input.adAccountId) {
    params.push(input.adAccountId);
    where.push(`ad_account_id=$${params.length}`);
  }
  if (input.type) {
    params.push(input.type);
    where.push(`type=$${params.length}`);
  }
  if (input.status) {
    params.push(input.status);
    where.push(`status=$${params.length}`);
  }
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  const r = await pool.query(
    `SELECT id, tenant_id, ad_account_id, meta_id, type, name, url, thumb_url, body, status, error,
            extract(epoch from created_at)*1000 AS created_at_ms,
            extract(epoch from updated_at)*1000 AS updated_at_ms
       FROM app_ads_creatives
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return r.rows.map(rowToAdsCreative);
}

/**
 * Devuelve la row con id en el WS dado, o null. Es el ownership-check
 * sentinel: si dbGetCreative({ id, tenantId }) devuelve null, el caller
 * debe responder 404 (no revelar si existe en otro tenant).
 */
export async function dbGetCreative(input: {
  id: string;
  tenantId: string;
}): Promise<AdsCreativeRow | null> {
  const id = String(input.id || "").trim();
  const tenantId = (input.tenantId || "default").trim() || "default";
  if (!id) return null;
  if (!pool) {
    return mem.adsCreatives.find((r) => r.id === id && r.tenant_id === tenantId) || null;
  }
  const r = await pool.query(
    `SELECT id, tenant_id, ad_account_id, meta_id, type, name, url, thumb_url, body, status, error,
            extract(epoch from created_at)*1000 AS created_at_ms,
            extract(epoch from updated_at)*1000 AS updated_at_ms
       FROM app_ads_creatives
      WHERE id=$1 AND tenant_id=$2
      LIMIT 1`,
    [id, tenantId],
  );
  if (!r.rows.length) return null;
  return rowToAdsCreative(r.rows[0]);
}

/**
 * Actualiza status (+ opcional meta_id / error). Solo toca la row si pertenece
 * al tenant — el WHERE multi-tenant lo garantiza.
 */
export async function dbUpdateCreativeStatus(input: {
  id: string;
  tenantId: string;
  status: AdsCreativeStatus;
  meta_id?: string | null;
  error?: string | null;
}): Promise<void> {
  const id = String(input.id || "").trim();
  const tenantId = (input.tenantId || "default").trim() || "default";
  if (!id) return;
  const now = Date.now();
  if (!pool) {
    const row = mem.adsCreatives.find((r) => r.id === id && r.tenant_id === tenantId);
    if (!row) return;
    row.status = input.status;
    if (input.meta_id !== undefined) row.meta_id = input.meta_id;
    if (input.error !== undefined) row.error = input.error;
    row.updated_at = now;
    return;
  }
  // Construimos UPDATE dinamico para no pisar meta_id/error si no vienen.
  const sets: string[] = [`status=$3`, `updated_at=to_timestamp($4/1000.0)`];
  const params: any[] = [id, tenantId, input.status, now];
  if (input.meta_id !== undefined) {
    params.push(input.meta_id);
    sets.push(`meta_id=$${params.length}`);
  }
  if (input.error !== undefined) {
    params.push(input.error);
    sets.push(`error=$${params.length}`);
  }
  await pool.query(
    `UPDATE app_ads_creatives SET ${sets.join(", ")} WHERE id=$1 AND tenant_id=$2`,
    params,
  );
}

/**
 * Borra una row del WS. Devuelve true si borró algo. Multi-tenant strict:
 * el WHERE tenant_id evita que un actor con id ajeno borre cross-tenant.
 */
export async function dbDeleteCreative(input: {
  id: string;
  tenantId: string;
}): Promise<boolean> {
  const id = String(input.id || "").trim();
  const tenantId = (input.tenantId || "default").trim() || "default";
  if (!id) return false;
  if (!pool) {
    const before = mem.adsCreatives.length;
    mem.adsCreatives = mem.adsCreatives.filter(
      (r) => !(r.id === id && r.tenant_id === tenantId),
    );
    return mem.adsCreatives.length < before;
  }
  const r = await pool.query(
    `DELETE FROM app_ads_creatives WHERE id=$1 AND tenant_id=$2`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

// ============================================================
// meta-ads-pro A4 — Experiments CRUD helpers.
//
// Reglas comunes (paralelo a creatives):
//   - tenant_id SIEMPRE explicito (caller usa currentWorkspaceId() bajo guard).
//   - dbList* filtra siempre por tenant_id ANTES de aplicar otros filtros.
//   - variants se serializa a JSON al insertar / parsea al leer.
//   - dbUpdateExperimentStatus solo toca status/ended_at/winner_ad_id/error
//     (no toca variants — para eso un dbUpdateExperimentVariants explicito).
// ============================================================

function rowToAdsExperiment(r: any): AdsExperimentRow {
  let variants: AdsExperimentVariant[] = [];
  try {
    const raw = r.variants;
    if (Array.isArray(raw)) variants = raw as AdsExperimentVariant[];
    else if (typeof raw === "string" && raw.length) variants = JSON.parse(raw);
  } catch {
    variants = [];
  }
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    ad_account_id: String(r.ad_account_id || ""),
    name: String(r.name || ""),
    base_campaign_id: String(r.base_campaign_id || ""),
    variants,
    started_at: Number(r.started_at_ms ?? r.started_at ?? 0),
    ended_at: r.ended_at_ms != null ? Number(r.ended_at_ms) : r.ended_at != null ? Number(r.ended_at) : null,
    winner_ad_id: r.winner_ad_id ?? null,
    status: String(r.status) as AdsExperimentStatus,
    error: r.error ?? null,
    created_at: Number(r.created_at_ms ?? r.created_at ?? 0),
    updated_at: Number(r.updated_at_ms ?? r.updated_at ?? 0),
  };
}

/**
 * Inserta un experimento. Defaults: status='running', winner null, ended_at null.
 */
export async function dbInsertExperiment(input: {
  tenant_id?: string;
  ad_account_id: string;
  name: string;
  base_campaign_id: string;
  variants: AdsExperimentVariant[];
  status?: AdsExperimentStatus;
}): Promise<AdsExperimentRow> {
  const id = genUuid();
  const tenant_id = (input.tenant_id || "default").trim() || "default";
  const now = Date.now();
  const variants = Array.isArray(input.variants) ? input.variants : [];
  const row: AdsExperimentRow = {
    id,
    tenant_id,
    ad_account_id: String(input.ad_account_id || ""),
    name: String(input.name || "").slice(0, 200),
    base_campaign_id: String(input.base_campaign_id || ""),
    variants,
    started_at: now,
    ended_at: null,
    winner_ad_id: null,
    status: input.status || "running",
    error: null,
    created_at: now,
    updated_at: now,
  };
  if (!pool) {
    mem.adsExperiments.unshift(row);
    if (mem.adsExperiments.length > 500) mem.adsExperiments.length = 500;
    return row;
  }
  await pool.query(
    `INSERT INTO app_ads_experiments
       (id, tenant_id, ad_account_id, name, base_campaign_id, variants, started_at, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb, to_timestamp($7/1000.0), $8, to_timestamp($7/1000.0), to_timestamp($7/1000.0))`,
    [
      id,
      tenant_id,
      row.ad_account_id,
      row.name,
      row.base_campaign_id,
      JSON.stringify(row.variants),
      now,
      row.status,
    ],
  );
  return row;
}

/**
 * Lista experimentos del WS con filtros opcionales (adAccountId/status).
 * Order by created_at DESC. Cap limit a 500.
 */
export async function dbListExperiments(input: {
  tenantId: string;
  adAccountId?: string;
  status?: AdsExperimentStatus;
  limit?: number;
  offset?: number;
}): Promise<AdsExperimentRow[]> {
  const tenantId = (input.tenantId || "default").trim() || "default";
  const limitRaw = Number(input.limit ?? 100);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 100));
  const offset = Math.max(0, Number(input.offset ?? 0) || 0);

  if (!pool) {
    let rows = mem.adsExperiments.filter((r) => r.tenant_id === tenantId);
    if (input.adAccountId) rows = rows.filter((r) => r.ad_account_id === input.adAccountId);
    if (input.status) rows = rows.filter((r) => r.status === input.status);
    rows.sort((a, b) => b.created_at - a.created_at);
    return rows.slice(offset, offset + limit);
  }

  const where: string[] = ["tenant_id=$1"];
  const params: any[] = [tenantId];
  if (input.adAccountId) {
    params.push(input.adAccountId);
    where.push(`ad_account_id=$${params.length}`);
  }
  if (input.status) {
    params.push(input.status);
    where.push(`status=$${params.length}`);
  }
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  const r = await pool.query(
    `SELECT id, tenant_id, ad_account_id, name, base_campaign_id, variants, winner_ad_id, status, error,
            extract(epoch from started_at)*1000 AS started_at_ms,
            extract(epoch from ended_at)*1000 AS ended_at_ms,
            extract(epoch from created_at)*1000 AS created_at_ms,
            extract(epoch from updated_at)*1000 AS updated_at_ms
       FROM app_ads_experiments
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return r.rows.map(rowToAdsExperiment);
}

/**
 * Devuelve el experimento con id en el WS dado, o null. Ownership-check sentinel.
 */
export async function dbGetExperiment(input: {
  id: string;
  tenantId: string;
}): Promise<AdsExperimentRow | null> {
  const id = String(input.id || "").trim();
  const tenantId = (input.tenantId || "default").trim() || "default";
  if (!id) return null;
  if (!pool) {
    return mem.adsExperiments.find((r) => r.id === id && r.tenant_id === tenantId) || null;
  }
  const r = await pool.query(
    `SELECT id, tenant_id, ad_account_id, name, base_campaign_id, variants, winner_ad_id, status, error,
            extract(epoch from started_at)*1000 AS started_at_ms,
            extract(epoch from ended_at)*1000 AS ended_at_ms,
            extract(epoch from created_at)*1000 AS created_at_ms,
            extract(epoch from updated_at)*1000 AS updated_at_ms
       FROM app_ads_experiments
      WHERE id=$1 AND tenant_id=$2
      LIMIT 1`,
    [id, tenantId],
  );
  if (!r.rows.length) return null;
  return rowToAdsExperiment(r.rows[0]);
}

/**
 * Update status / winner / error / ended_at del experimento. Sin ownership ya
 * mediado: el WHERE tenant_id es el cinturon de seguridad multi-tenant.
 */
export async function dbUpdateExperimentStatus(input: {
  id: string;
  tenantId: string;
  status?: AdsExperimentStatus;
  winner_ad_id?: string | null;
  error?: string | null;
  setEndedNow?: boolean;
}): Promise<void> {
  const id = String(input.id || "").trim();
  const tenantId = (input.tenantId || "default").trim() || "default";
  if (!id) return;
  const now = Date.now();
  if (!pool) {
    const row = mem.adsExperiments.find((r) => r.id === id && r.tenant_id === tenantId);
    if (!row) return;
    if (input.status !== undefined) row.status = input.status;
    if (input.winner_ad_id !== undefined) row.winner_ad_id = input.winner_ad_id;
    if (input.error !== undefined) row.error = input.error;
    if (input.setEndedNow) row.ended_at = now;
    row.updated_at = now;
    return;
  }
  const sets: string[] = [`updated_at=to_timestamp($3/1000.0)`];
  const params: any[] = [id, tenantId, now];
  if (input.status !== undefined) {
    params.push(input.status);
    sets.push(`status=$${params.length}`);
  }
  if (input.winner_ad_id !== undefined) {
    params.push(input.winner_ad_id);
    sets.push(`winner_ad_id=$${params.length}`);
  }
  if (input.error !== undefined) {
    params.push(input.error);
    sets.push(`error=$${params.length}`);
  }
  if (input.setEndedNow) {
    sets.push(`ended_at=to_timestamp($3/1000.0)`);
  }
  await pool.query(
    `UPDATE app_ads_experiments SET ${sets.join(", ")} WHERE id=$1 AND tenant_id=$2`,
    params,
  );
}

/**
 * Borra un experimento del WS. No borra las entidades clonadas en Meta (la
 * receta de pausa al declarar ganador deja el resto en PAUSED, no DELETED).
 */
export async function dbDeleteExperiment(input: {
  id: string;
  tenantId: string;
}): Promise<boolean> {
  const id = String(input.id || "").trim();
  const tenantId = (input.tenantId || "default").trim() || "default";
  if (!id) return false;
  if (!pool) {
    const before = mem.adsExperiments.length;
    mem.adsExperiments = mem.adsExperiments.filter(
      (r) => !(r.id === id && r.tenant_id === tenantId),
    );
    return mem.adsExperiments.length < before;
  }
  const r = await pool.query(
    `DELETE FROM app_ads_experiments WHERE id=$1 AND tenant_id=$2`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

// ============================================================
// meta-ads-pro A5 — Alertas CRUD + log de disparos.
//
// Reglas comunes (paralelo a experiments):
//   - tenant_id SIEMPRE explícito (caller usa currentWorkspaceId() bajo
//     guardAdminLocal).
//   - dbListAlerts/dbListAlertLog filtran SIEMPRE por tenant_id ANTES
//     de cualquier otro filtro (multi-tenant strict).
//   - dbInsertAlert + dbInsertAlertLog usan UUID auto (gen_random_uuid
//     en pg, fallback genUuid en mem).
//   - dbToggleAlert/dbDeleteAlert tienen el WHERE tenant_id como
//     cinturón cruzado: aunque venga un id válido pero ajeno, el UPDATE
//     o DELETE no afecta filas de otro WS.
//   - dbInsertAlertLog NO toca app_ads_alerts.last_fired_at — eso lo
//     hace dbTouchAlertFired (separado) para que el caller decida si
//     considera "disparo real" (status='fired') o "snoozed".
// ============================================================

function rowToAdsAlert(r: any): AdsAlertRow {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    ad_account_id: String(r.ad_account_id || ""),
    name: String(r.name || ""),
    metric: String(r.metric) as AdsAlertMetric,
    operator: String(r.operator) as AdsAlertOperator,
    threshold: Number(r.threshold) || 0,
    scope: String(r.scope) as AdsAlertScope,
    scope_id: r.scope_id ?? null,
    channel: String(r.channel) as AdsAlertChannel,
    enabled: Boolean(r.enabled),
    last_fired_at:
      r.last_fired_at_ms != null
        ? Number(r.last_fired_at_ms)
        : r.last_fired_at != null
          ? Number(r.last_fired_at)
          : null,
    created_at: Number(r.created_at_ms ?? r.created_at ?? 0),
    updated_at: Number(r.updated_at_ms ?? r.updated_at ?? 0),
  };
}

function rowToAdsAlertLog(r: any): AdsAlertLogRow {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    alert_id: String(r.alert_id),
    value: Number(r.value) || 0,
    fired_at: Number(r.fired_at_ms ?? r.fired_at ?? 0),
    status: String(r.status) as AdsAlertLogStatus,
  };
}

/**
 * Inserta una nueva alerta. Defaults: enabled=true, last_fired_at=null,
 * scope_id=null si scope='account'. `threshold` se castea a Number — si
 * llega NaN, lo guardamos como 0 (la UI debe validar antes).
 */
export async function dbCreateAlert(input: {
  tenant_id?: string;
  ad_account_id: string;
  name: string;
  metric: AdsAlertMetric;
  operator: AdsAlertOperator;
  threshold: number;
  scope: AdsAlertScope;
  scope_id?: string | null;
  channel: AdsAlertChannel;
  enabled?: boolean;
}): Promise<AdsAlertRow> {
  const id = genUuid();
  const tenant_id = (input.tenant_id || "default").trim() || "default";
  const now = Date.now();
  const threshold = Number.isFinite(input.threshold) ? Number(input.threshold) : 0;
  const scope_id =
    input.scope === "account" ? null : input.scope_id ? String(input.scope_id) : null;
  const row: AdsAlertRow = {
    id,
    tenant_id,
    ad_account_id: String(input.ad_account_id || ""),
    name: String(input.name || "").slice(0, 200),
    metric: input.metric,
    operator: input.operator,
    threshold,
    scope: input.scope,
    scope_id,
    channel: input.channel,
    enabled: input.enabled !== false,
    last_fired_at: null,
    created_at: now,
    updated_at: now,
  };
  if (!pool) {
    mem.adsAlerts.unshift(row);
    if (mem.adsAlerts.length > 500) mem.adsAlerts.length = 500;
    return row;
  }
  await pool.query(
    `INSERT INTO app_ads_alerts
       (id, tenant_id, ad_account_id, name, metric, operator, threshold,
        scope, scope_id, channel, enabled, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             to_timestamp($12/1000.0), to_timestamp($12/1000.0))`,
    [
      id,
      tenant_id,
      row.ad_account_id,
      row.name,
      row.metric,
      row.operator,
      row.threshold,
      row.scope,
      row.scope_id,
      row.channel,
      row.enabled,
      now,
    ],
  );
  return row;
}

/**
 * Lista alertas del WS con filtros opcionales (adAccountId/enabled).
 * Order by created_at DESC. Cap limit a 500. Multi-tenant strict via tenant_id.
 */
export async function dbListAlerts(input: {
  tenantId: string;
  adAccountId?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}): Promise<AdsAlertRow[]> {
  const tenantId = (input.tenantId || "default").trim() || "default";
  const limitRaw = Number(input.limit ?? 200);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 200));
  const offset = Math.max(0, Number(input.offset ?? 0) || 0);

  if (!pool) {
    let rows = mem.adsAlerts.filter((r) => r.tenant_id === tenantId);
    if (input.adAccountId) rows = rows.filter((r) => r.ad_account_id === input.adAccountId);
    if (input.enabled !== undefined) rows = rows.filter((r) => r.enabled === input.enabled);
    rows.sort((a, b) => b.created_at - a.created_at);
    return rows.slice(offset, offset + limit);
  }
  const where: string[] = ["tenant_id=$1"];
  const params: any[] = [tenantId];
  if (input.adAccountId) {
    params.push(input.adAccountId);
    where.push(`ad_account_id=$${params.length}`);
  }
  if (input.enabled !== undefined) {
    params.push(input.enabled);
    where.push(`enabled=$${params.length}`);
  }
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  const r = await pool.query(
    `SELECT id, tenant_id, ad_account_id, name, metric, operator, threshold,
            scope, scope_id, channel, enabled,
            extract(epoch from last_fired_at)*1000 AS last_fired_at_ms,
            extract(epoch from created_at)*1000 AS created_at_ms,
            extract(epoch from updated_at)*1000 AS updated_at_ms
       FROM app_ads_alerts
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return r.rows.map(rowToAdsAlert);
}

/**
 * Devuelve la alerta con id en el WS dado, o null. Sentinel de ownership
 * (mismo patron que dbGetExperiment).
 */
export async function dbGetAlert(input: {
  id: string;
  tenantId: string;
}): Promise<AdsAlertRow | null> {
  const id = String(input.id || "").trim();
  const tenantId = (input.tenantId || "default").trim() || "default";
  if (!id) return null;
  if (!pool) {
    return mem.adsAlerts.find((r) => r.id === id && r.tenant_id === tenantId) || null;
  }
  const r = await pool.query(
    `SELECT id, tenant_id, ad_account_id, name, metric, operator, threshold,
            scope, scope_id, channel, enabled,
            extract(epoch from last_fired_at)*1000 AS last_fired_at_ms,
            extract(epoch from created_at)*1000 AS created_at_ms,
            extract(epoch from updated_at)*1000 AS updated_at_ms
       FROM app_ads_alerts
      WHERE id=$1 AND tenant_id=$2
      LIMIT 1`,
    [id, tenantId],
  );
  if (!r.rows.length) return null;
  return rowToAdsAlert(r.rows[0]);
}

/**
 * Toggle enabled on/off. Devuelve el nuevo valor o null si no se encontró.
 * El WHERE tenant_id evita toggles cross-tenant.
 */
export async function dbToggleAlert(input: {
  id: string;
  tenantId: string;
  enabled?: boolean;
}): Promise<boolean | null> {
  const id = String(input.id || "").trim();
  const tenantId = (input.tenantId || "default").trim() || "default";
  if (!id) return null;
  const now = Date.now();
  if (!pool) {
    const row = mem.adsAlerts.find((r) => r.id === id && r.tenant_id === tenantId);
    if (!row) return null;
    row.enabled = input.enabled !== undefined ? !!input.enabled : !row.enabled;
    row.updated_at = now;
    return row.enabled;
  }
  if (input.enabled !== undefined) {
    const r = await pool.query(
      `UPDATE app_ads_alerts
          SET enabled=$3, updated_at=to_timestamp($4/1000.0)
        WHERE id=$1 AND tenant_id=$2
        RETURNING enabled`,
      [id, tenantId, !!input.enabled, now],
    );
    if (!r.rows.length) return null;
    return Boolean(r.rows[0].enabled);
  }
  // Toggle clásico: invierte sin saber el valor previo de antemano.
  const r = await pool.query(
    `UPDATE app_ads_alerts
        SET enabled = NOT enabled, updated_at=to_timestamp($3/1000.0)
      WHERE id=$1 AND tenant_id=$2
      RETURNING enabled`,
    [id, tenantId, now],
  );
  if (!r.rows.length) return null;
  return Boolean(r.rows[0].enabled);
}

/**
 * Actualiza el timestamp last_fired_at (epoch ms) de la alerta. Se llama
 * desde el worker cuando una alerta dispara. El WHERE tenant_id es
 * defensivo (el caller ya hizo dbGetAlert).
 */
export async function dbTouchAlertFired(input: {
  id: string;
  tenantId: string;
  whenMs?: number;
}): Promise<void> {
  const id = String(input.id || "").trim();
  const tenantId = (input.tenantId || "default").trim() || "default";
  if (!id) return;
  const when = Number(input.whenMs) || Date.now();
  if (!pool) {
    const row = mem.adsAlerts.find((r) => r.id === id && r.tenant_id === tenantId);
    if (!row) return;
    row.last_fired_at = when;
    row.updated_at = when;
    return;
  }
  await pool.query(
    `UPDATE app_ads_alerts
        SET last_fired_at=to_timestamp($3/1000.0),
            updated_at=to_timestamp($3/1000.0)
      WHERE id=$1 AND tenant_id=$2`,
    [id, tenantId, when],
  );
}

/**
 * Borra una alerta del WS. CASCADE borra los rows de app_ads_alert_log
 * vinculados (FK ON DELETE CASCADE en la tabla).
 */
export async function dbDeleteAlert(input: {
  id: string;
  tenantId: string;
}): Promise<boolean> {
  const id = String(input.id || "").trim();
  const tenantId = (input.tenantId || "default").trim() || "default";
  if (!id) return false;
  if (!pool) {
    const before = mem.adsAlerts.length;
    mem.adsAlerts = mem.adsAlerts.filter(
      (r) => !(r.id === id && r.tenant_id === tenantId),
    );
    // Cascada manual en mem mode: limpiamos también el log de ese alert.
    mem.adsAlertLog = mem.adsAlertLog.filter((r) => r.alert_id !== id);
    return mem.adsAlerts.length < before;
  }
  const r = await pool.query(
    `DELETE FROM app_ads_alerts WHERE id=$1 AND tenant_id=$2`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Inserta un disparo en el log. status='fired' por defecto. tenant_id
 * SIEMPRE explícito (no se infiere del alert porque puede haberse borrado
 * en mem mode — paranoia anti-leak).
 */
export async function dbInsertAlertLog(input: {
  tenant_id: string;
  alert_id: string;
  value: number;
  status?: AdsAlertLogStatus;
  firedAtMs?: number;
}): Promise<AdsAlertLogRow> {
  const id = genUuid();
  const tenant_id = (input.tenant_id || "default").trim() || "default";
  const alert_id = String(input.alert_id || "").trim();
  const value = Number.isFinite(input.value) ? Number(input.value) : 0;
  const status: AdsAlertLogStatus = input.status || "fired";
  const fired_at = Number(input.firedAtMs) || Date.now();
  const row: AdsAlertLogRow = {
    id,
    tenant_id,
    alert_id,
    value,
    fired_at,
    status,
  };
  if (!pool) {
    mem.adsAlertLog.unshift(row);
    if (mem.adsAlertLog.length > 2000) mem.adsAlertLog.length = 2000;
    return row;
  }
  await pool.query(
    `INSERT INTO app_ads_alert_log
       (id, tenant_id, alert_id, value, fired_at, status)
     VALUES ($1,$2,$3,$4, to_timestamp($5/1000.0), $6)`,
    [id, tenant_id, alert_id, value, fired_at, status],
  );
  return row;
}

/**
 * Lista el log de disparos del WS. Filtros opcionales (alertId, status).
 * Order by fired_at DESC. Cap limit a 500.
 */
export async function dbListAlertLog(input: {
  tenantId: string;
  alertId?: string;
  status?: AdsAlertLogStatus;
  limit?: number;
  offset?: number;
}): Promise<AdsAlertLogRow[]> {
  const tenantId = (input.tenantId || "default").trim() || "default";
  const limitRaw = Number(input.limit ?? 100);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 100));
  const offset = Math.max(0, Number(input.offset ?? 0) || 0);
  if (!pool) {
    let rows = mem.adsAlertLog.filter((r) => r.tenant_id === tenantId);
    if (input.alertId) rows = rows.filter((r) => r.alert_id === input.alertId);
    if (input.status) rows = rows.filter((r) => r.status === input.status);
    rows.sort((a, b) => b.fired_at - a.fired_at);
    return rows.slice(offset, offset + limit);
  }
  const where: string[] = ["tenant_id=$1"];
  const params: any[] = [tenantId];
  if (input.alertId) {
    params.push(input.alertId);
    where.push(`alert_id=$${params.length}`);
  }
  if (input.status) {
    params.push(input.status);
    where.push(`status=$${params.length}`);
  }
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  const r = await pool.query(
    `SELECT id, tenant_id, alert_id, value, status,
            extract(epoch from fired_at)*1000 AS fired_at_ms
       FROM app_ads_alert_log
      WHERE ${where.join(" AND ")}
      ORDER BY fired_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return r.rows.map(rowToAdsAlertLog);
}

// ============================================================
// difusion-flow D2 — CRUD broadcast-flows + cola con SKIP LOCKED.
//
// Sobre estos 3 grupos de helpers (flows / runs / jobs) se monta el
// Broadcast Flow Builder. Reglas comunes:
//
//   - tenant_id SIEMPRE explicito en la llave (currentWorkspaceId() bajo
//     guard del router). Si llega vacio, fallback 'default'.
//   - TODOS los SELECTs filtran por tenant_id ANTES de aplicar otros
//     filtros (multi-tenant strict).
//   - dbGet* devuelve null si la row no existe O pertenece a otro WS
//     (ownership sentinel — el caller responde 404, no revela cross-WS).
//   - dbUpdate*/dbDelete* llevan WHERE id=$1 AND tenant_id=$2 como
//     cinturon cruzado: aunque venga un id valido pero ajeno, el UPDATE
//     o DELETE no afecta filas de otro WS.
//
// PIEDRA ANGULAR — dbDueJobs usa SELECT ... FOR UPDATE SKIP LOCKED.
// Esto es lo que hace la cola multi-replica safe en Railway:
//
//   tick A: SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50 → bloquea 50 rows
//   tick B (otra replica, en paralelo): SELECT ... FOR UPDATE SKIP LOCKED
//           LIMIT 50 → "salta" las 50 que tiene A bloqueadas y toma las
//           siguientes 50, sin esperar, sin race.
//
// Memoria pieza-95 (signals-agent infra): si NO usaramos SKIP LOCKED y
// solo confiaramos en UPDATE ... RETURNING, dos replicas marcarian el
// MISMO job como "sent" simultaneamente → doble envio al destinatario.
// Con SKIP LOCKED el job esta fisicamente bloqueado (row lock) hasta el
// COMMIT del worker — la otra replica lo salta y se va a por el siguiente.
//
// El caller envuelve dbDueJobs en una transaccion y hace BEGIN antes y
// COMMIT/ROLLBACK al final (el lock se libera al cerrar). Aqui exponemos
// dbDueJobs(client) opcional para que el worker pueda pasar el cliente
// transaccional — si no se pasa, abrimos uno desde pool en modo "best
// effort lock" (autocommit suelta el lock inmediatamente; valido solo
// para una sola replica o como "lectura agresiva").
// ============================================================

function rowToBroadcastFlow(r: any): BroadcastFlow {
  let data: BcFlowData;
  try {
    const raw = r.data;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      data = raw as BcFlowData;
    } else if (typeof raw === "string" && raw.length) {
      data = JSON.parse(raw);
    } else {
      data = { nodes: [], edges: [], startId: "" };
    }
    // Defensa contra rows legacy/corruptas: asegura shape minimo.
    if (!Array.isArray(data.nodes)) data.nodes = [];
    if (!Array.isArray(data.edges)) data.edges = [];
    if (typeof data.startId !== "string") data.startId = "";
  } catch {
    data = { nodes: [], edges: [], startId: "" };
  }
  let last_sim_result: Record<string, unknown> | null = null;
  try {
    const raw = r.last_sim_result;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      last_sim_result = raw as Record<string, unknown>;
    } else if (typeof raw === "string" && raw.length) {
      last_sim_result = JSON.parse(raw);
    }
  } catch {
    last_sim_result = null;
  }
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id || "default"),
    name: String(r.name || ""),
    data,
    enabled: Boolean(r.enabled),
    last_sim_at:
      r.last_sim_at_ms != null
        ? Number(r.last_sim_at_ms)
        : r.last_sim_at != null
          ? Number(r.last_sim_at)
          : null,
    last_sim_result,
    created_by: String(r.created_by || ""),
    created_at: Number(r.created_at_ms ?? r.created_at ?? 0),
    updated_at: Number(r.updated_at_ms ?? r.updated_at ?? 0),
  };
}

function rowToBroadcastRun(r: any): BroadcastRun {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id || "default"),
    flow_id: String(r.flow_id),
    status: String(r.status) as BroadcastRunStatus,
    scheduled_for:
      r.scheduled_for_ms != null
        ? Number(r.scheduled_for_ms)
        : r.scheduled_for != null
          ? Number(r.scheduled_for)
          : null,
    started_at:
      r.started_at_ms != null
        ? Number(r.started_at_ms)
        : r.started_at != null
          ? Number(r.started_at)
          : null,
    ended_at:
      r.ended_at_ms != null
        ? Number(r.ended_at_ms)
        : r.ended_at != null
          ? Number(r.ended_at)
          : null,
    audience_total: Number(r.audience_total) || 0,
    jobs_sent: Number(r.jobs_sent) || 0,
    jobs_failed: Number(r.jobs_failed) || 0,
    jobs_replied: Number(r.jobs_replied) || 0,
    created_at: Number(r.created_at_ms ?? r.created_at ?? 0),
  };
}

function rowToBroadcastJob(r: any): BroadcastJob {
  let payload: Record<string, unknown> = {};
  try {
    const raw = r.payload;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      payload = raw as Record<string, unknown>;
    } else if (typeof raw === "string" && raw.length) {
      payload = JSON.parse(raw);
    }
  } catch {
    payload = {};
  }
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id || "default"),
    run_id: String(r.run_id),
    flow_id: String(r.flow_id),
    recipient: String(r.recipient || ""),
    channel: String(r.channel) as BcChannel,
    payload,
    status: String(r.status) as BroadcastJobStatus,
    attempts: Number(r.attempts) || 0,
    next_run:
      r.next_run_ms != null
        ? Number(r.next_run_ms)
        : r.next_run != null
          ? Number(r.next_run)
          : null,
    sent_at:
      r.sent_at_ms != null
        ? Number(r.sent_at_ms)
        : r.sent_at != null
          ? Number(r.sent_at)
          : null,
    replied_at:
      r.replied_at_ms != null
        ? Number(r.replied_at_ms)
        : r.replied_at != null
          ? Number(r.replied_at)
          : null,
    message_id: r.message_id ?? null,
    last_error: r.last_error ?? null,
    cost_cents: r.cost_cents != null ? Number(r.cost_cents) : null,
    created_at: Number(r.created_at_ms ?? r.created_at ?? 0),
  };
}

// ----------------------------------------------------------------
// FLOWS — definicion del grafo (CRUD).
// ----------------------------------------------------------------

/**
 * Lista flows del WS. Opcionalmente filtra por enabled. Order by updated_at
 * DESC. Cap limit a 500.
 */
export async function dbListBroadcastFlows(input: {
  tenantId: string;
  enabled?: boolean;
  limit?: number;
}): Promise<BroadcastFlow[]> {
  const tenantId = (input.tenantId || "default").trim() || "default";
  const limitRaw = Number(input.limit ?? 100);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 100));
  if (!pool) {
    let rows = mem.broadcastFlows.filter((r) => r.tenant_id === tenantId);
    if (input.enabled !== undefined) rows = rows.filter((r) => r.enabled === input.enabled);
    rows.sort((a, b) => b.updated_at - a.updated_at);
    return rows.slice(0, limit);
  }
  const where: string[] = ["tenant_id=$1"];
  const params: any[] = [tenantId];
  if (input.enabled !== undefined) {
    params.push(input.enabled);
    where.push(`enabled=$${params.length}`);
  }
  params.push(limit);
  const limitIdx = params.length;
  const r = await pool.query(
    `SELECT id, tenant_id, name, data, enabled,
            extract(epoch from last_sim_at)*1000 AS last_sim_at_ms,
            last_sim_result, created_by,
            extract(epoch from created_at)*1000 AS created_at_ms,
            extract(epoch from updated_at)*1000 AS updated_at_ms
       FROM app_broadcasts_flows
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${limitIdx}`,
    params,
  );
  return r.rows.map(rowToBroadcastFlow);
}

/**
 * Devuelve el flow con id en el WS dado, o null. Ownership sentinel:
 * si esta funcion devuelve null el caller responde 404 sin revelar si
 * el flow existe en otro tenant.
 */
export async function dbGetBroadcastFlow(
  id: string,
  tenantId: string,
): Promise<BroadcastFlow | null> {
  const flowId = String(id || "").trim();
  const ws = (tenantId || "default").trim() || "default";
  if (!flowId) return null;
  if (!pool) {
    return (
      mem.broadcastFlows.find((r) => r.id === flowId && r.tenant_id === ws) || null
    );
  }
  const r = await pool.query(
    `SELECT id, tenant_id, name, data, enabled,
            extract(epoch from last_sim_at)*1000 AS last_sim_at_ms,
            last_sim_result, created_by,
            extract(epoch from created_at)*1000 AS created_at_ms,
            extract(epoch from updated_at)*1000 AS updated_at_ms
       FROM app_broadcasts_flows
      WHERE id=$1 AND tenant_id=$2
      LIMIT 1`,
    [flowId, ws],
  );
  if (!r.rows.length) return null;
  return rowToBroadcastFlow(r.rows[0]);
}

/**
 * Upsert: si llega id existente EN EL MISMO TENANT → UPDATE; si no, INSERT
 * con id nuevo. El WHERE tenant_id del UPDATE bloquea overwriting cross-WS
 * (un id ajeno con tenant ajeno: el UPDATE no actualiza nada → caemos al
 * INSERT con nuevo UUID, no a sobreescribir la row ajena).
 *
 * Diseno: dos queries (SELECT-then-INSERT-or-UPDATE) por simplicidad. La
 * carga es CRUD humano (no hot-path), no merece un INSERT ... ON CONFLICT
 * sobre PK compuesto que no tenemos.
 */
export async function dbUpsertBroadcastFlow(input: {
  id?: string;
  tenant_id: string;
  name: string;
  data: BcFlowData;
  enabled?: boolean;
  created_by?: string;
}): Promise<BroadcastFlow> {
  const tenant_id = (input.tenant_id || "default").trim() || "default";
  const name = String(input.name || "").slice(0, 200);
  const data: BcFlowData = {
    nodes: Array.isArray(input.data?.nodes) ? input.data.nodes : [],
    edges: Array.isArray(input.data?.edges) ? input.data.edges : [],
    startId: typeof input.data?.startId === "string" ? input.data.startId : "",
  };
  const enabled = input.enabled === true;
  const created_by = String(input.created_by || "");
  const now = Date.now();

  // Si llega id, intentamos UPDATE en el WS correcto. Si afecta 1 row →
  // devolvemos esa. Si no afecta → caemos al INSERT como creacion nueva.
  const existing = input.id
    ? await dbGetBroadcastFlow(input.id, tenant_id)
    : null;

  if (existing) {
    if (!pool) {
      existing.name = name;
      existing.data = data;
      existing.enabled = enabled;
      if (input.created_by !== undefined) existing.created_by = created_by;
      existing.updated_at = now;
      return existing;
    }
    await pool.query(
      `UPDATE app_broadcasts_flows
          SET name=$3, data=$4::jsonb, enabled=$5,
              updated_at=to_timestamp($6/1000.0)
        WHERE id=$1 AND tenant_id=$2`,
      [existing.id, tenant_id, name, JSON.stringify(data), enabled, now],
    );
    const refreshed = await dbGetBroadcastFlow(existing.id, tenant_id);
    return refreshed || { ...existing, name, data, enabled, updated_at: now };
  }

  // INSERT path.
  const id = genUuid();
  const row: BroadcastFlow = {
    id,
    tenant_id,
    name,
    data,
    enabled,
    last_sim_at: null,
    last_sim_result: null,
    created_by,
    created_at: now,
    updated_at: now,
  };
  if (!pool) {
    mem.broadcastFlows.unshift(row);
    if (mem.broadcastFlows.length > 500) mem.broadcastFlows.length = 500;
    return row;
  }
  await pool.query(
    `INSERT INTO app_broadcasts_flows
       (id, tenant_id, name, data, enabled, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,
             to_timestamp($7/1000.0), to_timestamp($7/1000.0))`,
    [id, tenant_id, name, JSON.stringify(data), enabled, created_by, now],
  );
  return row;
}

/**
 * Borra un flow del WS. CASCADE borra sus runs (y, en cascada, los jobs
 * de esos runs) via FK ON DELETE CASCADE. El WHERE tenant_id evita
 * borrados cross-WS.
 */
export async function dbDeleteBroadcastFlow(
  id: string,
  tenantId: string,
): Promise<void> {
  const flowId = String(id || "").trim();
  const ws = (tenantId || "default").trim() || "default";
  if (!flowId) return;
  if (!pool) {
    mem.broadcastFlows = mem.broadcastFlows.filter(
      (r) => !(r.id === flowId && r.tenant_id === ws),
    );
    // Cascada manual en mem mode: limpiamos runs + jobs del flow.
    const runIds = new Set(
      mem.broadcastRuns
        .filter((r) => r.flow_id === flowId && r.tenant_id === ws)
        .map((r) => r.id),
    );
    mem.broadcastRuns = mem.broadcastRuns.filter(
      (r) => !(r.flow_id === flowId && r.tenant_id === ws),
    );
    mem.broadcastJobs = mem.broadcastJobs.filter((j) => !runIds.has(j.run_id));
    return;
  }
  await pool.query(
    `DELETE FROM app_broadcasts_flows WHERE id=$1 AND tenant_id=$2`,
    [flowId, ws],
  );
}

/**
 * Actualiza last_sim_at + last_sim_result tras un simulate. El WHERE
 * tenant_id es el cinturon cruzado (ownership-safe).
 */
export async function dbUpdateBroadcastFlowSim(
  id: string,
  tenantId: string,
  simResult: Record<string, unknown>,
): Promise<void> {
  const flowId = String(id || "").trim();
  const ws = (tenantId || "default").trim() || "default";
  if (!flowId) return;
  const now = Date.now();
  const result = simResult && typeof simResult === "object" ? simResult : {};
  if (!pool) {
    const row = mem.broadcastFlows.find(
      (r) => r.id === flowId && r.tenant_id === ws,
    );
    if (!row) return;
    row.last_sim_at = now;
    row.last_sim_result = result;
    row.updated_at = now;
    return;
  }
  await pool.query(
    `UPDATE app_broadcasts_flows
        SET last_sim_at=to_timestamp($3/1000.0),
            last_sim_result=$4::jsonb,
            updated_at=to_timestamp($3/1000.0)
      WHERE id=$1 AND tenant_id=$2`,
    [flowId, ws, now, JSON.stringify(result)],
  );
}

// ----------------------------------------------------------------
// RUNS — ejecucion (1..N por flow).
// ----------------------------------------------------------------

/**
 * Crea un nuevo run para un flow. status='queued' por defecto.
 * scheduled_for null = run inmediato (el worker lo recoge en el proximo tick).
 * audience_total es informativo (el operador puede precomputarlo en simulate).
 */
export async function dbCreateBroadcastRun(input: {
  tenant_id: string;
  flow_id: string;
  scheduled_for?: number | null;
  audience_total?: number;
}): Promise<BroadcastRun> {
  const id = genUuid();
  const tenant_id = (input.tenant_id || "default").trim() || "default";
  const flow_id = String(input.flow_id || "").trim();
  const scheduled_for =
    input.scheduled_for != null && Number.isFinite(input.scheduled_for)
      ? Number(input.scheduled_for)
      : null;
  const audience_total = Math.max(0, Number(input.audience_total) || 0);
  const now = Date.now();
  const row: BroadcastRun = {
    id,
    tenant_id,
    flow_id,
    status: "queued",
    scheduled_for,
    started_at: null,
    ended_at: null,
    audience_total,
    jobs_sent: 0,
    jobs_failed: 0,
    jobs_replied: 0,
    created_at: now,
  };
  if (!pool) {
    mem.broadcastRuns.unshift(row);
    if (mem.broadcastRuns.length > 2000) mem.broadcastRuns.length = 2000;
    return row;
  }
  if (scheduled_for == null) {
    await pool.query(
      `INSERT INTO app_broadcasts_runs
         (id, tenant_id, flow_id, status, audience_total, created_at)
       VALUES ($1,$2,$3,'queued',$4, to_timestamp($5/1000.0))`,
      [id, tenant_id, flow_id, audience_total, now],
    );
  } else {
    await pool.query(
      `INSERT INTO app_broadcasts_runs
         (id, tenant_id, flow_id, status, scheduled_for, audience_total, created_at)
       VALUES ($1,$2,$3,'queued', to_timestamp($4/1000.0), $5, to_timestamp($6/1000.0))`,
      [id, tenant_id, flow_id, scheduled_for, audience_total, now],
    );
  }
  return row;
}

/** Ownership sentinel: row del run en el WS o null. */
export async function dbGetBroadcastRun(
  id: string,
  tenantId: string,
): Promise<BroadcastRun | null> {
  const runId = String(id || "").trim();
  const ws = (tenantId || "default").trim() || "default";
  if (!runId) return null;
  if (!pool) {
    return (
      mem.broadcastRuns.find((r) => r.id === runId && r.tenant_id === ws) || null
    );
  }
  const r = await pool.query(
    `SELECT id, tenant_id, flow_id, status,
            extract(epoch from scheduled_for)*1000 AS scheduled_for_ms,
            extract(epoch from started_at)*1000 AS started_at_ms,
            extract(epoch from ended_at)*1000 AS ended_at_ms,
            audience_total, jobs_sent, jobs_failed, jobs_replied,
            extract(epoch from created_at)*1000 AS created_at_ms
       FROM app_broadcasts_runs
      WHERE id=$1 AND tenant_id=$2
      LIMIT 1`,
    [runId, ws],
  );
  if (!r.rows.length) return null;
  return rowToBroadcastRun(r.rows[0]);
}

/**
 * Lista runs del WS. Filtros opcionales por flowId/status. Order by
 * created_at DESC. Cap limit a 500.
 */
export async function dbListBroadcastRuns(input: {
  tenantId: string;
  flowId?: string;
  status?: BroadcastRunStatus;
  limit?: number;
}): Promise<BroadcastRun[]> {
  const tenantId = (input.tenantId || "default").trim() || "default";
  const limitRaw = Number(input.limit ?? 100);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 100));
  if (!pool) {
    let rows = mem.broadcastRuns.filter((r) => r.tenant_id === tenantId);
    if (input.flowId) rows = rows.filter((r) => r.flow_id === input.flowId);
    if (input.status) rows = rows.filter((r) => r.status === input.status);
    rows.sort((a, b) => b.created_at - a.created_at);
    return rows.slice(0, limit);
  }
  const where: string[] = ["tenant_id=$1"];
  const params: any[] = [tenantId];
  if (input.flowId) {
    params.push(input.flowId);
    where.push(`flow_id=$${params.length}`);
  }
  if (input.status) {
    params.push(input.status);
    where.push(`status=$${params.length}`);
  }
  params.push(limit);
  const limitIdx = params.length;
  const r = await pool.query(
    `SELECT id, tenant_id, flow_id, status,
            extract(epoch from scheduled_for)*1000 AS scheduled_for_ms,
            extract(epoch from started_at)*1000 AS started_at_ms,
            extract(epoch from ended_at)*1000 AS ended_at_ms,
            audience_total, jobs_sent, jobs_failed, jobs_replied,
            extract(epoch from created_at)*1000 AS created_at_ms
       FROM app_broadcasts_runs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${limitIdx}`,
    params,
  );
  return r.rows.map(rowToBroadcastRun);
}

/**
 * Actualiza estado de un run + contadores opcionales. WHERE tenant_id es
 * el cinturon cruzado (ownership-safe).
 *
 * El UPDATE es dinamico: solo toca columnas explicitamente pasadas en opts
 * para que un worker pueda subir solo jobs_sent sin pisar started_at.
 */
export async function dbUpdateBroadcastRunStatus(
  id: string,
  tenantId: string,
  status: BroadcastRunStatus,
  opts?: {
    started_at?: number;
    ended_at?: number;
    jobs_sent?: number;
    jobs_failed?: number;
    jobs_replied?: number;
  },
): Promise<void> {
  const runId = String(id || "").trim();
  const ws = (tenantId || "default").trim() || "default";
  if (!runId) return;
  if (!pool) {
    const row = mem.broadcastRuns.find(
      (r) => r.id === runId && r.tenant_id === ws,
    );
    if (!row) return;
    // REVISION-CANCELACION-1 · La cancelación gana a cualquier worker que
    // leyera antes. No puede reabrirla ni sobrescribir su fecha de cierre.
    if (row.status === "cancelled" && status !== "cancelled") return;
    row.status = status;
    if (opts?.started_at !== undefined) row.started_at = opts.started_at;
    if (opts?.ended_at !== undefined) row.ended_at = opts.ended_at;
    if (opts?.jobs_sent !== undefined) row.jobs_sent = Number(opts.jobs_sent) || 0;
    if (opts?.jobs_failed !== undefined) row.jobs_failed = Number(opts.jobs_failed) || 0;
    if (opts?.jobs_replied !== undefined) row.jobs_replied = Number(opts.jobs_replied) || 0;
    return;
  }
  const sets: string[] = [`status=$3`];
  const params: any[] = [runId, ws, status];
  if (opts?.started_at !== undefined) {
    params.push(opts.started_at);
    sets.push(`started_at=to_timestamp($${params.length}/1000.0)`);
  }
  if (opts?.ended_at !== undefined) {
    params.push(opts.ended_at);
    sets.push(`ended_at=to_timestamp($${params.length}/1000.0)`);
  }
  if (opts?.jobs_sent !== undefined) {
    params.push(Number(opts.jobs_sent) || 0);
    sets.push(`jobs_sent=$${params.length}`);
  }
  if (opts?.jobs_failed !== undefined) {
    params.push(Number(opts.jobs_failed) || 0);
    sets.push(`jobs_failed=$${params.length}`);
  }
  if (opts?.jobs_replied !== undefined) {
    params.push(Number(opts.jobs_replied) || 0);
    sets.push(`jobs_replied=$${params.length}`);
  }
  await pool.query(
    `UPDATE app_broadcasts_runs SET ${sets.join(", ")}
       WHERE id=$1 AND tenant_id=$2 AND (status<>'cancelled' OR $3='cancelled')`,
    params,
  );
}

/**
 * Cancela un run + sus jobs aun en cola. El run se marca 'cancelled'; los
 * jobs queued del run pasan a 'cancelled' (no tocamos los ya 'sent' /
 * 'failed' — esos son historico inmutable).
 *
 * Two-step: 1) UPDATE jobs WHERE run_id AND status='queued', 2) UPDATE run.
 * Ambos llevan WHERE tenant_id como cinturon cruzado.
 */
export async function dbCancelBroadcastRun(
  id: string,
  tenantId: string,
): Promise<void> {
  const runId = String(id || "").trim();
  const ws = (tenantId || "default").trim() || "default";
  if (!runId) return;
  const now = Date.now();
  if (!pool) {
    for (const j of mem.broadcastJobs) {
      if (j.run_id === runId && j.tenant_id === ws && j.status === "queued") {
        j.status = "cancelled";
      }
    }
    const row = mem.broadcastRuns.find(
      (r) => r.id === runId && r.tenant_id === ws,
    );
    if (row) {
      row.status = "cancelled";
      row.ended_at = now;
    }
    return;
  }
  await pool.query(
    `UPDATE app_broadcasts_jobs
        SET status='cancelled'
      WHERE run_id=$1 AND tenant_id=$2 AND status='queued'`,
    [runId, ws],
  );
  await pool.query(
    `UPDATE app_broadcasts_runs
        SET status='cancelled', ended_at=to_timestamp($3/1000.0)
      WHERE id=$1 AND tenant_id=$2`,
    [runId, ws, now],
  );
}

// ----------------------------------------------------------------
// JOBS — cola por destinatario × canal (multi-replica safe).
// ----------------------------------------------------------------

/**
 * Input para insertar un job nuevo. El caller (worker que materializa el
 * flow) lo construye con payload ya resuelto (vars expandidas, recipient
 * normalizado).
 */
export interface BroadcastJobInput {
  tenant_id: string;
  run_id: string;
  flow_id: string;
  recipient: string;
  channel: BcChannel;
  payload?: Record<string, unknown>;
  next_run?: number | null;
  /** Qué paso del flujo es este envío. 'main' = el mensaje; el seguimiento usa
   *  el id de su nodo. Forma parte de la identidad del job: sin esto, el
   *  seguimiento colisionaba con el mensaje original y no se encolaba nunca. */
  step_key?: string;
}

/**
 * Batch insert con dedup. La tabla tiene UNIQUE PARCIAL
 *   (run_id, recipient, channel, step_key) WHERE status IN ('queued','sent')
 *
 * Por eso ON CONFLICT DO NOTHING — si ya hay un job vivo para el mismo
 * (run, recipient, channel), el INSERT lo salta sin error. Si el job
 * anterior estaba 'failed'/'cancelled'/'skipped', el indice parcial no
 * lo cuenta como conflicto → el nuevo INSERT cuela (= reintento).
 *
 * Devuelve la cuenta de filas REALMENTE insertadas (no incluye los dedup
 * skippeados) para que el caller sepa cuantos jobs nuevos hay en cola.
 */
export async function dbEnqueueJobs(jobs: BroadcastJobInput[]): Promise<number> {
  if (!Array.isArray(jobs) || !jobs.length) return 0;
  const now = Date.now();
  // Normalizamos primero (tenant_id default, payload default, etc.).
  const norm = jobs
    .map((j) => {
      const tenant_id = (j.tenant_id || "default").trim() || "default";
      const run_id = String(j.run_id || "").trim();
      const flow_id = String(j.flow_id || "").trim();
      const recipient = String(j.recipient || "").trim();
      const channel = j.channel;
      if (!run_id || !flow_id || !recipient || !channel) return null;
      return {
        id: genUuid(),
        tenant_id,
        run_id,
        flow_id,
        recipient,
        channel,
        payload: j.payload && typeof j.payload === "object" ? j.payload : {},
        step_key: String(j.step_key || "main"),
        next_run:
          j.next_run != null && Number.isFinite(j.next_run) ? Number(j.next_run) : now,
        created_at: now,
      };
    })
    .filter(Boolean) as Array<{
      id: string;
      tenant_id: string;
      run_id: string;
      flow_id: string;
      recipient: string;
      channel: BcChannel;
      payload: Record<string, unknown>;
      step_key: string;
      next_run: number;
      created_at: number;
    }>;

  if (!norm.length) return 0;

  if (!pool) {
    // Mem dedup: misma logica que el indice parcial — (run_id, recipient,
    // channel) vivo (queued/sent) bloquea nuevos.
    let inserted = 0;
    for (const n of norm) {
      const live = mem.broadcastJobs.some(
        (j) =>
          j.run_id === n.run_id &&
          j.recipient === n.recipient &&
          j.channel === n.channel &&
          (j.step_key || "main") === n.step_key &&
          (j.status === "queued" || j.status === "sent"),
      );
      if (live) continue;
      const row: BroadcastJob = {
        id: n.id,
        tenant_id: n.tenant_id,
        run_id: n.run_id,
        flow_id: n.flow_id,
        recipient: n.recipient,
        channel: n.channel,
        payload: n.payload,
        step_key: n.step_key,
        status: "queued",
        attempts: 0,
        next_run: n.next_run,
        sent_at: null,
        replied_at: null,
        message_id: null,
        last_error: null,
        cost_cents: null,
        created_at: n.created_at,
      };
      mem.broadcastJobs.unshift(row);
      inserted++;
    }
    if (mem.broadcastJobs.length > 50000) mem.broadcastJobs.length = 50000;
    return inserted;
  }

  // Postgres batch INSERT con UNNEST: una sola query para N filas.
  // ON CONFLICT DO NOTHING aprovecha el UNIQUE PARCIAL idx_bcjobs_dedup.
  const ids = norm.map((n) => n.id);
  const tenants = norm.map((n) => n.tenant_id);
  const runIds = norm.map((n) => n.run_id);
  const flowIds = norm.map((n) => n.flow_id);
  const recipients = norm.map((n) => n.recipient);
  const channels = norm.map((n) => n.channel);
  const payloads = norm.map((n) => JSON.stringify(n.payload));
  const stepKeys = norm.map((n) => n.step_key);
  const nextRuns = norm.map((n) => n.next_run);
  const createdAts = norm.map((n) => n.created_at);

  const r = await pool.query(
    `INSERT INTO app_broadcasts_jobs
       (id, tenant_id, run_id, flow_id, recipient, channel, payload, step_key, status,
        next_run, created_at)
     SELECT u.id, u.tenant_id, u.run_id, u.flow_id, u.recipient, u.channel,
            u.payload::jsonb, u.step_key, 'queued',
            to_timestamp(u.next_run/1000.0),
            to_timestamp(u.created_at/1000.0)
       FROM unnest(
              $1::uuid[], $2::text[], $3::uuid[], $4::uuid[],
              $5::text[], $6::text[], $7::text[], $8::text[],
              $9::bigint[], $10::bigint[]
            ) AS u(id, tenant_id, run_id, flow_id, recipient, channel,
                   payload, step_key, next_run, created_at)
     ON CONFLICT DO NOTHING`,
    [ids, tenants, runIds, flowIds, recipients, channels, payloads, stepKeys, nextRuns, createdAts],
  );
  return r.rowCount ?? 0;
}

/**
 * PIEDRA ANGULAR: jobs listos para enviar. Multi-replica safe via
 * SELECT ... FOR UPDATE SKIP LOCKED.
 *
 * Como funciona:
 *   - SELECT con WHERE status='queued' AND next_run<=now() ORDER BY next_run.
 *   - FOR UPDATE bloquea fisicamente las filas devueltas (row lock) hasta
 *     el COMMIT/ROLLBACK de la transaccion.
 *   - SKIP LOCKED hace que SI OTRA transaccion ya tiene esas filas
 *     bloqueadas, las SALTAMOS — no esperamos, no fallamos. Vamos a por
 *     las siguientes.
 *
 * Resultado: dos replicas Railway corriendo el mismo tick toman jobs
 * DISJUNTOS sin coordinacion ni race. Memoria pieza-95 (signals-agent):
 * sin SKIP LOCKED, ambas replicas podrian marcar el mismo job como 'sent'
 * → doble envio al destinatario.
 *
 * IMPORTANTE: el caller DEBE envolver esta llamada en una transaccion y
 * mantener el lock hasta marcar el job (sent/failed/cancelled). Si pasa
 * un cliente transaccional via `client`, lo usamos; si no, usamos el pool
 * (autocommit → el lock se suelta al regresar; valido solo para
 * single-replica o "lectura agresiva"; el comentario lo deja claro).
 *
 * Filtros: channelFilter opcional para que un worker especializado (p.ej.
 * un worker-WA) solo coja jobs WA.
 */
export async function dbDueJobs(opts: {
  limit: number;
  channelFilter?: BcChannel | BcChannel[];
  client?: pg.PoolClient | pg.Client;
}): Promise<BroadcastJob[]> {
  const limitRaw = Number(opts.limit);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 50));
  const now = Date.now();

  // Fallback en memoria: no hay locks reales — devolvemos directamente.
  if (!pool) {
    let rows = mem.broadcastJobs.filter(
      (j) => j.status === "queued" && (j.next_run ?? 0) <= now && !memTenantArchived(j.tenant_id),
    );
    if (opts.channelFilter) {
      const filter = Array.isArray(opts.channelFilter)
        ? new Set(opts.channelFilter)
        : new Set([opts.channelFilter]);
      rows = rows.filter((j) => filter.has(j.channel));
    }
    rows.sort((a, b) => (a.next_run ?? 0) - (b.next_run ?? 0));
    return rows.slice(0, limit);
  }

  // WS-ARCHIVED: los jobs de un workspace archivado NO se reclaman (siguen
  // 'queued' y reviven si se desarchiva) — archivar detiene los envíos.
  const where: string[] = [
    "status='queued'",
    "next_run<=now()",
    wsNotArchivedSql("app_broadcasts_jobs.tenant_id"),
  ];
  const params: any[] = [];
  if (opts.channelFilter) {
    const list = Array.isArray(opts.channelFilter)
      ? opts.channelFilter
      : [opts.channelFilter];
    params.push(list);
    where.push(`channel = ANY($${params.length}::text[])`);
  }
  params.push(limit);
  const limitIdx = params.length;

  // EL QUERY CRITICO: FOR UPDATE SKIP LOCKED garantiza que otra replica
  // saltara estos rows en su propio tick simultaneo.
  const sql =
    `SELECT id, tenant_id, run_id, flow_id, recipient, channel, payload,
            status, attempts,
            extract(epoch from next_run)*1000 AS next_run_ms,
            extract(epoch from sent_at)*1000 AS sent_at_ms,
            extract(epoch from replied_at)*1000 AS replied_at_ms,
            message_id, last_error, cost_cents,
            extract(epoch from created_at)*1000 AS created_at_ms
       FROM app_broadcasts_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY next_run
      LIMIT $${limitIdx}
      FOR UPDATE SKIP LOCKED`;

  const runner = opts.client ?? pool;
  const r = await runner.query(sql, params);
  return r.rows.map(rowToBroadcastJob);
}

/**
 * Marca un job como enviado: status='sent', sent_at=now,
 * attempts+=1, message_id (wamid/mid Meta), cost_cents opcional.
 *
 * WHERE tenant_id evita transiciones cross-WS. No usa FOR UPDATE
 * porque el caller idealmente ya lo tiene bloqueado via dbDueJobs en
 * la misma transaccion.
 */
export async function dbMarkJobSent(
  id: string,
  tenantId: string,
  message_id?: string | null,
  cost_cents?: number | null,
  client?: pg.PoolClient | pg.Client,
): Promise<void> {
  const jobId = String(id || "").trim();
  const ws = (tenantId || "default").trim() || "default";
  if (!jobId) return;
  const now = Date.now();
  if (!pool) {
    const row = mem.broadcastJobs.find(
      (j) => j.id === jobId && j.tenant_id === ws,
    );
    if (!row) return;
    row.status = "sent";
    row.sent_at = now;
    row.attempts = (row.attempts || 0) + 1;
    if (message_id !== undefined) row.message_id = message_id;
    if (cost_cents !== undefined) row.cost_cents = cost_cents;
    row.last_error = null;
    return;
  }
  // REG-1: si llega `client`, ejecuta en la MISMA transacción que dbDueJobs
  // — mantiene el lock SKIP LOCKED hasta el COMMIT, garantizando que
  // ninguna réplica re-procese el job entre el SELECT y el UPDATE.
  const runner = client ?? pool;
  await runner.query(
    `UPDATE app_broadcasts_jobs
        SET status='sent',
            sent_at=to_timestamp($3/1000.0),
            attempts=attempts+1,
            message_id=COALESCE($4, message_id),
            cost_cents=COALESCE($5, cost_cents),
            last_error=NULL
      WHERE id=$1 AND tenant_id=$2`,
    [jobId, ws, now, message_id ?? null, cost_cents ?? null],
  );
}

/**
 * Marca un job como fallido. Si retryDelayMs > 0, el job vuelve a 'queued'
 * con next_run=now+delay (backoff) y attempts+=1 — el scheduler lo
 * reintentara. Si retryDelayMs no se pasa o <=0, queda 'failed' definitivo.
 *
 * En ambos casos last_error guarda el motivo (truncado para no inflar).
 */
export async function dbMarkJobFailed(
  id: string,
  tenantId: string,
  lastError: string,
  retryDelayMs?: number,
  client?: pg.PoolClient | pg.Client,
): Promise<void> {
  const jobId = String(id || "").trim();
  const ws = (tenantId || "default").trim() || "default";
  if (!jobId) return;
  const err = String(lastError || "").slice(0, 500);
  const retry = Number(retryDelayMs);
  const willRetry = Number.isFinite(retry) && retry > 0;
  const now = Date.now();
  if (!pool) {
    const row = mem.broadcastJobs.find(
      (j) => j.id === jobId && j.tenant_id === ws,
    );
    if (!row) return;
    row.attempts = (row.attempts || 0) + 1;
    row.last_error = err;
    if (willRetry) {
      row.status = "queued";
      row.next_run = now + retry;
    } else {
      row.status = "failed";
    }
    return;
  }
  // REG-1: misma lógica que dbMarkJobSent — si llega `client`, ejecuta
  // en la transacción abierta por tickBroadcastJobs y conserva el lock
  // del SELECT FOR UPDATE hasta el COMMIT.
  const runner = client ?? pool;
  if (willRetry) {
    await runner.query(
      `UPDATE app_broadcasts_jobs
          SET status='queued',
              attempts=attempts+1,
              last_error=$3,
              next_run=to_timestamp($4/1000.0)
        WHERE id=$1 AND tenant_id=$2`,
      [jobId, ws, err, now + retry],
    );
  } else {
    await runner.query(
      `UPDATE app_broadcasts_jobs
          SET status='failed',
              attempts=attempts+1,
              last_error=$3
        WHERE id=$1 AND tenant_id=$2`,
      [jobId, ws, err],
    );
  }
}

/**
 * REG-3: reagenda un job (status sigue 'queued' o vuelve a 'queued') sin
 * tocar attempts ni last_error. Lo usa el throttler per-phoneNumberId
 * (token bucket lleno) para retrasar +N ms sin consumir reintentos. Si
 * llega `client`, vive en la tx del batch para mantener el lock SKIP
 * LOCKED hasta el COMMIT.
 */
export async function dbRequeueJobNoAttempt(
  id: string,
  tenantId: string,
  delayMs: number,
  client?: pg.PoolClient | pg.Client,
): Promise<void> {
  const jobId = String(id || "").trim();
  const ws = (tenantId || "default").trim() || "default";
  if (!jobId) return;
  const delay = Math.max(0, Number(delayMs) || 0);
  const now = Date.now();
  if (!pool) {
    const row = mem.broadcastJobs.find(
      (j) => j.id === jobId && j.tenant_id === ws,
    );
    if (!row) return;
    row.status = "queued";
    row.next_run = now + delay;
    return;
  }
  const runner = client ?? pool;
  await runner.query(
    `UPDATE app_broadcasts_jobs
        SET status='queued',
            next_run=to_timestamp($3/1000.0)
      WHERE id=$1 AND tenant_id=$2`,
    [jobId, ws, now + delay],
  );
}

/**
 * Marca un job como contestado por el destinatario (webhook WA/IG inbound).
 * No cambia status (sigue 'sent') — solo registra replied_at. El run
 * agregado (jobs_replied) lo computa el caller / dbCountJobsByStatus.
 *
 * WHERE tenant_id = cinturon cruzado.
 */
/**
 * FOLLOWUP-2 · Deja constancia en el job ORIGINAL de que su seguimiento ya se
 * evaluó. El flag `payload.followup_fired` se LEÍA (tickFollowups) pero no lo
 * escribía nadie en todo el repositorio: cada tick de 60 s volvía a recorrer los
 * mismos jobs 'sent', volvía a darlos por vencidos y volvía a intentar encolar
 * el mismo seguimiento. Para siempre. Con el índice de deduplicación arreglado
 * (FOLLOWUP-1) eso habría pasado de no enviar nada a enviar de más, así que este
 * arreglo va OBLIGATORIAMENTE con el otro.
 */
export async function dbMarkFollowupFired(jobId: string, tenantId: string): Promise<void> {
  if (!jobId) return;
  if (!pool) {
    const j = mem.broadcastJobs.find((x) => x.id === jobId && x.tenant_id === tenantId);
    if (j) j.payload = { ...(j.payload || {}), followup_fired: true };
    return;
  }
  await pool.query(
    `UPDATE app_broadcasts_jobs
        SET payload = jsonb_set(COALESCE(payload,'{}'::jsonb),'{followup_fired}','true'::jsonb, true)
      WHERE id=$1 AND tenant_id=$2`,
    [jobId, tenantId],
  );
}

export async function dbMarkJobReplied(
  id: string,
  tenantId: string,
): Promise<void> {
  const jobId = String(id || "").trim();
  const ws = (tenantId || "default").trim() || "default";
  if (!jobId) return;
  const now = Date.now();
  if (!pool) {
    const row = mem.broadcastJobs.find(
      (j) => j.id === jobId && j.tenant_id === ws,
    );
    if (!row) return;
    if (row.replied_at == null) row.replied_at = now;
    return;
  }
  await pool.query(
    `UPDATE app_broadcasts_jobs
        SET replied_at=COALESCE(replied_at, to_timestamp($3/1000.0))
      WHERE id=$1 AND tenant_id=$2`,
    [jobId, ws, now],
  );
}

/**
 * Cuenta jobs por status para un run dado, en el WS dado. Util para que el
 * scheduler decida cuando marcar el run como 'completed' (queued=0) o para
 * pintar progreso en la UI sin traerse 10k filas.
 *
 * Devuelve TODAS las status keys aunque sea 0 (UI predecible).
 */
export async function dbCountJobsByStatus(
  runId: string,
  tenantId: string,
): Promise<{
  queued: number;
  sent: number;
  failed: number;
  cancelled: number;
  skipped: number;
  replied: number;
}> {
  const rid = String(runId || "").trim();
  const ws = (tenantId || "default").trim() || "default";
  const out = {
    queued: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    replied: 0,
  };
  if (!rid) return out;
  if (!pool) {
    for (const j of mem.broadcastJobs) {
      if (j.run_id !== rid || j.tenant_id !== ws) continue;
      if (j.status in out) (out as any)[j.status]++;
      if (j.replied_at != null) out.replied++;
    }
    return out;
  }
  const r = await pool.query(
    `SELECT status, COUNT(*)::int AS c,
            COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied_c
       FROM app_broadcasts_jobs
      WHERE run_id=$1 AND tenant_id=$2
      GROUP BY status`,
    [rid, ws],
  );
  let replied = 0;
  for (const row of r.rows) {
    const s = String(row.status);
    if (s in out) (out as any)[s] = Number(row.c) || 0;
    replied += Number(row.replied_c) || 0;
  }
  out.replied = replied;
  return out;
}

/**
 * Lista jobs del WS con filtros opcionales (runId/status/channel). Order
 * by created_at DESC, id DESC. Cap limit a 500. Pagina con offset.
 */
export async function dbListBroadcastJobs(input: {
  tenantId: string;
  runId?: string;
  status?: BroadcastJobStatus;
  channel?: BcChannel;
  limit?: number;
  offset?: number;
}): Promise<BroadcastJob[]> {
  const tenantId = (input.tenantId || "default").trim() || "default";
  const limitRaw = Number(input.limit ?? 100);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 100));
  const offset = Math.max(0, Number(input.offset ?? 0) || 0);
  if (!pool) {
    let rows = mem.broadcastJobs.filter((j) => j.tenant_id === tenantId);
    if (input.runId) rows = rows.filter((j) => j.run_id === input.runId);
    if (input.status) rows = rows.filter((j) => j.status === input.status);
    if (input.channel) rows = rows.filter((j) => j.channel === input.channel);
    // DIFUSION-PAGINAS-1 · Un lote comparte created_at: el UUID desempata para
    // que sus trabajos no salten ni se repitan entre páginas de 500.
    rows.sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
    return rows.slice(offset, offset + limit);
  }
  const where: string[] = ["tenant_id=$1"];
  const params: any[] = [tenantId];
  if (input.runId) {
    params.push(input.runId);
    where.push(`run_id=$${params.length}`);
  }
  if (input.status) {
    params.push(input.status);
    where.push(`status=$${params.length}`);
  }
  if (input.channel) {
    params.push(input.channel);
    where.push(`channel=$${params.length}`);
  }
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  const r = await pool.query(
    `SELECT id, tenant_id, run_id, flow_id, recipient, channel, payload,
            status, attempts,
            extract(epoch from next_run)*1000 AS next_run_ms,
            extract(epoch from sent_at)*1000 AS sent_at_ms,
            extract(epoch from replied_at)*1000 AS replied_at_ms,
            message_id, last_error, cost_cents,
            extract(epoch from created_at)*1000 AS created_at_ms
       FROM app_broadcasts_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return r.rows.map(rowToBroadcastJob);
}

/**
 * REG-2: lookup quirúrgico de jobs 'sent' no contestados todavía para
 * un recipient/channel concreto del WS, dentro de una ventana temporal.
 * Es el camino caliente del webhook (cada inbound dispara una llamada),
 * así que va por SQL exacto en lugar de listar 500 y filtrar en memoria.
 *
 * Usa el índice parcial `idx_bcjobs_unreplied` (creado abajo) para que
 * el plan sea Index Scan O(log N) — escalable a millones de jobs.
 */
export async function dbFindUnrepliedJobsByRecipient(input: {
  tenantId: string;
  recipient: string;
  channel: BcChannel;
  /** Días hacia atrás. Default 7 (TTL del reply hook en broadcast-flows.ts). */
  sinceDays?: number;
  /** Hard cap de filas devueltas (defensivo; típicamente <10). */
  limit?: number;
}): Promise<BroadcastJob[]> {
  const tenantId = (input.tenantId || "default").trim() || "default";
  const recipient = String(input.recipient || "").trim();
  if (!recipient) return [];
  const sinceDays = Math.max(1, Math.min(90, Number(input.sinceDays ?? 7) || 7));
  const limitRaw = Number(input.limit ?? 50);
  const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  if (!pool) {
    return mem.broadcastJobs
      .filter(
        (j) =>
          (j.tenant_id || "default") === tenantId &&
          j.recipient === recipient &&
          j.channel === input.channel &&
          j.status === "sent" &&
          j.replied_at == null &&
          (j.sent_at || 0) > cutoff,
      )
      .slice(0, limit);
  }

  const r = await pool.query(
    `SELECT id, tenant_id, run_id, flow_id, recipient, channel, payload,
            status, attempts,
            extract(epoch from next_run)*1000 AS next_run_ms,
            extract(epoch from sent_at)*1000 AS sent_at_ms,
            extract(epoch from replied_at)*1000 AS replied_at_ms,
            message_id, last_error, cost_cents,
            extract(epoch from created_at)*1000 AS created_at_ms
       FROM app_broadcasts_jobs
      WHERE tenant_id=$1
        AND recipient=$2
        AND channel=$3
        AND status='sent'
        AND replied_at IS NULL
        AND sent_at > to_timestamp($4/1000.0)
      ORDER BY sent_at DESC
      LIMIT $5`,
    [tenantId, recipient, input.channel, cutoff, limit],
  );
  return r.rows.map(rowToBroadcastJob);
}

// ── Automatización PRO: entradas a flujos por día (rango, tenant-scoped). ──
// AUTOMATIZACION-CANAL-1 · flowIds opcional: acota la serie diaria a los
// flujos de un canal/cuenta concretos (ver segAutomation en analytics.ts).
// Sin él, cuenta todos los flujos del tenant como siempre.
// CLASIFICA-FLUJOS-1 (MET-AUTO-02) · `phones` opcional: solo las entradas de ese
// subconjunto de personas (filtro «fuente de captación»). Un array vacío = nadie.
export async function dbFlowRunsDaily(sinceMs: number, untilMs: number, flowIds?: string[], phones?: string[]): Promise<Array<{ date: string; value: number }>> {
  const tenantId = currentWorkspaceId();
  const idSet = flowIds && flowIds.length ? new Set(flowIds) : null;
  const phoneSet = phones ? new Set(phones) : null;
  if (!pool) {
    const m: Record<string, number> = {};
    for (const r of mem.flowRuns.values()) {
      if (((r as unknown as { tenant_id?: string }).tenant_id || "default") !== tenantId) continue;
      if (idSet && !idSet.has(r.flow_id)) continue;
      if (phoneSet && !phoneSet.has(r.phone)) continue;
      // En memoria no hay created_at fiable: updated_at (o next_run) es la marca disponible. CLASIFICA-FLUJOS-1
      const at = (r as unknown as { updated_at?: number }).updated_at || r.next_run || 0;
      if (at >= sinceMs && at <= untilMs) { const d = new Date(at).toISOString().slice(0, 10); m[d] = (m[d] || 0) + 1; }
    }
    return Object.entries(m).map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
  }
  const params: unknown[] = [tenantId, sinceMs, untilMs];
  const conds: string[] = [];
  if (idSet) { params.push([...idSet]); conds.push(`AND flow_id = ANY($${params.length})`); }
  if (phoneSet) { params.push([...phoneSet]); conds.push(`AND phone = ANY($${params.length})`); }
  const r = await pool.query(
    `SELECT to_char(created_at,'YYYY-MM-DD') d, count(*) n FROM app_flow_runs
      WHERE tenant_id=$1 AND created_at IS NOT NULL AND created_at >= to_timestamp($2/1000.0) AND created_at <= to_timestamp($3/1000.0)
        ${conds.join(" ")}
      GROUP BY 1 ORDER BY 1`,
    params,
  );
  return r.rows.map((x: { d: string; n: string }) => ({ date: String(x.d), value: Number(x.n) || 0 }));
}

// AUTO-MEDICION-B-1 (MET-AUTO-05/06/07/10) · lo que el registro de los flujos permite medir de verdad,
// por flujo y acotado al negocio (tenant) y al rango: eventos del ciclo de vida (entró, respondió,
// completó, compró…), en qué paso está cada persona y cómo terminó, fallos por paso y si la persona
// siguió después, avisos de seguimiento repetidos y etiquetas de suscripción / resultado.
// null sin base persistente (modo memoria): el panel lo dice, no inventa cifras.
export interface AutoMedicionBDatos {
  eventos: Array<{ flow_id: string; event: string; personas: number; veces: number }>;
  nodos: Array<{ flow_id: string; node_id: string; status: string; n: number }>;
  fallos: Array<{ flow_id: string; node_id: string; personas: number; siguieron: number }>;
  repetidos: Array<{ flow_id: string; n: number }>;
  etiquetas: Array<{ flow_id: string; suscritas: number; conResultado: number; suscSinResultado: number; aMedias: number }>;
  // MET-AUTO-05-FIN · personas que un flujo pasó a otro (la entrada del destino lleva «desde el flujo «nombre»»).
  traspasos: Array<{ origen: string; personas: number }>;
  // MET-AUTO-05-FIN · lo que pasó DESPUÉS de entrar, con los datos que ya llegan: clic en el enlace
  // del flujo ≠ visita confirmada por el píxel (marca lmc_) · reserva en systeme.io ≠ cita celebrada
  // (fecha pasada sin cancelar) ≠ asistencia (solo si alguien la marcó con etiqueta «acudió/asistió») ·
  // oferta vista (clic o visita) ≠ compra (venta de systeme.io por email o pago propio por teléfono).
  embudo: Array<{ flow_id: string; clicaron: number; visitaron: number; reservaron: number; canceladas: number; celebradas: number; asistieron: number; vieronOferta: number; compraron: number }>;
}
export async function dbAutoMedicionB(sinceMs: number, untilMs: number, flowIds?: string[]): Promise<AutoMedicionBDatos | null> {
  const pg = pool;
  if (!pg) return null;
  const tenantId = currentWorkspaceId();
  const ids = flowIds && flowIds.length ? flowIds : null;
  const params: unknown[] = ids ? [tenantId, sinceMs, untilMs, ids] : [tenantId, sinceMs, untilMs];
  const evF = ids ? "AND e.flow_id = ANY($4)" : "";
  const rnF = ids ? "AND r.flow_id = ANY($4)" : "";
  const rango = "BETWEEN to_timestamp($2/1000.0) AND to_timestamp($3/1000.0)";
  const q = async (sql: string, ps: unknown[] = params): Promise<Array<Record<string, unknown>>> => {
    try { return (await pg.query(sql, ps)).rows as Array<Record<string, unknown>>; } catch { return []; }
  };
  const [ev, nd, fa, rp, et, tr, em] = await Promise.all([
    q(`SELECT e.flow_id, e.event, COUNT(DISTINCT e.phone)::int personas, COUNT(*)::int veces
         FROM app_flow_events e
        WHERE e.tenant_id=$1 AND e.at ${rango} ${evF}
        GROUP BY 1,2`),
    q(`SELECT r.flow_id, r.node_id, r.status, COUNT(*)::int n
         FROM app_flow_runs r
        WHERE r.tenant_id=$1 AND r.updated_at ${rango} ${rnF}
        GROUP BY 1,2,3`),
    q(`SELECT e.flow_id, e.node_id, COUNT(DISTINCT e.phone)::int personas,
              COUNT(DISTINCT e.phone) FILTER (WHERE r.status='done' OR (r.status IN ('active','waiting') AND r.node_id <> e.node_id))::int siguieron
         FROM app_flow_events e
         LEFT JOIN app_flow_runs r ON r.phone=e.phone AND r.flow_id=e.flow_id AND r.tenant_id=e.tenant_id
        WHERE e.tenant_id=$1 AND e.at ${rango} AND (e.event='error' OR e.event='paso NO entregado') ${evF}
        GROUP BY 1,2`),
    q(`SELECT t.flow_id, COUNT(*)::int n FROM (
         SELECT e.flow_id, e.phone, e.event FROM app_flow_events e
          WHERE e.tenant_id=$1 AND e.at ${rango} AND e.event IN ('reenganche 1','reenganche 2','reenganche 3') ${evF}
          GROUP BY 1,2,3 HAVING COUNT(*) > 1) t
        GROUP BY 1`),
    q(`WITH tg AS (
         SELECT e.flow_id, e.phone,
                bool_or(e.detail ~* '(newsletter|bolet[ií]n|suscri)') AS susc,
                bool_or(e.detail ~* '(resultado|diagn[oó]stico|informe)') AS res
           FROM app_flow_events e
          WHERE e.tenant_id=$1 AND e.at ${rango} AND e.event='acción' AND e.detail LIKE 'etiqueta +%' ${evF}
          GROUP BY 1,2)
       SELECT tg.flow_id,
              COUNT(*) FILTER (WHERE tg.susc)::int suscritas,
              COUNT(*) FILTER (WHERE tg.res)::int con_resultado,
              COUNT(*) FILTER (WHERE tg.susc AND NOT tg.res)::int susc_sin_resultado,
              COUNT(*) FILTER (WHERE tg.susc AND NOT tg.res AND COALESCE(r.status,'') <> 'done')::int a_medias
         FROM tg LEFT JOIN app_flow_runs r ON r.phone=tg.phone AND r.flow_id=tg.flow_id AND r.tenant_id=$1
        GROUP BY 1`),
    // MET-AUTO-05-FIN · sin filtro de flujos: el destino puede quedar fuera del filtro y el traspaso es del origen.
    q(`SELECT substring(e.detail from 'desde el flujo «(.*)»') origen, COUNT(DISTINCT e.phone)::int personas
         FROM app_flow_events e
        WHERE e.tenant_id=$1 AND e.at ${rango} AND e.event='entró' AND e.detail LIKE '%desde el flujo «%'
        GROUP BY 1`, [tenantId, sinceMs, untilMs]),
    // MET-AUTO-05-FIN · cada persona cuenta una vez por flujo, y solo lo ocurrido desde que entró.
    q(`WITH b AS (
         SELECT e.flow_id, e.phone, MIN(e.at) desde
           FROM app_flow_events e
          WHERE e.tenant_id=$1 AND e.at ${rango} AND e.event='entró' ${evF}
          GROUP BY 1,2),
       x AS (
         SELECT b.flow_id, b.phone,
                EXISTS (SELECT 1 FROM app_link_clicks c JOIN app_short_links sl ON sl.token=c.token
                         WHERE sl.tenant_id=$1 AND sl.context_kind='flow' AND sl.context_id=b.flow_id
                           AND c.phone=b.phone AND c.created_at >= b.desde) clic,
                EXISTS (SELECT 1 FROM app_page_views v
                         WHERE v.tenant_id=$1 AND v.contact<>'' AND v.contact=regexp_replace(b.phone,'[^0-9]','','g')
                           AND v.created_at >= b.desde) visita,
                k.email, k.tags
           FROM b
           LEFT JOIN LATERAL (SELECT lower(NULLIF(ct.email,'')) email, ct.tags FROM app_contacts ct
                               WHERE ct.tenant_id=$1 AND ct.phone=b.phone LIMIT 1) k ON true),
       y AS (
         SELECT x.*,
                (SELECT COUNT(*) FROM app_sio_bookings s WHERE s.tenant_id=$1 AND x.email IS NOT NULL AND lower(s.email)=x.email
                    AND COALESCE(s.created_at, s.synced_at) >= b.desde) res,
                (SELECT COUNT(*) FROM app_sio_bookings s WHERE s.tenant_id=$1 AND x.email IS NOT NULL AND lower(s.email)=x.email
                    AND COALESCE(s.created_at, s.synced_at) >= b.desde AND upper(s.status)='CANCELLED') canc,
                (SELECT COUNT(*) FROM app_sio_bookings s WHERE s.tenant_id=$1 AND x.email IS NOT NULL AND lower(s.email)=x.email
                    AND COALESCE(s.created_at, s.synced_at) >= b.desde AND upper(s.status)<>'CANCELLED' AND s.booked_at < now()) cele,
                EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(x.tags,'[]'::jsonb)) t WHERE t ~* '^(acudi|asisti)') asis,
                (EXISTS (SELECT 1 FROM app_sio_sales s WHERE s.tenant_id=$1 AND s.kind='sale' AND x.email IS NOT NULL
                          AND lower(s.email)=x.email AND s.paid_at >= b.desde)
                 OR EXISTS (SELECT 1 FROM app_purchases p WHERE p.tenant_id=$1 AND p.phone=x.phone AND p.created_at >= b.desde)) compra
           FROM x JOIN b ON b.flow_id=x.flow_id AND b.phone=x.phone)
       SELECT flow_id,
              COUNT(*) FILTER (WHERE clic)::int clicaron,
              COUNT(*) FILTER (WHERE visita)::int visitaron,
              COUNT(*) FILTER (WHERE res>0)::int reservaron,
              COUNT(*) FILTER (WHERE res>0 AND canc=res)::int canceladas,
              COUNT(*) FILTER (WHERE cele>0)::int celebradas,
              COUNT(*) FILTER (WHERE cele>0 AND asis)::int asistieron,
              COUNT(*) FILTER (WHERE clic OR visita)::int vieron_oferta,
              COUNT(*) FILTER (WHERE compra)::int compraron
         FROM y GROUP BY 1`),
  ]);
  const n = (v: unknown): number => Number(v) || 0;
  return {
    eventos: ev.map((x) => ({ flow_id: String(x.flow_id), event: String(x.event), personas: n(x.personas), veces: n(x.veces) })),
    nodos: nd.map((x) => ({ flow_id: String(x.flow_id), node_id: String(x.node_id || ""), status: String(x.status || ""), n: n(x.n) })),
    fallos: fa.map((x) => ({ flow_id: String(x.flow_id), node_id: String(x.node_id || ""), personas: n(x.personas), siguieron: n(x.siguieron) })),
    repetidos: rp.map((x) => ({ flow_id: String(x.flow_id), n: n(x.n) })),
    etiquetas: et.map((x) => ({ flow_id: String(x.flow_id), suscritas: n(x.suscritas), conResultado: n(x.con_resultado), suscSinResultado: n(x.susc_sin_resultado), aMedias: n(x.a_medias) })),
    traspasos: tr.filter((x) => x.origen).map((x) => ({ origen: String(x.origen), personas: n(x.personas) })),
    embudo: em.map((x) => ({ flow_id: String(x.flow_id), clicaron: n(x.clicaron), visitaron: n(x.visitaron), reservaron: n(x.reservaron), canceladas: n(x.canceladas), celebradas: n(x.celebradas), asistieron: n(x.asistieron), vieronOferta: n(x.vieron_oferta), compraron: n(x.compraron) })),
  };
}


// MET-AUTO-10-FIN · qué correos llevaron tráfico o respuestas, y qué eventos de correo no se
// pudieron vincular a ninguna ficha. Sale del rastro de app_email_events (aperturas y clics
// de envíos de systeme.io); «volvieron» = la persona tuvo actividad en un flujo DESPUÉS de
// ese evento (en los 7 días siguientes). Es coincidencia en el tiempo, no prueba de causa.
export interface CorreoQueLleva { cuenta: string; correo: string; abrieron: number; clicaron: number; volvieron: number; sinVincular: number }
export async function dbCorreosQueLlevan(sinceMs: number, untilMs: number): Promise<CorreoQueLleva[] | null> {
  const pg = pool;
  if (!pg) return null;
  try {
    const r = await pg.query(
      `WITH ev AS (
         SELECT x.account_id AS cuenta, split_part(x.dedupe_key, ':', 3) AS correo, x.event, lower(x.contact_email) AS email,
                COALESCE(x.occurred_at, x.received_at) AS at
           FROM app_email_events x
          WHERE x.tenant_id=$1 AND x.event IN ('mail_opened','mail_clicked')
            AND COALESCE(x.occurred_at, x.received_at) BETWEEN to_timestamp($2/1000.0) AND to_timestamp($3/1000.0))
       SELECT ev.cuenta, ev.correo,
              COUNT(DISTINCT ev.email) FILTER (WHERE ev.event='mail_opened')::int abrieron,
              COUNT(DISTINCT ev.email) FILTER (WHERE ev.event='mail_clicked')::int clicaron,
              COUNT(DISTINCT ev.email) FILTER (WHERE EXISTS (
                SELECT 1 FROM app_flow_events f
                 WHERE f.tenant_id=$1 AND f.phone=c.phone AND f.at > ev.at AND f.at <= ev.at + interval '7 days'
                   AND f.event IN ('respondió','entró','completó')))::int volvieron,
              COUNT(DISTINCT ev.email) FILTER (WHERE c.phone IS NULL)::int sin_vincular
         FROM ev
         LEFT JOIN LATERAL (SELECT k.phone FROM app_contacts k WHERE k.tenant_id=$1 AND lower(k.email)=ev.email LIMIT 1) c ON true
        GROUP BY 1,2 ORDER BY 4 DESC, 3 DESC LIMIT 20`,
      [currentWorkspaceId(), sinceMs, untilMs],
    );
    const n = (v: unknown): number => Number(v) || 0;
    return r.rows.map((x: Record<string, unknown>) => ({ cuenta: String(x.cuenta || ""), correo: String(x.correo || ""), abrieron: n(x.abrieron), clicaron: n(x.clicaron), volvieron: n(x.volvieron), sinVincular: n(x.sin_vincular) }));
  } catch { return []; }
}
// MET-LEADS-07-FIN · por ficha, el último correo que abrió o pulsó (app_email_events, cruzado por el
// email de la ficha), en epoch ms. Sólo Postgres: en modo memoria no hay rastro de correos.
export async function dbUltimoCorreoDeContactos(phones: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ps = [...new Set(phones.filter(Boolean))];
  if (!pool || !ps.length) return out;
  try {
    const r = await pool.query(
      `SELECT c.phone, extract(epoch from max(COALESCE(x.occurred_at, x.received_at)))*1000 AS at
         FROM app_contacts c
         JOIN app_email_events x ON x.tenant_id=c.tenant_id AND lower(x.contact_email)=lower(c.email)
        WHERE c.tenant_id=$1 AND c.phone = ANY($2::text[]) AND c.email <> ''
          AND x.event IN ('mail_opened','mail_clicked')
        GROUP BY c.phone`,
      [currentWorkspaceId(), ps],
    );
    for (const x of r.rows as { phone: string; at: unknown }[]) { const t = Number(x.at) || 0; if (t > 0) out.set(String(x.phone), t); }
  } catch { /* sin rastro de correos */ }
  return out;
}
// ── CRUCE sio→CRM (2026-08-14): contactos por email (lower) o por
// systemeio_contact_id — para atribuir registros de systeme.io creados por
// NUESTRO bot vía API (sin sourceURL ni utm: los «Directo / sin origen»). ──
export async function dbContactsBySioRef(
  emails: string[],
  sioIds: string[],
): Promise<{ byEmail: Map<string, Contact>; bySioId: Map<string, Contact> }> {
  const byEmail = new Map<string, Contact>();
  const bySioId = new Map<string, Contact>();
  const ems = [...new Set(emails.map((e) => String(e || "").toLowerCase()).filter(Boolean))];
  const ids = [...new Set(sioIds.map((x) => String(x || "")).filter(Boolean))];
  if (!ems.length && !ids.length) return { byEmail, bySioId };
  const tenantId = currentWorkspaceId();
  if (!pool) {
    for (const c of mem.contacts.values()) {
      if ((c.tenant_id || "default") !== tenantId) continue;
      if (c.email && ems.includes(c.email.toLowerCase())) byEmail.set(c.email.toLowerCase(), c);
      if (c.systemeio_contact_id && ids.includes(String(c.systemeio_contact_id))) bySioId.set(String(c.systemeio_contact_id), c);
    }
    return { byEmail, bySioId };
  }
  const r = await pool.query(
    `SELECT ${CFIELDS} FROM app_contacts WHERE tenant_id=$3 AND (lower(email) = ANY($1) OR systemeio_contact_id = ANY($2))`,
    [ems, ids, tenantId],
  );
  for (const row of r.rows) {
    const c = rowToContact(row);
    if (c.email) byEmail.set(c.email.toLowerCase(), c);
    if (c.systemeio_contact_id) bySioId.set(String(c.systemeio_contact_id), c);
  }
  return { byEmail, bySioId };
}

// ── UN-FLUJO-3 (2026-08-14, incidente IG del owner): al arrancar un flujo
// nuevo, cancelar TODOS los runs vivos del contacto menos el nuevo — no solo
// el «waiting» más reciente: los runs en 'active' (delays) o los segundos en
// espera quedaban latentes y se cruzaban días después. Siempre impera la nueva. ──
export async function dbCancelOtherFlowRuns(phone: string, exceptFlowId: string): Promise<Array<{ flow_id: string; node_id: string; status: string }>> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const out: Array<{ flow_id: string; node_id: string; status: string }> = [];
    for (const [k, x] of mem.flowRuns)
      if (
        x.phone === phone &&
        x.flow_id !== exceptFlowId &&
        (x.status === "active" || x.status === "waiting") &&
        ((x.tenant_id || "default") === tenantId)
      ) {
        out.push({ flow_id: x.flow_id, node_id: x.node_id, status: x.status });
        mem.flowRuns.delete(k);
      }
    return out;
  }
  const r = await pool.query(
    "UPDATE app_flow_runs SET status='cancelled' WHERE phone=$1 AND tenant_id=$2 AND flow_id<>$3 AND status IN ('active','waiting') RETURNING flow_id, node_id, status",
    [phone, tenantId, exceptFlowId],
  );
  return r.rows as Array<{ flow_id: string; node_id: string; status: string }>;
}

// ── ATRIBUCIÓN DE ANUNCIO (2026-08-14): fija los utm_* del contacto SOLO si
// aún no tiene ninguno (primer toque manda; nunca se pisa una atribución ya
// hecha). Lo usa la captura del `referral` de Meta en los webhooks WA/IG. ──
export async function dbSetContactUtmIfEmpty(
  phone: string,
  utm: { utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_content?: string },
): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const c = mem.contacts.get(contactMemKey(phone));
    if (!c || (c.tenant_id || "default") !== tenantId) return false;
    if (c.utm_source || c.utm_medium || c.utm_campaign || c.utm_content) return false;
    c.utm_source = utm.utm_source || ""; c.utm_medium = utm.utm_medium || "";
    c.utm_campaign = utm.utm_campaign || ""; c.utm_content = utm.utm_content || "";
    return true;
  }
  const r = await pool.query(
    `UPDATE app_contacts SET utm_source=$3, utm_medium=$4, utm_campaign=$5, utm_content=$6, updated_at=now()
     WHERE phone=$1 AND tenant_id=$2
       AND COALESCE(utm_source,'')='' AND COALESCE(utm_medium,'')=''
       AND COALESCE(utm_campaign,'')='' AND COALESCE(utm_content,'')=''`,
    [phone, tenantId, utm.utm_source || "", utm.utm_medium || "", utm.utm_campaign || "", utm.utm_content || ""],
  );
  return (r.rowCount || 0) > 0;
}

// ════════════════════════════════════════════════════════════════════
// T03-CORREOS · Eventos de correo (etiqueta puente) — claim + rastro.
// El INSERT con ON CONFLICT DO NOTHING sobre el índice único
// (tenant_id, account_id, dedupe_key) ES el claim de idempotencia: la
// primera vía que lo consiga (webhook o reconciliación, cualquier
// worker) procesa; el resto ve null y no repite. Sobrevive a reinicios
// porque la marca vive en la tabla, no en memoria.
// ════════════════════════════════════════════════════════════════════

export interface EmailEventRow {
  id: number;
  tenant_id: string;
  account_id: string;
  dedupe_key: string;
  event: string;
  tag: string;
  contact_email: string;
  source: string; // 'webhook' | 'poll'
  occurred_at: number | null; // epoch ms (null = el proveedor no lo dijo)
  received_at: number;
  status: string; // 'new' | 'processed' | 'partial' | 'error' | 'ignored'
  attempts: number;
  error: string;
  flows_started: number;
}

let memEmailEventSeq = 1;

/** Reclama un evento de correo. Devuelve el id de la fila NUEVA, o null si ya
 *  estaba reclamado (duplicado legítimo: reintento, webhook+poll, otro worker). */
export async function dbClaimEmailEvent(evt: {
  accountId: string;
  dedupeKey: string;
  event: string;
  tag: string;
  contactEmail: string;
  source: string;
  occurredAt?: number | null;
}): Promise<number | null> {
  const tenantId = currentWorkspaceId();
  const k = `${tenantId}:${evt.accountId}:${evt.dedupeKey}`;
  if (!pool) {
    if (mem.emailEvents.has(k)) return null;
    const row: EmailEventRow = {
      id: memEmailEventSeq++,
      tenant_id: tenantId,
      account_id: evt.accountId,
      dedupe_key: evt.dedupeKey,
      event: evt.event,
      tag: evt.tag,
      contact_email: evt.contactEmail,
      source: evt.source,
      occurred_at: evt.occurredAt ?? null,
      received_at: Date.now(),
      status: "new",
      attempts: 0,
      error: "",
      flows_started: 0,
    };
    mem.emailEvents.set(k, row);
    // Tope blando (sin DB no rota): nos quedamos con lo más reciente.
    if (mem.emailEvents.size > 5000) {
      const first = mem.emailEvents.keys().next().value;
      if (first) mem.emailEvents.delete(first);
    }
    return row.id;
  }
  const r = await pool.query(
    `INSERT INTO app_email_events (tenant_id, account_id, dedupe_key, event, tag, contact_email, source, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::bigint IS NULL THEN NULL ELSE to_timestamp($8::bigint/1000.0) END)
     ON CONFLICT (tenant_id, account_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [tenantId, evt.accountId, evt.dedupeKey, evt.event, evt.tag, evt.contactEmail, evt.source, evt.occurredAt ?? null],
  );
  return r.rowCount ? Number(r.rows[0].id) : null;
}

/** Cierra el procesamiento de un evento reclamado (resultado + intentos).
 *  Un error parcial queda como 'partial'/'error' con el detalle SANEADO por el
 *  llamante — jamás se guarda un payload crudo aquí. */
export async function dbFinishEmailEvent(
  accountId: string,
  dedupeKey: string,
  r: { status: string; error?: string; flowsStarted?: number },
): Promise<void> {
  const tenantId = currentWorkspaceId();
  const err = String(r.error || "").slice(0, 400);
  if (!pool) {
    const row = mem.emailEvents.get(`${tenantId}:${accountId}:${dedupeKey}`);
    if (row) {
      row.status = r.status;
      row.error = err;
      row.attempts += 1;
      row.flows_started = r.flowsStarted ?? row.flows_started;
    }
    return;
  }
  await pool.query(
    `UPDATE app_email_events SET status=$4, error=$5, attempts=attempts+1, flows_started=COALESCE($6, flows_started)
     WHERE tenant_id=$1 AND account_id=$2 AND dedupe_key=$3`,
    [tenantId, accountId, dedupeKey, r.status, err, r.flowsStarted ?? null],
  );
}

/** Últimos eventos de correo del workspace actual (observabilidad y pruebas). */
export async function dbListEmailEvents(opts: { accountId?: string; limit?: number } = {}): Promise<EmailEventRow[]> {
  const tenantId = currentWorkspaceId();
  const lim = Math.min(200, Math.max(1, Number(opts.limit) || 50));
  if (!pool) {
    const out: EmailEventRow[] = [];
    for (const row of mem.emailEvents.values()) {
      if (row.tenant_id !== tenantId) continue;
      if (opts.accountId && row.account_id !== opts.accountId) continue;
      out.push(row);
    }
    return out.sort((a, b) => b.received_at - a.received_at).slice(0, lim);
  }
  const args: unknown[] = [tenantId];
  let where = "tenant_id=$1";
  if (opts.accountId) {
    args.push(opts.accountId);
    where += " AND account_id=$2";
  }
  const r = await pool.query(
    `SELECT id, tenant_id, account_id, dedupe_key, event, tag, contact_email, source,
            (EXTRACT(EPOCH FROM occurred_at)*1000)::bigint AS occurred_at,
            (EXTRACT(EPOCH FROM received_at)*1000)::bigint AS received_at,
            status, attempts, error, flows_started
     FROM app_email_events WHERE ${where} ORDER BY received_at DESC LIMIT ${lim}`,
    args,
  );
  return r.rows.map((x: Record<string, unknown>) => ({
    id: Number(x.id),
    tenant_id: String(x.tenant_id),
    account_id: String(x.account_id),
    dedupe_key: String(x.dedupe_key),
    event: String(x.event),
    tag: String(x.tag),
    contact_email: String(x.contact_email),
    source: String(x.source),
    occurred_at: x.occurred_at == null ? null : Number(x.occurred_at),
    received_at: Number(x.received_at),
    status: String(x.status),
    attempts: Number(x.attempts),
    error: String(x.error),
    flows_started: Number(x.flows_started),
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// FORMULARIOS-1 · Formularios propios. Todo acotado al workspace activo salvo
// dbFormBySlugPublico(), que es la ÚNICA lectura sin tenant: la visita pública
// sólo trae el slug, y de la fila sale el workspace en el que se atiende.
// ════════════════════════════════════════════════════════════════════════════
export interface FormQuestion {
  id: string;
  type: "nombre" | "email" | "telefono" | "texto" | "parrafo" | "opcion" | "varias" | "numero" | "fecha" | "si_no" | "acepto"
    | "desplegable" | "escala" | "valoracion" | "web" // FORMULARIOS-4
    | "archivo"; // FORM-ARCHIVO-1 · quien responde adjunta fotos o PDF
  label: string;
  description?: string;  // FORMULARIOS-4 · texto de ayuda bajo la pregunta
  required?: boolean;
  options?: string[];
  placeholder?: string;
  /** FORMULARIOS-8 · en «una por pantalla», se ve en la misma pantalla que la pregunta anterior. */
  conAnterior?: boolean;
  /** FORMULARIOS-8 · imagen o vídeo encima de la pregunta: subido desde el panel (/f/m/<id>) o enlace https. */
  media?: { tipo: "imagen" | "video"; url: string };
  /** FORM-ARBOL-1 · árbol de decisiones: respuesta → id de la pregunta a la que salta ("fin" = terminar). */
  salto?: Record<string, string>;
  /** FORM-ARBOL-1 · después de esta pregunta (si ninguna respuesta salta), ir a este id ("fin" = terminar). */
  luego?: string;
}
export interface FormOpts {
  thanks?: string;       // texto al terminar
  button?: string;       // texto del botón de enviar
  color?: string;        // color de marca del formulario (#rrggbb)
  tag?: string;          // etiqueta extra en el CRM
  sioAccount?: string;   // cuenta web (systeme.io / leadmatch-lab) a la que se copia el contacto; '' = ninguna
  sioTag?: string;       // etiqueta que se le pone en esa web (la que enciende sus automatizaciones)
  redirect?: string;     // al terminar, ir a esta dirección (opcional)
  oneByOne?: boolean;    // una pregunta por pantalla (sólo cuenta si modoElegido; ver unaPorPantalla)
  modoElegido?: boolean; // FORMULARIOS-5 · el modo lo eligió alguien en el editor nuevo; sin esto, una por pantalla
  welcome?: boolean;     // FORMULARIOS-4 · pantalla de bienvenida (título + «Empezar») en el modo una a una
  notify?: boolean;      // avisar en la campana (por defecto sí)
  // FORMULARIOS-DISENO-1
  theme?: string;        // diseño elegido (TEMAS_FORMULARIO en formularios.ts)
  bgImage?: string;      // imagen de fondo (https)
  css?: string;          // CSS propio
  htmlTop?: string;      // HTML propio encima de las preguntas (ya saneado)
  htmlBottom?: string;   // HTML propio debajo del botón (ya saneado)
  // FORMULARIOS-2
  tags?: string[];       // etiquetas en el CRM (sustituye a `tag`, que se sigue leyendo)
  pipeline?: string;     // pipeline en el que entra quien responde ('' = ninguno)
  stage?: string;        // etapa de ese pipeline
  layout?: "tema" | "html"; // 'html' = página entera de HTML propio con {{formulario}} dentro
  pageHtml?: string;     // esa página (ya saneada)
  // FORM-CITA-1 · al enviar, un último paso con el calendario de reservas de la web
  // (página de systeme.io con el elemento Calendario, https). La reserva vive allí y
  // se copia aquí por la sincronización de reservas; '' = sin paso de cita.
  citaUrl?: string;
}
export interface FormRec {
  id: string;
  tenant_id?: string;
  slug: string;
  title: string;
  intro: string;
  questions: FormQuestion[];
  opts: FormOpts;
  status: "active" | "paused";
  created_by: string;
  created_at: number;
  updated_at: number;
}
export interface FormDayRow { tenant_id: string; form_id: string; day: string; views: number; submissions: number }
export interface FormResponseRec {
  id: string;
  tenant_id?: string;
  form_id: string;        // id propio, o 'tf:<id>' si viene de Typeform
  form_title: string;
  source: "web" | "typeform";
  contact_id: string;     // clave de la ficha en el CRM
  name: string;
  email: string;
  phone: string;
  answers: Array<{ label: string; v: string }>;
  sync: string;           // '' = sin copia a web · 'ok:<cuenta>' · 'error:<motivo>'
  created_at: number;
}

const FORM_COLS = "id,tenant_id,slug,title,intro,questions,opts,status,created_by, extract(epoch from created_at)*1000 created_at, extract(epoch from updated_at)*1000 updated_at";
function jsonDe<T>(v: unknown, def: T): T {
  try { const x = typeof v === "string" ? JSON.parse(v) : v; return (x ?? def) as T; } catch { return def; }
}
function rowToForm(r: Record<string, unknown>): FormRec {
  const q = jsonDe<FormQuestion[]>(r.questions, []);
  const o = jsonDe<FormOpts>(r.opts, {});
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id || "default"),
    slug: String(r.slug || ""),
    title: String(r.title ?? ""),
    intro: String(r.intro ?? ""),
    questions: Array.isArray(q) ? q : [],
    opts: o && typeof o === "object" ? o : {},
    status: r.status === "paused" ? "paused" : "active",
    created_by: String(r.created_by ?? ""),
    created_at: Number(r.created_at) || 0,
    updated_at: Number(r.updated_at) || 0,
  };
}
/** Día natural en Madrid (AAAA-MM-DD): el mismo en memoria y en Postgres. */
const formatoDiaFormulario = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" });
export function diaFormulario(ms = Date.now()): string {
  return formatoDiaFormulario.format(new Date(ms));
}

export async function dbListForms(): Promise<FormRec[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) return [...mem.forms.values()].filter((f) => (f.tenant_id || "default") === tenantId).sort((a, b) => b.updated_at - a.updated_at);
  const r = await pool.query(`SELECT ${FORM_COLS} FROM app_forms WHERE tenant_id=$1 ORDER BY updated_at DESC`, [tenantId]);
  return r.rows.map(rowToForm);
}

export async function dbGetForm(id: string): Promise<FormRec | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) { const f = mem.forms.get(id); return f && (f.tenant_id || "default") === tenantId ? f : null; }
  const r = await pool.query(`SELECT ${FORM_COLS} FROM app_forms WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  return r.rows.length ? rowToForm(r.rows[0]) : null;
}

/** La página pública: busca por slug EN TODA LA PLATAFORMA. Quien llama abre el
 *  ámbito del workspace de la fila (tenant_id) antes de tocar nada más. */
export async function dbFormBySlugPublico(slug: string): Promise<FormRec | null> {
  const s = String(slug || "").toLowerCase();
  if (!s) return null;
  if (!pool) return [...mem.forms.values()].find((f) => f.slug === s) || null;
  const r = await pool.query(`SELECT ${FORM_COLS} FROM app_forms WHERE slug=$1`, [s]);
  return r.rows.length ? rowToForm(r.rows[0]) : null;
}

/** ¿Está libre este slug? (único en toda la plataforma; no revela de quién es). */
export async function dbFormSlugLibre(slug: string, exceptId = ""): Promise<boolean> {
  if (!pool) return ![...mem.forms.values()].some((f) => f.slug === slug && f.id !== exceptId);
  const r = await pool.query(`SELECT 1 FROM app_forms WHERE slug=$1 AND id<>$2`, [slug, exceptId]);
  return !r.rows.length;
}

export async function dbUpsertForm(f: FormRec): Promise<void> {
  const tenantId = currentWorkspaceId();
  const ahora = Date.now();
  if (!pool) {
    const prev = mem.forms.get(f.id);
    if (prev && (prev.tenant_id || "default") !== tenantId) throw new Error("form ajeno");
    mem.forms.set(f.id, { ...f, tenant_id: tenantId, created_at: f.created_at || ahora, updated_at: ahora });
    return;
  }
  // El UPDATE sólo pisa la fila del MISMO workspace: un id adivinado de otro negocio
  // no se sobrescribe (el INSERT choca con la PK y el WHERE lo descarta).
  const r = await pool.query(
    `INSERT INTO app_forms (id,tenant_id,slug,title,intro,questions,opts,status,created_by,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,to_timestamp($10/1000.0),now())
     ON CONFLICT (id) DO UPDATE SET slug=$3,title=$4,intro=$5,questions=$6::jsonb,opts=$7::jsonb,status=$8,updated_at=now()
       WHERE app_forms.tenant_id=$2
     RETURNING 1`,
    [f.id, tenantId, f.slug, f.title.slice(0, 200), f.intro.slice(0, 2000), JSON.stringify(f.questions || []), JSON.stringify(f.opts || {}), f.status, f.created_by || "", f.created_at || ahora],
  );
  if (!r.rowCount) throw new Error("form ajeno");
}

export async function dbDeleteForm(id: string): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const f = mem.forms.get(id);
    if (f && (f.tenant_id || "default") === tenantId) mem.forms.delete(id);
    for (const [k, d] of mem.formDays) if (d.tenant_id === tenantId && d.form_id === id) mem.formDays.delete(k);
    return;
  }
  // Las respuestas se quedan: son historia de cada contacto (llevan el título copiado).
  await pool.query(`DELETE FROM app_forms WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  await pool.query(`DELETE FROM app_form_days WHERE form_id=$1 AND tenant_id=$2`, [id, tenantId]);
}

/** Suma una visita o un envío al día de hoy. */
export async function dbFormBump(formId: string, campo: "views" | "submissions"): Promise<void> {
  const tenantId = currentWorkspaceId();
  const day = diaFormulario();
  if (!pool) {
    const k = JSON.stringify([tenantId, formId, day]);
    const d = mem.formDays.get(k) || { tenant_id: tenantId, form_id: formId, day, views: 0, submissions: 0 };
    d[campo]++;
    mem.formDays.set(k, d);
    return;
  }
  const col = campo === "views" ? "views" : "submissions";
  await pool.query(
    `INSERT INTO app_form_days (tenant_id,form_id,day,${col}) VALUES ($1,$2,$3::date,1)
     ON CONFLICT (tenant_id,form_id,day) DO UPDATE SET ${col}=app_form_days.${col}+1`,
    [tenantId, formId, day],
  );
}

/** Contadores por día desde `desde` (AAAA-MM-DD) para los formularios del workspace. */
export async function dbFormDays(desde: string): Promise<FormDayRow[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) return [...mem.formDays.values()].filter((d) => d.tenant_id === tenantId && d.day >= desde);
  const r = await pool.query(
    `SELECT form_id, to_char(day,'YYYY-MM-DD') AS day, views, submissions FROM app_form_days WHERE tenant_id=$1 AND day >= $2::date`,
    [tenantId, desde],
  );
  return r.rows.map((x: Record<string, unknown>) => ({ tenant_id: tenantId, form_id: String(x.form_id), day: String(x.day), views: Number(x.views) || 0, submissions: Number(x.submissions) || 0 }));
}

/** Totales de siempre por formulario (visitas y envíos) del workspace. */
export async function dbFormTotals(): Promise<Record<string, { views: number; submissions: number }>> {
  const tenantId = currentWorkspaceId();
  const out: Record<string, { views: number; submissions: number }> = {};
  if (!pool) {
    for (const d of mem.formDays.values()) {
      if (d.tenant_id !== tenantId) continue;
      const t = (out[d.form_id] ||= { views: 0, submissions: 0 });
      t.views += d.views; t.submissions += d.submissions;
    }
    return out;
  }
  const r = await pool.query(`SELECT form_id, sum(views)::int v, sum(submissions)::int s FROM app_form_days WHERE tenant_id=$1 GROUP BY form_id`, [tenantId]);
  for (const x of r.rows) out[String(x.form_id)] = { views: Number(x.v) || 0, submissions: Number(x.s) || 0 };
  return out;
}

const FRESP_COLS = "id,tenant_id,form_id,form_title,source,contact_id,name,email,phone,answers,sync, extract(epoch from created_at)*1000 created_at";
function rowToFormResponse(r: Record<string, unknown>): FormResponseRec {
  const a = jsonDe<Array<{ label: string; v: string }>>(r.answers, []);
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id || "default"),
    form_id: String(r.form_id || ""),
    form_title: String(r.form_title ?? ""),
    source: r.source === "typeform" ? "typeform" : "web",
    contact_id: String(r.contact_id ?? ""),
    name: String(r.name ?? ""),
    email: String(r.email ?? ""),
    phone: String(r.phone ?? ""),
    answers: Array.isArray(a) ? a.map((x) => ({ label: String(x?.label ?? ""), v: String(x?.v ?? "") })) : [],
    sync: String(r.sync ?? ""),
    created_at: Number(r.created_at) || 0,
  };
}

export async function dbInsertFormResponse(x: FormResponseRec): Promise<void> {
  const tenantId = currentWorkspaceId();
  const rec = { ...x, tenant_id: tenantId, created_at: x.created_at || Date.now() };
  if (!pool) { mem.formResponses.push(rec); if (mem.formResponses.length > 20000) mem.formResponses.splice(0, 1000); return; }
  await pool.query(
    `INSERT INTO app_form_responses (id,tenant_id,form_id,form_title,source,contact_id,name,email,phone,answers,sync,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,to_timestamp($12/1000.0)) ON CONFLICT (id) DO NOTHING`,
    [rec.id, tenantId, rec.form_id, rec.form_title.slice(0, 200), rec.source, rec.contact_id, rec.name.slice(0, 200), rec.email.slice(0, 200), rec.phone.slice(0, 60), JSON.stringify(rec.answers || []), rec.sync.slice(0, 300), rec.created_at],
  );
}

export async function dbSetFormResponseSync(id: string, sync: string): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) { const r = mem.formResponses.find((x) => x.id === id && x.tenant_id === tenantId); if (r) r.sync = sync; return; }
  await pool.query(`UPDATE app_form_responses SET sync=$3 WHERE id=$1 AND tenant_id=$2`, [id, tenantId, sync.slice(0, 300)]);
}

/** FORM-CITA-2 · una respuesta del workspace por su id, o null. */
export async function dbGetFormResponse(id: string): Promise<FormResponseRec | null> {
  const tenantId = currentWorkspaceId();
  if (!id) return null;
  if (!pool) return mem.formResponses.find((x) => x.id === id && x.tenant_id === tenantId) || null;
  const r = await pool.query(`SELECT ${FRESP_COLS} FROM app_form_responses WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  return r.rows[0] ? rowToFormResponse(r.rows[0]) : null;
}

/**
 * FORM-CITA-2 · la respuesta que se guardó sin contacto (los datos los pide el calendario)
 * recibe su ficha al volver de reservar: contacto, nombre, correo, teléfono y las respuestas
 * completas. Solo si sigue sin contacto: un segundo intento no la reescribe.
 */
export async function dbCompletarFormResponse(id: string, x: Pick<FormResponseRec, "contact_id" | "name" | "email" | "phone" | "answers" | "sync">): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const r = mem.formResponses.find((y) => y.id === id && y.tenant_id === tenantId && !y.contact_id);
    if (!r) return false;
    Object.assign(r, x);
    return true;
  }
  const r = await pool.query(
    `UPDATE app_form_responses SET contact_id=$3, name=$4, email=$5, phone=$6, answers=$7::jsonb, sync=$8
     WHERE id=$1 AND tenant_id=$2 AND contact_id=''`,
    [id, tenantId, x.contact_id, x.name.slice(0, 200), x.email.slice(0, 200), x.phone.slice(0, 60), JSON.stringify(x.answers || []), x.sync.slice(0, 300)],
  );
  return (r.rowCount || 0) > 0;
}

/** Respuestas del workspace: de un formulario, de un contacto, o todas. Más recientes primero. */
export async function dbListFormResponses(opts: { formId?: string; contactId?: string; limit?: number } = {}): Promise<FormResponseRec[]> {
  const tenantId = currentWorkspaceId();
  const lim = Math.max(1, Math.min(5000, Number(opts.limit) || 1000));
  if (!pool) {
    return mem.formResponses
      .filter((r) => r.tenant_id === tenantId && (!opts.formId || r.form_id === opts.formId) && (!opts.contactId || r.contact_id === opts.contactId))
      .sort((a, b) => b.created_at - a.created_at).slice(0, lim);
  }
  const args: unknown[] = [tenantId];
  let where = "tenant_id=$1";
  if (opts.formId) { args.push(opts.formId); where += ` AND form_id=$${args.length}`; }
  if (opts.contactId) { args.push(opts.contactId); where += ` AND contact_id=$${args.length}`; }
  const r = await pool.query(`SELECT ${FRESP_COLS} FROM app_form_responses WHERE ${where} ORDER BY created_at DESC LIMIT ${lim}`, args);
  return r.rows.map(rowToFormResponse);
}

/** RESERVA-WA-3 · respuestas CON contacto creadas entre `desde` y `hasta` (ms), más recientes primero. */
export async function dbFormResponsesConContactoEntre(desde: number, hasta: number, limit = 50): Promise<FormResponseRec[]> {
  const tenantId = currentWorkspaceId();
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  if (!pool) {
    return mem.formResponses
      .filter((r) => r.tenant_id === tenantId && !!r.contact_id && r.created_at >= desde && r.created_at <= hasta)
      .sort((a, b) => b.created_at - a.created_at).slice(0, lim);
  }
  const r = await pool.query(
    `SELECT ${FRESP_COLS} FROM app_form_responses
     WHERE tenant_id=$1 AND contact_id<>'' AND created_at >= to_timestamp($2/1000.0) AND created_at <= to_timestamp($3/1000.0)
     ORDER BY created_at DESC LIMIT ${lim}`,
    [tenantId, desde, hasta],
  );
  return r.rows.map(rowToFormResponse);
}

/** Recuento y última respuesta por formulario (incluye los de Typeform, 'tf:<id>'). */
export async function dbFormResponseStats(): Promise<Record<string, { n: number; last: number }>> {
  const tenantId = currentWorkspaceId();
  const out: Record<string, { n: number; last: number }> = {};
  if (!pool) {
    for (const r of mem.formResponses) {
      if (r.tenant_id !== tenantId) continue;
      const t = (out[r.form_id] ||= { n: 0, last: 0 });
      t.n++; t.last = Math.max(t.last, r.created_at);
    }
    return out;
  }
  const r = await pool.query(`SELECT form_id, count(*)::int n, extract(epoch from max(created_at))*1000 last FROM app_form_responses WHERE tenant_id=$1 GROUP BY form_id`, [tenantId]);
  for (const x of r.rows) out[String(x.form_id)] = { n: Number(x.n) || 0, last: Number(x.last) || 0 };
  return out;
}

// ─── DASH-METRICAS-1 · Datos del panel de control (Dashboard) ──────────────────
// Series DIARIAS agrupadas en la zona horaria de quien mira (IANA: 'Europe/Madrid'),
// para que «hoy» sea su hoy y no el del servidor (Railway corre en UTC). Todo acotado
// por workspace. El endpoint /admin/api/dashboard/metricas compone la respuesta.

const dashFmt = new Map<string, Intl.DateTimeFormat>();
/** Día YYYY-MM-DD de un instante en la zona `tz` (en-CA ya formatea así). */
export function dashDayKey(ms: number, tz: string): string {
  let f = dashFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dashFmt.set(tz, f);
  }
  return f.format(new Date(ms));
}

/** Contactos nuevos por día y origen (utm_source + source, que el endpoint clasifica). */
export async function dbDashLeadsDaily(
  sinceMs: number,
  untilMs: number,
  tz: string,
): Promise<Array<{ day: string; utm_source: string; source: string; n: number }>> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const acc = new Map<string, { day: string; utm_source: string; source: string; n: number }>();
    for (const c of mem.contacts.values()) {
      if ((c.tenant_id || "default") !== tenantId || c.created_at < sinceMs || c.created_at > untilMs) continue;
      const day = dashDayKey(c.created_at, tz);
      const k = `${day}|${c.utm_source || ""}|${c.source || ""}`;
      const row = acc.get(k) || { day, utm_source: c.utm_source || "", source: c.source || "", n: 0 };
      row.n++;
      acc.set(k, row);
    }
    return [...acc.values()];
  }
  const r = await pool.query(
    `SELECT to_char(created_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, utm_source, source, count(*)::int AS n
       FROM app_contacts
      WHERE tenant_id=$1 AND created_at >= to_timestamp($2/1000.0) AND created_at <= to_timestamp($3/1000.0)
      GROUP BY 1, 2, 3`,
    [tenantId, sinceMs, untilMs, tz],
  );
  return r.rows.map((x: any) => ({ day: String(x.day), utm_source: x.utm_source || "", source: x.source || "", n: Number(x.n) || 0 }));
}

/** CANAL-COHERENTE-1 · personas que se registraron en una web (app_sio_leads) en el rango: una
 *  fila por persona (el email; sin email, la ficha de systeme.io) con su primer registro del
 *  rango y la ficha MÁS ANTIGUA del panel con ese email, si la hay. Con eso el endpoint decide
 *  si cuenta en Web y si es alguien nuevo para «Todos» (dashRegistroCuenta en admin.ts).
 *  CONTACTOS-ORIGEN-1 · `utm` es el utm_source de ese primer registro: el enlace etiquetado que
 *  la trajo a la web, su primera fuente si es nueva (vacío = desconocida).
 *  ORIGEN-VISITA-1 · sin utm, la plataforma de la visita de quien rellenó el formulario
 *  (app_sio_leads.origen_visita), que platformOf clasifica igual que un utm_source. */
export type DashRegistroWeb = {
  day: string; key: string; at: number; account_id: string; email: string; utm: string;
  c_source: string; c_utm: string; c_created: number | null; c_name: string; c_phone: string;
};
export async function dbDashWebRegsDaily(sinceMs: number, untilMs: number, tz: string): Promise<DashRegistroWeb[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const fichas = new Map<string, Contact>();
    for (const c of mem.contacts.values()) {
      const em = String(c.email || "").trim().toLowerCase();
      if ((c.tenant_id || "default") !== tenantId || !em) continue;
      const ya = fichas.get(em);
      if (!ya || c.created_at < ya.created_at) fichas.set(em, c);
    }
    const porPersona = new Map<string, SioLead>();
    for (const l of mem.sioLeads.values()) {
      const at = Number(l.registered_at) || 0;
      if ((l.tenant_id || "default") !== tenantId || !at || at < sinceMs || at > untilMs) continue;
      const k = String(l.email || "").trim().toLowerCase() || `${l.account_id}:${l.sio_contact_id}`;
      const ya = porPersona.get(k);
      if (!ya || at < Number(ya.registered_at)) porPersona.set(k, l);
    }
    return [...porPersona.entries()].map(([k, l]) => {
      const c = l.email ? fichas.get(String(l.email).trim().toLowerCase()) : undefined;
      return {
        day: dashDayKey(Number(l.registered_at), tz), key: k, at: Number(l.registered_at), account_id: l.account_id, email: l.email || "",
        utm: l.utm_source || (l.origen_visita !== "ninguno" ? l.origen_visita || "" : ""),
        c_source: c?.source || "", c_utm: c?.utm_source || "", c_created: c ? c.created_at : null, c_name: c?.name || "", c_phone: c?.phone || "",
      };
    });
  }
  const r = await pool.query(
    `WITH reg AS (
       SELECT DISTINCT ON (k) k, account_id, email, registered_at, utm_source FROM (
         SELECT COALESCE(NULLIF(lower(trim(email)),''), account_id || ':' || sio_contact_id) AS k, account_id, email, registered_at,
                COALESCE(NULLIF(utm_source,''), NULLIF(origen_visita,'ninguno'), '') AS utm_source
           FROM app_sio_leads
          WHERE tenant_id=$1 AND registered_at >= to_timestamp($2/1000.0) AND registered_at <= to_timestamp($3/1000.0)) x
        ORDER BY k, registered_at),
     ficha AS (
       SELECT DISTINCT ON (lower(trim(email))) lower(trim(email)) AS em, source, utm_source, name, phone, created_at
         FROM app_contacts WHERE tenant_id=$1 AND COALESCE(email,'') <> ''
        ORDER BY lower(trim(email)), created_at)
     SELECT to_char(reg.registered_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, reg.k, reg.account_id, reg.email,
            extract(epoch from reg.registered_at)*1000 AS at, COALESCE(reg.utm_source,'') AS utm,
            COALESCE(f.source,'') AS c_source, COALESCE(f.utm_source,'') AS c_utm,
            extract(epoch from f.created_at)*1000 AS c_created, COALESCE(f.name,'') AS c_name, COALESCE(f.phone,'') AS c_phone
       FROM reg LEFT JOIN ficha f ON reg.email <> '' AND f.em = lower(trim(reg.email))`,
    [tenantId, sinceMs, untilMs, tz],
  );
  return r.rows.map((x: any) => ({
    day: String(x.day), key: String(x.k), at: Number(x.at) || 0, account_id: String(x.account_id || ""), email: String(x.email || ""),
    utm: String(x.utm || ""),
    c_source: String(x.c_source || ""), c_utm: String(x.c_utm || ""), c_created: x.c_created == null ? null : Number(x.c_created),
    c_name: String(x.c_name || ""), c_phone: String(x.c_phone || ""),
  }));
}

/** CANAL-COHERENTE-1 · las combinaciones (source, utm_source) que existen en las fichas del
 *  workspace: el endpoint las clasifica por canal y filtra la Actividad en vivo en SQL. */
export async function dbDashOrigenes(): Promise<Array<[string, string]>> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const s = new Set<string>();
    for (const c of mem.contacts.values()) if ((c.tenant_id || "default") === tenantId) s.add(JSON.stringify([c.source || "", c.utm_source || ""]));
    return [...s].map((x) => JSON.parse(x) as [string, string]);
  }
  const r = await pool.query(
    `SELECT DISTINCT COALESCE(source,'') AS s, COALESCE(utm_source,'') AS u FROM app_contacts WHERE tenant_id=$1`,
    [tenantId],
  );
  return r.rows.map((x: any) => [String(x.s), String(x.u)] as [string, string]);
}

/** CANAL-COHERENTE-1 · los contactos creados en el rango, uno a uno, para el detalle de
 *  «Contactos nuevos» (la misma cuenta que dbDashLeadsDaily, fila a fila).
 *  CONTACTOS-ORIGEN-1 · el canal y la barra pulsada llegan como combinaciones (source, utm_source)
 *  y se filtran en la SQL, igual que la Actividad en vivo; `total` y `equipo` son un COUNT y el
 *  LIMIT sólo acota las filas que se pintan. Filtrando en JS sobre las 5000 más recientes, con más
 *  fichas en el rango la barra decía 3 y su detalle 0. pares null = todas menos las del equipo. */
export async function dbDashLeadsFilas(sinceMs: number, untilMs: number, filtro: { pares: Array<[string, string]> | null; excluir: string[] }, limit = 3000): Promise<{
  total: number; equipo: number;
  filas: Array<{ phone: string; name: string; email: string; source: string; utm_source: string; created_at: number }>;
}> {
  const tenantId = currentWorkspaceId();
  const pares = filtro.pares;
  const excluir = filtro.excluir.map((x) => String(x).toLowerCase());
  const lim = Math.max(1, Math.min(5000, Math.floor(Number(limit)) || 3000));
  if (!pool) {
    const casa = new Set((pares || []).map((p) => JSON.stringify(p)));
    const esEquipo = (c: Contact) => excluir.includes(String(c.source || "").toLowerCase());
    const delRango = [...mem.contacts.values()]
      .filter((c) => (c.tenant_id || "default") === tenantId && c.created_at >= sinceMs && c.created_at <= untilMs);
    const suyas = delRango.filter((c) => !esEquipo(c) && (!pares || casa.has(JSON.stringify([c.source || "", c.utm_source || ""]))));
    return {
      total: suyas.length, equipo: delRango.filter(esEquipo).length,
      filas: suyas.sort((a, b) => b.created_at - a.created_at).slice(0, lim)
        .map((c) => ({ phone: c.phone, name: c.name || "", email: c.email || "", source: c.source || "", utm_source: c.utm_source || "", created_at: c.created_at })),
    };
  }
  const enRango = `FROM app_contacts WHERE tenant_id=$1 AND created_at >= to_timestamp($2/1000.0) AND created_at <= to_timestamp($3/1000.0)`;
  const delEquipo = `lower(COALESCE(source,'')) = ANY($4::text[])`;
  const suya = `NOT (${delEquipo})` + (pares
    ? ` AND (COALESCE(source,''), COALESCE(utm_source,'')) IN (SELECT u.s, u.m FROM unnest($5::text[], $6::text[]) AS u(s, m))` : "");
  const args: unknown[] = [tenantId, sinceMs, untilMs, excluir, ...(pares ? [pares.map((p) => p[0]), pares.map((p) => p[1])] : [])];
  const [rn, rf] = await Promise.all([
    pool.query(`SELECT count(*) FILTER (WHERE ${suya}) AS total, count(*) FILTER (WHERE ${delEquipo}) AS equipo ${enRango}`, args),
    pool.query(
      `SELECT phone, name, email, source, utm_source, extract(epoch from created_at)*1000 AS created_at
         ${enRango} AND ${suya} ORDER BY created_at DESC LIMIT $${args.length + 1}`,
      [...args, lim],
    ),
  ]);
  return {
    total: Number(rn.rows[0]?.total) || 0, equipo: Number(rn.rows[0]?.equipo) || 0,
    filas: rf.rows.map((x: any) => ({
      phone: x.phone, name: x.name || "", email: x.email || "", source: x.source || "",
      utm_source: x.utm_source || "", created_at: Number(x.created_at) || 0,
    })),
  };
}

/** COMPRAS-CONTACTO-1 · una compra del panel ya contada en la web, por CUALQUIER vía: el enlace de
 *  pago del panel también se paga en un checkout de systeme.io (purchase-guard lo detecta por la
 *  etiqueta, sin importe), así que con la web conectada esa venta ya está en la copia — y con el importe. */
const SQL_COMPRA_YA_EN_LA_WEB = `EXISTS (
  SELECT 1 FROM app_sio_sales s
   WHERE s.tenant_id = p.tenant_id AND s.kind = 'sale' AND s.paid_at IS NOT NULL AND s.email <> ''
     AND lower(s.email) = lower(c.email)
     AND s.paid_at BETWEEN p.created_at - interval '3 days' AND p.created_at + interval '3 days')`;
/** VENTAS-WEB-1 · una compra del panel que ya está en la copia de las ventas de systeme.io (mismo
 *  email, ±3 días) es la MISMA venta: no se suma dos veces. MET-WEB-07-FIN · antes sólo se descartaba
 *  si llegó por el webhook de ventas, así que Resumen sumaba dos veces la compra de un enlace de pago
 *  cobrada en systeme.io, que flujos, ficha y origen ya contaban una. Una sola regla para todos. */
const SQL_COMPRA_REPETIDA = SQL_COMPRA_YA_EN_LA_WEB;

/** VENTA-CANAL-1 · la ficha del comprador de una venta de la web (alias `s`, app_sio_sales), con la
 *  regla de IDENTIDAD-COMUN-1. Antes sólo se buscaba por el correo: quien llegó por un DM de
 *  Instagram y pagó con un correo que nunca nos dio salía como «web», sin nombre y sin ficha que
 *  abrir, aunque su registro en esa web trajera la marca lmc_ que /r/ le puso en el enlace del DM.
 *  Por orden: 1) la ficha con su correo; 2) la de la marca lmc_ de su registro en esa web
 *  (app_sio_leads.source_url → app_visit_refs, unión «enlace»); 3) sin ficha, el utm_source de ese
 *  registro, que da el canal pero no la persona. Devuelve name, phone, source, utm_source, avatar_url. */
const SQL_FICHA_VENTA_SIO = `LEFT JOIN LATERAL (
  SELECT f.name, f.phone, f.source, f.utm_source, f.avatar_url FROM (
    SELECT x.name, x.phone, x.source, x.utm_source, x.avatar_url, 0 AS pri, x.created_at FROM app_contacts x
     WHERE x.tenant_id = s.tenant_id AND s.email <> '' AND lower(x.email) = lower(s.email)
    UNION ALL
    SELECT x.name, x.phone, x.source, x.utm_source, x.avatar_url, 1, x.created_at FROM app_sio_leads l
      JOIN app_visit_refs v ON v.tenant_id = l.tenant_id AND v.token = substring(l.source_url from 'lmc_[A-Za-z0-9_-]+')
      JOIN app_contacts x ON x.tenant_id = l.tenant_id AND x.phone IN (v.phone, '+' || v.phone)
     WHERE l.tenant_id = s.tenant_id AND l.account_id = s.account_id AND s.email <> '' AND lower(l.email) = lower(s.email)
    UNION ALL
    SELECT '', '', '', l.utm_source, '', 2, l.registered_at FROM app_sio_leads l
     WHERE l.tenant_id = s.tenant_id AND l.account_id = s.account_id AND s.email <> '' AND lower(l.email) = lower(s.email)
       AND l.utm_source <> ''
  ) f ORDER BY f.pri,
    -- VENTA-NOMBRE-1 · con varias fichas del mismo correo manda la que es una persona: no la alta del equipo
    -- (panel/import/leadfinder) y con nombre; la importada después sin nombre ni origen ya no tapa al lead de Instagram.
    (lower(COALESCE(f.source,'')) IN ('panel','import','leadfinder')), (COALESCE(f.name,'') = ''),
    f.created_at ASC NULLS LAST LIMIT 1) c ON true`;

/** Ventas por día, producto y moneda, con el origen del contacto que compró (para el
 *  filtro por canal). Sólo Postgres: registrarCompra no guarda nada en modo memoria. */
export async function dbDashPurchasesDaily(
  sinceMs: number,
  untilMs: number,
  tz: string,
): Promise<Array<{ day: string; product_id: string; currency: string; utm_source: string; source: string; n: number; amount: number }>> {
  if (!pool) return [];
  const tenantId = currentWorkspaceId();
  const r = await pool.query(
    `SELECT to_char(p.created_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, p.product_id, lower(p.currency) AS currency,
            COALESCE(c.utm_source,'') AS utm_source, COALESCE(c.source,'') AS source,
            count(*)::int AS n, COALESCE(sum((COALESCE(p.amount,0) - LEAST(COALESCE(p.amount,0), COALESCE(p.refunded_amount,0)))),0)::float8 AS amount
       FROM app_purchases p
       LEFT JOIN app_contacts c ON c.tenant_id=p.tenant_id AND c.phone=p.phone
      WHERE NOT (p.refunded_amount IS NOT NULL AND p.refunded_amount >= p.amount) AND p.tenant_id=$1 AND p.created_at >= to_timestamp($2/1000.0) AND p.created_at <= to_timestamp($3/1000.0)
        AND NOT (${SQL_COMPRA_REPETIDA})
      GROUP BY 1, 2, 3, 4, 5`,
    [tenantId, sinceMs, untilMs, tz],
  );
  return r.rows.map((x: any) => ({
    day: String(x.day),
    product_id: x.product_id || "",
    currency: x.currency || "",
    utm_source: x.utm_source || "",
    source: x.source || "",
    n: Number(x.n) || 0,
    amount: Number(x.amount) || 0,
  }));
}

/** VENTAS-WEB-1 · ventas y devoluciones de las webs de systeme.io (app_sio_sales) por día, web,
 *  producto y moneda, con el origen del contacto que tiene ese email (para el filtro por canal). */
export async function dbDashSioSalesDaily(sinceMs: number, untilMs: number, tz: string): Promise<Array<{
  day: string; account_id: string; currency: string; product: string; kind: "sale" | "refund";
  utm_source: string; source: string; n: number; amount: number;
}>> {
  if (!pool) return [];
  const tenantId = currentWorkspaceId();
  const r = await pool.query(
    `SELECT to_char(s.paid_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, s.account_id, lower(s.currency) AS currency,
            COALESCE(s.product,'') AS product, s.kind,
            COALESCE(c.utm_source,'') AS utm_source, COALESCE(c.source,'') AS source,
            count(*)::int AS n, COALESCE(sum(s.amount),0)::float8 AS amount
       FROM app_sio_sales s
       ${SQL_FICHA_VENTA_SIO}
      WHERE s.tenant_id=$1 AND s.paid_at IS NOT NULL
        AND s.paid_at >= to_timestamp($2/1000.0) AND s.paid_at <= to_timestamp($3/1000.0)
      GROUP BY 1, 2, 3, 4, 5, 6, 7`,
    [tenantId, sinceMs, untilMs, tz],
  );
  return r.rows.map((x: any) => ({
    day: String(x.day), account_id: String(x.account_id || ""), currency: String(x.currency || ""),
    product: String(x.product || ""), kind: x.kind === "refund" ? "refund" : "sale",
    utm_source: String(x.utm_source || ""), source: String(x.source || ""),
    n: Number(x.n) || 0, amount: Number(x.amount) || 0,
  }));
}

/** CANAL-COHERENTE-1 · las ventas del rango una a una (enlaces de pago del panel y webs de
 *  systeme.io, devoluciones incluidas) para el detalle de la tarjeta «Ventas». Mismas
 *  condiciones que dbDashPurchasesDaily y dbDashSioSalesDaily, fila a fila. */
export async function dbDashVentasFilas(sinceMs: number, untilMs: number, limit = 5000): Promise<{
  panel: Array<{ at: number; product_id: string; currency: string; amount: number; phone: string; name: string; email: string; source: string; utm_source: string }>;
  sio: Array<{ at: number; account_id: string; product: string; kind: "sale" | "refund"; currency: string; amount: number; phone: string; name: string; email: string; source: string; utm_source: string }>;
}> {
  if (!pool) return { panel: [], sio: [] };
  const tenantId = currentWorkspaceId();
  const [rp, rs] = await Promise.all([
    pool.query(
      `SELECT extract(epoch from p.created_at)*1000 AS at, p.product_id, lower(p.currency) AS currency, (COALESCE(p.amount,0) - LEAST(COALESCE(p.amount,0), COALESCE(p.refunded_amount,0)))::float8 AS amount,
              p.phone, COALESCE(c.name,'') AS name, COALESCE(c.email,'') AS email,
              COALESCE(c.source,'') AS source, COALESCE(c.utm_source,'') AS utm_source
         FROM app_purchases p
         LEFT JOIN app_contacts c ON c.tenant_id=p.tenant_id AND c.phone=p.phone
        WHERE NOT (p.refunded_amount IS NOT NULL AND p.refunded_amount >= p.amount) AND p.tenant_id=$1 AND p.created_at >= to_timestamp($2/1000.0) AND p.created_at <= to_timestamp($3/1000.0)
          AND NOT (${SQL_COMPRA_REPETIDA})
        ORDER BY p.created_at DESC LIMIT $4`,
      [tenantId, sinceMs, untilMs, limit],
    ),
    pool.query(
      `SELECT extract(epoch from s.paid_at)*1000 AS at, s.account_id, COALESCE(s.product,'') AS product, s.kind,
              lower(s.currency) AS currency, s.amount::float8 AS amount, s.email,
              COALESCE(c.name,'') AS name, COALESCE(c.phone,'') AS phone,
              COALESCE(c.source,'') AS source, COALESCE(c.utm_source,'') AS utm_source
         FROM app_sio_sales s
         ${SQL_FICHA_VENTA_SIO}
        WHERE s.tenant_id=$1 AND s.paid_at IS NOT NULL
          AND s.paid_at >= to_timestamp($2/1000.0) AND s.paid_at <= to_timestamp($3/1000.0)
        ORDER BY s.paid_at DESC LIMIT $4`,
      [tenantId, sinceMs, untilMs, limit],
    ),
  ]);
  return {
    panel: rp.rows.map((x: any) => ({
      at: Number(x.at) || 0, product_id: x.product_id || "", currency: x.currency || "", amount: Number(x.amount) || 0,
      phone: x.phone || "", name: x.name || "", email: x.email || "", source: x.source || "", utm_source: x.utm_source || "",
    })),
    sio: rs.rows.map((x: any) => ({
      at: Number(x.at) || 0, account_id: String(x.account_id || ""), product: x.product || "", kind: x.kind === "refund" ? "refund" : "sale",
      currency: x.currency || "", amount: Number(x.amount) || 0, phone: x.phone || "", name: x.name || "", email: x.email || "",
      source: x.source || "", utm_source: x.utm_source || "",
    })),
  };
}

/** COMPRAS-CONTACTO-1 · una compra de una persona, venga de donde venga. */
export interface CompraDeContacto {
  phone: string; at: number;
  /** Identidad de la venta: 'panel:<id>' o 'web:<cuenta>:<transacción>'. Dos fichas con el mismo
   *  email ven la misma venta web: al sumar entre personas se cuenta una vez por `ref`. */
  ref: string;
  /** 'panel' = enlace de pago o webhook de ventas (app_purchases) · 'web' = copia de las ventas de systeme.io. */
  origen: "panel" | "web";
  product_id: string; account_id: string; product: string;
  kind: "sale" | "refund"; currency: string;
  /** 0 = la venta no trajo importe (enlace de pago detectado por la etiqueta). */
  amount: number;
}
/** COMPRAS-CONTACTO-1 · lo que han comprado estas personas, fila a fila y lo último primero: lo
 *  registrado por el panel (enlace de pago, webhook de ventas: por teléfono) y las ventas y
 *  devoluciones de las webs de systeme.io (por el email de la ficha). Una compra del panel que ya
 *  está en la copia de las webs es la misma venta y sale una vez, con el importe de la web.
 *  Sólo Postgres: en modo memoria no se guardan ventas. */
export async function dbComprasFilasDeContactos(phones: string[], limit = 5000): Promise<CompraDeContacto[]> {
  const ps = [...new Set(phones.filter(Boolean))];
  if (!pool || !ps.length) return [];
  const tenantId = currentWorkspaceId();
  try {
    const [rp, rs] = await Promise.all([
      pool.query(
        `SELECT p.id, p.phone, extract(epoch from p.created_at)*1000 AS at, p.product_id,
                lower(p.currency) AS currency, (COALESCE(p.amount,0) - LEAST(COALESCE(p.amount,0), COALESCE(p.refunded_amount,0)))::float8 AS amount
           FROM app_purchases p
           LEFT JOIN app_contacts c ON c.tenant_id=p.tenant_id AND c.phone=p.phone
          WHERE NOT (p.refunded_amount IS NOT NULL AND p.refunded_amount >= p.amount) AND p.tenant_id=$1 AND p.phone = ANY($2::text[]) AND NOT (${SQL_COMPRA_YA_EN_LA_WEB})
          ORDER BY p.created_at DESC LIMIT $3`,
        [tenantId, ps, limit],
      ),
      pool.query(
        `SELECT c.phone, s.account_id, s.tx_id, extract(epoch from s.paid_at)*1000 AS at, COALESCE(s.product,'') AS product,
                s.kind, lower(s.currency) AS currency, COALESCE(s.amount,0)::float8 AS amount
           FROM app_contacts c
           JOIN app_sio_sales s ON s.tenant_id=c.tenant_id AND s.email<>'' AND lower(s.email)=lower(c.email)
          WHERE c.tenant_id=$1 AND c.phone = ANY($2::text[]) AND c.email<>'' AND s.paid_at IS NOT NULL
          ORDER BY s.paid_at DESC LIMIT $3`,
        [tenantId, ps, limit],
      ),
    ]);
    const out: CompraDeContacto[] = [
      ...rp.rows.map((x: any): CompraDeContacto => ({
        phone: String(x.phone || ""), at: Number(x.at) || 0, ref: "panel:" + x.id, origen: "panel",
        product_id: String(x.product_id || ""), account_id: "", product: "", kind: "sale",
        currency: String(x.currency || ""), amount: Number(x.amount) || 0,
      })),
      ...rs.rows.map((x: any): CompraDeContacto => ({
        phone: String(x.phone || ""), at: Number(x.at) || 0, ref: "web:" + x.account_id + ":" + x.tx_id, origen: "web",
        product_id: "", account_id: String(x.account_id || ""), product: String(x.product || ""),
        kind: x.kind === "refund" ? "refund" : "sale", currency: String(x.currency || ""), amount: Number(x.amount) || 0,
      })),
    ];
    return out.sort((a, b) => b.at - a.at);
  } catch (e) {
    console.warn("[compras] contactos:", (e as Error).message);
    return [];
  }
}

/** TIEMPO-COMPRA-1 (MET-LEADS-02) · lo primero que sabemos de cada ficha, por tres caminos: el
 *  alta en el CRM, su primer registro en una web de systeme.io (por el email) y su primer mensaje
 *  guardado. El mensaje solo cuenta si la conversación está entera: en el tope de turnos guardados
 *  (MAX_GUARDADO de memory.ts) ya perdió los primeros, y un turno sin fecha deja el primero sin
 *  saber. Sólo Postgres. */
export interface InicioDeContacto { phone: string; name: string; email: string; source: string; alta: number; registro: number; mensaje: number }
export async function dbIniciosDeContactos(phones: string[], topeTurnos: number): Promise<InicioDeContacto[]> {
  const ps = [...new Set(phones.filter(Boolean))];
  if (!pool || !ps.length) return [];
  const tenantId = currentWorkspaceId();
  try {
    const r = await pool.query(
      `WITH cs AS (
         SELECT phone, name, email, source, created_at FROM app_contacts WHERE tenant_id=$1 AND phone = ANY($2::text[])
       ), reg AS (
         SELECT lower(l.email) AS em, min(l.registered_at) AS r
           FROM app_sio_leads l
          WHERE l.tenant_id=$1 AND l.email<>'' AND l.registered_at IS NOT NULL
            AND lower(l.email) IN (SELECT lower(email) FROM cs WHERE email<>'')
          GROUP BY 1
       ), msg AS (
         SELECT v.user_id AS phone,
                CASE WHEN bool_and((CASE WHEN jsonb_typeof(t->'at')='number' THEN (t->>'at')::float8 ELSE 0 END) > 1e12)
                     THEN min(CASE WHEN jsonb_typeof(t->'at')='number' THEN (t->>'at')::float8 END) END AS m
           FROM app_conversations v
           CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.turns)='array' THEN v.turns ELSE '[]'::jsonb END) t
          WHERE v.tenant_id=$1 AND v.user_id = ANY($2::text[])
            AND (CASE WHEN jsonb_typeof(v.turns)='array' THEN jsonb_array_length(v.turns) ELSE 0 END) < $3
            AND t->>'role' = 'user'
          GROUP BY v.user_id
       )
       SELECT cs.phone, cs.name, cs.email, cs.source, extract(epoch from cs.created_at)*1000 AS alta,
              extract(epoch from reg.r)*1000 AS registro, msg.m AS mensaje
         FROM cs
         LEFT JOIN reg ON cs.email<>'' AND reg.em = lower(cs.email)
         LEFT JOIN msg ON msg.phone = cs.phone`,
      [tenantId, ps, topeTurnos],
    );
    return r.rows.map((x: any): InicioDeContacto => ({
      phone: String(x.phone || ""), name: String(x.name || ""), email: String(x.email || ""), source: String(x.source || ""),
      alta: Number(x.alta) || 0, registro: Number(x.registro) || 0, mensaje: Number(x.mensaje) || 0,
    }));
  } catch (e) {
    console.warn("[tiempo-compra] inicios:", (e as Error).message);
    return [];
  }
}
/** TIEMPO-COMPRA-1 · compradores de las webs que no tienen ficha (ninguna con su email): todas sus
 *  ventas, la primera incluida aunque sea de otro periodo, y su primer registro en una web. */
export async function dbComprasWebPorEmail(emails: string[], limit = 50000): Promise<Array<{ email: string; registro: number; compras: CompraDeContacto[] }>> {
  const es = [...new Set(emails.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  if (!pool || !es.length) return [];
  const tenantId = currentWorkspaceId();
  try {
    const [rs, rr] = await Promise.all([
      pool.query(
        `SELECT lower(s.email) AS em, s.account_id, s.tx_id, extract(epoch from s.paid_at)*1000 AS at, COALESCE(s.product,'') AS product,
                s.kind, lower(s.currency) AS currency, COALESCE(s.amount,0)::float8 AS amount
           FROM app_sio_sales s
          WHERE s.tenant_id=$1 AND s.email<>'' AND lower(s.email) = ANY($2::text[]) AND s.paid_at IS NOT NULL
          ORDER BY s.paid_at ASC LIMIT $3`,
        [tenantId, es, limit],
      ),
      pool.query(
        `SELECT lower(l.email) AS em, extract(epoch from min(l.registered_at))*1000 AS r
           FROM app_sio_leads l
          WHERE l.tenant_id=$1 AND l.email<>'' AND l.registered_at IS NOT NULL AND lower(l.email) = ANY($2::text[])
          GROUP BY 1`,
        [tenantId, es],
      ),
    ]);
    const out = new Map<string, { email: string; registro: number; compras: CompraDeContacto[] }>();
    for (const e of es) out.set(e, { email: e, registro: 0, compras: [] });
    for (const x of rr.rows) { const o = out.get(String(x.em)); if (o) o.registro = Number(x.r) || 0; }
    for (const x of rs.rows) {
      const o = out.get(String(x.em));
      if (!o) continue;
      o.compras.push({
        phone: "", at: Number(x.at) || 0, ref: "web:" + x.account_id + ":" + x.tx_id, origen: "web",
        product_id: "", account_id: String(x.account_id || ""), product: String(x.product || ""),
        kind: x.kind === "refund" ? "refund" : "sale", currency: String(x.currency || ""), amount: Number(x.amount) || 0,
      });
    }
    return [...out.values()];
  } catch (e) {
    console.warn("[tiempo-compra] web:", (e as Error).message);
    return [];
  }
}

/** ACCIONES-COMPRA-1 (MET-LEADS-03) · lo verificable que hizo cada persona, fila a fila y con su fecha:
 *  mensajes suyos (con el nº de turnos guardados y cuántos no traen fecha, para saber si la
 *  conversación está entera), comentarios que activaron un flujo, clics en enlaces del panel, visitas
 *  a páginas con ficha, registros en tus webs o formularios y reservas. Siempre acotado al workspace.
 *  Sólo Postgres: en modo memoria no se guardan y todo sale vacío. */
export interface AccionesPrevias {
  conv: Array<{ phone: string; turnos: number; sinFecha: number; ats: number[] }>;
  comentarios: Array<{ phone: string; at: number }>;
  visitas: Array<{ phone: string; at: number }>;
  registros: Array<{ email: string; phone: string; at: number }>;
  reservas: Array<{ email: string; at: number }>;
}
export async function dbAccionesPrevias(phones: string[], emails: string[]): Promise<AccionesPrevias> {
  const vacio: AccionesPrevias = { conv: [], comentarios: [], visitas: [], registros: [], reservas: [] };
  const ps = [...new Set(phones.filter(Boolean))];
  const es = [...new Set(emails.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  if (!pool || (!ps.length && !es.length)) return vacio;
  const tenantId = currentWorkspaceId();
  const num = (v: unknown) => Number(v) || 0;
  try {
    const [rc, rm, rcl, rpv, rl, rf, rb] = await Promise.all([
      pool.query(
        `SELECT v.user_id AS phone,
                (CASE WHEN jsonb_typeof(v.turns)='array' THEN jsonb_array_length(v.turns) ELSE 0 END)::int AS turnos,
                x.sinfecha, x.ats
           FROM app_conversations v
           CROSS JOIN LATERAL (
             SELECT (count(*) FILTER (WHERE s.a IS NULL OR s.a <= 1e12))::int AS sinfecha,
                    COALESCE(array_agg(s.a ORDER BY s.a) FILTER (WHERE s.a > 1e12), '{}'::float8[]) AS ats
               FROM (SELECT CASE WHEN jsonb_typeof(t->'at')='number' THEN (t->>'at')::float8 END AS a
                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.turns)='array' THEN v.turns ELSE '[]'::jsonb END) t
                      WHERE t->>'role'='user') s
           ) x
          WHERE v.tenant_id=$1 AND v.user_id = ANY($2::text[])`,
        [tenantId, ps],
      ),
      pool.query(
        `SELECT phone, extract(epoch from at)*1000 AS at FROM app_flow_events
          WHERE tenant_id=$1 AND phone = ANY($2::text[]) AND event='entró' AND detail LIKE '%· comentario%' AND detail NOT LIKE 'PRUEBA%'`,
        [tenantId, ps],
      ),
      pool.query(
        `SELECT phone, extract(epoch from created_at)*1000 AS at FROM app_link_clicks
          WHERE tenant_id=$1 AND phone = ANY($2::text[])`,
        [tenantId, ps],
      ),
      pool.query(
        `SELECT contact AS phone, extract(epoch from created_at)*1000 AS at FROM app_page_views
          WHERE tenant_id=$1 AND event='' AND contact = ANY($2::text[])`,
        [tenantId, ps],
      ),
      es.length ? pool.query(
        `SELECT lower(email) AS email, extract(epoch from registered_at)*1000 AS at FROM app_sio_leads
          WHERE tenant_id=$1 AND email<>'' AND registered_at IS NOT NULL AND lower(email) = ANY($2::text[])`,
        [tenantId, es],
      ) : Promise.resolve({ rows: [] as any[] }),
      pool.query(
        `SELECT lower(email) AS email, phone, contact_id, extract(epoch from created_at)*1000 AS at FROM app_form_responses
          WHERE tenant_id=$1 AND (contact_id = ANY($2::text[]) OR phone = ANY($2::text[]) OR (email<>'' AND lower(email) = ANY($3::text[])))`,
        [tenantId, ps, es],
      ),
      es.length ? pool.query(
        `SELECT lower(email) AS email, extract(epoch from created_at)*1000 AS at FROM app_sio_bookings
          WHERE tenant_id=$1 AND email<>'' AND created_at IS NOT NULL AND lower(email) = ANY($2::text[])`,
        [tenantId, es],
      ) : Promise.resolve({ rows: [] as any[] }),
    ]);
    const pset = new Set(ps);
    return {
      conv: rc.rows.map((x: any) => ({ phone: String(x.phone || ""), turnos: num(x.turnos), sinFecha: num(x.sinfecha), ats: (x.ats || []).map(num) })),
      comentarios: rm.rows.map((x: any) => ({ phone: String(x.phone || ""), at: num(x.at) })),
      visitas: [
        ...rcl.rows.map((x: any) => ({ phone: String(x.phone || ""), at: num(x.at) })),
        ...rpv.rows.map((x: any) => ({ phone: String(x.phone || ""), at: num(x.at) })),
      ],
      registros: [
        ...rl.rows.map((x: any) => ({ email: String(x.email || ""), phone: "", at: num(x.at) })),
        ...rf.rows.map((x: any) => ({ email: String(x.email || ""), phone: pset.has(String(x.phone || "")) ? String(x.phone) : (pset.has(String(x.contact_id || "")) ? String(x.contact_id) : ""), at: num(x.at) })),
      ],
      reservas: rb.rows.map((x: any) => ({ email: String(x.email || ""), at: num(x.at) })),
    };
  } catch (e) {
    // Un fallo NO es «nadie hizo nada»: se propaga y la vista dice que no se pudo calcular.
    console.warn("[acciones-compra] lectura:", (e as Error).message);
    throw e;
  }
}

/** Mensajes de WhatsApp recibidos/enviados por día (todas las líneas del workspace). */
export async function dbDashWaDaily(
  sinceMs: number,
  untilMs: number,
  tz: string,
): Promise<Array<{ day: string; dir: "in" | "out"; n: number }>> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const acc = new Map<string, { day: string; dir: "in" | "out"; n: number }>();
    for (const e of mem.waEvents) {
      if (e.tenant_id !== tenantId || e.created_at < sinceMs || e.created_at > untilMs) continue;
      const day = dashDayKey(e.created_at, tz);
      const dir = e.direction === "in" ? "in" : "out";
      const row = acc.get(day + dir) || { day, dir, n: 0 };
      row.n++;
      acc.set(day + dir, row);
    }
    return [...acc.values()];
  }
  const r = await pool.query(
    `SELECT to_char(created_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, direction, count(*)::int AS n
       FROM app_wa_events
      WHERE tenant_id=$1 AND created_at >= to_timestamp($2/1000.0) AND created_at <= to_timestamp($3/1000.0)
      GROUP BY 1, 2`,
    [tenantId, sinceMs, untilMs, tz],
  );
  return r.rows.map((x: any) => ({ day: String(x.day), dir: x.direction === "in" ? "in" : "out", n: Number(x.n) || 0 }));
}

/** CANAL-COHERENTE-1 · qué entra en la Actividad en vivo. Antes se traían los N últimos de
 *  todo el workspace y el endpoint filtraba el canal DESPUÉS: con Instagram llenando los 80
 *  últimos, «Web» o «WhatsApp» salían vacíos aunque hubiera actividad. Ahora filtra la SQL. */
export type DashFeedFiltro = {
  /** null = todos los canales; si no, sólo las fichas con estas combinaciones (source, utm_source). */
  pares?: Array<[string, string]> | null;
  /** Orígenes de fichas que no son leads (las da de alta el equipo): fuera de la actividad. */
  excluir?: string[];
  /** Web: todas las ventas de las webs de systeme.io, sea cual sea el origen del comprador. */
  ventasWeb?: boolean;
  /** Los registros en las webs (app_sio_leads) como evento propio. */
  registros?: boolean;
  /** FEED-VENTANA-1 · periodo del Dashboard (epoch ms, ambos inclusive). Sin él, lo último de siempre. */
  desde?: number;
  hasta?: number;
};

/** Lo último que ha pasado: contactos nuevos, registros en la web y ventas, cada uno con su origen. */
export async function dbDashFeed(limit = 60, filtro: DashFeedFiltro = {}): Promise<{
  contacts: Array<{ phone: string; name: string; email: string; source: string; utm_source: string; avatar_url: string; created_at: number }>;
  purchases: Array<{ phone: string; name: string; product_id: string; currency: string; amount: number; source: string; utm_source: string; created_at: number }>;
  sio: Array<{ email: string; name: string; phone: string; product: string; currency: string; amount: number; account_id: string; source: string; utm_source: string; avatar_url: string; created_at: number }>;
  registros: Array<{ email: string; name: string; phone: string; avatar_url: string; account_id: string; created_at: number }>;
}> {
  const tenantId = currentWorkspaceId();
  const lim = Math.max(1, Math.min(200, Number(limit) || 60));
  const pares = filtro.pares ?? null;
  const excluir = (filtro.excluir || []).map((x) => String(x).toLowerCase());
  const nada = !!pares && !pares.length;
  // FEED-VENTANA-1 · el periodo se aplica en la SQL, antes del LIMIT: si se recortara después, un periodo
  // corto con mucha actividad dejaría fuera lo que sí cae dentro, y uno largo enseñaría lo de antes.
  const desde = Number(filtro.desde) > 0 ? Number(filtro.desde) : 0;
  const hasta = Number(filtro.hasta) > 0 ? Number(filtro.hasta) : 0;
  const enVentana = (ms: number) => (!desde || ms >= desde) && (!hasta || ms <= hasta);
  const ventana = (p: any[], col: string) => {
    let w = "";
    if (desde) { p.push(desde); w += ` AND ${col} >= to_timestamp($${p.length}::float8/1000.0)`; }
    if (hasta) { p.push(hasta); w += ` AND ${col} <= to_timestamp($${p.length}::float8/1000.0)`; }
    return w;
  };
  if (!pool) {
    const casa = new Set((pares || []).map((p) => JSON.stringify(p)));
    const contacts = nada ? [] : [...mem.contacts.values()]
      .filter((c) => (c.tenant_id || "default") === tenantId && !excluir.includes(String(c.source || "").toLowerCase())
        && (!pares || casa.has(JSON.stringify([c.source || "", c.utm_source || ""]))) && enVentana(c.created_at))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, lim)
      .map((c) => ({
        phone: c.phone, name: c.name || "", email: c.email || "", source: c.source || "",
        utm_source: c.utm_source || "", avatar_url: c.avatar_url || "", created_at: c.created_at,
      }));
    const registros = !filtro.registros ? [] : [...mem.sioLeads.values()]
      .filter((l) => (l.tenant_id || "default") === tenantId && Number(l.registered_at) > 0 && enVentana(Number(l.registered_at)))
      .sort((a, b) => Number(b.registered_at) - Number(a.registered_at))
      .slice(0, lim)
      .map((l) => {
        const em = String(l.email || "").trim().toLowerCase();
        const c = em ? [...mem.contacts.values()].filter((x) => (x.tenant_id || "default") === tenantId && String(x.email || "").trim().toLowerCase() === em)
          .sort((a, b) => a.created_at - b.created_at)[0] : undefined;
        return { email: l.email || "", name: c?.name || "", phone: c?.phone || "", avatar_url: c?.avatar_url || "", account_id: l.account_id, created_at: Number(l.registered_at) };
      });
    return { contacts, purchases: [], sio: [], registros };
  }
  // (source, utm_source) de la ficha en la lista del canal. $a y $b son los números de parámetro.
  const enPares = (alias: string, a: number, b: number) =>
    `(COALESCE(${alias}.source,''), COALESCE(${alias}.utm_source,'')) IN (SELECT u.s, u.m FROM unnest($${a}::text[], $${b}::text[]) AS u(s, m))`;
  const ps = (pares || []).map((p) => p[0]);
  const pu = (pares || []).map((p) => p[1]);
  const vacio = { rows: [] as any[] };
  const argC: any[] = pares ? [tenantId, lim, excluir, ps, pu] : [tenantId, lim, excluir];
  const winC = ventana(argC, "x.created_at");
  const argP: any[] = pares ? [tenantId, lim, ps, pu] : [tenantId, lim];
  const winP = ventana(argP, "p.created_at");
  const argS: any[] = pares && !filtro.ventasWeb ? [tenantId, lim, ps, pu] : [tenantId, lim];
  const winS = ventana(argS, "s.paid_at");
  const argR: any[] = [tenantId, lim];
  const winR = ventana(argR, "l.registered_at");
  const [rc, rp, rs, rr] = await Promise.all([
    nada ? vacio : pool.query(
      `SELECT phone, name, email, source, utm_source, avatar_url, extract(epoch from created_at)*1000 AS created_at
         FROM app_contacts x WHERE tenant_id=$1 AND NOT (lower(COALESCE(source,'')) = ANY($3::text[]))
          ${pares ? "AND " + enPares("x", 4, 5) : ""}${winC}
        ORDER BY created_at DESC LIMIT $2`,
      argC,
    ),
    nada ? vacio : pool.query(
      `SELECT p.phone, COALESCE(c.name,'') AS name, p.product_id, lower(p.currency) AS currency, (COALESCE(p.amount,0) - LEAST(COALESCE(p.amount,0), COALESCE(p.refunded_amount,0)))::float8 AS amount,
              COALESCE(c.source,'') AS source, COALESCE(c.utm_source,'') AS utm_source,
              extract(epoch from p.created_at)*1000 AS created_at
         FROM app_purchases p
         LEFT JOIN app_contacts c ON c.tenant_id=p.tenant_id AND c.phone=p.phone
        WHERE NOT (p.refunded_amount IS NOT NULL AND p.refunded_amount >= p.amount) AND p.tenant_id=$1 AND NOT (${SQL_COMPRA_REPETIDA}) ${pares ? "AND " + enPares("c", 3, 4) : ""}${winP}
        ORDER BY p.created_at DESC LIMIT $2`,
      argP,
    ),
    nada && !filtro.ventasWeb ? vacio : pool.query(
      `SELECT s.email, COALESCE(c.name,'') AS name, COALESCE(c.phone,'') AS phone, COALESCE(s.product,'') AS product,
              lower(s.currency) AS currency, s.amount::float8 AS amount, s.account_id,
              COALESCE(c.source,'') AS source, COALESCE(c.utm_source,'') AS utm_source, COALESCE(c.avatar_url,'') AS avatar_url,
              extract(epoch from s.paid_at)*1000 AS created_at
         FROM app_sio_sales s
         ${SQL_FICHA_VENTA_SIO}
        WHERE s.tenant_id=$1 AND s.kind='sale' AND s.paid_at IS NOT NULL
          ${pares && !filtro.ventasWeb ? "AND " + enPares("c", 3, 4) : ""}${winS}
        ORDER BY s.paid_at DESC LIMIT $2`,
      argS,
    ),
    !filtro.registros ? vacio : pool.query(
      `SELECT l.email, l.account_id, COALESCE(c.name,'') AS name, COALESCE(c.phone,'') AS phone, COALESCE(c.avatar_url,'') AS avatar_url,
              extract(epoch from l.registered_at)*1000 AS created_at
         FROM app_sio_leads l
         LEFT JOIN LATERAL (
           SELECT x.name, x.phone, x.avatar_url FROM app_contacts x
            WHERE x.tenant_id = l.tenant_id AND l.email <> '' AND lower(trim(x.email)) = lower(trim(l.email))
            ORDER BY x.created_at LIMIT 1) c ON true
        WHERE l.tenant_id=$1 AND l.registered_at IS NOT NULL${winR}
        ORDER BY l.registered_at DESC LIMIT $2`,
      argR,
    ),
  ]);
  return {
    contacts: rc.rows.map((x: any) => ({
      phone: x.phone, name: x.name || "", email: x.email || "", source: x.source || "",
      utm_source: x.utm_source || "", avatar_url: x.avatar_url || "", created_at: Number(x.created_at) || 0,
    })),
    purchases: rp.rows.map((x: any) => ({
      phone: x.phone, name: x.name || "", product_id: x.product_id || "", currency: x.currency || "",
      amount: Number(x.amount) || 0, source: x.source || "", utm_source: x.utm_source || "",
      created_at: Number(x.created_at) || 0,
    })),
    sio: rs.rows.map((x: any) => ({
      email: x.email || "", name: x.name || "", phone: x.phone || "", product: x.product || "",
      currency: x.currency || "", amount: Number(x.amount) || 0, account_id: x.account_id || "",
      source: x.source || "", utm_source: x.utm_source || "", avatar_url: x.avatar_url || "", created_at: Number(x.created_at) || 0,
    })),
    registros: rr.rows.map((x: any) => ({
      email: x.email || "", name: x.name || "", phone: x.phone || "", avatar_url: x.avatar_url || "",
      account_id: String(x.account_id || ""), created_at: Number(x.created_at) || 0,
    })),
  };
}

// ── MCP-1 · Claves de conexión de IA ────────────────────────────────────────
// Cada clave actúa COMO el usuario que la creó, DENTRO del workspace donde la creó.
// Se guarda solo el sha256: quien lea la base no puede usar las claves.
export interface McpKeyRec {
  id: string;
  tenant_id: string;
  user_uid: string;       // "env-admin" | "u:<id>" — el mismo uid que firma la sesión
  user_label: string;     // email/nombre de quien la creó, para el listado
  name: string;
  token_hash: string;
  prefix: string;         // primeros caracteres, para reconocerla en el listado
  scope: "lectura" | "completo";
  uses: number;
  created_at: number;
  last_used_at: number;   // 0 = nunca
  revoked_at: number;     // 0 = viva
  // MCP-2 · conexión por inicio de sesión (OAuth). Las claves de MCP-1 llevan via "clave" y 0.
  via: "clave" | "oauth";
  client_id: string;
  client_name: string;       // lo que la IA dice ser (p. ej. «Claude»), para el listado
  expires_at: number;        // 0 = no caduca (claves); el pase OAuth dura 1 h
  refresh_expires_at: number;
  refresh_hash?: string;     // solo en memoria y en las consultas internas: nunca sale al panel
  refresh_prev_hash?: string; // el pase de renovación ya rotado (detectar que alguien lo reutiliza)
}
const MCP_KEY_COLS = "id,tenant_id,user_uid,user_label,name,token_hash,prefix,scope,uses,via,client_id,client_name,"
  + " extract(epoch from created_at)*1000 created_at, coalesce(extract(epoch from last_used_at)*1000,0) last_used_at,"
  + " coalesce(extract(epoch from revoked_at)*1000,0) revoked_at,"
  + " coalesce(extract(epoch from expires_at)*1000,0) expires_at, coalesce(extract(epoch from refresh_expires_at)*1000,0) refresh_expires_at";
function rowToMcpKey(r: Record<string, unknown>): McpKeyRec {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id || "default"),
    user_uid: String(r.user_uid || ""),
    user_label: String(r.user_label ?? ""),
    name: String(r.name ?? ""),
    token_hash: String(r.token_hash || ""),
    prefix: String(r.prefix ?? ""),
    scope: r.scope === "lectura" ? "lectura" : "completo",
    uses: Number(r.uses) || 0,
    created_at: Number(r.created_at) || 0,
    last_used_at: Number(r.last_used_at) || 0,
    revoked_at: Number(r.revoked_at) || 0,
    via: r.via === "oauth" ? "oauth" : "clave",
    client_id: String(r.client_id ?? ""),
    client_name: String(r.client_name ?? ""),
    expires_at: Number(r.expires_at) || 0,
    refresh_expires_at: Number(r.refresh_expires_at) || 0,
  };
}
/** Una conexión cuenta como viva mientras no se desactive y, si es por inicio de sesión,
 *  mientras se pueda renovar (la IA la renueva sola cada hora). */
const mcpViva = (k: McpKeyRec, ahora = Date.now()) =>
  !k.revoked_at && (k.via !== "oauth" || k.refresh_expires_at > ahora);

/** Las claves vivas del workspace activo, la más nueva primero. */
export async function dbListMcpKeys(): Promise<McpKeyRec[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) return [...mem.mcpKeys.values()].filter((k) => k.tenant_id === tenantId && mcpViva(k)).sort((a, b) => b.created_at - a.created_at);
  const r = await pool.query(`SELECT ${MCP_KEY_COLS} FROM app_mcp_keys WHERE tenant_id=$1 AND revoked_at IS NULL AND (via<>'oauth' OR refresh_expires_at > now()) ORDER BY created_at DESC LIMIT 500`, [tenantId]);
  return r.rows.map(rowToMcpKey);
}

type McpKeyAlta = Omit<McpKeyRec, "tenant_id" | "uses" | "created_at" | "last_used_at" | "revoked_at" | "via" | "client_id" | "client_name" | "expires_at" | "refresh_expires_at">
  & Partial<Pick<McpKeyRec, "via" | "client_id" | "client_name" | "expires_at" | "refresh_expires_at" | "refresh_hash">>;
/** Alta en el workspace activo (el tenant de la fila lo pone el ámbito, no quien llama). */
export async function dbCreateMcpKey(k: McpKeyAlta): Promise<McpKeyRec> {
  const tenantId = currentWorkspaceId();
  const { refresh_hash, ...resto } = k;
  const rec: McpKeyRec = {
    ...resto, tenant_id: tenantId, uses: 0, created_at: Date.now(), last_used_at: 0, revoked_at: 0,
    via: k.via === "oauth" ? "oauth" : "clave", client_id: k.client_id || "", client_name: (k.client_name || "").slice(0, 80),
    expires_at: k.expires_at || 0, refresh_expires_at: k.refresh_expires_at || 0,
  };
  if (!pool) { mem.mcpKeys.set(rec.id, { ...rec, refresh_hash }); return rec; }
  const ts = (ms: number) => (ms ? new Date(ms).toISOString() : null);
  await pool.query(
    `INSERT INTO app_mcp_keys (id,tenant_id,user_uid,user_label,name,token_hash,prefix,scope,via,client_id,client_name,refresh_hash,expires_at,refresh_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [rec.id, tenantId, rec.user_uid, rec.user_label.slice(0, 200), rec.name.slice(0, 80), rec.token_hash, rec.prefix, rec.scope,
      rec.via, rec.client_id.slice(0, 2000), rec.client_name, refresh_hash || null, ts(rec.expires_at), ts(rec.refresh_expires_at)],
  );
  return rec;
}

/** MCP-2 · la IA renueva su pase: se busca por el hash del pase de renovación, EN TODA LA
 *  PLATAFORMA (como dbMcpKeyPorHash). Solo conexiones vivas y renovables. */
export async function dbMcpKeyPorRefresh(hash: string): Promise<McpKeyRec | null> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const ahora = Date.now();
  if (!pool) {
    const k = [...mem.mcpKeys.values()].find((x) => x.refresh_hash === hash);
    return k && k.via === "oauth" && mcpViva(k, ahora) ? { ...k, refresh_hash: undefined, refresh_prev_hash: undefined } : null;
  }
  const r = await pool.query(`SELECT ${MCP_KEY_COLS} FROM app_mcp_keys WHERE refresh_hash=$1 AND via='oauth' AND revoked_at IS NULL AND refresh_expires_at > now()`, [hash]);
  return r.rows.length ? rowToMcpKey(r.rows[0]) : null;
}

/** MCP-2 · rotación: pase y pase de renovación nuevos EN LA MISMA FILA. Atómica sobre el hash
 *  de renovación anterior: si dos renovaciones llegan a la vez, solo gana una. */
export async function dbRotarMcpKey(id: string, tenantId: string, refreshAnterior: string,
  n: { token_hash: string; prefix: string; refresh_hash: string; expires_at: number; refresh_expires_at: number }): Promise<boolean> {
  if (!pool) {
    const k = mem.mcpKeys.get(id);
    if (!k || k.tenant_id !== tenantId || k.refresh_hash !== refreshAnterior || !mcpViva(k)) return false;
    Object.assign(k, n, { refresh_prev_hash: refreshAnterior });
    return true;
  }
  const r = await pool.query(
    `UPDATE app_mcp_keys SET token_hash=$4, prefix=$5, refresh_hash=$6, expires_at=$7, refresh_expires_at=$8, refresh_prev_hash=$3
      WHERE id=$1 AND tenant_id=$2 AND refresh_hash=$3 AND revoked_at IS NULL AND refresh_expires_at > now()`,
    [id, tenantId, refreshAnterior, n.token_hash, n.prefix, n.refresh_hash, new Date(n.expires_at).toISOString(), new Date(n.refresh_expires_at).toISOString()],
  );
  return !!r.rowCount;
}

/** MCP-2 · detección de reutilización: la conexión viva cuyo pase de renovación ANTERIOR (ya
 *  rotado) es este. EN TODA LA PLATAFORMA, como dbMcpKeyPorRefresh; quien llama abre el
 *  ámbito del workspace de la fila para apagarla. Solo recuerda el inmediatamente anterior. */
export async function dbMcpKeyPorRefreshViejo(hash: string): Promise<McpKeyRec | null> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  if (!pool) {
    const k = [...mem.mcpKeys.values()].find((x) => x.refresh_prev_hash === hash);
    return k && k.via === "oauth" && !k.revoked_at ? { ...k, refresh_hash: undefined, refresh_prev_hash: undefined } : null;
  }
  const r = await pool.query(`SELECT ${MCP_KEY_COLS} FROM app_mcp_keys WHERE refresh_prev_hash=$1 AND via='oauth' AND revoked_at IS NULL`, [hash]);
  return r.rows.length ? rowToMcpKey(r.rows[0]) : null;
}

/** Revoca una clave del workspace activo. false si no existe en ESTE workspace. */
export async function dbRevokeMcpKey(id: string): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const k = mem.mcpKeys.get(id);
    if (!k || k.tenant_id !== tenantId || k.revoked_at) return false;
    k.revoked_at = Date.now();
    return true;
  }
  const r = await pool.query(`UPDATE app_mcp_keys SET revoked_at=now() WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL`, [id, tenantId]);
  return !!r.rowCount;
}

/** Al cambiar la contraseña de una persona caen sus sesiones del navegador: también sus
 *  conexiones de IA, en TODOS sus negocios (a propósito sin tenant: es la persona, no el
 *  negocio). Devuelve cuántas apagó. */
export async function dbRevokeMcpKeysDeUsuario(userUid: string): Promise<number> {
  if (!pool) {
    let n = 0;
    for (const k of mem.mcpKeys.values()) if (k.user_uid === userUid && !k.revoked_at) { k.revoked_at = Date.now(); n++; }
    return n;
  }
  const r = await pool.query(`UPDATE app_mcp_keys SET revoked_at=now() WHERE user_uid=$1 AND revoked_at IS NULL`, [userUid]);
  return r.rowCount || 0;
}

/** El servidor MCP: busca por hash EN TODA LA PLATAFORMA (como el slug de los
 *  formularios). Quien llama abre el ámbito del workspace de la fila. Solo vivas y, las de
 *  inicio de sesión, con el pase sin caducar. `conocida:true` devuelve también las muertas:
 *  el servidor distingue «pase caducado» (la IA lo renueva) de «clave que no existe». */
export async function dbMcpKeyPorHash(hash: string, o: { conocida?: boolean } = {}): Promise<McpKeyRec | null> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const valida = (k: McpKeyRec) => o.conocida || (!k.revoked_at && (!k.expires_at || k.expires_at > Date.now()));
  if (!pool) {
    const k = [...mem.mcpKeys.values()].find((x) => x.token_hash === hash);
    return k && valida(k) ? { ...k, refresh_hash: undefined, refresh_prev_hash: undefined } : null;
  }
  const r = await pool.query(`SELECT ${MCP_KEY_COLS} FROM app_mcp_keys WHERE token_hash=$1`
    + (o.conocida ? "" : " AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())"), [hash]);
  return r.rows.length ? rowToMcpKey(r.rows[0]) : null;
}

/** Último uso (para que el listado diga si la clave se está usando). */
export async function dbTouchMcpKey(id: string, tenantId: string): Promise<void> {
  if (!pool) {
    const k = mem.mcpKeys.get(id);
    if (k && k.tenant_id === tenantId) { k.uses++; k.last_used_at = Date.now(); }
    return;
  }
  await pool.query(`UPDATE app_mcp_keys SET uses=uses+1, last_used_at=now() WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
}

/* ───────────────────────── CAMPANAS-1 (MET-AUTO-01 · MET-AUTO-03 · MET-AUTO-04) ─────────────────────────
 * Campañas = grupos de flujos. Toda consulta va acotada por tenant (workspace). La regla de cálculo vive
 * en campanas.ts (módulo puro); aquí solo se guarda y se lee. En memoria (sin Postgres) las campañas se
 * guardan en un Map y no hay reservas ni compras: «sin medir». */
const memCampanas = new Map<string, CampanaDef[]>();
const msOrNull = (v: unknown): number | null => (v == null ? null : Number(v) || null);

export async function dbCampanasList(): Promise<CampanaDef[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) return [...(memCampanas.get(tenantId) || [])].sort((a, b) => b.createdAt - a.createdAt);
  const r = await pool.query(
    `SELECT id, name, offer, objective, extract(epoch from starts_at)*1000 starts_at, extract(epoch from ends_at)*1000 ends_at,
            flow_ids, extract(epoch from created_at)*1000 created_at
       FROM app_campaigns WHERE tenant_id=$1 ORDER BY created_at DESC, id LIMIT 500`,
    [tenantId],
  );
  return r.rows.map((x: any): CampanaDef => ({
    id: String(x.id), name: String(x.name), offer: String(x.offer || ""),
    objective: x.objective === "reserva" || x.objective === "compra" ? x.objective : "completar",
    startsAt: msOrNull(x.starts_at), endsAt: msOrNull(x.ends_at),
    flowIds: Array.isArray(x.flow_ids) ? x.flow_ids.map(String) : [],
    createdAt: Number(x.created_at) || 0,
  }));
}
/** Crea (id vacío o desconocido) o actualiza (id existente de ESTE workspace) una campaña. */
export async function dbCampanaGuardar(v: Omit<CampanaDef, "createdAt">): Promise<CampanaDef> {
  const tenantId = currentWorkspaceId();
  const existente = v.id ? (await dbCampanasList()).find((c) => c.id === v.id) : undefined;
  const id = existente ? existente.id : "cmp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const out: CampanaDef = { ...v, id, createdAt: existente ? existente.createdAt : Date.now() };
  if (!pool) {
    const l = (memCampanas.get(tenantId) || []).filter((c) => c.id !== id);
    l.push(out);
    memCampanas.set(tenantId, l);
    return out;
  }
  await pool.query(
    `INSERT INTO app_campaigns (tenant_id, id, name, offer, objective, starts_at, ends_at, flow_ids, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     ON CONFLICT (tenant_id, id) DO UPDATE SET name=EXCLUDED.name, offer=EXCLUDED.offer, objective=EXCLUDED.objective,
       starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at, flow_ids=EXCLUDED.flow_ids, updated_at=now()`,
    [tenantId, id, out.name, out.offer, out.objective, out.startsAt == null ? null : new Date(out.startsAt),
      out.endsAt == null ? null : new Date(out.endsAt), JSON.stringify(out.flowIds), new Date(out.createdAt)],
  );
  return out;
}
export async function dbCampanaBorrar(id: string): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const l = memCampanas.get(tenantId) || [];
    const n = l.filter((c) => c.id !== id);
    memCampanas.set(tenantId, n);
    return n.length !== l.length;
  }
  const r = await pool.query(`DELETE FROM app_campaigns WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  return (r.rowCount || 0) > 0;
}
/** Entradas y finales («entró» / «completó») de los flujos dados en la ventana, en orden de llegada. */
export async function dbCampanasEventos(flowIds: string[], sinceMs: number, untilMs: number, cap = 60000): Promise<EventoCampana[]> {
  if (!flowIds.length) return [];
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const ids = new Set(flowIds);
    return mem.flowEvents
      .filter((e) => e.tenant_id === tenantId && ids.has(e.flow_id) && (e.event === "entró" || e.event === "completó") && e.at >= sinceMs && e.at < untilMs)
      .sort((a, b) => a.at - b.at).slice(0, cap)
      .map((e) => ({ flow: e.flow_id, key: e.phone, event: e.event, at: e.at }));
  }
  const r = await pool.query(
    `SELECT flow_id, phone, event, extract(epoch from at)*1000 AS t
       FROM app_flow_events
      WHERE tenant_id=$1 AND flow_id = ANY($2::text[]) AND event IN ('entró','completó')
        AND app_flow_events.at >= to_timestamp($3/1000.0) AND app_flow_events.at < to_timestamp($4/1000.0)
      ORDER BY app_flow_events.at ASC, id ASC LIMIT $5`,
    [tenantId, flowIds, sinceMs, untilMs, cap],
  );
  return r.rows.map((x: any) => ({ flow: String(x.flow_id), key: String(x.phone), event: String(x.event), at: Number(x.t) }));
}
/** Las fichas (con lo que acredita identidad) de estas claves de contacto, para fundir personas. */
export async function dbCampanasFichas(keys: string[]): Promise<FichaIdentidad[]> {
  const claves = [...new Set(keys.filter(Boolean))];
  if (!claves.length) return [];
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const out: FichaIdentidad[] = [];
    for (const p of claves) {
      const c = mem.contacts.get(contactMemKey(p, tenantId));
      if (c) out.push({
        phone: c.phone, email: c.email, channel_account: c.channel_account, source: c.source,
        systemeio_contact_id: c.systemeio_contact_id, systemeio_account: c.systemeio_account,
        fields: { telefono: c.fields?.telefono ?? "", formulario: c.fields?.formulario ?? "", typeform_formulario: c.fields?.typeform_formulario ?? "" },
        created_at: c.created_at,
      });
    }
    return out;
  }
  const r = await pool.query(
    `SELECT c.phone, c.email, c.channel_account, c.source, c.systemeio_contact_id, c.systemeio_account,
            c.fields->>'telefono' tel_form, c.fields->>'formulario' form_1, c.fields->>'typeform_formulario' form_2,
            extract(epoch from c.created_at)*1000 created_at
       FROM app_contacts c WHERE c.tenant_id=$1 AND c.phone = ANY($2::text[]) LIMIT 60000`,
    [tenantId, claves],
  );
  return r.rows.map((x: any): FichaIdentidad => ({
    phone: String(x.phone ?? ""), email: String(x.email ?? ""), channel_account: String(x.channel_account ?? ""),
    source: String(x.source ?? ""), systemeio_contact_id: String(x.systemeio_contact_id ?? ""), systemeio_account: String(x.systemeio_account ?? ""),
    fields: { telefono: String(x.tel_form ?? ""), formulario: String(x.form_1 ?? ""), typeform_formulario: String(x.form_2 ?? "") },
    created_at: Number(x.created_at) || 0,
  }));
}
/** Reservas (sin canceladas) y compras de las webs de systeme.io desde `sinceMs`, por correo. Si el workspace
 *  no tiene ninguna reserva (o ninguna venta) conectada, ese lado es «no medible»: NO se cuenta como cero. */
export async function dbCampanasHitos(sinceMs: number, untilMs: number): Promise<HitosExternos> {
  const vacio: HitosExternos = { reservas: { medible: false, filas: [] }, compras: { medible: false, filas: [] } };
  if (!pool) return vacio;
  const tenantId = currentWorkspaceId();
  const [hay, rs, vs] = await Promise.all([
    pool.query(
      `SELECT EXISTS (SELECT 1 FROM app_sio_bookings WHERE tenant_id=$1) agenda,
              EXISTS (SELECT 1 FROM app_sio_sales WHERE tenant_id=$1) ventas`,
      [tenantId],
    ),
    pool.query(
      `SELECT lower(trim(email)) email, extract(epoch from COALESCE(created_at, booked_at))*1000 t
         FROM app_sio_bookings
        WHERE tenant_id=$1 AND trim(COALESCE(email,''))<>'' AND lower(COALESCE(status,'')) NOT LIKE '%cancel%'
          AND COALESCE(created_at, booked_at) >= $2 AND COALESCE(created_at, booked_at) < $3 LIMIT 60000`,
      [tenantId, new Date(sinceMs), new Date(untilMs)],
    ),
    pool.query(
      `SELECT lower(trim(email)) email, extract(epoch from paid_at)*1000 t
         FROM app_sio_sales
        WHERE tenant_id=$1 AND kind='sale' AND paid_at IS NOT NULL AND trim(COALESCE(email,''))<>''
          AND paid_at >= $2 AND paid_at < $3 LIMIT 60000`,
      [tenantId, new Date(sinceMs), new Date(untilMs)],
    ),
  ]);
  const filas = (rows: any[]) => rows.map((x) => ({ email: String(x.email || ""), at: Number(x.t) || 0 })).filter((x) => x.email && x.at);
  return {
    reservas: { medible: !!hay.rows[0]?.agenda, filas: filas(rs.rows) },
    compras: { medible: !!hay.rows[0]?.ventas, filas: filas(vs.rows) },
  };
}

