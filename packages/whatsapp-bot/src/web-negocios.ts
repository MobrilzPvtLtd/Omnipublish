/**
 * NEGOCIO-EMBUDO-1 (MET-WEB-01) · Negocios y embudos de la analítica web.
 *
 * Un workspace puede medir varias webs que son de NEGOCIOS distintos (un training y una
 * consultoría en la misma cuenta, por ejemplo), y cada web mezcla varios EMBUDOS por ruta
 * (registro, reserva, venta…). Sin este mapa, Métricas → Web lo suma todo y nadie puede leer
 * el resultado de un negocio ni de un embudo.
 *
 * El mapa vive en los ajustes del workspace (`web.negocios`, JSON) y lo edita el propio
 * cliente desde la pestaña Web. Reglas:
 *  - Una web pertenece, como mucho, a UN negocio (la primera asignación gana).
 *  - Las webs sin asignar forman el pseudo-negocio «Sin negocio asignado» (`_sin`): ninguna
 *    visita se queda fuera de la vista.
 *  - Un embudo es una lista de páginas (web + ruta) de las webs de SU negocio. Una página que
 *    está en dos o más embudos del mismo negocio es COMPARTIDA: sólo cuenta para un embudo
 *    cuando la sesión pasa también por una página EXCLUSIVA de ese embudo. Así una página de
 *    gracias común no le regala a un embudo las visitas que trajo otro.
 *  - Sin mapa, o sin `biz` en la petición, la analítica es la de todo el workspace, como
 *    siempre: el Resumen y los demás canales no cambian.
 *
 * Este módulo sólo importa los ajustes: lo usan la analítica web y el panel sin ciclos.
 */
import { get as getSetting, set as setSetting } from "./settings.js";

export const CLAVE_MAPA = "web.negocios";
/** Pseudo-negocio de las webs que nadie ha asignado todavía. */
export const SIN_NEGOCIO = "_sin";
export const NOMBRE_SIN_NEGOCIO = "Sin negocio asignado";

export type ObjetivoEmbudo = "registro" | "reserva" | "venta" | "otro";
const OBJETIVOS: ObjetivoEmbudo[] = ["registro", "reserva", "venta", "otro"];

// Topes: el mapa viaja entero en cada vista de la pestaña Web.
const MAX_NEGOCIOS = 20;
const MAX_EMBUDOS = 50;
const MAX_PAGINAS = 100;
const MAX_ETAPAS = 100;
const MAX_WEBS = 100;
const MAX_NOMBRE = 80;

export interface PaginaEmbudo { web: string; ruta: string }
export interface NegocioWeb { id: string; nombre: string; webs: string[] }

/** MEDICION-EMBUDO-1 (MET-WEB-02) · tipo de etapa de un embudo:
 *  - `pagina`: una página de las webs del negocio (se mide con las vistas).
 *  - `accion`: una acción marcada con `lmTrack('nombre')` (un clic, un inicio de registro, un pago).
 *  - `externa`: un paso que ocurre fuera de las webs medidas (checkout o agenda de otra
 *    herramienta). No se mide: se enseña como tal y no rompe el recorrido. */
export type TipoEtapa = "pagina" | "accion" | "externa";
const TIPOS_ETAPA: TipoEtapa[] = ["pagina", "accion", "externa"];
/** MEDICION-EMBUDO-1 · una etapa, en el orden del recorrido. `confirma` = esta etapa prueba
 *  el resultado (registro, reserva o pago confirmados), no un simple clic o inicio. */
export interface EtapaConfig { nombre: string; tipo: TipoEtapa; web: string; ruta: string; evento: string; confirma: boolean; url: string }
/** RECORRIDO-EMBUDO-1 (MET-WEB-03) · la dirección de un paso externo (el checkout o la agenda de
 *  otra herramienta), para abrirlo desde el recorrido. Solo http(s); cualquier otra cosa, vacía. */
