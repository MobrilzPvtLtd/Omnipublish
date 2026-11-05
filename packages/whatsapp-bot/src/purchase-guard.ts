/**
 * REGLA DE COMPRA · Saca del flujo a quien YA compró.
 *
 * PROBLEMA: la compra ocurre en systeme.io (identificada por email + etiqueta "INSCRITO LM")
 * y el flujo corre en WhatsApp (identificado por teléfono). systeme.io NO manda el teléfono
 * en el webhook, PERO sí lo guarda en el contacto (campo phone_number, capturado en el
 * checkout de pago) — verificado con compradores reales. Y ese teléfono viene en el MISMO
 * formato que los contactos de WhatsApp (dígitos con código de país). → cruzamos por teléfono.
 *
 * DOS VÍAS que alimentan la misma acción (marcar en local + cancelar el run):
 *   - PUSH (instantáneo): el webhook "venta realizada"/etiqueta → handlePurchaseByEmail(email)
 *     → findContactByEmail → phone_number → cancelar.
 *   - PULL (garantía): cada pocos minutos listamos los contactos con la etiqueta de compra
 *     (con su phone_number) y cancelamos los que aún tengan un run activo. No depende de que
 *     el webhook llegue ni de la forma del payload.
 *
 * El guard de run() (flows.ts) comprueba la marca LOCAL antes de CADA paso → aunque el corte
 * llegue un momento tarde, ningún paso posterior se dispara para quien ya compró.
 */
import { listAccountsRaw, type SiAccount } from "./systemeio-accounts.js";
import { withPublicApiKey, listContactsWithTagAndPhone, buyerInfoByEmail } from "./systemeio-public-api.js";
import { getContact, enrichContact, addContactNote } from "./contacts.js";
import { dbHasActiveFlowRun, dbCancelFlowRunsForPhone, dbSaveFlowRun, dbFlowEventAdd, dbUpdateContact, type FlowRun } from "./db.js";
import { runWithWorkspace, currentWorkspaceId } from "./workspace.js";
import { recordWebhook } from "./webhookDebug.js";
import { avisarContacto } from "./notifications.js";
import { get as getSetting } from "./settings.js";
import { pipelineDeContacto } from "./pipelines.js";

const normPhone = (p: string): string => String(p || "").replace(/[^\d]/g, "");

/** Etiqueta de compra del producto (la que systeme.io asigna al comprar).
 *  SIN-DEFAULTS-LM-1 · Sin valor de fábrica: "INSCRITO LM" es la etiqueta del curso
 *  LeadMatch y en la instancia de un cliente no significa nada. Peor: haría que el
 *  guard buscara una etiqueta ajena y, si el cliente la usara por casualidad con otro
 *  sentido, cortaría flujos por una compra que no existe. Cadena vacía = el guard
 *  global no actúa; las reglas de compra por flujo (stopTag propio) siguen igual.
 *  La etiqueta se configura en el ajuste `systemeio.stopTag`, que se añadió al
 *  catálogo del panel junto con este cambio: antes la clave se leía pero no la
 *  escribía nadie (ni panel, ni entorno), así que sin el valor de fábrica el guard
 *  habría quedado muerto sin forma de reactivarlo. La instancia central tiene que
 *  fijarlo a «INSCRITO LM» ANTES de desplegar esto. */
const globalStopTag = (): string => getSetting("systemeio.stopTag").trim();

/** Flujos ACTIVOS con regla de compra (stopTag). Import perezoso: evita cualquier ciclo
 *  flows↔purchase-guard en la carga del módulo. */
async function flowsWithStopTag(): Promise<Array<{ id: string; name: string; stopTag: string; stopTagAccount?: string }>> {
  const { listFlows } = await import("./flows.js");
  return (await listFlows())
    .filter((f) => f.enabled && String(f.stopTag || "").trim())
    .map((f) => ({ id: f.id, name: f.name, stopTag: String(f.stopTag).trim(), stopTagAccount: (f as { stopTagAccount?: string }).stopTagAccount }));
}

