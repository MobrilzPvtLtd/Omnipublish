/**
 * metricas-pro M4 — Export PDF de métricas.
 *
 * Genera HTML "imprimible" (con `@media print` embebido) que el usuario
 * convierte a PDF desde su propio navegador con window.print() (recomendado:
 * "Guardar como PDF"). Estrategia premium SIN puppeteer/chromium: la memoria
 * del proyecto avisa del coste en Railway de levantar Chrome para PDF y la UX
 * de "imprimir como PDF" desde el browser es nativa, instantánea y respeta
 * el zoom + idioma del cliente.
 *
 * BIG-1 (workspace-aware): exportAnalyticsPdf({wsId, range, tabs?}) abre el
 * scope ALS del wsId solicitado para que gatherAll() / segs lean settings y
 * datos PER-WORKSPACE (Meta Ads, IG, WhatsApp...). Eso permite a un superadmin
 * exportar el informe de cualquier workspace sin asumir el wsId del request.
 *
 * Brand styling: el HTML lee 4 settings PER-WS (NO en GLOBAL_KEYS):
 *   - brand.primary  : color principal (header/títulos)  · default #0f172a
 *   - brand.accent   : color de acento (KPIs, barras)    · default #c0603e
 *   - brand.logoUrl  : URL del logo (se incrusta como <img src>)
 *   - brand.logoBase64 : data: URI alternativa (sobrescribe logoUrl si existe)
 * Si nada de eso está definido se usa el SVG de fallback (assets/logo.svg)
 * embebido en el HTML — el PDF nunca sale sin marca.
 *
 * Output: string HTML completo (<!doctype html>...) listo para servir con
 * Content-Type text/html. El front-end (admin.ts mxExportPdf) abre la URL en
 * una pestaña nueva y dispara window.print() automáticamente al onload.
 */
import { gatherAll, segInstagram, segWeb, segAds, segWhatsApp, etiquetaRango, type AnalyticsBundle, type Win } from "./analytics.js";
import { segFbAporte, fbAlcanceNombre, fbCoberturaTxt, type FbAporte } from "./analytics.js"; // PROPORCION-FB-1 (MET-FB-04) · CIFRAS-FB-1
import { listFbAccounts } from "./facebook.js";
import { resolveAccount, runWithAccount } from "./instagram.js";
import { runWithWorkspace, currentWorkspaceId } from "./workspace.js";
import { getWorkspaceSetting } from "./settings.js";
import { LOGO_SVG } from "./branding.js";
import { dbGetWorkspace } from "./db.js";
import { metaAdsAccountsList, runWithAdsAccount } from "./metaAds.js";

// ---- Tipos públicos ------------------------------------------------------

/** Pestañas exportables (en este orden si el caller no especifica). */
export type PdfTab = "ig" | "fb" | "ads" | "wa" | "web";

const ALL_TABS: PdfTab[] = ["ig", "fb", "ads", "wa", "web"];

/** Rango temporal (compatible con el query del front: ?range=last30d / ?days=). */
export interface PdfRange {
  /** "last7d" | "last30d" | "last90d" | número de días. */
  preset?: string;
  /** Fallback explícito en días si no llega preset. */
  days?: number;
}

export interface ExportAnalyticsPdfArgs {
  wsId: string;
  range: PdfRange;
  tabs?: PdfTab[];
  // JERARQUIA-RES-1 (MET-RES-06) · el rango de fechas y la cuenta de Instagram de la vista.
  win?: Win;
  igId?: string;
  // NUMEROS-NEGOCIO-1 (MET-WA-01) · números de WhatsApp elegidos en la vista («a,b»; vacío = todos).
  waPhone?: string;
  // NEGOCIO-EMBUDO-1 (MET-WEB-01) · negocio y embudo elegidos en la pestaña Web.
  webAmbito?: { biz?: string; fun?: string; cmp?: boolean };
  // PROPORCION-FB-1 (MET-FB-04) · la Página de Facebook elegida en la vista (vacío = la primera).
  fbPage?: string;
  // MET-RES-06-FIN · la cuenta publicitaria elegida en la vista (vacío = la de siempre) y la
  // marca de la lectura del Resumen que el panel deja preparada para este informe.
  adsAcct?: string;
  lectura?: string;
}

// ---- Helpers -------------------------------------------------------------

function presetToDays(preset?: string, fallback?: number): number {
  if (typeof fallback === "number" && fallback > 0) return clampDays(fallback);
  switch ((preset || "").toLowerCase()) {
    case "last7d": case "7d": return 7;
    case "last14d": case "14d": return 14;
    case "last28d": case "28d": return 28;
    case "last30d": case "30d": case "": case undefined as unknown as string: return 30;
    case "last90d": case "90d": return 90;
    case "last180d": case "180d": return 180;
    case "last365d": case "365d": case "lastyear": return 365;
    default: {
      const n = Number(preset);
      if (Number.isFinite(n) && n > 0) return clampDays(n);
      return 30;
    }
  }
}

function clampDays(n: number): number {
  return Math.max(1, Math.min(365, Math.floor(n)));
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtNum(n: unknown): string {
  if (n == null) return "—";
  if (typeof n === "number") {
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("es-ES");
  }
  return esc(String(n));
}

function fmtMoney(n: unknown, currency?: string): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const num = Number(n).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // HARD-3: defense in depth — currency llega de Meta Ads (string controlado por
  // settings/API externa). Aunque hoy son códigos ISO como "EUR", el valor acaba
  // inyectado tal cual en el HTML del PDF; escapamos por si en el futuro la fuente
  // permite caracteres especiales (evita XSS si alguien sube CSV con currency="<x>").
  return currency ? `${num} ${esc(currency)}` : num;
}

