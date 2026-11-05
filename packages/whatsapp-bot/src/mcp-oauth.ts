/**
 * MCP-2 · Conectar una IA iniciando sesión en el panel (OAuth 2.1 de la spec MCP 2025-11-25).
 *
 * A la IA (Claude, ChatGPT, Claude Code, Cursor…) le basta con la dirección <origen>/mcp:
 *   1. /mcp responde 401 señalando sus metadatos (RFC 9728) → la IA descubre este servidor de
 *      autorización (RFC 8414) y se registra sola (RFC 7591).
 *   2. Abre /oauth/authorize en el navegador. Sin sesión pasa por el login del panel y vuelve;
 *      la persona elige negocio y nivel y pulsa «Permitir».
 *   3. La IA canjea el código (PKCE S256 obligatorio) por un pase de 1 h y otro de renovación
 *      de 90 días que ROTA en cada uso. Los dos se guardan como sha256 en app_mcp_keys
 *      (via 'oauth'), así que el servidor MCP los trata como una clave más: los MISMOS
 *      permisos de quien autorizó, y solo en el negocio que eligió.
 *
 * Sin estado propio: el registro de la IA, el código y el anti-CSRF van SELLADOS (AES-256-GCM
 * con una clave derivada del secreto del servidor): ni tablas nuevas ni limpieza. Lo único en
 * memoria es la lista de códigos ya canjeados, que viven 120 s.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { dbCreateMcpKey, dbListMcpKeys, dbMcpKeyPorRefresh, dbMcpKeyPorRefreshViejo, dbRevokeMcpKey, dbRotarMcpKey } from "./db.js";
import { mcpSesion, nombreProducto, paginaSuelta, sesionPanel } from "./admin.js";
import { logActivity } from "./activity.js";
import { runWithWorkspace } from "./workspace.js";
import { frenoPublicoPorIp } from "./seguridad-panel.js";

const PASE_MS = 60 * 60_000;                  // lo que vale el pase que viaja en cada llamada
const GRACIA_MS = 60_000;                     // un reintento de la propia IA al renovar no apaga la conexión
const RENOVAR_MS = 90 * 24 * 60 * 60_000;     // sin usarse en 90 días, la conexión se apaga sola
const CODIGO_MS = 120_000;
const CSRF_MS = 30 * 60_000;
const MAX_CONEXIONES = 50;                    // el mismo tope que las claves (admin.ts, ia-claves)
const ALCANCES = ["lectura", "completo"] as const;
type Alcance = (typeof ALCANCES)[number];
const METODOS = ["none", "client_secret_post", "client_secret_basic"] as const;
type Metodo = (typeof METODOS)[number];

/** Registro de la IA (va sellado DENTRO del client_id). */
type Cliente = { n: string; r: string[]; m: Metodo; t: number };
/** Código de autorización sellado. */
type Codigo = { u: string; e: string; w: string; s: Alcance; c: string; n: string; r: string; ch: string; x: number; k: string; rs: string };
/** Anti-CSRF de la pantalla de autorizar: ata la sesión, la IA y su vuelta. */
type Csrf = { u: string; c: string; r: string; x: number };
type Peticion = { cli: Cliente; client_id: string; redirect: string; state: string; scope: Alcance; ch: string; rs: string };
type Negocio = { id: string; nombre: string };

let appRef: FastifyInstance | null = null;

// ── Utilidades ───────────────────────────────────────────────────────────────
/** Origen público de la petición (proto + host), el mismo que ve la IA. */
export function baseDe(req: FastifyRequest): string {
  const p = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim().toLowerCase();
  const proto = p === "http" || p === "https" ? p : "https";
  const h = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  return proto + "://" + (/^[a-z0-9.-]+(:\d{1,5})?$/.test(h) ? h : "localhost");
}
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();
const hashId = (clientId: string) => sha256("cliente:" + clientId).toString("hex");
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
function igual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256("cmp:" + a), sha256("cmp:" + b));
}

