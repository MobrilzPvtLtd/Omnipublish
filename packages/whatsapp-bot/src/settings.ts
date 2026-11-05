/**
 * Configuración resoluble en runtime: BD (Postgres, editable desde el panel)
 * con fallback a variables de entorno. Los secretos se cifran en BD.
 *
 * Multi-tenant (W7):
 *   - GLOBAL_KEYS  → namespace '_global_' (compartido por todos los workspaces).
 *                    Cosas que pertenecen al stack en sí: admin/cuenta operador,
 *                    Meta App credentials, llm provider+keys, bridge MCP,
 *                    chatfuel secret… ManyChat-style.
 *   - Resto         → namespace = currentWorkspaceId() (per-WS). Cada workspace
 *                    tiene sus credenciales WhatsApp/IG/FB/Ads/Systeme.io,
 *                    sus bots, su knowledge, su branding, etc.
 *
 * Cascada de lectura per-WS (WS-ISOLATION 2026-06-04):
 *   cacheByWs[wsActual][key]  →  env  →  fallback
 *   AISLAMIENTO TOTAL por defecto. Un WS distinto de 'default' NO hereda
 *   nada de cacheByWs['default']. Cada workspace conecta explicitamente sus
 *   credenciales. Opt-out legacy: WS_STRICT_SECRETS=false en env restaura el
 *   comportamiento anterior (herencia transparente desde 'default').
 *
 * Claves (dot-notation):
 *   llm.provider, llm.model
 *   key.<provider>            (secreto: api key del proveedor LLM)
 *   whatsapp.verifyToken, whatsapp.phoneNumberId
 *   whatsapp.accessToken*, whatsapp.appSecret*
 *   meta.igBusinessId, meta.adAccountId
 *   meta.igAccessToken*, meta.appSecret*, meta.adsToken*
 *   bots.json                 (JSON de personalidades)
 *   knowledge.negocio, brand  (texto)
 *   (* = secreto, cifrado en BD)
 */
import {
  dbAllSettingsWithTenant,
  dbSetSettingForTenant,
  dbRotarCifradoQr,
} from "./db.js";
import { encrypt, decrypt, isProd, appEncKeyPresent, appEncKeyWeak, isEncryptedWithDevKey, rotarCifrado, claveAnteriorPresente } from "./crypto.js";
import { currentWorkspaceId, DEFAULT_WORKSPACE_ID } from "./workspace.js";
import { invalidateChannelRoutingCache } from "./channel-routing-cache.js";

