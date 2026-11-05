/**
 * FUNNELS-1 · los funnels de las webs de systeme.io, con cifras propias.
 *
 * systeme.io sólo da la ESTRUCTURA (qué funnels hay y qué páginas tiene cada uno); no tiene
 * estadísticas de funnel ni de página. Las cifras salen de lo que el panel ya guarda:
 *   · visitas / visitantes → app_page_views (el seguimiento instalado en la web), por web y ruta
 *   · registros            → app_sio_leads, por la dirección donde se dio de alta
 *   · ventas / ingresos    → app_sio_sales, por el paso que cobró (o por su oferta)
 *
 * La estructura se lee de dos maneras, según la cuenta:
 *   · con clave  → API oficial, lectura estricta: si cae una página no se guarda a medias y, si
 *                  la API falla, NO se cae en silencio al puente: se guarda el error legible.
 *   · sin clave  → el puente (navegador, lento), que devuelve una lista vacía al fallar: una
 *                  lista vacía no borra lo guardado y se apunta «no se pudo leer».
 * Sólo se LEE de systeme.io: es infraestructura compartida con el curso.
 *
 * FALSO-CERO-1: null = no se puede medir; 0 = medido y fue cero.
 */
import { currentWorkspaceId, runWithWorkspace, listWorkspacesCached } from "./workspace.js";
import { listAccountsRaw, type SiAccount } from "./systemeio-accounts.js";
import { withPublicApiKey, listFunnelsFull, listFunnelSteps } from "./systemeio-public-api.js";
import { nombreWebCheckout } from "./web-nombre.js";
import { normalizarRuta } from "./web-negocios.js";
import {
  hostDe, pixelsDeWeb, visitasDeDestinos, visitantesDeDestinos, visitasDeDestinosPorDia, rutasVistasPorContacto,
  diaDeMadrid, type DestinoDeRuta,
} from "./web-analytics.js";
import { puedeLeerVentas, ventasLeidasBien } from "./sio-ventas.js";
import {
  dbSioFunnelsGuardar, dbSioFunnelPasosGuardar, dbSioFunnels, dbSioFunnelPasos, dbSioFunnelsPorCuenta,
  dbSioSalesHay, dbFunnelVentasAgregadas, dbFunnelVentasFilas, dbFunnelVentasDiaDivisa, dbFunnelVentasDeEmail,
  dbSioLeadsStats, dbSioLeadsPorUrl, dbSioLeadsPorDia, dbSioLeadsDeUrls, dbSioLeadsDeEmail,
  type SioFunnelFila, type SioFunnelPaso,
} from "./db.js";

const DIA = 86_400_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const red1 = (n: number): number => Math.round(n * 10) / 10;
const red2 = (n: number): number => Math.round(n * 100) / 100;

/* ---------- lectura de la estructura ---------- */

export interface FunnelLeido { id: string; name: string; active: boolean | null }
export interface PasoLeido { id: string; name: string; type: string; pageId: string; url: string; position: number | null; offerId: string }

/** De dónde sale la estructura. Sustituible en los arneses (sin red). */
export const _funnelsFetcher = {
  /** Lo que se espera antes de reintentar las páginas de un funnel que no respondió (ms). */
  esperaReintento: 1500,
  /** Con clave. null = systeme.io no respondió entero; [] = de verdad no hay. */
  async funnelsOficial(acc: SiAccount): Promise<FunnelLeido[] | null> {
    return withPublicApiKey(String(acc.apiKey || ""), () => listFunnelsFull());
  },
  async pasosOficial(acc: SiAccount, funnelId: string): Promise<PasoLeido[] | null> {
    return withPublicApiKey(String(acc.apiKey || ""), () => listFunnelSteps(funnelId));
  },
  /** Sin clave. El puente devuelve [] tanto si no hay como si falló. */
  async funnelsPuente(acc: SiAccount): Promise<FunnelLeido[]> {
    const { fetchSystemeioFunnels } = await import("./mcp-bridge.js");
    return (await fetchSystemeioFunnels(acc.id)).map((f) => ({ id: String(f.id ?? ""), name: String(f.name || ""), active: null }));
  },
  async pasosPuente(acc: SiAccount, funnelId: string): Promise<PasoLeido[]> {
    const { fetchSystemeioFunnelSteps } = await import("./mcp-bridge.js");
    return (await fetchSystemeioFunnelSteps(funnelId, acc.id)).map((s) => ({
      id: String(s.id ?? ""), name: String(s.name || ""), type: String(s.type || ""), pageId: String(s.pageId || ""),
      url: String(s.publicUrl || ""), position: null, offerId: "",
    }));
  },
};

export interface FunnelsSyncResult { ok: boolean; funnels: number; pasos: number; error: string }

