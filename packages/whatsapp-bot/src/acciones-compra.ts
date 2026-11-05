/**
 * ACCIONES-COMPRA-1 (MET-LEADS-03) · qué hizo cada persona, de forma verificable, antes de su primera
 * compra. La población es la de «Compras del periodo» de «Cuánto tardan en comprar»: las primeras compras
 * del negocio con fecha en el periodo (quien ya había comprado antes no hace una primera compra y se
 * cuenta aparte).
 *
 * Una acción cuenta una vez por sesión (30 minutos sin actividad del mismo tipo abren otra):
 *  - conversación: mensajes suyos; comentario: el que activó un flujo; visita: clic en un enlace del
 *    panel o visita a una página con ficha; registro: en tus webs o formularios; reserva: una cita.
 * No cuentan los mensajes del negocio, del bot, las difusiones, el eco del móvil, reacciones, aperturas,
 * impresiones ni el alta en el CRM en sí. Las visitas, los registros y las reservas a menos de 5 minutos
 * de una venta son el propio pago (la página de gracias, el registro del checkout): tampoco cuentan.
 *
 * Una persona solo entra en la cifra si se puede afirmar que lo medido está entero. Si no, va aparte y
 * con su motivo (por orden): sin un inicio claro · solo en la web (sin ficha) · conversación cortada
 * (en el tope de turnos guardados) o con mensajes sin fecha · caducado (los comentarios se guardan 90
 * días y las visitas 13 meses) · sin ninguna acción. «Ausente» no es «cero acciones».
 */
import { dbAccionesPrevias, type AccionesPrevias } from "./db.js";
import { MAX_GUARDADO } from "./memory.js";
import { MARGEN_COMPRA_MS, estadistica, ofertaDe, repartirVentas, tiempoDe, type BaseCompradores, type Estadistica } from "./tiempo-compra.js";
import { claveRuta, rutasDeCompra, type MedidoRuta, type RutasDeCompra } from "./rutas-compra.js"; // RUTAS-COMPRA-1 (MET-LEADS-05)

const DAY = 86400000;
/** Más de esto sin actividad del mismo tipo abre una acción nueva. */
export const SESION_MS = 30 * 60000;
/** Los comentarios que activan un flujo se guardan 90 días (limpieza de arranque de db.ts). */
const RETENCION_COMENTARIOS_MS = 90 * DAY;
const MAX_DETALLE = 2000;

export type TipoAccion = "conversacion" | "comentario" | "visita" | "registro" | "reserva";
export const TIPOS_ACCION: TipoAccion[] = ["conversacion", "comentario", "visita", "registro", "reserva"];
export type MotivoIncompleto = "sin-inicio" | "solo-web" | "cortada" | "caducado" | "sin-acciones";

export interface FilaAcciones {
  phone: string; nombre: string; email: string; compra: number; oferta: string;
  /** Acciones en total antes de la compra. */
  total: number;
  /** Por tipo: cuántas; null = ese tipo no se puede medir en esta persona (no es 0). */
  por: Record<TipoAccion, number | null>;
  /** RUTAS-COMPRA-1 (MET-LEADS-05) · su recorrido: fuente y tipos de acción en orden (ver rutas-compra.ts). */
  ruta: string;
  /** MET-LEADS-05-FIN · su línea temporal: cada acción contada (una por sesión), en orden, con su inicio. Solo lo registrado. */
  linea: { tipo: TipoAccion; at: number }[];
}
export interface AccionesDeCompra extends Estadistica {
  /** Personas que compraron en el periodo pero ya habían comprado antes. */
  recompras: number;
  incompletos: Record<MotivoIncompleto, number>;
  /** MET-LEADS-03-FIN · lo mismo por la oferta de su primera compra (cada comprador en una sola). */
  ofertas: Array<{ nombre: string } & Estadistica>;
  /** Medidas con 1 · 2 a 3 · 4 a 6 · más de 6 acciones. */
  tramos: number[];
  tipos: Array<{ tipo: TipoAccion; hicieron: number; medibles: number }>;
  detalle: FilaAcciones[];
  /** RUTAS-COMPRA-1 (MET-LEADS-05) · los recorridos que se repiten entre los compradores medidos. */
  rutas: RutasDeCompra;
  /** MET-LEADS-05-FIN · los mismos recorridos, por la oferta de la primera compra (las mismas reglas y umbrales). */
  rutasPorOferta: Record<string, RutasDeCompra>;
}

