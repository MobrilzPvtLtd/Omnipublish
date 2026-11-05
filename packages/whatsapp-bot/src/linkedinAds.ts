/**
 * Conector LinkedIn Ads (Marketing API, SOLO LECTURA — scopes r_ads + r_ads_reporting).
 * Devuelve el MISMO shape AdsSummary que metaAds.ts para que el panel reutilice la
 * tabla y los KPIs. El orgánico de LinkedIn ya vive en autopost/zernio.ts — esto es
 * el módulo de PAGO, independiente.
 *
 * Token: LinkedIn emite un access token de ~60 días + refresh token de ~1 año (solo
 * apps aprobadas). A diferencia de Meta (token de 60d sin refresh), aquí refrescamos
 * proactivamente (calco de youtube.ts refreshAccess). Todo per-workspace y cifrado:
 *   linkedin.accessToken / linkedin.refreshToken / linkedin.tokenExpiry (SECRET, per-WS)
 *   linkedin.adsAccounts (JSON array) / linkedin.adAccountId (cuenta activa)
 * App creds del stack (una app sirve a todos, modelo ManyChat): linkedin.clientId /
 * linkedin.clientSecret (GLOBAL).
 *
 * NOTA: la LinkedIn Marketing API exige aprobación ("Advertising API" en Marketing
 * Developer Platform). Hasta tenerla, esto degrada con elegancia (configured:false).
 * El formato exacto de adAnalytics (Rest.li 2.0 versionado) puede requerir ajuste
 * fino contra la versión aprobada; todo está aislado y nunca lanza.
 */
import { get, set, getWorkspaceSetting } from "./settings.js";
import { quickReply } from "./brain.js";
import { liGet } from "./linkedinAdsGraph.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AdsSummary, AdsCampaign, AdsRange } from "./metaAds.js";

/** Entrada per-WS en linkedin.adsAccounts. `adAccountId` = id numérico (sin urn). */
export interface LinkedInAdsAccountEntry {
  adAccountId: string;
  adAccountName: string;
  currency: string;
  label?: string;
  addedAt?: number;
}

type LiOverride = { adAccountId: string };
const liAccALS = new AsyncLocalStorage<LiOverride>();
export function runWithLinkedinAccount<T>(o: LiOverride, fn: () => Promise<T>): Promise<T> {
  return liAccALS.run(o, fn);
}

/** Credenciales de la app del stack (una para todos los workspaces). */
export function linkedinAppCreds(): { clientId: string; clientSecret: string } {
  return {
    clientId: get("linkedin.clientId") || process.env.LINKEDIN_CLIENT_ID || "",
    clientSecret: get("linkedin.clientSecret") || process.env.LINKEDIN_CLIENT_SECRET || "",
  };
}

/** ¿Hay OAuth app configurada (paso único del owner)? */
export function linkedinConfigured(): boolean {
  const { clientId, clientSecret } = linkedinAppCreds();
  return !!clientId && !!clientSecret;
}

/** ¿Este workspace tiene una conexión LinkedIn Ads activa (token + cuenta)? */
export function linkedinConnected(): boolean {
  return !!get("linkedin.accessToken") && (!!get("linkedin.adAccountId") || linkedinAdsAccountsList().length > 0);
}

/** Cuenta activa: override ALS (selector del panel) → linkedin.adAccountId. */
function activeAccountId(): string {
  const ov = liAccALS.getStore();
  if (ov && ov.adAccountId) return ov.adAccountId;
  return get("linkedin.adAccountId");
}

/** Lista de cuentas publicitarias del workspace (per-WS). */
export function linkedinAdsAccountsList(wsId?: string): LinkedInAdsAccountEntry[] {
  const raw = wsId ? getWorkspaceSetting(wsId, "linkedin.adsAccounts", "") : get("linkedin.adsAccounts");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((a: any): LinkedInAdsAccountEntry | null => {
        const id = String(a?.adAccountId || a?.id || "").trim();
        if (!id) return null;
        return {
          adAccountId: id,
          adAccountName: String(a?.adAccountName || a?.name || id),
          currency: String(a?.currency || ""),
          label: a?.label ? String(a.label) : undefined,
          addedAt: typeof a?.addedAt === "number" ? a.addedAt : undefined,
        };
      })
      .filter((x): x is LinkedInAdsAccountEntry => x !== null);
  } catch {
    return [];
  }
}

