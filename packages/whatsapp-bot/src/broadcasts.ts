/**
 * Motor de difusión, compartido entre el panel (envío inmediato), el scheduler
 * (envío programado) y la reanudación tras un reinicio. Aquí vive la lógica de
 * segmentación + envío para no duplicarla.
 *
 * DIFUSION-MARCA-1 · el envío con plantilla (al segmento o en lote desde Nueva
 * conversación) TAMBIÉN vive aquí: el panel resuelve la plantilla aprobada y la
 * deja en el plan de la fila, y ejecutarDifusion() hace el resto. Antes había tres
 * bucles casi idénticos (uno aquí, dos dentro de admin.ts) y ninguno sobrevivía a
 * un reinicio del proceso: la fila se quedaba «Enviando» para siempre.
 */
import { searchContacts, getContact, hasOptedOut, inWindowFor, findContactByPhoneLoose, createContact, updateContact, enrichContact, addContactNote } from "./contacts.js";
import { sendText, sendButtons, sendImage, sendTemplate, tplRenderText, resolveWaNumber, runWithWaNumber, type WaCreds, type WaNumber } from "./whatsapp.js";
import { dbDueBroadcasts, dbUpdateBroadcast, dbGetBroadcast, dbAddBroadcastHit, dbListBroadcastHits, dbClaimOrphanBroadcasts, dbCountContacts, contactoAlcanzablePorDifusion, type BroadcastRec, type BroadcastPlan, type LoteObjetivo } from "./db.js";
import { currentWorkspaceId, DEFAULT_WORKSPACE_ID, runWithWorkspace } from "./workspace.js";
import { logActivity } from "./activity.js";
import { notificar } from "./notifications.js";
import { appendPersistent } from "./memory.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** DIFUSION-RECORTE-1 · a cuántos contactos como mucho alcanza UNA difusión (el clamp de
 *  dbSearchContacts). Se exporta para que el panel y el aviso de recorte digan el MISMO
 *  número que aplica el motor: con la constante duplicada, cambiar el tope aquí habría
 *  dejado al panel avisando de un corte que ya no era el real. */
export const LIMITE_SEGMENTO = 2000;

/** Filtra contactos por segmento: etapa + origen + etiquetas (AND). Descarta solo-email.
 *
 * SEC-1: searchContacts SIEMPRE recibe tenantId del WS activo (defensa
 * cross-WS). Antes podía leer contactos de otro workspace si el caller
 * no había abierto scope ALS — aunque en la práctica todos los call-sites
 * lo hacen, este filtro lo blinda a nivel SQL. */
/** Un número que viene del navegador y solo vale si es un entero positivo. */
function diasOpt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** Lista de valores elegidos en un filtro multivalor. Devuelve undefined si no
 *  hay ninguno (= no filtres por esto). OJO: NO se filtran las cadenas vacías,
 *  porque '' es un valor con significado en varios de ellos («sin asignar»,
 *  «sin pipeline»); lo que se descarta es lo que no sea texto. */
function listaOpt(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x) => typeof x === "string" || typeof x === "number").map((x) => String(x));
  return out.length ? out : undefined;
}

