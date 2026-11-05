/**
 * Conector Meta Ads (Marketing API, solo lectura). Resumen de la cuenta y
 * por campaña en los últimos 30 días: gasto, impresiones, clics, CTR, CPC,
 * leads/compras, coste por resultado y ROAS cuando hay valor de conversión.
 *
 * Token: meta.adsToken (System User con permiso `ads_read`). Cuenta:
 * meta.adAccountId (sin el prefijo act_). Cada llamada va aislada y degrada
 * con elegancia (nunca lanza).
 *
 * M2 — Multi-cuenta: meta.adsAccounts (JSON cifrado per-WS) lista TODAS las
 * cuentas publicitarias propiedad del operador. Cada request del panel puede
 * pedir una cuenta concreta vía ALS (runWithAdsAccount): el override gana
 * sobre lo persistido en meta.adAccountId. Si no hay override, usamos el
 * legacy single-account para no romper schedulers/back-ends antiguos.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { get, getWorkspaceSetting } from "./settings.js";
import { quickReply } from "./brain.js";
import { graphGet, _setTokenResolver } from "./metaAdsGraph.js";

/** Entrada per-WS en meta.adsAccounts. `adAccountId` SIN prefijo act_. */
export interface MetaAdsAccountEntry {
  adAccountId: string;
  adAccountName: string;
  currency: string;
  businessId?: string;
  label?: string;
  /** Token específico de la cuenta si se conectó con un OAuth distinto al del primary. */
  token?: string;
  addedAt?: number;
}

/** Override per-request del adAccountId activo (cuando el operador escoge cuenta en el panel). */
type AdsOverride = { adAccountId: string; token?: string };
const adsAccALS = new AsyncLocalStorage<AdsOverride>();

/** Ejecuta `fn` con un adAccountId concreto como contexto activo. */
export function runWithAdsAccount<T>(o: AdsOverride, fn: () => Promise<T>): Promise<T> {
  return adsAccALS.run(o, fn);
}

function creds(): { token: string; acc: string } {
  const ov = adsAccALS.getStore();
  if (ov && ov.adAccountId) {
    return { token: ov.token || get("meta.adsToken"), acc: ov.adAccountId };
  }
  return { token: get("meta.adsToken"), acc: get("meta.adAccountId") };
}

/**
 * adAccountId efectivo del request (override ALS de runWithAdsAccount →
 * meta.adAccountId de settings). FIX id78: la caché de segAds necesita esta
 * cuenta en su clave — sin ella, el selector multi-cuenta del panel servía
 * gasto/leads/ROAS de la cuenta A bajo la cuenta B.
 */
export function activeAdsAccountId(): string {
  return creds().acc || "";
}

// Cablea metaAdsGraph al creds() ws-aware: cualquier graphGet/graphPost que
// no pase opts.token resolverá el bearer respetando runWithAdsAccount ALS
// (override per-request) + meta.adsToken per-WS (settings). Sin esto, los
// nuevos módulos (audiences/creatives/etc.) tendrían que reimportar creds().
_setTokenResolver(() => creds().token);

/**
 * Lista de cuentas Meta Ads del workspace. Cascada:
 *   1) meta.adsAccounts (JSON array, per-WS, M2) → parseado.
 *   2) Si vacío Y existe meta.adAccountId legacy → sintetizamos UNA entry con
 *      lo mínimo (acc id + token). Mantiene backwards-compat con instalaciones
 *      pre-M2 que solo conectaron 1 cuenta vía OAuth.
 * Si `wsId` se omite, usa el wsId activo (ALS).
 */
