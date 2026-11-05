/**
 * Analítica web propia, nivel Google Analytics (sin GA, sin cookies invasivas).
 *
 * Las páginas publicadas viven en systeme.io (externas), así que medimos con un
 * píxel propio: `pageviewSnippet()` se inyecta en el HTML y hace beacons a `/pv`:
 *   1) al cargar → registra la visita (ruta, referrer, idioma, dispositivo…).
 *   2) al salir  → actualiza el tiempo de permanencia (engagement) por `nonce`.
 *
 * `pageViewStats()` agrega métricas GA-grade: usuarios, sesiones (gap 30 min),
 * tiempo medio de interacción, % sesiones con engagement, nuevos vs recurrentes,
 * canales de tráfico, dispositivos, navegadores, SO, idiomas, páginas y serie.
 */
import crypto from "node:crypto";
import * as pg from "pg";
import { pgSsl } from "./pg-ssl.js";
import { get as getSetting, urlPublica } from "./settings.js";
import { platformOf } from "./attribution.js";
import { claveDePagina, normalizarRuta, normalizarEvento, type FiltroAmbitoWeb, type SenalEmbudo } from "./web-negocios.js";

/** MEDICION-EMBUDO-1 (MET-WEB-02) · el resultado de un embudo, sin confundir «no medimos» con
 *  «cero»: `sin-medir` (ninguna etapa confirma, o la que confirma ocurre fuera de las webs),
 *  `pendiente` (la señal está configurada pero en 90 días no ha llegado ni un dato) y `medido`
 *  (la señal ya ha llegado alguna vez: un 0 es un cero de verdad). `valor`/`prev` = PERSONAS
 *  distintas que llegaron a la señal (recargas y repeticiones de la misma persona cuentan una). */
export interface ResultadoEmbudo {
  estado: "sin-medir" | "pendiente" | "medido";
  /** `sin-paginas` / `sin-propias`: el embudo no tiene páginas, o todas las suyas son también de
   *  otros embudos. No hay filas suyas que contar: no se calcula nada (ni siquiera un cero). */
  motivo: "" | "sin-confirmacion" | "externa" | "sin-paginas" | "sin-propias";
  etapa: string;
  tipo: string;
  valor: number;
  prev: number;
}

const dbUrl = process.env.DATABASE_URL;
const pool = dbUrl
  ? new pg.default.Pool({
      connectionString: dbUrl,
      ssl: pgSsl(),
      max: 2,
    })
  : null;

interface MemView {
  tenant_id: string; page_id: string; page_label: string; ref: string; path: string;
  device: string; browser: string; os: string; lang: string; visitor: string;
  user_agent: string; ip: string; nonce: string; duration_ms: number; created_at: number;
  country: string; event: string;
  utm_source: string; utm_medium: string; utm_campaign: string; utm_term: string; utm_content: string;
  click_id: string; scroll_pct: number; load_ms: number; tz_min: number | null;
  contact?: string;
}
const mem: MemView[] = [];

/** Filtro de bots GA-grade: crawlers, previews de mensajería (WhatsApp/Telegram/Slack
 *  generan un hit al compartir un enlace), monitores de uptime y clientes HTTP headless.
 *  UA vacío también cuenta como bot: ningún navegador real llega sin User-Agent.
 *  Fuera a propósito (humanos reales): in-app browsers de Snapchat/Pinterest ('Snapchat/12',
 *  '[Pinterest/iOS]'), Electron (webviews de escritorio) y móviles CUBOT (su marca contiene
 *  'bot' y el patrón genérico los tragaba). */
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|pagespeed|gtmetrix|prerender|phantomjs|puppeteer|playwright|selenium|curl\/|wget\/|python-requests|python-urllib|go-http-client|okhttp|node-fetch|axios\/|java\/|libwww|facebookexternalhit|facebookcatalog|meta-externalagent|whatsapp\/|skypeuripreview|bytespider|petalbot|semrush|ahrefs|yandex|baiduspider|bingpreview|google-inspectiontool|adsbot|apis-google|mediapartners|feedfetcher|vkshare|w3c_validator|uptime|statuscake|site24x7|checkly|newrelic|datadoghq|hexometer/i;
export function isBotUa(ua: string): boolean {
  if (!ua || !ua.trim()) return true;
  if (/cubot/i.test(ua)) return false; // marca de móviles; no es el patrón 'bot'
  return BOT_RE.test(ua);
}

/** Zona horaria IANA → país (ISO-2). Cubre la audiencia hispana al completo y las zonas
 *  principales del resto del mundo; suficiente a nivel PAÍS, que es lo que mostramos. */
const TZ_COUNTRY: Record<string, string> = {
  "Europe/Madrid": "ES", "Atlantic/Canary": "ES", "Africa/Ceuta": "ES",
  "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR", "Europe/Berlin": "DE",
  "Europe/Rome": "IT", "Europe/Lisbon": "PT", "Atlantic/Madeira": "PT", "Atlantic/Azores": "PT",
  "Europe/Amsterdam": "NL", "Europe/Brussels": "BE", "Europe/Zurich": "CH", "Europe/Vienna": "AT",
  "Europe/Warsaw": "PL", "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Copenhagen": "DK",
  "Europe/Helsinki": "FI", "Europe/Athens": "GR", "Europe/Bucharest": "RO", "Europe/Prague": "CZ",
  "Europe/Budapest": "HU", "Europe/Kyiv": "UA", "Europe/Kiev": "UA", "Europe/Moscow": "RU",
  "Europe/Andorra": "AD", "Europe/Gibraltar": "GI", "Europe/Malta": "MT", "Europe/Luxembourg": "LU",
  "Europe/Monaco": "MC", "Europe/Zagreb": "HR", "Europe/Belgrade": "RS", "Europe/Bratislava": "SK",
  "Europe/Ljubljana": "SI", "Europe/Sofia": "BG", "Europe/Vilnius": "LT", "Europe/Riga": "LV",
  "Europe/Tallinn": "EE", "Atlantic/Reykjavik": "IS", "Europe/Istanbul": "TR",
  "America/Mexico_City": "MX", "America/Cancun": "MX", "America/Monterrey": "MX", "America/Tijuana": "MX",
  "America/Merida": "MX", "America/Chihuahua": "MX", "America/Hermosillo": "MX", "America/Mazatlan": "MX",
  "America/Bogota": "CO", "America/Lima": "PE", "America/Santiago": "CL", "America/Montevideo": "UY",
  "America/Asuncion": "PY", "America/La_Paz": "BO", "America/Guayaquil": "EC", "America/Caracas": "VE",
  "America/Panama": "PA", "America/Costa_Rica": "CR", "America/Guatemala": "GT", "America/El_Salvador": "SV",
  "America/Tegucigalpa": "HN", "America/Managua": "NI", "America/Santo_Domingo": "DO", "America/Havana": "CU",
  "America/Puerto_Rico": "PR",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US",
  "America/Phoenix": "US", "America/Anchorage": "US", "America/Detroit": "US", "Pacific/Honolulu": "US",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA", "America/Winnipeg": "CA",
  "America/Halifax": "CA", "America/Montreal": "CA",
  "America/Sao_Paulo": "BR", "America/Bahia": "BR", "America/Fortaleza": "BR", "America/Manaus": "BR", "America/Recife": "BR",
  "Asia/Tokyo": "JP", "Asia/Shanghai": "CN", "Asia/Hong_Kong": "HK", "Asia/Singapore": "SG",
  "Asia/Seoul": "KR", "Asia/Kolkata": "IN", "Asia/Dubai": "AE", "Asia/Jerusalem": "IL",
  "Asia/Bangkok": "TH", "Asia/Jakarta": "ID", "Asia/Manila": "PH",
  "Africa/Casablanca": "MA", "Africa/Lagos": "NG", "Africa/Johannesburg": "ZA", "Africa/Cairo": "EG",
  "Africa/Nairobi": "KE", "Africa/Algiers": "DZ", "Africa/Tunis": "TN",
  "Pacific/Auckland": "NZ",
};
function tzToCountry(tzName: string): string {
  const t = String(tzName || "").trim();
  if (!t) return "";
  // Propia, no heredada: «constructor» o «__proto__» llegan de fuera (?tzn=) y no son países.
  const tc = Object.prototype.hasOwnProperty.call(TZ_COUNTRY, t) ? TZ_COUNTRY[t] : "";
  if (tc) return tc;
  if (t.startsWith("America/Argentina/")) return "AR";
  if (t.startsWith("America/Indiana/") || t.startsWith("America/Kentucky/") || t.startsWith("America/North_Dakota/")) return "US";
  if (t.startsWith("Australia/")) return "AU";
  return "";
}
/** País (ISO-2) del visitante, por orden de confianza: cabecera de CDN si existe →
 *  zona horaria IANA del navegador (Europe/Madrid→ES, cubre a quien manda 'es' sin
 *  región) → región del idioma (es-MX→MX) → inferencia idioma+offset SOLO en el caso
 *  inequívoco: 'es' en huso CET/CEST (UTC+1/+2) = España, único país hispanohablante
 *  en ese huso. Combos ambiguos (es+UTC−5 puede ser CO/PE/EC/MX…) NO se adivinan.
 *  '' = desconocido. */
function countryOf(headerCountry: string | undefined, lang: string | undefined, tzName?: string, tzMin?: number): string {
  const h = String(headerCountry || "").toUpperCase();
  if (/^[A-Z]{2}$/.test(h) && h !== "XX" && h !== "T1") return h;
  const viaTz = tzToCountry(tzName || "");
  if (viaTz) return viaTz;
  const region = String(lang || "").split("-")[1];
  if (region && /^[A-Za-z]{2}$/.test(region)) return region.toUpperCase();
  // Inferencia por idioma DOMINANTE del huso (~90% de acierto, aproximación asumida):
  // en CET/CEST cada idioma base apunta con claridad a un país (es→ES único hispano;
  // fr→FR con minorías BE/CH; de→DE con AT/CH; it→IT; nl→NL; pl→PL). En huso británico
  // en→GB, y pt en WET→PT (Brasil va en UTC-3). Los combos realmente ambiguos
  // (es+UTC-5: CO/PE/EC/MX…) siguen sin adivinarse: mejor desconocido que inventado.
  const base = String(lang || "").split("-")[0].toLowerCase();
  const CET_LANG: Record<string, string> = { es: "ES", fr: "FR", de: "DE", it: "IT", nl: "NL", pl: "PL" };
  if ((tzMin === -60 || tzMin === -120) && Object.prototype.hasOwnProperty.call(CET_LANG, base)) return CET_LANG[base];
  if (base === "en" && (tzMin === 0 || tzMin === -60)) return "GB";
  if (base === "pt" && (tzMin === 0 || tzMin === -60)) return "PT";
  return "";
}

export function baseUrl(): string {
  // DOMINIO-INSTANCIA-1 · el dominio va INCRUSTADO en el fragmento del píxel que el
  // cliente pega en su web: si aquí saliera el dominio de otra instancia, sus visitas
  // se contarían en el tenant equivocado y corregirlo obligaría a volver a pegar el
  // píxel en todas sus páginas.
  return urlPublica();
}

