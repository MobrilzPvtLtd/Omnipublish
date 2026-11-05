/**
 * DASH-FUNCIONA-1 (MET-DASH-05) · «Qué está funcionando» del Panel de control.
 *
 * UNA pieza con resultado demostrado (un recorrido automático completo o una difusión) y, como mucho,
 * dos referencias más. Todo sale de lo que Métricas ya mide (Automatización › medirAutomacionB y
 * Whatsapp › dbDifusionesRanking): este módulo solo elige, no calcula nada nuevo ni inventa ventas.
 *
 * Reglas (las del owner):
 *  - Una pieza se valora por SU objetivo: un recorrido, por el que deduce objetivoDeFlujo (comprar,
 *    responder, pasar a una persona); una difusión con enlace, por abrir el enlace o comprar; una sin
 *    enlace, por responder. «Llegó al final» no es un logro.
 *  - Base mínima de BASE_MIN personas y al menos LOGRO_MIN con el logro: con menos no se señala nada
 *    (una venta suelta no demuestra una pieza).
 *  - Las personas se cuentan distintas dentro de cada pieza (COUNT DISTINCT en el SQL). Entre piezas
 *    NO se suman: la misma persona puede haber pasado por un recorrido y por una difusión, y por eso
 *    nunca se presenta una compra entera como mérito exclusivo de varias piezas a la vez.
 *  - Difusión con enlace cuyas compras no se pudieron medir (compradores = null): se dice, no se pone 0.
 *  - Sin pieza con resultado → el motivo, para que el cliente explique qué falta.
 *  - DASH-RECORRIDOS-1 · y, en ese caso, el resumen de los recorridos con actividad (`lista`): cuánta gente
 *    entró en cada uno y lo que consiguió, con las cifras de Métricas › Automatización. Los clics de los que
 *    buscan «reservar» o «abrir el enlace» no son personas distintas: se cuentan como clics, sin porcentaje
 *    ni suma, y nunca como resultado demostrado.
 *
 * Funciones puras: el arnés las prueba desde dist/dash-funciona.js (scripts/test-dash-funciona.mjs).
 */
import type { DifusionFila } from "./db.js";

export const BASE_MIN = 20;
export const LOGRO_MIN = 2;
/** Recorridos que se listan en la tarjeta; el resto se cuenta aparte en `masRecorridos`. */
export const FILAS_MAX = 7;

export type Logro = "compra" | "enlace" | "respuesta" | "persona";
export type MotivoVacio = "sin_datos" | "sin_actividad" | "poca_muestra" | "sin_resultado";
export type ObjetivoRecorrido = "compra" | "reserva" | "clic" | "respuesta" | "persona" | "ninguno";
/** Lo que se cuenta como resultado de un recorrido: personas distintas, salvo «clics», que son aperturas del enlace. */
export type LogroFila = "compraron" | "respondieron" | "derivadas" | "clics";

/** Lo mínimo que se necesita de un recorrido medido (FlujoMedido lo cumple). */
export interface RecorridoBreve {
  id: string; name: string; objetivo: string;
  entradas: number; respondieron: number; compraron: number; derivadas: number;
}

export interface Hallazgo {
  tipo: "recorrido" | "difusion";
  id: string;
  nombre: string;
  logro: Logro;
  /** Personas sobre las que se calcula, y cuántas lograron lo que la pieza buscaba. */
  base: number;
  n: number;
  /** n / base · 100 con un decimal. */
  pct: number;
  /** Difusión: cuándo salió (null en un recorrido). */
  at: number | null;
  /** Difusión con enlace cuyas compras no se pudieron medir: se muestra «aún no podemos medir las ventas». */
  ventasSinMedir: boolean;
}

