/**
 * Sync de RESERVAS del calendario de booking de systeme.io / leadmatch-lab
 * → app_sio_bookings. La vista Reuniones las pinta junto a las reuniones
 * apuntadas a contactos, con su estado real (confirmada/reprogramada/cancelada).
 *
 * Va contra la API PÚBLICA oficial (GET /booking-calendar/bookings, añadida por
 * systeme.io en 2026) con la misma X-API-Key por cuenta que ya vive en
 * Conexiones — nada de scraping ni credenciales nuevas. Solo lectura.
 *
 * A diferencia del sync de leads (incremental por cursor), aquí cada pasada
 * relee la VENTANA completa (30 días atrás → 120 adelante): una reserva puede
 * cambiar de fecha o cancelarse después de copiada, y el upsert es quien
 * corrige eso. El volumen de reservas de una ventana así es pequeño (páginas
 * de 100); releer es más barato que razonar sobre qué pudo cambiar.
 *
 * Multi-workspace: las cuentas web viven POR workspace (systemeio.accounts),
 * así que el tick recorre todos — igual que remindersTick, y a diferencia del
 * sync de leads, que solo mira 'default' (deuda conocida de ese worker).
 */
import { listAccountsRaw } from "./systemeio-accounts.js";
import { withPublicApiKey, listBookingsPage } from "./systemeio-public-api.js";
import { dbSioBookingsUpsert, dbSioBookingsPrevios, dbClaimOnce, dbClavesPorTelefono, dbClavesPorEmail, dbSioBookingSetContacto, dbFormResponsesConContactoEntre, type SioBooking, type FormResponseRec } from "./db.js";
import { normalizarTelefono, canalDeFicha } from "./identidad.js";
import { logActivity } from "./activity.js";
import { runWithWorkspace, listWorkspacesCached } from "./workspace.js";
import { getContact, contactByEmail, createContact, addContactNote, enrichContact, updateContact, type Contact } from "./contacts.js";
import { triggerBookingFlows } from "./flows.js";
import { get as getSetting } from "./settings.js";
import { avisarContacto } from "./notifications.js";
import { offsetMin } from "./cuando-publicar.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const DIAS_ATRAS = 30;
const DIAS_ADELANTE = 120;


/** MET-AUTO-07-FIN · ficha de WhatsApp de este negocio con el móvil que dejó al reservar, o "". */
async function fichaPorTelefono(raw: string): Promise<string> {
  const tel = normalizarTelefono(raw);
  if (!tel) return "";
  return (await dbClavesPorTelefono(tel).catch(() => [] as string[]))[0] || "";
}

/** RESERVA-WA-2 · la ficha de quien reservó, prefiriendo SIEMPRE la de WhatsApp: 1) la del móvil
 *  que dejó al reservar; 2) entre las fichas con su correo, la que tiene WhatsApp; 3) cualquiera
 *  con su correo. Antes era «la primera con ese correo» (LIMIT 1 sin orden): con una ficha
 *  «email:» y otra de WhatsApp con el mismo correo, a veces ganaba la «email:» y la confirmación
 *  por WhatsApp no salía. */
async function fichaDeReserva(b: { email?: string | null; phone?: string | null }): Promise<Contact | null> {
  const ft = await fichaPorTelefono(String(b.phone || ""));
  if (ft) { const c = await getContact(ft); if (c) return c; }
  const email = String(b.email || "").trim();
  if (!email) return null;
  let otra: Contact | null = null;
  for (const k of await dbClavesPorEmail(email).catch(() => [] as string[])) {
    const c = await getContact(k);
    if (!c) continue;
    if (canalDeFicha(c) === "whatsapp") return c;
    otra = otra || c;
  }
  return otra || (await contactByEmail(email));
}

