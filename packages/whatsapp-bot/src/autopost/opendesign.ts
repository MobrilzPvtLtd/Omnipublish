/**
 * Open Design — motor de diseño premium para los carruseles.
 *
 * Sustituye el dibujo plano a mano (canvas) por un sistema de plantillas con
 * layout real tipo CSS (flexbox, gradientes, sombras, tipografía grande) usando
 * Satori (HTML/CSS → SVG) + resvg (SVG → PNG). Es 100% open-source, SIN navegador
 * y SIN tokens ni servicios externos, así que despliega fiable en Railway igual
 * que el canvas, pero el resultado se ve de nivel agencia.
 *
 * La IA (Groq, gratis) escribe el contenido (generate.ts); Open Design lo maqueta.
 */
import { existsSync, readFileSync } from "node:fs";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { Slide } from "./generate.js";

const W = 1080;
const H = 1350;
const PAD = 92;

// ---------- Fuentes (mismas candidatas multi-OS que el render canvas) ----------
let FONTS: { reg: Buffer; bold: Buffer } | null = null;
function loadFonts(): { reg: Buffer; bold: Buffer } {
  if (FONTS) return FONTS;
  const regC = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
  ];
  const boldC = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
  ];
  const find = (list: string[]) => list.find((p) => existsSync(p));
  const rp = find(regC);
  const bp = find(boldC);
  if (!rp && !bp) throw new Error("Open Design: no se encontró ninguna fuente del sistema");
  const reg = readFileSync(rp || (bp as string));
  const bold = readFileSync(bp || (rp as string));
  FONTS = { reg, bold };
  return FONTS;
}

// ---------- Color ----------
function hexToRgb(h: string): [number, number, number] {
  const s = (h || "").replace("#", "").padEnd(6, "0").slice(0, 6);
  return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0, parseInt(s.slice(4, 6), 16) || 0];
}
function toHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, l, s];
}
function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}
function lighten(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex); const [h, l, s] = rgbToHls(r, g, b);
  return toHex(...hlsToRgb(h, Math.min(1, l + (1 - l) * amt), s));
}
function darken(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex); const [h, l, s] = rgbToHls(r, g, b);
  return toHex(...hlsToRgb(h, Math.max(0, l * (1 - amt)), s));
}
function family(hex: string): "warm" | "cool" | "neutral" {
  const [r, g, b] = hexToRgb(hex); const [h, , s] = rgbToHls(r, g, b);
  if (s < 0.12) return "neutral";
  const deg = h * 360;
  return deg < 60 || deg >= 300 ? "warm" : "cool";
}

interface Tokens {
  primary: string; accent: string; ink: string; paper: string; paper2: string;
  line: string; gStart: string; gMid: string; gEnd: string;
}
function tokens(primaryHex: string, accentHex?: string): Tokens {
  const primary = /^#?[0-9a-fA-F]{6}$/.test(primaryHex || "") ? (primaryHex.startsWith("#") ? primaryHex : "#" + primaryHex) : "#1E3A5F";
  const fam = family(primary);
  const paper = fam === "warm" ? "#F8F5EF" : fam === "cool" ? "#F4F6F9" : "#F6F5F1";
  const paper2 = fam === "warm" ? "#FFFFFF" : fam === "cool" ? "#FFFFFF" : "#FFFFFF";
  const line = fam === "warm" ? "#ECE6DA" : fam === "cool" ? "#E3E7EE" : "#E8E6DF";
  const ink = fam === "cool" ? "#0E1729" : fam === "warm" ? "#1A1714" : "#121214";
  // Acento: el que elija el usuario (2º color de marca), o auto-derivado del principal.
  const accent = /^#?[0-9a-fA-F]{6}$/.test(accentHex || "") ? (accentHex!.startsWith("#") ? accentHex! : "#" + accentHex!) : lighten(primary, 0.18);
  return {
    primary, accent, ink, paper, paper2, line,
    gStart: darken(primary, 0.38), gMid: primary, gEnd: lighten(primary, 0.22),
  };
}

// ---------- VDOM helper para Satori (sin JSX) ----------
type El = { type: string; props: { style: Record<string, unknown>; children?: unknown } };
function h(type: string, style: Record<string, unknown>, children?: unknown): El {
  return { type, props: { style, children } };
}
const FF = "Brand";

