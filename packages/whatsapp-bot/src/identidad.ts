/**
 * IDENTIDAD-COMUN-1 (MET-AUTO-09) · la regla común para seguir a la MISMA persona entre canales.
 *
 * Todas las pestañas de Métricas (Leads, Origen, Automatización), el Resumen y las exportaciones
 * cuentan personas, recorridos y hechos con ESTA regla, no con una distinta por pantalla. Es un
 * módulo puro (sin base de datos): las consultas que lo alimentan viven en db.ts
 * (`dbFichasEnFlujos`, `dbVentasWebEnlazadas`), la lectura agregada en analytics.ts
 * (`segAutomation` → `cobertura`) y la tarjeta en admin.ts, todo con la etiqueta IDENTIDAD-COMUN-1.
 *
 * ── Qué identifica a una persona (identificadores ACREDITADOS, siempre dentro del mismo negocio) ──
 *   tel:<dígitos>        el teléfono de WhatsApp, el de un enlace de pago o el que la persona dio
 *                        en un formulario. Normalizado: sólo dígitos, sin ceros delante y México
 *                        «521 + 10» → «52 + 10» (MX-521-1), para que el móvil, la Cloud API y los
 *                        formularios hablen del mismo número.
 *   email:<correo>       el correo con el que se registró en una web, pagó en un checkout, reservó
 *                        o rellenó un formulario (FORMULARIO-A-LEAD-1 lo pone en la ficha). En
 *                        minúsculas.
 *   ig:<id> / fb:<id>    la cuenta con la que escribió o comentó por Instagram o Facebook: el id que
 *                        da Meta para esa persona EN ESA cuenta del negocio (la ficha lo guarda en
 *                        `phone` y la cuenta en `channel_account`). Dos cuentas del negocio dan dos
 *                        ids distintos para la misma persona: entre ellas no hay unión.
 *   sio:<cuenta>:<id>    el contacto de systeme.io / leadmatch-lab enlazado a la ficha.
 *
 * ── Qué une dos canales (y deja seguir a la persona de uno al otro) ──
 *   · el MISMO teléfono: WhatsApp ↔ formulario ↔ enlace de pago ↔ visita con marca `lmc_` (la
 *     marca la resuelve `app_visit_refs` al teléfono, EMBUDO-PAGINAS-1) ↔ compra del panel;
 *   · el MISMO correo: web / systeme.io (registro, checkout, reserva) ↔ ficha ↔ formulario;
 *   · la referencia de systeme.io (`sio`) entre la ficha y lo que pasa en esa cuenta;
 *   · la cuenta social (`ig` / `fb`) entre comentarios, mensajes privados y flujos de esa cuenta.
 *   NO unen: el nombre, la foto, la ciudad, la coincidencia de horas, la IP sola, ni un teléfono
 *   que escribió el buscador de leads (`fields.telefono` sin formulario) y la persona no confirmó.
 *   Instagram / Facebook ↔ WhatsApp / web sólo se unen cuando la persona dejó su teléfono o su
 *   correo (en un formulario, al reservar o al pagar). Si no, el tramo queda como
 *   «No podemos seguir este tramo»: nunca una flecha verificada falsa.
 *
 * ── Qué no se cruza nunca ── dos negocios (workspaces). Las dos cuentas de systeme.io de un mismo
 *   negocio (p. ej. ingenierobinario y leadmatch-lab) sí: comparten tenant y el correo es la unión.
 *
 * ── Un hecho se cuenta UNA vez ── compra, reserva, comentario, mensaje, registro, clic o visita
 *   tienen una clave (`claveDeHecho`) y se cuentan una vez aunque lleguen por varias vías o los
 *   referencien varios enlaces: una reserva confirmada desde tres enlaces sigue siendo UNA reserva, y
 *   se relaciona con una persona sólo si comparte con ella un identificador acreditado.
 */

/** Canal por el que pasa una persona en un recorrido. */
export type Canal = "whatsapp" | "instagram" | "facebook" | "web" | "correo" | "formulario" | "panel" | "";
/** Qué dato acredita la unión de dos tramos. "enlace" = teléfono resuelto desde una marca lmc_ o un `ref=` de pago. */
export type Union = "telefono" | "correo" | "cuenta-social" | "referencia" | "enlace" | "";

