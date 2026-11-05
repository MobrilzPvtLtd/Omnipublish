/**
 * meta-ads-pro FASE A4 — A/B testing experiments (KISS approach).
 *
 * En vez de usar la Experiments API oficial de Meta (que está atada a
 * structured tests + no todas las cuentas la tienen habilitada), replicamos
 * un A/B/n test simple a nivel de creative usando primitivas que ya tenemos:
 *
 *   - Una campaign base (la que el operador quiere testear).
 *   - Clonamos su adset base 1 vez por variant (cada variant tiene su propio
 *     ad con su propio adcreative). El control sigue siendo el ad original
 *     del adset base — NO lo duplicamos para no inflar gasto.
 *   - Persistimos en `app_ads_experiments` los ad_ids de las variants + label.
 *   - getExperimentKpis pide /<ad_id>/insights en paralelo para cada variant
 *     y agrupa cpc/ctr/spend/conversions/reach por ad.
 *   - declareWinner pausa los OTROS ads (no toca el ganador). Pone status
 *     'completed' + winner_ad_id + ended_at = now.
 *
 * Razón de no usar Experiments API: simplicidad. Esta version cubre el 95%
 * del caso de uso (operador con 2-4 hooks/copys que quiere ver cuál convierte
 * mejor sin gastar ciegamente). Si en el futuro queremos statistical
 * significance/auto-stop, lo encajamos en A4.b sobre esta misma estructura.
 *
 * Reglas (heredadas de BIG-1/2/3 + A1/A2/A3):
 *   - Cada helper recibe `adAccountId` explícito (ya validado por el caller
 *     contra `adAccountBelongsToWorkspace`). Internamente prefijamos `act_`.
 *   - Cualquier fallo Graph se TRAGA aquí y se devuelve como
 *     `{ ok:false, error }` + `logActivity({ source:'meta-api',
 *     level:'error', ... })`. NUNCA bearer en payload — `_redacted` lo
 *     recuerda.
 *   - Las DB writes (insert/update) las hace el helper directamente — no es
 *     responsabilidad del endpoint.
 */
import { logActivity } from "./activity.js";
import { graphGet, graphPost } from "./metaAdsGraph.js";
// FIX id108: mismos helpers canónicos que adsSummary (metaAds.ts) para que
// «Conversiones» signifique lo mismo en experimentos que en el resto de vistas.
import { pickAction, pickLeadCount, pickPurchaseCount } from "./metaAds.js";
import {
  dbInsertExperiment,
  dbGetExperiment,
  dbUpdateExperimentStatus,
  type AdsExperimentRow,
  type AdsExperimentVariant,
} from "./db.js";

/** Resultado uniforme: { ok, data?, error? }. */
export interface ExperimentsResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Máximo de variants por experimento. Más allá de 4 el side-by-side se hace
 *  ilegible y la cuenta acumula mucho gasto en paralelo. */
export const EXPERIMENT_MAX_VARIANTS = 4;

/** Métricas que recogemos por variant. Lo justo para decidir un ganador. */
export interface VariantKpis {
  ad_id: string;
  label: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  cpc: number | null;
  ctr: number | null;
  /** Suma de actions[type=lead | purchase | offsite_conversion.*]. */
  conversions: number;
  /** Por si Meta no devuelve insights (ad recien creado, sin spend): null. */
  empty?: boolean;
}

/**
 * Prefija `act_` si no está. Defensivo contra `act_act_X`. Devuelve null si
 * no hay adAccountId resoluble.
 */
function actPath(adAccountId: string): string | null {
  const id = String(adAccountId || "").trim();
  if (!id) return null;
  const clean = id.startsWith("act_") ? id.slice(4) : id;
  return `act_${clean}`;
}

// ---- cloneCampaignWithVariants ----------------------------------------

/**
 * Receta para arrancar un experimento. Pasos:
 *
 *   1) Lee el adset base (campos: id, name, campaign_id, daily_budget,
 *      targeting). Validamos que pertenezca a `baseCampaignId`.
 *   2) Por cada variant del input (label + creative_id + copy opcional),
 *      crea un adcreative referenciado (si pasan creative_id, lo
 *      reusamos; si no, construimos un creative minimo con object_story_spec
 *      + link_data). Limit copy a 300 chars para no romper Graph.
 *   3) Crea un nuevo Ad dentro del adset base que apunta a ese creative.
 *      status='ACTIVE' para que arranque a competir desde ya.
 *   4) Persiste app_ads_experiments con la lista de variants (ad_id + label).
 *      Status 'running'.
 *
 * Si cualquier paso falla, marca el experimento (si llegamos a crearlo)
 * como 'failed' con el error y devuelve `{ ok:false }`. Los ads ya creados
 * NO se borran automáticamente — el operador puede pausarlos desde el panel
 * (más seguro que un rollback ciego que podría dejar el adset en un estado
 * raro).
 */
