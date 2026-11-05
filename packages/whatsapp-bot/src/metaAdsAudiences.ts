/**
 * meta-ads-pro FASE A2 — Audience Builder (Marketing API).
 *
 * Gestion ws-aware de las audiencias guardadas + custom audiences + lookalikes
 * + busqueda de intereses para targeting. Toda la I/O Graph pasa por
 * `metaAdsGraph.ts` (retry expo 2x para 429+5xx, logActivity automatico de
 * fallos, bearer ws-aware via runWithAdsAccount ALS).
 *
 * Contrato comun de cada helper:
 *   - Recibe `adAccountId` opcional. Si se omite, usa el de creds() ws-aware
 *     (lo resuelve metaAds.ts vis token-resolver inyectado en metaAdsGraph).
 *   - Si no hay token o no hay adAccountId resoluble, devuelve
 *     `{ ok:false, error:"meta_ads_not_configured" }` sin tocar la red.
 *   - Cualquier fallo Graph (incl. permisos/token expirado) se TRAGAN aqui y se
 *     devuelven como `{ ok:false, error }` + se loguea en `app_activity_log`
 *     via `logActivity({ source:"meta-api", level:"error", ... })`. NUNCA
 *     incluimos el bearer en el payload (lo recordamos como `_redacted`).
 *
 * El cache de busqueda de intereses es per-ws + per-locale para que dos
 * workspaces (o el mismo en idiomas distintos) no compartan hits. Si en el
 * mismo proceso un panel cambia de WS, las entradas de otros WS siguen vivas
 * (no se cruzan) hasta TTL.
 */
import { graphGet, graphPost, graphDelete } from "./metaAdsGraph.js";
import { metaAdsAccountsList } from "./metaAds.js";
import { currentWorkspaceId } from "./workspace.js";
import { get as getSetting } from "./settings.js";
import { logActivity } from "./activity.js";

/**
 * Resultado uniforme de cada helper: { ok, data?, error? }. Permite que los
 * endpoints REST hagan un `if (!r.ok) return reply.code(400)` limpio.
 */
export interface AudiencesResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface SavedAudience {
  id: string;
  name: string;
  description?: string;
  runStatus?: string;
  approximatePeopleLowerBound?: number;
  approximatePeopleUpperBound?: number;
  timeCreated?: string;
  timeUpdated?: string;
}

export interface CustomAudience {
  id: string;
  name: string;
  description?: string;
  subtype: string;
  approximateCountLowerBound?: number;
  approximateCountUpperBound?: number;
  deliveryStatus?: { code?: number; description?: string };
  timeCreated?: string;
  timeUpdated?: string;
  operationStatus?: { code?: number; description?: string };
}

export interface InterestHit {
  id: string;
  name: string;
  audienceSizeLowerBound?: number;
  audienceSizeUpperBound?: number;
  path?: string[];
  topic?: string;
}

/**
 * SUBTYPE_LIST y RATIO_RANGE viven aqui para validar input y para que el panel
 * pueda renderizar el dropdown sin reinventar el contrato con Meta.
 *
 * - CUSTOM: audiencia desde fuente propia (subiremos users mas adelante).
 * - WEBSITE / APP / OFFLINE_CONVERSION: orientadas a pixel/eventos (no las
 *   creamos aqui — se crean al instalar el pixel; las listamos en read-only).
 * - LOOKALIKE: clones de un seed customaudience.
 * - ENGAGEMENT / VIDEO: agregan engagement de Instagram/Facebook (read-only en
 *   esta version; el operador las construye en Ads Manager).
 *
 * Para creacion via UI restringimos a CUSTOM + LOOKALIKE (LOOKALIKE va por
 * `createLookalikeAudience` que rellena los campos especificos).
 */
export const AUDIENCE_SUBTYPES = ["CUSTOM", "LOOKALIKE"] as const;
export type CreatableSubtype = (typeof AUDIENCE_SUBTYPES)[number];

/**
 * Lookalike: ratio en [0.01 .. 0.20]. La Marketing API acepta 0.01 a 0.20
 * (1% a 20%). El sweet spot tipico es 1-3%. Lo capamos para evitar errores.
 */
const LOOKALIKE_RATIO_MIN = 0.01;
const LOOKALIKE_RATIO_MAX = 0.2;

/**
 * Resuelve `act_X` desde el id explicito o desde el adAccountId activo en ALS.
 * Devuelve null si no hay nada utilizable (ningun ws conectado todavia).
 */