/** Lo que una ficha (app_contacts) o un toque necesita para identificarse. Todo opcional: lo que falte no acredita. */
export interface FichaIdentidad {
  phone?: string | null;
  email?: string | null;
  /** 'wa:<phoneNumberId>' | 'ig:<igId>' | 'fb:<pageId>' | '' */
  channel_account?: string | null;
  /** 'whatsapp' | 'instagram' | 'facebook' | 'panel' | 'systemeio' | 'leadfinder' | 'import' | ... */
  source?: string | null;
  systemeio_contact_id?: string | number | null;
  systemeio_account?: string | null;
  /** Campos libres de la ficha: `telefono` (formulario o buscador de leads), `formulario`, `typeform_formulario`. */
  fields?: Record<string, unknown> | null;
  created_at?: number | string | Date | null;
}

export const MENSAJE_HUECO = "No podemos seguir este tramo";

/** Teléfono acreditable: sólo dígitos, sin ceros delante, México 521→52, entre 8 y 15 cifras. "" si no lo es (p. ej. el pseudo-teléfono `email:…`). */
export function normalizarTelefono(s: unknown): string {
  const raw = String(s ?? "").trim();
  if (!raw || /^email:/i.test(raw)) return "";
  let d = raw.replace(/\D+/g, "").replace(/^0+/, "");
  if (d.length === 13 && d.startsWith("521")) d = "52" + d.slice(3); // MX-521-1
  return d.length >= 8 && d.length <= 15 ? d : "";
}

/** Correo acreditable, en minúsculas. "" si no parece un correo. */
export function normalizarEmail(e: unknown): string {
  const s = String(e ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

function cuentaSocialDe(f: FichaIdentidad): "ig" | "fb" | "" {
  const ca = String(f.channel_account ?? "").toLowerCase();
  if (ca.startsWith("ig:")) return "ig";
  if (ca.startsWith("fb:")) return "fb";
  const src = String(f.source ?? "").toLowerCase();
  if (src === "instagram") return "ig";
  if (src === "facebook") return "fb";
  return "";
}

/** Canal en el que vive la identidad principal de la ficha: por dónde nos escribió o se dio de alta. */
export function canalDeFicha(f: FichaIdentidad): Canal {
  const soc = cuentaSocialDe(f);
  if (soc === "ig") return "instagram";
  if (soc === "fb") return "facebook";
  if (normalizarTelefono(f.phone)) return "whatsapp";
  if (normalizarEmail(f.email) || normalizarEmail(String(f.phone ?? "").replace(/^email:/i, ""))) return "correo";
  return "";
}

/** Clave principal de la persona: `ig:<id>` | `fb:<id>` | `tel:<dígitos>` | `email:<correo>` | "" si la ficha no identifica a nadie. */
export function claveDePersona(f: FichaIdentidad): string {
  const id = String(f.phone ?? "").trim();
  const soc = cuentaSocialDe(f);
  if (soc && id && !/^email:/i.test(id)) return soc + ":" + id;
  const tel = normalizarTelefono(id);
  if (tel) return "tel:" + tel;
  const em = normalizarEmail(f.email) || normalizarEmail(id.replace(/^email:/i, ""));
  return em ? "email:" + em : "";
}

/** Un teléfono apuntado en `fields.telefono` sólo acredita si lo dio la persona en un formulario (FORMULARIO-A-LEAD): el del buscador de leads, no. */
function telefonoDeFormulario(f: FichaIdentidad): string {
  const fl = f.fields;
  if (!fl || typeof fl !== "object") return "";
  const dado = String(fl.formulario ?? "").trim() || String(fl.typeform_formulario ?? "").trim();
  return dado ? normalizarTelefono(fl.telefono) : "";
}

/** Todos los identificadores acreditados de una ficha (sin repetir). Con ellos se funden fichas y se unen tramos. */
export function identificadoresDe(f: FichaIdentidad): string[] {
  const out = new Set<string>();
  const clave = claveDePersona(f);
  if (clave) out.add(clave);
  const tel = normalizarTelefono(f.phone);
  if (tel) out.add("tel:" + tel);
  const em = normalizarEmail(f.email);
  if (em) out.add("email:" + em);
  const telForm = telefonoDeFormulario(f);
  if (telForm) out.add("tel:" + telForm);
  const sio = String(f.systemeio_contact_id ?? "").trim();
  if (sio && sio !== "0") out.add("sio:" + String(f.systemeio_account ?? "").trim() + ":" + sio);
  return [...out];
}

/** Qué clase de unión aporta un identificador. */
export function tipoDeIdentificador(id: string): Union {
  if (id.startsWith("tel:")) return "telefono";
  if (id.startsWith("email:")) return "correo";
  if (id.startsWith("ig:") || id.startsWith("fb:")) return "cuenta-social";
  if (id.startsWith("sio:")) return "referencia";
  return "";
}

/** Canales en los que un conjunto de identificadores deja reconocer a la persona. */
export function canalesDe(identificadores: string[]): Canal[] {
  const out = new Set<Canal>();
  for (const id of identificadores) {
    if (id.startsWith("tel:")) out.add("whatsapp");
    else if (id.startsWith("email:") || id.startsWith("sio:")) out.add("web");
    else if (id.startsWith("ig:")) out.add("instagram");
    else if (id.startsWith("fb:")) out.add("facebook");
  }
  return [...out];
}

function altaDe(f: FichaIdentidad): number {
  const v = f.created_at;
  if (v == null || v === "") return 0;
  const n = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)) || Number(v) || 0;
  return n > 0 ? n : 0;
}

