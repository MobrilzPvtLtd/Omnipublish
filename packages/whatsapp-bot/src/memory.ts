/**
 * Memoria de conversación por usuario, persistida en Postgres con caché en
 * memoria para el camino caliente. Sin Postgres, solo memoria (no persiste).
 */
import type { ChatMessage } from "./llm.js";
import { dbGetConversation, dbSaveConversation } from "./db.js";
import { currentWorkspaceId } from "./workspace.js";
import { currentWaAcct } from "./whatsapp.js";

/** CHAT-POR-NUMERO-1 · Sella el turno con la cuenta WhatsApp del contexto (ALS de
 *  runWithWaNumber) si quien lo escribe no la puso explícita. Cubre de una vez el
 *  pipeline del bot, los ecos de la app verde, el historial de Coexistence y los
 *  flujos, que corren todos dentro de ese contexto. Fuera de WhatsApp devuelve ''
 *  y el turno queda como siempre. */
function sellarAcct(turn: ChatMessage): ChatMessage {
  if (turn.acct) return turn;
  const a = currentWaAcct();
  return a ? { ...turn, acct: a } : turn;
}

interface Session {
  botId: string;
  turns: ChatMessage[];
  updatedAt: number;
}

const cache = new Map<string, Session>();
const TTL_MS = 1000 * 60 * 60 * 6; // 6 h
/** Tras cuánto silencio la IA deja de tener en cuenta lo anterior (HILO-BORRADO-1). */
export const CONTEXTO_TTL_MS = TTL_MS;
// Dos cifras distintas para dos trabajos distintos. Antes era UNA sola y por
// eso el rastro de una conversación se borraba a los 30 mensajes: si un
// cliente se quejaba de lo que le dijo el bot, no había forma de comprobarlo
// (auditoría 2026-08-24).
/** Cuánto RECUERDA el bot al contestar. Subirlo encarece cada respuesta. */
export const MAX_CONTEXTO = 30;
/** Cuánto se GUARDA de la conversación. Es el rastro: no lo lee el modelo. */
export const MAX_GUARDADO = 400;

// SECURITY-FIX 2026-06-20 · la caché RAM se keya por tenant ADEMÁS del userId.
// Antes la clave era solo el userId (teléfono/PSID/IG-id) y el hit precedía a la
// BD (que sí filtra por tenant_id): el mismo número escribiendo a 2 negocios
// (2 workspaces) compartía historial/bot y corrompía datos cross-tenant. La BD
// ya keya por (tenant_id,user_id); esto alinea la RAM. Sin scope ⇒ 'default'
// (single-tenant idéntico a antes). Se evalúa por llamada (lee el ALS vivo).
const ckey = (userId: string): string => `${currentWorkspaceId()}:${userId}`;

export async function getSession(userId: string): Promise<Session | undefined> {
  const c = cache.get(ckey(userId));
  if (c && Date.now() - c.updatedAt <= TTL_MS) return c;

  const row = await dbGetConversation(userId);
  // SESION-CARRERA-1 (CTO-02) · mientras se leía la BD, otro mensaje del mismo contacto
  // pudo dejar ya su sesión en caché: se usa ESA. Si no, cada uno empuja su mensaje a su
  // propio objeto y el último en guardar borra al otro (con Postgres; en memoria no hay
  // espera y no pasa). Dos mensajes seguidos a dos números perdían uno.
  const ya = cache.get(ckey(userId));
  if (ya && Date.now() - ya.updatedAt <= TTL_MS) return ya;
  if (!row) return undefined;
  if (Date.now() - row.updated_at > TTL_MS) return undefined;
  const s: Session = {
    botId: row.bot_id,
    turns: row.turns as ChatMessage[],
    updatedAt: row.updated_at,
  };
  cache.set(ckey(userId), s);
  return s;
}