export function urlPaso(u: unknown): string {
  const s = String(u ?? "").trim().slice(0, 500);
  if (!s) return "";
  try {
    const x = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : "https://" + s);
    return (x.protocol === "https:" || x.protocol === "http:") && x.hostname.includes(".") ? x.toString().slice(0, 500) : "";
  } catch { return ""; }
}
/** `paginas` se deriva de las etapas de tipo página (acota la analítica, como en MET-WEB-01). */
export interface EmbudoWeb { id: string; negocio: string; nombre: string; objetivo: ObjetivoEmbudo; paginas: PaginaEmbudo[]; etapas: EtapaConfig[] }
export interface MapaNegocios { negocios: NegocioWeb[]; embudos: EmbudoWeb[] }

/** MEDICION-EMBUDO-1 · la señal que da el resultado de un embudo: su ÚLTIMA etapa que confirma. */
export interface SenalEmbudo { nombre: string; tipo: TipoEtapa; web: string; ruta: string; evento: string }

/** Nombre de acción comparable: lmTrack guarda el texto tal cual; «Compra» y «compra » son la misma. */
export function normalizarEvento(e: unknown): string {
  return String(e ?? "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 60);
}

/** Lo que la analítica necesita para acotar filas: qué webs entran (o cuáles no) y, con un
 *  embudo, qué páginas son suyas en exclusiva y cuáles comparte con otros embudos. Con
 *  `comparar` no se acota nada: se calcula una fila por negocio. */
export interface FiltroAmbitoWeb {
  webs?: string[];
  excluir?: string[];
  /** `eventos` (MEDICION-EMBUDO-1): las acciones de sus etapas cuentan aunque se marquen en una
   *  página que no está en el embudo, si la sesión pasa por una página propia. */
  embudo?: { propias: string[]; compartidas: string[]; eventos?: string[] };
  comparar?: { id: string; nombre: string; webs?: string[]; excluir?: string[] }[];
  /** COMPARAR-EMBUDOS-1 (MET-WEB-05) · con un negocio y SIN embudo elegido: sus embudos, cada
   *  uno con su reparto de páginas, para compararlos lado a lado. No acota filas. */
  embudos?: EmbudoComparable[];
  /** COMPARAR-EMBUDOS-1 · con un embudo elegido: sus páginas en el orden del mapa (las etapas
   *  que explican su resultado). No acota filas. */
  etapas?: EtapaEmbudo[];
  /** MEDICION-EMBUDO-1 · con un embudo elegido: la etapa que da su resultado (null = sin decir). */
  senal?: SenalEmbudo | null;
  /** MEDICION-EMBUDO-1 · el aviso del ámbito (ver `AmbitoWeb.aviso`): con `sin-paginas` o
   *  `sin-propias` el embudo no tiene filas suyas y su resultado no se calcula. */
  aviso?: "" | "sin-webs" | "sin-paginas" | "sin-propias";
}

/** COMPARAR-EMBUDOS-1 · un embudo del negocio listo para calcular su fila de la comparativa. */
export interface EmbudoComparable {
  id: string;
  nombre: string;
  objetivo: ObjetivoEmbudo;
  paginas: number;
  aviso: "" | "sin-paginas" | "sin-propias";
  embudo: { propias: string[]; compartidas: string[]; eventos?: string[] };
  /** MEDICION-EMBUDO-1 · la etapa que da su resultado; null = aún no se ha dicho cuál. */
  senal?: SenalEmbudo | null;
}

/** COMPARAR-EMBUDOS-1 · una página del embudo, en su orden; `compartida` si otro embudo del
 *  negocio también la usa. MEDICION-EMBUDO-1 · también las acciones y los pasos externos, con
 *  su nombre y si confirman el resultado. */
export interface EtapaEmbudo { web: string; ruta: string; compartida: boolean; nombre?: string; tipo?: TipoEtapa; evento?: string; confirma?: boolean; url?: string }

/** Ámbito ya resuelto de una petición de la pestaña Web. */
export interface AmbitoWeb extends FiltroAmbitoWeb {
  biz: string;
  nombre: string;
  fun: string;
  funNombre: string;
  objetivo: string;
  /** '' · 'sin-webs' (negocio sin webs) · 'sin-paginas' (embudo vacío) ·
   *  'sin-propias' (todas sus páginas las comparte con otros embudos: no se puede separar). */
  aviso: "" | "sin-webs" | "sin-paginas" | "sin-propias";
  /** Con embudo, las webs de sus páginas; si no, null (las del negocio). */
  websVisibles: string[] | null;
}

export function mapaVacio(): MapaNegocios {
  return { negocios: [], embudos: [] };
}

/** Ruta comparable: sin consulta ni ancla, en minúsculas, con «/» delante y sin «/» final
 *  (salvo la raíz). Si pegan una dirección entera, se queda con su ruta. */
export function normalizarRuta(r: unknown): string {
  let s = String(r ?? "").trim();
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).pathname; } catch { /* se queda como texto */ }
  }
  s = s.split("#")[0].split("?")[0];
  try { s = decodeURIComponent(s); } catch { /* ruta con % suelto: tal cual */ }
  s = s.toLowerCase();
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "") || "/";
  return s.slice(0, 300);
}

