/**
 * Lead Providers — capa de abstracción para buscar leads en distintas fuentes.
 *
 * La app NO reinventa MailerFind / Hunter / Apollo. Cada uno tiene su API y
 * su modelo de precios; nosotros somos el *hub* que las orquesta y manda los
 * leads encontrados al mismo sync (Systeme.io / leadmatch-lab).
 *
 * Providers actuales:
 *
 *   - `hunter`       (Hunter.io v2)  — domain-search: emails de empleados a
 *                                       partir de un dominio. Robusto, legal,
 *                                       muy documentado.
 *   - `apollo`       (Apollo.io v1)  — people-search: filtros tipo "founders en
 *                                       startups SaaS de Madrid". El más rico
 *                                       en B2B.
 *   - `mailerfind`   (MailerFind)    — emails de bios de Instagram a partir
 *                                       de un competidor (@handle). Asumen el
 *                                       riesgo de los ToS de IG por nosotros.
 *
 * El user mete su API key en Ajustes (cifrada). Si no hay key configurada,
 * el provider devuelve `{configured:false}` y la UI lo oculta/desactiva.
 *
 * Cada provider devuelve un array de `ProviderLead` con la misma forma que
 * el resto del leadfinder, para que el sync no tenga que saber de dónde vienen.
 */
import { get } from "./settings.js";
import { destinoConfigurableResuelvePublico, downloadPublic, PublicDownloadError } from "./public-download.js";

export interface ProviderLead {
  /** Nombre del contacto/persona o de la empresa, lo que el provider dé. */
  name: string;
  email: string;
  /** Email adicionales si el provider los devuelve. */
  emails?: string[];
  company?: string;
  website?: string;
  position?: string;
  linkedin?: string;
  instagram?: string;
  phone?: string;
  /** Confianza del provider (0-100). Hunter la da; Apollo no siempre. */
  confidence?: number;
  /** id del provider que lo encontró (para trazar). */
  source: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  description: string;
  /** Qué tipo de "input" pide al user para buscar. */
  inputKind: "domain" | "ig_handle" | "free_text";
  configured: boolean;
  /** Para mostrar en UI: "instagram_bios", "b2b_database", "domain_search". */
  category: "b2b_database" | "domain_search" | "instagram_bios";
}

export type ProviderId = "hunter" | "apollo" | "mailerfind";

export interface SearchOpts {
  /** Para Hunter/Apollo: limite de resultados (su quota lo respeta). */
  limit?: number;
}

interface ProviderImpl {
  info: Omit<ProviderInfo, "configured">;
  isConfigured(): boolean;
  search(input: string, opts?: SearchOpts): Promise<ProviderLead[]>;
}

/* ------------------------------------------------------------------ */
/* Hunter.io — domain → emails de empleados                            */
/* ------------------------------------------------------------------ */

const hunterProvider: ProviderImpl = {
  info: {
    id: "hunter",
    label: "Hunter.io",
    description:
      "Emails de empleados a partir del dominio de una empresa. Devuelve nombre, " +
      "posición y confianza. Plan free: 25 búsquedas/mes.",
    inputKind: "domain",
    category: "domain_search",
  },
  isConfigured() {
    return !!get("leads.hunter.apiKey");
  },
  async search(input: string, opts?: SearchOpts): Promise<ProviderLead[]> {
    const apiKey = get("leads.hunter.apiKey");
    if (!apiKey) throw new Error("Hunter.io no configurado (falta leads.hunter.apiKey en Ajustes)");
    const domain = input.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!domain) throw new Error("Hunter.io: dominio vacío");
    const limit = Math.min(100, Math.max(1, opts?.limit || 25));
    const url =
      "https://api.hunter.io/v2/domain-search?domain=" +
      encodeURIComponent(domain) +
      "&limit=" +
      limit +
      "&api_key=" +
      encodeURIComponent(apiKey);
    const res = await fetch(url);
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.errors?.[0]?.details || data?.message || `HTTP ${res.status}`;
      throw new Error("Hunter.io: " + msg);
    }
    const emails: any[] = data?.data?.emails ?? [];
    const orgName = data?.data?.organization || "";
    return emails
      .filter((e: any) => e?.value)
      .map((e: any) => ({
        name: [e.first_name, e.last_name].filter(Boolean).join(" ") || e.value,
        email: String(e.value),
        company: orgName,
        website: domain,
        position: e.position || "",
        linkedin: e.linkedin || "",
        phone: e.phone_number || "",
        confidence: typeof e.confidence === "number" ? e.confidence : undefined,
        source: "hunter:" + domain,
      }));
  },
};

/* ------------------------------------------------------------------ */
/* Apollo.io — people-search (B2B database)                            */
/* ------------------------------------------------------------------ */