export async function ensureSession(userId: string, botId: string): Promise<Session> {
  const s = await getSession(userId);
  if (s) return s;
  // HILO-BORRADO-1 · 29-sep-2026: una conversación con más de 6 h sin actividad daba
  // «sin sesión» (el TTL de getSession) y aquí se GUARDABA un hilo vacío encima del
  // real: el siguiente mensaje dejaba la Bandeja con uno solo (92 mensajes perdidos en
  // un chat por QR). El TTL es del contexto de la IA (brain.ts lo aplica al leer), no
  // del rastro: si hay fila, se retoma entera y la BD no se toca.
  const row = await dbGetConversation(userId);
  const ya = cache.get(ckey(userId)); // SESION-CARRERA-1 (CTO-02)
  if (ya && Date.now() - ya.updatedAt <= TTL_MS) return ya;
  if (row) {
    const retomada: Session = {
      botId: row.bot_id || botId,
      turns: Array.isArray(row.turns) ? (row.turns as ChatMessage[]) : [],
      updatedAt: Date.now(),
    };
    cache.set(ckey(userId), retomada);
    return retomada;
  }
  const fresh: Session = { botId, turns: [], updatedAt: Date.now() };
  cache.set(ckey(userId), fresh);
  await dbSaveConversation(userId, botId, fresh.turns);
  return fresh;
}

/**
 * BANDEJA-FIX-1 · Ventana en la que dos copias del MISMO mensaje pueden entrar por dos
 * vías distintas: el eco del propio envío que devuelve el móvil, o un número que está
 * conectado a la vez por Meta y por QR (el caso del dueño migrando un número) y entrega
 * cada mensaje dos veces con identificadores diferentes. Pasado este margen ya no es un
 * eco: es otro mensaje, y se guarda.
 */
const VENTANA_ECO_MS = 20_000;
/** DUP-ADJUNTO-1 · un adjunto se descarga (y se reintenta, QR: updateMediaMessage)
 *  ANTES de guardarse: las dos copias pueden quedar más separadas que un texto. */
const VENTANA_ECO_ADJ_MS = 120_000;
/** Cuántos turnos recientes se miran al buscar el duplicado. Un eco tardío de 40 turnos
 *  atrás no existe, y recorrer 400 en cada mensaje es gasto puro. */
const ECO_MIRAR_ATRAS = 40;

/**
 * BANDEJA-FIX-1 · Con qué se reconoce «el mismo mensaje» cuando no hay identificador
 * común. Para un adjunto NO vale el texto (el panel guarda «📎 factura.pdf» y el eco
 * «[document]»): vale el tipo, y después (mismoAdjunto) el tamaño y el nombre.
 * SIN-NOMBRE-1 · antes un adjunto sin tamaño ni nombre daba '' y no se comparaba con
 * nada: la copia fallida de una nota de voz (no tiene ni lo uno ni lo otro) nunca se
 * reconocía como la misma que la copia bajada. Ahora devuelve el tipo y es mismoAdjunto,
 * con las salvaguardas de indiceDelMismoMensaje, quien decide.
 */
function huellaTurno(t: ChatMessage): string {
  if (t.att) return "att|" + String(t.att.kind || "");
  const tx = String(t.content || "").trim();
  // ECO-ADJ-MARCADOR-1 · el eco de Meta de un adjunto enviado desde el móvil llega SIN
  // adjunto, como el marcador «[document]»: es el mismo mensaje que la copia del QR con el
  // fichero, y con la huella de texto («tx|[document]» frente a «att|document») nunca se
  // reconocían — la burbuja quedaba pintada como «No disponible» junto al fichero que sí
  // se abre. Es el mismo conjunto de marcadores que pinta el panel (admin.ts, attBubbleIn).
  const marca = MARCADOR_ADJ.exec(tx);
  if (marca) return "att|" + marca[1];
  return tx ? "tx|" + tx : "";
}
const MARCADOR_ADJ = /^\[(image|sticker|video|audio|voice|document|share|story_mention|ig_reel|reel)\]$/;

/**
 * DUP-ADJUNTO-1 · ¿Dos adjuntos del mismo tipo son el mismo fichero? Antes la huella
 * exigía tipo+tamaño+nombre IGUALES, y la copia que no se pudo descargar no tiene
 * tamaño: la vía que falló y la que sí lo bajó (Meta y QR sobre el mismo teléfono)
 * dejaban DOS burbujas del mismo PDF, una «Abrir» y otra «No disponible». Ahora cada
 * dato se compara sólo si lo tienen los dos, y hace falta que al menos uno coincida.
 */