export const PROVIDERS = {
  // 2026-08-19 · UN SOLO PROVEEDOR. Antes había ocho y cada instalación
  // elegía; ahora el stack se instala en clientes y todos usan el mismo:
  // una cuenta, una clave, los mismos modelos. DeepInfra sirve modelos
  // ABIERTOS con API compatible con OpenAI, así que si algún día hay que
  // cambiar de casa (o servirlos uno mismo) el modelo se lleva consigo.
  deepinfra: {
    label: "DeepInfra",
    baseURL: "https://api.deepinfra.com/v1/openai",
    // Mistral Small 3.2, elegido y verificado vivo contra el catálogo público
    // de DeepInfra (2026-08-19). Es europeo y entrenado con mucho español, y
    // sobre todo NO razona: no existe el fallo de que el modelo le suelte su
    // monólogo interno a un cliente por WhatsApp. Los modelos gpt-oss son más
    // baratos pero rompen el modo JSON (formato Harmony): no ponerlos aquí.
    defaultModel: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    envKey: "DEEPINFRA_API_KEY",
    note: "Tu cuenta en deepinfra.com. Crea una clave de acceso y pégala aquí: es lo único que necesita el panel para hablar, escribir y analizar. Viene con un modelo elegido que funciona bien en español, así que no tienes que tocar nada más. Se paga por uso: céntimos al mes con un uso normal.",
  },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

/**
 * Los tres modelos los elige el PANEL, no el cliente: cada uno está escogido
 * para su trabajo y verificado vivo contra el catálogo público de DeepInfra
 * (2026-08-19). Quien instala el panel solo pega su API key.
 *
 * Al revisarlos, comprobar que siguen en https://api.deepinfra.com/v1/openai/models
 * — es público y no pide clave. Un modelo retirado es lo que dejó el respaldo
 * del bot muerto durante meses cuando Groq jubiló la familia Llama.
 */
export const MODELOS = {
  /** El bot que habla con clientes: europeo, buen español y NO razona, así que
   *  no puede soltarle a nadie su monólogo interno por WhatsApp. */
  bot: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
  /** Respaldo: otra familia y otro hardware, para que no se caiga con el primero. */
  respaldo: "Qwen/Qwen3-235B-A22B-Instruct-2507",
  /** El Asistente del panel: bucle de herramientas, 1M de contexto y caché
   *  barata para el manual del panel que repite en cada llamada. */
  asistente: "deepseek-ai/DeepSeek-V4-Flash-0731",
} as const;

// WS-ISOLATION 2026-06-04 · SECRET_KEYS ampliado para cubrir TODO token /
// credencial / dato sensible per-WS. Antes solo cubria los obvios (tokens,
// passwords, api keys), pero los IDs (igBusinessId, adAccountId, etc) y JSON
// con tokens incrustados (whatsapp.numbers, meta.accounts, autopost.uploadPostAccounts)
// tambien deben tratarse como secretos en modo multi-tenant: revelar que un WS
// tiene una IG concreta o un Ad Account concreto FILTRA mas que el token mismo.
// Bajo WS_STRICT_SECRETS (default true), estos NUNCA heredan del 'default'.
const SECRET_KEYS = new Set<string>([
  // -- WhatsApp (per-WS · TODO sensible) --
  "whatsapp.accessToken",
  "whatsapp.appSecret",
  // Números WhatsApp adicionales (JSON con tokens) → cifrado.
  "whatsapp.numbers",
  "whatsapp.phoneNumberId",
  "whatsapp.wabaId",
  // ALTA-SELFSERVE-1 · PIN de verificación en dos pasos que el panel fija en Meta
  // al registrar cada número (POST /{phone-number-id}/register). Mapa JSON
  // {phoneNumberId: "123456"}. Va en clave APARTE de whatsapp.numbers a propósito:
  // ese array se reescribe en cinco sitios remapeando solo {phoneNumberId,label,
  // token,botId}, así que un pin dentro se perdería en silencio al renombrar o
  // quitar CUALQUIER número — y sin el pin, Meta no deja re-registrar (soporte).
  // Secreta (cifrada + enmascarada en el export del workspace) y NUNCA global:
  // el pin es de un número de un cliente concreto.
  "whatsapp.registerPins",
  // -- Meta (Instagram + Facebook + Ads · per-WS) --
  "meta.igAccessToken",
  "meta.igBusinessId",
  "meta.accounts",
  "meta.adAccounts",
  // Facebook Pages (Fase 1): array JSON cifrado de {pageId,name,token,pictureUrl,addedAt}.
  // Cada page_access_token es long-lived (60 días). Se rellena desde el callback OAuth Meta
  // junto a las cuentas IG (las páginas son las "parent" de cada IG Business).
  "meta.fbAccounts",
  "meta.appSecret",
  // FIRMA-IG-1: 2º secreto de app (config de webhook "Instagram Login"), para no
  // descartar sus entregas con 401. Opcional.
  "meta.appSecretAlt",
  // PASARELA-META-1 · clave de esta instancia ante la Pasarela Meta (sustituye al App Secret).
  "meta.gatewayKey",
  "meta.adsToken",
  "meta.adAccountId",
  // M2: array JSON cifrado de cuentas Meta Ads conectadas
  // ({adAccountId, adAccountName, currency, businessId?, label}).
  // Per-WS (NO en GLOBAL_KEYS): cada workspace tiene su propio set de cuentas.
  // Fallback retrocompatible al single-account (meta.adAccountId + meta.adsToken).
  "meta.adsAccounts",
  // Conocimiento del negocio: precios, condiciones y datos de clientes. Ya se
  // cifraban knowledge.negocio, bots.json y brand; las FICHAS se quedaron fuera
  // y viajaban en claro a la base de datos (auditoría 2026-08-24). Vendiendo
  // esto a clientes, sus precios no pueden estar en claro.
  "knowledge.packs",
  // -- LLM API keys (globales pero secretas) --
  "key.deepinfra",
  // Las anteriores siguen cifradas mientras dure el puente de migracion.
  "key.groq",
  "key.gemini",
  "key.nvidia",
  "key.cerebras",
  "key.openrouter",
  "key.anthropic",
  "key.openai",
  "admin.pass",
  // PIN para destrabar la sección Credenciales en Ajustes (scrypt-hashed).
  "admin.credentialsPin",
  // -- Autopost (Upload-Post + Postiz · per-WS) --
  "autopost.uploadPostToken",
  "autopost.uploadPostUser",
  // Multi-cuenta Upload-Post: array de {id,label,user,token,addedAt} encriptado.
  // Migrado idempotentemente desde el par legacy uploadPostToken/uploadPostUser.
  "autopost.uploadPostAccounts",
  // API key de Zernio — proveedor de publicación (SaaS, conectar-desde-la-app).
  // 3 claves = 3 cuentas Zernio (cada una ≤2 redes → plan gratis). El reparto de
  // redes a clave/bloque vive en zernio.ts (ZERNIO_BLOCKS). zernioApiKey = bloque 1
  // (compat con la clave única previa). Todas PER-WORKSPACE.
  "autopost.zernioApiKey",
  "autopost.zernioKey2",
  "autopost.zernioKey3",
  // -- Bridge MCP (systemeio-mcp) + sandbox systeme.io --
  "mcp.token",
  "systemeio.sandboxPass",
  "systemeio.sandboxEmail",
  // Puente Chatfuel (JSON API) para TikTok: secreto que valida el webhook.
  "chatfuel.jsonSecret",
  // -- Estudio de diseño (Open Design) --
  "opendesign.pass",
  "opendesign.geminiKey",
  // Proveedores externos de leads (búsqueda de emails de personas/empresas).
  "leads.hunter.apiKey",
  "leads.apollo.apiKey",
  "leads.mailerfind.apiKey",
  // MailerFind no documenta API pública estable: el user pega el endpoint exacto
  // que le dé su panel cuando lo contrate.
  "leads.mailerfind.endpoint",
  // GitHub PAT opcional (sube rate-limit de 60 → 5000 req/h en buscador devs).
  "leads.github.token",
  // Conexión Systeme.io / leadmatch-lab vía API pública oficial (api.systeme.io).
  // El user la genera en su panel Systeme.io → Settings → Public API Keys.
  "systemeio.publicApiKey",
  // Conexión vía cookie de sesión del navegador (PHPSESSID). Da acceso COMPLETO
  // al panel (funnels, ventas, newsletters, etc.) reutilizando la sesión web del
  // user. El user la pega desde DevTools → Application → Cookies. Caduca cuando
  // caduca la sesión del navegador (típico: días/semanas).
  "systemeio.sessionCookie",
  "systemeio.panelBaseUrl",
  "systemeio.accountEmail",
  // Multi-cuenta: JSON array con N cuentas conectadas (cada una con su
  // método+creds). Encriptado entero porque contiene apiKeys/cookies/pass.
  "systemeio.accounts",
  // -- YouTube (per-WS · OAuth tokens + canal) --
  "youtube.accessToken",
  "youtube.refreshToken",
  // T07-SEC · era el ÚNICO client secret OAuth del stack fuera de SECRET_KEYS:
  // se guardaba en claro y el GET de settings lo devolvía entero sin PIN.
  // decrypt() tolera filas legadas en claro (sin prefijo enc:), así que
  // añadirlo aquí no rompe instalaciones existentes.
  "youtube.clientSecret",
  "youtube.tokenExpiry",
  "youtube.channelId",
  "youtube.channelTitle",
  "youtube.channelThumb",
  "youtube.accounts",
  // -- Typeform (TYPEFORM-1) · secreto de la app del operador + tokens por workspace +
  //    secretos con los que Typeform firma las respuestas de cada formulario.
  "typeform.clientSecret",
  "typeform.accounts",
  "typeform.enlaces",
  // VENTA-WEBHOOK-1 · clave del webhook de ventas universal (per-WS: cada negocio la suya).
  "ventas.webhook.key",
  // -- LinkedIn Ads (per-WS · OAuth token + cuentas publicitarias) --
  "linkedin.accessToken",
  "linkedin.refreshToken",
  "linkedin.tokenExpiry",
  "linkedin.adAccountId",
  "linkedin.adsAccounts",
  // clientSecret de la app del stack: GLOBAL pero SECRET (se cifra). Ver GLOBAL_KEYS.
  "linkedin.clientSecret",
  // -- LinkedIn Community Management (per-WS · OAuth token + Páginas). App CM
  //    SEPARADA de Ads ("LeadMatch Insights"); no comparte token con r_ads. --
  "linkedin.cm.accessToken",
  "linkedin.cm.refreshToken",
  "linkedin.cm.tokenExpiry",
  "linkedin.cm.orgId",
  "linkedin.cm.orgs",
  // clientSecret de la app CM del stack: GLOBAL pero SECRET (se cifra). Ver GLOBAL_KEYS.
  "linkedin.cmClientSecret",
  // -- Google Ads (per-WS · OAuth refresh token + cuentas) --
  "googleads.accessToken",
  "googleads.refreshToken",
  "googleads.tokenExpiry",
  "googleads.customerId",
  "googleads.loginCustomerId",
  "googleads.accounts",
  // GLOBAL pero SECRET (se cifran): clientSecret + developerToken del stack.
  "googleads.clientSecret",
  "googleads.developerToken",
  // -- Branding + knowledge (per-WS · no son tokens pero NO deben heredar) --
  // Aunque texto plano, una cuenta nueva no debe arrancar pre-cargada con la
  // marca/conocimiento del WS original (UX confusa + leak de operativa).
  "brand",
  "knowledge.negocio",
  "bots.json",
  // Horario de atención del bot (JSON: días, franja, zona y aviso).
  "bot.horario",
  "pipelines.json",
  "pipeline.name",
  "tags.catalog",
  // ETQ-06 · DESC-ETIQUETA-1 · para qué sirve cada etiqueta (nota interna del equipo, etiquetas-desc.ts).
  "tags.desc",
]);

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key);
}

