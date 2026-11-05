/**
 * T03-CORREOS · Ingesta de EVENTOS individuales de correo desde las cuentas
 * web conectadas (systeme.io / leadmatch-lab).
 *
 * El proveedor NO expone webhooks de apertura/clic/rebote/baja (verificado
 * contra developer.systeme.io 2026: solo CONTACT_* y SALE_*). La única señal
 * INDIVIDUAL real es la ETIQUETA PUENTE: el dueño crea en su web la regla
 * «email abierto/clic → asignar etiqueta» y aquí esa asignación llega por DOS
 * vías que se deduplican entre sí con la MISMA clave semántica:
 *
 *   1) PUSH  · webhook CONTACT_TAG_ADDED (instantáneo) — systemeio-webhook.ts
 *              nos lo pasa tras validar la clave compartida.
 *   2) PULL  · reconciliación por API pública (contactos con la etiqueta),
 *              red de seguridad si el webhook no llegó. Acotada: solo cuentas
 *              y etiquetas que algún flujo ACTIVO referencia, pocas páginas.
 *
 * Clave de dedupe: `tag:<etiqueta>:<email>` bajo (workspace, cuenta) — igual
 * por ambas vías, así webhook repetido, webhook+poll, reinicios o dos workers
 * concurrentes no reprocesan (el claim es un INSERT ON CONFLICT en
 * app_email_events; ver db.ts).
 *
 * RESOLUCIÓN DE CUENTA — determinista o nada: el webhook debe llegar con
 * `?acc=<accountId>` (la URL que enseña el editor de Flujos) o traer una
 * sourceURL cuyo host case EXACTAMENTE con UNA cuenta conectada. Cero
 * coincidencias o más de una → el evento se descarta con rastro. JAMÁS se cae
 * al workspace 'default' ni a «la primera cuenta».
 */
import crypto from "node:crypto";
import { runWithWorkspace, listWorkspacesForRoutingCached, DEFAULT_WORKSPACE_ID } from "./workspace.js";
import { listAccountsRaw, type SiAccount } from "./systemeio-accounts.js";
import { listFlows, triggerEmailFlows, emailFlowMatches } from "./flows.js";
import { dbClaimEmailEvent, dbFinishEmailEvent, dbClaimOnce } from "./db.js";
import { withPublicApiKey, listContactsWithTagAndPhone } from "./systemeio-public-api.js";
import { getEmailCatalogOrStatus } from "./email-catalog.js";
import { logActivity } from "./activity.js";
import { recordWebhook } from "./webhookDebug.js";
import { get as getSetting } from "./settings.js";

function normTag(s: string): string {
  return String(s || "").trim().toLowerCase();
}
function normEmail(s: string): string {
  return String(s || "").trim().toLowerCase();
}

/** Clave de idempotencia SEMÁNTICA del evento (idéntica por webhook y por poll).
 *  El message-id del webhook NO sirve de clave: el poll no lo tiene y systeme.io
 *  genera uno nuevo por reintento — se guarda solo como rastro. */
export function emailEventDedupeKey(tag: string, contactEmail: string): string {
  return `tag:${normTag(tag)}:${normEmail(contactEmail)}`;
}

export interface ResolvedAccount {
  wsId: string;
  account: SiAccount;
}