function mismoAdjunto(a: NonNullable<ChatMessage["att"]>, b: NonNullable<ChatMessage["att"]>): boolean {
  if (String(a.kind || "") !== String(b.kind || "")) return false;
  const na = String(a.name || ""), nb = String(b.name || "");
  const ta = Number(a.size || 0), tb = Number(b.size || 0);
  const nombres = !!na && !!nb, tamanos = !!ta && !!tb;
  if (nombres && na !== nb) return false;
  if (tamanos && ta !== tb) return false;
  if (nombres || tamanos) return true;
  return sinDatosComparables(a, b);
}

/**
 * SIN-NOMBRE-1 · Una nota de voz, una foto o un vídeo de WhatsApp no traen nombre de
 * fichero, y la copia que no se pudo bajar tampoco tiene tamaño: no hay NADA que
 * comparar. Es el caso de la nota de voz que llega por Meta y por QR a la vez (el número
 * conectado por las dos vías): una copia se baja y la otra falla con «WhatsApp no
 * conectado», y el hilo enseñaba el reproductor y, debajo, una tarjeta «No disponible».
 * Aquí se reconocen como la misma SOLO si una se bajó y la otra no (la fallida no aporta
 * nada); que sean dos mensajes de verdad lo decide indiceDelMismoMensaje (dos vías,
 * ventana, identificadores).
 */
function sinDatosComparables(a: NonNullable<ChatMessage["att"]>, b: NonNullable<ChatMessage["att"]>): boolean {
  return (a.state === "ok") !== (b.state === "ok");
}

/** ¿Hay nombre o tamaño en los DOS adjuntos? Si no, solo el tipo los identifica. */
function tienenDatosComunes(a: NonNullable<ChatMessage["att"]>, b: NonNullable<ChatMessage["att"]>): boolean {
  return (!!a.name && !!b.name) || (!!Number(a.size || 0) && !!Number(b.size || 0));
}

/**
 * BANDEJA-FIX-1 · Posición del turno que YA es este mismo mensaje, o -1.
 *
 * Dos reglas, en este orden:
 *  1. Mismo identificador de plataforma (wamid / id de Baileys). Un wamid es único en
 *     el mundo, así que basta con él — antes se exigía además la misma cuenta y por eso
 *     una reentrega por otro camino colaba un duplicado.
 *  2. Sin identificador común: misma dirección, misma huella y pocos segundos de
 *     diferencia, y además la señal de que son DOS VÍAS y no dos mensajes de verdad:
 *     o llegaron por cuentas distintas (Meta y QR sobre el mismo teléfono), o uno trae
 *     identificador y el otro no (el turno que guardó el panel y su eco). Si los dos
 *     vienen por la misma cuenta y los dos traen identificador propio, son dos
 *     mensajes: escribir «vale» dos veces seguidas sigue enseñando dos burbujas.
 */
/**
 * ECO-UNIFICADO-3 · Un identificador de la Cloud API de Meta empieza siempre por
 * «wamid.»; el de WhatsApp Web (QR) es un hexadecimal sin prefijo. Dos copias del mismo
 * texto con identificadores de FORMATO distinto llegaron por dos transportes: es la
 * señal «dos vías» que sobrevive cuando las cuentas ya se han fundido en una (al
 * re-adoptar un número retirado las dos copias pasan a llevar el mismo acct y, sin
 * esto, dejaban de reconocerse como el mismo mensaje).
 */
const esWamid = (mid: unknown): boolean => String(mid || "").startsWith("wamid.");

/** SIN-NOMBRE-2 · todos los identificadores que se conocen de un turno: el principal y los
 *  de las copias que ya se fundieron en él (midsAlt). */
const idsDe = (x: ChatMessage): string[] => [x.mid, ...(x.midsAlt || [])].filter((m): m is string => !!m).map(String);

