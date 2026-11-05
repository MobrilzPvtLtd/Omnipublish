import Negotiator from "negotiator";
import { promisify } from "node:util";
import { brotliCompress, constants, deflate, gzip } from "node:zlib";
import type { FastifyReply, FastifyRequest } from "fastify";

const br = promisify(brotliCompress);
const gz = promisify(gzip);
const df = promisify(deflate);
type Codificacion = "br" | "gzip" | "deflate" | "identity";

// Una instancia por archivo estático del build, nunca por URL, usuario o negocio.
// Como máximo tres buffers y una promesa compartida por compresión en curso.
// ASSET-BR-9 · el brotli se calcula UNA vez por proceso, así que compensa calidad 9 en vez
// de 4 (medido sobre el JS del panel, 3,9 MB: 1,16 MB → 1,02 MB; 0,6 s en el threadpool,
// sin bloquear el event loop). Se calienta al crear la instancia para que el primer usuario
// tras un despliegue no espere. gzip y deflate siguen bajo demanda.
export function assetComprimido(contenido: string, calidadBr = 9) {
  const pendientes = new Map<Codificacion, Promise<Buffer>>();
  const opcionesBr = { params: {
    [constants.BROTLI_PARAM_QUALITY]: calidadBr,
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
  } };
  const calentar = br(contenido, opcionesBr);
  pendientes.set("br", calentar);
  calentar.catch(() => pendientes.delete("br"));
  const enviar = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Vary", "Accept-Encoding");
    const cabecera = req.headers["accept-encoding"];
    if (req.headers["x-no-compression"] !== undefined || !cabecera) return reply.send(contenido);
    const formato = new Negotiator({ headers: {
      "accept-encoding": cabecera.toLowerCase().replace(/\bx-gzip\b/g, "gzip"),
    } }).encoding(["br", "gzip", "deflate", "identity"]) as Codificacion | undefined;
    if (!formato) return reply.code(406).send();
    if (formato === "identity") return reply.send(contenido);
    let pendiente = pendientes.get(formato);
    if (!pendiente) {
      pendiente = formato === "br"
        ? br(contenido, opcionesBr)
        : formato === "gzip" ? gz(contenido) : df(contenido);
      pendientes.set(formato, pendiente);
      // Permitir reintentar si falla zlib, sin retener una promesa rechazada.
      pendiente.catch(() => pendientes.delete(formato));
    }
    const comprimido = await pendiente;
    return reply.header("Content-Encoding", formato).send(comprimido);
  };
  // PANEL-MINIFY-1 · se resuelve cuando el brotli de calentamiento ha terminado (bien o mal),
  // para poder cambiar lo servido sin que el primer usuario espere a una compresión lenta.
  return Object.assign(enviar, { listo: calentar.then(() => undefined, () => undefined) });
}
