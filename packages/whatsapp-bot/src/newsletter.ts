/**
 * NEWSLETTER-1 · El motor de la sección Newsletter.
 *
 * Reparto de responsabilidades (decidido así a propósito):
 *
 *   - NUESTRA tabla `app_newsletters` es la MEMORIA: el borrador, la instrucción
 *     con la que la IA lo redactó, los correos sueltos elegidos a mano y de qué
 *     negocio es. Nada de eso lo sabe guardar la web.
 *   - LA WEB (systeme.io / leadmatch-lab) es el BRAZO QUE ENVÍA: tiene la lista,
 *     las etiquetas, el remitente verificado, las bajas y la reputación de envío.
 *     Reimplementar eso aquí sería empezar de cero un servidor de correo.
 *   - `sio_id` es el hilo entre las dos.
 *
 * Y por eso la PROGRAMACIÓN se delega en la web (`PUT /newsletters/{id}/schedule`):
 * si el reloj fuese nuestro, un reinicio de Railway a la hora mala se comería un
 * envío. Nuestro latido de 60 s NO envía: reconcilia y vigila.
 */
import crypto from "node:crypto";
import { chat, type ChatMessage } from "./llm.js";
import { logActivity } from "./activity.js";
import { currentWorkspaceId } from "./workspace.js";
import {
  dbGetNewsletter,
  dbUpsertNewsletter,
  type NewsletterRec,
} from "./db.js";
import { getAccount, getActiveAccount, type SiAccount } from "./systemeio-accounts.js";
import {
  withPublicApiKey,
  ensureTagId,
  listTags,
  listTagsStrict,
  httpStatusDe,
  countContactsByTag,
  syncContactWithTags,
  createNewsletter,
  updateNewsletter,
  getNewsletter,
  setNewsletterIncludedTags,
  setNewsletterExcludedTags,
  scheduleNewsletter,
  sendNewsletter,
  sendNewsletterTest,
  deleteNewsletter,
} from "./systemeio-public-api.js";

// ---------------------------------------------------------------- utilidades

/** Un id nuevo para una fila nuestra. Mismo estilo que el resto del panel. */
export function nuevoIdNewsletter(): string {
  return `nl_${crypto.randomUUID()}`;
}

/** Fila vacía con todos los campos en su valor neutro: evita `undefined` sueltos
 *  viajando hasta el SQL, que es de donde salen los `null` en columnas NOT NULL. */
export function newsletterVacio(creadoPor = ""): NewsletterRec {
  const ahora = Date.now();
  return {
    id: nuevoIdNewsletter(),
    tenant_id: currentWorkspaceId(),
    account_id: "",
    sio_id: 0,
    subject: "",
    preview_text: "",
    body_html: "",
    sender_name: "",
    sender_email: "",
    prompt: "",
    include_tags: [],
    exclude_tags: [],
    contacts: [],
    bridge_tag: "",
    status: "draft",
    scheduled_at: null,
    sent_at: null,
    recipients: 0,
    result: "",
    routine_id: "",
    mailing_id: 0,
    created_by: creadoPor,
    created_at: ahora,
    updated_at: ahora,
  };
}

/** Texto de error legible para el cliente: sin trazas, sin nombres de API. */
export function motivoLegible(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const limpio = raw.replace(/\s+/g, " ").trim();
  return limpio.slice(0, 400) || "no se pudo completar";
}

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Normaliza y deduplica una lista de correos escritos a mano. */
export function normalizaCorreos(lista: unknown): string[] {
  const arr = Array.isArray(lista) ? lista : [];
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const x of arr) {
    const e = String(x ?? "").trim().toLowerCase();
    if (!e || !RE_EMAIL.test(e) || vistos.has(e)) continue;
    vistos.add(e);
    out.push(e);
  }
  return out;
}

