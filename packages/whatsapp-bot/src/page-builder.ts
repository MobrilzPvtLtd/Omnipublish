/**
 * Page builder: catálogo de templates + drafts de cliente.
 *
 * Cada template define:
 *  - id, label, kind ('checkout'|'landing'|'thank-you'|'lead-capture')
 *  - slots (campos editables visualmente: headline, sub, cta, color, logo…)
 *  - html: HTML completo con marcadores {{SLOT}}
 *
 * El cliente crea drafts personalizando slots → renderHtml = template.html con
 * sustitución. Para publicar: queueMcpJob('page-publish'), que sale por el
 * puente hacia **systemeio-mcp** → systeme.io. (MCP-DESTINO-1: aquí ponía
 * «leadmatch-mcp vía Claude API»; ni es el MCP del curso ni hay LLM en medio.)
 *
 * Fallback sin MCP: el panel ofrece copiar HTML / descargar para que el cliente
 * lo pegue manualmente en el editor systeme.io.
 */
import crypto from "node:crypto";
import * as pg from "pg";
import { pgSsl } from "./pg-ssl.js";
import { pageviewSnippet } from "./web-analytics.js";
import { currentWorkspaceId } from "./workspace.js";
import { quitarC2pa } from "./c2pa.js";

/** Inserta el píxel de analítica web antes de </body> (o al final si no hay). */
function injectPixel(html: string, id: string, label: string): string {
  const s = pageviewSnippet(id, label);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => s + "</body>") : html + s;
}

const dbUrl = process.env.DATABASE_URL;
const pool = dbUrl
  ? new pg.default.Pool({
      connectionString: dbUrl,
      ssl: pgSsl(),
      max: 2,
    })
  : null;

export interface SlotDef {
  key: string;
  label: string;
  kind: "text" | "textarea" | "url" | "color" | "image" | "select";
  default?: string;
  options?: string[]; // para kind=select
  placeholder?: string;
  help?: string;
}

export interface PageTemplate {
  id: string;
  label: string;
  kind: "checkout" | "landing" | "thank-you" | "lead-capture" | "course-cover";
  description: string;
  preview_url?: string;
  slots: SlotDef[];
  html: string;
  /**
   * La página la escribe el cliente entera y se publica TAL CUAL: nada de
   * post-proceso. Lo usa «Pegar HTML propio», cuya promesa literal es «lo que
   * pegues es lo que se publica».
   */
  talCual?: boolean;
}

/* ------------ TEMPLATES PREDEFINIDOS ------------ */

const COLORS_DEFAULT = {
  cream: "#FAF6F0",
  navy: "#1E3A5F",
  copper: "#AE5F45",
  copperLight: "#BC6E4C",
};

const FONTS_HEADER = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`;

const COMMON_CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:'Inter',system-ui,sans-serif;color:{{NAVY}};background:{{CREAM}};-webkit-font-smoothing:antialiased}
.wrap{max-width:980px;margin:0 auto;padding:48px 22px}
h1,h2,h3{font-family:'DM Sans',system-ui,sans-serif;font-weight:800;letter-spacing:-0.025em;line-height:1.15;color:{{NAVY}};margin:0}
h1{font-size:42px}h2{font-size:30px}h3{font-size:20px}
p{line-height:1.55;color:#5C6F87;margin:14px 0}
.btn{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,{{COPPER_LIGHT}},{{COPPER}});color:#fff;font-family:'DM Sans',system-ui,sans-serif;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:15px;transition:transform .12s,box-shadow .12s}
.btn:hover{transform:translateY(-2px);box-shadow:0 10px 24px -10px rgba(174,95,69,.4)}
.card{background:#fff;border-radius:18px;padding:32px;box-shadow:0 14px 36px rgba(30,58,95,.08);border:1px solid rgba(30,58,95,.06)}
.tag{display:inline-block;background:rgba(174,95,69,.12);color:{{COPPER}};font-family:'DM Sans',system-ui,sans-serif;font-weight:700;font-size:12px;letter-spacing:.06em;text-transform:uppercase;padding:7px 14px;border-radius:999px}
.bar{height:6px;background:{{COPPER}}}
.center{text-align:center}
@media(max-width:640px){h1{font-size:30px}h2{font-size:24px}.wrap{padding:32px 16px}}
`;

const TPL_LEAD_CAPTURE: PageTemplate = {
  id: "lead-capture-v1",
  label: "Captura de leads simple",
  kind: "lead-capture",
  description: "Página con un solo objetivo: capturar nombre + email. Formulario integrado en tu web.",
  slots: [
    { key: "TAG", label: "Etiqueta superior", kind: "text", default: "Acceso gratuito", placeholder: "Acceso gratuito" },
    { key: "HEADLINE", label: "Titular principal", kind: "text", default: "Aprende a duplicar tus ventas con WhatsApp en 30 días", placeholder: "Tu propuesta de valor en una frase" },
    { key: "SUB", label: "Subtítulo", kind: "textarea", default: "Te mando una guía PDF + 3 emails con los pasos exactos que aplican mis clientes para multiplicar conversaciones reales por WhatsApp.", placeholder: "Explica brevemente qué van a recibir" },
    { key: "CTA_LABEL", label: "Texto del botón", kind: "text", default: "Quiero la guía gratis", placeholder: "Quiero la guía" },
    { key: "CTA_URL", label: "Enlace al hacer clic (formulario integrado o página de gracias)", kind: "url", default: "#form", placeholder: "https://tu-web.com/gracias" },
    { key: "LOGO_URL", label: "URL del logo (cuadrado 1:1)", kind: "image", default: "", placeholder: "https://tu-web.com/logo.png" },
    { key: "BRAND_NAME", label: "Nombre de marca (pie)", kind: "text", default: "", placeholder: "tu-web.com" },
    { key: "COPPER", label: "Color de marca (acento)", kind: "color", default: "#AE5F45" },
    { key: "NAVY", label: "Color texto principal", kind: "color", default: "#1E3A5F" },
    { key: "CREAM", label: "Color de fondo", kind: "color", default: "#FAF6F0" },
    { key: "COPPER_LIGHT", label: "Acento claro (gradiente botón)", kind: "color", default: "#BC6E4C" },
  ],
  html: `<!doctype html><html lang=es><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>{{HEADLINE}}</title>
${FONTS_HEADER}
<style>${COMMON_CSS}
.hero{padding:80px 22px 60px;text-align:center}
.hero img{width:64px;height:64px;border-radius:14px;margin-bottom:18px;display:block;margin-left:auto;margin-right:auto;object-fit:contain;background:#fff;padding:6px}
.hero .tag{margin-bottom:24px}
.hero h1{font-size:48px;max-width:760px;margin:0 auto 22px}
.hero p{font-size:18px;max-width:600px;margin:0 auto 36px}
.foot{text-align:center;padding:32px 22px;color:#8693A4;font-size:13px}
@media(max-width:640px){.hero h1{font-size:32px}.hero p{font-size:16px}}
</style></head><body>
<div class=bar></div>
<div class=hero>
  <img src="{{LOGO_URL}}" alt="">
  <div class=tag>{{TAG}}</div>
  <h1>{{HEADLINE}}</h1>
  <p>{{SUB}}</p>
  <a class=btn href="{{CTA_URL}}">{{CTA_LABEL}}</a>
</div>
<p class=foot>{{BRAND_NAME}}</p>
</body></html>`,
};

