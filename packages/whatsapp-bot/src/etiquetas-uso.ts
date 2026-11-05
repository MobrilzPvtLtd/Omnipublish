/**
 * ETQ-05 · ETIQUETA-USO-1 · Renombrar y eliminar etiquetas sin romper contactos ni flujos.
 *
 * Una etiqueta vive en dos sitios distintos, y el Léeme de Etiquetas insiste en no
 * confundirlos:
 *  · en los CONTACTOS que la tienen (app_contacts.tags), y
 *  · en la CONFIGURACIÓN que la nombra por su texto: flujos, difusiones programadas,
 *    difusiones por pasos, formularios, disparadores antiguos de WhatsApp y productos.
 * Cero contactos NO significa «sin uso»: un flujo puede comprobarla o ponerla mañana.
 *
 * Aquí se calcula ese segundo alcance (qué la nombra y para qué) y se reescribe al
 * renombrar. Los flujos se leen con tag-refs.ts (ETQ-04), que compara cada campo COMO LO
 * COMPARA EL MOTOR; el resto de sitios comparan el texto exacto (recortado), igual que
 * el código que los ejecuta.
 *
 * Lo que NO se reescribe solo, y se devuelve como «pendiente» con su motivo:
 *  · lo que también es el nombre de la etiqueta en la web (systeme.io): syncTag, stopTag,
 *    el arranque por correo y «¿abrió el correo?». Cambiarlo aquí no la renombra allí, y
 *    cambiarlo a ciegas rompería las automatizaciones de la web;
 *  · {{tag.X}} dentro de un mensaje (es texto del dueño);
 *  · una pieza de «exige estas etiquetas» si el nombre nuevo lleva coma (ahí se separan
 *    con comas: se partiría en dos).
 *
 * Todo corre dentro del workspace activo: cada lectura y cada escritura de db.ts va
 * acotada por currentWorkspaceId().
 */
import { listFlows, type Flow } from "./flows.js";
import { tagFlowRefs, type TagFlowRef } from "./tag-refs.js";
import {
  dbReescribirFlujo,
  dbListBroadcasts,
  dbSetSegmentoDifusionProgramada,
  dbListBroadcastFlows,
  dbUpsertBroadcastFlow,
  dbListForms,
  dbUpsertForm,
  dbListAutomations,
  dbUpsertAutomation,
  ETIQUETA_NO_MOLESTAR,
} from "./db.js";
import { currentWorkspaceId } from "./workspace.js";
import { get as getSetting, set as setSetting } from "./settings.js";

export type TipoUso = "flujo" | "difusion" | "difusion-pasos" | "formulario" | "disparador" | "producto";

/** Un elemento de configuración que nombra la etiqueta. */
export interface UsoEtiqueta {
  tipo: TipoUso;
  id: string;
  nombre: string;
  /** Encendido / programado / activo. Uno pausado también cuenta: al encenderlo volvería
   *  a usar la etiqueta. */
  activo: boolean;
  /** Qué hace con ella, en frases cortas para el dueño. */
  roles: string[];
  /** Solo al renombrar: lo que NO se cambiará solo, cada uno con su motivo. */
  pendientes: string[];
}

export interface EtiquetaSistema {
  /** Por qué es especial, en una frase sin jerga. */
  motivo: string;
  /** true = el panel la LEE para decidir algo (bajas, compras, métricas): ni se borra ni
   *  se renombra, ni se puede renombrar otra HACIA ese nombre.
   *  false = el panel solo la PONE (a quien entra por un formulario…): se puede eliminar
   *  avisando de que volverá a aparecer, pero no renombrar (la gente nueva seguiría
   *  llegando con el nombre de siempre y el grupo quedaría partido en dos). */
  bloquea: boolean;
}

