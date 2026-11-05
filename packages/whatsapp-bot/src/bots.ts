/**
 * Personalidades de bot, editables desde el panel (clave de settings
 * `bots.json`). La base de conocimiento (`knowledge.negocio`) se inyecta en
 * el system de cada bot. Sin perfiles configurados, el asistente no responde.
 */
import { get } from "./settings.js";
import { REGLA_IDENTIDAD_IA, REGLA_NO_INVENTAR, KB_VACIA } from "./ai-compliance.js";

export interface Bot {
  id: string;
  system: string;
  greeting?: string;
  /** Nombre legible del perfil (p.ej. "Setter Black Friday"). Si falta, se usa el id. */
  name?: string;
  /** Campaña a la que pertenece este perfil (etiqueta libre, opcional). */
  campaign?: string;
  /** Base de conocimiento PROPIA de este bot/campaña. Se suma a la común del negocio. */
  knowledge?: string;
  /** PACKS-KB-1 · Ficha de conocimiento anexada (id de knowledge.packs).
   *  LEGADO: quedó cuando solo se podía elegir UNA. Se sigue leyendo. */
  knowledgePackId?: string;
  /** PACKS-KB-2 · Fichas anexadas a este perfil (varias). La master del negocio
   *  la llevan todos y no está en esta lista. Orden = orden en el prompt. */
  knowledgePackIds?: string[];
  /** AGENDA-PRINCIPAL-1 (BOT-06) · ficha cuya agenda usa este perfil para
   *  proponer citas, elegida a mano. Si falta y el perfil tiene una sola ficha
   *  con agenda, se usa esa. Si apunta a una ficha que ya no está o que perdió
   *  el horario, el perfil NO propone horas (nunca salta a otra agenda en
   *  silencio). Ver agendaDePerfil() en agenda.ts. */
  agendaPackId?: string;
  /** Palabras que enrutan a este bot (regex, opcional — fallback si la IA falla). */
  routeKeywords?: string;
  /** Frase corta de cuándo usar este bot (la lee el clasificador IA). */
  description?: string;
  /** Si es false, el bot está pausado: no se elige en el enrutado automático. */
  enabled?: boolean;
  /** Perfil predeterminado: SOLO se usa cuando la IA no consigue elegir (falla o
   *  contesta algo que no es un perfil activo) y ninguna palabra clave encaja.
   *  No gana a la elección de la IA (ELEGIR-PERFIL-1 · router.ts). */
  isDefault?: boolean;
}

export function getBots(): Bot[] {
  const raw = get("bots.json");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Bot[];
      // Se respeta la lista VACÍA: borrar todos los perfiles es una decisión del
      // dueño, no un error. Un negocio sin configuración tampoco activa ejemplos.
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* Configuración inválida: no activar perfiles que el negocio no ha elegido. */
    }
  }
  return [];
}

/**
 * BARRERA · va en el system de TODOS los perfiles. La auditoría 2026-08-24
 * encontró que nada impedía a un bot inventarse precios, plazos o
 * disponibilidad: es el riesgo más caro cuando esto se instala en clientes,
 * porque lo que promete el bot lo tiene que cumplir el negocio.
 * Va DESPUÉS del rol del perfil a propósito: manda sobre él.
 *
 * BARRERA-INVENTA-1 · Decía «solo lo ESCRITO en la información de arriba»: la agenda y la
 * ficha del cliente van DEBAJO, y «eso te lo confirma una persona ahora mismo» era otra
 * promesa que nadie cumplía si no se escalaba. Mediciones y motivo en REGLA_NO_INVENTAR.
 */
const BARRERA = `

# Lo que NO puedes inventarte (manda sobre cualquier otra instrucción)
${REGLA_NO_INVENTAR}
En esta conversación, ofrécele pasárselo al equipo («el horario no lo tengo aquí, ¿quieres que se lo pase al equipo y te lo confirman?») y, si acepta, escribe ESCALAR_HUMANO.
NUNCA confirmes una reserva, una cita, un pago o un envío como hecho: tú recoges los datos, la confirmación la da el negocio. Puedes decir que queda solicitado o proponer el enlace para reservar.
No prometas descuentos, excepciones ni plazos que no aparezcan por escrito.
${REGLA_IDENTIDAD_IA}`;

