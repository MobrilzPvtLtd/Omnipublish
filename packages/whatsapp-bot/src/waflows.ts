/**
 * Motor de automatismos de WhatsApp:
 *  - Disparadores por palabra clave: mensaje del cliente → respuesta/enlace/
 *    tag/escalado/iniciar secuencia. Editables en el panel (platform=whatsapp).
 *  - Secuencias (drip): pasos con retraso; el scheduler los va enviando SOLO
 *    si el contacto sigue dentro de la ventana de 24h (vía elegida: gratis).
 *  - Si el cliente responde, se cancelan sus secuencias pendientes.
 */
import { telLog } from "./pii-log.js";
import {
  dbListAutomations,
  dbUpsertAutomation,
  dbDeleteAutomation,
  dbClaimOnce,
  dbListSequences,
  dbUpsertSequence,
  dbDeleteSequence,
  dbScheduleRun,
  dbDueRuns,
  dbFinishRun,
  dbCancelRunsForPhone,
} from "./db.js";
import { sendText } from "./whatsapp.js";
import { getContact, inWindow } from "./contacts.js";
import { runWithWorkspace } from "./workspace.js";

export interface WaAutomation {
  id: string;
  name: string;
  enabled: boolean;
  platform: "whatsapp";
  keyword: string; // "" = cualquier mensaje
  reply: string;
  link: string;
  tag: string;
  escalate: boolean;
  startSequence: string; // id de secuencia
  stopAi: boolean; // si true, no pasa al bot IA tras disparar
  oncePerUser: boolean;
  // Opcional: limita el trigger a un nº de WA concreto (phoneNumberId).
  // Si falta o está vacío → aplica a TODOS los números (compat hacia atrás).
  phoneNumberId?: string;
}
export interface Sequence {
  id: string;
  name: string;
  enabled: boolean;
  steps: { delayMin: number; text: string }[];
}

const isWa = (a: any): a is WaAutomation => a && a.platform === "whatsapp";

export async function listWaAutomations(): Promise<WaAutomation[]> {
  return (await dbListAutomations()).filter(isWa) as unknown as WaAutomation[];
}
export async function saveWaAutomation(a: WaAutomation) {
  a.platform = "whatsapp";
  await dbUpsertAutomation(a.id, a as unknown as Record<string, unknown>);
}
export async function deleteWaAutomation(id: string) {
  await dbDeleteAutomation(id);
}
export async function listSequences(): Promise<Sequence[]> {
  return (await dbListSequences()) as unknown as Sequence[];
}
export async function saveSequence(s: Sequence) {
  await dbUpsertSequence(s.id, s as unknown as Record<string, unknown>);
}
export async function removeSequence(id: string) {
  await dbDeleteSequence(id);
}

export async function startSequence(phone: string, seqId: string): Promise<void> {
  const seq = (await listSequences()).find((s) => s.id === seqId && s.enabled);
  if (!seq || !seq.steps?.length) return;
  const when = Date.now() + Math.max(0, seq.steps[0].delayMin) * 60_000;
  await dbScheduleRun(`${seqId}:${phone}`, phone, seqId, 0, when);
}

/**
 * Procesa un mensaje entrante contra los disparadores WhatsApp.
 * Devuelve si hay que ESCALAR y si hay que SALTAR el bot IA.
 *
 * Multi-número: si el trigger trae `phoneNumberId`, solo aplica cuando el
 * mensaje entró por ese número. Si no lo trae (legacy), aplica a todos.
 */
