/**
 * Cliente Instagram (Graph + Messaging API). Cubre el mecanismo ManyChat:
 *  - responder públicamente a un comentario
 *  - abrir DM con quien comentó (private reply por comment_id) con texto
 *    o botón con enlace
 *  - publicar foto / reel (para el publicador programado)
 *
 * Permisos del token: instagram_basic, instagram_manage_comments,
 * instagram_manage_messages, instagram_content_publish, pages_show_list.
 * Producción real (fuera de usuarios de prueba) exige App Review.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { get } from "./settings.js";
import { getFbAccountByIgId } from "./facebook.js";
import { logActivity } from "./activity.js";
import { downloadPublic } from "./public-download.js";
import type { ChatMessage } from "./llm.js";

const BASE = "https://graph.facebook.com/v21.0";

export type IgCreds = { token: string; igId: string };

/** Cuenta IG activa para el flujo en curso (multi-cuenta). */
const acctALS = new AsyncLocalStorage<IgCreds>();

function creds(): IgCreds {
  const s = acctALS.getStore();
  if (s && s.token && s.igId) return s;
  return { token: get("meta.igAccessToken"), igId: get("meta.igBusinessId") };
}

/** Credenciales de la cuenta IG activa (ALS de la request, o la principal). Lo usa
 *  metrics.ts para que las métricas respeten la cuenta seleccionada (multi-cuenta). */
export function activeIgCreds(): IgCreds {
  return creds();
}

export interface IgAccount {
  igId: string;
  label: string;
  token: string;
}

/** Registro de cuentas: la principal (settings) + las extra (meta.accounts JSON). */
export function listIgAccounts(): IgAccount[] {
  const out: IgAccount[] = [];
  const pid = get("meta.igBusinessId");
  const ptok = get("meta.igAccessToken");
  if (pid && ptok)
    out.push({ igId: pid, label: get("meta.igLabel") || "Principal", token: ptok });
  try {
    for (const a of JSON.parse(get("meta.accounts") || "[]")) {
      if (a?.igId && a?.token && !out.some((x) => x.igId === String(a.igId)))
        out.push({ igId: String(a.igId), label: a.label || String(a.igId), token: a.token });
    }
  } catch {
    /* meta.accounts mal formado → se ignora */
  }
  return out;
}

/** Resuelve credenciales por id de cuenta IG (el entry.id del webhook). */
export function resolveAccount(igId: string): IgCreds | null {
  const a = listIgAccounts().find((x) => x.igId === igId);
  return a ? { token: a.token, igId: a.igId } : null;
}

/** Ejecuta fn con esa cuenta como contexto activo (las llamadas IG la usan). */
export function runWithAccount<T>(c: IgCreds, fn: () => Promise<T>): Promise<T> {
  return acctALS.run(c, fn);
}

async function graph(path: string, init?: RequestInit): Promise<any> {
  const { token } = creds();
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}/${path}${sep}access_token=${token}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`IG Graph ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ============================================================
// Mensajería IG (Messenger Platform for Instagram).
// CLAVE: enviar DMs requiere POST /{PAGE-ID}/messages con el PAGE ACCESS
// TOKEN — NO /{ig-id}/messages ni el system-user token (eso da error #3
// "Application does not have the capability"). Resolvemos la Página conectada
// al IG y derivamos su token desde el token de cuenta (system user / IG).
// Cacheado 1h (los page tokens de system user no caducan; refresco por si rota).
// ============================================================
const pageCredsCache = new Map<string, { pageId: string; pageToken: string; at: number }>();
const PAGE_CREDS_TTL = 60 * 60 * 1000;

async function resolvePageCreds(igId: string, accountToken: string): Promise<{ pageId: string; pageToken: string }> {
  // Clave compuesta igId+token: el mismo igId conectado en dos workspaces (con
  // tokens distintos) no debe compartir credenciales cacheadas.
  const cacheKey = igId + "|" + accountToken.slice(-16);
  const cached = pageCredsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PAGE_CREDS_TTL)
    return { pageId: cached.pageId, pageToken: cached.pageToken };
  let found: { pageId: string; pageToken: string } | null = null;
  // 0) Fast path: si conectamos la Page via OAuth FB, ya tenemos el mapeo
  //    igBusinessAccountId → Page guardado en meta.fbAccounts. Usamos eso primero
  //    (sin red, sin depender de que el IG token tenga pages_show_list).
  try {
    const fb = getFbAccountByIgId(igId);
    if (fb && fb.token) {
      found = { pageId: fb.pageId, pageToken: fb.token };
    }
  } catch { /* fallback abajo */ }
  // 1) Si no había mapeo guardado, lista las páginas del token IG.
  if (!found) {
    try {
      const r = await fetch(`${BASE}/me/accounts?fields=id,access_token,instagram_business_account{id}&access_token=${accountToken}`);
      const d = await r.json().catch(() => ({}));
      for (const p of d?.data ?? []) {
        if (p?.instagram_business_account?.id === igId && p?.access_token) {
          found = { pageId: String(p.id), pageToken: String(p.access_token) };
          break;
        }
      }
      // 2) Fallback: el expand de instagram_business_account a veces no llega en
      //    /me/accounts; consulta cada página directa para hallar el vínculo + token.
      if (!found) {
        for (const p of d?.data ?? []) {
          try {
            const pr = await fetch(`${BASE}/${p.id}?fields=instagram_business_account{id},access_token&access_token=${accountToken}`);
            const pd = await pr.json().catch(() => ({}));
            if (pd?.instagram_business_account?.id === igId && pd?.access_token) {
              found = { pageId: String(p.id), pageToken: String(pd.access_token) };
              break;
            }
          } catch { /* siguiente página */ }
        }
      }
    } catch { /* red/permiso → cae al error de abajo */ }
  }
  if (!found)
    throw new Error(`No se encontró la Página de Facebook conectada al Instagram ${igId} (necesaria para enviar DMs). Reconecta Facebook en Conexiones para que registremos el mapeo Page→IG.`);
  pageCredsCache.set(cacheKey, { ...found, at: Date.now() });
  return found;
}

/** Envía un mensaje IG vía la Página (POST /{pageId}/messages con page token). */
async function pageSendMessage(payload: Record<string, unknown>): Promise<void> {
  const { igId, token } = creds();
  const { pageId, pageToken } = await resolvePageCreds(igId, token);
  const res = await fetch(`${BASE}/${pageId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, access_token: pageToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`IG send ${res.status}: ${JSON.stringify(data)}`);
}

// NOTIF-COMENTARIO-ENLACE-1 · enlace directo a un comentario de Instagram para la campana:
// permalink del post + «c/<id>/», que abre el post con ese comentario delante. El permalink
// se pide una vez por publicación (caché 24 h) y con tope de 4 s: si falla, la notificación
// sale igual, sin enlace. Usa la cuenta activa (runWithAccount del webhook).
const permalinkCache = new Map<string, { url: string; at: number }>();
export async function igCommentLink(mediaId: string, commentId: string): Promise<string> {
  if (!mediaId || mediaId === "any") return "";
  const k = creds().igId + "|" + mediaId;
  let url = "";
  const c = permalinkCache.get(k);
  if (c && Date.now() - c.at < 24 * 3600_000) url = c.url;
  else {
    try {
      const d = await Promise.race([
        graph(`${encodeURIComponent(mediaId)}?fields=permalink`),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
      ]);
      url = /^https:\/\/(www\.)?instagram\.com\//.test(String(d?.permalink || "")) ? String(d.permalink) : "";
    } catch { url = ""; }
    if (url) {
      if (permalinkCache.size > 500) permalinkCache.clear();
      permalinkCache.set(k, { url, at: Date.now() });
    }
  }
  if (!url) return "";
  return url.replace(/\/?$/, "/") + (commentId && /^\d+$/.test(commentId) ? "c/" + commentId + "/" : "");
}

