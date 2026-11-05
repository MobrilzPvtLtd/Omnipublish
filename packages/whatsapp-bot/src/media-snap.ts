/**
 * MEDIA-SNAP-1 · Copia guardada de la publicación a la que apunta un flujo.
 *
 * Problema: la miniatura y el texto del post salían de la galería que devuelve la red
 * (Instagram: solo los 30 últimos). Un flujo cuyo post tenía semanas, o una historia ya
 * caducada, se pintaba como «esta publicación» con la foto de la cuenta. Además las URL
 * de miniatura de Instagram caducan, así que guardar la URL no vale.
 *
 * Solución: al guardar el flujo se pide UNA vez ese post a la red (por su id, sin
 * galería), se reduce la imagen a 128 px y se incrusta como data: URI dentro del propio
 * flujo (`trigger.mediaSnap`). Después el panel pinta SIEMPRE esa copia si la red no
 * devuelve el post. Todo es best-effort: si algo falla, el flujo se guarda igual.
 */
import { spawn } from "node:child_process";
import { rutaFfmpeg } from "./autopost/slideshow.js";
import { getMedia, resolveAccount, runWithAccount } from "./instagram.js";
import { getFbPost } from "./facebook.js";
import { posterParaCaducar } from "./autopost/poster.js";
import { getLinkedInPost } from "./linkedinCommunity.js";
import type { Flow } from "./flows.js";
import { downloadPublic } from "./public-download.js";

type Trigger = Flow["trigger"];
export type MediaSnap = NonNullable<NonNullable<Trigger>["mediaSnap"]>;

const MAX_ORIGEN = 6 * 1024 * 1024;

/** Reduce una imagen (cualquier formato que lea ffmpeg) a JPEG de `ancho` px como data: URI.
 *  128 px (≈3-5 KB) basta para la tarjeta de un flujo (58 px a 2x) y mantiene ligera la lista de
 *  flujos, que viaja entera. "" si no se puede. */
