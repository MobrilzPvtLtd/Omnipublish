/**
 * TIEMPO-COMPRA-1 (MET-LEADS-02) · cuánto tarda una persona desde lo primero que sabemos de ella
 * hasta su primera compra, dentro del mismo negocio (el workspace) y separado por oferta.
 *
 * Dos lecturas que no se mezclan:
 *  - «Compras del periodo» (calendario): las primeras compras que cayeron en el periodo y cuánto
 *    tardaron. Quien ya había comprado antes no hace una primera compra: se cuenta aparte.
 *  - «Quienes entraron en el periodo» (cohorte): de las fichas que empezaron en el periodo, cuántas
 *    compraron en un día, en 7 o en 30, contando solo a quienes ya han tenido ese tiempo: una ficha
 *    de ayer no ha agotado su oportunidad de comprar en 30 días.
 *
 * El inicio es lo más temprano que sabemos (alta en el CRM, registro en una web, primer mensaje),
 * salvo el alta de una importación, que es la fecha de la importación y no la del primer contacto.
 * Si lo primero que sabemos ocurrió menos de 5 minutos antes de pagar (o después), casi siempre es
 * la propia compra la que creó la ficha o el registro: esa persona no tiene un inicio claro y se
 * cuenta aparte, no como «compró en el acto».
 */
import { dbDashVentasFilas, dbComprasFilasDeContactos, dbIniciosDeContactos, dbComprasWebPorEmail, type CompraDeContacto } from "./db.js";
import { purchaseLinks } from "./links.js";
import { MAX_GUARDADO } from "./memory.js";

const DAY = 86400000;
/** Lo primero que sabemos a menos de esto antes de pagar suele ser la propia compra. */
export const MARGEN_COMPRA_MS = 5 * 60000;
/** Un alta con un mensaje o un registro a menos de esto se etiqueta con lo más concreto. */
const PEGADO_MS = 15 * 60000;
/** Límites de los tramos, en días: menos de 1 · de 1 a 7 · de 8 a 30 · más de 30. */
export const TRAMOS_DIAS = [1, 8, 31];
const MAX_DETALLE = 2000;

export type TipoInicio = "mensaje" | "registro" | "alta";
export type MotivoSinInicio = "con-la-compra" | "despues" | "importada" | "sin-datos";
export interface Evidencia { alta: number; registro: number; mensaje: number; importada: boolean }
export interface PersonaConCompras { phone: string; nombre: string; email: string; ev: Evidencia; compras: CompraDeContacto[] }
export interface FilaTiempo {
  /** Teléfono de la ficha ('' si la persona solo está en una web). */
  phone: string; nombre: string; email: string;
  inicio: number; tipo: TipoInicio | "";
  compra: number; oferta: string;
  /** ms del inicio a la primera compra; -1 = sin inicio claro (ver motivo). */
  dt: number; motivo: MotivoSinInicio | "";
}
export interface Estadistica { n: number; mediana: number | null; p25: number | null; p75: number | null; min: number | null; max: number | null }
export interface LecturaCalendario extends Estadistica {
  sinInicio: number; motivos: Record<MotivoSinInicio, number>;
  /** Personas que compraron en el periodo pero ya habían comprado antes. */
  recompras: number;
  tramos: number[];
  inicios: Record<TipoInicio, number>;
  ofertas: Array<{ nombre: string } & Estadistica>;
  detalle: FilaTiempo[];
}
export interface LecturaCohorte {
  /** Fichas nuevas del periodo que empezaron en él: la cohorte. */
  personas: number;
  /** Fuera de la cohorte: importadas, ya empezadas antes del periodo, compradores sin inicio claro. */
  importadas: number; antes: number; sinInicio: number; motivos: Record<MotivoSinInicio, number>;
  compraron: number;
  /** Por cada plazo: cuántas ya han tenido ese tiempo y cuántas de ellas compraron dentro. */
  horizontes: Array<{ dias: number; observadas: number; compraron: number }>;
  detalle: FilaTiempo[];
}
export interface TiempoDeCompra { calendario: LecturaCalendario; cohorte: LecturaCohorte }

const ORDEN: Record<TipoInicio, number> = { mensaje: 0, registro: 1, alta: 2 };
const sinMotivos = (): Record<MotivoSinInicio, number> => ({ "con-la-compra": 0, despues: 0, importada: 0, "sin-datos": 0 });

