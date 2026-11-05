/** DESCARGA-PUBLICA-1 · Descargas de vistas previas: solo Internet, con presupuesto
 * de tiempo y bytes. La IP validada se fija en la conexión (no se resuelve dos
 * veces) y cada salto vuelve a validarse. Las cabeceras privadas solo se envían
 * por HTTPS al destino inicial, nunca a una redirección. */
import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";

export class PublicDownloadError extends Error {
  constructor(public readonly code: "blocked" | "too_large" | "timeout" | "redirects", message: string) {
    super(message);
    this.name = "PublicDownloadError";
  }
}

/** Solo rangos globales. Bloquea también IPv4 mapeada en IPv6, traducción,
 * documentación y túneles que podrían desembocar en una red local. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  const [first, second = "0"] = address.toLowerCase().split(":");
  const a = parseInt(first, 16), b = parseInt(second, 16) || 0;
  return a >= 0x2000 && a <= 0x3fff
    && !(a === 0x2001 && (b < 0x200 || b === 0xdb8))
    && a !== 0x2002 && !(a === 0x3fff && b <= 0xfff);
}

/** DESTINO-PUBLICO-1 · URLs que configura cada negocio y a las que el servidor manda
 * SUS credenciales (panel de systeme.io con la cookie de sesión, API de MailerFind con
 * su clave): http(s) a un nombre de Internet. Fuera IPs privadas, localhost y nombres
 * de red interna (`*.railway.internal`, `postgres`…), que convertirían el ajuste en una
 * forma de sondear la red del servidor. No resuelve DNS: un nombre público que apunte
 * a una IP privada no se caza aquí (ver downloadPublic para eso). */
export function destinoConfigurablePermitido(raw: string): boolean {
  let url: URL;
  try { url = publicUrl(raw); } catch { return false; }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host)) return true;
  return host.includes(".") && !host.endsWith(".internal") && !host.endsWith(".lan") && !host.endsWith(".home.arpa");
}

/** DESTINO-PUBLICO-2 · Además del nombre, lo que resuelve: `10.0.0.5.nip.io` o un dominio
 * propio con AAAA a la red privada pasaban el filtro por nombre. Todas las direcciones
 * deben ser públicas. No fija la IP en la conexión (fetch no lo admite sin undici): un DNS
 * que cambie de respuesta entre esta consulta y la conexión (rebinding) no se caza aquí. */
export async function destinoConfigurableResuelvePublico(
  raw: string,
  lookup: (host: string) => Promise<LookupAddress[]> = (h) => dns.lookup(h, { all: true, verbatim: true }),
): Promise<boolean> {
  if (!destinoConfigurablePermitido(raw)) return false;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(host)) return true; // la IP literal ya la validó publicUrl
  try {
    const dirs = await lookup(host);
    return dirs.length > 0 && dirs.every((d) => isPublicAddress(String(d.address).replace(/^::ffff:/i, "")));
  } catch { return false; }
}

function publicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new PublicDownloadError("blocked", "Dirección no válida."); }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (raw.length > 8192 || !["http:", "https:"].includes(url.protocol) || url.username || url.password
      || !host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
      || (isIP(host) && !isPublicAddress(host))) {
    throw new PublicDownloadError("blocked", "La dirección debe ser pública.");
  }
  url.hash = "";
  return url;
}

