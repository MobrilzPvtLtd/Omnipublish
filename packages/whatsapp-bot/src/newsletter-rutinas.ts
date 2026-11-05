/**
 * NEWSLETTER-RUTINA-1 · Rutinas de correo: el boletín que se escribe solo.
 *
 * Una rutina NO es un correo. Es un encargo permanente —«cada martes a las 9:00,
 * escribe a los alumnos un consejo sobre X»— con el que la IA redacta un correo
 * DISTINTO en cada ejecución. Se deja corriendo y se pausa, igual que un flujo.
 *
 * Reparto:
 *   - Este módulo decide CUÁNDO toca (la recurrencia, en la hora del negocio) y
 *     orquesta la ejecución: redactar con la IA → publicar en la web → apuntar.
 *   - El envío en sí sigue siendo el de siempre (`publicarEnWeb`, «enviar»): la
 *     web conectada manda, con su lista, sus bajas y su reputación.
 *   - Cada ejecución deja su fila en app_newsletters con `routine_id`: así el
 *     historial de la rutina es simplemente «los boletines que salieron de ella»,
 *     y la ficha de aperturas/clics que ya existe sirve tal cual.
 *
 * Por qué la hora se calcula aquí y no se delega en la web (al revés que un
 * boletín suelto): la web programa UN envío con un contenido ya escrito. Aquí el
 * contenido no existe hasta la hora de ejecutar —lo escribe la IA en ese momento—,
 * así que el reloj tiene que ser nuestro. Si un reinicio cae justo a la hora, el
 * claim deja la rutina vencida y el siguiente latido (60 s) la recoge.
 */
import crypto from "node:crypto";
import { logActivity } from "./activity.js";
import { currentWorkspaceId } from "./workspace.js";
import { get as getSetting } from "./settings.js";
import {
  dbUpsertNewsletter,
  dbFinishNewsletterRoutine,
  dbListNewslettersDeRutina,
  type NewsletterRec,
  type NewsletterRoutineRec,
} from "./db.js";
import { newsletterVacio, publicarEnWeb, redactarConIA } from "./newsletter.js";

// ------------------------------------------- VARIEDAD-1 · memoria + actualidad
//
// Cada ejecución empezaba de cero: la IA no veía los correos anteriores (repetía
// «¿Por qué tu sueldo no sube…?») ni tenía noticias reales (las inventaba: «según
// McKinsey, el 70%…»). Ahora se le pasan los últimos asuntos de la rutina y
// titulares tech REALES del día, con su enlace. Todo es best-effort: si algo
// falla, el correo sale como antes.

// Ojo: genbeta.com/feedburner.xml está congelado en dic-2025; el filtro de 3 días lo descarta solo.
const FEEDS_TECH = ["https://www.xataka.com/index.xml", "https://www.genbeta.com/index.xml", "https://www.computerworld.es/feed/"];

function textoXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseaRss(xml: string, desde: number): Array<{ titulo: string; enlace: string }> {
  const out: Array<{ titulo: string; enlace: string }> = [];
  for (const m of String(xml ?? "").matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const it = m[0];
    const titulo = textoXml(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(it)?.[1] ?? "");
    const enlace = textoXml(/<link\b[^>]*>([\s\S]*?)<\/link>/i.exec(it)?.[1] ?? "");
    const fecha = Date.parse(textoXml(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i.exec(it)?.[1] ?? ""));
    if (!titulo || !/^https?:\/\//i.test(enlace)) continue;
    if (Number.isFinite(fecha) && fecha < desde) continue;
    out.push({ titulo: titulo.slice(0, 200), enlace });
  }
  return out;
}

export async function titularesTech(max = 15): Promise<Array<{ titulo: string; enlace: string }>> {
  const desde = Date.now() - 3 * 86400_000;
  const listas = await Promise.all(
    FEEDS_TECH.map(async (u) => {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(6000), headers: { "user-agent": "Mozilla/5.0 BusinessStack" } });
        return r.ok ? parseaRss(await r.text(), desde).slice(0, max / FEEDS_TECH.length) : [];
      } catch {
        return [];
      }
    }),
  );
  return listas.flat();
}

