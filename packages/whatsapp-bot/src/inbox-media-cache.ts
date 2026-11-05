import { randomUUID } from "node:crypto";

type Adjunto = { buf: Buffer; mime: string; ts: number; ws: string };
// No se expulsan adjuntos vigentes: Meta puede estar descargando sus URL.
// Un único temporizador libera los caducados aunque no llegue ninguna petición más.
export function crearAlmacenAdjuntos(opciones: { ttlMs?: number; maxBytes?: number; maxBytesWs?: number; maxEntradas?: number; maxEntradasWs?: number } = {}) {
  const ttl = opciones.ttlMs ?? 600_000;
  const maxBytes = opciones.maxBytes ?? 128 * 1024 * 1024;
  const maxBytesWs = opciones.maxBytesWs ?? 64 * 1024 * 1024;
  const maxEntradas = opciones.maxEntradas ?? 128;
  const maxEntradasWs = opciones.maxEntradasWs ?? 32;
  const datos = new Map<string, Adjunto>();
  const usos = new Map<string, { bytes: number; entradas: number }>();
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function purgar() {
    const ahora = Date.now();
    for (const [id, e] of datos) {
      if (ahora - e.ts < ttl) continue;
      datos.delete(id); bytes -= e.buf.length;
      const u = usos.get(e.ws)!; u.bytes -= e.buf.length; u.entradas--;
      if (!u.entradas) usos.delete(e.ws);
    }
  }
  function programar() {
    if (timer || !datos.size) return;
    const primero = datos.values().next().value as Adjunto;
    timer = setTimeout(() => { timer = undefined; purgar(); programar(); }, Math.max(1, primero.ts + ttl - Date.now()));
    timer.unref();
  }
  function guardar(buf: Buffer, mime: string, ws: string): string {
    purgar();
    const u = usos.get(ws) || { bytes: 0, entradas: 0 };
    if (bytes + buf.length > maxBytes || u.bytes + buf.length > maxBytesWs || datos.size >= maxEntradas || u.entradas >= maxEntradasWs) {
      throw new Error("Hay demasiados adjuntos pendientes de descarga. Espera unos minutos antes de volver a enviarlo.");
    }
    // Meta descarga sin sesión: el UUID v4 impredecible protege la URL pública.
    const id = randomUUID();
    datos.set(id, { buf, mime, ts: Date.now(), ws }); bytes += buf.length;
    u.bytes += buf.length; u.entradas++; usos.set(ws, u); programar();
    return id;
  }
  function obtener(id: string): Adjunto | undefined { purgar(); return datos.get(id); }
  return { guardar, obtener };
}
