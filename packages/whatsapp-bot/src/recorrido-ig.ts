/**
 * RECORRIDO-PUB-IG-1 · MET-IG-05-FIN (MET-IG-05) · de una publicación o story de Instagram a la venta: qué pasó
 * después de cada pieza, paso a paso y sólo hasta donde se puede comprobar.
 *
 * Módulo puro (sin base de datos): las filas las trae `dbRecorridoPublicacionesIg` (db.ts) y el
 * endpoint GET /admin/api/analytics/ig-recorrido las pasa por aquí. Los contactos nuevos salen de
 * las MISMAS filas que «Contactos de Instagram» (PORTADA-IG-1: mismo canal, sin las altas del
 * equipo), así que «12 contactos nuevos desde esta publicación» se reconstruye exactamente con la
 * lista que abre el panel.
 *
 * ── El camino, y cada paso por separado ──
 *   publicación o story → flujo activado → mensaje enviado → contestó → contacto nuevo → venta
 *   · «Activó el flujo» NO es «recibió un mensaje» (el envío puede fallar o el flujo empezar con
 *     una espera) y «recibió un mensaje» NO es «es un contacto nuevo».
 *   · El comentario o la respuesta a la story que dispara el flujo no se guarda como conversación:
 *     «contestó» sólo cuenta lo que la persona escribe DESPUÉS de entrar en el flujo.
 *   · Una persona que ya tenía ficha antes de estos días y vuelve a escribir cuenta como
 *     conversación, nunca como contacto nuevo. Una persona que interactúa con varias piezas sale en
 *     cada una de ellas (activó sus flujos), pero como contacto nuevo cuenta UNA sola vez.
 *
 * ── La regla de asignación (la de «Cómo llegaron», MET-ORIGEN-07: primer contacto) ──
 *   Un contacto nuevo y sus ventas cuentan para la pieza por la que esa persona llegó la PRIMERA
 *   vez: el primer flujo en el que entró (el que ya usa «Contactos de Instagram»). Una interacción
 *   posterior con otra pieza nunca pisa ese primer origen. Si llegó antes por otra vía (un mensaje
 *   directo, otra pieza, un enlace) cuenta para esa vía y aquí sólo se dice cuántas personas son.
 *   Lo que no se puede unir a una pieza (flujos de «cualquier publicación») se cuenta aparte.
 *
 * ── Qué es una venta «de la pieza» ──
 *   Sólo la de un contacto nuevo de la pieza, pagada dentro de las fechas elegidas y DESPUÉS de
 *   llegar. Una venta que ocurrió después de la publicación pero de alguien que ya era contacto o
 *   llegó por otra vía NO se da a la pieza: se dice aparte. Las devoluciones no restan ventas:
 *   también se dicen aparte. Cada venta cuenta una vez (por su identidad, `ref`).
 *
 * ── Lo que no se puede medir (se dice, nunca se rellena con ceros) ──
 *   · Los comentarios y mensajes que NO activaron ningún flujo no se guardan: no hay forma de
 *     saber cuántos comentarios tuvo la pieza más allá de lo que ya cuentan sus flujos.
 *   · Los mensajes enviados por el flujo salen del historial de eventos, que se conserva unos 90
 *     días: de personas que entraron antes el paso es «sin medir».
 *   · Sin ninguna venta registrada (ni del panel ni de la web) las ventas son «sin medir».
 *   · Una venta de la web sólo se une a una persona por su correo (IDENTIDAD-COMUN-1, MET-AUTO-09):
 *     las que no enlazan con ninguna ficha no se atribuyen a ninguna pieza.
 */

export interface FlujoDePieza { id: string; nombre: string }
/** Una publicación («comentario») o una story con al menos un flujo atado a ella. */
export interface PiezaIg { mediaId: string; tipo: "comentario" | "story"; flujos: FlujoDePieza[] }
/** Una persona que entró en un flujo: una fila por (persona, flujo). */
export interface EntradaIg {
  phone: string;
  flow_id: string;
  /** Cuándo entró (ms). */
  entro: number;
  /** El flujo le envió al menos un mensaje; null = no se puede saber (la entrada es anterior al historial). */
  mensaje: boolean | null;
  /** Escribió después de entrar. */
  contesto: boolean;
  /** Cuándo nació su ficha (ms); null = no tiene ficha. */
  alta: number | null;
  nombre: string;
}
/** Un contacto nuevo de Instagram en las fechas elegidas (las mismas filas que «Contactos de Instagram»). */
export interface NuevoIg { phone: string; nombre: string; alta: number; flow_id: string }
/** Una compra de una persona, con su importe y dónde se pagó ya resueltos. */
export interface CompraIg {
  phone: string;
  at: number;
  /** Identidad de la venta: dos fichas con el mismo correo ven la misma venta web, que cuenta una vez. */
  ref: string;
  kind: "sale" | "refund";
  producto: string;
  /** Dónde se pagó: el nombre de la web o «enlace de pago del panel». */
  donde: string;
  importe: number;
  moneda: string;
  /** El importe sale del precio configurado del producto porque la venta no lo trajo. */
  estimado: boolean;
  sinImporte: boolean;
}

