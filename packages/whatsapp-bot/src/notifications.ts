// NOTIFICACIONES-1 · notificaciones de negocio: lo que el dueño del panel quiere saber sin
// estar mirando (entra un lead, alguien contesta y sale de una automatización, pide hablar con
// una persona, paga, reserva…). Alimentan la campana de la cabecera y la pestaña
// «Notificaciones» de Actividad.
//
// No es el registro técnico (activity.ts / app_activity_log): aquello cuenta lo que hace el
// sistema; esto, lo que le pasa al negocio. Por eso vive aparte, con su propio catálogo.
//
// Contrato:
//  · notificar() NUNCA lanza ni bloquea al llamador (webhooks y motor de flujos). Fallar al
//    avisar no puede costar un mensaje.
//  · Siempre acotada por workspace: currentWorkspaceId() del scope activo, o `tenant` si el
//    llamador corre fuera de scope y lo conoce.
//  · dedup: la misma cosa no avisa dos veces (reintentos de Meta, pollers). Ver dedupVentana().
//  · Cada tipo se puede apagar por workspace (ajuste notificaciones.apagadas).
import { currentWorkspaceId, runWithWorkspace } from "./workspace.js";
import { getWorkspaceSetting, setWorkspaceSetting } from "./settings.js";
import { dbInsertNotification, dbGetContact, type NotificationRow } from "./db.js";

export interface NotifKind {
  key: string;
  label: string; // nombre del tipo en filtros y ajustes
  icon: string; // clave de ICN() en el panel
  desc: string; // qué dispara el aviso, en lenguaje de cliente
}

// El orden es el de los filtros y los ajustes: primero lo que pide acción ya.
export const NOTIF_KINDS: NotifKind[] = [
  { key: "lead_nuevo", label: "Lead nuevo", icon: "users", desc: "Alguien te escribe por primera vez o entra por un formulario, un anuncio o tu web." },
  { key: "flujo_salida", label: "Salió de una automatización", icon: "flow", desc: "Un contacto contesta en mitad de un flujo y el flujo se detiene para que le atiendas." },
  { key: "pide_persona", label: "Pide hablar con una persona", icon: "team", desc: "El bot o un flujo pasan la conversación a tu equipo." },
  { key: "lead_cualificado", label: "Lead cualificado", icon: "star", desc: "Un flujo llega al paso «Avisar a un closer»." },
  { key: "mensaje_sin_bot", label: "Mensaje sin respuesta automática", icon: "inbox", desc: "Te escriben en una conversación donde el bot está apagado. Como mucho un aviso cada 30 minutos por contacto." },
  { key: "comentario", label: "Comentario nuevo", icon: "reply", desc: "Alguien comenta en una publicación tuya." },
  { key: "reunion", label: "Reunión reservada", icon: "calendar", desc: "Un contacto reserva una cita." },
  { key: "pago", label: "Pago recibido", icon: "card", desc: "Te pagan por un enlace de pago." },
  { key: "difusion", label: "Difusión terminada", icon: "megaphone", desc: "Una difusión acaba de enviarse, o se ha detenido con fallos." },
  { key: "publicacion", label: "Publicación que no salió", icon: "image", desc: "Una publicación programada no se pudo publicar." },
  { key: "comentario_sin_flujo", label: "Palabra clave en una publicación sin flujo", icon: "flow", desc: "Alguien comenta la palabra clave de un flujo, pero en una publicación que ese flujo no escucha: no le llega nada." },
  { key: "flujo_conflicto", label: "Flujo no activado por palabra repetida", icon: "flow", desc: "Un flujo no se ha encendido porque otro ya usa la misma palabra clave en esa publicación." },
  { key: "conexion", label: "Conexión caída", icon: "link", desc: "Una de tus cuentas se ha desconectado y hay que volver a conectarla." },
];
const KIND_SET = new Set(NOTIF_KINDS.map((k) => k.key));
export function isNotifKind(k: string): boolean {
  return KIND_SET.has(k);
}

