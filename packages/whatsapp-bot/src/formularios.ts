/**
 * FORMULARIOS-1 · Formularios propios del panel, sin depender de nadie.
 *
 * Cada formulario tiene una página pública en /f/<slug> (la sirve index.ts). Quien lo
 * rellena entra en el CRM por el MISMO camino que una respuesta de Typeform
 * (procesarLeadDeFormulario, compartido): ficha por teléfono o correo, nota con las
 * respuestas, etiquetas, aviso de lead nuevo y flujos con disparador «formulario».
 * Además, si el formulario tiene una web elegida (systeme.io o leadmatch-lab), el
 * contacto se copia allí por la cola de sincronización de siempre (contact-upsert), con
 * la etiqueta que enciende sus automatizaciones.
 *
 * Cada envío queda también en app_form_responses (los de Typeform igual, con form_id
 * 'tf:<id>'): de ahí salen las respuestas de la vista y la sección de la ficha.
 *
 * Antispam: campo trampa invisible, envío demasiado rápido para una persona, y tope de
 * envíos por dirección IP. Las visitas se cuentan una vez por persona cada 30 minutos.
 */
import crypto from "node:crypto";
import { avisarLeadNuevo } from "./notifications.js";
import { currentWorkspaceId } from "./workspace.js";
import { getContact, createContact, enrichContact, addContactNote, contactByEmail } from "./contacts.js";
import {
  dbFindContactByPhoneDigits, dbClaimOnce, dbReleaseClaim, dbFormBump, dbInsertFormResponse,
  dbGetFormResponse, dbCompletarFormResponse,
  type FormRec, type FormQuestion, type FormResponseRec, dbPutInboxMedia, dbGetFormRespMedia,
} from "./db.js";
import { triggerFormularioFlows } from "./flows.js";
import { queueMcpJob } from "./mcp-bridge.js";
import { getPipelines, setStageWithTag } from "./pipelines.js";
import { getWorkspaceSetting, setWorkspaceSetting } from "./settings.js";

export function slugCampo(s: string): string {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

/** Una respuesta ya aplanada: pregunta, referencia, tipo y valor en texto. */
export interface ParRespuesta { titulo: string; ref: string; tipo: string; v: string }

export type ResultadoLead = "nueva" | "actualizada" | "sin_contacto";

/** Correo, teléfono y nombre de unas respuestas (por tipo de pregunta y, si no, por su texto). */
export function datosDeContacto(pares: ParRespuesta[]): { email: string; telRaw: string; digitos: string; nombre: string } {
  const email = (pares.find((p) => p.tipo === "email" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.v) && /mail|correo/i.test(p.titulo))?.v || "").toLowerCase();
  const telRaw = pares.find((p) => p.tipo === "phone_number")?.v
    || pares.find((p) => /tel[eé]fono|m[oó]vil|celular|whatsapp|phone/i.test(p.titulo) && p.v.replace(/\D/g, "").length >= 6)?.v || "";
  const digitos = telRaw.replace(/\D/g, "");
  const nombre = (pares.find((p) => p.ref === "nombre" || (p.tipo === "short_text" && /^[¿\s]*((tu|su) )?(nombre|name)( y apellidos| completo)?[\s?:*]*$|c[oó]mo te llamas/i.test(p.titulo)))?.v || "").slice(0, 120);
  return { email, telRaw, digitos, nombre };
}

/**
 * El tramo COMÚN a cualquier formulario (propio o de Typeform): de unas respuestas a la
 * ficha del CRM. La idempotencia (claim) la pone quien llama, y lo libera si esto lanza.
 * Corre DENTRO del ámbito del workspace.
 */
export async function procesarLeadDeFormulario(a: {
  fuente: "web" | "typeform";
  formId: string;               // id propio o 'tf:<id>' (el que se guarda en la respuesta)
  tituloForm: string;
  pares: ParRespuesta[];
  etiquetas: string[];          // las del origen: ['formulario', 'form:<slug>', <extra>]
  campoPrefijo: "formulario" | "typeform";
  varsPrefijo: "f_" | "tf_";
  notaOrigen: string;           // «de Typeform», «de tu web»…
  fecha?: string;               // ISO del envío
  vivo: boolean;                // sólo lo que entra en vivo avisa y arranca flujos
  avisar?: boolean;             // campana (por defecto sí)
  responseId: string;
  completar?: boolean;          // FORM-CITA-2 · la respuesta existe sin contacto: completarla
  disparar: (clave: string, vars: Record<string, string>) => Promise<unknown>;
}): Promise<{ resultado: ResultadoLead; clave: string; nombre: string; email: string; telefono: string }> {
  const pares = a.pares;
  const { email, telRaw, digitos, nombre } = datosDeContacto(pares);
  if (!email && digitos.length < 6) return { resultado: "sin_contacto", clave: "", nombre, email, telefono: telRaw };

  // Clave del contacto: la ficha que ya exista (por teléfono o correo) > teléfono > correo.
  const existente = (digitos.length >= 6 ? await dbFindContactByPhoneDigits(digitos) : null) || (email ? await contactByEmail(email) : null);
  const clave = existente?.phone || (digitos.length >= 6 ? digitos : "email:" + email);
  const tags = a.etiquetas.filter(Boolean);
  const fields: Record<string, string> = {};
  // La ficha se encontró por correo y no tiene este teléfono: que no se pierda.
  if (existente && digitos.length >= 6 && !String(existente.phone || "").replace(/\D/g, "").endsWith(digitos.slice(-9))) fields.telefono = telRaw.slice(0, 40);
  for (const p of pares) {
    if (p.tipo === "email" || p.tipo === "phone_number" || p.ref === "nombre" || p.v === telRaw) continue;
    const k = slugCampo(p.titulo);
    if (k) fields[k] = p.v.slice(0, p.tipo === "archivo" ? 4000 : 200); // FORM-ARCHIVO-1 · un enlace recortado no abre
  }
  fields[a.campoPrefijo === "typeform" ? "typeform_formulario" : "formulario"] = a.tituloForm;
  fields[a.campoPrefijo === "typeform" ? "typeform_fecha" : "formulario_fecha"] = String(a.fecha || new Date().toISOString()).slice(0, 10);
  let nueva = false;
  if (!existente && !(await getContact(clave))) {
    await createContact({ phone: clave, name: nombre || email || telRaw, email: email || undefined, tags: [...tags, "lead"], source: a.fuente === "typeform" ? "typeform" : "formulario", fields });
    nueva = true;
  } else {
    await enrichContact(clave, { tags, fields, ...(email && !existente?.email ? { email } : {}), ...(nombre && !existente?.name ? { name: nombre } : {}) });
  }
  // La respuesta queda guardada tal cual (ficha del contacto y vista de respuestas).
  const answers = pares.map((p) => ({ label: p.titulo.slice(0, 200), v: p.v.slice(0, p.tipo === "archivo" ? 4000 : 2000) }));
  // FORM-CITA-2 · la respuesta ya estaba guardada sin contacto: se completa, no se duplica.
  if (a.completar) await dbCompletarFormResponse(a.responseId, { contact_id: clave, name: nombre, email, phone: telRaw, answers, sync: "" });
  else await dbInsertFormResponse({
    id: a.responseId, form_id: a.formId, form_title: a.tituloForm, source: a.fuente, contact_id: clave,
    name: nombre, email, phone: telRaw, answers,
    sync: "", created_at: a.fecha ? Date.parse(a.fecha) || Date.now() : Date.now(),
  });
  // FORM-ARCHIVO-1 · los enlaces a los archivos van enteros: recortados no abren.
  const resumen = pares.map((p) => "• " + p.titulo.slice(0, 120) + ": " + (p.tipo === "archivo" ? "\n" + p.v : p.v.slice(0, 300))).join("\n");
  const adjuntos = pares.filter((p) => p.tipo === "archivo").map((p) => p.v).join("\n");
  await addContactNote(clave, "Respondió el formulario «" + a.tituloForm + "» " + a.notaOrigen + (a.vivo ? "" : " (importado)") + ":\n" + resumen, { kind: "system", author: a.fuente === "typeform" ? "typeform" : "formulario" }).catch(() => { /* nota best-effort */ });
  if (a.vivo) {
    if (nueva && a.avisar !== false) avisarLeadNuevo(clave, { name: nombre || email, channel: a.fuente === "typeform" ? "typeform" : "formulario", origen: "Ha rellenado tu formulario «" + a.tituloForm + "»." + (adjuntos ? "\nArchivos adjuntos:\n" + adjuntos : "") });
    const vars: Record<string, string> = { formulario: a.tituloForm };
    for (const [k, v] of Object.entries(fields)) vars[a.varsPrefijo + k] = v;
    // Sin esperar: quien llama ya puede contestar (el ámbito del workspace viaja con la promesa).
    void a.disparar(clave, vars).catch(() => 0);
  }
  return { resultado: nueva ? "nueva" : "actualizada", clave, nombre, email, telefono: telRaw };
}

// ─────────────────────────────── formularios propios ───────────────────────────────

export const TIPOS_PREGUNTA: FormQuestion["type"][] = ["nombre", "email", "telefono", "texto", "parrafo", "opcion", "varias", "numero", "fecha", "si_no", "acepto", "desplegable", "escala", "valoracion", "web", "archivo"];
/** FORMULARIOS-4 · tipos que se responden eligiendo de una lista escrita por el negocio. */
const CON_OPCIONES = new Set<FormQuestion["type"]>(["opcion", "varias", "desplegable"]);

/**
 * Deja una definición recibida del panel en su forma segura. Devuelve el error legible si no vale.
 * FORMULARIOS-2 · `previa`: para la vista previa en vivo nada bloquea (lo que falta se rellena
 * con un texto de muestra) y el primer problema vuelve en `aviso`, para decirlo sin dejar de pintar.
 */
export function normalizarFormulario(b: Record<string, unknown>, previa = false, conCita = false):{ ok: true; title: string; intro: string; questions: FormQuestion[]; aviso?: string } | { ok: false; error: string } {
  let aviso = "";
  const falla = (error: string) => { if (!aviso) aviso = error; return previa ? null : { ok: false as const, error }; };
  let title = String(b.title || "").trim().slice(0, 200);
  if (!title) { const e = falla("Ponle un título al formulario."); if (e) return e; title = "Tu formulario"; }
  const intro = String(b.intro || "").trim().slice(0, 2000);
  const raw = Array.isArray(b.questions) ? b.questions as Record<string, unknown>[] : [];
  const questions: FormQuestion[] = [];
  const vistos = new Set<string>();
  const deDonde: [FormQuestion, Record<string, unknown>][] = []; // FORM-ARBOL-1
  for (const q of raw.slice(0, 40)) {
    const type = String(q?.type || "") as FormQuestion["type"];
    if (!TIPOS_PREGUNTA.includes(type)) continue;
    let label = String(q?.label || "").trim().slice(0, 300);
    if (!label) { const e = falla("Hay una pregunta sin texto. Escríbela o quítala."); if (e) return e; label = "Pregunta sin texto"; }
    let id = String(q?.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || crypto.randomUUID().slice(0, 8);
    while (vistos.has(id)) id = crypto.randomUUID().slice(0, 8);
    vistos.add(id);
    const out: FormQuestion = { id, type, label, required: !!q?.required };
    const ds = String(q?.description || "").trim().slice(0, 500);
    if (ds) out.description = ds;
    if (CON_OPCIONES.has(type)) {
      const ops = (Array.isArray(q?.options) ? q.options as unknown[] : []).map((o) => String(o || "").trim().slice(0, 120)).filter(Boolean);
      // El desplegable es para listas largas (provincias, servicios…); los botones, para pocas.
      let unicas = [...new Set(ops)].slice(0, type === "desplegable" ? 100 : 30);
      if (unicas.length < 2) { const e = falla("La pregunta «" + label.slice(0, 60) + "» necesita al menos dos opciones."); if (e) return e; unicas = unicas.length ? [unicas[0], "Otra opción"] : ["Opción 1", "Opción 2"]; }
      out.options = unicas;
    }
    const ph = String(q?.placeholder || "").trim().slice(0, 120);
    if (ph) out.placeholder = ph;
    if (type === "acepto") out.required = true;
    // FORMULARIOS-8 · en la misma pantalla que la anterior (la primera no tiene anterior).
    if (q?.conAnterior && questions.length) out.conAnterior = true;
    if (q?.media) {
      const md = medioValido(q.media);
      if (md) out.media = md;
      else { const e = falla("La imagen o el vídeo de «" + label.slice(0, 60) + "» tiene que ser una dirección completa que empiece por https://"); if (e) return e; }
    }
    questions.push(out);
    deDonde.push([out, q]);
  }
  if (!questions.length) { const e = falla("Añade al menos una pregunta."); if (e) return e; }
  // FORM-CITA-2 · con calendario de reservas, los datos de contacto los pide el calendario
  // (vuelven a /reservada): no hace falta preguntarlos dos veces.
  if (!conCita && !questions.some((q) => q.type === "email" || q.type === "telefono")) {
    const e = falla("Añade una pregunta de correo o de teléfono: es lo que convierte cada respuesta en un contacto."); if (e) return e;
  }
  // FORM-ARBOL-1 · los saltos sólo van hacia delante (así no hay bucles) y a preguntas que
  // existen; una regla que ya no vale (pregunta borrada o movida) se descarta sin más.
  const pos = new Map(questions.map((q, k) => [q.id, k]));
  deDonde.forEach(([q, r]) => {
    const k = pos.get(q.id) as number;
    const destino = (v: unknown) => { const d = String(v || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40); return d === "fin" || (pos.get(d) ?? -1) > k ? d : ""; };
    if (CON_SALTO.has(q.type) && r?.salto && typeof r.salto === "object") {
      const validas = q.type === "si_no" ? ["Sí", "No"] : q.options || [];
      const salto: Record<string, string> = {};
      for (const [resp, d] of Object.entries(r.salto as Record<string, unknown>)) if (validas.includes(resp) && destino(d)) salto[resp] = destino(d);
      if (Object.keys(salto).length) q.salto = salto;
    }
    const luego = destino(r?.luego);
    if (luego) q.luego = luego;
  });
  return { ok: true, title, intro, questions, ...(aviso ? { aviso } : {}) };
}

/** FORM-ARBOL-1 · tipos cuya respuesta puede decidir el camino: una sola elección. */
export const CON_SALTO = new Set<FormQuestion["type"]>(["opcion", "si_no", "desplegable"]);

/** FORMULARIOS-8 · pantalla de cada pregunta: en «una por pantalla», las «junto a la anterior» comparten. */
export function pasosFormulario(qs: FormQuestion[], uno: boolean): number[] {
  const p: number[] = [];
  qs.forEach((q, k) => p.push(k === 0 ? 0 : p[k - 1] + (uno && q.conAnterior ? 0 : 1)));
  return p;
}

/**
 * FORM-ARBOL-1 · el árbol por pantallas: r = reglas «si la pregunta q vale v, ir a la pantalla a»
 * (en orden: gana la primera que se cumple), l = adónde ir si ninguna se cumple. -1 = terminar.
 * Lo usan igual la página (para navegar) y el servidor (para saber qué preguntas se vieron).
 */
export type PantallaArbol = { r: { q: string; v: string; a: number }[]; l?: number };
export function arbolFormulario(qs: FormQuestion[], paso: number[]): PantallaArbol[] {
  const n = paso.length ? paso[paso.length - 1] + 1 : 0;
  const arbol: PantallaArbol[] = Array.from({ length: n }, () => ({ r: [] }));
  const dest = (d: string, mia: number) => {
    if (d === "fin") return -1;
    const k = qs.findIndex((x) => x.id === d);
    return k >= 0 && paso[k] > mia ? paso[k] : null;
  };
  qs.forEach((q, k) => {
    const s = arbol[paso[k]];
    for (const [v, d] of Object.entries(q.salto || {})) { const a = dest(d, paso[k]); if (a !== null) s.r.push({ q: q.id, v, a }); }
    // En una pantalla con varias, manda el «después» de la última que lo tenga.
    if (q.luego) { const a = dest(q.luego, paso[k]); if (a !== null) s.l = a; }
  });
  return arbol;
}

/** FORM-ARBOL-1 · pantallas recorridas con estas respuestas, desde la primera hasta terminar. */
export function recorridoFormulario(arbol: PantallaArbol[], valor: (id: string) => string): Set<number> {
  const vistas = new Set<number>();
  let i = 0;
  while (i >= 0 && i < arbol.length && !vistas.has(i)) {
    vistas.add(i);
    const p = arbol[i];
    const r = p.r.find((x) => valor(x.q) === x.v);
    i = r ? r.a : p.l !== undefined ? p.l : i + 1;
  }
  return vistas;
}

/** De un título a una dirección corta y limpia (la unicidad la comprueba quien llama). */
export function slugDireccion(s: string): string {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "formulario";
}

// Topes en memoria del proceso (por réplica). Suficiente contra el relleno automático
// y los recargas: no es una frontera de seguridad, el dato real se valida igual.
const visitas = new Map<string, number>();
const envios = new Map<string, number[]>();
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of visitas) if (t - v > 30 * 60_000) visitas.delete(k);
  for (const [k, v] of envios) { const r = v.filter((x) => t - x < 10 * 60_000); if (r.length) envios.set(k, r); else envios.delete(k); }
}, 5 * 60_000).unref?.();