// ---------- Piezas compartidas ----------
function kicker(text: string, color: string): El {
  return h("div", {
    display: "flex", fontFamily: FF, fontSize: 26, fontWeight: 700, letterSpacing: 5,
    textTransform: "uppercase", color,
  }, (text || "").toUpperCase());
}
function dots(idx: number, total: number, on: string, off: string): El {
  const arr: El[] = [];
  for (let i = 0; i < total; i++) {
    const active = i === idx;
    arr.push(h("div", {
      display: "flex", width: active ? 30 : 10, height: 10, borderRadius: 999,
      backgroundColor: i <= idx ? on : off, marginRight: 8,
    }));
  }
  return h("div", { display: "flex", alignItems: "center" }, arr);
}
function footer(handle: string, idx: number, total: number, onCol: string, offCol: string, txtCol: string): El {
  return h("div", {
    display: "flex", position: "absolute", left: PAD, right: PAD, bottom: 64,
    alignItems: "center", justifyContent: "space-between",
  }, [
    h("div", { display: "flex", fontFamily: FF, fontSize: 24, fontWeight: 700, color: txtCol }, handle || "@mimarca"),
    dots(idx, total, onCol, offCol),
  ]);
}
function swipe(last: boolean, color: string, bg: string): El | null {
  if (last) return null;
  return h("div", {
    display: "flex", position: "absolute", right: PAD, top: H / 2 - 34, width: 68, height: 68,
    borderRadius: 999, backgroundColor: bg, alignItems: "center", justifyContent: "center",
    fontFamily: FF, fontSize: 38, fontWeight: 700, color,
  }, "›");
}

// ---------- Plantillas por tipo de slide ----------
function tplHero(s: Slide, idx: number, total: number, t: Tokens, handle: string, last: boolean): El {
  return h("div", {
    display: "flex", flexDirection: "column", width: W, height: H, backgroundColor: t.paper,
    padding: PAD, paddingTop: 150, position: "relative",
  }, [
    h("div", { display: "flex", width: 88, height: 8, borderRadius: 999, backgroundColor: t.primary, marginBottom: 40 }),
    kicker(s.tag, t.primary),
    h("div", {
      display: "flex", fontFamily: FF, fontSize: 86, fontWeight: 700, color: t.ink,
      lineHeight: 1.04, marginTop: 28, letterSpacing: -1,
    }, s.heading || ""),
    swipe(last, t.paper, t.primary),
    footer(handle, idx, total, t.primary, t.line, darken(t.paper, 0.45)),
  ].filter(Boolean));
}

function tplDark(s: Slide, idx: number, total: number, t: Tokens, handle: string, last: boolean, withRail: boolean): El {
  return h("div", {
    display: "flex", flexDirection: "column", width: W, height: H, backgroundColor: t.ink,
    padding: PAD, justifyContent: "center", position: "relative",
  }, [
    h("div", {
      display: "flex", position: "absolute", top: 40, right: 30, fontFamily: FF, fontSize: 380,
      fontWeight: 700, color: "rgba(255,255,255,0.045)", lineHeight: 1,
    }, String(idx + 1).padStart(2, "0")),
    kicker(s.tag, t.accent),
    h("div", {
      display: "flex", fontFamily: FF, fontSize: 58, fontWeight: 700, color: "#F6F5F1",
      lineHeight: 1.08, marginTop: 26, letterSpacing: -0.5,
      borderLeft: withRail ? `8px solid ${t.accent}` : "0", paddingLeft: withRail ? 30 : 0,
    }, s.heading || ""),
    s.body
      ? h("div", { display: "flex", fontFamily: FF, fontSize: 30, color: "rgba(246,245,241,0.74)", lineHeight: 1.5, marginTop: 30 }, s.body)
      : null,
    swipe(last, t.ink, "rgba(255,255,255,0.14)"),
    footer(handle, idx, total, t.accent, "rgba(255,255,255,0.15)", "rgba(246,245,241,0.6)"),
  ].filter(Boolean));
}

