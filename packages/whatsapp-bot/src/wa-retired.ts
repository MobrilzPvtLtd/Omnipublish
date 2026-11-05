/**
 * NUM-RETIRADO-1 · Memoria de los números de WhatsApp que se han quitado.
 *
 * Quitar un número no borra sus conversaciones ni sus contactos — siguen en sus tablas,
 * atados al canal por `channel_account`. Pero al quitarlo se perdía TODO rastro de él, y
 * entonces el chat solo podía decir «retirado»: ni el teléfono ni el nombre.
 *
 * Este registro guarda lo mínimo para dos cosas:
 *   1) que el chat siga diciendo DE QUÉ NÚMERO era, y explique que hay que reconectarlo;
 *   2) que al volver a conectar el MISMO teléfono —por la otra vía, típicamente pasar de
 *      Meta a QR— se pueda re-adoptar el histórico, que es lo que hace que la transición
 *      se vea limpia en vez de partir el hilo en dos.
 *
 * Vive en un ajuste del workspace, así que es privado de cada negocio como todo lo demás.
 */
import { get, set } from "./settings.js";

export interface NumeroRetirado {
  /** Cuenta de canal completa, tal cual se guarda en los contactos: `wa:<id>`. */
  acct: string;
  /** Teléfono real, para poder reconocerlo cuando vuelva por otra vía. */
  phone: string;
  /** El nombre que le puso el dueño, para que el chat siga hablando su idioma. */
  label: string;
  at: number;
}

const CLAVE = "whatsapp.retired";
/** Tope: es una ayuda para reconocer un número que vuelve, no un archivo histórico. */
const TOPE = 50;

/** Solo los dígitos: «+376 665 898» y «376665898» son el mismo teléfono. */
export function soloDigitos(phone: string): string {
  return String(phone || "").replace(/\D+/g, "");
}

export function listRetirados(): NumeroRetirado[] {
  try {
    const raw = JSON.parse(get(CLAVE) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .map((r: Partial<NumeroRetirado>) => ({
        acct: String(r?.acct || ""),
        phone: String(r?.phone || ""),
        label: String(r?.label || ""),
        at: Number(r?.at || 0),
      }))
      .filter((r) => !!r.acct);
  } catch {
    return []; // ajuste corrompido → como si no hubiera ninguno, nunca romper el panel
  }
}

async function guardar(lista: NumeroRetirado[]): Promise<void> {
  const recortada = lista.slice(-TOPE);
  await set(CLAVE, recortada.length ? JSON.stringify(recortada) : "");
}

/** Apunta un número que se acaba de quitar. Idempotente: re-quitar no duplica. */
export async function retirarNumero(n: { acct: string; phone?: string; label?: string }): Promise<void> {
  const acct = String(n.acct || "");
  if (!acct.startsWith("wa:")) return;
  const previo = listRetirados().find((r) => r.acct === acct);
  const lista = listRetirados().filter((r) => r.acct !== acct);
  lista.push({
    acct,
    // Si esta vez no sabemos el teléfono (Graph caído, sesión sin vincular), se conserva
    // el que ya tuviéramos: perderlo dejaría el número imposible de reconocer al volver.
    phone: String(n.phone || previo?.phone || ""),
    label: String(n.label || previo?.label || ""),
    at: Date.now(),
  });
  await guardar(lista);
}

/** Deja de recordarlo (ha vuelto, o el dueño ya no lo quiere ni en el histórico). */
export async function olvidarRetirado(acct: string): Promise<void> {
  const lista = listRetirados();
  const quedan = lista.filter((r) => r.acct !== acct);
  if (quedan.length !== lista.length) await guardar(quedan);
}

/**
 * BANDEJA-FIX-1 · Teléfono real de cada número, recordado MIENTRAS se sabe.
 *
 * El teléfono de un número de Meta solo se puede preguntar con su token: en cuanto el
 * número se quita (o su token deja de valer), ya no hay forma de saber cuál era. Y sin
 * teléfono no se le reconoce cuando vuelve por la otra vía: ni se re-adopta su
 * histórico, ni la Bandeja puede saber que esas dos vías son EL MISMO teléfono, así que
 * el hilo de un cliente sale partido en dos filas para siempre.
 *
 * Por eso se apunta cada vez que se resuelve, y se consulta cuando ya no se puede
 * preguntar. Es una caché de reconocimiento, no un dato de negocio: si falta, el
 * comportamiento es el de antes.
 */
const CLAVE_TEL = "whatsapp.phonesById";
const TOPE_TEL = 100;

export function telefonosRecordados(): Record<string, string> {
  try {
    const raw = JSON.parse(get(CLAVE_TEL) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const d = soloDigitos(String(v || ""));
      if (k && d) out[k] = d;
    }
    return out;
  } catch {
    return {};
  }
}

export function telefonoRecordado(phoneNumberId: string): string {
  return telefonosRecordados()[String(phoneNumberId || "")] || "";
}

/** Apunta los que se hayan podido resolver. Escribe SOLO si algo cambia. */
export async function recordarTelefonos(pares: Iterable<[string, string]>): Promise<void> {
  const actual = telefonosRecordados();
  let cambia = false;
  for (const [pid, phone] of pares) {
    const d = soloDigitos(phone);
    if (!pid || !d || actual[pid] === d) continue;
    actual[pid] = d;
    cambia = true;
  }
  if (!cambia) return;
  const entradas = Object.entries(actual).slice(-TOPE_TEL);
  await set(CLAVE_TEL, JSON.stringify(Object.fromEntries(entradas)));
}

export function retiradoPorAcct(acct: string): NumeroRetirado | null {
  return listRetirados().find((r) => r.acct === acct) || null;
}

/** El mismo teléfono, venga por donde venga. Es la clave de la transición Meta ↔ QR. */
export function retiradoPorTelefono(phone: string): NumeroRetirado | null {
  const d = soloDigitos(phone);
  if (!d) return null;
  // BANDEJA-FIX-1 · si al retirarlo no se pudo preguntar su teléfono (token ya inválido,
  // Graph caído), el registro se quedó sin él y el número volvía sin que nadie lo
  // reconociera. Se cae al teléfono que se apuntó mientras estaba vivo.
  return listRetirados().find((r) => soloDigitos(r.phone) === d
    || telefonoRecordado(r.acct.startsWith("wa:") ? r.acct.slice(3) : r.acct) === d) || null;
}

/** ¿Este id fue un número nuestro que se quitó? Lo usa el motor para esperar en vez de fallar. */
export function esNumeroRetirado(phoneNumberId: string): boolean {
  return !!retiradoPorAcct("wa:" + String(phoneNumberId || ""));
}
