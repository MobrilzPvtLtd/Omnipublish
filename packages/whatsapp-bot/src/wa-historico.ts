/**
 * BANDEJA-FIX-2 · Limpieza del histórico de la Bandeja de WhatsApp.
 *
 * BANDEJA-FIX-1 arregló dos cosas, pero SOLO desde el día que se desplegó:
 *   1) memory.ts deja de guardar un mensaje que ya está (mismo mid, o misma
 *      huella + ventana de 20s + señal de dos vías).
 *   2) gruposWaPorTelefono (admin.ts) funde AL LEER las cuentas que son el
 *      mismo teléfono del negocio por dos vías (Meta → QR o al revés), para
 *      que la Bandeja pinte una fila y no dos.
 *
 * Ninguno de los dos toca lo que YA estaba guardado. Y (2) tiene un agujero:
 * solo funde si sabe el teléfono de AMBAS cuentas, y el de un número retirado
 * ANTES de que existiera el registro que lo apunta (wa-retired.ts) nunca se
 * llegó a guardar — no hay forma de preguntárselo a Meta con un token que ya
 * no vale. Ese número queda irreconocible para siempre por esa vía, y su
 * conversación sale partida en dos filas: una «vía Número retirado» con el
 * histórico, otra con el número nuevo.
 *
 * Esta limpieza repara lo YA guardado con el MISMO criterio, pero reconociendo
 * la migración por un dato que SÍ tenemos aunque el teléfono del retirado se
 * haya perdido: dentro de una misma conversación (una fila = un contacto, la
 * PK de app_conversations es tenant+contacto) los turnos vienen repartidos
 * entre una cuenta retirada y una viva. Eso, sin más explicación posible, ES
 * la migración: el bot solo puede saber de una cuenta retirada por los turnos
 * que ella misma dejó en la conversación de un cliente real.
 *
 * GUARDA CRÍTICA — no negociable, pero no es «vivas o no»: es si son LA MISMA
 * LÍNEA TELEFÓNICA. Durante una migración de verdad, el número viejo (Cloud
 * API de Meta) y el nuevo (QR) están VIVOS A LA VEZ varios días — y ahí es
 * exactamente cuando hay que fundirlos, no cuando uno ya se retiró. Dos
 * cuentas vivas con TELÉFONOS DISTINTOS (Ventas y Soporte) nunca se funden:
 * eso sí es un cliente escribiendo a dos líneas reales del negocio.
 */
import type { ChatMessage } from "./llm.js";
import { depurarDuplicadosDeTurnos } from "./memory.js";
import { dbRecentConversations, dbRewriteConversationTurns } from "./db.js";
import { currentWorkspaceId, listWorkspacesCached, runWithWorkspace } from "./workspace.js";
import { listWaNumbers } from "./whatsapp.js";
import { qrList } from "./whatsapp-qr.js";
import { get, set } from "./settings.js";
import { logActivity } from "./activity.js";
import { soloDigitos, telefonoRecordado } from "./wa-retired.js";

/** Cuántas conversaciones revisa como mucho el barrido de un workspace en un
 *  arranque. Igual de acotado que dbScanLegacyTplConvs (cap 3000): es una
 *  limpieza de fondo, no un listado — el sobrante de hoy se revisa en el
 *  próximo arranque (el ajuste que marca «ya se hizo» solo se escribe si no
 *  quedó nada por barrer). */
const CAP_CONVERSACIONES = 5000;
/** Pausa entre escrituras: no acaparar el pool mientras el servidor ya sirve
 *  tráfico real (mismo motivo que el pacing de PLANTILLA-REPARA-1). */
const PACING_MS = 25;
/** Marca por workspace: «esta limpieza ya se hizo aquí». Así el coste real
 *  (leer las conversaciones enteras) se paga UNA vez y no en cada arranque. */
/** ECO-UNIFICADO-3 · V2: el criterio de duplicado aprendió a reconocer las dos copias
 *  por el FORMATO del identificador (Meta «wamid.» vs WhatsApp Web), así que el barrido
 *  se repite una vez para lo que la V1 no podía ver (copias ya reunidas bajo la misma
 *  cuenta). Cambiar la clave es lo que hace que se ejecute de nuevo. */
