#!/usr/bin/env node
// Generador del patrón «Carrusel → vídeo narrado». Sin IA: plan.json (+ tiempos.json de la voz) → proyecto HyperFrames.
//   · Cada escena = copia de plantillas/<plantilla>.html con __ID__ → id único (eNN) y sus valores (data-variable-values).
//   · index.html = fondo + marca + barra de progreso fijas, escenas en fila, subtítulos palabra a palabra,
//     voz y música ADAPTATIVA (dos pistas: calma/impulso, según la «energia» de cada escena).
// Uso: node generar.mjs [--plan plan.json] [--tiempos tiempos.json] [--solo 3,10] [--sin-musica]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(fs.readFileSync(path.resolve(RAIZ, arg("plan", "plan.json")), "utf8").replace(/^\uFEFF/, ""));
const fTiempos = path.resolve(RAIZ, arg("tiempos", "tiempos.json"));
const tiempos = fs.existsSync(fTiempos) ? JSON.parse(fs.readFileSync(fTiempos, "utf8").replace(/^\uFEFF/, "")) : null;
const solo = arg("solo", "") ? arg("solo").split(",").map(Number) : null;
const conMusica = !process.argv.includes("--sin-musica");

const W = 1080, H = 1920, COLA = 1.2; // segundos de cierre tras la última palabra
// voz.py genera cada escena entera: las pausas entre frases las pone la voz (~0,15 s de margen para cerrar
// subtítulos) y entre escenas hay P_ESCENA fija. Los inicios de frase vienen medidos por Whisper (tiempos.json).
const P_FRASE = 0.15, P_ESCENA = 0.45;
const marca = plan.marca;

// Frases de la narración; el «Uno.» / «Dos.» inicial va pegado a su frase (igual que voz.py).
function frasesDe(t) {
  const fr = String(t).split(/(?<=[.!?…])\s+/).filter(Boolean);
  if (fr.length > 1 && fr[0].split(/\s+/).length === 1) fr.splice(0, 2, fr[0] + " " + fr[1]);
  return fr;
}
// Sin voz: estimación por palabras (2,6 palabras/s).
function estimar(esc) {
  const fr = frasesDe(esc.narracion); let t = 0; const starts = [];
  for (const f of fr) { starts.push(+t.toFixed(3)); t += f.split(/\s+/).length / 2.6 + P_FRASE; }
  return { dur: t + P_ESCENA, frases: starts };
}

// 1) Tiempos por escena: los reales de la voz (inicio, dur, inicio de cada frase) o la estimación.
let reloj = 0;
let escenas = plan.escenas.map((esc, i) => {
  const tm = tiempos?.escenas?.[i] || estimar(esc);
  const inicio = tiempos?.escenas?.[i] ? tm.inicio : reloj;
  reloj = inicio + tm.dur;
  const fr = tm.frases, frases = frasesDe(esc.narracion);
  // Fin de cada frase = inicio de la siguiente − pausa (la última, hasta el final de la escena − pausas).
  const fines = fr.map((s, k) => (k + 1 < fr.length ? fr[k + 1] - P_FRASE : tm.dur - P_ESCENA - P_FRASE));
  return {
    ...esc, n: i + 1, id: "e" + String(i + 1).padStart(2, "0"), inicio, dur: tm.dur,
    t1: +(fr[1] ?? tm.dur * 0.35).toFixed(2), t2: +(fr[fr.length - 1] ?? tm.dur * 0.65).toFixed(2),
    frases: frases.map((txt, k) => ({ txt, ini: fr[k] ?? 0, fin: fines[k] ?? tm.dur })),
  };
});
if (solo) { escenas = escenas.filter((e) => solo.includes(e.n)); let t = 0; for (const e of escenas) { e.inicio = t; t += e.dur; } }
escenas.at(-1).dur += COLA;
const total = +(escenas.at(-1).inicio + escenas.at(-1).dur).toFixed(2);