/**
 * Keys que viven en namespace global ('_global_') sin importar el WS activo.
 * Lo que el operador del stack configura UNA vez para todos sus workspaces:
 *   - Cuenta del admin/operador del panel (admin.user/pass/credentialsPin)
 *   - Meta App credentials (1 Meta App aprobada sirve a todos, ManyChat-style)
 *   - Verify token + app secret del webhook WhatsApp (la app es la misma)
 *   - LLM provider, modelo y api keys (proveedor único compartido)
 *   - Bridge MCP (1 systemeio-mcp para todo el stack)
 *   - Chatfuel JSON secret (puente TikTok único)
 *
 * Cualquier otra key cae al namespace del WS activo (per-tenant).
 */
export const GLOBAL_KEYS: ReadonlySet<string> = new Set<string>([
  "admin.user",
  "admin.pass",
  "admin.credentialsPin",
  "meta.appId",
  "meta.appSecret",
  "meta.appSecretAlt",
  "meta.gatewayUrl",
  "meta.gatewayKey",
  "meta.waEmbeddedConfigId",
  "meta.waCoexistenceConfigId",
  "whatsapp.verifyToken",
  "whatsapp.appSecret",
  "key.groq",
  "key.gemini",
  "key.nvidia",
  "key.cerebras",
  "key.openrouter",
  "key.anthropic",
  "key.openai",
  "key.deepinfra",
  "llm.provider",
  "llm.model",
  "llm.fallbackProvider",
  "llm.fallbackModel",
  // Proveedor DEDICADO del Asistente del panel (opcional). Si no se configura,
  // el Asistente usa la cadena normal (llm.provider + fallback). Separado del
  // bot a propósito: el Asistente hace ráfagas de llamadas cortas y le pega un
  // free tier de mucha cuota (Cerebras), mientras el bot habla con clientes.
  "assistant.provider",
  "assistant.model",
  "llm.fallbackModel2",
  "chatfuel.jsonSecret",
  // Clave del webhook ENTRANTE de systeme.io: UNA sola para toda la app (el endpoint
  // /webhook/systemeio es único). Global evita que se lea/escriba en workspaces distintos
  // (el receptor corre sin scope) y que una "regenerar" en un workspace rompa el resto.
  "systemeio.webhook.key",
  // SIO-FIRMA-1 · «clave secreta» con la que systeme.io firma los avisos (X-Webhook-Signature).
  "systemeio.webhook.secret",
  // WEBHOOK-RELAY-1 · mapa {canal:id → URL de instancia} con el que la instancia
  // central reparte a cada cliente los webhooks que Meta solo entrega a una URL
  // (Instagram y Página). Global porque los receptores corren sin scope de
  // workspace, y solo escribible por el administrador del stack: quien lo edite
  // decide a qué servidor se reenvían conversaciones de terceros.
  "relay.routes",
  "mcp.token",
  "mcp.url",
  "mcp.authHeader",
  "mcp.authPrefix",
  // LinkedIn OAuth app del stack (una para todos, estilo Meta App). clientId
  // público; clientSecret además en SECRET_KEYS (se cifra).
  "linkedin.clientId",
  "linkedin.clientSecret",
  // App CM ("LeadMatch Insights") — SEPARADA de la de Ads. clientId público;
  // clientSecret además en SECRET_KEYS (se cifra).
  "linkedin.cmClientId",
  "linkedin.cmClientSecret",
  // Google Ads: OAuth client + developer token, del stack/operador.
  "googleads.clientId",
  "googleads.clientSecret",
  "googleads.developerToken",
  // YouTube OAuth app del stack (T07-SEC): mismo patrón que LinkedIn y Google
  // Ads — clientId público global, clientSecret global+secret (se cifra).
  // loadSettings absorbe filas legadas per-WS de claves globales al arrancar.
  "youtube.clientId",
  "youtube.clientSecret",
  // TYPEFORM-1 · app OAuth de Typeform del stack: una para todos los clientes.
  "typeform.clientId",
  "typeform.clientSecret",
  // Identidad legal y marca del despliegue: son del OPERADOR del stack, no de
  // cada workspace (las páginas /privacidad, /terminos y /eliminar-datos son
  // únicas y públicas). Globales ⇒ solo el admin del sistema puede tocarlas.
  "legal.business",
  "legal.email",
  "legal.site",
  "legal.host",
  "legal.entityForm",
  "legal.entityState",
  "legal.entityEin",
  "legal.entityFileNumber",
  "legal.entityFormed",
  "legal.entityRegAgent",
  "legal.entityRegAddress",
  "legal.address",
  "legal.representative",
  "legal.dpoContact",
  "legal.jurisdiction",
  "brand.operator",
  "brand.env",
  // MARCA-BLANCA-2 · nombre del producto (pestaña del navegador, pantalla de acceso,
  // previsualización de enlaces). Es del OPERADOR del stack, como brand.operator:
  // global, y sólo tocable por el administrador del sistema.
  "brand.product_name",
  // WS-LIFECYCLE · días entre archivar un workspace y poder purgarlo. Es política
  // de retención DEL STACK (una sola para todos los negocios), así que global y
  // solo tocable por el admin del sistema. La lee db.ts (dbWorkspaceRetentionDays)
  // con SQL directo sobre '_global_' para no crear un ciclo de imports; el env
  // WORKSPACE_RETENTION_DAYS manda sobre esta key, y a falta de ambos son 30 días.
  "workspace.retentionDays",
  // Estudio de diseño: es infraestructura DEL STACK (un daemon self-hosted y una
  // clave de Gemini que paga quien monta el panel), igual que las claves de IA.
  // Global y solo tocable por el admin del sistema; el env sigue mandando.
  "opendesign.url",
  "opendesign.user",
  "opendesign.pass",
  "opendesign.geminiKey",
  "opendesign.model",
  "opendesign.geminiBase",
]);
// NOTA: autopost.zernioApiKey es PER-WORKSPACE (en SECRET_KEYS, no aquí): cada
// workspace tiene su PROPIA cuenta/API key de Zernio → aislamiento total de redes.

export function isGlobalKey(key: string): boolean {
  return GLOBAL_KEYS.has(key);
}

/** Tenant id reservado donde viven todas las GLOBAL_KEYS. NO es un workspace real. */
const GLOBAL_TENANT_ID = "_global_";