export interface Persona<T extends FichaIdentidad = FichaIdentidad> {
  /** Clave de la ficha más antigua del grupo (la canónica). */
  clave: string;
  /** Fichas fundidas, la canónica primero. */
  fichas: T[];
  identificadores: string[];
  /** Canales en los que podemos reconocerla. */
  canales: Canal[];
  /** Lo más antiguo que sabemos de ella (epoch ms), o 0 si ninguna ficha trae fecha. */
  alta: number;
}

/**
 * Funde en personas las fichas que comparten algún identificador acreditado (transitivamente: una
 * ficha de WhatsApp con correo y un registro web con ese correo y otro teléfono son UNA persona).
 * La canónica es la de alta más antigua. Dos fichas sin ningún identificador en común siguen siendo
 * dos personas aunque se llamen igual.
 */
export function fundirPersonas<T extends FichaIdentidad>(fichas: T[]): Persona<T>[] {
  const padre = fichas.map((_, i) => i);
  const raiz = (i: number): number => { while (padre[i] !== i) { padre[i] = padre[padre[i]]; i = padre[i]; } return i; };
  const ids = fichas.map(identificadoresDe);
  const dueño = new Map<string, number>();
  ids.forEach((lista, i) => {
    for (const id of lista) {
      const j = dueño.get(id);
      if (j == null) dueño.set(id, i);
      else { const ri = raiz(i), rj = raiz(j); if (ri !== rj) padre[Math.max(ri, rj)] = Math.min(ri, rj); }
    }
  });
  const grupos = new Map<number, number[]>();
  fichas.forEach((_, i) => { const r = raiz(i); const g = grupos.get(r); if (g) g.push(i); else grupos.set(r, [i]); });
  const out: Persona<T>[] = [];
  for (const idx of grupos.values()) {
    idx.sort((a, b) => (altaDe(fichas[a]) || Infinity) - (altaDe(fichas[b]) || Infinity) || a - b);
    const todos = new Set<string>();
    for (const i of idx) for (const id of ids[i]) todos.add(id);
    const identificadores = [...todos];
    const alta = idx.map((i) => altaDe(fichas[i])).filter((n) => n > 0);
    out.push({
      clave: idx.map((i) => claveDePersona(fichas[i])).find((k) => k) || "",
      fichas: idx.map((i) => fichas[i]),
      identificadores,
      canales: canalesDe(identificadores),
      alta: alta.length ? Math.min(...alta) : 0,
    });
  }
  return out;
}

/** Un hecho que se cuenta una vez. Lo que falte deja la clave en "": ese hecho se cuenta aparte, nunca como duplicado ni como único. */
export interface Hecho {
  tipo: "compra" | "reserva" | "comentario" | "mensaje" | "registro" | "formulario" | "clic" | "visita";
  /** compra: la referencia COMPRAS-CONTACTO-1 ('panel:<id>' | 'web:<cuenta>:<tx>') o el id; el resto: el id que da la fuente. */
  id?: string | number | null;
  /** compra / reserva / registro: la cuenta de systeme.io; comentario: 'instagram' | 'facebook'. */
  cuenta?: string | null;
  email?: string | null;
  phone?: string | null;
  /** clic: el token del enlace. visita: el visitante (cookie) y la ruta. */
  token?: string | null;
  path?: string | null;
  cuando?: number | null;
  /** reserva: el momento de la cita. Mismo correo y misma cita = la misma reserva aunque llegue por varios enlaces. */
  cita?: number | null;
}

const minuto = (ms: unknown): string => { const n = Number(ms); return n > 0 ? String(Math.floor(n / 60000)) : ""; };
const limpio = (s: unknown): string => String(s ?? "").trim();

/**
 * Clave única de un hecho, alineada con las que ya usa el código para no contar dos veces:
 * `comentario:instagram:<id>` / `comentario:facebook:<id>` (dbClaimOnce), `_wa_msg:<wamid>`
 * (WAMID-UNA-VEZ-1), `compra:panel:<id>` / `compra:web:<cuenta>:<tx>` (COMPRAS-CONTACTO-1).
 */
