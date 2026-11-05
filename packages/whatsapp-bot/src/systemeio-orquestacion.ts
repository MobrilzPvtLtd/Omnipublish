/** SIO-ORQUESTA-1 · API y MCP oficiales, aditivos al puente compartido con el curso.
 * Cuenta explícita, destinos fijos, catálogo paginado y ninguna repetición de escrituras.
 * Las claves nunca forman parte de la URL, los resultados ni los mensajes de error. */
import crypto from "node:crypto";
import { getAccount, type SiAccount } from "./systemeio-accounts.js";
import { currentWorkspaceId } from "./workspace.js";
import { stripSecrets } from "./activity.js";
import { SYSTEME_OPERACIONES } from "./systemeio-catalogo.js";

type Objeto = Record<string, any>;
type Permisos = { permite: (vista: string) => boolean; administra: boolean };
type Operacion = { id: string; metodo: string; ruta: string; dominio: string; resumen: string;
  documentacion: string; parametros: readonly any[]; cuerpo?: any; obsoleta?: boolean };
const operaciones: readonly Operacion[] = SYSTEME_OPERACIONES;
const MCP_URL = "https://mcp.systeme.io/mcp";
const TOPE_RESPUESTA = 2 * 1024 * 1024, TOPE_CATALOGO = 64, TTL = 5 * 60_000;
const catalogos = new Map<string, { vence: number; herramientas: Objeto[]; bytes: number }>();
const pendientes = new Map<string, Promise<Objeto[]>>();
const actividad = new Map<string, number>();
let activas = 0;
function error(status: number, mensaje: string): never { throw Object.assign(new Error(mensaje), { status }); }
function objeto(v: unknown, nombre: string): Objeto {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) error(400, nombre + " debe ser un objeto");
  return v as Objeto;
}
function entero(v: unknown, defecto: number, max: number): number {
  const n = v === undefined ? defecto : Number(v);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) error(400, "Paginación no válida");
  return n;
}
function clave(a: SiAccount): string {
  return JSON.stringify([currentWorkspaceId(), a.id, crypto.createHash("sha256").update(a.mcpKey || "").digest("hex")]);
}
async function cuenta(id: unknown): Promise<SiAccount> {
  if (typeof id !== "string" || !id.trim()) error(400, "Elige una cuenta conectada de este negocio");
  const a = await getAccount(id);
  if (!a) error(404, "La cuenta no pertenece a este negocio o ya no está conectada");
  return a;
}
async function limitada<T>(a: SiAccount, fn: () => Promise<T>): Promise<T> {
  const k = JSON.stringify([currentWorkspaceId(), a.id]), n = actividad.get(k) || 0;
  if (n >= 3 || activas >= 24) error(429, "Hay varias operaciones en curso. Espera antes de repetir");
  actividad.set(k, n + 1); activas++;
  try { return await fn(); } finally {
    activas--; const restante = (actividad.get(k) || 1) - 1;
    if (restante) actividad.set(k, restante); else actividad.delete(k);
  }
}
export function vistaSysteme(nombre: string): string | null {
  const n = nombre.toLowerCase();
  // En la API manda el recurso principal: newsletter/included-tags no es Contactos.
  if (n.startsWith("/api/")) {
    const dominio = n.split("/")[2];
    return ({ contacts: "contacts", contact_fields: "contacts", tags: "contacts", mailing: "newsletter",
      "booking-calendar": "meetings", automation: "flow", funnels: "pages", "funnel-steps": "pages",
      "page-editor": "pages", pages: "pages", domains: "pages", files: "pages", payment: "paylinks" } as Record<string, string>)[dominio] || null;
  }
  if (/newsletter|mailing|campaign/.test(n)) return "newsletter";
  if (/booking|calendar|availability/.test(n)) return "meetings";
  if (/automation|workflow/.test(n)) return "flow";
  if (/funnel|page|domain|file/.test(n)) return "pages";
  if (/payment|price|coupon|offer|subscription|product/.test(n)) return "paylinks";
  if (/contact|tag/.test(n)) return "contacts";
  // Cursos, comunidades y SMS aún no tienen vista propia en Business Stack.
  return null;
}
function permitida(nombre: string, permisos: Permisos): boolean {
  const vista = vistaSysteme(nombre);
  return permisos.permite("connections") && (vista ? permisos.permite(vista) : permisos.administra);
}
export function lecturaSystemeMcp(h: Objeto): boolean {
  // Lo desconocido es escritura: no basta una descripción en lenguaje natural.
  return h.annotations?.readOnlyHint === true && h.annotations?.destructiveHint !== true
    && /^(?:get|list|find|search|retrieve|fetch|read)(?:[_\-.A-Z]|$)/.test(String(h.name || ""));
}
async function leerRespuesta(r: Response, rpcId?: number): Promise<any> {
  if (r.status === 204 || r.status === 202) { await r.body?.cancel(); return null; }
  const reader = r.body?.getReader();
  if (!reader) error(502, "El proveedor devolvió una respuesta vacía");
  let bytes = 0, texto = "", cola = "";
  const decoder = new TextDecoder(), sse = (r.headers.get("content-type") || "").includes("text/event-stream");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > TOPE_RESPUESTA) error(502, "La respuesta es demasiado grande. Reduce el límite o el filtro");
      const chunk = decoder.decode(value, { stream: true });
      if (!sse) { texto += chunk; continue; }
      cola += chunk;
      // SSE puede permanecer abierto: terminar en el resultado del id solicitado.
      let corte: RegExpExecArray | null;
      while ((corte = /\r?\n\r?\n/.exec(cola))) {
        const evento = cola.slice(0, corte.index); cola = cola.slice(corte.index + corte[0].length);
        const datos = evento.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
        if (!datos) continue;
        const parsed = JSON.parse(datos);
        if (parsed.id === rpcId) return parsed;
      }
    }
    if (sse) error(502, "El proveedor cerró la conexión sin resultado");
    return JSON.parse(texto + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}
