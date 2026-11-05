/**
 * Cliente WhatsApp Cloud API. Token y phone number id se leen de settings
 * (BD/panel o env), así que se cambian sin redeploy.
 *
 * Pipeline outbound: el body pasa por:
 *  1. substituteVars (si contiene `{{...}}`) — variables {{name}}, {{phone}},
 *     {{stage}}, etc. resueltas contra el Contact (auto-fetch si no se pasa).
 *  2. wrapUrlsInText — URLs http(s) → shortlinks /r/<token> para trackear
 *     clicks (a no ser que setting `links.wrap_auto=off`).
 *
 * Para enviar tal cual sin transformaciones usa `sendTextRaw`.
 */
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { get, botForAccount } from "./settings.js";
import { substituteVars } from "./templating.js";
import { wrapUrlsInText, type ShortenCtx } from "./links.js";
import { dbGetContact, dbInsertWaEvent, dbUpsertWaMessageStatus, dbUpsertWaReaction, type Contact } from "./db.js";
import { logActivity } from "./activity.js";
import { currentWorkspaceId } from "./workspace.js";
import { qrList, qrSend, qrReact } from "./whatsapp-qr.js";
import { downloadPublic } from "./public-download.js";

const GRAPH_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// ---- Multi-número: credenciales por número activo (como las cuentas IG) ----
export type WaCreds = { token: string; phoneId: string };
const waALS = new AsyncLocalStorage<WaCreds>();
function creds(): WaCreds {
  const s = waALS.getStore();
  if (s && s.phoneId && (s.token || isQrNumber(s.phoneId))) return s;
  return { token: get("whatsapp.accessToken"), phoneId: get("whatsapp.phoneNumberId") };
}

/** CHAT-POR-NUMERO-1 · La cuenta WhatsApp del contexto ('wa:<pid>') o '' si no lo hay.
 *  SOLO el ALS explícito (runWithWaNumber), sin caer a los settings: fuera de un envío
 *  de WhatsApp (p. ej. un turno de Instagram) debe devolver vacío, no el principal. */
export function currentWaAcct(): string {
  const s = waALS.getStore();
  return s?.phoneId ? "wa:" + s.phoneId : "";
}
export interface WaNumber {
  transport?: "cloud" | "qr";
  phoneNumberId: string;
  label: string;
  token: string;
  botId: string;
  isMain: boolean;
}
/** Números registrados: el principal (settings) + los extra (whatsapp.numbers JSON). */
export function listWaNumbers(includeQr = false): WaNumber[] {
  const out: WaNumber[] = [];
  const pid = get("whatsapp.phoneNumberId");
  const ptok = get("whatsapp.accessToken");
  // BOT-POR-CUENTA-1 · el bot de cada número vive ya en el mapa único
  // `bots.byAccount` (mismo sitio que Instagram y Facebook). Las claves viejas
  // (`whatsapp.botId` y `numbers[].botId`) siguen valiendo de respaldo para no
  // romper lo ya configurado hasta que se guarde una vez desde el panel.
  const delMapa = (pnid: string): string => botForAccount("wa:" + pnid);
  if (pid && ptok)
    out.push({
      phoneNumberId: pid,
      label: get("whatsapp.label") || get("whatsapp.displayPhoneNumber") || "Principal",
      token: ptok,
      botId: delMapa(pid) || get("whatsapp.botId") || "",
      isMain: true,
    });
  try {
    for (const a of JSON.parse(get("whatsapp.numbers") || "[]")) {
      if (a?.phoneNumberId && a?.token && !out.some((x) => x.phoneNumberId === String(a.phoneNumberId)))
        out.push({
          phoneNumberId: String(a.phoneNumberId),
          label: a.label || String(a.phoneNumberId),
          token: a.token,
          botId: delMapa(String(a.phoneNumberId)) || a.botId || "",
          isMain: false,
        });
    }
  } catch {
    /* whatsapp.numbers mal formado → se ignora */
  }
  if(includeQr) for (const n of qrList().filter(n => !!n.phone)) out.push({phoneNumberId:n.id,label:n.label || n.phone,token:"",botId:delMapa(n.id) || "__none__",isMain:false,transport:"qr"});
  return out;
}
/** El permiso de texto libre depende del transporte registrado, nunca de un prefijo enviado por el cliente. */
export function isQrNumber(id: string): boolean { return qrList().some(n => n.id === id && !!n.phone); }
/** Resuelve el número por su phone_number_id (el que llega en el webhook). */
export function resolveWaNumber(phoneNumberId: string): WaNumber | null {
  return listWaNumbers(true).find((x) => x.phoneNumberId === phoneNumberId) || null;
}
/** Ejecuta fn con ese número como contexto activo (los envíos lo usan). */
export function runWithWaNumber<T>(c: WaCreds, fn: () => Promise<T>): Promise<T> {
  return waALS.run(c, fn);
}

/**
 * T02 · Resolución ESTRICTA del número emisor elegido por el usuario.
 *
 * A diferencia de creds() (que sin contexto cae al principal), aquí un senderId
 * que no resuelve es un ERROR, nunca un fallback: el usuario eligió un número
 * concreto y enviar por otro sería mentirle. Como listWaNumbers() lee las
 * settings del workspace activo (ALS), un senderId de otro workspace simplemente
 * no aparece y recibe el mismo rechazo que uno inexistente — sin revelar nada.
 */
export function requireWaSender(senderId: string):
  | { ok: true; num: WaNumber }
  | { ok: false; error: string } {
  const id = String(senderId || "").trim();
  if (!id) return { ok: false, error: "Falta el número emisor. Elige desde qué número enviar." };
  const num = resolveWaNumber(id);
  if (!num || (!num.token && num.transport !== "qr") || !num.phoneNumberId) {
    return { ok: false, error: "Ese número de WhatsApp no está conectado en este workspace. Revisa Conexiones o elige otro emisor." };
  }
  return { ok: true, num };
}

/** Motivo único, para que el panel y el servidor digan exactamente lo mismo. */
export const MOTIVO_QR_SIN_DIFUSION =
  "Los números vinculados por QR no pueden enviar difusiones: el envío masivo es lo que hace que WhatsApp restrinja la cuenta. Elige un número conectado con Meta.";

/**
 * DIFUSION-QR-1 · Emisor válido para un envío MASIVO (difusiones y lotes).
 *
 * Un número por QR habla con WhatsApp por un cliente no oficial. Conversar de ida y
 * vuelta con quien ya escribió es de bajo riesgo, pero el saliente en volumen hacia
 * gente que no ha escrito es justo el patrón por el que WhatsApp restringe cuentas —
 * y la cuenta que se juega es la del CLIENTE. Por eso el masivo exige transporte de
 * Meta, aunque la Bandeja siga admitiendo el QR sin ninguna limitación.
 *
 * Vive aquí, y no en cada endpoint, a propósito: son cinco puertas de entrada
 * (difusión, reasignar emisor, lote de la Bandeja, el motor y el flow builder) y
 * dejarse una abierta valdría lo mismo que no cerrar ninguna.
 */
export function requireBroadcastSender(senderId: string):
  | { ok: true; num: WaNumber }
  | { ok: false; error: string } {
  const base = requireWaSender(senderId);
  if (!base.ok) return base;
  if (base.num.transport === "qr") return { ok: false, error: MOTIVO_QR_SIN_DIFUSION };
  return base;
}

/** Números que PUEDEN emitir un envío masivo. Los QR quedan fuera (ver arriba). */
export function listBroadcastSenders(): WaNumber[] {
  return listWaNumbers().filter((n) => n.transport !== "qr");
}


export type WabaSendTarget =
  | { ok: true; creds: WaCreds }
  | { ok: false; reason: "not-connected"; wabaPhones: string[] }
  | { ok: false; reason: "unknown" };

/**
 * Resuelve un número conectado (pnid+token) que pertenezca a `wabaId` — la cuenta de
 * WhatsApp Business donde vive la plantilla. Prefiere el número principal.
 *
 * Existe porque las plantillas se crean/listan contra UNA WABA (whatsapp.wabaId) pero el
 * envío sale del número activo. Con varios números en WABAs distintas, enviar una plantilla
 * desde el número equivocado da el error #132001 "la plantilla no existe en es" — porque
 * Meta la busca en la WABA del número emisor, no en la que la aprobó.
 *
 * Tres desenlaces:
 *  - ok:true      → envía envuelto en runWithWaNumber(creds).
 *  - unknown      → no se pudo verificar (red/permiso): el caller cae al principal, o sea
 *                   EXACTAMENTE lo de hoy — nunca rompe el caso single-WABA que funciona.
 *  - not-connected→ la WABA existe pero su número no está en el panel: error claro al usuario.
 */
