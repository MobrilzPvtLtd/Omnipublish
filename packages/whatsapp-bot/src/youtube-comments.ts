/**
 * Auto-respuesta a comentarios de YouTube (paridad con los Disparadores de IG/FB).
 *
 * POR QUÉ UN POLLER Y NO UN WEBHOOK
 * YouTube no tiene webhooks de comentarios. Su sistema push (WebSub) solo avisa
 * de vídeos nuevos y de cambios de título/descripción. El único patrón posible
 * es preguntar cada X (commentThreads.list = 1 unidad de cuota, y con
 * `allThreadsRelatedToChannelId` una sola llamada cubre TODO el canal).
 *
 * CUOTA (bucket general del proyecto: 10.000 unidades/día, compartido)
 *   poll cada 120s × 1 canal ≈ 720 unidades/día · cada respuesta = 50 unidades
 *   (la lectura pagina hasta la marca de agua: 1 unidad por página, máx. 5 por
 *    canal y tick, y solo si de verdad hay esa avalancha de comentarios nuevos)
 * → el tope diario de respuestas (dailyCap) existe para no fundir la cuota ni
 *   parecer spam. Responder comentarios NO requiere la compliance audit de
 *   YouTube (esa restricción aplica solo a subir vídeos).
 *
 * CINCO FRENOS (el orden importa, cada uno tapa un fallo distinto):
 *   1. Interruptor maestro APAGADO por defecto. Las políticas de YouTube exigen
 *      consentimiento expreso del dueño antes de actuar en su nombre: encenderlo
 *      es ese consentimiento.
 *   2. Marca de agua (`since`): al encender, solo se responden comentarios
 *      NUEVOS. Sin esto, el primer tick contestaría el histórico entero del
 *      canal de golpe — exactamente el patrón que YouTube penaliza como spam.
 *   3. Antigüedad máxima (48h): red de seguridad por si la marca de agua queda
 *      obsoleta (p. ej. se apaga el interruptor meses y se vuelve a encender).
 *   4. Dedup por id de comentario (dbClaimOnce): un comentario se procesa UNA
 *      vez aunque siga apareciendo en ticks siguientes.
 *   5. Nunca respondemos a comentarios del PROPIO canal: si no, nuestra respuesta
 *      contiene la palabra clave, la volvemos a leer y nos respondemos en bucle.
 */
import { get, set } from "./settings.js";
import { runWithWorkspace, listWorkspacesCached } from "./workspace.js";
import { logActivity } from "./activity.js";
import { recordWebhook } from "./webhookDebug.js";
import { notificar } from "./notifications.js";
import { dbClaimOnce, dbWasClaimed } from "./db.js";
import { handleCommentEvent, listAutomations, keywordHit } from "./automations.js";
import { triggerYtFlows } from "./flows.js";
import { listFlows, matchesKeyword } from "./flows.js";
import { youtubeListAccounts, youtubeCanWrite, youtubeListRecentComments } from "./youtube.js";

/** Nunca responder a un comentario más viejo que esto, pase lo que pase. */
const MAX_AGE_MS = 48 * 3600 * 1000;
/** Respuestas por tick: evita ráfagas (YouTube mira el "comportamiento", no solo el texto). */
const PER_TICK_CAP = 3;
const DEFAULT_DAILY_CAP = 40;
// Cada cuánto mira: 1 h de fábrica; el dueño lo cambia en Conexiones → YouTube (youtube.autoreply.pollSec).
const DEFAULT_POLL_SEC = 3600;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Respuestas ya enviadas hoy en este workspace (el contador se resetea al cambiar de día). */
function repliesToday(): number {
  if (get("youtube.autoreply.day") !== today()) return 0;
  return Number(get("youtube.autoreply.count") || 0);
}