/**
 * Access token fresco para el workspace activo. Refresca proactivamente si caduca
 * en <60s (calco de youtube.ts). Persiste el token refrescado (y rota el refresh
 * token si LinkedIn devuelve uno nuevo). Devuelve "" si no hay forma de obtener uno.
 */
export async function linkedinFreshToken(): Promise<string> {
  const at = get("linkedin.accessToken");
  const exp = Number(get("linkedin.tokenExpiry") || 0);
  if (at && Date.now() < exp - 60000) return at;
  const rt = get("linkedin.refreshToken");
  const { clientId, clientSecret } = linkedinAppCreds();
  if (!rt || !clientId || !clientSecret) return at || "";
  try {
    const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: rt,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const d: Record<string, unknown> = await res.json().catch(() => ({}));
    if (res.ok && d.access_token) {
      const newAt = String(d.access_token);
      await set("linkedin.accessToken", newAt);
      await set("linkedin.tokenExpiry", String(Date.now() + (Number(d.expires_in) || 5184000) * 1000));
      if (d.refresh_token) await set("linkedin.refreshToken", String(d.refresh_token));
      return newAt;
    }
  } catch {
    /* best-effort: si el refresh falla devolvemos el token viejo (puede seguir válido) */
  }
  return at || "";
}

// ---- adAnalytics (Rest.li 2.0 versionado) ------------------------------------

const LI_FIELDS = "costInLocalCurrency,impressions,clicks,externalWebsiteConversions,oneClickLeads,pivotValues";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Traduce el rango del panel a fechas {y,m,d} para el dateRange de LinkedIn. */
function rangeToLiDates(range: AdsRange): { start: Date; end: Date; label: string } {
  const end = new Date();
  if (typeof range === "object" && range.since && range.until) {
    return { start: new Date(range.since + "T00:00:00Z"), end: new Date(range.until + "T00:00:00Z"), label: `${range.since} → ${range.until}` };
  }
  // FIX id104: last_28d en el map — sin él, el preset «Últimos 28 días» del
  // date-picker caía al fallback de 30 días bajo una etiqueta que promete 28.
  const map: Record<string, number> = { today: 1, last_7d: 7, last_14d: 14, last_28d: 28, last_30d: 30, last_90d: 90 };
  const days = map[String(range)] ?? 30;
  const start = new Date(end.getTime() - days * 86400000);
  return { start, end, label: String(range) };
}

/** dateRange=(start:(year,month,day),end:(year,month,day)) — partes estructurales sin encodear.
 *  Guard: si una fecha es inválida (year:NaN rompería el path → 400), cae a últimos 30 días. */
function liDateRange(startIn: Date, endIn: Date): string {
  let start = startIn, end = endIn;
  if (Number.isNaN(start.getUTCFullYear()) || Number.isNaN(end.getUTCFullYear())) {
    end = new Date();
    start = new Date(end.getTime() - 30 * 86400000);
  }
  const p = (x: Date) => `(year:${x.getUTCFullYear()},month:${x.getUTCMonth() + 1},day:${x.getUTCDate()})`;
  return `dateRange=(start:${p(start)},end:${p(end)})`;
}

/** Construye el path de adAnalytics para un pivot dado. El URN de cuenta se encodea dentro de List(). */
function analyticsPath(pivot: "ACCOUNT" | "CAMPAIGN", start: Date, end: Date, accUrn: string): string {
  const parts = [
    "adAnalytics?q=analytics",
    liDateRange(start, end),
    "timeGranularity=(value:ALL)",
    `pivot=(value:${pivot})`,
    `accounts=List(${encodeURIComponent(accUrn)})`,
    `fields=${LI_FIELDS}`,
  ];
  return parts.join("&");
}