function tplGradient(s: Slide, idx: number, total: number, t: Tokens, handle: string, last: boolean): El {
  const kids: (El | null)[] = [
    kicker(s.tag, "rgba(255,255,255,0.82)"),
    h("div", {
      display: "flex", fontFamily: FF, fontSize: 62, fontWeight: 700, color: "#FFFFFF",
      lineHeight: 1.08, marginTop: 26, letterSpacing: -0.5,
    }, s.heading || ""),
  ];
  if (s.body)
    kids.push(h("div", { display: "flex", fontFamily: FF, fontSize: 30, color: "rgba(255,255,255,0.9)", lineHeight: 1.5, marginTop: 28 }, s.body));
  if (s.quote)
    kids.push(h("div", {
      display: "flex", flexDirection: "column", marginTop: 40, padding: 40, borderRadius: 28,
      backgroundColor: "rgba(255,255,255,0.13)", border: "2px solid rgba(255,255,255,0.28)",
    }, [
      h("div", { display: "flex", fontFamily: FF, fontSize: 90, fontWeight: 700, color: "rgba(255,255,255,0.55)", lineHeight: 0.6, height: 54 }, "“"),
      h("div", { display: "flex", fontFamily: FF, fontSize: 32, color: "#FFFFFF", lineHeight: 1.42 }, s.quote),
    ]));
  return h("div", {
    display: "flex", flexDirection: "column", width: W, height: H, padding: PAD,
    justifyContent: "center", position: "relative",
    backgroundImage: `linear-gradient(150deg, ${t.gStart} 0%, ${t.gMid} 52%, ${t.gEnd} 100%)`,
  }, [
    ...kids.filter(Boolean) as El[],
    swipe(last, "#FFFFFF", "rgba(255,255,255,0.2)"),
    footer(handle, idx, total, "#FFFFFF", "rgba(255,255,255,0.3)", "rgba(255,255,255,0.78)"),
  ]);
}

function tplFeatures(s: Slide, idx: number, total: number, t: Tokens, handle: string, last: boolean): El {
  const items = (s.items || []).slice(0, 4);
  const rows = items.map((it, i) =>
    h("div", {
      display: "flex", alignItems: "flex-start", backgroundColor: t.paper2, border: `1px solid ${t.line}`,
      borderRadius: 22, padding: 28, marginBottom: 18, boxShadow: "0 8px 24px rgba(20,20,30,0.05)",
    }, [
      h("div", {
        display: "flex", width: 58, height: 58, borderRadius: 16, backgroundColor: t.primary,
        alignItems: "center", justifyContent: "center", marginRight: 24, flexShrink: 0,
        fontFamily: FF, fontSize: 28, fontWeight: 700, color: "#fff",
      }, String(i + 1)),
      h("div", { display: "flex", flexDirection: "column", flexGrow: 1 }, [
        h("div", { display: "flex", fontFamily: FF, fontSize: 30, fontWeight: 700, color: t.ink }, it.label || ""),
        it.description
          ? h("div", { display: "flex", fontFamily: FF, fontSize: 25, color: darken(t.paper, 0.5), lineHeight: 1.4, marginTop: 8 }, it.description)
          : null,
      ].filter(Boolean)),
    ]),
  );
  return h("div", {
    display: "flex", flexDirection: "column", width: W, height: H, backgroundColor: t.paper,
    padding: PAD, paddingTop: 120, position: "relative",
  }, [
    kicker(s.tag, t.primary),
    h("div", { display: "flex", fontFamily: FF, fontSize: 50, fontWeight: 700, color: t.ink, lineHeight: 1.1, marginTop: 22, marginBottom: 40, letterSpacing: -0.5 }, s.heading || ""),
    h("div", { display: "flex", flexDirection: "column" }, rows),
    swipe(last, t.paper, t.primary),
    footer(handle, idx, total, t.primary, t.line, darken(t.paper, 0.45)),
  ]);
}

function tplProof(s: Slide, idx: number, total: number, t: Tokens, handle: string, last: boolean): El {
  const steps = (s.steps || []).slice(0, 4);
  const rows = steps.map((st, i) =>
    h("div", {
      display: "flex", alignItems: "flex-start", paddingTop: 26, paddingBottom: 26,
      borderTop: i === 0 ? "0" : `1px solid ${t.line}`,
    }, [
      h("div", { display: "flex", fontFamily: FF, fontSize: 54, fontWeight: 700, color: t.accent, marginRight: 28, flexShrink: 0, width: 86 }, st.number || String(i + 1).padStart(2, "0")),
      h("div", { display: "flex", flexDirection: "column", flexGrow: 1 }, [
        h("div", { display: "flex", fontFamily: FF, fontSize: 30, fontWeight: 700, color: t.ink }, st.title || ""),
        st.description
          ? h("div", { display: "flex", fontFamily: FF, fontSize: 25, color: darken(t.paper, 0.5), lineHeight: 1.4, marginTop: 8 }, st.description)
          : null,
      ].filter(Boolean)),
    ]),
  );
  return h("div", {
    display: "flex", flexDirection: "column", width: W, height: H, backgroundColor: t.paper,
    padding: PAD, paddingTop: 120, position: "relative",
  }, [
    kicker(s.tag, t.primary),
    h("div", { display: "flex", fontFamily: FF, fontSize: 50, fontWeight: 700, color: t.ink, lineHeight: 1.1, marginTop: 22, marginBottom: 24, letterSpacing: -0.5 }, s.heading || ""),
    h("div", { display: "flex", flexDirection: "column" }, rows),
    swipe(last, t.paper, t.primary),
    footer(handle, idx, total, t.primary, t.line, darken(t.paper, 0.45)),
  ]);
}