/**
 * Resuelve (workspace, cuenta) para un evento entrante. Determinista:
 *   - con `accId`: la cuenta con ese id, buscada en TODOS los workspaces;
 *   - sin él: la cuenta cuyo panelBaseUrl case con `host` (de la sourceURL);
 *   - y si eso no desambigua, SIO-TENANT-2: cuando en TODO el censo hay una
 *     sola cuenta conectada, esa es la única resolución posible.
 * Exactamente UNA coincidencia o null — nunca un fallback a 'default' a ciegas.
 *
 * SIO-TENANT-2 · por qué existe el tercer criterio. Los dos primeros no cubren
 * una instalación normal, así que la guardarraíl dejaba fuera a TODOS los
 * eventos de un cliente de un solo negocio:
 *   a) la URL que el panel entrega en Conexiones es
 *      `https://<host>/webhook/systemeio?k=<clave>` (admin.ts, `_sioWebhookUrl`):
 *      NO lleva `acc`, así que `accId` viene vacío en el alta guiada;
 *   b) sin `acc` se compara el hostname de la `sourceURL` del contacto (el
 *      embudo donde se registró, p. ej. `www.suempresa.com`) contra
 *      `panelBaseUrl`, que es la URL del PANEL de su web y cae por defecto a
 *      `https://leadmatch-lab.ingenierobinario.com` si no la escribe: no casan.
 *   c) y hay altas creadas por nuestro propio bot por API que ni siquiera traen
 *      `sourceURL`, con lo que no había ni host que comparar.
 * Sin este tercer criterio el comprador no se marcaba como cliente ni salía de
 * sus flujos: seguía recibiendo la secuencia de venta DESPUÉS de haber pagado.
 * El criterio sigue siendo determinista por construcción — sólo dispara cuando
 * no existe una segunda cuenta que pudiera reclamar el evento. Con dos o más,
 * se descarta como hasta ahora.
 */
export async function resolveEmailEventAccount(accId?: string, host?: string): Promise<ResolvedAccount | null> {
  const wanted = String(accId || "").trim();
  const wantHost = String(host || "").trim().toLowerCase();
  const matches: ResolvedAccount[] = [];
  /** SIO-TENANT-2 · censo completo de cuentas activas, para el desempate final. */
  const todas: ResolvedAccount[] = [];
  let wss: Array<{ id: string; archived?: boolean }> = [];
  try {
    wss = await listWorkspacesForRoutingCached();
  } catch {
    return null; // Sin censo no se puede excluir que otra cuenta reclame el evento.
  }
  if (!wss.length) return null;
  for (const ws of wss) {
    try {
      await runWithWorkspace(ws.id, async () => {
        for (const a of await listAccountsRaw()) {
          todas.push({ wsId: ws.id, account: a });
          if (wanted) {
            if (a.id === wanted) matches.push({ wsId: ws.id, account: a });
          } else if (wantHost) {
            try {
              if (new URL(a.panelBaseUrl).hostname.toLowerCase() === wantHost) matches.push({ wsId: ws.id, account: a });
            } catch { /* panelBaseUrl raro */ }
          }
        }
      });
    } catch { /* un workspace roto no tumba la resolución del resto */ }
  }
  // SIO-TENANT-1 · Un archivado sigue en el censo para detectar ambigüedad,
  // pero nunca recibe eventos ni vuelve a activar sus automatizaciones.
  const vivo = (m: ResolvedAccount): boolean => !wss.find((w) => w.id === m.wsId)?.archived;
  if (matches.length === 1 && vivo(matches[0])) return matches[0];
  // SIO-TENANT-2 · sin desempate por acc ni por dominio: sólo se acepta cuando
  // no hay NINGUNA otra cuenta en todo el censo que pudiera reclamar el evento.
  // Si vino un `acc` explícito y no casó, es una configuración equivocada: se
  // descarta igualmente en vez de escribir en el negocio que no toca.
  if (!wanted && todas.length === 1 && vivo(todas[0])) return todas[0];
  return null;
}

/**
 * Ingesta UNA ocurrencia «la web asignó la etiqueta X al contacto Y» ya
 * resuelta a (workspace, cuenta). Reclama el evento (dedupe), dispara los
 * flujos que casen y deja rastro saneado en el Centro de actividad.
 */
