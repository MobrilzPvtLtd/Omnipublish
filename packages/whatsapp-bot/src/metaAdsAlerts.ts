/**
 * meta-ads-pro FASE A5 — Worker de alertas configurables sobre Meta Ads.
 *
 * El operador define reglas (cpc>0.50, conversions<5, spend>100…) sobre un
 * scope (account/campaign/adset/ad). Cada 15 minutos (scheduler.ts) este
 * worker:
 *
 *   1) Itera workspaces activos (`listWorkspacesCached`).
 *   2) Por cada WS abre `runWithWorkspace(wsId, ...)` para que toda la
 *      telemetría caiga con su tenant_id correcto (no el de 'default').
 *   3) Pide alertas habilitadas del WS (`dbListAlerts`).
 *   4) Por cada alerta:
 *      - Resuelve la ad account → `runWithAdsAccount` para que graphGet
 *        use el bearer per-account ws-aware.
 *      - Pide insights del scope con cache 5 min (in-memory por WS+scope+
 *        scopeId). Las alertas comparten cache cuando coinciden — evita
 *        rate-limit Marketing API.
 *      - Compara `metric` con `operator threshold`. Si dispara:
 *          a) `dbInsertAlertLog({ status:'fired', value })`
 *          b) `dbTouchAlertFired(id)` para que la UI muestre "ult. disparo"
 *          c) `logActivity({ source:'meta-api', level:'warn', summary,
 *             payload:{value, threshold, alertId, scope} })`. NUNCA
 *             access_token en payload — `_redacted` lo recuerda.
 *          d) Si channel='whatsapp', `sendText` al `ads.alerts.ownerPhone`
 *             per-WS (silencioso si no configurado).
 *          e) Si channel='email', skip silencioso (no hay infra email).
 *
 * Anti-spam: dentro del mismo tick (15min) la misma alerta NO dispara dos
 * veces; el evaluador usa `enabled` + `last_fired_at` solo a nivel UI — el
 * scheduler ya marca el ritmo. Logactivity tiene su propio dedup de 60s
 * (telemetría limpia).
 *
 * Reglas (heredadas de BIG-1/2/3 + A1-A4):
 *   - `tenant_id` SIEMPRE viaja por ALS (runWithWorkspace) — el helper lo
 *     lee con `currentWorkspaceId()`.
 *   - `runWithAdsAccount(adAccountId, token)` envuelve cada call Graph.
 *   - Nada de access_token en logActivity.payload — `_redacted` siempre.
 *   - Errores Graph se TRAGAN aquí y se vuelcan a `logActivity` level
 *     'error'. NUNCA propagan al scheduler (telemetría no rompe el bot).
 */
import { graphGet } from "./metaAdsGraph.js";
import { logActivity } from "./activity.js";
import { metaAdsAccountsList, runWithAdsAccount, pickAction, pickLeadCount, pickPurchaseCount } from "./metaAds.js";
import { listWorkspacesCached, runWithWorkspace } from "./workspace.js";
import { getWorkspaceSetting } from "./settings.js";
import { sendText } from "./whatsapp.js";
import {
  dbListAlerts,
  dbInsertAlertLog,
  dbTouchAlertFired,
  type AdsAlertRow,
  type AdsAlertMetric,
  type AdsAlertOperator,
  type AdsAlertScope,
} from "./db.js";

/**
 * TTL del cache de insights por scope. 5 min es el sweet spot entre:
 *   - rate-limit Marketing API (Meta cuenta read-calls/hora por app),
 *   - latencia percibida (un disparo nuevo se ve en <=20 min).
 * Si el operador quiere ventana más corta, el scheduler manda — pero el
 * cache evita pegar a Graph N veces por las N alertas del MISMO scope.
 */
const INSIGHTS_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheKey = string; // `${wsId}|${adAccountId}|${scope}|${scopeId}`

interface InsightsSnapshot {
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  cpc: number | null;
  ctr: number | null;
  conversions: number;
}

interface CacheEntry {
  at: number;
  data: InsightsSnapshot | null; // null = call falló o sin delivery
}

const insightsCache = new Map<CacheKey, CacheEntry>();

/** Forma de la cache key: WS + adAccount + scope + scopeId (o '_acc'). */
function cacheKeyFor(
  wsId: string,
  adAccountId: string,
  scope: AdsAlertScope,
  scopeId: string | null,
): CacheKey {
  return `${wsId}|${adAccountId}|${scope}|${scopeId || "_acc"}`;
}

