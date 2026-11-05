/**
 * Red de seguridad de comentarios de Facebook (sondeo por API).
 *
 * POR QUÉ
 * Los comentarios de una publicación de Página llegan por webhook (campo `feed` del
 * objeto `page` de la APP). Si ese campo no está suscrito en el panel de Meta —o Meta se
 * deja un evento— el comentario existe en Facebook pero el panel no se entera, y el flujo
 * `fb_comment` nunca entra: sin error y sin log. Ya pasó (oct-2026: la app solo tenía
 * leadgen/messages/messaging_postbacks en `page`).
 *
 * QUÉ HACE
 * Cada pocos minutos repasa, por API, los comentarios recientes de las publicaciones que
 * miran los flujos/disparadores de Facebook y rescata los que el webhook no entregó. Es
 * el MISMO barrido que el botón «Recuperar caídos» (backfillFbCommentDrops), no un motor
 * nuevo: el dedup (`_fb_comment`) garantiza que un comentario se atiende UNA vez, llegue
 * antes el webhook o el sondeo; y nunca responde a la propia Página.
 *
 * FRENOS
 *   · Sin flujo/disparador de Facebook activo → no se llama a Meta (el barrido sale solo).
 *   · App limitada por Meta (#4/#17/#32/#613) → pausa (igGraphPaused): bastante ha costado
 *     recuperar la cuota como para gastarla en esto.
 *   · Ventana corta (2 h) y pocas publicaciones por vuelta: es una red, no el camino normal.
 *   · Se apaga con el ajuste `facebook.safetynet.enabled = "false"`.
 */
import { get, set } from "./settings.js";
import { runWithWorkspace, listWorkspacesCached } from "./workspace.js";
import { backfillFbCommentDrops } from "./automations.js";
import { igGraphPaused } from "./instagram.js";
import { recordWebhook } from "./webhookDebug.js";

/** Cada cuánto se mira (el timer corre cada minuto; el ritmo real lo marca este valor). */
const DEFAULT_POLL_SEC = 600;
/** Hasta dónde mira hacia atrás: un webhook perdido se nota en minutos, no en días. */
const WINDOW_HOURS = 2;
/** Publicaciones por vuelta: cada una es una lectura a Graph. */
const MAX_POSTS = 8;

/** Un ciclo del workspace activo. Exportado para poder probarlo sin esperar al timer. */
export async function facebookSafetyNetTick(): Promise<void> {
  if (get("facebook.safetynet.enabled") === "false") return;
  if (igGraphPaused()) return;

  const pollMs = Math.max(120, Number(get("facebook.safetynet.pollSec")) || DEFAULT_POLL_SEC) * 1000;
  const last = Number(get("facebook.safetynet.lastPoll") || 0);
  if (Date.now() - last < pollMs) return;
  await set("facebook.safetynet.lastPoll", String(Date.now()));

  const rep = await backfillFbCommentDrops({ sinceHours: WINDOW_HOURS, dryRun: false, maxPosts: MAX_POSTS });
  if (rep.dropped > 0 || rep.errors.length) {
    const note =
      "🛟 sondeo de seguridad: " + rep.dropped + " comentario(s) sin webhook, " + rep.triggered + " rescatado(s)" +
      (rep.errors.length ? " · errores: " + rep.errors.slice(0, 2).join(" | ") : "") +
      (rep.dropped > 0 ? " — revisa que la app tenga suscrito el campo «feed» del objeto «page» en Meta" : "");
    recordWebhook("facebook", note);
    console.warn("[fb-comments] " + note);
  }
}

// Multi-tenant: los ajustes son per-workspace; se recorre cada uno en su scope.
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
      await runWithWorkspace(ws.id, facebookSafetyNetTick);
    } catch (e) {
      console.error(`[fb-comments] tick ws=${ws.id}:`, (e as Error).message);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startFacebookCommentSafetyNet(): void {
  if (timer) return;
  timer = setInterval(tick, 60_000);
  console.log("[fb-comments] red de seguridad de comentarios de Facebook activa (cada " + DEFAULT_POLL_SEC / 60 + " min)");
}