export function deviceOf(ua: string): "mobile" | "tablet" | "desktop" {
  const u = (ua || "").toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(u)) return "tablet";
  if (/mobi|iphone|android.*mobile|phone/.test(u)) return "mobile";
  return "desktop";
}
function browserOf(ua: string): string {
  const u = ua || "";
  if (/Edg\//.test(u)) return "Edge";
  if (/OPR\/|Opera/.test(u)) return "Opera";
  if (/Chrome\//.test(u) && !/Chromium/.test(u)) return "Chrome";
  if (/CriOS/.test(u)) return "Chrome";
  if (/Firefox\//.test(u) || /FxiOS/.test(u)) return "Firefox";
  if (/Safari\//.test(u) && /Version\//.test(u)) return "Safari";
  if (/SamsungBrowser/.test(u)) return "Samsung Internet";
  return "Otro";
}
function osOf(ua: string): string {
  const u = ua || "";
  if (/Windows/.test(u)) return "Windows";
  if (/iPhone|iPad|iPod/.test(u)) return "iOS";
  if (/Android/.test(u)) return "Android";
  if (/Mac OS X/.test(u)) return "macOS";
  if (/Linux/.test(u)) return "Linux";
  return "Otro";
}

/** Referrer → fuente legible. */
export function sourceName(ref: string): string {
  if (!ref) return "Directo";
  let host = ref;
  try { host = new URL(ref).hostname.replace(/^www\./, ""); } catch { /* no URL */ }
  host = host.toLowerCase();
  if (/instagram|ig\.me|l\.instagram/.test(host)) return "Instagram";
  if (/facebook|fb\.com|fb\.me|l\.facebook/.test(host)) return "Facebook";
  if (/t\.co|twitter|x\.com/.test(host)) return "X / Twitter";
  if (/tiktok/.test(host)) return "TikTok";
  if (/linkedin|lnkd\.in/.test(host)) return "LinkedIn";
  if (/wa\.me|whatsapp/.test(host)) return "WhatsApp";
  if (/youtube|youtu\.be/.test(host)) return "YouTube";
  // IA / asistentes ANTES que buscadores: gemini.google.com contiene 'google' pero no es
  // una búsqueda; ChatGPT/Perplexity/Claude son una fuente propia, cada vez más real.
  if (/chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|you\.com|phind\.com/.test(host)) return "IA / Asistentes";
  // Buscadores por DOMINIO explícito, no substring: mail.google.com o docs.google.com NO
  // son búsqueda orgánica (Gmail/Docs inflaban 'Buscadores' con tráfico de correo).
  if (/(^|\.)google\.[a-z.]{2,6}$/.test(host) && !/^(mail|docs|drive|photos|play|meet|chat|calendar|sites|groups|translate)\./.test(host)) return "Buscadores";
  if (/(^|\.)bing\.com$|(^|\.)duckduckgo\.com$|(^|\.)ecosia\.org$|(^|\.)search\.yahoo\.com$|(^|\.)yandex\.[a-z]+$|(^|\.)baidu\.com$|(^|\.)startpage\.com$|(^|\.)brave\.com$/.test(host)) return "Buscadores";
  if (/pinterest|pin\.it/.test(host)) return "Pinterest";
  return host || "Otro";
}
/** Referrer → canal GA (Directo / Social / Búsqueda orgánica / Referido). */
export function channelOf(ref: string): string {
  if (!ref) return "Directo";
  const s = sourceName(ref);
  if (["Instagram", "Facebook", "X / Twitter", "TikTok", "LinkedIn", "WhatsApp", "YouTube", "Pinterest"].includes(s)) return "Social";
  if (s === "Buscadores") return "Búsqueda orgánica";
  return "Referido";
}

// ===== Agrupación de canales GA4 (default channel grouping) =====
// A diferencia de channelOf (solo referrer), aquí mandan los UTM y los click-ids
// de ads: gclid/msclkid = pago en buscador aunque el referrer diga "google";
// utm_medium=email identifica campañas de correo aunque el referrer venga vacío.
const SOCIAL_SRC = /^(instagram|ig|facebook|fb|twitter|x|tiktok|tt|linkedin|li|whatsapp|wa|youtube|yt|pinterest|reddit|threads|snapchat|telegram|tg)$/;
const SEARCH_SRC = /^(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex)$/;
const PAID_MEDIUM = /^(cpc|ppc|paidsearch|paid|paid_social|paid-social|paidsocial|cpm|cpv|cpa|display|banner|retargeting|remarketing|interstitial)$/;
const EMAIL_MEDIUM = /^(email|e-mail|e_mail|newsletter)$/;
// GA4 clasifica por MEDIUM primero: utm_medium=social (y variantes) es Social orgánico
// aunque la fuente no esté en la lista (p.ej. un scheduler tipo buffer/metricool).
const SOCIAL_MEDIUM = /^(social|social[-_ ]?media|social[-_ ]?network|sm)$/;
export function channelOfV2(r: { ref?: string; utm_source?: string; utm_medium?: string; click_id?: string }): string {
  const src = String(r.utm_source || "").toLowerCase();
  const med = String(r.utm_medium || "").toLowerCase();
  const cid = String(r.click_id || "").toLowerCase();
  const refSrc = sourceName(r.ref || "");
  // OJO fbclid: Facebook lo añade a TODOS los clics salientes (orgánicos incluidos),
  // así que NO es señal de pago (GA4 tampoco lo trata como tal). Los click-ids que sí
  // son de plataformas de ads: gclid/msclkid (buscador) y ttclid/li_fat_id/twclid (social).
  const paidCid = cid && cid !== "fbclid";
  const paid = PAID_MEDIUM.test(med) || paidCid;
  if (EMAIL_MEDIUM.test(med) || /mail|newsletter/.test(src)) return "Email";
  if (/affiliate/.test(med)) return "Afiliados";
  if (paid) {
    if (cid === "gclid" || cid === "msclkid") return "Búsqueda de pago";
    if (SEARCH_SRC.test(src) || refSrc === "Buscadores") return "Búsqueda de pago";
    if (cid === "ttclid" || cid === "li_fat_id" || cid === "twclid" || SOCIAL_SRC.test(src) || ["Instagram", "Facebook", "X / Twitter", "TikTok", "LinkedIn", "WhatsApp", "YouTube", "Pinterest"].includes(refSrc)) return "Social de pago";
    return "Display / otros de pago";
  }
  if (src || med) {
    if (SOCIAL_MEDIUM.test(med) || SOCIAL_SRC.test(src)) return "Social orgánico";
    if (SEARCH_SRC.test(src)) return "Búsqueda orgánica";
    if (med === "referral" || r.ref) return "Referido";
    return "Otros (con UTM)";
  }
  const c = channelOf(r.ref || "");
  return c === "Social" ? "Social orgánico" : c;
}
/** Fuente v2: prioriza utm_source (con mayúscula legible) y cae al referrer. */
// WEB-COMPARAR-7 · el MEDIO de una sesion (la mitad derecha del par fuente/medio). Sacado a
// funcion para que la tabla general y el desglose por web lo calculen IGUAL: si no, las
// columnas por web no sumarian su fila. Regla: el utm_medium si vino; sin el, el click-id
// de ads manda (gclid sin UTM = auto-tagging de Google Ads -> cpc, como muestra GA; si no,
// no coincidiria con channelStats, que ya lo marca de pago); y si tampoco hay, (referral)
// con referrer u (ninguno) en directo.
export function mediumOfV2(a: { utm_medium?: string | null; click_id?: string | null; ref?: string | null }): string {
  const cid = String(a.click_id || "").toLowerCase();
  return String(a.utm_medium || "")
    || (cid === "gclid" || cid === "msclkid" ? "cpc"
      : (cid === "ttclid" || cid === "li_fat_id" || cid === "twclid" ? "paid_social"
        : (a.ref ? "(referral)" : "(ninguno)")));
}

export function sourceNameV2(r: { ref?: string; utm_source?: string }): string {
  const src = String(r.utm_source || "").trim();
  if (src) {
    const known: Record<string, string> = { ig: "Instagram", instagram: "Instagram", fb: "Facebook", facebook: "Facebook", google: "Google", bing: "Bing", tiktok: "TikTok", tt: "TikTok", linkedin: "LinkedIn", li: "LinkedIn", youtube: "YouTube", yt: "YouTube", whatsapp: "WhatsApp", wa: "WhatsApp", x: "X / Twitter", twitter: "X / Twitter", telegram: "Telegram", tg: "Telegram", newsletter: "Newsletter", email: "Email" };
    const k = src.toLowerCase();
    return (Object.prototype.hasOwnProperty.call(known, k) && known[k]) || src;
  }
  return sourceName(r.ref || "");
}

export interface PageViewIn {
  pageId: string; label?: string; ref?: string; ua?: string; ip?: string;
  path?: string; lang?: string; nonce?: string; tenantId?: string;
  country?: string; event?: string;
  utmSource?: string; utmMedium?: string; utmCampaign?: string; utmTerm?: string; utmContent?: string;
  clickId?: string; tzMin?: number; tzName?: string;
  /** EMBUDO-PAGINAS-1 · contacto (solo dígitos) resuelto de la marca lmc_ que puso /r/. */
  contact?: string;
}
/** Normaliza un valor UTM: recorta, minúsculas en source/medium (GA es case-insensitive ahí). */
function utmNorm(v: string | undefined, lower = false): string {
  const s = String(v || "").trim().slice(0, 120);
  return lower ? s.toLowerCase() : s;
}
/** COUNCIL-FIX (privacidad): la IP se usa en memoria para el hash de visitante y el país,
 *  pero se ALMACENA anonimizada — último octeto a 0 en IPv4, primeros 3 grupos en IPv6.
 *  La IP entera no aporta nada analítico después del insert y es dato personal RGPD. */
function anonIp(ip: string): string {
  const s = String(ip || "").trim();
  if (!s) return "";
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0`;
  if (s.includes(":")) return s.split(":").slice(0, 3).join(":") + "::";
  return "";
}
/** COUNCIL-FIX (privacidad): el referrer se guarda sin query ni fragment — una URL
 *  same-origin con ?gclid=VALOR o un email incrustado no deben acabar en la BD.
 *  sourceName/channelOf solo miran el hostname, así que no se pierde nada. */
function cleanRef(ref: string): string {
  const s = String(ref || "").trim();
  if (!s) return "";
  try { const u = new URL(s); return u.origin + u.pathname; } catch { return s.split("?")[0].split("#")[0]; }
}
export async function recordPageView(v: PageViewIn): Promise<void> {
  // NO-ADMIN-PREVIEW · el píxel del page-builder también dispara cuando el DUEÑO previsualiza
  // un borrador en /admin/pages/drafts/.../html (mismo snippet, mismo /pv). Eso no es un
  // visitante: es el operador mirando su propia página. Sin este filtro el panel Web contaba
  // esas previews como tráfico real ("1 usuario · 100% nuevo" = tú previsualizando).
  if ((v.path || "").startsWith("/admin/")) return;
  // BOT-FILTER · GA descarta crawlers y previews de mensajería; nosotros también. Sin esto,
  // compartir un enlace por WhatsApp ya contaba una "visita" (el unfurl de Meta dispara el
  // píxel) y los monitores de uptime inflaban Directo un hit por minuto.
  if (isBotUa(v.ua || "")) return;
  const device = deviceOf(v.ua || "");
  const visitor = crypto.createHash("sha256").update(`${v.ip || ""}|${v.ua || ""}`).digest("hex").slice(0, 16);
  const tzRaw = Number(v.tzMin);
  const r: MemView = {
    // SECURITY-FIX 2026-06-20 · el tenant llega resuelto desde el draft dueño de la
    // página (el píxel /pv es público y no tiene scope). Antes era 'default' fijo:
    // la analítica de workspaces no-default se guardaba en 'default' (fuga + 0 datos
    // para el inquilino real). Fallback 'default' para páginas sin draft.
    tenant_id: v.tenantId || "default",
    page_id: (v.pageId || "").slice(0, 200),
    page_label: (v.label || "").slice(0, 200),
    ref: cleanRef(v.ref || "").slice(0, 300),
    path: (v.path || "").slice(0, 300),
    device,
    browser: browserOf(v.ua || ""),
    os: osOf(v.ua || ""),
    lang: (v.lang || "").slice(0, 12),
    visitor,
    user_agent: (v.ua || "").slice(0, 400),
    ip: anonIp(v.ip || "").slice(0, 64),
    nonce: (v.nonce || "").slice(0, 40),
    duration_ms: 0,
    created_at: Date.now(),
    country: countryOf(v.country, v.lang, v.tzName, Number.isFinite(tzRaw) ? Math.round(tzRaw) : undefined),
    event: (v.event || "").slice(0, 60),
    utm_source: utmNorm(v.utmSource, true),
    utm_medium: utmNorm(v.utmMedium, true),
    utm_campaign: utmNorm(v.utmCampaign),
    utm_term: utmNorm(v.utmTerm),
    utm_content: utmNorm(v.utmContent),
    // click_id guarda QUÉ id de ads venía en la URL (gclid/fbclid/…), no su valor:
    // basta para clasificar el canal como pago y no almacenamos identificadores de terceros.
    click_id: utmNorm(v.clickId, true).slice(0, 20),
    scroll_pct: 0,
    load_ms: 0,
    // getTimezoneOffset() del navegador (min DETRÁS de UTC; España en verano = -120).
    tz_min: Number.isFinite(tzRaw) && Math.abs(tzRaw) <= 840 ? Math.round(tzRaw) : null,
    contact: claveContacto(String(v.contact || "")),
  };
  // Cap del buffer en memoria (sin DATABASE_URL el fallback era ilimitado y el píxel es público).
  if (!pool) { mem.push(r); if (mem.length > 50000) mem.splice(0, mem.length - 50000); return; }
  await pool.query(
    `INSERT INTO app_page_views (tenant_id,page_id,page_label,ref,path,device,browser,os,lang,visitor,user_agent,ip,nonce,country,event,utm_source,utm_medium,utm_campaign,utm_term,utm_content,click_id,tz_min,contact)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [r.tenant_id, r.page_id, r.page_label, r.ref, r.path, r.device, r.browser, r.os, r.lang, r.visitor, r.user_agent, r.ip, r.nonce, r.country, r.event,
     r.utm_source, r.utm_medium, r.utm_campaign, r.utm_term, r.utm_content, r.click_id, r.tz_min, r.contact || ""],
  );
}
/** 2º beacon (salida): tiempo de permanencia + scroll máximo + velocidad de carga.
 *  Actualiza la fila reciente por nonce. scroll/load solo pisan si llegan (>0). */
export async function recordPageDuration(nonce: string, durationMs: number, scrollPct?: number, loadMs?: number, tenantId?: string): Promise<void> {
  const ms = Math.max(0, Math.min(3600000, Math.floor(durationMs || 0)));
  const sc = Math.max(0, Math.min(100, Math.floor(scrollPct || 0)));
  const lt = Math.max(0, Math.min(120000, Math.floor(loadMs || 0)));
  if (!nonce) return;
  // COUNCIL-FIX: lmTrack comparte nonce con la vista (B lleva &n= embebido), así que las
  // filas de conversión tienen el MISMO nonce. El beacon de salida debe actualizar la
  // VISTA (sessionize solo suma dur de filas sin event): en memoria, la última fila sin
  // event; en SQL, WHERE event='' — si no, la duración caía en la fila de conversión.
  // VISITA-TENANT-1 · el nonce lo genera el navegador del visitante (Math.random en
  // el snippet) y viaja en la URL de un píxel PÚBLICO: no identifica a nadie ni está
  // acotado a un workspace. Sin tenant en el WHERE, un beacon de salida repetido con
  // el nonce de otra web podía pisar el tiempo de permanencia, el scroll y la
  // velocidad de carga de la visita de OTRO workspace. El tenant es el mismo que
  // resuelve pvTenantFor para esta petición (el que se usó al insertar la vista).
  const ws = tenantId || undefined;
  if (!pool) {
    const row = [...mem].reverse().find((m) => m.nonce === nonce && !m.event && (!ws || (m.tenant_id || "default") === ws));
    if (row) { row.duration_ms = ms; if (sc) row.scroll_pct = Math.max(row.scroll_pct, sc); if (lt) row.load_ms = lt; }
    return;
  }
  const args: unknown[] = [ms, sc, lt, nonce.slice(0, 40)];
  let wsSql = "";
  if (ws) { args.push(ws); wsSql = ` AND tenant_id=$${args.length}`; }
  await pool.query(
    `UPDATE app_page_views SET duration_ms=$1, scroll_pct=GREATEST(scroll_pct,$2), load_ms=CASE WHEN $3>0 THEN $3 ELSE load_ms END
      WHERE nonce=$4 AND event='' AND created_at > now() - interval '2 hours'${wsSql}`,
    args,
  );
}

/** Totales GA-grade de un conjunto de filas. Se calcula para el periodo actual y para el
 *  anterior (mismo tamaño), para poder mostrar el delta % con flecha como GA4. */
export interface CoreTotals {
  users: number; sessions: number; views: number;
  avgEngagementMs: number; avgSessionMs: number;
  engagementRate: number; bounceRate: number; pagesPerSession: number;
  conv: number; // nº de conversiones (WebStats.conversions es el objeto detallado)
}

/** ORIGEN-EMBUDO-1 (MET-WEB-04) · una fila por canal de llegada al embudo elegido (ver origenDelEmbudo). */
export interface FilaOrigen {
  /** El canal de channelOfV2, más «Tus mensajes». «Directo» NO es «escribió la dirección»: el panel
   *  lo enseña como «Origen sin identificar». */
  canal: string;
  /** Personas distintas que llegaron por este canal. */
  llegadas: number;
  /** De ellas, las que llegaron a algún paso medido DESPUÉS del primero. */
  avanzaron: number;
  /** De ellas, las que completaron el paso que da el resultado del embudo. */
  resultado: number;
  /** Fuente + campaña + pieza (utm_content) de esas llegadas. `campana` vacía = sin campaña. */
  campanas: { fuente: string; campana: string; pieza: string; llegadas: number; resultado: number }[];
  /** La página por la que entraron (la primera vista de la sesión, sea o no del embudo). */
  entradas: { web: string; etiqueta: string; ruta: string; llegadas: number }[];
  /** Personas de este canal que llegaron a cada paso, en el orden del mapa (-1 = paso sin medir). */
  pasos: number[];
}
/** ORIGEN-EMBUDO-1 · dos lecturas que NO se mezclan bajo una misma etiqueta:
 *  · `primera`: cada persona UNA vez, en el canal de su primera sesión del embudo EN ESTAS FECHAS, con
 *    lo que hizo en todo el periodo. Las filas suman `personas`, y su resultado, el del embudo.
 *  · `visita`: cada sesión en su canal, con lo que se hizo DENTRO de esas sesiones. Quien volvió por
 *    otro canal cuenta en los dos: la suma de filas no es el total. */
export interface OrigenEmbudo { personas: number; conAvance: boolean; primera: FilaOrigen[]; visita: FilaOrigen[] }

export interface WebStats extends CoreTotals {
  newPct: number;
  /** Totales del periodo INMEDIATAMENTE anterior (mismo nº de días) para los deltas. */
  prev: CoreTotals;
  /** Adquisición por canal GA4 (sesiones atribuidas por su PRIMER hit con origen):
   *  usuarios, sesiones (+ las del periodo anterior para el delta), % engagement y conv. */
  channelStats: { label: string; users: number; sessions: number; prevSessions: number; engagementRate: number; conv: number }[];
  /** Explorador de sesiones: las últimas visitas una a una (GA User Explorer lite). */
  recentSessions: { ts: number; site: string; siteId: string; landing: string; source: string; channel: string; device: string; country: string; views: number; durMs: number; conv: number }[];
  /** Campañas UTM (sesiones con utm_campaign) con su fuente/medio dominante. */
  campaigns: { label: string; source: string; medium: string; sessions: number; users: number; conv: number }[];
  /** Fuente / medio de sesión (tabla source/medium de GA): sesiones y conversiones. */
  sourceMedium: { source: string; medium: string; sessions: number; conv: number }[];
  /** Valores disponibles para los filtros avanzados (calculados ANTES de aplicar los
   *  filtros de dimensión, para que el desplegable no se vacíe al filtrar). */
  filterOptions: { channels: string[]; sources: string[]; campaigns: string[]; devices: string[]; countries: string[]; paths: string[] };
  /** Serie del periodo ANTERIOR (misma duración) para el overlay discontinuo del gráfico. */
  prevSeries: { date: string; views: number; users: number; sessions: number; conv: number }[];
  /** Heatmap semanal: vistas por [díaSemana 0=lunes..6=domingo][hora 0-23], hora local del visitante. */
  heat: number[][];
  /** Distribución del scroll máximo por vista (solo vistas con dato). */
  scrollDist: { bucket: string; value: number }[];
  /** Contenido (utm_content) de la sesión: qué post/anuncio concreto trae sesiones y conversiones. */
  contents: { label: string; source: string; campaign: string; sessions: number; conv: number }[];
  /** Usuarios nuevos vs recurrentes del rango (recurrente = visto en los 90 días previos). */
  newVsReturning: { newUsers: number; returning: number };
  /** Profundidad de scroll: media del máximo alcanzado (solo vistas con dato) y
   *  % de vistas que llegan al 90% (lectura completa). */
  scroll: { avg: number; reach90: number; sampled: number };
  /** Velocidad de carga (Navigation Timing del visitante): media, p75 y páginas lentas. */
  speed: { avg: number; p75: number; sampled: number; slow: { label: string; value: number }[] };
  /** Recorridos: transiciones página→página dentro de una sesión (top). */
  paths: { from: string; to: string; value: number }[];
  channels: { label: string; value: number }[];
  sources: { label: string; value: number }[];
  devices: { label: string; value: number }[];
  browsers: { label: string; value: number }[];
  os: { label: string; value: number }[];
  languages: { label: string; value: number }[];
  countries: { label: string; value: number }[];
  conversions: { total: number; rate: number; byEvent: { label: string; value: number }[]; byPage: { label: string; value: number }[] };
  /** Sitios para el selector de la UI: los que tienen datos en el rango (page_id + su
   *  etiqueta) MÁS el catálogo que segWeb fusiona después (webs de Conexiones, Páginas
   *  publicadas y píxeles registrados — aunque aún no tengan visitas). */
  sites: { id: string; label: string; views: number; kind?: string; domain?: string }[];
  pages: { id: string; label: string; site: string; siteId: string; views: number; visitors: number; avgMs: number; scrollAvg: number; loadMs: number; conv: number }[];
  /** Páginas de ENTRADA (primera vista de sesión) y de SALIDA (última) — GA landing/exit. */
  landing: { label: string; site: string; value: number }[];
  exits: { label: string; site: string; value: number }[];
  /** Comparativa por sitio (SIEMPRE que haya sitios con datos; segWeb añade filas a
   *  cero para las webs del catálogo sin visitas): usuarios, sesiones, vistas, rebote,
   *  duración y conversiones. */
  siteStats: { id: string; label: string; users: number; sessions: number; views: number; bounceRate: number; avgSessionMs: number; conv: number; convSessions: number }[];
  /** WEB-COMPARAR-5 · los desgloses de adquisicion, POR WEB. Sin esto, en «Todas» las tablas
   *  de canal / fuente / campana / contenido solo pueden ensenar la SUMA de las webs, que es
   *  justo lo que no sirve para decidir. Mismas reglas de atribucion que la tabla general:
   *  una sesion, su canal de entrada, y cada sesion atribuida a la web de su PRIMER hit. */
  desgloseBySite: {
    id: string; label: string;
    // `n` es el numero de esa fila para esa web: SESIONES en las dimensiones de sesion
    // (canal, fuente, campana, contenido) y VISTAS en las de vista (dispositivo, pais,
    // idioma, navegador, sistema). Se llama `n` justamente para no mentir en el nombre.
    channels: { label: string; n: number }[];
    sources: { label: string; n: number }[];
    campaigns: { label: string; n: number }[];
    contents: { label: string; n: number }[];
    devices: { label: string; n: number }[];
    countries: { label: string; n: number }[];
    languages: { label: string; n: number }[];
    browsers: { label: string; n: number }[];
    os: { label: string; n: number }[];
    // WEB-COMPARAR-7 · paginas de entrada y de salida (sesiones), saltos pagina->pagina
    // (`de -> a`, sesiones) y el par `fuente / medio` (sesiones). La etiqueta es la RUTA, sin
    // el sitio: al comparar, la misma ruta en dos webs es una fila con dos columnas.
    landing: { label: string; n: number }[];
    exits: { label: string; n: number }[];
    paths: { label: string; n: number }[];
    sourceMedium: { label: string; n: number }[];
  }[];
  /** WEB-COMPARAR-2 · las MISMAS cifras del periodo anterior, por web, para poder decir si
   *  cada una sube o baja. Sin esto, «cual va mejor» solo se puede responder en absoluto. */
  prevSiteStats: { id: string; users: number; sessions: number; views: number; conv: number }[];
  /** WEB-COMPARAR-2 · una serie diaria POR WEB, para dibujar una linea por web en vez de una
   *  sola linea sumada. Solo las webs con mas vistas del rango (tope abajo): una serie por
   *  cada web de un catalogo grande es una respuesta inaceptable, y mas de 5 lineas no se lee. */
  seriesBySite: { id: string; label: string; serie: { date: string; views: number; users: number; sessions: number; conv: number }[] }[];
  series: { date: string; views: number; users: number; sessions: number; conv: number }[];
  /** Reparto por hora del día (0-23, hora del servidor) para ver a qué hora entra la gente. */
  hourly: { hour: number; views: number }[];
  /** NEGOCIO-EMBUDO-1 · con «Comparar negocios»: una fila por negocio (y «Sin negocio
   *  asignado»), con los mismos filtros avanzados. La suma de filas NO es el total: la misma
   *  persona (dispositivo + conexión) puede visitar webs de dos negocios. */
  bizStats?: { id: string; nombre: string; webs: string[] | null; users: number; sessions: number; views: number; conv: number; engagementRate: number; prev: { users: number; sessions: number; views: number; conv: number } }[];
  /** NEGOCIO-EMBUDO-1 · webs con datos del rango ANTES de acotar al negocio (catálogo del editor). */
  sitesTodos?: { id: string; label: string; views: number }[];
  /** COMPARAR-EMBUDOS-1 (MET-WEB-05) · con un negocio y sin embudo elegido: una fila por
   *  embudo, con los mismos filtros avanzados y su periodo anterior. Una persona puede pasar
   *  por dos embudos: la suma de filas NO es el total del negocio. */
  funStats?: { id: string; nombre: string; objetivo: string; paginas: number; aviso: string; users: number; sessions: number; views: number; conv: number; eventos: { label: string; value: number }[]; prev: { users: number; sessions: number; views: number; conv: number }; resultado?: ResultadoEmbudo }[];
  /** COMPARAR-EMBUDOS-1 · con un embudo elegido: sus páginas en orden, con quién llegó a
   *  cada una, cuántas sesiones del embudo empezaron en ella y qué acciones se completaron
   *  allí. `rutaReal` es la ruta tal como llega en los datos (para filtrar por ella).
   *  MEDICION-EMBUDO-1 · también las etapas de acción (`personas` que la completaron) y los
   *  pasos externos (sin medir: todo a 0 y `tipo: 'externa'`). */
  etapas?: { web: string; ruta: string; compartida: boolean; rutaReal: string; llegadas: number; vistas: number; inicios: number; acciones: number; eventos: { label: string; value: number }[]; nombre?: string; tipo?: string; evento?: string; confirma?: boolean; personas?: number;
    /** RECORRIDO-EMBUDO-1 (MET-WEB-03) · `estado`: medido · pendiente (nunca llegó en 90 días) ·
     *  sin-medir (externo). `desde` = el último paso MEDIDO antes que este (-1 si no hay);
     *  `base` = sus personas y `siguieron` = cuántas de ESAS MISMAS llegaron también a este;
     *  `recientes` = de las que no siguieron, las que llegaron a `desde` en los 7 últimos días
     *  del periodo (aún pueden seguir). `dondeWeb`/`dondeRuta`: la página donde más se hace
     *  una acción. `url`: la dirección de un paso externo, si la dieron. */
    estado?: "medido" | "pendiente" | "sin-medir"; desde?: number; base?: number; siguieron?: number; recientes?: number; dondeWeb?: string; dondeRuta?: string; url?: string }[];
  /** RECORRIDO-EMBUDO-1 · el tramo medido donde más personas no siguieron, sin contar a las que
   *  llegaron en los 7 últimos días (null si en ninguno se puede afirmar una pérdida). */
  mayorPerdida?: { desde: number; hasta: number; base: number; siguieron: number; perdidos: number; recientes: number } | null;
  /** MET-LEADS-07-FIN · por paso medido, las personas cuyo último paso fue ese. `siguiente` = el
   *  siguiente paso medido (-1 si no hay); `sinVer` = entre medias hay un paso que no se mide, así
   *  que no se sabe si siguieron. `fichas` = las que tienen ficha (tope 200) y si escribieron después. */
  detenidos?: { paso: number; siguiente: number; sinVer: boolean; personas: number; recientes: number; edadMediana: number; conFicha: number; escribieron: number; compraron: number; correo: number; fichas: { phone: string; nombre: string; ultimo: number; escribio: boolean; compro: boolean; abrioCorreo: boolean }[] }[];
  /** MEDICION-EMBUDO-1 · con un embudo elegido: su resultado (ver ResultadoEmbudo). */
  resultado?: ResultadoEmbudo;
  /** COMPARAR-EMBUDOS-1 · el rango y el periodo anterior con el que se comparan las variaciones. */
  periodo?: { desde: number; hasta: number; prevDesde: number };
  /** ORIGEN-EMBUDO-1 (MET-WEB-04) · con un embudo elegido: de qué canales llega su gente y cuál avanza. */
  origenEmbudo?: OrigenEmbudo;
  configured: boolean;
}

const PV_COLS = "contact,page_id,page_label,ref,path,device,browser,os,lang,visitor,user_agent,duration_ms,country,event,utm_source,utm_medium,utm_campaign,utm_term,utm_content,click_id,scroll_pct,load_ms,tz_min";

/** Filtros avanzados GA: canal/fuente/campaña son dimensiones de SESIÓN (se filtran
 *  sesiones enteras por su atribución); dispositivo/país/página son dimensiones de vista. */
export interface WebFilters { channel?: string; source?: string; campaign?: string; device?: string; country?: string; path?: string }

export async function pageViewStats(days = 30, tenant = "default", win?: { sinceMs: number; untilMs: number }, siteId = "", wf?: WebFilters, ambito?: FiltroAmbitoWeb | null): Promise<WebStats> {
  const d = Math.max(1, Math.min(365, Math.floor(days)));
  const untilMs = win ? win.untilMs : Date.now();
  // COUNCIL-FIX: el clamp de 365 días también aplica a ventanas custom (?from=&to= no
  // pasaba por él y un rango multianual duplicado por el periodo-anterior era posible).
  const sinceMs = win ? Math.max(win.sinceMs, untilMs - 365 * 86400000) : Date.now() - d * 86400000;
  // Periodo ANTERIOR = misma duración justo antes de sinceMs, para el delta % de GA.
  const spanMs = Math.max(1, untilMs - sinceMs);
  const prevSinceMs = sinceMs - spanMs;
  // "Visitante previo" (para nuevos vs recurrentes) mira 90 días hacia atrás, como el
  // horizonte de GA4 — antes escaneaba TODO el historial del tenant en cada render.
  const priorFromMs = sinceMs - 90 * 86400000;
  let rows: any[] = [];
  let prevRows: any[] = [];
  let priorVisitors = new Set<string>();
  // day y hour SIEMPRE en UTC en ambos modos (memoria y SQL); la hora local del
  // visitante sale de tz_min en aggregate(), no de la zona del proceso/BD.
  const enrich = (m: any) => ({ ...m, day: new Date(m.created_at).toISOString().slice(0, 10), hour: new Date(m.created_at).getUTCHours(), ts: m.created_at });
  // NEGOCIO-EMBUDO-1 · con un negocio elegido, «recurrente» = ya visitó alguna web de ESE
  // negocio en los 90 días previos (con un embudo también: la regla de sesión por página no
  // se aplica a 90 días de historial).
  const incluirWebs = ambito && ambito.webs ? ambito.webs : null;
  const excluirWebs = ambito && !ambito.webs && ambito.excluir && ambito.excluir.length ? ambito.excluir : null;
  const enWebs = (pid: unknown) => (incluirWebs ? incluirWebs.includes(String(pid || "")) : excluirWebs ? !excluirWebs.includes(String(pid || "")) : true);
  if (!pool) {
    const notAdmin = (m: any) => m.tenant_id === tenant && !(m.path || "").startsWith("/admin/");
    rows = mem.filter((m) => notAdmin(m) && m.created_at >= sinceMs && m.created_at < untilMs).map(enrich);
    prevRows = mem.filter((m) => notAdmin(m) && m.created_at >= prevSinceMs && m.created_at < sinceMs).map(enrich);
    priorVisitors = new Set(mem.filter((m) => notAdmin(m) && m.created_at < sinceMs && m.created_at >= priorFromMs && enWebs(m.page_id)).map((m) => m.visitor));
  } else {
    // path NOT LIKE '/admin/%' · excluye también las previews históricas ya guardadas, sin
    // borrar filas (el registro nuevo ya las descarta en recordPageView). LIMIT defensivo:
    // la sesionización necesita filas crudas y con tráfico normal nunca se alcanza; si un
    // tenant lo supera, se agrega sobre las 200k vistas más recientes del rango.
    const q = (fromSec: number, toSec: number) => pool!.query(
      `SELECT ${PV_COLS}, (contact <> '') AS con_marca,
              to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day, extract(hour from created_at AT TIME ZONE 'UTC')::int AS hour, extract(epoch from created_at)*1000 AS ts
         FROM app_page_views
        WHERE tenant_id=$1 AND created_at >= to_timestamp($2) AND created_at < to_timestamp($3)
          AND path NOT LIKE '/admin/%'
        ORDER BY created_at DESC
        LIMIT 200000`,
      [tenant, fromSec, toSec],
    );
    const [res, resPrev, prior] = await Promise.all([
      q(sinceMs / 1000, untilMs / 1000),
      q(prevSinceMs / 1000, sinceMs / 1000),
      pool.query(
        `SELECT DISTINCT visitor FROM app_page_views
          WHERE tenant_id=$1 AND created_at < to_timestamp($2) AND created_at >= to_timestamp($3) AND path NOT LIKE '/admin/%'`
          + (incluirWebs ? ` AND page_id = ANY($4::text[])` : excluirWebs ? ` AND (page_id IS NULL OR NOT (page_id = ANY($4::text[])))` : ``),
        incluirWebs || excluirWebs
          ? [tenant, sinceMs / 1000, priorFromMs / 1000, incluirWebs || excluirWebs]
          : [tenant, sinceMs / 1000, priorFromMs / 1000],
      ),
    ]);
    rows = res.rows; prevRows = resPrev.rows;
    priorVisitors = new Set(prior.rows.map((x: any) => x.visitor));
  }
  // COUNCIL-FIX: el filtro de bots también en LECTURA — las filas guardadas antes del
  // filtro de escritura (unfurls de WhatsApp/Meta, monitores) seguían contando y además
  // sesgaban el delta vs periodo anterior (post-deploy filtrado vs pre-deploy con bots).
  const noBot = (r: any) => !isBotUa(String(r.user_agent || ""));
  rows = rows.filter(noBot);
  prevRows = prevRows.filter(noBot);
  // NEGOCIO-EMBUDO-1 · se acota al negocio (y al embudo) ANTES de todo lo demás: selector de
  // webs, filtros avanzados, tarjetas y comparativa por web hablan sólo de ese negocio. Las
  // filas sin acotar se guardan para «Comparar negocios» y para el catálogo del editor.
  const todasRows = rows, todasPrev = prevRows;
  if (ambito) { rows = filtrarAmbito(rows, ambito); prevRows = filtrarAmbito(prevRows, ambito); }
  // El selector lista TODOS los sitios del rango aunque se esté filtrando por uno: si se
  // calculara sobre lo ya filtrado, al elegir un sitio el desplegable se quedaría con una
  // sola opción y no habría forma de volver a "todos".
  const siteMap = new Map<string, { label: string; views: number }>();
  for (const r of rows) {
    if (r.event) continue;
    const id = String(r.page_id || "");
    if (!id) continue;
    const s = siteMap.get(id) || { label: String(r.page_label || id), views: 0 };
    s.views++;
    siteMap.set(id, s);
  }
  const sites = [...siteMap.entries()].map(([id, s]) => ({ id, label: s.label, views: s.views })).sort((a, b) => b.views - a.views);
  const sel = String(siteId || "").trim();
  const scoped = sel ? rows.filter((r) => String(r.page_id || "") === sel) : rows;
  const scopedPrev = sel ? prevRows.filter((r) => String(r.page_id || "") === sel) : prevRows;
  // Opciones de los filtros avanzados: SIEMPRE sobre lo pre-filtro (post-sitio), para
  // que al filtrar por un canal el desplegable siga listando los demás canales.
  const foCh = new Set<string>(), foSrc = new Set<string>(), foCamp = new Set<string>(), foDev = new Set<string>(), foGeo = new Set<string>();
  for (const s of sessionize(scoped)) {
    const a = sessAttr(s);
    foCh.add(channelOfV2(a)); foSrc.add(sourceNameV2(a));
    if (a.utm_campaign) foCamp.add(a.utm_campaign);
  }
  for (const r of scoped) if (!r.event) { foDev.add(String(r.device || "desktop")); if (r.country) foGeo.add(String(r.country)); }
  const foPa = new Map<string, number>();
  for (const r of scoped) if (!r.event && r.path) foPa.set(String(r.path), (foPa.get(String(r.path)) || 0) + 1);
  // Filtros avanzados: dispositivo/país por VISTA; canal/fuente/campaña por SESIÓN
  // entera (la sesión se queda o se va completa según su atribución — si se filtraran
  // vistas sueltas, sesiones/rebote/engagement quedarían rotos).
  // COMPARAR-EMBUDOS-1 · fábrica: las etapas del embudo aplican los mismos filtros SIN el de
  // página (si no, al elegir una etapa las demás se quedarían a cero).
  const mkApplyWf = (wf?: WebFilters) => {
    const hasWf = !!(wf && (wf.channel || wf.source || wf.campaign || wf.device || wf.country || wf.path));
    return (rws: any[]) => {
      if (!hasWf) return rws;
      let out = rws;
      if (wf!.device) out = out.filter((r) => String(r.device || "desktop") === wf!.device);
      if (wf!.country) out = out.filter((r) => String(r.country || "") === wf!.country);
      if (wf!.path) out = out.filter((r) => String(r.path || "") === wf!.path);
      if (wf!.channel || wf!.source || wf!.campaign) {
        const keep = new Set<any>();
        for (const s of sessionize(out)) {
          const a = sessAttr(s);
          if (wf!.channel && channelOfV2(a) !== wf!.channel) continue;
          if (wf!.source && sourceNameV2(a) !== wf!.source) continue;
          if (wf!.campaign && String(a.utm_campaign || "") !== wf!.campaign) continue;
          for (const r of s.rows) keep.add(r);
        }
        out = out.filter((r) => keep.has(r));
      }
      return out;
    };
  };
  const applyWf = mkApplyWf(wf);
  const prevF = applyWf(scopedPrev);
  const stats = aggregate(applyWf(scoped), priorVisitors, sites, coreTotals(prevF));
  // Sesiones por canal del PERIODO ANTERIOR → delta por canal en la tabla de adquisición.
  {
    const prevCh = new Map<string, number>();
    for (const s of sessionize(prevF)) {
      const ch = channelOfV2(sessAttr(s));
      prevCh.set(ch, (prevCh.get(ch) || 0) + 1);
    }
    for (const c of stats.channelStats) c.prevSessions = prevCh.get(c.label) || 0;
  }
  // COUNCIL-FIX (zero-fill): ambas series se rellenan a CERO en todos los días del rango.
  // Sin esto, el gráfico posiciona los puntos por índice y una serie con huecos (campaña
  // de 5 días, píxel recién instalado) se estiraba a todo el eje, desalineando la
  // comparación día a día con el periodo anterior.
  const zeroFill = (ser: { date: string; views: number; users: number; sessions: number; conv: number }[], fromMs: number, toMs: number) => {
    const by = new Map(ser.map((s) => [s.date, s]));
    const out: typeof ser = [];
    const push = (d: string) => { if (!out.length || out[out.length - 1].date !== d) out.push(by.get(d) || { date: d, views: 0, users: 0, sessions: 0, conv: 0 }); };
    for (let t = fromMs; t < toMs; t += 86400000) push(new Date(t).toISOString().slice(0, 10));
    push(new Date(Math.max(fromMs, toMs - 1)).toISOString().slice(0, 10));
    return out;
  };
  stats.series = zeroFill(stats.series, sinceMs, untilMs);
  // Serie del periodo anterior para el overlay discontinuo del gráfico (mismos filtros).
  stats.prevSeries = zeroFill(seriesOf(prevF), prevSinceMs, sinceMs);
  stats.filterOptions = {
    channels: [...foCh].sort(), sources: [...foSrc].sort(), campaigns: [...foCamp].sort(),
    devices: [...foDev].sort(), countries: [...foGeo].sort(),
    paths: [...foPa.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([p]) => p),
  };
  // Comparativa por sitio: SIEMPRE sobre todos los sitios (rows sin filtrar) para poder
  // compararlos aunque el informe esté filtrado a uno. COUNCIL-FIX: se sesioniza UNA
  // sola vez y cada sesión se atribuye al sitio de su PRIMER hit — antes se
  // re-sesionizaba cada partición por sitio y una sesión que cruzaba dos webs contaba
  // (y se partía) en ambas: la suma de la comparativa no cuadraba con las tarjetas.
  // Los sitios con SOLO conversiones en el rango también tienen fila (conv cuadra).
  // COUNCIL-FIX: la comparativa por web respeta los filtros AVANZADOS (canal/fuente/
  // campaña/dispositivo/país) — solo queda exenta del filtro de SITIO (a propósito:
  // sirve para comparar webs aunque una esté seleccionada). Antes ignoraba ambos y sus
  // cifras contradecían a los tiles filtrados en la misma pantalla.
  const wfRows = applyWf(rows);
  if (wfRows.length > 0) {
    const byId = new Map<string, any[]>();
    for (const r of wfRows) { const id = String(r.page_id || ""); if (!id) continue; (byId.get(id) || byId.set(id, []).get(id)!).push(r); }
    const sessBySite = new Map<string, Sess[]>();
    for (const s of sessionize(wfRows)) {
      const sid = String(((s.first || s.rows[0] || {}) as any).page_id || "");
      if (!sid) continue;
      (sessBySite.get(sid) || sessBySite.set(sid, []).get(sid)!).push(s);
    }
    const ids = [...new Set([...sites.map((s) => s.id), ...byId.keys()])];
    stats.siteStats = ids.map((id) => {
      const sr = byId.get(id) || [];
      const pv = sr.filter((r) => !r.event);
      const ss = sessBySite.get(id) || [];
      let engaged = 0, dur = 0;
      for (const s of ss) { if (isEngaged(s)) engaged++; dur += s.dur; }
      const label = sites.find((s) => s.id === id)?.label || String(sr[0]?.page_label || id);
      return {
        id, label,
        users: new Set(pv.map((r) => r.visitor)).size,
        sessions: ss.length,
        views: pv.length,
        bounceRate: ss.length ? Math.round(((ss.length - engaged) / ss.length) * 1000) / 10 : 0,
        avgSessionMs: ss.length ? Math.round(dur / ss.length) : 0,
        conv: sr.length - pv.length,
        // Sesiones con al menos una conversión: la «Tasa» de una web es sobre ESTAS (una sesión con
        // tres compras es una sola), nunca sobre las conversiones sueltas, que pasan de 100 %.
        convSessions: ss.filter((s) => s.conv > 0).length,
      };
    }).sort((a, b) => b.views - a.views);

    // WEB-COMPARAR-2 · MISMO reparto para el periodo anterior. Se reutiliza la regla de
    // arriba (sesionizar una vez y atribuir cada sesion al sitio de su PRIMER hit) para que
    // una sesion que cruza dos webs no cuente en las dos. Solo las cuatro cifras que se
    // comparan: rebote y duracion del periodo anterior no se piden en la tabla.
    const wfPrev = applyWf(prevRows);
    if (wfPrev.length > 0) {
      const pById = new Map<string, any[]>();
      for (const r of wfPrev) { const id = String(r.page_id || ""); if (!id) continue; (pById.get(id) || pById.set(id, []).get(id)!).push(r); }
      const pSess = new Map<string, number>();
      for (const ss2 of sessionize(wfPrev)) {
        const sid = String(((ss2.first || ss2.rows[0] || {}) as any).page_id || "");
        if (!sid) continue;
        pSess.set(sid, (pSess.get(sid) || 0) + 1);
      }
      stats.prevSiteStats = [...pById.keys()].map((id) => {
        const sr = pById.get(id) || [];
        const pv2 = sr.filter((r) => !r.event);
        return { id, users: new Set(pv2.map((r) => r.visitor)).size, sessions: pSess.get(id) || 0, views: pv2.length, conv: sr.length - pv2.length };
      });
    }

    // WEB-COMPARAR-5 · los desgloses de adquisicion, por web. Se recorren las sesiones que YA
    // estan repartidas (sessBySite) y se les aplica la MISMA atribucion que a la tabla
    // general: asi las columnas por web suman exactamente la fila del total, sin sorpresas.
    // El pais puede venir vacio y la tabla general tambien lo cuenta asi: si aqui se tirara,
    // las columnas por web no sumarian su fila. Solo se ignora lo que es null/undefined.
    const cuenta = (m: Map<string, number>, k: string) => { if (k == null) return; m.set(k, (m.get(k) || 0) + 1); };
    const orden = (m: Map<string, number>) => [...m.entries()]
      .map(([label, n]) => ({ label, n }))
      .sort((a, b) => b.n - a.n);
    // WEB-COMPARAR-7 · aggregate() ya trajo, por web, las paginas de entrada / salida, los
    // saltos y el par fuente/medio (se cuentan en su bucle de sesiones). Aqui se funden.
    const paginasDe = new Map((stats.desgloseBySite || []).map((d) => [d.id, d]));
    stats.desgloseBySite = stats.siteStats.map((x) => {
      const pg = paginasDe.get(x.id);
      // Dimensiones de SESION: se recorren las sesiones que ya estan repartidas por web.
      const ch = new Map<string, number>(), sr = new Map<string, number>();
      const ca = new Map<string, number>(), co = new Map<string, number>();
      for (const se of (sessBySite.get(x.id) || [])) {
        const a = sessAttr(se);
        cuenta(ch, channelOfV2(a));
        cuenta(sr, sourceNameV2(a));
        cuenta(ca, String(a.utm_campaign || ""));
        cuenta(co, String(a.utm_content || ""));
      }
      // Dimensiones de VISTA: salen de las filas de esa web, sin las de conversion (que no
      // son paginas vistas). Mismas etiquetas y mismos respaldos que la tabla general, o las
      // columnas por web no cuadrarian con su fila.
      const de = new Map<string, number>(), pa = new Map<string, number>();
      const idm = new Map<string, number>(), nv = new Map<string, number>(), so = new Map<string, number>();
      for (const r of (byId.get(x.id) || [])) {
        if (r.event) continue;
        cuenta(de, String(r.device || "desktop"));
        cuenta(pa, String(r.country || ""));
        cuenta(idm, String(r.lang || "").split("-")[0] || "—");
        cuenta(nv, String(r.browser || "Otro"));
        cuenta(so, String(r.os || "Otro"));
      }
      return { id: x.id, label: x.label,
        channels: orden(ch), sources: orden(sr), campaigns: orden(ca), contents: orden(co),
        devices: orden(de), countries: orden(pa), languages: orden(idm), browsers: orden(nv), os: orden(so),
        landing: pg ? pg.landing : [], exits: pg ? pg.exits : [], paths: pg ? pg.paths : [], sourceMedium: pg ? pg.sourceMedium : [] };
    });

    // WEB-COMPARAR-2 · una serie diaria por web. Se construye con las filas y las sesiones
    // que YA estan repartidas arriba: no se vuelve a sesionizar. Tope de 5 webs por vistas
    // (mas lineas no se leen, y el payload crece por dias x webs).
    const TOPE_LINEAS = 5;
    stats.seriesBySite = stats.siteStats
      .filter((x) => x.views > 0)
      .slice(0, TOPE_LINEAS)
      .map((x) => {
        const sr = byId.get(x.id) || [];
        const m = new Map<string, { v: number; u: Set<string>; c: number; s: number }>();
        const dia = (d: string) => { const o = m.get(d) || { v: 0, u: new Set<string>(), c: 0, s: 0 }; m.set(d, o); return o; };
        for (const r of sr) { const o = dia(String(r.day)); if (r.event) o.c++; else { o.v++; o.u.add(r.visitor); } }
        for (const se of (sessBySite.get(x.id) || [])) dia(String(se.day)).s++;
        const serie = [...m.entries()]
          .map(([date, o]) => ({ date, views: o.v, users: o.u.size, sessions: o.s, conv: o.c }))
          .sort((a, b) => a.date.localeCompare(b.date));
        return { id: x.id, label: x.label, serie: zeroFill(serie, sinceMs, untilMs) };
      });
  }
  // NEGOCIO-EMBUDO-1 · las webs con datos ANTES de acotar (el editor del mapa asigna también
  // las que hoy son de otro negocio) y, con «Comparar negocios», una fila por negocio con los
  // mismos filtros avanzados. Cada fila se calcula aparte: su suma NO es el total.
  if (ambito) {
    const todas = new Map<string, { label: string; views: number }>();
    for (const r of todasRows) {
      if (r.event) continue;
      const id = String(r.page_id || "");
      if (!id) continue;
      const s = todas.get(id) || { label: String(r.page_label || id), views: 0 };
      s.views++;
      todas.set(id, s);
    }
    stats.sitesTodos = [...todas.entries()].map(([id, s]) => ({ id, label: s.label, views: s.views })).sort((a, b) => b.views - a.views);
    if (ambito.comparar && ambito.comparar.length) {
      stats.bizStats = ambito.comparar.map((n) => {
        const f: FiltroAmbitoWeb = { webs: n.webs, excluir: n.excluir };
        const cur = coreTotals(applyWf(filtrarAmbito(todasRows, f)));
        const prv = coreTotals(applyWf(filtrarAmbito(todasPrev, f)));
        return {
          id: n.id, nombre: n.nombre, webs: n.webs ? n.webs.slice() : null,
          users: cur.users, sessions: cur.sessions, views: cur.views, conv: cur.conv, engagementRate: cur.engagementRate,
          prev: { users: prv.users, sessions: prv.sessions, views: prv.views, conv: prv.conv },
        };
      });
    }
    // COMPARAR-EMBUDOS-1 · una fila por embudo del negocio, sobre las filas del negocio (con la
    // regla de páginas compartidas de cada embudo) y con los mismos filtros avanzados.
    // MEDICION-EMBUDO-1 · y su resultado: personas que llegaron a la etapa que confirma.
    const resultados: { r: ResultadoEmbudo; s: SenalEmbudo }[] = [];
    if (ambito.embudos && ambito.embudos.length) {
      stats.funStats = ambito.embudos.map((e) => {
        const f: FiltroAmbitoWeb = { embudo: e.embudo };
        const curRows = applyWf(filtrarAmbito(rows, f));
        const prvRows = applyWf(filtrarAmbito(prevRows, f));
        const cur = coreTotals(curRows);
        const prv = coreTotals(prvRows);
        const sinFilas = resultadoSinFilas(e.aviso, e.senal || null);
        const resultado = sinFilas || resultadoEmbudo(e.senal || null, curRows, prvRows);
        if (e.senal && !sinFilas) resultados.push({ r: resultado, s: e.senal });
        return {
          id: e.id, nombre: e.nombre, objetivo: e.objetivo, paginas: e.paginas, aviso: e.aviso,
          users: cur.users, sessions: cur.sessions, views: cur.views, conv: cur.conv,
          eventos: topMap(curRows.filter((r) => r.event), (r) => String(r.event)).slice(0, 3),
          prev: { users: prv.users, sessions: prv.sessions, views: prv.views, conv: prv.conv },
          resultado,
        };
      });
    }
    // COMPARAR-EMBUDOS-1 · las etapas del embudo elegido: quién llegó a cada página, cuántas
    // sesiones del embudo empezaron en ella y qué acciones se completaron allí.
    const sinPagina = mkApplyWf(wf ? { ...wf, path: "" } : undefined);
    const base = ambito.embudo ? sinPagina(rows) : [];
    // MEDICION-EMBUDO-1 · el resultado del embudo elegido, sobre las mismas filas que sus etapas.
    const sinFilasUno = ambito.embudo ? resultadoSinFilas(ambito.aviso || "", ambito.senal || null) : null;
    if (ambito.embudo) {
      stats.resultado = sinFilasUno || resultadoEmbudo(ambito.senal || null, base, sinPagina(prevRows));
      if (ambito.senal && !sinFilasUno) resultados.push({ r: stats.resultado, s: ambito.senal });
    }
    // Sin páginas propias tampoco hay etapas que medir: sus «0» serían falsos (el panel ya
    // explica el aviso en lugar de mostrarlas).
    if (ambito.etapas && ambito.etapas.length && !sinFilasUno) {
      const kOf = (r: any) => claveDePagina(r.page_id || "", r.path || "");
      const porClave = new Map<string, any[]>();
      for (const r of base) { const k = kOf(r); (porClave.get(k) || porClave.set(k, []).get(k))!.push(r); }
      const inicios = new Map<string, number>();
      for (const s of sessionize(base)) if (s.first) { const k = kOf(s.first); inicios.set(k, (inicios.get(k) || 0) + 1); }
      stats.etapas = ambito.etapas.map((p) => {
        const extra = { nombre: p.nombre || "", tipo: p.tipo || "pagina", evento: p.evento || "", confirma: !!p.confirma, url: p.tipo === "externa" ? (p.url || "") : "" };
        // MEDICION-EMBUDO-1 · una acción: quién la completó (y cuántas veces) en el embudo.
        if (p.tipo === "accion") {
          const e = normalizarEvento(p.evento);
          const ev = base.filter((r) => r.event && normalizarEvento(r.event) === e);
          const personas = new Set(ev.map((r) => r.visitor)).size;
          // RECORRIDO-EMBUDO-1 · la página donde más se hace: pulsar la acción abre su informe.
          const dn = new Map<string, { web: string; ruta: string; n: number }>();
          for (const r of ev) { const w = String(r.page_id || ""), ru = String(r.path || ""), kk = w + "\u0000" + ru; const o = dn.get(kk) || { web: w, ruta: ru, n: 0 }; o.n++; dn.set(kk, o); }
          const donde = [...dn.values()].sort((a, b) => b.n - a.n)[0];
          return { web: "", ruta: "", compartida: false, rutaReal: "", llegadas: personas, vistas: 0, inicios: 0, acciones: ev.length, eventos: [], ...extra, personas, dondeWeb: donde ? donde.web : "", dondeRuta: donde ? donde.ruta : "" };
        }
        // Un paso externo no se mide: va a cero y el panel lo dice en vez de enseñar una caída.
        if (p.tipo === "externa") {
          return { web: "", ruta: "", compartida: false, rutaReal: "", llegadas: 0, vistas: 0, inicios: 0, acciones: 0, eventos: [], ...extra, personas: 0 };
        }
        const k = claveDePagina(p.web, p.ruta);
        const rs = porClave.get(k) || [];
        const vistas = rs.filter((r) => !r.event);
        const ev = rs.filter((r) => r.event);
        const rutas = topMap(vistas.length ? vistas : rs, (r) => String(r.path || ""));
        const llegadas = new Set(vistas.map((r) => r.visitor)).size;
        return {
          web: p.web, ruta: p.ruta, compartida: p.compartida,
          rutaReal: rutas.length && rutas[0].label !== "—" ? rutas[0].label : "",
          llegadas, vistas: vistas.length,
          inicios: inicios.get(k) || 0, acciones: ev.length,
          eventos: topMap(ev, (r) => String(r.event)).slice(0, 3),
          ...extra, personas: llegadas,
        };
      });
      // RECORRIDO-EMBUDO-1 (MET-WEB-03) · quién sigue de un paso al siguiente: las MISMAS personas
      // (por visitante), nunca una división de dos conteos. Cada paso se compara con el último paso
      // MEDIDO antes que él: uno externo o sin datos no corta el recorrido ni cuenta como abandono.
      const etps = ambito.etapas;
      const quienes = etps.map((p) => {
        // Primera y última llegada de cada persona a este paso.
        const m = new Map<string, { a: number; z: number }>();
        let rs: any[] = [];
        if (p.tipo === "accion") { const e = normalizarEvento(p.evento); rs = base.filter((r) => r.event && normalizarEvento(r.event) === e); }
        else if (p.tipo !== "externa") rs = (porClave.get(claveDePagina(p.web, p.ruta)) || []).filter((r) => !r.event);
        for (const r of rs) {
          const v = String(r.visitor || ""), t = Number(r.ts) || 0;
          if (!v) continue;
          const o = m.get(v);
          if (!o) m.set(v, { a: t, z: t }); else { if (t < o.a) o.a = t; if (t > o.z) o.z = t; }
        }
        return m;
      });
      const senalDeEtapa = (p: typeof etps[number]): SenalEmbudo => ({ nombre: p.nombre || "", tipo: p.tipo || "pagina", web: p.web, ruta: p.ruta, evento: p.evento || "" });
      // Un paso sin nadie en el periodo: ¿ha llegado alguna vez (90 días)? Si no, «Datos pendientes».
      const vacios = etps.filter((p, i) => p.tipo !== "externa" && !quienes[i].size).map(senalDeEtapa);
      const conDatosEt = vacios.length ? await senalesConDatos(tenant, vacios) : new Set<string>();
      const desdeReciente = untilMs - 7 * 86400000;
      let ant = -1;
      let peor: NonNullable<WebStats["mayorPerdida"]> | null = null;
      stats.etapas.forEach((st, i) => {
        const p = etps[i];
        st.estado = p.tipo === "externa" ? "sin-medir" : (!quienes[i].size && !conDatosEt.has(claveSenal(senalDeEtapa(p))) ? "pendiente" : "medido");
        st.desde = -1; st.base = 0; st.siguieron = 0; st.recientes = 0;
        if (st.estado !== "medido") return;
        if (ant >= 0) {
          const a = quienes[ant], b = quienes[i];
          let sig = 0, rec = 0;
          // Siguió = llegó a este paso DESPUÉS de haber llegado al anterior (quien llegó antes a
          // este y nunca volvió tras el anterior no «siguió»). Reciente = su última llegada al
          // paso anterior es de los 7 últimos días: aún puede seguir.
          for (const [v, o] of a) { const ob = b.get(v); if (ob && ob.z >= o.a) sig++; else if (o.z >= desdeReciente) rec++; }
          st.desde = ant; st.base = a.size; st.siguieron = sig; st.recientes = rec;
          // La pérdida que se puede afirmar no cuenta a quien llegó hace poco: aún puede seguir.
          const perdidos = a.size - sig, firmes = perdidos - rec;
          if (firmes > 0 && (!peor || firmes > peor.perdidos - peor.recientes)) peor = { desde: ant, hasta: i, base: a.size, siguieron: sig, perdidos, recientes: rec };
        }
        ant = i;
      });
      stats.mayorPerdida = peor;
      // MET-LEADS-07-FIN · dónde se detiene cada persona: su ÚLTIMO paso medido del embudo, con las
      // mismas llegadas (por visitante) que el recorrido. «No avanzó todavía» solo si el paso
      // siguiente se mide; si entre medias hay un paso externo o sin datos, es «no podemos ver el
      // siguiente paso». Quien llegó al último paso medido sin nada que medir detrás no se cuenta.
      const med = stats.etapas.map((st, i) => st.estado === "medido" ? i : -1).filter((i) => i >= 0);
      const ultimo = med.length ? med[med.length - 1] : -1;
      const contactoDe = new Map<string, string>();
      for (const r of base) { const v = String(r.visitor || ""), c = String(r.contact || ""); if (v && c && !contactoDe.has(v)) contactoDe.set(v, c); }
      const grupos = new Map<number, { paso: number; siguiente: number; sinVer: boolean; personas: number; recientes: number; edades: number[]; fichas: Map<string, number> }>();
      const vistos = new Set<string>();
      for (const i of med) for (const v of quienes[i].keys()) vistos.add(v);
      for (const v of vistos) {
        let j = -1;
        for (const i of med) if (quienes[i].has(v)) j = i;
        if (j < 0) continue;
        const sig = med.find((i) => i > j);
        const huecoDetras = stats.etapas.some((st, i) => i > j && (sig === undefined || i < sig) && st.estado !== "medido");
        if (j === ultimo && !huecoDetras) continue;
        const z = quienes[j].get(v)!.z;
        const g = grupos.get(j) || { paso: j, siguiente: sig === undefined ? -1 : sig, sinVer: huecoDetras, personas: 0, recientes: 0, edades: [] as number[], fichas: new Map<string, number>() };
        g.personas++;
        if (z >= desdeReciente) g.recientes++;
        g.edades.push(Math.max(0, untilMs - z));
        const c = contactoDe.get(v);
        if (c && (g.fichas.get(c) || 0) < z) g.fichas.set(c, z);
        grupos.set(j, g);
      }
      // Lo que pasó DESPUÉS con quien tiene ficha: si te escribió más tarde. Tope de fichas por
      // grupo para no leer el CRM entero; el total de personas no depende de él.
      const { getContact } = await import("./contacts.js");
      // MET-LEADS-07-FIN · y si compraron o abrieron un correo DESPUÉS de su último paso. Se mira la
      // situación de hoy: quien compra más tarde sale como «compró después» sin cambiar el grupo.
      const todas = [...grupos.values()].flatMap((g) => [...g.fichas.keys()].slice(0, 200));
      const { dbComprasFilasDeContactos, dbUltimoCorreoDeContactos } = await import("./db.js");
      const [comprasF, correoDe] = await Promise.all([dbComprasFilasDeContactos(todas).catch(() => []), dbUltimoCorreoDeContactos(todas).catch(() => new Map<string, number>())]);
      const ultimaCompra = new Map<string, number>();
      for (const c of comprasF) if (c.kind === "sale" && c.at > (ultimaCompra.get(c.phone) || 0)) ultimaCompra.set(c.phone, c.at);
      stats.detenidos = [];
      for (const g of [...grupos.values()].sort((a, b) => a.paso - b.paso)) {
        const ed = g.edades.sort((a, b) => a - b);
        const fichas: NonNullable<WebStats["detenidos"]>[number]["fichas"] = [];
        let escribieron = 0, compraron = 0, correo = 0;
        for (const [ph, z] of [...g.fichas.entries()].slice(0, 200)) {
          const c = await getContact(ph).catch(() => null);
          if (!c) continue;
          const escr = (Number(c.last_inbound) || 0) > z;
          if (escr) escribieron++;
          const compro = (ultimaCompra.get(ph) || 0) > z, abrioCorreo = (correoDe.get(ph) || 0) > z;
          if (compro) compraron++;
          if (abrioCorreo) correo++;
          fichas.push({ phone: ph, nombre: c.name || "", ultimo: z, escribio: escr, compro, abrioCorreo });
        }
        stats.detenidos.push({ paso: g.paso, siguiente: g.siguiente, sinVer: g.sinVer, personas: g.personas, recientes: g.recientes, edadMediana: ed.length ? ed[Math.floor(ed.length / 2)] : 0, conFicha: g.fichas.size, escribieron, compraron, correo, fichas });
      }
    }
    // MEDICION-EMBUDO-1 · una señal a cero en los dos periodos: ¿ha llegado alguna vez (90 días)?
    // Si nunca llegó es «Datos pendientes», no «0 registros».
    const aMirar = resultados.filter((x) => x.r.estado === "pendiente");
    if (aMirar.length) {
      const conDatos = await senalesConDatos(tenant, aMirar.map((x) => x.s));
      for (const x of aMirar) if (conDatos.has(claveSenal(x.s))) x.r.estado = "medido";
    }
    // ORIGEN-EMBUDO-1 (MET-WEB-04) · de qué canales llega la gente del embudo y cuál avanza, sobre las
    // MISMAS filas que sus etapas y su resultado. La sesión se atribuye con todas las filas del negocio.
    if (ambito.embudo) {
      const medidos = (stats.etapas || []).map((st) => st.estado === "medido");
      stats.origenEmbudo = origenDelEmbudo(filtrarAmbito(todasRows, { webs: ambito.webs, excluir: ambito.excluir }), base, ambito.etapas || [], medidos, ambito.senal || null);
    }
  }
  // COMPARAR-EMBUDOS-1 · el periodo con el que se comparan las variaciones, para decirlo en pantalla.
  stats.periodo = { desde: sinceMs, hasta: untilMs, prevDesde: prevSinceMs };
  return stats;
}

/** Una sesión reconstruida (gap 30 min, como GA). `first`/`last` son la primera y
 *  última VISTA (los eventos de conversión cuentan para engagement, no como páginas). */
interface Sess {
  visitor: string; start: number; day: string;
  views: number; dur: number; conv: number;
  first: any; last: any; rows: any[];
}
/** Sesionización única para TODA la analítica (totales, adquisición, entradas/salidas,
 *  recorridos): filas (vistas + conversiones) → sesiones con gap 30 min por visitante. */
function sessionize(rows: any[]): Sess[] {
  const byVisitor = new Map<string, any[]>();
  for (const r of rows) (byVisitor.get(r.visitor) || byVisitor.set(r.visitor, []).get(r.visitor))!.push(r);
  const out: Sess[] = [];
  for (const [v, vr] of byVisitor) {
    vr.sort((a, b) => Number(a.ts) - Number(b.ts));
    let cur: Sess | null = null; let lastTs = -Infinity;
    // COUNCIL-FIX: las sesiones SOLO-conversión (lmTrack >30 min tras la última vista, o
    // vista fuera del rango consultado) también cuentan — si se tiraban, la suma de conv
    // por canal/campaña no cuadraba con conversions.total (GA4 también cuenta sesiones
    // iniciadas por evento). first/last quedan null y los consumidores ya lo protegen.
    const close = () => { if (cur && (cur.views > 0 || cur.conv > 0)) out.push(cur); cur = null; };
    for (const r of vr) {
      const t = Number(r.ts);
      if (t - lastTs > 30 * 60000) { close(); cur = { visitor: v, start: t, day: r.day, views: 0, dur: 0, conv: 0, first: null, last: null, rows: [] }; }
      lastTs = t;
      if (r.event) cur!.conv++;
      else { cur!.views++; cur!.dur += Number(r.duration_ms) || 0; if (!cur!.first) cur!.first = r; cur!.last = r; }
      cur!.rows.push(r);
    }
    close();
  }
  return out;
}
/** NEGOCIO-EMBUDO-1 · acota filas (vistas + conversiones) a las webs de un negocio y, con un
 *  embudo, a sus páginas: las EXCLUSIVAS cuentan siempre; las COMPARTIDAS con otros embudos
 *  del negocio, sólo si la sesión (sobre todas las filas del negocio) pasa también por una
 *  exclusiva de este embudo. Las conversiones siguen la misma regla por la página en la que
 *  se registran. Sin filtro, las filas tal cual. */
export function filtrarAmbito<T>(rws: T[], f: FiltroAmbitoWeb | null | undefined): T[] {
  if (!f) return rws;
  let out: any[] = rws as any[];
  if (f.webs) { const dentro = new Set(f.webs); out = out.filter((r) => dentro.has(String(r.page_id || ""))); }
  if (f.excluir && f.excluir.length) { const fuera = new Set(f.excluir); out = out.filter((r) => !fuera.has(String(r.page_id || ""))); }
  if (f.embudo) {
    const propias = new Set(f.embudo.propias);
    const compartidas = new Set(f.embudo.compartidas);
    const memo = new Map<string, string>();
    const clave = (r: any) => {
      const raw = `${String(r.page_id || "")}\u0000${String(r.path || "")}`;
      let k = memo.get(raw);
      if (k === undefined) { k = claveDePagina(r.page_id || "", r.path || ""); memo.set(raw, k); }
      return k;
    };
    // MEDICION-EMBUDO-1 · las acciones de las etapas del embudo cuentan como una página
    // compartida: aunque se marquen en una página que no está en el embudo (el botón de pago de
    // una página de producto), entran si la sesión pasa por una página propia.
    // RECORRIDO-EMBUDO-1 · y con ellas la PÁGINA donde se hicieron, en esa misma sesión: pulsar la
    // acción abre el informe de esa página dentro del embudo, y sin sus vistas salía «sin visitas».
    const eventos = new Set(f.embudo.eventos || []);
    const keep = new Set<any>();
    // MET-WEB-07-FIN · la regla de la página compartida va por PERSONA, no por sesión: quien se
    // registró en la landing (propia) y vuelve otro día, desde otro dominio o desde otro aparato
    // (con la marca de un enlace del panel) a la página de gracias compartida sigue siendo de este
    // embudo. Antes esa segunda sesión no pasaba por una propia y su compra se perdía.
    const sesiones = sessionize(out);
    const quien = personaDeVisitante(out);
    const conPropia = new Set<string>();
    for (const s of sesiones) if (s.rows.some((r) => propias.has(clave(r)))) conPropia.add(quien(s.visitor));
    for (const s of sesiones) {
      const ks = s.rows.map(clave);
      const pasaPorPropia = conPropia.has(quien(s.visitor));
      const deAccion = new Set<string>();
      if (pasaPorPropia && eventos.size) s.rows.forEach((r, i) => { if (r.event && eventos.has(normalizarEvento(r.event))) deAccion.add(ks[i]); });
      s.rows.forEach((r, i) => {
        if (propias.has(ks[i]) || (pasaPorPropia && (compartidas.has(ks[i]) || deAccion.has(ks[i])))) keep.add(r);
      });
    }
    out = out.filter((r) => keep.has(r));
  }
  return out as T[];
}
/** MEDICION-EMBUDO-1 · PERSONAS distintas que llegaron a una señal en estas filas: una página
 *  (sus vistas) o una acción (lmTrack con ese nombre). Recargar la página de gracias o pulsar
 *  dos veces el botón de pago es la misma persona: cuenta una. */
function personasEnSenal(rws: any[], s: SenalEmbudo): number {
  // MET-WEB-07-FIN · la misma persona desde dos aparatos (la reconoce la marca del enlace del
  // panel) cuenta una vez; sin marca, cada aparato sigue siendo un visitante.
  const quien = personaDeVisitante(rws);
  if (s.tipo === "accion") {
    const e = normalizarEvento(s.evento);
    return new Set(rws.filter((r) => r.event && normalizarEvento(r.event) === e).map((r) => quien(r.visitor))).size;
  }
  if (s.tipo !== "pagina") return 0;
  const k = claveDePagina(s.web, s.ruta);
  return new Set(rws.filter((r) => !r.event && claveDePagina(r.page_id || "", r.path || "") === k).map((r) => quien(r.visitor))).size;
}
/** MET-WEB-07-FIN · persona detrás de un visitante (conexión + navegador): el contacto si alguna
 *  de sus filas trae la marca de un enlace del panel (lmc_, EMBUDO-PAGINAS-1); si no, él mismo. */
function personaDeVisitante(rws: any[]): (v: string) => string {
  const c = new Map<string, string>();
  for (const r of rws) if (r.contact && !c.has(String(r.visitor || ""))) c.set(String(r.visitor || ""), "c|" + r.contact);
  return (v) => c.get(String(v || "")) || "v|" + String(v || "");
}
/** ORIGEN-EMBUDO-1 (MET-WEB-04) · de dónde llegan las personas del embudo y cuáles avanzan. A cada
 *  persona se la sigue por su visitante (conexión + navegador): es una aproximación.
 *  La sesión se atribuye con TODAS sus filas del negocio (quien entró por el blog desde Google y luego
 *  pasó a la landing vino de Google, no «sin origen»), pero sólo cuentan las sesiones que tocan el
 *  embudo y, de ellas, sus filas del embudo (`base`: los mismos filtros que las etapas).
 *  Una sesión sin campaña ni web de procedencia que trae la marca de un enlace enviado desde el panel
 *  (lmc_, EMBUDO-PAGINAS-1) es «Tus mensajes»: se sabe que vino de un mensaje, no de cuál. Las marcas
 *  de campaña o la web de procedencia, si las hay, siguen mandando. */
function origenDelEmbudo(negocio: any[], base: any[], etapas: NonNullable<FiltroAmbitoWeb["etapas"]>, medidos: boolean[], senal: SenalEmbudo | null): OrigenEmbudo {
  const memo = new Map<string, string>();
  const kFila = (r: any): string => {
    if (r.event) return "e|" + normalizarEvento(r.event);
    const raw = String(r.page_id || "") + "\u0000" + String(r.path || "");
    let k = memo.get(raw);
    if (k === undefined) { k = "p|" + claveDePagina(r.page_id || "", r.path || ""); memo.set(raw, k); }
    return k;
  };
  // Qué pasos MEDIDOS casan con cada clave de fila (uno externo o sin datos no cuenta), y la del resultado.
  const porClave = new Map<string, number[]>();
  etapas.forEach((p, i) => {
    if (!medidos[i] || p.tipo === "externa") return;
    const ev = p.tipo === "accion" ? normalizarEvento(p.evento) : "";
    const k = p.tipo === "accion" ? (ev ? "e|" + ev : "") : "p|" + claveDePagina(p.web, p.ruta);
    if (k) (porClave.get(k) || porClave.set(k, []).get(k))!.push(i);
  });
  const evRes = senal && senal.tipo === "accion" ? normalizarEvento(senal.evento) : "";
  const kRes = !senal ? "" : senal.tipo === "accion" ? (evRes ? "e|" + evRes : "") : senal.tipo === "pagina" ? "p|" + claveDePagina(senal.web, senal.ruta) : "";
  // «Avanzaron» = llegaron a algún paso medido DESPUÉS del primero medido.
  const despues = new Set(medidos.map((m, i) => (m ? i : -1)).filter((i) => i >= 0).slice(1));
  const enBase = new Set(base);
  // MET-WEB-07-FIN · la persona, no el aparato: el contacto que vuelve desde el móvil con la marca
  // del enlace es el mismo que entró desde el PC.
  const quien = personaDeVisitante(negocio);
  // Por persona y en TODO el periodo: a qué pasos llegó y si dio el resultado.
  const alcanzo = new Map<string, Set<number>>();
  const logro = new Set<string>();
  for (const r of base) {
    const v = quien(r.visitor), k = kFila(r), ps = porClave.get(k);
    if (ps) { let s = alcanzo.get(v); if (!s) { s = new Set<number>(); alcanzo.set(v, s); } for (const i of ps) s.add(i); }
    if (kRes && k === kRes) logro.add(v);
  }
  type Ses = { v: string; start: number; canal: string; a: ReturnType<typeof sessAttr>; entrada: any; pasos: Set<number>; res: boolean };
  const sesiones: Ses[] = [];
  for (const s of sessionize(negocio)) {
    const fr = s.rows.filter((r) => enBase.has(r));
    if (!fr.length) continue;
    const a = sessAttr(s);
    let canal = channelOfV2(a);
    if (canal === "Directo" && s.rows.some((r) => r.con_marca || r.contact)) canal = "Tus mensajes";
    const pasos = new Set<number>();
    let res = false;
    for (const r of fr) { const k = kFila(r), ps = porClave.get(k); if (ps) for (const i of ps) pasos.add(i); if (kRes && k === kRes) res = true; }
    sesiones.push({ v: quien(s.visitor), start: s.start, canal, a, entrada: s.first, pasos, res });
  }
  type Acc = {
    quien: Set<string>; avz: Set<string>; res: Set<string>; pasos: Set<string>[];
    camp: Map<string, { fuente: string; campana: string; pieza: string; quien: Set<string>; res: Set<string> }>;
    ent: Map<string, { web: string; etiqueta: string; ruta: string; quien: Set<string> }>;
  };
  const anota = (m: Map<string, Acc>, x: Ses, pasos: Set<number>, res: boolean) => {
    let f = m.get(x.canal);
    if (!f) { f = { quien: new Set(), avz: new Set(), res: new Set(), pasos: etapas.map(() => new Set<string>()), camp: new Map(), ent: new Map() }; m.set(x.canal, f); }
    f.quien.add(x.v);
    for (const i of pasos) { f.pasos[i].add(x.v); if (despues.has(i)) f.avz.add(x.v); }
    if (res) f.res.add(x.v);
    const fuente = x.a.utm_source || x.a.ref ? sourceNameV2(x.a) : "";
    const kc = fuente + "\u0000" + x.a.utm_campaign + "\u0000" + x.a.utm_content;
    let c = f.camp.get(kc);
    if (!c) { c = { fuente, campana: x.a.utm_campaign, pieza: x.a.utm_content, quien: new Set(), res: new Set() }; f.camp.set(kc, c); }
    c.quien.add(x.v);
    if (res) c.res.add(x.v);
    if (x.entrada) {
      const ke = kFila(x.entrada);
      let e = f.ent.get(ke);
      if (!e) { e = { web: String(x.entrada.page_id || ""), etiqueta: String(x.entrada.page_label || x.entrada.page_id || ""), ruta: String(x.entrada.path || ""), quien: new Set() }; f.ent.set(ke, e); }
      e.quien.add(x.v);
    }
  };
  // Primera llegada: la sesión del embudo más temprana de cada persona en estas fechas.
  const primera = new Map<string, Ses>();
  for (const x of sesiones) { const o = primera.get(x.v); if (!o || x.start < o.start) primera.set(x.v, x); }
  const mPrimera = new Map<string, Acc>(), mVisita = new Map<string, Acc>();
  for (const [v, x] of primera) anota(mPrimera, x, alcanzo.get(v) || new Set<number>(), logro.has(v));
  for (const x of sesiones) anota(mVisita, x, x.pasos, x.res);
  const filas = (m: Map<string, Acc>): FilaOrigen[] => [...m.entries()].map(([canal, f]) => ({
    canal, llegadas: f.quien.size, avanzaron: f.avz.size, resultado: f.res.size,
    campanas: [...f.camp.values()].map((c) => ({ fuente: c.fuente, campana: c.campana, pieza: c.pieza, llegadas: c.quien.size, resultado: c.res.size }))
      .sort((a, b) => b.llegadas - a.llegadas || b.resultado - a.resultado).slice(0, 25),
    entradas: [...f.ent.values()].map((e) => ({ web: e.web, etiqueta: e.etiqueta, ruta: e.ruta, llegadas: e.quien.size }))
      .sort((a, b) => b.llegadas - a.llegadas).slice(0, 10),
    pasos: f.pasos.map((s, i) => (medidos[i] ? s.size : -1)),
  })).sort((a, b) => b.llegadas - a.llegadas || b.resultado - a.resultado || a.canal.localeCompare(b.canal));
  return { personas: primera.size, conAvance: despues.size > 0, primera: filas(mPrimera), visita: filas(mVisita) };
}
/** Clave de una señal para saber si ya ha llegado alguna vez. */
function claveSenal(s: SenalEmbudo): string {
  return s.tipo === "accion" ? `e|${normalizarEvento(s.evento)}` : `p|${claveDePagina(s.web, s.ruta)}`;
}
/** MEDICION-EMBUDO-1 · un embudo sin páginas propias (aviso `sin-paginas` / `sin-propias`) no
 *  tiene filas que contar: `filtrarAmbito` las descarta todas, y un 0 calculado sobre nada se
 *  leería como «0 registros». Devuelve su «Sin medir» con el motivo, o null si hay que medir. */
function resultadoSinFilas(aviso: string, s: SenalEmbudo | null): ResultadoEmbudo | null {
  if (aviso !== "sin-paginas" && aviso !== "sin-propias") return null;
  const etapa = s ? (s.nombre || (s.tipo === "accion" ? s.evento : s.tipo === "pagina" ? s.ruta : "")) : "";
  return { estado: "sin-medir", motivo: aviso, etapa, tipo: s ? s.tipo : "", valor: 0, prev: 0 };
}
/** MEDICION-EMBUDO-1 · resultado de un embudo sobre sus filas (ya acotadas y filtradas) del
 *  periodo y del anterior. Una señal a cero en los dos queda `pendiente` hasta que
 *  `senalesConDatos` diga si ha llegado alguna vez. */
function resultadoEmbudo(s: SenalEmbudo | null, cur: any[], prv: any[]): ResultadoEmbudo {
  if (!s) return { estado: "sin-medir", motivo: "sin-confirmacion", etapa: "", tipo: "", valor: 0, prev: 0 };
  const etapa = s.nombre || (s.tipo === "accion" ? s.evento : s.tipo === "pagina" ? s.ruta : "");
  if (s.tipo === "externa") return { estado: "sin-medir", motivo: "externa", etapa, tipo: s.tipo, valor: 0, prev: 0 };
  const valor = personasEnSenal(cur, s), prev = personasEnSenal(prv, s);
  return { estado: valor > 0 || prev > 0 ? "medido" : "pendiente", motivo: "", etapa, tipo: s.tipo, valor, prev };
}
/** MEDICION-EMBUDO-1 · de estas señales, cuáles han llegado alguna vez en los últimos `dias`
 *  (en cualquier página: lo que se comprueba es que la medición está puesta). Una señal que
 *  nunca llegó es «Datos pendientes», no un cero. */
async function senalesConDatos(tenant: string, senales: SenalEmbudo[], dias = 90): Promise<Set<string>> {
  const out = new Set<string>();
  const evs = [...new Set(senales.filter((s) => s.tipo === "accion" && s.evento).map((s) => normalizarEvento(s.evento)))];
  const pags = senales.filter((s) => s.tipo === "pagina" && s.web);
  if (!evs.length && !pags.length) return out;
  const desde = Date.now() - dias * 86400000;
  const quiero = new Set(pags.map((s) => claveDePagina(s.web, s.ruta)));
  const mira = (web: unknown, path: unknown, ev: unknown) => {
    if (ev) { const e = normalizarEvento(ev); if (evs.includes(e)) out.add(`e|${e}`); return; }
    const k = claveDePagina(web || "", path || "");
    if (quiero.has(k)) out.add(`p|${k}`);
  };
  if (!pool) {
    for (const x of mem) {
      if (x.tenant_id !== tenant || x.created_at < desde || (x.path || "").startsWith("/admin/")) continue;
      mira(x.page_id, x.path, x.event);
    }
    return out;
  }
  const res = await pool.query(
    `SELECT page_id, path, COALESCE(event,'') AS event
       FROM app_page_views
      WHERE tenant_id=$1 AND created_at >= to_timestamp($2) AND path NOT LIKE '/admin/%'
        AND ((COALESCE(event,'') <> '' AND lower(regexp_replace(btrim(event), '\\s+', ' ', 'g')) = ANY($3::text[]))
          OR (COALESCE(event,'') = '' AND page_id = ANY($4::text[])))
      GROUP BY 1, 2, 3
      LIMIT 5000`,
    [tenant, desde / 1000, evs, [...new Set(pags.map((s) => s.web))]],
  );
  for (const r of res.rows) mira(r.page_id, r.path, r.event);
  return out;
}
/** MEDICION-EMBUDO-1 · acciones (lmTrack) que han llegado en los últimos `dias`, para elegirlas
 *  como etapa en el editor: el nombre tal como llega, las más frecuentes primero. */
export async function eventosVistos(tenant: string, dias = 90, limite = 200): Promise<{ evento: string; veces: number }[]> {
  const desde = Date.now() - Math.max(1, Math.min(365, Math.floor(dias))) * 86400000;
  const tope = Math.max(1, Math.min(500, Math.floor(limite)));
  let crudas: { evento: string; veces: number }[] = [];
  if (!pool) {
    const m = new Map<string, number>();
    for (const x of mem) {
      if (x.tenant_id !== tenant || x.created_at < desde || !x.event || (x.path || "").startsWith("/admin/")) continue;
      m.set(x.event, (m.get(x.event) || 0) + 1);
    }
    crudas = [...m.entries()].map(([evento, veces]) => ({ evento, veces }));
  } else {
    const res = await pool.query(
      `SELECT event AS evento, count(*)::int AS veces
         FROM app_page_views
        WHERE tenant_id=$1 AND created_at >= to_timestamp($2) AND COALESCE(event,'') <> ''
          AND path NOT LIKE '/admin/%'
        GROUP BY event
        ORDER BY veces DESC
        LIMIT 1000`,
      [tenant, desde / 1000],
    );
    crudas = res.rows.map((r: any) => ({ evento: String(r.evento), veces: Number(r.veces) || 0 }));
  }
  // «Compra» y «compra» son la misma acción: se suman bajo el nombre más usado.
  const porClave = new Map<string, { evento: string; veces: number; top: number }>();
  for (const c of crudas) {
    const k = normalizarEvento(c.evento);
    if (!k) continue;
    const o = porClave.get(k) || { evento: c.evento.trim(), veces: 0, top: 0 };
    o.veces += c.veces;
    if (c.veces > o.top) { o.top = c.veces; o.evento = c.evento.trim(); }
    porClave.set(k, o);
  }
  return [...porClave.values()].sort((a, b) => b.veces - a.veces).slice(0, tope).map((o) => ({ evento: o.evento, veces: o.veces }));
}
/** Sesión comprometida (GA4): ≥10s de engagement, ≥2 páginas O una conversión. */
const isEngaged = (s: Sess) => s.dur >= 10000 || s.views > 1 || s.conv > 0;
/** Atribución de la sesión: el PRIMER hit con origen de campaña (UTM/click-id) manda;
 *  sin campaña, el referrer de la primera vista. Como el snippet persiste los UTM en
 *  sessionStorage, las vistas intermedias también los llevan. */
function sessAttr(s: Sess): { ref: string; utm_source: string; utm_medium: string; utm_campaign: string; utm_term: string; utm_content: string; click_id: string } {
  // COUNCIL-FIX: el predicado cubre los 6 campos de campaña — un enlace etiquetado SOLO
  // con utm_campaign/term/content (sin source/medium) también es origen de campaña.
  const w = s.rows.find((r) => r.utm_source || r.utm_medium || r.utm_campaign || r.utm_term || r.utm_content || r.click_id);
  const base = s.first || s.rows[0] || {};
  return {
    ref: String(base.ref || ""),
    utm_source: String(w?.utm_source || ""), utm_medium: String(w?.utm_medium || ""),
    utm_campaign: String(w?.utm_campaign || ""), utm_term: String(w?.utm_term || ""),
    utm_content: String(w?.utm_content || ""), click_id: String(w?.click_id || ""),
  };
}

/** Serie diaria (vistas/usuarios/sesiones/conversiones) de un conjunto de filas —
 *  compartida por el periodo actual y el ANTERIOR (overlay del gráfico). */
function seriesOf(rows: any[]): { date: string; views: number; users: number; sessions: number; conv: number }[] {
  const m = new Map<string, { v: number; u: Set<string>; c: number }>();
  const day = (r: any) => { const o = m.get(r.day) || { v: 0, u: new Set<string>(), c: 0 }; m.set(r.day, o); return o; };
  for (const r of rows) { const o = day(r); if (r.event) o.c++; else { o.v++; o.u.add(r.visitor); } }
  const sBy = new Map<string, number>();
  // METRICAS-1 · cada sesión cuenta en su día (antes solo las «primeras»: la serie no sumaba lo que coreTotals).
  for (const s of sessionize(rows)) sBy.set(s.day, (sBy.get(s.day) || 0) + 1);
  return [...m.entries()].map(([date, o]) => ({ date, views: o.v, users: o.u.size, sessions: sBy.get(date) || 0, conv: o.c })).sort((a, b) => a.date.localeCompare(b.date));
}

/** Métricas núcleo GA de un conjunto de filas (sesiones con gap 30 min). Compartido por el
 *  periodo actual (dentro de aggregate) y el anterior (para los deltas). */
export function coreTotals(rows: any[]): CoreTotals {
  const pv = rows.filter((r) => !r.event);
  const conv = rows.length - pv.length;
  const sess = sessionize(rows);
  const users = new Set(pv.map((r) => r.visitor)).size;
  // COUNCIL-FIX: numerador y denominador coherentes — avgEngagement divide SOLO la
  // duración de las sesiones comprometidas entre las comprometidas (antes mezclaba la
  // duración de todas, y 9 rebotes de 5s + 1 engaged daban una "media" imposible).
  let engaged = 0, totalDur = 0, engagedDur = 0;
  for (const s of sess) { totalDur += s.dur; if (isEngaged(s)) { engaged++; engagedDur += s.dur; } }
  const sessions = sess.length;
  return {
    users,
    sessions,
    views: pv.length,
    // avgEngagement = media sobre sesiones COMPROMETIDAS; avgSession = media sobre TODAS (GA4).
    avgEngagementMs: engaged ? Math.round(engagedDur / engaged) : 0,
    avgSessionMs: sessions ? Math.round(totalDur / sessions) : 0,
    engagementRate: sessions ? Math.round((engaged / sessions) * 1000) / 10 : 0,
    bounceRate: sessions ? Math.round(((sessions - engaged) / sessions) * 1000) / 10 : 0,
    pagesPerSession: sessions ? Math.round((pv.length / sessions) * 10) / 10 : 0,
    conv,
  };
}

function topMap(rows: any[], keyFn: (r: any) => string): { label: string; value: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) { const k = keyFn(r) || "—"; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function aggregate(rows: any[], priorVisitors: Set<string>, sites: { id: string; label: string; views: number }[] = [], prev: CoreTotals = coreTotals([])): WebStats {
  const core = coreTotals(rows);
  const pvRows = rows.filter((r) => !r.event);
  const convRows = rows.filter((r) => r.event);
  const newUsers = new Set<string>();
  // COUNCIL-FIX: clave compuesta SITIO+RUTA en todas las agrupaciones de página — con
  // varios sitios en el tenant, las rutas repetidas ('/' en todas las landings) fundían
  // vistas/entradas/salidas/recorridos de sitios distintos en una sola fila atribuida al
  // primer sitio en aparecer. La etiqueta visible sigue siendo la ruta; el sitio va aparte.
  const pageKey = (r: any) => String(r.page_id || "") + "\u0000" + String(r.path || r.page_label || "—");
  const pageLabel = (r: any) => String(r.path || r.page_label || r.page_id || "—");
  const pageMap = new Map<string, { label: string; site: string; sid: string; views: number; vis: Set<string>; dur: number; durN: number; sc: number; scN: number; lt: number; ltN: number; conv: number }>();
  const newPage = (r: any) => ({ label: pageLabel(r), site: String(r.page_label || r.page_id || ""), sid: String(r.page_id || ""), views: 0, vis: new Set<string>(), dur: 0, durN: 0, sc: 0, scN: 0, lt: 0, ltN: 0, conv: 0 });
  for (const r of pvRows) {
    if (!priorVisitors.has(r.visitor)) newUsers.add(r.visitor);
    const pid = pageKey(r);
    const pm = pageMap.get(pid) || newPage(r);
    pm.views++; pm.vis.add(r.visitor);
    if (r.duration_ms > 0) { pm.dur += Number(r.duration_ms); pm.durN++; }
    if (Number(r.scroll_pct) > 0) { pm.sc += Number(r.scroll_pct); pm.scN++; }
    if (Number(r.load_ms) > 0) { pm.lt += Number(r.load_ms); pm.ltN++; }
    pageMap.set(pid, pm);
  }
  // Conversiones POR PÁGINA (la fila de evento lleva la ruta donde ocurrió).
  for (const r of convRows) {
    const pid = pageKey(r);
    const pm = pageMap.get(pid) || newPage(r);
    pm.conv++;
    pageMap.set(pid, pm);
  }
  // Sesionización ÚNICA (gap 30 min): de aquí salen entradas/salidas, sesiones por día,
  // adquisición por canal/fuente/campaña (atribución de sesión GA4) y recorridos.
  const sess = sessionize(rows);
  const landingMap = new Map<string, { label: string; site: string; value: number }>();
  const exitMap = new Map<string, { label: string; site: string; value: number }>();
  const sessByDay = new Map<string, number>();
  const bump = (m: Map<string, { label: string; site: string; value: number }>, r: any) => {
    const k = pageKey(r);
    const cur = m.get(k) || { label: pageLabel(r), site: String(r.page_label || r.page_id || ""), value: 0 };
    cur.value++; m.set(k, cur);
  };
  // Adquisición por canal (GA4): sesiones/usuarios/engagement/conversiones por canal.
  const chMap = new Map<string, { users: Set<string>; sessions: number; engaged: number; conv: number }>();
  const srcMap = new Map<string, number>();
  const campMap = new Map<string, { source: string; medium: string; sessions: number; users: Set<string>; conv: number }>();
  const contMap = new Map<string, { source: string; campaign: string; sessions: number; conv: number }>();
  const smMap = new Map<string, { source: string; medium: string; sessions: number; conv: number }>();
  const pathsMap = new Map<string, { from: string; to: string; value: number }>();
  // WEB-COMPARAR-7 · lo mismo, POR WEB: entrada, salida, saltos y fuente/medio de cada
  // sesion, atribuida a la web de su PRIMER hit (la misma regla que sessBySite). Se cuenta
  // en este mismo bucle para que cada columna por web sume EXACTAMENTE su fila del total.
  type Cnt = Map<string, number>;
  const porWeb = new Map<string, { landing: Cnt; exits: Cnt; paths: Cnt; sourceMedium: Cnt }>();
  const webDe = (x: Sess) => {
    const sid = String(((x.first || x.rows[0] || {}) as any).page_id || "");
    if (!sid) return null;
    let w = porWeb.get(sid);
    if (!w) { w = { landing: new Map(), exits: new Map(), paths: new Map(), sourceMedium: new Map() }; porWeb.set(sid, w); }
    return w;
  };
  const mas = (m: Cnt, k: string) => m.set(k, (m.get(k) || 0) + 1);
  for (const s of sess) {
    const w7 = webDe(s);
    if (s.first) { bump(landingMap, s.first); sessByDay.set(s.day, (sessByDay.get(s.day) || 0) + 1); if (w7) mas(w7.landing, pageLabel(s.first)); }
    if (s.last) { bump(exitMap, s.last); if (w7) mas(w7.exits, pageLabel(s.last)); }
    const a = sessAttr(s);
    const ch = channelOfV2(a);
    const c = chMap.get(ch) || { users: new Set<string>(), sessions: 0, engaged: 0, conv: 0 };
    c.users.add(s.visitor); c.sessions++; if (isEngaged(s)) c.engaged++; c.conv += s.conv;
    chMap.set(ch, c);
    const srcLbl = sourceNameV2(a);
    srcMap.set(srcLbl, (srcMap.get(srcLbl) || 0) + 1);
    // Fuente / medio de sesión (tabla source/medium de GA). Medium: el utm_medium si
    // vino; sin él, el click-id de ads manda (gclid sin UTM = auto-tagging de Google
    // Ads → cpc, como muestra GA; si no coincidiría con channelStats que ya lo marca
    // de pago); y si tampoco hay, (referral) con referrer u (ninguno) en directo.
    const smMed = mediumOfV2(a);
    const smKey = JSON.stringify([srcLbl, smMed]);
    const sm = smMap.get(smKey) || { source: srcLbl, medium: smMed, sessions: 0, conv: 0 };
    sm.sessions++; sm.conv += s.conv;
    smMap.set(smKey, sm);
    if (w7) mas(w7.sourceMedium, srcLbl + " / " + smMed);
    if (a.utm_campaign) {
      const cm = campMap.get(a.utm_campaign) || { source: a.utm_source, medium: a.utm_medium, sessions: 0, users: new Set<string>(), conv: 0 };
      cm.sessions++; cm.users.add(s.visitor); cm.conv += s.conv;
      campMap.set(a.utm_campaign, cm);
    }
    // Contenido concreto (utm_content = el post/anuncio que trajo la sesión).
    if (a.utm_content) {
      const ct = contMap.get(a.utm_content) || { source: a.utm_source, campaign: a.utm_campaign, sessions: 0, conv: 0 };
      ct.sessions++; ct.conv += s.conv;
      contMap.set(a.utm_content, ct);
    }
    // Recorridos: transiciones consecutivas página→página (solo si cambia de página).
    const seq = s.rows.filter((r) => !r.event);
    for (let i = 1; i < seq.length; i++) {
      const kf = pageKey(seq[i - 1]), kt = pageKey(seq[i]);
      if (kf === kt) continue;
      const k = JSON.stringify([kf, kt]);
      const cur = pathsMap.get(k) || { from: pageLabel(seq[i - 1]), to: pageLabel(seq[i]), value: 0 };
      cur.value++; pathsMap.set(k, cur);
      if (w7) mas(w7.paths, pageLabel(seq[i - 1]) + " \u2192 " + pageLabel(seq[i]));
    }
  }
  // WEB-COMPARAR-7 · aggregate() no conoce siteStats (se calcula despues, en pageViewStats):
  // devuelve el desglose de paginas y fuente/medio por web con la etiqueta vacia y las demas
  // dimensiones a cero, y pageViewStats() lo funde con el resto al montar desgloseBySite.
  const lista = (m: Map<string, number>) => [...m.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
  const desglosePaginas = [...porWeb.entries()].map(([id, w]) => ({
    id, label: "", channels: [], sources: [], campaigns: [], contents: [], devices: [], countries: [], languages: [], browsers: [], os: [],
    landing: lista(w.landing), exits: lista(w.exits), paths: lista(w.paths), sourceMedium: lista(w.sourceMedium),
  }));
  // Scroll y velocidad de carga (solo vistas CON dato: el beacon de salida no siempre llega).
  const scRows = pvRows.filter((r) => Number(r.scroll_pct) > 0);
  const scAvg = scRows.length ? Math.round(scRows.reduce((a, r) => a + Number(r.scroll_pct), 0) / scRows.length) : 0;
  const reach90 = scRows.length ? Math.round((scRows.filter((r) => Number(r.scroll_pct) >= 90).length / scRows.length) * 1000) / 10 : 0;
  // Distribución del scroll máximo: cuántas vistas se quedaron en cada tramo de la página.
  const scBuckets: [number, number][] = [[0, 24], [25, 49], [50, 74], [75, 89], [90, 100]];
  const scrollDist = scBuckets.map(([a, b]) => ({ bucket: `${a}-${b}%`, value: scRows.filter((r) => { const v = Number(r.scroll_pct); return v >= a && v <= b; }).length }));
  const ltRows = pvRows.filter((r) => Number(r.load_ms) > 0);
  const ltSorted = ltRows.map((r) => Number(r.load_ms)).sort((x, y) => x - y);
  const ltAvg = ltSorted.length ? Math.round(ltSorted.reduce((a, x) => a + x, 0) / ltSorted.length) : 0;
  const ltP75 = ltSorted.length ? ltSorted[Math.min(ltSorted.length - 1, Math.floor(ltSorted.length * 0.75))] : 0;
  const slowMap = new Map<string, { label: string; sum: number; n: number }>();
  for (const r of ltRows) { const k = pageKey(r); const o = slowMap.get(k) || { label: pageLabel(r), sum: 0, n: 0 }; o.sum += Number(r.load_ms); o.n++; slowMap.set(k, o); }
  const slow = [...slowMap.values()].map((o) => ({ label: o.label, value: Math.round(o.sum / o.n) }))
    .sort((a, b) => b.value - a.value).slice(0, 8);
  // Patrón por hora del día (0-23) en la hora LOCAL del visitante si el píxel mandó su
  // zona horaria (tz = getTimezoneOffset, min detrás de UTC); si no, hora del servidor.
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, views: 0 }));
  // Heatmap semanal día×hora (0=lunes) en hora LOCAL del visitante cuando el píxel la manda.
  const heat: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const r of pvRows) {
    const tz = r.tz_min;
    const localDate = (tz !== null && tz !== undefined && Number.isFinite(Number(tz)))
      ? new Date(Number(r.ts) - Number(tz) * 60000) : null;
    const h = localDate ? localDate.getUTCHours() : Number(r.hour);
    const wd = localDate ? localDate.getUTCDay() : new Date(Number(r.ts)).getUTCDay();
    if (h >= 0 && h < 24) { hourly[h].views++; heat[(wd + 6) % 7][h]++; }
  }
  return {
    users: core.users,
    sessions: core.sessions,
    views: core.views,
    avgEngagementMs: core.avgEngagementMs,
    avgSessionMs: core.avgSessionMs,
    engagementRate: core.engagementRate,
    bounceRate: core.bounceRate,
    pagesPerSession: core.pagesPerSession,
    conv: core.conv,
    prev,
    newPct: core.users ? Math.round((newUsers.size / core.users) * 1000) / 10 : 0,
    // Canales y fuentes POR SESIÓN con atribución GA4 (antes: por vista y solo referrer).
    channels: [...chMap.entries()].map(([label, c]) => ({ label, value: c.sessions })).sort((a, b) => b.value - a.value),
    sources: [...srcMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    channelStats: [...chMap.entries()].map(([label, c]) => ({
      label, users: c.users.size, sessions: c.sessions, prevSessions: 0,
      engagementRate: c.sessions ? Math.round((c.engaged / c.sessions) * 1000) / 10 : 0,
      conv: c.conv,
    })).sort((a, b) => b.sessions - a.sessions),
    // Explorador de sesiones: las últimas 50, con su atribución y contexto — los datos
    // de verdad, fila a fila, para analizar sin agregaciones de por medio.
    recentSessions: [...sess].sort((a, b) => b.start - a.start).slice(0, 50).map((s) => {
      const a = sessAttr(s);
      const f = s.first || s.rows[0] || {};
      return {
        ts: s.start,
        site: String(f.page_label || f.page_id || ""),
        siteId: String(f.page_id || ""),
        landing: String(f.path || f.page_label || "—"),
        source: sourceNameV2(a),
        channel: channelOfV2(a),
        device: String(f.device || "desktop"),
        country: String(f.country || ""),
        views: s.views,
        durMs: s.dur,
        conv: s.conv,
      };
    }),
    campaigns: [...campMap.entries()].map(([label, c]) => ({
      label, source: c.source, medium: c.medium, sessions: c.sessions, users: c.users.size, conv: c.conv,
    })).sort((a, b) => b.sessions - a.sessions).slice(0, 30),
    sourceMedium: [...smMap.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 30),
    newVsReturning: { newUsers: newUsers.size, returning: Math.max(0, core.users - newUsers.size) },
    contents: [...contMap.entries()].map(([label, c]) => ({ label, source: c.source, campaign: c.campaign, sessions: c.sessions, conv: c.conv }))
      .sort((a, b) => b.sessions - a.sessions).slice(0, 30),
    scrollDist,
    heat,
    // Los rellena pageViewStats (se calculan pre-filtro / sobre el periodo anterior).
    prevSeries: [],
    filterOptions: { channels: [], sources: [], campaigns: [], devices: [], countries: [], paths: [] },
    scroll: { avg: scAvg, reach90, sampled: scRows.length },
    speed: { avg: ltAvg, p75: ltP75, sampled: ltSorted.length, slow },
    paths: [...pathsMap.values()].sort((a, b) => b.value - a.value).slice(0, 15),
    devices: topMap(pvRows, (r) => r.device || "desktop"),
    browsers: topMap(pvRows, (r) => r.browser || "Otro"),
    os: topMap(pvRows, (r) => r.os || "Otro"),
    languages: topMap(pvRows, (r) => (r.lang || "").split("-")[0] || "—"),
    countries: topMap(pvRows, (r) => r.country || ""),
    conversions: {
      total: convRows.length,
      rate: core.sessions ? Math.round((convRows.length / core.sessions) * 1000) / 10 : 0,
      byEvent: topMap(convRows, (r) => r.event || "—"),
      byPage: (() => {
        const m = new Map<string, number>();
        for (const r of convRows) { const k = r.path || r.page_label || r.page_id || "—"; m.set(k, (m.get(k) || 0) + 1); }
        return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 20);
      })(),
    },
    sites,
    pages: [...pageMap.entries()].map(([id, p]) => ({
      id, label: p.label, site: p.site, siteId: p.sid, views: p.views, visitors: p.vis.size,
      avgMs: p.durN ? Math.round(p.dur / p.durN) : 0,
      scrollAvg: p.scN ? Math.round(p.sc / p.scN) : 0,
      loadMs: p.ltN ? Math.round(p.lt / p.ltN) : 0,
      conv: p.conv,
    })).sort((a, b) => b.views - a.views).slice(0, 50),
    // COUNCIL-FIX: el label sale del VALOR del map (la clave es la compuesta sitio+ruta
    // con separador NUL — antes se pintaba esa clave interna en la UI).
    landing: [...landingMap.values()].map((l) => ({ label: l.label, site: l.site, value: l.value })).sort((a, b) => b.value - a.value).slice(0, 15),
    exits: [...exitMap.values()].map((l) => ({ label: l.label, site: l.site, value: l.value })).sort((a, b) => b.value - a.value).slice(0, 15),
    siteStats: [],
    prevSiteStats: [],
    seriesBySite: [],
    desgloseBySite: desglosePaginas,
    series: (() => {
      const m = new Map<string, { v: number; u: Set<string>; c: number }>();
      const day = (r: any) => { const o = m.get(r.day) || { v: 0, u: new Set<string>(), c: 0 }; m.set(r.day, o); return o; };
      for (const r of pvRows) { const o = day(r); o.v++; o.u.add(r.visitor); }
      for (const r of convRows) day(r).c++;
      return [...m.entries()].map(([date, o]) => ({ date, views: o.v, users: o.u.size, sessions: sessByDay.get(date) || 0, conv: o.c })).sort((a, b) => a.date.localeCompare(b.date));
    })(),
    hourly,
    configured: true,
  };
}

/** GA-style «en vivo»: actividad de los últimos `mins` minutos (excluye previews de
 *  admin). Devuelve además fuentes, dispositivos, países y conversiones del tramo,
 *  como la vista Realtime de GA4. Barato y sin cache — la UI lo sondea cada ~15s. */
export async function realtimeStats(tenant = "default", mins = 30, siteId = "", ambito?: FiltroAmbitoWeb | null): Promise<{
  minutes: number; users: number; views: number; conv: number;
  perMinute: { min: number; views: number }[];
  pages: { label: string; views: number }[];
  sources: { label: string; value: number }[];
  devices: { label: string; value: number }[];
  countries: { label: string; value: number }[];
}> {
  const m = Math.max(1, Math.min(60, Math.floor(mins)));
  const sinceMs = Date.now() - m * 60000;
  const site = String(siteId || "").trim();
  type RtRow = { visitor: string; path: string; page_label: string; page_id: string; ts: number; ref: string; utm_source: string; click_id: string; device: string; country: string; event: string; user_agent?: string };
  let rows: RtRow[] = [];
  if (!pool) {
    rows = mem.filter((x) => x.tenant_id === tenant && x.created_at >= sinceMs && !(x.path || "").startsWith("/admin/") && (!site || x.page_id === site))
      .map((x) => ({ visitor: x.visitor, path: x.path, page_label: x.page_label, page_id: x.page_id, ts: x.created_at, ref: x.ref, utm_source: x.utm_source, click_id: x.click_id, device: x.device, country: x.country, event: x.event, user_agent: x.user_agent }));
  } else {
    const res = await pool.query(
      `SELECT visitor, path, page_label, page_id, extract(epoch from created_at)*1000 ts,
              ref, utm_source, click_id, device, country, event, user_agent
         FROM app_page_views
        WHERE tenant_id=$1 AND created_at >= to_timestamp($2) AND path NOT LIKE '/admin/%'
          AND ($3 = '' OR page_id = $3)`,
      [tenant, sinceMs / 1000, site],
    );
    rows = res.rows as RtRow[];
  }
  // NEGOCIO-EMBUDO-1 · «en vivo» del negocio / embudo elegido, con la misma regla de sesión.
  if (ambito) rows = filtrarAmbito(rows, ambito);
  // METRICAS-1 · los bots no son «gente en vivo» (el resto de la analítica ya los excluye).
  rows = rows.filter((r) => !isBotUa(String(r.user_agent || "")));
  const pv = rows.filter((r) => !r.event);
  const conv = rows.length - pv.length;
  const users = new Set(pv.map((r) => r.visitor)).size;
  const buckets = new Array(m).fill(0);
  for (const r of pv) {
    const idx = Math.min(m - 1, Math.max(0, Math.floor((Number(r.ts) - sinceMs) / 60000)));
    buckets[idx]++;
  }
  const perMinute = buckets.map((v, i) => ({ min: i - m, views: v as number }));
  const top = (keyFn: (r: RtRow) => string, n = 6) => {
    const mp = new Map<string, number>();
    for (const r of pv) { const k = keyFn(r) || "—"; mp.set(k, (mp.get(k) || 0) + 1); }
    return [...mp.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, n);
  };
  const pages = top((r) => r.page_label || r.path || r.page_id || "—", 8).map((x) => ({ label: x.label, views: x.value }));
  return {
    minutes: m, users, views: pv.length, conv, perMinute, pages,
    sources: top((r) => sourceNameV2(r)),
    devices: top((r) => r.device || "desktop", 3),
    countries: top((r) => r.country || ""),
  };
}

/** Seguimiento por web sin truncar antes sus rutas: también cuenta las de poco tráfico. */
export async function visitasPorWeb(tenant: string, dias = 30): Promise<{ web: string; vistas: number }[]> {
  const desde = Date.now() - Math.max(1, Math.min(365, Math.floor(dias))) * 86400000;
  if (!pool) {
    const totales = new Map<string, number>();
    for (const x of mem) {
      if (x.tenant_id !== tenant || x.created_at < desde || x.event || !x.page_id || (x.path || "").startsWith("/admin/")) continue;
      totales.set(x.page_id, (totales.get(x.page_id) || 0) + 1);
    }
    return [...totales].map(([web, vistas]) => ({ web, vistas }));
  }
  // Agregar antes de limitar: un ranking de rutas perdería las webs con poco tráfico.
  const r = await pool.query(
    `SELECT page_id AS web, count(*)::int AS vistas FROM app_page_views
      WHERE tenant_id=$1 AND created_at >= to_timestamp($2) AND COALESCE(event,'')=''
        AND COALESCE(page_id,'')<>'' AND path NOT LIKE '/admin/%'
      GROUP BY page_id`, [tenant, desde / 1000],
  );
  return r.rows.map((x: any) => ({ web: String(x.web), vistas: Number(x.vistas) || 0 }));
}

/** Páginas de cada web para elegir en el editor de embudos, ordenadas por visitas. */
export async function paginasPorWeb(tenant: string, dias = 90, limite = 500): Promise<{ web: string; ruta: string; vistas: number }[]> {
  const desde = Date.now() - Math.max(1, Math.min(365, Math.floor(dias))) * 86400000;
  const tope = Math.max(1, Math.min(2000, Math.floor(limite)));
  let crudas: { web: string; ruta: string; vistas: number }[] = [];
  if (!pool) {
    const m = new Map<string, { web: string; ruta: string; vistas: number }>();
    for (const x of mem) {
      if (x.tenant_id !== tenant || x.created_at < desde || x.event || !x.page_id || (x.path || "").startsWith("/admin/")) continue;
      const k = `${x.page_id}\u0000${x.path}`;
      const o = m.get(k) || { web: x.page_id, ruta: x.path || "/", vistas: 0 };
      o.vistas++;
      m.set(k, o);
    }
    crudas = [...m.values()];
  } else {
    const res = await pool.query(
      `SELECT page_id AS web, path AS ruta, count(*)::int AS vistas
         FROM app_page_views
        WHERE tenant_id=$1 AND created_at >= to_timestamp($2) AND COALESCE(event,'') = ''
          AND COALESCE(page_id,'') <> '' AND path NOT LIKE '/admin/%'
        GROUP BY page_id, path
        ORDER BY vistas DESC
        LIMIT 5000`,
      [tenant, desde / 1000],
    );
    crudas = res.rows.map((r: any) => ({ web: String(r.web), ruta: String(r.ruta || "/"), vistas: Number(r.vistas) || 0 }));
  }
  // La misma página con «/» final, mayúsculas o consulta es UNA página para el embudo.
  const porClave = new Map<string, { web: string; ruta: string; vistas: number }>();
  for (const c of crudas) {
    const ruta = normalizarRuta(c.ruta);
    const k = `${c.web}|${ruta}`;
    const o = porClave.get(k) || { web: c.web, ruta, vistas: 0 };
    o.vistas += c.vistas;
    porClave.set(k, o);
  }
  return [...porClave.values()].sort((a, b) => b.vistas - a.vistas).slice(0, tope);
}

// ===== Registro slug→workspace del píxel EXTERNO =====
// COUNCIL-FIX (fuga cross-tenant): el píxel copiable manda p=<slug del nombre>, que no
// existe en app_page_drafts, así que /pv caía a tenant 'default': un workspace no-default
// nunca veía sus visitas y sus datos quedaban en el workspace default. Al generar el
// snippet desde el panel se registra aquí el slug con su workspace; /pv lo consulta como
// fallback tras el lookup de drafts. El tenant NUNCA viaja en la URL del píxel (es
// público y sería falsificable) — solo se resuelve server-side.
const memPixelSites = new Map<string, { tenant: string; label: string }>();
export async function registerPixelSite(slug: string, tenant: string, label = ""): Promise<void> {
  const s = String(slug || "").slice(0, 200);
  const t = String(tenant || "default");
  const l = String(label || "").slice(0, 120);
  if (!s) return;
  if (!pool) { if (!memPixelSites.has(s)) memPixelSites.set(s, { tenant: t, label: l }); return; }
  // El label se actualiza si el slug ya era nuestro y estaba sin nombre (registros
  // anteriores a la columna label); la PROPIEDAD (tenant) nunca cambia.
  await pool.query(
    `INSERT INTO app_pixel_sites (slug, tenant_id, label) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET label = CASE WHEN app_pixel_sites.tenant_id = EXCLUDED.tenant_id AND app_pixel_sites.label = '' THEN EXCLUDED.label ELSE app_pixel_sites.label END`,
    [s, t, l],
  );
}
export async function pixelSiteTenant(slug: string): Promise<string | null> {
  const s = String(slug || "").slice(0, 200);
  if (!s) return null;
  if (!pool) return memPixelSites.get(s)?.tenant || null;
  const res = await pool.query(`SELECT tenant_id FROM app_pixel_sites WHERE slug=$1`, [s]);
  return res.rows[0]?.tenant_id || null;
}
/** Píxeles registrados por un workspace (slug + nombre legible) para el catálogo de segWeb. */
export async function listPixelSites(tenant: string): Promise<{ slug: string; label: string }[]> {
  const t = String(tenant || "default");
  if (!pool) return [...memPixelSites.entries()].filter(([, v]) => v.tenant === t).map(([slug, v]) => ({ slug, label: v.label }));
  const res = await pool.query(`SELECT slug, label FROM app_pixel_sites WHERE tenant_id=$1 ORDER BY created_at`, [t]);
  return res.rows;
}

// ===== EMBUDO-PAGINAS-1 · qué páginas de SUS webs ve cada contacto =====
// El enlace de un flujo pasa por /r/<token>?p=<contacto>. Si su destino es una web con el píxel
// de ESTE negocio, /r/ le añade utm_content=lmc_<marca> (utm_term si utm_content ya venía). El
// snippet v2 ya instalado guarda los utm_* de la primera página en sessionStorage y los reenvía
// en cada página siguiente de la misma pestaña (landing → checkout → gracias), así que /pv puede
// atribuir cada visita al contacto sin tocar la web. La marca es opaca y aleatoria (el teléfono
// nunca viaja en la URL) y solo vale para el negocio que la emitió.
const VISITA_PREFIJO = "lmc_";
const memVisitRefs = new Map<string, { tenant: string; phone: string }>(); // marca → dueño
const visitRefCache = new Map<string, string>(); // tenant|dígitos → marca
const digitos = (s: string) => String(s || "").replace(/[^\d]/g, "");
/** VISITA-CANAL-1 · clave con la que una visita se ata a un contacto. Los de WhatsApp/IG/FB son su teléfono o id
 *  (solo dígitos); los de YouTube y LinkedIn son «yt:<canal>» / «li:<persona>», que NO se pueden reducir a dígitos. */
export const claveContacto = (s: string) => (/^(yt|li):/i.test(String(s || "")) ? String(s).trim().slice(0, 60) : digitos(s).slice(0, 40));
/** Host sin «www.» ni puerto, en minúsculas. */
export function hostDe(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}
/** ¿La dirección es de una web con el píxel de este negocio? Se reconoce por el nombre con el que
 *  se generó el píxel (el dominio) o por su forma normalizada (slug, con o sin el sufijo que se
 *  le añade cuando otro negocio ya usaba ese nombre). */
export async function esWebConPixel(tenant: string, url: string): Promise<boolean> {
  return (await pixelsDeWeb(tenant, url)).length > 0;
}
// OFERTA-YT-1 (MET-YT-05) · Las visitas a una web con píxel que llegaron con la marca de UN vídeo
// (utm_source=youtube y utm_content=<id del vídeo>: la lleva el enlace con seguimiento que se crea en
// su ficha). Sólo vistas de página (event=''): una conversión de la misma visita no es otra visita.
// Filas, no un total: el panel cuenta personas (visitor) y abre la lista que lo justifica.
export async function visitasYtDeVideo(tenant: string, videoId: string, sinceMs: number, untilMs: number): Promise<{ at: number; visitor: string; path: string; label: string; device: string }[]> {
  if (!videoId) return [];
  if (!pool) {
    return mem
      .filter((r) => r.tenant_id === tenant && r.event === "" && r.utm_source === "youtube" && r.utm_content === videoId && r.created_at >= sinceMs && r.created_at < untilMs)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 5000)
      .map((r) => ({ at: r.created_at, visitor: r.visitor, path: r.path, label: r.page_label, device: r.device }));
  }
  const q = await pool.query(
    `SELECT created_at, visitor, path, page_label, device FROM app_page_views
      WHERE tenant_id=$1 AND event='' AND utm_source='youtube' AND utm_content=$2
        AND created_at >= to_timestamp($3::double precision/1000) AND created_at < to_timestamp($4::double precision/1000)
      ORDER BY created_at DESC LIMIT 5000`,
    [tenant, videoId, sinceMs, untilMs],
  );
  return q.rows.map((r: any) => ({ at: new Date(r.created_at).getTime(), visitor: String(r.visitor || ""), path: String(r.path || ""), label: String(r.page_label || ""), device: String(r.device || "") }));
}
/** Marca anónima y estable de un contacto dentro de un negocio (se crea la primera vez). */
export async function visitRefFor(tenant: string, phone: string): Promise<string> {
  const t = String(tenant || "default");
  const ph = claveContacto(phone);
  if (!ph) return "";
  const k = t + "|" + ph;
  const hit = visitRefCache.get(k);
  if (hit) return hit;
  // Los de YouTube/LinkedIn van en un comentario público: código corto (8 caracteres tras «lmc_»).
  const nuevo = VISITA_PREFIJO + crypto.randomBytes(/^(yt|li):/i.test(ph) ? 6 : 9).toString("base64url");
  let token = nuevo;
  if (!pool) {
    for (const [tk, v] of memVisitRefs) if (v.tenant === t && v.phone === ph) { token = tk; break; }
    if (token === nuevo) {
      if (memVisitRefs.size >= 50_000) memVisitRefs.delete(memVisitRefs.keys().next().value as string);
      memVisitRefs.set(nuevo, { tenant: t, phone: ph });
    }
  } else {
    await pool.query(`INSERT INTO app_visit_refs (token, tenant_id, phone) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, phone) DO NOTHING`, [nuevo, t, ph]);
    const r = await pool.query(`SELECT token FROM app_visit_refs WHERE tenant_id=$1 AND phone=$2`, [t, ph]);
    token = r.rows[0]?.token || "";
  }
  if (token) {
    // Tope: la caché es un atajo, no la fuente (la fuente es app_visit_refs).
    if (visitRefCache.size >= 50_000) visitRefCache.clear();
    visitRefCache.set(k, token);
  }
  return token;
}
/** Dueño de una marca, SOLO si es de este negocio. Nunca lanza. */
export async function resolveVisitRef(token: string, tenant: string): Promise<string> {
  const tk = String(token || "").trim();
  if (!tk.startsWith(VISITA_PREFIJO) || tk.length > 40) return "";
  try {
    if (!pool) { const v = memVisitRefs.get(tk); return v && v.tenant === tenant ? v.phone : ""; }
    const r = await pool.query(`SELECT phone FROM app_visit_refs WHERE token=$1 AND tenant_id=$2`, [tk, tenant]);
    return r.rows[0]?.phone || "";
  } catch { return ""; }
}
export const esMarcaVisita = (v: string) => String(v || "").startsWith(VISITA_PREFIJO);
/** Lo que se busca en la ruta de la página: si el dueño pegó la dirección entera, su ruta
 *  («/ahorrador-gracias»); si escribió un trozo, el trozo. */
