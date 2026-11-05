/**
 * Snapshots diarios de métricas clave para alimentar la tendencia % en los
 * tiles del dashboard (vs hace 7 días).
 *
 * - `runDailySnapshot(tenant)` captura todos los counts y los guarda en
 *   `app_daily_snapshots(tenant_id, snap_date, metric, value)`.
 * - `getTrend(metric, days=7)` devuelve {current, previous, deltaPct} para
 *   pintar la flecha verde/roja + porcentaje.
 *
 * El worker arranca en `main()` y dispara una vez al día (cron interno
 * comparando última fecha guardada).
 */
import * as pg from "pg";
import { pgSsl } from "./pg-ssl.js";
import { dbContactStats, dbCountConversations, dbListAutomations, dbListSequences, dbListScheduledPosts } from "./db.js";
import { listWaAutomations } from "./waflows.js";
import { listIgAccounts } from "./instagram.js";
// HARD-2: el worker de snapshots ahora itera por workspace activo igual que el
// analytics warmer, abriendo scope ALS para que las helpers per-WS lean settings
// del tenant correcto. Si la BD multi-tenant no está lista cae a 'default' (regression-free).
import { runWithWorkspace, listWorkspacesCached } from "./workspace.js";

const dbUrl = process.env.DATABASE_URL;
const pool = dbUrl
  ? new pg.default.Pool({
      connectionString: dbUrl,
      ssl: pgSsl(),
      max: 2,
    })
  : null;

// Cache en memoria para fallback sin DB.
const memSnaps: Array<{ tenant_id: string; snap_date: string; metric: string; value: number }> = [];

// METRICAS-1 · el día de un snapshot es el de Madrid, no el de la zona del servidor (UTC en Railway):
// entre las 00:00 y las 02:00 de Madrid el snapshot caía en el día anterior y pisaba su cierre.
const DIA_MADRID = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });
function ymdMadrid(d: Date): string {
  return DIA_MADRID.format(d);
}
function todayKey(): string {
  return ymdMadrid(new Date());
}

// pg devuelve snap_date como OBJETO Date: String(date).slice(0,10) daba «Wed Aug 12»
// (visto en prod) — claves que nunca casan con todayKey() y fechas rotas en la UI.
// Normaliza SIEMPRE a YYYY-MM-DD en hora local (coherente con todayKey).
function dateKey(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(+d)) return String(v).slice(0, 10);
  return ymdMadrid(d);
}

async function captureMetrics(tenant = "default"): Promise<Record<string, number>> {
  // FIX id109/id110: capturar con las MISMAS fuentes/fórmulas que el endpoint
  // /admin/api/dashboard (admin.ts) manda como `current` de cada trend — si
  // divergen, el delta % compara poblaciones desiguales:
  //   · contacts.*: antes listContacts(5000) capaba el histórico y, superado el
  //     cap, el delta pintaba crecimiento fantasma permanente (3.500 actuales
  //     vs snapshot congelado en 5.000/2.000). dbContactStats = COUNT real.
  //   · conversations.total: COUNT real (ya corregido antes).
  //   · automations.total: el current del dashboard es waAuts.length (solo
  //     WhatsApp); el snapshot guardaba TODAS las plataformas. Alineado a
  //     listWaAutomations().
  //   · ig.automations_active: mismo filtro que el dashboard (enabled Y
  //     platform !== 'whatsapp'; la tabla compartida inflaba la clave con
  //     disparadores WA).
  // Si cambia una fórmula del dashboard, cambiar AMBOS lados a la vez.
  const cstats = await dbContactStats();
  const convsTotal = await dbCountConversations();
  const waAuts = await listWaAutomations();
  const autos = await dbListAutomations();
  const seqs = await dbListSequences();
  const scheds = await dbListScheduledPosts();
  return {
    "contacts.total": cstats.total,
    "contacts.in_window": cstats.inWindow,
    "contacts.in_human_mode": cstats.human,
    "conversations.total": convsTotal,
    "automations.total": waAuts.length,
    "sequences.total": seqs.length,
    "ig.accounts": listIgAccounts().length,
    "ig.automations_active": autos.filter((a) => (a as Record<string, unknown>).enabled && (a as Record<string, unknown>).platform !== "whatsapp").length,
    "scheduled.pending": scheds.filter((p) => p.status === "pending").length,
    "scheduled.published": scheds.filter((p) => p.status === "published").length,
  };
}

/**
 * SEGUIDORES-DASH-1 · recuento diario de seguidores de cada cuenta conectada:
 * ig_followers_<id>, fb_followers_<pageId>, li_followers_<orgId>. Facebook y LinkedIn no dan
 * «nuevos por día»: el Panel de control los saca restando estos recuentos. Importa facebook.js y
 * linkedin en diferido porque esos módulos importan a este.
 */
