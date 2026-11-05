/**
 * MET-LEADS-06-FIN · «Compradores frente a quienes aún no compraron»: qué acciones se ven más entre
 * quienes compraron que entre personas parecidas que todavía no lo han hecho.
 *
 * Para que los dos grupos sean comparables:
 *  - Mismo negocio y misma entrada: las fichas nuevas del periodo (la cohorte de «Fichas nuevas»), sin
 *    importadas ni quien ya había empezado antes. Las compras de la web sin ficha no entran (no se sabe
 *    qué hicieron en tus canales).
 *  - Mismo tiempo de observación: solo quien lleva al menos VENTANA_DIAS desde su inicio. Una ficha de
 *    ayer no se compara con un comprador de hace un mes («todavía no compró» no es «nunca comprará»).
 *  - Misma ventana: se mira lo que hizo cada persona en sus primeros VENTANA_DIAS. Compradores = los que
 *    hicieron su primera compra dentro de esa ventana (se cuenta lo que hicieron ANTES de pagar); el resto
 *    = los que no compraron en ella, aunque compraran más tarde.
 *  - Misma cobertura: fuera quien tiene la conversación cortada o datos ya caducados; un tipo de acción
 *    que no se puede medir en alguien (sin correo, sin red social) no cuenta en su base.
 * Con menos de MIN_GRUPO personas medidas en algún grupo, o menos de MIN_GRUPO medibles en una acción,
 * no se da lectura: muestra pequeña, sin recomendación. Una diferencia es una señal para investigar, no
 * una causa.
 * MET-LEADS-06-FIN · además, una diferencia de 10 puntos con pocas personas medidas (2 de 20) puede ser
 * casualidad: sin pasar la prueba de dos proporciones (|z| ≥ 1,96, ~95 %) la lectura es «incierto», no
 * «más» ni «menos». Y si quedan fuera por datos incompletos (conversación cortada, caducados, sin inicio)
 * tantas personas como las comparadas, no se da lectura: la muestra medida no representa al periodo.
 */
import { dbAccionesPrevias, type AccionesPrevias } from "./db.js";
import { MAX_GUARDADO } from "./memory.js";
import { MARGEN_COMPRA_MS, inicioDe, repartirVentas, tiempoDe, type BaseCompradores } from "./tiempo-compra.js";
import { TIPOS_ACCION, sesiones, type TipoAccion } from "./acciones-compra.js";

const DAY = 86400000;
export const VENTANA_DIAS = 7;
export const MIN_GRUPO = 20;
/** Diferencia mínima, en puntos, para hablar de «más» o «menos» frecuente. */
export const MIN_PUNTOS = 10;
/** Prueba de dos proporciones al ~95 %: por debajo, la diferencia puede ser casualidad. */
export const Z_MIN = 1.96;
const RETENCION_COMENTARIOS_MS = 90 * DAY;

export type Lectura = "mas" | "menos" | "parecido" | "incierto" | "pocos";
export interface GrupoTipo { hicieron: number; medibles: number }
export interface CompararCompra {
  ventanaDias: number; minGrupo: number; minPuntos: number;
  compradores: number; resto: number;
  /** Fuera de la comparación: aún sin la ventana entera · conversación cortada · datos caducados · sin teléfono o sin inicio claro. */
  fuera: { recientes: number; cortada: number; caducado: number; sinInicio: number };
  suficiente: boolean;
  /** MET-LEADS-06-FIN · quedan fuera por datos incompletos al menos tantas personas como se comparan. */
  incompleto: boolean;
  tipos: Array<{ tipo: TipoAccion; c: GrupoTipo; r: GrupoTipo; lectura: Lectura }>;
}

const esSocial = (phone: string) => /^(ig|fb|yt|li):/.test(phone);
function agrupar<T extends { at: number }>(rows: T[], clave: (r: T) => string): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const r of rows) { const k = clave(r); if (!k) continue; const a = m.get(k); if (a) a.push(r.at); else m.set(k, [r.at]); }
  return m;
}

export function lecturaDe(c: GrupoTipo, r: GrupoTipo): Lectura {
  if (c.medibles < MIN_GRUPO || r.medibles < MIN_GRUPO) return "pocos";
  const pc = c.hicieron / c.medibles, pr = r.hicieron / r.medibles, d = (pc - pr) * 100;
  if (Math.abs(d) < MIN_PUNTOS) return "parecido";
  const pp = (c.hicieron + r.hicieron) / (c.medibles + r.medibles);
  const se = Math.sqrt(pp * (1 - pp) * (1 / c.medibles + 1 / r.medibles));
  if (!se || Math.abs(pc - pr) / se < Z_MIN) return "incierto";
  return d > 0 ? "mas" : "menos";
}