/** Extrae el id numérico de campaña de un pivotValue urn:li:sponsoredCampaign:123. */
function campaignIdFromPivot(row: any): string {
  const pv = row?.pivotValues;
  const urn = Array.isArray(pv) ? String(pv[0] || "") : String(pv || "");
  const m = urn.match(/sponsoredCampaign:(\d+)/);
  return m ? m[1] : "";
}

/**
 * Resumen de la cuenta LinkedIn Ads + por campaña, en el rango dado. Mismo shape
 * AdsSummary que Meta. LinkedIn no expone reach/cpm/purchases/revenue en el mismo
 * sentido; se rellenan a 0 / null (never-fake-metrics) y se mapea leads =
 * oneClickLeads (Lead Gen Forms) + externalWebsiteConversions (píxel).
 */
export async function linkedinAdsSummary(range: AdsRange = "last_30d"): Promise<AdsSummary> {
  const acc = activeAccountId();
  if (!acc) {
    return { configured: false, note: "Conecta LinkedIn Ads (permiso r_ads) y elige una cuenta publicitaria en Conexiones." };
  }
  const token = await linkedinFreshToken();
  if (!token) {
    return { configured: false, note: "LinkedIn Ads: falta el access token (reconecta la cuenta en Conexiones)." };
  }
  const { start, end, label } = rangeToLiDates(range);
  const accUrn = `urn:li:sponsoredAccount:${acc}`;

  // Info de la cuenta (nombre + divisa).
  const info = await liGet<any>(`adAccounts/${encodeURIComponent(acc)}`, { token });
  if (!info.ok) return { configured: false, note: `LinkedIn Ads: ${info.error}` };
  const accName = String(info.data?.name || acc);
  const currency = String(info.data?.currency || "");

  // KPIs a nivel cuenta.
  const ana = await liGet<any>(analyticsPath("ACCOUNT", start, end, accUrn), { token });
  // Mismo patrón que metaAds: un fallo aquí antes se tragaba en silencio y salía
  // "Gasto 0 · Leads 0 · Impresiones 0" como dato real. Error explícito en su lugar.
  if (!ana.ok) return { configured: false, note: `LinkedIn Ads: ${ana.error}` };
  const row = ana.data?.elements?.[0] ?? {};
  const spend = num(row.costInLocalCurrency);
  const impressions = num(row.impressions);
  const clicks = num(row.clicks);
  const leads = num(row.oneClickLeads) + num(row.externalWebsiteConversions);

  // KPIs por campaña (un solo call con pivot CAMPAIGN) + nombres/estado de campañas.
  const campAna = await liGet<any>(analyticsPath("CAMPAIGN", start, end, accUrn), { token });
  // Igual que arriba: sin este guard, un fallo pintaba "Sin campañas en el periodo".
  if (!campAna.ok) return { configured: false, note: `LinkedIn Ads: ${campAna.error}` };
  // Nota: el finder search de adCampaigns NO acepta sortOrder top-level (rechaza 400)
  // y pagina a ~10 por defecto → se recorre con start/count (count=100, tope 500)
  // para resolver nombres/estado de TODAS las campañas; antes solo la 1ª página y
  // a partir de la ~11ª campaña la tabla mostraba el id crudo y estado vacío.
  const metaById = new Map<string, { name: string; status: string; objective: string }>();
  const CAMP_PAGE = 100, CAMP_CAP = 500;
  for (let startAt = 0; startAt < CAMP_CAP; startAt += CAMP_PAGE) {
    const campMeta = await liGet<any>(
      `adAccounts/${encodeURIComponent(acc)}/adCampaigns?q=search&start=${startAt}&count=${CAMP_PAGE}`,
      { token },
    );
    if (!campMeta.ok) break; // best-effort: los KPIs no dependen de esto
    const els: any[] = campMeta.data?.elements ?? [];
    for (const c of els) {
      const id = String(c?.id || "");
      if (id) metaById.set(id, {
        name: String(c?.name || id),
        status: String(c?.status || ""),
        objective: String(c?.objectiveType || c?.objective || ""),
      });
    }
    if (els.length < CAMP_PAGE) break;
  }
  const campaigns: AdsCampaign[] = (campAna.data?.elements ?? [])
    .map((r: any): AdsCampaign => {
      const id = campaignIdFromPivot(r);
      const m = metaById.get(id) || { name: id ? "Campaña …" + id.slice(-4) : "Campaña", status: "", objective: "" };
      const cs = num(r.costInLocalCurrency);
      const cclicks = num(r.clicks);
      const cimp = num(r.impressions);
      const cleads = num(r.oneClickLeads) + num(r.externalWebsiteConversions);
      return {
        id,
        name: m.name,
        status: m.status,
        objective: m.objective,
        spend: cs,
        impressions: cimp,
        reach: 0,
        clicks: cclicks,
        ctr: cimp ? +((cclicks / cimp) * 100).toFixed(2) : 0,
        cpc: cclicks ? +(cs / cclicks).toFixed(2) : 0,
        cpm: cimp ? +((cs / cimp) * 1000).toFixed(2) : 0,
        leads: cleads,
        purchases: 0,
        revenue: 0,
        cpl: cleads ? +(cs / cleads).toFixed(2) : null,
        roas: null, // LinkedIn no da valor de conversión en este set de fields
      };
    })
    .sort((a: AdsCampaign, b: AdsCampaign) => b.spend - a.spend);

  return {
    configured: true,
    account: accName,
    currency,
    datePreset: label,
    spend,
    impressions,
    clicks,
    ctr: impressions ? +((clicks / impressions) * 100).toFixed(2) : 0,
    cpc: clicks ? +(spend / clicks).toFixed(2) : 0,
    reach: 0,
    leads,
    purchases: 0,
    revenue: 0,
    cpl: leads ? +(spend / leads).toFixed(2) : null,
    roas: null,
    campaigns,
  };
}

