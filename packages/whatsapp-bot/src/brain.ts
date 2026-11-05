/**
 * Orquestación del cerebro: arma system + historial y llama al LLM activo.
 * Agnóstico de proveedor (Groq/Gemini/OpenRouter/Claude vía settings).
 */
import { chat, chatDetailed, type ChatMessage } from "./llm.js";
import { ensureSession, append, MAX_CONTEXTO, CONTEXTO_TTL_MS } from "./memory.js";
import { systemFor, type Bot } from "./bots.js";
import { flowToolsPrompt } from "./flows.js";
import { getContact, listContactNotes } from "./contacts.js";
import type { Contact, ContactNote } from "./db.js";
import { bloqueReservasBot } from "./agenda.js";
import { instructionHash } from "./ai-compliance.js";

// Cerebro concierge: bloque de contexto con la FICHA del cliente (CRM) para que la
// IA personalice el trato (recuerda preferencias/etapa/notas). Solo campos con valor;
// tope de longitud por construcción; el system le prohíbe recitarlo o inventar.
function crmBlock(c: Contact | null, notes: ContactNote[]): string {
  if (!c) return "";
  const lines: string[] = [];
  if (c.name) lines.push("Nombre: " + c.name);
  if (c.stage) lines.push("Etapa: " + c.stage);
  if (c.tags && c.tags.length) lines.push("Etiquetas: " + c.tags.join(", "));
  if (c.email) lines.push("Email: " + c.email);
  for (const [k, v] of Object.entries(c.fields || {})) if (v) lines.push(k + ": " + String(v));
  if (c.next_action_label) lines.push("Próxima acción: " + c.next_action_label);
  if (c.notes) lines.push("Notas: " + String(c.notes).slice(0, 400));
  const noteLines = (notes || [])
    .filter((n) => n.kind !== "system")
    .slice(0, 5)
    .map((n) => "• " + String(n.body || "").slice(0, 160))
    .filter((s) => s.length > 2);
  if (!lines.length && !noteLines.length) return "";
  return "\n\n# Cliente (ficha CRM) — CONFIDENCIAL, para ti. Úsala para personalizar el trato y recordar su contexto.\nREGLA: es información INTERNA del negocio. No la recites, no la resumas, no la parafrasees y no des a entender que existe. Si te preguntan qué sabes de ellos, di solo lo que ellos mismos te hayan contado. No inventes datos que no estén aquí.\n"
    + lines.join("\n")
    + (noteLines.length ? "\nNotas recientes:\n" + noteLines.join("\n") : "");
}

