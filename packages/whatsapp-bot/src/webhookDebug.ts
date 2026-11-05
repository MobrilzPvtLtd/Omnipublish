/**
 * Registro en memoria (anillo) de los últimos webhooks recibidos, para diagnosticar
 * entregas sin adivinar: ¿llega el mensaje?, ¿se rechaza por firma?, ¿se procesa o se
 * descarta y por qué? Se expone en el panel (Conexiones → WhatsApp → Diagnóstico).
 *
 * Es solo telemetría volátil del proceso (no persiste, no toca BD). En multi-réplica
 * cada réplica tiene el suyo; suficiente para depurar.
 */
import { currentWorkspace } from "./workspace.js";

export type WebhookHit = { at: number; channel: string; note: string; tenant_id: string | null };

const hits: WebhookHit[] = [];
const MAX = 30;

export function recordWebhook(channel: string, note: string): void {
  // WEBHOOK-DIAGNOSTICO-TENANT-1 · Antes de resolver el canal el evento es
  // global, nunca del workspace 'default' por accidente.
  hits.unshift({ at: Date.now(), channel, note: String(note).slice(0, 200), tenant_id: currentWorkspace()?.id || null });
  if (hits.length > MAX) hits.length = MAX;
}

export function getWebhookHits(opts: { allTenants?: boolean } = {}): WebhookHit[] {
  const tenant = currentWorkspace()?.id;
  return hits.filter((hit) => opts.allTenants || (tenant && hit.tenant_id === tenant));
}