/** SOLO LECTURA · Busca el comentario de un @usuario en un post y devuelve las
 *  respuestas que cuelgan de él (para verificar qué texto/emoji le respondimos). */
export async function fetchUserCommentReplies(mediaId: string, username: string): Promise<{
  found: boolean;
  comment?: string;
  replies: Array<{ de: string; texto: string }>;
}> {
  const target = username.replace(/^@/, "").toLowerCase();
  let after = "";
  for (let guard = 0; guard < 60; guard++) {
    const d = await graph(
      `${mediaId}/comments?fields=id,username,text,replies{id,username,text}&limit=50` + (after ? `&after=${encodeURIComponent(after)}` : ""),
    );
    for (const c of d?.data ?? []) {
      if (String(c.username || "").toLowerCase() === target) {
        return {
          found: true,
          comment: String(c.text || ""),
          replies: (c.replies?.data ?? []).map((r: any) => ({ de: "@" + (r.username || ""), texto: String(r.text || "") })),
        };
      }
    }
    after = d?.paging?.cursors?.after || "";
    if (!after || !(d?.data?.length)) break;
  }
  return { found: false, replies: [] };
}

/** El @usuario de una cuenta IG (para reconocer/excluir sus propios comentarios). */
export async function fetchAllCommentsSelf(igId: string): Promise<string> {
  const d = await graph(`${igId}?fields=username`);
  return String(d?.username || "");
}

/** COMENTARIO-FIJADO-1 · Comentario de nivel superior en una publicación propia (primer comentario). */
export async function commentOnMedia(mediaId: string, message: string): Promise<void> {
  await graph(`${mediaId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

/** Respuesta pública a un comentario. */
export async function replyToComment(commentId: string, message: string): Promise<void> {
  await graph(`${commentId}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

/**
 * Abre un DM con quien comentó (private reply). Si hay link+botón, manda
 * plantilla de botón; si no, texto plano. Solo se permite 1 private reply
 * por comentario y dentro de la ventana de Meta.
 */
export async function sendDmFromComment(opts: {
  commentId: string;
  text: string;
  link?: string;
  buttonText?: string;
}): Promise<void> {
  const message =
    opts.link && opts.buttonText
      ? {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              // Nunca vacío: Meta rechaza una plantilla de botón con texto "" y un paso
              // que solo lleva enlace (sin texto) es perfectamente creable en el editor.
              text: (opts.text || "👇").slice(0, 640),
              buttons: [
                { type: "web_url", url: opts.link, title: opts.buttonText.slice(0, 20) },
              ],
            },
          },
        }
      : { text: opts.link ? `${opts.text}\n\n${opts.link}` : opts.text };

  await pageSendMessage({ recipient: { comment_id: opts.commentId }, message });
}

/**
 * ENLACE-BOTON-1 · Envía un DM con el enlace dentro de un BOTÓN, no en el texto.
 *
 * POR QUÉ EXISTE: Instagram puede restringir el envío de enlaces de una cuenta
 * ("Link can't be shared · your activity may not follow our Community Standards").
 * Con esa restricción, un DM que lleve una URL EN EL TEXTO se rechaza con un 400 y el
 * paso del flujo no llega — pero la misma URL dentro de un botón (adjunto de tipo
 * plantilla) sí pasa. Es como lo hace ManyChat.
 *
 * `sendDmFromComment` ya lo hacía para la ÚNICA respuesta privada permitida por
 * comentario; esto lo trae a los DMs normales, que es donde se entregan el resto de
 * pasos del flujo (y donde estaba el agujero).
 *
 * Devuelve false si Meta lo rechaza, para que quien llame pueda reaccionar en vez de
 * dar el paso por entregado.
 */
export async function sendIgLinkButton(
  recipientId: string,
  text: string,
  url: string,
  buttonText = "Abrir enlace",
  opts: { humanAgent?: boolean } = {},
): Promise<boolean> {
  try {
    await pageSendMessage({
      recipient: { id: recipientId },
      // humanAgent: respuesta MANUAL desde el panel fuera de la ventana de 24h
      // (regla del owner 2026-08-15: los enlaces por DM van SIEMPRE en botón,
      // nunca en texto plano — Instagram penaliza los enlaces crudos).
      ...(opts.humanAgent ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : { messaging_type: "RESPONSE" }),
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: (text || "👇").slice(0, 640),
            buttons: [{ type: "web_url", url, title: (buttonText || "Abrir enlace").slice(0, 20) }],
          },
        },
      },
    });
    return true;
  } catch (e) {
    const msg = (e as Error).message || "";
    await logActivity({
      source: "ig-send",
      level: "error",
      summary: "No se pudo enviar el enlace en un botón: " + msg.slice(0, 140),
      payload: {
        file: "instagram.ts",
        fn: "sendIgLinkButton",
        recipientId: recipientId.slice(0, 4) + "***" + recipientId.slice(-3),
        url,
        error: msg.slice(0, 400),
        hint: /Link can't be shared|Community Standards/i.test(msg)
          ? "Instagram tiene restringido el envío de enlaces en esta cuenta. Revisa Configuración → Estado de la cuenta en Instagram."
          : "",
      },
    }).catch(() => { /* la telemetría nunca rompe el envío */ });
    return false;
  }
}

/** Lista las publicaciones/reels recientes (para elegir el post concreto). */
/**
 * DRIP-1 · Enumera los comentarios HISTÓRICOS de la cuenta: recorre las publicaciones y,
 * de cada una, sus comentarios (id, autor, texto, fecha). Es la base del goteo de
 * respuestas — sin esto no tenemos los comment_id a los que responder (el webhook solo
 * nos da los comentarios EN VIVO, no los viejos).
 *
 * SOLO LECTURA. Pagina con tope de seguridad para no barrer indefinidamente. Devuelve
 * también cuántas páginas/publicaciones miró, para que el diagnóstico sea honesto.
 */