export async function broadcastSegment(f: {
  tags?: unknown;
  stage?: unknown;
  source?: unknown;
  /** Etiquetas que DEJAN FUERA (ninguna de ellas). */
  excludeTags?: unknown;
  /** Closer responsable. '' = sin asignar (pool); ausente = cualquiera. */
  owner?: unknown;
  /** true = solo los alcanzables gratis; false = solo los que exigen plantilla. */
  inWindow24h?: unknown;
  /** Respondió en los últimos N días / lleva más de N días sin responder. */
  activeWithinDays?: unknown;
  inactiveForDays?: unknown;
  /** Puntuación mínima del lead. */
  minScore?: unknown;
  /** Multivalor (OR dentro de cada uno, AND entre ellos). */
  stages?: unknown;
  owners?: unknown;
  sources?: unknown;
  pipelines?: unknown;
  /** Selección EXPLÍCITA de destinatarios (teléfonos). Si viene, el envío va SOLO a estos.
   *  Es la lista que el dueño ha marcado a mano en la pantalla de Difusión: las etiquetas
   *  y la etapa solo sirven para acotar a quién le enseñamos, la última palabra es esta. */
  only?: unknown;
}) {
  const tenantId = currentWorkspaceId() || DEFAULT_WORKSPACE_ID;
  const tags = Array.isArray(f.tags) ? f.tags.map((t) => String(t)).filter(Boolean) : [];
  const exTags = Array.isArray(f.excludeTags) ? f.excludeTags.map((t) => String(t)).filter(Boolean) : [];
  const minScore = Number(f.minScore);
  // Límite efectivo de página (coincide con el clamp de dbSearchContacts).
  const SEG_LIMIT = LIMITE_SEGMENTO;
  // DIFUSION-RECORTE-1 · UN solo objeto de filtro para el listado y para el COUNT: si
  // se escribieran dos veces, el «de N contactos» que se le enseña al dueño contaría
  // sobre un filtro distinto al que se envía.
  const filtro = {
    stage: f.stage ? String(f.stage) : undefined,
    source: f.source ? String(f.source) : undefined,
    // AND de etiquetas EN SQL, ANTES del LIMIT (ContactFilter.tags): antes se
    // filtraba en memoria SOBRE la página de 2000 y contactos que SÍ tenían la
    // etiqueta quedaban fuera del conteo y del envío, sin aviso. Lo mismo vale
    // para todo lo que se añada aquí: si un filtro se aplicara después del
    // LIMIT, el segmento sería «los 2000 más recientes, y de esos los que
    // cumplan», que no es lo que dice la pantalla.
    tags: tags.length ? tags : undefined,
    excludeTags: exTags.length ? exTags : undefined,
    // '' es un valor con significado (sin asignar), así que se distingue de
    // «no han elegido responsable» por el null/undefined, no por ser vacío.
    owner: f.owner == null ? undefined : String(f.owner),
    inWindow24h: f.inWindow24h == null ? undefined : Boolean(f.inWindow24h),
    activeWithinDays: diasOpt(f.activeWithinDays),
    inactiveForDays: diasOpt(f.inactiveForDays),
    minScore: Number.isFinite(minScore) && minScore > 0 ? minScore : undefined,
    stages: listaOpt(f.stages),
    owners: listaOpt(f.owners),
    sources: listaOpt(f.sources),
    pipelines: listaOpt(f.pipelines),
    // DIFUSION-UNIVERSO-1 · los dos descartes de siempre (baja y contacto que no es de
    // WhatsApp) dejan de hacerse a mano DESPUÉS del LIMIT y pasan al mismo WHERE que
    // todo lo demás. Sin esto pasaban dos cosas a la vez: el COUNT contaba un universo
    // más grande que el que acaba en `arr` —«cumplen el segmento 7431» incluyendo a
    // miles de bajas y de leads de Instagram, que luego se apuntaban como «perdidos por
    // el recorte»— y la página de 2000 se llenaba de gente descartable, así que la
    // difusión salía a 1700 habiendo 7000 candidatos esperando turno.
    alcanzablePorDifusion: true,
    limit: SEG_LIMIT,
    tenantId,
  };
  let arr = await searchContacts(filtro);
  // Página llena ⇒ hay más contactos que cumplen el filtro más allá del corte:
  // el conteo que ve el usuario y el envío estarían recortados. Se propaga como
  // truncatedSegment para que el panel lo avise en vez de callar.
  const truncatedSegment = arr.length >= SEG_LIMIT;
  // DIFUSION-RECORTE-1 · cuántos cumplen el filtro DE VERDAD, sin el corte. Solo se
  // pregunta cuando la página se llenó: es un COUNT(*) sobre los mismos WHERE y no
  // hace falta pagarlo en cada repintado de la audiencia. Este número es el que
  // convierte «se envía a 2000» en «se envía a 2000 de 7431», que es lo único que le
  // permite al dueño decidir si segmenta o lanza por tandas.
  // DIFUSION-UNIVERSO-1 · se cuenta con EL MISMO objeto `filtro`, así que cuenta el
  // mismo universo que termina en `arr`: bajas y contactos que no son de WhatsApp
  // quedan fuera de los dos lados. Antes solo quedaban fuera de `arr`, y el «7431» se
  // los apuntaba al recorte como si el tope se los hubiera llevado por delante.
  const segTotal = truncatedSegment
    ? await dbCountContacts({ ...filtro, limit: undefined }).catch(() => arr.length)
    : arr.length;
  // BAJA y CANAL: quien ha pedido no recibir más mensajes, y quien no es de WhatsApp,
  // quedan FUERA de toda difusión, se filtre como se filtre. Este es el motor que usa la
  // vista Difusión entera (plantillas, envío libre, programadas y el contador de
  // audiencia): sin esto, al que pulsó "Dejar de recibir promociones" se le volvería a
  // mandar exactamente esa misma plantilla, y a un lead de Instagram se le intentaría
  // enviar por la Cloud API un mensaje a un "número" que no existe.
  // DIFUSION-UNIVERSO-1 · cinturón: los dos descartes ya vienen hechos en SQL
  // (alcanzablePorDifusion), con el MISMO predicado. Se mantiene aquí por defensa y para
  // la rama sin base de datos; si este filtro quita a alguien es que las dos ramas se han
  // separado, no que el filtro haga falta.
  arr = arr.filter((c) => contactoAlcanzablePorDifusion(c));
  // Cinturón: las etiquetas ya vienen filtradas en SQL; se mantiene por defensa.
  if (tags.length) arr = arr.filter((c) => tags.every((t) => (c.tags || []).includes(t)));
  // Y el mismo cinturón para las excluidas: si esta se cae, alguien que pidió
  // «a todos menos a los que ya compraron» recibe justo lo contrario.
  if (exTags.length) arr = arr.filter((c) => !exTags.some((t) => (c.tags || []).includes(t)));

  // Selección explícita. Se aplica AL FINAL y como INTERSECCIÓN, nunca como sustitución:
  // así una baja o un contacto sin teléfono no se cuela por haber sido marcado en pantalla.
  // Marcar a alguien no salta ningún filtro de seguridad.
  //
  // OJO a la distinción, que es de seguridad: `only` AUSENTE (null/undefined) = "nadie ha
  // elegido nada" → se envía a todo el filtro, como siempre. `only` PRESENTE pero VACÍO =
  // "he desmarcado a todo el mundo" → NO se envía a nadie. Si tratáramos los dos casos
  // igual, desmarcar a todos acabaría enviando a todos: exactamente lo contrario.
  if (Array.isArray(f.only)) {
    const pick = new Set(f.only.map((p) => String(p || "").trim()).filter(Boolean));
    arr = arr.filter((c) => pick.has(c.phone));
  }
  return { contacts: arr, truncatedSegment, segTotal };
}