/** Clave estable de una página: «web|ruta». */
export function claveDePagina(web: unknown, ruta: unknown): string {
  return `${String(web ?? "")}|${normalizarRuta(ruta)}`;
}

/** Limpia lo que llega del panel (o de los ajustes): nombres, ids, topes, una web por
 *  negocio, embudos sólo de negocios existentes y páginas sólo de las webs de su negocio. */
export function normalizarMapa(entrada: unknown): MapaNegocios {
  const src: any = entrada && typeof entrada === "object" ? entrada : {};
  const limpio = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NOMBRE);
  const usados = new Set<string>();
  const idValido = (s: unknown) => typeof s === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(s) && !usados.has(s);
  const nuevoId = (pref: string) => {
    let id = "";
    do { id = pref + Math.random().toString(36).slice(2, 10); } while (usados.has(id));
    return id;
  };
  const webTomada = new Set<string>();
  const negocios: NegocioWeb[] = [];
  for (const n of (Array.isArray(src.negocios) ? src.negocios : [])) {
    if (negocios.length >= MAX_NEGOCIOS) break;
    if (!n || typeof n !== "object") continue;
    const nombre = limpio(n.nombre);
    if (!nombre) continue;
    const id = idValido(n.id) ? String(n.id) : nuevoId("n");
    usados.add(id);
    const webs: string[] = [];
    for (const w of (Array.isArray(n.webs) ? n.webs : [])) {
      if (webs.length >= MAX_WEBS) break;
      const s = String(w ?? "").trim().slice(0, 200);
      if (!s || webTomada.has(s)) continue; // una web, un negocio: la primera asignación gana
      webTomada.add(s);
      webs.push(s);
    }
    negocios.push({ id, nombre, webs });
  }
  const porId = new Map(negocios.map((n) => [n.id, n]));
  const embudos: EmbudoWeb[] = [];
  for (const e of (Array.isArray(src.embudos) ? src.embudos : [])) {
    if (embudos.length >= MAX_EMBUDOS) break;
    if (!e || typeof e !== "object") continue;
    const neg = porId.get(String(e.negocio ?? ""));
    if (!neg) continue;
    const nombre = limpio(e.nombre);
    if (!nombre) continue;
    const id = idValido(e.id) ? String(e.id) : nuevoId("e");
    usados.add(id);
    const objetivo: ObjetivoEmbudo = OBJETIVOS.includes(e.objetivo) ? e.objetivo : "otro";
    // MEDICION-EMBUDO-1 · etapas ordenadas (páginas, acciones y pasos externos). Un mapa de
    // antes, sin `etapas`, las saca de sus páginas: nada de lo guardado se pierde.
    const fuente: any[] = Array.isArray(e.etapas)
      ? e.etapas
      : (Array.isArray(e.paginas) ? e.paginas : []).map((p: any) => ({ tipo: "pagina", web: p?.web, ruta: p?.ruta }));
    const vistas = new Set<string>();
    const paginas: PaginaEmbudo[] = [];
    const etapas: EtapaConfig[] = [];
    for (const x of fuente) {
      if (etapas.length >= MAX_ETAPAS) break;
      if (!x || typeof x !== "object") continue;
      const tipo: TipoEtapa = TIPOS_ETAPA.includes(x.tipo) ? x.tipo : "pagina";
      const nombreEt = limpio(x.nombre);
      const confirma = x.confirma === true;
      if (tipo === "pagina") {
        if (paginas.length >= MAX_PAGINAS) continue;
        const web = String(x.web ?? "").trim().slice(0, 200);
        // Sólo páginas de las webs de SU negocio: si la web cambia de negocio, sus páginas
        // dejan de ser de este embudo al guardar.
        if (!web || !neg.webs.includes(web)) continue;
        const ruta = normalizarRuta(x.ruta);
        const k = `p|${web}|${ruta}`;
        if (vistas.has(k)) continue;
        vistas.add(k);
        paginas.push({ web, ruta });
        etapas.push({ nombre: nombreEt, tipo, web, ruta, evento: "", confirma, url: "" });
      } else if (tipo === "accion") {
        // El nombre tal como se pasa a lmTrack (se compara sin mayúsculas ni espacios de más).
        const evento = String(x.evento ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        if (!evento) continue;
        const k = `e|${normalizarEvento(evento)}`;
        if (vistas.has(k)) continue;
        vistas.add(k);
        etapas.push({ nombre: nombreEt, tipo, web: "", ruta: "", evento, confirma, url: "" });
      } else {
        // Paso externo: su nombre (el panel pone el rótulo por defecto si va vacío) y, si la
        // dan, su dirección (RECORRIDO-EMBUDO-1): pulsarlo en el recorrido la abre.
        etapas.push({ nombre: nombreEt, tipo, web: "", ruta: "", evento: "", confirma, url: urlPaso(x.url) });
      }
    }
    embudos.push({ id, negocio: neg.id, nombre, objetivo, paginas, etapas });
  }
  return { negocios, embudos };
}