const minus = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** ¿La usa el propio panel por su nombre? null = es una etiqueta normal del dueño. */
export function etiquetaDeSistema(nombre: string): EtiquetaSistema | null {
  const n = minus(nombre);
  if (!n) return null;
  const compra = minus(getSetting("systemeio.stopTag"));
  if (compra && n === compra)
    return { bloquea: true, motivo: "Es la etiqueta que marca a quien ha comprado en tu web. Sin ella, los flujos de venta volverían a escribir a quien ya compró." };
  if (n === ETIQUETA_NO_MOLESTAR)
    return { bloquea: true, motivo: "Marca a quien pidió no recibir más mensajes. Sin ella, esa gente volvería a entrar en tus difusiones." };
  if (n.startsWith("compra-"))
    return { bloquea: true, motivo: "Marca a quien ya ha comprado: el panel la usa para contar ventas y para no volver a venderle." };
  if (n === "sio-registrado")
    return { bloquea: true, motivo: "La pone tu web a quien se registra, y el panel la usa para contar los registros." };
  if (n === "clico-registro" || n === "clico-webinar")
    return { bloquea: true, motivo: "La pone el panel a quien pulsa un enlace de registro, y la usa para medir esos clics." };
  if (n === "escribió")
    return { bloquea: true, motivo: "La pone el panel a quien escribe dentro de un flujo, y Resultados la usa para contar ese paso." };
  if (n === "clico-pago")
    return { bloquea: false, motivo: "La pone el panel solo a quien pulsa un enlace de pago: si la borras, volverá a aparecer con el siguiente clic." };
  if (n === "lead" || n === "formulario" || n.startsWith("form:"))
    return { bloquea: false, motivo: "La pone el panel solo a quien entra por un formulario: si la borras, volverá a aparecer con el siguiente." };
  if (n === "lead-ads" || n.startsWith("lead-ads:"))
    return { bloquea: false, motivo: "La pone el panel solo a quien llega por un formulario de anuncios: si la borras, volverá a aparecer con el siguiente." };
  return null;
}

/** Comprueba un renombrado ANTES de tocar nada. Devuelve el motivo para no hacerlo, o
 *  null si se puede. `existentes` = catálogo ∪ etiquetas que tienen los contactos. */
export function motivoParaNoRenombrar(desde: string, hacia: string, existentes: Iterable<string>): string | null {
  const sisDesde = etiquetaDeSistema(desde);
  if (sisDesde && sisDesde.bloquea) return "«" + desde + "» no se puede renombrar. " + sisDesde.motivo;
  if (sisDesde) return "«" + desde + "» no se puede renombrar: la pone el propio panel con ese nombre, y la gente nueva seguiría llegando como «" + desde + "».";
  const sisHacia = etiquetaDeSistema(hacia);
  if (sisHacia && sisHacia.bloquea) return "«" + hacia + "» es una etiqueta que usa el propio panel. " + sisHacia.motivo + " Elige otro nombre.";
  for (const e of existentes) {
    if (e === desde) continue;
    if (minus(e) === minus(hacia))
      return "Ya existe la etiqueta «" + e + "». Al renombrar se juntarían las dos y no se podrían volver a separar. Elige otro nombre.";
  }
  return null;
}

// ---------------------------------------------------------------- flujos

/** Campos de un flujo que el renombrado reescribe solo: los que leen o ponen la etiqueta
 *  del CONTACTO y nada más. Lo de la web y los mensajes quedan como pendientes. */
function reescribible(r: TagFlowRef): boolean {
  if (!r.local || r.web) return false;
  return r.uso === "comprueba" || r.uso === "pone" || r.uso === "exige";
}

/** Clave de una referencia, para saber si sigue ahí después de reescribir. */
const claveRef = (r: TagFlowRef) => r.flowId + "|" + (r.nodeId || "") + "|" + r.campo + "|" + r.valor;

/** Cambia en `f` (ya clonado) las referencias reescribibles a `desde` por `hacia`. */
function reescribirFlujo(f: Flow, refs: TagFlowRef[], hacia: string): boolean {
  const fl = f as Flow & Record<string, unknown>;
  const nodos = (fl.nodes || {}) as unknown as Record<string, Record<string, unknown>>;
  let cambio = false;
  for (const r of refs) {
    if (!r.efectiva || !reescribible(r)) continue;
    if (r.nodeId) {
      const n = nodos[r.nodeId];
      if (n && String(n[r.campo] ?? "").trim() === r.valor.trim()) { n[r.campo] = hacia; cambio = true; }
      continue;
    }
    if (r.campo === "rdRequireTags") {
      if (hacia.includes(",")) continue; // se partiría en dos etiquetas: queda pendiente
      const piezas = String(fl.rdRequireTags ?? "").split(",");
      const nuevas = piezas.map((p) => (p.trim() === r.valor.trim() ? hacia : p.trim()));
      if (nuevas.join(", ") !== piezas.map((p) => p.trim()).join(", ")) { fl.rdRequireTags = nuevas.filter(Boolean).join(", "); cambio = true; }
      continue;
    }
    if (r.campo === "btnDoubtTag" || r.campo === "fuCarlaTag") {
      // fuCarlaTag vacío = «derivado-inactividad» por defecto (tag-refs.ts): se escribe
      // explícito para que el renombrado se note.
      fl[r.campo] = hacia;
      cambio = true;
    }
  }
  return cambio;
}

