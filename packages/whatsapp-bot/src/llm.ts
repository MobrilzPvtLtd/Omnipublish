/**
 * Adaptador LLM agnóstico de proveedor. Usa la API estilo OpenAI
 * (chat.completions) que soportan Groq, Gemini (endpoint compatible),
 * OpenRouter, Anthropic y OpenAI. Se cambia de proveedor/modelo desde el
 * panel sin tocar código (ver settings.ts / resolveLlm).
 *
 * Resiliencia: si el primario devuelve 429 (rate limit), 5xx (caído) o se
 * queda sin tokens, intenta con el FALLBACK configurado en el panel. Mientras
 * el primario respira, el bot sigue contestando.
 */
import OpenAI from "openai";
import { resolveLlm, resolveLlmFallback } from "./settings.js";
import { logActivity } from "./activity.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  /** Imágenes de referencia (data URLs `data:image/...;base64,...` o URLs http)
   *  para mensajes multimodales (visión). Si se rellena, callOne envía el content
   *  como array [texto, image_url...] estilo OpenAI. Requiere modelo con visión
   *  (Gemini, GPT-4o, Claude, modelos vision de Groq/OpenRouter). */
  images?: string[];
  /** Marca de tiempo (epoch ms) del turno, para mostrar la hora en la Bandeja.
   *  Se ignora al llamar al LLM (callOne la elimina). */
  at?: number;
  /** MEDIA-BANDEJA-1 · Adjunto re-hospedado (foto/audio/vídeo/doc). Solo lo lee la
   *  Bandeja para pintar la burbuja; callOne reconstruye {role,content} y NUNCA se lo
   *  manda al modelo.
   *  OJO: no reutilizar `images` para esto — ese campo va como image_url multimodal y
   *  reenviaría la foto del cliente al LLM en cada llamada posterior (coste + error en
   *  modelos sin visión).
   *  BANDEJA-FIX-1 · deja de ser solo de ENTRANTES: el adjunto que manda el panel se
   *  guarda igual, con su nombre de fichero y su tamaño. `name` es lo que se enseña en
   *  la tarjeta del documento; `size` es lo que distingue dos ficheros del mismo tipo
   *  al deduplicar el eco; `caption` es el pie de foto que acompañaba al envío. */
  att?: { id?: string; kind: string; mime?: string; state: "ok" | "failed"; reason?: string; name?: string; size?: number; caption?: string };
  /** CITA-1 · id del mensaje en la plataforma (mid de Instagram, id de WhatsApp).
   *  Lo necesitamos para poder responder CITANDO de verdad. callOne lo ignora. */
  mid?: string;
  /** ACUSE-FUSION-1 · identificadores adicionales del mismo mensaje, cuando la
   *  fusión de duplicados (memory.ts · fundirTurno) encontró que las dos copias
   *  traían CADA UNA su propio id real (dos vías, dos acuses distintos). El estado
   *  de entrega se busca por `mid` y, si no aparece, por cada uno de éstos — así
   *  ninguno de los dos acuses que WhatsApp sí mandó se queda sin encontrarse. */
  midsAlt?: string[];
  /** CITA-1 · mensaje al que responde este turno (lo pinta la Bandeja). */
  re?: { role?: string; text?: string; mid?: string; at?: number };
  /** REENVIAR-1 · el mensaje llegó reenviado desde otra conversación. */
  fwd?: boolean;
  /** T02 · cuenta emisora de un turno SALIENTE ('wa:<phoneNumberId>'): desde qué
   *  número del workspace se envió. Solo informativo (Bandeja); callOne lo ignora. */
  acct?: string;
  /** Estado asíncrono de entrega de WhatsApp, añadido al leer la Bandeja. No se
   * persiste en el turno ni se envía al modelo. */
  delivery?: {
    status: "accepted" | "sent" | "delivered" | "read" | "failed";
    status_at: number;
    error_code?: string;
    error_detail?: string;
    error_kind?: "ventana" | "limite" | "plantilla" | "permanente" | "temporal" | "auth";
    error_human?: string;
  };
  /** REACCIONES-1 · reacciones vigentes a este turno (una por lado como mucho: la
   *  del contacto y/o la del agente), añadidas al leer la Bandeja igual que
   *  `delivery`. No se persiste en el turno ni se envía al modelo. */
  rx?: { from_role: "contact" | "agent"; emoji: string; reacted_at: number }[];
  /** PLANTILLA-BANDEJA-1 · botones que acompañaron a un turno SALIENTE (interactive
   *  de WhatsApp, quick replies o plantilla de botón de IG/FB, botones de una
   *  plantilla aprobada). t=etiqueta visible; u=URL si el botón abría un enlace.
   *  Solo los pinta la Bandeja; callOne los ignora. */
  btns?: { t: string; u?: string }[];
  /** PLANTILLA-BANDEJA-1 · nombre de la plantilla aprobada de WhatsApp con la que
   *  salió el turno (la Bandeja pinta una insignia discreta). callOne lo ignora. */
  tpl?: string;
  /** ATENCION-HUMANA-1 (MET-WA-06) · quién escribió un turno SALIENTE, para separar en
   *  Métricas la atención humana de lo automático. equipo = desde el panel; movil = escrito
   *  en el móvil (eco de la app verde o del QR); bot = mensaje fijo del bot (saludo, fuera de
   *  horario); flujo = paso de un flujo; difusion = envío por lote. La respuesta de la IA se
   *  reconoce por `ai`/`notice`. Sin marca = anterior a este cambio. callOne lo ignora. */
  by?: "equipo" | "movil" | "bot" | "flujo" | "difusion";
  /** AI-ACT-1 · aviso de transparencia enviado antes de la primera respuesta IA. */
  notice?: "ai";
  /** AI-ACT-1 · trazabilidad de una respuesta generada. No se manda al modelo. */
  ai?: {
    channel: string;
    account?: string;
    botId: string;
    botName: string;
    provider: string;
    model: string;
    instructionHash: string;
    /** Snapshot periódico; evita repetir prompts grandes en todos los turnos. */
    instructions?: string;
  };
};