// Cómo acabó la última lectura de cada cuenta, por workspace. En memoria: tras un reinicio no se
// sabe nada hasta la siguiente lectura; lo guardado en la base (y su fecha) sigue ahí.
interface EstadoLectura { at: number; okAt: number; error: string; enCurso: Promise<FunnelsSyncResult> | null }
const lecturas = new Map<string, EstadoLectura>();
const claveLectura = (accountId: string): string => currentWorkspaceId() + ":" + accountId;
const estadoDe = (accountId: string): EstadoLectura => {
  const k = claveLectura(accountId);
  let e = lecturas.get(k);
  if (!e) lecturas.set(k, (e = { at: 0, okAt: 0, error: "", enCurso: null }));
  return e;
};

/** Lee la estructura de UNA cuenta y la guarda. Dos llamadas a la vez comparten la misma lectura. */
export function syncFunnelsSio(acc: SiAccount): Promise<FunnelsSyncResult> {
  const e = estadoDe(acc.id);
  if (e.enCurso) return e.enCurso;
  const p = leerYGuardar(acc)
    .catch((err): FunnelsSyncResult => {
      console.warn("[sio-funnels]", acc.id, (err as Error).message);
      return { ok: false, funnels: 0, pasos: 0, error: "No se pudieron guardar los funnels de esta web. Vuelve a intentarlo en unos minutos." };
    })
    .then((r) => {
      e.at = Date.now();
      e.error = r.error;
      if (r.ok) e.okAt = e.at;
      e.enCurso = null;
      return r;
    });
  e.enCurso = p;
  return p;
}

const pasoNormalizado = (p: PasoLeido, orden: number) => {
  const url = /^https?:\/\//i.test(p.url) ? p.url.trim() : "";
  return {
    step_id: p.id, name: p.name, type: p.type, page_id: p.pageId, url,
    // La dirección ya partida para cruzarla: el dominio (sin «www.») y la ruta comparable.
    web: url ? hostDe(url) : "", path: url ? normalizarRuta(url) : "",
    position: p.position ?? orden, offer_id: p.offerId,
  };
};

async function leerYGuardar(acc: SiAccount): Promise<FunnelsSyncResult> {
  const oficial = !!acc.apiKey;
  let funnels: FunnelLeido[];
  if (oficial) {
    const leidos = await _funnelsFetcher.funnelsOficial(acc);
    if (!leidos) return { ok: false, funnels: 0, pasos: 0, error: "systeme.io no respondió al pedir los funnels de esta web. Se conserva lo último que se leyó." };
    funnels = leidos;
  } else {
    funnels = await _funnelsFetcher.funnelsPuente(acc);
    // Sin clave, una lista vacía es lo mismo que un fallo: no se borra nada.
    if (!funnels.length) return { ok: false, funnels: 0, pasos: 0, error: "No se pudieron leer los funnels de esta web. Se conserva lo último que se leyó." };
  }
  funnels = funnels.filter((f) => f.id);
  // Sólo la lectura oficial es completa de verdad: el puente puede dar una lista parcial sin avisar.
  await dbSioFunnelsGuardar(acc.id, funnels.map((f) => ({ funnel_id: f.id, name: f.name, active: f.active })), oficial);

  const yaGuardados = new Set((await dbSioFunnelPasos(acc.id)).map((p) => p.funnel_id));
  let pasos = 0, sinLeer = 0, vacios = 0;
  for (const f of funnels) {
    let leidos = oficial ? await _funnelsFetcher.pasosOficial(acc, f.id) : await _funnelsFetcher.pasosPuente(acc, f.id);
    if (!leidos && oficial) {
      // Un límite de ritmo a mitad tumbaba en cadena todos los funnels siguientes: se espera y se
      // reintenta una vez antes de darlo por no leído.
      await sleep(_funnelsFetcher.esperaReintento);
      leidos = await _funnelsFetcher.pasosOficial(acc, f.id);
    }
    if (!leidos) { sinLeer++; if (oficial) await sleep(120); continue; } // no respondió → sus páginas guardadas se quedan
    if (!oficial && !leidos.length) {
      // Sin clave no se distingue «no tiene páginas» de «falló»: no se retira nada. Sólo es un
      // fallo seguro si de ese funnel ya había páginas guardadas.
      vacios++;
      if (yaGuardados.has(f.id)) sinLeer++;
      continue;
    }
    const filas = leidos.filter((p) => p.id).map((p, i) => pasoNormalizado(p, i + 1));
    await dbSioFunnelPasosGuardar(acc.id, f.id, filas, { retirarAusentes: oficial, oficial });
    pasos += filas.length;
    if (oficial) await sleep(120); // respirar entre funnels
  }
  if (!oficial && vacios === funnels.length) sinLeer = funnels.length; // ninguno trajo páginas: el puente no las está dando
  const error = sinLeer
    ? (sinLeer === 1 ? "No se pudieron leer las páginas de 1 funnel" : `No se pudieron leer las páginas de ${sinLeer} funnels`) + ". Se conserva lo último que se leyó."
    : "";
  return { ok: !error, funnels: funnels.length, pasos, error };
}