/** Cuenta la visita (una por persona y formulario cada 30 minutos). Dentro del ámbito del workspace. */
export async function contarVisita(form: FormRec, ip: string): Promise<void> {
  const k = form.id + "|" + ip;
  const prev = visitas.get(k);
  if (prev && Date.now() - prev < 30 * 60_000) return;
  visitas.set(k, Date.now());
  await dbFormBump(form.id, "views").catch(() => { /* la métrica no tumba la página */ });
}

const MAX_ENVIOS_IP = 8; // por IP cada 10 minutos, sumando todos los formularios

function valorPregunta(q: FormQuestion, v: unknown): { v: string; error?: string } {
  if (q.type === "varias") {
    const arr = (Array.isArray(v) ? v : []).map((x) => String(x || "")).filter((x) => q.options?.includes(x));
    return { v: arr.join(", ") };
  }
  const s = String(v ?? "").trim();
  if (!s) return { v: "" };
  switch (q.type) {
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(s) && s.length <= 200 ? { v: s.toLowerCase() } : { v: "", error: "Revisa el correo: parece que le falta algo." };
    case "telefono": {
      const d = s.replace(/\D/g, "");
      return d.length >= 6 && d.length <= 16 ? { v: s.slice(0, 40) } : { v: "", error: "Revisa el teléfono: tiene que tener al menos 6 números." };
    }
    case "numero":
      return /^-?\d+([.,]\d+)?$/.test(s) ? { v: s.slice(0, 40) } : { v: "", error: "Aquí va un número." };
    case "fecha":
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { v: s } : { v: "", error: "Elige una fecha." };
    case "opcion":
    case "desplegable":
      return q.options?.includes(s) ? { v: s } : { v: "", error: "Elige una de las opciones." };
    case "escala":
      return /^(10|\d)$/.test(s) ? { v: s } : { v: "", error: "Elige un número del 0 al 10." };
    case "valoracion":
      return /^[1-5]$/.test(s) ? { v: s } : { v: "", error: "Elige de 1 a 5 estrellas." };
    case "web":
      return /^(https?:\/\/)?[^\s/.]+(\.[^\s/.]+)*\.[a-z]{2,}(\/\S*)?$/i.test(s) && s.length <= 300 ? { v: s } : { v: "", error: "Revisa la dirección: algo como tuweb.com." };
    case "si_no":
      return s === "Sí" || s === "No" ? { v: s } : { v: "", error: "Elige sí o no." };
    case "acepto":
      return s === "1" || s === "true" || s === "Sí" ? { v: "Sí" } : { v: "" };
    case "parrafo":
      return { v: s.slice(0, 4000) };
    default:
      return { v: s.slice(0, 500) };
  }
}

