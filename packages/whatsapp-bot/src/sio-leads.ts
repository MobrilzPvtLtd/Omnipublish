/**
 * Sync de leads de systeme.io / leadmatch-lab con su URL DE ORIGEN → app_sio_leads.
 *
 * Para saber DE DÓNDE llegan los leads que se registran en systeme.io (Instagram,
 * LinkedIn, campaña de pago, post concreto…) usamos la sourceURL que systeme.io
 * guarda por contacto (la URL de la landing en el momento del registro, con sus
 * utm_*). La API pública la expone por contacto; aquí se copia a la tabla local
 * app_sio_leads con los utm_* parseados, y la vista Métricas → Origen la agrega.
 *
 * INCREMENTAL: los ids de contacto de systeme.io son crecientes y la paginación es
 * por cursor (startingAfter=id) → guardamos el max id copiado y seguimos desde ahí.
 * La sourceURL de un contacto no cambia tras registrarse, así que no hay que
 * re-visitar lo ya copiado. Primer sync de una cuenta = recorrido completo
 * (~1 llamada por cada 100 contactos, con pausa entre páginas).
 *
 * Solo cuentas con API key pública (las autologin la auto-crean con
 * ensure-api-key; en cuentas systeme.io PRINCIPALES esa auto-creación puede
 * fallar — ver memoria — y entonces el user la pega a mano en Conexiones).
 */
import { listAccountsRaw, type SiAccount } from "./systemeio-accounts.js";
import { withPublicApiKey, listContactsAttributionPage } from "./systemeio-public-api.js";
import { dbSioLeadsUpsert, dbSioLeadsMaxId, dbSioLeadsRows, dbContactsBySioRef, dbGetContact, dbUpdateContact, dbSioLeadsSinOrigen, dbSioLeadSetOrigenVisita, type SioLead } from "./db.js";
import { contactoDeUnAlta, origenDeVisitaDeUnAlta, plataformaDeVisita } from "./web-analytics.js";
import { parseUtm } from "./attribution.js";
import { logActivity } from "./activity.js";
import { runWithWorkspace, currentWorkspaceId } from "./workspace.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface SioLeadsSyncResult {
  accountId: string;
  scanned: number;
  added: number;
  withSourceUrl: number;
  withUtm: number;
  pages: number;
  done: boolean; // false = quedó cola (tope de páginas por pasada)
  linked: number; // FORMULARIO-A-LEAD-1 · altas cuyo email pasó a la ficha del lead
  origenes?: number; // ORIGEN-VISITA-1 · altas sin utm a las que su visita les dio origen
  error?: string;
}

/**
 * Sincroniza UNA cuenta. `maxPages` limita la pasada (40 páginas = 4.000 contactos)
 * para no colgar una request del panel; si queda cola devuelve done:false y la
 * siguiente pasada (botón o scheduler) continúa desde el cursor.
 */