export function trozoDeRuta(valor: string): string {
  let v = String(valor || "").trim();
  if (!v) return "";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(v)) v = "https://" + v;
  if (/^https?:\/\//i.test(v)) {
    try { const p = new URL(v).pathname.replace(/\/+$/, ""); return (p || "/").toLowerCase(); } catch { /* trozo tal cual */ }
  }
  return v.toLowerCase();
}
/** ¿Este contacto ha visto una página cuya ruta contiene `valor`? (`sinceMs`: solo visitas
 *  posteriores). Mismo truco de relojes que phoneOpenedFlowLink: se compara una antigüedad. */
export async function contactVisitedPage(tenant: string, phone: string, valor: string, sinceMs = 0): Promise<boolean> {
  const ph = claveContacto(phone);
  const trozo = trozoDeRuta(valor);
  if (!ph || !trozo) return false;
  const desde = Math.max(0, Math.floor(Number(sinceMs) || 0));
  const casa = (path: string) => trozo === "/" ? (path === "/" || path === "") : String(path || "").toLowerCase().includes(trozo);
  if (!pool) return mem.some((m) => m.tenant_id === tenant && m.contact === ph && (!desde || m.created_at >= desde) && casa(m.path));
  const antiguedadMs = desde ? Math.max(1, Date.now() - desde) : 0;
  try {
    const r = await pool.query(
      `SELECT 1 FROM app_page_views WHERE tenant_id=$1 AND contact=$2
         AND (CASE WHEN $3::text = '/' THEN path IN ('/','') ELSE strpos(lower(path), $3::text) > 0 END)
         AND ($4::double precision = 0 OR created_at >= now() - ($4::double precision * interval '1 millisecond'))
       LIMIT 1`,
      [tenant, ph, trozo, antiguedadMs],
    );
    return (r.rowCount || 0) > 0;
  } catch (e) {
    console.warn("[web] contactVisitedPage:", (e as Error).message);
    return false;
  }
}
/** OBJETIVO-FLUJO-1 · de estos contactos (dígitos → desde cuándo cuenta), quién vio una página
 *  cuya ruta contiene alguno de los `valores`, y cuándo la vio por primera vez desde esa fecha.
 *  Una sola consulta para todo el flujo (la versión de uno en uno es contactVisitedPage). */
