/**
 * Cifrado de secretos en reposo (AES-256-GCM). Los tokens (WhatsApp, Meta,
 * LLM) se guardan cifrados en Postgres. La clave viene de APP_ENC_KEY.
 * Si no hay APP_ENC_KEY se usa una de desarrollo (NO usar así en producción).
 */
import crypto from "node:crypto";

let warned = false;

// Clave de DESARROLLO (pública/conocida). Solo se usa como fallback fuera de
// producción. En prod, assertEncKeyOrMigrate() (settings.ts) impide arrancar con
// secretos cifrados con esta clave (ver F5).
const DEV_KEY = crypto.createHash("sha256").update("dev-only-insecure-key").digest();

function key(): Buffer {
  const raw = process.env.APP_ENC_KEY;
  if (!raw) {
    if (!warned) {
      console.warn(
        "[crypto] APP_ENC_KEY no definida — usando clave de desarrollo. Define APP_ENC_KEY en Railway.",
      );
      warned = true;
    }
    return DEV_KEY;
  }
  return crypto.createHash("sha256").update(raw).digest();
}

/** Señal de producción (Railway no inyecta NODE_ENV; usa sus propias vars). */
export function isProd(): boolean {
  return process.env.NODE_ENV === "production"
    || !!process.env.RAILWAY_ENVIRONMENT
    || !!process.env.RAILWAY_PROJECT_ID
    || !!process.env.RAILWAY_PUBLIC_DOMAIN;
}

/**
 * ¿Hay una APP_ENC_KEY definida? Bar deliberadamente baja (no vacía): el fallo de
 * seguridad GRAVE es la AUSENCIA (activa la dev-key pública). Una key presente pero
 * corta/placeholder genera igualmente una clave no-pública (sha256 de la key) — muy
 * superior a la dev-key — y se avisa por separado (appEncKeyWeak) sin tumbar el server.
 */
export function appEncKeyPresent(): boolean {
  const raw = process.env.APP_ENC_KEY;
  return !!raw && raw.trim().length > 0;
}

/** Key presente pero débil (corta o el placeholder del .env.example): solo aviso. */
export function appEncKeyWeak(): boolean {
  const raw = (process.env.APP_ENC_KEY || "").trim();
  return raw.length > 0 && (raw.length < 16 || raw === "cadena-larga-aleatoria");
}

/**
 * ¿Este valor cifrado lo fue con la DEV_KEY insegura? Gracias al auth-tag GCM,
 * descifrar con la clave equivocada lanza en final(); si NO lanza, fue dev-key.
 * Determinista, sin falsos positivos relevantes (colisión de tag ≈ 2^-128).
 */
export function isEncryptedWithDevKey(value: string): boolean {
  if (!value || !value.startsWith("enc:")) return false;
  try {
    const [, ivb, tagb, datab] = value.split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", DEV_KEY, Buffer.from(ivb, "base64"), { authTagLength: 16 }); // GCM-TAG-1
    d.setAuthTag(Buffer.from(tagb, "base64"));
    Buffer.concat([d.update(Buffer.from(datab, "base64")), d.final()]);
    return true;
  } catch {
    return false;
  }
}

/** Descifra un valor cifrado con la DEV_KEY (para migrarlo a la clave real). */
export function decryptWithDevKey(value: string): string {
  const [, ivb, tagb, datab] = value.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", DEV_KEY, Buffer.from(ivb, "base64"), { authTagLength: 16 }); // GCM-TAG-1
  d.setAuthTag(Buffer.from(tagb, "base64"));
  return Buffer.concat([d.update(Buffer.from(datab, "base64")), d.final()]).toString("utf8");
}