export function metaAdsAccountsList(wsId?: string): MetaAdsAccountEntry[] {
  const raw = wsId ? getWorkspaceSetting(wsId, "meta.adsAccounts", "") : get("meta.adsAccounts");
  let arr: MetaAdsAccountEntry[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        arr = parsed
          .map((a: any): MetaAdsAccountEntry | null => {
            const id = String(a?.adAccountId || a?.id || "").trim();
            if (!id) return null;
            return {
              adAccountId: id,
              adAccountName: String(a?.adAccountName || a?.name || id),
              currency: String(a?.currency || ""),
              businessId: a?.businessId ? String(a.businessId) : undefined,
              label: a?.label ? String(a.label) : undefined,
              token: a?.token ? String(a.token) : undefined,
              addedAt: typeof a?.addedAt === "number" ? a.addedAt : undefined,
            };
          })
          .filter((x): x is MetaAdsAccountEntry => x !== null);
      }
    } catch {
      arr = [];
    }
  }
  if (arr.length) return arr;
  // Fallback retro-compat: si no hay meta.adsAccounts pero el legacy single-account
  // sí está, sintetizamos UNA entry. Así el selector multi-cuenta sigue mostrando
  // algo útil incluso en cuentas pre-M2 que nunca se han re-conectado.
  const legacyId = wsId ? getWorkspaceSetting(wsId, "meta.adAccountId", "") : get("meta.adAccountId");
  if (legacyId) {
    // meta.adAccounts (con S minúscula, legacy del flow OAuth) puede tener el
    // nombre/currency aunque adsAccounts no exista todavía. Lo aprovechamos.
    let legacyName = legacyId;
    let legacyCurrency = "";
    const legacyAccountsRaw = wsId
      ? getWorkspaceSetting(wsId, "meta.adAccounts", "")
      : get("meta.adAccounts");
    if (legacyAccountsRaw) {
      try {
        const legacy = JSON.parse(legacyAccountsRaw);
        if (Array.isArray(legacy)) {
          const hit = legacy.find((a: any) => String(a?.id || "") === legacyId);
          if (hit) {
            legacyName = String(hit.name || legacyId);
            legacyCurrency = String(hit.currency || "");
          }
        }
      } catch {
        /* legacy mal formado → ignoramos */
      }
    }
    return [{
      adAccountId: legacyId,
      adAccountName: legacyName,
      currency: legacyCurrency,
      label: legacyName,
    }];
  }
  return [];
}

/**
 * Adapter ligero: mantiene el contrato `_error` que ya usaban los callers de
 * este módulo (adsSummary) y delega en el graphGet compartido (retry + log
 * + ws-aware token via _setTokenResolver). Así no tenemos que reescribir el
 * shape de cada respuesta + check de error en los call-sites de abajo.
 */
async function g(path: string): Promise<any> {
  const r = await graphGet<any>(path);
  if (!r.ok) return { _error: r.error || "graph error" };
  return r.data ?? {};
}

/**
 * FIX id103: valor de UN action_type exacto en una fila de insights, o null si
 * no aparece. Base de toda selección canónica: en la Graph API los agregados
 * («lead», «omni_purchase») conviven en el MISMO array con sus subtipos
 * (lead_grouped, fb_pixel_lead, fb_pixel_purchase…) — sumar agregado + subtipos
 * contaba cada lead ~2x y cada compra hasta 3x. NUNCA matchear por prefijos.
 */
export function pickAction(rows: any[], type: string): number | null {
  let n = 0;
  let found = false;
  for (const a of rows ?? []) {
    if (a?.action_type === type) { found = true; n += Number(a.value) || 0; }
  }
  return found ? n : null;
}

/**
 * Leads SIN duplicar: la fila agregada `lead` si existe; si no, suma de los
 * subtipos onsite (lead_grouped) + offsite (fb_pixel_lead), que son disjuntos.
 * `onsite_conversion.messaging_conversation_started_7d` (conversaciones de
 * WhatsApp/Messenger iniciadas) NO es un lead: se expone aparte como
 * conversationsStarted, nunca bajo la etiqueta «Leads».
 */
export function pickLeadCount(actions: any[]): number {
  const agg = pickAction(actions, "lead");
  if (agg != null) return agg;
  return (
    (pickAction(actions, "onsite_conversion.lead_grouped") ?? 0) +
    (pickAction(actions, "offsite_conversion.fb_pixel_lead") ?? 0)
  );
}

/**
 * Compras SIN duplicar: la Graph API devuelve para LA MISMA compra el agregado
 * (omni_purchase) Y sus subtipos (purchase, fb_pixel_purchase) — sumarlos
 * infla revenue/ROAS hasta 3x. Se toma SOLO el primer action_type presente en
 * este orden de prioridad, nunca la suma de los tres.
 */