const AJUSTE_APAGADAS = "notificaciones.apagadas";

/** Tipos que este workspace ha apagado. */
export function tiposApagados(tenant?: string): string[] {
  const t = tenant || currentWorkspaceId();
  return String(getWorkspaceSetting(t, AJUSTE_APAGADAS, "") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => KIND_SET.has(s));
}

export async function guardarTiposApagados(tenant: string, apagadas: string[]): Promise<string[]> {
  const limpias = [...new Set(apagadas.filter((s) => KIND_SET.has(s)))];
  await setWorkspaceSetting(tenant, AJUSTE_APAGADAS, limpias.join(","));
  return limpias;
}

/** Clave de dedup «como mucho una por ventana de N minutos» (p. ej. mensajes seguidos). */
export function dedupVentana(base: string, minutos: number): string {
  const slot = Math.floor(Date.now() / (Math.max(1, minutos) * 60000));
  return base + "@" + slot;
}

export interface NotificarInput {
  kind: string;
  title: string;
  body?: string;
  phone?: string | null; // clave del contacto tal y como la usa la Bandeja
  channel?: string | null; // whatsapp | instagram | facebook | web | email | …
  link?: string | null; // destino en el panel: 'inbox:<clave>' | 'flows' | 'bcast' | 'connections' …
  dedup?: string | null;
  payload?: Record<string, unknown> | null;
  // NOTIF-CUENTA-1 · en qué cuenta pasó: clave de canal ('wa:<pnid>' | 'ig:<igId>' | 'fb:<pageId>'),
  // que se traduce al listar a «@usuario» / nombre de la página / etiqueta del número; o, si no
  // hay clave (YouTube, LinkedIn), el nombre tal cual.
  account?: string | null;
  accountName?: string | null;
  tenant?: string;
}

// Enganche para los arneses: la última promesa lanzada (para poder esperarla).
let ultima: Promise<NotificationRow | null> = Promise.resolve(null);
export function ultimaNotificacion(): Promise<NotificationRow | null> {
  return ultima;
}

function conCuenta(p: Record<string, unknown> | null | undefined, acct?: string | null, nombre?: string | null): Record<string, unknown> | null {
  const a = String(acct || "").trim(), nm = String(nombre || "").trim();
  if (!a && !nm) return p || null;
  return { ...(p || {}), ...(a ? { cuenta: a } : {}), ...(nm ? { cuentaNombre: nm } : {}) };
}

/**
 * Registra una notificación. Fire-and-forget: devuelve al instante y se traga cualquier error.
 */
export function notificar(n: NotificarInput): void {
  try {
    if (!n || !KIND_SET.has(n.kind) || !String(n.title || "").trim()) return;
    const tenant = (n.tenant || currentWorkspaceId() || "default").trim() || "default";
    if (tiposApagados(tenant).includes(n.kind)) return;
    ultima = dbInsertNotification({
      tenant_id: tenant,
      kind: n.kind,
      title: String(n.title).trim(),
      body: String(n.body || "").trim(),
      phone: n.phone || null,
      channel: n.channel || null,
      link: n.link || null,
      dedup_key: n.dedup || null,
      payload: conCuenta(n.payload, n.account, n.accountName),
    }).catch((e) => {
      console.warn(`[notificaciones] no se pudo guardar (${n.kind}): ${(e as Error).message}`);
      return null;
    });
  } catch (e) {
    console.warn(`[notificaciones] ${(e as Error).message}`);
  }
}