// ROTACION-ENC-1 · rotación de APP_ENC_KEY sin perder secretos. Con APP_ENC_KEY_OLD
// definida, lo que no abre con la clave actual se intenta con la anterior (y con la de
// desarrollo, como en F5) y se vuelve a cifrar con la actual al arrancar: ajustes
// secretos (assertEncKeyOrMigrate, settings.ts) y tablas del WhatsApp por QR
// (dbRotarCifradoQr, db.ts). Idempotente: al siguiente arranque todo abre con la actual.
function keyFromRaw(raw: string): Buffer {
  return crypto.createHash("sha256").update(raw).digest();
}
function decryptWithKey(value: string, k: Buffer): string | null {
  try {
    const [, ivb, tagb, datab] = value.split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(ivb, "base64"));
    d.setAuthTag(Buffer.from(tagb, "base64"));
    return Buffer.concat([d.update(Buffer.from(datab, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
/** ¿Hay una APP_ENC_KEY_OLD distinta de la actual? */
export function claveAnteriorPresente(): boolean {
  const old = (process.env.APP_ENC_KEY_OLD || "").trim();
  return old.length > 0 && old !== (process.env.APP_ENC_KEY || "").trim();
}
export type OrigenCifrado = "actual" | "anterior" | "desarrollo" | "claro";
/**
 * Comprueba con qué clave está cifrado un valor y, si no es la actual, lo devuelve
 * re-cifrado con ella. null = no abre con ninguna (actual, APP_ENC_KEY_OLD, desarrollo).
 * Un valor sin «enc:» (en claro, legado) se devuelve tal cual.
 */
export function rotarCifrado(value: string): { valor: string; origen: OrigenCifrado; cambiado: boolean } | null {
  if (!value || !value.startsWith("enc:")) return { valor: value, origen: "claro", cambiado: false };
  if (decryptWithKey(value, key()) !== null) return { valor: value, origen: "actual", cambiado: false };
  const old = (process.env.APP_ENC_KEY_OLD || "").trim();
  if (old) {
    const plain = decryptWithKey(value, keyFromRaw(old));
    if (plain !== null) return { valor: encrypt(plain), origen: "anterior", cambiado: true };
  }
  const plainDev = decryptWithKey(value, DEV_KEY);
  if (plainDev !== null) return { valor: encrypt(plainDev), origen: "desarrollo", cambiado: true };
  return null;
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decrypt(value: string): string {
  if (!value.startsWith("enc:")) return value; // valor en claro (legado/env)
  const [, ivb, tagb, datab] = value.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivb, "base64"),
    { authTagLength: 16 }, // GCM-TAG-1: un tag truncado no se acepta
  );
  decipher.setAuthTag(Buffer.from(tagb, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(datab, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Enmascara un secreto para mostrarlo en la UI sin revelarlo.
 * DESBLOQUEO-ADMIN-1 · solo asoma el final (0+4): los tres primeros caracteres
 * delataban el proveedor y el prefijo de la clave (sk-, EAA…).
 */
export function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `••••${value.slice(-4)}`;
}

/**
 * SECRETOS-ARRANQUE-1 · revisa los secretos al arrancar y AVISA con un mensaje claro de lo
 * que falta o es débil. NUNCA tumba el arranque: producción y las instancias de cliente
 * deben seguir levantando aunque falte una variable. El único bloqueo que existe es el de
 * siempre (F5, assertEncKeyOrMigrate): producción sin APP_ENC_KEY, con su kill-switch
 * ALLOW_INSECURE_ENC_KEY=true. Se llama ANTES de initDb() para que el aviso salga primero.
 * Devuelve la lista de avisos (la usa el arnés).
 */
export function comprobarSecretosDeArranque(): string[] {
  if (!isProd()) return [];
  const avisos: string[] = [];
  if (!appEncKeyPresent()) avisos.push("APP_ENC_KEY no definida: cifra las credenciales guardadas (cadena aleatoria de 32 o más caracteres).");
  else if (appEncKeyWeak()) avisos.push("APP_ENC_KEY es corta o de ejemplo: usa una cadena aleatoria de 32 o más caracteres (pon la actual en APP_ENC_KEY_OLD al cambiarla).");
  const pass = (process.env.ADMIN_PASSWORD || "").trim();
  if (!pass) avisos.push("ADMIN_PASSWORD no definida: sin ella la firma de las sesiones depende solo de APP_ENC_KEY. Define ADMIN_PASSWORD o SESSION_SECRET.");
  else if (pass.length < 12) avisos.push("ADMIN_PASSWORD tiene menos de 12 caracteres.");
  const ses = (process.env.SESSION_SECRET || "").trim();
  if (!ses) avisos.push("SESSION_SECRET no definida (opcional): las sesiones se firman con una clave derivada de ADMIN_PASSWORD y APP_ENC_KEY, así que cambiar cualquiera de las dos cierra todas las sesiones.");
  else if (ses.length < 32) avisos.push("SESSION_SECRET tiene menos de 32 caracteres.");
  if (claveAnteriorPresente()) avisos.push("APP_ENC_KEY_OLD definida: al arrancar se re-cifra con APP_ENC_KEY lo que aún abra con la anterior; cuando el log diga que ya no queda nada, retírala.");
  for (const a of avisos) console.warn("[SECRETOS-ARRANQUE-1] " + a);
  return avisos;
}
