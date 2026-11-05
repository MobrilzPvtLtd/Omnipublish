/**
 * WEBHOOK-RELAY-1 · Reparto de webhooks de Meta hacia la instancia de cada cliente.
 * ---------------------------------------------------------------------------------
 * POR QUÉ EXISTE
 *
 * El stack pasa a desplegarse UNA INSTANCIA POR CLIENTE (su Railway, su Postgres,
 * su dominio), pero todas comparten la MISMA Meta App —el modelo Tech Provider, que
 * es justo lo que evita que cada cliente tenga que pasar su propio App Review—.
 *
 * Y ahí está el problema: **Instagram entrega los webhooks a una sola URL por app**.
 * La documentación de Meta es literal: «Account level webhooks customization is not
 * supported» (developers.facebook.com/docs/instagram-platform/webhooks, consultada
 * el 6-sep-2026). No hay override por cuenta ni por Página, y la suscripción de la
 * app al objeto `instagram` ni siquiera se puede tocar por API: solo desde el App
 * Dashboard. WhatsApp sí tiene anulación por número (ver WEBHOOK-NUMERO-1 en
 * admin.ts), pero Instagram no tiene ninguna.
 *
 * Consecuencia sin este módulo: los DMs y comentarios de Instagram de TODOS los
 * clientes llegan a la instancia que figura en el App Dashboard —la central— y la
 * instancia del cliente no ve ni uno.
 *
 * QUÉ HACE
 *
 * La instancia central mira el `entry.id` de cada evento, busca si pertenece a una
 * instancia de cliente y, si es así, le reenvía **el cuerpo tal cual llegó**, byte a
 * byte, con su cabecera `x-hub-signature-256` intacta. La instancia destino verifica
 * esa firma con el mismo App Secret y no necesita ningún cambio para aceptarla: para
 * ella es indistinguible de una entrega directa de Meta.
 *
 * Lo que NO hace, a propósito:
 *   · No guarda ningún dato de negocio. Solo un mapa {id de canal → URL}. Los
 *     Platform Terms de Meta (5.b.ii.2) exigen mantener separados los datos de cada
 *     cliente, así que la central no puede convertirse en un almacén central.
 *   · No transforma el cuerpo. Cualquier reserialización rompería la firma.
 *   · No bloquea la respuesta a Meta. El receptor ya contestó 200 antes de llamar
 *     aquí; el reenvío va por detrás.
 *
 * DÓNDE SE CONFIGURA
 *
 * Ajuste global `relay.routes` (solo lo escribe el administrador del stack), un JSON:
 *
 *   { "ig:17841400000000000": "https://cliente.stack.ingenierobinario.com",
 *     "page:1029384756":      "https://cliente.stack.ingenierobinario.com",
 *     "wa:109876543210987":   "https://otro.stack.ingenierobinario.com" }
 *
 * La clave es `<canal>:<id>`; el valor, la URL base de la instancia (sin la ruta).
 * Un cliente normalmente tiene dos entradas: su cuenta de Instagram y su Página.
 *
 * ESTO ES UN APAÑO CONSCIENTE, NO LA ARQUITECTURA FINAL. Hace de la central un punto
 * único de fallo para Instagram y no tiene cola persistente: si el destino no
 * responde, se reintenta una vez y se pierde (Meta reintenta por su cuenta si no
 * recibe 2xx, pero nosotros ya contestamos 200). Lo sustituye la «Pasarela Meta»
 * —servicio propio, con cola y monitor— antes del tercer cliente.
 */
import crypto from "node:crypto";
import { get as getSetting } from "./settings.js";

/** Canales que se reparten. Solo estos dos: WhatsApp llega directo a la instancia
 *  del cliente por WEBHOOK-NUMERO-1, así que no tiene punto de reparto y aceptar
 *  aquí una clave `wa:` sería prometer algo que no ocurre. */
export type RelayChannel = "ig" | "page";

/** Valor de la cabecera que marca una entrega ya repartida (freno de bucle). */
export const RELAY_HEADER = "x-relay-from";
export const RELAY_HEADER_VALUE = "business-stack-central";

export interface RelayResult {
  /** El evento pertenecía a otra instancia: el receptor NO debe procesarlo aquí,
   *  haya llegado o no. Se llama así, y no `reenviado`, porque antes valía `true`
   *  también cuando el envío fallaba y el rastro decía «reenviado» sobre un evento
   *  perdido: exactamente el tipo de mentira que el proyecto prohíbe. */
  esDeOtra: boolean;
  /** true SOLO si el destino confirmó la entrega con un 2xx. */
  entregado: boolean;
  /** URL base a la que se envió, para el registro. */
  destino?: string;
  /** Motivo del fallo, si lo hubo. El evento se da por perdido. */
  error?: string;
}

/** Lee el mapa de rutas. Tolerante: un JSON corrupto no puede tumbar un webhook. */
function rutas(): Record<string, string> {
  const raw = getSetting("relay.routes");
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      const url = String(v || "").trim().replace(/\/+$/, "");
      // Solo https y sin credenciales incrustadas: esto reenvía datos de clientes.
      if (url && /^https:\/\/[^\s@]+$/i.test(url)) out[k.trim()] = url;
    }
    return out;
  } catch {
    console.warn("[webhook-relay] relay.routes no es JSON válido: se ignora (ningún evento se reenvía).");
    return {};
  }
}

