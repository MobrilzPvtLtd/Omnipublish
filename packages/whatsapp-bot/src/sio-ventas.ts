/**
 * VENTAS-SIO-1 · copia local de las ventas de los checkouts de systeme.io → app_sio_sales.
 *
 * El dueño preguntó «¿cuánto se ha recaudado?» y no había dónde mirarlo: el webhook de
 * systeme.io solo marca que alguien compró, sin importe, y app_purchases (PAGO-1) solo
 * recoge los enlaces de pago del panel. La fuente con el dinero es el listado de Ventas
 * del panel de systeme.io (/payment/transactions/list/v2): importe en céntimos, divisa,
 * email del comprador y fecha. Se lee con la cookie de la cuenta si la tiene y, si no,
 * por la sesión del puente (cuentas con usuario y contraseña). Nada que tocar en
 * systeme.io ni en el píxel.
 *
 * INCREMENTAL por fecha: cada pasada pide desde 3 días antes de la última venta copiada
 * (las devoluciones llegan después de la venta). La primera, el último año entero.
 * Idempotente: la clave es el id de la transacción.
 */
import { listAccountsRaw, type SiAccount } from "./systemeio-accounts.js";
import { currentWorkspaceId } from "./workspace.js";
import { get as getSetting } from "./settings.js";
import { dbSioSalesUpsert, dbSioSalesUltima, dbSioSalesSinMirarFunnel, dbSioSalesCerrarSinFunnel, type SioVenta, type VentaDeFlujo, type CompraDeContacto } from "./db.js";

const DIA = 86_400_000;
const POR_PAGINA = 50; // el endpoint rechaza más de 50 con HTTP 400
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isoSinMs = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

/** Una fila cruda del listado → venta, o null si no trae lo mínimo (id e importe). */
export function ventaDeTransaccion(accountId: string, t: unknown): SioVenta | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, any>;
  const id = o.id != null ? String(o.id) : "";
  const pago = (o.payment || {}) as Record<string, any>;
  // METRICAS-1 · Number(null) y Number("") dan 0: una fila sin importe no es una venta de 0 €.
  const centimos = pago.total == null || String(pago.total).trim() === "" ? NaN : Number(pago.total);
  if (!id || !Number.isFinite(centimos)) return null;
  const tipo = String(o.transactionType || "").toLowerCase();
  const cli = (o.invoice && o.invoice.customer) || {};
  const email = String(cli.email || (cli.contact && cli.contact.email) || "").trim().toLowerCase();
  const plan = pago.paymentItems && pago.paymentItems[0] && pago.paymentItems[0].orderItem && pago.paymentItems[0].orderItem.pricePlan;
  const cuando = Date.parse(String(pago.paidAt || o.transactionDate || ""));
  return {
    account_id: accountId,
    tx_id: id,
    kind: tipo === "refund" ? "refund" : "sale",
    email,
    amount: Math.abs(centimos) / 100,
    currency: String(pago.currency || (plan && plan.currency) || "").toLowerCase(),
    product: String((plan && plan.name) || ""),
    paid_at: Number.isFinite(cuando) ? cuando : null,
    ...funnelDeTransaccion(o),
  };
}

/**
 * FUNNELS-1 · en qué funnel y en qué paso se hizo la venta, y qué oferta se cobró.
 *
 * La forma documentada es payment.paymentItems[].orderItem.offer.{id, funnelStep.{id, funnel.id}},
 * pero NO está comprobada contra una respuesta real del listado: se mira esa ruta y sus vecinas
 * plausibles (la oferta colgando del artículo, del pago o de la transacción; el paso con otro
 * nombre; el funnel como objeto o como número suelto). Lo que no aparezca se queda en '' —nunca
 * se inventa—, y entonces el paso se busca por la oferta (dbFunnel*, SQL_VENTAS_CON_FUNNEL).
 */