function actPath(adAccountId?: string): string | null {
  const id = String(adAccountId || "").trim() || getSetting("meta.adAccountId");
  if (!id) return null;
  // El caller ya pasa SIN prefijo (M2). Si llegara con `act_` lo limpiamos
  // para no construir `act_act_123`.
  const clean = id.startsWith("act_") ? id.slice(4) : id;
  return `act_${clean}`;
}

/**
 * Pre-flight: confirma que tenemos token Y adAccountId resoluble. Si no, no
 * llamamos a Graph (ahorra una request 4xx y un log de error innecesario).
 */
function preflight(adAccountId?: string): { ok: true; act: string } | { ok: false; error: string } {
  const token = getSetting("meta.adsToken");
  if (!token) return { ok: false, error: "meta_ads_not_configured" };
  const act = actPath(adAccountId);
  if (!act) return { ok: false, error: "meta_ads_account_missing" };
  return { ok: true, act };
}

// ---- Cache para searchInterests ---------------------------------------
//
// La busqueda de intereses dispara 1 request a Graph por keystroke + locale.
// Sin cache, un buscador con debounce 300ms igual se va a 5-10 calls por
// session. Cache 60s por { wsId, query, locale } reduce a 1 hit por combinacion
// y se autorefresca cuando el operador prueba algo distinto.

const SEARCH_CACHE_TTL_MS = 60_000;
interface CacheEntry {
  ts: number;
  hits: InterestHit[];
}
const searchCache = new Map<string, CacheEntry>();
const SEARCH_CACHE_MAX = 500;

function searchCacheKey(wsId: string, query: string, locale: string): string {
  return `${wsId}::${locale}::${query.trim().toLowerCase()}`;
}

function searchCacheGet(key: string): InterestHit[] | null {
  const e = searchCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts >= SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return e.hits;
}

function searchCacheSet(key: string, hits: InterestHit[]): void {
  // Capamos el cache a SEARCH_CACHE_MAX entradas. Cuando se llena, soltamos la
  // mas vieja (sweep oportunista — barato, no se ejecuta en cada set).
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of searchCache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { ts: Date.now(), hits });
}

// ---- listSavedAudiences ------------------------------------------------

/**
 * Audiencias guardadas (saved_audiences): segmentaciones reutilizables creadas
 * por el operador en Ads Manager. SOLO LECTURA — la creacion vive en Ads
 * Manager porque el JSON de targeting es enorme y prefiere builders graficos.
 *
 * Aqui las listamos para que el panel pueda mostrarlas como "preset" cuando
 * el operador crea un adset.
 */
export async function listSavedAudiences(
  adAccountId?: string,
): Promise<AudiencesResult<SavedAudience[]>> {
  const p = preflight(adAccountId);
  if (!p.ok) return { ok: false, error: p.error };
  const fields = [
    "id",
    "name",
    "description",
    "run_status",
    "approximate_count_lower_bound",
    "approximate_count_upper_bound",
    "time_created",
    "time_updated",
  ].join(",");
  const r = await graphGet<{ data?: any[] }>(`${p.act}/saved_audiences`, {
    fields,
    limit: 200,
  });
  if (!r.ok) {
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `audiences:saved list failed — ${r.error}`.slice(0, 200),
      payload: { adAccountId: adAccountId || null, status: r.status, _redacted: ["access_token"] },
    });
    return { ok: false, error: r.error || "graph error" };
  }
  const rows = Array.isArray(r.data?.data) ? r.data!.data! : [];
  const out: SavedAudience[] = rows.map((a) => ({
    id: String(a.id),
    name: String(a.name || ""),
    description: a.description ? String(a.description) : undefined,
    runStatus: a.run_status ? String(a.run_status) : undefined,
    approximatePeopleLowerBound:
      a.approximate_count_lower_bound != null ? Number(a.approximate_count_lower_bound) : undefined,
    approximatePeopleUpperBound:
      a.approximate_count_upper_bound != null ? Number(a.approximate_count_upper_bound) : undefined,
    timeCreated: a.time_created ? String(a.time_created) : undefined,
    timeUpdated: a.time_updated ? String(a.time_updated) : undefined,
  }));
  return { ok: true, data: out };
}

// ---- listCustomAudiences -----------------------------------------------

