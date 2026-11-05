/**
 * DASH-07-CAMPANAS-1 · «Campañas de WhatsApp» del Panel de control.
 *
 * Una campaña es una difusión que ya salió (RESULTADO-DIFUSION-1): las mismas filas y las mismas
 * reglas que Métricas › WhatsApp › «Cada difusión, como campaña». Nunca se deduce una campaña de
 * los mensajes sueltos: los recibidos de la tarjeta de mensajes mezclan respuestas y conversación,
 * y esa tabla no guarda de quién es cada mensaje.
 *
 * Funciones puras, para que el arnés las pruebe desde dist/dash-campanas.js:
 *  - rangoCampanas: las fechas que manda el Dashboard (las de /dashboard/metricas), validadas.
 *  - resumirCampanas: el resumen del periodo y las últimas difusiones.
 *
 * Las respuestas se suman solo en las difusiones con seguimiento (las anteriores salen «—», no 0,
 * como en Métricas) y las compras solo si se midieron (null = sin medir, nunca 0).
 */
import type { DifusionFila } from "./db.js";

const DIA = 86_400_000;

export interface RangoCampanas { desde: number; hasta: number; prevDesde: number | null; prevHasta: number | null }

/** El periodo, con las mismas reglas que /dashboard/metricas (30 días por defecto, 400 como mucho).
 *  El anterior solo vale si cae entero antes del actual y no es más largo que él. */
export function rangoCampanas(q: Record<string, unknown>, ahora: number): RangoCampanas {
  const instante = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < ahora + 366 * DIA ? n : 0; };
  let hasta = instante(q.to) || ahora;
  let desde = instante(q.from) || hasta - 30 * DIA;
  if (!(hasta > desde)) { hasta = ahora; desde = ahora - 30 * DIA; }
  if (hasta - desde > 400 * DIA) desde = hasta - 400 * DIA;
  const pd = instante(q.pfrom), ph = instante(q.pto);
  const valido = pd > 0 && ph >= pd && ph < desde && ph - pd <= hasta - desde + DIA;
  return { desde, hasta, prevDesde: valido ? pd : null, prevHasta: valido ? ph : null };
}

export interface CampanaBreve {
  id: string; text: string; plantilla: string; at: number; personas: number; aceptados: number; respSeg: number; respondieron: number;
  llevaEnlace: boolean | null; enlace: number | null; compradores: number | null;
}
export interface ResumenCampanas {
  /** Difusiones que salieron en el periodo, y en el anterior (null: sin periodo anterior). */
  n: number; prevN: number | null;
  /** Sumas por difusión: quien recibió dos difusiones cuenta en las dos. */
  personas: number; aceptados: number;
  /** Solo de las difusiones con seguimiento de respuestas; sinSeg = las que no lo tienen. */
  respSeg: number; respondieron: number; sinSeg: number;
  /** Difusiones que llevaban enlace y personas que lo abrieron (null: ninguna llevaba). */
  conEnlace: number; enlace: number | null;
  /** Pagaron con un enlace de pago del panel en los 7 días siguientes (null: sin medir). */
  compradores: number | null;
  /** METRICAS-1 · difusiones del periodo en las que la compra no se pudo medir, y a cuántas personas
   *  llegaron las que SÍ se midieron (base del % de compra: las no medidas no cuentan como «no compró»). */
  compSinMedir: number; aceptMedidos: number;
  ultimas: CampanaBreve[];
}

export function resumirCampanas(filas: DifusionFila[], r: RangoCampanas, max = 3): ResumenCampanas {
  const entre = (f: DifusionFila, a: number, b: number) => f.at >= a && f.at <= b;
  const enviadas = filas.filter(f => f.aceptados > 0);
  const cur = enviadas.filter((f) => entre(f, r.desde, r.hasta)).sort((a, b) => b.at - a.at);
  const prevN = r.prevDesde != null && r.prevHasta != null
    ? enviadas.filter((f) => entre(f, r.prevDesde as number, r.prevHasta as number)).length : null;
  let personas = 0, aceptados = 0, respSeg = 0, respondieron = 0, sinSeg = 0, conEnlace = 0;
  let enlace: number | null = null, compradores: number | null = null, compSinMedir = 0, aceptMedidos = 0;
  for (const f of cur) {
    personas += f.personas || 0;
    aceptados += f.aceptados || 0;
    if (f.respSeg > 0) { respSeg += f.respSeg; respondieron += f.respondieron || 0; } else sinSeg++;
    if (f.llevaEnlace) { conEnlace++; enlace = (enlace || 0) + (f.enlace || 0); }
    if (f.compradores != null) { compradores = (compradores || 0) + f.compradores; aceptMedidos += f.aceptados || 0; } else compSinMedir++;
  }
  const ultimas = cur.slice(0, max).map((f) => ({
    id: f.id, text: f.text, plantilla: f.plantilla || "", at: f.at, personas: f.personas, aceptados: f.aceptados, respSeg: f.respSeg,
    respondieron: f.respondieron, llevaEnlace: f.llevaEnlace, enlace: f.enlace, compradores: f.compradores,
  }));
  return { n: cur.length, prevN, personas, aceptados, respSeg, respondieron, sinSeg, conEnlace, enlace, compradores, compSinMedir, aceptMedidos, ultimas };
}