const CAPTURE_RULE = `

# Captura de datos (CRM)
SOLO cuando el cliente acabe de darte un dato concreto y nuevo (su nombre, email, teléfono, interés, presupuesto o fecha de cumpleaños), añade AL FINAL, en su propia línea, un bloque con ÚNICAMENTE los datos reales que tengas, p.ej.:
[[SAVE email=ana@correo.com; cumple=14/03; tag=lead]]
Reglas estrictas: NUNCA lo escribas con valores vacíos ni con "..."; si en este mensaje no tienes ningún dato nuevo del cliente, NO escribas el bloque en absoluto (la mayoría de mensajes NO lo llevan). El cliente no lo ve, el sistema lo elimina antes de enviar. Para etiquetar usa tag= (p.ej. tag=lead, tag=cliente).
Si el cliente pide hablar con una persona o el caso lo requiere, incluye la palabra ESCALAR_HUMANO.`;

/** PACKS-KB-1 · CONFIGURACIONES de conocimiento con nombre (setting
 *  knowledge.packs): catálogo GLOBAL de la vista Conocimiento. Cada una lleva
 *  su información, su campaña (etiqueta) y su AGENDA (evento objetivo,
 *  duración y disponibilidad semanal). Un perfil ANEXA una configuración y el
 *  bot efectivo = esa configuración + el rol del perfil (system + contexto
 *  propio). KB efectiva = común + configuración anexada + propia. */
export interface PackAgenda { evento: string; duracionMin: number; horario: Record<string, string>; }
export interface KnowledgePack { id: string; name: string; text: string; campaign?: string; agenda?: PackAgenda | null; }
const DIAS_PACK = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"];
export function knowledgePacks(): KnowledgePack[] {
  try {
    const raw = JSON.parse(get("knowledge.packs") || "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map((p) => {
      const pp = (p || {}) as Record<string, unknown>;
      let agenda: PackAgenda | null = null;
      const ag = (pp.agenda || null) as Record<string, unknown> | null;
      if (ag && typeof ag === "object") {
        const horario: Record<string, string> = {};
        const h = (ag.horario || {}) as Record<string, unknown>;
        let alguno = false;
        for (const d of DIAS_PACK) { const v = String(h[d] || "").trim(); horario[d] = v; if (v) alguno = true; }
        if (alguno) agenda = { evento: String(ag.evento || "").slice(0, 200), duracionMin: Math.min(240, Math.max(10, Number(ag.duracionMin) || 30)), horario };
      }
      return { id: String(pp.id || ""), name: String(pp.name || "").slice(0, 120), text: String(pp.text || ""), campaign: String(pp.campaign || "").slice(0, 120), agenda };
    }).filter((p) => p.id && (p.name || p.text || p.agenda)).slice(0, 12);
  } catch { return []; }
}

/** PACKS-KB-2 · Fichas anexadas a un perfil, en orden y sin repetidas. Acepta el
 *  campo nuevo (varias) y el legado de cuando solo se podía elegir una. */
export function packsDeBot(bot: Bot): KnowledgePack[] {
  const ids: string[] = [];
  for (const id of (Array.isArray(bot.knowledgePackIds) ? bot.knowledgePackIds : [])) {
    const s = String(id || "").trim();
    if (s && ids.indexOf(s) < 0) ids.push(s);
  }
  const legado = String(bot.knowledgePackId || "").trim();
  if (legado && ids.indexOf(legado) < 0) ids.push(legado);
  if (!ids.length) return [];
  const todas = knowledgePacks();
  return ids.map((id) => todas.find((p) => p.id === id)).filter((p): p is KnowledgePack => !!p);
}

/** System efectivo = system del bot + voz de marca + base(s) de conocimiento + regla de captura.
 *  KB efectiva = la MASTER del negocio (knowledge.negocio, la llevan todos los perfiles) +
 *  las FICHAS anexadas al perfil (knowledge.packs, pueden ser varias) +
 *  las NOTAS propias de este bot (bot.knowledge). Así no se repite la info común. */
export function systemFor(bot: Bot): string {
  const common = (get("knowledge.negocio") || "").trim();
  const own = (bot.knowledge || "").trim();
  const brand = get("brand");
  // VOZ-PRIORIDAD-1 (BOT-07) · la voz de marca es la pauta COMÚN; si choca con la
  // personalidad del perfil (bot.system, que va antes), manda el perfil. Es la misma
  // regla que explica el panel junto a los dos campos, y la prueba usa este system.
  const brandBlock = brand ? `\n\n# Voz de marca / tono (pauta común de todos los perfiles: aplícala siempre, salvo en lo que tus instrucciones de arriba pidan otra cosa; si chocan, mandan tus instrucciones)\n${brand}` : "";
  const kbParts: string[] = [];
  if (common) kbParts.push(`# Información del negocio\n${common}`);
  for (const pack of packsDeBot(bot)) {
    if (pack.text.trim()) kbParts.push(`# Ficha «${pack.name || pack.id}»${pack.campaign ? ` · campaña «${pack.campaign}»` : ""}\n${pack.text.trim()}`);
  }
  if (own) kbParts.push(`# Notas propias de este bot${bot.campaign ? ` · campaña «${bot.campaign}»` : ""}\n${own}`);
  const kbBlock = kbParts.length ? `\n\n${kbParts.join("\n\n")}` : `\n\n# Información del negocio\n${KB_VACIA}`; // BARRERA-INVENTA-1
  return `${bot.system}${brandBlock}${kbBlock}${BARRERA}${CAPTURE_RULE}`;
}

