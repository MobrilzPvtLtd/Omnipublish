/**
 * SHORT-IMAGENES-1 · Convierte una foto o un carrusel en un vídeo vertical (Short).
 *
 * YouTube solo admite vídeo por API: ni Shorts con fotos ni publicaciones de imagen.
 * Para que «Foto» y «Carrusel» también salgan en YouTube, aquí se monta un MP4
 * 1080×1920 con cada imagen como diapositiva:
 *   · cada imagen se encaja entera (sin recortar) sobre un fondo desenfocado de ella misma;
 *   · un zoom suave mientras se ve y un fundido entre diapositivas;
 *   · pista de audio en silencio (algunos reproductores tratan peor un vídeo sin audio).
 * SHORT-DURACION-MUSICA-1 · la duración total la elige quien publica (por defecto 60 s en un
 * carrusel: a 3 s por imagen no daba tiempo a leerlas) y se reparte entre las imágenes; y puede
 * llevar música: se repite si es corta, se corta a la duración y se apaga al final.
 *
 * La composición de cada fotograma la hace @napi-rs/canvas (lee JPG/PNG/WebP/GIF) y
 * ffmpeg (paquete ffmpeg-static, o el ffmpeg del sistema) solo anima y codifica.
 * Un único render a la vez: el servidor es pequeño y esto usa CPU unos segundos.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getAsset } from "../page-builder.js";
import { fetchConReintentos } from "../net-retry.js";

// YOUTUBE-NORMAL-1 · vertical (Short) o horizontal 16:9 (vídeo normal de YouTube). Lo demás es igual.
export type FormatoVideo = "vertical" | "horizontal";
const DIM = {
  vertical: { W: 1080, H: 1920 },
  horizontal: { W: 1920, H: 1080 },
} as const;
const FPS = 30;
/** Duración del vídeo si quien publica no elige otra. */
const SEG_SOLA = 15;
const SEG_CARRUSEL_TOTAL = 60;
/** Duraciones admitidas: un Short de YouTube no puede pasar de 3 minutos. */
export const SHORT_SEG_MIN = 5;
export const SHORT_SEG_MAX = 180;
const FUNDIDO = 0.5;
/** La música se apaga en estos últimos segundos. */
const APAGADO = 2;
/** Zoom total al final de cada diapositiva (5 %). */
const ZOOM = 0.05;
const MAX_IMAGENES = 20;
const MAX_BYTES_IMAGEN = 15 * 1024 * 1024;
const MAX_BYTES_MUSICA = 25 * 1024 * 1024;

/** Ruta del ejecutable: FFMPEG_PATH › ffmpeg-static › «ffmpeg» del PATH. */
export function rutaFfmpeg(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const p = createRequire(import.meta.url)("ffmpeg-static") as unknown;
    if (typeof p === "string" && p) return p;
  } catch { /* sin el paquete: se usa el del sistema */ }
  return "ffmpeg";
}

/** Duración total del vídeo para N imágenes: la elegida (acotada) o la de por defecto. */
export function duracionShort(n: number, segundos?: number): number {
  const s = Number(segundos);
  if (Number.isFinite(s) && s > 0) return Math.min(SHORT_SEG_MAX, Math.max(SHORT_SEG_MIN, Math.round(s)));
  return n <= 1 ? SEG_SOLA : SEG_CARRUSEL_TOTAL;
}

/** Segundos que se ve cada imagen (los fundidos se solapan) para llenar la duración total. */
export function segundosPorImagen(n: number, total: number): number {
  if (n <= 1) return total;
  return (total + (n - 1) * FUNDIDO) / n;
}

/** MP3, M4A/AAC, WAV, OGG u FLAC, mirando la firma del fichero. */
export function esAudio(b: Buffer): boolean {
  if (b.length < 12) return false;
  if (b.subarray(0, 3).toString("latin1") === "ID3") return true;
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true; // trama MPEG (MP3 sin etiqueta) o ADTS (AAC)
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WAVE") return true;
  if (b.subarray(0, 4).toString("latin1") === "OggS" || b.subarray(0, 4).toString("latin1") === "fLaC") return true;
  return b.subarray(4, 8).toString("latin1") === "ftyp"; // M4A (y el audio de un MP4)
}