const PURCHASE_PRIORITY = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];

function pickPurchase(rows: any[]): number {
  for (const t of PURCHASE_PRIORITY) {
    const n = pickAction(rows, t);
    if (n != null) return n;
  }
  return 0;
}

/** Valor de conversiones de compra de una fila de insights (`action_values`). */
export function pickPurchaseValue(actionValues: any[]): number {
  return pickPurchase(actionValues);
}

/** Gemelo de conteo: nº de compras de una fila de insights (`actions`). */
export function pickPurchaseCount(actions: any[]): number {
  return pickPurchase(actions);
}

export interface AdsSummary {
  configured: boolean;
  note?: string;
  account?: string;
  currency?: string;
  spend?: number;
  impressions?: number;
  clicks?: number;
  ctr?: number;
  cpc?: number;
  reach?: number;
  leads?: number;
  /** Conversaciones de WhatsApp/Messenger iniciadas por anuncios
   *  (onsite_conversion.messaging_conversation_started_7d). NO son leads:
   *  antes se sumaban bajo la etiqueta «Leads» (FIX id103). */
  conversationsStarted?: number;
  purchases?: number;
  revenue?: number;
  // FIX: null cuando denominador 0 (leads=0 → cpl null; revenue=0 → roas null).
  // Memoria "never fake metrics": no afirmar CPL=0 cuando no hay leads.
  cpl?: number | null;
  roas?: number | null;
  /** Serie diaria del rango (time_increment=1): gasto y clics por día. */
  daily?: Array<{ date: string; spend: number; clicks: number }>;
  datePreset?: string;
  campaigns?: AdsCampaign[];
  /** true si la cuenta tiene más campañas que las devueltas (quedaba paging.next
   *  tras el tope de paginación de 10 páginas / 500 campañas): el cliente debe
   *  etiquetar la lista como top parcial por gasto, no como total. */
  campaignsTruncated?: boolean;
}

export interface AdsCampaign {
  id?: string;
  name: string;
  status: string;
  objective?: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number;       // %
  cpc: number;       // coste por clic
  cpm: number;       // coste por mil impresiones
  leads: number;
  purchases: number;
  revenue: number;
  cpl: number | null;
  roas: number | null;
}

const VALID_PRESETS = new Set(["today", "yesterday", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "this_month", "last_month"]);

/** Traduce el nº de días del selector del panel al date_preset de la Marketing API. */
export function daysToPreset(days?: number): string {
  const d = Number(days) || 30;
  if (d <= 1) return "today";
  if (d <= 7) return "last_7d";
  if (d <= 14) return "last_14d";
  // FIX id104: el preset «Últimos 28 días» del date-picker caía al bucket de 30
  // → la pestaña Ads mostraba 30 días de gasto/leads bajo un toolbar que
  // prometía 28 (~7% de gasto de más). Meta soporta date_preset=last_28d.
  if (d <= 28) return "last_28d";
  if (d <= 30) return "last_30d";
  return "last_90d";
}

/** Rango temporal para la Marketing API: o un preset, o fechas explícitas YYYY-MM-DD. */
export type AdsRange = string | { since: string; until: string };

/** Construye los fragmentos de query para el rango: el param top-level de /insights
 *  y el modificador del field-expansion anidado en /campaigns. Con fechas explícitas
 *  usamos time_range (sin tope de 90 días que tiene daysToPreset). */
function rangeFragments(range: AdsRange): { top: string; nested: string; label: string } {
  if (typeof range === "object" && range.since && range.until) {
    const tr = `{'since':'${range.since}','until':'${range.until}'}`;
    return {
      top: `time_range=${encodeURIComponent(JSON.stringify({ since: range.since, until: range.until }))}`,
      nested: `time_range(${tr})`,
      label: `${range.since} → ${range.until}`,
    };
  }
  const preset = typeof range === "string" && VALID_PRESETS.has(range) ? range : "last_30d";
  return { top: `date_preset=${preset}`, nested: `date_preset(${preset})`, label: preset };
}