/** Nombre legible de un contacto para el título: el nombre si lo hay, si no la clave. */
// NTF-SIN-ID-1 · En Instagram, Facebook, TikTok, YouTube y LinkedIn la clave de la ficha es
// el identificador interno de la red (17 dígitos): como eran sólo dígitos, salía como si
// fuera un teléfono («Lead nuevo: +1265405738577861»). Con el canal, nunca se enseña.
const CANAL_SIN_TELEFONO = new Set(["instagram", "facebook", "tiktok", "youtube", "linkedin"]);
export function quien(name: string | null | undefined, phone: string | null | undefined, canal?: string | null): string {
  const nm = String(name || "").trim();
  if (nm) return nm;
  const p = String(phone || "").trim();
  const c = String(canal || "") || (p ? canalDeClave(p) : "");
  if (CANAL_SIN_TELEFONO.has(c)) return "Un contacto de " + nombreCanal(c);
  if (!p) return "Un contacto";
  // Claves de canal (ig:123, fb:456) no se enseñan: no le dicen nada al cliente.
  if (/^[a-z]{2,4}:/i.test(p)) return "Un contacto";
  // Un teléfono tiene como mucho 15 dígitos (E.164): más largo es un identificador interno.
  if (/^\+?\d{16,}$/.test(p)) return "Un contacto";
  return p.startsWith("+") ? p : (/^\d{6,}$/.test(p) ? "+" + p : p);
}

export function canalDeClave(phone: string | null | undefined): string {
  const p = String(phone || "");
  if (p.startsWith("ig:")) return "instagram";
  if (p.startsWith("fb:")) return "facebook";
  if (p.startsWith("yt:")) return "youtube";
  if (p.startsWith("li:")) return "linkedin";
  if (p.includes("@")) return "email";
  return "whatsapp";
}

const NOMBRE_CANAL: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  email: "correo",
  web: "tu web",
};
export function nombreCanal(canal: string | null | undefined): string {
  return NOMBRE_CANAL[String(canal || "")] || String(canal || "");
}

/**
 * Aviso sobre un contacto concreto. Resuelve su nombre de la ficha (si quien llama no lo
 * tiene) y enlaza a su conversación. Fire-and-forget como notificar(): el tenant se fija
 * AQUÍ, antes de cualquier await, para que no dependa del scope cuando la promesa resuelva.
 */
export function avisarContacto(
  kind: string,
  phone: string,
  texto: (nombre: string) => { title: string; body?: string },
  extra: { name?: string | null; channel?: string | null; account?: string | null; dedup?: string | null; payload?: Record<string, unknown> | null; tenant?: string } = {},
): void {
  try {
    const tenant = extra.tenant || currentWorkspaceId() || "default";
    if (tiposApagados(tenant).includes(kind)) return;
    const canal = extra.channel || canalDeClave(phone);
    const sale = (nm: string | null | undefined, acct: string | null | undefined) => {
      const t = texto(quien(nm, phone, canal));
      notificar({ kind, title: t.title, body: t.body, phone, channel: canal, link: "inbox:" + phone, dedup: extra.dedup, payload: extra.payload, account: acct, tenant });
    };
    const nm = String(extra.name || "").trim();
    if (nm && extra.account) return sale(nm, extra.account);
    // NOTIF-CUENTA-1 · la ficha se lee también cuando ya traen el nombre: de ahí sale la cuenta.
    runWithWorkspace(tenant, () => dbGetContact(phone))
      .then((c) => sale(nm || c?.name, extra.account || c?.channel_account))
      .catch(() => sale(nm, extra.account));
  } catch (e) {
    console.warn(`[notificaciones] ${(e as Error).message}`);
  }
}

/** Lead nuevo: una sola vez por contacto y workspace (dedup), venga por donde venga. */
export function avisarLeadNuevo(phone: string, opts: { name?: string | null; channel?: string | null; account?: string | null; origen?: string; tenant?: string } = {}): void {
  const canal = opts.channel || canalDeClave(phone);
  avisarContacto(
    "lead_nuevo",
    phone,
    (nm) => ({ title: "Lead nuevo: " + nm, body: opts.origen || ("Te ha escrito por primera vez por " + nombreCanal(canal) + ".") }),
    { name: opts.name, channel: canal, account: opts.account, dedup: "lead:" + phone, tenant: opts.tenant },
  );
}
