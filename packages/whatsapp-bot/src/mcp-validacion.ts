/** Banderas de «ya se lo pregunté al usuario» (cuestionario previo a publicar). Algunos clientes MCP
 *  tienen cacheado un catálogo viejo de herramientas SIN estos parámetros y mandan todo lo que no
 *  conocen como texto: «true» llegaba como "true" y la publicación se quedaba en borrador para
 *  siempre («debe ser verdadero o falso»). Solo estas dos se aceptan como texto «true»/«false».
 *  NO se tocan `confirmado_por_humano` ni ningún otro booleano: la validación estricta sigue. */
const BANDERAS_CUESTIONARIO = ["flujos_decididos", "sin_comentario_fijado"];
export function normalizarBanderasCuestionario<T extends Record<string, unknown>>(args: T): T {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  let salida: Record<string, unknown> | null = null;
  for (const k of BANDERAS_CUESTIONARIO) {
    const v = (args as Record<string, unknown>)[k];
    if (typeof v !== "string") continue;
    const t = v.trim().toLowerCase();
    if (t !== "true" && t !== "false") continue;
    salida ??= { ...args };
    salida[k] = t === "true";
  }
  // `comentario_fijado` {red: texto}: el mismo cliente con catálogo viejo lo manda como JSON en texto.
  const cf = (args as Record<string, unknown>).comentario_fijado;
  if (typeof cf === "string" && cf.trim().startsWith("{")) {
    try {
      const o = JSON.parse(cf);
      if (o && typeof o === "object" && !Array.isArray(o)) { salida ??= { ...args }; salida.comentario_fijado = o; }
    } catch { /* texto que no es JSON: la validación estricta lo explica */ }
  }
  // `flujos_al_publicar` (lista de ids): un cliente con catálogo viejo lo manda como texto: JSON o «a, b».
  const fl = (args as Record<string, unknown>).flujos_al_publicar;
  if (typeof fl === "string" && fl.trim()) {
    let ids: unknown = null;
    if (fl.trim().startsWith("[")) { try { ids = JSON.parse(fl); } catch { /* texto: se separa por comas */ } }
    if (!Array.isArray(ids)) ids = fl.split(/[,;\s]+/).filter(Boolean);
    salida ??= { ...args }; salida.flujos_al_publicar = (ids as unknown[]).filter((x) => typeof x === "string");
  }
  return (salida ?? args) as T;
}

/** Validación del contrato MCP antes de ejecutar operaciones del panel. */
export function validarArgumentos(esquema: Record<string, unknown>, valor: unknown, ruta = "argumentos", profundidad = 0): string | null {
  if (profundidad > 24) return ruta + ": demasiados niveles";
  const tipo = esquema.type;
  const objeto = valor !== null && typeof valor === "object" && !Array.isArray(valor);
  if (tipo === "object" && !objeto) return ruta + ": debe ser un objeto";
  if (tipo === "array" && !Array.isArray(valor)) return ruta + ": debe ser una lista";
  if (tipo === "string" && typeof valor !== "string") return ruta + ": debe ser texto";
  if (tipo === "boolean" && typeof valor !== "boolean") return ruta + ": debe ser verdadero o falso";
  if ((tipo === "number" || tipo === "integer") && (typeof valor !== "number" || !Number.isFinite(valor) || (tipo === "integer" && !Number.isInteger(valor)))) return ruta + ": debe ser un número" + (tipo === "integer" ? " entero" : " finito");
  if (Array.isArray(esquema.enum) && !esquema.enum.includes(valor)) return ruta + ": valor fuera de las opciones permitidas";
  if (typeof valor === "number") {
    if (typeof esquema.minimum === "number" && valor < esquema.minimum) return ruta + ": inferior al mínimo " + esquema.minimum;
    if (typeof esquema.maximum === "number" && valor > esquema.maximum) return ruta + ": superior al máximo " + esquema.maximum;
  }
  if (typeof valor === "string" && valor.length > 500_000) return ruta + ": texto demasiado largo";
  if (Array.isArray(valor)) {
    if (valor.length > 10_000) return ruta + ": lista demasiado larga";
    for (let i = 0; i < valor.length; i++) {
      const error = validarArgumentos(esquema.items && typeof esquema.items === "object" ? esquema.items as Record<string, unknown> : {}, valor[i], ruta + "[" + i + "]", profundidad + 1);
      if (error) return error;
    }
  }
  if (objeto) {
    const v = valor as Record<string, unknown>;
    const props = (esquema.properties || {}) as Record<string, Record<string, unknown>>;
    const requeridos = (esquema.required || []) as string[];
    for (const k of requeridos) if (!Object.hasOwn(v, k) || v[k] === undefined || v[k] === null) return ruta + ": falta «" + k + "»";
    for (const k of Object.keys(v)) {
      if (["__proto__", "constructor", "prototype"].includes(k)) return ruta + ": propiedad no permitida";
      if (!Object.hasOwn(props, k) && esquema.additionalProperties === false) return ruta + ": no admite «" + k + "»";
      const regla = Object.hasOwn(props, k) ? props[k] : typeof esquema.additionalProperties === "object" ? esquema.additionalProperties as Record<string, unknown> : {};
      const error = validarArgumentos(regla, v[k], ruta + "." + k, profundidad + 1);
      if (error) return error;
    }
  }
  return null;
}
