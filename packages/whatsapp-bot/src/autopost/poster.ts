/**
 * MINIATURA-VIDEO-1 · Portada (JPG pequeño) de un vídeo guardado en /a/:id.
 *
 * La cola del Programador no puede enseñar un vídeo como miniatura: un .mp4 no se
 * pinta como imagen y un <video> por fila obliga a bajar el archivo entero (50 MB+)
 * antes de ver un fotograma. Aquí ffmpeg saca un fotograma una sola vez y se guarda
 * en memoria; el navegador lo cachea como cualquier imagen.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAsset, getAssetPoster, setAssetPoster } from "../page-builder.js";
import { rutaFfmpeg } from "./slideshow.js";

const MAX_CACHE = 200;
const cache = new Map<string, Promise<Buffer | null>>();

function fotograma(bin: string, entrada: string, salida: string, segundo: number): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ["-y", "-loglevel", "error", ...(segundo > 0 ? ["-ss", String(segundo)] : []),
      "-i", entrada, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", salida];
    const pr = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    pr.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-1000); });
    const t = setTimeout(() => pr.kill("SIGKILL"), 30_000);
    pr.on("error", () => { clearTimeout(t); resolve(false); });
    pr.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) console.warn("[poster] ffmpeg", code, err);
      resolve(code === 0);
    });
  });
}

async function generar(id: string, tambienImagen = false): Promise<Buffer | null> {
  const r = await getAsset(id);
  const tipo = r ? String(r.asset.content_type) : "";
  if (!r || !(tipo.startsWith("video/") || (tambienImagen && tipo.startsWith("image/")))) return null;
  const dir = await mkdtemp(join(tmpdir(), "poster-"));
  try {
    const entrada = join(dir, "in"), salida = join(dir, "out.jpg");
    await writeFile(entrada, r.data);
    const bin = rutaFfmpeg();
    // Medio segundo evita el negro del primer fotograma; un vídeo más corto cae al 0.
    for (const s of [0.5, 0]) {
      if (await fotograma(bin, entrada, salida, s)) {
        const jpg = await readFile(salida).catch(() => null);
        if (jpg && jpg.length) return jpg;
      }
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** MEDIA-CADUCA-1 · miniatura (320 px) que se guarda al caducar un medio: vídeo o imagen. Sin caché. */
export function posterParaCaducar(id: string): Promise<Buffer | null> {
  return generar(id, true);
}

/** JPG de portada (320 px) del vídeo o la imagen `id`, o null si no es ninguno o ffmpeg no puede leerlo.
 *  POSTER-GUARDADO-1 · se saca UNA vez y se guarda en BD: la caché en memoria se perdía en cada
 *  despliegue y el Programador volvía a leer cada vídeo entero (50 MB+) y a lanzar ffmpeg por
 *  miniatura. Las imágenes también: antes daban 404 y el calendario bajaba el original completo. */
export function posterDeVideo(id: string): Promise<Buffer | null> {
  let p = cache.get(id);
  if (!p) {
    // MEDIA-CADUCA-1 · si el original ya caducó, la miniatura se sirve de la guardada en BD.
    p = getAssetPoster(id)
      .then(async (g) => {
        if (g) return g;
        const jpg = await generar(id, true);
        if (jpg) await setAssetPoster(id, jpg).catch((e) => console.warn("[poster] guardar", (e as Error).message));
        return jpg;
      })
      .catch((e) => { console.warn("[poster]", (e as Error).message); return null; });
    // Un fallo no se cachea: el siguiente intento puede salir bien.
    p.then((b) => { if (!b) cache.delete(id); });
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(id, p);
  }
  return p;
}
