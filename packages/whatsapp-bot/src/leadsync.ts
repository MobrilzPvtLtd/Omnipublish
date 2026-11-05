/**
 * Sincronización de leads a destinos externos.
 *
 * El destino va por el `mcp-bridge` (cola de jobs que el worker procesa contra el
 * systemeio-mcp):
 *
 *   - `systemeio`      → systeme.io, o el dominio propio de la cuenta
 *   - `leadmatch-lab`  → SIN-DEFAULTS-LM-1 · destino histórico, el laboratorio de
 *     pruebas del operador. Ya no se ofrece: era el destino por defecto y mandaba
 *     los leads de un cliente a un servidor ajeno. Se sigue aceptando para no
 *     romper los flujos que ya lo tengan guardado, pero `resolvePanelUrl()` lo
 *     resuelve a systeme.io.
 *
 * Para el MVP las credenciales son las mismas para ambos targets (las que ya
 * hay en settings: `systemeio.sandboxEmail` / `systemeio.sandboxPass`). El
 * `target_platform` decide la URL de login del bridge. Si más adelante hay
 * dos cuentas distintas, se añaden settings por-target (`sync.<id>.email/pass`)
 * y el bridge las usa por preferencia.
 *
 * Diseño deliberadamente fino: nada de lock-in al MCP — la API pública aquí
 * son `listTargets()` y `syncLead(targetId, lead)`, así que cambiar la capa
 * de transporte (REST directo, Zapier, …) en el futuro solo toca este archivo.
 */
import { queueMcpJob } from "./mcp-bridge.js";

export type SyncTargetId = "leadmatch-lab" | "systemeio";

export interface SyncTarget {
  id: SyncTargetId;
  label: string;
  description: string;
}

const TARGETS: SyncTarget[] = [
  {
    id: "systemeio",
    label: "Tu web",
    description: "systeme.io",
  },
];

/** Destinos que ya no se ofrecen pero se siguen aceptando (ver cabecera). */
const TARGETS_HEREDADOS: SyncTargetId[] = ["leadmatch-lab"];

export function listTargets(): SyncTarget[] {
  return TARGETS.slice();
}

export function isValidTarget(id: string): id is SyncTargetId {
  return TARGETS.some((t) => t.id === id) || TARGETS_HEREDADOS.some((t) => t === id);
}

export interface SyncLead {
  email: string;
  name?: string;
  tags?: string[];
  /** Datos extra que se intentan persistir como campos del contacto. */
  extra?: Record<string, string>;
}

/** Devuelve el job_id en la cola del MCP bridge (sin esperar a procesarlo). */
// accountId identifica la CONEXIÓN. Sin él, el puente resuelve la cuenta por su
// cuenta y con dos conectadas en la misma plataforma es una lotería: el mismo
// fallo que ya se corrigió en el paso «Sincronizar» de Flujos.
export async function syncLead(target: SyncTargetId, lead: SyncLead, accountId?: string): Promise<string> {
  if (!lead.email) {
    throw new Error("syncLead: email es obligatorio para localizar el contacto");
  }
  if (!isValidTarget(target)) {
    throw new Error("syncLead: target inválido: " + target);
  }
  const payload: Record<string, unknown> = {
    target_platform: target,
    ...(accountId ? { account_id: accountId } : {}),
    contact: {
      email: lead.email.trim().toLowerCase(),
      name: lead.name || "",
      tags: lead.tags || [],
      fields: lead.extra || {},
    },
  };
  return queueMcpJob({ kind: "contact-upsert", payload });
}

/**
 * Sync masivo: encola un contact-upsert por cada lead, devuelve los job_ids
 * y los emails saltados (sin email). No espera a la cola — el worker procesa
 * en background y cada job termina en `done` o `error` consultable por su id.
 */
export async function syncLeads(
  target: SyncTargetId,
  leads: SyncLead[],
  accountId?: string,
): Promise<{ enqueued: string[]; skipped: number }> {
  const enqueued: string[] = [];
  let skipped = 0;
  for (const lead of leads) {
    if (!lead.email) {
      skipped++;
      continue;
    }
    try {
      enqueued.push(await syncLead(target, lead, accountId));
    } catch {
      skipped++;
    }
  }
  return { enqueued, skipped };
}
