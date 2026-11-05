/**
 * Pipelines del CRM: la lista (setting `pipelines.json`) y el paso de un contacto a una
 * etapa. Vivía dentro de admin.ts; sale aquí para que los formularios (FORMULARIOS-2)
 * metan a la gente en un pipeline con la MISMA lógica que el panel: etapa, pipeline en
 * `fields.pipeline_id` y la etiqueta «📍 <etapa>».
 *
 * OPORTUNIDADES-1 (PIP-01) · El tablero ya no enseña CONTACTOS: enseña oportunidades
 * (app_opportunities). Una persona puede existir, escribir y recibir mensajes sin estar
 * en ningún pipeline. La etapa del contacto se sigue escribiendo (etiqueta «📍», filtros
 * de Contactos, disparadores), pero sólo como espejo de su última oportunidad tocada.
 * Una oportunidad nace únicamente por una decisión explícita: alguien la añade (tablero,
 * ficha, Bandeja, alta) o una regla configurada la abre (nodo de flujo, formulario,
 * Buscar leads), y queda anotado cuál (origin + reason).
 */
import { get as getSetting, set as setSetting } from "./settings.js";
import { getContact, updateContact } from "./contacts.js";
import { dbMoverEtapaContactos, dbOpportunityCounts, dbMoveOpportunitiesStage } from "./db.js";
import {
  dbListOpportunities, dbCreateOpportunity, dbUpdateOpportunity, dbMigrateOpportunitiesFromContacts,
  type Opportunity,
} from "./db.js";
import { currentWorkspaceId } from "./workspace.js";

// Prefijo de la etiqueta de estado del pipeline. Al mover de etapa, el contacto
// queda tagueado con "📍 <Etapa>" (estilo systeme.io): el estado es visible como
// etiqueta y se puede usar como disparador de secuencias/automatizaciones.
export const STAGE_TAG_PREFIX = "📍 ";

/** De dónde sale una oportunidad: se guarda con ella para poder corregir una regla.
 *  `espejo`: el cambio lo hace una persona desde la ficha o la Bandeja, que enseñan la
 *  etapa de SU oportunidad; entonces se mueve esa (también de pipeline) en vez de abrir
 *  otra. Una regla automática nunca mueve una oportunidad de pipeline. */
export interface OppOrigen { origin: string; reason: string; espejo?: boolean }

/** `origen === null`: la llamada viene del propio tablero, que ya ha movido SU oportunidad
 *  y sólo quiere el espejo en el contacto. Sin origen se trata como un cambio manual. */
export async function setStageWithTag(phone: string, stage: string, pipelineId?: string, origen?: OppOrigen | null): Promise<void> {
  const c = await getContact(phone);
  const base = (c?.tags || []).filter((t) => !t.startsWith(STAGE_TAG_PREFIX));
  const tags = stage ? [...base, STAGE_TAG_PREFIX + stage] : base;
  const upd: { stage: string; tags: string[]; fields?: Record<string, string> } = { stage, tags };
  // Guarda a qué pipeline pertenece el lead (en fields, sin migración de BD).
  if (pipelineId !== undefined) upd.fields = { ...(c?.fields || {}), pipeline_id: pipelineId };
  await updateContact(phone, upd);
  if (origen === null || !c) return;
  await syncDesdeContacto(phone, c, stage, pipelineId, origen || { origin: "panel", reason: "Etapa puesta desde el panel", espejo: true });
}

/** La etapa/pipeline del contacto cambió (antes = la ficha ANTES del cambio): su
 *  oportunidad sigue el cambio. Si no cambió nada no se toca ninguna: la ficha reenvía
 *  la etapa en cada Guardar, y releerla no puede mover (ni cerrar) otra oportunidad. */