export function claveDeHecho(h: Hecho): string {
  const id = limpio(h.id);
  const cuenta = limpio(h.cuenta).toLowerCase();
  const em = normalizarEmail(h.email);
  const tel = normalizarTelefono(h.phone);
  const min = minuto(h.cuando);
  switch (h.tipo) {
    case "compra":
      if (/^(panel|web):/.test(id)) return "compra:" + id;
      if (id && cuenta) return "compra:web:" + cuenta + ":" + id;
      return id ? "compra:panel:" + id : "";
    case "reserva":
      // MET-AUTO-09-FIN · la misma persona (correo acreditado) en la misma cita es UNA reserva,
      // aunque la agenda le dé un id distinto por cada enlace desde el que la confirmó.
      if (em && minuto(h.cita)) return "reserva:" + em + ":cita:" + minuto(h.cita);
      if (id) return "reserva:" + cuenta + ":" + id;
      return em && min ? "reserva:" + em + ":" + min : "";
    case "comentario":
      return id && (cuenta === "instagram" || cuenta === "facebook") ? "comentario:" + cuenta + ":" + id : "";
    case "mensaje":
      return id ? "_wa_msg:" + id : "";
    case "registro":
      if (id && id !== "0") return "registro:" + cuenta + ":" + id;
      return em && min ? "registro:" + em + ":" + min : "";
    case "formulario":
      if (id) return "formulario:" + id;
      return (em || tel) && min ? "formulario:" + (em || tel) + ":" + min : "";
    case "clic":
      return limpio(h.token) && min ? "clic:" + limpio(h.token) + ":" + tel + ":" + min : "";
    case "visita":
      return limpio(h.token) && min ? "visita:" + limpio(h.token) + ":" + limpio(h.path) + ":" + min : "";
    default:
      return "";
  }
}

/** Quita los hechos repetidos (misma clave). Los que no tienen clave se devuelven aparte, sin contar. */
export function hechosUnaVez<T extends Hecho>(hechos: T[]): { unicos: T[]; sinClave: T[]; repetidos: number } {
  const vistos = new Set<string>();
  const unicos: T[] = [], sinClave: T[] = [];
  let repetidos = 0;
  for (const h of hechos) {
    const k = claveDeHecho(h);
    if (!k) { sinClave.push(h); continue; }
    if (vistos.has(k)) { repetidos++; continue; }
    vistos.add(k);
    unicos.push(h);
  }
  return { unicos, sinClave, repetidos };
}

/** Un paso del recorrido de una persona: por qué canal pasó y con qué datos la vimos ahí. */
export interface Toque extends FichaIdentidad {
  canal: Canal;
  cuando?: number | null;
  /** El teléfono llegó resuelto desde una marca `lmc_` o un `ref=` de pago (EMBUDO-PAGINAS-1): la unión se declara «por enlace». */
  porEnlace?: boolean;
}

export interface Tramo {
  de: Canal;
  a: Canal;
  seguible: boolean;
  por: Union;
  /** "" si es seguible; si no, «No podemos seguir este tramo: …» con el motivo. */
  motivo: string;
}

export function etiquetaCanal(c: Canal): string {
  switch (c) {
    case "whatsapp": return "WhatsApp";
    case "instagram": return "Instagram";
    case "facebook": return "Facebook";
    case "web": return "la web";
    case "correo": return "el correo";
    case "formulario": return "el formulario";
    case "panel": return "el panel";
    default: return "un canal desconocido";
  }
}

function motivoDeHueco(a: Toque, b: Toque): string {
  const sa = cuentaSocialDe(a), sb = cuentaSocialDe(b);
  if (sa && sb) return "son cuentas distintas de la persona y no dejó un teléfono ni un correo que las una.";
  if (sa || sb) {
    const red = etiquetaCanal(sa ? a.canal : b.canal);
    return "la persona no dejó su teléfono ni su correo en " + red + ".";
  }
  const telA = !!normalizarTelefono(a.phone) || !!telefonoDeFormulario(a), telB = !!normalizarTelefono(b.phone) || !!telefonoDeFormulario(b);
  const emA = !!normalizarEmail(a.email), emB = !!normalizarEmail(b.email);
  if (telA && !emA && emB && !telB) return "no tenemos el correo de su ficha de " + etiquetaCanal(a.canal) + " ni el teléfono de su paso por " + etiquetaCanal(b.canal) + ".";
  if (emA && !telA && telB && !emB) return "no tenemos el teléfono de su paso por " + etiquetaCanal(a.canal) + " ni el correo de su ficha de " + etiquetaCanal(b.canal) + ".";
  return "no hay un dato acreditado (teléfono, correo, cuenta o referencia) que una los dos pasos.";
}