let claveSello: Buffer | null = null;
function sello(): Buffer {
  // Derivada del secreto del servidor: cambiarlo invalida registros y códigos en vuelo (la IA
  // se vuelve a registrar sola). Sin ninguno (desarrollo), una al azar por proceso.
  if (!claveSello) {
    const base = process.env.APP_ENC_KEY || process.env.ADMIN_PASSWORD || crypto.randomBytes(32).toString("hex");
    claveSello = sha256("mcp-oauth:v1:" + base);
  }
  return claveSello;
}
function sellar(tipo: string, obj: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", sello(), iv);
  c.setAAD(Buffer.from(tipo));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url");
}
function abrir<T>(tipo: string, s: unknown): T | null {
  if (typeof s !== "string" || s.length > 8000 || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  if (b.length < 29) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", sello(), b.subarray(0, 12));
    d.setAAD(Buffer.from(tipo));
    d.setAuthTag(b.subarray(b.length - 16));
    const o = JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("utf8"));
    return o && typeof o === "object" ? (o as T) : null;
  } catch { return null; }
}
const secretoDe = (clientId: string) => "bss_" + crypto.createHmac("sha256", sello()).update("secreto:" + clientId).digest("base64url");

// ── Direcciones de vuelta ────────────────────────────────────────────────────
const ESQUEMAS_VETADOS = new Set(["javascript", "data", "file", "vbscript", "about", "blob", "ftp", "ws", "wss", "mailto", "tel", "sms", "intent", "chrome", "edge", "view-source"]);
const esLoopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";
/** https; http solo hacia este mismo equipo; o el esquema propio de una app de escritorio. */
function redirectValido(v: unknown): URL | null {
  if (typeof v !== "string" || !v || v.length > 500 || /[\s\\]/.test(v) || v.includes("#")) return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.username || u.password) return null;
  const esq = u.protocol.slice(0, -1).toLowerCase();
  if (esq === "https") return u.hostname ? u : null;
  if (esq === "http") return esLoopback(u.hostname) ? u : null;
  return ESQUEMAS_VETADOS.has(esq) || !/^[a-z][a-z0-9+.-]*$/.test(esq) ? null : u;
}
/** Exacta; en loopback el puerto puede cambiar en cada arranque de la app (RFC 8252 §7.3). */
function mismoRedirect(registrada: string, pedida: string): boolean {
  if (registrada === pedida) return true;
  const a = redirectValido(registrada), b = redirectValido(pedida);
  return !!a && !!b && a.protocol === "http:" && b.protocol === "http:" && esLoopback(a.hostname)
    && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}
function urlRetorno(redirect: string, p: Record<string, string>): string {
  const u = new URL(redirect);
  for (const [k, v] of Object.entries(p)) if (v) u.searchParams.set(k, v);
  return u.toString();
}
const recursoValido = (rs: string, base: string) => { const r = rs.replace(/\/+$/, ""); return r === base + "/mcp" || r === base; };

// ── Cuerpo (JSON, formulario o texto) ────────────────────────────────────────
function cuerpo(req: FastifyRequest): Record<string, unknown> {
  const b = req.body as unknown;
  if (!b) return {};
  if (typeof b === "string") {
    try { const j = JSON.parse(b); if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>; } catch { /* formulario */ }
    const o: Record<string, string> = {};
    new URLSearchParams(b).forEach((v, k) => (o[k] = v));
    return o;
  }
  if (typeof b !== "object" || Buffer.isBuffer(b)) return {};
  // El parser JSON común (index.ts) entrega { raw, json }.
  if ("raw" in b && "json" in b) {
    const j = (b as { json: unknown }).json;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  }
  return b as Record<string, unknown>;
}
const texto = (v: unknown) => (typeof v === "string" ? v : "");