export async function cloneCampaignWithVariants(input: {
  adAccountId: string;
  baseCampaignId: string;
  /** Adset base sobre el que se clonan los Ads. */
  baseAdsetId: string;
  name?: string;
  /** Page id para object_story_spec en creatives nuevos. */
  pageId?: string;
  variants: Array<{
    label: string;
    /** Id de adcreative ya existente. Tiene preferencia sobre `copy`. */
    creativeId?: string;
    copy?: {
      message?: string;
      link?: string;
      cta_type?: string;
      name?: string; // headline
    };
  }>;
  /** tenant_id del WS — pasa el caller. */
  tenantId: string;
}): Promise<ExperimentsResult<{ experimentId: string; variants: AdsExperimentVariant[] }>> {
  const act = actPath(input.adAccountId);
  if (!act) return { ok: false, error: "adAccountId_required" };
  if (!input.baseCampaignId) return { ok: false, error: "baseCampaignId_required" };
  if (!input.baseAdsetId) return { ok: false, error: "baseAdsetId_required" };
  const variants = Array.isArray(input.variants) ? input.variants : [];
  if (variants.length < 2) return { ok: false, error: "min_2_variants" };
  if (variants.length > EXPERIMENT_MAX_VARIANTS) {
    return { ok: false, error: `max_${EXPERIMENT_MAX_VARIANTS}_variants` };
  }

  // 1) Validar que el adset existe y pertenece a la campaign base.
  const adsetInfo = await graphGet<{ id?: string; campaign_id?: string; name?: string }>(
    String(input.baseAdsetId),
    { fields: "id,campaign_id,name" },
  );
  if (!adsetInfo.ok) {
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `experiments:adset fetch failed — ${adsetInfo.error}`.slice(0, 200),
      payload: {
        adAccountId: input.adAccountId,
        baseAdsetId: input.baseAdsetId,
        status: adsetInfo.status,
        _redacted: ["access_token"],
      },
    });
    return { ok: false, error: adsetInfo.error || "adset_fetch_failed" };
  }
  const campaignOfAdset = String(adsetInfo.data?.campaign_id || "");
  if (campaignOfAdset && campaignOfAdset !== String(input.baseCampaignId)) {
    return { ok: false, error: "adset_not_in_base_campaign" };
  }

  // 2) Por cada variant, conseguimos un creativeId. Si viene "ya existente"
  //    lo usamos; si no, construimos uno minimo a partir de `copy`. Sin pageId
  //    no podemos crear creatives nuevos (Meta lo exige) — en ese caso solo
  //    aceptamos variants con creativeId pre-existente.
  const createdVariants: AdsExperimentVariant[] = [];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const label = String(v.label || "").trim().slice(0, 40) || `Variant ${String.fromCharCode(65 + i)}`;
    let creativeId = String(v.creativeId || "").trim();

    if (!creativeId) {
      if (!input.pageId) {
        // Cleanup parcial: marcamos failed solo si llegamos a crear algo.
        return { ok: false, error: `variant_${i}_needs_creativeId_or_pageId` };
      }
      const copy = v.copy || {};
      const creativeBody: Record<string, unknown> = {
        name: `Experiment variant ${label}`.slice(0, 100),
        object_story_spec: {
          page_id: String(input.pageId),
          link_data: {
            message: String(copy.message || "").slice(0, 300),
            link: String(copy.link || "").slice(0, 500),
            name: String(copy.name || "").slice(0, 100),
            call_to_action: copy.cta_type
              ? { type: String(copy.cta_type) }
              : undefined,
          },
        },
      };
      const cr = await graphPost<{ id?: string }>(`${act}/adcreatives`, creativeBody);
      if (!cr.ok) {
        await logActivity({
          source: "meta-api",
          level: "error",
          summary: `experiments:creative create failed — ${cr.error}`.slice(0, 200),
          payload: {
            adAccountId: input.adAccountId,
            variantIdx: i,
            status: cr.status,
            _redacted: ["access_token"],
          },
        });
        return { ok: false, error: cr.error || "creative_create_failed" };
      }
      creativeId = String(cr.data?.id || "");
      if (!creativeId) return { ok: false, error: "creative_no_id" };
    }

    // 3) Crear el Ad apuntando al creative dentro del adset base. status
    //    ACTIVE para que arranque a competir desde ya.
    const adBody: Record<string, unknown> = {
      name: `Experiment ${label}`.slice(0, 100),
      adset_id: String(input.baseAdsetId),
      creative: { creative_id: creativeId },
      status: "ACTIVE",
    };
    const ad = await graphPost<{ id?: string }>(`${act}/ads`, adBody);
    if (!ad.ok) {
      await logActivity({
        source: "meta-api",
        level: "error",
        summary: `experiments:ad create failed — ${ad.error}`.slice(0, 200),
        payload: {
          adAccountId: input.adAccountId,
          variantIdx: i,
          creativeId,
          status: ad.status,
          _redacted: ["access_token"],
        },
      });
      return { ok: false, error: ad.error || "ad_create_failed" };
    }
    const adId = String(ad.data?.id || "");
    if (!adId) return { ok: false, error: "ad_no_id" };

    createdVariants.push({
      ad_id: adId,
      label,
      creative_id: creativeId,
      adset_id: String(input.baseAdsetId),
    });
  }

  // 4) Persistir el experimento. tenant_id viene del caller (currentWorkspaceId).
  try {
    const row = await dbInsertExperiment({
      tenant_id: input.tenantId,
      ad_account_id: input.adAccountId,
      name: String(input.name || `Experiment ${new Date().toISOString().slice(0, 16)}`),
      base_campaign_id: String(input.baseCampaignId),
      variants: createdVariants,
      status: "running",
    });
    return { ok: true, data: { experimentId: row.id, variants: createdVariants } };
  } catch (e) {
    const msg = (e as Error).message || "db insert failed";
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `experiments:db insert failed — ${msg}`.slice(0, 200),
      payload: {
        adAccountId: input.adAccountId,
        baseCampaignId: input.baseCampaignId,
        variantsCreated: createdVariants.length,
        _redacted: ["access_token"],
      },
    });
    return { ok: false, error: msg };
  }
}

