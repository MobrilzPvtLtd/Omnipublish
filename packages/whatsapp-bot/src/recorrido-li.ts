/**
 * RECORRIDO-LI-1 (MET-LI-04) · del clic en LinkedIn a la reserva: qué pasó después de cada pieza.
 *
 * Módulo puro (sin base de datos): las filas las trae `dbRecorridoLinkedIn` (db.ts) y el endpoint
 * GET /admin/api/analytics/linkedin/recorrido las pasa por aquí. El panel pone al lado lo que ya
 * tiene (clics de LinkedIn y visitas a la web medidas por el píxel) y pinta cada paso por separado.
 *
 * ── La regla de asignación (la de «Cómo llegaron», MET-ORIGEN-07) ──
 *   Una reserva, un contacto nuevo o una venta cuentan para la pieza por la que esa persona llegó
 *   la PRIMERA vez: su primer origen conocido (la ficha del panel o el registro en la web con su
 *   marca de origen, utm_source / source) que sea ANTERIOR a la reserva o a la venta. Si ese primer
 *   origen es LinkedIn, cuenta para la pieza de su marca de contenido (utm_content); sin marca, para
 *   «LinkedIn, sin saber qué pieza». Si llegó antes por otra vía, cuenta para esa vía y aquí sólo se
 *   dice cuántas son. Un clic posterior nunca pisa el primer origen.
 *
 * ── Qué une los pasos (IDENTIDAD-COMUN-1, MET-AUTO-09) ──
 *   El correo: el de la ficha, el del registro en la web, el de la reserva y el de la venta. Las
 *   visitas son anónimas: a una persona sólo se la sigue desde que deja su correo. Lo que no se puede
 *   unir se cuenta aparte como hueco, nunca se adjudica a una pieza.
 *
 * ── Un hecho, una vez ── la reserva por su id en la agenda (claveDeHecho), la venta por su
 *   transacción. Las reservas canceladas no cuentan como hechas: se dicen aparte. Las devoluciones
 *   tampoco restan ventas aquí: se dicen aparte.
 */
import { claveDeHecho, normalizarEmail, normalizarTelefono } from "./identidad.js";
import { platformOf } from "./attribution.js";

/** Un registro que dice de dónde llegó una persona: su ficha del panel o su registro en la web. */
export interface OrigenLi {
  tipo: "ficha" | "registro";
  email: string;
  phone: string;
  at: number | null;
  source: string;
  utm_source: string;
  utm_content: string;
}
export interface ReservaLi { cuenta: string; id: string; email: string; creada: number | null; estado: string }
export interface VentaLi { cuenta: string; id: string; kind: string; email: string; pagada: number | null }

export interface PiezaRecorrido {
  /** utm_content en minúsculas; "" = LinkedIn sin marca de pieza. */
  marca: string;
  contactos: number;
  /** de esos contactos, los que no dejaron correo: no se les puede seguir hasta la reserva. */
  sinCorreo: number;
  reservas: number;
  canceladas: number;
  ventas: number;
  devoluciones: number;
}
export interface RecorridoLi {
  /** Hay base de datos que leer (en memoria no hay registros de la web ni ventas). */
  medido: boolean;
  /** Alguna reserva sincronizada alguna vez: sin ninguna, las reservas son «sin medir», no 0. */
  agenda: boolean;
  /** Alguna venta de la web sincronizada alguna vez: sin ninguna, las ventas son «sin medir». */
  ventasWeb: boolean;
  piezas: PiezaRecorrido[];
  total: { contactos: number; sinCorreo: number; reservas: number; canceladas: number; ventas: number; devoluciones: number };
  huecos: {
    /** reservas de estos días de personas sin ningún origen conocido antes de reservar. */
    reservasSinOrigen: number;
    /** reservas de personas que llegaron antes por otra vía (cuentan para esa vía). */
    reservasOtraVia: number;
    /** la misma reserva repetida (varias copias o varias vías): contada una vez. */
    reservasRepetidas: number;
    ventasSinOrigen: number;
    ventasOtraVia: number;
  };
}

const ES_LI = (o: OrigenLi): boolean => platformOf(o.utm_source, o.source) === "linkedin";
/** ¿Dice este registro de dónde llegó la persona? Sin marca de origen, o creada a mano en el panel, no. */
const CONOCIDO = (o: OrigenLi): boolean => {
  if (!String(o.utm_source || "").trim() && !String(o.source || "").trim()) return false;
  return platformOf(o.utm_source, o.source) !== "directo";
};
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