// ── Quién es la IA (lo que ve la persona antes de permitir) ─────────────────
// El nombre que manda la IA al registrarse lo pone ella: solo se «reconoce» a Claude o a
// ChatGPT por su dirección de vuelta, que es lo que no puede falsear. Y la vuelta siempre se
// enseña, para que un «Claude» que devuelve a otra web se note.
const LOGOS: Record<string, string> = {
  claude: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#D97757" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
  "claude-code": '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#D97757" d="M20 4v4h4v4h-4v8h-2v-4h-2v4h-2v-4h-4v4H8v-4H6v4H4v-8H0V8h4V4z"/><path fill="#141413" d="M6 6h2v2H6zm10 0h2v2h-2z"/></svg>',
  openai: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  cursor: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"/></svg>',
};
function quienEs(cli: Cliente, redirect: string): { nombre: string; logo: string; vuelta: string } {
  const u = new URL(redirect);
  const host = u.hostname.toLowerCase();
  const loop = u.protocol === "http:" && esLoopback(host);
  const de = (d: string) => host === d || host.endsWith("." + d);
  let nombre = cli.n, logo = "";
  if (u.protocol === "https:" && (de("claude.ai") || de("claude.com"))) { nombre = "Claude"; logo = "claude"; }
  else if (u.protocol === "https:" && (de("chatgpt.com") || de("openai.com"))) { nombre = "ChatGPT"; logo = "openai"; }
  else if (loop && /^claude[ -]?code/i.test(cli.n)) { nombre = "Claude Code"; logo = "claude-code"; }
  else if (u.protocol === "cursor:") { nombre = "Cursor"; logo = "cursor"; }
  // Los agentes de Cursor en la web vuelven a su dominio, no al esquema cursor://.
  else if (u.protocol === "https:" && (de("cursor.com") || de("cursor.sh"))) { nombre = "Cursor"; logo = "cursor"; }
  else if (/claude|anthropic|chatgpt|openai|cursor/i.test(cli.n)) {
    // Dice ser una IA conocida pero vuelve a otra dirección: su nombre no se enseña a secas.
    const origen = " (" + (u.protocol === "https:" || loop ? host : u.protocol.slice(0, -1)).slice(0, 60) + ")";
    nombre = cli.n.slice(0, 80 - origen.length) + origen;
  }
  const vuelta = u.protocol === "https:" ? host : loop ? "una aplicación de este ordenador" : "la aplicación «" + u.protocol.slice(0, -1) + "»";
  return { nombre: nombre.slice(0, 80) || host || "Tu IA", logo, vuelta };
}
const limpiarNombre = (v: unknown) => String(v ?? "")
  .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
  .replace(/\s+/g, " ").trim().slice(0, 80);

// ── Códigos canjeados (un código vale una vez) ───────────────────────────────
const usados = new Map<string, { x: number; w: string; id: string }>();
setInterval(() => { const t = Date.now(); for (const [k, v] of usados) if (v.x < t) usados.delete(k); }, 10 * 60_000).unref();

// ── Metadatos ────────────────────────────────────────────────────────────────
function corsAbierto(reply: FastifyReply): void {
  // Metadatos, registro y canje no usan cookies: el origen abierto no expone nada, y los
  // clientes que corren en un navegador los necesitan.
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version");
}
const metaRecurso = (req: FastifyRequest) => {
  const b = baseDe(req);
  return { resource: b + "/mcp", authorization_servers: [b], scopes_supported: [...ALCANCES], bearer_methods_supported: ["header"], resource_name: nombreProducto() };
};
const metaServidor = (req: FastifyRequest) => {
  const b = baseDe(req);
  return {
    issuer: b,
    authorization_endpoint: b + "/oauth/authorize",
    token_endpoint: b + "/oauth/token",
    registration_endpoint: b + "/oauth/register",
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...METODOS],
    scopes_supported: [...ALCANCES],
    authorization_response_iss_parameter_supported: true,
  };
};

// ── Páginas (autorizar y avisos) ─────────────────────────────────────────────
function cabeceras(reply: FastifyReply, destino = ""): void {
  // form-action gobierna también el 302 que sigue al «Permitir»: incluye la vuelta de la IA.
  reply.header("X-Frame-Options", "DENY");
  reply.header("Content-Security-Policy", "frame-ancestors 'none'; form-action 'self'" + (destino ? " " + destino : "") + "; base-uri 'none'; object-src 'none'");
  reply.header("Cache-Control", "no-store");
  // same-origin y no no-referrer: con no-referrer el navegador manda «Origin: null» en el POST.
  reply.header("Referrer-Policy", "same-origin");
  reply.header("X-Content-Type-Options", "nosniff");
}
function fuenteDestino(redirect: string): string {
  const u = new URL(redirect);
  return u.protocol === "https:" || u.protocol === "http:" ? u.protocol + "//" + u.host : u.protocol;
}
function aviso(reply: FastifyReply, status: number, titulo: string, txt: string) {
  cabeceras(reply);
  return reply.code(status).type("text/html").send(paginaSuelta({
    eyebrow: "Conectar una IA", titulo: esc(titulo), texto: esc(txt),
    cuerpo: '<div class="oa-botones"><a class="lg-cta" href="/admin#ia">Ir al panel</a></div>',
  }));
}
function par(logo: string, nombre: string): string {
  const cli = logo ? LOGOS[logo] : '<b>' + esc((Array.from(nombre.trim())[0] || "?").toUpperCase()) + "</b>";
  return '<div class="oa-par" aria-hidden="true"><span class="oa-logo oa-logo-' + (logo || "otra") + '">' + cli + '</span>'
    + '<span class="oa-une"><i></i><i></i><i></i></span><span class="oa-logo oa-logo-yo">' + "<!--LOGO-PANEL-->" + "</span></div>";
}