// Fallback a env cuando la clave no está en BD.
const ENV_FALLBACK: Record<string, string> = {
  "llm.provider": "LLM_PROVIDER",
  "llm.model": "LLM_MODEL",
  "whatsapp.verifyToken": "WHATSAPP_VERIFY_TOKEN",
  "whatsapp.accessToken": "WHATSAPP_ACCESS_TOKEN",
  "whatsapp.phoneNumberId": "WHATSAPP_PHONE_NUMBER_ID",
  "whatsapp.appSecret": "WHATSAPP_APP_SECRET",
  "meta.igAccessToken": "IG_ACCESS_TOKEN",
  "meta.igBusinessId": "IG_BUSINESS_ACCOUNT_ID",
  // App ID + App Secret + Embedded Signup Config ID: gestionados por env (estilo
  // ManyChat). Una sola Meta App aprobada por el admin del stack sirve a todos
  // los tenants. Los usuarios finales nunca ven estos valores.
  "meta.appId": "META_APP_ID",
  "meta.appSecret": "IG_APP_SECRET",
  "meta.appSecretAlt": "IG_APP_SECRET_ALT",
  "meta.gatewayUrl": "META_GATEWAY_URL",
  "meta.gatewayKey": "META_GATEWAY_KEY",
  "meta.waEmbeddedConfigId": "META_WA_EMBEDDED_CONFIG_ID",
  "meta.waCoexistenceConfigId": "META_WA_COEXISTENCE_CONFIG_ID",
  "meta.adsToken": "META_ADS_TOKEN",
  "meta.adAccountId": "META_AD_ACCOUNT_ID",
  "key.groq": "GROQ_API_KEY",
  "key.gemini": "GEMINI_API_KEY",
  "key.nvidia": "NVIDIA_API_KEY",
  "key.cerebras": "CEREBRAS_API_KEY",
  "key.openrouter": "OPENROUTER_API_KEY",
  "assistant.provider": "ASSISTANT_PROVIDER",
  "assistant.model": "ASSISTANT_MODEL",
  "key.anthropic": "ANTHROPIC_API_KEY",
  "key.openai": "OPENAI_API_KEY",
  "admin.user": "ADMIN_USER",
  "admin.pass": "ADMIN_PASSWORD",
  // MARCA-BLANCA-2 · respaldo de entorno para el nombre del producto, como el resto
  // de la marca. Sin ajuste ni variable, manda el nombre genérico de fábrica.
  "brand.product_name": "BRAND_PRODUCT_NAME",
  "chatfuel.jsonSecret": "CHATFUEL_JSON_SECRET",
  "linkedin.clientId": "LINKEDIN_CLIENT_ID",
  "linkedin.clientSecret": "LINKEDIN_CLIENT_SECRET",
  "linkedin.cmClientId": "LINKEDIN_CM_CLIENT_ID",
  "linkedin.cmClientSecret": "LINKEDIN_CM_CLIENT_SECRET",
  "googleads.clientId": "GOOGLE_ADS_CLIENT_ID",
  "googleads.clientSecret": "GOOGLE_ADS_CLIENT_SECRET",
  "googleads.developerToken": "GOOGLE_ADS_DEVELOPER_TOKEN",
  // Estudio de diseño (Open Design). Se configuraba SOLO por variables del
  // servidor y encima se leía una vez al arrancar: cambiar la clave exigía
  // redesplegar, y quien no tiene acceso al Railway no podía tocarlo. Ahora
  // manda el ajuste del panel y el env queda de respaldo, como en el resto.
  "opendesign.url": "OD_URL",
  "opendesign.user": "OD_USER",
  "opendesign.pass": "OD_PASS",
  "opendesign.geminiKey": "OD_GEMINI_KEY",
  "opendesign.model": "OD_MODEL",
  "opendesign.geminiBase": "OD_GEMINI_BASE",
  // MCP-POR-INSTANCIA-1 · El puente con systeme.io (publicar páginas, leer embudos)
  // habla con `systemeio-mcp`, que es un SERVICIO APARTE con su propio despliegue.
  // Cada instancia tiene que apuntar al SUYO: el de un cliente corre en el Railway
  // de ese cliente, y su dirección es la que genera ese despliegue.
  //
  // Hasta ahora estas cuatro claves solo se podían fijar por API con una sesión de
  // administrador del stack: no estaban aquí, así que montar una instancia nueva
  // exigía una llamada a mano después de desplegar. Con el respaldo de entorno, la
  // URL del MCP se pega en Railway junto al resto y la instancia arranca hablando.
  // El ajuste del panel sigue mandando sobre el entorno, como en todo lo demás.
  //
  // OJO · no hay valor de fábrica a propósito (SIN-DEFAULTS-LM-1): antes apuntaba al
  // servidor del operador, y el puente le manda el correo y la contraseña de
  // systeme.io del workspace para abrir sesión. Cada cual al suyo.
  "mcp.url": "MCP_URL",
  "mcp.token": "MCP_TOKEN",
  "mcp.authHeader": "MCP_AUTH_HEADER",
  "mcp.authPrefix": "MCP_AUTH_PREFIX",
};

function envFallback(key: string): string {
  const envName = ENV_FALLBACK[key];
  return (envName && process.env[envName]) || "";
}

// ---- Cache ----
// Antes había un solo Map<key,value> singleton. Ahora hay dos pisos:
//   cacheGlobal    → GLOBAL_KEYS resueltas del namespace '_global_'
//   cacheByWs[ws]  → keys per-ws resueltas para ese workspace
// Una sola query (dbAllSettingsWithTenant) las rellena todas en loadSettings().
const cacheGlobal = new Map<string, string>();
const cacheByWs = new Map<string, Map<string, string>>();

function getWsCache(wsId: string): Map<string, string> {
  let m = cacheByWs.get(wsId);
  if (!m) {
    m = new Map<string, string>();
    cacheByWs.set(wsId, m);
  }
  return m;
}

/**
 * Carga todas las settings desde BD a las dos caches (global + per-ws).
 * Idempotente: limpia las caches antes de llenarlas.
 */
export async function loadSettings(): Promise<void> {
  cacheGlobal.clear();
  cacheByWs.clear();
  for (const row of await dbAllSettingsWithTenant()) {
    let value: string;
    try {
      value = row.is_secret ? decrypt(row.value) : row.value;
    } catch {
      // ROTACION-ENC-1 · solo se llega aquí con ALLOW_INSECURE_ENC_KEY=true (o en local
      // sin clave): assertEncKeyOrMigrate ya lo ha listado. El valor se ignora, no se pisa.
      console.error(`[ROTACION-ENC-1] ajuste «${row.key}» (negocio ${row.tenant_id}) no se puede descifrar con la clave actual: se ignora hasta que se vuelva a introducir.`);
      continue;
    }
    if (GLOBAL_KEYS.has(row.key)) {
      // Globales: ignoramos tenant_id real, las metemos en cacheGlobal.
      // Si una key global se grabó accidentalmente per-WS (legacy), gana la
      // última vista — best-effort: setGlobalSetting siempre escribe en '_global_'.
      cacheGlobal.set(row.key, value);
    } else {
      getWsCache(row.tenant_id).set(row.key, value);
    }
  }
}

/**
 * SECURITY-FIX 2026-06-20 (F5) · fail-fast de cripto en el ARRANQUE.
 *
 * Antes: si faltaba APP_ENC_KEY, crypto.ts cifraba con sha256('dev-only-insecure-key')
 * (clave pública conocida) con solo un warn → los secretos (tokens Meta/WhatsApp/IG/
 * Ads, keys LLM) quedaban ≈ en texto plano, y el SECRET de firma de cookies de admin
 * (admin.ts, deriva de APP_ENC_KEY||'dev') era forjable.
 *
 * Estrategia (cero pérdida de datos, no tumba al owner bien configurado):
 *  - Fuera de producción: no hace nada (dev local conserva el fallback dev-key).
 *  - En producción: inspecciona los secretos en BD. Si hay secretos cifrados con la
 *    dev-key Y existe APP_ENC_KEY real → los MIGRA (re-cifra con la clave real) en el
 *    primer boot (rotación segura, posible gracias al auth-tag GCM que distingue qué
 *    clave cifró cada valor). Si faltara APP_ENC_KEY → THROW (fail-fast accionable).
 *  - Kill-switch de emergencia: ALLOW_INSECURE_ENC_KEY=true degrada el throw a error
 *    ruidoso (para arrancar en un incidente y poder migrar).
 *
 * Se ejecuta UNA vez en main() tras initDb() y ANTES de loadSettings().
 */