const TPL_THANK_YOU: PageTemplate = {
  id: "thank-you-v1",
  label: "Página de gracias",
  kind: "thank-you",
  description: "Tras una compra o suscripción: confirma + dirige a la siguiente acción (correo, vídeo, descarga).",
  slots: [
    { key: "BADGE", label: "Insignia superior", kind: "text", default: "🎉 ¡Compra confirmada!" },
    { key: "HEADLINE", label: "Titular emocional", kind: "text", default: "Acabas de recuperar tus tardes" },
    { key: "SUB", label: "Subtítulo", kind: "textarea", default: "Te acabamos de enviar un email con el enlace de acceso. Ábrelo, pulsa el botón y sigue el vídeo." },
    { key: "STEP1", label: "Paso 1 — título", kind: "text", default: "Abre el correo que acabas de recibir." },
    { key: "STEP1_BODY", label: "Paso 1 — explicación", kind: "textarea", default: "En el mismo email con el que compraste — dentro tienes tu enlace." },
    { key: "STEP2", label: "Paso 2 — título", kind: "text", default: "Dale al play a la clase." },
    { key: "STEP2_BODY", label: "Paso 2 — explicación", kind: "textarea", default: "Un vídeo cortito que te lleva paso a paso. Al terminar ya estarás operativo." },
    { key: "LOGO_URL", label: "URL del logo", kind: "image", default: "", placeholder: "https://tu-web.com/logo.png" },
    { key: "SUPPORT_LINE", label: "Línea de soporte (footer)", kind: "textarea", default: "¿Te atascas en algo? Responde al correo de tu compra o escríbenos por tu canal de soporte." },
    { key: "BRAND_NAME", label: "Nombre marca", kind: "text", default: "", placeholder: "Tu nombre o tu marca" },
    { key: "COPPER", label: "Color acento", kind: "color", default: "#AE5F45" },
    { key: "NAVY", label: "Color texto", kind: "color", default: "#1E3A5F" },
    { key: "CREAM", label: "Color fondo cream", kind: "color", default: "#FAF6F0" },
    { key: "COPPER_LIGHT", label: "Acento claro botones", kind: "color", default: "#BC6E4C" },
  ],
  html: `<!doctype html><html lang=es><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>{{HEADLINE}}</title>
${FONTS_HEADER}
<style>${COMMON_CSS}
.hero{text-align:center;padding:56px 22px 40px}
.hero img{width:56px;height:56px;border-radius:12px;margin-bottom:14px}
.hero .tag{margin-bottom:22px}
.hero h1{margin-bottom:14px}
.hero p{font-size:18px;max-width:680px;margin:0 auto}
.inbox{max-width:680px;margin:24px auto 32px;padding:36px 28px}
.inbox-ic{width:88px;height:88px;border-radius:50%;background:{{COPPER}};margin:0 auto 18px;display:flex;align-items:center;justify-content:center}
.inbox-ic svg{width:42px;height:42px;stroke:#FAF6F0;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.steps{max-width:680px;margin:0 auto}
.step{display:flex;gap:16px;background:#fff;border:1px solid rgba(30,58,95,.08);border-radius:14px;padding:18px 20px;margin-bottom:14px;align-items:flex-start}
.step-n{flex:0 0 34px;width:34px;height:34px;border-radius:50%;background:{{COPPER}};color:#fff;font-family:'DM Sans',system-ui,sans-serif;font-weight:800;display:flex;align-items:center;justify-content:center}
.foot{background:{{NAVY}};color:#FAF6F0;padding:32px 22px;text-align:center}
.foot b{color:#fff}
</style></head><body>
<div class=bar></div>
<div class=hero>
  <img src="{{LOGO_URL}}" alt="">
  <div class=tag>{{BADGE}}</div>
  <h1>{{HEADLINE}}</h1>
  <p>{{SUB}}</p>
</div>
<div class="card inbox center">
  <div class=inbox-ic><svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="m2.5 6.5 9.5 6.5 9.5-6.5"/></svg></div>
  <h3>Tu acceso está en tu correo</h3>
  <p style="font-size:15px">Te acabamos de enviar el email con tu acceso. Sigue los pasos abajo.</p>
</div>
<div class=wrap>
<h2 class=center style="margin-bottom:28px">Solo dos pasos para arrancar</h2>
<div class=steps>
  <div class=step><div class=step-n>1</div><div><b>{{STEP1}}</b><p style="margin:4px 0 0">{{STEP1_BODY}}</p></div></div>
  <div class=step><div class=step-n>2</div><div><b>{{STEP2}}</b><p style="margin:4px 0 0">{{STEP2_BODY}}</p></div></div>
</div>
</div>
<div class=foot>
  <p style="max-width:560px;margin:0 auto 16px;color:#D7E0EA">{{SUPPORT_LINE}}</p>
  <p>Nos vemos dentro,<br><b>{{BRAND_NAME}}</b></p>
</div>
</body></html>`,
};

const TPL_CHECKOUT: PageTemplate = {
  id: "checkout-v1",
  label: "Página de venta", // REVISION-PREMIUM-2 · «Checkout» es jerga en inglés
  kind: "checkout",
  description: "Página de venta con precio tachado, beneficio y botón de pago.",
  slots: [
    { key: "EYEBROW", label: "Línea superior", kind: "text", default: "Oferta de lanzamiento · Acceso inmediato" },
    { key: "HEADLINE", label: "Titular principal", kind: "text", default: "Piloto Automático de Redes con Claude" },
    { key: "SUB", label: "Subtítulo", kind: "textarea", default: "Crea y publica carruseles en 10+ redes, 24/7. Sin mover un dedo." },
    { key: "BENEFIT1", label: "Beneficio 1", kind: "text", default: "Claude crea el contenido por ti" },
    { key: "BENEFIT2", label: "Beneficio 2", kind: "text", default: "Publicas en todas las redes con una orden" },
    { key: "BENEFIT3", label: "Beneficio 3", kind: "text", default: "Funciona en piloto automático 24/7" },
    { key: "PRICE_OLD", label: "Precio tachado", kind: "text", default: "$135" },
    { key: "PRICE_NEW", label: "Precio final", kind: "text", default: "$77.97" },
    { key: "CTA_LABEL", label: "Texto botón compra", kind: "text", default: "Acceso inmediato" },
    { key: "CTA_URL", label: "URL del pago (Stripe, PayPal o el checkout de tu web)", kind: "url", default: "https://..." },
    { key: "LOGO_URL", label: "URL del logo", kind: "image", default: "", placeholder: "https://tu-web.com/logo.png" },
    { key: "BRAND_NAME", label: "Nombre marca", kind: "text", default: "", placeholder: "tu-web.com" },
    { key: "COPPER", label: "Color acento", kind: "color", default: "#AE5F45" },
    { key: "NAVY", label: "Color texto", kind: "color", default: "#1E3A5F" },
    { key: "CREAM", label: "Color fondo", kind: "color", default: "#FAF6F0" },
    { key: "COPPER_LIGHT", label: "Acento claro botones", kind: "color", default: "#BC6E4C" },
  ],
  html: `<!doctype html><html lang=es><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>{{HEADLINE}}</title>
${FONTS_HEADER}
<style>${COMMON_CSS}
.hero{padding:60px 22px 50px;text-align:center}
.hero img{width:64px;height:64px;border-radius:14px;background:#fff;padding:6px;margin:0 auto 18px;display:block}
.hero .eye{font-family:'DM Sans',system-ui,sans-serif;font-style:italic;font-weight:600;color:{{COPPER}};font-size:14px;margin-bottom:14px}
.hero h1{max-width:760px;margin:0 auto 22px}
.hero p{font-size:18px;max-width:600px;margin:0 auto 36px}
.benefits{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;max-width:840px;margin:0 auto 40px;padding:0 22px}
.benefit{background:#fff;border-radius:14px;padding:22px 20px;border:1px solid rgba(30,58,95,.06);text-align:left}
.benefit svg{width:18px;height:18px;color:{{COPPER}};stroke:currentColor;fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;vertical-align:-3px;margin-right:6px}
.pricing{max-width:520px;margin:0 auto;background:#fff;border-radius:18px;padding:32px;text-align:center;box-shadow:0 14px 36px rgba(30,58,95,.08)}
.price-old{font-size:18px;color:#8693A4;text-decoration:line-through;margin-right:8px;font-family:'DM Sans',system-ui,sans-serif}
.price-new{font-size:46px;font-family:'DM Sans',system-ui,sans-serif;font-weight:800;color:{{NAVY}};letter-spacing:-0.03em}
.btn-big{margin-top:22px;padding:16px 36px;font-size:16px}
.foot{text-align:center;padding:32px 22px;color:#8693A4;font-size:13px}
</style></head><body>
<div class=bar></div>
<div class=hero>
  <img src="{{LOGO_URL}}" alt="">
  <div class=eye>{{EYEBROW}}</div>
  <h1>{{HEADLINE}}</h1>
  <p>{{SUB}}</p>
</div>
<div class=benefits>
  <div class=benefit><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><b>{{BENEFIT1}}</b></div>
  <div class=benefit><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><b>{{BENEFIT2}}</b></div>
  <div class=benefit><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><b>{{BENEFIT3}}</b></div>
</div>
<div class=pricing>
  <p style="margin:0 0 16px;color:#5C6F87">Acceso inmediato</p>
  <div><span class=price-old>{{PRICE_OLD}}</span><span class=price-new>{{PRICE_NEW}}</span></div>
  <a class="btn btn-big" href="{{CTA_URL}}">{{CTA_LABEL}}</a>
  <p style="margin:18px 0 0;color:#8693A4;font-size:12.5px">Pago seguro · Acceso de por vida</p>
</div>
<p class=foot>{{BRAND_NAME}}</p>
</body></html>`,
};