export interface BroadcastPayload {
  /** id de la difusión: firma sus enlaces para que cada difusión tenga su fila en
   *  Enlaces, y es la fila del historial donde se apuntan avance, latido y detalle. */
  id?: string;
  text: string;
  buttons?: string[];
  imageUrl?: string;
  /** Tal cual se guarda en la fila de la difusión: una programada se vuelve a
   *  resolver con ESTE objeto el día del envío, así que aquí tiene que caber
   *  todo lo que el dueño eligió, no solo los tres filtros originales. */
  segment: Parameters<typeof broadcastSegment>[0];
  /** T02 · phone_number_id del número EMISOR elegido. Si viene, la difusión sale
   *  EXACTAMENTE por ese número; si ya no está conectado, executeBroadcast lanza
   *  (jamás cae al principal en silencio). '' / ausente = comportamiento legado
   *  (número principal del workspace), para no romper difusiones anteriores. */
  senderPid?: string;
  /** RITMO-DIFUSION-1 · milisegundos entre contactos elegidos por el dueño.
   *  Solo se respeta si es ≥ 10 s (tope 6 h); ausente/0 = 700 ms de siempre. */
  paceMs?: number;
  /** DIFUSION-MARCA-1 · al RETOMAR: teléfonos ya tocados (constan en app_broadcast_hits)
   *  y los totales que ya llevaba la fila, para que los contadores sigan donde estaban. */
  omitir?: Set<string>;
  base?: { sent: number; failed: number };
  /** DIFUSION-MARCA-1 · si viene, la audiencia se limita a estos teléfonos (la lista
   *  fijada al lanzarla): una difusión retomada no alcanza a quien entró en el segmento
   *  después ni deja fuera a quien salió de él. */
  solo?: Set<string>;
}

// ── DIFUSION-MARCA-1 · latido, anulación y reanudación ──────────────────────
/** Cada cuánto late el bucle mientras espera al siguiente envío (y relee «Anular»).
 *  Con un ritmo de 6 h, antes «Parar» tardaba hasta 6 h en surtir efecto. */
export const LATIDO_MS = 30_000;
/** Un 'sending' sin latido desde hace más de esto es huérfano: su proceso murió. */
export const HUERFANA_MS = 120_000;
/** Difusiones que ESTE proceso está enviando ahora mismo. */
const enCurso = new Set<string>();

/** ¿La anularon desde el historial (o desapareció)? Una lectura de una fila, indexada. */
async function filaParada(id: string): Promise<boolean> {
  try {
    const b = await dbGetBroadcast(id);
    return !b || b.status === "canceled";
  } catch {
    return false; // si la base no contesta, seguimos: parar por un fallo de lectura sería peor
  }
}
/** Apunta el avance y renueva el latido. Informar jamás tumba el envío. */
async function latido(id: string, sent: number, failed: number): Promise<void> {
  try { await dbUpdateBroadcast(id, { sent, failed, heartbeat_at: Date.now() }); } catch { /* nada */ }
}
/** Espera `ms` a trozos de ≤ LATIDO_MS, latiendo y releyendo la anulación entre trozo y
 *  trozo. Devuelve true si hay que parar. Sin id (sin fila) es un sleep normal. */
