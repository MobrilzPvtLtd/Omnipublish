/**
 * DIVISA-1 · el cambio del día entre monedas, para que el panel pueda enseñar UN total cuando
 * un negocio cobra en euros y en dólares a la vez, en vez de dos cifras que hay que sumar a mano.
 *
 * Fuente: los tipos de referencia del Banco Central Europeo (públicos, sin clave, uno por día
 * hábil). Vienen expresados por euro: `tasas.USD = 1.1181` quiere decir 1 € = 1,1181 US$.
 *
 * Frenos: una lectura cada 6 h; si falla, se sigue sirviendo la última buena y se reintenta a
 * los 10 min. Si nunca hubo una buena se devuelve `null` y el panel enseña las monedas por
 * separado, como antes: jamás se inventa un cambio (FALSO-CERO-1).
 */

export interface TasasDivisa {
  /** Moneda en la que están expresadas las tasas. */
  base: "EUR";
  /** Unidades de cada moneda que da 1 euro. Incluye `EUR: 1`. */
  tasas: Record<string, number>;
  /** Día al que corresponde el cambio (AAAA-MM-DD), según la fuente. */
  fecha: string;
  /** Cuándo se leyó (ms). */
  leido: number;
}

const FUENTE = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const VIGENCIA_MS = 6 * 60 * 60 * 1000;
const REINTENTO_MS = 10 * 60 * 1000;

let ultima: TasasDivisa | null = null;
let proximoIntento = 0;
let enCurso: Promise<TasasDivisa | null> | null = null;

/** Convierte el XML del BCE en tasas. Exportada para probarla sin red. */
export function leerTasasBce(xml: string, ahora = Date.now()): TasasDivisa | null {
  const fecha = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1] || "";
  const tasas: Record<string, number> = { EUR: 1 };
  const re = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const v = Number(m[2]);
    if (Number.isFinite(v) && v > 0) tasas[m[1]] = v;
  }
  // Sin dólar no hay nada que ofrecer: mejor «sin cambio» que una tabla a medias.
  if (!fecha || !tasas.USD) return null;
  return { base: "EUR", tasas, fecha, leido: ahora };
}

async function leer(): Promise<TasasDivisa | null> {
  try {
    const r = await fetch(FUENTE, { signal: AbortSignal.timeout(12_000), headers: { Accept: "application/xml" } });
    if (!r.ok) return null;
    return leerTasasBce(await r.text());
  } catch {
    return null;
  }
}

/** El cambio vigente, o `null` si todavía no se ha podido leer ninguno. */
export async function tasasDivisa(): Promise<TasasDivisa | null> {
  const ahora = Date.now();
  if (ultima && ahora - ultima.leido < VIGENCIA_MS) return ultima;
  if (ahora < proximoIntento) return ultima;
  if (!enCurso) {
    enCurso = leer()
      .then((t) => {
        if (t) ultima = t;
        else proximoIntento = Date.now() + REINTENTO_MS;
        return ultima;
      })
      .finally(() => {
        enCurso = null;
      });
  }
  return enCurso;
}

/** Solo para los arneses: fija (o borra) el cambio sin salir a la red. */
export function fijarTasasDivisaParaPruebas(t: TasasDivisa | null): void {
  ultima = t;
  proximoIntento = t ? 0 : Date.now() + REINTENTO_MS;
}
