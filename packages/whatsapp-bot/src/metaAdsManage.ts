/**
 * Gestión de campañas Meta Ads (Marketing API, ESCRITURA). Complementa a
 * metaAds.ts (solo lectura). Permite, desde el panel, sin salir a Meta:
 *   · listar campañas con su estado y presupuesto (ads_management)
 *   · crear una campaña nueva (siempre en PAUSA → no gasta hasta activar)
 *   · pausar / activar una campaña existente
 *   · cambiar el presupuesto diario
 *   · "impulsar" (boost) una publicación de una Página de Facebook creando
 *     campaña + conjunto de anuncios + anuncio que la promociona
 *     (pages_manage_ads). Se crea en PAUSA para que el usuario revise antes
 *     de que empiece a gastar.
 *
 * Token: meta.adsToken (System User / usuario long-lived con scopes ads_*).
 * Cuenta: meta.adAccountId (sin prefijo act_). Las llamadas degradan con
 * elegancia: nunca lanzan, devuelven { error } cuando Meta rechaza.
 */
import { get } from "./settings.js";
import { getFbAccount } from "./facebook.js";

const BASE = "https://graph.facebook.com/v21.0";

function creds(): { token: string; acc: string } {
  return { token: get("meta.adsToken"), acc: get("meta.adAccountId") };
}

/** Objetivos de campaña válidos (Marketing API v21, esquema OUTCOME_*). */
export const CAMPAIGN_OBJECTIVES: { id: string; label: string }[] = [
  { id: "OUTCOME_TRAFFIC", label: "Tráfico (visitas a web/perfil)" },
  { id: "OUTCOME_ENGAGEMENT", label: "Interacción (mensajes, likes, vídeo)" },
  { id: "OUTCOME_LEADS", label: "Clientes potenciales (leads)" },
  { id: "OUTCOME_SALES", label: "Ventas / conversiones" },
  { id: "OUTCOME_AWARENESS", label: "Reconocimiento de marca / alcance" },
];

const VALID_OBJECTIVES = new Set(CAMPAIGN_OBJECTIVES.map((o) => o.id));

interface GraphResult { ok: boolean; data?: any; error?: string; }