function indiceDelMismoMensaje(turns: ChatMessage[], nuevo: ChatMessage, mirarAtras = ECO_MIRAR_ATRAS): number {
  const huella = huellaTurno(nuevo);
  const atN = nuevo.at ?? Date.now();
  const idsN = idsDe(nuevo);
  const desde = Math.max(0, turns.length - mirarAtras);
  for (let i = turns.length - 1; i >= desde; i--) {
    const t = turns[i];
    // SIN-NOMBRE-2 · también por los ids de las copias ya fundidas: la reentrega de un
    // wamid cuya copia quedó dentro de otro turno (midsAlt) es ese mismo mensaje.
    if (idsN.length && idsDe(t).some((m) => idsN.includes(m))) return i;
    if (!huella || t.role !== nuevo.role) continue;
    if (huellaTurno(t) !== huella) continue;
    if (t.att && nuevo.att && !mismoAdjunto(t.att, nuevo.att)) continue; // DUP-ADJUNTO-1
    // SIN-NOMBRE-1 · sin nombre ni tamaño comunes, «uno bajado y otro fallido» NO basta
    // como señal de dos vías: dos notas de voz seguidas de la misma cuenta (una bajada y
    // otra no) son dos mensajes. Tiene que haber otra señal (cuenta o formato de id).
    const sinDatos = !!t.att && !!nuevo.att && !tienenDatosComunes(t.att, nuevo.att);
    // SIN-NOMBRE-2 · SOLO el tipo identifica el adjunto: o no hay nombre ni tamaño en común,
    // o una de las dos copias es el marcador «[document]» sin adjunto (ECO-ADJ-MARCADOR-1).
    // Ahí no hay nada que comparar, y la cercanía en el tiempo no basta: un mensaje trae
    // como mucho UNA copia por vía, así que si el turno ya tiene un id del mismo formato
    // (wamid / hexadecimal) que el nuevo, ese turno ya tiene su gemela de esa vía y el
    // nuevo es OTRO mensaje (antes la nota de voz B, que solo llegó por Meta, se fundía
    // en la A bajada por QR y desaparecía).
    const soloTipo = sinDatos || (!!t.att !== !!nuevo.att);
    if (soloTipo && nuevo.mid && idsDe(t).some((m) => esWamid(m) === esWamid(nuevo.mid))) continue;
    const dosVias =
      String(t.acct || "") !== String(nuevo.acct || "") || (!t.mid) !== (!nuevo.mid) ||
      (!!t.mid && !!nuevo.mid && esWamid(t.mid) !== esWamid(nuevo.mid)) || // ECO-UNIFICADO-3
      // DUP-ADJUNTO-1 · el mismo fichero, bajado en una copia y fallido en la otra: es la
      // reentrega de Meta (tardamos en contestar al webhook) o la otra vía, no un reenvío
      // del cliente — y fundirlos no pierde nada, se queda la copia que sí se abre.
      (!!t.att && !!nuevo.att && !sinDatos && (t.att.state === "ok") !== (nuevo.att.state === "ok"));
    if (!dosVias) continue;
    // DUP-ADJUNTO-1 · bajado + fallido con el MISMO nombre: sin límite de tiempo (dentro
    // de los últimos turnos). La copia fallida no aporta nada y fundirla no pierde nada.
    const parFallido = !!t.att && !!nuevo.att && (t.att.state === "ok") !== (nuevo.att.state === "ok") &&
      !!t.att.name && t.att.name === nuevo.att.name;
    // SIN-NOMBRE-2 · las gemelas reales (Meta + QR) están a 1,7–5,6 s en producción; con
    // solo el tipo, 120 s emparejaba con el adjunto de OTRO mensaje: ventana corta.
    const ventana = !soloTipo && t.att && nuevo.att ? VENTANA_ECO_ADJ_MS : VENTANA_ECO_MS;
    if (!parFallido && Math.abs(atN - Number(t.at || 0)) > ventana) continue;
    return i;
  }
  return -1;
}