export type RolIg = "nuevo" | "yaEra" | "otraVia" | "sinFicha";
export interface PersonaPiezaIg {
  phone: string;
  nombre: string;
  rol: RolIg;
  entro: number | null;
  mensaje: boolean | null;
  contesto: boolean;
  alta: number | null;
  ventas: number;
  devoluciones: number;
}
export interface VentaPiezaIg {
  phone: string;
  nombre: string;
  at: number;
  producto: string;
  donde: string;
  importe: number;
  moneda: string;
  estimado: boolean;
  sinImporte: boolean;
}
export interface Importe { moneda: string; importe: number }
export interface PiezaRecorridoIg {
  mediaId: string;
  tipo: "comentario" | "story";
  flujos: FlujoDePieza[];
  /** Personas que entraron en algún flujo de la pieza (o cuya ficha nació por ella) en estos días. */
  activaron: number;
  /** De ellas, a las que el flujo les envió al menos un mensaje. */
  mensaje: number;
  /** De ellas, las que entraron antes de lo que guarda el historial: no se sabe. */
  mensajeSinMedir: number;
  contestaron: number;
  nuevos: number;
  /** Ya tenían ficha antes de estos días: cuentan como conversación, no como contacto nuevo. */
  yaEran: number;
  /** Su ficha nació en estos días pero llegaron antes por otra vía. */
  otraVia: number;
  /** Entraron en el flujo pero no tienen ficha. */
  sinFicha: number;
  /** null = sin medir (no hay ninguna venta registrada). */
  ventas: number | null;
  importes: Importe[];
  estimado: boolean;
  sinImporte: number;
  devoluciones: number;
}
export interface RecorridoPubIg {
  /** Hay base de datos que leer (en memoria no hay historial de flujos ni ventas). */
  medido: boolean;
  /** Hay alguna venta registrada (panel o web): sin ninguna, las ventas son «sin medir», no 0. */
  ventasMedidas: boolean;
  /** Se llegó al tope de filas: las cifras pueden quedarse cortas. */
  parcial: boolean;
  piezas: PiezaRecorridoIg[];
  /** Publicaciones o stories con flujo pero sin ninguna actividad en estos días. */
  sinActividad: number;
  /** Personas distintas (una persona en varias piezas cuenta una vez). */
  total: {
    activaron: number; mensaje: number; mensajeSinMedir: number; contestaron: number;
    nuevos: number; ventas: number | null; importes: Importe[]; estimado: boolean; sinImporte: number; devoluciones: number;
  };
  /** Flujos de «cualquier publicación» o «cualquier story»: no se pueden atar a una pieza concreta. */
  sinPieza: { flujos: number; activaron: number; nuevos: number };
  huecos: {
    /** Ventas de personas que activaron estas piezas pero no llegaron por ellas: no cuentan para la pieza. */
    ventasSinAtribuir: number;
    /** Ventas de un contacto nuevo anteriores a su llegada: tampoco cuentan. */
    ventasAntes: number;
    /** Ventas de la web de estos días que no enlazan con ninguna ficha (no se pueden atribuir a nada). */
    ventasWebSinFicha: number;
  };
  detalle: { tipo: "comentario" | "story"; mediaId: string; personas: PersonaPiezaIg[]; ventas: VentaPiezaIg[]; recortado: boolean } | null;
}

const red2 = (n: number): number => Math.round(n * 100) / 100;
const finito = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const ordenImportes = (m: Map<string, number>): Importe[] =>
  [...m].map(([moneda, importe]) => ({ moneda, importe: red2(importe) })).sort((a, b) => b.importe - a.importe || a.moneda.localeCompare(b.moneda));

/** Tope de personas que se devuelven en el detalle de una pieza (las más recientes). */
export const TOPE_DETALLE_IG = 2000;