export async function fetchAllComments(opts: { maxMedia?: number; maxPerMedia?: number; mediaId?: string; includeReplies?: boolean; withFrom?: boolean } = {}): Promise<{
  comments: Array<{ commentId: string; mediaId: string; username: string; text: string; ts: number; userId?: string }>;
  mediaVistas: number;
  error?: string;
}> {
  const maxMedia = opts.maxMedia ?? 60;
  const maxPerMedia = opts.maxPerMedia ?? 2000;
  // withFrom: además del @usuario, pide el IGSID del autor (from{id}) — lo necesita el
  // BACKFILL para reanudar el flujo (el run se indexa por IGSID). Es un campo aparte:
  // el barrido normal (goteo) no lo pide para no cambiar su comportamiento probado.
  const withFrom = opts.withFrom === true;
  const out: Array<{ commentId: string; mediaId: string; username: string; text: string; ts: number; userId?: string }> = [];
  let mediaVistas = 0;
  try {
    // Si se pasa una publicación concreta, solo esa (el caso del goteo, que va a UN post).
    const mediaIds: string[] = [];
    // Paginación por CURSOR (paging.cursors.after). Antes reconstruía la URL de
    // `paging.next` a mano y se rompía tras la 1ª página (dejaba 32 de 2233). El cursor
    // es lo robusto: se añade &after=<cursor> a la MISMA URL base.
    const pageAll = async (base: (after: string) => string, onItem: (it: any) => void, maxItems: number): Promise<void> => {
      let after = "";
      for (let guard = 0; guard < 400; guard++) {
        const d = await graph(base(after));
        const data = (d?.data ?? []) as any[];
        for (const it of data) onItem(it);
        after = d?.paging?.cursors?.after || "";
        if (!after || !data.length) break;
        if (guard * 50 >= maxItems) break;
      }
    };

    if (opts.mediaId) {
      mediaIds.push(String(opts.mediaId));
    } else {
      const { igId } = creds();
      await pageAll(
        (a) => `${igId}/media?fields=id&limit=50` + (a ? `&after=${encodeURIComponent(a)}` : ""),
        (m) => { if (m?.id) mediaIds.push(String(m.id)); },
        maxMedia,
      );
    }

    // Comentarios de cada publicación. Cada una en su try: si el campo `username` falla
    // (comentarios sin autor accesible por privacidad → "(#100) nonexisting field"), se
    // reintenta ESA publicación con `from{username}` en vez de abortar el barrido.
    let ultimoError = "";
    for (const mediaId of mediaIds.slice(0, maxMedia)) {
      mediaVistas++;
      const push = (c: any, uname: string, fromId?: string) => {
        if (!c?.id) return;
        out.push({ commentId: String(c.id), mediaId, username: String(uname || ""), text: String(c.text || ""), ts: Date.parse(c.timestamp || "") || 0, userId: String(fromId || c?.from?.id || "") });
      };
      // RESPUESTAS ANIDADAS en la MISMA llamada (replies{...}). Antes hacía una llamada
      // extra por cada comentario para traer sus respuestas → cientos de llamadas y
      // timeout, y encima solo miraba el 1er nivel cuando fallaba. Ahora Meta las
      // devuelve inline: cada comentario trae sus respuestas de una vez. En un post de
      // 2233 comentarios eso incluye a la gente que solo comentó DENTRO de un hilo.
      const wantReplies = opts.includeReplies === true;
      const fromSpec = withFrom ? ",from{id,username}" : "";
      const repliesSpec = wantReplies ? `,replies{id,username,text,timestamp${fromSpec}}` : "";
      const takeAll = (c: any) => {
        push(c, c.username, c?.from?.id);
        for (const r of c?.replies?.data ?? []) push(r, r.username, r?.from?.id);
      };
      try {
        await pageAll(
          (a) => `${mediaId}/comments?fields=id,username,text,timestamp${fromSpec}${repliesSpec}&limit=50` + (a ? `&after=${encodeURIComponent(a)}` : ""),
          takeAll,
          maxPerMedia,
        );
      } catch (e) {
        ultimoError = (e as Error).message;
        try {
          await pageAll(
            (a) => `${mediaId}/comments?fields=id,text,timestamp,from{id,username}${wantReplies ? ",replies{id,from{id,username},text,timestamp}" : ""}&limit=50` + (a ? `&after=${encodeURIComponent(a)}` : ""),
            (c) => { push(c, c.from?.username, c?.from?.id); for (const r of c?.replies?.data ?? []) push(r, r.from?.username, r?.from?.id); },
            maxPerMedia,
          );
        } catch { /* esta publicación no se puede leer: se salta */ }
      }
    }
    return { comments: out, mediaVistas, error: ultimoError || undefined };
  } catch (e) {
    return { comments: out, mediaVistas, error: (e as Error).message };
  }
}

export async function listMedia(limit = 25): Promise<
  {
    id: string;
    caption: string;
    type: string;
    thumb: string;
    permalink: string;
    timestamp: string;
  }[]
> {
  // IG-MEDIA-PAGINAR-1 · Meta corta cada página (≈25-30) aunque pidas más: sin seguir
  // el cursor, una cuenta que publica a diario solo ofrecía ~6 días en el selector del
  // flujo y los posts más viejos no se podían asignar → sus comentarios no entraban en
  // ninguna automatización (DeZfbp0MCRZ y DebDInhMdEi, 20-oct-2026).
  const { igId } = creds();
  const out: any[] = [];
  let after = "";
  for (let i = 0; i < 10 && out.length < limit; i++) {
    const d = await graph(
      `${igId}/media?fields=${MEDIA_FIELDS}&limit=${Math.min(50, limit - out.length)}` + (after ? `&after=${encodeURIComponent(after)}` : ""),
    );
    const data = (d?.data ?? []) as any[];
    out.push(...data);
    after = d?.paging?.cursors?.after || "";
    if (!after || !data.length || !d?.paging?.next) break;
  }
  return out.slice(0, limit).map(mapMedia);
}

const MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,children{media_url,thumbnail_url,media_type}";

function mapMedia(m: any) {
  // IMAGE→media_url, VIDEO/REEL→thumbnail_url, CAROUSEL→1ª hija con imagen.
  let thumb = m.thumbnail_url || "";
  if (!thumb && m.media_type === "IMAGE") thumb = m.media_url || "";
  if (!thumb && m.children?.data?.length) {
    const c = m.children.data.find(
      (x: any) => x.thumbnail_url || x.media_url,
    );
    thumb = c?.thumbnail_url || c?.media_url || "";
  }
  return {
    id: String(m.id),
    caption: (m.caption || "").replace(/\s+/g, " ").slice(0, 120),
    type:
      m.media_product_type === "REELS"
        ? "REEL"
        : m.media_type || "POST",
    thumb: String(thumb),
    permalink: m.permalink || "",
    timestamp: m.timestamp || "",
  };
}

/** MEDIA-SNAP-1 · UNA publicación por su id (sin paginar la galería): sirve para posts
 *  viejos que ya no caben en listMedia(). Lanza si la red no lo devuelve (borrado, o
 *  historia caducada). */
export async function getMedia(mediaId: string) {
  const d = await graph(`${encodeURIComponent(mediaId)}?fields=${MEDIA_FIELDS}`);
  if (!d?.id) throw new Error("IG: sin datos para " + mediaId);
  return mapMedia(d);
}

/** REEL-PRUEBA-1 · La publicación a la que pertenece un comentario. Un reel de prueba que
 *  luego pasa a normal NO sale en /media, pero sus comentarios sí llegan: desde uno de
 *  ellos se recupera el reel para poder asignarle un flujo. */
export async function getMediaDeComentario(commentId: string) {
  const d = await graph(`${encodeURIComponent(commentId)}?fields=media{${MEDIA_FIELDS}}`);
  if (!d?.media?.id) throw new Error("IG: el comentario " + commentId + " no trae publicación");
  return mapMedia(d.media);
}

/** Historias activas (últimas 24h) para seleccionarlas en una automatización. */
export async function listStories(): Promise<
  { id: string; caption: string; type: string; thumb: string; permalink: string; timestamp: string }[]
> {
  const { igId } = creds();
  const d = await graph(
    `${igId}/stories?fields=id,media_type,media_url,thumbnail_url,timestamp,permalink&limit=30`,
  );
  return (d.data ?? []).map((m: any) => ({
    id: m.id,
    caption: "Historia",
    type: "STORY",
    thumb: m.thumbnail_url || m.media_url || "",
    permalink: m.permalink || "",
    timestamp: m.timestamp || "",
  }));
}

/** REACCIONES-2 · Reacciona (o retira la reacción) a un mensaje del hilo de DMs.
 *  Meta solo admite `reaction:"love"` al ENVIAR (el ❤️ de la app); `emoji:''`
 *  retira. Sale por la Página como cualquier DM (POST /{page-id}/messages con
 *  `sender_action`). Meta NO devuelve eco de nuestras reacciones: quien llama
 *  debe registrarla en BD al momento. Lanza si Meta la rechaza. */
export async function sendIgReaction(recipientId: string, messageId: string, emoji: string): Promise<void> {
  try {
    await pageSendMessage({
      recipient: { id: recipientId },
      sender_action: emoji ? "react" : "unreact",
      payload: { message_id: messageId, ...(emoji ? { reaction: "love" } : {}) },
    });
  } catch (e) {
    await logActivity({
      source: "ig-send",
      level: "error",
      status: "error",
      summary: `Instagram sendIgReaction falló: ${(e as Error).message.slice(0, 160)}`,
      payload: {
        file: "instagram.ts",
        fn: "sendIgReaction",
        igId: creds().igId,
        recipientId: recipientId.slice(0, 4) + "***" + recipientId.slice(-3),
        remove: !emoji,
        error: (e as Error).message.slice(0, 400),
      },
    });
    throw e;
  }
}

