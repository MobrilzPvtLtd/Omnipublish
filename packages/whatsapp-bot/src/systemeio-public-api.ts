/**
 * Cliente para la API Pública oficial de Systeme.io (api.systeme.io).
 *
 *  - Auth: header `X-API-Key: <key>` (la key la genera el user en su panel
 *    Systeme.io → Ajustes → Claves de la API pública. OJO: la clave "MCP" de esa
 *    misma pantalla es otra cosa y NO sirve aquí).
 *  - Formato: JSON normal. `Accept: application/json` — pedir `application/ld+json`
 *    devuelve **406 Not Acceptable**. Los listados vienen como
 *    `{ items: [...], hasMore: bool }` y paginan por CURSOR (`limit` +
 *    `startingAfter`), NO por `page` / `items_per_page`.
 *  - Sirve a cualquier panel apuntando a este backend; el dominio del panel
 *    no afecta a la URL de la API.
 *
 *  Endpoints expuestos por la API pública (cubrimos los necesarios para
 *  métricas + sync de leads):
 *    GET    /api/contacts                  (paginado, filtrable por tag)
 *    GET    /api/contacts/{id}
 *    POST   /api/contacts                  (crear/upsert)
 *    PATCH  /api/contacts/{id}
 *    DELETE /api/contacts/{id}
 *    GET    /api/contact_fields            (definiciones de campos custom)
 *    GET    /api/tags                      (lista de tags + ids)
 *    POST   /api/tags
 *    GET    /api/communities
 *
 *  Lo que NO está en la API pública (necesita systemeio-mcp scraping):
 *  funnels, newsletters, sales, pipelines, workflows, automation rules.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { get as getSetting } from "./settings.js";

const BASE_URL = "https://api.systeme.io/api";

export interface PublicApiCreds {
  apiKey: string;
}

/**
 * SEC: per-call credentials via ALS — análogo a `internalMetricsWithCreds()` en
 * systemeio-internal-api.ts. Antes admin.ts hacía
 * `setSetting("systemeio.publicApiKey", acc.apiKey)` ANTES de llamar a
 * `publicMetrics()`, y ese settings es global a TODO el proceso: dos requests
 * concurrentes para cuentas distintas se pisaban la API key en mitad de la
 * cascada (countContacts → listTags → listCommunities → recentContacts) y
 * devolvían métricas de la cuenta equivocada al user equivocado (cross-account
 * leak, race gemela a la de la cookie).
 *
 * Ahora `publicMetricsWithCreds()` envuelve TODO el árbol de llamadas en un
 * ALS run con la apiKey de ESA cuenta, y `getApiKeyCreds()` la lee del store.
 * Sin ALS no hay race — la propagación es por contexto de promesa.
 *
 * Compat: `publicMetrics()` (sin args) sigue leyendo settings global como
 * fallback para call-sites legacy.
 */
interface PublicCredsStore {
  apiKey: string;
  baseUrl: string;
}
const publicCredsAls = new AsyncLocalStorage<PublicCredsStore>();

function getApiKeyCreds(): PublicApiCreds {
  const fromAls = publicCredsAls.getStore();
  if (fromAls) return { apiKey: fromAls.apiKey };
  return { apiKey: getSetting("systemeio.publicApiKey") };
}

function creds(): PublicApiCreds {
  return getApiKeyCreds();
}

interface HydraResp<T> {
  "hydra:member": T[];
  "hydra:totalItems": number;
  "hydra:view"?: { "hydra:next"?: string };
}

interface RawContact {
  id: number;
  email: string;
  fields?: Array<{ slug: string; value: string | null }>;
  tags?: Array<{ id: number; name: string }>;
  registeredAt?: string;
  sourceURL?: string | null;
  locale?: string;
}
export interface PublicContact {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  tags: Array<{ id: number; name: string }>;
  registeredAt: string;
}

interface RawTag {
  id: number;
  name: string;
}
export interface PublicTag {
  id: number;
  name: string;
}

interface RawCommunity {
  id: number;
  name?: string;
  memberCount?: number;
}
export interface PublicCommunity {
  id: number;
  name: string;
  memberCount: number;
}

/**
 * FORMATO REAL DE LA API (2026-07, verificado contra prod):
 *
 * Este cliente se escribió asumiendo Hydra/JSON-LD (`hydra:member`, `items_per_page`)
 * y pidiendo `Accept: application/ld+json`. NUNCA se había ejecutado contra la API de
 * verdad (ninguna cuenta tenía API key), así que el error salió a la primera:
 * **HTTP 406 Not Acceptable** — systeme.io no sirve ld+json.
 *
 * Lo real:
 *   - `Accept: application/json`
 *   - Listados: `{ items: [...], hasMore: bool }` — NO `hydra:member`
 *   - Paginación por CURSOR: `limit` + `startingAfter`, NO `page` / `items_per_page`
 *
 * `pickItems()` acepta las dos formas por si acaso, pero la buena es `items`.
 */
/**
 * `limit` tiene MÍNIMO en esta API: pedir `limit=1` devuelve
 * **422 "limit: This value should be..."**. No es un capricho — con `limit=1` la
 * validación de la key fallaba con un 422 que parecía culpa de la clave.
 * Lo dejamos entre 10 y 100 SIEMPRE, y si el caller quería menos, recorta él.
 */
function clampLimit(n: number): number {
  return Math.min(100, Math.max(10, Math.floor(n) || 10));
}

function pickItems<T>(data: unknown): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as T[];
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.items)) return d.items as T[];
  if (Array.isArray(d["hydra:member"])) return d["hydra:member"] as T[];
  return [];
}

/**
 * SIO-TRANSPORTE-1 · fetch contra la API con reintento ante 429. La cuota es
 * compartida entre las claves de la cuenta y systeme.io responde 429 con
 * Retry-After: sin esperar, una ráfaga (conteos por etiqueta, estadísticas de
 * correo) devolvía huecos que los llamadores leían como «vacío» o «0». Dos
 * reintentos como mucho y nunca más de 10 s por espera; un 429 no procesa la
 * petición, así que repetir un POST no duplica nada.
 */
async function fetchSio(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  for (let intento = 0; ; intento++) {
    const res = await fetch(`${BASE_URL}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 429 || intento >= 2) return res;
    const ra = Number(res.headers.get("retry-after"));
    const espera = Math.min(10_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * (intento + 1));
    await res.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, espera));
  }
}

async function apiGet<T>(path: string, key?: string): Promise<T | null> {
  const apiKey = key ?? creds().apiKey;
  if (!apiKey) return null;
  try {
    const res = await fetchSio(path, {
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
    }, 15_000);
    if (!res.ok) {
      console.warn(`[systemeio] GET ${path} → ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.warn(`[systemeio] GET ${path} → ${(e as Error).message}`);
    return null;
  }
}

/**
 * NEWSLETTER-1 · Como apiGet, pero FALLA en vez de devolver null. apiGet aplana
 * 401, 404, 500 y un corte de red en el mismo «null», y para las métricas eso vale;
 * para quien decide con la respuesta —a quién se envía un boletín, a quién NO, si
 * un boletín ya existe allí— «no está» y «no se pudo leer» tienen que ser cosas
 * distintas: con la tolerante, un 500 pasajero creaba un boletín duplicado en la
 * web o dejaba caer una etiqueta excluida sin decirlo. El error lleva `status`
 * para que el llamante distinga el 404 (no existe) del resto (no se sabe).
 */
async function apiGetStrict<T>(path: string): Promise<T> {
  const apiKey = creds().apiKey;
  if (!apiKey) throw new Error("falta la clave de acceso de la web");
  const res = await fetchSio(path, {
    headers: { "X-API-Key": apiKey, Accept: "application/json" },
  }, 15_000);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    let detail = txt;
    try {
      const j = JSON.parse(txt) as Record<string, unknown>;
      detail = String(j.detail || j.message || j.title || txt);
    } catch { /* texto crudo */ }
    throw Object.assign(new Error(`Systeme.io ${res.status}: ${detail.slice(0, 240)}`), { status: res.status });
  }
  return (await res.json()) as T;
}

/** Código HTTP que trae un error de apiGetStrict/apiSend, o 0 si no es de la API. */
export function httpStatusDe(e: unknown): number {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : 0;
}

