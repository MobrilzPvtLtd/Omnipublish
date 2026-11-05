/**
 * RUTAS-COMPRA-1 (MET-LEADS-05) · los recorridos que se repiten entre quienes compran.
 *
 * Un recorrido es la fuente de la ficha, las acciones que consta que hizo la persona antes de su primera
 * compra (de «Qué hacen antes de comprar») en el orden en que las hizo por primera vez, y la compra.
 * Reglas, siempre las mismas:
 *  - Cada tipo de acción cuenta una sola vez, en su primera aparición: quien visita diez veces la misma
 *    página, o repite un flujo, no se multiplica ni cambia de recorrido por eso.
 *  - Cada comprador pertenece a un único recorrido: la suma de todos los recorridos es el total medido.
 *  - Dos personas siguen el mismo recorrido si tienen la misma fuente y los mismos tipos de acción en el
 *    mismo orden. Cuando alguien repitió un paso, el recorrido lo señala (se resume en uno).
 *  - Solo hay pasos que constan. Lo que no se pudo medir (sin inicio claro, sin ficha, conversación
 *    cortada, datos caducados, sin ninguna acción) no entra y no se rellena.
 *
 * Muestra pequeña: con menos de MIN_MEDIDOS_RUTAS compradores medidos no se enseña ningún recorrido; solo
 * se destaca un recorrido con al menos MIN_RUTA personas (con menos es un ejemplo observado, no un patrón);
 * y no se da el tiempo habitual de un recorrido con menos de MIN_TIEMPO_RUTA personas.
 *
 * Lo último que consta antes de comprar describe el orden, no la causa de la venta.
 *
 * Solo importa tipos: se prueba tal cual con node.
 */
import type { TipoAccion } from "./acciones-compra.js";

export const MIN_MEDIDOS_RUTAS = 5;
export const MIN_RUTA = 3;
export const MIN_TIEMPO_RUTA = 5;
export const MAX_DESTACADAS = 3;
const TIPOS: TipoAccion[] = ["conversacion", "comentario", "visita", "registro", "reserva"];

/** Un comprador medido: su fuente, sus tipos de acción en orden de primera aparición, el último tipo antes
 *  de comprar, lo que tardó y si repitió algún paso. */
export interface MedidoRuta { fuente: string; orden: TipoAccion[]; ultima: TipoAccion; dt: number; repetido: boolean }
export interface RutaCompra {
  clave: string; fuente: string; orden: TipoAccion[];
  /** Compradores que siguieron este recorrido. */
  n: number;
  /** Lo habitual (ms) que tardaron; null con menos de MIN_TIEMPO_RUTA personas. */
  mediana: number | null;
  /** De ellos, cuántos repitieron algún paso (el recorrido lo resume en uno). */
  repetidos: number;
}
export interface RutasDeCompra {
  medidos: number; minMedidos: number; minRuta: number; minTiempo: number;
  /** Todos los recorridos, del más seguido al menos. */
  rutas: RutaCompra[];
  /** Claves de los recorridos que se destacan (vacío si no hay muestra o ninguno llega a MIN_RUTA). */
  destacadas: string[];
  /** Lo último que consta antes de comprar, por tipo de acción. */
  ultimas: Array<{ tipo: TipoAccion; n: number }>;
}

export const claveRuta = (fuente: string, orden: TipoAccion[]): string => fuente + ">" + orden.join(">");

/** Mediana con la misma interpolación que `estadistica` de tiempo-compra.ts. */
function mediana(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * 0.5, lo = Math.floor(pos), hi = Math.ceil(pos);
  return Math.round(s[lo] + (s[hi] - s[lo]) * (pos - lo));
}

export function rutasDeCompra(ms: MedidoRuta[]): RutasDeCompra {
  const g = new Map<string, { fuente: string; orden: TipoAccion[]; dts: number[]; rep: number }>();
  const ult: Record<TipoAccion, number> = { conversacion: 0, comentario: 0, visita: 0, registro: 0, reserva: 0 };
  for (const m of ms) {
    const k = claveRuta(m.fuente, m.orden);
    const x = g.get(k) || { fuente: m.fuente, orden: m.orden, dts: [], rep: 0 };
    x.dts.push(m.dt);
    if (m.repetido) x.rep++;
    g.set(k, x);
    ult[m.ultima]++;
  }
  const rutas: RutaCompra[] = [...g.entries()].map(([clave, x]) => ({
    clave, fuente: x.fuente, orden: x.orden, n: x.dts.length,
    mediana: x.dts.length >= MIN_TIEMPO_RUTA ? mediana(x.dts) : null, repetidos: x.rep,
  })).sort((a, b) => b.n - a.n || a.clave.localeCompare(b.clave));
  const destacadas = ms.length >= MIN_MEDIDOS_RUTAS
    ? rutas.filter((r) => r.n >= MIN_RUTA).slice(0, MAX_DESTACADAS).map((r) => r.clave) : [];
  const ultimas = TIPOS.map((tipo) => ({ tipo, n: ult[tipo] })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  return { medidos: ms.length, minMedidos: MIN_MEDIDOS_RUTAS, minRuta: MIN_RUTA, minTiempo: MIN_TIEMPO_RUTA, rutas, destacadas, ultimas };
}
