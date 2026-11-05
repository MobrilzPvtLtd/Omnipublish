/**
 * Receptor de webhooks de systeme.io / leadmatch-lab.
 *
 * Verifica la clave compartida, resuelve una cuenta activa inequívoca y procesa
 * registros/compras en su workspace. El diagnóstico conserva solo sus eventos;
 * los avisos sin un destino verificado se registran sin datos de contacto.
 *
 * Eventos que enviará systeme.io (según su pantalla "Crear Webhook"):
 *   - "Registro"            → alguien se suscribe por un formulario de registro (landing)
 *   - "Asignación de etiqueta" → se le asignó una etiqueta (p.ej. la de "abrió el correo")
 *   - Creación de contacto / Eliminación de etiqueta / Ventas
 */
import crypto from "node:crypto";
import { get } from "./settings.js";
import { recordWebhook } from "./webhookDebug.js";
import { avisarLeadNuevo } from "./notifications.js";
import { getContact, enrichContact, contactByEmail, createContact, addContactNote } from "./contacts.js";
import { dbUpdateContact, dbSioWebhookSaleInsert, dbSioSalesDesdeAviso } from "./db.js";
import { parseUtm } from "./attribution.js";
import { runWithWorkspace, currentWorkspaceId } from "./workspace.js";
import { sioBookingsPokeSoon } from "./sio-bookings.js";
import { listAccounts as siListAccounts } from "./systemeio-accounts.js";
import { handleSioWebhookForEmailEvents, resolveEmailEventAccount } from "./email-events.js";
import { resolvePaymentToken } from "./links.js";

export interface SioWebhookHit {
  tenant_id?: string;
  at: number;
  event: string;
  email: string;
  bodyText: string; // payload crudo (recortado a 4 KB)
  headers: Record<string, string>;
}

const RING: SioWebhookHit[] = [];
const RING_MAX = 25;

/** Últimos webhooks recibidos, más reciente primero. Para inspección desde el panel. */
export function getSioWebhookLog(opts: { allTenants?: boolean } = {}): SioWebhookHit[] {
  const tenant = currentWorkspaceId();
  return RING.filter((hit) => opts.allTenants || hit.tenant_id === tenant).slice().reverse();
}

