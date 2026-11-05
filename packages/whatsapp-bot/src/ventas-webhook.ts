/**
 * VENTA-WEBHOOK-1 · Webhook de ventas UNIVERSAL: cualquier plataforma de pago (Stripe,
 * Hotmart, Shopify, WooCommerce, o un Zapier/Make en medio) avisa al panel de que alguien
 * ha comprado, y el panel lo marca como cliente con la MISMA pieza que ya usa systeme.io
 * (`markPurchased`: etapa ganada, etiquetas, nota en la ficha, corte de los flujos con
 * regla de compra y aviso).
 *
 *   POST /webhook/ventas?ws=<workspace>&k=<clave>
 *
 * La clave es POR WORKSPACE (`ventas.webhook.key`, secreta): el `ws` de la URL solo dice
 * dónde buscarla; sin la clave de ese negocio no se toca nada.
 *
 * No hay un formato propio que el cliente tenga que respetar: se lee el cuerpo (JSON o
 * formulario) y se buscan los datos por el NOMBRE del campo, a cualquier profundidad:
 *   - quién:   `ref` (el enlace de pago personal o el identificador del contacto),
 *              teléfono, o email — en ese orden.
 *   - qué:     id del pedido (para no contar dos veces un reintento), importe, divisa, producto.
 *   - si NO es una venta (reembolso, pago fallido, sesión caducada…) se ignora con 200,
 *     para que la plataforma no reintente.
 *
 * Además de `markPurchased` (que sólo actúa en la PRIMERA compra), cada venta deja
 * `fields.last_purchase_at` en la ficha: la condición «¿Ha comprado?» de los flujos la lee
 * para saber si compró DESPUÉS de recibir el enlace, también si ya era cliente de antes.
 */
import crypto from "node:crypto";
import { getContact, contactByEmail, addContactNote } from "./contacts.js";
import { dbUpdateContact } from "./db.js";
import { markPurchased, enCola } from "./purchase-guard.js";
import { get as getSetting, set as setSetting } from "./settings.js";
import { logActivity } from "./activity.js";
import { currentWorkspaceId } from "./workspace.js";

export const CLAVE_VENTAS = "ventas.webhook.key";

/** Clave del webhook de ventas del workspace activo; la crea si aún no existe. */
export async function claveVentas(crear = true): Promise<string> {
  let k = getSetting(CLAVE_VENTAS).trim();
  if (!k && crear) {
    k = "vt_" + crypto.randomBytes(18).toString("base64url");
    await setSetting(CLAVE_VENTAS, k);
  }
  return k;
}
export async function rotarClaveVentas(): Promise<string> {
  const k = "vt_" + crypto.randomBytes(18).toString("base64url");
  await setSetting(CLAVE_VENTAS, k);
  return k;
}
export function claveVentasValida(dada: string): boolean {
  const k = getSetting(CLAVE_VENTAS).trim();
  if (!k || !dada) return false;
  const a = Buffer.from(k), b = Buffer.from(String(dada));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Lectura del cuerpo: aplanado a hojas {ruta, clave, valor}.
// ---------------------------------------------------------------------------
type Hoja = { ruta: string; clave: string; valor: string; prof: number };
function aplanar(o: unknown, ruta = "", prof = 0, out: Hoja[] = []): Hoja[] {
  if (out.length > 2000 || prof > 8 || o == null) return out;
  if (Array.isArray(o)) { o.slice(0, 50).forEach((v, i) => aplanar(v, ruta + "[" + i + "]", prof + 1, out)); return out; }
  if (typeof o === "object") {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) aplanar(v, ruta ? ruta + "." + k : k, prof + 1, out);
    return out;
  }
  const clave = (ruta.split(".").pop() || "").replace(/\[\d+\]$/, "").toLowerCase();
  out.push({ ruta: ruta.toLowerCase(), clave, valor: String(o).trim(), prof });
  return out;
}
const primera = (h: Hoja[], re: RegExp, ok: (v: string) => boolean = (v) => !!v): string =>
  (h.filter((x) => re.test(x.clave) && ok(x.valor)).sort((a, b) => a.prof - b.prof)[0]?.valor) || "";

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digitos = (s: string) => String(s || "").replace(/\D/g, "");