/**
 * Próximo cambio de día en el PACÍFICO (America/Los_Angeles), en epoch ms. Es el
 * horizonte de la pausa por cuota: Google reinicia el bucket diario de la YouTube
 * Data API a medianoche del Pacífico (PST/PDT), NO a medianoche UTC
 * — developers.google.com/youtube/v3/determine_quota_cost.
 *
 * CUOTA-YT-2 · Con la medianoche UTC el poller se reanudaba hasta 8 horas ANTES
 * del reset real: el primer comentario volvía a chocar con la cuota, gastaba su
 * claim (que no tiene release: ese comentario se pierde para siempre) y dejaba el
 * sondeo pausado otras 24 h — es decir, la mayor parte del día siguiente.
 *
 * Se calcula con Intl (sin dependencias ni tabla de horarios de verano a mano):
 * fecha civil de Los Ángeles ahora → desfase del huso en este instante → medianoche
 * civil del día siguiente traída de vuelta a epoch.
 */
function nextPacificMidnight(): number {
  const now = Date.now();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(now));
    const g = (t: string): number => {
      const p = parts.find((x) => x.type === t);
      return p ? Number(p.value) : 0;
    };
    // Algunos ICU devuelven "24" a medianoche con hour12:false.
    const civil = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
    // Desfase del huso EN ESTE INSTANTE (negativo en el Pacífico).
    const offset = civil - Math.floor(now / 1000) * 1000;
    // Medianoche civil del día siguiente, devuelta a epoch real. Si esa noche hay
    // cambio de horario de verano el instante baila una hora: irrelevante para una
    // pausa de cuota (como mucho se reanuda 60 min antes o después).
    return Date.UTC(g("year"), g("month") - 1, g("day") + 1, 0, 0, 0, 0) - offset;
  } catch {
    // Runtime sin datos de husos (ICU recortado): margen fijo de 24 h, que nunca
    // reanuda ANTES del reset (que es el fallo que estamos corrigiendo).
    return now + 24 * 3600 * 1000;
  }
}

async function bumpRepliesToday(n: number): Promise<void> {
  const base = repliesToday();
  await set("youtube.autoreply.day", today());
  await set("youtube.autoreply.count", String(base + n));
}

/** Al ENCENDER el interruptor: la marca de agua se pone a "ahora" para no
 *  contestar el histórico. Lo llama el endpoint del panel. */
export async function youtubeAutoreplyArm(): Promise<void> {
  await set("youtube.autoreply.since", String(Date.now()));
}

/**
 * Resumen honesto de un ciclo del poller. Lo devuelve «Probar ahora» del panel
 * para poder decir POR QUÉ no se responde, en vez de un «no ha pasado nada».
 */
export interface YtTickReport {
  /** Comentarios leídos de la API en este ciclo. */
  leidos: number;
  /** De esos, posteriores a la marca de agua y no escritos por el propio canal. */
  frescos: number;
  /** Frescos que ya se habían procesado en un ciclo anterior (dedup). */
  yaVistos: number;
  /** Comentarios nuevos que encajan con algún disparador o flujo de YouTube. */
  casados: number;
  /** Respuestas publicadas de verdad (siempre 0 en modo prueba). */
  respondidos: number;
  /** Frenos que se han activado, en el idioma del dueño del canal. */
  motivos: string[];
  /** true = no se ha publicado nada ni se ha consumido el dedup. */
  dryRun: boolean;
}

type YtAutomation = Awaited<ReturnType<typeof listAutomations>>[number];
type YtFlowDef = Awaited<ReturnType<typeof listFlows>>[number];

/**
 * ¿Este comentario habría disparado algo? SOLO LECTURA: es lo que usa el modo
 * prueba (dryRun) para contar los "casados" sin publicar ni reclamar nada.
 * Réplica del `matches()` de automations.ts y del filtro de triggerYtFlows.
 * `autos` y `ytFlows` llegan ya filtrados (youtube + activos).
 *
 * PRUEBA-FIEL-1 · Usa el keywordHit() REAL de automations.ts (importado, no una
 * copia): antes había aquí un clon sin normalizar acentos, así que el contador de
 * «casados» del modo prueba se calculaba con reglas distintas a las del motor y
 * podía decir «ninguno encaja» sobre comentarios que el poller sí responde.
 */