/**
 * Custom audiences propias de la cuenta. Cubre TODOS los subtypes (CUSTOM,
 * WEBSITE, LOOKALIKE, etc.) — la UI las filtra/agrupa.
 *
 * approximate_count_* viene en buckets para evitar fingerprinting (Meta
 * Privacy). delivery_status nos dice si la audiencia esta lista para usarse en
 * un adset; operation_status si una operacion async (subida de users) sigue
 * corriendo.
 */
export async function listCustomAudiences(
  adAccountId?: string,
): Promise<AudiencesResult<CustomAudience[]>> {
  const p = preflight(adAccountId);
  if (!p.ok) return { ok: false, error: p.error };
  const fields = [
    "id",
    "name",
    "description",
    "subtype",
    "approximate_count_lower_bound",
    "approximate_count_upper_bound",
    "delivery_status",
    "operation_status",
    "time_created",
    "time_updated",
  ].join(",");
  // METRICAS-1 · Meta pagina: con más de 200 audiencias, las demás no se veían. Hasta 5 páginas.
  const r = await graphGet<{ data?: any[]; paging?: { cursors?: { after?: string }; next?: string } }>(`${p.act}/customaudiences`, {
    fields,
    limit: 200,
  });
  const todas: any[] = Array.isArray(r.data?.data) ? [...r.data!.data!] : [];
  let sig = r.ok && r.data?.paging?.next ? r.data.paging.cursors?.after : undefined;
  for (let pag = 1; sig && pag < 5; pag++) {
    const rp = await graphGet<{ data?: any[]; paging?: { cursors?: { after?: string }; next?: string } }>(`${p.act}/customaudiences`, {
      fields,
      limit: 200,
      after: sig,
    });
    if (!rp.ok) break; // la primera página ya vale: no se tira por un fallo en la siguiente
    if (Array.isArray(rp.data?.data)) todas.push(...rp.data!.data!);
    sig = rp.data?.paging?.next ? rp.data.paging.cursors?.after : undefined;
  }
  if (!r.ok) {
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `audiences:custom list failed — ${r.error}`.slice(0, 200),
      payload: { adAccountId: adAccountId || null, status: r.status, _redacted: ["access_token"] },
    });
    return { ok: false, error: r.error || "graph error" };
  }
  const rows = todas;
  const out: CustomAudience[] = rows.map((a) => ({
    id: String(a.id),
    name: String(a.name || ""),
    description: a.description ? String(a.description) : undefined,
    subtype: String(a.subtype || "CUSTOM"),
    approximateCountLowerBound:
      a.approximate_count_lower_bound != null ? Number(a.approximate_count_lower_bound) : undefined,
    approximateCountUpperBound:
      a.approximate_count_upper_bound != null ? Number(a.approximate_count_upper_bound) : undefined,
    deliveryStatus: a.delivery_status ?? undefined,
    operationStatus: a.operation_status ?? undefined,
    timeCreated: a.time_created ? String(a.time_created) : undefined,
    timeUpdated: a.time_updated ? String(a.time_updated) : undefined,
  }));
  return { ok: true, data: out };
}

// ---- createCustomAudience ---------------------------------------------

/**
 * Crea una custom audience vacia (sin users todavia). El alta de users (hash
 * SHA-256 de email/phone) se hace en un endpoint dedicado en una fase
 * posterior — esto solo cubre el contenedor.
 *
 * Reglas Meta:
 *   - `name` requerido (max 255 chars).
 *   - `subtype` debe ser uno de los validos. Filtramos a CUSTOM/LOOKALIKE
 *     (LOOKALIKE se crea via `createLookalikeAudience`, no aqui).
 *   - `customer_file_source` es obligatorio para subtype CUSTOM cuando vas a
 *     subir users. Lo dejamos en `USER_PROVIDED_ONLY` por defecto (la opcion
 *     mas restrictiva — el operador subio los datos manualmente).
 */