/** Un recorrido con actividad en el resumen: lo que busca y lo que de verdad consiguió (Métricas › Automatización). */
export interface FilaRecorrido {
  id: string;
  nombre: string;
  objetivo: ObjetivoRecorrido;
  /** Personas distintas que entraron en el periodo. */
  entradas: number;
  /** Qué se cuenta como resultado. null = el recorrido solo envía mensajes: no hay un resultado que medir. */
  logro: LogroFila | null;
  /** Cuántos. null = debería medirse y no se pudo leer (los clics): no es lo mismo que cero. */
  n: number | null;
  /** n / entradas · 100 con un decimal. null con menos de BASE_MIN personas y siempre en los clics (un clic repetido no es otra persona). */
  pct: number | null;
  /** Entraron BASE_MIN personas o más: hay base para valorarlo. */
  conBase: boolean;
}

export interface ResumenFunciona {
  principal: Hallazgo | null;
  secundarios: Hallazgo[];
  motivo: MotivoVacio | null;
  /** Para explicar el vacío: piezas con actividad, piezas con base suficiente y recorridos cuyo objetivo no se mide aquí. */
  recorridos: number;
  difusiones: number;
  conBase: number;
  sinMedir: number;
  baseMin: number;
  logroMin: number;
  /** DASH-RECORRIDOS-1 · los recorridos con actividad, de más a menos gente (hasta FILAS_MAX), y cuántos quedan fuera. */
  lista: FilaRecorrido[];
  masRecorridos: number;
}

const PESO: Record<Logro, number> = { compra: 3, enlace: 2, respuesta: 1, persona: 1 };
const pct1 = (n: number, base: number): number => (base > 0 ? Math.round((n / base) * 1000) / 10 : 0);
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

function deRecorrido(f: RecorridoBreve): Hallazgo | null {
  const base = num(f.entradas);
  let logro: Logro, n: number;
  if (f.objetivo === "compra") { logro = "compra"; n = num(f.compraron); }
  else if (f.objetivo === "respuesta") { logro = "respuesta"; n = num(f.respondieron); }
  else if (f.objetivo === "persona") { logro = "persona"; n = num(f.derivadas); }
  else return null;
  if (base < BASE_MIN || n < LOGRO_MIN) return null;
  return { tipo: "recorrido", id: String(f.id), nombre: String(f.name || ""), logro, base, n: Math.min(n, base), pct: pct1(Math.min(n, base), base), at: null, ventasSinMedir: false };
}

function deDifusion(f: DifusionFila): Hallazgo | null {
  const nombre = String(f.text || f.plantilla || "");
  if (f.llevaEnlace) {
    const base = num(f.aceptados);
    if (base < BASE_MIN) return null;
    if (f.compradores != null && num(f.compradores) >= LOGRO_MIN) {
      const n = Math.min(num(f.compradores), base);
      return { tipo: "difusion", id: String(f.id), nombre, logro: "compra", base, n, pct: pct1(n, base), at: f.at, ventasSinMedir: false };
    }
    if (f.enlace != null && num(f.enlace) >= LOGRO_MIN) {
      const n = Math.min(num(f.enlace), base);
      return { tipo: "difusion", id: String(f.id), nombre, logro: "enlace", base, n, pct: pct1(n, base), at: f.at, ventasSinMedir: f.compradores == null };
    }
    return null;
  }
  const base = num(f.respSeg);
  if (base < BASE_MIN || num(f.respondieron) < LOGRO_MIN) return null;
  const n = Math.min(num(f.respondieron), base);
  return { tipo: "difusion", id: String(f.id), nombre, logro: "respuesta", base, n, pct: pct1(n, base), at: f.at, ventasSinMedir: false };
}

/** Mejor primero: una compra pesa más que abrir un enlace y esto más que responder; dentro, la tasa y luego la cifra. */
function mejor(a: Hallazgo, b: Hallazgo): number {
  return (PESO[b.logro] - PESO[a.logro]) || (b.pct - a.pct) || (b.n - a.n) || a.nombre.localeCompare(b.nombre) || a.id.localeCompare(b.id);
}

const OBJETIVOS: ReadonlySet<string> = new Set(["compra", "reserva", "clic", "respuesta", "persona", "ninguno"]);