function ytWouldMatch(
  autos: YtAutomation[],
  ytFlows: YtFlowDef[],
  c: { text: string; videoId: string },
  accountId: string,
): boolean {
  for (const a of autos) {
    if (a.mediaId && a.mediaId !== "any" && a.mediaId !== c.videoId) continue;
    if (a.ytAccountId && a.ytAccountId !== "any" && a.ytAccountId !== accountId) continue;
    if (a.keyword && !keywordHit(a.keyword, c.text)) continue;
    return true;
  }
  for (const f of ytFlows) {
    // AMBITO-YT-1 · el motor (triggerYtFlows) ya filtra por canal, así que aquí también:
    // es exactamente la divergencia que advierte PRUEBA-FIEL-1 justo arriba. Sin esto,
    // «Probar ahora» contaría como casados comentarios que el motor no responde.
    if (f.appliesTo && f.appliesTo !== accountId) continue;
    const mid = f.trigger?.mediaId || "any";
    if (mid !== "any" && mid !== c.videoId) continue;
    if (!matchesKeyword(c.text, f.trigger?.keyword, f.trigger?.matchExact)) continue;
    return true;
  }
  return false;
}

/**
 * Un ciclo de poll del workspace activo. Exportado para poder probarlo/forzarlo
 * sin esperar al timer de 60s: lo usa POST /admin/api/yt-autoreply/test.
 *   force  → salta el interruptor maestro y el ritmo del poll (nada más).
 *   dryRun → NO publica, NO consume el dedup y NO mueve las marcas de tiempo.
 */
