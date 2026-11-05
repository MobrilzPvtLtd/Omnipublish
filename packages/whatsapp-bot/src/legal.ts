/**
 * Páginas legales públicas (sin auth) servidas por la propia app:
 *   /privacidad      → Política de Privacidad (requisito para publicar la
 *                       app en Meta y para el App Review de Instagram)
 *   /terminos        → Términos del Servicio
 *   /eliminar-datos  → Instrucciones de eliminación de datos (Meta exige
 *                       una "Data Deletion Instructions URL")
 *
 * Editables sin redeploy desde settings (claves legal.*), con defaults
 * sensatos. La fecha de "última actualización" se fija al boot.
 */
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { get } from "./settings.js";
import { verificarSignedRequest } from "./meta-app.js";

const UPDATED = new Date().toISOString().slice(0, 10);

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verifica y parsea el `signed_request` que Meta envía al callback de
 * eliminación de datos. Devuelve el payload (con user_id) o null si la
 * firma no valida con el App Secret.
 */
function parseSignedRequest(signed: string, appSecret: string): any | null {
  const [sig, payload] = (signed || "").split(".", 2);
  if (!sig || !payload || !appSecret) return null;
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(payload)
    .digest();
  const got = b64urlToBuf(sig);
  if (
    expected.length !== got.length ||
    !crypto.timingSafeEqual(expected, got)
  )
    return null;
  try {
    return JSON.parse(b64urlToBuf(payload).toString("utf8"));
  } catch {
    return null;
  }
}

function v(key: string, def: string): string {
  return get(key) || def;
}

// WHITE-LABEL: defaults NEUTROS. Antes aquí vivían los datos legales reales del
// autor original (EIN, File Number, email personal, agente registrado) — un
// comprador que desplegara sin configurar `legal.*` publicaba en SU dominio la
// identidad legal de otra empresa. Cada instalación debe rellenar sus settings
// legal.* desde el panel; hasta entonces se muestran placeholders evidentes.
const D = {
  business: "[Tu empresa]",
  email: "[configura legal.email]",
  site: "",
  host: "localhost",
  entityState: "",
  entityFileNumber: "",
  entityFormed: "",
  entityEin: "",
  entityRegAgent: "",
  entityRegAddress: "",
  entityForm: "",
  address: "",
  representative: "",
  dpoContact: "",
  jurisdiction: "",
};

// Orden de precedencia: setting del panel → variable de entorno → vacío.
// Las env LEGAL_* permiten dejar la identidad lista en el despliegue sin
// entrar al panel; los campos vacíos simplemente NO se imprimen (ver
// identityBlock), en vez de publicar «[pendiente]» o datos de otra empresa.
const ENV_KEYS: Record<string, string> = {
  "legal.business": "LEGAL_BUSINESS",
  "legal.email": "LEGAL_EMAIL",
  "legal.site": "LEGAL_SITE",
  "legal.host": "LEGAL_HOST",
  "legal.entityForm": "LEGAL_ENTITY_FORM",
  "legal.entityState": "LEGAL_ENTITY_STATE",
  "legal.entityFileNumber": "LEGAL_ENTITY_FILE_NUMBER",
  "legal.entityFormed": "LEGAL_ENTITY_FORMED",
  "legal.entityEin": "LEGAL_ENTITY_EIN",
  "legal.entityRegAgent": "LEGAL_ENTITY_REG_AGENT",
  "legal.entityRegAddress": "LEGAL_ENTITY_REG_ADDRESS",
  "legal.address": "LEGAL_ADDRESS",
  "legal.representative": "LEGAL_REPRESENTATIVE",
  "legal.dpoContact": "LEGAL_DPO_CONTACT",
  "legal.jurisdiction": "LEGAL_JURISDICTION",
};
function cfg(key: string, def = ""): string {
  const fromEnv = ENV_KEYS[key] ? process.env[ENV_KEYS[key]] : undefined;
  return (get(key) || fromEnv || def).trim();
}