export function recorridoLinkedIn(o: {
  sinceMs: number;
  untilMs: number;
  origenes: OrigenLi[];
  reservas: ReservaLi[];
  ventas: VentaLi[];
  agenda: boolean;
  ventasWeb: boolean;
  medido?: boolean;
}): RecorridoLi {
  const porMarca = new Map<string, PiezaRecorrido>();
  const pieza = (m: string): PiezaRecorrido => {
    let p = porMarca.get(m);
    if (!p) { p = { marca: m, contactos: 0, sinCorreo: 0, reservas: 0, canceladas: 0, ventas: 0, devoluciones: 0 }; porMarca.set(m, p); }
    return p;
  };
  const marcaDe = (x: OrigenLi): string => String(x.utm_content || "").trim().toLowerCase();

  // Los registros de cada persona: por correo; los que no tienen, por teléfono (no se pueden seguir).
  const porPersona = new Map<string, OrigenLi[]>();
  for (const x of o.origenes) {
    const em = normalizarEmail(x.email);
    const k = em ? "e:" + em : (String(x.phone || "").trim() ? "t:" + (normalizarTelefono(x.phone) || String(x.phone).trim()) : "");
    if (!k) continue;
    const l = porPersona.get(k) || [];
    l.push(x);
    porPersona.set(k, l);
  }
  const t = (x: OrigenLi): number => num(x.at) ?? Number.MAX_SAFE_INTEGER;
  for (const l of porPersona.values()) l.sort((a, b) => t(a) - t(b));
  /** El primer origen conocido de una persona hasta un instante (incluido). */
  const primero = (k: string, hasta: number): OrigenLi | null => {
    for (const x of porPersona.get(k) || []) { const a = num(x.at); if (a != null && a <= hasta && CONOCIDO(x)) return x; }
    return null;
  };

  // Contactos nuevos: su primer registro (el que sea) cae en estos días y su primer origen conocido es LinkedIn.
  for (const [k, l] of porPersona) {
    const a0 = num(l[0]?.at);
    if (a0 == null || a0 < o.sinceMs || a0 >= o.untilMs) continue;
    const pr = primero(k, o.untilMs);
    if (!pr || !ES_LI(pr)) continue;
    const p = pieza(marcaDe(pr));
    p.contactos++;
    if (k.startsWith("t:")) p.sinCorreo++;
  }

  // Reservas de estos días: una vez cada una; para LinkedIn si el primer origen ANTERIOR a reservar lo es.
  const huecos = { reservasSinOrigen: 0, reservasOtraVia: 0, reservasRepetidas: 0, ventasSinOrigen: 0, ventasOtraVia: 0 };
  const vistas = new Set<string>();
  for (const r of o.reservas) {
    const cuando = num(r.creada);
    const clave = claveDeHecho({ tipo: "reserva", id: r.id, cuenta: r.cuenta, email: r.email, cuando });
    if (clave) { if (vistas.has(clave)) { huecos.reservasRepetidas++; continue; } vistas.add(clave); }
    if (cuando != null && (cuando < o.sinceMs || cuando >= o.untilMs)) continue;
    const em = normalizarEmail(r.email);
    // Sin correo o sin fecha de creación no se puede situar a la persona antes de reservar.
    const pr = em && cuando != null ? primero("e:" + em, cuando) : null;
    if (!pr) { huecos.reservasSinOrigen++; continue; }
    if (!ES_LI(pr)) { huecos.reservasOtraVia++; continue; }
    const p = pieza(marcaDe(pr));
    if (String(r.estado || "").toUpperCase() === "CANCELLED") p.canceladas++;
    else p.reservas++;
  }

  // Ventas de estos días (las de la web, con su correo): igual. Las devoluciones se dicen aparte.
  const vv = new Set<string>();
  for (const v of o.ventas) {
    const cuando = num(v.pagada);
    const clave = v.id ? (String(v.kind) === "refund" ? "dev:" : "") + claveDeHecho({ tipo: "compra", id: v.id, cuenta: v.cuenta }) : "";
    if (clave) { if (vv.has(clave)) continue; vv.add(clave); }
    if (cuando == null || cuando < o.sinceMs || cuando >= o.untilMs) continue;
    const em = normalizarEmail(v.email);
    const pr = em ? primero("e:" + em, cuando) : null;
    const dev = String(v.kind) === "refund";
    if (!pr) { if (!dev) huecos.ventasSinOrigen++; continue; }
    if (!ES_LI(pr)) { if (!dev) huecos.ventasOtraVia++; continue; }
    const p = pieza(marcaDe(pr));
    if (dev) p.devoluciones++; else p.ventas++;
  }

  const piezas = [...porMarca.values()].sort((a, b) => (b.reservas - a.reservas) || (b.contactos - a.contactos) || (b.ventas - a.ventas) || a.marca.localeCompare(b.marca));
  const total = { contactos: 0, sinCorreo: 0, reservas: 0, canceladas: 0, ventas: 0, devoluciones: 0 };
  for (const p of piezas) {
    total.contactos += p.contactos; total.sinCorreo += p.sinCorreo; total.reservas += p.reservas;
    total.canceladas += p.canceladas; total.ventas += p.ventas; total.devoluciones += p.devoluciones;
  }
  return { medido: o.medido !== false, agenda: !!o.agenda, ventasWeb: !!o.ventasWeb, piezas, total, huecos };
}