/** Acciones distintas: las marcas de tiempo, sesionadas por huecos de más de SESION_MS. */
export function sesiones(ts: number[]): number {
  const s = ts.filter((x) => x > 0).sort((a, b) => a - b);
  let n = 0, prev = -Infinity;
  for (const t of s) { if (t - prev > SESION_MS) n++; prev = t; }
  return n;
}
/** MET-LEADS-05-FIN · el inicio de cada sesión (las mismas que cuenta `sesiones`). */
export function iniciosDeSesion(ts: number[]): number[] {
  const s = ts.filter((x) => x > 0).sort((a, b) => a - b);
  const o: number[] = []; let prev = -Infinity;
  for (const t of s) { if (t - prev > SESION_MS) o.push(t); prev = t; }
  return o;
}
/** Tope de pasos de la línea temporal que viaja por persona (los más cercanos a la compra). */
const MAX_LINEA = 40;
/** 0 = una acción · 1 = 2 a 3 · 2 = 4 a 6 · 3 = más de 6. */
export function tramoAcciones(n: number): number { return n <= 1 ? 0 : n <= 3 ? 1 : n <= 6 ? 2 : 3; }

const esSocial = (phone: string) => /^(ig|fb|yt|li):/.test(phone);
function agrupar<T extends { at: number }>(rows: T[], clave: (r: T) => string): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const r of rows) { const k = clave(r); if (!k) continue; const a = m.get(k); if (a) a.push(r.at); else m.set(k, [r.at]); }
  return m;
}