async function esperar(ms: number, id: string, sent: number, failed: number): Promise<boolean> {
  let resta = ms;
  while (resta > 0) {
    const trozo = Math.min(resta, LATIDO_MS);
    await new Promise((r) => setTimeout(r, trozo));
    resta -= trozo;
    if (!id) continue;
    if (await filaParada(id)) return true;
    if (resta > 0) await latido(id, sent, failed);
  }
  return false;
}

/** Envía la difusión libre (texto / imagen / botones) al segmento ∩ ventana 24 h. */
export async function executeBroadcast(
  p: BroadcastPayload,
): Promise<{ sent: number; failed: number; recipients: number; outWindow: number; segTotal: number }> {
  // T02 · Emisor explícito: se resuelve UNA vez, antes de tocar a nadie. Un emisor
  // que ya no está conectado ABORTA la difusión con causa (el caller la marca
  // 'blocked'/'error'): enviar por otro número sería mentir al dueño y romper la
  // ventana 24h que el cliente tiene abierta con el número elegido.
  let waCtx: WaCreds | null = null;
  if (p.senderPid) {
    const n = resolveWaNumber(p.senderPid);
    if (!n) throw new Error(`El número emisor elegido ya no está conectado en este workspace (id ${p.senderPid}). Elige otro emisor y reanúdala.`);
    waCtx = { token: n.token, phoneId: n.phoneNumberId };
  }
  const id = String(p.id || "");
  const { contacts: seg, truncatedSegment: segRecortado, segTotal } = await broadcastSegment(p.segment);
  const cutoff = Date.now() - WINDOW_MS;
  const enVentana = seg.filter((c) => c.last_inbound >= cutoff);
  // DIFUSION-MARCA-1 · audiencia fijada al lanzar (si la hay) y sin los ya tocados.
  const solo = p.solo;
  const targets = solo ? enVentana.filter((c) => solo.has(c.phone)) : enVentana;
  const omitir = p.omitir || new Set<string>();
  const pendientes = targets.filter((c) => !omitir.has(c.phone));
  const base = p.base || { sent: 0, failed: 0 };
  let sent = base.sent;
  let failed = base.failed;
  if (id && !solo) {
    // DIFUSION-MARCA-1 · la lista resuelta se fija en la fila ANTES del primer envío (una
    // programada no la conocía hasta ahora): es lo que permite retomarla si el proceso muere.
    try {
      // DIFUSION-RECORTE-1 · el recorte se escribe AQUÍ, con el segmento ya resuelto: es
      // el único momento en que una difusión PROGRAMADA sabe a cuántos iba de verdad (al
      // programarla, semanas antes, el segmento todavía no existía). Sin esto, su ficha
      // de resultados decía «enviada a 2000» y el resto se perdía sin dejar rastro.
      await dbUpdateBroadcast(id, {
        plan: { kind: "libre", targets: targets.map((c) => ({ phone: c.phone, name: c.name || "" })) },
        // Solo es un recorte REAL cuando la difusión va al segmento entero: con una
        // selección a mano, los marcados salieron de la lista que ya se vio y el corte
        // no le quita a nadie de los elegidos.
        seg_truncated: segRecortado && !Array.isArray(p.segment?.only),
        seg_total: segTotal,
      });
    } catch { /* sin plan no se podrá retomar, pero se envía igual */ }
  } else if (id && solo && p.omitir) {
    // Al retomar: a quien se le cerró la ventana de 24 h durante la parada ya no se le puede
    // escribir libre. Consta como fallo con su motivo, para que los totales cuadren.
    const alcanzables = new Set(targets.map((c) => c.phone));
    for (const ph of solo) {
      if (omitir.has(ph) || alcanzables.has(ph)) continue;
      failed++;
      await dbAddBroadcastHit(id, { phone: ph, ok: false, error: "Su ventana de 24 h se cerró mientras el envío estaba parado: ya solo se le puede escribir con plantilla" });
    }
  }
  const buttons = (p.buttons || []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 3);
  // RITMO-DIFUSION-1 · ritmo elegido por el dueño (mínimo 10 s, tope 6 h) o los 700 ms estándar.
  const pausa = Number(p.paceMs) >= 10_000 ? Math.min(Number(p.paceMs), 6 * 3600_000) : 700;
  const bucle = async (): Promise<void> => {
    for (const c of pendientes) {
      // «Anular» se relee ANTES DE CADA envío: con uno cada 10 min, esperar 10 envíos para
      // enterarse serían casi dos horas.
      if (id && (await filaParada(id))) break;
      let ok = false;
      let motivo = "";
      const salida: { wamid?: string } = {}; // ENTREGA-WA-1 · id del mensaje para seguir su entrega
      try {
        // REVISION-DIFUSION-1 · Entre seleccionar la audiencia y su turno pueden
        // pasar horas: releemos baja y ventana antes de CADA envío real.
        const actual = await getContact(c.phone);
        if (!actual) throw new Error("El contacto se eliminó antes de que le tocara el turno");
        if (hasOptedOut(actual)) throw new Error("Pidió no recibir mensajes antes de que le tocara el turno");
        const cuenta = p.senderPid && (actual.channel_account || Object.keys(actual.last_inbound_by || {}).length) ? "wa:" + p.senderPid : "";
        if (!inWindowFor(actual, cuenta)) throw new Error("La ventana de 24 h del número emisor se cerró antes de que le tocara el turno");
        const ctx = { contact: actual, linkCtx: { kind: "broadcast" as const, id, phone: c.phone }, out: salida };
        // Las CUATRO ramas comprueban el resultado real del envío: antes solo la de
        // texto plano lo hacía, y una difusión con botones/imagen sin credenciales
        // (o cuyo interactive Y su fallback fallaran) se contaba entera como
        // «enviada» → el panel pintaba «✓ Enviados: N · Fallos: 0» sin salir nada.
        if (p.imageUrl && buttons.length) ok = await sendButtons(c.phone, p.text, buttons, ctx, p.imageUrl);
        else if (p.imageUrl) ok = await sendImage(c.phone, p.imageUrl, p.text, ctx);
        else if (buttons.length) ok = await sendButtons(c.phone, p.text, buttons, ctx);
        else ok = await sendText(c.phone, p.text, ctx);
        if (!ok) motivo = "WhatsApp no aceptó el mensaje (el motivo está en Actividad)";
      } catch (e) {
        motivo = (e as Error).message || "fallo al enviar";
      }
      if (ok) sent++; else failed++;
      // DIFUSION-DETALLE-1 · impacto por destinatario. DIFUSION-MARCA-1 · se ESPERA: es la
      // marca de agua (quién ya se tocó); en void, un reinicio justo después lo perdía.
      if (id) {
        await dbAddBroadcastHit(id, { phone: c.phone, name: c.name || "", ok, error: motivo, mid: ok ? salida.wamid || "" : "" });
        await latido(id, sent, failed);
      }
      if (await esperar(pausa, id, sent, failed)) break; // throttling anti rate-limit o ritmo elegido
    }
  };
  // T02 · El scope ALS de runWithWaNumber sobrevive a los await del bucle entero:
  // todos los sendX de esta difusión usan las credenciales del emisor elegido.
  if (waCtx) await runWithWaNumber(waCtx, bucle);
  else await bucle();
  return { sent, failed, recipients: targets.length, outWindow: seg.length - targets.length, segTotal: seg.length };
}