export function recorridoPublicacionesIg(o: {
  sinceMs: number;
  untilMs: number;
  piezas: PiezaIg[];
  /** Flujos de «cualquier publicación» / «cualquier story»: no atables a una pieza. */
  sinPieza: FlujoDePieza[];
  entradas: EntradaIg[];
  nuevos: NuevoIg[];
  compras: CompraIg[];
  medido: boolean;
  ventasMedidas: boolean;
  parcial?: boolean;
  ventasWebSinFicha?: number;
  detalle?: { tipo: "comentario" | "story"; mediaId: string };
}): RecorridoPubIg {
  const enRango = (t: number | null): boolean => t != null && t >= o.sinceMs && t <= o.untilMs;
  const clave = (tipo: string, mediaId: string): string => tipo + "|" + mediaId;

  // Piezas y qué flujo pertenece a cuál (una pieza puede tener varios flujos).
  const piezas = new Map<string, PiezaIg>();
  const piezaDeFlujo = new Map<string, string>();
  for (const p of o.piezas) {
    const k = clave(p.tipo, p.mediaId);
    const ya = piezas.get(k);
    if (ya) { for (const f of p.flujos) if (!ya.flujos.some((x) => x.id === f.id)) ya.flujos.push(f); }
    else piezas.set(k, { mediaId: p.mediaId, tipo: p.tipo, flujos: [...p.flujos] });
    for (const f of p.flujos) piezaDeFlujo.set(f.id, k);
  }
  const sinPiezaIds = new Set(o.sinPieza.map((f) => f.id));

  // Las entradas, por pieza y persona.
  const porPieza = new Map<string, Map<string, EntradaIg[]>>();
  const sinPiezaGente = new Set<string>();
  for (const e of o.entradas) {
    if (!e.phone) continue;
    const k = piezaDeFlujo.get(e.flow_id);
    if (k) {
      let m = porPieza.get(k);
      if (!m) { m = new Map(); porPieza.set(k, m); }
      const l = m.get(e.phone);
      if (l) l.push(e); else m.set(e.phone, [e]);
    } else if (sinPiezaIds.has(e.flow_id)) sinPiezaGente.add(e.phone);
  }

  // Contactos nuevos: su primer flujo decide la pieza (la misma regla que «Contactos de Instagram»).
  const nuevoDe = new Map<string, string>();
  const nuevoInfo = new Map<string, NuevoIg>();
  let sinPiezaNuevos = 0;
  for (const n of o.nuevos) {
    if (!n.phone || nuevoInfo.has(n.phone)) continue;
    nuevoInfo.set(n.phone, n);
    const k = piezaDeFlujo.get(n.flow_id);
    if (k) nuevoDe.set(n.phone, k);
    else if (sinPiezaIds.has(n.flow_id)) sinPiezaNuevos++;
  }

  const comprasDe = new Map<string, CompraIg[]>();
  for (const c of [...o.compras].sort((a, b) => a.at - b.at)) {
    if (!c.phone) continue;
    const l = comprasDe.get(c.phone);
    if (l) l.push(c); else comprasDe.set(c.phone, [c]);
  }

  const refsUsadas = new Set<string>();
  const huecos = { ventasSinAtribuir: 0, ventasAntes: 0, ventasWebSinFicha: Math.max(0, Math.round(Number(o.ventasWebSinFicha) || 0)) };
  // Estado de cada persona entre todas las piezas (para los totales: una persona, una vez).
  const deTodas = new Map<string, { mensaje: boolean | null; contesto: boolean }>();
  const buscado = o.detalle ? clave(o.detalle.tipo, o.detalle.mediaId) : "";
  let detalle: RecorridoPubIg["detalle"] = null;

  const filas: PiezaRecorridoIg[] = [];
  let sinActividad = 0;
  const totImportes = new Map<string, number>();
  let totVentas = 0, totEstimado = false, totSinImporte = 0, totDevol = 0, totNuevos = 0;

  for (const [k, pz] of piezas) {
    const mapa = porPieza.get(k) || new Map<string, EntradaIg[]>();
    const gente = new Set<string>(mapa.keys());
    for (const [ph, kk] of nuevoDe) if (kk === k) gente.add(ph);
    if (!gente.size) { sinActividad++; continue; }

    let mensaje = 0, mensajeSinMedir = 0, contestaron = 0, nuevos = 0, yaEran = 0, otraVia = 0, sinFicha = 0;
    let ventas = 0, devoluciones = 0, sinImporte = 0, estimado = false;
    const importes = new Map<string, number>();
    const personas: PersonaPiezaIg[] = [];
    const ventasDet: VentaPiezaIg[] = [];

    for (const ph of gente) {
      const es = mapa.get(ph) || [];
      const info = nuevoInfo.get(ph);
      const altaEs = es.map((x) => x.alta).find((a) => typeof a === "number" && Number.isFinite(a));
      const alta: number | null = (typeof altaEs === "number" ? altaEs : null) ?? (info ? info.alta : null);
      const nombre = String(info?.nombre || es.map((x) => x.nombre).find((x) => !!x) || "");
      // «sin medir» (null) cuando no hay entradas de las que fiarse o alguna es anterior al historial y ninguna dice que sí.
      const mens: boolean | null = es.some((x) => x.mensaje === true) ? true : (!es.length || es.some((x) => x.mensaje === null)) ? null : false;
      const contesto = es.some((x) => x.contesto);
      const entro = es.reduce<number | null>((m, x) => (finito(x.entro) != null && (m == null || x.entro > m) ? x.entro : m), null);
      const rol: RolIg = nuevoDe.get(ph) === k ? "nuevo" : alta == null ? "sinFicha" : alta < o.sinceMs ? "yaEra" : "otraVia";

      if (mens === true) mensaje++; else if (mens === null) mensajeSinMedir++;
      if (contesto) contestaron++;
      if (rol === "nuevo") nuevos++; else if (rol === "yaEra") yaEran++; else if (rol === "otraVia") otraVia++; else sinFicha++;
      const g = deTodas.get(ph);
      if (!g) deTodas.set(ph, { mensaje: mens, contesto });
      else {
        g.mensaje = g.mensaje === true || mens === true ? true : (g.mensaje === null || mens === null ? null : false);
        g.contesto = g.contesto || contesto;
      }

      // Las ventas sólo cuentan para el contacto NUEVO de la pieza: pagadas en estos días y después de llegar.
      let vp = 0, dp = 0;
      if (rol === "nuevo") {
        for (const c of comprasDe.get(ph) || []) {
          if (c.ref) { if (refsUsadas.has(c.ref)) continue; refsUsadas.add(c.ref); }
          if (!enRango(c.at)) continue;
          if (c.kind === "refund") { dp++; devoluciones++; continue; }
          if (alta != null && c.at < alta) { huecos.ventasAntes++; continue; }
          vp++; ventas++;
          if (c.sinImporte) sinImporte++;
          else importes.set(c.moneda, (importes.get(c.moneda) || 0) + c.importe);
          if (c.estimado) estimado = true;
          if (k === buscado) ventasDet.push({ phone: ph, nombre, at: c.at, producto: c.producto, donde: c.donde, importe: c.importe, moneda: c.moneda, estimado: c.estimado, sinImporte: c.sinImporte });
        }
      }
      if (k === buscado) personas.push({ phone: ph, nombre, rol, entro, mensaje: mens, contesto, alta, ventas: vp, devoluciones: dp });
    }

    totNuevos += nuevos; totVentas += ventas; totDevol += devoluciones; totSinImporte += sinImporte; if (estimado) totEstimado = true;
    for (const [m, v] of importes) totImportes.set(m, (totImportes.get(m) || 0) + v);
    filas.push({
      mediaId: pz.mediaId, tipo: pz.tipo, flujos: pz.flujos,
      activaron: gente.size, mensaje, mensajeSinMedir, contestaron, nuevos, yaEran, otraVia, sinFicha,
      ventas: o.ventasMedidas ? ventas : null, importes: ordenImportes(importes), estimado, sinImporte, devoluciones,
    });
    if (k === buscado) {
      personas.sort((a, b) => (b.entro ?? 0) - (a.entro ?? 0) || a.phone.localeCompare(b.phone));
      ventasDet.sort((a, b) => b.at - a.at);
      detalle = {
        tipo: pz.tipo, mediaId: pz.mediaId,
        personas: personas.slice(0, TOPE_DETALLE_IG), ventas: ventasDet, recortado: personas.length > TOPE_DETALLE_IG,
      };
    }
  }

  // Ventas de personas que activaron estas piezas pero no llegaron por ellas: se dicen aparte, no se dan a ninguna pieza.
  for (const [ph] of deTodas) {
    if (nuevoDe.has(ph)) continue;
    for (const c of comprasDe.get(ph) || []) {
      if (c.ref) { if (refsUsadas.has(c.ref)) continue; refsUsadas.add(c.ref); }
      if (c.kind === "sale" && enRango(c.at)) huecos.ventasSinAtribuir++;
    }
  }

  filas.sort((a, b) => (b.nuevos - a.nuevos) || (b.activaron - a.activaron) || (a.tipo + a.mediaId).localeCompare(b.tipo + b.mediaId));
  let mensajeT = 0, mensajeSinMedirT = 0, contestaronT = 0;
  for (const g of deTodas.values()) {
    if (g.mensaje === true) mensajeT++; else if (g.mensaje === null) mensajeSinMedirT++;
    if (g.contesto) contestaronT++;
  }
  return {
    medido: o.medido,
    ventasMedidas: o.ventasMedidas,
    parcial: !!o.parcial,
    piezas: filas.slice(0, 200),
    sinActividad,
    total: {
      activaron: deTodas.size, mensaje: mensajeT, mensajeSinMedir: mensajeSinMedirT, contestaron: contestaronT,
      nuevos: totNuevos, ventas: o.ventasMedidas ? totVentas : null, importes: ordenImportes(totImportes),
      estimado: totEstimado, sinImporte: totSinImporte, devoluciones: totDevol,
    },
    sinPieza: { flujos: o.sinPieza.length, activaron: sinPiezaGente.size, nuevos: sinPiezaNuevos },
    huecos,
    detalle,
  };
}
