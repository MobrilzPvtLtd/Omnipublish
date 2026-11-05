/**
 * Conector Google Ads (Google Ads API, SOLO LECTURA). Devuelve el mismo shape
 * AdsSummary que metaAds.ts. Reutiliza el mecanismo OAuth de Google (idéntico a
 * youtube.ts: access_type=offline + refresh token) pero con scope `adwords` y un
 * developer token del operador.
 *
 * Credenciales:
 *   - App del stack (GLOBAL): googleads.clientId / googleads.clientSecret /
 *     googleads.developerToken (env GOOGLE_ADS_CLIENT_ID/SECRET/DEVELOPER_TOKEN,
 *     fallback a GOOGLE_CLIENT_ID/SECRET del proyecto de YouTube).
 *   - Per-workspace (SECRET, cifrado): googleads.accessToken / refreshToken /
 *     tokenExpiry / customerId (cuenta activa) / loginCustomerId (MCC) / accounts.
 *
 * GATES externos (owner): developer token con Basic access aprobado + verificación
 * del app OAuth (scope adwords es sensible → cupo de 100 usuarios si NO se verifica,
 * mismo problema que el proyecto leadmatch). Ver plan. Hasta entonces degrada con
 * elegancia (configured:false). La versión de la API (v17) puede requerir bump.
 */
import { get, set, getWorkspaceSetting } from "./settings.js";
import { quickReply } from "./brain.js";
import { gaGet, gaSearch } from "./googleAdsGraph.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AdsSummary, AdsCampaign, AdsRange } from "./metaAds.js";

export interface GoogleAdsAccountEntry {
  customerId: string;        // solo dígitos, sin guiones
  name: string;
  currency: string;
  manager?: boolean;         // cuenta MCC (no tiene campañas propias)
  addedAt?: number;
}

type GaOverride = { customerId: string };
const gaAccALS = new AsyncLocalStorage<GaOverride>();
export function runWithGoogleAdsAccount<T>(o: GaOverride, fn: () => Promise<T>): Promise<T> {
  return gaAccALS.run(o, fn);
}

/** Credenciales de la app del stack (una para todos). developerToken es del operador. */
export function googleAdsAppCreds(): { clientId: string; clientSecret: string; developerToken: string } {
  return {
    clientId: get("googleads.clientId") || process.env.GOOGLE_ADS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: get("googleads.clientSecret") || process.env.GOOGLE_ADS_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "",
    developerToken: get("googleads.developerToken") || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
  };
}

/** ¿Hay OAuth client + developer token configurados (paso único del owner)? */
export function googleAdsConfigured(): boolean {
  const c = googleAdsAppCreds();
  return !!c.clientId && !!c.clientSecret && !!c.developerToken;
}

/** ¿Este workspace tiene conexión Google Ads activa (refresh token + cuenta)? */
export function googleAdsConnected(): boolean {
  return !!get("googleads.refreshToken") && (!!get("googleads.customerId") || googleAdsAccountsList().length > 0);
}

function activeCustomerId(): string {
  const ov = gaAccALS.getStore();
  if (ov && ov.customerId) return ov.customerId;
  return get("googleads.customerId");
}

export function googleAdsAccountsList(wsId?: string): GoogleAdsAccountEntry[] {
  const raw = wsId ? getWorkspaceSetting(wsId, "googleads.accounts", "") : get("googleads.accounts");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((a: any): GoogleAdsAccountEntry | null => {
        const id = String(a?.customerId || a?.id || "").replace(/[^0-9]/g, "");
        if (!id) return null;
        return {
          customerId: id,
          name: String(a?.name || id),
          currency: String(a?.currency || ""),
          manager: !!a?.manager,
          addedAt: typeof a?.addedAt === "number" ? a.addedAt : undefined,
        };
      })
      .filter((x): x is GoogleAdsAccountEntry => x !== null);
  } catch {
    return [];
  }
}

/** Access token fresco (Google Ads: 1h). Refresca con refresh_token si caduca. */
export async function googleAdsFreshToken(): Promise<string> {
  const at = get("googleads.accessToken");
  const exp = Number(get("googleads.tokenExpiry") || 0);
  if (at && Date.now() < exp - 60000) return at;
  const rt = get("googleads.refreshToken");
  const { clientId, clientSecret } = googleAdsAppCreds();
  if (!rt || !clientId || !clientSecret) return at || "";
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId, client_secret: clientSecret }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const d: Record<string, unknown> = await res.json().catch(() => ({}));
    if (res.ok && d.access_token) {
      const nt = String(d.access_token);
      await set("googleads.accessToken", nt);
      await set("googleads.tokenExpiry", String(Date.now() + (Number(d.expires_in) || 3500) * 1000));
      return nt;
    }
  } catch {
    /* best-effort */
  }
  return at || "";
}