export async function contactosQueVieronPagina(tenant: string, desde: Map<string, number>, valores: string[]): Promise<Map<string, { at: number; path: string }>> {
  const out = new Map<string, { at: number; path: string }>();
  const trozos = [...new Set(valores.map(trozoDeRuta).filter(Boolean))];
  const phones = [...desde.keys()].map(claveContacto).filter(Boolean);
  if (!trozos.length || !phones.length) return out;
  const casa = (path: string) => trozos.some((t) => t === "/" ? (path === "/" || path === "") : String(path || "").toLowerCase().includes(t));
  const anota = (ph: string, at: number, path: string) => {
    if (at < (desde.get(ph) || 0) || !casa(path)) return;
    const prev = out.get(ph);
    if (!prev || at < prev.at) out.set(ph, { at, path });
  };
  if (!pool) {
    const set = new Set(phones);
    for (const m of mem) if (m.tenant_id === tenant && set.has(m.contact || "")) anota(m.contact || "", m.created_at, m.path || "");
    return out;
  }
  try {
    const r = await pool.query(
      `SELECT contact, path, (EXTRACT(EPOCH FROM created_at)*1000)::bigint AS at FROM app_page_views
        WHERE tenant_id=$1 AND contact = ANY($2::text[]) AND contact <> ''`,
      [tenant, phones],
    );
    for (const x of r.rows as { contact: string; path: string; at: string }[]) anota(x.contact, Number(x.at), x.path);
  } catch (e) { console.warn("[web] contactosQueVieronPagina:", (e as Error).message); }
  return out;
}
/**
 * FORMULARIO-A-LEAD-1 · ¿qué contacto rellenó un formulario de su web? Caso real
 * (25-sep-2026, flujo AHORRADOR): los emails del checkout de systeme.io no aparecían en
 * ninguna ficha y el dueño no sabía qué usuario de Instagram era cada comprador. El
 * formulario no lleva nuestra marca y el píxel pegado en la web no se toca, así que el
 * cruce se hace aquí con lo que el píxel ya manda: quién estaba EN ESA PÁGINA cuando
 * systeme.io registró el alta.
 *  - Candidatos: visitas a esa ruta en los 10 min anteriores al alta.
 *  - Si alguna seguía a la vista en ese segundo (entrada + duración), solo cuentan esas:
 *    el formulario se envía con la página abierta.
 *  - FORMULARIO-A-LEAD-2 · todos los visitantes que quedan tienen que ser el MISMO contacto:
 *    cada uno llegó desde un enlace del flujo (alguna de sus visitas lleva contacto) y es
 *    uno solo, el mismo para todos. Antes se exigía un único visitante, pero el visitante
 *    es IP+navegador y la IP cambia a mitad de compra: caso real (28-sep-2026), un lead de
 *    Instagram abrió el checkout con dos IPs de dos operadores en 26 s, quedó como dos
 *    visitantes y su compra se quedó sin ficha. Si alguno es anónimo o de otro contacto,
 *    no se enlaza.
 * Ante la duda devuelve "": vale más un email sin ficha que un email en la ficha de otro.
 */