async function graphGet(path: string): Promise<GraphResult> {
  const { token } = creds();
  const sep = path.includes("?") ? "&" : "?";
  try {
    const r = await fetch(`${BASE}/${path}${sep}access_token=${token}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d?.error) return { ok: false, error: d?.error?.message || `HTTP ${r.status}` };
    return { ok: true, data: d };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function graphPost(path: string, body: Record<string, unknown>, token?: string): Promise<GraphResult> {
  const t = token || creds().token;
  try {
    // JSON body: serializa correctamente arrays/objetos (p.ej. special_ad_categories:[]
    // y targeting:{...}); con urlencoded daban "Invalid parameter".
    const r = await fetch(`${BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, access_token: t }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d?.error) {
      // Mensaje detallado: Graph suele explicar el motivo real en error_user_msg/title.
      const e = d?.error || {};
      const detail = [e.message, e.error_user_title, e.error_user_msg].filter(Boolean).join(" · ");
      return { ok: false, error: detail || `HTTP ${r.status}` };
    }
    return { ok: true, data: d };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface ManagedCampaign {
  id: string;
  name: string;
  status: string;            // ACTIVE | PAUSED | ARCHIVED | DELETED
  effectiveStatus: string;   // incluye motivos (WITH_ISSUES, IN_PROCESS…)
  objective: string;
  dailyBudget: number | null;    // en unidades de moneda (no minor units)
  lifetimeBudget: number | null;
  startTime?: string;
  stopTime?: string;
}

/** Lista las campañas de la cuenta activa con estado y presupuesto. */
export async function listManagedCampaigns(): Promise<{ configured: boolean; note?: string; currency?: string; campaigns?: ManagedCampaign[] }> {
  const { token, acc } = creds();
  if (!token || !acc) return { configured: false, note: "Conecta Meta Ads y selecciona una cuenta publicitaria en Conexiones." };

  const info = await graphGet(`act_${acc}?fields=name,currency`);
  if (!info.ok) return { configured: false, note: `Meta Ads: ${info.error}` };
  const currency = info.data?.currency || "";

  const mngFields = "name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time";
  const res = await graphGet(`act_${acc}/campaigns?fields=${mngFields}&limit=100`);
  if (!res.ok) return { configured: true, currency, note: res.error, campaigns: [] };

  // FIX id106: la tabla de Gestión presentaba UNA página (100 en orden de
  // creación) como si fuera el total. Se sigue el paging (cursor `after`)
  // hasta agotar, con tope sano de 5 páginas / 500 campañas.
  const rows: any[] = Array.isArray(res.data?.data) ? res.data.data.slice() : [];
  let hasNext = Boolean(res.data?.paging?.next);
  let after = String(res.data?.paging?.cursors?.after || "");
  for (let page = 2; hasNext && after && page <= 5; page++) {
    const nx = await graphGet(`act_${acc}/campaigns?fields=${mngFields}&limit=100&after=${encodeURIComponent(after)}`);
    if (!nx.ok || !Array.isArray(nx.data?.data) || !nx.data.data.length) break;
    rows.push(...nx.data.data);
    hasNext = Boolean(nx.data?.paging?.next);
    after = String(nx.data?.paging?.cursors?.after || "");
  }

  const campaigns: ManagedCampaign[] = rows.map((c: any) => ({
    id: String(c.id),
    name: c.name || "(sin nombre)",
    status: c.status || "",
    effectiveStatus: c.effective_status || c.status || "",
    objective: c.objective || "",
    // La API devuelve el presupuesto en minor units (céntimos). Lo pasamos a unidades.
    dailyBudget: c.daily_budget != null ? Number(c.daily_budget) / 100 : null,
    lifetimeBudget: c.lifetime_budget != null ? Number(c.lifetime_budget) / 100 : null,
    startTime: c.start_time,
    stopTime: c.stop_time,
  }));
  return { configured: true, currency, campaigns };
}

/** Crea una campaña nueva SIEMPRE en pausa (no gasta hasta que el usuario la active). */
export async function createCampaign(input: { name: string; objective: string; dailyBudget?: number }): Promise<{ ok: boolean; id?: string; error?: string }> {
  const { token, acc } = creds();
  if (!token || !acc) return { ok: false, error: "Meta Ads no conectado." };
  const name = String(input.name || "").trim();
  if (!name) return { ok: false, error: "El nombre de la campaña es obligatorio." };
  const objective = VALID_OBJECTIVES.has(input.objective) ? input.objective : "OUTCOME_TRAFFIC";

  const body: Record<string, unknown> = {
    name,
    objective,
    status: "PAUSED",
    // Categorías de anuncio especiales: vacío = anuncio normal. Meta lo exige.
    special_ad_categories: [],
  };
  // Presupuesto a nivel de campaña (CBO) en minor units si se indica. Si NO hay
  // presupuesto de campaña, Meta exige declarar is_adset_budget_sharing_enabled.
  if (input.dailyBudget && input.dailyBudget > 0) {
    body.daily_budget = Math.round(input.dailyBudget * 100);
  } else {
    body.is_adset_budget_sharing_enabled = false;
  }
  const r = await graphPost(`act_${acc}/campaigns`, body);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, id: String(r.data?.id || "") };
}

/** Pausa o activa una campaña. status = 'ACTIVE' | 'PAUSED'. */
export async function setCampaignStatus(campaignId: string, status: "ACTIVE" | "PAUSED"): Promise<{ ok: boolean; error?: string }> {
  if (!campaignId) return { ok: false, error: "Falta el id de campaña." };
  const st = status === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const r = await graphPost(String(campaignId), { status: st });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** Cambia el presupuesto diario de una campaña (recibe unidades de moneda). */
export async function updateCampaignBudget(campaignId: string, dailyBudget: number): Promise<{ ok: boolean; error?: string }> {
  if (!campaignId) return { ok: false, error: "Falta el id de campaña." };
  const minor = Math.round(Number(dailyBudget) * 100);
  if (!minor || minor < 100) return { ok: false, error: "El presupuesto diario mínimo es 1.00." };
  const r = await graphPost(String(campaignId), { daily_budget: String(minor) });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// ============================================================
// Boost de publicación de Página (pages_manage_ads)
// ============================================================

export interface BoostablePost {
  id: string;          // {pageId}_{postId}
  message: string;
  picture?: string;
  createdTime?: string;
  permalink?: string;
}

/** Publicaciones recientes de una Página, candidatas a impulsar (boost). */
export async function listBoostablePosts(pageId: string): Promise<{ ok: boolean; posts?: BoostablePost[]; error?: string }> {
  const a = getFbAccount(pageId);
  if (!a) return { ok: false, error: "Página no encontrada o desconectada." };
  try {
    const url = `${BASE}/${pageId}/published_posts?fields=message,full_picture,created_time,permalink_url&limit=20&access_token=${encodeURIComponent(a.token)}`;
    const r = await fetch(url);
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok || d?.error) return { ok: false, error: d?.error?.message || `HTTP ${r.status}` };
    const posts: BoostablePost[] = (d.data ?? [])
      .filter((p: any) => p.id)
      .map((p: any) => ({
        id: String(p.id),
        message: String(p.message || "(publicación sin texto)").slice(0, 140),
        picture: p.full_picture || undefined,
        createdTime: p.created_time,
        permalink: p.permalink_url,
      }));
    return { ok: true, posts };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Impulsa (boost) una publicación de Página: crea campaña + conjunto de
 * anuncios + anuncio que la promociona. Se queda TODO en PAUSA para que el
 * usuario revise y active. Geo por países (ISO-2), presupuesto diario y
 * duración configurables. Usa el token de la cuenta publicitaria (ads_*) +
 * el object_story_id de la publicación de la Página (pages_manage_ads).
 */
export async function boostPost(input: {
  pageId: string;
  postId: string;       // {pageId}_{postId} (el id completo del post)
  dailyBudget: number;  // unidades de moneda
  days: number;         // duración en días
  countries?: string[]; // ISO-2; default ES
}): Promise<{ ok: boolean; campaignId?: string; adSetId?: string; adId?: string; error?: string }> {
  const { token, acc } = creds();
  if (!token || !acc) return { ok: false, error: "Meta Ads no conectado." };
  const page = getFbAccount(input.pageId);
  if (!page) return { ok: false, error: "Página no encontrada." };
  const budgetMinor = Math.round(Number(input.dailyBudget) * 100);
  if (!budgetMinor || budgetMinor < 100) return { ok: false, error: "Presupuesto diario mínimo 1.00." };
  const countries = (input.countries && input.countries.length ? input.countries : ["ES"]).map((c) => c.toUpperCase());

  // 1) Campaña — objetivo interacción (lo natural para impulsar un post).
  const camp = await graphPost(`act_${acc}/campaigns`, {
    name: `Impulsar publicación · ${page.name || input.pageId}`.slice(0, 100),
    objective: "OUTCOME_ENGAGEMENT",
    status: "PAUSED",
    special_ad_categories: [],
    // El presupuesto va en el adset (no en la campaña) → Meta exige este campo.
    is_adset_budget_sharing_enabled: false,
  });
  if (!camp.ok) return { ok: false, error: `Campaña: ${camp.error}` };
  const campaignId = String(camp.data?.id || "");

  // 2) Conjunto de anuncios — presupuesto diario, geo, optimización por alcance.
  const adSet = await graphPost(`act_${acc}/adsets`, {
    name: "Conjunto · impulsar publicación",
    campaign_id: campaignId,
    daily_budget: String(budgetMinor),
    billing_event: "IMPRESSIONS",
    optimization_goal: "POST_ENGAGEMENT",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    targeting: { geo_locations: { countries } },
    status: "PAUSED",
  });
  if (!adSet.ok) return { ok: false, campaignId, error: `Conjunto de anuncios: ${adSet.error}` };
  const adSetId = String(adSet.data?.id || "");

  // 3) Creatividad referenciando la publicación existente de la Página.
  const creative = await graphPost(`act_${acc}/adcreatives`, {
    name: "Creatividad · publicación existente",
    object_story_id: input.postId,
  });
  if (!creative.ok) return { ok: false, campaignId, adSetId, error: `Creatividad: ${creative.error}` };
  const creativeId = String(creative.data?.id || "");

  // 4) Anuncio que une conjunto + creatividad.
  const ad = await graphPost(`act_${acc}/ads`, {
    name: "Anuncio · publicación impulsada",
    adset_id: adSetId,
    creative: { creative_id: creativeId },
    status: "PAUSED",
  });
  if (!ad.ok) return { ok: false, campaignId, adSetId, error: `Anuncio: ${ad.error}` };

  return { ok: true, campaignId, adSetId, adId: String(ad.data?.id || "") };
}