/** Envía un DM por IGSID (conversación multivuelta tras el primer contacto).
 *  Con `humanAgent:true` usa la etiqueta HUMAN_AGENT, que permite a un agente
 *  humano responder hasta 7 días después del último mensaje del cliente (fuera
 *  de la ventana estándar de 24h). Úsalo SOLO cuando responde una persona. */
export async function sendIgText(recipientId: string, text: string, opts: { humanAgent?: boolean; replyToMid?: string } = {}): Promise<void> {
  try {
    const base = {
      recipient: { id: recipientId },
      ...(opts.humanAgent
        ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
        : { messaging_type: "RESPONSE" }),
    };
    // CITA-1 · Instagram admite responder citando (reply_to.mid) en la mayoría de
    // hilos, pero no en todos (mensajes viejos, ecos, algunos tipos). Si Meta lo
    // rechaza NO perdemos el mensaje: se reenvía sin la cita.
    if (opts.replyToMid) {
      try {
        await pageSendMessage({ ...base, message: { text }, reply_to: { mid: opts.replyToMid } });
        return;
      } catch { /* sigue abajo, sin cita */ }
    }
    await pageSendMessage({ ...base, message: { text } });
  } catch (e) {
    // FASE-5: telemetría — Meta rechazó DM IG (token/permiso/ventana 24h…).
    // NO logueamos token; el recipientId IGSID se ofusca; text se trunca.
    await logActivity({
      source: "ig-send",
      level: "error",
      status: "error",
      summary: `Instagram sendIgText falló: ${(e as Error).message.slice(0, 160)}`,
      payload: {
        file: "instagram.ts",
        fn: "sendIgText",
        igId: creds().igId,
        recipientId: recipientId.slice(0, 4) + "***" + recipientId.slice(-3),
        humanAgent: !!opts.humanAgent,
        textPreview: String(text || "").slice(0, 80),
        error: (e as Error).message.slice(0, 400),
      },
    });
    throw e;
  }
}

/**
 * Envía un adjunto (image/video/audio) por URL pública vía la Página. Instagram NO
 * soporta subida por attachment_id, así que la URL debe ser accesible por Meta (el
 * panel la sirve desde una ruta pública efímera). Con `humanAgent:true` usa la
 * etiqueta HUMAN_AGENT (responde una persona fuera de la ventana estándar de 24h).
 */
export async function sendIgMedia(
  recipientId: string,
  type: "image" | "video" | "audio",
  url: string,
  opts: { humanAgent?: boolean } = {},
): Promise<void> {
  try {
    await pageSendMessage({
      recipient: { id: recipientId },
      message: { attachment: { type, payload: { url, is_reusable: false } } },
      ...(opts.humanAgent ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : { messaging_type: "RESPONSE" }),
    });
  } catch (e) {
    await logActivity({
      source: "ig-send",
      level: "error",
      status: "error",
      summary: `Instagram sendIgMedia falló: ${(e as Error).message.slice(0, 160)}`,
      payload: {
        file: "instagram.ts",
        fn: "sendIgMedia",
        igId: creds().igId,
        recipientId: recipientId.slice(0, 4) + "***" + recipientId.slice(-3),
        type,
        error: (e as Error).message.slice(0, 400),
      },
    });
    throw e;
  }
}

/**
 * Envía un mensaje con BOTONES tappables (quick replies de Instagram). El cliente
 * toca y el webhook recibe un mensaje normal cuyo `text` = el título del botón, así
 * que el motor lo trata como una respuesta más (resumeFlow continúa). Se puede
 * dirigir por IGSID (conversación abierta) o por comment_id (primer private reply).
 * Máximo 13 quick replies; títulos ≤20 chars.
 */
export async function sendIgQuickReplies(opts: {
  recipientId?: string;
  commentId?: string;
  text: string;
  replies: string[];
}): Promise<void> {
  const quick_replies = (opts.replies || [])
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .slice(0, 13)
    .map((t, i) => ({ content_type: "text", title: t.slice(0, 20), payload: "QR_" + i }));
  const message: Record<string, unknown> = { text: opts.text.slice(0, 640) };
  if (quick_replies.length) message.quick_replies = quick_replies;
  const recipient = opts.commentId ? { comment_id: opts.commentId } : { id: opts.recipientId };
  await pageSendMessage({
    recipient,
    message,
    ...(opts.commentId ? {} : { messaging_type: "RESPONSE" }),
  });
}

/**
 * Perfil del usuario que escribe (IGSID) vía la User Profile API de mensajería:
 * GET /{igsid}?fields=name,username,profile_pic con el PAGE token. Solo aplica a
 * usuarios que ya han mensajeado a la cuenta. Best-effort: null si falla (no
 * rompe el flujo del bot). El profile_pic es una URL de CDN que puede caducar.
 */
/**
 * MEDIA-BANDEJA-1 · Descarga los bytes de un adjunto entrante de Instagram/Facebook.
 *
 * `attachments[0].payload.url` ya viene FIRMADA: es un solo salto y NO se le manda
 * Authorization (mandar el token ahí no sirve de nada y lo filtraría a la CDN).
 *
 * Se llama DENTRO del webhook a propósito: es el único momento en que esa URL está
 * viva con certeza. Caduca en días y un adjunto de DM no se puede volver a pedir, así
 * que si no lo bajamos ahora, se pierde para siempre.
 */
const MAX_ATT_BYTES = 16 * 1024 * 1024; // 16 MB: tope de lo que aceptamos guardar

export async function downloadMetaAttachment(
  url: string,
): Promise<{ data: Buffer; contentType: string } | { error: string }> {
  if (!url) return { error: "el mensaje no traía URL del adjunto" };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { error: `Meta devolvió ${res.status} al descargar el adjunto` };
    const ct = res.headers.get("content-type") || "application/octet-stream";
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_ATT_BYTES) return { error: `el adjunto pesa ${Math.round(len / 1048576)} MB (máx 16 MB)` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ATT_BYTES) return { error: "el adjunto supera los 16 MB" };
    if (!buf.length) return { error: "Meta devolvió un adjunto vacío" };
    return { data: buf, contentType: ct };
  } catch (e) {
    return { error: (e as Error).message || "no se pudo descargar el adjunto" };
  }
}

/**
 * FOLLOW-REAL-1 · ¿Este usuario SIGUE a la cuenta? (User Profile API,
 * campo is_user_follow_business — mismas credenciales que fetchIgUserProfile).
 *
 * Devuelve:
 *   true  → confirmado que sigue
 *   false → confirmado que NO sigue
 *   null  → no se pudo saber (API caída, campo ausente, fuera de ventana…)
 * El caller debe tratar null como "beneficio de la duda": nunca bloqueamos a una
 * persona por un fallo NUESTRO de API.
 */
export async function fetchIgFollowStatus(igsid: string): Promise<boolean | null> {
  try {
    const { igId, token } = creds();
    const { pageToken } = await resolvePageCreds(igId, token);
    const res = await fetch(
      `${BASE}/${igsid}?fields=is_user_follow_business&access_token=${pageToken}`,
    );
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    if (typeof d.is_user_follow_business === "boolean") return d.is_user_follow_business;
    return null;
  } catch {
    return null;
  }
}

/**
 * SONDEO-IG-1 · Lee por API los DMs recientes de esta cuenta (los últimos de cada
 * conversación), en vez de esperar a que Meta nos los empuje por webhook.
 *
 * POR QUÉ EXISTE: la entrega de webhooks de MENSAJERÍA depende de que la Página esté
 * suscrita a los campos `messages`/`messaging_postbacks`, y esa suscripción exige el
 * permiso `pages_messaging`, que hoy los tokens NO tienen. Resultado: los comentarios
 * llegan (campo `feed`) pero el tap del botón y la respuesta por DM NO llegan NUNCA, y
 * el flujo se queda congelado justo después del primer mensaje.
 *
 * Leer conversaciones solo necesita `instagram_manage_messages`, que SÍ tenemos. Así
 * el flujo avanza sin depender de Meta ni de ningún permiso nuevo.
 *
 * Un tap en un botón de respuesta rápida viaja como un mensaje normal cuyo texto es la
 * etiqueta del botón ("Ya te sigo ✅"), así que se detecta igual que si lo escribieran.
 */