async function apiSend<T>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T | null> {
  const { apiKey } = creds();
  if (!apiKey) return null;
  try {
    const res = await fetchSio(path, {
      method,
      headers: {
        "X-API-Key": apiKey,
        // PATCH exige merge-patch+json en esta API; POST/DELETE, json normal.
        "Content-Type": method === "PATCH" ? "application/merge-patch+json" : "application/json",
        Accept: "application/json",
      },
      body: body == null ? undefined : JSON.stringify(body),
    }, 20_000);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      // Sacamos el `detail` (RFC7807) en vez de escupir el JSON crudo: la causa real
      // llegaba recortada e ilegible al panel. El caso más común y menos evidente:
      // "Please upgrade your plan to create more tags" — no es un fallo del código, es
      // que la cuenta de systeme.io llegó al tope de etiquetas de su plan.
      let detail = txt;
      try {
        const j = JSON.parse(txt) as Record<string, unknown>;
        detail = String(j.detail || j.message || j.title || txt);
      } catch { /* nos quedamos con el texto crudo */ }
      if (/upgrade your plan/i.test(detail)) {
        throw new Error(
          "Tu plan de la web no permite crear más etiquetas (has llegado al tope). " +
            "Usa una etiqueta que YA exista allí, borra alguna que no uses, o sube de plan. " +
            "Asignar etiquetas existentes sigue funcionando.",
        );
      }
      throw Object.assign(new Error(`Systeme.io ${res.status}: ${detail.slice(0, 240)}`), { status: res.status });
    }
    if (res.status === 204) return null;
    return (await res.json()) as T;
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** SIO-WEBHOOK-ALTA-1 · da de alta el webhook oficial (POST /api/webhooks) con los seis eventos.
 *  systeme.io no deja reactivar una suscripción desactivada: se crea uno nuevo. */
export async function createWebhook(name: string, url: string, secret: string): Promise<{ id?: string } | null> {
  return apiSend<{ id?: string }>("POST", "/webhooks", {
    name, url, secret, active: true,
    subscriptions: ["CONTACT_CREATED", "CONTACT_OPT_IN", "CONTACT_TAG_ADDED", "CONTACT_TAG_REMOVED", "SALE_NEW", "SALE_CANCELED"],
  });
}

/**
 * Verifica que una API key sirve haciendo una llamada barata (`GET /contacts?limit=1`).
 */
export async function validateApiKey(
  key: string,
): Promise<{ ok: boolean; sample: number; hasMore: boolean; error?: string }> {
  if (!key) return { ok: false, sample: 0, hasMore: false, error: "Pega tu API Key" };
  try {
    // Sin parámetros: la llamada más simple posible. Menos superficie para que un
    // parámetro mal puesto (como el limit=1 de antes) se disfrace de "clave mala".
    const res = await fetch(`${BASE_URL}/contacts`, {
      headers: {
        "X-API-Key": key,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    // Solo 401/403 significan "la clave no vale". Cualquier otro código es un
    // problema NUESTRO o de systeme.io, y decirle al usuario "clave rechazada" sería
    // mentirle (es justo lo que pasó con el 406: la clave era buena y el que pedía
    // mal el formato era yo).
    if (res.status === 401 || res.status === 403)
      return { ok: false, sample: 0, hasMore: false, error: "La clave no es válida o no tiene permisos" };
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      // Sacamos el `detail` del cuerpo (Symfony/RFC7807) en vez de escupir el JSON
      // crudo recortado: cortado a 120 chars el mensaje se quedaba en "limit: This
      // value sho…" y no había forma de saber qué le pasaba.
      let detail = txt;
      try {
        const j = JSON.parse(txt) as Record<string, unknown>;
        detail = String(j.detail || j.message || j.title || txt);
      } catch { /* nos quedamos con el texto crudo */ }
      return {
        ok: false,
        sample: 0,
        hasMore: false,
        error: `systeme.io respondió HTTP ${res.status}. No es culpa de tu clave: ${detail.slice(0, 300)}`,
      };
    }
    const data = await res.json();
    const items = pickItems<RawContact>(data);
    // La API real ({items, hasMore}) NUNCA devuelve hydra:totalItems (ver la nota
    // de formato arriba): items.length es solo la 1ª página, no el total. Aquí
    // devolvemos esa muestra + hasMore; el total real lo calcula el caller con
    // countContacts() (paginación por cursor).
    return { ok: true, sample: items.length, hasMore: !!(data as Record<string, unknown>)?.hasMore };
  } catch (e) {
    return { ok: false, sample: 0, hasMore: false, error: (e as Error).message || "Error de red" };
  }
}

function mapContact(raw: RawContact): PublicContact {
  const f = (slug: string) =>
    (raw.fields || []).find((x) => x.slug === slug)?.value ?? "";
  return {
    id: raw.id,
    email: raw.email,
    firstName: f("first_name"),
    lastName: f("surname") || f("last_name"),
    tags: raw.tags || [],
    registeredAt: raw.registeredAt || "",
  };
}

export async function listContacts(
  opts: { perPage?: number; page?: number } = {},
): Promise<{ items: PublicContact[]; total: number }> {
  const want = opts.perPage ?? 20;
  const r = await apiGet<unknown>(`/contacts?limit=${clampLimit(want)}`);
  const items = pickItems<RawContact>(r).map(mapContact).slice(0, Math.max(1, want));
  return { items, total: items.length };
}

export async function countContacts(): Promise<{ count: number; capped: boolean }> {
  // La API pagina por cursor y no devuelve un total: contamos recorriendo páginas.
  // `capped` avisa de que el conteo se cortó en el tope de guarda (no es el total).
  return countAll("/contacts");
}

/** Contacto crudo para ATRIBUCIÓN: conserva sourceURL (la URL de la landing con la
 *  que systeme.io registró al lead, con sus utm_*) que mapContact descarta. */
export interface AttributionContact {
  id: number;
  email: string;
  registeredAt: string;
  sourceURL: string;
}

/**
 * Una página de contactos con su URL de origen, por cursor. `startingAfter` = id del
 * último contacto ya visto (los ids son crecientes → sirve de cursor incremental:
 * el sync guarda el max id copiado y sigue desde ahí).
 */
export async function listContactsAttributionPage(
  startingAfter?: number,
): Promise<{ items: AttributionContact[]; hasMore: boolean }> {
  const r = await apiGet<Record<string, unknown>>(
    `/contacts?limit=100${startingAfter ? `&startingAfter=${startingAfter}` : ""}`,
  );
  if (!r) return { items: [], hasMore: false };
  const items = pickItems<RawContact>(r).map((c) => ({
    id: Number(c.id) || 0,
    email: String(c.email || ""),
    registeredAt: String(c.registeredAt || ""),
    sourceURL: String(c.sourceURL || ""),
  }));
  return { items, hasMore: !!(r as { hasMore?: boolean }).hasMore };
}

// ── Booking & Calendar (añadido a la API oficial en 2026) ────────────────────
// GET /booking-calendar/bookings — las RESERVAS del calendario de booking, con
// filtros por fecha y paginación por cursor. La doc (developer.systeme.io) solo
// documenta contactName del asistente — SIN email —, pero la respuesta real
// puede traer más: se sondean variantes y se conserva el item crudo en `raw`
// para que aguas arriba no se pierda nada.
export interface SioBookingItem {
  id: number;
  date: string; // ISO 8601
  createdAt: string; // ISO 8601
  eventName: string;
  eventDuration: number | null; // minutos
  status: string; // SCHEDULED | UPCOMING | PAST | RESCHEDULED | CANCELLED
  paymentStatus: string;
  eventType: string;
  contactName: string;
  email: string; // '' si la API no lo trae
  /** MET-AUTO-07-FIN · móvil que dejó al reservar, si la API lo trae ('' si no). */
  phone: string;
  raw: Record<string, unknown>;
}
export async function listBookingsPage(opts: {
  startDate?: string;
  endDate?: string;
  startingAfter?: number;
}): Promise<{ items: SioBookingItem[]; hasMore: boolean }> {
  const q: string[] = ["limit=100", "order=asc"];
  if (opts.startDate) q.push("startDate=" + encodeURIComponent(opts.startDate));
  if (opts.endDate) q.push("endDate=" + encodeURIComponent(opts.endDate));
  if (opts.startingAfter) q.push("startingAfter=" + opts.startingAfter);
  const r = await apiGet<Record<string, unknown>>(`/booking-calendar/bookings?${q.join("&")}`);
  if (!r) return { items: [], hasMore: false };
  const items = pickItems<Record<string, unknown>>(r).map((b) => {
    const contact = (b.contact && typeof b.contact === "object" ? b.contact : {}) as Record<string, unknown>;
    return {
      id: Number(b.id) || 0,
      date: String(b.date || ""),
      createdAt: String(b.createdAt || ""),
      eventName: String(b.eventName || ""),
      eventDuration: b.eventDuration == null ? null : Number(b.eventDuration) || null,
      status: String(b.status || ""),
      paymentStatus: String(b.paymentStatus || ""),
      eventType: String(b.eventType || ""),
      contactName: String(b.contactName || contact.name || ""),
      email: String(b.email || b.contactEmail || contact.email || ""),
      phone: String(b.phone || b.phoneNumber || b.contactPhone || contact.phone || contact.phoneNumber || ""),
      raw: b,
    };
  });
  return { items, hasMore: !!(r as { hasMore?: boolean }).hasMore };
}
/** GET /booking-calendar/events — definiciones de eventos (id + nombre). */
export async function listBookingEvents(): Promise<Array<{ id: number; name: string }>> {
  const r = await apiGet<Record<string, unknown>>("/booking-calendar/events?limit=100");
  return pickItems<{ id: number; name: string }>(r).map((e) => ({ id: Number(e.id) || 0, name: String(e.name || "") }));
}

/** Recorre un listado paginado por cursor y cuenta los elementos (tope de guarda).
 *  `capped` = salimos por el tope `max` con más páginas pendientes: el count NO es
 *  el total real, es un suelo (el render lo pinta con sufijo '+').
 *  SIO-TRANSPORTE-1 · Si la PRIMERA página falla, lanza: antes devolvía 0 y un 500
 *  pasajero pintaba «0 contactos» (todos los llamadores ya tenían su catch para
 *  «no se pudo contar», que nunca saltaba). Si falla a mitad, lo contado es un
 *  suelo y se marca `capped`. */
async function countAll(path: string, max = 5000): Promise<{ count: number; capped: boolean }> {
  let count = 0;
  let after = "";
  let capped = false;
  for (let i = 0; i < 60; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await apiGet<Record<string, unknown>>(
      `${path}${sep}limit=100${after ? `&startingAfter=${encodeURIComponent(after)}` : ""}`,
    );
    if (r === null) {
      if (i === 0) throw new Error("no se pudo contar: la web no respondió");
      capped = true;
      break;
    }
    const items = pickItems<{ id: number }>(r);
    count += items.length;
    if (!r?.hasMore || !items.length) break;
    if (count >= max) {
      capped = true; // hasMore aún era true → hay más contactos que `count`
      break;
    }
    after = String(items[items.length - 1]?.id ?? "");
    if (!after) break;
  }
  return { count, capped };
}

export async function listTags(): Promise<PublicTag[]> {
  const out: PublicTag[] = [];
  let after = "";
  for (let i = 0; i < 20; i++) {
    const r = await apiGet<Record<string, unknown>>(
      `/tags?limit=100${after ? `&startingAfter=${encodeURIComponent(after)}` : ""}`,
    );
    const items = pickItems<RawTag>(r);
    for (const t of items) out.push({ id: t.id, name: t.name });
    if (!r?.hasMore || !items.length) break;
    after = String(items[items.length - 1]?.id ?? "");
    if (!after) break;
  }
  return out;
}

export async function listCommunities(): Promise<PublicCommunity[]> {
  const r = await apiGet<unknown>("/communities?limit=20");
  return pickItems<RawCommunity>(r).map((c) => ({
    id: c.id,
    name: c.name ?? `Community #${c.id}`,
    memberCount: c.memberCount ?? 0,
  }));
}

// 2026-08-19 · MIGRACIÓN A API OFICIAL: systeme.io añadió GET /api/funnels a su
// API pública (2025-2026). Con esto los dropdowns del Page Builder dejan de
// depender del systemeio-mcp para las cuentas con API key. Los STEPS de un
// funnel NO se migran aún: el enum oficial de `type` no incluye checkout/optin
// del panel y el publish clasifica páginas por ese campo (camino destructivo
// si se clasifica mal) — esos siguen por el MCP.
export interface PublicFunnel {
  id: number;
  name: string;
}

/** Todos los funnels de la cuenta (cursor {items,hasMore}; cap de guarda 500). */
/**
 * FALSO-CERO-1 · 2026-08-23: devuelve **null** si la API falla (403/404/timeout…)
 * y `[]` solo si la cuenta de verdad no tiene funnels. `apiGet` traga cualquier
 * error y devuelve null: sin esta distinción, una llamada fallida se convertía en
 * «0 funnels» y el panel pintaba un cero falso donde antes había el número real.
 */
export async function listFunnels(maxItems = 500): Promise<PublicFunnel[] | null> {
  const out: PublicFunnel[] = [];
  let after = "";
  for (let i = 0; i < 20 && out.length < maxItems; i++) {
    const r = await apiGet<Record<string, unknown>>(
      `/funnels?limit=100${after ? `&startingAfter=${encodeURIComponent(after)}` : ""}`,
    );
    if (i === 0 && !r) return null; // la API no contestó: «sin dato», NO «cero»
    const items = pickItems<{ id?: number; name?: string | null }>(r);
    for (const f of items) out.push({ id: Number(f.id) || 0, name: String(f.name ?? "") });
    if (!r?.hasMore || !items.length) break;
    after = String(items[items.length - 1]?.id ?? "");
    if (!after) break;
  }
  return out.slice(0, maxItems);
}

// FUNNELS-1 · lectura ESTRICTA de la estructura de los funnels (la vista Funnels guarda lo que
// lee y retira lo que ya no está: una página caída a medias no puede pasar por «ya no existe»).
// Aditivo: listFunnels() de arriba no se toca (lo usan los desplegables, que prefieren una lista
// parcial a ninguna). Aquí, null = no se pudo leer ENTERO; [] = de verdad no hay.
export interface PublicFunnelFull {
  id: string;
  name: string;
  /** null = la respuesta no dice si está activo. */
  active: boolean | null;
}
export interface PublicFunnelStep {
  id: string;
  name: string;
  type: string;
  pageId: string;
  url: string;
  /** null = la respuesta no trae el orden. */
  position: number | null;
  offerId: string;
}
const idTexto = (v: unknown): string => (v === null || v === undefined || v === "" ? "" : String(v));
function activoDe(f: Record<string, unknown>): boolean | null {
  for (const k of ["active", "isActive", "enabled"]) if (typeof f[k] === "boolean") return f[k] as boolean;
  const st = f.state as Record<string, unknown> | null | undefined;
  if (st && typeof st === "object" && typeof st.isActive === "boolean") return st.isActive;
  if (typeof f.status === "string") {
    const s = f.status.toLowerCase();
    if (s === "active" || s === "published") return true;
    if (s === "inactive" || s === "disabled" || s === "archived") return false;
  }
  return null;
}
/** Recorre un listado {items, hasMore} entero. null si cae CUALQUIER página o no se llega al final. */
async function listadoEntero(ruta: string, maxPages: number): Promise<Record<string, unknown>[] | null> {
  const out: Record<string, unknown>[] = [];
  let after = "";
  for (let i = 0; i < maxPages; i++) {
    const r = await apiGet<Record<string, unknown>>(`${ruta}?limit=100${after ? `&startingAfter=${encodeURIComponent(after)}` : ""}`);
    if (!r) return null;
    // Un 200 que no trae el listado (cuerpo de error, respuesta a medias) NO es «no hay ninguno»:
    // quien llama retira lo que falta, y vaciaría la estructura guardada.
    if (!Array.isArray(r.items) && !Array.isArray(r["hydra:member"])) return null;
    const items = pickItems<Record<string, unknown>>(r);
    out.push(...items);
    if (!r.hasMore || !items.length) return out;
    after = idTexto(items[items.length - 1]?.id);
    if (!after) return null;
  }
  return null; // quedaban páginas: no es una lectura completa
}
/** Todos los funnels de la cuenta. Se llama dentro de withPublicApiKey(apiKey, …). */
export async function listFunnelsFull(maxPages = 50): Promise<PublicFunnelFull[] | null> {
  const items = await listadoEntero("/funnels", maxPages);
  if (!items) return null;
  return items
    .map((f) => ({ id: idTexto(f.id), name: String(f.name ?? ""), active: activoDe(f) }))
    .filter((f) => f.id);
}
/** Los pasos (páginas) de UN funnel, con su dirección pública, su orden y la oferta que cobran.
 *  Se llama dentro de withPublicApiKey(apiKey, …). */
export async function listFunnelSteps(funnelId: string | number, maxPages = 20): Promise<PublicFunnelStep[] | null> {
  const items = await listadoEntero(`/funnels/${encodeURIComponent(String(funnelId))}/steps`, maxPages);
  if (!items) return null;
  return items
    .map((s) => {
      const pos = Number(s.position);
      return {
        id: idTexto(s.id),
        name: String(s.name ?? ""),
        type: String(s.type ?? ""),
        pageId: idTexto(s.pageId),
        url: String(s.url ?? ""),
        position: s.position === null || s.position === undefined || !Number.isFinite(pos) ? null : pos,
        offerId: idTexto(s.offerId),
      };
    })
    .filter((s) => s.id);
}

// 2026-08-19 · Newsletters vía API oficial (GET /api/mailing/newsletters,
// añadido por systeme.io en 2025-2026). El subject viene anidado en content.
export interface PublicNewsletter {
  id: number;
  subject: string;
  isSent: boolean;
}

/** FALSO-CERO-1 · null = la API no contestó; [] = la cuenta no tiene newsletters. */
export async function listNewsletters(limit = 10): Promise<PublicNewsletter[] | null> {
  const r = await apiGet<Record<string, unknown>>(`/mailing/newsletters?limit=${clampLimit(limit)}`);
  if (!r) return null;
  return pickItems<{ id?: number; content?: { subject?: string | null } | null; state?: { isSent?: boolean } | null }>(r)
    .slice(0, Math.max(1, limit))
    .map((n) => ({
      id: Number(n.id) || 0,
      subject: String(n.content?.subject ?? "(sin asunto)"),
      isSent: !!n.state?.isSent,
    }));
}

/**
 * T03-CORREOS · Página de newsletters por cursor, para el catálogo unificado de
 * Correos. La colección oficial solo expone id + content.subject + state.isSent
 * (sin fechas ni destinatarios — eso vive en la API interna por cookie).
 * FALSO-CERO-1: null = la API no contestó; { items: [] } = cero real.
 */
export async function listNewslettersPage(
  opts: { limit?: number; startingAfter?: number | string; order?: "asc" | "desc" } = {},
): Promise<{ items: PublicNewsletter[]; hasMore: boolean } | null> {
  const lim = clampLimit(opts.limit ?? 100);
  const after = opts.startingAfter != null && String(opts.startingAfter) !== "" ? `&startingAfter=${encodeURIComponent(String(opts.startingAfter))}` : "";
  const r = await apiGet<Record<string, unknown>>(`/mailing/newsletters?limit=${lim}&order=${opts.order || "desc"}${after}`);
  if (!r) return null;
  const items = pickItems<{ id?: number; content?: { subject?: string | null } | null; state?: { isSent?: boolean } | null }>(r).map((n) => ({
    id: Number(n.id) || 0,
    subject: String(n.content?.subject ?? "(sin asunto)"),
    isSent: !!n.state?.isSent,
  }));
  return { items, hasMore: !!(r as { hasMore?: boolean }).hasMore };
}

// ════════════════════════════════════════════════════════════════════════════
// NEWSLETTER-API-1 · ESCRITURA de boletines por la API OFICIAL de systeme.io.
//
// Hasta aquí este módulo solo ESCRIBÍA contactos y etiquetas; los correos eran
// de solo lectura (catálogo + métricas). La API oficial sí expone el ciclo
// entero de un boletín, así que la sección Newsletter NO necesita el navegador
// del MCP para nada del envío:
//
//   POST   /mailing/newsletters                  → 201 {id, content, state}
//   PATCH  /mailing/newsletters/{id}             → 200   (merge-patch+json)
//   PUT    /mailing/newsletters/{id}/schedule    → 200 {scheduledAt}  (null = quitar)
//   PUT    /mailing/newsletters/{id}/included-tags → 200 {items:[{id,name}]}
//   PUT    /mailing/newsletters/{id}/excluded-tags → 200 (simétrico)
//   POST   /mailing/newsletters/{id}/send        → 204 sin cuerpo
//   POST   /mailing/newsletters/{id}/send-test   → 204 sin cuerpo
//
// TRAMPA DEL 204 (la que de verdad muerde): apiSend() devuelve null en DOS
// casos que no se parecen en nada — «204 Sin contenido, ha ido bien» y «no hay
// API key en el ámbito, no se ha llamado a nadie». Un envío que no sale y se
// reporta como enviado es el peor fallo posible de esta sección, así que todas
// las funciones de abajo empiezan por exigirClave(): sin clave, excepción.
// ════════════════════════════════════════════════════════════════════════════

/** Sin clave en el ámbito no se llama a nadie y apiSend devuelve null en silencio:
 *  para una operación de ENVÍO eso sería un falso «enviado». Aquí se corta antes. */
function exigirClave(): void {
  if (!creds().apiKey) {
    throw new Error(
      "Esta cuenta web no tiene clave de acceso guardada: conéctala en Conexiones para poder enviar",
    );
  }
}

/** Cuerpo de un boletín tal y como lo acepta la API oficial. Todo opcional salvo
 *  el asunto al crearlo. `bodyHtml` es el modo clásico (el que usamos); `bodyJson`
 *  es el del editor visual y lo dejamos pasar tal cual por si un boletín creado
 *  en la web se edita aquí. */
export interface NewsletterContent {
  subject?: string;
  previewText?: string | null;
  editorType?: "classic" | "visual";
  bodyHtml?: string | null;
  bodyJson?: unknown[] | null;
  senderEmail?: string;
  senderName?: string | null;
}

export interface NewsletterDetalle {
  id: number;
  subject: string;
  previewText: string;
  bodyHtml: string;
  senderEmail: string;
  senderName: string;
  isSent: boolean;
}

function mapNewsletterDetalle(n: Record<string, unknown> | null): NewsletterDetalle | null {
  if (!n || !n.id) return null;
  const c = (n.content || {}) as Record<string, unknown>;
  const s = (n.state || {}) as Record<string, unknown>;
  return {
    id: Number(n.id) || 0,
    subject: String(c.subject ?? ""),
    previewText: String(c.previewText ?? ""),
    bodyHtml: String(c.bodyHtml ?? ""),
    senderEmail: String(c.senderEmail ?? ""),
    senderName: String(c.senderName ?? ""),
    isSent: !!s.isSent,
  };
}

/** El asunto es obligatorio y la API lo corta en 255; el texto de vista previa, en 140.
 *  Recortamos AQUÍ para que un asunto largo no se convierta en un 422 opaco. */
function saneaContenido(c: NewsletterContent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.subject != null) out.subject = String(c.subject).slice(0, 255);
  if (c.previewText !== undefined) {
    const p = c.previewText == null ? null : String(c.previewText).slice(0, 140);
    out.previewText = p || null;
  }
  if (c.editorType) out.editorType = c.editorType;
  if (c.bodyHtml !== undefined) out.bodyHtml = c.bodyHtml ?? null;
  if (c.bodyJson !== undefined) out.bodyJson = c.bodyJson ?? null;
  if (c.senderEmail) out.senderEmail = c.senderEmail;
  if (c.senderName !== undefined) out.senderName = c.senderName ?? null;
  return out;
}

/** Crea el boletín en la web. Devuelve su id, que es lo que enlaza nuestra fila con la suya. */
export async function createNewsletter(content: NewsletterContent): Promise<NewsletterDetalle> {
  exigirClave();
  const asunto = String(content.subject || "").trim();
  if (!asunto) throw new Error("el boletín necesita un asunto");
  const r = await apiSend<Record<string, unknown>>("POST", "/mailing/newsletters", {
    content: saneaContenido({ editorType: "classic", ...content, subject: asunto }),
  });
  const d = mapNewsletterDetalle(r);
  if (!d || !d.id) throw new Error("la web no devolvió el id del boletín recién creado");
  return d;
}

/** Reescribe asunto/cuerpo/remitente de un boletín que YA existe allí. */
export async function updateNewsletter(id: number, content: NewsletterContent): Promise<void> {
  exigirClave();
  if (!id) throw new Error("falta el identificador del boletín en la web");
  await apiSend<unknown>("PATCH", `/mailing/newsletters/${id}`, { content: saneaContenido(content) });
}

/** Ficha completa de un boletín. null = la web no lo tiene (borrado allí).
 *  Cualquier OTRO fallo (clave rechazada, 500, corte) LANZA: con la lectura
 *  tolerante, un 500 pasajero se leía como «no existe» y el llamante creaba un
 *  boletín nuevo en la web — o, en la reconciliación, lo reenviaba a ciegas. */
export async function getNewsletter(id: number): Promise<NewsletterDetalle | null> {
  if (!id) return null;
  try {
    const r = await apiGetStrict<Record<string, unknown>>(`/mailing/newsletters/${id}`);
    return mapNewsletterDetalle(r);
  } catch (e) {
    if (httpStatusDe(e) === 404) return null;
    throw e;
  }
}

/** A quién SÍ se le envía. Lista completa: lo que no venga aquí se queda fuera. */
export async function setNewsletterIncludedTags(id: number, tagIds: number[]): Promise<void> {
  exigirClave();
  if (!id) throw new Error("falta el identificador del boletín en la web");
  await apiSend<unknown>("PUT", `/mailing/newsletters/${id}/included-tags`, { tagIds: unicos(tagIds) });
}

/** A quién NO, aunque cumpla lo de arriba. Mandar [] limpia las exclusiones. */
export async function setNewsletterExcludedTags(id: number, tagIds: number[]): Promise<void> {
  exigirClave();
  if (!id) throw new Error("falta el identificador del boletín en la web");
  await apiSend<unknown>("PUT", `/mailing/newsletters/${id}/excluded-tags`, { tagIds: unicos(tagIds) });
}

/** La API exige enteros ≥1 y sin repetidos; un 0 colado devuelve un 422 ilegible. */
function unicos(ids: number[]): number[] {
  return [...new Set((ids || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1))];
}

/**
 * Programa el envío en la WEB (no en nuestro reloj): es su infraestructura la que
 * dispara a la hora, así que un reinicio nuestro no se lleva por delante un envío.
 * `null` retira la programación. La API rechaza más de un año vista.
 */
export async function scheduleNewsletter(id: number, cuandoIso: string | null): Promise<void> {
  exigirClave();
  if (!id) throw new Error("falta el identificador del boletín en la web");
  if (cuandoIso) {
    const t = Date.parse(cuandoIso);
    if (!isFinite(t)) throw new Error("la fecha de programación no es válida");
    if (t > Date.now() + 365 * 24 * 3600 * 1000) {
      throw new Error("la web no admite programar con más de un año de antelación");
    }
  }
  await apiSend<unknown>("PUT", `/mailing/newsletters/${id}/schedule`, { scheduledAt: cuandoIso });
}

/** Cuándo está programado, según la web. null = no está programado. */
export async function getNewsletterSchedule(id: number): Promise<string | null> {
  if (!id) return null;
  const r = await apiGet<Record<string, unknown>>(`/mailing/newsletters/${id}/schedule`);
  const v = r?.scheduledAt;
  return v ? String(v) : null;
}

/** Envía YA. Responde 204 sin cuerpo: sin excepción = aceptado por la web. */
export async function sendNewsletter(id: number): Promise<void> {
  exigirClave();
  if (!id) throw new Error("falta el identificador del boletín en la web");
  await apiSend<unknown>("POST", `/mailing/newsletters/${id}/send`);
}

/** Prueba a UNA dirección (la API solo acepta una). No consume la lista. */
export async function sendNewsletterTest(id: number, email: string): Promise<void> {
  exigirClave();
  if (!id) throw new Error("falta el identificador del boletín en la web");
  const dir = String(email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dir)) throw new Error("escribe un correo válido para la prueba");
  await apiSend<unknown>("POST", `/mailing/newsletters/${id}/send-test`, { testRecipientEmail: dir });
}

/** Borra el boletín en la web. Solo se usa al borrar el nuestro, y nunca si ya se envió. */
export async function deleteNewsletter(id: number): Promise<void> {
  exigirClave();
  if (!id) return;
  await apiSend<unknown>("DELETE", `/mailing/newsletters/${id}`);
}

/** T03-CORREOS · Campaña de mailing (secuencia de correos). El listado oficial solo
 *  trae id + name (+ senderEmail): los correos de dentro son los campaign-steps. */
export interface PublicCampaign {
  id: number;
  name: string;
}

/** T03-CORREOS · Página de campañas por cursor. null = no contestó; items [] = cero real. */
export async function listCampaignsPage(
  opts: { limit?: number; startingAfter?: number | string; order?: "asc" | "desc" } = {},
): Promise<{ items: PublicCampaign[]; hasMore: boolean } | null> {
  const lim = clampLimit(opts.limit ?? 100);
  const after = opts.startingAfter != null && String(opts.startingAfter) !== "" ? `&startingAfter=${encodeURIComponent(String(opts.startingAfter))}` : "";
  const r = await apiGet<Record<string, unknown>>(`/mailing/campaigns?limit=${lim}&order=${opts.order || "desc"}${after}`);
  if (!r) return null;
  const items = pickItems<{ id?: number; name?: string | null }>(r).map((c) => ({
    id: Number(c.id) || 0,
    name: String(c.name ?? "(sin nombre)"),
  }));
  return { items, hasMore: !!(r as { hasMore?: boolean }).hasMore };
}

/** CORREO-API-3 (SIO-API-F7) · Correos de automatización (GET /mailing/automation-emails,
 *  por cursor). La API no dice a qué regla ni a qué workflow pertenece cada uno: solo id y
 *  asunto. `limit` 1-9 da 400 «fuera de rango» (medido el 29-oct-2026): siempre 100.
 *  null = la primera página no contestó; después se devuelve lo que haya. */
export async function listAutomationEmails(maxPages = 5): Promise<{ items: Array<{ id: number; subject: string }>; truncated: boolean } | null> {
  const items: Array<{ id: number; subject: string }> = [];
  let after = "";
  for (let i = 0; i < maxPages; i++) {
    const r = await apiGet<Record<string, unknown>>(`/mailing/automation-emails?limit=100${after ? `&startingAfter=${encodeURIComponent(after)}` : ""}`);
    if (!r) return i === 0 ? null : { items, truncated: true };
    const page = pickItems<{ id?: number; content?: { subject?: string | null } | null }>(r);
    for (const e of page) if (Number(e.id)) items.push({ id: Number(e.id), subject: String(e.content?.subject ?? "(sin asunto)") });
    if (!(r as { hasMore?: boolean }).hasMore || !page.length) return { items, truncated: false };
    after = String(page[page.length - 1].id);
  }
  return { items, truncated: true };
}

/** CORREO-API-6 (SIO-API-F7) · Correos que envían las reglas de automatización (GET
 *  /automation/rules + GET /automation/rules/{id}: el listado solo trae el tipo de cada acción;
 *  el id del correo y el paso de embudo vienen en el detalle, medido el 29-oct-2026). Las reglas
 *  form_subscribed con funnelStepId se agrupan por paso, con el nombre de la página (el paso no
 *  dice de qué embudo es). Tope de 60 detalles. null = el listado no contestó. */
export async function listRuleEmails(maxDetails = 60): Promise<{
  rules: number[]; steps: Array<{ id: number; name: string; active: boolean; emailIds: number[] }>; truncated: boolean;
} | null> {
  const ids: Array<{ id: number; email: boolean; active: boolean }> = [];
  let after = "";
  for (let i = 0; i < 5; i++) {
    const r = await apiGet<Record<string, unknown>>(`/automation/rules?limit=100${after ? `&startingAfter=${encodeURIComponent(after)}` : ""}`);
    if (!r) { if (i === 0) return null; break; }
    const page = pickItems<{ id?: number; actions?: Array<{ type?: string }>; state?: { isActive?: boolean } }>(r);
    for (const x of page) if (Number(x.id)) ids.push({ id: Number(x.id), email: (x.actions || []).some((a) => a.type === "send_email"), active: !!x.state?.isActive });
    if (!(r as { hasMore?: boolean }).hasMore || !page.length) break;
    after = String(page[page.length - 1].id);
  }
  const conCorreo = ids.filter((x) => x.email);
  const rules: number[] = [];
  const porPaso = new Map<number, { active: boolean; emailIds: number[] }>();
  const lote = conCorreo.slice(0, maxDetails);
  for (let j = 0; j < lote.length; j += 6) {
    await Promise.all(lote.slice(j, j + 6).map(async (x) => {
      const d = await apiGet<{ triggers?: Array<{ details?: { funnelStepId?: number } }>; actions?: Array<{ type?: string; details?: { automationEmailId?: number } }> }>(`/automation/rules/${x.id}`);
      if (!d) return;
      const emails = (d.actions || []).filter((a) => a.type === "send_email").map((a) => Number(a.details?.automationEmailId)).filter(Boolean);
      const paso = (d.triggers || []).map((t) => Number(t.details?.funnelStepId)).find(Boolean);
      if (!paso) { rules.push(...emails); return; }
      const g = porPaso.get(paso) || { active: false, emailIds: [] };
      g.active = g.active || x.active; g.emailIds.push(...emails);
      porPaso.set(paso, g);
    }));
  }
  const steps = [];
  for (const [id, g] of porPaso) {
    const st = await apiGet<{ name?: string }>(`/funnel-steps/${id}`);
    steps.push({ id, name: String(st?.name || "Paso " + id), active: g.active, emailIds: [...new Set(g.emailIds)] });
  }
  return { rules: [...new Set(rules)], steps, truncated: conCorreo.length > maxDetails };
}

/** T03-CORREOS · Un email DENTRO de una campaña (campaign-step). isActive=false =
 *  el correo existe pero está pausado en la secuencia. */
export interface PublicCampaignStep {
  id: number;
  campaignId: number;
  subject: string;
  isActive: boolean;
  position: number | null;
}

/** T03-CORREOS · Todos los emails de una campaña (paginado por cursor, con tope de
 *  páginas para no recorrer históricos enormes). null = la API no contestó. */
export async function listCampaignSteps(campaignId: number, maxPages = 5): Promise<PublicCampaignStep[] | null> {
  const out: PublicCampaignStep[] = [];
  let after = "";
  for (let i = 0; i < maxPages; i++) {
    const r = await apiGet<Record<string, unknown>>(
      `/mailing/campaigns/${campaignId}/steps?limit=100${after ? `&startingAfter=${encodeURIComponent(after)}` : ""}`,
    );
    if (!r) return i === 0 ? null : out; // primera página caída = no concluyente; después, lo que haya
    const items = pickItems<{ id?: number; campaignId?: number; content?: { subject?: string | null } | null; state?: { isActive?: boolean; position?: number | null } | null }>(r);
    for (const s of items) {
      out.push({
        id: Number(s.id) || 0,
        campaignId: Number(s.campaignId) || campaignId,
        subject: String(s.content?.subject ?? "(sin asunto)"),
        isActive: !!s.state?.isActive,
        position: s.state?.position ?? null,
      });
    }
    if (!(r as { hasMore?: boolean })?.hasMore || !items.length) break;
    after = String(items[items.length - 1]?.id ?? "");
    if (!after) break;
  }
  return out;
}

/**
 * 2026-08-19 · Una página de contactos para el job contact-pull (réplica de la
 * forma que devolvía el list-contacts del MCP en la cola: contacts + hasMore).
 */
export async function listContactsPullPage(
  limit = 100,
): Promise<{ contacts: PublicContact[]; hasMore: boolean }> {
  const r = await apiGet<Record<string, unknown>>(`/contacts?limit=${clampLimit(limit)}`);
  if (!r) return { contacts: [], hasMore: false };
  const contacts = pickItems<RawContact>(r).map(mapContact).slice(0, Math.max(1, limit));
  return { contacts, hasMore: !!(r as { hasMore?: boolean }).hasMore };
}

/**
 * Cuenta cuántos contactos hay con un tag concreto. Útil para el "top tags"
 * de la card de Conexiones (mostramos los 5 con más contactos).
 */
export async function countContactsByTag(tagId: number): Promise<number> {
  return (await countAll(`/contacts?tags=${tagId}`, 2000)).count;
}

/** Devuelve los N contactos más recientes. (n<10 → pedimos el mínimo y recortamos.) */
export async function recentContacts(n = 5): Promise<PublicContact[]> {
  const r = await apiGet<unknown>(`/contacts?limit=${clampLimit(n)}`);
  return pickItems<RawContact>(r).map(mapContact).slice(0, Math.max(1, n));
}

/**
 * Ejecuta `fn` con la API key de UNA cuenta concreta (ALS, sin race entre
 * requests concurrentes de cuentas distintas). Generaliza lo que hasta ahora
 * solo hacía publicMetricsWithCreds().
 */
export async function withPublicApiKey<T>(apiKey: string, fn: () => Promise<T>): Promise<T> {
  return publicCredsAls.run({ apiKey, baseUrl: BASE_URL }, fn);
}

/**
 * Localiza un contacto por email.
 *
 * SEGURIDAD (bug real evitado): NO se puede coger `hydra:member[0]` a ciegas.
 * Las APIs API-Platform IGNORAN los query params que no estén declarados como
 * filtro; si `?email=` no filtrase, la respuesta sería la primera página de
 * TODOS los contactos y el [0] un contacto ARBITRARIO — al que acabaríamos
 * asignándole la etiqueta del lead (y metiéndolo en la automatización de otro).
 * Por eso se comprueba SIEMPRE que el email coincide; si no coincide ninguno,
 * devolvemos null (y avisamos: significa que el filtro no está filtrando).
 */
/** Teléfono de un contacto crudo (campo phone_number, capturado en el checkout de pago). */
export function contactPhone(raw: RawContact | null | undefined): string {
  if (!raw) return "";
  const v = (raw.fields || []).find((f) => f.slug === "phone_number")?.value ?? "";
  return String(v || "");
}

export interface BuyerContact { id: number; email: string; phone: string; registeredAt: string; }

/** REGLA DE COMPRA · Lista los contactos que tienen una etiqueta (por nombre) CON su
 *  teléfono (phone_number). Sirve para el cruce periódico "quién ha comprado" → sacar del
 *  flujo. Devuelve [] si la etiqueta no existe. Pagina por cursor (ids crecientes). */
export async function listContactsWithTagAndPhone(tagName: string, maxPages = 20): Promise<BuyerContact[]> {
  const want = String(tagName || "").trim().toLowerCase();
  if (!want) return [];
  const tags = await listTags();
  const t = tags.find((x) => String(x.name || "").trim().toLowerCase() === want);
  if (!t) return [];
  const out: BuyerContact[] = [];
  let after = "";
  for (let i = 0; i < maxPages; i++) {
    const r = await apiGet<Record<string, unknown>>(
      `/contacts?tags=${t.id}&limit=100${after ? `&startingAfter=${encodeURIComponent(after)}` : ""}`,
    );
    const items = pickItems<RawContact>(r);
    for (const c of items) out.push({ id: c.id, email: String(c.email || ""), phone: contactPhone(c), registeredAt: String(c.registeredAt || "") });
    if (!(r as { hasMore?: boolean })?.hasMore || !items.length) break;
    after = String(items[items.length - 1]?.id ?? "");
    if (!after) break;
  }
  return out;
}

/** REGLA DE COMPRA (vía instantánea) · Por email, devuelve el teléfono (phone_number) y si
 *  tiene la etiqueta de compra. Se llama dentro de withPublicApiKey. */
export async function buyerInfoByEmail(email: string, tagName: string): Promise<{ found: boolean; hasTag: boolean; phone: string }> {
  const raw = await findContactByEmail(email);
  if (!raw) return { found: false, hasTag: false, phone: "" };
  const want = String(tagName || "").trim().toLowerCase();
  const hasTag = (raw.tags || []).some((t) => String(t?.name || "").trim().toLowerCase() === want);
  return { found: true, hasTag, phone: contactPhone(raw) };
}

export async function findContactByEmail(email: string): Promise<RawContact | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  const r = await apiGet<Record<string, unknown>>(
    `/contacts?email=${encodeURIComponent(target)}&limit=20`,
  );
  const members = pickItems<RawContact>(r);
  const hit = members.find((c) => String(c.email || "").trim().toLowerCase() === target);
  if (!hit && members.length) {
    console.warn(
      `[systemeio] el filtro ?email= no está filtrando (devolvió ${members.length} contactos y ninguno es ${target}). No asignamos nada.`,
    );
  }
  return hit ?? null;
}