export async function syncDesdeContacto(
  phone: string, antes: { stage?: string; fields?: Record<string, unknown> | Record<string, string> } | null,
  stage: string, pipelineId: string | undefined, origen: OppOrigen,
): Promise<void> {
  const pidAntes = String((antes?.fields as Record<string, unknown> | undefined)?.pipeline_id || "");
  const pid = pipelineId ?? pidAntes;
  if (String(antes?.stage || "") === stage && pid === pidAntes) return;
  await syncOpportunity(phone, stage, pid, origen, pidAntes);
}

// DESENLACES-1 (PIP-03) · «Ganado» y «Perdido» son DESENLACES, no pasos del proceso.
// Cada pipeline guarda cuál de sus etapas es cada uno (`won` / `lost`): así renombrarlas
// o reordenar los pasos no les cambia el significado, y el tablero no las pinta como
// «Ganado → Perdido». `stages` sigue siendo la lista ENTERA (pasos y, al final, los dos
// desenlaces) porque la consumen la ficha, los formularios, los flujos y el asistente:
// `stages[0]` es siempre un paso de trabajo, que es la etapa de entrada por defecto.
// Misma forma de datos que la rama claude/bs-pip, para que las dos casen.
export interface Pipeline { id: string; name: string; stages: string[]; won: string; lost: string }

// Sólo para pipelines guardados ANTES de DESENLACES-1 (sin won/lost): se deduce cuál era
// el desenlace por el nombre, palabra a palabra (con /gan/ suelto, «Organizado» contaba
// como ganado). Si hay varias candidatas, la última: los desenlaces van al final.
const PAL_GANA = /^(ganad[oa]s?|won|vendid[oa]s?|cerrad[oa]s?|clientes?|comprad[oa]s?)$/;
const PAL_PIERDE = /^(perdid[oa]s?|lost|descartad[oa]s?|rechazad[oa]s?|bajas?)$/;
const palabras = (s: string): string[] =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
const esPerdida = (s: string): boolean => palabras(s).some((w) => PAL_PIERDE.test(w));
const esGanada = (s: string): boolean => {
  const w = palabras(s);
  return w.some((x) => PAL_GANA.test(x)) && !w.some((x) => PAL_PIERDE.test(x) || /^potencial(es)?$/.test(x));
};

/** Los pasos de trabajo, en orden: todo lo que no es un desenlace. */
export function workSteps(p: Pipeline): string[] {
  return p.stages.filter((s) => s !== p.won && s !== p.lost);
}

/**
 * Deja un pipeline en su forma válida: sin etapas repetidas, con al menos un paso de
 * trabajo y con sus DOS desenlaces al final. Lo usan la lectura y el guardado, así que
 * lo que se guarda es exactamente lo que se lee.
 *
 * `won`/`lost` explícitos mandan siempre. Sin ellos (formato anterior) se deducen por el
 * nombre y, si no hay ninguno, se añaden «Ganado» / «Perdido» vacíos: un pipeline sin
 * desenlaces no deja marcar una venta como ganada ni como perdida.
 */
export function normalizePipeline(p: Record<string, unknown>, i: number): Pipeline {
  let stages = Array.isArray(p.stages) ? (p.stages as unknown[]).map((s) => String(s ?? "").trim()).filter(Boolean) : [];
  stages = stages.filter((s, k) => stages.indexOf(s) === k);
  const explicito = typeof p.won === "string" || typeof p.lost === "string";
  if (!explicito) {
    // El pipeline por defecto de algunos negocios quedó guardado como «Contactado →
    // Nuevo», que no describe ningún proceso. Se corrige SOLO en el formato anterior:
    // a partir del primer guardado con el editor nuevo, el orden es el que eligió el
    // negocio y no se vuelve a tocar.
    const iC = stages.findIndex((s) => s.toLowerCase() === "contactado");
    const iN = stages.findIndex((s) => s.toLowerCase() === "nuevo");
    if (iC >= 0 && iN > iC) { const t = stages[iC]; stages[iC] = stages[iN]; stages[iN] = t; }
  }
  let won = typeof p.won === "string" ? p.won.trim() : explicito ? "" : ([...stages].reverse().find(esGanada) || "");
  let lost = typeof p.lost === "string" ? p.lost.trim() : explicito ? "" : ([...stages].reverse().find((s) => s !== won && esPerdida(s)) || "");
  if (!won) won = lost === "Ganado" ? "Vendido" : "Ganado";
  if (!lost || lost === won) lost = won === "Perdido" ? "Descartado" : "Perdido";
  let work = stages.filter((s) => s !== won && s !== lost);
  // Sin un solo paso de trabajo, la etapa de entrada sería un desenlace: quien entrase
  // por un formulario aparecería ya ganado.
  if (!work.length) work = ["Nuevo"];
  return {
    id: String(p.id || "p" + i),
    name: String(p.name || "").trim() || "Pipeline " + (i + 1),
    stages: [...work, won, lost],
    won,
    lost,
  };
}