export async function fetchIgRecentInbound(
  sinceMs: number,
): Promise<Array<{ igsid: string; mid: string; text: string; ts: number }>> {
  return (await fetchIgRecentInboundDiag(sinceMs)).items;
}

/** Igual que fetchIgRecentInbound pero contando lo que pasó, para poder COMPROBAR desde
 *  el panel que la lectura por API funciona sin tener que esperar a que alguien
 *  comente. Si esto responde ok, el rescate de flujos funciona. */
export async function fetchIgRecentInboundDiag(
  sinceMs: number,
): Promise<{
  ok: boolean;
  error?: string;
  pageId?: string;
  conversations: number;
  items: Array<{ igsid: string; mid: string; text: string; ts: number }>;
}> {
  const out: Array<{ igsid: string; mid: string; text: string; ts: number }> = [];
  let conversations = 0;
  let pageId = "";
  try {
    const { igId, token } = creds();
    const pc = await resolvePageCreds(igId, token);
    pageId = pc.pageId;
    const pageToken = pc.pageToken;
    // EN DOS PASOS, a propósito. Pedir las conversaciones CON sus mensajes anidados en
    // una sola llamada es lo natural, pero en una cuenta con historial Meta responde
    // "Please reduce the amount of data you're asking for" y no devuelve NADA (probado
    // en producción: la cuenta pequeña funcionaba y la grande fallaba entera).
    //
    // Paso 1 pide solo id+fecha (baratísimo) y paso 2 baja los mensajes SOLO de las
    // conversaciones movidas desde el último sondeo — que casi siempre son cero o una.
    // Además de no reventar, sale más barato en el caso normal.
    const listUrl =
      `${BASE}/${pageId}/conversations?platform=instagram&limit=15` +
      `&fields=id,updated_time&access_token=${encodeURIComponent(pageToken)}`;
    const res = await fetch(listUrl, { signal: AbortSignal.timeout(8000) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d?.error) {
      return { ok: false, error: d?.error?.message || `HTTP ${res.status}`, pageId, conversations: 0, items: [] };
    }
    // Meta las devuelve de más reciente a más antigua; en cuanto una queda fuera de la
    // ventana, las siguientes también → se corta y no se piden mensajes de más.
    const recientes: string[] = [];
    for (const conv of d?.data ?? []) {
      conversations++;
      const upd = Date.parse(conv?.updated_time || "") || 0;
      if (upd && upd < sinceMs) break;
      if (conv?.id) recientes.push(String(conv.id));
      if (recientes.length >= 8) break; // tope duro: un sondeo nunca se dispara en llamadas
    }
    for (const convId of recientes) {
      const mUrl =
        `${BASE}/${convId}/messages?limit=6&fields=id,from,message,created_time` +
        `&access_token=${encodeURIComponent(pageToken)}`;
      const mr = await fetch(mUrl, { signal: AbortSignal.timeout(8000) });
      const md = await mr.json().catch(() => ({}));
      if (!mr.ok || md?.error) continue; // una conversación ilegible no tumba el resto
      for (const m of md?.data ?? []) {
        const fromId = String(m?.from?.id || "");
        // Descarta lo que hemos enviado NOSOTROS (el eco de la propia cuenta).
        if (!fromId || fromId === igId || fromId === pageId) continue;
        const text = String(m?.message || "");
        if (!text) continue; // adjunto sin texto: no reanuda un flujo
        const ts = Date.parse(m?.created_time || "") || 0;
        if (ts && ts < sinceMs) continue;
        out.push({ igsid: fromId, mid: String(m?.id || ""), text, ts });
      }
    }
  } catch (e) {
    // El sondeo nunca puede tumbar el scheduler.
    return { ok: false, error: (e as Error).message, pageId, conversations, items: [] };
  }
  // Del más antiguo al más nuevo: si alguien mandó dos mensajes, el flujo debe
  // procesarlos en el orden en que los escribió.
  return { ok: true, pageId, conversations, items: out.sort((a, b) => a.ts - b.ts) };
}

/** BACKFILL-IG-1 · Hilo reciente (AMBOS lados) de la conversación con un usuario, vía
 *  Conversations API. A diferencia de fetchIgRecentInboundDiag, NO descarta nuestro
 *  lado: sirve para rellenar en la Bandeja el SALIENTE escrito a mano desde la app de
 *  Instagram — que llega por webhook is_echo y que en algunas cuentas Meta no entrega
 *  (o cuya firma se descarta). Usa el page token → no depende del webhook. Solo texto:
 *  los mensajes sin cuerpo (media suelta) se omiten. */
export async function fetchIgThreadWith(
  igsid: string,
  limit = 30,
): Promise<{ ok: boolean; error?: string; messages: Array<{ mid: string; role: "user" | "assistant"; content: string; at: number }> }> {
  try {
    const { igId, token } = creds();
    const { pageId, pageToken } = await resolvePageCreds(igId, token);
    // 1) Conversación con ESTE usuario. Primero el filtro user_id (una llamada); si la
    //    cuenta no lo soporta, se listan las recientes y se casa por participante.
    let convId = "";
    try {
      const cu =
        `${BASE}/${pageId}/conversations?platform=instagram&user_id=${encodeURIComponent(igsid)}` +
        `&fields=id&access_token=${encodeURIComponent(pageToken)}`;
      const cr = await fetch(cu, { signal: AbortSignal.timeout(8000) });
      const cd = await cr.json().catch(() => ({}));
      if (cr.ok && !cd?.error && cd?.data?.[0]?.id) convId = String(cd.data[0].id);
    } catch { /* fallback abajo */ }
    if (!convId) {
      const lu =
        `${BASE}/${pageId}/conversations?platform=instagram&limit=25` +
        `&fields=id,participants&access_token=${encodeURIComponent(pageToken)}`;
      const lr = await fetch(lu, { signal: AbortSignal.timeout(8000) });
      const ld = await lr.json().catch(() => ({}));
      if (!lr.ok || ld?.error) return { ok: false, error: ld?.error?.message || `HTTP ${lr.status}`, messages: [] };
      for (const c of ld?.data ?? []) {
        if ((c?.participants?.data ?? []).some((p: { id?: string }) => String(p?.id) === igsid)) {
          convId = String(c.id);
          break;
        }
      }
    }
    if (!convId) return { ok: true, messages: [] }; // aún no hay conversación conocida
    // 2) Mensajes con los MISMOS campos que el sondeo (probados en producción, evita el
    //    "reduce the amount of data" que devuelve vacío en cuentas con historial).
    const mu =
      `${BASE}/${convId}/messages?limit=${Math.max(1, Math.min(50, limit))}` +
      `&fields=id,from,message,created_time&access_token=${encodeURIComponent(pageToken)}`;
    const mr = await fetch(mu, { signal: AbortSignal.timeout(9000) });
    const md = await mr.json().catch(() => ({}));
    if (!mr.ok || md?.error) return { ok: false, error: md?.error?.message || `HTTP ${mr.status}`, messages: [] };
    const out: Array<{ mid: string; role: "user" | "assistant"; content: string; at: number }> = [];
    for (const m of md?.data ?? []) {
      const fromId = String(m?.from?.id || "");
      if (!fromId) continue;
      const text = String(m?.message || "");
      if (!text) continue; // media suelta: se omite (el objetivo es el saliente escrito)
      out.push({
        mid: String(m?.id || ""),
        // NUESTRO lado = la propia cuenta IG o su Página. El resto, el cliente.
        role: fromId === igId || fromId === pageId ? "assistant" : "user",
        content: text,
        at: Date.parse(m?.created_time || "") || 0,
      });
    }
    out.sort((a, b) => a.at - b.at); // Meta los entrega del más nuevo al más viejo
    return { ok: true, messages: out };
  } catch (e) {
    return { ok: false, error: (e as Error).message, messages: [] };
  }
}

/** BACKFILL-IG-1 · Funde el hilo de la API (ambos lados) sobre los turns guardados,
 *  añadiendo SOLO lo que falta (típicamente nuestro saliente escrito a mano). Dedup por
 *  rol+contenido: nunca duplica algo que ya se ve. Ordena por marca de tiempo para que
 *  el saliente caiga en su sitio, no al final. */
export function mergeIgThread(
  stored: ChatMessage[],
  api: Array<{ role: "user" | "assistant"; content: string; at: number }>,
): { turns: ChatMessage[]; changed: boolean; added: number } {
  // Normaliza `at` conservando el orden actual (turns antiguos podían no tenerlo: se
  // hereda el del anterior para no romper el orden al reordenar).
  const base: ChatMessage[] = stored.map((t) => ({ ...t }));
  let last = 0;
  for (const t of base) {
    const a = typeof t.at === "number" && t.at > 0 ? t.at : 0;
    if (a > 0) last = a;
    else t.at = last;
  }
  const consumed = new Set<number>();
  const additions: ChatMessage[] = [];
  let upgraded = 0;
  for (const m of api) {
    const mc = m.content.trim();
    let found = -1;
    for (let i = 0; i < base.length; i++) {
      if (consumed.has(i)) continue;
      if (base[i].role !== m.role) continue;
      const bc = String(base[i].content || "").trim();
      // Coincidencia directa, O BIEN: un adjunto+caption enviado desde el PANEL se guarda
      // como UN turn "«etiqueta media»\n«caption»" pero se ENVÍA como DOS mensajes IG
      // (media + texto), así que la API devuelve el caption suelto. Casamos por la cola
      // tras el primer salto de línea para no duplicar el caption.
      if (bc === mc || (bc.includes("\n") && bc.slice(bc.indexOf("\n") + 1).trim() === mc)) {
        found = i;
        break;
      }
    }
    // PLANTILLA-ENTRANTE-1 · un mensaje con botones que entró por webhook antes del arreglo quedó
    // como «[template]». Si la API trae su texto (mismo lado, a menos de 15 min), se sustituye
    // en su sitio en vez de añadirlo aparte (antes salían los dos: el texto y el «[template]»).
    if (found < 0 && mc && mc !== "[template]") {
      for (let i = 0; i < base.length; i++) {
        if (consumed.has(i) || base[i].role !== m.role) continue;
        if (String(base[i].content || "").trim() !== "[template]") continue;
        if (m.at > 0 && Math.abs((base[i].at || 0) - m.at) > 15 * 60 * 1000) continue;
        base[i].content = m.content;
        upgraded++;
        found = i;
        break;
      }
    }
    if (found >= 0) {
      // Adopta la marca de tiempo REAL de la API en el turn guardado. Sin esto, un hilo
      // antiguo sin `at` (todos a 0) dejaría el saliente añadido AL FINAL en vez de
      // intercalado — justo el fallo que este backfill quiere evitar.
      if (m.at > 0) base[found].at = m.at;
      consumed.add(found); // 1 mensaje de la API → 1 turn guardado, sin re-emparejar
      continue;
    }
    additions.push({ role: m.role, content: m.content, at: m.at || Date.now() });
  }
  if (!additions.length) return upgraded ? { turns: base, changed: true, added: 0 } : { turns: stored, changed: false, added: 0 };
  const all = [...base, ...additions].sort((a, b) => (a.at || 0) - (b.at || 0));
  return { turns: all, changed: true, added: additions.length };
}

/**
 * Foto de perfil por @username vía **Business Discovery** — el rodeo a la ventana
 * de 24h. La User Profile API de mensajería solo devuelve profile_pic de usuarios
 * dentro de la ventana (o con acceso avanzado aprobado); un comentarista que nunca
 * abrió el DM se queda sin foto. Business Discovery (GET /{myIgId}?fields=
 * business_discovery.username(X){profile_picture_url}) SÍ devuelve la foto de
 * CUALQUIER cuenta PROFESIONAL pública, sin necesidad de que nos haya escrito.
 * Falla en silencio ('' ) si la cuenta es personal/privada (Meta da error) o si
 * nuestra cuenta es Creator y no Business (business_discovery exige Business).
 * Mismo endpoint/permiso que ya usa el Leadfinder de hashtags (instagram_basic).
 */
// Caché NEGATIVA de Business Discovery: la mayoría de comentaristas son cuentas
// PERSONALES (Meta responde code 110 «Invalid user id» — no descubribles por BD) y
// eso no cambia a menudo. Sin esto, el enriquecimiento re-consultaría BD para esas
// ~30 cuentas CADA 6h, quemando el rate-limit de la app (el propio #4 que vimos) y
// pudiendo tumbar tanto los lookups legítimos como el sondeo de flujos IG. Marcamos
// «esta cuenta no da foto por BD» 7 días. NO cacheamos errores transitorios (#4
// rate-limit): esos se reintentan. El reinicio del proceso limpia el mapa.
const bdNegative = new Map<string, number>();
const BD_NEG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

// IG-LLAMADAS-1 · cortacircuitos del rate-limit de la APP (#4/#17/#32/#613). El
// enriquecimiento de perfiles (nombre/foto) es lo MÁS barato de sacrificar y lo que más
// llamadas consume; cuando Meta limita la app, seguir insistiendo solo retrasa el
// desbloqueo y deja sin cuota a los flujos. Al primer rate-limit se pausa el
// enriquecimiento 60 min (en memoria: un reinicio lo rearma con la primera respuesta).
let igRateLimitedUntil = 0;
const IG_RATE_PAUSE_MS = 60 * 60 * 1000;
export const igGraphPaused = (): boolean => Date.now() < igRateLimitedUntil;
function noteIgRateLimit(d: unknown): void {
  const c = (d as { error?: { code?: number } } | null)?.error?.code;
  if (c === 4 || c === 17 || c === 32 || c === 613) igRateLimitedUntil = Date.now() + IG_RATE_PAUSE_MS;
}
async function fetchIgProfilePicByUsername(usernameRaw: string): Promise<string> {
  const username = String(usernameRaw || "").replace(/^@/, "").trim();
  // IG usernames son [a-zA-Z0-9._]; sanea por si acaso (va inline en el fields).
  if (!username || !/^[a-zA-Z0-9._]{1,30}$/.test(username)) return "";
  const neg = bdNegative.get(username);
  if (neg != null && Date.now() - neg < BD_NEG_TTL_MS) return "";
  if (igGraphPaused()) return "";
  try {
    const { igId, token } = creds();
    if (!igId || !token) return "";
    const fields = `business_discovery.username(${username}){profile_picture_url}`;
    const res = await fetch(
      `${BASE}/${igId}?fields=${encodeURIComponent(fields)}&access_token=${token}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const d = await res.json().catch(() => ({}));
    noteIgRateLimit(d);
    if (res.ok) {
      const pic = String(d?.business_discovery?.profile_picture_url || "");
      if (!pic) bdNegative.set(username, Date.now()); // descubrible pero sin foto (raro)
      return pic;
    }
    // Error: solo cacheamos como negativo los NO transitorios (cuenta personal =
    // code 110). El #4 (rate limit, is_transient) NO se cachea → se reintenta luego.
    const err = (d as { error?: { code?: number; is_transient?: boolean } })?.error;
    if (err && err.is_transient !== true && err.code !== 4) bdNegative.set(username, Date.now());
    return "";
  } catch {
    return "";
  }
}

/**
 * Perfil del comentarista/DMer para su avatar en la Bandeja.
 *
 * `knownUsername` = el @username que YA tenemos guardado (lo puso el webhook del
 * comentario al crear la ficha), sin depender de que la API de mensajería lo
 * devuelva. Es la pieza que hace funcionar el fallback de Business Discovery para
 * comentaristas fuera de la ventana de 24h: la User Profile API de mensajería no
 * les da username NI foto, pero con su username conocido sí sacamos la foto por BD.
 */
/** DIAGNÓSTICO (solo lectura): devuelve la respuesta CRUDA de Meta a
 *  business_discovery para ver POR QUÉ no llega la foto (permiso, tipo de cuenta,
 *  cuenta personal/privada). Corre bajo runWithAccount para probar cuenta a cuenta. */
export async function debugBizDiscovery(
  usernameRaw: string,
): Promise<{ igId: string; ok: boolean; status: number; raw: unknown }> {
  const username = String(usernameRaw || "").replace(/^@/, "").trim();
  const { igId, token } = creds();
  const fields = `business_discovery.username(${username}){profile_picture_url,username,followers_count,name}`;
  const res = await fetch(
    `${BASE}/${igId}?fields=${encodeURIComponent(fields)}&access_token=${token}`,
    { signal: AbortSignal.timeout(8000) },
  );
  const raw = await res.json().catch(() => ({}));
  return { igId, ok: res.ok, status: res.status, raw };
}

type IgProfile = { name?: string; username?: string; profilePic?: string } | null;

// IG-LLAMADAS-2 · MEMORIA POR IGSID de lo que Meta contestó. Cada llamada a
// fetchIgUserProfile son hasta TRES lecturas a Graph (perfil por IGSID, participantes de
// la conversación y Business Discovery). Los caminos de webhook (index.ts: cada DM y cada
// comentario) la llamaban SIN freno cuando el contacto no tenía foto guardada, y las
// cuentas privadas/fuera de ventana NUNCA la dan: cada mensaje de esa persona repetía
// las tres lecturas para siempre (≈3.100 IGBusinessScopedID + 780 ShadowIGUser al día).
// El arreglo IG-LLAMADAS-1 solo cubría la pasada de la Bandeja. Aquí se corta en un
// punto único para TODOS los llamadores: sin foto → no se vuelve a preguntar en 24 h;
// con foto → 30 min (la URL firmada de Meta caduca y quien la guarda ya la baja a BD).
// En memoria y por cuenta de Instagram: un reinicio lo vacía (solo cuesta volver a
// preguntar una vez por persona).
const IG_PROFILE_TTL_SIN_FOTO_MS = 24 * 60 * 60 * 1000;
const IG_PROFILE_TTL_CON_FOTO_MS = 30 * 60 * 1000;
const IG_PROFILE_CACHE_MAX = 5000;
const igProfileCache = new Map<string, { t: number; ttl: number; v: IgProfile }>();
const igProfileEnVuelo = new Map<string, Promise<IgProfile>>();

export async function fetchIgUserProfile(igsid: string, knownUsername?: string): Promise<IgProfile> {
  if (igGraphPaused()) return null; // IG-LLAMADAS-1: la app está limitada → no gastar cuota en nombre/foto
  let cuenta = "";
  try { cuenta = creds().igId || ""; } catch { /* sin credenciales: la lectura de abajo lo dirá */ }
  const key = cuenta + ":" + igsid;
  const hit = igProfileCache.get(key);
  if (hit && Date.now() - hit.t < hit.ttl) return hit.v;
  const vuelo = igProfileEnVuelo.get(key);
  if (vuelo) return vuelo;
  const p = fetchIgUserProfileRaw(igsid, knownUsername)
    .then((v) => {
      // Una respuesta cortada por el rate-limit NO es «esta persona no tiene foto»: no se memoriza.
      if (!igGraphPaused()) {
        if (igProfileCache.size >= IG_PROFILE_CACHE_MAX) {
          const viejo = igProfileCache.keys().next().value;
          if (viejo !== undefined) igProfileCache.delete(viejo);
        }
        igProfileCache.set(key, {
          t: Date.now(),
          ttl: v?.profilePic ? IG_PROFILE_TTL_CON_FOTO_MS : IG_PROFILE_TTL_SIN_FOTO_MS,
          v,
        });
      }
      return v;
    })
    .finally(() => { igProfileEnVuelo.delete(key); });
  igProfileEnVuelo.set(key, p);
  return p;
}

async function fetchIgUserProfileRaw(
  igsid: string,
  knownUsername?: string,
): Promise<IgProfile> {
  let apiName = "";
  let apiUsername = "";
  let profilePic = "";
  let pageToken = "";
  // 1) User Profile API de mensajería (name/username/profile_pic). Best-effort: si
  //    falla (cuenta secundaria sin page token, o usuario fuera de ventana), no
  //    abortamos — todavía podemos sacar la foto por Business Discovery con el
  //    username conocido.
  try {
    const { igId, token } = creds();
    pageToken = (await resolvePageCreds(igId, token)).pageToken;
    const res = await fetch(
      `${BASE}/${igsid}?fields=name,username,profile_pic&access_token=${pageToken}`,
      // Timeout explícito (consistente con Business Discovery): sin él, un body que
      // gotea puede retener minutos la pasada de enriquecimiento en segundo plano.
      { signal: AbortSignal.timeout(8000) },
    );
    const d = await res.json().catch(() => ({}));
    noteIgRateLimit(d);
    if (res.ok) {
      apiName = d.name ? String(d.name) : "";
      apiUsername = d.username ? String(d.username) : "";
      if (d.profile_pic) profilePic = String(d.profile_pic);
    }
  } catch { /* sigue al fallback */ }

  // IG-NOMBRE-1 · Meta niega la User Profile API con #230 («User consent is
  // required») a quien aún no ha dado consentimiento, y la ficha se quedaba como
  // «Contacto de Instagram». La lista de participantes de la conversación sí trae
  // su @usuario, sin ese requisito.
  if (!apiUsername && pageToken && !igGraphPaused()) {
    try {
      const res = await fetch(
        `${BASE}/me/conversations?platform=instagram&user_id=${encodeURIComponent(igsid)}&fields=participants&access_token=${pageToken}`,
        { signal: AbortSignal.timeout(8000) },
      );
      const d = await res.json().catch(() => ({}));
      noteIgRateLimit(d);
      for (const conv of d?.data ?? []) {
        const p = (conv?.participants?.data ?? []).find((x: { id?: string }) => String(x?.id) === igsid);
        if (p?.username) { apiUsername = String(p.username); break; }
      }
    } catch { /* best effort */ }
  }

  // 2) Fallback Business Discovery: la foto de cualquier cuenta PROFESIONAL pública
  //    por su @username, sin depender de la ventana de mensajería. Usa el username
  //    que devolvió la API o, si no, el que ya teníamos guardado (@name).
  const username = apiUsername || String(knownUsername || "").replace(/^@/, "").trim();
  if (!profilePic && username) {
    const bd = await fetchIgProfilePicByUsername(username);
    if (bd) profilePic = bd;
  }

  if (!apiName && !username && !profilePic) return null; // no sacamos nada nuevo
  if (!profilePic) {
    console.warn(
      `[ig-profile] ${igsid}: sin profile_pic ni por mensajería ni por Business ` +
      `Discovery (usuario fuera de la ventana de 24h Y cuenta personal/privada, ` +
      `o acceso 'instagram_manage_messages' sin aprobar). El avatar queda en iniciales.`,
    );
  }
  return { name: apiName || undefined, username: username || undefined, profilePic: profilePic || undefined };
}

// Opciones extra para publicar (Nivel 2 tagging):
//  - collaborator: 1 username (sin @) → aparece "Colaboración con @x" (Graph
//    devuelve error si el user no es público o no acepta; lo dejamos llegar).
//  - userTags (Nivel 3, no soportado aún en UI): array {username,x,y} para
//    tags clickables sobre la foto.
export interface PublishOpts {
  collaborator?: string;
  userTags?: { username: string; x: number; y: number }[];
  // PORTADA-1 · Reels: imagen de portada propia (URL pública) o fotograma (ms desde el inicio).
  coverUrl?: string;
  coverOffsetMs?: number;
  // REEL-PRUEBA-1 · reel de prueba: solo lo ven quienes no te siguen. MANUAL = lo pasas tú a tus
  // seguidores desde la app; SS_PERFORMANCE = Instagram lo pasa solo si funciona bien.
  trial?: "MANUAL" | "SS_PERFORMANCE";
}

function bodyForFeed(imageUrl: string, caption: string, opts?: PublishOpts): Record<string, unknown> {
  const body: Record<string, unknown> = { image_url: imageUrl, caption };
  if (opts?.collaborator) body.collaborators = [opts.collaborator.replace(/^@/, "")];
  if (opts?.userTags && opts.userTags.length)
    body.user_tags = opts.userTags.map((t) => ({
      username: t.username.replace(/^@/, ""),
      x: Math.max(0, Math.min(1, Number(t.x) || 0)),
      y: Math.max(0, Math.min(1, Number(t.y) || 0)),
    }));
  return body;
}

/** Publica una imagen en el feed (URL pública). */
export async function publishImage(imageUrl: string, caption: string, opts?: PublishOpts): Promise<string> {
  const { igId } = creds();
  const c = await graph(`${igId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyForFeed(imageUrl, caption, opts)),
  });
  const p = await graph(`${igId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: c.id }),
  });
  return p.id as string;
}

/** Publica un Reel (vídeo, URL pública). Espera al procesado. */
export async function publishReel(videoUrl: string, caption: string, opts?: PublishOpts): Promise<string> {
  const { igId } = creds();
  const reelBody: Record<string, unknown> = { media_type: "REELS", video_url: videoUrl, caption };
  // Reels solo admite collaborators (no user_tags clickables).
  if (opts?.collaborator) reelBody.collaborators = [opts.collaborator.replace(/^@/, "")];
  // PORTADA-1 · cover_url = imagen propia; si no, thumb_offset = el fotograma de ese momento.
  if (opts?.coverUrl) reelBody.cover_url = opts.coverUrl;
  else if (opts?.coverOffsetMs && opts.coverOffsetMs > 0) reelBody.thumb_offset = Math.round(opts.coverOffsetMs);
  // REEL-PRUEBA-1 · Meta solo acepta trial_params con media_type REELS.
  if (opts?.trial) reelBody.trial_params = { graduation_strategy: opts.trial };
  const c = await graph(`${igId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reelBody),
  });
  for (let i = 0; i < 24; i++) {
    const st = await graph(`${c.id}?fields=status_code`);
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR") throw new Error("Procesado del reel falló");
    await new Promise((r) => setTimeout(r, 5000));
  }
  const p = await graph(`${igId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: c.id }),
  });
  return p.id as string;
}

/** ¿La URL apunta a un vídeo? (por extensión: Meta pide decir qué es cada medio del carrusel). */
export function esVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v)(\?|#|$)/i.test(String(url || ""));
}

/**
 * ¿Es vídeo? Por extensión y, si la URL no la tiene (las subidas del Programador son /a/<id>),
 * preguntando al servidor su content-type (HEAD; si no deja, GET de 1 byte). Sin respuesta, imagen.
 */
export async function esVideoMedio(url: string): Promise<boolean> {
  if (esVideoUrl(url)) return true;
  if (/\.(jpe?g|png|webp|gif|heic)(\?|#|$)/i.test(String(url || ""))) return false;
  // DESTINO-SSRF-2: la URL la escribe el negocio; solo Internet, IP fijada en cada redirección.
  const tipo = async (method: "HEAD" | "GET") => {
    try {
      const r = await downloadPublic(url, method === "HEAD"
        ? { method, timeoutMs: 6000, maxBytes: 1 }
        : { timeoutMs: 6000, maxBytes: 1, truncate: true, range: "bytes=0-0" });
      return r.ok ? String(r.headers["content-type"] || "").toLowerCase() : "";
    } catch { return ""; }
  };
  let ct = await tipo("HEAD");
  if (!ct) ct = await tipo("GET");
  return ct.startsWith("video/");
}

/**
 * HISTORIAS-1 · publica una historia de Instagram (imagen o vídeo, URL pública). Las historias
 * no llevan texto. API de Meta: contenedor media_type STORIES → esperar FINISHED → media_publish.
 */
export async function publishStory(url: string): Promise<string> {
  const { igId } = creds();
  const video = await esVideoMedio(url);
  const body: Record<string, unknown> = video ? { media_type: "STORIES", video_url: url } : { media_type: "STORIES", image_url: url };
  const c = await graph(`${igId}/media`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!c || !c.id) throw new Error("Instagram no aceptó la historia");
  await esperaContenedor(String(c.id), "la historia", video ? 24 : 6, video ? 5000 : 1500);
  const p = await graph(`${igId}/media_publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ creation_id: c.id }) });
  return p.id as string;
}