// ---- GAQL helpers ------------------------------------------------------------

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Cláusula WHERE de fechas GAQL a partir del rango del panel. */
function gaqlDate(range: AdsRange): { clause: string; label: string } {
  if (typeof range === "object" && range.since && range.until) {
    return { clause: `segments.date BETWEEN '${range.since}' AND '${range.until}'`, label: `${range.since} → ${range.until}` };
  }
  const lit: Record<string, string> = { today: "TODAY", last_7d: "LAST_7_DAYS", last_14d: "LAST_14_DAYS", last_30d: "LAST_30_DAYS" };
  const key = String(range);
  if (lit[key]) return { clause: `segments.date DURING ${lit[key]}`, label: key };
  // last_28d/last_90d u otros last_Nd: sin literal DURING → BETWEEN calculado.
  // FIX id104: antes esta rama devolvía SIEMPRE 90 días hardcoded — con el
  // preset last_28d del date-picker habría mostrado 90 días bajo una etiqueta
  // de 28. Se parsea el N real del preset (fallback 90 para desconocidos).
  const m = /^last_(\d+)d$/.exec(key);
  const n = m ? Math.max(1, Number(m[1])) : 90;
  // METRICAS-1 · N días naturales cerrados (hasta AYER, sin el día en curso) y con el día de Madrid, no el UTC.
  // Antes: [hoy-N, hoy] = N+1 días con hoy parcial.
  const dia = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const [y, mo, d] = dia(Date.now() - 86400000).split("-").map(Number);
  const endStr = dia(Date.UTC(y, mo - 1, d, 12));
  const startStr = dia(Date.UTC(y, mo - 1, d - (n - 1), 12));
  return { clause: `segments.date BETWEEN '${startStr}' AND '${endStr}'`, label: key };
}

export async function googleAdsSummary(range: AdsRange = "last_30d"): Promise<AdsSummary> {
  const { developerToken } = googleAdsAppCreds();
  if (!developerToken) return { configured: false, note: "Falta el developer token de Google Ads (config del admin del stack)." };
  const token = await googleAdsFreshToken();
  if (!token) return { configured: false, note: "Google Ads: falta el token (reconecta la cuenta en Conexiones)." };
  const cid = activeCustomerId();
  if (!cid) return { configured: false, note: "Conecta Google Ads y elige una cuenta en Conexiones." };
  const opts = { accessToken: token, developerToken, loginCustomerId: get("googleads.loginCustomerId") || undefined };
  const { clause, label } = gaqlDate(range);

  // Info de la cuenta.
  const accRes = await gaSearch(cid, "SELECT customer.descriptive_name, customer.currency_code FROM customer", opts);
  if (!accRes.ok) return { configured: false, note: `Google Ads: ${accRes.error}` };
  const accName = String(accRes.data?.[0]?.customer?.descriptiveName || cid);
  const currency = String(accRes.data?.[0]?.customer?.currencyCode || "");

  // KPIs a nivel cuenta (una fila agregada al no seleccionar segments).
  const kpiRes = await gaSearch(cid, `SELECT metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM customer WHERE ${clause}`, opts);
  // Mismo patrón que metaAds: un fallo aquí antes se tragaba en silencio y salía
  // "Gasto 0 · Conversiones 0" como dato real. Error explícito en su lugar.
  if (!kpiRes.ok) return { configured: false, note: `Google Ads: ${kpiRes.error}` };
  const k = kpiRes.data?.[0]?.metrics ?? {};
  const spend = num(k.costMicros) / 1e6;
  const impressions = num(k.impressions);
  const clicks = num(k.clicks);
  const leads = num(k.conversions);

  // Por campaña.
  const campRes = await gaSearch(
    cid,
    `SELECT campaign.name, campaign.status, campaign.advertising_channel_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE ${clause} ORDER BY metrics.cost_micros DESC LIMIT 50`,
    opts,
  );
  // Igual que arriba: sin este guard, un fallo pintaba "Sin campañas en el periodo".
  if (!campRes.ok) return { configured: false, note: `Google Ads: ${campRes.error}` };
  const campaigns: AdsCampaign[] = (campRes.data ?? [])
    .map((r: any): AdsCampaign => {
      const m = r.metrics ?? {};
      const cs = num(m.costMicros) / 1e6;
      const cclicks = num(m.clicks);
      const cimp = num(m.impressions);
      const cleads = num(m.conversions);
      return {
        id: String(r.campaign?.id || ""),
        name: String(r.campaign?.name || "Campaña"),
        status: String(r.campaign?.status || ""),
        objective: String(r.campaign?.advertisingChannelType || ""),
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
        roas: null,
      };
    });

  return {
    configured: true,
    account: accName,
    currency,
    datePreset: label,
    spend: +spend.toFixed(2),
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

// ---- OAuth (Google, offline + refresh) ---------------------------------------

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

export function googleAdsAuthUrl(redirectUri: string, state: string): string {
  const { clientId } = googleAdsAppCreds();
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_ADS_SCOPE,
    access_type: "offline",
    prompt: "consent",              // fuerza refresh_token en cada consentimiento
    include_granted_scopes: "true",
    state,
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}

/** Descubre las cuentas accesibles y resuelve nombre/divisa (best-effort). */
async function discoverAccounts(accessToken: string, developerToken: string): Promise<GoogleAdsAccountEntry[]> {
  const list = await gaGet<any>("customers:listAccessibleCustomers", { accessToken, developerToken });
  if (!list.ok) return [];
  const names: string[] = list.data?.resourceNames ?? [];
  const out: GoogleAdsAccountEntry[] = [];
  let i = 0;
  for (const rn of names) {
    if (i++ >= 15) break;
    const id = String(rn).replace(/[^0-9]/g, "");
    if (!id) continue;
    // Consulta la fila customer con login-customer-id = el propio id (funciona para
    // cuentas directas y para MCCs sobre su propia fila). Best-effort.
    const info = await gaSearch(id, "SELECT customer.descriptive_name, customer.currency_code, customer.manager FROM customer", {
      accessToken, developerToken, loginCustomerId: id,
    });
    const c = info.ok ? (info.data?.[0]?.customer ?? {}) : {};
    out.push({
      customerId: id,
      name: String(c.descriptiveName || id),
      currency: String(c.currencyCode || ""),
      manager: !!c.manager,
      addedAt: Date.now(),
    });
  }
  return out;
}

export async function googleAdsExchangeCode(code: string, redirectUri: string): Promise<{ ok: boolean; error?: string; accountsFound?: number }> {
  const { clientId, clientSecret, developerToken } = googleAdsAppCreds();
  if (!clientId || !clientSecret) return { ok: false, error: "Falta el OAuth client de Google (googleads.clientId / clientSecret)." };
  let d: Record<string, unknown> = {};
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }).toString(),
      signal: AbortSignal.timeout(12000),
    });
    d = await res.json().catch(() => ({}));
    if (!res.ok || !d.access_token) return { ok: false, error: String(d.error_description || d.error || "token exchange falló") };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const accessToken = String(d.access_token);
  await set("googleads.accessToken", accessToken);
  await set("googleads.tokenExpiry", String(Date.now() + (Number(d.expires_in) || 3500) * 1000));
  if (d.refresh_token) await set("googleads.refreshToken", String(d.refresh_token));
  let accounts: GoogleAdsAccountEntry[] = [];
  if (developerToken) {
    try { accounts = await discoverAccounts(accessToken, developerToken); } catch { accounts = []; }
  }
  if (accounts.length) {
    await set("googleads.accounts", JSON.stringify(accounts));
    // Cuenta operable por defecto = primera no-manager; MCC (manager) → loginCustomerId.
    const client = accounts.find((a) => !a.manager) || accounts[0];
    if (!get("googleads.customerId")) await set("googleads.customerId", client.customerId);
    const mgr = accounts.find((a) => a.manager);
    if (mgr && !get("googleads.loginCustomerId")) await set("googleads.loginCustomerId", mgr.customerId);
  }
  return { ok: true, accountsFound: accounts.length };
}

