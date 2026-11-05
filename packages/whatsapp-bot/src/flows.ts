/**
 * Motor de flujos (Flow Builder propio, estilo ManyChat).
 * Un flujo = disparador + nodos encadenados. Tipos de nodo:
 *   message  : envía un mensaje (+enlace opcional) y sigue
 *   ask      : pregunta, espera la respuesta y la guarda (vars + contacto)
 *   buttons  : envía opciones numeradas y ramifica según lo que elija
 *   condition: ramifica (yes/no) según último mensaje o una variable
 *   delay    : espera N minutos (scheduler) y sigue
 *   action   : tag / etapa / escalar / iniciar otro flujo, y sigue
 *   end      : fin
 * Estado por contacto en app_flow_runs (waiting = esperando respuesta).
 * v1: canal WhatsApp. Instagram (comment→flow) = siguiente iteración.
 */
import { telLog } from "./pii-log.js";
import {
  dbListFlows,
  dbUpsertFlow,
  dbDeleteFlow,
  dbSaveFlowRun,
  dbSaveFlowRunIfLive,
  dbClaimFlowStart,
  dbWaitingFlowRun,
  dbWaitingFlowRunFor,
  dbAdvanceWaitingIfUnchanged,
  dbDeriveActiveDelayRun,
  dbDeferWaiting,
  dbRearmWaitingForFlow,
  dbActiveFlowRunsForPhone,
  dbWaitingFlowRunsForPhone,
  dbClavesPorEmail,
  dbClavesPorTelefono,
  dbCurrentFlowRunsForPhone,
  dbHasActiveFlowRun,
  dbReleaseClaim,
  dbGetContact,
  dbCancelFlowRunsForPhone,
  ETIQUETA_NO_MOLESTAR,
  dbCancelOtherFlowRuns,
  dbDueFlowRuns,
  dbDueWaitingFlowRuns,
  dbWaitingIgRuns,
  IG_WAIT_WINDOW_MS,
  dbClaimOnce,
  dbWasClaimed,
  dbFlowRunPhonesWindow,
  dbFlowEventAdd,
  dbDripNext,
  dbDripMark,
  dbDripCounts,
  dbDripEnqueue,
  dbDripAuthors,
  type FlowRun,
} from "./db.js";
import { sendText, sendButtons, sendCtaUrl, sendTemplate, activeWaPhoneId, resolveWaNumber, runWithWaNumber, uploadWaMedia, sendWaMedia, isQrNumber } from "./whatsapp.js";
import { sendFbText, fbSendDmFromComment, fbReplyToComment, sendFbQuickReplies, sendFbMedia } from "./facebook.js";
import { normalizarTelefono } from "./identidad.js"; // MET-AUTO-07-FIN
import { dbGetFlowMedia, dbGetWorkspace, dbWaMessageStatuses } from "./db.js";
import { logActivity } from "./activity.js";
import { sendDmFromComment, sendIgText, replyToComment, sendIgQuickReplies, activeIgCreds, resolveAccount, runWithAccount, fetchIgFollowStatus, fetchIgRecentInboundDiag, sendIgLinkButton, fetchIgUserProfile, fetchAllComments, fetchAllCommentsSelf, listIgAccounts, sendIgMedia } from "./instagram.js";
import { youtubeReplyToComment } from "./youtube.js";
import { replyToLinkedInComment } from "./linkedinCommunity.js";
import { enrichContact, setStage, getContact, inWindow, inWindowFor, routeAccount, setHuman, setScore, touchContact, contactByEmail, createContact } from "./contacts.js";
import { getAccount as siGetAccount, accountLabel as siAccountLabel } from "./systemeio-accounts.js";
import { queueMcpJob, contactHasSystemeioTag } from "./mcp-bridge.js";
import { esWebConPixel, visitRefFor } from "./web-analytics.js";
import { wrapUrlsInText, utmTagUrls, ogForUrl, probeImage, tarjetaImagenUrl, phoneOpenedFlowLink } from "./links.js";
import type { ChatMessage } from "./llm.js";
import { quickReply } from "./brain.js";
import { ensureSession, append, getSession } from "./memory.js";
import { aiTransparencyNotice, needsAiDisclosure, labelAiGeneratedContent, REGLA_IDENTIDAD_IA, REGLA_NO_INVENTAR, KB_VACIA } from "./ai-compliance.js";
import { runWithWorkspace, currentWorkspaceId } from "./workspace.js";
import { recordWebhook } from "./webhookDebug.js";
import { get, set } from "./settings.js";
import { substituteVars } from "./templating.js";
import { avisarContacto, avisarLeadNuevo, dedupVentana, canalDeClave } from "./notifications.js";

// Guarda un turno en la conversación (app_conversations) para que los flujos se
// VEAN en la Bandeja igual que las respuestas de la IA. append() no hace nada si
// no hay sesión en caché → ensureSession primero. Best-effort: nunca rompe el flujo.
/** Etiqueta del botón que lleva el enlace en Instagram. Es una FUNCIÓN, no una
 *  constante: a nivel de módulo se evaluaría antes de loadSettings() (siempre el valor
 *  por defecto) y además no recogería un cambio del ajuste sin reiniciar. */
const botonEnlace = (): string => (get("instagram.linkButtonText") || "Abrir enlace").slice(0, 20);

// BANDEJA-AUTO-1 · exportada para que automations.ts (los disparadores de
// comentario, que NO pasan por say()) puedan autorregistrar su envío en vez
// de depender del eco de Meta — el mismo hueco que dejaba «[template]» en
// flows.ts hasta PLANTILLA-BANDEJA-1, y que en automations.ts ni eso: el eco
// de Facebook se descarta siempre (index.ts) y el de Instagram no llega para
// todas las cuentas (visto en producción con @leadmatch.co).
export async function flowLog(
  phone: string,
  role: "user" | "assistant",
  content: string,
  // PLANTILLA-BANDEJA-1 · botones que acompañaron al mensaje (la Bandeja los pinta
  // tal cual): antes un paso con botones no dejaba rastro y el eco de Instagram
  // rellenaba el hueco con «[template]».
  // MEDIA-FLUJO-1 · att = referencia al adjunto enviado (los bytes viven en
  // app_inbox_media con source='flow'): con él la Bandeja pinta la foto/vídeo/audio
  // DE VERDAD en la burbuja, no solo la etiqueta «🎬 Vídeo».
  // AI-ACT-FLUJO-1 · notice='ai' marca el turno que YA lleva el aviso de transparencia
  // incorporado. Es la MISMA marca que usa el bot de la Bandeja, así que quien ya
  // recibió el aviso por un lado no lo recibe otra vez por el otro.
  extra?: { btns?: { t: string; u?: string }[]; att?: ChatMessage["att"]; notice?: "ai" },
): Promise<void> {
  if (!phone || !content) return;
  try {
    await ensureSession(phone, "");
    await append(phone, {
      role, content,
      ...(role === "assistant" ? { by: "flujo" as const } : {}), // ATENCION-HUMANA-1
      ...(extra?.btns?.length ? { btns: extra.btns } : {}),
      ...(extra?.att ? { att: extra.att } : {}),
      ...(extra?.notice ? { notice: extra.notice } : {}),
    });
  } catch { /* no bloquea el flujo */ }
}

/**
 * AI-ACT-FLUJO-1 · Devuelve el aviso de transparencia si a esta conversación todavía
 * no se le ha dicho que hay una IA detrás, o cadena vacía si ya se le dijo.
 *
 * Un paso «Mensaje» con IA activada genera su texto con `flowAiReply` y lo entrega con
 * `say`, sin pasar por el aviso: la persona recibía una respuesta generada sin saberlo.
 *
 * El aviso va DENTRO del mismo mensaje, no como mensaje aparte, y es deliberado:
 *  · en YouTube sólo se puede publicar UNA respuesta por comentario, y en Instagram
 *    sólo UNA respuesta privada — gastar ese único envío en un aviso suelto dejaría al
 *    cliente sin la respuesta que venía a buscar;
 *  · y en WhatsApp evita un mensaje extra que no aporta nada a quien ya está leyendo.
 * Cumplir no tiene por qué molestar.
 */
async function avisoIaPendiente(phone: string): Promise<string> {
  try {
    return needsAiDisclosure(await getSession(phone)) ? aiTransparencyNotice() : "";
  } catch { return ""; }
}

/** Envía según el canal del run: WhatsApp, IG (1ª vez private reply por comentario,
 *  luego DM por IGSID), o YouTube (siempre respuesta pública al comentario). */
/** MARCA-PUBLICA-1 · enlace de una respuesta PÚBLICA (YouTube/LinkedIn): sin acortador, con UNA sola marca.
 *  Si la web de destino lleva el píxel de este negocio, el enlace lleva el código corto del contacto
 *  (`utm_content=lmc_xxxxxxxx`): el píxel atribuye la visita a esa persona y, por la clave «yt:»/«li:»,
 *  sabe la red. Si no lleva píxel, queda `utm_source=<red>` como hasta ahora. */
async function etiquetaEnlacePublico(texto: string, clave: string, red: "youtube" | "linkedin"): Promise<string> {
  const urls = [...new Set(texto.match(/https?:\/\/[^\s]+/g) || [])];
  if (!urls.length) return texto;
  const tenant = currentWorkspaceId() || "default";
  let marca = "";
  const tagged = new Map<string, string>();
  for (const u of urls) {
    const limpia = u.replace(/[.,;:!?)\]]+$/, "");
    if (/[?&]utm_(source|content)=/i.test(limpia)) continue;
    let conPixel = false;
    try { conPixel = await esWebConPixel(tenant, limpia); } catch { /* sin píxel conocido */ }
    if (conPixel) {
      if (!marca) { try { marca = await visitRefFor(tenant, clave); } catch { /* sin marca */ } }
    }
    tagged.set(u, utmTagUrls(u, marca && conPixel ? { utm_content: marca } : { utm_source: red }));
  }
  let out = texto;
  for (const [orig, nuevo] of tagged) out = out.split(orig).join(nuevo);
  return out;
}