export interface PublicDownload {
  ok: boolean;
  status: number;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export async function downloadPublic(raw: string, options: {
  maxBytes: number;
  timeoutMs?: number;
  /** Leer solo una cabecera/HTML parcial y cerrar al llegar al límite. */
  truncate?: boolean;
  range?: string;
  /** Cabeceras del servicio. Host y cabeceras de transporte no se pueden reemplazar. */
  headers?: Readonly<Record<string, string>>;
  /** false devuelve la primera redirección sin seguirla. Nunca se siguen con credenciales. */
  followRedirects?: boolean;
  /** DESTINO-SSRF-2 · GET por defecto. HEAD para preguntar el tipo; POST con `body` para
   * APIs que configura el negocio (la IP queda fijada igual que en una descarga). */
  method?: "GET" | "HEAD" | "POST";
  body?: string | Buffer;
}): Promise<PublicDownload> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error("Límite de descarga no válido.");
  const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (compatible; business-stack-og/1.0)", "accept-encoding": "identity", ...(options.range ? { range: options.range } : {}) };
  let privadas = false;
  for (const [nombre, valor] of Object.entries(options.headers || {})) {
    const k = nombre.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(k) || /^(host|connection|content-length|transfer-encoding|upgrade|proxy-authorization|proxy-connection)$/.test(k)
      || typeof valor !== "string" || /[\r\n\u0000]/.test(valor)) throw new PublicDownloadError("blocked", "Cabecera de descarga no permitida.");
    headers[k] = valor;
    // Lista positiva: una clave con un nombre nuevo tampoco viaja a otro destino.
    if (!["accept", "accept-language", "accept-encoding", "user-agent", "range"].includes(k)) privadas = true;
  }
  const method = options.method || "GET";
  if (options.body !== undefined && method !== "POST") throw new Error("Solo POST lleva cuerpo.");
  // Un POST no se repite contra otro destino: la redirección se devuelve tal cual.
  const seguir = options.followRedirects !== false && !privadas && method !== "POST";
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new PublicDownloadError("timeout", "La descarga tardó demasiado.")), options.timeoutMs ?? 6000);
  const redirectCodes = new Set([301, 302, 303, 307, 308]);
  try {
    let url = publicUrl(raw);
    if (privadas && url.protocol !== "https:") throw new PublicDownloadError("blocked", "Las conexiones con credenciales requieren HTTPS.");
    for (let hop = 0; hop <= 4; hop++) {
      abort.signal.throwIfAborted();
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const directFamily = isIP(host);
      // Incluye DNS en el mismo plazo total que conexión, redirecciones y cuerpo.
      const addresses = directFamily ? [{ address: host, family: directFamily }] : await new Promise<LookupAddress[]>((resolve, reject) => {
        const stop = () => reject(abort.signal.reason);
        abort.signal.addEventListener("abort", stop, { once: true });
        dns.lookup(host, { all: true, verbatim: true }).then(resolve, reject).finally(() => abort.signal.removeEventListener("abort", stop));
      });
      if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
        throw new PublicDownloadError("blocked", "La dirección debe ser pública.");
      }
      abort.signal.throwIfAborted();
      const pinned = addresses[0];
      const result = await new Promise<PublicDownload>((resolve, reject) => {
        // El hostname original se conserva para Host, SNI y comprobación TLS.
        const lookup: LookupFunction = (_host, opts, callback) => {
          if (opts.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        };
        const request = (url.protocol === "https:" ? https : http).request(url, {
          method, agent: false, lookup, signal: abort.signal,
          ...(url.protocol === "https:" && !directFamily ? { servername: host } : {}),
          headers,
        }, (response) => {
          const status = response.statusCode || 0;
          const done = (body: Buffer) => resolve({ ok: status >= 200 && status < 300, status, url: url.href, headers: response.headers, body });
          response.on("error", reject);
          if (redirectCodes.has(status) || status < 200 || status >= 300) {
            done(Buffer.alloc(0));
            response.destroy();
            return;
          }
          const declared = Number(response.headers["content-length"] || 0);
          if (!options.truncate && method !== "HEAD" && declared > options.maxBytes) {
            reject(new PublicDownloadError("too_large", "La descarga supera el tamaño permitido."));
            response.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            if (size + chunk.length > options.maxBytes) {
              if (options.truncate) {
                chunks.push(chunk.subarray(0, options.maxBytes - size));
                done(Buffer.concat(chunks, options.maxBytes));
              } else reject(new PublicDownloadError("too_large", "La descarga supera el tamaño permitido."));
              response.destroy();
              return;
            }
            size += chunk.length;
            chunks.push(chunk);
          });
          response.on("end", () => done(Buffer.concat(chunks, size)));
        });
        request.on("error", reject);
        request.end(options.body);
      });
      if (!seguir || !redirectCodes.has(result.status) || !result.headers.location) return result;
      url = publicUrl(new URL(result.headers.location, url).href);
    }
    throw new PublicDownloadError("redirects", "La descarga tiene demasiadas redirecciones.");
  } finally {
    clearTimeout(timer);
  }
}
