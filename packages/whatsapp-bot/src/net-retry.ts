// RED-REINTENTO-1 · «fetch failed» a secas no dice qué pasó (undici esconde el motivo en `cause`) y un
// corte de red puntual tiraba un envío entero (YouTube en un Short, 14 oct): se reintenta lo que es
// transitorio y, si no hay manera, el error nombra el motivo real.

/** Códigos de undici/Node que significan «la conexión no llegó a cerrarse bien»: merece otro intento. */
const TRANSITORIOS = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CLOSED",
]);

function codigoDe(e: unknown): string {
  const c = (e as { cause?: { code?: string; message?: string } })?.cause;
  return String(c?.code || (e as { code?: string })?.code || "");
}

/** El mismo error, pero con el motivo de red a la vista («fetch failed (ECONNRESET)»). */
export function conMotivoDeRed(e: unknown, url?: string | URL): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  const cod = codigoDe(err);
  const det = (err as { cause?: { message?: string } }).cause?.message;
  if (err.message === "fetch failed" && (cod || det)) {
    let host = "";
    try { host = url ? new URL(String(url)).host : ""; } catch { /* sin host */ }
    return new Error(`fetch failed (${[cod, det].filter(Boolean).join(": ").slice(0, 120)}${host ? " · " + host : ""})`, { cause: err });
  }
  return err;
}

/** fetch con hasta `intentos` intentos ante cortes de red transitorios. Un HTTP de error NO se reintenta. */
export async function fetchConReintentos(url: string | URL, init: RequestInit = {}, intentos = 3): Promise<Response> {
  let ultimo: unknown;
  for (let i = 0; i < intentos; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      ultimo = e;
      const transitorio = e instanceof TypeError && (TRANSITORIOS.has(codigoDe(e)) || (e as Error).message === "fetch failed");
      if (!transitorio || i === intentos - 1) break;
      console.warn(`[red] ${String(url).slice(0, 80)} · intento ${i + 1}/${intentos} falló (${codigoDe(e) || (e as Error).message}); se reintenta`);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw conMotivoDeRed(ultimo, url);
}
