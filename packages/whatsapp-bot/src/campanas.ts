/**
 * CAMPANAS-1 (MET-AUTO-01 · MET-AUTO-03 · MET-AUTO-04) · una campaña es un grupo de flujos que
 * persiguen el mismo objetivo, a veces en varios canales. Módulo PURO (sin base de datos): las
 * consultas viven en db.ts (`dbCampanas*`), los endpoints en admin.ts (`/admin/api/campanas*`) y la
 * pestaña Automatización pinta lo que sale de aquí.
 *
 * Reglas (cada una con su porqué):
 *  · Una campaña NO fusiona flujos: los agrupa. Cada uno conserva su identidad, canal y disparador.
 *  · Una persona que recorre tres flujos de la campaña es UNA participante. Se cuenta por persona
 *    fundida (identidad.ts), no por ficha ni por flujo. Si no hay forma de unir sus fichas
 *    (Instagram → WhatsApp sin teléfono ni correo) son dos personas: nunca se inventa la unión.
 *  · Un flujo que está en varias campañas NO se suma a todas. Estos eventos no guardan el contexto
 *    de campaña: sus entradas quedan «sin asignar». Haber entrado antes a otro flujo no acredita
 *    una transición ni permite adjudicar la ejecución compartida por proximidad temporal.
 *  · Solo cuenta lo ocurrido dentro de la vigencia de la campaña (inicio / fin) y del periodo mirado.
 *  · Reserva y compra se miden solo si hay reservas / ventas conectadas y la persona tiene un correo
 *    con el que unirlas. Si no: «sin medir» (null), nunca 0. Un 0 es un 0 medido.
 *  · Una comparación solo se hace con muestra suficiente (MUESTRA_MIN personas en los dos lados).
 *  · Una flecha del mapa es una unión verificable: un paso «lanza otro flujo» (configurado) o la
 *    misma persona entrando en el flujo siguiente (observado). Nada se deduce por nombres parecidos.
 */
import { fundirPersonas, type Canal, type FichaIdentidad } from "./identidad.js";

/** Con menos personas que esto no se compara ni se ordena nada: la diferencia sería ruido. */
export const MUESTRA_MIN = 20;

export type ObjetivoCampana = "completar" | "reserva" | "compra";
export const OBJETIVOS_CAMPANA: ObjetivoCampana[] = ["completar", "reserva", "compra"];
export type CanalFlujo = "wa" | "ig" | "fb" | "yt" | "li" | "email";

export interface CampanaDef {
  id: string;
  name: string;
  offer: string;
  objective: ObjetivoCampana;
  /** Inicio y fin de la vigencia (epoch ms). null = sin límite. */
  startsAt: number | null;
  endsAt: number | null;
  flowIds: string[];
  createdAt: number;
}
export interface FlujoCampana {
  id: string;
  name: string;
  enabled: boolean;
  canal: CanalFlujo | null;
  /** Última edición del flujo (epoch ms; 0 = desconocida). */
  updatedAt: number;
  /** Flujos que lanza un paso «lanza otro flujo» de este (configuración, no deducción). */
  lanza: string[];
  /** MET-AUTO-04-FIN · primera página web que enlaza (enlace de un mensaje o de reservas) y primer mensaje que envía. */
  web?: string;
  mensaje?: string;
}
export interface EventoCampana { flow: string; key: string; event: string; at: number }
export interface HitosExternos {
  reservas: { medible: boolean; filas: Array<{ email: string; at: number }> };
  compras: { medible: boolean; filas: Array<{ email: string; at: number }> };
}
export interface IndicePersonas {
  /** Persona (fundida) a la que pertenece una clave de contacto. Sin ficha: la clave misma. */
  personaDe(clave: string): string;
  correosDe(persona: string): string[];
  canalesDe(persona: string): Canal[];
}