/**
 * ELEGIR-PERFIL-1 (BOT-05) · El respaldo cuando la IA no decide, con el MOTIVO
 * de la elección, para que el simulador del panel («Comprobar quién
 * contestaría») cuente lo mismo que hace el motor y no una versión aparte.
 *
 *   palabra        → el PRIMER perfil activo (en el orden de la lista) cuyas
 *                    palabras clave internas encajan. Empate = gana el de arriba.
 *   predeterminado → ninguna palabra encaja y hay un perfil activo marcado como
 *                    predeterminado (el panel solo deja marcar uno; si hubiera
 *                    dos, gana el de arriba).
 *   primero        → ni palabra ni predeterminado activo: el primero activo.
 *   ninguno        → no hay ningún perfil activo: no contesta nadie.
 */
export type ViaRespaldo = "palabra" | "predeterminado" | "primero" | "ninguno";

export function routeBotConMotivo(firstMessage: string): { bot: Bot | null; via: ViaRespaldo } {
  const all = getBots();
  // Los bots pausados no entran en el enrutado automático. Con TODOS pausados
  // no se repesca a nadie: antes `pool = all` devolvía un perfil pausado y
  // «pausado» no pausaba nada. Sin activos, no atiende nadie.
  const pool = all.filter((b) => b.enabled !== false);
  if (!pool.length) return { bot: null, via: "ninguno" };
  const t = firstMessage.toLowerCase();
  for (const b of pool) {
    if (b.routeKeywords) {
      try {
        if (new RegExp(b.routeKeywords, "i").test(t)) return { bot: b, via: "palabra" };
      } catch {
        /* regex inválida → ignora */
      }
    }
  }
  const def = pool.find((b) => b.isDefault);
  if (def) return { bot: def, via: "predeterminado" };
  return { bot: pool[0], via: "primero" };
}

export function routeBot(firstMessage: string): Bot | null {
  return routeBotConMotivo(firstMessage).bot;
}

/**
 * HORARIO DE ATENCIÓN · fuera de él el bot no improvisa: el mensaje espera en
 * la Bandeja. La auditoría 2026-08-24 lo señaló como el hueco más obvio frente
 * a un producto profesional — hoy el bot contesta a las 3 de la madrugada de
 * un domingo, y eso a un cliente le parece un descuido, no una virtud.
 *
 * Sin configurar = atiende siempre (lo de hoy). Las automatizaciones y los
 * flujos NO se ven afectados: esto solo gobierna la charla libre de la IA.
 */
export type Horario = { activo: boolean; dias: number[]; desde: string; hasta: string; zona: string; aviso: string };

/**
 * HORARIO-REGEX-1 · La validación de «HH:MM» vivía escrita como /^d{2}:d{2}$/
 * (sin las barras invertidas de \d), así que sólo daba por buena la cadena
 * literal «dd:dd»: TODA hora real se descartaba y el horario volvía a
 * 09:00–20:00 sin decir nada. Una sola función, usada por el servidor del panel
 * y por el motor del bot, y con rango de verdad (00-23 : 00-59).
 */
export function horaValida(v: unknown): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));
}

export function horarioBot(): Horario {
  const d: Horario = { activo: false, dias: [1, 2, 3, 4, 5], desde: "09:00", hasta: "20:00", zona: "Europe/Madrid", aviso: "" };
  try {
    const raw = JSON.parse(get("bot.horario") || "{}") as Partial<Horario>;
    return {
      activo: !!raw.activo,
      dias: Array.isArray(raw.dias) && raw.dias.length ? raw.dias.map(Number).filter((x) => x >= 0 && x <= 6) : d.dias,
      desde: horaValida(raw.desde) ? String(raw.desde) : d.desde,
      hasta: horaValida(raw.hasta) ? String(raw.hasta) : d.hasta,
      zona: String(raw.zona || d.zona),
      aviso: String(raw.aviso || "").slice(0, 400),
    };
  } catch { return d; }
}