const _tagAccountCache = new Map<string, { id: string; at: number }>();
/** Cuenta de systeme.io con API key para leer la etiqueta. 1) la configurada en el flujo;
 *  2) si no y hay varias cuentas, la que REALMENTE tiene esa etiqueta (auto-detección,
 *  cache 5 min) → así en otros flujos basta activar la regla sin elegir cuenta;
 *  3) fallback: la primera con key. */
async function resolveBuyerAccount(stopTagAccount?: string, tagName?: string): Promise<SiAccount | null> {
  const accs = await listAccountsRaw();
  if (stopTagAccount) {
    // REVISION-COMPRA-1 · Una cuenta elegida y luego desconectada no autoriza
    // comprobar compras en otra web que casualmente tenga la misma etiqueta.
    return accs.find((x) => x.id === stopTagAccount && x.apiKey) || null;
  }
  const withKey = accs.filter((x) => x.apiKey);
  if (withKey.length <= 1) return withKey[0] || null;
  const want = String(tagName || "").trim().toLowerCase();
  if (want) {
    // REVISION-COMPRA-1 · La misma etiqueta puede existir en muchos negocios.
    // Cachear solo por nombre impedía detectar compras en el segundo workspace.
    const cacheKey = currentWorkspaceId() + ":" + want;
    const c = _tagAccountCache.get(cacheKey);
    const cachedAccount = c && withKey.find((x) => x.id === c.id);
    if (c && cachedAccount && Date.now() - c.at < 5 * 60_000) return cachedAccount;
    _tagAccountCache.delete(cacheKey);
    const { listTags } = await import("./systemeio-public-api.js");
    for (const a of withKey) {
      try {
        const has = await withPublicApiKey(a.apiKey!, async () => (await listTags()).some((t) => String(t.name || "").trim().toLowerCase() === want));
        if (has) { _tagAccountCache.set(cacheKey, { id: a.id, at: Date.now() }); return a; }
      } catch { /* prueba la siguiente cuenta */ }
    }
  }
  return withKey[0] || null;
}

/** Marca al contacto como comprador (para el guard) y cancela su run en ese flujo. */
async function stopContactInFlow(phone: string, tagName: string, flowId: string, flowName: string): Promise<boolean> {
  if (!(await dbHasActiveFlowRun(phone, flowId))) return false;
  try { await enrichContact(phone, { tags: [tagName] }); } catch { /* la marca local es best-effort */ }
  await dbCancelFlowRunsForPhone(phone, flowId);
  void dbFlowEventAdd(flowId, phone, "salió · compró", "", "compra detectada en la web («" + tagName + "») → fuera del flujo");
  try { recordWebhook("systemeio", "🛑 compra: …" + phone.slice(-4) + " sacado del flujo \"" + flowName + "\""); } catch { /* noop */ }
  return true;
}

// ============================================================================
// MARCA DE CLIENTE · markPurchased es el ÚNICO sitio que convierte "compró" en
// estado del panel: etapa ganada + etiquetas (compra-<divisa> y la de producto)
// + purchased_at + nota en la ficha + corte de flujos. Lo llaman las TRES vías
// (webhook por token, webhook por email y la reconciliación PULL) y es
// IDEMPOTENTE por purchased_at: la primera marca gana; reintentos, eventos
// duplicados o formularios posteriores no pisan nada — tampoco una decisión
// humana posterior (p.ej. reembolso → la closer lo mueve a Perdido a mano y
// ahí se queda).
// ============================================================================
const STAGE_TAG_PREFIX = "📍 ";
/** DESENLACES-1 (PIP-03) · la etapa «ganada» del pipeline EN EL QUE ESTÁ el contacto. Antes
 *  se buscaba por nombre en todos los pipelines y se cogía la primera que sonase a ganado:
 *  un comprador del pipeline B acababa con la etapa ganada del A, que en el B no existe, y
 *  desaparecía de los dos tableros. Ahora cada pipeline dice cuál es su desenlace ganado. */
function wonStageName(fields: Record<string, unknown> | null | undefined): string {
  try { return pipelineDeContacto(fields).won || "Ganado"; } catch { return "Ganado"; }
}

