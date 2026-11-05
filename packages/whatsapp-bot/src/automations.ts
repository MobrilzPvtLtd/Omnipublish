/**
 * Motor de automatizaciones estilo ManyChat.
 *
 * Disparador: alguien comenta un post/reel.
 * Acciones (en orden, las vacías se saltan):
 *   1. Responder públicamente al comentario.
 *   2. Abrir DM con quien comentó: mensaje + enlace (texto o botón).
 *   3. (Opcional) Generar la respuesta/DM con IA a partir de un prompt.
 * Filtros: por media concreto o "any", por palabra clave, y "una vez por
 * usuario" (dedupe en BD).
 *
 * Redes con ruta funcional (todas por API oficial):
 *   - Instagram: respuesta pública + DM (private reply).
 *   - Facebook: respuesta pública + mensaje privado de la Página (mismo par de
 *     acciones que Instagram; ver la rama `platform === "facebook"` más abajo).
 *   - YouTube y LinkedIn: SOLO respuesta pública (ninguna de las dos tiene API de
 *     mensajes directos a quien comenta), con el enlace del CTA dentro del texto.
 *
 * mediaId: en Facebook es el id "{pageId}_{postId}" que devuelve
 * /{pageId}/published_posts — el MISMO que guarda el picker del panel y el que
 * entrega el webhook en val.post_id (index.ts lo normaliza a ese formato antes de
 * llamar aquí, porque matches() compara por igualdad estricta).
 */
import {
  dbListAutomations,
  dbUpsertAutomation,
  dbDeleteAutomation,
  dbClaimOnce,
  dbWasClaimed,
} from "./db.js";
import { replyToComment, sendDmFromComment } from "./instagram.js";
import { fbReplyToComment, fbSendDmFromComment, listFbAccounts, listFbPosts, listFbComments } from "./facebook.js";
import { youtubeReplyToComment } from "./youtube.js";
import { replyToLinkedInComment } from "./linkedinCommunity.js";
import { utmTagUrls } from "./links.js";
import { quickReply } from "./brain.js";
import { triggerIgFlows, deaccent, triggerFbFlows, listFlows, matchesKeyword, flowAppliesTo, flowLog } from "./flows.js";
import { recordWebhook } from "./webhookDebug.js";
import { get } from "./settings.js";
import { labelAiGeneratedContent, REGLA_IDENTIDAD_IA, REGLA_NO_INVENTAR, KB_VACIA } from "./ai-compliance.js";

export type CommentPlatform = "instagram" | "facebook" | "youtube" | "linkedin";

/**
 * Construye el system prompt para respuestas IA de Instagram: misma base de
 * conocimiento y marca que el bot de WhatsApp, pero con restricciones para
 * un comentario PÚBLICO (corto, sin enlaces inventados, en español).
 *
 * En YouTube la respuesta pública es el ÚNICO canal: no existe API de mensajes
 * directos (los DM que YouTube relanzó en 2026 son solo de la app móvil), así
 * que la IA no puede prometer "te escribo por privado" — el CTA va en la propia
 * respuesta. Además pedimos variedad: la política de spam de YouTube penaliza
 * los comentarios "de alto volumen, repetitivos o plantillados".
 */