export async function contextoRutina(r: NewsletterRoutineRec): Promise<string> {
  const partes: string[] = [];
  try {
    const h = await dbListNewslettersDeRutina(r.id, 6, 0);
    const previos = h.items.filter((n) => n.status === "sent" && n.subject);
    if (previos.length) {
      partes.push(
        "CORREOS ANTERIORES DE ESTA SERIE (del más reciente al más antiguo). El nuevo NO puede repetir su recurso de asunto (si el último fue una pregunta, este no lo es), ni su dolor, ni su ángulo, ni sus frases de arranque:",
        ...previos.map((n) => {
          const ini = n.body_html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
          return `- Asunto: «${n.subject}» · Empezaba: «${ini}…»`;
        }),
      );
    }
  } catch { /* sin historial: sigue sin él */ }
  try {
    const t = await titularesTech();
    if (t.length) {
      partes.push(
        "",
        "TITULARES TECH REALES DE ESTOS DÍAS (fuente: Xataka, Genbeta y Computerworld). Elige UNO que encaje con el público y úsalo como gancho del asunto y la apertura; puedes enlazar la noticia en el cuerpo con su URL exacta. Ignora los que no tengan que ver con trabajo, tecnología o IA. No inventes ningún dato que no esté en el titular; si ninguno encaja, no uses noticia:",
        ...t.map((x) => `- ${x.titulo} — ${x.enlace}`),
      );
    }
  } catch { /* sin noticias: sigue sin ellas */ }
  return partes.join("\n").trim();
}

// ---------------------------------------------------------------- utilidades

export function nuevoIdRutina(): string {
  return `nlr_${crypto.randomUUID()}`;
}

export function rutinaVacia(creadoPor = ""): NewsletterRoutineRec {
  const ahora = Date.now();
  return {
    id: nuevoIdRutina(),
    tenant_id: currentWorkspaceId(),
    account_id: "",
    name: "",
    prompt: "",
    sender_name: "",
    sender_email: "",
    include_tags: [],
    exclude_tags: [],
    contacts: [],
    freq: "weekly",
    weekdays: [1],
    monthday: 1,
    at_hour: 9,
    at_min: 0,
    tz: "Europe/Madrid",
    ai_model: "",
    signature: { despedida: "Un abrazo,", cargo: "", web: "" },
    active: false,
    next_run_at: null,
    last_run_at: null,
    runs: 0,
    last_result: "",
    created_by: creadoPor,
    created_at: ahora,
    updated_at: ahora,
  };
}

