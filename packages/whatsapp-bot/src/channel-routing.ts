/**
 * Multi-tenant W6: routing de webhooks entrantes → workspace.
 *
 * Los webhooks de Meta (WhatsApp/Instagram/Facebook) no llevan ninguna
 * señal del workspace destinatario: solo el channelId (phone_number_id,
 * ig business id, page id). Para servir a varios workspaces con la MISMA
 * Meta App (estilo ManyChat), tenemos que mapear ese channelId → wsId
 * mirando las settings per-WS que el operador configuró:
 *
 *   wa  : whatsapp.phoneNumberId (principal) + array whatsapp.numbers
 *   ig  : meta.igBusinessId (principal)      + array meta.accounts
 *   fb  : array meta.fbAccounts (no hay "principal" — todos en array)
 *
 * Estrategia:
 *   1. Cache 5 min Map<'{channel}:{channelId}', {wsId, ts}>. Anti-stampede:
 *      cuando una réplica reinicia, cada webhook entrante pega a BD una
 *      vez por (channel, channelId) y luego sirve desde RAM.
 *   2. Miss → iterar el censo de workspaces (activos Y archivados), leer
 *      settings per-WS y matchear. Gana el primer ACTIVO (created_at ASC);
 *      un archivado solo se usa si ningún activo reclama ese canal.
 *   3. Sin match en ningún workspace → 'default' (regresión zero) + warn
 *      para que el operador lo detecte si dejó el canal a medio conectar.
 *   4. setWorkspaceSetting() llama invalidateChannelRoutingCache() para
 *      keys 'whatsapp.*'/'meta.*' → next webhook reconcilia inmediato.
 *
 * WS-ARCHIVED-ROUTING 2026-08-07 · el registro tiene ESTADO.
 * Antes el censo eran los workspaces ACTIVOS: al archivar un workspace sus
 * canales dejaban de matchear y su webhook entrante se procesaba en el tenant
 * 'default' del owner (contaminación cruzada, respuestas con credenciales de
 * otro negocio). "Archivar" no es "ocultar". Ahora el censo incluye los
 * archivados y cada canal resuelve a uno de tres estados:
 *   active       → wsId real, se procesa como siempre.
 *   suspended    → el canal pertenece a un workspace archivado: SUMIDERO
 *                  (SUSPENDED_ROUTE_ID). El caller responde 2xx y descarta.
 *                  Jamás cae a 'default'.
 *   unconfigured → el canal no está dado de alta en ningún workspace. Único
 *                  caso que usa 'default' (compat single-tenant).
 */
import {
  DEFAULT_WORKSPACE_ID,
  listWorkspacesForRoutingCached,
} from "./workspace.js";
import { getWorkspaceSetting } from "./settings.js";
import {
  channelRoutingCache as cache,
  invalidateChannelRoutingCache,
  type ChannelRouteStatus,
} from "./channel-routing-cache.js";

export { invalidateChannelRoutingCache };

/**
 * ROUTING-STRICT-1 · Modo estricto para la instancia que recibe por la Meta App.
 *
 * La lleva SOLO la instancia central (la que figura en el App Dashboard y, por
 * tanto, recibe lo de todo el mundo mientras un cliente no tenga su redirección
 * puesta). Las instancias de cliente la dejan SIN DEFINIR: ahí el fallback a
 * 'default' es correcto, porque 'default' ES el negocio del cliente.
 *
 * Se activa con ROUTING_STRICT=1. Cualquier otro valor (o ausencia) = apagado,
 * comportamiento de siempre.
 */
const ROUTING_STRICT = process.env.ROUTING_STRICT === "1";
export type { ChannelRouteStatus };

export type RoutingChannel = "wa" | "ig" | "fb";

/**
 * Sumidero: id reservado que NO es ningún tenant. Cuando resolveWorkspaceByChannel
 * lo devuelve, el webhook debe contestarse 2xx y descartarse sin procesar.
 * Nunca abrir un scope de workspace con él.
 */
export const SUSPENDED_ROUTE_ID = "__suspended__";

/** ¿El id devuelto por el router es el sumidero (workspace archivado)? */
export function isSuspendedRoute(wsId: string): boolean {
  return wsId === SUSPENDED_ROUTE_ID;
}

export interface ChannelRoute {
  wsId: string;
  status: ChannelRouteStatus;
}

const CACHE_TTL_MS = 5 * 60_000;

/**
 * Registro canal→workspace con estado. Cache 5min (invalidada al tocar
 * settings 'whatsapp.*'/'meta.*' y al archivar/desarchivar workspaces).
 */