/**
 * Como findContactByEmail, pero DISTINGUE "no se pudo consultar" (API caída / 429 /
 * timeout → apiGet devuelve null) de "consultado, sin ese contacto" (200 con lista
 * vacía). Lo usa el gate "¿Abrió el correo?" para NO tratar un fallo de red como
 * "no abrió" (que recordaría a quien SÍ abrió). reachable=false → resultado NO concluyente.
 */
export async function findContactByEmailResult(
  email: string,
): Promise<{ reachable: boolean; contact: RawContact | null }> {
  const target = email.trim().toLowerCase();
  if (!target) return { reachable: true, contact: null };
  const r = await apiGet<Record<string, unknown>>(
    `/contacts?email=${encodeURIComponent(target)}&limit=20`,
  );
  if (r == null) return { reachable: false, contact: null }; // apiGet null ⟺ no-OK/timeout
  const members = pickItems<RawContact>(r);
  const hit = members.find((c) => String(c.email || "").trim().toLowerCase() === target);
  return { reachable: true, contact: hit ?? null };
}

/** Id de una etiqueta por nombre (case-insensitive). La crea si no existe. */
/**
 * Devuelve el id de una etiqueta, creándola solo si se autoriza EXPRESAMENTE.
 *
 * `crear=false` devuelve 0 cuando la etiqueta no existe allí, y el llamante la salta sin
 * ruido. Es importante con planes limitados: systeme.io tope 10 etiquetas, y nosotros
 * mandamos TODAS las del contacto —incluidas las internas del panel («📍 Propuesta»,
 * «lead-instagram»)—. Si hubiera hueco, esas internas se colarían allí y se comerían el
 * cupo que el dueño reserva para las etiquetas que disparan sus campañas.
 */
