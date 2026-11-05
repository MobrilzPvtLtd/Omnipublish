/**
 * FLUJO-AL-PUBLICAR-1 · «asigno un flujo a la publicación y se enciende solo cuando sale».
 *
 * En el Programador (o por MCP) una publicación lleva tags.flujos = [id de flujo yt_comment/ig_comment].
 * Un vídeo de YouTube no tiene id hasta que se publica (Zernio lo sube de forma asíncrona), así que el
 * flujo no se puede atar antes. Este tick, cada pocos minutos, recoge las publicaciones YA publicadas
 * con flujos sin activar, encuentra su vídeo / post, lo pone en el disparador del flujo (mediaId) y lo
 * ENCIENDE. Deja constancia en tags.flujosListos (por flujo) para no repetirlo y para enseñarlo.
 *
 *   YouTube   → el vídeo más reciente del canal del flujo (appliesTo) cuyo título coincide con la
 *               primera línea del texto y que salió después de la hora programada.
 *   Instagram → el id del post que devolvió Meta al publicar (queda en `result`).
 *   Facebook  → el post más antiguo de la Página con el mismo arranque de texto, salido tras la hora.
 *   Otros     → se marca como «no soportado»: el flujo queda apagado, nunca se enciende a ciegas.
 */
import { runWithWorkspace } from "./workspace.js";
import { listFlows, saveFlow, conflictoClaveMismoPost } from "./flows.js";
import { notificar } from "./notifications.js";
import { dbListPostsConFlujosPendientes, dbMarcarFlujosListos, type ScheduledPost } from "./db.js";
import { youtubeChannel, youtubeRecentVideos } from "./youtube.js";
import { listFbPosts, listFbAccounts } from "./facebook.js";
import { logActivity } from "./activity.js";

const ESPERA_MAX_MS = 6 * 60 * 60_000; // pasado esto sin encontrar el vídeo, se rinde y lo dice