/**
 * BANDEJA-FIX-1 · El eco no añade burbuja, pero sí COMPLETA la que ya hay: el
 * identificador con el que llegará el estado de entrega, la hora real, el adjunto si el
 * panel no pudo guardarlo. Nunca pisa un dato que ya estaba: devuelve null si no aporta
 * nada, y así ni se reescribe la conversación.
 */
function fundirTurno(prev: ChatMessage, nuevo: ChatMessage): ChatMessage | null {
  const out: ChatMessage = { ...prev };
  let cambia = false;
  if (!out.mid && nuevo.mid) { out.mid = nuevo.mid; cambia = true; }
  // ACUSE-FUSION-1 · si las DOS copias traían cada una su propio identificador real
  // (las dos vías entregaron el mismo mensaje con acuse propio — típico de una
  // migración con Meta y QR conviviendo), quedarse solo con el mid de `prev` perdía
  // para siempre el acuse de entrega que ya estaba guardado bajo el OTRO id: la
  // burbuja fundida se quedaba sin estado aunque WhatsApp SÍ hubiera confirmado la
  // entrega. Se conservan como alternativos — el estado de entrega se busca por
  // cualquiera de los identificadores conocidos, nunca solo por el principal.
  const idsNuevo = [nuevo.mid, ...(nuevo.midsAlt || [])].filter(
    (m): m is string => !!m && m !== out.mid && !(out.midsAlt || []).includes(m),
  );
  if (idsNuevo.length) { out.midsAlt = [...(out.midsAlt || []), ...idsNuevo]; cambia = true; }
  if (!out.acct && nuevo.acct) { out.acct = nuevo.acct; cambia = true; }
  if (!out.at && nuevo.at) { out.at = nuevo.at; cambia = true; }
  if (nuevo.att && (!out.att || (out.att.state !== "ok" && nuevo.att.state === "ok"))) { out.att = nuevo.att; cambia = true; }
  if (!String(out.content || "").trim() && String(nuevo.content || "").trim()) { out.content = nuevo.content; cambia = true; }
  if (!out.btns?.length && nuevo.btns?.length) { out.btns = nuevo.btns; cambia = true; }
  if (!out.tpl && nuevo.tpl) { out.tpl = nuevo.tpl; cambia = true; }
  // ATENCION-HUMANA-1 · el eco del móvil («movil») puede llegar ANTES que el registro del
  // envío real (IA, flujo, panel): el autor de verdad es el del registro, no el del eco.
  if (nuevo.ai && !out.ai) { out.ai = nuevo.ai; if (out.by === "movil") delete out.by; cambia = true; }
  if (nuevo.by && nuevo.by !== "movil" && !out.ai && (!out.by || out.by === "movil")) { out.by = nuevo.by; cambia = true; }
  else if (nuevo.by === "movil" && !out.by && !out.ai && !out.notice) { out.by = "movil"; cambia = true; }
  return cambia ? out : null;
}

/**
 * BANDEJA-FIX-2 · Aplica a un array de turnos YA GUARDADO el MISMO criterio de
 * duplicado que append()/appendPersistent() aplican a lo que entra ahora — sin
 * copiarlo: reutiliza indiceDelMismoMensaje() y fundirTurno() turno a turno,
 * simulando la misma secuencia de "¿esto ya está?" que se hizo al guardar cada
 * uno la primera vez. Lo usa la limpieza del histórico (wa-historico.ts) para
 * lo que se guardó ANTES de que este criterio existiera.
 *
 * Nunca muta el array de entrada. Asume que `turns` viene ordenado por `at`
 * (como se guarda siempre) — si no lo estuviera, el resultado sigue siendo
 * correcto pero puede dejar de fundir un caso límite (mismo criterio que ya
 * tenía append(), que tampoco reordena).
 */
export function depurarDuplicadosDeTurnos(turns: ChatMessage[]): { turns: ChatMessage[]; retirados: number } {
  const out: ChatMessage[] = [];
  let retirados = 0;
  for (const turno of turns) {
    const rep = indiceDelMismoMensaje(out, turno);
    if (rep < 0) {
      out.push(turno);
      continue;
    }
    const fundido = fundirTurno(out[rep], turno);
    if (fundido) out[rep] = fundido;
    retirados++; // el turno no se añade: es copia de out[rep], fundida o no
  }
  return { turns: out, retirados };
}