/** RESERVA-WA-3 · palabras de un nombre, sin acentos ni mayúsculas. */
function palabrasNombre(s: string): string[] {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
/** Mismo nombre de pila, y las palabras del nombre corto están todas en el largo
 *  («Carla Calle» ↔ «Carla Berdejo Calle» sí; «Carla Ruiz» ↔ «Carla Calle» no). */
function nombresCompatibles(a: string, b: string): boolean {
  const x = palabrasNombre(a), y = palabrasNombre(b);
  if (!x.length || !y.length || x[0] !== y[0]) return false;
  const [corto, largo] = x.length <= y.length ? [x, y] : [y, x];
  return corto.every((t) => largo.includes(t));
}

/** RESERVA-WA-3 · la API de reservas de systeme.io NO trae correo ni teléfono, solo «contactName»
 *  y cuándo se creó. Quien reserva desde un formulario del panel lo ha respondido segundos antes
 *  (la respuesta ya tiene ficha y móvil): se busca la respuesta de las 2 h anteriores (o 15 min
 *  después, por relojes) con nombre compatible, la más cercana. Si hay DOS personas posibles, no
 *  se une a ninguna: confirmar la cita a quien no es peor que no confirmarla. */
async function fichaPorRespuesta(nombre: string, creadaMs: number): Promise<{ c: Contact; tel: string } | null> {
  if (!palabrasNombre(nombre).length || !creadaMs) return null;
  const resps = await dbFormResponsesConContactoEntre(creadaMs - 2 * 3600000, creadaMs + 15 * 60000).catch(() => [] as FormResponseRec[]);
  const hits: { r: FormResponseRec; c: Contact }[] = [];
  for (const r of resps) {
    const c = await getContact(r.contact_id).catch(() => null);
    if (!c) continue;
    if (!nombresCompatibles(nombre, r.name) && !nombresCompatibles(nombre, String(c.name || ""))) continue;
    hits.push({ r, c });
  }
  if (!hits.length || new Set(hits.map((h) => h.c.phone)).size > 1) return null;
  hits.sort((a, b) => Math.abs(a.r.created_at - creadaMs) - Math.abs(b.r.created_at - creadaMs));
  return { c: hits[0].c, tel: hits[0].r.phone };
}

/** RESERVA-WA-3 · quién hizo la reserva y su móvil: la ficha ya unida en otra pasada; si no, por el
 *  móvil o el correo de la reserva (RESERVA-WA-2); si no, por la respuesta del formulario. La ficha
 *  hallada queda unida a la reserva (contact_key: Reuniones la enseña con su teléfono). */
async function quienReservo(accountId: string, b: { id: number; contactName?: string; createdAt?: string | null; email?: string | null; phone?: string | null }, unida: string): Promise<{ c: Contact | null; tel: string }> {
  let c: Contact | null = unida ? await getContact(unida).catch(() => null) : null;
  let tel = String(b.phone || "");
  if (!c) c = await fichaDeReserva(b);
  if (!c) {
    const m = await fichaPorRespuesta(String(b.contactName || ""), b.createdAt ? Date.parse(b.createdAt) || 0 : 0);
    // Con su correo y su móvil, la ficha de WhatsApp si la hay (RESERVA-WA-2).
    if (m) { c = (await fichaDeReserva({ email: m.c.email, phone: m.tel })) || m.c; tel = tel || m.tel; }
  }
  if (!c) return { c: null, tel };
  if (!normalizarTelefono(tel) && normalizarTelefono(c.phone)) tel = c.phone;
  if (c.phone !== unida) await dbSioBookingSetContacto(accountId, b.id, c.phone).catch(() => { /* la unión es best-effort */ });
  return { c, tel };
}

export interface SioBookingsSyncResult {
  accountId: string;
  copied: number;
  pages: number;
  error?: string;
}

/** RESERVA-HORA-1 · Zona del negocio, válida; sin configurar, la de España peninsular
 *  (nunca la del proceso: en Railway es UTC y las horas salían 2 h corridas). */
export function zonaReservas(): string {
  const tz = (getSetting("biz.timezone") || "").trim();
  if (tz) { try { new Date().toLocaleString("es-ES", { timeZone: tz }); return tz; } catch { /* zona inválida */ } }
  return "Europe/Madrid";
}

/** RESERVA-HORA-1 · El instante real de la cita. systeme.io manda la HORA DE RELOJ de la cita
 *  con «+00:00» pegado: la reserva 204286, hecha a las 18:50 de Madrid, llega como
 *  «2026-10-16T18:50:00+00:00» (comprobado el 10-oct-2026; su createdAt, en cambio, sí es UTC).
 *  Se ignora ese desfase y la hora se sitúa en la zona del negocio. */
export function instanteReserva(date: string, tz: string): number {
  const m = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return Date.parse(date) || 0;
  const reloj = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let utc = reloj - offsetMin(reloj, tz) * 60_000;
  utc = reloj - offsetMin(utc, tz) * 60_000; // segunda vuelta: el cambio de hora cae entre medias
  return Number.isFinite(utc) ? utc : 0;
}

/** Fecha YYYY-MM-DD (el filtro de la API es por día, no por instante). */
function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Sincroniza UNA cuenta: relee la ventana entera y upserta. */
export async function syncSioBookingsForAccount(accountId: string, maxPages = 20): Promise<SioBookingsSyncResult> {
  const acc = (await listAccountsRaw()).find((a) => a.id === accountId);
  const out: SioBookingsSyncResult = { accountId, copied: 0, pages: 0 };
  if (!acc) { out.error = "Cuenta no encontrada"; return out; }
  if (!acc.apiKey) { out.error = "La cuenta no tiene clave de API pública (añádela en Conexiones)"; return out; }
  const now = Date.now();
  const tz = zonaReservas(); // RESERVA-HORA-1
  const startDate = ymd(now - DIAS_ATRAS * 86400000);
  const endDate = ymd(now + DIAS_ADELANTE * 86400000);
  try {
    await withPublicApiKey(acc.apiKey, async () => {
      let cursor: number | undefined = undefined;
      for (let p = 0; p < maxPages; p++) {
        const page = await listBookingsPage({ startDate, endDate, startingAfter: cursor });
        out.pages++;
        if (!page.items.length) return;
        const rows: SioBooking[] = page.items.map((b) => ({
          account_id: accountId,
          booking_id: b.id,
          booked_at: b.date ? instanteReserva(b.date, tz) || null : null, // RESERVA-HORA-1
          created_at: b.createdAt ? Date.parse(b.createdAt) || null : null,
          event_name: b.eventName.slice(0, 300),
          duration_min: b.eventDuration,
          status: b.status,
          payment_status: b.paymentStatus,
          event_type: b.eventType,
          contact_name: b.contactName.slice(0, 200),
          email: b.email.slice(0, 320).toLowerCase(),
        }));
        // FORM-CITA-2 · cómo estaban antes de esta pasada: lo que cambie de fecha o se cancele
        // desde la anterior se refleja en la ficha (systeme.io no avisa de reservas: se compara).
        const previas = await dbSioBookingsPrevios(accountId, rows.map((r) => r.booking_id)).catch(() => new Map<number, { booked_at: number | null; status: string; contact_key: string }>());
        await dbSioBookingsUpsert(rows);
        out.copied += rows.length;
        // ALTA UNIFICADA · quien reserva y no tiene ficha, la gana: es un lead
        // de verdad, y con ficha la reserva queda vinculada (y con email, el
        // panel puede llegar a avisarle si algún día escribe por un canal).
        for (const b of page.items) {
          if (!b.email) continue;
          try {
            if (await contactByEmail(b.email)) continue;
            // MET-AUTO-07-FIN · reservó dejando su móvil y ya tiene ficha de WhatsApp SIN correo:
            // se le pone el correo a ESA ficha (mismo teléfono = misma persona, IDENTIDAD-COMUN-1)
            // en vez de abrir una ficha «email:» paralela que la separaría de su conversación.
            const fichaTel = await fichaPorTelefono(b.phone);
            if (fichaTel) {
              const ct = await getContact(fichaTel);
              if (ct && !String(ct.email || "").trim()) {
                await updateContact(fichaTel, { email: b.email.toLowerCase() });
                await addContactNote(fichaTel, "Correo añadido por su reserva en tu web («" + (b.eventName || "reserva") + "»): reservó con este mismo teléfono", { kind: "system", author: "panel" }).catch(() => { /* nota best-effort */ });
                continue;
              }
            }
            const phone = "email:" + b.email;
            if (await getContact(phone)) continue;
            await createContact({ phone, email: b.email, name: b.contactName || b.email, source: "systemeio", systemeio_account: accountId });
            await addContactNote(phone, "Ficha creada por su reserva en tu web («" + (b.eventName || "reserva") + "»)", { kind: "system", author: "panel" }).catch(() => { /* nota best-effort */ });
          } catch { /* best-effort: la reserva ya está copiada igualmente */ }
        }
        // RESERVA-FLOW-1 · Una reserva NUEVA dispara los flujos con trigger
        // «booking» (confirmación/bienvenida con el copy del usuario). Solo:
        //  - futuras y no canceladas (confirmar una cita pasada es ruido);
        //  - RECIENTES (creadas hace <48 h): al estrenar un flujo no hay que
        //    «confirmar» reservas hechas hace semanas que el sync ya conocía;
        //  - UNA vez por reserva (claim booking-flow, sobrevive a reinicios).
        // Los datos viajan como vars del run Y quedan en la ficha como campos
        // reserva_* — utilizables en mensajes como {{reserva_evento}} o
        // {{field.reserva_evento}}, y visibles en la ficha del contacto.
        const diaDe = (ms: number) => new Date(ms).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: tz });
        const horaDe = (ms: number) => new Date(ms).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: tz });
        for (const b of page.items) {
          try {
            const estado = String(b.status || "").toUpperCase();
            if (estado === "CANCELLED" || estado === "PAST") continue;
            const atMs = b.date ? instanteReserva(b.date, tz) : 0; // RESERVA-HORA-1
            if (!atMs || atMs <= Date.now()) continue;
            const creadaMs = b.createdAt ? Date.parse(b.createdAt) || 0 : 0;
            if (!creadaMs || Date.now() - creadaMs > 48 * 3600000) continue;
            // MET-AUTO-07-FIN + RESERVA-WA-2 · la ficha de WhatsApp antes que la «email:».
            // RESERVA-WA-3 · y sin correo ni móvil en la reserva, la de su respuesta del formulario.
            const { c, tel } = await quienReservo(accountId, b, previas.get(b.id)?.contact_key || "");
            const phone = c ? c.phone : (b.email ? "email:" + b.email : "");
            if (!phone) continue;
            if (!(await dbClaimOnce("booking-flow", accountId + ":" + b.id))) continue;
            const fecha = diaDe(atMs);
            const hora = horaDe(atMs);
            const webLbl = acc.accountEmail || acc.label || accountId;
            // NOTIFICACIONES-1 · reunion (una vez por reserva: el claim de arriba)
            avisarContacto("reunion", phone, (nm) => ({ title: nm + " ha reservado una cita", body: (b.eventName ? "«" + b.eventName + "» · " : "") + fecha + " a las " + hora + "." }), { name: c?.name || b.contactName, channel: "web", dedup: "reunion:" + accountId + ":" + b.id });
            await enrichContact(phone, { fields: { reserva_evento: (b.eventName || "").slice(0, 200), reserva_fecha: fecha, reserva_hora: hora, reserva_web: webLbl.slice(0, 120), reserva_estado: "confirmada", reserva_at: new Date().toISOString() /* MET-AUTO-10-FIN: corta secuencias en curso */ } }).catch(() => { /* campos best-effort */ });
            const n = await triggerBookingFlows(phone, { evento: b.eventName || "", fecha, hora, web: webLbl, origen: "web", telefono: tel });
            if (n > 0) {
              await logActivity({
                source: "app", level: "info",
                summary: `Reserva nueva → ${n} flujo(s) de confirmación arrancados (${b.eventName || "reserva"})`,
                payload: { file: "sio-bookings.ts", booking: accountId + ":" + b.id, phone: phone.slice(0, 10) + "…" },
              }).catch(() => {});
            }
          } catch { /* best-effort: la reserva ya está copiada igualmente */ }
        }
        // FORM-CITA-2 · CAMBIOS: una reserva ya conocida que cambia de día u hora, o que se
        // cancela, deja la ficha al día (reserva_fecha, reserva_hora, reserva_estado), con una
        // nota y el aviso de reunión. Una vez por cambio (claim con la fecha nueva o «C»).
        // No vuelve a disparar los flujos de reserva: un flujo largo no debe repetirse entero.
        for (const b of page.items) {
          try {
            const antes = previas.get(b.id);
            if (!antes) continue;
            const estado = String(b.status || "").toUpperCase();
            const atMs = b.date ? instanteReserva(b.date, tz) : 0; // RESERVA-HORA-1
            // RESERVA-HORA-1 · guardada con la lectura antigua (la hora de reloj tomada como UTC): no se
            // ha movido, solo se corrige. Si su ficha aún enseña la hora mal calculada, se arregla
            // en silencio (sin nota ni aviso) y la reserva sigue su curso. Una cancelación sí sigue abajo.
            const atViejo = b.date ? Date.parse(b.date) || 0 : 0;
            if (atMs && atViejo && atViejo !== atMs && antes.booked_at != null && Math.abs(antes.booked_at - atViejo) < 1000 && estado !== "CANCELLED") {
              if (atMs > Date.now()) {
                const { c } = await quienReservo(accountId, b, antes.contact_key);
                const f = (c && c.fields) || {};
                if (c && f.reserva_fecha === diaDe(atViejo) && f.reserva_hora === horaDe(atViejo)) {
                  await enrichContact(c.phone, { fields: { reserva_fecha: diaDe(atMs), reserva_hora: horaDe(atMs) } }).catch(() => { /* campos best-effort */ });
                }
              }
              continue;
            }
            const cancelada = estado === "CANCELLED" && String(antes.status || "").toUpperCase() !== "CANCELLED";
            const movida = !cancelada && estado !== "CANCELLED" && !!atMs && !!antes.booked_at && Math.abs(atMs - antes.booked_at) >= 60_000;
            if (!cancelada && !movida) continue;
            if (atMs && atMs < Date.now() - 86400000) continue; // citas ya pasadas: ruido
            const { c } = await quienReservo(accountId, b, antes.contact_key); // RESERVA-WA-2/3
            if (!c) continue;
            if (!(await dbClaimOnce("booking-cambio", accountId + ":" + b.id + ":" + (cancelada ? "C" : String(atMs))))) continue;
            const evento = b.eventName ? "«" + b.eventName + "»" : "su cita";
            if (movida) {
              const fecha = diaDe(atMs), hora = horaDe(atMs);
              const antesTxt = diaDe(antes.booked_at!) + " a las " + horaDe(antes.booked_at!);
              await enrichContact(c.phone, { fields: { reserva_evento: (b.eventName || "").slice(0, 200), reserva_fecha: fecha, reserva_hora: hora, reserva_estado: "reprogramada" } }).catch(() => { /* campos best-effort */ });
              await addContactNote(c.phone, "Ha cambiado " + evento + ": antes " + antesTxt + ", ahora " + fecha + " a las " + hora + ".", { kind: "system", author: "panel" }).catch(() => { /* nota best-effort */ });
              avisarContacto("reunion", c.phone, (nm) => ({ title: nm + " ha cambiado su cita", body: (b.eventName ? "«" + b.eventName + "» · " : "") + "ahora el " + fecha + " a las " + hora + " (antes " + antesTxt + ")." }), { name: c.name || b.contactName, channel: "web", dedup: "reunion-cambio:" + accountId + ":" + b.id + ":" + atMs });
            } else {
              const cuando = atMs ? diaDe(atMs) + " a las " + horaDe(atMs) : "";
              await enrichContact(c.phone, { fields: { reserva_estado: "cancelada" } }).catch(() => { /* campos best-effort */ });
              await addContactNote(c.phone, "Ha cancelado " + evento + (cuando ? " del " + cuando : "") + ".", { kind: "system", author: "panel" }).catch(() => { /* nota best-effort */ });
              avisarContacto("reunion", c.phone, (nm) => ({ title: nm + " ha cancelado su cita", body: (b.eventName ? "«" + b.eventName + "»" : "La cita") + (cuando ? " del " + cuando : "") + "." }), { name: c.name || b.contactName, channel: "web", dedup: "reunion-cancelada:" + accountId + ":" + b.id });
            }
          } catch { /* best-effort: la reserva ya está copiada igualmente */ }
        }
        if (!page.hasMore) return;
        cursor = Math.max(...page.items.map((b) => b.id));
        await sleep(250); // respirar entre páginas (rate-limit de la API)
      }
    });
  } catch (e) {
    out.error = (e as Error).message || "error de sync";
  }
  return out;
}