/** DUP-ADJUNTO-1 · V3: el criterio aprendió que un adjunto bajado y su copia fallida
 *  son el mismo mensaje; sin cambiar la clave, lo ya guardado nunca se barría. */
/** SIN-NOMBRE-1 · V4: el criterio aprendió a juntar la nota de voz (o foto/vídeo) que llegó
 *  por Meta y por QR a la vez — una copia bajada y otra fallida, sin nombre ni tamaño con
 *  que compararlas—; sin cambiar la clave, el «No disponible» ya guardado se quedaba. */
/** SIN-NOMBRE-2 · V5: el eco de Meta de un adjunto enviado desde el móvil llega como el
 *  marcador «[document]» sin adjunto, y ahora se reconoce como la copia del QR con el fichero
 *  (ECO-ADJ-MARCADOR-1); además dos mensajes distintos ya no se funden por cercanía. El barrido
 *  de arranque de la V5 SOLO deduplica (ver limpiarHistoricoAlArrancar). */
export const CLAVE_HECHO = "whatsapp.historicoLimpiezaV5";

/** Las cuentas de WhatsApp conectadas AHORA MISMO, sin llamar a Meta (nada de
 *  red: esto tiene que ser barato y no puede bloquear el arranque). Cloud:
 *  las que están en los ajustes del workspace (principal + extra). QR: las
 *  sesiones cuyo estado es literalmente "connected". */
function cuentasVivasAhora(): Set<string> {
  const vivas = new Set<string>();
  for (const n of listWaNumbers(false)) vivas.add("wa:" + n.phoneNumberId);
  for (const q of qrList()) if (q.status === "connected" && q.phone) vivas.add("wa:" + q.id);
  return vivas;
}

/**
 * El teléfono real (solo dígitos) de una cuenta viva, sin llamar a Meta, o ''
 * si no se conoce. QR: lo trae la propia sesión (se guarda al vincular). Cloud:
 * la caché de reconocimiento de wa-retired.ts (se apunta mientras se puede
 * preguntar a Graph) y, para la PRINCIPAL, el ajuste manual de respaldo
 * `whatsapp.displayPhoneNumber` que ya usa listWaNumbers() para su label.
 */
function telefonoDeCuenta(acct: string): string {
  const id = acct.startsWith("wa:") ? acct.slice(3) : acct;
  const qr = qrList().find((q) => q.id === id);
  if (qr?.phone) return soloDigitos(qr.phone);
  const recordado = telefonoRecordado(id); // ya viene normalizado (soloDigitos)
  if (recordado) return recordado;
  if (id === get("whatsapp.phoneNumberId")) {
    const d = soloDigitos(get("whatsapp.displayPhoneNumber"));
    if (d) return d;
  }
  return "";
}

/**
 * A qué cuenta se funden TODAS las demás de este grupo, o null si este grupo
 * no se toca.
 *   - Ninguna cuenta del grupo está viva → la de actividad más reciente (la
 *     que dejó el último turno en ESTA conversación) — el caso de una
 *     migración ya cerrada, sin ninguna vía viva hoy.
 *   - Una sola está viva → esa (la vieja retirada + la nueva que la sustituyó).
 *   - Dos o más vivas → la distinción NO es «vivas o no», es si son LA MISMA
 *     línea telefónica:
 *       · de TODAS se conoce el teléfono y es el mismo → se funden en la de
 *         actividad más reciente (la migración con las dos vías conviviendo).
 *       · algún teléfono conocido DIFIERE → null, GUARDA REAL: dos líneas
 *         reales del negocio (Ventas y Soporte), nunca se mezclan.
 *       · de alguna no se conoce el teléfono → null también: sin el dato no
 *         se adivina.
 */