/** Prefija `act_` si scope='account', si no usa el id raw del scope. */
function buildInsightsPath(
  adAccountId: string,
  scope: AdsAlertScope,
  scopeId: string | null,
): string | null {
  const acc = String(adAccountId || "").trim();
  if (!acc) return null;
  if (scope === "account") {
    const clean = acc.startsWith("act_") ? acc.slice(4) : acc;
    return `act_${clean}/insights`;
  }
  // campaign/adset/ad: el endpoint es <id>/insights directo.
  const sid = String(scopeId || "").trim();
  if (!sid) return null;
  return `${sid}/insights`;
}

/**
 * Suma actions[] de Meta para los tipos que cuentan como "conversión"
 * (mismo set que en metaAdsExperiments.getExperimentKpis para coherencia
 * cross-feature: si un experimento contó N conversiones, una alerta
 * sobre el mismo ad contará igual N).
 */
function sumConversionActions(actions: unknown): number {
  // METRICAS-1 · los mismos contadores canónicos que experimentos (id108): antes se sumaba la fila
  // agregada «lead» más sus subtipos y cualquier offsite_/onsite_ (ver contenido, conversaciones…),
  // y una alerta «conversiones > 50» saltaba con 10 conversiones reales.
  if (!Array.isArray(actions)) return 0;
  return pickLeadCount(actions) + pickPurchaseCount(actions) + (pickAction(actions, "complete_registration") ?? 0);
}

/**
 * Pide insights de un scope a Meta. Si está en cache (<5min), devuelve
 * el snapshot cacheado. Si Graph falla, cacheamos `null` durante el TTL
 * para no martillarlo en cada alert del mismo scope.
 *
 * Lifetime preset: `date_preset=maximum` (las alertas son sobre KPIs
 * acumulativos del scope; el operador define "spend>100 esta campaña").
 * Si en el futuro queremos ventana corta (last_7d), se añade por alert.
 */
async function getInsightsCached(
  wsId: string,
  adAccountId: string,
  scope: AdsAlertScope,
  scopeId: string | null,
): Promise<InsightsSnapshot | null> {
  const key = cacheKeyFor(wsId, adAccountId, scope, scopeId);
  const now = Date.now();
  const hit = insightsCache.get(key);
  if (hit && now - hit.at < INSIGHTS_CACHE_TTL_MS) return hit.data;

  const path = buildInsightsPath(adAccountId, scope, scopeId);
  if (!path) {
    insightsCache.set(key, { at: now, data: null });
    return null;
  }
  const fields = "spend,impressions,clicks,reach,cpc,ctr,actions";
  const r = await graphGet<{ data?: any[] }>(path, {
    fields,
    date_preset: "maximum",
  });
  if (!r.ok) {
    // 400 sin delivery: cacheamos null silencioso (no es error real).
    // 401/403/500: cacheamos null TAMBIÉN para no martillar — pero logueamos.
    if (r.status && r.status !== 400) {
      await logActivity({
        source: "meta-api",
        level: "error",
        summary: `alerts:insights fetch failed scope=${scope} — ${r.error}`.slice(
          0,
          200,
        ),
        payload: {
          adAccountId,
          scope,
          scopeId,
          status: r.status,
          _redacted: ["access_token"],
        },
      });
    }
    insightsCache.set(key, { at: now, data: null });
    return null;
  }
  const arr = Array.isArray(r.data?.data) ? r.data!.data! : [];
  if (!arr.length) {
    insightsCache.set(key, { at: now, data: null });
    return null;
  }
  const d = arr[0] || {};
  const spend = Number(d.spend) || 0;
  const impressions = Number(d.impressions) || 0;
  const clicks = Number(d.clicks) || 0;
  const reach = Number(d.reach) || 0;
  const cpc =
    d.cpc != null ? Number(d.cpc) : clicks > 0 ? spend / clicks : null;
  const ctr =
    d.ctr != null
      ? Number(d.ctr)
      : impressions > 0
        ? (clicks / impressions) * 100
        : null;
  const conversions = sumConversionActions(d.actions);
  const snap: InsightsSnapshot = {
    spend,
    impressions,
    clicks,
    reach,
    cpc,
    ctr,
    conversions,
  };
  insightsCache.set(key, { at: now, data: snap });
  return snap;
}