/**
 * Campos personalizados definidos en la cuenta (GET /api/contact_fields).
 *
 * Son la clave para no quedarse sin etiquetas: en vez de UNA etiqueta y UNA regla por
 * cada lead magnet —que es lo que agota el plan—, se usa UNA sola regla y el contenido
 * concreto viaja en un campo del contacto, que el correo de la campaña inserta.
 */
export async function listContactFields(): Promise<Array<{ slug: string; name: string; type?: string }>> {
  const d = await apiGet<unknown>(`/contact_fields?limit=${clampLimit(100)}`);
  return pickItems<{ slug?: string; name?: string; fieldType?: string; type?: string }>(d).map((f) => ({
    slug: String(f.slug || ""),
    name: String(f.name || f.slug || ""),
    type: String(f.fieldType || f.type || ""),
  })).filter((f) => f.slug);
}

/** NEWSLETTER-1 · listTags que FALLA si la web no responde, en vez de devolver
 *  vacío. Para elegir la audiencia de un boletín, «no hay etiquetas» y «no se
 *  pudo leer la lista» no pueden parecerse: con la tolerante, una etiqueta
 *  EXCLUIDA se caía en silencio ante un 500 y el correo salía a quien no debía. */
export async function listTagsStrict(): Promise<PublicTag[]> {
  const out: PublicTag[] = [];
  let after = "";
  for (let i = 0; i < 20; i++) {
    const r = await apiGetStrict<Record<string, unknown>>(
      `/tags?limit=100${after ? `&startingAfter=${encodeURIComponent(after)}` : ""}`,
    );
    const items = pickItems<RawTag>(r);
    for (const t of items) out.push({ id: t.id, name: t.name });
    if (!r?.hasMore || !items.length) break;
    after = String(items[items.length - 1]?.id ?? "");
    if (!after) break;
  }
  return out;
}