export async function createCustomAudience(input: {
  name: string;
  subtype: CreatableSubtype;
  description?: string;
  adAccountId?: string;
}): Promise<AudiencesResult<{ id: string }>> {
  const p = preflight(input.adAccountId);
  if (!p.ok) return { ok: false, error: p.error };

  const name = String(input.name || "").trim();
  if (!name) return { ok: false, error: "name_required" };
  if (name.length > 255) return { ok: false, error: "name_too_long" };

  if (!AUDIENCE_SUBTYPES.includes(input.subtype)) {
    return { ok: false, error: "subtype_invalid" };
  }
  // LOOKALIKE tiene su propio helper porque exige campos extra; aqui solo
  // CUSTOM.
  if (input.subtype !== "CUSTOM") {
    return { ok: false, error: "use_create_lookalike_for_lookalike_subtype" };
  }

  const body: Record<string, unknown> = {
    name,
    subtype: "CUSTOM",
    customer_file_source: "USER_PROVIDED_ONLY",
  };
  if (input.description) body.description = String(input.description).slice(0, 1024);

  const r = await graphPost<{ id?: string }>(`${p.act}/customaudiences`, body);
  if (!r.ok) {
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `audiences:custom create failed — ${r.error}`.slice(0, 200),
      payload: {
        adAccountId: input.adAccountId || null,
        name: name.slice(0, 120),
        subtype: "CUSTOM",
        status: r.status,
        _redacted: ["access_token"],
      },
    });
    return { ok: false, error: r.error || "graph error" };
  }
  return { ok: true, data: { id: String(r.data?.id || "") } };
}

// ---- createLookalikeAudience ------------------------------------------

/**
 * Crea una lookalike a partir de una customaudience seed. La Marketing API
 * usa el mismo endpoint /customaudiences con subtype=LOOKALIKE y un
 * `lookalike_spec` JSON con la seed + pais + ratio.
 *
 * Reglas:
 *   - `sourceAudienceId` es el id de la seed (debe pertenecer a la misma
 *     cuenta publicitaria — Meta lo valida).
 *   - `country` ISO-2 (ES, MX, US, ...).
 *   - `ratio` entre 0.01 y 0.20 (lo capamos).
 *
 * El nombre se genera auto a partir de la seed para que el operador no tenga
 * que escribir uno; el panel lo puede editar tras crearla.
 */
export async function createLookalikeAudience(input: {
  sourceAudienceId: string;
  country: string;
  ratio: number;
  name?: string;
  adAccountId?: string;
}): Promise<AudiencesResult<{ id: string }>> {
  const p = preflight(input.adAccountId);
  if (!p.ok) return { ok: false, error: p.error };

  const seed = String(input.sourceAudienceId || "").trim();
  if (!seed) return { ok: false, error: "sourceAudienceId_required" };
  const country = String(input.country || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, error: "country_iso2_required" };
  let ratio = Number(input.ratio);
  if (!Number.isFinite(ratio)) return { ok: false, error: "ratio_invalid" };
  if (ratio > 1) ratio = ratio / 100; // si llega 3 (3%), normalizamos a 0.03
  if (ratio < LOOKALIKE_RATIO_MIN) ratio = LOOKALIKE_RATIO_MIN;
  if (ratio > LOOKALIKE_RATIO_MAX) ratio = LOOKALIKE_RATIO_MAX;

  const autoName =
    input.name && input.name.trim()
      ? input.name.trim()
      : `Lookalike ${country} ${Math.round(ratio * 100)}% — seed ${seed.slice(-6)}`;

  const body: Record<string, unknown> = {
    name: autoName.slice(0, 255),
    subtype: "LOOKALIKE",
    origin_audience_id: seed,
    lookalike_spec: JSON.stringify({
      type: "similarity",
      country,
      ratio,
    }),
  };

  const r = await graphPost<{ id?: string }>(`${p.act}/customaudiences`, body);
  if (!r.ok) {
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `audiences:lookalike create failed — ${r.error}`.slice(0, 200),
      payload: {
        adAccountId: input.adAccountId || null,
        sourceAudienceId: seed,
        country,
        ratio,
        status: r.status,
        _redacted: ["access_token"],
      },
    });
    return { ok: false, error: r.error || "graph error" };
  }
  return { ok: true, data: { id: String(r.data?.id || "") } };
}

// ---- searchInterests ---------------------------------------------------

/**
 * Busqueda de intereses para targeting. Endpoint Graph: /search?type=adinterest.
 * Devuelve hits con id + name + estimacion de tamano de audiencia.
 *
 * Cache 60s per (wsId, query, locale). Si el query esta vacio (<2 chars), no
 * llamamos a Graph — devolvemos lista vacia. Si el cache responde, no llama
 * a Graph; si no, llama y guarda.
 */
