/**
 * Render de las 7 slides (1080x1350) con @napi-rs/canvas. Port de render_pillow.py:
 * mismos tokens de color derivados de un hex de marca, mismo ritmo light/dark/
 * gradient y los 7 layouts (hero/context/insight/features/depth/proof/cta).
 * Sin navegador — pesa poco y despliega fiable en Railway.
 */
import { existsSync } from "node:fs";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import type { Slide } from "./generate.js";

const W = 1080;
const H = 1350;
const SCALE = W / 420;
const PAD_X = Math.round(36 * SCALE);
const MAXW = W - 2 * PAD_X;

// ---------- Fuentes (registro robusto multi-OS) ----------
let REG = "sans-serif";
let BOLD = "sans-serif";
let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  const regCandidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "C:/Windows/Fonts/arial.ttf",
  ];
  const boldCandidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
  ];
  for (const p of regCandidates) {
    if (existsSync(p) && GlobalFonts.registerFromPath(p, "BrandReg")) { REG = "BrandReg"; break; }
  }
  for (const p of boldCandidates) {
    if (existsSync(p) && GlobalFonts.registerFromPath(p, "BrandBold")) { BOLD = "BrandBold"; break; }
  }
  if (REG === "sans-serif" && BOLD !== "sans-serif") REG = BOLD;
  if (BOLD === "sans-serif" && REG !== "sans-serif") BOLD = REG;
  if (REG === "sans-serif") {
    try {
      (GlobalFonts as unknown as { loadSystemFonts?: () => void }).loadSystemFonts?.();
    } catch { /* ignore */ }
  }
}

// ---------- Color ----------
function hexToRgb(h: string): [number, number, number] {
  const s = h.replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, l, s];
}
function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  let r: number, g: number, b: number;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  return [r * 255, g * 255, b * 255];
}
function lighten(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex); const [h, l, s] = rgbToHls(r, g, b);
  return rgbToHex(...hlsToRgb(h, Math.min(1, l + (1 - l) * amt), s));
}
function darken(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex); const [h, l, s] = rgbToHls(r, g, b);
  return rgbToHex(...hlsToRgb(h, Math.max(0, l * (1 - amt)), s));
}
function hueFamily(hex: string): "warm" | "cool" | "neutral" {
  const [r, g, b] = hexToRgb(hex); const [h, , s] = rgbToHls(r, g, b);
  if (s < 0.12) return "neutral";
  const deg = h * 360;
  if (deg < 60 || deg >= 300) return "warm";
  return "cool";
}
interface Tokens {
  PRIMARY: string; LIGHT: string; DARK: string; LIGHT_BG: string;
  LIGHT_BORDER: string; DARK_BG: string; ACCENT: string;
  G_START: string; G_MID: string; G_END: string; FAMILY: string;
}
function deriveTokens(primary: string): Tokens {
  const family = hueFamily(primary);
  const brandLight = lighten(primary, 0.25);
  const brandDark = darken(primary, 0.35);
  let lightBg: string, lightBorder: string, darkBg: string, accent: string;
  if (family === "warm") { lightBg = "#F7F5F0"; lightBorder = "#EAE6DC"; darkBg = "#1A1918"; accent = lighten(primary, 0.15); }
  else if (family === "cool") { lightBg = "#F4F5F7"; lightBorder = "#E1E4EA"; darkBg = "#0F172A"; accent = lighten(primary, 0.15); }
  else { lightBg = "#F5F4EE"; lightBorder = "#E6E4DB"; darkBg = "#0D0D10"; accent = "#D4A574"; }
  const mid = family === "neutral" ? "#2A2A30" : primary;
  return {
    PRIMARY: primary, LIGHT: brandLight, DARK: brandDark, LIGHT_BG: lightBg,
    LIGHT_BORDER: lightBorder, DARK_BG: darkBg, ACCENT: accent,
    G_START: brandDark, G_MID: mid, G_END: accent, FAMILY: family,
  };
}
function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