/** ¿Estamos FUERA del horario de atención ahora mismo? Ante la duda, dentro. */
export function fueraDeHorario(ahora = new Date()): { fuera: boolean; aviso: string } {
  const h = horarioBot();
  if (!h.activo) return { fuera: false, aviso: "" };
  try {
    // La hora del NEGOCIO, no la del servidor (Railway va en UTC).
    const f = new Intl.DateTimeFormat("es-ES", { timeZone: h.zona, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    const partes = Object.fromEntries(f.formatToParts(ahora).map((p) => [p.type, p.value]));
    const dias = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
    const dia = dias.findIndex((x) => String(partes.weekday || "").toLowerCase().startsWith(x.slice(0, 2)));
    const min = Number(partes.hour) * 60 + Number(partes.minute);
    const aMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    const desde = aMin(h.desde), hasta = aMin(h.hasta);
    // Franja que cruza la medianoche (22:00→02:00) se trata al revés.
    const enFranja = desde <= hasta ? min >= desde && min < hasta : min >= desde || min < hasta;
    const enDia = h.dias.includes(dia);
    return { fuera: !(enDia && enFranja), aviso: h.aviso };
  } catch {
    // Zona horaria inválida: mejor atender que callar por un ajuste roto.
    return { fuera: false, aviso: "" };
  }
}

export function botById(id: string): Bot | undefined {
  return getBots().find((b) => b.id === id) ?? getBots()[0];
}

/**
 * El perfil con ese id, o null si NO existe. A diferencia de botById, nunca
 * devuelve «el primero de la lista»: un id de un perfil borrado o renombrado
 * hacía que atendiera otro perfil —con otro catálogo y otros precios— sin que
 * nadie se enterara (auditoría 2026-08-24).
 */
export function botByIdOrNull(id: string): Bot | null {
  if (!id || id === "__none__") return null;
  return getBots().find((b) => b.id === id) ?? null;
}

/**
 * ¿Ese perfil puede atender ahora mismo? Existe Y no está pausado.
 * PAUSADO = NO ATIENDE A NADIE, tampoco en la cuenta que lo tenga fijado:
 * es lo que el dueño entiende al leer «pausado», y lo que la pantalla promete.
 */
export function perfilDisponible(id: string): Bot | null {
  const b = botByIdOrNull(id);
  return b && b.enabled !== false ? b : null;
}

/**
 * QUIÉN ATIENDE · única fuente de verdad, compartida por WhatsApp, Instagram y
 * Facebook. Antes cada canal repetía la misma cadena de ternarios y los tres
 * caían en el mismo agujero: un id de perfil borrado se resolvía al primero de
 * la lista y un perfil pausado seguía contestando (auditoría 2026-08-24).
 *
 *   atiende → responde ese perfil.
 *   callar  → NO responde nadie y el motivo se escribe en la Bandeja. Pasa
 *             cuando el perfil elegido a mano está pausado: pausado es pausado,
 *             y saltar a otro perfil sería contestar con otro catálogo.
 *   enrutar → nadie lo ha fijado (o el que había ya no existe): que decida la IA.
 */
export type Atencion =
  | { estado: "atiende"; bot: Bot }
  | { estado: "callar"; motivo: string }
  | { estado: "enrutar" };

export function quienAtiende(pegado: string, fijado: string): Atencion {
  for (const [id, donde] of [[pegado, "de esta conversación"], [fijado, "fijado a esta cuenta"]] as const) {
    if (!id || id === "__none__") continue;
    const bot = botByIdOrNull(id);
    // Perfil borrado o renombrado: NO hereda la conversación otro perfil.
    // Se sigue buscando (y, si nadie más lo reclama, decide la IA).
    if (!bot) continue;
    if (bot.enabled === false) return { estado: "callar", motivo: `el perfil «${bot.name || bot.id}» ${donde} está pausado` };
    return { estado: "atiende", bot };
  }
  if (!hayPerfilesActivos()) return { estado: "callar", motivo: "no hay ningún perfil activo" };
  return { estado: "enrutar" };
}

/** ¿Queda algún perfil sin pausar? Si no, no atiende nadie: no se improvisa. */
export function hayPerfilesActivos(): boolean {
  return getBots().some((b) => b.enabled !== false);
}

/**
 * ESTADO-PERFIL-1 (BOT-03) · ¿Quién responde AHORA a una conversación NUEVA,
 * cuenta por cuenta, y qué significa eso para cada perfil? Es la decisión del
 * motor (index.ts, los tres canales y el puente de TikTok), sin llamar a la IA
 * ni tocar nada:
 *   1. el horario de atención (fueraDeHorario) calla la charla libre, salvo en
 *      TikTok, cuyo puente no lo mira;
 *   2. el interruptor del canal (autoReplyOn) y la cuenta en «solo humano»
 *      (SOLO-HUMANO-1) callan igual;
 *   3. y quienAtiende("", fijo) decide: el perfil fijo, «calla» si está
 *      pausado o no queda ninguno activo, o la IA elige entre los activos.
 * Las conversaciones que ya tenían perfil siguen con él (quienAtiende mira
 * antes la conversación): esto describe las nuevas. Lo pinta el panel en cada
 * tarjeta de perfil y en el resumen del estado de la IA. `botId` de cada
 * cuenta debe venir resuelto COMO LO RESUELVE EL MOTOR (listWaNumbers para
 * WhatsApp, botForAccount para Instagram y Facebook).
 */
export type CuentaMotor = { key: string; canal: string; botId: string };
export type CuentaAhora = {
  key: string;
  canal: string;
  /** Interruptor de la IA del canal. */
  canalOn: boolean;
  /** Fuera del horario de atención (en TikTok, nunca). */
  fueraDeHorario: boolean;
  /** Con el canal encendido y en horario: id del perfil fijo que responde,
   *  «*» = la IA elige entre los perfiles activos, «» = no responde nadie. */
  responde: string;
  /** Si responde === "": por qué. */
  calla?: "solo-humano" | "perfil-pausado" | "sin-perfiles";
};
export type PerfilAhora = {
  id: string;
  /** Su propia preferencia: activo o pausado (la casilla del editor). */
  activo: boolean;
  /** Cuentas donde es el perfil fijo y qué pasa ahora en cada una. */
  fijas: Array<{ key: string; ahora: "responde" | "pausado" | "canal-apagado" | "fuera-de-horario" }>;
  /** Cuentas sin perfil fijo (claves), donde entra si la IA lo elige. */
  libres: { responde: string[]; canalApagado: string[]; fueraDeHorario: string[] };
  /** Único perfil activo: en las cuentas sin perfil fijo responde siempre él. */
  unico: boolean;
  /** ¿Respondería ahora a una conversación nueva en alguna cuenta? */
  puede: boolean;
};
export function quienRespondeAhora(
  cuentas: CuentaMotor[],
  canalOn: (canal: string) => boolean,
  fuera: boolean = fueraDeHorario().fuera,
): { cuentas: CuentaAhora[]; perfiles: PerfilAhora[] } {
  const perfiles = getBots();
  const nActivos = perfiles.filter((b) => b.enabled !== false).length;
  const cs: CuentaAhora[] = cuentas.map((c) => {
    const base = { key: c.key, canal: c.canal, canalOn: canalOn(c.canal), fueraDeHorario: fuera && c.canal !== "tiktok" };
    if (c.botId === "__none__") return { ...base, responde: "", calla: "solo-humano" as const };
    const at = quienAtiende("", c.botId || "");
    if (at.estado === "atiende") return { ...base, responde: at.bot.id };
    if (at.estado === "enrutar") return { ...base, responde: "*" };
    return { ...base, responde: "", calla: botByIdOrNull(c.botId || "") ? ("perfil-pausado" as const) : ("sin-perfiles" as const) };
  });
  const ps: PerfilAhora[] = perfiles.map((b) => {
    const activo = b.enabled !== false;
    const fijas: PerfilAhora["fijas"] = [];
    const libres: PerfilAhora["libres"] = { responde: [], canalApagado: [], fueraDeHorario: [] };
    cs.forEach((c, i) => {
      if (cuentas[i].botId === b.id) {
        fijas.push({ key: c.key, ahora: !activo ? "pausado" : !c.canalOn ? "canal-apagado" : c.fueraDeHorario ? "fuera-de-horario" : "responde" });
      } else if (c.responde === "*" && activo) {
        if (!c.canalOn) libres.canalApagado.push(c.key);
        else if (c.fueraDeHorario) libres.fueraDeHorario.push(c.key);
        else libres.responde.push(c.key);
      }
    });
    const puede = activo && (fijas.some((f) => f.ahora === "responde") || libres.responde.length > 0);
    return { id: b.id, activo, fijas, libres, unico: activo && nActivos === 1, puede };
  });
  return { cuentas: cs, perfiles: ps };
}