const TPL_HTML_PASTE: PageTemplate = {
  id: "html-paste-v1",
  label: "Pegar HTML propio",
  kind: "landing",
  description: "Pega una página completa que ya tengas hecha (exportada de otro editor o entregada por un diseñador). Se publica tal cual en tu web, sin tocar textos ni colores.",
  slots: [
    {
      key: "HTML",
      label: "HTML completo de la página",
      kind: "textarea",
      help: "Pega aquí todo el HTML — desde <!doctype html> hasta </html>. Soporta CSS embedded, fonts de Google, SVG inline. Lo que pegues es lo que se publica.",
      placeholder: "<!doctype html><html lang=es>...</html>",
      default: `<!doctype html><html lang=es><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Mi página</title>
<style>
  body{margin:0;font-family:'Inter',system-ui,sans-serif;background:#FAF6F0;color:#1E3A5F;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
  .wrap{max-width:640px;padding:40px 22px}
  h1{font-size:42px;font-weight:800;margin:0 0 18px;letter-spacing:-.02em}
  p{font-size:18px;line-height:1.55;color:#5C6F87}
  .btn{display:inline-block;margin-top:24px;background:#AE5F45;color:#fff;padding:14px 32px;border-radius:8px;font-weight:700;text-decoration:none}
</style></head><body>
<div class=wrap>
  <h1>Pega aquí tu HTML</h1>
  <p>Este es el placeholder. Sustituye TODO el contenido por el HTML que quieres publicar y dale a Publicar.</p>
  <a class=btn href="#">Llamada a la acción</a>
</div>
</body></html>`,
    },
  ],
  html: `{{HTML}}`,
  talCual: true,
};

const TPL_WEBINAR: PageTemplate = {
  id: "webinar-vsl-v1",
  label: "Webinar / vídeo de venta",
  kind: "landing",
  description: "Registro a clase en directo o página de vídeo-venta: vídeo integrado, qué aprenderás, botón de reserva y bio del presentador.",
  slots: [
    { key: "TAG", label: "Etiqueta superior", kind: "text", default: "Clase gratuita en directo" },
    { key: "HEADLINE", label: "Titular principal", kind: "text", default: "Cómo montar tu sistema de captación con IA en 7 días" },
    { key: "SUB", label: "Subtítulo", kind: "textarea", default: "Sin equipo, sin saber programar y sin pagar anuncios hasta que el sistema esté validado. Te lo enseño en directo, paso a paso." },
    { key: "VIDEO_EMBED_URL", label: "URL embed del vídeo (YouTube/Vimeo)", kind: "url", default: "https://www.youtube.com/embed/dQw4w9WgXcQ", help: "Usa la URL de embed (youtube.com/embed/ID o player.vimeo.com/video/ID). Déjala vacía para ocultar el vídeo." },
    { key: "DATE_LINE", label: "Fecha / disponibilidad", kind: "text", default: "Jueves 20:00h (Madrid) · Plazas limitadas" },
    { key: "BULLET1", label: "Aprenderás — punto 1", kind: "text", default: "El stack exacto: WhatsApp + IA + funnels, sin herramientas de pago" },
    { key: "BULLET2", label: "Aprenderás — punto 2", kind: "text", default: "Cómo convertir conversaciones en clientes en piloto automático" },
    { key: "BULLET3", label: "Aprenderás — punto 3", kind: "text", default: "El error #1 que mata la conversión (y cómo evitarlo)" },
    { key: "CTA_LABEL", label: "Texto del botón", kind: "text", default: "Reservar mi plaza gratis" },
    { key: "CTA_URL", label: "URL del botón (form/registro)", kind: "url", default: "#registro" },
    { key: "HOST_NAME", label: "Nombre del presentador", kind: "text", default: "", placeholder: "Quién da el webinar" },
    { key: "HOST_ROLE", label: "Rol / credencial", kind: "text", default: "", placeholder: "Tu cargo o credencial" },
    { key: "HOST_AVATAR_URL", label: "Foto del presentador (cuadrada)", kind: "image", default: "", placeholder: "https://tu-web.com/logo.png" },
    { key: "LOGO_URL", label: "URL del logo", kind: "image", default: "", placeholder: "https://tu-web.com/logo.png" },
    { key: "BRAND_NAME", label: "Nombre marca (pie)", kind: "text", default: "", placeholder: "tu-web.com" },
    { key: "COPPER", label: "Color acento", kind: "color", default: "#AE5F45" },
    { key: "NAVY", label: "Color texto", kind: "color", default: "#1E3A5F" },
    { key: "CREAM", label: "Color fondo", kind: "color", default: "#FAF6F0" },
    { key: "COPPER_LIGHT", label: "Acento claro botones", kind: "color", default: "#BC6E4C" },
  ],
  html: `<!doctype html><html lang=es><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>{{HEADLINE}}</title>
${FONTS_HEADER}
<style>${COMMON_CSS}
.hero{padding:64px 22px 30px;text-align:center}
.hero img.logo{width:56px;height:56px;border-radius:12px;background:#fff;padding:5px;margin:0 auto 16px;display:block;object-fit:contain}
.hero .tag{margin-bottom:20px}
.hero h1{max-width:780px;margin:0 auto 18px;font-size:44px}
.hero p{font-size:18px;max-width:640px;margin:0 auto}
.vwrap{max-width:860px;margin:34px auto 0;padding:0 22px}
.vframe{position:relative;padding-top:56.25%;border-radius:18px;overflow:hidden;box-shadow:0 24px 60px -18px rgba(30,58,95,.35);background:#000}
.vframe iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.dateline{display:inline-flex;align-items:center;gap:8px;margin:26px auto 0;background:#fff;border:1px solid rgba(30,58,95,.1);border-radius:999px;padding:10px 22px;font-family:'DM Sans',system-ui,sans-serif;font-weight:700;font-size:14px;color:{{COPPER}}}
.learn{max-width:680px;margin:46px auto 0;padding:0 22px}
.learn h2{text-align:center;margin-bottom:22px}
.bullet{display:flex;gap:14px;background:#fff;border:1px solid rgba(30,58,95,.08);border-radius:14px;padding:18px 20px;margin-bottom:12px;align-items:flex-start}
.bullet svg{flex:none;width:22px;height:22px;color:{{COPPER}};stroke:currentColor;fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;margin-top:1px}
.ctaband{text-align:center;padding:44px 22px 10px}
.host{display:flex;gap:18px;align-items:center;max-width:560px;margin:52px auto 0;padding:24px 26px;background:#fff;border-radius:18px;border:1px solid rgba(30,58,95,.08)}
.host img{width:72px;height:72px;border-radius:50%;object-fit:cover;flex:none}
.host b{font-family:'DM Sans',system-ui,sans-serif;font-size:17px}
.host span{display:block;color:#5C6F87;font-size:13.5px;margin-top:3px}
.foot{text-align:center;padding:40px 22px;color:#8693A4;font-size:13px}
@media(max-width:640px){.hero h1{font-size:31px}.hero p{font-size:16px}.host{flex-direction:column;text-align:center}}
</style></head><body>
<div class=bar></div>
<div class=hero>
  <img class=logo src="{{LOGO_URL}}" alt="">
  <div class=tag>{{TAG}}</div>
  <h1>{{HEADLINE}}</h1>
  <p>{{SUB}}</p>
  <div class=vwrap><div class=vframe><iframe src="{{VIDEO_EMBED_URL}}" title="Vídeo" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen loading=lazy></iframe></div></div>
  <div class=dateline>📅 {{DATE_LINE}}</div>
</div>
<div class=learn>
  <h2>En esta clase aprenderás</h2>
  <div class=bullet><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><b>{{BULLET1}}</b></div>
  <div class=bullet><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><b>{{BULLET2}}</b></div>
  <div class=bullet><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><b>{{BULLET3}}</b></div>
</div>
<div class=ctaband><a class="btn" style="padding:16px 38px;font-size:16px" href="{{CTA_URL}}">{{CTA_LABEL}}</a><p style="font-size:12.5px;color:#8693A4;margin-top:14px">Gratis · Sin tarjeta · Aforo limitado</p></div>
<div class=host><img src="{{HOST_AVATAR_URL}}" alt=""><div><b>{{HOST_NAME}}</b><span>{{HOST_ROLE}}</span></div></div>
<p class=foot>{{BRAND_NAME}}</p>
</body></html>`,
};