/** Las llamadas con la misma clave se ejecutan de una en una, en orden de llegada. */
const colas = new Map<string, Promise<unknown>>();
export function enCola<T>(clave: string, fn: () => Promise<T>): Promise<T> {
  const previa = colas.get(clave) || Promise.resolve();
  const esta = previa.catch(() => undefined).then(fn);
  const hueco = esta.catch(() => undefined);
  colas.set(clave, hueco);
  void hueco.then(() => { if (colas.get(clave) === hueco) colas.delete(clave); });
  return esta;
}

// COMPRA-UNA-VEZ-1 · systeme.io manda la venta y la etiqueta de compra casi a la vez, y la
// reconciliación puede coincidir con ellas: sin cola, dos llamadas leían purchased_at vacío y
// las dos anotaban «✔ Compró» y cortaban flujos. Clave propia («marca|»): el aviso de ventas
// ya llama aquí desde SU cola por contacto, y compartir la clave lo dejaría esperándose a sí mismo.
export function markPurchased(phone: string, opts: { currency?: string; via: string; reciente?: boolean }): Promise<boolean> {
  return enCola("marca|" + currentWorkspaceId() + "|" + phone, () => marcarCompra(phone, opts));
}
async function marcarCompra(phone: string, opts: { currency?: string; via: string; reciente?: boolean }): Promise<boolean> {
  const c = await getContact(phone);
  if (!c) return false; // sin ficha en el panel no hay a quién marcar (la venta sigue en systeme.io)
  const fields = (c.fields || {}) as Record<string, string>;
  if (String(fields.purchased_at || "").trim()) {
    // VENTA-WEBHOOK-1 · ya era cliente y esto es una venta NUEVA en vivo (no la pasada de
    // la reconciliación, que repite cada 3 min): se anota la hora para que «¿Ha comprado?
    // …tras el último enlace» la vea. Lo demás no se repisa.
    if (opts.reciente) await dbUpdateContact(phone, { fields: { ...fields, last_purchase_at: new Date().toISOString() } });
    return false;
  }
  const stage = wonStageName(fields);
  const keep = (c.tags || []).filter((t) => !String(t).startsWith(STAGE_TAG_PREFIX));
  const tags = [...keep, STAGE_TAG_PREFIX + stage];
  const cur = String(opts.currency || "").toLowerCase().replace(/[^a-z]/g, "");
  if (cur && !tags.some((t) => t.toLowerCase() === "compra-" + cur)) tags.push("compra-" + cur);
  // La etiqueta de producto también en local: el guard de los flujos (stopTag) y las
  // audiencias de difusión la leen de aquí.
  const stop = globalStopTag();
  if (stop && !tags.some((t) => t.toLowerCase() === stop.toLowerCase())) tags.push(stop);
  await dbUpdateContact(phone, {
    stage,
    tags,
    fields: { ...fields, purchased_at: new Date().toISOString(), purchase_via: opts.via },
  });
  // Corta sus runs en los flujos con regla de compra (mismo corte que PUSH/PULL).
  try {
    for (const f of await flowsWithStopTag()) await stopContactInFlow(phone, f.stopTag, f.id, f.name);
  } catch { /* best-effort */ }
  try {
    await addContactNote(phone, "✔ Compró" + (cur ? " (" + cur.toUpperCase() + ")" : "") + " · detectado por " + opts.via, { kind: "compra", author: "sistema" });
  } catch { /* la nota es cosmética */ }
  try { recordWebhook("systemeio", "🏆 cliente: …" + phone.slice(-4) + " marcado como comprador (" + opts.via + ")"); } catch { /* noop */ }
  // NOTIFICACIONES-1 · pago (una sola vez por contacto: purchased_at corta arriba)
  avisarContacto("pago", phone, (nm) => ({ title: nm + " ha comprado", body: "Compra detectada" + (cur ? " en " + cur.toUpperCase() : "") + ". Ya está en la etapa «" + stage + "» y sus flujos de venta se han parado." }), { name: c.name, channel: "web", dedup: "pago:" + phone });
  return true;
}