export async function ingestEmailTagEvent(
  resolved: ResolvedAccount,
  evt: { tag: string; contactEmail: string; occurredAt?: number | null; source: "webhook" | "poll" },
): Promise<{ claimed: boolean; started: number }> {
  const tag = String(evt.tag || "").trim().slice(0, 120);
  const email = normEmail(evt.contactEmail);
  if (!tag || !email || email.indexOf("@") < 0) return { claimed: false, started: 0 };
  return runWithWorkspace(resolved.wsId, async () => {
    // PREFILTRO · solo persistimos etiquetas que algún flujo ACTIVO referencia:
    // cada CONTACT_TAG_ADDED de una etiqueta ajena a Correos se ignora sin fila.
    const flows = await listFlows();
    const relevant = flows.some((f) => emailFlowMatches(f, { accountId: resolved.account.id, tag }));
    if (!relevant) return { claimed: false, started: 0 };
    const dedupeKey = emailEventDedupeKey(tag, email);
    const rowId = await dbClaimEmailEvent({
      accountId: resolved.account.id,
      dedupeKey,
      event: "tag_added",
      tag,
      contactEmail: email,
      source: evt.source,
      occurredAt: evt.occurredAt ?? null,
    });
    if (rowId == null) return { claimed: false, started: 0 }; // duplicado legítimo
    try {
      const r = await triggerEmailFlows({
        accountId: resolved.account.id,
        tag,
        contactEmail: email,
        dedupeKey,
        occurredAt: evt.occurredAt ?? null,
        source: evt.source,
      });
      await dbFinishEmailEvent(resolved.account.id, dedupeKey, {
        status: r.started > 0 ? "processed" : "ignored",
        flowsStarted: r.started,
      });
      try {
        await logActivity({
          source: "webhook",
          level: "info",
          summary:
            `Correo: etiqueta «${tag.slice(0, 40)}» de la cuenta ${resolved.account.id} → ` +
            `${r.started} flujo(s) arrancado(s)` + (r.skipped ? `, ${r.skipped} omitido(s)` : "") +
            ` (vía ${evt.source === "poll" ? "reconciliación" : "webhook"})`,
          payload: {
            file: "email-events.ts",
            fn: "ingestEmailTagEvent",
            account_id: resolved.account.id,
            tag: tag.slice(0, 80),
            // email del contacto RECORTADO (PII mínima en el rastro).
            contact: email.slice(0, 3) + "…",
            started: r.started,
            skipped: r.skipped,
            source: evt.source,
          },
        });
      } catch { /* la telemetría nunca rompe la ingesta */ }
      return { claimed: true, started: r.started };
    } catch (e) {
      // Error PARCIAL: el evento queda reclamado con su error saneado; el claim
      // por flujo (dbClaimOnce en triggerEmailFlows) garantiza que un reintento
      // manual no repita los flujos que sí arrancaron.
      const msg = String((e as Error).message || "error").slice(0, 200);
      await dbFinishEmailEvent(resolved.account.id, dedupeKey, { status: "error", error: msg }).catch(() => { /* best-effort */ });
      try {
        await logActivity({
          source: "webhook",
          level: "error",
          summary: `Correo: fallo procesando la etiqueta «${tag.slice(0, 40)}»: ${msg.slice(0, 120)}`,
          payload: { file: "email-events.ts", fn: "ingestEmailTagEvent", account_id: resolved.account.id, error: msg },
        });
      } catch { /* noop */ }
      return { claimed: true, started: 0 };
    }
  });
}

/**
 * DIRECTO-1 · Ingesta un evento leído de los DESTINATARIOS de un envío
 * concreto (getMailingRecipientsInternal: opened/clicked POR CONTACTO — la
 * vía para newsletters sueltas, sin regla ni etiqueta en la web). Misma
 * mecánica de claim; clave `mail:<tipo>:<mailingId>:<email>`.
 *
 * `baseline` = primera pasada de un flujo recién activado SIN «incluir
 * pasados»: el claim por flujo se marca SIN ejecutar (línea base) para que
 * las aperturas viejas no disparen nada; a partir de ahí, solo lo nuevo.
 */
