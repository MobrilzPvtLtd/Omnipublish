/**
 * Link tracker. Envuelve URLs en mensajes salientes con un shortlink propio
 * `https://<dominio>/r/<token>` para registrar cada click por contacto.
 *
 * - `shortenUrl(url, ctx)`: crea/obtiene el shortlink.
 * - `wrapUrlsInText(text, ctx)`: detecta URLs http(s) y las sustituye por shortlinks.
 * - `recordClick(token, req)`: persiste el click.
 * - `redirectUrl(token)`: devuelve la URL destino para hacer 302.
 *
 * Idempotencia: si la misma URL + contexto (kind+id+phone opcional) ya tiene
 * shortlink, lo reusa. Esto evita generar miles de tokens duplicados.
 */
import crypto from "node:crypto";
import * as pg from "pg";
import { pgSsl } from "./pg-ssl.js";
import { get as getSetting, set as setSetting, urlPublica } from "./settings.js";
import { currentWorkspaceId } from "./workspace.js";
import { downloadPublic } from "./public-download.js";

// ---------- Open Graph del destino (PREVIEW-OG-1 / ENLACE-TARJETA-1) ----------
// Vivía en index.ts (solo lo usaba la página que se sirve a los rastreadores de
// previsualización). Ahora también lo usa el motor de flujos para la tarjeta con imagen y
// botón, y flows.ts no puede importar de index.ts (ciclo): aquí no hay dependencias.
/** `fmt` = formato real de la imagen leído de sus bytes ("png" | "jpeg" | ""), `bytes` = peso
 *  total si el servidor lo dice (content-range / content-length; 0 si no se sabe). */
export type OgInfo = { title: string; desc: string; image: string; w: number; h: number; fmt: string; bytes: number };
const _ogCache = new Map<string, OgInfo & { ts: number }>();
const _OG_TTL = 60 * 60 * 1000; // 1 h
function _ogPick(html: string, prop: string): string {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i");
  return (html.match(re)?.[1] || html.match(re2)?.[1] || "").trim();
}
/** Dimensiones de una imagen leyendo solo la cabecera (PNG directo; JPEG busca el SOF). */
export function imageHeaderDimensions(buf: Buffer): { w: number; h: number; fmt: string } {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), fmt: "png" };
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), fmt: "jpeg" };
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return { w: 0, h: 0, fmt: "jpeg" }; // JPEG sin SOF en los primeros 64 KB: formato sí, medidas no
    }
  } catch { /* dimensiones desconocidas */ }
  return { w: 0, h: 0, fmt: "" }; // WEBP, GIF, SVG, AVIF…: WhatsApp no los admite como imagen de mensaje
}
/** URL pública de la imagen de cabecera de una tarjeta con botón, re-codificada por el panel
 *  (ruta /og/tarjeta.jpg?u=<base64url> en index.ts): así Meta recibe siempre un JPEG RGB válido. */
export function tarjetaImagenUrl(src: string): string {
  return baseUrl() + "/og/tarjeta.jpg?u=" + Buffer.from(String(src || "")).toString("base64url");
}
/** Formato, medidas y peso de una imagen leyendo solo sus primeros 64 KB (nunca lanza). */
export async function probeImage(image: string): Promise<{ w: number; h: number; fmt: string; bytes: number }> {
  let w = 0, h = 0, fmt = "", bytes = 0;
  try {
    const ir = await downloadPublic(image, { timeoutMs: 5000, maxBytes: 65536, truncate: true, range: "bytes=0-65535" });
    if (ir.ok) {
      const d = imageHeaderDimensions(ir.body);
      w = d.w; h = d.h; fmt = d.fmt;
      const cr = String(ir.headers["content-range"] || "");
      const total = cr.includes("/") ? Number(cr.split("/").pop()) : Number(ir.headers["content-length"] || 0);
      bytes = Number.isFinite(total) && total > 0 ? total : 0;
    }
  } catch { /* sin datos: quien llama decide */ }
  return { w, h, fmt, bytes };
}
const _ogInflight = new Map<string, Promise<OgInfo>>();
/** Título, descripción e imagen (con dimensiones medidas) de una página. Caché 1 h por URL
 *  sin query; un fallo se cachea solo 60 s. Nunca lanza: sin datos devuelve campos vacíos. */