export async function googleAdsSelectAccount(customerId: string): Promise<boolean> {
  const id = String(customerId || "").replace(/[^0-9]/g, "");
  if (!id) return false;
  if (!googleAdsAccountsList().some((a) => a.customerId === id)) return false;
  await set("googleads.customerId", id);
  return true;
}

export async function googleAdsDisconnect(): Promise<void> {
  for (const k of ["googleads.accessToken", "googleads.refreshToken", "googleads.tokenExpiry", "googleads.customerId", "googleads.loginCustomerId", "googleads.accounts"]) {
    await set(k, "");
  }
}

export async function analyzeGoogleAds(): Promise<string> {
  const s = await googleAdsSummary();
  if (!s.configured) return s.note || "Google Ads no configurado.";
  const data = [
    `Cuenta ${s.account} (${s.currency}). Rango ${s.datePreset}:`,
    `Gasto ${s.spend} · Impresiones ${s.impressions} · Clics ${s.clicks} · CTR ${s.ctr}% · CPC ${s.cpc}`,
    `Conversiones ${s.leads} · Coste/conversión ${s.cpl ?? "—"}`,
    "",
    "Campañas (por gasto):",
    ...(s.campaigns ?? []).slice(0, 8).map(
      (c) => `- ${c.name} [${c.status}] gasto ${c.spend}, ${c.leads} conv, coste/conv ${c.cpl ?? "—"}, CTR ${c.ctr}%`,
    ),
  ].join("\n");
  const sys =
    "Eres analista de Google Ads (search/performance max). Analiza estos datos reales y responde en español, conciso, con esta estructura exacta y encabezados en MAYÚSCULAS:\n" +
    "QUÉ FUNCIONA: (campañas con buen coste/conversión y CTR)\n" +
    "QUÉ MALGASTA: (campañas con gasto alto y pocas conversiones)\n" +
    "RECOMENDACIONES: (3 acciones concretas con cifras)\n" +
    "Sin relleno, sin markdown. Basado solo en los números dados.";
  return (await quickReply(sys, data)) || "No se pudo generar el análisis ahora mismo.";
}