export function funnelDeTransaccion(t: unknown): { funnel_id: string; step_id: string; offer_id: string } {
  const vacio = { funnel_id: "", step_id: "", offer_id: "" };
  if (!t || typeof t !== "object") return vacio;
  const o = t as Record<string, any>;
  const obj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);
  // Un identificador es un número o un texto corto; un objeto o un vacío no lo son.
  const id = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v.trim().slice(0, 80) : "");
  const idDe = (v: unknown): string => { const x = obj(v); return x ? id(x.id) : id(v); };
  const pago = obj(o.payment) || {};
  const items: unknown[] = Array.isArray(pago.paymentItems) ? pago.paymentItems : [];
  // Dónde puede venir la oferta, de lo más concreto a lo más general.
  const sitios: Array<Record<string, any>> = [];
  for (const it of items) {
    const i = obj(it);
    if (!i) continue;
    const oi = obj(i.orderItem);
    if (oi) sitios.push(oi);
    sitios.push(i);
  }
  const oiSuelto = obj(o.orderItem);
  if (oiSuelto) sitios.push(oiSuelto);
  sitios.push(pago, o);
  let oferta = "";
  for (const s of sitios) {
    const of = obj(s.offer);
    // El paso cuelga de la oferta; por si acaso, también del propio sitio.
    for (const dueno of [of, s]) {
      if (!dueno) continue;
      const paso = obj(dueno.funnelStep) || obj(dueno.funnel_step);
      const step = paso ? id(paso.id) : id(dueno.funnelStepId);
      const funnel = (paso && (idDe(paso.funnel) || id(paso.funnelId))) || idDe(dueno.funnel) || id(dueno.funnelId);
      if (!oferta) oferta = (of && id(of.id)) || id(s.offerId);
      if (step || funnel) return { funnel_id: funnel || "", step_id: step, offer_id: (of && id(of.id)) || id(s.offerId) || oferta };
    }
  }
  return { ...vacio, offer_id: oferta };
}

/** La cuenta entra con usuario y contraseña (propia o la global del puente). */
const entraConContrasena = (a: SiAccount): boolean => !!a.sandboxPass;

/** Inyectable en pruebas: una página del listado (datos crudos) para esa cuenta. */
export const _ventasFetcher = {
  pagina: async (acc: SiAccount, query: string): Promise<{ ok: boolean; data: unknown; reason: string | null }> => {
    const { fetchSystemeioTransactionsPage } = await import("./mcp-bridge.js");
    return fetchSystemeioTransactionsPage(acc.id, query);
  },
};

export interface VentasSyncResult {
  accountId: string;
  pages: number;
  scanned: number;
  added: number;
  done: boolean;
  error?: string;
}

const cortadas = new Set<string>(); // cuentas cuya última pasada no llegó al final

// CIFRAS-CLARAS-1 (DASH-10) · cómo acabó la última lectura de ventas de cada cuenta, por workspace.
// Antes un fallo (sesión caducada, systeme.io caído) sólo iba a la consola: el Dashboard seguía
// diciendo «No hubo ventas» con la fuente cortada. En memoria: tras un reinicio no se sabe nada
// hasta la siguiente pasada (90 s y luego cada 15 min), y entonces la tarjeta no avisa de más.
const ultimaLectura = new Map<string, { at: number; error: string }>();
const claveLectura = (accountId: string) => currentWorkspaceId() + ":" + accountId;

/** VENTAS-CORTE-1 (SIO-API-F8) · desde el corte las ventas llegan por el aviso de systeme.io
 *  (systemeio-webhook.ts → app_sio_sales con origen='webhook') y el sondeo por sesión no corre.
 *  Volver atrás = poner esto a true Y dejar de copiar avisos (dbSioSalesDesdeAviso): si no, las
 *  ventas de después del corte saldrían dos veces (la sesión las trae con otro id). */
export const VENTAS_POR_SONDEO = false;
/** Hay de dónde sacar las ventas: con el sondeo, la contraseña de la cuenta; desde el corte,
 *  la clave del aviso de systeme.io del negocio (sin ella no llega ninguna venta). */
export const puedeLeerVentas = (a: Partial<SiAccount>): boolean =>
  VENTAS_POR_SONDEO ? entraConContrasena(a as SiAccount) : !!String(getSetting("systemeio.webhook.key") || "");

/** El error de la última lectura de ventas de esa cuenta en este workspace, o "" si fue bien o no se sabe. */
export const errorVentasSio = (accountId: string): string => ultimaLectura.get(claveLectura(accountId))?.error || "";
/** FUNNELS-1 · ¿la última lectura de ventas de esa cuenta en este workspace acabó bien? false si
 *  falló o si aún no se ha leído (tras un reinicio, o en un workspace que el programador no recorre):
 *  quien pinta cifras no puede dar un 0 por medido sin esto. */
export const ventasLeidasBien = (accountId: string): boolean => {
  if (!VENTAS_POR_SONDEO) return puedeLeerVentas({});
  const u = ultimaLectura.get(claveLectura(accountId));
  return !!u && !u.error;
};
// FUNNELS-1 · cuándo se intentó por última vez la pasada del año entero para rellenar el funnel de
// las ventas antiguas. Una cuenta que no llega al final (más páginas que el tope, o una que siempre
// falla) la repetiría en cada tick para siempre: como mucho una vez al día.
const rellenoAnual = new Map<string, number>();

