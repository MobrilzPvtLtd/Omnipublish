/**
 * T03-CORREOS · Catálogo UNIFICADO de correos de una cuenta web conectada
 * (systeme.io / leadmatch-lab — mismo proveedor, el sandbox es solo el panel).
 *
 * «Correo» aquí es CUALQUIER email de la cuenta, venga de donde venga:
 * newsletter, campaña (secuencia de mailing), workflow/automatización, regla,
 * o un envío suelto que el proveedor liste. La procedencia (originType) es un
 * ATRIBUTO, no una funcionalidad aparte.
 *
 * IDENTIDAD ESTABLE — regla dura: la identidad de un correo es SIEMPRE un id
 * del proveedor con prefijo de espacio (los espacios de ids NO se cruzan):
 *   nl:<newsletterId>            newsletter (API pública oficial)
 *   cs:<campaignId>:<stepId>     email dentro de una campaña (API pública)
 *   wf:<workflowId>:<emailId>    email de un workflow (bridge legado)
 *   rl:<emailId>                 email colgado de una regla (bridge legado)
 *   ml:<mailingId>               ENVÍO listado por las stats internas (cookie)
 * JAMÁS se usa el asunto, el nombre de campaña ni la posición como identidad:
 * dos correos con el mismo asunto son dos entidades. El asunto solo se usa
 * para ENRIQUECER con stats agregadas, y únicamente cuando el cruce es
 * inequívoco (un solo candidato); si hay ambigüedad, el envío se lista aparte.
 *
 * CAPACIDADES HONESTAS · systeme.io NO expone eventos individuales de email
 * (ni webhook de apertura/clic/rebote/baja — verificado contra la doc oficial
 * 2026: solo CONTACT_* y SALE_*). La única señal INDIVIDUAL demostrable es la
 * «etiqueta puente» (regla en la web «email abierto/clic → asignar etiqueta» →
 * webhook CONTACT_TAG_ADDED). Las stats internas (aperturas/clics/rebotes por
 * mailing) son AGREGADAS: aquí se sirven como contexto y el llamante no debe
 * usarlas para disparar acciones sobre contactos concretos.
 */
import { getAccount, type SiAccount } from "./systemeio-accounts.js";
import {
  withPublicApiKey,
  listNewslettersPage,
  listCampaignsPage,
  listCampaignSteps,
  listAutomationEmails,
} from "./systemeio-public-api.js";
import { currentWorkspaceId } from "./workspace.js";

export type EmailOriginType = "newsletter" | "campaign" | "sequence" | "automation" | "rule" | "individual" | "other";

export interface EmailAggregates {
  sent: number;
  opened: number;
  clicked: number;
  bounced: number;
  spam: number;
  /** true SIEMPRE: estas cifras son agregadas del proveedor, nunca eventos individuales. */
  aggregate: true;
  /** 'exact' = mismo espacio de ids · 'subject' = cruce por asunto inequívoco (aprox). */
  match: "exact" | "subject";
}

export interface CatalogEmail {
  provider: "systemeio";
  accountId: string;
  /** Id ESTABLE con prefijo de espacio (nl:/cs:/wf:/rl:/ml:). */
  extId: string;
  originType: EmailOriginType;
  /** Id estable del origen (cp:<id> / wf:<id> / nl:<id> / rl: / ml:). */
  originId: string;
  originName: string;
  subject: string;
  /** draft | scheduled | sent | active | paused | unknown */
  status: string;
  scheduledAt: string | null;
  sentAt: string | null;
  stats: EmailAggregates | null;
  /** DIRECTO-1 · id del ENVÍO en las stats internas, si se conoce (entradas
   *  ml: y cruces inequívocos). Con él —y cookie viva— el panel puede leer
   *  los DESTINATARIOS del envío (abrió/clicó por contacto) sin necesidad de
   *  regla ni etiqueta en la web: es la vía para newsletters sueltas. */
  mailingId?: number | null;
}

