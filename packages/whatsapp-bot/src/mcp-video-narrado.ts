/**
 * VIDEO-NARRADO-1 · Lo que el MCP pone para «carrusel → vídeo narrado».
 *
 * La voz clonada y el render necesitan GPU/CPU de verdad: los hace la IA de cada persona en SU
 * ordenador (Claude Code, Cowork…), no Railway. Business Stack pone dos cosas:
 *   1. El KIT (kit/video-narrado/): plantillas, scripts y receta. Se descarga con
 *      `curl <origen>/kit/video-narrado/instalar.py | python - <carpeta>` (sin dependencias: urllib + json).
 *   2. La SUBIDA del vídeo terminado: un MP4 de 10-100 MB no cabe en una llamada MCP (base64 en el
 *      contexto), así que `subir_archivo` da un enlace de un solo uso para `curl -T`. Al recibirlo se
 *      abre una sesión del dueño del enlace y se guarda por la ruta de siempre del Programador
 *      (/admin/api/pages/assets, draft __sched__): mismas validaciones (firma real, ≤100 MB) y RBAC.
 */
import crypto from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { mcpSesion } from "./admin.js";
import { baseDe } from "./mcp-oauth.js";
import { MAX_VIDEO_PROGRAMADOR } from "./page-builder.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MAX_SUBIDA = MAX_VIDEO_PROGRAMADOR; // 250 MB (MEDIA-CADUCA-1; antes 100 MB por el base64)
const VIDA_SUBIDA_MS = 60 * 60_000;

// ── Kit ──────────────────────────────────────────────────────────────────────
let kitCache: { version: string; json: string } | null = null;
function dirKit(): string | null {
  // src/ (tsx) y dist/ (build) están al mismo nivel: el kit vive en la raíz del paquete.
  for (const p of [join(AQUI, "..", "kit", "video-narrado"), join(AQUI, "kit", "video-narrado")]) {
    try { if (statSync(p).isDirectory()) return p; } catch { /* siguiente */ }
  }
  return null;
}
export function kitVideoNarrado(): { version: string; json: string } | null {
  if (kitCache) return kitCache;
  const raiz = dirKit();
  if (!raiz) return null;
  const archivos: { ruta: string; b64: string }[] = [];
  const recorre = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      if (n === "__pycache__" || n === "node_modules" || n.startsWith(".")) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) recorre(p);
      else archivos.push({ ruta: relative(raiz, p).split(sep).join("/"), b64: readFileSync(p).toString("base64") });
    }
  };
  recorre(raiz);
  const h = crypto.createHash("sha256");
  for (const a of archivos) h.update(a.ruta).update(a.b64);
  const version = h.digest("hex").slice(0, 10);
  kitCache = { version, json: JSON.stringify({ version, archivos }) };
  return kitCache;
}

const instalador = (origen: string) => `"""Descarga el kit «vídeo narrado» de Business Stack.
Uso:  python instalar.py [carpeta]      (por defecto ./video-narrado; no toca voz/, marca.json ni .venv/)
"""
import base64, json, sys, urllib.request
from pathlib import Path

destino = Path(sys.argv[1] if len(sys.argv) > 1 else "video-narrado").resolve()
with urllib.request.urlopen(${JSON.stringify(origen + "/kit/video-narrado.json")}) as r:
    kit = json.load(r)
for a in kit["archivos"]:
    p = destino / a["ruta"]
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(base64.b64decode(a["b64"]))
(destino / ".version-kit").write_text(kit["version"])
print(f"✓ Kit {kit['version']} en {destino} ({len(kit['archivos'])} archivos). Sigue LEEME.md.")
`;

// ── Subidas de un solo uso ───────────────────────────────────────────────────
const subidas = new Map<string, { uid: string; ws: string; nombre: string; caduca: number }>();
export function crearSubida(uid: string, ws: string, nombre: string): { token: string; caduca: number } {
  const ahora = Date.now();
  for (const [t, s] of subidas) if (s.caduca < ahora) subidas.delete(t);
  const token = crypto.randomBytes(24).toString("base64url");
  const caduca = ahora + VIDA_SUBIDA_MS;
  subidas.set(token, { uid, ws, nombre: nombre.replace(/[^\w.\- ]+/g, "").slice(0, 80) || "video.mp4", caduca });
  return { token, caduca };
}

export function registrarVideoNarrado(app: FastifyInstance): void {
  app.get("/kit/video-narrado.json", async (_req, reply) => {
    const k = kitVideoNarrado();
    if (!k) return reply.code(404).send({ error: "kit no disponible en esta instalación" });
    return reply.type("application/json").header("Cache-Control", "no-cache").send(k.json);
  });
  app.get("/kit/video-narrado/instalar.py", async (req, reply) =>
    reply.type("text/x-python; charset=utf-8").header("Cache-Control", "no-cache").send(instalador(baseDe(req))));

  // Cuerpo crudo (el MP4 tal cual): parser propio solo en este contexto, sin tocar el JSON del resto.
  app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_SUBIDA }, (_req, body, done) => done(null, body));
    sub.put("/mcp/subida/:token", { bodyLimit: MAX_SUBIDA }, async (req, reply) => {
      const token = String((req.params as { token?: string }).token || "");
      const s = subidas.get(token);
      if (!s || s.caduca < Date.now()) {
        subidas.delete(token);
        return reply.code(410).send({ error: "Enlace de subida caducado o ya usado: pide otro con subir_archivo." });
      }
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || !buf.length) return reply.code(400).send({ error: "Cuerpo vacío: sube el archivo con curl -T <archivo> <enlace>." });
      const ses = await mcpSesion(s.uid, s.ws).catch((e: Error) => ({ error: e.message }));
      if ("error" in ses) return reply.code(403).send({ error: "La cuenta ya no puede usar ese negocio: " + ses.error });
      // MEDIA-CADUCA-1 · canal binario (sin base64): el archivo viaja tal cual, así el límite es
      // MAX_SUBIDA y no los ~100 MB que dejaba el JSON+base64 con 150 MB de cuerpo.
      const r = await app.inject({
        method: "PUT", url: "/admin/api/pages/assets/raw",
        headers: { cookie: ses.cookie, "x-workspace-id": s.ws, "content-type": "application/octet-stream",
          "x-asset-name": s.nombre, "user-agent": "BusinessStack-MCP/1" },
        payload: buf,
      });
      let j: { url?: string; error?: string; size?: number; contentType?: string } = {};
      try { j = JSON.parse(r.body); } catch { /* texto */ }
      if (r.statusCode >= 300 || !j.url) return reply.code(r.statusCode >= 300 ? r.statusCode : 500).send({ error: j.error || r.body || "no se pudo guardar" });
      subidas.delete(token);
      return { ok: true, url: baseDe(req) + j.url, tipo: j.contentType, bytes: j.size,
        siguiente: "Usa esta url como medio_url en programar_publicacion (tipo reel para un vídeo vertical)." };
    });
  });
}