/** Un destinatario de una difusión con plantilla (al segmento, o en lote desde Nueva
 *  conversación). Lanza si WhatsApp no la acepta o si la persona pidió la baja. */
async function enviarConPlantilla(
  kind: "plantilla" | "lote",
  o: LoteObjetivo,
  plan: BroadcastPlan,
  num: WaNumber | null,
): Promise<string> {
  const tpl = plan.tpl!;
  const ya = await findContactByPhoneLoose(o.phone);
  // Al retomar, alguien pudo pedir la baja mientras el envío estaba parado: se respeta.
  if (ya && hasOptedOut(ya)) throw new Error("Pidió no recibir mensajes antes de que le tocara el turno");
  if (kind === "plantilla") {
    // ENTREGA-WA-1 · devuelve el id del mensaje: la ficha de la difusión sigue su entrega.
    return (await sendTemplate(o.phone, tpl.name, tpl.language || "es", tpl.hasVar ? [o.name || "cliente"] : [])).wamid || "";
  }
  // LOTE (Nueva conversación → Varios): {{nombre}} por destinatario, ficha nueva si no
  // existía, etiquetas del lote, «guardar como contactos» y el mensaje en la Bandeja.
  const ps = (plan.params || []).map((p) => p.replace(/\{\{\s*nombre\s*\}\}/gi, o.name || "cliente"));
  const rT = await sendTemplate(o.phone, tpl.name, tpl.language || "es", ps);
  const acct = num ? "wa:" + num.phoneNumberId : "";
  if (!ya) {
    await createContact({ phone: o.phone, source: "panel", last_inbound: 0 });
    if (acct) await updateContact(o.phone, { channel_account: acct });
  } else if (!ya.channel_account && acct) {
    await updateContact(ya.phone, { channel_account: acct });
  }
  // LOTE-ETIQUETAS-1 · etiquetas del lote entero. CSV-CAMPOS-1 · más las de SU fila del listado
  // (la serie, el segmento…) y los datos sueltos que traía (puntuación, clics, días sin abrir).
  // Todo por unión aditiva: dbPatchContact nunca pisa lo que la ficha ya tiene. Un fallo al
  // enriquecer jamás tumba el envío del lote — el mensaje ya salió.
  const tags = [...(plan.tags || []), ...(o.tags || [])];
  const fields = o.fields && Object.keys(o.fields).length ? o.fields : undefined;
  if (tags.length || fields || o.email) {
    try { await enrichContact((ya?.phone) || o.phone, { tags, ...(fields ? { fields } : {}), ...(o.email ? { email: o.email } : {}) }); } catch { /* best-effort */ }
  }
  if (o.notes) {
    // CSV-CAMPOS-1 · la nota del listado (el «ángulo», observaciones…) va a los DOS sitios donde
    // el closer la va a buscar: fechada en el historial del contacto, y en el campo de notas de
    // su ficha — ahí se lee de un vistazo al abrirla. Se AÑADE: nunca pisa lo que ya hubiera, y
    // si el texto ya está no lo repite (un lote relanzado no acumula copias).
    const quien = (ya?.phone) || o.phone;
    try { await addContactNote(quien, o.notes, { kind: "note", author: "listado importado" }); } catch { /* best-effort */ }
    try {
      const f0 = await findContactByPhoneLoose(quien);
      const previo = String(f0?.notes || "").trim();
      if (f0 && previo.indexOf(o.notes) < 0) {
        await updateContact(f0.phone, { notes: (previo ? previo + String.fromCharCode(10) : "") + o.notes });
      }
    } catch { /* best-effort */ }
  }
  if (plan.save && o.name) {
    const f2 = await findContactByPhoneLoose(o.phone);
    if (f2 && !f2.name) await enrichContact(f2.phone, { name: o.name, tags: [] });
  }
  await appendPersistent((ya?.phone) || o.phone, ya?.bot_id || "", {
    role: "assistant",
    by: "difusion", // ATENCION-HUMANA-1
    // PLANTILLA-BANDEJA-1 · el texto real (body + variables), no el nombre.
    content: tplRenderText({ name: tpl.name, status: "APPROVED", body: tpl.body }, ps),
    ...(acct ? { acct } : {}),
    ...(rT.wamid ? { mid: rT.wamid } : {}),
    tpl: tpl.name,
    ...(tpl.buttons?.length ? { btns: tpl.buttons } : {}),
  });
  return rT.wamid || "";
}