// Estados y eventos. Un aviso se cuenta como venta solo si NINGÚN estado dice que no se ha
// cobrado y, cuando trae estados, alguno CONFIRMA el cobro. Lista blanca y no solo negra:
// Stripe con «enviar todos los eventos» manda invoice.created, customer.created… y Hotmart
// PURCHASE_OUT_OF_SHOPPING_CART (el carrito abandonado: justo a quien hay que recordar).
const RE_NO = /refund|reembols|devol|fail|fallid|cancel|expir|chargeback|dispute|disputa|protest|pending|pendiente|waiting|esperando|abandon|shopping_cart|cart|carrito|declin|rechaz|unpaid|impagad|no_payment|void|delay|billet|printed|under_anal|blocked|bloquead|no_funds|overdue|vencid|pre_order|on-hold|on_hold|draft|borrador|requires|incomplete|processing|created|creado/i;
const RE_SI = /(^|[^a-z])(paid|pagad[oa]|succeeded|success|successful|exitos[oa]|complete|completed|completad[oa]|approved|aprobad[oa]|captured|settled|confirmed|confirmad[oa])([^a-z]|$)/i;
// Divisas sin decimales: Stripe no las manda en céntimos.
const SIN_DECIMALES = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
// Datos que NO son del comprador (Hotmart trae productor y afiliados; un Zap puede meter
// el correo de la tienda) y rutas preferidas cuando hay varios.
const RE_AJENO = /producer|productor|seller|vendedor|merchant|affiliate|afiliad|support|soporte|owner|store|tienda|company|empresa|business|negocio|from|reply|admin/;
const RE_COMPRADOR = /buyer|customer|comprador|cliente|billing|payer|pagador|contact/;
const delComprador = (h: Hoja[], re: RegExp, ok: (v: string) => boolean): Hoja | undefined =>
  h.filter((x) => re.test(x.clave) && !RE_AJENO.test(x.ruta) && ok(x.valor))
    .sort((a, b) => (RE_COMPRADOR.test(a.ruta) ? 0 : 1) - (RE_COMPRADOR.test(b.ruta) ? 0 : 1) || a.prof - b.prof)[0];

export interface VentaLeida {
  ref: string; telefono: string; email: string;
  pedido: string; importe: number; divisa: string; producto: string;
  /** METRICAS-1 · lo devuelto, si el aviso es una devolución y lo trae (Stripe: amount_refunded). */
  devuelto: number | null;
  /** Motivo por el que NO es una venta (reembolso, fallo…); vacío si lo es. */
  noVenta: string;
}

/** Extrae de un cuerpo cualquiera lo que hace falta para registrar la venta. Exportada
 *  para el arnés: es la parte que más formatos distintos tiene que tragar. */