/** Una pasada completa: todas las cuentas con API key de todos los workspaces. */
export async function syncAllSioBookings(): Promise<void> {
  try {
    let workspaces: { id: string }[] = [];
    try { workspaces = await listWorkspacesCached(); }
    catch { workspaces = [{ id: "default" }]; }
    for (const ws of workspaces) {
      if (!ws.id || ws.id === "_global_") continue;
      await runWithWorkspace(ws.id, async () => {
        for (const acc of (await listAccountsRaw()).filter((a) => !!a.apiKey)) {
          const r = await syncSioBookingsForAccount(acc.id);
          if (r.copied > 0) {
            await logActivity({
              source: "app",
              level: "info",
              summary: `Reservas web: ${r.copied} copiadas de ${acc.accountEmail || acc.label || acc.id}`,
              payload: { file: "sio-bookings.ts", ...r },
            }).catch(() => {});
          } else if (r.error && r.error !== "La cuenta no tiene clave de API pública (añádela en Conexiones)") {
            console.warn(`[sio-bookings] ${acc.id}: ${r.error}`);
          }
        }
      });
    }
  } catch (e) {
    console.warn("[sio-bookings] tick:", (e as Error).message);
  }
}

/**
 * TIMBRE del webhook: systeme.io NO tiene webhook de reservas, pero una reserva
 * crea/actualiza al contacto en la web (squeeze lead) y ESO sí dispara el
 * webhook que el panel ya recibe. Cualquier evento entrante = probable reserva
 * nueva → se adelanta una pasada de sync en vez de esperar al tick de 10 min.
 * Debounce duro (60 s) para que una ráfaga de webhooks no se convierta en una
 * ráfaga de barridos; 5 s de espera para que la reserva aterrice en su API.
 */
