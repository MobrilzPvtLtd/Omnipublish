/**
 * Bridge directo HTTP entre business-stack y **`systemeio-mcp`**
 * La dirección vive SIEMPRE en el ajuste global `mcp.url` — no hay valor de
 * fábrica (SIN-DEFAULTS-LM-1): sin ese ajuste el puente se queda apagado.
 *
 * ⚠ MCP-DESTINO-1 · NO es el MCP del curso. Esta cabecera decía
 * `leadmatch-mcp.ingenierobinario.com` y describía un paso `empezar-modulo` con
 * código de módulo y `admin_key`: eso fue la arquitectura ORIGINAL y hoy es
 * FALSO — `empezar-modulo` no se llama desde ningún sitio y `mcp.gateCode` /
 * `mcp.adminKey` no se leen (los campos del contexto van siempre a ""). Se
 * arregla porque mandaba a depurar contra el servidor del CURSO, que es
 * infraestructura COMPARTIDA con alumnos en vuelo y no se toca.
 *
 * Los dos servidores son distintos y NO se deben confundir:
 *  - `systemeio-mcp` — el que usa este puente. Sin puerta de módulo.
 *  - `leadmatch-mcp` — el del curso. Proxea tools `systemeio-*` sobre el mismo
 *    servidor de abajo, pero **exige código de módulo**. Desde business-stack
 *    no se llama nunca.
 *
 * SIN LLM en medio. SIN coste de API. Habla JSON-RPC al MCP directamente
 * sobre HTTP siguiendo el spec MCP 2024-11-05 con session header.
 *
 * Flujo por job:
 *  1. `mcpInitSession()` — handshake `initialize` + `notifications/initialized`.
 *     Devuelve `Mcp-Session-Id` que se pasa en todas las llamadas posteriores.
 *  2. `bootstrapSession()` — resuelve la identidad de la web (de la CUENTA o de
 *     los ajustes del workspace; ver IDENTIDAD-PUENTE-1) y, si hace falta,
 *     `systemeio-login-start`. El `student_id` que viaja a las tools es ese
 *     correo: es la identidad de la cuenta de systeme.io, no un alumno.
 *  3. Tool específico del kind (contact-upsert → list-contacts +
 *     create-contact, page-publish → import-checkout-block +
 *     personalize-checkout-rawhtml).
 *
 * Job kinds:
 *  - `contact-upsert`: crea/actualiza contacto en systeme.io.
 *  - `contact-pull`: importa los últimos N contactos al panel.
 *  - `page-publish`: publica una page draft.
 *
 * Modo "draft" (sin identidad configurada): los jobs quedan en
 * `awaiting_config` con `error` informativo. Cuando el user la configura en
 * Conexiones, el worker reintenta automáticamente.
 */
import crypto from "node:crypto";
import * as pg from "pg";
import { pgSsl } from "./pg-ssl.js";
import { get as getSetting, set as setSetting } from "./settings.js";
import {
  addAccount as siAddAccount,
  getAccount as siGetAccount,
  getActiveAccount as siGetActiveAccount,
  listAccountsRaw as siListAccountsRaw,
  type SiAccount,
} from "./systemeio-accounts.js";
import { runWithWorkspace, currentWorkspaceId } from "./workspace.js";
import { logActivity } from "./activity.js";
import { tasasDivisa } from "./divisa.js";
import {
  syncContactWithTags,
  withPublicApiKey,
  estadisticasCorreoApi,
  findContactByEmailResult,
  listTags as siListTagsPublic,
  ensureTagId as siEnsureTagId,
  listFunnels as siListFunnelsPublic,
  listContactsPullPage as siListContactsPullPage,
  listNewsletters as siListNewslettersPublic,
  listFunnelSteps as siListFunnelStepsPublic,
  getNewsletter as siGetNewsletterPublic,
} from "./systemeio-public-api.js";

/**
 * Elige la cuenta systeme.io de un job.
 *
 * OJO con el default: getActiveAccount() es list[0], y en producción list[0] es la
 * cuenta SANDBOX (leadmatch-lab). Sin esto, un flujo que pide sincronizar a
 * "systeme.io" acababa escribiendo en el sandbox del curso sin que nadie lo notara.
 * Orden: id explícito > la plataforma pedida (prefiriendo cuentas con API key,
 * que son las únicas que saben asignar etiquetas) > la activa.
 */
export async function resolveSyncAccount(
  accountId?: string,
  targetPlatform?: string,
): Promise<SiAccount | null> {
  if (accountId) {
    // ESTRICTO a propósito: si el dueño ELIGIÓ una cuenta y ya no está entre las
    // Conexiones del workspace, la respuesta es null — el caller lo cuenta como
    // «cuenta desconectada». Caer aquí a otra cuenta «parecida» escribía los
    // datos en una web que nadie eligió (y en el OPEN-GATE, leía la etiqueta
    // de la cuenta equivocada: mejor «no concluyente» que adivinar).
    return (await siGetAccount(accountId)) ?? null;
  }
  const target = (targetPlatform || "").toLowerCase();
  if (target) {
    const wantsSandbox = target.includes("leadmatch-lab");
    const all = await siListAccountsRaw();
    const matches = all.filter((a) => {
      const host = (a.panelBaseUrl || "").toLowerCase();
      const isSandbox = host.includes("leadmatch-lab");
      return wantsSandbox ? isSandbox : !isSandbox;
    });
    if (matches.length) return matches.find((a) => a.apiKey) ?? matches[0];
    // SIO-SIN-GLOBAL-1 · se pidió una plataforma y no hay ninguna cuenta de ese tipo:
    // NO caer en la activa (que puede ser el sandbox del curso).
    console.warn(`[sio] sin cuenta para «${target}»: no se sincroniza`);
    return null;
  }
  // SIO-SIN-GLOBAL-1 · sin cuenta ni plataforma, solo sirve si no hay ambigüedad.
  const all = await siListAccountsRaw();
  if (all.length === 1) return all[0];
  if (all.length > 1) console.warn(`[sio] ${all.length} cuentas y ninguna elegida: no se sincroniza`);
  return null;
}

/**
 * OPEN-GATE · ¿el contacto (localizado por email) tiene una etiqueta concreta en
 * systeme.io / leadmatch-lab? Lo usa el nodo de flujo "¿Abrió el correo?": el dueño
 * configura en systeme.io una regla "email abierto → asignar etiqueta", y aquí la
 * leemos por la API pública (misma vía probada que el sync de leads).
 *
 * Devuelve un TRIESTADO a propósito:
 *   true  → la etiqueta está (abrió).
 *   false → se consultó y la etiqueta NO está (confirmado no abrió → procede recordar).
 *   null  → NO concluyente: sin email/etiqueta, sin cuenta con API key, systeme.io no
 *           respondió (429/timeout/5xx), o se pidió la cuenta REAL y solo hay sandbox.
 * El llamante NO debe recordar cuando es null (si no, un fallo de red recordaría a quien
 * SÍ abrió). Nunca lanza.
 */
export async function contactHasSystemeioTag(
  email: string,
  tagName: string,
  opts?: { accountId?: string; targetPlatform?: string },
): Promise<boolean | null> {
  const mail = String(email || "").trim().toLowerCase();
  const target = String(tagName || "").trim().toLowerCase();
  if (!mail || !target) return null;
  const acct = await resolveSyncAccount(opts?.accountId, opts?.targetPlatform);
  if (!acct?.apiKey) return null;
  // Guard sandbox: si se pidió la cuenta REAL y no había ninguna conectada,
  // resolveSyncAccount cae en getActiveAccount()=list[0]=leadmatch-lab (sandbox del
  // curso). NO leemos la etiqueta de un lead real contra el sandbox → no concluyente.
  if (!opts?.accountId) {
    const wantsReal = !!opts?.targetPlatform && !opts.targetPlatform.toLowerCase().includes("leadmatch-lab");
    const isSandbox = String(acct.panelBaseUrl || "").toLowerCase().includes("leadmatch-lab");
    if (wantsReal && isSandbox) return null;
  }
  return withPublicApiKey(acct.apiKey, async () => {
    const { reachable, contact } = await findContactByEmailResult(mail);
    if (!reachable) return null; // systeme.io no respondió → NO concluyente (no recordar)
    return !!contact?.tags?.some((t) => String(t?.name || "").trim().toLowerCase() === target);
  });
}

const dbUrl = process.env.DATABASE_URL;
const pg_pool = dbUrl
  ? new pg.default.Pool({
      connectionString: dbUrl,
      ssl: pgSsl(),
      max: 2,
    })
  : null;

const memJobs = new Map<string, McpJob>();

export interface McpJob {
  id: string;
  tenant_id: string;
  kind: McpJobKind;
  payload: Record<string, unknown>;
  status: McpJobStatus;
  result: Record<string, unknown>;
  error: string;
  attempts: number;
  next_run: number;
  created_at: number;
  updated_at: number;
  /** Clave de idempotencia ('' = sin dedupe): dos encolados con la misma clave
   *  mientras el primero siga 'queued' devuelven el MISMO job. */
  dedupe_key: string;
}

export type McpJobKind = "contact-upsert" | "contact-pull" | "page-publish";
export type McpJobStatus = "queued" | "running" | "done" | "error" | "awaiting_config";

export interface QueueOpts {
  kind: McpJobKind;
  payload: Record<string, unknown>;
  tenant_id?: string;
  /** Idempotencia opcional: mismo (tenant, kind, dedupe_key) con un job aún
   *  'queued' → no se encola otro, se devuelve el id del que ya espera. */
  dedupe_key?: string;
}

/* ============================================================
 * Persistencia de la cola (igual que antes).
 * ============================================================ */

export async function queueMcpJob(opts: QueueOpts): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const job: McpJob = {
    id,
    // TENANT-COLA-1 · El tenant por defecto es el del scope ALS activo, NO
    // 'default': los encolados del panel (alta/edición/ficha) no lo pasaban y
    // el worker acababa ejecutando el job dentro del workspace 'default' —
    // leyendo las cuentas systeme.io de OTRO negocio (flows.ts ya lo parcheaba
    // por su cuenta llamándolo «fuga cross-tenant en la cola»).
    tenant_id: opts.tenant_id ?? currentWorkspaceId(),
    kind: opts.kind,
    payload: opts.payload,
    status: "queued",
    result: {},
    error: "",
    attempts: 0,
    next_run: now,
    created_at: now,
    updated_at: now,
    dedupe_key: opts.dedupe_key ?? "",
  };
  if (!pg_pool) {
    if (job.dedupe_key) {
      const dup = [...memJobs.values()].find(
        (j) => j.status === "queued" && j.tenant_id === job.tenant_id && j.kind === job.kind && j.dedupe_key === job.dedupe_key,
      );
      if (dup) {
        // El payload del job que espera se REFRESCA con el guardado más
        // reciente: si no, una segunda edición (nueva fecha de la cita) se
        // perdía y el job procesaba la cita vieja — la nueva se quedaba en
        // «pending» para siempre porque su desenlace nunca casaba.
        dup.payload = job.payload;
        dup.updated_at = Date.now();
        return dup.id;
      }
    }
    memJobs.set(id, job);
    return id;
  }
  // Con dedupe: primero intenta REFRESCAR el payload del job que ya espera
  // (última edición manda); si no hay ninguno, INSERT con ON CONFLICT contra
  // el índice único parcial. El bucle cubre la carrera de que el job en cola
  // sea reclamado por el worker entre medias (2ª vuelta: ya no está 'queued'
  // y el INSERT entra limpio).
  for (let intento = 0; intento < 2; intento++) {
    if (job.dedupe_key) {
      const upd = await pg_pool.query(
        `UPDATE app_mcp_jobs SET payload=$4::jsonb, updated_at=now()
         WHERE tenant_id=$1 AND kind=$2 AND dedupe_key=$3 AND status='queued' RETURNING id`,
        [job.tenant_id, job.kind, job.dedupe_key, JSON.stringify(job.payload)],
      );
      if (upd.rowCount) return String(upd.rows[0].id);
    }
    const ins = await pg_pool.query(
      `INSERT INTO app_mcp_jobs (id,tenant_id,kind,payload,status,result,error,attempts,next_run,created_at,updated_at,dedupe_key)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8,to_timestamp($9/1000.0),to_timestamp($10/1000.0),to_timestamp($11/1000.0),$12)
       ON CONFLICT DO NOTHING RETURNING id`,
      [id, job.tenant_id, job.kind, JSON.stringify(job.payload), job.status, JSON.stringify(job.result), job.error, job.attempts, job.next_run, job.created_at, job.updated_at, job.dedupe_key],
    );
    if (ins.rowCount) return id;
  }
  // Dos vueltas perdidas contra la carrera: encola sin dedupe antes que perder
  // el guardado (el upsert remoto es idempotente por email).
  const idLibre = crypto.randomUUID();
  await pg_pool.query(
    `INSERT INTO app_mcp_jobs (id,tenant_id,kind,payload,status,result,error,attempts,next_run,created_at,updated_at,dedupe_key)
     VALUES ($1,$2,$3,$4::jsonb,'queued','{}'::jsonb,'',0,now(),now(),now(),'')`,
    [idLibre, job.tenant_id, job.kind, JSON.stringify(job.payload)],
  );
  return idLibre;
}

