/**
 * ORIGEN-ATRIBUCION-1 (MET-ORIGEN-07) · la regla común de «Cómo llegaron» y «Qué ayudó a cerrar».
 *
 * Módulo puro (sin base de datos): las filas las trae `dbOrigenCierre` (db.ts), el endpoint
 * GET /admin/api/analytics/origen/cierre resuelve la vía y el nombre de la pieza de cada llegada y las
 * pasa por aquí. Es la misma regla que ya aplica `recorridoLinkedIn` (RECORRIDO-LI-1), generalizada a
 * todas las vías.
 *
 * ── La regla (una sola, para las dos lecturas) ──
 *   · «Cómo llegaron» cuenta PERSONAS por la vía de su primera llegada conocida (la ficha del panel o su
 *     registro en la web con su marca de origen), en el día en que llegaron.
 *   · «Qué ayudó a cerrar» cuenta VENTAS por esa MISMA primera llegada conocida, anterior al pago, en el
 *     día en que se pagó. Un clic o un mensaje posterior nunca pisa el primer origen.
 *   · Lo que pasó entre la llegada y el pago (reservó una llamada, habló con un flujo) son AYUDAS: se
 *     cuentan aparte, por vía, y nunca suman como ventas. Una venta, una vez.
 *   · Una venta cuenta una vez: por su referencia (`panel:<id>` o `web:<cuenta>:<transacción>`).
 *   · Las devoluciones restan del importe de su misma moneda y se dicen aparte; las monedas no se suman.
 *   · Sin ninguna llegada conocida ANTERIOR al pago (persona sin ficha, sin correo, sin marca de origen)
 *     la venta va a «sin origen conocido»: se cuenta, no se adjudica a ninguna vía por aproximación.
 */

/** Una llegada de la persona: su ficha del panel o su registro en la web, con la vía ya resuelta. */
export interface LlegadaPersona {
  tipo: "ficha" | "registro";
  /** Instante en que quedó registrada esa llegada (ms). Sin fecha no se puede situar antes del pago. */
  at: number | null;
  /** Vía (plataforma) de esa llegada; "" o "directo" = no dice de dónde llegó la persona. */
  via: string;
  /** Pieza (anuncio, publicación, flujo) con título legible, o "". */
  contenido: string;
  campana: string;
  /** Flujo que recogió el dato, si lo hubo. */
  flowId: string;
}
export interface VentaAtribuible {
  /** Identidad de la venta: `panel:<id>` o `web:<cuenta>:<transacción>`. */
  ref: string;
  fuente: "panel" | "web";
  kind: "sale" | "refund";
  moneda: string;
  /** 0 = la venta no trajo importe (enlace de pago detectado por la etiqueta). */
  importe: number;
  at: number;
  llegadas: LlegadaPersona[];
  /** La persona había reservado una llamada ANTES de pagar. */
  reservoAntes: boolean;
  /** La persona había hablado con un flujo ANTES de pagar. */
  flujoAntes: boolean;
  /** MET-ORIGEN-07-FIN · la persona ya había pagado antes (en el panel o en la web): es una recompra. */
  recompra?: boolean;
  /** MET-ORIGEN-07-FIN · quién compra (correo o teléfono normalizado): una persona cuenta una vez en «compradores». */
  persona?: string;
}

