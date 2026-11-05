#!/usr/bin/env node
// Música del vídeo: dos pistas libres de Incompetech (Kevin MacLeod, CC BY 4.0) → public/musica/{calma,impulso}.mp3.
// La música cambia sola según la «energia» de cada escena: calma/tension usan «calma» (tension, apagada),
// impulso/climax usan «impulso».
//   node musica.mjs --buscar "calm piano"            busca en el catálogo (título, ambiente, instrumentos)
//   node musica.mjs                                   descarga las de plan.json → musica.calma / musica.impulso
// Imprime el crédito que hay que poner en el texto de la publicación (lo exige la licencia).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const CAT = "https://incompetech.com/music/royalty-free/pieces.json";
const arg = (k) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : undefined; };
const piezas = await (await fetch(CAT)).json();
const n = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const q = arg("buscar");
if (q) {
  const ps = n(q).split(/\s+/);
  const hits = piezas.map((p) => ({ p, s: ps.filter((w) => n([p.title, p.feel, p.description, p.instruments].join(" ")).includes(w)).length }))
    .filter((x) => x.s).sort((a, b) => b.s - a.s).slice(0, 15);
  for (const { p } of hits) console.log(`${p.title} · ${p.length} · ${p.bpm} bpm · ${p.feel} · ${p.description}`);
  process.exit(0);
}

const plan = JSON.parse(fs.readFileSync(path.join(RAIZ, arg("plan") || "plan.json"), "utf8").replace(/^\uFEFF/, ""));
fs.mkdirSync(path.join(RAIZ, "public", "musica"), { recursive: true });
const creditos = [];
for (const papel of ["calma", "impulso"]) {
  const titulo = plan.musica?.[papel];
  const p = piezas.find((x) => n(x.title) === n(titulo));
  if (!p) throw new Error(`plan.json → musica.${papel}: «${titulo}» no está en Incompetech (usa --buscar)`);
  const r = await fetch("https://incompetech.com/music/royalty-free/mp3-royaltyfree/" + encodeURIComponent(p.filename));
  if (!r.ok) throw new Error(`No se pudo descargar «${p.title}» (${r.status})`);
  fs.writeFileSync(path.join(RAIZ, "public", "musica", papel + ".mp3"), Buffer.from(await r.arrayBuffer()));
  creditos.push(`«${p.title}»`);
  console.log(`✓ public/musica/${papel}.mp3 ← ${p.title} (${p.length})`);
}
console.log(`\nCrédito para el texto: Música: ${[...new Set(creditos)].join(" y ")} de Kevin MacLeod (incompetech.com), licencia CC BY 4.0`);
