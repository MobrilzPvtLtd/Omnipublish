/**
 * Programación recurrente del autopost. Cada 60s comprueba si toca publicar
 * según la cadencia configurada y, si toca, genera+publica un carrusel nuevo y
 * recalcula la próxima fecha. Equivale a las scheduled tasks del skill.
 */
import { get, set } from "../settings.js";
import { publishNow } from "./index.js";
import { runWithWorkspace, listWorkspacesCached } from "../workspace.js";

/**
 * ZONA-HORARIA-AUTOPOST-1 · obtiene la zona horaria del programador: la propia si alguna
 * vez se guardó, si no la del negocio (`biz.timezone`, la misma que usan la agenda y las
 * reuniones) y, en último caso, Europe/Madrid. El panel no tiene control propio de zona
 * para el programador, así que en la práctica manda la zona del negocio.
 * Valida que sea un nombre IANA válido usando Intl.DateTimeFormat.
 */
export function autopostTimeZone(): string {
  const tz = String(get("autopost.timezone") || "").trim() || String(get("biz.timezone") || "").trim() || "Europe/Madrid";
  try {
    new Intl.DateTimeFormat("es", { timeZone: String(tz) }).format(new Date());
    return String(tz);
  } catch {
    return "Europe/Madrid";
  }
}

const CADENCE_DAYS: Record<string, number[]> = {
  daily: [0, 1, 2, 3, 4, 5, 6],
  "3xweek": [1, 3, 5], // Lun/Mié/Vie
  "2xweek": [2, 5],    // Mar/Vie
  weekly: [1],         // Lun
};

export function cadenceDays(cadence: string): number[] {
  return CADENCE_DAYS[cadence] || CADENCE_DAYS["3xweek"];
}

/**
 * Resuelve los días activos: si `daysOverride` viene (array 0-6, dom=0)
 * y tiene al menos 1 día válido, lo usa. Si no, cae a CADENCE_DAYS[cadence].
 */
export function resolveDays(cadence: string, daysOverride?: number[] | null): number[] {
  if (Array.isArray(daysOverride)) {
    const clean = daysOverride
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    const uniq = Array.from(new Set(clean));
    if (uniq.length > 0) return uniq.sort((a, b) => a - b);
  }
  return cadenceDays(cadence);
}

/**
 * ZONA-HORARIA-AUTOPOST-1 · obtiene la hora local (en la zona especificada) de un timestamp.
 * Devuelve { y, m (0-11), d, h, min, dayOfWeek (0-6, dom=0) }.
 */
function getLocalDateTime(timestamp: number, timeZone: string): { y: number; m: number; d: number; h: number; min: number; dayOfWeek: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const y = parseInt(parts.find((p) => p.type === "year")?.value || "2026", 10);
  const m = parseInt(parts.find((p) => p.type === "month")?.value || "1", 10) - 1;
  const d = parseInt(parts.find((p) => p.type === "day")?.value || "1", 10);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const min = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  const weekdayMap: Record<string, number> = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
  };
  const weekday = parts.find((p) => p.type === "weekday")?.value || "Sunday";
  const dayOfWeek = weekdayMap[weekday] ?? 0;
  return { y, m, d, h, min, dayOfWeek };
}

/**
 * Calcula el próximo timestamp de ejecución respetando la zona horaria.
 * Acepta minuto opcional (0/15/30/45 típico, clampado 0-59) y array de días opcional.
 * Si `daysOverride` está presente y no vacío, ignora el preset `cadence`.
 * Si `timeZone` no es válido, usa Europe/Madrid.
 */