/* ---------- cuentas y rango ---------- */

export const esLaboratorio = (a: { panelBaseUrl?: string } | null | undefined): boolean => String(a?.panelBaseUrl || "").includes("leadmatch-lab");

export interface RangoFunnels { days: number; since: number; until: number }
export function rangoFunnels(days: unknown): RangoFunnels {
  const n = Number(days);
  const d = [7, 30, 90, 365].includes(n) ? n : 30;
  const until = Date.now();
  return { days: d, since: until - d * DIA, until };
}

interface CuentaVista { id: string; label: string; lab: boolean }
const cuentaVista = (a: SiAccount): CuentaVista => ({ id: a.id, label: nombreWebCheckout(a), lab: esLaboratorio(a) });

/** La cuenta que se enseña: la pedida si existe; si no, la primera que no sea el laboratorio y
 *  tenga funnels; si ninguna los tiene, la primera que no sea el laboratorio; si sólo hay laboratorio, ésa. */
function cuentaElegida(cuentas: SiAccount[], pedida: string, conFunnels: Set<string>): SiAccount | null {
  const p = pedida ? cuentas.find((a) => a.id === pedida) : undefined;
  if (p) return p;
  const propias = cuentas.filter((a) => !esLaboratorio(a));
  return propias.find((a) => conFunnels.has(a.id)) || propias[0] || cuentas.find((a) => conFunnels.has(a.id)) || cuentas[0] || null;
}

/* ---------- cifras ---------- */

export interface Importe { moneda: string; importe: number }
export type ClasePaso = "captura" | "venta" | "pago" | "gracias" | "otra";

/** Para el icono y la etiqueta, a partir del tipo crudo de systeme.io. */
export function claseDePaso(tipo: string, offerId = ""): ClasePaso {
  const t = String(tipo || "").toLowerCase().replace(/_/g, "-");
  if (/thank/.test(t)) return "gracias";
  if (offerId || /offer|order-form|checkout|payment|upsell|downsell/.test(t)) return "pago";
  if (/squeeze|optin|opt-in|lead|inline|popup|registration/.test(t)) return "captura";
  if (/sales|sale/.test(t)) return "venta";
  return "otra";
}

/** Neto por divisa (ventas − devoluciones), de mayor a menor. */
function netoPorDivisa(filas: Array<{ kind: "sale" | "refund"; currency: string; amount: number }>): Importe[] {
  const m = new Map<string, number>();
  for (const f of filas) m.set(f.currency, (m.get(f.currency) || 0) + (f.kind === "refund" ? -Math.abs(f.amount) : f.amount));
  return [...m].map(([moneda, importe]) => ({ moneda, importe: red2(importe) }))
    .filter((x) => x.moneda || x.importe)
    .sort((a, b) => b.importe - a.importe);
}
const pct = (parte: number | null, de: number | null): number | null => (parte === null || de === null || de <= 0 ? null : red1((parte / de) * 100));
/** Conversión del funnel: de las personas que entraron (los visitantes de su primera página con
 *  seguimiento), cuántas acabaron. Dividir por las visitas de TODAS las páginas la diluía con cada
 *  página y cada recarga. Si acaban más de las que se vieron entrar (seguimiento puesto después,
 *  entrada directa a otra página), no hay base: «no se sabe», nunca un 250 %. */
const conversionDe = (parte: number | null, entran: number | null): number | null =>
  parte === null || entran === null || entran <= 0 || parte > entran ? null : red1((parte / entran) * 100);
const sumaONull = (xs: Array<number | null>): number | null => {
  const medidos = xs.filter((x): x is number => x !== null);
  return medidos.length ? medidos.reduce((a, b) => a + b, 0) : null;
};
const clavePagina = (web: string, path: string): string => web + "|" + path;
const clavePaginaDeUrl = (url: string): string => {
  const web = hostDe(url);
  return web ? clavePagina(web, normalizarRuta(url)) : "";
};

/** Lo que hace falta para medir los pasos de una cuenta: los identificadores de seguimiento de cada web. */
async function seguimientoDeWebs(pasos: SioFunnelPaso[]): Promise<Map<string, string[]>> {
  const tenant = currentWorkspaceId();
  const out = new Map<string, string[]>();
  for (const web of new Set(pasos.map((p) => p.web).filter(Boolean))) {
    out.set(web, await pixelsDeWeb(tenant, "https://" + web).catch(() => [] as string[]));
  }
  return out;
}
const slugsDePaso = (p: SioFunnelPaso, seg: Map<string, string[]>): string[] => (p.web && p.path ? seg.get(p.web) || [] : []);