export async function ogForUrl(url: string): Promise<OgInfo> {
  // CLAVE = URL SIN query: el ?p=/?ref= de cada lead no cambia las OG de la página. Antes cada
  // lead disparaba una visita al destino → en ráfaga (live) el hosting nos limitaba y su página
  // de error ("You are being rate limited") acababa CACHEADA 1 h como título de la tarjeta.
  const key = url.split(/[?#]/)[0];
  const hit = _ogCache.get(key);
  // Lo BUENO se cachea 1 h; un fallo solo 60 s (reintento pronto, jamás una tarjeta de error).
  if (hit && Date.now() - hit.ts < (hit.title || hit.image ? _OG_TTL : 60_000)) return hit;
  const inflight = _ogInflight.get(key);
  if (inflight) return inflight; // dedup: una sola visita aunque lleguen N previews a la vez
  const p = (async () => {
    let title = "", desc = "", image = "", w = 0, h = 0, fmt = "", bytes = 0;
    try {
      const r = await downloadPublic(url, { timeoutMs: 6000, maxBytes: 400_000, truncate: true });
      if (r.ok) {
        const html = r.body.toString("utf8");
        title = _ogPick(html, "og:title") || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim();
        desc = _ogPick(html, "og:description") || _ogPick(html, "description");
        image = _ogPick(html, "og:image");
        // Guardia anti-interstitial: si el "título" es una página de error/limitación, se
        // descarta entero (mejor tarjeta plana que una tarjeta rota delante del lead).
        if (/rate.?limit|too many request|access denied|attention required|just a moment|error \d{3}/i.test(title)) { title = ""; desc = ""; image = ""; }
        // og:image relativa o sin esquema («/img/og.png», «//cdn/x.png»): se resuelve contra la
        // URL FINAL (tras redirecciones). Meta exige una URL absoluta https.
        if (image) { try { image = new URL(image, r.url || url).href; } catch { image = ""; } }
        if (image) { const d = await probeImage(image); w = d.w; h = d.h; fmt = d.fmt; bytes = d.bytes; }
      }
    } catch { /* destino caído: OG mínimas, reintento en 60 s */ }
    const out = { ts: Date.now(), title, desc, image, w, h, fmt, bytes };
    _ogCache.set(key, out);
    if (_ogCache.size > 500) { const k = _ogCache.keys().next().value; if (k) _ogCache.delete(k); }
    return out;
  })().finally(() => { _ogInflight.delete(key); });
  _ogInflight.set(key, p);
  return p;
}

const dbUrl = process.env.DATABASE_URL;
const pool = dbUrl
  ? new pg.default.Pool({
      connectionString: dbUrl,
      ssl: pgSsl(),
      max: 3,
    })
  : null;

interface MemShortLink {
  token: string;
  tenant_id: string;
  url: string;
  label: string;
  context_kind: string;
  context_id: string;
  created_at: number;
  archived?: boolean;
}
const memLinks = new Map<string, MemShortLink>();
const memByUrlCtx = new Map<string, string>(); // dedupe key → token
const memClicks: Array<{ token: string; phone: string; ua: string; ip: string; ref: string; created_at: number }> = [];

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

function genToken(): string {
  // 7 chars base36 ≈ 78bn combos. Suficiente para shortlinks no adivinables.
  return crypto.randomBytes(5).toString("hex").slice(0, 7);
}

function baseUrl(): string {
  // DOMINIO-INSTANCIA-1 · una sola fuente de verdad (settings.urlPublica). Antes caía
  // al dominio de la instancia central, así que los enlaces cortos y de pago de un
  // cliente salían apuntando a nuestro servidor: sus clics se perdían allí.
  return urlPublica();
}

export interface ShortenCtx {
  /** kind: 'flow' | 'sequence' | 'wa-trigger' | 'autopost' | 'broadcast' | 'manual' */
  kind?: string;
  /** id del recurso (flow id, sequence id, etc.) */
  id?: string;
  /** label visible en dashboard de clicks (ej: "Botón CTA · Welcome flow") */
  label?: string;
  /** opcional: contacto que va a recibir el link (para dedupe por contacto) */
  phone?: string;
  /** tenant */
  tenant_id?: string;
}

export async function shortenUrl(url: string, ctx: ShortenCtx = {}): Promise<string> {
  // DUENO-ENLACE-1 · El dueño por defecto es el negocio ACTIVO, no `default`.
  // Escribía siempre `default` mientras que todas las lecturas de este mismo
  // fichero filtran por `currentWorkspaceId()`, así que un enlace creado desde
  // otro negocio se guardaba a nombre del primero y luego no aparecía en su
  // propia lista de enlaces, ni sus clics se le atribuían. Todos los que llaman
  // aquí corren ya dentro del ámbito del negocio (el hook de /admin/api/ y los
  // envíos de flujos y difusiones), así que el valor correcto está a mano.
  const tenant = ctx.tenant_id ?? currentWorkspaceId();
  const dedupeKey = `${tenant}::${ctx.kind ?? ""}::${ctx.id ?? ""}::${url}`;

  // ATRIBUCIÓN POR CONTACTO 2026-07-09 · el token del enlace es COMPARTIDO (dedupe
  // por url+contexto), pero cada destinatario recibe su variante con `?p=<phone>`
  // para que el redirector /r/:token registre QUIÉN pulsó (app_link_clicks.phone).
  // Sin esto el phone quedaba siempre vacío y solo teníamos el conteo, no la lista
  // de asistentes. El `?p` NO se guarda en app_short_links (la fila sigue siendo
  // única por link); solo viaja en la URL entregada a ese contacto.
  const withPhone = (base: string): string =>
    ctx.phone ? `${base}?p=${encodeURIComponent(ctx.phone)}` : base;

  if (!pool) {
    const existing = memByUrlCtx.get(dedupeKey);
    if (existing) return withPhone(`${baseUrl()}/r/${existing}`);
    const token = genToken();
    memLinks.set(token, {
      token,
      tenant_id: tenant,
      url,
      label: ctx.label ?? "",
      context_kind: ctx.kind ?? "",
      context_id: ctx.id ?? "",
      created_at: Date.now(),
    });
    memByUrlCtx.set(dedupeKey, token);
    await heredaOcultoDelGrupo(token, tenant);
    return withPhone(`${baseUrl()}/r/${token}`);
  }

  // Dedupe en pg por (tenant_id, context_kind, context_id, url)
  const dup = await pool.query(
    `SELECT token FROM app_short_links WHERE tenant_id=$1 AND context_kind=$2 AND context_id=$3 AND url=$4 LIMIT 1`,
    [tenant, ctx.kind ?? "", ctx.id ?? "", url],
  );
  if (dup.rows[0]) return withPhone(`${baseUrl()}/r/${dup.rows[0].token}`);

  const token = genToken();
  await pool.query(
    `INSERT INTO app_short_links (token,tenant_id,url,label,context_kind,context_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [token, tenant, url, ctx.label ?? "", ctx.kind ?? "", ctx.id ?? ""],
  );
  await heredaOcultoDelGrupo(token, tenant);
  return withPhone(`${baseUrl()}/r/${token}`);
}

/**
 * Detecta URLs en `text` y las sustituye por shortlinks. Preserva el resto.
 * Si `getSetting('links.wrap_auto')` está vacío o 'off', NO envuelve y
 * devuelve el texto original.
 */
export async function wrapUrlsInText(text: string, ctx: ShortenCtx = {}): Promise<string> {
  if (!text) return text;
  const auto = getSetting("links.wrap_auto");
  if (auto === "off") return text;
  const matches = [...text.matchAll(URL_RE)];
  if (!matches.length) return text;
  const replacements: Array<[string, string]> = [];
  for (const m of matches) {
    const original = m[0];
    // No re-envolver shortlinks propios.
    if (original.includes("/r/")) continue;
    try {
      // ENLACE-PAGO-3 · Si la URL es una página de pago configurada y sabemos QUIÉN la
      // recibe, se convierte en su enlace de pago PERSONAL (token opaco como ?ref= que
      // el webhook de venta devuelve). Así aunque la closer pegue la URL "a pelo" en la
      // Bandeja, el seguimiento de la compra no se pierde por el camino.
      const pay = ctx.phone ? matchPurchaseBase(original) : null;
      const short = pay
        ? (await paymentLinkForContact(pay, { phone: ctx.phone!, tenant_id: ctx.tenant_id })).short
        : await shortenUrl(original, ctx);
      replacements.push([original, short]);
    } catch {
      // best-effort
    }
  }
  let out = text;
  for (const [orig, short] of replacements) {
    out = out.split(orig).join(short);
  }
  return out;
}

/**
 * Etiqueta las URLs de un texto con parámetros UTM, SIN redirect ni acortado.
 *
 * Para YouTube: su política de spam cuenta las URLs "ofuscadas" (un shortlink
 * /r/xxx esconde el destino real) como señal negativa, y al espectador un
 * redirect le genera desconfianza. Aquí se deja el dominio REAL a la vista y
 * solo se le cuelga ?utm_* → el destino (GA4 o el píxel propio /pv) atribuye la
 * visita a "youtube". Se pierde el clic en la tabla de enlaces del panel, pero
 * se gana no arriesgar el canal y una URL limpia y clicable.
 *
 * Idempotente: si la URL ya trae utm_source, no la vuelve a tocar. Respeta el
 * fragmento (#...). No toca URLs que no sean http(s).
 */
export function utmTagUrls(text: string, params: Record<string, string>): string {
  if (!text) return text;
  const pairs = Object.entries(params).filter(([, v]) => v);
  if (!pairs.length) return text;
  const qs = pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return text.replace(URL_RE, (raw) => {
    // Quita puntuación final pegada por el redactor ("...aquí: https://x.com.")
    const trail = (raw.match(/[.,;:!?)\]]+$/) || [""])[0];
    const u = trail ? raw.slice(0, raw.length - trail.length) : raw;
    if (/[?&]utm_source=/i.test(u)) return raw; // ya etiquetada
    const hi = u.indexOf("#");
    const frag = hi >= 0 ? u.slice(hi) : "";
    const base = hi >= 0 ? u.slice(0, hi) : u;
    const sep = base.includes("?") ? "&" : "?";
    return base + sep + qs + frag + trail;
  });
}

export async function redirectUrl(token: string): Promise<{ url: string; tenant_id: string; context_kind: string; context_id: string } | null> {
  if (!pool) {
    const l = memLinks.get(token);
    return l ? { url: l.url, tenant_id: l.tenant_id, context_kind: l.context_kind, context_id: l.context_id } : null;
  }
  const r = await pool.query(`SELECT url, tenant_id, context_kind, context_id FROM app_short_links WHERE token=$1 LIMIT 1`, [token]);
  return r.rows[0]
    ? { url: r.rows[0].url, tenant_id: r.rows[0].tenant_id, context_kind: r.rows[0].context_kind || "", context_id: r.rows[0].context_id || "" }
    : null;
}

// ---------------------------------------------------------------------------
// ENLACE-PAGO · Enlaces de pago personales (los manda la closer a mano).
//
// El enlace corto que ve el cliente NO lleva query ninguna (tampoco ?p=): el
// token del propio shortlink hace de `ref` OPACO. El 302 aterriza en el checkout
// con ?ref=<token>, systeme.io lo guarda en el sourceURL del contacto, y el
// webhook de venta lo devuelve → la compra se cruza con el contacto del panel
// SIN exponer su teléfono en ninguna URL.
//
// Config: setting `purchase.links` (JSON [{label,currency,url,msg}]). Si no
// está, los dos checkouts del curso LeadMatch.
// ---------------------------------------------------------------------------
export interface PurchaseLinkDef {
  /** Identidad ESTABLE del producto. Es lo que manda el panel al pedir un
   *  enlace: sin ella, dos productos en la misma divisa son indistinguibles y
   *  el segundo nunca se puede vender. */
  id: string;
  label: string; // lo que ve la closer en el panel ("Pago EUR")
  currency: string; // 'eur' | 'usd' → etiqueta compra-<divisa> al comprar
  url: string; // página de pago REAL (se respeta su query tal cual)
  msg?: string; // frase que se inserta delante del enlace (opcional)
  /** Web a la que pertenece. Con varias webs, cada producto reparte enlaces
   *  bajo el dominio de la suya y no bajo el del workspace entero. */
  site?: string;
  price?: number; // para calcular ingresos cuando la venta no trae importe
  tag?: string; // etiqueta de compra propia (si no, compra-<id>)
  active?: boolean; // un producto retirado deja de ofrecerse, sin perder su historial
}
/** Identidad estable a partir del nombre o de la URL. Se usa para dar `id` a los
 *  catálogos antiguos, que no lo tenían: mientras no se cambie el nombre ni la
 *  página, el id sale igual y los enlaces ya generados siguen apuntando bien. */
function slugProducto(x: { label?: string; url?: string; currency?: string }): string {
  const base = String(x.label || "").trim() || String(x.url || "").split(/[?#]/)[0].split("/").filter(Boolean).pop() || "producto";
  const s = base.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || ("producto-" + String(x.currency || "").toLowerCase());
}
/**
 * SIN-DEFAULTS-LM-1 · Catálogo de fábrica VACÍO.
 *
 * Aquí vivían los dos checkouts del curso LeadMatch. Con un solo despliegue era
 * cómodo; con una instancia por cliente es un fallo grave: en un panel recién
 * montado y sin catálogo configurado, una closer que pulse «enlace de pago» le
 * manda al contacto NUESTRA página de compra. El dinero, además, iría a la cuenta
 * de otro.
 *
 * Vacío significa que el panel no ofrece ningún producto hasta que el cliente
 * configure el suyo (purchaseLinksConfigurados() ya distinguía este caso y la UI
 * lo enseña). Los checkouts del curso siguen funcionando en la instancia central:
 * están guardados en SU ajuste `purchase.links`, no en el código.
 */
const DEFAULT_PURCHASE_LINKS: PurchaseLinkDef[] = [];
/** ¿El catálogo está configurado de verdad, o son los de fábrica? El panel lo
 *  necesita para no dar por bueno un catálogo que no es del cliente. */
export function purchaseLinksConfigurados(): boolean {
  try {
    const raw = getSetting("purchase.links");
    return !!(raw && Array.isArray(JSON.parse(raw)) && JSON.parse(raw).length);
  } catch { return false; }
}
export async function guardarPurchaseLinks(defs: PurchaseLinkDef[]): Promise<void> {
  await setSetting("purchase.links", JSON.stringify(defs));
}
export function purchaseLinks(): PurchaseLinkDef[] {
  try {
    const raw = getSetting("purchase.links");
    if (raw) {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) {
        const vistos = new Set<string>();
        const out = a
          .map((x) => {
            // Los catálogos guardados antes de PAGO-1 no traen id: se les calcula
            // uno estable a partir del nombre, y si dos chocan se desempata, para
            // que nunca haya dos productos con la misma identidad.
            let id = String(x?.id || "").trim() || slugProducto({ label: x?.label, url: x?.url, currency: x?.currency });
            while (vistos.has(id)) id = id.replace(/-(\d+)$/, (_m, d) => "-" + (Number(d) + 1)) === id ? id + "-2" : id.replace(/-(\d+)$/, (_m, d) => "-" + (Number(d) + 1));
            vistos.add(id);
            const url = String(x?.url || "");
            let site = String(x?.site || "").trim();
            if (!site) { try { site = new URL(url).host; } catch { site = ""; } }
            return {
              id,
              label: String(x?.label || ""),
              currency: String(x?.currency || "").toLowerCase(),
              url,
              msg: x?.msg ? String(x.msg) : undefined,
              site,
              price: Number(x?.price) > 0 ? Number(x.price) : undefined,
              tag: x?.tag ? String(x.tag) : undefined,
              active: x?.active === false ? false : true,
            };
          })
          .filter((x) => x.label && x.url);
        if (out.length) return out;
      }
    }
  } catch {
    /* JSON roto → defaults */
  }
  return DEFAULT_PURCHASE_LINKS;
}
const urlBase = (u: string): string => String(u || "").split(/[?#]/)[0].replace(/\/+$/, "");
/** ¿Esta URL es una de las páginas de pago configuradas? Igualdad de base EXACTA:
 *  la URL de EUR es PREFIJO de la de USD (…-curso / …-curso-usd), así que un
 *  LIKE/startsWith mandaría al cliente al checkout en la divisa equivocada. */
export function matchPurchaseBase(url: string): PurchaseLinkDef | null {
  const b = urlBase(url);
  if (!b) return null;
  return purchaseLinks().find((d) => urlBase(d.url) === b) || null;
}
/** Añade el ?ref= a la URL de pago SIN destrozarla. urlBase() partía por '?' y
 *  se llevaba por delante los parámetros del checkout: un producto que se
 *  identifica con ?plan=pro acababa en el checkout genérico. */
function conRef(url: string, token: string): string {
  const limpia = String(url || "").split("#")[0].replace(/\/+$/, "");
  return limpia + (limpia.includes("?") ? "&" : "?") + "ref=" + token;
}
export async function paymentLinkForContact(
  def: PurchaseLinkDef,
  opts: { phone: string; tenant_id?: string },
): Promise<{ short: string; token: string; existed: boolean }> {
  // DUENO-ENLACE-1 · ver shortenUrl.
  const tenant = opts.tenant_id ?? currentWorkspaceId();
  const base = urlBase(def.url);
  if (!pool) {
    for (const l of memLinks.values()) {
      if (l.tenant_id === tenant && l.context_kind === "payment" && l.context_id === opts.phone && urlBase(l.url) === base)
        return { short: `${baseUrl()}/r/${l.token}`, token: l.token, existed: true };
    }
    const token = genToken();
    memLinks.set(token, {
      token, tenant_id: tenant, url: conRef(def.url, token), label: def.label,
      context_kind: "payment", context_id: opts.phone, created_at: Date.now(),
    });
    await heredaOcultoDelGrupo(token, tenant);
    return { short: `${baseUrl()}/r/${token}`, token, existed: false };
  }
  // Dedupe por contacto + página. La base se compara SIN query (la URL guardada
  // lleva el ?ref=<token>, que es distinto por fila — huevo y gallina si no).
  // Dedupe por PRODUCTO, no por URL recortada: dos productos de la misma web
  // comparten base, así que con la clave vieja el segundo devolvía el enlace del
  // primero. Los enlaces creados antes de PAGO-1 no tienen product_id, así que
  // para ellos se sigue aceptando la coincidencia por base (no se pierde nada).
  const dup = await pool.query(
    `SELECT token FROM app_short_links WHERE tenant_id=$1 AND context_kind='payment' AND context_id=$2
       AND (product_id=$3 OR (product_id='' AND split_part(url,'?',1)=$4)) LIMIT 1`,
    [tenant, opts.phone, def.id, base],
  );
  if (dup.rows[0]) return { short: `${baseUrl()}/r/${dup.rows[0].token}`, token: dup.rows[0].token, existed: true };
  const token = genToken();
  await pool.query(
    `INSERT INTO app_short_links (token,tenant_id,url,label,context_kind,context_id,product_id) VALUES ($1,$2,$3,$4,'payment',$5,$6)`,
    [token, tenant, conRef(def.url, token), def.label, opts.phone, def.id],
  );
  await heredaOcultoDelGrupo(token, tenant);
  return { short: `${baseUrl()}/r/${token}`, token, existed: false };
}
/** Deja constancia de una venta. Es idempotente: el mismo pago no se cuenta dos
 *  veces aunque el webhook reintente (índice único por tenant+teléfono+producto
 *  +id externo). Devuelve true solo si la fila es NUEVA, para no inflar métricas. */
export async function registrarCompra(v: {
  tenant_id: string; phone: string; product_id: string; token: string;
  currency?: string; amount?: number; via?: string; external_id?: string;
}): Promise<boolean> {
  if (!pool) return false;
  try {
    const r = await pool.query(
      `INSERT INTO app_purchases (tenant_id,phone,product_id,token,currency,amount,via,external_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id,phone,product_id,external_id) DO NOTHING RETURNING id`,
      [v.tenant_id || "default", v.phone || "", v.product_id || "", v.token || "",
       (v.currency || "").toLowerCase(), Number(v.amount) || 0, v.via || "", v.external_id || ""],
    );
    return !!r.rows[0];
  } catch { return false; }
}
/** METRICAS-1 · devolución de un pago ya registrado, por su id externo (el mismo pedido que
 *  dejó la venta). Sin importe, se da por devuelto entero. Devuelve cuántas compras tocó. */
export async function registrarDevolucion(tenant: string, externalId: string, importe: number | null): Promise<number> {
  if (!pool || !externalId) return 0;
  try {
    const r = await pool.query(
      `UPDATE app_purchases SET refunded_amount = LEAST(amount, COALESCE($3::numeric, amount))
        WHERE tenant_id=$1 AND external_id=$2 AND external_id<>'' RETURNING id`,
      [tenant || "default", externalId, importe != null && importe > 0 ? importe : null],
    );
    return r.rowCount || 0;
  } catch { return 0; }
}
/** Métricas por producto: enlaces creados, personas a las que se les mandó,
 *  clics, cuántas personas clicaron, último clic, compras e ingresos.
 *
 *  Los enlaces creados ANTES de PAGO-1 no llevan product_id, así que se les
 *  asigna el producto cuyo checkout coincide con su URL. Lo que no case queda en
 *  su propio grupo, sin identificar: inventarle un dueño sería mentir. */
export async function estadisticasDeProductos(sinceMs?: number): Promise<Array<{
  product_id: string; base: string; creados: number; personas: number;
  clics: number; clicaron: number; ultimo_clic: number;
  /** METRICAS-1 · quiénes: al juntar grupos (enlace viejo sin producto + nuevo, URL cambiada,
   *  varios en «sin identificar») se unen estos conjuntos; sumar los recuentos contaba dos veces. */
  ctxs: string[]; telefonos: string[];
}>> {
  if (!pool) return [];
  const tenant = currentWorkspaceId();
  const desde = sinceMs ? new Date(sinceMs) : null;
  const r = await pool.query(
    `SELECT COALESCE(sl.product_id,'') product_id,
            split_part(sl.url,'?',1) base,
            COUNT(DISTINCT sl.token) creados,
            COUNT(DISTINCT sl.context_id) personas,
            COUNT(c.id) clics,
            COUNT(DISTINCT NULLIF(c.phone,'')) clicaron,
            COALESCE(EXTRACT(epoch FROM MAX(c.created_at))*1000,0) ultimo_clic,
            array_remove(array_agg(DISTINCT sl.context_id), NULL) ctxs,
            array_remove(array_agg(DISTINCT NULLIF(c.phone,'')), NULL) telefonos
       FROM app_short_links sl
       LEFT JOIN app_link_clicks c ON c.token=sl.token AND ($2::timestamptz IS NULL OR c.created_at>=$2)
      WHERE sl.tenant_id=$1 AND sl.context_kind='payment'
      GROUP BY 1,2`,
    [tenant, desde],
  );
  return r.rows.map((x: Record<string, unknown>) => ({
    product_id: String(x.product_id || ""),
    base: String(x.base || ""),
    creados: Number(x.creados) || 0,
    personas: Number(x.personas) || 0,
    clics: Number(x.clics) || 0,
    clicaron: Number(x.clicaron) || 0,
    ultimo_clic: Number(x.ultimo_clic) || 0,
    ctxs: Array.isArray(x.ctxs) ? (x.ctxs as unknown[]).map(String) : [],
    telefonos: Array.isArray(x.telefonos) ? (x.telefonos as unknown[]).map(String) : [],
  }));
}
/** Compras e ingresos por producto. Ojo con la lectura: solo existen desde que
 *  se empezó a registrarlas; antes no había dónde guardarlas. */
export interface ImporteMoneda { moneda: string; importe: number }
/** DIVISA-1 · apunta un importe en su moneda dentro de una lista por moneda (la crea si falta). */
export function sumarEnMoneda(lista: ImporteMoneda[], moneda: string, importe: number): ImporteMoneda[] {
  if (!importe) return lista;
  const m = String(moneda || "").toLowerCase();
  const ya = lista.find((x) => x.moneda === m);
  if (ya) ya.importe = Math.round((ya.importe + importe) * 100) / 100;
  else lista.push({ moneda: m, importe: Math.round(importe * 100) / 100 });
  return lista;
}
export async function comprasDeProductos(sinceMs?: number): Promise<Array<{ product_id: string; compras: number; ingresos: number; ultima: number; por_moneda: ImporteMoneda[] }>> {
  if (!pool) return [];
  const desde = sinceMs ? new Date(sinceMs) : null;
  // DIVISA-1 · una fila por producto Y moneda. «ingresos» sigue siendo la suma de siempre (los
  // importes tal cual, sin mirar la moneda: lo conserva quien ya lo leía); «por_moneda» es lo
  // que el panel suma de verdad, convertido al cambio del día.
  const r = await pool.query(
    `SELECT product_id, lower(currency) moneda, COUNT(*) FILTER (WHERE NOT (refunded_amount IS NOT NULL AND refunded_amount >= amount)) compras, COALESCE(SUM((amount - LEAST(amount, COALESCE(refunded_amount,0)))),0) importe,
            COALESCE(SUM(SUM((amount - LEAST(amount, COALESCE(refunded_amount,0))))) OVER (PARTITION BY product_id),0) ingresos,
            COALESCE(EXTRACT(epoch FROM MAX(created_at))*1000,0) ultima
       FROM app_purchases
      WHERE tenant_id=$1 AND ($2::timestamptz IS NULL OR created_at>=$2)
      GROUP BY 1,2
      ORDER BY 1,2`,
    [currentWorkspaceId(), desde],
  );
  const porProducto = new Map<string, { product_id: string; compras: number; ingresos: number; ultima: number; por_moneda: ImporteMoneda[] }>();
  for (const x of r.rows as Array<Record<string, unknown>>) {
    const id = String(x.product_id || "");
    const f = porProducto.get(id) || { product_id: id, compras: 0, ingresos: Number(x.ingresos) || 0, ultima: 0, por_moneda: [] };
    f.compras += Number(x.compras) || 0;
    f.ultima = Math.max(f.ultima, Number(x.ultima) || 0);
    sumarEnMoneda(f.por_moneda, String(x.moneda || ""), Number(x.importe) || 0);
    porProducto.set(id, f);
  }
  return [...porProducto.values()];
}
/** La base de una URL de checkout: sin query, sin barra final y en minúsculas.
 *  Es la que empareja los enlaces viejos (sin product_id) con su producto. */
function baseDeUrl(u: string): string {
  return String(u || "").split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
}
export interface FilaDeProducto {
  phone: string; name: string; stage: string;
  token: string; creado: number;
  clics: number; primer_clic: number; ultimo_clic: number;
  compro: boolean; importe: number; moneda: string; comprado_en: number; via: string;
  // ENL-05-ENLACES-1 · el enlace personal tal como se manda (dirección corta, SIN el
  // teléfono: el vínculo con el contacto lo guarda el sistema, no la URL) y cuántas
  // compras distintas tiene esa persona de este producto. Sin esto último, la fila del
  // catálogo contaba compras y el detalle contaba personas, y los dos números no
  // cuadraban en cuanto alguien compraba dos veces.
  url_corta: string; ncompras: number;
  // DIVISA-1 · lo que pagó esa persona, moneda a moneda. «importe» y «moneda» se quedan como
  // estaban (la suma cruda y UNA de sus monedas): quien pagó en dos monedas solo cuadra aquí.
  por_moneda: ImporteMoneda[];
}
/**
 * PAGO-5 · Detalle de UN producto, persona a persona. La fila de la tabla dice
 * «12 enlaces, 9 personas, 30 clics, 2 compras»; esto dice QUIÉNES son esos 12,
 * cuál de ellos no ha abierto todavía y cuál acabó pagando — que es lo único que
 * se puede accionar.
 *
 * El emparejamiento es EXACTAMENTE el mismo que usa la tabla (product_id, y para
 * los enlaces anteriores a PAGO-1 la base de la URL del checkout). Si aquí se
 * emparejara distinto, el popup enseñaría menos gente de la que promete su fila
 * y no habría forma de saber cuál de los dos números miente.
 *
 * `productId` vacío o «__sin_identificar__» abre el cajón de los huérfanos: los
 * enlaces de pago que ya no corresponden a ningún producto del catálogo.
 */
export interface ComprasSinContacto { n: number; importe: number; moneda: string; por_moneda: ImporteMoneda[] }
export async function detalleDeProducto(productId: string, sinceMs?: number): Promise<{
  gente: FilaDeProducto[]; recortado?: boolean; timeline: number[]; anon: number; sin_contacto: ComprasSinContacto;
}> {
  const vacio = { gente: [] as FilaDeProducto[], timeline: [] as number[], anon: 0, sin_contacto: { n: 0, importe: 0, moneda: "", por_moneda: [] as ImporteMoneda[] } };
  if (!pool) return vacio;
  const tenant = currentWorkspaceId();
  const desde = sinceMs ? new Date(sinceMs) : null;
  const defs = purchaseLinks();
  const huerfano = !productId || productId === "__sin_identificar__";
  // Qué enlaces son de este producto. Los MISMOS dos parámetros en los dos casos
  // (id y lista de bases) para que el SQL tenga siempre $3 y $4: un placeholder
  // que se queda sin usar en una rama hace que Postgres no pueda deducir su tipo
  // y reviente el bind.
  const bases = defs.map((d) => baseDeUrl(d.url));
  const suyo = defs.find((d) => d.id === productId);
  // La base en SQL tiene que salir EXACTAMENTE igual que baseDeUrl(): sin query,
  // sin ancla, sin barra final y en minúsculas. Un rtrim de menos y el popup
  // enseñaría menos gente de la que promete su propia fila, sin forma de saber
  // cuál de los dos números miente.
  const BASE_SQL = `rtrim(split_part(split_part(lower(sl.url),'?',1),'#',1),'/')`;
  // Mismo reparto que hace la tabla en /admin/api/payment-products: un enlace es
  // de este producto por product_id, o —si nació antes de PAGO-1 y no lo lleva—
  // porque su checkout es el de este producto. Lo que no case por ninguna de las
  // dos vías cae en «sin identificar».
  // Huérfano = todo lo que no es de ningún producto del catálogo: el product_id
  // vacío cuyo checkout tampoco casa con ninguno, y el product_id de un producto
  // que se quitó del catálogo.
  //
  // Los DOS caminos usan exactamente $1..$4, y cada placeholder lleva su tipo
  // escrito: un $n que se quede sin usar en una rama hace que Postgres no pueda
  // deducir su tipo y reviente el bind, y sobrar un parámetro también.
  //   $3 = el id del producto (huérfano: la lista de ids vivos)
  //   $4 = las bases de checkout con las que emparejar los enlaces sin id
  const ids = defs.map((d) => d.id);
  const cond = huerfano
    ? `(NOT (sl.product_id = ANY($3::text[])) AND NOT (sl.product_id='' AND ${BASE_SQL} = ANY($4::text[])))`
    : `(sl.product_id = ANY($3::text[]) OR (sl.product_id='' AND ${BASE_SQL} = ANY($4::text[])))`;
  const p3: string[] = huerfano ? ids : [productId];
  const p4: string[] = huerfano ? bases : suyo ? [baseDeUrl(suyo.url)] : [];
  // Una fila por PERSONA (context_id de un enlace de pago = su teléfono). Si a
  // alguien se le generó el enlace dos veces, se queda el más reciente y sus
  // clics se suman: dos filas de la misma persona serían la misma persona
  // contada dos veces, que es justo lo que la columna «Personas» no hace.
  const r = await pool.query(
    `WITH mios AS (
       SELECT sl.token, sl.context_id phone, sl.url,
              extract(epoch from sl.created_at)*1000 creado
         FROM app_short_links sl
        WHERE sl.tenant_id=$1 AND sl.context_kind='payment' AND ${cond}
     ), clics AS (
       SELECT c.token, COUNT(*)::int n,
              extract(epoch from MIN(c.created_at))*1000 primero,
              extract(epoch from MAX(c.created_at))*1000 ultimo
         FROM app_link_clicks c JOIN mios m ON m.token=c.token
        WHERE c.tenant_id=$1 AND ($2::timestamptz IS NULL OR c.created_at>=$2)
        GROUP BY c.token
     )
     SELECT m.phone,
            COALESCE(ct.name,'') name,
            COALESCE(ct.stage,'') stage,
            (array_agg(m.token ORDER BY m.creado DESC))[1] token,
            MAX(m.creado) creado,
            COALESCE(SUM(cl.n),0)::int clics,
            COALESCE(MIN(cl.primero),0) primer_clic,
            COALESCE(MAX(cl.ultimo),0) ultimo_clic
       FROM mios m
       LEFT JOIN clics cl ON cl.token=m.token
       LEFT JOIN app_contacts ct ON ct.phone=m.phone AND ct.tenant_id=$1
      GROUP BY m.phone, ct.name, ct.stage
      ORDER BY 8 DESC, 5 DESC
      LIMIT 501`,
    [tenant, desde, p3, p4],
  );
  // Compras del producto, para cruzarlas por teléfono. Van aparte porque una
  // compra puede llegar sin enlace (pago directo en la web) y aun así es suya.
  // ENL-05-ENLACES-1 · COUNT(*) por persona: la fila del catálogo cuenta COMPRAS
  // (cada pago confirmado), así que el detalle tiene que poder contar lo mismo.
  const cq = await pool.query(
    `SELECT phone, (COUNT(*) FILTER (WHERE NOT (refunded_amount IS NOT NULL AND refunded_amount >= amount)))::int n, COALESCE(SUM((amount - LEAST(amount, COALESCE(refunded_amount,0)))),0) importe,
            COALESCE(MAX(currency),'') moneda, COALESCE(MAX(via),'') via,
            extract(epoch from MAX(created_at))*1000 cuando
       FROM app_purchases
      WHERE tenant_id=$1 AND ($2::timestamptz IS NULL OR created_at>=$2)
        AND ${huerfano ? "NOT (product_id = ANY($3::text[]))" : "product_id = ANY($3::text[])"}
      GROUP BY phone`,
    [tenant, desde, p3],
  );
  // DIVISA-1 · las mismas compras partidas por moneda. La consulta de arriba suma los importes
  // sin mirarla y se queda con UNA moneda por persona (MAX): quien pagó una vez en euros y otra
  // en dólares salía con las dos cifras sumadas y una sola etiqueta. Mismo filtro, mismo tenant.
  const mq = await pool.query(
    `SELECT phone, lower(currency) moneda, COALESCE(SUM((amount - LEAST(amount, COALESCE(refunded_amount,0)))),0) importe
       FROM app_purchases
      WHERE tenant_id=$1 AND ($2::timestamptz IS NULL OR created_at>=$2)
        AND ${huerfano ? "NOT (product_id = ANY($3::text[]))" : "product_id = ANY($3::text[])"}
      GROUP BY 1,2
      ORDER BY 1,2`,
    [tenant, desde, p3],
  );
  const porMoneda = new Map<string, ImporteMoneda[]>();
  for (const x of mq.rows) {
    const k = String(x.phone || "");
    porMoneda.set(k, sumarEnMoneda(porMoneda.get(k) || [], String(x.moneda || ""), Number(x.importe) || 0));
  }
  const compras = new Map<string, { n: number; importe: number; moneda: string; via: string; cuando: number; por_moneda: ImporteMoneda[] }>();
  for (const x of cq.rows) {
    if (!(Number(x.n) > 0)) continue; // METRICAS-1 · lo devolvió todo: no cuenta como comprador
    compras.set(String(x.phone || ""), {
      n: Number(x.n) || 0,
      importe: Number(x.importe) || 0, moneda: String(x.moneda || ""),
      via: String(x.via || ""), cuando: Number(x.cuando) || 0,
      por_moneda: porMoneda.get(String(x.phone || "")) || [],
    });
  }
  // Línea de tiempo de los clics (se agrupa por hora en el panel) y los clics
  // sin teléfono, que existen y no se esconden.
  const tl = await pool.query(
    `SELECT extract(epoch from c.created_at)*1000 t, c.phone
       FROM app_link_clicks c
       JOIN app_short_links sl ON sl.token=c.token
      WHERE c.tenant_id=$1 AND sl.tenant_id=$1 AND sl.context_kind='payment' AND ${cond}
        AND ($2::timestamptz IS NULL OR c.created_at>=$2)
      ORDER BY c.created_at DESC LIMIT 5000`,
    [tenant, desde, p3, p4],
  );
  // METRICAS-1 · la lista se corta en 500 personas, y se dice. Y quien compró y quedó fuera del
  // corte SÍ tenía enlace: sin mirarlo, salía al final como «pagó sin enlace».
  const recortado = r.rows.length > 500;
  const conEnlaceFuera = new Set<string>();
  if (recortado) {
    const fx = await pool.query(
      `SELECT DISTINCT sl.context_id phone FROM app_short_links sl
        WHERE sl.tenant_id=$1 AND sl.context_kind='payment' AND ${cond}
          AND $2::timestamptz IS NOT DISTINCT FROM $2::timestamptz`, // igual que «mios»: sin fecha; $2 solo para tiparlo
      [tenant, desde, p3, p4],
    );
    for (const x of fx.rows) conEnlaceFuera.add(String(x.phone || ""));
  }
  const gente: FilaDeProducto[] = r.rows.slice(0, 500).map((x: Record<string, unknown>) => {
    const phone = String(x.phone || "");
    const c = compras.get(phone);
    const token = String(x.token || "");
    return {
      phone, name: String(x.name || ""), stage: String(x.stage || ""),
      token, creado: Number(x.creado) || 0,
      clics: Number(x.clics) || 0,
      primer_clic: Number(x.primer_clic) || 0,
      ultimo_clic: Number(x.ultimo_clic) || 0,
      compro: !!c, importe: c ? c.importe : 0, moneda: c ? c.moneda : "",
      comprado_en: c ? c.cuando : 0, via: c ? c.via : "",
      url_corta: token ? `${baseUrl()}/r/${token}` : "", ncompras: c ? c.n : 0,
      por_moneda: c ? c.por_moneda : [],
    };
  });
  // Compras de gente a la que este panel nunca le generó un enlace (pago directo
  // en la web). Se añaden al final: esconderlas descuadraría «compras» contra la
  // lista de personas y parecería un fallo de la tabla.
  const conEnlace = new Set(gente.map((g) => g.phone));
  for (const [phone, c] of compras) {
    if (!phone || conEnlace.has(phone) || conEnlaceFuera.has(phone)) continue;
    gente.push({
      phone, name: "", stage: "", token: "", creado: 0,
      clics: 0, primer_clic: 0, ultimo_clic: 0,
      compro: true, importe: c.importe, moneda: c.moneda, comprado_en: c.cuando, via: c.via,
      url_corta: "", ncompras: c.n, por_moneda: c.por_moneda,
    });
  }
  // ENL-05-ENLACES-1 · Compras que llegaron sin teléfono (pago anónimo): cuentan en
  // la fila del catálogo y no tienen persona a la que colgarlas. Se declaran aparte
  // en vez de callarlas, o el detalle prometería menos compras que su fila.
  const anonimas = compras.get("");
  return {
    gente, recortado,
    timeline: tl.rows.map((x: Record<string, unknown>) => Number(x.t)),
    anon: tl.rows.filter((x: Record<string, unknown>) => !String(x.phone || "")).length,
    sin_contacto: anonimas
      ? { n: anonimas.n, importe: anonimas.importe, moneda: anonimas.moneda, por_moneda: anonimas.por_moneda }
      : { n: 0, importe: 0, moneda: "", por_moneda: [] },
  };
}
/** Qué productos ha comprado YA este contacto. Sirve para que el aviso de «ya
 *  compró» sea POR PRODUCTO: al que ya te compró una cosa es a quien más sentido
 *  tiene ofrecerle la siguiente, y el aviso global decía justo lo contrario. */
export async function comprasDeContacto(phone: string): Promise<string[]> {
  if (!pool || !phone) return [];
  try {
    const r = await pool.query(
      `SELECT DISTINCT product_id FROM app_purchases WHERE tenant_id=$1 AND phone=$2`,
      [currentWorkspaceId(), phone],
    );
    return r.rows.map((x: Record<string, unknown>) => String(x.product_id || "")).filter(Boolean);
  } catch { return []; }
}
/** Enlaces de pago ya generados para un contacto (para avisar a la closer de que
 *  ese cliente ya recibió el de la otra divisa, p.ej.). */
export async function paymentLinksForPhone(
  phone: string,
  tenant_id?: string,
): Promise<Array<{ token: string; url: string; label: string; created_at: number }>> {
  // DUENO-ENLACE-1 · ver shortenUrl.
  const tenant = tenant_id ?? currentWorkspaceId();
  if (!pool) {
    return [...memLinks.values()]
      .filter((l) => l.tenant_id === tenant && l.context_kind === "payment" && l.context_id === phone)
      .map((l) => ({ token: l.token, url: l.url, label: l.label, created_at: l.created_at }));
  }
  const r = await pool.query(
    `SELECT token,url,label, extract(epoch from created_at)*1000 created_at
     FROM app_short_links WHERE tenant_id=$1 AND context_kind='payment' AND context_id=$2 ORDER BY created_at DESC`,
    [tenant, phone],
  );
  return r.rows.map((x: any) => ({ token: x.token, url: x.url, label: x.label, created_at: Number(x.created_at) }));
}
/** Resuelve un `ref` de webhook a su contacto SI es un token de enlace de pago.
 *  Un ref con otra pinta (p.ej. el teléfono de los enlaces de registro) devuelve
 *  null y sigue su camino habitual — jerarquía estricta, nunca se confunden. */
export async function resolvePaymentToken(
  token: string,
): Promise<{ phone: string; tenant_id: string; label: string; url: string; product_id: string } | null> {
  const t = String(token || "").trim();
  if (!t || !/^[a-z0-9]{4,16}$/i.test(t)) return null;
  if (!pool) {
    const l = memLinks.get(t);
    return l && l.context_kind === "payment" ? { phone: l.context_id, tenant_id: l.tenant_id, label: l.label, url: l.url, product_id: "" } : null;
  }
  const r = await pool.query(
    `SELECT context_id, tenant_id, label, url, COALESCE(product_id,'') product_id FROM app_short_links WHERE token=$1 AND context_kind='payment' LIMIT 1`,
    [t],
  );
  return r.rows[0]
    ? { phone: r.rows[0].context_id, tenant_id: r.rows[0].tenant_id, label: r.rows[0].label, url: r.rows[0].url, product_id: String(r.rows[0].product_id || "") }
    : null;
}

/**
 * Crawlers que abren el enlace SIN que nadie lo haya tocado.
 *
 * Cuando el bot manda un mensaje con `preview_url: true`, los servidores de Meta
 * visitan la URL para construir la tarjeta de vista previa. Como nuestros shortlinks
 * llevan `?p=<teléfono>`, esa visita es una URL distinta por destinatario → sin este
 * filtro se registraría como un CLIC de esa persona, y las métricas de "abrieron el
 * enlace" (LIVE · Asistencia) contarían gente que no ha pulsado nada.
 *
 * Un clic de un robot no es un clic. Se redirige igual, pero no se cuenta.
 *
 * CLIC-NAVEGADOR-APP-1 · «Instagram» NO va en esta lista: es el navegador interno de la
 * app, el que se abre cuando una PERSONA pulsa el enlace en el DM. La vista previa de
 * Meta llega como `facebookexternalhit`, que ya está. Con «Instagram» dentro, el último flujo AHORRADOR (comentario de IG → DM) marcaba 12
 * «personas que clicaron» de 155: solo contaban los que abrían el enlace fuera de la app.
 * Arnés: scripts/test-clic-navegador-app.mjs.
 */
const BOT_UA = /facebookexternalhit|facebookcatalog|WhatsApp|Twitterbot|LinkedInBot|TelegramBot|Slackbot|Discordbot|SkypeUriPreview|Googlebot|bingbot|AhrefsBot|SemrushBot|Applebot|redditbot|Pinterest|preview|crawler|spider|bot\b/i;

/** ¿La visita la hizo un robot (previsualizador / indexador) y no una persona? */
export function isBotUa(ua: string): boolean {
  return !!ua && BOT_UA.test(ua);
}

export async function recordClick(token: string, meta: { phone?: string; ua?: string; ip?: string; ref?: string; tenant_id?: string }): Promise<void> {
  // No contamos las visitas de los previsualizadores. El redirect sigue funcionando
  // (esto solo decide si se apunta el clic), así que la vista previa no se rompe.
  if (isBotUa(meta.ua ?? "")) return;
  if (!pool) {
    memClicks.push({
      token,
      phone: meta.phone ?? "",
      ua: meta.ua ?? "",
      ip: meta.ip ?? "",
      ref: meta.ref ?? "",
      created_at: Date.now(),
    });
    return;
  }
  await pool.query(
    `INSERT INTO app_link_clicks (tenant_id,token,phone,user_agent,ip,ref) VALUES ($1,$2,$3,$4,$5,$6)`,
    // DUENO-ENLACE-1 · ver shortenUrl.
    [meta.tenant_id ?? currentWorkspaceId(), token, meta.phone ?? "", meta.ua ?? "", meta.ip ?? "", meta.ref ?? ""],
  );
}

// OFERTA-YT-1 (MET-YT-05) · Enlaces con seguimiento de UN vídeo de YouTube: los crea su ficha
// (shortenUrl con kind 'youtube' e id = el del vídeo) y el redirector /r/ apunta sus clics. La
// persona de un clic es su teléfono si el enlace lo llevaba; si no, la huella ip+navegador (la
// misma que usa el píxel para el visitante): quien pulsa tres veces es una persona, no tres.
export async function enlacesYtDeVideo(videoId: string): Promise<Array<{ token: string; url: string; label: string; created_at: number }>> {
  const tenant = currentWorkspaceId();
  if (!videoId) return [];
  if (!pool) {
    return [...memLinks.values()]
      .filter((l) => l.tenant_id === tenant && l.context_kind === "youtube" && l.context_id === videoId)
      .sort((a, b) => a.created_at - b.created_at)
      .map((l) => ({ token: l.token, url: l.url, label: l.label, created_at: l.created_at }));
  }
  const r = await pool.query(
    `SELECT token, url, label, created_at FROM app_short_links WHERE tenant_id=$1 AND context_kind='youtube' AND context_id=$2 ORDER BY created_at LIMIT 200`,
    [tenant, videoId],
  );
  return r.rows.map((x: any) => ({ token: String(x.token), url: String(x.url), label: String(x.label || ""), created_at: new Date(x.created_at).getTime() }));
}

const personaDeClic = (phone: string, ip: string, ua: string): string => {
  const ph = String(phone || "").replace(/[^\d]/g, "");
  return ph ? "p" + ph : "v" + crypto.createHash("sha256").update(`${ip || ""}|${ua || ""}`).digest("hex").slice(0, 16);
};

/** Clics de personas (los previsualizadores ya no se apuntan) en los enlaces de un vídeo, en [desde, hasta). */
export async function clicsYtDeVideo(videoId: string, sinceMs: number, untilMs: number): Promise<Array<{ at: number; persona: string; url: string; ua: string }>> {
  const tenant = currentWorkspaceId();
  if (!videoId) return [];
  if (!pool) {
    const mios = new Map([...memLinks.values()].filter((l) => l.tenant_id === tenant && l.context_kind === "youtube" && l.context_id === videoId).map((l) => [l.token, l.url]));
    return memClicks
      .filter((c) => mios.has(c.token) && c.created_at >= sinceMs && c.created_at < untilMs)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 5000)
      .map((c) => ({ at: c.created_at, persona: personaDeClic(c.phone, c.ip, c.ua), url: mios.get(c.token) || "", ua: c.ua }));
  }
  const r = await pool.query(
    `SELECT c.created_at, c.phone, c.ip, c.user_agent, l.url
       FROM app_link_clicks c JOIN app_short_links l ON l.token=c.token AND l.tenant_id=$1
      WHERE c.tenant_id=$1 AND l.context_kind='youtube' AND l.context_id=$2
        AND c.created_at >= to_timestamp($3::double precision/1000) AND c.created_at < to_timestamp($4::double precision/1000)
      ORDER BY c.created_at DESC LIMIT 5000`,
    [tenant, videoId, sinceMs, untilMs],
  );
  return r.rows.map((x: any) => ({ at: new Date(x.created_at).getTime(), persona: personaDeClic(x.phone, x.ip, x.user_agent), url: String(x.url || ""), ua: String(x.user_agent || "") }));
}

/** Las direcciones de un texto (la descripción de un vídeo), sin la puntuación pegada al final y sin repetir. */
export function enlacesDeTexto(texto: string, max = 20): string[] {
  const out: string[] = [];
  for (const m of String(texto || "").match(URL_RE) || []) {
    const u = m.replace(/[)\].,;:!?»"'’]+$/, "");
    if (u.length > 10 && !out.includes(u)) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

/** El token si `url` es un enlace corto de ESTA instancia (<urlPublica>/r/<token>); "" si no. */
export function tokenDeEnlaceCorto(url: string): string {
  try {
    const u = new URL(url), b = new URL(baseUrl());
    if (u.host.toLowerCase() !== b.host.toLowerCase()) return "";
    const m = u.pathname.match(/^\/r\/([A-Za-z0-9_-]{4,40})\/?$/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

/** ENLACE-ABIERTO-2 · Filtros opcionales de «¿abrió el enlace?». `urlContains` = trozo de la
 *  dirección DESTINO (sin distinguir mayúsculas) que debe llevar el enlace pulsado; `sinceMs` =
 *  solo cuentan clics desde ese instante (epoch ms del reloj de Node). Vacío / 0 = sin filtro
 *  (como siempre). En Postgres el instante se convierte a una antigüedad («hace N ms») para no
 *  comparar el reloj de Node con el de la base: cada duración se mide en su propio reloj. */
export interface LinkOpenedFilter { urlContains?: string; sinceMs?: number }

/** ENLACE-ABIERTO-1 · ¿Este contacto ha pulsado ALGÚN enlace de este flujo? Clics reales del
 *  acortador (/r/<token>?p=<teléfono>) atribuidos al flujo (context_kind='flow'). Los bots de
 *  previsualización no cuentan (recordClick ya los filtra). Nunca lanza: sin datos = false.
 *  ENLACE-ABIERTO-2 · con `filtro` se acota a UN enlace (por su dirección) y/o a una ventana de
 *  tiempo: dos botones con la misma dirección comparten token (dedupe por url+flujo), así que
 *  la única forma de distinguir «el enlace de ESTE mensaje» es el instante en que se envió. */
export async function phoneOpenedFlowLink(phone: string, flowId: string, filtro: LinkOpenedFilter = {}): Promise<boolean> {
  const dig = (s: string) => String(s || "").replace(/[^\d]/g, "");
  const ph = dig(phone);
  if (!ph || !flowId) return false;
  const trozo = String(filtro.urlContains || "").trim().toLowerCase();
  const desde = Math.max(0, Math.floor(Number(filtro.sinceMs) || 0));
  if (!pool) {
    return memClicks.some((c) => {
      if (dig(c.phone) !== ph) return false;
      if (desde && c.created_at < desde) return false;
      const l = memLinks.get(c.token);
      if (!l || l.context_kind !== "flow" || String(l.context_id || "") !== flowId) return false;
      return !trozo || String(l.url || "").toLowerCase().includes(trozo);
    });
  }
  // El clic se graba con el reloj de Postgres (created_at DEFAULT now()) y `desde` viene del
  // reloj de Node: comparar instantes mezclaría dos relojes y un desfase de >1 s bastaría para
  // perder un clic real. Se compara una ANTIGÜEDAD: «hace cuántos ms fue `desde`» (medido en
  // Node) contra now()-created_at (medido en Postgres). Cada duración va con su propio reloj y el
  // desfase entre ambos se anula; solo queda la latencia de la consulta, cubierta por el margen.
  const antiguedadMs = desde ? Math.max(1, Date.now() - desde) : 0;
  try {
    const r = await pool.query(
      `SELECT 1 FROM app_link_clicks c JOIN app_short_links sl ON sl.token=c.token
       WHERE sl.context_kind='flow' AND sl.context_id=$1 AND sl.tenant_id=$2 AND regexp_replace(COALESCE(c.phone,''),'\\D','','g')=$3
         AND ($4::text = '' OR strpos(lower(sl.url), $4::text) > 0)
         AND ($5::double precision = 0 OR c.created_at >= now() - ($5::double precision * interval '1 millisecond'))
       LIMIT 1`,
      [flowId, currentWorkspaceId(), ph, trozo, antiguedadMs],
    );
    return (r.rowCount || 0) > 0;
  } catch (e) {
    console.warn("[links] phoneOpenedFlowLink:", (e as Error).message);
    return false;
  }
}

export interface LinkSummary {
  token: string;
  url: string;
  label: string;
  context_kind: string;
  context_id: string;
  clicks: number;
  last_click_at: number | null;
  created_at: number;
  archived: boolean;
}

/** Destino sin el `?ref=`, que es lo ÚNICO que cambia de una persona a otra.
 *  Se conservan el resto de parámetros (utm_*, og…): dos variantes UTM son dos
 *  enlaces distintos a propósito, y el dueño las creó así. */
export function destinoCanonico(url: string): string {
  return String(url || "")
    .replace(/([?&])ref=[^&]*/g, "$1")
    .replace(/\?&/g, "?")
    .replace(/[?&]+$/, "");
}

/** La misma canonicalización, en SQL. Se usa dos veces (listar y agregar), así
 *  que vive en una constante para que no puedan desincronizarse. */
const SQL_DESTINO =
  "regexp_replace(regexp_replace(regexp_replace(sl.url, '([?&])ref=[^&]*', '\\1', 'g'), '\\?&', '?'), '[?&]+$', '')";
/** Clave de contexto: para los enlaces de PAGO el context_id es el teléfono del
 *  contacto, así que agruparlos por él no agruparía nada; se usa el producto. */
const SQL_CTXKEY =
  "CASE WHEN sl.context_kind='payment' THEN COALESCE(sl.product_id,'') ELSE COALESCE(sl.context_id,'') END";

export interface LinkGroup extends LinkSummary {
  /** Cuántos enlaces personales componen el grupo (1 = enlace único). */
  enlaces: number;
  /** Personas distintas que lo abrieron, contadas SIN duplicar entre enlaces. */
  personas: number;
  /** Destino canónico (sin ?ref=) — lo que un humano llamaría «el enlace». */
  dest: string;
  /** Todos sus enlaces están ocultos (para que ocultar un grupo signifique algo). */
  archivadoTodo: boolean;
  /** ENL-02 · Enlaces de PAGO: el producto por el que se agrupa (vacío en los
   *  anteriores a PAGO-1 y en el resto de tipos). Con él la lista y «Productos y
   *  pagos» señalan el MISMO producto. */
  product_id: string;
  /** ENL-04-PERIODO-1 · cuándo se creó el PRIMER enlace del grupo (created_at es el último). */
  primer_creado: number;
}

/** Lista los enlaces AGRUPADOS por enlace real. El LIMIT se aplica a los
 *  GRUPOS, no a los tokens: por eso no vale agrupar en el cliente.
 *  ENL-04-PERIODO-1 · con `desdeMs`, `clicks` y `personas` cuentan SOLO los clics desde esa
 *  fecha (las cifras del periodo que enseña la lista). `last_click_at` y las fechas de creación
 *  no se recortan: dicen CUÁNDO, no cuántos, y el orden «Recientes» se apoya en ellas.
 *  ENL-03-MISMO-DESTINO-1 · con `soloDestino` (un destino canónico) solo salen los grupos que
 *  llevan a ESE destino: los otros usos del mismo enlace (otro flujo, otra difusión, un pago). */
export async function listLinkGroups(limit = 200, includeArchived = false, desdeMs: number | null = null, soloDestino: string | null = null): Promise<LinkGroup[]> {
  const tenantId = currentWorkspaceId();
  const enPeriodo = (at: number): boolean => desdeMs == null || at >= desdeMs;
  if (!pool) {
    // Camino en memoria (sin base de datos): mismo criterio, en JS, para que el
    // panel y las pruebas sin Postgres vean exactamente lo mismo.
    const porClave = new Map<string, LinkGroup>();
    for (const l of memLinks.values()) {
      if ((l.tenant_id || "default") !== tenantId) continue;
      if (!includeArchived && l.archived) continue;
      const dest = destinoCanonico(l.url);
      if (soloDestino != null && dest !== soloDestino) continue;
      const ctxKey = l.context_kind === "payment" ? String((l as any).product_id || "") : (l.context_id || "");
      const k = l.context_kind + "\u0000" + ctxKey + "\u0000" + dest;
      const todos = memClicks.filter((c) => c.token === l.token);
      const clicks = todos.filter((c) => enPeriodo(c.created_at));
      const ult = todos.length ? Math.max(...todos.map((c) => c.created_at)) : null;
      const g = porClave.get(k);
      if (!g) {
        porClave.set(k, {
          token: l.token, url: l.url, label: l.label, context_kind: l.context_kind,
          context_id: l.context_id, clicks: clicks.length,
          last_click_at: ult,
          created_at: l.created_at, archived: !!l.archived,
          enlaces: 1, personas: new Set(clicks.map((c) => c.phone).filter(Boolean)).size,
          dest, archivadoTodo: !!l.archived,
          product_id: l.context_kind === "payment" ? ctxKey : "",
          primer_creado: l.created_at,
        });
      } else {
        g.enlaces++;
        g.clicks += clicks.length;
        if (ult && (!g.last_click_at || ult > g.last_click_at)) g.last_click_at = ult;
        if (l.created_at > g.created_at) { g.created_at = l.created_at; g.token = l.token; g.url = l.url; }
        if (l.created_at < g.primer_creado) g.primer_creado = l.created_at;
        if (!g.label && l.label) g.label = l.label;
        g.archivadoTodo = g.archivadoTodo && !!l.archived;
        g.archived = g.archivadoTodo; // como en Postgres (BOOL_AND), no el del primer enlace
      }
    }
    // personas del grupo, sin duplicar entre sus enlaces
    for (const [k, g] of porClave) {
      const suyos = [...memLinks.values()].filter((l) => (l.tenant_id || "default") === tenantId
        && (includeArchived || !l.archived)
        && (l.context_kind + "\u0000" + (l.context_kind === "payment" ? String((l as any).product_id || "") : (l.context_id || "")) + "\u0000" + destinoCanonico(l.url)) === k);
      const tokens = new Set(suyos.map((l) => l.token));
      g.personas = new Set(memClicks.filter((c) => tokens.has(c.token) && c.phone && enPeriodo(c.created_at)).map((c) => c.phone)).size;
    }
    return [...porClave.values()].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }
  const r = await pool.query(
    `SELECT sl.context_kind,
            ${SQL_CTXKEY} ctx_key,
            ${SQL_DESTINO} dest,
            COUNT(DISTINCT sl.token)::int enlaces,
            COUNT(k.token) FILTER (WHERE $4::timestamptz IS NULL OR k.created_at >= $4::timestamptz)::int clicks,
            COUNT(DISTINCT k.phone) FILTER (WHERE k.phone <> '' AND ($4::timestamptz IS NULL OR k.created_at >= $4::timestamptz))::int personas,
            extract(epoch from MAX(k.created_at))*1000 last_click_at,
            extract(epoch from MAX(sl.created_at))*1000 created_at,
            extract(epoch from MIN(sl.created_at))*1000 primer_creado,
            BOOL_AND(sl.archived) archivado_todo,
            (ARRAY_AGG(sl.token ORDER BY sl.created_at DESC))[1] token,
            (ARRAY_AGG(sl.url ORDER BY sl.created_at DESC))[1] url,
            (ARRAY_AGG(sl.context_id ORDER BY sl.created_at DESC))[1] context_id,
            COALESCE(MAX(NULLIF(sl.label,'')),'') label
       FROM app_short_links sl
       LEFT JOIN app_link_clicks k ON k.token = sl.token AND k.tenant_id = sl.tenant_id
      WHERE sl.tenant_id=$2 AND ($3 OR sl.archived=false)
        AND ($5::text IS NULL OR ${SQL_DESTINO}=$5::text)
      GROUP BY sl.context_kind, ctx_key, dest
      ORDER BY MAX(sl.created_at) DESC
      LIMIT $1`,
    [limit, tenantId, includeArchived, desdeMs != null ? new Date(desdeMs) : null, soloDestino],
  );
  return r.rows.map((x: any) => ({
    token: x.token, url: x.url, label: x.label || "",
    context_kind: x.context_kind || "", context_id: x.context_id || "",
    clicks: Number(x.clicks) || 0,
    last_click_at: x.last_click_at ? Number(x.last_click_at) : null,
    created_at: Number(x.created_at) || 0,
    archived: !!x.archivado_todo,
    enlaces: Number(x.enlaces) || 1,
    personas: Number(x.personas) || 0,
    dest: x.dest || "",
    archivadoTodo: !!x.archivado_todo,
    product_id: x.context_kind === "payment" ? String(x.ctx_key || "") : "",
    primer_creado: Number(x.primer_creado) || Number(x.created_at) || 0,
  }));
}

/** ENL-04-PERIODO-1 · Las cifras de la cabecera de Enlaces, con la MISMA definición que las
 *  filas de listLinkGroups: solo enlaces visibles (no ocultos), clics desde `desdeMs` y
 *  personas = teléfonos distintos IDENTIFICADOS. Quien hizo clic en tres enlaces cuenta una
 *  vez aquí (y una vez en cada fila): por eso no se suma la columna. `anonimos` son los clics
 *  que llegaron sin saber de quién eran (cuentan como clic, nunca como persona). */
export async function resumenClicsEnlaces(desdeMs: number | null = null): Promise<{ clics: number; personas: number; anonimos: number }> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const visibles = new Set([...memLinks.values()]
      .filter((l) => (l.tenant_id || "default") === tenantId && !l.archived).map((l) => l.token));
    const suyos = memClicks.filter((c) => visibles.has(c.token) && (desdeMs == null || c.created_at >= desdeMs));
    return {
      clics: suyos.length,
      personas: new Set(suyos.map((c) => c.phone).filter(Boolean)).size,
      anonimos: suyos.filter((c) => !c.phone).length,
    };
  }
  const r = await pool.query(
    `SELECT COUNT(*)::int clics,
            COUNT(DISTINCT k.phone) FILTER (WHERE k.phone <> '')::int personas,
            COUNT(*) FILTER (WHERE COALESCE(k.phone,'') = '')::int anonimos
       FROM app_link_clicks k
       JOIN app_short_links sl ON sl.token = k.token AND sl.tenant_id = k.tenant_id
      WHERE k.tenant_id = $1 AND sl.archived = false
        AND ($2::timestamptz IS NULL OR k.created_at >= $2::timestamptz)`,
    [tenantId, desdeMs != null ? new Date(desdeMs) : null],
  );
  const x = r.rows[0] || {};
  return { clics: Number(x.clics) || 0, personas: Number(x.personas) || 0, anonimos: Number(x.anonimos) || 0 };
}

/** Oculta o muestra TODOS los enlaces del grupo. Devuelve cuántos ha tocado.
 *  Hacerlo de uno en uno dejaba enlaces varados: la lista los excluye por
 *  archivados, pero el grupo seguía apareciendo entre los activos, así que ese
 *  enlace no se podía volver a mostrar desde ninguna vista del panel. */
export async function setLinkArchivedGrupo(token: string, archived: boolean): Promise<number> {
  // BORRAR-ENLACE-1 · el grupo ENTERO, ocultos incluidos: buscando solo entre los visibles,
  // «Volver a mostrar» un grupo oculto no encontraba nada y respondía «enlace no encontrado».
  const tokens = await tokensDelGrupo(token, true);
  if (!tokens.length) return 0;
  let n = 0;
  for (const t of tokens) if (await setLinkArchived(t, archived)) n++;
  return n;
}

/** Borra los enlaces del grupo que su fila enseña, y sus clics. Devuelve cuántos ha borrado. */
export async function deleteLinkGrupo(token: string): Promise<number> {
  // BORRAR-LO-ANUNCIADO-1 · se borra EXACTAMENTE lo que la fila enseña y el aviso anuncia
  // (sus enlaces y sus clics). Una fila de los activos son sus enlaces VISIBLES; un grupo
  // entero oculto (el único que sale en «enlaces ocultos») son todos, y antes daba 404.
  // Borrar también los ocultos de un grupo con visibles se llevaba enlaces y clics que el
  // aviso no contaba; así se quedan en «enlaces ocultos», con su historial.
  const visibles = await tokensDelGrupo(token, false);
  const tokens = visibles.length ? visibles : await tokensDelGrupo(token, true);
  if (!tokens.length) return 0;
  let n = 0;
  for (const t of tokens) if (await deleteLink(t)) n++;
  return n;
}

/** Renombra TODOS los enlaces del grupo: el rótulo del grupo sale de sus
 *  enlaces, así que cambiar uno solo dejaba el nombre viejo si otro lo tenía. */
export async function setLinkLabelGrupo(token: string, label: string): Promise<number> {
  // BORRAR-ENLACE-1 · también se renombra desde «enlaces ocultos».
  const tokens = await tokensDelGrupo(token, true);
  if (!tokens.length) return 0;
  let n = 0;
  for (const t of tokens) if (await setLinkLabel(t, label)) n++;
  return n;
}

/** Los tokens que componen el grupo al que pertenece `token`. Lo usan el
 *  detalle agregado y las acciones (renombrar / ocultar / borrar un grupo). */
/** OJO con `includeArchived`: tiene que ir SIEMPRE igual que en la lista. Si
 *  la lista excluye los ocultos y esto no, la fila dice unos clics y su detalle
 *  otros, sin que nada lo explique. */
export async function tokensDelGrupo(token: string, includeArchived = false): Promise<string[]> {
  const tenantId = currentWorkspaceId();
  if (!token) return [];
  if (!pool) {
    const l = memLinks.get(token);
    // Igual que en Postgres: un token de otro workspace no tiene grupo aquí.
    if (!l || (l.tenant_id || "default") !== tenantId) return [];
    const k = (x: any) => x.context_kind + "\u0000" + (x.context_kind === "payment" ? String((x as any).product_id || "") : (x.context_id || "")) + "\u0000" + destinoCanonico(x.url);
    const mio = k(l);
    return [...memLinks.values()].filter((x) => (x.tenant_id || "default") === tenantId && k(x) === mio && (includeArchived || !x.archived)).map((x) => x.token);
  }
  const r = await pool.query(
    `WITH yo AS (
        SELECT ${SQL_CTXKEY} ctx_key, ${SQL_DESTINO} dest, sl.context_kind
          FROM app_short_links sl WHERE sl.token=$1 AND sl.tenant_id=$2 LIMIT 1)
      SELECT sl.token FROM app_short_links sl, yo
       WHERE sl.tenant_id=$2 AND sl.context_kind=yo.context_kind
         AND ${SQL_CTXKEY}=yo.ctx_key AND ${SQL_DESTINO}=yo.dest
         AND ($3 OR sl.archived=false)`,
    [token, tenantId, includeArchived],
  );
  return r.rows.map((x: any) => String(x.token));
}

/** OCULTO-HEREDA-1 · Un enlace NUEVO de un grupo que el negocio ha ocultado nace oculto.
 *  Ocultar es cosa del grupo («el enlace real»), pero un flujo o una difusión con ?ref= y los
 *  enlaces de pago crean un enlace por persona. Sin esto, el siguiente envío devolvía el grupo a
 *  la lista de activos con solo los clics nuevos, y su historial desaparecía de las dos vistas:
 *  el grupo ya no estaba «todo oculto» (BOOL_AND), así que tampoco salía entre los ocultos.
 *  Si el grupo tiene algún enlace visible, o el nuevo es el primero, nace visible como siempre.
 *  Mismo criterio de grupo que tokensDelGrupo / listLinkGroups. */
async function heredaOcultoDelGrupo(token: string, tenant: string): Promise<void> {
  try {
    if (!pool) {
      const l = memLinks.get(token);
      if (!l) return;
      const k = (x: any) => x.context_kind + "\u0000" + (x.context_kind === "payment" ? String((x as any).product_id || "") : (x.context_id || "")) + "\u0000" + destinoCanonico(x.url);
      const mio = k(l);
      const hermanos = [...memLinks.values()].filter((x) => x.token !== token && (x.tenant_id || "default") === tenant && k(x) === mio);
      if (hermanos.length && hermanos.every((x) => !!x.archived)) l.archived = true;
      return;
    }
    // BOOL_AND sobre los hermanos: NULL si no hay ninguno → no se toca.
    await pool.query(
      `UPDATE app_short_links SET archived=true
        WHERE token=$1 AND tenant_id=$2
          AND (WITH yo AS (
                 SELECT ${SQL_CTXKEY} ctx_key, ${SQL_DESTINO} dest, sl.context_kind
                   FROM app_short_links sl WHERE sl.token=$1 AND sl.tenant_id=$2 LIMIT 1)
               SELECT BOOL_AND(sl.archived) FROM app_short_links sl, yo
                WHERE sl.tenant_id=$2 AND sl.token<>$1 AND sl.context_kind=yo.context_kind
                  AND ${SQL_CTXKEY}=yo.ctx_key AND ${SQL_DESTINO}=yo.dest) IS TRUE`,
      [token, tenant],
    );
  } catch (e) {
    // El enlace ya está creado y funciona: si esto falla, queda visible (lo de antes).
    console.warn("[links] heredaOcultoDelGrupo:", (e as Error).message);
  }
}

export async function listLinks(limit = 100, includeArchived = false): Promise<LinkSummary[]> {
  // Multi-tenant: SIEMPRE scoped al workspace activo. Sin este filtro, el panel
  // de cualquier workspace listaba los shortlinks (y sus clicks) de TODOS los
  // demás workspaces (fuga cross-tenant en Métricas → Web/links).
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const out: LinkSummary[] = [];
    for (const l of memLinks.values()) {
      if ((l.tenant_id || "default") !== tenantId) continue;
      if (!includeArchived && l.archived) continue;
      const clicks = memClicks.filter((c) => c.token === l.token);
      const last = clicks.length ? Math.max(...clicks.map((c) => c.created_at)) : null;
      out.push({
        token: l.token,
        url: l.url,
        label: l.label,
        context_kind: l.context_kind,
        context_id: l.context_id,
        clicks: clicks.length,
        last_click_at: last,
        created_at: l.created_at,
        archived: !!l.archived,
      });
    }
    return out.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }
  const r = await pool.query(
    `SELECT sl.token, sl.url, sl.label, sl.context_kind, sl.context_id, sl.archived,
       extract(epoch from sl.created_at)*1000 created_at,
       COALESCE(c.clicks,0) clicks,
       extract(epoch from c.last_click_at)*1000 last_click_at
     FROM app_short_links sl
     LEFT JOIN (
       SELECT token, COUNT(*) clicks, MAX(created_at) last_click_at
       FROM app_link_clicks GROUP BY token
     ) c ON c.token = sl.token
     WHERE sl.tenant_id=$2 AND ($3 OR sl.archived=false)
     ORDER BY sl.created_at DESC LIMIT $1`,
    [limit, tenantId, includeArchived],
  );
  return r.rows.map((x: any) => ({
    token: x.token,
    url: x.url,
    label: x.label,
    context_kind: x.context_kind,
    context_id: x.context_id,
    clicks: Number(x.clicks ?? 0),
    last_click_at: x.last_click_at ? Number(x.last_click_at) : null,
    created_at: Number(x.created_at),
    archived: !!x.archived,
  }));
}

/** Clics agregados POR VENTANA temporal: cuenta app_link_clicks del tenant entre
 *  sinceMs y untilMs, agrupado por enlace. A diferencia del campo `clicks` de
 *  listLinks (contador acumulado de toda la vida del enlace), esto permite que
 *  «Clics de enlaces» y «Enlaces más clicados» respeten el rango del date-picker
 *  igual que Visitas/Visitantes. Excluye archivados (como listLinks por defecto). */
export async function linkClickStats(sinceMs: number, untilMs: number): Promise<Array<{ token: string; url: string; label: string; context_kind: string; clicks: number }>> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const out: Array<{ token: string; url: string; label: string; context_kind: string; clicks: number }> = [];
    for (const l of memLinks.values()) {
      if ((l.tenant_id || "default") !== tenantId) continue;
      if (l.archived) continue;
      const n = memClicks.filter((c) => c.token === l.token && c.created_at >= sinceMs && c.created_at <= untilMs).length;
      if (n > 0) out.push({ token: l.token, url: l.url, label: l.label, context_kind: l.context_kind, clicks: n });
    }
    return out;
  }
  const r = await pool.query(
    `SELECT sl.token, sl.url, sl.label, sl.context_kind, COUNT(c.*)::int clicks
     FROM app_short_links sl
     JOIN app_link_clicks c ON c.token = sl.token
       AND c.created_at >= to_timestamp($2/1000.0)
       AND c.created_at <= to_timestamp($3/1000.0)
     WHERE sl.tenant_id=$1 AND sl.archived=false
     GROUP BY 1,2,3,4`,
    [tenantId, sinceMs, untilMs],
  );
  return r.rows.map((x: any) => ({ token: x.token, url: x.url, label: x.label, context_kind: x.context_kind, clicks: Number(x.clicks) || 0 }));
}

/** Renombra un enlace (etiqueta visible en la lista de LIVE · Asistencia). Scoped al workspace. */
export async function setLinkLabel(token: string, label: string): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!token) return false;
  if (!pool) {
    const l = memLinks.get(token);
    if (!l || (l.tenant_id || "default") !== tenantId) return false;
    l.label = label;
    return true;
  }
  const r = await pool.query(
    `UPDATE app_short_links SET label=$3 WHERE token=$1 AND tenant_id=$2`,
    [token, tenantId, label],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Oculta/muestra un enlace (no borra datos). Scoped al workspace. */
export async function setLinkArchived(token: string, archived: boolean): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!token) return false;
  if (!pool) {
    const l = memLinks.get(token);
    if (!l || (l.tenant_id || "default") !== tenantId) return false;
    l.archived = archived;
    return true;
  }
  const r = await pool.query(
    `UPDATE app_short_links SET archived=$3 WHERE token=$1 AND tenant_id=$2`,
    [token, tenantId, archived],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Borra un enlace y TODOS sus clics (permanente). Scoped al workspace. */
export async function deleteLink(token: string): Promise<boolean> {
  const tenantId = currentWorkspaceId();
  if (!token) return false;
  if (!pool) {
    const l = memLinks.get(token);
    if (!l || (l.tenant_id || "default") !== tenantId) return false;
    memLinks.delete(token);
    for (const [k, v] of memByUrlCtx) if (v === token) memByUrlCtx.delete(k);
    for (let i = memClicks.length - 1; i >= 0; i--) if (memClicks[i].token === token) memClicks.splice(i, 1);
    return true;
  }
  await pool.query(`DELETE FROM app_link_clicks WHERE token=$1 AND tenant_id=$2`, [token, tenantId]);
  const r = await pool.query(`DELETE FROM app_short_links WHERE token=$1 AND tenant_id=$2`, [token, tenantId]);
  return (r.rowCount ?? 0) > 0;
}

export async function linkAnalytics(token: string, limit = 50): Promise<{ link: LinkSummary | null; clicks: Array<{ phone: string; ua: string; ip: string; ref: string; created_at: number }> }> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const l = memLinks.get(token);
    // Cross-tenant guard: un token de otro workspace se trata como inexistente.
    // ENLACE-TOKEN-1 · la rama de memoria ya iba directa a la clave: no hay página
    // que agotar, así que aquí el enlace 1001 nunca se perdió.
    if (!l || (l.tenant_id || "default") !== tenantId) return { link: null, clicks: [] };
    const all = memClicks.filter((c) => c.token === token).sort((a, b) => b.created_at - a.created_at).slice(0, limit);
    return {
      link: {
        token: l.token, url: l.url, label: l.label,
        context_kind: l.context_kind, context_id: l.context_id,
        clicks: memClicks.filter((c) => c.token === token).length,
        last_click_at: all.length ? all[0].created_at : null,
        created_at: l.created_at,
        archived: !!l.archived,
      },
      clicks: all,
    };
  }
  // ENLACE-TOKEN-1 · consulta DIRECTA por token, acotada al workspace. Antes se
  // traían los 1000 enlaces más recientes con listLinks(1000,true) y se buscaba el
  // token en memoria: a partir del enlace 1001 el `find` no lo encontraba y la ficha
  // salía vacía («este enlace no existe») aunque el enlace estuviera vivo y con clics.
  // El filtro cross-tenant sigue siendo el mismo, pero ahora lo hace el WHERE:
  // un token de otro workspace no devuelve fila y sus clics (teléfono/IP) no se ven.
  // Los archivados siguen siendo consultables por token, como antes.
  const lr = await pool.query(
    `SELECT sl.token, sl.url, sl.label, sl.context_kind, sl.context_id, sl.archived,
       extract(epoch from sl.created_at)*1000 created_at,
       (SELECT COUNT(*) FROM app_link_clicks c WHERE c.token=sl.token AND c.tenant_id=sl.tenant_id)::int clicks,
       (SELECT extract(epoch from MAX(c.created_at))*1000 FROM app_link_clicks c WHERE c.token=sl.token AND c.tenant_id=sl.tenant_id) last_click_at
     FROM app_short_links sl WHERE sl.token=$1 AND sl.tenant_id=$2`,
    [token, tenantId],
  );
  if (!lr.rowCount) return { link: null, clicks: [] };
  const x0 = lr.rows[0] as any;
  const link: LinkSummary = {
    token: x0.token,
    url: x0.url,
    label: x0.label,
    context_kind: x0.context_kind,
    context_id: x0.context_id,
    clicks: Number(x0.clicks ?? 0),
    last_click_at: x0.last_click_at != null ? Number(x0.last_click_at) : null,
    created_at: Number(x0.created_at),
    archived: !!x0.archived,
  };
  const all = await pool.query(
    `SELECT phone,user_agent ua,ip,ref, extract(epoch from created_at)*1000 created_at
     FROM app_link_clicks WHERE token=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT $3`,
    [token, tenantId, limit],
  );
  return { link, clicks: all.rows.map((x: any) => ({ ...x, created_at: Number(x.created_at) })) };
}

/** METRICAS-1 · reparte las estadísticas de enlaces entre los productos del catálogo. Los enlaces
 *  creados antes de que existiera product_id se reasignan por la URL del checkout; lo que no case
 *  —o el product_id de un producto que ya no está en el catálogo (PAGO-5)— va al cajón
 *  «__sin_identificar__»: inventarle dueño sería mentir, y abrirle un grupo propio que nadie pinta
 *  haría desaparecer su historial. Personas y quién pulsó se UNEN, no se suman: la misma persona
 *  con un enlace viejo sin producto y otro nuevo es una persona. */
export function repartirEstadisticas(
  stats: Array<{ product_id: string; base: string; creados: number; clics: number; ultimo_clic: number; ctxs: string[]; telefonos: string[] }>,
  defs: Array<{ id: string; url: string }>,
): Map<string, { creados: number; personas: number; clics: number; clicaron: number; ultimo_clic: number }> {
  const baseDe = (u: string): string => String(u || "").split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
  const out = new Map<string, { creados: number; personas: number; clics: number; clicaron: number; ultimo_clic: number; ctx: Set<string>; tel: Set<string> }>();
  for (const st of stats) {
    let id = st.product_id;
    if (!id) { const d = defs.find((x) => baseDe(x.url) === baseDe(st.base)); id = d ? d.id : "__sin_identificar__"; }
    else if (!defs.some((d) => d.id === id)) id = "__sin_identificar__";
    const g = out.get(id) || { creados: 0, personas: 0, clics: 0, clicaron: 0, ultimo_clic: 0, ctx: new Set<string>(), tel: new Set<string>() };
    g.creados += st.creados; g.clics += st.clics; g.ultimo_clic = Math.max(g.ultimo_clic, st.ultimo_clic);
    for (const x of st.ctxs) g.ctx.add(x);
    for (const x of st.telefonos) g.tel.add(x);
    g.personas = g.ctx.size; g.clicaron = g.tel.size;
    out.set(id, g);
  }
  return new Map([...out].map(([id, g]) => [id, { creados: g.creados, personas: g.personas, clics: g.clics, clicaron: g.clicaron, ultimo_clic: g.ultimo_clic }]));
}