function fmtPct(n: unknown): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("es-ES", { maximumFractionDigits: 1 }) + "%";
}

function rangeLabel(days: number): string {
  if (days === 1) return "Hoy";
  if (days === 7) return "Últimos 7 días";
  if (days === 14) return "Últimos 14 días";
  if (days === 28) return "Últimos 28 días";
  if (days === 30) return "Últimos 30 días";
  if (days === 90) return "Últimos 90 días";
  if (days === 365) return "Último año";
  return `Últimos ${days} días`;
}

// ---- Brand per-workspace -------------------------------------------------

interface BrandStyle {
  primary: string;
  accent: string;
  logoHtml: string;
  logoUrl: string;
}

function resolveBrand(wsId: string): BrandStyle {
  // Per-WS getters: usamos getWorkspaceSetting(wsId, key) en lugar de get(key)
  // para NO depender del scope ALS abierto por el caller (puede que el HTML se
  // renderice tras runWithWorkspace, pero la firma queda explícita y resistente
  // a refactors). brand.* NO están en GLOBAL_KEYS → cascada per-WS → 'default'.
  const primary = sanitizeColor(getWorkspaceSetting(wsId, "brand.primary"), "#0f172a");
  const accent = sanitizeColor(getWorkspaceSetting(wsId, "brand.accent"), "#c0603e");
  const logoBase64 = String(getWorkspaceSetting(wsId, "brand.logoBase64") || "").trim();
  const logoUrlRaw = String(getWorkspaceSetting(wsId, "brand.logoUrl") || "").trim();
  // Si brand.logoBase64 viene sin prefijo "data:", lo prefijamos como image/png.
  // Si trae prefijo (data:image/...;base64,...), lo respetamos tal cual.
  let logoSrc = "";
  if (logoBase64) {
    logoSrc = logoBase64.startsWith("data:")
      ? logoBase64
      : `data:image/png;base64,${logoBase64}`;
  } else if (logoUrlRaw && /^https?:\/\//i.test(logoUrlRaw)) {
    logoSrc = logoUrlRaw;
  }
  const logoHtml = logoSrc
    ? `<img class="pdf-logo-img" alt="logo" src="${esc(logoSrc)}"/>`
    // Fallback: SVG de marca embebido (no requiere red). LOGO_SVG ya es un
    // string válido <svg ...>...</svg>.
    : `<span class="pdf-logo-svg">${LOGO_SVG}</span>`;
  return { primary, accent, logoHtml, logoUrl: logoSrc };
}

/**
 * Defensa CSS-injection: brand.primary/brand.accent vienen de settings (BD,
 * editables desde el panel). Filtramos a una forma reconocible (#hex de 3/6/8
 * dígitos o rgb/rgba/hsl con paréntesis). Si no encaja, devolvemos el default.
 * Así un valor como "red; background:url(evil)" no se cuela en el <style>.
 */
function sanitizeColor(v: string | undefined | null, fallback: string): string {
  const s = String(v || "").trim();
  if (!s) return fallback;
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return s;
  if (/^(rgb|rgba|hsl|hsla)\([0-9.,\s%/-]+\)$/.test(s)) return s;
  return fallback;
}

// ---- Sparkline SVG (sin libs) -------------------------------------------

/**
 * Mini chart 240x60 px embebido en el HTML — adecuado para sección/tab card.
 * No requiere JS en el PDF: el SVG es estático y se imprime tal cual.
 * series: array de {date,value} o {value}; se ignoran null/undefined.
 */
function sparkline(series: Array<{ date?: string; value?: number | null }>, color: string): string {
  const pts = (series || [])
    .map((x) => Number(x?.value))
    .filter((v) => Number.isFinite(v));
  if (pts.length < 2) {
    return `<div class="pdf-spark-empty">Serie no disponible en este rango.</div>`;
  }
  const W = 240, H = 60, padX = 4, padY = 6;
  const mn = Math.min(...pts), mx = Math.max(...pts);
  const span = mx - mn || Math.abs(mx) || 1;
  const xs = pts.map((_, i) => padX + (i / (pts.length - 1)) * (W - padX * 2));
  const ys = pts.map((v) => padY + (1 - (v - mn) / span) * (H - padY * 2));
  const d = "M" + xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" L");
  const area = d + ` L${(W - padX).toFixed(1)},${(H - padY).toFixed(1)} L${padX},${(H - padY).toFixed(1)} Z`;
  return `<svg class="pdf-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
    + `<path d="${area}" fill="${esc(color)}" fill-opacity="0.12" stroke="none"/>`
    + `<path d="${d}" fill="none" stroke="${esc(color)}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
    + `</svg>`;
}

// ---- Render KPIs + tablas ----------------------------------------------

function kpiTile(label: string, value: string, sub?: string): string {
  return `<div class="pdf-kpi">`
    + `<div class="pdf-kpi-lbl">${esc(label)}</div>`
    + `<div class="pdf-kpi-val">${value}</div>`
    + (sub ? `<div class="pdf-kpi-sub">${esc(sub)}</div>` : "")
    + `</div>`;
}

