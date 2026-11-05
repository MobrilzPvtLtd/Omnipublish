/**
 * PASARELA-META-1 · Todo lo que necesita el App Secret de la Meta App compartida pasa
 * por aquí. Dos modos:
 *   · Local: el secreto está en esta instancia (meta.appSecret), como siempre.
 *   · Pasarela: la instancia NO tiene el secreto; tiene meta.gatewayUrl + meta.gatewayKey
 *     y la pasarela (services/meta-gateway) hace la llamada en su nombre.
 * Si hay secreto local, gana el local: el Business Stack del operador sigue igual.
 *
 * Cada función devuelve una Response de fetch, así los llamadores no cambian su
 * forma de leer el resultado.
 */
import crypto from "node:crypto";
import { get } from "./settings.js";

const GRAPH = "https://graph.facebook.com/v21.0";
/** Ventana de validez del sello de tiempo de la pasarela (anti-reenvío). */
const VENTANA_MS = 5 * 60_000;

export const GATEWAY_HEADER = "x-meta-gateway";
export const GATEWAY_TS = "x-gateway-ts";
export const GATEWAY_SIG = "x-gateway-signature";

// Mismas fuentes que leían los sitios de admin.ts antes de pasar por aquí.
const appId = () => get("meta.appId") || process.env.META_APP_ID || process.env.FB_APP_ID || "";
const secretoLocal = () => get("meta.appSecret") || process.env.META_APP_SECRET || process.env.FB_APP_SECRET || "";

/** URL de la pasarela, sólo https (o http a localhost, para pruebas). */
function urlPasarela(): string {
  const u = get("meta.gatewayUrl").trim().replace(/\/+$/, "");
  if (!u) return "";
  return /^https:\/\/[^/\s]+$/.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u) ? u : "";
}
/** «<instancia>.<64 hex>» → partes; vacío si el formato no cuadra. */
function clave(): { id: string; hex: string } | null {
  const m = /^([a-z0-9-]{2,40})\.([a-f0-9]{64})$/.exec(get("meta.gatewayKey").trim());
  return m ? { id: m[1], hex: m[2] } : null;
}

export type ModoMetaApp = "local" | "pasarela" | "ninguno";
export function modoMetaApp(): ModoMetaApp {
  if (appId() && secretoLocal()) return "local";
  if (appId() && urlPasarela() && clave()) return "pasarela";
  return "ninguno";
}
/** ¿Puede esta instancia hacer las operaciones de la app (canje, debug_token…)? */
export const metaAppLista = () => modoMetaApp() !== "ninguno";

/**
 * PASARELA-META-2 · Dirección a la que Meta tiene que entregar los avisos cuando esta
 * instancia va por la pasarela (la pasarela reparte luego a cada instancia). Vacío si
 * no hay pasarela válida.
 */
export function webhookPasarela(): string {
  const u = urlPasarela();
  return u ? u + "/webhook" : "";
}

/**
 * PASARELA-META-2 · La pasarela está a medio configurar: hay URL o clave, pero no basta
 * para usarla, así que la instancia se queda sin Meta sin decir nada. Devuelve qué falla
 * (nunca los valores) o "" si no aplica.
 */
export function pasarelaIncompleta(): string {
  if (modoMetaApp() !== "ninguno") return "";
  const hayUrl = !!get("meta.gatewayUrl").trim();
  const hayClave = !!get("meta.gatewayKey").trim();
  if (!hayUrl && !hayClave) return "";
  const fallos: string[] = [];
  if (!appId()) fallos.push("falta META_APP_ID");
  if (!hayUrl) fallos.push("falta META_GATEWAY_URL");
  else if (!urlPasarela()) fallos.push("META_GATEWAY_URL no es https://<dominio> (sin ruta)");
  if (!hayClave) fallos.push("falta META_GATEWAY_KEY");
  else if (!clave()) fallos.push("META_GATEWAY_KEY no tiene el formato <instancia>.<64 hex>");
  return fallos.join("; ");
}

