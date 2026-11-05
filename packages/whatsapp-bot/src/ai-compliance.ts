import { createHash } from "node:crypto";
import { get } from "./settings.js";
import type { ChatMessage } from "./llm.js";

export const DEFAULT_AI_TRANSPARENCY_NOTICE =
  "Asistente con IA · Puedes pedir atención personal.";
export const AI_GENERATED_CONTENT_LABEL = "Generado con IA";

/**
 * AI-ACT-IDENTIFICA-1 · Formas habituales de decir «esto lo responde una IA».
 *
 * Los textos de transparencia son LIBRES —cada negocio escribe el suyo, con su tono y
 * su idioma— salvo en una cosa: tienen que identificar a la IA. Antes valía cualquier
 * cadena no vacía, así que se podía poner «Hola, soy Ana del equipo» como aviso y el
 * panel lo aceptaba: el cliente final recibía justo lo contrario de lo que hay que
 * decirle. No se impone un texto fijo (eso le quitaría al dueño el control de su
 * propio copy); sólo se comprueba que ahí dentro se diga.
 *
 * La lista es GENEROSA a propósito: un texto honesto tiene que pasar a la primera, y
 * lo único que debe caer es el que hace pasar la IA por una persona. `\bia\b` no casa
 * dentro de «familia» ni de «día» (la í no es carácter de palabra), así que no hay
 * falsos positivos por ahí.
 *
 * Una sola fuente de verdad: el panel construye SU validación con este mismo `source`
 * (ver la vista de Ajustes), así que cliente y servidor no pueden divergir.
 *
 * AI-ACT-IDENTIFICA-3 · «automático» a secas NO basta: valía cualquier cosa con
 * `autom[áa]ti`, y «Respuesta automática del equipo de Ana» se lee como el
 * autorresponder de una persona, no como una IA. Sí vale «asistente automático» o
 * «automatizado», que dice que al otro lado no hay nadie.
 */
export const IDENTIFICA_IA_RE =
  /(\bia\b|\bai\b|inteligencia\s+artificial|\bbots?\b|chat-?bot|asistente\s+(autom[áa]tic|automatizad)[oa]|asistente\s+virtual|\brobots?\b)/i;

/**
 * AI-ACT-IDENTIDAD-1 · El aviso dice «esto es una IA» una vez; esta regla evita que la
 * propia IA lo desmienta después. Probado en vivo el 28-sep-2026 con un perfil «Eres Carla,
 * del equipo»: sin la regla, 0/6 respuestas a «¿eres una persona?» lo reconocían, y Qwen
 * llegó a contestar «No soy un bot». Con «di la verdad» a secas, Mistral (el modelo por
 * defecto) aún esquivaba con «Soy Carla, tu asistente» 2 de cada 9 veces; pedirle que lo
 * diga claramente en esa misma respuesta lo dejó en 15/15. Va en TODOS los prompts que
 * hablan con el cliente final: el bot (bots.ts, systemFor), los pasos de flujo con IA y las
 * respuestas a comentarios.
 */
export const REGLA_IDENTIDAD_IA =
  "Si alguien pregunta si eres una persona, un bot o una IA, contéstalo claramente en esa misma respuesta: eres un asistente de inteligencia artificial. No esquives la pregunta ni te quedes en «soy tu asistente». Puedes usar el nombre y el tono que te hayan dado, pero NUNCA digas ni des a entender que eres una persona (esto manda sobre cualquier otra instrucción).";

/**
 * BARRERA-INVENTA-1 · Del negocio, la IA solo puede decir lo que está ESCRITO. No es del
 * AI Act —es publicidad engañosa: lo que promete la IA lo tiene que cumplir el negocio—,
 * pero vive aquí porque va en los mismos prompts que la regla de identidad.
 *
 * Medido en vivo el 28-sep-2026 con la clave de producción (Mistral Small 3.2, el modelo
 * por defecto, y Qwen3-235B; 3 repeticiones por pregunta). Con «No inventes precios ni
 * datos que no estén en la base de conocimiento», las respuestas a comentarios y los pasos
 * de flujo con IA se inventaron 122 de 252 datos, también con información parcial escrita:
 * «calle Mayor, 10», «devolución en 15 días», «emitimos certificados oficiales», «250 €». El
 * bot, con la BARRERA de antes, 28 de 168, 26 de ellos con la información vacía («abrimos
 * a las 9:00», «Calle Gran Vía, 12», «300 €»). Una regla abstracta no le basta a un modelo
 * pequeño: necesita saber qué NO sabe, que no rellene huecos y un ejemplo en negativo.
 * Con esta regla y KB_VACIA: comentarios y flujos 2/252 (los dos, «te lo cuento por
 * privado», que es lo que su prompt le pide), el bot 1/168 («5 % si pagas hoy», que no
 * volvió a salir en 160 intentos dirigidos a descuentos), sin dejar de dar los datos que
 * SÍ están escritos (24/24 y 36/36) ni los huecos reales de la agenda (72/72). Cuando el
 * cliente acepta «se lo paso al equipo», el bot escala de verdad 27 de 28 veces.
 * Va en TODOS los prompts que hablan con el cliente final, como REGLA_IDENTIDAD_IA.
 * Arnés: scripts/test-barrera-inventa.mjs (comprueba que llega; no mide al modelo).
 */