function shell(title: string, body: string, opts: { path?: string; description?: string; host?: string } = {}): string {
  const biz = cfg("legal.business", D.business);
  const site = cfg("legal.site", D.site);
  const host = opts.host || cfg("legal.host", D.host);
  const path = opts.path || "/";
  const canonical = `https://${host}${path}`;
  const desc = opts.description || `${title} de ${biz}. Información oficial sobre cómo tratamos tus datos en nuestros canales automatizados de WhatsApp e Instagram.`;
  const ogImage = `https://${host}/og.png`;
  const ogW = 1200;
  const ogH = 630;
  // JSON-LD: Organization + WebPage para que Google y Meta entiendan quién
  // está detrás. Refuerza el trust signal en App Review y en SERPs.
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "name": biz,
        "url": `https://${host}`,
        "logo": ogImage,
        // Identificación fiscal/postal SOLO si la instalación la configuró:
        // no publicamos datos de nadie por defecto.
        ...(cfg("legal.email") ? { email: cfg("legal.email") } : {}),
        ...(cfg("legal.entityFormed") ? { foundingDate: cfg("legal.entityFormed") } : {}),
        ...(cfg("legal.entityEin") ? { taxID: cfg("legal.entityEin") } : {}),
        ...(cfg("legal.address") || cfg("legal.entityRegAddress")
          ? { address: { "@type": "PostalAddress", streetAddress: cfg("legal.address") || cfg("legal.entityRegAddress") } }
          : {}),
      },
      {
        "@type": "WebPage",
        "name": title,
        "url": canonical,
        "inLanguage": "es",
        "isPartOf": { "@type": "WebSite", "name": biz, "url": `https://${host}` },
      },
    ],
  });
  return `<!doctype html><html lang=es><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${title} · ${biz}</title>
<meta name="description" content="${desc.replace(/"/g, "&quot;")}">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#AE5F45">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/favicon.svg">
<meta property="og:site_name" content="${biz}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc.replace(/"/g, "&quot;")}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="${ogW}">
<meta property="og:image:height" content="${ogH}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="${biz}">
<meta property="og:locale" content="es_ES">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc.replace(/"/g, "&quot;")}">
<meta name="twitter:image" content="${ogImage}">
<script type="application/ld+json">${jsonLd}</script>
<style>
*{box-sizing:border-box}
body{font:16px/1.6 system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#f7f3f1;color:#2a1712}
header{background:#c0603e;color:#fff;padding:26px 20px}
.wrap{max-width:780px;margin:0 auto;padding:0 20px}
header .wrap{display:flex;align-items:center;gap:12px}
header svg{width:38px;height:38px;border-radius:50%}
header b{font-size:20px}
main{max-width:780px;margin:0 auto;padding:30px 20px 60px}
h1{font-size:26px;margin:0 0 4px}
.upd{color:#8a7a72;font-size:14px;margin-bottom:26px}
h2{font-size:19px;margin:30px 0 8px;color:#a34e30}
a{color:#c0603e}
ul{padding-left:20px}
.box{background:#fff;border:1px solid #e9ddd6;border-radius:12px;padding:16px 20px;margin:18px 0}
footer{border-top:1px solid #e9ddd6;margin-top:40px;padding:20px;text-align:center;color:#8a7a72;font-size:13px}
nav a{margin:0 10px;color:#8a7a72;text-decoration:none}
</style>
<header><div class=wrap>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="256" fill="#fff"/><path d="M168 150 H372 L300 250 H110 Z" fill="#c0603e"/><path d="M168 280 H322 L250 392 V442 L208 396 L134 382 Z" fill="#c0603e"/></svg>
<b>${biz}</b></div></header>
<main>${body}
<footer><nav><a href="/privacidad">Privacidad</a> · <a href="/terminos">Términos</a> · <a href="/eliminar-datos">Eliminar datos</a></nav>
<p>${biz} — <a href="${site}">${site}</a></p></footer>
</main></html>`;
}

