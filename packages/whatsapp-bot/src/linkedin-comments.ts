/**
 * Auto-respuesta a comentarios de LinkedIn (paridad con los Disparadores de IG/FB/YT).
 *
 * POR QUÉ UN POLLER Y NO UN WEBHOOK
 * La Community Management API de LinkedIn no entrega webhooks de comentarios a apps
 * self-serve. El único patrón es preguntar cada X por los comentarios de nuestros
 * propios posts (socialActions/{share}/comments). Calca 1:1 el poller de YouTube.
 *
 * CINCO FRENOS (el orden importa, cada uno tapa un fallo distinto):
 *   1. Interruptor maestro APAGADO por defecto (linkedin.autoreply.enabled). Encenderlo
 *      es el consentimiento expreso del dueño para actuar como la Página.
 *   2. Marca de agua (since): al encender, solo comentarios NUEVOS. Sin esto, el primer
 *      tick contestaría el histórico entero de golpe (spam).
 *   3. Antigüedad máxima (48h): red de seguridad si la marca de agua queda obsoleta.
 *   4. Dedup por URN de comentario (dbClaimOnce '__lipoll'): cada comentario se procesa
 *      UNA vez aunque siga apareciendo en ticks posteriores.
 *   5. Nunca respondemos a comentarios de la PROPIA Página: si no, leeríamos nuestra
 *      respuesta y entraríamos en bucle.
 *
 * Todo es per-workspace y depende del token linkedin.cm.* (app CM separada de Ads).
 */
import { get, set } from "./settings.js";
import { runWithWorkspace, listWorkspacesCached } from "./workspace.js";
import { dbClaimOnce } from "./db.js";
import { notificar } from "./notifications.js";
import { handleCommentEvent, listAutomations } from "./automations.js";
import { listFlows, triggerLiFlows } from "./flows.js";
import { listLinkedInComments, linkedinCmOrgsList, linkedinCmConnected } from "./linkedinCommunity.js";

/** Nunca responder a un comentario más viejo que esto, pase lo que pase. */
const MAX_AGE_MS = 48 * 3600 * 1000;
/** Respuestas por tick: evita ráfagas (LinkedIn mira el comportamiento, no solo el texto). */
const PER_TICK_CAP = 3;
const DEFAULT_DAILY_CAP = 40;
// LI-CUOTA-1 · 300 s (antes 180): LinkedIn agotó el límite DIARIO de la API (code 101) con ~11 llamadas
// por tick y 480 ticks al día. Ver también «urns» más abajo: solo se pide lo que un flujo escucha.
// POLL-CONFIG-1 · 1 h de fábrica (el cupo diario de la API ya se agotó a 180/300 s); el dueño lo cambia en
// Conexiones → LinkedIn Página (linkedin.autoreply.pollSec).
const DEFAULT_POLL_SEC = 3600;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Respuestas ya enviadas hoy en este workspace (se resetea al cambiar de día). */
function repliesToday(): number {
  if (get("linkedin.autoreply.day") !== today()) return 0;
  return Number(get("linkedin.autoreply.count") || 0);
}

async function bumpRepliesToday(n: number): Promise<void> {
  const base = repliesToday();
  await set("linkedin.autoreply.day", today());
  await set("linkedin.autoreply.count", String(base + n));
}

/** Al ENCENDER el interruptor: la marca de agua se pone a "ahora" para no
 *  contestar el histórico. Lo llama el endpoint del panel. */
export async function linkedinAutoreplyArm(): Promise<void> {
  await set("linkedin.autoreply.since", String(Date.now()));
}

/** Un ciclo de poll del workspace activo. Exportado para poder forzarlo sin esperar al timer. */
export async function linkedinAutoreplyTick(): Promise<void> {
  return tickForCurrentWorkspace();
}