export async function resolveSendCredsForWaba(wabaId: string): Promise<WabaSendTarget> {
  const nums = listWaNumbers();
  if (!wabaId || !nums.length) return { ok: false, reason: "unknown" };
  // Un token puede no "ver" una WABA ajena; probamos con todos los que tenemos.
  const tokens = [get("whatsapp.accessToken"), ...nums.map((n) => n.token)].filter(Boolean) as string[];
  let phones: { id: string; display: string }[] | null = null;
  for (const tok of tokens) {
    try {
      const r = await fetch(
        `${BASE}/${wabaId}/phone_numbers?fields=id,display_phone_number&access_token=${encodeURIComponent(tok)}`,
      );
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(j.data)) {
        phones = j.data.map((p: any) => ({ id: String(p.id || ""), display: String(p.display_phone_number || "") }));
        break;
      }
    } catch { /* siguiente token */ }
  }
  if (!phones) return { ok: false, reason: "unknown" };
  const pids = new Set(phones.map((p) => p.id));
  const match =
    nums.find((n) => n.isMain && pids.has(n.phoneNumberId)) ||
    nums.find((n) => pids.has(n.phoneNumberId));
  if (match) return { ok: true, creds: { token: match.token, phoneId: match.phoneNumberId } };
  return { ok: false, reason: "not-connected", wabaPhones: phones.map((p) => p.display).filter(Boolean) };
}
/** phone_number_id del número activo (o el principal si no hay contexto). Lo usa
 *  el motor de flujos para limitar un flujo a un número concreto (Flow.appliesTo). */
export function activeWaPhoneId(): string {
  return creds().phoneId;
}

/**
 * T02 · phone_number_ids que pertenecen a una WABA, para validar que el emisor
 * elegido puede enviar una plantilla de esa cuenta (si no coincide: error #132001
 * de Meta). Cache 5 min por (workspace, waba) — misma llamada Graph que
 * resolveSendCredsForWaba, pero devolviendo la LISTA para chequear pertenencia.
 * null = no verificable ahora (red/permisos): el caller no debe bloquear por eso.
 */
const wabaPhonesCache = new Map<string, { at: number; pids: string[] }>();
export async function listWabaPhoneIds(wabaId: string): Promise<string[] | null> {
  if (!wabaId) return null;
  const nums = listWaNumbers();
  // La clave lleva la HUELLA de los números conectados (ids + hash de tokens):
  // conectar, desconectar o RECONECTAR un número (token nuevo) cambia la huella
  // y la caché se invalida sola, sin esperar el TTL. Jamás se guarda un token.
  const huella = crypto.createHash("sha256")
    .update(nums.map((n) => n.phoneNumberId + ":" + n.token).sort().join("|"))
    .digest("hex").slice(0, 12);
  const key = `${currentWorkspaceId()}|${wabaId}|${huella}`;
  const hit = wabaPhonesCache.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.pids;
  const tokens = [get("whatsapp.accessToken"), ...nums.map((n) => n.token)].filter(Boolean) as string[];
  for (const tok of tokens) {
    try {
      const r = await fetch(`${BASE}/${wabaId}/phone_numbers?fields=id&access_token=${encodeURIComponent(tok)}`);
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(j.data)) {
        const pids = j.data.map((p: any) => String(p.id || "")).filter(Boolean);
        wabaPhonesCache.set(key, { at: Date.now(), pids });
        if (wabaPhonesCache.size > 100) wabaPhonesCache.delete(wabaPhonesCache.keys().next().value as string);
        return pids;
      }
    } catch { /* siguiente token */ }
  }
  return null;
}

export interface SendCtx {
  /** Contacto destinatario. Si no se pasa, se hace fetch por phone cuando hace falta. */
  contact?: Contact | null;
  /** Contexto para los shortlinks generados (kind/id/label) para reporting. */
  linkCtx?: ShortenCtx;
  /** Saltar la sustitución de variables {{...}} aunque el body las tenga. */
  skipVars?: boolean;
  /** Saltar el wrap de URLs. */
  skipLinkWrap?: boolean;
  /** T02 · Colector de salida: si se pasa, el envío deja aquí el wamid que devuelve
   *  Meta (messages[0].id). Opcional para no tocar la firma boolean que ya
   *  comprueban decenas de call-sites.
   *  ENLACE-ECO-1 · y `body`: el texto que recibió DE VERDAD el cliente (con variables
   *  puestas y enlaces ya acortados). Es lo que la Bandeja debe guardar. */
  out?: { wamid?: string; body?: string };
}

async function preparePayload(to: string, body: string, ctx?: SendCtx): Promise<string> {
  let out = body;
  if (!ctx?.skipVars && out.includes("{{")) {
    const c = ctx?.contact ?? (await dbGetContact(to));
    out = substituteVars(out, c, { strict: false });
  }
  if (!ctx?.skipLinkWrap && /https?:\/\//i.test(out)) {
    // Sin contexto explícito es un envío manual (Bandeja): que lo diga. Con el
    // kind vacío estos enlaces caían en el cubo «otro» de las métricas y en la
    // lista de Enlaces sin origen.
    const linkCtx = ctx?.linkCtx ?? { kind: "inbox", phone: to };
    out = await wrapUrlsInText(out, linkCtx);
  }
  return out;
}

/** Devuelve SI el mensaje salió de verdad. Antes devolvia void y no lanzaba nunca: un
 *  envio rechazado por Meta (o sin credenciales) se registraba en Actividad pero quien
 *  llamaba no se enteraba, y la difusion lo contaba como ENVIADO. El valor de retorno es
 *  aditivo: quien lo ignore se comporta exactamente igual que antes. */
export async function sendText(to: string, body: string, ctx?: SendCtx, replyToMid?: string): Promise<boolean> {
  const { token, phoneId } = creds();
  if (isQrNumber(phoneId)) {
    const final = await preparePayload(to, body, ctx);
    const r = await qrSend(phoneId, to, final);
    if (ctx?.out) { ctx.out.wamid = r.id; ctx.out.body = final; }
    await dbUpsertWaMessageStatus({tenant_id:currentWorkspaceId(),phone_number_id:phoneId,message_id:r.id,user_id:to,msg_type:"text",status:"accepted"}).catch(() => {});
    return true;
  }
  if (!token || !phoneId) {
    console.error("[whatsapp] Falta accessToken/phoneNumberId — no se envía.");
    return false;
  }
  let enviado = true;
  const finalBody = await preparePayload(to, body, ctx);
  const chunks = finalBody.match(/[\s\S]{1,3900}/g) ?? [finalBody];
  for (const chunk of chunks) {
    const res = await fetch(`${BASE}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: chunk, preview_url: true },
        // CITA-1 · solo el PRIMER trozo cita: si no, un texto largo citaría N veces.
        ...(replyToMid && chunk === chunks[0] ? { context: { message_id: replyToMid } } : {}),
      }),
    });
    if (!res.ok) {
      const errTxt = await res.text();
      console.error(`[whatsapp] send ${res.status}: ${errTxt}`);
      // FASE-5: telemetría — Meta Graph rechazó el envío.
      // NO logueamos token ni body del chunk completo (contiene phone destinatario en `to`).
      await logActivity({
        source: "wa-send",
        level: "error",
        status: String(res.status),
        summary: `WhatsApp sendText falló ${res.status}: ${errTxt.slice(0, 160)}`,
        payload: {
          file: "whatsapp.ts",
          fn: "sendText",
          phoneId,
          to: to.slice(0, 4) + "***" + to.slice(-3),
          httpStatus: res.status,
          error: errTxt.slice(0, 400),
        },
      });
      // metricas-pro M3: registramos también como evento fallido para que
      // la pestaña WhatsApp PRO refleje envíos rotos en el heatmap.
      try {
        await dbInsertWaEvent({
          tenant_id: currentWorkspaceId(),
          phone_number_id: phoneId,
          direction: "out",
          msg_type: "text",
          status: "failed",
        });
      } catch { /* event tracking nunca tira el envío */ }
      enviado = false;
    } else {
      // Un HTTP 200 solo significa que Meta ACEPTÓ tramitar el mensaje. El estado
      // real (sent/delivered/read/failed) llega después por webhook. Exigimos wamid
      // para poder enlazar ambas cosas; sin él el panel no puede afirmar que salió.
      const j: any = await res.json().catch(() => ({}));
      const wamid = String(j?.messages?.[0]?.id || "").trim();
      if (!wamid) {
        console.error("[whatsapp] Meta respondió 2xx sin messages[0].id");
        await logActivity({
          source: "wa-send",
          level: "error",
          status: "invalid-response",
          summary: "WhatsApp aceptó la petición pero no devolvió un id de mensaje",
          payload: { file: "whatsapp.ts", fn: "sendText", phoneId, to: to.slice(0, 4) + "***" + to.slice(-3) },
        });
        enviado = false;
        continue;
      }
      if (ctx?.out && chunk === chunks[0]) { ctx.out.wamid = wamid; ctx.out.body = finalBody; }
      // "accepted" es deliberado: no se convierte en ✓ hasta recibir `sent`.
      try {
        await dbUpsertWaMessageStatus({
          tenant_id: currentWorkspaceId(),
          phone_number_id: phoneId,
          message_id: wamid,
          user_id: to,
          msg_type: "text",
          status: "accepted",
        });
      } catch { /* el tracking nunca revierte una petición ya aceptada por Meta */ }
    }
  }
  return enviado;
}

/** Versión bypass para casos donde NO queremos vars ni shortlinks. */
export async function sendTextRaw(to: string, body: string): Promise<boolean> {
  return sendText(to, body, { skipVars: true, skipLinkWrap: true });
}

/** REACCIONES-1 · Envía (emoji='' retira) una reacción a un mensaje ya existente de la
 *  conversación. messageFromMe dice de QUIÉN es ese mensaje (no quién reacciona: aquí
 *  siempre es el agente) — Cloud API y Baileys necesitan identificarlo igual. */
export async function sendReaction(to: string, messageId: string, messageFromMe: boolean, emoji: string): Promise<boolean> {
  const msgId = String(messageId || "").trim();
  if (!msgId) return false;
  const { token, phoneId } = creds();
  if (isQrNumber(phoneId)) {
    try {
      await qrReact(phoneId, to, msgId, messageFromMe, emoji);
    } catch (e) {
      console.error("[whatsapp] sendReaction (QR) falló:", (e as Error).message);
      return false;
    }
    await dbUpsertWaReaction({ message_id: msgId, from_role: "agent", emoji }).catch(() => {});
    return true;
  }
  if (!token || !phoneId) {
    console.error("[whatsapp] Falta accessToken/phoneNumberId — no se envía la reacción.");
    return false;
  }
  const res = await fetch(`${BASE}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "reaction", reaction: { message_id: msgId, emoji } }),
  });
  if (!res.ok) {
    const errTxt = await res.text();
    console.error(`[whatsapp] sendReaction ${res.status}: ${errTxt}`);
    await logActivity({
      source: "wa-send",
      level: "error",
      status: String(res.status),
      summary: `WhatsApp sendReaction falló ${res.status}: ${errTxt.slice(0, 160)}`,
      payload: {
        file: "whatsapp.ts",
        fn: "sendReaction",
        phoneId,
        to: to.slice(0, 4) + "***" + to.slice(-3),
        httpStatus: res.status,
        error: errTxt.slice(0, 400),
      },
    });
    return false;
  }
  await dbUpsertWaReaction({ message_id: msgId, from_role: "agent", emoji }).catch(() => {});
  return true;
}

