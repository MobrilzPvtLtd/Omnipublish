/**
 * CUENTAS-ATOMICO-1 · Cola de escritura por clave de ajustes.
 *
 * Varias colecciones del panel (las páginas de Facebook, los canales de YouTube)
 * viven como UN solo JSON dentro de una clave de ajustes. Toda actualización es,
 * por tanto, un leer-todo → modificar → escribir-todo, y entre la lectura y la
 * escritura hay siempre un `await`. Dos actualizaciones que se solapen pisan una
 * a la otra: la segunda escribe el estado que leyó ANTES de que la primera
 * guardara, así que el cambio de la primera desaparece (una página recién
 * borrada resucita, un token recién refrescado se pierde).
 *
 * Esto serializa esos tríos por clave y por espacio de trabajo: mientras uno está
 * en marcha, el siguiente espera, y cuando entra vuelve a LEER — que es justo lo
 * que faltaba. La lectura tiene que quedar DENTRO de la cola o no sirve de nada.
 *
 * Límite conocido, a propósito: esto es una cola EN MEMORIA, así que solo cubre
 * las colisiones dentro de un mismo proceso. Con más de una réplica sirviendo el
 * panel, la carrera vuelve a existir entre procesos; la solución de verdad es
 * guardar cada página / cada canal en su propia fila (INSERT … ON CONFLICT DO
 * UPDATE, como app_inbox_media), y queda anotada como deuda.
 */
import { currentWorkspaceId } from "./workspace.js";

// clave → promesa de la última tarea encolada (nunca rechaza: ver abajo).
const colas = new Map<string, Promise<void>>();

/**
 * Ejecuta `fn` en exclusiva para esa clave de ajustes (dentro del proceso).
 * Devuelve lo que devuelva `fn`, y propaga su error tal cual al que llamó —
 * un fallo NO atasca la cola: el siguiente de la fila entra igualmente.
 */
export function withKeyLock<T>(clave: string, fn: () => Promise<T>): Promise<T> {
  let tenant = "default";
  try { tenant = currentWorkspaceId() || "default"; } catch { tenant = "default"; }
  const k = tenant + "::" + clave;
  const anterior = colas.get(k) || Promise.resolve();
  const propio = anterior.then(() => fn());
  // En la cola guardamos una versión que nunca rechaza: si guardásemos `propio`
  // y `fn` fallara, el siguiente de la fila heredaría el rechazo (y además
  // quedaría un rechazo sin capturar tumbando el proceso).
  const marcador: Promise<void> = propio.then(() => undefined, () => undefined);
  colas.set(k, marcador);
  // Si nadie más se ha puesto detrás, se retira la entrada: el mapa no crece.
  void marcador.then(() => { if (colas.get(k) === marcador) colas.delete(k); });
  return propio;
}