// FORM-ARCHIVO-1 · quien responde adjunta fotos (JPG, PNG, HEIC) o PDF. Cada archivo se sube
// ANTES de enviar (POST /f/<slug>/archivo) y la respuesta lleva sus ids; al enviar se cruzan con
// el formulario y se guarda «nombre — enlace» como texto, así Respuestas, la ficha, la exportación
// y el aviso por correo los enseñan sin más. Se sirven en /f/a/<id> (id imposible de adivinar).
export const MAX_ARCHIVO_MB = 20;
export const MAX_ARCHIVOS_PREGUNTA = 10;
const MAX_SUBIDAS_IP = 40; // por IP cada 10 minutos
const subidas = new Map<string, number[]>();
/** El tipo lo dicen los primeros bytes, no el nombre ni lo que declare el navegador. */
function tipoArchivo(b: Buffer): { mime: string; ext: string } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (b.length > 12 && b.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(b.subarray(8, 12).toString("latin1"))) return { mime: "image/heic", ext: "heic" };
  return null;
}
export function nombreArchivo(n: unknown): string {
  return String(n || "").replace(/[\u0000-\u001f"<>\\/]/g, "").trim().slice(0, 120) || "archivo";
}
/** Un archivo de quien responde. Corre DENTRO del ámbito del workspace del formulario. */
export async function subirArchivoFormulario(form: FormRec, body: Record<string, unknown>, ip: string): Promise<{ ok: true; id: string; nombre: string } | { ok: false; status: number; error: string }> {
  if (form.status !== "active") return { ok: false, status: 410, error: "Este formulario ya no admite respuestas." };
  if (!form.questions.some((q) => q.type === "archivo")) return { ok: false, status: 400, error: "Este formulario no admite archivos." };
  const t = Date.now();
  const hist = (subidas.get(ip) || []).filter((x) => t - x < 10 * 60_000);
  if (hist.length >= MAX_SUBIDAS_IP) return { ok: false, status: 429, error: "Has subido muchos archivos seguidos. Espera unos minutos y vuelve a intentarlo." };
  let buf: Buffer;
  try { buf = Buffer.from(String(body.dataB64 || ""), "base64"); } catch { buf = Buffer.alloc(0); }
  if (!buf.length) return { ok: false, status: 400, error: "El archivo ha llegado vacío. Vuelve a elegirlo." };
  if (buf.length > MAX_ARCHIVO_MB * 1024 * 1024) return { ok: false, status: 413, error: "Cada archivo puede pesar " + MAX_ARCHIVO_MB + " MB como máximo." };
  const tipo = tipoArchivo(buf);
  if (!tipo) return { ok: false, status: 400, error: "Sube una foto (JPG, PNG o HEIC) o un PDF." };
  hist.push(t);
  subidas.set(ip, hist);
  const id = crypto.randomUUID();
  await dbPutInboxMedia({ id, user_id: form.id, source: "form-resp", kind: tipo.mime === "application/pdf" ? "document" : "image", content_type: tipo.mime, data: buf });
  let nombre = nombreArchivo(body.name);
  if (!/\.[a-z0-9]{2,5}$/i.test(nombre)) nombre += "." + tipo.ext;
  return { ok: true, id, nombre };
}
/** Los archivos de una pregunta al enviar: sólo los subidos a ESTE formulario. */
async function archivosDe(form: FormRec, v: unknown, origen: string): Promise<{ v: string; error?: string }> {
  const arr = Array.isArray(v) ? v : [];
  if (arr.length > MAX_ARCHIVOS_PREGUNTA) return { v: "", error: "Puedes adjuntar " + MAX_ARCHIVOS_PREGUNTA + " archivos como máximo." };
  const lineas: string[] = [];
  for (const x of arr) {
    const id = String((x as any)?.id || "");
    const m = /^[0-9a-f-]{36}$/.test(id) ? await dbGetFormRespMedia(id).catch(() => null) : null;
    if (!m || m.form_id !== form.id) return { v: "", error: "Uno de los archivos no se ha subido bien. Quítalo y vuelve a adjuntarlo." };
    lineas.push(nombreArchivo((x as any)?.n) + " — " + origen + "/f/a/" + id);
  }
  return { v: lineas.join("\n") };
}

export type ResultadoEnvio =
  | { ok: true; thanks: string; redirect: string; cita?: string }
  | { ok: false; status: number; error: string; campo?: string };

/**
 * Un envío de la página pública. Corre DENTRO del ámbito del workspace del formulario.
 * `body` = { a: { <idPregunta>: valor }, sid, hp, ms }.
 */
export async function enviarFormulario(form: FormRec, body: Record<string, unknown>, ip: string, origen = ""): Promise<ResultadoEnvio> {
  const thanks = String(form.opts.thanks || "").trim() || "¡Gracias! Hemos recibido tus respuestas.";
  const redirect = /^https:\/\/[^\s"'<>]+$/i.test(String(form.opts.redirect || "")) ? String(form.opts.redirect) : "";
  // FORM-CITA-1 · con calendario, el «gracias» (o la página de después) llega tras reservar.
  const cita = citaDe(form);
  if (form.status !== "active") return { ok: false, status: 410, error: "Este formulario ya no admite respuestas." };
  // Trampas para robots: el campo invisible relleno, o un envío más rápido que una persona.
  // Se contesta «ok» para no enseñarles qué los delató; no se guarda nada.
  if (String(body.hp || "").trim()) return { ok: true, thanks, redirect, cita };
  const ms = Number(body.ms);
  if (Number.isFinite(ms) && ms >= 0 && ms < 1200) return { ok: true, thanks, redirect, cita };
  const t = Date.now();
  const hist = (envios.get(ip) || []).filter((x) => t - x < 10 * 60_000);
  if (hist.length >= MAX_ENVIOS_IP) return { ok: false, status: 429, error: "Has enviado varias veces seguidas. Espera unos minutos y vuelve a intentarlo." };

  const resp = (body.a && typeof body.a === "object" ? body.a : {}) as Record<string, unknown>;
  const pares: ParRespuesta[] = [];
  // FORM-ARBOL-1 · sólo cuentan las preguntas del camino que siguió la persona: las de otras
  // ramas ni se exigen ni se guardan (pudo contestarlas y luego cambiar de respuesta).
  const pasosT = pasosFormulario(form.questions, true);
  const paso = pasosFormulario(form.questions, unaPorPantalla(form.opts) && pasosT[pasosT.length - 1] > 0);
  const vistas = recorridoFormulario(arbolFormulario(form.questions, paso), (id) => {
    const q = form.questions.find((x) => x.id === id);
    return q ? valorPregunta(q, resp[id]).v : "";
  });
  for (const [k, q] of form.questions.entries()) {
    if (!vistas.has(paso[k])) continue;
    const r = q.type === "archivo" ? await archivosDe(form, resp[q.id], origen) : valorPregunta(q, resp[q.id]);
    if (r.error) return { ok: false, status: 400, error: r.error, campo: q.id };
    if (!r.v) {
      if (q.required) return { ok: false, status: 400, error: q.type === "acepto" ? "Tienes que aceptar para continuar." : "Esta pregunta es obligatoria.", campo: q.id };
      continue;
    }
    pares.push({
      titulo: q.label,
      ref: q.type === "nombre" ? "nombre" : q.id,
      tipo: q.type === "email" ? "email" : q.type === "telefono" ? "phone_number" : q.type === "nombre" ? "short_text" : q.type,
      v: r.v,
    });
  }
  // FORM-CITA-2 · con calendario, el contacto puede llegar después, al volver de reservar.
  const sinContacto = !pares.some((p) => p.tipo === "email" || p.tipo === "phone_number");
  // FORM-ARBOL-1 · si su camino no pasaba por el correo ni el teléfono (p. ej. «no me interesa»
  // → terminar), la respuesta se guarda igual, sin ficha.
  const qContacto = form.questions.find((x, k) => (x.type === "email" || x.type === "telefono") && vistas.has(paso[k]));
  if (sinContacto && !cita && qContacto) {
    const q = qContacto;
    return { ok: false, status: 400, error: "Déjanos tu correo o tu teléfono para poder contestarte.", campo: q?.id };
  }
  // Doble clic o reintento del navegador: el mismo `sid` (uno por carga de página) no entra dos veces.
  const sid = String(body.sid || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 60) || crypto.randomUUID();
  const claimKey = form.id + ":" + sid;
  // Reservar antes del primer await: los envíos simultáneos deben ver el mismo cupo.
  hist.push(t);
  envios.set(ip, hist);
  const soltarCupo = () => {
    const actual = envios.get(ip);
    const pos = actual?.indexOf(t) ?? -1;
    if (actual && pos >= 0) actual.splice(pos, 1);
  };
  try {
    if (!(await dbClaimOnce("formulario", claimKey))) {
      soltarCupo();
      return { ok: true, thanks, redirect, cita };
    }
  } catch (err) { soltarCupo(); throw err; }

  const responseId = crypto.randomUUID();
  // FORM-CITA-2 · sin correo ni teléfono (los pide el calendario): las respuestas se guardan
  // YA, sin ficha, y el calendario se abre con ?bs=<esta respuesta>. Al volver de reservar,
  // /reservada trae nombre, correo y teléfono y completarReserva() hace el resto (ficha,
  // etiquetas, pipeline, copia a la web, aviso y flujos), una sola vez.
  if (sinContacto) {
    try {
      await dbInsertFormResponse({
        id: responseId, form_id: form.id, form_title: form.title, source: "web", contact_id: "",
        name: "", email: "", phone: "",
        answers: pares.map((p) => ({ label: p.titulo.slice(0, 200), v: p.v.slice(0, p.tipo === "archivo" ? 4000 : 2000) })),
        sync: cita ? SYNC_PENDIENTE : "", created_at: Date.now(),
      });
    } catch (err) {
      await dbReleaseClaim("formulario", claimKey).catch(() => { /* peor caso: el reintento se da por hecho */ });
      console.error("[formularios] no se pudo guardar el envío:", (err as Error).message);
      return { ok: false, status: 500, error: "No hemos podido guardar tus respuestas. Inténtalo de nuevo en un momento." };
    }
    await dbFormBump(form.id, "submissions").catch(() => { /* la métrica no tumba el envío */ });
    return { ok: true, thanks, redirect, cita: citaConDatos(cita, "", "", "", responseId) };
  }
  let r: Awaited<ReturnType<typeof procesarLeadDeFormulario>>;
  try {
    r = await procesarLeadDeFormulario({
      fuente: "web", formId: form.id, tituloForm: form.title, pares,
      etiquetas: ["formulario", ("form:" + slugCampo(form.title)).slice(0, 40), ...etiquetasDe(form.opts)],
      campoPrefijo: "formulario", varsPrefijo: "f_", notaOrigen: "de tu web", vivo: true,
      avisar: form.opts.notify !== false, responseId,
      // El pipeline va ANTES de los flujos: un flujo puede preguntar en qué etapa está.
      disparar: async (clave, vars) => { await meterEnPipeline(form, clave); return triggerFormularioFlows(clave, { formId: form.id, formTitle: form.title, vars }); },
    });
  } catch (err) {
    await dbReleaseClaim("formulario", claimKey).catch(() => { /* peor caso: el reintento se da por hecho */ });
    console.error("[formularios] no se pudo guardar el envío:", (err as Error).message);
    return { ok: false, status: 500, error: "No hemos podido guardar tus respuestas. Inténtalo de nuevo en un momento." };
  }
  await dbFormBump(form.id, "submissions").catch(() => { /* la métrica no tumba el envío */ });
  await meterEnPipeline(form, r.clave); // no-op si `disparar` ya lo hizo; así queda puesto al contestar
  await copiarAWeb(form, responseId, r.clave, r.email, r.nombre);
  return { ok: true, thanks, redirect, cita: citaConDatos(cita, r.email, r.nombre, r.telefono, responseId) };
}

/** FORM-CITA-2 · marca de la respuesta guardada a la espera de los datos del calendario. */
const SYNC_PENDIENTE = "reserva:pendiente";
/** FORM-CITA-2 · cuánto vale la marca ?bs= de una respuesta para unirle los datos de la reserva. */
const BS_VALIDEZ_MS = 48 * 3600_000;

/**
 * FORM-CITA-2 · Vuelta del calendario a /f/<slug>/reservada con los datos de quien reservó.
 * El script de la página del calendario (systeme.io) los lee del paso 2 y redirige a
 * `…/reservada?bs=<respuesta>&nombre=…&apellido=…&email=…&telefono=…`.
 *
 * La ruta es PÚBLICA: sin una `bs` de verdad (una respuesta de ESTE formulario, de las
 * últimas 48 h) no se crea ni se toca ninguna ficha — si no, cualquiera podría inventarse
 * contactos y disparar avisos y flujos con una URL. Y cada respuesta se une una sola vez.
 *  - Respuesta guardada sin contacto → ficha nueva o la que ya exista (por teléfono o
 *    correo), con las etiquetas, el pipeline, la copia a la web, el aviso de lead nuevo
 *    y los flujos del formulario: lo mismo que si hubiera dejado sus datos en el formulario.
 *  - Respuesta que ya tenía contacto → a esa ficha se le añade lo que le faltaba
 *    (correo, teléfono, nombre).
 * La confirmación por WhatsApp NO sale de aquí: la manda la copia de reservas
 * (sio-bookings.ts), que es la que sabe el día y la hora, y la encuentra por el correo.
 * Corre DENTRO del ámbito del workspace. Nunca lanza.
 */
export async function completarReserva(form: FormRec, q: Record<string, unknown>): Promise<"unida" | "completada" | "ignorada"> {
  try {
    const bs = String(q.bs || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 60);
    const email = String(q.email || "").trim().toLowerCase().slice(0, 200);
    const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
    const telRaw = String(q.telefono || q.phone || "").trim().slice(0, 40);
    const digitos = telRaw.replace(/\D/g, "");
    const telOk = digitos.length >= 6 && digitos.length <= 15 ? telRaw : "";
    const nombre = [q.nombre, q.apellido].map((x) => String(x || "").trim()).filter(Boolean).join(" ").slice(0, 120);
    if (!bs || (!emailOk && !telOk)) return "ignorada";
    const resp = await dbGetFormResponse(bs);
    if (!resp || resp.form_id !== form.id || Date.now() - resp.created_at > BS_VALIDEZ_MS) return "ignorada";
    if (!(await dbClaimOnce("form-reserva", form.id + ":" + bs))) return "ignorada";

    if (resp.contact_id) {
      // Ya dejó sus datos en el formulario: solo lo que le faltaba a la ficha.
      try {
        const c = await getContact(resp.contact_id);
        if (!c) throw new Error("la ficha de la respuesta ya no existe");
        const fields: Record<string, string> = {};
        const telFicha = String(c.phone || "").replace(/\D/g, "");
        if (telOk && !telFicha.endsWith(digitos.slice(-9)) && !String(c.fields?.telefono || "").trim()) fields.telefono = telOk;
        await enrichContact(c.phone, {
          fields,
          ...(emailOk && !String(c.email || "").trim() ? { email: emailOk } : {}),
          // Sin nombre, la ficha lleva de nombre el correo o el número: eso no es un nombre.
          ...(nombre && (!String(c.name || "").trim() || /@|^[+\d\s()-]+$/.test(String(c.name))) ? { name: nombre } : {}),
        });
      } catch (err) {
        // Sin efecto, el uso único no se gasta: volver a /reservada lo reintenta.
        await dbReleaseClaim("form-reserva", form.id + ":" + bs).catch(() => { /* el siguiente intento lo reintenta */ });
        throw err;
      }
      return "completada";
    }

    // Respuesta sin contacto: las respuestas guardadas + los datos del calendario.
    const tipoDe = (t: FormQuestion["type"]) => t === "email" ? "email" : t === "telefono" ? "phone_number" : t === "nombre" ? "short_text" : t;
    const pares: ParRespuesta[] = [];
    if (nombre) pares.push({ titulo: "Nombre", ref: "nombre", tipo: "short_text", v: nombre });
    if (emailOk) pares.push({ titulo: "Correo", ref: "email", tipo: "email", v: emailOk });
    if (telOk) pares.push({ titulo: "Teléfono", ref: "telefono", tipo: "phone_number", v: telOk });
    for (const a of resp.answers) {
      const pq = form.questions.find((x) => x.label.slice(0, 200) === a.label);
      pares.push({ titulo: a.label, ref: pq ? (pq.type === "nombre" ? "nombre" : pq.id) : slugCampo(a.label), tipo: pq ? tipoDe(pq.type) : "texto", v: a.v });
    }
    let r: Awaited<ReturnType<typeof procesarLeadDeFormulario>>;
    try {
      r = await procesarLeadDeFormulario({
        fuente: "web", formId: form.id, tituloForm: form.title, pares,
        etiquetas: ["formulario", ("form:" + slugCampo(form.title)).slice(0, 40), ...etiquetasDe(form.opts)],
        campoPrefijo: "formulario", varsPrefijo: "f_", notaOrigen: "de tu web (sus datos, del calendario al reservar)", vivo: true,
        avisar: form.opts.notify !== false, responseId: resp.id, completar: true,
        disparar: async (clave, vars) => { await meterEnPipeline(form, clave); return triggerFormularioFlows(clave, { formId: form.id, formTitle: form.title, vars }); },
      });
    } catch (err) {
      await dbReleaseClaim("form-reserva", form.id + ":" + bs).catch(() => { /* el siguiente intento lo reintenta */ });
      throw err;
    }
    if (!r.clave) return "ignorada";
    // La ficha ya está creada y unida: un fallo aquí no debe llevarse por delante lo otro.
    await meterEnPipeline(form, r.clave).catch((e) => console.error("[formularios] reserva: pipeline:", (e as Error).message));
    await copiarAWeb(form, resp.id, r.clave, r.email, r.nombre).catch((e) => console.error("[formularios] reserva: copia a la web:", (e as Error).message));
    return "unida";
  } catch (err) {
    console.error("[formularios] no se pudo unir la reserva a la respuesta:", (err as Error).message);
    return "ignorada";
  }
}

/** FORM-CITA-1 · la página del calendario de reservas del formulario (https), o "". */
export function citaDe(form: Pick<FormRec, "opts">): string {
  const u = String(form.opts.citaUrl || "").trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : "";
}

/** FORM-CITA-1 · el origen del calendario, para dejarlo entrar en la página (frame-src). */
export function origenCita(form: Pick<FormRec, "opts">): string {
  try { return citaDe(form) ? new URL(citaDe(form)).origin : ""; } catch { return ""; }
}

/**
 * FORM-CITA-1 · el calendario con lo que ya contestó: si la web rellena sola el
 * correo, el nombre o el teléfono, no se lo vuelve a pedir. Y es el CORREO con el
 * que reserve lo que une la reserva a esta ficha al copiarla (sio-bookings.ts).
 */
function citaConDatos(base: string, email: string, nombre: string, tel: string, bs = ""): string {
  if (!base) return "";
  try {
    const u = new URL(base);
    // FORM-CITA-2 · la marca de ESTA respuesta: el script del calendario la devuelve a /reservada.
    if (bs) u.searchParams.set("bs", bs);
    if (email) u.searchParams.set("email", email);
    if (nombre) { u.searchParams.set("first_name", nombre); u.searchParams.set("name", nombre); }
    if (tel) u.searchParams.set("phone_number", tel);
    return u.toString();
  } catch { return base; }
}

/** FORMULARIOS-2 · Las etiquetas del CRM de un formulario (la lista nueva y la única de antes). */
export function etiquetasDe(o: { tags?: unknown; tag?: unknown }): string[] {
  const l = (Array.isArray(o.tags) ? o.tags : []).map((t) => String(t || "").trim().slice(0, 40));
  const vieja = String(o.tag || "").trim().slice(0, 40);
  return [...new Set([...l, vieja].filter(Boolean))].slice(0, 10);
}

/**
 * FORMULARIOS-2 · Quien responde entra en el pipeline y la etapa del formulario, con la
 * misma lógica que al moverlo en el panel (etapa + pipeline + etiqueta «📍»). Sólo si aún
 * no estaba en ninguna etapa: volver a rellenar un formulario no le hace retroceder.
 */
async function meterEnPipeline(form: FormRec, clave: string): Promise<void> {
  const pid = String(form.opts.pipeline || "").trim(), etapa = String(form.opts.stage || "").trim();
  if (!pid || !etapa || !clave) return;
  const p = getPipelines().find((x) => x.id === pid);
  if (!p || !p.stages.includes(etapa)) return; // pipeline o etapa borrados después de guardar
  try {
    const c = await getContact(clave);
    if (c && String(c.stage || "").trim()) return;
    await setStageWithTag(clave, etapa, pid, { origin: "formulario", reason: "Respondió al formulario «" + (form.title || form.slug) + "», que mete en el pipeline" });
  } catch (err) {
    console.error("[formularios] no se pudo meter en el pipeline:", (err as Error).message);
  }
}

/** Copia el contacto a la web elegida en el formulario (systeme.io / leadmatch-lab). */
async function copiarAWeb(form: FormRec, responseId: string, clave: string, email: string, nombre: string): Promise<void> {
  const cuenta = String(form.opts.sioAccount || "").trim();
  if (!cuenta || !clave) return;
  const { dbSetFormResponseSync } = await import("./db.js");
  // Esas webs localizan a la gente por su correo: sin correo no hay copia, y se dice.
  if (!email) { await dbSetFormResponseSync(responseId, "sin_correo").catch(() => {}); return; }
  try {
    const c = await getContact(clave);
    const tag = String(form.opts.sioTag || "").trim().slice(0, 60);
    const jobId = await queueMcpJob({
      kind: "contact-upsert",
      tenant_id: currentWorkspaceId(),
      payload: {
        phone: clave, email, account_id: cuenta,
        ...(tag ? { sync_tag: tag } : {}),
        contact: { email, name: c?.name || nombre || "", tags: tag ? [tag] : [] },
      },
    });
    await dbSetFormResponseSync(responseId, "cola:" + jobId).catch(() => {});
  } catch (err) {
    await dbSetFormResponseSync(responseId, "error:" + String((err as Error).message || "no se pudo encolar").slice(0, 200)).catch(() => {});
  }
}

// ─────────────────────────────── página pública ───────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function colorValido(c: unknown): string {
  return /^#[0-9a-f]{6}$/i.test(String(c || "")) ? String(c) : "#2563eb";
}

// ───────────────────── FORMULARIOS-DISENO-1 · diseños, HTML y CSS propios ─────────────────────
// Diseños listos para elegir con un clic (como los temas de Typeform). El color del
// formulario, si se elige, manda sobre el acento del diseño. «claro» es el de siempre y
// sigue el modo oscuro del dispositivo; los demás tienen su propio fondo fijo.
export interface TemaFormulario {
  id: string; nombre: string;
  bg: string;            // fondo de la página (color o degradado CSS)
  card: string; tx: string; mu: string; ln: string; inp: string;
  b: string;             // acento por defecto (botones, progreso, selección)
  bt: string;            // texto sobre el acento
  neg: string;           // color del nombre del negocio, sobre el fondo
  fuente: string;        // familia de Google Fonts ('' = la del sistema)
  titulos?: string;      // familia sólo para los títulos
  radio: number;         // redondeo de campos y botones (px)
  sinTarjeta?: boolean;  // el formulario va directo sobre el fondo, sin caja
}
export const TEMAS_FORMULARIO: TemaFormulario[] = [
  { id: "claro", nombre: "Claro", bg: "#f5f6f8", card: "#fff", tx: "#14161a", mu: "#5c6370", ln: "#dfe2e7", inp: "#fff", b: "#2563eb", bt: "#fff", neg: "#5c6370", fuente: "", radio: 12 },
  { id: "crema", nombre: "Crema", bg: "#f4eee3", card: "#fffdf8", tx: "#2b2118", mu: "#76675a", ln: "#e5dac8", inp: "#fffdf8", b: "#c2410c", bt: "#fff", neg: "#76675a", fuente: "DM Sans", titulos: "Fraunces", radio: 14 },
  { id: "noche", nombre: "Noche", bg: "#0b1020", card: "#131a2e", tx: "#e8ecf6", mu: "#98a3be", ln: "#26324f", inp: "#0f1628", b: "#8aa4ff", bt: "#0b1020", neg: "#98a3be", fuente: "Inter", radio: 12 },
  { id: "bosque", nombre: "Bosque", bg: "#0f2a22", card: "#143629", tx: "#eaf4ee", mu: "#a3c5b5", ln: "#285a47", inp: "#10302a", b: "#6ee7b7", bt: "#0f2a22", neg: "#a3c5b5", fuente: "DM Sans", radio: 12 },
  { id: "atardecer", nombre: "Atardecer", bg: "linear-gradient(135deg,#ff9a8b 0%,#ff6a88 55%,#ff99ac 100%)", card: "#fff", tx: "#2a1520", mu: "#7a5a66", ln: "#f1d6de", inp: "#fff", b: "#d63d6e", bt: "#fff", neg: "#fff", fuente: "Poppins", radio: 16 },
  { id: "oceano", nombre: "Océano", bg: "linear-gradient(160deg,#0f4c81 0%,#1f7a8c 55%,#2a9d8f 100%)", card: "#fff", tx: "#10263a", mu: "#526579", ln: "#d5e2ec", inp: "#fff", b: "#0f4c81", bt: "#fff", neg: "#e6f2f7", fuente: "Nunito", radio: 14 },
  { id: "pastel", nombre: "Pastel", bg: "linear-gradient(160deg,#f3efff 0%,#fdf2f8 100%)", card: "#fff", tx: "#231a3a", mu: "#6b6385", ln: "#e6e0f5", inp: "#fbfaff", b: "#7c3aed", bt: "#fff", neg: "#6b6385", fuente: "Quicksand", radio: 22 },
  { id: "minimal", nombre: "Minimal", bg: "#fff", card: "#fff", tx: "#111", mu: "#666", ln: "#d9d9d9", inp: "#fff", b: "#111", bt: "#fff", neg: "#666", fuente: "Space Grotesk", radio: 4, sinTarjeta: true },
  { id: "editorial", nombre: "Editorial", bg: "#f3efe6", card: "#f3efe6", tx: "#1d2a24", mu: "#5f6b64", ln: "#cfc7b6", inp: "#fbf8f1", b: "#1f3a2e", bt: "#f3efe6", neg: "#5f6b64", fuente: "Inter", titulos: "Playfair Display", radio: 0, sinTarjeta: true },
];
export function temaFormulario(id: unknown): TemaFormulario {
  return TEMAS_FORMULARIO.find((t) => t.id === id) || TEMAS_FORMULARIO[0];
}

// Sitios que se pueden incrustar en el HTML propio (vídeo, mapa, agenda). La CSP de la
// página repite esta lista: aunque algo se colara aquí, el navegador no lo cargaría.
const MARCOS_OK = ["https://www.youtube.com/", "https://www.youtube-nocookie.com/", "https://player.vimeo.com/", "https://www.google.com/maps/", "https://calendly.com/", "https://www.loom.com/"];
const ETIQUETAS_OK = new Set(["p", "div", "span", "section", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "b", "strong", "i", "em", "u", "s", "small", "mark", "br", "hr", "a", "img", "ul", "ol", "li", "blockquote", "figure", "figcaption", "picture", "source", "iframe", "video", "center", "table", "thead", "tbody", "tr", "td", "th", "sup", "sub", "code", "pre"]);
const ETIQUETAS_VACIAS = new Set(["br", "hr", "img", "source"]);
// Lo de dentro de éstas se tira entero, no sólo la etiqueta.
const ETIQUETAS_FUERA = new Set(["script", "style", "noscript", "template", "object", "embed", "applet", "frame", "frameset", "svg", "math", "textarea", "select", "title", "head", "xmp", "plaintext", "noembed", "noframes"]);
const ATRIBUTOS_OK = new Set(["class", "id", "style", "href", "src", "srcset", "alt", "title", "target", "rel", "width", "height", "align", "allow", "allowfullscreen", "frameborder", "loading", "controls", "autoplay", "muted", "loop", "playsinline", "poster", "colspan", "rowspan", "type", "media", "sizes"]);

function urlSegura(v: string, marco: boolean): boolean {
  const u = v.replace(/&amp;/g, "&").trim();
  if (/[\u0000-\u001f\s]/.test(u)) return false;
  if (marco) return MARCOS_OK.some((p) => u.startsWith(p));
  return /^(https:\/\/|http:\/\/|mailto:|tel:|#|\/(?!\/))/i.test(u);
}

/** HTML propio del formulario: deja pasar maquetación, imágenes, enlaces y vídeos de
 *  sitios conocidos; quita scripts, eventos y enlaces «javascript:». Cierra lo que quede
 *  abierto para que no se trague el formulario. La CSP de la página es la segunda red. */
export function limpiarHtmlFormulario(html: unknown, max = 20000): string {
  const s = String(html ?? "").slice(0, max).replace(/<!--[\s\S]*?(-->|$)/g, "");
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const texto = (t: string) => t.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let out = "", ult = 0, saltarHasta = "";
  const pila: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (!saltarHasta) out += texto(s.slice(ult, m.index));
    ult = re.lastIndex;
    const cierre = m[1] === "/", tag = m[2].toLowerCase();
    if (saltarHasta) { if (cierre && tag === saltarHasta) saltarHasta = ""; continue; }
    if (ETIQUETAS_FUERA.has(tag)) { if (!cierre && !/\/\s*$/.test(m[3])) saltarHasta = tag; continue; }
    if (!ETIQUETAS_OK.has(tag)) continue;
    if (cierre) {
      const k = pila.lastIndexOf(tag);
      if (k < 0) continue;
      while (pila.length > k) out += "</" + pila.pop() + ">";
      continue;
    }
    let attrs = "";
    const ra = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
    let a: RegExpExecArray | null;
    while ((a = ra.exec(m[3]))) {
      const n = a[1].toLowerCase();
      if (!ATRIBUTOS_OK.has(n)) continue;
      let v = a[2] ?? "";
      if (/^["']/.test(v)) v = v.slice(1, -1);
      if (n === "href" && !urlSegura(v, false)) continue;
      if ((n === "src" || n === "poster") && !(tag === "iframe" ? urlSegura(v, true) : /^https:\/\//i.test(v.trim()) || /^data:image\/(png|jpe?g|gif|webp);/i.test(v.trim()))) continue;
      if (n === "srcset" && /javascript:|data:(?!image\/)/i.test(v)) continue;
      if (n === "style" && /expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(v)) continue;
      attrs += " " + n + (a[2] === undefined ? "" : '="' + esc(v.replace(/&amp;/g, "&")) + '"');
    }
    if (tag === "iframe" && !/ src="/.test(attrs)) continue;
    if (tag === "a" && / target="_blank"/i.test(attrs) && !/ rel="/.test(attrs)) attrs += ' rel="noopener"';
    out += "<" + tag + attrs + ">";
    if (!ETIQUETAS_VACIAS.has(tag)) pila.push(tag);
  }
  if (!saltarHasta) out += texto(s.slice(ult));
  while (pila.length) out += "</" + pila.pop() + ">";
  return out;
}

/**
 * FORMULARIOS-2 · Página entera de HTML propio (el diseño lo hace quien la escribe, como en
 * Páginas). Se admite pegar un documento completo: de su <head> se quedan los <style> y las
 * letras de Google Fonts; del resto, lo que deja pasar limpiarHtmlFormulario. El marcador
 * {{formulario}} dice dónde van las preguntas. La salida vuelve a ser entrada válida (se
 * sanea al guardar y otra vez al pintar sin cambiar).
 */
export const MARCA_FORMULARIO = "{{formulario}}";
const MAX_PAGINA_HTML = 80000;
export function limpiarPaginaHtml(html: unknown): string {
  let s = String(html ?? "").slice(0, MAX_PAGINA_HTML).replace(/<!--[\s\S]*?(-->|$)/g, "");
  const estilos: string[] = [], letras: string[] = [];
  s = s.replace(/<style\b[^>]*>([\s\S]*?)(<\/style\s*>|$)/gi, (_m, css: string) => { estilos.push(limpiarCssFormulario(css)); return ""; });
  s = s.replace(/<link\b[^>]*>/gi, (m) => {
    const h = /\bhref\s*=\s*["']?(https:\/\/fonts\.googleapis\.com\/[^"'\s>]+)/i.exec(m);
    if (h && !/[<>"'\\]/.test(h[1]) && letras.length < 4) letras.push(h[1].replace(/&amp;/g, "&"));
    return "";
  });
  const cuerpo = /<body\b[^>]*>([\s\S]*?)(<\/body\s*>|$)/i.exec(s);
  if (cuerpo) s = cuerpo[1];
  const css = estilos.join("\n").trim();
  return (css ? "<style>\n" + css + "\n</style>\n" : "")
    + letras.map((u) => '<link rel="stylesheet" href="' + esc(u) + '">\n').join("")
    + limpiarHtmlFormulario(s.trim(), MAX_PAGINA_HTML);
}
/** Separa lo que va en <head> (estilos y letras, ya limpios) del cuerpo de una página ya saneada. */
function partesPaginaHtml(limpia: string): { cabeza: string; cuerpo: string } {
  let cabeza = "";
  const cuerpo = limpia
    .replace(/^<style>\n([\s\S]*?)\n<\/style>\n/, (_m, css: string) => { cabeza += "<style>" + limpiarCssFormulario(css) + "</style>"; return ""; })
    .replace(/^(<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/[^"]*">\n)+/, (m) => { cabeza += m; return ""; });
  return { cabeza, cuerpo };
}

/**
 * FORMULARIOS-3 · Plantillas de página propia: el HTML que alguien quiere reutilizar en
 * varios formularios. Viven por negocio en un ajuste (`formularios.plantillas`, JSON), sin
 * tabla nueva. Se guardan YA saneadas, igual que la página de un formulario.
 */
export interface PlantillaPagina { id: string; nombre: string; html: string; upd: number }
const CLAVE_PLANTILLAS = "formularios.plantillas";
const MAX_PLANTILLAS = 20;
export function listarPlantillas(): PlantillaPagina[] {
  try {
    const v = JSON.parse(getWorkspaceSetting(currentWorkspaceId(), CLAVE_PLANTILLAS, "") || "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((p) => p && typeof p.id === "string" && typeof p.html === "string")
      .map((p) => ({ id: p.id, nombre: String(p.nombre || "Plantilla").slice(0, 60), html: p.html, upd: Number(p.upd) || 0 }));
  } catch { return []; }
}
/** Guarda (o sobrescribe, si llega `id` o el mismo nombre) una plantilla. */
export async function guardarPlantilla(b: { id?: unknown; nombre?: unknown; html?: unknown }): Promise<{ ok: true; plantilla: PlantillaPagina } | { ok: false; error: string; campo: string }> {
  const nombre = String(b.nombre ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!nombre) return { ok: false, error: "Ponle un nombre a la plantilla", campo: "nombre" };
  const html = limpiarPaginaHtml(b.html);
  if (!html.trim()) return { ok: false, error: "La página está vacía: escribe tu HTML antes de guardarla como plantilla", campo: "html" };
  const lista = listarPlantillas();
  const id = String(b.id ?? "").trim();
  const previa = lista.find((p) => (id && p.id === id) || p.nombre.toLowerCase() === nombre.toLowerCase());
  const plantilla: PlantillaPagina = { id: previa?.id || "plt_" + crypto.randomBytes(6).toString("hex"), nombre, html, upd: Date.now() };
  const resto = lista.filter((p) => p.id !== plantilla.id);
  if (!previa && resto.length >= MAX_PLANTILLAS) return { ok: false, error: "Ya tienes " + MAX_PLANTILLAS + " plantillas: borra alguna antes de guardar otra", campo: "nombre" };
  await setWorkspaceSetting(currentWorkspaceId(), CLAVE_PLANTILLAS, JSON.stringify([plantilla, ...resto]));
  return { ok: true, plantilla };
}
export async function borrarPlantilla(id: unknown): Promise<boolean> {
  const lista = listarPlantillas();
  const resto = lista.filter((p) => p.id !== String(id ?? ""));
  if (resto.length === lista.length) return false;
  await setWorkspaceSetting(currentWorkspaceId(), CLAVE_PLANTILLAS, JSON.stringify(resto));
  return true;
}

/** CSS propio: sólo se impide que salga de su <style>. Lo que cargue lo acota la CSP. */
export function limpiarCssFormulario(css: unknown): string {
  return String(css ?? "").slice(0, 20000).replace(/</g, "");
}

/** Imagen de fondo: una dirección https sin caracteres que rompan el CSS. */
// FORMULARIOS-7 · color de fondo de la página (y el del texto encima) para la barra de estado
// del móvil y la tablet de la vista previa: así el marco parece el teléfono con esa página abierta.
// «Claro» sin imagen se pasa a oscuro con el dispositivo (CSS_FORMULARIO): va también esa variante.
export function colorBarraFormulario(o: FormRec["opts"]): { bg: string; tx: string; oscuro?: { bg: string; tx: string } } {
  const t = temaFormulario(o.theme);
  const bg = o.layout === "html" ? "#ffffff" : fondoValido(o.bgImage) ? "#111111" : (String(t.bg).match(/#[0-9a-f]{6}/i) || ["#ffffff"])[0];
  const sigue = o.layout !== "html" && !fondoValido(o.bgImage) && t.id === "claro";
  return { bg, tx: textoSobre(bg), ...(sigue ? { oscuro: { bg: "#0f1115", tx: "#ffffff" } } : {}) };
}

// FORMULARIOS-8 · imagen o vídeo de una pregunta. Vale lo subido desde el panel (se sirve en
// /f/m/<id>) o una dirección https. Los enlaces de YouTube, Vimeo y Loom se ven con su reproductor.
const MEDIO_PROPIO = /^\/f\/m\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function videoIncrustado(u: string): string {
  let m = /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i.exec(u);
  if (m) return "https://www.youtube-nocookie.com/embed/" + m[1];
  m = /^https:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?(\d{5,12})/i.exec(u);
  if (m) return "https://player.vimeo.com/video/" + m[1];
  m = /^https:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([0-9a-f]{32})/i.exec(u);
  if (m) return "https://www.loom.com/embed/" + m[1];
  return "";
}
export function medioValido(v: unknown): FormQuestion["media"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const url = String(o.url || "").trim();
  if (!MEDIO_PROPIO.test(url) && !fondoValido(url)) return undefined;
  const video = !!videoIncrustado(url) || o.tipo === "video" || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url);
  return { tipo: video ? "video" : "imagen", url };
}

export function fondoValido(u: unknown): string {
  const s = String(u || "").trim();
  return /^https:\/\/[^\s"'()<>\\]+$/i.test(s) && s.length <= 500 ? s : "";
}

/** La política de la página pública: sólo corre nuestro script (con su nonce). */
export function cspFormulario(nonce: string, marcoExtra = ""): string {
  return [
    "default-src 'none'",
    "script-src 'nonce-" + nonce + "'",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com data:",
    // FORMULARIOS-8 · 'self': la imagen o el vídeo subidos desde el panel se sirven en /f/m/<id>.
    "img-src 'self' https: data:",
    "media-src 'self' https: data:",
    // FORM-CITA-1 · `marcoExtra` = origen del calendario de reservas del formulario, y
    // 'self' para la página de vuelta (/f/<slug>/reservada) cuando ya se ha reservado.
    "frame-src 'self' " + MARCOS_OK.map((u) => u.replace(/\/(maps\/)?$/, "")).join(" ") + (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(marcoExtra) ? " " + marcoExtra : ""),
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
  ].join("; ");
}

/** Texto legible sobre un color de acento elegido a mano. */
function textoSobre(hex: string): string {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#111" : "#fff";
}

/** CSS del diseño elegido (+ color propio e imagen de fondo) y el <link> de sus fuentes. */
// FORMULARIOS-6 · en una por pantalla la pregunta va sin caja, directa sobre el fondo. Sólo
// se queda la tarjeta donde el texto oscuro no se leería sobre el fondo: degradados intensos
// con tarjeta blanca (Atardecer, Océano) y cualquier imagen de fondo.
function tarjetaEnUno(form: FormRec): boolean {
  return !!fondoValido(form.opts.bgImage) || ["atardecer", "oceano"].includes(temaFormulario(form.opts.theme).id);
}

function cssDelDiseno(form: FormRec): { css: string; fuentes: string } {
  const t = temaFormulario(form.opts.theme);
  const propio = /^#[0-9a-f]{6}$/i.test(String(form.opts.color || "")) ? String(form.opts.color) : "";
  const b = propio || t.b, bt = propio ? textoSobre(propio) : t.bt;
  let css = t.id === "claro"
    ? ":root{--b:" + b + ";--bt:" + bt + "}"
    : ":root{--bg:" + t.card + ";--card:" + t.card + ";--tx:" + t.tx + ";--mu:" + t.mu + ";--ln:" + t.ln + ";--in:" + t.inp + ";--b:" + b + ";--bt:" + bt + ";--er:#d93a2b}"
      + "body{background:" + t.bg + ";background-attachment:fixed}.neg{color:" + t.neg + "}";
  const fam = (f: string) => "'" + f + "',system-ui,-apple-system,'Segoe UI',sans-serif";
  if (t.fuente) css += "body,input,textarea,select,.btn{font-family:" + fam(t.fuente) + "}";
  if (t.titulos) css += "h1{font-family:'" + t.titulos + "',Georgia,serif;font-weight:600;letter-spacing:0}";
  if (t.radio !== 12) css += "input[type=text],input[type=email],input[type=tel],input[type=number],input[type=date],textarea,select,.op,.btn{border-radius:" + t.radio + "px}.c{border-radius:" + (t.radio ? t.radio + 6 : 0) + "px}";
  if (t.sinTarjeta) css += ".c{background:transparent;border:0;box-shadow:none;padding:8px 0}h1{font-size:34px}@media (max-width:520px){.c{padding:4px 0}h1{font-size:28px}}";
  const fondo = fondoValido(form.opts.bgImage);
  if (fondo) css += "body{background:linear-gradient(rgba(0,0,0,.38),rgba(0,0,0,.38)),url(\"" + fondo + "\") center/cover fixed}.neg{color:#fff}"
    + (t.sinTarjeta ? ".c{background:var(--card);border:1px solid var(--ln);padding:32px}@media (max-width:520px){.c{padding:22px 18px}}" : "");
  // FORMULARIOS-6 · una por pantalla: la cabecera va sobre el fondo (color del negocio), la
  // pregunta con la letra de títulos del diseño, y con tarjeta (.tj) la barra en blanco.
  const sobreFondo = fondo ? "#fff" : t.id === "claro" ? "" : t.neg;
  if (sobreFondo) css += "body.uno .pr{color:" + sobreFondo + "}";
  if (t.titulos) css += "body.uno .q .t{font-family:'" + t.titulos + "',Georgia,serif}";
  css += ""
    + ".hx{margin:0 0 20px;overflow-wrap:anywhere}.hx:last-child{margin:20px 0 0}.hx img,.hx video,.hx iframe{max-width:100%;height:auto;border:0}.hx iframe{aspect-ratio:16/9;width:100%}";
  const fams = [t.fuente, t.titulos].filter(Boolean) as string[];
  const fuentes = fams.length
    ? '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
      + fams.map((f) => "family=" + f.replace(/ /g, "+") + ":wght@400;500;600;700").join("&amp;") + '&amp;display=swap">'
    : "";
  return { css, fuentes };
}

const CSS = [
  ":root{--b:#2563eb;--bg:#f5f6f8;--card:#fff;--tx:#14161a;--mu:#5c6370;--ln:#dfe2e7;--in:#fff;--er:#c0392b}",
  "@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--tx:#eef0f3;--mu:#9aa3af;--ln:#2a2f38;--in:#1d2129;--er:#ff7b6b}}",
  "*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--tx);font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:32px 16px}",
  ".w{width:100%;max-width:600px}.neg{font-size:13px;color:var(--mu);margin:0 0 12px;letter-spacing:.02em}",
  ".c{background:var(--card);border:1px solid var(--ln);border-radius:18px;padding:32px;box-shadow:0 1px 2px rgba(0,0,0,.04)}",
  "@media (max-width:520px){.c{padding:22px 18px;border-radius:14px}body{padding:18px 12px}}",
  "h1{font-size:26px;line-height:1.25;margin:0 0 8px;letter-spacing:-.01em}.intro{color:var(--mu);margin:0 0 24px;white-space:pre-line}",
  ".bar{height:4px;background:var(--ln);border-radius:4px;overflow:hidden;margin:0 0 22px}.bar i{display:block;height:100%;background:var(--b);width:0;transition:width .25s}",
  ".q{margin:0 0 22px}.q.oc{display:none}.q .t{display:block;font-weight:600;margin:0 0 8px}.q .req{color:var(--b);margin-left:2px}",
  "input[type=text],input[type=email],input[type=tel],input[type=number],input[type=date],textarea,select{width:100%;font:inherit;color:var(--tx);background:var(--in);border:1px solid var(--ln);border-radius:12px;padding:12px 14px;min-height:48px;outline:none;transition:border-color .15s}",
  "textarea{min-height:120px;resize:vertical}input:focus,textarea:focus{border-color:var(--b);box-shadow:0 0 0 3px color-mix(in srgb,var(--b) 18%,transparent)}",
  ".ops{display:grid;gap:8px}.op{display:flex;align-items:center;gap:10px;border:1px solid var(--ln);border-radius:12px;padding:12px 14px;cursor:pointer;background:var(--in);transition:border-color .15s}",
  ".op:hover{border-color:var(--b)}.op input{accent-color:var(--b);width:18px;height:18px;margin:0;flex:none}.op.on{border-color:var(--b);box-shadow:inset 0 0 0 1px var(--b)}",
  ".sn{grid-template-columns:1fr 1fr}.ac{display:flex;gap:10px;align-items:flex-start;cursor:pointer}.ac input{accent-color:var(--b);width:18px;height:18px;margin:3px 0 0;flex:none}",
  ".er{color:var(--er);font-size:14px;margin:6px 0 0;min-height:0}.q.mal input,.q.mal textarea,.q.mal .op{border-color:var(--er)}",
  ".acc{display:flex;gap:10px;margin-top:8px}.btn{flex:1;font:inherit;font-weight:600;border:0;border-radius:12px;min-height:50px;padding:0 20px;cursor:pointer;background:var(--b);color:var(--bt,#fff);transition:filter .15s}",
  ".btn:hover{filter:brightness(1.06)}.btn[disabled]{opacity:.6;cursor:default}.btn.sec{flex:0 0 auto;background:transparent;color:var(--tx);border:1px solid var(--ln)}.btn.sec:hover{filter:none;border-color:var(--b)}",
  ".hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}",
  // FORM-ARCHIVO-1 · adjuntar archivos: botón con borde discontinuo y la lista de lo subido.
  ".ar{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:6px;cursor:pointer}.ar input{position:absolute;opacity:0;width:1px;height:1px}",
  ".arb{display:inline-flex;align-items:center;gap:8px;border:1px dashed var(--ln);border-radius:12px;padding:12px 16px;background:var(--in);font-weight:600;transition:border-color .15s}.ar:hover .arb,.ar input:focus-visible+.arb{border-color:var(--b)}.arb svg{width:18px;height:18px;flex:none}.arh{font-size:13px;color:var(--mu)}",
  ".arl{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:6px}.arl:empty{display:none}.arl li{display:flex;align-items:center;gap:8px;border:1px solid var(--ln);border-radius:10px;padding:8px 12px;background:var(--in);font-size:14px;min-width:0}",
  ".arl li span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.arl li.sb{color:var(--mu)}.arx{flex:none;border:0;background:none;color:var(--mu);font:inherit;font-size:20px;line-height:1;cursor:pointer;padding:0 4px}.arx:hover{color:var(--tx)}",
  ".ok{text-align:center;padding:12px 0}.ok .ic{width:56px;height:56px;border-radius:50%;background:color-mix(in srgb,var(--b) 14%,transparent);color:var(--b);display:grid;place-items:center;margin:0 auto 16px}",
  ".ok p{color:var(--mu);white-space:pre-line;margin:0}.pie{font-size:12px;color:var(--mu);text-align:center;margin:16px 0 0}.gen{color:var(--er);margin:0 0 12px}",
  // FORMULARIOS-4 · descripción, opciones con letra, desplegable, escala, estrellas y el modo una a una.
  ".q .ds{color:var(--mu);font-size:14.5px;margin:-4px 0 12px;white-space:pre-line;overflow-wrap:anywhere}.hv{color:var(--mu);font-size:13px;margin:-4px 0 10px}",
  "select{appearance:none;-webkit-appearance:none;cursor:pointer;padding-right:40px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 20px) 50%,calc(100% - 15px) 50%;background-size:5px 5px;background-repeat:no-repeat}select:focus{border-color:var(--b);box-shadow:0 0 0 3px color-mix(in srgb,var(--b) 18%,transparent)}",
  ".op{position:relative}.op input{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}.op:focus-within{border-color:var(--b)}",
  ".op .k{flex:none;min-width:26px;height:26px;padding:0 6px;border:1px solid var(--ln);border-radius:6px;display:inline-grid;place-items:center;font-size:12.5px;font-weight:700;color:var(--mu);background:var(--card);transition:background .15s,color .15s,border-color .15s}",
  ".op .ot{flex:1;min-width:0;overflow-wrap:anywhere}.op .ck{flex:none;width:18px;height:18px;color:var(--b);opacity:0;transition:opacity .15s}",
  ".op.on{background:color-mix(in srgb,var(--b) 9%,var(--in))}.op.on .k{background:var(--b);border-color:var(--b);color:var(--bt,#fff)}.op.on .ck{opacity:1}",
  ".esc{grid-template-columns:repeat(11,minmax(0,1fr));gap:6px}.esc .op{justify-content:center;padding:0;min-height:48px;font-weight:600;font-variant-numeric:tabular-nums}.esc .op.on{background:var(--b);color:var(--bt,#fff)}",
  "@media (max-width:560px){.esc{grid-template-columns:repeat(6,minmax(0,1fr))}}",
  ".est{display:flex;flex-direction:row-reverse;justify-content:flex-end;gap:4px}.est .op{border:0;background:transparent;box-shadow:none;padding:4px;color:var(--ln)}.est .op svg{width:42px;height:42px;display:block}",
  ".est .op.on,.est .op.on~.op,.est .op:hover,.est .op:hover~.op{color:var(--b);background:transparent}.est .op:focus-within{outline:2px solid var(--b);outline-offset:1px;border-radius:8px}",
  // FORMULARIOS-4 · la pregunta recibe el foco por programa (para el teclado): sin recuadro; el foco visible es el de cada opción.
  ".q:focus{outline:none}",
  ".nm{display:none}#fm[data-uno=\"1\"] .nm{display:inline-flex;align-items:center;gap:3px;color:var(--b);font-size:15px;font-weight:700;margin-right:10px;vertical-align:2px}.nm svg{width:14px;height:14px}",
  ".pr{font-size:13px;color:var(--mu);margin:0 0 8px;font-variant-numeric:tabular-nums}",
  ".kh,.nav{display:none}.kh{font-size:13px;color:var(--mu)}.kh b{font-weight:600;color:var(--tx)}#fm[data-uno=\"1\"] .kh,.wl .kh{display:inline}",
  "#fm[data-uno=\"1\"] .acc{align-items:center;flex-wrap:wrap;gap:12px;margin-top:4px}#fm[data-uno=\"1\"] #env{flex:0 0 auto;min-width:120px}",
  "#fm[data-uno=\"1\"] .nav{display:inline-flex;gap:6px;margin-left:auto}.nav .btn{flex:none;width:42px;min-height:42px;padding:0;display:inline-grid;place-items:center}.nav .btn[disabled]{opacity:.35}",
  "@media (hover:none){.kh{display:none!important}}",
  "@keyframes qsube{from{opacity:0;transform:translateY(64px)}to{opacity:1;transform:none}}@keyframes qbaja{from{opacity:0;transform:translateY(-64px)}to{opacity:1;transform:none}}",
  // FORMULARIOS-5 · la pregunta que se va también se mueve: así se ve que «se pasa» a la siguiente.
  "@keyframes qsalea{to{opacity:0;transform:translateY(-64px)}}@keyframes qsaleb{to{opacity:0;transform:translateY(64px)}}.q.sa{animation:qsalea .22s ease-in both;pointer-events:none}.q.sb{animation:qsaleb .22s ease-in both;pointer-events:none}",
  ".q.va{animation:qsube .42s cubic-bezier(.2,.7,.2,1) both}.q.vu{animation:qbaja .42s cubic-bezier(.2,.7,.2,1) both}.ok,.wl{animation:qsube .45s cubic-bezier(.2,.7,.2,1) both}",
  // FORMULARIOS-6 · una por pantalla con aspecto profesional (tipo Typeform): pantalla completa,
  // columna de 720 px centrada, cabecera discreta (negocio · título a la izquierda, «2 de 5» a la
  // derecha), barra de progreso fina arriba a todo el ancho, campos subrayados en letra grande,
  // opciones tintadas del color de marca y las flechas unidas abajo a la derecha. Sin tarjeta
  // salvo .tj (ver tarjetaEnUno). Todo bajo body.uno: ni «todas a la vez» ni el HTML propio cambian.
  "body.uno{padding:0 24px;align-items:stretch}body.uno .w{max-width:720px;margin:0 auto;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;padding:20px 0 96px;position:relative}",
  "body.uno .neg{margin:0;font-size:14px;line-height:24px;font-weight:600;letter-spacing:0;padding-right:84px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}body.uno .neg .nt{font-weight:500;opacity:.85}body.uno .neg .sp{margin:0 8px;opacity:.45}",
  "body:has(.c.bv) .neg .nt,body:has(.c.bv) .neg .sp{display:none}",
  "body.uno .pr{position:absolute;top:20px;right:0;margin:0;font-size:13px;line-height:24px;font-weight:600;letter-spacing:.02em}",
  "body.uno .bar{position:fixed;top:0;left:0;right:0;height:4px;margin:0;border-radius:0;background:color-mix(in srgb,var(--b) 16%,transparent);z-index:6}body.uno .bar i{transition:width .4s cubic-bezier(.2,.7,.2,1)}",
  "body.uno .c{background:transparent;border:0;box-shadow:none;border-radius:0;padding:0;margin:auto 0;width:100%}",
  "body.uno .c>h1{display:none}body.uno .c>.intro{font-size:17px;margin:0 0 32px;max-width:600px}",
  "body.uno .c:not(:has(#fm>.hp+.q:not(.oc)))>.intro{display:none}",
  "body.uno.tj .c{background:var(--card);border:0;border-radius:24px;padding:52px 56px;box-shadow:0 24px 60px rgba(0,0,0,.18);min-height:min(520px,calc(100vh - 170px));display:flex;flex-direction:column;justify-content:center}",
  "body.uno.tj .bar{background:rgba(255,255,255,.3)}body.uno.tj .bar i{background:#fff}",
  // La pregunta: grande, con el número colgado a la izquierda en pantallas anchas.
  "body.uno #fm .q{margin:0}body.uno #fm .q .t{position:relative;font-size:26px;line-height:1.3;font-weight:500;letter-spacing:-.01em;margin:0 0 10px;overflow-wrap:anywhere}",
  "body.uno #fm .nm{font-size:15px;margin-right:10px;vertical-align:4px}",
  "@media (min-width:900px){body.uno:not(.tj) #fm .nm{position:absolute;right:100%;top:8px;margin-right:14px;white-space:nowrap}}",
  "body.uno #fm .q .ds{font-size:18px;line-height:1.45;margin:0 0 22px}body.uno #fm .q .t+.ops,body.uno #fm .q .t+input,body.uno #fm .q .t+textarea,body.uno #fm .q .t+select{margin-top:22px}body.uno #fm .hv{font-size:14px;margin:-12px 0 14px}",
  // Campos subrayados, sin caja: el texto que se escribe es lo protagonista.
  "body.uno #fm input[type=text],body.uno #fm input[type=email],body.uno #fm input[type=tel],body.uno #fm input[type=number],body.uno #fm input[type=date],body.uno #fm textarea{background:transparent;border:0;border-bottom:2px solid color-mix(in srgb,var(--b) 32%,transparent);border-radius:0;padding:4px 0 8px;min-height:50px;font-size:26px;line-height:1.3;box-shadow:none;transition:border-color .2s}",
  "body.uno #fm textarea{font-size:21px;min-height:112px;resize:none}body.uno #fm input[type=date]{font-size:22px;max-width:320px}",
  "body.uno #fm input:focus,body.uno #fm textarea:focus{border-bottom-color:var(--b);box-shadow:none}",
  "body.uno #fm input::placeholder,body.uno #fm textarea::placeholder{color:color-mix(in srgb,var(--tx) 30%,transparent);opacity:1}",
  "body.uno #fm select{font-size:19px;min-height:54px;max-width:480px}",
  "body.uno #fm .q.mal input,body.uno #fm .q.mal textarea{border-color:transparent;border-bottom-color:var(--er)}",
  // Opciones: tarjetas tintadas del color de marca, a un ancho cómodo.
  "body.uno #fm .ops:not(.esc):not(.est){max-width:480px}body.uno #fm .ops{gap:10px}",
  "body.uno #fm .op{font-size:18px;padding:11px 14px;background:color-mix(in srgb,var(--b) 7%,transparent);border-color:color-mix(in srgb,var(--b) 38%,transparent)}",
  "body.uno #fm .op:hover{background:color-mix(in srgb,var(--b) 13%,transparent);border-color:var(--b)}",
  "body.uno #fm .op .k{border-color:color-mix(in srgb,var(--b) 55%,transparent);color:var(--b);background:var(--card)}",
  "body.uno #fm .op.on{background:color-mix(in srgb,var(--b) 18%,transparent);border-color:var(--b);box-shadow:inset 0 0 0 1px var(--b)}body.uno #fm .op.on .k{background:var(--b);border-color:var(--b);color:var(--bt,#fff)}",
  "body.uno #fm .esc .op{font-size:17px;padding:0}body.uno #fm .esc .op.on{background:var(--b);color:var(--bt,#fff)}",
  "body.uno #fm .est .op,body.uno #fm .est .op:hover,body.uno #fm .est .op.on{background:transparent;border:0;box-shadow:none}body.uno #fm .est .op{color:color-mix(in srgb,var(--b) 28%,transparent)}",
  "body.uno #fm .est .op.on,body.uno #fm .est .op.on~.op,body.uno #fm .est .op:hover,body.uno #fm .est .op:hover~.op{color:var(--b)}",
  // El aviso de error, como una pastilla que no se confunde con el texto.
  "body.uno #fm .er:empty{display:none}body.uno #fm .er:not(:empty){display:inline-block;margin:14px 0 0;padding:6px 12px;border-radius:8px;font-size:14px;background:color-mix(in srgb,var(--er) 12%,transparent)}",
  // Botón compacto + «pulsa Enter»; las flechas, unidas y fijas abajo a la derecha.
  "body.uno #fm .acc{margin-top:30px;gap:14px}body.uno #fm #env{min-width:0;min-height:46px;padding:0 24px;font-size:17px;box-shadow:0 1px 2px rgba(0,0,0,.08)}",
  "body.uno #fm .nav{position:fixed;right:24px;bottom:24px;margin:0;gap:0;border-radius:10px;overflow:hidden;box-shadow:0 6px 18px rgba(0,0,0,.14);z-index:6}",
  "body.uno #fm .nav .btn{width:42px;min-height:40px;border:0;border-radius:0;background:var(--b);color:var(--bt,#fff)}body.uno #fm .nav .btn+.btn{border-left:1px solid color-mix(in srgb,var(--bt,#fff) 28%,transparent)}",
  "body.uno #fm .nav .btn:hover{filter:brightness(1.08)}body.uno #fm .nav .btn[disabled]{opacity:1;color:color-mix(in srgb,var(--bt,#fff) 40%,transparent)}",
  // Bienvenida y final, a juego.
  "body.uno .wl{text-align:left;padding:0}body.uno .wl h1{font-size:40px;line-height:1.15;letter-spacing:-.02em;margin:0 0 14px}body.uno .wl .intro{font-size:19px;max-width:560px;margin:0 0 34px}body.uno .wla{justify-content:flex-start}body.uno .wla .btn{min-width:0;min-height:48px;padding:0 28px;font-size:17px}",
  "body.uno.tj .wl{text-align:center}body.uno.tj .wl .intro{margin:0 auto 34px}body.uno.tj .wla{justify-content:center}",
  "body.uno .ok h1{font-size:32px}body.uno .ok p{font-size:18px}",
  ".wl{text-align:center;padding:8px 0}.wl h1{font-size:32px}.wl .intro{max-width:460px;margin:0 auto 28px}.wla{display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap}.wla .btn{flex:0 0 auto;min-width:170px}",
  ".bv #fm,.bv .pr,.bv .bar{display:none}.c:not(.bv) .wl{display:none}",
  "@media (max-width:520px){.wl h1{font-size:26px}body.uno{padding:0 18px}body.uno .w{padding:16px 0 84px}body.uno .pr{top:16px}"
    + "body.uno #fm .q .t{font-size:22px}body.uno #fm .q .ds{font-size:16px}body.uno #fm input[type=text],body.uno #fm input[type=email],body.uno #fm input[type=tel],body.uno #fm input[type=number]{font-size:22px}"
    + "body.uno .wl h1{font-size:30px}body.uno .wl .intro{font-size:17px}body.uno.tj .c{padding:32px 22px;border-radius:18px;min-height:min(460px,calc(100vh - 150px))}body.uno #fm .nav{right:16px;bottom:16px}}",
  // FORMULARIOS-8 · imagen o vídeo encima de la pregunta, y varias preguntas en una pantalla
  // (.g; .gs = la segunda y siguientes): letra algo menor y aire entre ellas, para que quepan.
  ".md{margin:0 0 16px}.md img,.md video{display:block;max-width:100%;max-height:360px;height:auto;border-radius:12px;object-fit:contain}.md video{width:100%;background:#000}",
  ".md iframe{display:block;width:100%;height:auto;aspect-ratio:16/9;border:0;border-radius:12px;background:#000}",
  "body.uno #fm .md{margin:0 0 24px;max-width:640px}body.uno #fm .md img,body.uno #fm .md video{max-height:min(40vh,400px)}body.uno #fm .q.g .md img,body.uno #fm .q.g .md video{max-height:min(28vh,260px)}",
  "body.uno #fm .q.gs{margin-top:30px}body.uno #fm .q.g .t{font-size:21px;margin:0 0 4px}body.uno #fm .q.g .ds{font-size:15.5px;margin:0 0 6px}",
  "body.uno #fm .q.g .t+.ops,body.uno #fm .q.g .t+input,body.uno #fm .q.g .t+textarea,body.uno #fm .q.g .t+select{margin-top:10px}",
  "body.uno #fm .q.g input[type=text],body.uno #fm .q.g input[type=email],body.uno #fm .q.g input[type=tel],body.uno #fm .q.g input[type=number],body.uno #fm .q.g input[type=date]{font-size:21px;min-height:46px}",
  "body.uno #fm .q.g textarea{font-size:18px;min-height:88px}body.uno #fm .q.g .op{font-size:16px}",
  "@media (max-width:520px){body.uno #fm .q.gs{margin-top:24px}body.uno #fm .q.g .t{font-size:19px}body.uno #fm .q.g input[type=text],body.uno #fm .q.g input[type=email],body.uno #fm .q.g input[type=tel],body.uno #fm .q.g input[type=number]{font-size:19px}}",
  "@media (prefers-reduced-motion:reduce){.q.va,.q.vu,.q.sa,.q.sb,.ok,.wl{animation:none}}",
  // FORM-CITA-1 · el último paso: el calendario de reservas de la web, a lo ancho.
  "body.ci .w,body.uno.ci .w{max-width:900px}body.uno.tj.ci .c{padding:28px}",
  ".ct h1{margin:0 0 6px}.ct .intro{margin:0 0 18px}",
  ".cal{display:block;width:100%;height:780px;max-height:calc(100vh - 150px);max-height:calc(100dvh - 150px);min-height:540px;border:1px solid var(--ln);border-radius:12px;background:#fff}",
  "@media (max-width:520px){body.uno.tj.ci .c{padding:18px 14px}.cal{min-height:600px;border-radius:10px}}",
].join("");

// FORMULARIOS-2 · En la página de HTML propio el cuerpo es del cliente: fuera el centrado
// en columna de la página normal; el bloque de preguntas (.fx) mantiene un ancho legible, y el
// diseño «Claro» no se pasa a oscuro con el dispositivo: los colores de la página los pone quien la escribe.
const CSS_PAGINA_PROPIA = "body.propia{display:block;padding:0;min-height:0}.fx{width:100%;max-width:560px;margin:0 auto;padding:8px 0}.fx .ok{padding:24px 0}"
  + "@media (prefers-color-scheme:dark){body.propia.t-claro{--bg:#f5f6f8;--card:#fff;--tx:#14161a;--mu:#5c6370;--ln:#dfe2e7;--in:#fff;--er:#c0392b}}";

// FORMULARIOS-4 · iconos y letras de las opciones (como en Typeform: A, B, C… se eligen con el teclado).
const SVG_CLIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>';
const SVG_CHECK = '<svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const SVG_ESTRELLA = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.8l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.6l-5.8 3.1 1.1-6.5L2.6 9.6l6.5-.9z"/></svg>';
const SVG_FLECHA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const SVG_ARRIBA = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
const SVG_ABAJO = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const LETRAS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** FORMULARIOS-8 · la imagen o el vídeo que va encima de la pregunta. */
function mediaHtml(q: FormQuestion): string {
  const m = q.media;
  if (!m || !m.url) return "";
  const emb = videoIncrustado(m.url);
  if (emb) return '<figure class="md mdv"><iframe src="' + esc(emb) + '" title="Vídeo" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe></figure>';
  if (m.tipo === "video") return '<figure class="md"><video src="' + esc(m.url) + '" controls playsinline preload="metadata"></video></figure>';
  return '<figure class="md"><img src="' + esc(m.url) + '" alt="" decoding="async"></figure>';
}

// FORMULARIOS-8 · n = número de pantalla (paso); junta = comparte pantalla con otras;
// primero = es la primera de su pantalla (sólo ella lleva el número).
function campoHtml(q: FormQuestion, n: number, junta = false, primero = true): string {
  const id = "q_" + esc(q.id), name = esc(q.id);
  const req = q.required ? ' required aria-required="true"' : "";
  const ph = q.placeholder ? ' placeholder="' + esc(q.placeholder) + '"' : "";
  // FORMULARIOS-6 · un campo subrayado vacío parece un hueco: sin texto de ayuda propio, uno genérico.
  const phR = ph || ' placeholder="Escribe aquí tu respuesta…"';
  const marca = q.required ? '<span class="req" aria-hidden="true">*</span>' : "";
  // El número sólo se ve en el modo una a una (lo decide el CSS).
  const num = primero ? '<span class="nm" aria-hidden="true">' + (n + 1) + SVG_FLECHA + "</span>" : "";
  const ds = q.description ? '<p class="ds" id="' + id + '_d">' + esc(q.description) + "</p>" : "";
  const dsRef = q.description ? ' aria-describedby="' + id + '_d"' : "";
  const etq = '<label class="t" for="' + id + '">' + num + esc(q.label) + marca + "</label>" + ds;
  const grupo = '<span class="t" id="' + id + '_l">' + num + esc(q.label) + marca + "</span>" + ds;
  const caja = (cab: string, ctl: string) => '<div class="q' + (junta ? " g" + (primero ? "" : " gs") : "") + '" data-q="' + name + '" data-t="' + q.type + '" data-p="' + n + '">' + mediaHtml(q) + cab + ctl + '<p class="er" role="alert"></p></div>';
  const op = (tipo: string, valor: string, texto: string, tecla: string) =>
    '<label class="op"><input type="' + tipo + '" name="' + name + '" value="' + esc(valor) + '"><span class="k" aria-hidden="true">' + tecla + '</span><span class="ot">' + esc(texto) + "</span>" + SVG_CHECK + "</label>";
  const lista = (clase: string, rol: string, dentro: string) => '<div class="' + clase + '" role="' + rol + '" aria-labelledby="' + id + '_l"' + dsRef + ">" + dentro + "</div>";
  const input = (tipo: string, extra: string) => '<input type="' + tipo + '" id="' + id + '" name="' + name + '"' + extra + req + dsRef;
  switch (q.type) {
    case "email": return caja(etq, input("email", ' autocomplete="email" inputmode="email"') + (ph || ' placeholder="tu@correo.com"') + ">");
    case "telefono": return caja(etq, input("tel", ' autocomplete="tel" inputmode="tel"') + (ph || ' placeholder="+34 600 000 000"') + ">");
    case "nombre": return caja(etq, input("text", ' autocomplete="name"') + phR + ">");
    case "numero": return caja(etq, input("text", ' inputmode="decimal"') + phR + ">");
    case "web": return caja(etq, input("text", ' inputmode="url" autocomplete="url"') + (ph || ' placeholder="tuweb.com"') + ">");
    case "fecha": return caja(etq, input("date", "") + ">");
    case "parrafo": return caja(etq, '<textarea id="' + id + '" name="' + name + '"' + req + dsRef + phR + "></textarea>");
    case "desplegable":
      return caja(etq, '<select id="' + id + '" name="' + name + '"' + req + dsRef + '><option value="">' + esc(q.placeholder || "Elige una opción…") + "</option>"
        + (q.options || []).map((o) => '<option value="' + esc(o) + '">' + esc(o) + "</option>").join("") + "</select>");
    case "opcion":
      return caja(grupo, lista("ops", "radiogroup", (q.options || []).map((o, k) => op("radio", o, o, LETRAS[k] || String(k + 1))).join("")));
    case "varias":
      return caja(grupo + '<p class="hv">Puedes elegir varias</p>', lista("ops", "group", (q.options || []).map((o, k) => op("checkbox", o, o, LETRAS[k] || String(k + 1))).join("")));
    case "si_no":
      return caja(grupo, lista("ops sn", "radiogroup", op("radio", "Sí", "Sí", "S") + op("radio", "No", "No", "N")));
    case "escala": {
      let d = "";
      for (let k = 0; k <= 10; k++) d += '<label class="op"><input type="radio" name="' + name + '" value="' + k + '"><span>' + k + "</span></label>";
      return caja(grupo, lista("ops esc", "radiogroup", d));
    }
    case "valoracion": {
      // Del 5 al 1 en el HTML y al revés en pantalla: así «esta y las anteriores» se pinta sólo con CSS.
      let d = "";
      for (let k = 5; k >= 1; k--) d += '<label class="op" title="' + k + ' de 5"><input type="radio" name="' + name + '" value="' + k + '" aria-label="' + k + ' de 5">' + SVG_ESTRELLA + "</label>";
      return caja(grupo, lista("ops est", "radiogroup", d));
    }
    case "archivo":
      // FORM-ARCHIVO-1 · el input no lleva name: los archivos viajan ya subidos, por su id.
      return caja(etq, '<label class="ar"><input type="file" id="' + id + '" multiple accept=".jpg,.jpeg,.png,.heic,.heif,.pdf,image/jpeg,image/png,image/heic,image/heif,application/pdf"' + dsRef + '>'
        + '<span class="arb">' + SVG_CLIP + '<span>Elegir archivos</span></span><span class="arh">Fotos o PDF · hasta ' + MAX_ARCHIVO_MB + ' MB cada uno</span></label><ul class="arl"></ul>');
    case "acepto":
      return caja('<label class="ac"><input type="checkbox" name="' + name + '" value="1"' + dsRef + "><span>" + esc(q.label) + "</span></label>", ds);
    default: return caja(etq, input("text", "") + phR + ">");
  }
}

// Script del cliente: sin plantillas ni dependencias. Valida lo básico (el servidor
// revalida todo), una pregunta por pantalla si el formulario lo pide, y envía por JSON.
// FORMULARIOS-4 · en el modo una a una: Enter avanza (Mayús+Enter, salto de línea en las
// respuestas largas), las letras eligen opción, las flechas de abajo van y vuelven, y cada
// pregunta entra con una transición en el sentido en que se avanza.
const JS = [
  "(function(){var f=document.getElementById('fm');if(!f)return;var t0=Date.now();",
  "var sid=(window.crypto&&crypto.randomUUID)?crypto.randomUUID():String(Math.random()).slice(2)+Date.now();",
  "var qs=[].slice.call(f.querySelectorAll('.q'));",
  // FORMULARIOS-8 · ps = las pantallas: las preguntas con el mismo data-p van juntas.
  "var ps=[];qs.forEach(function(q,k){var p=parseInt(q.getAttribute('data-p'),10);if(isNaN(p))p=k;(ps[p]=ps[p]||[]).push(q)});ps=ps.filter(Boolean);",
  "var uno=f.getAttribute('data-uno')==='1'&&ps.length>1;",
  "function pasoDe(q){for(var k=0;k<ps.length;k++)if(ps[k].indexOf(q)>=0)return k;return 0}",
  "var i=Math.max(0,Math.min(ps.length-1,parseInt(f.getAttribute('data-ini')||'0',10)||0));",
  // FORM-ARBOL-1 · AB[pantalla] = {r:[{q,v,a}],l}; a=-1 termina. sigP(i) = la pantalla que toca
  // tras la i según lo contestado; hist = el camino seguido (para volver atrás por él).
  "var AB=null;try{AB=JSON.parse(f.getAttribute('data-arbol')||'null')}catch(x){}var hist=[];",
  "function qDe(id){for(var k=0;k<qs.length;k++)if(qs[k].getAttribute('data-q')===id)return qs[k];return null}",
  "function sigP(i){var p=AB&&AB[i];if(p){for(var k=0;k<p.r.length;k++){var q=qDe(p.r[k].q);if(q&&val(q)===p.r[k].v)return p.r[k].a}if(p.l!==undefined&&p.l!==null)return p.l}return i+1}",
  "function esUlt(i){var s=sigP(i);return s<0||s>=ps.length}",
  "function camino(){var v={},k=0;while(k>=0&&k<ps.length&&!v[k]){v[k]=1;k=sigP(k)}return v}",
  // En «todas a la vez», se ocultan las preguntas que quedan fuera del camino.
  "function rama(){if(uno||!AB)return;var v=camino();ps.forEach(function(g,k){g.forEach(function(q){q.classList.toggle('oc',!v[k])})})}",
  "var cj=document.getElementById('cj');var bar=document.querySelector('.bar i');var cnt=document.getElementById('cnt');var kh=document.getElementById('kh');",
  "var btn=document.getElementById('env');var atr=document.getElementById('atr');var sig=document.getElementById('sig');var gen=document.getElementById('gen');",
  "var txtEnv=btn.getAttribute('data-txt')||btn.textContent;",
  "var AUTO={opcion:1,si_no:1,escala:1,valoracion:1,desplegable:1};",
  // FORM-ARCHIVO-1 · AR[pregunta] = {l:[{n,id}]}; id vacío = aún subiendo. Se suben al elegirlos.
  "var AR={},MB=" + MAX_ARCHIVO_MB + ";",
  "function arQuita(q,x){var s=AR[q.getAttribute('data-q')];var j=s.l.indexOf(x);if(j>=0)s.l.splice(j,1);arPinta(q)}",
  "function arPinta(q){var s=AR[q.getAttribute('data-q')],ul=q.querySelector('.arl');ul.innerHTML='';s.l.forEach(function(x){var li=document.createElement('li');if(!x.id)li.className='sb';",
  " var sp=document.createElement('span');sp.textContent=x.n+(x.id?'':' · subiendo…');li.appendChild(sp);",
  " if(x.id){var b=document.createElement('button');b.type='button';b.className='arx';b.title='Quitar';b.setAttribute('aria-label','Quitar '+x.n);b.textContent='×';b.addEventListener('click',function(){arQuita(q,x);if(q.classList.contains('mal'))chk(q)});li.appendChild(b)}",
  " ul.appendChild(li)})}",
  "function arSube(q,fi){var k=q.getAttribute('data-q'),s=AR[k]=AR[k]||{l:[]},x={n:fi.name||'archivo',id:''};",
  " if(fi.size>MB*1048576){err(q,'«'+x.n+'» pesa más de '+MB+' MB.');return}",
  " if(s.l.length>=" + MAX_ARCHIVOS_PREGUNTA + "){err(q,'Puedes adjuntar " + MAX_ARCHIVOS_PREGUNTA + " archivos como máximo.');return}",
  " function falla(m){arQuita(q,x);err(q,m)}",
  " s.l.push(x);arPinta(q);var rd=new FileReader();rd.addEventListener('error',function(){falla('No se ha podido leer «'+x.n+'».')});",
  " rd.onload=function(){var b64=String(rd.result).split(',')[1]||'';var u=location.pathname;if(u.slice(-1)!=='/')u+='/';",
  "  fetch(u+'archivo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:x.n,dataB64:b64})})",
  "  .then(function(r){return r.json().catch(function(){return {ok:false}})})",
  "  .then(function(d){if(d&&d.ok){x.id=d.id;x.n=d.nombre||x.n;arPinta(q);if(q.classList.contains('mal'))chk(q)}else falla((d&&d.error)||'No se ha podido subir «'+x.n+'». Vuelve a intentarlo.')})",
  "  .catch(function(){falla('Sin conexión: no se ha podido subir «'+x.n+'».')})};",
  " rd.readAsDataURL(fi)}",
  "function val(q){var t=q.getAttribute('data-t');",
  " if(t==='archivo'){var s=AR[q.getAttribute('data-q')];return s?s.l.filter(function(x){return x.id}).map(function(x){return {id:x.id,n:x.n}}):[]}",
  " if(t==='varias'){return [].slice.call(q.querySelectorAll('input:checked')).map(function(x){return x.value})}",
  " if(t==='opcion'||t==='si_no'||t==='escala'||t==='valoracion'){var c=q.querySelector('input:checked');return c?c.value:''}",
  " if(t==='acepto'){return q.querySelector('input').checked?'1':''}",
  " var e=q.querySelector('input,textarea,select');return e?e.value.trim():''}",
  "function err(q,m){q.classList.toggle('mal',!!m);q.querySelector('.er').textContent=m||''}",
  "function chk(q){var t=q.getAttribute('data-t');var v=val(q);var req=!!q.querySelector('[required]')||!!q.querySelector('.req')||t==='acepto';",
  " if(t==='archivo'){var sa=AR[q.getAttribute('data-q')];if(sa&&sa.l.some(function(x){return !x.id})){err(q,'Espera a que terminen de subirse los archivos.');return false}}",
  " var vacio=Array.isArray(v)?!v.length:!v;if(vacio){if(req){err(q,t==='acepto'?'Tienes que aceptar para continuar.':(t==='varias'||t==='opcion'||t==='si_no'||t==='desplegable')?'Elige una opción para seguir.':'Esta pregunta es obligatoria.');return false}err(q,'');return true}",
  " if(t==='email'&&!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]{2,}$/.test(v)){err(q,'Revisa el correo: parece que le falta algo.');return false}",
  " if(t==='telefono'&&v.replace(/\\D/g,'').length<6){err(q,'Revisa el teléfono: tiene que tener al menos 6 números.');return false}",
  " if(t==='numero'&&!/^-?\\d+([.,]\\d+)?$/.test(v)){err(q,'Aquí va un número.');return false}",
  " if(t==='web'&&!/^(https?:\\/\\/)?[^\\s/.]+(\\.[^\\s/.]+)*\\.[a-z]{2,}(\\/\\S*)?$/i.test(v)){err(q,'Revisa la dirección: algo como tuweb.com.');return false}",
  " err(q,'');return true}",
  "function foco(q){var e=q.querySelector('input:not([type=radio]):not([type=checkbox]),textarea,select');",
  " try{if(e)e.focus({preventScroll:true});else{q.setAttribute('tabindex','-1');q.focus({preventScroll:true})}}catch(x){}",
  " var r=q.getBoundingClientRect();if(r.top<0||r.top>innerHeight*.6)q.scrollIntoView({block:'center'})}",
  "var gira=0,MOV=!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);",
  "function pinta(dir){if(!uno)return;var g=ps[i],q=g[0],yo=++gira;",
  " var viejas=qs.filter(function(x){return g.indexOf(x)<0&&!x.classList.contains('oc')});",
  " function entra(){if(yo!==gira)return;qs.forEach(function(x){x.classList.remove('va','vu','sa','sb');x.classList.toggle('oc',g.indexOf(x)<0)});",
  // Un vídeo que se queda atrás no sigue sonando.
  "  [].slice.call(f.querySelectorAll('.q.oc video')).forEach(function(v){try{v.pause()}catch(x){}});",
  "  if(dir){g.forEach(function(x){void x.offsetWidth;x.classList.add(dir>0?'va':'vu')});foco(q)}}",
  " if(dir&&viejas.length&&MOV){qs.forEach(function(x){x.classList.remove('va','vu')});viejas.forEach(function(x){x.classList.add(dir>0?'sa':'sb')});setTimeout(entra,220)}else entra();",
  " if(bar)bar.style.width=Math.round(i/ps.length*100)+'%';if(cnt)cnt.textContent=(i+1)+' de '+ps.length;",
  " var ult=esUlt(i);btn.textContent=ult?txtEnv:'OK ✓';atr.disabled=!hist.length;sig.disabled=ult;",
  " if(kh)kh.innerHTML=g.some(function(x){return x.getAttribute('data-t')==='parrafo'})?'pulsa <b>Enter ↵</b> · <b>Mayús + Enter</b>, otra línea':'pulsa <b>Enter ↵</b>';",
  "}",
  // FORMULARIOS-8 · se revisan todas las de la pantalla; con varias, el foco va a la primera que falla.
  // Volver a una pantalla ya recorrida (la que falla al enviar): el camino se recorta hasta ella.
  "function irA(k){var j=hist.indexOf(k);if(j>=0)hist.length=j;else if(k!==i)hist=hist.filter(function(x){return x<k});i=k;pinta(-1)}",
  "function chkP(g){var m=null;g.forEach(function(q){if(!chk(q)&&!m)m=q});if(m&&g.length>1)foco(m);return !m}",
  "function avanzar(){gen.textContent='';if(uno&&!esUlt(i)){if(chkP(ps[i])){hist.push(i);i=sigP(i);pinta(1)}return}enviar()}",
  "function empieza(){if(!cj||!cj.classList.contains('bv'))return;cj.classList.remove('bv');pinta(1)}",
  "var emp=document.getElementById('emp');if(emp)emp.addEventListener('click',empieza);",
  "f.addEventListener('change',function(ev){if(ev.target.type==='file'){var qa=ev.target.closest('.q');err(qa,'');[].slice.call(ev.target.files||[]).forEach(function(fi){arSube(qa,fi)});ev.target.value='';return}",
  " var o=ev.target.closest&&ev.target.closest('.ops');if(o){[].slice.call(o.querySelectorAll('.op')).forEach(function(l){l.classList.toggle('on',l.querySelector('input').checked)})}",
  " var q=ev.target.closest&&ev.target.closest('.q');if(!q)return;if(q.classList.contains('mal'))chk(q);rama();",
  // Con árbol, la respuesta puede volver última esta pantalla: el botón se rehace.
  " if(uno&&AB){var u=esUlt(i);btn.textContent=u?txtEnv:'OK ✓';sig.disabled=u}",
  " if(uno&&AUTO[q.getAttribute('data-t')]&&ps[i].length===1&&ps[i][0]===q&&!esUlt(i)&&val(q)&&chk(q)){setTimeout(function(){if(ps[i][0]===q&&!esUlt(i)){hist.push(i);i=sigP(i);pinta(1)}},320)}});",
  // El aviso se revalida al escribir, no al perder el foco: si se vaciara en el `change`
  // que dispara el clic en «Siguiente», el botón subiría bajo el puntero y el clic se perdería.
  "f.addEventListener('input',function(ev){var q=ev.target.closest&&ev.target.closest('.q');if(q&&q.classList.contains('mal'))chk(q)});",
  "atr.addEventListener('click',function(){if(hist.length){gen.textContent='';i=hist.pop();pinta(-1)}});",
  "sig.addEventListener('click',function(){if(!esUlt(i))avanzar()});",
  "document.addEventListener('keydown',function(ev){if(ev.defaultPrevented||ev.isComposing)return;",
  " if(cj&&cj.classList.contains('bv')){if(ev.key==='Enter'){ev.preventDefault();empieza()}return}",
  " if(!uno||btn.disabled)return;var tg=ev.target||{},tn=String(tg.tagName||'').toLowerCase(),ty=String(tg.type||'').toLowerCase();",
  " if(ev.key==='Enter'){if(tn==='button'||tn==='a'||(tn==='textarea'&&ev.shiftKey))return;ev.preventDefault();avanzar();return}",
  " if(tn==='textarea'||tn==='select'||(tn==='input'&&ty!=='radio'&&ty!=='checkbox')||ev.ctrlKey||ev.metaKey||ev.altKey||String(ev.key).length!==1)return;",
  " if(ps[i].length!==1)return;var q=ps[i][0],t=q.getAttribute('data-t'),k=ev.key.toUpperCase(),ins=[].slice.call(q.querySelectorAll('.ops input')),p=-1;",
  " if(t==='opcion'||t==='varias')p=k.charCodeAt(0)-65;else if(t==='si_no')p=k==='S'||k==='Y'?0:k==='N'?1:-1;",
  " else if(t==='escala')p=/^\\d$/.test(k)?+k:-1;else if(t==='valoracion')p=/^[1-5]$/.test(k)?5-k:-1;",
  " if(p<0||p>=ins.length)return;ev.preventDefault();var x=ins[p];x.checked=x.type==='checkbox'?!x.checked:true;x.dispatchEvent(new Event('change',{bubbles:true}))});",
  "f.addEventListener('submit',function(ev){ev.preventDefault();avanzar()});",
  // FORM-ARBOL-1 · sólo se revisan y se envían las preguntas del camino seguido.
  "function enviar(){var v=camino(),en=qs.filter(function(q){return v[pasoDe(q)]}),bien=true,prim=null;en.forEach(function(q){if(!chk(q)){bien=false;prim=prim||q}});",
  " if(!bien){if(uno){irA(pasoDe(prim))}else{var e=prim.querySelector('input,textarea,select');if(e)e.focus()}return}",
  " var a={};en.forEach(function(q){a[q.getAttribute('data-q')]=val(q)});",
  " btn.disabled=true;btn.textContent='Enviando…';",
  " fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({a:a,sid:sid,hp:(f.querySelector('.hp input')||{}).value||'',ms:Date.now()-t0})})",
  " .then(function(r){return r.json().catch(function(){return {ok:false,error:'No hemos podido enviar tus respuestas. Inténtalo de nuevo.'}})})",
  " .then(function(d){if(d&&d.ok){if(d.cita){cita(d);return}if(d.redirect){location.href=d.redirect;return}listo(d.thanks,'¡Listo!');return}",
  "  btn.disabled=false;btn.textContent=uno&&i<ps.length-1?'OK ✓':txtEnv;var m=(d&&d.error)||'No hemos podido enviar tus respuestas. Inténtalo de nuevo.';",
  "  var q=d&&d.campo?f.querySelector('.q[data-q=\"'+d.campo+'\"]'):null;if(q){err(q,m);if(uno)irA(pasoDe(q))}else{gen.textContent=m}})",
  " .catch(function(){btn.disabled=false;btn.textContent=txtEnv;gen.textContent='Sin conexión. Revisa tu internet y vuelve a intentarlo.'})}",
  "function listo(t,h){document.body.classList.remove('ci');",
  " cj.innerHTML='<div class=\"ok\"><div class=\"ic\"><svg width=\"28\" height=\"28\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 6 9 17l-5-5\"/></svg></div><h1></h1><p></p></div>';",
  " cj.querySelector('h1').textContent=h;cj.querySelector('p').textContent=t||'';window.scrollTo(0,0)}",
  // FORM-CITA-1 · tras enviar, el calendario de la web. Al reservar, la web vuelve a
  // /f/<slug>/reservada DENTRO del marco; esa página (mismo origen) avisa aquí y entonces
  // va la página de después o el «gracias».
  "function cita(d){document.body.classList.add('ci');",
  " cj.innerHTML='<div class=\"ct\"><h1>Elige día y hora</h1><p class=\"intro\">Último paso: reserva tu cita en el calendario.</p><iframe class=\"cal\" title=\"Calendario de reservas\" allow=\"payment\"></iframe></div>';",
  " cj.querySelector('iframe').src=d.cita;window.scrollTo(0,0);",
  " window.addEventListener('message',function(e){if(e.origin!==location.origin||!e.data||e.data.bsCita!=='reservada')return;",
  "  if(d.redirect){location.href=d.redirect;return}listo(d.thanks,'¡Cita reservada!')})}",
  "rama();pinta()})();",
].join("\n");

/**
 * HTML de la página pública del formulario. `negocio` = nombre del workspace (encabezado discreto).
 * FORMULARIOS-4 · `inicio` (sólo la vista previa del panel): abre directamente en esa pregunta,
 * sin la bienvenida, para ver en vivo la que se está editando.
 */
// FORMULARIOS-5 · «una por pantalla» es lo normal. El interruptor vivía escondido en Diseño y
// apagado, así que un oneByOne:false guardado antes de FORMULARIOS-5 no es una elección: sólo
// se respeta «todas a la vez» cuando se eligió en el editor nuevo (modoElegido).
export function unaPorPantalla(o: FormRec["opts"]): boolean {
  return o.modoElegido ? !!o.oneByOne : true;
}

export function paginaFormulario(form: FormRec, negocio: string, nonce = "", inicio = -1): string {
  const { css: cssDiseno, fuentes } = cssDelDiseno(form);
  const arriba = form.opts.htmlTop ? '<div class="hx">' + limpiarHtmlFormulario(form.opts.htmlTop) + "</div>" : "";
  const abajo = form.opts.htmlBottom ? '<div class="hx">' + limpiarHtmlFormulario(form.opts.htmlBottom) + "</div>" : "";
  const boton = String(form.opts.button || "").trim().slice(0, 40) || "Enviar";
  // FORMULARIOS-8 · pasos: en una por pantalla, las preguntas «junto a la anterior» comparten pantalla.
  const pasoDe: number[] = [];
  form.questions.forEach((q, k) => pasoDe.push(k === 0 ? 0 : pasoDe[k - 1] + (q.conAnterior ? 0 : 1)));
  const pasos = pasoDe.length ? pasoDe[pasoDe.length - 1] + 1 : 0;
  const uno = unaPorPantalla(form.opts) && pasos > 1;
  // «inicio» es la pregunta que se edita; la vista previa abre en su pantalla.
  const ini = uno && inicio >= 0 ? pasoDe[Math.min(Math.floor(inicio), form.questions.length - 1)] : -1;
  // FORM-ARBOL-1 · el árbol viaja a la página por pantallas (en «todas a la vez», una por pregunta).
  const arbol = arbolFormulario(form.questions, pasosFormulario(form.questions, uno));
  const conArbol = arbol.some((p) => p.r.length || p.l !== undefined);
  const propia = form.opts.layout === "html" && !!String(form.opts.pageHtml || "").trim();
  const bienvenida = uno && !!form.opts.welcome && !propia && form.status === "active" && ini < 0;
  const n = pasos;
  const tj = uno && tarjetaEnUno(form);
  const preguntas = (uno ? '<div class="pr" aria-live="polite"><span id="cnt">' + (Math.max(ini, 0) + 1) + " de " + n + '</span></div><div class="bar" aria-hidden="true"><i></i></div>' : "")
    + '<form id="fm" novalidate data-uno="' + (uno ? "1" : "0") + '"' + (ini >= 0 ? ' data-ini="' + ini + '"' : "") + (conArbol ? " data-arbol=\"" + esc(JSON.stringify(arbol)) + "\"" : "") + ">"
    + '<div class="hp" aria-hidden="true"><label>No rellenes esto<input type="text" name="web" tabindex="-1" autocomplete="off"></label></div>'
    + form.questions.map((q, k) => campoHtml(q, uno ? pasoDe[k] : k, uno && (pasoDe[k - 1] === pasoDe[k] || pasoDe[k + 1] === pasoDe[k]), !uno || k === 0 || pasoDe[k - 1] !== pasoDe[k])).join("")
    + '<p class="gen" id="gen" role="alert"></p>'
    + '<div class="acc"><button type="submit" class="btn" id="env" data-txt="' + esc(boton) + '">' + esc(boton) + "</button>"
    + '<span class="kh" id="kh">pulsa <b>Enter ↵</b></span>'
    + '<span class="nav"><button type="button" class="btn sec" id="atr" title="Pregunta anterior" aria-label="Pregunta anterior">' + SVG_ARRIBA + "</button>"
    + '<button type="button" class="btn sec" id="sig" title="Pregunta siguiente" aria-label="Pregunta siguiente">' + SVG_ABAJO + "</button></span></div>"
    + "</form>";
  const script = form.status === "active" ? "<script" + (nonce ? ' nonce="' + esc(nonce) + '"' : "") + ">" + JS + "</script>" : "";
  const cabecera = "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<title>" + esc(form.title) + "</title><meta name=\"robots\" content=\"noindex\">"
    + '<meta property="og:title" content="' + esc(form.title) + '">' + (form.intro ? '<meta property="og:description" content="' + esc(form.intro.slice(0, 200)) + '">' : "");
  // FORMULARIOS-2 · página entera de HTML propio: las preguntas van donde diga {{formulario}}
  // (al final si no lo dice). El diseño elegido sigue dando letra y colores a los campos.
  if (propia) {
    const { cabeza, cuerpo: pag } = partesPaginaHtml(limpiarPaginaHtml(form.opts.pageHtml));
    const bloque = '<div class="fx" id="cj">' + (form.status !== "active" ? '<p class="intro">Este formulario ya no admite respuestas. Gracias por tu interés.</p>' : preguntas) + "</div>";
    const k = pag.indexOf(MARCA_FORMULARIO);
    const html = k < 0 ? pag + bloque : pag.slice(0, k) + bloque + pag.slice(k + MARCA_FORMULARIO.length).split(MARCA_FORMULARIO).join("");
    return cabecera + fuentes + "<style>" + CSS + cssDiseno + CSS_PAGINA_PROPIA + (form.opts.css ? "\n" + limpiarCssFormulario(form.opts.css) : "") + "</style>" + cabeza
      + "</head><body class=\"t-" + esc(temaFormulario(form.opts.theme).id) + " propia\">" + html + script + "</body></html>";
  }
  const titulo = "<h1>" + esc(form.title) + "</h1>" + (form.intro ? '<p class="intro">' + esc(form.intro) + "</p>" : "");
  const cuerpo = form.status !== "active"
    ? arriba + '<h1>' + esc(form.title) + '</h1><p class="intro">Este formulario ya no admite respuestas. Gracias por tu interés.</p>'
    : bienvenida
      ? arriba + '<section class="wl" id="wl">' + titulo + '<div class="wla"><button type="button" class="btn" id="emp">Empezar</button><span class="kh">pulsa <b>Enter ↵</b></span></div></section>' + preguntas + abajo
      : arriba + titulo + preguntas + abajo;
  return cabecera + fuentes + "<style>" + CSS + cssDiseno + (form.opts.css ? "\n" + limpiarCssFormulario(form.opts.css) : "") + "</style></head><body class=\"t-" + esc(temaFormulario(form.opts.theme).id) + (uno && form.status === "active" ? " uno" + (tj ? " tj" : "") : "") + "\"><div class=\"w\">"
    + (uno && form.status === "active"
      ? '<p class="neg">' + esc(negocio) + (negocio ? '<span class="sp" aria-hidden="true">·</span>' : "") + '<span class="nt">' + esc(form.title) + "</span></p>"
      : negocio ? '<p class="neg">' + esc(negocio) + "</p>" : "")
    + '<div class="c' + (bienvenida ? " bv" : "") + '" id="cj">' + cuerpo + "</div>"
    + "</div>" + script + "</body></html>";
}

/**
 * FORM-CITA-1 · /f/<slug>/reservada: adonde devuelve la web a la persona al reservar
 * (se pega en el calendario como «dirección después de reservar»). Lo normal es que
 * cargue DENTRO del marco del formulario: avisa a la página de arriba (mismo origen) y
 * ésa sigue. Si la web la abre a pantalla completa, va ella misma a la página de
 * después; sin página de después, se queda con el «gracias».
 */
export function paginaReservada(form: FormRec, negocio: string, nonce: string): string {
  const { css: cssDiseno, fuentes } = cssDelDiseno(form);
  const redirect = /^https:\/\/[^\s"'<>]+$/i.test(String(form.opts.redirect || "")) ? String(form.opts.redirect) : "";
  const thanks = String(form.opts.thanks || "").trim() || "¡Gracias! Te hemos guardado la cita.";
  const js = "(function(){var R=" + JSON.stringify(redirect).replace(/</g, "\\u003c") + ";"
    + "try{if(window.parent!==window&&parent.location.origin===location.origin){parent.postMessage({bsCita:'reservada'},location.origin);return}}catch(e){}"
    + "if(R)location.replace(R)})();";
  return "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<title>Cita reservada</title><meta name=\"robots\" content=\"noindex\">" + fuentes + "<style>" + CSS + cssDiseno + "</style></head>"
    + "<body class=\"t-" + esc(temaFormulario(form.opts.theme).id) + "\"><div class=\"w\">" + (negocio ? '<p class="neg">' + esc(negocio) + "</p>" : "")
    + '<div class="c"><div class="ok"><div class="ic"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>'
    + "<h1>¡Cita reservada!</h1><p>" + esc(thanks) + "</p></div></div></div>"
    + "<script nonce=\"" + esc(nonce) + "\">" + js + "</script></body></html>";
}

export function paginaNoEncontrada(): string {
  return "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Formulario no disponible</title><meta name=\"robots\" content=\"noindex\"><style>" + CSS + "</style></head>"
    + '<body><div class="w"><div class="c"><h1>Formulario no disponible</h1><p class="intro">La dirección no es correcta o el formulario se ha retirado.</p></div></div></body></html>';
}

export type { FormResponseRec };