/**
 * Mismo criterio que Métricas › Automatización (mxAutoB05): compra → compraron, respuesta → respondieron, persona → pasaron
 * a una persona, reserva y clic → clics en el enlace, ninguno → sin resultado que medir. `clics` null = no se pudieron leer.
 */
function filaDeRecorrido(f: RecorridoBreve, clics: ReadonlyMap<string, number> | null): FilaRecorrido {
  const entradas = num(f.entradas);
  const objetivo = (OBJETIVOS.has(f.objetivo) ? f.objetivo : "ninguno") as ObjetivoRecorrido;
  let logro: LogroFila | null = null;
  let n: number | null = null;
  if (objetivo === "compra") { logro = "compraron"; n = num(f.compraron); }
  else if (objetivo === "respuesta") { logro = "respondieron"; n = num(f.respondieron); }
  else if (objetivo === "persona") { logro = "derivadas"; n = num(f.derivadas); }
  else if (objetivo === "reserva" || objetivo === "clic") { logro = "clics"; n = clics ? num(clics.get(String(f.id))) : null; }
  const conBase = entradas >= BASE_MIN;
  // Personas distintas nunca pasan de las que entraron; los clics se dejan tal cual (un clic repetido no es otra persona).
  if (n != null && logro !== "clics") n = Math.min(n, entradas);
  const pct = n != null && logro !== null && logro !== "clics" && conBase ? pct1(n, entradas) : null;
  return { id: String(f.id), nombre: String(f.name || ""), objetivo, entradas, logro, n, pct, conBase };
}

/** De más a menos gente; a igualdad, por nombre y, al final, por id (orden estable). */
function masGente(a: FilaRecorrido, b: FilaRecorrido): number {
  return (b.entradas - a.entradas) || a.nombre.localeCompare(b.nombre) || a.id.localeCompare(b.id);
}

/**
 * Elige la pieza que mejor funciona y hasta dos referencias más.
 * `recorridos` y `difusiones` son lo medido en las fechas del Dashboard; null en `recorridos` = sin registro persistente.
 * `clics` = clics por recorrido en esas fechas (id → clics; el que no aparece tuvo 0); null/undefined = no se pudieron leer.
 */
export function resumirFunciona(recorridos: RecorridoBreve[] | null, difusiones: DifusionFila[], clics?: ReadonlyMap<string, number> | null): ResumenFunciona {
  const rs = recorridos || [];
  const activos = rs.filter((f) => num(f.entradas) > 0);
  const cand: Hallazgo[] = [];
  let conBase = 0, sinMedir = 0;
  for (const f of activos) {
    if (num(f.entradas) >= BASE_MIN) {
      conBase++;
      if (f.objetivo === "reserva" || f.objetivo === "clic") sinMedir++;
    }
    const h = deRecorrido(f);
    if (h) cand.push(h);
  }
  for (const f of difusiones) {
    const base = f.llevaEnlace ? num(f.aceptados) : num(f.respSeg);
    if (base >= BASE_MIN) conBase++;
    const h = deDifusion(f);
    if (h) cand.push(h);
  }
  cand.sort(mejor);
  const piezas = activos.length + difusiones.length;
  let motivo: MotivoVacio | null = null;
  if (!cand.length) {
    if (recorridos === null && !difusiones.length) motivo = "sin_datos";
    else if (!piezas) motivo = "sin_actividad";
    else if (!conBase) motivo = "poca_muestra";
    else motivo = "sin_resultado";
  }
  const filas = activos.map((f) => filaDeRecorrido(f, clics || null)).sort(masGente);
  return {
    principal: cand[0] || null, secundarios: cand.slice(1, 3), motivo,
    recorridos: activos.length, difusiones: difusiones.length, conBase, sinMedir, baseMin: BASE_MIN, logroMin: LOGRO_MIN,
    lista: filas.slice(0, FILAS_MAX), masRecorridos: Math.max(0, filas.length - FILAS_MAX),
  };
}
