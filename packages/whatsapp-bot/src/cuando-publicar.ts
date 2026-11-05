/**
 * CUANDO-PUBLICAR-1 (MET-IG-07) · «Cuándo publicar» de Instagram.
 *
 * Son dos señales distintas y aquí se calculan por separado, con funciones puras (sin red ni
 * estado) para que lo que la pantalla dice que usa sea exactamente lo que se usó:
 *
 *  1. AUDIENCIA · a qué horas están conectados los seguidores. Dato de Instagram
 *     (`online_followers`): un punto por día con 24 valores. Instagram NO documenta en qué zona
 *     horaria da esas 24 horas: se leen como UTC (lo que hacía el panel) y se dice en pantalla.
 *  2. RENDIMIENTO · cuánto respondió la gente (me gusta + comentarios) a las publicaciones según
 *     la hora a la que salieron. Datos propios, con la hora real de cada publicación.
 *
 * Las dos reciben la zona de quien mira (?tz=) y convierten CADA día/publicación con la regla
 * horaria de ese día (verano/invierno), no con el desfase de hoy aplicado a todo.
 */

/** Zona en la que se leen las 24 horas de `online_followers`: supuesta, Instagram no la documenta. */
export const ZONA_ORIGEN_AUDIENCIA = "UTC";
/** Publicaciones mínimas en una franja (u día) para compararla. */
export const MIN_PUBS_FRANJA = 3;
/** Publicaciones mínimas en total para decir nada sobre horas. */
export const MIN_PUBS_TOTAL = 10;
/** Días mínimos de audiencia para marcar una franja. */
export const MIN_DIAS_AUDIENCIA = 3;
/** Una franja de audiencia destaca si supera en un 10 % la media de las 24 horas. */
export const UMBRAL_AUDIENCIA = 1.1;
/** Una franja de rendimiento destaca si su mediana supera en un 20 % la mediana de todas. */
export const UMBRAL_RENDIMIENTO = 20;
/** Horas por franja al comparar el rendimiento (8 franjas al día). */
export const HORAS_FRANJA = 3;

const DIA_MS = 86400000;
const NOMBRES_DIA = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const DIA_EN: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

// ---------------------------------------------------------------------------------------------
// Zona horaria
// ---------------------------------------------------------------------------------------------

const FORMATEADORES = new Map<string, Intl.DateTimeFormat>();
function formateador(tz: string): Intl.DateTimeFormat {
  let f = FORMATEADORES.get(tz);
  if (!f) {
    if (FORMATEADORES.size > 80) FORMATEADORES.clear();
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      weekday: "short", hour: "numeric", minute: "numeric", second: "numeric",
    });
    FORMATEADORES.set(tz, f);
  }
  return f;
}

/** Zona IANA válida; si no lo es (o falta), `porDefecto`. */
export function zonaValida(tz: unknown, porDefecto = "UTC"): string {
  const s = String(tz || "").trim().slice(0, 64);
  if (!s || !/^[A-Za-z0-9_+\-/]+$/.test(s)) return porDefecto;
  try { new Intl.DateTimeFormat("en", { timeZone: s }); return s; } catch { return porDefecto; }
}

/** Hora (0-23) y día de la semana (0 = lunes … 6 = domingo) de un instante en la zona. */
export function horaLocal(ms: number, tz: string): { h: number; dow: number } | null {
  if (!Number.isFinite(ms)) return null;
  try {
    let h = -1;
    let dow = -1;
    for (const p of formateador(tz).formatToParts(new Date(ms))) {
      if (p.type === "hour") h = Number(p.value) % 24;
      else if (p.type === "weekday") dow = DIA_EN[p.value] ?? -1;
    }
    return h >= 0 && dow >= 0 ? { h, dow } : null;
  } catch { return null; }
}

