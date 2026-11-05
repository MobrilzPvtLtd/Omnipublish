/**
 * CONVERSOR Disparadores → Flujos.
 *
 * La vista «Disparadores» se retira y su trabajo pasa a Flujos. Este módulo traduce
 * cada disparador ya creado por un cliente al flujo equivalente, para que nadie tenga
 * que rehacer a mano lo que ya tenía montado.
 *
 * Tres reglas que gobiernan todo lo de abajo:
 *
 * 1. NO SE BORRA NADA. El disparador original se queda en su tabla, PAUSADO y marcado
 *    con el id del flujo que lo sustituye (`migradoAFlujo`). Así ni el disparador ni el
 *    flujo pueden responder los dos al mismo mensaje, y deshacer la conversión es tan
 *    fácil como volver a activarlo y borrar el flujo.
 *
 * 2. EL FLUJO NACE PAUSADO. Siempre, incluso convirtiendo uno que estaba activo. El
 *    dueño lo revisa y lo enciende. Convertir en caliente significaría cambiar el
 *    comportamiento de automatismos vivos sin que nadie lo mire.
 *
 * 3. ES IDEMPOTENTE. Un disparador ya migrado se salta. Se puede ejecutar dos veces
 *    sin duplicar flujos.
 *
 * Se lee el JSON CRUDO de la tabla (dbListAutomations), no lo que devuelve el
 * formulario del panel: hay disparadores antiguos con campos que la pantalla actual ya
 * no envía (startSequence) y que se perderían al pasar por ella.
 */
import { dbListAutomations, dbUpsertAutomation, dbCopyClaims } from "./db.js";
import { listFlows, saveFlow, type Flow } from "./flows.js";

/** Un disparador tal y como está guardado, sin asumir forma: son datos de cliente. */
type Crudo = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const bool = (v: unknown): boolean => v === true;

/** Qué le pasó a un disparador concreto. */
export interface Resultado {
  id: string;
  nombre: string;
  plataforma: string;
  /** convertido | ya-migrado | sin-destino (no hay equivalente en Flujos) | vacio */
  estado: "convertido" | "ya-migrado" | "sin-destino" | "vacio";
  flujoId?: string;
  flujoNombre?: string;
  /** Lo que el dueño TIENE que mirar antes de encender el flujo. */
  avisos: string[];
  /** Marcas de «una vez por persona» heredadas. */
  marcasCopiadas?: number;
}

export interface Informe {
  simulacion: boolean;
  total: number;
  convertidos: number;
  yaMigrados: number;
  sinDestino: number;
  resultados: Resultado[];
}

/** Nombre libre: si ya hay un flujo con ese nombre, se numera. */
function nombreLibre(base: string, usados: Set<string>): string {
  const limpio = (base || "Disparador sin nombre").slice(0, 80);
  if (!usados.has(limpio)) return limpio;
  for (let i = 2; i < 500; i++) {
    const t = `${limpio} (${i})`;
    if (!usados.has(t)) return t;
  }
  return `${limpio} (${Date.now()})`;
}

/**
 * ¿Esta palabra clave estaba MUERTA? El motor viejo de WhatsApp buscaba la cadena
 * entera, así que un disparador con «info, precio» exigía ese texto literal y no
 * disparaba jamás. Al convertirlo empieza a funcionar de verdad — que es lo que su
 * dueño quería— pero sobre tráfico real y sin que nadie lo haya revisado. Por eso
 * merece un aviso propio.
 */
const keywordEstabaMuerta = (plataforma: string, keyword: string): boolean =>
  plataforma === "whatsapp" && keyword.includes(",");