export async function youtubeAutoreplyTick(
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<YtTickReport> {
  return tickForCurrentWorkspace(opts);
}

async function tickForCurrentWorkspace(
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<YtTickReport> {
  const force = opts.force === true;
  const dryRun = opts.dryRun === true;
  const rep: YtTickReport = {
    leidos: 0, frescos: 0, yaVistos: 0, casados: 0, respondidos: 0, motivos: [], dryRun,
  };

  if (get("youtube.autoreply.enabled") !== "true") {
    rep.motivos.push("El interruptor de respuestas de YouTube está apagado.");
    if (!force) return rep;
  }

  // Freno 6 (CUOTA-YT-1): pausa por cuota agotada del proyecto de Google. La
  // pone el catch de abajo al ver un 'yt:quotaExceeded'. Mientras dure NO se
  // lee NI se reclama nada: cada dbClaimOnce que gastáramos ahora marcaría el
  // comentario como visto sin poder responderlo (no hay release del claim).
  // Es per-workspace, como el resto de settings youtube.* .
  // `force` NO lo salta a propósito: forzar aquí solo quemaría más cuota.
  const pausedUntil = Number(get("youtube.autoreply.pausedUntil") || 0);
  if (Date.now() < pausedUntil) {
    rep.motivos.push(
      "Cuota de la API de YouTube agotada: en pausa hasta " +
        new Date(pausedUntil).toISOString().slice(0, 16).replace("T", " ") + " UTC.",
    );
    return rep;
  }

  // ¿Hay algo que hacer? Sin disparadores NI flujos de YouTube activos no gastamos cuota.
  const autos = (await listAutomations()).filter((a) => a.platform === "youtube" && a.enabled);
  const ytFlows = (await listFlows()).filter((f) => f.enabled && f.trigger?.type === "yt_comment");
  if (!autos.length && !ytFlows.length) {
    rep.motivos.push("No hay ningún disparador ni flujo de YouTube activo.");
    return rep;
  }

  const allAccounts = youtubeListAccounts();
  const accounts = allAccounts.filter(youtubeCanWrite);
  if (!accounts.length) {
    rep.motivos.push(
      allAccounts.length
        ? "Ningún canal conectado puede escribir comentarios: reconéctalo en Conexiones → YouTube para dar el permiso."
        : "No hay ningún canal de YouTube conectado.",
    );
    return rep;
  }

  // Ritmo del poll (independiente del tick de 60s del scheduler).
  const pollMs = Math.max(60, Number(get("youtube.autoreply.pollSec")) || DEFAULT_POLL_SEC) * 1000;
  const last = Number(get("youtube.autoreply.lastPoll") || 0);
  if (Date.now() - last < pollMs && !force) {
    rep.motivos.push("Todavía no tocaba comprobar (se mira cada " + Math.round(pollMs / 1000) + " s).");
    return rep;
  }
  // En modo prueba no se mueve la marca del último sondeo: si no, el poller de
  // verdad se quedaría esperando otro ciclo entero por haber pulsado un botón.
  if (!dryRun) await set("youtube.autoreply.lastPoll", String(Date.now()));

  // Marca de agua: primera vez → solo comentarios de aquí en adelante.
  let since = Number(get("youtube.autoreply.since") || 0);
  if (!since) {
    rep.motivos.push(
      dryRun
        ? "Aún no hay marca de agua: al encender el interruptor se fijará y solo se responderán los comentarios posteriores."
        : "No había marca de agua: se acaba de fijar, solo se responderán los comentarios de aquí en adelante.",
    );
    if (!dryRun) await set("youtube.autoreply.since", String(Date.now()));
    return rep;
  }
  // Freno 3: aunque la marca de agua sea antigua, nunca tocamos nada de hace >48h.
  since = Math.max(since, Date.now() - MAX_AGE_MS);

  // TOPE-CERO-1 · «Vacío» y «cero» NO son lo mismo. Antes: `Number(get(...)) || DEFAULT`,
  // y como Number("0") es 0 (falsy) el `||` lo convertía en 40. El panel admite min=0 y
  // el endpoint guarda el 0 tal cual, así que el dueño ponía 0 para FRENAR al bot, la
  // tarjeta le mostraba «Máximo de respuestas al día: 0»… y el poller seguía publicando
  // hasta 40 respuestas reales al día en su canal. Ahora solo se cae al valor por
  // defecto cuando el ajuste está ausente o no es un número.
  const _capRaw = get("youtube.autoreply.dailyCap");
  const _capNum = Number(_capRaw);
  const dailyCap =
    _capRaw !== "" && Number.isFinite(_capNum)
      ? Math.max(0, Math.min(200, Math.floor(_capNum)))
      : DEFAULT_DAILY_CAP;
  let sentThisTick = 0;
  // Contador de claims del tick para el Diagnóstico de Conexiones (recordWebhook
  // al final): sin esto el poller es invisible y "no pasa nada" no se distingue
  // de "no se está ejecutando". Los demás contadores viven ya en `rep`.
  let claimedTotal = 0;

  for (const acc of accounts) {
    if (sentThisTick >= PER_TICK_CAP) break;
    if (repliesToday() >= dailyCap) {
      rep.motivos.push("Tope diario alcanzado (" + dailyCap + " respuestas): no se responde más hoy.");
      console.warn(`[yt-comments] tope diario alcanzado (${dailyCap}); no se responde más hoy.`);
      // En modo prueba no se ensucia la telemetría: no se ha intentado responder.
      if (!dryRun) {
        await logActivity({
          source: "yt-send",
          level: "warn",
          summary: "Tope diario de respuestas de YouTube alcanzado (" + dailyCap + "): no se responde más hoy",
          payload: {
            file: "youtube-comments.ts",
            fn: "tickForCurrentWorkspace",
            dailyCap,
            sentToday: repliesToday(),
          },
        }).catch(() => { /* la telemetría nunca rompe el envío */ });
      }
      break;
    }

    let comments;
    try {
      // YT-INGESTA-1 · 50 por página y paginación hasta la marca de agua: con
      // una sola página de 20, un canal con más de 20 comentarios nuevos entre
      // polls perdía los más antiguos para siempre. `since` corta el bucle
      // dentro de la primera página en el caso normal (1 unidad de cuota).
      comments = await youtubeListRecentComments(acc.id, 50, since);
    } catch (e) {
      const msg = (e as Error).message || "";
      console.error(`[yt-comments] leyendo comentarios de "${acc.title}":`, msg);
      await logActivity({
        source: "yt-send",
        level: "error",
        summary: "No se pudieron leer los comentarios de YouTube: " + msg.slice(0, 140),
        payload: {
          file: "youtube-comments.ts",
          fn: "youtubeListRecentComments",
          channel: acc.title,
          accountId: acc.id,
          error: msg.slice(0, 400),
        },
      }).catch(() => { /* la telemetría nunca rompe el envío */ });
      continue;
    }
    rep.leidos += comments.length;

    // Del más antiguo al más nuevo: si topamos el cap, dejamos sin responder los
    // más recientes (que seguirán ahí en el próximo tick), no los más viejos.
    const fresh = comments
      .filter((c) => c.publishedAt > since)
      .filter((c) => c.authorChannelId !== acc.channelId) // freno 5: no respondernos a nosotros
      .sort((a, b) => a.publishedAt - b.publishedAt);
    rep.frescos += fresh.length;

    for (const c of fresh) {
      if (sentThisTick >= PER_TICK_CAP || repliesToday() >= dailyCap) break;
      // MODO PRUEBA: mirar sin tocar. dbWasClaimed es la versión SOLO LECTURA de
      // dbClaimOnce (no escribe), así que probar no "gasta" comentarios: los que
      // encajen los seguirá respondiendo el poller de verdad en su próximo ciclo.
      if (dryRun) {
        if (await dbWasClaimed("__ytpoll", c.id)) { rep.yaVistos++; continue; }
        if (ytWouldMatch(autos, ytFlows, c, acc.id)) rep.casados++;
        continue;
      }
      // Freno 4: dedup. Reclamamos el comentario aunque luego no case ninguna
      // automatización — "visto" es "visto", y así no lo re-evaluamos cada tick.
      const first = await dbClaimOnce("__ytpoll", c.id);
      if (!first) { rep.yaVistos++; continue; }
      claimedTotal++;
      // NOTIFICACIONES-1 · comentario (una vez por comentario: el claim de arriba)
      notificar({ kind: "comentario", title: "Comentario nuevo en YouTube" + (c.author ? " de " + c.author : ""), body: "«" + String(c.text || "").replace(/\s+/g, " ").trim().slice(0, 140) + "»", channel: "youtube", accountName: acc.title, link: c.videoId ? "https://www.youtube.com/watch?v=" + encodeURIComponent(c.videoId) + "&lc=" + encodeURIComponent(c.id) : null, dedup: "comentario:youtube:" + c.id });

      try {
        // UNA-RESPUESTA-YT-1 · Disparadores y Flujos COMPITEN por el comentario, no
        // se acumulan. Antes se ejecutaban los dos sobre el mismo commentId: si un
        // disparador y un flujo casaban, el canal publicaba DOS respuestas públicas
        // distintas colgando del mismo hilo (spam, riesgo de baneo). Gana el
        // Disparador (es la respuesta de un paso, inmediata); los Flujos solo entran
        // si ningún disparador ha respondido.
        // 1) Disparadores (respuesta de un paso). Devuelve 0 o 1.
        let done = await handleCommentEvent({
          platform: "youtube",
          commentId: c.id,
          text: c.text,
          username: c.author,
          userId: c.authorChannelId || c.id,
          mediaId: c.videoId,
          ytAccountId: acc.id,
        });
        // 2) Solo si NADIE respondió: flujos con disparador yt_comment (ramificación
        //    por texto, esperas). Publican comentarios igual que un disparador → si
        //    arrancan, cuentan para el tope diario.
        if (done === 0) {
          // PRUEBA-CANAL-1 · el nombre de quien comenta viaja al motor: es con lo que se
          // compara el nombre de prueba cuando el flujo está en modo prueba.
          done = await triggerYtFlows(c.authorChannelId, c.text, c.id, c.videoId, acc.id, c.author);
        }
        if (done > 0) {
          sentThisTick += done;
          rep.casados++;
          rep.respondidos += done;
          await bumpRepliesToday(done);
        }
      } catch (e) {
        const msg = (e as Error).message || "";
        console.error(`[yt-comments] procesando ${c.id}:`, msg);
        // CUOTA-YT-1 · ESTE comentario se pierde pase lo que pase: su claim ya
        // está consumido (dbClaimOnce arriba, sin release) y no volverá a
        // entrar en un tick futuro. Es el precio de no responder dos veces.
        // Lo que sí evitamos es quemar los SIGUIENTES: si la cuota del proyecto
        // está agotada, cada claim adicional sería otro comentario perdido.
        if (msg.startsWith("yt:quotaExceeded")) {
          const until = nextPacificMidnight();
          await set("youtube.autoreply.pausedUntil", String(until));
          await logActivity({
            source: "yt-send",
            level: "error",
            summary: "Cuota de la API de YouTube agotada: auto-respuesta en pausa hasta que Google reinicie el contador (medianoche del Pacífico)",
            payload: {
              file: "youtube-comments.ts",
              fn: "tickForCurrentWorkspace",
              commentId: c.id,
              videoId: c.videoId,
              pausedUntil: until,
              error: msg.slice(0, 400),
            },
          }).catch(() => { /* la telemetría nunca rompe el envío */ });
          recordWebhook(
            "yt",
            "⛔ cuota de la API de YouTube agotada → auto-respuesta EN PAUSA hasta " +
              new Date(until).toISOString().slice(0, 16).replace("T", " ") + " UTC",
          );
          rep.motivos.push(
            "Cuota de la API de YouTube agotada: en pausa hasta " +
              new Date(until).toISOString().slice(0, 16).replace("T", " ") + " UTC.",
          );
          return rep; // sale de AMBOS bucles: ni un claim más hasta que vuelva la cuota
        }
        await logActivity({
          source: "yt-send",
          level: "error",
          summary: "No se pudo procesar un comentario de YouTube: " + msg.slice(0, 140),
          payload: {
            file: "youtube-comments.ts",
            fn: "tickForCurrentWorkspace",
            commentId: c.id,
            videoId: c.videoId,
            error: msg.slice(0, 400),
          },
        }).catch(() => { /* la telemetría nunca rompe el envío */ });
        // 'yt:commentsDisabled' y 'yt:forbidden' son del VÍDEO concreto, no del
        // proyecto: seguimos con el resto de comentarios del tick.
        continue;
      }
    }
  }

  // Si no ha saltado ningún freno y aun así no hay nada que responder, hay que
  // decirlo igual: el panel no puede quedarse mudo tras pulsar «Probar ahora».
  if (!rep.motivos.length && !rep.casados && !rep.respondidos) {
    rep.motivos.push(
      rep.frescos
        ? "Hay comentarios nuevos, pero ninguno encaja con tus disparadores ni con tus flujos de YouTube."
        : "No hay comentarios nuevos desde la marca de agua.",
    );
  }

  // Una traza por tick para el Diagnóstico de Conexiones: demuestra que el
  // poller corre (YouTube no manda webhooks, así que sin esto no hay señal).
  recordWebhook(
    "yt",
    (dryRun ? "🧪 prueba de sondeo (no publica nada): " : "🔎 sondeo de comentarios: ") +
      rep.leidos + " leídos · " + rep.frescos + " nuevos · " +
      (dryRun ? rep.yaVistos + " ya vistos · " + rep.casados + " encajan" : claimedTotal + " procesados"),
  );
  return rep;
}

// Multi-tenant: las settings del auto-reply son per-workspace, igual que el
// autopost. Iteramos workspaces y cada uno corre en su scope.
async function tick(): Promise<void> {
  let workspaces: { id: string }[] = [{ id: "default" }];
  try {
    const wss = await listWorkspacesCached();
    if (wss.length) workspaces = wss.map((w) => ({ id: w.id }));
  } catch {
    // BD no disponible → solo 'default'.
  }
  for (const ws of workspaces) {
    try {
      // Sin force ni dryRun: el ciclo normal del scheduler, exactamente igual que antes.
      await runWithWorkspace(ws.id, () => tickForCurrentWorkspace());
    } catch (e) {
      console.error(`[yt-comments] tick ws=${ws.id}:`, (e as Error).message);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startYoutubeCommentPoller(): void {
  if (timer) return;
  timer = setInterval(tick, 60_000);
  console.log("[yt-comments] poller de comentarios de YouTube activo (tick 60s)");
}