function consentimiento(req: FastifyRequest, reply: FastifyReply, v: Peticion, ses: { uid: string; email: string }, negocios: Negocio[]) {
  const q = quienEs(v.cli, v.redirect);
  const csrf = sellar("csrf", { u: ses.uid, c: hashId(v.client_id), r: v.redirect, x: Date.now() + CSRF_MS } satisfies Csrf);
  const ocultos: Record<string, string> = {
    client_id: v.client_id, redirect_uri: v.redirect, state: v.state, response_type: "code",
    code_challenge: v.ch, code_challenge_method: "S256", scope: v.scope, resource: v.rs, csrf,
  };
  const cookie = String(req.headers.cookie || "").match(/(?:^|;\s*)bstack_ws=([^;]+)/);
  let actual = "";
  try { actual = cookie ? decodeURIComponent(cookie[1]) : ""; } catch { /* sin preferencia */ }
  const elegido = negocios.some((n) => n.id === actual) ? actual : negocios[0].id;
  const negocio = negocios.length === 1
    ? '<div class="oa-fijo">' + esc(negocios[0].nombre) + '</div><input type="hidden" name="ws" value="' + esc(negocios[0].id) + '">'
    : '<div class="oa-sel"><select id="oa-ws" name="ws">' + negocios.map((n) =>
      '<option value="' + esc(n.id) + '"' + (n.id === elegido ? " selected" : "") + ">" + esc(n.nombre) + "</option>").join("") + "</select></div>";
  const nivel = (valor: Alcance, titulo: string, txt: string, marcado: boolean) =>
    '<label class="oa-nivel"><input type="radio" name="nivel" value="' + valor + '"' + (marcado ? " checked" : "") + '>'
    + '<span class="oa-nivel-tx"><b>' + titulo + "</b><small>" + txt + "</small></span></label>";
  const niveles = v.scope === "lectura"
    ? nivel("lectura", "Solo consultar", "Ver métricas, flujos, contactos y publicaciones sin cambiar nada.", true)
    : nivel("completo", "Consultar y actuar", "Ver métricas y crear flujos, publicaciones o contactos.", true)
      + nivel("lectura", "Solo consultar", "Ver métricas, flujos, contactos y publicaciones sin cambiar nada.", false);
  const volverA = "/oauth/authorize?" + new URLSearchParams(Object.entries({
    response_type: "code", client_id: v.client_id, redirect_uri: v.redirect, state: v.state,
    code_challenge: v.ch, code_challenge_method: "S256", scope: v.scope, resource: v.rs,
  }).filter(([, x]) => x)).toString();
  const inicial = esc((Array.from(ses.email.trim())[0] || "?").toUpperCase());
  const form = '<form method="POST" action="/oauth/authorize" class="lg-form oa-form">'
    + Object.entries(ocultos).filter(([, x]) => x).map(([k, x]) => '<input type="hidden" name="' + k + '" value="' + esc(x) + '">').join("")
    + '<div class="oa-cuenta"><span class="oa-av" aria-hidden="true">' + inicial + '</span><span class="oa-cuenta-tx"><small>Has iniciado sesión como</small><b>' + esc(ses.email) + "</b></span>"
    + '<a class="oa-cambiar" href="/admin/logout?next=' + esc(encodeURIComponent(volverA)) + '">Cambiar</a></div>'
    + '<div class="lg-field"><label' + (negocios.length > 1 ? ' for="oa-ws"' : "") + ">Negocio</label>" + negocio + "</div>"
    + '<fieldset class="oa-niveles"><legend>Qué podrá hacer</legend>' + niveles + "</fieldset>"
    + '<p class="oa-nota">Actuará siempre con tus permisos y todo lo que haga quedará en Actividad. La desconectas cuando quieras en <b>Conecta tu IA</b>.</p>'
    + '<div class="oa-botones"><button type="submit" name="decision" value="permitir" class="lg-cta">Permitir</button>'
    + '<button type="submit" name="decision" value="cancelar" class="oa-no">Cancelar</button></div>'
    + "</form>";
  cabeceras(reply, fuenteDestino(v.redirect));
  return reply.type("text/html").send(paginaSuelta({
    eyebrow: "Conectar una IA",
    titulo: "«" + esc(q.nombre) + "» quiere acceder a " + esc(nombreProducto()),
    texto: "Al permitirlo volverás a " + esc(q.vuelta) + ".",
    arriba: par(q.logo, q.nombre),
    cuerpo: form,
  }));
}