/** Extrae el valor de la métrica del snapshot, o null si no comparable. */
function pickMetric(snap: InsightsSnapshot, metric: AdsAlertMetric): number | null {
  switch (metric) {
    case "cpc":
      return snap.cpc;
    case "ctr":
      return snap.ctr;
    case "conversions":
      return snap.conversions;
    case "spend":
      return snap.spend;
    case "reach":
      return snap.reach;
    default:
      return null;
  }
}

/** Compara `value` con `threshold` aplicando el operador. */
function compare(
  value: number,
  op: AdsAlertOperator,
  threshold: number,
): boolean {
  // Tolerancia para '=': fp comparisons exactos son frágiles. 0.001 es
  // suficiente para todas las métricas (cpc/ctr en decimales, conversions
  // que son enteros, spend/reach que rara vez serán exactos).
  const EPS = 0.001;
  switch (op) {
    case ">":
      return value > threshold;
    case "<":
      return value < threshold;
    case ">=":
      return value >= threshold;
    case "<=":
      return value <= threshold;
    case "=":
      return Math.abs(value - threshold) <= EPS;
    default:
      return false;
  }
}

/** Texto humano descriptivo del scope para summary y mensaje WA. */
function scopeLabel(scope: AdsAlertScope, scopeId: string | null): string {
  if (scope === "account") return "toda la cuenta";
  const tail = String(scopeId || "").slice(-10);
  return `${scope} ${tail}`;
}

/**
 * Envía notificación WhatsApp al ownerPhone configurado per-WS.
 * Silencioso si no hay phone configurado (la UI debe avisar al operador
 * que rellene `ads.alerts.ownerPhone` para activar este canal).
 */
async function notifyWhatsApp(
  wsId: string,
  alert: AdsAlertRow,
  value: number,
): Promise<void> {
  const phone = String(getWorkspaceSetting(wsId, "ads.alerts.ownerPhone", "") || "").trim();
  if (!phone) return; // no configurado → skip silencioso
  // Mensaje conciso: 1 línea por humano. Sin links (evitamos wrapUrlsInText).
  const sl = scopeLabel(alert.scope, alert.scope_id);
  const body =
    `Alerta Meta Ads · ${alert.name || alert.metric}: ${alert.metric}=${value.toFixed(2)} ` +
    `${alert.operator} ${alert.threshold} (${sl})`;
  try {
    await sendText(phone, body.slice(0, 1000), {
      skipVars: true,
      skipLinkWrap: true,
    });
  } catch {
    // sendText ya loguea su error en activity. No re-emitimos: doble ruido.
  }
}

/**
 * Evalúa todas las alertas habilitadas del WS dado. Llamado desde el
 * scheduler (cada 15min) dentro de su propio `runWithWorkspace(wsId)`.
 *
 * Devuelve la cantidad de disparos para que el caller pueda loguear
 * un summary agregado si quiere ("WS X · 3 alertas dispararon").
 */