const norm = (s: string) => s.toLowerCase().replace(/#shorts?\b/g, "").replace(/\s+/g, " ").trim();

/** Id del vídeo de YouTube de esta publicación (título = 1.ª línea del texto, salido tras la hora programada). */
export async function videoDeYoutube(p: ScheduledPost, canal: string | undefined,
  buscar: typeof youtubeRecentVideos = youtubeRecentVideos, canalDe: typeof youtubeChannel = youtubeChannel): Promise<string> {
  const titulo = norm(String(p.caption || "").split("\n")[0] || "");
  if (!titulo) return "";
  const ch = await canalDe(canal);
  if (!ch?.uploads) return "";
  const vids = await buscar(ch.uploads, 25, canal);
  const desde = p.scheduled_at - 15 * 60_000;
  const t60 = titulo.slice(0, 60);
  const hit = vids
    .filter((v) => v.id && Date.parse(v.published) >= desde)
    .filter((v) => { const n = norm(v.title); return n.startsWith(t60) || titulo.startsWith(n.slice(0, 60)); })
    .sort((a, b) => Date.parse(a.published) - Date.parse(b.published))[0];
  return hit?.id || "";
}

/** Id del post de Instagram que devolvió Meta al publicar (result = JSON por red). */
export function postDeInstagram(result: string): string {
  try {
    const r = JSON.parse(result) as { platform?: string; ok?: boolean; message?: string }[];
    const ig = Array.isArray(r) ? r.find((x) => x.platform === "instagram" && x.ok && /^\d{8,}$/.test(String(x.message || ""))) : null;
    return ig ? String(ig.message) : "";
  } catch { return ""; }
}

/** Id del post de Facebook de esta publicación: el más antiguo de la Página (o de todas) con el mismo
 *  arranque de texto y salido tras la hora programada. Mismo id que reciben los comentarios (pagina_post). */
export async function postDeFacebook(p: ScheduledPost, pagina: string | undefined,
  buscar: (pageId: string, limit: number) => Promise<{ id: string; caption: string; timestamp: string }[]> = listFbPosts,
  paginas: () => { pageId: string }[] = listFbAccounts): Promise<string> {
  const titulo = norm(String(p.caption || "").split("\n")[0] || "").slice(0, 40);
  if (!titulo) return "";
  const ids = pagina ? [pagina] : paginas().map((x) => x.pageId);
  const desde = p.scheduled_at - 15 * 60_000;
  const hits: { id: string; t: number }[] = [];
  for (const pid of ids.slice(0, 5)) {
    for (const x of await buscar(pid, 15)) {
      const t = Date.parse(x.timestamp);
      if (x.id && t >= desde && norm(x.caption).startsWith(titulo)) hits.push({ id: x.id, t });
    }
  }
  return hits.sort((a, b) => a.t - b.t)[0]?.id || "";
}

async function procesar(p: ScheduledPost): Promise<void> {
  const ids = Array.isArray(p.tags?.flujos) ? p.tags!.flujos! : [];
  if (!ids.length) return;
  const flows = await listFlows();
  const resultado: Record<string, unknown> = {};
  const vencida = Date.now() - p.scheduled_at > ESPERA_MAX_MS;
  let pendiente = false;
  for (const id of ids) {
    const f = flows.find((x) => x.id === id);
    if (!f) { resultado[id] = { error: "el flujo ya no existe" }; continue; }
    const tipo = String(f.trigger?.type || "");
    let mediaId = "";
    if (tipo === "yt_comment") mediaId = await videoDeYoutube(p, f.appliesTo ? String(f.appliesTo) : undefined);
    else if (tipo === "ig_comment") mediaId = postDeInstagram(p.result);
    else if (tipo === "fb_comment") mediaId = await postDeFacebook(p, f.appliesTo ? String(f.appliesTo) : undefined);
    else { resultado[id] = { error: "solo se asignan al publicar flujos de comentarios de YouTube, Instagram y Facebook" }; continue; }
    if (!mediaId) {
      const red = tipo === "yt_comment" ? "YouTube" : tipo === "fb_comment" ? "Facebook" : "Instagram";
      if (vencida) resultado[id] = { error: "no encontré la publicación en " + red + "; asigna el vídeo a mano en Flujos" };
      else pendiente = true;
      continue;
    }
    // KW-UNICA-POST-1 · si otro flujo activo ya usa esa clave en la publicación, NO se
    // enciende: se asigna pausado y se avisa en la campana.
    const nuevo = { ...f, trigger: { ...f.trigger, mediaId }, enabled: true } as typeof f;
    const choque = conflictoClaveMismoPost(nuevo, flows);
    if (choque) {
      await saveFlow({ ...nuevo, enabled: false });
      resultado[id] = { mediaId, nombre: f.name, error: choque };
      notificar({ kind: "flujo_conflicto", title: "Flujo «" + f.name + "» no activado", body: choque,
        link: "flow", dedup: "flujo_conflicto:" + id + ":" + mediaId, payload: { flowId: id, mediaId } });
      continue;
    }
    await saveFlow(nuevo);
    resultado[id] = { mediaId, nombre: f.name, activadoEn: Date.now() };
    await logActivity({ source: "app", level: "info",
      summary: "Flujo «" + f.name + "» asignado al vídeo publicado y encendido (FLUJO-AL-PUBLICAR-1)",
      payload: { postId: p.id, flowId: id, mediaId } });
  }
  if (pendiente) return; // el vídeo aún no está: lo reintenta el siguiente tick
  await dbMarcarFlujosListos(p.id, p.tenant_id || "default", resultado);
}

export async function flujosAlPublicarTick(): Promise<number> {
  const posts = await dbListPostsConFlujosPendientes();
  let n = 0;
  for (const p of posts) {
    try { await runWithWorkspace(p.tenant_id, () => procesar(p)); n++; }
    catch (e) { console.warn("[flujo-al-publicar]", p.id, (e as Error).message); }
  }
  return n;
}