// NOTIFICACIONES-1 · difusion: cómo acabó un envío masivo. Una por difusión y estado.
function avisarDifusion(b: BroadcastRec, estado: "sent" | "canceled" | "blocked" | "error", sent: number, failed: number, motivo = ""): void {
  const nombre = b.plan?.tpl?.name ? "«" + b.plan.tpl.name + "»" : (String(b.text || "").trim() ? "«" + String(b.text).replace(/\s+/g, " ").trim().slice(0, 50) + "»" : "");
  const cuenta = sent + (sent === 1 ? " enviado" : " enviados") + (failed ? " · " + failed + (failed === 1 ? " fallo" : " fallos") : "");
  const t = estado === "sent" ? { title: "Difusión terminada" + (nombre ? " " + nombre : ""), body: cuenta + "." }
    : estado === "canceled" ? { title: "Difusión anulada" + (nombre ? " " + nombre : ""), body: "Se paró a mitad: " + cuenta + "." }
    : { title: (estado === "blocked" ? "Difusión bloqueada" : "Difusión con error") + (nombre ? " " + nombre : ""), body: (motivo || "No se ha podido enviar.").slice(0, 220) };
  notificar({ kind: "difusion", title: t.title, body: t.body, channel: "whatsapp", link: "bcast", dedup: "difusion:" + b.id + ":" + estado, payload: { broadcastId: b.id, sent, failed } });
}
/** DIFUSION-MARCA-1 · EL motor de una difusión simple, sea cual sea su clase (libre,
 *  plantilla al segmento, lote de Nueva conversación) y venga de donde venga (petición
 *  del panel, programada vencida, o retomada tras un reinicio). Corre ya dentro del
 *  workspace dueño. Nunca lanza: deja la fila en su estado final (sent / canceled /
 *  blocked / error) y lo registra en Actividad. */