export async function append(userId: string, turn: ChatMessage): Promise<void> {
  const s = cache.get(ckey(userId));
  if (!s) return;
  turn = sellarAcct(turn); // CHAT-POR-NUMERO-1
  // BANDEJA-FIX-1 · el mismo mensaje entregado dos veces (dos vías, dos identificadores)
  // completaba el hilo con una segunda burbuja idéntica. Ahora completa la que ya está.
  const rep = indiceDelMismoMensaje(s.turns, turn);
  if (rep >= 0) {
    const fundido = fundirTurno(s.turns[rep], turn);
    if (!fundido) return;
    s.turns[rep] = fundido;
    s.updatedAt = Date.now();
    await dbSaveConversation(userId, s.botId, s.turns);
    return;
  }
  s.turns.push({ ...turn, at: turn.at ?? Date.now() });
  if (s.turns.length > MAX_GUARDADO) s.turns = s.turns.slice(-MAX_GUARDADO);
  s.updatedAt = Date.now();
  await dbSaveConversation(userId, s.botId, s.turns);
}

/**
 * Bidireccional: añade un turn al historial SIN aplicar TTL ni perder el histórico.
 *
 * Casos donde NO queremos descartar la conversación previa por TTL (uso típico):
 *  - El owner responde manualmente desde el panel a una conversación de hace >6h
 *  - La IA repesca un hilo viejo porque el cliente reabrió la conversación
 *
 * El TTL de getSession() es para el AI context (la IA no necesita recordar conversaciones
 * de hace semanas). Pero el inbox del owner SÍ debe preservar TODO el historial entrante
 * y saliente. Por eso esta función carga directamente de BD y bypaesea getSession.
 */
const persistentWrites = new Map<string, Promise<unknown>>();
export async function appendPersistent(userId: string, botId: string, turn: ChatMessage): Promise<void> {
  const key = ckey(userId);
  const job = (persistentWrites.get(key) || Promise.resolve()).catch(() => {}).then(() => appendPersistentNow(userId,botId,turn));
  persistentWrites.set(key,job);
  try { await job; } finally { if(persistentWrites.get(key) === job)persistentWrites.delete(key); }
}
async function appendPersistentNow(
  userId: string,
  botId: string,
  turn: ChatMessage,
): Promise<void> {
  // 1) Carga conversación actual desde BD (ignora TTL — queremos los turns reales)
  let turns: ChatMessage[] = [];
  let resolvedBotId = botId;
  const row = await dbGetConversation(userId);
  if (row) {
    turns = (row.turns as ChatMessage[]) || [];
    resolvedBotId = row.bot_id || botId;
  }
  // 2) Append el turn nuevo (el tope de guardado, no el del modelo)
  turn = sellarAcct(turn); // CHAT-POR-NUMERO-1
  // WA-QR-1 · el envío local y su eco comparten identificador; no son dos mensajes.
  // BANDEJA-FIX-1 · y cuando NO lo comparten (Meta y QR sobre el mismo teléfono dan
  // identificadores distintos al mismo mensaje) se reconocen por huella + ventana. El
  // eco no añade burbuja: completa la que el panel ya guardó.
  const rep = indiceDelMismoMensaje(turns, turn);
  if (rep >= 0) {
    const fundido = fundirTurno(turns[rep], turn);
    if (!fundido) return;
    turns = turns.slice();
    turns[rep] = fundido;
    await dbSaveConversation(userId, resolvedBotId, turns);
    cache.set(ckey(userId), { botId: resolvedBotId, turns, updatedAt: Date.now() });
    return;
  }
  turns.push({ ...turn, at: turn.at ?? Date.now() });
  if (turns.length > MAX_GUARDADO) turns = turns.slice(-MAX_GUARDADO);
  // 3) Persiste + actualiza cache para que el siguiente getSession lo encuentre
  await dbSaveConversation(userId, resolvedBotId, turns);
  cache.set(ckey(userId), { botId: resolvedBotId, turns, updatedAt: Date.now() });
}