/**
 * VÍA TOKEN · El `ref` del webhook puede ser el token del enlace de pago personal
 * que generó la closer. Es la vía DETERMINISTA (no depende del email ni del
 * formato del teléfono del checkout). Con dos guardas:
 *  - FILTRO DE PRODUCTO: el sourceURL con ?ref= es eterno — si ese contacto compra
 *    OTRO producto meses después, el mismo ref reaparecería. Solo se marca si la
 *    compra trae la etiqueta del producto (payload o ficha del comprador en sio).
 *  - ENLACE REENVIADO: si quien pagó (phone_number del checkout) es OTRO contacto
 *    del panel, gana el comprador real; si no existe como contacto, se atribuye al
 *    dueño del enlace (ese es justo el caso "compró con otro número").
 */
export async function markPurchasedByPaymentRef(
  ref: string,
  opts: { email?: string; tagInPayload?: boolean; stopTag?: string },
): Promise<boolean> {
  const { resolvePaymentToken } = await import("./links.js");
  const row = await resolvePaymentToken(ref);
  if (!row) return false; // no es un token de pago (p.ej. ref=teléfono de un registro) → nada
  const hay = (row.label + " " + row.url).toLowerCase();
  const currency = /usd|dolar|dólar|\$/.test(hay) ? "usd" : /eur|€/.test(hay) ? "eur" : "";
  const tagName = (opts.stopTag || globalStopTag()).trim();
  let confirmed = opts.tagInPayload === true;
  let buyerPhone = "";
  const mail = String(opts.email || "").trim().toLowerCase();
  // SIN-DEFAULTS-LM-1 · sin etiqueta de compra configurada no se consulta por
  // etiqueta: preguntar por la cadena vacía podría dar hasTag=true si systeme.io
  // devolviera una etiqueta sin nombre, y marcaríamos comprador a quien no lo es.
  // Sin ella, la confirmación llega por el payload (tagInPayload) o por la
  // reconciliación, exactamente como cuando la etiqueta no coincide.
  if (mail && tagName) {
    const acc = await resolveBuyerAccount(undefined, tagName);
    if (acc?.apiKey) {
      try {
        const info = await withPublicApiKey(acc.apiKey, () => buyerInfoByEmail(mail, tagName));
        if (info) { confirmed = confirmed || info.hasTag; buyerPhone = normPhone(info.phone); }
      } catch { /* la confirmación cae a la reconciliación */ }
    }
  }
  if (!confirmed) {
    try { recordWebhook("systemeio", "🤔 venta con token …" + ref.slice(-4) + " sin confirmar el producto → lo marcará la reconciliación"); } catch { /* noop */ }
    return false; // el PULL (cada 3 min, lista por etiqueta) es la garantía
  }
  return runWithWorkspace(row.tenant_id || "default", async () => {
    let phone = String(row.phone || "");
    if (buyerPhone && buyerPhone !== normPhone(phone)) {
      const real = await getContact(buyerPhone);
      if (real) phone = buyerPhone;
    }
    if (!phone) return false;
    // PAGO-2 · La venta se registra SIEMPRE, aunque markPurchased la descarte por
    // ser la segunda compra de este contacto: esa marca es un campo binario en la
    // ficha, y aquí lo que queremos es el histórico real por producto. Sin esta
    // fila, «compras» e «ingresos» del panel no podrían existir.
    try {
      const { registrarCompra } = await import("./links.js");
      await registrarCompra({
        tenant_id: row.tenant_id || "default",
        phone,
        product_id: row.product_id || "",
        token: ref,
        currency,
        via: "enlace de pago",
        external_id: ref,
      });
    } catch { /* la marca del contacto no depende de esto */ }
    return markPurchased(phone, { currency, via: "enlace de pago", reciente: true });
  });
}

/**
 * PUSH · Un email acaba de comprar (webhook). Para cada flujo con regla, resuelve el
 * teléfono del comprador en systeme.io (phone_number) y lo saca del flujo. Best-effort.
 */