export async function resolveChannelRoute(
  channel: RoutingChannel,
  channelId: string,
): Promise<ChannelRoute> {
  const cid = (channelId || "").trim();
  // Webhook sin channelId: no hay canal que buscar → único caso de "jamás
  // configurado" que no depende de la BD.
  if (!cid) return { wsId: DEFAULT_WORKSPACE_ID, status: "unconfigured" };
  const cacheKey = `${channel}:${cid}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.ts < CACHE_TTL_MS) {
    if (hit.wsId === SUSPENDED_ROUTE_ID) {
      return { wsId: SUSPENDED_ROUTE_ID, status: "suspended" };
    }
    return {
      wsId: hit.wsId,
      status: hit.status ?? (hit.wsId === DEFAULT_WORKSPACE_ID ? "unconfigured" : "active"),
    };
  }

  let resolved: ChannelRoute | null = null;
  let lookupFailed = false;
  try {
    // Censo COMPLETO (incluye archivados). Un workspace vivo siempre gana al
    // archivado: si el operador movió el número a otro negocio, el tráfico va
    // al nuevo y no al sumidero del viejo.
    const wss = await listWorkspacesForRoutingCached();
    let archivedHit = "";
    const activeHits: string[] = [];
    for (const ws of wss) {
      if (!matchesChannel(ws.id, channel, cid)) continue;
      if (ws.archived) {
        if (!archivedHit) archivedHit = ws.id;
        continue;
      }
      activeHits.push(ws.id);
    }
    if (activeHits.length === 1) {
      resolved = { wsId: activeHits[0], status: "active" };
    } else if (activeHits.length > 1) {
      // CHANNEL-CLAIM-CONFLICT (T05 2026-08-25) · DOS workspaces ACTIVOS
      // reclaman el mismo canal. Antes ganaba el primero del censo
      // (created_at ASC): un tenant que apuntara en sus settings el
      // phone_number_id/igId/pageId de OTRO podía quedarse con sus mensajes
      // entrantes si su workspace era más antiguo. Un canal en disputa no se
      // entrega a nadie: sumidero (2xx sin procesar) + error en logs hasta que
      // el operador retire la configuración duplicada. Seguridad antes que
      // disponibilidad: el sumidero no filtra datos; la entrega al primero, sí.
      console.error(
        `[channel-routing] CONFLICTO ${channel}:${cid} reclamado por ${activeHits.length} workspaces ACTIVOS (${activeHits.join(", ")}) → sumidero hasta resolverlo (retira el canal duplicado en Conexiones).`,
      );
      resolved = { wsId: SUSPENDED_ROUTE_ID, status: "suspended" };
    }
    if (!resolved && archivedHit) {
      console.warn(
        `[channel-routing] ${channel}:${cid} pertenece al workspace ARCHIVADO ${archivedHit} → sumidero (2xx sin procesar). No cae a 'default'.`,
      );
      resolved = { wsId: SUSPENDED_ROUTE_ID, status: "suspended" };
    }
  } catch (e) {
    lookupFailed = true;
    console.warn(
      `[channel-routing] lookup ${channel}:${cid} falló (${(e as Error).message})`,
    );
  }

  if (!resolved && lookupFailed) {
    // Sin censo no podemos distinguir "sin configurar" de "suspendido", así que
    // NO damos por bueno 'default' salvo que el propio 'default' tenga ese canal
    // configurado (settings viven en cache de proceso, no dependen de la BD).
    // No cacheamos: el fallo es transitorio y el siguiente webhook reintenta.
    if (matchesChannel(DEFAULT_WORKSPACE_ID, channel, cid)) {
      return { wsId: DEFAULT_WORKSPACE_ID, status: "active" };
    }
    console.warn(
      `[channel-routing] ${channel}:${cid} sin censo y no es del 'default' → sumidero temporal (2xx sin procesar).`,
    );
    return { wsId: SUSPENDED_ROUTE_ID, status: "suspended" };
  }

  if (!resolved) {
    // ROUTING-STRICT-1 · Un canal que no está en NINGÚN workspace cae a 'default'
    // por compatibilidad con el despliegue single-tenant de siempre. Pero cuando la
    // Meta App sirve a instancias de clientes, ese fallback es una fuga: los mensajes
    // de un cliente cuya redirección de webhooks aún no está puesta llegan a la
    // instancia central, se procesan bajo su 'default' y el bot del owner contesta
    // desde SU número al cliente de otro. Con ROUTING_STRICT=1 (solo lo lleva la
    // central) esos eventos van al sumidero: 2xx a Meta y nada más.
    if (ROUTING_STRICT) {
      console.warn(
        `[channel-routing] ${channel}:${cid} no está configurado en ningún workspace y ROUTING_STRICT=1 → sumidero (2xx sin procesar).`,
      );
      resolved = { wsId: SUSPENDED_ROUTE_ID, status: "suspended" };
    } else {
      console.warn(
        `[channel-routing] ${channel}:${cid} no está configurado en ningún workspace → default (canal jamás configurado)`,
      );
      resolved = { wsId: DEFAULT_WORKSPACE_ID, status: "unconfigured" };
    }
  }
  cache.set(cacheKey, { wsId: resolved.wsId, ts: now, status: resolved.status });
  return resolved;
}

/**
 * Resuelve el workspace al que pertenece un canal Meta entrante.
 * Devuelve SUSPENDED_ROUTE_ID si el canal es de un workspace archivado: el
 * caller DEBE comprobarlo con isSuspendedRoute() y descartar el evento
 * (responder 2xx) en vez de abrir scope. 'default' solo para canales que
 * no están dados de alta en ningún workspace.
 */
export async function resolveWorkspaceByChannel(
  channel: RoutingChannel,
  channelId: string,
): Promise<string> {
  const r = await resolveChannelRoute(channel, channelId);
  return r.wsId;
}

// invalidateChannelRoutingCache se re-exporta desde channel-routing-cache.ts
// (módulo sin deps) para que settings.ts pueda invocarla sin ciclo.

// ───────────────────────────────────────────────────────────────────────
// Internals
// ───────────────────────────────────────────────────────────────────────

function matchesChannel(wsId: string, channel: RoutingChannel, cid: string): boolean {
  switch (channel) {
    case "wa": return matchesWa(wsId, cid);
    case "ig": return matchesIg(wsId, cid);
    case "fb": return matchesFb(wsId, cid);
  }
}

function matchesWa(wsId: string, phoneNumberId: string): boolean {
  // 1) Número principal del WS
  const main = getWorkspaceSetting(wsId, "whatsapp.phoneNumberId");
  if (main && main === phoneNumberId) return true;
  // 2) Array de números extra (whatsapp.numbers, JSON cifrado en BD pero
  //    settings.ts lo devuelve ya descifrado en plano).
  const arr = parseJsonArray(getWorkspaceSetting(wsId, "whatsapp.numbers"));
  for (const n of arr) {
    if (n && typeof n === "object" && String((n as any).phoneNumberId || "") === phoneNumberId) {
      return true;
    }
  }
  return false;
}

function matchesIg(wsId: string, igBusinessId: string): boolean {
  // 1) Cuenta principal del WS
  const main = getWorkspaceSetting(wsId, "meta.igBusinessId");
  if (main && main === igBusinessId) return true;
  // 2) Array meta.accounts (extras IG)
  const arr = parseJsonArray(getWorkspaceSetting(wsId, "meta.accounts"));
  for (const a of arr) {
    if (a && typeof a === "object" && String((a as any).igId || "") === igBusinessId) {
      return true;
    }
  }
  return false;
}

function matchesFb(wsId: string, pageOrIgBusinessId: string): boolean {
  // Facebook: el array meta.fbAccounts es la única fuente (no hay "principal").
  // Cada entry tiene pageId + opcionalmente igBusinessAccountId. Matcheamos
  // por cualquiera de los dos: el webhook Facebook trae el pageId en entry.id,
  // pero algunos handlers ya hacen routing por el ig business asociado.
  const arr = parseJsonArray(getWorkspaceSetting(wsId, "meta.fbAccounts"));
  for (const a of arr) {
    if (!a || typeof a !== "object") continue;
    const pageId = String((a as any).pageId || "");
    const igBA = String((a as any).igBusinessAccountId || "");
    if (pageId && pageId === pageOrIgBusinessId) return true;
    if (igBA && igBA === pageOrIgBusinessId) return true;
  }
  return false;
}

function parseJsonArray(raw: string): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * PASARELA-META-1 · Los canales de Meta de esta instancia, en el formato de la pasarela:
 * `wa:<número>`, `waba:<cuenta>`, `ig:<cuenta de IG>`, `page:<Página>`. Sólo de los
 * workspaces activos: lo archivado no debe seguir reclamando mensajes.
 */
export async function canalesParaPasarela(): Promise<string[]> {
  const out = new Set<string>();
  const add = (pref: string, v: unknown) => { const s = String(v ?? "").trim(); if (/^\d{3,25}$/.test(s)) out.add(`${pref}:${s}`); };
  for (const ws of await listWorkspacesForRoutingCached()) {
    if (ws.archived) continue;
    const g = (k: string) => getWorkspaceSetting(ws.id, k);
    add("wa", g("whatsapp.phoneNumberId"));
    add("waba", g("whatsapp.wabaId"));
    for (const n of parseJsonArray(g("whatsapp.numbers")) as any[]) { add("wa", n?.phoneNumberId); add("waba", n?.wabaId); }
    add("ig", g("meta.igBusinessId"));
    for (const a of parseJsonArray(g("meta.accounts")) as any[]) add("ig", a?.igId);
    for (const a of parseJsonArray(g("meta.fbAccounts")) as any[]) { add("page", a?.pageId); add("ig", a?.igBusinessAccountId); }
  }
  return [...out].sort();
}