// ---- getExperimentKpis -------------------------------------------------

/**
 * Devuelve las KPIs (cpc, ctr, spend, conversions, reach) de cada variant en
 * paralelo. Lifetime preset por defecto — los experimentos suelen ser de pocos
 * días y queremos todo el periodo desde que arrancó. Si el operador necesita
 * ventana corta, A4.b puede aceptar `date_preset` o `time_range`.
 *
 * Si Graph devuelve `{ data: [] }` para un ad (todavía sin spend), lo
 * marcamos `empty:true` con ceros — la UI lo pinta como "Sin datos aún" en
 * vez de cero ganador artificial.
 */
export async function getExperimentKpis(input: {
  experimentId: string;
  tenantId: string;
}): Promise<ExperimentsResult<{ experiment: AdsExperimentRow; kpis: VariantKpis[] }>> {
  const id = String(input.experimentId || "").trim();
  const tenant = String(input.tenantId || "").trim() || "default";
  if (!id) return { ok: false, error: "experimentId_required" };

  const row = await dbGetExperiment({ id, tenantId: tenant });
  if (!row) return { ok: false, error: "experiment_not_found" };
  if (!row.variants.length) {
    return { ok: true, data: { experiment: row, kpis: [] } };
  }

  // Pedimos insights en paralelo. Cada call es independiente — si una falla,
  // la marcamos empty y seguimos: NO hacemos shortcircuit del experimento por
  // un ad transitorio (ads recien creados a veces dan 400 hasta que tienen
  // delivery).
  const fields =
    "spend,impressions,clicks,reach,cpc,ctr,actions";
  const kpis: VariantKpis[] = await Promise.all(
    row.variants.map(async (v): Promise<VariantKpis> => {
      const r = await graphGet<{ data?: any[] }>(`${v.ad_id}/insights`, {
        fields,
        date_preset: "maximum",
      });
      if (!r.ok) {
        // Si es 400 sin delivery, lo tratamos como empty. Solo si es
        // 401/403/500 lo logueamos como fallo.
        if (r.status && r.status >= 400 && r.status !== 400) {
          await logActivity({
            source: "meta-api",
            level: "error",
            summary: `experiments:kpis fetch failed ad=${v.ad_id} — ${r.error}`.slice(0, 200),
            payload: {
              experimentId: id,
              adId: v.ad_id,
              status: r.status,
              _redacted: ["access_token"],
            },
          });
        }
        return {
          ad_id: v.ad_id,
          label: v.label,
          spend: 0,
          impressions: 0,
          clicks: 0,
          reach: 0,
          cpc: null,
          ctr: null,
          conversions: 0,
          empty: true,
        };
      }
      const arr = Array.isArray(r.data?.data) ? r.data!.data! : [];
      if (!arr.length) {
        return {
          ad_id: v.ad_id,
          label: v.label,
          spend: 0,
          impressions: 0,
          clicks: 0,
          reach: 0,
          cpc: null,
          ctr: null,
          conversions: 0,
          empty: true,
        };
      }
      const d = arr[0] || {};
      // FIX id108: selección canónica de «Conversiones» (mismo criterio que
      // adsSummary en metaAds.ts): leads (fila agregada `lead` o, si falta,
      // suma de subtipos onsite+offsite) + compras (omni_purchase → purchase →
      // fb_pixel_purchase, nunca la suma) + complete_registration. El filtro
      // anterior por prefijos offsite_/onsite_ sumaba view_content, add_to_cart,
      // initiate_checkout, post_save, mensajes… — duplicaba leads reales y
      // podía activar el badge de líder sobre la variante equivocada.
      const actions = Array.isArray(d.actions) ? d.actions : [];
      const conversions =
        pickLeadCount(actions) +
        pickPurchaseCount(actions) +
        (pickAction(actions, "complete_registration") ?? 0);
      const spend = Number(d.spend) || 0;
      const impressions = Number(d.impressions) || 0;
      const clicks = Number(d.clicks) || 0;
      const reach = Number(d.reach) || 0;
      const cpc = d.cpc != null ? Number(d.cpc) : clicks > 0 ? spend / clicks : null;
      const ctr =
        d.ctr != null
          ? Number(d.ctr)
          : impressions > 0
            ? (clicks / impressions) * 100
            : null;
      return {
        ad_id: v.ad_id,
        label: v.label,
        spend,
        impressions,
        clicks,
        reach,
        cpc,
        ctr,
        conversions,
      };
    }),
  );

  return { ok: true, data: { experiment: row, kpis } };
}

