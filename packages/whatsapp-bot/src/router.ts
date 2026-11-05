/**
 * Enrutado IA: el LLM lee el primer mensaje del cliente y decide qué bot/rol
 * lo atiende. Si el LLM falla o devuelve algo raro, cae a routeBot (keywords)
 * y, en último término, al primer bot del array.
 */
import { chat } from "./llm.js";
import { getBots, routeBotConMotivo, type Bot, type ViaRespaldo } from "./bots.js";

/**
 * ELEGIR-PERFIL-1 (BOT-05) · Cómo se elige el perfil de una conversación NUEVA
 * cuando ni la conversación ni la cuenta tienen perfil fijo. Una sola función
 * para el motor (classifyBot) y para el simulador del panel, con el motivo:
 *
 *   ninguno → no hay perfiles activos: no contesta nadie.
 *   unico   → solo hay UN perfil activo: contesta él, siempre, sin preguntar a
 *             la IA (aunque su descripción no encaje con el mensaje).
 *   ia      → con dos o más activos, la IA lee el mensaje y la descripción de
 *             cada perfil activo («¿Qué consultas atiende?»; si está vacía, el
 *             principio de sus instrucciones) y elige UNO. No existe la
 *             respuesta «no encaja ninguno»: siempre elige alguno.
 *   palabra / predeterminado / primero → la IA falló o contestó algo que no es
 *             un perfil activo de ESTE negocio: respaldo de routeBotConMotivo.
 */
export type ViaPerfil = "unico" | "ia" | ViaRespaldo;

export async function elegirPerfil(firstMessage: string): Promise<{ bot: Bot | null; via: ViaPerfil }> {
  // PERFIL-PAUSADO-2 · «pausado» significa que ese perfil no atiende a nadie.
  // La versión anterior repescaba a los pausados cuando no quedaba ninguno
  // activo («mejor un bot que un silencio»), y con eso un perfil pausado
  // contestaba a clientes reales. Si no hay ninguno activo, no atiende nadie:
  // el mensaje va a la Bandeja con el motivo escrito.
  const bots = getBots().filter((b) => b.enabled !== false);
  if (!bots.length) return { bot: null, via: "ninguno" };
  if (bots.length === 1) return { bot: bots[0], via: "unico" };

  const catalog = bots
    .map((b) => `- ${b.id}: ${b.description || b.system.slice(0, 120)}`)
    .join("\n");

  try {
    const out = await chat(
      [
        {
          role: "system",
          content:
            `Clasifica el mensaje del cliente en UNO de estos roles. ` +
            `Responde SOLO con el id exacto, sin nada más.\n\nRoles:\n${catalog}`,
        },
        { role: "user", content: firstMessage.slice(0, 500) },
      ],
      { maxTokens: 12, temperature: 0 },
    );
    const id = out.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    // Solo vale un perfil ACTIVO de este negocio: un id pausado, borrado o de
    // otro negocio no está en `bots` y cae al respaldo.
    const hit = bots.find((b) => b.id.toLowerCase() === id);
    if (hit) return { bot: hit, via: "ia" };
  } catch {
    /* cae al fallback */
  }
  return routeBotConMotivo(firstMessage);
}

export async function classifyBot(firstMessage: string): Promise<Bot | null> {
  return (await elegirPerfil(firstMessage)).bot;
}