async function tickForCurrentWorkspace(): Promise<void> {
  if (get("linkedin.autoreply.enabled") !== "true") return;
  if (!linkedinCmConnected()) return;

  // ¿Hay algo que hacer? Sin disparadores de LinkedIn activos no gastamos cuota/API.
  // Los flujos con disparador li_comment (Flow Studio) cuentan igual que los Disparadores.
  const autos = (await listAutomations()).filter((a) => a.platform === "linkedin" && a.enabled);
  const liFlows = (await listFlows()).filter((f) => f.enabled && f.trigger?.type === "li_comment");
  if (!autos.length && !liFlows.length) return;

  const orgs = linkedinCmOrgsList();
  if (!orgs.length) return;

  // Ritmo del poll (independiente del tick de 60s del scheduler).
  const pollMs = Math.max(60, Number(get("linkedin.autoreply.pollSec")) || DEFAULT_POLL_SEC) * 1000;
  const last = Number(get("linkedin.autoreply.lastPoll") || 0);
  if (Date.now() - last < pollMs) return;
  await set("linkedin.autoreply.lastPoll", String(Date.now()));

  // Marca de agua: primera vez → solo comentarios de aquí en adelante.
  let since = Number(get("linkedin.autoreply.since") || 0);
  if (!since) {
    await set("linkedin.autoreply.since", String(Date.now()));
    return;
  }
  // Freno 3: aunque la marca de agua sea antigua, nunca tocamos nada de hace >48h.
  since = Math.max(since, Date.now() - MAX_AGE_MS);

  // TOPE-CERO-1 · Mismo arreglo que en youtube-comments.ts: `Number(x) || DEFAULT`
  // convertía un tope explícito de 0 (el dueño quiere FRENAR al bot) en el valor por
  // defecto, porque Number("0") es falsy. Solo se cae al defecto si no hay ajuste.
  const _capRaw = get("linkedin.autoreply.dailyCap");
  const _capNum = Number(_capRaw);
  const dailyCap =
    _capRaw !== "" && Number.isFinite(_capNum)
      ? Math.max(0, Math.min(200, Math.floor(_capNum)))
      : DEFAULT_DAILY_CAP;
  let sentThisTick = 0;

  // LI-CUOTA-1 · de qué posts hay que leer comentarios: solo los que un flujo/automatización escucha.
  // Con un post concreto son 1 llamada por post y tick, no «lista de posts + 10 posts». Si alguna regla
  // escucha «cualquier publicación», se miran las 5 últimas.
  const ids = [
    ...liFlows.map((f) => String((f.trigger as { mediaId?: string }).mediaId || "any")),
    ...autos.map((a) => String(a.mediaId || "any")),
  ];
  const concretos = [...new Set(ids.filter((m) => m && m !== "any"))];
  const urns = ids.some((m) => !m || m === "any") ? undefined : concretos.slice(0, 10);

  for (const org of orgs) {
    if (sentThisTick >= PER_TICK_CAP) break;
    if (repliesToday() >= dailyCap) {
      console.warn(`[li-comments] tope diario alcanzado (${dailyCap}); no se responde más hoy.`);
      break;
    }
    const selfUrn = `urn:li:organization:${org.orgId}`;

    let comments;
    try {
      comments = await listLinkedInComments(org.orgId, urns ? Math.max(1, urns.length) : 5, 10, { urns });
    } catch (e) {
      console.error(`[li-comments] leyendo comentarios de "${org.name}":`, (e as Error).message);
      continue;
    }

    // Del más antiguo al más nuevo: si topamos el cap, dejamos sin responder los
    // más recientes (que seguirán ahí en el próximo tick), no los más viejos.
    const fresh = comments
      .filter((c) => c.createdAt > since)
      .filter((c) => c.authorUrn !== selfUrn) // freno 5: no respondernos a nosotros
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const c of fresh) {
      if (sentThisTick >= PER_TICK_CAP || repliesToday() >= dailyCap) break;
      // Freno 4: dedup. Reclamamos el comentario aunque luego no case ninguna
      // automatización — "visto" es "visto", y así no lo re-evaluamos cada tick.
      const first = await dbClaimOnce("__lipoll", c.id);
      if (!first) continue;
      // NOTIFICACIONES-1 · comentario (una vez por comentario: el claim de arriba)
      notificar({ kind: "comentario", title: "Comentario nuevo en LinkedIn" + (c.author ? " de " + c.author : ""), body: "«" + String(c.text || "").replace(/\s+/g, " ").trim().slice(0, 140) + "»", channel: "linkedin", accountName: org.name, link: /^urn:li:(activity|share|ugcPost):/.test(c.objectUrn || "") ? "https://www.linkedin.com/feed/update/" + c.objectUrn + "/?commentUrn=" + encodeURIComponent(c.id) : null, dedup: "comentario:linkedin:" + c.id });

      try {
        // 1) Disparadores (respuesta de un paso). Si uno responde, el flujo NO entra:
        //    dos respuestas públicas al mismo comentario son spam (mismo criterio que YouTube).
        let done = await handleCommentEvent({
          platform: "linkedin",
          commentId: c.id,          // URN del comentario (parentComment al responder)
          text: c.text,
          username: c.author,
          userId: c.authorUrn || c.id,
          mediaId: c.objectUrn,     // URN del post/share (el `object`)
          liOrgId: org.orgId,
        });
        // 2) Solo si NADIE respondió: flujos con disparador li_comment.
        if (done === 0) {
          done = await triggerLiFlows(c.authorUrn, c.text, c.id, c.objectUrn, org.orgId, c.author);
        }
        if (done > 0) {
          sentThisTick += done;
          await bumpRepliesToday(done);
        }
      } catch (e) {
        console.error(`[li-comments] procesando ${c.id}:`, (e as Error).message);
      }
    }
  }
}

// Multi-tenant: las settings del auto-reply son per-workspace. Iteramos workspaces
// y cada uno corre en su scope.
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
      await runWithWorkspace(ws.id, tickForCurrentWorkspace);
    } catch (e) {
      console.error(`[li-comments] tick ws=${ws.id}:`, (e as Error).message);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startLinkedinCommentPoller(): void {
  if (timer) return;
  timer = setInterval(tick, 60_000);
  console.log("[li-comments] poller de comentarios de LinkedIn activo (tick 60s)");
}