export async function assertEncKeyOrMigrate(): Promise<void> {
  const allow = process.env.ALLOW_INSECURE_ENC_KEY === "true";
  const fail = (msg: string): void => {
    if (allow) { console.error(`[crypto][INSEGURO] ${msg} · ALLOW_INSECURE_ENC_KEY=true → se arranca igual`); return; }
    throw new Error(`[crypto] ${msg}`);
  };
  const hasKey = appEncKeyPresent();
  // ROTACION-ENC-1 · fuera de producción solo actuamos si hay APP_ENC_KEY: con la clave
  // de desarrollo no hay nada que rotar y el onboarding local no debe romperse.
  if (!isProd() && !hasKey) return;
  if (isProd() && appEncKeyWeak()) {
    console.warn("[crypto] APP_ENC_KEY presente pero DÉBIL (corta o placeholder). Usa una cadena larga aleatoria (>=32 chars) en Railway. No bloquea el arranque.");
  }

  let rows: Array<{ key: string; value: string; is_secret: boolean; tenant_id: string }> = [];
  try {
    rows = await dbAllSettingsWithTenant();
  } catch (e) {
    // Si no podemos inspeccionar la BD, no bloqueamos por esto: exigimos al menos
    // que la key esté presente para no operar a ciegas con la dev-key.
    if (isProd() && !hasKey) fail(`No se pudo leer settings para verificar cripto y falta APP_ENC_KEY: ${(e as Error).message}`);
    return;
  }

  const secrets = rows.filter((r) => r.is_secret && typeof r.value === "string" && r.value.startsWith("enc:"));
  if (!hasKey) {
    // Producción sin clave: como hasta ahora, no se arranca (salvo kill-switch).
    const devKeyed = secrets.filter((r) => isEncryptedWithDevKey(r.value)).length;
    fail(devKeyed
      ? `Hay ${devKeyed} secreto(s) cifrados con la clave de desarrollo insegura. Define APP_ENC_KEY en Railway y reinicia: se migrarán automáticamente.`
      : "APP_ENC_KEY ausente en producción. Defínela en Railway (cadena larga aleatoria) antes de arrancar.");
    return;
  }

  // ROTACION-ENC-1 · con APP_ENC_KEY presente, todo secreto que no abra con ella se
  // intenta con APP_ENC_KEY_OLD (rotación) y con la clave de desarrollo (migración F5)
  // y se vuelve a cifrar con la actual. Idempotente: en el siguiente arranque todo abre
  // con la actual y no se toca nada. Lo que no abre con ninguna se lista por NOMBRE
  // (nunca el valor) y el proceso no arranca: una credencial ilegible no se descarta
  // en silencio ni se opera con ella.
  const ilegibles: string[] = [];
  const recifrados = { anterior: 0, desarrollo: 0 };
  for (const r of secrets) {
    const rot = rotarCifrado(r.value);
    if (!rot) { ilegibles.push(`ajuste «${r.key}» (negocio ${r.tenant_id})`); continue; }
    if (!rot.cambiado) continue;
    try {
      await dbSetSettingForTenant(r.tenant_id, r.key, rot.valor, true);
      if (rot.origen === "anterior") recifrados.anterior++; else recifrados.desarrollo++;
      console.log(`[ROTACION-ENC-1] ajuste «${r.key}» (negocio ${r.tenant_id}) re-cifrado con la clave actual (venía de la clave ${rot.origen}).`);
    } catch (e) {
      ilegibles.push(`ajuste «${r.key}» (negocio ${r.tenant_id}: no se pudo guardar re-cifrado: ${(e as Error).message})`);
    }
  }
  let qr = { total: 0, rotados: 0, ilegibles: [] as string[] };
  try {
    qr = await dbRotarCifradoQr(rotarCifrado);
  } catch (e) {
    ilegibles.push(`WhatsApp por QR (no se pudieron revisar sus tablas: ${(e as Error).message})`);
  }
  // El WhatsApp por QR ilegible NO bloquea el arranque (antes de ROTACION-ENC-1 tampoco):
  // esa sesión tendrá que volver a vincularse escaneando el código.
  for (const q of qr.ilegibles) console.error(`[ROTACION-ENC-1] ${q} no abre con APP_ENC_KEY${claveAnteriorPresente() ? " ni con APP_ENC_KEY_OLD" : ""}: habrá que volver a vincular ese WhatsApp.`);
  const resumen = `${secrets.length} secreto(s) de ajustes y ${qr.total} valor(es) del WhatsApp por QR comprobados · re-cifrados: ${recifrados.anterior} con APP_ENC_KEY_OLD, ${recifrados.desarrollo} desde la clave de desarrollo, ${qr.rotados} del WhatsApp por QR`;
  if (ilegibles.length) {
    fail(`[ROTACION-ENC-1] ${ilegibles.length} valor(es) cifrados NO abren con APP_ENC_KEY${claveAnteriorPresente() ? " ni con APP_ENC_KEY_OLD" : ""}: ${ilegibles.join("; ")}. Si acabas de cambiar APP_ENC_KEY, pon la clave anterior en APP_ENC_KEY_OLD y vuelve a desplegar: se re-cifrarán solos. Si la clave anterior se ha perdido, esas credenciales hay que volver a introducirlas en el panel (para arrancar mientras tanto ignorándolas: ALLOW_INSECURE_ENC_KEY=true). ${resumen}.`);
    return;
  }
  if (recifrados.anterior || recifrados.desarrollo || qr.rotados) console.warn(`[ROTACION-ENC-1] ${resumen}. APP_ENC_KEY_OLD ya puede retirarse de las variables.`);
  else console.log(`[crypto] APP_ENC_KEY OK · ${resumen}.`);
}

/**
 * WS-ISOLATION 2026-06-04 · default flip: WS_STRICT_SECRETS pasa a true.
 *
 * Antes (legacy): un WS recien creado heredaba TODAS las settings del WS
 * 'default' (incluidos tokens Meta/WhatsApp/IG/Ads/etc). UX comoda pero
 * insegura en multi-tenant: un operador con acceso al WS nuevo podia
 * consumir los tokens del WS original sin que el owner lo supiera.
 *
 * Ahora (default safe): un WS recien creado arranca VACIO. El operador
 * conecta sus credenciales explicitamente. Cero herencia transparente de
 * tokens/secrets/IDs entre workspaces. La unica fuente compartida son las
 * GLOBAL_KEYS (Meta App de stack, llm provider/keys, admin del panel,
 * chatfuel secret, MCP bridge) — todo lo demas vive per-WS.
 *
 * Opt-out explicito: WS_STRICT_SECRETS=false en env restaura el comportamiento
 * legacy. Pensado para deploys single-tenant que no quieren tocar nada.
 *
 * Notar que esto NO afecta a las GLOBAL_KEYS — esas siguen siendo
 * compartidas como hasta ahora.
 */