// Multi-pipeline: lista de pipelines. Guardada como JSON en settings. Migra el
// pipeline único legacy (pipeline.stages/.name) si no hay. Un pipeline guardado sin
// ninguna etapa se ignora, como siempre: normalizarlo lo resucitaría con tres inventadas.
const DEFAULT_STAGES = "Nuevo,Contactado,Propuesta enviada,Ganado,Perdido";
const tieneEtapas = (p: Record<string, unknown>): boolean =>
  Array.isArray(p?.stages) && (p.stages as unknown[]).some((s) => String(s ?? "").trim());
export function getPipelines(): Pipeline[] {
  const raw = getSetting("pipelines.json");
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        const out = arr
          .map((p: Record<string, unknown>, i: number) => (p && tieneEtapas(p) ? normalizePipeline(p, i) : null))
          .filter((p): p is Pipeline => !!p);
        if (out.length) return out;
      }
    } catch {
      /* JSON inválido → migración */
    }
  }
  const stages = (getSetting("pipeline.stages") || DEFAULT_STAGES)
    .split(",").map((s) => s.trim()).filter(Boolean);
  return [normalizePipeline({ id: "default", name: getSetting("pipeline.name") || "Pipeline", stages }, 0)];
}
/** Limpia lo que llega del editor: misma regla que la lectura. */
export function cleanPipelines(arr: unknown[]): Pipeline[] {
  return arr
    .map((p, i) => (p && typeof p === "object" && tieneEtapas(p as Record<string, unknown>) ? normalizePipeline(p as Record<string, unknown>, i) : null))
    .filter((p): p is Pipeline => !!p);
}

/** El pipeline en el que se ve a un contacto: el suyo y, si no tiene o ya no existe,
 *  el primero. La misma regla que la ficha (pipeDeContacto) y el tablero. */
export function pipelineDeContacto(fields: Record<string, unknown> | null | undefined): Pipeline {
  const pipes = getPipelines();
  const pid = String((fields || {}).pipeline_id || "");
  return pipes.find((p) => p.id === pid) || pipes[0];
}

// De quién es el espejo de una etapa en su ficha: los que tienen el pipeline asignado y, en
// el primero, también los que no tienen ninguno (la ficha los enseña ahí).
const filtroPipe = (pipelineId: string, esPrimero: boolean): string[] => (esPrimero ? [pipelineId, ""] : [pipelineId]);

/** Cuántas oportunidades hay, de verdad (COUNT en la base, no la muestra del tablero), en
 *  cada etapa de un pipeline: abiertas y cerradas, como las enseña el tablero. Acotado al
 *  workspace activo, como todo dbOpportunityCounts. */
export async function contarPorEtapa(pipelineId: string): Promise<Record<string, number>> {
  await ensureOpportunitiesMigrated();
  const out: Record<string, number> = {};
  for (const c of await dbOpportunityCounts()) if (c.pipeline_id === pipelineId) out[c.stage] = (out[c.stage] || 0) + c.n;
  return out;
}