async function say(r: FlowRun, text: string, link?: string, linkLabel?: string, linkImage?: string, opts?: { avisoIa?: boolean; avisoFinal?: string }): Promise<void> {
  // AI-ACT-FLUJO-1 · el mensaje ya lleva el aviso incorporado: el turno queda marcado
  // para que nadie lo reciba dos veces (misma marca que el bot de la Bandeja).
  const marcaIa = opts?.avisoIa ? { notice: "ai" as const } : {};
  // Etiqueta del boton para ESTE mensaje. Si el paso trae la suya (linkLabel) manda esa;
  // si no, el ajuste global; si no, "Abrir enlace". Asi un flujo puede decir «Reclamar»
  // y otro «Descargar» sin pisarse.
  const etiquetaBoton = (linkLabel && linkLabel.trim()) || botonEnlace();
  // VARS-CANAL-1 · Sustituir {{name}}, {{email}}… TAMBIÉN en Instagram y YouTube. El
  // editor de un paso «Mensaje» es el mismo para todos los canales y ofrece variables,
  // pero la sustitución solo ocurría dentro del envío de WhatsApp (preparePayload):
  // en IG/YT el cliente recibía «Hola {{name}}» tal cual. Aquí se hace antes de
  // ramificar por canal; la rama de WhatsApp la vuelve a aplicar sin efecto (ya no
  // quedan llaves), así que su comportamiento no cambia.
  //
  // Se sustituyen texto y enlace POR SEPARADO, no la cadena ya unida: cuando el paso
  // lleva enlace, el texto viaja solo (dentro del botón) y si se sustituyera únicamente
  // la cadena unida, ese texto suelto saldría con las llaves sin resolver.
  let cuerpo = text || "";
  let enlace = link || "";
  if ((cuerpo + enlace).includes("{{")) {
    try {
      const c = await getContact(r.phone);
      // VARS-RUN-1 · Además del contacto, resuelven las variables del PROPIO run:
      // lo guardado por un paso «Pregunta» (saveAs) y las de contexto del
      // disparador (reserva_evento, reserva_fecha… en el trigger de reservas).
      // Las internas __* no molestan: solo se resuelve lo que el texto pide.
      cuerpo = substituteVars(cuerpo, c, { strict: false, extra: r.vars });
      enlace = substituteVars(enlace, c, { strict: false, extra: r.vars });
    } catch { /* si no se puede resolver, va el texto tal cual (como hasta ahora) */ }
  }
  const clean = [cuerpo, enlace].filter(Boolean).join("\n");
  if (!clean) return;
  // ENLACE-ABIERTO-2 · «desde el último enlace enviado»: se anota CUÁNDO sale el último mensaje
  // con enlace de este run, ANTES de enviarlo (así un clic real nunca queda por delante de la
  // marca). Es deliberado: si el envío falla después, la marca queda puesta y la condición
  // responde NO hasta que haya un clic posterior — el lado seguro (nunca un SÍ inventado).
  // Lo lee la condición «¿Ha abierto el enlace?» con «solo clics posteriores al último
  // enlace enviado». Viaja en vars y se guarda con el run en el siguiente aparcado.
  if (enlace.trim() || /\bhttps?:\/\/\S+/i.test(cuerpo)) r.vars.__linkAt = String(Date.now());
  // Envuelve enlaces con el tracker etiquetados con el flujo → mide clics/CTR
  // reales en Insights (respeta el ajuste links.wrap_auto = off).
  if (r.vars.__ch === "yt") {
    // YouTube no tiene DM: la ÚNICA salida es responder en público al comentario.
    // Tampoco hay Bandeja que alimentar.
    //
    // YT-UNA-RESPUESTA-1 · UNA sola respuesta pública por comentario. Antes __cid
    // NO se borraba, así que un flujo con dos o más pasos «Mensaje» publicaba una
    // respuesta pública POR PASO colgando del MISMO comentario: exactamente el
    // patrón repetitivo que la política de spam de YouTube penaliza (y sin DM al
    // que derivar la continuación). Ahora se borra tras el primer envío, igual que
    // la private reply de Instagram, y los pasos siguientes no publican nada.
    //
    // Enlaces: NO se acortan con el tracker (sí en WhatsApp/IG). La política de
    // spam de YouTube penaliza las URLs "ofuscadas" (un redirect esconde el
    // destino). En su lugar se etiquetan con UTM (dominio real visible), salvo
    // que el owner lo desactive con youtube.utm=off. Así la visita se atribuye a
    // "youtube" en la analítica web del destino sin arriesgar el canal.
    if (!r.vars.__ytacc) return;
    if (!r.vars.__cid) {
      // Nunca silencioso: queda en el Diagnóstico de Conexiones para que se vea
      // por qué el segundo paso «Mensaje» del flujo no aparece en YouTube.
      fev(r.flow_id, r.phone, "error", r.node_id, "YouTube solo admite UNA respuesta pública por comentario: este paso no se publica");
      recordWebhook("yt", "✋ este flujo ya respondió en público a ese comentario → el paso siguiente NO se publica (1 respuesta por comentario)");
      return;
    }
    const out =
      get("youtube.utm") === "off"
        ? clean
        : await etiquetaEnlacePublico(clean, r.phone, "youtube");
    // AVISO-IA-AL-FINAL · en una respuesta pública el aviso de IA va detrás del texto y del enlace.
    await youtubeReplyToComment(r.vars.__ytacc, r.vars.__cid, opts?.avisoFinal ? out + "\n\n" + opts.avisoFinal : out);
    delete r.vars.__cid;
    return;
  }
  if (r.vars.__ch === "li") {
    // LinkedIn, igual que YouTube: la Página NO puede escribir por privado a quien
    // comenta (no hay API de mensajes), así que la única salida es la respuesta pública
    // al comentario, UNA por comentario (__cid se borra tras la primera). Los enlaces van
    // con UTM y dominio visible, sin acortador: LinkedIn trata los redirects como spam.
    if (!r.vars.__liorg || !r.vars.__lipost) return;
    if (!r.vars.__cid) {
      fev(r.flow_id, r.phone, "error", r.node_id, "LinkedIn solo admite UNA respuesta pública por comentario: este paso no se publica");
      recordWebhook("linkedin", "✋ este flujo ya respondió en público a ese comentario → el paso siguiente NO se publica (1 respuesta por comentario)");
      return;
    }
    const out =
      get("linkedin.utm") === "off"
        ? clean
        : await etiquetaEnlacePublico(clean, r.phone, "linkedin");
    await replyToLinkedInComment(r.vars.__liorg, r.vars.__lipost, r.vars.__cid, opts?.avisoFinal ? out + "\n\n" + opts.avisoFinal : out);
    delete r.vars.__cid;
    return;
  }
  // ENLACE-TAL-CUAL-1 · con «enlaces tal cual» el enlace va sin acortar: la tarjeta de
  // WhatsApp enseña el dominio real. Se renuncia a medir clics solo en este flujo.
  const body = r.vars.__rawlinks === "1" ? clean : await wrapUrlsInText(clean, { kind: "flow", id: r.flow_id, phone: r.phone });
  if (r.vars.__ch === "ig") {
    // TELEMETRIA-IG-1 + regla dura de Meta: en un flujo por COMENTARIO solo se permite
    // UNA respuesta privada; los pasos siguientes van por DM normal, que Meta rechaza
    // si el usuario nunca ha escrito (no hay ventana). Antes ese rechazo reventaba el
    // run en silencio. Ahora: se registra en Actividad (visible) y el flujo SIGUE —
    // así queda en espera y se retoma solo cuando el usuario responda por DM.
    try {
      // ENLACE-BOTON-1 · Si el paso lleva ENLACE, va dentro de un BOTÓN, nunca suelto en
      // el texto. Instagram puede tener restringido el envío de enlaces de una cuenta
      // ("Link can't be shared"): con esa restricción un DM con la URL en el texto se
      // rechaza con un 400 y el paso NO llega —pasó en producción con el enlace del
      // lead magnet—, mientras que la misma URL en un botón sí se entrega. Es como lo
      // resuelve ManyChat.
      // URL NORMALIZADA. Un botón exige una URL absoluta: si el dueño escribió
      // "mi-web.com" sin http, Meta devuelve 400 y el paso NO llega (y encima el aviso
      // le echaría la culpa a Instagram). Se le antepone https:// y, si aun así no es
      // una URL parseable, se renuncia al botón y se envía como texto de siempre.
      let linkUrl = enlace ? (await wrapUrlsInText(enlace, { kind: "flow", id: r.flow_id, phone: r.phone })).trim() : "";
      if (linkUrl && !/^https?:\/\//i.test(linkUrl)) linkUrl = "https://" + linkUrl.replace(/^\/+/, "");
      if (linkUrl) {
        try { new URL(linkUrl); } catch { linkUrl = ""; } // no es una URL: mejor texto plano que un paso perdido
      }
      // `cuerpo`, no `text`: el texto ya lleva las variables sustituidas. Con el crudo,
      // un paso con enlace entregaba «Hola {{name}}» literal dentro del botón.
      // Y nunca vacío: una plantilla de botón con texto "" la rechaza Meta.
      const soloTexto = linkUrl ? cuerpo.trim() || "👇" : clean;
      if (r.vars.__cid) {
        await sendDmFromComment({
          commentId: r.vars.__cid,
          text: linkUrl ? soloTexto : body,
          link: linkUrl || undefined,
          buttonText: linkUrl ? etiquetaBoton : undefined,
        });
        delete r.vars.__cid; // solo 1 private reply por comentario
      } else if (linkUrl) {
        // r.phone = IGSID en canal IG
        const ok = await sendIgLinkButton(r.phone, soloTexto, linkUrl, etiquetaBoton);
        if (!ok) throw new Error("Instagram rechazó el enlace (ni siquiera dentro de un botón)");
      } else {
        await sendIgText(r.phone, body);
      }
      // PLANTILLA-BANDEJA-1 · Si el enlace salió dentro de un BOTÓN, el turno guarda
      // texto + botón (lo que el cliente vio de verdad), no «texto\nenlace». Además el
      // eco de Instagram (payload.text = este mismo texto) casa con el turno y no
      // duplica la burbuja.
      if (linkUrl) await flowLog(r.phone, "assistant", soloTexto, { btns: [{ t: etiquetaBoton, u: linkUrl }], ...marcaIa });
      else await flowLog(r.phone, "assistant", clean, marcaIa); // refleja el mensaje del flujo en la Bandeja
    } catch (e) {
      const msg = ((e as Error).message || "error").slice(0, 200);
      fev(r.flow_id, r.phone, "error", r.node_id, "paso NO entregado: " + msg.slice(0, 140));
      try {
        await logActivity({
          source: "ig-send",
          level: "error",
          summary: `Flujo IG: un paso no se pudo entregar: ${msg.slice(0, 120)}`,
          payload: {
            file: "flows.ts",
            fn: "say",
            flow_id: r.flow_id,
            error: msg,
            hint: r.vars.__cid
              ? ""
              : "Meta solo permite UNA respuesta privada por comentario. Los pasos siguientes solo llegan si el usuario responde por DM: junta el contenido importante en el PRIMER mensaje del flujo.",
          },
        });
      } catch { /* la telemetría nunca rompe el flujo */ }
      // EL FALLO NO PUEDE SER SILENCIOSO. Antes el flujo seguía como si el paso se
      // hubiera entregado: la persona recibía el «cualquier duda escríbeme» del paso
      // siguiente SIN haber recibido nunca lo que pidió (pasó en producción con el
      // enlace bloqueado por Instagram). Si lo que no salió era un ENLACE, se le manda
      // una alternativa para que no se quede a medias, y queda marcado en Actividad.
      // Solo cuando el fallo es DE VERDAD el bloqueo de enlaces. Si no se entregó por
      // otra causa (ventana cerrada, límite de envíos, red), decirle a la persona que
      // «Instagram no me deja mandarte el enlace» sería mentirle y mandarla al perfil
      // para nada; ese caso queda registrado y ya está.
      const bloqueoDeEnlace = /Link can't be shared|Community Standards|2534122|rechazó el enlace/i.test(msg);
      if (link && bloqueoDeEnlace) {
        recordWebhook("instagram", "⛔ el enlace del flujo NO se pudo entregar (Instagram lo bloquea) → se avisa a la persona");
        const aviso =
          get("instagram.linkBlockedText") ||
          "Uf, Instagram no me deja enviarte el enlace por aquí 😅 Lo tienes en el enlace de mi perfil 👆 (o dime «enlace» y te lo paso de otra forma).";
        try {
          // Si el envío falló ANTES de gastar la respuesta privada del comentario, el
          // aviso va por ahí. Es la única vía con entrega garantizada para quien solo ha
          // comentado (aún no hay ventana de 24 h), y además evita que la gaste el
          // siguiente paso: si no, la persona acababa recibiendo el mensaje de relleno
          // por la vía buena y nunca lo que había pedido.
          if (r.vars.__cid) {
            await sendDmFromComment({ commentId: r.vars.__cid, text: aviso });
            delete r.vars.__cid;
          } else {
            await sendIgText(r.phone, aviso);
          }
          await flowLog(r.phone, "assistant", aviso);
        } catch { /* si ni eso sale, ya está registrado arriba */ }
      }
    }
    return;
  }
  if (r.vars.__ch === "fb") {
    // Messenger, espejo de la rama de Instagram con una diferencia a favor:
    // Facebook no bloquea los enlaces en el texto («Link can't be shared» es cosa
    // de IG), así que en los pasos normales el enlace va en el propio mensaje —
    // ya acortado y atribuido por wrapUrlsInText como en el resto de canales. En
    // la respuesta privada al comentario (una sola por comentario, regla de Meta)
    // sí se usa el botón, que fbSendDmFromComment ya soporta.
    const pageId = r.vars.__fbpage || "";
    try {
      if (!pageId) throw new Error("run de Facebook sin Página (__fbpage vacío)");
      let fbLinkUrl = ""; // PLANTILLA-BANDEJA-1 · fuera del if: el log final necesita saber si hubo botón
      if (r.vars.__cid) {
        let linkUrl = enlace ? (await wrapUrlsInText(enlace, { kind: "flow", id: r.flow_id, phone: r.phone })).trim() : "";
        if (linkUrl && !/^https?:\/\//i.test(linkUrl)) linkUrl = "https://" + linkUrl.replace(/^\/+/, "");
        if (linkUrl) { try { new URL(linkUrl); } catch { linkUrl = ""; } }
        await fbSendDmFromComment({
          commentId: r.vars.__cid,
          text: linkUrl ? (cuerpo.trim() || "👇") : body,
          link: linkUrl || undefined,
          buttonText: linkUrl ? etiquetaBoton : undefined,
          pageId,
        });
        fbLinkUrl = linkUrl;
        delete r.vars.__cid; // solo 1 respuesta privada por comentario
      } else {
        await sendFbText(r.phone, body, pageId);
      }
      // PLANTILLA-BANDEJA-1 · con botón, el turno guarda texto + botón (lo enviado de verdad).
      if (fbLinkUrl) await flowLog(r.phone, "assistant", cuerpo.trim() || "👇", { btns: [{ t: etiquetaBoton, u: fbLinkUrl }], ...marcaIa });
      else await flowLog(r.phone, "assistant", clean, marcaIa);
    } catch (e) {
      const msg = ((e as Error).message || "error").slice(0, 200);
      fev(r.flow_id, r.phone, "error", r.node_id, "paso NO entregado: " + msg.slice(0, 140));
      try {
        await logActivity({
          source: "fb-send",
          level: "error",
          summary: `Flujo FB: un paso no se pudo entregar: ${msg.slice(0, 120)}`,
          payload: {
            file: "flows.ts",
            fn: "say",
            flow_id: r.flow_id,
            error: msg,
            hint: r.vars.__cid
              ? ""
              : "Meta solo permite UNA respuesta privada por comentario. Los pasos siguientes solo llegan si la persona responde por Messenger.",
          },
        });
      } catch { /* la telemetría nunca rompe el flujo */ }
    }
    return;
  }
  // ENLACE-TARJETA-1 · Paso con enlace como TARJETA: imagen grande de la página de
  // destino (su og:image), el texto, el dominio real al pie y un botón que abre el
  // enlace. Motivo: la previsualización de un enlace enviado por la API sale SIEMPRE en
  // tarjeta pequeña (WhatsApp no genera el formato grande para los bots, haga lo que
  // haga la página de destino); con la tarjeta la imagen va como cabecera y el botón
  // lleva el enlace acortado (mide clics) sin que el dominio del panel se vea.
  // Solo si el cuerpo cabe en la tarjeta (límite de Meta: 1024): un texto más largo sale
  // como texto de siempre, entero, en vez de cortado a mitad de frase.
  if (r.vars.__linkcard === "1" && enlace.trim() && cuerpo.trim().length <= 1024) {
    const destino = /^https?:\/\//i.test(enlace.trim()) ? enlace.trim() : "https://" + enlace.trim().replace(/^\/+/, "");
    let destinoOk = false;
    try { new URL(destino); destinoOk = true; } catch { /* no es una URL: mejor texto plano que un paso perdido */ }
    // El botón exige una URL absoluta: se sanea lo que devuelve el acortador igual que en IG/FB.
    let linkUrl = "";
    if (destinoOk) {
      linkUrl = r.vars.__rawlinks === "1" ? destino : (await wrapUrlsInText(destino, { kind: "flow", id: r.flow_id, phone: r.phone })).trim();
      if (linkUrl && !/^https?:\/\//i.test(linkUrl)) linkUrl = "https://" + linkUrl.replace(/^\/+/, "");
      try { new URL(linkUrl); } catch { linkUrl = ""; }
    }
    if (linkUrl) {
      // Imagen de la tarjeta: la que el dueño puso en el paso («imagen de la tarjeta») o, si
      // no, la de la página de destino (og:image). Las dos pasan el mismo filtro.
      let og: { image: string; fmt: string; w: number; bytes: number } = await ogForUrl(destino);
      const propia = String(linkImage || "").trim();
      if (propia) {
        const src = /^https?:\/\//i.test(propia) ? propia : "https://" + propia.replace(/^\/+/, "");
        og = { image: src, ...(await probeImage(src)) };
      }
      // SIN pie con el dominio (decisión del owner, 2-sep 23:45): WhatsApp Web lo convertía
      // en enlace y un clic ahí entraba sin pasar por el acortador. El único camino a la
      // página es el botón, que se mide.
      // WhatsApp solo admite JPEG/PNG de hasta 5 MB como imagen de mensaje: lo que no cumpla
      // (WEBP, SVG, pesada) va sin cabecera desde el principio, sin gastar un envío fallido.
      const imagenOk = !!og.image && (og.fmt === "png" || og.fmt === "jpeg") && (og.w === 0 || og.w >= 300) && og.bytes <= 5 * 1024 * 1024;
      const etiquetaWa = etiquetaBoton.slice(0, 20); // límite de Meta para el botón; la Bandeja guarda lo mismo que vio el cliente
      const ok = await sendCtaUrl(
        r.phone,
        // La imagen va RE-CODIFICADA por el panel (JPEG RGB): un PNG de paleta o de 16 bits
        // Meta lo rechaza en diferido y el mensaje no llega, sin ningún error síncrono.
        { body: cuerpo.trim(), url: linkUrl, buttonText: etiquetaWa, imageUrl: imagenOk ? tarjetaImagenUrl(og.image) : undefined },
        // Los enlaces que el dueño escribió DENTRO del texto siguen la regla del flujo:
        // acortados y atribuidos (miden clics) salvo «tal cual».
        r.vars.__rawlinks === "1" ? { skipLinkWrap: true } : { linkCtx: { kind: "flow", id: r.flow_id, phone: r.phone } },
      );
      if (ok) {
        // PLANTILLA-BANDEJA-1 · el turno guarda texto + botón (lo que el cliente vio).
        await flowLog(r.phone, "assistant", cuerpo.trim() || "👇", { btns: [{ t: etiquetaWa, u: linkUrl }], ...marcaIa });
        return;
      }
      fev(r.flow_id, r.phone, "aviso", r.node_id, "WhatsApp no aceptó la tarjeta con botón (detalle en el Centro de Actividad): se intenta como texto con enlace");
    }
  }
  // sendText devuelve false SIN lanzar cuando Meta rechaza (o faltan
  // credenciales): decirlo en los logs del flujo y NO reflejar en la Bandeja un
  // mensaje que nadie recibió. El detalle del rechazo ya queda en wa-send.
  const entregado = await sendText(r.phone, body, r.vars.__rawlinks === "1" ? { skipLinkWrap: true } : undefined);
  if (entregado === false) {
    fev(r.flow_id, r.phone, "paso NO entregado", r.node_id, "WhatsApp no aceptó el mensaje (detalle en el Centro de Actividad, wa-send)");
    return;
  }
  await flowLog(r.phone, "assistant", clean, marcaIa); // refleja el mensaje del flujo en la Bandeja
}

/** URL pública de un adjunto de flujo, SIN request: Meta lo descarga días
 *  después y el motor corre desde un barrido. El host sale del ajuste del panel
 *  o del dominio de Railway, igual que hace el autopost. */
function flowMediaPublicUrl(id: string): string {
  const host = String(get("autopost.publicHost") || process.env.RAILWAY_PUBLIC_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return host ? `https://${host}/admin/api/flow-media/${id}` : "";
}

/** Envía el ADJUNTO de un paso, después del texto. Por canal:
 *  WhatsApp sube los bytes (robusto multi-réplica); Instagram/Facebook
 *  descargan la URL pública. Un tipo que Instagram no admite (documentos) va
 *  como enlace con botón, acortado y atribuido al flujo. El fallo NUNCA es
 *  silencioso: registro del flujo + Actividad, la misma red que los enlaces. */
async function sendFlowMedia(r: FlowRun, media: { id: string; kind?: string; name?: string; mime?: string }): Promise<void> {
  if (!media || !media.id) return;
  if (r.vars.__ch === "yt") {
    fev(r.flow_id, r.phone, "error", r.node_id, "YouTube no admite adjuntos en respuestas a comentarios: este adjunto no se envía");
    return;
  }
  if (r.vars.__ch === "li") {
    fev(r.flow_id, r.phone, "error", r.node_id, "LinkedIn no admite adjuntos en respuestas a comentarios: este adjunto no se envía");
    return;
  }
  try {
    const m = await dbGetFlowMedia(media.id);
    if (!m || !m.data) throw new Error("el archivo del paso ya no está guardado");
    const kind = String(media.kind || m.kind || "document");
    const nombre = media.name || "archivo";
    if (r.vars.__ch === "ig") {
      if (kind === "image" || kind === "video" || kind === "audio") {
        const url = flowMediaPublicUrl(media.id);
        if (!url) throw new Error("falta el dominio público del panel (autopost.publicHost)");
        await sendIgMedia(r.phone, kind, url);
      } else {
        // Instagram no admite archivos en DM: va como enlace con botón, por la
        // misma vía (y con el mismo rastreo) que cualquier enlace de un paso.
        await say(r, "📎 " + nombre, flowMediaPublicUrl(media.id), "Descargar");
        return;
      }
    } else if (r.vars.__ch === "fb") {
      const url = flowMediaPublicUrl(media.id);
      if (!url) throw new Error("falta el dominio público del panel (autopost.publicHost)");
      await sendFbMedia(r.phone, r.vars.__fbpage || "", kind === "document" ? "file" : (kind as "image" | "video" | "audio"), url);
    } else {
      const mediaId = await uploadWaMedia(m.data, m.content_type, nombre);
      await sendWaMedia(r.phone, kind as "image" | "video" | "audio" | "document", { mediaId }, {
        filename: kind === "document" ? nombre : undefined,
        // NOTA-DE-VOZ-1 · un OGG-Opus (la subida ya verificó el códec) llega como
        // NOTA DE VOZ con ondas; ≤512 KB porque por encima WhatsApp quita el play.
        voice: kind === "audio" && m.content_type === "audio/ogg" && (m.data?.length || 0) <= 512 * 1024,
      });
    }
    const etiqueta = kind === "image" ? "📷 Foto" : kind === "video" ? "🎬 Vídeo" : kind === "audio" ? "🎵 Audio" : kind === "sticker" ? "🩷 Sticker" : "📎 " + nombre;
    // MEDIA-FLUJO-1 · el turno referencia el adjunto (att) y la Bandeja pinta la
    // burbuja REAL (foto/vídeo/audio reproducible), no solo la etiqueta. El content
    // sigue siendo la etiqueta: es lo que ven la lista, la búsqueda y la IA.
    await flowLog(r.phone, "assistant", etiqueta, { att: { id: media.id, kind, mime: m.content_type, state: "ok" } });
  } catch (e) {
    const msg = ((e as Error).message || "error").slice(0, 200);
    fev(r.flow_id, r.phone, "error", r.node_id, "adjunto NO entregado: " + msg.slice(0, 140));
    try {
      await logActivity({
        source: r.vars.__ch === "ig" ? "ig-send" : r.vars.__ch === "fb" ? "fb-send" : "wa-send",
        level: "error",
        summary: `Flujo: el adjunto no se pudo entregar: ${msg.slice(0, 120)}`,
        payload: {
          file: "flows.ts",
          fn: "sendFlowMedia",
          flow_id: r.flow_id,
          error: msg,
          hint: "En Instagram y Facebook el adjunto solo llega si la persona ya ha escrito (ventana de mensajería abierta). En el primer contacto por comentario, Meta solo permite texto.",
        },
      });
    } catch { /* la telemetría nunca rompe el flujo */ }
  }
}

export type FlowNode =
  // ai:true → el bot redacta la respuesta (varía el texto, evita el spam) y `text`
  // queda como reserva si la generación falla. aiPrompt = objetivo de la respuesta.
  // variants: textos ALTERNATIVOS escritos por el dueño. Al enviar se elige uno al
  // azar entre `text` + `variants` → cada persona recibe una redacción distinta sin
  // ceder el control del copy a la IA. Importa de verdad en Instagram: respuestas
  // idénticas repetidas se marcan como spam y se ocultan solas.
  | { type: "message"; text: string; variants?: string[]; link?: string; linkLabel?: string; linkImage?: string; next?: string; ai?: boolean; aiPrompt?: string; media?: { id: string; kind?: string; name?: string; mime?: string } }
  // CAPTURA-EMAIL-3 · expect: qué se espera que escriba la persona. Opcional a propósito: los
  // flujos ya guardados no lo llevan y siguen funcionando igual (se deduce del nombre del campo).
  // CAPTURA-EMAIL-4 · todo lo de abajo se configura DESDE EL FLUJO, no desde el código. Todo
  // opcional: un flujo ya guardado que no lleve nada se comporta exactamente igual que antes.
  //   maxTries   · veces que se le pide antes de rendirse (1-10, por defecto 3)
  //   retryText  · lo que se le dice al 1er fallo · retryText2 · a partir del 2º
  //   onFail     · qué hacer al agotarse: "continue" sigue igual, "human" pasa a una persona,
  //                y "auto" (por defecto) decide MIRANDO EL FLUJO: si más adelante el premio se
  //                entrega por correo, seguir es prometer algo que no va a llegar → persona.
  //   failText   · lo que se le dice al rendirse · notifyPhones · a quién avisar (vacío = el del flujo)
  | { type: "ask"; text: string; saveAs: string; next?: string; expect?: "email" | "text";
      maxTries?: number; retryText?: string; retryText2?: string;
      onFail?: "auto" | "continue" | "human"; failText?: string; notifyPhones?: string }
  // requireFollow (def. true): no se pasa de aquí hasta que Meta confirme que SIGUE.
  // false = se le pide 2 veces y luego continúa igual.
  | { type: "follow"; text?: string; variants?: string[]; confirmLabel?: string; requireFollow?: boolean; skipIfFollows?: boolean; alreadyFollowsText?: string; alreadyFollowsLabel?: string; next?: string } // pedir seguir (IG) → botón "Listo" → se comprueba de verdad
  | { type: "buttons"; text: string; saveAs?: string; options: { label: string; next?: string }[] }
  | {
      type: "condition";
      // "emailOpened" = ¿el contacto abrió el correo? (etiqueta systeme.io por email).
      // "hasTag" = ¿el contacto tiene una etiqueta LOCAL? (p.ej. "sio-registrado", que el
      // webhook de systeme.io pone al confirmar su registro). value = nombre de la etiqueta.
      // "linkOpened" = ¿el contacto abrió algún enlace de ESTE flujo? (clics del acortador,
      // /r/<token>?p=<teléfono>, atribuidos al flujo). ENLACE-ABIERTO-1.
      //   ENLACE-ABIERTO-2 · `value` (opcional) = trozo de la dirección DESTINO que debe llevar
      //   el enlace pulsado (p. ej. «consigue-tu-pack-cc»); `sinceLastLink` = solo cuentan los
      //   clics posteriores al ÚLTIMO mensaje con enlace que envió este run (__linkAt). Así se
      //   distingue «pulsó el botón de ESTE mensaje» de «pulsó algo en algún momento».
      // VENTA-WEBHOOK-1 · "purchased" = ¿consta una compra del contacto? (webhook de ventas,
      //   systeme.io o enlace de pago; ver ventas-webhook.ts → contactoCompro). Con
      //   `sinceLastLink`, solo compras posteriores al último enlace enviado.
      //   `notPurchased` (solo en "linkOpened") = SÍ únicamente si abrió Y no ha comprado:
      //   el «llegó al formulario de pago y no terminó» en un solo nodo.
      source: "lastMessage" | "var" | "emailOpened" | "hasTag" | "linkOpened" | "purchased";
      varName?: string;
      op: "contains" | "equals" | "exists";
      value?: string;
      sinceLastLink?: boolean;
      notPurchased?: boolean;
      // OPEN-GATE (source "emailOpened"):
      openTag?: string; // etiqueta que systeme.io asigna al abrir el correo
      openTarget?: string; // a qué cuenta preguntar: 'systemeio' | 'leadmatch-lab' | accountId
      openAccountId?: string; // cuenta systeme.io EXACTA (si hay varias)
      yes?: string;
      no?: string;
    }
  // ESPERA-SEG-1 · `seconds` (0-59) se suma a `minutes`. Opcional: los flujos ya guardados
  // solo traen minutos y siguen valiendo tal cual (undefined = 0).
  | { type: "delay"; minutes: number; seconds?: number; next?: string }
  | {
      type: "action";
      kind?: "tag" | "stage" | "flow" | "escalate" | "score" | "tobot" | "notify" | "sync" | "book"; // qué hace (1 sola cosa)
      addTag?: string;
      bookingUrl?: string; // 'book': enlace de reservas (Cal.com/Calendly); si vacío, usa el ajuste booking.url
      bookingPromptText?: string; // 'book': texto que acompaña al enlace
      bookingTag?: string; // 'book': etiqueta al agendar (p.ej. 'agendado')
      syncTarget?: string; // a dónde sincronizar el contacto (accountId | 'systemeio' | 'leadmatch-lab')
      syncAccountId?: string; // cuenta systeme.io EXACTA (hay varias); si falta se deduce de syncTarget
      syncTag?: string; // etiqueta a aplicar al contacto antes de empujarlo
      // CAMPO IDENTIFICADOR: qué recurso pidió esta persona. Lo escribe ESTE flujo en el
      // contacto (p.ej. recurso="fluxmule") y allí un ÚNICO workflow ramifica por su
      // valor para mandar el correo que toca. Así cada flujo entrega un correo distinto
      // sin gastar una etiqueta ni una regla por cada uno.
      syncField?: string; // slug del campo en systeme.io (p.ej. "company_name")
      syncFieldValue?: string; // valor que identifica a ESTE flujo (p.ej. "fluxmule")
      setStage?: string;
      setPipeline?: string;
      setScore?: number;
      escalate?: boolean;
      toBot?: boolean; // devuelve la conversación al bot (human=false)
      notify?: boolean; // avisa a los closers por WhatsApp
      notifyPhones?: string; // E.164 separados por coma
      notifyTemplate?: string; // plantilla aprobada (para fuera de la ventana 24h)
      notifyLang?: string; // idioma de la plantilla (def 'es')
      // AVISO-VARIABLES-1 · valores de {{1}}, {{2}}, {{3}}… de la plantilla, en orden. Admiten
      // variables del contacto y del run, con respaldo: "{{nombre}}", "{{telefono}}",
      // "{{field.dolor|Sin diagnóstico}}". Ausente = [nombre, teléfono], como siempre.
      notifyParams?: string[];
      startFlow?: string;
      next?: string;
    }
  | { type: "end" };

export interface Flow {
  id: string;
  name: string;
  enabled: boolean;
  /** Fechas de columna (dbListFlows las inyecta; jamás se persisten en data). */
  createdAt?: number;
  updatedAt?: number;
  /** Endpoint al que se limita el disparador: phone_number_id (WhatsApp) o
   *  ig_id (Instagram). Vacío = se aplica a TODOS los números/cuentas (default). */
  appliesTo?: string;
  /** REGLA DE PARADA · Etiqueta que, si el contacto la tiene (en LOCAL o en systeme.io),
   *  DETIENE este flujo: no seguimos cerrando a quien ya compró. Ej. "INSCRITO LM". El
   *  cruce con systeme.io se hace por TELÉFONO (campo phone_number que el checkout captura)
   *  vía webhook (instantáneo) + reconciliación periódica (garantía). El guard de run()
   *  comprueba la marca LOCAL antes de cada paso. Vacío = sin regla. */
  stopTag?: string;
  /** Cuenta de systeme.io donde vive la etiqueta de compra (id de connections). Vacío =
   *  se prueba la primera cuenta con API key que tenga esa etiqueta. */
  stopTagAccount?: string;
  /** ENLACE-TAL-CUAL-1 · los enlaces de este flujo salen SIN acortar: WhatsApp pinta el
   *  dominio del enlace que va en el mensaje, así que con el acortador la tarjeta decía
   *  «business-stack…» en vez del dominio real. Se pierde la medición de clics de este
   *  flujo (y solo de este); el resto del panel sigue midiendo. */
  rawLinks?: boolean;
  /** ENLACE-TARJETA-1 · Paso «Mensaje» con enlace como tarjeta: imagen grande de la
   *  página (su og:image), texto, dominio real al pie y un botón que abre el enlace.
   *  Es el comportamiento POR DEFECTO (undefined = tarjeta); false = enlace en el texto. */
  linkCard?: boolean;
  /** MODO TEST · mientras esté ON: (a) SOLO el número `testPhone` puede disparar el flujo
   *  (los clientes quedan fuera), y (b) todas las esperas valen 1 min. La marca va en el
   *  RUN (vars.__test), no en el flujo → un cliente que ya esté dentro mantiene sus tiempos
   *  reales aunque enciendas el test, y una prueba sigue comprimida aunque lo apagues. */
  testMode?: boolean;
  testPhone?: string;
  /** PRUEBA-CANAL-1 · El modo prueba NO es solo de WhatsApp: un flujo que arranca por
   *  Instagram, Facebook, YouTube, correo o una reserva escribía a contactos REALES con
   *  el modo prueba encendido (solo se comprimían las esperas). Cada canal tiene su
   *  propio contacto de prueba porque el identificador que llega es distinto en cada uno:
   *  un número en WhatsApp, el usuario que comenta en Instagram, el nombre que comenta en
   *  Facebook o YouTube, y el correo en los disparadores de correo y de reservas.
   *  Sin el contacto de prueba de SU canal, el flujo en pruebas no entra para nadie
   *  (bloqueaPorPrueba) — es lo único seguro: abrirlo a todos sería exponerlo. */
  testIgUser?: string;
  testFbUser?: string;
  testYtUser?: string;
  testLiUser?: string;
  testEmail?: string;
  /** SEGUIMIENTO SI NO RESPONDE (timeout de inactividad, condición global del flujo) ·
   *  cuando el contacto no contesta en un nodo de espera (botones/pregunta), el bot lo
   *  reengancha en cadencia y, si sigue callado, lo deriva a Carla igualmente. Una sola
   *  config, no 18 nodos. Reutiliza el reloj de las esperas (y el modo test lo comprime). */
  fuEnabled?: boolean;
  fuT1?: number;   // min hasta el reenganche 1 (def 90)
  fuMsg1?: string;
  fuT2?: number;   // min hasta el reenganche 2 (def 1320 = 22 h → dentro de la ventana de 24 h)
  fuMsg2?: string;
  fuT3?: number;   // min hasta derivar a Carla (def 1440)
  fuFinalMsg?: string;      // mensaje al lead al derivar (opcional)
  fuNotifyPhones?: string;  // nº del closer/Carla para el aviso
  fuNotifyTemplate?: string; // plantilla aprobada para el aviso a Carla (llega fuera de 24 h)
  fuNotifyLang?: string;     // idioma de la plantilla (def "es")
  fuCarlaTag?: string;      // etiqueta al derivar por inactividad (def "derivado-inactividad")
  /** REPESCA-3-1 · qué pasa al TERCER toque: «derivar» (por defecto: cerrar el run, etiquetar
   *  y avisar a Carla) o «mensaje» (enviar fuFinalMsg como tercer aviso y dejar el run
   *  APARCADO: si el lead contesta más tarde, el flujo continúa desde ese punto). */
  fuMode?: "derivar" | "mensaje";
  /** DERIVACIÓN INMEDIATA · «regla que impera sobre las esperas»: si el lead ESCRIBE mientras
   *  el flujo está aparcado en una ESPERA (delay), no se le hace aguantar el temporizador:
   *  se le contesta, se avisa a Carla al instante, se pasa a modo humano y el flujo termina.
   *  El lead más caliente (el que escribe por iniciativa propia) es el que antes llega al cierre. */
  rdEnabled?: boolean;
  rdNotifyPhones?: string;  // nº del closer/Carla (si vacío: el del primer paso «Avisar a un closer» del flujo)
  rdMsg?: string;           // respuesta al lead al derivar (hay texto por defecto)
  rdNotifyTemplate?: string; // plantilla del aviso a Carla (si vacío: usa la del seguimiento, fuNotifyTemplate)
  rdNotifyLang?: string;     // idioma de la plantilla (def "es")
  /** CUALIFICACIÓN MÍNIMA para la derivación inmediata: solo se deriva si el contacto tiene
   *  ALGUNA de estas etiquetas (separadas por coma, p.ej. "acudió live, vio la grabación").
   *  Regla del owner: a quien no ha visto la formación NO se le pasa a Carla — se le sigue
   *  empujando la grabación (el flujo/la IA continúan con normalidad). Vacío = sin filtro. */
  rdRequireTags?: string;
  /** TEXTO-EN-BOTONES-1 · qué pasa si, en un paso con botones, la persona ESCRIBE en vez de
   *  pulsar. btnRetryText sustituye al «No te entendí. Elige una opción…» de fábrica.
   *  Si el texto es una DUDA real (pregunta, precio, pago…) y hay btnDoubtTag, no se le
   *  insiste con los botones: se etiqueta, se avisa a una persona (btnDoubtNotifyPhones +
   *  btnDoubtTemplate, variables {{1}} nombre y {{2}} teléfono) y el flujo sigue esperando
   *  en el mismo paso, por si luego pulsa. Todo vacío = comportamiento de siempre. */
  btnRetryText?: string;
  btnDoubtTag?: string;
  btnDoubtNotifyPhones?: string;
  btnDoubtTemplate?: string;
  /** FRANJA HORARIA de entrega (hora de España): no entregar mensajes automáticos de
   *  madrugada. Si una espera o un reenganche vence dentro de la franja silenciosa
   *  (quietFrom→quietTo), la entrega se pospone a quietTo. El modo test NO se ve afectado. */
  quietEnabled?: boolean;
  quietFrom?: string;       // inicio del silencio, "23:30" por defecto
  quietTo?: string;         // fin del silencio, "07:30" por defecto
  /** FRANJA-PAIS-1 · zona horaria (IANA) en la que se leen quietFrom/quietTo. Vacío o
   *  desconocida = Europe/Madrid, como siempre. El público LATAM de un flujo no tiene que
   *  convertir horas de cabeza: elige su país y la franja corre en SU hora. */
  quietTz?: string;
  /** Clave estable para que el BOT (IA) dispare este flujo (puente bot→flow). */
  intent?: string;
  /** PUBLIC-REPLY-1 · Respuestas PÚBLICAS al comentario (trigger ig_comment). Se elige
   *  una al azar. Vacío = las de reserva. Es lo que la gente ve bajo tu post. */
  publicReplies?: string[];
  /** true = no responder en público al comentario (solo DM). */
  publicReplyOff?: boolean;
  /** PUBLIC-AI-1 · La respuesta pública la ESCRIBE la IA, con la base de conocimiento y
   *  la voz de marca, mirando lo que la persona ha comentado de verdad. publicReplies
   *  queda de reserva por si el modelo falla o devuelve vacío. Publicar siempre el mismo
   *  texto bajo tus posts es justo lo que Instagram marca como spam, así que esto no es
   *  un adorno: es lo que hace que cada respuesta sea distinta. */
  publicAi?: boolean;
  /** Qué debe conseguir esa respuesta pública, en una frase («confírmale que se lo
   *  mandas por privado»). Vacío = solo la base de conocimiento y la voz de marca. */
  publicAiPrompt?: string;
  /** ONCE-FLOW-1 · Una vez por persona: quien ya entró en este flujo no vuelve a
   *  entrar NUNCA, aunque repita la palabra clave o vuelva a comentar. La marca es
   *  PERMANENTE (app_automation_log, clave flujo + identidad del canal) y sobrevive
   *  al final del recorrido — no confundir con dbHasActiveFlowRun, que solo evita
   *  solapar mientras el run sigue vivo. Es el equivalente del «una vez por usuario»
   *  de los Disparadores (waflows.ts, automations.ts). Ausente = como siempre. */
  oncePerUser?: boolean;
  /** KEEP-AI-1 · true = el flujo responde y DEJA que la IA siga atendiendo (es el
   *  stopAi=false de los Disparadores). Por defecto, y como ha sido siempre, un flujo
   *  que arranca lleva la conversación en exclusiva y la IA calla.
   *  SOLO surte efecto en flujos INSTANTÁNEOS (sin preguntas, botones, «pedir seguir»
   *  ni esperas): ver flowEsInstantaneo. Si el flujo deja al contacto esperando algo,
   *  esta casilla se ignora a propósito — la IA hablaría encima y le robaría la
   *  respuesta al flujo, que es como se corrompen los datos del lead. */
  keepAi?: boolean;
  trigger: {
    type: "wa_keyword" | "wa_any" | "ig_comment" | "ig_story" | "ig_dm" | "yt_comment" | "li_comment" | "fb_comment" | "booking" | "recordatorio" | "email" | "typeform" | "formulario";
    keyword?: string;
    /** TYPEFORM-1 · solo trigger «typeform»: formulario concreto (id de Typeform).
     *  Vacío = cualquier formulario con «Guardar respuestas» activado. */
    tfFormId?: string;
    /** FORMULARIOS-1 · disparador «formulario»: id del formulario propio (vacío = cualquiera). */
    formId?: string;
    /** COMENTARIO-ABIERTO-1 · QUÉ texto abre el flujo en las redes (comentarios de
     *  Instagram/Facebook/YouTube, respuestas a historia y DMs):
     *    'any'     = CUALQUIER comentario o mensaje, sin palabra clave. Lo que acota
     *                el flujo es entonces la publicación (mediaId) y la cuenta.
     *    'keyword' = solo si el texto casa con `keyword`.
     *  AUSENTE = se deriva de la clave (vacía → 'any'), que es EXACTAMENTE lo que el
     *  motor hacía desde siempre (matchesKeyword con clave vacía casa con todo): por
     *  eso ningún flujo ya guardado cambia de comportamiento al añadirse este campo.
     *  Invariante que garantiza el guardado (normalizeTriggerMatch): match==='any'
     *  ⟺ keyword vacía. Así la clave nunca queda escondida contradiciendo al modo. */
    match?: "any" | "keyword";
    /** T03-CORREOS · solo trigger «email»: cuenta web EXACTA (id de Conexiones).
     *  Obligatoria y persistida: jamás se sustituye en silencio por otra cuenta
     *  ni por «la primera» — si se desconecta, el flujo queda bloqueado y
     *  reparable (fev + Centro de actividad), nunca reasignado. */
    emAccountId?: string;
    /** Evento del correo: 'opened' (lo abrió) | 'clicked' (pulsó un enlace).
     *  Son los ÚNICOS eventos individuales demostrables del proveedor: llegan
     *  como etiqueta puente (regla «email abierto/clic → asignar etiqueta» en
     *  la web → webhook CONTACT_TAG_ADDED + reconciliación por API pública).
     *  Enviado/entregado/rebote/baja/spam solo existen AGREGADOS y no se
     *  ofrecen como disparador (un agregado no identifica a un contacto). */
    emEvent?: string;
    /** Alcance configurado: 'any' (cualquier correo de la cuenta) | 'email'
     *  (un correo concreto) | 'origin' (todos los de un origen) | 'type'
     *  (todos los de un tipo). El alcance documenta QUÉ representa la
     *  etiqueta puente y alimenta las variables; el disparo real siempre es
     *  la etiqueta (es la única señal individual que existe). */
    emScope?: string;
    /** newsletter | campaign | sequence | automation | rule | individual | other */
    emOriginType?: string;
    /** Id estable del origen (cp:<id> / wf:<id> / nl:<id>…), scope 'origin'/'email'. */
    emOriginId?: string;
    emOriginName?: string;
    /** Id estable del correo concreto (nl:/cs:/wf:/rl:/ml:), scope 'email'. */
    emEmailId?: string;
    emSubject?: string;
    /** Etiqueta que la web asigna al ocurrir el evento (vía instantánea por
     *  webhook). OPCIONAL si hay seguimiento directo del envío. */
    emTag?: string;
    /** DIRECTO-1 · id del ENVÍO (stats internas) del correo elegido. Con él y
     *  cookie viva, el panel lee los destinatarios (abrió/clicó POR CONTACTO)
     *  cada ~30 min — la vía para newsletters sueltas, que en systeme.io no
     *  tienen dónde colgar una regla de etiqueta. Es pull: menos inmediato
     *  que la etiqueta, y así se cuenta en la UI. */
    emMailingId?: string;
    /** DIRECTO-1 · true = en la PRIMERA pasada también dispara para quienes YA
     *  habían abierto/clicado antes de activar el flujo. Por defecto false:
     *  la primera pasada solo marca la línea base (nadie recibe nada por
     *  aperturas viejas) y se dispara solo con lo nuevo. */
    emIncludePast?: boolean;
    /** RECORDATORIO-FLOW-1 · solo trigger «recordatorio»: a qué reuniones aplica.
     *  'todos' | 'manual' (apuntadas en el panel) | 'webs' (reservas de las webs) |
     *  'evento:<nombre del evento web>'. La más específica gana: si un evento tiene
     *  su propio flujo de aviso, los generales no le escriben (no se duplica). */
    ambito?: string;
    /** Minutos ANTES de la cita en que se dispara (5..20160). */
    antesMin?: number;
    /** Plantilla WhatsApp aprobada para cuando la ventana de 24 h está cerrada
     *  (variables {{1}} motivo, {{2}} cuándo). Vacía → appointment.template legacy. */
    tpl?: string;
    tplLang?: string;
    /** FORM-CITA-2 · solo trigger «booking»: qué llevan las dos variables de la plantilla.
     *  "" (por defecto) → {{1}} la cita y {{2}} cuándo · "dia_hora" → {{1}} el día y {{2}} la hora
     *  («Confirmamos tu reserva el {{1}} a las {{2}}»).
     *  RESERVA-WA-1 · o una lista: «nombre,fecha,hora» → {{1}} nombre, {{2}} día, {{3}} hora
     *  (datos válidos en DATOS_RESERVA). En «booking», `ambito` = «evento:<nombre>» limita el
     *  flujo a ese evento y `appliesTo` (phone_number_id) fija el número que envía. */
    tplVars?: string;
    /** FRASE EXACTA · si true, el disparador NO casa por «contiene alguna palabra» sino que
     *  exige que el mensaje SEA exactamente esa frase (normalizada: sin acentos/mayúsculas/
     *  signos). Pensado para el CTA pre-rellenado del enlace wa.me: solo dispara quien envía
     *  la frase tal cual, nunca una frase suelta que contenga «hoy» o «equipo». */
    matchExact?: boolean;
    mediaId?: string; // ig_comment: id de publicación · yt_comment: id de vídeo · li_comment: URN del post · "any"
    /** MEDIA-SNAP-1 · copia guardada de la publicación elegida (miniatura incrustada +
     *  texto), hecha UNA vez al guardar el flujo. El panel la pinta cuando la red no
     *  devuelve el post (posts viejos fuera de la galería, historias caducadas, red caída). */
    mediaSnap?: { id: string; caption: string; type: string; thumb: string; permalink: string; timestamp: string; at: number; perdido?: boolean };
    /** EXCEPCION-IG-1 · @usuarios de Instagram que NO deben disparar este flujo (ya
     *  compraron, ya son clientes, etc.). Separados por coma, con o sin @. Si quien
     *  comenta está en la lista, el flujo se salta para él (los demás siguen igual). */
    excludeUsers?: string;
  };
  start: string;
  nodes: Record<string, FlowNode>;
}

export async function listFlows(): Promise<Flow[]> {
  return (await dbListFlows()) as unknown as Flow[];
}
export async function saveFlow(f: Flow) {
  await dbUpsertFlow(f.id, f as unknown as Record<string, unknown>);
  // BACKFILL del seguimiento por inactividad: si el flujo tiene el seguimiento activo, rearma
  // los runs que quedaron aparcados «para siempre» (next_run=FU_FAR, puestos cuando estaba OFF)
  // para que el reenganche 1 les llegue tras el silencio configurado. Idempotente (solo toca
  // los FU_FAR) y best-effort (jamás rompe el guardado del flujo). Sin esto, activar el
  // seguimiento no rescataría a quien YA estaba callado en el flujo (el caso real del owner).
  if (f.fuEnabled) {
    try {
      const n = await dbRearmWaitingForFlow(f.id, Math.max(1, Number(f.fuT1) || 90));
      if (n > 0) console.log("[followup] rearmados " + n + " runs en espera del flujo " + f.id);
    } catch (e) { console.warn("[followup] rearm:", (e as Error).message); }
  }
}
export async function removeFlow(id: string): Promise<boolean> {
  return dbDeleteFlow(id);
}

// ============================================================
// FLOW-LOGS («Ver Logs») · Registro de cada movimiento real de un contacto dentro
// del flujo. fev() es fire-and-forget y dbFlowEventAdd nunca lanza → el registro
// JAMÁS puede frenar ni romper el motor. Un evento por paso ejecutado + eventos de
// ciclo de vida (entró / respondió / completó / cancelado / salió-por-compra).
// ============================================================
// PRUEBA-CANAL-1 · exportada porque el rescate diferido de Instagram (index.ts) es
// otra puerta de arranque y su veto de modo prueba debe verse en el mismo registro.
export function fev(flowId: string, phone: string, event: string, nodeId = "", detail = ""): void {
  void dbFlowEventAdd(flowId, phone, event, nodeId, detail);
}
/** Resumen humano de un paso para el registro: [evento, detalle]. */
function fevNode(node: FlowNode): [string, string] {
  const t = (s?: string, n = 120) => String(s || "").replace(/\s+/g, " ").slice(0, n);
  switch (node.type) {
    case "message": return ["mensaje", t(node.text) + (node.link ? " · con enlace" : "")];
    case "ask": return ["pregunta", t(node.text)];
    case "buttons": return ["opciones", t(node.text, 80) + " [" + t((node.options || []).map((o) => o.label).join(" · "), 90) + "]"];
    case "follow": return ["pedir seguir", t(node.text, 80)];
    case "condition":
      return ["condición", node.source === "hasTag" ? "¿tiene etiqueta «" + t(node.value, 40) + "»?" : node.source === "linkOpened" ? "¿abrió el enlace" + (node.value ? " «" + t(node.value, 40) + "»" : "") + (node.sinceLastLink ? " (tras el último enviado)" : "") + (node.notPurchased ? " y no ha comprado" : "") + "?" : node.source === "purchased" ? "¿ha comprado" + (node.sinceLastLink ? " (tras el último enlace)" : "") + "?" : node.source === "emailOpened" ? "¿abrió el correo?" : node.source === "var" ? "¿" + t(node.varName, 30) + " " + t(node.op, 12) + " " + t(node.value, 30) + "?" : "¿respondió algo?"];
    case "delay": return ["espera", esperaHumana(node.minutes, node.seconds)];
    case "action": {
      const a: string[] = [];
      if (node.addTag) a.push("etiqueta +«" + t(node.addTag, 40) + "»");
      if (node.setStage) a.push("etapa «" + t(node.setStage, 30) + "»");
      if (typeof node.setScore === "number") a.push("score " + node.setScore);
      // AVISO-POR-KIND-1 · un nodo cargado por la API puede llevar solo kind:"notify".
      if (node.notify || node.kind === "notify") a.push("aviso al closer");
      if (node.escalate) a.push("pasa a humano");
      if (node.toBot) a.push("vuelve al bot");
      if (node.startFlow) a.push("lanza otro flujo");
      if (node.syncTarget || node.kind === "sync") a.push("sincroniza con tu web");
      if (node.kind === "book") a.push("enlace de reserva");
      return ["acción", a.join(" · ") || "(vacía)"];
    }
    case "end": return ["fin", ""];
    default: return ["paso", String((node as { type?: string }).type || "")];
  }
}

async function finish(run: FlowRun) {
  run.status = "done";
  // STOP-CAS · guardado con guarda: si el panel canceló el run (Stop/Detener) mientras
  // esta cadena estaba en vuelo, NO lo reescribimos a 'done' ni fingimos que completó.
  const live = await dbSaveFlowRunIfLive(run);
  if (!live) return;
  fev(run.flow_id, run.phone, "completó", run.node_id, "");
}

/**
 * NOMBRE-ASISTENTE-1 · A quién se le dice al CONTACTO que se le pasa. El literal
 * «Carla» —una persona real del operador— viajaba dentro de los mensajes que
 * recibe el contacto de cualquier cliente del panel: en un producto de marca
 * blanca eso es un nombre ajeno metido en la conversación de otro negocio.
 *
 * Se usa el nombre del negocio cuando está configurado (Ajustes → Nombre del
 * negocio, el mismo `brand.name` que titula el panel) y, si no lo está, una
 * frase neutra SIN nombre propio. Nunca un nombre de persona escrito a fuego.
 *
 * MARCA-DERIVACION-1 · el nombre del negocio se edita en DOS sitios del panel y
 * los dos son legítimos: Ajustes → Marca escribe `brand.name`, y la cabecera del
 * Dashboard —el sitio más visible— escribe el rótulo del workspace (`ws.label`).
 * Mirando sólo `brand.name`, a quien nombró su negocio desde el Dashboard le
 * salía la frase neutra en los mensajes que reciben sus propios contactos. Se
 * toma el primero que esté relleno.
 */
/** El rótulo de fábrica de un workspace recién creado (db.ts). No es el nombre de
 *  ningún negocio, así que no se mete en la conversación de un contacto. */
const ROTULO_DE_FABRICA = /^negocio principal$/i;
export async function equipoDeDerivacion(): Promise<string> {
  let negocio = String(get("brand.name") || "").trim();
  if (!negocio) {
    // Sólo si Marca está vacía: una lectura más, y sólo en el momento de derivar.
    try {
      const ws = await dbGetWorkspace(currentWorkspaceId());
      negocio = String(ws?.label || "").trim();
    } catch { /* si la base no contesta, frase neutra: nunca un nombre inventado */ }
  }
  if (!negocio || ROTULO_DE_FABRICA.test(negocio)) return "una persona del equipo";
  return "el equipo de " + negocio;
}

/** TEXTO-EN-BOTONES-1 · ¿el texto libre es una duda de compra que merece una persona?
 *  Pregunta explícita o palabras de dinero, pago o condiciones. Un «hola», «vale» o «ya
 *  lo vi» NO lo es: a esos se les recuerda pulsar. */
function esDudaReal(text: string): boolean {
  const t = String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (t.includes("?")) return true;
  return /\b(precio|cuanto (cuesta|vale|es)|coste|costo|pago|pagar|plazos?|cuotas?|tarjeta|transferencia|factura|garantia|devolucion|reembolso|duda|dudas|no entiendo|como funciona|que incluye)\b/.test(t);
}

/** Avisa por WhatsApp a los closers (pool) de un lead. Con plantilla aprobada llega
 *  aunque el closer no haya escrito al bot en 24h; sin plantilla, texto plano (solo en ventana). */
async function notifyClosers(
  leadPhone: string,
  node: { notifyPhones?: string; notifyTemplate?: string; notifyLang?: string; notifyParams?: string[] },
  vars?: Record<string, string>,
): Promise<void> {
  const phones = String(node.notifyPhones || "")
    .split(",")
    .map((p) => p.trim().replace(/[^\d+]/g, ""))
    .filter(Boolean);
  if (!phones.length) return;
  const ct = await getContact(leadPhone);
  const name = ct?.name || leadPhone;
  const tpl = (node.notifyTemplate || "").trim();
  const lang = (node.notifyLang || "es").trim();
  const text = `🔔 Nuevo lead cualificado: ${name} (${leadPhone}). Ábrelo en la bandeja para atenderlo.`;
  // AVISO-VARIABLES-1 · Meta rechaza un parámetro vacío o con saltos de línea: cada valor
  // se resuelve contra el contacto y el run, se aplana y, si queda vacío, lleva «—».
  const params = Array.isArray(node.notifyParams) && node.notifyParams.length
    ? node.notifyParams.map((p) => substituteVars(String(p ?? ""), ct, { strict: false, extra: vars || {} }).replace(/\s+/g, " ").trim() || "—")
    : [name, leadPhone];

  // NOTIFY-1 · No fallar en silencio. Antes esto era un catch con console.error: si el
  // aviso al closer no salía (plantilla inexistente, fuera de ventana de 24h…), nadie
  // se enteraba. Ahora cada intento queda en Actividad con el motivo real.
  const logFail = async (to: string, reason: string) => {
    console.error("[flow] notify closer:", reason);
    try {
      await logActivity({
        source: "wa-send",
        level: "error",
        summary: `Aviso al closer ${to.slice(0, 4)}***${to.slice(-3)} NO se envió: ${reason.slice(0, 140)}`,
        payload: { file: "flows.ts", fn: "notifyClosers", to: to.slice(0, 4) + "***" + to.slice(-3), reason: reason.slice(0, 400) },
      });
    } catch { /* ni el log debe tirar el flujo */ }
  };

  // Un nombre de plantilla NO puede llevar espacios ni {{...}}: si el usuario dejó ahí
  // una DESCRIPCIÓN (el caso real: "El lead: {{1}}=nombre..."), Meta la rechaza y el
  // aviso muere. Lo detectamos ANTES de gastar la llamada y damos un error accionable.
  const tplLooksLikeName = tpl && !/\s/.test(tpl) && !tpl.includes("{{");
  if (tpl && !tplLooksLikeName) {
    for (const to of phones) {
      if (to === leadPhone) continue;
      await logFail(to, `"${tpl.slice(0, 40)}…" no es el NOMBRE de una plantilla (un nombre no lleva espacios ni {{ }}). Elige una plantilla aprobada en el paso «Avisar a un closer».`);
    }
    return;
  }

  for (const to of phones) {
    if (to === leadPhone) continue; // no avisar sobre el propio lead
    // NOTA: NO se bloquea avisar a una línea propia. Los números +376 (Carla/Principal)
    // están en modo COEXISTENCE (app verde de WhatsApp Business en el móvil + espejo al
    // panel), así que un aviso a Carla SÍ le llega a su app. Solo una línea de SOLO-API
    // (como Setter) no tendría app; eso queda a criterio del que configura el número.
    try {
      let sent = true;
      if (tpl) await sendTemplate(to, tpl, lang, params);
      else sent = await sendText(to, text);
      // NOTIFY-3 · sendText NO lanza: devuelve false si Meta rechaza (típico: ventana de 24 h
      // cerrada, el closer no escribió al bot). Sin este chequeo se registraba un ÉXITO falso y
      // el dueño creía avisado a Carla cuando no llegó nada. Con plantilla aprobada sí llega.
      if (!sent) { await logFail(to, "el envío de texto no salió (ventana de 24 h cerrada o número no válido). Configura una plantilla aprobada para avisar fuera de esa ventana."); continue; }
      // NOTIFY-2 · Dejar rastro del ÉXITO en Actividad (antes solo se registraban los
      // fallos): así el dueño VE que el aviso salió y para quién, sin adivinar.
      try {
        await logActivity({
          source: "wa-send",
          level: "info",
          summary: `Aviso al closer ${to.slice(0, 4)}***${to.slice(-3)} enviado por el lead ${name}`,
          payload: { file: "flows.ts", fn: "notifyClosers", to: to.slice(0, 4) + "***" + to.slice(-3), lead: leadPhone, via: tpl ? `plantilla ${tpl}` : "texto" },
        });
      } catch { /* el log nunca debe tirar el flujo */ }
    } catch (e) {
      await logFail(to, (e as Error).message || "error al enviar");
    }
  }
}

/** Ejecuta el flujo desde run.node_id hasta que espere/termine. */
/**
 * Pasos que YouTube puede ejecutar de verdad. Los demás necesitan o bien que la
 * persona te CONTESTE (preguntar, botones, pedir seguir) —imposible: no hay DM—,
 * o bien un CONTACTO con teléfono/email al que etiquetar o sincronizar, que en un
 * comentario de YouTube no existe. El constructor ya no los ofrece; esto es la red
 * de seguridad para un flujo viejo o importado.
 */
const YT_NODES = new Set(["message", "condition", "delay", "end"]);

/**
 * Respuesta redactada por el bot (nodo message con ai:true).
 * Resuelve DOS cosas a la vez que pedía el owner:
 *   - anti-spam: la IA escribe un texto DISTINTO a cada comentario (YouTube
 *     penaliza responder mucho y siempre lo mismo);
 *   - lógica hacia el objetivo: se le da el "goal" (aiPrompt) y, si el nodo
 *     lleva enlace, se le ordena cerrar invitando a tocarlo — pero SIN escribir
 *     ella la URL (el enlace lo añade say(), ya con UTM). Así siempre acaba
 *     empujando a lo que queremos (p.ej. dar el enlace).
 * Si la generación falla o viene vacía, el caller usa el texto fijo de reserva.
 */
/**
 * VARIANTES-1 · Texto a enviar de un nodo `message`: uno al azar entre el principal
 * y sus alternativas. Sin alternativas → el de siempre (cero cambio de conducta en
 * los flujos ya creados).
 */
export function pickMessageText(node: { text?: string; variants?: string[] }): string {
  const opts = [node.text || "", ...(Array.isArray(node.variants) ? node.variants : [])]
    .map((t) => String(t || "").trim())
    .filter(Boolean);
  if (!opts.length) return node.text || "";
  if (opts.length === 1) return opts[0];
  return opts[Math.floor(Math.random() * opts.length)];
}

/** PUBLIC-AI-1 · Escribe con IA la respuesta PÚBLICA a un comentario de IG/FB.
 *  Hermano de igAiSystem (automations.ts), reescrito aquí a propósito: importarlo
 *  cerraría el ciclo flows → automations → flows. A diferencia del de allí, la regla
 *  anti-plantilla va SIEMPRE, porque es la razón de ser de esta opción.
 *  Devuelve "" si el modelo falla: quien llama se queda con el texto de reserva. */
export async function publicAiReply(flow: Flow, canal: "ig" | "fb", comentario: string, quien: string): Promise<string> {
  const kb = get("knowledge.negocio") || "";
  const brand = get("brand") || "";
  const red = canal === "fb" ? "Facebook" : "Instagram";
  const privado = canal === "fb" ? "Messenger" : "el DM";
  const sys = [
    `Eres el asistente de la marca respondiendo PÚBLICAMENTE a un comentario en ${red}.`,
    "Responde en español, máximo 2 frases, cercano y útil, 1-2 emojis como mucho.",
    REGLA_NO_INVENTAR, // BARRERA-INVENTA-1
    `Ya le estás enviando el contenido por privado: invítale a mirar ${privado}.`,
    "Responde SIEMPRE de forma distinta y específica a ESTE comentario (menciona algo concreto de lo que dice). Las respuestas calcadas se consideran spam.",
    "No uses markdown ni listas. Nada de #hashtags salvo que la persona los pida.",
    REGLA_IDENTIDAD_IA, // AI-ACT-IDENTIDAD-1
    flow.publicAiPrompt ? `Objetivo de esta respuesta: ${flow.publicAiPrompt}` : "",
    `\n# Base de conocimiento del negocio\n${kb || KB_VACIA}`, // BARRERA-INVENTA-1
    brand ? `\n# Voz de marca\n${brand}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    return await quickReply(sys, `Comentario de @${String(quien || "").replace(/^@/, "") || "alguien"}: "${comentario}"`);
  } catch {
    return "";
  }
}

export async function flowAiReply(r: FlowRun, goal: string, hasLink: boolean): Promise<string> {
  // VARS-RUN-1 (T03) · el objetivo también resuelve variables del run y del
  // contacto ({{correo_asunto}}, {{reserva_evento}}, {{nombre}}…): sin esto,
  // un aiPrompt con moustaches se los pasaba LITERALES al modelo.
  if (goal && goal.indexOf("{{") >= 0) {
    try {
      const c = await getContact(r.phone);
      goal = substituteVars(goal, c, { strict: false, extra: r.vars });
    } catch { /* si no se puede resolver, va tal cual (como hasta ahora) */ }
  }
  const kb = get("knowledge.negocio") || "";
  const brand = get("brand") || "";
  const yt = r.vars.__ch === "yt";
  const li = r.vars.__ch === "li";
  const red = yt ? "YouTube" : li ? "LinkedIn" : r.vars.__ch === "ig" ? "Instagram" : r.vars.__ch === "fb" ? "Facebook" : "WhatsApp";
  const sys = [
    yt
      ? "Eres el asistente de la marca respondiendo PÚBLICAMENTE a un comentario en YouTube."
      : li
      ? "Eres el asistente de la marca respondiendo PÚBLICAMENTE, como la Página de empresa, a un comentario en LinkedIn. Tono profesional B2B, cercano y sin jerga."
      : `Eres el asistente de la marca respondiendo a un cliente por ${red}.`,
    "Responde en español, cercano y útil, máximo 2 frases, 1-2 emojis como mucho, sin markdown ni listas.",
    REGLA_NO_INVENTAR, // BARRERA-INVENTA-1
    "Responde de forma DISTINTA y específica a lo que dice esta persona (menciona algo concreto de su mensaje). Nunca repitas una fórmula calcada: el texto repetido se considera spam.",
    yt ? "En YouTube NO hay mensajes privados: nunca digas que le escribes por privado ni le pidas el correo." : "",
    li ? "En LinkedIn NO hay mensajes privados desde la Página: nunca digas que le escribes por privado ni le pidas el correo." : "",
    hasLink ? "Cierra invitando a tocar el enlace que aparece justo debajo. NO escribas tú ninguna URL: el enlace se añade solo." : "",
    REGLA_IDENTIDAD_IA, // AI-ACT-IDENTIDAD-1
    goal ? `Objetivo de esta respuesta: ${goal}` : "",
    `\n# Base de conocimiento del negocio\n${kb || KB_VACIA}`, // BARRERA-INVENTA-1
    brand ? `\n# Voz de marca\n${brand}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const input = r.vars.__last ? `Comentario de la persona: "${r.vars.__last}"` : "Saluda y cumple el objetivo.";
  try {
    return await quickReply(sys, input);
  } catch {
    return "";
  }
}

const FU_FAR = 8.64e15; // "nunca" (waiting sin seguimiento no lo mira el followupTick)
// CARRERA-TICK-1 (incidente valentinpardo/SEEDANCE 2026-08-14): los arranques creaban
// el run 'active' con next_run=Date.now() — YA VENCIDO — y lo persistían ANTES de
// enviar el primer paso (2-5 s en vuelo). Si flowTick (cada 30 s) barría en esa
// ventana, dbDueFlowRuns devolvía el run recién nacido y step() lo remataba como
// 'done' («Completada» falsa a los 3 s de entrar): el usuario pulsaba el botón y el
// resto del flujo no llegaba jamás. Los runs nacen ahora con esta gracia: run() los
// ejecuta en línea igual que siempre (el next_run real lo fijan delay/parkWaiting), y
// si el proceso muere a mitad del arranque, el barrido los encuentra pasada la gracia
// y los RESCATA (ver step(): interactivo → re-aparcar; no interactivo → cierre explícito).
const RUN_GRACE_MS = 15 * 60_000;
/** DOBLE-ARRANQUE-1 · dos entradas al MISMO flujo separadas por menos de esto son la misma:
 *  la segunda no arranca nada. Los duplicados medidos en producción iban de 0 a 11 segundos;
 *  con 90 s se cubren de sobra sin estorbar a una re-entrada de verdad (que llega horas
 *  después, cuando la persona vuelve a escribir la palabra clave). */
const DOBLE_ARRANQUE_MS = 90_000;
// ── FRANJA HORARIA (hora de España) ──────────────────────────────────────────
/** FRANJA-PAIS-1 · zona horaria válida para Intl, o Europe/Madrid si no lo es (o viene vacía). */
// CAPTURA-EMAIL-3 · ¿este paso está pidiendo un correo?
//
// Antes se compraba el nombre del campo con una igualdad EXACTA: email|correo|e-mail|mail. Un
// flujo que guardara en «tu correo», «email_lead» o «correo2» no validaba NADA: se tragaba un
// «vale» tal cual, mandaba el enlace y el lead se quedaba guardado sin correo. Y el constructor
// solo lo SUGERÍA con un texto de ayuda; no había forma de obligarlo.
//
// Ahora el paso puede decirlo (expect), y si no lo dice se mira si el nombre del campo lleva un
// TOKEN de correo: se parte por separadores y por mayúsculas intercaladas y se quitan los
// dígitos del final. Así entran «tu correo», «email_lead», «correoDelLead» y «correo2», y NO
// entran «mailing» ni «emailing» — encender la validación en un campo que no es un correo
// dejaría a la persona re-preguntando, que es el fallo contrario y también molesta.
const TOKENS_CORREO = new Set(["email", "emails", "mail", "mails", "correo", "correos"]);
export function esPasoDeCorreo(node: { saveAs?: string; expect?: string } | null | undefined): boolean {
  if (!node) return false;
  if (node.expect === "email") return true;
  if (node.expect === "text") return false; // salida de emergencia declarada por el flujo
  return String(node.saveAs || "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.replace(/\d+$/, ""))
    .filter(Boolean)
    .some((t) => TOKENS_CORREO.has(t));
}

// CAPTURA-EMAIL-4 · cuántas veces se le pide el correo. Lo dice el flujo; 3 si no dice nada.
export function topeIntentosCorreo(node: { maxTries?: unknown } | null | undefined): number {
  const n = Math.floor(Number(node?.maxTries));
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : 3;
}

/** Ids a los que puede saltar un paso: la salida normal, las dos ramas de una condición y
 *  las opciones de un paso de botones. */
function salidasDe(node: unknown): string[] {
  const n = (node || {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["next", "yes", "no"]) if (typeof n[k] === "string" && n[k]) out.push(n[k] as string);
  const ops = n.options;
  if (Array.isArray(ops)) for (const o of ops) { const v = (o as { next?: unknown })?.next; if (typeof v === "string" && v) out.push(v); }
  return out;
}

/** CAPTURA-EMAIL-4 · ¿a partir de aquí el flujo entrega algo POR CORREO?
 *
 *  Es la diferencia que importa. Si el premio va en la conversación, seguir sin correo no le
 *  quita nada a la persona: lo recibe igual. Pero si el flujo manda el contacto a la web para
 *  que ALLÍ le envíen el correo, sin correo válido no se manda nada — y el paso siguiente
 *  suele decirle «revisa tu correo en unos minutos». Eso es prometerle algo que no va a llegar.
 *
 *  Se recorre el flujo hacia delante desde el paso siguiente, sin repetir y con tope, porque un
 *  flujo puede tener ciclos. */
export function entregaPorCorreo(flow: { nodes?: Record<string, unknown> } | null | undefined, desde?: string): boolean {
  const nodes = (flow?.nodes || {}) as Record<string, unknown>;
  const vistos = new Set<string>();
  const cola: string[] = desde ? [desde] : [];
  while (cola.length && vistos.size < 300) {
    const id = cola.shift() as string;
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    const n = nodes[id] as { type?: string; kind?: string; syncTarget?: string } | undefined;
    if (!n) continue;
    if (n.type === "action" && (n.kind === "sync" || !!n.syncTarget)) return true;
    for (const x of salidasDe(n)) cola.push(x);
  }
  return false;
}

/** CAPTURA-EMAIL-4 · qué hacer cuando se acaban los intentos. Lo manda el flujo. */
export function queHacerSinCorreo(
  flow: { nodes?: Record<string, unknown> } | null | undefined,
  node: { onFail?: unknown; next?: string } | null | undefined,
): "continue" | "human" {
  const m = String(node?.onFail || "auto");
  if (m === "human") return "human";
  if (m === "continue") return "continue";
  return entregaPorCorreo(flow, node?.next) ? "human" : "continue";
}

export function quietZone(tz?: string): string {
  const z = String(tz || "").trim();
  if (!z) return "Europe/Madrid";
  try { new Intl.DateTimeFormat("en-GB", { timeZone: z }); return z; } catch { return "Europe/Madrid"; }
}
/** Minuto del día (0-1439) de un instante en esa zona (DST incluido vía Intl). */
function zoneMinutes(ts: number, tz?: string): number {
  const s = new Intl.DateTimeFormat("en-GB", { timeZone: quietZone(tz), hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts));
  const [h, m] = s.split(":").map(Number);
  return ((h || 0) % 24) * 60 + (m || 0);
}
/** Si `ts` cae dentro de la franja silenciosa (from→to, envolviendo medianoche), lo pospone
 *  al próximo `to`. Fuera de la franja devuelve `ts` tal cual. Horas mal formadas → defaults. */
export function clampQuietHours(ts: number, fromHHMM?: string, toHHMM?: string, tz?: string): number {
  // FRANJA-HORA-1 · «12» o «4» valen como 12:00 y 04:00 (también «12.30»). Antes solo casaba
  // HH:MM y una hora suelta caía EN SILENCIO a los valores por defecto (23:30→07:30): el
  // dueño creía tener una franja y corría otra distinta. Lo que se escribe es lo que corre.
  const parse = (v: string | undefined, def: number) => {
    const m = /^(\d{1,2})(?:[:.](\d{1,2}))?$/.exec(String(v || "").trim());
    return m ? (Number(m[1]) % 24) * 60 + Math.min(59, Number(m[2] || 0)) : def;
  };
  const from = parse(fromHHMM, 23 * 60 + 30);
  const to = parse(toHHMM, 7 * 60 + 30);
  if (from === to) return ts; // franja vacía = desactivada
  const t = zoneMinutes(ts, tz); // FRANJA-PAIS-1 · en la hora del país del flujo
  const inQuiet = from > to ? t >= from || t < to : t >= from && t < to;
  if (!inQuiet) return ts;
  const delta = t < to ? to - t : 24 * 60 - t + to;
  return ts + delta * 60_000;
}
/** Aplica la franja del flujo a un instante de entrega (si está activa y no es un run de test). */
function applyQuiet(flow: Flow, r: FlowRun, ts: number): number {
  // PROBAR-FLUJO-1 · una prueba lanzada desde «Probar» tampoco espera a la mañana: esperas
  // reales, pero sin la franja de silencio (si no, probar de noche aplaza todo a las 08:00).
  if (!flow.quietEnabled || r.vars.__test === "1" || r.vars.__probar === "1") return ts;
  return clampQuietHours(ts, flow.quietFrom, flow.quietTo, flow.quietTz);
}
/** Aparca el run en ESPERA de respuesta. Si el flujo tiene el seguimiento por inactividad
 *  activo, arma el reloj del reenganche 1 (respetando modo test = 1 min) y pone la cuenta
 *  de reenganches a cero (nodo de espera nuevo). Si no, next_run="nunca". */
async function parkWaiting(flow: Flow, r: FlowRun): Promise<void> {
  r.status = "waiting";
  // __since = «esperando su respuesta DESDE». Lo usa el sondeo IG como corte para no reanudar
  // con un mensaje anterior al botón. Se fija en CADA (re)aparcado (también cuando re-pregunta
  // en el mismo nodo) y el reenganche por inactividad NO lo mueve (el CAS reescribe vars pero
  // preserva __since), así una respuesta previa del lead nunca se descarta por avanzar la cadencia.
  r.vars.__since = String(Date.now());
  // IG-SIN-NOENTENDI-1 · escribió en vez de pulsar: sin insistencias hasta que pulse o le contestes.
  if (flow.fuEnabled && r.vars.__fuPausa !== "1") {
    const t1 = r.vars.__test === "1" ? 1 : Math.max(1, Number(flow.fuT1) || 90);
    r.next_run = applyQuiet(flow, r, Date.now() + t1 * 60_000); // franja: sin reenganches de madrugada
    delete r.vars.__fu; // el lead acaba de (re)entrar en espera → cadencia de reenganche desde cero
  } else {
    r.next_run = FU_FAR;
  }
  // STOP-CAS · si el panel canceló el run mientras la cadena estaba en vuelo (botón
  // Stop/Detener), este guardado NO debe resucitarlo pisando el 'cancelled' — el upsert
  // ciego de antes lo hacía y el lead seguía recibiendo mensajes tras el Stop.
  await dbSaveFlowRunIfLive(r);
}

async function run(flow: Flow, r: FlowRun): Promise<void> {
  // ENLACE-TAL-CUAL-1 · say() no recibe el flujo: el modo de enlaces viaja en el run.
  r.vars.__rawlinks = flow.rawLinks ? "1" : "";
  // ENLACE-TARJETA-1 · Por defecto TODO paso con enlace sale como tarjeta (imagen grande,
  // texto, dominio al pie y botón); solo se desactiva a propósito por flujo (linkCard=false).
  r.vars.__linkcard = flow.linkCard === false ? "" : "1";
  // REGLA DE PARADA (stopTag) · Si el flujo declara una etiqueta de corte y el contacto YA
  // la tiene (p.ej. "Inscrito LM" = ya compró), se cancela: no tiene sentido seguir el
  // cierre con quien ya cerró. Se mira UNA sola vez por entrada a run() (arranque,
  // reanudación por respuesta, o vencimiento de una espera), no por nodo → cubre los ~40
  // pasos sin ramificar el grafo con una condición antes de cada uno. Es "perezoso" a
  // propósito: corta en el PRÓXIMO paso (el webhook de systeme.io lo cancela al instante).
  if (flow.stopTag && flow.stopTag.trim()) {
    try {
      const c = await getContact(r.phone);
      const stop = flow.stopTag.trim().toLowerCase();
      if ((c?.tags || []).some((t) => String(t || "").trim().toLowerCase() === stop)) {
        await dbCancelFlowRunsForPhone(r.phone, flow.id);
        fev(flow.id, r.phone, "salió · compró", r.node_id, "regla de compra («" + flow.stopTag.trim() + "»): validación antes del paso");
        try { recordWebhook("whatsapp", "🛑 flujo \"" + flow.name + "\" detenido: el contacto ya tiene \"" + flow.stopTag.trim() + "\""); } catch { /* noop */ }
        return;
      }
    } catch { /* si no se puede leer el contacto, el flujo sigue igual que siempre */ }
  }
  // MET-AUTO-10-FIN · los mensajes programados respetan los cambios de estado. Antes solo
  // cortaba la etiqueta de compra del flujo (y solo si se configuraba): quien pedía no
  // recibir más mensajes, compraba o reservaba DESPUÉS de entrar seguía recibiendo la
  // secuencia. __inicio = primera entrada a run(); solo cuenta lo ocurrido después, así
  // un flujo que arranca POR una compra o una reserva no se corta a sí mismo.
  if (!r.vars.__inicio) r.vars.__inicio = String(Date.now());
  try {
    const inicio = Number(r.vars.__inicio) || 0;
    const c = await getContact(r.phone);
    const f = ((c?.fields || {}) as Record<string, string>);
    const tras = (v: unknown): boolean => { const t = Date.parse(String(v || "")); return t > 0 && inicio > 0 && t >= inicio; };
    const motivo = (c?.tags || []).includes(ETIQUETA_NO_MOLESTAR) ? "baja"
      : (tras(f.purchased_at) || tras(f.last_purchase_at)) ? "compró"
      : tras(f.reserva_at) ? "reservó" : "";
    if (motivo) {
      await dbCancelFlowRunsForPhone(r.phone, flow.id);
      fev(flow.id, r.phone, "salió · " + motivo, r.node_id, "validación antes del paso: " + (motivo === "baja" ? "pidió no recibir más mensajes" : motivo + " después de entrar en el flujo"));
      return;
    }
  } catch { /* si no se puede leer el contacto, el flujo sigue igual que siempre */ }
  for (let i = 0; i < 40; i++) {
    const node = flow.nodes[r.node_id];
    if (!node) return finish(r);
    // FLOW-LOGS · un evento por paso ejecutado (mensaje/espera/opciones/condición/acción…).
    // En try/catch: ni un nodo corrupto (p.ej. buttons sin options) puede romper el motor.
    try { const [ev, det] = fevNode(node); fev(r.flow_id, r.phone, ev, r.node_id, det); } catch { /* el registro jamás rompe el motor */ }

    if ((r.vars.__ch === "yt" || r.vars.__ch === "li") && !YT_NODES.has(node.type)) {
      console.warn(`[flow] '${flow.name}': el paso '${node.type}' no existe en ${r.vars.__ch === "li" ? "LinkedIn" : "YouTube"} (no hay DM ni contacto). El flujo termina aquí.`);
      return finish(r);
    }

    if (node.type === "message") {
      // VARIANTES-1 · Si el paso tiene textos alternativos, se elige UNO al azar.
      // Evita que todas las personas reciban la misma frase calcada (Instagram lo
      // trata como spam y oculta las respuestas). La IA, si está activada, sigue
      // teniendo prioridad; las variantes son el modo "yo escribo el copy".
      let text = pickMessageText(node);
      // AI-ACT-FLUJO-1 · sólo se avisa cuando el texto lo ESCRIBE la IA. Un paso con
      // texto fijo (o uno con IA cuya generación falló y cae a su texto de reserva) no
      // es un sistema de IA interactuando: no lleva aviso, y así debe ser.
      let avisoIa = "";
      let avisoFinal = "";
      if ((node as { ai?: boolean }).ai) {
        const gen = await flowAiReply(r, (node as { aiPrompt?: string }).aiPrompt || "", !!node.link);
        if (gen) {
          text = gen; // el texto fijo queda de reserva si la IA falla
          avisoIa = await avisoIaPendiente(r.phone);
          // YouTube y LinkedIn son respuestas públicas bajo un comentario: el aviso va al final.
          if (avisoIa && (r.vars.__ch === "yt" || r.vars.__ch === "li")) avisoFinal = avisoIa;
          else if (avisoIa) text = avisoIa + "\n\n" + text;
        }
      }
      await say(r, text, node.link, (node as { linkLabel?: string }).linkLabel, (node as { linkImage?: string }).linkImage, avisoIa ? { avisoIa: true, ...(avisoFinal ? { avisoFinal } : {}) } : undefined);
      // El adjunto del paso va DESPUÉS del texto: en WhatsApp siempre; en IG/FB
      // solo con ventana abierta, y si no llega queda dicho (nunca en silencio).
      const media = (node as { media?: { id: string; kind?: string; name?: string; mime?: string } }).media;
      if (media && media.id) await sendFlowMedia(r, media);
      if (!node.next) return finish(r);
      r.node_id = node.next;
      continue;
    }
    if (node.type === "ask") {
      // CORREO-UNA-VEZ-1 · Si ya dio su correo (en este flujo o en otro), no se le vuelve a
      // pedir: se rellena la variable con el que tenemos y se pasa directo a la entrega.
      if (esPasoDeCorreo(node) && node.saveAs) {
        const em = String((await getContact(r.phone).catch(() => null))?.email || "").trim().toLowerCase();
        if (/^[^@\s]+@[^@\s]+\.\p{L}{2,}$/iu.test(em)) {
          r.vars[node.saveAs] = em;
          fev(flow.id, r.phone, "aviso", r.node_id, "ya tenía correo → se salta la pregunta");
          if (!node.next) return finish(r);
          r.node_id = node.next;
          continue;
        }
      }
      await say(r, node.text);
      await parkWaiting(flow, r);
      return;
    }
    if (node.type === "follow") {
      // YA-TE-SIGUE-1 · Antes de pedir nada, MIRAR si ya te sigue. A quien ya te sigue
      // pedirle que te siga queda fatal (y le añade un paso para nada): si Instagram
      // confirma que sí, la puerta se salta y va directo al contenido.
      //
      // Solo se salta con un SÍ rotundo. Si la respuesta es "no" o "no se sabe" (la
      // consulta falla, o la persona aún no ha abierto conversación y Meta no da el
      // dato), se pide igual: preferimos pedirlo de más a regalar el contenido sin
      // comprobarlo. Y el `skipIfFollows:false` deja forzar que SIEMPRE se pida.
      if (r.vars.__ch === "ig" && (node as { skipIfFollows?: boolean }).skipIfFollows !== false) {
        const yaSigue = await fetchIgFollowStatus(r.phone);
        if (yaSigue === true) {
          // OJO · Saltar el paso a secas tiene un efecto colateral que no es evidente:
          // el TAP en el botón era la ÚNICA interacción del usuario en todo el flujo, y
          // es lo que abre la ventana de mensajería de 24 h de Meta. Sin ese tap, el
          // PRIMER mensaje siguiente todavía sale (gasta la respuesta privada del
          // comentario), pero el SEGUNDO ya no tiene por dónde salir y Meta lo rechaza:
          // la persona se queda a medias y encima etiquetada como si hubiera terminado.
          //
          // Por eso el salto limpio solo se hace si YA hay ventana abierta. Si no la
          // hay, no le pedimos que nos siga —que es justo lo que molestaba— pero sí le
          // pedimos un toque para poder escribirle.
          const c = await getContact(r.phone);
          if (c && inWindow(c)) {
            recordWebhook("instagram", "✅ ya te sigue y hay ventana abierta → se salta el paso y va directo al contenido");
            if (!node.next) return finish(r);
            r.node_id = node.next;
            continue;
          }
          recordWebhook("instagram", "✅ ya te sigue, pero sin ventana abierta → se le pide un toque (no que siga) para poder escribirle");
          const gracias =
            (node as { alreadyFollowsText?: string }).alreadyFollowsText ||
            get("instagram.alreadyFollowsText") ||
            "¡Gracias por seguirme! 🙌 Pulsa aquí y seguimos 👇";
          const okLabel = ((node as { alreadyFollowsLabel?: string }).alreadyFollowsLabel || "Vamos allá 👇").slice(0, 20);
          try {
            await sendIgQuickReplies({ recipientId: r.phone, commentId: r.vars.__cid, text: gracias, replies: [okLabel] });
            if (r.vars.__cid) delete r.vars.__cid; // solo 1 private reply por comentario
            await flowLog(r.phone, "assistant", gracias, { btns: [{ t: okLabel }] }); // PLANTILLA-BANDEJA-1
          } catch (e) {
            recordWebhook("instagram", "⚠️ no se pudo enviar el toque de continuación: " + ((e as Error).message || "").slice(0, 60));
            try { await say(r, gracias); } catch { /* ya está registrado */ }
          }
          await parkWaiting(flow, r);
          return;
        }
      }
      // Follow-gate (Instagram): pide seguir y muestra un BOTÓN tappable ("Listo").
      // Al pulsarlo, IG manda el título como mensaje y resumeFlow continúa. Hoy no
      // verifica el follow de verdad (se confía en la confirmación); con la Meta App
      // aprobada se puede comprobar con is_user_follow_business (User Profile API).
      // Varias redacciones, igual que un paso «Mensaje»: este texto es lo PRIMERO que
      // recibe la persona (es la única respuesta privada que Meta permite por
      // comentario), así que repetir siempre el mismo párrafo es justo lo que Instagram
      // marca como spam.
      const prompt =
        pickMessageText(node) ||
        "¡Ya casi! 🙌 Para enviarte esto necesito que me sigas. Sígueme y pulsa el botón de abajo cuando lo hayas hecho 👇";
      const label = (node.confirmLabel || "Listo ✅").slice(0, 20);
      if (r.vars.__ch === "ig") {
        try {
          await sendIgQuickReplies({ recipientId: r.phone, commentId: r.vars.__cid, text: prompt, replies: [label] });
          if (r.vars.__cid) delete r.vars.__cid; // solo 1 private reply por comentario
          await flowLog(r.phone, "assistant", prompt, { btns: [{ t: label }] }); // PLANTILLA-BANDEJA-1
        } catch (e) {
          console.error("[flow] follow quick-reply, fallback texto:", (e as Error).message);
          await say(r, prompt); // si la API rechaza el botón → texto plano (igual sirve: cualquier respuesta continúa)
        }
      } else if (r.vars.__ch === "fb") {
        try {
          await sendFbQuickReplies({ psid: r.phone, commentId: r.vars.__cid, text: prompt, replies: [label], pageId: r.vars.__fbpage || "" });
          if (r.vars.__cid) delete r.vars.__cid; // solo 1 respuesta privada por comentario
          await flowLog(r.phone, "assistant", prompt, { btns: [{ t: label }] }); // PLANTILLA-BANDEJA-1
        } catch (e) {
          console.error("[flow] follow quick-reply FB, fallback texto:", (e as Error).message);
          await say(r, prompt); // texto plano: cualquier respuesta continúa
        }
      } else {
        // PLANTILLA-BANDEJA-1 · botón nativo de WhatsApp, reflejado en la Bandeja si salió.
        const okFG = await sendButtons(r.phone, prompt, [label]);
        if (okFG !== false) await flowLog(r.phone, "assistant", prompt, { btns: [{ t: label }] });
      }
      await parkWaiting(flow, r);
      return;
    }
    if (node.type === "buttons") {
      // VARS-BOTONES-1 · Igual que VARS-CANAL-1 en «Mensaje»: el texto de un paso con
      // botones salía SIN sustituir en Instagram y Facebook. Caso real: «¡Hola
      // {{firstname|crack}}!» llegó literal a ~47 personas del reel de Claude.
      let textoBtn = node.text || "";
      if (textoBtn.includes("{{")) {
        try { textoBtn = substituteVars(textoBtn, await getContact(r.phone), { strict: false, extra: r.vars }); }
        catch { /* si no se puede resolver, va el texto tal cual */ }
      }
      // WhatsApp: botones/lista nativos (tappables). Instagram: quick replies TAPPABLES.
      if (r.vars.__ch === "ig") {
        // ANTI-BAN-ENLACE · El toque en un quick reply llega como mensaje entrante y ABRE
        // la ventana de mensajería de 24 h. Eso es lo que permite mandar el enlace en un
        // mensaje POSTERIOR (no en el primero): Instagram penaliza el enlace en el primer
        // DM automático, pero tras una interacción del usuario ya es una respuesta
        // legítima. Antes esto salía como texto numerado («1. …»), que obliga a ESCRIBIR
        // y queda peor. Si el quick reply falla, cae al texto numerado de siempre.
        const labels = node.options.map((o) => o.label);
        try {
          await sendIgQuickReplies({ recipientId: r.phone, commentId: r.vars.__cid, text: textoBtn, replies: labels });
          if (r.vars.__cid) delete r.vars.__cid; // solo 1 respuesta privada por comentario
          // PLANTILLA-BANDEJA-1 · el paso con botones se VE en la Bandeja (texto + botones).
          await flowLog(r.phone, "assistant", textoBtn, { btns: labels.map((t) => ({ t })) });
        } catch {
          const opts = node.options.map((o, idx) => `${idx + 1}. ${o.label}`).join("\n");
          await say(r, `${textoBtn}\n${opts}`);
        }
      } else if (r.vars.__ch === "fb") {
        const labels = node.options.map((o) => o.label);
        try {
          await sendFbQuickReplies({ psid: r.phone, commentId: r.vars.__cid, text: textoBtn, replies: labels, pageId: r.vars.__fbpage || "" });
          if (r.vars.__cid) delete r.vars.__cid;
          await flowLog(r.phone, "assistant", textoBtn, { btns: labels.map((t) => ({ t })) }); // PLANTILLA-BANDEJA-1
        } catch {
          const opts = node.options.map((o, idx) => `${idx + 1}. ${o.label}`).join("\n");
          await say(r, `${textoBtn}\n${opts}`);
        }
      } else {
        const labels = node.options.map((o) => o.label);
        // PLANTILLA-BANDEJA-1 · sendButtons devuelve false si Meta rechazó (tras caer
        // al texto numerado): solo se refleja en la Bandeja lo que sí salió.
        const okB = await sendButtons(r.phone, textoBtn, labels);
        if (okB !== false) await flowLog(r.phone, "assistant", textoBtn, { btns: labels.map((t) => ({ t })) });
      }
      await parkWaiting(flow, r);
      return;
    }
    if (node.type === "condition") {
      // TAG-GATE · "¿Tiene la etiqueta X?" — comprobación LOCAL de las etiquetas del
      // contacto (sin llamar a systeme.io). Lo usa el recordatorio de registro: el webhook
      // pone "sio-registrado" al confirmar el registro → aquí yes=registrado (no recordar),
      // no=no registrado (recordar). Un fallo al leer cuenta como "no la tiene" (= recuerda).
      if (node.source === "hasTag") {
        const tag = String(node.value || "").trim().toLowerCase();
        let has = false;
        if (tag) {
          try {
            const c = await getContact(r.phone);
            has = !!(c?.tags || []).some((t) => String(t || "").trim().toLowerCase() === tag);
          } catch (e) {
            console.warn("[flow] hasTag: no se pudo comprobar la etiqueta:", (e as Error).message);
          }
        }
        const nxt = has ? node.yes : node.no;
        if (!nxt) return finish(r);
        r.node_id = nxt;
        continue;
      }
      // ENLACE-ABIERTO-1 · "¿Abrió el enlace?" — clics reales del acortador atribuidos a ESTE
      // flujo y a ESTE contacto (botones de las tarjetas y enlaces medidos). yes=abrió;
      // no=no consta ningún clic. Un fallo de consulta cuenta como NO (nunca bloquea).
      if (node.source === "linkOpened") {
        let opened = false;
        // ENLACE-ABIERTO-2 · filtros opcionales: trozo de la dirección destino (value) y «solo
        // clics posteriores al último enlace enviado» (sinceLastLink → __linkAt, que say() anota
        // ANTES de enviar). 1 s de margen por si el reloj de la base va por detrás del de la app.
        // Con sinceLastLink y ningún enlace enviado aún en este run no hay ventana: cuenta como NO
        // (los clics que haya son de otro run o de otro mensaje).
        const trozo = String(node.value || "").trim();
        const linkAt = Number(r.vars.__linkAt || 0);
        const sinVentana = !!node.sinceLastLink && !(linkAt > 0);
        if (!sinVentana) {
          try {
            opened = await phoneOpenedFlowLink(r.phone, r.flow_id, { urlContains: trozo, sinceMs: node.sinceLastLink ? Math.max(1, linkAt - 1000) : 0 });
          } catch (e) { console.warn("[flow] linkOpened:", (e as Error).message); }
          // EMBUDO-PAGINAS-1 · con una página concreta (value) también vale HABERLA VISTO aunque
          // no fuera el enlace del mensaje: el lead entró por la landing y siguió al checkout o
          // a la página de gracias (lo cuenta el píxel de la web gracias a la marca de /r/).
          if (!opened && trozo) {
            try {
              const { contactVisitedPage } = await import("./web-analytics.js");
              opened = await contactVisitedPage(currentWorkspaceId() || "default", r.phone, trozo, node.sinceLastLink ? Math.max(1, linkAt - 1000) : 0);
            } catch (e) { console.warn("[flow] linkOpened/página:", (e as Error).message); }
          }
        }
        // EMBUDO-PAGINAS-1 · una dirección entera se enseña como su ruta (/ahorrador-gracias): el
        // recorrido corta el detalle y dejaba solo «https://www.tuweb.c».
        let verTrozo = trozo;
        if (trozo) { try { verTrozo = (await import("./web-analytics.js")).trozoDeRuta(trozo) || trozo; } catch { /* se queda tal cual */ } }
        const filtro = (trozo ? " «" + verTrozo + "»" : "") + (node.sinceLastLink ? " tras el último enlace enviado" : "");
        // VENTA-WEBHOOK-1 · «…y todavía no ha comprado»: abrió pero no pagó → SÍ (recordatorio);
        // si ya consta la compra (en la misma ventana que los clics) → NO.
        let compro = false;
        if (opened && node.notPurchased) {
          try {
            const { contactoCompro } = await import("./ventas-webhook.js");
            compro = await contactoCompro(r.phone, { desdeMs: node.sinceLastLink ? Math.max(1, linkAt - 1000) : 0, etiquetas: [flow.stopTag || ""] });
          } catch (e) { console.warn("[flow] linkOpened/notPurchased:", (e as Error).message); }
        }
        fev(r.flow_id, r.phone, "condición", r.node_id, opened ? (compro ? "abrió el enlace" + filtro + " pero ya compró → NO" : "abrió el enlace" + filtro + (node.notPurchased ? " y no ha comprado" : "") + " → SÍ") : (sinVentana ? "este run aún no envió ningún enlace → NO" : "sin clics en los enlaces de este flujo" + filtro + " → NO"));
        const nxt = opened && !compro ? node.yes : node.no;
        if (!nxt) return finish(r);
        r.node_id = nxt;
        continue;
      }
      // VENTA-WEBHOOK-1 · "¿Ha comprado?" — yes=consta una compra (con sinceLastLink, posterior
      // al último enlace enviado; sin enlace enviado aún en este run, cualquier compra vale).
      // Un fallo al leer cuenta como NO, igual que hasTag.
      if (node.source === "purchased") {
        const linkAt = Number(r.vars.__linkAt || 0);
        const desdeMs = node.sinceLastLink && linkAt > 0 ? Math.max(1, linkAt - 1000) : 0;
        let compro = false;
        try {
          const { contactoCompro } = await import("./ventas-webhook.js");
          compro = await contactoCompro(r.phone, { desdeMs, etiquetas: [flow.stopTag || ""] });
        }
        catch (e) { console.warn("[flow] purchased:", (e as Error).message); }
        fev(r.flow_id, r.phone, "condición", r.node_id, (compro ? "consta una compra" : "no consta ninguna compra") + (desdeMs ? " tras el último enlace enviado" : "") + (compro ? " → SÍ" : " → NO"));
        const nxt = compro ? node.yes : node.no;
        if (!nxt) return finish(r);
        r.node_id = nxt;
        continue;
      }
      // OPEN-GATE · "¿Abrió el correo?" — pregunta a systeme.io/leadmatch-lab (por email)
      // si el contacto tiene la etiqueta que allí se asigna al abrir. yes=abrió, no=no.
      // Un email/etiqueta ausente o un fallo de red cuenta como NO abierto (rama `no`),
      // que es lo que dispara el recordatorio — nunca bloquea el flujo.
      if (node.source === "emailOpened") {
        const c = await getContact(r.phone);
        const email = String(c?.email || "").trim();
        const tag = String(node.openTag || node.value || "").trim();
        // Triestado: true=abrió · false=confirmado NO abrió · null=no concluyente.
        let opened: boolean | null = null;
        if (email && tag) {
          try {
            opened = await contactHasSystemeioTag(email, tag, {
              accountId: node.openAccountId,
              // Sin cuenta explícita, apunta a la REAL (systeme.io), NUNCA al sandbox:
              // resolveSyncAccount() sin target cae en getActiveAccount()=list[0]=leadmatch-lab.
              targetPlatform: node.openTarget || "systemeio",
            });
          } catch (e) {
            console.warn("[flow] emailOpened: no se pudo comprobar la apertura:", (e as Error).message);
            opened = null;
          }
        }
        // SOLO recordamos (rama `no`) cuando está CONFIRMADO que no abrió. Si no se pudo
        // determinar (systeme.io caído, sin cuenta, mal configurado), NO recordamos (rama
        // `yes`) — así un fallo de red nunca molesta a quien pudo haber abierto.
        const nxt = opened === false ? node.no : node.yes;
        if (!nxt) return finish(r);
        r.node_id = nxt;
        continue;
      }
      // VENTANA-DE-RESPUESTA · Una condición sobre «lo último que escribió» solo debe ver lo
      // escrito DESDE la última espera. Antes miraba __last a secas, que queda relleno para
      // siempre tras el primer botón → «¿Respondió algo?» daba SÍ aunque llevara horas callado
      // (visto en producción 2026-07-28: derivó a Carla como «escribió» a quien no escribió nada;
      // además volvía inalcanzable la rama «¿Pudiste verla?» tras entregar la grabación).
      // __replied se enciende con CADA mensaje del contacto (resumeFlow, noteReplyToActiveRuns,
      // comentario YT que arranca el flujo) y se apaga al EMPEZAR cada espera (nodo delay).
      const last = r.vars.__replied === "1" ? (r.vars.__last || "").toLowerCase() : "";
      let ok = false;
      let base = node.source === "var" ? (r.vars[node.varName || ""] || "") : last;
      base = String(base).toLowerCase();
      const val = (node.value || "").toLowerCase();
      if (node.op === "exists") ok = !!base;
      else if (node.op === "equals") ok = base === val;
      else ok = base.includes(val);
      const nxt = ok ? node.yes : node.no;
      if (!nxt) return finish(r);
      r.node_id = nxt;
      continue;
    }
    if (node.type === "delay") {
      // ESPERA-SEG-1 · minutos + segundos. MODO TEST: la espera se COMPRIME a 1 min como
      // máximo (antes se forzaba a 1 min, y alargaba una espera de 10 s).
      const real = delayMsOf(node);
      const ms = r.vars.__test === "1" ? Math.min(60_000, real) : real;
      // VENTANA-DE-RESPUESTA · Al empezar una espera se abre ventana nueva: lo que el contacto
      // haya dicho ANTES ya no cuenta para el «¿Respondió?» de después de la espera.
      delete r.vars.__replied;
      // FRANJA HORARIA · si el vencimiento cae de madrugada, se entrega al abrir la franja.
      r.next_run = applyQuiet(flow, r, Date.now() + ms);
      r.status = "active";
      // STOP-CAS · guardado con guarda (no resucitar un run cancelado por el panel).
      await dbSaveFlowRunIfLive(r);
      // ESPERA-SEG-1 · el barrido es cada 30 s: una espera de segundos llegaría hasta 30 s
      // tarde. Se pide un barrido extra justo al vencer (el tick es reentrante-seguro y solo
      // recoge runs vencidos, así que un barrido de más nunca duplica nada).
      if (ms < 60_000) flowTickSoon(ms + 250);
      return; // el scheduler lo retoma
    }
    if (node.type === "action") {
      if (node.addTag) await enrichContact(r.phone, { tags: [node.addTag] });
      // OPORTUNIDADES-1 · el nodo «poner etapa» es una regla configurada: abre o mueve la
      // oportunidad en el pipeline del propio nodo, y deja dicho qué flujo fue.
      if (node.setStage) await setStage(r.phone, node.setStage, { origin: "flujo", reason: "Paso «poner etapa» del flujo «" + (flow.name || "sin nombre") + "»" }, node.setPipeline || undefined);
      if (node.setPipeline) await enrichContact(r.phone, { fields: { pipeline_id: node.setPipeline } });
      if (typeof node.setScore === "number") await setScore(r.phone, node.setScore);
      // Sincronizar el contacto a systeme.io con sus etiquetas, para que allí
      // dispare el workflow cuyo trigger es "asignar etiqueta".
      //
      // BUG RAÍZ (arreglado aquí): esto encolaba {phone, target_platform} y nada
      // más. El comentario de antes decía que "execContactUpsert lee el contacto
      // fresco por teléfono (con su email)" — era FALSO: queueMcpJob es un INSERT
      // pelado y execContactUpsert solo mira payload.email / payload.contact.email.
      // Resultado: TODO sync lanzado desde un flujo moría en
      // {skipped:"Contacto sin email"}, y como tampoco viajaban las etiquetas, la
      // etiqueta jamás llegaba a systeme.io. Ahora cargamos el contacto (ya con el
      // email que acaba de capturar el nodo `ask`) y lo mandamos entero.
      if (node.kind === "sync" || node.syncTarget) {
        if (node.syncTag) await enrichContact(r.phone, { tags: [node.syncTag] });
        const c = await getContact(r.phone);
        const email = String(c?.email || "").trim();
        if (!email) {
          // Sin email no hay nada que sincronizar: systeme.io localiza por email.
          // No encolamos un job condenado a morir; lo dejamos dicho en el log.
          console.warn(
            `[flow] sync omitido: el contacto ${r.phone} no tiene email (¿falta un paso "Pregunta" con Guardar en = email antes del sync?)`,
          );
        } else {
          await queueMcpJob({
            kind: "contact-upsert",
            // tenant_id: el run corre bajo su workspace; sin esto el job caía
            // siempre en 'default' (fuga cross-tenant en la cola).
            tenant_id: (r as { tenant_id?: string }).tenant_id || currentWorkspaceId(),
            payload: {
              phone: r.phone,
              email,
              target_platform: node.syncTarget || "",
              // La etiqueta elegida en el paso: la unica que se puede CREAR alli.
              ...(node.syncTag ? { sync_tag: node.syncTag } : {}),
              // El campo va ANTES que la etiqueta a proposito (ver mcp-bridge): la
              // etiqueta enciende el workflow, y si el campo no estuviera escrito ya, el
              // workflow ramificaria con el valor viejo o con ninguno.
              ...(node.syncField && node.syncFieldValue
                ? { sync_field: node.syncField, sync_field_value: node.syncFieldValue }
                : {}),
              ...(node.syncAccountId ? { account_id: node.syncAccountId } : {}),
              contact: {
                email,
                name: c?.name || "",
                tags: c?.tags || [],
              },
            },
          });
        }
      }
      if (node.escalate) {
        await setHuman(r.phone, true); // silencia el bot y deja el contacto para una persona
        // NOTIFICACIONES-1 · pide_persona
        avisarContacto("pide_persona", r.phone, (nm) => ({ title: nm + " pasa a tu equipo", body: "El flujo «" + flow.name + "» le ha pasado con una persona. El bot ya no le contesta." }), { dedup: dedupVentana("persona:" + flow.id + ":" + r.phone, 30) });
        await say(r, "Te paso con una persona del equipo, te escribirá en breve. 🙌");
      }
      if (node.toBot) await setHuman(r.phone, false); // devuelve la conversación al bot
      // AVISO-POR-KIND-1 · el panel guarda el paso «Avisar a un closer» con notify:true, pero un
      // flujo cargado o editado por la API puede traer solo kind:"notify" (caso real del 16-sep:
      // el aviso a Carla del flujo DCC se registraba como «acción (vacía)» y no salía). El motor
      // honra las dos marcas, igual que ya hacían los ayudantes del servidor.
      if (node.notify || node.kind === "notify") {
        // NOTIFICACIONES-1 · lead_cualificado
        avisarContacto("lead_cualificado", r.phone, (nm) => ({ title: nm + " es un lead cualificado", body: "Ha llegado al paso «Avisar a un closer» del flujo «" + flow.name + "»." }), { dedup: dedupVentana("cualif:" + flow.id + ":" + r.phone, 60) });
        // AVISO-A-CARLA-ROBUSTO · el aviso al closer DEBE llegar aunque el nodo esté mal
        // configurado (nº o plantilla vacíos, visto en producción: avisos que no salían).
        // Sin plantilla, el texto libre lo rechaza Meta si el closer no ha escrito en 24 h.
        // Rellenamos SIEMPRE desde el flujo: nº ← nodo || rd || fu; plantilla ← nodo || fu.
        await notifyClosers(r.phone, {
          notifyPhones: node.notifyPhones || flow.rdNotifyPhones || flow.fuNotifyPhones,
          notifyTemplate: node.notifyTemplate || flow.fuNotifyTemplate,
          notifyLang: node.notifyLang || flow.fuNotifyLang,
          notifyParams: node.notifyParams,
        }, r.vars);
      }
      if (node.startFlow) {
        const target = (await listFlows()).find((f) => f.id === node.startFlow && f.enabled);
        // CROSS-CANAL-2: el flujo encadenado hereda el CANAL del run actual. Antes
        // siempre arrancaba por la vía WhatsApp: desde un run de Instagram, el nuevo
        // run nacía sin __ch:'ig' y say() acababa mandando el IGSID a la API de
        // WhatsApp → error de Meta y mensaje que jamás llegaba.
        if (target) {
          // CLASIFICA-FLUJOS-1 (MET-AUTO-02) · la entrada queda registrada como «desde el flujo X»:
          // un flujo que recibe gente de otro se analiza por ese punto de entrada aparte.
          const desde = (r.vars.__ch === "ig" ? "Instagram" : "WhatsApp") + " · desde el flujo «" + String(flow.name || flow.id).slice(0, 60) + "»";
          // MET-AUTO-05-FIN · evento propio en el ORIGEN: el traspaso cuenta como logro de este flujo
          // por su id, no por el nombre (que se renombra o se repite entre flujos).
          fev(flow.id, r.phone, "traspasó", r.node_id, String(target.name || target.id).slice(0, 60));
          if (r.vars.__ch === "ig") await startFlowIgDm(r.phone, target, { desde });
          else await startFlow(r.phone, target, { desde });
        }
      }
      // Agendado por link: comparte el enlace de reservas (del nodo o del ajuste
      // booking.url) y etiqueta al lead. La cita real vive en Cal.com/Calendly.
      if (node.kind === "book") {
        if (node.bookingTag) await enrichContact(r.phone, { tags: [node.bookingTag] });
        const url = node.bookingUrl || get("booking.url") || "";
        if (url) await say(r, node.bookingPromptText || "Reserva tu cita aquí 👇", url);
        else await say(r, node.bookingPromptText || "Cuéntame qué día y hora te vienen bien y te confirmo.");
      }
      if (!node.next) return finish(r);
      r.node_id = node.next;
      continue;
    }
    return finish(r); // end
  }
  await finish(r); // tope anti-bucle
}

// ESPERA-SEG-1 · UNA sola verdad para leer una espera (minutos + segundos) y para decirla en
// humano. La usan el motor, el servidor del panel (esperaLbl) y el registro del flujo.
export function delayMsOf(n: { minutes?: unknown; seconds?: unknown }): number {
  return Math.max(0, Math.round((Number(n.minutes) || 0) * 60_000 + (Number(n.seconds) || 0) * 1000));
}
export function esperaHumana(minutes: unknown, seconds?: unknown): string {
  const tot = Math.round(delayMsOf({ minutes, seconds }) / 1000); // segundos totales
  if (tot <= 0) return "0 min";
  const h = Math.floor(tot / 3600), m = Math.floor((tot % 3600) / 60), s = tot % 60;
  const p: string[] = [];
  if (h) p.push(h + " h");
  if (m) p.push(m + " min");
  if (s) p.push(s + " s");
  return p.join(" ");
}
// CLASIFICA-FLUJOS-1 (MET-AUTO-02) · `desde`: por dónde entra la persona cuando no es el
// disparador propio del flujo (encadenado desde otro flujo, lanzado por el asistente de IA).
// Va al detalle de «entró» del registro: la pestaña de Automatización desglosa cada flujo
// por sus puntos de entrada sin duplicar su ficha.
export async function startFlow(phone: string, flow: Flow, opts: { prueba?: boolean; desde?: string } = {}): Promise<void> {
  // UN-FLUJO-2 TAMPOCO SE APLICA A WHATSAPP. Cerrar el flujo anterior a medias es
  // correcto en Instagram (un comentario = una conversación), pero en WhatsApp mata
  // runs legítimos: "ENLACE LIVE DIRECTO" se queda ESPERANDO en su nodo de botones un
  // buen rato, y cualquier otro flujo que arrancara mientras tanto lo cancelaba, con lo
  // que el alumno se quedaba sin el enlace del Zoom que ya había pedido. En WhatsApp
  // pueden convivir varios runs, como llevaba haciendo producción desde siempre.
  const r: FlowRun = {
    phone,
    flow_id: flow.id,
    node_id: flow.start,
    // Recordamos DESDE QUÉ número de WhatsApp arrancó. Un delay que se reanuda más tarde
    // (en flowTick, fuera del ámbito del webhook) enviaría desde el número PRINCIPAL si no,
    // y Meta lo rechazaría: el cliente escribió a ESTE número, no al principal, así que solo
    // aquí tiene ventana de 24h. Multi-número real (el flujo de Carla va por el nº Setter).
    // __test: marca de ejecución de PRUEBA (modo test) → esperas de 1 min. Va en el run,
    // no en el flujo, para no afectar a clientes ya dentro.
    vars: { __pnid: activeWaPhoneId() || "", ...(flow.testMode ? { __test: "1" } : {}), ...(opts.prueba ? { __probar: "1" } : {}) },
    status: "active",
    next_run: Date.now() + RUN_GRACE_MS, // CARRERA-TICK-1: el run nace fuera del radar del barrido
  };
  // DOBLE-ARRANQUE-1 · si ese contacto acaba de entrar en ESTE flujo, no se arranca otra vez.
  // La reserva y la escritura son la misma sentencia: comprobar antes y guardar después
  // dejaría la ventana abierta justo para el caso que esto arregla.
  if (!(await dbClaimFlowStart(r, DOBLE_ARRANQUE_MS))) {
    console.warn(`[flow] ${telLog(phone)} ya acababa de entrar en «${flow.name}»: no se arranca por segunda vez`);
    return;
  }
  fev(flow.id, phone, "entró", flow.start, (flow.testMode ? "PRUEBA · " : "") + (opts.desde || "WhatsApp · " + (flow.trigger?.type === "wa_any" ? "cualquier mensaje" : "palabra clave «" + String(flow.trigger?.keyword || "").slice(0, 60) + "»")));
  await run(flow, r);
}

/**
 * RESCATE-ENLACE-IG · Entrega a un contacto el ENLACE de un flujo (su paso "message" con
 * link) por el camino BUENO — dentro de un botón vía sendIgLinkButton — sin depender del
 * estado del run. Lo usa la recuperación de quienes pulsaron el botón pero su respuesta se
 * perdió en un reinicio (el sondeo solo rescata runs en 'waiting'; si el run ya salió de
 * ese estado, nadie les manda el enlace). Un DM con la URL en el texto lo rechaza Meta en
 * esta cuenta ("Link can't be shared"); dentro de un botón sí pasa.
 *
 * Idempotente por diseño de quien llama: comprobar antes si el enlace ya está en la
 * conversación. Devuelve qué nodo entregó (o el motivo de que no).
 */
export async function deliverIgFlowLinkTo(
  igsid: string,
  flowId: string,
  opts: { markDone?: boolean } = {},
): Promise<{ ok: boolean; nodeId?: string; link?: string; error?: string }> {
  const flow = (await listFlows()).find((f) => f.id === flowId);
  if (!flow) return { ok: false, error: "flujo no encontrado" };
  // Nodo de mensaje con enlace (el que entrega el recurso). El primero que aparezca.
  type MsgNode = FlowNode & { text?: string; link?: string; linkLabel?: string; next?: string };
  let nodeId = "";
  let node: MsgNode | null = null;
  for (const [id, n] of Object.entries(flow.nodes || {})) {
    const nn = n as MsgNode;
    if (nn.type === "message" && nn.link) { nodeId = id; node = nn; break; }
  }
  if (!node || !node.link) return { ok: false, error: "el flujo no tiene un paso con enlace" };
  // Cuenta de IG por la que entró la conversación (channel_account 'ig:<igId>').
  const ct = await getContact(igsid);
  const chAcc = String(ct?.channel_account || "");
  const igId = chAcc.startsWith("ig:") ? chAcc.slice(3) : String((flow as { appliesTo?: string }).appliesTo || activeIgCreds().igId || "");
  const acct = resolveAccount(igId);
  if (!acct) return { ok: false, error: "cuenta IG no resuelta (" + igId + ")" };
  const r: FlowRun = {
    phone: igsid,
    flow_id: flowId,
    node_id: nodeId,
    vars: { __ch: "ig", __igid: igId },
    status: "active",
    next_run: Date.now() + RUN_GRACE_MS, // CARRERA-TICK-1: el run nace fuera del radar del barrido
  };
  await runWithAccount(acct, async () => {
    await say(r, node!.text || "", node!.link, node!.linkLabel);
  });
  // Marca el run como completado (evita que el sondeo lo re-toque). No bloquea si falla.
  if (opts.markDone !== false) {
    try { await dbSaveFlowRun({ ...r, node_id: node.next || "", status: "done", next_run: Date.now() }); } catch { /* cosmético */ }
  }
  return { ok: true, nodeId, link: node.link };
}

/** Arranca un flujo en canal Instagram (1ª salida = private reply al comentario). */
export async function startFlowIg(igsid: string, flow: Flow, commentId: string, username = "", publicoOcupado = false, commentText = ""): Promise<void> {
  await closeOtherRuns(igsid, flow.id, flow.name || ""); // UN-FLUJO-2
  // CONTACTO-IG-1: quien comenta y dispara un flujo ES un lead → crea su ficha de
  // contacto ya. Sin esto, las acciones del flujo (etiqueta, etapa, sync a systeme.io)
  // eran no-ops silenciosos: son UPDATEs y la fila no existía hasta que la persona
  // enviara un DM (cosa que puede no pasar nunca).
  // source="instagram": sin esto el IGSID se guardaba con source "whatsapp" y acababa
  // en las audiencias de difusion de WhatsApp como si fuera un numero de telefono.
  //
  // NOMBRE-IG-1 · El @usuario viene en el propio evento del comentario, así que la ficha
  // nace ya con nombre. Antes se creaba con el nombre VACÍO y el lead quedaba
  // identificado solo por un id de 16 dígitos: inútil en la Bandeja, en las etiquetas y
  // en lo que se sincroniza a systeme.io. Si por lo que sea no viniera, se pregunta al
  // perfil (una sola vez, solo cuando falta).
  try {
    let nombre = username ? "@" + username.replace(/^@/, "") : "";
    if (!nombre) {
      try {
        const prof = await fetchIgUserProfile(igsid);
        if (prof?.username) nombre = "@" + prof.username;
        else if (prof?.name) nombre = prof.name;
      } catch { /* sin nombre: el flujo sigue igual */ }
    }
    // NOTIFICACIONES-1 · lead_nuevo: la ficha nace con este mensaje (dedup por contacto).
    if (await touchContact(igsid, nombre, "", "ig:" + (activeIgCreds().igId || ""), "instagram")) avisarLeadNuevo(igsid, { name: nombre, channel: "instagram", origen: "Ha comentado en una publicación tuya de Instagram." });
  } catch { /* no bloquea el flujo */ }
  const r: FlowRun = {
    phone: igsid,
    flow_id: flow.id,
    node_id: flow.start,
    // __igid: la cuenta de IG que arrancó el flujo, para reanudar delays desde ELLA (multi-cuenta).
    // __last = lo que la persona ha comentado: lo leen la respuesta pública con IA y
    // los nodos de mensaje con IA. Sin __replied a propósito: no queremos cambiar cómo
    // se comportan las condiciones sobre «último mensaje» en los flujos ya guardados.
    vars: { __ch: "ig", __cid: commentId, __igid: activeIgCreds().igId || "", __last: commentText },
    status: "active",
    next_run: Date.now() + RUN_GRACE_MS, // CARRERA-TICK-1: el run nace fuera del radar del barrido
  };
  await dbSaveFlowRun(r);
  fev(flow.id, igsid, "entró", flow.start, "Instagram · comentario" + (username ? " de @" + String(username).replace(/^@/, "").slice(0, 40) : ""));
  // Respuesta PÚBLICA al comentario (como ManyChat): el bot contesta el comentario
  // a la vista de todos y, además, el flujo manda el contenido por DM privado.
  // Se rota el texto para no publicar siempre lo mismo (evita spam-flag de IG).
  // PUBLIC-REPLY-1 · Las respuestas públicas ahora las escribe el DUEÑO en el flujo
  // (como en ManyChat). Sin configurar → estas de reserva. Se puede desactivar del
  // todo con publicReplyOff. Se elige una AL AZAR: publicar siempre lo mismo bajo tus
  // posts es exactamente lo que Instagram marca como spam.
  const custom = (flow.publicReplies || []).map((t) => String(t || "").trim()).filter(Boolean);
  const PUBLIC_REPLIES = custom.length
    ? custom
    : [
        "¡Te lo acabo de enviar al DM! 👀 Revisa tus mensajes 📩",
        "¡Hecho! Te escribo por privado ahora mismo 📩 Mira tu DM 👀",
        "¡Voy! Te lo mando al DM 🙌 Échale un ojo a tus mensajes 📩",
      ];
  // PUBLICO-OCUPADO-1 · si un Disparador ya comentó bajo este post, aquí no se
  // publica otra vez (el DM del flujo sí sale: son canales distintos).
  if (!flow.publicReplyOff && !publicoOcupado) {
    try {
      // PUBLIC-AI-1 · dentro del try a propósito: si el modelo tarda o revienta, el
      // texto de reserva sale igual y, sobre todo, no se lleva por delante el DM.
      let txt = PUBLIC_REPLIES[Math.floor(Math.random() * PUBLIC_REPLIES.length)];
      if (flow.publicAi) {
        const gen = await publicAiReply(flow, "ig", commentText, username);
        // AI-ACT-PUBLICO-1 · la respuesta PÚBLICA que escribe la IA lleva su sello, igual
        // que ya hacían las automatizaciones de comentarios. En un hilo de comentarios no
        // hay otro canal para avisar a quien comentó: o va dentro, o no va. El texto de
        // reserva (PUBLIC_REPLIES) NO se sella: lo escribimos nosotros, no infiere nada.
        if (gen) txt = labelAiGeneratedContent(gen);
      }
      await replyToComment(commentId, txt);
    } catch (e) {
      console.error("[flow] respuesta pública al comentario:", (e as Error).message);
    }
  }
  await run(flow, r);
}

/** Comentario de FACEBOOK → arranca flujos con trigger fb_comment que casen.
 *  Espejo de triggerIgFlows; el endpoint del appliesTo es el pageId.
 *  El `publicoOcupado` final es el mismo de triggerIgFlows (PUBLICO-OCUPADO-1). */
export async function triggerFbFlows(
  psid: string,
  text: string,
  commentId: string,
  mediaId: string,
  pageId: string,
  name = "",
  publicoOcupado = false,
): Promise<boolean> {
  const quien = deaccent(String(name || "").replace(/^@/, "").trim());
  const cands = (await listFlows()).filter((f) => {
    if (!f.enabled || f.trigger?.type !== "fb_comment") return false;
    if (!flowAppliesTo(f, pageId)) return false;
    const mid = f.trigger.mediaId || "any";
    if (mid !== "any" && mid !== mediaId) return false;
    if (!triggerTextMatches(f.trigger, text)) return false;
    const excl = (f.trigger.excludeUsers || "")
      .split(",")
      .map((u) => deaccent(u.replace(/^@/, "").trim()))
      .filter(Boolean);
    if (quien && excl.includes(quien)) {
      recordWebhook("facebook", "🚫 " + name + " está excluido del flujo \"" + f.name + "\" (ya cliente) → no se dispara para él");
      return false;
    }
    return true;
  });
  let started = false;
  // UN-FLUJO-1: un comentario dispara UN solo flujo (Meta solo permite una
  // respuesta privada por comentario).
  for (const f of mostSpecific(cands, text)) {
    // PRUEBA-CANAL-1 · MODO PRUEBA · antes que nada, por el mismo motivo que en Instagram.
    const vetoPrueba = bloqueaPorPrueba(f, "facebook", name);
    if (vetoPrueba) {
      recordWebhook("facebook", "flujo \"" + f.name + "\" · " + vetoPrueba);
      fev(f.id, psid, "no entró", f.start, vetoPrueba);
      continue;
    }
    // ONCE-FLOW-1 · va ANTES del re-disparo: si no, quien comenta por segunda vez
    // cancelaría su propio run vivo y se quedaría sin nada.
    if (f.oncePerUser && !(await dbClaimOnce(f.id, psid))) continue;
    if (await dbHasActiveFlowRun(psid, f.id)) {
      await dbCancelFlowRunsForPhone(psid, f.id);
      fev(f.id, psid, "cancelado", "", "comentó de nuevo → el flujo se reinicia desde cero");
    }
    await startFlowFb(psid, f, commentId, pageId, name, publicoOcupado, text);
    recordWebhook("facebook", "▶️ flujo \"" + f.name + "\" disparado por comentario");
    started = true;
  }
  return started;
}

export async function startFlowFb(psid: string, flow: Flow, commentId: string, pageId: string, name = "", publicoOcupado = false, commentText = ""): Promise<void> {
  await closeOtherRuns(psid, flow.id, flow.name || ""); // UN-FLUJO-2
  // Quien comenta y dispara un flujo ES un lead: su ficha nace ya, con el nombre
  // que trae el propio evento, y con source facebook para que la Bandeja y las
  // audiencias lo traten como lo que es (mismo motivo que CONTACTO-IG-1).
  try {
    // NOTIFICACIONES-1 · lead_nuevo: la ficha nace con este mensaje (dedup por contacto).
    if (await touchContact(psid, String(name || "").trim(), "", "fb:" + pageId, "facebook")) avisarLeadNuevo(psid, { name: String(name || "").trim(), channel: "facebook", origen: "Ha comentado en una publicación tuya de Facebook." });
  } catch { /* no bloquea el flujo */ }
  const r: FlowRun = {
    phone: psid,
    flow_id: flow.id,
    node_id: flow.start,
    // __fbpage: la Página que arrancó el flujo — cada envío posterior necesita su token.
    // __last · mismo motivo que en Instagram.
    vars: { __ch: "fb", __cid: commentId, __fbpage: pageId, __last: commentText },
    status: "active",
    next_run: Date.now() + RUN_GRACE_MS, // CARRERA-TICK-1: nace fuera del radar del barrido
  };
  await dbSaveFlowRun(r);
  fev(flow.id, psid, "entró", flow.start, "Facebook · comentario" + (name ? " de " + String(name).slice(0, 40) : ""));
  // Respuesta pública al comentario, configurable como en IG. Se elige al azar:
  // publicar siempre lo mismo bajo tus posts es patrón de spam también aquí.
  const custom = (flow.publicReplies || []).map((t) => String(t || "").trim()).filter(Boolean);
  const PUBLIC_REPLIES = custom.length
    ? custom
    : [
        "¡Te lo acabo de enviar por Messenger! 👀 Revisa tus mensajes 📩",
        "¡Hecho! Te escribo por privado ahora mismo 📩",
        "¡Voy! Te lo mando por Messenger 🙌 Échale un ojo a tus mensajes 📩",
      ];
  // PUBLICO-OCUPADO-1 · espejo del de Instagram.
  if (!flow.publicReplyOff && !publicoOcupado) {
    try {
      // PUBLIC-AI-1 · espejo del de Instagram.
      let txt = PUBLIC_REPLIES[Math.floor(Math.random() * PUBLIC_REPLIES.length)];
      if (flow.publicAi) {
        const gen = await publicAiReply(flow, "fb", commentText, name);
        if (gen) txt = labelAiGeneratedContent(gen); // AI-ACT-PUBLICO-1 · espejo de Instagram
      }
      await fbReplyToComment(commentId, txt, pageId);
    } catch (e) {
      console.error("[flow] respuesta pública al comentario FB:", (e as Error).message);
    }
  }
  await run(flow, r);
}

/** MET-AUTO-07-FIN · Desarma los runs en espera de este contacto: next_run «nunca» y __fu="R".
 *  Cambiar __fu (no sólo next_run) es lo que frena a un tick que ya leyó el run: su CAS compara
 *  __fu y pierde, así que no sale un «¿sigues ahí?» después de reservar. No los cancela: si la
 *  persona contesta, el flujo sigue desde donde estaba. Si ya había recibido algún aviso, queda
 *  el evento «reservó tras aviso»: secuencia observada, no prueba de que el aviso la causara. */
async function desarmarSeguimientosPorReserva(phone: string, telefono?: string): Promise<void> {
  // MET-AUTO-07-FIN · la reserva llega por correo (calendario de la web), pero el aviso puede
  // estar armado en la ficha de WhatsApp, Instagram o Facebook de la MISMA persona: se desarman
  // los de todas sus fichas con ese correo (IDENTIDAD-COMUN-1), no sólo los de la clave que reservó.
  const claves = new Set<string>([phone]);
  const email = phone.startsWith("email:") ? phone.slice(6) : String((await getContact(phone).catch(() => null))?.email || "");
  for (const k of await dbClavesPorEmail(email).catch(() => [] as string[])) claves.add(k);
  // MET-AUTO-07-FIN · y por el MISMO teléfono: la ficha de WhatsApp sin correo de quien reservó
  // dejando su móvil (IDENTIDAD-COMUN-1: el teléfono acredita la unión, el nombre no).
  const tel = normalizarTelefono(telefono);
  if (tel) for (const k of await dbClavesPorTelefono(tel).catch(() => [] as string[])) claves.add(k);
  const runs: FlowRun[] = [];
  for (const k of claves) runs.push(...(await dbWaitingFlowRunsForPhone(k).catch(() => [] as FlowRun[])));
  for (const r of runs) {
    const canal = " · canal: " + canalDeClave(r.phone);
    const mark = String(r.vars.__fu || "");
    if (mark === "R") continue; // ya desarmado por otra reserva
    try {
      if (Number(mark || 0) >= 1) fev(r.flow_id, r.phone, "reservó tras aviso", r.node_id, "reservó cita después de recibir " + mark + " aviso(s) de seguimiento" + canal);
      if (!(Number(r.next_run) < FU_FAR)) continue; // nada armado
      const ok = await dbAdvanceWaitingIfUnchanged(r.phone, r.flow_id, r.node_id, mark, { vars: { ...r.vars, __fu: "R" }, status: "waiting", nextRun: FU_FAR });
      if (ok) fev(r.flow_id, r.phone, "seguimiento cancelado · reservó", r.node_id, "reservó cita: no se le mandan más avisos de seguimiento" + canal);
    } catch (e) { console.warn("[followup] desarmar por reserva:", (e as Error).message); }
  }
}

/**
 * RESERVA-FLOW-1 · Dispara los flujos con trigger «booking» para un contacto que
 * acaba de RESERVAR en una web conectada. La confirmación/bienvenida al reservar
 * es marketing y vive en el editor de flujos (con el copy del usuario, ramas,
 * enlaces…); los recordatorios de «se acerca la cita» son OTROS flujos, con el
 * trigger «recordatorio» (los dispara el scheduler; ver triggerReminderFlow).
 *
 * El canal lo dicta el CONTACTO (por dónde entró): Instagram → DM desde su
 * cuenta; Messenger → su Página; WhatsApp → su número. Un contacto solo-email
 * (ficha creada por la propia reserva, sin canal de mensajería) no puede
 * recibir mensajes: se registra en los logs del flujo y no se arranca nada —
 * decirlo es mejor que fingir un envío.
 *
 * `info` viaja como vars del run ({{reserva_evento}}, {{reserva_fecha}}…);
 * quien llama las persiste además como fields de la ficha ({{field.reserva_*}}).
 */
/** RESERVA-WA-1 · Datos que pueden ir en los huecos {{1}}, {{2}}… de la plantilla de
 *  confirmación, y el relleno si la reserva no lo trae (Meta rechaza un parámetro vacío). */
export const DATOS_RESERVA = ["nombre", "cita", "cuando", "fecha", "hora", "web"] as const;
const RELLENO_RESERVA: Record<string, string> = { nombre: "😊", cita: "tu cita", cuando: "pronto", fecha: "pronto", hora: "la hora acordada", web: "nuestra web" };

/** RESERVA-WA-1 · trigger.tplVars → qué dato va en cada hueco, en orden. Compat:
 *  "" = cita, cuando · "dia_hora" = fecha, hora. Si no, lista separada por comas
 *  («nombre,fecha,hora»); un dato que no existe se descarta. */
export function huecosDeReserva(tplVars: unknown): string[] {
  const v = String(tplVars || "").trim().toLowerCase();
  if (!v) return ["cita", "cuando"];
  if (v === "dia_hora") return ["fecha", "hora"];
  const ks = v.split(",").map((k) => k.trim()).filter((k) => (DATOS_RESERVA as readonly string[]).includes(k)).slice(0, 6);
  return ks.length ? ks : ["cita", "cuando"];
}

/** RESERVA-WA-1 · Los flujos «booking» que tocan a una reserva de `evento`: los de ESE
 *  evento (ambito «evento:<nombre>») si los hay; si no, los generales. Sin distinguir
 *  mayúsculas ni espacios de los extremos (el nombre lo teclea una persona). */
export function flujosDeReserva(flows: Flow[], evento: string): Flow[] {
  const norm = (s: string) => String(s || "").trim().toLowerCase();
  const ev = norm(evento);
  const deEvento = (f: Flow): string | null => {
    const a = String(f.trigger?.ambito || "");
    return a.startsWith("evento:") ? norm(a.slice(7)) : null;
  };
  const propios = ev ? flows.filter((f) => deEvento(f) === ev) : [];
  return propios.length ? propios : flows.filter((f) => deEvento(f) === null);
}

export async function triggerBookingFlows(
  phone: string,
  info: { evento: string; fecha: string; hora: string; web: string; origen: string; telefono?: string },
): Promise<number> {
  // MET-AUTO-07-FIN · la reserva desarma los avisos de seguimiento pendientes, haya o no flujo
  // de confirmación: se reserve desde el vídeo, el correo o WhatsApp, todo acaba en el mismo
  // calendario y un «¿sigues ahí?» después de reservar ya no procede.
  await desarmarSeguimientosPorReserva(phone, info.telefono);
  // RESERVA-WA-1 · «solo para el evento X» = trigger.ambito «evento:<nombre>», como en los avisos.
  // El más específico gana: si el evento tiene su propio flujo, los generales no le escriben
  // (dos confirmaciones de la misma cita es peor que ninguna).
  const flows = flujosDeReserva((await listFlows()).filter((f) => f.enabled && f.trigger?.type === "booking"), info.evento);
  if (!flows.length) return 0;
  const c = await getContact(phone);
  if (!c) return 0;
  // CHAT-POR-NUMERO-1 · ruta = el par con la entrada más reciente (channel_account
  // quedó congelado como atribución del historial y ya no sigue al último entrante).
  const acc = routeAccount(c);
  const varsBase: Record<string, string> = {
    reserva_evento: String(info.evento || "").slice(0, 200),
    reserva_fecha: String(info.fecha || ""),
    reserva_hora: String(info.hora || ""),
    reserva_web: String(info.web || "").slice(0, 120),
    reserva_origen: String(info.origen || "web"),
  };
  // FORM-CITA-1 · quien reserva desde un formulario o la web casi nunca ha escrito por
  // WhatsApp: con un número de Meta y la ventana de 24 h cerrada, un mensaje normal no
  // llega. Entonces sale la plantilla aprobada del disparador ({{1}} la cita, {{2}}
  // cuándo), como en los recordatorios. Un número por QR no tiene ventana: va el flujo.
  const esWa = !acc.startsWith("ig:") && !acc.startsWith("fb:") && phone.indexOf("email:") !== 0;
  const cuando = (String(info.fecha || "") + (info.hora ? " a las " + info.hora : "")).trim();
  const datos: Record<string, string> = {
    // el nombre de pila, nunca el correo (la ficha creada por una reserva se llama como su email)
    nombre: ((n) => n && n.indexOf("@") < 0 ? n.charAt(0).toUpperCase() + n.slice(1) : "")(String(c.name || "").trim().split(/\s+/)[0] || ""),
    cita: String(info.evento || "").slice(0, 200), cuando,
    fecha: String(info.fecha || "").trim(), hora: String(info.hora || "").trim(),
    web: String(info.web || "").slice(0, 120),
  };
  let arrancados = 0;
  for (const f of flows) {
    const detalle = "Reserva en tu web" + (info.evento ? " · «" + String(info.evento).slice(0, 60) + "»" : "");
    // PRUEBA-CANAL-1 · MODO PRUEBA · una reserva de un cliente real no puede arrancar un
    // flujo que aún estás montando: vale tu número o tu correo de prueba, nada más.
    const vetoPrueba = bloqueaPorPrueba(f, "reserva", phone, c.email);
    if (vetoPrueba) { fev(f.id, phone, "no entró", f.start, detalle + " · " + vetoPrueba); continue; }
    // RESERVA-WA-1 · «envía desde»: con un número de WhatsApp fijado en el flujo (appliesTo),
    // la confirmación sale de ese número aunque la persona escribiera antes a otro; la
    // ventana de 24 h que cuenta es la de ESE número (la de Meta es por número).
    const fijo = esWa && f.appliesTo && resolveWaNumber(f.appliesTo) ? f.appliesTo : "";
    const accF = fijo ? "wa:" + fijo : acc;
    const pnid = accF.startsWith("wa:") ? accF.slice(3) : "";
    const waCerrado = esWa && !(fijo ? inWindowFor(c, accF) : inWindow(c)) && !isQrNumber(pnid || activeWaPhoneId());
    if (waCerrado) {
      const tpl = String(f.trigger.tpl || "").trim();
      if (!tpl) { fev(f.id, phone, "no entró", f.start, detalle + " · no ha escrito por WhatsApp en las últimas 24 h y el flujo no tiene plantilla para ese caso"); continue; }
      const waNum = pnid ? resolveWaNumber(pnid) : null;
      const vars = huecosDeReserva(f.trigger.tplVars).map((k) => datos[k] || RELLENO_RESERVA[k] || "");
      const envia = () => sendTemplate(phone, tpl, String(f.trigger.tplLang || "").trim() || "es", vars);
      try {
        if (waNum) await runWithWaNumber({ token: waNum.token, phoneId: waNum.phoneNumberId }, envia);
        else await envia();
        fev(f.id, phone, "entró", f.start, detalle + " · sin conversación abierta: enviada la plantilla «" + tpl + "»");
        arrancados++;
      } catch (e) {
        fev(f.id, phone, "error", f.start, detalle + " · la plantilla «" + tpl + "» no se pudo enviar: " + String((e as Error).message || e).slice(0, 160));
      }
      continue;
    }
    if (await arrancarPorFicha(f, phone, accF, varsBase, detalle)) arrancados++;
  }
  return arrancados;
}

/**
 * RESERVA-FLOW-1 · TYPEFORM-1 · Arranca UN flujo para una ficha que llega sin
 * conversación abierta (reserva en la web, respuesta a un formulario). El canal lo
 * dicta el contacto: Instagram → DM desde su cuenta; Messenger → su Página; WhatsApp
 * → su número. Una ficha solo-correo no puede recibir mensajes: se registra en los
 * logs del flujo y no se arranca nada. Devuelve true si el run arrancó.
 */
async function arrancarPorFicha(f: Flow, phone: string, acc: string, varsBase: Record<string, string>, detalle: string, desde?: string): Promise<boolean> {
  const ini = desde || f.start; // RELANZAR-FLUJO-1: arrancar desde un paso elegido
  if (acc.startsWith("ig:")) {
    const igc = resolveAccount(acc.slice(3));
    if (!igc) { fev(f.id, phone, "no entró", ini, detalle + " · su cuenta de Instagram ya no está conectada"); return false; }
    const r: FlowRun = {
      phone, flow_id: f.id, node_id: ini,
      vars: { ...varsBase, __ch: "ig", __igid: acc.slice(3), ...(f.testMode ? { __test: "1" } : {}) },
      status: "active", next_run: Date.now() + RUN_GRACE_MS,
    };
    await dbSaveFlowRun(r);
    fev(f.id, phone, "entró", ini, detalle);
    await runWithAccount(igc, () => run(f, r));
  } else if (acc.startsWith("fb:")) {
    const r: FlowRun = {
      phone, flow_id: f.id, node_id: ini,
      vars: { ...varsBase, __ch: "fb", __fbpage: acc.slice(3), ...(f.testMode ? { __test: "1" } : {}) },
      status: "active", next_run: Date.now() + RUN_GRACE_MS,
    };
    await dbSaveFlowRun(r);
    fev(f.id, phone, "entró", ini, detalle);
    await run(f, r);
  } else if (phone.indexOf("email:") === 0) {
    fev(f.id, phone, "no entró", ini, detalle + " · la ficha no tiene canal de mensajería (solo email)");
    return false;
  } else {
    // WhatsApp: desde el número por el que entró el contacto si se conoce —
    // también en el PRIMER envío (runWithWaNumber), no solo al reanudar.
    const pnid = acc.startsWith("wa:") ? acc.slice(3) : "";
    const waNum = pnid ? resolveWaNumber(pnid) : null;
    const r: FlowRun = {
      phone, flow_id: f.id, node_id: ini,
      vars: { ...varsBase, ...(pnid ? { __pnid: pnid } : {}), ...(f.testMode ? { __test: "1" } : {}) },
      status: "active", next_run: Date.now() + RUN_GRACE_MS,
    };
    await dbSaveFlowRun(r);
    fev(f.id, phone, "entró", ini, detalle);
    if (waNum) await runWithWaNumber({ token: waNum.token, phoneId: waNum.phoneNumberId }, () => run(f, r));
    else await run(f, r);
  }
  return true;
}

/**
 * RELANZAR-FLUJO-1 · Arranca un flujo DESDE SU PASO INICIAL para un contacto que ya
 * existe, por SU canal y SU cuenta (channel_account / ruta viva): Instagram → DM desde
 * su cuenta de IG; Messenger → su Página; WhatsApp → su número (o el fijado en el
 * flujo). Antes cancela el run que tuviera de ESE flujo e ignora «una vez por persona»:
 * es una decisión manual del dueño, no un disparo automático. No hay comentario que
 * responder, así que en IG/FB todo sale por mensaje directo (Meta exige que la persona
 * haya escrito en las últimas 24 h; si no, se devuelve el aviso y se intenta igual).
 */
export async function relanzarFlujo(
  flowId: string,
  phone: string,
  desde?: string,
): Promise<{ ok: boolean; canal?: "whatsapp" | "instagram" | "facebook"; cuenta?: string; flow?: string; desde?: string; aviso?: string; error?: string; status?: number }> {
  const flow = (await listFlows()).find((f) => f.id === flowId);
  if (!flow) return { ok: false, status: 404, error: "Ese flujo ya no existe" };
  if (!flow.start || !(flow.nodes || {})[flow.start]) return { ok: false, status: 400, error: "Este flujo no tiene un primer paso" };
  const paso = String(desde || "").trim();
  if (paso && !(flow.nodes || {})[paso]) return { ok: false, status: 400, error: "Ese paso ya no existe en el flujo: vuelve a abrir el selector de pasos" };
  const c = await getContact(phone);
  if (!c) return { ok: false, status: 404, error: "No hay ningún contacto con ese identificador" };
  if (phone.indexOf("email:") === 0) return { ok: false, status: 400, error: "Este contacto solo tiene correo: no hay chat por el que mandarle el flujo" };
  const src = String(c.source || "").toLowerCase();
  let acc = routeAccount(c);
  // Mismo orden que la Bandeja: Messenger antes que Instagram (sus PSID también son largos).
  const esFb = acc.startsWith("fb:") || (!acc.startsWith("ig:") && (src.includes("facebook") || src.includes("messenger")));
  const esIg = !esFb && (acc.startsWith("ig:") || src.includes("instagram"));
  if (esFb && !acc.startsWith("fb:")) {
    const ca = String(c.channel_account || "");
    if (!ca.startsWith("fb:")) return { ok: false, status: 409, error: "No consta por qué Página de Facebook escribió esta persona" };
    acc = ca;
  }
  if (esIg && !acc.startsWith("ig:")) {
    const ca = String(c.channel_account || "");
    const ig = ca.startsWith("ig:") ? ca.slice(3) : (activeIgCreds().igId || "");
    if (!ig) return { ok: false, status: 409, error: "No hay ninguna cuenta de Instagram conectada" };
    acc = "ig:" + ig;
  }
  let aviso = "";
  if (esIg || esFb) {
    if (esIg && !resolveAccount(acc.slice(3))) return { ok: false, status: 409, error: "La cuenta de Instagram de esta conversación ya no está conectada" };
    if (!inWindow(c)) aviso = "Esta persona no ha escrito en las últimas 24 horas: " + (esIg ? "Instagram" : "Facebook") + " puede rechazar los mensajes del flujo hasta que vuelva a escribir.";
  } else {
    // WhatsApp: si el flujo está atado a un número, sale por ese (como en producción).
    const fijo = flow.appliesTo && resolveWaNumber(String(flow.appliesTo).replace(/^wa:/, "")) ? "wa:" + String(flow.appliesTo).replace(/^wa:/, "") : "";
    if (fijo) acc = fijo;
    const pnid = acc.startsWith("wa:") ? acc.slice(3) : "";
    const abierta = fijo ? inWindowFor(c, fijo) : inWindow(c);
    if (!abierta && !isQrNumber(pnid || activeWaPhoneId()))
      return { ok: false, status: 409, error: "Esta persona no ha escrito por WhatsApp en las últimas 24 horas, así que WhatsApp no deja enviarle los mensajes del flujo. Mándale antes una plantilla aprobada." };
  }
  await dbCancelFlowRunsForPhone(phone, flow.id);
  fev(flow.id, phone, "cancelado", "", paso && paso !== flow.start ? "relanzado a mano → vuelve a empezar desde un paso elegido" : "relanzado a mano → el flujo vuelve a empezar desde el primer paso");
  const arrancado = await arrancarPorFicha(flow, phone, acc, {}, "Relanzado a mano desde el panel", paso || undefined);
  if (!arrancado) return { ok: false, status: 409, error: "No se pudo arrancar el flujo para este contacto (mira «Ver Logs» del flujo)" };
  return { ok: true, canal: esFb ? "facebook" : esIg ? "instagram" : "whatsapp", cuenta: acc, flow: flow.name, desde: paso || flow.start, ...(aviso ? { aviso } : {}) };
}

/**
 * FORMULARIOS-1 · Arranca los flujos con disparador «formulario» (formularios propios,
 * página /f/<slug>). Mismo camino que Typeform: la ficha ya existe cuando se llama.
 */
export async function triggerFormularioFlows(phone: string, info: { formId: string; formTitle: string; vars: Record<string, string> }): Promise<number> {
  const flows = (await listFlows()).filter((f) => f.enabled && f.trigger?.type === "formulario" && (!f.trigger.formId || f.trigger.formId === info.formId));
  if (!flows.length) return 0;
  const c = await getContact(phone);
  if (!c) return 0;
  const acc = routeAccount(c);
  const varsBase: Record<string, string> = {};
  for (const [k, v] of Object.entries(info.vars || {})) varsBase[k] = String(v || "").slice(0, 300);
  let arrancados = 0;
  for (const f of flows) {
    const detalle = "Formulario · «" + String(info.formTitle || "formulario").slice(0, 60) + "»";
    const vetoPrueba = bloqueaPorPrueba(f, "reserva", phone, c.email);
    if (vetoPrueba) { fev(f.id, phone, "no entró", f.start, detalle + " · " + vetoPrueba); continue; }
    if (await arrancarPorFicha(f, phone, acc, varsBase, detalle)) arrancados++;
  }
  return arrancados;
}

/**
 * RECORDATORIO-FLOW-1 · Arranca UN flujo de aviso («recordatorio») para un
 * contacto cuya reunión se acerca. Lo llama el scheduler (remindersTick), que es
 * quien sabe CUÁNDO tocaba (antesMin), qué reunión es y quién reclamó el claim de
 * idempotencia — aquí solo se enruta por el canal del contacto y se arranca el
 * run, calcado de triggerBookingFlows pero para un flujo concreto.
 *
 * `info` viaja como vars del run: en los mensajes del flujo valen {{nombre}},
 * {{evento}}, {{fecha}}, {{hora}} y {{cuando}}. Devuelve true si el run arrancó
 * (false = ficha sin canal o cuenta IG desconectada; queda en los logs del flujo).
 */
export async function triggerReminderFlow(
  phone: string,
  f: Flow,
  info: { nombre: string; evento: string; fecha: string; hora: string; cuando: string },
): Promise<boolean> {
  const c = await getContact(phone);
  if (!c) return false;
  const acc = routeAccount(c); // CHAT-POR-NUMERO-1 · ruta por ventana viva, no atribución congelada
  const varsBase: Record<string, string> = {
    nombre: String(info.nombre || "").slice(0, 120),
    evento: String(info.evento || "tu reunión").slice(0, 200),
    fecha: String(info.fecha || ""),
    hora: String(info.hora || ""),
    cuando: String(info.cuando || ""),
  };
  const detalle = "Aviso de reunión" + (info.evento ? " · «" + String(info.evento).slice(0, 60) + "»" : "");
  // PRUEBA-CANAL-1 · MODO PRUEBA · calcado de reservas: en pruebas solo se avisa a tu
  // número o a tu correo de prueba, nunca a la agenda real.
  const vetoPrueba = bloqueaPorPrueba(f, "reserva", phone, c.email);
  if (vetoPrueba) { fev(f.id, phone, "no entró", f.start, detalle + " · " + vetoPrueba); return false; }
  if (acc.startsWith("ig:")) {
    const igc = resolveAccount(acc.slice(3));
    if (!igc) { fev(f.id, phone, "no entró", f.start, detalle + " · su cuenta de Instagram ya no está conectada"); return false; }
    const r: FlowRun = {
      phone, flow_id: f.id, node_id: f.start,
      vars: { ...varsBase, __ch: "ig", __igid: acc.slice(3), ...(f.testMode ? { __test: "1" } : {}) },
      status: "active", next_run: Date.now() + RUN_GRACE_MS,
    };
    await dbSaveFlowRun(r);
    fev(f.id, phone, "entró", f.start, detalle);
    await runWithAccount(igc, () => run(f, r));
    return true;
  }
  if (acc.startsWith("fb:")) {
    const r: FlowRun = {
      phone, flow_id: f.id, node_id: f.start,
      vars: { ...varsBase, __ch: "fb", __fbpage: acc.slice(3), ...(f.testMode ? { __test: "1" } : {}) },
      status: "active", next_run: Date.now() + RUN_GRACE_MS,
    };
    await dbSaveFlowRun(r);
    fev(f.id, phone, "entró", f.start, detalle);
    await run(f, r);
    return true;
  }
  if (phone.indexOf("email:") === 0) {
    fev(f.id, phone, "no entró", f.start, detalle + " · la ficha no tiene canal de mensajería (solo email)");
    return false;
  }
  // WhatsApp: desde el número por el que entró el contacto si se conoce —
  // también en el PRIMER envío (runWithWaNumber), no solo al reanudar.
  const pnid = acc.startsWith("wa:") ? acc.slice(3) : "";
  const waNum = pnid ? resolveWaNumber(pnid) : null;
  const r: FlowRun = {
    phone, flow_id: f.id, node_id: f.start,
    vars: { ...varsBase, ...(pnid ? { __pnid: pnid } : {}), ...(f.testMode ? { __test: "1" } : {}) },
    status: "active", next_run: Date.now() + RUN_GRACE_MS,
  };
  await dbSaveFlowRun(r);
  fev(f.id, phone, "entró", f.start, detalle);
  if (waNum) await runWithWaNumber({ token: waNum.token, phoneId: waNum.phoneNumberId }, () => run(f, r));
  else await run(f, r);
  return true;
}

/**
 * T03-CORREOS · ¿Este flujo necesita un canal de mensajería para ejecutarse?
 * (mensajes, preguntas, botones, «pedir seguir» o la acción de reservas
 * escriben AL contacto; etiquetar, mover de etapa, puntuar, sincronizar,
 * avisar al equipo, escalar o iniciar otro flujo no). Con un contacto
 * solo-email, un flujo que necesita canal NO entra — decirlo es mejor que
 * fingir un envío (misma regla que reservas/avisos).
 */
export function flowNeedsMessagingChannel(f: Flow): boolean {
  for (const n of Object.values(f.nodes || {})) {
    if (n.type === "message" || n.type === "ask" || n.type === "buttons" || n.type === "follow") return true;
    if (n.type === "action" && n.kind === "book") return true;
  }
  return false;
}

/** T03-CORREOS · Evento individual de correo ya reclamado (dedupe hecho por
 *  quien llama, en app_email_events): aquí solo se casan flujos y se arranca. */
export interface EmailFlowEvent {
  accountId: string;
  /** Etiqueta que la web asignó (señal push). Vacía en eventos de envío. */
  tag: string;
  contactEmail: string;
  /** Clave de idempotencia del EVENTO (la misma por webhook y por poll). */
  dedupeKey: string;
  occurredAt: number | null;
  source: string; // 'webhook' | 'poll'
  /** DIRECTO-1 · evento leído de los destinatarios de UN envío concreto. */
  mailingId?: string;
  evType?: "opened" | "clicked";
  /** DIRECTO-2 · procedencia del envío (si el catálogo la conoce), para casar
   *  alcances 'type'/'origin' sin etiqueta. */
  mOriginType?: string;
  mOriginId?: string;
}

function normTag(s: string | undefined): string {
  return String(s || "").trim().toLowerCase();
}

/** ¿El flujo (activo, trigger email) casa con este evento? Cuenta EXACTA y,
 *  o bien la etiqueta exacta (normalizada), o bien el MISMO envío + el mismo
 *  tipo de evento (seguimiento directo) — sin comodines ni fallbacks. */
export function emailFlowMatches(
  f: Flow,
  evt: { accountId: string; tag: string; mailingId?: string; evType?: string; mOriginType?: string; mOriginId?: string },
): boolean {
  const t = f.trigger;
  if (!f.enabled || t?.type !== "email") return false;
  if (String(t.emAccountId || "") !== evt.accountId) return false;
  if (evt.tag) return !!normTag(t.emTag) && normTag(t.emTag) === normTag(evt.tag);
  if (evt.mailingId) {
    // Un flujo CON etiqueta va SOLO por su etiqueta (modo instantáneo): si
    // también casara por la vía directa, el mismo evento semántico llegaría
    // dos veces con claves distintas y sin línea base.
    if (normTag(t.emTag)) return false;
    if ((t.emEvent === "clicked" ? "clicked" : "opened") !== (evt.evType || "opened")) return false;
    // Correo concreto: el MISMO envío, siempre.
    if (t.emMailingId) return String(t.emMailingId) === String(evt.mailingId);
    // DIRECTO-2 · alcances amplios sin etiqueta: cualquiera de la cuenta, un
    // tipo (procedencia del envío) o un origen (si el catálogo lo mapeó).
    if (t.emScope === "any") return true;
    if (t.emScope === "type") return !!t.emOriginType && evt.mOriginType === t.emOriginType;
    if (t.emScope === "origin") return !!t.emOriginId && !!evt.mOriginId && evt.mOriginId === t.emOriginId;
    return false;
  }
  return false;
}

/**
 * T03-CORREOS · Dispara los flujos con trigger «email» que casen con un evento
 * de correo (etiqueta puente asignada a un contacto). Idempotencia en DOS
 * niveles: el llamante ya reclamó el EVENTO (app_email_events) y aquí se
 * reclama además POR FLUJO (dbClaimOnce) — si el proceso se cae a mitad, el
 * reintento retoma los flujos que faltaban sin repetir los ya arrancados.
 *
 * El canal lo dicta el CONTACTO (por dónde entró), calcado de
 * triggerBookingFlows. Si la ficha es solo-email y el flujo necesita canal de
 * mensajería, se anota en los logs y no se arranca (nunca se finge un envío);
 * si el flujo solo etiqueta/puntúa/avisa al equipo, SÍ corre.
 */
export async function triggerEmailFlows(evt: EmailFlowEvent): Promise<{ started: number; skipped: number }> {
  const email = String(evt.contactEmail || "").trim().toLowerCase();
  if (!email || email.indexOf("@") < 0) return { started: 0, skipped: 0 };
  const flows = (await listFlows()).filter((f) => emailFlowMatches(f, evt));
  if (!flows.length) return { started: 0, skipped: 0 };
  let started = 0;
  let skipped = 0;
  for (const f of flows) {
    const t = f.trigger;
    const detalle =
      "Correo · " +
      (t.emEvent === "clicked" ? "clic en enlace" : "apertura") +
      (t.emSubject ? " · «" + String(t.emSubject).slice(0, 60) + "»" : "") +
      (evt.tag ? " · etiqueta «" + String(evt.tag).slice(0, 60) + "»" : " · seguimiento directo del envío");
    // PRUEBA-CANAL-1 · MODO PRUEBA · antes de reclamar el evento: si se reclamara primero,
    // un flujo en pruebas se comería los eventos de correo de contactos reales y, al
    // apagar las pruebas, esos correos ya no volverían a disparar nada.
    const vetoPrueba = bloqueaPorPrueba(f, "correo", email);
    if (vetoPrueba) {
      fev(f.id, "email:" + email, "no entró", f.start, detalle + " · " + vetoPrueba);
      skipped++;
      continue;
    }
    // CUENTA DESCONECTADA → estado reparable: config intacta, aviso en logs y
    // Centro de actividad; jamás se reasigna a otra cuenta.
    const acc = await siGetAccount(String(t.emAccountId || ""));
    if (!acc) {
      fev(f.id, "email:" + email, "no entró", f.start, detalle + " · la cuenta web del disparador ya no está conectada — repárala en el flujo");
      try {
        await logActivity({
          source: "webhook",
          level: "warn",
          summary: `Flujo «${String(f.name).slice(0, 60)}»: su cuenta web ya no está conectada — el disparador de correo queda en pausa`,
          payload: { file: "flows.ts", fn: "triggerEmailFlows", flow_id: f.id, account_id: String(t.emAccountId || "") },
        });
      } catch { /* telemetría best-effort */ }
      skipped++;
      continue;
    }
    // CLAIM POR FLUJO · un evento ejecuta cada flujo UNA vez (dos workers, o
    // webhook+poll, compiten por esta marca — gana uno).
    if (!(await dbClaimOnce("emailflow:" + f.id, evt.dedupeKey))) {
      skipped++;
      continue;
    }
    // Contacto local: por email (ficha de cualquier canal) o ficha email:*;
    // si no existe, se crea (alta unificada — las acciones necesitan un destino).
    let c = await contactByEmail(email);
    if (!c) c = await getContact("email:" + email);
    if (!c) {
      try {
        c = await createContact({ phone: "email:" + email, email, name: email, source: "systemeio", systemeio_account: acc.id });
      } catch {
        c = await getContact("email:" + email); // carrera con otra alta: releer
      }
    }
    if (!c) {
      fev(f.id, "email:" + email, "no entró", f.start, detalle + " · no se pudo crear la ficha del contacto");
      skipped++;
      continue;
    }
    const phone = c.phone;
    const varsBase: Record<string, string> = {
      correo_evento: t.emEvent === "clicked" ? "clic" : "abierto",
      correo_etiqueta: String(evt.tag || "").slice(0, 120),
      correo_asunto: String(t.emSubject || "").slice(0, 200),
      correo_id: String(t.emEmailId || ""),
      correo_origen_tipo: String(t.emOriginType || ""),
      correo_origen_id: String(t.emOriginId || ""),
      correo_origen_nombre: String(t.emOriginName || "").slice(0, 120),
      correo_cuenta: String(siAccountLabel(acc)).slice(0, 120),
      correo_fecha: evt.occurredAt ? new Date(evt.occurredAt).toISOString() : "",
      contacto_email: email,
    };
    const acct = routeAccount(c); // CHAT-POR-NUMERO-1 · ruta por ventana viva, no atribución congelada
    if (acct.startsWith("ig:")) {
      const igc = resolveAccount(acct.slice(3));
      if (!igc) { fev(f.id, phone, "no entró", f.start, detalle + " · su cuenta de Instagram ya no está conectada"); skipped++; continue; }
      const r: FlowRun = {
        phone, flow_id: f.id, node_id: f.start,
        vars: { ...varsBase, __ch: "ig", __igid: acct.slice(3), ...(f.testMode ? { __test: "1" } : {}) },
        status: "active", next_run: Date.now() + RUN_GRACE_MS,
      };
      await dbSaveFlowRun(r);
      fev(f.id, phone, "entró", f.start, detalle);
      await runWithAccount(igc, () => run(f, r));
    } else if (acct.startsWith("fb:")) {
      const r: FlowRun = {
        phone, flow_id: f.id, node_id: f.start,
        vars: { ...varsBase, __ch: "fb", __fbpage: acct.slice(3), ...(f.testMode ? { __test: "1" } : {}) },
        status: "active", next_run: Date.now() + RUN_GRACE_MS,
      };
      await dbSaveFlowRun(r);
      fev(f.id, phone, "entró", f.start, detalle);
      await run(f, r);
    } else if (phone.indexOf("email:") === 0 && flowNeedsMessagingChannel(f)) {
      fev(f.id, phone, "no entró", f.start, detalle + " · la ficha no tiene canal de mensajería (solo email) y el flujo envía mensajes");
      skipped++;
      continue;
    } else {
      // WhatsApp — o ficha solo-email con flujo SIN mensajes (solo acciones).
      const pnid = acct.startsWith("wa:") ? acct.slice(3) : "";
      const waNum = pnid ? resolveWaNumber(pnid) : null;
      const r: FlowRun = {
        phone, flow_id: f.id, node_id: f.start,
        vars: { ...varsBase, ...(pnid ? { __pnid: pnid } : {}), ...(f.testMode ? { __test: "1" } : {}) },
        status: "active", next_run: Date.now() + RUN_GRACE_MS,
      };
      await dbSaveFlowRun(r);
      fev(f.id, phone, "entró", f.start, detalle);
      if (waNum) await runWithWaNumber({ token: waNum.token, phoneId: waNum.phoneNumberId }, () => run(f, r));
      else await run(f, r);
    }
    started++;
  }
  return { started, skipped };
}

/** ¿El flujo aplica al endpoint (número de WhatsApp / cuenta de IG) que recibió
 *  el evento? `appliesTo` vacío = se aplica a todos. */
export function flowAppliesTo(f: Flow, endpointId: string): boolean {
  return !f.appliesTo || f.appliesTo === endpointId;
}

/**
 * UN-FLUJO-1 · SOLO INSTAGRAM/FACEBOOK · De todos los flujos que casan con un evento,
 * se dispara SOLO EL MÁS ESPECÍFICO.
 *
 * OJO: esta regla NO vale para WhatsApp (ver triggerFlows). Nació de un daño que solo
 * existe en las redes: dos respuestas públicas colgando del mismo comentario y el
 * segundo DM rechazado por Meta. Aplicarla a WhatsApp silenciaba flujos que llevaban
 * meses conviviendo en producción.
 *
 * Antes se arrancaban TODOS los que casaran. Con dos flujos solapados (p.ej. uno
 * atado a una publicación concreta y otro con la palabra clave vacía = "cualquier
 * comentario") pasaba esto: dos respuestas públicas bajo el mismo comentario, y el
 * segundo DM rechazado por Meta (solo permite uno por comentario).
 *
 * Gana el que apunta más fino: publicación concreta > cualquiera; con palabra clave >
 * sin ella; atado a una cuenta/número > todos. A igualdad, el más recientemente
 * editado (el último que tocaste es el que tienes en mente).
 */
/** Longitud de la palabra clave MÁS LARGA que casó. Es el desempate que de verdad
 *  importa: con "equipo" y "Hola Equipo" compitiendo por el mismo mensaje gana la
 *  segunda, porque describe lo que el cliente ha escrito. Sin esto el desempate lo
 *  decidía el orden de la lista —o sea, el azar— y en producción eso podía hacer
 *  ganar al flujo equivocado (caso real: los dos flujos del LIVE de Carla). */
function matchedKeywordLen(text: string, keyword?: string): number {
  const t = deaccent(text || "");
  let best = 0;
  for (const raw of (keyword || "").split(",")) {
    const k = deaccent(raw.trim());
    if (k && t.includes(k)) best = Math.max(best, k.length);
  }
  return best;
}
/** Criterios de especificidad EN ORDEN, del que más manda al que menos. Se comparan
 *  uno a uno (lexicográfico) en vez de sumarse: sumando, un criterio flojo podía
 *  arrastrar a otro fuerte según cómo cayeran los números (con puntos, `appliesTo`
 *  valía 1000 y la longitud de la palabra clave como mucho 999, así que bastaba con
 *  que un flujo estuviera atado a una cuenta y el otro no para que la palabra clave
 *  dejara de decidir NUNCA). Por niveles eso no puede pasar.
 *
 *  1) publicación concreta   — "este post" gana a "cualquier post".
 *  2) palabra clave más larga— la que mejor describe lo que la persona ESCRIBIÓ;
 *                              0 = disparador sin palabra clave (cajón de sastre).
 *  3) atado a una cuenta     — desempate final, ya casi simbólico: los flujos de otras
 *                              cuentas se han filtrado antes con flowAppliesTo(). */
function flowTiers(f: Flow, text?: string): number[] {
  const t = f.trigger || ({} as Flow["trigger"]);
  return [
    t.mediaId && t.mediaId !== "any" ? 1 : 0,
    text ? matchedKeywordLen(text, t.keyword) : (t.keyword || "").trim() ? 1 : 0,
    f.appliesTo ? 1 : 0,
  ];
}
/** Comparador para ordenar de MÁS a MENOS específico. */
function cmpSpecificity(a: Flow, b: Flow, text?: string): number {
  const A = flowTiers(a, text);
  const B = flowTiers(b, text);
  for (let i = 0; i < A.length; i++) if (B[i] !== A[i]) return B[i] - A[i];
  return 0;
}
/**
 * UN-FLUJO-2 · Un contacto = UN flujo a la vez (lo mismo que hace ManyChat).
 *
 * Al arrancar un flujo se cierran los que ese contacto tuviera a medias. Sin esto,
 * dos flujos podían quedarse los dos esperando respuesta del mismo usuario y, como
 * `dbWaitingFlowRun` coge SOLO el más reciente, lo que escribía o pulsaba iba a uno
 * y el otro se quedaba colgado PARA SIEMPRE (nunca recibía lo que había pedido).
 * Ahora siempre está en la conversación que acaba de pedir, que es lo predecible.
 */
async function closeOtherRuns(phone: string, keepFlowId: string, keepName = ""): Promise<void> {
  try {
    // UN-FLUJO-3 (incidente 2026-08-14): antes solo se cancelaba el run en
    // 'waiting' MÁS RECIENTE — un run latente en 'active' (delay) o un segundo
    // en espera sobrevivía y se cruzaba días después con el flujo nuevo
    // (pasó en IG: contacto sin responder activó otra automatización y la
    // vieja resucitó en medio). Ahora se cancelan TODOS los runs vivos del
    // contacto menos el nuevo. Siempre impera la nueva.
    const closed = await dbCancelOtherFlowRuns(phone, keepFlowId);
    if (closed.length) {
      recordWebhook("instagram", "↩️ se cierran " + closed.length + " flujo(s) a medias de este contacto (arranca otro nuevo): " + closed.map((x) => x.flow_id + (x.status === "waiting" ? " (esperaba)" : "")).join(", ").slice(0, 180));
      // Rastro FORENSE (incidente valentinpardo/SEEDANCE 2026-08-15): un run
      // 'cancelled' a secas era indistinguible de cualquier otro cancelado y la
      // investigación fue a ciegas. Cada run desplazado deja SU evento con el
      // paso donde murió y quién lo desplazó.
      for (const x of closed) fev(x.flow_id, phone, "cancelado", x.node_id, "desplazado en «" + x.node_id + "» por el arranque de «" + (keepName || keepFlowId) + "» (UN-FLUJO-3)");
    }
  } catch { /* nunca impide arrancar el flujo nuevo */ }
}

// COLISIÓN-KEYWORD-1 (incidente valentinpardo/SEEDANCE 2026-08-15, endurecido por
// consejo adversarial): el contacto está DENTRO de un flujo (run vivo, p.ej. en un
// delay 'active' donde resumeFlow no lo ve) y llega un texto que VUELVE a casar la
// keyword de ese flujo — el mismo texto del trigger, o el título de un botón. Antes,
// un flujo GEMELO que casara la misma keyword (mismo tipo u otro: ig_dm vs ig_story;
// mismo tier u otro: appliesTo/mediaId) arrancaba y UN-FLUJO-3 cancelaba el run en
// curso a mitad — parón en seco. Regla: si el texto re-casa la keyword (no vacía)
// del flujo QUE YA ATIENDE al contacto, nada arranca y nada se cancela: esa keyword
// ya está siendo atendida. Una keyword DISTINTA de otro flujo sigue desplazando al
// actual («siempre impera la nueva»), y un catch-all vivo (keyword vacía) no
// bloquea a nadie. Se mira contra los runs vivos reales — inmune a tipos y tiers.
async function keywordYaAtendida(phone: string, text: string, ch = "instagram"): Promise<boolean> {
  const vivos = await dbCurrentFlowRunsForPhone(phone);
  if (!vivos.length) return false;
  const flows = await listFlows();
  for (const rr of vivos) {
    const f = flows.find((x) => x.id === rr.flow_id);
    if (!f || !f.enabled) continue; // un flujo APAGADO no retiene a nadie
    const kw = String(f.trigger?.keyword || "").trim();
    if (!kw) continue; // catch-all vivo: la keyword explícita nueva sí impera
    // matchExact con keyword sin caracteres latinos (solo emojis) normaliza a vacío y
    // casaría CUALQUIER texto → sería un bloqueador universal. Se trata como catch-all.
    if (f.trigger?.matchExact && !deaccent(kw).replace(/[^a-z0-9 ]/gi, " ").trim()) continue;
    if (matchesKeyword(text, kw, f.trigger?.matchExact)) {
      // El mensaje NO puede desaparecer de la Bandeja por quedarse aquí.
      await flowLog(phone, "user", text);
      recordWebhook(ch, "⛔ «" + (f.name || f.id) + "» ya atiende a este contacto y el texto re-casa su keyword → no se arranca ningún gemelo ni se cancela su run");
      return true;
    }
  }
  return false;
}

/** `ch` = canal del Diagnóstico de Conexiones donde se anota la elección. Lo usa
 *  también YouTube (triggerYtFlows), que antes arrancaba TODOS los flujos que
 *  casaban y publicaba una respuesta pública por cada uno. */
function mostSpecific(cands: Flow[], text?: string, ch = "instagram"): Flow[] {
  if (cands.length <= 1) return cands;
  const sorted = [...cands].sort((a, b) => cmpSpecificity(a, b, text));
  const top = sorted[0];
  const losers = sorted.slice(1);
  recordWebhook(
    ch,
    "🎯 " + cands.length + " flujos casaban; se dispara solo el más específico: \"" + (top.name || top.id) +
      "\" (descartados: " + losers.map((x) => x.name || x.id).join(", ") + ")",
  );
  return [top];
}

/** ¿El texto casa con la(s) palabra(s) clave? Vacío = cualquiera. Varias separadas por coma = OR.
 *  Insensible a mayúsculas Y a acentos («formación» casa con "formacion" y viceversa):
 *  antes había que duplicar cada keyword con y sin tilde a mano. */
export const deaccent = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
export function matchesKeyword(text: string, keyword?: string, exact?: boolean): boolean {
  if (exact) {
    // FRASE EXACTA · normaliza los DOS lados (sin acentos/mayúsculas/signos, espacios
    // colapsados) y compara IGUALDAD. Toda la keyword es UNA frase (las comas son literales).
    // Así solo dispara quien envía la frase tal cual (el CTA pre-rellenado del enlace).

    // EMOJI-CLAVE-1 · clave de solo emojis: primer norm quita todo [^a-z0-9 ],
    // dejando la frase vacía. Eso NO es un comodín (la clave no es realmente vacía),
    // así que se aplica una segunda norm que conserva pictogramas y se compara eso.
    const kw = String(keyword || "").trim();
    if (!kw) return true; // clave realmente vacía → comodín

    const norm = (s: string) => deaccent(s || "").replace(/[^a-z0-9 ]/gi, " ").replace(/\s+/g, " ").trim();
    const normEmoji = (s: string) => deaccent(s || "").replace(/[^\p{L}\p{N}\p{Extended_Pictographic} ]/gu, " ").replace(/\s+/g, " ").trim();

    // CAJITAS-CLAVE-1 · VARIAS frases exactas, separadas por ';'. La coma NO separa aquí
    // (dentro de una frase es texto), por eso hace falta otro carácter. Sin ';'
    // el resultado es idéntico al de siempre: toda la clave es UNA frase.
    // EMOJI-CLAVE-1 · cada frase se normaliza según su contenido (alfanuméricos con norm,
    // emojis con normEmoji) y se compara el texto normalizado de ambas formas contra todas las frases.
    const frasesOriginal = kw.split(";");
    const frases = frasesOriginal.map((f) => {
      const normalizada = norm(f);
      if (normalizada) return normalizada;
      const normalizadaEmoji = normEmoji(f);
      return normalizadaEmoji || null;
    }).filter(Boolean);

    if (!frases.length) return false; // ni letras ni emojis → no casa con nada

    const t0 = norm(text);
    const t0emoji = normEmoji(text);
    return frases.some((f) => f === t0 || f === t0emoji);
  }
  const kws = (keyword || "")
    // CAJITAS-CLAVE-1 · ';' separa también en «contiene»: es lo que escribe el panel al
    // usar cajitas. Antes un ';' se quedaba DENTRO del término («info;precio» no
    // casaba con nada), así que aceptarlo no cambia ninguna clave que funcionara.
    .split(/[,;]/)
    .map((k) => deaccent(k.trim()))
    .filter(Boolean);
  if (!kws.length) return true; // sin palabra(s) → cualquier mensaje
  const t = deaccent(text);
  return kws.some((k) => t.includes(k));
}

// ============================================================
// PRUEBA-CANAL-1 · MODO PRUEBA, UNA SOLA PUERTA PARA TODOS LOS CANALES
//
// El modo prueba frenaba SOLO WhatsApp: los disparadores de Instagram, Facebook,
// YouTube, correo y reservas se limitaban a marcar el recorrido como prueba
// (vars.__test, que solo comprime las esperas) y seguían escribiendo a contactos
// REALES. La tarjeta del panel, además, se pinta para cualquier disparador y
// prometía «solo el número X dispara este flujo» también ahí.
//
// La causa es que la comprobación vivía copiada dentro de triggerFlows en vez de
// ser una puerta común. Ahora hay una sola función y la llaman TODOS los
// disparadores, cada uno con el contacto que le llega por su canal.
//
// Regla: con el modo prueba encendido, si el flujo no tiene el contacto de prueba
// de SU canal, el flujo NO entra para nadie. Abrirlo a todos sería exponer una
// automatización a medio montar; dejarlo pasar «porque no hay con qué comparar»
// es justo el falso OK que se está arreglando.
// ============================================================

/** PRUEBA-CANAL-1 · Canal por el que un disparador mete gente en el flujo. */
export type CanalPrueba = "whatsapp" | "instagram" | "facebook" | "youtube" | "linkedin" | "correo" | "reserva";

/** PRUEBA-CANAL-1 · Cómo se llama el contacto de prueba de cada canal a ojos del
 *  cliente. Se usa tal cual en el registro del flujo y en el panel: nada de códigos. */
export const CONTACTO_PRUEBA: Record<CanalPrueba, string> = {
  whatsapp: "número de prueba",
  instagram: "usuario de Instagram de prueba",
  facebook: "nombre de Facebook de prueba",
  youtube: "nombre de YouTube de prueba",
  linkedin: "nombre de LinkedIn de prueba",
  correo: "correo de prueba",
  reserva: "número o correo de prueba",
};

/** PRUEBA-CANAL-1 · El contacto de prueba que el flujo tiene guardado para ese canal. */
export function contactoDePrueba(flow: Flow, canal: CanalPrueba): string {
  switch (canal) {
    case "whatsapp": return String(flow.testPhone || "").trim();
    case "instagram": return String(flow.testIgUser || "").trim();
    case "facebook": return String(flow.testFbUser || "").trim();
    case "youtube": return String(flow.testYtUser || "").trim();
    case "linkedin": return String(flow.testLiUser || "").trim();
    case "correo": return String(flow.testEmail || "").trim();
    case "reserva": return String(flow.testPhone || "").trim() || String(flow.testEmail || "").trim();
  }
}

/**
 * PRUEBA-CANAL-1 · ¿El modo prueba impide que este contacto entre en el flujo?
 *
 * Devuelve "" cuando puede entrar, y si no el motivo escrito para el dueño del
 * panel (va tal cual al registro del flujo). `idContacto` es lo que llega por el
 * canal: el número en WhatsApp, quien comenta en Instagram / Facebook / YouTube,
 * el correo en los disparadores de correo, y la clave del contacto en reservas.
 * `correoContacto` solo lo usan reservas y avisos, donde la ficha puede tener
 * correo aunque la reserva no traiga número.
 */
export function bloqueaPorPrueba(flow: Flow, canal: CanalPrueba, idContacto: string, correoContacto = ""): string {
  if (!flow.testMode) return "";
  const falta =
    "modo prueba: este flujo aún no tiene " + CONTACTO_PRUEBA[canal] +
    ", así que no entra nadie hasta que lo indiques en la tarjeta «Modo prueba»";
  const fuera = "modo prueba: solo entra tu " + CONTACTO_PRUEBA[canal] + ", y este contacto no lo es";
  const cifras = (s: string) => String(s || "").replace(/[^\d]/g, "");
  const quien = (s: string) => deaccent(String(s || "").replace(/^@/, "").trim());
  const correo = (s: string) => String(s || "").trim().toLowerCase();
  switch (canal) {
    case "whatsapp": {
      const esperado = cifras(flow.testPhone || "");
      if (!esperado) return falta;
      return cifras(idContacto) === esperado ? "" : fuera;
    }
    case "instagram":
    case "facebook":
    case "youtube":
    case "linkedin": {
      const esperado = quien(contactoDePrueba(flow, canal));
      if (!esperado) return falta;
      // Sin saber QUIÉN ha comentado no se puede afirmar que sea la prueba: no entra.
      const suyo = quien(idContacto);
      return suyo !== "" && suyo === esperado ? "" : fuera;
    }
    case "correo": {
      const esperado = correo(flow.testEmail || "");
      if (!esperado) return falta;
      return correo(idContacto) === esperado ? "" : fuera;
    }
    case "reserva": {
      // La reserva llega por la ficha del contacto, que puede ser un número de
      // WhatsApp o un correo: vale cualquiera de los dos contactos de prueba.
      const numero = cifras(flow.testPhone || "");
      const buzon = correo(flow.testEmail || "");
      if (!numero && !buzon) return falta;
      // Una ficha solo-correo lleva su correo en la clave («email:ana@…»): sacarle
      // «cifras» daría un número inventado, así que ahí solo se compara el correo.
      const suyoNum = idContacto.indexOf("email:") === 0 ? "" : cifras(idContacto);
      if (numero && suyoNum && suyoNum === numero) return "";
      if (buzon && (correo(correoContacto) === buzon || correo(idContacto.replace(/^email:/, "")) === buzon)) return "";
      return fuera;
    }
  }
}

/**
 * COMENTARIO-ABIERTO-1 · ¿El texto del evento abre este disparador?
 *
 * Es el ÚNICO sitio por el que pasan los disparadores de redes: envuelve a
 * matchesKeyword para que el modo «cualquier comentario» sea explícito en el
 * modelo y no un efecto lateral de dejar la palabra clave en blanco. Sin `match`
 * el resultado es idéntico al de siempre, así que es retrocompatible al 100 %.
 */
export function triggerTextMatches(t: Flow["trigger"] | undefined, text: string): boolean {
  if (!t) return true;
  if (t.match === "any") return true; // abre con cualquier cosa que comenten/escriban
  return matchesKeyword(text, t.keyword, t.matchExact);
}

/** KW-UNICA-POST-1 · Términos normalizados de la clave de un disparador (mismo troceo que
 *  matchesKeyword: frase exacta → ';'; contiene → ',' o ';'). Vacío = cualquier comentario. */
function terminosClave(t: Flow["trigger"]): string[] {
  if (t.match === "any") return [];
  const sep = t.matchExact ? /;/ : /[,;]/;
  return String(t.keyword || "").split(sep).map((k) => deaccent(k).replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** KW-UNICA-POST-1 · Un flujo ACTIVO de comentarios con publicación concreta no puede compartir
 *  palabra clave con otro flujo activo del mismo tipo sobre la MISMA publicación: el motor solo
 *  arranca uno por comentario y el otro quedaría mudo sin que nadie lo sepa. Devuelve el mensaje
 *  para el cliente, o null si no choca. Los pausados no cuentan (los duplicados nacen pausados). */
export function conflictoClaveMismoPost(f: Flow, todos: Flow[]): string | null {
  const t = f.trigger;
  if (!f.enabled || !t || !MATCH_APLICA.has(t.type)) return null;
  const media = String(t.mediaId || "");
  if (!media || media === "any") return null;
  const mios = terminosClave(t);
  for (const o of todos) {
    if (o.id === f.id || !o.enabled || o.trigger?.type !== t.type || String(o.trigger.mediaId || "") !== media) continue;
    const suyos = terminosClave(o.trigger);
    const comunes = mios.filter((k) => suyos.includes(k));
    if (!mios.length && !suyos.length) {
      return "El flujo «" + o.name + "» ya responde a cualquier comentario de esta publicación. Pausa uno de los dos o ponles palabras clave distintas.";
    }
    if (comunes.length) {
      return "El flujo «" + o.name + "» ya usa " + (comunes.length > 1 ? "las palabras clave " : "la palabra clave ") +
        comunes.map((k) => "«" + k + "»").join(", ") + " en esta misma publicación. Cámbialas o pausa uno de los dos.";
    }
  }
  return null;
}

/** Disparadores de RED donde elegir «cualquier comentario» significa algo. En
 *  WhatsApp la elección ya es un tipo de disparador aparte (wa_any), y reservas /
 *  avisos / correos ni miran el texto: escribirles un `match` sería ruido. */
const MATCH_APLICA = new Set(["ig_comment", "ig_story", "ig_dm", "fb_comment", "yt_comment", "li_comment"]);

/**
 * Normaliza el modo del disparador ANTES de guardar (lo llama el endpoint de
 * flujos). Deja el par (match, keyword) siempre coherente:
 *   · sin `match` → se deduce de la clave, que es como se comportaba el flujo.
 *   · 'any'  → la clave se vacía: guardarla escondida es lo que hacía que un flujo
 *              «con palabra» y otro «sin palabra» fueran indistinguibles en la BD.
 *   · 'keyword' sin ninguna clave → NO se acepta como tal: sería un catch-all
 *              disfrazado (matchesKeyword('') casa con todo). Se corrige a 'any',
 *              que es lo que de verdad va a hacer, para que el panel lo enseñe.
 * Devuelve true si tuvo que corregir algo.
 */
export function normalizeTriggerMatch(t: Flow["trigger"] | undefined): boolean {
  if (!t) return false;
  if (!MATCH_APLICA.has(t.type)) {
    if (t.match === undefined) return false;
    delete t.match;
    return true;
  }
  const kw = String(t.keyword || "").trim();
  const antes = t.match;
  if (t.match !== "any" && t.match !== "keyword") t.match = kw ? "keyword" : "any";
  if (t.match === "keyword" && !kw) t.match = "any";
  if (t.match === "any" && t.keyword) t.keyword = "";
  return antes !== t.match || (t.match === "any" && kw !== "");
}

/** Comentario IG → arranca flujos con trigger ig_comment que casen.
 *
 *  PUBLICO-OCUPADO-1 · true = un Disparador YA ha publicado su respuesta bajo este
 *  comentario. El flujo se salta entonces la suya y entrega solo por privado: dos
 *  comentarios del negocio colgando del mismo hilo es justo lo que Instagram marca
 *  como spam. No es lo mismo que publicReplyOff (decisión del dueño, permanente):
 *  esto es circunstancial, de este comentario concreto. */
/**
 * COMENTARIO-SIN-FLUJO-1 (incidente @wilmeraguirre1985, 30-oct-2026) · Alguien comenta la
 * palabra clave de un flujo, pero en una publicación que ese flujo NO escucha (el flujo
 * está atado a otro reel: se volvió a publicar la pieza, se subió una variante…). El motor
 * lo descartaba en silencio: ni registro del flujo ni aviso, y el lead se perdía.
 * Devuelve los nombres de los flujos activos cuya palabra clave casa con el texto pero
 * que escuchan OTRA publicación — solo si ningún flujo escucha esta (concreta o «cualquiera»).
 */
export async function flujosIgEnOtraPublicacion(text: string, mediaId: string): Promise<string[]> {
  if (!mediaId || mediaId === "any") return [];
  const me = activeIgCreds().igId;
  const vivos = (await listFlows()).filter((f) => f.enabled && f.trigger?.type === "ig_comment" && flowAppliesTo(f, me));
  const aqui = vivos.some((f) => {
    const mid = f.trigger.mediaId || "any";
    return (mid === "any" || mid === mediaId) && triggerTextMatches(f.trigger, text);
  });
  if (aqui) return [];
  return vivos
    .filter((f) => { const mid = f.trigger.mediaId || "any"; return mid !== "any" && mid !== mediaId && triggerTextMatches(f.trigger, text); })
    .map((f) => f.name);
}

export async function triggerIgFlows(
  igsid: string,
  text: string,
  commentId: string,
  mediaId: string,
  username = "",
  publicoOcupado = false,
): Promise<boolean> {
  const me = activeIgCreds().igId;
  const quien = deaccent(String(username || "").replace(/^@/, "").trim());
  const cands = (await listFlows()).filter((f) => {
    if (!f.enabled || f.trigger?.type !== "ig_comment") return false;
    if (!flowAppliesTo(f, me)) return false;
    const mid = f.trigger.mediaId || "any";
    if (mid !== "any" && mid !== mediaId) return false;
    if (!triggerTextMatches(f.trigger, text)) return false;
    // EXCEPCION-IG-1 · Si esta persona está en la lista de excluidos del flujo (ya
    // compró, ya es cliente…), este flujo NO es para ella. Se compara sin @ y sin
    // acentos; si no tenemos su usuario (username vacío), no se excluye a nadie.
    const excl = (f.trigger.excludeUsers || "")
      .split(",")
      .map((u) => deaccent(u.replace(/^@/, "").trim()))
      .filter(Boolean);
    if (quien && excl.includes(quien)) {
      recordWebhook("instagram", "🚫 @" + username + " está excluido del flujo \"" + f.name + "\" (ya cliente) → no se dispara para él");
      return false;
    }
    return true;
  });
  let started = false;
  // UN-FLUJO-1: un comentario dispara UN solo flujo (Meta solo permite una respuesta
  // privada por comentario: arrancar dos garantizaba que el segundo fallase).
  for (const f of mostSpecific(cands, text)) {
    // PRUEBA-CANAL-1 · MODO PRUEBA · va ANTES de todo lo demás, igual que en WhatsApp: si
    // fuera después, un flujo en pruebas quemaría la marca de «una vez por persona» de
    // cada cliente real que comentara, y le cancelaría un recorrido vivo que sí es suyo.
    const vetoPrueba = bloqueaPorPrueba(f, "instagram", username);
    if (vetoPrueba) {
      recordWebhook("instagram", "flujo \"" + f.name + "\" · " + vetoPrueba);
      fev(f.id, igsid, "no entró", f.start, vetoPrueba);
      continue;
    }
    // RE-DISPARO-IG-1 · Un comentario NUEVO con la palabra clave = "quiero esto (otra
    // vez)". Antes, si quedaba un run a medias (p.ej. esperando el botón de seguir),
    // volver a comentar NO hacía nada y parecía que el flujo estaba roto — sin
    // equivalente al reset por palabra clave que sí tiene WhatsApp. Ahora se cancela
    // el run anterior y se arranca limpio. Cada comentario es único (dbClaimOnce), así
    // que esto no puede entrar en bucle por reintentos de Meta.
    // ONCE-FLOW-1 · gana al RE-DISPARO-IG-1 de abajo, por el mismo motivo que en FB.
    // MARCA-HUERFANA-IG-1 · La marca «una vez por persona» se quema ANTES de arrancar. Si
    // el arranque falló (reinicio, excepción), la persona quedaba bloqueada para siempre
    // SIN haber recibido nada y sin dejar rastro (un `continue` mudo). Una persona que
    // nunca llegó a tener ficha (startFlowIg la crea al arrancar) no ha entrado jamás:
    // su marca es huérfana y se recupera. Quien sí tiene ficha sigue bloqueado.
    if (f.oncePerUser && !(await dbClaimOnce(f.id, igsid))) {
      const nuncaEntro = !(await dbGetContact(igsid).catch(() => null));
      if (!nuncaEntro) {
        fev(f.id, igsid, "no entró", f.start, "ya había entrado antes (flujo de una sola vez por persona)");
        continue;
      }
      recordWebhook("instagram", "♻️ flujo \"" + f.name + "\" · marca huérfana de @" + username + " (nunca llegó a entrar): se recupera");
    }
    if (await dbHasActiveFlowRun(igsid, f.id)) {
      await dbCancelFlowRunsForPhone(igsid, f.id);
      fev(f.id, igsid, "cancelado", "", "comentó de nuevo → el flujo se reinicia desde cero");
      recordWebhook("instagram", "🔄 flujo \"" + f.name + "\" re-disparado: había un run a medias y se reinicia con este comentario");
    }
    try {
      await startFlowIg(igsid, f, commentId, username, publicoOcupado, text);
    } catch (e) {
      // Un arranque fallido no puede dejar la marca quemada: se libera y se propaga.
      if (f.oncePerUser) await dbReleaseClaim(f.id, igsid).catch(() => {});
      throw e;
    }
    recordWebhook("instagram", "▶️ flujo \"" + f.name + "\" disparado por comentario");
    started = true;
  }
  return started;
}

/**
 * BACKFILL-COMENTARIOS-IG · Rescata a quienes comentaron la palabra clave pero NUNCA
 * entraron en la automatización porque su webhook de comentario se perdió (típico en un
 * reinicio del proceso: Instagram no reintenta el webhook de comentario como sí hace con
 * los mensajes). El sondeo `igPollRun` NO cubre esto: solo lee DMs de gente que YA está
 * en espera; a quien nunca entró no lo mira nadie.
 *
 * Señal EXACTA de "se cayó": el webhook reclama TODO comentario nuevo con
 * dbClaimOnce("_ig_comment", commentId) ANTES de mirar flujos. Un comentario SIN
 * reclamar = su webhook no llegó = se perdió. Aquí barremos por API los posts que tienen
 * un flujo de comentario, y por cada comentario que casa la keyword y NO está reclamado,
 * disparamos el flujo igual que lo habría hecho el webhook (reutiliza triggerIgFlows:
 * misma exclusión, mismo "un flujo por comentario", misma creación de contacto).
 *
 * Idempotente: reclama el comentario (dbClaimOnce) antes de disparar, así ni este barrido
 * ni un webhook tardío lo repiten. dryRun=true (por defecto) NO reclama ni envía: solo
 * informa a quién rescataría.
 */
export type IgBackfillReport = {
  dryRun: boolean;
  sinceHours: number;
  accounts: number;
  postsScanned: number;
  matched: number;      // comentarios que casan keyword+ventana (ya dentro o no)
  alreadyIn: number;    // ya reclamados (entraron por webhook) → no se tocan
  dropped: number;      // sin reclamar = se cayeron
  triggered: number;    // rescatados (disparados) en esta pasada
  unresolved: number;   // caídos pero sin IGSID resoluble (from{id} vacío) → no se pudo disparar
  people: Array<{ flow: string; username: string; commentId: string; igsid: string; text: string; when: string; action: string }>;
  errors: string[];
};

// RESCATE-PAUSADO-1 · `incluirReclamados`: un comentario que llegó con el flujo EN PAUSA
// queda reclamado (su webhook sí llegó) pero nadie le escribió. Con esta opción también
// se dispara a esos, siempre que la persona NO tenga ninguna ejecución de ese flujo en la
// ventana: triggerIgFlows cancela y reinicia la que hubiera, así que sin este filtro se
// le repetiría el flujo a quien ya lo recibió.
export async function backfillIgCommentDrops(opts: { sinceHours?: number; dryRun?: boolean; flowId?: string; maxPerMedia?: number; incluirReclamados?: boolean; commentIds?: string[] } = {}): Promise<IgBackfillReport> {
  const sinceHours = opts.sinceHours ?? 24;
  // RESCATE-UNO-1 · rescatar SOLO estos comentarios (el resto del post ni se cuenta):
  // a los que ya se atendieron a mano no se les vuelve a escribir.
  const soloIds = new Set((opts.commentIds || []).map(String).filter(Boolean));
  const cutoff = Date.now() - sinceHours * 3600_000;
  const dryRun = opts.dryRun !== false; // por defecto NO envía
  const rep: IgBackfillReport = { dryRun, sinceHours, accounts: 0, postsScanned: 0, matched: 0, alreadyIn: 0, dropped: 0, triggered: 0, unresolved: 0, people: [], errors: [] };

  const flows = (await listFlows()).filter(
    (f) =>
      f.enabled &&
      f.trigger?.type === "ig_comment" &&
      (!opts.flowId || f.id === opts.flowId) &&
      f.trigger.mediaId &&
      f.trigger.mediaId !== "any", // "any" barrería TODO el perfil: fuera del alcance del rescate
  );
  if (!flows.length) return rep;

  for (const acc of listIgAccounts()) {
    const forAcct = flows.filter((f) => flowAppliesTo(f, acc.igId));
    if (!forAcct.length) continue;
    const creds = resolveAccount(acc.igId);
    if (!creds) { rep.errors.push("cuenta " + acc.igId + " sin credenciales"); continue; }
    rep.accounts++;
    await runWithAccount(creds, async () => {
      let self = "";
      try { self = deaccent(await fetchAllCommentsSelf(acc.igId)); } catch { /* seguimos: como mucho no excluimos el propio */ }
      // Un mismo comentario puede casar varios flujos del mismo post: se dispara UNA vez
      // (triggerIgFlows ya elige el más específico), así que deduplicamos por commentId.
      const seen = new Set<string>();
      for (const f of forAcct) {
        const mediaId = String(f.trigger.mediaId);
        let comments: Awaited<ReturnType<typeof fetchAllComments>>["comments"] = [];
        try {
          const r = await fetchAllComments({ mediaId, includeReplies: true, withFrom: true, maxPerMedia: opts.maxPerMedia ?? 2000 });
          comments = r.comments;
          if (r.error) rep.errors.push("post " + mediaId + ": " + r.error);
          rep.postsScanned++;
        } catch (e) {
          rep.errors.push("post " + mediaId + ": " + (e as Error).message);
          continue;
        }
        const excl = (f.trigger.excludeUsers || "").split(",").map((u) => deaccent(u.replace(/^@/, "").trim())).filter(Boolean);
        let conRun: Set<string> | null = null;
        if (opts.incluirReclamados) {
          try { conRun = new Set((await dbFlowRunPhonesWindow(cutoff, Date.now() + 60_000, [f.id])).phones); }
          catch (e) { rep.errors.push("ejecuciones de " + f.name + ": " + (e as Error).message); continue; }
        }
        for (const c of comments) {
          if ((c.ts || 0) < cutoff) continue;
          if (soloIds.size && !soloIds.has(String(c.commentId))) continue; // RESCATE-UNO-1
          if (!triggerTextMatches(f.trigger, c.text)) continue;
          const uname = deaccent(String(c.username || "").replace(/^@/, ""));
          if (uname && self && uname === self) continue; // comentario propio
          if (uname && excl.includes(uname)) continue;    // excluido del flujo
          rep.matched++;
          if (seen.has(c.commentId)) continue; // ya contabilizado por otro flujo del mismo post
          // ¿llegó su webhook? (reclamado = entró). Lectura, no consume el claim.
          let claimed = false;
          try { claimed = await dbWasClaimed("_ig_comment", c.commentId); } catch { claimed = false; }
          const sinRun = !!conRun && !!c.userId && !conRun.has(String(c.userId));
          if (claimed && !sinRun) { rep.alreadyIn++; seen.add(c.commentId); continue; }
          // CAÍDO.
          rep.dropped++;
          seen.add(c.commentId);
          const igsid = String(c.userId || "");
          let action = "";
          if (!igsid) {
            rep.unresolved++;
            action = "sin IGSID (from{id} vacío) — no se pudo reanudar";
          } else if (dryRun) {
            action = "se rescataría";
          } else {
            // Reclama primero: si aquí mismo llegara un webhook tardío, uno de los dos
            // pierde el INSERT y no se dispara dos veces.
            let claimedNow = claimed; // RESCATE-PAUSADO-1 · ya reclamado: no hay carrera con su webhook
            if (!claimed) { try { claimedNow = await dbClaimOnce("_ig_comment", c.commentId); } catch { claimedNow = false; } }
            if (!claimedNow) { action = "lo tomó otro proceso justo ahora"; }
            else {
              try {
                // Solo cuenta como rescatado lo que arrancó de verdad (antes se contaba
                // aunque triggerIgFlows no arrancara nada).
                if (await triggerIgFlows(igsid, c.text, c.commentId, c.mediaId, c.username)) {
                  rep.triggered++;
                  action = "RESCATADO";
                } else {
                  action = "NO arrancó (ningún flujo lo aceptó: ver Actividad del flujo)";
                  rep.errors.push(c.commentId + ": " + action);
                }
              } catch (e) {
                action = "error al disparar: " + (e as Error).message;
                rep.errors.push(c.commentId + ": " + action);
              }
            }
          }
          rep.people.push({ flow: f.name, username: c.username, commentId: c.commentId, igsid, text: String(c.text || "").slice(0, 60), when: c.ts ? new Date(c.ts).toISOString() : "", action });
        }
      }
    });
  }
  if (!dryRun && rep.triggered) recordWebhook("instagram", "🛟 backfill: " + rep.triggered + " comentario(s) caído(s) reincorporados a su automatización");
  return rep;
}

/**
 * Comentario de YouTube → arranca los flujos con trigger yt_comment que casen
 * (por vídeo concreto o "cualquiera", y por palabra clave).
 *
 * Devuelve cuántos arrancó: el poller lo suma a su tope diario de respuestas,
 * porque un flujo también publica comentarios y cuenta igual para la cuota de
 * la API y para el radar de spam de YouTube.
 *
 * El run se identifica por el CANAL de quien comentó (no hay teléfono ni IGSID),
 * así que `phone` = "yt:<channelId>". Eso hace que dbHasActiveFlowRun evite
 * arrancarle dos veces el mismo flujo a la misma persona.
 */
export async function triggerYtFlows(
  authorChannelId: string,
  text: string,
  commentId: string,
  videoId: string,
  ytAccountId: string,
  /** PRUEBA-CANAL-1 · nombre con el que aparece quien comenta. Es lo ÚNICO legible que
   *  YouTube da de esa persona, y es con lo que se compara el nombre de prueba. */
  authorName = "",
): Promise<number> {
  let started = 0;
  // UN-FLUJO-YT-1 · Igual que triggerIgFlows: un comentario dispara UN solo flujo,
  // el más específico. Antes se iteraba la lista entera y CADA flujo que casaba
  // publicaba su propia respuesta pública al mismo comentario (dos flujos solapados
  // = dos comentarios del canal colgando del mismo hilo, riesgo de baneo por spam).
  const cands = (await listFlows()).filter((f) => {
    if (!f.enabled || f.trigger?.type !== "yt_comment") return false;
    // AMBITO-YT-1 · acota el flujo a UN canal conectado, igual que ig_comment y
    // fb_comment. Sin esto, con dos canales conectados el flujo respondía en los DOS.
    // El valor de appliesTo es el id INTERNO de la cuenta (YtAccount.id), que es lo que
    // el poller pasa aquí — no el channelId UC... de YouTube. Vacío = todos.
    if (!flowAppliesTo(f, ytAccountId)) return false;
    const mid = f.trigger.mediaId || "any";
    if (mid !== "any" && mid !== videoId) return false;
    if (!triggerTextMatches(f.trigger, text)) return false;
    return true;
  });
  for (const f of mostSpecific(cands, text, "yt")) {
    const key = `yt:${authorChannelId || commentId}`;
    // PRUEBA-CANAL-1 · MODO PRUEBA · antes de reclamar nada, por el mismo motivo que en
    // Instagram y Facebook.
    const vetoPrueba = bloqueaPorPrueba(f, "youtube", authorName);
    if (vetoPrueba) {
      recordWebhook("youtube", "flujo \"" + f.name + "\" · " + vetoPrueba);
      fev(f.id, key, "no entró", f.start, vetoPrueba);
      continue;
    }
    if (await dbHasActiveFlowRun(key, f.id)) continue;
    // ONCE-FLOW-1 · solo si sabemos QUIÉN comentó: sin canal, la clave sería única por
    // comentario y no bloquearía nunca — mejor no reclamar que fingir que se reclama.
    if (f.oncePerUser && authorChannelId && !(await dbClaimOnce(f.id, key))) {
      // Nunca en silencio: sin esto «no contestó» y «ya le había contestado» se ven igual en el registro.
      fev(f.id, key, "no entró", f.start, "Ya había entrado en este flujo («una vez por persona»): no se le contesta otra vez");
      recordWebhook("youtube", "flujo \"" + f.name + "\" · ya contestó antes a esa persona (una vez por persona)");
      continue;
    }
    // Campaña UTM legible = nombre del flujo (para atribuir la visita en la
    // analítica del destino). Sin espacios ni acentos raros.
    const camp = (f.name || "flujo")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // borra los acentos (accent) en vez de dejarlos como guion
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "flujo";
    const r: FlowRun = {
      phone: key,
      flow_id: f.id,
      node_id: f.start,
      // __last = el texto del comentario → es lo que evalúan Condición y la IA.
      // __replied: el comentario que ARRANCA el flujo cuenta como «ya escribió» para una
      // condición inmediata (antes de cualquier espera) — mismo comportamiento de siempre.
      vars: { __ch: "yt", __cid: commentId, __ytacc: ytAccountId, __last: text, __replied: "1", __camp: camp },
      status: "active",
      next_run: Date.now() + RUN_GRACE_MS, // CARRERA-TICK-1: el run nace fuera del radar del barrido
    };
    // NOMBRE-COMENTARISTA-1 · la ficha lleva el nombre con el que comenta (antes, «yt:UC…»).
    if (authorName.trim()) { try { await touchContact(key, authorName.trim(), "", "yt:" + ytAccountId, "youtube"); } catch { /* no bloquea el flujo */ } }
    await dbSaveFlowRun(r);
    fev(f.id, key, "entró", f.start, "YouTube · comentario");
    await run(f, r);
    started++;
  }
  return started;
}

/**
 * Comentario de LinkedIn → arranca el flujo con trigger li_comment que case.
 * Calco de triggerYtFlows (LinkedIn tampoco tiene DM ni webhook): un comentario
 * dispara UN solo flujo, el más específico, y la única salida es la respuesta
 * pública como la Página. Lo llama el poller de linkedin-comments.ts.
 *
 * `orgId` = id numérico de la Página (es lo que acota `appliesTo`) y `postUrn` el
 * objeto comentado (urn:li:share:… / ugcPost / activity), contra el que se compara
 * `trigger.mediaId` y sobre el que cuelga la respuesta.
 */
export async function triggerLiFlows(
  actorUrn: string,
  text: string,
  commentUrn: string,
  postUrn: string,
  orgId: string,
  /** Nombre visible de quien comenta (si LinkedIn lo da); con él se compara el nombre de prueba. */
  authorName = "",
): Promise<number> {
  let started = 0;
  const cands = (await listFlows()).filter((f) => {
    if (!f.enabled || f.trigger?.type !== "li_comment") return false;
    if (!flowAppliesTo(f, orgId)) return false;
    const mid = f.trigger.mediaId || "any";
    if (mid !== "any" && mid !== postUrn) return false;
    if (!triggerTextMatches(f.trigger, text)) return false;
    return true;
  });
  for (const f of mostSpecific(cands, text, "linkedin")) {
    const key = `li:${actorUrn || commentUrn}`;
    const vetoPrueba = bloqueaPorPrueba(f, "linkedin", authorName);
    if (vetoPrueba) {
      recordWebhook("linkedin", "flujo \"" + f.name + "\" · " + vetoPrueba);
      fev(f.id, key, "no entró", f.start, vetoPrueba);
      continue;
    }
    if (await dbHasActiveFlowRun(key, f.id)) continue;
    if (f.oncePerUser && actorUrn && !(await dbClaimOnce(f.id, key))) {
      fev(f.id, key, "no entró", f.start, "Ya había entrado en este flujo («una vez por persona»): no se le contesta otra vez");
      recordWebhook("linkedin", "flujo \"" + f.name + "\" · ya contestó antes a esa persona (una vez por persona)");
      continue;
    }
    const camp = (f.name || "flujo")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "flujo";
    const r: FlowRun = {
      phone: key,
      flow_id: f.id,
      node_id: f.start,
      vars: { __ch: "li", __cid: commentUrn, __liorg: orgId, __lipost: postUrn, __last: text, __replied: "1", __camp: camp },
      status: "active",
      next_run: Date.now() + RUN_GRACE_MS,
    };
    if (authorName.trim()) { try { await touchContact(key, authorName.trim(), "", "li:" + orgId, "linkedin"); } catch { /* no bloquea el flujo */ } }
    await dbSaveFlowRun(r);
    fev(f.id, key, "entró", f.start, "LinkedIn · comentario");
    // A diferencia de YouTube aquí no hay cuota que pausar: si LinkedIn rechaza la respuesta
    // (token caducado, comentario borrado) el run se CIERRA con el motivo visible en el registro
    // del flujo, en vez de quedar «activo» y bloquear a esa persona en los próximos comentarios.
    try {
      await run(f, r);
      started++;
    } catch (e) {
      const motivo = (e as Error).message || String(e);
      console.error(`[flow] '${f.name}': LinkedIn no dejó publicar la respuesta:`, motivo);
      fev(f.id, key, "error", r.node_id, "LinkedIn no dejó publicar la respuesta: " + motivo.slice(0, 200));
      recordWebhook("linkedin", "⛔ flujo \"" + f.name + "\" · no se pudo responder en LinkedIn: " + motivo.slice(0, 120));
      r.status = "done";
      await dbSaveFlowRunIfLive(r).catch(() => false);
    }
  }
  return started;
}

/** Arranca un flujo en canal Instagram por DM (sin comentario: respuesta a historia). */
export async function startFlowIgDm(igsid: string, flow: Flow, opts: { desde?: string } = {}): Promise<void> {
  await closeOtherRuns(igsid, flow.id, flow.name || ""); // UN-FLUJO-2
  const r: FlowRun = {
    phone: igsid,
    flow_id: flow.id,
    node_id: flow.start,
    vars: { __ch: "ig", __igid: activeIgCreds().igId || "" }, // sin __cid → envía por DM (sendIgText)
    status: "active",
    next_run: Date.now() + RUN_GRACE_MS, // CARRERA-TICK-1: el run nace fuera del radar del barrido
  };
  // DOBLE-ARRANQUE-1 · igual que en WhatsApp: un segundo disparo en segundos no duplica el flujo.
  if (!(await dbClaimFlowStart(r, DOBLE_ARRANQUE_MS))) {
    console.warn(`[flow] ${igsid} ya acababa de entrar en «${flow.name}»: no se arranca por segunda vez`);
    return;
  }
  fev(flow.id, igsid, "entró", flow.start, opts.desde || (flow.trigger?.type === "ig_story" ? "Instagram · respuesta a historia" : "Instagram · mensaje directo")); // CLASIFICA-FLUJOS-1
  await run(flow, r);
}

/** Respuesta a una Historia de IG → arranca flujos ig_story que casen por historia + palabra clave. */
export async function triggerStoryFlows(
  igsid: string,
  text: string,
  storyId?: string,
): Promise<boolean> {
  const me = activeIgCreds().igId;
  const cands = (await listFlows()).filter((f) => {
    if (!f.enabled || f.trigger?.type !== "ig_story") return false;
    if (!flowAppliesTo(f, me)) return false;
    // Historia concreta: exige CONOCER el id de la historia respondida y que coincida.
    // Antes, si el webhook no traía story.id, el filtro se auto-anulaba y un flujo
    // limitado a UNA historia saltaba con respuestas a CUALQUIERA.
    const mid = f.trigger.mediaId || "any";
    if (mid !== "any" && (!storyId || mid !== storyId)) return false;
    return triggerTextMatches(f.trigger, text);
  });
  if (cands.length && (await keywordYaAtendida(igsid, text))) return true; // COLISIÓN-KEYWORD-1
  let started = false;
  // PRUEBA-CANAL-1 · aquí no llega el usuario que escribe (Instagram solo manda su
  // conversación), así que se lee de su ficha — y solo si hay algún flujo en pruebas:
  // una consulta de más en cada mensaje directo no compensa.
  let quienIg: string | null = null;
  for (const f of mostSpecific(cands, text)) { // UN-FLUJO-1
    // PRUEBA-CANAL-1 · MODO PRUEBA · antes de reclamar nada, igual que en los comentarios.
    if (f.testMode) {
      if (quienIg === null) quienIg = String((await getContact(igsid))?.name || "");
      const vetoPrueba = bloqueaPorPrueba(f, "instagram", quienIg);
      if (vetoPrueba) {
        recordWebhook("instagram", "flujo \"" + f.name + "\" · " + vetoPrueba);
        fev(f.id, igsid, "no entró", f.start, vetoPrueba);
        continue;
      }
    }
    if (await dbHasActiveFlowRun(igsid, f.id)) continue;
    // ONCE-FLOW-1 · llegar aquí ya implica que el flujo va a arrancar (keywordYaAtendida
    // filtró antes), así que la marca no se quema en balde.
    if (f.oncePerUser && !(await dbClaimOnce(f.id, igsid))) continue;
    await startFlowIgDm(igsid, f);
    started = true;
  }
  return started;
}

/** DM directo de IG (no historia ni comentario) → arranca flujos ig_dm que casen por palabra clave. */
export async function triggerIgDmFlows(igsid: string, text: string): Promise<boolean> {
  const me = activeIgCreds().igId;
  const cands = (await listFlows()).filter(
    (f) =>
      f.enabled &&
      f.trigger?.type === "ig_dm" &&
      flowAppliesTo(f, me) &&
      triggerTextMatches(f.trigger, text),
  );
  if (cands.length && (await keywordYaAtendida(igsid, text))) return true; // COLISIÓN-KEYWORD-1
  let started = false;
  // PRUEBA-CANAL-1 · aquí no llega el usuario que escribe (Instagram solo manda su
  // conversación), así que se lee de su ficha — y solo si hay algún flujo en pruebas:
  // una consulta de más en cada mensaje directo no compensa.
  let quienIg: string | null = null;
  for (const f of mostSpecific(cands, text)) { // UN-FLUJO-1
    // PRUEBA-CANAL-1 · MODO PRUEBA · antes de reclamar nada, igual que en los comentarios.
    if (f.testMode) {
      if (quienIg === null) quienIg = String((await getContact(igsid))?.name || "");
      const vetoPrueba = bloqueaPorPrueba(f, "instagram", quienIg);
      if (vetoPrueba) {
        recordWebhook("instagram", "flujo \"" + f.name + "\" · " + vetoPrueba);
        fev(f.id, igsid, "no entró", f.start, vetoPrueba);
        continue;
      }
    }
    if (await dbHasActiveFlowRun(igsid, f.id)) continue;
    // ONCE-FLOW-1 · llegar aquí ya implica que el flujo va a arrancar (keywordYaAtendida
    // filtró antes), así que la marca no se quema en balde.
    if (f.oncePerUser && !(await dbClaimOnce(f.id, igsid))) continue;
    await startFlowIgDm(igsid, f);
    started = true;
  }
  return started;
}

// ── Puente bot→flow ─────────────────────────────────────────────────────────
// El bot (IA) puede DISPARAR flujos de automatización emitiendo INTENT:<clave>.
// Una clave casa con la `intent` explícita de un flujo o, en su defecto, con su
// palabra clave de WhatsApp (así funciona ya con los flujos que tengas creados).

/** Flujos que el bot puede lanzar, con su clave y nombre (para listarlos en su prompt). */
export async function botInvocableFlows(): Promise<{ key: string; name: string }[]> {
  const out: { key: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const f of await listFlows()) {
    if (!f.enabled) continue;
    // Los flujos de reserva/aviso los dispara el sistema con SUS variables
    // ({{reserva_*}}, {{cuando}}…): lanzados por la IA saldrían con huecos.
    if (f.trigger?.type === "booking" || f.trigger?.type === "recordatorio" || f.trigger?.type === "typeform" || f.trigger?.type === "formulario") continue;
    let key = "";
    if (f.intent) key = String(f.intent).trim();
    else if (f.trigger?.type === "wa_keyword" && f.trigger.keyword) key = f.trigger.keyword.split(",")[0]?.trim() || "";
    if (!key) continue;
    const low = key.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push({ key, name: f.name });
  }
  return out;
}

/** Bloque para el system del bot: las automatizaciones que puede lanzar (sus "herramientas"). */
export async function flowToolsPrompt(): Promise<string> {
  const tools = await botInvocableFlows();
  if (!tools.length) return "";
  const lines = tools.map((t) => `- INTENT:${t.key} → ${t.name}`).join("\n");
  return `\n\n# Automatizaciones que puedes lanzar
Cuando el cliente lo necesite (p.ej. ya está cualificado y toca pasarlo a una persona, quiere agendar, etc.), AÑADE AL FINAL de tu respuesta una línea con INTENT:<clave>. Úsalo SOLO cuando aplique; la mayoría de mensajes NO la llevan. El cliente no ve esa línea (el sistema la elimina).
Disponibles:
${lines}`;
}

/** Dispara (en WhatsApp) el flujo cuya `intent` o palabra clave coincide con la clave del bot. */
export async function runFlowByIntent(phone: string, key: string): Promise<boolean> {
  const want = String(key || "").trim().toLowerCase();
  if (!want) return false;
  // booking/recordatorio fuera: los dispara el sistema con sus variables.
  const flows = (await listFlows()).filter((f) => f.trigger?.type !== "booking" && f.trigger?.type !== "recordatorio" && f.trigger?.type !== "typeform" && f.trigger?.type !== "formulario");
  const flow =
    flows.find((f) => f.enabled && f.intent && String(f.intent).trim().toLowerCase() === want) ||
    flows.find(
      (f) =>
        f.enabled &&
        f.trigger?.type === "wa_keyword" &&
        (f.trigger.keyword || "").split(",").some((k) => k.trim().toLowerCase() === want),
    );
  if (!flow) return false;
  if (await dbHasActiveFlowRun(phone, flow.id)) return false; // no re-disparar si ya corre
  // PRUEBA-CANAL-1 · MODO PRUEBA · si el flujo está en prueba, solo el número de prueba
  // puede lanzarlo por IA (misma puerta que los disparadores).
  const vetoPrueba = bloqueaPorPrueba(flow, "whatsapp", phone);
  if (vetoPrueba) { fev(flow.id, phone, "no entró", flow.start, vetoPrueba); return false; }
  // ONCE-FLOW-1 · el bot puede arrancar un flujo por INTENT saltándose triggerFlows:
  // sin este guard, «una vez por persona» tendría una puerta trasera. Va DESPUÉS del
  // modo prueba por el mismo motivo que en triggerFlows: si fuera antes, un flujo en
  // pruebas quemaría la marca de cada cliente real al que el bot intentase meter, y al
  // pasar a producción ya no entraría ninguno.
  if (flow.oncePerUser && !(await dbClaimOnce(flow.id, phone))) return false;
  // CLASIFICA-FLUJOS-1 (MET-AUTO-02) · entrada por el asistente de IA, no por la palabra clave.
  await startFlow(phone, flow, { desde: "WhatsApp · desde el asistente de IA («" + want.slice(0, 60) + "»)" });
  return true;
}

/** Arranca flujos cuyo disparador casa con el mensaje. */
/** KEEP-AI-1 · ¿Este flujo entrega y termina, sin dejar al contacto esperando nada?
 *  Solo entonces es seguro dejar hablar a la IA después: si el flujo se aparca en una
 *  pregunta, unos botones, un «pedir seguir» o una espera, el siguiente mensaje del
 *  contacto se lo come resumeFlow — y si además la IA le ha preguntado otra cosa, esa
 *  respuesta entra en el flujo como si fuera la suya. Con un `ask` de correo eso
 *  significa reintentos y un lead sin email; con cualquier otro, un dato basura
 *  guardado en el CRM. Un Disparador nunca tuvo ese problema porque era de un paso:
 *  esta comprobación es lo que hace la equivalencia honesta. */
function flowEsInstantaneo(flow: Flow): boolean {
  for (const n of Object.values(flow.nodes || {})) {
    const t = (n as { type?: string })?.type;
    if (t === "ask" || t === "buttons" || t === "follow" || t === "delay") return false;
  }
  return true;
}

/** El `out` opcional informa de si los flujos arrancados dejan seguir a la IA
 *  (KEEP-AI-1). Va como parámetro de salida y NO en el valor de retorno a propósito:
 *  quien llama hace `if (await triggerFlows(...))`, y devolver un objeto seguiría
 *  compilando y siendo siempre cierto — la IA se callaría siempre, en silencio. */
export async function triggerFlows(phone: string, text: string, out?: { keepAi?: boolean }): Promise<boolean> {
  const me = activeWaPhoneId();
  const cands = (await listFlows()).filter((f) => {
    if (!f.enabled || !flowAppliesTo(f, me)) return false;
    const t = f.trigger || ({} as Flow["trigger"]);
    // wa_any (cualquier mensaje) es el menos específico: solo gana si no hay otro.
    return t.type === "wa_any" || (t.type === "wa_keyword" && matchesKeyword(text, t.keyword, t.matchExact));
  });
  let started = false;
  let keepAll = true; // KEEP-AI-1 · basta con que UN flujo pida silencio para que la IA calle
  // UN-FLUJO-1 NO SE APLICA A WHATSAPP (a propósito). Es una regla de INSTAGRAM: allí
  // dos flujos solapados dejan dos respuestas públicas bajo el mismo comentario y Meta
  // rechaza el segundo DM. En WhatsApp no existe ninguno de esos dos daños, y recortar
  // a un solo flujo CAMBIABA el comportamiento que llevaba meses en producción: los
  // flujos del Setter tienen palabras clave que se solapan ("enlace" en PEDIR
  // DIAGNÓSTICO, "equipo/Link/hoy" en ENLACE LIVE DIRECTO), así que un mensaje como
  // "Hola equipo, ¿me pasáis el enlace?" casaba con los dos y el alumno recibía los
  // dos. Con el recorte se quedaba en uno —y cuál, dependía de cuál se hubiera editado
  // por última vez en el panel—, o sea que el alumno podía dejar de recibir el enlace
  // del Zoom sin ningún error visible. En WhatsApp arrancan TODOS los que casan.
  for (const f of cands) {
    if (await dbHasActiveFlowRun(phone, f.id)) continue;
    // PRUEBA-CANAL-1 · MODO PRUEBA · si el flujo está en pruebas, SOLO entra el número de
    // prueba; los clientes quedan fuera (así se valida sin exponerlo). Sin número de
    // prueba → nadie entra (evita abrirlo a clientes sin querer). La comprobación es la
    // misma puerta que usan los otros cinco disparadores.
    const vetoPrueba = bloqueaPorPrueba(f, "whatsapp", phone);
    if (vetoPrueba) {
      recordWebhook("whatsapp", "flujo \"" + f.name + "\" · " + vetoPrueba);
      fev(f.id, phone, "no entró", f.start, vetoPrueba);
      continue;
    }
    // ONCE-FLOW-1 · se reclama AQUÍ, con el arranque ya decidido: si fuera antes del
    // bloque MODO TEST de arriba, un flujo en pruebas quemaría la marca de cada cliente
    // real que escribiera la palabra clave, y al pasar a producción ya no entraría nadie.
    if (f.oncePerUser && !(await dbClaimOnce(f.id, phone))) continue;
    // KEEP-AI-1 · con la IA siguiendo, el turno del cliente lo registra think() al
    // hablar; escribirlo también aquí lo duplicaría en la Bandeja y en el historial
    // que lee el modelo.
    const dejaIa = !!f.keepAi && flowEsInstantaneo(f);
    if (!started && !dejaIa) await flowLog(phone, "user", text); // mensaje que disparó el flujo → visible en la Bandeja
    await startFlow(phone, f);
    started = true;
    // En WhatsApp arrancan TODOS los flujos que casan (ver arriba), así que basta con
    // que UNO pida silencio para que la IA calle: quien lo pide, gana.
    if (!dejaIa) keepAll = false;
  }
  if (out) out.keepAi = started && keepAll;
  return started;
}

/** ¿El mensaje casa con la palabra clave de algún disparador de flujo activo para el
 *  número actual? Es señal de "quiero empezar (otra vez)". */
async function matchesAnyWaTrigger(text: string): Promise<boolean> {
  const me = activeWaPhoneId();
  for (const f of await listFlows()) {
    if (!f.enabled || !flowAppliesTo(f, me)) continue;
    const t = f.trigger || ({} as Flow["trigger"]);
    if (t.type === "wa_keyword" && t.keyword && matchesKeyword(text, t.keyword, t.matchExact)) return true;
  }
  return false;
}

/** Si hay un flujo esperando respuesta de este contacto, la procesa. */
/** `ch` = canal por el que entró el mensaje. Solo afecta a la telemetría: el buffer de
 *  "últimos webhooks" es un anillo de 30 por proceso, y meter en él CADA mensaje de
 *  WhatsApp lo dejaba inservible justo cuando hace falta (depurar por qué un flujo no
 *  responde), además de rotular tráfico de WhatsApp como "instagram". */
/**
 * Deja constancia de que el contacto RESPONDIÓ en los flujos que están esperando por un
 * DELAY (status='active', a la espera del scheduler). Esos flujos —los del patrón
 * mensaje→espera→condición «¿respondió?»— NUNCA entran en 'waiting', así que resumeFlow
 * no los ve y la respuesta se perdía: la condición «último mensaje escrito» salía SIEMPRE
 * "no" y el aviso al closer no se disparaba jamás (bug reportado en el flujo PEDIR
 * DIAGNÓSTICO de Carla). Aquí escribimos __last/__replied (lo que evalúa la condición);
 * el flujo NO avanza por aquí — de eso se encarga el scheduler al vencer el delay — con UNA
 * excepción: si el flujo tiene DERIVACIÓN INMEDIATA (rdEnabled), escribir durante la espera
 * deriva a Carla al instante y TERMINA el run (devuelve true para que la IA calle). Se llama
 * en CADA mensaje entrante, antes de resumeFlow. Si el mensaje es el disparador que arranca
 * el flujo, todavía no hay run activo → no se marca (correcto: el disparador no es una
 * "respuesta"). Best-effort: nunca debe tumbar el pipeline de entrada.
 */
/** Nº de closer por defecto de un flujo: el del primer paso «Avisar a un closer». */
function flowDefaultNotifyPhones(flow: Flow): string {
  for (const n of Object.values(flow.nodes || {})) {
    const a = n as { notify?: boolean; kind?: string; notifyPhones?: string };
    if ((a.notify || a.kind === "notify") && a.notifyPhones) return a.notifyPhones;
  }
  return "";
}
/** Devuelve true si algún flujo DERIVÓ al lead a Carla por escribir durante una espera
 *  (rdEnabled): el pipeline debe entonces callar a la IA — la derivación ya contestó. */
export async function noteReplyToActiveRuns(phone: string, text: string): Promise<boolean> {
  let derived = false;
  try {
    const runs = await dbActiveFlowRunsForPhone(phone);
    // FU-CANCEL-1 · 2026-08-20 (bug real en producción: reenganche a quien SÍ
    // contestó): también hay que mirar los runs en 'waiting' — su reloj de
    // inactividad vivía al margen de los mensajes entrantes (solo lo desarmaba
    // resumeFlow si consumía ESE run concreto, y solo mira el más reciente).
    const waitingRuns = await dbWaitingFlowRunsForPhone(phone).catch(() => [] as FlowRun[]);
    if (!runs.length && !waitingRuns.length) return false;
    const flows = await listFlows();
    // ¿Hay un run ESPERANDO respuesta (botón/pregunta) de este contacto? Entonces este
    // mensaje es con toda probabilidad ESA respuesta y la consumirá resumeFlow: aquí solo
    // se marca la ventana, JAMÁS se deriva (un tap de botón de otro flujo NO es «el lead
    // escribiendo por iniciativa», y derivar daría dos respuestas contradictorias a la vez).
    let hayRunEsperando = false;
    try { hayRunEsperando = !!(await dbWaitingFlowRun(phone)); } catch { /* prudencia: sin dato, no derivar */ hayRunEsperando = true; }
    for (const r of runs) {
      const flow = flows.find((f) => f.id === r.flow_id);
      const node = flow?.nodes?.[r.node_id] as { type?: string } | undefined;
      // DERIVACIÓN INMEDIATA (rdEnabled) · Solo si el run está APARCADO EN UNA ESPERA (el
      // node_id apunta al delay) y nada más va a responder a este mensaje. Un solo aviso
      // por mensaje aunque el contacto tenga varios runs aparcados.
      let derive = !!flow?.rdEnabled && node?.type === "delay" && !derived && !hayRunEsperando;
      // Palabra clave de disparador → el lead pide ARRANCAR un flujo, no ayuda: el pipeline
      // normal (reset + triggerFlows) debe gestionarlo; derivar aquí se lo comería.
      if (derive && (!r.vars.__ch || r.vars.__ch === "wa") && (await matchesAnyWaTrigger(text))) derive = false;
      // Regla de compra (no derivar a quien ya compró) + CUALIFICACIÓN MÍNIMA (solo derivar a
      // quien ya vio la formación — etiquetas de rdRequireTags). Una sola lectura del contacto.
      const reqRaw = (flow?.rdRequireTags || "").trim();
      if (derive && ((flow!.stopTag && flow!.stopTag.trim()) || reqRaw)) {
        const norm = (s: unknown) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[-_\s]+/g, " ").trim();
        try {
          const c = await getContact(r.phone);
          const tags = (c?.tags || []).map(norm);
          const stop = norm(flow!.stopTag || "");
          if (stop && tags.includes(stop)) derive = false;
          if (derive && reqRaw) {
            const req = reqRaw.split(",").map(norm).filter(Boolean);
            if (req.length && !req.some((t) => tags.includes(t))) derive = false; // sin cualificar → el flujo/IA siguen su curso
          }
        } catch {
          // Sin poder leer el contacto: con cualificación exigida NO derivamos (prudencia:
          // el owner prohíbe pasar leads sin cualificar); sin ella, derivamos igual.
          if (reqRaw) derive = false;
        }
      }
      // Canal de origen irresoluble → no derivar en falso; el temporizador seguirá su curso.
      const chan = derive ? flowChannel(r) : null;
      if (derive && !chan) derive = false;
      if (!derive) {
        // Solo marcar la VENTANA-DE-RESPUESTA: escribió dentro de la espera en curso.
        r.vars.__last = text;
        r.vars.__lastAt = String(Date.now());
        r.vars.__replied = "1";
        // STOP-CAS · con guarda: si justo lo cancelaron desde el panel, no resucitarlo.
        await dbSaveFlowRunIfLive(r);
        continue;
      }
      // CAS anti-carrera con flowTick: cierra el run SOLO si sigue aparcado en ESTE delay y
      // el temporizador AÚN NO venció (el tick solo toca runs vencidos → conjuntos disjuntos).
      // Si no gana, el flujo está avanzando/avanzó y contestará por su camino normal.
      const won = await dbDeriveActiveDelayRun(r.phone, r.flow_id, r.node_id, { ...r.vars, __last: text, __lastAt: String(Date.now()), __replied: "1" });
      if (!won) continue;
      derived = true;
      try { await enrichContact(r.phone, { tags: ["escribió"] }); } catch { /* best-effort */ }
      await chan!(async () => {
        try { await say(r, (flow!.rdMsg || "").trim() || ("Te paso con " + (await equipoDeDerivacion()) + " para que te conteste directamente, le aviso 🙌")); } catch { /* noop */ }
        // Con plantilla SIEMPRE (fallback a la del seguimiento): el aviso de la derivación
        // inmediata debe llegar a Carla aunque esté fuera de la ventana de 24 h. Antes iba como
        // texto libre y Meta lo rechazaba en silencio (visto en producción, 2026-07-28).
        try { await notifyClosers(r.phone, { notifyPhones: flow!.rdNotifyPhones || flowDefaultNotifyPhones(flow!), notifyTemplate: flow!.rdNotifyTemplate || flow!.fuNotifyTemplate, notifyLang: flow!.rdNotifyLang || flow!.fuNotifyLang }); } catch (e) { console.warn("[flow] rd notify:", (e as Error).message); }
      });
      try { await setHuman(r.phone, true); } catch { /* noop */ } // Carla toma la conversación: la IA calla
      fev(flow!.id, r.phone, "derivado · escribió en espera", r.node_id, String(text || "").replace(/\s+/g, " ").slice(0, 120));
      // NOTIFICACIONES-1 · flujo_salida: contestó a mitad de la automatización y el flujo se detiene.
      avisarContacto("flujo_salida", r.phone, (nm) => ({ title: nm + " contestó y salió de «" + flow!.name + "»", body: "«" + String(text || "").replace(/\s+/g, " ").trim().slice(0, 140) + "» — el flujo se ha detenido y la conversación es tuya." }), { dedup: dedupVentana("salida:" + flow!.id + ":" + r.phone, 10) });
    }
    // FU-CANCEL-1 · cualquier mensaje del contacto REINICIA la cadencia de
    // reenganche de TODOS sus runs aparcados: el reloj de inactividad cuenta
    // desde su último mensaje, no desde que el flujo preguntó. resumeFlow
    // decide después si la respuesta además avanza el run más reciente (este
    // guardado no toca node_id/status/__since, así que no interfiere).
    for (const w of waitingRuns) {
      try {
        const wf = flows.find((f) => f.id === w.flow_id);
        w.vars.__last = text;
        w.vars.__lastAt = String(Date.now());
        w.vars.__replied = "1";
        if (wf?.fuEnabled) {
          const t1 = w.vars.__test === "1" ? 1 : Math.max(1, Number(wf.fuT1) || 90);
          delete w.vars.__fu; // cadencia de reenganche desde cero
          w.next_run = applyQuiet(wf, w, Date.now() + t1 * 60_000);
        }
        await dbSaveFlowRunIfLive(w); // STOP-CAS: un run cancelado desde el panel no se resucita
      } catch { /* best-effort por run */ }
    }
  } catch (e) {
    console.warn("[flow] noteReplyToActiveRuns:", (e as Error).message);
  }
  return derived;
}

/** IG-CLAVE-GANA-1 · ¿El texto contiene, como palabra(s) entera(s), sin mayúsculas ni tildes,
 *  la palabra clave de OTRO flujo de Instagram activo de esta cuenta? «quiero la clase» casa
 *  «clase»; «clases» no. Nunca cuenta si el texto es el rótulo de un botón del paso actual
 *  (el sondeo no sabe si fue un toque). Los de «cualquier mensaje» no interrumpen a nadie. */
export function casaPalabraEntera(text: string, keyword?: string, exact?: boolean): boolean {
  const kw = String(keyword || "").trim();
  if (!kw) return false;
  if (exact) return matchesKeyword(text, kw, true);
  const n = (s: string) => " " + deaccent(s).replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim() + " ";
  const t = n(text);
  return kw.split(/[,;]/).map((k) => n(k)).some((k) => k.trim() !== "" && t.includes(k));
}

async function claveDeOtroFlujoIg(r: FlowRun, text: string, isStory: boolean, storyId?: string): Promise<boolean> {
  const flows = await listFlows();
  const actual = flows.find((f) => f.id === r.flow_id);
  const nodo = actual?.nodes[r.node_id] as { options?: { label: string }[] } | undefined;
  const nb = (s: string) => deaccent(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if ((nodo?.options || []).some((o) => nb(o.label) === nb(text))) return false;
  const me = activeIgCreds().igId;
  return flows.some((f) => {
    if (!f.enabled || f.id === r.flow_id || !flowAppliesTo(f, me)) return false;
    const t = f.trigger;
    if (!t || t.match === "any") return false;
    if (t.type !== "ig_dm" && !(isStory && t.type === "ig_story")) return false;
    // Mismo filtro de historia concreta que triggerStoryFlows: si ese flujo no va a arrancar,
    // el mensaje no puede salirse del flujo actual.
    if (t.type === "ig_story" && (t.mediaId || "any") !== "any" && t.mediaId !== storyId) return false;
    return casaPalabraEntera(text, t.keyword, t.matchExact);
  });
}

/** IG-SIN-NOENTENDI-1 · Contestaste desde la Bandeja: las insistencias que se pausaron
 *  porque la persona escribió en vez de pulsar vuelven a contar desde ahora. */
export async function reanudarInsistenciasIg(phone: string): Promise<void> {
  const runs = await dbWaitingFlowRunsForPhone(phone).catch(() => [] as FlowRun[]);
  if (!runs.some((x) => x.vars?.__fuPausa === "1")) return;
  const flows = await listFlows();
  for (const x of runs) {
    if (x.vars?.__fuPausa !== "1") continue;
    const f = flows.find((y) => y.id === x.flow_id);
    if (!f) continue;
    delete x.vars.__fuPausa;
    await parkWaiting(f, x);
    fev(f.id, phone, "aviso", x.node_id, "contestaste desde la Bandeja → vuelven las insistencias");
  }
}

export async function resumeFlow(phone: string, text: string, ch: "wa" | "ig" | "fb" = "wa", opts?: { esBoton?: boolean; isStory?: boolean; storyId?: string }): Promise<boolean> {
  // Si el mensaje es una PALABRA CLAVE de disparador, el cliente quiere empezar de nuevo:
  // liberamos cualquier flujo atascado y dejamos que triggerFlows lo arranque limpio, en
  // vez de tratar la palabra clave como una respuesta perdida a un botón. Antes, un flujo
  // que se quedaba esperando (p.ej. tras un fallo de envío) atrapaba al cliente para
  // siempre: cualquier cosa que escribiera —incluida la propia palabra clave— caía en
  // "No te entendí" y no había forma de reiniciar.
  const r = await dbWaitingFlowRun(phone);
  // CROSS-CANAL-1: el reset por palabra clave es una regla de WHATSAPP. Antes se
  // aplicaba también a runs de INSTAGRAM en espera: si el usuario de IG respondía algo
  // que casara por substring con la keyword de CUALQUIER flujo de WhatsApp activo
  // (p.ej. "Ya te sigo ✅" conteniendo "sigo"), su flujo de IG se cancelaba en seco.
  // CROSS-CANAL-1b (consejo 2026-08-15): con r=null (run IG en delay 'active') la
  // guarda de abajo no protegía y un tap/texto IG que casara por substring una
  // keyword de WhatsApp cancelaba TODOS los runs del contacto sin rastro. El reset
  // por keyword es una regla de WHATSAPP: solo corre procesando WhatsApp.
  if (ch === "wa" && (!r || r.vars.__ch !== "ig") && (await matchesAnyWaTrigger(text))) {
    await dbCancelFlowRunsForPhone(phone);
    if (r) fev(r.flow_id, phone, "cancelado", r.node_id, "escribió otra palabra clave → reinicia limpio");
    return false;
  }
  // TELEMETRIA-IG-2: sin esto, una respuesta que no encuentra flujo en espera
  // desaparecía sin dejar rastro y parecía que "el botón no hace nada".
  if (!r) {
    if (ch !== "wa") recordWebhook("instagram", "🤷 respuesta de " + phone.slice(-6) + " SIN flujo en espera (nadie la retoma)");
    return false;
  }
  // IG-CLAVE-GANA-1 · En Instagram la palabra clave de OTRO flujo gana: con los botones del
  // diagnóstico pendientes, «clase» (por privado o respondiendo a una historia) tenía que
  // arrancar el flujo de la clase y en su lugar caía aquí como respuesta inválida («No te
  // entendí»). No se cancela nada aquí: devolvemos false y el disparador que arranca cierra
  // los runs anteriores (UN-FLUJO-3), que es lo que deja el seguimiento solo del último.
  // Por PALABRA ENTERA y solo contra flujos de Instagram de esta cuenta (CROSS-CANAL-1: el
  // substring contra claves de WhatsApp cancelaba runs con «Ya te sigo» → «sigo»).
  if (ch === "ig" && r.vars.__ch === "ig" && !opts?.esBoton && (await claveDeOtroFlujoIg(r, text, !!opts?.isStory, opts?.storyId))) {
    recordWebhook("instagram", "🔀 escribió la palabra clave de otro flujo → arranca ese y el actual deja de esperar");
    return false;
  }
  // Sin el TEXTO del cliente: este buffer es un anillo único de proceso, sin workspace,
  // y se sirve entero al admin de cualquier cuenta → no puede llevar contenido de nadie.
  if (ch !== "wa" || r.vars.__ch === "ig") {
    recordWebhook("instagram", "↩️ respuesta de " + phone.slice(-6) + " retoma el flujo en el paso " + r.node_id);
  }
  // El cliente respondió a un flujo en curso: guarda su mensaje en la conversación
  // para que se VEA en la Bandeja (antes el flujo lo atendía mudo y no se reflejaba).
  await flowLog(phone, "user", text);
  fev(r.flow_id, phone, "respondió", r.node_id, String(text || "").replace(/\s+/g, " ").slice(0, 140));
  const flow = (await listFlows()).find((f) => f.id === r.flow_id);
  if (!flow) {
    await finish(r);
    return false;
  }
  const node = flow.nodes[r.node_id];
  if (!node) {
    await finish(r);
    return true;
  }
  r.vars.__last = text;
  r.vars.__replied = "1"; // VENTANA-DE-RESPUESTA: acaba de escribir (cuenta para el próximo «¿Respondió?»)
  if (node.type !== "buttons") delete r.vars.__fuPausa; // IG-SIN-NOENTENDI-1 · solo pausa un paso de botones

  if (node.type === "ask") {
    const key = (node.saveAs || "").trim().toLowerCase();
    const isEmailAsk = esPasoDeCorreo(node);
    // Al escribir un correo desde el móvil es normalísimo que llegue con espacios
    // sueltos, con el teclado en mayúsculas, con caracteres invisibles pegados al
    // copiar… o DENTRO DE UNA FRASE («Hola mi correo es fulano@gmail.com por favor»).
    //
    // Antes esto se "limpiaba" quitando TODOS los espacios, lo que PEGABA la frase al
    // correo («holabuenastardesnombre@gmail.comporfavor») y esa cadena además PASABA
    // la validación (un solo @, sin espacios, termina en letras) → 9 leads reales de
    // un cliente acabaron en systeme.io con un correo roto y sin su email (2026-07-31).
    // Ahora se EXTRAE el primer token con forma de correo de lo que haya escrito; solo
    // si no hay ninguno se cae a la limpieza antigua (y la validación lo re-preguntará).
    // Solo en el paso de email: los demás campos se guardan tal cual.
    const sinInvisibles = text.replace(/[​-‍﻿￼]/g, "");
    // CAPTURA-EMAIL-2 (2026-08-14, aviso del owner): el patrón ASCII rechazaba
    // dominios personalizados con letras internacionales (ñ, acentos — nada
    // raro en dominios .es) y el lead acababa sin email tras 3 intentos con un
    // correo PERFECTAMENTE válido. Ahora local y dominio aceptan \p{L}\p{N}
    // (Unicode) y se recorta la puntuación colgante («mi@correo.com.», «…com,»).
    const emailToken = isEmailAsk
      ? sinInvisibles.match(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u)?.[0]
      : undefined;
    const val = isEmailAsk
      ? (emailToken || sinInvisibles.replace(/\s+/g, "")).trim().toLowerCase().replace(/[.,;:!?]+$/u, "")
      : text.trim();
    const looksLikeEmail = /^[^@\s]+@[^@\s]+\.\p{L}{2,}$/iu.test(val);

    // CAPTURA-EMAIL-1: si el paso pide un EMAIL y lo que llega no lo es, se vuelve a
    // preguntar en vez de tragárselo. Antes se guardaba la basura en fields.email,
    // contact.email quedaba vacío, el flujo seguía y el sync a systeme.io moría
    // después sin que nadie se enterara.
    //
    // CAPTURA-EMAIL-4 · cuántas veces se pide y qué pasa al rendirse YA NO ESTÁ AQUÍ: lo dice
    // el flujo, desde el panel. El comportamiento de siempre (3 intentos y seguir) es el que
    // sale cuando el flujo no dice nada, así que nada de lo ya guardado cambia.
    //
    // Y el «seguir adelante» deja de ser ciego: si más adelante el premio se entrega POR
    // CORREO, seguir no es no dejar tirada a la persona — es decirle «revisa tu correo en unos
    // minutos» sabiendo que no va a llegar nada. Ahí pasa a una persona.
    if (isEmailAsk && !looksLikeEmail) {
      const cap = topeIntentosCorreo(node);
      const tries = Number(r.vars.__emailTries || 0) + 1;
      r.vars.__emailTries = String(tries);
      if (tries < cap) {
        // El lead ESCRIBIÓ (aunque no fuera un email válido): se reaparca por parkWaiting para
        // reiniciar el reloj de inactividad. Sin esto, el reloj seguía corriendo desde que entró
        // al nodo y podía reengancharlo/derivarlo a Carla mientras corregía el correo.
        await parkWaiting(flow, r);
        await say(
          r,
          tries === 1
            ? (node.retryText || "Mmm, eso no parece un correo 🤔 ¿Me lo escribes otra vez? (p. ej. nombre@correo.com)")
            : (node.retryText2 || "Sigue sin parecer un correo válido. Escríbelo tal cual, sin espacios (p. ej. nombre@correo.com)."),
        );
        return true; // seguimos esperando en el MISMO nodo
      }
      // Se acabaron los intentos. Qué hacer lo decide el FLUJO (o se deduce de él).
      if (queHacerSinCorreo(flow, node) === "human") {
        await say(
          r,
          node.failText ||
            "No consigo tu correo, y sin él no puedo enviártelo. Te paso con una persona del equipo, te escribe en breve. 🙌",
        );
        await setHuman(r.phone, true); // silencia el bot y deja la conversación en la Bandeja
        // NOTIFICACIONES-1 · pide_persona
        avisarContacto("pide_persona", r.phone, (nm) => ({ title: nm + " pasa a tu equipo", body: "No dio un correo válido en el flujo «" + flow.name + "»: el bot le ha pasado con una persona." }), { dedup: dedupVentana("persona:" + flow.id + ":" + r.phone, 30) });
        await notifyClosers(r.phone, {
          notifyPhones: node.notifyPhones || flow.rdNotifyPhones || flow.fuNotifyPhones || flowDefaultNotifyPhones(flow),
          notifyTemplate: flow.fuNotifyTemplate,
          notifyLang: flow.fuNotifyLang,
        });
        fev(
          flow.id,
          r.phone,
          "aviso",
          r.node_id,
          cap + " intentos sin un correo válido — pasa a una PERSONA porque el premio se entrega por correo (último texto: «" + text.slice(0, 60) + "»)",
        );
        await finish(r);
        return true;
      }
      console.warn(`[flow] ${telLog(phone)}: ${cap} intentos sin un email válido; el flujo continúa sin él`);
      // Visible en los eventos del flujo (antes solo console — invisible para el owner).
      fev(flow.id, r.phone, "aviso", r.node_id, cap + " intentos sin un correo válido — el flujo continúa SIN correo (último texto: «" + text.slice(0, 60) + "»)");
    }
    if (isEmailAsk && looksLikeEmail) r.vars.__emailTries = "0";

    // Se guarda el valor LIMPIO (el correo normalizado), no el texto crudo: si no, en
    // el contacto y en el sync acabaría " Nombre@Correo.COM " con espacios y mayúsculas.
    const guardado = isEmailAsk && looksLikeEmail ? val : text;
    r.vars[node.saveAs] = guardado;
    // Si el ask guarda en un campo de email/nombre, escríbelo también en la
    // columna núcleo del contacto (no solo en fields) → así el sync a
    // systeme.io lo recoge. El email se valida antes de fijarlo.
    const enrich: { fields: Record<string, string>; email?: string; name?: string } = {
      fields: { [node.saveAs]: guardado },
    };
    if (isEmailAsk && looksLikeEmail) {
      enrich.email = val; // ya viene normalizado
    } else if (/^(nombre|name)$/.test(key)) {
      enrich.name = val;
    }
    await enrichContact(phone, enrich);
    r.node_id = node.next || "";
    r.status = "active";
    await run(flow, r);
    return true;
  }
  if (node.type === "buttons") {
    let pick = -1;
    const n = parseInt(text.trim(), 10);
    if (n >= 1 && n <= node.options.length) pick = n - 1;
    else {
      // TEXTO-EN-BOTONES-1 · se compara sin tildes ni signos: «si» es «Sí», «aun no» es
      // «Aún no». Primero la coincidencia exacta (así «a» elige «A» y no «Aún no»); luego
      // la parcial de siempre, pero nunca con un texto vacío (un audio o una foto no
      // pueden elegir la primera opción por casar con todo).
      const nb = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
      const t = nb(text);
      pick = t ? node.options.findIndex((o) => nb(o.label) === t) : -1;
      if (pick < 0 && t) pick = node.options.findIndex((o) => nb(o.label).includes(t));
    }
    // TEXTO-EN-BOTONES-1 · una DUDA real (pregunta, precio, pago…) no se contesta con «pulsa
    // un botón»: se etiqueta, se avisa a una persona y el paso sigue esperando la pulsación.
    // Va antes de CTA-ÚNICA para que «¿cuánto cuesta?» no cuente como pulsar la única opción.
    if (pick < 0 && flow.btnDoubtTag && esDudaReal(text)) {
      await enrichContact(phone, { tags: [flow.btnDoubtTag] });
      fev(flow.id, r.phone, "aviso", r.node_id, "escribió una duda en vez de pulsar — etiqueta " + flow.btnDoubtTag + " (texto: «" + text.slice(0, 60) + "»)");
      // NOTIFICACIONES-1 · una duda real en mitad de los botones: alguien tiene que contestarla.
      avisarContacto("pide_persona", r.phone, (nm) => ({ title: nm + " tiene una duda", body: "«" + text.replace(/\s+/g, " ").trim().slice(0, 140) + "» — en el flujo «" + flow.name + "», que sigue esperando que pulse un botón." }), { dedup: dedupVentana("duda:" + flow.id + ":" + r.phone, 30) });
      if (flow.btnDoubtNotifyPhones) {
        await notifyClosers(r.phone, { notifyPhones: flow.btnDoubtNotifyPhones, notifyTemplate: flow.btnDoubtTemplate, notifyLang: flow.fuNotifyLang }, r.vars);
      }
      await parkWaiting(flow, r);
      return true;
    }
    // CTA-ÚNICA · Un mensaje con UN solo botón es una llamada a la acción, no un menú: si la
    // persona responde con texto libre («hola si», «vale», «ok») en vez de pulsar, eso ES un
    // sí — se avanza por el botón. Solo se frena si la respuesta es claramente negativa o de
    // posponer («no», «luego», «aún no»…). Visto en producción: «hola si» a una CTA única
    // recibía el robótico «No te entendí. Elige una opción: 1. …» en bucle.
    // IG-SIN-NOENTENDI-1 · En Instagram solo se avanza pulsando y el bot nunca contesta a texto
    // libre (allí no puede sonar a bot): ni «No te entendí» ni CTA-ÚNICA. El mensaje ya está en
    // la Bandeja (flowLog de arriba), te llega un aviso, el paso sigue esperando con sus
    // botones vivos y las insistencias se pausan hasta que pulse o le contestes tú.
    if (pick < 0 && (ch === "ig" || r.vars.__ch === "ig")) {
      if (flow.btnDoubtTag && esDudaReal(text)) await enrichContact(phone, { tags: [flow.btnDoubtTag] });
      avisarContacto("pide_persona", r.phone, (nm) => ({ title: nm + " te ha escrito", body: "«" + text.replace(/\s+/g, " ").trim().slice(0, 140) + "» — en el flujo «" + flow.name + "». El bot no contesta: los botones siguen esperando." }), { channel: "instagram", dedup: dedupVentana("igtexto:" + flow.id + ":" + r.phone, 30) });
      fev(flow.id, r.phone, "aviso", r.node_id, "escribió en vez de pulsar — el bot calla, te avisa y pausa las insistencias (texto: «" + text.slice(0, 60) + "»)");
      r.vars.__fuPausa = "1";
      await parkWaiting(flow, r);
      return true;
    }
    if (pick < 0 && node.options.length === 1 && !/\b(no|nop|luego|despu[eé]s|m[aá]s tarde|ahora no|a[uú]n no|todav[ií]a no|espera|espero)\b/i.test(text)) {
      pick = 0;
    }
    if (pick < 0) {
      const opts = node.options.map((o, idx) => `${idx + 1}. ${o.label}`).join("\n");
      const retry = String(flow.btnRetryText || "").trim();
      await say(r, retry || `No te entendí. Elige una opción:\n${opts}`);
      // El lead ACABA de escribir: se reaparca para reiniciar el reloj de inactividad. Sin
      // esto, los reenganches y la derivación del seguimiento seguían llegando EN MEDIO de
      // una persona respondiendo (visto en producción: reenganche 2 y derivación a Carla
      // mientras el lead contestaba «hola si» / «si»).
      await parkWaiting(flow, r);
      return true;
    }
    const chosen = node.options[pick];
    delete r.vars.__fuPausa; // IG-SIN-NOENTENDI-1 · pulsó: vuelven las insistencias del paso siguiente
    // Cuestionario: si el bloque tiene saveAs, guarda la opción elegida en el contacto.
    if (node.saveAs) {
      r.vars[node.saveAs] = chosen.label;
      await enrichContact(phone, { fields: { [node.saveAs]: chosen.label } });
    }
    r.node_id = chosen.next || "";
    r.status = "active";
    await run(flow, r);
    return true;
  }
  if (node.type === "follow") {
    // FOLLOW-REAL-1 · Antes esto era decorativo: CUALQUIER respuesta (incluso "no")
    // pasaba la puerta. Ahora, en Instagram, se comprueba DE VERDAD con
    // is_user_follow_business. Reglas:
    //  - sigue (true)        → continúa.
    //  - NO sigue (false)    → se re-pide con el botón, máx. 2 veces; a la 3ª se
    //                          continúa igual (nunca dejamos a una persona atrapada).
    //  - no se sabe (null)   → beneficio de la duda: continúa (el fallo es nuestro).
    if (r.vars.__ch === "ig") {
      const follows = await fetchIgFollowStatus(r.phone);
      recordWebhook(
        "instagram",
        "🔒 «Ya te sigo» pulsado → Meta dice: " +
          (follows === true ? "SÍ te sigue → continúa" : follows === false ? "NO te sigue → se le vuelve a pedir" : "NO SE PUEDE SABER (sin dato) → continúa por si acaso"),
      );
      if (follows === false) {
        const tries = Number(r.vars.__followTries || 0) + 1;
        r.vars.__followTries = String(tries);
        // FOLLOW-BUCLE-1 · `requireFollow` (por defecto SÍ) = no se pasa de aquí hasta
        // que siga de verdad. Es lo que se espera de una puerta "sígueme para recibir
        // esto": si con pulsar el botón bastara, no sería una puerta.
        // Salvaguarda: esto SOLO se aplica cuando Meta confirma que NO sigue. Si no se
        // puede saber (follows === null), se continúa igual — nunca atrapamos a nadie
        // por un fallo NUESTRO de API.
        const strict = (node as { requireFollow?: boolean }).requireFollow !== false;
        if (strict || tries <= 2) {
          // El lead PULSÓ el botón (aunque aún no siga): se reaparca por parkWaiting para
          // reiniciar el reloj de inactividad — acaba de interactuar, no está inactivo.
          await parkWaiting(flow, r); // sigue esperando en el MISMO nodo
          // Se rota el texto: repetir el mismo mensaje una y otra vez es justo lo que
          // Instagram marca como spam.
          const PROMPTS = [
            "Mmm, aún no me aparece que me sigas 🙈 Dale a «Seguir» en mi perfil y pulsa el botón otra vez 👇",
            "Sigo sin verlo 😅 A veces Instagram tarda un poquito: comprueba que le diste a «Seguir» y vuelve a pulsar 👇",
            "Casi 🙌 Necesito que me sigas para poder enviártelo. Cuando lo tengas, pulsa abajo 👇",
            "Te espero 😊 En cuanto le des a «Seguir», pulsa el botón y te lo mando al momento 👇",
          ];
          const prompt = PROMPTS[(tries - 1) % PROMPTS.length];
          const label = ((node as { confirmLabel?: string }).confirmLabel || "Listo ✅").slice(0, 20);
          try {
            await sendIgQuickReplies({ recipientId: r.phone, text: prompt, replies: [label] });
            await flowLog(phone, "assistant", prompt, { btns: [{ t: label }] }); // PLANTILLA-BANDEJA-1
          } catch (e) {
            recordWebhook("instagram", "⚠️ no se pudo reenviar el botón de seguir: " + ((e as Error).message || "").slice(0, 60));
            try { await say(r, prompt); } catch { /* ya está registrado arriba */ }
          }
          return true;
        }
        // Modo NO estricto agotado: seguimos igual, pero queda constancia honesta.
        console.warn(`[flow] ${telLog(phone)}: no sigue la cuenta tras 3 intentos; el flujo continúa`);
      }
    }
    r.node_id = node.next || "";
    r.status = "active";
    await run(flow, r);
    return true;
  }
  // Estado raro: reanuda desde donde esté.
  r.status = "active";
  await run(flow, r);
  return true;
}

/**
 * SONDEO-IG-1 · Rescata los flujos de Instagram que se quedan congelados porque el
 * webhook de mensajería no nos llega.
 *
 * El síntoma que arregla: comentas, recibes el primer DM, pulsas «Ya te sigo ✅»... y
 * no pasa nada más. La causa es que Meta solo nos entrega los comentarios (campo
 * `feed`); los mensajes y los taps de botón exigen que la Página esté suscrita a
 * `messages`, y esa suscripción pide el permiso `pages_messaging`, que los tokens
 * actuales no tienen. Como ese permiso no depende de nosotros, en vez de esperar el
 * aviso PREGUNTAMOS: cada pocos segundos leemos las conversaciones de las cuentas que
 * tienen algún flujo en espera y reanudamos con lo que la persona haya contestado.
 *
 * Coste acotado: si no hay ningún flujo esperando, no se hace ni una llamada.
 * Anti-duplicado: se reclama el id del mensaje con la MISMA clave que usa el webhook
 * (`_ig_msg`), así que si algún día los webhooks vuelven a funcionar, el mensaje lo
 * procesa quien llegue primero y nunca los dos.
 */
/** Hasta qué momento hemos leído ya en cada cuenta de Instagram (ver la explicación en
 *  el cuerpo del tick). En memoria a propósito: si el proceso se reinicia, la primera
 *  vuelta vuelve a barrer 6 h, que es exactamente lo que queremos tras un despliegue. */
const igPollCursor = new Map<string, number>();
/** Evita que dos sondeos se pisen si uno tarda más que el intervalo: sin esto, una
 *  llamada lenta a Meta encadenaría ticks solapados y multiplicaría las peticiones. */
let igPollBusy = false;

async function igPollTick(): Promise<void> {
  // El interruptor se mira en DOS sitios a propósito: la variable de entorno es el
  // corte global de emergencia (funciona sin base de datos y para todos los
  // workspaces), y el ajuste se comprueba además dentro de cada workspace más abajo.
  if (process.env.IG_POLL === "off") return;
  if (igPollBusy) return;
  igPollBusy = true;
  try {
    await igPollRun();
  } finally {
    igPollBusy = false;
  }
}

async function igPollRun(): Promise<void> {
  let waiting: FlowRun[];
  try {
    waiting = await dbWaitingIgRuns();
  } catch (e) {
    console.error("[ig-poll] tick:", (e as Error).message);
    return;
  }
  if (!waiting.length) return; // nadie esperando → ni una llamada a Meta
  // Agrupado por workspace y, dentro, por cuenta de Instagram: una sola lectura de
  // conversaciones por cuenta, no una por persona en espera.
  const byTenant = new Map<string, FlowRun[]>();
  for (const r of waiting) {
    const t = (r as unknown as { tenant_id?: string }).tenant_id || "default";
    const arr = byTenant.get(t);
    if (arr) arr.push(r);
    else byTenant.set(t, [r]);
  }
  for (const [tenant, runs] of byTenant) {
    await runWithWorkspace(tenant, async () => {
      // Dentro del scope: así cada workspace puede apagar SU sondeo. Fuera, get()
      // leía siempre los ajustes de 'default' y el interruptor no servía de nada
      // para los demás.
      if (get("instagram.poll") === "off") return;
      // Por cuenta → por persona → DESDE CUÁNDO está esperando. Ese último dato es
      // imprescindible: sin él se reanudaría el flujo con un mensaje que la persona
      // escribió ANTES de llegar al botón (se vio en producción, con el paso del
      // «Ya te sigo» respondiéndose solo dos veces con texto viejo).
      const byAccount = new Map<string, Map<string, number>>();
      for (const r of runs) {
        const acc = r.vars.__igid || "";
        if (!acc) continue;
        // Si no supiéramos cuándo entró en espera, solo se acepta lo muy reciente:
        // preferimos no reanudar a reanudar con basura.
        const desde = (r as unknown as { waiting_since?: number }).waiting_since || Date.now() - 15 * 60_000;
        const m = byAccount.get(acc);
        if (m) m.set(r.phone, desde);
        else byAccount.set(acc, new Map([[r.phone, desde]]));
      }
      for (const [igId, phones] of byAccount) {
        const c = resolveAccount(igId);
        if (!c) continue;
        await runWithAccount(c, async () => {
          // VENTANA CON MEMORIA. Una ventana fija corta (p.ej. 15 min) tiene un agujero
          // grave: quien se quedó tirado ANTES —por ejemplo antes de que existiera este
          // sondeo— no se rescata nunca, porque su respuesta ya cayó fuera. Y una
          // ventana fija larga es carísima: pediría los mensajes de todas las
          // conversaciones movidas en horas, cada 8 segundos.
          //
          // Solución: recordar hasta dónde miramos por cuenta. La primera vuelta tras
          // arrancar el proceso barre la ventana completa (IG_WAIT_WINDOW_MS = 7 días, y
          // rescata a los atascados que respondieron dentro de ese plazo); a partir de ahí
          // solo mira lo nuevo, así que en reposo es UNA llamada por sondeo. Ese barrido de
          // 7 días es un coste de UNA vez por reinicio y por cuenta, no por tick.
          const prev = igPollCursor.get(igId);
          const desde = Math.max(prev ?? 0, Date.now() - IG_WAIT_WINDOW_MS);
          const leido = await fetchIgRecentInboundDiag(desde);
          if (!leido.ok) {
            // NO avanzar el cursor si la lectura falló: si lo hiciéramos, la ventana se
            // habría "consumido" sin haber leído nada y esas respuestas se perderían
            // para siempre. Fallando así, el siguiente sondeo reintenta el mismo tramo.
            console.error("[ig-poll] lectura de " + igId + " falló:", leido.error);
            return;
          }
          // Se avanza el cursor con un solapo de un minuto: si el reloj de Meta y el
          // nuestro no van exactos, es preferible releer un mensaje (dbClaimOnce lo
          // descarta) que perderlo para siempre.
          igPollCursor.set(igId, Date.now() - 60_000);
          for (const m of leido.items) {
            const esperandoDesde = phones.get(m.igsid);
            if (esperandoDesde === undefined) continue; // esa persona no tiene flujo en espera
            if (m.ts && m.ts <= esperandoDesde) continue; // mensaje ANTERIOR al botón: no es la respuesta
            try {
              // dbClaimOnce va DENTRO del try a propósito. Es una escritura en Postgres
              // y puede fallar (pool caído, timeout). Fuera del try, ese rechazo subía
              // hasta el setInterval, donde nadie lo captura, y Node mata el proceso
              // entero — llevándose por delante el bot de WhatsApp.
              if (m.mid && !(await dbClaimOnce("_ig_msg", m.mid))) continue; // ya lo trató el webhook
              recordWebhook("instagram", "🛰️ sondeo: respuesta de " + m.igsid.slice(-6) + " recuperada por API (el webhook no llegó)");
              await noteReplyToActiveRuns(m.igsid, m.text); // también enciende la ventana de un run en DELAY
              // IG-CLAVE-GANA-1 · si era la palabra clave de otro flujo, resumeFlow la suelta: se arranca aquí.
              if (!(await resumeFlow(m.igsid, m.text, "ig"))) await triggerIgDmFlows(m.igsid, m.text);
            } catch (e) {
              console.error("[ig-poll] resume:", (e as Error).message);
            }
          }
        });
      }
    });
  }
}

/** Scheduler: retoma flujos en espera por delay. */
let timer: ReturnType<typeof setInterval> | null = null;
let igTimer: ReturnType<typeof setInterval> | null = null;
let dripTimer: ReturnType<typeof setInterval> | null = null;
export function startFlowScheduler(): void {
  if (timer) return;
  timer = setInterval(flowTick, 30_000);
  timer.unref?.();
  // SEGUIMIENTO SI NO RESPONDE · cada 2 min avanza la cadencia de reenganche/derivación de
  // los runs en espera que llevan callados demasiado (solo flujos con el seguimiento activo).
  { const fu = setInterval(() => { void followupTick(); }, 2 * 60_000); fu.unref?.(); }
  // Más frecuente que flowTick: aquí hay una persona esperando delante del móvil a que
  // el bot le conteste. 30 s de silencio tras pulsar un botón se sienten como "roto".
  if (!igTimer) {
    igTimer = setInterval(() => { void igPollTick(); }, 8_000);
    igTimer.unref?.();
  }
  // GOTEO de respuestas a comentarios: el tick comprueba cada 20 s, pero solo responde
  // si ha pasado el intervalo configurado (para ir MUY despacio y no despertar el
  // anti-spam de Meta). Ver commentDripTick.
  if (!dripTimer) {
    dripTimer = setInterval(() => { void commentDripTick(); }, 20_000);
    dripTimer.unref?.();
  }
}

/**
 * GOTEO-1 · Responde a los comentarios encolados, UNO cada `ig.drip.intervalSec`.
 *
 * Anti-baneo: nunca responde dos veces seguidas sin dejar pasar el intervalo (config,
 * p.ej. 600 s = 1 cada 10 min), rota el texto para no repetir, NO mete enlaces (la
 * cuenta tiene el bloqueo de enlaces + un enlace en comentario es señal de spam), y si
 * Meta devuelve CUALQUIER error PARA EL GOTEO ENTERO (ig.drip.enabled=off) y lo deja
 * anotado — mejor frenar y avisar que insistir y que te restrinjan.
 */
let dripBusy = false;

/** Re-escanea el post y encola a los que aún no estaban. Dedupe por PERSONA (una
 *  respuesta por autor) y excluye la propia cuenta + los excluidos. Devuelve cuántos
 *  nuevos encoló. */
async function dripRefill(igId: string, mediaId: string, excludeCsv: string): Promise<number> {
  if (!igId || !mediaId) return 0;
  const acct = resolveAccount(igId);
  if (!acct) return 0;
  const excl = new Set(
    (excludeCsv || "").split(",").map((u) => deaccent(u.replace(/^@/, "").trim())).filter(Boolean),
  );
  return runWithAccount(acct, async () => {
    let self = "";
    try { self = deaccent((await fetchAllCommentsSelf(igId)) || ""); } catch { /* seguimos */ }
    const r = await fetchAllComments({ mediaId, includeReplies: true });
    const yaEnCola = await dbDripAuthors(); // autores que ya están en la cola (cualquier estado)
    const vistos = new Set<string>();
    const rows: { comment_id: string; media_id: string; ig_id: string; author: string }[] = [];
    for (const c of r.comments) {
      const a = deaccent(c.username || "");
      if (!a || a === self || excl.has(a) || yaEnCola.has(a) || vistos.has(a)) continue;
      vistos.add(a);
      rows.push({ comment_id: c.commentId, media_id: mediaId, ig_id: igId, author: c.username });
    }
    return dbDripEnqueue(rows);
  });
}

async function commentDripTick(): Promise<void> {
  if (get("instagram.drip.enabled") !== "on") return;
  if (dripBusy) return;
  dripBusy = true;
  try {
    await runWithWorkspace(get("instagram.drip.tenant") || "default", async () => {
      // ── RE-ESCANEO (refill) ────────────────────────────────────────────────
      // La API de Instagram da un PUÑADO ALEATORIO de comentarios cada llamada, nunca
      // la lista completa de un post grande. Solución: re-escanear cada pocos minutos y
      // encolar a los NUEVOS que aparezcan. Con los días, la unión de todos esos puñados
      // cubre a casi todos. dbDripEnqueue dedupe por comentario y aquí dedupe por
      // PERSONA (dbDripAuthors), así que nunca se responde dos veces a la misma.
      const refillMin = Math.max(2, Number(get("instagram.drip.refillMin")) || 10);
      const lastRefill = Number(get("instagram.drip.lastRefillAt")) || 0;
      if (Date.now() - lastRefill >= refillMin * 60_000) {
        set("instagram.drip.lastRefillAt", String(Date.now())); // marca ANTES (el scan tarda)
        try {
          const nuevos = await dripRefill(get("instagram.drip.igId"), get("instagram.drip.mediaId"), get("instagram.drip.exclude"));
          if (nuevos > 0) {
            set("instagram.drip.emptyRefills", "0");
            recordWebhook("instagram", "🔄 re-escaneo: " + nuevos + " personas NUEVAS encoladas");
          } else {
            const e = (Number(get("instagram.drip.emptyRefills")) || 0) + 1;
            set("instagram.drip.emptyRefills", String(e));
          }
        } catch (e) { console.error("[drip] refill:", (e as Error).message); }
      }

      const intervalSec = Math.max(60, Number(get("instagram.drip.intervalSec")) || 600);
      const lastAt = Number(get("instagram.drip.lastAt")) || 0;
      if (Date.now() - lastAt < intervalSec * 1000) return; // aún no toca responder

      const next = await dbDripNext();
      if (!next) {
        // Cola vacía. NO se apaga sin más: puede que el próximo re-escaneo traiga gente.
        // Solo se da por TERMINADO cuando llevamos muchos re-escaneos seguidos SIN
        // encontrar a nadie nuevo (la API ya no da más → hemos alcanzado a casi todos).
        const empty = Number(get("instagram.drip.emptyRefills")) || 0;
        const corte = Math.max(6, Number(get("instagram.drip.stopAfterEmpty")) || 30);
        if (empty >= corte) {
          set("instagram.drip.enabled", "off");
          const c = await dbDripCounts();
          recordWebhook("instagram", "🏁 goteo TERMINADO: " + c.done + " respondidos y ya no aparece gente nueva tras " + empty + " re-escaneos");
        }
        return;
      }
      // EXCLUIDOS también AQUÍ (no solo al encolar): si alguien entró en la cola antes
      // de configurar la exclusión (o por un prepare sin lista), no se le responde igual.
      const excl = new Set(
        (get("instagram.drip.exclude") || "").split(",").map((u) => deaccent(u.replace(/^@/, "").trim())).filter(Boolean),
      );
      if (excl.has(deaccent(next.author || ""))) {
        await dbDripMark(next.comment_id, "skipped", "excluido");
        recordWebhook("instagram", "🚫 goteo: @" + next.author + " está excluido → se salta (no se le responde)");
        return; // el siguiente tick coge al siguiente
      }
      const acct = resolveAccount(next.ig_id);
      if (!acct) { await dbDripMark(next.comment_id, "skipped", "cuenta IG no resuelta"); return; }

      // rota entre las variantes; NUNCA enlaces
      let variants: string[] = [];
      try { variants = JSON.parse(get("instagram.drip.variants") || "[]"); } catch { /* vacío */ }
      variants = variants.map((t) => String(t || "").trim()).filter(Boolean);
      if (!variants.length) { set("instagram.drip.enabled", "off"); recordWebhook("instagram", "⚠️ goteo detenido: no hay textos configurados"); return; }
      // el índice rota con el nº de enviados (determinista, sin Math.random)
      const idx = (await dbDripCounts()).done % variants.length;
      const texto = variants[idx];

      set("instagram.drip.lastAt", String(Date.now())); // marca ANTES de enviar: si el envío tarda, el siguiente tick no se solapa
      try {
        await runWithAccount(acct, async () => { await replyToComment(next.comment_id, texto); });
        await dbDripMark(next.comment_id, "done");
        const c = await dbDripCounts();
        recordWebhook("instagram", "💧 goteo: respondido a @" + next.author + " (" + c.done + "/" + c.total + ")");
      } catch (e) {
        const msg = (e as Error).message || "error";
        await dbDripMark(next.comment_id, "error", msg);
        // FRENO INTELIGENTE. Solo se PARA el goteo entero ante señales de LÍMITE/BLOQUEO
        // reales de Meta (spam, rate limit, permiso, restricción). Un error TRANSITORIO
        // (500, "reduce the amount of data", red, code 1/2) es un hipo puntual de un
        // comentario: se salta ESE y se sigue — parar todo por eso desperdicia la
        // campaña (pasó: se detuvo tras 266 envíos por un único 500).
        const grave = /spam|rate.?limit|too many|reduce the number of|restrict|blocked|bloque|community standard|not authoriz|permission|no permitido|#4\b|#10\b|#17\b|#613|368\b/i.test(msg);
        if (grave) {
          set("instagram.drip.enabled", "off");
          recordWebhook("instagram", "🛑 GOTEO DETENIDO (posible límite/bloqueo de Meta) al responder a @" + next.author + ": " + msg.slice(0, 90));
        } else {
          recordWebhook("instagram", "⚠️ goteo: error TRANSITORIO con @" + next.author + " (" + msg.slice(0, 45) + ") → se salta y sigue");
        }
      }
    });
  } catch (e) {
    console.error("[drip] tick:", (e as Error).message);
  } finally {
    dripBusy = false;
  }
}
// ESPERA-SEG-1 · barrido extra a la hora exacta de una espera corta. Uno solo pendiente a la
// vez (si ya hay uno programado antes, con ese basta); nunca sustituye al barrido de 30 s.
let _tickSoon: ReturnType<typeof setTimeout> | null = null;
export function flowTickSoon(ms: number): void {
  if (_tickSoon) return;
  _tickSoon = setTimeout(() => { _tickSoon = null; void flowTick(); }, Math.max(250, ms));
}
async function flowTick(): Promise<void> {
  let due: FlowRun[];
  try {
    due = await dbDueFlowRuns();
  } catch (e) {
    console.error("[flow] tick:", (e as Error).message);
    return;
  }
  // Multi-tenant W8: cada run corre bajo su tenant_id (fallback 'default').
  // El listado de flujos va DENTRO del scope del workspace: listFlows() filtra por
  // currentWorkspaceId(), así que llamarlo fuera devolvía siempre los de 'default' y
  // los runs de cualquier otro workspace no encontraban su flujo → se cerraban en
  // silencio (los nodos de espera y las secuencias no llegaban a reanudarse nunca).
  // Agrupamos por workspace para listar una sola vez por tenant, no una por run.
  const byTenant = new Map<string, FlowRun[]>();
  for (const r of due) {
    const t = (r as any).tenant_id || "default";
    const arr = byTenant.get(t);
    if (arr) arr.push(r);
    else byTenant.set(t, [r]);
  }
  for (const [tenant, runs] of byTenant) {
    await runWithWorkspace(tenant, async () => {
      const flows = await listFlows();
      // Cada run se procesa aislado: un fallo (o un cierre) no puede abortar el resto
      // de runs de este workspace. Por eso el cuerpo va en su propia función.
      const step = async (r: FlowRun): Promise<void> => {
        const flow = flows.find((f) => f.id === r.flow_id);
        if (!flow) return finish(r);
        const node = flow.nodes[r.node_id];
        if (!node) return finish(r);
        // CARRERA-TICK-1 · Antes: todo nodo no-delay se remataba con finish() →
        // 'done' + evento «completó» SIN interacción (así murió el SEEDANCE de
        // @valentinpardo a los 3 s de entrar). Un run 'active' vencido en un nodo
        // que NO es delay solo puede ser un arranque interrumpido (crash/redeploy
        // a mitad del primer envío, ya fuera de la gracia RUN_GRACE_MS): un nodo
        // INTERACTIVO se RESCATA re-aparcándolo en espera (idempotente, no envía
        // nada; el tap del usuario vuelve a funcionar); cualquier otro se cierra
        // EXPLÍCITAMENTE como cancelado con su evento — jamás como «Completada».
        if (node.type !== "delay") {
          if (node.type === "buttons" || node.type === "ask" || node.type === "follow") {
            await parkWaiting(flow, r);
            fev(flow.id, r.phone, "aviso", r.node_id, "el barrido encontró el run 'active' en un nodo interactivo → re-aparcado en espera (rescate)");
            return;
          }
          r.status = "cancelled";
          await dbSaveFlowRunIfLive(r);
          fev(flow.id, r.phone, "cancelado", r.node_id, "run interrumpido a medias en un nodo no interactivo (fuera de gracia) → cierre explícito");
          return;
        }
        const c = await getContact(r.phone);
        // YouTube no tiene ventana de 24 h (se responde en publico al comentario), asi
        // que exigirla mataba SIEMPRE los pasos «Espera» de un flujo de YouTube.
        if (r.vars.__ch !== "yt" && r.vars.__ch !== "li" && (!c || !inWindow(c))) return finish(r); // fuera de 24h: no se puede continuar gratis
        if (!node.next) return finish(r);
        // El interruptor de respuestas automáticas NO se comprueba aquí a propósito. Un
        // flujo es una automatización que el dueño montó y activó; el interruptor solo
        // calla a la IA de charla libre, nunca desactiva un flujo (ver INCIDENTE 2026-07-14
        // en index.ts: apagar el canal mató el flujo del LIVE de Carla). Un nodo "espera"
        // es la CONTINUACIÓN de un flujo que ya arrancó; tiene que completarse igual que
        // sus mensajes iniciales. Si antes se aparcaba con el canal apagado, el mensaje
        // posterior al delay no llegaba nunca — que es justo lo que fallaba.
        // REVISION-ESPERA-1 · Resolver ANTES de avanzar el nodo. El mismo
        // contrato de los seguimientos protege las demoras: si desapareció el
        // emisor explícito, se conserva la espera para cuando vuelva a conectarse.
        const channel = flowChannel(r);
        if (!channel) {
          r.next_run = Date.now() + 30 * 60_000;
          await dbSaveFlowRunIfLive(r);
          fev(flow.id, r.phone, "reanudación aplazada", r.node_id, "el número/cuenta de origen no está disponible ahora");
          return;
        }
        r.node_id = node.next;
        r.status = "active";
        // Reanudar DESDE EL MISMO número/cuenta que arrancó el flujo. flowTick corre fuera
        // del ámbito del webhook, así que sin esto el envío saldría del número PRINCIPAL y
        // Meta lo rechazaría (el cliente escribió a otro número → sin ventana 24h allí).
        await channel(() => run(flow, r));
      };
      for (const r of runs) {
        try {
          await step(r);
        } catch (e) {
          console.error("[flow] step:", (e as Error).message);
          // CARRERA-TICK-2 (consejo final 2026-08-15): esto hacía finish() → un fallo
          // TRANSITORIO del envío tras una espera (timeout, rechazo puntual de Meta)
          // marcaba el flujo «Completada» sin entregar nada — la misma clase de falso
          // completado del incidente SEEDANCE, por la vía de la excepción. Ahora:
          // hasta 3 reintentos con 5 min de margen; si persiste, cierre EXPLÍCITO
          // como cancelado con su evento (nunca «completó»).
          try {
            const tries = Number(r.vars.__tickErr || 0) + 1;
            r.vars.__tickErr = String(tries);
            if (tries <= 3) {
              r.status = "active";
              r.next_run = Date.now() + 5 * 60_000;
              await dbSaveFlowRunIfLive(r);
            } else {
              r.status = "cancelled";
              await dbSaveFlowRunIfLive(r);
              fev(r.flow_id, r.phone, "cancelado", r.node_id, "3 fallos seguidos reanudando tras una espera (" + String((e as Error)?.message || e).slice(0, 80) + ") → cierre explícito");
            }
          } catch { /* el guardado de emergencia nunca tumba el tick */ }
        }
      }
    });
  }
}

// ============================================================
// SEGUIMIENTO SI NO RESPONDE (timeout de inactividad) · avanza la cadencia de reenganche
// de los runs en espera que llevan callados demasiado: reenganche 1 → reenganche 2 →
// derivar a Carla. Reutiliza next_run como reloj (parkWaiting lo armó). Corre cada 2 min.
// ============================================================
const fuMsg1Def = async () => "¿Sigues por aquí? Me quedo listo para lo que necesites; si prefieres, te paso con " + (await equipoDeDerivacion()) + " directamente.";
const fuMsg2Def = async () => "Te escribo una última vez por si se te pasó — no quiero que te quedes sin tu sitio. ¿Lo retomamos o te paso ya con " + (await equipoDeDerivacion()) + "?";
/** Devuelve un wrapper que ejecuta fn con el número WA / cuenta IG por el que arrancó el flujo,
 *  o `null` si el flujo declaró un canal de origen que YA NO resuelve (número quitado, cuenta
 *  desconectada). Distinguir los dos casos es clave: sin var de canal → principal (legítimo,
 *  como flowTick); con var pero irresoluble → NO caer al principal (el lead escribió a OTRO
 *  número; sin ventana de 24 h allí Meta lo rechazaría y avanzaríamos la cadencia en falso). */
type ChannelRunner = <T>(fn: () => Promise<T>) => Promise<T>;
function flowChannel(r: FlowRun): ChannelRunner | null {
  if (r.vars.__ch === "ig" && r.vars.__igid) {
    const acc = resolveAccount(r.vars.__igid);
    return acc ? (<T>(fn: () => Promise<T>) => runWithAccount(acc, fn)) : null;
  }
  if (r.vars.__pnid) {
    const n = resolveWaNumber(r.vars.__pnid);
    return n ? (<T>(fn: () => Promise<T>) => runWithWaNumber({ token: n.token, phoneId: n.phoneNumberId }, fn)) : null;
  }
  return <T>(fn: () => Promise<T>) => fn();
}
function fuPhones(raw?: string): string[] {
  return String(raw || "").split(",").map((p) => p.trim().replace(/[^\d+]/g, "")).filter(Boolean);
}

/** MET-AUTO-07-FIN · Último mensaje SALIENTE de la conversación (flujo, bot o persona): cuándo
 *  salió y, si WhatsApp mandó acuse, su estado. null si no hay conversación o no se puede leer. */
async function ultimoEnvio(phone: string): Promise<{ at: number; estado?: string; entregadoAt?: number } | null> {
  try {
    const turns = (await getSession(phone))?.turns || [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role !== "assistant" || !t.at) continue;
      const out: { at: number; estado?: string; entregadoAt?: number } = { at: Number(t.at) };
      const ids = [t.mid, ...(t.midsAlt || [])].filter(Boolean) as string[];
      if (ids.length) {
        const st = await dbWaMessageStatuses(ids).catch(() => ({} as Record<string, { status: string; status_at: number }>));
        const filas = Object.values(st);
        const ok = filas.find((f) => f.status === "delivered" || f.status === "read");
        if (ok) { out.estado = ok.status; out.entregadoAt = Number(ok.status_at) || 0; }
        else if (filas.length) out.estado = filas[0].status;
      }
      return out;
    }
  } catch { /* sin conversación legible: el reloj sigue como estaba */ }
  return null;
}

// Avanza la cadencia de UN run en espera que lleva callado demasiado. Blindado contra:
//  · carrera con la respuesta del lead (CAS por nodo+__fu, no un save ciego),
//  · varios flujos del mismo contacto (re-lectura acotada al flujo, no «el más reciente»),
//  · ticks/réplicas duplicados (el CAS lo gana uno solo),
//  · comprador/cliente aparcado (re-check de stopTag antes de enviar),
//  · número de origen caído (aplaza, no deriva en falso),
//  · re-derivación por reinicio (cierra el run ANTES de avisar).
async function followupStep(flow: Flow, r: FlowRun): Promise<void> {
  const test = r.vars.__test === "1";
  const mins = (v: unknown, def: number) => (test ? 1 : Math.max(1, Number(v) || def));

  // 1) RE-LECTURA anti-carrera ACOTADA A ESTE FLUJO (no «el waiting más reciente del teléfono»,
  //    que dejaría huérfano al flujo más antiguo cuando el contacto está en varios a la vez).
  //    Si el contacto respondió (resumeFlow movió el nodo) o el run se canceló → no lo tocamos.
  const cur = await dbWaitingFlowRunFor(r.phone, r.flow_id);
  if (!cur || cur.node_id !== r.node_id) return;
  r = cur;
  // MET-AUTO-07-FIN · reservó cita mientras esperaba: ningún aviso más (ni derivación: «R» no es
  // un número y caería en la rama de derivar). Si algo lo rearmó, se vuelve a aparcar.
  if (r.vars.__fu === "R") { await dbDeferWaiting(r.phone, r.flow_id, r.node_id, FU_FAR); return; }
  const fu = Number(r.vars.__fu || 0);
  const fuMark = String(r.vars.__fu || ""); // marcador exacto para el compare-and-set

  // FU-CANCEL-2 · cinturón: si el contacto escribió después de armarse esta
  // ventana (carrera con el tick, o rutas de entrada que no pasan por
  // noteReplyToActiveRuns), el reenganche NO se envía — el reloj se reinicia
  // para contar desde su último mensaje. Antes __replied/__lastAt quedaban
  // escritos en vars y NADIE los miraba antes de enviar.
  const lastAt = Number(r.vars.__lastAt || 0);
  if (lastAt) {
    const due = applyQuiet(flow, r, lastAt + mins(flow.fuT1, 90) * 60_000);
    if (due > Date.now()) {
      const nv = { ...r.vars };
      delete nv.__fu;
      await dbAdvanceWaitingIfUnchanged(r.phone, r.flow_id, r.node_id, fuMark, { vars: nv, status: "waiting", nextRun: due });
      fev(flow.id, r.phone, "reenganche pospuesto", r.node_id, "el contacto escribió — el reloj cuenta desde su último mensaje");
      return;
    }
  }
  // MET-AUTO-07-FIN · el primer aviso cuenta desde lo ÚLTIMO que le llegó, no desde que el
  // flujo se puso a esperar. Si el resultado (diagnóstico, vídeo…) salió DESPUÉS por otro
  // camino —otro flujo, el bot, una persona—, preguntar «¿viste el vídeo?» a los pocos
  // minutos de mandarlo es prematuro. Y si WhatsApp aún no confirmó la entrega de ese último
  // envío, se espera a que llegue (con tope de 2 h: sin acuse no se bloquea para siempre).
  if (fu < 1) {
    const out = await ultimoEnvio(r.phone);
    if (out) {
      const since = Number(r.vars.__since || 0);
      const pendienteEntrega = out.estado === "accepted" || out.estado === "sent";
      let due = 0;
      let motivo = "";
      if (pendienteEntrega && Date.now() - out.at < 2 * 3600_000) {
        due = Date.now() + mins(5, 5) * 60_000;
        motivo = "el último mensaje aún no consta como entregado — el aviso espera a que llegue";
      } else if (out.at > since) {
        due = applyQuiet(flow, r, Math.max(out.at, out.entregadoAt || 0) + mins(flow.fuT1, 90) * 60_000);
        motivo = "se le envió algo después de quedar esperando — el reloj cuenta desde ese envío";
      }
      if (due > Date.now()) {
        const moved = await dbAdvanceWaitingIfUnchanged(r.phone, r.flow_id, r.node_id, fuMark, { vars: r.vars, status: "waiting", nextRun: due });
        if (moved) fev(flow.id, r.phone, "reenganche pospuesto", r.node_id, motivo);
        return;
      }
    }
  }

  // 2) REGLA DE PARADA también aquí: el seguimiento avanza el run SIN pasar por run(), así que
  //    su guard de stopTag no se re-evalúa. Sin esto, un comprador/cliente aparcado recibiría
  //    reenganches y acabaría derivado a Carla. Cubre la etiqueta local (compra reconciliada o
  //    puesta a mano por un closer en el panel).
  if (flow.stopTag && flow.stopTag.trim()) {
    try {
      const c = await getContact(r.phone);
      const stop = flow.stopTag.trim().toLowerCase();
      if ((c?.tags || []).some((t) => String(t || "").trim().toLowerCase() === stop)) {
        await dbCancelFlowRunsForPhone(r.phone, flow.id);
        fev(flow.id, r.phone, "salió · compró", r.node_id, "regla de compra («" + flow.stopTag.trim() + "»): no se le reengancha");
        return;
      }
    } catch { /* si no se puede leer el contacto, seguimos con cautela */ }
  }

  // 3) CANAL DE ORIGEN. Si el flujo declaró número/cuenta y ya no resuelve, aplazar (no avanzar
  //    la cadencia ni derivar en falso) y reintentar en 30 min por si el número vuelve.
  const chan = flowChannel(r);
  if (!chan) {
    await dbDeferWaiting(r.phone, r.flow_id, r.node_id, Date.now() + 30 * 60_000);
    fev(flow.id, r.phone, "reenganche aplazado", r.node_id, "el número/cuenta de origen no está disponible ahora");
    return;
  }

  if (fu < 2) {
    // Reenganche 1 (fu 0→1, arma reloj del reenganche 2) o Reenganche 2 (fu 1→2, arma derivación).
    const isFirst = fu < 1;
    const nextFu = isFirst ? "1" : "2";
    const armMin = isFirst ? mins(flow.fuT2, 1320) : mins(flow.fuT3, 1440);
    // CAS PRIMERO: lo gana un solo tick/réplica y bloquea el avance si el lead respondió. Solo
    // tras ganarlo enviamos, para no mandar el reenganche por duplicado. La franja horaria
    // aplica también aquí: el siguiente aviso jamás se arma de madrugada.
    const won = await dbAdvanceWaitingIfUnchanged(r.phone, r.flow_id, r.node_id, fuMark, { vars: { ...r.vars, __fu: nextFu }, status: "waiting", nextRun: applyQuiet(flow, r, Date.now() + armMin * 60_000) });
    if (!won) return; // el lead respondió / otro tick se adelantó
    // MARCA-DERIVACION-1 · el texto de fábrica se compone DESPUÉS de ganar el CAS: lleva el
    // nombre del negocio y leerlo no tiene sentido en el tick que pierde la carrera.
    const msg = isFirst ? (flow.fuMsg1 || await fuMsg1Def()) : (flow.fuMsg2 || await fuMsg2Def());
    await chan(() => say(r, msg));
    fev(flow.id, r.phone, isFirst ? "reenganche 1" : "reenganche 2", r.node_id, isFirst ? "sin respuesta → primer aviso" : "sigue sin responder → segundo aviso");
  } else if ((flow.fuMode || "derivar") === "mensaje") {
    // REPESCA-3-1 · Tercer toque SIN derivar: sale fuFinalMsg como tercer aviso y el run queda
    // APARCADO (status 'waiting' + next_run «nunca»): no habrá más avisos, pero si el lead
    // contesta más tarde resumeFlow retoma el flujo desde este mismo nodo. Ni etiqueta ni
    // aviso a Carla: eso es de la derivación. CAS primero, igual que abajo.
    const parked = await dbAdvanceWaitingIfUnchanged(r.phone, r.flow_id, r.node_id, fuMark, { vars: { ...r.vars, __fu: "3" }, status: "waiting", nextRun: FU_FAR });
    if (!parked) return; // el lead respondió / otro tick se adelantó
    const msg3 = (flow.fuFinalMsg || "").trim();
    if (msg3) await chan(() => say(r, msg3));
    fev(flow.id, r.phone, "reenganche 3", r.node_id, msg3 ? "tercer aviso enviado → el flujo queda esperando su respuesta (sin derivar)" : "sin mensaje configurado → el flujo queda esperando su respuesta (sin derivar)");
  } else {
    // Derivar a Carla. CERRAR EL RUN ATÓMICAMENTE PRIMERO (status='done'): así un reinicio o un
    // segundo tick no puede re-derivar (Carla no recibe el aviso repetido). Los efectos externos
    // (etiqueta, mensaje final, aviso) van después, best-effort.
    const closed = await dbAdvanceWaitingIfUnchanged(r.phone, r.flow_id, r.node_id, fuMark, { vars: { ...r.vars, __fu: "3" }, status: "done", nextRun: FU_FAR });
    if (!closed) return; // el lead respondió / ya se derivó en otro tick
    // NOTIFICACIONES-1 · pide_persona (el run ya está cerrado: el CAS de arriba evita repetirlo)
    avisarContacto("pide_persona", r.phone, (nm) => ({ title: nm + " no contesta: pasa a tu equipo", body: "No respondió a los recordatorios del flujo «" + flow.name + "»." }), { dedup: "inact:" + flow.id + ":" + r.phone + ":" + String(fuMark) });
    const tag = (flow.fuCarlaTag || "derivado-inactividad").trim();
    if (tag) { try { await enrichContact(r.phone, { tags: [tag] }); } catch { /* best-effort */ } }
    const phones = fuPhones(flow.fuNotifyPhones);
    await chan(async () => {
      if (flow.fuFinalMsg && flow.fuFinalMsg.trim()) { try { await say(r, flow.fuFinalMsg.trim()); } catch { /* noop */ } }
      if (phones.length) { try { await notifyClosers(r.phone, { notifyPhones: flow.fuNotifyPhones, notifyTemplate: flow.fuNotifyTemplate, notifyLang: flow.fuNotifyLang }); } catch (e) { console.warn("[followup] notify:", (e as Error).message); } }
    });
    if (phones.length) {
      fev(flow.id, r.phone, "derivado · inactividad", r.node_id, "no respondió a los avisos → a Carla (" + tag + ")");
    } else {
      // Sin número de Carla configurado: NO fingir éxito silencioso; dejar traza visible.
      fev(flow.id, r.phone, "derivado · SIN aviso", r.node_id, "no hay número de Carla configurado → nadie fue avisado");
      try { await logActivity({ source: "wa-send", level: "error", summary: "Derivación por inactividad SIN aviso en «" + flow.name + "»: no hay número de Carla configurado", payload: { file: "flows.ts", fn: "followupStep", flow: flow.id, phone: r.phone } }); } catch { /* noop */ }
    }
  }
}

// MET-AUTO-07-FIN · exportada para el arnés scripts/test-met-auto-07.mjs (lo arranca el scheduler cada 2 min).
export async function followupTick(): Promise<void> {
  let due: FlowRun[];
  try { due = await dbDueWaitingFlowRuns(); } catch (e) { console.error("[followup] tick:", (e as Error).message); return; }
  if (!due.length) return;
  const byTenant = new Map<string, FlowRun[]>();
  for (const r of due) { const t = (r as unknown as { tenant_id?: string }).tenant_id || "default"; (byTenant.get(t) || byTenant.set(t, []).get(t)!).push(r); }
  for (const [tenant, runs] of byTenant) {
    await runWithWorkspace(tenant, async () => {
      const flows = await listFlows();
      for (const r of runs) {
        try {
          const flow = flows.find((f) => f.id === r.flow_id);
          // Flujo borrado, o waiting de un flujo SIN seguimiento → desármalo (next_run="nunca")
          // para que no vuelva a salir. dbDeferWaiting es node-scoped: no pisa una respuesta que
          // el lead acabe de dar (a diferencia de un save ciego).
          if (!flow || !flow.fuEnabled) { await dbDeferWaiting(r.phone, r.flow_id, r.node_id, FU_FAR); continue; }
          await followupStep(flow, r);
        } catch (e) { console.error("[followup] step:", (e as Error).message); }
      }
    });
  }
}