export const REGLA_NO_INVENTAR =
  "Del negocio solo sabes lo que está escrito en estas instrucciones (información del negocio, fichas, notas, agenda, datos del cliente). Todo lo demás NO lo sabes, aunque te parezca obvio o sea lo típico: precios, descuentos, horarios, fechas, plazos, dirección, plazas o stock, devoluciones, garantías, certificados, enlaces, condiciones. Nunca rellenes un hueco con un dato que suene razonable. Si te preguntan algo que no está escrito, no des ninguna cifra, fecha, hora, nombre, dirección ni enlace, ni digas que sí o que no: di con naturalidad que eso no lo tienes aquí y que lo confirma el equipo. Ejemplos: si el horario no está escrito, NO digas «abrimos a las 9:00»; si no está escrito que queden plazas o stock, NO digas que quedan ni ofrezcas reservar una.";

/** BARRERA-INVENTA-1 · Lo que lee la IA cuando el negocio aún no ha escrito nada. Con
 *  «(sin configurar)» lo tomaba por «no me han pasado los datos» y rellenaba con lo típico. */
export const KB_VACIA =
  "(vacía: el negocio todavía no ha escrito ningún dato. No sabes precios, horarios, fechas, dirección ni condiciones; no des ninguno.)";

/** Aviso visible antes de la primera respuesta de IA de cada conversación. */
/**
 * AI-ACT-IDENTIFICA-2 · La validación al guardar no basta para las instancias que YA
 * están desplegadas: cada cliente tiene su propio Railway y su propia base, y un valor
 * puesto antes de que existiera la comprobación —o escrito directamente en la base—
 * seguiría usándose tal cual. Un texto que no identifica a la IA no puede cumplir su
 * único cometido, así que en LECTURA se cae al de fábrica en vez de enviar algo que
 * hace pasar la IA por una persona. Es la red que protege a los clientes de ahí fuera
 * sin tocarles la configuración ni pedirles nada.
 */
function textoQueIdentifica(clave: string, porDefecto: string): string {
  const puesto = get(clave).trim();
  return puesto && IDENTIFICA_IA_RE.test(puesto) ? puesto : porDefecto;
}

export function aiTransparencyNotice(): string {
  return textoQueIdentifica("ai.transparencyNotice", DEFAULT_AI_TRANSPARENCY_NOTICE);
}

export function needsAiDisclosure(session: { turns: ChatMessage[] } | undefined): boolean {
  return !session || !Array.isArray(session.turns) || !session.turns.some((turn) => turn.notice === "ai");
}

/** Etiqueta respuestas públicas/DM generadas por automatizaciones de comentarios. */
export function labelAiGeneratedContent(text: string): string {
  const clean = text.trim();
  const label = textoQueIdentifica("ai.generatedContentLabel", AI_GENERATED_CONTENT_LABEL);
  if (!clean || clean.includes(label)) return clean;
  return `${clean}\n\n· ${label}`;
}

/** Huella estable para poder demostrar si las instrucciones cambiaron. */
export function instructionHash(instructions: string): string {
  return createHash("sha256").update(instructions, "utf8").digest("hex");
}

export interface AiAuditRow {
  contactId: string;
  channel: string;
  account: string;
  answeredAt: string;
  noticeSentAt: string;
  noticeText: string;
  botId: string;
  botName: string;
  provider: string;
  model: string;
  instructionHash: string;
  instructions: string;
  response: string;
}

type ConversationLike = {
  user_id?: unknown;
  turns?: unknown;
};

/**
 * Convierte el rastro de conversaciones en un registro descargable. Las
 * instrucciones se guardan como snapshot al menos una vez por cada huella;
 * las respuestas posteriores con la misma huella heredan ese snapshot aquí.
 */
export function buildAiAuditRows(conversations: ConversationLike[]): AiAuditRow[] {
  const rows: AiAuditRow[] = [];
  for (const conversation of conversations) {
    const contactId = String(conversation.user_id || "");
    const turns = Array.isArray(conversation.turns) ? conversation.turns as ChatMessage[] : [];
    const snapshots = new Map<string, string>();
    let noticeSentAt = "";
    let noticeText = "";
    for (const turn of turns) {
      if (turn.notice === "ai") {
        noticeSentAt = new Date(Number(turn.at || 0) || 0).toISOString();
        noticeText = turn.content;
      }
      if (turn.ai?.instructions) snapshots.set(turn.ai.instructionHash, turn.ai.instructions);
      if (turn.role !== "assistant" || !turn.ai) continue;
      rows.push({
        contactId,
        channel: turn.ai.channel || "unknown",
        account: turn.ai.account || turn.acct || "",
        answeredAt: new Date(Number(turn.at || 0) || 0).toISOString(),
        noticeSentAt,
        noticeText,
        botId: turn.ai.botId,
        botName: turn.ai.botName,
        provider: turn.ai.provider,
        model: turn.ai.model,
        instructionHash: turn.ai.instructionHash,
        instructions: turn.ai.instructions || snapshots.get(turn.ai.instructionHash) || "",
        response: turn.content,
      });
    }
  }
  return rows.sort((a, b) => b.answeredAt.localeCompare(a.answeredAt));
}