/** ¿Hay algún reparto configurado? Permite saltarse todo el trabajo si no. */
export function relayActivo(): boolean {
  return Object.keys(rutas()).length > 0;
}

/** URL de la instancia dueña de ese canal, o "" si el evento es de esta instancia. */
export function destinoDe(channel: RelayChannel, id: string): string {
  if (!id) return "";
  return rutas()[`${channel}:${String(id).trim()}`] || "";
}

/**
 * Reparte las entries de una entrega entre las instancias dueñas.
 *
 * Devuelve las entries que se queda ESTA instancia (las que no tienen ruta) y lanza
 * un envío por destino con SOLO sus entries. Agrupar es lo que evita que el cliente
 * A vea las conversaciones del B cuando Meta mete varias cuentas en la misma entrega.
 *
 * `esDeOtra` en el resultado por entry es lo que el receptor usa para saltársela.
 */
export async function repartir<T>(
  path: string,
  objeto: string,
  entries: T[],
  canalDe: (entry: T) => { canal: RelayChannel; id: string },
  appSecret: string,
  yaRepartido: boolean,
): Promise<{ mias: T[]; enviados: Array<RelayResult & { ids: string[] }> }> {
  // Freno de bucle: si esto YA viene de un reparto, no se vuelve a repartir. Una ruta
  // que apunte (por error) a la propia instancia se quedaría rebotando para siempre.
  if (yaRepartido) return { mias: entries, enviados: [] };
  const porDestino = new Map<string, { entries: T[]; ids: string[] }>();
  const mias: T[] = [];
  for (const e of entries) {
    const { canal, id } = canalDe(e);
    const destino = destinoDe(canal, id);
    if (!destino) { mias.push(e); continue; }
    const g = porDestino.get(destino) || { entries: [], ids: [] };
    g.entries.push(e);
    g.ids.push(id);
    porDestino.set(destino, g);
  }
  const enviados: Array<RelayResult & { ids: string[] }> = [];
  for (const [destino, g] of porDestino) {
    const r = await reenviar(destino, path, { object: objeto, entry: g.entries }, appSecret);
    enviados.push({ ...r, ids: g.ids });
  }
  return { mias, enviados };
}

/**
 * Reenvía a la instancia dueña UNA entrega recortada a sus propios eventos.
 *
 * Por qué se recorta y se vuelve a firmar, en vez de reenviar el cuerpo original:
 * el array `entry` de Meta es **multi-cuenta**. Una sola entrega puede traer las
 * conversaciones de varios clientes a la vez. Reenviar el cuerpo entero a cada uno
 * significaba que el servidor del cliente A recibía en claro los DMs del cliente B
 * —aunque luego los descartara, el dato ya había cruzado y quedaba en sus registros—.
 * Eso es justo la separación que los Platform Terms de Meta (5.b.ii.2) obligan a
 * mantener, así que se prefiere reconstruir el cuerpo con solo las entries de ese
 * destino y firmarlo de nuevo con el App Secret, que la central tiene.
 *
 * `path` es la MISMA ruta por la que entró, para que el destino lo procese por su
 * camino de siempre. Nunca lanza: un fallo de red no puede romper el reparto a los
 * demás clientes ni el procesado de lo que sí es de esta instancia.
 */
export async function reenviar(
  destino: string,
  path: string,
  cuerpoJson: unknown,
  appSecret: string,
): Promise<RelayResult> {
  const url = destino.replace(/\/+$/, "") + path;
  // El cuerpo se serializa aquí, así que la firma original ya no vale: se calcula de
  // nuevo sobre estos bytes exactos. El destino la valida con el mismo App Secret y
  // no nota la diferencia. Si no tuviéramos el secreto no podríamos recortar, y
  // habría que elegir entre la fuga o no repartir.
  const texto = JSON.stringify(cuerpoJson);
  const cuerpo = new TextEncoder().encode(texto);
  const firma = "sha256=" + crypto.createHmac("sha256", appSecret).update(cuerpo).digest("hex");
  // Dos intentos y a otra cosa: el receptor ya respondió 200 a Meta, así que aquí
  // no hay reintento de Meta que aprovechar. Un timeout corto evita que un destino
  // caído retenga el bucle de entries de los demás clientes.
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": firma,
          // Marca de reenvío. La lee el receptor para NO volver a repartir lo que ya
          // le ha repartido otro: sin esto, una ruta mal puesta que apunte a la propia
          // instancia (o dos instancias que se apunten entre sí) genera un bucle.
          "x-relay-from": RELAY_HEADER_VALUE,
        },
        body: cuerpo,
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      // 200 «ignored» es la respuesta que da el receptor cuando DESCARTA por firma
      // inválida (ACK-Y-DESCARTE). Un 2xx no basta para cantar victoria.
      if (r.ok) {
        const cuerpoResp = await r.text().catch(() => "");
        if (/ignored/i.test(cuerpoResp)) return { esDeOtra: true, entregado: false, destino, error: "el destino lo descartó (firma inválida)" };
        return { esDeOtra: true, entregado: true, destino };
      }
      // 4xx del destino: no se arregla reintentando (firma, ruta, instancia caída).
      if (r.status >= 400 && r.status < 500) return { esDeOtra: true, entregado: false, destino, error: `HTTP ${r.status}` };
    } catch (e) {
      if (intento === 2) return { esDeOtra: true, entregado: false, destino, error: (e as Error).message };
    }
  }
  return { esDeOtra: true, entregado: false, destino, error: "sin respuesta tras 2 intentos" };
}