function elegirDestino(accts: string[], vivas: Set<string>, ultimaAct: Map<string, number>): string | null {
  const vivasEnGrupo = accts.filter((a) => vivas.has(a));
  const masReciente = (candidatos: string[]): string => {
    let mejor = candidatos[0];
    let mejorAt = ultimaAct.get(mejor) || 0;
    for (const a of candidatos.slice(1)) {
      const at = ultimaAct.get(a) || 0;
      if (at > mejorAt) { mejor = a; mejorAt = at; }
    }
    return mejor;
  };
  if (vivasEnGrupo.length >= 2) {
    const telefonos = new Set<string>();
    for (const a of vivasEnGrupo) {
      const tel = telefonoDeCuenta(a);
      if (!tel) return null; // sin el teléfono de alguna viva, no se adivina
      telefonos.add(tel);
    }
    if (telefonos.size > 1) return null; // teléfonos distintos: líneas distintas, nunca se funden
    return masReciente(vivasEnGrupo); // mismo teléfono en todas: la viva más activa
  }
  if (vivasEnGrupo.length === 1) return vivasEnGrupo[0];
  return masReciente(accts);
}

/** Retagea el `acct` de los turnos de una conversación a UNA sola cuenta,
 *  cuando el grupo tiene un destino claro (ver elegirDestino). Turnos de
 *  otros canales (ig:/fb:/'') no se tocan. */
export function fusionarCuentasEnTurnos(
  turns: ChatMessage[],
  vivas: Set<string>,
): { turns: ChatMessage[]; cambio: boolean } {
  const ultimaAct = new Map<string, number>();
  const accts = new Set<string>();
  for (const t of turns) {
    const a = String((t as { acct?: string }).acct || "");
    if (!a.startsWith("wa:")) continue;
    accts.add(a);
    const at = Number(t.at || 0);
    if (at > (ultimaAct.get(a) || 0)) ultimaAct.set(a, at);
  }
  if (accts.size < 2) return { turns, cambio: false };
  const destino = elegirDestino([...accts], vivas, ultimaAct);
  if (!destino) return { turns, cambio: false };
  let cambio = false;
  const nuevos = turns.map((t) => {
    const a = String((t as { acct?: string }).acct || "");
    if (!a.startsWith("wa:") || a === destino) return t;
    cambio = true;
    return { ...(t as Record<string, unknown>), acct: destino };
  });
  return { turns: cambio ? (nuevos as ChatMessage[]) : turns, cambio };
}

/**
 * La limpieza de UNA conversación: primero deduplica, DESPUÉS funde cuentas.
 *
 * El orden importa y no es arbitrario: indiceDelMismoMensaje (memory.ts)
 * reconoce un duplicado sin mid común, en parte, por la señal de que llegó
 * por DOS VÍAS — y esa señal es justo que el `acct` difiera. Si se fundieran
 * las cuentas ANTES, dos turnos que hoy tienen acct distinto pasarían a tener
 * el mismo, la señal desaparecería, y el duplicado real de la migración (el
 * caso que más nos importa) dejaría de reconocerse. Deduplicar primero,
 * fundir después, conserva la señal mientras hace falta.
 */
export function limpiarTurnosHistoricos(
  turns: ChatMessage[],
  vivas: Set<string>,
  fundirCuentas = true,
): { turns: ChatMessage[]; cambio: boolean; duplicadosRetirados: number; cuentasFusionadas: boolean } {
  const dedup = depurarDuplicadosDeTurnos(turns);
  const fusion = fundirCuentas ? fusionarCuentasEnTurnos(dedup.turns, vivas) : { turns: dedup.turns, cambio: false };
  return {
    turns: fusion.turns,
    cambio: dedup.retirados > 0 || fusion.cambio,
    duplicadosRetirados: dedup.retirados,
    cuentasFusionadas: fusion.cambio,
  };
}

/**
 * Barre TODAS las conversaciones del workspace ACTIVO (currentWorkspaceId) y
 * aplica limpiarTurnosHistoricos a cada una, escribiendo solo las que
 * cambiaron. Callable directamente (lo usa el arranque, y las pruebas para
 * comprobar que repetirlo no cambia nada).
 *
 * Lectura en bloque (dbRecentConversations) para no pagar una consulta por
 * conversación al DETECTAR candidatas; la ESCRITURA de las que sí cambian va
 * por dbRewriteConversationTurns, que relee fresco con bloqueo optimista — si
 * un mensaje real entra a mitad de la limpieza, esa fila se deja para el
 * próximo barrido en vez de arriesgarse a pisarlo.
 */