export function computeNextRun(
  cadence: string,
  hour: number,
  from: number = Date.now(),
  minute: number = 0,
  daysOverride?: number[] | null,
  timeZone?: string,
): number {
  const days = resolveDays(cadence, daysOverride);
  const safeHour = Math.max(0, Math.min(23, Math.floor(Number(hour) || 0)));
  const safeMinute = Math.max(0, Math.min(59, Math.floor(Number(minute) || 0)));

  // Validar timeZone
  const tz = timeZone || "Europe/Madrid";
  let validTZ = tz;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
  } catch {
    validTZ = "Europe/Madrid";
  }

  // Obtener la hora LOCAL del punto de inicio
  const startLocal = getLocalDateTime(from, validTZ);

  // Iterar sobre los próximos días (en la zona local)
  for (let i = 0; i <= 8; i++) {
    // Candidato: día (startLocal.d + i) a las safeHour:safeMinute en la zona.
    // Date.UTC normaliza día → mes → año por sí solo (31-dic + 1 = 1-ene del año siguiente),
    // así que no hace falta contar los días de cada mes a mano.
    const t = new Date(Date.UTC(startLocal.y, startLocal.m, startLocal.d + i));
    const targetYear = t.getUTCFullYear();
    const targetMonth = t.getUTCMonth();
    const targetDay = t.getUTCDate();

    // «Pared»: la fecha y hora local deseadas leídas como si fueran UTC. El instante real es
    // pared − desfase de la zona, y el desfase se mide con FECHA y hora completas: si se
    // midiera solo con la hora, las 22:00 de Madrid (00:00 del día siguiente en UTC+2) darían
    // «−22 h» y el candidato saltaría un día entero.
    const wall = Date.UTC(targetYear, targetMonth, targetDay, safeHour, safeMinute);
    let candidate = wall;

    // Iterar hasta converger (máximo 3 intentos, suficiente para DST)
    for (let iter = 0; iter < 3; iter++) {
      const cl = getLocalDateTime(candidate, validTZ);
      const offsetMs = Date.UTC(cl.y, cl.m, cl.d, cl.h, cl.min) - candidate;
      const nextCandidate = wall - offsetMs;

      // Si el offset no cambió, hemos convergido
      if (nextCandidate === candidate) break;
      candidate = nextCandidate;
    }

    // Comprobar que candidato es futuro y el día de semana es válido
    const candidateLocal = getLocalDateTime(candidate, validTZ);
    if (candidate > from && days.includes(candidateLocal.dayOfWeek)) {
      return candidate;
    }
  }

  return from + 24 * 3600 * 1000;
}

/**
 * Parsea CSV de días persistido en `autopost.daysMask` ("1,3,5") a array.
 * Devuelve null si la setting está vacía → señal de "usar preset cadence".
 */
function readDaysSetting(): number[] | null {
  const raw = get("autopost.daysMask");
  if (!raw) return null;
  const parts = String(raw)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return parts.length ? parts : null;
}

async function tickForCurrentWorkspace(): Promise<void> {
  try {
    if (get("autopost.enabled") !== "true") return;
    const cadence = get("autopost.cadence") || "3xweek";
    const hour = Number(get("autopost.hour") || 19);
    const minute = Number(get("autopost.minute") || 0);
    const days = readDaysSetting();
    const tz = autopostTimeZone(); // ZONA-HORARIA-AUTOPOST-1
    const next = Number(get("autopost.nextRun") || 0);
    if (!next) {
      await set("autopost.nextRun", String(computeNextRun(cadence, hour, Date.now(), minute, days, tz)));
      return;
    }
    if (Date.now() >= next) {
      // Recalcula ANTES de publicar para no re-disparar si la generación tarda.
      await set("autopost.nextRun", String(computeNextRun(cadence, hour, Date.now(), minute, days, tz)));
      try {
        const r = await publishNow();
        console.log(`[autopost] publicado "${r.idea}" en ${r.platforms.join(", ")}`);
      } catch (e) {
        console.error("[autopost] run:", (e as Error).message);
      }
    }
  } catch (e) {
    console.error("[autopost] tick:", (e as Error).message);
  }
}

// Multi-tenant W8: el autopost lee settings PER-WS (autopost.enabled/cadence/hour…).
// Iteramos workspaces y cada uno corre su tickForCurrentWorkspace en su scope.
// Sin BD/workspaces → solo 'default' (regresión zero).
async function tick(): Promise<void> {
  let workspaces: { id: string }[] = [{ id: "default" }];
  try {
    const wss = await listWorkspacesCached();
    if (wss.length) workspaces = wss.map((w) => ({ id: w.id }));
  } catch {
    // BD no disponible o tabla aún no creada → solo 'default'.
  }
  for (const ws of workspaces) {
    await runWithWorkspace(ws.id, tickForCurrentWorkspace);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startAutopostScheduler(): void {
  if (timer) return;
  timer = setInterval(tick, 60_000);
  console.log("[autopost] programador de carruseles activo (60s)");
}