/** Qué une dos toques: el identificador acreditado que comparten (teléfono > correo > cuenta social > referencia), o nada. */
export function unionEntre(a: Toque, b: Toque): { por: Union; motivo: string } {
  const ia = new Set(identificadoresDe(a));
  const comunes = identificadoresDe(b).filter((x) => ia.has(x));
  const orden: Union[] = ["telefono", "correo", "cuenta-social", "referencia"];
  for (const u of orden) {
    if (comunes.some((x) => tipoDeIdentificador(x) === u)) return { por: u === "telefono" && (a.porEnlace || b.porEnlace) ? "enlace" : u, motivo: "" };
  }
  return { por: "", motivo: MENSAJE_HUECO + ": " + motivoDeHueco(a, b) };
}

/** Los tramos de un recorrido (toques en orden de tiempo si lo traen), cada uno seguible o con su hueco explicado. */
export function tramos(toques: Toque[]): Tramo[] {
  const lista = toques.slice();
  if (lista.every((t) => Number(t.cuando) > 0)) lista.sort((x, y) => Number(x.cuando) - Number(y.cuando));
  const out: Tramo[] = [];
  for (let i = 1; i < lista.length; i++) {
    const u = unionEntre(lista[i - 1], lista[i]);
    out.push({ de: lista[i - 1].canal, a: lista[i].canal, seguible: !!u.por, por: u.por, motivo: u.motivo });
  }
  return out;
}

export interface Cobertura {
  total: number;
  seguibles: number;
  huecos: Tramo[];
  /** true si no queda ningún tramo sin seguir (un recorrido de un solo toque está completo). */
  completo: boolean;
}

/** Cobertura de un recorrido: cuántos tramos podemos seguir y cuáles no. Va junto a cada conclusión que se saque de él. */
export function coberturaDeRecorrido(toques: Toque[]): Cobertura {
  const tr = tramos(toques);
  const huecos = tr.filter((t) => !t.seguible);
  return { total: tr.length, seguibles: tr.length - huecos.length, huecos, completo: huecos.length === 0 };
}

/** Tramo agregado sobre muchas personas: de las que entraron por `de`, a cuántas reconoceríamos al pasar a `a`, y con qué dato. */
export interface TramoAgregado {
  de: Canal;
  a: Canal;
  personas: number;
  seguibles: number;
  por: Union;
}

export interface CoberturaEntreCanales {
  /** Personas distintas (fichas ya fundidas). */
  personas: number;
  /** Las que podríamos seguir al menos a otro canal. */
  seguibles: number;
  tramos: TramoAgregado[];
}

/**
 * Cobertura entre canales de un conjunto de fichas (p. ej. las personas que entraron en un flujo):
 * por canal de entrada, a cuántas podríamos reconocer si pasan a WhatsApp (hace falta su teléfono)
 * o a la web / el correo (hace falta su correo o su referencia de systeme.io). Lo que no está
 * acreditado cuenta como hueco, nunca como unión.
 */
export function coberturaEntreCanales(fichas: FichaIdentidad[]): CoberturaEntreCanales {
  const personas = fundirPersonas(fichas);
  const acc = new Map<string, TramoAgregado>();
  const suma = (de: Canal, a: Canal, por: Union, ok: boolean) => {
    const k = de + ">" + a;
    let t = acc.get(k);
    if (!t) { t = { de, a, personas: 0, seguibles: 0, por }; acc.set(k, t); }
    t.personas++;
    if (ok) t.seguibles++;
  };
  let seguibles = 0;
  for (const p of personas) {
    const de = canalDeFicha(p.fichas[0]);
    if (!de) continue;
    const tel = p.identificadores.some((x) => x.startsWith("tel:"));
    const web = p.identificadores.some((x) => x.startsWith("email:") || x.startsWith("sio:"));
    let alguno = false;
    if (de !== "whatsapp") { suma(de, "whatsapp", "telefono", tel); alguno = alguno || tel; }
    if (de !== "correo") { suma(de, "web", "correo", web); alguno = alguno || web; }
    if (alguno) seguibles++;
  }
  const orden: Record<string, number> = { whatsapp: 0, instagram: 1, facebook: 2, correo: 3 };
  const lista = [...acc.values()].sort((x, y) => (orden[x.de] ?? 9) - (orden[y.de] ?? 9) || x.a.localeCompare(y.a));
  return { personas: personas.length, seguibles, tramos: lista };
}
