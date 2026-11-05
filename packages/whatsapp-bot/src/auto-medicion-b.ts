/**
 * AUTO-MEDICION-B-1 (MET-AUTO-05/06/07/08/10/11) · lo que la pestaña Automatización de Métricas
 * enseña sobre el OBJETIVO de cada flujo, sus pasos, el seguimiento, la suscripción y las difusiones.
 *
 * Reglas (las del owner):
 *  - Cada flujo se mide por SU objetivo (comprar, reservar, abrir el enlace, responder, pasar a una
 *    persona), deducido de lo que el propio flujo hace. «Llegó al final» es un dato técnico, no el logro.
 *  - Una persona que espera, la que sale por otra rama, la que abandona y la que tuvo un error son
 *    cuatro cosas distintas: cada paso las cuenta por separado.
 *  - Sin datos en el registro → se dice qué falta; nunca se inventa un número.
 *
 * El SQL vive en db.ts (dbAutoMedicionB); aquí sólo se ordena y se etiqueta por flujo.
 */
import { dbAutoMedicionB, dbDifusionesRanking, dbCorreosQueLlevan, type AutoMedicionBDatos, type DifusionFila } from "./db.js";
import { getEmailCatalog } from "./email-catalog.js";

type NodoLike = { type?: string; text?: string; link?: string; kind?: string; notify?: boolean; escalate?: boolean; startFlow?: string; minutes?: number; seconds?: number; options?: Array<{ label?: string }> };
export type FlujoLike = { id: string; name?: string; start?: string; stopTag?: string; nodes?: Record<string, NodoLike> };

export type ObjetivoFlujo = "compra" | "reserva" | "clic" | "respuesta" | "persona" | "traspaso" | "ninguno";

/** Qué intenta conseguir el flujo, mirando lo que hace (no una finalización universal). */
export function objetivoDeFlujo(f: FlujoLike): ObjetivoFlujo {
  const nodos = Object.values(f.nodes || {});
  if (String(f.stopTag || "").trim()) return "compra";
  if (nodos.some((n) => n.type === "action" && n.kind === "book")) return "reserva";
  if (nodos.some((n) => n.type === "message" && String(n.link || "").trim())) return "clic";
  if (nodos.some((n) => n.type === "ask" || n.type === "buttons")) return "respuesta";
  if (nodos.some((n) => n.type === "action" && (n.notify || n.escalate || n.kind === "notify"))) return "persona";
  // MET-AUTO-05-FIN · un flujo que solo entrega al siguiente cumple al pasarle la persona.
  if (nodos.some((n) => String(n.startFlow || "").trim())) return "traspaso";
  return "ninguno";
}

const rec = (s: string, n = 46): string => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Nombre humano de un paso: lo que hace y su texto, sin identificadores. */
function nombrePaso(n: NodoLike | undefined, id: string): { txt: string; tipo: string } {
  if (!n) return { txt: id ? "Paso eliminado del flujo" : "Antes de empezar", tipo: "" };
  switch (n.type) {
    case "message": return { txt: "Mensaje · " + rec(n.text || "", 40) + (n.link ? " (con enlace)" : ""), tipo: "mensaje" };
    case "ask": return { txt: "Pregunta · " + rec(n.text || "", 40), tipo: "respuesta" };
    case "buttons": return { txt: "Botones · " + rec(n.text || "", 40), tipo: "respuesta" };
    case "follow": return { txt: "Pide seguir la cuenta", tipo: "respuesta" };
    case "condition": return { txt: "Decisión entre dos ramas", tipo: "rama" };
    case "delay": return { txt: "Espera programada", tipo: "espera" };
    case "action": return { txt: "Acción interna", tipo: "accion" };
    case "end": return { txt: "Fin del flujo", tipo: "fin" };
    default: return { txt: "Paso", tipo: "" };
  }
}