export async function ensureTagId(name: string, crear = true): Promise<number> {
  const wanted = name.trim();
  if (!wanted) throw new Error("nombre de etiqueta vacío");
  // SIO-TRANSPORTE-1 · lista ESTRICTA: con la tolerante, un 500 se leía como
  // «no existe» y se creaba una etiqueta duplicada (o chocaba con el tope del plan).
  const existing = (await listTagsStrict()).find(
    (t) => t.name.trim().toLowerCase() === wanted.toLowerCase(),
  );
  if (existing) return existing.id;
  if (!crear) return 0; // no existe allí y no se autoriza crearla → se ignora
  const created = await apiSend<RawTag>("POST", "/tags", { name: wanted });
  if (!created?.id) throw new Error(`systeme.io no devolvió id al crear la etiqueta "${wanted}"`);
  return created.id;
}

/**
 * ASIGNA una etiqueta a un contacto: POST /api/contacts/{id}/tags {tagId}.
 *
 * Esta es LA pieza que faltaba. Hasta ahora el bridge solo llamaba a create-tag
 * (que crea la etiqueta suelta en la cuenta) y devolvía `tags_attempted` — la
 * etiqueta nunca llegaba a colgar del contacto, así que el trigger "asignar
 * etiqueta" de los workflows de systeme.io NO disparaba jamás.
 */