export interface ChatResult {
  text: string;
  provider: string;
  model: string;
}

interface LlmCreds {
  provider: string;
  baseURL: string;
  model: string;
  apiKey: string;
}

// Cliente OpenAI dedicado por baseURL/apiKey (Set evita reinstanciar en cada chat).
const clientCache = new Map<string, OpenAI>();
function getClient(creds: LlmCreds): OpenAI {
  const k = `${creds.baseURL}|${creds.apiKey.slice(-8)}`;
  let c = clientCache.get(k);
  if (c) return c;
  c = new OpenAI({
    apiKey: creds.apiKey,
    baseURL: creds.baseURL,
    // Sin timeout, un proveedor colgado (free tiers saturados: NVIDIA NIM 503/
    // cuelgues >45s observados) retiene la respuesta minutos y el fallback nunca
    // salta. 30s + 1 retry: "Request timed out" casa con isRetryable → fallback.
    timeout: 30_000,
    maxRetries: 1,
    defaultHeaders: {
      "HTTP-Referer": "https://railway.app",
      "X-Title": "digital-business-stack",
    },
  });
  clientCache.set(k, c);
  return c;
}

// Errores recuperables que justifican intentar el fallback (no fallar al user).
function isRetryable(err: unknown): boolean {
  const msg = (err as Error)?.message || "";
  // 429 = rate limit · 5xx = servidor del proveedor caído · ECONNRESET/timeout = red
  if (/\b429\b/.test(msg)) return true;
  if (/\b5\d\d\b/.test(msg)) return true;
  if (/rate.?limit/i.test(msg)) return true;
  if (/timeout|ECONN|ETIMEDOUT|fetch failed|network/i.test(msg)) return true;
  // MODELO-RETIRADO-1 · El caso que motivó tener respaldo era justo este —el
  // proveedor jubila un modelo— y era el único que NO lo activaba: un 404
  // «model does not exist» no es 429 ni 5xx, así que el bot moría con el
  // primario en vez de pasar al respaldo. (Incidente Groq/Llama, 2026-08.)
  if (/\b404\b|does not exist|not found|decommissioned|deprecated|model_not_found|unknown model|invalid_model/i.test(msg)) return true;
  return false;
}

async function callOne(
  creds: LlmCreds,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; json?: boolean; timeoutMs?: number },
): Promise<string> {
  const client = getClient(creds);
  const _imgCount = messages.reduce((n, m) => n + (m.images?.length || 0), 0);
  if (_imgCount) console.log(`[LLM vision] ${creds.provider}/${creds.model} · ${_imgCount} imagen(es) adjuntas · json=${!!opts.json}`);
  const baseBody = {
    model: creds.model,
    messages: messages.map((m) => {
      // Mensaje multimodal: texto + imágenes (visión). Solo si trae images.
      if (m.images && m.images.length) {
        return {
          role: m.role,
          content: [
            { type: "text", text: m.content },
            ...m.images.map((u) => ({ type: "image_url", image_url: { url: u } })),
          ],
        };
      }
      return { role: m.role, content: m.content };
    }) as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.4,
  };
  // ASISTENTE-PLAZO-1 · los 30 s del cliente son para el bot de WhatsApp; quien
  // espera más (el Asistente con imágenes y un historial largo) pide su plazo.
  const reqOpts = opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined;
  try {
    const res = await client.chat.completions.create(
      opts.json
        ? { ...baseBody, response_format: { type: "json_object" as const } }
        : baseBody,
      reqOpts,
    );
    return res.choices[0]?.message?.content?.trim() || "";
  } catch (e) {
    // Si falla por response_format (modelo no lo soporta), reintenta sin él
    // ANTES de propagar (esto NO es un error de proveedor que justifique fallback).
    // «Failed to generate JSON» y «Failed to validate JSON» son los 400 del
    // modo JSON de Groq con modelos razonadores (gpt-oss): mismo remedio,
    // pedir sin response_format y que extraerJson/el caller pesque el objeto.
    if (opts.json && /response_format|json_object|unsupported|failed to (generate|validate)/i.test((e as Error).message)) {
      const res = await client.chat.completions.create(baseBody, reqOpts);
      return res.choices[0]?.message?.content?.trim() || "";
    }
    throw e;
  }
}

