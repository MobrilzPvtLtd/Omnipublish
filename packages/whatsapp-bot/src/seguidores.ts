/**
 * SEGUIDORES-DASH-1 · cuentas de seguidores para el Panel de control.
 *
 * Funciones puras (sin dependencias del proyecto) para que el arnés las pruebe desde
 * dist/seguidores.js:
 *  - anclaSnapshot: el recuento guardado más cercano a un día, con tolerancia. Facebook y
 *    LinkedIn no dan «nuevos por día»: la cifra sale de restar dos recuentos, y los
 *    recuentos diarios tienen huecos (el panel no siempre estaba encendido).
 *  - saltosDiarios: diferencias entre recuentos de días CONSECUTIVOS (un hueco no es «0»).
 *  - graphFollowers: seguidores en vivo de una cuenta de Instagram o una página de Facebook.
 *  - igAltasBajas: altas y bajas de Instagram en un tramo (Meta sólo da 30 días por llamada).
 *
 *  SEGUIDORES-DASH-2 · cuando en una ventana no hubo altas ni bajas, Meta responde 200 con el desglose
 *  SIN `results` (y con `data` vacío si la ventana cae dentro de hoy). Eso son ceros, no un fallo:
 *  tratarlo como error dejaba «—» en producción en cuanto el tramo acababa en el día en curso.
 */

const DIA = 86_400_000;
const GRAPH = "https://graph.facebook.com/v21.0";

export interface PuntoSnap { date: string; value: number }

const ms = (d: string): number => Date.parse(d + "T00:00:00Z");

/** Recuento más cercano a `dia` (YYYY-MM-DD) dentro de ±tolerancia días; a igual distancia, el
 *  anterior. Si no hay ninguno tan cerca, el último anterior a `dia`. Null si no hay nada. */
export function anclaSnapshot(serie: PuntoSnap[], dia: string, tolerancia = 15): PuntoSnap | null {
  if (!serie.length) return null;
  const objetivo = ms(dia);
  let mejor: PuntoSnap | null = null;
  let mejorDist = Infinity;
  for (const p of serie) {
    const dist = Math.abs(ms(p.date) - objetivo) / DIA;
    if (dist > tolerancia) continue;
    if (dist < mejorDist || (dist === mejorDist && mejor && ms(p.date) < ms(mejor.date))) { mejor = p; mejorDist = dist; }
  }
  if (mejor) return mejor;
  let antes: PuntoSnap | null = null;
  for (const p of serie) if (ms(p.date) < objetivo && (!antes || ms(p.date) > ms(antes.date))) antes = p;
  return antes;
}

/** Diferencias entre recuentos de días consecutivos, fechadas en el día posterior. */
export function saltosDiarios(serie: PuntoSnap[]): Array<{ date: string; delta: number }> {
  const s = [...serie].sort((a, b) => ms(a.date) - ms(b.date));
  const out: Array<{ date: string; delta: number }> = [];
  for (let k = 1; k < s.length; k++) {
    if (ms(s[k].date) - ms(s[k - 1].date) !== DIA) continue;
    out.push({ date: s[k].date, delta: s[k].value - s[k - 1].value });
  }
  return out;
}

async function graphJson(url: string, timeoutMs: number): Promise<any> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const d = await r.json().catch(() => null);
    return r.ok ? d : null;
  } catch {
    return null;
  }
}

/** Seguidores ahora mismo de una cuenta IG o una página FB. Null si Meta no responde. */
export async function graphFollowers(id: string, token: string, timeoutMs = 6000): Promise<number | null> {
  if (!id || !token) return null;
  const d = await graphJson(`${GRAPH}/${encodeURIComponent(id)}?fields=followers_count&access_token=${encodeURIComponent(token)}`, timeoutMs);
  const n = d && d.followers_count != null ? Number(d.followers_count) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Altas y bajas de seguidores de Instagram entre dos instantes. Meta limita cada llamada a
 *  30 días: se pide por ventanas. Null si el tramo pide más de `maxVentanas` o si alguna falla. */
export async function igAltasBajas(igId: string, token: string, desdeMs: number, hastaMs: number, maxVentanas = 14, timeoutMs = 6000): Promise<{ nuevos: number; bajas: number } | null> {
  if (!igId || !token) return null;
  const fin = Math.min(hastaMs, Date.now());
  if (desdeMs >= fin) return { nuevos: 0, bajas: 0 };
  const VENTANA = 30 * DIA; // Meta admite hasta 30 días (2.592.000 s) entre since y until
  if (Math.ceil((fin - desdeMs) / VENTANA) > maxVentanas) return null;
  let nuevos = 0, bajas = 0;
  for (let ini = desdeMs; ini < fin; ini += VENTANA) {
    const tope = Math.min(ini + VENTANA, fin);
    const q = `insights?metric=follows_and_unfollows&metric_type=total_value&period=day&breakdown=follow_type&since=${Math.floor(ini / 1000)}&until=${Math.floor(tope / 1000)}&access_token=${encodeURIComponent(token)}`;
    const d = await graphJson(`${GRAPH}/${encodeURIComponent(igId)}/${q}`, timeoutMs);
    if (!d || !Array.isArray(d.data)) return null; // error de red, de permiso o de token
    // SEGUIDORES-DASH-2 · sin altas ni bajas no hay `results`: la ventana suma cero.
    const res = d.data[0]?.total_value?.breakdowns?.[0]?.results;
    if (!Array.isArray(res)) continue;
    for (const r of res) {
      const dim = String((r.dimension_values || [])[0] || "").toUpperCase();
      const v = Number(r.value) || 0;
      if (dim === "FOLLOWER") nuevos += v;
      else if (dim === "NON_FOLLOWER") bajas += v;
    }
  }
  return { nuevos, bajas };
}