export function leerVenta(cuerpo: unknown): VentaLeida {
  const h = aplanar(cuerpo);
  // Solo los primeros niveles: más abajo hay estados de envío, de líneas de pedido…
  // «estado»/«evento» solo cuentan si dicen algo de un cobro (en México «estado» es la
  // provincia); «type» solo si parece un evento (checkout.session.completed, PURCHASE_APPROVED).
  const estados = h.filter((x) => x.prof <= 3 && (
    /^(event|event_type|status|payment_status|financial_status)$/.test(x.clave)
    || (/^(estado|evento)$/.test(x.clave) && (RE_SI.test(x.valor) || RE_NO.test(x.valor)))
    || (x.clave === "type" && /^\w+[._][\w.]+$/.test(x.valor))));
  const malo = estados.find((x) => RE_NO.test(x.valor));
  const noVenta = malo ? malo.clave + "=" + malo.valor
    : (estados.length && !estados.some((x) => RE_SI.test(x.valor))) ? estados[0].clave + "=" + estados[0].valor + " (no confirma el cobro)" : "";
  // ref: el campo explícito, o el ?ref= que viaje dentro de alguna URL (sourceURL, landing…).
  let ref = primera(h, /^(ref|lm_ref|reference|referencia|client_reference_id|contacto|contact_ref|sck|src)$/, (v) => /^[\w.+-]{4,64}$/.test(v));
  if (!ref) {
    const u = h.find((x) => /[?&]ref=[\w-]{4,64}/.test(x.valor));
    const m = u && /[?&]ref=([\w-]{4,64})/.exec(u.valor);
    if (m) ref = m[1];
  }
  const email = (delComprador(h, /e-?mail|correo/, (v) => RE_EMAIL.test(v)) || delComprador(h, /./, (v) => RE_EMAIL.test(v)))?.valor || "";
  const hTel = delComprador(h, /phone|tel[eé]fono|telefono|mobile|m[oó]vil|celular|whatsapp/, (v) => digitos(v).length >= 8);
  let telefono = digitos(hTel?.valor || "");
  // Prefijo de país en un campo hermano (Hotmart: checkout_phone + checkout_phone_code).
  if (hTel && !String(hTel.valor).trim().startsWith("+")) {
    const padre = hTel.ruta.slice(0, hTel.ruta.lastIndexOf(".") + 1);
    const cod = digitos(h.find((x) => x.ruta.startsWith(padre) && x.ruta.slice(padre.length).indexOf(".") < 0
      && /(phone_code|phone_country|country_code|dial_code|ddi|prefix|prefijo)$/.test(x.clave))?.valor || "");
    if (cod && cod.length <= 4 && !telefono.startsWith(cod) && telefono.length <= 11) telefono = cod + telefono;
  }
  // Stripe: una venta llega como varios eventos (checkout.session.completed,
  // payment_intent.succeeded, charge.succeeded, invoice.paid). Todos comparten la factura
  // o el cobro: ése es el pedido, no el id del evento.
  const esStripe = h.some((x) => x.ruta === "object" && x.valor === "event");
  const so = (k: string) => h.find((x) => x.ruta === "data.object." + k)?.valor || "";
  const pedido = (esStripe && (so("invoice") || (so("object") === "invoice" ? so("id") : "")
      || so("payment_intent") || (so("object") === "payment_intent" ? so("id") : "") || so("id")))
    || primera(h, /^(order_id|orderid|order_number|pedido|transaction|transaction_id|payment_id|payment_intent|charge|invoice|sale_id|purchase_id)$/)
    || (h.find((x) => x.prof === 1 && x.clave === "id")?.valor || "")
    || (h.find((x) => x.prof === 2 && /^(data|order|purchase|sale|object)\.id$/.test(x.ruta))?.valor || "");
  // Importe: el cobrado al comprador. Fuera comisiones, tasas, precio original o sin descuento.
  const RE_IMP = [/^(amount_total|amount_paid|amount_received|grand_total|total_price|total)$/, /^(price|precio|importe|amount)$/, /^(value|valor)$/];
  const okImp = (x: Hoja) => /^-?\d+([.,]\d+)?$/.test(x.valor) && !/commission|comision|fee|tax|impuesto|full_price|original|discount|descuento|shipping|envio|refund/.test(x.ruta);
  let bruto = "";
  for (const re of RE_IMP) {
    const x = h.filter((y) => re.test(y.clave) && okImp(y)).sort((a, b) => a.prof - b.prof)[0];
    if (x) { bruto = x.valor; break; }
  }
  let importe = Number(bruto.replace(",", ".")) || 0;
  const divisa = primera(h, /^(currency|currency_code|currency_value|moneda|divisa)$/, (v) => /^[a-z]{3}$/i.test(v)).toLowerCase();
  // Stripe manda los importes en la unidad mínima (céntimos), salvo las divisas sin decimales.
  if (esStripe && !SIN_DECIMALES.has(divisa)) importe = importe / 100;
  // «name» / «title» solo dentro de un producto, línea u oferta: sueltos suelen ser el nombre
  // del cliente. Los identificadores internos de Stripe (prod_…, price_…) no son un nombre.
  const okProd = (v: string) => v.length <= 120 && !RE_EMAIL.test(v) && !/^\d+$/.test(v) && !/^(prod|price|plan)_\w+$/.test(v);
  const producto = primera(h, /^(product_name|producto|product|offer_name|plan_name|item_name)$/, okProd)
    || (h.filter((x) => /^(name|title)$/.test(x.clave) && /product|item|offer|plan|line_items/.test(x.ruta) && okProd(x.valor)).sort((a, b) => a.prof - b.prof)[0]?.valor || "");
  const dv = primera(h, /^(amount_refunded|refunded_amount|refund_amount)$/, (x) => /^\d+([.,]\d+)?$/.test(x));
  let devuelto: number | null = dv ? Number(dv.replace(",", ".")) || null : null;
  if (devuelto != null && esStripe && !SIN_DECIMALES.has(divisa)) devuelto = devuelto / 100;
  return { ref, telefono, email: email.toLowerCase(), pedido: pedido.slice(0, 120), importe, divisa, producto: producto.slice(0, 120), noVenta, devuelto };
}

