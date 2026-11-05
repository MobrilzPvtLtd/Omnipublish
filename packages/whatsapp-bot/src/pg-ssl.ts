/** PG-TLS-1 · Una sola política de TLS para TODOS los clientes de PostgreSQL (el pool
 * principal, su conexión de escucha y los pools pequeños de enlaces, MCP, páginas,
 * snapshots y analítica web). Antes cada uno repetía
 * `DATABASE_SSL === "require" ? { rejectUnauthorized: false }`: cifraba sin comprobar
 * a quién se conectaba, y no había forma de darle una CA.
 *
 *   DATABASE_SSL        sin valor / disable → sin TLS (red privada: Railway cifra
 *                                              *.railway.internal por su cuenta)
 *                       require             → cifra; con CA la verifica (sin nombre),
 *                                              sin CA NO verifica — avisa al arrancar
 *                       verify-ca           → exige CA; verifica la cadena, no el nombre
 *                       verify-full         → verifica cadena y nombre (CA propia o la
 *                                              del sistema si el certificado es público)
 *   DATABASE_SSL_CA       PEM de la CA (admite \n escapados)
 *   DATABASE_SSL_CA_FILE  ruta a un fichero PEM
 *
 * Mismos nombres que libpq. Un valor desconocido para el arranque: con el healthcheck
 * de Railway el despliegue anterior sigue sirviendo, y un error tipográfico no deja la
 * base sin TLS en silencio. OJO: si DATABASE_URL trae `sslmode`/`sslrootcert`, pg le
 * da prioridad a la URL sobre esta opción — se avisa. */
import fs from "node:fs";
import { isIP } from "node:net";
import tls, { type ConnectionOptions } from "node:tls";

export type PgSslModo = "disable" | "require" | "verify-ca" | "verify-full";

export interface PgSslPolitica {
  modo: PgSslModo;
  ssl: ConnectionOptions | undefined;
  avisos: string[];
}

export function pgSslDesdeEntorno(env: NodeJS.ProcessEnv = process.env): PgSslPolitica {
  const raw = String(env.DATABASE_SSL ?? "").trim().toLowerCase();
  // prefer/allow son de libpq, pero pg no negocia TLS opcional: se quedan sin TLS, que es
  // lo que hacían antes (sólo "require" activaba algo) — con aviso, sin tumbar el arranque.
  const opcional = raw === "prefer" || raw === "allow";
  const modo: PgSslModo | null = !raw || raw === "disable" || raw === "off" || raw === "false" || opcional
    ? "disable"
    : raw === "require" || raw === "verify-ca" || raw === "verify-full" ? raw : null;
  if (!modo) {
    throw new Error(`DATABASE_SSL="${raw}" no es válido: usa disable, require, verify-ca o verify-full.`);
  }
  const avisos: string[] = [];
  if (opcional) avisos.push(`DATABASE_SSL=${raw}: el cliente pg no negocia TLS opcional y conecta sin TLS. Para cifrar usa require o verify-full.`);
  let ca: string | undefined;
  const caPem = String(env.DATABASE_SSL_CA ?? "").trim();
  const caFile = String(env.DATABASE_SSL_CA_FILE ?? "").trim();
  if (caPem) ca = caPem.replace(/\\n/g, "\n");
  else if (caFile) {
    try { ca = fs.readFileSync(caFile, "utf8"); } catch (e) {
      throw new Error(`DATABASE_SSL_CA_FILE no se puede leer (${caFile}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (ca && !/-----BEGIN CERTIFICATE-----/.test(ca)) {
    throw new Error("DATABASE_SSL_CA / DATABASE_SSL_CA_FILE no contiene un certificado PEM.");
  }

  let ssl: ConnectionOptions | undefined;
  if (modo === "disable") {
    ssl = undefined;
    if (ca) avisos.push("Hay una CA de PostgreSQL configurada pero DATABASE_SSL está desactivado: la conexión va sin TLS.");
  } else if (modo === "require") {
    if (ca) ssl = { rejectUnauthorized: true, ca, checkServerIdentity: () => undefined };
    else {
      ssl = { rejectUnauthorized: false };
      avisos.push("DATABASE_SSL=require cifra pero NO verifica el servidor. Fuera de una red privada usa verify-full (y DATABASE_SSL_CA si la CA es propia).");
    }
  } else if (modo === "verify-ca") {
    if (!ca) throw new Error("DATABASE_SSL=verify-ca exige la CA en DATABASE_SSL_CA o DATABASE_SSL_CA_FILE.");
    ssl = { rejectUnauthorized: true, ca, checkServerIdentity: () => undefined };
  } else {
    ssl = ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
    // pg sólo le pasa el nombre a TLS cuando el host NO es una IP; con una IP, Node no
    // comprobaba contra ella y un certificado de otro nombre pasaba (lo caza el arnés).
    const host = hostDeUrl(String(env.DATABASE_URL ?? ""));
    if (host && isIP(host)) ssl.checkServerIdentity = (_h, cert) => tls.checkServerIdentity(host, cert);
  }

  const url = String(env.DATABASE_URL ?? "");
  const q = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const enUrl = q.split("&").map((p) => p.split("=")[0].toLowerCase())
    .filter((k) => k === "sslmode" || k === "ssl" || k === "sslrootcert" || k === "uselibpqcompat");
  if (enUrl.length) {
    avisos.push(`DATABASE_URL trae ${enUrl.join(", ")}: pg aplica la URL por encima de DATABASE_SSL`
      + (modo !== "disable" ? ` (DATABASE_SSL=${modo} no se aplica).` : "."));
  }
  return { modo, ssl, avisos };
}

function hostDeUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, ""); } catch { return ""; }
}

let cache: PgSslPolitica | null = null;

/** La opción `ssl` para `new pg.Pool/Client`. Se calcula una vez y avisa una vez. */
export function pgSsl(): ConnectionOptions | undefined {
  if (!cache) {
    cache = pgSslDesdeEntorno();
    for (const a of cache.avisos) console.warn("[PG-TLS-1] " + a);
  }
  return cache.ssl;
}