export type PorMoneda = Record<string, { importe: number; devuelto: number }>;
export interface ViaCierre {
  via: string;
  ventas: number;
  devoluciones: number;
  moneda: PorMoneda;
  /** ventas de esta vía cuya persona reservó antes de pagar (ayuda: no suma ventas). */
  conReserva: number;
  /** ventas de esta vía cuya persona habló con un flujo antes de pagar (ayuda: no suma ventas). */
  conFlujo: number;
  /** ventas sin importe registrado: cuentan como venta, no suman dinero. */
  sinImporte: number;
  /** MET-ORIGEN-07-FIN · de sus ventas, cuántas fueron la primera compra de la persona y cuántas recompras. */
  primeras: number;
  recompras: number;
  /** ventas de personas que LLEGARON dentro del rango (lectura por grupo de entrada). */
  deCaptados: number;
  /** personas distintas que compraron por esta vía. */
  compradores: number;
}
export interface PiezaCierre {
  via: string;
  contenido: string;
  campana: string;
  flowId: string;
  ventas: number;
  devoluciones: number;
  moneda: PorMoneda;
  sinImporte: number;
}
export interface EjemploCierre {
  via: string;
  contenido: string;
  campana: string;
  llegoAt: number | null;
  reservoAntes: boolean;
  flujoAntes: boolean;
  pagoAt: number;
  importe: number;
  moneda: string;
  fuente: "panel" | "web";
}
export interface CierreOrigen {
  medido: boolean;
  /** ventas distintas del rango (sin devoluciones), cada una una vez. */
  ventas: number;
  devoluciones: number;
  /** filas repetidas (misma referencia) que se descartaron. */
  repetidas: number;
  moneda: PorMoneda;
  vias: ViaCierre[];
  piezas: PiezaCierre[];
  sinOrigen: { ventas: number; devoluciones: number; moneda: PorMoneda };
  /** MET-ORIGEN-07-FIN · personas distintas que compraron (sin persona conocida, cada venta cuenta como una). */
  compradores: number;
  primeras: number;
  recompras: number;
  /** ventas cuya persona llegó dentro del rango: «ventas de contactos captados en este periodo». */
  deCaptados: number;
  /** Una venta real, sin datos personales, para explicar en qué lectura cuenta y por qué. */
  ejemplo: EjemploCierre | null;
}

const SIN_VIA = (v: string): boolean => {
  const x = String(v || "").trim().toLowerCase();
  return !x || x === "directo" || x === "desconocido";
};
const okNum = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const monedaDe = (m: string): string => String(m || "").trim().toLowerCase() || "?";

function sumar(pm: PorMoneda, moneda: string, importe: number, devolucion: boolean): void {
  const k = monedaDe(moneda);
  const c = pm[k] || (pm[k] = { importe: 0, devuelto: 0 });
  if (devolucion) c.devuelto += Math.abs(importe); else c.importe += importe;
}

/** La primera llegada conocida de la persona que sea ANTERIOR (o del mismo instante) al pago. */
export function primeraLlegada(llegadas: LlegadaPersona[], hasta: number): LlegadaPersona | null {
  let mejor: LlegadaPersona | null = null;
  for (const l of llegadas || []) {
    if (l.at == null || !(l.at > 0) || l.at > hasta || SIN_VIA(l.via)) continue;
    if (!mejor || (l.at as number) < (mejor.at as number)) mejor = l;
  }
  return mejor;
}