/** Canal de un flujo según su disparador (misma convención que analytics.ts). Sin canal externo: null. */
export function canalDeDisparador(t: string | undefined): CanalFlujo | null {
  if (t === "wa_keyword" || t === "wa_any") return "wa";
  if (t === "ig_comment" || t === "ig_story" || t === "ig_dm") return "ig";
  if (t === "fb_comment") return "fb";
  if (t === "yt_comment") return "yt";
  if (t === "li_comment") return "li";
  if (t === "email") return "email";
  return null;
}
/** Un flujo del motor, reducido a lo que una campaña necesita. `lanza` sale de sus pasos «lanza otro flujo». */
export function aFlujoCampana(f: {
  id: string; name: string; enabled: boolean; updatedAt?: number;
  trigger?: { type?: string }; nodes?: Record<string, unknown>;
}): FlujoCampana {
  const lanza = new Set<string>();
  let web = "", mensaje = "";
  for (const n of Object.values(f.nodes || {})) {
    const x = (n || {}) as { startFlow?: unknown; type?: unknown; text?: unknown; link?: unknown; bookingUrl?: unknown };
    if (typeof x.startFlow === "string" && x.startFlow) lanza.add(x.startFlow);
    // MET-AUTO-04-FIN · solo direcciones http(s): nada de javascript: ni rutas internas en un enlace del panel.
    for (const u of [x.link, x.bookingUrl]) if (!web && typeof u === "string" && /^https?:\/\//i.test(u.trim())) web = u.trim().slice(0, 500);
    if (!mensaje && x.type === "message" && typeof x.text === "string" && x.text.trim()) mensaje = x.text.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  return { id: f.id, name: f.name, enabled: !!f.enabled, canal: canalDeDisparador(f.trigger?.type), updatedAt: Number(f.updatedAt) || 0, lanza: [...lanza], ...(web ? { web } : {}), ...(mensaje ? { mensaje } : {}) };
}

/** Funde las fichas en personas y devuelve cómo preguntarles. */
export function indexarPersonas(fichas: FichaIdentidad[]): IndicePersonas {
  const idDe = new Map<string, string>();
  const correos = new Map<string, string[]>();
  const canales = new Map<string, Canal[]>();
  fundirPersonas(fichas).forEach((p, i) => {
    const id = "p:" + (p.clave || "#" + i);
    for (const f of p.fichas) idDe.set(String(f.phone || ""), id);
    correos.set(id, p.identificadores.filter((x) => x.startsWith("email:")).map((x) => x.slice(6)));
    canales.set(id, p.canales);
  });
  return {
    personaDe: (clave) => idDe.get(clave) || "k:" + clave,
    correosDe: (persona) => correos.get(persona) || [],
    canalesDe: (persona) => canales.get(persona) || [],
  };
}

interface Paso { first: number; done: boolean }
type PasosDe = Map<string, Map<string, Paso>>; // persona → flujo → paso

function pasosPorPersona(eventos: EventoCampana[], ind: IndicePersonas): PasosDe {
  const out: PasosDe = new Map();
  for (const e of [...eventos].sort((a, b) => a.at - b.at)) {
    const p = ind.personaDe(e.key);
    let m = out.get(p);
    if (!m) { m = new Map(); out.set(p, m); }
    const s = m.get(e.flow);
    if (e.event === "entró") { if (!s) m.set(e.flow, { first: e.at, done: false }); }
    // Un «completó» sin «entró» en el periodo es de una entrada anterior: no es de esta cohorte.
    else if (e.event === "completó" && s) s.done = true;
  }
  return out;
}

export interface Reparto {
  /** campaña → persona → flujo → paso, ya con la vigencia y los flujos compartidos resueltos. */
  porCampana: Map<string, PasosDe>;
  /** campaña → entradas a flujos compartidos que no se pudieron asignar con seguridad. */
  sinAsignar: Map<string, number>;
}

/** Reparte los exclusivos y declara los compartidos sin contexto registrado. */
export function repartir(defs: CampanaDef[], eventos: EventoCampana[], ind: IndicePersonas): Reparto {
  const campsDe = new Map<string, string[]>();
  for (const d of defs) for (const f of new Set(d.flowIds)) {
    const l = campsDe.get(f);
    if (l) l.push(d.id); else campsDe.set(f, [d.id]);
  }
  const porCampana = new Map<string, PasosDe>(defs.map((d) => [d.id, new Map()]));
  const sinAsignar = new Map<string, number>();
  const eventosPorFlujo = new Map<string, EventoCampana[]>();
  for (const e of eventos) {
    if (!campsDe.has(e.flow)) continue;
    const lista = eventosPorFlujo.get(e.flow) || [];
    lista.push(e); eventosPorFlujo.set(e.flow, lista);
  }
  for (const d of defs) {
    // Filtrar ANTES de deduplicar: una entrada anterior no tapa una reentrada válida.
    const vigentes = [...new Set(d.flowIds)].flatMap((f) => eventosPorFlujo.get(f) || [])
      .filter((e) => (d.startsAt == null || e.at >= d.startsAt) && (d.endsAt == null || e.at < d.endsAt));
    for (const [persona, flujos] of pasosPorPersona(vigentes, ind)) {
      for (const [f, s] of flujos) {
        if ((campsDe.get(f)?.length || 0) !== 1) {
          sinAsignar.set(d.id, (sinAsignar.get(d.id) || 0) + 1);
          continue;
        }
        const mapa = porCampana.get(d.id)!;
        let m = mapa.get(persona);
        if (!m) { m = new Map(); mapa.set(persona, m); }
        m.set(f, s);
      }
    }
  }
  return { porCampana, sinAsignar };
}

export interface ResultadoFlujo {
  id: string; name: string; canal: CanalFlujo | null; enabled: boolean;
  /** Personas que entraron en el periodo (asignadas a esta campaña). */
  entradas: number;
  terminaron: number;
  /** Última edición del flujo y cuántas de esas entradas son posteriores: las anteriores son de su versión anterior. */
  editado: number;
  desdeEdicion: number;
  /** El flujo está también en otra campaña. */
  compartido: boolean;
}
export interface ResultadoCampana {
  id: string; name: string; offer: string; objective: ObjetivoCampana;
  startsAt: number | null; endsAt: number | null;
  estado: "activa" | "pausada" | "terminada" | "sin-flujos";
  participantes: number;
  /** Llegaron al final de un flujo final de la campaña (otra vía de resultado cuando el objetivo es reserva o compra). */
  terminaron: number;
  /** Personas que consiguieron el objetivo principal. null = no se puede medir (ver logroMotivo). */
  logro: number | null;
  logroMotivo: string;
  /** Participantes sin correo: no se pueden unir con reservas ni compras. */
  sinCorreo: number;
  sinAsignar: number;
  muestraSuficiente: boolean;
  canales: CanalFlujo[];
  flujos: ResultadoFlujo[];
}

export const ETIQUETA_OBJETIVO: Record<ObjetivoCampana, string> = {
  completar: "Que lleguen al final del recorrido",
  reserva: "Que reserven una llamada",
  compra: "Que compren",
};

export function resultadosCampanas(o: {
  defs: CampanaDef[]; flujos: FlujoCampana[]; eventos: EventoCampana[];
  personas: IndicePersonas; hitos: HitosExternos; ahora: number;
}): { campanas: ResultadoCampana[]; personasUnicas: number; lograronUnicas: number; sinMedir: number } {
  const flujoDe = new Map(o.flujos.map((f) => [f.id, f]));
  const rep = repartir(o.defs, o.eventos, o.personas);
  const unicas = new Set<string>();
  const lograron = new Set<string>();
  let sinMedir = 0;
  const campsDeFlujo = new Map<string, number>();
  for (const d of o.defs) for (const f of new Set(d.flowIds)) campsDeFlujo.set(f, (campsDeFlujo.get(f) || 0) + 1);
  const campanas = o.defs.map((d): ResultadoCampana => {
    const porP = rep.porCampana.get(d.id) || new Map();
    const propios = d.flowIds.map((id) => flujoDe.get(id)).filter((f): f is FlujoCampana => !!f);
    const finales = new Set(
      d.flowIds.filter((id) => !(flujoDe.get(id)?.lanza || []).some((x) => d.flowIds.includes(x))),
    );
    const terminaronSet = new Set<string>();
    for (const [p, fl] of porP) for (const [f, s] of fl) if (s.done && finales.has(f)) terminaronSet.add(p);
    let logro: number | null = null;
    let logroMotivo = "";
    let sinCorreo = 0;
    const logroSet = new Set<string>();
    if (d.objective === "completar") {
      for (const p of terminaronSet) logroSet.add(p);
      logro = logroSet.size;
    } else {
      const h = d.objective === "reserva" ? o.hitos.reservas : o.hitos.compras;
      if (!h.medible) {
        logroMotivo = d.objective === "reserva"
          ? "Aún no hay reservas de tu agenda conectadas: no se puede decir cuántas reservas ha dado."
          : "Aún no hay ventas de tu web conectadas: no se puede decir cuántas compras ha dado.";
      } else {
        const porCorreo = new Map<string, number[]>();
        for (const x of h.filas) { const l = porCorreo.get(x.email); if (l) l.push(x.at); else porCorreo.set(x.email, [x.at]); }
        for (const [p, fl] of porP) {
          const mails = o.personas.correosDe(p);
          if (!mails.length) { sinCorreo++; continue; }
          const t0 = Math.min(...[...fl.values()].map((s) => s.first));
          if (mails.some((m) => (porCorreo.get(m) || []).some((t) => t >= t0 && (d.endsAt == null || t < d.endsAt)))) logroSet.add(p);
        }
        if (porP.size > 0 && sinCorreo === porP.size) {
          logroMotivo = "Ninguna de las " + porP.size + " personas tiene correo en su ficha: no se pueden unir con " + (d.objective === "reserva" ? "las reservas." : "las compras.");
        } else logro = logroSet.size;
      }
    }
    if (logro == null) sinMedir++;
    for (const p of porP.keys()) unicas.add(p);
    for (const p of logroSet) lograron.add(p);
    const flujos = propios.map((f): ResultadoFlujo => {
      let entradas = 0, terminaron = 0, desde = 0;
      for (const fl of porP.values()) {
        const s = fl.get(f.id);
        if (!s) continue;
        entradas++;
        if (s.done) terminaron++;
        if (f.updatedAt > 0 && s.first >= f.updatedAt) desde++;
      }
      return { id: f.id, name: f.name, canal: f.canal, enabled: f.enabled, entradas, terminaron, editado: f.updatedAt, desdeEdicion: desde, compartido: (campsDeFlujo.get(f.id) || 0) > 1 };
    });
    const estado: ResultadoCampana["estado"] = !propios.length ? "sin-flujos"
      : d.endsAt != null && d.endsAt < o.ahora ? "terminada"
      : propios.some((f) => f.enabled) ? "activa" : "pausada";
    return {
      id: d.id, name: d.name, offer: d.offer, objective: d.objective, startsAt: d.startsAt, endsAt: d.endsAt,
      estado, participantes: porP.size, terminaron: terminaronSet.size, logro, logroMotivo, sinCorreo,
      sinAsignar: rep.sinAsignar.get(d.id) || 0, muestraSuficiente: porP.size >= MUESTRA_MIN,
      canales: [...new Set(propios.map((f) => f.canal).filter((c): c is CanalFlujo => !!c))],
      flujos,
    };
  });
  return { campanas, personasUnicas: unicas.size, lograronUnicas: lograron.size, sinMedir };
}

/** Comparación con el periodo anterior: solo vale con muestra suficiente en los dos lados. */
export function compararPeriodos(actual: number, anterior: number): { valida: boolean; delta: number | null; motivo: string } {
  if (actual < MUESTRA_MIN || anterior < MUESTRA_MIN) {
    return { valida: false, delta: null, motivo: "Aún no hay muestra suficiente para comparar con el periodo anterior (hacen falta al menos " + MUESTRA_MIN + " personas en cada uno)." };
  }
  return { valida: true, delta: Math.round(((actual - anterior) / anterior) * 100), motivo: "" };
}

/** Un logro comprobado y un problema accionable, solo si hay base. */
export function destacadosCampanas(cs: ResultadoCampana[]): { logro: string; problema: string } {
  let logro = "", problema = "";
  const con = cs.filter((c) => c.muestraSuficiente && c.logro != null);
  const mejor = con.filter((c) => (c.logro || 0) > 0).sort((a, b) => (b.logro! / b.participantes) - (a.logro! / a.participantes))[0];
  if (mejor) logro = "«" + mejor.name + "» ha conseguido su objetivo con " + mejor.logro + " de " + mejor.participantes + " personas.";
  const cero = con.find((c) => c.logro === 0);
  if (cero) problema = "«" + cero.name + "»: " + cero.participantes + " personas han entrado y ninguna ha conseguido el objetivo. Revisa dónde se pierden en su recorrido.";
  else {
    const apagada = cs.find((c) => c.estado === "activa" && c.flujos.some((f) => !f.enabled));
    if (apagada) problema = "«" + apagada.name + "» tiene " + apagada.flujos.filter((f) => !f.enabled).length + " de sus " + apagada.flujos.length + " flujos apagados: la gente se queda a medio camino.";
  }
  return { logro, problema };
}

// ───────────────────────── Mapa de una campaña (MET-AUTO-04) ─────────────────────────

const CANAL_PERSONA: Partial<Record<CanalFlujo, Canal>> = { wa: "whatsapp", ig: "instagram", fb: "facebook", email: "correo" };

export interface TramoMapa {
  de: string; a: string;
  /** configurado = un paso del flujo lanza el otro; observado = personas que lo recorrieron; ambos = las dos cosas. */
  fuente: "configurado" | "observado" | "ambos";
  /** Personas que entraron en el flujo de origen (las elegibles para seguir). */
  llegaron: number;
  /** De ellas, las que después entraron en el flujo de destino. */
  siguieron: number;
  /** Tiempo habitual (mediana) entre una entrada y otra, en ms; null si nadie lo recorrió. */
  medianaMs: number | null;
  cambioCanal: boolean;
  /** Solo en un cambio de canal: de las que llegaron, las que no podemos reconocer en el canal siguiente. */
  noSeguibles: number;
  medible: boolean;
  motivo: string;
}
export interface MapaCampana {
  id: string; name: string; personas: number;
  flujos: Array<ResultadoFlujo & { entrada: boolean; salida: boolean; sinUnion: boolean; web?: string; mensaje?: string }>;
  tramos: TramoMapa[];
}

const mediana = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export function mapaDeCampana(o: {
  id: string; defs: CampanaDef[]; flujos: FlujoCampana[]; eventos: EventoCampana[]; personas: IndicePersonas; hitos: HitosExternos; ahora: number;
}): MapaCampana | null {
  const def = o.defs.find((d) => d.id === o.id);
  if (!def) return null;
  const res = resultadosCampanas({ defs: o.defs, flujos: o.flujos, eventos: o.eventos, personas: o.personas, hitos: o.hitos, ahora: o.ahora }).campanas.find((c) => c.id === o.id)!;
  const porP = repartir(o.defs, o.eventos, o.personas).porCampana.get(o.id) || new Map();
  const dentro = new Set(def.flowIds);
  const flujoDe = new Map(o.flujos.map((f) => [f.id, f]));
  const llegaron = new Map<string, number>();
  const cuenta = new Map<string, { n: number; ms: number[]; ids: string[] }>();
  for (const fl of porP.values()) {
    const orden = [...fl].sort((a, b) => a[1].first - b[1].first || (a[0] < b[0] ? -1 : 1));
    for (const [f] of orden) llegaron.set(f, (llegaron.get(f) || 0) + 1);
    for (let i = 0; i + 1 < orden.length; i++) {
      const k = orden[i][0] + ">" + orden[i + 1][0];
      const c = cuenta.get(k) || { n: 0, ms: [], ids: [] };
      c.n++; c.ms.push(orden[i + 1][1].first - orden[i][1].first);
      cuenta.set(k, c);
    }
  }
  // Quién de los que llegaron a cada flujo no se reconoce en el canal del siguiente.
  const personasEn = (f: string) => [...porP].filter(([, fl]) => fl.has(f)).map(([p]) => p);
  const tramos = new Map<string, TramoMapa>();
  const nuevo = (de: string, a: string): TramoMapa => {
    const cd = flujoDe.get(de)?.canal ?? null, ca = flujoDe.get(a)?.canal ?? null;
    const cambio = !!cd && !!ca && cd !== ca;
    return { de, a, fuente: "observado", llegaron: llegaron.get(de) || 0, siguieron: 0, medianaMs: null, cambioCanal: cambio, noSeguibles: 0, medible: true, motivo: "" };
  };
  for (const [k, c] of cuenta) {
    const [de, a] = k.split(">");
    const t = nuevo(de, a);
    t.siguieron = c.n; t.medianaMs = mediana(c.ms);
    tramos.set(k, t);
  }
  for (const d of def.flowIds) {
    for (const a of flujoDe.get(d)?.lanza || []) {
      if (!dentro.has(a) || a === d) continue;
      const k = d + ">" + a;
      const t = tramos.get(k);
      if (t) t.fuente = "ambos"; else tramos.set(k, { ...nuevo(d, a), fuente: "configurado" });
    }
  }
  for (const t of tramos.values()) {
    if (!t.cambioCanal) continue;
    const destino = flujoDe.get(t.a)?.canal;
    const canalDestino = destino ? CANAL_PERSONA[destino] : undefined;
    if (!canalDestino) continue;
    // MET-AUTO-04-FIN · quien entró en el flujo destino YA fue reconocido allí: nunca cuenta como «no seguible»
    // (antes el tramo decía «no podemos seguir a nadie» junto a «26 de 30 siguieron»).
    t.noSeguibles = personasEn(t.de).filter((p) => !porP.get(p)?.has(t.a) && !o.personas.canalesDe(p).includes(canalDestino)).length;
    if (t.noSeguibles > 0) {
      t.medible = t.noSeguibles < t.llegaron;
      t.motivo = t.noSeguibles === t.llegaron
        ? "No podemos seguir este tramo: ninguna de las personas que llegaron dejó un teléfono o un correo con el que reconocerla en el canal siguiente."
        : "No podemos seguir este tramo con " + t.noSeguibles + " de " + t.llegaron + " personas: no dejaron un teléfono o un correo con el que reconocerlas en el canal siguiente.";
    }
  }
  const lista = [...tramos.values()].sort((x, y) => y.siguieron - x.siguieron || (x.de + x.a < y.de + y.a ? -1 : 1));
  const conEntrada = new Set(lista.map((t) => t.a));
  const conSalida = new Set(lista.map((t) => t.de));
  return {
    id: def.id, name: def.name, personas: res.participantes, tramos: lista,
    flujos: res.flujos.map((f) => ({
      ...f,
      web: flujoDe.get(f.id)?.web, mensaje: flujoDe.get(f.id)?.mensaje,
      entrada: !conEntrada.has(f.id),
      salida: !conSalida.has(f.id),
      sinUnion: res.flujos.length > 1 && !conEntrada.has(f.id) && !conSalida.has(f.id),
    })),
  };
}

/** Normaliza lo que llega del panel: nombre, objetivo y fechas válidos, flujos sin repetir (máx. 60). */
export function sanearCampana(raw: unknown, idsValidos: Set<string>): { ok: true; v: Omit<CampanaDef, "createdAt"> } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = String(r.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) return { ok: false, error: "Ponle un nombre a la campaña." };
  const objective = OBJETIVOS_CAMPANA.includes(r.objective as ObjetivoCampana) ? (r.objective as ObjetivoCampana) : "completar";
  const fecha = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };
  const startsAt = fecha(r.startsAt), endsAt = fecha(r.endsAt);
  if (startsAt != null && endsAt != null && endsAt <= startsAt) return { ok: false, error: "El fin de la campaña tiene que ser posterior a su inicio." };
  const lista = Array.isArray(r.flowIds) ? r.flowIds : [];
  const flowIds = [...new Set(lista.map((x) => String(x)).filter((x) => idsValidos.has(x)))];
  // METRICAS-1 · antes se recortaba en silencio a 60 y la campaña salía con menos flujos de los elegidos.
  if (flowIds.length > 60) return { ok: false, error: "Máximo 60 flujos por campaña." };
  const id = String(r.id ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  return { ok: true, v: { id, name, offer: String(r.offer ?? "").replace(/\s+/g, " ").trim().slice(0, 120), objective, startsAt, endsAt, flowIds } };
}