/**
 * Pregunta con opciones NATIVAS de WhatsApp (cuestionario tappable):
 *  - 1-3 opciones → botones de respuesta rápida.
 *  - 4-10 opciones → lista desplegable.
 * El cliente toca y WhatsApp devuelve la opción elegida (interactive reply).
 * Si la API rechaza el interactive, cae a texto numerado (1. 2. 3.).
 */
export async function sendButtons(to: string, body: string, labels: string[], ctx?: SendCtx, imageUrl?: string): Promise<boolean> {
  const clean = (labels || []).map((l) => String(l || "").trim()).filter(Boolean);
  if (isQrNumber(creds().phoneId)) return sendText(to, body + "\n" + clean.map((x,i) => `${i+1}. ${x}`).join("\n"), ctx);
  if (!clean.length) return sendText(to, body, ctx);
  const { token, phoneId } = creds();
  if (!token || !phoneId) {
    console.error("[whatsapp] Falta accessToken/phoneNumberId — botones no enviados.");
    return false;
  }
  const text = (await preparePayload(to, body, ctx)) || "Elige una opción:";
  // Los BOTONES tappables de WhatsApp limitan el título a 20 caracteres; si alguna opción
  // es más larga, se cortaría y quedaría ilegible ("¡Sí! Quiero que me c…"). En ese caso
  // usamos una LISTA, cuyas filas admiten título (24) + DESCRIPCIÓN (72): mucho más texto,
  // y sigue siendo clickable (el cliente abre el menú y toca su opción).
  const anyLong = clean.some((l) => l.length > 20);
  // Solo el interactive 'button' (<=3) admite cabecera de imagen; la lista no.
  const header = imageUrl && clean.length <= 3 && !anyLong ? { header: { type: "image", image: { link: imageUrl } } } : {};
  const interactive =
    clean.length <= 3 && !anyLong
      ? {
          type: "button",
          ...header,
          body: { text: text.slice(0, 1024) },
          action: {
            buttons: clean.map((l, i) => ({ type: "reply", reply: { id: "opt_" + i, title: l.slice(0, 20) } })),
          },
        }
      : {
          type: "list",
          body: { text: text.slice(0, 1024) },
          action: {
            button: "Ver opciones",
            sections: [
              {
                title: "Opciones",
                rows: clean.slice(0, 10).map((l, i) => {
                  const row: { id: string; title: string; description?: string } = { id: "opt_" + i, title: l.slice(0, 24) };
                  if (l.length > 24) row.description = l.slice(0, 72); // el resto del texto, legible
                  return row;
                }),
              },
            ],
          },
        };
  const res = await fetch(`${BASE}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "interactive", interactive }),
  });
  if (!res.ok) {
    console.error(`[whatsapp] buttons ${res.status}: ${await res.text()}`);
    // Fallback: opciones numeradas en texto (el motor las entiende igual).
    // Se PROPAGA el boolean del fallback: si también falla, el caller (p.ej.
    // executeBroadcast) debe contarlo como fallo, no como enviado.
    return sendText(to, `${text}\n${clean.map((l, i) => `${i + 1}. ${l}`).join("\n")}`, {
      skipVars: true,
      skipLinkWrap: true,
    });
  }
  return true;
}

/** ENLACE-TARJETA-1 · Mensaje interactivo «cta_url»: imagen de cabecera opcional, texto,
 *  pie y UN botón que abre una URL. Es la única forma de que un enlace enviado por la API
 *  salga con imagen GRANDE: la previsualización de enlaces de los mensajes de la API la
 *  genera WhatsApp en formato pequeño (miniatura cuadrada) haga lo que haga la página de
 *  destino — el formato grande solo lo produce el móvil del remitente, que sube su propia
 *  miniatura (comprobado en producción el 2-sep-2026: misma URL, grande desde el móvil y
 *  pequeña desde la API, con og:image de 1500x844 y 124 KB). Con el botón, además, la URL
 *  no se ve: puede ir acortada (mide clics) sin que aparezca el dominio del panel.
 *  Si Meta rechaza la cabecera (imagen inaccesible o demasiado pesada) se reintenta sin
 *  ella; si tampoco, devuelve false y quien llama decide el plan B (texto con enlace). */
export async function sendCtaUrl(
  to: string,
  card: { body: string; url: string; buttonText: string; imageUrl?: string; footer?: string },
  ctx?: SendCtx,
): Promise<boolean> {
  const { token, phoneId } = creds();
  if (isQrNumber(phoneId)) return sendText(to, card.body + "\n" + card.buttonText + ": " + card.url, ctx);
  if (!token || !phoneId) {
    console.error("[whatsapp] Falta accessToken/phoneNumberId — tarjeta no enviada.");
    return false;
  }
  const text = (await preparePayload(to, card.body, ctx)).trim() || "👇";
  const label = String(card.buttonText || "Abrir enlace").trim().slice(0, 20) || "Abrir enlace";
  const footer = String(card.footer || "").trim().slice(0, 60);
  const build = (withImage: boolean) => ({
    type: "cta_url",
    ...(withImage && card.imageUrl ? { header: { type: "image", image: { link: card.imageUrl } } } : {}),
    body: { text: text.slice(0, 1024) },
    ...(footer ? { footer: { text: footer } } : {}),
    action: { name: "cta_url", parameters: { display_text: label, url: card.url } },
  });
  for (const withImage of card.imageUrl ? [true, false] : [false]) {
    const res = await fetch(`${BASE}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "interactive", interactive: build(withImage) }),
    });
    if (res.ok) {
      // Mismo rastro que sendText: wamid para quien lo pida y fila «out» en las métricas.
      // Todo accesorio: jamás rompe un envío que YA salió.
      if (ctx?.out) {
        try { const j: any = await res.json(); ctx.out.wamid = String(j?.messages?.[0]?.id || ""); } catch { /* accesorio */ }
      }
      try {
        await dbInsertWaEvent({ tenant_id: currentWorkspaceId(), phone_number_id: phoneId, direction: "out", msg_type: "interactive", status: "sent" });
      } catch { /* idem */ }
      return true;
    }
    const errTxt = await res.text();
    console.error(`[whatsapp] cta_url${withImage ? " (con imagen)" : ""} ${res.status}: ${errTxt}`);
    // Reintentar sin cabecera solo tiene sentido si el rechazo es de la IMAGEN (131053 media
    // o el detalle habla de header/image/link). Ventana cerrada, límites o número inválido
    // fallarían igual: se devuelve false a la primera y quien llama decide.
    const deImagen = withImage && /131053|media|image|header|link/i.test(errTxt);
    if (deImagen) continue;
    try {
      await logActivity({
        source: "wa-send",
        level: "error",
        summary: `Tarjeta con botón rechazada por WhatsApp: ${errTxt.slice(0, 160)}`,
        payload: { file: "whatsapp.ts", fn: "sendCtaUrl", status: res.status, withImage },
      });
    } catch { /* la telemetría nunca rompe el envío */ }
    return false;
  }
  return false;
}