/** Normaliza nombres de etiqueta (se guardan por NOMBRE, no por id — ver NewsletterRec). */
export function normalizaEtiquetas(lista: unknown): string[] {
  const arr = Array.isArray(lista) ? lista : [];
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const x of arr) {
    const t = String(x ?? "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Resuelve la cuenta web con la que se envía este boletín.
 *
 * Si la fila no trae cuenta (borrador viejo, o el cliente solo tiene una), cae a
 * la activa. Si no hay ninguna conectada, el error lo dice en cristiano: el
 * cliente tiene que poder arreglarlo sin llamar a nadie.
 */
export async function cuentaDe(rec: NewsletterRec): Promise<SiAccount> {
  const acc = rec.account_id ? await getAccount(rec.account_id) : await getActiveAccount();
  if (!acc) {
    throw new Error(
      "No hay ninguna web conectada: conéctala en Conexiones para poder enviar el boletín",
    );
  }
  if (!acc.apiKey) {
    throw new Error(
      `La web «${acc.label || acc.accountEmail || "conectada"}» no tiene clave de acceso guardada: añádela en Conexiones`,
    );
  }
  return acc;
}

// -------------------------------------------------------------------- LA IA

export interface BorradorIA {
  subject: string;
  previewText: string;
  bodyHtml: string;
}

/** El HTML que devuelve la IA se limpia: fuera <script>, <iframe>, <style> y los
 *  manejadores `on*=`. No es paranoia teórica — ese HTML acaba en el buzón de
 *  cientos de personas y en la vista previa del panel. */
export function limpiaHtml(html: string): string {
  return String(html ?? "")
    .replace(/<\s*(script|iframe|object|embed|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed|style)\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript\s*:/gi, "")
    .trim();
}

function escapaHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Redacta el boletín a partir de la instrucción libre del cliente.
 *
 * Devuelve asunto + texto de vista previa + cuerpo HTML. El `json:true` es lo que
 * hace que esto sea fiable: sin él, el modelo contesta «¡Claro! Aquí tienes…» y
 * ese preámbulo acabaría siendo el asunto del correo.
 */
/**
 * IA-POTENCIA-1 · Qué IA redacta el boletín. Todas van por la misma clave del
 * panel (DeepInfra); '' = la IA normal del panel. Es una LISTA CERRADA: el
 * servidor no acepta un modelo que no esté aquí. Si se cambia, cambiar también
 * RT_IA en el panel (admin.ts). Comprobar que siguen vivos en
 * https://api.deepinfra.com/models/list antes de tocarla.
 */
export const IA_REDACCION: ReadonlyArray<{ id: string; potencia: string; nombre: string }> = [
  { id: "", potencia: "Estándar", nombre: "La IA del panel" },
  { id: "deepseek-ai/DeepSeek-V4-Pro-0813", potencia: "Alta", nombre: "DeepSeek V4 Pro" },
  { id: "Qwen/Qwen3.8-Max", potencia: "Alta", nombre: "Qwen 3.8 Max" },
  { id: "openai/gpt-oss-120b", potencia: "Alta", nombre: "OpenAI GPT-OSS 120B" },
  { id: "openai/gpt-oss-120b-Turbo", potencia: "Alta", nombre: "OpenAI GPT-OSS 120B Turbo" },
  { id: "openai/gpt-oss-120b-Ultra", potencia: "Alta", nombre: "OpenAI GPT-OSS 120B Ultra" },
  { id: "openai/gpt-oss-20b", potencia: "Estándar", nombre: "OpenAI GPT-OSS 20B" },
  { id: "anthropic/claude-sonnet-5", potencia: "Máxima", nombre: "Claude Sonnet 5" },
  { id: "google/gemini-3.1-pro", potencia: "Máxima", nombre: "Gemini 3.1 Pro" },
];

/** Un modelo de la lista cerrada, o '' (la IA del panel) si no lo es. */
export function modeloRedaccion(x: unknown): string {
  const v = String(x ?? "").trim();
  return IA_REDACCION.some((m) => m.id === v) ? v : "";
}

// ENLACE-CTA-1 · la IA escribe a veces la dirección entera («https://…») aunque se le
// pida un texto. Aquí se corrige siempre: enlace cuyo texto es una URL, o URL suelta
// en el texto, pasa a ser <a href="URL">Entra aquí</a>.
const CTA_ENLACE = "Entra aquí";
export function enlacesConTexto(html: string): string {
  const url = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/gi;
  let dentroDeA = 0;
  return String(html ?? "")
    .split(/(<[^>]+>)/)
    .map((trozo) => {
      if (trozo.startsWith("<")) {
        if (/^<a\b/i.test(trozo)) dentroDeA++;
        else if (/^<\/a\s*>/i.test(trozo)) dentroDeA = Math.max(0, dentroDeA - 1);
        return trozo;
      }
      if (dentroDeA) {
        // texto del enlace: si es solo una dirección, se cambia por la llamada
        return /^\s*(https?:\/\/|www\.)\S+\s*$/i.test(trozo) ? CTA_ENLACE : trozo;
      }
      return trozo.replace(url, (u) => `<a href="${u}">${CTA_ENLACE}</a>`);
    })
    .join("");
}

// FIRMA-2 · la firma de las rutinas la monta el código, igual en cada envío:
// despedida, nombre, cargo o frase, y un enlace. La IA solo escribe el cuerpo.
export interface Firma { despedida: string; cargo: string; web: string }

export function normalizaFirma(x: unknown): Firma {
  const f = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const web = String(f.web ?? "").trim().slice(0, 200);
  return {
    despedida: String(f.despedida ?? "").trim().slice(0, 60),
    cargo: String(f.cargo ?? "").trim().slice(0, 120),
    web: !web ? "" : /^https?:\/\//i.test(web) ? web : "https://" + web,
  };
}

export function firmaHtml(nombre: string, f: Firma): string {
  const lineas: string[] = [];
  if (f.despedida) lineas.push(escapaHtml(f.despedida));
  if (nombre.trim()) lineas.push(`<strong>${escapaHtml(nombre.trim())}</strong>`);
  const gris = "color:#6b7280;font-size:14px";
  if (f.cargo) lineas.push(`<span style="${gris}">${escapaHtml(f.cargo)}</span>`);
  if (/^https?:\/\/[^\s"<>]+$/i.test(f.web)) {
    const txt = f.web.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    lineas.push(`<a href="${escapaHtml(f.web)}" style="${gris}">${escapaHtml(txt)}</a>`);
  }
  return lineas.length ? `<p style="margin:24px 0 0;line-height:1.5">${lineas.join("<br>")}</p>` : "";
}

// CUERPO-MINIMO-1 · por qué un cuerpo no vale para enviarse ('' = vale). El sistema
// pide 120-400 palabras; el suelo es más bajo para no tirar correos buenos y breves.
export const CUERPO_MIN_PALABRAS = 80;
export function fallosCuerpo(bodyHtml: string, urlsPedidas: string[] = []): string {
  const palabras = bodyHtml.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;
  const fallos: string[] = [];
  if (palabras < CUERPO_MIN_PALABRAS) {
    fallos.push(`el cuerpo tiene ${palabras} palabras y necesita al menos ${CUERPO_MIN_PALABRAS}`);
  }
  if (urlsPedidas.length) {
    const hrefs = [...bodyHtml.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)].map((x) => x[1].replace(/\/$/, ""));
    if (!urlsPedidas.some((u) => hrefs.includes(u.replace(/\/$/, "")))) {
      fallos.push(`falta el enlace a ${urlsPedidas[0]} en la llamada a la acción`);
    }
  }
  return fallos.join("; ");
}

export async function redactarConIA(
  prompt: string,
  ctx: { negocio?: string; tono?: string; idioma?: string; firmante?: string; modelo?: string; firma?: Firma; contexto?: string } = {},
): Promise<BorradorIA> {
  const instruccion = String(prompt ?? "").trim();
  if (!instruccion) throw new Error("Escribe qué quieres contar en el boletín");

  const negocio = String(ctx.negocio ?? "").trim();
  const tono = String(ctx.tono ?? "cercano y profesional").trim();
  const idioma = String(ctx.idioma ?? "español").trim();
  const firmante = String(ctx.firmante ?? "").trim();

  const sistema = [
    "Eres redactor de boletines por correo.",
    `Escribes en ${idioma}, con un tono ${tono}.`,
    negocio ? `El remitente es «${negocio}».` : "",
    ctx.firma
      ? "No escribas despedida ni firma al final: se añaden aparte."
      : firmante ? `Firma como «${firmante}».` : "",
    "Devuelves SOLO un objeto JSON con estas claves exactas:",
    '{"subject": "...", "previewText": "...", "bodyHtml": "..."}',
    "- subject: máximo 70 caracteres, sin comillas ni emojis de relleno.",
    "- previewText: máximo 120 caracteres; es la línea que se ve en la bandeja debajo del asunto, y NO repite el asunto.",
    "- bodyHtml: el cuerpo del correo en HTML SIMPLE (solo <p>, <h2>, <ul>, <li>, <strong>, <em>, <a>, <br>).",
    "  Sin <html>, <head>, <body>, <script>, <style> ni CSS externo. Los estilos, en línea.",
    "  Entre 120 y 400 palabras, con una llamada a la acción clara al final.",
    "  Todo enlace va como <a href=\"URL\">texto de 2 a 5 palabras que invita a pulsar</a>. La dirección NUNCA se ve escrita en el correo.",
    "No inventes datos concretos (precios, fechas, cifras) que no estén en la instrucción.",
  ]
    .filter(Boolean)
    .join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: sistema },
    { role: "user", content: instruccion },
    // VARIEDAD-1 · historial de la serie y titulares reales (newsletter-rutinas.ts).
    ...(ctx.contexto?.trim() ? [{ role: "user" as const, content: ctx.contexto.trim() }] : []),
  ];

  // JSON-ROTO-1 · un correo SOLO sale si la IA devolvió el JSON entero con asunto y
  // cuerpo. Antes, si el JSON llegaba cortado (los modelos que «piensan» gastan parte
  // del margen de palabras), el texto crudo «{ "subject": … » se enviaba como cuerpo
  // con el asunto «Novedades». Ahora: más margen, un reintento con la IA del panel y,
  // si tampoco, error — que la rutina registra y no envía.
  //
  // CUERPO-MINIMO-1 · un JSON válido tampoco basta: Gemini 3.1 Pro devolvió un
  // bodyHtml de UNA frase (sin giro ni CTA) y salió a 2.698 personas. Ahora el cuerpo
  // debe tener un mínimo de palabras y, si la instrucción trae una URL, llevar al
  // menos un enlace a ella. Si no, se repite con la misma IA avisándole del fallo y
  // después con la del panel.
  const urlsPedidas = [...instruccion.matchAll(/https?:\/\/[^\s<>"')]+[^\s<>"'.,;:!?)]/gi)].map((x) => x[0]);
  const modelo = modeloRedaccion(ctx.modelo);
  const intentos = modelo ? [modelo, modelo, ""] : ["", ""];
  let aviso = "";
  for (const [i, m] of intentos.entries()) {
    let texto = "";
    try {
      const msgs: ChatMessage[] = aviso ? [...messages, { role: "user", content: aviso }] : messages;
      texto = await chat(msgs, { json: true, maxTokens: 6000, temperature: 0.7, ...(m ? { model: m } : {}) });
    } catch (e) {
      if (i === intentos.length - 1) throw e;
      continue;
    }
    let obj: Record<string, unknown> = {};
    try {
      // Algunos modelos envuelven el JSON en ```json … ``` aunque se pida json:true.
      const limpio = String(texto ?? "")
        .replace(/^\s*```(?:json)?/i, "")
        .replace(/```\s*$/, "")
        .trim();
      const parsed = JSON.parse(limpio);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      obj = {};
    }
    const subject = String(obj.subject ?? "").trim().slice(0, 255);
    const previewText = String(obj.previewText ?? "").trim().slice(0, 140);
    let bodyHtml = enlacesConTexto(limpiaHtml(String(obj.bodyHtml ?? "")));
    const fallo = bodyHtml ? fallosCuerpo(bodyHtml, urlsPedidas) : "";
    if (fallo) {
      console.warn(`[newsletter] CUERPO-MINIMO-1 · la IA ${m || "del panel"} devolvió un cuerpo flojo: ${fallo}`);
      aviso = `Tu respuesta anterior no vale: ${fallo}. Vuelve a escribir el correo COMPLETO siguiendo toda la estructura de la instrucción, y devuelve solo el JSON.`;
      continue;
    }
    // FIRMA-1 · la IA se salta a veces la firma aunque se le pida: si el nombre no
    // aparece en el cuerpo, se añade al final.
    if (bodyHtml && ctx.firma) bodyHtml += firmaHtml(firmante, ctx.firma);
    else if (bodyHtml && firmante && !bodyHtml.replace(/<[^>]*>/g, " ").includes(firmante)) {
      bodyHtml += `<p>${escapaHtml(firmante)}</p>`;
    }
    if (subject && bodyHtml) return { subject, previewText, bodyHtml };
    console.warn(`[newsletter] JSON-ROTO-1 · la IA ${m || "del panel"} devolvió un correo incompleto (${String(texto ?? "").length} caracteres)`);
  }
  throw new Error("La IA devolvió el correo cortado, demasiado corto o sin el enlace pedido, así que no se ha enviado nada. Vuelve a intentarlo o elige otra IA en la rutina.");
}

// ------------------------------------------------- audiencia (quién lo recibe)

export interface EtiquetaAudiencia {
  id: number;
  name: string;
  contacts: number;
}

/**
 * Las etiquetas de la web con cuántos contactos tiene cada una, para que el
 * cliente elija sabiendo a cuánta gente escribe. El conteo se pide etiqueta a
 * etiqueta (la API no da un agregado), así que se limita: 60 llamadas por
 * abrir una pantalla ya es demasiado.
 */
export async function audienciaDeCuenta(
  accountId: string,
  opts: { conConteo?: boolean; maxConteos?: number } = {},
): Promise<EtiquetaAudiencia[]> {
  const acc = accountId ? await getAccount(accountId) : await getActiveAccount();
  if (!acc?.apiKey) {
    throw new Error(
      "Esa web no tiene clave de acceso guardada: conéctala en Conexiones para ver sus etiquetas",
    );
  }
  const max = Math.max(0, Math.min(opts.maxConteos ?? 40, 80));
  return withPublicApiKey(acc.apiKey, async () => {
    const tags = await listTags();
    const out: EtiquetaAudiencia[] = tags.map((t) => ({ id: t.id, name: t.name, contacts: -1 }));
    if (opts.conConteo === false) return out;
    for (let i = 0; i < out.length && i < max; i++) {
      try {
        out[i].contacts = await countContactsByTag(out[i].id);
      } catch {
        out[i].contacts = -1; // -1 = «no se pudo contar», el panel lo pinta como «—»
      }
    }
    return out;
  });
}

/**
 * Estimación de destinatarios: suma de las etiquetas incluidas + los correos
 * sueltos. Es una ESTIMACIÓN y así se dice en el panel — un contacto con dos
 * etiquetas incluidas se cuenta dos veces aquí, pero la web lo deduplica al
 * enviar. Contarlo exacto exigiría descargar la lista entera.
 */
export async function estimaDestinatarios(rec: NewsletterRec): Promise<number> {
  const acc = await cuentaDe(rec);
  return withPublicApiKey(acc.apiKey!, async () => {
    const tags = await listTags();
    const porNombre = new Map(tags.map((t) => [t.name.trim().toLowerCase(), t.id]));
    let total = 0;
    for (const nombre of rec.include_tags) {
      const id = porNombre.get(nombre.trim().toLowerCase());
      if (!id) continue;
      try {
        total += await countContactsByTag(id);
      } catch {
        /* una etiqueta que no se deja contar no invalida la estimación */
      }
    }
    return total + rec.contacts.length;
  });
}

// ------------------------------------------------ publicación y envío en la web

/** Nombre de la etiqueta puente para los correos sueltos de un boletín.
 *  Lleva el id de la fila dentro para que dos boletines no se pisen la audiencia. */
export function nombreEtiquetaPuente(rec: NewsletterRec): string {
  return `Boletín ${rec.id.replace(/^nl_/, "").slice(0, 8)}`;
}

/**
 * Resuelve NOMBRES de etiqueta a ids de ESTA cuenta, creando las que falten.
 *
 * Se guarda el nombre y no el id a propósito: los ids son de una cuenta. Si el
 * cliente cambia de web entre escribir el borrador y enviarlo, un id guardado
 * apuntaría a una etiqueta ajena y el boletín saldría a la gente equivocada.
 * Debe llamarse DENTRO de withPublicApiKey.
 */
async function idsDeEtiquetas(nombres: string[], crear: boolean): Promise<number[]> {
  if (!nombres.length) return [];
  // UN listado para todos los nombres, y un listado que FALLA si la web no responde.
  // La versión tolerante devolvía vacío ante un 500 o un corte, y con eso una etiqueta
  // excluida se caía en silencio: el boletín salía también a quien no debía recibirlo.
  const todas = await listTagsStrict();
  const ids: number[] = [];
  for (const n of nombres) {
    const wanted = n.trim().toLowerCase();
    if (!wanted) continue;
    let id = todas.find((t) => t.name.trim().toLowerCase() === wanted)?.id || 0;
    // Aquí NO se traga el error: el tope de etiquetas del plan o un corte de red tienen
    // que PARAR el envío con su motivo, no recortar la audiencia sin decirlo. Lo único
    // que no suma es una etiqueta que no existe y no se autoriza crear (ensureTagId → 0).
    if (!id && crear) id = await ensureTagId(n, true);
    if (id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Mete los correos sueltos en la lista de la web y les cuelga la etiqueta puente.
 *
 * systeme.io solo sabe enviar boletines POR ETIQUETA. El cliente, en cambio,
 * quiere poder escribir cuatro correos a mano. El puente es la traducción entre
 * las dos ideas, y reutiliza `syncContactWithTags`, que ya crea el contacto si no
 * existe y respeta el nombre que ya tuviera.
 */
async function tiendeElPuente(rec: NewsletterRec, etiqueta: string): Promise<number> {
  let ok = 0;
  for (const email of rec.contacts) {
    try {
      await syncContactWithTags(email, { tags: [etiqueta] });
      ok++;
    } catch (e) {
      await logActivity({
        source: "newsletter",
        level: "warn",
        summary: `No se pudo añadir ${email} a la audiencia del boletín`,
        payload: { newsletter: rec.id, error: motivoLegible(e) },
      });
    }
  }
  return ok;
}

/** JSON-ROTO-2 · ¿el cuerpo es (o contiene) la respuesta cruda de la IA? */
export function correoPareceRoto(html: string): boolean {
  const texto = String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&lt;/g, "<").trim();
  return /^\{/.test(texto) || /"(subject|previewText|bodyHtml)"\s*:/.test(texto);
}

/** SIN-ESTADISTICAS-1 · se guarda en `result`: el panel lo usa para no prometer
 *  estadísticas que la web nunca va a tener. */
export const AVISO_UNO_A_UNO = "Salió uno a uno a los correos sueltos: tu web no guarda aperturas ni clics de estos envíos.";

export interface ResultadoPublicar {
  sioId: number;
  destinatarios: number;
  programado: string | null;
  /** Algo que salió a medias y el cliente tiene que saber (p. ej. correos sueltos fuera). */
  aviso?: string;
}

/**
 * Sube el boletín a la web y lo deja listo: contenido, etiquetas incluidas y
 * excluidas, etiqueta puente para los correos sueltos y, si toca, programación.
 *
 * `accion`:
 *   - "guardar"   → solo sincroniza contenido y audiencia (borrador en la web).
 *   - "programar" → además fija la fecha en la web (la web es quien dispara).
 *   - "enviar"    → lo manda ahora mismo.
 *
 * MUTA `rec` (sio_id, bridge_tag, recipients) para que el llamante lo persista.
 */
export async function publicarEnWeb(
  rec: NewsletterRec,
  accion: "guardar" | "programar" | "enviar",
): Promise<ResultadoPublicar> {
  const asunto = String(rec.subject || "").trim();
  if (!asunto) throw new Error("El boletín necesita un asunto antes de salir");
  if (!String(rec.body_html || "").trim()) throw new Error("El boletín no tiene contenido");
  // JSON-ROTO-2 · última barrera antes de algo irreversible: si el cuerpo trae restos
  // de la respuesta de la IA sin interpretar ("subject": …, "bodyHtml": …), no sale.
  if (accion !== "guardar" && correoPareceRoto(rec.body_html)) {
    throw new Error("El correo trae la respuesta de la IA sin terminar, así que no se ha enviado. Vuelve a generarlo.");
  }
  const acc = await cuentaDe(rec);
  rec.account_id = acc.id;

  if (accion === "programar") {
    if (!rec.scheduled_at) throw new Error("Elige la fecha y la hora del envío");
    if (rec.scheduled_at <= Date.now()) {
      throw new Error("Esa fecha ya pasó: elige un momento futuro");
    }
  }
  if (accion !== "guardar" && !rec.include_tags.length && !rec.contacts.length) {
    // Sin audiencia, systeme.io acepta el envío y no le llega a nadie: un envío
    // «correcto» del que el cliente no se entera hasta que pregunta por qué no
    // lo ha recibido nadie.
    throw new Error("Elige al menos una etiqueta o un contacto que lo reciba");
  }

  return withPublicApiKey(acc.apiKey!, async () => {
    const contenido = {
      subject: asunto,
      previewText: rec.preview_text || null,
      editorType: "classic" as const,
      bodyHtml: limpiaHtml(rec.body_html),
      ...(rec.sender_email ? { senderEmail: rec.sender_email } : {}),
      ...(rec.sender_name ? { senderName: rec.sender_name } : {}),
    };

    // ¿Existe ya allí? Si el id guardado apunta a algo que ya no está (borrado a
    // mano en la web), se crea de nuevo en vez de fallar con un 404 opaco.
    let sioId = rec.sio_id > 0 ? rec.sio_id : 0;
    if (sioId > 0) {
      const existe = await getNewsletter(sioId);
      if (!existe) sioId = 0;
      else if (existe.isSent && accion !== "guardar") {
        throw new Error("Ese boletín ya se envió desde la web: duplica una copia para volver a enviarlo");
      }
    }
    if (sioId > 0) {
      await updateNewsletter(sioId, contenido);
    } else {
      const creado = await createNewsletter(contenido);
      sioId = creado.id;
    }
    rec.sio_id = sioId;

    // --- audiencia -------------------------------------------------------
    const incluidas = [...rec.include_tags];
    let puenteOk = 0;
    let aviso = "";
    if (rec.contacts.length) {
      const puente = rec.bridge_tag || nombreEtiquetaPuente(rec);
      rec.bridge_tag = puente;
      // PUENTE-1 · La etiqueta puente se crea PRIMERO. syncContactWithTags solo asigna
      // etiquetas que ya existen (crear gasta el cupo del plan), así que colgarla antes
      // de crearla la saltaba en silencio: los correos sueltos no la recibían nunca, y
      // después se creaba vacía. Si no se puede crear (tope del plan) y hay etiquetas
      // elegidas, el boletín sale a ellas y se DICE que los correos sueltos se quedan fuera.
      let puedePuente = true;
      try {
        await ensureTagId(puente, true);
      } catch (e) {
        // DIRECTO-1 · solo correos sueltos y sin sitio para la etiqueta puente (el plan
        // de la web tiene tope de etiquetas): se manda a cada correo uno a uno, sin
        // etiqueta. Solo para «enviar» y listas cortas escritas a mano.
        if (!rec.include_tags.length && accion === "enviar" && rec.contacts.length <= 20) {
          let n = 0;
          for (const email of rec.contacts) {
            await sendNewsletterTest(sioId, email);
            n++;
          }
          rec.recipients = n;
          // SIN-ESTADISTICAS-1 · el envío de prueba de la web no crea envío en sus
          // estadísticas: nunca habrá aperturas ni clics que enseñar. Se DICE.
          return { sioId, destinatarios: n, programado: null, aviso: AVISO_UNO_A_UNO };
        }
        if (!rec.include_tags.length) throw e;
        puedePuente = false;
        aviso = `Los correos sueltos no lo han recibido: ${motivoLegible(e)}`;
      }
      if (puedePuente) puenteOk = await tiendeElPuente(rec, puente);
      if (puenteOk > 0 && !incluidas.some((t) => t.toLowerCase() === puente.toLowerCase())) {
        incluidas.push(puente);
      }
    }

    const idsIncl = await idsDeEtiquetas(incluidas, true);
    // Las EXCLUIDAS no se crean: excluir a una etiqueta que no existe no protege
    // a nadie, y crearla ensucia la cuenta del cliente con etiquetas fantasma.
    const idsExcl = await idsDeEtiquetas(rec.exclude_tags, false);

    if (accion !== "guardar" && !idsIncl.length) {
      throw new Error("Ninguna de las etiquetas elegidas existe en la web: revisa la audiencia");
    }
    await setNewsletterIncludedTags(sioId, idsIncl);
    await setNewsletterExcludedTags(sioId, idsExcl);

    // --- destinatarios ---------------------------------------------------
    let destinatarios = 0;
    for (const id of idsIncl) {
      try {
        destinatarios += await countContactsByTag(id);
      } catch {
        /* no poder contar no impide enviar */
      }
    }
    rec.recipients = destinatarios;

    // --- disparo ---------------------------------------------------------
    let programado: string | null = null;
    if (accion === "programar") {
      programado = new Date(rec.scheduled_at!).toISOString();
      await scheduleNewsletter(sioId, programado);
    } else if (accion === "enviar") {
      // Si venía programado en la web, se retira la programación antes de
      // mandarlo a mano: si no, saldría dos veces.
      await scheduleNewsletter(sioId, null).catch(() => {});
      await sendNewsletter(sioId);
    }

    return { sioId, destinatarios, programado, ...(aviso ? { aviso } : {}) };
  });
}

/** Envía una prueba a un solo correo. No toca la audiencia ni marca nada como enviado. */
export async function enviarPrueba(rec: NewsletterRec, email: string): Promise<void> {
  const destino = String(email ?? "").trim().toLowerCase();
  if (!RE_EMAIL.test(destino)) throw new Error("Ese correo no parece válido");
  // La prueba necesita que el contenido esté arriba: si no, systeme.io manda el
  // boletín anterior (o uno vacío) y el cliente cree que su texto no se guarda.
  await publicarEnWeb(rec, "guardar");
  const acc = await cuentaDe(rec);
  await withPublicApiKey(acc.apiKey!, () => sendNewsletterTest(rec.sio_id, destino));
}

/** Retira la programación de la web. Se llama al cancelar o al volver a borrador. */
export async function desprogramarEnWeb(rec: NewsletterRec): Promise<void> {
  if (!rec.sio_id) return;
  const acc = await cuentaDe(rec);
  await withPublicApiKey(acc.apiKey!, () => scheduleNewsletter(rec.sio_id, null));
}

/** Borra también la copia de la web. Que un boletín borrado del panel siga
 *  programado allí y salga solo es exactamente lo que no puede pasar. */
export async function borrarEnWeb(rec: NewsletterRec): Promise<void> {
  if (!rec.sio_id) return;
  const acc = await cuentaDe(rec);
  await withPublicApiKey(acc.apiKey!, async () => {
    await scheduleNewsletter(rec.sio_id, null).catch(() => {});
    try {
      await deleteNewsletter(rec.sio_id);
    } catch (e) {
      // Si la web ya no lo tiene (lo borraron allí a mano), no queda nada que retirar:
      // no es un fallo, y tratarlo como tal dejaría la fila imposible de borrar aquí.
      if (httpStatusDe(e) === 404) return;
      throw e;
    }
  });
}

// ------------------------------------------------------------ reconciliación

/**
 * Cierra un boletín que el latido ha reclamado ('scheduled' → 'sending').
 *
 * OJO con lo que hace y lo que NO hace. Quien envía es la web, por su propia
 * programación. Esto solo comprueba si ya salió y actualiza nuestra fila. Si
 * todavía no consta enviado, se INTENTA el envío una única vez, porque el caso
 * real que cubre es «se guardó aquí pero la programación remota no llegó a
 * grabarse». Antes de intentarlo se vuelve a mirar el estado remoto: mandar a
 * ciegas un boletín que quizá ya salió lo duplica en la bandeja de todos.
 */
export async function reconciliarNewsletter(rec: NewsletterRec): Promise<void> {
  try {
    const acc = await cuentaDe(rec);
    const estado = await withPublicApiKey(acc.apiKey!, async () => {
      if (!rec.sio_id) return null;
      return getNewsletter(rec.sio_id);
    });

    if (estado?.isSent) {
      rec.status = "sent";
      rec.sent_at = Date.now();
      rec.result = "Enviado desde la web";
      await dbUpsertNewsletter(rec);
      await logActivity({
        source: "newsletter",
        level: "info",
        status: "sent",
        summary: `Boletín enviado: ${rec.subject}`,
        payload: { newsletter: rec.id, destinatarios: rec.recipients },
      });
      return;
    }

    // No consta enviado y su hora ya pasó → la programación remota no prendió.
    const r = await publicarEnWeb(rec, "enviar");
    rec.status = "sent";
    rec.sent_at = Date.now();
    rec.recipients = r.destinatarios;
    rec.result = r.aviso || "Enviado por el panel (la programación de la web no constaba)";
    await dbUpsertNewsletter(rec);
    await logActivity({
      source: "newsletter",
      level: "info",
      status: "sent",
      summary: `Boletín enviado: ${rec.subject}`,
      payload: { newsletter: rec.id, destinatarios: r.destinatarios, via: "panel" },
    });
  } catch (e) {
    rec.status = "error";
    rec.result = motivoLegible(e);
    await dbUpsertNewsletter(rec);
    await logActivity({
      source: "newsletter",
      level: "error",
      status: "error",
      summary: `No se pudo enviar el boletín «${rec.subject}»`,
      payload: { newsletter: rec.id, error: rec.result },
    });
  }
}

/** Relee una fila desde la base antes de tocarla (el panel pudo cambiarla entre
 *  el claim y esto). Devuelve null si ya no procede actuar sobre ella. */
export async function refrescaSiProcede(rec: NewsletterRec): Promise<NewsletterRec | null> {
  const fresco = await dbGetNewsletter(rec.id);
  if (!fresco) return null;
  if (fresco.status !== "sending") return null; // alguien lo canceló o ya se cerró
  return fresco;
}