export async function ingestMailingEvent(
  resolved: ResolvedAccount,
  evt: { mailingId: string; evType: "opened" | "clicked"; contactEmail: string; source: "poll"; baselineFlowIds?: string[]; mOriginType?: string; mOriginId?: string },
): Promise<{ claimed: boolean; started: number }> {
  const email = normEmail(evt.contactEmail);
  const mid = String(evt.mailingId || "").trim();
  if (!mid || !email || email.indexOf("@") < 0) return { claimed: false, started: 0 };
  return runWithWorkspace(resolved.wsId, async () => {
    const flows = await listFlows();
    const match = { accountId: resolved.account.id, tag: "", mailingId: mid, evType: evt.evType, mOriginType: evt.mOriginType, mOriginId: evt.mOriginId };
    if (!flows.some((f) => emailFlowMatches(f, match))) return { claimed: false, started: 0 };
    const dedupeKey = `mail:${evt.evType}:${mid}:${email}`;
    const rowId = await dbClaimEmailEvent({
      accountId: resolved.account.id,
      dedupeKey,
      event: "mail_" + evt.evType,
      tag: "",
      contactEmail: email,
      source: evt.source,
      occurredAt: null,
    });
    if (rowId == null) return { claimed: false, started: 0 };
    try {
      // LÍNEA BASE · los flujos listados reclaman el evento sin ejecutarlo.
      for (const fid of evt.baselineFlowIds || []) await dbClaimOnce("emailflow:" + fid, dedupeKey);
      const r = await triggerEmailFlows({
        accountId: resolved.account.id,
        tag: "",
        mailingId: mid,
        evType: evt.evType,
        mOriginType: evt.mOriginType,
        mOriginId: evt.mOriginId,
        contactEmail: email,
        dedupeKey,
        occurredAt: null,
        source: evt.source,
      });
      await dbFinishEmailEvent(resolved.account.id, dedupeKey, { status: r.started > 0 ? "processed" : "ignored", flowsStarted: r.started });
      if (r.started > 0) {
        try {
          await logActivity({
            source: "webhook",
            level: "info",
            summary: `Correo (envío ${mid}): ${evt.evType === "clicked" ? "clic" : "apertura"} → ${r.started} flujo(s) arrancado(s) (seguimiento directo)`,
            payload: { file: "email-events.ts", fn: "ingestMailingEvent", account_id: resolved.account.id, mailing_id: mid, contact: email.slice(0, 3) + "…", started: r.started },
          });
        } catch { /* telemetría best-effort */ }
      }
      return { claimed: true, started: r.started };
    } catch (e) {
      const msg = String((e as Error).message || "error").slice(0, 200);
      await dbFinishEmailEvent(resolved.account.id, dedupeKey, { status: "error", error: msg }).catch(() => { /* best-effort */ });
      return { claimed: true, started: 0 };
    }
  });
}

/** Firma HMAC del webhook (si viaja): SHA-256 del cuerpo con la MISMA clave
 *  compartida del receptor. Si la cabecera viene y NO casa, el evento de correo
 *  se descarta (la clave de la URL ya pasó — esto es una segunda cerradura,
 *  gratis porque systeme.io firma con la «clave secreta» del webhook, que es
 *  la que el dueño pega como `?k=`). */
