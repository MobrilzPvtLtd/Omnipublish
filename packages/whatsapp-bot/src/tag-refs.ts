/**
 * ETQ-04 · ETIQUETA-EN-FLUJOS-1 · Qué flujos NOMBRAN una etiqueta en su configuración.
 *
 * La vista Etiquetas solo puede decir «Usada en flujos» si hay una referencia que se pueda
 * comprobar: un campo del flujo que escribe o lee esa etiqueta. Nunca se deduce de los
 * contactos etiquetados (que un contacto la tenga no dice qué flujo se la puso).
 *
 * Funciones PURAS: reciben los flujos ya leídos (listFlows) y no tocan la base. Las usa
 * GET /admin/api/tags (campo `flows` de cada etiqueta) y las reutiliza ETQ-05 al renombrar
 * y borrar (src/etiquetas-uso.ts).
 *
 * Cada campo se compara COMO LO COMPARA EL MOTOR (flows.ts), y eso decide `efectiva`:
 *  · exacta      → lo que el flujo ESCRIBE en el contacto (enrichContact recorta y guarda
 *                  tal cual): addTag, bookingTag, syncTag, btnDoubtTag, fuCarlaTag.
 *  · minusculas  → trim + minúsculas: condición hasTag, emTag (normTag), openTag,
 *                  {{tag.X}} en los textos (templating.ts) y stopTag: el guard que DETIENE el
 *                  flujo (flows.ts, antes de cada paso y al reanudar) y el webhook de ventas
 *                  comparan así. La derivación lo compara normalizado, pero ahí solo impide
 *                  pasar al equipo, no detiene: con «normalizada», «Inscrito-LM» salía como
 *                  «Detiene el flujo» de un stopTag «inscrito lm» que no lo detiene.
 *  · normalizada → sin acentos y con -/_/espacios fundidos: rdRequireTags (la derivación
 *                  los compara así).
 * Se DEVUELVEN también las coincidencias por trim + minúsculas que el motor no daría por
 * buenas (`efectiva:false`, p. ej. un addTag que solo difiere en mayúsculas): a quien
 * renombra le interesa verlas; a la vista Etiquetas, no.
 */
import type { Flow } from "./flows.js";

export type TagRefComparacion = "exacta" | "minusculas" | "normalizada";
export type TagRefUso = "comprueba" | "pone" | "detiene" | "exige" | "arranca" | "correo" | "mensaje";

export interface TagFlowRef {
  flowId: string;
  flowName: string;
  enabled: boolean;
  /** Ruta del dato dentro del flujo: "value", "addTag", "rdRequireTags", "trigger.emTag",
   *  o el nombre del texto que lleva {{tag.X}} ("text", "fuMsg"…). */
  campo: string;
  /** Solo en los campos de un paso; los de flujo entero no lo llevan. */
  nodeId?: string;
  /** Qué hace el flujo con ella, como código estable (el panel lo traduce). */
  uso: TagRefUso;
  /** Lo mismo en una frase en español, para mensajes del servidor. */
  rol: string;
  /** El texto tal cual está en el flujo (en rdRequireTags, el trozo de esa etiqueta). */
  valor: string;
  /** Lee o escribe la etiqueta del CONTACTO en el panel. */
  local: boolean;
  /** Toca también la etiqueta en la web (systeme.io). */
  web: boolean;
  comparacion: TagRefComparacion;
  /** valor.trim() === nombre.trim() */
  exacta: boolean;
  /** El motor la da por la misma etiqueta con su propia comparación. */
  efectiva: boolean;
}

type RefCruda = Omit<TagFlowRef, "exacta" | "efectiva">;

const minus = (s: unknown) => String(s ?? "").trim().toLowerCase();
const normal = (s: unknown) =>
  String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[-_\s]+/g, " ").trim();
// La misma sintaxis que RE_VAR de templating.ts, solo para las claves tag.X.
const RE_TAG_VAR = /\{\{\s*tag\.([a-zA-Z0-9_.-]+)\s*(?:\|[^}]*)?\}\}/gi;

function textosConEtiqueta(texto: string): string[] {
  const out: string[] = [];
  if (!texto || texto.indexOf("{{") < 0) return out;
  for (const m of texto.matchAll(RE_TAG_VAR)) if (m[1]) out.push(m[1]);
  return out;
}