/** Minutos al este de UTC que lleva la zona en ese instante (Madrid en verano = 120). */
export function offsetMin(ms: number, tz: string): number {
  const v: Record<string, number> = {};
  for (const p of formateador(tz).formatToParts(new Date(ms))) {
    if (p.type === "year" || p.type === "month" || p.type === "day" || p.type === "hour" || p.type === "minute" || p.type === "second") v[p.type] = Number(p.value);
  }
  const comoUtc = Date.UTC(v.year, (v.month || 1) - 1, v.day, (v.hour || 0) % 24, v.minute || 0, v.second || 0);
  return Math.round((comoUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export interface EtiquetaZona { nombre: string; utc: string; texto: string }

/** «Madrid (UTC+2)». Para «UTC» sale sólo «UTC». */
export function etiquetaZona(tz: string, ms: number = Date.now()): EtiquetaZona {
  const off = offsetMin(ms, tz);
  const a = Math.abs(off);
  const hh = Math.floor(a / 60);
  const mm = a % 60;
  const utc = off === 0 ? "UTC" : "UTC" + (off > 0 ? "+" : "-") + hh + (mm ? ":" + String(mm).padStart(2, "0") : "");
  const nombre = tz === "UTC" ? "UTC" : (tz.split("/").pop() || tz).replace(/_/g, " ");
  return { nombre, utc, texto: nombre === utc ? utc : nombre + " (" + utc + ")" };
}

function isoDia(ms: number): string {
  const d = new Date(ms);
  const z = (n: number) => (n < 10 ? "0" : "") + n;
  return d.getUTCFullYear() + "-" + z(d.getUTCMonth() + 1) + "-" + z(d.getUTCDate());
}

// ---------------------------------------------------------------------------------------------
// 1 · Audiencia conectada
// ---------------------------------------------------------------------------------------------

/** Un día de `online_followers`: `t` = end_time del punto (ms) y `h[k]` = conectados a la hora k. */
export interface DiaAudiencia { t: number; h: Array<number | null> }

export interface FranjaAudiencia {
  /** Hora local de inicio (0-23). */
  desde: number;
  /** Hora local de fin, exclusiva (puede ser menor que `desde`: pasa de medianoche). */
  hasta: number;
  /** Seguidores conectados de media en esas horas. */
  media: number;
  /** % por encima de la media de las 24 horas. */
  vsMedia: number;
}

export interface AudienciaHora {
  estado: "ok" | "pareja" | "pocos-dias" | "sin-datos";
  zona: string;
  zonaNombre: string;
  zonaUtc: string;
  zonaTexto: string;
  /** Zona en la que se leen las horas que da Instagram. */
  origenZona: string;
  /** Instagram no documenta esa zona: siempre false. La pantalla lo dice. */
  origenZonaSegura: false;
  /** Días con dato que entran en la media. */
  dias: number;
  /** Primer y último día del dato (AAAA-MM-DD). */
  desdeDia: string | null;
  hastaDia: string | null;
  /** Conectados de media en cada hora LOCAL (24; null = sin dato esa hora). */
  porHora: Array<number | null>;
  /** Media de las 24 horas. */
  media: number | null;
  franjas: FranjaAudiencia[];
}

const distCircular = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
};

export function audienciaPorHora(diario: DiaAudiencia[] | null | undefined, tzPedida: string): AudienciaHora {
  const zona = zonaValida(tzPedida);
  const et = etiquetaZona(zona);
  const base = {
    zona, zonaNombre: et.nombre, zonaUtc: et.utc, zonaTexto: et.texto,
    origenZona: ZONA_ORIGEN_AUDIENCIA, origenZonaSegura: false as const,
  };
  // Un día con todo a cero o sin cifras no es un día de audiencia: es la ausencia del dato.
  const dias = (Array.isArray(diario) ? diario : [])
    .filter((d) => d && Number.isFinite(d.t) && Array.isArray(d.h) && d.h.some((v) => typeof v === "number" && Number.isFinite(v) && v > 0))
    .slice()
    .sort((a, b) => a.t - b.t);
  if (!dias.length) {
    return { ...base, estado: "sin-datos", dias: 0, desdeDia: null, hastaDia: null, porHora: new Array(24).fill(null), media: null, franjas: [] };
  }
  const suma = new Array<number>(24).fill(0);
  const cuenta = new Array<number>(24).fill(0);
  for (const d of dias) {
    // Mismo criterio de fecha que metrics.ts: el punto lleva el end_time del día siguiente.
    const u = new Date(d.t - DIA_MS);
    for (let k = 0; k < 24; k++) {
      const v = d.h[k];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const hl = horaLocal(Date.UTC(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), k), zona);
      if (!hl) continue;
      suma[hl.h] += v;
      cuenta[hl.h] += 1;
    }
  }
  const crudo: Array<number | null> = suma.map((s, h) => (cuenta[h] ? s / cuenta[h] : null));
  const valores = crudo.filter((v): v is number => v != null);
  const mediaCruda = valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : 0;
  const comun = {
    ...base,
    dias: dias.length,
    desdeDia: isoDia(dias[0].t - DIA_MS),
    hastaDia: isoDia(dias[dias.length - 1].t - DIA_MS),
    porHora: crudo.map((v) => (v == null ? null : Math.round(v))),
    media: Math.round(mediaCruda),
  };
  if (mediaCruda <= 0) return { ...comun, estado: "sin-datos", media: null, franjas: [] };
  if (dias.length < MIN_DIAS_AUDIENCIA) return { ...comun, estado: "pocos-dias", franjas: [] };

  // Ventanas de dos horas seguidas (pueden cruzar la medianoche), de más a menos conectadas; se
  // quedan hasta tres que no se solapen y que superen la media del día en un 10 %.
  const ventanas: Array<{ desde: number; media: number }> = [];
  for (let h = 0; h < 24; h++) {
    const a = crudo[h];
    const b = crudo[(h + 1) % 24];
    if (a == null || b == null) continue;
    ventanas.push({ desde: h, media: (a + b) / 2 });
  }
  ventanas.sort((x, y) => y.media - x.media || x.desde - y.desde);
  const elegidas: Array<{ desde: number; media: number }> = [];
  for (const v of ventanas) {
    if (elegidas.length >= 3 || v.media < mediaCruda * UMBRAL_AUDIENCIA) break;
    if (elegidas.every((e) => distCircular(e.desde, v.desde) >= 2)) elegidas.push(v);
  }
  if (!elegidas.length) return { ...comun, estado: "pareja", franjas: [] };
  // En orden del reloj, no del «mejor»: son franjas a considerar, no un podio.
  elegidas.sort((x, y) => x.desde - y.desde);
  return {
    ...comun,
    estado: "ok",
    franjas: elegidas.map((e) => ({
      desde: e.desde,
      hasta: (e.desde + 2) % 24,
      media: Math.round(e.media),
      vsMedia: Math.round((e.media / mediaCruda - 1) * 100),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// 2 · Rendimiento de las publicaciones según la hora
// ---------------------------------------------------------------------------------------------

/** Lo mínimo que hace falta de cada publicación (`allPosts` de segInstagram lo trae). */
export interface PubMin {
  timestamp?: string | number | null;
  likes?: number | null;
  comments?: number | null;
  type?: string | null;
  mediaProductType?: string | null;
}

export interface FormatoN { formato: string; n: number }

export interface FranjaRend {
  desde: number;
  hasta: number;
  n: number;
  mediana: number | null;
  /** % sobre la mediana de todas las publicaciones (null si no se puede comparar). */
  vs: number | null;
  formatos: FormatoN[];
  /** Hay publicaciones suficientes en esta franja para compararla. */
  suficiente: boolean;
  destacada: boolean;
}

export interface DiaRend {
  dia: number;
  nombre: string;
  n: number;
  mediana: number | null;
  vs: number | null;
  formatos: FormatoN[];
  suficiente: boolean;
  destacado: boolean;
}

export interface RendimientoHora {
  estado: "ok" | "sin-franja" | "pocas" | "sin-datos";
  zona: string;
  zonaNombre: string;
  zonaUtc: string;
  zonaTexto: string;
  /** Publicaciones comparadas. */
  n: number;
  /** Fecha de la primera y de la última (ms). */
  desde: number | null;
  hasta: number | null;
  /** Mediana de interacciones (me gusta + comentarios) de todas las comparadas. */
  mediana: number | null;
  minFranja: number;
  minTotal: number;
  franjas: FranjaRend[];
  dias: DiaRend[];
}

function mediana(v: number[]): number | null {
  if (!v.length) return null;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Mismos nombres de formato que el resto de «Instagram» en el panel. */
function formatoDe(p: PubMin): string {
  const mp = String(p.mediaProductType || "").toUpperCase();
  const t = String(p.type || "").toUpperCase();
  if (t.includes("CAROUSEL")) return "Carrusel";
  if (mp.includes("REEL") || t.includes("REEL") || t.includes("VIDEO")) return "Reel / Vídeo";
  if (t.includes("IMAGE") || t.includes("PHOTO")) return "Imagen";
  return "Otro";
}

function repartoFormatos(fs: string[]): FormatoN[] {
  const m = new Map<string, number>();
  for (const f of fs) m.set(f, (m.get(f) || 0) + 1);
  return [...m.entries()].map(([formato, n]) => ({ formato, n })).sort((a, b) => b.n - a.n || a.formato.localeCompare(b.formato));
}

export function rendimientoPorHora(posts: PubMin[] | null | undefined, tzPedida: string): RendimientoHora {
  const zona = zonaValida(tzPedida);
  const et = etiquetaZona(zona);
  const vacio = (estado: RendimientoHora["estado"], n = 0, desde: number | null = null, hasta: number | null = null): RendimientoHora => ({
    estado, zona, zonaNombre: et.nombre, zonaUtc: et.utc, zonaTexto: et.texto,
    n, desde, hasta, mediana: null, minFranja: MIN_PUBS_FRANJA, minTotal: MIN_PUBS_TOTAL, franjas: [], dias: [],
  });
  type Item = { ms: number; h: number; dow: number; inter: number; formato: string };
  const items: Item[] = [];
  for (const p of Array.isArray(posts) ? posts : []) {
    if (!p) continue;
    const ms = typeof p.timestamp === "number" ? p.timestamp : Date.parse(String(p.timestamp || ""));
    const hl = horaLocal(ms, zona);
    if (!hl) continue;
    const inter = (Number(p.likes) || 0) + (Number(p.comments) || 0);
    items.push({ ms, h: hl.h, dow: hl.dow, inter, formato: formatoDe(p) });
  }
  if (!items.length) return vacio("sin-datos");
  const desde = Math.min(...items.map((i) => i.ms));
  const hasta = Math.max(...items.map((i) => i.ms));
  if (items.length < MIN_PUBS_TOTAL) return vacio("pocas", items.length, desde, hasta);

  const med = mediana(items.map((i) => i.inter));
  const vsDe = (m: number | null): number | null => (m == null || med == null || med <= 0 ? null : Math.round((m / med - 1) * 100));

  const nFr = 24 / HORAS_FRANJA;
  const franjas: FranjaRend[] = [];
  for (let i = 0; i < nFr; i++) {
    const g = items.filter((x) => Math.floor(x.h / HORAS_FRANJA) === i);
    const m = mediana(g.map((x) => x.inter));
    franjas.push({
      desde: i * HORAS_FRANJA, hasta: (i + 1) * HORAS_FRANJA, n: g.length, mediana: m, vs: vsDe(m),
      formatos: repartoFormatos(g.map((x) => x.formato)), suficiente: g.length >= MIN_PUBS_FRANJA, destacada: false,
    });
  }
  // Destacan, como mucho, tres franjas con muestra suficiente cuya mediana supera en un 20 % la de
  // todas. Una sola publicación viral no manda: se compara la mediana, no la media.
  franjas
    .filter((f) => f.suficiente && f.vs != null && f.vs >= UMBRAL_RENDIMIENTO)
    .sort((a, b) => (b.vs as number) - (a.vs as number) || b.n - a.n)
    .slice(0, 3)
    .forEach((f) => { f.destacada = true; });

  const dias: DiaRend[] = [];
  for (let d = 0; d < 7; d++) {
    const g = items.filter((x) => x.dow === d);
    const m = mediana(g.map((x) => x.inter));
    dias.push({
      dia: d, nombre: NOMBRES_DIA[d], n: g.length, mediana: m, vs: vsDe(m),
      formatos: repartoFormatos(g.map((x) => x.formato)), suficiente: g.length >= MIN_PUBS_FRANJA, destacado: false,
    });
  }
  dias
    .filter((x) => x.suficiente && x.vs != null && x.vs >= UMBRAL_RENDIMIENTO)
    .sort((a, b) => (b.vs as number) - (a.vs as number) || b.n - a.n)
    .slice(0, 2)
    .forEach((x) => { x.destacado = true; });

  return {
    ...vacio("ok", items.length, desde, hasta),
    estado: franjas.some((f) => f.destacada) ? "ok" : "sin-franja",
    mediana: med,
    franjas,
    dias,
  };
}
