/**
 * AGENDA-BOT-1 · La agenda REAL del negocio, para que el bot proponga citas
 * con fundamento en vez de inventarse horas.
 *
 * La DISPONIBILIDAD (evento objetivo, duración, franjas semanales) vive en la
 * CONFIGURACIÓN de conocimiento anexada al perfil (knowledge.packs → agenda):
 * cada campaña/perfil puede tener la suya. Lo OCUPADO es global del negocio
 * — reservas web sincronizadas (app_sio_bookings, cualquier evento) y
 * reuniones manuales del panel — porque el tiempo del negocio es uno.
 *
 * La verdad última sigue siendo el calendario de la web: el bot PROPONE huecos
 * y la reserva solo queda confirmada cuando el cliente la hace por el enlace.
 * Sin configuración anexada o sin huecos → se dice tal cual, nunca se finge.
 */
import { get } from "./settings.js";
import { dbSioBookingsRange, dbListContacts } from "./db.js";
import { currentWorkspaceId } from "./workspace.js";
import { knowledgePacks, packsDeBot, type PackAgenda, type Bot, type KnowledgePack } from "./bots.js";

export interface AgendaHueco { ts: number; label: string; }

export interface AgendaResumen {
  configurada: boolean;
  evento: string;
  duracionMin: number;
  tz: string;
  huecos: AgendaHueco[];
  /** Cuando no hay huecos o falta config: el porqué, en cristiano. */
  motivo: string;
}

const DIAS_VISTA = 7;
const MIN_ANTELACION_MS = 2 * 3600000; // no proponer huecos a menos de 2 h
const MAX_POR_DIA = 3;
const MAX_TOTAL = 8;

/** Offset del huso en ese instante (p. ej. GMT+02:00 → 7.2e6 ms), vía Intl. */
function tzOffsetMs(ts: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(ts));
    const name = parts.find((p) => p.type === "timeZoneName")?.value || "";
    const m = name.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * ((+m[2]) * 60 + (+(m[3] || 0))) * 60000;
  } catch { return 0; }
}

/** Epoch de «ese día a las HH:MM» EN el huso tz. Doble pasada por si el offset
 *  cambia justo en un cambio de hora (peor caso: 1 h de error ese único día). */
function epochAt(y: number, mo: number, d: number, hh: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, hh, mi);
  let off = tzOffsetMs(guess, tz);
  off = tzOffsetMs(guess - off, tz);
  return guess - off;
}

/** Epoch de un hh:mm del día: en el huso del negocio si está configurado; si
 *  no, en la hora LOCAL del proceso — la misma con la que se pintan los
 *  rótulos (mezclar UTC en el cálculo con local en el rótulo desplazaba todo). */
function slotEpoch(y: number, mo: number, d: number, hh: number, mi: number, tz: string): number {
  return tz ? epochAt(y, mo, d, hh, mi, tz) : new Date(y, mo - 1, d, hh, mi).getTime();
}