export async function assignTagToContact(contactId: number, tagId: number): Promise<void> {
  await apiSend<unknown>("POST", `/contacts/${contactId}/tags`, { tagId });
}

/** QUITA una etiqueta de un contacto: DELETE /api/contacts/{id}/tags/{tagId}.
 *  La pareja de assignTagToContact; juntas permiten RE-DISPARAR un workflow cuyo
 *  trigger es «etiqueta asignada» (quitar → volver a poner = evento nuevo). */
export async function removeTagFromContact(contactId: number, tagId: number): Promise<void> {
  await apiSend<unknown>("DELETE", `/contacts/${contactId}/tags/${tagId}`);
}

/**
 * Camino completo de un lead: localiza o crea el contacto por email y le ASIGNA
 * las etiquetas. Idempotente: si el contacto ya existe se reutiliza, y una
 * etiqueta que ya cuelga del contacto no se vuelve a asignar.
 *
 * Devuelve qué se asignó DE VERDAD y qué falló y por qué (nada de "attempted").
 */
/**
 * Completa nombre/campos de un contacto que YA existe en systeme.io.
 *
 * El nombre se parte igual que al crearlo (first_name + surname) para que un contacto
 * llegado por Instagram —donde el "nombre" es el @usuario— quede identificado igual
 * venga por donde venga.
 */
async function updateContactFields(
  contactId: number,
  name?: string,
  extra?: Record<string, string>,
): Promise<void> {
  const fields: Array<{ slug: string; value: string }> = [];
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts[0]) fields.push({ slug: "first_name", value: parts[0] });
    if (parts.length > 1) fields.push({ slug: "surname", value: parts.slice(1).join(" ") });
  }
  for (const [k, v] of Object.entries(extra || {})) fields.push({ slug: k, value: v });
  if (!fields.length) return;
  await apiSend("PATCH", `/contacts/${contactId}`, { fields });
}

export async function syncContactWithTags(
  email: string,
  data: { name?: string; tags?: string[]; fields?: Record<string, string>; primaryTag?: string },
): Promise<{
  contactId: number;
  created: boolean;
  tagsAssigned: string[];
  tagsAlready: string[];
  tagsSkipped: string[];
  tagsRetriggered: string[];
  tagErrors: Array<{ tag: string; error: string }>;
}> {
  const existing = await findContactByEmail(email);
  let contactId: number;
  let created = false;
  let currentTags: Array<{ id: number; name: string }> = [];
  if (existing) {
    contactId = existing.id;
    currentTags = existing.tags || [];
    // NOMBRE-EXISTENTE-1 · Si ya estaba en la lista, antes SOLO se le ponía la etiqueta
    // y el nombre se perdía. Alguien que ya era contacto (una newsletter antigua, por
    // ejemplo) y ahora llega por Instagram se quedaba sin su @usuario, que es
    // justamente lo que identifica de dónde vino. Se completa lo que falte.
    //
    // Solo se RELLENA lo vacío, nunca se pisa: si el contacto ya tiene nombre puesto a
    // mano o por otro embudo, ese manda.
    try {
      const yaTieneNombre = (existing.fields || []).some(
        (f) => /^(first_name|surname)$/.test(f.slug || "") && String(f.value || "").trim(),
      );
      // El NOMBRE solo se rellena si falta (no se pisa uno puesto a mano). Los CAMPOS,
      // en cambio, se escriben SIEMPRE: identifican que recurso ha pedido esta persona
      // AHORA, y quien vuelve a por un segundo lead magnet necesita el valor nuevo. Si
      // se conservara el viejo, el workflow le mandaria el correo del recurso anterior.
      const nombreAEscribir = data.name && !yaTieneNombre ? data.name : undefined;
      if (nombreAEscribir || (data.fields && Object.keys(data.fields).length)) {
        await updateContactFields(contactId, nombreAEscribir, data.fields);
      }
    } catch { /* que no se pueda completar el campo nunca impide asignar la etiqueta */ }
  } else {
    const r = await upsertContactPublicApi(email, { name: data.name, fields: data.fields });
    contactId = r.id;
    created = r.created;
  }
  if (!contactId) throw new Error("la web no devolvió el id del contacto");

  const have = new Set(currentTags.map((t) => t.name.trim().toLowerCase()));
  const tagsAssigned: string[] = [];
  const tagsAlready: string[] = [];
  const tagsSkipped: string[] = [];
  const tagsRetriggered: string[] = [];
  const tagErrors: Array<{ tag: string; error: string }> = [];
  // Solo se AUTORIZA crear la etiqueta que el dueño eligió en el paso del flujo (la que
  // dispara su campaña). Las demás son etiquetas internas del panel: se asignan si ya
  // existen allí, y si no, se ignoran en silencio. Antes se intentaba crearlas todas y
  // ensuciaba el resultado con errores de tope — o peor, habrían gastado su cupo.
  const creable = String(data.primaryTag || "").trim().toLowerCase();
  for (const raw of data.tags || []) {
    const tag = String(raw || "").trim();
    if (!tag) continue;
    if (have.has(tag.toLowerCase())) {
      // RE-DISPARO · Si es la etiqueta DISPARADORA (la que enciende el workflow de
      // systeme.io) y el contacto YA la tiene de un recurso anterior, dejarla como está
      // no genera ningún evento y el workflow no vuelve a arrancar: el lead que vuelve
      // a por un 2º recurso no recibía su correo, en silencio (visto en prod 2026-07-31).
      // Quitar → volver a poner produce un evento «etiqueta asignada» nuevo. El campo
      // identificador ya se escribió ANTES (arriba), así que ramifica al correo correcto.
      if (tag.toLowerCase() === creable) {
        try {
          const tagId =
            currentTags.find((t) => t.name.trim().toLowerCase() === tag.toLowerCase())?.id ||
            (await ensureTagId(tag, false));
          if (tagId) {
            await removeTagFromContact(contactId, tagId);
            // SIO-API-F5 · si volver a ponerla falla, el contacto se quedaría SIN la etiqueta
            // que ya tenía: se reintenta una vez antes de dar el error.
            try { await assignTagToContact(contactId, tagId); }
            catch { await assignTagToContact(contactId, tagId); }
            tagsRetriggered.push(tag);
            continue;
          }
        } catch (e) {
          tagErrors.push({ tag, error: ("re-disparo: " + ((e as Error).message || "error")).slice(0, 200) });
          continue;
        }
      }
      tagsAlready.push(tag);
      continue;
    }
    try {
      const tagId = await ensureTagId(tag, tag.toLowerCase() === creable);
      if (!tagId) { tagsSkipped.push(tag); continue; } // no existe allí y no toca crearla
      await assignTagToContact(contactId, tagId);
      tagsAssigned.push(tag);
    } catch (e) {
      tagErrors.push({ tag, error: ((e as Error).message || "error").slice(0, 200) });
    }
  }
  return { contactId, created, tagsAssigned, tagsAlready, tagsSkipped, tagsRetriggered, tagErrors };
}