const apolloProvider: ProviderImpl = {
  info: {
    id: "apollo",
    label: "Apollo.io",
    description:
      "Base de datos B2B masiva. Búsqueda por keywords (cargo + sector). El email " +
      "viene si el plan del user incluye `email reveal`; si no, solo el nombre.",
    inputKind: "free_text",
    category: "b2b_database",
  },
  isConfigured() {
    return !!get("leads.apollo.apiKey");
  },
  async search(input: string, opts?: SearchOpts): Promise<ProviderLead[]> {
    const apiKey = get("leads.apollo.apiKey");
    if (!apiKey) throw new Error("Apollo.io no configurado (falta leads.apollo.apiKey en Ajustes)");
    const q = input.trim();
    if (!q) throw new Error("Apollo.io: query vacío");
    const limit = Math.min(100, Math.max(1, opts?.limit || 25));
    const res = await fetch("https://api.apollo.io/v1/mixed_people/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify({
        q_keywords: q,
        page: 1,
        per_page: limit,
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error || data?.message || `HTTP ${res.status}`;
      throw new Error("Apollo.io: " + msg);
    }
    const people: any[] = data?.people ?? [];
    return people
      .filter((p: any) => p?.email)
      .map((p: any) => ({
        name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.name || p.email,
        email: String(p.email),
        company: p.organization?.name || "",
        website: p.organization?.website_url || "",
        position: p.title || "",
        linkedin: p.linkedin_url || "",
        phone: p.phone_numbers?.[0]?.raw_number || "",
        source: "apollo:" + q.slice(0, 40),
      }));
  },
};

/* ------------------------------------------------------------------ */
/* MailerFind (genérico) — emails de bios IG a partir de un @handle    */
/* ------------------------------------------------------------------ */
/* MailerFind no publica una API REST estable y documentada. Algunos    */
/* planes exponen un endpoint privado al user; en otros sólo hay export */
/* manual. Para no atarnos a un shape concreto que cambia, dejamos al   */
/* user pegar el endpoint EXACTO que su panel le da, y POSTeamos un     */
/* JSON con { handle, limit, key }. El shape esperado de respuesta es    */
/* { results: [{ name, email, instagram, ... }] }. Si su API tiene otro */
/* shape, la lectura más abajo cae con elegancia y devuelve [].          */

const mailerfindProvider: ProviderImpl = {
  info: {
    id: "mailerfind",
    label: "MailerFind",
    description:
      "Emails de bios de Instagram a partir de los followers de un competidor. " +
      "Necesita endpoint + API key del panel de MailerFind (zona Ajustes → Credenciales).",
    inputKind: "ig_handle",
    category: "instagram_bios",
  },
  isConfigured() {
    return !!get("leads.mailerfind.apiKey") && !!get("leads.mailerfind.endpoint");
  },
  async search(input: string, opts?: SearchOpts): Promise<ProviderLead[]> {
    const apiKey = get("leads.mailerfind.apiKey");
    const endpoint = get("leads.mailerfind.endpoint");
    if (!apiKey || !endpoint) {
      throw new Error(
        "MailerFind no configurado: necesita leads.mailerfind.apiKey y leads.mailerfind.endpoint (URL exacta de su API, en su panel).",
      );
    }
    // DESTINO-PUBLICO-1/2: la clave del negocio solo sale hacia una dirección de Internet.
    if (!(await destinoConfigurableResuelvePublico(endpoint))) {
      throw new Error("MailerFind: la dirección de su API debe ser pública (https://…), no una dirección interna.");
    }
    const handle = input.trim().replace(/^@/, "").replace(/^.*instagram\.com\//, "");
    if (!handle) throw new Error("MailerFind: @handle vacío");
    const limit = Math.min(500, Math.max(1, opts?.limit || 100));
    // DESTINO-SSRF-2: la IP comprobada es la IP a la que se conecta (sin rebinding) y la
    // respuesta se lee con tope. Con credenciales no se siguen redirecciones.
    const res = await downloadPublic(endpoint, {
      method: "POST",
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 30_000,
      followRedirects: false,
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify({ handle, limit }),
    }).catch((e) => {
      if (e instanceof PublicDownloadError) throw new Error("MailerFind: " + e.message);
      throw e;
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error("MailerFind: su API respondió con una redirección; pon la dirección final de la API.");
    }
    const data: any = (() => { try { return JSON.parse(res.body.toString("utf8")); } catch { return {}; } })();
    if (!res.ok) {
      const msg = data?.error || data?.message || `HTTP ${res.status}`;
      throw new Error("MailerFind: " + msg);
    }
    // Tolerante a varios shapes: { results: [...] } | { data: [...] } | [...].
    const items: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.data)
          ? data.data
          : [];
    return items
      .filter((it) => it && (it.email || it.mail))
      .map((it: any): ProviderLead => ({
        name: it.name || it.full_name || it.username || it.handle || "",
        email: String(it.email || it.mail),
        instagram: it.instagram || (it.username ? "https://instagram.com/" + it.username : ""),
        website: it.website || it.url || "",
        phone: it.phone || "",
        source: "mailerfind:@" + handle,
      }));
  },
};

/* ------------------------------------------------------------------ */
/* Registry + API pública                                              */
/* ------------------------------------------------------------------ */

const PROVIDERS: Record<ProviderId, ProviderImpl> = {
  hunter: hunterProvider,
  apollo: apolloProvider,
  mailerfind: mailerfindProvider,
};

export function listProviders(): ProviderInfo[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
    const p = PROVIDERS[id];
    return { ...p.info, configured: p.isConfigured() };
  });
}

export function getProvider(id: string): ProviderImpl | null {
  return (PROVIDERS as Record<string, ProviderImpl>)[id] ?? null;
}

export async function searchWithProvider(
  id: string,
  input: string,
  opts?: SearchOpts,
): Promise<ProviderLead[]> {
  const p = getProvider(id);
  if (!p) throw new Error("Provider desconocido: " + id);
  if (!p.isConfigured()) throw new Error("Provider " + id + " no configurado en Ajustes");
  return await p.search(input, opts);
}