/** Envía una imagen (por URL pública) con caption opcional. */
export async function sendImage(to: string, imageUrl: string, caption?: string, ctx?: SendCtx): Promise<boolean> {
  const { token, phoneId } = creds();
  if (isQrNumber(phoneId)) {
    const media = await downloadPublic(imageUrl, {maxBytes:16*1024*1024,timeoutMs:15000});
    if(!media.ok)throw new Error("No se pudo descargar la imagen.");
    const r = await qrSend(phoneId,to,await preparePayload(to,caption || "",ctx),{buffer:media.body,mime:String(media.headers["content-type"] || "image/jpeg"),filename:"imagen",kind:"image"});
    if(ctx?.out)ctx.out.wamid=r.id;
    return true;
  }
  if (!token || !phoneId) {
    console.error("[whatsapp] Falta accessToken/phoneNumberId — imagen no enviada.");
    return false;
  }
  const cap = caption ? await preparePayload(to, caption, ctx) : "";
  const res = await fetch(`${BASE}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: imageUrl, ...(cap ? { caption: cap.slice(0, 1024) } : {}) },
    }),
  });
  if (!res.ok) throw new Error(`image ${res.status}: ${await res.text()}`);
  return true;
}

export type WaMediaKind = "image" | "document" | "audio" | "video" | "sticker";

/**
 * Sube bytes al endpoint /media de WhatsApp y devuelve el media_id (válido ~30 días).
 * Es el camino ROBUSTO para mandar documentos/audio/vídeo/sticker desde el panel: no
 * depende de hosting público (a diferencia de IG/FB), así que funciona aunque el
 * servicio corra en varias réplicas Railway. multipart/form-data vía FormData+Blob
 * (global en Node ≥18 / undici).
 */
export async function uploadWaMedia(buffer: Buffer, mime: string, filename = "file"): Promise<string> {
  const { token, phoneId } = creds();
  if (!token || !phoneId) throw new Error("Falta accessToken/phoneNumberId — media no subida.");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  // Uint8Array desacopla el Blob del Buffer de Node (evita problemas de SharedArrayBuffer).
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mime }), filename);
  const res = await fetch(`${BASE}/${phoneId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  if (!res.ok || !data?.id) throw new Error(`media upload ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return String(data.id);
}

/**
 * Envía un media ya subido (por media_id, preferido) o por link público. image/video/
 * document admiten caption; document admite filename; sticker debe ser webp.
 */
export async function sendWaMedia(
  to: string,
  kind: WaMediaKind,
  src: { mediaId?: string; link?: string },
  opts: { caption?: string; filename?: string; voice?: boolean; out?: { wamid?: string } } = {},
): Promise<void> {
  const { token, phoneId } = creds();
  if (!token || !phoneId) throw new Error("Falta accessToken/phoneNumberId — media no enviada.");
  const ref: Record<string, unknown> = src.mediaId ? { id: src.mediaId } : { link: src.link };
  if ((kind === "image" || kind === "video" || kind === "document") && opts.caption) {
    ref.caption = opts.caption.slice(0, 1024);
  }
  if (kind === "document" && opts.filename) ref.filename = opts.filename.slice(0, 240);
  // NOTA-DE-VOZ-1 · voice:true = burbuja de NOTA DE VOZ (onda + play + transcripción)
  // en vez de la tarjeta de archivo de audio. Exigencias de Meta (docs 2-sep-2026):
  // el fichero debe ser OGG con códec Opus y mono; el play solo aparece ≤512 KB.
  // El caller decide cuándo activarlo — aquí solo se transmite.
  if (kind === "audio" && opts.voice) ref.voice = true;
  const res = await fetch(`${BASE}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: kind, [kind]: ref }),
  });
  if (!res.ok) {
    const errTxt = await res.text();
    try {
      await dbInsertWaEvent({
        tenant_id: currentWorkspaceId(),
        phone_number_id: phoneId,
        direction: "out",
        msg_type: kind,
        status: "failed",
      });
    } catch { /* telemetría nunca tira el envío */ }
    throw new Error(`${kind} ${res.status}: ${errTxt.slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[] };
  const wamid = String(data?.messages?.[0]?.id || "").trim();
  if (!wamid) throw new Error(`${kind}: Meta aceptó la petición pero no devolvió un id de mensaje`);
  if (opts.out) opts.out.wamid = wamid;
  try {
    await dbUpsertWaMessageStatus({
      tenant_id: currentWorkspaceId(),
      phone_number_id: phoneId,
      message_id: wamid,
      user_id: to,
      msg_type: kind,
      status: "accepted",
    });
  } catch { /* idem */ }
}

// ---- Plantillas de marketing (HSM) — para escribir FUERA de la ventana de 24 h ----
// La app las crea y envía a aprobación por API: el usuario NUNCA toca Meta.

export interface WaTemplate {
  id?: string; // id de Meta — necesario para EDITAR la plantilla
  name: string;
  status: string; // APPROVED | PENDING | REJECTED | ...
  category?: string;
  language?: string;
  hasVar?: boolean; // body con {{1}} (personaliza con el nombre)
  body?: string; // texto real de la plantilla (para verlo en el panel)
  rejectedReason?: string; // por qué la rechazó Meta (solo si status=REJECTED)
  /** PLANTILLA-BANDEJA-1 · botones de la plantilla aprobada (etiqueta + URL si es de
   *  enlace). Meta los entrega al destinatario junto al body sin que sendTemplate
   *  tenga que mandarlos; se leen aquí para que la Bandeja enseñe el mensaje entero. */
  buttons?: { t: string; u?: string }[];
  /** PLANTILLA-CABECERA-1 · cabecera de la plantilla (IMAGE/VIDEO/DOCUMENT/TEXT). El medio
   *  concreto de una cabecera multimedia se adjunta EN CADA envío; sendTemplate lo
   *  resuelve solo con el apunte tpl.header.<nombre> que guarda el panel al crearla. */
  header?: { format: string; text?: string };
  /** PLANTILLA-META-1 · apunte local del panel (solo plantillas creadas desde aquí). */
  createdAt?: number;
  requestedCategory?: string;
  /** PLANTILLA-META-1 · lo que dice Meta: categoría anterior a su recategorización, y a
   *  cuál va a moverla. Meta NO publica fecha de alta de una plantilla. */
  previousCategory?: string;
  correctCategory?: string;
}

/** PLANTILLA-BANDEJA-1 · El texto REAL que recibió el cliente: el body de la
 *  plantilla con sus {{n}} sustituidos por los parámetros del envío. Si el body no
 *  se pudo leer del catálogo, se cae a la etiqueta antigua (nombre + parámetros)
 *  para no dejar el turno vacío. */
export function tplRenderText(tpl: WaTemplate, params: string[]): string {
  const body = String(tpl.body || "").trim();
  if (!body) return "🧩 Plantilla · " + tpl.name + (params.length ? " — " + params.join(" · ") : "");
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => {
    const v = params[Number(n) - 1];
    return v != null && String(v).trim() !== "" ? String(v) : m;
  });
}

/**
 * MEDIA-BANDEJA-1 · Descarga un adjunto entrante de WhatsApp. DOS saltos:
 *   1. GET /{mediaId} con Bearer → {url, mime_type}
 *   2. GET esa url TAMBIÉN con Bearer (aquí sí: la CDN de WhatsApp exige el token;
 *      por eso un <img> del navegador NUNCA podría cargarla directamente, y por eso
 *      re-hospedamos los bytes en vez de guardar el enlace).
 */
export async function downloadWaMedia(
  mediaId: string,
): Promise<{ data: Buffer; contentType: string } | { error: string }> {
  const { token } = creds();
  if (!token) return { error: "WhatsApp no conectado" };
  if (!mediaId) return { error: "el mensaje no traía id de media" };
  try {
    const meta = await fetch(`${BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!meta.ok) return { error: `WhatsApp devolvió ${meta.status} al pedir el media` };
    const d: any = await meta.json().catch(() => ({}));
    if (!d?.url) return { error: "WhatsApp no devolvió la URL del media" };
    const bin = await fetch(String(d.url), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12000),
    });
    if (!bin.ok) return { error: `la CDN de WhatsApp devolvió ${bin.status}` };
    const buf = Buffer.from(await bin.arrayBuffer());
    if (!buf.length) return { error: "WhatsApp devolvió un adjunto vacío" };
    if (buf.length > 16 * 1024 * 1024) return { error: "el adjunto supera los 16 MB" };
    return { data: buf, contentType: String(d.mime_type || bin.headers.get("content-type") || "application/octet-stream") };
  } catch (e) {
    return { error: (e as Error).message || "no se pudo descargar el adjunto" };
  }
}

