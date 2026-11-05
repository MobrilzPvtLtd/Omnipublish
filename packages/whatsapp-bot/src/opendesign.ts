/**
 * Cliente de Open Design (estudio de diseño IA self-hosted en Railway).
 *
 * Genera HTML llamando al daemon de Open Design a través de su proxy BYOK a
 * Gemini. La cadena es: business-stack -> nginx (basic auth) -> daemon ->
 * Gemini (modelo 2.5). El daemon inyecta su OD_API_TOKEN; nosotros solo
 * mandamos basic auth + la API key de Gemini en el cuerpo.
 *
 * CONFIG-DEL-PANEL-1 · La config vive en los ajustes del panel, con la variable
 * de entorno solo como respaldo (la cascada de settings.ts). Antes se leía
 * `process.env` AL IMPORTAR el módulo: no se podía tocar nada sin acceso al
 * Railway, y cambiar la clave obligaba a redesplegar. Ahora se lee en cada
 * llamada, así que guardar en el panel surte efecto al instante.
 *
 *   opendesign.url         (OD_URL)         URL del servicio Open Design
 *   opendesign.user        (OD_USER)        usuario basic auth
 *   opendesign.pass        (OD_PASS)        contraseña basic auth · secreta
 *   opendesign.geminiKey   (OD_GEMINI_KEY)  API key de Google Gemini · secreta
 *   opendesign.model       (OD_MODEL)       por defecto gemini-2.5-flash
 *   opendesign.geminiBase  (OD_GEMINI_BASE)
 */
import { get as getSetting } from "./settings.js";

const odUrl = (): string => (getSetting("opendesign.url") || "").replace(/\/+$/, "");
const odUser = (): string => getSetting("opendesign.user") || "";
const odPass = (): string => getSetting("opendesign.pass") || "";
const odGeminiKey = (): string => getSetting("opendesign.geminiKey") || "";
const odModel = (): string => getSetting("opendesign.model") || "gemini-2.5-flash";
const odGeminiBase = (): string =>
  getSetting("opendesign.geminiBase") || "https://generativelanguage.googleapis.com";

const DESIGN_SYSTEM_PROMPT =
  "Eres un diseñador web senior. Devuelves SIEMPRE una única página HTML " +
  "completa y autocontenida (HTML + CSS en una etiqueta <style>), moderna, " +
  "responsive y atractiva. No incluyas explicaciones ni texto fuera del " +
  "HTML, ni vallas de código markdown.";

export function opendesignConfigured(): boolean {
  return !!(odUrl() && odUser() && odPass() && odGeminiKey());
}

export function opendesignModel(): string {
  return odModel();
}

/** Limpia la salida del modelo: quita vallas ```html y recorta al documento. */
function cleanHtml(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const lower = t.toLowerCase();
  const docIdx = lower.indexOf("<!doctype");
  const htmlIdx = lower.indexOf("<html");
  const start = docIdx >= 0 ? docIdx : htmlIdx;
  const end = lower.lastIndexOf("</html>");
  if (start >= 0 && end >= 0) return t.slice(start, end + 7).trim();
  return t;
}

export interface GenerateResult {
  ok: boolean;
  html?: string;
  model?: string;
  ms?: number;
  error?: string;
}

export interface GenerateOpts {
  model?: string;
  maxTokens?: number;
  system?: string;
  timeoutMs?: number;
}

export async function generateDesign(
  prompt: string,
  opts: GenerateOpts = {},
): Promise<GenerateResult> {
  if (!opendesignConfigured()) {
    return {
      ok: false,
      error:
        "El estudio de diseño no está configurado. Rellena su URL, usuario, contraseña y clave de Gemini en Ajustes (opendesign.*).",
    };
  }
  const model = opts.model || odModel();
  const payload = {
    baseUrl: odGeminiBase(),
    apiKey: odGeminiKey(),
    model,
    systemPrompt: opts.system || DESIGN_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
    maxTokens: opts.maxTokens || 8000,
  };
  const auth = "Basic " + Buffer.from(`${odUser()}:${odPass()}`).toString("base64");
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 120000);
  let raw = "";
  try {
    const resp = await fetch(`${odUrl()}/api/proxy/google/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return {
        ok: false,
        model,
        ms: Date.now() - t0,
        error: `Open Design respondió ${resp.status}: ${txt.slice(0, 300)}`,
      };
    }
    raw = await resp.text();
  } catch (e) {
    const err = e as Error;
    return {
      ok: false,
      model,
      ms: Date.now() - t0,
      error:
        err.name === "AbortError"
          ? "Timeout esperando a Open Design (>120s)."
          : "No se pudo conectar a Open Design: " + err.message,
    };
  } finally {
    clearTimeout(timer);
  }

  // Parsear el stream SSE acumulado: bloques separados por línea en blanco,
  // cada uno con "event:" y "data:" (JSON). El HTML se acumula de los delta.
  let out = "";
  let streamErr = "";
  for (const block of raw.split("\n\n")) {
    let ev = "";
    let dataLine = "";
    for (const rawLine of block.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
    }
    if (!dataLine) continue;
    let data: { delta?: unknown; message?: unknown; error?: { message?: unknown } };
    try {
      data = JSON.parse(dataLine);
    } catch {
      continue;
    }
    if (ev === "delta" && typeof data.delta === "string") {
      out += data.delta;
    } else if (ev === "error") {
      const m = data?.error?.message ?? data?.message;
      streamErr = typeof m === "string" ? m : "Error del proveedor.";
    }
  }

  const ms = Date.now() - t0;
  if (streamErr) return { ok: false, model, ms, error: streamErr };
  const html = cleanHtml(out);
  if (!html) return { ok: false, model, ms, error: "El modelo devolvió una respuesta vacía." };
  return { ok: true, html, model, ms };
}