function tipoPorFirma(b: Buffer): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image";
  if (b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1"))) return "image";
  if (b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp") return "video";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video";
  return "";
}

/** Descarga un medio. Los subidos al propio panel (/a/<id>) se leen directamente de la BD. */
async function descargar(url: string, que = "una imagen", max = MAX_BYTES_IMAGEN): Promise<Buffer> {
  const propio = /\/a\/([0-9a-f-]{36})(?:[?#]|$)/i.exec(url);
  if (propio) {
    const a = await getAsset(propio[1]);
    if (a) return a.data;
  }
  if (!/^https?:\/\//i.test(url)) throw new Error(`No se encuentra ${que}: puede que se borrara`);
  const r = await fetchConReintentos(url, { signal: AbortSignal.timeout(que === "el vídeo" ? 180_000 : 30_000), redirect: "follow" });
  if (!r.ok) throw new Error(`No se pudo descargar ${que} (HTTP ${r.status})`);
  const tope = que === "una imagen" ? "Una de las imágenes pesa más de 15 MB"
    : que === "el vídeo" ? `El vídeo pesa más de ${Math.round(max / 1048576)} MB`
    : `La música pesa más de ${Math.round(max / 1048576)} MB`;
  const len = Number(r.headers.get("content-length") || 0);
  if (len > max) throw new Error(tope);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length > max) throw new Error(tope);
  return b;
}

// SHORT-C2PA-1 · las imágenes hechas con IA (ChatGPT, Adobe…) llevan la firma C2PA en un bloque PNG
// «caBX» justo tras la cabecera, y su manifiesto contiene «<svg» a unos 300 bytes del principio:
// @napi-rs/canvas mira el principio del archivo, la toma por un SVG y falla con «Invalid SVG image».
// Del PNG se quedan los bloques críticos y los opcionales que cambian cómo se ve; los metadatos sobran.
const PNG_FIRMA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_OPCIONALES_VISIBLES = new Set(["tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs"]);
function pngSinMetadatos(b: Buffer): Buffer {
  const partes = [b.subarray(0, 8)];
  let o = 8;
  while (o + 12 <= b.length) {
    const len = b.readUInt32BE(o);
    if (o + 12 + len > b.length) return b; // PNG cortado: que lo juzgue el decodificador tal cual
    const tipo = b.toString("latin1", o + 4, o + 8);
    if (tipo.charCodeAt(0) < 97 || PNG_OPCIONALES_VISIBLES.has(tipo)) partes.push(b.subarray(o, o + 12 + len));
    o += 12 + len;
    if (tipo === "IEND") break;
  }
  return Buffer.concat(partes);
}

/** Lee la imagen; si @napi-rs/canvas no puede, ffmpeg la pasa a un PNG simple y se reintenta. */
async function cargarImagen(buf: Buffer): Promise<Awaited<ReturnType<typeof loadImage>>> {
  const esPng = buf.length > 8 && buf.subarray(0, 8).equals(PNG_FIRMA);
  try {
    return await loadImage(esPng ? pngSinMetadatos(buf) : buf);
  } catch (e) {
    console.warn("[slideshow] imagen ilegible para canvas, se convierte con ffmpeg:", (e as Error).message);
    const dir = await mkdtemp(join(tmpdir(), "short-img-"));
    try {
      const ent = join(dir, "entrada"), sal = join(dir, "salida.png");
      await writeFile(ent, buf);
      await ejecutar(rutaFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-i", ent, "-frames:v", "1", sal], 30_000);
      return await loadImage(await readFile(sal));
    } catch {
      throw new Error("Una de las imágenes no se puede leer: vuelve a subirla en JPG o PNG");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// CALIDAD-SHORT-1 · el fotograma se compone un ZOOM más grande que el vídeo: el zoom suave solo
// REDUCE (de ese tamaño a 1080 de ancho), nunca amplía una imagen ya rasterizada (eso emborronaba
// las letras). Se guarda en PNG: el JPEG intermedio dejaba artefactos alrededor del texto.
function dimComp(f: FormatoVideo): { CW: number; CH: number } {
  const { W, H } = DIM[f];
  return { CW: Math.round((W * (1 + ZOOM)) / 2) * 2, CH: Math.round((H * (1 + ZOOM)) / 2) * 2 };
}

/** Fotograma CW×CH: la imagen entera, centrada, sobre su propio fondo desenfocado y oscurecido. */
async function componer(buf: Buffer, formato: FormatoVideo): Promise<Buffer> {
  const { CW, CH } = dimComp(formato);
  const img = await cargarImagen(buf);
  const iw = img.width, ih = img.height;
  if (!iw || !ih) throw new Error("Una de las imágenes no se puede leer");
  const W = CW, H = CH;
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  // Fondo: la imagen cubriendo el lienzo, reducida a un tamaño mínimo y vuelta a ampliar
  // (desenfoque barato y sin depender de filtros), y oscurecida para que destaque la imagen.
  const peq = createCanvas(W / 20, H / 20);
  const pctx = peq.getContext("2d");
  const cub = Math.max(peq.width / iw, peq.height / ih);
  pctx.drawImage(img, (peq.width - iw * cub) / 2, (peq.height - ih * cub) / 2, iw * cub, ih * cub);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(peq, 0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, 0, W, H);
  // Imagen entera, encajada sin recortar.
  const enc = Math.min(W / iw, H / ih);
  const dw = Math.round(iw * enc), dh = Math.round(ih * enc);
  ctx.drawImage(img, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh);
  return c.toBuffer("image/png");
}

function ejecutar(bin: string, args: string[], limiteMs: number, conMusica = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const pr = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    pr.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
    const t = setTimeout(() => { pr.kill("SIGKILL"); reject(new Error("Generar el vídeo ha tardado demasiado")); }, limiteMs);
    pr.on("error", (e) => {
      clearTimeout(t);
      reject(new Error((e as NodeJS.ErrnoException).code === "ENOENT" ? "Este servidor no tiene el conversor de vídeo instalado" : e.message));
    });
    pr.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else {
        console.error("[slideshow] ffmpeg", code, err);
        reject(new Error(conMusica && /matches no streams|Invalid data found|could not find codec|Error opening input/i.test(err)
          ? "No se pudo usar la música: sube un MP3, M4A, WAV u OGG con sonido"
          : "No se pudo generar el vídeo a partir de las imágenes"));
      }
    });
  });
}

let cola: Promise<unknown> = Promise.resolve();
/** Un render cada vez: los siguientes esperan su turno. */
function enCola<T>(fn: () => Promise<T>): Promise<T> {
  const r = cola.then(fn, fn);
  cola = r.catch(() => undefined);
  return r;
}

export interface OpcionesShort {
  /** Duración total en segundos (se acota a 5..180). Sin ella, la de por defecto. */
  segundos?: number;
  /** Música de fondo: URL pública o /a/<id> del panel. */
  musica?: string;
  /** «vertical» (Short, por defecto) o «horizontal» (vídeo normal 16:9). */
  formato?: FormatoVideo;
}

/**
 * Monta el MP4 vertical a partir de 1..20 imágenes (URLs públicas o /a/<id> del panel).
 * Lanza un error con un mensaje para el cliente si algo no cuadra (un vídeo en el
 * carrusel, una imagen que no se descarga, una música que no es audio…).
 */
export function imagenesAShort(urls: string[], opciones: OpcionesShort = {}): Promise<Buffer> {
  const lista = urls.filter(Boolean).slice(0, MAX_IMAGENES);
  if (!lista.length) return Promise.reject(new Error("No hay imágenes para montar el vídeo"));
  return enCola(async () => {
    const dir = await mkdtemp(join(tmpdir(), "short-"));
    try {
      const n = lista.length;
      const formato: FormatoVideo = opciones.formato === "horizontal" ? "horizontal" : "vertical";
      const { W, H } = DIM[formato];
      const total = duracionShort(n, opciones.segundos);
      const seg = segundosPorImagen(n, total);
      for (let i = 0; i < n; i++) {
        const buf = await descargar(lista[i]);
        const tipo = tipoPorFirma(buf);
        if (tipo === "video") throw new Error("Para YouTube el carrusel solo puede llevar imágenes: quita los vídeos o publica el vídeo como Short");
        if (!tipo) throw new Error("Uno de los archivos no es una imagen JPG, PNG, WebP o GIF");
        await writeFile(join(dir, `s${i}.png`), await componer(buf, formato));
      }
      let musica = "";
      if (opciones.musica) {
        // YT-SHORT-SIEMPRE-1 · la música es un adorno: si su servidor no contesta (incompetech.com daba
        // ETIMEDOUT desde Railway y tumbaba el Short entero, 14 oct) el vídeo sale igualmente, sin ella.
        // Un archivo que NO es audio sí sigue siendo un error del usuario.
        let buf: Buffer | null = null;
        try {
          buf = await descargar(opciones.musica, "la música", MAX_BYTES_MUSICA);
        } catch (e) {
          const m = (e as Error).message || "";
          if (/^fetch failed|No se pudo descargar|se borrara|timeout|aborted/i.test(m)) {
            console.warn("[slideshow] música no disponible, el vídeo sale sin ella:", m.slice(0, 160));
          } else throw e;
        }
        if (buf) {
          if (!esAudio(buf)) throw new Error("La música tiene que ser un archivo de audio: MP3, M4A, WAV u OGG");
          musica = join(dir, "musica");
          await writeFile(musica, buf);
        }
      }
      const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];
      for (let i = 0; i < n; i++) args.push("-loop", "1", "-framerate", String(FPS), "-t", seg.toFixed(3), "-i", join(dir, `s${i}.png`));
      // Con música se repite si es más corta que el vídeo; sin ella, silencio.
      if (musica) args.push("-stream_loop", "-1", "-i", musica);
      else args.push("-f", "lavfi", "-t", String(total), "-i", "anullsrc=r=44100:cl=stereo");
      // Cada diapositiva: zoom suave centrado (escala por fotograma + recorte al centro). El fotograma
      // mide CW (un ZOOM más) y se reduce de 1080 a CW con lanczos: nunca se amplía (CALIDAD-SHORT-1).
      const partes: string[] = [];
      for (let i = 0; i < n; i++) {
        partes.push(`[${i}:v]scale=w='trunc(${W}*(1+${ZOOM}*t/${seg.toFixed(3)})/2)*2':h=-2:eval=frame:flags=lanczos+accurate_rnd+full_chroma_int,crop=${W}:${H},setsar=1,fps=${FPS},format=yuv420p[v${i}]`);
      }
      // Fundido entre diapositivas.
      let ult = "v0";
      for (let i = 1; i < n; i++) {
        const sal = `x${i}`;
        partes.push(`[${ult}][v${i}]xfade=transition=fade:duration=${FUNDIDO}:offset=${(i * (seg - FUNDIDO)).toFixed(2)}[${sal}]`);
        ult = sal;
      }
      // Música: cortada a la duración, entrada suave y apagado en los últimos segundos.
      if (musica) {
        partes.push(`[${n}:a]atrim=0:${total},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,`
          + `afade=t=in:st=0:d=0.3,afade=t=out:st=${Math.max(0, total - APAGADO)}:d=${Math.min(APAGADO, total)}[aud]`);
      }
      const salida = join(dir, "short.mp4");
      args.push(
        "-filter_complex", partes.join(";"),
        "-map", `[${ult}]`, "-map", musica ? "[aud]" : `${n}:a`,
        // CALIDAD-SHORT-1 · antes veryfast + CRF 21 dejaba 100 s en ~0,3 Mbps (texto con bloques).
        // CRF 17 (calidad casi transparente) con techo de 12 Mbps para no pasar de lo que aceptan las redes.
        "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-profile:v", "high", "-level", "4.2",
        "-maxrate", "12M", "-bufsize", "24M", "-pix_fmt", "yuv420p", "-r", String(FPS),
        "-c:a", "aac", "-b:a", musica ? "192k" : "96k",
        "-t", String(total), "-movflags", "+faststart",
        salida,
      );
      // Un minuto de vídeo tarda bastante más que los 15 s de antes en un servidor pequeño.
      await ejecutar(rutaFfmpeg(), args, Math.max(180_000, total * 8_000), !!musica);
      return await readFile(salida);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

/**
 * YOUTUBE-NORMAL-1 · pasa un vídeo VERTICAL (un Reel) a un vídeo normal de YouTube 1920×1080: el
 * vídeo entero, centrado, sobre su propio fondo desenfocado y oscurecido. Conserva el audio.
 * Sin recortar nada: lo que se ve en el Reel se ve igual.
 */
export function videoAHorizontal(url: string): Promise<Buffer> {
  return enCola(async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt16x9-"));
    try {
      const buf = await descargar(url, "el vídeo", 500 * 1024 * 1024);
      if (tipoPorFirma(buf) !== "video") throw new Error("El medio no es un vídeo: no se puede pasar a formato normal de YouTube");
      const ent = join(dir, "entrada"), sal = join(dir, "normal.mp4");
      await writeFile(ent, buf);
      const { W, H } = DIM.horizontal;
      const fc = `[0:v]split[a][b];`
        + `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:6,eq=brightness=-0.15[bg];`
        + `[b]scale=-2:${H}:flags=lanczos,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${FPS},format=yuv420p[v]`;
      await ejecutar(rutaFfmpeg(), [
        "-hide_banner", "-loglevel", "error", "-y", "-i", ent,
        "-filter_complex", fc, "-map", "[v]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-level", "4.2",
        "-maxrate", "12M", "-bufsize", "24M", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", sal,
      ], 15 * 60_000);
      return await readFile(sal);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

/**
 * YT-FORMATO-REAL-1 · duración y tamaño reales de un vídeo (ffmpeg -i lee la cabecera, no baja el
 * archivo entero). null si no se puede medir: quien llame decide qué suponer.
 */
export function sondearVideo(url: string): Promise<{ seg: number; ancho: number; alto: number } | null> {
  return new Promise((resolve) => {
    let pr: ReturnType<typeof spawn>;
    try { pr = spawn(rutaFfmpeg(), ["-hide_banner", "-i", url], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }); }
    catch { resolve(null); return; }
    let err = "";
    pr.stderr?.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-20000); });
    const t = setTimeout(() => { pr.kill("SIGKILL"); resolve(null); }, 30_000);
    pr.on("error", () => { clearTimeout(t); resolve(null); });
    // Sin salida, ffmpeg termina con código 1: lo que importa es lo que cuenta por stderr.
    pr.on("close", () => {
      clearTimeout(t);
      const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      const v = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(err);
      if (!d || !v) { resolve(null); return; }
      let ancho = Number(v[1]), alto = Number(v[2]);
      // Un vídeo de móvil girado 90°/270° se ve con el ancho y el alto cambiados.
      if (/rotate\s*:\s*-?(90|270)|rotation of -?(90|270)/i.test(err)) [ancho, alto] = [alto, ancho];
      resolve({ seg: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]), ancho, alto });
    });
  });
}

/**
 * YT-FORMATO-REAL-1 · ¿lo trata YouTube como Short? Hasta 3 minutos (180 s) y vertical o cuadrado.
 * El panel aplica la misma regla en schYtEsShort (admin.ts): si se cambia aquí, cambiarla allí.
 */
export function esShortDeYoutube(m: { seg: number; ancho: number; alto: number }): boolean {
  return m.seg <= 180.5 && m.alto >= m.ancho;
}

// ADAPTAR-VIDEO-1 · máxima calidad en todas las redes: un Reel/vídeo vertical se publica TAL CUAL
// si ya es 9:16, H.264/AAC y ≥1080×1920 (sin recomprimir). Si no, se lleva a 1080×1920 sin recortar:
// 9:16 de menos resolución se escala; otra proporción (16:9, 1:1, 4:5) va entera sobre su fondo desenfocado.
export interface SondaVideo { w: number; h: number; vcodec: string; acodec: string; pix: string; rotado: boolean }

function sondearArchivo(ent: string): Promise<SondaVideo | null> {
  return new Promise((resolve) => {
    const pr = spawn(rutaFfmpeg(), ["-hide_banner", "-i", ent], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    pr.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-8000); });
    const t = setTimeout(() => { pr.kill("SIGKILL"); resolve(null); }, 30_000);
    pr.on("error", () => { clearTimeout(t); resolve(null); });
    pr.on("close", () => {
      clearTimeout(t);
      const v = /Video: (\w+)[^\n]*?, (yuv\w+|nv\d+|\w+)(?:\([^)]*\))?[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(err);
      if (!v) return resolve(null);
      const a = /Audio: (\w+)/.exec(err);
      let w = Number(v[3]), h = Number(v[4]);
      const rotado = /displaymatrix[^\n]*\n?[^\n]*rotation of -?(90|270)/i.test(err) || /rotate\s*:\s*(90|270)/i.test(err);
      if (rotado) [w, h] = [h, w];
      resolve({ w, h, vcodec: v[1], acodec: a ? a[1] : "", pix: v[2], rotado });
    });
  });
}

/** ¿Hay que tocar el vídeo para que salga en vertical con la máxima calidad? (puro, probado aparte) */
export function planVertical(s: SondaVideo): "tal-cual" | "escalar" | "encajar" {
  const prop = s.w / s.h, ideal = 1080 / 1920;
  if (Math.abs(prop - ideal) / ideal > 0.02) return "encajar";
  const ok = s.vcodec === "h264" && s.pix === "yuv420p" && !s.rotado && s.w >= 1080 && s.h >= 1920 && (s.acodec === "aac" || !s.acodec);
  return ok ? "tal-cual" : "escalar";
}

/** null = el original ya es óptimo (se publica sin recomprimir). */
export function videoAVertical(url: string): Promise<{ data: Buffer; plan: string } | null> {
  return enCola(async () => {
    const dir = await mkdtemp(join(tmpdir(), "vert-"));
    try {
      const buf = await descargar(url, "el vídeo", 500 * 1024 * 1024);
      if (tipoPorFirma(buf) !== "video") return null;
      const ent = join(dir, "entrada"), sal = join(dir, "vertical.mp4");
      await writeFile(ent, buf);
      const s = await sondearArchivo(ent);
      if (!s) return null;
      const plan = planVertical(s);
      if (plan === "tal-cual") return null;
      const { W, H } = DIM.vertical;
      const fc = plan === "escalar"
        ? `[0:v]scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p[v]`
        : `[0:v]split[a][b];`
          + `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:6,eq=brightness=-0.15[bg];`
          + `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]`;
      await ejecutar(rutaFfmpeg(), [
        "-hide_banner", "-loglevel", "error", "-y", "-i", ent,
        "-filter_complex", fc, "-map", "[v]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-profile:v", "high", "-level", "4.2",
        "-maxrate", "16M", "-bufsize", "32M", "-pix_fmt", "yuv420p",
        // El audio AAC ya bueno se copia sin recodificar; si no, AAC 192k a 48 kHz.
        ...(s.acodec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]),
        "-movflags", "+faststart", sal,
      ], 20 * 60_000);
      return { data: await readFile(sal), plan };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