export function cierreDeOrigen(o: { ventas: VentaAtribuible[]; medido?: boolean; desde?: number }): CierreOrigen {
  const desde = okNum(o.desde);
  const quienes = new Set<string>();
  const quienesVia = new Map<string, Set<string>>();
  const vias = new Map<string, ViaCierre>();
  const piezas = new Map<string, PiezaCierre>();
  const via = (v: string): ViaCierre => {
    let x = vias.get(v);
    if (!x) { x = { via: v, ventas: 0, devoluciones: 0, moneda: Object.create(null) as PorMoneda, conReserva: 0, conFlujo: 0, sinImporte: 0, primeras: 0, recompras: 0, deCaptados: 0, compradores: 0 }; vias.set(v, x); }
    return x;
  };
  const pieza = (l: LlegadaPersona): PiezaCierre => {
    const k = [l.via, l.contenido, l.flowId].join("\u0001");
    let x = piezas.get(k);
    if (!x) { x = { via: l.via, contenido: l.contenido, campana: l.campana, flowId: l.flowId, ventas: 0, devoluciones: 0, moneda: Object.create(null) as PorMoneda, sinImporte: 0 }; piezas.set(k, x); }
    return x;
  };
  const total: CierreOrigen = {
    medido: o.medido !== false, ventas: 0, devoluciones: 0, repetidas: 0, moneda: Object.create(null) as PorMoneda,
    compradores: 0, primeras: 0, recompras: 0, deCaptados: 0,
    vias: [], piezas: [], sinOrigen: { ventas: 0, devoluciones: 0, moneda: Object.create(null) as PorMoneda }, ejemplo: null,
  };
  const vistas = new Set<string>();
  let mejorEjemplo: { v: VentaAtribuible; l: LlegadaPersona; puntos: number } | null = null;

  for (const v of o.ventas || []) {
    const dev = v.kind === "refund";
    // Un hecho, una vez: la misma referencia no se cuenta dos veces (varias copias o varias vías).
    const clave = (dev ? "dev:" : "") + String(v.ref || "");
    if (v.ref) { if (vistas.has(clave)) { total.repetidas++; continue; } vistas.add(clave); }
    const importe = okNum(v.importe);
    if (dev) total.devoluciones++; else total.ventas++;
    sumar(total.moneda, v.moneda, importe, dev);
    const l = primeraLlegada(v.llegadas, okNum(v.at));
    // MET-ORIGEN-07-FIN · primera compra / recompra y persona distinta (una persona, una vez).
    const quien = String(v.persona || "").trim().toLowerCase() || ("venta:" + clave);
    if (!dev) {
      if (v.recompra) total.recompras++; else total.primeras++;
      quienes.add(quien);
      if (l && desde > 0 && (l.at as number) >= desde) total.deCaptados++;
    }
    if (!l) {
      if (dev) total.sinOrigen.devoluciones++; else total.sinOrigen.ventas++;
      sumar(total.sinOrigen.moneda, v.moneda, importe, dev);
      continue;
    }
    const a = via(l.via);
    const p = pieza(l);
    if (dev) { a.devoluciones++; p.devoluciones++; }
    else {
      a.ventas++; p.ventas++;
      if (v.reservoAntes) a.conReserva++;
      if (v.flujoAntes) a.conFlujo++;
      if (!(importe > 0)) { a.sinImporte++; p.sinImporte++; }
      if (v.recompra) a.recompras++; else a.primeras++;
      if (desde > 0 && (l.at as number) >= desde) a.deCaptados++;
      let qs = quienesVia.get(l.via); if (!qs) { qs = new Set(); quienesVia.set(l.via, qs); }
      qs.add(quien);
      const puntos = (v.reservoAntes ? 2 : 0) + (v.flujoAntes ? 1 : 0) + (l.contenido ? 1 : 0) + (importe > 0 ? 1 : 0);
      if (!mejorEjemplo || puntos > mejorEjemplo.puntos) mejorEjemplo = { v, l, puntos };
    }
    sumar(a.moneda, v.moneda, importe, dev);
    sumar(p.moneda, v.moneda, importe, dev);
  }

  total.compradores = quienes.size;
  for (const a of vias.values()) a.compradores = quienesVia.get(a.via)?.size || 0;
  total.vias = [...vias.values()].sort((a, b) => (b.ventas - a.ventas) || a.via.localeCompare(b.via));
  total.piezas = [...piezas.values()].sort((a, b) => (b.ventas - a.ventas) || a.contenido.localeCompare(b.contenido));
  const e = mejorEjemplo as { v: VentaAtribuible; l: LlegadaPersona; puntos: number } | null;
  if (e) {
    total.ejemplo = {
      via: e.l.via, contenido: e.l.contenido, campana: e.l.campana, llegoAt: e.l.at,
      reservoAntes: !!e.v.reservoAntes, flujoAntes: !!e.v.flujoAntes,
      pagoAt: okNum(e.v.at), importe: okNum(e.v.importe), moneda: monedaDe(e.v.moneda), fuente: e.v.fuente,
    };
  }
  return total;
}