/** ADJUNTO-REINTENTO-1 · Descarga el adjunto con el token del número que LO RECIBIÓ
 *  ('wa:<phone_number_id>'). downloadWaMedia a secas usa el número del contexto y, sin
 *  él, cae al principal: el webhook bajaba los adjuntos ANTES de fijar ese contexto, así
 *  que todo lo que llegaba a un número que no fuera el principal fallaba con «WhatsApp no
 *  conectado» y la Bandeja enseñaba el documento como perdido. */
export async function downloadWaMediaFor(
  mediaId: string,
  acct: string,
): Promise<{ data: Buffer; contentType: string } | { error: string }> {
  const pid = String(acct || "").replace(/^wa:/, "");
  const num = pid ? resolveWaNumber(pid) : null;
  if (num && num.token) return runWithWaNumber({ token: num.token, phoneId: num.phoneNumberId }, () => downloadWaMedia(mediaId));
  return downloadWaMedia(mediaId);
}

/** Ejemplos por nombre de variable (Meta exige un ejemplo por cada {{n}}). */
const TEMPLATE_VAR_EXAMPLES: Record<string, string> = {
  nombre: "María", name: "María",
  telefono: "+34600123123", "teléfono": "+34600123123", phone: "+34600123123", movil: "+34600123123", "móvil": "+34600123123",
  email: "maria@correo.com", correo: "maria@correo.com",
  fecha: "12 de marzo", hora: "18:00", enlace: "https://ejemplo.com", link: "https://ejemplo.com",
};

/** Convierte {{nombre}}, {{telefono}}… → {{1}},{{2}},… en orden de aparición.
 *  Devuelve el body numerado y el orden de las variables (para construir los ejemplos).
 *  RESERVA-WA-1 · un texto que ya viene numerado ({{1}}, {{2}}…) se respeta tal cual:
 *  antes la regex no veía los dígitos, la plantilla salía sin ejemplos y Meta la
 *  rechaza («el cuerpo tiene variables pero no hay ejemplo»). */
export function numberTemplateVars(text: string): { body: string; order: string[] } {
  const src = String(text || "");
  const nums = Array.from(src.matchAll(/\{\{\s*([a-zA-Z0-9áéíóúñ_]+)\s*\}\}/g)).map((m) => m[1]);
  if (nums.length && nums.every((k) => /^[0-9]+$/.test(k))) {
    const max = Math.max(...nums.map(Number));
    const body = src.replace(/\{\{\s*([0-9]+)\s*\}\}/g, "{{$1}}").slice(0, 1024).trim();
    return { body, order: Array.from({ length: max }, (_v, i) => String(i + 1)) };
  }
  const order: string[] = [];
  const body = src
    .replace(/\{\{\s*([a-zA-Záéíóúñ_]+)\s*\}\}/g, (_m, raw: string) => {
      const key = String(raw).toLowerCase();
      let idx = order.indexOf(key);
      if (idx < 0) { order.push(key); idx = order.length - 1; }
      return `{{${idx + 1}}}`;
    })
    .slice(0, 1024)
    .trim();
  return { body, order };
}

/** Normaliza un nombre de plantilla válido para Meta (minúsculas + _, <=60). */
export function templateNameFromText(seed: string): string {
  const base = (seed || "difusion")
    .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 44) || "difusion";
  return base;
}

/** Lista las plantillas de la WABA con su estado, su TEXTO y, si Meta la rechazó, el motivo. */
export async function listTemplates(): Promise<WaTemplate[]> {
  // PLANTILLAS-EDITOR-1 · El token global (`whatsapp.accessToken`) puede estar vacío cuando
  // los números viven en `whatsapp.numbers` (multi-número): la lista volvía VACÍA en silencio
  // y el editor de flujos marcaba «no válida» cualquier plantilla aprobada (15-sep-2026).
  // Mismo respaldo que el catálogo de Plantillas: el token del primer número conectado.
  const token = creds().token || listWaNumbers().find((n) => n.token)?.token || "";
  return listTemplatesForWaba(get("whatsapp.wabaId"), token);
}

/** T02e · Igual que listTemplates pero contra una WABA y token EXPLÍCITOS: cada
 *  número emisor lista las plantillas de SU cuenta, no de la guardada. */