/**
 * Sync de un lead vía API pública (alternativa al MCP bridge): crea/upsert.
 * Si el email ya existe, Systeme.io devuelve 422 con `existing_email`; lo
 * tratamos como éxito idempotente y devolvemos el id existente.
 *
 * OJO: POST /api/contacts NO acepta tags — asignarlas es SIEMPRE una 2ª llamada
 * (ver syncContactWithTags / assignTagToContact).
 */
export async function upsertContactPublicApi(
  email: string,
  data: { name?: string; tags?: string[]; fields?: Record<string, string> },
): Promise<{ id: number; created: boolean }> {
  const fields: Array<{ slug: string; value: string }> = [];
  if (data.name) {
    const parts = data.name.trim().split(/\s+/);
    if (parts[0]) fields.push({ slug: "first_name", value: parts[0] });
    if (parts.length > 1)
      fields.push({ slug: "surname", value: parts.slice(1).join(" ") });
  }
  for (const [k, v] of Object.entries(data.fields || {})) {
    fields.push({ slug: k, value: v });
  }
  const body = { email, fields, locale: "es" };
  try {
    const r = await apiSend<RawContact>("POST", "/contacts", body);
    return { id: r?.id ?? 0, created: true };
  } catch (e) {
    const msg = (e as Error).message || "";
    const m = msg.match(/already exist|existing_email|422/i);
    if (!m) throw e;
    // Idempotencia: buscamos el contacto existente (con verificación de email).
    const existing = await findContactByEmail(email);
    if (!existing) throw e;
    return { id: existing.id, created: false };
  }
}

/**
 * Métricas combinadas para la card de Conexiones. Calculado en paralelo
 * para minimizar latencia. Las métricas que requieren scraping (funnels,
 * sales, newsletters) se sirven desde el MCP bridge — no aquí.
 */
export interface PublicMetrics {
  ok: boolean;
  totalContacts: number;
  /** true = totalContacts se cortó en el tope de guarda del conteo por cursor
   *  (countAll max=5000): el total real es MAYOR — el render debe pintar '5.000+'. */
  contactsCapped: boolean;
  totalTags: number;
  totalCommunities: number;
  topTags: Array<{ id: number; name: string; count: number }>;
  recent: Array<{ email: string; name: string; at: string }>;
  error?: string;
}

export async function publicMetrics(): Promise<PublicMetrics> {
  const { apiKey } = creds();
  if (!apiKey) {
    return {
      ok: false,
      totalContacts: 0,
      contactsCapped: false,
      totalTags: 0,
      totalCommunities: 0,
      topTags: [],
      recent: [],
      error: "Sin API key configurada",
    };
  }
  try {
    const [contacts, tags, communities, last5] = await Promise.all([
      countContacts(),
      listTags(),
      listCommunities(),
      recentContacts(5),
    ]);
    // Top 5 tags por contacts count. Cada llamada es 1 HTTP; limitamos a las
    // 10 primeras tags por nombre para no quemar rate-limit con cuentas con
    // muchos tags.
    const tagSample = tags.slice(0, 10);
    const counts = await Promise.all(
      tagSample.map(async (t) => ({ ...t, count: await countContactsByTag(t.id).catch(() => -1) })),
    );
    const topTags = counts.filter((t) => t.count >= 0).sort((a, b) => b.count - a.count).slice(0, 5);
    return {
      ok: true,
      totalContacts: contacts.count,
      contactsCapped: contacts.capped,
      totalTags: tags.length,
      totalCommunities: communities.length,
      topTags,
      recent: last5.map((c) => ({
        email: c.email,
        name: [c.firstName, c.lastName].filter(Boolean).join(" "),
        at: c.registeredAt,
      })),
    };
  } catch (e) {
    return {
      ok: false,
      totalContacts: 0,
      contactsCapped: false,
      totalTags: 0,
      totalCommunities: 0,
      topTags: [],
      recent: [],
      error: (e as Error).message || "Error",
    };
  }
}

/**
 * SEC overload: ejecuta `publicMetrics()` con apiKey/baseUrl EXPLÍCITAS para
 * una cuenta concreta, sin mutar settings globales. Toda la cascada
 * (`countContacts` / `listTags` / `listCommunities` / `recentContacts` /
 * `countContactsByTag`) lee del ALS store vía `getApiKeyCreds()`.
 *
 * Esta es la API correcta para multi-cuenta: cada request pasa SU apiKey, sin
 * race condition con otras requests concurrentes (paralela a
 * `internalMetricsWithCreds` para la API interna).
 *
 * NOTA: `baseUrl` se acepta por simetría con `internalMetricsWithCreds`, pero
 * la API Pública oficial siempre vive en `api.systeme.io` (constante
 * `BASE_URL`) — el dominio del panel del user NO afecta. Se almacena en el
 * ALS por consistencia futura.
 */
export async function publicMetricsWithCreds(creds: {
  apiKey: string;
  baseUrl?: string;
}): Promise<PublicMetrics> {
  const baseUrl = (creds.baseUrl || BASE_URL).replace(/\/+$/, "");
  return publicCredsAls.run({ apiKey: creds.apiKey, baseUrl }, () =>
    publicMetrics(),
  );
}

// DIAG (solo lectura): GET crudo con status + cuerpo recortado — para sondear
// el comportamiento real de la API pública (p.ej. la paginación de /contacts
// parada el 23-jul-2026) sin adivinar desde apiGet, que se traga los errores.
export async function rawApiGet(path: string): Promise<{ status: number; body: unknown }> {
  const apiKey = creds().apiKey;
  if (!apiKey) return { status: 0, body: "sin apiKey en contexto" };
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "X-API-Key": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  let body: unknown = null;
  const text = await res.text().catch(() => "");
  try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
  // Recorte defensivo: items largos → solo los 3 primeros con campos clave.
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const k of ["items", "hydra:member"]) {
      if (Array.isArray(b[k])) {
        b[k] = (b[k] as Array<Record<string, unknown>>).slice(0, 3).map((c) => ({
          id: c.id, email: c.email, registeredAt: c.registeredAt,
          sourceURL: typeof c.sourceURL === "string" ? (c.sourceURL as string).slice(0, 80) : c.sourceURL,
        }));
      }
    }
  }
  return { status: res.status, body };
}