export function webhookSignatureOk(rawBody: string, headers: Record<string, unknown>): boolean {
  const sig = String(headers["x-webhook-signature"] || "").trim();
  if (!sig) return true; // sin firma no hay nada que verificar (la clave ?k= ya pasó)
  const key = getSetting("systemeio.webhook.key");
  if (!key) return true;
  try {
    const h = crypto.createHmac("sha256", key).update(rawBody, "utf8").digest("hex");
    const a = Buffer.from(h.toLowerCase());
    const b = Buffer.from(sig.toLowerCase().replace(/^sha256=/, ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Entrada desde systemeio-webhook.ts (fire-and-forget, después del 200).
 * Extrae la etiqueta añadida y el email del contacto, resuelve la cuenta de
 * forma determinista y delega en ingestEmailTagEvent. Nunca lanza.
 */
export async function handleSioWebhookForEmailEvents(
  json: unknown,
  headers: Record<string, unknown>,
  query: Record<string, string>,
  rawBody: string,
): Promise<void> {
  try {
    const j = json as Record<string, unknown> | null;
    const event = String(headers["x-webhook-event"] || "").toUpperCase();
    // Solo el evento de ASIGNACIÓN de etiqueta es señal de correo. La lista de
    // tags del contacto que viaja en otros eventos (CONTACT_CREATED…) NO lo es:
    // usarla dispararía «aperturas» con cada alta.
    const tagObj = (j?.tag ?? (j?.data as Record<string, unknown> | undefined)?.tag) as Record<string, unknown> | undefined;
    const tagName = String(tagObj?.name ?? (j?.tagName as string) ?? "").trim();
    const isTagAdded = event.includes("TAG_ADDED") || (!event && !!tagName);
    if (!isTagAdded || !tagName) return;
    if (event.includes("TAG_REMOVED")) return;
    const contact = (j?.contact ?? (j?.data as Record<string, unknown> | undefined)?.contact) as Record<string, unknown> | undefined;
    const email = normEmail(String(contact?.email ?? (j?.email as string) ?? ""));
    if (!email) return;
    if (!webhookSignatureOk(rawBody, headers)) {
      recordWebhook("systemeio", "⛔ Correos: firma X-Webhook-Signature NO casa con la clave — evento descartado");
      return;
    }
    // Momento del evento: cabecera oficial (epoch) si viene; si no, ahora.
    const tsRaw = Number(headers["x-webhook-event-timestamp"] || 0);
    const occurredAt = tsRaw > 0 ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : Date.now();
    // Resolución determinista: ?acc=… (la URL que enseña el editor) o el host
    // de la sourceURL del contacto. Nada de defaults.
    const src = String(contact?.sourceURL ?? (j?.sourceURL as string) ?? "");
    let host = "";
    try { host = src ? new URL(src).hostname : ""; } catch { /* sourceURL rara */ }
    const resolved = await resolveEmailEventAccount(query.acc, host);
    if (!resolved) {
      if (query.acc) recordWebhook("systemeio", "⚠️ Correos: acc=" + String(query.acc).slice(0, 12) + " no corresponde a ninguna cuenta conectada (o a más de una) — evento descartado");
      return; // sin cuenta resoluble no hay workspace: JAMÁS 'default' a ciegas
    }
    await ingestEmailTagEvent(resolved, { tag: tagName, contactEmail: email, occurredAt, source: "webhook" });
  } catch (e) {
    try { recordWebhook("systemeio", "⚠️ Correos: " + String((e as Error).message || e).slice(0, 160)); } catch { /* noop */ }
  }
}

// ════════════════════════════════════════════════════════════════════
// RECONCILIACIÓN (red de seguridad) · cada 30 min, SOLO para las parejas
// (cuenta, etiqueta) que algún flujo activo referencia y SOLO en cuentas con
// API key: se listan los contactos que ya tienen la etiqueta (pocas páginas,
// tope explícito) y se ingieren con la MISMA clave → los ya vistos por webhook
// no repiten. Un reinicio no pierde nada: la marca vive en app_email_events.
// ════════════════════════════════════════════════════════════════════

const POLL_EVERY_MS = 30 * 60_000;
const POLL_MAX_PAGES = 5; // 5×100 contactos por etiqueta y pasada — backfill acotado
const POLL_MAX_TAGS_PER_TICK = 20; // por workspace — el resto, a la siguiente pasada
const lastPollAt = new Map<string, number>(); // `${ws}:${acc}:${tag}` → epoch ms
/** Solo pruebas: vaciar las puertas de cadencia entre ticks simulados. */
export const _pollState = { lastPollAt };

/** Inyectable en pruebas: sustituye las llamadas reales al proveedor. */
export const _pollFetchers = {
  contactsWithTag: (apiKey: string, tag: string, maxPages: number) =>
    withPublicApiKey(apiKey, () => listContactsWithTagAndPhone(tag, maxPages)),
  // DIRECTO-1 · destinatarios de un envío (abrió/clicó por contacto). Desde
  // SIO-LIMPIEZA-1 (30-oct-2026) siempre por el puente MCP (fetchSystemeioMailingDetail, ya existente —
  // 1 página de 100, truncated rotulado): así una cuenta que «funciona por
  // autologin» no obliga a nadie a pegar cookies.
  mailingPeople: async (acc: SiAccount, mailingId: string) => {
    const { fetchSystemeioMailingDetail } = await import("./mcp-bridge.js");
    const d = await fetchSystemeioMailingDetail(acc.id, Number(mailingId) || 0);
    const vacio = { clk: { found: false, clicks: [] as Array<{ url: string; unique: number | null; total: number | null }>, pathUsed: null as string | null } };
    if (!d) return { rec: { expired: false, found: false, recipients: [], truncated: false, pathUsed: null }, ...vacio };
    return {
      rec: { expired: false, found: d.recipients.length > 0 || !d.reason, recipients: d.recipients, truncated: d.recipientsTruncated, pathUsed: "bridge" },
      clk: { found: d.clicks.length > 0, clicks: d.clicks, pathUsed: "bridge" },
    };
  },
  // DIRECTO-2 · envíos recientes de la cuenta (90 días), por el puente.
  recentMailings: async (acc: SiAccount) => {
    const to = new Date();
    const from = new Date(to.getTime() - 90 * 86400_000);
    const iso = (d: Date): string => d.toISOString().slice(0, 10);
    const { fetchSystemeioEmailStats } = await import("./mcp-bridge.js");
    const r = await fetchSystemeioEmailStats(acc.id, iso(from) + "T00:00:00", iso(to) + "T23:59:59");
    return r?.emails ?? [];
  },
};

export async function emailEventsReconcileTick(): Promise<void> {
  let wss: Array<{ id: string }> = [];
  try {
    wss = await listWorkspacesForRoutingCached();
  } catch {
    wss = [{ id: DEFAULT_WORKSPACE_ID }];
  }
  if (!wss.length) wss = [{ id: DEFAULT_WORKSPACE_ID }];
  for (const ws of wss) {
    try {
      await runWithWorkspace(ws.id, async () => {
        const flows = (await listFlows()).filter((f) => f.enabled && f.trigger?.type === "email");
        if (!flows.length) return;
        const accounts = await listAccountsRaw();
        const byId = new Map(accounts.map((a) => [a.id, a]));
        // Parejas (cuenta, etiqueta) únicas que los flujos activos referencian.
        const pairs = new Map<string, { acc: SiAccount; tag: string }>();
        for (const f of flows) {
          const acc = byId.get(String(f.trigger.emAccountId || ""));
          const tag = String(f.trigger.emTag || "").trim();
          if (!acc || !acc.apiKey || !tag) continue; // sin API key no hay pull (el webhook sigue)
          pairs.set(`${acc.id}:${normTag(tag)}`, { acc, tag });
        }
        let done = 0;
        for (const [pairKey, { acc, tag }] of pairs) {
          if (done >= POLL_MAX_TAGS_PER_TICK) break;
          const k = `${ws.id}:${pairKey}`;
          const last = lastPollAt.get(k) || 0;
          if (Date.now() - last < POLL_EVERY_MS - 60_000) continue;
          lastPollAt.set(k, Date.now());
          done++;
          try {
            const contacts = await _pollFetchers.contactsWithTag(acc.apiKey as string, tag, POLL_MAX_PAGES);
            for (const c of contacts) {
              if (!c.email) continue;
              await ingestEmailTagEvent({ wsId: ws.id, account: acc }, { tag, contactEmail: c.email, occurredAt: null, source: "poll" });
            }
          } catch (e) {
            // Error temporal (429/timeout/5xx): a la próxima pasada. Sin martilleo.
            recordWebhook("systemeio", "⚠️ Correos (reconciliación) «" + tag.slice(0, 40) + "»: " + String((e as Error).message || e).slice(0, 120));
          }
        }
        // ── DIRECTO-1/2 · seguimiento de ENVÍOS por destinatario (sin etiqueta):
        // un solo bucle para (a) correos CONCRETOS con mailingId y (b) alcances
        // AMPLIOS (cualquiera/tipo/origen) de cuentas con cookie, sobre los
        // envíos RECIENTES de la cuenta (90 días, tope 15). La procedencia de
        // cada envío sale del catálogo YA cacheado (waitMs:1, jamás un build).
        const RECENT_CAP = 15;
        const mjobs = new Map<string, { acc: SiAccount; mid: string }>();
        const concreteByMid = new Map<string, Array<{ id: string; includePast: boolean }>>();
        const broadByAcc = new Map<string, { acc: SiAccount; flows: Array<{ id: string; includePast: boolean }> }>();
        for (const f of flows) {
          const acc = byId.get(String(f.trigger.emAccountId || ""));
          // SIO-LIMPIEZA-1 · solo por el puente: la cuenta necesita su correo y contraseña.
          if (!acc || !acc.sandboxPass) continue;
          const mid = String(f.trigger.emMailingId || "").trim();
          const fl = { id: f.id, includePast: !!f.trigger.emIncludePast };
          if (mid) {
            const gk = `${acc.id}:${mid}`;
            mjobs.set(gk, { acc, mid });
            const arr = concreteByMid.get(gk) || [];
            arr.push(fl);
            concreteByMid.set(gk, arr);
          } else if (!String(f.trigger.emTag || "").trim() && ["any", "type", "origin"].includes(String(f.trigger.emScope || "any"))) {
            const g = broadByAcc.get(acc.id) || { acc, flows: [] };
            g.flows.push(fl);
            broadByAcc.set(acc.id, g);
          }
        }
        for (const [, g] of broadByAcc) {
          try {
            const recent = await _pollFetchers.recentMailings(g.acc);
            const sent = recent
              .filter((m) => m.mailingId && (String(m.status || "").toLowerCase() === "sent" || m.sent > 0))
              .sort((a, b) => String(b.scheduledAt || "").localeCompare(String(a.scheduledAt || "")))
              .slice(0, RECENT_CAP);
            for (const m of sent) {
              const gk = `${g.acc.id}:${m.mailingId}`;
              if (!mjobs.has(gk)) mjobs.set(gk, { acc: g.acc, mid: String(m.mailingId) });
            }
          } catch (e) {
            recordWebhook("systemeio", "⚠️ Correos (envíos recientes): " + String((e as Error).message || e).slice(0, 120));
          }
        }
        // Procedencia mailing→(tipo, origen) desde el catálogo cacheado.
        const metaByAcc = new Map<string, Map<string, { mOriginType?: string; mOriginId?: string }>>();
        const metaFor = async (acc: SiAccount): Promise<Map<string, { mOriginType?: string; mOriginId?: string }>> => {
          let m = metaByAcc.get(acc.id);
          if (m) return m;
          m = new Map();
          try {
            const st = await getEmailCatalogOrStatus(acc.id, { waitMs: 1 });
            if (st && st.status === "ready") for (const e of st.cat.items) if (e.mailingId) m.set(String(e.mailingId), { mOriginType: e.originType, mOriginId: e.originId });
          } catch { /* sin catálogo cacheado: los alcances por tipo/origen esperan al siguiente tick */ }
          metaByAcc.set(acc.id, m);
          return m;
        };
        // LÍNEA BASE · concretos: 1ª vez por (flujo, envío); amplios: 1ª pasada
        // GLOBAL del flujo (todo lo visto en ella se reclama sin ejecutar).
        const broadSeeded = new Map<string, boolean>();
        const baselineFor = async (accId: string, mid: string): Promise<string[]> => {
          const ids: string[] = [];
          for (const fl of concreteByMid.get(`${accId}:${mid}`) || []) {
            if (!fl.includePast && (await dbClaimOnce("emailflow-seed:" + fl.id, "mail:" + mid))) ids.push(fl.id);
          }
          for (const fl of (broadByAcc.get(accId) || { flows: [] }).flows) {
            if (fl.includePast) continue;
            if (!broadSeeded.has(fl.id)) broadSeeded.set(fl.id, await dbClaimOnce("emailflow-seed:" + fl.id, "__scope__"));
            if (broadSeeded.get(fl.id)) ids.push(fl.id);
          }
          return ids;
        };
        let mdone = 0;
        for (const [gk, job] of mjobs) {
          if (mdone >= POLL_MAX_TAGS_PER_TICK) break;
          const k = `${ws.id}:mail:${gk}`;
          const last = lastPollAt.get(k) || 0;
          if (Date.now() - last < POLL_EVERY_MS - 60_000) continue;
          lastPollAt.set(k, Date.now());
          mdone++;
          try {
            const { rec } = await _pollFetchers.mailingPeople(job.acc, job.mid);
            if (rec.expired) { recordWebhook("systemeio", "⚠️ Correos (envío " + job.mid + "): la cookie de la cuenta caducó — reconéctala en Conexiones"); continue; }
            if (!rec.found) { recordWebhook("systemeio", "⚠️ Correos (envío " + job.mid + "): esta cuenta no expone los destinatarios del envío"); continue; }
            const meta = (await metaFor(job.acc)).get(job.mid) || {};
            const baseline = await baselineFor(job.acc.id, job.mid);
            for (const r of rec.recipients) {
              if (!r.email) continue;
              if (r.opened) await ingestMailingEvent({ wsId: ws.id, account: job.acc }, { mailingId: job.mid, evType: "opened", contactEmail: r.email, source: "poll", baselineFlowIds: baseline, ...meta });
              if (r.clicked) await ingestMailingEvent({ wsId: ws.id, account: job.acc }, { mailingId: job.mid, evType: "clicked", contactEmail: r.email, source: "poll", baselineFlowIds: baseline, ...meta });
            }
          } catch (e) {
            recordWebhook("systemeio", "⚠️ Correos (envío " + job.mid + "): " + String((e as Error).message || e).slice(0, 120));
          }
        }
      });
    } catch { /* un workspace roto no frena a los demás */ }
  }
}

// Al guardar/activar un flujo de correo, un tick adelantado (debounced): el
// primer sondeo no espera media hora. Las puertas lastPollAt evitan martilleo.
let pokeT: ReturnType<typeof setTimeout> | null = null;
export function emailEventsPokeSoon(): void {
  if (pokeT) return;
  pokeT = setTimeout(() => {
    pokeT = null;
    void emailEventsReconcileTick().catch(() => { /* siguiente tick regular */ });
  }, 8_000);
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Arranca la reconciliación periódica (idempotente). Sin flujos de correo
 *  activos, cada pasada no hace NINGUNA llamada externa. */
export function startEmailEventsScheduler(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void emailEventsReconcileTick().catch(() => { /* nunca tumba el proceso */ });
  }, POLL_EVERY_MS);
  // Primera pasada suave tras el arranque (deja respirar el boot).
  setTimeout(() => {
    void emailEventsReconcileTick().catch(() => { /* idem */ });
  }, 2 * 60_000).unref?.();
}
