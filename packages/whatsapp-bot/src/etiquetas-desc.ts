/**
 * ETQ-06 · DESC-ETIQUETA-1 · Para qué sirve cada etiqueta: una nota interna y opcional.
 *
 * Se guarda en el ajuste por workspace «tags.desc» (un objeto JSON nombre → texto), al lado
 * del catálogo («tags.catalog»). NO va en los contactos ni en ninguna tabla: escribirla no
 * toca fichas, no dispara flujos y no mueve ninguna cifra. Los contactos no la ven nunca;
 * solo el equipo, en la vista Etiquetas.
 *
 * Está en SECRET_KEYS igual que el catálogo: se cifra en reposo y, sobre todo, NO se hereda
 * del workspace 'default' (un negocio nuevo no arranca con las notas de otro).
 *
 * La lectura es tolerante: un valor que no sea un objeto de textos se ignora (entero o por
 * entradas) y jamás tumba la vista. Se trabaja con Map, así un nombre como «__proto__» es
 * una etiqueta más y no la cadena de prototipos.
 *
 * Ciclo de vida, desde POST /admin/api/tags:
 *  · add    → con `desc` no vacía la guarda; sin ella NO borra la que hubiera (el «+» de
 *             «Añadir a tu catálogo» también es un add, y no debe llevarse la nota por delante).
 *  · desc   → la cambia (vacía = la quita). Nada más.
 *  · rename → viaja con la etiqueta. Renombrar nunca funde con otra que exista (ETQ-05), así
 *             que si el nombre nuevo tenía una nota, era de una etiqueta que ya no existe.
 *  · delete → se va con ella.
 * Quitar una etiqueta del último contacto conserva su nota: puede seguir en el catálogo
 * o volver a utilizarse. Solo eliminarla explícitamente desde Etiquetas borra la nota.
 */
import { get as getSetting, set as setSetting } from "./settings.js";
import { currentWorkspaceId } from "./workspace.js";

const CLAVE = "tags.desc";
const escrituras = new Map<string, Promise<unknown>>();
/** Serializa leer-modificar-escribir dentro del proceso, aislado por negocio. */
function enCola<T>(fn: () => Promise<T>): Promise<T> {
  const ws = currentWorkspaceId();
  const anterior = escrituras.get(ws) || Promise.resolve();
  const tarea = anterior.catch(() => undefined).then(fn);
  escrituras.set(ws, tarea);
  const limpia = () => { if (escrituras.get(ws) === tarea) escrituras.delete(ws); };
  void tarea.then(limpia, limpia);
  return tarea;
}

/** Corta a propósito: es una nota que se lee en la fila, en dos líneas como mucho. */
export const MAX_DESC = 160;

/**
 * Texto limpio: sin caracteres de control, espacios colapsados (\s ya incluye los separadores
 * de línea y de párrafo de Unicode), recortado y a MAX_DESC caracteres.
 */
export function limpiaDescEtiqueta(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.slice(0, MAX_DESC * 8).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  const letras = Array.from(s);
  return letras.length > MAX_DESC ? letras.slice(0, MAX_DESC).join("").trim() : s;
}

/** Todas las descripciones del workspace activo (nombre exacto de la etiqueta → texto). */
export function descripcionesEtiquetas(): Map<string, string> {
  const m = new Map<string, string>();
  let o: unknown;
  try {
    o = JSON.parse(getSetting(CLAVE) || "{}");
  } catch {
    return m;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return m;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const nombre = String(k).trim();
    const d = limpiaDescEtiqueta(v);
    if (nombre && d) m.set(nombre, d);
  }
  return m;
}

async function guarda(m: Map<string, string>): Promise<void> {
  // Object.fromEntries define propiedades propias: «__proto__» se guarda como un nombre más.
  await setSetting(CLAVE, JSON.stringify(Object.fromEntries(m)));
}

/** Pone la descripción de una etiqueta, o la quita si queda vacía. Devuelve el texto guardado. */
export async function ponDescEtiqueta(nombre: string, desc: unknown): Promise<string> {
  return enCola(async () => {
  const n = String(nombre || "").trim();
  if (!n) return "";
  const d = limpiaDescEtiqueta(desc);
  const m = descripcionesEtiquetas();
  if ((m.get(n) || "") === d) return d;
  if (d) m.set(n, d);
  else m.delete(n);
  await guarda(m);
  return d;
  });
}

/** Al renombrar, la nota viaja con la etiqueta (y el nombre nuevo no hereda una nota huérfana). */
export async function renombraDescEtiqueta(desde: string, hacia: string): Promise<void> {
  return enCola(async () => {
  const a = String(desde || "").trim();
  const b = String(hacia || "").trim();
  if (!a || !b || a === b) return;
  const m = descripcionesEtiquetas();
  const d = m.get(a);
  if (!d && !m.has(b)) return;
  m.delete(a);
  if (d) m.set(b, d);
  else m.delete(b);
  await guarda(m);
  });
}

/** Al borrar una etiqueta, su nota se va con ella. */
export async function quitaDescEtiqueta(nombre: string): Promise<void> {
  return enCola(async () => {
  const n = String(nombre || "").trim();
  const m = descripcionesEtiquetas();
  if (!n || !m.has(n)) return;
  m.delete(n);
  await guarda(m);
  });
}