/** Todas las referencias a etiquetas que tiene un flujo, sin filtrar por nombre. */
export function referenciasDeFlujo(f: Flow): RefCruda[] {
  const out: RefCruda[] = [];
  const base = { flowId: String(f.id || ""), flowName: String(f.name || ""), enabled: !!f.enabled };
  const add = (r: Omit<RefCruda, "flowId" | "flowName" | "enabled">) => {
    if (String(r.valor || "").trim()) out.push({ ...base, ...r, valor: String(r.valor) });
  };
  const nodes = (f.nodes || {}) as Record<string, Record<string, unknown>>;
  for (const [nodeId, n] of Object.entries(nodes)) {
    if (!n || typeof n !== "object") continue;
    if (n.type === "condition" && n.source === "hasTag")
      add({ campo: "value", nodeId, uso: "comprueba", rol: "la comprueba en una condición", valor: String(n.value ?? ""), local: true, web: false, comparacion: "minusculas" });
    if (n.type === "condition" && n.source === "emailOpened") {
      const campo = String(n.openTag ?? "").trim() ? "openTag" : "value";
      add({ campo, nodeId, uso: "correo", rol: "la mira en tu web para saber si abrió el correo", valor: String(n[campo] ?? ""), local: false, web: true, comparacion: "minusculas" });
    }
    if (n.type === "action") {
      add({ campo: "addTag", nodeId, uso: "pone", rol: "la pone", valor: String(n.addTag ?? ""), local: true, web: false, comparacion: "exacta" });
      if (n.kind === "sync" || n.syncTarget)
        add({ campo: "syncTag", nodeId, uso: "pone", rol: "la pone al enviar el contacto a tu web", valor: String(n.syncTag ?? ""), local: true, web: true, comparacion: "exacta" });
      if (n.kind === "book")
        add({ campo: "bookingTag", nodeId, uso: "pone", rol: "la pone al pedir cita", valor: String(n.bookingTag ?? ""), local: true, web: false, comparacion: "exacta" });
    }
    for (const [k, v] of Object.entries(n)) {
      const textos = typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      for (const t of textos)
        for (const nom of textosConEtiqueta(t))
          add({ campo: k, nodeId, uso: "mensaje", rol: "la usa en un mensaje", valor: nom, local: true, web: false, comparacion: "minusculas" });
    }
  }
  const fl = f as Flow & Record<string, unknown>;
  add({ campo: "stopTag", uso: "detiene", rol: "detiene el flujo a quien la tiene", valor: String(fl.stopTag ?? ""), local: true, web: true, comparacion: "minusculas" });
  if (fl.rdEnabled)
    for (const pieza of String(fl.rdRequireTags ?? "").split(","))
      add({ campo: "rdRequireTags", uso: "exige", rol: "la exige para pasar el contacto a tu equipo", valor: pieza.trim(), local: true, web: false, comparacion: "normalizada" });
  add({ campo: "btnDoubtTag", uso: "pone", rol: "la pone a quien escribe una duda en vez de pulsar", valor: String(fl.btnDoubtTag ?? ""), local: true, web: false, comparacion: "exacta" });
  // El motor usa «derivado-inactividad» cuando el campo está vacío (flows.ts, derivación por
  // inactividad), y solo deriva si el seguimiento está activo y no está en modo «mensaje».
  if (fl.fuEnabled && (fl.fuMode || "derivar") !== "mensaje")
    add({ campo: "fuCarlaTag", uso: "pone", rol: "la pone al pasar a tu equipo a quien no contesta", valor: String(fl.fuCarlaTag || "derivado-inactividad").trim(), local: true, web: false, comparacion: "exacta" });
  if (f.trigger?.type === "email")
    add({ campo: "trigger.emTag", uso: "arranca", rol: "arranca cuando tu web la pone", valor: String(f.trigger.emTag ?? ""), local: false, web: true, comparacion: "minusculas" });
  for (const [k, v] of Object.entries(fl)) {
    if (typeof v !== "string" || k === "id" || k === "name") continue;
    for (const nom of textosConEtiqueta(v))
      add({ campo: k, uso: "mensaje", rol: "la usa en un mensaje", valor: nom, local: true, web: false, comparacion: "minusculas" });
  }
  return out;
}

function casa(r: RefCruda, nombre: string): TagFlowRef | null {
  const exacta = r.valor.trim() === nombre.trim();
  const porMinus = minus(r.valor) === minus(nombre);
  const porNormal = normal(r.valor) === normal(nombre);
  if (!porMinus && !(r.comparacion === "normalizada" && porNormal)) return null;
  const efectiva = r.comparacion === "exacta" ? exacta : r.comparacion === "minusculas" ? porMinus : porNormal;
  return { ...r, exacta, efectiva };
}

/** Índice para consultar muchas etiquetas contra los mismos flujos (la vista entera)
 *  recorriendo los flujos una sola vez. */
export function tagFlowIndex(flows: Flow[]): (nombre: string) => TagFlowRef[] {
  const porMinus = new Map<string, RefCruda[]>();
  const porNormal = new Map<string, RefCruda[]>();
  for (const f of flows || []) {
    if (!f || typeof f !== "object") continue;
    for (const r of referenciasDeFlujo(f)) {
      const km = minus(r.valor);
      if (!porMinus.has(km)) porMinus.set(km, []);
      porMinus.get(km)!.push(r);
      if (r.comparacion === "normalizada") {
        const kn = normal(r.valor);
        if (!porNormal.has(kn)) porNormal.set(kn, []);
        porNormal.get(kn)!.push(r);
      }
    }
  }
  return (nombre: string) => {
    const vistos = new Set<RefCruda>();
    const out: TagFlowRef[] = [];
    for (const r of [...(porMinus.get(minus(nombre)) || []), ...(porNormal.get(normal(nombre)) || [])]) {
      if (vistos.has(r)) continue;
      vistos.add(r);
      const m = casa(r, nombre);
      if (m) out.push(m);
    }
    return out;
  };
}

/** Referencias de UNA etiqueta en los flujos dados. */
export function tagFlowRefs(flows: Flow[], nombre: string): TagFlowRef[] {
  return tagFlowIndex(flows)(nombre);
}

/** Resumen para la vista Etiquetas: un elemento por flujo, solo con referencias que el
 *  motor da por buenas (las de la web también: el flujo nombra esa etiqueta, y el rol
 *  dice que es la de la web). */
export function flujosQueLaUsan(refs: TagFlowRef[]): { id: string; name: string; enabled: boolean; usos: TagRefUso[] }[] {
  const porFlujo = new Map<string, { id: string; name: string; enabled: boolean; usos: TagRefUso[] }>();
  for (const r of refs) {
    if (!r.efectiva || !r.flowId) continue;
    let e = porFlujo.get(r.flowId);
    if (!e) { e = { id: r.flowId, name: r.flowName, enabled: r.enabled, usos: [] }; porFlujo.set(r.flowId, e); }
    if (!e.usos.includes(r.uso)) e.usos.push(r.uso);
  }
  return [...porFlujo.values()].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}
