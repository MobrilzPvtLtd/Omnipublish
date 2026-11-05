/**
 * Diagnóstico de permisos Meta. Responde a la pregunta clave: "¿el token de mi
 * Página tiene de verdad los permisos que necesito?" — separando dos cosas que
 * a simple vista se confunden:
 *   1) Lo que el código PIDE en el OAuth (META_OAUTH_SCOPES). Si aquí no está
 *      leads_retrieval, es que el deploy es viejo (reconectar no servirá).
 *   2) Lo que Meta realmente CONCEDIÓ en el token (debug_token). Si lo piden
 *      pero no aparece, Meta no lo otorgó (rol de app / modo Live / review).
 */
import { get } from "./settings.js";
import { metaAppLista, debugToken } from "./meta-app.js";
import { listFbAccounts } from "./facebook.js";

const BASE = "https://graph.facebook.com/v21.0";

// Mapa único de scopes que el OAuth solicita por plataforma. Lo usa el handler
// /admin/auth/meta/start Y el diagnóstico, así el diagnóstico SIEMPRE refleja lo
// que pide el código realmente desplegado.
export const META_OAUTH_SCOPES: Record<string, string[]> = {
  // pages_messaging TAMBIÉN en el flujo IG: sin él, el page token acuñado al conectar
  // por Instagram no puede suscribir los campos de mensajería de la Página
  // (POST /{page}/subscribed_apps con messages/messaging_postbacks → error #200) y la
  // suscripción de webhooks queda coja aunque instagram_manage_messages esté aprobado.
  // pages_manage_engagement TAMBIÉN aquí (FB-PERMISOS-1): "Conectar Instagram" guarda
  // ADEMÁS las Páginas FB con su page token, y sin este permiso ese token no puede
  // publicar respuestas a comentarios (POST /{commentId}/comments → error #200). El
  // array `fb` ya lo pedía; el de IG no, así que quien conectaba por Instagram se
  // quedaba con Páginas que leen comentarios pero no pueden contestarlos.
  ig: ["instagram_basic", "instagram_manage_messages", "instagram_manage_comments", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "pages_manage_engagement", "pages_manage_metadata", "pages_messaging", "business_management", "instagram_manage_insights", "leads_retrieval", "pages_manage_ads"],
  fb: ["pages_show_list", "pages_read_engagement", "pages_manage_engagement", "pages_manage_metadata", "pages_messaging", "business_management", "leads_retrieval", "pages_manage_ads"],
  wa: ["whatsapp_business_messaging", "whatsapp_business_management", "business_management"],
  ads: ["ads_read", "ads_management", "pages_manage_ads", "business_management"],
};

export interface PageTokenDiag {
  name: string;
  pageId: string;
  scopes: string[];
  hasLeadsRetrieval: boolean;
  hasPagesManageAds: boolean;
  hasPagesReadEngagement: boolean;
  error?: string;
}

/** Inspecciona con debug_token el token de cada Página conectada y reporta sus scopes. */
export async function diagnosePageTokens(): Promise<{ appConfigured: boolean; requested: Record<string, string[]>; pages: PageTokenDiag[] }> {
  const appConfigured = metaAppLista();
  const pages = listFbAccounts();
  const out: PageTokenDiag[] = [];
  for (const p of pages) {
    let scopes: string[] = [];
    let error: string | undefined;
    if (!appConfigured) {
      error = "Falta meta.appId / meta.appSecret para inspeccionar el token.";
    } else {
      try {
        const r = await debugToken(p.token);
        const d: any = await r.json().catch(() => ({}));
        if (d?.data?.scopes) scopes = d.data.scopes as string[];
        else error = d?.error?.message || "Meta no devolvió scopes para este token.";
      } catch (e) {
        error = (e as Error).message;
      }
    }
    out.push({
      name: p.name || p.pageId,
      pageId: p.pageId,
      scopes,
      hasLeadsRetrieval: scopes.includes("leads_retrieval"),
      hasPagesManageAds: scopes.includes("pages_manage_ads"),
      hasPagesReadEngagement: scopes.includes("pages_read_engagement"),
      error,
    });
  }
  return { appConfigured, requested: META_OAUTH_SCOPES, pages: out };
}