/** Cálculo puro sobre la cohorte de fichas nuevas de `base`. */
export function compararCompra(base: BaseCompradores, ap: AccionesPrevias, since: number, now: number): CompararCompra {
  const W = VENTANA_DIAS * DAY;
  const conv = new Map(ap.conv.map((c) => [c.phone, c]));
  const coment = agrupar(ap.comentarios, (r) => r.phone);
  const visitas = agrupar(ap.visitas, (r) => r.phone);
  const regTel = agrupar(ap.registros, (r) => r.phone);
  const regMail = agrupar(ap.registros, (r) => r.email);
  const reservas = agrupar(ap.reservas, (r) => r.email);
  const hace13m = (() => { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - 13); return d.getTime(); })();
  const fuera = { recientes: 0, cortada: 0, caducado: 0, sinInicio: 0 };
  const vacio = (): Record<TipoAccion, GrupoTipo> => ({ conversacion: { hicieron: 0, medibles: 0 }, comentario: { hicieron: 0, medibles: 0 }, visita: { hicieron: 0, medibles: 0 }, registro: { hicieron: 0, medibles: 0 }, reserva: { hicieron: 0, medibles: 0 } });
  const gc = vacio(), gr = vacio();
  let nc = 0, nr = 0;
  for (const [p, ventas] of repartirVentas(base.nuevos.map(base.persona))) {
    if (p.ev.importada) continue;
    const ini = inicioDe(p.ev);
    if (!ini || ini.at < since) continue;
    if (!p.phone) { fuera.sinInicio++; continue; }
    if (now - ini.at < W) { fuera.recientes++; continue; }
    const primera = ventas[0];
    let compro = false;
    if (primera) {
      const t = tiempoDe(p.ev, primera.at);
      if (!("dt" in t)) { fuera.sinInicio++; continue; }
      compro = t.dt < W;
    }
    const cv = conv.get(p.phone);
    if (cv && (cv.turnos >= MAX_GUARDADO || cv.sinFecha > 0)) { fuera.cortada++; continue; }
    const social = esSocial(p.phone);
    if ((social && ini.at < now - RETENCION_COMENTARIOS_MS) || ini.at < hace13m) { fuera.caducado++; continue; }
    // Lo que hizo desde su inicio hasta el fin de su ventana o, si compró en ella, hasta pagar.
    const fin = compro ? primera.at : ini.at + W;
    const dentro = (ts: number[] | undefined) => (ts || []).filter((x) => x >= ini.at - MARGEN_COMPRA_MS && x < fin);
    const lejosDeVentas = (x: number) => ventas.every((c) => Math.abs(x - c.at) > MARGEN_COMPRA_MS);
    const email = (p.email || "").trim().toLowerCase();
    const por: Record<TipoAccion, number | null> = {
      conversacion: sesiones(dentro(cv?.ats)),
      comentario: social ? sesiones(dentro(coment.get(p.phone))) : null,
      visita: sesiones(dentro(visitas.get(p.phone)).filter(lejosDeVentas)),
      registro: email ? sesiones(dentro([...(regTel.get(p.phone) || []), ...(regMail.get(email) || [])]).filter(lejosDeVentas)) : null,
      reserva: email ? sesiones(dentro(reservas.get(email)).filter(lejosDeVentas)) : null,
    };
    const g = compro ? gc : gr;
    if (compro) nc++; else nr++;
    for (const k of TIPOS_ACCION) { if (por[k] === null) continue; g[k].medibles++; if (por[k]) g[k].hicieron++; }
  }
  const incompleto = fuera.cortada + fuera.caducado + fuera.sinInicio >= nc + nr && nc + nr > 0;
  const suficiente = nc >= MIN_GRUPO && nr >= MIN_GRUPO && !incompleto;
  return {
    ventanaDias: VENTANA_DIAS, minGrupo: MIN_GRUPO, minPuntos: MIN_PUNTOS,
    compradores: nc, resto: nr, fuera, suficiente, incompleto,
    tipos: TIPOS_ACCION.map((tipo) => ({ tipo, c: gc[tipo], r: gr[tipo], lectura: suficiente ? lecturaDe(gc[tipo], gr[tipo]) : "pocos" })),
  };
}

/** Lee lo que hicieron las fichas nuevas del periodo y compara. Sólo Postgres; si la lectura falla, lanza. */
export async function compararCompradores(o: { since: number; now: number }, base: BaseCompradores): Promise<CompararCompra> {
  const ps = base.nuevos.map(base.persona);
  const ap = await dbAccionesPrevias(ps.map((p) => p.phone), ps.map((p) => p.email));
  return compararCompra(base, ap, o.since, o.now);
}