/** Lo más temprano que sabemos de una persona. El alta de una importación no cuenta. */
export function inicioDe(e: Evidencia): { at: number; tipo: TipoInicio } | null {
  const c: Array<{ at: number; tipo: TipoInicio }> = [];
  if (e.mensaje > 0) c.push({ at: e.mensaje, tipo: "mensaje" });
  if (e.registro > 0) c.push({ at: e.registro, tipo: "registro" });
  if (e.alta > 0 && !e.importada) c.push({ at: e.alta, tipo: "alta" });
  if (!c.length) return null;
  c.sort((a, b) => a.at - b.at || ORDEN[a.tipo] - ORDEN[b.tipo]);
  const p = c[0];
  // El alta suele ser el efecto de lo otro: si un mensaje o un registro llegó a la vez, se dice cuál.
  if (p.tipo === "alta") {
    const pegado = c.find((x) => x.tipo !== "alta" && x.at - p.at <= PEGADO_MS);
    if (pegado) return { at: p.at, tipo: pegado.tipo };
  }
  return p;
}

/** El tiempo de un comprador hasta su primera compra o, si no tiene un inicio claro, por qué. */
export function tiempoDe(e: Evidencia, primera: number):
  { inicio: number; tipo: TipoInicio; dt: number } | { inicio: number; tipo: TipoInicio | ""; motivo: MotivoSinInicio } {
  const ini = inicioDe(e);
  if (!ini) return { inicio: 0, tipo: "", motivo: e.importada && e.alta > 0 ? "importada" : "sin-datos" };
  if (ini.at > primera + MARGEN_COMPRA_MS) return { inicio: ini.at, tipo: ini.tipo, motivo: "despues" };
  if (ini.at > primera - MARGEN_COMPRA_MS) return { inicio: ini.at, tipo: ini.tipo, motivo: "con-la-compra" };
  return { inicio: ini.at, tipo: ini.tipo, dt: primera - ini.at };
}

function cuantil(s: number[], q: number): number {
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return Math.round(s[lo] + (s[hi] - s[lo]) * (pos - lo));
}
export function estadistica(dts: number[]): Estadistica {
  const s = dts.slice().sort((a, b) => a - b);
  if (!s.length) return { n: 0, mediana: null, p25: null, p75: null, min: null, max: null };
  return { n: s.length, mediana: cuantil(s, 0.5), p25: cuantil(s, 0.25), p75: cuantil(s, 0.75), min: s[0], max: s[s.length - 1] };
}
/** 0 = menos de un día · 1 = de 1 a 7 días · 2 = de 8 a 30 · 3 = más de 30. */
export function tramoDe(dt: number): number {
  const d = dt / DAY;
  let k = 0;
  while (k < TRAMOS_DIAS.length && d >= TRAMOS_DIAS[k]) k++;
  return k;
}

export type Catalogo = Array<{ id: string; label?: string }>;
/** La oferta de una venta: el producto del catálogo (enlace de pago) o el de la web, por nombre. */
export function ofertaDe(c: CompraDeContacto, cat: Catalogo): { clave: string; nombre: string } {
  const nombre = c.origen === "panel"
    ? (cat.find((p) => p.id === c.product_id)?.label || "Enlace de pago")
    : (c.product.trim() || "Venta en la web");
  return { clave: nombre.trim().toLowerCase(), nombre };
}

/** Las ventas de cada persona, de la más antigua a la más nueva. Cada venta cuenta una vez: dos
 *  fichas con el mismo email ven la misma venta de la web (misma `ref`), y se queda con la ficha más
 *  reciente, la misma que elige el resto del panel al cruzar las ventas de la web por email (así las
 *  dos lecturas le dan la venta a la misma persona). Las devoluciones no son compras. */
export function repartirVentas(ps: PersonaConCompras[]): Array<[PersonaConCompras, CompraDeContacto[]]> {
  const vistas = new Set<string>();
  const clave = (p: PersonaConCompras) => p.phone || "~" + p.email;
  return [...ps].sort((a, b) => (b.ev.alta - a.ev.alta) || clave(a).localeCompare(clave(b))).map((p): [PersonaConCompras, CompraDeContacto[]] => {
    const v: CompraDeContacto[] = [];
    for (const c of p.compras) {
      if (c.kind !== "sale" || vistas.has(c.ref)) continue;
      vistas.add(c.ref);
      v.push(c);
    }
    return [p, v.sort((a, b) => a.at - b.at)];
  });
}
const porCompra = (a: FilaTiempo, b: FilaTiempo) => b.compra - a.compra;