export interface EmailCatalogResult {
  items: CatalogEmail[];
  total: number;
  /** true si alguna fuente cortó por tope de páginas (no está TODO el histórico). */
  truncated: boolean;
  /** Fuentes que fallaron en esta pasada ('publica' | 'interna' | 'bridge'). */
  partial: string[];
  /** Fuentes LENTAS aún fundiéndose en segundo plano ('workflows'): el
   *  catálogo ya es usable; estas entradas aparecen al terminar. */
  pending: string[];
  /** Capacidades REALES a nivel de cuenta (los eventos van por etiqueta puente). */
  capabilities: {
    /** Eventos individuales abrió/clic vía etiqueta puente (webhook CONTACT_TAG_ADDED). */
    tagEvents: true;
    /** La reconciliación por API pública (red de seguridad del webhook) es posible. */
    reconcile: boolean;
    /** Hay stats agregadas (cookie interna viva). */
    aggregates: boolean;
  };
  fetchedAt: number;
}

/** Tope de entradas por cuenta: el selector pagina; no descargamos históricos enteros. */
const MAX_ENTRIES = 800;
const MAX_NL_PAGES = 3; // 3×100 newsletters más recientes
const MAX_CAMPAIGNS = 25; // por cuenta (las más recientes) — evita N+1 sin tope
const CACHE_TTL_MS = 10 * 60_000;

interface CacheSlot {
  at: number;
  result: EmailCatalogResult;
}
const cache = new Map<string, CacheSlot>(); // clave `${tenant}:${accountId}` — jamás global
// Builds EN CURSO (dedupe): dos peticiones concurrentes comparten el mismo
// build; el que llega tarde no lanza otro barrido contra el proveedor.
// RAPIDO-1 · El build se parte en dos: las fuentes RÁPIDAS (API pública +
// stats internas, en paralelo, segundos) sirven el catálogo ya usable; el
// bridge de workflows (legado, puede tardar >1 min) se FUNDE en la caché en
// segundo plano con la marca `pending:['workflows']` — el selector deja de
// pagar el pato del puente.
const inflight = new Map<string, Promise<EmailCatalogResult>>();
const inflightBridge = new Map<string, Promise<void>>();

/** Invalida el catálogo (al conectar/desconectar/sincronizar una cuenta). */
export function invalidateEmailCatalog(accountId?: string): void {
  const tenant = currentWorkspaceId();
  if (accountId) cache.delete(`${tenant}:${accountId}`);
  else for (const k of [...cache.keys()]) if (k.startsWith(tenant + ":")) cache.delete(k);
}