/** ¿Se pueden contar los registros y las ventas de esta cuenta? Si no, sus cifras son «no se sabe», no cero. */
async function medibles(acc: SiAccount | undefined, accountId: string): Promise<{ registros: boolean; ventas: boolean }> {
  // Tener con qué leer no es haber leído: sin altas copiadas, o sin una lectura de ventas que haya
  // acabado bien, un 0 sería inventado (FALSO-CERO-1).
  const registros = (await dbSioLeadsStats(accountId).catch(() => ({ total: 0 }))).total > 0;
  const ventas = (!!acc && puedeLeerVentas(acc) && ventasLeidasBien(accountId)) || (await dbSioSalesHay(accountId).catch(() => false));
  return { registros, ventas };
}

/** Altas del rango por página (dominio|ruta), con las direcciones crudas que caen en cada una. */
async function altasPorPagina(accountId: string, r: RangoFunnels): Promise<Map<string, { n: number; ultima: number; urls: string[] }>> {
  const out = new Map<string, { n: number; ultima: number; urls: string[] }>();
  for (const f of await dbSioLeadsPorUrl(accountId, r.since, r.until)) {
    const k = clavePaginaDeUrl(f.source_url);
    if (!k) continue;
    const o = out.get(k) || { n: 0, ultima: 0, urls: [] };
    o.n += f.n;
    o.ultima = Math.max(o.ultima, f.ultima);
    o.urls.push(f.source_url);
    out.set(k, o);
  }
  return out;
}

/* ---------- GET /admin/api/funnels ---------- */

export interface FunnelsListado {
  accounts: CuentaVista[];
  account: string;
  range: RangoFunnels;
  syncedAt: number | null;
  syncing: boolean;
  error: string;
  seguimiento: { webs: string[] };
  totals: { funnels: number; visitas: number | null; registros: number | null; ventas: number | null; ingresos: Importe[] };
  funnels: Array<{
    id: string; name: string; active: boolean | null; pasos: number;
    visitas: number | null; registros: number | null; ventas: number | null; ingresos: Importe[];
    conversion: number | null; ultimaActividad: number | null;
  }>;
  /** Día a día de toda la web, para el gráfico. Lo que no se mide va a 0 aquí y a `null` en `totals`. */
  serie: DiaDeFunnel[];
}
export interface DiaDeFunnel { dia: string; visitas: number; registros: number; ventas: number; ingresos: Importe[] }

const TODO = "*";

/** Ventas e ingresos netos de cada día, de las filas por día y divisa que cumplen `cuenta`. */
function ventasPorDia(filas: Awaited<ReturnType<typeof dbFunnelVentasDiaDivisa>>, cuenta: (funnel: string) => boolean): Map<string, { n: number; ingresos: Importe[] }> {
  const porDia = new Map<string, typeof filas>();
  for (const f of filas) if (cuenta(f.funnel)) porDia.set(f.dia, [...(porDia.get(f.dia) || []), f]);
  return new Map([...porDia].map(([dia, fs]) => [dia, { n: fs.filter((x) => x.kind === "sale").reduce((a, x) => a + x.n, 0), ingresos: netoPorDivisa(fs) }] as const));
}