export async function evaluateAlertsForWs(wsId: string): Promise<number> {
  const tenantId = (wsId || "default").trim() || "default";
  let fired = 0;
  let alerts: AdsAlertRow[] = [];
  try {
    alerts = await dbListAlerts({ tenantId, enabled: true });
  } catch (e) {
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `alerts:list failed — ${(e as Error).message}`.slice(0, 200),
      payload: { wsId: tenantId, _redacted: ["access_token"] },
    });
    return 0;
  }
  if (!alerts.length) return 0;

  // Agrupamos por ad_account_id para abrir runWithAdsAccount una vez por
  // cuenta — los snapshots de insights se cachean cross-alert dentro del
  // mismo scope.
  const byAccount = new Map<string, AdsAlertRow[]>();
  for (const a of alerts) {
    if (!a.ad_account_id) continue;
    const list = byAccount.get(a.ad_account_id) ?? [];
    list.push(a);
    byAccount.set(a.ad_account_id, list);
  }

  const accounts = metaAdsAccountsList(tenantId);
  for (const [adAccountId, group] of byAccount) {
    // Ownership defensivo: si la cuenta ya no pertenece al WS (eliminada
    // post-creación de la alerta), saltamos silenciosamente las alertas
    // de esa cuenta. No las borramos automáticamente — el operador
    // decide qué hacer.
    const entry = accounts.find((a) => a.adAccountId === adAccountId);
    if (!entry) continue;
    await runWithAdsAccount({ adAccountId, token: entry.token }, async () => {
      for (const alert of group) {
        try {
          const snap = await getInsightsCached(
            tenantId,
            adAccountId,
            alert.scope,
            alert.scope_id,
          );
          if (!snap) continue; // sin datos comparables → no dispara
          const value = pickMetric(snap, alert.metric);
          if (value == null || !Number.isFinite(value)) continue;
          if (!compare(value, alert.operator, alert.threshold)) continue;

          // Disparo confirmado: log + actividad + notificación canal.
          fired += 1;
          const firedAtMs = Date.now();
          try {
            await dbInsertAlertLog({
              tenant_id: tenantId,
              alert_id: alert.id,
              value,
              status: "fired",
              firedAtMs,
            });
            await dbTouchAlertFired({
              id: alert.id,
              tenantId,
              whenMs: firedAtMs,
            });
          } catch (e) {
            await logActivity({
              source: "meta-api",
              level: "error",
              summary: `alerts:log insert failed — ${(e as Error).message}`.slice(
                0,
                200,
              ),
              payload: {
                alertId: alert.id,
                value,
                _redacted: ["access_token"],
              },
            });
            // sigue: si DB log falla, la notificación al menos llega.
          }

          const sl = scopeLabel(alert.scope, alert.scope_id);
          const summary =
            `Alert ${alert.name || alert.metric}: ${alert.metric}=${value.toFixed(2)} ` +
            `${alert.operator} ${alert.threshold} (${sl})`;
          await logActivity({
            source: "meta-api",
            level: "warn",
            summary: summary.slice(0, 200),
            payload: {
              alertId: alert.id,
              name: alert.name,
              metric: alert.metric,
              operator: alert.operator,
              threshold: alert.threshold,
              value,
              scope: alert.scope,
              scopeId: alert.scope_id,
              channel: alert.channel,
              adAccountId,
              _redacted: ["access_token"],
            },
          });

          // Notificación por canal. 'panel' ya queda cubierto por
          // logActivity (badge nav). 'whatsapp' envía al ownerPhone.
          // 'email' es skip silencioso (sin infra email).
          if (alert.channel === "whatsapp") {
            await notifyWhatsApp(tenantId, alert, value);
          }
        } catch (e) {
          // Capturamos cualquier excepción por-alerta para no abortar el
          // resto del grupo. logActivity con _redacted.
          await logActivity({
            source: "meta-api",
            level: "error",
            summary: `alerts:eval exception — ${(e as Error).message}`.slice(
              0,
              200,
            ),
            payload: {
              alertId: alert.id,
              metric: alert.metric,
              _redacted: ["access_token"],
            },
          });
        }
      }
    });
  }
  return fired;
}

/**
 * Itera TODOS los workspaces activos y evalúa sus alertas. Llamado desde
 * scheduler.ts cada 15 minutos. Wrapping `runWithWorkspace(wsId)`
 * garantiza que logActivity caiga con el tenant correcto.
 *
 * Devuelve el total de disparos acumulados (útil para tests/telemetría
 * agregada; el scheduler ignora el return).
 */
export async function evaluateAllAlerts(): Promise<number> {
  let total = 0;
  let workspaces: { id: string }[] = [];
  try {
    workspaces = await listWorkspacesCached();
  } catch (e) {
    // Sin scope abierto: cae a 'default'. Es el único caso donde queremos
    // que el fallback sea 'default' — no hay WS al que asociar el fallo.
    await logActivity({
      source: "meta-api",
      level: "error",
      summary: `alerts:list workspaces failed — ${(e as Error).message}`.slice(
        0,
        200,
      ),
      payload: { _redacted: ["access_token"] },
    });
    return 0;
  }
  for (const ws of workspaces) {
    if (!ws.id || ws.id === "_global_") continue; // _global_ no es un WS real
    const count = await runWithWorkspace(ws.id, async () =>
      evaluateAlertsForWs(ws.id),
    );
    total += count;
  }
  return total;
}

// ---- Test seam ---------------------------------------------------------

/** Solo para tests: limpiar el cache de insights. NO usar desde producción. */
export const __internal = {
  insightsCache,
  INSIGHTS_CACHE_TTL_MS,
  clearInsightsCache(): void {
    insightsCache.clear();
  },
};