// ---- OAuth (authorization code + refresh) ------------------------------------

/**
 * Scopes baseline SOLO LECTURA (r_ads + r_ads_reporting).
 * Fase 2 = dos TRACKS de aprobación distintos (NO 'r_ads_leadgen_automation', que
 * está DEPRECADO desde jul-2023 y ya no existe):
 *   - rw_ads → gestión/creación de campañas (use-case "ads management").
 *   - r_marketing_leadgen_automation → ingesta de Lead Gen Forms al CRM vía Lead Sync
 *     API (producto/solicitud SEPARADA). Recomendado SOLICITAR acceso en paralelo en
 *     cuanto se apruebe la Advertising API (la maquinaria se calca de leadsAds.ts).
 */
export const LINKEDIN_SCOPES = ["r_ads", "r_ads_reporting"];

export function linkedinAuthUrl(redirectUri: string, state: string): string {
  const { clientId } = linkedinAppCreds();
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: LINKEDIN_SCOPES.join(" "),
    state,
  });
  return "https://www.linkedin.com/oauth/v2/authorization?" + p.toString();
}

/** Descubre las cuentas publicitarias accesibles por el token (best-effort, N+1 acotado). */
async function discoverAccounts(token: string): Promise<LinkedInAdsAccountEntry[]> {
  const users = await liGet<any>("adAccountUsers?q=authenticatedUser", { token });
  if (!users.ok) return [];
  const urns = new Set<string>();
  for (const e of (users.data?.elements ?? [])) {
    const urn = String(e?.account || "");
    if (urn) urns.add(urn);
  }
  const out: LinkedInAdsAccountEntry[] = [];
  let i = 0;
  for (const urn of urns) {
    if (i++ >= 25) break; // acota el N+1
    const id = (urn.match(/sponsoredAccount:(\d+)/) || [])[1] || "";
    if (!id) continue;
    const info = await liGet<any>(`adAccounts/${encodeURIComponent(id)}`, { token });
    const name = info.ok ? String(info.data?.name || id) : id;
    const currency = info.ok ? String(info.data?.currency || "") : "";
    out.push({ adAccountId: id, adAccountName: name, currency, label: name, addedAt: Date.now() });
  }
  return out;
}

