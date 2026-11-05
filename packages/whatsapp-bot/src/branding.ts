/**
 * Logo de marca. Si existe `assets/logo.png` (el PNG real del negocio),
 * se sirve ese raster en toda la app; si no, se cae al SVG aproximado.
 * Se lee una vez al arrancar y se cachea en memoria.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

let png: Buffer | null = null;
try {
  const p = fileURLToPath(new URL("../assets/logo.png", import.meta.url));
  if (existsSync(p)) png = readFileSync(p);
} catch {
  png = null;
}

/** PNG real de marca, o null si no se ha subido a assets/. */
export const LOGO_PNG: Buffer | null = png;

/** SVG de respaldo (recreación terracota) cuando no hay PNG. */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="256" fill="#c0603e"/><path d="M168 150 H372 L300 250 H110 Z" fill="#fff"/><path d="M168 280 H322 L250 392 V442 L208 396 L134 382 Z" fill="#fff"/></svg>`;

/** src a usar en <img>/<link>: el PNG si está, si no el SVG. */
// MARCA-EDITABLE-1 · con versión: /logo.png se sirve con caché pública de un día, y sin
// esto un cambio del fichero tardaba 24 h en verse (el owner seguía viendo el arte viejo).
export const LOGO_SRC = LOGO_PNG
  ? "/logo.png?v=" + createHash("sha1").update(LOGO_PNG).digest("hex").slice(0, 8)
  : "/favicon.svg";

// ============================================================
// OG / Twitter Card image (1200x630). Cargado una vez al boot.
// Si no existe, los meta tags caerán a /logo.png.
// ============================================================
let ogPng: Buffer | null = null;
try {
  const og = fileURLToPath(new URL("../assets/og.png", import.meta.url));
  if (existsSync(og)) ogPng = readFileSync(og);
} catch {
  ogPng = null;
}
export const OG_PNG: Buffer | null = ogPng;
export const OG_SRC = OG_PNG ? "/og.png" : LOGO_SRC;
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
