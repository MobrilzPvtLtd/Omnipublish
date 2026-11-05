/**
 * Multi-tenant: AsyncLocalStorage del workspace activo.
 *
 * Generaliza el patrón que ya usaban whatsapp.ts (waALS) e instagram.ts
 * (acctALS): un store por petición que indica QUÉ workspace estamos
 * sirviendo. Los handlers HTTP que ya están "ws-aware" envuelven su
 * trabajo en `runWithWorkspace(req.workspaceId, ...)` y cualquier
 * código aguas abajo lee el id activo con `currentWorkspaceId()`.
 *
 * REGRESIÓN ZERO: si nadie abrió un scope, `currentWorkspaceId()`
 * devuelve 'default' (el workspace original seeded en W1). Así, los
 * handlers que aún no se hayan refactorizado siguen viendo el mismo
 * comportamiento single-tenant de siempre.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { dbGetWorkspace, dbListWorkspaces, type Workspace } from "./db.js";

/** Identidad mínima del workspace que viaja por el ALS (no carga toda la fila). */
export interface WorkspaceContext {
  id: string;
  label?: string;
}

export const wsALS = new AsyncLocalStorage<WorkspaceContext>();

/** Workspace original (single-tenant retro-compatible). Coincide con el seed de W1. */
export const DEFAULT_WORKSPACE_ID = "default";

/**
 * id del workspace activo en este scope, o 'default' si nadie abrió scope.
 * Fail-safe transparente: ningún call-site queda sin tenant.
 */
export function currentWorkspaceId(): string {
  const store = wsALS.getStore();
  if (store && store.id) return store.id;
  return DEFAULT_WORKSPACE_ID;
}

/** Workspace activo entero, o null si no hay scope abierto (no asume 'default'). */
export function currentWorkspace(): WorkspaceContext | null {
  return wsALS.getStore() ?? null;
}

/**
 * Abre un scope ALS con el workspace dado y ejecuta fn dentro.
 * Fail-safe: si wsId viene vacío/null cae a 'default' (no rompe la request).
 * Devuelve lo que devuelva fn.
 */
export async function runWithWorkspace<T>(
  wsId: string | null | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  const id = (wsId || "").trim() || DEFAULT_WORKSPACE_ID;
  return wsALS.run({ id }, async () => fn());
}

/**
 * Activa el workspace para el RESTO del async-chain actual sin necesidad de
 * envolver al caller en una función. Pensado para hooks Fastify (guard()/
 * onRequest) que ya forman parte del flujo async de la request: tras llamar
 * a enterWorkspaceScope() los handlers que corren a continuación verán este
 * wsId al hacer currentWorkspaceId().
 *
 * Importante: usa AsyncLocalStorage.enterWith — establece el store en el
 * ALS para ESTE async resource y todos los que descienden de él. Los demás
 * requests en vuelo no se ven afectados (cada uno tiene su propio scope).
 *
 * Fail-safe: si wsId viene vacío cae a 'default' (regression-free).
 */
export function enterWorkspaceScope(wsId: string | null | undefined): void {
  const id = (wsId || "").trim() || DEFAULT_WORKSPACE_ID;
  wsALS.enterWith({ id });
}

/**
 * Verifica que un workspace existe y no está archivado. Tira si no.
 * 'default' está siempre vivo (seed de W1) — bypass directo sin tocar BD.
 */
export async function assertWorkspaceExists(wsId: string): Promise<void> {
  if (!wsId) throw new Error("workspace.id requerido");
  if (wsId === DEFAULT_WORKSPACE_ID) return;
  const ws = await dbGetWorkspace(wsId);
  if (!ws) throw new Error(`workspace no encontrado: ${wsId}`);
  if (ws.archived) throw new Error(`workspace archivado: ${wsId}`);
}

// ---- Cache de listado (60s) ----
// Listar workspaces se hace en cada render del selector del panel: la cache
// evita pegarle a Postgres en cada navegación. TTL corto porque crear/archivar
// es raro y siempre llamamos a invalidateWorkspaceListCache() después.
const LIST_CACHE_TTL_MS = 60_000;
let listCache: { at: number; data: Workspace[] } | null = null;
let listAllCache: { at: number; data: Workspace[] } | null = null;

/** Lista de workspaces activos (no archivados), cacheada 60s. */
export async function listWorkspacesCached(): Promise<Workspace[]> {
  const now = Date.now();
  if (listCache && now - listCache.at < LIST_CACHE_TTL_MS) return listCache.data;
  const data = await dbListWorkspaces(false);
  listCache = { at: now, data };
  return data;
}

/**
 * WS-ARCHIVED-ROUTING 2026-08-07 · lista TODOS los workspaces, archivados
 * incluidos, cacheada 60s. Es el censo que necesita el registro canal→workspace:
 * un canal de un workspace archivado tiene que seguir RESOLVIENDO (a "suspendido"),
 * porque si desaparece del censo su webhook cae al tenant 'default' del owner
 * → contaminación cruzada. NO usar para loops de scheduler/automatizaciones:
 * ésos quieren solo activos (listWorkspacesCached).
 */
export async function listWorkspacesForRoutingCached(): Promise<Workspace[]> {
  const now = Date.now();
  if (listAllCache && now - listAllCache.at < LIST_CACHE_TTL_MS) return listAllCache.data;
  const data = await dbListWorkspaces(true);
  listAllCache = { at: now, data };
  return data;
}

/** Vacía la cache. Llamar tras crear/archivar/renombrar workspaces. */
export function invalidateWorkspaceListCache(): void {
  listCache = null;
  listAllCache = null;
}