export function igAiSystem(extra: string, platform: CommentPlatform = "instagram"): string {
  const kb = get("knowledge.negocio") || KB_VACIA; // BARRERA-INVENTA-1
  const brand = get("brand") || "";
  const red = platform === "facebook" ? "Facebook" : platform === "youtube" ? "YouTube" : platform === "linkedin" ? "LinkedIn" : "Instagram";
  // Ni YouTube ni LinkedIn permiten DM de la cuenta/Página a quien comenta: la
  // respuesta pública es el único canal (y ambas plataformas penalizan lo plantillado).
  const noDm = platform === "youtube" || platform === "linkedin";
  const noDmLine =
    platform === "youtube"
      ? "En YouTube NO hay mensajes privados: nunca digas que le escribes por privado ni que mire el DM. Responde a lo que pregunta y, si procede, remite a la descripción del vídeo o al comentario fijado."
      : platform === "linkedin"
      ? "Respondes como la Página de empresa y NO hay mensajes privados a quien comenta en LinkedIn: contesta a lo que pregunta y, si procede, invita a visitar la Página o el enlace del post. Tono profesional B2B."
      : "Si procede, invita a escribir por mensaje directo o WhatsApp para más detalle.";
  return [
    `Eres el asistente de la marca respondiendo PÚBLICAMENTE a un comentario en ${red}.`,
    "Reglas: responde en español, máximo 2 frases, cercano y útil, 1-2 emojis máximo.",
    REGLA_NO_INVENTAR, // BARRERA-INVENTA-1
    noDmLine,
    noDm
      ? "Responde SIEMPRE de forma distinta y específica a ESTE comentario (menciona algo concreto de lo que dice). Las respuestas repetidas o plantilladas se consideran spam."
      : "",
    "No uses markdown ni listas. Nada de #hashtags salvo que el usuario los pida.",
    REGLA_IDENTIDAD_IA, // AI-ACT-IDENTIDAD-1
    extra ? `Instrucción específica de esta automatización: ${extra}` : "",
    `\n# Base de conocimiento del negocio\n${kb}`,
    brand ? `\n# Voz de marca\n${brand}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  platform: CommentPlatform;
  /** "any" o el id del post/reel/vídeo concreto. */
  mediaId: string;
  /**
   * Solo YouTube: canal conectado al que se limita esta automatización.
   * "" o "any" = todos los canales (comportamiento de las automatizaciones
   * creadas antes de este campo, que llegan sin él). Con 2+ canales conectados
   * y mediaId 'any', sin esto la automatización dispararía en TODOS.
   */
  ytAccountId?: string;
  /** "" = cualquier comentario; si no, debe contener esta palabra/clave. */
  keyword: string;
  /** Respuesta pública al comentario. "" = no responder. */
  replyComment: string;
  /** Texto del DM. "" = no enviar DM. En YouTube se ignora (no hay DM). */
  dmText: string;
  /** Enlace. IG/FB: va dentro del DM. YouTube: se añade al final de la respuesta pública (el CTA). */
  dmLink: string;
  dmButtonText: string;
  /** Si true, genera replyComment/dmText con IA usando aiPrompt. */
  aiReply: boolean;
  aiPrompt: string;
  oncePerUser: boolean;
}

export interface CommentEvent {
  platform: CommentPlatform;
  commentId: string;
  text: string;
  username: string;
  userId: string;
  mediaId: string;
  /** Facebook: id de la Página dueña del post (para resolver el token). */
  pageId?: string;
  /** YouTube: id de la cuenta/canal conectado dueño del vídeo (para resolver el token). */
  ytAccountId?: string;
  /** LinkedIn: id numérico de la Página (organization) dueña del post (para resolver el token). */
  liOrgId?: string;
}

export async function listAutomations(): Promise<Automation[]> {
  return (await dbListAutomations()) as unknown as Automation[];
}

export async function saveAutomation(a: Automation): Promise<void> {
  await dbUpsertAutomation(a.id, a as unknown as Record<string, unknown>);
}

export async function deleteAutomation(id: string): Promise<void> {
  await dbDeleteAutomation(id);
}

function fill(t: string, ev: CommentEvent): string {
  return t.replace(/\{name\}/g, ev.username || "").replace(/\{text\}/g, ev.text || "");
}

/**
 * BANDEJA-AUTO-1 · Registra en la Bandeja el DM que acaba de salir por un
 * disparador de comentario, en vez de fiarse del eco de Meta (que Facebook
 * descarta siempre y que en Instagram no llega para todas las cuentas).
 * Espejo EXACTO de la condición link+buttonText de sendDmFromComment /
 * fbSendDmFromComment: solo hay botón cuando las dos vienen puestas; si no,
 * el enlace viaja pegado al texto (o no hay enlace).
 */
async function logAutoDm(userId: string, text: string, link?: string, buttonText?: string): Promise<void> {
  if (link && buttonText) {
    await flowLog(userId, "assistant", text || "👇", { btns: [{ t: buttonText.slice(0, 20), u: link }] });
  } else {
    await flowLog(userId, "assistant", link ? `${text}\n\n${link}` : text);
  }
}

/**
 * La UI pide las palabras clave "separadas por comas", pero el match era un
 * `includes` de la cadena ENTERA: una automatización con «guia, info» no casaba
 * jamás (el comentario tendría que contener literalmente "guia, info"). Ahora
 * se parte por comas y basta con que el comentario contenga CUALQUIERA de los
 * términos, que es lo que promete el formulario.
 *
 * ACENTOS-1 · Se normaliza con el MISMO deaccent() que matchesKeyword() de
 * flows.ts: una palabra clave «formación» tiene que casar con "formacion" (y al
 * revés). Antes solo se bajaba a minúsculas, así que los Disparadores de
 * IG/FB/YT/LinkedIn fallaban con cualquier tilde mientras los Flujos sí casaban.
 */
export function keywordHit(keyword: string, text: string): boolean {
  const terms = keyword.split(",").map((k) => deaccent(k.trim())).filter(Boolean);
  if (!terms.length) return true;
  const t = deaccent(text || "");
  return terms.some((k) => t.includes(k));
}

/** Longitud de la palabra clave que DE VERDAD casa con el texto (0 = ninguna, o
 *  disparador sin palabra clave: el cajón de sastre). Desempata por "la que mejor
 *  describe lo que la persona escribió", igual que matchedKeywordLen() de flows.ts. */
function matchedKwLen(keyword: string, text: string): number {
  const t = deaccent(text || "");
  let best = 0;
  for (const raw of (keyword || "").split(",")) {
    const k = deaccent(raw.trim());
    if (k && t.includes(k) && k.length > best) best = k.length;
  }
  return best;
}

/** Especificidad de un disparador, por NIVELES (réplica de flowTiers() de flows.ts;
 *  se comparan uno a uno, no se suman): 1) publicación concreta gana a "cualquiera",
 *  2) palabra clave más larga, 3) atado a un canal/cuenta concretos. */
function autoTiers(a: Automation, ev: CommentEvent): number[] {
  return [
    a.mediaId && a.mediaId !== "any" ? 1 : 0,
    matchedKwLen(a.keyword || "", ev.text),
    a.ytAccountId && a.ytAccountId !== "any" ? 1 : 0,
  ];
}

function matches(a: Automation, ev: CommentEvent): boolean {
  if (!a.enabled || a.platform !== ev.platform) return false;
  if (a.mediaId && a.mediaId !== "any" && a.mediaId !== ev.mediaId) return false;
  // Multi-canal de YouTube: sin este filtro, una automatización con mediaId
  // 'any' dispara en TODOS los canales conectados. El guard `a.ytAccountId &&`
  // mantiene el comportamiento anterior en las automatizaciones sin el campo.
  if (ev.platform === "youtube" && a.ytAccountId && a.ytAccountId !== "any" && a.ytAccountId !== ev.ytAccountId) return false;
  if (a.keyword && !keywordHit(a.keyword, ev.text)) return false;
  return true;
}

/**
 * Procesa un comentario entrante contra las automatizaciones que casan y ejecuta
 * COMO MUCHO UNA (la más específica que de verdad envía algo).
 * Devuelve 1 si se respondió y 0 si no (lo usa el poller de YouTube para el tope
 * diario y para decidir si además intenta un Flujo). En Instagram y Facebook los
 * puentes a Flujos del final NO miran este número, sino si el disparador ocupó el
 * mensaje privado del comentario (ver DOBLE-RESPUESTA-1 más abajo).
 */
export async function handleCommentEvent(ev: CommentEvent): Promise<number> {
  let executed = 0;
  // ¿Ha ocupado un disparador el MENSAJE PRIVADO de este comentario? Meta solo
  // permite UNA respuesta privada por comentario, así que es el único recurso que
  // un Disparador y un Flujo no pueden repartirse. Lo de abajo (DOBLE-RESPUESTA-1)
  // decide con esto, no con «¿ha hecho algo el disparador?».
  let dmOcupado = false;
  // ¿Y ha comentado ya en público bajo el post? Eso el Flujo sí puede repetirlo
  // técnicamente, pero deja DOS comentarios del negocio en el mismo hilo — que es
  // justo lo que Instagram marca como spam. Se le avisa para que se salte el suyo.
  let publicoOcupado = false;
  // UN-DISPARADOR-1 · Un comentario = UNA respuesta. Antes se recorrían TODAS las
  // automatizaciones que casaban y cada una publicaba su respuesta pública y su DM:
  // dos disparadores solapados (p. ej. uno por post concreto y otro "cualquiera")
  // dejaban dos comentarios del negocio colgando del mismo hilo. Ahora se ordenan
  // por especificidad (misma escala que los Flujos) y se para en la primera que de
  // verdad envía algo. El desempate final por id hace el orden ESTABLE: sin él,
  // dos disparadores gemelos se turnarían según lo que devolviera la BD.
  const all = (await listAutomations())
    .filter((a) => matches(a, ev))
    .sort((a, b) => {
      const A = autoTiers(a, ev);
      const B = autoTiers(b, ev);
      for (let i = 0; i < A.length; i++) if (B[i] !== A[i]) return B[i] - A[i];
      return String(a.id).localeCompare(String(b.id));
    });
  for (const a of all) {
    // Una automatización SIN nada que enviar (ni respuesta, ni DM, ni enlace, ni IA)
    // no puede actuar: se descarta ANTES de reclamar el dedup, para no quemarle a
    // esa persona el "una vez por usuario" con un envío que nunca ocurrió.
    if (!a.replyComment && !a.dmText && !a.dmLink && !a.aiReply) {
      console.warn(`[automations] '${a.name}': no tiene ninguna acción configurada, se omite.`);
      continue;
    }

    if (a.oncePerUser) {
      const first = await dbClaimOnce(a.id, ev.userId || ev.commentId);
      if (!first) continue;
    }

    // Facebook necesita el pageId (token de la Página); sin él no podemos actuar.
    if (ev.platform === "facebook" && !ev.pageId) {
      console.warn(`[automations] '${a.name}': comentario FB sin pageId, se omite.`);
      continue;
    }
    // YouTube necesita saber QUÉ canal conectado responde (su token OAuth).
    if (ev.platform === "youtube" && !ev.ytAccountId) {
      console.warn(`[automations] '${a.name}': comentario de YouTube sin canal, se omite.`);
      continue;
    }
    // LinkedIn necesita saber QUÉ Página responde (para resolver su token OAuth).
    if (ev.platform === "linkedin" && !ev.liOrgId) {
      console.warn(`[automations] '${a.name}': comentario de LinkedIn sin Página, se omite.`);
      continue;
    }

    try {
      // ENVIO-REAL-1 · `sent` solo se pone a true DESPUÉS de un envío confirmado.
      // Antes se contaba como ejecutada cualquier automatización que no lanzara,
      // aunque no hubiera salido nada (textos vacíos, IA sin respuesta y sin
      // fallback): el poller de YouTube sumaba esa respuesta fantasma a su tope
      // diario y el dedup la daba por procesada.
      let sent = false;
      let replyText = fill(a.replyComment, ev);
      let dmText = fill(a.dmText, ev);

      if (a.aiReply) {
        const generated = await quickReply(
          igAiSystem(a.aiPrompt, ev.platform),
          `Comentario de @${ev.username}: "${ev.text}"`,
        );
        if (generated) {
          // La respuesta IA sustituye al texto fijo (que queda de fallback).
          const disclosed = labelAiGeneratedContent(generated);
          replyText = disclosed;
          if (a.dmText) dmText = disclosed;
        }
      }

      const dm = dmText || "¡Hola! Te dejo el enlace 👇";
      if (ev.platform === "youtube") {
        // YouTube no tiene DM: la respuesta pública ES el canal, y el enlace del
        // CTA se añade al final (si la IA no lo puso ya). OJO: en Shorts los
        // enlaces de los comentarios NO son clicables (política de YouTube); en
        // vídeo largo sí, con las funciones avanzadas del canal activadas.
        let text = replyText;
        if (a.dmLink && text && !text.includes(a.dmLink)) text = `${text}\n${a.dmLink}`;
        if (!text) text = a.dmLink;
        // Enlace SIN acortar: se etiqueta con UTM (dominio real visible) en vez
        // de pasarlo por el tracker /r/ — la política de spam de YouTube penaliza
        // las URLs ofuscadas. Se desactiva con youtube.utm=off.
        if (text && get("youtube.utm") !== "off") {
          text = utmTagUrls(text, { utm_source: "youtube" });
        }
        if (text) { await youtubeReplyToComment(ev.ytAccountId!, ev.commentId, text); sent = true; }
      } else if (ev.platform === "linkedin") {
        // LinkedIn: solo respuesta pública (la Página no envía DMs a quien comenta).
        // El enlace del CTA se añade al final de la respuesta (si la IA no lo puso).
        // mediaId = URN del post/share (el `object`); commentId = URN del comentario padre.
        let text = replyText;
        if (a.dmLink && text && !text.includes(a.dmLink)) text = `${text}\n${a.dmLink}`;
        if (!text) text = a.dmLink;
        if (text) { await replyToLinkedInComment(ev.liOrgId!, ev.mediaId, ev.commentId, text); sent = true; }
      } else if (ev.platform === "facebook") {
        if (replyText) { await fbReplyToComment(ev.commentId, replyText, ev.pageId!); sent = true; publicoOcupado = true; }
        if (dmText || a.dmLink) {
          await fbSendDmFromComment({ commentId: ev.commentId, text: dm, link: a.dmLink || undefined, buttonText: a.dmButtonText || undefined, pageId: ev.pageId! });
          sent = true;
          dmOcupado = true;
          // BANDEJA-AUTO-1 · autorregistro: el webhook de Página DESCARTA todo eco
          // (index.ts) — sin esto, este DM nunca aparecía en la Bandeja.
          await logAutoDm(ev.userId, dm, a.dmLink, a.dmButtonText);
        }
      } else {
        if (replyText) { await replyToComment(ev.commentId, replyText); sent = true; publicoOcupado = true; }
        if (dmText || a.dmLink) {
          await sendDmFromComment({ commentId: ev.commentId, text: dm, link: a.dmLink || undefined, buttonText: a.dmButtonText || undefined });
          sent = true;
          dmOcupado = true;
          // BANDEJA-AUTO-1 · autorregistro: el eco de Instagram no llega para todas
          // las cuentas (visto en producción) — antes ese DM podía quedar invisible
          // en la Bandeja, o el eco lo guardaba como «[template]» si su forma no
          // casaba con lo esperado.
          await logAutoDm(ev.userId, dm, a.dmLink, a.dmButtonText);
        }
      }
      if (!sent) {
        console.warn(`[automations] '${a.name}': no se envió nada (sin texto ni enlace); no cuenta como ejecutada.`);
        continue;
      }
      executed++;
      console.log(`[automations] '${a.name}' ejecutada para @${ev.username} (${ev.platform})`);
      // UN-DISPARADOR-1 · ya hay respuesta para este comentario: no se sigue.
      break;
    } catch (e) {
      const msg = (e as Error).message || "";
      console.error(`[automations] '${a.name}' falló:`, msg);
      // CUOTA-YT-1 · 'yt:quotaExceeded' NO es un fallo de ESTA automatización:
      // es la cuota diaria del proyecto de Google, y afecta a todo lo que venga
      // detrás. Se propaga (única excepción a "un fallo no tumba el resto") para
      // que el poller de YouTube pause el sondeo en vez de seguir reclamando
      // comentarios que ya nadie podrá responder — cada claim gastado durante el
      // apagón es un comentario perdido para siempre.
      if (msg.startsWith("yt:quotaExceeded")) throw e;
    }
  }

  // ¿Y si NINGÚN disparador ha contestado? Entonces —y solo entonces— se prueba con
  // los Flujos que tengan trigger ig_comment o fb_comment.
  //
  // DOBLE-RESPUESTA-1 · Estos dos puentes eran INCONDICIONALES: un comentario que
  //     casaba un Disparador Y un Flujo recibía las dos cosas, así que el negocio
  //     pedía DOS mensajes privados y Meta descartaba el segundo en silencio.
  //
  //     El guard NO es 'executed === 0' (que sí vale para YouTube, youtube-comments.ts
  //     'if (done === 0)'): allí NO EXISTE el DM, la respuesta pública es el único
  //     canal, y cortar por «ya ha respondido alguien» es exacto. Aquí el Disparador
  //     y el Flujo pueden usar canales DISTINTOS y compatibles: un disparador que solo
  //     comenta en público no estorba al DM del flujo. Cortar por 'executed' mataba
  //     ese DM — es decir, el lead — sin que nada lo registrara.
  //
  //     Se corta solo por el recurso que de verdad es único: la respuesta PRIVADA.
  //     El otro solapamiento (disparador que comenta en público + flujo que también
  //     comenta) no se resuelve cortando, sino avisando: se le pasa `publicoOcupado`
  //     al flujo y este se salta SU respuesta pública y entrega solo por privado
  //     (PUBLICO-OCUPADO-1 en flows.ts). Así ninguna de las dos entregas se pierde
  //     y el hilo del post no acaba con dos comentarios del negocio.
  //
  // ALCANCE-FB-1 · (1) YA NO está fuera de alcance: el trigger `fb_comment` existe
  //     (flows.ts) con sus ramas de envío por Messenger; el puente se cruza abajo
  //     igual que el de Instagram.
  // (2) Lectura de comentarios de Facebook: YA NO está fuera de alcance — existe
  //     listFbComments() y con ella backfillFbCommentDrops(), la red de recuperación
  //     espejo de la de Instagram (más abajo en este mismo archivo).
  // Nada de esto afecta a los Disparadores de Facebook, que funcionan al 100% en vivo:
  // Meta ENTREGA cada comentario por webhook (campo 'feed') y de ahí sale este motor.
  if (dmOcupado && ev.platform === "instagram") {
    recordWebhook("instagram", "⏭️ un disparador ya mandó el mensaje privado de este comentario → los flujos ig_comment no se evalúan (Meta solo permite uno)");
  }
  if (!dmOcupado && ev.platform === "instagram") {
    try {
      await triggerIgFlows(ev.userId, ev.text, ev.commentId, ev.mediaId, ev.username, publicoOcupado);
    } catch (e) {
      console.error("[automations] triggerIgFlows:", (e as Error).message);
    }
  }
  if (dmOcupado && ev.platform === "facebook") {
    recordWebhook("facebook", "⏭️ un disparador ya mandó el mensaje privado de este comentario → los flujos fb_comment no se evalúan (Meta solo permite uno)");
  }
  if (!dmOcupado && ev.platform === "facebook" && ev.pageId) {
    try {
      await triggerFbFlows(ev.userId, ev.text, ev.commentId, ev.mediaId, ev.pageId, ev.username, publicoOcupado);
    } catch (e) {
      console.error("[automations] triggerFbFlows:", (e as Error).message);
    }
  }
  return executed;
}

/**
 * BACKFILL-COMENTARIOS-FB · Espejo exacto de backfillIgCommentDrops (flows.ts) para
 * Facebook: rescata los comentarios que NUNCA entraron en su automatización porque
 * su webhook 'feed' no llegó (reinicio del proceso, entrega fallida de Meta, firma
 * rechazada durante un despliegue). Antes de esto, Facebook era la única de las tres
 * redes sin red de seguridad: Instagram tiene su backfill y su goteo, YouTube se
 * autorrepara porque sondea con marca de agua de 48 h, y en Facebook el comentario
 * se perdía para siempre sin que nadie se enterara.
 *
 * Señal EXACTA de "se cayó": index.ts reclama TODO comentario de Página con
 * dbClaimOnce("_fb_comment", commentId) ANTES de llamar al motor. Un comentario SIN
 * reclamar = su webhook no llegó.
 *
 * Idempotente: reclama el comentario antes de reinyectarlo, así ni este barrido ni
 * un webhook tardío lo procesan dos veces. dryRun=true (POR DEFECTO) no reclama ni
 * publica nada: solo dice a quién rescataría.
 */
export type FbBackfillReport = {
  dryRun: boolean;
  sinceHours: number;
  pages: number;
  postsScanned: number;
  matched: number;     // comentarios dentro de la ventana que casan alguna automatización
  alreadyIn: number;   // ya reclamados (su webhook sí llegó) → no se tocan
  dropped: number;     // sin reclamar = se cayeron
  triggered: number;   // rescatados de verdad en esta pasada
  people: Array<{ page: string; username: string; commentId: string; postId: string; text: string; when: string; action: string }>;
  errors: string[];
};

export async function backfillFbCommentDrops(
  opts: { sinceHours?: number; dryRun?: boolean; maxPosts?: number } = {},
): Promise<FbBackfillReport> {
  const sinceHours = opts.sinceHours ?? 24;
  const cutoff = Date.now() - sinceHours * 3600_000;
  const dryRun = opts.dryRun !== false; // por defecto NO publica
  const maxPosts = Math.min(50, Math.max(1, opts.maxPosts ?? 25));
  const rep: FbBackfillReport = {
    dryRun, sinceHours, pages: 0, postsScanned: 0, matched: 0, alreadyIn: 0, dropped: 0, triggered: 0, people: [], errors: [],
  };

  const autos = (await listAutomations()).filter((a) => a.enabled && a.platform === "facebook");
  // RESCATE-FB-FLUJOS-1 · Los Disparadores se están retirando. Sin mirar también los
  // flujos fb_comment, el día que un cliente convierta los suyos este botón diría «0
  // caídos» sin haber llamado siquiera a Meta. Para este barrido las dos familias
  // aportan lo mismo: a qué publicaciones hay que ir a mirar. (Instagram ya lo hacía
  // así: backfillIgCommentDrops se alimenta de listFlows.)
  const flujosFb = (await listFlows()).filter((f) => f.enabled && f.trigger?.type === "fb_comment");
  if (!autos.length && !flujosFb.length) return rep;


  for (const acc of listFbAccounts()) {
    // Automatizaciones que pueden actuar en ESTA Página. Las de post concreto solo
    // valen si el post es suyo: el id es "<pageId>_<postId>" (CONTRATO DEL ID).
    const dePagina = (mid?: string) => !mid || mid === "any" || String(mid).startsWith(acc.pageId + "_");
    const forPage = autos.filter((a) => dePagina(a.mediaId));
    // RESCATE-FB-FLUJOS-1 · los flujos fb_comment aportan lo mismo que los disparadores:
    // a qué publicaciones mirar y qué palabra clave hace que un comentario cuente.
    const flujosPagina = flujosFb.filter((f) => dePagina(f.trigger?.mediaId) && flowAppliesTo(f, acc.pageId));
    if (!forPage.length && !flujosPagina.length) continue;
    rep.pages++;

    // Posts a barrer: los concretos de las automatizaciones atadas a un post, más los
    // recientes de la Página si alguna automatización es de "cualquier publicación".
    const targeted = new Set<string>();
    for (const a of forPage) if (a.mediaId && a.mediaId !== "any") targeted.add(String(a.mediaId));
    for (const f of flujosPagina) { const m = f.trigger?.mediaId; if (m && m !== "any") targeted.add(String(m)); }
    const anyPost = forPage.some((a) => !a.mediaId || a.mediaId === "any") ||
      flujosPagina.some((f) => !f.trigger?.mediaId || f.trigger.mediaId === "any");
    if (anyPost) {
      try {
        for (const p of await listFbPosts(acc.pageId, maxPosts)) if (p.id) targeted.add(p.id);
      } catch (e) {
        rep.errors.push("Página " + acc.pageId + ": " + (e as Error).message);
      }
    }

    for (const postId of [...targeted].slice(0, maxPosts)) {
      let comments: Awaited<ReturnType<typeof listFbComments>> = [];
      try {
        comments = await listFbComments(acc.pageId, postId, cutoff);
        rep.postsScanned++;
      } catch (e) {
        rep.errors.push("post " + postId + ": " + (e as Error).message);
        continue;
      }
      for (const c of comments) {
        if (c.ts < cutoff) continue;
        // Freno anti-bucle: nunca los comentarios de la propia Página (nuestras
        // respuestas contienen la palabra clave y nos responderíamos a nosotros).
        if (c.fromId && c.fromId === acc.pageId) continue;
        const ev: CommentEvent = {
          platform: "facebook",
          commentId: c.id,
          text: c.text,
          username: c.fromName,
          userId: c.fromId || c.id,
          mediaId: postId,
          pageId: acc.pageId,
        };
        const casaDisparador = forPage.some((a) => matches(a, ev));
        const casaFlujo = flujosPagina.some((f) => {
          const mid = f.trigger?.mediaId || "any";
          if (mid !== "any" && mid !== ev.mediaId) return false;
          return matchesKeyword(ev.text, f.trigger?.keyword, f.trigger?.matchExact);
        });
        if (!casaDisparador && !casaFlujo) continue;
        rep.matched++;
        // ¿llegó su webhook? dbWasClaimed es SOLO LECTURA: mirar no gasta el claim.
        let claimed = false;
        try { claimed = await dbWasClaimed("_fb_comment", c.id); } catch { claimed = false; }
        if (claimed) { rep.alreadyIn++; continue; }
        rep.dropped++;
        let action = "";
        if (dryRun) {
          action = "se rescataría";
        } else {
          // Reclama ANTES de actuar: si justo ahora llegara el webhook tardío, uno
          // de los dos pierde el INSERT y no se responde dos veces.
          let claimedNow = false;
          try { claimedNow = await dbClaimOnce("_fb_comment", c.id); } catch { claimedNow = false; }
          if (!claimedNow) {
            action = "lo tomó otro proceso justo ahora";
          } else {
            try {
              const done = await handleCommentEvent(ev);
              if (done > 0) { rep.triggered++; action = "RESCATADO"; }
              else action = "ninguna automatización llegó a enviar nada";
            } catch (e) {
              action = "error al disparar: " + (e as Error).message;
              rep.errors.push(c.id + ": " + action);
            }
          }
        }
        rep.people.push({
          page: acc.pageId,
          username: c.fromName,
          commentId: c.id,
          postId,
          text: String(c.text || "").slice(0, 60),
          when: c.ts ? new Date(c.ts).toISOString() : "",
          action,
        });
      }
    }
  }
  return rep;
}