const TPL_SERVICES: PageTemplate = {
  id: "services-v1",
  label: "Página de servicios",
  kind: "landing",
  description: "Presenta hasta 3 servicios con precio, tu proceso de trabajo en 3 pasos y un botón de contacto directo.",
  slots: [
    { key: "TAG", label: "Etiqueta superior", kind: "text", default: "Servicios" },
    { key: "HEADLINE", label: "Titular principal", kind: "text", default: "Automatiza tu negocio. Yo me encargo de la parte técnica." },
    { key: "SUB", label: "Subtítulo", kind: "textarea", default: "Sistemas de captación, bots de WhatsApp y funnels que venden mientras tú trabajas en lo importante." },
    { key: "SVC1_T", label: "Servicio 1 — título", kind: "text", default: "Bot de WhatsApp con IA" },
    { key: "SVC1_D", label: "Servicio 1 — descripción", kind: "textarea", default: "Atiende, cualifica y agenda por ti, 24/7. Entrenado con tu negocio." },
    { key: "SVC1_P", label: "Servicio 1 — precio", kind: "text", default: "desde 490€" },
    { key: "SVC2_T", label: "Servicio 2 — título", kind: "text", default: "Funnel de venta completo" },
    { key: "SVC2_D", label: "Servicio 2 — descripción", kind: "textarea", default: "Landing + emails + checkout, listo para recibir tráfico en 7 días." },
    { key: "SVC2_P", label: "Servicio 2 — precio", kind: "text", default: "desde 790€" },
    { key: "SVC3_T", label: "Servicio 3 — título", kind: "text", default: "Sistema de captación llave en mano" },
    { key: "SVC3_D", label: "Servicio 3 — descripción", kind: "textarea", default: "Leads cualificados cada semana con IA + automatización multicanal." },
    { key: "SVC3_P", label: "Servicio 3 — precio", kind: "text", default: "a medida" },
    { key: "STEP1", label: "Proceso — paso 1", kind: "text", default: "Llamada de diagnóstico (30 min, gratis)" },
    { key: "STEP2", label: "Proceso — paso 2", kind: "text", default: "Propuesta cerrada: alcance, plazo y precio" },
    { key: "STEP3", label: "Proceso — paso 3", kind: "text", default: "Entrega funcionando + 30 días de soporte" },
    { key: "CTA_LABEL", label: "Texto del botón", kind: "text", default: "Agendar llamada gratis" },
    { key: "CTA_URL", label: "URL del botón (WhatsApp/calendario)", kind: "url", default: "https://wa.me/34600000000" },
    { key: "LOGO_URL", label: "URL del logo", kind: "image", default: "", placeholder: "https://tu-web.com/logo.png" },
    { key: "BRAND_NAME", label: "Nombre marca (pie)", kind: "text", default: "", placeholder: "tu-web.com" },
    { key: "COPPER", label: "Color acento", kind: "color", default: "#AE5F45" },
    { key: "NAVY", label: "Color texto", kind: "color", default: "#1E3A5F" },
    { key: "CREAM", label: "Color fondo", kind: "color", default: "#FAF6F0" },
    { key: "COPPER_LIGHT", label: "Acento claro botones", kind: "color", default: "#BC6E4C" },
  ],
  html: `<!doctype html><html lang=es><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>{{HEADLINE}}</title>
${FONTS_HEADER}
<style>${COMMON_CSS}
.hero{padding:64px 22px 46px;text-align:center}
.hero img{width:56px;height:56px;border-radius:12px;background:#fff;padding:5px;margin:0 auto 16px;display:block;object-fit:contain}
.hero .tag{margin-bottom:20px}
.hero h1{max-width:740px;margin:0 auto 18px}
.hero p{font-size:18px;max-width:600px;margin:0 auto}
.svcs{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;max-width:960px;margin:0 auto;padding:0 22px}
.svc{background:#fff;border-radius:18px;padding:28px 24px;border:1px solid rgba(30,58,95,.07);box-shadow:0 10px 30px -16px rgba(30,58,95,.14);display:flex;flex-direction:column}
.svc h3{margin-bottom:10px}
.svc p{margin:0 0 18px;font-size:14.5px;flex:1}
.svc .price{font-family:'DM Sans',system-ui,sans-serif;font-weight:800;color:{{COPPER}};font-size:19px}
.proc{max-width:680px;margin:60px auto 0;padding:0 22px}
.proc h2{text-align:center;margin-bottom:24px}
.pstep{display:flex;gap:16px;align-items:flex-start;background:#fff;border:1px solid rgba(30,58,95,.08);border-radius:14px;padding:18px 20px;margin-bottom:12px}
.pstep .n{flex:0 0 34px;width:34px;height:34px;border-radius:50%;background:{{COPPER}};color:#fff;font-family:'DM Sans',system-ui,sans-serif;font-weight:800;display:flex;align-items:center;justify-content:center}
.pstep b{padding-top:6px;display:block}
.ctaband{background:{{NAVY}};margin-top:64px;padding:52px 22px;text-align:center}
.ctaband h2{color:#FAF6F0;margin-bottom:22px}
.foot{text-align:center;padding:34px 22px;color:#8693A4;font-size:13px}
@media(max-width:640px){.hero h1{font-size:30px}}
</style></head><body>
<div class=bar></div>
<div class=hero>
  <img src="{{LOGO_URL}}" alt="">
  <div class=tag>{{TAG}}</div>
  <h1>{{HEADLINE}}</h1>
  <p>{{SUB}}</p>
</div>
<div class=svcs>
  <div class=svc><h3>{{SVC1_T}}</h3><p>{{SVC1_D}}</p><span class=price>{{SVC1_P}}</span></div>
  <div class=svc><h3>{{SVC2_T}}</h3><p>{{SVC2_D}}</p><span class=price>{{SVC2_P}}</span></div>
  <div class=svc><h3>{{SVC3_T}}</h3><p>{{SVC3_D}}</p><span class=price>{{SVC3_P}}</span></div>
</div>
<div class=proc>
  <h2>Cómo trabajamos</h2>
  <div class=pstep><span class=n>1</span><b>{{STEP1}}</b></div>
  <div class=pstep><span class=n>2</span><b>{{STEP2}}</b></div>
  <div class=pstep><span class=n>3</span><b>{{STEP3}}</b></div>
</div>
<div class=ctaband><h2>¿Hablamos de tu caso?</h2><a class="btn" style="padding:16px 36px;font-size:16px" href="{{CTA_URL}}">{{CTA_LABEL}}</a></div>
<p class=foot>{{BRAND_NAME}}</p>
</body></html>`,
};