/** Mapa del workspace activo. Un valor ilegible cuenta como «sin mapa». */
export function leerMapa(): MapaNegocios {
  const raw = getSetting(CLAVE_MAPA, "");
  if (!raw) return mapaVacio();
  try { return normalizarMapa(JSON.parse(raw)); } catch { return mapaVacio(); }
}

/** Guarda el mapa (ya normalizado) en el workspace activo y lo devuelve tal como quedó. */
export async function guardarMapa(entrada: unknown): Promise<MapaNegocios> {
  const mapa = normalizarMapa(entrada);
  await setSetting(CLAVE_MAPA, JSON.stringify(mapa));
  return mapa;
}

/** Páginas propias y compartidas de un embudo: una página es COMPARTIDA si está en dos o más
 *  embudos de su negocio. */
function particion(mapa: MapaNegocios, emb: EmbudoWeb): { propias: string[]; compartidas: string[] } {
  const cuenta = new Map<string, number>();
  for (const e of mapa.embudos) {
    if (e.negocio !== emb.negocio) continue;
    for (const k of new Set(e.paginas.map((p) => claveDePagina(p.web, p.ruta)))) cuenta.set(k, (cuenta.get(k) || 0) + 1);
  }
  const claves = [...new Set(emb.paginas.map((p) => claveDePagina(p.web, p.ruta)))];
  return {
    propias: claves.filter((k) => (cuenta.get(k) || 0) < 2),
    compartidas: claves.filter((k) => (cuenta.get(k) || 0) >= 2),
  };
}

/** MEDICION-EMBUDO-1 · la ÚLTIMA etapa que confirma: la que da el resultado del embudo. */
export function senalDe(emb: EmbudoWeb): SenalEmbudo | null {
  for (let i = emb.etapas.length - 1; i >= 0; i--) {
    const s = emb.etapas[i];
    if (s.confirma) return { nombre: s.nombre, tipo: s.tipo, web: s.web, ruta: s.ruta, evento: s.evento };
  }
  return null;
}

/** MEDICION-EMBUDO-1 · las acciones de las etapas del embudo, comparables. */
function eventosDe(emb: EmbudoWeb): string[] {
  return [...new Set(emb.etapas.filter((s) => s.tipo === "accion" && s.evento).map((s) => normalizarEvento(s.evento)))];
}