export async function handlePurchaseByEmail(email: string, opts: { reciente?: boolean } = {}): Promise<number> {
  const mail = String(email || "").trim().toLowerCase();
  if (!mail) return 0;
  // MARCA DE CLIENTE independiente de flujos: aunque no haya ningún flujo con regla
  // ni run activo (cierre en frío de la closer, campaña pausada), el comprador debe
  // quedar como cliente en el panel. Antes esta vía SOLO cortaba runs activos y el
  // comprador sin run jamás aparecía como cliente.
  try {
    const tag = globalStopTag();
    // SIN-DEFAULTS-LM-1 · sin etiqueta configurada, esta vía no aplica (ver arriba).
    const acc0 = tag ? await resolveBuyerAccount(undefined, tag) : null;
    if (tag && acc0?.apiKey) {
      const info0 = await withPublicApiKey(acc0.apiKey, () => buyerInfoByEmail(mail, tag));
      if (info0?.hasTag) {
        const p0 = normPhone(info0.phone);
        if (p0) await markPurchased(p0, { via: "webhook (email)", reciente: opts.reciente === true });
      }
    }
  } catch { /* la reconciliación lo repesca */ }
  const flows = await flowsWithStopTag();
  if (!flows.length) return 0;
  let cancelled = 0;
  for (const flow of flows) {
    const acc = await resolveBuyerAccount(flow.stopTagAccount, flow.stopTag);
    if (!acc?.apiKey) continue;
    // Verifica que ESE email tiene la etiqueta de compra Y saca su teléfono (una llamada).
    let info: Awaited<ReturnType<typeof buyerInfoByEmail>> | null = null;
    try { info = await withPublicApiKey(acc.apiKey, () => buyerInfoByEmail(mail, flow.stopTag)); } catch { info = null; }
    if (!info?.hasTag) continue; // no es comprador de ESTE producto → no tocar
    const phone = normPhone(info.phone);
    if (!phone) continue; // comprador sin teléfono (raro): lo cogerá la reconciliación si aparece
    if (await stopContactInFlow(phone, flow.stopTag, flow.id, flow.name)) cancelled++;
  }
  return cancelled;
}

/**
 * PULL · Reconciliación: por cada flujo con regla, lista los compradores (etiqueta) con su
 * teléfono y saca del flujo a los que aún tengan un run activo. Es la GARANTÍA (no depende
 * del webhook). Idempotente: quien ya no tiene run activo se salta.
 */
export async function reconcilePurchasesOnce(): Promise<{ flows: number; buyers: number; cancelled: number; errors: string[] }> {
  const res = { flows: 0, buyers: 0, cancelled: 0, errors: [] as string[] };
  const flows = await flowsWithStopTag();
  if (!flows.length) return res;
  // Agrupa por (cuenta, etiqueta) para pedir la lista de compradores UNA vez.
  const byPull = new Map<string, { acc: SiAccount; tag: string; flows: typeof flows }>();
  for (const flow of flows) {
    const acc = await resolveBuyerAccount(flow.stopTagAccount, flow.stopTag);
    if (!acc?.apiKey) { res.errors.push("sin cuenta para \"" + flow.name + "\""); continue; }
    const k = acc.id + "|" + flow.stopTag.toLowerCase();
    const g = byPull.get(k);
    if (g) g.flows.push(flow);
    else byPull.set(k, { acc, tag: flow.stopTag, flows: [flow] });
  }
  for (const { acc, tag, flows: fs } of byPull.values()) {
    let buyers: Awaited<ReturnType<typeof listContactsWithTagAndPhone>> = [];
    try { buyers = await withPublicApiKey(acc.apiKey!, () => listContactsWithTagAndPhone(tag)); }
    catch (e) { res.errors.push("pull " + tag + ": " + (e as Error).message); continue; }
    res.buyers += buyers.length;
    const esProducto = tag.trim().toLowerCase() === globalStopTag().toLowerCase();
    for (const bmy of buyers) {
      const phone = normPhone(bmy.phone);
      if (!phone) continue;
      // GARANTÍA DE MARCADO · la lista viene DE la etiqueta de compra → todos son
      // compradores del producto. Si el webhook se perdió (deploy, caída justo tras
      // el 200), aquí quedan marcados igual. Idempotente por purchased_at.
      if (esProducto) {
        try { await markPurchased(phone, { via: "reconciliación" }); } catch { /* siguiente */ }
      }
      for (const flow of fs) { res.flows++; if (await stopContactInFlow(phone, flow.stopTag, flow.id, flow.name)) res.cancelled++; }
    }
  }
  return res;
}