/** «Compras del periodo»: primeras compras con fecha en [since, until]. */
export function lecturaCalendario(ps: PersonaConCompras[], since: number, until: number, cat: Catalogo): LecturaCalendario {
  const motivos = sinMotivos();
  const inicios: Record<TipoInicio, number> = { mensaje: 0, registro: 0, alta: 0 };
  const tramos = [0, 0, 0, 0];
  const dts: number[] = [];
  const porOferta = new Map<string, { nombre: string; dts: number[] }>();
  const detalle: FilaTiempo[] = [];
  let recompras = 0, sinInicio = 0;
  const dentro = (t: number) => t >= since && t <= until;
  for (const [p, ventas] of repartirVentas(ps)) {
    if (!ventas.some((c) => dentro(c.at))) continue;
    const primera = ventas[0];
    const t = tiempoDe(p.ev, primera.at);
    // Por oferta: la primera compra de cada oferta; volver a comprar la misma no es primera compra.
    if ("dt" in t) {
      const vistas = new Set<string>();
      for (const c of ventas) {
        const o = ofertaDe(c, cat);
        if (vistas.has(o.clave)) continue;
        vistas.add(o.clave);
        if (!dentro(c.at)) continue;
        const g = porOferta.get(o.clave) || { nombre: o.nombre, dts: [] };
        g.dts.push(c.at - t.inicio);
        porOferta.set(o.clave, g);
      }
    }
    if (!dentro(primera.at)) { recompras++; continue; }
    const base = { phone: p.phone, nombre: p.nombre, email: p.email, compra: primera.at, oferta: ofertaDe(primera, cat).nombre };
    if ("dt" in t) {
      dts.push(t.dt);
      tramos[tramoDe(t.dt)]++;
      inicios[t.tipo]++;
      detalle.push({ ...base, inicio: t.inicio, tipo: t.tipo, dt: t.dt, motivo: "" });
    } else {
      sinInicio++;
      motivos[t.motivo]++;
      detalle.push({ ...base, inicio: t.inicio, tipo: t.tipo, dt: -1, motivo: t.motivo });
    }
  }
  const ofertas = [...porOferta.values()]
    .map((g) => ({ nombre: g.nombre, ...estadistica(g.dts) }))
    .sort((a, b) => b.n - a.n || a.nombre.localeCompare(b.nombre));
  return { ...estadistica(dts), sinInicio, motivos, recompras, tramos, inicios, ofertas, detalle: detalle.sort(porCompra).slice(0, MAX_DETALLE) };
}

/** «Quienes entraron en el periodo»: las fichas nuevas que empezaron en él y, por cada plazo, cuántas
 *  compraron dentro de ese plazo entre las que ya han tenido ese tiempo. */
export function lecturaCohorte(nuevos: PersonaConCompras[], since: number, now: number, cat: Catalogo): LecturaCohorte {
  const motivos = sinMotivos();
  const miembros: Array<{ edad: number; dt: number | null }> = [];
  const detalle: FilaTiempo[] = [];
  let importadas = 0, antes = 0, sinInicio = 0;
  for (const [p, ventas] of repartirVentas(nuevos)) {
    if (p.ev.importada) { importadas++; continue; }
    const ini = inicioDe(p.ev);
    if (!ini) continue;
    if (ini.at < since) { antes++; continue; }
    const primera = ventas[0];
    let dt: number | null = null;
    if (primera) {
      const t = tiempoDe(p.ev, primera.at);
      if (!("dt" in t)) { sinInicio++; motivos[t.motivo]++; continue; }
      dt = t.dt;
      detalle.push({ phone: p.phone, nombre: p.nombre, email: p.email, inicio: t.inicio, tipo: t.tipo, compra: primera.at, oferta: ofertaDe(primera, cat).nombre, dt, motivo: "" });
    }
    miembros.push({ edad: Math.max(0, now - ini.at), dt });
  }
  const horizontes = TRAMOS_DIAS.map((dias) => {
    const h = dias * DAY;
    const obs = miembros.filter((m) => m.edad >= h);
    return { dias, observadas: obs.length, compraron: obs.filter((m) => m.dt !== null && m.dt < h).length };
  });
  return {
    personas: miembros.length, importadas, antes, sinInicio, motivos,
    compraron: miembros.filter((m) => m.dt !== null).length,
    horizontes, detalle: detalle.sort(porCompra).slice(0, MAX_DETALLE),
  };
}