function motivoPendiente(r: TagFlowRef, hacia: string): string {
  if (r.uso === "mensaje") return r.rol + " ({{tag." + r.valor + "}}): cámbialo a mano en el texto";
  if (r.web) return r.rol + ": es también el nombre de la etiqueta en tu web, que no se renombra desde aquí. Revísalo a mano";
  if (r.campo === "rdRequireTags" && hacia.includes(",")) return r.rol + ": ahí las etiquetas se separan con comas y el nombre nuevo lleva una. Cámbialo a mano";
  return r.rol + ": cámbialo a mano";
}

interface Cambio { uso: UsoEtiqueta; guardar: () => Promise<boolean> }

/** Flujos que nombran la etiqueta. Con `hacia`, prepara además su reescritura. */
async function analizarFlujos(desde: string, hacia: string | null, cambios: Cambio[]): Promise<UsoEtiqueta[]> {
  const flujos = await listFlows();
  const refs = tagFlowRefs(flujos, desde).filter((r) => r.efectiva);
  const porFlujo = new Map<string, TagFlowRef[]>();
  for (const r of refs) {
    // Para ELIMINAR solo cuenta lo que lee o pone la etiqueta del contacto: lo que solo
    // mira la web no depende de ella. Al RENOMBRAR se enseña todo, para avisar.
    if (!hacia && !r.local) continue;
    if (!porFlujo.has(r.flowId)) porFlujo.set(r.flowId, []);
    porFlujo.get(r.flowId)!.push(r);
  }
  const out: UsoEtiqueta[] = [];
  for (const f of flujos) {
    const suyas = porFlujo.get(String(f.id));
    if (!suyas || !suyas.length) continue;
    const uso: UsoEtiqueta = {
      tipo: "flujo", id: String(f.id), nombre: String(f.name || "Flujo sin nombre"), activo: !!f.enabled,
      roles: [...new Set(suyas.map((r) => r.rol))], pendientes: [],
    };
    out.push(uso);
    if (hacia === null) continue;
    const copia = structuredClone(f) as Flow;
    const cambia = reescribirFlujo(copia, suyas, hacia);
    // Lo que sigue apuntando a la etiqueta vieja DESPUÉS de reescribir, y no apunta ya
    // a la nueva, es lo que el dueño tiene que mirar.
    const aNueva = new Set(tagFlowRefs([copia], hacia).filter((r) => r.efectiva).map(claveRef));
    for (const r of tagFlowRefs([copia], desde)) {
      if (!r.efectiva || aNueva.has(claveRef(r))) continue;
      const m = motivoPendiente(r, hacia);
      if (!uso.pendientes.includes(m)) uso.pendientes.push(m);
    }
    if (cambia) cambios.push({ uso, guardar: () => dbReescribirFlujo(String(f.id), copia as unknown as Record<string, unknown>) });
  }
  return out;
}

// ---------------------------------------------------------------- el resto

const igual = (a: unknown, b: string) => typeof a === "string" && a.trim() === b.trim();
const cambiaLista = (l: unknown, desde: string, hacia: string): string[] | null => {
  if (!Array.isArray(l) || !l.some((t) => igual(t, desde))) return null;
  return [...new Set(l.map((t) => (igual(t, desde) ? hacia : String(t))))];
};