let ultimoPoke = 0;
export function sioBookingsPokeSoon(): void {
  const ahora = Date.now();
  if (ahora - ultimoPoke < 60_000) return;
  ultimoPoke = ahora;
  const t = setTimeout(() => { void syncAllSioBookings(); }, 5_000);
  (t as { unref?: () => void }).unref?.();
}

/**
 * FORM-CITA-1 · TIMBRE de la reserva hecha desde un formulario: systeme.io devuelve a
 * la persona a /f/<slug>/reservada al reservar, y eso adelanta una pasada SOLO de ese
 * workspace (todas sus cuentas web: el calendario puede no ser de la cuenta a la que el
 * formulario copia el contacto) para que la confirmación por
 * WhatsApp salga en segundos y no a los 10 min. La reserva tarda un poco en aparecer
 * en su API: se mira a los 4 s, a los 25 s y a los 90 s. La ruta es pública, así que
 * hay freno por workspace (una tanda cada 20 s).
 */
const ultimoPokeWs = new Map<string, number>();
export function sioBookingsPokeWorkspace(wsId: string): void {
  if (!wsId) return;
  const ahora = Date.now();
  if (ahora - (ultimoPokeWs.get(wsId) || 0) < 20_000) return;
  ultimoPokeWs.set(wsId, ahora);
  const pasada = (): Promise<void> => runWithWorkspace(wsId, async () => {
    for (const acc of (await listAccountsRaw()).filter((a) => !!a.apiKey)) {
      const r = await syncSioBookingsForAccount(acc.id);
      if (r.error) console.warn(`[sio-bookings] timbre formulario ${acc.id}: ${r.error}`);
    }
  }).catch((e) => { console.warn("[sio-bookings] timbre formulario:", (e as Error).message); });
  for (const ms of [4_000, 25_000, 90_000]) {
    const t = setTimeout(() => { void pasada(); }, ms);
    (t as { unref?: () => void }).unref?.();
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Cada 10 min (garantía de fondo; el timbre del webhook adelanta lo urgente). */
export function startSioBookingsScheduler(): void {
  if (timer) return;
  timer = setInterval(() => { void syncAllSioBookings(); }, 10 * 60_000);
  timer.unref?.();
  // Primera pasada a los 2 min del arranque (no compite con el boot).
  const first = setTimeout(() => { void syncAllSioBookings(); }, 120_000);
  (first as { unref?: () => void }).unref?.();
  console.log("[sio-bookings] sync de reservas web activo (10m + timbre webhook)");
}
