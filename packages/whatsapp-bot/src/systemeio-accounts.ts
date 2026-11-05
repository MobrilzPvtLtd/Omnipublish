/**
 * Almacén multi-cuenta de plataformas leadmatch-lab / systeme.io.
 *
 * Hasta ahora todo el sistema asumía UNA sola cuenta conectada (los settings
 * sueltos `systemeio.publicApiKey`, `systemeio.sessionCookie`,
 * `systemeio.sandboxEmail/Pass`, etc.). El user quiere poder enlazar varias
 * webs y elegir el destino en cada feature (sync, page builder, dashboard).
 *
 * Almacenamos un JSON encriptado bajo `systemeio.accounts` (cifrado por estar
 * en SECRET_KEYS) con la lista de cuentas:
 *
 *   [
 *     {
 *       id, label, panelBaseUrl, accountEmail, method,
 *       apiKey?, sessionCookie?, sandboxEmail?, sandboxPass?,
 *       addedAt
 *     }, ...
 *   ]
 *
 * Migración automática: si el JSON está vacío pero hay credenciales viejas
 * en los settings sueltos, las convertimos a una "Cuenta principal" idempotente
 * en la primera lectura. Después borramos los sueltos para no dejar duplicados.
 *
 * Backward compat: los settings viejos siguen leyéndose por mcp-bridge mientras
 * no esté borrado; cuando se borren tras la migración, mcp-bridge usará el
 * account activo (el primero o el que se le pase como accountId).
 */
import crypto from "node:crypto";
import { get as getSetting, set as setSetting } from "./settings.js";

// SIO-LIMPIEZA-1 · desde el 30-oct-2026 solo existe la vía de la clave de la web.
// El correo y la contraseña (sandboxEmail/Pass) se conservan: los usa el puente del
// editor para publicar páginas (la API oficial no admite HTML libre). Las cuentas
// guardadas como "autologin" o "cookie" se leen como "apikey" y su cookie se descarta.
export type SiMethod = "apikey";

export interface SiAccount {
  id: string;
  label: string;
  panelBaseUrl: string;
  accountEmail: string;
  method: SiMethod;
  apiKey?: string;
  mcpKey?: string;
  sandboxEmail?: string;
  sandboxPass?: string;
  addedAt: number;
}

export interface SiAccountPublic {
  id: string;
  label: string;
  panelBaseUrl: string;
  accountEmail: string;
  method: SiMethod;
  hasApiKey: boolean;
  hasMcpKey: boolean;
  hasSandboxPass: boolean;
  addedAt: number;
}

let _migrated = false;

function readRaw(): SiAccount[] {
  try {
    const raw = getSetting("systemeio.accounts");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<SiAccount & { sessionCookie?: string }>).map(({ sessionCookie: _c, ...a }) => ({ ...a, method: "apikey" as const }));
  } catch {
    return [];
  }
}

async function writeRaw(accounts: SiAccount[]): Promise<void> {
  await setSetting("systemeio.accounts", JSON.stringify(accounts));
}

/**
 * Migración idempotente: si hay creds sueltas (de la versión single-account)
 * y `systemeio.accounts` está vacío, crea UNA cuenta "Principal" con ellas.
 * Borra los sueltos para no duplicar. Solo corre 1 vez por proceso.
 */