// 2) Escenas: copia de la plantilla con su id.
const dirEsc = path.join(RAIZ, "compositions", "escenas");
fs.rmSync(dirEsc, { recursive: true, force: true });
fs.mkdirSync(dirEsc, { recursive: true });
// Las plantillas están dibujadas con una paleta de referencia: se cambia por la de la marca.
const PALETA = { "#D4E6A5": marca.colores.acento, "#111312": marca.colores.fondo, "#9A9E9A": marca.colores.secundario, "#FFFFFF": marca.colores.texto };
const conMascota = fs.existsSync(path.join(RAIZ, "public", "mascota.png"));
for (const e of escenas) {
  const src = path.join(RAIZ, "plantillas", e.plantilla + ".html");
  if (!fs.existsSync(src)) throw new Error("Plantilla inexistente: " + e.plantilla);
  let html = fs.readFileSync(src, "utf8").replaceAll("__ID__", e.id);
  for (const [de, a] of Object.entries(PALETA)) if (a) html = html.replace(new RegExp(de + "(?![0-9a-f])", "gi"), a);
  if (!conMascota) html = html.replace(/<img class="masc"[^>]*>/, "");
  fs.writeFileSync(path.join(dirEsc, e.id + ".html"), html);
}

// 3) Subtítulos: grupos de ≤4 palabras (cortando en la puntuación); cada palabra con su tiempo, repartido dentro
//    de su frase según su longitud (la frase sí tiene tiempo exacto porque la voz se genera frase a frase).
const subs = [];
const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ]/g, "");
for (const e of escenas) { e.palabras = []; for (const f of e.frases) {
  const ws = f.txt.split(/\s+/).filter(Boolean);
  const pesos = ws.map((w) => w.replace(/[^\p{L}\p{N}]/gu, "").length + 2), suma = pesos.reduce((a, b) => a + b, 0);
  let t = e.inicio + f.ini; const lim = e.inicio + f.fin;
  const pal = ws.map((w, k) => { const d = (lim - (e.inicio + f.ini)) * pesos[k] / suma; const p = { w, ini: t, fin: t + d }; t += d; return p; });
  e.palabras.push(...pal);
  let g = [];
  for (const p of pal) { g.push(p); if (g.length === 4 || /[,.;:!?…»]$/.test(p.w)) { subs.push(g); g = []; } }
  if (g.length) subs.push(g);
} }
// ANCLAS · cada animación clave ocurre cuando SE DICE su palabra (no al empezar la frase): plan.escenas[i].anclas =
// { t1: "cientos", t2: "Date" } → t1/t2 = segundo (dentro de la escena) en que empieza esa palabra. Se busca en
// orden (t2 después de t1). Sin anclas: inicio de la 2.ª frase y de la última, como antes.
for (const e of escenas) {
  let desde = 0;
  for (const k of ["t1", "t2"]) {
    const buscada = e.anclas?.[k];
    if (!buscada) continue;
    const pb = norm(String(buscada).split(/\s+/)[0]);
    const i = e.palabras.findIndex((p, j) => j >= desde && norm(p.w).startsWith(pb));
    if (i < 0) { console.warn(`⚠ ${e.id}: la palabra «${buscada}» (anclas.${k}) no está en la narración — uso la frase`); continue; }
    e[k] = +(e.palabras[i].ini - e.inicio).toFixed(2); desde = i + 1;
  }
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
const subsHtml = subs.map((g, k) => {
  const ini = g[0].ini, fin = (subs[k + 1] && subs[k + 1][0].ini - g.at(-1).fin < 0.25) ? subs[k + 1][0].ini : g.at(-1).fin + 0.2;
  return `      <div id="sub${k}" class="clip gen-sub" data-start="${ini.toFixed(2)}" data-duration="${(fin - ini).toFixed(2)}" data-track-index="6">${g.map((p, j) => `<span id="sub${k}w${j}">${esc(p.w)}</span>`).join(" ")}</div>`;
}).join("\n");
const subsTl = subs.flatMap((g, k) => g.map((p, j) =>
  `      tl.fromTo("#sub${k}w${j}", { color: "#ffffff" }, { color: "${marca.colores.acento}", duration: 0.08 }, ${p.ini.toFixed(2)});`)).join("\n");

// 4) Música adaptativa: dos pistas (A calma, B impulso) con envolventes de volumen y un paso-bajo en A.
//    Reglas fijas por energía — la IA solo etiqueta la escena.
const audio = [];
if (tiempos?.voz) audio.push(`      <audio id="voz" src="${tiempos.voz}" data-start="0" data-duration="${total}" data-track-index="8" data-volume="1"></audio>`);
if (conMusica) {
  // BASE ≈ −20 dB bajo la voz; en los respiros entre escenas (sin voz) la música sube ×RESPIRO para que se
  // note el cambio de tono justo donde ocurre (antes, a −38 dB, la adaptación no se oía).
  const BASE = 0.25, RESPIRO = 2.2, ABIERTO = 18000, TAPADO = 900, XF = 1.2;
  const estado = { calma: { a: 1, b: 0, f: ABIERTO }, tension: { a: 0.75, b: 0, f: TAPADO }, impulso: { a: 0, b: 1, f: ABIERTO }, climax: { a: 0, b: 1, f: ABIERTO } };
  const pa = [], pb = [], pf = [];
  const punto = (arr, t, v) => { t = +Math.max(0, t).toFixed(2); if (arr.length && t <= arr.at(-1).t) t = +(arr.at(-1).t + 0.01).toFixed(2); arr.push({ t, v: +v.toFixed(3) }); };
  for (const [k, e] of escenas.entries()) {
    const s = estado[e.energia] || estado.calma, t0 = Math.max(0, e.inicio - XF / 2);
    const prev = escenas[k - 1], sp = prev ? (estado[prev.energia] || estado.calma) : s;
    // Respiro: termina la voz de la escena anterior → la música (aún con el estado anterior) sube; con la
    // nueva escena cruza al nuevo estado y vuelve a su sitio bajo la voz.
    if (prev) {
      const finVoz = prev.inicio + prev.frases.at(-1).fin;
      if (e.inicio - finVoz > 0.3) {
        punto(pa, finVoz + 0.05, BASE * sp.a); punto(pb, finVoz + 0.05, BASE * sp.b);
        punto(pa, finVoz + 0.3, BASE * sp.a * RESPIRO); punto(pb, finVoz + 0.3, BASE * sp.b * RESPIRO);
      }
    }
    punto(pa, t0, BASE * s.a * (prev ? RESPIRO : 1)); punto(pa, t0 + XF, BASE * s.a);
    punto(pb, t0, BASE * s.b * (prev ? RESPIRO : 1)); punto(pb, t0 + XF, BASE * s.b);
    punto(pf, t0, s.f); punto(pf, t0 + XF, s.f);
    if (e.energia === "climax") { // +3 dB en el remate y vuelta
      const tr = e.inicio + e.t2; punto(pb, tr - 0.4, BASE); punto(pb, tr, BASE * 1.41); punto(pb, e.inicio + e.dur - 0.6, BASE * 1.41);
    }
  }
  for (const arr of [pa, pb]) { punto(arr, total - 2, arr.at(-1).v); punto(arr, total, 0); }
  const fxA = { version: 1, nodes: [{ type: "lowpass", id: "n1", label: "Tensión (tapado)", params: { frequency: ABIERTO, q: 0.707, poles: "2" } }] };
  const autoA = { version: 1, lanes: [{ target: "volume", points: pa }, { target: "fx.n1.frequency", points: pf }] };
  const autoB = { version: 1, lanes: [{ target: "volume", points: pb }] };
  const q = (o) => JSON.stringify(o).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  audio.push(`      <audio id="musica-calma" src="public/musica/calma.mp3" data-start="0" data-duration="${total}" data-track-index="9" data-volume="1" data-fx-chain="${q(fxA)}" data-automation="${q(autoA)}"></audio>`);
  audio.push(`      <audio id="musica-impulso" src="public/musica/impulso.mp3" data-start="0" data-duration="${total}" data-track-index="10" data-volume="1" data-automation="${q(autoB)}"></audio>`);
}

// 5) index.html
const nItems = Math.max(...plan.escenas.map((e) => Number(e.campos?.numero) || 0), 0);
const hosts = escenas.map((e, k) => {
  const vals = { ...e.campos, t1: e.t1, t2: e.t2, dur: +e.dur.toFixed(2) };
  for (const [kk, vv] of Object.entries(vals)) if (vv && typeof vv === "object") { for (const [a, b] of Object.entries(vv)) vals[kk + "_" + a] = b; delete vals[kk]; }
  return `      <div id="${e.id}" data-composition-id="${e.id}" data-composition-src="compositions/escenas/${e.id}.html"
        data-start="${e.inicio.toFixed(2)}" data-duration="${e.dur.toFixed(2)}" data-track-index="${2 + (k % 2)}"
        data-width="${W}" data-height="${H}" data-variable-values='${esc(JSON.stringify(vals))}'></div>`;
}).join("\n");
const segs = Array.from({ length: nItems }, (_, i) => `<i id="seg${i + 1}"></i>`).join("");
const progreso = escenas.filter((e) => Number(e.campos?.numero)).map((e) => `      tl.fromTo("#seg${e.campos.numero}", { backgroundColor: "#2a2e2b" }, { backgroundColor: "${marca.colores.acento}", duration: 0.4 }, ${(e.inicio + 0.1).toFixed(2)});`).join("\n");

fs.writeFileSync(path.join(RAIZ, "index.html"), `<!doctype html>
<!-- GENERADO por generar.mjs desde plan.json — no editar a mano. -->
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Jost"; src: url("public/fonts/Jost-var.ttf") format("truetype"); font-weight: 100 900; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${marca.colores.fondo}; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${marca.colores.fondo}; font-family: "Jost", sans-serif; color: ${marca.colores.texto}; }
      #marca { position: absolute; left: 96px; right: 96px; top: 150px; display: flex; justify-content: space-between; align-items: center; font-size: 30px; font-weight: 600; letter-spacing: .02em; }
      #marca span { color: ${marca.colores.secundario}; font-weight: 400; }
      #progreso { position: absolute; left: 96px; right: 96px; top: 218px; height: 6px; display: flex; gap: 10px; }
      #progreso i { flex: 1; height: 6px; border-radius: 3px; background: #2a2e2b; display: block; }
      .gen-sub { position: absolute; left: 80px; right: 80px; top: 1470px; text-align: center; font-size: 60px; font-weight: 700; line-height: 1.15; color: #fff; text-shadow: 0 4px 18px rgba(0,0,0,.9); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${W}" data-height="${H}">
      <div id="marca" class="clip" data-start="0" data-duration="${total}" data-track-index="1">${esc(marca.nombre)}<span>${esc(marca.usuario)}</span></div>
      <div id="progreso" class="clip" data-start="0" data-duration="${total}" data-track-index="1">${segs}</div>
${hosts}
${subsHtml}
${audio.join("\n")}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
${progreso}
${subsTl}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`);
fs.writeFileSync(path.join(RAIZ, "escenas.json"), JSON.stringify(escenas.map(({ id, plantilla, energia, inicio, dur, t1, t2 }) => ({ id, plantilla, energia, inicio: +inicio.toFixed(2), dur: +dur.toFixed(2), t1, t2 })), null, 1));
console.log(`✓ ${escenas.length} escenas · ${subs.length} subtítulos · ${total} s · ${tiempos ? "voz real" : "tiempos estimados"} · index.html`);