export interface PasoMedido { txt: string; tipo: string; espera: number; terminaron: number; abandonan: number; error: number; siguieron: number }
export interface FlujoMedido {
  id: string; name: string; objetivo: ObjetivoFlujo;
  entradas: number; fin: number; respondieron: number; compraron: number; derivadas: number;
  // MET-AUTO-05-FIN · traspasados: pasaron a otro flujo (éxito de este, no fin de la campaña);
  // enCurso: siguen dentro esperando su turno — aún a tiempo, nunca abandono.
  traspasados: number; enCurso: number;
  // MET-AUTO-05-FIN · lo que pasó después: clic ≠ visita confirmada, reserva ≠ cita celebrada ≠ asistencia, oferta vista ≠ compra.
  embudo: { clicaron: number; visitaron: number; reservaron: number; canceladas: number; celebradas: number; asistieron: number; vieronOferta: number; compraron: number };
  pasos: PasoMedido[];
  seguimiento: { aviso1: number; aviso2: number; aviso3: number; pospuestos: number; aplazados: number; repetidos: number; derivados: number; sinAviso: number; reservaronTras: number; cancReserva: number };
  resultado: { suscritas: number; conResultado: number; suscSinResultado: number; aMedias: number };
}
export interface MedicionAutomatizacionB {
  flujos: FlujoMedido[];
  difusiones: DifusionFila[];
  /** MET-AUTO-10-FIN · correos que llevaron tráfico o respuestas; null = sin rastro de correo. */
  correos: Array<{ asunto: string; abrieron: number; clicaron: number; volvieron: number; sinVincular: number }> | null;
}