// ════════════════════════════════════════════════════════════════════════════
// CORREO-API-1 · Estadísticas de correo por la API OFICIAL (/api/mailing/statistics/*).
//
// Hasta aquí la pestaña Correo salía del puente (`get-email-stats-summary` +
// `list-emails-in-period`: dos tools serializadas sobre el navegador del
// systemeio-mcp). La API oficial lo da en HTTP puro:
//   · /mailing/statistics/{newsletters,automation-emails,campaign-steps}/summary
//        → {summary, byDay[]}  (dateFrom/dateTo obligatorios, AAAA-MM-DD)
//   · /mailing/statistics/{newsletters,automation-emails,campaign-steps}
//        → {items:[{newsletter|automationEmail|campaignStep:{id,content:{subject}}, statistics}], hasMore}
//
// Medido el 15-oct-2026 contra las dos cuentas reales con API, mismo periodo
// (15-sep → 15-oct) que el panel por el puente: a8f6bf4b 24.206 + 17 = 24.223
// enviados y 5d5bda96 1.129 + 92 = 1.221, idénticos al puente al número, y las
// filas de newsletter y de automatización coinciden una a una.
//
// DOS DIFERENCIAS REALES con el puente (no ocultarlas):
//   1. El `id` de una newsletter aquí (5438326) NO es el `mailingId` del puente
//      (13136539): son espacios de ids distintos para el mismo envío. En los
//      correos de automatización SÍ coinciden. El cruce con fichas por asunto
//      sigue valiendo; por id, solo para automatización.
//   2. La lista no trae fecha de envío; sale de GET /newsletters/{id}/schedule
//      (una llamada por newsletter, en paralelo). Sin ella queda `null`.
//
// FALSO-CERO-1: null = la API no contestó (el llamante cae al puente); nunca se
// devuelve «0 enviados» por no haber podido leer.
// ════════════════════════════════════════════════════════════════════════════
export interface CorreoApiEst {
  sentAmount?: number; openedAmount?: number; bouncedAmount?: number;
  spamReportAmount?: number; clickedAmount?: number;
  openedPercent?: number; clickedPercent?: number; bouncedPercent?: number;
}
export interface CorreoApiResumen { summary?: CorreoApiEst | null; byDay?: Array<{ date?: string; statistics?: CorreoApiEst | null }> | null }
export interface CorreoApiResultado {
  summary: {
    totalSent: number; openRatePct: number; bounceRatePct: number; spamRatePct: number; activeDays: number;
    bestDay: { date: string; sent: number; openedPct: number } | null;
    worstDay: { date: string; sent: number; openedPct: number } | null;
    byDay: Array<{ date: string; sent: number; openedPct: number; bouncedPct: number; spamPct: number }>;
  };
  emails: Array<{
    mailingId: number; subject: string; emailType: string; status: string; scheduledAt: string | null;
    sent: number; opened: number; clicked: number; bounced: number; spamReports: number;
    openRatePct: number; clickRatePct: number; clickThroughOpenRatePct: number; bounceRatePct: number;
  }>;
  emailsTruncated: boolean;
}

const c2 = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;

/** CORREO-API-2 (SIO-API-F7) · Agregados de UNA newsletter por su id de CATÁLOGO
 *  (GET /mailing/newsletters/{id}/statistics). Aquí no hay dos espacios de ids
 *  (STATS-ID-1): el id del catálogo vale tal cual. Medido el 29-oct-2026 en a8f6bf4b
 *  (5448315 → 2.205 enviados, 368 abiertos, 5 clics, igual que la lista). Sin
 *  destinatarios ni clics por enlace: la API no los da. null = no contestó. */
export async function estadisticasNewsletterApi(id: number | string): Promise<{
  sent: number; opened: number; clicked: number; bounced: number; spam: number;
  openRatePct: number; clickRatePct: number; bounceRatePct: number;
} | null> {
  const r = await apiGet<{ summary?: CorreoApiEst | null }>(`/mailing/newsletters/${encodeURIComponent(String(id))}/statistics`);
  const s = r?.summary;
  if (!s || s.sentAmount == null) return null;
  return {
    sent: Number(s.sentAmount) || 0, opened: Number(s.openedAmount) || 0, clicked: Number(s.clickedAmount) || 0,
    bounced: Number(s.bouncedAmount) || 0, spam: Number(s.spamReportAmount) || 0,
    openRatePct: c2(s.openedPercent), clickRatePct: c2(s.clickedPercent), bounceRatePct: c2(s.bouncedPercent),
  };
}

/** Suma los tres resúmenes (newsletters + automatización + campañas) en el mismo
 *  `summary` que daba el puente: tasas ponderadas por envíos, no medias simples.
 *  Función pura: se prueba con respuestas reales sin red. */
export function armarResumenCorreo(partes: CorreoApiResumen[]): CorreoApiResultado["summary"] {
  const tot = { sent: 0, op: 0, bo: 0, sp: 0 };
  const dias = new Map<string, { sent: number; op: number; bo: number; sp: number }>();
  for (const p of partes) {
    const s = p.summary || {};
    tot.sent += Number(s.sentAmount) || 0;
    tot.op += Number(s.openedAmount) || 0;
    tot.bo += Number(s.bouncedAmount) || 0;
    tot.sp += Number(s.spamReportAmount) || 0;
    for (const d of p.byDay || []) {
      const date = String(d.date || "").slice(0, 10);
      if (!date) continue;
      const st = d.statistics || {};
      const cur = dias.get(date) || { sent: 0, op: 0, bo: 0, sp: 0 };
      cur.sent += Number(st.sentAmount) || 0;
      cur.op += Number(st.openedAmount) || 0;
      cur.bo += Number(st.bouncedAmount) || 0;
      cur.sp += Number(st.spamReportAmount) || 0;
      dias.set(date, cur);
    }
  }
  const pct = (a: number, b: number): number => (b > 0 ? c2((a / b) * 100) : 0);
  const byDay = [...dias.entries()]
    .map(([date, v]) => ({ date, sent: v.sent, openedPct: pct(v.op, v.sent), bouncedPct: pct(v.bo, v.sent), spamPct: pct(v.sp, v.sent) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const activos = byDay.filter((d) => d.sent > 0);
  let best: (typeof byDay)[number] | null = null;
  let worst: (typeof byDay)[number] | null = null;
  for (const d of activos) {
    if (!best || d.openedPct > best.openedPct) best = d;
    if (!worst || d.openedPct < worst.openedPct) worst = d;
  }
  const dia = (d: (typeof byDay)[number] | null) => (d ? { date: d.date, sent: d.sent, openedPct: d.openedPct } : null);
  return {
    totalSent: tot.sent,
    openRatePct: pct(tot.op, tot.sent),
    bounceRatePct: pct(tot.bo, tot.sent),
    spamRatePct: pct(tot.sp, tot.sent),
    activeDays: activos.length,
    bestDay: dia(best),
    worstDay: dia(worst),
    byDay,
  };
}

type CorreoApiItem = Record<string, unknown>;

/** Una fila de la lista oficial → la fila que el panel ya sabe pintar. */
export function filaCorreoApi(it: CorreoApiItem, emailType: string, clave: string, scheduledAt: string | null): CorreoApiResultado["emails"][number] | null {
  const e = (it[clave] || null) as { id?: number; content?: { subject?: string | null } | null } | null;
  if (!e || !Number(e.id)) return null;
  const s = (it.statistics || {}) as CorreoApiEst;
  const sent = Number(s.sentAmount) || 0;
  const opened = Number(s.openedAmount) || 0;
  const clicked = Number(s.clickedAmount) || 0;
  return {
    mailingId: Number(e.id),
    subject: String(e.content?.subject ?? "(sin asunto)"),
    emailType,
    status: "active",
    scheduledAt,
    sent, opened, clicked,
    bounced: Number(s.bouncedAmount) || 0,
    spamReports: Number(s.spamReportAmount) || 0,
    openRatePct: c2(s.openedPercent),
    clickRatePct: c2(s.clickedPercent),
    clickThroughOpenRatePct: opened > 0 ? c2((clicked / opened) * 100) : 0,
    bounceRatePct: c2(s.bouncedPercent),
  };
}

const CORREO_TIPOS = [
  { ruta: "newsletters", clave: "newsletter", tipo: "newsletter" },
  { ruta: "automation-emails", clave: "automationEmail", tipo: "automation" },
  { ruta: "campaign-steps", clave: "campaignStep", tipo: "campaign" },
] as const;

/** Estadísticas de correo de la web de la clave activa (dentro de withPublicApiKey).
 *  dateFrom/dateTo: ISO con o sin hora; la API pide solo el día. null = no se pudo leer. */
export async function estadisticasCorreoApi(
  dateFrom: string,
  dateTo: string,
  opts: { max?: number } = {},
): Promise<CorreoApiResultado | null> {
  if (!creds().apiKey) return null;
  const q = `dateFrom=${encodeURIComponent(String(dateFrom).slice(0, 10))}&dateTo=${encodeURIComponent(String(dateTo).slice(0, 10))}`;
  const max = Math.max(10, Math.min(5000, Number(opts.max) || 100));
  const resumenes = await Promise.all(
    CORREO_TIPOS.map((t) => apiGet<CorreoApiResumen>(`/mailing/statistics/${t.ruta}/summary?${q}`)),
  );
  // Un resumen que falta dejaría el total corto sin avisar: se cae al puente entero.
  if (resumenes.some((r) => !r || !r.summary)) return null;

  type Fila = { it: CorreoApiItem; tipo: string; clave: string };
  const filas: Fila[] = [];
  let truncado = false;
  for (const t of CORREO_TIPOS) {
    let after = "";
    for (let pag = 0; pag < 60; pag++) {
      const r = await apiGet<{ items?: CorreoApiItem[]; hasMore?: boolean }>(
        `/mailing/statistics/${t.ruta}?${q}&limit=100&order=desc${after}`,
      );
      if (!r || !Array.isArray(r.items)) return null;
      for (const it of r.items) filas.push({ it, tipo: t.tipo, clave: t.clave });
      const ult = r.items.length ? (r.items[r.items.length - 1][t.clave] as { id?: number } | undefined) : undefined;
      if (!r.hasMore || !ult?.id) break;
      after = `&startingAfter=${encodeURIComponent(String(ult.id))}`;
      if (filas.length >= max) break;
    }
    if (filas.length >= max) { truncado = true; break; }
  }
  const recorte = filas.slice(0, max);
  if (filas.length > max) truncado = true;

  // Fecha de envío: solo las newsletters la tienen, en su propia ruta.
  const fechas = new Map<number, string | null>();
  const nls = recorte.filter((f) => f.tipo === "newsletter").map((f) => Number((f.it[f.clave] as { id?: number }).id));
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(8, nls.length) }, async () => {
    while (i < nls.length) {
      const id = nls[i++];
      fechas.set(id, await getNewsletterSchedule(id).catch(() => null));
    }
  }));

  const emails: CorreoApiResultado["emails"] = [];
  for (const f of recorte) {
    const id = Number((f.it[f.clave] as { id?: number } | undefined)?.id) || 0;
    const row = filaCorreoApi(f.it, f.tipo, f.clave, f.tipo === "newsletter" ? fechas.get(id) ?? null : null);
    if (row) emails.push(row);
  }
  return { summary: armarResumenCorreo(resumenes as CorreoApiResumen[]), emails, emailsTruncated: truncado };
}