/**
 * AUTO-PRUEBA end-to-end SIN dinero ni mensajes. Usa un comprador REAL de otra etiqueta
 * (que ya tiene teléfono en systeme.io), le crea un run de prueba en un flujo desechable
 * con la regla, corre la reconciliación REAL y comprueba que lo SACA del flujo. Luego limpia.
 * Prueba exactamente la cadena que se usará con INSCRITO LM: comprador real → teléfono →
 * match con el run → cancelación. Best-effort de limpieza.
 */
export async function purchaseGuardSelfTest(tagName: string, accountId?: string): Promise<Record<string, unknown>> {
  const rep: Record<string, unknown> = { tag: tagName };
  const acc = await resolveBuyerAccount(accountId, tagName);
  if (!acc?.apiKey) { rep.error = "no hay cuenta la web con API key"; return rep; }
  // 1) Un comprador REAL con teléfono.
  let buyers: Awaited<ReturnType<typeof listContactsWithTagAndPhone>> = [];
  try { buyers = await withPublicApiKey(acc.apiKey, () => listContactsWithTagAndPhone(tagName, 3)); }
  catch (e) { rep.error = "pull falló: " + (e as Error).message; return rep; }
  rep.buyersFound = buyers.length;
  const buyer = buyers.find((x) => normPhone(x.phone));
  if (!buyer) { rep.error = "ningún comprador con teléfono para la etiqueta \"" + tagName + "\""; return rep; }
  const phone = normPhone(buyer.phone);
  rep.testPhone = phone.slice(0, 4) + "…" + phone.slice(-2);
  rep.phoneExtracted = true;
  rep.matchesWaContact = !!(await getContact(phone)); // ¿ese teléfono es un contacto de WhatsApp? (informativo)
  // 2) Flujo desechable con la regla + 3) run activo de prueba para ese teléfono.
  const testFlowId = "pgselftest-" + phone;
  const { saveFlow, removeFlow } = await import("./flows.js");
  try {
    await saveFlow({
      id: testFlowId, name: "__selftest regla de compra__", enabled: true,
      trigger: { type: "wa_keyword", keyword: "__pg_selftest_no_dispara__" },
      stopTag: tagName, stopTagAccount: acc.id, start: "n1",
      nodes: { n1: { type: "message", text: "selftest", next: "" } },
    } as unknown as Parameters<typeof saveFlow>[0]);
    const run: FlowRun = { phone, flow_id: testFlowId, node_id: "n1", vars: {}, status: "waiting", next_run: Date.now() };
    await dbSaveFlowRun(run);
    rep.runCreado = await dbHasActiveFlowRun(phone, testFlowId);
    // 4) Reconciliación REAL.
    const rec = await reconcilePurchasesOnce();
    rep.reconcile = rec;
    // 5) ¿Se sacó del flujo?
    rep.runSigueActivo = await dbHasActiveFlowRun(phone, testFlowId);
    rep.PASS = rep.runCreado === true && rep.runSigueActivo === false;
  } finally {
    // 6) Limpieza: cancelar cualquier resto + borrar el flujo de prueba.
    try { await dbCancelFlowRunsForPhone(phone, testFlowId); } catch { /* noop */ }
    try { await removeFlow(testFlowId); } catch { /* noop */ }
  }
  return rep;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Scheduler: reconcilia compras cada 3 min (garantía de corte del flujo al comprar). */
export function startPurchaseReconcileScheduler(): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    try {
      const r = await runWithWorkspace("default", () => reconcilePurchasesOnce());
      if (r.cancelled) recordWebhook("systemeio", "🛡️ reconciliación compras: " + r.cancelled + " sacado(s) del flujo");
    } catch (e) {
      console.warn("[purchase-reconcile] tick:", (e as Error).message);
    }
  };
  timer = setInterval(() => { void tick(); }, 3 * 60_000);
  timer.unref?.();
  const first = setTimeout(() => { void tick(); }, 100_000); // primera pasada tras el boot
  (first as { unref?: () => void }).unref?.();
}