export async function listTemplatesForWaba(wabaId: string, token: string): Promise<WaTemplate[]> {
  if (!token || !wabaId) return [];
  try { return await listTemplatesForWabaEstricto(wabaId, token); }
  catch (e) { console.error("[wa] listTemplates", (e as Error).message); return []; }
}
// PLANTILLAS-EDITOR-2 · vía ESTRICTA: LANZA cuando el catálogo no se pudo consultar (sin
// credenciales, Meta caída, token muerto, tiempo agotado) en vez de devolver []. Una promesa
// rechazada no entra en cachedUpstream, así que un fallo pasajero de Meta ya no se queda 5 min
// disfrazado de «0 plantillas aprobadas» en /flow-options, /wa-templates ni las difusiones: así
// fue como el editor de flujos marcó «no válida» una plantilla aprobada y dejó el desplegable
// vacío (15-sep-2026). `listTemplatesForWaba` (arriba) conserva el contrato tolerante para quien
// solo quiere «lo que haya». El tiempo máximo evita que una llamada colgada deje al editor sin
// catálogo indefinidamente.
export async function listTemplatesForWabaEstricto(wabaId: string, token: string): Promise<WaTemplate[]> {
  if (!token) throw new Error("sin token de acceso para consultar el catálogo de plantillas");
  if (!wabaId) throw new Error("sin cuenta de WhatsApp Business para consultar el catálogo de plantillas");
  // PLANTILLAS-1: pedimos también el motivo del rechazo. Sin él, una plantilla REJECTED se
  // quedaba en la lista sin decir por qué y no había forma de corregirla.
  // PLANTILLA-META-1: y previous_category/correct_category, que es como Meta cuenta que
  // RECATEGORIZÓ una plantilla al revisarla (pediste «aviso» y te la cobra como «promoción»).
  const BASE_FIELDS = "id,name,status,category,language,components,rejected_reason";
  const EXTRA_FIELDS = ",previous_category,correct_category";
  const pedir = (fields: string) =>
    fetch(`${BASE}/${wabaId}/message_templates?fields=${fields}&limit=200`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12_000) });
  let res = await pedir(BASE_FIELDS + EXTRA_FIELDS);
  if (!res.ok) {
    // Red de seguridad: si esta versión del Graph no conoce alguno de los campos nuevos
    // (error 100 «nonexisting field»), el catálogo NO puede quedarse vacío por eso.
    const txt = await res.clone().text().catch(() => "");
    if (/nonexisting field|previous_category|correct_category/i.test(txt)) {
      console.warn("[wa] listTemplates: el Graph no admite previous_category/correct_category, se piden los campos básicos");
      res = await pedir(BASE_FIELDS);
    }
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Meta respondió ${res.status} al pedir el catálogo de plantillas: ${txt.slice(0, 300)}`);
  }
  const d: any = await res.json();
  return (d.data || []).map((t: any) => {
    const comps: any[] = t.components || [];
    const bodyComp = comps.find((c) => String(c.type).toUpperCase() === "BODY");
    // PLANTILLA-BANDEJA-1 · Los botones de la plantilla (QUICK_REPLY/URL/PHONE): Meta
    // se los entrega al cliente junto al body, así que la Bandeja debe verlos también.
    const btnComp = comps.find((c) => String(c.type).toUpperCase() === "BUTTONS");
    const buttons = (Array.isArray(btnComp?.buttons) ? btnComp.buttons : [])
      .map((b: any) => ({ t: String(b?.text || "").trim(), ...(b?.url ? { u: String(b.url) } : {}) }))
      .filter((b: { t: string }) => b.t);
    // PLANTILLA-CABECERA-1 · la cabecera, para pintarla en el panel y para que editar
    // una plantilla no la borre en silencio (components es el conjunto completo).
    const headComp = comps.find((c) => String(c.type).toUpperCase() === "HEADER");
    const header = headComp
      ? { format: String(headComp.format || "TEXT").toUpperCase(), ...(headComp.text ? { text: String(headComp.text) } : {}) }
      : undefined;
    return {
      ...(header ? { header } : {}),
      id: t.id ? String(t.id) : "",
      name: t.name,
      status: t.status,
      category: t.category,
      language: t.language,
      hasVar: JSON.stringify(comps).includes("{{1}}"),
      // El cuerpo real, para que en el panel se vea QUÉ dice cada plantilla.
      body: String(bodyComp?.text || ""),
      buttons,
      // PLANTILLA-META-1 · lo que dice META de la recategorización: previous_category = la
      // categoría que tenía antes de que ella la cambiara; correct_category = a la que la va
      // a mover. Sirve también para plantillas creadas fuera del panel (sin apunte local).
      ...(t.previous_category ? { previousCategory: String(t.previous_category) } : {}),
      ...(t.correct_category ? { correctCategory: String(t.correct_category) } : {}),
      rejectedReason:
        t.status === "REJECTED" ? String(t.rejected_reason || "") : "",
    };
  });
}

/**
 * Crea una plantilla y la manda a aprobación. {{nombre}} → {{1}}.
 *
 * PLANTILLAS-1: la categoría ya no está clavada a MARKETING.
 *  - MARKETING: promociones, ofertas, invitaciones. Es la categoría CARA y la que
 *    Meta más rechaza.
 *  - UTILITY: seguimiento de algo que el usuario ya pidió (recordatorio de una cita
 *    a la que se apuntó, confirmación, estado de un pedido). Más barata y se aprueba
 *    con mucha más facilidad.
 * Mandar como MARKETING algo que es UTILITY = pagar de más y arriesgar rechazo.
 */
/**
 * Traduce el error de la Graph API a algo que un humano pueda accionar.
 *
 * `error.message` casi siempre es el genérico "Invalid parameter" (código 100): decírselo
 * al dueño tal cual es no decirle nada. El motivo real viaja en OTROS campos —
 * `error_user_msg`, `error_data.details`, el subcódigo— y hasta ahora los tirábamos.
 */
export function metaErrorText(d: any): string {
  const e = d?.error ?? {};
  const detail =
    e.error_user_msg ||
    e.error_data?.details ||
    (typeof e.error_data === "string" ? e.error_data : "") ||
    "";
  const title = e.error_user_title || "";
  const base = String(e.message || "Meta rechazó la petición");
  const code = [e.code, e.error_subcode].filter(Boolean).join("/");

  // Casos que sabemos traducir. El resto se muestra crudo, pero COMPLETO.
  const all = `${base} ${title} ${detail}`.toLowerCase();
  // 2388023/2388024: ya existe una plantilla con ese nombre (en ese idioma). Meta lo cuenta
  // como "Invalid parameter", que no le dice nada a nadie.
  const sub = String(e.error_subcode || "");
  if (all.includes("already exists") || all.includes("ya existe") || all.includes("ya hay contenido") || sub === "2388023" || sub === "2388024")
    return "Ya tienes una plantilla con ese nombre. Ponle otro nombre distinto, o borra la anterior de la lista de abajo.";
  if (all.includes("payment") || String(e.code) === "141006")
    return "Meta no deja crear plantillas porque la cuenta de WhatsApp no tiene método de pago válido. Ve a business.facebook.com → WhatsApp Manager → tu cuenta → Facturación.";
  if (all.includes("business verification") || all.includes("not verified"))
    return "Meta pide tener la verificación del negocio completada para crear plantillas.";

  // Lo que dice Meta en cristiano (si lo dice) + el mensaje técnico entre paréntesis, para
  // poder buscarlo. Nunca devolvemos solo "Invalid parameter": eso no le sirve a nadie.
  const human = [title, detail].filter(Boolean).join(" — ");
  const tech = `Meta: ${base}${code ? ` · código ${code}` : ""}`;
  return human ? `${human} (${tech})` : tech;
}

/**
 * T02 · Traduce el error de un ENVÍO rechazado por Meta a algo accionable, y lo
 * clasifica para que el caller distinga qué reintentar y qué no. Los códigos y
 * acciones vienen de la página oficial de error codes de Cloud API (2026):
 * 131047 re-engagement, 131049 límite marketing por usuario, 131026 no entregable,
 * 131056 pair rate limit, 131048 spam rate limit, 130472 grupo de control,
 * 132000/132001/132005/132007/132012/132015/132016/132018 plantillas.
 * Acepta el texto crudo del error (lo que lanza sendTemplate o devuelve res.text()).
 */
export type WaSendErrorKind = "ventana" | "limite" | "plantilla" | "permanente" | "temporal" | "auth";
export function translateWaSendError(raw: string): { text: string; kind: WaSendErrorKind } {
  const s = String(raw || "");
  const has = (code: string) => s.includes(code);
  // ALTA-SELFSERVE-1 · 133010 es el síntoma de que al número le falta el último paso
  // del alta (el registro en Cloud API). Sin traducir, el operador veía el código
  // crudo y se iba a buscar el fallo al token o a la plantilla, que están bien.
  if (has("133010"))
    return { kind: "permanente", text: "Ese número está dado de alta pero le falta activarse para poder enviar. Ve a Conexiones → WhatsApp → Diagnóstico y pulsa «Activarlo ahora» en ese número." };
  if (has("131047"))
    return { kind: "ventana", text: "Han pasado más de 24 h desde el último mensaje de esta persona a ese número: WhatsApp solo permite escribirle con una plantilla aprobada." };
  if (has("131049") || has("130429"))
    return { kind: "limite", text: "WhatsApp no lo ha entregado para no saturar al destinatario (límite de mensajes de marketing por usuario). Espera al menos 24 h antes de reintentar." };
  if (has("131056"))
    return { kind: "limite", text: "Demasiados mensajes seguidos a esta misma persona (límite de WhatsApp: ~1 cada 6 segundos). Espera un momento y reintenta." };
  if (has("131048"))
    return { kind: "limite", text: "WhatsApp ha limitado los envíos de este número por marcas de spam. Revisa la calidad del número en WhatsApp Manager." };
  if (has("131026"))
    return { kind: "permanente", text: "WhatsApp no puede entregar mensajes a ese número: puede que no tenga WhatsApp o que no haya aceptado los términos nuevos. Verifícalo con esa persona por otro canal." };
  if (has("130472"))
    return { kind: "permanente", text: "El destinatario está en un grupo de control de Meta (experimento de marketing): este mensaje no se le puede enviar." };
  if (has("132000") || has("132012") || has("132018"))
    // PLANTILLA-CABECERA-1 · estos códigos también saltan cuando falta o está mal el
    // MEDIO de la cabecera al enviar — el texto no puede hablar solo de variables.
    return { kind: "plantilla", text: "Los datos de la plantilla no encajan con lo aprobado: revisa las variables y, si la plantilla tiene cabecera con imagen o vídeo, que su archivo siga disponible. Si no cuadra, crea la plantilla de nuevo." };
  if (has("132001"))
    return { kind: "plantilla", text: "Esa plantilla no existe en la cuenta de WhatsApp del número emisor, o no está en ese idioma: crea una plantilla nueva o elige otra. Comprueba que la plantilla pertenezca a la WABA de ese número." };
  if (has("132015"))
    return { kind: "plantilla", text: "La plantilla está pausada por baja calidad: Meta no permite enviarla ahora mismo." };
  if (has("132016"))
    return { kind: "plantilla", text: "La plantilla fue deshabilitada definitivamente por Meta. Crea una plantilla nueva." };
  if (has("132005"))
    return { kind: "plantilla", text: "El texto final de la plantilla es demasiado largo para WhatsApp." };
  if (has("132007"))
    return { kind: "plantilla", text: "Meta considera que el contenido de la plantilla viola sus políticas de WhatsApp." };
  if (has("(#10)") || has("(#200)") || has("OAuthException") || has("Error validating access token") || has("\"code\":190"))
    return { kind: "auth", text: "Las credenciales de ese número ya no sirven (token caducado o permisos revocados). Reconecta el número en Conexiones." };
  if (has("\"code\":1,") || has("temporarily unavailable") || has("timed out") || has("fetch failed"))
    return { kind: "temporal", text: "Fallo temporal al hablar con WhatsApp. Reintenta en unos minutos." };
  return { kind: "permanente", text: `WhatsApp rechazó el envío: ${s.slice(0, 220)}` };
}

/** PLANTILLA-CABECERA-1 · Resumable Upload API (sesión → bytes → handle) para el EJEMPLO
 *  de una cabecera multimedia de plantilla. La doc oficial pide user token; en esta base
 *  el app token (appId|appSecret) ya funciona en producción para la foto de perfil, así
 *  que se intentan en orden los tokens recibidos y gana el primero que complete los dos
 *  saltos. El handle caduca pronto (~24 h): subir y crear la plantilla en la misma
 *  petición, nunca persistirlo. */
export async function uploadHeaderHandle(
  appId: string,
  buf: Buffer,
  mime: string,
  fileName: string,
  tokens: string[],
  // PASARELA-META-1 · el token de la app ya no viaja aquí: si lo hay, se sube por meta-app.
  conApp?: () => Promise<{ h?: string; error?: string }>,
): Promise<{ h?: string; error?: string }> {
  // El error de CADA credencial se conserva: solo enseñar el último ocultó durante horas
  // que el token del número (el que pide la doc) fallaba por un motivo distinto al #4.
  const errores: string[] = [];
  let idx = 0;
  for (const tk of tokens.filter(Boolean)) {
    idx++;
    const etiqueta = idx === 1 ? "token del número" : "token de la app";
    try {
      const sRes = await fetch(
        `${BASE}/${appId}/uploads?file_name=${encodeURIComponent(fileName)}&file_length=${buf.length}&file_type=${encodeURIComponent(mime)}&access_token=${encodeURIComponent(tk)}`,
        { method: "POST" },
      );
      const sJson = (await sRes.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
      if (!sRes.ok || !sJson.id) { errores.push(etiqueta + ": " + (sJson?.error?.message || `sesión de subida ${sRes.status}`)); continue; }
      const uRes = await fetch(`${BASE}/${sJson.id}`, {
        method: "POST",
        headers: { Authorization: `OAuth ${tk}`, file_offset: "0", "Content-Type": mime },
        body: buf as unknown as BodyInit,
      });
      const uJson = (await uRes.json().catch(() => ({}))) as { h?: string; error?: { message?: string } };
      if (!uRes.ok || !uJson.h) { errores.push(etiqueta + ": " + (uJson?.error?.message || `subida ${uRes.status}`)); continue; }
      return { h: uJson.h };
    } catch (e) { errores.push(etiqueta + ": " + (e as Error).message); }
  }
  if (conApp) {
    const r = await conApp();
    if (r.h) return r;
    errores.push("token de la app: " + (r.error || "sin respuesta"));
  }
  return { error: errores.join(" · ") || "no se pudo subir el medio de la cabecera" };
}

export async function createMarketingTemplate(
  name: string,
  bodyWithName: string,
  lang = "es",
  category: "MARKETING" | "UTILITY" = "MARKETING",
  // T02g · cuenta/token EXPLÍCITOS: crear la plantilla en la cuenta de un número
  // concreto (multi-WABA). Sin opts, el comportamiento de siempre.
  // PLANTILLA-BOTONES-1 · buttons: respuestas rápidas ({t}) y botones de enlace ({t,u});
  // Meta exige los quick-reply agrupados y admite hasta 2 de enlace.
  // PLANTILLA-CABECERA-1 · headerFormat+headerHandle: cabecera multimedia; el handle de
  // ejemplo lo sube el handler del panel con la Resumable Upload API antes de llamar aquí.
  // RESERVA-WA-1 · examples: el ejemplo de cada variable, en orden ({{1}}, {{2}}…). Meta
  // revisa la plantilla con ellos; sin ellos va el genérico por nombre o «ejemplo».
  opts?: { wabaId?: string; token?: string; buttons?: (string | { t: string; u?: string })[]; headerFormat?: "IMAGE" | "VIDEO" | "DOCUMENT"; headerHandle?: string; examples?: string[] },
): Promise<{ ok: boolean; status?: string; error?: string; hasVar: boolean }> {
  const token = opts?.token || creds().token;
  const wabaId = opts?.wabaId || get("whatsapp.wabaId");
  if (!token || !wabaId) return { ok: false, error: "WhatsApp no conectado (falta la WABA).", hasVar: false };
  // PLANTILLAS-2: variables MÚLTIPLES por nombre. Antes solo se convertía {{nombre}}→{{1}}
  // y se daba UN ejemplo; una plantilla con {{telefono}} dejaba esa variable literal y con
  // numeración inconsistente → Meta la rechazaba con INVALID_FORMAT (justo el caso del
  // aviso a un closer, que necesita nombre Y teléfono). Ahora se mapea cada nombre a
  // {{1}},{{2}},… EN ORDEN DE APARICIÓN, con TANTOS ejemplos como variables (Meta exige
  // que nº de ejemplos == nº de variables).
  const { body, order } = numberTemplateVars(bodyWithName);
  const hasVar = order.length > 0;
  if (!body) return { ok: false, error: "El mensaje está vacío.", hasVar };
  const bodyComp: Record<string, unknown> = { type: "BODY", text: body };
  if (hasVar) bodyComp.example = { body_text: [order.map((k, i) => String(opts?.examples?.[i] || "").trim() || TEMPLATE_VAR_EXAMPLES[k] || "ejemplo")] };
  // allow_category_change: si Meta cree que el mensaje NO es del tipo que has marcado,
  // lo recoloca en vez de rechazarlo. Sin esto, marcar "aviso" un texto que Meta lee como
  // promoción se salda con un rechazo y a esperar otra vez.
  // PLANTILLA-BOTONES-1 · el título de un botón de plantilla admite 25 caracteres (Meta).
  // Acepta strings (quick-reply, compat) y {t,u} (enlace). Quick-replies agrupados
  // primero; hasta 2 botones de enlace (límite Meta).
  const btnsIn = (opts?.buttons || []).map((x) =>
    typeof x === "string" ? { t: x, u: "" } : { t: String(x?.t || ""), u: String(x?.u || "").trim() });
  const btnsOk = btnsIn.map((b) => ({ t: b.t.trim().slice(0, 25), u: b.u })).filter((b) => b.t);
  const qrs = btnsOk.filter((b) => !b.u).slice(0, 3);
  const urls = btnsOk.filter((b) => !!b.u).slice(0, 2);
  const components: Record<string, unknown>[] = [];
  // PLANTILLA-CABECERA-1 · la cabecera multimedia necesita un handle de ejemplo para la
  // revisión de Meta. AUDIO no existe como cabecera de plantilla: es límite de WhatsApp.
  if (opts?.headerFormat && opts?.headerHandle)
    components.push({ type: "HEADER", format: opts.headerFormat, example: { header_handle: [opts.headerHandle] } });
  components.push(bodyComp);
  if (qrs.length || urls.length)
    components.push({ type: "BUTTONS", buttons: [
      ...qrs.map((b) => ({ type: "QUICK_REPLY", text: b.t })),
      ...urls.map((b) => ({ type: "URL", text: b.t, url: b.u })),
    ] });
  const payload = {
    name,
    language: lang,
    category,
    allow_category_change: true,
    components,
  };
  const res = await fetch(`${BASE}/${wabaId}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Traza completa para poder diagnosticar sin pedirle al dueño que repita la prueba.
    // Nunca el token; sí el cuerpo exacto que mandamos y el error íntegro de Meta.
    console.error(
      "[wa-template] Meta rechazó la creación:",
      JSON.stringify({ status: res.status, sent: payload, metaError: d?.error ?? d }),
    );
    return { ok: false, error: metaErrorText(d), hasVar };
  }
  return { ok: true, status: d.status || "PENDING", hasVar };
}