/** Busca el contacto del panel: enlace de pago personal → identificador directo →
 *  teléfono → email. Devuelve la clave del contacto (el teléfono en WhatsApp, el id de
 *  Instagram/Facebook en esos canales). */
async function resolverContacto(v: VentaLeida): Promise<{ phone: string; por: string; productId: string } | null> {
  const ws = currentWorkspaceId();
  if (v.ref) {
    const { resolvePaymentToken } = await import("./links.js");
    const pay = await resolvePaymentToken(v.ref).catch(() => null);
    if (pay && (pay.tenant_id || "default") === ws && pay.phone && (await getContact(pay.phone))) {
      return { phone: pay.phone, por: "enlace de pago", productId: pay.product_id || "" };
    }
    if (/^\d{6,}$/.test(v.ref) && (await getContact(v.ref))) return { phone: v.ref, por: "referencia", productId: "" };
  }
  if (v.telefono && (await getContact(v.telefono))) return { phone: v.telefono, por: "teléfono", productId: "" };
  if (v.email) {
    const c = await contactByEmail(v.email).catch(() => null);
    if (c?.phone) return { phone: c.phone, por: "email", productId: "" };
  }
  return null;
}

export type ResultadoVenta =
  | { ok: true; estado: "marcado" | "repetida" | "duplicada"; contacto: string; por: string }
  | { ok: true; estado: "ignorada"; motivo: string }
  | { ok: true; estado: "sin-contacto" };

// Stripe manda la misma venta en varios eventos casi a la vez: los avisos de un mismo
// contacto se procesan EN COLA (enCola, de purchase-guard), para que el segundo vea el
// pedido que dejó el primero.
// Pedido de respaldo cuando el aviso no trae ninguno: huella del cuerpo SIN las marcas de
// tiempo (un Zapier que reintenta con otro `timestamp` no es otra venta).
function huella(cuerpo: unknown): string {
  const hojas = aplanar(cuerpo).filter((x) => !/time|date|fecha|hora|sent|enviad|created|updated|attempt|intento|nonce|signature|firma/.test(x.clave));
  const txt = hojas.map((x) => x.ruta + "=" + x.valor).sort().join("\n");
  return "h:" + crypto.createHash("sha1").update(txt).digest("hex").slice(0, 20);
}

