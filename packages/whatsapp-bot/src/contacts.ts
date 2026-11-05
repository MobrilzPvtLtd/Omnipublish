/**
 * CRM ligero de contactos. Cada persona que escribe queda registrada con
 * teléfono, nombre, tags, campos capturados y última actividad. La "ventana
 * de 24h" de WhatsApp se calcula desde last_inbound.
 */
import { currentWorkspaceId } from "./workspace.js";
import {
  dbTouchContact,
  dbGetContact,
  dbPatchContact,
  dbListContacts,
  dbSetContactStage,
  dbSetContactHuman,
  dbSetContactOwner,
  dbCreateContact,
  dbContactByEmail,
  dbUpdateContact,
  dbDeleteContact,
  dbSearchContacts,
  dbAddContactNote,
  dbListContactNotes,
  dbFindContactByPhoneDigits,
  ETIQUETA_NO_MOLESTAR,
  type Contact,
  type ContactFilter,
  type ContactNote,
} from "./db.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Registra/actualiza el contacto al recibir un mensaje suyo. `account` = número/cuenta
 *  por el que entró ('wa:<phoneNumberId>' | 'ig:<igId>'), para saber qué bot lo atendió.
 *  Devuelve true si la ficha es NUEVA (NOTIFICACIONES-1: quien llama decide si es un lead). */
export async function touchContact(phone: string, name: string, botId: string, account = "", source = ""): Promise<boolean> {
  return dbTouchContact(phone, name, botId, account, source);
}

export async function getContact(phone: string): Promise<Contact | null> {
  return dbGetContact(phone);
}

/** Añade tags y/o campos capturados a un contacto. `email`/`name` van a las
 *  columnas núcleo del contacto (no solo a `fields`), para que el sync a
 *  systeme.io/leadmatch-lab —que lee `contact.email`— los recoja. */