/** Borra una plantilla de la WABA por nombre (borra todos sus idiomas). */
/**
 * Edita una plantilla existente (por su id de Meta). Cambia el cuerpo y/o la categoría.
 * Reglas de Meta que conviene conocer (no las inventa este código, las impone la API):
 *  - No se puede editar una plantilla PENDING (aún en revisión). Sí APPROVED o REJECTED.
 *  - Al editar el contenido, vuelve a PENDING y Meta la revisa otra vez.
 *  - Hay límites (aprox. 1 edición/día y 10/mes por plantilla).
 * El {{nombre}} se normaliza a {{1}} igual que al crear, para que el panel hable en cristiano.
 */
export async function editTemplate(
  id: string,
  bodyWithName: string,
  category?: "MARKETING" | "UTILITY",
  tokenOverride?: string, // T02g · token del número de la cuenta dueña (multi-WABA)
  // PLANTILLA-BOTONES-1 · para Meta, `components` es el conjunto COMPLETO: editar solo el
  // BODY borraba en silencio los botones que la plantilla ya tenía. El llamante pasa los
  // botones (los actuales o los editados) y aquí se reconstruye el componente entero.
  buttons?: { t: string; u?: string }[],
  // PLANTILLA-CABECERA-1 · misma regla para la cabecera: si la plantilla la tiene, hay
  // que reconstruirla al editar (TEXT con su texto; multimedia con un handle fresco).
  header?: { format: string; text?: string; handle?: string },
): Promise<{ ok: boolean; error?: string; hasVar: boolean }> {
  const token = tokenOverride || creds().token;
  if (!token) return { ok: false, error: "WhatsApp no conectado.", hasVar: false };
  if (!id) return { ok: false, error: "Falta el identificador de la plantilla.", hasVar: false };
  const { body, order } = numberTemplateVars(bodyWithName); // PLANTILLAS-2: multi-variable
  const hasVar = order.length > 0;
  if (!body) return { ok: false, error: "El mensaje está vacío.", hasVar };
  const bodyComp: Record<string, unknown> = { type: "BODY", text: body };
  if (hasVar) bodyComp.example = { body_text: [order.map((k) => TEMPLATE_VAR_EXAMPLES[k] || "ejemplo")] };
  // PLANTILLA-BOTONES-1 · se respeta el orden recibido (Meta exige los quick-reply
  // agrupados; el orden de listTemplates ya viene agrupado de fábrica). Tope 10 (Meta).
  const btns = (buttons || [])
    .map((b) => ({ t: String(b?.t || "").trim().slice(0, 25), u: String(b?.u || "").trim() }))
    .filter((b) => b.t)
    .slice(0, 10);
  const components: Record<string, unknown>[] = [];
  if (header && header.format) {
    if (String(header.format).toUpperCase() === "TEXT" && header.text) components.push({ type: "HEADER", format: "TEXT", text: header.text });
    else if (header.handle) components.push({ type: "HEADER", format: String(header.format).toUpperCase(), example: { header_handle: [header.handle] } });
  }
  components.push(bodyComp);
  if (btns.length) components.push({ type: "BUTTONS", buttons: btns.map((b) => (b.u ? { type: "URL", text: b.t, url: b.u } : { type: "QUICK_REPLY", text: b.t })) });
  const payload: Record<string, unknown> = { components };
  if (category) payload.category = category;
  const res = await fetch(`${BASE}/${id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[wa-template] Meta rechazó la edición:", JSON.stringify({ status: res.status, sent: payload, metaError: d?.error ?? d }));
    return { ok: false, error: metaErrorText(d), hasVar };
  }
  return { ok: true, hasVar };
}

export async function deleteTemplate(
  name: string,
  hsmId?: string,
  opts?: { wabaId?: string; token?: string }, // T02g · cuenta explícita (multi-WABA)
): Promise<{ ok: boolean; error?: string }> {
  const token = opts?.token || creds().token;
  const wabaId = opts?.wabaId || get("whatsapp.wabaId");
  if (!token || !wabaId) return { ok: false, error: "WhatsApp no conectado (falta la WABA)." };
  // Con hsm_id borramos ESA versión concreta (idioma); sin él, todas las del nombre. Algunas
  // plantillas (p. ej. la demo hello_world en en_US) solo se dejan borrar dando el id.
  const qs = hsmId
    ? `hsm_id=${encodeURIComponent(hsmId)}&name=${encodeURIComponent(name)}`
    : `name=${encodeURIComponent(name)}`;
  const res = await fetch(`${BASE}/${wabaId}/message_templates?${qs}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: metaErrorText(d) };
  return { ok: true };
}