export async function adsSummary(range: AdsRange = "last_30d"): Promise<AdsSummary> {
  const rf = rangeFragments(range);
  const { token, acc } = creds();
  if (!token || !acc)
    return {
      configured: false,
      note: "Conecta Meta Ads para ver tus campañas aquí.",
    };

  const info = await g(`act_${acc}?fields=name,currency,account_status`);
  if (info?._error)
    return { configured: false, note: `Meta Ads: ${info._error}` };

  const ins = await g(
    `act_${acc}/insights?fields=spend,impressions,clicks,ctr,cpc,cpm,reach,actions,action_values&${rf.top}`,
  );
  // Un fallo aquí antes se tragaba en silencio y salía "gasto 0" como dato real
  // (y con la caché del panel se quedaba pintado minutos). Error explícito.
  if (ins?._error) return { configured: false, note: `Meta Ads: ${ins._error}` };
  const row = ins?.data?.[0] ?? {};
  // FIX id103: selección canónica (fila `lead` o suma de subtipos disjuntos),
  // nunca agregado + subtipos. Las conversaciones WA iniciadas van aparte.
  const leads = pickLeadCount(row.actions);
  // Serie DIARIA de gasto/clics (una sola llamada extra, cae bajo el mismo memo).
  // Best-effort: si Meta la niega, el resto del resumen sigue íntegro.
  let daily: Array<{ date: string; spend: number; clicks: number }> = [];
  try {
    // METRICAS-1 · limit=400: una fila por día y la página por defecto de la Graph API es de 25, así
    // que un rango de 28/30/90 días perdía días sin aviso. 400 cubre el máximo de 365.
    const dins = await g(`act_${acc}/insights?fields=spend,clicks&time_increment=1&limit=400&${rf.top}`);
    if (Array.isArray(dins?.data)) daily = dins.data.map((x: any) => ({ date: String(x.date_start || ""), spend: Number(x.spend) || 0, clicks: Number(x.clicks) || 0 }));
  } catch { /* la serie es un extra */ }
  const conversationsStarted =
    pickAction(row.actions, "onsite_conversion.messaging_conversation_started_7d") ?? 0;
  // Compras/revenue con pickPurchase*: agregado O subtipo, nunca la suma.
  const purchases = pickPurchaseCount(row.actions);
  const revenue = pickPurchaseValue(row.action_values);
  const spend = Number(row.spend) || 0;

  // Por campaña, ahora con métricas completas (no solo gasto/clics): impresiones,
  // alcance, CTR, CPC, CPM, leads, compras, ingresos, CPL y ROAS.
  const campFields = `name,status,objective,insights.${rf.nested}{spend,impressions,clicks,ctr,cpc,cpm,reach,actions,action_values}`;
  const camps = await g(`act_${acc}/campaigns?fields=${campFields}&limit=50`);
  if (camps?._error) return { configured: false, note: `Meta Ads: ${camps._error}` };
  // FIX id106: /campaigns pagina en ORDEN DE CREACIÓN — quedarse con la primera
  // página y ordenar por gasto en memoria NO era un top-50 real (con >50
  // campañas podía omitir precisamente las de más gasto). Se sigue el paging
  // (cursor `after`) hasta agotar, con tope sano de 10 páginas / 500 campañas.
  const campRows: any[] = Array.isArray(camps?.data) ? camps.data.slice() : [];
  let campHasNext = Boolean(camps?.paging?.next);
  let campAfter = String(camps?.paging?.cursors?.after || "");
  for (let page = 2; campHasNext && campAfter && page <= 10; page++) {
    const nx = await g(`act_${acc}/campaigns?fields=${campFields}&limit=50&after=${encodeURIComponent(campAfter)}`);
    if (nx?._error || !Array.isArray(nx?.data) || !nx.data.length) break;
    campRows.push(...nx.data);
    campHasNext = Boolean(nx?.paging?.next);
    campAfter = String(nx?.paging?.cursors?.after || "");
  }
  const campaigns: AdsCampaign[] = campRows
    .map((c: any): AdsCampaign => {
      const ci = c.insights?.data?.[0] ?? {};
      const cs = Number(ci.spend) || 0;
      const cl = pickLeadCount(ci.actions);
      const cpur = pickPurchaseCount(ci.actions);
      const crev = pickPurchaseValue(ci.action_values);
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        spend: cs,
        impressions: Number(ci.impressions) || 0,
        reach: Number(ci.reach) || 0,
        clicks: Number(ci.clicks) || 0,
        ctr: ci.ctr ? +Number(ci.ctr).toFixed(2) : 0,
        cpc: ci.cpc ? +Number(ci.cpc).toFixed(2) : 0,
        cpm: ci.cpm ? +Number(ci.cpm).toFixed(2) : 0,
        leads: cl,
        purchases: cpur,
        revenue: crev,
        cpl: cl ? +(cs / cl).toFixed(2) : null,
        // null≠0: sin NINGUNA señal de compra (ni evento ni valor) el ROAS no es
        // «0x», es «no medible» — normalmente el píxel/evento no está configurado.
        roas: cs && (cpur > 0 || crev > 0) ? +(crev / cs).toFixed(2) : null,
      };
    })
    .sort((a: AdsCampaign, b: AdsCampaign) => b.spend - a.spend);

  return {
    configured: true,
    account: info.name,
    currency: info.currency,
    datePreset: rf.label,
    spend,
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    ctr: row.ctr ? +Number(row.ctr).toFixed(2) : 0,
    cpc: row.cpc ? +Number(row.cpc).toFixed(2) : 0,
    reach: Number(row.reach) || 0,
    leads,
    conversationsStarted,
    purchases,
    revenue,
    // FIX: null cuando denominador 0 — mismo patron que per-campaign.
    cpl: leads ? +(spend / leads).toFixed(2) : null,
    roas: spend && (purchases > 0 || revenue > 0) ? +(revenue / spend).toFixed(2) : null,
    daily,
    campaigns,
    // FIX id106: /campaigns ahora se pagina hasta 10 páginas (500 campañas).
    // Solo si tras el tope AÚN queda paging.next la lista es parcial — y en ese
    // caso el orden por gasto es un top PARCIAL; el título del panel lo refleja.
    campaignsTruncated: campHasNext,
  };
}