export async function captureFollowers(tenant = "default"): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const tope = <T,>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  try {
    const { graphFollowers } = await import("./seguidores.js");
    for (const a of listIgAccounts().slice(0, 10)) {
      const n = await tope(graphFollowers(a.igId, a.token), 8000);
      if (n != null) out[`ig_followers_${a.igId}`] = n;
    }
    const { listFbAccounts } = await import("./facebook.js");
    for (const p of listFbAccounts().slice(0, 10)) {
      const n = await tope(graphFollowers(p.pageId, p.token), 8000);
      if (n != null) out[`fb_followers_${p.pageId}`] = n;
    }
  } catch (e) {
    console.warn("[snapshots] seguidores Meta:", (e as Error).message);
  }
  try {
    const { linkedinCmOrgsList, linkedinCmFreshToken } = await import("./linkedinCommunity.js");
    const orgs = linkedinCmOrgsList().slice(0, 10);
    if (orgs.length) {
      const token = await tope(linkedinCmFreshToken(), 8000);
      if (token) {
        const { liGet } = await import("./linkedinAdsGraph.js");
        for (const o of orgs) {
          const r = await tope(liGet<{ firstDegreeSize?: number }>(`networkSizes/${encodeURIComponent("urn:li:organization:" + o.orgId)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, { token, timeoutMs: 8000 }), 9000);
          const n = r && r.ok && r.data ? Number(r.data.firstDegreeSize) : NaN;
          if (Number.isFinite(n)) out[`li_followers_${o.orgId}`] = n;
        }
      }
    }
  } catch (e) {
    console.warn("[snapshots] seguidores LinkedIn:", (e as Error).message);
  }
  void tenant;
  return out;
}

export async function runDailySnapshot(tenant = "default"): Promise<void> {
  const date = todayKey();
  const metrics = { ...(await captureMetrics(tenant)), ...(await captureFollowers(tenant)) };
  if (!pool) {
    for (const [metric, value] of Object.entries(metrics)) {
      const i = memSnaps.findIndex((s) => s.tenant_id === tenant && s.snap_date === date && s.metric === metric);
      if (i >= 0) memSnaps[i].value = value;
      else memSnaps.push({ tenant_id: tenant, snap_date: date, metric, value });
    }
    return;
  }
  for (const [metric, value] of Object.entries(metrics)) {
    await pool.query(
      `INSERT INTO app_daily_snapshots (tenant_id,snap_date,metric,value)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id,snap_date,metric) DO UPDATE SET value=EXCLUDED.value`,
      [tenant, date, metric, value],
    );
  }
}

/**
 * Devuelve la tendencia de una métrica vs hace `days` días.
 * Si no hay snapshot histórico, devuelve current+0% para no falsear datos.
 */
export async function getTrend(metric: string, current: number, days = 7, tenant = "default"): Promise<{ current: number; previous: number | null; deltaPct: number | null }> {
  const past = new Date();
  past.setDate(past.getDate() - days);
  const pastKey = ymdMadrid(past);
  let prev: number | null = null;
  if (!pool) {
    const s = memSnaps.find((x) => x.tenant_id === tenant && x.snap_date === pastKey && x.metric === metric);
    prev = s ? s.value : null;
  } else {
    const r = await pool.query(
      `SELECT value FROM app_daily_snapshots WHERE tenant_id=$1 AND snap_date<=$2 AND metric=$3 ORDER BY snap_date DESC LIMIT 1`,
      [tenant, pastKey, metric],
    );
    prev = r.rows[0] ? Number(r.rows[0].value) : null;
  }
  let deltaPct: number | null = null;
  if (prev !== null && prev !== 0) deltaPct = Math.round(((current - prev) / prev) * 100);
  else if (prev === 0 && current > 0) deltaPct = 100;
  else if (prev === null) deltaPct = null;
  return { current, previous: prev, deltaPct };
}

/** Para todas las métricas: { metric: trend } a partir del bundle de counts del dashboard. */
export async function getTrendsBundle(currents: Record<string, number>, days = 7, tenant = "default"): Promise<Record<string, { current: number; previous: number | null; deltaPct: number | null }>> {
  const out: Record<string, { current: number; previous: number | null; deltaPct: number | null }> = {};
  for (const [metric, current] of Object.entries(currents)) {
    out[metric] = await getTrend(metric, current, days, tenant);
  }
  return out;
}

/** Upsert de UNA métrica para HOY (idempotente por fecha). Para snapshots
 *  oportunistas: p.ej. fans de una Page FB cada vez que se cargan sus métricas —
 *  Meta no da histórico sin App Review, así que la serie la construimos nosotros. */
export async function saveMetricSnapshot(metric: string, value: number, tenant = "default"): Promise<void> {
  const date = todayKey();
  if (!pool) {
    const i = memSnaps.findIndex((s) => s.tenant_id === tenant && s.snap_date === date && s.metric === metric);
    if (i >= 0) memSnaps[i].value = value;
    else memSnaps.push({ tenant_id: tenant, snap_date: date, metric, value });
    return;
  }
  await pool.query(
    `INSERT INTO app_daily_snapshots (tenant_id,snap_date,metric,value)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id,snap_date,metric) DO UPDATE SET value=EXCLUDED.value`,
    [tenant, date, metric, value],
  );
}

/** Serie {date,value} de una métrica — SOLO días con snapshot (sin rellenar con
 *  ceros: para métricas acumulativas como fans, un 0 de relleno sería mentira). */
export async function getSnapshotSeries(metric: string, days = 30, tenant = "default"): Promise<Array<{ date: string; value: number }>> {
  if (!pool) {
    return memSnaps
      .filter((s) => s.tenant_id === tenant && s.metric === metric)
      .sort((a, b) => a.snap_date.localeCompare(b.snap_date))
      .slice(-days)
      .map((s) => ({ date: s.snap_date, value: s.value }));
  }
  const r = await pool.query(
    `SELECT snap_date, value FROM app_daily_snapshots
     WHERE tenant_id=$1 AND metric=$2 AND snap_date>=current_date - $3::int
     ORDER BY snap_date ASC`,
    [tenant, metric, days],
  );
  return r.rows.map((row: any) => ({ date: dateKey(row.snap_date), value: Number(row.value) }));
}

/** Sparkline simple: últimos N valores diarios de una métrica. */
export async function getSparkline(metric: string, days = 14, tenant = "default"): Promise<number[]> {
  if (!pool) {
    const out: number[] = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const key = ymdMadrid(d);
      const s = memSnaps.find((x) => x.tenant_id === tenant && x.snap_date === key && x.metric === metric);
      out.push(s ? s.value : 0);
    }
    return out;
  }
  const r = await pool.query(
    `SELECT snap_date, value FROM app_daily_snapshots
     WHERE tenant_id=$1 AND metric=$2 AND snap_date>=current_date - $3::int
     ORDER BY snap_date ASC`,
    [tenant, metric, days],
  );
  // Re-relleno con 0s en huecos para una sparkline consistente.
  const map = new Map<string, number>();
  for (const row of r.rows) map.set(dateKey(row.snap_date), Number(row.value));
  const out: number[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = ymdMadrid(d);
    out.push(map.get(key) ?? 0);
  }
  return out;
}

/* ------------ Worker ------------ */
let snapsStarted = false;

/** Arranca el worker que toma 1 snapshot al día (en boot + cada 6h chequea). */
export function startSnapshotWorker(): void {
  if (snapsStarted) return;
  snapsStarted = true;
  const tick = async () => {
    try {
      // HARD-2: itera por workspace activo y captura snapshot por cada uno,
      // dentro de su scope ALS. Sin BD/workspaces → solo 'default' (regression-zero).
      // Mismo patrón que startAnalyticsWarmer en analytics.ts.
      let workspaces: { id: string }[] = [{ id: "default" }];
      try {
        const wss = await listWorkspacesCached();
        if (wss.length) workspaces = wss.map((w) => ({ id: w.id }));
      } catch {
        // BD no disponible o tabla aún no creada → solo 'default'.
      }
      const today = todayKey();
      for (const ws of workspaces) {
        await runWithWorkspace(ws.id, async () => {
          let alreadyCaptured = false;
          if (pool) {
            const r = await pool.query(
              `SELECT 1 FROM app_daily_snapshots WHERE tenant_id=$1 AND snap_date=$2 AND metric=$3 LIMIT 1`,
              [ws.id, today, "contacts.total"],
            );
            alreadyCaptured = (r.rowCount ?? 0) > 0;
          } else {
            alreadyCaptured = memSnaps.some((s) => s.tenant_id === ws.id && s.snap_date === today && s.metric === "contacts.total");
          }
          if (!alreadyCaptured) {
            await runDailySnapshot(ws.id);
            console.log("[snapshots] capturado snapshot diario", today, "ws=", ws.id);
          }
        });
      }
    } catch (e) {
      console.error("[snapshots] err:", (e as Error).message);
    } finally {
      setTimeout(tick, 6 * 60 * 60 * 1000); // cada 6h
    }
  };
  // Primer tick a los 30s para no bloquear boot.
  setTimeout(tick, 30_000);
  console.log("[snapshots] worker arrancado (cada 6h, idempotente por fecha, por workspace)");
}