export async function funnelsListado(opts: { siAcc?: string; days?: unknown }): Promise<FunnelsListado> {
  const tenant = currentWorkspaceId();
  const range = rangoFunnels(opts.days);
  const cuentas = await listAccountsRaw().catch(() => [] as SiAccount[]);
  const porCuenta = await dbSioFunnelsPorCuenta();
  const acc = cuentaElegida(cuentas, String(opts.siAcc || "").trim(), new Set(porCuenta.filter((c) => c.funnels > 0).map((c) => c.account_id)));
  const out: FunnelsListado = {
    accounts: cuentas.map(cuentaVista), account: acc?.id || "", range, syncedAt: null, syncing: false, error: "",
    seguimiento: { webs: [] }, totals: { funnels: 0, visitas: null, registros: null, ventas: null, ingresos: [] }, funnels: [], serie: [],
  };
  if (!acc) return out;

  const funnels = await dbSioFunnels(acc.id);
  const estado = estadoDe(acc.id);
  // Lectura bajo demanda, sin esperar: si aún no hay nada guardado de esta web y no se acaba de intentar.
  if (!funnels.length && !estado.enCurso && Date.now() - estado.at > 10 * 60_000) void syncFunnelsSio(acc);
  out.syncing = !!estado.enCurso;
  out.error = estado.error;
  const guardado = porCuenta.find((c) => c.account_id === acc.id)?.synced_at || 0;
  out.syncedAt = Math.max(guardado, estado.okAt) || null;
  if (!funnels.length) return out;

  const pasos = await dbSioFunnelPasos(acc.id);
  const seg = await seguimientoDeWebs(pasos);
  out.seguimiento.webs = [...seg].filter(([, s]) => s.length).map(([web]) => web).sort();
  const destinos: DestinoDeRuta[] = [];
  for (const p of pasos) {
    const slugs = slugsDePaso(p, seg);
    if (!slugs.length) continue;
    destinos.push({ slugs, ruta: p.path, grupo: p.step_id }, { slugs, ruta: p.path, grupo: TODO });
  }
  const [visitas, altas, ventas, mide, visitasDia, ventasDia] = await Promise.all([
    visitasDeDestinos(tenant, destinos, range.since, range.until),
    altasPorPagina(acc.id, range),
    dbFunnelVentasAgregadas(acc.id, range.since, range.until),
    medibles(acc, acc.id),
    visitasDeDestinosPorDia(tenant, destinos.filter((d) => d.grupo === TODO), range.since, range.until),
    dbFunnelVentasDiaDivisa(acc.id, range.since, range.until),
  ]);

  const pasosDe = new Map<string, SioFunnelPaso[]>();
  for (const p of pasos) pasosDe.set(p.funnel_id, [...(pasosDe.get(p.funnel_id) || []), p]);
  const paginasConAltas = new Set<string>();
  for (const f of funnels) {
    const suyos = pasosDe.get(f.funnel_id) || [];
    const medidos = suyos.filter((p) => slugsDePaso(p, seg).length);
    const v = medidos.length ? medidos.reduce((a, p) => a + (visitas.get(p.step_id)?.visitas || 0), 0) : null;
    // Registros: una página repetida en dos pasos del mismo funnel cuenta una vez.
    const paginas = [...new Set(suyos.filter((p) => p.web && p.path).map((p) => clavePagina(p.web, p.path)))];
    const reg = mide.registros && paginas.length ? paginas.reduce((a, k) => a + (altas.get(k)?.n || 0), 0) : null;
    if (reg !== null) for (const k of paginas) paginasConAltas.add(k);
    const suyas = ventas.filter((x) => x.funnel === f.funnel_id);
    const ven = mide.ventas ? suyas.filter((x) => x.kind === "sale").reduce((a, x) => a + x.n, 0) : null;
    const hayPago = suyos.some((p) => claseDePaso(p.type, p.offer_id) === "pago");
    const entrada = [...medidos].sort((a, b) => a.position - b.position)[0];
    const entran = entrada ? visitas.get(entrada.step_id)?.visitantes || 0 : null;
    const ultima = Math.max(0,
      ...medidos.map((p) => visitas.get(p.step_id)?.ultima || 0),
      ...(reg !== null ? paginas.map((k) => altas.get(k)?.ultima || 0) : []),
      ...suyas.map((x) => x.ultima));
    out.funnels.push({
      id: f.funnel_id, name: f.name, active: f.active, pasos: f.pasos,
      visitas: v, registros: reg, ventas: ven, ingresos: netoPorDivisa(suyas),
      conversion: conversionDe(hayPago ? ven : reg, entran), ultimaActividad: ultima || null,
    });
  }
  out.funnels.sort((a, b) => (b.ultimaActividad || 0) - (a.ultimaActividad || 0) || a.name.localeCompare(b.name, "es"));
  const ids = new Set(funnels.map((f) => f.funnel_id));
  out.totals = {
    funnels: funnels.length,
    // Una página que está en dos funnels cuenta una vez en el total.
    visitas: destinos.length ? visitas.get(TODO)?.visitas || 0 : null,
    registros: mide.registros && paginasConAltas.size ? [...paginasConAltas].reduce((a, k) => a + (altas.get(k)?.n || 0), 0) : sumaONull(out.funnels.map((f) => f.registros)),
    ventas: sumaONull(out.funnels.map((f) => f.ventas)),
    ingresos: netoPorDivisa(ventas.filter((x) => ids.has(x.funnel))),
  };
  // El día a día de la web entera: las mismas visitas, altas y ventas que suman los totales.
  const urls = [...paginasConAltas].flatMap((k) => altas.get(k)?.urls || []);
  const altasDia = urls.length ? await dbSioLeadsPorDia(acc.id, range.since, range.until, urls) : [];
  const diaV = visitasDia.get(TODO) || new Map<string, number>();
  const diaA = new Map(altasDia.map((x) => [x.dia, x.n] as const));
  const diaS = ventasPorDia(mide.ventas ? ventasDia : [], (fid) => ids.has(fid));
  out.serie = diasDelRango(range).map((dia) => ({
    dia, visitas: diaV.get(dia) || 0, registros: diaA.get(dia) || 0, ventas: diaS.get(dia)?.n || 0, ingresos: diaS.get(dia)?.ingresos || [],
  }));
  return out;
}

/* ---------- GET /admin/api/funnels/:funnelId ---------- */