export async function enrichContact(
  phone: string,
  opts: { tags?: string[]; fields?: Record<string, string>; email?: string; name?: string },
): Promise<void> {
  const tags = (opts.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const fields = opts.fields ?? {};
  const core: { email?: string; name?: string } = {};
  if (opts.email && opts.email.trim()) core.email = opts.email.trim().toLowerCase();
  if (opts.name && opts.name.trim()) core.name = opts.name.trim();
  if (!tags.length && !Object.keys(fields).length && !Object.keys(core).length) return;
  if (tags.length || Object.keys(fields).length) await dbPatchContact(phone, tags, fields);
  if (Object.keys(core).length) await dbUpdateContact(phone, core);
}

export async function listContacts(limit = 500): Promise<Contact[]> {
  return dbListContacts(limit);
}

// OPORTUNIDADES-1 (PIP-01) · una regla que pone etapa (nodo de flujo, Buscar leads) abre
// o mueve la oportunidad de esa persona, y deja dicho qué regla fue (origen). Si la regla
// vuelve a dispararse con la misma etapa (reimportar, flujo que se repite) no abre otra.
export async function setStage(phone: string, stage: string, origen?: { origin: string; reason: string }, pipelineId?: string): Promise<void> {
  const antes = stage ? await dbGetContact(phone) : null;
  await dbSetContactStage(phone, stage);
  if (!stage) return;
  const { syncDesdeContacto } = await import("./pipelines.js");
  await syncDesdeContacto(phone, antes, stage, pipelineId || undefined,
    origen || { origin: "regla", reason: "Etapa puesta automáticamente" });
}

/** Activa/desactiva el handoff humano (bot en silencio para ese contacto). */
export async function setHuman(phone: string, human: boolean): Promise<void> {
  await dbSetContactHuman(phone, human);
}

/** Asigna el closer dueño del lead. owner='' = vuelve al pool sin asignar. */
export async function setOwner(phone: string, owner: string): Promise<void> {
  await dbSetContactOwner(phone, owner);
}

/** Cambia el perfil de bot que atiende a ESTE contacto. botId='' = que vuelva a
 *  decidirlo la IA en el siguiente mensaje. */
export async function setBotId(phone: string, botId: string): Promise<void> {
  await dbUpdateContact(phone, { bot_id: botId });
}

/** Fija el lead score (0-100). Lo usan las acciones de flujo y el scoring por reglas. */
export async function setScore(phone: string, score: number): Promise<void> {
  const s = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  await dbUpdateContact(phone, { score: s });
}

export function inWindow(c: Pick<Contact, "last_inbound">): boolean {
  return Date.now() - c.last_inbound < WINDOW_MS;
}

/** CHAT-POR-NUMERO-1 · Ventana de 24 h del PAR (cuenta, cliente). La de Meta es por
 *  número: que el cliente haya escrito a Setter no abre la ventana de Ingeniero
 *  Binario. Sin registro por número (contacto de antes del arreglo), el last_inbound
 *  clásico solo vale para la cuenta a la que estaba atribuido el hilo. */
export function inWindowFor(
  c: Pick<Contact, "last_inbound" | "last_inbound_by" | "channel_account">,
  acct: string,
): boolean {
  if (!acct) return inWindow(c);
  const by = c.last_inbound_by || {};
  const t = by[acct] || 0;
  if (t) return Date.now() - t < WINDOW_MS;
  // Con el registro por número YA poblado, un número ausente del mapa NO tiene
  // ventana: el last_inbound clásico lo refresca CUALQUIER entrante y mentiría por
  // él (badge «24h» eterno en el chat A mientras el cliente solo escribe al B —
  // cazado por la revisión adversaria del 2-sep). El fallback clásico queda solo
  // para contactos sin NINGÚN entrante posterior al arreglo.
  if (Object.keys(by).length) return false;
  return acct === c.channel_account ? inWindow(c) : false;
}

/** CHAT-POR-NUMERO-1 · La cuenta por la que ENRUTAR un envío nuevo a este contacto:
 *  el par con la entrada más reciente (last_inbound_by), que es quien tiene la
 *  ventana de 24 h viva — exactamente lo que channel_account significaba antes de
 *  congelarse (el webhook lo movía al último número receptor). Sin registro por
 *  número, cae al channel_account histórico. La usan los flujos, el scheduler y la
 *  respuesta del panel cuando el chat abierto no dicta número; channel_account queda
 *  como ATRIBUCIÓN del historial, no como ruta. */
export function routeAccount(c: Pick<Contact, "channel_account" | "last_inbound_by">): string {
  const by = c.last_inbound_by || {};
  let best = "";
  let bestT = 0;
  for (const k of Object.keys(by)) {
    const t = Number(by[k]) || 0;
    if (t > bestT) { best = k; bestT = t; }
  }
  return best || String(c.channel_account || "");
}

/** Etapa del pipeline → puntos del lead score heurístico. */
const STAGE_SCORE: Record<string, number> = {
  "Nuevo": 5, "nuevo": 5,
  "Contactado": 15, "contactado": 15,
  "Propuesta": 35, "propuesta": 35,
  "Negociación": 45, "Negociacion": 45, "negociación": 45, "negociacion": 45,
  "Ganado": 80, "ganado": 80,
  "Perdido": 0, "perdido": 0,
};

/**
 * Lead score heurístico 0-100 (engagement + etapa + presencia de datos).
 * ÚNICA fuente del score automático: lo usan la lista de Contactos, la ficha
 * de contacto y la Bandeja para que el mismo contacto muestre SIEMPRE el
 * mismo número. Si el contacto tiene score manual >0 se respeta (el caller
 * hace `c.score > 0 ? c.score : computeLeadScore(c)`).
 */
export function computeLeadScore(
  c: Pick<Contact, "last_inbound" | "tags" | "stage" | "email" | "phone" | "utm_source" | "utm_campaign">,
): number {
  let s = 0;
  const hoursSince = (Date.now() - c.last_inbound) / 3600_000;
  if (hoursSince < 24) s += 25;
  else if (hoursSince < 168) s += 12;
  else if (hoursSince < 720) s += 5;
  s += Math.min(30, (c.tags || []).length * 8);
  s += STAGE_SCORE[c.stage] ?? 0;
  if (c.email) s += 10;
  if (c.phone && !c.phone.startsWith("email:")) s += 5;
  if (c.utm_source || c.utm_campaign) s += 5;
  return Math.min(100, s);
}

/** Contactos a los que SÍ se puede escribir gratis ahora (ventana 24h). */
export async function contactsInWindow(): Promise<Contact[]> {
  return (await dbListContacts(5000)).filter(inWindow);
}

/** Alta explícita desde el panel u otra integración (no toca last_inbound). */
export async function createContact(c: Partial<Contact> & { phone: string }): Promise<Contact> {
  return dbCreateContact(c);
}

/** Contacto del workspace activo con ese email exacto (case-insensitive), o null. */
export async function contactByEmail(email: string): Promise<Contact | null> {
  return dbContactByEmail(email);
}

/** Update parcial de los campos editables de un contacto. */
export async function updateContact(phone: string, upd: Partial<Contact>): Promise<void> {
  await dbUpdateContact(phone, upd);
}

/** Borrado fuerte (también borra notas asociadas). */
export async function deleteContact(phone: string): Promise<void> {
  await dbDeleteContact(phone);
}

/** Buscar/filtrar contactos para bandeja y vista Contactos. */
export async function searchContacts(filter: ContactFilter = {}): Promise<Contact[]> {
  return dbSearchContacts(filter);
}

/** Añade una nota o entrada de log al contacto. */
export async function addContactNote(phone: string, body: string, opts: { kind?: string; author?: string; tenant_id?: string } = {}): Promise<void> {
  await dbAddContactNote({
    phone,
    kind: opts.kind ?? "note",
    body,
    author: opts.author ?? "panel",
    // Multi-tenant: el workspace activo, no 'default' (antes TODAS las notas se
    // etiquetaban 'default' aunque el workspace fuera otro).
    tenant_id: opts.tenant_id ?? currentWorkspaceId(),
  });
}

/** Historial de notas + eventos sistémicos por contacto (scoped a workspace). */
export async function listContactNotes(phone: string, limit = 50): Promise<ContactNote[]> {
  return dbListContactNotes(phone, limit, currentWorkspaceId());
}

/**
 * Etiqueta de BAJA. Un contacto con esta etiqueta ha pedido explícitamente no recibir más
 * mensajes (p. ej. pulsando "Dejar de recibir promociones" en una plantilla), y queda
 * EXCLUIDO de las difusiones — ver resolveAudience en broadcast-flows.ts.
 *
 * La cadena en sí vive en db.ts (ETIQUETA_NO_MOLESTAR) y aquí solo se le pone el nombre
 * con el que la conoce el resto del código: el filtro SQL de contactos también la
 * necesita, y db.ts no puede importar de este módulo sin cerrar un ciclo.
 * DIFUSION-UNIVERSO-1 · una etiqueta de baja escrita en dos sitios es peor que no
 * tenerla: hace creer al dueño que la petición está atendida mientras la otra copia
 * sigue enviando.
 */
export const OPT_OUT_TAG = ETIQUETA_NO_MOLESTAR;

/** ¿Este contacto ha pedido la baja? */
export function hasOptedOut(c: { tags?: string[] | null } | null | undefined): boolean {
  return !!c?.tags?.includes(OPT_OUT_TAG);
}

// Deja solo letras y números: minúsculas, sin acentos, sin emoji y sin puntuación.
//   "🚫 Cancelar Suscripción!" → "cancelar suscripcion"
// Los emoji en las etiquetas de botón son la norma, no la excepción: sin limpiarlos, un
// botón "🚫 Baja" no se reconocería y el bot le contestaría a quien pidió la baja.
const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // acentos
    .replace(/[^a-z0-9\s]/g, " ")      // emoji, signos, puntuación
    .replace(/\s+/g, " ")
    .trim();

/**
 * Etiquetas de botón que significan "no me escribas más".
 *
 * Se compara la etiqueta COMPLETA, nunca por partes. Buscar "baja" dentro del texto
 * silenciaría "Baja laboral" o "Tramitar una baja" —el botón de una gestoría, que es
 * justo el tipo de negocio que usa esto— y perderíamos un lead con toda la intención.
 * Y al revés: el botón que Meta pone en las plantillas de marketing en español suele ser
 * "Dejar de recibir promociones", que buscando "no recibir" se escaparía. De ahí la lista.
 */
const OPT_OUT_LABELS = new Set([
  "stop", "stop promotions", "baja", "darme de baja", "dar de baja", "me doy de baja",
  "no recibir mas mensajes", "no recibir mas", "no quiero recibir mas", "no quiero recibir mas mensajes",
  "dejar de recibir promociones", "dejar de recibir mensajes", "dejar de recibir",
  "dejar de escribirme", "quitar de la lista", "eliminar mis datos",
  "cancelar suscripcion", "cancelar la suscripcion", "unsubscribe", "opt out", "detener promociones",
]);

/** ¿La etiqueta de este botón (o su payload) es una petición de baja? */
export function isOptOutLabel(label: string, payload?: string): boolean {
  const l = norm(label || "");
  const p = norm(payload || "");
  return (!!l && OPT_OUT_LABELS.has(l)) || (!!p && OPT_OUT_LABELS.has(p));
}

// ---------------------------------------------------------------------------
// T02 · Normalización de teléfonos para WhatsApp (formato de la casa: E.164 SIN
// '+', igual que el wa_id que manda Meta en los webhooks — así el hilo que abre
// el panel y el que abre la respuesta del cliente son EL MISMO user_id).
// ---------------------------------------------------------------------------

export interface WaPhoneNorm { ok: true; phone: string; display: string }
export interface WaPhoneNormErr { ok: false; error: string }

/**
 * Normaliza lo que teclea una persona a E.164. Reglas:
 *  - Se toleran separadores habituales: espacios, guiones, puntos, paréntesis.
 *  - El prefijo internacional debe venir EXPLÍCITO: '+34…' o '0034…'. No se asume
 *    España ni ningún otro país: adivinar el prefijo enviaría el mensaje a otra
 *    persona en otro país sin que nadie se entere.
 *  - Largo E.164: 8–15 dígitos en total (15 es el máximo del estándar).
 * Devuelve phone (dígitos pelados, clave de contacto/conversación) y display
 * ('+<dígitos>' para enseñar al usuario antes de confirmar).
 */
export function normalizeWaPhone(raw: string): WaPhoneNorm | WaPhoneNormErr {
  let s = String(raw || "").trim();
  if (!s) return { ok: false, error: "Escribe un número de teléfono." };
  // Separadores permitidos fuera; cualquier otro carácter es un error de tecleo.
  s = s.replace(/[\s\-.()·]/g, "");
  const conMas = s.startsWith("+");
  if (conMas) s = s.slice(1);
  if (/\D/.test(s)) return { ok: false, error: "El teléfono solo puede llevar dígitos, espacios y el prefijo «+»." };
  if (!conMas) {
    if (s.startsWith("00")) s = s.slice(2);
    else
      return {
        ok: false,
        error: "Incluye el prefijo internacional (por ejemplo +34 para España, +52 para México). No lo adivinamos para no escribirle a otra persona.",
      };
  }
  s = s.replace(/^0+/, ""); // '+ 0…' residual: E.164 nunca empieza por 0
  if (s.length < 8) return { ok: false, error: "Ese número está incompleto: con el prefijo del país debe tener al menos 8 dígitos." };
  if (s.length > 15) return { ok: false, error: "Ese número tiene demasiados dígitos para ser un teléfono válido (máximo 15)." };
  return { ok: true, phone: s, display: "+" + s };
}

/**
 * T02 · Busca un contacto por teléfono TOLERANDO diferencias de formato: primero
 * el match exacto (formato de la casa) y después por igualdad de dígitos en SQL,
 * para encontrar fichas antiguas guardadas como '+34 600 11 22 33' desde el
 * panel. Siempre acotado al workspace activo. Evita crear duplicados por formato.
 */
export async function findContactByPhoneLoose(normalizedDigits: string): Promise<Contact | null> {
  const exact = await dbGetContact(normalizedDigits);
  if (exact) return exact;
  return dbFindContactByPhoneDigits(normalizedDigits);
}

// Re-export tipos por conveniencia para consumidores.
export type { Contact, ContactFilter, ContactNote };