export async function syncSioLeadsForAccount(accountId: string, maxPages = 40): Promise<SioLeadsSyncResult> {
  const acc = (await listAccountsRaw()).find((a) => a.id === accountId);
  const out: SioLeadsSyncResult = { accountId, scanned: 0, added: 0, withSourceUrl: 0, withUtm: 0, pages: 0, done: true, linked: 0 };
  if (!acc) { out.error = "Cuenta no encontrada"; return out; }
  if (!acc.apiKey) { out.error = "La cuenta no tiene clave de API pública (añádela en Conexiones)"; return out; }
  // INCIDENTE 2026-08-14 (root cause del «se paró el 23-jul»): systeme.io
  // INVIRTIÓ la dirección de /contacts alrededor del 23-jul-2026 — ahora la
  // primera página (sin cursor) es lo MÁS NUEVO y startingAfter=X devuelve
  // contactos MÁS ANTIGUOS que X (descendente). El incremental antiguo partía
  // del maxId copiado y «avanzaba»… hacia atrás: releía lo viejo para siempre
  // y el más nuevo quedó congelado en el día del cambio, en las dos cuentas.
  // Estrategia nueva: primera página SIN cursor, autodetectar dirección y
  //  - descendente: bajar hasta alcanzar ids ya copiados (o el final);
  //  - ascendente (por si systeme.io lo revierte): cursor desde maxId como antes.
  const known = await dbSioLeadsMaxId(accountId);
  try {
    await withPublicApiKey(acc.apiKey, async () => {
      let cursor: number | undefined = undefined;
      let dir: "asc" | "desc" | null = null;
      for (let p = 0; p < maxPages; p++) {
        const page = await listContactsAttributionPage(cursor);
        out.pages++;
        if (!page.items.length) { out.done = true; return; }
        const ids = page.items.map((c) => c.id).filter((n) => n > 0);
        if (dir === null) {
          if (ids.length >= 2) dir = ids[0] > ids[ids.length - 1] ? "desc" : "asc";
          else dir = (known && ids[0] && ids[0] > known) ? "desc" : "asc";
        }
        const rows: SioLead[] = page.items.map((c) => {
          const utm = parseUtm(c.sourceURL);
          if (c.sourceURL) out.withSourceUrl++;
          if (utm.utm_source || utm.utm_medium || utm.utm_campaign || utm.utm_content) out.withUtm++;
          return {
            account_id: accountId,
            sio_contact_id: c.id,
            email: c.email,
            registered_at: c.registeredAt ? Date.parse(c.registeredAt) || null : null,
            source_url: (c.sourceURL || "").slice(0, 600),
            utm_source: utm.utm_source || "",
            utm_medium: utm.utm_medium || "",
            utm_campaign: utm.utm_campaign || "",
            utm_content: utm.utm_content || "",
          };
        });
        // SIO-RUIDO-1 * added son las ALTAS de verdad, no las filas miradas. Antes se le
        // sumaba rows.length -toda la pagina- y por eso el registro decia 100 leads
        // copiados cada hora aunque no hubiera entrado ni uno.
        out.added += await dbSioLeadsUpsert(rows);
        out.scanned += page.items.length;
        if (dir === "desc") {
          const minId = Math.min(...ids);
          // Alcanzado lo ya copiado → la cabeza nueva está completa.
          if (known && minId <= known) { out.done = true; return; }
          cursor = minId;
        } else {
          // Ascendente (comportamiento pre-cambio): saltar a lo conocido en la
          // primera página y avanzar desde ahí.
          const maxIdPage = Math.max(...ids);
          cursor = (p === 0 && known && known > maxIdPage) ? known : maxIdPage;
        }
        if (!page.hasMore) { out.done = true; return; }
        out.done = false; // aún hay más; si agotamos maxPages queda cola
        await sleep(250); // respirar entre páginas (rate-limit de la API)
      }
    });
  } catch (e) {
    out.error = (e as Error).message || "error de sync";
  }
  // Aunque la pasada falle, lo ya copiado se puede enlazar igual.
  out.linked = await enlazarAltasConLeads(accountId).catch((e) => { console.warn("[sio-leads] enlazar:", (e as Error).message); return 0; });
  out.origenes = await origenDeAltasPorVisita(accountId).catch((e) => { console.warn("[sio-leads] origen por visita:", (e as Error).message); return 0; });
  return out;
}

/**
 * FORMULARIO-A-LEAD-1 · pone el email de cada alta reciente de systeme.io en la ficha del
 * lead que la rellenó (el que entró por un flujo de Instagram o WhatsApp y abrió la web
 * desde su enlace). La regla del cruce y por qué está en web-analytics.ts ·
 * contactoDeUnAlta. Solo altas de los últimos 7 días cuyo email no está aún en ninguna
 * ficha; y nunca pisa un email que la ficha ya tenga. Idempotente: una vez enlazada,
 * el email ya está en Contactos y el alta deja de ser candidata.
 */
export async function enlazarAltasConLeads(accountId: string): Promise<number> {
  const ahora = Date.now();
  const altas = (await dbSioLeadsRows(accountId, ahora - 7 * 86_400_000, ahora, 2000)).filter((l) => l.email && l.source_url && l.registered_at);
  if (!altas.length) return 0;
  const { byEmail } = await dbContactsBySioRef(altas.map((l) => l.email), []);
  const tenant = currentWorkspaceId();
  let n = 0;
  for (const l of altas) {
    if (byEmail.has(l.email.toLowerCase())) continue;
    let ruta = "";
    try { ruta = new URL(l.source_url).pathname; } catch { continue; }
    const phone = await contactoDeUnAlta(tenant, ruta, l.registered_at as number);
    if (!phone) continue;
    const c = await dbGetContact(phone);
    if (!c || c.email) continue;
    await dbUpdateContact(phone, {
      email: l.email,
      ...(c.systemeio_contact_id ? {} : { systemeio_contact_id: String(l.sio_contact_id), systemeio_account: accountId }),
    });
    byEmail.set(l.email.toLowerCase(), c);
    n++;
    await logActivity({
      source: "app",
      level: "info",
      summary: `${c.name || phone} dejó su email (${l.email}) en ${ruta} — añadido a su ficha`,
      payload: { file: "sio-leads.ts", tag: "FORMULARIO-A-LEAD-1", phone, email: l.email, sio_contact_id: l.sio_contact_id, ruta },
    }).catch(() => {});
  }
  return n;
}