// Reutilizar ICU: una recurrencia consulta varias veces la misma zona.
// Caché acotada, sin datos del negocio.
const formatosZona = new Map<string, Intl.DateTimeFormat>();
function formatoZona(tz: string): Intl.DateTimeFormat {
  let f = formatosZona.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    if (formatosZona.size >= 128) formatosZona.delete(formatosZona.keys().next().value!);
    formatosZona.set(tz, f);
  }
  return f;
}
export function zonaValida(tz: string): boolean {
  try {
    formatoZona(tz);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ la hora local

interface Muro { y: number; mo: number; d: number; h: number; mi: number; dow: number }

/** La hora de pared que marca `tz` en el instante `at`. */
function muroEn(tz: string, at: number): Muro {
  const p = formatoZona(tz).formatToParts(new Date(at));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const y = g("year"), mo = g("month"), d = g("day"), h = g("hour") % 24, mi = g("minute");
  return { y, mo, d, h, mi, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}

/** Minutos que `tz` va por delante de UTC en el instante `at`. */
function desfase(tz: string, at: number): number {
  const m = muroEn(tz, at);
  const comoUtc = Date.UTC(m.y, m.mo - 1, m.d, m.h, m.mi);
  return Math.round((comoUtc - Math.floor(at / 60000) * 60000) / 60000);
}

/**
 * El instante en que `tz` marca y-mo-d h:mi. Dos pasadas porque el desfase
 * depende del propio instante (horario de verano). Si esa hora no existe —el
 * hueco de marzo, p. ej. 02:30 el día del cambio— cae en el instante vecino y
 * se ejecuta una vez igualmente; si existe dos veces —octubre— gana la primera.
 */
function instanteDe(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const muro = Date.UTC(y, mo - 1, d, h, mi);
  let t = muro - desfase(tz, muro) * 60000;
  t = muro - desfase(tz, t) * 60000;
  return t;
}

/**
 * La próxima vez que toca, estrictamente DESPUÉS de `desde`. null si la regla
 * no puede cumplirse nunca (semanal sin ningún día marcado).
 *
 * Se recorre día a día en el calendario LOCAL del negocio, no sumando 24 h: con
 * horario de verano hay días de 23 y de 25 horas, y sumando se acaba corriendo
 * la hora de la rutina.
 */
export function proximaEjecucion(r: Pick<NewsletterRoutineRec, "freq" | "weekdays" | "monthday" | "at_hour" | "at_min" | "tz">, desde = Date.now()): number | null {
  const tz = zonaValida(r.tz) ? r.tz : "Europe/Madrid";
  if (r.freq === "weekly" && !(r.weekdays || []).length) return null;
  const hoy = muroEn(tz, desde);
  const base = Date.UTC(hoy.y, hoy.mo - 1, hoy.d);
  for (let i = 0; i < 400; i++) {
    const dia = new Date(base + i * 86400000);
    const y = dia.getUTCFullYear(), mo = dia.getUTCMonth() + 1, d = dia.getUTCDate(), dow = dia.getUTCDay();
    const toca =
      r.freq === "daily" ? true
      : r.freq === "weekly" ? r.weekdays.includes(dow)
      : d === Math.min(28, Math.max(1, r.monthday || 1));
    if (!toca) continue;
    const t = instanteDe(tz, y, mo, d, r.at_hour || 0, r.at_min || 0);
    if (t > desde) return t;
  }
  return null;
}

// ---------------------------------------------------------- en cristiano

const DIAS = ["domingos", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados"];

function listaY(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] || "") : xs.slice(0, -1).join(", ") + " y " + xs[xs.length - 1];
}

/** Ciudad de una zona IANA: «Europe/Madrid» → «Madrid». Es lo único que le dice algo al cliente. */
export function ciudadDe(tz: string): string {
  const c = String(tz || "").split("/").pop() || tz;
  return c.replace(/_/g, " ");
}

/** «A las 09:00, los martes y jueves (hora de Madrid)». Mismo formato que las rutinas de Claude Code. */
export function describeRecurrencia(r: Pick<NewsletterRoutineRec, "freq" | "weekdays" | "monthday" | "at_hour" | "at_min" | "tz">): string {
  const hh = String(r.at_hour || 0).padStart(2, "0") + ":" + String(r.at_min || 0).padStart(2, "0");
  let cuando: string;
  if (r.freq === "daily") cuando = "todos los días";
  else if (r.freq === "monthly") cuando = `el día ${Math.min(28, Math.max(1, r.monthday || 1))} de cada mes`;
  else {
    const ds = [...(r.weekdays || [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    if (!ds.length) cuando = "sin ningún día elegido";
    else if (ds.length === 7) cuando = "todos los días";
    else if (ds.length === 5 && [1, 2, 3, 4, 5].every((x) => ds.includes(x))) cuando = "de lunes a viernes";
    else cuando = (ds.length === 1 ? "solo los " : "los ") + listaY(ds.map((x) => DIAS[x]));
  }
  return `A las ${hh}, ${cuando} (hora de ${ciudadDe(r.tz)})`;
}

// ---------------------------------------------------------------- reglas

/** Lo que una rutina necesita para poder ACTIVARSE. Guardarla en pausa no exige nada. */
export function motivoNoActivable(r: NewsletterRoutineRec): string | null {
  if (!String(r.prompt || "").trim()) return "Escribe qué tiene que contar la IA en cada correo";
  if (!r.include_tags.length && !r.contacts.length) return "Elige a quién se lo enviamos: alguna etiqueta o algún correo";
  if (r.freq === "weekly" && !r.weekdays.length) return "Marca al menos un día de la semana";
  if (!zonaValida(r.tz)) return "La zona horaria no es válida";
  return null;
}

// ------------------------------------------------------------- ejecución

/**
 * PUENTE-1 · La etiqueta puente de una rutina es FIJA mientras no cambien sus
 * correos sueltos. Antes cada ejecución era un boletín nuevo con su propia
 * etiqueta «Boletín xxxx»: una etiqueta nueva por envío, hasta agotar el cupo
 * del plan de la web («Tu plan no permite crear más etiquetas»). Si el cliente
 * quita un correo, la huella cambia y se usa otra: quien sale deja de recibirlo.
 */
export function etiquetaPuenteRutina(r: Pick<NewsletterRoutineRec, "id" | "contacts">): string {
  const lista = [...new Set((r.contacts || []).map((c) => String(c).trim().toLowerCase()).filter(Boolean))].sort();
  const huella = crypto.createHash("sha1").update(lista.join("\n")).digest("hex").slice(0, 4);
  return `Rutina ${r.id.replace(/^nlr_/, "").slice(0, 8)} ${huella}`;
}

export interface ResultadoEjecucion {
  ok: boolean;
  newsletterId: string;
  motivo: string;
}

/**
 * Una ejecución: la IA redacta, la web envía, y se apunta todo.
 *
 * `manual` = el cliente pulsó «Ejecutar ahora»: no mueve la próxima ejecución
 * programada (probar la rutina no debe comerse el envío del martes).
 *
 * Nunca lanza: devuelve el resultado y deja constancia tanto en la rutina
 * (last_result) como en el boletín generado, para que el historial explique
 * qué pasó aunque haya fallado.
 */
export async function ejecutaRutina(r: NewsletterRoutineRec, opts: { manual?: boolean } = {}): Promise<ResultadoEjecucion> {
  const ahora = Date.now();
  const nl: NewsletterRec = {
    ...newsletterVacio(opts.manual ? "manual" : "rutina"),
    tenant_id: r.tenant_id || currentWorkspaceId(),
    account_id: r.account_id,
    sender_name: r.sender_name,
    sender_email: r.sender_email,
    prompt: r.prompt,
    include_tags: [...r.include_tags],
    exclude_tags: [...r.exclude_tags],
    contacts: [...r.contacts],
    routine_id: r.id,
    bridge_tag: r.contacts.length ? etiquetaPuenteRutina(r) : "",
    status: "sending",
  };

  let res: ResultadoEjecucion;
  try {
    let negocio = "";
    try { negocio = String(getSetting("brand.name") || "").trim(); } catch { /* sin marca: la IA no firma con nombre de negocio */ }
    const contexto = await contextoRutina(r);
    const b = await redactarConIA(r.prompt, { negocio, firmante: r.sender_name, modelo: r.ai_model, firma: r.signature, contexto });
    nl.subject = b.subject;
    nl.preview_text = b.previewText;
    nl.body_html = b.bodyHtml;
    await dbUpsertNewsletter(nl);

    const pub = await publicarEnWeb(nl, "enviar");
    nl.sio_id = pub.sioId;
    nl.recipients = pub.destinatarios;
    nl.status = "sent";
    nl.sent_at = Date.now();
    nl.result = pub.aviso || "";
    await dbUpsertNewsletter(nl);
    res = { ok: true, newsletterId: nl.id, motivo: `Enviado: «${b.subject}»` + (pub.aviso ? `. ${pub.aviso}` : "") };
  } catch (e) {
    const msg = String((e as Error).message || "error desconocido").slice(0, 400);
    nl.status = "error";
    nl.result = msg;
    try { await dbUpsertNewsletter(nl); } catch { /* best-effort: lo importante es no perder el motivo en la rutina */ }
    res = { ok: false, newsletterId: nl.id, motivo: msg };
  }

  const sig = opts.manual ? r.next_run_at : (r.active ? proximaEjecucion(r, Math.max(ahora, r.next_run_at || 0)) : null);
  await dbFinishNewsletterRoutine(r.id, {
    at: ahora, message: res.motivo, expectedNext: r.next_run_at,
    next: sig, manual: !!opts.manual,
  });
  await logActivity({
    source: "newsletter",
    level: !res.ok ? "error" : res.motivo.includes("no lo han recibido") ? "warn" : "info",
    status: res.ok ? "ok" : "error",
    summary: `Rutina «${r.name || "sin nombre"}»: ${res.motivo}`.slice(0, 240),
    payload: { routine: r.id, newsletter: res.newsletterId, manual: !!opts.manual },
  });
  return res;
}

/** NEWSLETTER-RUTINA-1 · etapa 3. Entre los envíos que la web lista en la ventana
 *  de la fecha, el nuestro es el de mismo asunto (sin mayúsculas ni espacios de
 *  más); si el asunto se repite —una rutina que titula igual cada semana—, el más
 *  cercano a nuestra hora de envío. 0 = no está (todavía). */
export function eligeMailing(
  emails: Array<{ mailingId: number | string; subject: string; scheduledAt?: string | null }>,
  subject: string,
  sentAt: number,
): number {
  const norm = (x: string): string => String(x || "").trim().toLowerCase().replace(/\s+/g, " ");
  const quiero = norm(subject);
  if (!quiero) return 0;
  const dist = (e: { scheduledAt?: string | null }): number => {
    const t = e.scheduledAt ? new Date(e.scheduledAt).getTime() : NaN;
    return Number.isFinite(t) ? Math.abs(t - sentAt) : Number.MAX_SAFE_INTEGER;
  };
  const c = (emails || [])
    .filter((e) => Number(e.mailingId) > 0 && norm(e.subject) === quiero)
    .sort((a, b) => dist(a) - dist(b));
  return c.length ? Number(c[0].mailingId) : 0;
}
