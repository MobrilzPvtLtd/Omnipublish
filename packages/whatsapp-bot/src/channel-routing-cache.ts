/**
 * Cache compartida del routing de canales (W6).
 *
 * Aislado en un módulo sin dependencias para evitar el ciclo
 *   settings.ts → channel-routing.ts → settings.ts.
 * settings.ts solo necesita invalidateChannelRoutingCache() (lo llama al
 * mutar keys 'whatsapp.*'/'meta.*'). El resolver vive en channel-routing.ts
 * y consume estos primitivos.
 */
/**
 * Estado del registro canal→workspace:
 *   active       → el canal pertenece a un workspace vivo (wsId real).
 *   suspended    → pertenece a un workspace ARCHIVADO. wsId es el sumidero,
 *                  nunca un tenant real: se responde 2xx y no se procesa.
 *   unconfigured → el canal no está dado de alta en ningún workspace; solo
 *                  ESTE caso puede caer al 'default' (compat single-tenant).
 */
export type ChannelRouteStatus = "active" | "suspended" | "unconfigured";

export const channelRoutingCache = new Map<
  string,
  { wsId: string; ts: number; status?: ChannelRouteStatus }
>();

/** PASARELA-META-2 · quién quiere enterarse de que han cambiado los canales. */
const oyentesRutas: Array<() => void> = [];

/**
 * Vacía toda la cache de routing. Llamar tras cualquier mutación de
 * keys con prefijo `whatsapp.` o `meta.` per-WS. Operación O(1) sobre el
 * Map: barato hacerlo en cada set de setting (la mayoría serán keys
 * no-routing y el clear es trivial; las que SÍ afectan routing reconcilian
 * con el siguiente webhook entrante).
 */
export function invalidateChannelRoutingCache(): void {
  channelRoutingCache.clear();
  // PASARELA-META-2 · avisar a quien depende de los canales (la declaración a la
  // pasarela). Un oyente que falle nunca rompe el guardado que lo disparó.
  for (const fn of oyentesRutas) {
    try { fn(); } catch { /* el aviso es best-effort */ }
  }
}

/**
 * PASARELA-META-2 · Registra una función que se llama cada vez que cambian los canales
 * (mismo disparo que invalidateChannelRoutingCache). Vive aquí, sin dependencias, por la
 * misma razón que la cache: settings.ts no puede importar a quien lo importa a él.
 */
export function alInvalidarRutas(fn: () => void): void {
  oyentesRutas.push(fn);
}