export async function searchInterests(
  query: string,
  locale = "es_ES",
): Promise<AudiencesResult<InterestHit[]>> {
  const q = String(query || "").trim();
  if (q.length < 2) return { ok: true, data: [] };
  // Token es lo unico imprescindible para /search (no requiere act_X).
  const token = getSetting("meta.adsToken");
  if (!token) return { ok: false, error: "meta_ads_not_configured" };

  const wsId = currentWorkspaceId();
  const loc = String(locale || "es_ES").trim() || "es_ES";
  const key = searchCacheKey(wsId, q, loc);
  const cached = searchCacheGet(key);
  if (cached) return { ok: true, data: cached };

  const r = await graphGet<{ data?: any[] }>("search", {
    type: "adinterest",
    q,
    locale: loc,
    limit: 25,
  });
  if (!r.ok) {
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `audiences:interests search failed — ${r.error}`.slice(0, 200),
      payload: {
        query: q.slice(0, 120),
        locale: loc,
        status: r.status,
        _redacted: ["access_token"],
      },
    });
    return { ok: false, error: r.error || "graph error" };
  }
  const rows = Array.isArray(r.data?.data) ? r.data!.data! : [];
  const hits: InterestHit[] = rows.map((a) => ({
    id: String(a.id),
    name: String(a.name || ""),
    audienceSizeLowerBound:
      a.audience_size_lower_bound != null
        ? Number(a.audience_size_lower_bound)
        : a.audience_size != null
          ? Number(a.audience_size)
          : undefined,
    audienceSizeUpperBound:
      a.audience_size_upper_bound != null ? Number(a.audience_size_upper_bound) : undefined,
    path: Array.isArray(a.path) ? a.path.map(String) : undefined,
    topic: a.topic ? String(a.topic) : undefined,
  }));
  searchCacheSet(key, hits);
  return { ok: true, data: hits };
}

// ---- deleteCustomAudience ---------------------------------------------

/**
 * Borra una custom audience. Validamos ANTES que pertenezca a la cuenta del
 * adAccountId activo: listamos custom audiences y buscamos el id. Si no esta,
 * devolvemos `audience_not_owned` (no lanzamos DELETE a Graph — un atacante
 * con id ajeno no debe poder probar si existe).
 *
 * IMPORTANTE: el caller (endpoint REST en admin.ts) ya hace ownership check a
 * nivel de adAccountId (debe pertenecer al WS). Esto es el segundo cinturon a
 * nivel de "esta audiencia pertenece A ESTA cuenta".
 */
export async function deleteCustomAudience(
  audienceId: string,
  adAccountId?: string,
): Promise<AudiencesResult<{ removed: boolean }>> {
  const p = preflight(adAccountId);
  if (!p.ok) return { ok: false, error: p.error };
  const id = String(audienceId || "").trim();
  if (!id) return { ok: false, error: "audienceId_required" };

  // Ownership: la audiencia debe estar en la lista de la cuenta. Si Meta no
  // la devuelve (ya borrada, o id ajeno), respondemos como si no existiera.
  const list = await listCustomAudiences(adAccountId);
  if (!list.ok) return { ok: false, error: list.error };
  const found = (list.data || []).find((a) => a.id === id);
  if (!found) return { ok: false, error: "audience_not_owned" };

  const r = await graphDelete<{ success?: boolean }>(id);
  if (!r.ok) {
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `audiences:custom delete failed — ${r.error}`.slice(0, 200),
      payload: {
        adAccountId: adAccountId || null,
        audienceId: id,
        status: r.status,
        _redacted: ["access_token"],
      },
    });
    return { ok: false, error: r.error || "graph error" };
  }
  return { ok: true, data: { removed: true } };
}

// ---- Helper de ownership para los endpoints REST ----------------------

/**
 * Valida que un adAccountId pertenezca al workspace activo. Es exactamente lo
 * que hace `/admin/api/analytics/:seg` con el segmento ads (SEC: act_id no
 * propietario del WS devuelve 403). Lo exportamos aqui para que los 6
 * endpoints de audiences hagan el mismo check sin duplicar logica.
 */
export function adAccountBelongsToWorkspace(adAccountId: string): boolean {
  const id = String(adAccountId || "").trim();
  if (!id) return false;
  const entries = metaAdsAccountsList();
  return entries.some((a) => a.adAccountId === id);
}

// ---- Test seam ---------------------------------------------------------

/** Solo para tests: limpiar el cache de search. NO usar desde produccion. */
export const __internal = {
  searchCache,
  SEARCH_CACHE_TTL_MS,
  clearSearchCache(): void {
    searchCache.clear();
  },
};