function parseRangos(txt: string): Array<{ h1: number; m1: number; h2: number; m2: number }> {
  const out: Array<{ h1: number; m1: number; h2: number; m2: number }> = [];
  for (const tramo of String(txt || "").split(",")) {
    const m = tramo.trim().match(/^(\d{1,2}):(\d{2})\s*[-–a]+\s*(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const h1 = +m[1], m1 = +m[2], h2 = +m[3], m2 = +m[4];
    if (h1 > 23 || h2 > 24 || (h2 === 24 && m2 !== 0) || m1 > 59 || m2 > 59) continue;
    if (h2 * 60 + m2 <= h1 * 60 + m1) continue;
    out.push({ h1, m1, h2, m2 });
  }
  return out;
}

// Lo OCUPADO toca BD (reservas + contactos): se cachea 60 s por workspace.
// El cálculo de huecos por configuración es barato y se hace al vuelo.
const busyCache = new Map<string, { at: number; busy: Array<{ a: number; b: number }> }>();

async function ocupado(fresco?: boolean): Promise<Array<{ a: number; b: number }>> {
  const ws = currentWorkspaceId();
  const hit = busyCache.get(ws);
  if (!fresco && hit && Date.now() - hit.at < 60000) return hit.busy;
  const now = Date.now();
  const hasta = now + (DIAS_VISTA + 1) * 86400000; // cubre también el día de 25 horas
  const busy: Array<{ a: number; b: number }> = [];
  try {
    for (const b of await dbSioBookingsRange(now - 4 * 3600000, hasta)) {
      if (String(b.status || "").toUpperCase() === "CANCELLED" || !b.booked_at) continue;
      busy.push({ a: b.booked_at, b: b.booked_at + Math.max(10, Number(b.duration_min) || 30) * 60000 });
    }
  } catch { /* sin reservas legibles: se calcula solo contra reuniones */ }
  try {
    for (const c of await dbListContacts(5000)) {
      const at = Number(c.next_action_at || 0);
      if (at > now - 4 * 3600000 && at < hasta) busy.push({ a: at, b: at + 3600000 });
    }
  } catch { /* ídem */ }
  busyCache.set(ws, { at: Date.now(), busy });
  return busy;
}

/** Resumen de agenda PARA UNA CONFIGURACIÓN de conocimiento (por id). */
export async function agendaResumenPack(packId: string, fresco?: boolean): Promise<AgendaResumen> {
  const tz = (() => { const t = (get("biz.timezone") || "").trim(); if (!t) return "";
    try { new Date().toLocaleString("es-ES", { timeZone: t }); return t; } catch { return ""; } })();
  const pack = knowledgePacks().find((p) => p.id === String(packId || ""));
  const cfg: PackAgenda | null = (pack && pack.agenda) || null;
  if (!cfg) {
    return { configurada: false, evento: "", duracionMin: 30, tz, huecos: [], motivo: pack ? "La configuración «" + (pack.name || pack.id) + "» no tiene agenda: rellena su horario semanal en Conocimiento." : "Sin configuración de conocimiento anexada." };
  }

  const now = Date.now();
  const busy = await ocupado(fresco);
  const fmtDia = new Intl.DateTimeFormat("en-US", tz ? { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", weekday: "short" } : { year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
  const fmtLabelDia = new Intl.DateTimeFormat("es-ES", tz ? { timeZone: tz, weekday: "short", day: "numeric" } : { weekday: "short", day: "numeric" });
  const fmtLabelHora = new Intl.DateTimeFormat("es-ES", tz ? { timeZone: tz, hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  const WD: Record<string, string> = { Sun: "dom", Mon: "lun", Tue: "mar", Wed: "mie", Thu: "jue", Fri: "vie", Sat: "sab" };

  const huecos: AgendaHueco[] = [];
  const paso = cfg.duracionMin * 60000;
  const hoy = fmtDia.formatToParts(new Date(now));
  const hoyY = Number(hoy.find(p => p.type === "year")?.value);
  const hoyM = Number(hoy.find(p => p.type === "month")?.value);
  const hoyD = Number(hoy.find(p => p.type === "day")?.value);
  for (let i = 0; i < DIAS_VISTA && huecos.length < MAX_TOTAL; i++) {
    // Días de calendario del negocio, no bloques de 24 h: evita duplicar o saltar
    // fechas al cambiar el horario de verano. Mediodía evita transiciones nocturnas.
    const dia = new Date(Date.UTC(hoyY, hoyM - 1, hoyD + i));
    const ref = slotEpoch(dia.getUTCFullYear(), dia.getUTCMonth() + 1, dia.getUTCDate(), 12, 0, tz);
    const partes = fmtDia.formatToParts(new Date(ref));
    const y = +(partes.find((p) => p.type === "year")?.value || 0);
    const mo = +(partes.find((p) => p.type === "month")?.value || 0);
    const d = +(partes.find((p) => p.type === "day")?.value || 0);
    const wd = WD[partes.find((p) => p.type === "weekday")?.value || ""] || "";
    if (!y || !mo || !d || !wd) continue;
    const rangos = parseRangos(cfg.horario[wd] || "");
    let delDia = 0;
    for (const r of rangos) {
      for (let t = slotEpoch(y, mo, d, r.h1, r.m1, tz); t + paso <= slotEpoch(y, mo, d, r.h2, r.m2, tz); t += paso) {
        if (t < now + MIN_ANTELACION_MS) continue;
        if (busy.some((x) => t < x.b && t + paso > x.a)) continue;
        huecos.push({ ts: t, label: fmtLabelDia.format(new Date(t)) + " · " + fmtLabelHora.format(new Date(t)) });
        delDia++;
        if (delDia >= MAX_POR_DIA || huecos.length >= MAX_TOTAL) break;
      }
      if (delDia >= MAX_POR_DIA || huecos.length >= MAX_TOTAL) break;
    }
  }

  return {
    configurada: true,
    evento: cfg.evento,
    duracionMin: cfg.duracionMin,
    tz,
    huecos,
    motivo: huecos.length ? "" : "No queda ningún hueco libre en los próximos " + DIAS_VISTA + " días (o la antelación mínima de 2 h los descarta).",
  };
}

/** AGENDA-PRINCIPAL-1 (BOT-06) · De qué agenda salen las citas de un perfil,
 *  sin reglas ocultas. Un perfil puede llevar varias fichas, pero solo propone
 *  UNA agenda (mezclar dos disponibilidades daría horas que no existen):
 *  - «elegida»: la elegida a mano (agendaPackId) sigue marcada y con horario.
 *  - «unica»: sin elección, solo una de sus fichas tiene agenda.
 *  - «ambigua»: sin elección y con varias. Se sigue usando la primera (lo que
 *    hacía siempre: los perfiles ya guardados no cambian) y el panel avisa para
 *    que se elija; el editor no deja guardar sin elegir.
 *  - «no-disponible»: la elegida ya no existe, perdió el horario o se desmarcó.
 *    El perfil NO propone horas hasta corregirlo: jamás salta a otra agenda en
 *    silencio.
 *  - «sin-agenda»: ninguna de sus fichas tiene agenda.
 *  Espejo en el panel: beAgendaDe() (admin.ts). Si cambia uno, cambia el otro. */
export type EstadoAgendaPerfil = "elegida" | "unica" | "ambigua" | "no-disponible" | "sin-agenda";
export interface AgendaDePerfil {
  estado: EstadoAgendaPerfil;
  /** Ficha cuya agenda propone; null si el perfil no propone horas. */
  pack: KnowledgePack | null;
  /** Fichas del perfil con agenda, en su orden. */
  candidatas: Array<{ id: string; name: string }>;
  /** En «no-disponible», el porqué en cristiano (sin punto final). */
  motivo: string;
}
export function agendaDePerfil(bot: Bot): AgendaDePerfil {
  const propias = packsDeBot(bot);
  const conAgenda = propias.filter((p) => p.agenda);
  const candidatas = conAgenda.map((p) => ({ id: p.id, name: p.name || p.id }));
  const elegida = String(bot.agendaPackId || "").trim();
  if (elegida) {
    const pack = conAgenda.find((p) => p.id === elegida);
    if (pack) return { estado: "elegida", pack, candidatas, motivo: "" };
    const existe = knowledgePacks().find((p) => p.id === elegida);
    const nombre = existe ? "«" + (existe.name || existe.id) + "»" : "";
    const motivo = !existe ? "la ficha de su agenda ya no existe"
      : !propias.some((p) => p.id === elegida) ? "la ficha " + nombre + " ya no está marcada en este perfil"
      : "la ficha " + nombre + " ya no tiene horario de citas";
    return { estado: "no-disponible", pack: null, candidatas, motivo };
  }
  if (!conAgenda.length) return { estado: "sin-agenda", pack: null, candidatas, motivo: "" };
  return { estado: conAgenda.length > 1 ? "ambigua" : "unica", pack: conAgenda[0], candidatas, motivo: "" };
}

/** Bloque de prompt con la agenda del perfil (ver agendaDePerfil). '' si no
 *  tiene ficha con agenda. Si la que eligió ya no vale, se le prohíbe proponer
 *  horas en vez de dejarle improvisarlas. */
export async function agendaPromptBlockBot(bot: Bot): Promise<string> {
  const a = agendaDePerfil(bot);
  if (a.estado === "no-disponible") {
    return "\n\n# Agenda para proponer cita" +
      "\nAhora mismo NO tienes agenda: no propongas días ni horas concretos (JAMÁS inventes una hora). Si el cliente quiere cita, comparte el enlace de reservas si lo tienes; si no, ofrécele pasarle con el equipo.";
  }
  return a.pack ? await agendaPromptBlock(a.pack.id) : "";
}

/** AGENDA-PRINCIPAL-1 · Bloque de RESERVAS del system: enlace de reservas +
 *  agenda del perfil. Lo usan la conversación real (brain.ts) y la prueba del
 *  panel, para que lo que la prueba dice de la agenda sea lo que hará el bot.
 *  Si algo falla, se queda con lo que haya podido montar (nunca tumba al bot). */
export async function bloqueReservasBot(bot: Bot): Promise<string> {
  let out = "";
  try {
    const burl = get("booking.url");
    if (burl) out = "\n\n# Reservas\nSi el cliente quiere agendar/reservar (cita, llamada, mesa…), comparte EXACTAMENTE este enlace sin modificarlo: " + burl;
    const ag = await agendaPromptBlockBot(bot);
    if (ag) out += ag;
  } catch { /* sin reservas configuradas */ }
  return out;
}
export async function agendaPromptBlock(packId?: string): Promise<string> {
  if (!packId) return "";
  const r = await agendaResumenPack(packId);
  if (!r.configurada) return "";
  const cab = "\n\n# Agenda para proponer cita" +
    "\nCita objetivo: " + (r.evento ? "«" + r.evento + "»" : "la cita del negocio") + " (" + r.duracionMin + " min)." + (r.tz ? " Zona horaria: " + r.tz + "." : "");
  if (!r.huecos.length) {
    return cab + "\nAhora mismo NO queda ningún hueco libre en los próximos " + DIAS_VISTA + " días. Dilo con honestidad y comparte el enlace de reservas para que el cliente elija en el calendario completo. JAMÁS inventes una hora.";
  }
  return cab +
    "\nHuecos libres REALES ahora mismo: " + r.huecos.map((h) => h.label).join(" · ") + "." +
    "\nReglas: propón 2-3 de ESOS huecos (nunca otros; no inventes horas). La cita solo queda confirmada cuando el cliente reserva en el enlace de reservas — tú propones, el enlace confirma. Si ninguno le encaja, comparte el enlace para que elija en el calendario completo.";
}
