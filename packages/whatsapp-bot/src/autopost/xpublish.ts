/**
 * X (Twitter) se publica por Upload-Post: Zernio no deja conectar X en el plan gratis de las
 * cuentas que ya tenemos, y Upload-Post sí. Es el ÚNICO uso de Upload-Post que queda en el
 * publicador: el resto de redes va por Zernio (ver zernio.ts) e Instagram por Meta.
 * La cuenta sale del almacén multi-cuenta (accounts.ts, «Conexiones»).
 */
import { getActiveUpAccount } from "./accounts.js";
import { uploadPostPublishUrls, type PerPlatform, type UploadResult } from "./upload.js";

/** Límite de X: 4 imágenes por tuit (un vídeo va solo). Si hay más, se publica un hilo. */
const X_MAX_IMAGES = 4;

export async function publishX(opts: {
  caption: string;
  mediaUrls: string[];
  mediaType: "image" | "video";
  /** Texto propio de los tuits 2..n del hilo; el que falte usa el de por defecto. */
  hilo?: string[];
}): Promise<{ result: PerPlatform; warnings: string[] }> {
  const acc = await getActiveUpAccount();
  if (!acc || !acc.token || !acc.user) {
    return {
      result: { platform: "x", ok: false, message: "X no está configurado: añade la cuenta de publicación de X en Conexiones" },
      warnings: [],
    };
  }
  const warnings: string[] = [];
  let urls = opts.mediaUrls.filter((u) => /^https?:\/\//.test(u));
  if (opts.mediaType === "video") urls = urls.slice(0, 1);

  // HILO-X-1 · más de 4 imágenes = hilo: 4 por tuit, cada uno responde al anterior, hasta
  // sacarlas todas. El texto va en el primero; los siguientes llevan el que haya dado quien
  // publica (opts.hilo) o, si no, «2/3 · Sigue 👇» y un cierre.
  const grupos: string[][] = [];
  if (opts.mediaType === "image" && urls.length > X_MAX_IMAGES) {
    for (let i = 0; i < urls.length; i += X_MAX_IMAGES) grupos.push(urls.slice(i, i + X_MAX_IMAGES));
  } else grupos.push(urls);
  const total = grupos.length;

  let previo = "";
  for (let i = 0; i < total; i++) {
    let r: UploadResult;
    try {
      r = await uploadPostPublishUrls({
        token: acc.token, user: acc.user, platforms: ["x"],
        caption: i === 0 ? opts.caption : textoTuit(i, total, opts.hilo),
        mediaUrls: grupos[i], mediaType: opts.mediaType, replyToId: previo || undefined,
      });
    } catch (e) {
      const motivo = (e as Error).message.slice(0, 160);
      return { result: { platform: "x", ok: false, message: total === 1 ? motivo : aMedias(i, total, motivo) }, warnings };
    }
    const own = r.perPlatform.find((p) => p.platform === "x" || p.platform === "twitter");
    const ok = own ? own.ok : r.ok;
    if (!ok) {
      const motivo = (own && own.message) || `HTTP ${r.status}${r.raw ? " · " + r.raw.slice(0, 140) : ""}`;
      return { result: { platform: "x", ok: false, message: total === 1 ? motivo : aMedias(i, total, motivo) }, warnings: warnings.concat(r.warnings) };
    }
    if (i < total - 1) {
      previo = (own && own.ref) || "";
      if (!previo) {
        return {
          result: { platform: "x", ok: false, message: aMedias(i + 1, total, "X no devolvió el identificador del tuit y no se puede encadenar el siguiente.") },
          warnings: warnings.concat(r.warnings),
        };
      }
      await new Promise((res) => setTimeout(res, 2000)); // deja que X asiente el tuit antes de responderle
    } else {
      warnings.push(...r.warnings);
      if (total > 1) warnings.push(`Hilo de ${total} tuits con ${urls.length} imágenes (4 por tuit).`);
      const msg = total === 1 ? (own && own.message) || "ok" : `ok · hilo de ${total} tuits (${urls.length} imágenes)`;
      return { result: { platform: "x", ok: true, message: msg }, warnings };
    }
  }
  return { result: { platform: "x", ok: false, message: "No había nada que publicar en X" }, warnings };
}

/** Texto del tuit `i` (0-based, ≥1): el propio si lo dieron; si no, contador + continuación o cierre. */
function textoTuit(i: number, total: number, hilo?: string[]): string {
  const propio = (hilo?.[i - 1] || "").trim();
  if (propio) return propio.slice(0, 280);
  const n = `${i + 1}/${total}`;
  return i === total - 1 ? `${n} · Y hasta aquí. Guárdalo para volver a él 🔖` : `${n} · Sigue 👇`;
}

/** Hilo cortado a medias: dice cuántos tuits salieron para no republicar los primeros. */
function aMedias(salidos: number, total: number, motivo: string): string {
  return `Hilo a medias: salieron ${salidos} de ${total} tuits. ${motivo}`;
}
