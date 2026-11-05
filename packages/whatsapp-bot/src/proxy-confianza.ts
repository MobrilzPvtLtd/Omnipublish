/** PROXY-CONFIANZA-1 · De quién se acepta X-Forwarded-For (y con ello req.ip, que
 * alimenta los topes por IP de login, PIN y formularios públicos).
 *
 *   TRUST_PROXY=<n>            confiar en los n saltos más cercanos, siempre que el
 *                              primero (quien abre la conexión) sea una IP no pública
 *   TRUST_PROXY=<ip/cidr,...>  confiar solo en esos emisores (también loopback, …)
 *   TRUST_PROXY=false          no confiar en nadie: req.ip es la IP del socket
 *   sin definir, en Railway    como TRUST_PROXY=2
 *   sin definir, fuera         no confiar en nadie
 *
 * Por qué 2 saltos en Railway y no el rango del edge: Railway no publica ese rango; el
 * edge llega al contenedor desde su red interna (100.64.0.0/10, no pública) y el
 * contenedor no es alcanzable de otro modo. Medido en producción el 26-sep-2026: TODAS
 * las peticiones llegan con dos entradas en X-Forwarded-For, también las que no traían
 * ninguna — `<cliente>, <salto interno de Railway con IP pública>` —, y (según Railway)
 * el edge descarta la X-Forwarded-For que mande el cliente. Con 1 salto, req.ip era ese salto interno: los
 * topes por IP agrupaban a visitantes distintos y el freno de login no frenaba (medido:
 * 6 fallos seguidos, ningún 429). Con 2, req.ip es la primera entrada, la del cliente; y
 * si el edge dejara pasar una X-Forwarded-For inventada, quedaría a la izquierda y
 * tampoco se leería. Fastify 5 ignora a propósito un número a secas («no valida al
 * emisor inmediato») y dejaría req.ip = IP del edge: por eso se le pasa una función que
 * exige, además, que quien conecta no sea una IP pública. Si una instancia de cliente se
 * quedara sin confianza, todos los visitantes de sus formularios compartirían la IP del
 * proxy y el tope por IP bloquearía leads reales. Nunca se admite un comodín (`true`, `*`). */
import { isIP } from "node:net";
import { isPublicAddress } from "./public-download.js";

export type FnConfianza = (addr: string, i: number) => boolean;
export type ConfianzaProxy = false | string[] | FnConfianza;

/** n saltos, con el emisor inmediato obligatoriamente en una red no pública. Un emisor
 * sin IP (socket ya cerrado) no es de confianza: isPublicAddress("") daría false. */
export function confiarSaltos(n: number): FnConfianza {
  return (addr, i) => {
    if (i >= n) return false;
    if (i > 0) return true;
    const a = String(addr || "").replace(/^::ffff:/i, "");
    return isIP(a) !== 0 && !isPublicAddress(a);
  };
}

export function confianzaProxy(env: NodeJS.ProcessEnv = process.env): { valor: ConfianzaProxy; origen: string; texto: string } {
  const raw = env.TRUST_PROXY;
  if (raw !== undefined) {
    const v = raw.trim();
    if (!v || /^(false|off|no|0)$/i.test(v)) return { valor: false, origen: "TRUST_PROXY", texto: "ninguno (IP del socket)" };
    if (/^(true|\*|all)$/i.test(v)) {
      throw new Error("TRUST_PROXY no admite un comodín: indica el número de saltos (2 en Railway) o las IPs/CIDR de tus proxies.");
    }
    if (/^\d+$/.test(v)) return { valor: confiarSaltos(Number(v)), origen: "TRUST_PROXY", texto: `${v} salto(s) desde red no pública` };
    const lista = v.split(",").map((s) => s.trim()).filter(Boolean);
    return { valor: lista, origen: "TRUST_PROXY", texto: lista.join(", ") };
  }
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID) {
    return { valor: confiarSaltos(2), origen: "railway", texto: "2 saltos desde red no pública" };
  }
  return { valor: false, origen: "defecto", texto: "ninguno (IP del socket)" };
}

export function describirConfianza(c: { origen: string; texto: string }): string {
  return `proxies de confianza: ${c.texto} · origen: ${c.origen}`;
}
