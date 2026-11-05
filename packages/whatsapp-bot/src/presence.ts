/**
 * PRESENCIA · quién está MIRANDO el panel ahora mismo.
 *
 * ── El problema ──────────────────────────────────────────────────────────
 * Los pre-warm de fondo (analytics cada 2 min, métricas systeme.io cada
 * 4 min) se ejecutaban 24/7 aunque no hubiera un alma delante del panel.
 * A las 4 de la madrugada de un domingo seguían calentando cachés que
 * nadie iba a leer. Eso costaba tres cosas distintas:
 *
 *   1. Cuota de la Graph API de Meta y carga de Postgres, gratis para nadie.
 *   2. RAM del propio panel, que nunca bajaba de la marca de agua.
 *   3. Sobre todo: mantenía DESPIERTO a systemeio-mcp en Railway las 24 h.
 *      Cada ronda del warm abría sesión Playwright contra él, así que su
 *      Chromium jamás se cerraba y su TTL de sesión jamás vencía. Ese
 *      servicio. Medido el 2026-09-08 con la API de Railway: 521 sesiones
 *      MCP vivas allí, unos 2 MB de RSS cada una, ~1 GB de los 1,82 GB que
 *      factura. Es su mayor sumidero, muy por encima de Chromium.
 *
 * ── El modelo ────────────────────────────────────────────────────────────
 * El navegador late (POST /admin/api/presence) SOLO mientras la pestaña
 * está visible: `document.hidden` corta el latido, igual que ya hacían
 * refreshNavCounts() y verCheck(). El servidor apunta el último latido por
 * workspace. Un warmer solo trabaja para los workspaces con latido reciente.
 *
 * Nadie mirando ⇒ nadie calienta. Y en cuanto alguien abre el panel, su
 * primer latido dispara un calentamiento inmediato de SU workspace, así que
 * los datos están listos para cuando termine de navegar hasta el Dashboard.
 * El calor sigue a la persona en vez de quemarse en el vacío.
 *
 * ── Fail-safe ────────────────────────────────────────────────────────────
 * Que sin latidos no se caliente nada NO es una degradación: es exactamente
 * el objetivo. Por eso el fallback no es "ante la duda, calienta".
 * Escotillas de salida sin revertir código, ambas por variable de entorno:
 *
 *   WARM_ALWAYS=1       → vuelve a la conducta anterior (calienta siempre).
 *   PRESENCE_TTL_MS=... → margen de gracia tras el último latido (def. 3 min).
 *
 * Ojo con lo que NO se controla desde aquí: el worker de trabajos del bridge
 * MCP y el snapshot diario de snapshots.ts NO son pre-warm de interfaz, son
 * trabajo de negocio real. Siguen corriendo haya o no haya nadie mirando.
 */

/** Margen tras el último latido durante el que seguimos considerando "hay alguien". */
export const PRESENCE_TTL_MS = Math.max(
  30_000,
  Number(process.env.PRESENCE_TTL_MS || 3 * 60_000) || 3 * 60_000,
);

/** Escotilla: restaura el comportamiento anterior (calentar siempre) sin tocar código. */
export const WARM_ALWAYS = process.env.WARM_ALWAYS === "1";

/**
 * Tras un calentamiento por llegada, no volvemos a disparar otro para el mismo
 * workspace durante este tiempo. Sin esto, cinco pestañas abiertas a la vez
 * (o un F5 nervioso) lanzarían cinco cadenas de warm simultáneas.
 */
const ARRIVAL_COOLDOWN_MS = 60_000;

/** Tope de entradas. Los workspaces son pocos; esto solo evita crecer sin fin. */
const MAX_ENTRIES = 500;

/** wsId → epoch ms del último latido recibido. */
const lastSeen = new Map<string, number>();
/** wsId → epoch ms del último warm disparado por llegada. */
const lastArrivalWarm = new Map<string, number>();

/** Quita entradas caducadas hace mucho para que los Maps no crezcan sin límite. */
function prune(now: number): void {
  if (lastSeen.size < MAX_ENTRIES) return;
  const cutoff = now - Math.max(PRESENCE_TTL_MS * 10, 60 * 60_000);
  for (const [k, ts] of lastSeen) if (ts < cutoff) lastSeen.delete(k);
  for (const [k, ts] of lastArrivalWarm) if (ts < cutoff) lastArrivalWarm.delete(k);
}

/**
 * Registra que alguien está mirando el panel de este workspace.
 *
 * Devuelve `arrived: true` cuando es una transición de frío a caliente, es
 * decir: no había nadie mirando y ahora sí. El llamante usa esa señal para
 * disparar un calentamiento inmediato. El cooldown evita ráfagas.
 */
export function notePresence(wsId: string): { arrived: boolean } {
  const id = (wsId || "").trim() || "default";
  const now = Date.now();
  const prev = lastSeen.get(id) || 0;
  const wasWatched = now - prev < PRESENCE_TTL_MS;
  lastSeen.set(id, now);
  prune(now);

  if (wasWatched) return { arrived: false };

  const lastWarm = lastArrivalWarm.get(id) || 0;
  if (now - lastWarm < ARRIVAL_COOLDOWN_MS) return { arrived: false };
  lastArrivalWarm.set(id, now);
  return { arrived: true };
}

/** ¿Hay alguien mirando este workspace ahora mismo? */
export function isWatched(wsId: string): boolean {
  if (WARM_ALWAYS) return true;
  const id = (wsId || "").trim() || "default";
  const ts = lastSeen.get(id);
  return !!ts && Date.now() - ts < PRESENCE_TTL_MS;
}

/** Filtra una lista de workspaces dejando solo los que tienen a alguien delante. */
export function watchedWorkspaces<T extends { id: string }>(all: T[]): T[] {
  if (WARM_ALWAYS) return all;
  return all.filter((w) => isWatched(w.id));
}

/** ¿Hay alguien mirando CUALQUIER workspace? Atajo para saltar rondas enteras. */
export function anyoneWatching(): boolean {
  if (WARM_ALWAYS) return true;
  const now = Date.now();
  for (const ts of lastSeen.values()) if (now - ts < PRESENCE_TTL_MS) return true;
  return false;
}

/** Foto del estado para /health y para depurar por qué algo no se calienta. */
export function presenceStats(): {
  warmAlways: boolean;
  ttlMs: number;
  watching: string[];
  tracked: number;
} {
  const now = Date.now();
  const watching: string[] = [];
  for (const [id, ts] of lastSeen) if (now - ts < PRESENCE_TTL_MS) watching.push(id);
  return { warmAlways: WARM_ALWAYS, ttlMs: PRESENCE_TTL_MS, watching, tracked: lastSeen.size };
}

/** Solo para tests: vacía el registro. */
export function __resetPresence(): void {
  lastSeen.clear();
  lastArrivalWarm.clear();
}