export async function listMcpJobs(limit = 50, opts?: { tenantId?: string }): Promise<McpJob[]> {
  const tenantId = opts?.tenantId;
  if (!pg_pool) {
    let rows = [...memJobs.values()];
    if (tenantId) rows = rows.filter((j) => (j.tenant_id || "default") === tenantId);
    return rows.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }
  // SEC-1: filtra tenant_id en SQL cuando se proporciona — rowToJob ya expone
  // tenant_id real (no 'default' fallback) para que filterEvents/mapper puedan
  // descartar fugas cross-tenant.
  const params: unknown[] = [];
  let where = "";
  if (tenantId) { params.push(tenantId); where = ` WHERE tenant_id=$${params.length}`; }
  params.push(limit);
  const r = await pg_pool.query(
    `SELECT id,tenant_id,kind,payload,status,result,error,attempts,dedupe_key,
       extract(epoch from next_run)*1000 next_run,
       extract(epoch from created_at)*1000 created_at,
       extract(epoch from updated_at)*1000 updated_at
     FROM app_mcp_jobs${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(rowToJob);
}

/** FORMULARIOS-1 · Estado de unos jobs concretos del workspace (id → estado y motivo).
 *  Solo lectura; lo usa la vista de respuestas para decir si la copia a la web llegó. */
export async function mcpJobsEstado(ids: string[], tenantId: string): Promise<Record<string, { status: McpJobStatus; error: string; skipped: string }>> {
  const out: Record<string, { status: McpJobStatus; error: string; skipped: string }> = {};
  const want = [...new Set(ids.filter(Boolean))].slice(0, 500);
  if (!want.length) return out;
  const pon = (j: McpJob) => {
    const res = (j.result || {}) as Record<string, unknown>;
    out[j.id] = { status: j.status, error: String(j.error || ""), skipped: res.skipped ? String(res.reason || "no se copió") : "" };
  };
  if (!pg_pool) {
    for (const id of want) { const j = memJobs.get(id); if (j && (j.tenant_id || "default") === tenantId) pon(j); }
    return out;
  }
  const r = await pg_pool.query(
    `SELECT id,tenant_id,kind,payload,status,result,error,attempts,dedupe_key,
       extract(epoch from next_run)*1000 next_run,
       extract(epoch from created_at)*1000 created_at,
       extract(epoch from updated_at)*1000 updated_at
     FROM app_mcp_jobs WHERE tenant_id=$1 AND id = ANY($2::text[])`,
    [tenantId, want],
  );
  for (const row of r.rows) pon(rowToJob(row));
  return out;
}

async function pickDueJobs(): Promise<McpJob[]> {
  if (!pg_pool) {
    const now = Date.now();
    return [...memJobs.values()].filter(
      (j) => (j.status === "queued" || j.status === "awaiting_config") && j.next_run <= now,
    ).slice(0, 3);
  }
  // CLAIM ATÓMICO · el SELECT-luego-UPDATE de antes dejaba que dos workers
  // cogieran EL MISMO job a la vez (dos upserts contra la web, etiqueta
  // re-disparada dos veces). El UPDATE con SKIP LOCKED reclama y devuelve en
  // una sola sentencia: cada job lo ejecuta exactamente un worker.
  // Se reclaman también:
  //  - 'awaiting_config' vencidos: executeJob les pone next_run +5 min, pero
  //    nadie los recogía jamás — «requiere configuración» era una lápida en
  //    vez de un estado del que se sale arreglando la config.
  //  - 'running' huérfanos (>15 min sin tocar): un proceso muerto a mitad de
  //    job lo dejaba clavado en running para siempre. El claim los suelta con
  //    dedupe vacío para no chocar con guardados nuevos en cola.
  const r = await pg_pool.query(
    `UPDATE app_mcp_jobs SET status='running', updated_at=now(), dedupe_key=''
     WHERE id IN (
       SELECT id FROM app_mcp_jobs
       WHERE ((status='queued' OR status='awaiting_config') AND next_run<=now())
          OR (status='running' AND updated_at < now() - interval '15 minutes')
       ORDER BY next_run ASC LIMIT 3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id,tenant_id,kind,payload,status,result,error,attempts,dedupe_key,
       extract(epoch from next_run)*1000 next_run,
       extract(epoch from created_at)*1000 created_at,
       extract(epoch from updated_at)*1000 updated_at`,
  );
  return r.rows.map(rowToJob);
}

function rowToJob(r: Record<string, unknown>): McpJob {
  return {
    id: r.id as string,
    tenant_id: (r.tenant_id as string) ?? "default",
    kind: r.kind as McpJobKind,
    payload: (r.payload as Record<string, unknown>) ?? {},
    status: r.status as McpJobStatus,
    result: (r.result as Record<string, unknown>) ?? {},
    error: (r.error as string) ?? "",
    attempts: Number(r.attempts ?? 0),
    next_run: Number(r.next_run),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    dedupe_key: (r.dedupe_key as string) ?? "",
  };
}

async function updateJob(id: string, patch: Partial<McpJob>): Promise<void> {
  if (!pg_pool) {
    const j = memJobs.get(id);
    if (!j) return;
    Object.assign(j, patch, { updated_at: Date.now() });
    return;
  }
  const set: string[] = ["updated_at=now()"];
  const args: unknown[] = [id];
  const add = (col: string, val: unknown, cast = "") => {
    args.push(val);
    set.push(`${col}=$${args.length}${cast}`);
  };
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.result !== undefined) add("result", JSON.stringify(patch.result), "::jsonb");
  if (patch.error !== undefined) add("error", patch.error);
  if (patch.attempts !== undefined) add("attempts", patch.attempts);
  if (patch.dedupe_key !== undefined) add("dedupe_key", patch.dedupe_key);
  if (patch.next_run !== undefined) {
    args.push(patch.next_run);
    set.push(`next_run=to_timestamp($${args.length}/1000.0)`);
  }
  await pg_pool.query(`UPDATE app_mcp_jobs SET ${set.join(",")} WHERE id=$1`, args);
}

/* ============================================================
 * Cliente HTTP JSON-RPC directo al MCP.
 * ============================================================ */

// SIN-DEFAULTS-LM-1 · Aquí había cableado `https://systemeio-mcp.ingenierobinario.com/mcp`,
// que es el servidor del operador. El puente le manda el correo y la contraseña de
// systeme.io del workspace para abrir sesión, así que ese defecto significaba que las
// credenciales de un cliente salían hacia una máquina que no es suya sin que nadie lo
// hubiera pedido. Ahora la dirección no se hereda: si no está en el ajuste `mcp.url`,
// el puente se queda apagado y lo dice.
function mcpUrl(): string {
  return (getSetting("mcp.url") || "").trim();
}

function mcpAuthHeaders(): Record<string, string> {
  const token = getSetting("mcp.token") || "";
  if (!token) return {};
  // MCP-DESTINO-1 · el defecto tiene que casar con el servidor al que apunta
  // el ajuste `mcp.url`. `systemeio-mcp` autentica con la cabecera
  // `X-Internal-Secret` a pelo (así lo documenta su README y así responde:
  // verificado 2026-09-01 — con `Authorization: Bearer` devuelve 401). El
  // defecto anterior era `Authorization: Bearer`, de la época en que el puente
  // hablaba con otro servidor: producción funciona porque tiene el ajuste
  // `mcp.authHeader` puesto a mano, pero un despliegue nuevo que configurase
  // sólo `mcp.token` se llevaba un 401 sin pista de por qué.
  const header = getSetting("mcp.authHeader") || "X-Internal-Secret";
  const prefix = getSetting("mcp.authPrefix");
  // Con `Authorization` y sin prefijo explícito se asume Bearer, que es lo que
  // espera casi todo lo demás.
  const value = (prefix !== null && prefix !== undefined)
    ? `${prefix}${token}`
    : (header.toLowerCase() === "authorization" ? `Bearer ${token}` : token);
  return { [header]: value };
}

let _msgId = 1000;
function nextId(): number { return ++_msgId; }

interface McpRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function mcpRpc(body: Record<string, unknown>, sessionId?: string, timeoutMs = 20000): Promise<{ data: McpRpcResponse | null; sessionId: string | null; status: number; raw?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...mcpAuthHeaders(),
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  // Timeout: una llamada MCP colgada no debe bloquear el worker indefinidamente.
  // OJO: las tools de página manejan un navegador Playwright (login + navigate
  // + save) y tardan 30-90s legítimamente — el caller elige el timeout.
  const url = mcpUrl();
  // PUENTE-EDITOR-1 (SIO-API-F9) · apagado en este negocio: no se llama a nadie.
  if (url && puenteApagado()) {
    return { data: { jsonrpc: "2.0", error: { code: -32003, message: MOTIVO_PUENTE_APAGADO } }, sessionId: sessionId || null, status: 0 };
  }
  if (!url) {
    // SIN-DEFAULTS-LM-1 · sin dirección no se llama a nadie: antes se caía en el
    // servidor del operador por defecto. Se devuelve como error de RPC para que el
    // caller lo pinte igual que cualquier otro fallo del puente.
    return { data: { jsonrpc: "2.0", error: { code: -32002, message: "El puente de systeme.io no tiene dirección configurada (ajuste `mcp.url`, lo pone el administrador del sistema)." } }, sessionId: sessionId || null, status: 0 };
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const newSid = res.headers.get("mcp-session-id") || sessionId || null;
  if (res.status === 202) return { data: null, sessionId: newSid, status: 202 };
  const txt = await res.text();
  let data: McpRpcResponse | null = null;
  try { data = JSON.parse(txt); } catch { /* keep raw */ }
  if (res.status === 401) {
    return { data: { jsonrpc: "2.0", error: { code: -32001, message: `MCP 401 Unauthorized — revisa mcp.token / mcp.authHeader. URL: ${mcpUrl()}` } }, sessionId: newSid, status: res.status, raw: txt };
  }
  return { data, sessionId: newSid, status: res.status, raw: txt };
}

/** Handshake completo: devuelve session id. */
async function mcpInitSession(): Promise<string> {
  const initR = await mcpRpc({
    jsonrpc: "2.0",
    id: nextId(),
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "business-stack", version: "0.2.0" },
    },
  });
  if (!initR.sessionId) throw new Error("MCP no devolvió sessionId en initialize");
  if (initR.data?.error) throw new Error(`MCP initialize error: ${initR.data.error.message}`);
  // El cliente debe notificar initialized antes de poder llamar tools.
  await mcpRpc({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }, initR.sessionId);
  return initR.sessionId;
}

/** Llama un tool y devuelve el resultado parseado del primer content.text. */
async function callTool(sessionId: string, name: string, args: Record<string, unknown>): Promise<{ raw: McpRpcResponse | null; text: string; json: Record<string, unknown> | null; isError: boolean }> {
  // 120s: login-start / list-funnel-steps / replace-page-html abren navegador
  // en el MCP; con 20s el bridge abortaba publishes legítimos ("The operation
  // was aborted due to timeout") justo durante el login en el panel.
  const r = await mcpRpc({
    jsonrpc: "2.0",
    id: nextId(),
    method: "tools/call",
    params: { name, arguments: args },
  }, sessionId, 120000);
  if (r.data?.error) {
    return { raw: r.data, text: r.data.error.message, json: null, isError: true };
  }
  const result = r.data?.result as Record<string, unknown> | undefined;
  const content = (result?.content as Array<Record<string, unknown>>) || [];
  let text = content.filter((c) => c.type === "text").map((c) => String(c.text || "")).join("\n");
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  // Las tools del MCP envuelven errores en {ok:false, error:{message,details}}
  // vía mcpResult(err(...)) SIN marcar isError a nivel protocolo MCP. Sin esto,
  // un rechazo de gate (ANTI_SYSTEMEIO_RESETS, NATIVE_FORM_REQUIRED, etc.) se
  // colaba como éxito silencioso. Lo tratamos como error y exponemos el mensaje
  // humano (student_message_literal > message) en `text` para los throws aguas abajo.
  let isError = !!result?.isError;
  if (json && (json as Record<string, unknown>).ok === false) {
    isError = true;
    const env = (json as Record<string, unknown>).error as Record<string, unknown> | undefined;
    if (env && typeof env === "object") {
      const det = (env.details && typeof env.details === "object") ? env.details as Record<string, unknown> : {};
      // det.message lleva el error REAL cuando el MCP envuelve un throw con
      // message genérico "Tool reported error" (catch de la tool). Va antes que
      // env.message para no perder la causa real.
      text = String(det.student_message_literal || det.studentMessageLiteral || det.message || env.message || text);
    }
  }
  return { raw: r.data ?? null, text, json, isError };
}

/* ============================================================
 * Estado del bridge.
 * ============================================================ */

/** PUENTE-EDITOR-1 (SIO-API-F9) · el puente del editor (systemeio-mcp: páginas, destinatarios,
 *  workflows, pipelines) se puede apagar por negocio con el ajuste `systemeio.puenteEditor` = "0".
 *  Sin valor sigue como estaba: encendido donde el administrador puso la dirección del puente
 *  (`mcp.url`, global), que hoy es solo la instancia central; en las de cliente ya no hay puente.
 *  La cola (contact-upsert por la API oficial) NO depende de esto: el worker arranca siempre. */
export function puenteApagado(): boolean {
  return (getSetting("systemeio.puenteEditor") || "").trim() === "0";
}
export const MOTIVO_PUENTE_APAGADO = "El editor de systeme.io está apagado en este negocio: las páginas, los destinatarios, los workflows y los pipelines de la web no se leen desde aquí. Lo demás (contactos, etiquetas, correos y ventas) va por la clave de la web.";
export function bridgeStatus(): { live: boolean; reason?: string; mode: "direct-http"; url: string } {
  const url = mcpUrl();
  if (url && puenteApagado()) return { live: false, mode: "direct-http", url, reason: MOTIVO_PUENTE_APAGADO };
  if (!url) {
    return { live: false, mode: "direct-http", url, reason: "Falta la dirección del puente de systeme.io (ajuste `mcp.url`, lo pone el administrador del sistema)." };
  }
  const token = getSetting("mcp.token");
  if (!token) {
    return { live: false, mode: "direct-http", url, reason: "Falta `mcp.token` (token de auth del MCP, p.ej. INTERNAL_API_SECRET del Railway service)." };
  }
  // IDENTIDAD-PUENTE-1 · aquí había cableados el correo y la contraseña del
  // owner, así que `live` salía true en CUALQUIER workspace aunque no tuviera
  // acceso propio — y luego bootstrapSession operaba con esa identidad.
  // Ahora hay puente si hay identidad de verdad, y la identidad puede vivir en
  // los ajustes del workspace O en una cuenta concreta (el caso normal: las
  // cuentas son `autologin` y llevan su propio correo y contraseña).
  const gEmail = getSetting("systemeio.sandboxEmail");
  const gPass = getSetting("systemeio.sandboxPass");
  if (gEmail && gPass) return { live: true, mode: "direct-http", url };
  // Lectura SÍNCRONA del almacén de cuentas (es un ajuste JSON): bridgeStatus
  // se llama desde sitios que no pueden esperar, así que no se usa la vía async.
  let algunaCuenta = false;
  try {
    const raw = getSetting("systemeio.accounts");
    if (raw) {
      const arr = JSON.parse(raw) as Array<{ sandboxEmail?: string; sandboxPass?: string }>;
      algunaCuenta = Array.isArray(arr) && arr.some((a) => !!(a && a.sandboxEmail && a.sandboxPass));
    }
  } catch { /* JSON mal formado: se trata como «sin cuentas», igual que listAccounts */ }
  if (algunaCuenta) return { live: true, mode: "direct-http", url };
  return { live: false, mode: "direct-http", url, reason: "Ninguna web de este espacio tiene acceso configurado: añade su correo y contraseña en Conexiones." };
}

/* ============================================================
 * Job executors (uno por kind).
 * ============================================================ */

interface SessionCtx {
  sid: string;
  studentId: string;
  email: string;
  pass: string;
  gateCode: string;
  adminKey: string;
}

/** Resuelve el panel_base_url según el target_platform del job/draft. */
function resolvePanelUrl(targetPlatform?: string): string {
  // SIN-DEFAULTS-LM-1 · la rama `leadmatch-lab` devolvía el laboratorio del operador.
  // Ya no existe destino de pruebas: todo va a systeme.io salvo dominio propio.
  if (targetPlatform === "systemeio" || targetPlatform === "leadmatch-lab") return "https://systeme.io";
  return getSetting("systemeio.panelBaseUrl") || "https://systeme.io";
}

// Cache de sesión MCP por accountId: evitar el coste de mcpInitSession +
// session-status check + (peor) login-start en cada llamada. TTL 20 min
// (las sesiones server-side caducan a los ~30 min, dejamos margen).
const sessionCache = new Map<string, { ctx: SessionCtx; ts: number }>();
const SESSION_TTL_MS = 20 * 60 * 1000;

// ── Cierre de las sesiones MCP que el bridge abandona ───────────────────────
// El bridge rota su sesión cada SESSION_TTL_MS: al caducar la entrada del
// cache, bootstrapSession abre otra con mcpInitSession() y hasta ahora la
// anterior se quedaba huérfana. systemeio-mcp guarda cada transport en un
// Record sin TTL ni barrido (server.ts:840) y su ÚNICA purga es
// transport.onclose (server.ts:869), que el SDK solo dispara al atender un
// DELETE /mcp (server.ts:900). Es decir: cada rotación dejaba allí un
// McpServer completo residente hasta el siguiente despliegue, del orden de
// 2 MB de RSS cada uno. Con el warm anterior eso eran ~140 MB/día que no se
// recuperaban nunca — la mayor parte de los 1,96 GB que factura el servicio.
//
// Se cierra con RETARDO, nunca al instante: bootstrapSession devuelve el ctx
// POR REFERENCIA y hay tools que manejan Playwright y tardan 30-90 s de forma
// legítima (por eso callTool usa 120 s de timeout). Un DELETE inmediato
// cerraría el transporte de una llamada en vuelo y su respuesta no se
// entregaría jamás, aunque el efecto en systeme.io sí se hubiera aplicado.
const ABANDONED_GRACE_MS = Math.max(
  30_000,
  Number(process.env.MCP_SESSION_CLOSE_GRACE_MS || 150_000) || 150_000,
);
/** Escotilla: MCP_SESSION_CLOSE=0 vuelve a abandonarlas sin cerrar. */
const CLOSE_ABANDONED = process.env.MCP_SESSION_CLOSE !== "0";
const closingSessions = new Set<string>();

/** Cierra en el MCP una sesión que este proceso ya no va a volver a usar. */
function closeAbandonedSession(sid?: string | null): void {
  if (!CLOSE_ABANDONED || !sid || closingSessions.has(sid)) return;
  closingSessions.add(sid);
  const t = setTimeout(() => {
    void (async () => {
      try {
        const res = await fetch(mcpUrl(), {
          method: "DELETE",
          headers: { ...mcpAuthHeaders(), "Mcp-Session-Id": sid },
          signal: AbortSignal.timeout(15_000),
        });
        // 400 = el MCP ya no conoce ese sid (se reinició, o nunca existió):
        // no hay nada que liberar y no es un error que merezca ruido.
        if (res.ok) console.log("[mcp-bridge] sesión MCP abandonada cerrada:", sid.slice(0, 8));
      } catch {
        /* MCP caído o reiniciado: entonces su memoria ya está liberada igual. */
      } finally {
        closingSessions.delete(sid);
      }
    })();
  }, ABANDONED_GRACE_MS);
  t.unref?.();
}

export function invalidateSystemeioSession(accountId?: string): void {
  // Las claves del cache son `${workspaceId}|${accountId}|${targetPlatform}`
  // (el workspace se añadió en IDENTIDAD-PUENTE-1). Se compara por el SEGMENTO
  // de la cuenta, no por prefijo: con el prefijo de workspace delante, un
  // `startsWith(accountId)` no acertaría nunca — que es exactamente el no-op
  // que ya tuvo esta función una vez.
  if (accountId) {
    for (const k of [...sessionCache.keys()]) {
      if (k === accountId || k.split("|").indexOf(accountId) >= 0) {
        // Cierra la sesión en el MCP antes de soltarla: borrarla solo del
        // cache dejaba el McpServer residente allí para siempre.
        closeAbandonedSession(sessionCache.get(k)?.ctx.sid);
        sessionCache.delete(k);
      }
    }
  } else {
    // Rama SIN accountId: es el camino «sesión MCP perdida» (el MCP se
    // reinició). Esos sids o ya están muertos, o pertenecen a otras cuentas
    // que siguen sanas. NO se cierran en masa a propósito: convertiría un
    // fallo transitorio en una cascada de re-inicializaciones.
    sessionCache.clear();
  }
}

async function bootstrapSession(
  opts?: string | { targetPlatform?: string; accountId?: string },
): Promise<SessionCtx> {
  const targetPlatform = typeof opts === "string" ? opts : opts?.targetPlatform;
  const accountId = typeof opts === "string" ? undefined : opts?.accountId;
  // Resuelve la cuenta: pasada explícitamente > activa (primera del array) >
  // fallback a settings sueltos (compat con código pre multi-cuenta).
  let acc: SiAccount | null = null;
  if (accountId) {
    acc = await siGetAccount(accountId);
    if (!acc) throw new Error("La cuenta de systeme.io no existe en este negocio");
  }
  if (!acc) acc = await siGetActiveAccount();
  // IDENTIDAD-PUENTE-1 · el workspace VA en la clave. Los ids de cuenta son 8
  // hex generados por workspace: dos espacios distintos podían coincidir y
  // compartir sesión (y por tanto credenciales). Poco probable, consecuencia
  // total — y la entrada cacheada guarda correo y contraseña.
  const cacheKey = currentWorkspaceId() + "|" + (acc?.id || "legacy") + "|" + (targetPlatform || "");
  const cached = sessionCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SESSION_TTL_MS) {
    return cached.ctx;
  }
  // Caducada: su sesión queda huérfana en el servidor MCP. La sacamos ya del
  // cache (para que dos llamadas concurrentes no programen dos cierres del
  // mismo sid) y la cerramos con retardo.
  if (cached) {
    sessionCache.delete(cacheKey);
    closeAbandonedSession(cached.ctx.sid);
  }
  const sid = await mcpInitSession();
  // IDENTIDAD-PUENTE-1 · NADA de identidad cableada.
  // Aquí había un último recurso con el correo y la contraseña del owner
  // escritos a mano: un workspace SIN acceso propio configurado acababa
  // operando contra la cuenta systeme.io del owner.
  // Y como `pass` caía a "", no se forzaba login: se aprovechaba la sesión que
  // el warmTick mantiene caliente desde el workspace del owner, así que el
  // cliente veía SUS correos y SUS métricas como si fueran propios.
  // Es el mismo patrón que el bug histórico del proyecto (fuera de contexto,
  // las credenciales caían en silencio a las principales): se falla explícito.
  const email = acc?.sandboxEmail || getSetting("systemeio.sandboxEmail") || "";
  const pass = acc?.sandboxPass || getSetting("systemeio.sandboxPass") || "";
  if (!email) {
    throw new Error(
      acc
        ? `La web «${acc.label || acc.id}» no tiene acceso configurado: añade su correo y contraseña en Conexiones → esa cuenta.`
        : "Ninguna web de este espacio tiene acceso configurado: añádelo en Conexiones.",
    );
  }
  const panelUrl = acc?.panelBaseUrl || resolvePanelUrl(targetPlatform);

  // 1. Primero comprobar si la sesión MCP ya está viva para este student_id
  //    (el MCP guarda cookies por student_id; si el user ya operó antes con
  //    esta cuenta o tiene sesión activa, no hace falta volver a login).
  //    EXCEPCIÓN: si la cuenta del multi-store define su propio panelBaseUrl y
  //    tenemos credenciales, vamos SIEMPRE a login-start contra ese panel.
  //    session-status (getStatus) dice "ready" sin validar a qué dominio
  //    pertenecen las cookies guardadas → tras mover una cuenta de systeme.io
  //    a leadmatch-lab el shortcut saltaba el login y las tools recibían el
  //    HTML del login ("Unexpected token '<'"). El sessionCache de 20 min
  //    evita logins en cascada.
  let sessionActive = false;
  const forceLoginOnPanel = !!(acc?.panelBaseUrl && pass);
  if (!forceLoginOnPanel) try {
    const st = await callTool(sid, "session-status", { student_id: email });
    if (!st.isError) {
      const data = (st.json as any)?.data || st.json;
      // MCP-CLIENTES-1 · el servidor devuelve {state:'ready'|'not_logged_in'|'awaiting_2fa'}
      // (session.ts) y aquí se leía SOLO `status`: sessionActive era siempre false y se
      // hacía un login-start con navegador en cada rotación de caché (20 min). Se aceptan
      // los dos nombres; systemeio-mcp-customers además devuelve ya `status` como alias.
      const status = String((data && (data.status ?? data.state)) || "").toLowerCase();
      // Estados del servidor: ready | not_logged_in | awaiting_2fa. Solo «ready» (o sus
      // sinónimos exactos) es sesión viva: «not_logged_in» CONTIENE «logged» y con el
      // regex anterior una cuenta sin sesión pasaba por activa (auto-connect daba ok con
      // una contraseña falsa sin llegar a intentar el login).
      sessionActive = /^(ready|logged_in|active|ok)$/.test(status);
    }
  } catch { /* ignorar: fallback al login */ }

  // 2. Si la sesión ya está activa → no tocamos nada y devolvemos contexto.
  if (sessionActive) {
    const ctx = { sid, studentId: email, email, pass, gateCode: "", adminKey: "" };
    sessionCache.set(cacheKey, { ctx, ts: Date.now() });
    return ctx;
  }

  // 3. Sesión inactiva: solo intentamos login-start si hay credenciales como
  //    fallback. Sin credenciales → error accionable.
  if (!pass) {
    throw new Error(
      "No hay sesión abierta con " + email + " ni acceso de reserva guardado. " +
      "Inicia sesión en " + panelUrl + " desde el navegador y el puente reutilizará esa sesión. " +
      "El acceso de reserva lo configura el administrador del stack.",
    );
  }
  const login = await callTool(sid, "login-start", {
    student_id: email,
    systemeio_email: email,
    systemeio_password: pass,
    panel_base_url: panelUrl,
  });
  if (login.isError) throw new Error(`login-start falló: ${login.text.slice(0, 300)}`);
  if (login.json && (login.json as any).data?.status === "2fa_required") {
    throw new Error("login pide 2FA — desactívalo en la cuenta o reaute manualmente via el panel del MCP");
  }
  // MCP-CLIENTES-1 · login-start también termina en «invalid_credentials» o «unknown_state»
  // con ok:true (server.ts): aquí sólo se miraba el 2FA, así que una contraseña MALA se
  // guardaba como cuenta válida y fallaba más tarde en la primera herramienta.
  const loginStatus = String((login.json as any)?.data?.status || "").toLowerCase();
  if (loginStatus === "invalid_credentials") {
    throw new Error("systeme.io rechazó el correo o la contraseña de esta cuenta. Revísalos en Conexiones → Webs, o conecta con la clave de API.");
  }
  if (loginStatus && loginStatus !== "ready") {
    throw new Error("No se pudo confirmar el acceso a systeme.io (" + loginStatus + "). Prueba de nuevo o conecta con la clave de API.");
  }
  const ctx = { sid, studentId: email, email, pass, gateCode: "", adminKey: "" };
  sessionCache.set(cacheKey, { ctx, ts: Date.now() });
  return ctx;
}

// Cache de métricas por accountId. Evita re-pegar 7 tools MCP en cada refresh
// de la card de Conexiones / dashboard widget.
// TTL = 5 min — los counts (contacts/tags/funnels/sales) son de movimiento lento,
// no necesitamos refrescar cada minuto; el botón 'Actualizar' invalida bajo
// demanda cuando el user quiere data fresca.
const metricsCache = new Map<string, { m: SiMcpMetrics; ts: number }>();
const metricsEnCurso = new Map<string, Promise<SiMcpMetrics | null>>();
let metricsRevision = 0;
const METRICS_TTL_MS = 5 * 60 * 1000;

export function invalidateSystemeioMetrics(accountId?: string): void {
  metricsRevision++;
  const prefijo = currentWorkspaceId() + "|";
  for (const k of metricsCache.keys()) if (accountId ? k === prefijo + accountId || k === prefijo + "legacy" : k.startsWith(prefijo)) metricsCache.delete(k);
  for (const k of metricsEnCurso.keys()) if (accountId ? k === prefijo + accountId || k === prefijo + "legacy" : k.startsWith(prefijo)) metricsEnCurso.delete(k);
}

function guardarMetricasPuente(clave: string, m: SiMcpMetrics, revision: number): void {
  if (revision !== metricsRevision) return; // Una respuesta antigua no revive una cuenta desconectada.
  const ahora = Date.now();
  for (const [k, v] of metricsCache) if (ahora - v.ts >= METRICS_TTL_MS) metricsCache.delete(k);
  metricsCache.delete(clave);
  metricsCache.set(clave, { m, ts: ahora });
  while (metricsCache.size > 128) metricsCache.delete(metricsCache.keys().next().value!);
}

/** Fetch funnels para el account dado (sin caché — el caller decide). */
export async function fetchSystemeioFunnels(
  accountId?: string,
): Promise<Array<{ id: string | number; name: string }>> {
  // 2026-08-19 · MIGRACIÓN A API OFICIAL: con API key en la cuenta, los funnels
  // salen de GET /api/funnels directo (REST, sin sesión MCP ni autologin — el
  // bootstrap podía disparar un login Playwright entero solo para un dropdown).
  // El MCP queda como fallback para cuentas sin key. Objetivo declarado: ir
  // quitando dependencia del systemeio-mcp allí donde la API oficial ya cubre.
  try {
    const acc = accountId ? await siGetAccount(accountId) : await siGetActiveAccount();
    if (acc?.apiKey) {
      const funnels = await withPublicApiKey(acc.apiKey, () => siListFunnelsPublic());
      // FALSO-CERO-1: null (API caída/403) o lista vacía → NO devolvemos un
      // desplegable vacío; se prueba el MCP, que es lo que había antes.
      if (funnels && funnels.length) {
        return funnels.map((f) => ({ id: f.id, name: String(f.name || "(sin nombre)").slice(0, 80) }));
      }
    }
  } catch { /* SIO-API-F5 · sin respaldo por el puente: la API oficial es la única vía */ }
  return [];
}

/** Fetch steps (pages) de un funnel. Incluye pageId/type/publicUrl para que el
 * panel pueda auto-rellenar el page id al elegir step (sin que el user busque el
 * número) y marcar las páginas no publicables (page.id ausente o === stepId, p.ej.
 * "Página de agradecimiento" especial). El dropdown sigue usando id+name. */
const slugDeUrl = (url: string): string => {
  try { return /^https?:\/\//i.test(url) ? decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "") : ""; }
  catch { return ""; }
};

export async function fetchSystemeioFunnelSteps(
  funnelId: string | number,
  accountId?: string,
): Promise<Array<{ id: string | number; name: string; pageId?: string; type?: string; publicUrl?: string; slug?: string }>> {
  // PUENTE-API-1 · API oficial primero (GET /api/funnels/{id}/steps): sin sesión
  // del systemeio-mcp. Mismos campos que devolvía el MCP (stepId, pageId, type, url).
  try {
    const acc = accountId ? await siGetAccount(accountId) : await siGetActiveAccount();
    if (acc?.apiKey) {
      const steps = await withPublicApiKey(acc.apiKey, () => siListFunnelStepsPublic(funnelId));
      // FALSO-CERO-1: null (API caída) o [] → se prueba el MCP, como antes.
      if (steps && steps.length) {
        return steps.map((s) => ({
          id: s.id,
          name: String(s.name || s.type || "(sin nombre)").slice(0, 80),
          pageId: s.pageId,
          type: s.type,
          publicUrl: s.url,
          // SIO-API-F6 · la API no da slug: se INFIERE del último segmento de la url pública
          // (pageId y url pueden llegar null: entonces no hay slug).
          slug: slugDeUrl(s.url),
        }));
      }
    }
  } catch { /* SIO-API-F5 · sin respaldo por el puente: la API oficial es la única vía */ }
  return [];
}

/**
 * Sincroniza el catálogo de etiquetas con systeme.io para la cuenta dada:
 *  - importa las tags que existen en systeme.io y no tenemos localmente,
 *  - crea en systeme.io las tags locales que allí no existen.
 * Devuelve qué se importó / creó. Lanza si la sesión no se puede establecer
 * (p.ej. rate-limit) → el caller lo traduce a error accionable.
 */
export async function syncSystemeioTags(
  accountId: string | undefined,
  localTags: string[],
): Promise<{
  pulled: string[];
  pushed: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
  total: number;
  account: { email: string; panelBaseUrl: string };
}> {
  const acc0 = accountId ? await siGetAccount(accountId) : await siGetActiveAccount();

  // CAMINO PREFERENTE: API pública oficial (REST). Es fiable y verificable, al
  // contrario que la tool create-tag del MCP (que va por navegador y es la que
  // estaba fallando en silencio en producción).
  if (acc0?.apiKey) {
    const account = { email: acc0.accountEmail || acc0.sandboxEmail || "", panelBaseUrl: acc0.panelBaseUrl || "" };
    return withPublicApiKey(acc0.apiKey, async () => {
      const sioTags = (await siListTagsPublic()).map((t) => t.name.trim()).filter(Boolean);
      const sioLower = new Set(sioTags.map((s) => s.toLowerCase()));
      const localLower = new Set(localTags.map((s) => s.toLowerCase()));
      const pulled = sioTags.filter((t) => !localLower.has(t.toLowerCase()));
      const toPush = localTags.filter((t) => t && !sioLower.has(t.toLowerCase()));
      const skipped = localTags.filter((t) => t && sioLower.has(t.toLowerCase()));
      const pushed: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const t of toPush) {
        try { await siEnsureTagId(t); pushed.push(t); }
        catch (e) { failed.push({ name: t, error: ((e as Error).message || "error").slice(0, 300) }); }
      }
      return { pulled, pushed, skipped, failed, total: sioTags.length, account };
    });
  }

  // SIO-API-F5 · sin clave no se sincroniza por el puente (su create-tag iba por navegador
  // y fallaba en silencio): el que llama convierte esto en un aviso accionable.
  throw new Error("Esa web no tiene su clave de acceso guardada: pégala en Conexiones para sincronizar etiquetas.");
}

async function execContactUpsert(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Respeta account_id (la cuenta systeme.io elegida en la ficha) y target_platform
  // (URL del panel) del payload. Sin account_id → cuenta activa (primera). Antes el
  // selector era cosmético: account_id se ignoraba y siempre usaba la activa.
  const accountId = typeof payload.account_id === "string" ? (payload.account_id as string) : undefined;
  const targetPlatform = typeof payload.target_platform === "string"
    ? (payload.target_platform as string)
    : undefined;
  const contact = (payload.contact as Record<string, unknown>) || {};
  // payload.email (lo tecleado en la ficha) tiene prioridad sobre el del contacto.
  const email = String(payload.email || contact.email || "");
  // CUENTA-ELEGIDA-1 · Con account_id explícito NO hay plan B: si esa conexión ya
  // no existe en el workspace, el job falla como «cuenta desconectada». Caer a
  // otra cuenta «parecida» (o a la activa, que en producción es la sandbox)
  // escribía el contacto en una web que nadie eligió.
  if (accountId && !(await siGetAccount(accountId))) {
    return {
      action: "failed",
      code: "account_disconnected",
      email,
      reason: "La web elegida ya no está entre tus Conexiones. Vuelve a conectarla o elige otra y guarda de nuevo.",
    };
  }
  // QUE ETIQUETAS SE MANDAN.
  //
  // Si el job viene de un paso «Sincronizar» de un flujo, el dueño ha ELEGIDO ahí una
  // etiqueta (de una lista que le muestra las que existen de verdad en esa cuenta), y
  // esa es la que dispara su campaña. En ese caso se manda ESA Y SOLO ESA.
  //
  // Mandar además las etiquetas internas del panel («lead-instagram», «📍 Propuesta»,
  // la etapa del CRM…) tiene dos problemas: ensucia su cuenta, y sobre todo si alguna
  // coincide de nombre con una suya podría DISPARAR otra automatización que no toca.
  // Un flujo asigna una etiqueta concreta y predecible, no el estado interno del CRM.
  //
  // Sin `sync_tag` (sincronizaciones manuales desde la ficha del contacto) se mantiene
  // el comportamiento de siempre: se mandan sus etiquetas, y las que no existan allí
  // simplemente se omiten.
  const syncTag = String((payload.sync_tag as string) || "").trim();
  const allTags = Array.isArray((contact as any).tags) ? (contact as any).tags as string[] : [];
  const tags = syncTag ? [syncTag] : allTags;
  if (!email) return { skipped: true, reason: "Contacto sin email — esa web localiza a la gente por su email" };

  // ── CAMINO PREFERENTE: API pública oficial de systeme.io ──────────────────
  // Es el ÚNICO que sabe ASIGNAR una etiqueta a un contacto (POST
  // /api/contacts/{id}/tags). El MCP solo tiene create-tag, que crea la etiqueta
  // suelta en la cuenta y NUNCA la cuelga del contacto → el trigger "asignar
  // etiqueta" de los workflows de systeme.io no disparaba jamás.
  // Además evita el scrape de hasta 5000 contactos por lead contra el MCP, que es
  // infraestructura COMPARTIDA con el curso LeadMatch.
  const acct = await resolveSyncAccount(accountId, targetPlatform);
  if (acct?.apiKey) {
    const name = String((contact as { name?: string }).name || "").trim().replace(/^@/, "");
    try {
      // primaryTag = la etiqueta que el dueño eligió en el paso del flujo. Es la ÚNICA
      // que se autoriza a CREAR en systeme.io; las demás son etiquetas internas del
      // panel y solo se asignan si ya existen allí. Con planes topados (10 etiquetas)
      // esto evita que «lead-instagram» o «📍 Propuesta» se coman el cupo que el dueño
      // reserva para las que disparan sus campañas.
      const primaryTag = syncTag;
      // Campo identificador del flujo (que recurso pidio). Se escribe SIEMPRE, tanto si
      // el contacto es nuevo como si ya existia: quien vuelve a por un segundo recurso
      // necesita el valor NUEVO, no el de la vez anterior.
      const campo = String((payload.sync_field as string) || "").trim();
      const valor = String((payload.sync_field_value as string) || "").trim();
      const fields = campo && valor ? { [campo]: valor } : undefined;
      const r = await withPublicApiKey(acct.apiKey, () =>
        syncContactWithTags(email, { name: name || undefined, tags, primaryTag, fields }),
      );
      return {
        action: r.created ? "created" : "linked",
        via: "public-api",
        systemeio_contact_id: String(r.contactId),
        // CUENTA-SIO-1 · En QUÉ cuenta acabó (se persiste en el contacto del panel para
        // poder agrupar por cuenta; el id remoto solo no dice de cuál es).
        systemeio_account: acct.id,
        email,
        tags_assigned: r.tagsAssigned,
        tags_already: r.tagsAlready,
        // Etiqueta disparadora que YA tenía → se quitó y se volvió a poner para que el
        // workflow de systeme.io dispare otra vez (el lead que vuelve a por otro recurso).
        ...(r.tagsRetriggered.length ? { tags_redisparadas: r.tagsRetriggered } : {}),
        ...(fields ? { campo_escrito: fields } : {}),
        ...(r.tagsSkipped.length ? { tags_omitidas: r.tagsSkipped } : {}),
        ...(r.tagErrors.length ? { tag_errors: r.tagErrors } : {}),
      };
    } catch (e) {
      const msg = (e as Error).message || "error";
      // REINTENTO-1 · Solo se reintenta lo TEMPORAL: 429/5xx/timeout/red se
      // relanzan para que executeJob reprograme con backoff (antes cualquier
      // hipo de systeme.io mataba el job al primer intento como error final).
      if (/^Systeme\.io (429|5\d\d):/.test(msg) || /timeout|timed? ?out|abort|fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|socket/i.test(msg)) {
        throw e;
      }
      // Credencial mala NO se reintenta jamás (reintentar un 401 es spamear a
      // systeme.io con una clave rota): estado propio para que el panel diga
      // «revisa la API key en Conexiones» en vez de un error genérico.
      if (/^Systeme\.io (401|403):/.test(msg)) {
        return {
          action: "failed",
          code: "needs_config",
          via: "public-api",
          email,
          reason: "La API key de esa web no es válida o no tiene permisos. Revísala en Conexiones → esa cuenta.",
        };
      }
      // No caemos al MCP en silencio: el MCP NO puede asignar etiquetas, así que
      // "arreglarlo" por ahí daría un falso OK. Devolvemos el error real.
      return {
        action: "failed",
        via: "public-api",
        email,
        reason: `API pública de systeme.io: ${msg}`.slice(0, 300),
      };
    }
  }

  // SIO-API-F5 · sin clave de API no hay plan B: el puente no sabe asignar etiquetas y
  // su listado de contactos cargaba la infraestructura del curso. Se dice qué falta.
  return {
    action: "failed",
    code: "sin_clave",
    email,
    ...(acct?.id ? { systemeio_account: acct.id } : {}),
    reason: acct
      ? "Esa web no tiene su clave de acceso guardada. Pégala en Conexiones y se sincronizará sola."
      : "No hay ninguna web elegida para sincronizar. Elige una en Conexiones.",
  };
}

async function execContactPull(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const limit = Number(payload.limit) || 100;
  // SIO-API-F5 · solo por la API oficial; sin clave, error propio (sin caer al puente).
  const acc = await resolveSyncAccount(typeof payload.account_id === "string" ? payload.account_id : undefined);
  if (!acc?.apiKey) {
    return { action: "failed", code: "sin_clave", reason: "Esa web no tiene su clave de acceso guardada. Pégala en Conexiones." };
  }
  const r = await withPublicApiKey(acc.apiKey, () => siListContactsPullPage(limit));
  return {
    via: "public-api",
    items: {
      status: "success",
      contactCount: r.contacts.length,
      hasMore: r.hasMore,
      contacts: r.contacts.map((c) => ({
        id: c.id,
        email: c.email,
        firstName: c.firstName,
        registeredAt: c.registeredAt,
        tags: c.tags,
      })),
    },
  };
}

async function execPagePublish(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const draft = (payload.draft as Record<string, unknown>) || {};
  const targetPlatform = String(draft.target_platform || "leadmatch-lab");
  // 'standalone' = solo descarga HTML: nunca debería llegar aquí (el panel y la
  // ruta de publish lo bloquean), pero si llega, no tocamos nada en systeme.io.
  if (targetPlatform === "standalone") {
    return { skipped: true, reason: "Draft 'standalone' (solo descarga HTML) — no se publica vía MCP." };
  }
  // target_platform puede ser ahora: 'standalone' | un accountId | legacy
  // ('leadmatch-lab' | 'systemeio'). Detectamos si es account id y abrimos
  // sesión con ese contexto (que usa los creds del account guardado).
  const maybeAcc = await siGetAccount(targetPlatform);
  const ctx = maybeAcc
    ? await bootstrapSession({ accountId: maybeAcc.id })
    : await bootstrapSession(targetPlatform);
  // panel_base_url EXPLÍCITO (handoff §8.6): las tools del MCP (list-funnels,
  // list-funnel-steps, replace-page-html) aceptan `panel_base_url` opcional
  // (z.string().url()). Pasarlo elimina la dependencia del default del MCP
  // (leadmatch-lab) y del origen de page.url(): nav, read y save usan SIEMPRE
  // el panel del account del draft.
  const panelBase = String(maybeAcc?.panelBaseUrl || "").trim().replace(/\/+$/, "");
  const baseArgs: Record<string, unknown> = { student_id: ctx.studentId };
  if (/^https?:\/\//i.test(panelBase)) baseArgs.panel_base_url = panelBase;
  const html = String(draft.rendered_html || "");
  if (!html) throw new Error("Draft sin rendered_html");
  let pageId = String(draft.target_page_id || "").trim();
  const targetFunnelId = String(draft.target_funnel_id || "").trim();
  const targetStepId = String(draft.target_step_id || "").trim();
  // Gate 1 (handoff §8.2): el override debe ser un page id NUMÉRICO. Un slug
  // (p.ej. "prueba1") produce un 404 oscuro en el editor de systeme.io.
  if (pageId && !/^\d+$/.test(pageId)) {
    throw new Error(
      `target_page_id "${pageId}" no es un page id numérico (parece un slug). ` +
      `Vacía el campo "Page ID (override avanzado)" y elige Funnel + Página en los desplegables, ` +
      `o pon el id numérico real de la página destino.`,
    );
  }
  // Gate 2 (handoff §8.3): replace-page-html VACÍA la página destino antes de
  // volcar el HTML. Una operación destructiva no puede resolver a un destino
  // implícito ("primer step del primer funnel"): exigimos step o page id explícito.
  if (!pageId && !targetStepId) {
    throw new Error(
      "Falta el destino de publicación: elige Funnel + Página (step) en la pestaña Publicación, " +
      "o pon un Page ID numérico en el override. (La publicación REEMPLAZA todo el contenido " +
      "de la página destino, así que no se elige un destino implícito.)",
    );
  }
  let publicUrl = "";
  let stepType = "";
  if (!pageId) {
    if (!targetFunnelId) {
      throw new Error("El draft tiene step pero no funnel (target_funnel_id vacío). Vuelve a elegir Funnel + Página en la pestaña Publicación.");
    }
    // SIO-API-F6 · los pasos salen de la API oficial (GET /api/funnels/{id}/steps), no del
    // puente: con clave, pageId y url llegan siempre que systeme.io los tenga (sin reintento).
    if (!maybeAcc?.apiKey) {
      throw new Error("Esa web no tiene su clave de acceso guardada: pégala en Conexiones para poder publicar en un paso del funnel.");
    }
    const stList = await fetchSystemeioFunnelSteps(targetFunnelId, maybeAcc.id);
    const st = stList.find((s) => String(s.id) === targetStepId);
    // Sin fallback a stList[0]: si el step ya no existe, error accionable en vez
    // de machacar otra página (replace-page-html es destructivo).
    if (!st) {
      throw new Error(
        `El step ${targetStepId} ya no existe en el funnel ${targetFunnelId} ` +
        `(¿lo borraste en systeme.io?). Recarga los desplegables de la pestaña Publicación y vuelve a elegir.`,
      );
    }
    // El campo real es `pageId` (camelCase); mantenemos fallbacks por compat.
    pageId = String(st.pageId || "");
    publicUrl = String(st.publicUrl || "");
    stepType = String(st.type || "");
    if (!pageId) {
      throw new Error(
        `El step seleccionado no expone pageId (panel ${panelBase || "default"}). ` +
        `Abre Conexiones → Editar cuenta y comprueba que la dirección del panel es la de tu cuenta, ` +
        `o pon el identificador de la página a mano en el ajuste manual.`,
      );
    }
  } else if (targetFunnelId) {
    // Override numérico + funnel conocido → best-effort: resolver la URL pública
    // del step que apunta a esa página (para published_url del draft).
    try {
      const stList = await fetchSystemeioFunnelSteps(targetFunnelId, maybeAcc?.id);
      const st = stList.find((s) => String(s.pageId || "") === pageId);
      if (st) { publicUrl = String(st.publicUrl || ""); stepType = String(st.type || ""); }
    } catch { /* best-effort */ }
  }
  // Volcar la página completa diseñada en el builder reemplazando TODO el
  // contenido del step. `replace-page-html` (mismo primitivo que usa LeadMatch
  // en producción para publicar páginas completas):
  //   - vacía el <Body> del step y crea Section→Row→Column→RawHtml con el HTML
  //     verbatim (preserva <style> y <script>: el CSS/JS a medida se publica),
  //   - funciona para CUALQUIER tipo de página (no requiere un bloque de
  //     checkout ni RawHtml previos), por lo que no añade widgets de pago
  //     espurios — esto sustituye al antiguo import-checkout-block +
  //     personalize-checkout-rawhtml, que era el patrón para PERSONALIZAR una
  //     página de checkout existente, no para publicar una página diseñada
  //     (causa del error "No se encontró RawHtml entity tras import-checkout-block").
  // Nota: si el HTML trae un <form> visible sin form nativo SE.io, el MCP lo
  // rechaza con NATIVE_FORM_REQUIRED — lo propagamos como error accionable.
  // Capa 7 (handoff): páginas con FORM/PAGO NATIVO (optin, "Página de pago",
  // checkout SE.io). replace-page-html vacía la página y elimina el campo email
  // que systeme.io exige → save HTTP 400 "Se requiere al menos un campo de
  // correo". Para esos steps usamos write-page-preserve-native-from-url, que
  // conserva el bloque nativo e inyecta nuestro HTML antes de él (param
  // before_native_content inline; tool existente del MCP, sin tocar defaults).
  const publishPreservingNative = async (): Promise<Record<string, unknown>> => {
    const wr = await callTool(ctx.sid, "write-page-preserve-native-from-url", {
      ...baseArgs,
      page_id: pageId,
      before_native_content: html,
      // OPT-IN aislado (igual que replace-page-html): navigate-first + base
      // consistente para systeme.io directo. Cowork/LeadMatch NUNCA lo pasa.
      nav_editor_first: true,
    });
    if (wr.isError) throw new Error(`write-page-preserve-native falló: ${wr.text.slice(0, 300)}`);
    const wd = (wr.json as any)?.data || {};
    if (wd.status && wd.status !== "success") {
      throw new Error(`write-page-preserve-native no guardó (httpStatus ${wd.httpStatus ?? "?"}).`);
    }
    return {
      target_page_id: pageId,
      public_url: publicUrl,
      mode: "preserve-native",
      http_status: wd.httpStatus,
      published_at: Date.now(),
    };
  };
  // Detección proactiva por type del step (nombres SE.io: optIn/checkout/pago…).
  if (/opt.?in|checkout|payment|pago|order|squeeze|pop.?up|inline.?form/i.test(stepType)) {
    return await publishPreservingNative();
  }
  const repl = await callTool(ctx.sid, "replace-page-html", {
    ...baseArgs,
    page_id: pageId,
    blocks: [{ html }],
    // OPT-IN aislado: activa en el systemeio-mcp el navigate-first + base
    // consistente (origen de page.url()) para leer/guardar. Necesario porque las
    // cuentas de business-stack van a systeme.io directo (no el proxy
    // leadmatch-lab). Cowork/LeadMatch NUNCA pasa este flag → su camino queda
    // byte-idéntico (ver rollback d436e68 + reimplementación aislada).
    nav_editor_first: true,
  });
  if (repl.isError) {
    // Fallback reactivo: si el destino tenía un form nativo que no detectamos
    // por type (p.ej. override de page id), reintenta UNA vez preservándolo.
    if (/campo de correo|requiere al menos un campo/i.test(repl.text)) {
      return await publishPreservingNative();
    }
    throw new Error(`replace-page-html falló: ${repl.text.slice(0, 300)}`);
  }
  const replData = (repl.json as any)?.data || {};
  if (replData.status && replData.status !== "success") {
    throw new Error(`replace-page-html no guardó (httpStatus ${replData.httpStatus ?? "?"}).`);
  }
  return {
    target_page_id: pageId,
    public_url: publicUrl,
    blocks_injected: replData.blocksInjected,
    http_status: replData.httpStatus,
    published_at: Date.now(),
  };
}

/**
 * Marca el draft asociado a un job page-publish con el estado real del job
 * (handoff §8.5: el draft se quedaba en 'queued' para siempre y la lista
 * mostraba "—" en published_url aunque el job hubiera terminado `done`).
 * Best-effort: si el draft ya no existe o la BD falla, no rompe el job.
 * Requiere correr dentro del workspace del job (runWithWorkspace en el worker)
 * porque updateDraftStatus filtra por tenant_id = currentWorkspaceId().
 */
async function syncDraftFromJob(
  job: McpJob,
  status: "publishing" | "published" | "error" | "queued",
  result?: Record<string, unknown>,
): Promise<void> {
  if (job.kind !== "page-publish") return;
  const draftId = String(((job.payload as any)?.draft || {}).id || "");
  if (!draftId) return;
  try {
    const { updateDraftStatus } = await import("./page-builder.js");
    if (status === "published") {
      await updateDraftStatus(draftId, "published", {
        published_url: String((result as any)?.public_url || ""),
        published_at: Number((result as any)?.published_at) || Date.now(),
      });
    } else {
      await updateDraftStatus(draftId, status);
    }
  } catch { /* best-effort */ }
}

/**
 * PRÓXIMA-ACCIÓN · refleja el resultado del job en la ficha del contacto para que
 * la UI enseñe la verdad (pending/processing/synced/failed/needs_config/
 * disconnected). Solo escribe si la cita sigue siendo LA MISMA (misma fecha y
 * misma cuenta): el job de una cita ya reprogramada no pisa el estado de la nueva.
 */
async function naStatusFromJob(job: McpJob, status: string, error: string): Promise<void> {
  const p = job.payload as Record<string, unknown>;
  if (job.kind !== "contact-upsert" || !p.na) return;
  const phone = String(p.phone || "");
  if (!phone) return;
  try {
    const { dbGetContact, dbUpdateContact } = await import("./db.js");
    const c = await dbGetContact(phone);
    if (!c || !c.next_action_at) return;
    if (Number((p.na as { at?: number }).at) !== Number(c.next_action_at)) return;
    if (String(p.account_id || "") !== String(c.next_action_account || "")) return;
    await dbUpdateContact(phone, {
      next_action_sync_status: status,
      next_action_sync_error: String(error || "").slice(0, 300),
    } as never);
  } catch { /* best-effort: el estado completo vive también en la cola MCP */ }
}

async function executeJob(job: McpJob): Promise<void> {
  const st = bridgeStatus();
  // CUENTA-ELEGIDA-1 (gate previo) · Si el job trae account_id y esa conexión
  // ya no existe en el workspace, muere AQUÍ como «cuenta desconectada» —
  // antes que cualquier otro gate: sin mcp.token configurado se quedaba
  // eternamente en awaiting_config culpando a la config del MCP, cuando el
  // problema real (y accionable) es que la web elegida ya no está conectada.
  let cuentaJob: SiAccount | null = null;
  if (job.kind === "contact-upsert") {
    const accId = String((job.payload as Record<string, unknown>).account_id || "");
    if (accId) {
      try { cuentaJob = await siGetAccount(accId); } catch { cuentaJob = null; }
      if (!cuentaJob) {
        const reason = "La web elegida ya no está entre tus Conexiones. Vuelve a conectarla o elige otra y guarda de nuevo.";
        await updateJob(job.id, {
          status: "error",
          attempts: job.attempts + 1,
          error: reason,
          result: { action: "failed", code: "account_disconnected", reason },
        });
        await naStatusFromJob(job, "disconnected", reason);
        return;
      }
    }
  }
  // El gate del bridge solo aplica a lo que de verdad NECESITA el MCP: un
  // contact-upsert hacia una cuenta CON API key va entero por la API pública
  // oficial — exigirle mcp.token lo dejaba en awaiting_config para siempre
  // en instalaciones de cliente que jamás configuran el MCP del curso.
  const skipBridgeGate = job.kind === "contact-upsert" && !!cuentaJob?.apiKey;
  if (!st.live && !skipBridgeGate) {
    await updateJob(job.id, {
      status: "awaiting_config",
      error: st.reason ?? "",
      next_run: Date.now() + 5 * 60_000,
    });
    await naStatusFromJob(job, "needs_config", st.reason ?? "El puente de sincronización no está configurado");
    return;
  }
  await updateJob(job.id, { status: "running", attempts: job.attempts + 1, error: "" });
  await naStatusFromJob(job, "processing", "");
  await syncDraftFromJob(job, "publishing");
  try {
    let result: Record<string, unknown> = {};
    switch (job.kind) {
      case "contact-upsert": result = await execContactUpsert(job.payload); break;
      case "contact-pull":   result = await execContactPull(job.payload); break;
      case "page-publish":   result = await execPagePublish(job.payload); break;
      default:               result = { error: `kind no soportado: ${job.kind}` };
    }
    // FALLO-SILENCIOSO-2: esto marcaba el job como "done" SIEMPRE, incluso cuando el
    // ejecutor devolvía {action:'failed'} o {error}. En la UI de la cola todo salía
    // en verde aunque no se hubiera sincronizado nada. El estado ahora sale del
    // resultado real.
    const failedResult =
      result.action === "failed" || result.action === "create_failed" || !!result.error;
    const jobError = failedResult
      ? String(result.reason || result.error || "el job falló").slice(0, 400)
      : "";
    await updateJob(job.id, {
      status: failedResult ? "error" : "done",
      result,
      error: jobError,
    });
    // PRÓXIMA-ACCIÓN · la ficha refleja el desenlace real, con su estado propio
    // para cada causa (la UI convierte cada uno en un texto accionable).
    if (failedResult) {
      const naSt = result.code === "account_disconnected" ? "disconnected"
        : result.code === "needs_config" || result.code === "sin_clave" ? "needs_config" : "failed";
      await naStatusFromJob(job, naSt, jobError);
    } else if (result.skipped) {
      // «skipped» = no se sincronizó (p.ej. contacto sin email): para la cita
      // eso NO es verde — es «te falta algo», con el motivo delante.
      await naStatusFromJob(job, "needs_config", String(result.reason || "No se pudo sincronizar"));
    } else {
      await naStatusFromJob(job, "synced", "");
    }
    if (!result.skipped && !failedResult) await syncDraftFromJob(job, "published", result);
    // Si fue contact-upsert exitoso, persistir systemeio_contact_id en el panel (y en
    // QUÉ cuenta de systeme.io quedó, para poder agrupar por cuenta en Contactos).
    if (job.kind === "contact-upsert" && result.systemeio_contact_id) {
      try {
        const { dbUpdateContact } = await import("./db.js");
        const phone = String((job.payload as any).phone || "");
        const upd: Record<string, string> = { systemeio_contact_id: String(result.systemeio_contact_id) };
        const accUsed = String(result.systemeio_account || (job.payload as any).account_id || "");
        if (accUsed) upd.systemeio_account = accUsed;
        if (phone) await dbUpdateContact(phone, upd as any);
      } catch (_) { /* best-effort */ }
    }
  } catch (e) {
    const msg = (e as Error).message || "";
    // Sesión MCP perdida: el systemeio-mcp se reinició/redeployó (borra sus
    // sesiones en memoria) y el bridge tenía una cacheada → "Session not found.
    // Client must reinitialize.". Invalidamos la sesión para que el próximo
    // intento re-inicialice y reintentamos pronto (sin backoff: no es un fallo
    // real del job, sino infra transitoria).
    if (/session not found|must reinitialize|no session|mcp-session/i.test(msg)) {
      invalidateSystemeioSession();
      const st1 = job.attempts >= 5 ? "error" as const : "queued" as const;
      await updateJob(job.id, {
        status: st1,
        error: msg.slice(0, 400),
        next_run: Date.now() + 3000,
        // El reintento suelta su clave de dedupe: si mientras corría entró un
        // guardado nuevo (queued con la misma clave), volver a 'queued' con
        // ella chocaría contra el índice único y el job se quedaba clavado
        // en 'running' para siempre.
        dedupe_key: "",
      });
      await syncDraftFromJob(job, st1 === "error" ? "error" : "queued");
      await naStatusFromJob(job, st1 === "error" ? "failed" : "pending", msg);
      return;
    }
    const backoff = Math.min(30 * 60_000, 30_000 * Math.pow(2, job.attempts));
    const st2 = job.attempts >= 5 ? "error" as const : "queued" as const;
    await updateJob(job.id, {
      status: st2,
      error: msg.slice(0, 400),
      next_run: Date.now() + backoff,
      // Mismo motivo que arriba: el reintento no puede chocar con un guardado
      // nuevo que ya espere en cola con la misma clave de dedupe.
      dedupe_key: "",
    });
    await syncDraftFromJob(job, st2 === "error" ? "error" : "queued");
    // Error temporal → el job vuelve a la cola (backoff) y la cita queda en
    // «pendiente» con el motivo; agotados los intentos, «fallida» de verdad.
    await naStatusFromJob(job, st2 === "error" ? "failed" : "pending", msg);
  }
}

/* ============================================================
 * Auto-conexión: el user pega email + password de leadmatch-lab en el panel
 * y nosotros disparamos el flujo de login vía Playwright (que ya hace el
 * MCP). Guardamos las credenciales encriptadas para que bootstrapSession las
 * use después; si el login falla, las descartamos para no dejar basura.
 * ============================================================ */

export async function connectViaLogin(opts: {
  email: string;
  password: string;
  baseUrl?: string;
  accountEmail?: string;
}): Promise<{ ok: boolean; error?: string; twoFactor?: boolean }> {
  const email = (opts.email || "").trim();
  const password = (opts.password || "").trim();
  const baseUrl = (opts.baseUrl || "").trim().replace(/\/+$/, "");
  if (!email || !password) return { ok: false, error: "Email y contraseña requeridos" };
  // MCP-CLIENTES-1 · la migración de las credenciales antiguas (siListAccounts, una sola
  // vez por proceso) convertía en cuenta guardada la contraseña que estamos PROBANDO si
  // corría dentro del intento (bootstrapSession lista cuentas): en una instancia nueva, el
  // primer login fallido dejaba una cuenta fantasma con la contraseña mala. Se fuerza
  // antes de escribir nada, y si el login falla se limpian los dos ajustes de prueba.
  await siListAccountsRaw();
  // Guardamos antes de probar para que bootstrapSession las pueda leer.
  await setSetting("systemeio.sandboxEmail", email);
  await setSetting("systemeio.sandboxPass", password);
  if (baseUrl) await setSetting("systemeio.panelBaseUrl", baseUrl);
  if (opts.accountEmail) await setSetting("systemeio.accountEmail", opts.accountEmail.trim());
  // Status del bridge: si falta mcp.token no podemos ni intentar.
  const st = bridgeStatus();
  if (!st.live && st.reason && /mcp\.token/.test(st.reason)) {
    return { ok: false, error: "El acceso automático del puente no está configurado (lo pone el administrador del stack). Mientras tanto, conecta pegando la cookie a mano." };
  }
  try {
    const ctx = await bootstrapSession();
    if (!ctx?.sid) {
      await setSetting("systemeio.sandboxPass", "");
      return { ok: false, error: "El bridge no devolvió session id" };
    }
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    // Limpiamos los ajustes de prueba para no dejar nada roto ni a medias.
    await setSetting("systemeio.sandboxPass", "");
    await setSetting("systemeio.sandboxEmail", "");
    invalidateSystemeioSession();
    if (/2fa/i.test(msg)) return { ok: false, error: msg, twoFactor: true };
    return { ok: false, error: msg };
  }
}

/* ============================================================
 * Métricas síncronas vía systemeio-mcp para la card de Conexiones y
 * el widget de Dashboard. Bootstrap session compartida + 4 tools en
 * paralelo. Si el bridge no está vivo, devuelve null gracefully — el
 * caller se apaña con los valores de la Public API.
 * ============================================================ */

export interface SiMcpMetrics {
  // null = la tool no devolvió data («sin datos», distinto de 0 funnels reales).
  funnelsCount: number | null;
  funnels: Array<{ id: number | string; name: string }>;
  newslettersCount: number;
  newsletters: Array<{ id: number | string; subject: string; sentAt?: string }>;
  salesSummary: {
    allTimeRevenueEur: number;
    allTimeCount: number;
    currency: string;
    /**
     * true = el importe NO es un total exacto: o pasó por tasas FX fijas
     * aproximadas (divisas ≠ EUR), o es PARCIAL porque se excluyó la parte en
     * otra divisa. La UI muestra la salvedad al usuario (antes solo un «≈»).
     */
    fxApprox?: boolean;
    /** Detalle de lo excluido del importe, para que la UI pueda decir la verdad exacta. */
    fxNote?: string;
    /**
     * DIVISA-1 · lo cobrado en CADA moneda, sin convertir. El panel lo suma al cambio del día
     * en la moneda que elija la persona (botón EUR/USD). Campo nuevo: los de arriba no cambian
     * de forma.
     */
    ingresos?: Array<{ moneda: string; importe: number }>;
    /** DIVISA-1 · true = alguna moneda no tenía cambio del día y `allTimeRevenueEur` tiró de la tabla fija. */
    fxFijo?: boolean;
  } | null;
  pipelinesCount: number;
  // Contactos + tags vía bridge (para que la card auto-login muestre los
  // mismos números que cookie sin necesidad de cookie aparte).
  totalContacts: number;
  totalTags: number;
  topTags: Array<{ id: number | string; name: string; count: number }>;
  recentContacts: Array<{ email: string; name: string; at: string }>;
  reason?: string;
}

async function safeCallTool(sid: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const r = await callTool(sid, name, args);
    if (r.isError) return null;
    return r.json ?? null;
  } catch {
    return null;
  }
}

/**
 * Extracción robusta de arrays. Las tools MCP envuelven en {ok,data:{...}} pero
 * la clave de la lista cambia por tool y por versión del MCP (tags|items|
 * funnels|tags_with_counts|...). Probamos data.*, top-level.*, .result.* y array
 * pelado. Esto evita los "0 fantasma" cuando una tool renombra su clave (causa
 * del tags=0 aunque hubiera 10): un solo desajuste de clave dejaba la métrica a 0.
 */
function pickArr(r: Record<string, unknown> | null, ...keys: string[]): unknown[] {
  if (!r) return [];
  const data = (r as { data?: unknown }).data;
  const result = (r as { result?: unknown }).result;
  const dataResult = data && typeof data === "object" ? (data as { result?: unknown }).result : undefined;
  const containers = [data, r, result, dataResult].filter((c): c is Record<string, unknown> => !!c && typeof c === "object");
  for (const c of containers) {
    if (Array.isArray(c)) return c;
    for (const k of keys) {
      const v = (c as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

/** Igual que pickArr pero para un número (count/total/totalItems/pagination). */
function pickNum(r: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!r) return null;
  const data = (r as { data?: unknown }).data;
  const sources = [data, r].filter((c): c is Record<string, unknown> => !!c && typeof c === "object");
  for (const src of sources) {
    for (const k of keys) {
      const v = src[k];
      if (typeof v === "number") return v;
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
    }
    const pag = src.pagination as { totalItems?: number } | undefined;
    if (pag && typeof pag.totalItems === "number") return pag.totalItems;
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * Llama tools en orden con reintentos, SERIALIZADO. El servidor MCP corre UNA
 * sesión de navegador por student → varias llamadas concurrentes chocan y
 * devuelven {ok,error} sin data (flakiness: tags=10 en una llamada y 0 en la
 * siguiente). Por eso NO usamos Promise.all: serializamos y reintentamos. Una
 * respuesta es válida si trae `.data` sin `.error`. Si la 1ª tool no da data en
 * `tries` intentos, pasa a la siguiente (fallback list-tags / list-contacts).
 */
async function callToolData(
  sid: string,
  attempts: Array<{ name: string; args: Record<string, unknown> }>,
  tries = 2,
): Promise<Record<string, unknown> | null> {
  let last: Record<string, unknown> | null = null;
  for (const a of attempts) {
    for (let i = 0; i < tries; i++) {
      const r = await safeCallTool(sid, a.name, a.args);
      if (r) {
        last = r;
        const d = (r as { data?: unknown }).data;
        if (d != null && !(r as { error?: unknown }).error) return r;
      }
      if (i < tries - 1) await sleep(350);
    }
  }
  return last;
}

// 2026-08-19 · Parse FX de get-sales-summary, extraído para compartirlo entre
// la cascada MCP legacy y la rama de métricas por API oficial. Ventas
// multi-divisa → convertir a EUR con tasas fijas aproximadas (el owner eligió
// ver "ingresos totales" en EUR). Sumamos el desglose por divisa; si no viene,
// caemos al net_revenue del resumen. Las divisas FUERA de la tabla NO se
// convierten (antes había un `?? 1` → 500.000 CLP salían como «500.000 EUR»):
// se acumulan aparte y, si dominan, el resumen se emite en esa divisa real.
const FX_TO_EUR: Record<string, number> = {
  eur: 1, usd: 0.92, gbp: 1.17, mxn: 0.05, cop: 0.00023, ars: 0.001, brl: 0.18,
  clp: 0.001, pen: 0.24, jpy: 0.0057, cad: 0.67, aud: 0.6, chf: 1.06,
  uyu: 0.022, bob: 0.13, pyg: 0.00012, gtq: 0.12, crc: 0.0018, dop: 0.015,
  hnl: 0.037, nio: 0.025, inr: 0.011, cny: 0.13,
};

// Exportada para su prueba (scripts/test-divisa-sio.mjs): no la llama nadie más desde fuera.
export async function salesSummaryFromToolResult(
  salesR: Record<string, unknown> | null,
): Promise<SiMcpMetrics["salesSummary"]> {
  if (salesR?.data == null) return null;
  // get-sales-summary → data:{totals:{sales_count}, revenue:{net_revenue,gross_revenue}, by_currency:[{currency}]}
  const sd = (salesR.data ?? {}) as {
    revenue?: { net_revenue?: number; gross_revenue?: number };
    totals?: { sales_count?: number };
    by_currency?: Array<{ currency?: string; revenue?: number }>;
  };
  const byCur = Array.isArray(sd.by_currency) ? sd.by_currency : [];
  // DIVISA-1 · el cambio del día manda; la tabla fija queda de respaldo para la moneda que el
  // cambio del día no traiga (o si hoy no se pudo leer ninguno).
  const hoy = byCur.length ? await cambioDelDiaParaVentas() : null;
  let convertedEur = 0;
  let fxFijo = false; // alguna moneda distinta del euro pasó por la tabla fija
  const porMoneda = new Map<string, number>(); // lo cobrado en cada moneda, sin convertir
  const unconverted = new Map<string, number>(); // divisa sin tasa → importe SIN convertir
  for (const c of byCur) {
    const cur = String(c.currency || "eur").toLowerCase();
    const amt = Number(c.revenue) || 0;
    if (amt) porMoneda.set(cur, (porMoneda.get(cur) || 0) + amt);
    const delDia = cur === "eur" ? 1 : hoy?.[cur.toUpperCase()];
    const rate = delDia && delDia > 0 ? 1 / delDia : FX_TO_EUR[cur];
    if (rate != null) {
      convertedEur += amt * rate;
      if (!(delDia && delDia > 0) && amt > 0) fxFijo = true;
    } else if (amt > 0) unconverted.set(cur, (unconverted.get(cur) || 0) + amt);
  }
  // fxApprox → hubo conversión con tasas fijas: el importe no es exacto. Con el cambio del día
  // ya no lo es «por aproximación», así que la marca solo sale si se usó la tabla fija.
  const fxApprox = fxFijo;
  // Lo que se queda FUERA del importe mostrado — el resultado avisa de que la
  // cifra es parcial (antes la UI pintaba el número mudo, sin marca).
  let fxExcluded: string[] = [];
  let salesRevenueEur: number;
  let salesCurrency: string;
  if (byCur.length) {
    salesRevenueEur = convertedEur;
    salesCurrency = "EUR";
    if (unconverted.size > 0) {
      const dominant = [...unconverted.entries()].sort((a, b) => b[1] - a[1])[0];
      if (dominant[1] > convertedEur) {
        // La parte sin tasa domina: mejor el importe real de la divisa dominante
        // que una suma imposible de divisas mezcladas.
        salesCurrency = dominant[0].toUpperCase();
        salesRevenueEur = dominant[1];
      }
      const excluded = [...unconverted.entries()]
        .filter(([cur]) => cur.toUpperCase() !== salesCurrency)
        .map(([cur, amt]) => `${Math.round(amt)} ${cur.toUpperCase()}`);
      if (salesCurrency !== "EUR" && convertedEur > 0) excluded.push(`~${Math.round(convertedEur)} EUR`);
      fxExcluded = excluded;
      if (excluded.length) {
        await logActivity({
          source: "mcp-job",
          level: "warn",
          status: "warning",
          summary: `Ingresos systeme.io: parte excluida del chip por divisa sin tasa FX (${excluded.join(", ")}); se muestra ${salesCurrency}.`,
          payload: { file: "mcp-bridge.ts", fn: "salesSummaryFromToolResult", excluded, shown_currency: salesCurrency },
        }).catch(() => {});
      }
    }
  } else {
    salesRevenueEur = Number(sd.revenue?.net_revenue ?? sd.revenue?.gross_revenue ?? 0);
    // Sin desglose por divisa: propagamos la divisa que reporte el resumen (si
    // la reporta); EUR solo como último recurso.
    salesCurrency = String((sd as { currency?: string }).currency || "EUR").toUpperCase();
  }
  return {
    // Total histórico de ingresos (la card lo etiqueta "ingresos totales").
    // allTimeCount = nº de ventas (histórico completo). La clave conserva el
    // sufijo Eur por compat con call-sites, pero `currency` manda: si dominó
    // una divisa sin tasa FX, el importe va en esa divisa real, sin convertir.
    allTimeRevenueEur: Math.round(salesRevenueEur),
    allTimeCount: Number(sd.totals?.sales_count ?? 0),
    currency: salesCurrency,
    // Marca de «no es un total exacto»: (a) conversión con tasas fijas, o
    // (b) importe parcial porque ganó una divisa sin tasa.
    ...((fxApprox && salesCurrency === "EUR") || fxExcluded.length ? { fxApprox: true } : {}),
    ...(fxExcluded.length ? { fxNote: `No incluye ${fxExcluded.join(", ")} (divisa sin tasa de cambio)` } : {}),
    // DIVISA-1 · cada moneda tal cual se cobró: el panel suma al cambio del día y respeta el
    // botón EUR/USD. Sin desglose por moneda, el único importe que hay, en la suya.
    ingresos: byCur.length
      ? [...porMoneda.entries()].map(([moneda, importe]) => ({ moneda, importe: Math.round(importe * 100) / 100 }))
      : salesRevenueEur
        ? [{ moneda: salesCurrency.toLowerCase(), importe: Math.round(salesRevenueEur * 100) / 100 }]
        : [],
    ...(fxFijo ? { fxFijo: true } : {}),
  };
}

/**
 * DIVISA-1 · unidades de cada moneda por euro al cambio de hoy, o null si no se pudo leer.
 * Acotado a 2 s: la tarjeta de systeme.io no espera a la red por un cambio; si tarda, tira de
 * la tabla fija como hacía antes.
 */
async function cambioDelDiaParaVentas(): Promise<Record<string, number> | null> {
  try {
    const t = await Promise.race([
      tasasDivisa(),
      new Promise<null>((r) => {
        const h = setTimeout(() => r(null), 2000);
        (h as { unref?: () => void }).unref?.();
      }),
    ]);
    return t?.tasas ?? null;
  } catch {
    return null;
  }
}

// 2026-08-19 · MIGRACIÓN A API OFICIAL · métricas sin cascada MCP: funnels y
// newsletters salen de la API pública directa; contactos/tags/topTags/recientes
// los aporta ya el upstream `api` del endpoint de métricas
// (publicMetricsWithCreds) y el frontend hace fallback entre upstreams → aquí
// van a 0/[] para no pagar dos veces el rate-limit con datos idénticos. El MCP
// queda SOLO para pipelines y ventas (sin endpoint oficial); si el MCP está
// caído, las métricas oficiales se devuelven igual (antes: card entera vacía).
const MCP_SOLO_TTL_MS = 60 * 60 * 1000;
const mcpSoloCache = new Map<string, { at: number; pipelinesCount: number; salesSummary: SiMcpMetrics["salesSummary"] }>();
async function fetchMetricsViaOfficialApi(apiKey: string, accountId?: string): Promise<SiMcpMetrics> {
  const [funnelsApi, newslettersApi] = await Promise.all([
    withPublicApiKey(apiKey, () => siListFunnelsPublic()).catch(() => null),
    withPublicApiKey(apiKey, () => siListNewslettersPublic(10)).catch(() => null),
  ]);
  let funnels: Array<{ id: number | string; name: string }> | null =
    funnelsApi ? funnelsApi.map((f) => ({ id: f.id, name: String(f.name || `Funnel ${f.id}`) })) : null;
  let newsletters: Array<{ id: number | string; subject: string }> | null =
    newslettersApi ? newslettersApi.map((n) => ({ id: n.id, subject: n.subject })) : null;
  // FALSO-CERO-1 · 2026-08-23 (regresión reportada: «0 funnels» en una cuenta que
  // sí los tiene). La API oficial puede fallar o no exponer el recurso para esa
  // cuenta; entonces se consulta el MCP, que es de donde salía el número antes.
  // Un 0 solo se pinta si AMBAS fuentes coinciden en que no hay nada.
  const faltanFunnels = !funnels || !funnels.length;
  const faltanNews = !newsletters || !newsletters.length;
  let pipelinesCount = 0;
  let salesSummary: SiMcpMetrics["salesSummary"] = null;
  // MCP-HORA-1 · pipelines y ventas no tienen endpoint oficial y cada consulta
  // obliga al MCP a iniciar sesión en un Chromium (6 logins/hora con el warm de
  // 4 min, y la RAM del MCP creciendo sin parar). Cambian poco: se reutilizan
  // durante MCP_SOLO_TTL_MS y el MCP solo se toca una vez por hora y cuenta.
  const claveSolo = accountId || "__activa";
  const previo = mcpSoloCache.get(claveSolo);
  if (previo && Date.now() - previo.at < MCP_SOLO_TTL_MS && !faltanFunnels && !faltanNews) {
    pipelinesCount = previo.pipelinesCount;
    salesSummary = previo.salesSummary;
  } else try {
    const ctx = await bootstrapSession({ accountId });
    const base = { student_id: ctx.studentId };
    const pipelinesR = await callToolData(ctx.sid, [{ name: "list-pipelines", args: base }]);
    pipelinesCount = (pickArr(pipelinesR, "pipelines", "items") as unknown[]).length;
    const salesR = await callToolData(ctx.sid, [
      { name: "get-sales-summary", args: { ...base, date_from: "2018-01-01T00:00:00" } },
    ]);
    salesSummary = await salesSummaryFromToolResult(salesR);
    // Serializado (el MCP tiene UNA sesión de navegador por cuenta: en paralelo chocan).
    if (faltanFunnels) {
      const fR = await callToolData(ctx.sid, [{ name: "list-funnels", args: base }]);
      const arr = pickArr(fR, "funnels", "items") as Array<{ id?: number | string; name?: string }>;
      if (fR?.data != null) {
        if (arr.length) {
          funnels = arr.map((f) => ({ id: f.id ?? 0, name: String(f.name ?? `Funnel ${f.id ?? ""}`) }));
          await logActivity({
            source: "app",
            level: "warn",
            status: "warning",
            summary: `Métricas systeme.io: la API oficial no devolvió funnels (${funnelsApi ? "lista vacía" : "llamada fallida"}); se usó el puente MCP y hay ${arr.length}.`,
            payload: { file: "mcp-bridge.ts", fn: "fetchMetricsViaOfficialApi", accountId: accountId || "", via: "mcp-fallback" },
          }).catch(() => {});
        } else if (!funnels) {
          funnels = []; // el MCP confirma que no hay ninguno
        }
      }
    }
    if (faltanNews) {
      const nR = await callToolData(ctx.sid, [{ name: "list-newsletters", args: { ...base, limit: 5 } }]);
      const arr = pickArr(nR, "newsletters", "items") as Array<{ id?: number | string; subject?: string; mailing?: { currentEmail?: { subject?: string } } }>;
      if (nR?.data != null && arr.length) {
        newsletters = arr.map((n) => ({ id: n.id ?? 0, subject: String(n.subject ?? n.mailing?.currentEmail?.subject ?? "(sin asunto)") }));
      } else if (nR?.data != null && !newsletters) {
        newsletters = [];
      }
    }
    mcpSoloCache.set(claveSolo, { at: Date.now(), pipelinesCount, salesSummary });
  } catch { /* MCP caído → pipelines/ventas sin dato; el resto vale igual */ }
  const newsSlice = (newsletters ?? []).slice(0, 5);
  return {
    // null = «sin datos» (ninguna fuente contestó) → el panel no pinta el chip;
    // jamás un 0 inventado en una cuenta que sí tiene funnels.
    funnelsCount: funnels ? funnels.length : null,
    funnels: (funnels ?? []).slice(0, 5).map((f) => ({ id: f.id, name: String(f.name || `Funnel ${f.id}`).slice(0, 60) })),
    newslettersCount: newsSlice.length,
    newsletters: newsSlice.map((n) => ({ id: n.id, subject: n.subject.slice(0, 80) })),
    salesSummary,
    pipelinesCount,
    totalContacts: 0,
    totalTags: 0,
    topTags: [],
    recentContacts: [],
  };
}

export async function fetchSystemeioMcpMetrics(accountId?: string): Promise<SiMcpMetrics | null> {
  if (accountId && !(await siGetAccount(accountId))) throw new Error("La cuenta de systeme.io no existe en este negocio");
  const cacheKey = currentWorkspaceId() + "|" + (accountId || "legacy");
  const cached = metricsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < METRICS_TTL_MS) return cached.m;
  const pendiente = metricsEnCurso.get(cacheKey);
  if (pendiente) return pendiente;
  const promesa = cargarSystemeioMcpMetrics(accountId, cacheKey, metricsRevision);
  metricsEnCurso.set(cacheKey, promesa);
  try { return await promesa; }
  finally { if (metricsEnCurso.get(cacheKey) === promesa) metricsEnCurso.delete(cacheKey); }
}

async function cargarSystemeioMcpMetrics(accountId: string | undefined, cacheKey: string, revision: number): Promise<SiMcpMetrics | null> {
  const st = bridgeStatus();
  if (!st.live) return null;
  // 2026-08-19 · MIGRACIÓN A API OFICIAL: con API key en la cuenta, la cascada
  // de 7 tools MCP se sustituye por API pública directa + 2 llamadas MCP
  // (pipelines y ventas, lo único sin endpoint oficial). Sin key → cascada
  // MCP completa de siempre.
  try {
    const accForApi = accountId ? await siGetAccount(accountId) : await siGetActiveAccount();
    if (accForApi?.apiKey) {
      const m = await fetchMetricsViaOfficialApi(accForApi.apiKey, accountId);
      guardarMetricasPuente(cacheKey, m, revision);
      return m;
    }
  } catch { /* cuenta ilegible → cascada MCP de siempre */ }
  let ctx;
  try {
    ctx = await bootstrapSession({ accountId });
  } catch (e) {
    return {
      // funnelsCount null = «sin datos» (bootstrap falló); jamás un 0 que parezca dato.
      funnelsCount: null, funnels: [], newslettersCount: 0, newsletters: [],
      salesSummary: null, pipelinesCount: 0,
      totalContacts: 0, totalTags: 0, topTags: [], recentContacts: [],
      reason: (e as Error).message || "bootstrap failed",
    };
  }
  const sid = ctx.sid;
  const studentId = ctx.studentId;
  // "ingresos totales": Systeme.io existe desde ~2018; este date_from cubre todo
  // el histórico (get-sales-summary agrega TODAS las transacciones del rango).
  const allTimeFrom = "2018-01-01T00:00:00";
  // SERIALIZADO (no Promise.all): el MCP tiene 1 sesión de navegador por
  // student; en paralelo chocan y dan {ok,error} aleatorio.
  const base = { student_id: studentId };
  const funnelsR = await callToolData(sid, [{ name: "list-funnels", args: base }]);
  const pipelinesR = await callToolData(sid, [{ name: "list-pipelines", args: base }]);
  const tagsR = await callToolData(sid, [
    { name: "list-tags", args: base },
    { name: "list-tags-with-counts", args: base },
  ]);
  // CONTEO exacto: count-contacts PRIMERO (el MCP ya cae a /contacts/count
  // interno si la API pública falla → total real). list-contacts(page) NO sirve
  // como total: solo trae una página (p.ej. 10 con hasMore) → quedaría capado.
  const contactsR = await callToolData(sid, [
    { name: "count-contacts", args: base },
    { name: "list-contacts", args: { ...base, auto_paginate: false } },
  ]);
  const newslettersR = await callToolData(sid, [{ name: "list-newsletters", args: { ...base, limit: 5 } }]);
  // get-sales-summary EXIGE `date_from` (no date_since/date_till). El nombre mal
  // hacía fallar la validación Zod → ventas/ingresos salían 0 SIEMPRE.
  const salesR = await callToolData(sid, [
    { name: "get-sales-summary", args: { ...base, date_from: allTimeFrom } },
  ]);
  // "recientes": lista corta aparte (count-contacts no devuelve la lista de
  // contactos, solo el total).
  const recentR = await callToolData(sid, [
    { name: "list-contacts", args: { ...base, limit: 5, auto_paginate: false, order_desc: true } },
  ]);
  const funArr = pickArr(funnelsR, "funnels", "items") as Array<{ id?: number | string; name?: string }>;
  const newsArr = pickArr(newslettersR, "newsletters", "items") as Array<{ id?: number | string; subject?: string; mailing?: { currentEmail?: { subject?: string } }; sentAt?: string }>;
  const pipArr = pickArr(pipelinesR, "pipelines", "items") as Array<unknown>;
  // 2026-08-19 · el parse FX de get-sales-summary vive ahora en
  // salesSummaryFromToolResult (compartido con la rama de métricas por API
  // oficial). Lógica intacta.
  const salesSummary = await salesSummaryFromToolResult(salesR);
  // count-contacts → {data:{count}}; fallback list-contacts → data.contactCount.
  const totalContacts = pickNum(contactsR, "count", "contactCount", "totalItems", "total") ?? 0;
  // list-tags-with-counts cambia la clave según versión del MCP → probamos todas.
  const tagsArr = pickArr(tagsR, "tags", "tags_with_counts", "tagsWithCounts", "items") as Array<{ id?: number | string; name?: string; contactCount?: number; count?: number }>;
  // 2026-08-19 · list-tags del MCP es ahora oficial-first y sus items ya no
  // traen contactCount ({id,name,createdAt}) — y como SÍ trae data, el
  // fallback en cadena a list-tags-with-counts nunca corre → topTags saldría
  // con count 0. Si TODOS los items vienen sin count, pedimos los counts
  // aparte; si también falla, se queda el comportamiento anterior (counts 0).
  let tagsCountsArr = tagsArr;
  if (tagsArr.length > 0 && tagsArr.every((t) => t.contactCount == null && t.count == null)) {
    const withCountsR = await callToolData(sid, [{ name: "list-tags-with-counts", args: base }]).catch(() => null);
    const wc = pickArr(withCountsR, "tags", "tags_with_counts", "tagsWithCounts", "items") as typeof tagsArr;
    if (wc.length > 0) tagsCountsArr = wc;
  }
  const topTags = tagsCountsArr
    .map((t) => ({ id: t.id ?? 0, name: String(t.name ?? "(sin nombre)").slice(0, 60), count: Number(t.contactCount ?? t.count ?? 0) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const recentArr = pickArr(recentR, "items", "contacts") as Array<{ email?: string; firstName?: string | null; surname?: string | null; registeredAt?: string }>;
  const recentContacts = recentArr.slice(0, 5).map((c) => ({
    email: c.email ?? "",
    name: [c.firstName, c.surname].filter(Boolean).join(" ").trim(),
    at: c.registeredAt ?? "",
  }));
  const result: SiMcpMetrics = {
    // «Sin datos» ≠ «cero»: si la tool no devolvió data (flakiness documentada del
    // MCP), va null y el dashboard NO pinta el chip — nunca un 0 falso.
    funnelsCount: funnelsR?.data != null ? funArr.length : null,
    funnels: funArr.slice(0, 5).map((f) => ({ id: f.id ?? 0, name: String(f.name ?? `Funnel ${f.id ?? ""}`).slice(0, 60) })),
    newslettersCount: newsArr.length,
    newsletters: newsArr.slice(0, 5).map((n) => ({
      id: n.id ?? 0,
      subject: String(n.subject ?? n.mailing?.currentEmail?.subject ?? "(sin asunto)").slice(0, 80),
      sentAt: n.sentAt,
    })),
    // Si get-sales-summary no devolvió data (flakiness), salesSummary=null y los
    // chips de ventas/ingresos no se pintan — jamás «0 EUR» falso en cuenta con ventas.
    salesSummary,
    pipelinesCount: pipArr.length,
    totalContacts,
    totalTags: tagsArr.length,
    topTags,
    recentContacts,
  };
  guardarMetricasPuente(cacheKey, result, revision);
  return result;
}

/* ============================================================
 * Estadísticas de apertura de correo POR CUENTA vía systemeio-mcp.
 * Fallback para cuentas SIN cookie de sesión local (apikey, o autologin sin
 * cookie guardada): el bridge levanta la sesión (bootstrapSession) y llama las
 * tools `get-email-stats-summary` + `list-emails-in-period`, ya desplegadas en
 * el MCP (server.ts registerEmailStatsTools). Las cuentas CON cookie usan la
 * Internal API directa (systemeio-internal-api.ts) — más rápida, sin navegador.
 * ============================================================ */

/**
 * SIO-EDITOR-1 · Editor de páginas del systemeio-mcp propio para el MCP del panel.
 * La identidad (student_id) y el panel (systeme.io o leadmatch-lab) salen SIEMPRE
 * de la cuenta conectada: el llamante no puede elegirlos.
 */
const INYECTADOS_EDITOR = ["student_id", "panel_base_url"];
export async function listarHerramientasEditor(accountId: string): Promise<Array<Record<string, any>>> {
  if (!bridgeStatus().live) throw Object.assign(new Error("El editor de páginas no está disponible en este stack"), { status: 503 });
  const ctx = await bootstrapSession({ accountId });
  const tl = await mcpRpc({ jsonrpc: "2.0", id: nextId(), method: "tools/list", params: {} }, ctx.sid, 30000);
  const tools = ((tl.data?.result as Record<string, unknown> | undefined)?.tools as Array<Record<string, any>> | undefined) ?? [];
  return tools.map((t) => {
    const s = { ...(t.inputSchema || {}) }, props = { ...(s.properties || {}) };
    for (const k of INYECTADOS_EDITOR) delete props[k];
    return { ...t, inputSchema: { ...s, properties: props, required: (s.required || []).filter((k: string) => !INYECTADOS_EDITOR.includes(k)) } };
  });
}
export async function llamarHerramientaEditor(accountId: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; json: unknown; text: string }> {
  if (!bridgeStatus().live) throw Object.assign(new Error("El editor de páginas no está disponible en este stack"), { status: 503 });
  const acc = await siGetAccount(accountId);
  if (!acc) throw Object.assign(new Error("La cuenta no pertenece a este negocio"), { status: 404 });
  const ctx = await bootstrapSession({ accountId });
  const limpios = Object.fromEntries(Object.entries(args).filter(([k]) => !INYECTADOS_EDITOR.includes(k)));
  const r = await callTool(ctx.sid, name, { ...limpios, student_id: ctx.studentId, ...(acc.panelBaseUrl ? { panel_base_url: acc.panelBaseUrl } : {}) });
  return { isError: r.isError, json: r.json, text: r.json ? "" : r.text };
}

export interface SiMcpEmailStats {
  summary: {
    totalSent: number;
    openRatePct: number;
    bounceRatePct: number;
    spamRatePct: number;
    activeDays: number;
    bestDay: { date: string; sent: number; openedPct: number } | null;
    worstDay: { date: string; sent: number; openedPct: number } | null;
    byDay: Array<{ date: string; sent: number; openedPct: number; bouncedPct: number; spamPct: number }>;
  } | null;
  emails: Array<{
    mailingId: number;
    subject: string;
    emailType: string;
    status: string;
    scheduledAt: string | null;
    sent: number;
    opened: number;
    clicked: number;
    bounced: number;
    spamReports: number;
    openRatePct: number;
    clickRatePct: number;
    clickThroughOpenRatePct: number;
    bounceRatePct: number;
  }>;
  reason?: string;
}

const r2 = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param dateFrom/@param dateTo ISO datetime (ej "2026-06-01T00:00:00"). Las
 * tools MCP exigen `date_from`/`date_to` (no dateSince/dateTill).
 */
export async function fetchSystemeioEmailStats(
  accountId: string | undefined,
  dateFrom: string,
  dateTo: string,
): Promise<SiMcpEmailStats | null> {
  // CORREO-API-1: API oficial primero (HTTP puro, sin sesión de navegador). null = no
  // se pudo leer → puente. Nunca se devuelve «0» por no haber podido leer (FALSO-CERO-1).
  try {
    const acc = accountId ? await siGetAccount(accountId) : await siGetActiveAccount();
    if (acc?.apiKey) {
      const r = await withPublicApiKey(acc.apiKey, () => estadisticasCorreoApi(dateFrom, dateTo, { max: 100 }));
      if (r) return { summary: r.summary, emails: r.emails };
    }
  } catch {
    /* cae al puente */
  }
  const st = bridgeStatus();
  if (!st.live) return null;
  let ctx;
  try {
    ctx = await bootstrapSession({ accountId });
  } catch (e) {
    return { summary: null, emails: [], reason: (e as Error).message || "bootstrap failed" };
  }
  const sid = ctx.sid;
  const base = { student_id: ctx.studentId };
  // SERIALIZADO (1 sesión de navegador por student): summary primero, luego lista.
  const summaryR = await callToolData(sid, [
    { name: "get-email-stats-summary", args: { ...base, date_from: dateFrom, date_to: dateTo } },
  ]);
  const listR = await callToolData(sid, [
    { name: "list-emails-in-period", args: { ...base, date_from: dateFrom, date_to: dateTo, limit: 100 } },
  ]);
  // Las tools ya calculan las tasas → el data trae report ya formateado.
  const sd = (summaryR?.data ?? null) as null | {
    total_sent?: number;
    average?: { opened_pct?: number; bounced_pct?: number; spam_reports_pct?: number };
    active_days?: number;
    best_day?: { date?: string; sent?: number; opened_pct?: number } | null;
    worst_day?: { date?: string; sent?: number; opened_pct?: number } | null;
    by_day?: Record<string, { sentAmount?: number; openedPercent?: number; bouncedPercent?: number; spamReportsPercent?: number }>;
  };
  let summary: SiMcpEmailStats["summary"] = null;
  if (sd) {
    const byDay = Object.entries(sd.by_day ?? {})
      .map(([date, s]) => ({
        date,
        sent: Number(s?.sentAmount) || 0,
        openedPct: r2(s?.openedPercent),
        bouncedPct: r2(s?.bouncedPercent),
        spamPct: r2(s?.spamReportsPercent),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    summary = {
      totalSent: Number(sd.total_sent) || 0,
      openRatePct: r2(sd.average?.opened_pct),
      bounceRatePct: r2(sd.average?.bounced_pct),
      spamRatePct: r2(sd.average?.spam_reports_pct),
      activeDays: Number(sd.active_days) || byDay.filter((d) => d.sent > 0).length,
      bestDay: sd.best_day
        ? { date: String(sd.best_day.date ?? ""), sent: Number(sd.best_day.sent) || 0, openedPct: r2(sd.best_day.opened_pct) }
        : null,
      worstDay: sd.worst_day
        ? { date: String(sd.worst_day.date ?? ""), sent: Number(sd.worst_day.sent) || 0, openedPct: r2(sd.worst_day.opened_pct) }
        : null,
      byDay,
    };
  }
  const ld = (listR?.data ?? {}) as {
    items?: Array<Record<string, unknown>>;
  };
  const emails = (ld.items ?? []).map((e) => ({
    mailingId: Number(e.mailing_id) || 0,
    subject: String(e.subject ?? "(sin asunto)"),
    emailType: String(e.email_type ?? ""),
    status: String(e.status ?? ""),
    scheduledAt: (e.scheduled_at as string) ?? null,
    sent: Number(e.sent) || 0,
    opened: Number(e.opened) || 0,
    clicked: Number(e.clicked) || 0,
    bounced: Number(e.bounced) || 0,
    spamReports: Number(e.spam_reports) || 0,
    openRatePct: r2(e.open_rate_pct),
    clickRatePct: r2(e.click_rate_pct),
    clickThroughOpenRatePct: r2(e.click_through_open_rate_pct),
    bounceRatePct: r2(e.bounce_rate_pct),
  }));
  return { summary, emails };
}

/* ============================================================
 * Worker.
 * ============================================================ */

let workerStarted = false;
let stopWorker = false;

/**
 * UNA pasada de jobs vencidos — lo que hace cada tick del worker. Exportada
 * para poder probar la cola (encolar → procesar → verificar) sin arrancar el
 * setTimeout de 20 s. Devuelve cuántos jobs reclamó esta pasada.
 */
export async function processDueMcpJobsOnce(): Promise<number> {
  const due = await pickDueJobs();
  // Multi-tenant W8: cada job corre bajo su tenant_id (ya viaja en McpJob).
  // Sin tenant_id explícito → 'default' (regresión zero).
  for (const j of due) {
    await runWithWorkspace(j.tenant_id || "default", async () => {
      await executeJob(j);
    });
  }
  return due.length;
}

export function startMcpBridgeWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const tick = async () => {
    if (stopWorker) return;
    try {
      await processDueMcpJobsOnce();
    } catch (e) {
      console.error("[mcp-bridge] worker err:", (e as Error).message);
      // FASE-5: telemetría — el worker MCP reventó (pickDueJobs, runWithWorkspace, executeJob).
      // tenant_id auto desde workspace ALS — fallback 'default' si no hay scope abierto.
      await logActivity({
        source: "mcp-job",
        level: "error",
        status: "error",
        summary: `MCP bridge worker tick falló: ${(e as Error).message.slice(0, 160)}`,
        payload: {
          file: "mcp-bridge.ts",
          fn: "startMcpBridgeWorker.tick",
          error: (e as Error).message.slice(0, 400),
        },
      });
    } finally {
      if (!stopWorker) setTimeout(tick, 20_000);
    }
  };
  setTimeout(tick, 5_000);
  const st = bridgeStatus();
  console.log(
    "[mcp-bridge] worker arrancado (modo direct-http, " +
      (st.live ? "LIVE" : "DRAFT — " + (st.reason || "config faltante")) +
      ")",
  );
}

// ============================================================
// CORREO PRO — detalle de UN envío (mailing): stats absolutas, destinatarios
// con estado individual (quién abrió / clicó / rebotó / marcó spam) y clics
// por enlace. Todo vía las tools del curso; normalización DEFENSIVA porque
// las tools devuelven claves snake_case con variantes.
// ============================================================
export interface SiMailingRecipient {
  email: string;
  name: string;
  opened: boolean;
  clicked: boolean;
  bounced: boolean;
  spam: boolean;
  // LISTA-COMPLETA-1 · el id de la fila en la web es el CURSOR de paginación
  // (pagination[startingAfter]): sin él no se puede pedir la página siguiente.
  id?: number | null;
}

// LISTA-COMPLETA-1 · el mapeo de una fila de /statistics/list, compartido entre la
// ficha (primera página) y el cargador del resto de páginas.
function siMapRecipientRows(rawRec: Array<Record<string, unknown>>): SiMailingRecipient[] {
  const truthy = (v: unknown): boolean => v === true || v === 1 || v === "1" || (typeof v === "string" && v !== "" && v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "null");
  return rawRec.map((r) => {
    const contact = (r.contact ?? {}) as Record<string, unknown>;
    const idRaw = r.id ?? r.recipient_id ?? r.recipientId;
    return {
      id: idRaw == null || idRaw === "" ? null : (Number(idRaw) || null),
      email: String(r.email ?? contact.email ?? "").slice(0, 160),
      name: String(r.name ?? contact.name ?? contact.first_name ?? "").slice(0, 120),
      // FICHA-CORREO-3 · las dos vías leen la MISMA lista y tenían cascadas distintas: aquí
      // faltaban las formas isXxx y allí las is_xxx. Ahora las dos cubren la unión, y lo
      // vigila scripts/check-simetria-correo.mjs.
      opened: truthy(r.opened ?? r.isOpened ?? r.is_opened ?? r.openedAt ?? r.opened_at),
      clicked: truthy(r.clicked ?? r.isClicked ?? r.is_clicked ?? r.clickedAt ?? r.clicked_at),
      bounced: truthy(r.bounced ?? r.isBounced ?? r.is_bounced ?? r.bouncedAt ?? r.bounced_at),
      // FICHA-CORREO-3 · spam era el único que NO cubría el camelCase, mientras opened,
      // clicked y bounced sí miran openedAt/clickedAt/bouncedAt. Si la web manda spamAt (que
      // es la forma que documenta el comentario de arriba), el chip «Spam» decía un número y
      // al filtrar no salía ninguna fila. Se alinea con la cascada de la vía directa.
      spam: truthy(r.spam ?? r.spamAt ?? r.spam_at ?? r.spamReported ?? r.spamReportedAt ?? r.spam_report ?? r.is_spam ?? r.isSpamReport),
    };
  }).filter((r) => r.email);
}
function siPickRecipientRows(data: unknown): Array<Record<string, unknown>> {
  const rd = (data ?? {}) as Record<string, unknown>;
  const cands: unknown[] = [
    data, rd.items, rd.recipients, rd.contacts, rd.list, rd.rows,
    (rd.data as Record<string, unknown> | undefined)?.items,
    (rd.data as Record<string, unknown> | undefined)?.recipients,
    rd.data,
  ];
  return (cands.find((c) => Array.isArray(c) && (c as unknown[]).length) ?? []) as Array<Record<string, unknown>>;
}

// LISTA-COMPLETA-1 · la lista ENTERA en UNA llamada. systeme.io quitó la paginación por
// cursor de su API interna (la página 2 devuelve HTTP 400 «Este formulario no debería
// contener campos adicionales», verificado 1-sep-2026), pero /statistics/list SÍ acepta
// un pagination[limit] arbitrario (probado con 5000). La tool `browser-fetch` del puente
// hace un fetch autenticado con la sesión del navegador a una URL cruda: es la única vía
// que trae los 2.755 de golpe. Cada fila: openedAt (null = no abrió), clicked, bounced,
// spam, contact.{id,email}. Los envíos de tipo campaña dan 404 aquí (no existen).
export async function fetchSystemeioMailingRecipientsAll(
  accountId: string | undefined,
  mailingId: number | string,
  limit: number,
): Promise<{ recipients: SiMailingRecipient[]; reason: string | null }> {
  const st = bridgeStatus();
  if (!st.live) return { recipients: [], reason: st.reason || "puente no disponible" };
  let ctx;
  try { ctx = await bootstrapSession({ accountId }); }
  catch (e) { return { recipients: [], reason: (e as Error).message || "bootstrap failed" }; }
  let base = "https://systeme.io";
  try { const acc = accountId ? await siGetAccount(accountId) : null; if (acc?.panelBaseUrl) base = String(acc.panelBaseUrl).replace(/\/+$/, ""); } catch { /* base por defecto */ }
  const lim = Math.min(20_000, Math.max(200, Math.floor(limit) || 200));
  const url = `${base}/api/dashboard/customer/mailing/${mailingId}/statistics/list?pagination[order]=next&pagination[limit]=${lim}`;
  const r = await callToolData(ctx.sid, [{ name: "browser-fetch", args: { student_id: ctx.studentId, url, max_response_length: 8_000_000 } }]);
  if (!r) return { recipients: [], reason: "browser-fetch sin respuesta" };
  if ((r as { error?: unknown }).error) return { recipients: [], reason: String(((r as { error?: { message?: string } }).error?.message) || "browser-fetch error") };
  // El cuerpo puede venir ya parseado, como string JSON, o anidado en {body}/{data}.
  let payload: unknown = r.data;
  const desanida = (v: unknown): unknown => {
    if (v == null) return v;
    if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.items)) return o;
      if (o.body != null) return desanida(o.body);
      if (o.text != null) return desanida(o.text);
      if (o.data != null && !Array.isArray(o.data)) return desanida(o.data);
    }
    return v;
  };
  payload = desanida(payload);
  const recipients = siMapRecipientRows(siPickRecipientRows(payload));
  return { recipients, reason: recipients.length ? null : "browser-fetch devolvió una lista vacía" };
}

// VENTAS-SIO-1 · una página del listado de Ventas por la sesión del puente (cuentas que
// entran con usuario y contraseña). Misma tool `browser-fetch` que LISTA-COMPLETA-1: ya
// manda X-Requested-With, sin el cual systeme.io devuelve la página HTML y no el JSON.
export async function fetchSystemeioTransactionsPage(
  accountId: string,
  query: string,
): Promise<{ ok: boolean; data: unknown; reason: string | null }> {
  const st = bridgeStatus();
  if (!st.live) return { ok: false, data: null, reason: st.reason || "puente no disponible" };
  let ctx;
  try { ctx = await bootstrapSession({ accountId }); }
  catch (e) { return { ok: false, data: null, reason: (e as Error).message || "bootstrap failed" }; }
  let base = "https://systeme.io";
  try { const acc = await siGetAccount(accountId); if (acc?.panelBaseUrl) base = String(acc.panelBaseUrl).replace(/\/+$/, ""); } catch { /* base por defecto */ }
  const url = `${base}/api/dashboard/customer/payment/transactions/list/v2?${query}`;
  const r = await callToolData(ctx.sid, [{ name: "browser-fetch", args: { student_id: ctx.studentId, url, max_response_length: 4_000_000 } }]);
  if (!r) return { ok: false, data: null, reason: "browser-fetch sin respuesta" };
  if ((r as { error?: unknown }).error) return { ok: false, data: null, reason: String(((r as { error?: { message?: string } }).error?.message) || "browser-fetch error") };
  const d = r.data as { status?: number; body?: unknown } | string | null;
  const status = d && typeof d === "object" ? Number(d.status) || 0 : 0;
  if (status && status !== 200) return { ok: false, data: null, reason: "HTTP " + status };
  let body: unknown = d && typeof d === "object" && "body" in d ? d.body : d;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return { ok: false, data: null, reason: "respuesta que no es JSON" }; } }
  return { ok: true, data: body, reason: null };
}

// LISTA-COMPLETA-1 · UNA página más de destinatarios, a partir del cursor. La lista
// entera de un envío grande (2.755) son ~28 páginas de 100: pedirlas todas en una
// petición reventaba el tiempo del puente (verificado 2026-08-13, el auto-paginado
// devolvía data=null). En cambio una página responde en 1-2 s. El panel las va
// pidiendo de una en una y rellena la tabla mientras el usuario mira.
export async function fetchSystemeioMailingRecipientsPage(
  accountId: string | undefined,
  mailingId: number | string,
  afterId?: number | null,
): Promise<{ recipients: SiMailingRecipient[]; hasMore: boolean; lastId: number | null; reason: string | null }> {
  const st = bridgeStatus();
  if (!st.live) return { recipients: [], hasMore: false, lastId: null, reason: st.reason || "puente no disponible" };
  let ctx;
  try { ctx = await bootstrapSession({ accountId }); }
  catch (e) { return { recipients: [], hasMore: false, lastId: null, reason: (e as Error).message || "bootstrap failed" }; }
  const args: Record<string, unknown> = { student_id: ctx.studentId, mailing_id: mailingId, auto_paginate: false, limit: 100 };
  if (afterId != null) args.starting_after_id = afterId;
  const r = await callToolData(ctx.sid, [{ name: "list-mailing-recipients", args }]);
  const rd = (r?.data ?? {}) as Record<string, unknown>;
  const recipients = siMapRecipientRows(siPickRecipientRows(r?.data));
  const hasMore = !!(rd.hasMore ?? rd.has_more) && recipients.length > 0;
  const lastId = recipients.length ? (recipients[recipients.length - 1].id ?? null) : null;
  return { recipients, hasMore: hasMore && lastId != null, lastId, reason: (!recipients.length && r?.error) ? String((r.error as { message?: string })?.message || "sin datos") : null };
}
export interface SiMailingDetail {
  stats: {
    sent: number | null; opened: number | null; clicked: number | null;
    bounced: number | null; spam: number | null;
    openRatePct: number | null; clickRatePct: number | null; bounceRatePct: number | null;
  } | null;
  recipients: SiMailingRecipient[];
  recipientsTotal: number | null;
  recipientsTruncated: boolean;
  // LISTA-COMPLETA-1 · cursor para pedir la página siguiente de destinatarios.
  recLastId?: number | null;
  // STATS-ID-1 · id del envío en el espacio de las ESTADÍSTICAS (el de list-emails-in-period).
  statsId?: number | null;
  // FICHA-CORREO-2 · `type` y `label` vienen del propio systeme.io (click-link-statistics
  // devuelve {link, displayLinkName, type, …}); el puente los tiraba y el panel no podía
  // decir qué clase de enlace es cada fila (el de darse de baja, por ejemplo).
  clicks: Array<{ url: string; unique: number | null; total: number | null; type?: string; label?: string }>;
  reason: string | null;
  // Payloads CRUDOS de las tools (para el modo debug=1 del endpoint admin —
  // las formas exactas de respuesta del curso no están documentadas).
  raw?: { stats: unknown; recipients: unknown; clicks: unknown };
}
export async function fetchSystemeioMailingDetail(
  accountId: string | undefined,
  mailingId: number | string,
  hint?: { subject?: string; scheduledAt?: string | null },
): Promise<SiMailingDetail | null> {
  const st = bridgeStatus();
  if (!st.live) return null;
  let ctx;
  try {
    ctx = await bootstrapSession({ accountId });
  } catch (e) {
    return { stats: null, recipients: [], recipientsTotal: null, recipientsTruncated: false, clicks: [], reason: (e as Error).message || "bootstrap failed" };
  }
  const sid = ctx.sid;
  const base = { student_id: ctx.studentId, mailing_id: mailingId };
  const num = (v: unknown): number | null => (v == null || v === "" ? null : (Number(v) || 0));
  const truthy = (v: unknown): boolean => v === true || v === 1 || v === "1" || (typeof v === "string" && v !== "" && v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "no");
  // SERIALIZADO (1 sesión por student). VERIFICADO en prod 2026-08-13: el
  // auto-paginado devolvía data=null (el tool revienta su timeout interno con
  // miles de destinatarios) — UNA página de 100 responde en ~1-2s fiable;
  // recipientsTruncated rotula el corte.
  // CONTAR NO ES LISTAR (FICHA-CORREO-1). Los contadores de la ficha salían de
  // la página de 100 que devuelve list-mailing-recipients: «Todos · 100» sobre
  // un envío de 2.788, y «Abrieron 9» presentado como hecho del correo cuando
  // arriba ponía 225. La propia tool lo dice en su descripción: «úsalo para
  // auditar quién abrió/cliqueó, NO para contar (usa get-mailing-stats)».
  // ⚠ `get-mailing-stats` pega a /mailing/{id}/preview y ESO DEVUELVE 403 en
  // producción: verificado el 2026-09-01 con sesión recién logueada y sana
  // (`HTTP 403 {"redirect":"https://systeme.io/dashboard"}`). No era la sesión.
  // Se sigue intentando —es una call y si algún día vuelve, mejor— pero el
  // agregado bueno viene de `list-emails-in-period`, la MISMA fuente que
  // alimenta la pestaña Correo de Métricas, que además trae rebotes y spam.
  //
  // VAN LAS PRIMERAS A PROPÓSITO: el puente serializa (1 sesión por student) y
  // el handler tiene 40 s. Son las calls que sostienen las cifras grandes y los
  // chips, así que si el presupuesto se agota se pierde la LISTA (que ya era una
  // muestra) y no los totales.
  // STATS-ID-1 · Las newsletters tienen DOS ids: el del catálogo (5448315) y el de las
  // estadísticas (13156923). Destinatarios y clics por enlace solo existen con el segundo;
  // con el primero systeme.io contesta 403 o —peor— con los clics de OTRO correo (la ficha
  // enseñaba enlaces de Instagram y de un carrito que no estaban en el envío). Por eso lo
  // primero es la lista por período, que trae el id bueno, casada por asunto (y no por id,
  // que en el otro espacio puede ser de otro correo) o, sin asunto, por id.
  const dia = 86_400_000;
  const iso = (t: number): string => new Date(t).toISOString().slice(0, 19);
  const ancla = hint?.scheduledAt ? Date.parse(hint.scheduledAt) : NaN;
  const ok = Number.isFinite(ancla);
  const per = await callToolData(sid, [{ name: "list-emails-in-period", args: {
    ...base,
    mailing_id: undefined,
    date_from: iso(ok ? ancla - 1.5 * dia : Date.now() - 120 * dia),
    date_to: iso(ok ? ancla + 1.5 * dia : Date.now() + dia),
    limit: 100,
  } }]);
  const pd = (per?.data ?? {}) as Record<string, unknown>;
  const lista = ((pd.items ?? pd.emails ?? pd.list ?? []) as Array<Record<string, unknown>>) || [];
  const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const quiero = norm(hint?.subject);
  const e = quiero
    ? lista.find((x) => norm(x.subject) === quiero)
    : lista.find((x) => String(x.mailing_id ?? x.mailingId) === String(mailingId));
  const statsIdN = e ? Number(e.mailing_id ?? e.mailingId) || null : null;
  const idUso: number | string = statsIdN ?? mailingId;
  const baseUso = { student_id: ctx.studentId, mailing_id: idUso };
  let stR: Awaited<ReturnType<typeof callToolData>> | null = null;
  let stats: SiMailingDetail["stats"] = null;
  if (e && num(e.sent) != null) {
    stats = {
      sent: num(e.sent), opened: num(e.opened), clicked: num(e.clicked),
      bounced: num(e.bounced), spam: num(e.spam_reports ?? e.spamReports),
      openRatePct: num(e.open_rate_pct), clickRatePct: num(e.click_rate_pct), bounceRatePct: num(e.bounce_rate_pct),
    };
  } else {
    // Sin casar en la lista: se prueba get-mailing-stats (hoy da 403 en producción, ver arriba).
    stR = await callToolData(sid, [{ name: "get-mailing-stats", args: baseUso }]);
    const sd = (stR?.data ?? {}) as Record<string, unknown>;
    const sdRates = (sd.rates_pct ?? {}) as Record<string, unknown>;
    const stSent = num(sd.sent_amount ?? sd.sentAmount ?? sd.sent);
    if (stSent != null) {
      stats = {
        sent: stSent,
        opened: num(sd.opened_amount ?? sd.openedAmount ?? sd.opened),
        clicked: num(sd.clicked_amount ?? sd.clickedAmount ?? sd.clicked),
        bounced: num(sd.bounced_amount ?? sd.bouncedAmount ?? sd.bounced),
        spam: num(sd.spam_report_amount ?? sd.spamReportAmount ?? sd.spam),
        openRatePct: num(sdRates.open_rate ?? sdRates.openRate),
        clickRatePct: num(sdRates.click_rate ?? sdRates.clickRate),
        bounceRatePct: num(sdRates.bounce_rate ?? sdRates.bounceRate),
      };
    }
  }
  // El total de destinatarios es `sent`: mismo número que enseña systeme.io en
  // la cabecera del envío. get-mailing-recipients-count daría lo mismo con una
  // call extra, así que no se gasta (el puente ya serializa tres).
  const recipientsTotal: number | null = stats ? stats.sent : null;
  // La muestra y el desglose por enlace van DESPUÉS de los agregados: son las
  // dos calls caras y las prescindibles (ver el comentario de arriba).
  const recR = await callToolData(sid, [{ name: "list-mailing-recipients", args: { ...baseUso, auto_paginate: false, limit: 100 } }]);
  const clkR = await callToolData(sid, [{ name: "get-mailing-click-stats", args: baseUso }]);
  // La forma del payload de recipients varía: array directo, {items}, {recipients},
  // {contacts}, o anidado en {data:{items}} — probamos todas (verificado en prod
  // que el count llega pero la lista venía en una forma no contemplada).
  const rd = (recR?.data ?? {}) as Record<string, unknown>;
  const recCandidates: unknown[] = [
    recR?.data,
    rd.items, rd.recipients, rd.contacts, rd.list, rd.rows,
    (rd.data as Record<string, unknown> | undefined)?.items,
    (rd.data as Record<string, unknown> | undefined)?.recipients,
    rd.data,
  ];
  const rawRec = (recCandidates.find((c) => Array.isArray(c) && (c as unknown[]).length) ?? []) as Array<Record<string, unknown>>;
  const recipients: SiMailingRecipient[] = siMapRecipientRows(rawRec);
  const kd = (clkR?.data ?? {}) as Record<string, unknown>;
  const clkCandidates: unknown[] = [clkR?.data, kd.links, kd.items, kd.clicks, (kd.data as Record<string, unknown> | undefined)?.items, kd.data];
  const rawClk = (clkCandidates.find((c) => Array.isArray(c) && (c as unknown[]).length) ?? []) as Array<Record<string, unknown>>;
  // Forma REAL verificada en prod: {items:[{link, uniqueClickAmount,
  // totalClickAmount, displayLinkName, mailingLinkId, type}]}.
  const clicks = rawClk.map((c) => ({
    url: String(c.link ?? c.url ?? c.displayLinkName ?? c.href ?? "").slice(0, 400),
    unique: num(c.uniqueClickAmount ?? c.unique ?? c.unique_clicks ?? c.uniqueClicks ?? c.unique_amount ?? c.uniqueAmount ?? c.unique_count ?? c.uniqueCount ?? c.uniqueVisitorsCount),
    total: num(c.totalClickAmount ?? c.total ?? c.total_clicks ?? c.totalClicks ?? c.total_amount ?? c.totalAmount ?? c.count ?? c.clicks ?? c.clicksAmount ?? c.visitorsCount),
    type: String(c.type ?? "").slice(0, 40),
    label: String(c.displayLinkName ?? c.name ?? "").slice(0, 160),
  })).filter((c) => c.url);
  return {
    stats,
    recipients,
    recipientsTotal,
    recipientsTruncated: truthy(rd.truncated ?? rd.has_more) || (recipientsTotal != null && recipients.length > 0 && recipients.length < recipientsTotal),
    recLastId: recipients.length ? (recipients[recipients.length - 1].id ?? null) : null,
    statsId: statsIdN,
    clicks,
    // `stats` cuenta como dato: con los agregados pero sin lista, la respuesta
    // es útil (chips y cifras grandes salen) y decir «no devolvió datos» sería
    // falso — y el cliente pinta ese texto en la tarjeta.
    reason: (!rawRec.length && !rawClk.length && !stats) ? "El puente no devolvió datos para este envío." : null,
    raw: { stats: stR?.data ?? null, recipients: recR?.data ?? null, clicks: clkR?.data ?? null },
  };
}

// Contenido del correo vía puente: las cuentas autologin NO guardan sessionCookie
// (verificado en prod: la vía interna directa nunca se ejecutaba), así que el
// cuerpo solo puede venir de list-newsletters del curso (items con
// mailing.currentEmail). Match por id de mailing y fallback por asunto.
export async function fetchSystemeioNewsletterContent(
  accountId: string | undefined,
  mailingId: number | string,
  subjectHint?: string,
  emailType?: string,
  wfEmailId?: number,
): Promise<{ subject: string | null; html: string | null; sample?: unknown } | null> {
  // PUENTE-API-1 · API oficial primero: GET /api/mailing/newsletters/{id}. El id de
  // las estadísticas puede ser OTRO espacio que el de la newsletter, así que sólo se
  // da por bueno si el asunto coincide con la pista (o no hay pista y no es un
  // correo de automatización). Cualquier duda → camino del MCP, como antes.
  try {
    const acc = accountId ? await siGetAccount(accountId) : await siGetActiveAccount();
    const nid = Number(mailingId) || 0;
    if (acc?.apiKey && nid > 0 && emailType !== "automation") {
      const n = await withPublicApiKey(acc.apiKey, () => siGetNewsletterPublic(nid));
      const norm0 = (x: unknown): string => String(x ?? "").trim().toLowerCase().replace(/\s+/g, " ");
      if (n && n.bodyHtml && (!subjectHint || norm0(n.subject) === norm0(subjectHint))) {
        return { subject: n.subject || null, html: n.bodyHtml };
      }
    }
  } catch { /* API directa falló → probamos por el MCP */ }
  const st = bridgeStatus();
  if (!st.live) return null;
  let ctx;
  try { ctx = await bootstrapSession({ accountId }); } catch { return null; }
  // 0) get-newsletter-content — tool ADITIVA del systemeio-mcp (en prod desde
  // 264c826): devuelve body/html por mailing_id/asunto. email_type=automation
  // le indica que busque por la vía de workflow-emails. wfEmailId es el id del
  // EMAIL de workflow resuelto por asunto desde el builder (OTRO espacio de ids
  // que el mailingId de stats — verificado en prod): la tool hace GET directo a
  // /customer/emails/{newsletter_id} con él.
  try {
    const t0 = await callTool(ctx.sid, "get-newsletter-content", {
      student_id: ctx.studentId,
      mailing_id: Number(mailingId) || undefined,
      newsletter_id: (Number(wfEmailId) || 0) > 0 ? Number(wfEmailId) : undefined,
      subject: subjectHint || undefined,
      email_type: emailType || undefined,
    });
    if (!t0.isError && t0.json) {
      const d0 = ((t0.json as Record<string, unknown>).data ?? t0.json) as Record<string, unknown>;
      const html0 = String(d0.body ?? d0.html ?? "") || null;
      if (html0) return { subject: String(d0.subject ?? "") || null, html: html0 };
    }
  } catch { /* tool aún no desplegada — seguimos con el camino viejo */ }
  // list-newsletters: VERIFICADO en prod — la tool está rota en origen
  // (auto_paginate fuerza limit=100 → 400 de systeme.io con cualquier arg);
  // se mantiene el intento por si el server se arregla.
  let nlErr: string | null = null;
  let r: Record<string, unknown> | null = null;
  // SIN limit primero (que la tool use su default) — 10/20/50/100 dan 400 de
  // paginación en systeme.io para newsletters.
  const nlAttempts: Array<Record<string, unknown>> = [
    { student_id: ctx.studentId },
    { student_id: ctx.studentId, limit: 10 },
    { student_id: ctx.studentId, limit: 5 },
  ];
  for (const args of nlAttempts) {
    try {
      const t = await callTool(ctx.sid, "list-newsletters", args);
      if (t.isError) { nlErr = String(t.text || "error").slice(0, 220); continue; }
      r = t.json; nlErr = null; break;
    } catch (e) { nlErr = String((e as Error).message || e).slice(0, 220); }
  }
  const d = (r?.data ?? {}) as Record<string, unknown>;
  const items = ([] as Array<Record<string, any>>)
    .concat(Array.isArray(d.newsletters) ? (d.newsletters as Array<Record<string, any>>) : [])
    .concat(Array.isArray(d.items) ? (d.items as Array<Record<string, any>>) : [])
    .concat(Array.isArray(r?.data) ? (r?.data as Array<Record<string, any>>) : []);
  const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const hint = norm(subjectHint);
  const want = Number(mailingId) || -1;
  const extract = (n: Record<string, any>): { subject: string | null; html: string | null } => {
    const m = (n.mailing ?? {}) as Record<string, any>;
    const cur = (m.currentEmail ?? n.currentEmail ?? n.current_email ?? {}) as Record<string, any>;
    const html = String(cur.content ?? cur.body ?? cur.html ?? cur.compiledContent ?? n.content ?? "") || null;
    return { subject: String(cur.subject ?? n.subject ?? "") || null, html };
  };
  for (const n of items) {
    const m = (n.mailing ?? {}) as Record<string, any>;
    const ids = [n.id, n.mailing_id, n.mailingId, m.id, m.mailingId].map((x) => Number(x) || 0);
    if (ids.includes(want)) return extract(n);
  }
  if (hint) {
    for (const n of items) {
      const m = (n.mailing ?? {}) as Record<string, any>;
      const cand = [n.subject, m.currentEmail?.subject].map(norm);
      if (cand.includes(hint)) return extract(n);
    }
  }
  // Sin match: muestra para debug. Incluye el INVENTARIO real de tools del MCP
  // (tools/list) filtrado por mail/news/letter — se acabó adivinar nombres.
  let toolNames: string[] = [];
  try {
    const tl = await mcpRpc({ jsonrpc: "2.0", id: nextId(), method: "tools/list", params: {} }, ctx.sid, 30000);
    const tools = ((tl.data?.result as Record<string, unknown> | undefined)?.tools as Array<{ name?: string }> | undefined) ?? [];
    toolNames = tools.map((t) => String(t.name || "")).filter((n) => /mail|news|letter|email/i.test(n)).slice(0, 30);
  } catch { /* inventario opcional */ }
  return {
    subject: null,
    html: null,
    sample: {
      v: 3,
      itemsLen: items.length,
      nlErr,
      snippet: JSON.stringify(r?.data ?? null).slice(0, 400),
      toolsMail: toolNames,
      first: items.slice(0, 4).map((n) => ({ id: n.id, mailingId: (n.mailing ?? {}).id ?? null, subject: String(n.subject ?? "").slice(0, 50), keys: Object.keys(n).slice(0, 12) })),
    },
  };
}

// ── Mapeo correo→automatización (workflows de systeme.io) ────────────────────
// Para la card «Automatizaciones» de Métricas→Correo: qué correos pertenecen a
// qué workflow y en qué orden aproximado del flujo. Solo lectura:
//   list-workflows        → id/nombre/estado de cada workflow
//   read-workflow (×N)    → JSON del builder; los pasos send_email llevan el id
//                           del correo (systemeEmail)
//   list-workflow-emails  → /emails/options: id→asunto para casar con las stats
export async function fetchSystemeioWorkflowEmails(
  accountId: string | undefined,
): Promise<{
  workflows: Array<{ id: number | string; name: string; active: boolean | null; emailIds: number[] }>;
  campaigns: Array<{ id: number | string; name: string; active: boolean | null; emailIds: number[] }>;
  funnels: Array<{ id: number | string; name: string; active: boolean | null; emailIds: number[] }>;
  rules: number[];
  emailSubjects: Record<string, string>;
  sample?: unknown;
} | null> {
  const st = bridgeStatus();
  if (!st.live) return null;
  let ctx;
  try { ctx = await bootstrapSession({ accountId }); } catch { return null; }

  // 1) Listado de workflows.
  let wfList: Array<Record<string, unknown>> = [];
  try {
    const t = await callTool(ctx.sid, "list-workflows", { student_id: ctx.studentId });
    if (!t.isError && t.json) {
      const d = ((t.json as Record<string, unknown>).data ?? t.json) as Record<string, unknown>;
      const arr = (d.workflows ?? d.items ?? d) as unknown;
      if (Array.isArray(arr)) wfList = arr as Array<Record<string, unknown>>;
    }
  } catch { /* sin workflows legibles — devolvemos vacío honesto abajo */ }

  // 2) id→asunto de los correos de workflow. VERIFICADO en prod: los ids de
  //    email de workflow (21xxxxxx) son OTRO espacio que los mailingIds de las
  //    stats (12xxxxxx) — el match con las stats va por ASUNTO sí o sí.
  //    Fuente A: /emails/options (list-workflow-emails). Parseo tolerante: el
  //    array puede venir en cualquier nivel ({emails:{items:[...]}} incluido).
  const emailSubjects: Record<string, string> = {};
  let rawOptions: unknown = null;
  const harvestPairs = (node: unknown, depth: number): void => {
    if (depth > 4 || node == null) return;
    if (Array.isArray(node)) {
      for (const e of node as Array<Record<string, unknown>>) {
        if (e && typeof e === "object") {
          const id = Number((e as Record<string, unknown>).id ?? (e as Record<string, unknown>).value ?? (e as Record<string, unknown>).emailId) || 0;
          const subj = String((e as Record<string, unknown>).subject ?? (e as Record<string, unknown>).label ?? (e as Record<string, unknown>).name ?? "").trim();
          if (id && subj) emailSubjects[String(id)] = subj;
        }
      }
      return;
    }
    if (typeof node === "object") { for (const k of Object.keys(node as Record<string, unknown>)) harvestPairs((node as Record<string, unknown>)[k], depth + 1); }
  };
  try {
    const t = await callTool(ctx.sid, "list-workflow-emails", { student_id: ctx.studentId });
    if (!t.isError && t.json) {
      rawOptions = JSON.stringify(t.json).slice(0, 500);
      harvestPairs((t.json as Record<string, unknown>).data ?? t.json, 0);
    } else rawOptions = "isError: " + String(t.text || "").slice(0, 300);
  } catch (e) { rawOptions = "throw: " + String((e as Error).message || e).slice(0, 200); }

  // 3) Pasos de cada workflow: paseo profundo del JSON del builder recogiendo
  //    ids de correos en orden de aparición (aprox. orden del flujo). Fuente B
  //    de asuntos: el builder suele INCRUSTAR el objeto del email en el paso
  //    (systemeEmail:{id,subject,...} — es lo que pinta en la caja del paso).
  //    Cap 15 workflows: el puente serializa y esto se cachea 1h en el server.
  let stepSample: unknown = null;
  const collectEmailIds = (node: unknown, out: number[]): void => {
    if (Array.isArray(node)) { for (const n of node) collectEmailIds(n, out); return; }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const push = (v: unknown): void => {
      if (v && typeof v === "object") {
        const eo = v as Record<string, unknown>;
        const id = Number(eo.id) || 0;
        if (id) {
          if (!out.includes(id)) out.push(id);
          const subj = String(eo.subject ?? eo.name ?? eo.label ?? eo.title ?? "").trim();
          if (subj && !emailSubjects[String(id)]) emailSubjects[String(id)] = subj;
          if (stepSample == null) stepSample = { keys: Object.keys(eo).slice(0, 14), subject: subj.slice(0, 60) || null };
        }
        return;
      }
      const id = Number(v);
      if (id && !out.includes(id)) out.push(id);
    };
    if (o.systemeEmail != null) push(o.systemeEmail);
    if (o.systeme_email != null) push(o.systeme_email);
    // Acciones de envío: el nombre del tipo varía por endpoint (send_email,
    // sendEmail, SEND_EMAIL…) — vale cualquier type que contenga 'email'.
    if (String(o.type ?? o.actionType ?? "").toLowerCase().indexOf("email") >= 0) {
      for (const k of ["email", "emailId", "email_id", "mailingId", "mailing", "systemeEmail"]) if (o[k] != null) push(o[k]);
    }
    for (const k of Object.keys(o)) collectEmailIds(o[k], out);
  };
  const workflows: Array<{ id: number | string; name: string; active: boolean | null; emailIds: number[] }> = [];
  let firstRaw: unknown = null;
  for (const wf of wfList.slice(0, 15)) {
    const wid = wf.id ?? wf.workflowId;
    if (wid == null) continue;
    const name = String(wf.name ?? wf.title ?? ("Workflow " + wid));
    const active = typeof wf.active === "boolean" ? wf.active : (typeof wf.enabled === "boolean" ? wf.enabled : null);
    const emailIds: number[] = [];
    try {
      const t = await callTool(ctx.sid, "read-workflow", { student_id: ctx.studentId, workflow_id: String(wid) });
      if (!t.isError && t.json) {
        if (firstRaw == null) firstRaw = { keys: Object.keys(t.json).slice(0, 12) };
        collectEmailIds(t.json, emailIds);
      }
    } catch { /* workflow ilegible — aparece sin correos */ }
    workflows.push({ id: wid as number | string, name, active, emailIds });
  }
  // 4) CAMPAÑAS (secuencias de correos): las stats también las reportan como
  //    emailType 'automation' — verificado en prod: 36/48 correos «automation»
  //    no estaban en ningún workflow, son de campañas. list-campaigns +
  //    list-campaign-emails (pasos EN ORDEN de la secuencia, con asunto).
  const campaigns: Array<{ id: number | string; name: string; active: boolean | null; emailIds: number[] }> = [];
  let campSample: unknown = null;
  try {
    const t = await callTool(ctx.sid, "list-campaigns", { student_id: ctx.studentId });
    if (!t.isError && t.json) {
      const d = ((t.json as Record<string, unknown>).data ?? t.json) as Record<string, unknown>;
      const arr = (Array.isArray(d.campaigns) ? d.campaigns : (Array.isArray(d.items) ? d.items : (Array.isArray(d) ? d : []))) as Array<Record<string, unknown>>;
      for (const c of arr.slice(0, 15)) {
        const cid = c.id ?? c.campaignId;
        if (cid == null) continue;
        const cname = String(c.name ?? c.title ?? ("Campaña " + cid));
        const cactive = typeof c.active === "boolean" ? c.active : (typeof c.enabled === "boolean" ? c.enabled : null);
        const emailIds: number[] = [];
        try {
          const t2 = await callTool(ctx.sid, "list-campaign-emails", { student_id: ctx.studentId, campaign_id: String(cid) });
          if (!t2.isError && t2.json) {
            const d2 = ((t2.json as Record<string, unknown>).data ?? t2.json) as Record<string, unknown>;
            const steps = (Array.isArray(d2.emails) ? d2.emails : (Array.isArray(d2.items) ? d2.items : [])) as Array<Record<string, unknown>>;
            for (const s of steps) {
              const mailing = (s.mailing ?? {}) as Record<string, unknown>;
              const cur = (mailing.currentEmail ?? s.currentEmail ?? {}) as Record<string, unknown>;
              const id = Number(mailing.id ?? s.mailingId ?? s.emailId ?? s.email ?? s.id) || 0;
              const subj = String(cur.subject ?? s.subject ?? s.name ?? "").trim();
              if (id) {
                if (!emailIds.includes(id)) emailIds.push(id);
                if (subj && !emailSubjects[String(id)]) emailSubjects[String(id)] = subj;
              }
              if (campSample == null && steps.length) campSample = { keys: Object.keys(s).slice(0, 14), subj: subj.slice(0, 50) || null, hasBody: !!(cur.body ?? cur.content) };
            }
          }
        } catch { /* campaña ilegible — aparece sin correos */ }
        campaigns.push({ id: cid as number | string, name: cname, active: cactive, emailIds });
      }
    }
  } catch { /* sin campañas legibles */ }
  // 5) REGLAS de automatización (trigger→send_email sueltos: confirmaciones de
  //    reserva, entregas de guías, etc.) — tercera fuente de correos
  //    «automation» en las stats. Un solo grupo con los ids en orden del
  //    listado; el paseo profundo cosecha también sus asuntos si van
  //    incrustados ({id,subject} en la acción).
  const rules: number[] = [];
  let ruleSample: unknown = null;
  try {
    const t = await callTool(ctx.sid, "list-automation-rules", { student_id: ctx.studentId });
    if (!t.isError && t.json) {
      const d = ((t.json as Record<string, unknown>).data ?? t.json) as Record<string, unknown>;
      const arr = (Array.isArray(d.rules) ? d.rules : (Array.isArray(d.items) ? d.items : (Array.isArray(d) ? d : []))) as Array<Record<string, unknown>>;
      for (const r of arr) collectEmailIds(r, rules);
      if (arr.length) {
        // Muestra CRUDA de la primera regla con acción de email para verificar
        // el shape real en prod (harvested:0 en v4 = shape distinto al de save).
        const withEmail = arr.find((r) => JSON.stringify(r.actions ?? r).toLowerCase().includes("email")) ?? arr[0];
        ruleSample = { count: arr.length, keys: Object.keys(arr[0] ?? {}).slice(0, 12), harvested: rules.length, first: JSON.stringify(withEmail).slice(0, 600) };
      }
    }
  } catch { /* sin reglas legibles */ }
  // 6) Reglas de PASO DE EMBUDO — cuarta fuente (verificado en prod: las 11
  //    reglas globales no envían correos; los «Aquí tienes el acceso al
  //    webinar», guías, etc. salen de form_subscribed→send_email en pasos de
  //    embudo). Topes duros: 8 embudos × 6 pasos, 30 llamadas de reglas máx —
  //    el puente serializa y el mapa entero se cachea 1h en el server.
  const funnels: Array<{ id: number | string; name: string; active: boolean | null; emailIds: number[] }> = [];
  let fsSample: unknown = null;
  let ruleCalls = 0;
  let fCount = 0;
  try {
    const tf = await callTool(ctx.sid, "list-funnels", { student_id: ctx.studentId });
    if (!tf.isError && tf.json) {
      const df = ((tf.json as Record<string, unknown>).data ?? tf.json) as Record<string, unknown>;
      const fArr = (Array.isArray(df.funnels) ? df.funnels : (Array.isArray(df.items) ? df.items : (Array.isArray(df) ? df : []))) as Array<Record<string, unknown>>;
      fCount = fArr.length;
      for (const f of fArr.slice(0, 20)) {
        if (ruleCalls >= 60) break;
        const fid = f.id ?? f.funnelId;
        if (fid == null) continue;
        const fname = String(f.name ?? ("Embudo " + fid));
        const emailIds: number[] = [];
        try {
          const ts = await callTool(ctx.sid, "list-funnel-steps", { student_id: ctx.studentId, funnel_id: String(fid) });
          if (!ts.isError && ts.json) {
            const ds = ((ts.json as Record<string, unknown>).data ?? ts.json) as Record<string, unknown>;
            const sArr = (Array.isArray(ds.steps) ? ds.steps : (Array.isArray(ds.items) ? ds.items : (Array.isArray(ds) ? ds : []))) as Array<Record<string, unknown>>;
            for (const s of sArr.slice(0, 10)) {
              if (ruleCalls >= 60) break;
              const sid = s.id ?? s.stepId;
              if (sid == null) continue;
              ruleCalls++;
              try {
                const tr = await callTool(ctx.sid, "list-funnel-step-rules", { student_id: ctx.studentId, step_id: String(sid) });
                if (!tr.isError && tr.json) {
                  const before = emailIds.length;
                  collectEmailIds(((tr.json as Record<string, unknown>).data ?? tr.json), emailIds);
                  if (fsSample == null && emailIds.length > before) {
                    const nid = emailIds[emailIds.length - 1];
                    fsSample = { funnel: fname.slice(0, 30), firstId: nid, subj: (emailSubjects[String(nid)] || null) };
                  }
                }
              } catch { /* paso sin reglas legibles */ }
            }
          }
        } catch { /* embudo sin pasos legibles */ }
        if (emailIds.length) funnels.push({ id: fid as number | string, name: "Embudo: " + fname, active: null, emailIds });
      }
    }
  } catch { /* sin embudos legibles */ }
  return { workflows, campaigns, funnels, rules, emailSubjects, sample: { wfCount: wfList.length, campCount: campaigns.length, fCount, funnelCount: funnels.length, ruleCalls, rulesCount: rules.length, subjectsCount: Object.keys(emailSubjects).length, rawOptions, stepSample, campSample, ruleSample, fsSample, firstRaw } };
}