export async function contactoDeUnAlta(tenant: string, ruta: string, altaMs: number): Promise<string> {
  const contactosDe = async (visitor: string): Promise<string[]> => {
    if (!pool) return [...new Set(mem.filter((m) => m.tenant_id === tenant && m.visitor === visitor && m.contact).map((m) => m.contact || ""))];
    const r = await pool.query(`SELECT DISTINCT contact FROM app_page_views WHERE tenant_id=$1 AND visitor=$2 AND contact <> ''`, [tenant, visitor]);
    return (r.rows as { contact: string }[]).map((x) => x.contact);
  };
  const cand = await visitantesDeUnAlta(tenant, ruta, altaMs, []);
  let unico = "";
  for (const visitor of cand) {
    const cs = await contactosDe(visitor);
    if (cs.length !== 1 || (unico && cs[0] !== unico)) return "";
    unico = cs[0];
  }
  return unico;
}
/**
 * FORMULARIO-A-LEAD-1 (y ORIGEN-VISITA-1) · los visitantes que pudieron enviar el formulario de
 * `ruta` en `altaMs`: quien vio esa página en los 10 min anteriores y, si alguno seguía con ella
 * abierta en ese segundo, solo esos. `webs` (slugs de píxel) acota a la web del alta; vacío = todas
 * las del workspace (lo que hace contactoDeUnAlta, que no cambia).
 */