export interface FunnelDetalle {
  funnel: { id: string; name: string; active: boolean | null; account: string; accountLabel: string; lab: boolean };
  range: RangoFunnels;
  totals: {
    visitas: number | null; visitantes: number | null; registros: number | null; ventas: number | null;
    devoluciones: number | null; ingresos: Importe[]; conversionRegistro: number | null; conversionVenta: number | null;
    /** Personas que entraron por la primera página que se puede medir: la base de las dos conversiones. */
    entran: number | null;
  };
  pasos: Array<{
    id: string; name: string; tipo: string; clase: ClasePaso; url: string; position: number; medible: boolean;
    visitas: number | null; visitantes: number | null; registros: number | null; ventas: number | null;
    ingresos: Importe[]; pasan: number | null;
  }>;
  serie: DiaDeFunnel[];
  registros: Array<{ email: string; phone: string; name: string; at: number; pasoId: string; paso: string }>;
  ventas: Array<{ email: string; phone: string; name: string; at: number; pasoId: string; paso: string; producto: string; importe: number; moneda: string; devolucion: boolean }>;
}

/** Los días del rango, en hora de Madrid, del primero al último. */
function diasDelRango(r: RangoFunnels): string[] {
  const out: string[] = [];
  const fin = diaDeMadrid(r.until);
  // Se avanza por el calendario, no sumando 24 h: con el cambio de hora un día dura 23 o 25 h
  // y sumando horas se saltaría (o repetiría) uno.
  const [a, m, d] = diaDeMadrid(r.since).split("-").map(Number);
  for (let i = 0; i < 400; i++) {
    const dia = new Date(Date.UTC(a, m - 1, d + i)).toISOString().slice(0, 10);
    if (dia > fin) break;
    out.push(dia);
  }
  return out;
}

/** El detalle de UN funnel del workspace activo, o null si no existe (en esa cuenta, si se pide una). */
export async function funnelDetalle(funnelId: string, opts: { siAcc?: string; days?: unknown }): Promise<FunnelDetalle | null> {
  const tenant = currentWorkspaceId();
  const id = String(funnelId || "").trim();
  if (!id) return null;
  const pedida = String(opts.siAcc || "").trim();
  const f: SioFunnelFila | undefined = (await dbSioFunnels(pedida)).find((x) => x.funnel_id === id);
  if (!f) return null;
  const range = rangoFunnels(opts.days);
  const cuentas = await listAccountsRaw().catch(() => [] as SiAccount[]);
  const acc = cuentas.find((a) => a.id === f.account_id);
  const pasos = await dbSioFunnelPasos(f.account_id, id);
  const seg = await seguimientoDeWebs(pasos);
  const destinos: DestinoDeRuta[] = [];
  for (const p of pasos) {
    const slugs = slugsDePaso(p, seg);
    if (!slugs.length) continue;
    destinos.push({ slugs, ruta: p.path, grupo: p.step_id }, { slugs, ruta: p.path, grupo: TODO });
  }
  const [visitantes, porDia, altas, agregadas, ventasDia, filasVentas, mide] = await Promise.all([
    visitantesDeDestinos(tenant, destinos, range.since, range.until),
    visitasDeDestinosPorDia(tenant, destinos.filter((d) => d.grupo === TODO), range.since, range.until),
    altasPorPagina(f.account_id, range),
    dbFunnelVentasAgregadas(f.account_id, range.since, range.until),
    dbFunnelVentasDiaDivisa(f.account_id, range.since, range.until),
    dbFunnelVentasFilas(f.account_id, id, range.since, range.until, 500),
    medibles(acc, f.account_id),
  ]);
  const suyas = agregadas.filter((x) => x.funnel === id);
  const cuenta = (grupo: string): { visitas: number; visitantes: number } => {
    let visitas = 0, personas = 0;
    for (const [visitor, o] of visitantes.get(grupo) || []) { visitas += o.veces; if (visitor) personas++; }
    return { visitas, visitantes: personas };
  };

  const medible = pasos.map((p) => slugsDePaso(p, seg).length > 0);
  const paginasUrl = new Map<string, SioFunnelPaso>(); // dominio|ruta → el primer paso que la usa
  for (const p of pasos) if (p.web && p.path && !paginasUrl.has(clavePagina(p.web, p.path))) paginasUrl.set(clavePagina(p.web, p.path), p);

  const outPasos: FunnelDetalle["pasos"] = pasos.map((p, i) => {
    const c = medible[i] ? cuenta(p.step_id) : null;
    // % de los visitantes de este paso que llegan al siguiente que se puede medir (y después de verlo).
    let pasan: number | null = null;
    const j = medible[i] ? medible.findIndex((m, k) => k > i && m) : -1;
    if (c && c.visitantes > 0 && j > i) {
      const aqui = visitantes.get(p.step_id) || new Map();
      const alli = visitantes.get(pasos[j].step_id) || new Map<string, { veces: number; primera: number; ultima: number }>();
      let llegan = 0;
      for (const [visitor, o] of aqui) {
        if (!visitor) continue;
        const s = alli.get(visitor);
        if (s && s.ultima >= o.primera) llegan++;
      }
      pasan = red1((llegan / c.visitantes) * 100);
    }
    const delPaso = suyas.filter((x) => x.paso === p.step_id);
    return {
      id: p.step_id, name: p.name, tipo: p.type, clase: claseDePaso(p.type, p.offer_id), url: p.url, position: p.position,
      medible: medible[i],
      visitas: c ? c.visitas : null, visitantes: c ? c.visitantes : null,
      registros: mide.registros && p.web && p.path ? altas.get(clavePagina(p.web, p.path))?.n || 0 : null,
      ventas: mide.ventas ? delPaso.filter((x) => x.kind === "sale").reduce((a, x) => a + x.n, 0) : null,
      ingresos: netoPorDivisa(delPaso), pasan,
    };
  });

  const total = destinos.length ? cuenta(TODO) : null;
  const iEntrada = medible.indexOf(true); // los pasos llegan ordenados por posición
  const entran = iEntrada >= 0 ? cuenta(pasos[iEntrada].step_id).visitantes : null;
  const registros = mide.registros && paginasUrl.size ? [...paginasUrl.keys()].reduce((a, k) => a + (altas.get(k)?.n || 0), 0) : null;
  const ventas = mide.ventas ? suyas.filter((x) => x.kind === "sale").reduce((a, x) => a + x.n, 0) : null;
  const devoluciones = mide.ventas ? suyas.filter((x) => x.kind === "refund").reduce((a, x) => a + x.n, 0) : null;

  // Altas una a una y por día: sólo las que se registraron en una página de este funnel.
  const urls = [...paginasUrl.keys()].flatMap((k) => altas.get(k)?.urls || []);
  const [altasDia, filasAltas] = mide.registros && urls.length
    ? await Promise.all([dbSioLeadsPorDia(f.account_id, range.since, range.until, urls), dbSioLeadsDeUrls(f.account_id, range.since, range.until, urls, 500)])
    : [[], []];
  const nombrePaso = new Map(pasos.map((p) => [p.step_id, p.name] as const));
  const diaV = porDia.get(TODO) || new Map<string, number>();
  const diaA = new Map(altasDia.map((x) => [x.dia, x.n] as const));
  const diaS = ventasPorDia(mide.ventas ? ventasDia : [], (fid) => fid === id);

  return {
    funnel: { id: f.funnel_id, name: f.name, active: f.active, account: f.account_id, accountLabel: nombreWebCheckout(acc), lab: esLaboratorio(acc) },
    range,
    totals: {
      visitas: total ? total.visitas : null, visitantes: total ? total.visitantes : null,
      registros, ventas, devoluciones, ingresos: netoPorDivisa(suyas),
      conversionRegistro: conversionDe(registros, entran),
      conversionVenta: conversionDe(ventas, entran),
      entran,
    },
    pasos: outPasos,
    serie: diasDelRango(range).map((dia) => ({
      dia, visitas: diaV.get(dia) || 0, registros: diaA.get(dia) || 0, ventas: diaS.get(dia)?.n || 0, ingresos: diaS.get(dia)?.ingresos || [],
    })),
    registros: filasAltas.map((a) => {
      const p = paginasUrl.get(clavePaginaDeUrl(a.source_url));
      return { email: a.email, phone: a.phone, name: a.name, at: a.at, pasoId: p?.step_id || "", paso: p?.name || "" };
    }),
    ventas: filasVentas.map((v) => ({
      email: v.email, phone: v.phone, name: v.name, at: v.at, pasoId: v.paso, paso: nombrePaso.get(v.paso) || "",
      producto: v.product, importe: red2(Math.abs(v.amount)), moneda: v.currency, devolucion: v.kind === "refund",
    })),
  };
}