/** Turno del histórico traído del móvil al vincular por QR. */
export type QrHistoryTurn = { text: string; id: string; ts: number; fromMe: boolean };

/**
 * WA-QR-HIST-1 · Funde sobre lo guardado las conversaciones que YA existían en el móvil.
 *
 * Dedup EXACTO por (mid, acct): WhatsApp da identificador real de mensaje, así que —a
 * diferencia de mergeIgThread, que tiene que casar por rol+contenido— aquí no hay
 * ambigüedad y un mensaje que ya se ve nunca se duplica.
 *
 * ECO-UNIFICADO-3 · Y ADEMÁS el mismo criterio que append(): el móvil trae por QR, con
 * su identificador de WhatsApp Web, mensajes que el panel YA guardó con el de Meta (el
 * envío por la Cloud API o su eco). Solo con el identificador exacto cada uno de esos
 * entraba dos veces —una burbuja por transporte— y al reunir las cuentas del mismo
 * teléfono en un hilo se veían pegadas. Ahora el gemelo se FUNDE (conserva el otro
 * identificador en midsAlt para que el acuse por cualquiera de los dos lo encuentre).
 * Se mira el hilo entero, no los últimos 40: el histórico llega en bloque.
 *
 * Y ORDENA POR FECHA, que es lo importante: el orden del array ES el orden de la Bandeja
 * (nadie ordena al pintar, ni memory ni admin). Sin esto el histórico de hace tres meses
 * caería DEBAJO del mensaje de hoy.
 */
export function mergeQrHistory(
  stored: ChatMessage[],
  items: QrHistoryTurn[],
  acct: string,
): { turns: ChatMessage[]; changed: boolean; added: number } {
  // Normaliza `at` heredando el del anterior: un turno antiguo sin fecha valdría 0 y al
  // reordenar se iría al principio, desbaratando un hilo que hoy se ve bien.
  const base: ChatMessage[] = stored.map((t) => ({ ...t }));
  let last = 0;
  for (const t of base) {
    const a = typeof t.at === "number" && t.at > 0 ? t.at : 0;
    if (a > 0) last = a;
    else t.at = last;
  }
  const vistos = new Set(base.filter((t) => t.mid).map((t) => `${t.mid}\u0000${t.acct || ""}`));
  const nuevos: ChatMessage[] = [];
  let fundidos = 0;
  for (const it of items) {
    if (!it.id || !it.text) continue;
    const k = `${it.id}\u0000${acct}`;
    if (vistos.has(k)) continue; // ya está guardado, o repetido dentro del propio lote
    vistos.add(k);
    const nuevo: ChatMessage = { role: it.fromMe ? "assistant" : "user", content: it.text, mid: it.id, acct, at: it.ts };
    // ECO-UNIFICADO-3 · ¿es un mensaje que ya está guardado por la otra vía?
    const rep = indiceDelMismoMensaje(base, nuevo, base.length);
    if (rep >= 0) {
      const f = fundirTurno(base[rep], nuevo);
      if (f) { base[rep] = f; fundidos++; }
      continue;
    }
    nuevos.push(nuevo);
  }
  if (!nuevos.length && !fundidos) return { turns: stored, changed: false, added: 0 };
  if (!nuevos.length) return { turns: base, changed: true, added: 0 };
  const todos = [...base, ...nuevos].sort((a, b) => (a.at || 0) - (b.at || 0));
  return { turns: todos, changed: true, added: nuevos.length };
}

/**
 * WA-QR-HIST-1 · La fusión, DENTRO de la misma cola por contacto que usa appendPersistent.
 * Es la diferencia con el backfill de Instagram, que relee «fresco» y aun así puede pisar
 * un mensaje que entre mientras funde: aquí el histórico y el mensaje vivo no pueden
 * solaparse porque comparten turno de escritura.
 */