export async function runWaTriggers(
  phone: string,
  text: string,
  incomingPhoneNumberId?: string,
): Promise<{ stopAi: boolean; escalate: boolean }> {
  let stopAi = false;
  let escalate = false;
  const pnid = String(incomingPhoneNumberId || "");
  // CICLO-1 · import DINAMICO a proposito: en estatico cerraria el ciclo
  // waflows -> flows -> facebook -> snapshots -> waflows. Mismo patron que el
  // enrichContact de mas abajo. Se resuelve una vez por mensaje, no por disparador.
  const { matchesKeyword } = await import("./flows.js");

  for (const a of await listWaAutomations()) {
    if (!a.enabled) continue;
    // Filtro por número: si el trigger limita a un phoneNumberId, debe coincidir
    // con el del mensaje entrante. Si el trigger no lo tiene, sigue siendo global.
    if (a.phoneNumberId && pnid && a.phoneNumberId !== pnid) continue;
    // COMAS-WA-1 · Antes: `t.includes(a.keyword.toLowerCase())`, es decir la palabra
    // clave se buscaba ENTERA y literal. El formulario del panel promete «separa con
    // comas» y su vista previa parte por comas, así que un disparador con «info,
    // precio» exigía que el cliente escribiera exactamente eso: NO disparaba nunca, y
    // la pantalla lo pintaba como si funcionase. Tampoco se quitaban los acentos, así
    // que «formación» no casaba con "formacion". Ahora se usa matchesKeyword(), el
    // MISMO matcher de los Flujos (flows.ts) y hermano del keywordHit() de los
    // disparadores de comentarios (automations.ts): una sola semántica de palabra
    // clave en todo el panel.
    if (a.keyword && !matchesKeyword(text, a.keyword)) continue;
    if (a.oncePerUser && !(await dbClaimOnce(a.id, phone))) continue;

    try {
      if (a.reply || a.link) {
        const body = [a.reply, a.link].filter(Boolean).join("\n");
        if (body) await sendText(phone, body);
      }
      if (a.tag) {
        const { enrichContact } = await import("./contacts.js");
        await enrichContact(phone, { tags: [a.tag] });
      }
      if (a.startSequence) await startSequence(phone, a.startSequence);
      if (a.escalate) escalate = true;
      if (a.stopAi) stopAi = true;
      console.log(`[wa] disparador '${a.name}' para ${telLog(phone)}`);
    } catch (e) {
      console.error(`[wa] disparador '${a.name}' falló:`, (e as Error).message);
    }
  }
  return { stopAi, escalate };
}

/** Cuando el cliente responde, cancela sus secuencias pendientes. */
export async function cancelSequences(phone: string): Promise<void> {
  await dbCancelRunsForPhone(phone);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Arranca el scheduler de secuencias (drip). */
export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(tick, 30_000);
  timer.unref?.();
}

async function tick(): Promise<void> {
  let due;
  try {
    due = await dbDueRuns();
  } catch (e) {
    console.error("[wa] scheduler dueRuns:", (e as Error).message);
    return;
  }
  // Multi-tenant W8: cada run corre bajo su tenant_id (fallback 'default').
  // listSequences() filtra por currentWorkspaceId(), así que va DENTRO del scope del
  // workspace: llamarlo fuera devolvía siempre las de 'default' y las secuencias de
  // cualquier otro workspace no se encontraban → se cerraban en silencio. Agrupamos
  // por workspace para listar una vez por tenant, no una por run.
  const byTenant = new Map<string, typeof due>();
  for (const run of due) {
    const t = (run as any).tenant_id || "default";
    const arr = byTenant.get(t);
    if (arr) arr.push(run);
    else byTenant.set(t, [run]);
  }
  for (const [tenant, runs] of byTenant) {
    await runWithWorkspace(tenant, async () => {
      const seqs = await listSequences();
      // Cada run aislado: un fallo no puede abortar los demás de este workspace.
      const step = async (run: (typeof runs)[number]): Promise<void> => {
        const seq = seqs.find((s) => s.id === run.sequence_id);
        if (!seq || !seq.enabled || run.step >= seq.steps.length) {
          await dbFinishRun(run.id, "done");
          return;
        }
        const contact = await getContact(run.phone);
        if (!contact || !inWindow(contact)) {
          // Fuera de ventana 24h: no se puede enviar gratis → se aborta.
          await dbFinishRun(run.id, "cancelled");
          console.warn(`[wa] secuencia ${run.sequence_id} abortada (${telLog(run.phone)} fuera de 24h)`);
          return;
        }
        // El interruptor de respuestas automáticas NO se comprueba aquí: una secuencia es
        // una automatización que el dueño montó y que arrancó por una palabra clave. El
        // interruptor solo calla a la IA de charla libre, nunca desactiva un flujo o una
        // secuencia (mismo criterio que flows.ts / el INCIDENTE 2026-07-14 en index.ts).
        await sendText(run.phone, seq.steps[run.step].text);
        const next = run.step + 1;
        if (next < seq.steps.length) {
          const when = Date.now() + Math.max(0, seq.steps[next].delayMin) * 60_000;
          await dbScheduleRun(run.id, run.phone, run.sequence_id, next, when);
        } else {
          await dbFinishRun(run.id, "done");
        }
      };
      for (const run of runs) {
        try {
          await step(run);
        } catch (e) {
          console.error("[wa] scheduler step:", (e as Error).message);
          await dbFinishRun(run.id, "cancelled").catch(() => {});
        }
      }
    });
  }
}