/** Copia las ventas nuevas de UNA cuenta y apunta si la lectura falló. */
export async function syncVentasSio(acc: SiAccount, maxPages = 200): Promise<VentasSyncResult> {
  try {
    const out = await pasadaVentasSio(acc, maxPages);
    ultimaLectura.set(claveLectura(acc.id), { at: Date.now(), error: out.error || "" });
    return out;
  } catch (e) {
    ultimaLectura.set(claveLectura(acc.id), { at: Date.now(), error: (e as Error).message || "error al leer las ventas" });
    throw e;
  }
}

async function pasadaVentasSio(acc: SiAccount, maxPages: number): Promise<VentasSyncResult> {
  const out: VentasSyncResult = { accountId: acc.id, pages: 0, scanned: 0, added: 0, done: false };
  // Si la pasada anterior se cortó a medias, no se sabe en qué orden llegaron las páginas:
  // se vuelve a pedir el año entero (lo ya copiado no se duplica).
  // FUNNELS-1 · las ventas copiadas antes de guardar el funnel (funnel_id NULL) sólo lo reciben
  // releyendo su transacción: mientras quede alguna dentro del año, la pasada es del año entero.
  const anual = Date.now() - 365 * DIA;
  const pendientes = (await dbSioSalesSinMirarFunnel(acc.id, anual)) > 0;
  const sinMirar = pendientes && Date.now() - (rellenoAnual.get(claveLectura(acc.id)) || 0) > DIA;
  if (sinMirar) rellenoAnual.set(claveLectura(acc.id), Date.now());
  const ultima = cortadas.has(acc.id) || sinMirar ? 0 : await dbSioSalesUltima(acc.id);
  const desde = ultima ? ultima - 3 * DIA : anual;
  cortadas.add(acc.id);
  const hasta = Date.now() + DIA;
  let cursor = "";
  for (let p = 0; p < maxPages; p++) {
    const qs = new URLSearchParams();
    qs.append("pagination[order]", "next");
    qs.append("pagination[limit]", String(POR_PAGINA));
    qs.append("filter[dateFrom]", isoSinMs(desde));
    qs.append("filter[dateTo]", isoSinMs(hasta));
    if (cursor) qs.append("pagination[startingAfter]", cursor);
    const r = await _ventasFetcher.pagina(acc, qs.toString());
    out.pages++;
    if (!r.ok) { out.error = r.reason || "systeme.io no respondió"; return out; }
    const d = r.data as { items?: unknown[]; hasMore?: boolean } | null;
    if (!d || !Array.isArray(d.items)) { out.error = "systeme.io devolvió algo que no es el listado de ventas"; return out; }
    const filas = d.items.map((t) => ventaDeTransaccion(acc.id, t)).filter((v): v is SioVenta => !!v);
    out.scanned += d.items.length;
    out.added += await dbSioSalesUpsert(filas);
    const ultimo = d.items[d.items.length - 1] as { id?: unknown } | undefined;
    if (!d.hasMore || !d.items.length || !ultimo || ultimo.id == null) {
      cortadas.delete(acc.id);
      // Pasada completa: lo que siga sin funnel en la ventana recorrida ya se miró y no lo trae.
      if (sinMirar) await dbSioSalesCerrarSinFunnel(acc.id, desde);
      out.done = true;
      return out;
    }
    cursor = String(ultimo.id);
    await sleep(300); // respirar entre páginas
  }
  // METRICAS-1 · agotar el tope de páginas no es una lectura completa: sin esto ventasLeidasBien()
  // daba por medida una cifra parcial.
  out.error = "hay más ventas de las que se leen de una vez: la cifra puede estar incompleta";
  return out;
}

/** Todas las cuentas que pueden leer el listado: con cookie o con contraseña guardada. */
export async function cuentasConVentas(): Promise<SiAccount[]> {
  return (await listAccountsRaw()).filter(puedeLeerVentas);
}