export function registerLegal(app: FastifyInstance): void {
  const email = () => cfg("legal.email", D.email);
  const biz = () => cfg("legal.business", D.business);
  // Datos de identificación legal de la entidad. Meta App Review exige que la
  // Privacy Policy identifique al responsable del tratamiento de forma
  // inequívoca → CADA instalación configura los suyos en settings legal.*
  // (defaults = placeholders neutros, nunca la identidad de otra empresa).
  // Bloque de identidad CONDICIONAL: cada línea se imprime solo si su dato
  // está configurado. Antes se imprimían siempre y una instalación sin
  // configurar publicaba «File Number: [pendiente]» o, peor, los datos reales
  // de otra empresa. Meta App Review solo exige identificar al responsable de
  // forma inequívoca — no exige campos que la entidad no tenga.
  const identityBlock = (): string => {
    const lines: string[] = [];
    const form = cfg("legal.entityForm");
    const state = cfg("legal.entityState");
    if (form && state) lines.push(`${form} constituida en ${state}.`);
    else if (form) lines.push(`${form}.`);
    else if (state) lines.push(`Entidad constituida en ${state}.`);
    const formed = cfg("legal.entityFormed");
    if (formed) lines.push(`Fecha de constitución: ${formed}.`);
    const ids: string[] = [];
    const fileNo = cfg("legal.entityFileNumber");
    const ein = cfg("legal.entityEin");
    if (fileNo) ids.push(`File Number: ${fileNo}`);
    if (ein) ids.push(`EIN: ${ein}`);
    if (ids.length) lines.push(`${ids.join(" · ")}.`);
    const addr = cfg("legal.address");
    if (addr) lines.push(`Domicilio: ${addr}.`);
    const agent = cfg("legal.entityRegAgent");
    const agentAddr = cfg("legal.entityRegAddress");
    if (agent) lines.push(`Agente registrado${state ? ` en ${state}` : ""}: ${agent}${agentAddr ? `, ${agentAddr}` : ""}.`);
    const rep = cfg("legal.representative");
    if (rep) lines.push(`Representante legal: ${rep}.`);
    return lines.length ? `<p style="margin:0 0 8px"><b>${biz()}</b><br>${lines.join("<br>")}</p>` : `<p style="margin:0 0 8px"><b>${biz()}</b></p>`;
  };

  const privacyBody = () => `<h1>Política de Privacidad</h1>
<p class=upd>Última actualización: ${UPDATED}</p>

<p>Esta política describe cómo <b>${biz()}</b> ("nosotros") trata los datos
personales cuando interactúas con nuestros canales automatizados de atención
en <b>WhatsApp</b> e <b>Instagram</b>.</p>

<h2>1. Responsable del tratamiento</h2>
<div class=box>
${identityBlock()}
<p style="margin:8px 0 0">Contacto de privacidad: <a href="mailto:${email()}">${email()}</a>.</p>
${cfg("legal.dpoContact") ? `<p style="margin:8px 0 0">Delegado de Protección de Datos: <a href="${cfg("legal.dpoContact")}" target="_blank" rel="noopener">${cfg("legal.dpoContact")}</a>.</p>` : ""}
</div>

<h2>2. Qué datos recogemos</h2>
<ul>
<li>Tu nombre de perfil público de WhatsApp/Instagram y tu identificador de
usuario en esas plataformas (número de teléfono o ID de Instagram).</li>
<li>El contenido de los mensajes y comentarios que nos envías y nuestras
respuestas.</li>
<li>Metadatos de la interacción (fecha/hora, etiquetas y etapa comercial que
asignemos para gestionar tu solicitud).</li>
</ul>
<p>No recogemos datos de tarjetas, ni categorías especiales de datos, ni
rastreamos tu actividad fuera de la conversación.</p>

<h2>3. Para qué los usamos</h2>
<ul>
<li>Responder a tus consultas y automatizar la atención (incluida la
respuesta a comentarios y el envío de mensajes directos que tú inicias o
solicitas).</li>
<li>Gestionar el seguimiento comercial (CRM) de tu solicitud.</li>
</ul>
<p>Base jurídica (RGPD): tu <b>consentimiento</b> al iniciar la conversación o
comentar solicitando información, y nuestro <b>interés legítimo</b> en
atender y dar seguimiento a esa solicitud.</p>

<h2>4. Dónde se guardan y quién los procesa</h2>
<p>Los datos se almacenan en una base de datos PostgreSQL gestionada en
<b>Railway</b>. Los secretos y credenciales se cifran (AES-256-GCM). Para
prestar el servicio intervienen como encargados:</p>
<ul>
<li><b>Meta Platforms</b> (WhatsApp Business Platform e Instagram Graph API),
para entregar y recibir los mensajes.</li>
<li>Un proveedor de modelo de lenguaje para generar respuestas. Por defecto
usamos un proveedor que <b>no entrena sus modelos con tus datos</b>; si se
cambiara a otro, se actualizará esta política.</li>
</ul>

<h2>5. Uso de inteligencia artificial</h2>
<p>Al comenzar una conversación atendida por nuestro asistente te informamos
de forma expresa de que interactúas con un sistema de inteligencia artificial.
La IA puede redactar respuestas, resumir el contexto de la conversación,
clasificar tu solicitud y proponer su derivación a una persona.</p>
<p>Para generar una respuesta se puede enviar al proveedor del modelo el
contenido relevante de tus mensajes, el historial reciente de la conversación,
las instrucciones del asistente y, cuando exista, información de tu ficha de
atención necesaria para contextualizar la consulta. No uses estos canales para
enviar datos especialmente sensibles que no sean necesarios.</p>
<p>Mantenemos un registro técnico asociado a la conversación que identifica el
perfil de asistente y el proveedor/modelo utilizados, la versión de sus
instrucciones y la respuesta generada. Este registro sirve para supervisión,
seguridad, atención de reclamaciones y rendición de cuentas, y se elimina junto
con la conversación.</p>
<p>Puedes pedir la intervención de una persona escribiendo, por ejemplo,
<b>«Quiero hablar con una persona»</b>. Las respuestas automáticas pueden
contener errores y deben verificarse antes de tomar decisiones importantes.</p>

<h2>6. Conservación</h2>
<p>Conservamos la conversación y los datos de contacto mientras exista
relación de atención o seguimiento comercial, y los eliminamos cuando lo
solicitas o cuando dejan de ser necesarios.</p>

<h2>7. Tus derechos</h2>
<p>Puedes ejercer tus derechos de acceso, rectificación, supresión, oposición
y portabilidad escribiendo a <a href="mailto:${email()}">${email()}</a>. Para
borrar tus datos consulta la página
<a href="/eliminar-datos">Eliminar datos</a>.</p>

<h2>8. Menores</h2>
<p>El servicio no está dirigido a menores de 14 años.</p>

<h2>9. Cambios</h2>
<p>Podemos actualizar esta política; publicaremos la nueva versión en esta
misma dirección con su fecha.</p>`;

  const termsBody = () => `<h1>Términos del Servicio</h1>
<p class=upd>Última actualización: ${UPDATED}</p>
<p>Al interactuar con los canales automatizados de <b>${biz()}</b> en
WhatsApp e Instagram aceptas lo siguiente:</p>
<h2>1. Identificación del prestador</h2>
<div class=box>
${identityBlock()}
<p style="margin:8px 0 0">Contacto: <a href="mailto:${email()}">${email()}</a>.</p>
</div>
<h2>2. Descripción</h2>
<p>Ofrecemos atención e información automatizada mediante asistentes
conversacionales. Las respuestas pueden generarse de forma automática y
pueden contener errores; no constituyen asesoramiento profesional vinculante.</p>
<h2>3. Uso aceptable</h2>
<p>No está permitido usar el servicio para enviar contenido ilícito, spam,
abusivo o que infrinja derechos de terceros.</p>
<h2>4. Disponibilidad</h2>
<p>El servicio se presta "tal cual", sin garantía de disponibilidad
ininterrumpida. Podemos modificarlo o suspenderlo.</p>
<h2>5. Responsabilidad</h2>
<p>En la medida permitida por la ley, no nos hacemos responsables de daños
indirectos derivados del uso del servicio.</p>
<h2>6. Legislación y jurisdicción</h2>
<p>${cfg("legal.jurisdiction") || cfg("legal.entityState")
      ? `Estos términos se rigen por las leyes de ${cfg("legal.jurisdiction") || cfg("legal.entityState")}, sin perjuicio de`
      : "Estos términos se rigen por la legislación aplicable al prestador, sin perjuicio de"}
los derechos imperativos que correspondan al usuario según las leyes de su
país de residencia.</p>
<h2>7. Contacto</h2>
<p><a href="mailto:${email()}">${email()}</a></p>`;

  const deletionBody = () => `<h1>Instrucciones de eliminación de datos</h1>
<p class=upd>Última actualización: ${UPDATED}</p>
<p>Tienes derecho a solicitar la eliminación de todos los datos personales
que <b>${biz()}</b> haya almacenado sobre ti a partir de tus interacciones en
WhatsApp o Instagram.</p>
<div class=box>
<h2 style="margin-top:0">Cómo solicitarlo</h2>
<p><b>Opción A — Por mensaje:</b> escríbenos por el mismo canal de WhatsApp o
Instagram la palabra <b>ELIMINAR MIS DATOS</b>. Procesaremos la baja y
borraremos tu conversación y ficha de contacto.</p>
<p><b>Opción B — Por correo:</b> envía un email a
<a href="mailto:${email()}">${email()}</a> desde, o indicando, la cuenta
(número de teléfono o usuario de Instagram) cuya eliminación solicitas.</p>
</div>
<p>Atenderemos la solicitud en un plazo máximo de 30 días y te confirmaremos
la eliminación. Una vez borrados, los datos no se pueden recuperar.</p>`;

  const hostOf = (req: any): string => {
    const fwd = (req.headers && req.headers["x-forwarded-host"]) || (req.headers && req.headers.host);
    return String(fwd || cfg("legal.host", D.host));
  };
  const sendHtml = (reply: any, s: string) => reply.type("text/html; charset=utf-8").send(s);

  // Cada handler ahora pasa path + description específicos para canonical/OG.
  const privacyDesc = "Política de privacidad de " + cfg("legal.business", D.business) + ". Qué datos recogemos, cómo los tratamos y cómo ejercer tus derechos en nuestros canales WhatsApp e Instagram.";
  const termsDesc = "Términos del Servicio de " + cfg("legal.business", D.business) + ". Condiciones de uso de nuestros asistentes conversacionales de WhatsApp e Instagram.";
  const deletionDesc = "Cómo solicitar la eliminación de tus datos almacenados por " + cfg("legal.business", D.business) + " a partir de tus interacciones en WhatsApp o Instagram.";

  app.get("/privacidad",     async (req, reply) => sendHtml(reply, shell("Política de Privacidad", privacyBody(),  { path: "/privacidad",     description: privacyDesc,  host: hostOf(req) })));
  app.get("/privacy",        async (req, reply) => sendHtml(reply, shell("Política de Privacidad", privacyBody(),  { path: "/privacy",        description: privacyDesc,  host: hostOf(req) })));
  app.get("/terminos",       async (req, reply) => sendHtml(reply, shell("Términos del Servicio",  termsBody(),    { path: "/terminos",       description: termsDesc,    host: hostOf(req) })));
  app.get("/terms",          async (req, reply) => sendHtml(reply, shell("Términos del Servicio",  termsBody(),    { path: "/terms",          description: termsDesc,    host: hostOf(req) })));
  app.get("/eliminar-datos", async (req, reply) => sendHtml(reply, shell("Eliminar tus datos",     deletionBody(), { path: "/eliminar-datos", description: deletionDesc, host: hostOf(req) })));
  app.get("/data-deletion",  async (req, reply) => sendHtml(reply, shell("Eliminar tus datos",     deletionBody(), { path: "/data-deletion",  description: deletionDesc, host: hostOf(req) })));

  // robots.txt: permite indexar páginas legales, bloquea el panel + webhooks
  // + redirects. Apunta al sitemap.xml. Indispensable para que Google sepa qué
  // rastrear y para que Meta valide la integridad de la app.
  app.get("/robots.txt", async (req, reply) => {
    const host = hostOf(req);
    reply.type("text/plain; charset=utf-8").send(
      [
        "User-agent: *",
        "Allow: /privacidad",
        "Allow: /privacy",
        "Allow: /terminos",
        "Allow: /terms",
        "Allow: /eliminar-datos",
        "Allow: /data-deletion",
        "Disallow: /admin",
        "Disallow: /admin/",
        "Disallow: /webhook",
        "Disallow: /r/",
        "Disallow: /api/",
        "",
        `Sitemap: https://${host}/sitemap.xml`,
        "",
      ].join("\n"),
    );
  });

  // sitemap.xml: lista las 3 páginas legales (ES + EN) que sí queremos indexadas.
  app.get("/sitemap.xml", async (req, reply) => {
    const host = hostOf(req);
    const today = new Date().toISOString().slice(0, 10);
    const url = (p: string, priority: string) =>
      `<url><loc>https://${host}${p}</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>${priority}</priority></url>`;
    reply.type("application/xml; charset=utf-8").send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        url("/privacidad", "0.8") +
        url("/privacy", "0.6") +
        url("/terminos", "0.8") +
        url("/terms", "0.6") +
        url("/eliminar-datos", "0.7") +
        url("/data-deletion", "0.5") +
        `\n</urlset>`,
    );
  });

  /**
   * Callback de eliminación de datos (método oficial de Meta para apps con
   * datos de usuario). Meta hace POST con `signed_request`; verificamos la
   * firma con el App Secret, registramos la solicitud y respondemos con la
   * URL de estado + un código de confirmación, como exige la spec.
   */
  app.post("/data-deletion/callback", async (req, reply) => {
    const body = req.body as any;
    const signed: string =
      (body && (body.signed_request ?? body.json?.signed_request)) || "";
    const data = await verificarSignedRequest(signed, parseSignedRequest);
    const userId: string = data?.user_id || "desconocido";
    const code =
      "DEL-" +
      crypto.createHash("sha256").update(userId + ":" + Date.now()).digest("hex").slice(0, 12).toUpperCase();
    // Registro de la solicitud (borrado efectivo: vía mensaje "ELIMINAR MIS
    // DATOS" o email, según política; aquí dejamos traza auditable).
    req.log.warn(
      { userId, code, valid: !!data },
      "Solicitud de eliminación de datos recibida (Meta callback)",
    );
    const base = "https://" + (req.headers.host || cfg("legal.host", D.host));
    return reply.send({
      url: base + "/eliminar-datos/estado?code=" + code,
      confirmation_code: code,
    });
  });

  app.get("/eliminar-datos/estado", async (req, reply) => {
    const code = String((req.query as any)?.code || "—");
    return sendHtml(reply, shell(
      "Estado de eliminación",
      `<h1>Solicitud de eliminación recibida</h1>
<p class=upd>Código de confirmación: <b>${code.replace(/[^A-Z0-9-]/g, "")}</b></p>
<div class=box><p>Hemos registrado tu solicitud de eliminación de datos.
Procesamos la baja y borramos tu conversación y ficha de contacto en un plazo
máximo de 30 días. Si necesitas confirmación o tienes dudas, escribe a
<a href="mailto:${email()}">${email()}</a> indicando este código.</p></div>`,
      { path: "/eliminar-datos/estado", description: "Confirmación de solicitud de eliminación de datos.", host: hostOf(req) },
    ));
  });
}
