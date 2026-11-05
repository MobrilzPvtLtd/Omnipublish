/**
 * Sustitución de variables `{{...}}` en mensajes salientes.
 *
 * Vars soportadas (sin distinguir mayúsculas):
 *   {{name}} {{firstname}} {{lastname}} {{phone}} {{email}}
 *   {{stage}} {{source}} {{score}} {{bot}}
 *   {{tag.NAME}}    →  comprueba si el contacto tiene tag NAME (Sí/No)
 *   {{field.KEY}}   →  valor del custom field KEY
 *   {{utm_source}} {{utm_medium}} {{utm_campaign}} {{utm_content}}
 *   {{date}} {{time}} {{day}} {{month}} {{year}}
 *
 * Con valor por defecto: `{{name|amigo}}` cae a "amigo" si name está vacío.
 *
 * `vars.strict_mode=on` (settings): si la var no tiene fallback ni resuelve,
 * se rechaza el mensaje (caller debe gestionar el throw).
 */
import type { Contact } from "./db.js";
import { get as getSetting } from "./settings.js";

export interface SubstituteOptions {
  /** Variables extra (override / añade sobre el contacto). */
  extra?: Record<string, string>;
  /** Marca todas las vars no resueltas. Cuando strict=on, lanza error. */
  strict?: boolean;
}

const RE_VAR = /\{\{\s*([a-zA-Z0-9_.-]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

function pad(n: number): string { return String(n).padStart(2, "0"); }

function contextToVars(c: Contact | null | undefined, extra: Record<string, string> = {}): Record<string, (key: string) => string> {
  const now = new Date();
  const v: Record<string, () => string> = {
    name: () => c?.name?.trim() || "",
    firstname: () => (c?.name?.trim() || "").split(/\s+/)[0] || "",
    lastname: () => {
      const parts = (c?.name?.trim() || "").split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(" ") : "";
    },
    phone: () => c?.phone || "",
    email: () => c?.email || "",
    stage: () => c?.stage || "",
    source: () => c?.source || "",
    score: () => String(c?.score ?? 0),
    bot: () => c?.bot_id || "",
    utm_source: () => c?.utm_source || "",
    utm_medium: () => c?.utm_medium || "",
    utm_campaign: () => c?.utm_campaign || "",
    utm_content: () => c?.utm_content || "",
    date: () => `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`,
    time: () => `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    day: () => ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"][now.getDay()],
    month: () => ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"][now.getMonth()],
    year: () => String(now.getFullYear()),
  };
  // ALIAS EN ESPAÑOL. El panel lleva desde siempre diciendo «usa {{nombre}} para
  // personalizar» (Difusión, plantillas del catálogo, el botón «insertar variable»…),
  // pero el motor solo entendía {{name}}: cada difusión personalizada salía con el
  // hueco VACÍO ("Hola  👋"). Se añaden como alias en vez de cambiar los textos del
  // panel porque así arreglan también los borradores YA guardados, sin tocarlos.
  v.nombre = v.name;
  v.apellido = v.lastname;
  v.telefono = v.phone;
  v.correo = v.email;
  v.etapa = v.stage;
  v.origen = v.source;
  v.fecha = v.date;
  v.hora = v.time;
  v.dia = v.day;
  v.mes = v.month;
  v.anio = v.year;
  // Convertimos a funciones que también respetan claves prefijadas (tag.X, field.X)
  return {
    simple: (key: string) => v[key.toLowerCase()] ? v[key.toLowerCase()]() : "",
    tag: (name: string) => (c?.tags || []).some((t) => t.toLowerCase() === name.toLowerCase()) ? "Sí" : "",
    field: (name: string) => c?.fields?.[name] ?? "",
    extra: (key: string) => extra[key] ?? extra[key.toLowerCase()] ?? "",
  } as unknown as Record<string, (key: string) => string>;
}

export function substituteVars(text: string, contact: Contact | null | undefined, opts: SubstituteOptions = {}): string {
  if (!text || text.indexOf("{{") < 0) return text;
  const extra = opts.extra ?? {};
  const strict = opts.strict ?? (getSetting("vars.strict_mode") === "on");
  const lookup = contextToVars(contact, extra);
  const unresolved: string[] = [];

  const out = text.replace(RE_VAR, (_, rawKey: string, fallback: string | undefined) => {
    let value = "";
    const k = rawKey.trim();
    if (k.toLowerCase().startsWith("tag.")) value = lookup.tag(k.slice(4));
    else if (k.toLowerCase().startsWith("field.")) value = lookup.field(k.slice(6));
    else value = lookup.extra(k) || lookup.simple(k);

    if (!value && fallback !== undefined) value = fallback;
    if (!value) unresolved.push(k);
    return value;
  });

  if (strict && unresolved.length) {
    throw new Error(`Variables sin resolver y sin fallback: ${[...new Set(unresolved)].join(", ")}`);
  }
  return out;
}

/** Extrae las variables presentes en un texto (para validación / preview). */
export function extractVars(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const m of text.matchAll(RE_VAR)) found.add(m[1].trim());
  return [...found];
}

/** Sustituye vars con un sample contact para mostrar preview en el panel. */
export function previewSubstitute(text: string, sample: Partial<Contact> = {}): string {
  const fake = {
    phone: "+34 600 123 456",
    name: "Ana García",
    email: "ana@empresa.com",
    tags: ["vip", "demo-pedida"],
    fields: { ciudad: "Madrid", interes: "Pro" },
    bot_id: "ventas",
    stage: "Propuesta",
    human: false,
    source: "instagram",
    utm_source: "ig-reel",
    utm_medium: "social",
    utm_campaign: "lanzamiento",
    utm_content: "",
    notes: "",
    next_action_at: null,
    next_action_label: "",
    next_action_account: "",
    next_action_by: "",
    score: 72,
    systemeio_contact_id: "",
    last_inbound: Date.now(),
    created_at: Date.now() - 7 * 24 * 60 * 60 * 1000,
    updated_at: Date.now(),
    ...sample,
  } as Contact;
  return substituteVars(text, fake, { strict: false });
}