/* ---------- GET /admin/api/contacts/:phone/funnels ---------- */

export interface FunnelDeContacto {
  account: string; accountLabel: string; lab: boolean; funnelId: string; funnelName: string;
  registro: { at: number; pasoId: string; paso: string; url: string } | null;
  compras: Array<{ at: number; pasoId: string; paso: string; producto: string; importe: number; moneda: string; devolucion: boolean }>;
  visitas: Array<{ pasoId: string; paso: string; veces: number; ultima: number }>;
  ultima: number;
}

/** En qué funnels está una ficha: dónde se dio de alta, qué compró y qué páginas abrió. El cruce
 *  con altas y ventas es por el email de la ficha; las páginas, por su teléfono (el seguimiento). */
export async function funnelsDeContacto(c: { phone: string; email?: string | null }): Promise<{ funnels: FunnelDeContacto[] }> {
  const tenant = currentWorkspaceId();
  const funnels = await dbSioFunnels();
  if (!funnels.length) return { funnels: [] };
  const pasos = await dbSioFunnelPasos();
  const cuentas = await listAccountsRaw().catch(() => [] as SiAccount[]);
  const email = String(c.email || "").trim();
  const [altas, compras, vistas, seg] = await Promise.all([
    email ? dbSioLeadsDeEmail(email) : Promise.resolve([]),
    email ? dbFunnelVentasDeEmail(email, 500) : Promise.resolve([]),
    rutasVistasPorContacto(tenant, c.phone),
    seguimientoDeWebs(pasos),
  ]);
  const clave = (account: string, funnel: string): string => account + "\u0000" + funnel;
  const nombre = new Map(funnels.map((f) => [clave(f.account_id, f.funnel_id), f.name] as const));
  const nombrePaso = new Map(pasos.map((p) => [clave(p.account_id, p.step_id), p.name] as const));
  const out = new Map<string, FunnelDeContacto>();
  const de = (account: string, funnel: string): FunnelDeContacto | null => {
    const k = clave(account, funnel);
    if (!nombre.has(k)) return null; // un funnel que ya no está en la estructura no se puede nombrar
    let o = out.get(k);
    if (!o) {
      const acc = cuentas.find((a) => a.id === account);
      if (!acc) return null; // la web se desconectó: su estructura guardada ya no se enseña
      out.set(k, (o = {
        account, accountLabel: nombreWebCheckout(acc), lab: esLaboratorio(acc), funnelId: funnel, funnelName: nombre.get(k) || "",
        registro: null, compras: [], visitas: [], ultima: 0,
      }));
    }
    return o;
  };
  // Dónde se dio de alta: la página de su alta en esa web es un paso de…
  for (const a of altas) {
    const k = clavePaginaDeUrl(a.source_url);
    if (!k) continue;
    for (const p of pasos) {
      if (p.account_id !== a.account_id || !p.web || clavePagina(p.web, p.path) !== k) continue;
      const o = de(p.account_id, p.funnel_id);
      if (!o || (o.registro && o.registro.at <= a.at)) continue;
      o.registro = { at: a.at, pasoId: p.step_id, paso: p.name, url: a.source_url };
      o.ultima = Math.max(o.ultima, a.at);
    }
  }
  for (const v of compras) {
    const o = de(v.account_id, v.funnel);
    if (!o) continue;
    o.compras.push({
      at: v.at, pasoId: v.paso, paso: nombrePaso.get(clave(v.account_id, v.paso)) || "", producto: v.product,
      importe: red2(Math.abs(v.amount)), moneda: v.currency, devolucion: v.kind === "refund",
    });
    o.ultima = Math.max(o.ultima, v.at);
  }
  // Qué pasos abrió, en el orden del funnel (dbSioFunnelPasos ya los trae ordenados).
  const vista = new Map(vistas.map((x) => [x.web + "\u0000" + x.ruta, x] as const));
  for (const p of pasos) {
    let veces = 0, ultima = 0;
    for (const slug of slugsDePaso(p, seg)) {
      const x = vista.get(slug + "\u0000" + p.path);
      if (x) { veces += x.veces; ultima = Math.max(ultima, x.ultima); }
    }
    if (!veces) continue;
    const o = de(p.account_id, p.funnel_id);
    if (!o) continue;
    o.visitas.push({ pasoId: p.step_id, paso: p.name, veces, ultima });
    o.ultima = Math.max(o.ultima, ultima);
  }
  return { funnels: [...out.values()].sort((a, b) => b.ultima - a.ultima) };
}

