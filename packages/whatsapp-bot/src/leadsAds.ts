/**
 * Lead Ads (leads_retrieval): formularios de captación de Meta + descarga de
 * los leads + sincronización al CRM local. Cada Página de Facebook conectada
 * (meta.fbAccounts) puede tener varios formularios de instant forms. Con el
 * page access token leemos /{pageId}/leadgen_forms y /{formId}/leads, y damos
 * de alta cada lead como contacto (source='lead-ads', tag con el nombre del
 * formulario).
 *
 * Permiso: leads_retrieval (+ pages_show_list / pages_manage_metadata ya
 * presentes). El alumno NUNCA pega un token: usa el page token guardado tras
 * el OAuth de Meta.
 */
import { listFbAccounts, getFbAccount } from "./facebook.js";
import { createContact, getContact, updateContact, addContactNote } from "./contacts.js";
import { avisarLeadNuevo } from "./notifications.js";

const BASE = "https://graph.facebook.com/v21.0";

export interface LeadForm {
  id: string;
  name: string;
  status: string;
  leadsCount: number;
  pageId: string;
  pageName: string;
  createdTime?: string;
}

/** Lista todos los formularios de Lead Ads de todas las Páginas conectadas. */
export async function listLeadForms(): Promise<{ ok: boolean; forms: LeadForm[]; errors: string[] }> {
  const pages = listFbAccounts();
  const forms: LeadForm[] = [];
  const errors: string[] = [];
  for (const p of pages) {
    try {
      const url = `${BASE}/${p.pageId}/leadgen_forms?fields=id,name,status,leads_count,created_time&limit=100&access_token=${encodeURIComponent(p.token)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok || d?.error) {
        errors.push(`${p.name}: ${d?.error?.message || `HTTP ${r.status}`}`);
        continue;
      }
      for (const f of d.data ?? []) {
        forms.push({
          id: String(f.id),
          name: f.name || "(formulario sin nombre)",
          status: f.status || "",
          leadsCount: Number(f.leads_count) || 0,
          pageId: String(p.pageId),
          pageName: p.name || p.pageId,
          createdTime: f.created_time,
        });
      }
    } catch (e) {
      errors.push(`${p.name}: ${(e as Error).message}`);
    }
  }
  return { ok: errors.length === 0, forms, errors };
}

export interface RawLead {
  id: string;
  createdTime: string;
  fields: Record<string, string>;
}

/**
 * Descarga los leads de un formulario (necesita el page token de su Página).
 * Sigue paging.next de Meta hasta agotar `limit` (tope duro 2000): antes solo
 * se leía la primera página y el sync dejaba fuera en silencio la mayoría de
 * leads en formularios grandes. Con limit 50 (preview) la primera página basta.
 */
export async function listFormLeads(formId: string, pageId: string, limit = 200): Promise<{ ok: boolean; leads: RawLead[]; error?: string }> {
  const page = getFbAccount(pageId);
  if (!page) return { ok: false, leads: [], error: "Página no encontrada o desconectada." };
  try {
    const HARD_CAP = 2000;
    const target = Math.min(HARD_CAP, Math.max(1, limit));
    const leads: RawLead[] = [];
    let url: string | undefined = `${BASE}/${formId}/leads?fields=created_time,field_data&limit=${Math.min(500, target)}&access_token=${encodeURIComponent(page.token)}`;
    while (url && leads.length < target) {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok || d?.error) {
        // Primera página caída → error real. Página posterior caída → devolvemos
        // lo acumulado (el sync es idempotente y una re-ejecución continúa).
        if (leads.length === 0) return { ok: false, leads: [], error: d?.error?.message || `HTTP ${r.status}` };
        break;
      }
      const batch: any[] = d.data ?? [];
      for (const l of batch) {
        if (leads.length >= target) break;
        const fields: Record<string, string> = {};
        for (const fd of l.field_data ?? []) {
          const key = String(fd.name || "").toLowerCase();
          const val = Array.isArray(fd.values) ? fd.values.join(", ") : String(fd.values ?? "");
          if (key) fields[key] = val;
        }
        leads.push({ id: String(l.id), createdTime: l.created_time, fields });
      }
      url = batch.length > 0 ? (d.paging?.next as string | undefined) : undefined;
    }
    return { ok: true, leads };
  } catch (e) {
    return { ok: false, leads: [], error: (e as Error).message };
  }
}

// Heurística: localiza email / nombre / teléfono entre los campos del lead,
// tolerando nombres habituales en ES/EN y campos custom.
function pickEmail(f: Record<string, string>): string {
  return f.email || f.correo || f["correo_electrónico"] || f["correo_electronico"] || f["e-mail"] || "";
}
function pickPhone(f: Record<string, string>): string {
  const raw = f.phone_number || f.phone || f["teléfono"] || f.telefono || f["número_de_teléfono"] || "";
  return raw.replace(/[^\d+]/g, "");
}
function pickName(f: Record<string, string>): string {
  if (f.full_name) return f.full_name;
  if (f.name || f.nombre) return f.name || f.nombre;
  const first = f.first_name || f.nombre || "";
  const last = f.last_name || f.apellidos || f.apellido || "";
  return [first, last].filter(Boolean).join(" ").trim();
}

/**
 * Sincroniza los leads de un formulario al CRM. Idempotente: si el contacto ya
 * existe (mismo teléfono o email) solo añade el tag, no duplica. Devuelve el
 * recuento de importados/actualizados/omitidos.
 */
export async function syncFormLeads(formId: string, pageId: string, formName = ""): Promise<{ ok: boolean; imported: number; updated: number; skipped: number; error?: string }> {
  // limit 2000 = consumir todas las páginas (tope de seguridad de listFormLeads);
  // con el default (200) el sync solo procesaba la primera página de Meta.
  const res = await listFormLeads(formId, pageId, 2000);
  if (!res.ok) return { ok: false, imported: 0, updated: 0, skipped: 0, error: res.error };

  const tag = ("lead-ads" + (formName ? ":" + formName.toLowerCase().replace(/\s+/g, "-").slice(0, 24) : "")).slice(0, 40);
  let imported = 0, updated = 0, skipped = 0;

  for (const lead of res.leads) {
    const email = pickEmail(lead.fields);
    const phoneRaw = pickPhone(lead.fields);
    const name = pickName(lead.fields);
    // Clave del contacto: teléfono real > email > id del lead (último recurso).
    const key = phoneRaw || (email ? `email:${email}` : `lead:${lead.id}`);
    if (!phoneRaw && !email) { skipped++; continue; }

    // Campos extra del formulario que no son email/phone/name → fields del contacto.
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(lead.fields)) {
      if (["email", "correo", "phone_number", "phone", "telefono", "full_name", "name", "nombre", "first_name", "last_name", "apellidos"].includes(k)) continue;
      extra[k.slice(0, 40)] = String(v).slice(0, 200);
    }

    try {
      const existing = await getContact(key);
      if (existing) {
        const tags = Array.from(new Set([...(existing.tags || []), tag, "lead"]));
        await updateContact(key, {
          tags,
          name: existing.name || name,
          email: existing.email || email,
          fields: { ...(existing.fields || {}), ...extra },
          source: existing.source || "lead-ads",
        });
        updated++;
      } else {
        await createContact({
          phone: key,
          name,
          email,
          tags: [tag, "lead"],
          source: "lead-ads",
          fields: extra,
        });
        await addContactNote(key, `Lead captado por formulario de Meta "${formName || formId}"`, { kind: "system", author: "lead-ads" });
        // NOTIFICACIONES-1 · lead_nuevo, solo si el lead es reciente: importar el histórico
        // de un formulario no puede llenar la campana de cientos de avisos viejos.
        if (Date.now() - (Date.parse(lead.createdTime || "") || 0) < 48 * 3600000) avisarLeadNuevo(key, { name: name || email, channel: "facebook", origen: "Ha rellenado tu formulario «" + (formName || "de Meta") + "»." });
        imported++;
      }
    } catch {
      skipped++;
    }
  }
  return { ok: true, imported, updated, skipped };
}