export async function ejecutarDifusion(b: BroadcastRec, opts: { reanudada?: boolean } = {}): Promise<void> {
  const id = String(b.id || "");
  if (!id || enCurso.has(id)) return;
  enCurso.add(id);
  const plan = b.plan || {};
  const kind = plan.kind;
  try {
    if (opts.reanudada && !kind) {
      // Fila de antes de la mejora: no hay plan con el que retomar. Se cierra con causa
      // visible en vez de quedarse «Enviando» eternamente.
      await dbUpdateBroadcast(id, {
        status: "error",
        // El claim la contó como retomada; no lo fue: se cerró. Sin esto el historial decía
        // «retomada tras un reinicio» en una fila que justamente NO se pudo retomar.
        resumed: 0,
        block_reason: "El panel se reinició a mitad de este envío y esta difusión es anterior a la mejora que permite retomarlo: lo ya enviado consta en el detalle uno a uno; al resto no le llegó nada.",
      });
      await logActivity({
        source: "broadcast", level: "warn", status: "error",
        summary: `Difusión ${id} interrumpida por un reinicio (anterior a la marca de agua): cerrada sin retomar`,
        payload: { file: "broadcasts.ts", fn: "ejecutarDifusion", broadcastId: id },
      });
      return;
    }
    // T02 · el emisor elegido tiene que seguir conectado. Si no, BLOQUEADA con causa visible
    // y reasignable desde el historial — nunca sale por el principal en silencio.
    if (b.sender_pid && !resolveWaNumber(b.sender_pid)) {
      await dbUpdateBroadcast(id, {
        status: "blocked",
        block_reason: "El número emisor elegido ya no está conectado en este workspace. Elige otro emisor en el historial para reanudarla.",
      });
      avisarDifusion(b, "blocked", 0, 0, "El número desde el que salía ya no está conectado. Elige otro en el historial de Difusión para reanudarla.");
      await logActivity({
        source: "broadcast", level: "warn", status: "blocked",
        summary: `Difusión ${id} bloqueada: su número emisor (${b.sender_pid}) ya no está conectado`,
        payload: { file: "broadcasts.ts", fn: "ejecutarDifusion", broadcastId: id, senderPid: b.sender_pid },
      });
      return;
    }
    // Lo ya tocado (al retomar) lo dice app_broadcast_hits, que se escribe tras cada envío.
    const hits = opts.reanudada ? await dbListBroadcastHits(id, 5000) : [];
    const omitir = new Set(hits.map((h) => h.phone));
    const base = { sent: hits.filter((h) => h.ok).length, failed: hits.filter((h) => !h.ok).length };
    const paceS = Number(b.pace_seconds) || 0;
    if (opts.reanudada) console.log(`[broadcast] retomando ${id} (${kind}): ${omitir.size} ya tocados de ${(plan.targets || []).length}`);

    if (kind === "libre" || !kind) {
      const r = await executeBroadcast({
        id, text: b.text, buttons: b.buttons, imageUrl: b.image_url, segment: b.segment,
        senderPid: b.sender_pid || "",
        paceMs: paceS * 1000, // RITMO-DIFUSION-1 · la programada respeta el ritmo guardado
        omitir: opts.reanudada ? omitir : undefined,
        base,
        solo: plan.targets?.length ? new Set(plan.targets.map((t) => t.phone)) : undefined,
      });
      const fin = await dbGetBroadcast(id);
      await dbUpdateBroadcast(id, {
        // Si la anularon a media salida, se queda anulada: lo enviado ya salió y lo dice el
        // contador, pero el estado no puede decir «enviada».
        status: fin && fin.status === "canceled" ? "canceled" : "sent",
        sent: r.sent, failed: r.failed,
        // La audiencia de la fila solo se fija en la primera pasada: al retomar no se
        // reescribe con lo que quedaba.
        ...(opts.reanudada ? {} : { recipients: r.recipients, out_window: r.outWindow }),
      });
      console.log(`[broadcast] ${id} ${opts.reanudada ? "retomada y " : ""}terminada → ${r.sent}/${r.recipients}`);
      avisarDifusion(b, fin && fin.status === "canceled" ? "canceled" : "sent", r.sent, r.failed);
      return;
    }

    // plantilla al segmento / lote de Nueva conversación
    if (!plan.tpl?.name) throw new Error("La difusión no tiene plantilla guardada en su plan, así que no se puede enviar.");
    const num = b.sender_pid ? resolveWaNumber(b.sender_pid) : null;
    const pendientes = (plan.targets || []).filter((t) => !omitir.has(t.phone));
    let sent = base.sent;
    let failed = base.failed;
    // RITMO-DIFUSION-1 · ritmo elegido (10 s a 6 h) o el estándar de cada clase.
    const pausa = paceS >= 10 ? Math.min(paceS * 1000, 6 * 3600_000) : (kind === "lote" ? 500 : 700);
    const bucle = async (): Promise<void> => {
      for (const o of pendientes) {
        if (await filaParada(id)) return;
        try {
          const mid = await enviarConPlantilla(kind, o, plan, num);
          sent++;
          await dbAddBroadcastHit(id, { phone: o.phone, name: o.name || "", ok: true, mid }); // DIFUSION-DETALLE-1 · ENTREGA-WA-1
        } catch (e) {
          failed++;
          await dbAddBroadcastHit(id, { phone: o.phone, name: o.name || "", ok: false, error: (e as Error).message || "fallo al enviar" });
        }
        await latido(id, sent, failed);
        if (await esperar(pausa, id, sent, failed)) return;
      }
    };
    if (num) await runWithWaNumber({ token: num.token, phoneId: num.phoneNumberId }, bucle);
    else await bucle();
    const fin = await dbGetBroadcast(id);
    await dbUpdateBroadcast(id, { status: fin && fin.status === "canceled" ? "canceled" : "sent", sent, failed });
    avisarDifusion(b, fin && fin.status === "canceled" ? "canceled" : "sent", sent, failed);
    if (kind === "lote") {
      await logActivity({
        source: "wa-send", status: "ok",
        summary: `Lote «${plan.tpl.name}» desde «${num?.label || b.sender_pid || "principal"}»: ${sent} aceptados · ${failed} fallos · ${plan.omitidos || 0} omitidos${opts.reanudada ? " · retomado tras un reinicio" : ""}`,
        payload: { file: "broadcasts.ts", fn: "ejecutarDifusion", broadcastId: id, senderPid: b.sender_pid, template: plan.tpl.name, total: (plan.targets || []).length, sent, failed, omitidos: plan.omitidos || 0, reanudada: !!opts.reanudada },
      });
    }
  } catch (e) {
    const msg = (e as Error).message || "";
    console.error(`[broadcast] ${id} falló a mitad:`, msg);
    try {
      // T02 · si lo que reventó fue el EMISOR (desconectado entre validar y ejecutar), la
      // difusión queda 'blocked' con causa reasignable desde el historial — no un 'error' opaco.
      if (msg.includes("emisor")) await dbUpdateBroadcast(id, { status: "blocked", block_reason: msg.slice(0, 300) });
      else await dbUpdateBroadcast(id, { status: "error", block_reason: msg.slice(0, 300) });
      avisarDifusion(b, msg.includes("emisor") ? "blocked" : "error", 0, 0, msg.slice(0, 220));
    } catch { /* nada que hacer */ }
    // FASE-5: telemetría. NO se loguea el texto del mensaje (puede traer vars sensibles).
    await logActivity({
      source: "broadcast", level: "error", status: "error",
      summary: `Difusión ${id} falló: ${msg.slice(0, 160)}`,
      payload: { file: "broadcasts.ts", fn: "ejecutarDifusion", broadcastId: id, kind: kind || "libre", segment: b.segment, error: msg.slice(0, 400) },
    });
  } finally {
    enCurso.delete(id);
  }
}