// ── La petición de autorizar ─────────────────────────────────────────────────
function validarPeticion(req: FastifyRequest, p: Record<string, unknown>): Peticion | { pagina: string } | { redirigir: string } {
  const client_id = texto(p.client_id);
  const cli = abrir<Cliente>("cli", client_id);
  if (!cli || !Array.isArray(cli.r) || !cli.r.length)
    return { pagina: "Tu IA no está registrada en este panel (o se registró en otro). Quita la conexión en tu IA y vuelve a añadirla con la dirección de Conecta tu IA." };
  let redirect = texto(p.redirect_uri);
  if (!redirect && cli.r.length === 1) redirect = cli.r[0];
  if (!redirectValido(redirect) || !cli.r.some((x) => mismoRedirect(x, redirect)))
    return { pagina: "La dirección a la que tu IA quiere volver no es la que registró. Por seguridad, la conexión se detiene aquí." };
  const state = texto(p.state).slice(0, 4000);
  const base = baseDe(req);
  const ur = new URL(redirect);
  const confiable = !!quienEs(cli, redirect).logo || (ur.protocol === "http:" && esLoopback(ur.hostname.toLowerCase()));
  const volver = (error: string, desc: string) => confiable
    ? { redirigir: urlRetorno(redirect, { error, error_description: desc, state, iss: base }) }
    : { pagina: "Tu IA ha pedido conectarse de una forma que este panel no admite, así que la conexión se detiene aquí. Detalle para quien la hizo: " + desc };
  if (p.response_type !== "code") return volver("unsupported_response_type", "Solo se admite response_type=code.");
  const ch = texto(p.code_challenge);
  if (p.code_challenge_method !== "S256" || !/^[A-Za-z0-9._~-]{43,128}$/.test(ch)) return volver("invalid_request", "PKCE con S256 es obligatorio.");
  const rs = texto(p.resource);
  if (rs && !recursoValido(rs, base)) return volver("invalid_target", "Este servidor solo autoriza el acceso a " + base + "/mcp.");
  const pedidos = texto(p.scope).split(/\s+/).filter(Boolean);
  const scope: Alcance = pedidos.includes("lectura") && !pedidos.includes("completo") ? "lectura" : "completo";
  return { cli, client_id, redirect, state, scope, ch, rs };
}

/** Negocios donde esta sesión puede conectar una IA: los suyos (la lógica de my-workspaces)
 *  y, en cada uno, con permiso para Conecta tu IA (el mismo guard que la pantalla). */
async function negociosDe(req: FastifyRequest): Promise<Negocio[]> {
  const app = appRef;
  if (!app) return [];
  const cookie = String(req.headers.cookie || "");
  const r = await app.inject({ method: "GET", url: "/admin/api/my-workspaces", headers: { cookie } });
  if (r.statusCode !== 200) return [];
  const ws = ((r.json() as { workspaces?: { id?: string; label?: string; slug?: string; archived?: boolean }[] }).workspaces || [])
    .filter((w) => w && w.id && !w.archived);
  const ok = await Promise.all(ws.map(async (w) => {
    const x = await app.inject({ method: "GET", url: "/admin/api/ia-claves", headers: { cookie, "x-workspace-id": String(w.id) } });
    return x.statusCode === 200 ? { id: String(w.id), nombre: String(w.label || w.slug || w.id) } : null;
  }));
  return ok.filter((n): n is Negocio => !!n);
}

function nuevoPase() {
  const acceso = "bsk_" + crypto.randomBytes(24).toString("base64url");
  const renovar = "bsr_" + crypto.randomBytes(32).toString("base64url");
  const t = Date.now();
  return {
    acceso, renovar,
    fila: {
      token_hash: sha256(acceso).toString("hex"), prefix: acceso.slice(0, 8),
      refresh_hash: sha256(renovar).toString("hex"), expires_at: t + PASE_MS, refresh_expires_at: t + RENOVAR_MS,
    },
  };
}