async function analizarResto(desde: string, hacia: string | null, cambios: Cambio[]): Promise<UsoEtiqueta[]> {
  const out: UsoEtiqueta[] = [];
  const anota = (u: Omit<UsoEtiqueta, "pendientes">, guardar: (() => Promise<boolean>) | null) => {
    const uso: UsoEtiqueta = { ...u, pendientes: [] };
    out.push(uso);
    if (hacia !== null && guardar) cambios.push({ uso, guardar });
  };
  const h = hacia ?? "";

  // Difusiones PROGRAMADAS: su segmento se resuelve al salir.
  for (const b of await dbListBroadcasts(500)) {
    if (b.status !== "scheduled") continue;
    const seg = (b.segment || {}) as Record<string, unknown>;
    const roles: string[] = [];
    if (Array.isArray(seg.tags) && seg.tags.some((t) => igual(t, desde))) roles.push("elige a quién se envía");
    if (Array.isArray(seg.excludeTags) && seg.excludeTags.some((t) => igual(t, desde))) roles.push("deja fuera a quien la tiene");
    if (!roles.length) continue;
    const cuando = b.scheduled_at ? new Date(b.scheduled_at).toLocaleString("es-ES", { timeZone: "Europe/Madrid", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    const texto = String(b.text || "").replace(/\s+/g, " ").trim();
    anota(
      { tipo: "difusion", id: b.id, nombre: (cuando ? cuando + " · " : "") + (texto.length > 48 ? texto.slice(0, 47) + "…" : texto || "Difusión programada"), activo: true, roles },
      () => {
        const nuevo = { ...seg };
        const t = cambiaLista(seg.tags, desde, h); if (t) nuevo.tags = t;
        const x = cambiaLista(seg.excludeTags, desde, h); if (x) nuevo.excludeTags = x;
        return dbSetSegmentoDifusionProgramada(b.id, nuevo);
      },
    );
  }

  // Difusiones por pasos: la audiencia guardada se usa en cada nueva ejecución.
  for (const bf of await dbListBroadcastFlows({ tenantId: currentWorkspaceId(), limit: 500 })) {
    const nodos = Array.isArray(bf.data?.nodes) ? bf.data.nodes : [];
    const usa = nodos.some((n) => n.type === "audience" && (n.audience?.mode === "tags" || n.audience?.mode === "segment" || !n.audience?.mode) && (n.audience?.tags || []).some((t) => igual(t, desde)));
    if (!usa) continue;
    anota(
      { tipo: "difusion-pasos", id: bf.id, nombre: bf.name || "Difusión sin nombre", activo: !!bf.enabled, roles: ["elige a quién se envía"] },
      async () => {
        const data = structuredClone(bf.data);
        for (const n of data.nodes) if (n.type === "audience" && n.audience) { const t = cambiaLista(n.audience.tags, desde, h); if (t) n.audience.tags = t; }
        await dbUpsertBroadcastFlow({ id: bf.id, tenant_id: bf.tenant_id, name: bf.name, data, enabled: bf.enabled });
        return true;
      },
    );
  }

  // Formularios: la ponen a quien responde (lista nueva `tags` y la única de antes `tag`).
  for (const f of await dbListForms()) {
    const o = (f.opts || {}) as Record<string, unknown>;
    if (!(Array.isArray(o.tags) && o.tags.some((t) => igual(t, desde))) && !igual(o.tag, desde)) continue;
    anota(
      { tipo: "formulario", id: f.id, nombre: f.title || f.slug || "Formulario", activo: f.status === "active", roles: ["la pone a quien responde"] },
      async () => {
        const opts = { ...f.opts };
        const t = cambiaLista(o.tags, desde, h); if (t) opts.tags = t;
        if (igual(o.tag, desde)) opts.tag = h;
        await dbUpsertForm({ ...f, opts });
        return true;
      },
    );
  }

  // Disparadores antiguos de WhatsApp (vista retirada; se convierten en flujos). Al
  // renombrar se reescriben TODOS, también los pausados: «deshacer la conversión» los
  // vuelve a encender y traerían el nombre viejo.
  for (const a of await dbListAutomations()) {
    if (a.platform !== "whatsapp" || !igual(a.tag, desde)) continue;
    const id = String(a.id || "");
    if (!id) continue;
    const guardar = async () => { await dbUpsertAutomation(id, { ...a, tag: h }); return true; };
    if (a.enabled) anota({ tipo: "disparador", id, nombre: String(a.name || a.keyword || "Respuesta automática de WhatsApp"), activo: true, roles: ["la pone cuando alguien escribe su palabra clave"] }, guardar);
    else if (hacia !== null) cambios.push({ uso: { tipo: "disparador", id, nombre: String(a.name || "Respuesta automática de WhatsApp"), activo: false, roles: [], pendientes: [] }, guardar });
  }

  // Productos: la etiqueta de compra propia de cada uno. Se reescribe el JSON guardado
  // tal cual (purchaseLinks() normaliza y añadiría campos que el dueño no puso).
  let crudo: unknown = null;
  try { crudo = JSON.parse(getSetting("purchase.links") || "null"); } catch { crudo = null; }
  if (Array.isArray(crudo)) {
    const lista = crudo as Record<string, unknown>[];
    const suyos = lista.filter((p) => p && igual(p.tag, desde));
    suyos.forEach((p, i) => {
      // Una sola escritura para todos los productos: la hace el primero.
      anota(
        { tipo: "producto", id: String(p.id || p.label || ""), nombre: String(p.label || "Producto"), activo: p.active !== false, roles: ["la pone a quien lo compra"] },
        i === 0 ? async () => { await setSetting("purchase.links", JSON.stringify(lista.map((x) => (x && igual(x.tag, desde) ? { ...x, tag: h } : x)))); return true; } : async () => true,
      );
    });
  }
  return out;
}

// ---------------------------------------------------------------- API del módulo

const NOMBRE_TIPO: Record<TipoUso, [string, string]> = {
  flujo: ["flujo", "flujos"],
  difusion: ["difusión programada", "difusiones programadas"],
  // Con los nombres que les da el panel: la pestaña «Con seguimiento» de Difusión y el aviso
  // «respuestas automáticas antiguas» de Flujos.
  "difusion-pasos": ["difusión con seguimiento", "difusiones con seguimiento"],
  formulario: ["formulario", "formularios"],
  disparador: ["respuesta automática antigua", "respuestas automáticas antiguas"],
  producto: ["producto", "productos"],
};
/** «2 flujos y 1 formulario» — para los mensajes del servidor (y del Asistente). */
export function resumenUsos(usos: UsoEtiqueta[]): string {
  const n = new Map<TipoUso, number>();
  for (const u of usos) n.set(u.tipo, (n.get(u.tipo) || 0) + 1);
  const partes = [...n.entries()].map(([t, k]) => k + " " + NOMBRE_TIPO[t][k === 1 ? 0 : 1]);
  return partes.length > 1 ? partes.slice(0, -1).join(", ") + " y " + partes[partes.length - 1] : partes[0] || "";
}

/** Qué nombra la etiqueta. Con `hacia`, cada uso trae además lo que NO se cambiaría solo
 *  al renombrar a ese nombre. No escribe nada. */
export async function usosDeEtiqueta(nombre: string, hacia?: string): Promise<UsoEtiqueta[]> {
  const h = hacia && hacia.trim() ? hacia.trim() : null;
  const sobra: Cambio[] = [];
  return [...(await analizarFlujos(nombre, h, sobra)), ...(await analizarResto(nombre, h, sobra))];
}

export interface ResultadoRenombrado {
  /** Elementos cuya referencia se cambió al nombre nuevo. */
  actualizados: UsoEtiqueta[];
  /** Elementos con algo que sigue con el nombre viejo, y por qué. */
  pendientes: UsoEtiqueta[];
  /** Elementos que no se pudieron guardar (se dice cuáles; el resto sí se guardó). */
  errores: { tipo: TipoUso; id: string; nombre: string; error: string }[];
}

/** Cambia el nombre en toda la configuración que lo usa. Los contactos y el catálogo los
 *  cambia quien llama (POST /admin/api/tags). */
export async function renombrarReferencias(desde: string, hacia: string): Promise<ResultadoRenombrado> {
  const cambios: Cambio[] = [];
  const usos = [...(await analizarFlujos(desde, hacia, cambios)), ...(await analizarResto(desde, hacia, cambios))];
  const res: ResultadoRenombrado = { actualizados: [], pendientes: usos.filter((u) => u.pendientes.length), errores: [] };
  for (const c of cambios) {
    try {
      if (await c.guardar()) { if (c.uso.roles.length && !res.actualizados.includes(c.uso)) res.actualizados.push(c.uso); }
      else res.errores.push({ tipo: c.uso.tipo, id: c.uso.id, nombre: c.uso.nombre, error: c.uso.tipo === "difusion" ? "ya ha empezado a enviarse" : "no se encontró" });
    } catch (e) {
      res.errores.push({ tipo: c.uso.tipo, id: c.uso.id, nombre: c.uso.nombre, error: String((e as Error)?.message || e).slice(0, 160) });
    }
  }
  return res;
}