export async function reducirJpeg(buf: Buffer, ancho = 128, q = 7): Promise<string> {
  if (!buf.length || buf.length > MAX_ORIGEN) return "";
  return await new Promise<string>((resolve) => {
    const p = spawn(
      rutaFfmpeg(),
      ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-vf", `scale=${ancho}:-2`, "-q:v", String(q), "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const out: Buffer[] = [];
    const t = setTimeout(() => { p.kill("SIGKILL"); resolve(""); }, 10_000);
    p.stdout.on("data", (c: Buffer) => out.push(c));
    p.on("error", () => { clearTimeout(t); resolve(""); });
    p.on("close", () => {
      clearTimeout(t);
      const jpg = Buffer.concat(out);
      resolve(jpg.length > 100 ? "data:image/jpeg;base64," + jpg.toString("base64") : "");
    });
    p.stdin.on("error", () => { /* ffmpeg cerró antes de leer todo */ });
    p.stdin.end(buf);
  });
}

async function miniatura(url: string): Promise<string> {
  if (!url) return "";
  // DESTINO-SSRF-2: solo Internet, con la IP fijada en cada salto y tope de bytes.
  const res = await downloadPublic(url, { timeoutMs: 8000, maxBytes: 25 * 1024 * 1024 });
  if (!res.ok) return "";
  return reducirJpeg(res.body);
}

/**
 * MINIATURA-CONGELADA-1 · miniatura del primer medio de una publicación del Programador, como
 * data: URI de 160 px. Se saca AL PUBLICAR, que es cuando el archivo seguro existe, y se guarda en
 * `tags.thumb`: el calendario la pinta aunque el original se borre o caduque después.
 *  - Medio propio (/a/<uuid>): el fotograma o la imagen salen de los bytes guardados.
 *  - Medio externo https que no sea vídeo: se descarga.
 * "" si no hay forma. Nunca lanza.
 */
export async function miniaturaDePost(mediaUrl: string): Promise<string> {
  try {
    const u = String(mediaUrl || "");
    const propio = /\/a\/([0-9a-f-]{36})(?:[?#.]|$)/i.exec(u);
    if (propio) {
      const jpg = await posterParaCaducar(propio[1]);
      return jpg ? await reducirJpeg(jpg, 160, 8) : "";
    }
    if (/^https:\/\//i.test(u) && !/\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(u)) {
      // DESTINO-SSRF-2: la URL la escribe el negocio; nunca hacia la red interna.
      const res = await downloadPublic(u, { timeoutMs: 8000, maxBytes: 25 * 1024 * 1024 });
      return res.ok ? await reducirJpeg(res.body, 160, 8) : "";
    }
  } catch (e) {
    console.warn("[miniatura-post] " + (e as Error).message);
  }
  return "";
}

/** Pide el post a su red y devuelve la copia, o null si no hay forma (borrado, caducado…). */
async function pedirSnap(t: NonNullable<Trigger>, appliesTo: string): Promise<MediaSnap | null> {
  const id = String(t.mediaId || "");
  let m: { id: string; caption: string; type: string; thumb: string; permalink: string; timestamp: string } | null = null;
  if (t.type === "ig_comment" || t.type === "ig_story") {
    const acct = appliesTo ? resolveAccount(appliesTo) : null;
    m = await (acct ? runWithAccount(acct, () => getMedia(id)) : getMedia(id));
  } else if (t.type === "fb_comment") {
    m = appliesTo ? await getFbPost(appliesTo, id) : null;
  } else if (t.type === "yt_comment") {
    // SNAP-SIN-GALERIA-2 · YouTube por oEmbed: público, sin clave y sin gastar cuota de la API.
    const r = await downloadPublic("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id), { timeoutMs: 8000, maxBytes: 64 * 1024 });
    if (r.ok) {
      const o = JSON.parse(r.body.toString("utf8")) as { title?: string; thumbnail_url?: string };
      m = { id, caption: String(o.title || "").slice(0, 120), type: "VIDEO", thumb: String(o.thumbnail_url || ""), permalink: "https://www.youtube.com/watch?v=" + id, timestamp: "" };
    }
  } else if (t.type === "li_comment") {
    const p = await getLinkedInPost(id);
    m = p ? { id: p.id, caption: p.caption.replace(/\s+/g, " ").slice(0, 120), type: "POST", thumb: p.thumb, permalink: "", timestamp: p.createdAt ? new Date(p.createdAt).toISOString() : "" } : null;
  }
  if (!m) return null;
  let thumb = "";
  try { thumb = await miniatura(m.thumb); } catch { /* sin miniatura: se guarda el texto */ }
  if (!thumb && !m.caption) return null;
  return {
    id,
    caption: m.caption,
    type: m.type,
    thumb,
    permalink: m.permalink,
    timestamp: m.timestamp,
    at: Date.now(),
  };
}

export function aplica(t: Trigger | undefined): boolean {
  return !!t && (t.type === "ig_comment" || t.type === "ig_story" || t.type === "fb_comment" || t.type === "li_comment" || t.type === "yt_comment")
    && !!t.mediaId && t.mediaId !== "any";
}

/**
 * Deja `f.trigger.mediaSnap` al día. Reglas:
 *  - sin post concreto → se quita la copia (no pinta nada);
 *  - misma publicación y ya hay copia con miniatura → no se toca ni se pide nada;
 *  - `previo` (el flujo tal como estaba guardado) aporta la copia si el cliente no la
 *    mandó: así una historia ya caducada no pierde su foto al volver a guardar;
 *  - si la red no devuelve el post, se conserva lo que hubiera (nunca se borra una copia).
 * Devuelve true si cambió algo. Nunca lanza.
 */
export async function asegurarSnap(f: Flow, previo?: Flow | null): Promise<boolean> {
  const t = f.trigger;
  if (!t) return false;
  if (!aplica(t)) {
    if (t.mediaSnap) { delete t.mediaSnap; return true; }
    return false;
  }
  const id = String(t.mediaId);
  const heredada = t.mediaSnap?.id === id ? t.mediaSnap
    : previo?.trigger?.mediaSnap?.id === id ? previo.trigger.mediaSnap : undefined;
  if (heredada?.thumb) {
    if (t.mediaSnap !== heredada) { t.mediaSnap = heredada; return true; }
    return false;
  }
  try {
    const nueva = await pedirSnap(t, String(f.appliesTo || ""));
    if (nueva) { t.mediaSnap = nueva; return true; }
  } catch (e) {
    console.warn("[media-snap] " + id + ": " + (e as Error).message);
  }
  if (heredada && t.mediaSnap !== heredada) { t.mediaSnap = heredada; return true; }
  // SNAP-SIN-GALERIA-2 · la red ya no da el post (historia caducada, publicación borrada, sin
  // acceso): se apunta como perdido para que el panel deje de pedir galerías por él en cada
  // visita. Se reintenta al volver a guardar el flujo o con el relleno.
  if (!heredada) { t.mediaSnap = { id, caption: "", type: "", thumb: "", permalink: "", timestamp: "", at: Date.now(), perdido: true }; return true; }
  // Copia de OTRO post (el flujo cambió de publicación y la red no respondió): fuera, para que
  // nunca se pinte la foto equivocada.
  if (t.mediaSnap && t.mediaSnap.id !== id) { delete t.mediaSnap; return true; }
  return false;
}