async function visitantesDeUnAlta(tenant: string, ruta: string, altaMs: number, webs: string[]): Promise<Set<string>> {
  const r0 = String(ruta || "").replace(/\/+$/, "") || "/";
  const desde = altaMs - 10 * 60_000, hasta = altaMs + 2000;
  let vistas: { visitor: string; a: number; d: number }[] = [];
  if (!pool) {
    vistas = mem.filter((m) => m.tenant_id === tenant && m.visitor && ((m.path || "").replace(/\/+$/, "") || "/") === r0 && m.created_at >= desde && m.created_at <= hasta
      && (!webs.length || webs.includes(m.page_id)))
      .map((m) => ({ visitor: m.visitor, a: m.created_at, d: m.duration_ms || 0 }));
  } else {
    const r = await pool.query(
      `SELECT visitor, (EXTRACT(EPOCH FROM created_at)*1000)::bigint AS a, COALESCE(duration_ms,0)::bigint AS d FROM app_page_views
        WHERE tenant_id=$1 AND (path=$2 OR path=$2||'/') AND visitor <> ''
          AND created_at BETWEEN to_timestamp($3/1000.0) AND to_timestamp($4/1000.0)` + (webs.length ? ` AND page_id = ANY($5::text[])` : ``),
      webs.length ? [tenant, r0, desde, hasta, webs] : [tenant, r0, desde, hasta],
    );
    vistas = (r.rows as { visitor: string; a: string; d: string }[]).map((x) => ({ visitor: x.visitor, a: Number(x.a), d: Number(x.d) }));
  }
  const abiertas = new Set(vistas.filter((v) => v.a + v.d >= altaMs - 5000).map((v) => v.visitor));
  return abiertas.size ? abiertas : new Set(vistas.map((v) => v.visitor));
}
/** ORIGEN-VISITA-1 · las fuentes que el Dashboard sabe nombrar como primera fuente (DASH_FUENTES de
 *  admin.ts sin «web» ni «desconocido»: venir de otra web o de ninguna no es un origen). */