function tplCta(s: Slide, idx: number, total: number, t: Tokens, handle: string): El {
  const cta = s.cta_text || 'COMENTA "INFO"';
  return h("div", {
    display: "flex", flexDirection: "column", width: W, height: H, padding: PAD,
    alignItems: "center", justifyContent: "center", position: "relative", textAlign: "center",
    backgroundImage: `linear-gradient(150deg, ${t.gStart} 0%, ${t.gMid} 52%, ${t.gEnd} 100%)`,
  }, [
    kicker(s.tag, "rgba(255,255,255,0.82)"),
    h("div", { display: "flex", fontFamily: FF, fontSize: 66, fontWeight: 700, color: "#FFFFFF", lineHeight: 1.08, marginTop: 24, letterSpacing: -0.5, textAlign: "center" }, s.heading || ""),
    s.body
      ? h("div", { display: "flex", fontFamily: FF, fontSize: 30, color: "rgba(255,255,255,0.88)", lineHeight: 1.5, marginTop: 26, textAlign: "center" }, s.body)
      : null,
    h("div", {
      display: "flex", marginTop: 50, backgroundColor: "#FFFFFF", color: t.ink, borderRadius: 999,
      padding: "26px 46px", fontFamily: FF, fontSize: 30, fontWeight: 700,
      boxShadow: "0 24px 60px rgba(0,0,0,0.32)",
    }, `${cta}  ↗`),
    footer(handle, idx, total, "#FFFFFF", "rgba(255,255,255,0.3)", "rgba(255,255,255,0.78)"),
  ].filter(Boolean));
}

function build(s: Slide, idx: number, total: number, t: Tokens, handle: string): El {
  const last = idx === total - 1;
  switch (s.type) {
    case "hero": return tplHero(s, idx, total, t, handle, last);
    case "context": return tplDark(s, idx, total, t, handle, last, false);
    case "insight": return tplGradient(s, idx, total, t, handle, last);
    case "features": return tplFeatures(s, idx, total, t, handle, last);
    case "depth": return tplDark(s, idx, total, t, handle, last, true);
    case "proof": return tplProof(s, idx, total, t, handle, last);
    case "cta": return tplCta(s, idx, total, t, handle);
    default: return tplDark(s, idx, total, t, handle, last, false);
  }
}

/** Renderiza el carrusel completo con Open Design. handle = @marca para el footer. */
export async function renderCarouselOpenDesign(
  slides: Slide[],
  primaryHex: string,
  handle = "@mimarca",
  accentHex?: string,
): Promise<{ name: string; buffer: Buffer }[]> {
  const { reg, bold } = loadFonts();
  const t = tokens(primaryHex, accentHex);
  const total = slides.length;
  const fonts = [
    { name: FF, data: reg, weight: 400 as const, style: "normal" as const },
    { name: FF, data: bold, weight: 700 as const, style: "normal" as const },
  ];
  const out: { name: string; buffer: Buffer }[] = [];
  for (let i = 0; i < slides.length; i++) {
    const svg = await satori(build(slides[i], i, total, t, handle) as unknown as Parameters<typeof satori>[0], {
      width: W, height: H, fonts,
    });
    // satori embebe la fuente en el SVG (embedFont por defecto); además le pasamos
    // los buffers a resvg como red de seguridad. `fontBuffers` funciona en runtime
    // en resvg 2.6 aunque sus typings aún no lo declaren → cast del objeto opciones.
    const resvgOpts = {
      fitTo: { mode: "width", value: W },
      font: { fontBuffers: [reg, bold], loadSystemFonts: false, defaultFontFamily: FF },
    } as unknown as ConstructorParameters<typeof Resvg>[1];
    const png = new Resvg(svg, resvgOpts).render().asPng();
    out.push({ name: `slide_${String(i + 1).padStart(2, "0")}.png`, buffer: png });
  }
  return out;
}