/** Espera a que Meta termine de procesar un contenedor (FINISHED) o falla con motivo claro. */
async function esperaContenedor(id: string, que: string, intentos: number, pausaMs: number): Promise<void> {
  for (let i = 0; i < intentos; i++) {
    const st = await graph(`${id}?fields=status_code`);
    if (st.status_code === "FINISHED" || st.status_code === "PUBLISHED") return;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error(`Instagram no pudo procesar ${que}`);
    await new Promise((r) => setTimeout(r, pausaMs));
  }
  throw new Error(`Instagram tarda demasiado en procesar ${que}: vuelve a intentarlo en unos minutos`);
}

/**
 * CARRUSEL-IG-1 · publica un carrusel de 2 a 10 medios (imágenes y/o vídeos, URLs públicas).
 * API de Meta: un contenedor por medio con is_carousel_item, después el contenedor CAROUSEL
 * con children y el texto, y media_publish. Las etiquetas de personas van en la primera imagen;
 * la colaboración, en el carrusel.
 */
export async function publishCarousel(urls: string[], caption: string, opts?: PublishOpts): Promise<string> {
  const lista = (urls || []).map((u) => String(u || "").trim()).filter((u) => /^https?:\/\//.test(u));
  if (lista.length < 2) throw new Error("Un carrusel necesita al menos 2 imágenes o vídeos");
  if (lista.length > 10) throw new Error("Instagram admite como mucho 10 imágenes o vídeos por carrusel");
  const { igId } = creds();
  const hijos: string[] = [];
  for (let i = 0; i < lista.length; i++) {
    const url = lista[i];
    const video = await esVideoMedio(url); // las subidas del Programador no llevan extensión
    const body: Record<string, unknown> = video
      ? { media_type: "VIDEO", video_url: url, is_carousel_item: true }
      : { image_url: url, is_carousel_item: true };
    if (!video && i === 0 && opts?.userTags && opts.userTags.length) body.user_tags = bodyForFeed(url, "", opts).user_tags;
    const c = await graph(`${igId}/media`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!c || !c.id) throw new Error(`Instagram no aceptó el medio ${i + 1} del carrusel`);
    // Las imágenes se procesan al momento; los vídeos tardan (como un Reel).
    await esperaContenedor(String(c.id), `el medio ${i + 1} del carrusel`, video ? 24 : 6, video ? 5000 : 1500);
    hijos.push(String(c.id));
  }
  const padre: Record<string, unknown> = { media_type: "CAROUSEL", children: hijos.join(","), caption };
  if (opts?.collaborator) padre.collaborators = [opts.collaborator.replace(/^@/, "")];
  const c = await graph(`${igId}/media`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(padre) });
  await esperaContenedor(String(c.id), "el carrusel", 12, 2500);
  const p = await graph(`${igId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: c.id }),
  });
  return p.id as string;
}
