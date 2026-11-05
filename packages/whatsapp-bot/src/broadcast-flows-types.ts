/**
 * difusion-flow D1 — tipos del Broadcast Flow Builder.
 *
 * Un BroadcastFlow es un grafo orientado de nodos (BcNode) conectados por
 * aristas (BcEdge) que describe una difusión multi-paso: seleccionar
 * audiencia → enviar mensaje → esperar X → enviar followup si no respondió,
 * con saltos condicionales y programación temporal.
 *
 * El flujo se guarda en `app_broadcasts_flows.data` como JSON {nodes,edges,startId}.
 * Su ejecución produce un BroadcastRun (app_broadcasts_runs) con N jobs
 * (app_broadcasts_jobs) — uno por destinatario × canal.
 *
 * Multi-tenant: TODAS las filas viven scoped a tenant_id ('default' = WS legacy).
 */

export type BcNodeId = string;

/** Canales soportados para envío. */
export type BcChannel = "wa" | "ig_dm" | "fb_msg" | "email" | "sms";

/**
 * Selector de audiencia. La resolución real (→ lista de phones/emails) ocurre
 * al ejecutar el flow. Cada modo lee de tablas distintas:
 *  - tags     → app_contacts WHERE tags @> [...]
 *  - segment  → BroadcastRec.segment (stage/source/tag combinados)
 *  - explicit → lista de contact ids/phones embebidos
 *  - csv      → asset subido al panel (parsed → recipients)
 */
export interface BcAudienceSpec {
  mode: "tags" | "segment" | "explicit" | "csv";
  tags?: string[];
  stage?: string;
  source?: string;
  /** Para mode='explicit' o 'csv': lista de recipients ya resueltos. */
  recipients?: string[];
  /** Asset id en app_page_assets para mode='csv'. */
  asset_id?: string;
}

/** Nodo "audience" — inicio del flow; resuelve a quiénes se envía. */
export interface BcAudienceNode {
  id: BcNodeId;
  type: "audience";
  audience: BcAudienceSpec;
  channel: BcChannel;
}

/**
 * Nodo "message" — envío del mensaje principal (texto/template/imagen).
 * `vars` se expanden con datos del contacto al encolar el job.
 */
export interface BcMessageNode {
  id: BcNodeId;
  type: "message";
  /** Texto/caption con {{var}} interpolables. */
  text?: string;
  /** URL de imagen opcional (WA/IG). */
  image_url?: string;
  /** Nombre de la template WA (si aplica). */
  template_name?: string;
  /** Componentes de la template (header/body params). */
  template_components?: Record<string, unknown>;
  /** Botones rápidos (texto plano, sin URL). */
  buttons?: string[];
  /**
   * REG-3: número WABA explícito a usar para este nodo. Si está, el
   * runWithWaNumber wrapper resuelve creds() al número correcto y el
   * envío sale por esa cuenta. Si vacío/undefined, fallback al número
   * principal del WS. Necesario para WS multi-WABA (varios canales WhatsApp
   * en un mismo workspace) — sin esto la difusión sale siempre por el
   * principal aunque la audiencia esté segmentada.
   */
  wa_phone_number_id?: string;
}

/**
 * Nodo "wait" — pausa antes del siguiente nodo. `delay_ms` se respeta vía
 * `next_run` en app_broadcasts_jobs.
 */
export interface BcWaitNode {
  id: BcNodeId;
  type: "wait";
  delay_ms: number;
}

/**
 * Nodo "schedule" — arranque programado del flow (alternativa a start
 * inmediato). `scheduled_for_ms` se traslada a app_broadcasts_runs.scheduled_for.
 */
export interface BcScheduleNode {
  id: BcNodeId;
  type: "schedule";
  scheduled_for_ms: number;
}

/**
 * Nodo "followup" — mensaje de seguimiento si el destinatario NO respondió
 * antes de `wait_for_reply_ms`. Si SÍ respondió, salta el followup.
 */
export interface BcFollowupNode {
  id: BcNodeId;
  type: "followup";
  wait_for_reply_ms: number;
  text?: string;
  image_url?: string;
  template_name?: string;
}

/**
 * Nodo "branch" — bifurcación condicional. Evalúa `condition` contra el
 * estado del job (replied, opened, clicked…) y enruta a yes/no edges.
 */
export interface BcBranchNode {
  id: BcNodeId;
  type: "branch";
  condition: "replied" | "clicked" | "tag_present" | "stage_equals";
  /** Operando para condiciones que lo requieran (tag, stage). */
  value?: string;
}

export type BcNode =
  | BcAudienceNode
  | BcMessageNode
  | BcWaitNode
  | BcScheduleNode
  | BcFollowupNode
  | BcBranchNode;

/** Arista del grafo. `label` se usa para edges de branch ('yes'/'no'). */
export interface BcEdge {
  from: BcNodeId;
  to: BcNodeId;
  label?: string;
}

/** Estructura JSON serializada en app_broadcasts_flows.data. */
export interface BcFlowData {
  nodes: BcNode[];
  edges: BcEdge[];
  /** Id del nodo raíz (típicamente el audience o schedule). */
  startId: BcNodeId;
}

/** Estado de una Broadcast Flow definition (tabla app_broadcasts_flows). */
export interface BroadcastFlow {
  id: string;
  tenant_id: string;
  name: string;
  data: BcFlowData;
  enabled: boolean;
  /** epoch ms del último simulate exitoso (o fallo, en payload). */
  last_sim_at: number | null;
  /** Resultado del último simulate (resumen + warnings). */
  last_sim_result: Record<string, unknown> | null;
  created_by: string;
  created_at: number; // epoch ms
  updated_at: number; // epoch ms
}

/** Estado de una ejecución del flow (tabla app_broadcasts_runs). */
export type BroadcastRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export interface BroadcastRun {
  id: string;
  tenant_id: string;
  flow_id: string;
  status: BroadcastRunStatus;
  scheduled_for: number | null; // epoch ms (null = inmediato)
  started_at: number | null;
  ended_at: number | null;
  audience_total: number;
  jobs_sent: number;
  jobs_failed: number;
  jobs_replied: number;
  created_at: number; // epoch ms
}

/** Estado de un job individual de la cola (tabla app_broadcasts_jobs). */
export type BroadcastJobStatus =
  | "queued"
  | "sent"
  | "failed"
  | "cancelled"
  | "skipped";

export interface BroadcastJob {
  /** Qué paso del flujo es este envío: 'main' el mensaje, o el id del nodo de
   *  seguimiento. Forma parte de la identidad del job (FOLLOWUP-1). */
  step_key?: string;
  id: string;
  tenant_id: string;
  run_id: string;
  flow_id: string;
  recipient: string;
  channel: BcChannel;
  /** Payload final ya con {{vars}} resueltas (texto/img/template/etc). */
  payload: Record<string, unknown>;
  status: BroadcastJobStatus;
  attempts: number;
  next_run: number | null; // epoch ms (cuando toca enviar)
  sent_at: number | null;
  replied_at: number | null;
  /** ID del mensaje en Meta (wamid/mid) tras envío exitoso. */
  message_id: string | null;
  last_error: string | null;
  /** Coste estimado (céntimos). WA pricing tier × tipo. */
  cost_cents: number | null;
  created_at: number; // epoch ms
}