/** Registra una venta ya autenticada, dentro del ámbito del workspace. */
export async function procesarVenta(cuerpo: unknown): Promise<ResultadoVenta> {
  const v = leerVenta(cuerpo);
  const pista = (v.email ? v.email.replace(/^(.).*@/, "$1…@") : "") || (v.telefono ? "…" + v.telefono.slice(-4) : "") || (v.ref ? "ref …" + v.ref.slice(-4) : "sin datos");
  if (v.noVenta) {
    // METRICAS-1 · una devolución resta de la compra que ya se contó (antes se ignoraba y los
    // ingresos del enlace de pago seguían diciendo 97 € de una venta devuelta).
    if (/refund|reembols|devol|chargeback/i.test(v.noVenta) && v.pedido) {
      const { registrarDevolucion } = await import("./links.js");
      const n = await registrarDevolucion(currentWorkspaceId(), v.pedido, v.devuelto);
      if (n) {
        await logActivity({ source: "webhook", summary: "Devolución registrada: deja de contar como compra" + (v.devuelto ? " (" + v.devuelto + " " + v.divisa + ")" : ""), payload: { pista } });
        return { ok: true, estado: "ignorada", motivo: v.noVenta };
      }
    }
    await logActivity({ source: "webhook", summary: "Aviso de la plataforma de pago ignorado: no es un cobro (" + v.noVenta.slice(0, 60) + ")", payload: { pista } });
    return { ok: true, estado: "ignorada", motivo: v.noVenta };
  }
  const c = await resolverContacto(v);
  if (!c) {
    await logActivity({ source: "webhook", level: "warn", summary: "Venta recibida sin contacto en el panel (" + pista + ")", payload: { pista, producto: v.producto, importe: v.importe, divisa: v.divisa } });
    return { ok: true, estado: "sin-contacto" };
  }
  const pedido = v.pedido || huella(cuerpo);
  return enCola(currentWorkspaceId() + "|" + c.phone, async () => {
    const antes = await getContact(c.phone);
    const f0 = ((antes?.fields || {}) as Record<string, string>);
    // Los últimos pedidos vistos (no solo el último): un reintento tardío de A después de B
    // tampoco es una venta nueva.
    const vistos = String(f0.purchase_refs || f0.last_purchase_ref || "").split(" ").filter(Boolean);
    if (vistos.includes(pedido)) return { ok: true as const, estado: "duplicada" as const, contacto: c.phone, por: c.por };
    try {
      const { registrarCompra } = await import("./links.js");
      // product_id es el producto DEL PANEL (enlace de pago); un nombre suelto de la
      // plataforma crearía grupos fantasma en las métricas de productos.
      await registrarCompra({ tenant_id: currentWorkspaceId(), phone: c.phone, product_id: c.productId, token: v.ref, currency: v.divisa, amount: v.importe, via: "webhook de ventas", external_id: pedido });
    } catch { /* la marca del contacto no depende de la fila de métricas */ }
    const esPrimera = await markPurchased(c.phone, { currency: v.divisa, via: "webhook de ventas" });
    // Se relee DESPUÉS de markPurchased para no pisar lo que acaba de escribir.
    const ahora = await getContact(c.phone);
    const f1 = ((ahora?.fields || {}) as Record<string, string>);
    const refs = [...vistos.filter((x) => x !== pedido), pedido].slice(-20).join(" ");
    await dbUpdateContact(c.phone, { fields: { ...f1, last_purchase_at: new Date().toISOString(), last_purchase_ref: pedido, purchase_refs: refs } });
    const qué = (v.producto ? "«" + v.producto + "»" : "") + (v.importe ? " " + v.importe + (v.divisa ? " " + v.divisa.toUpperCase() : "") : "");
    if (!esPrimera) {
      try { await addContactNote(c.phone, "✔ Nueva compra" + (qué ? " " + qué.trim() : "") + " · detectada por el aviso de ventas", { kind: "compra", author: "sistema" }); } catch { /* cosmético */ }
    }
    await logActivity({ source: "webhook", summary: "Venta registrada" + (qué ? " " + qué.trim() : "") + " · contacto encontrado por " + c.por, payload: { contacto: "…" + c.phone.slice(-4), por: c.por, pedido: pedido.slice(0, 40), primera: esPrimera } });
    return { ok: true as const, estado: esPrimera ? "marcado" as const : "repetida" as const, contacto: c.phone, por: c.por };
  });
}

/** ¿Consta una compra de este contacto? Con `desdeMs`, solo las posteriores a ese
 *  instante. Lo usa la condición de los flujos. Sin marca de tiempo (la etiqueta de
 *  compra de un flujo) solo cuenta cuando no se pide ventana. */
export async function contactoCompro(phone: string, opts: { desdeMs?: number; etiquetas?: string[] } = {}): Promise<boolean> {
  const c = await getContact(phone);
  if (!c) return false;
  const f = (c.fields || {}) as Record<string, string>;
  const ts = [f.purchased_at, f.last_purchase_at].map((x) => Date.parse(String(x || ""))).filter((n) => n > 0);
  const desde = Number(opts.desdeMs || 0);
  if (desde > 0) return ts.some((t) => t >= desde);
  if (ts.length) return true;
  const want = (opts.etiquetas || []).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean);
  return want.length > 0 && (c.tags || []).some((t) => want.includes(String(t || "").trim().toLowerCase()));
}