/* ---------- programador ---------- */

/** Una pasada: todas las cuentas de todos los workspaces. Con clave, siempre; sin clave (el puente
 *  abre un navegador), sólo si lo guardado tiene más de un día. */
export async function syncAllSioFunnels(): Promise<void> {
  try {
    let workspaces: { id: string }[] = [];
    try { workspaces = await listWorkspacesCached(); }
    catch { workspaces = [{ id: "default" }]; }
    for (const ws of workspaces) {
      if (!ws.id || ws.id === "_global_") continue;
      await runWithWorkspace(ws.id, async () => {
        const cuentas = await listAccountsRaw();
        if (!cuentas.length) return;
        const guardado = new Map((await dbSioFunnelsPorCuenta()).map((c) => [c.account_id, c.synced_at] as const));
        for (const acc of cuentas) {
          if (!acc.apiKey && Date.now() - (guardado.get(acc.id) || 0) < DIA) continue;
          const r = await syncFunnelsSio(acc);
          if (r.error) console.warn(`[sio-funnels] ${ws.id}/${acc.id}: ${r.error}`);
        }
      }).catch((e) => { console.warn(`[sio-funnels] ${ws.id}:`, (e as Error).message); });
    }
  } catch (e) {
    console.warn("[sio-funnels] tick:", (e as Error).message);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Primera lectura a los 4 min de arrancar (que no compita con el arranque) y luego cada 6 h:
 *  la estructura de un funnel cambia poco, y «Actualizar» en la vista la relee al momento. */
export function startSioFunnelsScheduler(): void {
  if (timer) return;
  const primera = setTimeout(() => { void syncAllSioFunnels(); }, 4 * 60_000);
  primera.unref?.();
  timer = setInterval(() => { void syncAllSioFunnels(); }, 6 * 3_600_000);
  timer.unref?.();
}