/**
 * Pasa TODAS las oportunidades (`n`, ya contadas) de una etapa de un pipeline a otra etapa,
 * con el desenlace de la nueva, y pone al día el espejo de sus contactos. Va en el servidor
 * y contra la base: el editor lo hacía en el navegador sobre la muestra que tenía cargada,
 * así que con más gente dejaba a los demás en una etapa que ya no existía.
 * MUDANZA-ETAPA-1 · cada paso es UNA sentencia, no una ida y vuelta por persona: contacto a
 * contacto, 2.300 tardaban 108 s. Igual que setStageWithTag, no dispara flujos ni deja
 * actividad. Si la mudanza de las oportunidades falla no se mueve ninguna: se quedan en
 * «Por colocar» y se devuelve cuántas, para que el panel lo diga en vez de dar el guardado
 * por bueno.
 */
export async function moverEtapa(p: Pipeline, de: string, a: string, esPrimero: boolean, n: number): Promise<{ movidos: number; fallidos: number }> {
  let phones: string[];
  try {
    phones = await dbMoveOpportunitiesStage(p.id, de, a, outcomeOf(p, a));
  } catch (e) {
    console.error("[pipelines] mudanza de etapa fallida:", (e as Error)?.message || e);
    return { movidos: 0, fallidos: n };
  }
  // El espejo: «de» ya no existe en este pipeline, así que quien la tenga en su ficha pasa
  // a «a». Quien no tiene pipeline asignado pero cuya oportunidad estaba aquí, también, y su
  // ficha pasa a señalar este pipeline: lo mismo que hace el tablero al mover una tarjeta.
  try {
    await dbMoverEtapaContactos({ stages: [de], pipelines: filtroPipe(p.id, esPrimero) }, a, STAGE_TAG_PREFIX);
    if (!esPrimero && phones.length) await dbMoverEtapaContactos({ stages: [de], pipelines: [""], phones }, a, STAGE_TAG_PREFIX, p.id);
  } catch (e) {
    console.error("[pipelines] espejo de la mudanza de etapa fallido:", (e as Error)?.message || e);
  }
  return { movidos: n, fallidos: 0 };
}

// OPORTUNIDADES-1 · Qué desenlace representa una etapa: '' = sigue abierta. Si el
// pipeline ya guarda cuál es su etapa de ganado/perdido (won/lost) manda eso; si no,
// se reconoce por el nombre, igual que el resto del panel.
const RE_WON = /^(ganad[oa]s?|vendid[oa]s?|cerrad[oa]s?|clientes?)$/i;
const RE_LOST = /^(perdid[oa]s?|descartad[oa]s?)$/i;
export function outcomeOf(p: { stages: string[]; won?: string; lost?: string } | undefined, stage: string): "" | "won" | "lost" {
  if (!p || !stage) return "";
  if (p.won !== undefined || p.lost !== undefined) return stage === p.won ? "won" : stage === p.lost ? "lost" : "";
  const s = stage.trim();
  return RE_WON.test(s) ? "won" : RE_LOST.test(s) ? "lost" : "";
}

/**
 * Una regla configurada, la ficha o la Bandeja ponen a una persona en una etapa.
 *  · Si ya tiene una oportunidad ABIERTA en ese pipeline, se mueve esa (la última tocada).
 *  · Si el cambio es manual (`espejo`) y su oportunidad abierta estaba en otro pipeline
 *    (`desde`), se traslada esa: es la misma gestión cambiando de tablero.
 *  · Si no, se abre una nueva con su origen. Una cerrada (ganada/perdida) no se reabre:
 *    volver a entrar es otra gestión distinta.
 * Nunca se funden dos oportunidades ni se borra ninguna. Quitar la etapa sólo la deja
 * «por colocar» si el cambio es manual; una regla sin etapa no toca nada.
 */
export async function syncOpportunity(phone: string, stage: string, pipelineId: string, origen: OppOrigen, desde?: string): Promise<Opportunity | null> {
  await ensureOpportunitiesMigrated();
  return porPersona(currentWorkspaceId() + "\u0000" + phone, () => syncOpportunityYa(phone, stage, pipelineId, origen, desde));
}