export async function mergeQrHistoryPersistent(
  userId: string,
  botId: string,
  acct: string,
  items: QrHistoryTurn[],
): Promise<number> {
  if (!items.length) return 0;
  const key = ckey(userId);
  const job = (persistentWrites.get(key) || Promise.resolve())
    .catch(() => {})
    .then(() => mergeQrHistoryNow(userId, botId, acct, items));
  persistentWrites.set(key, job);
  try { return await job; } finally { if (persistentWrites.get(key) === job) persistentWrites.delete(key); }
}
async function mergeQrHistoryNow(
  userId: string,
  botId: string,
  acct: string,
  items: QrHistoryTurn[],
): Promise<number> {
  const row = await dbGetConversation(userId);
  const stored = ((row?.turns as ChatMessage[]) || []);
  const merged = mergeQrHistory(stored, items, acct);
  if (!merged.changed) return 0;
  const resolvedBotId = row?.bot_id || botId;
  // Tras ordenar ascendente, recortar por la cola conserva lo MÁS RECIENTE.
  const capped = merged.turns.length > MAX_GUARDADO ? merged.turns.slice(-MAX_GUARDADO) : merged.turns;
  await dbSaveConversation(userId, resolvedBotId, capped);
  cache.set(ckey(userId), { botId: resolvedBotId, turns: capped, updatedAt: Date.now() });
  return merged.added;
}

/**
 * BACKFILL-IG-1 · Reemplaza el historial COMPLETO (BD + caché RAM) de forma coherente,
 * respetando MAX_TURNS. Lo usa el backfill del inbox de Instagram: al fundir el saliente
 * recuperado por la Conversations API hay que PRIMAR la misma caché que lee el webhook,
 * o el siguiente append() (que parte de esa caché) sobrescribiría lo recuperado. Devuelve
 * el array ya capado — es lo que la Bandeja debe mostrar.
 */
export async function replaceTurns(
  userId: string,
  botId: string,
  turns: ChatMessage[],
): Promise<ChatMessage[]> {
  const capped = turns.length > MAX_GUARDADO ? turns.slice(-MAX_GUARDADO) : turns;
  await dbSaveConversation(userId, botId, capped);
  cache.set(ckey(userId), { botId, turns: capped, updatedAt: Date.now() });
  return capped;
}

/**
 * ¿Sigue siendo un PRIMER CONTACTO? Lo es mientras el bot no haya dicho nada todavía,
 * aunque la conversación ya exista con mensajes del cliente.
 *
 * Antes esto se deducía de "¿existe sesión?". Dejó de valer en cuanto empezamos a
 * registrar los adjuntos entrantes: un cliente que abre con una foto (o un GIF, muy
 * común en Instagram) ya crea la conversación, y con la regla vieja el bot daba por
 * hecho que "ya venía de antes" — no saludaba nunca y se quedaba pegado a un bot que
 * nadie había elegido. El criterio correcto es si el bot ha intervenido o no.
 */
export function botHasNotSpoken(s: { turns: ChatMessage[] } | undefined): boolean {
  // Array.isArray: una fila antigua con turns mal formado no puede tumbar el webhook.
  return !s || !Array.isArray(s.turns) || !s.turns.some((t) => t.role === "assistant");
}

/**
 * Fija el bot que atiende una conversación que el bot AÚN NO ha contestado. Es lo que
 * repara el caso de arriba: la conversación se creó al registrar un adjunto (sin poder
 * saber quién debía atenderla) y ahora que el cliente ha escrito ya sabemos el bot real.
 * No-op si el bot ya habló: ahí el bot es pegajoso y no se toca.
 */
export async function repinBot(userId: string, botId: string): Promise<void> {
  const s = cache.get(ckey(userId));
  if (!s || !botId || s.botId === botId) return;
  if (s.turns.some((t) => t.role === "assistant")) return;
  s.botId = botId;
  await dbSaveConversation(userId, botId, s.turns);
}

export function reset(userId: string): void {
  cache.delete(ckey(userId));
  // En BD se sobrescribe en la próxima conversación; basta con limpiar caché.
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.updatedAt > TTL_MS) cache.delete(k);
}, 1000 * 60 * 30).unref();