const TPL_LINKBIO: PageTemplate = {
  id: "linkbio-v1",
  label: "Página de enlaces",
  kind: "landing",
  description: "Tu página de enlaces para Instagram/TikTok: avatar, bio y hasta 4 botones con tu marca.",
  slots: [
    // SIN-DEFAULTS-LM-1 · NINGÚN dato de fábrica en la página de un cliente. Aquí
    // vivían la foto, el nombre y la bio del operador, y —lo peor— el primer botón,
    // el destacado, apuntaba a la web de venta del curso LeadMatch. Un cliente que
    // publicaba su página de enlaces sin editarla mandaba a sus seguidores al
    // checkout de otro negocio desde su propio dominio. Los ejemplos van como
    // `placeholder` (se ven en gris, no se publican), nunca como `default`.
    { key: "AVATAR_URL", label: "Foto / avatar (cuadrada)", kind: "image", default: "", placeholder: "https://tu-web.com/tu-foto.jpg" },
    { key: "NAME", label: "Nombre", kind: "text", default: "", placeholder: "Tu nombre o el de tu negocio" },
    { key: "BIO", label: "Bio corta", kind: "textarea", default: "", placeholder: "Qué haces y para quién, en una frase" },
    { key: "LINK1_LABEL", label: "Enlace 1 — texto", kind: "text", default: "", placeholder: "🌐 Mi web" },
    { key: "LINK1_URL", label: "Enlace 1 — URL", kind: "url", default: "", placeholder: "https://tu-web.com" },
    { key: "LINK2_LABEL", label: "Enlace 2 — texto", kind: "text", default: "", placeholder: "💬 Escríbeme por WhatsApp" },
    { key: "LINK2_URL", label: "Enlace 2 — URL", kind: "url", default: "", placeholder: "https://wa.me/34600000000" },
    { key: "LINK3_LABEL", label: "Enlace 3 — texto", kind: "text", default: "", placeholder: "📅 Agenda una llamada" },
    { key: "LINK3_URL", label: "Enlace 3 — URL", kind: "url", default: "", placeholder: "https://tu-web.com/agenda" },
    { key: "LINK4_LABEL", label: "Enlace 4 — texto", kind: "text", default: "", placeholder: "📩 Newsletter" },
    { key: "LINK4_URL", label: "Enlace 4 — URL", kind: "url", default: "", placeholder: "https://tu-web.com/newsletter" },
    { key: "BRAND_NAME", label: "Pie de página", kind: "text", default: "", placeholder: "tu-web.com" },
    { key: "COPPER", label: "Color acento", kind: "color", default: "#AE5F45" },
    { key: "NAVY", label: "Color texto", kind: "color", default: "#1E3A5F" },
    { key: "CREAM", label: "Color fondo", kind: "color", default: "#FAF6F0" },
    { key: "COPPER_LIGHT", label: "Acento claro botones", kind: "color", default: "#BC6E4C" },
  ],
  html: `<!doctype html><html lang=es><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>{{NAME}}</title>
${FONTS_HEADER}
<style>${COMMON_CSS}
body{background:linear-gradient(170deg,{{CREAM}} 0%,#fff 55%,{{CREAM}} 100%);min-height:100vh}
.bio-wrap{max-width:480px;margin:0 auto;padding:64px 22px 40px;text-align:center}
.bio-wrap img.avatar{width:104px;height:104px;border-radius:50%;object-fit:cover;border:4px solid #fff;box-shadow:0 14px 36px -10px rgba(30,58,95,.28);margin-bottom:18px}
.bio-wrap h1{font-size:26px;margin-bottom:10px}
.bio-wrap .bio{font-size:15px;max-width:380px;margin:0 auto 32px}
.blink{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;background:#fff;border:1.5px solid rgba(30,58,95,.1);border-radius:14px;padding:17px 20px;margin-bottom:13px;font-family:'DM Sans',system-ui,sans-serif;font-weight:700;font-size:15px;color:{{NAVY}};text-decoration:none;transition:transform .14s,box-shadow .14s,border-color .14s;box-shadow:0 3px 14px -8px rgba(30,58,95,.18)}
.blink:hover{transform:translateY(-2px);border-color:{{COPPER}};box-shadow:0 14px 30px -12px rgba(174,95,69,.35)}
.blink.primary{background:linear-gradient(135deg,{{COPPER_LIGHT}},{{COPPER}});color:#fff;border-color:transparent}
.foot{color:#8693A4;font-size:12.5px;margin-top:30px}
</style></head><body>
<div class=bar></div>
<div class=bio-wrap>
  <img class=avatar src="{{AVATAR_URL}}" alt="{{NAME}}">
  <h1>{{NAME}}</h1>
  <p class=bio>{{BIO}}</p>
  <a class="blink primary" href="{{LINK1_URL}}">{{LINK1_LABEL}}</a>
  <a class=blink href="{{LINK2_URL}}">{{LINK2_LABEL}}</a>
  <a class=blink href="{{LINK3_URL}}">{{LINK3_LABEL}}</a>
  <a class=blink href="{{LINK4_URL}}">{{LINK4_LABEL}}</a>
  <p class=foot>{{BRAND_NAME}}</p>
</div>
</body></html>`,
};

export const PAGE_TEMPLATES: PageTemplate[] = [TPL_HTML_PASTE, TPL_LEAD_CAPTURE, TPL_THANK_YOU, TPL_CHECKOUT, TPL_WEBINAR, TPL_SERVICES, TPL_LINKBIO];

/* ------------ RENDERING ------------ */

/** Sustituye `{{SLOT}}` en el HTML del template con los valores del draft. */
export function renderTemplate(template: PageTemplate, data: Record<string, string>): string {
  let html = template.html;
  const merged: Record<string, string> = {};
  for (const slot of template.slots) merged[slot.key] = (data[slot.key] !== undefined ? data[slot.key] : slot.default ?? "");
  // colores fallback si faltan
  if (!merged.NAVY) merged.NAVY = COLORS_DEFAULT.navy;
  if (!merged.COPPER) merged.COPPER = COLORS_DEFAULT.copper;
  if (!merged.CREAM) merged.CREAM = COLORS_DEFAULT.cream;
  if (!merged.COPPER_LIGHT) merged.COPPER_LIGHT = COLORS_DEFAULT.copperLight;

  html = html.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => merged[key] ?? "");

  // SIN-DEFAULTS-LM-1 · Los valores de fábrica eran del operador (su logo, su web,
  // su bio), así que se han vaciado. Pero el HTML de las plantillas pinta las
  // etiquetas sin condicional, y un hueco vacío deja basura visible en la página
  // que el cliente publica: una imagen rota con su marco, o un botón sin texto que
  // no lleva a ninguna parte. Se limpian aquí, después de sustituir, para no tener
  // que meter lógica en siete plantillas.
  //
  // OJO · Solo sobre plantillas NUESTRAS. En «Pegar HTML propio» la página entera
  // es del cliente, y estas dos expresiones se la destrozarían: una imagen con
  // carga diferida (`<img src="" data-src="…">`, patrón corriente al exportar de
  // otro editor) desaparecería, y un `<a href="" onclick="…">` se llevaría por
  // delante todo lo que envuelve. Esa plantilla promete por escrito que lo que
  // pegas es lo que se publica.
  if (!template.talCual) {
    html = html
      // <img> sin origen: el navegador lo resolvería contra la propia página y
      // pintaría el icono de imagen rota con el tamaño fijo del CSS.
      .replace(/<img\b[^>]*\bsrc=""[^>]*>/gi, "")
      // Botón de enlace sin destino, con o sin texto.
      .replace(/<a\b[^>]*\bhref=""[^>]*>[\s\S]*?<\/a>/gi, "");
  }
  return html;
}

/* ------------ DRAFTS PERSISTENCE ------------ */

export interface PageDraft {
  id: string;
  tenant_id: string;
  template_id: string;
  label: string;
  data: Record<string, string>;
  rendered_html: string;
  target_platform: string; // 'systemeio' | 'leadmatch-lab' | 'standalone'
  target_funnel_id: string;
  target_step_id: string;
  target_page_id: string;
  status: "draft" | "queued" | "publishing" | "published" | "error";
  published_url: string;
  published_at: number | null;
  updated_at: number;
}

const memDrafts = new Map<string, PageDraft>();