const ORIGENES_VISITA = new Set(["instagram", "facebook", "linkedin", "youtube", "tiktok", "google", "x", "email", "whatsapp"]);
const CLICK_ID_ORIGEN: Record<string, string> = { fbclid: "facebook", gclid: "google", msclkid: "", ttclid: "tiktok", li_fat_id: "linkedin", twclid: "x" };
/**
 * ORIGEN-VISITA-1 · de qué plataforma llegó UNA visita, con las reglas que ya clasifican el
 * tráfico: el utm_source manda (platformOf, el criterio de Métricas → Origen); sin él, el click id
 * de anuncio que el píxel guarda (fbclid → Facebook, como en Métricas → Origen; gclid → Google…);
 * y sin él, el referrer por sourceName (l.instagram.com → Instagram, google.* buscador → Google; el
 * correo o los documentos de Google no son una búsqueda). "" = no lo sabemos (directa, otra web).
 */
export function plataformaDeVisita(v: { ref?: string | null; utm_source?: string | null; click_id?: string | null }): string {
  const ok = (p: string) => (ORIGENES_VISITA.has(p) ? p : "");
  const us = String(v.utm_source || "").trim();
  if (us) return ok(platformOf(us, ""));
  const cid = CLICK_ID_ORIGEN[String(v.click_id || "").toLowerCase()];
  if (cid) return cid;
  const ref = String(v.ref || "");
  if (!ref) return "";
  const n = sourceName(ref);
  if (n === "Buscadores") return /(^|\.)google\./.test(hostDe(ref)) ? "google" : "";
  // Solo las redes que sourceName reconoce; un host suelto (mail.google.com, otra web) no es origen.
  return ["Instagram", "Facebook", "X / Twitter", "TikTok", "LinkedIn", "WhatsApp", "YouTube"].includes(n) ? ok(platformOf("", n)) : "";
}
/** ORIGEN-VISITA-1 · slugs de píxel de la web de `url` en este workspace (la regla con la que se reconoce una web con píxel). */
export async function pixelsDeWeb(tenant: string, url: string): Promise<string[]> {
  const host = hostDe(url);
  if (!host) return [];
  const slugHost = host.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const sitios = await listPixelSites(tenant).catch(() => [] as { slug: string; label: string }[]);
  return sitios.filter((s) => {
    const lbl = String(s.label || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    return lbl === host || s.slug === slugHost || new RegExp("^" + slugHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-[0-9a-f]{4}$").test(s.slug);
  }).map((s) => s.slug);
}
/**
 * ORIGEN-VISITA-1 · ¿de dónde llegó quien se registró en `url` en `altaMs`, si no tiene ficha ni
 * enlace etiquetado? Caso real (4-oct-2026): 20 de los contactos nuevos de 30 días eran altas de
 * systeme.io sin ficha en «No sabemos de dónde llegó», con el referrer y el click id de su visita ya
 * guardados por el píxel sin cruzar con el alta. Mismos candidatos que FORMULARIO-A-LEAD-1
 * (visitantesDeUnAlta), acotados a la web del alta. Cada candidato aporta las fuentes de sus
 * visitas a las webs del negocio en las 2 h anteriores (la página del formulario suele no tener
 * referrer: se llegó desde la portada). Solo se atribuye si TODOS los candidatos dicen la MISMA
 * fuente y cada uno una sola: un candidato sin fuente (la IP del equipo que lo visita todo, una
 * visita directa) o con otra hace ambigua el alta. La IP cambia en móvil: lo que no se cruce se
 * queda sin origen, que es lo honrado.
 */
export async function origenDeVisitaDeUnAlta(tenant: string, url: string, altaMs: number): Promise<string> {
  let ruta = "";
  try { ruta = new URL(url).pathname; } catch { return ""; }
  const cand = await visitantesDeUnAlta(tenant, ruta, altaMs, await pixelsDeWeb(tenant, url));
  if (!cand.size) return "";
  const desde = altaMs - 2 * 3_600_000, hasta = altaMs + 2000;
  let unico = "";
  for (const visitor of cand) {
    let filas: { ref: string; utm_source: string; click_id: string }[];
    if (!pool) filas = mem.filter((m) => m.tenant_id === tenant && m.visitor === visitor && m.created_at >= desde && m.created_at <= hasta);
    else {
      const r = await pool.query(
        `SELECT DISTINCT ref, utm_source, click_id FROM app_page_views
          WHERE tenant_id=$1 AND visitor=$2 AND created_at BETWEEN to_timestamp($3/1000.0) AND to_timestamp($4/1000.0)`,
        [tenant, visitor, desde, hasta],
      );
      filas = r.rows;
    }
    const fuentes = new Set(filas.map(plataformaDeVisita).filter(Boolean));
    if (fuentes.size !== 1) return "";
    const f = [...fuentes][0];
    if (unico && f !== unico) return "";
    unico = f;
  }
  return unico;
}
/** Recorrido de un contacto por las webs del negocio (más reciente primero). */
export async function paginasDeContacto(tenant: string, phone: string, limite = 30): Promise<{ path: string; web: string; at: number; event: string }[]> {
  const ph = claveContacto(phone);
  if (!ph) return [];
  const n = Math.max(1, Math.min(200, Math.floor(limite) || 30));
  if (!pool) {
    return mem.filter((m) => m.tenant_id === tenant && m.contact === ph)
      .sort((a, b) => b.created_at - a.created_at).slice(0, n)
      .map((m) => ({ path: m.path, web: m.page_label || m.page_id, at: m.created_at, event: m.event }));
  }
  const r = await pool.query(
    `SELECT path, COALESCE(NULLIF(page_label,''), page_id) AS web, event, (EXTRACT(EPOCH FROM created_at)*1000)::bigint AS at
       FROM app_page_views WHERE tenant_id=$1 AND contact=$2 ORDER BY created_at DESC LIMIT $3`,
    [tenant, ph, n],
  );
  return r.rows.map((x: { path: string; web: string; event: string; at: string }) => ({ path: x.path, web: x.web, event: x.event, at: Number(x.at) }));
}

// ===== FUNNELS-1 · visitas a las páginas de los funnels =====
// Un «destino» es una página (ruta YA normalizada) de una web con seguimiento (sus slugs) y el
// grupo al que suma: un paso de un funnel, o un funnel entero. La ruta que guarda el seguimiento
// llega cruda (mayúsculas, «/» final, consulta) y se compara con la MISMA regla que los embudos
// (normalizarRuta), no con una imitación en SQL. Por eso son dos consultas: 1) las rutas distintas
// de esas webs en el rango; 2) el recuento, ya agrupado, contra la lista de las que casan.
// Sólo vistas de página (event vacío): una conversión de la misma visita no es otra visita.
export interface DestinoDeRuta { slugs: string[]; ruta: string; grupo: string }

const fmtDiaMadrid = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });
/** Día (YYYY-MM-DD) de un instante en hora de Madrid. */
export const diaDeMadrid = (ms: number): string => fmtDiaMadrid.format(new Date(ms));

