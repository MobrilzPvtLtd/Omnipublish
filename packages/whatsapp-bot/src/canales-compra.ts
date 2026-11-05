/**
 * CANALES-COMPRA-1 (MET-LEADS-04) · comparar los canales de entrada por tres cosas que no son la misma:
 * cuántas fichas nuevas traen (volumen), qué parte de ellas compra (proporción) y cuánto tardan en
 * comprar (rapidez). El canal que más gente trae no tiene por qué ser el que más compra ni el más rápido.
 *
 * Población: la cohorte de «Fichas nuevas» de «Cuánto tardan en comprar» (miembrosDeCohorte): las fichas
 * que empezaron dentro del periodo y tienen un inicio claro. Canal = la fuente guardada en la ficha al
 * crearse, es decir, el primero que se conoce. No se adjudica ninguna compra a una cuenta ni a una campaña
 * concreta: no hay una cadena registrada que las una.
 *
 * Igualar el tiempo para madurar: «ya han comprado» no sirve para comparar, porque una ficha de ayer aún
 * tiene tiempo. La proporción solo cuenta a quienes llevan 8 días o más desde su inicio (una semana entera)
 * y mira si compraron en los primeros 7. La rapidez es la mediana de quienes compraron en esa misma
 * primera semana, así todos los canales se miden con la misma oportunidad.
 *
 * Muestra pequeña: con menos de MIN_BASE_CANAL personas que ya hayan tenido la semana, el canal no da
 * porcentaje; con menos de MIN_COMPRAS_CANAL compras en la semana, no da tiempo; y no se declara un
 * ganador de proporción ni de rapidez sin al menos dos canales que cumplan lo anterior. «Panel» y
 * «sin fuente» no son canales de captación: se enseñan, pero no compiten.
 *
 * Sin imports en tiempo de ejecución: se prueba tal cual con node.
 */
const DAY = 86400000;
/** «Compró en 7 días o menos» = antes de que pasen 8; es el mismo plazo que «Fichas nuevas». */
export const SEMANA_MS = 8 * DAY;
export const MIN_BASE_CANAL = 30;
export const MIN_COMPRAS_CANAL = 5;
/** Fuentes que describen cómo se creó la ficha, no por dónde llegó la persona. */
const NO_CAPTA = new Set(["panel", "desconocido"]);

export interface MiembroCanal { src: string; edad: number; dt: number | null }
export interface CanalCompra {
  src: string;
  /** false: «panel» y «sin fuente» no son un canal que capte. */
  captacion: boolean;
  /** Fichas nuevas que empezaron aquí. */
  personas: number;
  /** De ellas, las que ya han comprado (hasta hoy, sin igualar el tiempo). */
  compraron: number;
  /** Las que llevan al menos 8 días: han tenido una semana entera para comprar. */
  observadas: number;
  /** De esas, las que compraron en 7 días o menos. */
  compraronSemana: number;
  /** Mediana (ms) de quienes compraron en la primera semana; null con menos de MIN_COMPRAS_CANAL. */
  tiempo: number | null;
}
export interface CanalesPorCompra {
  canales: CanalCompra[];
  minBase: number; minCompras: number;
  /** Quién gana en cada cosa, o null si no hay un ganador claro con muestra suficiente. */
  lideres: { contactos: string | null; proporcion: string | null; rapidez: string | null };
  /** Cuántos canales cumplen el umbral de cada comparación (hacen falta 2). */
  elegibles: { proporcion: number; rapidez: number };
}

/** Mediana con la misma interpolación que `estadistica` de tiempo-compra.ts. */
function mediana(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * 0.5, lo = Math.floor(pos), hi = Math.ceil(pos);
  return Math.round(s[lo] + (s[hi] - s[lo]) * (pos - lo));
}

export function canalesPorCompra(ms: MiembroCanal[]): CanalesPorCompra {
  const g = new Map<string, { personas: number; compraron: number; observadas: number; semana: number[] }>();
  for (const m of ms) {
    const x = g.get(m.src) || { personas: 0, compraron: 0, observadas: 0, semana: [] };
    x.personas++;
    if (m.dt !== null) x.compraron++;
    if (m.edad >= SEMANA_MS) {
      x.observadas++;
      if (m.dt !== null && m.dt < SEMANA_MS) x.semana.push(m.dt);
    }
    g.set(m.src, x);
  }
  const canales: CanalCompra[] = [...g.entries()].map(([src, x]) => ({
    src, captacion: !NO_CAPTA.has(src),
    personas: x.personas, compraron: x.compraron, observadas: x.observadas, compraronSemana: x.semana.length,
    tiempo: x.semana.length >= MIN_COMPRAS_CANAL ? mediana(x.semana) : null,
  })).sort((a, b) => b.personas - a.personas || a.src.localeCompare(b.src));

  const reales = canales.filter((c) => c.captacion);
  // Volumen: solo hay «el que más trae» si hay con quién compararlo y no hay empate.
  const contactos = reales.length >= 2 && reales[0].personas > reales[1].personas ? reales[0].src : null;
  // Proporción: dos canales con base suficiente y un líder con compras suficientes y por encima del segundo.
  const elP = reales.filter((c) => c.observadas >= MIN_BASE_CANAL);
  const tasa = (c: CanalCompra) => c.compraronSemana / c.observadas;
  const oP = [...elP].sort((a, b) => tasa(b) - tasa(a));
  const proporcion = oP.length >= 2 && oP[0].compraronSemana >= MIN_COMPRAS_CANAL && tasa(oP[0]) > tasa(oP[1]) ? oP[0].src : null;
  // Rapidez: dos canales con tiempo medido y un líder estrictamente más rápido.
  const elR = reales.filter((c) => c.tiempo !== null);
  const oR = [...elR].sort((a, b) => (a.tiempo as number) - (b.tiempo as number));
  const rapidez = oR.length >= 2 && (oR[0].tiempo as number) < (oR[1].tiempo as number) ? oR[0].src : null;
  return {
    canales, minBase: MIN_BASE_CANAL, minCompras: MIN_COMPRAS_CANAL,
    lideres: { contactos, proporcion, rapidez },
    elegibles: { proporcion: elP.length, rapidez: elR.length },
  };
}