async function enviar(url: string, headers: Record<string, string>, method: string, body?: unknown): Promise<Response> {
  let r: Response;
  try { r = await fetch(url, { method, headers, redirect: "error", signal: AbortSignal.timeout(25_000),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
  catch { error(502, "No se pudo completar la conexión con systeme.io. Comprueba el estado antes de repetir una escritura"); }
  if (!r.ok) {
    await r.body?.cancel();
    if (r.status === 401 || r.status === 403) error(r.status, "La cuenta de systeme.io rechazó el acceso. Revisa su clave y permisos");
    if (r.status === 429) error(429, "systeme.io ha agotado temporalmente su cuota. Espera antes de repetir");
    error(502, "systeme.io respondió con estado " + r.status + ". No se ha repetido la operación");
  }
  return r;
}
async function sesionMcp<T>(key: string, fn: (rpc: (metodo: string, params: Objeto) => Promise<any>) => Promise<T>): Promise<T> {
  const headers: Record<string, string> = { "X-MCP-Key": key, Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
  let secuencia = 0, sid = "";
  const rpc = async (method: string, params: Objeto): Promise<any> => {
    const id = ++secuencia;
    const r = await enviar(MCP_URL, headers, "POST", { jsonrpc: "2.0", id, method, params });
    if (method === "initialize") { sid = r.headers.get("mcp-session-id") || ""; if (sid) headers["Mcp-Session-Id"] = sid; }
    const data = await leerRespuesta(r, id);
    if (!data || data.id !== id || data.error) error(502, "El MCP de systeme.io no pudo completar " + method);
    return data.result;
  };
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "BusinessStack", version: "1.0" } });
    if (!["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(init?.protocolVersion)) error(502, "Versión MCP del proveedor no compatible");
    headers["MCP-Protocol-Version"] = init.protocolVersion;
    const n = await enviar(MCP_URL, headers, "POST", { jsonrpc: "2.0", method: "notifications/initialized" });
    await n.body?.cancel();
    return await fn(rpc);
  } finally {
    // Los servidores sin sesión no necesitan DELETE. Sin reintentar ni ocultar el resultado.
    if (sid) try { const r = await fetch(MCP_URL, { method: "DELETE", headers, redirect: "error", signal: AbortSignal.timeout(3000) }); await r.body?.cancel(); } catch { /* caduca en el proveedor */ }
  }
}
export async function comprobarClaveMcp(key: string, accountId: string): Promise<number> {
  if (!key || key.length > 4096 || /[\r\n]/.test(key)) error(400, "Clave de acceso no válida");
  const a = await cuenta(accountId);
  return limitada(a, () => sesionMcp(key, async rpc => {
    const r = await rpc("tools/list", {});
    if (!Array.isArray(r?.tools)) error(502, "El proveedor no devolvió su catálogo");
    return r.tools.length;
  }));
}
async function herramientas(a: SiAccount): Promise<Objeto[]> {
  if (!a.mcpKey) error(409, "Conecta el acceso de orquestación de esta cuenta en Conexiones");
  const k = clave(a), ahora = Date.now();
  for (const [id, c] of catalogos) if (c.vence <= ahora) catalogos.delete(id);
  const c = catalogos.get(k); if (c) return c.herramientas;
  const enCurso = pendientes.get(k); if (enCurso) return enCurso;
  if (pendientes.size >= 8) error(429, "Hay varios catálogos cargándose. Espera un momento");
  const p = sesionMcp(a.mcpKey, async rpc => {
    const lista: Objeto[] = [], cursores = new Set<string>(); let cursor: string | undefined;
    for (let pagina = 0; pagina < 12; pagina++) {
      const r = await rpc("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(r?.tools)) error(502, "Catálogo MCP no válido");
      for (const h of r.tools) {
        if (typeof h?.name !== "string" || h.name.length > 128 || !h.inputSchema || typeof h.inputSchema !== "object") error(502, "Herramienta MCP no válida");
        lista.push(h);
      }
      if (lista.length > 1000 || Buffer.byteLength(JSON.stringify(lista)) > TOPE_RESPUESTA) error(502, "Catálogo MCP demasiado grande");
      cursor = r.nextCursor;
      if (!cursor) {
        if (new Set(lista.map(h => h.name)).size !== lista.length) error(502, "Catálogo MCP con nombres repetidos");
        const bytes = Buffer.byteLength(JSON.stringify(lista));
        let usados = [...catalogos.values()].reduce((n,c) => n + c.bytes, 0);
        while (catalogos.size >= TOPE_CATALOGO || usados + bytes > 16 * 1024 * 1024) {
          const primero = catalogos.keys().next().value!;
          usados -= catalogos.get(primero)!.bytes; catalogos.delete(primero);
        }
        catalogos.set(k, { vence: Date.now() + TTL, herramientas: lista, bytes }); return lista;
      }
      if (typeof cursor !== "string" || cursor.length > 4096 || cursores.has(cursor)) error(502, "Paginación MCP no válida");
      cursores.add(cursor);
    }
    error(502, "El catálogo MCP supera el número de páginas admitido");
  });
  pendientes.set(k, p);
  try { return await p; } finally { if (pendientes.get(k) === p) pendientes.delete(k); }
}
// SIO-EDITOR-1 · TODO el systemeio-mcp propio (páginas, correo, workflows, contactos, calendario,
// productos…) en systeme.io y leadmatch-lab. Fuera: depuración del navegador, sesión y claves.
const EDITOR_VETADAS = new Set(["eval-js", "dom-query", "browser-fetch", "intercept-requests", "explore", "ping",
  "login-start", "login-verify-2fa", "logout", "session-status", "ensure-api-key", "rotate-api-key", "audit-student-account"]);
const LOTE = "lote", TOPE_LOTE = 25;
const editorLectura = (n: string) => /^(?:list|get|read|count|screenshot|debug|validators)-/.test(n);
// Lo que vistaSysteme no clasifica (checkout, formularios, moneda…) es de Páginas.
const rutaPermisoEditor = (n: string) => vistaSysteme(n) ? n : "/api/pages";
async function herramientasEditor(a: SiAccount): Promise<Objeto[]> {
  const { listarHerramientasEditor } = await import("./mcp-bridge.js");
  const lista = (await listarHerramientasEditor(a.id)).filter(h => !EDITOR_VETADAS.has(h.name));
  return [...lista, { name: LOTE, description: "Ejecuta en orden hasta " + TOPE_LOTE + " operaciones del editor (equivale a los *-bundle del curso: varias páginas, SEO, slugs, formularios, subidas). Se detiene en el primer error.",
    inputSchema: { type: "object", required: ["operaciones"], properties: { operaciones: { type: "array", maxItems: TOPE_LOTE, items: { type: "object", required: ["operacion"],
      properties: { operacion: { type: "string" }, parametros: { type: "object" } } } }, continuar_si_falla: { type: "boolean" } } } }];
}
function fuenteDe(v: unknown): "api" | "mcp" | "editor" {
  if (v === undefined || v === "api") return "api";
  if (v === "mcp" || v === "editor") return v;
  error(400, "El origen debe ser api, mcp o editor");
}
export async function catalogoSysteme(args: Objeto, permisos: Permisos): Promise<Objeto> {
  const a = await cuenta(args.accountId), fuente = fuenteDe(args.fuente);
  const offset = entero(args.offset, 0, 10000), limit = Math.max(1, entero(args.limit, 20, 50));
  const buscar = String(args.buscar || "").slice(0, 150).toLowerCase();
  return limitada(a, async () => {
    const rows: Objeto[] = fuente === "api" ? operaciones.map(op => ({ ...op, lectura: op.metodo === "GET" }))
      : fuente === "editor" ? (await herramientasEditor(a)).map(h => ({ id: h.name, resumen: h.description, esquema: h.inputSchema, lectura: editorLectura(h.name), dominio: vistaSysteme(h.name) || "pages" }))
      : (await herramientas(a)).map(h => ({ id: h.name, resumen: h.description, esquema: h.inputSchema, lectura: lecturaSystemeMcp(h) }));
    const visibles = rows.filter(r => permitida(fuente === "api" ? r.ruta : fuente === "editor" ? rutaPermisoEditor(r.id) : r.id, permisos));
    const filtradas = visibles.filter(r => !buscar || (r.id + " " + r.resumen).toLowerCase().includes(buscar));
    const seleccion = args.operacion ? filtradas.filter(r => r.id === args.operacion) : filtradas.slice(offset, offset + limit);
    return { accountId: a.id, fuente, total: filtradas.length, offset, limit, hasMore: !args.operacion && offset + limit < filtradas.length,
      operaciones: seleccion.map(r => args.operacion ? r : { id: r.id, resumen: r.resumen, lectura: r.lectura, dominio: r.dominio,
        ...(r.documentacion ? { documentacion: r.documentacion } : {}) }),
      nota: "Las escrituras requieren confirmación. El catálogo no implica que el plan de la cuenta admita todas las operaciones." };
  });
}
function validarValor(v: unknown, s: Objeto, nombre: string, nivel = 0): void {
  if (nivel > 24) error(400, "La operación tiene demasiados niveles");
  if (v === null && (s.nullable || s.type === "null" || Array.isArray(s.type) && s.type.includes("null"))) return;
  const tipos = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (tipos.length && !tipos.some((t: string) => t === "integer" ? Number.isSafeInteger(v) : t === "number" ? typeof v === "number" && Number.isFinite(v)
    : t === "array" ? Array.isArray(v) : t === "object" ? !!v && typeof v === "object" && !Array.isArray(v) : typeof v === t)) error(400, nombre + ": tipo no válido");
  if (s.enum && !s.enum.includes(v)) error(400, nombre + ": valor no permitido");
  if (typeof v === "number" && (s.minimum !== undefined && v < s.minimum || s.maximum !== undefined && v > s.maximum)) error(400, nombre + ": fuera de rango");
  if (typeof v === "string" && (s.minLength !== undefined && v.length < s.minLength || s.maxLength !== undefined && v.length > s.maxLength)) error(400, nombre + ": longitud no válida");
  for (const regla of s.allOf || []) validarValor(v, regla, nombre, nivel + 1);
  for (const variante of ["oneOf", "anyOf"]) if (s[variante]?.length) {
    let validas = 0;
    for (const regla of s[variante]) try { validarValor(v, regla, nombre, nivel + 1); validas++; } catch { /* otra variante */ }
    if (!validas || variante === "oneOf" && validas !== 1) error(400, nombre + ": no coincide con el contrato publicado");
  }
  if (Array.isArray(v)) for (let i = 0; i < v.length; i++) validarValor(v[i], s.items || {}, nombre + "[" + i + "]", nivel + 1);
  else if (v && typeof v === "object") {
    const o = v as Objeto;
    for (const k of s.required || []) if (!Object.hasOwn(o, k)) error(400, "Falta " + nombre + "." + k);
    for (const [k, valor] of Object.entries(o)) {
      if (["__proto__", "prototype", "constructor"].includes(k)) error(400, "Propiedad no permitida");
      if (s.additionalProperties === false && !Object.hasOwn(s.properties || {}, k)) error(400, nombre + ": propiedad desconocida");
      validarValor(valor, s.properties?.[k] || {}, nombre + "." + k, nivel + 1);
    }
  }
}
export function ocultarRespuestaSysteme(valor: unknown, claves: string[], nivel = 0): unknown {
  if (nivel > 24) return "[resultado demasiado anidado]";
  if (typeof valor === "string") {
    // MCP también devuelve objetos JSON dentro de content[].text.
    if (nivel < 20 && /^[\s]*[\[{]/.test(valor)) try { return JSON.stringify(ocultarRespuestaSysteme(JSON.parse(valor), claves, nivel + 1)); } catch { /* texto normal */ }
    let texto = valor; for (const k of claves) if (k) texto = texto.split(k).join("__redacted__");
    return stripSecrets(texto);
  }
  if (Array.isArray(valor)) return valor.map(v => ocultarRespuestaSysteme(v, claves, nivel + 1));
  if (valor && typeof valor === "object") return stripSecrets(Object.fromEntries(Object.entries(valor).map(([k,v]) => [k, ocultarRespuestaSysteme(v, claves, nivel + 1)])));
  return valor;
}
export function prepararOperacionSysteme(op: Operacion, args: Objeto): { url: string; cuerpo?: unknown; mime?: string } {
  const p = objeto(args.parametros, "parametros"), q = objeto(args.consulta, "consulta");
  let ruta = op.ruta;
  for (const nombre of Object.keys(p)) if (!op.parametros.some(v => v.en === "path" && v.nombre === nombre)) error(400, "Parámetro de ruta desconocido: " + nombre);
  for (const campo of op.parametros.filter(v => v.en === "path")) {
    const valor = p[campo.nombre];
    if (valor === undefined || valor === null) error(400, "Falta " + campo.nombre);
    validarValor(valor, campo.esquema, campo.nombre);
    const segmento = String(valor);
    if (!segmento || segmento === "." || segmento === ".." || /[/\\%?#\u0000-\u001f]/.test(segmento)) error(400, "Identificador de ruta no válido");
    ruta = ruta.replace("{" + campo.nombre + "}", encodeURIComponent(segmento));
  }
  if (/[{}]/.test(ruta)) error(400, "Faltan parámetros de ruta");
  const url = new URL(ruta, "https://api.systeme.io");
  for (const [nombre, valor] of Object.entries(q)) {
    const campo = op.parametros.find(v => v.en === "query" && v.nombre === nombre);
    if (!campo) error(400, "Filtro no documentado: " + nombre);
    validarValor(valor, campo.esquema, nombre);
    if (valor !== null && typeof valor === "object" && !Array.isArray(valor)) error(400, "Filtro no válido: " + nombre);
    for (const v of Array.isArray(valor) ? valor : [valor]) url.searchParams.append(nombre, String(v));
  }
  for (const campo of op.parametros.filter(v => v.en === "query" && v.requerido)) if (q[campo.nombre] === undefined) error(400, "Falta " + campo.nombre);
  if (op.parametros.some(v => v.en === "query" && v.nombre === "limit") && !url.searchParams.has("limit")) url.searchParams.set("limit", "25");
  if (op.cuerpo?.requerido && args.cuerpo === undefined) error(400, "Falta el cuerpo de la operación");
  if (args.cuerpo !== undefined) {
    if (!op.cuerpo) error(400, "Esta operación no acepta cuerpo");
    validarValor(args.cuerpo, op.cuerpo.esquema, "cuerpo");
    for (const k of op.cuerpo.esquema.required || []) if (args.cuerpo?.[k] === undefined) error(400, "Falta cuerpo." + k);
  }
  return { url: url.toString(), cuerpo: args.cuerpo, mime: op.cuerpo?.mime };
}
export async function ejecutarSysteme(args: Objeto, permisos: Permisos, soloLectura: boolean): Promise<Objeto> {
  const a = await cuenta(args.accountId), fuente = fuenteDe(args.fuente);
  if (typeof args.operacion !== "string" || args.operacion.length > 300) error(400, "Elige una operación del catálogo");
  if (Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024) error(413, "La operación es demasiado grande");
  return limitada(a, async () => {
    const op = fuente === "api" ? operaciones.find(o => o.id === args.operacion) : undefined;
    const h = fuente === "mcp" ? (await herramientas(a)).find(h => h.name === args.operacion)
      : fuente === "editor" ? (await herramientasEditor(a)).find(h => h.name === args.operacion) : undefined;
    if (!op && !h) error(404, "La operación no existe en el catálogo de esta cuenta");
    const editor = fuente === "editor" ? await herramientasEditor(a) : [];
    const pasos: Objeto[] = h?.name === LOTE ? objeto(args.parametros, "parametros").operaciones : [];
    if (h?.name === LOTE) {
      if (!Array.isArray(pasos) || !pasos.length || pasos.length > TOPE_LOTE) error(400, "El lote necesita entre 1 y " + TOPE_LOTE + " operaciones");
      for (const p of pasos) {
        const hp = editor.find(x => x.name === p?.operacion);
        if (!hp || hp.name === LOTE) error(400, "Operación de lote desconocida: " + String(p?.operacion));
        if (!permitida(rutaPermisoEditor(hp.name), permisos)) error(403, "No tienes permiso para " + hp.name);
      }
    } else if (!permitida(op ? op.ruta : fuente === "editor" ? rutaPermisoEditor(h!.name) : h!.name, permisos)) error(403, "No tienes permiso para esa función");
    const lectura = op ? op.metodo === "GET" : fuente === "editor"
      ? (h!.name === LOTE ? pasos.every(p => editorLectura(p.operacion)) : editorLectura(h!.name)) : lecturaSystemeMcp(h!);
    if (!lectura && soloLectura) error(403, "Esta operación no está certificada como consulta");
    if (!lectura && args.confirmado_por_humano !== true) error(428, "Muestra la cuenta, la acción y sus efectos al usuario y solicita confirmación antes de ejecutarla");
    let resultado: unknown;
    if (op) {
      if (!a.apiKey) error(409, "Esta cuenta necesita su clave de acceso a la API en Conexiones");
      const req = prepararOperacionSysteme(op, args);
      const r = await enviar(req.url, { "X-API-Key": a.apiKey, Accept: "application/json", "Content-Type": req.mime || "application/json" }, op.metodo, req.cuerpo);
      resultado = await leerRespuesta(r);
    } else {
      const params = objeto(args.parametros, "parametros");
      const schema = h!.inputSchema;
      validarValor(params, schema, "parametros");
      for (const k of schema.required || []) if (params[k] === undefined) error(400, "Falta " + k);
      for (const [k,v] of Object.entries(params)) {
        if (schema.additionalProperties === false && !schema.properties?.[k]) error(400, "Parámetro no admitido: " + k);
        if (schema.properties?.[k]) validarValor(v, schema.properties[k], k);
      }
      if (fuente === "editor" && h!.name === LOTE) {
        const { llamarHerramientaEditor } = await import("./mcp-bridge.js");
        const resultados: Objeto[] = [];
        for (const p of pasos) {
          const r = await llamarHerramientaEditor(a.id, p.operacion, objeto(p.parametros, "parametros"));
          resultados.push({ operacion: p.operacion, ...r });
          if (r.isError && params.continuar_si_falla !== true) break;
        }
        resultado = { isError: resultados.some(r => r.isError), hechas: resultados.length, total: pasos.length, resultados };
      } else if (fuente === "editor") {
        const { llamarHerramientaEditor } = await import("./mcp-bridge.js");
        resultado = await llamarHerramientaEditor(a.id, h!.name, params);
      } else resultado = await sesionMcp(a.mcpKey!, rpc => rpc("tools/call", { name: h!.name, arguments: params }));
    }
    return { ok: !(resultado && typeof resultado === "object" && (resultado as Objeto).isError), accountId: a.id, fuente, operacion: args.operacion, lectura, resultado: ocultarRespuestaSysteme(resultado, [a.apiKey || "", a.mcpKey || ""]) };
  });
}
