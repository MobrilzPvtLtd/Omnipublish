// Caché de consultas de métricas: memoria y trabajo concurrente acotados.
export function crearCacheSegmentos(ttlMs = 180_000, maxEntradas = 256, maxPendientes = 64) {
  const cache = new Map<string, { data: unknown; ts: number }>();
  const pendientes = new Map<string, Promise<unknown>>();
  let activos = 0;
  const purgar = () => {
    const ahora = Date.now();
    for (const [key, valor] of cache) if (ahora - valor.ts >= ttlMs) cache.delete(key);
  };
  async function leer<T>(key: string, fn: () => Promise<T>): Promise<T> {
    purgar();
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit.data as T; }
    const anterior = pendientes.get(key);
    if (anterior) return anterior as Promise<T>;
    if (activos >= maxPendientes) throw new Error("Hay demasiadas consultas de métricas en curso. Inténtalo de nuevo en un momento.");
    activos++;
    const p = Promise.resolve().then(fn).then((data) => {
      // Invalidar permite una consulta nueva, pero la anterior no puede repoblar.
      if (pendientes.get(key) === p) {
        purgar(); cache.delete(key); cache.set(key, { data, ts: Date.now() });
        while (cache.size > maxEntradas) cache.delete(cache.keys().next().value as string);
      }
      return data;
    }).finally(() => {
      activos--;
      if (pendientes.get(key) === p) pendientes.delete(key);
    });
    pendientes.set(key, p);
    return p;
  }
  function invalidar(prefix: string): number {
    let n = 0;
    for (const key of cache.keys()) if (key.startsWith(prefix)) { cache.delete(key); n++; }
    for (const key of pendientes.keys()) if (key.startsWith(prefix)) pendientes.delete(key);
    return n;
  }
  return { leer, invalidar };
}
