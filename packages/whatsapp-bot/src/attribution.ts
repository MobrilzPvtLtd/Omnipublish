/**
 * Atribución de leads por origen. Parseo de UTM desde la sourceURL (la URL de la
 * landing con la que systeme.io registra al lead, p.ej.
 *   https://sudominio.com/webinar?ref=IGSID&utm_source=instagram&utm_medium=social&utm_content=salto
 * ) y clasificación en PLATAFORMA (instagram/linkedin/youtube…) y PAGO vs ORGÁNICO.
 *
 * Compartido por: el webhook de systeme.io (captura → escribe utm_* en el contacto),
 * el endpoint de analítica (/admin/api/analytics/attribution) y el dashboard.
 */

export interface Utm {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
}

/** Extrae los utm_* de una URL. Devuelve solo las claves presentes (no vacías). */
export function parseUtm(url: string): Utm {
  const out: Utm = {};
  if (!url) return out;
  try {
    const qIdx = url.indexOf("?");
    if (qIdx < 0) return out;
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const grab = (k: keyof Utm) => {
      const v = params.get(k);
      if (v && v.trim()) out[k] = v.trim().slice(0, 120);
    };
    grab("utm_source");
    grab("utm_medium");
    grab("utm_campaign");
    grab("utm_content");
  } catch {
    /* URL malformada → sin utm */
  }
  return out;
}

/**
 * Plataforma normalizada a partir de utm_source; si no hay utm, cae al canal grueso del
 * contacto (`source`: whatsapp/instagram/panel…). Devuelve una etiqueta estable en
 * minúsculas para agrupar (instagram, facebook, linkedin, youtube, tiktok, google, x,
 * email, whatsapp, web, directo, otro).
 */
export function platformOf(utmSource?: string, fallbackSource?: string): string {
  const s = String(utmSource || "").toLowerCase().trim();
  const f = String(fallbackSource || "").toLowerCase().trim();
  const pick = (v: string): string => {
    if (!v) return "";
    if (/(instagram|(^|[^a-z])ig([^a-z]|$))/.test(v)) return "instagram";
    // CONTACTOS-ORIGEN-1 · «lead-ads» es el origen de las fichas que trae la sincronización de los
    // formularios de Lead Ads (leadsAds.ts): Facebook, como «meta-lead-ad» del webhook. Valor exacto:
    // un utm «google-lead-ads» no es Facebook.
    if (/(facebook|(^|[^a-z])fb([^a-z]|$)|meta|^lead-ads$)/.test(v)) return "facebook";
    if (/linkedin/.test(v)) return "linkedin";
    if (/(youtube|(^|[^a-z])yt([^a-z]|$))/.test(v)) return "youtube";
    if (/tiktok/.test(v)) return "tiktok";
    if (/(google|adwords|gads)/.test(v)) return "google";
    if (/(twitter|(^|[^a-z])x([^a-z]|$))/.test(v)) return "x";
    if (/(email|e-?mail|newsletter|mailing|correo)/.test(v)) return "email";
    if (/whats?app/.test(v)) return "whatsapp";
    if (/(web|site|landing|organic-search|referral|blog)/.test(v)) return "web";
    if (/(direct|directo|panel|manual)/.test(v)) return "directo";
    return "";
  };
  return pick(s) || pick(f) || (s || f ? "otro" : "directo");
}

/** ¿Tráfico de PAGO u ORGÁNICO? Heurística sobre utm_medium (+ presencia de campaña). */
export function paidOrganicOf(utm: Utm): "pago" | "organico" | "desconocido" {
  const m = String(utm.utm_medium || "").toLowerCase().trim();
  if (!m && !utm.utm_campaign) return "desconocido";
  // Pago: cpc, ppc, paid, paid-social, display, cpm, sem, ads/anuncio…
  if (/(cpc|ppc|paid|cpm|(^|[^a-z])sem([^a-z]|$)|display|banner|(^|[^a-z])ads?([^a-z]|$)|anuncio|pago|promoted)/.test(m)) return "pago";
  // Orgánico: social, organic, bio, post, story, reel, referral, link…
  // MET-ORIGEN-02-FIN · email/newsletter NO es orgánico por sí mismo: un correo puede ser la vía de
  // llegada o una comunicación posterior → «desconocido» salvo otra señal.
  if (/(social|organic|org[aá]nico|bio|post|story|reel|referral|referido|link|community|comment|comentario)/.test(m)) {
    return "organico";
  }
  // Con campaña pero medium raro → asumimos pago (una campaña suele ser de pago);
  // sin nada reconocible → desconocido.
  return utm.utm_campaign ? "pago" : "desconocido";
}

/**
 * MET-ORIGEN-02-FIN · Clase de adquisición cuando utm/flujo no la deciden («desconocido»).
 * Altas del equipo (panel/import/leadfinder) → «manual». Instagram/YouTube sin referral de
 * anuncio → «organico» (Meta marca el referral de un anuncio). WhatsApp, web y correo NO se
 * dan por orgánicos: pueden ser canal de llegada o un seguimiento posterior → «desconocido».
 */
export function fallbackKindOf(platform: string, crmSource: string): "manual" | "organico" | "desconocido" {
  if (/^(panel|import|leadfinder)$/.test(String(crmSource || ""))) return "manual";
  if (platform === "instagram" || platform === "youtube") return "organico";
  return "desconocido";
}

/** Etiqueta bonita para la UI a partir de la clave de plataforma. */
export function platformLabel(key: string): string {
  const map: Record<string, string> = {
    instagram: "Instagram",
    facebook: "Facebook",
    linkedin: "LinkedIn",
    youtube: "YouTube",
    tiktok: "TikTok",
    google: "Google",
    x: "X / Twitter",
    email: "Email",
    whatsapp: "WhatsApp",
    web: "Web",
    directo: "Directo / sin origen",
    otro: "Otro",
  };
  return map[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Directo / sin origen");
}