function gruposDeDestinos(destinos: DestinoDeRuta[]): { slugs: string[]; porRuta: Map<string, Set<string>> } {
  const porRuta = new Map<string, Set<string>>();
  const slugs = new Set<string>();
  for (const d of destinos) {
    if (!d.grupo || !d.ruta) continue;
    for (const s of d.slugs) {
      if (!s) continue;
      slugs.add(s);
      const k = s + "\u0000" + d.ruta;
      let g = porRuta.get(k);
      if (!g) porRuta.set(k, (g = new Set<string>()));
      g.add(d.grupo);
    }
  }
  return { slugs: [...slugs], porRuta };
}
/** Modo memoria: cada vista del rango con el grupo al que suma (una fila por grupo). */
function vistasMemDeDestinos(tenant: string, destinos: DestinoDeRuta[], sinceMs: number, untilMs: number): { grupo: string; m: MemView }[] {
  const { porRuta } = gruposDeDestinos(destinos);
  const out: { grupo: string; m: MemView }[] = [];
  for (const m of mem) {
    if (m.tenant_id !== tenant || m.created_at < sinceMs || m.created_at > untilMs || m.event || (m.path || "").startsWith("/admin/")) continue;
    const g = porRuta.get(m.page_id + "\u0000" + normalizarRuta(m.path));
    if (g) for (const grupo of g) out.push({ grupo, m });
  }
  return out;
}
/** Postgres: recuento agrupado por grupo (y por `agrupa`, si se pide) de las vistas que casan con los destinos. */
async function recuentoDeDestinos(tenant: string, destinos: DestinoDeRuta[], sinceMs: number, untilMs: number, columnas: string, agrupa = ""): Promise<any[]> {
  const { slugs, porRuta } = gruposDeDestinos(destinos);
  if (!pool || !slugs.length) return [];
  const args = [tenant, slugs, sinceMs, untilMs];
  const filtro = `v.tenant_id=$1 AND v.page_id = ANY($2::text[])
      AND v.created_at >= to_timestamp($3/1000.0) AND v.created_at <= to_timestamp($4/1000.0)
      AND COALESCE(v.event,'')='' AND v.path NOT LIKE '/admin/%'`;
  const crudas = await pool.query(`SELECT DISTINCT v.page_id, v.path FROM app_page_views v WHERE ${filtro}`, args);
  const webs: string[] = [], rutas: string[] = [], grupos: string[] = [];
  for (const r of crudas.rows as { page_id: string; path: string }[]) {
    const g = porRuta.get(r.page_id + "\u0000" + normalizarRuta(r.path));
    if (!g) continue;
    for (const grupo of g) { webs.push(r.page_id); rutas.push(r.path); grupos.push(grupo); }
  }
  if (!webs.length) return [];
  const res = await pool.query(
    `SELECT m.grupo, ${columnas}
       FROM app_page_views v
       JOIN unnest($5::text[], $6::text[], $7::text[]) AS m(web, ruta, grupo) ON m.web = v.page_id AND m.ruta = v.path
      WHERE ${filtro}
      GROUP BY m.grupo${agrupa ? ", " + agrupa : ""}`,
    [...args, webs, rutas, grupos],
  );
  return res.rows;
}
/** Por grupo: vistas de página, visitantes distintos y cuándo fue la última. Un grupo sin vistas no sale. */
export async function visitasDeDestinos(tenant: string, destinos: DestinoDeRuta[], sinceMs: number, untilMs: number): Promise<Map<string, { visitas: number; visitantes: number; ultima: number }>> {
  const out = new Map<string, { visitas: number; visitantes: number; ultima: number }>();
  if (!pool) {
    const vistos = new Map<string, Set<string>>();
    for (const { grupo, m } of vistasMemDeDestinos(tenant, destinos, sinceMs, untilMs)) {
      const o = out.get(grupo) || { visitas: 0, visitantes: 0, ultima: 0 };
      o.visitas++;
      o.ultima = Math.max(o.ultima, m.created_at);
      out.set(grupo, o);
      if (m.visitor) { const s = vistos.get(grupo) || new Set<string>(); s.add(m.visitor); vistos.set(grupo, s); }
    }
    for (const [g, s] of vistos) out.get(g)!.visitantes = s.size;
    return out;
  }
  const filas = await recuentoDeDestinos(tenant, destinos, sinceMs, untilMs,
    `COUNT(*)::int AS visitas, COUNT(DISTINCT NULLIF(v.visitor,''))::int AS visitantes, extract(epoch from MAX(v.created_at))*1000 AS ultima`);
  for (const x of filas) out.set(String(x.grupo), { visitas: Number(x.visitas) || 0, visitantes: Number(x.visitantes) || 0, ultima: Number(x.ultima) || 0 });
  return out;
}
/** Por grupo y visitante: cuántas veces lo vio y su primera y última vista. El visitante '' reúne las vistas sin identificar. */
export async function visitantesDeDestinos(tenant: string, destinos: DestinoDeRuta[], sinceMs: number, untilMs: number): Promise<Map<string, Map<string, { veces: number; primera: number; ultima: number }>>> {
  const out = new Map<string, Map<string, { veces: number; primera: number; ultima: number }>>();
  const suma = (grupo: string, visitor: string, veces: number, primera: number, ultima: number): void => {
    let g = out.get(grupo);
    if (!g) out.set(grupo, (g = new Map()));
    const o = g.get(visitor);
    if (!o) g.set(visitor, { veces, primera, ultima });
    else { o.veces += veces; o.primera = Math.min(o.primera, primera); o.ultima = Math.max(o.ultima, ultima); }
  };
  if (!pool) {
    for (const { grupo, m } of vistasMemDeDestinos(tenant, destinos, sinceMs, untilMs)) suma(grupo, m.visitor || "", 1, m.created_at, m.created_at);
    return out;
  }
  const filas = await recuentoDeDestinos(tenant, destinos, sinceMs, untilMs,
    `v.visitor, COUNT(*)::int AS veces, extract(epoch from MIN(v.created_at))*1000 AS primera, extract(epoch from MAX(v.created_at))*1000 AS ultima`, "v.visitor");
  for (const x of filas) suma(String(x.grupo), String(x.visitor || ""), Number(x.veces) || 0, Number(x.primera) || 0, Number(x.ultima) || 0);
  return out;
}
/** Por grupo y día (hora de Madrid): vistas de página. */
export async function visitasDeDestinosPorDia(tenant: string, destinos: DestinoDeRuta[], sinceMs: number, untilMs: number): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const suma = (grupo: string, dia: string, n: number): void => {
    let g = out.get(grupo);
    if (!g) out.set(grupo, (g = new Map()));
    g.set(dia, (g.get(dia) || 0) + n);
  };
  if (!pool) {
    for (const { grupo, m } of vistasMemDeDestinos(tenant, destinos, sinceMs, untilMs)) suma(grupo, diaDeMadrid(m.created_at), 1);
    return out;
  }
  const filas = await recuentoDeDestinos(tenant, destinos, sinceMs, untilMs,
    `to_char(v.created_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD') AS dia, COUNT(*)::int AS n`, "2");
  for (const x of filas) suma(String(x.grupo), String(x.dia), Number(x.n) || 0);
  return out;
}
/** Las páginas que ha visto un contacto en las webs del negocio, por web (slug) y ruta normalizada. */
export async function rutasVistasPorContacto(tenant: string, phone: string): Promise<{ web: string; ruta: string; veces: number; ultima: number }[]> {
  const ph = claveContacto(phone);
  if (!ph) return [];
  let crudas: { web: string; ruta: string; veces: number; ultima: number }[];
  if (!pool) {
    crudas = mem.filter((m) => m.tenant_id === tenant && m.contact === ph && !m.event)
      .map((m) => ({ web: m.page_id, ruta: m.path, veces: 1, ultima: m.created_at }));
  } else {
    const r = await pool.query(
      `SELECT page_id AS web, path AS ruta, COUNT(*)::int AS veces, extract(epoch from MAX(created_at))*1000 AS ultima
         FROM app_page_views
        WHERE tenant_id=$1 AND contact=$2 AND COALESCE(event,'')=''
        GROUP BY page_id, path`,
      [tenant, ph],
    );
    crudas = r.rows.map((x: any) => ({ web: String(x.web || ""), ruta: String(x.ruta || ""), veces: Number(x.veces) || 0, ultima: Number(x.ultima) || 0 }));
  }
  const porClave = new Map<string, { web: string; ruta: string; veces: number; ultima: number }>();
  for (const c of crudas) {
    const ruta = normalizarRuta(c.ruta);
    const k = c.web + "\u0000" + ruta;
    const o = porClave.get(k);
    if (!o) porClave.set(k, { web: c.web, ruta, veces: c.veces, ultima: c.ultima });
    else { o.veces += c.veces; o.ultima = Math.max(o.ultima, c.ultima); }
  }
  return [...porClave.values()];
}

/**
 * Snippet a inyectar en el HTML (Node-side: aquí sí podemos escribir `</script>`).
 * v2 GA-grade: beacon de carga con UTM/click-ids/zona horaria + beacon de salida
 * (tiempo, scroll máximo y velocidad de carga) por nonce. Los UTM de la URL se
 * guardan en sessionStorage para que la atribución sobreviva al navegar entre
 * páginas del mismo sitio (la sesión entera queda atribuida a su campaña).
 */
export function pageviewSnippet(pageId: string, label = ""): string {
  const u = baseUrl();
  const q = `p=${encodeURIComponent(pageId)}&l=${encodeURIComponent(label)}`;
  return (
    "<script>(function(){try{" +
    "var n=Math.random().toString(36).slice(2),t0=Date.now(),sent=false,sc=0;" +
    `var B=${JSON.stringify(`${u}/pv?${q}`)}+"&n="+n;` +
    'function s(x){try{var i=new Image();i.src=B+x;}catch(e){}}' +
    // UTM de la URL → beacon; sin UTM en la URL, se reutilizan los de sessionStorage.
    "var U='';try{var Q=new URLSearchParams(location.search),K=[['utm_source','us'],['utm_medium','um'],['utm_campaign','uc'],['utm_term','ut'],['utm_content','uo']],P=[],i,v;" +
    "for(i=0;i<K.length;i++){v=Q.get(K[i][0]);if(v)P.push(K[i][1]+'='+encodeURIComponent(v.slice(0,120)));}" +
    "var C='';['gclid','fbclid','msclkid','ttclid','li_fat_id','twclid'].some(function(k){if(Q.get(k)){C=k;return true;}return false;});" +
    "if(C)P.push('ci='+C);" +
    "if(P.length){U='&'+P.join('&');try{sessionStorage.setItem('_lmU',U);}catch(e){}}else{try{U=sessionStorage.getItem('_lmU')||''}catch(e){}}}catch(e){}" +
    // Auto-referral fuera (GA también lo excluye): navegar dentro del propio sitio no es
    // una fuente de tráfico. Recortado a 300 (el server trunca igual; evita URLs enormes).
    "var rf=document.referrer||'';try{if(rf&&new URL(rf).hostname===location.hostname)rf='';}catch(e){}" +
    // Zona horaria IANA → país en el server (Railway no tiene CDN que mande cabecera geo).
    "var tn='';try{tn=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){}" +
    's("&r="+encodeURIComponent(rf.slice(0,300))+"&pa="+encodeURIComponent(location.pathname)+"&lg="+encodeURIComponent(navigator.language||"")+"&tz="+(new Date().getTimezoneOffset())+"&tzn="+encodeURIComponent(tn)+U);' +
    // Conversiones: window.lmTrack("compra") desde un onclick o la página de gracias.
    'window.lmTrack=function(e){s("&e="+encodeURIComponent(e)+"&pa="+encodeURIComponent(location.pathname)+U);};' +
    // Scroll máximo alcanzado (0-100). passive: nunca frena el scroll del visitante.
    'function m(){try{var d=document.documentElement,b=document.body,h=Math.max(d.scrollHeight,b?b.scrollHeight:0),y=(window.scrollY||d.scrollTop||0)+window.innerHeight,p=h>0?Math.round(y/h*100):0;if(p>sc)sc=p>100?100:p;}catch(e){}}' +
    "window.addEventListener('scroll',m,{passive:true});m();" +
    'function d(){if(sent)return;sent=true;var lt=0;try{var pe=performance.getEntriesByType("navigation")[0];lt=pe&&pe.loadEventEnd?Math.round(pe.loadEventEnd):0;}catch(e){}s("&d="+(Date.now()-t0)+"&sc="+sc+(lt?"&lt="+lt:""));}' +
    'document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")d();});' +
    'window.addEventListener("pagehide",d);' +
    "}catch(e){}})();</script>"
  );
}