const WS_STRICT_SECRETS = process.env.WS_STRICT_SECRETS === "false" ? false : true;

/**
 * Valor efectivo: cascada según naturaleza de la key.
 * - GLOBAL_KEYS: cacheGlobal → env → fallback
 * - per-WS:      cacheByWs[wsActual] → (sin herencia bajo WS_STRICT_SECRETS) → env → fallback
 *
 * WS-ISOLATION 2026-06-04 (default ON):
 *   Bajo WS_STRICT_SECRETS=true (default), un WS distinto de 'default' NUNCA
 *   hereda valores de cacheByWs['default']. El operador conecta sus credenciales
 *   en el WS nuevo explicitamente. Si no hay valor propio, devolvemos env (por
 *   compat con deploys single-tenant que dejan tokens en env vars) o vacio.
 *
 *   Esto rompe con el comportamiento legacy donde un WS nuevo heredaba toda la
 *   config del WS original (Meta accounts, WhatsApp numbers, branding, etc.).
 *   El nuevo modelo es: WS nuevo = pizarra en blanco, salvo GLOBAL_KEYS.
 *
 * Opt-out legacy: WS_STRICT_SECRETS=false → cualquier key (secreta o no)
 * vuelve a heredar transparente desde 'default'. Util para single-tenant.
 *
 * SIN cambios de firma: cualquier call-site existente sigue funcionando, y el
 * resultado depende del scope ALS abierto por el caller upstream (router/scheduler).
 * Si nadie abrió scope, currentWorkspaceId() devuelve 'default' y todo se
 * comporta como antes del refactor (sin herencia entre 'default' y 'default').
 */
export function get(key: string, fallback?: string): string {
  if (GLOBAL_KEYS.has(key)) {
    const v = cacheGlobal.get(key);
    if (v) return v;
    const env = envFallback(key);
    return env || fallback || "";
  }
  const wsId = currentWorkspaceId();
  const perWs = cacheByWs.get(wsId)?.get(key);
  if (perWs) return perWs;
  // WS-ISOLATION 2026-06-04 · sin herencia bajo strict mode (default).
  // Si el WS activo no tiene la key, NO miramos a 'default' (evitamos leak
  // transversal de credenciales/IDs/branding entre workspaces). Caemos a env
  // (por compat single-tenant) o vacio. Para volver al comportamiento legacy
  // de herencia, set WS_STRICT_SECRETS=false en env.
  if (wsId !== DEFAULT_WORKSPACE_ID && !WS_STRICT_SECRETS) {
    const inherited = cacheByWs.get(DEFAULT_WORKSPACE_ID)?.get(key);
    if (inherited) return inherited;
  }
  const env = envFallback(key);
  return env || fallback || "";
}

/**
 * MARCA-BLANCA-3 · Valor que sale SÓLO de la base de datos, sin respaldo del entorno.
 *
 * `get()` mezcla a propósito dos orígenes —lo que un administrador guardó desde el panel
 * y lo que quien despliega dejó en una variable del servidor— porque para casi todo da
 * igual de dónde venga. Hay un sitio donde no da igual: la edición de cliente no puede
 * enseñar jamás la marca de quien fabrica el panel, y una instancia de cliente se
 * aprovisiona copiando las variables de una plantilla del operador. Si esa marca entrara
 * por variable del servidor, el panel del cliente la pintaría sin que nadie la escribiera.
 *
 * Por eso quien necesite distinguir «lo escribió el administrador de ESTA instancia» de
 * «venía heredado del entorno» lee por aquí y decide después, en vez de confiar en que
 * una clave concreta no tenga respaldo de entorno hoy (mañana puede tenerlo).
 *
 * Misma cascada que `get()` en lo demás: global → caché global; per-workspace → caché del
 * workspace activo, sin herencia desde 'default' bajo WS_STRICT_SECRETS.
 */
export function getSoloBd(key: string): string {
  if (GLOBAL_KEYS.has(key)) return cacheGlobal.get(key) || "";
  const wsId = currentWorkspaceId();
  const perWs = cacheByWs.get(wsId)?.get(key);
  if (perWs) return perWs;
  if (wsId !== DEFAULT_WORKSPACE_ID && !WS_STRICT_SECRETS) {
    return cacheByWs.get(DEFAULT_WORKSPACE_ID)?.get(key) || "";
  }
  return "";
}

/**
 * DOMINIO-INSTANCIA-1 · URL pública de ESTA instancia, sin barra final.
 *
 * Existe porque el stack pasa a desplegarse UNA INSTANCIA POR CLIENTE, cada una en
 * su propio Railway y su propio dominio. Hasta ahora media docena de sitios caían al
 * literal `https://business-stack.ingenierobinario.com` cuando no había nada
 * configurado, y eso en la instancia de un cliente significa que sus enlaces de pago,
 * sus enlaces cortos y el píxel que pega en su web apuntan a NUESTRO servidor: su
 * tráfico y sus clics se pierden (o peor, se cuentan en nuestro tenant).
 *
 * Cascada, de más específico a más general:
 *   1. `links.domain` — ajuste per-workspace, si alguien lo fijó a mano.
 *   2. `PUBLIC_BASE_URL` — variable de entorno, la que pone el alta de un cliente.
 *   3. `RAILWAY_PUBLIC_DOMAIN` — la inyecta Railway sola. Es la red de seguridad:
 *      una instancia recién montada tiene URL correcta aunque nadie fije nada.
 *   4. `http://localhost:<PORT>` — solo se llega aquí en local y en los arneses.
 *      Un enlace a localhost es evidentemente de desarrollo; uno al dominio de otra
 *      instancia parece bueno y se lleva el tráfico del cliente. Se avisa por consola.
 *
 * Lo que NUNCA devuelve es el dominio de otra instancia, que era el defecto anterior.
 */