// ---- declareWinner -----------------------------------------------------

/**
 * Declara el ad ganador del experimento. Pausa el RESTO de variants (no
 * toca el ganador — sigue ACTIVE). Marca status='completed' + winner_ad_id
 * + ended_at=now.
 *
 * Validación: el ganador debe estar en la lista de variants del experimento
 * (no se puede declarar ganador a un ad ajeno). Esto evita que un actor con
 * id de ad valido pero ajeno al test lo "secuestre".
 *
 * Si la pausa de algún ad-no-ganador falla en Graph, seguimos pausando el
 * resto y devolvemos ok:true (el experimento quedaria parcialmente cerrado).
 * El operador puede ver el partial-pause en el log de actividad.
 */
export async function declareWinner(input: {
  experimentId: string;
  adId: string;
  tenantId: string;
}): Promise<ExperimentsResult<{ pausedAdIds: string[]; winnerAdId: string }>> {
  const id = String(input.experimentId || "").trim();
  const winnerAdId = String(input.adId || "").trim();
  const tenant = String(input.tenantId || "").trim() || "default";
  if (!id) return { ok: false, error: "experimentId_required" };
  if (!winnerAdId) return { ok: false, error: "adId_required" };

  const row = await dbGetExperiment({ id, tenantId: tenant });
  if (!row) return { ok: false, error: "experiment_not_found" };

  // Ownership del adId: debe pertenecer al experimento.
  const isOwned = row.variants.some((v) => v.ad_id === winnerAdId);
  if (!isOwned) return { ok: false, error: "ad_not_in_experiment" };

  // Pausar todas las variants distintas del ganador. En paralelo, con
  // logging individual si alguna falla.
  const losers = row.variants.filter((v) => v.ad_id !== winnerAdId);
  const pausedAdIds: string[] = [];
  await Promise.all(
    losers.map(async (v) => {
      const r = await graphPost<{ success?: boolean }>(String(v.ad_id), {
        status: "PAUSED",
      });
      if (r.ok) {
        pausedAdIds.push(v.ad_id);
      } else {
        await logActivity({
          source: "meta-api",
          level: "error",
          summary: `experiments:pause loser ad=${v.ad_id} failed — ${r.error}`.slice(0, 200),
          payload: {
            experimentId: id,
            adId: v.ad_id,
            status: r.status,
            _redacted: ["access_token"],
          },
        });
      }
    }),
  );

  // Marcar el experimento como completed.
  try {
    await dbUpdateExperimentStatus({
      id,
      tenantId: tenant,
      status: "completed",
      winner_ad_id: winnerAdId,
      setEndedNow: true,
    });
  } catch (e) {
    const msg = (e as Error).message || "db update failed";
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `experiments:winner db update failed — ${msg}`.slice(0, 200),
      payload: { experimentId: id, _redacted: ["access_token"] },
    });
    return { ok: false, error: msg };
  }

  return { ok: true, data: { pausedAdIds, winnerAdId } };
}

// ---- Re-export type para callers ---------------------------------------

export type { AdsExperimentRow, AdsExperimentVariant };