export async function limpiarHistoricoWorkspace(opciones: { fundirCuentas?: boolean } = {}): Promise<{
  revisadas: number;
  conversacionesFusionadas: number;
  mensajesDuplicadosRetirados: number;
}> {
  const fundirCuentas = opciones.fundirCuentas !== false;
  const tenantId = currentWorkspaceId();
  const vivas = cuentasVivasAhora();
  const candidatas = await dbRecentConversations(CAP_CONVERSACIONES);
  let conversacionesFusionadas = 0;
  let mensajesDuplicadosRetirados = 0;
  for (const cv of candidatas) {
    const turnsIniciales = ((cv as { turns?: unknown }).turns as ChatMessage[]) || [];
    if (turnsIniciales.length < 2) continue; // nada que deduplicar ni fundir
    const previsto = limpiarTurnosHistoricos(turnsIniciales, vivas, fundirCuentas);
    if (!previsto.cambio) continue;
    let fusiono = false;
    let retirados = 0;
    const escrito = await dbRewriteConversationTurns(tenantId, String((cv as { user_id: string }).user_id), (frescos) => {
      const propios = (Array.isArray(frescos) ? frescos : []) as ChatMessage[];
      const r = limpiarTurnosHistoricos(propios, vivas, fundirCuentas);
      if (!r.cambio) return null;
      fusiono = r.cuentasFusionadas;
      retirados = r.duplicadosRetirados;
      return r.turns as unknown[];
    });
    if (escrito) {
      if (fusiono) conversacionesFusionadas++;
      mensajesDuplicadosRetirados += retirados;
    }
    await new Promise((res) => setTimeout(res, PACING_MS));
  }
  return { revisadas: candidatas.length, conversacionesFusionadas, mensajesDuplicadosRetirados };
}

/**
 * Punto de entrada del arranque: UNA vez por workspace, en segundo plano, sin
 * bloquear el arranque — mismo patrón que warmLogoVersions/qrRestoreAll en
 * index.ts. Barato quede lo que quede: si el workspace ya quedó marcado como
 * limpio en un arranque anterior, esta llamada no toca la BD para nada más
 * que leer un ajuste. Si algo falla, se registra y el servicio sigue: una
 * limpieza de fondo nunca puede costarle el panel a nadie.
 */
export async function limpiarHistoricoAlArrancar(): Promise<void> {
  let workspaces: { id: string }[] = [];
  try {
    workspaces = await listWorkspacesCached();
  } catch {
    return; // sin censo de workspaces no hay nada seguro que barrer
  }
  for (const w of workspaces) {
    await runWithWorkspace(w.id, async () => {
      if (get(CLAVE_HECHO)) return; // ya se hizo aquí — coste: un ajuste en caché
      try {
        // SIN-NOMBRE-2 · la V5 solo cambió el criterio de duplicado: NO se vuelven a fundir
        // cuentas. Esa fusión depende de qué QR figuran «connected» en ese instante (qrRestoreAll
        // corre en segundo plano y puede no haber terminado) y la V1–V4 ya la aplicaron; con una
        // foto incompleta de las cuentas vivas reetiquetaría conversaciones que la guarda dejó
        // a propósito con dos líneas.
        const r = await limpiarHistoricoWorkspace({ fundirCuentas: false });
        await set(CLAVE_HECHO, String(Date.now()));
        if (r.conversacionesFusionadas || r.mensajesDuplicadosRetirados) {
          await logActivity({
            source: "app",
            level: "info",
            summary:
              `Limpieza de la Bandeja: se unieron ${r.conversacionesFusionadas} ` +
              `conversaciones que estaban repartidas entre dos números y se ` +
              `retiraron ${r.mensajesDuplicadosRetirados} mensajes que estaban ` +
              `guardados dos veces.`,
            payload: { ...r },
          }).catch(() => { /* la actividad es informativa, nunca bloqueante */ });
        }
      } catch (e) {
        // No se marca CLAVE_HECHO: se reintenta en el próximo arranque.
        await logActivity({
          source: "app",
          level: "warn",
          summary: "La limpieza de la Bandeja no se pudo completar; se reintentará en el próximo arranque.",
          payload: { workspace: w.id, error: String((e as Error)?.message || e).slice(0, 300) },
        }).catch(() => { /* idem */ });
      }
    });
    await new Promise((res) => setTimeout(res, PACING_MS * 4)); // entre workspaces, más aire
  }
}