async function migrateLegacyIfNeeded(current: SiAccount[]): Promise<SiAccount[]> {
  if (_migrated || current.length > 0) {
    _migrated = true;
    return current;
  }
  _migrated = true;
  const legacyKey = getSetting("systemeio.publicApiKey");
  const legacySandboxEmail = getSetting("systemeio.sandboxEmail");
  const legacySandboxPass = getSetting("systemeio.sandboxPass");
  if (!legacyKey && !legacySandboxPass) return [];
  const legacyBaseUrl =
    getSetting("systemeio.panelBaseUrl") || "https://systeme.io";
  const legacyAccountEmail = getSetting("systemeio.accountEmail") || legacySandboxEmail || "";
  const method: SiMethod = "apikey";
  const acc: SiAccount = {
    // SIO-LEADS-TENANT-1 · id COMPLETO. Con 8 hex (32 bits) la probabilidad de que
    // dos negocios distintos acabaran con el mismo id de cuenta era real, y ese id
    // es la clave con la que se guardan sus leads en app_sio_leads. Las cuentas ya
    // creadas conservan su id corto: esto solo afecta a las que se den de alta ahora.
    id: crypto.randomUUID(),
    label: legacyAccountEmail || "Cuenta principal",
    panelBaseUrl: legacyBaseUrl,
    accountEmail: legacyAccountEmail,
    method,
    apiKey: legacyKey || undefined,
    sandboxEmail: legacySandboxEmail || undefined,
    sandboxPass: legacySandboxPass || undefined,
    addedAt: Date.now(),
  };
  const list = [acc];
  await writeRaw(list);
  // Borramos los sueltos para no dejar duplicados.
  await setSetting("systemeio.publicApiKey", "");
  await setSetting("systemeio.sessionCookie", "");
  // sandboxEmail/Pass los dejamos por compat — bootstrapSession aún los lee
  // hasta que ese código pase a leer del active account.
  return list;
}

export async function listAccounts(): Promise<SiAccountPublic[]> {
  let raw = readRaw();
  if (!_migrated) raw = await migrateLegacyIfNeeded(raw);
  return raw.map(toPublic);
}

export async function listAccountsRaw(): Promise<SiAccount[]> {
  let raw = readRaw();
  if (!_migrated) raw = await migrateLegacyIfNeeded(raw);
  return raw;
}

function toPublic(a: SiAccount): SiAccountPublic {
  return {
    id: a.id,
    label: a.label,
    panelBaseUrl: a.panelBaseUrl,
    accountEmail: a.accountEmail,
    method: a.method,
    hasApiKey: !!a.apiKey,
    hasMcpKey: !!a.mcpKey,
    hasSandboxPass: !!a.sandboxPass,
    addedAt: a.addedAt,
  };
}

export async function getAccount(id: string): Promise<SiAccount | null> {
  const list = await listAccountsRaw();
  return list.find((a) => a.id === id) ?? null;
}

export async function getActiveAccount(): Promise<SiAccount | null> {
  const list = await listAccountsRaw();
  return list[0] ?? null;
}

export async function addAccount(input: Omit<SiAccount, "id" | "addedAt"> & { id?: string }): Promise<SiAccount> {
  const list = await listAccountsRaw();
  // SIO-LEADS-TENANT-1 · id COMPLETO (antes 8 hex): es la clave con la que se guardan
  // los leads de esta cuenta, y un choque entre workspaces los mezclaba.
  const id = input.id || crypto.randomUUID();
  // Si ya existe un id idéntico, hacemos update; si no, push.
  const idx = list.findIndex((a) => a.id === id);
  const acc: SiAccount = {
    ...input,
    id,
    addedAt: Date.now(),
  };
  if (idx >= 0) list[idx] = { ...list[idx], ...acc, addedAt: list[idx].addedAt };
  else list.push(acc);
  await writeRaw(list);
  return acc;
}

export async function updateAccount(id: string, patch: Partial<SiAccount>): Promise<SiAccount | null> {
  const list = await listAccountsRaw();
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  await writeRaw(list);
  return list[idx];
}

export async function removeAccount(id: string): Promise<boolean> {
  const list = await listAccountsRaw();
  const next = list.filter((a) => a.id !== id);
  if (next.length === list.length) return false;
  await writeRaw(next);
  return true;
}

/** Devuelve un label legible para un account: prioriza label > email > domain. */
export function accountLabel(a: SiAccountPublic | SiAccount): string {
  if (a.label) return a.label;
  if (a.accountEmail) return a.accountEmail;
  try {
    return new URL(a.panelBaseUrl).hostname;
  } catch {
    return a.id;
  }
}