/** CANALES-COMPRA-1 (MET-LEADS-04) · los miembros de la cohorte de «Fichas nuevas», uno a uno: los mismos
 *  que cuenta `lecturaCohorte` (sin importadas, sin las que ya habían empezado antes del periodo, sin
 *  compradoras sin un inicio claro), con su teléfono para asignarles canal, su edad, lo que tardaron en
 *  comprar (null = aún no han comprado) y la oferta de su primera compra. */
export interface MiembroCohorte { phone: string; edad: number; dt: number | null; oferta: string }
export function miembrosDeCohorte(nuevos: PersonaConCompras[], since: number, now: number, cat: Catalogo): MiembroCohorte[] {
  const out: MiembroCohorte[] = [];
  for (const [p, ventas] of repartirVentas(nuevos)) {
    if (p.ev.importada) continue;
    const ini = inicioDe(p.ev);
    if (!ini || ini.at < since) continue;
    const primera = ventas[0];
    let dt: number | null = null, oferta = "";
    if (primera) {
      const t = tiempoDe(p.ev, primera.at);
      if (!("dt" in t)) continue;
      dt = t.dt;
      oferta = ofertaDe(primera, cat).nombre;
    }
    out.push({ phone: p.phone, edad: Math.max(0, now - ini.at), dt, oferta });
  }
  return out;
}

/** ACCIONES-COMPRA-1 (MET-LEADS-03) · lo que cargan las dos lecturas y también «Qué hacen antes de
 *  comprar»: se lee una vez y se reparte. */
export interface BaseCompradores {
  cat: Catalogo; compradores: PersonaConCompras[]; nuevos: string[];
  persona: (phone: string) => PersonaConCompras;
}
/** Las dos lecturas para el periodo [since, until]. `nuevos` son los teléfonos de las fichas nuevas
 *  del periodo (la misma población que el resto de la vista Leads). Sólo Postgres: sin base de
 *  datos no hay ventas guardadas y las dos lecturas salen vacías. */
export async function cargarCompradores(o: { since: number; until: number; nuevos: string[] }): Promise<BaseCompradores> {
  const cat = purchaseLinks();
  const v = await dbDashVentasFilas(o.since, o.until, 20000);
  const phones = new Set<string>(), emails = new Set<string>();
  for (const x of v.panel) if (x.phone) phones.add(x.phone);
  for (const x of v.sio) {
    if (x.kind !== "sale") continue;
    if (x.phone) phones.add(x.phone);
    else if (x.email) emails.add(x.email.trim().toLowerCase());
  }
  const nuevos = [...new Set(o.nuevos.filter(Boolean))];
  const todos = [...new Set([...phones, ...nuevos])];
  const [filas, web, inicios] = await Promise.all([
    dbComprasFilasDeContactos(todos, 50000),
    dbComprasWebPorEmail([...emails]),
    dbIniciosDeContactos(todos, MAX_GUARDADO),
  ]);
  const ini = new Map(inicios.map((x) => [x.phone, x]));
  const compras = new Map<string, CompraDeContacto[]>();
  for (const f of filas) { const a = compras.get(f.phone); if (a) a.push(f); else compras.set(f.phone, [f]); }
  const persona = (phone: string): PersonaConCompras => {
    const x = ini.get(phone);
    return {
      phone, nombre: x?.name || "", email: x?.email || "",
      ev: { alta: x?.alta || 0, registro: x?.registro || 0, mensaje: x?.mensaje || 0, importada: x?.source === "import" },
      compras: compras.get(phone) || [],
    };
  };
  const compradores: PersonaConCompras[] = [
    ...[...phones].map(persona),
    ...web.map((w) => ({ phone: "", nombre: "", email: w.email, ev: { alta: 0, registro: w.registro, mensaje: 0, importada: false }, compras: w.compras })),
  ];
  return { cat, compradores, nuevos, persona };
}

export async function tiempoDeCompra(o: { since: number; until: number; now: number; nuevos: string[] }, base?: BaseCompradores): Promise<TiempoDeCompra> {
  const b = base || await cargarCompradores(o);
  return {
    calendario: lecturaCalendario(b.compradores, o.since, o.until, b.cat),
    cohorte: lecturaCohorte(b.nuevos.map(b.persona), o.since, o.now, b.cat),
  };
}