// OPORTUNIDADES-1 · «mirar si tiene una abierta y, si no, abrirla» no es atómico. Dos reglas a
// la vez para la misma persona leían las dos «no tiene» y abrían dos: el formulario lo hace
// siempre (meterEnPipeline va en los flujos, que corren sin esperar, y otra vez al contestar).
// Una cola por persona y workspace: la segunda ve la que abrió la primera y la mueve.
const colaPersona = new Map<string, Promise<unknown>>();
function porPersona<T>(clave: string, fn: () => Promise<T>): Promise<T> {
  const turno = (colaPersona.get(clave) || Promise.resolve()).catch(() => 0).then(fn);
  const cola = turno.catch(() => 0);
  colaPersona.set(clave, cola);
  void cola.then(() => { if (colaPersona.get(clave) === cola) colaPersona.delete(clave); });
  return turno;
}

async function syncOpportunityYa(phone: string, stage: string, pipelineId: string, origen: OppOrigen, desde?: string): Promise<Opportunity | null> {
  const pipes = getPipelines();
  const p = (stage
    ? pipes.find((x) => x.id === pipelineId && x.stages.includes(stage)) || pipes.find((x) => x.stages.includes(stage))
    : pipes.find((x) => x.id === pipelineId));
  if (!p) return null;
  const outcome = outcomeOf(p, stage);
  const [aqui] = await dbListOpportunities({ pipelineId: p.id, phone, open: true, limit: 1 });
  if (aqui) return (stage || origen.espejo) ? dbUpdateOpportunity(aqui.id, { stage, outcome }) : aqui;
  if (origen.espejo && desde && desde !== p.id) {
    const [alli] = await dbListOpportunities({ pipelineId: desde, phone, open: true, limit: 1 });
    if (alli) return dbUpdateOpportunity(alli.id, { pipeline_id: p.id, stage, outcome });
  }
  if (!stage) return null;
  return dbCreateOpportunity({ phone, pipeline_id: p.id, stage, outcome, origin: origen.origin, reason: origen.reason.slice(0, 200) });
}

// La migración corre UNA vez por workspace, la primera vez que alguien mira el tablero
// o una regla abre una oportunidad. Sólo convierte a quien ya tenía etapa o pipeline
// puestos; el resto (gente que sólo escribió o se importó) sigue en Contactos. La marca
// lleva dentro el id del workspace: con herencia de ajustes entre workspaces activada
// (WS_STRICT_SECRETS=false), uno nuevo no puede saltarse su migración por heredarla.
const migrando = new Map<string, Promise<void>>();
export async function ensureOpportunitiesMigrated(): Promise<void> {
  const ws = currentWorkspaceId();
  try { if (JSON.parse(getSetting("pipeline.opps_v1") || "{}").ws === ws) return; } catch { /* marca ilegible: se migra */ }
  let pr = migrando.get(ws);
  if (!pr) {
    pr = (async () => {
      const pipes = getPipelines();
      // Quien no tenía pipeline se veía en el primero; si su etapa sólo existe en otro
      // (la puso un flujo de ese otro), va a ese: en el primero no salía en ninguna columna.
      const r = await dbMigrateOpportunitiesFromContacts((pid, st) => {
        const p = pid ? pipes.find((x) => x.id === pid)
          : (st && !pipes[0]?.stages.includes(st) && pipes.find((x) => x.stages.includes(st))) || pipes[0];
        return { pipeline_id: pid || p?.id || "default", outcome: outcomeOf(p, st) };
      });
      await setSetting("pipeline.opps_v1", JSON.stringify({ ws, at: Date.now(), ...r }));
      console.log(`[oportunidades] ws=${ws} migradas ${r.creadas} (con etapa ${r.conEtapa}) de ${r.contactos} contactos`);
    })().finally(() => migrando.delete(ws));
    migrando.set(ws, pr);
  }
  await pr;
}