/** Cálculo puro: las compradoras de `base` y lo que se sabe que hicieron antes de pagar. */
export function accionesDeCompra(base: BaseCompradores, ap: AccionesPrevias, since: number, until: number, now: number, fuentes?: Map<string, string>): AccionesDeCompra {
  const dentro = (t: number) => t >= since && t <= until;
  const conv = new Map(ap.conv.map((c) => [c.phone, c]));
  const coment = agrupar(ap.comentarios, (r) => r.phone);
  const visitas = agrupar(ap.visitas, (r) => r.phone);
  const regTel = agrupar(ap.registros, (r) => r.phone);
  const regMail = agrupar(ap.registros, (r) => r.email);
  const reservas = agrupar(ap.reservas, (r) => r.email);
  const hace13m = (() => { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - 13); return d.getTime(); })();
  const incompletos: Record<MotivoIncompleto, number> = { "sin-inicio": 0, "solo-web": 0, cortada: 0, caducado: 0, "sin-acciones": 0 };
  const tramos = [0, 0, 0, 0];
  const hicieron: Record<TipoAccion, number> = { conversacion: 0, comentario: 0, visita: 0, registro: 0, reserva: 0 };
  const medibles: Record<TipoAccion, number> = { conversacion: 0, comentario: 0, visita: 0, registro: 0, reserva: 0 };
  const totales: number[] = [];
  const detalle: FilaAcciones[] = [];
  const medidos: MedidoRuta[] = [];
  const porOferta = new Map<string, { nombre: string; totales: number[] }>(); // MET-LEADS-03-FIN
  const rutasOferta = new Map<string, MedidoRuta[]>(); // MET-LEADS-05-FIN
  let recompras = 0;
  for (const [p, ventas] of repartirVentas(base.compradores)) {
    if (!ventas.some((c) => dentro(c.at))) continue;
    const primera = ventas[0];
    if (!dentro(primera.at)) { recompras++; continue; }
    const t = tiempoDe(p.ev, primera.at);
    if (!("dt" in t)) { incompletos["sin-inicio"]++; continue; }
    if (!p.phone) { incompletos["solo-web"]++; continue; }
    const cv = conv.get(p.phone);
    if (cv && (cv.turnos >= MAX_GUARDADO || cv.sinFecha > 0)) { incompletos.cortada++; continue; }
    const social = esSocial(p.phone);
    if ((social && t.inicio < now - RETENCION_COMENTARIOS_MS) || t.inicio < hace13m) { incompletos.caducado++; continue; }
    const email = (p.email || "").trim().toLowerCase();
    const antes = (ts: number[] | undefined) => (ts || []).filter((x) => x < primera.at);
    const lejosDeVentas = (x: number) => ventas.every((c) => Math.abs(x - c.at) > MARGEN_COMPRA_MS);
    const resTodas = email ? (reservas.get(email) || []) : [];
    const res = antes(resTodas).filter(lejosDeVentas);
    const reg = antes([...(regTel.get(p.phone) || []), ...(email ? (regMail.get(email) || []) : [])])
      .filter(lejosDeVentas).filter((x) => resTodas.every((r) => Math.abs(x - r) > MARGEN_COMPRA_MS));
    // RUTAS-COMPRA-1 (MET-LEADS-05) · las marcas de tiempo de cada tipo: de ellas salen las sesiones y el orden del recorrido.
    const marcas: Record<TipoAccion, number[]> = {
      conversacion: antes(cv?.ats),
      comentario: social ? antes(coment.get(p.phone)) : [],
      visita: antes(visitas.get(p.phone)).filter(lejosDeVentas),
      registro: email ? reg : [],
      reserva: email ? res : [],
    };
    const por: Record<TipoAccion, number | null> = {
      conversacion: sesiones(marcas.conversacion),
      comentario: social ? sesiones(marcas.comentario) : null,
      visita: sesiones(marcas.visita),
      registro: email ? sesiones(marcas.registro) : null,
      reserva: email ? sesiones(marcas.reserva) : null,
    };
    const total = TIPOS_ACCION.reduce((s, k) => s + (por[k] || 0), 0);
    if (!total) { incompletos["sin-acciones"]++; continue; }
    // El recorrido: cada tipo una sola vez, por su primera aparición (a igual instante, el orden de TIPOS_ACCION);
    // lo último que consta, por su última marca. Quien repite un paso no cambia de recorrido ni se multiplica.
    const minimo = (v: number[]) => v.reduce((m, x) => (x > 0 && x < m ? x : m), Infinity);
    const maximo = (v: number[]) => v.reduce((m, x) => (x > m ? x : m), 0);
    const presentes = TIPOS_ACCION.filter((k) => (por[k] || 0) > 0);
    const orden = presentes.slice().sort((a, b) => minimo(marcas[a]) - minimo(marcas[b]) || TIPOS_ACCION.indexOf(a) - TIPOS_ACCION.indexOf(b));
    const ultima = presentes.slice().sort((a, b) => maximo(marcas[b]) - maximo(marcas[a]) || TIPOS_ACCION.indexOf(a) - TIPOS_ACCION.indexOf(b))[0];
    const fuente = fuentes?.get(p.phone) || "desconocido";
    const mr: MedidoRuta = { fuente, orden, ultima, dt: t.dt, repetido: total > orden.length };
    medidos.push(mr);
    const oferta = ofertaDe(primera, base.cat).nombre;
    const lo = rutasOferta.get(oferta); if (lo) lo.push(mr); else rutasOferta.set(oferta, [mr]);
    totales.push(total);
    const of = ofertaDe(primera, base.cat);
    const go = porOferta.get(of.clave) || { nombre: of.nombre, totales: [] };
    go.totales.push(total); porOferta.set(of.clave, go);
    tramos[tramoAcciones(total)]++;
    for (const k of TIPOS_ACCION) { if (por[k] === null) continue; medibles[k]++; if (por[k]) hicieron[k]++; }
    const linea = presentes.flatMap((k) => iniciosDeSesion(marcas[k]).map((at) => ({ tipo: k, at })))
      .sort((a, b) => a.at - b.at || TIPOS_ACCION.indexOf(a.tipo) - TIPOS_ACCION.indexOf(b.tipo)).slice(-MAX_LINEA);
    detalle.push({ phone: p.phone, nombre: p.nombre, email: p.email, compra: primera.at, oferta, total, por, ruta: claveRuta(fuente, orden), linea });
  }
  return {
    ...estadistica(totales), recompras, incompletos, tramos,
    ofertas: [...porOferta.values()].map((g) => ({ nombre: g.nombre, ...estadistica(g.totales) }))
      .sort((a, b) => b.n - a.n || a.nombre.localeCompare(b.nombre)),
    tipos: TIPOS_ACCION.map((tipo) => ({ tipo, hicieron: hicieron[tipo], medibles: medibles[tipo] })),
    detalle: detalle.sort((a, b) => b.compra - a.compra).slice(0, MAX_DETALLE),
    rutas: rutasDeCompra(medidos),
    rutasPorOferta: Object.fromEntries([...rutasOferta].map(([k, v]) => [k, rutasDeCompra(v)])),
  };
}

/** Lee lo que hicieron las compradoras del periodo y lo cuenta. Sólo Postgres. Si la lectura falla
 *  lanza: quien llama distingue «no se pudo calcular» de «nadie hizo nada». */
export async function accionesAntesDeComprar(o: { since: number; until: number; now: number }, base: BaseCompradores, fuentes?: Map<string, string>): Promise<AccionesDeCompra> {
  const ap = await dbAccionesPrevias(base.compradores.map((p) => p.phone), base.compradores.map((p) => p.email));
  return accionesDeCompra(base, ap, o.since, o.until, o.now, fuentes);
}