export interface ResumenVentas {
  /** Neto por divisa (ventas − devoluciones), de mayor a menor. */
  total: Array<{ currency: string; importe: number; ventas: number }>;
  /** Quién compró, lo último primero. Importe en su divisa principal; 0 con `sinImporte` si
   *  ninguna de sus compras trajo importe. */
  compradores: Array<{ phone: string; name: string; source: string; importe: number; currency: string; at: number; product: string; estimado?: boolean; sinImporte?: boolean;
    /** DIVISA-1 · todo lo que pagó, moneda a moneda (neto, solo las que quedan en positivo), de mayor a menor. */
    ingresos: IngresoMoneda[];
    /** DIVISA-1 · cuántas compras hizo (sin contar devoluciones): con una sola, es un cobro suelto. */
    compras: number }>;
  /** flow_id → neto en la divisa principal del conjunto (total[0]). */
  porFlujo: Map<string, number>;
  /** DIVISA-1 · flow_id → neto en CADA moneda, de mayor a menor. `porFlujo` solo trae la principal:
   *  un flujo que vende en dólares salía a 0 si el conjunto vendía más en euros. */
  porFlujoMonedas: Map<string, IngresoMoneda[]>;
  /** COMPRAS-CONTACTO-1 · algún importe sale del precio del producto (enlace de pago sin importe). */
  estimado: boolean;
  /** COMPRAS-CONTACTO-1 · ventas de las que no se sabe el importe (cuentan como venta, no suman). */
  sinImporte: number;
}
/** DIVISA-1 · un importe en su moneda. Es la forma que entiende el ayudante de divisa del panel. */
export interface IngresoMoneda { moneda: string; importe: number }
const red2 = (n: number): number => Math.round(n * 100) / 100;
/** Agrega las ventas de los flujos: total, compradores y reparto por flujo. Con el catálogo, las
 *  compras del panel que no trajeron importe se cuentan al precio del producto (estimado). */
export function resumenDeVentas(v: VentaDeFlujo[], catalogo: ProductoDeCatalogo[] = []): ResumenVentas {
  const porDivisa = new Map<string, { importe: number; ventas: number }>();
  const personas = new Map<string, { phone: string; name: string; source: string; por: Map<string, number>; at: number; product: string; estimado: boolean; sinImporte: boolean; compras: number }>();
  const porFlujo = new Map<string, Map<string, number>>();
  let estimado = false, sinImporte = 0;
  for (const x of v) {
    const panel = x.origen === "panel";
    const i = importeDeCompra({ origen: panel ? "panel" : "web", product_id: x.product_id || "", amount: x.amount, currency: x.currency }, catalogo);
    const neto = x.kind === "refund" ? -i.importe : i.importe;
    const product = panel ? (catalogo.find((p) => p.id === x.product_id)?.label || "Enlace de pago") : x.product;
    if (i.estimado) estimado = true;
    if (i.sinImporte) sinImporte++;
    // Una venta sin importe no entra en el total de ninguna divisa: se cuenta aparte (sinImporte).
    if (!i.sinImporte) {
      const d = porDivisa.get(i.currency) || { importe: 0, ventas: 0 };
      d.importe += neto;
      if (x.kind !== "refund") d.ventas++;
      porDivisa.set(i.currency, d);
    }
    const p = personas.get(x.phone) || { phone: x.phone, name: x.name, source: x.source, por: new Map<string, number>(), at: 0, product: "", estimado: false, sinImporte: false, compras: 0 };
    if (!i.sinImporte) p.por.set(i.currency, (p.por.get(i.currency) || 0) + neto);
    else if (x.kind !== "refund") p.sinImporte = true;
    if (i.estimado) p.estimado = true;
    if (x.kind !== "refund") p.compras++;
    if (x.kind !== "refund" && x.paid_at > p.at) { p.at = x.paid_at; p.product = product; }
    personas.set(x.phone, p);
    if (!i.sinImporte) {
      const pf = porFlujo.get(i.currency) || new Map<string, number>();
      pf.set(x.flow_id, (pf.get(x.flow_id) || 0) + neto);
      porFlujo.set(i.currency, pf);
    }
  }
  const total = [...porDivisa].map(([currency, d]) => ({ currency, importe: red2(d.importe), ventas: d.ventas })).sort((a, b) => b.importe - a.importe || b.ventas - a.ventas);
  const principal = total[0]?.currency ?? "";
  const flujos = new Map<string, number>();
  for (const [fid, n] of porFlujo.get(principal) || []) flujos.set(fid, red2(n));
  // DIVISA-1 · el mismo reparto sin tirar ninguna moneda: el panel las suma al cambio del día.
  const porFlujoMonedas = new Map<string, IngresoMoneda[]>();
  for (const [moneda, pf] of porFlujo) for (const [fid, n] of pf) {
    const l = porFlujoMonedas.get(fid) || [];
    l.push({ moneda, importe: red2(n) });
    porFlujoMonedas.set(fid, l);
  }
  for (const l of porFlujoMonedas.values()) l.sort((a, b) => b.importe - a.importe);
  const compradores: ResumenVentas["compradores"] = [];
  for (const p of personas.values()) {
    const [currency, importe] = [...p.por].sort((a, b) => b[1] - a[1])[0] || ["", 0];
    const ingresos: IngresoMoneda[] = [...p.por].filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]).map(([moneda, n]) => ({ moneda, importe: red2(n) }));
    // Sin importe también compró: sale en la lista (con «sin importe»), no desaparece.
    if (importe > 0) compradores.push({ phone: p.phone, name: p.name, source: p.source, importe: red2(importe), currency, at: p.at, product: p.product, estimado: p.estimado || undefined, ingresos, compras: p.compras });
    else if (p.sinImporte && p.at > 0) compradores.push({ phone: p.phone, name: p.name, source: p.source, importe: 0, currency: "", at: p.at, product: p.product, sinImporte: true, ingresos: [], compras: p.compras });
  }
  compradores.sort((a, b) => b.at - a.at);
  return { total, compradores, porFlujo: flujos, porFlujoMonedas, estimado, sinImporte };
}