/** Procesa las difusiones programadas vencidas. Lo invoca el scheduler cada 60 s. */
export async function runDueBroadcasts(): Promise<void> {
  for (const b of await dbDueBroadcasts()) {
    // Multi-tenant W8: cada difusión corre bajo su workspace dueño.
    // Fallback 'default' si la fila no trae tenant_id (regresión zero).
    await runWithWorkspace(b.tenant_id || "default", async () => {
      // DIFUSION-MARCA-1 · el motor único hace el resto: emisor (bloqueada con causa si ya no
      // está conectado), latido, avance, anulación y estado final. La programada nace sin plan
      // (la audiencia se resuelve al salir): executeBroadcast fija la lista en la fila antes
      // del primer envío, y desde ahí un reinicio ya no la pierde.
      await ejecutarDifusion(b);
    });
  }
}

/** DIFUSION-MARCA-1 · retoma las difusiones que un proceso anterior dejó a mitad («Enviando»
 *  sin latido). Lo invoca el scheduler cada 60 s — y por tanto ~1-2 min después de cada
 *  arranque. Sin await por difusión: un lote de 400 no puede tener el tick colgado. */
export async function reanudarDifusionesHuerfanas(): Promise<void> {
  const filas = await dbClaimOrphanBroadcasts(HUERFANA_MS, [...enCurso]);
  for (const b of filas) {
    const kind = b.plan?.kind || "sin plan";
    const hechos = (Number(b.sent) || 0) + (Number(b.failed) || 0);
    console.log(`[broadcast] ${b.id} estaba «Enviando» sin latido (${kind}, ${hechos} de ${b.recipients}) → se retoma`);
    void runWithWorkspace(b.tenant_id || "default", async () => {
      await logActivity({
        source: "broadcast", level: "warn", status: "resumed",
        summary: `Difusión ${b.id} retomada tras un reinicio: iba por ${hechos} de ${b.recipients}`,
        payload: { file: "broadcasts.ts", fn: "reanudarDifusionesHuerfanas", broadcastId: b.id, kind, hechos, recipients: b.recipients, resumed: b.resumed || 0 },
      });
      await ejecutarDifusion(b, { reanudada: true });
    }).catch((e) => console.error("[broadcast] reanudar:", (e as Error).message));
  }
}