function pushHit(h: SioWebhookHit): void {
  RING.push(h);
  if (RING.length > RING_MAX) RING.splice(0, RING.length - RING_MAX);
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** SIO-FIRMA-1 · systeme.io firma cada aviso en X-Webhook-Signature: HMAC-SHA256 (hex) del
 *  cuerpo con la «clave secreta» que se puso al crear el webhook. No manda x-webhook-key, así
 *  que un webhook dado de alta sin ?k= se rechazaba siempre (401) y systeme.io acababa
 *  desactivando la suscripción por BAD_SUCCESS_RATE. Se prueba el cuerpo tal cual llega y su
 *  forma normalizada (unicode y "/" escapados, como lo serializa PHP). */
function sioJsonPhp(o: unknown): string {
  return JSON.stringify(o)
    .replace(/\//g, "\\/")
    .replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
export function sioFirmaValida(signature: string, raw: string, json: unknown, secrets: string[]): boolean {
  const sig = signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const cuerpos = [raw];
  try { if (json && typeof json === "object") cuerpos.push(sioJsonPhp(json)); } catch { /* noop */ }
  for (const sec of secrets) {
    if (!sec) continue;
    for (const c of cuerpos) {
      if (timingSafeEq(crypto.createHmac("sha256", sec).update(c, "utf8").digest("hex"), sig)) return true;
    }
  }
  return false;
}

function safeStringify(o: unknown): string {
  try {
    return JSON.stringify(o);
  } catch {
    return String(o);
  }
}

/** Etiqueta que se pone al contacto cuando se confirma su registro en systeme.io. */
export const SIO_REGISTRADO_TAG = "sio-registrado";

/** Saca el token `ref` del payload: 1) de la URL de origen (?ref=…), 2) de un campo
 *  del contacto llamado/con slug "ref". Vacío si no viaja (→ no se puede cruzar). */
function extractRef(json: any): string {
  const src = String(json?.contact?.sourceURL || json?.sourceURL || json?.data?.contact?.sourceURL || "");
  const m = src.match(/[?&]ref=([^&#]+)/);
  if (m && m[1]) {
    try { return decodeURIComponent(m[1]).trim(); } catch { return m[1].trim(); }
  }
  const fields = json?.contact?.fields || json?.data?.contact?.fields || [];
  if (Array.isArray(fields)) {
    for (const f of fields) {
      const slug = String(f?.slug || f?.fieldName || "").toLowerCase();
      if (slug === "ref" || slug.includes("ref")) {
        const val = String(f?.value || "").trim();
        if (val) return val;
      }
    }
  }
  return "";
}

/** Cruza un evento de systeme.io con NUESTRO contacto (por el token `ref`=IGSID/teléfono
 *  que el flujo puso en el enlace) y lo marca como registrado. Best-effort: si no hay
 *  token, o el token no es un contacto nuestro, no hace nada. */
async function correlateSioRegistration(json: any): Promise<void> {
  const ref = extractRef(json);
  if (!ref) return;
  // La sourceURL de la landing trae la ATRIBUCIÓN del lead (utm_source/medium/content).
  // Antes se descartaba (solo se sacaba `ref`): ahora la parseamos y la guardamos en el
  // contacto para el dashboard de origen de leads.
  const sourceUrl = String(json?.contact?.sourceURL || json?.sourceURL || json?.data?.contact?.sourceURL || "");
  const utm = parseUtm(sourceUrl);
  await runWithWorkspace(currentWorkspaceId(), async () => {
    const c = await getContact(ref);
    if (!c) return; // el ref no corresponde a un contacto nuestro
    // ETQ-07-FIN · el registro queda como DATO con su fecha; la etiqueta sigue para los flujos,
    // pero los resultados cuentan este campo, no el nombre de la etiqueta.
    const yaReg = String(((c.fields || {}) as Record<string, unknown>).sio_registered_at || "");
    await enrichContact(ref, { tags: [SIO_REGISTRADO_TAG], ...(yaReg ? {} : { fields: { sio_registered_at: new Date().toISOString() } }) });
    // Escribe utm_* solo si vienen en la URL (no pises una atribución previa con vacíos).
    if (Object.keys(utm).length) {
      try {
        await dbUpdateContact(ref, utm);
        if (sourceUrl) await enrichContact(ref, { fields: { source_url: sourceUrl.slice(0, 500) } });
        recordWebhook(
          "systemeio",
          "🎯 atribución …" + ref.slice(-6) + " → " + (utm.utm_source || "?") + (utm.utm_content ? " · " + utm.utm_content : ""),
        );
      } catch (e) {
        recordWebhook("systemeio", "⚠️ no se pudo guardar la atribución de …" + ref.slice(-6) + ": " + (e as Error).message);
      }
    }
    recordWebhook("systemeio", "🔗 registro cruzado con contacto …" + ref.slice(-6) + " → etiqueta " + SIO_REGISTRADO_TAG);
  });
}

/**
 * ALTA UNIFICADA · Business Stack es la herramienta que unifica: todo evento de
 * la web que traiga un contacto con email acaba en una ficha del CRM con TODA
 * su información (nombre, email, campos del formulario, etiquetas, atribución
 * UTM y de qué web vino). El orden de casado evita duplicados:
 *
 *   1) token `ref` (el flujo del panel lo mete en el enlace con {{phone}}) →
 *      el registro se FUSIONA en la ficha que ya existía (p. ej. el contacto de
 *      Instagram que recibió el DM con el enlace gana su email y su formulario);
 *   2) sin ref, por EMAIL exacto → se enriquece esa ficha;
 *   3) sin nada que case → ficha nueva `email:<email>`, source 'systemeio'.
 *
 * La cuenta web de origen se deduce del dominio de la sourceURL contra las
 * conexiones. Best-effort y aditivo: nunca pisa un nombre ya puesto con vacíos.
 */
async function importSioContact(json: any, accountId = ""): Promise<void> {
  const cj = (json?.contact || json?.data?.contact || json) ?? {};
  const email = String(cj?.email || json?.email || json?.data?.email || "").trim().toLowerCase();
  if (!email || email.indexOf("@") < 0) return;
  const first = String(cj?.firstName || cj?.first_name || "").trim();
  const last = String(cj?.lastName || cj?.last_name || "").trim();
  const nombre = (first + " " + last).trim();
  const sourceUrl = String(cj?.sourceURL || json?.sourceURL || json?.data?.contact?.sourceURL || "");
  const utm = parseUtm(sourceUrl);
  // Campos a medida del formulario → fields de la ficha (slug → valor).
  const fields: Record<string, string> = {};
  if (Array.isArray(cj?.fields)) {
    for (const f of cj.fields) {
      const slug = String(f?.slug || f?.fieldName || "").trim().toLowerCase();
      const val = String(f?.value ?? "").trim();
      if (slug && val && slug !== "ref") fields[slug] = val.slice(0, 300);
    }
  }
  // Etiquetas de la web → etiquetas de la ficha (merge aditivo).
  const tags: string[] = [];
  if (Array.isArray(cj?.tags)) {
    for (const t of cj.tags) { const n = String((t && (t.name ?? t)) || "").trim(); if (n) tags.push(n.slice(0, 60)); }
  }
  // ¿De qué web vino? El dominio de la landing contra las cuentas conectadas.
  let cuenta = accountId;
  try {
    const host = sourceUrl ? new URL(sourceUrl).hostname : "";
    if (host && !cuenta) {
      for (const a of await siListAccounts()) {
        try { if (a.panelBaseUrl && new URL(a.panelBaseUrl).hostname === host) { cuenta = a.id; break; } } catch { /* URL rara */ }
      }
    }
  } catch { /* sin cuenta no pasa nada */ }
  await runWithWorkspace(currentWorkspaceId(), async () => {
    // 1) ref → la ficha que ya existía (la unificación de verdad).
    let phone = "";
    const ref = extractRef(json);
    if (ref && (await getContact(ref))) phone = ref;
    // 2) email exacto.
    if (!phone) { const c = await contactByEmail(email); if (c) phone = c.phone; }
    if (!phone && (await getContact("email:" + email))) phone = "email:" + email;
    // 3) ficha nueva.
    let creada = false;
    if (!phone) {
      phone = "email:" + email;
      await createContact({ phone, email, name: nombre || email, source: "systemeio", systemeio_account: cuenta });
      creada = true;
    }
    await enrichContact(phone, { tags, fields, email, name: nombre });
    if (Object.keys(utm).length) await dbUpdateContact(phone, utm).catch(() => { /* atribución best-effort */ });
    if (sourceUrl) await enrichContact(phone, { fields: { source_url: sourceUrl.slice(0, 500) } });
    if (cuenta) await dbUpdateContact(phone, { systemeio_account: cuenta }).catch(() => { /* idem */ });
    if (creada) {
      await addContactNote(phone, "Ficha creada desde tu web (registro por webhook)" + (sourceUrl ? " · " + sourceUrl.slice(0, 160) : ""), { kind: "system", author: "panel" }).catch(() => { /* nota best-effort */ });
      recordWebhook("systemeio", "➕ ficha nueva en el CRM: " + email + (cuenta ? " · cuenta " + cuenta : ""));
      // NOTIFICACIONES-1 · lead_nuevo desde la web
      avisarLeadNuevo(phone, { name: nombre || email, channel: "web", origen: "Se ha registrado en tu web" + (sourceUrl ? " (" + sourceUrl.replace(/^https?:\/\//, "").slice(0, 80) + ")" : "") + "." });
    } else {
      recordWebhook("systemeio", "♻️ ficha unificada (" + (phone.indexOf("email:") === 0 ? "email" : "ref") + "): …" + phone.slice(-6) + " ← " + email);
    }
  });
}

/** ¿El payload indica que el contacto tiene/recibió la etiqueta `tagName`? Defensivo:
 *  cubre el evento de asignación de etiqueta (tag.name) y una lista de tags del contacto,
 *  porque no fijamos la forma exacta del payload de systeme.io hasta verla en producción. */
function tagPresent(json: any, tagName: string): boolean {
  const want = tagName.trim().toLowerCase();
  if (!want) return false;
  const added = String(
    json?.tag?.name || json?.data?.tag?.name || json?.tagName || json?.data?.tagName || "",
  ).trim().toLowerCase();
  if (added && added === want) return true;
  const tags = json?.contact?.tags || json?.data?.contact?.tags || json?.tags || [];
  if (Array.isArray(tags)) {
    return tags.some((t: any) => String(t?.name || t?.tag || t || "").trim().toLowerCase() === want);
  }
  return false;
}

/** REGLA DE COMPRA (vía INSTANTÁNEA) · Cuando systeme.io avisa de una VENTA REALIZADA (o
 *  de que se asignó la etiqueta de compra), sacamos al comprador de sus flujos con regla.
 *  El teléfono NO viaja en el webhook, pero SÍ está en la ficha del comprador (phone_number,
 *  capturado en el checkout) → handlePurchaseByEmail cruza por email→teléfono. La
 *  reconciliación periódica es la garantía si este aviso no llega. */
async function correlateSioPurchase(json: any, event: string): Promise<void> {
  const stopTagName = get("systemeio.stopTag").trim(); // SIN-DEFAULTS-LM-1 (ver purchase-guard)
  const email = String(
    json?.contact?.email || json?.data?.contact?.email || json?.data?.email || json?.email || "",
  ).trim();
  // Señal de compra: evento de venta/pedido, o el payload trae la etiqueta de compra.
  // SIO-FIRMA-1 · SALE_CANCELED casaba con «sale»: una cancelación no es una compra.
  const isSale = !/cancel|refund|reembols/i.test(event) && /sale|order|venta|pedido|payment|pago|purchase|compra|inscri/i.test(event);
  const tagged = tagPresent(json, stopTagName);
  if (!(isSale || tagged)) return;
  // OJO: antes un `!email` cortaba aquí y la vía por token —que es justo la que NO
  // necesita email— nunca llegaba a evaluarse. Ahora basta con email O ref.
  const ref = extractRef(json);
  if (!email && !ref) return;
  await runWithWorkspace(currentWorkspaceId(), async () => {
    const { handlePurchaseByEmail, markPurchasedByPaymentRef } = await import("./purchase-guard.js"); // perezoso: sin ciclos en carga
    // VÍA TOKEN · el ref del enlace de pago personal de la closer (determinista).
    if (ref) {
      try {
        // El token es público: no autoriza a confirmar una compra de otro negocio.
        const payment = await resolvePaymentToken(ref);
        if (payment && payment.tenant_id !== currentWorkspaceId()) return;
        const ok = await markPurchasedByPaymentRef(ref, { email, tagInPayload: tagged, stopTag: stopTagName });
        if (ok) recordWebhook("systemeio", "🏆 compra por enlace de pago (…" + ref.slice(-4) + ") → cliente marcado");
      } catch (e) {
        recordWebhook("systemeio", "⚠️ vía token de pago: " + (e as Error).message);
      }
    }
    // VÍA EMAIL · corta flujos + marca cliente cruzando email→phone_number del checkout.
    if (email) {
      // Solo un evento de VENTA es una compra nueva; que el payload traiga la etiqueta de
      // compra (tagged) también lo dice cualquier aviso de un cliente antiguo.
      const n = await handlePurchaseByEmail(email, { reciente: isSale });
      if (n) recordWebhook("systemeio", "🛑 compra al instante (" + email.slice(0, 3) + "…) → " + n + " flujo(s) cortado(s)");
    }
  });
}

/** VENTAS-WEBHOOK-1 (SIO-API-F2) · Guarda SALE_NEW / SALE_CANCELED en la tabla sombra
 *  app_sio_webhook_sales, con el aviso entero. La forma del aviso no está verificada con una
 *  venta real: se leen varias rutas posibles y, si no hay id, no se guarda (se registra). */
export function ventaDesdeAviso(json: any, event: string): {
  sale_id: string; kind: "sale" | "canceled"; email: string; amount: number | null; currency: string; product: string; at: number | null;
} | null {
  const ev = String(event || "").toUpperCase();
  const kind = ev === "SALE_NEW" || ev === "NEW_SALE" ? "sale" : ev === "SALE_CANCELED" ? "canceled" : null;
  if (!kind) return null;
  const d = json?.data && typeof json.data === "object" ? json.data : json || {};
  const order = d.order || {};
  const item = d.orderItem || (Array.isArray(order.orderItems) ? order.orderItems[0] : null) || {};
  const plan = d.pricePlan || item.pricePlan || {};
  const id = item.id ?? order.id ?? d.id ?? d.saleId;
  if (id == null || id === "") return null;
  const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const t = Date.parse(String(d.createdAt || order.createdAt || item.createdAt || d.canceledAt || ""));
  return {
    sale_id: String(item.id != null ? "oi:" + item.id : order.id != null ? "o:" + order.id : "x:" + id),
    kind,
    email: String(d.customer?.email || d.contact?.email || json?.contact?.email || d.email || "").trim().toLowerCase(),
    amount: num(plan.amount ?? item.amount ?? order.amount),
    currency: String(plan.currency || order.currency || d.currency || "").toLowerCase(),
    product: String(plan.name || item.name || d.product?.name || ""),
    at: Number.isFinite(t) ? t : null,
  };
}
async function guardarVentaWebhook(json: any, event: string, accountId: string): Promise<void> {
  if (!/^(SALE_NEW|NEW_SALE|SALE_CANCELED)$/i.test(event)) return;
  const v = ventaDesdeAviso(json, event);
  if (!v) { recordWebhook("systemeio", "⚠️ aviso de venta sin id reconocible (" + event + "): no se guarda"); return; }
  const nueva = await dbSioWebhookSaleInsert({ account_id: accountId, ...v, payload: json });
  if (nueva) recordWebhook("systemeio", (v.kind === "sale" ? "💶 venta" : "↩️ cancelación") + " guardada por aviso · " + v.sale_id);
  // VENTAS-CORTE-1 (SIO-API-F8) · desde el corte el aviso es la fuente de las ventas que suman.
  // Va también con un reintento: si la primera vez falló esta copia, la segunda la completa.
  await dbSioSalesDesdeAviso(accountId, v.sale_id, v.kind);
}

/**
 * POST /webhook/systemeio — receptor. Guardado por clave compartida (?k= o header).
 * Nunca lanza hacia Fastify: cualquier error interno se traga y responde 200 igualmente
 * (systeme.io reintenta / desactiva webhooks que devuelven error, y aquí solo registramos).
 */
export async function handleSystemeioWebhook(req: unknown, reply: unknown): Promise<void> {
  const r = req as { query?: Record<string, string>; headers?: Record<string, unknown>; body?: { raw?: Buffer; json?: unknown } };
  const rep = reply as { code: (n: number) => { send: (b: unknown) => void } };
  try {
    const q = r.query || {};
    const key = get("systemeio.webhook.key");
    // Parseamos SIEMPRE (incluso si vamos a rechazar) para poder inspeccionar qué llega.
    const b = r.body || {};
    const json: any = b.json ?? b;
    const rawText = b.raw ? b.raw.toString("utf8") : safeStringify(json);
    // El nombre del evento viene en la CABECERA x-webhook-event (CONTACT_TAG_ADDED,
    // CONTACT_OPT_IN, …), no en el cuerpo. Fallback al cuerpo por si acaso.
    const event = String(
      (r.headers?.["x-webhook-event"] as string) || json?.type || json?.event || json?.eventType || json?.name || "(desconocido)",
    );
    const email = String(
      json?.contact?.email || json?.data?.contact?.email || json?.data?.email || json?.email || "",
    );
    // Cabeceras que importan: cómo viaja la "Clave secreta" que puso el dueño (firma/HMAC).
    // T09-SEC · las cabeceras PORTADORAS de secreto (x-webhook-key, firmas, HMAC) se
    // guardan como HUELLA (prefijo + longitud), nunca el valor: estos hits los sirve el
    // panel por /admin/api/systemeio-webhook-log y antes la clave válida viajaba entera
    // dentro de headers en cada respuesta JSON.
    const hdr: Record<string, string> = {};
    for (const k of Object.keys(r.headers || {})) {
      if (/signature|webhook|secret|hmac|systeme|content-type|user-agent/i.test(k)) {
        const v = String((r.headers as Record<string, unknown>)[k]).slice(0, 200);
        hdr[k] = /key|secret|signature|hmac|authorization/i.test(k)
          ? (v ? v.slice(0, 6) + "…(" + v.length + ")" : "")
          : v;
      }
    }
    const provided = String((r.headers?.["x-webhook-key"] as string) || q.k || "");
    // Huella de la clave recibida (sin exponer secretos): prefijo + longitud. Sirve para
    // diagnosticar un desajuste de clave sin que un rechazo sea invisible.
    const kp = provided ? provided.slice(0, 10) + "…(" + provided.length + ")" : "(sin clave)";
    // SIO-FIRMA-1 · un aviso con firma válida vale aunque no traiga ?k=.
    const secret = get("systemeio.webhook.secret");
    const firma = String((r.headers?.["x-webhook-signature"] as string) || "");
    const firmado = !!firma && sioFirmaValida(firma, rawText, json, [secret, key]);
    if (!key && !firmado) {
      pushHit({ at: Date.now(), event: "⚠️ sin clave configurada · " + event, email: "", bodyText: "Evento sin autenticar; contenido omitido.", headers: hdr });
      rep.code(503).send({ error: "systemeio.webhook.key no configurado" });
      return;
    }
    if (!firmado && !timingSafeEq(provided, key)) {
      // REGISTRAMOS el rechazo (antes era invisible → parecía que systeme.io no llamaba).
      pushHit({ at: Date.now(), event: "⛔ RECHAZADO (clave incorrecta) · " + event, email: "", bodyText: "clave recibida: " + kp, headers: hdr });
      recordWebhook("systemeio", "⛔ webhook systeme.io RECHAZADO (clave incorrecta) · recibida=" + kp);
      rep.code(401).send({ error: "clave inválida" });
      return;
    }
    rep.code(200).send({ ok: true });
    // SIO-TENANT-1 · El destino se resuelve antes de tocar el CRM, registros,
    // compras o automatizaciones. La clave global autentica al emisor, no el
    // workspace: usar siempre 'default' importaba datos de todos sus clientes.
    const sourceUrl = String(json?.contact?.sourceURL || json?.data?.contact?.sourceURL || json?.sourceURL || "");
    let host = "";
    try { host = sourceUrl ? new URL(sourceUrl).hostname : ""; } catch { /* origen no válido */ }
    const resolved = await resolveEmailEventAccount(q.acc, host);
    if (!resolved) {
      pushHit({ at: Date.now(), event, email: "", bodyText: "Evento recibido sin una cuenta activa inequívoca; contenido omitido.", headers: hdr });
      recordWebhook("systemeio", "⚠️ Evento recibido sin una cuenta activa inequívoca: no se modifica ningún negocio.");
      return;
    }
    pushHit({ tenant_id: resolved.wsId, at: Date.now(), event, email, bodyText: rawText.slice(0, 4000), headers: hdr });
    recordWebhook("systemeio", "📥 webhook systeme.io · evento=" + event);
    await runWithWorkspace(resolved.wsId, async () => {
    // TIMBRE DE RESERVAS · systeme.io no avisa de reservas, pero quien reserva
    // se convierte en contacto y eso dispara ESTE webhook: se adelanta el sync
    // de reservas (debounced en sio-bookings) en vez de esperar al tick de 10m.
    sioBookingsPokeSoon();
    // CORRELACIÓN-1 · Si el evento trae el token `ref` (que el flujo mete en el enlace de
    // registro con {{phone}}), marcamos a ESE contacto como registrado → el paso del flujo
    // "¿tiene etiqueta sio-registrado?" le salta el recordatorio. Fire-and-forget: no
    // retrasa el 200 ni tumba el webhook.
    void correlateSioRegistration(json).catch((e) => {
      try { recordWebhook("systemeio", "⚠️ correlación registro: " + (e as Error).message); } catch { /* noop */ }
    });
    // ALTA UNIFICADA · el contacto del evento acaba en el CRM con toda su info
    // (fusiona por ref/email; crea ficha si no existía). Fire-and-forget.
    void importSioContact(json, resolved.account.id).catch((e) => {
      try { recordWebhook("systemeio", "⚠️ alta unificada: " + (e as Error).message); } catch { /* noop */ }
    });
    // REGLA DE COMPRA · si es una venta / etiqueta de compra, saca al comprador de sus flujos.
    void correlateSioPurchase(json, event).catch((e) => {
      try { recordWebhook("systemeio", "⚠️ correlación compra: " + (e as Error).message); } catch { /* noop */ }
    });
    // VENTAS-WEBHOOK-1 · la venta o la cancelación, a la tabla sombra (paridad antes del corte).
    void guardarVentaWebhook(json, event, resolved.account.id).catch((e) => {
      try { recordWebhook("systemeio", "⚠️ guardar venta: " + (e as Error).message); } catch { /* noop */ }
    });
    // T03-CORREOS · Si es una ASIGNACIÓN de etiqueta (la etiqueta puente de un
    // flujo de Correos), se ingiere como evento individual de correo: resolución
    // DETERMINISTA de cuenta/workspace (?acc=… o host de la sourceURL — jamás
    // 'default' a ciegas), dedupe semántico y disparo de flujos. Fire-and-forget.
    void handleSioWebhookForEmailEvents(json, (r.headers || {}) as Record<string, unknown>, q, rawText).catch((e) => {
      try { recordWebhook("systemeio", "⚠️ evento de correo: " + (e as Error).message); } catch { /* noop */ }
    });
    });
  } catch (e) {
    try {
      recordWebhook("systemeio", "⚠️ error procesando webhook systeme.io: " + (e as Error).message);
    } catch {
      /* noop */
    }
    rep.code(200).send({ ok: true });
  }
}