// ── Rutas ────────────────────────────────────────────────────────────────────
export function registrarOAuth(app: FastifyInstance): void {
  appRef = app;
  const opts = { logLevel: "warn" as const };

  for (const url of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    app.get(url, opts, async (req, reply) => { corsAbierto(reply); return reply.send(metaRecurso(req)); });
    app.options(url, opts, async (_req, reply) => { corsAbierto(reply); return reply.code(204).send(); });
  }
  app.get("/.well-known/oauth-authorization-server", opts, async (req, reply) => { corsAbierto(reply); return reply.send(metaServidor(req)); });
  app.options("/.well-known/oauth-authorization-server", opts, async (_req, reply) => { corsAbierto(reply); return reply.code(204).send(); });

  // Registro SIN estado: todo lo registrado viaja sellado dentro del propio client_id.
  app.options("/oauth/register", opts, async (_req, reply) => { corsAbierto(reply); return reply.code(204).send(); });
  // LIMITE-TASA-1 · ruta pública: tope por IP real (req.ip).
  app.post("/oauth/register", { ...opts, onRequest: frenoPublicoPorIp("/oauth/register", 20) }, async (req, reply) => {
    corsAbierto(reply);
    reply.header("Cache-Control", "no-store");
    const b = cuerpo(req);
    const falla = (error: string, desc: string) => reply.code(400).send({ error, error_description: desc });
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!uris.length || uris.length > 5) return falla("invalid_redirect_uri", "Indica entre 1 y 5 direcciones de vuelta (redirect_uris).");
    if (uris.some((x) => !redirectValido(x))) return falla("invalid_redirect_uri", "Dirección de vuelta no admitida: https, http solo hacia este equipo (localhost) o el esquema propio de una app.");
    const r = uris.map(String);
    const m = METODOS.find((x) => x === (b.token_endpoint_auth_method ?? "none"));
    if (!m) return falla("invalid_client_metadata", "token_endpoint_auth_method admitidos: " + METODOS.join(", ") + ".");
    const gts = Array.isArray(b.grant_types) ? b.grant_types.map(String) : [];
    if (gts.some((g) => g !== "authorization_code" && g !== "refresh_token")) return falla("invalid_client_metadata", "grant_types admitidos: authorization_code y refresh_token.");
    const rts = Array.isArray(b.response_types) ? b.response_types.map(String) : [];
    if (rts.some((x) => x !== "code")) return falla("invalid_client_metadata", "response_types admitido: code.");
    const u0 = new URL(r[0]);
    const n = limpiarNombre(b.client_name) || u0.hostname || u0.protocol.slice(0, -1);
    const t = Math.floor(Date.now() / 1000);
    const client_id = sellar("cli", { n, r, m, t } satisfies Cliente);
    return reply.code(201).send({
      client_id, client_id_issued_at: t, client_name: n, redirect_uris: r,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: m, scope: ALCANCES.join(" "),
      ...(m !== "none" ? { client_secret: secretoDe(client_id), client_secret_expires_at: 0 } : {}),
    });
  });

  app.get("/oauth/authorize", opts, async (req, reply) => {
    const v = validarPeticion(req, (req.query || {}) as Record<string, unknown>);
    if ("pagina" in v) return aviso(reply, 400, "No se ha podido conectar", v.pagina);
    if ("redirigir" in v) { reply.header("Cache-Control", "no-store"); return reply.redirect(v.redirigir, 302); }
    const ses = await sesionPanel(req);
    // Sin sesión: al login del panel, que vuelve aquí (siguienteSeguro solo admite esta ruta).
    if (!ses) { reply.header("Cache-Control", "no-store"); return reply.redirect("/admin/login?next=" + encodeURIComponent(req.url), 302); }
    const negocios = await negociosDe(req);
    if (!negocios.length) return aviso(reply, 403, "No puedes conectar una IA", "Tu usuario no tiene permiso para conectar IA en ningún negocio. Pídeselo a quien administra tu cuenta.");
    return consentimiento(req, reply, v, ses, negocios);
  });

  // LIMITE-TASA-1 · ruta pública: tope por IP real (req.ip).
  app.post("/oauth/authorize", { ...opts, onRequest: frenoPublicoPorIp("/oauth/authorize", 30) }, async (req, reply) => {
    const base = baseDe(req);
    const origen = req.headers.origin;
    if (origen ? origen !== base : req.headers["sec-fetch-site"] !== "same-origin")
      return aviso(reply, 403, "No se ha podido conectar", "La petición no viene de esta página. Vuelve a empezar desde tu IA.");
    const b = cuerpo(req);
    const v = validarPeticion(req, b);
    if ("pagina" in v) return aviso(reply, 400, "No se ha podido conectar", v.pagina);
    if ("redirigir" in v) { reply.header("Cache-Control", "no-store"); return reply.redirect(v.redirigir, 302); }
    const ses = await sesionPanel(req);
    if (!ses) return aviso(reply, 401, "Tu sesión ha caducado", "Vuelve a empezar la conexión desde tu IA.");
    const t = abrir<Csrf>("csrf", b.csrf);
    if (!t || t.u !== ses.uid || t.c !== hashId(v.client_id) || t.r !== v.redirect || !(t.x > Date.now()))
      return aviso(reply, 403, "Esta pantalla ha caducado", "Vuelve a empezar la conexión desde tu IA.");
    reply.header("Cache-Control", "no-store");
    if (b.decision !== "permitir")
      return reply.redirect(urlRetorno(v.redirect, { error: "access_denied", error_description: "Se ha cancelado la conexión.", state: v.state, iss: base }), 302);
    const negocios = await negociosDe(req);
    const neg = negocios.find((n) => n.id === texto(b.ws));
    if (!neg) return aviso(reply, 403, "No se ha podido conectar", "No tienes permiso para conectar una IA en ese negocio.");
    const vivas = await runWithWorkspace(neg.id, () => dbListMcpKeys());
    if (vivas.length >= MAX_CONEXIONES)
      return aviso(reply, 409, "Demasiadas conexiones", "«" + neg.nombre + "» ya tiene " + MAX_CONEXIONES + " IA conectadas. Quita alguna que no uses en Conecta tu IA y vuelve a intentarlo.");
    const scope: Alcance = v.scope === "lectura" || b.nivel === "lectura" ? "lectura" : "completo";
    const q = quienEs(v.cli, v.redirect);
    const code = sellar("code", {
      u: ses.uid, e: ses.email, w: neg.id, s: scope, c: hashId(v.client_id), n: q.nombre, r: v.redirect,
      ch: v.ch, x: Date.now() + CODIGO_MS, k: crypto.randomUUID(), rs: v.rs,
    } satisfies Codigo);
    return reply.redirect(urlRetorno(v.redirect, { code, state: v.state, iss: base }), 302);
  });

  app.options("/oauth/token", opts, async (_req, reply) => { corsAbierto(reply); return reply.code(204).send(); });
  // LIMITE-TASA-1 · ruta pública: tope por IP real (req.ip).
  app.post("/oauth/token", { ...opts, onRequest: frenoPublicoPorIp("/oauth/token", 60) }, async (req, reply) => {
    corsAbierto(reply);
    reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
    const b = cuerpo(req);
    const falla = (st: number, error: string, desc: string) => reply.code(st).send({ error, error_description: desc });

    // La IA se identifica por Basic o en el cuerpo.
    let client_id = texto(b.client_id), secreto = texto(b.client_secret), porBasic = false;
    const mb = String(req.headers.authorization || "").match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
    if (mb) {
      const d = Buffer.from(mb[1], "base64").toString("utf8"), i = d.indexOf(":");
      if (i > 0) {
        try { client_id = decodeURIComponent(d.slice(0, i)); secreto = decodeURIComponent(d.slice(i + 1)); porBasic = true; }
        catch { return falla(401, "invalid_client", "Credenciales del cliente mal formadas."); }
      }
    }
    const cli = abrir<Cliente>("cli", client_id);
    const clienteMalo = (desc: string) => { if (porBasic) reply.header("WWW-Authenticate", "Basic realm=\"oauth\""); return falla(401, "invalid_client", desc); };
    if (!cli) return clienteMalo("Cliente desconocido: vuelve a añadir la conexión en tu IA.");
    if (cli.m !== "none" && !igual(secreto, secretoDe(client_id))) return clienteMalo("El secreto del cliente no es correcto.");
    const base = baseDe(req);
    const rs = texto(b.resource);
    if (rs && !recursoValido(rs, base)) return falla(400, "invalid_target", "Este servidor solo emite pases para " + base + "/mcp.");

    const gt = texto(b.grant_type);
    if (gt === "authorization_code") {
      const c = abrir<Codigo>("code", b.code);
      if (!c || !(c.x > Date.now())) return falla(400, "invalid_grant", "El código no es válido o ha caducado.");
      const previo = usados.get(c.k);
      if (previo) {
        // Un código reutilizado es señal de robo: se apaga lo que se emitió con él.
        if (previo.id) await runWithWorkspace(previo.w, () => dbRevokeMcpKey(previo.id)).catch(() => false);
        return falla(400, "invalid_grant", "Ese código ya se ha usado.");
      }
      if (c.c !== hashId(client_id)) return falla(400, "invalid_grant", "El código es de otro cliente.");
      const ru = texto(b.redirect_uri);
      if (ru && ru !== c.r) return falla(400, "invalid_grant", "La dirección de vuelta no coincide con la de la autorización.");
      const ver = texto(b.code_verifier);
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(ver) || sha256(ver).toString("base64url") !== c.ch)
        return falla(400, "invalid_grant", "La verificación PKCE no coincide.");
      usados.set(c.k, { x: c.x, w: c.w, id: "" });
      const s = await mcpSesion(c.u, c.w).catch((e: Error) => ({ error: e.message || "error interno" }));
      if ("error" in s) return falla(400, "invalid_grant", "La cuenta ya no puede usar ese negocio: " + s.error + ".");
      const p = nuevoPase();
      const rec = await runWithWorkspace(c.w, async () => {
        // La misma IA (mismo registro) que vuelve a conectarse sustituye a su conexión anterior.
        const vivas = await dbListMcpKeys();
        const previas = vivas.filter((k) => k.via === "oauth" && k.user_uid === c.u && k.client_id === c.c);
        if (vivas.length - previas.length >= MAX_CONEXIONES) return null;
        for (const k of previas) await dbRevokeMcpKey(k.id);
        const nueva = await dbCreateMcpKey({
          id: crypto.randomUUID(), user_uid: c.u, user_label: c.e, name: c.n, scope: c.s,
          via: "oauth", client_id: c.c, client_name: c.n, ...p.fila,
        });
        await logActivity({
          source: "app", status: "ok",
          summary: "IA conectada iniciando sesión: «" + c.n + "» (" + (c.s === "lectura" ? "solo consultar" : "consultar y actuar") + ")",
          payload: { file: "mcp-oauth.ts", fn: "POST /oauth/token", id: nueva.id, scope: c.s, sustituye: previas.length },
        }).catch(() => { /* registro best-effort */ });
        return nueva;
      });
      if (!rec) return falla(400, "invalid_grant", "Ese negocio ya tiene " + MAX_CONEXIONES + " IA conectadas.");
      usados.set(c.k, { x: c.x, w: c.w, id: rec.id });
      return reply.send({ access_token: p.acceso, token_type: "Bearer", expires_in: PASE_MS / 1000, refresh_token: p.renovar, scope: c.s });
    }

    if (gt === "refresh_token") {
      const rt = texto(b.refresh_token);
      if (!/^bsr_[A-Za-z0-9_-]{40,64}$/.test(rt)) return falla(400, "invalid_grant", "Pase de renovación no válido.");
      const hash = sha256(rt).toString("hex");
      const k = await dbMcpKeyPorRefresh(hash);
      if (!k) {
        // Un pase de renovación ya rotado que vuelve es señal de robo (RFC 9700 §4.14.2): se
        // apaga la conexión. Salvo en el primer minuto tras rotar: un reintento de la propia IA.
        const viejo = await dbMcpKeyPorRefreshViejo(hash).catch(() => null);
        if (viejo && Date.now() - (viejo.expires_at - PASE_MS) > GRACIA_MS) {
          await runWithWorkspace(viejo.tenant_id, async () => {
            if (!(await dbRevokeMcpKey(viejo.id))) return;
            await logActivity({
              source: "app", status: "error",
              summary: "IA desconectada por seguridad: se reutilizó un pase antiguo de «" + viejo.name + "». Vuelve a conectarla.",
              payload: { file: "mcp-oauth.ts", fn: "POST /oauth/token", id: viejo.id },
            }).catch(() => { /* registro best-effort */ });
          }).catch(() => false);
        }
      }
      if (!k || k.client_id !== hashId(client_id)) return falla(400, "invalid_grant", "Pase de renovación no válido, caducado o de otra conexión.");
      const pedidos = texto(b.scope).split(/\s+/).filter(Boolean);
      if (pedidos.some((x) => !ALCANCES.includes(x as Alcance)) || (k.scope === "lectura" && pedidos.includes("completo")))
        return falla(400, "invalid_scope", "No se puede ampliar el nivel de una conexión al renovarla.");
      const s = await mcpSesion(k.user_uid, k.tenant_id).catch((e: Error) => ({ error: e.message || "error interno" }));
      if ("error" in s) return falla(400, "invalid_grant", "La cuenta ya no puede usar ese negocio: " + s.error + ".");
      const p = nuevoPase();
      if (!(await dbRotarMcpKey(k.id, k.tenant_id, hash, p.fila))) return falla(400, "invalid_grant", "Ese pase de renovación ya se usó.");
      return reply.send({ access_token: p.acceso, token_type: "Bearer", expires_in: PASE_MS / 1000, refresh_token: p.renovar, scope: k.scope });
    }
    return falla(400, "unsupported_grant_type", "grant_type admitidos: authorization_code y refresh_token.");
  });
}