async function pasarela(ruta: string, cuerpo: unknown, timeoutMs = 60_000, signal?: AbortSignal): Promise<Response> {
  const k = clave()!;
  // PASARELA-META-2 · si el llamador trae su propia señal (el diagnóstico corta a los
  // pocos segundos), también corta la llamada a la pasarela, no sólo nuestro plazo.
  const plazo = AbortSignal.timeout(timeoutMs);
  return fetch(urlPasarela() + ruta, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${k.id}.${k.hex}` },
    body: JSON.stringify(cuerpo),
    signal: signal ? AbortSignal.any([plazo, signal]) : plazo,
  });
}
const sinApp = () => new Response(JSON.stringify({ error: { message: "El panel todavía no está conectado con Meta" } }), { status: 400 });
const tokenApp = () => `${appId()}|${secretoLocal()}`;
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

export async function debugToken(inputToken: string, init?: { signal?: AbortSignal }): Promise<Response> {
  const m = modoMetaApp();
  if (m === "local") return fetch(`${GRAPH}/debug_token?${qs({ input_token: inputToken, access_token: tokenApp() })}`, init);
  if (m === "pasarela") return pasarela("/v1/graph", { op: "debug_token", query: { input_token: inputToken } }, undefined, init?.signal); // PASARELA-META-2
  return sinApp();
}

/** Canje de un code de OAuth. Sin redirectUri = Embedded Signup (el code dura 30 s). */
export async function canjearCodigo(code: string, redirectUri?: string): Promise<Response> {
  const m = modoMetaApp();
  const q: Record<string, string> = { code };
  if (redirectUri) q.redirect_uri = redirectUri;
  if (m === "local") return fetch(`${GRAPH}/oauth/access_token?${qs({ client_id: appId(), client_secret: secretoLocal(), ...q })}`);
  if (m === "pasarela") return pasarela("/v1/graph", { op: "oauth_code", query: q }, 25_000);
  return sinApp();
}

export async function alargarToken(token: string): Promise<Response> {
  const m = modoMetaApp();
  if (m === "local")
    return fetch(`${GRAPH}/oauth/access_token?${qs({ grant_type: "fb_exchange_token", client_id: appId(), client_secret: secretoLocal(), fb_exchange_token: token })}`);
  if (m === "pasarela") return pasarela("/v1/graph", { op: "exchange_token", query: { fb_exchange_token: token } });
  return sinApp();
}

/** Lectura de las suscripciones de webhook de la app (cambiarlas es cosa del operador). */
export async function suscripcionesApp(init?: { signal?: AbortSignal }): Promise<Response> {
  const m = modoMetaApp();
  if (m === "local") return fetch(`${GRAPH}/${appId()}/subscriptions?${qs({ access_token: tokenApp() })}`, init);
  if (m === "pasarela") return pasarela("/v1/graph", { op: "app_subscriptions", method: "GET" }, undefined, init?.signal); // PASARELA-META-2
  return sinApp();
}

/** Subida reanudable con el token de la app → handle (foto de perfil, cabecera de plantilla). */
export async function subirConApp(buf: Buffer, mime: string, fileName?: string): Promise<{ h?: string; error?: string }> {
  const m = modoMetaApp();
  if (m === "ninguno") return { error: "el panel todavía no está conectado con Meta" };
  try {
    const q: Record<string, string> = { file_length: String(buf.length), file_type: mime };
    if (fileName) q.file_name = fileName;
    const sRes = m === "local"
      ? await fetch(`${GRAPH}/${appId()}/uploads?${qs({ ...q, access_token: tokenApp() })}`, { method: "POST" })
      : await pasarela("/v1/graph", { op: "upload_start", query: q });
    const sJson = (await sRes.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!sRes.ok || !sJson.id) return { error: sJson?.error?.message || `sesión de subida ${sRes.status}` };
    const uRes = m === "local"
      ? await fetch(`${GRAPH}/${sJson.id}`, {
          method: "POST",
          headers: { Authorization: `OAuth ${tokenApp()}`, file_offset: "0", "Content-Type": mime },
          body: buf as unknown as BodyInit,
        })
      : await pasarela("/v1/graph", { op: "upload_chunk", query: { session: sJson.id, file_offset: "0" }, data_b64: buf.toString("base64") });
    const uJson = (await uRes.json().catch(() => ({}))) as { h?: string; error?: { message?: string } };
    if (!uRes.ok || !uJson.h) return { error: uJson?.error?.message || `subida ${uRes.status}` };
    return { h: uJson.h };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** signed_request de Meta (borrado de datos). Devuelve el payload o null. */
export async function verificarSignedRequest(signed: string, local: (s: string, secret: string) => any | null): Promise<any | null> {
  const m = modoMetaApp();
  if (m === "local") return local(signed, secretoLocal());
  if (m !== "pasarela") return null;
  try {
    const r = await pasarela("/v1/signed-request", { signed_request: signed }, 10_000);
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; payload?: unknown };
    return r.ok && j.ok ? j.payload : null;
  } catch { return null; }
}

/**
 * ¿Este webhook viene de NUESTRA pasarela? Exige las tres cosas:
 *   · cabecera con el id de esta instancia,
 *   · sello de tiempo a menos de 5 min (una entrega capturada no se puede reenviar después),
 *   · HMAC(clave de la instancia, ts + "." + cuerpo).
 * La clave de la instancia no sirve para nada más: no es el App Secret.
 *
 * PASARELA-META-2 · Devuelve "nueva", "repetida" (esa misma entrega firmada ya entró: se
 * contesta 200 y NO se procesa otra vez) o null (no viene de la pasarela → 401).
 */
export function entregaDePasarela(raw: Buffer, headers: Record<string, unknown>): "nueva" | "repetida" | null {
  const k = clave();
  if (!k || !urlPasarela()) return null;
  if (String(headers[GATEWAY_HEADER] || "") !== k.id) return null;
  const ts = String(headers[GATEWAY_TS] || "");
  // PASARELA-META-2 · el sello llega en SEGUNDOS (10 cifras, la pasarela de ahora) o en
  // milisegundos (13, la de PASARELA-META-1, la que hay en producción). Valen los dos:
  // pasarela e instancias se despliegan por separado. Restarlo tal cual a Date.now()
  // dejaba fuera de plazo TODAS las entregas en segundos (401 «bad signature»).
  if (!/^(\d{10}|\d{13})$/.test(ts)) return null;
  const tsMs = ts.length === 10 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs(Date.now() - tsMs) > VENTANA_MS) return null;
  const esperada = Buffer.from("sha256=" + crypto.createHmac("sha256", k.hex).update(ts + ".").update(raw).digest("hex"));
  // PASARELA-META-2 · se comparan BYTES, no caracteres: una firma con caracteres de varios
  // bytes medía lo mismo en caracteres, timingSafeEqual lanzaba y el aviso daba 500, no 401.
  const dada = Buffer.from(String(headers[GATEWAY_SIG] || ""));
  if (dada.length !== esperada.length || !crypto.timingSafeEqual(dada, esperada)) return null;
  // PASARELA-META-2 · y cada entrega firmada se procesa UNA vez (ver firmaRepetida). Con el
  // sello en segundos, dos entregas de cuerpo idéntico en el mismo segundo firman igual: la
  // segunda es el mismo contenido, así que se da por recibida sin procesarla, no se rechaza.
  return firmaRepetida(dada.toString("latin1"), tsMs + VENTANA_MS) ? "repetida" : "nueva";
}

/**
 * PASARELA-META-2 · Firmas ya aceptadas → cuándo dejan de valer. Dentro de la ventana de
 * 5 min, la misma entrega capturada (mismo sello, mismo cuerpo, misma firma) se podía
 * reenviar tantas veces como se quisiera. La pasarela vuelve a firmar cada reintento con
 * un sello nuevo, así que un reintento legítimo nunca choca con esto. Sólo entran firmas
 * válidas (hace falta la clave), y caducan solas: el tamaño lo marca el tráfico real.
 */
const firmasVistas = new Map<string, number>();
let ultimaPurga = 0;
function firmaRepetida(firma: string, caduca: number): boolean {
  const ahora = Date.now();
  if (ahora - ultimaPurga > 30_000) {
    ultimaPurga = ahora;
    for (const [f, c] of firmasVistas) if (c < ahora) firmasVistas.delete(f);
  }
  if (firmasVistas.has(firma)) return true;
  firmasVistas.set(firma, caduca);
  return false;
}

/**
 * Declara a la pasarela qué canales son de esta instancia (números, WABAs, cuentas de
 * IG, Páginas). La pasarela rechaza los que ya son de otra: así un cliente no puede
 * quedarse con los mensajes de otro poniendo su número en el panel.
 */
export async function declararCanales(canales: string[]): Promise<{ aceptados: string[]; conflictos: string[] } | null> {
  if (modoMetaApp() !== "pasarela") return null;
  const k = clave()!;
  const r = await fetch(urlPasarela() + "/v1/canales", {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${k.id}.${k.hex}` },
    body: JSON.stringify({ canales }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`pasarela ${r.status}`);
  return (await r.json()) as { aceptados: string[]; conflictos: string[] };
}