function kpiRow(items: Array<{ label: string; value: string; sub?: string }>): string {
  if (!items.length) return "";
  // PULIDO-IG-1 · rejilla cuadrada: 4 tarjetas en 4 columnas (en 3 quedaba una huérfana); 2×2 en el móvil.
  return `<div class="pdf-kpis${items.length === 4 ? " pdf-kpis-4" : ""}">${items.map((i) => kpiTile(i.label, i.value, i.sub)).join("")}</div>`;
}

interface TopRow { label: string; values: Array<string | number> }

function topTable(headers: string[], rows: TopRow[]): string {
  if (!rows.length) {
    return `<div class="pdf-empty">Sin datos en este rango.</div>`;
  }
  // PULIDO-IG-1 · las cifras y sus cabeceras van a la derecha; una columna de texto («Tipo»,
  // «Contexto»), a la izquierda. Es de texto si alguna celda no lleva ni una cifra (la raya no cuenta).
  const texto = headers.map((_, i) => i > 0 && rows.some((r) => {
    const v = r.values[i - 1];
    return typeof v === "string" && v.trim() !== "" && v !== "—" && !/[0-9]/.test(v);
  }));
  const head = headers.map((h, i) => `<th${i && !texto[i] ? ' class="pdf-th-num"' : ""}>${esc(h)}</th>`).join("");
  const body = rows.map((r) => {
    const lbl = `<td class="pdf-td-lbl">${esc(r.label)}</td>`;
    // data-l: en el móvil cada fila es una tarjeta y cada valor lleva delante su etiqueta.
    const vals = r.values.map((v, j) =>
      `<td class="${texto[j + 1] ? "pdf-td-txt" : "pdf-td-num"}" data-l="${esc(headers[j + 1] || "")}">${typeof v === "number" ? fmtNum(v) : esc(v)}</td>`,
    ).join("");
    return `<tr>${lbl}${vals}</tr>`;
  }).join("");
  return `<div class="pdf-tbl"><table class="pdf-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---- Renderers por pestaña ---------------------------------------------

function renderIG(bundle: AnalyticsBundle, brand: BrandStyle): string {
  const ig: any = bundle.instagram || {};
  const acc: any = ig.account || {};
  const series = (ig.series || []).map((x: any) => ({ date: x.date, value: x.value }));
  // PULIDO-IG-1 (MET-IG-08) · mismos nombres que el panel; la tabla son las ÚLTIMAS publicaciones
  // (antes se titulaba «Top … (alcance)» sin estar ordenada por alcance) y un alcance que
  // Instagram no dio sale «—», no 0.
  const gd = series.length;
  const nCt = (ig.contentTypes || []).reduce((s: number, c: any) => s + (Number(c.count) || 0), 0);
  const kpis = kpiRow([
    { label: "Seguidores ahora", value: fmtNum(acc.followers) },
    { label: "Alcance 28d", value: fmtNum(acc.reach) },
    { label: "Visitas al perfil 28d", value: fmtNum(acc.profileViews) },
    // PORTADA-IG-1 · follower_count son las altas de cada día: no resta a quien deja de seguirte.
    { label: gd ? `Seguidores nuevos · ${gd}d` : "Seguidores nuevos", value: fmtNum(ig.growth) },
  ]);
  const topPostRows: TopRow[] = (ig.posts || []).slice(0, 8).map((p: any): TopRow => ({
    label: ((p.caption || "").slice(0, 60)) || `(${p.typeLabel || p.type || "publicación"})`,
    values: [p.typeLabel || p.type || "—", p.reach == null ? "—" : p.reach, p.likes || 0, p.comments || 0],
  }));
  const contentRows: TopRow[] = (ig.contentTypes || []).slice(0, 6).map((c: any): TopRow => ({
    label: c.type,
    // La columna dice «por 100 alcanzadas»: la cifra va sin «%» para no decir lo mismo dos veces.
    values: [c.count || 0, c.avgReach == null ? "—" : c.avgReach, c.avgEng == null ? "—" : c.avgEng, c.engRate == null ? "—" : Number(c.engRate).toLocaleString("es-ES", { maximumFractionDigits: 1 })],
  }));
  return tabSection({
    title: acc.username ? `Instagram · @${acc.username}` : "Instagram",
    accent: brand.accent,
    kpis,
    spark: sparkline(series, brand.accent),
    sparkLabel: "Seguidores nuevos por día",
    tables: [
      { title: "Últimas publicaciones · cifras acumuladas", html: topTable(["Publicación", "Tipo", "Alcance", "Me gusta", "Coment."], topPostRows) },
      { title: nCt === 1 ? "Rendimiento por formato · última publicación" : nCt ? `Rendimiento por formato · últimas ${nCt} publicaciones` : "Rendimiento por formato", html: topTable(["Formato", "Publicaciones", "Alcance medio", "Interacciones medias", "Interacc. por 100 alcanzadas"], contentRows) },
    ],
  });
}

// PROPORCION-FB-1 (MET-FB-04) · Facebook en el informe, con la Página y las fechas de la vista: primero lo que trajo al
// negocio (webs y contactos, medido sin Meta) y después las cifras de la Página. Lo que no se pudo medir sale «—», nunca 0;
// sin Página conectada, una línea. Las cuatro cifras salen siempre juntas para que la rejilla quede cuadrada.
function renderFB(fbB: any, ap: FbAporte | null, conectada: boolean, brand: BrandStyle): string {
  if (!conectada) {
    return tabSection({ title: "Facebook", accent: brand.accent, kpis: "", spark: "", sparkLabel: "", tables: [], empty: "Facebook no está conectado en este negocio." });
  }
  const fb: any = fbB || null;
  const sinLeer = "no se pudo leer ahora";
  const w = ap?.web ?? null;
  const c = ap?.contactos ?? null;
  const kWeb = !w ? { value: "—", sub: sinLeer }
    : (!w.webs && !w.visitasTotales) ? { value: "Sin medir", sub: "ninguna de tus webs mide visitas" }
    : { value: fmtNum(w.visitas), sub: "sesiones, no personas" };
  const kCon = !c ? { value: "—", sub: sinLeer } : { value: fmtNum(c.total), sub: `de ${fmtNum(c.totalNegocio)} contactos nuevos` };
  const dPct = fb && fb.reachDeltaPct != null && Number.isFinite(Number(fb.reachDeltaPct)) ? Math.round(Number(fb.reachDeltaPct)) : null;
  // CIFRAS-FB-1 · si las impresiones sólo son de parte de las publicaciones leídas, el informe lo dice (en la cifra y en la tabla).
  const cobTxt = fb?.reachKind === "posts" ? fbCoberturaTxt(fb.postsMedidas, fb.postsTotal).replace(/^ · /, "") : "";
  const cobSub = cobTxt ? cobTxt.charAt(0).toUpperCase() + cobTxt.slice(1) : undefined;
  const kpis = kpiRow([
    { label: "Visitas a tus webs desde Facebook", ...kWeb },
    { label: "Contactos con origen Facebook", ...kCon },
    { label: fbAlcanceNombre(fb?.reachKind), value: fmtNum(fb?.reach28d ?? null), sub: !fb ? sinLeer : dPct != null ? `${dPct > 0 ? "+" : ""}${dPct}% frente al periodo anterior` : cobSub },
    { label: "Interacciones en publicaciones", value: fmtNum(fb?.postEngagements ?? null), sub: !fb ? sinLeer : undefined },
  ]);
  const tipos: any[] = (fb && fb.postTypes) || [];
  const conImp = tipos.some((t: any) => t.impressions != null);
  const filas: TopRow[] = tipos.map((t: any): TopRow => ({
    label: t.label || t.type || "(formato)",
    values: conImp ? [t.count || 0, t.impressions == null ? "—" : t.impressions, t.pct == null ? "—" : fmtPct(t.pct)] : [t.count || 0],
  }));
  return tabSection({
    title: fb && fb.pageName ? `Facebook · ${fb.pageName}` : "Facebook",
    accent: brand.accent,
    kpis,
    spark: "",
    sparkLabel: "",
    tables: filas.length
      ? [{ title: "Publicaciones por formato" + (conImp ? fbCoberturaTxt(fb?.postsMedidas, fb?.postsTotal).replace(" · medidas", " · impresiones medidas") : ""), html: topTable(conImp ? ["Formato", "Publicaciones", "Impresiones", "% de impresiones"] : ["Formato", "Publicaciones"], filas) }]
      : [],
  });
}

function renderAds(bundle: AnalyticsBundle, brand: BrandStyle): string {
  const ads: any = bundle.ads || {};
  if (!ads.configured) {
    return tabSection({
      title: "Meta Ads",
      accent: brand.accent,
      kpis: "",
      spark: "",
      sparkLabel: "",
      tables: [],
      empty: "Meta Ads no está conectado para este workspace.",
    });
  }
  const kpis = kpiRow([
    { label: "Gasto", value: fmtMoney(ads.spend, ads.currency) },
    { label: "Leads", value: fmtNum(ads.leads) },
    { label: "CPL", value: fmtMoney(ads.cpl, ads.currency) },
    { label: "ROAS", value: ads.roas == null ? "—" : Number(ads.roas).toLocaleString("es-ES", { maximumFractionDigits: 2 }) },
  ]);
  const series = (ads.series || []).map((x: any) => ({ date: x.date, value: Number(x.spend ?? x.value ?? 0) }));
  const camps: any[] = ads.campaigns || ads.topCampaigns || [];
  const campRows: TopRow[] = camps.slice(0, 8).map((c: any): TopRow => ({
    label: c.name || c.id || "(campaña)",
    values: [fmtMoney(c.spend, ads.currency), c.leads || 0, c.impressions || 0, fmtMoney(c.cpl, ads.currency)],
  }));
  return tabSection({
    title: "Meta Ads",
    accent: brand.accent,
    kpis,
    spark: sparkline(series, brand.accent),
    sparkLabel: "Gasto / día",
    tables: [
      { title: "Campañas principales", html: topTable(["Campaña", "Gasto", "Leads", "Impresiones", "CPL"], campRows) },
    ],
  });
}

function renderWA(waSeg: any, brand: BrandStyle): string {
  const wa = waSeg || {};
  const kpis = kpiRow([
    { label: "Enviados", value: fmtNum(wa.sent) },
    { label: "Recibidos", value: fmtNum(wa.received) },
    // ATENCION-HUMANA-1 · personas (no mensajes) y la respuesta de una PERSONA del equipo;
    // el «tiempo medio de respuesta» de antes medía al cliente, no al equipo.
    { label: "Personas", value: fmtNum(wa.atencion?.personas) },
    { label: "Resp. del equipo", value: wa.atencion?.equipoMedianaMs == null ? "—" : `${Math.round((wa.atencion.equipoMedianaMs || 0) / 60000)} min`, sub: "mediana, sin respuestas automáticas" },
  ]);
  // El heatmap original (24x7) es denso para PDF: extraemos la serie
  // "envíos por hora" agregando los 7 días de la semana (más legible impreso).
  const hourly: Array<{ hour: number; dow: number; count_in: number; count_out: number }> = wa.by_hour || [];
  const perHour: number[] = new Array(24).fill(0);
  for (const c of hourly) perHour[c.hour] = (perHour[c.hour] || 0) + (c.count_out || 0);
  const series = perHour.map((v, i) => ({ date: `${i}:00`, value: v }));
  const tplRows: TopRow[] = (wa.by_template || []).slice(0, 8).map((t: any): TopRow => ({
    label: t.name || "(sin plantilla)",
    values: [t.sent || 0, fmtPct(t.delivered_pct), fmtPct(t.read_pct), fmtPct(t.failed_pct)],
  }));
  return tabSection({
    title: "WhatsApp PRO",
    accent: brand.accent,
    kpis,
    spark: sparkline(series, brand.accent),
    sparkLabel: "Envíos por hora del día",
    tables: [
      { title: "Calidad por plantilla", html: topTable(["Plantilla", "Envíos", "% Entrega", "% Lectura", "% Fallos"], tplRows) },
    ],
  });
}

function renderWeb(bundle: AnalyticsBundle, brand: BrandStyle): string {
  const web: any = bundle.web || {};
  const pv: any = web.pageviews || {};
  const cl: any = web.clicks || {};
  const ambito: any = web.webScope || {};
  const kpis = kpiRow([
    { label: "Usuarios", value: fmtNum(pv.users) },
    { label: "Sesiones", value: fmtNum(pv.sessions) },
    { label: "Páginas vistas", value: fmtNum(pv.views) },
    { label: "Clics enlaces", value: fmtNum(cl.total) },
  ]);
  const series = (pv.series || []).map((x: any) => ({ date: x.date, value: Number(x.value ?? x.views ?? 0) }));
  const pages: any[] = pv.pages || [];
  const pageRows: TopRow[] = pages.slice(0, 8).map((p: any): TopRow => ({
    label: p.label || p.path || "(/)",
    values: [p.views || 0, p.visitors || 0],
  }));
  const linkRows: TopRow[] = (cl.top || []).slice(0, 8).map((l: any): TopRow => ({
    label: l.label || "(enlace)",
    values: [l.kind || "—", l.clicks || 0],
  }));
  return tabSection({
    title: "Web (analítica propia)" + (ambito.bizNombre ? ` · ${ambito.bizNombre}${ambito.funNombre ? ` · ${ambito.funNombre}` : ""}` : ""),
    accent: brand.accent,
    kpis,
    spark: sparkline(series, brand.accent),
    sparkLabel: "Páginas vistas / día",
    tables: [
      { title: "Páginas más vistas", html: topTable(["Página", "Vistas", "Únicos"], pageRows) },
      { title: "Enlaces con más clics", html: topTable(["Enlace", "Contexto", "Clics"], linkRows) },
    ],
  });
}

interface SectionArgs {
  title: string;
  accent: string;
  kpis: string;
  spark: string;
  sparkLabel: string;
  tables: Array<{ title: string; html: string }>;
  empty?: string;
}
function tabSection(s: SectionArgs): string {
  const tables = s.tables.map((t) =>
    `<div class="pdf-subblock"><h3>${esc(t.title)}</h3>${t.html}</div>`,
  ).join("");
  const sparkBlock = s.spark
    ? `<div class="pdf-spark-wrap"><div class="pdf-spark-lbl">${esc(s.sparkLabel)}</div>${s.spark}</div>`
    : "";
  const body = s.empty
    ? `<div class="pdf-empty">${esc(s.empty)}</div>`
    : `${s.kpis}${sparkBlock}${tables}`;
  return `<section class="pdf-tab pdf-page-break">`
    + `<h2 class="pdf-tab-title" style="border-color:${esc(s.accent)};color:${esc(s.accent)}">${esc(s.title)}</h2>`
    + body
    + `</section>`;
}

// ---- Resumen ejecutivo --------------------------------------------------

function renderSummary(bundle: AnalyticsBundle, waSeg: any, brand: BrandStyle): string {
  const o: any = bundle.overview || {};
  // Pintamos 6 KPIs cross-canal: lo que un dueño quiere ver en la primera página.
  const kpis = kpiRow([
    { label: "Contactos (CRM)", value: fmtNum(o.leadsTotal), sub: `+${fmtNum(o.leadsNew)} nuevos en rango` },
    { label: "Conversaciones", value: fmtNum(o.conversations) },
    { label: "Ventas Ads (leads)", value: fmtNum(o.adLeads) },
    { label: "Alcance IG", value: fmtNum(o.reach28d), sub: "28d" },
    { label: "Gasto Meta Ads", value: o.adSpend == null ? "—" : fmtMoney(o.adSpend) },
    { label: "WhatsApp out", value: fmtNum((waSeg && waSeg.sent) || 0) },
  ]);
  return `<section class="pdf-summary">`
    + `<h2 class="pdf-tab-title" style="border-color:${esc(brand.accent)};color:${esc(brand.primary)}">Resumen ejecutivo</h2>`
    + kpis
    + `</section>`;
}

// ---- CSS embebido + chrome del PDF -------------------------------------

function pdfStyles(brand: BrandStyle): string {
  // Todo el CSS va inline para que el PDF se renderice sin red.
  // @media print: A4, márgenes 14mm, page-break antes de cada section.
  // @page con counters para "Página N de M" en el footer.
  return `<style>
:root{--brand:${brand.primary};--accent:${brand.accent};}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;background:#fff;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.45;}
.pdf-app{max-width:880px;margin:0 auto;padding:24px 28px 80px;}
.pdf-toolbar{position:sticky;top:0;background:#fff;border-bottom:1px solid #e5e7eb;padding:10px 14px;display:flex;gap:10px;align-items:center;justify-content:flex-end;z-index:10;}
.pdf-toolbar button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;font-size:13px;}
.pdf-toolbar button.sec{background:#f1f5f9;color:#0f172a;}
.pdf-header{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 0 12px;border-bottom:3px solid var(--accent);}
.pdf-logo-img{max-height:48px;max-width:160px;display:block;object-fit:contain;}
.pdf-logo-svg svg{width:48px;height:48px;display:block;}
.pdf-title{flex:1;}
.pdf-title h1{margin:0;font-size:20px;font-weight:700;color:var(--brand);letter-spacing:-0.01em;}
.pdf-title .pdf-sub{margin-top:4px;color:#64748b;font-size:12px;}
.pdf-meta{text-align:right;font-size:11px;color:#64748b;}
.pdf-meta b{display:block;color:#0f172a;font-size:13px;}
.pdf-summary{margin:24px 0;}
.pdf-tab-title{font-size:16px;margin:0 0 14px;padding:6px 0 8px;border-bottom:2px solid var(--accent);color:var(--brand);font-weight:700;}
.pdf-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:14px;}
.pdf-kpis-4{grid-template-columns:repeat(4,minmax(0,1fr));}
.pdf-kpi{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;}
.pdf-kpi-lbl{color:#64748b;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;}
.pdf-kpi-val{font-size:18px;font-weight:700;color:var(--brand);margin-top:2px;}
.pdf-kpi-sub{color:#64748b;font-size:11px;margin-top:2px;}
.pdf-spark-wrap{margin:8px 0 14px;padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;}
.pdf-spark-lbl{font-size:11px;color:#64748b;margin-bottom:4px;font-weight:600;}
.pdf-spark{width:100%;height:60px;display:block;}
.pdf-spark-empty{font-size:11px;color:#94a3b8;font-style:italic;padding:14px 0;text-align:center;}
.pdf-subblock{margin:14px 0;}
.pdf-subblock h3{font-size:13px;margin:0 0 6px;color:var(--brand);font-weight:700;}
.pdf-table{width:100%;border-collapse:collapse;font-size:11px;}
.pdf-table thead th{background:#f1f5f9;color:#0f172a;text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:0.04em;}
.pdf-table tbody td{padding:6px 8px;border-bottom:1px solid #f1f5f9;}
.pdf-td-lbl{font-weight:500;color:#0f172a;}
.pdf-td-num{text-align:right;color:#475569;font-variant-numeric:tabular-nums;}
.pdf-table thead th.pdf-th-num{text-align:right;}
.pdf-td-txt{color:#475569;}
.pdf-empty{padding:14px;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;color:#64748b;font-size:12px;text-align:center;}
.pdf-footer{margin-top:32px;padding-top:14px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;color:#94a3b8;font-size:10px;}

/* Móvil: la página no se desliza de lado. La barra de imprimir va en dos líneas sin partir el
   botón, y cada fila de las tablas es una tarjeta con la etiqueta delante de cada valor. */
@media screen and (max-width:640px){
  .pdf-toolbar{flex-wrap:wrap;}
  .pdf-toolbar>span{flex-basis:100%;}
  .pdf-toolbar button{white-space:nowrap;}
  .pdf-toolbar button:last-child{flex:1;}
  .pdf-app{padding:16px 16px 60px;}
  .pdf-kpis,.pdf-kpis-4{grid-template-columns:repeat(2,minmax(0,1fr));}
  .pdf-tbl thead{display:none;}
  .pdf-tbl table,.pdf-tbl tbody,.pdf-tbl tr{display:block;}
  .pdf-tbl tr{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;margin-bottom:8px;}
  .pdf-tbl tbody td{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:3px 0;border:0;text-align:right;overflow-wrap:anywhere;}
  .pdf-tbl tbody td::before{content:attr(data-l);flex:none;text-align:left;color:#64748b;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;}
  .pdf-tbl tbody td.pdf-td-lbl{display:block;text-align:left;padding:0 0 6px;margin-bottom:4px;border-bottom:1px solid #e5e7eb;}
  .pdf-tbl tbody td.pdf-td-lbl::before{content:none;}
  .pdf-header{flex-wrap:wrap;}
  .pdf-footer{flex-direction:column;gap:4px;}
}

@media print{
  @page{size:A4;margin:14mm 12mm 18mm 12mm;}
  .pdf-toolbar{display:none !important;}
  .pdf-app{max-width:none;padding:0;}
  .pdf-page-break{break-before:page;page-break-before:always;}
  .pdf-summary{break-before:auto;page-break-before:auto;}
  body{font-size:11px;}
  .pdf-kpi-val{font-size:16px;}
  .pdf-table{font-size:10px;}
  /* Evita cortar filas/secciones de cabecera al saltar de página. */
  thead{display:table-header-group;}
  tr,.pdf-kpi,.pdf-subblock{break-inside:avoid;page-break-inside:avoid;}
}
</style>`;
}

function toolbar(rango: string, tabs: PdfTab[]): string {
  // El botón "Imprimir PDF" usa window.print() del navegador del cliente; el
  // diálogo nativo permite elegir destino "Guardar como PDF" → portabilidad
  // total sin necesidad de chromium server-side. El segundo botón cierra la
  // pestaña (handy si se abre desde el panel).
  const lbl = esc(rango);
  return `<div class="pdf-toolbar">`
    + `<span style="margin-right:auto;color:#64748b;font-size:12px;">Vista previa para imprimir · ${lbl} · ${esc(tabs.join(", ").toUpperCase())}</span>`
    + `<button class="sec" type="button" onclick="window.close()">Cerrar</button>`
    + `<button type="button" onclick="window.print()">Imprimir / Guardar como PDF</button>`
    + `</div>`;
}

// NEGOCIO-VISIBLE-1 (MET-RES-01) · el informe dice el NOMBRE del negocio, no su identificador
// interno: con LeadMatch e Ingeniero Binario en el mismo panel, el PDF tiene que decir de cuál es.
async function nombreNegocio(wsId: string): Promise<string> {
  const ws = await dbGetWorkspace(wsId).catch(() => null);
  return (ws && ws.label) || "Tu negocio";
}

// PULIDO-IG-1 · zona del negocio para la fecha y la hora del informe; si no es válida, Madrid.
async function zonaNegocio(wsId: string): Promise<string> {
  const ws = await dbGetWorkspace(wsId).catch(() => null);
  const z = String((ws && ws.timezone) || "").trim();
  if (z) { try { new Intl.DateTimeFormat("es-ES", { timeZone: z }); return z; } catch { /* zona no válida */ } }
  return "Europe/Madrid";
}

function header(brand: BrandStyle, negocio: string, rango: string, zona = "Europe/Madrid"): string {
  return `<header class="pdf-header">`
    + `<div class="pdf-logo">${brand.logoHtml}</div>`
    + `<div class="pdf-title"><h1>Informe de analítica</h1>`
    + `<div class="pdf-sub"><b>${esc(negocio)}</b> · ${esc(rango)}</div></div>`
    + `<div class="pdf-meta"><b>${esc(new Date().toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: zona }))}</b>`
    + `${esc(new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: zona }))}</div>`
    + `</header>`;
}

function footer(negocio: string, zona = "Europe/Madrid"): string {
  // El footer también aparece en la versión @media print: lo dejamos al final
  // del HTML; Chrome lo repite en cada página solo si el usuario activa
  // "Cabeceras y pies" en el diálogo (predeterminado en muchos casos). El
  // contador "Página N de M" lo añade Chrome automáticamente con esa opción.
  return `<footer class="pdf-footer">`
    + `<span>Generado el ${esc(new Date().toLocaleString("es-ES", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: zona }))}</span>`
    + `<span>Negocio: ${esc(negocio)}</span>`
    + `<span>metricas-pro · Digital Business Stack</span>`
    + `</footer>`;
}

// ---- Auto-print on load (UX premium) -----------------------------------

function autoPrintScript(): string {
  // Espera a que imágenes (logo) y SVGs terminen → entonces dispara print().
  // Si el usuario cancela el diálogo, no reabre (chequeo de flag). Sin "auto"
  // en query, no se autoejecuta — útil para previsualizar sin imprimir.
  return `<script>
(function(){
  try{
    var qs=new URLSearchParams(location.search);
    if(qs.get('auto')!=='1')return;
    var fired=false;
    function go(){if(fired)return;fired=true;try{setTimeout(function(){window.print();},250);}catch(_){}}
    if(document.readyState==='complete')go();
    else window.addEventListener('load',go);
  }catch(_){}
})();
</script>`;
}

// ---- API pública --------------------------------------------------------

/**
 * Genera el HTML imprimible del informe para el wsId, rango y tabs solicitados.
 * Llamada típica:
 *   exportAnalyticsPdf({wsId:'default', range:{preset:'last30d'}, tabs:['ig','ads','wa','web']})
 *
 * El call-site (Fastify handler) sólo tiene que poner el Content-Type:
 *   reply.type('text/html').send(await exportAnalyticsPdf({...}))
 */
export async function exportAnalyticsPdf(args: ExportAnalyticsPdfArgs): Promise<string> {
  const wsId = (args.wsId || "").trim() || currentWorkspaceId() || "default";
  const days = presetToDays(args.range?.preset, args.range?.days);
  const tabs = (args.tabs && args.tabs.length ? args.tabs : ALL_TABS)
    .filter((t) => ALL_TABS.includes(t));
  const win = args.win;
  const rango = win ? etiquetaRango(days, win).replace(/^./, (c) => c.toUpperCase()) : rangeLabel(days);

  // Abrimos scope ALS del wsId para que TODO el árbol (gatherAll → segs →
  // settings.get → channel-routing) vea ese workspace, no el del request.
  return await runWithWorkspace(wsId, async () => {
    // Bundle + WA en paralelo (WA es segmento aparte porque hereda phoneId
    // del wsId activo y no entra en gatherAll por defecto).
    // La cuenta de Instagram se resuelve DENTRO del workspace: una de otro negocio no se encuentra.
    const acct = args.igId ? resolveAccount(args.igId) : null;
    const reunir = () => Promise.all([
      gatherAll(days, win, undefined, args.fbPage, args.webAmbito).catch(() => null as AnalyticsBundle | null),
      segWhatsApp(days, args.waPhone, win).catch(() => ({}) as any),
      // PROPORCION-FB-1 · lo que Facebook trajo al negocio, sólo si se pide la pestaña.
      tabs.includes("fb") ? segFbAporte(days, win).catch(() => null) : Promise.resolve(null),
    ]);
    // MET-RES-06-FIN · la cuenta de Ads se busca SÓLO entre las de este workspace: una ajena no
    // se encuentra y el informe sale con la de siempre, igual que la vista.
    const ads = args.adsAcct ? metaAdsAccountsList().find((a) => a.adAccountId === args.adsAcct) : undefined;
    const conAds = () => (ads ? runWithAdsAccount({ adAccountId: ads.adAccountId, token: ads.token }, reunir) : reunir());
    const [bundle, waSeg, fbAporte] = await (acct ? runWithAccount(acct, conAds) : conAds());
    if (!bundle) {
      // No deberíamos llegar aquí (gatherAll es defensivo internamente), pero
      // por si acaso devolvemos un HTML válido con mensaje de error.
      return errorHtml(wsId, await nombreNegocio(wsId), "No se pudo generar el informe.");
    }

    const brand = resolveBrand(wsId);
    const negocio = await nombreNegocio(wsId);
    const zona = await zonaNegocio(wsId);
    const sections: string[] = [];
    sections.push(renderSummary(bundle, waSeg, brand));
    for (const t of tabs) {
      if (t === "ig") sections.push(renderIG(bundle, brand));
      else if (t === "fb") sections.push(renderFB(bundle.facebook, fbAporte, listFbAccounts().length > 0, brand));
      else if (t === "ads") sections.push(renderAds(bundle, brand));
      else if (t === "wa") sections.push(renderWA(waSeg, brand));
      else if (t === "web") sections.push(renderWeb(bundle, brand));
    }

    return `<!doctype html><html lang="es"><head>`
      + `<meta charset="utf-8"/>`
      + `<meta name="viewport" content="width=device-width,initial-scale=1"/>`
      + `<title>Informe analítica · ${esc(negocio)} · ${esc(rango)}</title>`
      + `<meta name="robots" content="noindex,nofollow"/>`
      + pdfStyles(brand)
      + `</head><body>`
      + toolbar(rango, tabs)
      + `<div class="pdf-app">`
      + header(brand, negocio, rango, zona)
      + lecturaResumen(args.lectura)
      + sections.join("")
      + footer(negocio, zona)
      + `</div>`
      + autoPrintScript()
      + `</body></html>`;
  });
}

// MET-RES-06-FIN · lo que CONCLUYE el Resumen (cómo ha ido el periodo, lo mejor, la mejora) se
// compone en el panel, no aquí: el panel lo deja en localStorage bajo una marca de un solo uso y
// este hueco lo pinta antes de imprimir, como texto (nunca HTML). Sin marca o sin dato, nada.
function lecturaResumen(marca?: string): string {
  const m = String(marca || "").replace(/[^a-z0-9]/gi, "").slice(0, 32);
  if (!m) return "";
  return `<section class="pdf-section" id="pdf-lectura" hidden></section><script>
(function(){
  try{
    var k='mxLect:${m}',t=localStorage.getItem(k);localStorage.removeItem(k);
    if(!t)return;var box=document.getElementById('pdf-lectura'),ul=null;
    // MET-RES-06-FIN · doble barra: con una sola, el template de TS emitía un salto real y el
    // literal quedaba roto (SyntaxError): el PDF salía siempre sin la lectura.
    t.split('\\n').forEach(function(l){
      var el;
      if(/^## /.test(l)){el=document.createElement('h2');el.textContent=l.slice(3);ul=null;}
      else if(/^### /.test(l)){el=document.createElement('h3');el.textContent=l.slice(4);ul=null;}
      else if(/^- /.test(l)){if(!ul){ul=document.createElement('ul');box.appendChild(ul);}var li=document.createElement('li');li.textContent=l.slice(2);ul.appendChild(li);return;}
      else if(l.trim()){el=document.createElement('p');el.textContent=l;ul=null;}
      else{ul=null;return;}
      box.appendChild(el);
    });
    if(box.childNodes.length)box.hidden=false;
  }catch(_){}
})();
</script>`;
}

function errorHtml(wsId: string, negocio: string, msg: string): string {
  const brand = resolveBrand(wsId);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"/><title>Error informe</title>`
    + pdfStyles(brand)
    + `</head><body><div class="pdf-app">`
    + header(brand, negocio, rangeLabel(30))
    + `<div class="pdf-empty">${esc(msg)}</div>`
    + footer(negocio)
    + `</div></body></html>`;
}

// Re-exporto presetToDays/ALL_TABS para que el handler valide query sin
// duplicar parsing.
export { presetToDays as _presetToDays, ALL_TABS as _ALL_TABS };