/** WhatsApp: palabra clave → respuesta, enlace, etiqueta, humano. */
function convertirWhatsApp(a: Crudo, nombre: string, id: string): { flow: Flow; avisos: string[] } {
  const avisos: string[] = [];
  const keyword = str(a.keyword).trim();
  const reply = str(a.reply);
  const link = str(a.link);
  const tag = str(a.tag);

  const nodes: Flow["nodes"] = {};
  let anterior: string | null = null;
  const encadenar = (nodeId: string, node: Flow["nodes"][string]) => {
    nodes[nodeId] = node;
    if (anterior) {
      const prev = nodes[anterior] as { next?: string };
      prev.next = nodeId;
    }
    anterior = nodeId;
  };

  if (reply || link) encadenar("n1", { type: "message", text: reply, link: link || undefined });
  if (tag) encadenar("n2", { type: "action", kind: "tag", addTag: tag });
  // `kind` es lo que lee el EDITOR para pintar el paso; `escalate` es lo que ejecuta el
  // MOTOR (flows.ts). Hacen falta los dos: solo con kind el paso se ve pero no escala.
  if (bool(a.escalate)) encadenar("n3", { type: "action", kind: "escalate", escalate: true });
  encadenar("nfin", { type: "end" });

  if (keywordEstabaMuerta("whatsapp", keyword)) {
    avisos.push(
      "Esta palabra clave llevaba con comas, y el motor antiguo buscaba el texto entero: NUNCA llegaba a dispararse. " +
        "Ahora sí funcionaría, sobre clientes reales. Revísala antes de encender el flujo.",
    );
  }
  // stopAi=false era el valor POR DEFECTO del formulario de Disparadores, así que
  // convertirlo al pie de la letra pondría «dejar hablar al bot» en casi todo lo
  // migrado — la opción rara en Flujos pasaría a ser la normal. Se convierte, pero
  // se dice, porque es un cambio de comportamiento que el dueño no eligió a conciencia.
  const dejaHablarBot = !bool(a.stopAi) && !!reply;
  if (dejaHablarBot) {
    avisos.push(
      "El disparador respondía y dejaba seguir al bot (era lo que venía marcado por defecto). " +
        "Se ha conservado, pero comprueba si de verdad lo querías así: en Flujos lo normal es que el flujo lleve la conversación.",
    );
  }
  const seq = str(a.startSequence);
  if (seq) {
    avisos.push(
      "Este disparador arrancaba una secuencia de goteo (" + seq + "). Las secuencias no se convierten solas: " +
        "reconstrúyela con pasos «Espera» + «Mensaje» dentro de este flujo.",
    );
  }

  const flow: Flow = {
    id: "",
    name: nombre,
    enabled: false,
    trigger: keyword ? { type: "wa_keyword", keyword } : { type: "wa_any" },
    appliesTo: str(a.phoneNumberId) || undefined,
    oncePerUser: bool(a.oncePerUser) || undefined,
    keepAi: dejaHablarBot || undefined,
    start: Object.keys(nodes)[0] || "nfin",
    nodes,
  };
  return { flow, avisos };
}

/** Instagram, Facebook y YouTube: comentario → respuesta pública (+ privado, salvo YouTube). */
function convertirComentario(a: Crudo, nombre: string, plataforma: string): { flow: Flow; avisos: string[] } {
  const avisos: string[] = [];
  const keyword = str(a.keyword).trim();
  const replyComment = str(a.replyComment);
  const dmText = str(a.dmText);
  const dmLink = str(a.dmLink);
  const dmButtonText = str(a.dmButtonText);
  const aiReply = bool(a.aiReply);
  const aiPrompt = str(a.aiPrompt);
  const mediaId = str(a.mediaId) || "any";
  const esYt = plataforma === "youtube";
  const esLi = plataforma === "linkedin";
  // YouTube y LinkedIn comparten forma: sin mensajes privados, la respuesta pública ES la entrega.
  const soloPublico = esYt || esLi;

  const nodes: Flow["nodes"] = {};
  if (soloPublico) {
    // YouTube y LinkedIn no tienen mensajes privados: la respuesta pública ES la entrega, y el
    // enlace va dentro de ella. Por eso aquí el texto del comentario es el del nodo,
    // no una «respuesta pública» aparte como en Instagram y Facebook.
    nodes.n1 = {
      type: "message",
      text: replyComment,
      link: dmLink || undefined,
      ai: aiReply || undefined,
      aiPrompt: aiReply && aiPrompt ? aiPrompt : undefined,
    };
    nodes.nfin = { type: "end" };
    (nodes.n1 as { next?: string }).next = "nfin";
    if (bool(a.escalate) || str(a.tag)) {
      avisos.push("En " + (esLi ? "LinkedIn" : "YouTube") + " un flujo solo puede responder: las etiquetas y el pase a un humano no se han convertido.");
    }
  } else {
    // Instagram y Facebook: la respuesta pública es del flujo (publicReplies / IA) y el
    // contenido va por privado, que es el nodo.
    nodes.n1 = {
      type: "message",
      text: dmText,
      link: dmLink || undefined,
      linkLabel: dmButtonText || undefined,
      ai: aiReply && !!dmText ? true : undefined,
      aiPrompt: aiReply && aiPrompt ? aiPrompt : undefined,
    };
    nodes.nfin = { type: "end" };
    (nodes.n1 as { next?: string }).next = "nfin";
  }

  const tipo = plataforma === "facebook" ? "fb_comment" : esYt ? "yt_comment" : esLi ? "li_comment" : "ig_comment";
  const flow: Flow = {
    id: "",
    name: nombre,
    enabled: false,
    trigger: {
      type: tipo as Flow["trigger"]["type"],
      keyword: keyword || undefined,
      mediaId,
    },
    oncePerUser: bool(a.oncePerUser) || undefined,
    start: "n1",
    nodes,
  };

  if (!soloPublico) {
    // La respuesta pública fija pasa a la lista del flujo; si la escribía la IA, se
    // conserva como tal (para eso se añadió publicAi).
    if (replyComment) flow.publicReplies = [replyComment];
    if (!replyComment && !aiReply) flow.publicReplyOff = true;
    if (aiReply) {
      flow.publicAi = true;
      if (aiPrompt) flow.publicAiPrompt = aiPrompt;
    }
  } else if (esYt) {
    // El ámbito de YouTube es el canal; 'any' es el comodín de Disparadores y en
    // Flujos el comodín es vacío (no traducirlo dejaría el flujo muerto).
    const yt = str(a.ytAccountId);
    if (yt && yt !== "any") flow.appliesTo = yt;
  }
  // LinkedIn: los Disparadores no se acotaban por Página, así que el flujo tampoco.

  return { flow, avisos };
}