export async function listDrafts(): Promise<PageDraft[]> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    return [...memDrafts.values()]
      .filter((d) => (d.tenant_id || "default") === tenantId)
      .sort((a, b) => b.updated_at - a.updated_at);
  }
  const r = await pool.query(
    `SELECT id,tenant_id,template_id,label,data,rendered_html,target_platform,target_funnel_id,target_step_id,target_page_id,status,published_url,
       extract(epoch from published_at)*1000 published_at,
       extract(epoch from updated_at)*1000 updated_at
     FROM app_page_drafts WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 200`,
    [tenantId],
  );
  return r.rows.map((x: any) => ({
    id: x.id, tenant_id: x.tenant_id, template_id: x.template_id, label: x.label,
    data: x.data ?? {}, rendered_html: x.rendered_html ?? "",
    target_platform: x.target_platform, target_funnel_id: x.target_funnel_id, target_step_id: x.target_step_id, target_page_id: x.target_page_id,
    status: x.status, published_url: x.published_url ?? "",
    published_at: x.published_at ? Number(x.published_at) : null,
    updated_at: Number(x.updated_at),
  }));
}

export async function getDraft(id: string): Promise<PageDraft | null> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const d = memDrafts.get(id);
    if (!d) return null;
    return (d.tenant_id || "default") === tenantId ? d : null;
  }
  const r = await pool.query(
    `SELECT id,tenant_id,template_id,label,data,rendered_html,target_platform,target_funnel_id,target_step_id,target_page_id,status,published_url,
       extract(epoch from published_at)*1000 published_at,
       extract(epoch from updated_at)*1000 updated_at
     FROM app_page_drafts WHERE id=$1 AND tenant_id=$2`,
    [id, tenantId],
  );
  if (!r.rows[0]) return null;
  const x: any = r.rows[0];
  return {
    id: x.id, tenant_id: x.tenant_id, template_id: x.template_id, label: x.label,
    data: x.data ?? {}, rendered_html: x.rendered_html ?? "",
    target_platform: x.target_platform, target_funnel_id: x.target_funnel_id, target_step_id: x.target_step_id, target_page_id: x.target_page_id,
    status: x.status, published_url: x.published_url ?? "",
    published_at: x.published_at ? Number(x.published_at) : null,
    updated_at: Number(x.updated_at),
  };
}

export interface SaveDraftInput {
  id?: string;
  tenant_id?: string;
  template_id: string;
  label: string;
  data: Record<string, string>;
  target_platform?: string;
  target_funnel_id?: string;
  target_step_id?: string;
  target_page_id?: string;
}

export async function saveDraft(input: SaveDraftInput): Promise<PageDraft> {
  const template = PAGE_TEMPLATES.find((t) => t.id === input.template_id);
  if (!template) throw new Error("Template no encontrado: " + input.template_id);
  let id = input.id || crypto.randomUUID();
  const label = input.label || template.label;
  const draftTenant = input.tenant_id ?? currentWorkspaceId();
  // SECURITY-FIX 2026-06-20 · evita el secuestro cross-tenant via ON CONFLICT(id):
  // un miembro de WS-B podía sobrescribir el draft de WS-A pasando body.id=<UUID de A>
  // (PK = id sola). Si el id propuesto ya existe bajo OTRO tenant, lo tratamos como
  // draft NUEVO (UUID fresco) en vez de tocar la fila ajena. El WHERE del DO UPDATE
  // (abajo) es la segunda barrera por si este pre-check fallara.
  if (input.id) {
    if (pool) {
      try {
        const owner = await pool.query("SELECT tenant_id FROM app_page_drafts WHERE id=$1", [id]);
        if (owner.rows[0] && owner.rows[0].tenant_id !== draftTenant) id = crypto.randomUUID();
      } catch { /* si el pre-check falla, el WHERE del upsert impide el overwrite */ }
    } else {
      const prev = memDrafts.get(id);
      if (prev && (prev.tenant_id || "default") !== draftTenant) id = crypto.randomUUID();
    }
  }
  // El HTML lleva el píxel de analítica web embebido (se mide aunque la página
  // viva en systeme.io). Idempotente: no se duplica si ya estaba.
  const rendered = renderTemplate(template, input.data);
  // 0) Counter-resets canon vs estilos heredados de Systeme.io (requerido por el
  //    gate ANTI_SYSTEMEIO_RESETS del MCP al publicar vía replace-page-html).
  const withResets = injectSystemeioResets(rendered);
  // 1) Inyectamos SEO si el draft lo trae (meta title/description/og:*/favicon).
  const withSeo = injectSeo(withResets, (input.data as Record<string, unknown>).seo as SeoConfig | undefined);
  // 1.bis) CSS / JS / HTML propios del usuario (sección "Código a medida").
  const cd = input.data as Record<string, unknown>;
  const withCustom = injectCustomCode(
    withSeo,
    cd.__custom_css as string | undefined,
    cd.__custom_js as string | undefined,
    cd.__custom_html as string | undefined,
  );
  // 2) Píxel de analítica (idempotente). El guard mira withSeo (HTML de la
  //    plantilla, no el código a medida del usuario) para que un __custom_*
  //    que contenga "/pv?p=" no suprima el píxel real.
  const html = withSeo.includes("/pv?p=") ? withCustom : injectPixel(withCustom, id, label);
  const draft: PageDraft = {
    id,
    tenant_id: draftTenant,
    template_id: input.template_id,
    label,
    data: input.data,
    rendered_html: html,
    target_platform: input.target_platform ?? "systemeio",
    target_funnel_id: input.target_funnel_id ?? "",
    target_step_id: input.target_step_id ?? "",
    target_page_id: input.target_page_id ?? "",
    status: "draft",
    published_url: "",
    published_at: null,
    updated_at: Date.now(),
  };
  if (!pool) {
    memDrafts.set(id, draft);
    return draft;
  }
  await pool.query(
    `INSERT INTO app_page_drafts
      (id,tenant_id,template_id,label,data,rendered_html,target_platform,target_funnel_id,target_step_id,target_page_id,status,published_url,published_at,updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,NULL,now())
     ON CONFLICT (id) DO UPDATE SET
       template_id=EXCLUDED.template_id,label=EXCLUDED.label,data=EXCLUDED.data,rendered_html=EXCLUDED.rendered_html,
       target_platform=EXCLUDED.target_platform,target_funnel_id=EXCLUDED.target_funnel_id,
       target_step_id=EXCLUDED.target_step_id,target_page_id=EXCLUDED.target_page_id,
       status=EXCLUDED.status,updated_at=now()
     WHERE app_page_drafts.tenant_id = EXCLUDED.tenant_id`,
    [
      draft.id, draft.tenant_id, draft.template_id, draft.label,
      JSON.stringify(draft.data), draft.rendered_html,
      draft.target_platform, draft.target_funnel_id, draft.target_step_id, draft.target_page_id,
      draft.status, draft.published_url,
    ],
  );
  return draft;
}

export async function deleteDraft(id: string): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const d = memDrafts.get(id);
    if (d && (d.tenant_id || "default") === tenantId) memDrafts.delete(id);
    return;
  }
  await pool.query("DELETE FROM app_page_drafts WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
}

/* ============================================================
 * Assets de páginas: imágenes (u otros archivos) adjuntos en el editor.
 * Almacenados en BD como BYTEA + servidos públicamente vía /a/:id con
 * UUID inguessable (no requiere auth — sino la URL no servría dentro
 * del HTML publicado a leadmatch-lab / systeme.io).
 * ============================================================ */
export interface PageAsset {
  id: string;
  draft_id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  created_at: number;
}

const memAssets = new Map<string, PageAsset & { data: Buffer; tenant_id?: string }>();
const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp",
  "image/gif", "image/svg+xml", "image/avif", "image/x-icon",
]);