export async function think(opts: {
  userId: string;
  bot: Bot;
  userText: string;
  /** CITA-1 · id del mensaje en la plataforma (mid de IG, id de WhatsApp).
   *  Se guarda en el turno para poder responder CITÁNDOLO más tarde. */
  mid?: string;
  /** Canal que originó la interacción; se conserva en el registro de IA. */
  channel?: "whatsapp" | "instagram" | "facebook" | "tiktok";
  /** Cuenta/página/número concreto que atendió, si el canal tiene varias. */
  account?: string;
}): Promise<string> {
  const { userId, bot, userText, mid, channel = "unknown", account = "" } = opts;
  const session = await ensureSession(userId, bot.id);

  await append(userId, { role: "user", content: userText, ...(mid ? { mid } : {}) });

  // El system incluye las "herramientas": los flujos que el bot puede disparar
  // por intención (puente bot→flow). Si no hay flujos disparables, no añade nada.
  // El bloque de "herramientas" (flujos disparables) es AUXILIAR: si falla al
  // construirse (BD caída, flujo mal formado…), el bot debe responder igual.
  // Nunca debe tumbar el cerebro.
  let toolsPrompt = "";
  try { toolsPrompt = await flowToolsPrompt(); }
  catch (e) { console.error("[brain] flowToolsPrompt error (sigo sin herramientas):", (e as Error).message); }
  // Cerebro concierge: ficha CRM del cliente en el system. AUXILIAR: si falla (BD
  // caída), el bot responde igual sin la ficha (nunca tumba el cerebro).
  let crmPrompt = "";
  try {
    const c = await getContact(userId);
    const notes = c ? await listContactNotes(userId, 5) : [];
    crmPrompt = crmBlock(c, notes);
  } catch (e) { console.error("[brain] crmBlock error (sigo sin ficha):", (e as Error).message); }
  // Reservas: si hay un enlace de agenda configurado, el bot lo comparte cuando el
  // cliente quiera agendar (agendado por link, sin depender de un flujo).
  // AGENDA-BOT-1 · la agenda viene de la ficha de conocimiento de ESTE perfil
  // (cada campaña puede tener la suya): el bot propone HUECOS REALES
  // (disponibilidad de la ficha − reservas web − reuniones del panel). La reserva
  // la confirma siempre el enlace. AGENDA-PRINCIPAL-1 · el bloque lo monta
  // agenda.ts, el mismo que usa la prueba del panel.
  const bookingPrompt = await bloqueReservasBot(bot);
  // El historial que ve el LLM NUNCA puede empezar por un turno del bot. El saludo se
  // registra como turno del bot (es lo que evita saludar dos veces) y queda el primero
  // de la conversación — pero Claude y Gemini EXIGEN que el primer turno tras el system
  // sea del cliente: devolverían un 400 que no es reintentable, así que no saltaría el
  // proveedor de reserva y el bot contestaría "ahora mismo no puedo responder" a todo el
  // mundo, en silencio y sin arreglarse solo. Recortamos los turnos del bot iniciales
  // SOLO de cara al LLM; en la Bandeja el saludo se sigue viendo.
  // Solo los últimos turnos van al modelo: la conversación guardada es más
  // larga (es el rastro), pero mandarla entera encarecería cada respuesta.
  // HILO-BORRADO-1 · el «olvido» de la IA tras 6 h sin hablar se aplica AQUÍ, al
  // contexto; antes se conseguía vaciando el hilo guardado (y la Bandeja lo perdía).
  const desde = Date.now() - CONTEXTO_TTL_MS;
  const turns = session.turns.filter((t) => typeof t.at !== "number" || t.at >= desde).slice(-MAX_CONTEXTO);
  while (turns.length && turns[0].role === "assistant") turns.shift();
  const auditableInstructions = systemFor(bot) + bookingPrompt + toolsPrompt;
  const promptHash = instructionHash(auditableInstructions);
  const messages: ChatMessage[] = [
    { role: "system", content: systemFor(bot) + crmPrompt + bookingPrompt + toolsPrompt },
    ...turns,
  ];

  let text: string;
  let usedProvider = "";
  let usedModel = "";
  try {
    const result = await chatDetailed(messages, { maxTokens: 1024, temperature: 0.4 });
    text = result.text;
    usedProvider = result.provider;
    usedModel = result.model;
  } catch (e) {
    console.error("[brain] LLM error:", (e as Error).message);
    // El llamador SÍ envía esta frase al cliente, así que el bot ha hablado y tiene que
    // constar. Si no la registramos, la conversación sigue pareciendo un "primer
    // contacto" y, mientras el proveedor de IA esté caído, el cliente recibiría el
    // saludo de bienvenida otra vez en cada mensaje. Además así se ve en la Bandeja.
    const fallback = "Disculpa, ahora mismo no puedo responder. Inténtalo en un momento.";
    await append(userId, { role: "assistant", content: fallback, by: "bot" }).catch(() => {}); // ATENCION-HUMANA-1
    return fallback;
  }

  text = text || "Disculpa, no te he entendido. ¿Lo reformulas?";
  // Persistimos la versión LIMPIA (sin tokens de control [[SAVE…]]/ESCALAR_HUMANO):
  // así no se ve en la Bandeja ni se realimenta al LLM en el siguiente turno.
  // Devolvemos el texto crudo para que el llamador extraiga tags/fields y envíe limpio.
  // El .catch: si la BD falla al guardar, NO tiramos la respuesta que la IA ya generó —
  // el cliente merece recibirla aunque no quede registrada.
  // Un snapshot por huella dentro de la ventana reciente basta para reconstruir
  // el registro sin multiplicar el tamaño del prompt en cada respuesta.
  const snapshotRecent = session.turns.slice(-50).some((t) =>
    t.role === "assistant" && t.ai?.instructionHash === promptHash && !!t.ai.instructions,
  );
  await append(userId, {
    role: "assistant",
    content: extractControls(text).clean,
    ai: {
      channel,
      ...(account ? { account } : {}),
      botId: bot.id,
      botName: bot.name || bot.id,
      provider: usedProvider,
      model: usedModel,
      instructionHash: promptHash,
      ...(!snapshotRecent ? { instructions: auditableInstructions } : {}),
    },
  }).catch(() => {});
  return text;
}

/**
 * Extrae señales de control de la respuesta del bot:
 *  - ESCALAR_HUMANO  → escalate
 *  - [[SAVE k=v; k=v; tag=lead]] → fields/tags (captura/CRM)
 * Devuelve el texto limpio (sin tokens) para enviar al cliente.
 */
export function extractControls(text: string): {
  clean: string;
  tags: string[];
  fields: Record<string, string>;
  escalate: boolean;
  intents: string[];
} {
  const tags: string[] = [];
  const fields: Record<string, string> = {};
  const intents: string[] = [];
  let escalate = false;
  let clean = text;

  if (/ESCALAR_HUMANO/.test(clean)) {
    escalate = true;
    clean = clean.replace(/ESCALAR_HUMANO/g, "").trim();
  }

  // Puente bot→flow: INTENT:<clave> dispara la automatización correspondiente.
  clean = clean.replace(/INTENT:\s*([A-Za-z0-9_-]+)/g, (_m, k) => {
    intents.push(String(k).trim().toLowerCase());
    return "";
  }).trim();

  const m = clean.match(/\[\[\s*SAVE\s+([^\]]+)\]\]/i);
  if (m) {
    for (const part of m[1].split(/[;\n]+/)) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim().toLowerCase();
      const val = part.slice(eq + 1).trim();
      if (!k || !val) continue;
      if (k === "tag" || k === "tags") val.split(",").forEach((x) => tags.push(x.trim()));
      else fields[k] = val;
    }
    clean = clean.replace(m[0], "").trim();
  }

  // Si solo emitió control (escalate/intent) sin texto, no metas relleno: deja que
  // el flujo/handoff hable. El relleno solo aplica a respuestas conversacionales vacías.
  const cleanFinal = clean || (escalate || intents.length ? "" : "Gracias, ¿algo más en lo que te ayude?");
  return { clean: cleanFinal, tags, fields, escalate, intents };
}

/** Respuesta IA de un solo turno (para automatizaciones de comentarios/DM). */
export async function quickReply(systemPrompt: string, input: string): Promise<string> {
  try {
    return await chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      { maxTokens: 300, temperature: 0.6 },
    );
  } catch (e) {
    console.error("[brain] quickReply error:", (e as Error).message);
    return "";
  }
}