/** Junta el registro de eventos con la definición de cada flujo. null = sin base persistente. */
export async function medirAutomacionB(
  w: { sinceMs: number; untilMs: number },
  flows: FlujoLike[],
  flowIds?: string[],
  conDifusiones = true,
): Promise<MedicionAutomatizacionB | null> {
  const datos: AutoMedicionBDatos | null = await dbAutoMedicionB(w.sinceMs, w.untilMs, flowIds);
  if (!datos) return null;
  const ev = new Map<string, Map<string, number>>();
  const evV = new Map<string, Map<string, number>>();
  for (const e of datos.eventos) {
    if (!ev.has(e.flow_id)) { ev.set(e.flow_id, new Map()); evV.set(e.flow_id, new Map()); }
    ev.get(e.flow_id)!.set(e.event, e.personas);
    evV.get(e.flow_id)!.set(e.event, e.veces);
  }
  const personas = (fid: string, ...nombres: string[]): number => {
    const m = ev.get(fid);
    return m ? nombres.reduce((a, k) => a + (m.get(k) || 0), 0) : 0;
  };
  const derivadasDe = (fid: string): number => {
    const m = ev.get(fid);
    if (!m) return 0;
    let t = 0;
    for (const [k, v] of m) if (k.startsWith("derivado")) t += v;
    return t;
  };
  const trasp = new Map<string, number>();
  for (const t of datos.traspasos || []) trasp.set(t.origen, (trasp.get(t.origen) || 0) + t.personas);
  const out: FlujoMedido[] = [];
  for (const f of flows) {
    const fid = f.id;
    const entradas = personas(fid, "entró");
    const nodosF = datos.nodos.filter((x) => x.flow_id === fid);
    const fallosF = datos.fallos.filter((x) => x.flow_id === fid);
    if (!entradas && !nodosF.length && !fallosF.length && !ev.get(fid)) continue;
    const porNodo = new Map<string, PasoMedido>();
    const paso = (nid: string): PasoMedido => {
      let p = porNodo.get(nid);
      if (!p) { const nm = nombrePaso((f.nodes || {})[nid], nid); p = { txt: nm.txt, tipo: nm.tipo, espera: 0, terminaron: 0, abandonan: 0, error: 0, siguieron: 0 }; porNodo.set(nid, p); }
      return p;
    };
    for (const x of nodosF) {
      const p = paso(x.node_id);
      if (x.status === "waiting" || x.status === "active") p.espera += x.n;
      else if (x.status === "done") p.terminaron += x.n;
      else if (x.status === "cancelled") p.abandonan += x.n;
    }
    for (const x of fallosF) { const p = paso(x.node_id); p.error += x.personas; p.siguieron += x.siguieron; }
    const pasos = [...porNodo.values()].filter((p) => p.espera + p.terminaron + p.abandonan + p.error > 0)
      .sort((a, b) => (b.abandonan + b.error + b.espera) - (a.abandonan + a.error + a.espera)).slice(0, 12);
    const rep = datos.repetidos.find((x) => x.flow_id === fid);
    const et = datos.etiquetas.find((x) => x.flow_id === fid);
    out.push({
      id: fid, name: String(f.name || fid), objetivo: objetivoDeFlujo(f),
      entradas, fin: personas(fid, "completó"), respondieron: personas(fid, "respondió"),
      compraron: personas(fid, "salió · compró"), derivadas: derivadasDe(fid),
      // MET-AUTO-05-FIN · el evento «traspasó» del origen manda; el nombre solo cubre el histórico anterior.
      traspasados: personas(fid, "traspasó") || trasp.get(String(f.name || f.id).slice(0, 60)) || 0,
      embudo: (({ flow_id: _f, ...resto }) => resto)(datos.embudo.find((x) => x.flow_id === fid)
        || { flow_id: fid, clicaron: 0, visitaron: 0, reservaron: 0, canceladas: 0, celebradas: 0, asistieron: 0, vieronOferta: 0, compraron: 0 }),
      enCurso: nodosF.reduce((a, x) => a + (x.status === "waiting" || x.status === "active" ? x.n : 0), 0),
      pasos,
      seguimiento: {
        aviso1: personas(fid, "reenganche 1"), aviso2: personas(fid, "reenganche 2"), aviso3: personas(fid, "reenganche 3"),
        pospuestos: personas(fid, "reenganche pospuesto"), aplazados: personas(fid, "reenganche aplazado", "reanudación aplazada"),
        repetidos: rep ? rep.n : 0, derivados: personas(fid, "derivado · inactividad", "derivado · escribió en espera"), sinAviso: personas(fid, "derivado · SIN aviso"),
        // MET-AUTO-07-FIN · reservar después de un aviso es secuencia observada, no causa probada.
        reservaronTras: personas(fid, "reservó tras aviso"), cancReserva: personas(fid, "seguimiento cancelado · reservó"),
      },
      resultado: et
        ? { suscritas: et.suscritas, conResultado: et.conResultado, suscSinResultado: et.suscSinResultado, aMedias: et.aMedias }
        : { suscritas: 0, conResultado: 0, suscSinResultado: 0, aMedias: 0 },
    });
  }
  out.sort((a, b) => b.entradas - a.entradas);
  let difusiones: DifusionFila[] = [];
  if (conDifusiones) {
    try { difusiones = (await dbDifusionesRanking(w.sinceMs, w.untilMs)).slice(0, 40); } catch { difusiones = []; }
  }
  // MET-AUTO-10-FIN · el asunto sale del catálogo de correos ya cacheado; sin él, la fecha no se sabe y se dice «envío sin asunto».
  let correos: MedicionAutomatizacionB["correos"] = null;
  try {
    const filas = await dbCorreosQueLlevan(w.sinceMs, w.untilMs);
    if (filas) {
      const cats = new Map<string, Awaited<ReturnType<typeof getEmailCatalog>>>();
      correos = [];
      for (const x of filas) {
        if (!cats.has(x.cuenta)) { try { cats.set(x.cuenta, await getEmailCatalog(x.cuenta)); } catch { cats.set(x.cuenta, null); } }
        const it = cats.get(x.cuenta)?.items.find((e) => e.mailingId != null && String(e.mailingId) === x.correo);
        correos.push({ asunto: (it?.subject || it?.originName || "Envío sin asunto conocido").slice(0, 120), abrieron: x.abrieron, clicaron: x.clicaron, volvieron: x.volvieron, sinVincular: x.sinVincular });
      }
    }
  } catch { correos = null; }
  return { flujos: out.slice(0, 40), difusiones, correos };
}