export async function chatDetailed(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; json?: boolean; model?: string; timeoutMs?: number } = {},
): Promise<ChatResult> {
  // IA-POTENCIA-1 · un encargo puede pedir otro modelo del MISMO proveedor (misma
  // clave). Si ese modelo falla, el respaldo es el modelo normal del panel.
  const base = resolveLlm();
  const primary = opts.model ? { ...base, model: opts.model } : base;
  if (!primary.apiKey) {
    // DISENO-1 · el texto llega tal cual al cliente (Carruseles, bots…): sin «API key», sin el
    // nombre del proveedor ni «variable de entorno». El panel ofrece «Activar la IA» al leerlo.
    throw new Error(
      `Falta activar la IA: pega la clave de tu proveedor de IA en «Activar la IA».`,
    );
  }
  try {
    return { text: await callOne(primary, messages, opts), provider: primary.provider, model: primary.model };
  } catch (e) {
    // No es recuperable → propaga al caller (think() decide qué hacer). Pero
    // ANTES se registra: este es el fallo MÁS probable en producción (clave
    // mala, modelo inexistente, 400) y era justo el único que no dejaba ni una
    // línea en el Centro de Actividad — el dueño no podía enterarse de que la
    // IA llevaba días muda, porque el throw iba delante de todos los logs.
    if (!isRetryable(e)) {
      await logActivity({
        source: "llm",
        level: "error",
        summary: `La IA no pudo responder: ${(e as Error).message.slice(0, 140)}`,
        payload: { proveedor: primary.provider, modelo: primary.model, recuperable: false },
      }).catch(() => {});
      throw e;
    }
    // Intenta el fallback si está configurado.
    const fallback = opts.model && opts.model !== base.model ? base : resolveLlmFallback();
    if (!fallback) {
      // Log discreto: primario reventó y no hay backup. El user verá el 429 igual.
      console.warn(
        `[llm] primary '${primary.provider}' falló (${(e as Error).message.slice(0, 100)}) y NO hay fallback configurado en Conexiones → LLM. Considera añadir un proveedor backup.`,
      );
      // FASE-5: telemetría — primary cayó sin fallback configurado.
      // No incluimos apiKey en payload (logActivity es side-effect; never throws).
      await logActivity({
        source: "llm",
        level: "error",
        status: "error",
        summary: `LLM primary '${primary.provider}' falló sin fallback: ${(e as Error).message.slice(0, 120)}`,
        payload: {
          file: "llm.ts",
          fn: "chat",
          provider: primary.provider,
          model: primary.model,
          baseURL: primary.baseURL,
          fallbackConfigured: false,
        },
      });
      throw e;
    }
    console.warn(
      `[llm] primary '${primary.provider}' falló (${(e as Error).message.slice(0, 80)}) → tirando fallback '${fallback.provider}' (${fallback.model}).`,
    );
    try {
      return { text: await callOne(fallback, messages, opts), provider: fallback.provider, model: fallback.model };
    } catch (e2) {
      // FASE-5: telemetría — toda la cadena fallback cayó.
      await logActivity({
        source: "llm",
        level: "error",
        status: "error",
        summary: `LLM primary '${primary.provider}' y fallback '${fallback.provider}' fallaron`,
        payload: {
          file: "llm.ts",
          fn: "chat",
          primary: { provider: primary.provider, model: primary.model, error: (e as Error).message.slice(0, 200) },
          fallback: { provider: fallback.provider, model: fallback.model, error: (e2 as Error).message.slice(0, 200) },
        },
      });
      // Fallback también revienta → mensaje contextual al caller.
      throw new Error(
        `LLM primary '${primary.provider}' y fallback '${fallback.provider}' han fallado. Primary: ${(e as Error).message.slice(0, 80)}. Fallback: ${(e2 as Error).message.slice(0, 80)}.`,
      );
    }
  }
}

/** API compatible para los call-sites que solo necesitan el texto. */
export async function chat(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; json?: boolean; model?: string; timeoutMs?: number } = {},
): Promise<string> {
  return (await chatDetailed(messages, opts)).text;
}