let _avisoUrlPublica = false;
export function urlPublica(): string {
  const limpia = (u: string): string => u.trim().replace(/\/+$/, "");
  const cfg = get("links.domain");
  if (cfg) return limpia(cfg);
  const env = process.env.PUBLIC_BASE_URL;
  if (env) return limpia(env);
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railway) return limpia("https://" + railway.trim().replace(/^https?:\/\//, ""));
  if (!_avisoUrlPublica) {
    _avisoUrlPublica = true;
    // Aviso para quien despliega (consola del servidor, nunca a la vista del cliente).
    console.warn(
      "[settings] Esta instancia no sabe cuál es su dirección pública, así que los enlaces " +
        "cortos y el píxel de la web saldrán apuntando a localhost. Lo configura el administrador " +
        "del sistema al desplegar la instancia.",
    );
  }
  return "http://localhost:" + (process.env.PORT || "8080");
}

/**
 * DOMINIO-INSTANCIA-1 · URL pública de CONFIANZA. Como `urlPublica()` pero **sin
 * `links.domain`**, y exigiendo https.
 *
 * Por qué existe: `links.domain` es un ajuste per-workspace que NO está en
 * GLOBAL_KEYS, así que lo escribe cualquier usuario del panel con la vista de
 * Ajustes. Para pintar los enlaces cortos del propio negocio eso está bien —el daño
 * se limita a su tenant—, pero hay un sitio donde no vale: la URL que se le da a Meta
 * como destino de los webhooks de un número. Si saliera de ahí, ese usuario podría
 * apuntar la entrega de SUS mensajes entrantes (y de paso el verify token) a un
 * servidor suyo, sin ser administrador del stack y sin que nada lo impidiera.
 *
 * Aquí solo se admiten las fuentes que fija quien despliega: `PUBLIC_BASE_URL` y
 * `RAILWAY_PUBLIC_DOMAIN`. Y solo https: Meta rechaza cualquier otra cosa, y un valor
 * sin esquema («midominio.com») produciría una URL inválida.
 *
 * Devuelve "" si no hay ninguna fuente fiable. Quien llame debe tratarlo como «no se
 * puede fijar» y decirlo, nunca inventarse un destino.
 */
export function urlPublicaDeConfianza(): string {
  const soloHttps = (u: string): string => {
    const limpia = u.trim().replace(/\/+$/, "");
    return /^https:\/\/[a-z0-9.-]+(:\d{2,5})?$/i.test(limpia) ? limpia : "";
  };
  const env = process.env.PUBLIC_BASE_URL;
  if (env) return soloHttps(env);
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railway) return soloHttps("https://" + railway.trim().replace(/^https?:\/\//, ""));
  return "";
}

/**
 * Interruptor de RESPUESTAS AUTOMÁTICAS por canal (per-workspace).
 * Clave: `bots.autoReply` = JSON {"whatsapp":true,"instagram":true,"facebook":true}
 * UI: panel → Bots & Conocimiento → "¿Quién contesta los mensajes?".
 *
 * DEFAULT = APAGADO (opt-in explícito, decisión del dueño del producto). Un canal
 * solo contesta solo si alguien lo ha ENCENDIDO a conciencia en el panel. Ausente /
 * vacío / JSON corrupto / canal no presente ⇒ false: ante la duda, el bot calla y el
 * mensaje queda en la Bandeja para que lo conteste una persona. Nunca respondemos
 * automáticamente "por accidente".
 *
 * Apagado ⇒ en ese canal la IA no contesta la charla libre, no se manda el saludo
 * del perfil y los seguimientos «si no responde» de las difusiones esperan
 * (broadcast-flows.ts). Los flujos, las palabras clave, los comentarios —incluidas
 * sus respuestas con IA—, el envío de las difusiones, las bajas y el aviso de fuera
 * de horario SIGUEN según su propia configuración: el motor de flujos corre antes del
 * corte (INCIDENTE 2026-07-14). El mensaje SÍ se registra. Lo que ve el cliente está
 * en el desplegable «Qué apaga este interruptor» del panel (BOT-02): si cambias esto,
 * cámbialo allí.
 *
 * Lee de la cache en memoria (0 queries por mensaje) y resuelve el workspace vía
 * currentWorkspaceId(): los handlers de webhook ya corren dentro de runWithWorkspace().
 */
export type AutoReplyChannel = "whatsapp" | "instagram" | "facebook" | "tiktok";

/** Canales gobernados por el interruptor. 'tiktok' entra por el puente de Chatfuel. */
export const AUTO_REPLY_CHANNELS: AutoReplyChannel[] = ["whatsapp", "instagram", "facebook", "tiktok"];

export function autoReplyOn(chan: AutoReplyChannel): boolean {
  const raw = get("bots.autoReply");
  if (!raw) return false;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return o[chan] === true;
  } catch {
    return false;
  }
}

/**
 * BOT-POR-CUENTA-1 · Qué bot atiende UNA cuenta concreta. La clave del mapa es
 * la misma cadena `channel_account` que ya se guarda en cada contacto —
 * 'wa:<phoneNumberId>', 'ig:<igId>', 'fb:<pageId>'— así que no hay que
 * inventar identificadores nuevos. Tres valores, iguales en los tres canales:
 *   ''          → la IA elige el perfil que mejor encaje
 *   '__none__'  → solo humano: el bot calla en esa cuenta
 *   '<botId>'   → siempre ese perfil
 * Setting `bots.byAccount` (JSON, por workspace). WhatsApp mantiene además sus
 * claves antiguas como respaldo hasta que se guarde una vez desde el panel.
 */
export function botForAccount(account: string): string {
  const key = String(account || "").trim();
  if (!key) return "";
  try {
    const o = JSON.parse(get("bots.byAccount") || "{}") as Record<string, unknown>;
    const v = o[key];
    if (typeof v === "string") return v;
  } catch { /* mapa corrupto → como si no hubiera nada configurado */ }
  return "";
}

/** Estado de todos los canales (lo pinta el panel). Misma semántica que autoReplyOn(). */
export function autoReplyAll(): Record<AutoReplyChannel, boolean> {
  return {
    whatsapp: autoReplyOn("whatsapp"),
    instagram: autoReplyOn("instagram"),
    facebook: autoReplyOn("facebook"),
    tiktok: autoReplyOn("tiktok"),
  };
}

/**
 * Escribe el valor en el namespace que corresponda (global o el WS activo)
 * y refresca la cache local. SIN cambios de firma — el caller no necesita
 * saber si la key es global o no, lo decide isGlobalKey().
 */
export async function set(key: string, value: string): Promise<void> {
  const secret = isSecretKey(key);
  const stored = secret ? encrypt(value) : value;
  if (GLOBAL_KEYS.has(key)) {
    await dbSetSettingForTenant(GLOBAL_TENANT_ID, key, stored, secret);
    cacheGlobal.set(key, value);
    return;
  }
  const wsId = currentWorkspaceId();
  await dbSetSettingForTenant(wsId, key, stored, secret);
  getWsCache(wsId).set(key, value);
  // W6: si la key afecta al routing de canales (whatsapp.*/meta.*) la
  // cache de channel→ws queda stale y debe limpiarse. La invalidación
  // es O(1) (clear del Map) y los webhooks repueblan al siguiente hit.
  if (key.startsWith("whatsapp.") || key.startsWith("meta.")) {
    invalidateChannelRoutingCache();
  }
}

/**
 * ¿De dónde sale el valor? Para mostrarlo en el panel.
 * Mirar cache directo es más rápido (y consistente con get()) que pegar a BD.
 *
 * WS-ISOLATION 2026-06-04 · bajo strict mode (default), un WS distinto de
 * 'default' NO muestra "bd" para keys que solo existen en 'default' — porque
 * en ese caso get() no las devolveria (no hay herencia). Asi el panel refleja
 * fielmente lo que el operador ve.
 */
export async function source(key: string): Promise<"bd" | "env" | "vacío"> {
  if (GLOBAL_KEYS.has(key)) {
    if (cacheGlobal.has(key)) return "bd";
  } else {
    const wsId = currentWorkspaceId();
    if (cacheByWs.get(wsId)?.has(key)) return "bd";
    // Solo reconocemos 'default' como fuente si NO estamos en strict mode
    // (legacy behavior · WS_STRICT_SECRETS=false).
    if (!WS_STRICT_SECRETS && wsId !== DEFAULT_WORKSPACE_ID && cacheByWs.get(DEFAULT_WORKSPACE_ID)?.has(key)) {
      return "bd";
    }
  }
  const env = ENV_FALLBACK[key];
  return env && process.env[env] ? "env" : "vacío";
}

// ===========================================================================
// APIs ws-explícitas (sin ALS) — para schedulers/handlers que iteran sobre
// varios workspaces y no quieren depender del scope ALS del caller.
// ===========================================================================

/** Lee una key global sin importar el ALS. Tira si la key NO es global. */
export function getGlobalSetting(key: string, fallback?: string): string {
  if (!GLOBAL_KEYS.has(key)) {
    throw new Error(`getGlobalSetting: '${key}' no es una global key`);
  }
  const v = cacheGlobal.get(key);
  if (v) return v;
  const env = envFallback(key);
  return env || fallback || "";
}

/** Escribe una key global. Tira si la key NO es global. */
export async function setGlobalSetting(key: string, value: string): Promise<void> {
  if (!GLOBAL_KEYS.has(key)) {
    throw new Error(`setGlobalSetting: '${key}' no es una global key`);
  }
  const secret = isSecretKey(key);
  const stored = secret ? encrypt(value) : value;
  await dbSetSettingForTenant(GLOBAL_TENANT_ID, key, stored, secret);
  cacheGlobal.set(key, value);
}

/**
 * Lee una key per-WS para un workspace concreto. Si la key es global, delega
 * en getGlobalSetting (porque las globales no son per-WS). Si no hay valor
 * para ese WS, cae a env → fallback (bajo strict mode no hay herencia).
 *
 * WS-ISOLATION 2026-06-04 · mismo comportamiento que get() — sin herencia
 * desde 'default' bajo WS_STRICT_SECRETS (default true).
 */
export function getWorkspaceSetting(wsId: string, key: string, fallback?: string): string {
  if (GLOBAL_KEYS.has(key)) return getGlobalSetting(key, fallback);
  const id = (wsId || "").trim() || DEFAULT_WORKSPACE_ID;
  const perWs = cacheByWs.get(id)?.get(key);
  if (perWs) return perWs;
  // Sin herencia bajo strict mode.
  if (id !== DEFAULT_WORKSPACE_ID && !WS_STRICT_SECRETS) {
    const inherited = cacheByWs.get(DEFAULT_WORKSPACE_ID)?.get(key);
    if (inherited) return inherited;
  }
  const env = envFallback(key);
  return env || fallback || "";
}

/**
 * Escribe una key per-WS para un workspace concreto. Si la key es global,
 * delega en setGlobalSetting (la grabaría en _global_ aunque pases otro wsId
 * para mantener invariante: globales nunca tienen rows per-tenant).
 */
export async function setWorkspaceSetting(wsId: string, key: string, value: string): Promise<void> {
  if (GLOBAL_KEYS.has(key)) {
    await setGlobalSetting(key, value);
    return;
  }
  const id = (wsId || "").trim() || DEFAULT_WORKSPACE_ID;
  const secret = isSecretKey(key);
  const stored = secret ? encrypt(value) : value;
  await dbSetSettingForTenant(id, key, stored, secret);
  getWsCache(id).set(key, value);
  // W6: ver comentario en set(). Mismo trigger por prefijo.
  if (key.startsWith("whatsapp.") || key.startsWith("meta.")) {
    invalidateChannelRoutingCache();
  }
}

/** ¿Esta instalación ya está unificada en DeepInfra, o sigue en el puente? */
export function llmUnificado(): boolean {
  return !!get("key.deepinfra");
}

/** Resuelve la IA activa: DeepInfra. Sin clave, chat() avisa con claridad. */
/** MODELO-HEREDADO-1 · `llm.model` (y sus hermanas) las escribió el panel de la
 *  época Groq/Gemini/OpenRouter con ids de ESOS proveedores. Nada las borró al
 *  unificar en DeepInfra, así que seguían mandando: el id viejo viaja a
 *  DeepInfra, devuelve 404 y el bot se queda mudo. Solo se acepta un valor
 *  guardado si es uno de los modelos del catálogo unificado; cualquier otra
 *  cosa se ignora y manda el del panel. Así los residuos que ya están en la BD
 *  dejan de tener efecto sin tener que tocar la base a mano. */
const MODELOS_VALIDOS = new Set<string>([MODELOS.bot, MODELOS.respaldo, MODELOS.asistente]);
function modeloGuardado(key: string, porDefecto: string): string {
  const m = (get(key) || "").trim();
  if (m && MODELOS_VALIDOS.has(m)) return m;
  if (m) console.warn(`[llm] ${key}="${m}" no es del catálogo unificado (proveedor antiguo) → se usa ${porDefecto}`);
  return porDefecto;
}

/** Los tres modelos que se usarán DE VERDAD (ya pasados por la lista blanca),
 *  para que el panel pueda enseñar quién contesta en vez de pedir fe. */
export function modelosEfectivos(): { bot: string; respaldo: string; asistente: string } {
  return {
    bot: modeloGuardado("llm.model", MODELOS.bot),
    respaldo: modeloGuardado("llm.fallbackModel", MODELOS.respaldo),
    asistente: modeloGuardado("assistant.model", MODELOS.asistente),
  };
}

export function resolveLlm(): {
  provider: ProviderId;
  baseURL: string;
  model: string;
  apiKey: string;
} {
  const apiKey = get("key.deepinfra");
  if (apiKey) {
    return {
      provider: "deepinfra",
      baseURL: PROVIDERS.deepinfra.baseURL,
      model: modeloGuardado("llm.model", MODELOS.bot),
      apiKey,
    };
  }
  return { provider: "deepinfra", baseURL: PROVIDERS.deepinfra.baseURL, model: PROVIDERS.deepinfra.defaultModel, apiKey: "" };
}

/**
 * Proveedor DEDICADO del Asistente del panel. Con un solo proveedor ya no
 * es «otro proveedor» sino OTRO MODELO: el Asistente elige rutas y devuelve
 * JSON, y al bot que habla con clientes le conviene otro perfil. Vacío =
 * usa el mismo modelo que el bot.
 */
export function resolveAssistantLlm(): {
  provider: ProviderId;
  baseURL: string;
  model: string;
  apiKey: string;
} | null {
  if (!llmUnificado()) return null;
  const model = modeloGuardado("assistant.model", MODELOS.asistente);
  const base = resolveLlm();
  if (!base.apiKey || model === base.model) return null;
  return { ...base, model };
}

/**
 * Modelo de RESPALDO. Mismo proveedor y misma clave, otro modelo: cubre que
 * el proveedor retire un modelo o lo tenga saturado, que es exactamente lo
 * que pasó el 2026-08-19 cuando Groq retiró la familia Llama y el respaldo
 * llevaba meses muerto sin que nadie lo viera.
 */
export function resolveLlmFallback(): {
  provider: ProviderId;
  baseURL: string;
  model: string;
  apiKey: string;
} | null {
  const model = modeloGuardado("llm.fallbackModel", MODELOS.respaldo);
  const base = resolveLlm();
  if (!base.apiKey) return null;
  if (model === base.model) return null;
  return { ...base, model };
}
