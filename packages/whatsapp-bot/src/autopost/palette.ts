/**
 * Extracción de paleta desde una imagen de referencia (data URL / buffer).
 *
 * Determinista (sin IA): decodifica la imagen con @napi-rs/canvas, la reduce a una
 * miniatura y agrupa los colores en buckets ponderados por saturación. Devuelve un
 * color PRIMARIO (el dominante vivo) y un ACENTO (el dominante de tono distinto).
 *
 * Se usa para que, al adjuntar imágenes de referencia, el diseño del carrusel
 * (plantillas Open Design) tome la paleta de esas imágenes — pase lo que pase con
 * la visión del modelo. Si no hay color aprovechable, devuelve null y se usa el
 * color de marca por defecto.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";

function toHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function hue(r: number, g: number, b: number): number {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return h;
}
function hueDiff(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 360 - d);
}

interface Bucket { r: number; g: number; b: number; w: number; }

/** Paleta {primary, accent} de una imagen (data URL o base64). null si no hay color. */
export async function paletteFromImage(dataUrl: string): Promise<{ primary: string; accent: string } | null> {
  try {
    const comma = dataUrl.indexOf(",");
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const buf = Buffer.from(b64, "base64");
    const img = await loadImage(buf);
    const SW = 64;
    const sh = Math.max(1, Math.round((SW * (img.height || 1)) / (img.width || 1))) || 64;
    const canvas = createCanvas(SW, sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, SW, sh);
    const data = ctx.getImageData(0, 0, SW, sh).data;

    const buckets = new Map<number, Bucket>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;
      const sum = r + g + b;
      if (sum > 735) continue; // casi blanco (fondo)
      if (sum < 45) continue;  // casi negro
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const weight = 1 + sat * 3.5; // prioriza colores vivos sobre grises
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); // 5 bits/canal
      const e = buckets.get(key) || { r: 0, g: 0, b: 0, w: 0 };
      e.r += r * weight; e.g += g * weight; e.b += b * weight; e.w += weight;
      buckets.set(key, e);
    }
    if (!buckets.size) return null;
    const ranked = [...buckets.values()]
      .map((e) => ({ r: e.r / e.w, g: e.g / e.w, b: e.b / e.w, score: e.w }))
      .sort((x, y) => y.score - x.score);

    const primary = ranked[0];
    const ph = hue(primary.r, primary.g, primary.b);
    // Acento = primer bucket dominante con tono claramente distinto (>40°).
    const accent = ranked.slice(1).find((x) => hueDiff(hue(x.r, x.g, x.b), ph) > 40);
    return {
      primary: toHex(primary.r, primary.g, primary.b),
      accent: accent ? toHex(accent.r, accent.g, accent.b) : "",
    };
  } catch {
    return null;
  }
}
