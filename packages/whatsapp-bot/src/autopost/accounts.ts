/**
 * Almacén multi-cuenta de cuentas Upload-Post.
 *
 * Hasta ahora el panel asumía UNA sola cuenta Upload-Post conectada
 * (`autopost.uploadPostToken` + `autopost.uploadPostUser`). El user quiere
 * poder gestionar N cuentas independientes (su marca + clientes A, B, C)
 * con bundles distintos de redes conectadas, y elegir desde qué publicar
 * en Programador / Carruseles.
 *
 * Almacenamos un JSON encriptado bajo `autopost.uploadPostAccounts`
 * (SECRET_KEYS) con la lista de cuentas:
 *
 *   [
 *     { id, label, user, token, addedAt }, ...
 *   ]
 *
 * Migración automática (idempotente): si el JSON está vacío pero existen
 * `autopost.uploadPostToken/uploadPostUser` legacy, los convertimos a una
 * "Cuenta principal" y borramos los sueltos para no duplicar.
 *
 * Backward compat: chat() y rutas viejas siguen leyendo via getActive()
 * mientras las consumidoras nuevas pasan accountId explícito.
 */
import crypto from "node:crypto";
import { get as getSetting, set as setSetting } from "../settings.js";

export interface UpAccount {
  id: string;
  label: string;
  user: string;
  token: string;
  addedAt: number;
}

export interface UpAccountPublic {
  id: string;
  label: string;
  user: string;
  hasToken: boolean;
  addedAt: number;
}

let _migrated = false;

function readRaw(): UpAccount[] {
  try {
    const raw = getSetting("autopost.uploadPostAccounts");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as UpAccount[];
  } catch {
    return [];
  }
}

async function writeRaw(accounts: UpAccount[]): Promise<void> {
  await setSetting("autopost.uploadPostAccounts", JSON.stringify(accounts));
}

/**
 * Migración idempotente: si no hay cuentas y hay legacy token/user sueltos,
 * crea una "Cuenta principal" con ellos. Solo corre 1 vez por proceso.
 */
async function migrateLegacyIfNeeded(current: UpAccount[]): Promise<UpAccount[]> {
  if (_migrated || current.length > 0) {
    _migrated = true;
    return current;
  }
  _migrated = true;
  const legacyToken = getSetting("autopost.uploadPostToken");
  const legacyUser = getSetting("autopost.uploadPostUser");
  if (!legacyToken && !legacyUser) return [];
  const acc: UpAccount = {
    id: crypto.randomUUID().slice(0, 8),
    label: legacyUser || "Cuenta principal",
    user: legacyUser || "leadmatch",
    token: legacyToken || "",
    addedAt: Date.now(),
  };
  const list = [acc];
  await writeRaw(list);
  // Borramos los sueltos del legacy para no dejar duplicados.
  await setSetting("autopost.uploadPostToken", "");
  await setSetting("autopost.uploadPostUser", "");
  return list;
}

export async function listUpAccounts(): Promise<UpAccountPublic[]> {
  let raw = readRaw();
  if (!_migrated) raw = await migrateLegacyIfNeeded(raw);
  return raw.map(toPublic);
}

export async function listUpAccountsRaw(): Promise<UpAccount[]> {
  let raw = readRaw();
  if (!_migrated) raw = await migrateLegacyIfNeeded(raw);
  return raw;
}

function toPublic(a: UpAccount): UpAccountPublic {
  return {
    id: a.id,
    label: a.label,
    user: a.user,
    hasToken: !!a.token,
    addedAt: a.addedAt,
  };
}

export async function getUpAccount(id: string): Promise<UpAccount | null> {
  const list = await listUpAccountsRaw();
  return list.find((a) => a.id === id) ?? null;
}

/** Devuelve la primera cuenta UP — para callers que no pasan accountId explícito. */
export async function getActiveUpAccount(): Promise<UpAccount | null> {
  const list = await listUpAccountsRaw();
  return list[0] ?? null;
}

export async function addUpAccount(
  input: Omit<UpAccount, "id" | "addedAt"> & { id?: string },
): Promise<UpAccount> {
  const list = await listUpAccountsRaw();
  const id = input.id || crypto.randomUUID().slice(0, 8);
  const idx = list.findIndex((a) => a.id === id);
  const acc: UpAccount = { ...input, id, addedAt: Date.now() };
  if (idx >= 0) list[idx] = { ...list[idx], ...acc, addedAt: list[idx].addedAt };
  else list.push(acc);
  await writeRaw(list);
  return acc;
}

export async function updateUpAccount(
  id: string,
  patch: Partial<UpAccount>,
): Promise<UpAccount | null> {
  const list = await listUpAccountsRaw();
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  await writeRaw(list);
  return list[idx];
}

export async function removeUpAccount(id: string): Promise<boolean> {
  const list = await listUpAccountsRaw();
  const next = list.filter((a) => a.id !== id);
  if (next.length === list.length) return false;
  await writeRaw(next);
  return true;
}