/**
 * Convierte todos los disparadores del workspace activo.
 * `simulacion` (por defecto) NO escribe nada: devuelve el informe de lo que haría.
 */
export async function convertirDisparadores(simulacion = true): Promise<Informe> {
  const crudos = await dbListAutomations();
  const flujos = await listFlows();
  const usados = new Set(flujos.map((f) => f.name));
  const resultados: Resultado[] = [];

  for (const a of crudos) {
    const id = str(a.id);
    const plataforma = str(a.platform) || "whatsapp";
    const nombreOrig = str(a.name) || "(sin nombre)";
    const base: Resultado = { id, nombre: nombreOrig, plataforma, estado: "convertido", avisos: [] };

    if (str(a.migradoAFlujo)) {
      resultados.push({ ...base, estado: "ya-migrado", flujoId: str(a.migradoAFlujo) });
      continue;
    }

    const nombre = nombreLibre(nombreOrig, usados);
    const { flow, avisos } =
      plataforma === "whatsapp" ? convertirWhatsApp(a, nombre, id) : convertirComentario(a, nombre, plataforma);

    // Un disparador que no envía nada no tiene flujo que valga: solo ruido.
    const entrega = Object.values(flow.nodes).some(
      (n) => n.type === "message" && (!!(n as { text?: string }).text || !!(n as { link?: string }).link || !!(n as { ai?: boolean }).ai),
    );
    // En comentarios de Instagram y Facebook la respuesta PÚBLICA no es un nodo: vive en
    // publicReplies / publicAi. Sin contarla, un disparador que solo comenta en público
    // (que es una configuración normal) se daba por vacío y se quedaba sin convertir.
    const respondeEnPublico = !!(flow.publicReplies && flow.publicReplies.length) || !!flow.publicAi;
    const hacía = entrega || respondeEnPublico || Object.values(flow.nodes).some((n) => n.type === "action");
    if (!hacía) {
      resultados.push({ ...base, estado: "vacio", avisos: ["No tenía ninguna acción configurada: no se ha creado ningún flujo."] });
      continue;
    }

    if (bool(a.enabled)) {
      avisos.push("El disparador estaba ACTIVO. Se ha pausado y el flujo nace pausado: revísalo y enciéndelo tú.");
    }

    if (simulacion) {
      resultados.push({ ...base, flujoNombre: nombre, avisos });
      usados.add(nombre);
      continue;
    }

    flow.id = crypto.randomUUID();
    await saveFlow(flow);
    usados.add(nombre);

    // Las marcas de «una vez por persona» viven indexadas por el id del disparador. Sin
    // copiarlas, el flujo nuevo volvería a escribir a todo el mundo desde cero.
    // En YouTube la identidad lleva el prefijo 'yt:' en Flujos y no lo lleva en
    // Disparadores, así que se prefija al copiar.
    let marcas = 0;
    if (bool(a.oncePerUser)) {
      try {
        marcas = await dbCopyClaims(id, flow.id, plataforma === "youtube" ? "yt:" : plataforma === "linkedin" ? "li:" : "");
      } catch {
        avisos.push("No se han podido heredar las marcas de «una vez por persona»: al encenderlo podría volver a escribir a quien ya recibió el mensaje.");
      }
    }

    // El original: pausado y marcado. Nunca borrado.
    // Se guarda si estaba encendido para poder devolverlo a su estado exacto al
    // deshacer: reactivar a ciegas encendería disparadores que ya estaban en pausa.
    await dbUpsertAutomation(id, { ...a, enabled: false, migradoAFlujo: flow.id, enabledAntesDeMigrar: bool(a.enabled) });

    resultados.push({ ...base, flujoId: flow.id, flujoNombre: nombre, avisos, marcasCopiadas: marcas });
  }

  return {
    simulacion,
    total: resultados.length,
    convertidos: resultados.filter((r) => r.estado === "convertido").length,
    yaMigrados: resultados.filter((r) => r.estado === "ya-migrado").length,
    sinDestino: resultados.filter((r) => r.estado === "sin-destino").length,
    resultados,
  };
}

/** Deshacer: reactiva el disparador y le quita la marca. El flujo se borra aparte. */
export async function deshacerConversion(disparadorId: string): Promise<boolean> {
  const crudos = await dbListAutomations();
  const a = crudos.find((x) => str(x.id) === disparadorId);
  if (!a) return false;
  // Solo se deshace lo que ESTE conversor convirtió. Sin esta comprobación, el endpoint
  // era un interruptor genérico para encender cualquier disparador del workspace.
  if (!str(a.migradoAFlujo)) return false;
  // Vuelve a su estado exacto, no a «encendido»: muchos estaban pausados antes.
  const copia = { ...a, enabled: bool(a.enabledAntesDeMigrar) };
  delete (copia as Record<string, unknown>).migradoAFlujo;
  delete (copia as Record<string, unknown>).enabledAntesDeMigrar;
  await dbUpsertAutomation(disparadorId, copia);
  return true;
}