/** Análisis IA de la inversión publicitaria: qué rinde y dónde ajustar. */
export async function analyzeAds(): Promise<string> {
  const s = await adsSummary();
  if (!s.configured) return s.note || "Meta Ads no configurado.";
  const data = [
    `Cuenta ${s.account} (${s.currency}). Últimos 30 días:`,
    `Gasto ${s.spend} · Impresiones ${s.impressions} · Clics ${s.clicks} · CTR ${s.ctr}% · CPC ${s.cpc}`,
    `Leads ${s.leads} · CPL ${s.cpl ?? "—"} · Compras ${s.purchases} · Ingresos ${s.revenue} · ROAS ${s.roas ?? "—"}`,
    "",
    "Campañas (por gasto):",
    ...(s.campaigns ?? [])
      .slice(0, 8)
      .map(
        (c) =>
          `- ${c.name} [${c.status}] gasto ${c.spend}, ${c.leads} leads, CPL ${c.cpl ?? "—"}, CTR ${c.ctr}%, compras ${c.purchases}, ROAS ${c.roas ?? "—"}`,
      ),
  ].join("\n");
  const sys =
    "Eres analista de paid media. Analiza estos datos reales de Meta Ads y responde en español, conciso, con esta estructura exacta y encabezados en MAYÚSCULAS:\n" +
    "QUÉ FUNCIONA: (campañas con buen CPL/ROAS, con el dato)\n" +
    "QUÉ MALGASTA: (campañas con gasto alto y pocos resultados)\n" +
    "RECOMENDACIONES: (3 acciones concretas: escalar, pausar o ajustar, con cifras)\n" +
    "Sin relleno, sin markdown. Basado solo en los números dados.";
  return (await quickReply(sys, data)) || "No se pudo generar el análisis ahora mismo.";
}