/** COMPRAS-CONTACTO-1 · lo mínimo del catálogo de productos del panel (purchaseLinks) para
 *  poner precio a una compra que no trajo importe. */
export interface ProductoDeCatalogo { id: string; label?: string; currency?: string; price?: number }
/** Lo que costó una compra: el importe que trajo o, si el enlace de pago no lo trajo, el precio
 *  configurado del producto (estimado, como en Enlaces de pago). Sin ninguno de los dos no se
 *  inventa: `sinImporte`. */
export function importeDeCompra(
  c: Pick<CompraDeContacto, "origen" | "product_id" | "amount" | "currency">,
  catalogo: ProductoDeCatalogo[],
): { importe: number; currency: string; estimado: boolean; sinImporte: boolean } {
  if (c.origen !== "panel" || c.amount > 0) return { importe: c.amount, currency: c.currency, estimado: false, sinImporte: false };
  const p = catalogo.find((x) => x.id === c.product_id);
  const currency = c.currency || String(p?.currency || "").toLowerCase();
  if (p && Number(p.price) > 0) return { importe: Number(p.price), currency, estimado: true, sinImporte: false };
  return { importe: 0, currency, estimado: false, sinImporte: true };
}
export interface GastoDePersona {
  /** Neto por divisa (compras − devoluciones), de mayor a menor. Nunca se suman divisas distintas. */
  total: Array<{ currency: string; importe: number }>;
  compras: number;
  devoluciones: number;
  /** Última compra (no devolución), epoch ms. */
  ultima: number;
  /** Algún importe sale del precio del producto porque la venta no lo trajo. */
  estimado: boolean;
  /** Compras de las que no se sabe el importe. */
  sinImporte: number;
}
/** COMPRAS-CONTACTO-1 · agrega unas compras. Cada venta cuenta una vez aunque la vean dos fichas
 *  con el mismo email (misma `ref`). */
export function gastoDeCompras(filas: CompraDeContacto[], catalogo: ProductoDeCatalogo[]): GastoDePersona {
  const div = new Map<string, number>();
  const vistas = new Set<string>();
  const g: GastoDePersona = { total: [], compras: 0, devoluciones: 0, ultima: 0, estimado: false, sinImporte: 0 };
  for (const f of filas) {
    if (vistas.has(f.ref)) continue;
    vistas.add(f.ref);
    const i = importeDeCompra(f, catalogo);
    if (f.kind === "refund") {
      g.devoluciones++;
      div.set(i.currency, (div.get(i.currency) || 0) - i.importe);
      continue;
    }
    g.compras++;
    if (f.at > g.ultima) g.ultima = f.at;
    if (i.estimado) g.estimado = true;
    if (i.sinImporte) { g.sinImporte++; continue; }
    div.set(i.currency, (div.get(i.currency) || 0) + i.importe);
  }
  g.total = [...div].map(([currency, importe]) => ({ currency, importe: red2(importe) })).sort((a, b) => b.importe - a.importe);
  return g;
}
/** COMPRAS-CONTACTO-1 · lo mismo, persona a persona (teléfono → gasto). */
export function gastoPorPersona(filas: CompraDeContacto[], catalogo: ProductoDeCatalogo[]): Map<string, GastoDePersona> {
  const por = new Map<string, CompraDeContacto[]>();
  for (const f of filas) { const a = por.get(f.phone); if (a) a.push(f); else por.set(f.phone, [f]); }
  const out = new Map<string, GastoDePersona>();
  for (const [phone, fs] of por) out.set(phone, gastoDeCompras(fs, catalogo));
  return out;
}