// ---------- Helpers de dibujo ----------
function setFont(ctx: SKRSContext2D, px: number, bold = false): number {
  const sized = Math.round(px * SCALE);
  ctx.font = `${sized}px ${bold ? BOLD : REG}`;
  return sized;
}
function wrap(ctx: SKRSContext2D, text: string, maxW: number): string[] {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width <= maxW) cur = test;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}
function drawLines(
  ctx: SKRSContext2D, text: string, x: number, y: number,
  px: number, bold: boolean, color: string, maxW: number, mult = 1.2,
): number {
  setFont(ctx, px, bold);
  ctx.fillStyle = color;
  const lines = wrap(ctx, text, maxW);
  const lh = Math.round(px * SCALE * mult);
  lines.forEach((ln, i) => ctx.fillText(ln, x, y + i * lh));
  return y + lines.length * lh;
}
function drawTag(ctx: SKRSContext2D, text: string, x: number, y: number, color: string): number {
  setFont(ctx, 10, true);
  ctx.fillStyle = color;
  const ls = Math.round(2 * SCALE);
  let cx = x;
  for (const ch of (text || "").toUpperCase()) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + ls;
  }
  return y + Math.round((10 + 20) * SCALE);
}
function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function progressBar(ctx: SKRSContext2D, idx: number, total: number, variant: "light" | "dark", tok: Tokens): void {
  const y = H - Math.round(36 * SCALE);
  const barH = Math.max(3, Math.round(3 * SCALE));
  const barX = PAD_X;
  const barW = W - PAD_X - Math.round(60 * SCALE);
  const track = variant === "light" ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.12)";
  const fill = variant === "light" ? tok.PRIMARY : "#FFFFFF";
  const label = variant === "light" ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.45)";
  ctx.fillStyle = track;
  roundRect(ctx, barX, y, barW, barH, barH / 2); ctx.fill();
  ctx.fillStyle = fill;
  roundRect(ctx, barX, y, Math.round(barW * ((idx + 1) / total)), barH, barH / 2); ctx.fill();
  const lbl = `${idx + 1}/${total}`;
  const sz = setFont(ctx, 11, true);
  ctx.fillStyle = label;
  const lw = ctx.measureText(lbl).width;
  ctx.fillText(lbl, W - PAD_X - lw, y - Math.round(6 * SCALE) + (barH - sz) / 2);
}
function swipeArrow(ctx: SKRSContext2D, variant: "light" | "dark"): void {
  const aw = Math.round(48 * SCALE);
  const grad = ctx.createLinearGradient(W - aw, 0, W, 0);
  const tint = variant === "light" ? "0,0,0" : "255,255,255";
  grad.addColorStop(0, `rgba(${tint},0)`);
  grad.addColorStop(1, `rgba(${tint},${variant === "light" ? 0.06 : 0.08})`);
  ctx.fillStyle = grad;
  ctx.fillRect(W - aw, 0, aw, H);
  const cx = W - aw / 2, cy = H / 2;
  const size = Math.round(12 * SCALE);
  ctx.strokeStyle = `rgba(${tint},${variant === "light" ? 0.28 : 0.35})`;
  ctx.lineWidth = Math.max(4, Math.round(2.5 * SCALE));
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - size / 2, cy - size);
  ctx.lineTo(cx + size / 2, cy);
  ctx.lineTo(cx - size / 2, cy + size);
  ctx.stroke();
}
function gradientBg(ctx: SKRSContext2D, tok: Tokens): void {
  const g = ctx.createLinearGradient(W, 0, 0, H); // ~165°
  g.addColorStop(0, tok.G_START);
  g.addColorStop(0.5, tok.G_MID);
  g.addColorStop(1, tok.G_END);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// ---------- Renderers de slide ----------
function base(): { ctx: SKRSContext2D; done: () => Buffer } {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  return { ctx, done: () => canvas.toBuffer("image/png") };
}

function renderHero(s: Slide, idx: number, total: number, tok: Tokens, last: boolean): Buffer {
  const { ctx, done } = base();
  ctx.fillStyle = tok.LIGHT_BG; ctx.fillRect(0, 0, W, H);
  let y = Math.round(180 * SCALE);
  y = drawTag(ctx, s.tag, PAD_X, y, tok.PRIMARY);
  drawLines(ctx, s.heading, PAD_X, y, 34, true, tok.DARK, MAXW, 1.12);
  progressBar(ctx, idx, total, "light", tok);
  if (!last) swipeArrow(ctx, "light");
  return done();
}
function renderDark(s: Slide, idx: number, total: number, tok: Tokens, last: boolean): Buffer {
  const { ctx, done } = base();
  ctx.fillStyle = tok.DARK_BG; ctx.fillRect(0, 0, W, H);
  let y = Math.round(180 * SCALE);
  y = drawTag(ctx, s.tag, PAD_X, y, tok.ACCENT);
  y = drawLines(ctx, s.heading, PAD_X, y, 28, true, "#F5F4EE", MAXW, 1.12);
  y += Math.round(16 * SCALE);
  if (s.body) drawLines(ctx, s.body, PAD_X, y, 14, false, "rgba(245,244,238,0.78)", MAXW, 1.55);
  progressBar(ctx, idx, total, "dark", tok);
  if (!last) swipeArrow(ctx, "dark");
  return done();
}
function renderGradient(s: Slide, idx: number, total: number, tok: Tokens, last: boolean): Buffer {
  const { ctx, done } = base();
  gradientBg(ctx, tok);
  let y = Math.round(170 * SCALE);
  y = drawTag(ctx, s.tag, PAD_X, y, "rgba(255,255,255,0.8)");
  y = drawLines(ctx, s.heading, PAD_X, y, 30, true, "#FFFFFF", MAXW, 1.12);
  y += Math.round(14 * SCALE);
  if (s.body) y = drawLines(ctx, s.body, PAD_X, y, 14, false, "rgba(255,255,255,0.86)", MAXW, 1.5);
  if (s.quote) {
    y += Math.round(18 * SCALE);
    const pad = Math.round(16 * SCALE);
    setFont(ctx, 14, false);
    const qlines = wrap(ctx, `“${s.quote}”`, MAXW - 2 * pad);
    const lh = Math.round(14 * SCALE * 1.45);
    const boxH = qlines.length * lh + 2 * pad;
    ctx.fillStyle = "rgba(0,0,0,0.24)";
    roundRect(ctx, PAD_X, y, MAXW, boxH, Math.round(12 * SCALE)); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 2;
    roundRect(ctx, PAD_X, y, MAXW, boxH, Math.round(12 * SCALE)); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    setFont(ctx, 14, false);
    qlines.forEach((ln, i) => ctx.fillText(ln, PAD_X + pad, y + pad + i * lh));
  }
  progressBar(ctx, idx, total, "dark", tok);
  if (!last) swipeArrow(ctx, "dark");
  return done();
}
function renderFeatures(s: Slide, idx: number, total: number, tok: Tokens, last: boolean): Buffer {
  const { ctx, done } = base();
  ctx.fillStyle = tok.LIGHT_BG; ctx.fillRect(0, 0, W, H);
  let y = Math.round(140 * SCALE);
  y = drawTag(ctx, s.tag, PAD_X, y, tok.PRIMARY);
  y = drawLines(ctx, s.heading, PAD_X, y, 26, true, tok.DARK, MAXW, 1.12);
  y += Math.round(16 * SCALE);
  const items = s.items || [];
  const bulletCol = Math.round(28 * SCALE);
  const mid = "rgba(107,102,94,1)";
  for (const it of items) {
    const rowTop = y + Math.round(11 * SCALE);
    // diamante de viñeta
    const bx = PAD_X + Math.round(6 * SCALE);
    const by = rowTop + Math.round(8 * SCALE);
    const bs = Math.round(6 * SCALE);
    ctx.fillStyle = tok.ACCENT;
    ctx.beginPath();
    ctx.moveTo(bx, by - bs); ctx.lineTo(bx + bs, by); ctx.lineTo(bx, by + bs); ctx.lineTo(bx - bs, by);
    ctx.closePath(); ctx.fill();
    const tx = PAD_X + bulletCol;
    const tw = W - tx - PAD_X;
    setFont(ctx, 13, true);
    const labelText = `${it.label} — `;
    const lw = ctx.measureText(labelText).width;
    ctx.fillStyle = tok.DARK;
    ctx.fillText(labelText, tx, rowTop);
    // descripción: primera línea tras el label, resto a ancho completo
    setFont(ctx, 12, false);
    ctx.fillStyle = mid;
    const words = (it.description || "").split(/\s+/).filter(Boolean);
    let i = 0; let line = "";
    while (i < words.length) {
      const test = line ? line + " " + words[i] : words[i];
      if (ctx.measureText(test).width <= tw - lw) { line = test; i++; } else break;
    }
    ctx.fillText(line, tx + lw, rowTop + Math.round(2 * SCALE));
    let cy = rowTop + Math.round(18 * SCALE);
    let rem = words.slice(i);
    while (rem.length) {
      let l2 = ""; let j = 0;
      while (j < rem.length) {
        const test = l2 ? l2 + " " + rem[j] : rem[j];
        if (ctx.measureText(test).width <= tw) { l2 = test; j++; } else break;
      }
      if (j === 0) { l2 = rem[0]; j = 1; }
      ctx.fillText(l2, tx, cy);
      cy += Math.round(12 * SCALE * 1.4);
      rem = rem.slice(j);
    }
    y = Math.max(cy, rowTop + Math.round(34 * SCALE));
    ctx.strokeStyle = tok.LIGHT_BORDER; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD_X, y); ctx.lineTo(W - PAD_X, y); ctx.stroke();
  }
  progressBar(ctx, idx, total, "light", tok);
  if (!last) swipeArrow(ctx, "light");
  return done();
}
function renderProof(s: Slide, idx: number, total: number, tok: Tokens, last: boolean): Buffer {
  const { ctx, done } = base();
  ctx.fillStyle = tok.LIGHT_BG; ctx.fillRect(0, 0, W, H);
  let y = Math.round(120 * SCALE);
  y = drawTag(ctx, s.tag, PAD_X, y, tok.PRIMARY);
  y = drawLines(ctx, s.heading, PAD_X, y, 26, true, tok.DARK, MAXW, 1.12);
  y += Math.round(12 * SCALE);
  const steps = s.steps || [];
  const numCol = Math.round(60 * SCALE);
  const mid = "rgba(107,102,94,1)";
  for (const st of steps) {
    const rowTop = y + Math.round(12 * SCALE);
    setFont(ctx, 20, true);
    ctx.fillStyle = tok.ACCENT;
    ctx.fillText(st.number || "", PAD_X, rowTop);
    const tx = PAD_X + numCol;
    const tw = W - tx - PAD_X;
    setFont(ctx, 13, true);
    const titleText = `${st.title} — `;
    const titleW = ctx.measureText(titleText).width;
    ctx.fillStyle = tok.DARK;
    ctx.fillText(titleText, tx, rowTop);
    setFont(ctx, 12, false);
    ctx.fillStyle = mid;
    const words = (st.description || "").split(/\s+/).filter(Boolean);
    let i = 0; let line = "";
    while (i < words.length) {
      const test = line ? line + " " + words[i] : words[i];
      if (ctx.measureText(test).width <= tw - titleW) { line = test; i++; } else break;
    }
    ctx.fillText(line, tx + titleW, rowTop + Math.round(2 * SCALE));
    let cy = rowTop + Math.round(19 * SCALE);
    let rem = words.slice(i);
    while (rem.length) {
      let l2 = ""; let j = 0;
      while (j < rem.length) {
        const test = l2 ? l2 + " " + rem[j] : rem[j];
        if (ctx.measureText(test).width <= tw) { l2 = test; j++; } else break;
      }
      if (j === 0) { l2 = rem[0]; j = 1; }
      ctx.fillText(l2, tx, cy);
      cy += Math.round(12 * SCALE * 1.4);
      rem = rem.slice(j);
    }
    y = Math.max(cy, rowTop + Math.round(34 * SCALE));
    ctx.strokeStyle = tok.LIGHT_BORDER; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD_X, y); ctx.lineTo(W - PAD_X, y); ctx.stroke();
  }
  progressBar(ctx, idx, total, "light", tok);
  if (!last) swipeArrow(ctx, "light");
  return done();
}
function renderCta(s: Slide, idx: number, total: number, tok: Tokens): Buffer {
  const { ctx, done } = base();
  gradientBg(ctx, tok);
  const ctaText = s.cta_text || 'COMENTA "INFO"';
  setFont(ctx, 30, true);
  const headingLines = wrap(ctx, s.heading, MAXW);
  setFont(ctx, 14, false);
  const bodyLines = wrap(ctx, s.body || "", MAXW);
  const headLh = Math.round(30 * SCALE * 1.12);
  const bodyLh = Math.round(14 * SCALE * 1.5);
  const totalH = Math.round(30 * SCALE) + headingLines.length * headLh
    + Math.round(14 * SCALE) + bodyLines.length * bodyLh
    + Math.round(24 * SCALE) + Math.round(56 * SCALE);
  let y = Math.round((H - totalH) / 2);
  ctx.textAlign = "center";
  // tag centrado (letterspacing aproximado con textAlign center: lo dibujamos simple)
  setFont(ctx, 10, true);
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText((s.tag || "").toUpperCase(), W / 2, y);
  y += Math.round(30 * SCALE);
  setFont(ctx, 30, true);
  ctx.fillStyle = "#FFFFFF";
  for (const ln of headingLines) { ctx.fillText(ln, W / 2, y); y += headLh; }
  y += Math.round(14 * SCALE);
  setFont(ctx, 14, false);
  ctx.fillStyle = "rgba(255,255,255,0.86)";
  for (const ln of bodyLines) { ctx.fillText(ln, W / 2, y); y += bodyLh; }
  y += Math.round(24 * SCALE);
  // pill CTA
  setFont(ctx, 13, true);
  const pw = ctx.measureText(ctaText).width;
  const padX = Math.round(28 * SCALE), padY = Math.round(14 * SCALE);
  const arrow = Math.round(14 * SCALE), gap = Math.round(12 * SCALE);
  const pillW = pw + gap + arrow + 2 * padX;
  const pillH = Math.round(13 * SCALE) + 2 * padY;
  const px = Math.round((W - pillW) / 2);
  ctx.fillStyle = "#FFFFFF";
  roundRect(ctx, px, y, pillW, pillH, pillH / 2); ctx.fill();
  ctx.textAlign = "left";
  ctx.fillStyle = tok.DARK;
  setFont(ctx, 13, true);
  ctx.fillText(ctaText, px + padX, y + padY);
  // flecha ↗
  const ax = px + padX + pw + gap;
  const ayc = y + pillH / 2;
  ctx.strokeStyle = tok.DARK; ctx.lineWidth = Math.max(3, Math.round(2.2 * SCALE));
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(ax, ayc + arrow / 2); ctx.lineTo(ax + arrow, ayc - arrow / 2);
  ctx.moveTo(ax + arrow, ayc - arrow / 2); ctx.lineTo(ax + arrow / 2, ayc - arrow / 2);
  ctx.moveTo(ax + arrow, ayc - arrow / 2); ctx.lineTo(ax + arrow, ayc);
  ctx.stroke();
  progressBar(ctx, idx, total, "dark", tok);
  return done();
}

const RENDERERS: Record<string, (s: Slide, i: number, t: number, tok: Tokens, last: boolean) => Buffer> = {
  hero: renderHero,
  context: renderDark,
  insight: renderGradient,
  features: renderFeatures,
  depth: renderDark,
  proof: renderProof,
  cta: (s, i, t, tok) => renderCta(s, i, t, tok),
};

export function renderCarousel(slides: Slide[], primaryHex: string): { name: string; buffer: Buffer }[] {
  ensureFonts();
  const tok = deriveTokens(primaryHex || "#18181B");
  const total = slides.length;
  return slides.map((s, i) => {
    const fn = RENDERERS[s.type] || renderDark;
    const buf = fn(s, i, total, tok, i === total - 1);
    return { name: `slide_${String(i + 1).padStart(2, "0")}.png`, buffer: buf };
  });
}