/** Envía un mensaje de plantilla aprobada (sirve dentro y FUERA de las 24 h).
 *  T02 · Ahora devuelve el wamid que asigna Meta (antes Promise<void>): los callers
 *  que lo ignoran siguen funcionando igual; Nueva conversación lo persiste en el turn. */
export async function sendTemplate(
  to: string,
  name: string,
  lang: string,
  bodyParams: string[] = [],
): Promise<{ wamid: string }> {
  const { token, phoneId } = creds();
  if (isQrNumber(phoneId)) throw new Error("Este número está vinculado por QR: escribe un mensaje normal. Las plantillas se envían con la conexión de Meta.");
  if (!token || !phoneId) throw new Error("WhatsApp no configurado");
  const components: Record<string, unknown>[] = bodyParams.length
    ? [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: String(t || "") })) }]
    : [];
  // PLANTILLA-CABECERA-1 · una plantilla con cabecera multimedia exige el medio EN CADA
  // envío. El panel guarda al crearla el apunte tpl.header.<nombre> = {kind,url} (URL
  // pública estable del almacén de medios); resolverlo aquí dentro evita cambiar los
  // ocho puntos del código que llaman a sendTemplate. Sin apunte, envío de siempre.
  try {
    const hRaw = get("tpl.header." + name);
    if (hRaw) {
      const h = JSON.parse(hRaw) as { kind?: string; url?: string };
      const k = h?.kind === "image" ? "image" : h?.kind === "video" ? "video" : h?.kind === "document" ? "document" : "";
      if (k && h?.url) components.unshift({ type: "header", parameters: [{ type: k, [k]: { link: h.url } }] });
    }
  } catch { /* apunte corrupto: la plantilla sale sin cabecera adjunta */ }
  const res = await fetch(`${BASE}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name, language: { code: lang || "es" }, components },
    }),
  });
  if (!res.ok) {
    const errTxt = await res.text();
    // FASE-5: telemetría — Meta rechazó la plantilla (HSM) outbound.
    // NO logueamos token; el `to` se ofusca; los bodyParams quedan a metade.
    await logActivity({
      source: "wa-send",
      level: "error",
      status: String(res.status),
      summary: `WhatsApp sendTemplate '${name}' falló ${res.status}: ${errTxt.slice(0, 160)}`,
      payload: {
        file: "whatsapp.ts",
        fn: "sendTemplate",
        phoneId,
        to: to.slice(0, 4) + "***" + to.slice(-3),
        template: name,
        lang: lang || "es",
        bodyParamsCount: bodyParams.length,
        httpStatus: res.status,
        error: errTxt.slice(0, 400),
      },
    });
    // metricas-pro M3: envío de plantilla rechazado → fila template + failed
    // para que la "calidad por plantilla" muestre el % real de fallos.
    try {
      await dbInsertWaEvent({
        tenant_id: currentWorkspaceId(),
        phone_number_id: phoneId,
        direction: "out",
        msg_type: "template",
        status: "failed",
        template_name: name,
      });
    } catch { /* idem */ }
    throw new Error(`template ${res.status}: ${errTxt}`);
  }
  // T02 · wamid del 200 de Meta (messages[0].id). Accesorio: si el JSON no se
  // puede leer, el envío sigue contando como aceptado y se devuelve ''.
  let wamid = "";
  try {
    const dOk: any = await res.json();
    wamid = String(dOk?.messages?.[0]?.id || "");
  } catch { /* body ilegible: wamid vacío */ }
  // ENTREGA-WA-1 · el envío y sus confirmaciones son UNA fila, por el id del mensaje: así
  // la entrega/lectura/fallo que llega luego por webhook queda atribuida a la plantilla.
  // Antes se guardaba aparte una fila «sent» sin id y la entrega nunca se le asignaba.
  try {
    if (wamid) await dbUpsertWaMessageStatus({ tenant_id: currentWorkspaceId(), phone_number_id: phoneId, message_id: wamid, user_id: to, msg_type: "template", status: "accepted", template_name: name });
    else await dbInsertWaEvent({ tenant_id: currentWorkspaceId(), phone_number_id: phoneId, direction: "out", msg_type: "template", status: "accepted", template_name: name });
  } catch { /* idem */ }
  return { wamid };
}

/** Difusión con throttling (evita rate limits). Devuelve cuántos OK/fallo. */
export async function sendBroadcast(
  phones: string[],
  body: string,
  delayMs = 900,
  linkCtx?: ShortenCtx,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const p of phones) {
    try {
      // En broadcast el contact se busca por phone para resolver vars.
      await sendText(p, body, { linkCtx: linkCtx ?? { kind: "broadcast", phone: p } });
      sent++;
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { sent, failed };
}

export async function markRead(messageId: string): Promise<void> {
  const { token, phoneId } = creds();
  if (!token || !phoneId) return;
  await fetch(`${BASE}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    }),
  }).catch(() => {});
}

/** Verifica la firma HMAC del webhook (X-Hub-Signature-256). */
/**
 * FIRMA-META-1 · Prueba VARIOS secretos y devuelve el NOMBRE del que acertó (null si
 * ninguno). Devuelve el nombre, no el valor, para poder dejar constancia en el
 * diagnóstico de cuál sirve sin escribir jamás un secreto en un log.
 *
 * Por qué hace falta: la misma cuenta de Meta puede entregar eventos firmados con el
 * secreto de OTRA app (el panel, por ejemplo, ya lee META_APP_SECRET y FB_APP_SECRET,
 * pero la verificación solo miraba IG_APP_SECRET). Un secreto que YA está en el entorno
 * se estaba ignorando y sus eventos se tiraban por "firma inválida".
 *
 * No debilita nada: cada candidato sigue exigiendo una firma HMAC válida. Probar N
 * secretos PROPIOS no acerca a un atacante a falsificar ninguno.
 */
export function verifySignatureAny(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  candidates: Array<[string, string]>,
): string | null {
  if (!signatureHeader) return null;
  const seen = new Set<string>();
  for (const [name, secret] of candidates) {
    if (!secret || seen.has(secret)) continue;
    seen.add(secret);
    if (verifySignature(rawBody, signatureHeader, secret)) return name;
  }
  return null;
}

export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!appSecret) {
    console.warn("[verifySignature] appSecret vacío, rechazando webhook (fail-closed)");
    return false;
  }
  if (!signatureHeader) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}