function normSubject(s: string): string {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** DEPENDENCIAS INYECTABLES (solo para pruebas: los mocks sustituyen la red).
 *  En producción son los clientes reales. */
export const _fetchers = {
  newslettersPage: listNewslettersPage,
  campaignsPage: listCampaignsPage,
  campaignSteps: listCampaignSteps,
  automationEmails: listAutomationEmails,
  workflowEmails: null as
    | null
    | ((accountId: string) => Promise<{
        workflows: Array<{ id: number | string; name: string; active: boolean | null; emailIds: number[] }>;
        campaigns: Array<{ id: number | string; name: string; active: boolean | null; emailIds: number[] }>;
        funnels: Array<{ id: number | string; name: string; active: boolean | null; emailIds: number[] }>;
        rules: number[];
        emailSubjects: Record<string, string>;
      } | null>),
};

/** El bridge MCP (legado, en retirada — no se mejora) se carga perezoso para no
 *  encadenar su pool de Postgres a cada import de este módulo. */
async function bridgeWorkflowEmails(accountId: string) {
  if (_fetchers.workflowEmails) return _fetchers.workflowEmails(accountId);
  try {
    const m = await import("./mcp-bridge.js");
    return await m.fetchSystemeioWorkflowEmails(accountId);
  } catch {
    return null;
  }
}

/**
 * Catálogo unificado de la cuenta `accountId` del workspace ACTUAL. La cuenta
 * se resuelve SOLO dentro del workspace (getAccount lee el setting del tenant):
 * un accountId de otro workspace devuelve null y el llamante responde 404 sin
 * revelar si existe en otro sitio. Sin fallback a «la primera cuenta».
 */
export async function getEmailCatalog(accountId: string, opts: { refresh?: boolean } = {}): Promise<EmailCatalogResult | null> {
  // Compat (pruebas/validación sin prisa): catálogo COMPLETO — espera también
  // a la fusión del bridge.
  const r = await getEmailCatalogOrStatus(accountId, { refresh: opts.refresh, full: true });
  if (!r) return null;
  return r.status === "ready" ? r.cat : null;
}

/**
 * Variante para rutas HTTP: si el catálogo está cacheado (o el build termina
 * dentro de `waitMs`) devuelve 'ready'; si el PRIMER barrido de la cuenta
 * sigue en marcha (el puente de workflows puede tardar >1 min), devuelve
 * 'building' para que la UI enseñe «preparando…» y re-pregunte — antes el
 * fetch del navegador moría por timeout y parecía un error.
 */
export async function getEmailCatalogOrStatus(
  accountId: string,
  opts: { refresh?: boolean; waitMs?: number; full?: boolean } = {},
): Promise<{ status: "ready"; cat: EmailCatalogResult } | { status: "building" } | null> {
  const acc = await getAccount(String(accountId || ""));
  if (!acc) return null;
  const key = `${currentWorkspaceId()}:${acc.id}`;
  const hit = cache.get(key);
  if (hit && !opts.refresh && Date.now() - hit.at < CACHE_TTL_MS) {
    // full = esperar también al bridge si sigue fundiéndose en segundo plano.
    if (opts.full && hit.result.pending.length) await inflightBridge.get(key);
    return { status: "ready", cat: hit.result };
  }
  let p = inflight.get(key);
  if (!p) {
    p = buildCatalog(acc)
      .then((result) => {
        cache.set(key, { at: Date.now(), result });
        inflight.delete(key);
        // La fusión del bridge arranca YA pero no bloquea a nadie: muta el
        // resultado cacheado y limpia `pending` al terminar.
        const bp = mergeBridgeInto(acc, result).finally(() => inflightBridge.delete(key));
        inflightBridge.set(key, bp);
        bp.catch(() => { /* mergeBridgeInto ya deja rastro en partial */ });
        return result;
      })
      .catch((e) => {
        inflight.delete(key);
        throw e;
      });
    inflight.set(key, p);
    p.catch(() => { /* el poll siguiente relanza; sin unhandled rejection */ });
  }
  const waitMs = opts.waitMs ?? 0;
  if (waitMs <= 0 || opts.full) {
    const result = await p;
    if (opts.full && result.pending.length) await inflightBridge.get(key);
    return { status: "ready", cat: result };
  }
  const winner = await Promise.race([
    p.then((cat) => ({ status: "ready" as const, cat })),
    new Promise<{ status: "building" }>((resolve) => setTimeout(() => resolve({ status: "building" }), waitMs)),
  ]).catch(() => null);
  return winner ?? { status: "building" };
}

function mkEntry(acc: SiAccount, e: Omit<CatalogEmail, "provider" | "accountId">): CatalogEmail {
  return {
    provider: "systemeio",
    accountId: acc.id,
    ...e,
    subject: String(e.subject || "(sin asunto)").slice(0, 300),
    originName: String(e.originName || "").slice(0, 200),
  };
}

async function buildCatalog(acc: SiAccount): Promise<EmailCatalogResult> {
  const items: CatalogEmail[] = [];
  const partial: string[] = [];
  let truncated = false;

  const mk = (e: Omit<CatalogEmail, "provider" | "accountId">): CatalogEmail => mkEntry(acc, e);

  // ── 1 · API PÚBLICA oficial (apiKey): newsletters + campañas con sus emails ──
  const pubJob = async (): Promise<void> => {
    if (!acc.apiKey) return;
    await withPublicApiKey(acc.apiKey, async () => {
      // Newsletters (páginas más recientes primero).
      let after: string | number | undefined;
      for (let i = 0; i < MAX_NL_PAGES; i++) {
        const page = await _fetchers.newslettersPage({ limit: 100, startingAfter: after, order: "desc" });
        if (page == null) {
          if (i === 0) partial.push("publica"); // FALSO-CERO-1: null = no contestó (≠ cero)
          break;
        }
        for (const n of page.items) {
          items.push(
            mk({
              extId: `nl:${n.id}`,
              originType: "newsletter",
              originId: `nl:${n.id}`,
              originName: "Newsletter",
              subject: n.subject,
              status: n.isSent ? "sent" : "draft",
              scheduledAt: null,
              sentAt: null,
              stats: null,
            }),
          );
        }
        if (!page.hasMore || !page.items.length) break;
        after = page.items[page.items.length - 1]?.id;
        if (i === MAX_NL_PAGES - 1 && page.hasMore) truncated = true;
      }
      // Campañas + sus emails (steps). Tope de campañas para no hacer N+1 sin fin.
      const cps = await _fetchers.campaignsPage({ limit: 100, order: "desc" });
      if (cps == null) {
        if (!partial.includes("publica")) partial.push("publica");
      } else {
        if (cps.hasMore || cps.items.length > MAX_CAMPAIGNS) truncated = true;
        // POOL de 5 en paralelo: 25 campañas en serie eran 25×latencia y el
        // primer barrido de la cuenta se hacía eterno (parecía un error).
        const cola = cps.items.slice(0, MAX_CAMPAIGNS);
        const resultados: Array<{ cp: (typeof cola)[number]; steps: Awaited<ReturnType<typeof _fetchers.campaignSteps>> }> = [];
        let idx = 0;
        await Promise.all(
          Array.from({ length: Math.min(5, cola.length) }, async () => {
            for (;;) {
              const i = idx++;
              if (i >= cola.length) return;
              const cp = cola[i];
              resultados.push({ cp, steps: await _fetchers.campaignSteps(cp.id, 3) });
            }
          }),
        );
        for (const { cp, steps } of resultados) {
          if (steps == null) {
            if (!partial.includes("publica")) partial.push("publica");
            continue;
          }
          for (const s of steps) {
            items.push(
              mk({
                extId: `cs:${cp.id}:${s.id}`,
                originType: "campaign",
                originId: `cp:${cp.id}`,
                originName: cp.name,
                subject: s.subject,
                status: s.isActive ? "active" : "paused",
                scheduledAt: null,
                sentAt: null,
                stats: null,
              }),
            );
          }
        }
      }
    });
  };

  // RAPIDO-1 · Las dos fuentes rápidas corren EN PARALELO (antes en serie).
  // SIO-LIMPIEZA-1 · los agregados por sesión (cookie) se retiraron el 30-oct-2026.
  await pubJob();

  if (items.length > MAX_ENTRIES) {
    truncated = true;
    items.length = MAX_ENTRIES;
  }

  return {
    items,
    total: items.length,
    truncated,
    partial,
    // El bridge de workflows se funde después (mergeBridgeInto): el catálogo ya
    // es usable con las fuentes rápidas.
    pending: ["workflows"],
    capabilities: {
      tagEvents: true,
      reconcile: !!acc.apiKey,
      aggregates: false,
    },
    fetchedAt: Date.now(),
  };
}

/** RAPIDO-1 · Funde los correos de workflows/reglas (bridge legado, lento) en
 *  un resultado YA servido. Muta `out` (que vive en la caché): los lectores
 *  siguientes ven las entradas nuevas sin otro barrido. */
async function mergeBridgeInto(acc: SiAccount, out: EmailCatalogResult): Promise<void> {
  const mk = (e: Omit<CatalogEmail, "provider" | "accountId">): CatalogEmail => mkEntry(acc, e);
  try {
    // CORREO-API-3 (SIO-API-F7) · Con clave de acceso, los correos de automatización salen de
    // la API oficial. No se atribuyen a regla ni a workflow porque la API no lo dice (el panel
    // lo explica); los workflows no existen en la API. El puente queda para cuentas sin clave.
    if (acc.apiKey) {
      const ae = await withPublicApiKey(acc.apiKey, () => _fetchers.automationEmails());
      if (!ae) {
        if (!out.partial.includes("publica")) out.partial.push("publica");
      } else {
        for (const e of ae.items) {
          out.items.push(mk({
            extId: `ae:${e.id}`, originType: "automation", originId: "ae:", originName: "Automatización",
            subject: e.subject, status: "unknown", scheduledAt: null, sentAt: null, stats: null,
          }));
        }
        if (ae.truncated) out.truncated = true;
      }
    }
    const wf = acc.apiKey ? null : await bridgeWorkflowEmails(acc.id);
    if (wf) {
      for (const w of wf.workflows || []) {
        for (const eid of w.emailIds || []) {
          out.items.push(
            mk({
              extId: `wf:${w.id}:${eid}`,
              originType: "automation",
              originId: `wf:${w.id}`,
              originName: w.name,
              subject: wf.emailSubjects?.[String(eid)] || "(sin asunto)",
              status: w.active === false ? "paused" : w.active === true ? "active" : "unknown",
              scheduledAt: null,
              sentAt: null,
              stats: null,
            }),
          );
        }
      }
      for (const eid of wf.rules || []) {
        out.items.push(
          mk({
            extId: `rl:${eid}`,
            originType: "rule",
            originId: "rl:",
            originName: "Regla",
            subject: wf.emailSubjects?.[String(eid)] || "(sin asunto)",
            status: "active",
            scheduledAt: null,
            sentAt: null,
            stats: null,
          }),
        );
      }
    } else if (!acc.apiKey && acc.sandboxPass) {
      // Solo cuenta como fallo si esa cuenta PODÍA tener workflows legibles.
      if (!out.partial.includes("bridge")) out.partial.push("bridge");
    }
  } catch {
    if (!out.partial.includes("bridge")) out.partial.push("bridge");
  }
  if (out.items.length > MAX_ENTRIES) {
    out.truncated = true;
    out.items.length = MAX_ENTRIES;
  }
  out.total = out.items.length;
  out.pending = [];
}

/** Busca un correo del catálogo por su id estable (para validar un flujo). */
export async function findCatalogEmail(accountId: string, extId: string): Promise<CatalogEmail | null> {
  const cat = await getEmailCatalog(accountId);
  if (!cat) return null;
  return cat.items.find((e) => e.extId === extId) ?? null;
}

/** Filtro + paginación en servidor sobre el catálogo cacheado (el cliente no
 *  descarga las 800 entradas de golpe). */
export function filterCatalog(
  cat: EmailCatalogResult,
  opts: { q?: string; type?: string; status?: string; offset?: number; limit?: number },
): { items: CatalogEmail[]; total: number } {
  const q = normSubject(opts.q || "");
  const type = String(opts.type || "").trim();
  const status = String(opts.status || "").trim().toLowerCase();
  let list = cat.items;
  if (type) list = list.filter((e) => e.originType === type);
  if (status) list = list.filter((e) => e.status.toLowerCase() === status);
  if (q) list = list.filter((e) => normSubject(e.subject).includes(q) || normSubject(e.originName).includes(q));
  // Orden estable: procedencia → origen → asunto (dos correos de igual asunto
  // siguen distinguibles por extId, que la UI enseña recortado).
  const sorted = [...list].sort(
    (a, b) =>
      a.originType.localeCompare(b.originType) ||
      a.originName.localeCompare(b.originName) ||
      a.subject.localeCompare(b.subject) ||
      a.extId.localeCompare(b.extId),
  );
  const off = Math.max(0, Number(opts.offset) || 0);
  const lim = Math.min(200, Math.max(1, Number(opts.limit) || 60));
  return { items: sorted.slice(off, off + lim), total: sorted.length };
}