/** ¿La web `id` se ve en este ámbito? (conmutador, comparativa por web y clics). */
export function webEnAmbito(a: AmbitoWeb | null | undefined, id: string): boolean {
  if (!a) return true;
  if (a.websVisibles) return a.websVisibles.includes(id);
  if (a.webs) return a.webs.includes(id);
  if (a.excluir) return !a.excluir.includes(id);
  return true;
}

/**
 * Resuelve el ámbito de una petición. `biz` vacío, «auto» o desconocido: el negocio de la
 * web elegida (`siteId`), o el primero. Un embudo que no es del negocio elegido se ignora
 * («Todo el negocio»). Con `cmp`, sin acotar y con una fila por negocio para comparar.
 * Sin negocios en el mapa devuelve null: todo el workspace, como siempre.
 */
export function resolverAmbito(mapa: MapaNegocios, q: { biz?: string; fun?: string; cmp?: boolean }, siteId = ""): AmbitoWeb | null {
  if (!mapa.negocios.length) return null;
  const asignadas = mapa.negocios.flatMap((n) => n.webs);
  const vacio = { fun: "", funNombre: "", objetivo: "", aviso: "" as const, websVisibles: null };
  if (q.cmp) {
    return {
      ...vacio, biz: "", nombre: "",
      comparar: [
        ...mapa.negocios.map((n) => ({ id: n.id, nombre: n.nombre, webs: n.webs.slice() })),
        { id: SIN_NEGOCIO, nombre: NOMBRE_SIN_NEGOCIO, excluir: asignadas.slice() },
      ],
    };
  }
  const pedido = String(q.biz || "");
  let neg = mapa.negocios.find((n) => n.id === pedido) || null;
  let sin = pedido === SIN_NEGOCIO;
  if (!neg && !sin) {
    const site = String(siteId || "");
    neg = (site && mapa.negocios.find((n) => n.webs.includes(site))) || null;
    if (!neg) {
      if (site && !asignadas.includes(site)) sin = true;
      else neg = mapa.negocios[0];
    }
  }
  if (sin || !neg) return { ...vacio, biz: SIN_NEGOCIO, nombre: NOMBRE_SIN_NEGOCIO, excluir: asignadas.slice() };
  const base: AmbitoWeb = { ...vacio, biz: neg.id, nombre: neg.nombre, webs: neg.webs.slice(), aviso: neg.webs.length ? "" : "sin-webs" };
  const negId = neg.id;
  const emb = q.fun ? mapa.embudos.find((e) => e.id === q.fun && e.negocio === negId) : null;
  if (!emb) {
    // COMPARAR-EMBUDOS-1 · «Todo el negocio»: sus embudos, para la comparativa lado a lado.
    const suyos = mapa.embudos.filter((e) => e.negocio === negId);
    if (suyos.length) {
      base.embudos = suyos.map((e) => {
        const part = particion(mapa, e);
        return {
          id: e.id, nombre: e.nombre, objetivo: e.objetivo, paginas: e.paginas.length,
          aviso: !e.paginas.length ? "sin-paginas" as const : (!part.propias.length ? "sin-propias" as const : "" as const),
          embudo: { ...part, eventos: eventosDe(e) },
          senal: senalDe(e),
        };
      });
    }
    return base;
  }
  const { propias, compartidas } = particion(mapa, emb);
  const comp = new Set(compartidas);
  return {
    ...base,
    fun: emb.id, funNombre: emb.nombre, objetivo: emb.objetivo,
    embudo: { propias, compartidas, eventos: eventosDe(emb) },
    // COMPARAR-EMBUDOS-1 · las etapas del embudo en su orden. MEDICION-EMBUDO-1 · con las
    // acciones, los pasos externos y cuál confirma el resultado.
    etapas: emb.etapas.map((s) => ({
      web: s.web, ruta: s.ruta, compartida: s.tipo === "pagina" && comp.has(claveDePagina(s.web, s.ruta)),
      nombre: s.nombre, tipo: s.tipo, evento: s.evento, confirma: s.confirma, url: s.url,
    })),
    senal: senalDe(emb),
    websVisibles: [...new Set(emb.paginas.map((p) => p.web))],
    aviso: !emb.paginas.length ? "sin-paginas" : (!propias.length ? "sin-propias" : base.aviso),
  };
}