/** Intercambia el code por tokens, persiste, y descubre cuentas. Espejo de youtubeExchangeCode. */
export async function linkedinExchangeCode(code: string, redirectUri: string): Promise<{ ok: boolean; error?: string; accountsFound?: number }> {
  const { clientId, clientSecret } = linkedinAppCreds();
  if (!clientId || !clientSecret) return { ok: false, error: "Falta la LinkedIn App (linkedin.clientId / linkedin.clientSecret)." };
  let d: Record<string, unknown> = {};
  try {
    const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(12000),
    });
    d = await res.json().catch(() => ({}));
    if (!res.ok || !d.access_token) return { ok: false, error: String(d.error_description || d.error || "token exchange falló") };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const accessToken = String(d.access_token);
  // Persistencia + discovery aislados: si set()/BD falla, devolvemos {ok:false} en vez
  // de propagar (el callback OAuth muestra un error amable, no un 500 crudo).
  try {
    await set("linkedin.accessToken", accessToken);
    await set("linkedin.tokenExpiry", String(Date.now() + (Number(d.expires_in) || 5184000) * 1000));
    if (d.refresh_token) await set("linkedin.refreshToken", String(d.refresh_token));
    let accounts: LinkedInAdsAccountEntry[] = [];
    try { accounts = await discoverAccounts(accessToken); } catch { accounts = []; }
    if (accounts.length) {
      await set("linkedin.adsAccounts", JSON.stringify(accounts));
      if (!get("linkedin.adAccountId")) await set("linkedin.adAccountId", accounts[0].adAccountId);
    }
    return { ok: true, accountsFound: accounts.length };
  } catch (e) {
    return { ok: false, error: `No se pudo guardar la conexión: ${(e as Error).message}` };
  }
}

/** Fija la cuenta activa (debe estar en la lista descubierta del workspace). */
export async function linkedinSelectAccount(adAccountId: string): Promise<boolean> {
  const id = String(adAccountId || "").trim();
  if (!id) return false;
  if (!linkedinAdsAccountsList().some((a) => a.adAccountId === id)) return false;
  await set("linkedin.adAccountId", id);
  return true;
}

/** Desconecta LinkedIn Ads del workspace (borra token + cuentas). */
export async function linkedinDisconnect(): Promise<void> {
  for (const k of ["linkedin.accessToken", "linkedin.refreshToken", "linkedin.tokenExpiry", "linkedin.adAccountId", "linkedin.adsAccounts"]) {
    await set(k, "");
  }
}

/** Análisis IA de la inversión en LinkedIn Ads. */
export async function analyzeLinkedinAds(): Promise<string> {
  const s = await linkedinAdsSummary();
  if (!s.configured) return s.note || "LinkedIn Ads no configurado.";
  const data = [
    `Cuenta ${s.account} (${s.currency}). Rango ${s.datePreset}:`,
    `Gasto ${s.spend} · Impresiones ${s.impressions} · Clics ${s.clicks} · CTR ${s.ctr}% · CPC ${s.cpc}`,
    `Leads ${s.leads} · CPL ${s.cpl ?? "—"}`,
    "",
    "Campañas (por gasto):",
    ...(s.campaigns ?? []).slice(0, 8).map(
      (c) => `- ${c.name} [${c.status}] gasto ${c.spend}, ${c.leads} leads, CPL ${c.cpl ?? "—"}, CTR ${c.ctr}%`,
    ),
  ].join("\n");
  const sys =
    "Eres analista de paid media B2B (LinkedIn Ads). Analiza estos datos reales y responde en español, conciso, con esta estructura exacta y encabezados en MAYÚSCULAS:\n" +
    "QUÉ FUNCIONA: (campañas con buen CPL/CTR, con el dato)\n" +
    "QUÉ MALGASTA: (campañas con gasto alto y pocos leads)\n" +
    "RECOMENDACIONES: (3 acciones concretas: escalar, pausar o ajustar, con cifras)\n" +
    "Sin relleno, sin markdown. Basado solo en los números dados.";
  return (await quickReply(sys, data)) || "No se pudo generar el análisis ahora mismo.";
}