/**
 * ORIGEN-VISITA-1 · da origen a las altas que llegaron sin utm, con la regla de
 * web-analytics.ts · origenDeVisitaDeUnAlta. Primero lo que trae la propia dirección del alta
 * (un click id de anuncio en la URL, la regla de Métricas → Origen); si no, la visita de quien la
 * rellenó. Cada alta se mira UNA vez (queda 'ninguno' si no se sabe), así que la primera pasada
 * recorre lo ya guardado hacia atrás y las siguientes solo lo nuevo. Espera 5 min tras el alta: el
 * píxel manda la duración de la visita al cerrar la página. Tope por pasada; sigue en la próxima.
 */
export async function origenDeAltasPorVisita(accountId: string, tope = 2000): Promise<number> {
  const tenant = currentWorkspaceId();
  let n = 0, vistas = 0;
  while (vistas < tope) {
    const altas = await dbSioLeadsSinOrigen(accountId, 5 * 60_000, Math.min(500, tope - vistas));
    if (!altas.length) break;
    for (const l of altas) {
      vistas++;
      let cid = "";
      try { const q = new URL(l.source_url).searchParams; cid = ["gclid", "msclkid", "fbclid", "ttclid", "li_fat_id", "twclid"].find((k) => q.get(k)) || ""; } catch { /* sin URL */ }
      const o = (cid && plataformaDeVisita({ click_id: cid })) || (await origenDeVisitaDeUnAlta(tenant, l.source_url, l.registered_at as number));
      await dbSioLeadSetOrigenVisita(accountId, l.sio_contact_id, o);
      if (o) n++;
    }
  }
  return n;
}

/** Cuentas sincronizables (con API key). */
export async function sioLeadsSyncableAccounts(): Promise<SiAccount[]> {
  return (await listAccountsRaw()).filter((a) => !!a.apiKey);
}

let timer: ReturnType<typeof setInterval> | null = null;
/**
 * Scheduler cada 15 min: pasada incremental por cada cuenta con key. Tras el primer
 * recorrido completo, cada pasada es 1 llamada (sin contactos nuevos) — barato.
 */
export function startSioLeadsScheduler(): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    try {
      await runWithWorkspace("default", async () => {
        for (const acc of await sioLeadsSyncableAccounts()) {
          const r = await syncSioLeadsForAccount(acc.id, 10);
          // SIO-RUIDO-1 * solo se apunta cuando ENTRA algo. La pasada horaria relee
          // siempre la pagina mas nueva (100 contactos) para ver si hay altas: con
          // scanned > 0 dejaba una linea por cuenta y hora -48 al dia- que ademas
          // decia copiados de gente ya copiada hacia semanas.
          if (r.added > 0) {
            await logActivity({
              source: "app",
              level: "info",
              summary: `Origen sio: ${r.added} lead${r.added === 1 ? "" : "s"} nuevo${r.added === 1 ? "" : "s"} de ${acc.accountEmail || acc.id} (${r.withUtm} con UTM de ${r.scanned} revisados)`,
              payload: { file: "sio-leads.ts", ...r },
            }).catch(() => {});
          }
        }
        // VENTAS-SIO-1 · y las ventas de los checkouts, con su importe (después de las altas:
        // así el email del comprador ya está en la ficha del lead cuando se cruza).
        // VENTAS-CORTE-1 · desde el corte las trae el aviso de systeme.io: el sondeo no corre.
        const { cuentasConVentas, syncVentasSio, VENTAS_POR_SONDEO } = await import("./sio-ventas.js");
        for (const acc of VENTAS_POR_SONDEO ? await cuentasConVentas() : []) {
          const v = await syncVentasSio(acc).catch((e) => ({ added: 0, error: (e as Error).message }));
          if (v.error) console.warn("[sio-ventas]", acc.id, v.error);
          if (v.added > 0) {
            await logActivity({
              source: "app",
              level: "info",
              summary: `Ventas de systeme.io: ${v.added} nueva${v.added === 1 ? "" : "s"} de ${acc.accountEmail || acc.id}`,
              payload: { file: "sio-ventas.ts", tag: "VENTAS-SIO-1", ...v },
            }).catch(() => {});
          }
        }
      });
    } catch (e) {
      console.warn("[sio-leads] tick:", (e as Error).message);
    }
  };
  // FORMULARIO-A-LEAD-1 · cada 15 min (antes cada hora): el email del checkout tiene que
  // aparecer en la ficha del lead poco después de comprar. Sin altas nuevas es 1 llamada.
  timer = setInterval(() => { void tick(); }, 15 * 60_000);
  timer.unref?.();
  // Primera pasada a los 90s del arranque (no compite con el boot).
  const first = setTimeout(() => { void tick(); }, 90_000);
  (first as { unref?: () => void }).unref?.();
}