export async function saveAsset(
  input: { draft_id: string; name: string; content_type: string; data: Buffer; tenant_id?: string },
  // T04 · el Programador de publicaciones sube también vídeo (el bodyLimit de
  // 150MB se amplió para él, index.ts:48) y valida el contenido por firma en su
  // ruta ANTES de llegar aquí. Estos límites opcionales solo relajan tipo/tamaño
  // para ese caller; sin opts, el comportamiento de Page Studio no cambia.
  opts?: { allowedTypes?: Set<string>; maxBytes?: number },
): Promise<PageAsset> {
  const allowed = opts?.allowedTypes ?? ALLOWED_TYPES;
  const maxBytes = opts?.maxBytes ?? MAX_ASSET_BYTES;
  if (!allowed.has(input.content_type))
    throw new Error("Tipo de fichero no permitido: " + input.content_type);
  if (input.data.length > maxBytes)
    throw new Error(`Fichero >${Math.round(maxBytes / 1048576)} MB. Comprime el archivo y vuelve a intentarlo.`);
  // QUITAR-C2PA-1 · toda imagen subida al panel se guarda sin la firma «hecho con IA» (C2PA).
  input = { ...input, data: quitarC2pa(input.data, input.content_type) };
  const id = crypto.randomUUID();
  const asset: PageAsset = {
    id,
    draft_id: input.draft_id || "",
    name: input.name || "asset",
    content_type: input.content_type,
    size_bytes: input.data.length,
    created_at: Date.now(),
  };
  // SECURITY-FIX 2026-06-20 · el tenant por defecto es el workspace activo, no
  // 'default' hardcodeado (antes todos los assets subidos por el editor caían en
  // 'default'). workspace-logo sigue pasando tenant_id explícito.
  const assetTenant = input.tenant_id ?? currentWorkspaceId();
  if (!pool) {
    memAssets.set(id, { ...asset, data: input.data, tenant_id: assetTenant });
    return asset;
  }
  await pool.query(
    `INSERT INTO app_page_assets (id,tenant_id,draft_id,name,content_type,size_bytes,data,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
    [id, assetTenant, asset.draft_id, asset.name, asset.content_type, asset.size_bytes, input.data],
  );
  return asset;
}

/** MEDIA-CADUCA-1 · tope de un vídeo del Programador por el canal binario (PUT crudo, sin base64). */
export const MAX_VIDEO_PROGRAMADOR = 250 * 1024 * 1024;
export const MAX_IMAGEN_PROGRAMADOR = 8 * 1024 * 1024;

/** Tipo REAL de un medio del Programador por su firma (nunca el MIME declarado). '' = no admitido. */
export function firmaMedioProgramador(bf: Buffer): string {
  if (bf.length >= 3 && bf[0] === 0xff && bf[1] === 0xd8 && bf[2] === 0xff) return "image/jpeg";
  if (bf.length >= 8 && bf[0] === 0x89 && bf[1] === 0x50 && bf[2] === 0x4e && bf[3] === 0x47) return "image/png";
  if (bf.length >= 12 && bf.subarray(0, 4).toString("latin1") === "RIFF" && bf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bf.length >= 6 && ["GIF87a", "GIF89a"].includes(bf.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (bf.length >= 12 && bf.subarray(4, 8).toString("latin1") === "ftyp") return "video/mp4"; // mp4 / mov / m4v
  if (bf.length >= 4 && bf[0] === 0x1a && bf[1] === 0x45 && bf[2] === 0xdf && bf[3] === 0xa3) return "video/webm";
  return "";
}

/** Días que se conserva un medio del Programador tras publicarse (0 = no caduca nunca). MEDIA_RETENTION_DAYS. */
export function diasRetencionMedios(): number {
  const raw = process.env.MEDIA_RETENTION_DAYS;
  if (raw === undefined || raw === "") return 30;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * MEDIA-CADUCA-1 · Estado de un asset ya caducado: sus bytes ya no existen, pero la fila (y una
 * miniatura pequeña) se conservan para que el historial siga viéndose. null = no existe o sigue vivo.
 */
export async function assetCaducado(id: string): Promise<{ content_type: string; poster: Buffer | null } | null> {
  if (!pool) return null;
  const r = await pool.query(
    `SELECT content_type, poster FROM app_page_assets WHERE id=$1 AND expired_at IS NOT NULL`, [id]);
  const x: any = r.rows[0];
  return x ? { content_type: x.content_type, poster: x.poster ? Buffer.from(x.poster) : null } : null;
}

/**
 * MEDIA-CADUCA-1 · Caduca los medios del Programador (draft __sched__) más viejos que `dias`:
 * guarda antes una miniatura (`hacerPoster`), vacía los bytes y marca expired_at.
 * NUNCA toca un medio que una publicación aún necesita: pendiente, borrador, enviándose, o publicada
 * hace menos de `dias` (se mira en media_url y en tags, donde viven portada y música).
 * No toca imágenes de páginas, logos ni nada fuera de __sched__. Lotes pequeños: 1 poster = 1 ffmpeg.
 */
export async function caducarMediosAntiguos(
  dias: number,
  hacerPoster: (id: string) => Promise<Buffer | null>,
  limite = 20,
): Promise<{ caducados: number; bytes: number }> {
  if (!pool || dias <= 0) return { caducados: 0, bytes: 0 };
  const r = await pool.query(
    `SELECT a.id, a.size_bytes FROM app_page_assets a
      WHERE a.draft_id='__sched__' AND a.expired_at IS NULL
        AND a.created_at < now() - make_interval(days => $1::int)
        AND NOT EXISTS (
          SELECT 1 FROM app_scheduled_posts p
           WHERE p.tenant_id = a.tenant_id
             AND (position(a.id in p.media_url) > 0 OR position(a.id in p.tags::text) > 0)
             AND (p.status NOT IN ('published','partial','error','cancelled')
                  OR p.scheduled_at >= now() - make_interval(days => $1::int)))
      ORDER BY a.created_at ASC LIMIT $2`,
    [dias, limite],
  );
  let caducados = 0, bytes = 0;
  for (const row of r.rows as { id: string; size_bytes: number }[]) {
    const poster = await hacerPoster(row.id).catch(() => null); // sin miniatura caduca igual: manda el espacio
    const u = await pool.query(
      `UPDATE app_page_assets SET poster=$2, data='\\x'::bytea, expired_at=now()
        WHERE id=$1 AND expired_at IS NULL`,
      [row.id, poster],
    );
    if (u.rowCount) { caducados++; bytes += Number(row.size_bytes) || 0; }
  }
  return { caducados, bytes };
}

/** POSTER-GUARDADO-1 · guarda UNA vez la miniatura de un medio para no volver a sacarla con ffmpeg. */
export async function setAssetPoster(id: string, jpg: Buffer): Promise<void> {
  if (!pool) return;
  await pool.query(`UPDATE app_page_assets SET poster=$2 WHERE id=$1 AND poster IS NULL`, [id, jpg]);
}

export async function getAssetPoster(id: string): Promise<Buffer | null> {
  if (!pool) return null;
  const r = await pool.query(`SELECT poster FROM app_page_assets WHERE id=$1 AND poster IS NOT NULL`, [id]);
  return r.rows[0]?.poster ? Buffer.from(r.rows[0].poster) : null;
}

export async function getAsset(id: string): Promise<{ asset: PageAsset; data: Buffer } | null> {
  if (!pool) {
    const m = memAssets.get(id);
    if (!m) return null;
    const { data, ...rest } = m;
    return { asset: rest, data };
  }
  const r = await pool.query(
    `SELECT id,tenant_id,draft_id,name,content_type,size_bytes,data,
       extract(epoch from created_at)*1000 created_at
     FROM app_page_assets WHERE id=$1 AND expired_at IS NULL`,
    [id],
  );
  if (!r.rows[0]) return null;
  const x: any = r.rows[0];
  return {
    asset: {
      id: x.id, draft_id: x.draft_id, name: x.name,
      content_type: x.content_type, size_bytes: Number(x.size_bytes),
      created_at: Number(x.created_at),
    },
    data: Buffer.from(x.data),
  };
}

export async function listAssets(draftId?: string): Promise<PageAsset[]> {
  // SECURITY-FIX 2026-06-20 · acotar SIEMPRE por tenant (antes, sin draftId,
  // listaba assets de TODOS los workspaces). Esta ruta pasa por guard() autenticado.
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const all = [...memAssets.values()].filter((a) => (a.tenant_id || "default") === tenantId);
    const filtered = draftId ? all.filter((a) => a.draft_id === draftId) : all;
    return filtered.map(({ data, tenant_id, ...rest }) => rest).sort((a, b) => b.created_at - a.created_at);
  }
  const sql = draftId
    ? `SELECT id,draft_id,name,content_type,size_bytes,extract(epoch from created_at)*1000 created_at
       FROM app_page_assets WHERE draft_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 200`
    : `SELECT id,draft_id,name,content_type,size_bytes,extract(epoch from created_at)*1000 created_at
       FROM app_page_assets WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200`;
  const r = draftId ? await pool.query(sql, [draftId, tenantId]) : await pool.query(sql, [tenantId]);
  return r.rows.map((x: any) => ({
    id: x.id, draft_id: x.draft_id, name: x.name,
    content_type: x.content_type, size_bytes: Number(x.size_bytes),
    created_at: Number(x.created_at),
  }));
}

export async function deleteAsset(id: string): Promise<void> {
  // SECURITY-FIX 2026-06-20 · borra SOLO si el asset es del tenant activo (antes
  // borraba por id sin tenant ⇒ borrado cross-tenant conociendo el UUID).
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const m = memAssets.get(id);
    if (m && (m.tenant_id || "default") === tenantId) memAssets.delete(id);
    return;
  }
  await pool.query("DELETE FROM app_page_assets WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
}

/* ============================================================
 * Inyección de SEO en el HTML publicado.
 * Si el draft.data.seo trae title/description/og_image/etc., se sustituyen
 * o añaden los meta tags en <head> antes de subir a leadmatch-lab.
 * ============================================================ */
export interface SeoConfig {
  title?: string;
  description?: string;
  og_image?: string;
  og_title?: string;
  og_description?: string;
  favicon?: string;
  canonical?: string;
  lang?: string;
  twitter_card?: string;
  robots?: string;
}

export function injectSeo(html: string, seo: SeoConfig | null | undefined): string {
  if (!seo || typeof seo !== "object") return html;
  let out = html;
  // <html lang="...">
  if (seo.lang) {
    out = /^<html[^>]*lang=/i.test(out)
      ? out.replace(/(<html[^>]*lang=)["'][^"']*["']/i, `$1"${esc(seo.lang)}"`)
      : out.replace(/<html([^>]*)>/i, `<html$1 lang="${esc(seo.lang)}">`);
  }
  // <title>...</title>
  if (seo.title) {
    out = /<title>[\s\S]*?<\/title>/i.test(out)
      ? out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(seo.title)}</title>`)
      : addToHead(out, `<title>${esc(seo.title)}</title>`);
  }
  const tags: string[] = [];
  if (seo.description) tags.push(metaTag("description", seo.description));
  if (seo.robots) tags.push(metaTag("robots", seo.robots));
  if (seo.og_title) tags.push(metaProp("og:title", seo.og_title));
  else if (seo.title) tags.push(metaProp("og:title", seo.title));
  if (seo.og_description) tags.push(metaProp("og:description", seo.og_description));
  else if (seo.description) tags.push(metaProp("og:description", seo.description));
  if (seo.og_image) {
    tags.push(metaProp("og:image", seo.og_image));
    tags.push(metaTag("twitter:image", seo.og_image));
  }
  tags.push(metaTag("twitter:card", seo.twitter_card || "summary_large_image"));
  if (seo.canonical) tags.push(`<link rel="canonical" href="${esc(seo.canonical)}">`);
  if (seo.favicon) tags.push(`<link rel="icon" href="${esc(seo.favicon)}">`);
  // Limpiamos duplicados que ya estuvieran en el head antes de inyectar.
  for (const re of [
    /<meta[^>]+name=["']description["'][^>]*>/gi,
    /<meta[^>]+name=["']robots["'][^>]*>/gi,
    /<meta[^>]+property=["']og:title["'][^>]*>/gi,
    /<meta[^>]+property=["']og:description["'][^>]*>/gi,
    /<meta[^>]+property=["']og:image["'][^>]*>/gi,
    /<meta[^>]+name=["']twitter:card["'][^>]*>/gi,
    /<meta[^>]+name=["']twitter:image["'][^>]*>/gi,
    /<link[^>]+rel=["']canonical["'][^>]*>/gi,
    /<link[^>]+rel=["']icon["'][^>]*>/gi,
  ]) out = out.replace(re, "");
  return addToHead(out, tags.join("\n"));
}

function metaTag(name: string, content: string): string {
  return `<meta name="${esc(name)}" content="${esc(content)}">`;
}
function metaProp(property: string, content: string): string {
  return `<meta property="${esc(property)}" content="${esc(content)}">`;
}
function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function addToHead(html: string, snippet: string): string {
  if (!snippet) return html;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n${snippet}`);
  }
  // Sin <head>: lo creamos antes de <body> o al inicio si no hay body.
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body/i, `<head>\n${snippet}\n</head>\n<body`);
  }
  return `<head>\n${snippet}\n</head>\n` + html;
}

/**
 * Inyecta CSS / JS / HTML propios del usuario (campos __custom_css/__custom_js/
 * __custom_html del draft) en el documento ya renderizado. Mismo punto de
 * inserción tanto en el publicado (saveDraft) como en el preview (endpoint
 * /admin/api/pages/preview), para que el "Preview en vivo" coincida 1:1 con lo
 * que se publica:
 *   - CSS  → <style> justo antes de </head>: cascada última, puede sobreescribir
 *            el CSS de la plantilla (lo que el usuario espera de "su" CSS).
 *   - HTML → al final del <body> (para embeds / widgets / badges).
 *   - JS   → <script> antes de </body>.
 * NO se escapa: es código del propio dueño para su propia página (page builder).
 * Idempotente por marcador data-custom-* para no duplicar en re-render.
 */
/**
 * Counter-resets canon contra los estilos heredados de Systeme.io. Al publicar,
 * el MCP mete el HTML en una entidad RawHtml cuyo wrapper tiene text-align:center
 * → todo el contenido se centraría; y SE.io añade margin al body y deja .reveal a
 * opacity:0 (sin el observer JS). El gate ANTI_SYSTEMEIO_RESETS del MCP EXIGE
 * estos 3 markers en el HTML que se publica (si no, rechaza el replace-page-html).
 * Van temprano en el <head> para que el CSS a medida del usuario pueda ganarles
 * con !important si lo necesita. Idempotente por data-lm-resets.
 */
export function injectSystemeioResets(html: string): string {
  if (/data-lm-resets/i.test(html)) return html;
  const block = `<style data-lm-resets>body{margin:0!important;text-align:left!important}.reveal{opacity:1!important}</style>`;
  return addToHead(html, block);
}

export function injectCustomCode(html: string, css?: string, js?: string, extraHtml?: string): string {
  let out = html;
  const cssT = (css || "").trim();
  if (cssT && !/data-custom-css/i.test(out)) {
    const block = `<style data-custom-css>\n${cssT}\n</style>`;
    out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, () => `${block}\n</head>`) : addToHead(out, block);
  }
  const parts: string[] = [];
  const htmlT = (extraHtml || "").trim();
  if (htmlT && !out.includes("<!--custom-html-->")) parts.push(`<!--custom-html-->\n${htmlT}`);
  const jsT = (js || "").trim();
  if (jsT && !/data-custom-js/i.test(out)) parts.push(`<script data-custom-js>\n${jsT}\n</script>`);
  if (parts.length) {
    const block = parts.join("\n");
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, () => `${block}\n</body>`) : out + block;
  }
  return out;
}

export async function updateDraftStatus(id: string, status: PageDraft["status"], extras: Partial<Pick<PageDraft, "published_url" | "published_at">> = {}): Promise<void> {
  const tenantId = currentWorkspaceId();
  if (!pool) {
    const d = memDrafts.get(id);
    if (!d || (d.tenant_id || "default") !== tenantId) return;
    d.status = status;
    if (extras.published_url !== undefined) d.published_url = extras.published_url;
    if (extras.published_at !== undefined) d.published_at = extras.published_at;
    d.updated_at = Date.now();
    return;
  }
  const sets: string[] = ["status=$2", "updated_at=now()"];
  const args: unknown[] = [id, status];
  if (extras.published_url !== undefined) { args.push(extras.published_url); sets.push(`published_url=$${args.length}`); }
  if (extras.published_at !== undefined) { args.push(extras.published_at ? new Date(extras.published_at).toISOString() : null); sets.push(`published_at=$${args.length}::timestamptz`); }
  args.push(tenantId);
  await pool.query(`UPDATE app_page_drafts SET ${sets.join(",")} WHERE id=$1 AND tenant_id=$${args.length}`, args);
}
