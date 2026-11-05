/**
 * Servicio único desplegable en Railway:
 *   - /webhook            → WhatsApp Cloud API (bot IA + CRM + automatismos)
 *   - /webhook/instagram  → comentarios IG → motor de automatizaciones
 *   - /admin              → panel de configuración (password)
 *   - /health
 */
import "dotenv/config";
import crypto from "node:crypto";
import Fastify from "fastify";
import { qrOnMessage, qrOnAck, qrOnHistory, qrOnLinked, qrOnSelf, qrOnDisabled, qrOnReaction, qrList, qrHuerfanas, qrRestoreAll, qrCloseAll, type QrHistoryItem } from "./whatsapp-qr.js";
import { dbPing, dbGetWorkspace, dbAdoptarCuenta, dbLimpiarNombresDeEco, dbFormBySlugPublico, dbGetFormMedia, dbGetFormRespMedia, dbFbAnotarEntrada } from "./db.js";
import { retiradoPorTelefono, retiradoPorAcct, olvidarRetirado, retirarNumero, telefonoRecordado, recordarTelefonos, soloDigitos } from "./wa-retired.js";
import { limpiarHistoricoAlArrancar } from "./wa-historico.js";
import { initDb, dbInsertWaEvent, dbBroadcastMarcarRespuesta, dbUpsertWaMessageStatus, dbUpsertWaReaction, dbWaLastOutTs, dbDraftTenantById, dbClaimOnce, dbReleaseClaim, dbPutInboxMedia, dbGetConversation, dbSetContactUtmIfEmpty, dbCurrentFlowRunsForPhone, dbEndedFlowRunsForPhone, dbPutAvatar, dbAvatarAge, dbBackfillConvAccts, dbScanLegacyTplConvs, dbRewriteConversationTurns, type WaMessageStatus } from "./db.js";
import { loadSettings, get, assertEncKeyOrMigrate, autoReplyOn, botForAccount, urlPublica } from "./settings.js";
import { sendText, markRead, verifySignature, verifySignatureAny, resolveWaNumber, runWithWaNumber, listWaNumbers, downloadWaMediaFor, listTemplates, tplRenderText, type WaTemplate, type WaNumber } from "./whatsapp.js";
import { botById, quienAtiende, fueraDeHorario } from "./bots.js";
import { think, extractControls } from "./brain.js";
import { classifyBot } from "./router.js";
import { getSession, ensureSession, append, appendPersistent, mergeQrHistoryPersistent, reset, botHasNotSpoken, repinBot, depurarDuplicadosDeTurnos } from "./memory.js";
import { handleCommentEvent } from "./automations.js";
import { resolveAccount, runWithAccount, sendIgText, fetchIgUserProfile, downloadMetaAttachment, igCommentLink } from "./instagram.js";
import { getFbAccount, listFbAccounts, sendFbText, fetchFbUserProfile } from "./facebook.js";
import { startPostScheduler } from "./scheduler.js";
import { touchContact, enrichContact, getContact, updateContact, setHuman, createContact, OPT_OUT_TAG, isOptOutLabel } from "./contacts.js";
import { runWaTriggers, cancelSequences, startScheduler } from "./waflows.js";
import { resumeFlow, noteReplyToActiveRuns, triggerFlows, triggerStoryFlows, triggerIgDmFlows, startFlowIgDm, listFlows, startFlowScheduler, runFlowByIntent, bloqueaPorPrueba, fev, flujosIgEnOtraPublicacion } from "./flows.js";
import { startSioLeadsScheduler } from "./sio-leads.js";
import { startSioFunnelsScheduler } from "./sio-funnels.js";
import { startSioBookingsScheduler, sioBookingsPokeWorkspace } from "./sio-bookings.js";
import { startEmailEventsScheduler } from "./email-events.js";
import { startPurchaseReconcileScheduler } from "./purchase-guard.js";
import { registerAdmin, warmLogoVersions, iniciarSesionesRevocadas } from "./admin.js";
import { comprobarSecretosDeArranque } from "./crypto.js";
import { registerLegal } from "./legal.js";
import { registerAssistant } from "./assistant.js";
import { registerMcp } from "./mcp-server.js";
import { startAutopostScheduler } from "./autopost/schedule.js";
import { startYoutubeCommentPoller } from "./youtube-comments.js";
import { startLinkedinCommentPoller } from "./linkedin-comments.js";
import { startFacebookCommentSafetyNet } from "./facebook-comments.js";
import { startSaludConexiones } from "./salud-conexiones.js";
import { startMcpBridgeWorker } from "./mcp-bridge.js";
import { startAnalyticsWarmer } from "./analytics.js";
import { redirectUrl, recordClick, ogForUrl, imageHeaderDimensions } from "./links.js";
import { downloadPublic, isPublicAddress, PublicDownloadError } from "./public-download.js";
import { recordPageView, recordPageDuration, pixelSiteTenant, esWebConPixel, visitRefFor, resolveVisitRef, esMarcaVisita } from "./web-analytics.js";
import { recordWebhook } from "./webhookDebug.js";
import { avisarContacto, avisarLeadNuevo, dedupVentana, notificar } from "./notifications.js";
import { handleSystemeioWebhook } from "./systemeio-webhook.js";
import { startSnapshotWorker } from "./snapshots.js";
import { registerBroadcastFlowsWorker, onBroadcastInboundReply } from "./broadcast-flows.js";
import { logActivity } from "./activity.js";
import { runWithWorkspace, currentWorkspaceId } from "./workspace.js";
import { contarVisita, enviarFormulario, subirArchivoFormulario, paginaFormulario, paginaNoEncontrada, cspFormulario, origenCita, citaDe, paginaReservada, completarReserva } from "./formularios.js";
import { resolveWorkspaceByChannel, isSuspendedRoute, canalesParaPasarela } from "./channel-routing.js";
import { repartir as relayRepartir, RELAY_HEADER, RELAY_HEADER_VALUE } from "./webhook-relay.js";
import { entregaDePasarela, declararCanales, modoMetaApp, pasarelaIncompleta } from "./meta-app.js";
import { alInvalidarRutas } from "./channel-routing-cache.js"; // PASARELA-META-2
import { aiTransparencyNotice, needsAiDisclosure } from "./ai-compliance.js";
import { confianzaProxy, describirConfianza } from "./proxy-confianza.js";

// disableRequestLogging: corta los logs automáticos por cada request (ruido + coste con
// el polling cada pocos s); se conservan los app.log.error/warn/info explícitos.
// El panel autenticado admite 150MB para uploads JSON+base64 (imágenes y vídeo del programador/
// carruseles). El binario real ≈ bodyLimit / 1.37 (overhead base64) → ~108MB de
// fichero. Quitamos el tope artificial de 25MB del cliente; este es el límite real.
// NOTA: subidas MUY grandes (cientos de MB / GB) no son viables por base64-JSON
// (memoria + posible corte del proxy); para eso haría falta un canal binario
// directo (octet-stream / URL prefirmada), aún no implementado.
// Las rutas públicas tienen 1 MiB. registerAdmin permite 150 MiB tras autenticar.
// Sólo un proxy de confianza puede aportar la IP del cliente (PROXY-CONFIANZA-1).
const proxyConfianza = confianzaProxy();
const app = Fastify({ logger: true, disableRequestLogging: true, bodyLimit: 1024 * 1024,
  trustProxy: proxyConfianza.valor });
app.log.info("PROXY-CONFIANZA-1 · " + describirConfianza(proxyConfianza));
// PROXY-CONFIANZA-1 · Deja en el log, por proceso, la primera petición de cada forma de
// X-Forwarded-For (por número de entradas): de quién llega (el proxy), cuántas entradas
// trae y de cuál salió req.ip. Es la prueba de que la confianza encaja con la topología
// real; sin confianza y con X-Forwarded-For, avisa: los topes por IP agruparían a todos.
// En Railway lo esperado es entradasXff=2, ipEsPrimeraXff=true e ipEsXRealIp=true; si
// apareciera entradasXff=3, el edge estaría dejando pasar la X-Forwarded-For del cliente
// (sigue sin leerse: queda a la izquierda de lo que se confía).
const proxyFormasVistas = new Set<number>();
app.addHook("onRequest", async (req) => {
  const xff = req.headers["x-forwarded-for"];
  if (!xff || proxyFormasVistas.size >= 6) return;
  const entradas = String(xff).split(",").map((v) => v.trim()).filter(Boolean);
  if (proxyFormasVistas.has(entradas.length)) return;
  proxyFormasVistas.add(entradas.length);
  const peer = String(req.socket?.remoteAddress || "");
  const datos = {
    peer, entradasXff: entradas.length,
    ipEsUltimaXff: req.ip === entradas[entradas.length - 1],
    ipEsPrimeraXff: entradas.length > 1 && req.ip === entradas[0],
    ipEsXRealIp: req.ip === String(req.headers["x-real-ip"] || "").trim(),
    ipEsPeer: req.ip === peer,
    ipPublica: isPublicAddress(String(req.ip || "").replace(/^::ffff:/i, "")),
  };
  if (proxyConfianza.valor === false) {
    if (proxyFormasVistas.size === 1) app.log.warn(datos, "PROXY-CONFIANZA-1 · llega X-Forwarded-For y no hay proxy de confianza: los topes por IP usan la IP del socket");
  } else app.log.info(datos, "PROXY-CONFIANZA-1 · muestra");
});

// Compresión Brotli/gzip de TODAS las respuestas de texto (el HTML del panel pesa
// ~1.58MB sin comprimir → ~410KB br; los JSON de /admin/api se sondean cada pocos s).
// threshold:1024 deja respuestas diminutas (GIF /pv, /health) sin tocar; Fastify
// negocia Accept-Encoding solo. El `await` es OBLIGATORIO: el plugin engancha vía
// hook onRoute, que solo afecta a rutas registradas DESPUÉS de que el plugin cargue.
// Sin await, el plugin bootea en app.listen() — con las ~375 rutas ya registradas —
// y NADA se comprime (verificado: content-encoding ausente en /admin).
await app.register(import("@fastify/compress"), {
  global: true,
  encodings: ["br", "gzip", "deflate"],
  threshold: 1024,
});

// SEC #19: cabeceras de seguridad para el panel admin. CSP restrictiva +
// X-Frame-Options DENY + Referrer-Policy + X-Content-Type-Options. Solo se
// aplica a rutas /admin/* (panel + API). NO se aplica a /webhook/* (Meta no
// las necesita y CSP rompe la verificacion del hub.challenge) ni a / o
// /health (publico minimo). El callback de OAuth ya inyecta su propio CSP
// via <meta http-equiv> y el header de aqui es compatible (mismo intent).
app.addHook("onSend", async (req, reply, payload) => {
  const url = req.raw.url || "";
  if (!url.startsWith("/admin")) return payload;
  // ADJUNTO-PUBLICO-1 · si el handler ya fijó su propia política (los adjuntos públicos van
  // con «sandbox» y sin referer), se conserva: este hook corre después y la pisaba.
  if (!reply.hasHeader("content-security-policy")) reply.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // connect.facebook.net = SDK JS de Facebook (Embedded Signup / Coexistence de WhatsApp).
      // Sin esto la CSP bloquea el script y FB.login no abre el popup.
      "script-src 'self' 'unsafe-inline' https://connect.facebook.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      // PROG-BULK-1 · blob: para las miniaturas locales de la subida masiva del Programador
      // (URL.createObjectURL del archivo antes de subirlo); sin él salían en blanco.
      "img-src 'self' https: data: blob:",
      // DISENO-1 · sin media-src el <video> de la vista previa del Programador caía en default-src
      // 'self' y el navegador lo bloqueaba (maqueta negra + 4 errores de CSP por edición).
      "media-src 'self' https: blob: data:",
      // CSP-CONNECT-1 · el panel solo habla con su propio servidor; el SDK de Facebook con
      // *.facebook.com. Con «https:» un script colado podía mandar la sesión a cualquier sitio.
      "connect-src 'self' https://*.facebook.com https://connect.facebook.net",
      // El SDK de FB inyecta un iframe oculto (xd_arbiter en staticxx/facebook) para
      // la comunicación cross-domain del Embedded Signup.
      // FORMULARIOS-8 · YouTube, Vimeo y Loom: el vídeo de una pregunta en la vista previa del editor
      // de formularios (el marco srcdoc hereda esta política).
      "frame-src 'self' https://www.facebook.com https://staticxx.facebook.com https://web.facebook.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].concat(req.routeOptions.url === "/admin/pages/drafts/:id/html" ? ["sandbox allow-scripts"] : []).join("; "),
  );
  reply.header("X-Frame-Options", "DENY");
  if (!reply.hasHeader("referrer-policy")) reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("X-Content-Type-Options", "nosniff");
  // CSP-CONNECT-1 · el panel no usa cámara, micrófono ni geolocalización: que ningún marco
  // incrustado pueda pedirlos.
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  // SEC-HSTS-1 · solo detrás de https (Railway). Sin includeSubDomains ni preload para no
  // afectar a otros subdominios del dominio del cliente; en local por http no se emite.
  if (String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https" || req.protocol === "https") {
    reply.header("Strict-Transport-Security", "max-age=31536000");
  }
  return payload;
});

// Dedup anti-loop IA: si el mismo texto entró en los últimos 60s para el
// mismo contacto, omitimos `think()` (evita "Hola → Hola → Hola" que
// genera 6 respuestas variadas de la IA cuando el cliente solo está
// testeando o spam-clicando).
const recentDedupe = new Map<string, number>();
const DEDUPE_WINDOW_MS = 60_000;
setInterval(() => {
  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  for (const [k, ts] of recentDedupe) if (ts < cutoff) recentDedupe.delete(k);
}, 5 * 60_000);

app.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (_req, body, done) => {
    try {
      done(null, {
        raw: body as Buffer,
        json: JSON.parse((body as Buffer).toString("utf8") || "{}"),
      });
    } catch (e) {
      done(e as Error);
    }
  },
);

// HEALTH-BD-1 · con base, /health comprueba que responde (SELECT 1, 2 s): si no, 503 y Railway
// lo ve. Sin base (modo memoria), como siempre. La ruta no cambia: railway.json la usa.
app.get("/health", async (_req, reply) => {
  if (!(await dbPing(2000))) return reply.code(503).send({ ok: false, db: "timeout" });
  return { ok: true };
});

// ---------- Link tracker (/r/:token) ----------
// PREVIEW-OG-1 · Rastreadores de previsualización (WhatsApp/Meta/Telegram…): visitan el
// enlace en cuanto se ENVÍA el mensaje, antes de que la persona toque nada. Dos problemas
// que resuelve este bloque:
//  1) Contaban como CLIC y aplicaban la etiqueta clico-* al lead (¡sin haber clicado!):
//     métricas infladas y nodos «¿abrió el enlace?» engañados. Ahora los bots NO cuentan.
//  2) La tarjeta de WhatsApp salía BORROSA: el destino (systeme.io) no declara
//     og:image:width/height. A los bots les servimos las OG del destino + dimensiones
//     explícitas (medidas de verdad). OJO (medido el 2-sep-2026): con eso la miniatura
//     sale nítida, pero la tarjeta de un enlace enviado por la API es SIEMPRE la
//     pequeña (miniatura cuadrada); el formato grande solo lo genera el móvil del
//     remitente. Para imagen grande por API: tarjeta con botón (ENLACE-TARJETA-1).
const PREVIEW_BOT_UA = /facebookexternalhit|whatsapp|twitterbot|linkedinbot|telegrambot|slackbot|discordbot|skypeuripreview|pinterest\/|vkshare|googlebot|bingbot/i;
// ogForUrl (título, descripción, imagen medida) vive ahora en links.ts: lo comparte con el
// motor de flujos (ENLACE-TARJETA-1).
// OG-CUADRADO · Imagen 1:1 de marca para la previsualización de WhatsApp (miniatura cuadrada
// nítida, sin el recorte feo del banner ancho). Se genera UNA vez con canvas (banner de marca
// centrado sobre un cuadrado color crema = letterbox) y se cachea en RAM.
// SIN-DEFAULTS-LM-1 · El banner venía cableado al logo de LeadMatch en el CDN del
// operador, así que cualquier cliente que activara el modo cuadrado enseñaba una
// marca ajena en la previsualización de SUS enlaces. Ahora la imagen sale del
// ajuste `links.preview_square_img` y, sin él, el modo cuadrado no se aplica.
// La caché va POR NEGOCIO y por imagen: era un único buffer de módulo, así que dos
// workspaces con imágenes distintas se pisaban la previsualización el uno al otro.
const _cuadrados = new Map<string, { ts: number; src: string; buf: Buffer }>();
function bannerCuadrado(): string {
  return (get("links.preview_square_img") || "").trim();
}
async function pngCuadrado(ws: string): Promise<Buffer> {
  const BANNER = bannerCuadrado();
  if (!BANNER) throw new Error("Sin imagen de marca configurada");
  const hit = _cuadrados.get(ws);
  if (hit && hit.src === BANNER && Date.now() - hit.ts < 24 * 3600_000) return hit.buf;
  // DESCARGA-PUBLICA-1 · la dirección sale de un ajuste, así que la descarga va por el
  // descargador endurecido (bloquea loopback, redes privadas y el endpoint de metadatos
  // del proveedor, fija la IP y revalida cada salto) y con tope de bytes. Con `fetch` a
  // pelo, cualquiera podía pedir esta ruta SIN sesión y usarla para sondear la red
  // interna: la petición la hace el servidor, no quien la pide.
  const r = await downloadPublic(BANNER, { timeoutMs: 6000, maxBytes: 10 * 1024 * 1024 });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(r.body);
  const S = 1000;
  const cv = createCanvas(S, S);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#F2E9DE"; // crema de fondo del letterbox
  ctx.fillRect(0, 0, S, S);
  const dh = Math.round((img.height / img.width) * S); // banner a todo el ancho, centrado en vertical
  ctx.drawImage(img, 0, Math.round((S - dh) / 2), S, dh);
  const buf = cv.toBuffer("image/png");
  _cuadrados.set(ws, { ts: Date.now(), src: BANNER, buf });
  return buf;
}
// `?r=<token>` dice de qué enlace corto es la miniatura, y de ahí sale el negocio dueño
// de la imagen. Sin él se caía en el workspace `default` y un cliente enseñaba la marca
// de otro. El token ya es público (es el propio enlace corto), así que no destapa nada.
// `/og/lm-square.png` se mantiene como alias: WhatsApp cachea las previsualizaciones y
// los enlaces ya compartidos siguen pidiendo esa ruta.
for (const ruta of ["/og/cuadrado.png", "/og/lm-square.png"]) {
  app.get(ruta, async (req, reply) => {
    const token = String((req.query as Record<string, string>)?.r || "").trim();
    const dest = token ? await redirectUrl(token) : null;
    const ws = dest?.tenant_id || "default";
    return runWithWorkspace(ws, async () => {
      if (!bannerCuadrado()) return reply.code(404).type("text/plain").send("Imagen no encontrada.");
      try {
        const png = await pngCuadrado(ws);
        return reply.type("image/png").header("cache-control", "public, max-age=86400").send(png);
      } catch {
        // Aquí se redirigía 302 a la dirección del ajuste. Eso convertía el dominio del
        // panel en un redirector abierto hacia cualquier sitio, en una ruta que Meta y
        // WhatsApp ya tienen por buena. Si no se puede generar, no hay imagen.
        return reply.code(404).type("text/plain").send("Imagen no encontrada.");
      }
    });
  });
}
// ENLACE-TARJETA-1 · Imagen de cabecera de la tarjeta con botón, RE-CODIFICADA por el panel:
// Meta solo acepta JPEG/PNG de 8 bits RGB/RGBA (un PNG de paleta —como el del Training—, un
// WEBP o un PNG de 16 bits se rechazan en diferido y el mensaje no llega nunca, sin error
// síncrono). Se descarga la og:image del destino, se aplana sobre blanco y se sirve como JPEG
// (máx. 1600 px de ancho), cacheado 24 h en RAM. Si no se puede decodificar, 302 al original.
// El origen va en la query (?u=base64url), no en un segmento de la ruta: Fastify limita los
// parámetros de ruta a 100 caracteres (414) y una URL de CDN codificada los supera.
const _tarjetaImg = new Map<string, { ts: number; buf: Buffer }>();
app.get("/og/tarjeta.jpg", async (req, reply) => {
  let src = "";
  try { src = Buffer.from(String((req.query as { u?: string })?.u || ""), "base64url").toString("utf8"); } catch { /* inválido */ }
  if (!/^https?:\/\//i.test(src)) return reply.code(404).type("text/plain").send("Imagen no encontrada.");
  const hit = _tarjetaImg.get(src);
  if (hit && Date.now() - hit.ts < 24 * 3600_000) return reply.type("image/jpeg").header("cache-control", "public, max-age=86400").send(hit.buf);
  try {
    const r = await downloadPublic(src, { timeoutMs: 8000, maxBytes: 10 * 1024 * 1024 });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const raw = r.body;
    // Integridad ANTES de tocar el decodificador nativo: un fichero truncado o basura no
    // debe llegar a canvas (un fallo nativo tumbaría el proceso entero, no solo la petición).
    const esPng = raw.length > 64 && raw[0] === 0x89 && raw[1] === 0x50 && raw.subarray(raw.length - 12).includes(Buffer.from("IEND"));
    const esJpeg = raw.length > 64 && raw[0] === 0xff && raw[1] === 0xd8 && raw[raw.length - 2] === 0xff && raw[raw.length - 1] === 0xd9;
    if (!esPng && !esJpeg) throw new Error("no es un PNG/JPEG completo (" + raw.length + " bytes)");
    // DESCARGA-PUBLICA-1 · Limita la expansión ANTES del decodificador nativo.
    const dimensions = imageHeaderDimensions(raw);
    if (!dimensions.w || !dimensions.h || dimensions.w * dimensions.h > 24_000_000) {
      throw new PublicDownloadError("too_large", "La imagen supera las dimensiones permitidas.");
    }
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(raw);
    const scale = Math.min(1, 1600 / img.width, 1600 / img.height);
    const W = Math.max(1, Math.round(img.width * scale));
    const H = Math.max(1, Math.round(img.height * scale));
    const cv = createCanvas(W, H);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff"; // aplana la transparencia: JPEG no tiene alfa
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    const buf = cv.toBuffer("image/jpeg", 88);
    _tarjetaImg.set(src, { ts: Date.now(), buf });
    if (_tarjetaImg.size > 200) { const k = _tarjetaImg.keys().next().value; if (k) _tarjetaImg.delete(k); }
    return reply.type("image/jpeg").header("cache-control", "public, max-age=86400").send(buf);
  } catch (e) {
    // DESCARGA-PUBLICA-2 · sólo «blocked» corta en seco; el resto recupera su respaldo.
    //
    // «blocked» (dirección privada) NO se redirige, y es deliberado: mandar al cliente
    // a 169.254.169.254 o a 127.0.0.1 convertiría esta ruta —pública y sin autenticar—
    // en un pivote para que el SSRF lo hiciera quien nos llama. Lo cubre t02-e2e con
    // «imagen de una dirección privada se rechaza sin redirigir».
    //
    // Los DEMÁS fallos sí vuelven al 302 de siempre («mejor el original que un 500»).
    // Al blindar la descarga, el catch pasó a devolver 404 para CUALQUIER
    // PublicDownloadError y se llevó por delante ese respaldo: una imagen del cliente
    // demasiado grande, con una redirección de más o que tarda, dejaba la tarjeta de
    // WhatsApp/Meta SIN foto aunque la original se viera perfectamente. Esos tres casos
    // no dicen nada de la red interna, así que devolver el original no filtra nada.
    if (e instanceof PublicDownloadError && e.code === "blocked") {
      return reply.code(404).type("text/plain").send("Imagen no encontrada.");
    }
    console.error("[og/tarjeta] no se pudo re-codificar: " + ((e as Error).message || e));
    return reply.redirect(src, 302);
  }
});
app.get("/r/:token", async (req, reply) => {
  const token = (req.params as { token: string }).token;
  const dest = await redirectUrl(token);
  if (!dest) return reply.code(404).type("text/plain").send("Link no encontrado.");
  const headers = req.headers || {};
  const ua = String(headers["user-agent"] || "");
  const ip = ipDe(req); // PROXY-CONFIANZA-1: la izquierda de X-Forwarded-For la escribe el cliente
  const ref = String(headers["referer"] || headers["referrer"] || "");
  // ENLACE-PAGO-2 · Los enlaces de pago NO llevan ?p= (nada personal en la URL): el
  // dueño del enlace viene de la propia fila (context_id) — así el clic se atribuye
  // igual y el cliente solo ve un enlace corto limpio.
  const isPay = dest.context_kind === "payment";
  const phone = String((req.query as Record<string, string>)?.p || "") || (isPay ? dest.context_id : "");
  if (PREVIEW_BOT_UA.test(ua)) {
    // AMBITO-PREVIA-1 · Los tres ajustes que deciden la tarjeta (`links.preview_no_image`,
    // `links.preview_square_og` y `links.preview_square_img`) se leían FUERA de ámbito de
    // negocio, así que salían siempre los del workspace `default`: el enlace de un cliente
    // se pintaba con la configuración —y la marca— de otro. El dueño ya estaba a mano, es
    // el mismo `dest.tenant_id` que usan el registro del clic y el redirect de abajo.
    return runWithWorkspace(dest.tenant_id || "default", async () => {
    // Rastreador de previsualización: NI clic NI etiqueta. Servimos las OG del destino con
    // dimensiones explícitas (tarjeta grande nítida) y un salto JS para humanos mal detectados.
    // OG-SIN-IMAGEN · Si `links.preview_no_image`='on', se sirve la tarjeta SOLO con título y
    // descripción, sin og:image. Motivo (petición del owner): algunas páginas de destino
    // (systeme.io) traen una imagen que WhatsApp recorta a un cuadrado pequeño y sale borrosa;
    // preferimos una tarjeta de texto limpia a una imagen mal recortada. Reversible por ajuste.
    // ENLACE-PAGO-OG · La tarjeta de un enlace de PAGO es SIEMPRE la de la página de
    // pago real (su og:title/description/image, tal cual): el cliente tiene que
    // reconocer lo que va a comprar. Los modos "sin imagen" y "cuadrado de marca"
    // no aplican a estos enlaces.
    const noImage = !isPay && get("links.preview_no_image") === "on";
    // OG-CUADRADO · Si `links.preview_square_og`='on', servimos NUESTRA imagen cuadrada de marca
    // (/og/lm-square.png) en vez de la del destino. Motivo: WhatsApp muestra los enlaces de bot
    // en tarjeta pequeña con miniatura CUADRADA; el banner ancho de systeme.io se recorta feo,
    // pero una imagen 1:1 se ve nítida. Anula el modo sin-imagen.
    // SIN-DEFAULTS-LM-1 · sin imagen propia configurada no hay modo cuadrado: antes
    // caía en el logo del operador.
    const squareOg = !isPay && get("links.preview_square_og") === "on" && !!bannerCuadrado();
    const og = await ogForUrl(dest.url);
    const esc = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    // DOMINIO-INSTANCIA-1 · sin literal de otra instancia: Host de la petición y, si
    // falta, la URL pública de ESTA (PUBLIC_BASE_URL / RAILWAY_PUBLIC_DOMAIN).
    const origin = "https://" + String(headers["x-forwarded-host"] || headers["host"] || urlPublica().replace(/^https?:\/\//, "")).split(",")[0].trim();
    const imgUrl = squareOg ? origin + "/og/cuadrado.png?r=" + encodeURIComponent(token) : og.image;
    const imgW = squareOg ? 1000 : og.w, imgH = squareOg ? 1000 : og.h;
    const showImg = !!imgUrl && !noImage;
    // SIN-DEFAULTS-LM-1 · respaldo del título: el dominio del destino, no una marca ajena.
    const hostDest = (() => { try { return new URL(dest.url).hostname.replace(/^www./, ""); } catch { return ""; } })();
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(og.title || hostDest)}</title>
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(dest.url)}">
<meta property="og:site_name" content="${esc((() => { try { return new URL(dest.url).hostname; } catch { return ""; } })())}">
<meta property="og:title" content="${esc(og.title || hostDest)}">
${og.desc ? `<meta property="og:description" content="${esc(og.desc)}">` : ""}
${showImg ? `<meta property="og:image" content="${esc(imgUrl)}">` : ""}
${showImg && imgW >= 300 ? `<meta property="og:image:width" content="${imgW}"><meta property="og:image:height" content="${imgH}">${!squareOg ? `<meta name="twitter:card" content="summary_large_image">` : ""}` : ""}
</head><body><script>location.replace(${JSON.stringify(dest.url)})</script><a href="${esc(dest.url)}">Continuar</a></body></html>`;
    return reply.type("text/html; charset=utf-8").send(html);
    });
  }
  // Best-effort log, no bloquea redirect.
  recordClick(token, { phone, ua, ip, ref, tenant_id: dest.tenant_id }).catch(() => {});
  // CLIC-ENLACE · Marcamos al contacto según el tipo de enlace de funnel que ABRE (nuestro
  // tracking propio, 100% fiable, no depende de systeme.io ni del token):
  //   …/registro… → "clico-registro"   ·   …/webinar… → "clico-webinar"
  // Lo usan los nodos de flujo "¿abrió el enlace?" para NO recordar a quien ya entró (y NUNCA
  // a un registrado, que siempre abre el enlace para registrarse). Fire-and-forget.
  let clicoTag = "";
  // Enlace de pago: señal BLANDA "posible apertura" (un reenvío o un escáner con UA
  // limpia también la disparan) — por eso el copy del panel dice "posible", no "abrió".
  if (isPay) clicoTag = "clico-pago";
  else if (/registro/i.test(dest.url)) clicoTag = "clico-registro";
  else if (/webinar/i.test(dest.url)) clicoTag = "clico-webinar";
  if (phone && clicoTag) {
    void runWithWorkspace(dest.tenant_id || "default", () =>
      enrichContact(phone, { tags: [clicoTag] }),
    ).catch(() => {});
  }
  // EMBUDO-PAGINAS-1 · destino = web con el píxel de este negocio → se le añade la marca anónima
  // del contacto (utm_content, o utm_term si el dueño ya usaba utm_content; si usa los dos, no
  // se toca). El píxel la arrastra por el embudo y /pv atribuye cada página al contacto.
  let destino = dest.url;
  if (phone) {
    try {
      const tn = dest.tenant_id || "default";
      // Solo para un contacto REAL de este negocio: `?p=` llega de la URL y cualquiera podría
      // acuñar la marca de un teléfono ajeno para falsear sus visitas.
      if (await esWebConPixel(tn, destino) && await runWithWorkspace(tn, () => getContact(phone)).catch(() => null)) {
        const u = new URL(destino);
        const campo = !u.searchParams.get("utm_content") ? "utm_content" : !u.searchParams.get("utm_term") ? "utm_term" : "";
        const marca = campo ? await visitRefFor(tn, phone) : "";
        if (campo && marca) { u.searchParams.set(campo, marca); destino = u.toString(); }
      }
    } catch (e) { console.warn("[r] marca de visita:", (e as Error).message); }
  }
  return reply.redirect(destino, 302);
});

// ---------- Píxel de analítica web (/pv) ----------
// Público: lo dispara el snippet inyectado en las páginas publicadas. Registra la
// visita y devuelve un GIF 1x1 transparente. Nunca bloquea ni falla hacia el cliente.
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
// SECURITY-FIX 2026-06-20 · cache RAM pageId→tenant para atribuir la visita al
// workspace dueño sin un SELECT por cada beacon (el mapeo draft→tenant es estable).
const _pvTenantCache = new Map<string, { tenant: string; ts: number }>();
const _PV_TENANT_TTL = 10 * 60 * 1000; // 10 min
// PIXEL-TENANT-1 · el «no sé de quién es» se recuerda MENOS tiempo: una web recién
// registrada empieza a contar en un minuto, no en diez.
const _PV_TENANT_TTL_SIN_DUENO = 60 * 1000;
// PIXEL-TENANT-1 · devuelve null cuando no se sabe de quién es la visita.
//
// Antes caía al literal 'default', que NO es un cajón de sastre: es un workspace real (el
// original de la instalación). Un píxel copiado a una web que nadie registró, o el id de
// una página borrada, le metía visitas ajenas en sus métricas. Ahora la visita se descarta:
// perder un dato desconocido es correcto; imputárselo a un cliente, no.
async function pvTenantFor(pageId: string): Promise<string | null> {
  if (!pageId) return null;
  const hit = _pvTenantCache.get(pageId);
  if (hit) {
    const ttl = hit.tenant ? _PV_TENANT_TTL : _PV_TENANT_TTL_SIN_DUENO;
    if (Date.now() - hit.ts < ttl) return hit.tenant || null;
  }
  // 1) Páginas publicadas (id de draft). 2) COUNCIL-FIX: sitios del píxel externo — el
  // slug se registró con su workspace al generar el snippet en el panel; sin este
  // fallback, las visitas de píxeles copiados caían todas al tenant 'default'.
  const tenant = (await dbDraftTenantById(pageId).catch(() => null))
    || (await pixelSiteTenant(pageId).catch(() => null))
    || "";
  _pvTenantCache.set(pageId, { tenant, ts: Date.now() });
  return tenant || null;
}
app.get("/pv", async (req, reply) => {
  try {
    const q = (req.query as Record<string, string>) || {};
    const headers = req.headers || {};
    const ua = String(headers["user-agent"] || "");
    const ip = ipDe(req); // PROXY-CONFIANZA-1
    // COUNCIL-FIX: si el snippet manda r= (aunque venga VACÍO = visita directa), ese es el
    // referrer. El fallback al header Referer solo aplica cuando el parámetro no viene:
    // el header de la petición del GIF es la URL de la PROPIA página, y con `q.r ||` toda
    // visita directa acababa clasificada como «Referido» de su propio dominio.
    const ref = q.r !== undefined ? String(q.r) : String(headers["referer"] || headers["referrer"] || "");
    // País del visitante: cabecera del CDN si el dominio está detrás de uno (Cloudflare,
    // Vercel, Fastly…). Si no llega, web-analytics cae a la región del idioma como aprox.
    const country = String(
      headers["cf-ipcountry"] || headers["x-vercel-ip-country"] || headers["x-country-code"] ||
      headers["x-geo-country"] || headers["fastly-geo-country"] || "",
    );
    if (q.d && q.n) {
      // Beacon de salida: tiempo de permanencia + scroll máximo (sc) + carga (lt) por nonce.
      // VISITA-TENANT-1 · el beacon de salida trae la misma p= que la vista (va en la base
      // B del snippet), así que se resuelve su workspace igual que en la vista y el UPDATE
      // va acotado: un nonce repetido de otra web no puede pisar la visita ajena.
      // Sin workspace conocido la vista no se guardó (misma regla que abajo), así que
      // el beacon de salida tampoco tiene fila que actualizar.
      pvTenantFor(String(q.p || ""))
        .then((tenantId) => {
          if (!tenantId) return;
          return recordPageDuration(String(q.n), Number(q.d), Number(q.sc), Number(q.lt), tenantId);
        })
        .catch(() => {});
    } else if (q.p || q.l) {
      const pid = String(q.p || "");
      // q.e presente = conversión (window.lmTrack("compra")); si no, vista de página.
      // us/um/uc/ut/uo = utm_source/medium/campaign/term/content · ci = click-id de
      // ads (gclid/fbclid/…, solo el nombre) · tz = getTimezoneOffset() del visitante.
      pvTenantFor(pid)
        .then((tenantId) => {
          // PIXEL-TENANT-1 · sin dueño conocido no se anota: la visita no es de nadie.
          if (!tenantId) return;
          // EMBUDO-PAGINAS-1 · la marca lmc_ (utm_content o utm_term) identifica al contacto y NO
          // es una campaña: se quita de la analítica. Solo cuenta si es de este mismo negocio.
          const uo = String(q.uo || ""), ut = String(q.ut || "");
          const marca = esMarcaVisita(uo) ? uo : esMarcaVisita(ut) ? ut : "";
          return (marca ? resolveVisitRef(marca, tenantId) : Promise.resolve("")).then((contact) => recordPageView({
            pageId: pid, label: String(q.l || ""), ref, ua, ip,
            path: String(q.pa || ""), lang: String(q.lg || ""), nonce: String(q.n || ""),
            country, event: String(q.e || ""), tenantId,
            // MARCA-PUBLICA-1 · el enlace de una respuesta pública lleva solo el código del contacto; la red
            // se deduce de su clave («yt:…» / «li:…») para que la visita se cuente como YouTube/LinkedIn.
            utmSource: String(q.us || "") || (/^yt:/i.test(contact) ? "youtube" : /^li:/i.test(contact) ? "linkedin" : ""),
            utmMedium: String(q.um || "") || (/^(yt|li):/i.test(contact) ? "comment" : ""), utmCampaign: String(q.uc || ""),
            utmTerm: esMarcaVisita(ut) ? "" : ut, utmContent: esMarcaVisita(uo) ? "" : uo, clickId: String(q.ci || ""),
            tzMin: q.tz !== undefined && q.tz !== "" ? Number(q.tz) : undefined,
            tzName: String(q.tzn || "").slice(0, 60),
            contact,
          }));
        })
        .catch(() => {});
    }
  } catch { /* el píxel nunca rompe la página del visitante */ }
  return reply
    .header("Content-Type", "image/gif")
    .header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
    .send(PIXEL_GIF);
});
// La raíz lleva al panel: si no hay sesión, /admin muestra el login.
app.get("/", async (_req, reply) => reply.redirect("/admin"));
// El asistente va PRIMERO a propósito: su hook onRoute construye el catálogo
// vivo de rutas y solo ve las que se registran después de él (todas las del
// panel nacen dentro de registerAdmin).
registerAssistant(app);
// MCP-1 · servidor MCP para IAs externas (/mcp). Reusa el panel vía inject: no depende del orden.
registerMcp(app);
registerLegal(app);
registerAdmin(app);

// ---------- WhatsApp ----------
app.get("/webhook", async (req, reply) => {
  const q = req.query as Record<string, string>;
  if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === get("whatsapp.verifyToken"))
    return reply.code(200).send(q["hub.challenge"]);
  return reply.code(403).send("forbidden");
});

// Coexistence: guarda como SALIENTES en la bandeja los mensajes que un agente escribió
// desde la APP VERDE de WhatsApp Business (Meta los reenvía como smb_message_echoes).
// Así el historial/estado del cliente queda unificado, se chatee por la app o por el panel.
// ECO-UNIFICADO-1 · ¿A qué número NUESTRO pertenece un eco de la app verde?
// Meta identifica el número por su phone_number_id de Coexistence, pero el negocio lo
// identifica por su TELÉFONO: si ese mismo teléfono está hoy conectado por otra vía
// (QR, o un phone_number_id nuevo), el eco pertenece a la conversación de ESA cuenta.
// Antes el eco se guardaba sin cuenta (o con el id viejo) y el mismo cliente salía dos
// veces en la Bandeja: «vía Número retirado» con lo escrito desde el móvil y otra fila
// con el número vivo. Se apunta además el teléfono del id, para que la Bandeja lo
// reconozca aunque ya no esté dado de alta.
async function cuentaDelEco(value: any): Promise<{ acct: string; botId: string; num: WaNumber | null }> {
  const pnid = String(value?.metadata?.phone_number_id ?? "").trim();
  const tel = soloDigitos(String(value?.metadata?.display_phone_number ?? "")) || telefonoRecordado(pnid);
  if (pnid && tel) await recordarTelefonos([[pnid, tel]]).catch(() => { /* la caché nunca rompe el webhook */ });
  const bot = (n: WaNumber): string => botById(n.botId && n.botId !== "__none__" ? n.botId : "")?.id || "";
  const directo = resolveWaNumber(pnid);
  if (directo) return { acct: "wa:" + pnid, botId: bot(directo), num: directo };
  if (tel) {
    const mismoTel = listWaNumbers(true).find((n) =>
      (n.transport === "qr" ? soloDigitos(qrList().find((q) => q.id === n.phoneNumberId)?.phone || "") : telefonoRecordado(n.phoneNumberId)) === tel);
    if (mismoTel) return { acct: "wa:" + mismoTel.phoneNumberId, botId: bot(mismoTel), num: mismoTel.token ? mismoTel : null };
  }
  return { acct: pnid ? "wa:" + pnid : "", botId: botById("")?.id || "", num: null };
}
async function handleSmbEchoes(value: any): Promise<void> {
  const echoes: any[] = value?.message_echoes || [];
  if (!echoes.length) return;
  const destino = await cuentaDelEco(value);
  const waNum = destino.num;
  const exec = async () => {
    for (const e of echoes) {
      const to: string = e?.to || "";                 // el cliente (destinatario del agente)
      if (!to) continue;
      const tsMs = Number(e?.timestamp) > 0 ? Number(e.timestamp) * 1000 : Date.now();
      // ECO-UNIFICADO-1 · una reacción desde el móvil es una reacción, no un mensaje:
      // se guarda como las del contacto (REACCIONES-1) y nunca como burbuja «[reaction]».
      if (e?.type === "reaction") {
        const targetId = String(e?.reaction?.message_id || "").trim();
        if (targetId) {
          await dbUpsertWaReaction({ message_id: targetId, from_role: "agent", emoji: String(e?.reaction?.emoji || ""), reacted_at: tsMs }).catch(() => {});
        }
        continue;
      }
      const text: string = e?.text?.body ?? (e?.type && e.type !== "text" ? `[${e.type}]` : "");
      if (!text) continue;
      await ensureSession(to, destino.botId);
      // saliente → aparece como "Tú:" en la bandeja. Con id y hora reales para que, si el
      // panel ya guardó este mismo envío, el eco lo COMPLETE en vez de duplicarlo.
      await append(to, { role: "assistant", content: text, at: tsMs, by: "movil", ...(destino.acct ? { acct: destino.acct } : {}), ...(e?.id ? { mid: String(e.id) } : {}) });
    }
  };
  if (waNum) await runWithWaNumber({ token: waNum.token, phoneId: waNum.phoneNumberId }, exec);
  else await exec();
}

// Coexistence: importación del historial (hasta ~6 meses) que Meta envía por chunks
// tras el onboarding de un número de la app verde. Lo volcamos a la bandeja para que
// el dueño vea sus conversaciones previas. Campo del webhook: `history`.
async function handleHistory(value: any): Promise<void> {
  const chunks: any[] = value?.history || [];
  if (!chunks.length) return;
  // ECO-UNIFICADO-1 · misma resolución de cuenta que los ecos: el historial es del
  // teléfono, no del identificador de Coexistence.
  const destino = await cuentaDelEco(value);
  const waNum = destino.num;
  const botId = destino.botId;
  const exec = async () => {
    for (const ch of chunks) {
      for (const thread of ch?.threads || []) {
        const customer: string = thread?.id || ""; // teléfono del cliente = clave de la conversación
        if (!customer) continue;
        await ensureSession(customer, botId);
        for (const m of thread?.messages || []) {
          if (m?.type === "reaction") continue; // ECO-UNIFICADO-1 · nunca una burbuja «[reaction]»
          const body: string = m?.text?.body ?? (m?.type && m.type !== "text" ? `[${m.type}]` : "");
          if (!body) continue;
          // Si el mensaje sale del cliente → entrante (user); si no → saliente (assistant).
          const role: "user" | "assistant" = String(m?.from || "") === customer ? "user" : "assistant";
          await append(customer, { role, content: body, ...(destino.acct ? { acct: destino.acct } : {}) });
        }
      }
    }
  };
  if (waNum) await runWithWaNumber({ token: waNum.token, phoneId: waNum.phoneNumberId }, exec);
  else await exec();
}

// Coexistence: sincronización del estado de la app verde. Hoy la usamos para los
// CONTACTOS (nombre real del cliente que tiene guardado la app). Campo: `smb_app_state_sync`.
async function handleAppStateSync(value: any): Promise<void> {
  const items: any[] = value?.state_sync || [];
  for (const it of items) {
    if (it?.type !== "contact") continue;
    const phone = String(it?.contact?.phone_number || "").replace(/[^\d]/g, "");
    const name = String(it?.contact?.full_name || it?.contact?.first_name || "").trim();
    if (!phone || !name) continue;
    try {
      const existing = await getContact(phone);
      if (existing) await updateContact(phone, { name });
      else await createContact({ phone, name });
    } catch { /* sync de contactos best-effort: nunca rompe el webhook */ }
  }
}

app.post("/webhook", async (req, reply) => {
  const { raw, json } = req.body as { raw: Buffer; json: any };
  recordWebhook("whatsapp", "📩 recibido (verificando firma)");
  // Firma: la app es UNA sola en Meta, así que aceptamos si valida con whatsapp.appSecret
  // O con meta.appSecret (evita el bug de config partida donde solo uno está puesto).
  const sigHdr = req.headers["x-hub-signature-256"] as string;
  const waSec = get("whatsapp.appSecret");
  const metaSec = get("meta.appSecret");
  // PASARELA-META-1 · o viene de nuestra pasarela, firmado con la clave de esta instancia.
  const _pas = entregaDePasarela(raw, req.headers);
  if (_pas === "repetida") return reply.code(200).send("ok"); // PASARELA-META-2 · ya entró: no se procesa dos veces
  const sigOk = _pas === "nueva" || verifySignature(raw, sigHdr, waSec) || (!!metaSec && metaSec !== waSec && verifySignature(raw, sigHdr, metaSec));
  if (!sigOk) {
    // PASARELA-META-2 · por la pasarela no hay secreto que revisar en el panel: lo que
    // falla es que el aviso no llega firmado por ella (p. ej. un número que Meta entrega
    // directo aquí). Mandar a buscar el App Secret era una pista falsa.
    recordWebhook("whatsapp", modoMetaApp() === "pasarela"
      ? "❌ Firma no válida: el aviso no viene de la pasarela"
      : "❌ FIRMA INVÁLIDA — revisa whatsapp.appSecret / meta.appSecret en el panel");
    return reply.code(401).send("bad signature");
  }
  reply.code(200).send("ok");

  // W6: routing canal→workspace. El phone_number_id viaja en
  // value.metadata.phone_number_id. Si el número no está dado de alta en ningún
  // workspace, cae a 'default' (regresión zero) y el resto del handler se
  // ejecuta como antes.
  const _waPid = String(json?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? "");
  const _wsId = await resolveWorkspaceByChannel("wa", _waPid);
  // WS-ARCHIVED-ROUTING: el número pertenece a un negocio ARCHIVADO → sumidero.
  // Ya hemos contestado 200 arriba: aceptamos la entrega y la descartamos sin
  // procesar. Nunca se procesa bajo 'default' (sería el negocio de otro).
  if (isSuspendedRoute(_wsId)) {
    recordWebhook("whatsapp", "⏸️ número de un negocio archivado — entrega aceptada y descartada sin procesar (pnid " + (_waPid || "?") + ")");
    console.warn(`[channel-routing] wa:${_waPid} → sumidero: evento descartado (workspace archivado)`);
    return;
  }
  await handleWhatsappPayload(json, _wsId, _waPid);
});

// WA-QR-1 · mismo pipeline de atención para ambos transportes. La ruta pública sigue
// exigiendo firma; el socket QR aporta directamente su workspace autenticado.
// RESULTADO-DIFUSION-1 · cada respuesta (texto, botón, nota de voz…) se apunta a la difusión
// que la provocó: por el mensaje citado si lo hay (los botones de plantilla siempre citan) y,
// si no, a la más reciente que esa persona recibió en las 72 h anteriores. Nunca rompe el webhook.
async function marcarRespuestaDifusion(msg: any, pid: string): Promise<void> {
  const boton = msg?.type === "button" ? String(msg.button?.text || "")
    : msg?.type === "interactive" ? String(msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "") : "";
  await dbBroadcastMarcarRespuesta(pid, String(msg?.from || ""), { citaId: String(msg?.context?.id || ""), boton });
}

async function handleWhatsappPayload(json: any, _wsId: string, _waPid: string): Promise<void> {
  await runWithWorkspace(_wsId, async () => {
  try {
    const change = json?.entry?.[0]?.changes?.[0];
    const value = change?.value;
    // ── Coexistence ───────────────────────────────────────────────────────────
    // Mensajes que un agente envió desde la APP VERDE de WhatsApp Business (no por la
    // API). Meta los reenvía como `smb_message_echoes` → los guardamos como SALIENTES
    // en la bandeja para que el estado/historial del cliente esté unificado.
    if (change?.field === "smb_message_echoes" || value?.message_echoes) {
      recordWebhook("whatsapp", "↩️ echo de la app verde (smb_message_echoes)");
      await handleSmbEchoes(value);
      return;
    }
    // Coexistence: importación de historial al onboardear un número de la app verde.
    if (change?.field === "history" || value?.history) {
      recordWebhook("whatsapp", "🕓 historial de la app verde (history) → importando a la bandeja");
      await handleHistory(value);
      return;
    }
    // Coexistence: sincronización de contactos/estado de la app verde.
    if (change?.field === "smb_app_state_sync" || value?.state_sync) {
      recordWebhook("whatsapp", "👤 contactos de la app verde (smb_app_state_sync)");
      await handleAppStateSync(value);
      return;
    }
    // ESTADO-WA-1 · El 200 de /messages no confirma entrega. Meta publica después
    // uno o varios statuses; guardarlos evita que la Bandeja pinte un ✓ falso y
    // permite enseñar el motivo exacto cuando Alexander u otro número falla.
    const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
    if (statuses.length) {
      const permitidos = new Set<WaMessageStatus>(["sent", "delivered", "read", "failed"]);
      for (const st of statuses) {
        const messageId = String(st?.id || "").trim();
        const status = String(st?.status || "").trim() as WaMessageStatus;
        if (!messageId || !permitidos.has(status)) continue;
        const err = Array.isArray(st?.errors) ? st.errors[0] : undefined;
        const errorCode = String(err?.code ?? "").slice(0, 80);
        const errorDetail = String(err?.error_data?.details || err?.message || err?.title || "").slice(0, 500);
        const recipient = String(st?.recipient_id || "").replace(/[^\d]/g, "");
        await dbUpsertWaMessageStatus({
          tenant_id: _wsId,
          phone_number_id: _waPid,
          message_id: messageId,
          user_id: recipient,
          status,
          status_at: Number(st?.timestamp) > 0 ? Number(st.timestamp) * 1000 : Date.now(),
          error_code: errorCode,
          error_detail: errorDetail,
        });
        if (status === "failed") {
          await logActivity({
            source: "wa-send",
            level: "error",
            status: errorCode || "failed",
            summary: `WhatsApp no entregó un mensaje${errorDetail ? `: ${errorDetail.slice(0, 160)}` : ""}`,
            payload: {
              file: "index.ts",
              fn: "POST /webhook statuses",
              phoneId: _waPid,
              to: recipient ? recipient.slice(0, 4) + "***" + recipient.slice(-3) : "",
              wamid: messageId.slice(-24),
              errorCode,
              error: errorDetail,
            },
          });
        }
      }
      recordWebhook("whatsapp", "📬 estado de envío actualizado: " + statuses.map((s: any) => String(s?.status || "?")).join(","));
      if (!value?.messages?.[0]) return;
    }
    const msg = value?.messages?.[0];
    if (!msg) { recordWebhook("whatsapp", "ℹ️ evento sin mensaje (status/otro): campo=" + (change?.field || "?")); return; }
    // WAMID-UNA-VEZ-1 · cada mensaje se procesa UNA sola vez. Meta puede entregar el mismo
    // varias veces (reintentos), y aquí eso no era una repetición inofensiva: cada entrega
    // arrancaba el flujo otra vez y el cliente recibía todo duplicado. Medido el 3-sep-2026:
    // un contacto con 13 entregas de «¡Sí, quiero el vídeo!» en 5,7 s, dos de ellas separadas
    // por 55 ms — imposible de pulsar a mano. Mismo candado que ya usaban Instagram y
    // Facebook. Si el mensaje no trae id (no debería), se procesa como siempre.
    if (msg.id && !(await dbClaimOnce("_wa_msg", String(msg.id)))) {
      recordWebhook("whatsapp", "🔁 entrega repetida del mismo mensaje — descartada (" + String(msg.id).slice(-12) + ")");
      return;
    }
    // MX-521-1 · 29-sep-2026: los móviles de México llegan de Meta como 521+10 cifras,
    // pero el panel les escribe (y guarda la ficha) como 52+10. Eran DOS conversaciones:
    // la plantilla enviada en una y la respuesta del cliente en otra, sin hilo. Si ya
    // existe la ficha 52+10, el mensaje va a ella (Meta entrega igual escribiendo a 52+10).
    {
      const mx = /^521(\d{10})$/.exec(String(msg.from || ""));
      if (mx) {
        const corto = "52" + mx[1];
        if ((await getContact(corto)) || (await dbGetConversation(corto))) msg.from = corto;
      }
    }
    // Multi-número: ¿a qué número de WhatsApp llegó? (phone_number_id del webhook).
    const waNum = resolveWaNumber(value?.metadata?.phone_number_id ?? "");
    // ── CTWA (2026-08-14, «¿cómo clasificamos el 100%?») ────────────────────
    // Meta marca los mensajes que llegan DESDE UN ANUNCIO con msg.referral
    // (source_id, source_url, headline, ctwa_clid). Es LA señal pago/orgánico
    // de mensajería y se descartaba — el clasificador tenía que adivinar.
    // Primer toque: se fija como utm_* del contacto solo si no tenía ninguno.
    try {
      const ref = (msg as { referral?: { source_url?: string; source_type?: string; source_id?: string; headline?: string; ctwa_clid?: string } }).referral;
      if (ref && (ref.source_id || ref.source_url || ref.ctwa_clid) && msg.from) {
        // NOTIFICACIONES-1 · lead_nuevo: la ficha nace con este mensaje (dedup por contacto).
        if (await touchContact(msg.from, "", waNum?.botId || "", "wa:" + (value?.metadata?.phone_number_id || ""), "whatsapp")) avisarLeadNuevo(msg.from, { channel: "whatsapp", origen: "Te ha escrito por WhatsApp desde un anuncio." });
        const fijado = await dbSetContactUtmIfEmpty(msg.from, {
          utm_source: "whatsapp",
          utm_medium: "paid-ctwa",
          utm_campaign: String(ref.headline || "").slice(0, 120) || "Anuncio CTWA",
          utm_content: String(ref.source_id || ref.source_url || "").slice(0, 160),
        });
        if (ref.ctwa_clid) await enrichContact(msg.from, { fields: { ctwa_clid: String(ref.ctwa_clid).slice(0, 140) } });
        recordWebhook("whatsapp", "🎯 mensaje desde ANUNCIO (CTWA): " + (String(ref.headline || ref.source_id || "").slice(0, 60) || "sin título") + (fijado ? " → atribuido al contacto" : " (el contacto ya tenía atribución)"));
      }
    } catch { /* la atribución nunca rompe el webhook */ }
    // REACCIONES-1 · un contacto reaccionando con emoji a un mensaje nuestro. No es un
    // mensaje que el bot tenga que contestar (por eso sale ANTES del bloque no-texto de
    // abajo, que si no lo capturase primero lo tiraría como "reaction" sin guardar nada).
    if (msg.type === "reaction") {
      const targetId = String((msg as { reaction?: { message_id?: string; emoji?: string } }).reaction?.message_id || "").trim();
      if (targetId) {
        const emoji = String((msg as { reaction?: { emoji?: string } }).reaction?.emoji || "");
        const tsMs = Number(msg.timestamp) > 0 ? Number(msg.timestamp) * 1000 : Date.now();
        await dbUpsertWaReaction({ tenant_id: _wsId, message_id: targetId, from_role: "contact", emoji, reacted_at: tsMs }).catch(() => {});
        recordWebhook("whatsapp", emoji ? `😀 reacción de contacto: ${emoji}` : "😀 reacción de contacto retirada");
      }
      return;
    }
    // No-texto (audio, foto, vídeo, sticker, ubicación, documento): el bot nunca supo
    // responderlos, pero antes se DESCARTABAN sin dejar rastro. Con el interruptor
    // apagado la Bandeja es el único sitio donde el dueño ve a sus clientes: si alguien
    // manda una nota de voz, no puede desaparecer. Lo guardamos como marcador ([audio],
    // [image]…) — el mismo patrón que ya usa la app verde — y salimos sin pasar por el
    // bot, así que con el canal encendido el comportamiento es el de siempre.
    if (msg.type !== "text" && msg.type !== "interactive" && !(msg.type === "button" && msg.button?.text)) {
      const fromNt: string = msg.from || "";
      // Solo los adjuntos DE VERDAD. El resto de tipos (reaction, system, unsupported…)
      // se siguen ignorando como siempre: no son un mensaje que el dueño tenga que
      // contestar, y llenarían la Bandeja de ruido tipo "[reaction]".
      if (fromNt && MEDIA_TYPES.has(msg.type)) {
        // MEDIA-BANDEJA-1: los tipos DESCARGABLES traen un media id; el resto
        // (location, contacts, order…) están en MEDIA_TYPES pero NO tienen fichero.
        const dl = new Set(["image", "video", "audio", "voice", "document", "sticker"]);
        const mediaId = dl.has(msg.type) ? String((msg as Record<string, { id?: string }>)[msg.type]?.id || "") : "";
        // BANDEJA-FIX-1 · WhatsApp manda el nombre del fichero en el documento; se
        // descartaba y la tarjeta del chat decía «Documento» a secas.
        const fileName = msg.type === "document" ? String((msg as Record<string, { filename?: string }>).document?.filename || "") : "";
        await marcarRespuestaDifusion(msg, String(value?.metadata?.phone_number_id ?? ""));
        await logInboundAttachment(fromNt, msg.type, "whatsapp",
          waNum ? "wa:" + waNum.phoneNumberId : "",
          value?.contacts?.[0]?.profile?.name ?? "",
          mediaId ? { mediaId, ...(fileName ? { name: fileName } : {}) } : undefined,
          String(msg.id || ""));
      }
      recordWebhook("whatsapp", "📎 mensaje no-texto (" + msg.type + ")"
        + (MEDIA_TYPES.has(msg.type) ? " → guardado en la Bandeja; el bot no lo responde" : " → ignorado"));
      return;
    }
    // metricas-pro M3: registramos el evento 'in' en app_wa_events ANTES de
    // procesar el mensaje. Calculamos response_time_ms buscando el último
    // 'out' al MISMO phone_number_id en los últimos 60min (heurística: ms
    // que tardó el cliente en responder al bot, agregado a nivel de número).
    // En try/catch: telemetría rota NO bloquea la respuesta al cliente.
    try {
      const _waPidIn = String(value?.metadata?.phone_number_id ?? "");
      if (_waPidIn) {
        let rtMs: number | null = null;
        const lastOut = await dbWaLastOutTs({ tenant_id: _wsId, phone_number_id: _waPidIn });
        if (lastOut) {
          const diff = Date.now() - lastOut;
          if (diff > 0 && diff <= 60 * 60 * 1000) rtMs = diff;
        }
        await dbInsertWaEvent({
          tenant_id: _wsId,
          phone_number_id: _waPidIn,
          direction: "in",
          msg_type: msg.type,
          response_time_ms: rtMs,
        });
      }
      await marcarRespuestaDifusion(msg, _waPidIn);
    } catch { /* tracking nunca rompe el handler */ }
    recordWebhook("whatsapp", "✅ mensaje de " + (msg.from || "?") + " · pnid " + (value?.metadata?.phone_number_id || "?") + (waNum ? " → bot " + (waNum.botId || "IA") : " · ⚠️ NÚMERO NO RECONOCIDO en el panel (usa principal)"));
    const exec = async () => {
    const from: string = msg.from;
    // Respuesta interactiva (botón/lista del cuestionario) → tratamos el título
    // elegido como si fuera el texto que escribió el cliente. Lo mismo con 'button',
    // que es el botón de una PLANTILLA (lo que pulsa quien responde a una difusión:
    // "Sí, me interesa"). Antes se tiraba: ese cliente no aparecía en ninguna parte.
    const text: string =
      msg.type === "interactive"
        ? msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ""
        : msg.type === "button"
          ? msg.button?.text ?? ""
          : msg.text?.body ?? "";
    const profileName: string = value?.contacts?.[0]?.profile?.name ?? "";
    await markRead(msg.id);

    // Comando de reinicio. Solo existe si el canal está ENCENDIDO: apagado, "reiniciar"
    // (o "empezar", que es lo que escribe un cliente respondiendo a un CTA) es un mensaje
    // más y debe seguir el camino normal hasta quedar registrado en la Bandeja. Si
    // cortáramos aquí, ese mensaje se perdería: ni respuesta, ni rastro para el dueño.
    // SOLO-HUMANO-1: un número en «solo humano» tampoco contesta a esto — el
    // panel promete que ahí no sale NINGUNA respuesta automática, y «empezar»
    // es justo lo que escribe quien responde a una CTA.
    if (autoReplyOn("whatsapp") && !(waNum && waNum.botId === "__none__") && /^\/?(reset|reiniciar|empezar)$/i.test(text.trim())) {
      reset(from);
      await cancelSequences(from);
      await sendText(from, "Conversación reiniciada. ¿En qué te ayudo?");
      return;
    }

    // SOLO-HUMANO-1 (2026-08-24) · El guard de «solo humano» vivía AQUÍ, y por
    // estar tan arriba no solo callaba a la IA: se saltaba el registro de las
    // BAJAS pedidas por botón (riesgo de que te reporten), el hook de
    // respuestas a difusiones (a esa gente le llegaba el «como no me
    // contestaste») y el motor de flujos entero. El interruptor de canal y
    // «Atender yo» ya habían aprendido esa lección (incidentes 2026-07-14 y
    // 2026-07-20) y viven más abajo; este se había quedado con el bug.
    // Ahora se decide junto a ellos: ver el guard de `!chanOn` unas líneas más
    // abajo, que es donde de verdad se calla al bot.

    // ¿PRIMER CONTACTO? = el bot todavía no ha dicho nada. NO es lo mismo que "no existe
    // la conversación": si el cliente abrió con una foto, la conversación ya existe (la
    // registramos para la Bandeja) pero nadie la ha atendido. Gobierna SOLO el saludo.
    const existing = await getSession(from);
    const firstContact = botHasNotSpoken(existing);

    // ¿QUÉ BOT ATIENDE? Es pegajoso: una vez asignado, no se vuelve a preguntar. Si aún
    // no hay ninguno, manda el bot del número y, si tampoco, lo decide la IA — pero solo
    // si el canal está ENCENDIDO: con el bot apagado no va a atender nadie, así que no
    // gastamos una llamada a la IA por cada mensaje que entra. La conversación se queda
    // sin bot asignado y se decide el día que enciendas el canal.
    // (Esto va deliberadamente separado de firstContact: si se usara el mismo criterio,
    // una conversación que nunca ha sido contestada —canal apagado, o "Atender yo"—
    // re-preguntaría a la IA en cada mensaje y el bot mostrado bailaría solo.)
    const chanOn = autoReplyOn("whatsapp");
    const stickyBotId = existing?.botId || waNum?.botId || "";
    // QUIÉN ATIENDE · misma regla que Instagram y Facebook (bots.ts): un perfil
    // pausado no atiende ni en el número que lo tiene fijado, y uno borrado no
    // deja su conversación en manos de otro.
    const at = quienAtiende(existing?.botId || "", waNum?.botId || "");
    const bot = at.estado === "atiende" ? at.bot : at.estado === "enrutar" && chanOn ? await classifyBot(text) : null;
    const mudoPorPerfil = at.estado === "callar" ? at.motivo : !bot && chanOn && at.estado === "enrutar" ? "no hay ningún perfil activo" : "";
    const assignedBotId = stickyBotId || (chanOn && bot ? bot.id : "");
    if (existing && assignedBotId && existing.botId !== assignedBotId)
      await repinBot(from, assignedBotId);

    // CRM: registra/actualiza contacto; el cliente respondió → corta drips.
    // Guardamos en qué número entró ('wa:<phoneNumberId>') para mostrar qué bot lo atendió.
    // assignedBotId vacío ⇒ no pisa el bot que ya tuviera el contacto.
    // NOTIFICACIONES-1 · lead_nuevo: la ficha nace con este mensaje (dedup por contacto).
    if (await touchContact(from, profileName, assignedBotId, waNum ? "wa:" + waNum.phoneNumberId : "")) avisarLeadNuevo(from, { name: profileName, channel: "whatsapp" });
    // CHAT-POR-NUMERO-1 · a qué número escribió el cliente: se sella en cada turno para
    // que la Bandeja pueda separar el chat de cada número (los appends de este handler
    // corren FUERA de runWithWaNumber, así que el sellado automático de memory.ts no
    // los cubre y va explícito).
    const waAcct = waNum ? "wa:" + waNum.phoneNumberId : "";
    await cancelSequences(from);

    // difusion-flow D5: hook broadcast-flows. Si este 'from' tiene jobs
    // 'sent' recientes (≤7d) en el WS, marca replied_at y actualiza
    // contadores del run. Va ANTES del motor de flujos para que el conteo
    // 'jobs_replied' se refleje aunque luego un flujo retome la
    // conversación. NUNCA rompe el handler: try/catch swallow + log
    // interno; se ejecuta dentro de runWithWorkspace (BIG-1 webhook
    // routing) → currentWorkspaceId() resuelve al WS del canal.
    //
    // Va ANTES del modo humano y de la baja a propósito: quien contesta a una difusión ha
    // contestado, lo atienda quien lo atienda. Si cortáramos antes, un contacto en "Atender
    // yo" —justo los más calientes, los que lleva un closer— nunca constaría como que
    // respondió y seguiría recibiendo el mensaje de "como no me has contestado…".
    try { await onBroadcastInboundReply(from, "wa", currentWorkspaceId()); } catch (e) {
      // Swallow para no dejar mudo al bot, pero logueamos para no perder fallos
      // del hook en silencio (antes era `catch {}` — invisible al admin).
      await logActivity({
        source: "broadcast",
        level: "error",
        summary: "Reply hook fallo en WA",
        payload: {
          recipient: from,
          channel: "wa",
          error: String((e as Error)?.message || e),
          _redacted: [],
        },
        status: "error",
      });
    }

    // BAJA pedida con el BOTÓN de una plantilla ("Baja", "Stop promotions", "Dejar de
    // recibir promociones"…). Ese tap ahora entra como texto (antes se descartaba), así
    // que hay que blindarlo: contestarle —o peor, arrancarle un flujo porque su etiqueta
    // casa con una palabra clave— a alguien que acaba de pedir que le dejes en paz es la
    // vía rápida a que te reporte y te quemen el número en Meta.
    //
    // Va ANTES del modo humano: la baja hay que registrarla y etiquetarla aunque a ese
    // contacto lo lleve una persona. Si no, seguiría en las difusiones futuras.
    //
    // Se compara la etiqueta ENTERA (normalizada), no por partes: con búsqueda parcial,
    // un botón "Baja laboral" —de una gestoría, que es justo el tipo de cliente de esto—
    // se leería como una baja y se silenciaría a un lead con toda la intención del mundo.
    // DIFUSION-FIX-6 · La baja valía SOLO desde el botón de una plantilla
    // (msg.type==='button'). Los botones de respuesta rápida que crea el propio
    // compositor de Difusión llegan como 'interactive', así que poner un botón
    // «Dar de baja» en una difusión no daba de baja a NADIE — y escribir «BAJA»
    // a mano, tampoco. Ahora valen las tres vías.
    // El comparador exige la etiqueta ENTERA (contacts.ts), así que «baja
    // laboral» sigue sin contar como baja: eso no cambia.
    const pidioBaja =
      (msg.type === "button" && isOptOutLabel(text, msg.button?.payload)) ||
      (msg.type === "interactive" && isOptOutLabel(text, msg.interactive?.button_reply?.id)) ||
      (msg.type === "text" && isOptOutLabel(text));
    if (pidioBaja) {
      await ensureSession(from, assignedBotId);
      // WAMID-UNA-VEZ-1 · el id del mensaje viaja con el turno: sin él no había forma de saber si
      // trece mensajes iguales fueron trece pulsaciones o trece entregas del mismo.
      await append(from, { role: "user", content: text, ...(msg.id ? { mid: String(msg.id) } : {}), ...(waAcct ? { acct: waAcct } : {}) });
      try { await enrichContact(from, { tags: [OPT_OUT_TAG], fields: {} }); } catch { /* best effort */ }
      recordWebhook("whatsapp", "🚫 el cliente pidió la BAJA (botón o texto) → registrado y etiquetado, sin respuesta");
      app.log.info({ from, via: msg.type }, "opt-out: bot en silencio");
      return;
    }

    const c = await getContact(from);

    // Motor de flujos (retomar flujo en curso + disparadores + arrancar flujo).
    //
    // INCIDENTE 2026-07-14 · Aquí ARRIBA estaba el interruptor del canal, y apagado
    // hacía `return` ANTES de esta sección: eso mató TODAS las automatizaciones
    // configuradas (el flujo del enlace del LIVE de Carla dejó de responder en
    // producción). El interruptor ahora vive DESPUÉS del motor (ver abajo).
    //
    // La regla es: un FLUJO es algo que el dueño ha configurado a propósito y espera
    // que ocurra; la IA es la que "contesta a lo que sea". El interruptor solo debe
    // callar a la IA — nunca desactivar lo que alguien montó a mano.
    // DEFENSIVO: un fallo del motor de flujos NO debe dejar mudo al bot. Si algo
    // aquí lanza (BD, flujo mal formado, etc.), lo registramos y seguimos hasta
    // la IA, que sí responde. El motor de flujos es accesorio, la respuesta no.
    // KEEP-AI-1 · fuera del try a propósito: si el motor de flujos revienta, esto queda
    // en false y el pipeline sigue exactamente como siempre.
    let flujoDejaHablarIa = false;
    try {
      // 0) Deja constancia de la respuesta en flujos que esperan por un DELAY
      //    (mensaje→espera→condición «¿respondió?»). Si el flujo tiene DERIVACIÓN
      //    INMEDIATA (rdEnabled), escribir durante la espera deriva a Carla YA
      //    (respuesta + aviso + modo humano) y devuelve true → la IA debe callar.
      const derivadoEnEspera = await noteReplyToActiveRuns(from, text);

      // 1) ¿Hay un flujo esperando respuesta de este contacto? Lo retoma.
      if (await resumeFlow(from, text)) return;
      if (derivadoEnEspera) { recordWebhook("whatsapp", "⏩ escribió durante una espera → derivado a Carla al instante (la IA calla)"); return; }

      // 2) Disparadores por palabra clave (WhatsApp).
      //    Pasamos el phoneNumberId del mensaje entrante para que el filtro
      //    multi-número (trigger.phoneNumberId) se respete.
      const trig = await runWaTriggers(from, text, waNum?.phoneNumberId);
      if (trig.escalate) {
        await setHuman(from, true); // silencia el bot y marca el contacto para que lo atienda una persona
        avisarContacto("pide_persona", from, (nm) => ({ title: nm + " pasa a tu equipo", body: "Ha escrito una palabra que pide hablar con una persona. El bot ya no le contesta." }), { channel: "whatsapp", dedup: dedupVentana("persona:ia:" + from, 30) }); // NOTIFICACIONES-1
        await sendText(from, "Te paso con una persona del equipo, te escribirá en breve. 🙌");
        app.log.warn({ from }, "ESCALADO A HUMANO (trigger)");
      }
      if (trig.stopAi) { recordWebhook("whatsapp", "🛑 un disparador detuvo la IA (stopAi)"); return; }

      // 3) ¿Algún flujo se dispara con este mensaje? Si arranca, gestiona él —
      //    salvo que pida expresamente dejar seguir a la IA (KEEP-AI-1).
      const fOut: { keepAi?: boolean } = {};
      if (await triggerFlows(from, text, fOut)) {
        if (!fOut.keepAi) { recordWebhook("whatsapp", "▶️ un flujo se disparó y gestiona la conversación"); return; }
        flujoDejaHablarIa = true;
        recordWebhook("whatsapp", "▶️ un flujo se disparó y DEJA seguir a la IA");
      }
    } catch (e) {
      recordWebhook("whatsapp", "⚠️ motor de flujos falló (sigo con IA): " + (e as Error).message);
      app.log.error(e, "motor de flujos (sigo con IA)");
    }

    // Handoff humano: ningún flujo se ha hecho cargo → el bot calla y el mensaje solo se
    // registra para que se vea en la Bandeja.
    //
    // Va DESPUÉS del motor de flujos por la MISMA razón que el interruptor de la IA (ver
    // INCIDENTE 2026-07-14 justo arriba). Estaba antes, con su propio `return`, así que
    // marcar «Atender yo» en un contacto desactivaba TODAS sus automatizaciones sin
    // avisar: alguien a mitad de un flujo, respondiendo a un botón que le habíamos
    // enviado nosotros, se quedaba tirado para siempre. Se detectó en Instagram el
    // 2026-07-20 y aquí estaba idéntico. «Atender yo» significa "que no conteste la IA",
    // no "cancela lo que el dueño configuró".
    if (c?.human) {
      // NOTIFICACIONES-1 · mensaje_sin_bot: la IA no contesta, así que alguien tiene que hacerlo.
      avisarContacto("mensaje_sin_bot", from, (nm) => ({ title: nm + " te ha escrito", body: "«" + String(text || "").replace(/\s+/g, " ").trim().slice(0, 140) + "»" + " — la conversación la atiendes tú: el bot no contesta." }), { name: c?.name, channel: "whatsapp", dedup: dedupVentana("sinbot:" + from, 30) });
      await ensureSession(from, assignedBotId);
      await append(from, { role: "user", content: text, ...(msg.id ? { mid: String(msg.id) } : {}), ...(waAcct ? { acct: waAcct } : {}) });
      recordWebhook("whatsapp", "🙋 contacto en modo HUMANO (Atender yo) → la IA calla; los flujos SÍ se han ejecutado");
      app.log.info({ from }, "modo humano: bot en silencio");
      return;
    }

    // ── INTERRUPTOR DE LA IA (panel → Bots & Conocimiento) ───────────────────
    // Apagado ⇒ la IA no contesta la charla libre y no se manda el saludo: si alguien
    // escribe "hola, ¿qué tal?" y no coincide con ninguna automatización, el bot NO
    // inventa una respuesta; el mensaje queda en la Bandeja para una persona.
    //
    // Va DESPUÉS del motor de flujos A PROPÓSITO: las automatizaciones que el dueño ha
    // configurado (palabra clave, comentarios, historias) se ejecutan SIEMPRE, tenga la
    // IA encendida o apagada. Apagar la IA no puede desactivar lo que alguien montó.
    //
    // ensureSession ANTES de append no es opcional: append() es un no-op silencioso si
    // no hay sesión en cache (memory.ts), y la Bandeja se construye desde las
    // conversaciones, no desde los contactos. Sin este par, el mensaje no aparecería.
    // SOLO-HUMANO-1 · el número en «solo humano» calla al bot EXACTAMENTE igual
    // que el interruptor del canal: ni charla libre ni saludo, pero los flujos,
    // los disparadores, las bajas y las difusiones siguen su curso.
    const soloHumano = !!(waNum && waNum.botId === "__none__");
    // Silencio EXPLICADO: perfil pausado o sin perfiles activos. Igual que el
    // canal apagado, pero diciendo el motivo en la Bandeja.
    // HORARIO DE ATENCIÓN · fuera de él la IA no improvisa. Los flujos y las
    // automatizaciones siguen funcionando: esto solo calla la charla libre.
    const fh = fueraDeHorario();
    if (fh.fuera) {
      await ensureSession(from, assignedBotId);
      await append(from, { role: "user", content: text, ...(msg.id ? { mid: String(msg.id) } : {}), ...(waAcct ? { acct: waAcct } : {}) });
      if (fh.aviso) {
        const ult = [...(((await getSession(from))?.turns) || [])].reverse().find((m) => m.role === "assistant");
        if (!ult || ult.content !== fh.aviso) {
          try { await sendText(from, fh.aviso); await append(from, { role: "assistant", content: fh.aviso, by: "bot", ...(waAcct ? { acct: waAcct } : {}) }); } catch { /* el aviso es secundario */ }
        }
      }
      recordWebhook("whatsapp", "🌙 fuera del horario de atención: la IA no improvisa. El mensaje está en la Bandeja");
      return;
    }
    if (mudoPorPerfil) {
      await ensureSession(from, assignedBotId);
      await append(from, { role: "user", content: text, ...(msg.id ? { mid: String(msg.id) } : {}), ...(waAcct ? { acct: waAcct } : {}) });
      recordWebhook("whatsapp", "🔇 sin respuesta: " + mudoPorPerfil + " (las automatizaciones SÍ funcionan). El mensaje está en la Bandeja");
      return;
    }
    if (!chanOn || soloHumano) {
      await ensureSession(from, soloHumano ? "" : assignedBotId);
      await append(from, { role: "user", content: text, ...(msg.id ? { mid: String(msg.id) } : {}), ...(waAcct ? { acct: waAcct } : {}) });
      recordWebhook("whatsapp", soloHumano
        ? "🙋 Número en «solo humano» → el bot calla (tus automatizaciones SÍ funcionan). El mensaje está en la Bandeja."
        : "🔇 IA apagada en WhatsApp → sin respuesta libre (las automatizaciones SÍ funcionan). El mensaje está en la Bandeja.");
      app.log.info({ from, soloHumano }, "bot en silencio: sin respuesta libre; los flujos siguen activos");
      return;
    }
    // Red explícita: llegados aquí siempre hay perfil (los guardas de arriba
    // devuelven antes). Si un camino futuro lo dejara vacío, se calla y se anota
    // en vez de reventar la petición del webhook.
    if (!bot) { recordWebhook("whatsapp", "🔇 sin respuesta: no hay perfil que atienda"); return; }

    // AI-ACT-1 · transparencia ANTES de la primera intervención de IA. La marca
    // propia permite avisar también una vez a conversaciones anteriores al cambio.
    if (needsAiDisclosure(existing)) {
      await ensureSession(from, bot.id);
      try {
        const notice = aiTransparencyNotice();
        await sendText(from, notice);
        await append(from, { role: "assistant", content: notice, notice: "ai", ...(waAcct ? { acct: waAcct } : {}) })
          .catch((e) => recordWebhook("whatsapp", "⚠️ aviso IA enviado pero no persistido: " + (e as Error).message));
        recordWebhook("whatsapp", "🤖 aviso de transparencia IA enviado");
      } catch (e) {
        recordWebhook("whatsapp", "❌ ENVÍO del aviso IA falló: " + (e as Error).message);
        await append(from, { role: "user", content: text, ...(waAcct ? { acct: waAcct } : {}) }).catch(() => {});
        return;
      }
    }

    // Saludo solo en el primer mensaje de la conversación.
    // El saludo SE REGISTRA como turno del bot. No es cosmético: es lo que hace que la
    // conversación deje de ser "primer contacto". Sin esto, entre que saludamos y la IA
    // termina de responder (segundos), un cliente que escribe dos veces seguidas —lo
    // normal— recibiría el saludo dos veces; y con la IA caída lo recibiría en CADA
    // mensaje, para siempre. De paso, el saludo por fin se ve en la Bandeja.
    // El fallo de envío NO se relanza (antes sí, en WhatsApp): abortaba el pipeline y el
    // mensaje del cliente se perdía. Igual que ya hacían Instagram y Facebook.
    // KEEP-AI-1 · `firstContact` se congela mucho más arriba, ANTES del motor de flujos,
    // así que sin esta condición el primer contacto recibiría el mensaje del flujo, el
    // saludo y encima la respuesta de la IA: tres mensajes por escribir una palabra.
    if (firstContact && bot.greeting && !flujoDejaHablarIa) {
      await ensureSession(from, bot.id);
      try {
        await sendText(from, bot.greeting);
        await append(from, { role: "assistant", content: bot.greeting, by: "bot", ...(waAcct ? { acct: waAcct } : {}) });
        recordWebhook("whatsapp", "👋 saludo enviado (primer mensaje)");
      } catch (e) {
        recordWebhook("whatsapp", "❌ ENVÍO del saludo falló: " + (e as Error).message);
      }
    }

    // Anti-loop: si el mismo texto entró hace <60s para este contacto, no
    // invocamos IA otra vez (corta el caso "Hola → Hola → Hola → ..." que
    // hacía la IA contestar 6 cosas distintas a un cliente que solo prueba).
    // T05 2026-08-25 · la clave lleva el workspace: sin él, el mismo teléfono
    // escribiendo a DOS negocios distintos silenciaba la IA del segundo (y un
    // tenant podía apagar la del otro repitiendo el texto).
    const dedupKey = `${currentWorkspaceId()}:${from}:${text.trim().toLowerCase()}`;
    const lastTs = recentDedupe.get(dedupKey);
    if (lastTs && Date.now() - lastTs < DEDUPE_WINDOW_MS) {
      recordWebhook("whatsapp", "🔁 dedup: mismo texto repetido <60s → IA omitida (manda un texto distinto para probar)");
      app.log.info({ from }, "dedup: mismo texto repetido <60s, IA omitida");
      return;
    }
    recentDedupe.set(dedupKey, Date.now());

    // Cerebro IA.
    const raw2 = await think({ userId: from, bot, userText: text, channel: "whatsapp", account: waAcct });
    const ctl = extractControls(raw2);
    if (ctl.tags.length || Object.keys(ctl.fields).length)
      await enrichContact(from, { tags: ctl.tags, fields: ctl.fields });
    // Escalar a humano y/o disparar flujos pedidos por el bot (puente bot→flow).
    if (ctl.escalate || ctl.intents.length) {
      try {
        if (ctl.clean) await sendText(from, ctl.clean);          // primero la frase del bot
        if (ctl.escalate) await setHuman(from, true);
        if (ctl.escalate) avisarContacto("pide_persona", from, (nm) => ({ title: nm + " pasa a tu equipo", body: "El asistente ha decidido pasarle con una persona. El bot ya no le contesta." }), { channel: "whatsapp", dedup: dedupVentana("persona:ia:" + from, 30) }); // NOTIFICACIONES-1
        let firedFlow = false;
        for (const intent of ctl.intents) {
          try { if (await runFlowByIntent(from, intent)) firedFlow = true; }
          catch (e) { app.log.error(e, "runFlowByIntent"); }
        }
        if (ctl.escalate && !firedFlow)
          await sendText(from, "Te paso con una persona del equipo, te escribirá en breve. 🙌");
        recordWebhook("whatsapp", "✅ respuesta enviada" + (ctl.escalate ? " (escalado)" : firedFlow ? " (+flujo)" : ""));
      } catch (e) {
        recordWebhook("whatsapp", "❌ ENVÍO falló (escalado/flujo): " + (e as Error).message);
        throw e;
      }
      return;
    }
    try {
      await sendText(from, ctl.clean);
      recordWebhook("whatsapp", "✅ respuesta IA enviada a " + from);
    } catch (e) {
      recordWebhook("whatsapp", "❌ ENVÍO de la respuesta FALLÓ: " + (e as Error).message);
      throw e;
    }
    };
    if (waNum) await runWithWaNumber({ token: waNum.token, phoneId: waNum.phoneNumberId }, exec);
    else await exec();
  } catch (err) {
    app.log.error(err, "WhatsApp webhook");
    recordWebhook("whatsapp", "❌ EXCEPCIÓN en el handler (el bot no respondió): " + (err as Error).message);
  }
  });
}

qrOnMessage(async e => {
  const ws = await dbGetWorkspace(e.workspaceId);
  if (!ws || ws.archived || ws.archived_at) return;
  await runWithWorkspace(e.workspaceId, async () => {
    const num = resolveWaNumber(e.sessionId);
    if(!num || num.transport !== "qr")return;
    const acct = "wa:"+e.sessionId;
    if(e.fromMe || e.media || e.mediaFailed) {
      if(!(await dbClaimOnce("_wa_qr",e.sessionId+":"+e.id)))return;
      const ct = await getContact(e.phone);
      // NOMBRE-ECO-1 · El pushName de un mensaje PROPIO (fromMe) es el nombre de perfil
      // del teléfono vinculado — el del dueño —, NO el del contacto. Usarlo aquí
      // bautizaba con el nombre del dueño la ficha de cualquiera a quien él escribiera
      // primero desde el móvil, y ahí se quedaba: touchContact sólo corrige el nombre
      // cuando esa persona contesta, y quien nunca contesta nunca se corrige.
      // Sólo un mensaje DEL CONTACTO puede darle nombre — igual que ya hacía la
      // importación del histórico (WA-QR-HIST-1, más abajo).
      const nombre = e.fromMe ? "" : (e.name || "");
      if(!ct)await createContact({phone:e.phone,name:nombre,source:"whatsapp",channel_account:acct});
      if(!e.fromMe)await touchContact(e.phone,nombre,"",acct,"whatsapp");
      let att: {id:string;kind:string;mime?:string;state:"ok"|"failed";reason?:string;name?:string;size?:number} | undefined;
      if(e.media){
        const id = crypto.randomUUID();
        await dbPutInboxMedia({id,user_id:e.phone,source:"whatsapp",kind:e.media.kind,content_type:e.media.mime,data:e.media.buffer});
        // BANDEJA-FIX-1 · nombre (para la tarjeta del documento) y tamaño (para
        // reconocer que este eco ES el envío que el panel ya guardó).
        att={id,kind:e.media.kind,mime:e.media.mime,state:"ok",size:e.media.buffer.length,...(e.media.filename?{name:e.media.filename}:{})};
      } else if(e.mediaFailed){
        // ADJUNTO-REINTENTO-1 · ni con el reenvío del móvil se pudo bajar: queda como
        // adjunto no disponible (con su nombre), nunca como texto dentro del mensaje.
        const id = crypto.randomUUID();
        const f = e.mediaFailed;
        await dbPutInboxMedia({id,user_id:e.phone,source:"whatsapp",kind:f.kind,content_type:"",data:null,fail_reason:f.reason});
        att={id,kind:f.kind,...(f.mime?{mime:f.mime}:{}),state:"failed",reason:f.reason,...(f.filename?{name:f.filename}:{})};
        recordWebhook("whatsapp","⚠️ adjunto "+f.kind+" por QR sin descargar ("+f.reason+")");
      }
      const kindAdj = e.media?.kind || e.mediaFailed?.kind;
      await appendPersistent(e.phone,ct?.bot_id || "",{role:e.fromMe?"assistant":"user",...(e.fromMe?{by:"movil" as const}:{}),content:e.text || (kindAdj?"["+kindAdj+"]":""),mid:e.id,acct,at:e.ts,...(att?{att}:{})});
      return;
    }
    await handleWhatsappPayload({entry:[{changes:[{value:{metadata:{phone_number_id:e.sessionId},contacts:[{profile:{name:e.name}}],messages:[{id:e.id,from:e.phone,timestamp:String(Math.floor(e.ts/1000)),type:"text",text:{body:e.text}}]}}]}]}, e.workspaceId, e.sessionId);
  });
});
// ACUSE-QR-1 · antes se tiraba el acuse si resolveWaNumber(e.sessionId) no
// resolvía — pensado como filtro de sanidad, pero e.workspaceId YA es el tenant
// correcto (lo pone nuestro propio despachador, no el mensaje) y el acuse no
// necesita "resolver" el número para guardarse: message_id + tenant_id bastan.
// Con la guarda, un acuse que llegaba tarde para un número recién retirado (o
// que Baileys entregaba en el instante en que la Bandeja aún no había refrescado
// la caché de sesiones) se descartaba en silencio y ese mensaje se quedaba sin
// estado para siempre — justo el «?» que veía el dueño. Sin la guarda, el peor
// caso es un estado guardado para un número que ya no está: inofensivo, y es
// justo lo que wa-retired.ts ya hace con el resto del histórico.
qrOnAck(async e => {
  await runWithWorkspace(e.workspaceId, async () => {
    await dbUpsertWaMessageStatus({tenant_id:e.workspaceId,phone_number_id:e.sessionId,message_id:e.id,user_id:e.phone,msg_type:"text",status:e.status});
  });
});
// REACCIONES-1 · fromMe aquí es quién REACCIONÓ (propio teléfono vinculado vs
// contacto), no de quién es el mensaje reaccionado — ver whatsapp-qr.ts.
qrOnReaction(async e => {
  await runWithWorkspace(e.workspaceId, async () => {
    await dbUpsertWaReaction({tenant_id:e.workspaceId,message_id:e.messageId,from_role:e.fromMe?"agent":"contact",emoji:e.emoji,reacted_at:e.ts}).catch(() => {});
  });
});
// WA-QR-HIST-1 · Las conversaciones que YA existían en el móvil, traídas al vincular.
// Se escriben DIRECTAS al historial y al CRM y NUNCA pasan por handleWhatsappPayload:
// si pasaran, el bot se pondría a contestar mensajes de hace meses y los flujos se
// dispararían retroactivamente sobre cientos de personas.
qrOnHistory(async e => {
  const ws = await dbGetWorkspace(e.workspaceId);
  if (!ws || ws.archived || ws.archived_at) return;
  await runWithWorkspace(e.workspaceId, async () => {
    // Por id de sesión, NO por número: al llegar el primer lote la vinculación puede
    // no haber persistido aún el teléfono, y perder el histórico no tiene segunda
    // oportunidad — sólo se envía una vez, al vincular.
    if (!qrList().some(q => q.id === e.sessionId)) return;
    const acct = "wa:" + e.sessionId;
    const porContacto = new Map<string, QrHistoryItem[]>();
    for (const it of e.items) {
      const lista = porContacto.get(it.phone);
      if (lista) lista.push(it); else porContacto.set(it.phone, [it]);
    }
    let fundidos = 0;
    for (const [phone, items] of porContacto) {
      try {
        const ct = await getContact(phone);
        // Se crea el contacto para que el CRM se pueble, pero NO se llama a touchContact:
        // la ventana de 24 h la abre un entrante de VERDAD, no un mensaje viejo.
        if (!ct) await createContact({ phone, name: items.find(i => !i.fromMe && i.name)?.name || "", source: "whatsapp", channel_account: acct });
        fundidos += await mergeQrHistoryPersistent(phone, ct?.bot_id || "", acct, items);
      } catch (err) {
        // Un contacto que falle no puede llevarse por delante el resto del lote.
        app.log.warn({ phone, err: (err as Error).message }, "No se pudo importar el historial de WhatsApp de este contacto");
      }
    }
    if (fundidos || e.done) app.log.info({ sesion: e.sessionId, contactos: porContacto.size, turnos: fundidos, progreso: e.progress, fin: e.done }, "Histórico de WhatsApp por QR importado");
  });
});
// NOMBRE-ECO-1 · Al abrir la conexión sabemos nuestro propio nombre de perfil, que es
// exactamente el nombre con el que el eco venía bautizando fichas ajenas. Se limpian
// esas fichas: mejor ver el teléfono que ver el nombre del dueño en el chat de otra
// persona. Acotado al workspace de la sesión, sólo contactos de WhatsApp, y nunca la
// ficha del propio número vinculado (ahí ese nombre SÍ es el correcto).
qrOnSelf(async e => {
  const ws = await dbGetWorkspace(e.workspaceId);
  if (!ws || ws.archived || ws.archived_at) return;
  await runWithWorkspace(e.workspaceId, async () => {
    try {
      const n = await dbLimpiarNombresDeEco(e.selfName, e.phone);
      if (n) app.log.info({ sesion: e.sessionId, fichas: n }, "Contactos que tenían el nombre del teléfono vinculado: nombre retirado");
    } catch (err) {
      // Que falle la limpieza no puede tumbar la conexión de WhatsApp.
      app.log.warn({ err: (err as Error).message, sesion: e.sessionId }, "No se pudo limpiar el nombre heredado del eco en los contactos");
    }
  });
});
// NUM-RETIRADO-1 · Un número que VUELVE. Al vincular por QR un teléfono que antes
// estaba por Meta (o al revés), el identificador es otro y el histórico se quedaría
// atado al viejo: la vista por número partiría el hilo en dos. Aquí se re-adopta.
qrOnLinked(async e => {
  const ws = await dbGetWorkspace(e.workspaceId);
  if (!ws || ws.archived || ws.archived_at) return;
  await runWithWorkspace(e.workspaceId, async () => {
    const acct = "wa:" + e.sessionId;
    const previo = retiradoPorTelefono(e.phone);
    if (!previo || previo.acct === acct) return;
    try {
      // ECO-UNIFICADO-3 · deduplicar ANTES de re-sellar (ver dbAdoptarCuenta).
      const r = await dbAdoptarCuenta(previo.acct, acct, (t) => depurarDuplicadosDeTurnos(t as Parameters<typeof depurarDuplicadosDeTurnos>[0]).turns);
      await olvidarRetirado(previo.acct);
      app.log.info({ de: previo.acct, a: acct, ...r }, "Número recuperado: su histórico vuelve a ser suyo");
    } catch (err) {
      // Que falle la adopción no puede impedir que el número quede vinculado: lo peor
      // que pasa es que el histórico siga saliendo como del número anterior.
      app.log.warn({ err: (err as Error).message, de: previo.acct, a: acct }, "No se pudo re-adoptar el histórico del número que volvió");
    }
  });
});
// NUM-RETIRADO-1 · Un número que SE VA sin pedirlo el dueño (logout desde el teléfono,
// sesión inválida): antes solo la desconexión manual (botón "Quitar") apuntaba el
// teléfono retirado. Ésta era la otra baja posible y no lo hacía, así que el número
// volvía por QR sin que el chat lo reconociera ni se re-adoptase su histórico.
qrOnDisabled(async e => {
  const ws = await dbGetWorkspace(e.workspaceId);
  if (!ws || ws.archived || ws.archived_at) return;
  await runWithWorkspace(e.workspaceId, async () => {
    try {
      await retirarNumero({ acct: "wa:" + e.sessionId, phone: e.phone, label: e.label });
      // NOTIFICACIONES-1 · conexion: el WhatsApp por QR se ha desconectado solo (sesión cerrada en el móvil).
      notificar({ kind: "conexion", title: "WhatsApp desconectado" + (e.label ? ": " + e.label : ""), body: "El número …" + String(e.phone || "").slice(-4) + " ha cerrado la sesión. Vuelve a escanear el código para recibir y enviar mensajes.", channel: "whatsapp", link: "connections", dedup: dedupVentana("conexion:wa:" + e.sessionId, 60) });
    } catch (err) {
      // Que falle esto no puede impedir que la sesión quede desconectada: lo peor
      // que pasa es que el chat no reconozca el número si vuelve a conectarse.
      app.log.warn({ err: (err as Error).message, acct: "wa:" + e.sessionId }, "No se pudo apuntar el número retirado tras una desconexión de QR");
    }
  });
});
app.addHook("onClose", async () => { await qrCloseAll(); });

// DM entrante de Instagram → pipeline completo del bot (espejo de WhatsApp):
// resumeFlow → triggerStoryFlows → triggerIgDmFlows → saludo → cerebro IA → responde por IG.
// Debe ejecutarse dentro de runWithAccount() para que sendIgText use la
// cuenta correcta (multi-cuenta vía AsyncLocalStorage).
/** FOTO-PERFIL-1 · Guarda los BYTES de la foto de perfil mientras la URL firmada
 *  de Meta sigue viva (caduca en horas). Devuelve true si quedó cacheada.
 *  Solo baja la foto si no la teníamos o si ya tiene más de 7 días. */
async function cacheProfilePic(userId: string, picUrl: string): Promise<boolean> {
  if (!userId || !picUrl) return false;
  try {
    const edad = await dbAvatarAge(userId).catch(() => null);
    if (edad != null && edad < 7 * 24 * 3600 * 1000) return true;
    const res = await fetch(picUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 3 * 1024 * 1024) return false;
    await dbPutAvatar(userId, buf, String(res.headers.get("content-type") || "image/jpeg"));
    return true;
  } catch { return false; }
}

async function handleIgDm(sid: string, text: string, isStory = false, storyId?: string, acctId = "", esBoton = false, mid = ""): Promise<void> {
  // Comando de reinicio — solo si el canal está ENCENDIDO (ver WhatsApp para el detalle:
  // apagado, el mensaje debe seguir hasta la Bandeja en vez de morir aquí).
  // !esBoton (consejo 2026-08-15): un quick reply titulado «Empezar» es una CTA de
  // flujo, no el comando de reinicio — el reset aquí se comía el tap y colgaba el run.
  if (!esBoton && autoReplyOn("instagram") && /^\/?(reset|reiniciar|empezar)$/i.test(text.trim())) {
    reset(sid);
    await cancelSequences(sid);
    await sendIgText(sid, "Conversación reiniciada. ¿En qué te ayudo?");
    return;
  }

  // "Primer contacto" (gobierna el saludo) = el bot aún no ha hablado. Un DM que empieza
  // con un GIF ya crea la conversación, pero nadie la ha atendido todavía.
  // "Qué bot atiende" es OTRA cosa, y es pegajoso: si el canal está apagado no le
  // preguntamos a la IA (nadie va a atender), y así no gastamos una llamada por mensaje.
  // Ver WhatsApp para el razonamiento completo.
  const existing = await getSession(sid);
  const firstContact = botHasNotSpoken(existing);
  // BOT-POR-CUENTA-1 · con varias cuentas de Instagram, cada una puede tener su
  // perfil fijo o quedarse en «solo humano» (antes o contestaba la IA en todas
  // o en ninguna). Mismos tres valores que en WhatsApp.
  const cuentaBot = botForAccount("ig:" + acctId);
  const soloHumano = cuentaBot === "__none__";
  const chanOn = autoReplyOn("instagram") && !soloHumano;
  const fijo = cuentaBot && !soloHumano ? cuentaBot : "";
  // QUIÉN ATIENDE · una sola regla para los tres canales (bots.ts). Un perfil
  // pausado NO atiende ni en la cuenta que lo tiene fijado, y un perfil borrado
  // no deja su conversación en manos de otro con distinto catálogo.
  const at = quienAtiende(existing?.botId || "", fijo);
  const bot = at.estado === "atiende" ? at.bot : at.estado === "enrutar" && chanOn ? await classifyBot(text) : null;
  const mudoPorPerfil = at.estado === "callar" ? at.motivo : !bot && chanOn && at.estado === "enrutar" ? "no hay ningún perfil activo" : "";
  const assignedBotId = existing?.botId || fijo || (chanOn && bot ? bot.id : "");
  if (existing && assignedBotId && existing.botId !== assignedBotId) await repinBot(sid, assignedBotId);

  // CRM: registra el contacto, marca canal Instagram y, en el primer contacto,
  // enriquece con username + foto de perfil (User Profile API). Solo se busca
  // una vez (si falta name o avatar) para no llamar a Graph en cada mensaje.
  // NOTIFICACIONES-1 · lead_nuevo: la ficha nace con este mensaje (dedup por contacto).
  // NTF-SIN-ID-1 · el aviso sale DESPUÉS de pedir su @usuario: antes salía sin nombre.
  const leadNuevoIg = await touchContact(sid, "", assignedBotId, acctId ? "ig:" + acctId : "");
  try {
    const cur = await getContact(sid);
    const upd: { source: string; name?: string; avatar_url?: string } = { source: "instagram" };
    // ¿Tenemos ya la foto GUARDADA (bytes) y fresca? Si solo hay una avatar_url,
    // no cuenta: las de Meta caducan y acaban en 403 → monograma.
    const edadFoto = await dbAvatarAge(sid).catch(() => null);
    const fotoOk = edadFoto != null && edadFoto < 7 * 24 * 3600 * 1000;
    if (!cur?.name || !fotoOk) {
      // La pista del @usuario habilita el respaldo por Business Discovery.
      const hint = cur?.name && cur.name.startsWith("@") ? cur.name : undefined;
      const prof = await fetchIgUserProfile(sid, hint);
      if (prof) {
        if (prof.username) upd.name = "@" + prof.username;
        else if (prof.name) upd.name = prof.name;
        // Ahora mismo es cuando su foto se puede descargar con garantías.
        if (prof.profilePic && (await cacheProfilePic(sid, prof.profilePic)))
          upd.avatar_url = "/admin/api/inbox/avatar/" + encodeURIComponent(sid);
      }
    }
    await updateContact(sid, upd);
  } catch {
    /* best effort: no bloquea la respuesta */
  }
  if (leadNuevoIg) avisarLeadNuevo(sid, { channel: "instagram" });
  await cancelSequences(sid);

  const c = await getContact(sid);

  // difusion-flow D5: hook broadcast-flows IG DM. Mismo razonamiento que
  // WA: si este sid tiene jobs 'sent' recientes (≤7d) en el WS, marca
  // replied_at y actualiza contadores. ANTES del motor de flujos para que
  // 'jobs_replied' se refleje aunque luego un flujo retome. Swallow
  // errors: el broadcast-flows reply hook NUNCA debe dejar mudo al bot.
  // Se ejecuta dentro de runWithWorkspace (BIG-1 webhook routing IG) →
  // currentWorkspaceId() resuelve al WS del canal.
  try { await onBroadcastInboundReply(sid, "ig_dm", currentWorkspaceId()); } catch (e) {
    // Swallow para no dejar mudo al bot, pero logueamos para no perder fallos
    // del hook en silencio (antes era `catch {}` — invisible al admin).
    await logActivity({
      source: "broadcast",
      level: "error",
      summary: "Reply hook fallo en IG",
      payload: {
        recipient: sid,
        channel: "ig_dm",
        error: String((e as Error)?.message || e),
        _redacted: [],
      },
      status: "error",
    });
  }

  // Las AUTOMATIZACIONES van SIEMPRE: con la IA encendida o apagada, y TAMBIÉN con el
  // contacto en modo humano («Atender yo»).
  //
  // INCIDENTE 2026-07-20 · El handoff humano estaba ARRIBA, con su propio `return`, así
  // que un contacto marcado como "lo atiende un humano" no ejecutaba ni un flujo. Se vio
  // en producción probando el follow-gate: la persona pulsaba «Ya te sigo», el mensaje
  // llegaba, se descartaba aquí y el flujo se quedaba congelado para siempre. Y como el
  // id del mensaje ya se había reclamado para no procesarlo dos veces, el sondeo tampoco
  // podía rescatarlo.
  //
  // Es EXACTAMENTE el mismo fallo que el del interruptor de la IA (INCIDENTE 2026-07-14,
  // que mató el flujo del LIVE de Carla): un interruptor pensado para callar la charla
  // libre acababa desactivando automatizaciones que el dueño montó y activó a mano.
  // Un flujo no es el bot hablando por su cuenta: es una secuencia que el dueño
  // configuró y que la persona está recorriendo AHORA, respondiendo a botones que le
  // hemos enviado nosotros. Dejarla tirada a mitad es el peor resultado posible.
  // 0) Deja constancia de la respuesta en flujos aparcados por DELAY (mensaje→espera→
  //    condición «¿respondió?»): igual que en WhatsApp — sin esto la respuesta durante la
  //    espera no enciende la ventana y la condición saldría siempre «no» en IG.
  //    Con DERIVACIÓN INMEDIATA (rdEnabled) además deriva a Carla YA → la IA calla.
  const derivadoEnEspera = await noteReplyToActiveRuns(sid, text);
  // 1) ¿Flujo esperando respuesta de este usuario? Lo retoma.
  if (await resumeFlow(sid, text, "ig", { esBoton, isStory, storyId })) return;
  if (derivadoEnEspera) { recordWebhook("instagram", "⏩ escribió durante una espera → derivado al instante (la IA calla)"); return; }
  // BOTÓN-1 (incidente valentinpardo/SEEDANCE 2026-08-15): el tap de un botón
  // NUESTRO jamás es una keyword de arranque. Si no hay run esperándolo todavía
  // (carrera: el clic llega ANTES de que el run se aparque en 'waiting', o el run
  // está en un delay 'active'), se reintenta unos segundos y, si nadie lo reclama,
  // el tap va a la Bandeja y SE PARA aquí: ni triggers ni IA. Antes el título del
  // botón se evaluaba contra las keywords y podía arrancar un flujo gemelo
  // (colisión de keyword) que cancelaba el run en curso — parón en seco.
  if (esBoton) {
    for (let i = 0; i < 3; i++) {
      await new Promise((rs) => setTimeout(rs, 1200));
      if (await resumeFlow(sid, text, "ig", { esBoton })) return;
    }
    await ensureSession(sid, assignedBotId);
    await append(sid, { role: "user", content: text });
    recordWebhook("instagram", "🔘 botón «" + text.slice(0, 30) + "» sin flujo en espera tras 3,6s → queda en la Bandeja; un clic no dispara triggers ni IA");
    return;
  }
  // RESCATE-DIFERIDO-1 (incidente CARRERA-TICK-1, 2026-08-15): a las víctimas del
  // barrido (flujo marcado «Completada» en falso, fuera ya de la ventana de 24h y
  // sin permiso Human Agent para avisarlas) se les marca fields.rescate_flow en el
  // CRM. En cuanto escriben CUALQUIER cosa (ventana nueva), su flujo pendiente se
  // re-arranca desde el principio: botones, puerta de email y enlaces en botón —
  // todo por el cauce normal del motor. La marca se consume a un solo uso.
  //
  // ANTI-BOT-REPETITIVO (aviso del owner): el rescate SOLO dispara si (1) la marca
  // no ha caducado (rescate_hasta, 14 días), (2) el contacto no tiene ya un run
  // vivo, y (3) el flujo marcado NO se completó de verdad después de la marca
  // (p.ej. se rescató solo re-comentando) — y siempre precedido de UNA línea
  // humana de contexto para que repetir el primer paso no suene a bucle. Si algo
  // no cuadra, la marca se consume EN SILENCIO: mejor no escribir que escribir dos veces.
  try {
    const cf = (c?.fields || {}) as Record<string, unknown>;
    const rf = String(cf.rescate_flow || "");
    if (rf) {
      const desde = Number(cf.rescate_desde || 0);
      const hasta = Number(cf.rescate_hasta || 0);
      await enrichContact(sid, { fields: { rescate_flow: "", rescate_desde: "", rescate_hasta: "" } });
      const fw = (await listFlows()).find((x) => x.id === rf && x.enabled);
      const caducado = hasta > 0 && Date.now() > hasta;
      const ocupado = (await dbCurrentFlowRunsForPhone(sid)).length > 0;
      const yaServido = !fw || (await dbEndedFlowRunsForPhone(sid, 20)).some((r) => r.flow_id === fw.id && r.status === "done" && r.last_at > desde);
      if (fw && !caducado && !ocupado && !yaServido) {
        // PRUEBA-CANAL-1 · MODO PRUEBA · el rescate diferido es la TERCERA vía de arranque
        // de un mensaje directo (las otras dos, triggerStoryFlows y triggerIgDmFlows, ya
        // pasan por esta puerta) y también escribe a una persona REAL. Si el flujo está en
        // pruebas y este contacto no es el de prueba, no se le reenvía nada.
        // La marca se DEVUELVE a la ficha: el veto es temporal (el dueño está retocando el
        // flujo), así que quemarla dejaría a esa persona sin rescate para siempre.
        const vetoPrueba = bloqueaPorPrueba(fw, "instagram", String(c?.name || ""));
        if (vetoPrueba) {
          await enrichContact(sid, { fields: { rescate_flow: rf, rescate_desde: String(cf.rescate_desde || ""), rescate_hasta: String(cf.rescate_hasta || "") } });
          recordWebhook("instagram", "flujo \"" + (fw.name || fw.id) + "\" · " + vetoPrueba + " — el rescate queda pendiente hasta que el flujo salga de pruebas");
          fev(fw.id, sid, "no entró", fw.start, vetoPrueba);
        } else {
          recordWebhook("instagram", "🛟 rescate diferido: escribió y se le re-arranca «" + (fw.name || fw.id) + "» con línea de contexto");
          try { await sendIgText(sid, "¡Hey! Perdona 🙏 El otro día un fallo técnico dejó nuestra conversación a medias. Te lo reenvío ahora mismo 👇"); } catch { /* si el contexto falla, el flujo sale igual */ }
          await startFlowIgDm(sid, fw);
          return;
        }
      } else {
        recordWebhook("instagram", "🛟 marca de rescate consumida SIN reenvío (" + (caducado ? "caducada" : ocupado ? "ya está en otro flujo" : "ya se le sirvió") + ") — anti bot repetitivo");
      }
    }
  } catch { /* el rescate nunca rompe el pipeline */ }
  // 2) ¿Respuesta a una Historia con palabra clave? Dispara flujos ig_story.
  if (isStory && (await triggerStoryFlows(sid, text, storyId))) return;
  // 3) ¿Un flujo de DM directo (ig_dm) casa con la palabra clave del mensaje?
  if (await triggerIgDmFlows(sid, text)) return;

  // Handoff humano: ningún flujo se ha hecho cargo → a partir de aquí el bot calla y el
  // mensaje solo se registra para que se vea en la Bandeja.
  if (c?.human) {
    // NOTIFICACIONES-1 · mensaje_sin_bot: la IA no contesta, así que alguien tiene que hacerlo.
    avisarContacto("mensaje_sin_bot", sid, (nm) => ({ title: nm + " te ha escrito", body: "«" + String(text || "").replace(/\s+/g, " ").trim().slice(0, 140) + "»" + " — la conversación la atiendes tú: el bot no contesta." }), { name: c?.name, channel: "instagram", dedup: dedupVentana("sinbot:" + sid, 30) });
    await ensureSession(sid, assignedBotId);
    await append(sid, { role: "user", content: text });
    recordWebhook("instagram", "🙋 contacto en modo HUMANO (Atender yo) → la IA calla; los flujos SÍ se han ejecutado");
    app.log.info({ sid }, "IG modo humano: bot en silencio");
    return;
  }

  // ── INTERRUPTOR DE LA IA (Instagram) ─────────────────────────────────────
  // Apagado ⇒ ni saludo ni respuesta libre de la IA. Las automatizaciones de arriba
  // ya se han ejecutado: apagar la IA NO desactiva lo que el dueño ha configurado.
  // Silencio EXPLICADO: si el perfil elegido está pausado (o no queda ninguno
  // activo) no contesta nadie, y el motivo queda escrito en la Bandeja en vez
  // de un silencio raro que el dueño no sabe interpretar.
  // HORARIO DE ATENCIÓN · fuera de él la IA no improvisa. Los flujos y las
  // automatizaciones siguen funcionando: esto solo calla la charla libre.
  const fh = fueraDeHorario();
  if (fh.fuera) {
    await ensureSession(sid, assignedBotId);
    await append(sid, { role: "user", content: text });
    if (fh.aviso) {
      // El aviso se manda UNA vez: si lo último que dijimos ya fue el aviso,
      // no se repite con cada mensaje que escriba el cliente.
      const ult = [...(((await getSession(sid))?.turns) || [])].reverse().find((m) => m.role === "assistant");
      if (!ult || ult.content !== fh.aviso) {
        try { await sendIgText(sid, fh.aviso); await append(sid, { role: "assistant", content: fh.aviso }); } catch { /* el aviso es secundario */ }
      }
    }
    recordWebhook("instagram", "🌙 fuera del horario de atención: la IA no improvisa. El mensaje está en la Bandeja");
    return;
  }
  if (mudoPorPerfil) {
    await ensureSession(sid, assignedBotId);
    await append(sid, { role: "user", content: text });
    recordWebhook("instagram", "🔇 sin respuesta: " + mudoPorPerfil + " (las automatizaciones SÍ funcionan). El mensaje está en la Bandeja");
    return;
  }
  if (!chanOn) {
    await ensureSession(sid, assignedBotId);
    await append(sid, { role: "user", content: text });
    recordWebhook("instagram", "🔇 IA apagada en Instagram → sin respuesta libre (las automatizaciones SÍ funcionan). El mensaje está en la Bandeja.");
    app.log.info({ sid }, "IA OFF (instagram): sin respuesta libre; los flujos siguen activos");
    return;
  }
  // Red explícita: llegados aquí siempre hay perfil (los guardas de arriba
  // devuelven antes). Si un camino futuro lo dejara vacío, se calla y se anota
  // en vez de reventar la petición del webhook.
  if (!bot) { recordWebhook("instagram", "🔇 sin respuesta: no hay perfil que atienda"); return; }

  // AI-ACT-1 · aviso inequívoco antes del saludo y de la respuesta generada.
  if (needsAiDisclosure(existing)) {
    await ensureSession(sid, bot.id);
    try {
      const notice = aiTransparencyNotice();
      await sendIgText(sid, notice);
      await append(sid, { role: "assistant", content: notice, notice: "ai" })
        .catch((e) => app.log.error({ sid, err: (e as Error).message }, "IG: aviso IA enviado pero no persistido"));
      recordWebhook("instagram", "🤖 aviso de transparencia IA enviado");
    } catch (e) {
      app.log.error({ sid, err: (e as Error).message }, "IG: fallo enviando aviso IA (respuesta IA cancelada)");
      await append(sid, { role: "user", content: text }).catch(() => {});
      return;
    }
  }

  // Saludo solo en el primer mensaje. El envío va en try/catch: si fallara,
  // NO debe abortar el pipeline (si no, think() no persistiría la conversación
  // y no aparecería en la Bandeja). El saludo es secundario; la conversación no.
  if (firstContact && bot.greeting) {
    await ensureSession(sid, bot.id);
    try {
      await sendIgText(sid, bot.greeting);
      // Registrar el saludo es lo que marca "el bot ya ha hablado" (ver WhatsApp): sin
      // esto, un cliente que escribe dos veces seguidas recibe el saludo dos veces.
      await append(sid, { role: "assistant", content: bot.greeting });
    } catch (e) {
      app.log.error({ sid, err: (e as Error).message }, "IG: fallo enviando saludo (sigue)");
    }
  }

  // Anti-loop: mismo texto <60s para este usuario → IA omitida.
  const dedupKey = `ig:${sid}:${text.trim().toLowerCase()}`;
  const lastTs = recentDedupe.get(dedupKey);
  if (lastTs && Date.now() - lastTs < DEDUPE_WINDOW_MS) {
    app.log.info({ sid }, "IG dedup: mismo texto <60s, IA omitida");
    return;
  }
  recentDedupe.set(dedupKey, Date.now());

  // Cerebro IA → persiste la conversación (ensureSession + append) y responde.
  // El envío final va en try/catch: aunque falle, la conversación YA quedó
  // guardada por think() → aparece en la Bandeja igualmente.
  const raw2 = await think({ userId: sid, bot, userText: text, mid, channel: "instagram", account: acctId ? "ig:" + acctId : "" });
  const ctl = extractControls(raw2);
  if (ctl.tags.length || Object.keys(ctl.fields).length)
    await enrichContact(sid, { tags: ctl.tags, fields: ctl.fields });
  if (ctl.escalate) await setHuman(sid, true); // handoff: el bot calla y queda para una persona
  if (ctl.escalate) avisarContacto("pide_persona", sid, (nm) => ({ title: nm + " pasa a tu equipo", body: "El asistente ha decidido pasarle con una persona. El bot ya no le contesta." }), { channel: "instagram", dedup: dedupVentana("persona:ia:" + sid, 30) }); // NOTIFICACIONES-1
  try {
    await sendIgText(sid, ctl.clean);
  } catch (e) {
    app.log.error({ sid, err: (e as Error).message }, "IG: fallo enviando respuesta (conversación ya registrada)");
  }
}

/** Adjuntos reales que sí merecen quedar registrados en la Bandeja. */
// 'order' incluido a propósito: es un pedido hecho desde el catálogo de WhatsApp. Antes
// se perdía sin dejar rastro — de todo lo que se descartaba, era lo que más dinero costaba.
const MEDIA_TYPES = new Set(["audio", "voice", "image", "video", "document", "sticker", "location", "contacts", "order", "file", "share", "story_mention"]);


/**
 * Registra en la Bandeja un adjunto entrante (audio, foto, vídeo…) que el bot no sabe
 * responder. Antes se descartaban en silencio: ni contacto, ni conversación, ni rastro.
 * Con el interruptor apagado eso significaba perder al cliente sin enterarse, porque la
 * Bandeja es justo donde el dueño va a atenderlo. Se guarda como marcador — "[audio]" —
 * igual que hace la app verde con sus propios adjuntos.
 *
 * Detalles que NO son opcionales:
 *  - `source` explícito: sin él, el contacto se guarda como WhatsApp y un PSID de
 *    Messenger acaba clasificado (y persistido) como Instagram — el cliente aparecería
 *    en la pestaña equivocada de la Bandeja para siempre.
 *  - botId vacío en touchContact: no sabemos aún quién debe atenderle, así que NO
 *    pisamos el bot que ya tuviera el contacto (ni asignamos uno a un número marcado
 *    como "solo humano"). El bot real se fija cuando el cliente escriba (repinBot).
 *  - ensureSession ANTES de append: append() es un no-op si no hay sesión en memoria.
 */
/**
 * MEDIA-BANDEJA-1 · Descarga los bytes del adjunto y devuelve la referencia para el
 * turno. NUNCA lanza: si no se puede bajar, se devuelve state:'failed' con el motivo
 * para poder DECIRLO en la Bandeja. Perder al cliente del hilo es el bug grave;
 * quedarnos sin la foto, no.
 */
async function saveInboundMedia(
  userId: string,
  kind: string,
  source: "whatsapp" | "instagram" | "facebook",
  media: { url?: string; mediaId?: string; name?: string },
  channelAccount = "",
): Promise<{ id?: string; kind: string; mime?: string; state: "ok" | "failed"; reason?: string; name?: string; size?: number; retry?: boolean }> {
  const id = crypto.randomUUID();
  // BANDEJA-FIX-1 · el nombre real del fichero viaja con el adjunto: la tarjeta de un
  // documento decía «Documento» y nadie sabía cuál de los tres que le mandaron era.
  const name = String(media.name || "").slice(0, 200);
  const conNombre = name ? { name } : {};
  // ADJUNTO-REINTENTO-1 · con qué volver a pedirlo si ahora falla. WhatsApp conserva el
  // adjunto días tras la entrega (se pide otra vez por su id con el token del número);
  // la URL de Instagram/Facebook vive menos, pero un corte de red se recupera igual.
  const retryRef = source === "whatsapp"
    ? (media.mediaId ? JSON.stringify({ mid: String(media.mediaId), acct: channelAccount }) : "")
    : (media.url ? JSON.stringify({ url: String(media.url) }) : "");
  const conRetry = retryRef ? { retry: true } : {};
  try {
    const r = source === "whatsapp"
      ? await downloadWaMediaFor(String(media.mediaId || ""), channelAccount)
      : await downloadMetaAttachment(String(media.url || ""));
    if ("error" in r) {
      await dbPutInboxMedia({ id, user_id: userId, source, kind, content_type: "", data: null, fail_reason: r.error, retry_ref: retryRef });
      recordWebhook(source, "⚠️ adjunto " + kind + " sin descargar (" + r.error + ")" + (retryRef ? " → se reintentará al abrir el chat" : ""));
      return { id, kind, state: "failed", reason: r.error, ...conNombre, ...conRetry };
    }
    await dbPutInboxMedia({ id, user_id: userId, source, kind, content_type: r.contentType, data: r.data });
    recordWebhook(source, "📎 adjunto " + kind + " guardado (" + r.data.length + " B)");
    // BANDEJA-FIX-1 · el tamaño exacto es lo que distingue dos ficheros del mismo tipo
    // al reconocer el eco (memory.ts · huellaTurno).
    return { id, kind, mime: r.contentType, state: "ok", size: r.data.length, ...conNombre };
  } catch (e) {
    const reason = (e as Error).message || "error al guardar el adjunto";
    try { await dbPutInboxMedia({ id, user_id: userId, source, kind, content_type: "", data: null, fail_reason: reason, retry_ref: retryRef }); } catch { /* ni eso */ }
    return { id, kind, state: "failed", reason, ...conNombre, ...conRetry };
  }
}

async function logInboundAttachment(
  userId: string,
  kind: string,
  source: "whatsapp" | "instagram" | "facebook",
  channelAccount: string,
  name = "",
  media?: { url?: string; mediaId?: string; name?: string },
  mid = "",
  // PLANTILLA-ENTRANTE-1 · el texto y los botones reales de un mensaje con botones.
  tpl?: { content: string; btns: { t: string; u?: string }[] },
): Promise<void> {
  try {
    await touchContact(userId, name, "", channelAccount);
    // IG-PERFIL-1: hidrata @usuario + foto TAMBIÉN cuando el primer (o único) mensaje
    // es una foto. Antes solo lo hacía el camino de TEXTO (handleIgDm), y el webhook
    // hace `continue` para los adjuntos → quien te mandaba SOLO una foto se quedaba
    // como un IGSID crudo con un avatar de dos dígitos, para siempre.
    // Best-effort: si Graph falla, el mensaje se registra igual (perder al cliente de
    // la Bandeja es el bug grave; quedarnos sin su foto de perfil, no).
    const upd: { source: string; name?: string; avatar_url?: string } = { source };
    try {
      const cur = await getContact(userId);
      if (!cur?.name || !cur?.avatar_url) {
        if (source === "instagram") {
          const prof = await fetchIgUserProfile(userId);
          if (prof?.username) upd.name = "@" + prof.username;
          else if (prof?.name) upd.name = prof.name;
          if (prof?.profilePic) upd.avatar_url = prof.profilePic;
        } else if (source === "facebook") {
          const pageId = channelAccount.startsWith("fb:") ? channelAccount.slice(3) : "";
          const prof = pageId ? await fetchFbUserProfile(userId, pageId) : null;
          if (prof?.name) upd.name = prof.name;
          if (prof?.profilePic) upd.avatar_url = prof.profilePic;
        }
      }
    } catch { /* best effort: el perfil es accesorio, el mensaje no */ }
    try { await updateContact(userId, upd); } catch { /* best effort */ }
    // MEDIA-BANDEJA-1: bajamos los bytes AHORA (única ventana en que la URL de Meta
    // vive). El turno guarda la referencia en `att`; `content` sigue siendo "[image]"
    // para no romper la búsqueda, el resumen de la lista ni el contexto de la IA.
    const att = media ? await saveInboundMedia(userId, kind, source, media, channelAccount) : undefined;
    // Sesión SIN bot asignado ("" centinela): todavía no sabemos quién debe atender y no
    // vamos a preguntárselo a la IA por una foto. Se decide cuando el cliente escriba.
    await ensureSession(userId, "");
    // CHAT-POR-NUMERO-1 · el adjunto también sella a qué cuenta llegó.
    // DUP-ADJUNTO-1 · con el identificador del mensaje, un reenvío de Meta (o la otra vía)
    // se reconoce como el mismo mensaje en vez de dejar una segunda burbuja.
    await append(userId, { role: "user", content: tpl ? tpl.content : `[${kind}]`, ...(tpl && tpl.btns.length ? { btns: tpl.btns } : {}), ...(att ? { att } : {}), ...(channelAccount ? { acct: channelAccount } : {}), ...(mid ? { mid } : {}) });
  } catch (e) {
    app.log.error({ userId, kind, err: (e as Error).message }, "no pude registrar el adjunto entrante");
  }
}

// ---------- Instagram ----------
app.get("/webhook/instagram", async (req, reply) => {
  const q = req.query as Record<string, string>;
  if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === get("whatsapp.verifyToken"))
    return reply.code(200).send(q["hub.challenge"]);
  return reply.code(403).send("forbidden");
});

/**
 * FIRMA-META-1 · Todos los secretos con los que Meta PUEDE estar firmando lo que nos
 * entrega, en orden de probabilidad. Se usa en las rutas de Instagram, Facebook y
 * Leads — NO en la de WhatsApp, que conserva su verificación de siempre intacta.
 *
 * Los tres últimos existen porque el panel ya lee esas variables de entorno
 * (META_APP_SECRET / FB_APP_SECRET) mientras que la verificación solo consultaba
 * IG_APP_SECRET: si alguna estaba puesta en Railway con otro valor, sus eventos se
 * descartaban por "firma inválida" teniendo nosotros la clave delante.
 */
const metaSecretCandidates = (): Array<[string, string]> => [
  ["meta.appSecret", get("meta.appSecret")],
  ["meta.appSecretAlt", get("meta.appSecretAlt")],
  ["whatsapp.appSecret", get("whatsapp.appSecret")],
  ["env:META_APP_SECRET", process.env.META_APP_SECRET || ""],
  ["env:FB_APP_SECRET", process.env.FB_APP_SECRET || ""],
];

app.post("/webhook/instagram", async (req, reply) => {
  const { raw, json } = req.body as { raw: Buffer; json: any };
  // Nota: Meta entrega cada evento por CADA suscripción de webhook activa. Si
  // existe la suscripción "Instagram-login" además de la "Facebook-login", sus
  // entregas van firmadas con el secret de la sub-app IG y aquí dan 401 (no la
  // tenemos). Es inofensivo (se descarta), pero ensucia el log: para evitarlo,
  // desuscribir el webhook en el tab "API setup with Instagram login".
  // FIRMA-IG-1 · Segundo secreto. Meta entrega por CADA configuración de webhook
  // activa: si la app tiene además "API con Instagram Login", esas entregas van
  // firmadas con OTRO secreto y aquí se caían con 401 — perdiendo eventos REALES
  // (se detectó en producción: los taps de los botones llegaban por esa vía y se
  // descartaban, así que el flujo "se quedaba parado"). `meta.appSecretAlt` permite
  // aceptar también esa vía. Si no está configurado, se comporta como antes.
  const _sig = req.headers["x-hub-signature-256"] as string;
  // PASARELA-META-1 · lo que llega de la pasarela ya viene repartido: no se re-reparte.
  const _pas = entregaDePasarela(raw, req.headers);
  if (_pas === "repetida") return reply.code(200).send("ok"); // PASARELA-META-2 · ya entró: no se procesa dos veces
  const _dePas = _pas === "nueva";
  const _hit = _dePas ? "meta.appSecret" : verifySignatureAny(raw, _sig, metaSecretCandidates());
  if (!_hit) {
    // Diagnóstico: qué evento estamos rechazando (solo METADATOS del payload, nunca
    // se procesa nada sin firma válida). Sin esto no había forma de saber qué se perdía.
    let _what = "";
    try {
      const e0 = json?.entry?.[0];
      const kinds = (e0?.changes ?? []).map((c: { field?: string }) => c.field)
        .concat((e0?.messaging ?? []).length ? ["messaging"] : []).join(",");
      _what = " · object=" + String(json?.object || "?") + " cuenta=" + String(e0?.id || "?") + " tipo=" + (kinds || "?");
    } catch { /* el diagnóstico nunca rompe el descarte */ }
    recordWebhook("instagram", "⚠️ webhook con firma inválida descartado" + _what);
    // ACK-Y-DESCARTE (orden del owner 2026-08-15: «quita esa copia duplicada»):
    // antes se respondía 401 y Meta REINTENTABA la entrega fallida en bucle
    // (ráfagas de decenas de duplicados en el diagnóstico — trabajo a lo tonto).
    // Con 200, Meta la da por entregada y no reintenta. NADA se procesa sin firma
    // válida (el descarte es idéntico); solo cambia el código de respuesta. La
    // copia desaparece del todo desuscribiendo el webhook en el tab «API setup
    // with Instagram login» del panel de Meta (o configurando meta.appSecretAlt
    // para ACEPTARLA como segunda vía firmada).
    return reply.code(200).send("ignored");
  }
  // Deja constancia de CUÁL sirvió (el nombre, nunca el valor) para dejar de adivinar.
  if (_hit !== "meta.appSecret") recordWebhook("instagram", "🔑 entrega aceptada con la clave «" + _hit + "»");
  reply.code(200).send("ok");

  try {
    // WEBHOOK-RELAY-1 · Instagram no admite una URL de callback por cuenta (una sola
    // por app), así que la instancia central recibe lo de todos los clientes y
    // reparte. Se hace ANTES del bucle y agrupando por destino: el array `entry` es
    // multi-cuenta, y mandar la entrega entera a cada uno le enseñaría a un cliente
    // las conversaciones de otro. `mias` son las entries que sí son de aquí.
    const _repIg = await relayRepartir(
      "/webhook/instagram",
      String(json?.object || "instagram"),
      (json?.entry ?? []) as any[],
      (e: any) => ({ canal: "ig" as const, id: String(e?.id ?? "") }),
      get("meta.appSecret") || get("whatsapp.appSecret"),
      _dePas || String(req.headers[RELAY_HEADER] || "") === RELAY_HEADER_VALUE,
    );
    for (const _e of _repIg.enviados) {
      recordWebhook("instagram", _e.entregado
        ? "↪️ evento de " + _e.ids.join(", ") + " entregado a su panel"
        : "⚠️ evento de " + _e.ids.join(", ") + " NO se pudo entregar a su panel: " + (_e.error || "sin detalle"));
      if (!_e.entregado) app.log.warn({ ids: _e.ids, destino: _e.destino, error: _e.error }, "IG webhook: reenvío fallido, evento perdido");
    }
    for (const entry of _repIg.mias) {
      // entry.id = id de la cuenta IG. Multi-cuenta: resuelve sus credenciales.
      const acctId: string = String(entry?.id ?? "");
      // W6: routing canal→workspace por igBusinessId. Fail-safe a 'default'. Se
      // resuelve ANTES de leer credenciales: meta.igAccessToken/adsAccounts son
      // per-WS (WS_STRICT_SECRETS), así que resolveAccount() y los get() de la
      // cuenta principal deben correr DENTRO del scope del workspace dueño; si no,
      // caerían a las credenciales del owner en 'default' y actuarían con el token
      // equivocado para una cuenta enrutada a otro workspace.
      const _wsId = await resolveWorkspaceByChannel("ig", acctId);
      // WS-ARCHIVED-ROUTING: cuenta de un negocio ARCHIVADO → sumidero. Ya
      // contestamos 200 arriba; descartamos sin procesar. Jamás bajo 'default'.
      if (isSuspendedRoute(_wsId)) {
        recordWebhook("instagram", "⏸️ cuenta de un negocio archivado (" + acctId + ") — entrega aceptada y descartada sin procesar");
        console.warn(`[channel-routing] ig:${acctId} → sumidero: evento descartado (workspace archivado)`);
        continue;
      }
      await runWithWorkspace(_wsId, async () => {
      const _known = resolveAccount(acctId);
      // IG-NO-SUPLANTAR-1 · Antes, una cuenta de Instagram que no estuviera
      // registrada en este workspace NO se descartaba: se sustituía por las
      // credenciales de la cuenta principal y el evento seguía su curso. Eso
      // significa contestar el DM de un desconocido con el token de otra cuenta
      // —la del owner, o la del primer cliente que hubiera conectado—, y con los
      // flujos acotados a esa cuenta sin saltar. Facebook ya hacía lo correcto
      // («Page no registrada, evento descartado»); Instagram ahora también.
      // Importa más que nunca con la Meta App compartida entre instancias: un
      // evento mal enrutado ya no se responde con la identidad equivocada.
      if (!_known) {
        recordWebhook("instagram", "🚫 evento de la cuenta " + acctId + " descartado — no está conectada en este panel");
        app.log.info({ acctId, wsId: _wsId }, "IG webhook: cuenta no registrada, evento descartado");
        return;
      }
      const acct = _known;
      const igId = acct.igId;
      // TELEMETRIA-IG-1: el handler era casi ciego — "0 webhooks recibidos" no
      // distinguía entre "Meta no entrega" y "llegan pero no se registran". Ahora
      // cada entrega queda en el diagnóstico, con la cuenta que la originó.
      {
        const _kinds = (entry?.changes ?? []).map((c: { field?: string }) => c.field).concat((entry?.messaging ?? []).length ? ["messaging"] : []).join(",") || "(vacío)";
        recordWebhook("instagram", "📥 evento de cuenta " + acctId + " · " + _kinds);
      }
      await runWithAccount(acct, async () => {
        // Comentarios → automatizaciones IG + flows ig_comment.
        //
        // El interruptor de la IA NO manda aquí. Responder a un comentario con la
        // palabra clave que TÚ has configurado es una AUTOMATIZACIÓN, no la IA
        // improvisando: apagar la IA no puede desactivarla. (Antes se ignoraba el
        // comentario si Instagram estaba "apagado", y como el interruptor nacía
        // apagado, todos los disparadores de comentarios quedaron muertos.)
        // Para pausar una automatización concreta está su propio interruptor
        // "Activa/Pausada" en Disparadores.
        for (const ch of entry?.changes ?? []) {
          if (ch.field !== "comments") continue;
          const val = ch.value ?? {};
          // Solo comentarios NUEVOS: ignora ediciones/borrados (verb: add|edit|remove)
          // para no re-disparar respuestas. Reintentos de Meta se deduplican por commentId.
          if (val.verb && val.verb !== "add") continue;
          if (val.from?.id && igId && val.from.id === igId) {
            // TELEMETRIA-IG-1: el auto-comentario se descarta A PROPÓSITO (es la propia
            // cuenta). Antes era invisible y el owner probaba comentándose a sí mismo,
            // no veía DM y creía que el flujo estaba roto.
            recordWebhook("instagram", "💬 comentario propio de @" + (val.from?.username || igId) + " descartado (anti-self: prueba desde OTRA cuenta)");
            continue;
          }
          if (val.id && !(await dbClaimOnce("_ig_comment", String(val.id)))) continue;
          // NOTIFICACIONES-1 · comentario (una vez por comentario: el claim de arriba)
          // NOTIF-COMENTARIO-ENLACE-1 · al pulsarla abre el post en Instagram con ese comentario.
          const igLink = await igCommentLink(String(val.media?.id || ""), String(val.id || ""));
          notificar({ kind: "comentario", title: "Comentario nuevo en Instagram" + (val.from?.username ? " de @" + val.from.username : ""), body: "«" + String(val.text || "").replace(/\s+/g, " ").trim().slice(0, 140) + "»", channel: "instagram", account: igId ? "ig:" + igId : null, link: igLink || null, dedup: "comentario:instagram:" + String(val.id || ""), payload: val.media?.id ? { mediaId: String(val.media.id) } : null }); // REEL-PRUEBA-1
          recordWebhook("instagram", "💬 comentario de @" + (val.from?.username || val.from?.id || "?") + " en cuenta " + acctId + ": \"" + String(val.text ?? "").slice(0, 40) + "\"");
          // MARCA-HUERFANA-IG-1 · El comentario se reclamó arriba. Si procesarlo revienta, la
          // marca se libera: así el rescate lo ve como «caído» y lo recupera. Antes quedaba
          // reclamado-y-perdido, y el rescate lo daba por entrado.
          try {
            await handleCommentEvent({
              platform: "instagram",
              commentId: val.id,
              text: val.text ?? "",
              username: val.from?.username ?? "",
              userId: val.from?.id ?? val.id,
              mediaId: val.media?.id ?? "any",
            });
            // COMENTARIO-SIN-FLUJO-1 · la palabra clave de un flujo en una publicación que no escucha.
            const otros = await flujosIgEnOtraPublicacion(String(val.text || ""), String(val.media?.id || ""));
            if (otros.length) {
              recordWebhook("instagram", "⚠️ @" + (val.from?.username || "?") + " comentó la palabra clave de «" + otros.join("», «") + "» en una publicación que ese flujo no escucha → no entra");
              notificar({ kind: "comentario_sin_flujo", title: "Palabra clave en una publicación sin flujo" + (val.from?.username ? " · @" + val.from.username : ""), body: "«" + String(val.text || "").replace(/\s+/g, " ").trim().slice(0, 100) + "» coincide con «" + otros.join("», «") + "», pero ese flujo escucha otra publicación. No le ha llegado nada: añade esta publicación al flujo o escríbele.", channel: "instagram", account: igId ? "ig:" + igId : null, link: igLink || null, dedup: "comentario_sin_flujo:" + String(val.id || ""), payload: { mediaId: String(val.media?.id || ""), flujos: otros } });
            }
          } catch (e) {
            if (val.id) await dbReleaseClaim("_ig_comment", String(val.id)).catch(() => {});
            recordWebhook("instagram", "❌ fallo al procesar el comentario de @" + (val.from?.username || "?") + ": " + (e as Error).message);
            console.error("[ig-comment]", (e as Error).message);
          }
        }
        // DM entrante de Instagram → pipeline completo del bot (cerebro IA).
        for (const m of entry?.messaging ?? []) {
          const sid: string = m?.sender?.id ?? "";
          // BOTÓN-1 (incidente valentinpardo/SEEDANCE 2026-08-15): distinguir el TAP
          // de un botón nuestro de un texto libre. Quick reply = mensaje normal con
          // message.quick_reply (payload QR_n). Postback puro (plantilla) NO trae
          // message: antes caía en `if (!mtext) continue` y el clic se TIRABA en
          // silencio — el flujo se quedaba esperando para siempre. Su título ES el clic.
          const _qrPayload: string = String(m?.message?.quick_reply?.payload ?? "");
          const _pbTitle: string = !m?.message ? String((m as { postback?: { title?: string } }).postback?.title ?? "") : "";
          const esBoton = !!_qrPayload || !!_pbTitle;
          const mtext: string = m?.message?.text ?? _pbTitle;
          // ECHO: respuesta que un agente escribió desde la APP de Instagram (el móvil).
          // Meta la reenvía con is_echo=true (sender=la cuenta, recipient=el cliente). La
          // guardamos como SALIENTE para que la Bandeja muestre AMBOS lados, igual que con
          // la app verde de WhatsApp. Antes se descartaba → solo se veían los mensajes del
          // cliente (por eso en @leadmatch.co, atendida desde el móvil, faltaba tu lado).
          if (m?.message?.is_echo) {
            const to = m?.recipient?.id ?? "";
            // PLANTILLA-BANDEJA-1 · Un eco con adjunto «template» (mensaje con botones)
            // NUNCA sale de la app de Instagram: siempre lo mandó una API (nuestro
            // panel/bot u otra herramienta). Antes se guardaba el literal «[template]»
            // en la Bandeja; ahora se extrae el contenido REAL del payload del eco
            // (texto + botones) y se deduplica contra lo que el envío ya registró.
            const att0 = (m?.message?.attachments?.[0] ?? null) as { type?: string; payload?: { text?: string; title?: string; buttons?: Array<{ title?: string; url?: string }> } } | null;
            const esTpl = !mtext && att0?.type === "template";
            let etext = mtext;
            let ebtns: { t: string; u?: string }[] = [];
            if (esTpl) {
              const pay = att0?.payload || {};
              etext = String(pay.text || pay.title || "").trim();
              ebtns = (Array.isArray(pay.buttons) ? pay.buttons : [])
                .map((b) => ({ t: String(b?.title || "").trim(), ...(b?.url ? { u: String(b.url) } : {}) }))
                .filter((b) => b.t);
              if (!etext && ebtns.length) etext = "👇"; // solo botón, sin cuerpo: como lo enviamos nosotros
              if (!etext) {
                // Sin payload legible no hay nada que enseñar: mejor nada que «[template]».
                // Si lo mandó este panel/bot, el envío ya dejó su turno registrado.
                recordWebhook("instagram", "eco de un mensaje con botones sin contenido legible → no se registra (si salió de aquí, ya quedó guardado al enviarlo)");
                continue;
              }
            } else if (!etext) {
              etext = att0?.type ? `[${att0.type}]` : "";
            }
            if (to && etext && to !== igId) {
              // Dedup: el mismo echo puede llegar por dos vías (dos webhooks). No dupliques.
              const emid = String(m?.message?.mid || "");
              if (!emid || (await dbClaimOnce("_ig_echo", emid))) {
                try {
                  // SOLO registramos ecos escritos desde la APP de Instagram. Los que envió el
                  // bot, una automatización o el panel YA se guardaron al mandarlos (append /
                  // flowLog "assistant") → sin este filtro el mensaje saldría DOBLE en la
                  // Bandeja. Comprobamos si ya está en los últimos turnos de la conversación.
                  const conv = await dbGetConversation(to);
                  const recent = ((conv?.turns as { role?: string; content?: string }[]) || []).slice(-6);
                  // PLANTILLA-BANDEJA-1 · en un eco de plantilla el texto llega RECORTADO
                  // (Meta trunca a 640): también cuenta como «ya está» si uno de los
                  // turnos recientes empieza por él (o al revés).
                  const eNorm = etext.trim();
                  const yaEsta = recent.some((t) => {
                    if (t?.role !== "assistant") return false;
                    const c = String(t?.content || "").trim();
                    if (!c) return false;
                    return c === eNorm || (esTpl && (c.startsWith(eNorm) || eNorm.startsWith(c)));
                  });
                  if (!yaEsta) {
                    // appendPersistent carga el historial de BD (sin el TTL de 6h que borraría
                    // el hilo) y respeta el bot ya asignado.
                    // IG-NEGOCIO-1 · el eco dice por qué cuenta salió (antes se guardaba sin ella y
                    // la conversación acababa en el negocio de otra cuenta).
                    const ecoAcct = acctId ? "ig:" + acctId : "";
                    await appendPersistent(to, botById("")?.id || "", { role: "assistant", content: etext, ...(ebtns.length ? { btns: ebtns } : {}), ...(ecoAcct ? { acct: ecoAcct } : {}), ...(emid ? { mid: emid } : {}) });
                    // PIP-04-FIN · el eco lo escribimos NOSOTROS: no es un mensaje del contacto.
                    // touchContact fijaba last_inbound, y el Pipeline decía «Escribió el…» (y la
                    // ventana de 24 h se abría) por un mensaje nuestro. Solo se asegura la ficha.
                    const ctEco = await getContact(to);
                    if (!ctEco) await createContact({ phone: to, source: "instagram", channel_account: ecoAcct });
                    else await updateContact(to, { source: "instagram", ...(!ctEco.channel_account && ecoAcct ? { channel_account: ecoAcct } : {}) });
                  }
                } catch (e) {
                  app.log.error({ to, err: (e as Error).message }, "IG echo: no se pudo registrar el saliente");
                }
              }
            }
            continue;
          }
          if (!sid || (igId && sid === igId)) continue;
          // REACCIONES-2 · el contacto reacciona con emoji a un mensaje del hilo
          // (campo de webhook `message_reactions`: messaging[].reaction sin `message`).
          // Antes caía en el bloque «sin texto» de abajo y se tiraba en silencio. No es
          // un mensaje que el bot conteste: se guarda aparte y se pinta en la Bandeja.
          // Meta no manda eco de NUESTRAS reacciones: esas se registran al enviarlas.
          {
            const rx = (m as { reaction?: { mid?: string; action?: string; emoji?: string; reaction?: string } }).reaction;
            if (rx && !m?.message) {
              const targetId = String(rx.mid || "").trim();
              if (targetId) {
                const quita = String(rx.action || "").toLowerCase() === "unreact";
                const emoji = quita ? "" : String(rx.emoji || (rx.reaction === "love" ? "❤️" : "") || "❤️");
                const tsMs = Number(m?.timestamp) > 0 ? Number(m.timestamp) : Date.now();
                await dbUpsertWaReaction({ tenant_id: _wsId, message_id: targetId, from_role: "contact", emoji, reacted_at: tsMs }).catch(() => {});
                recordWebhook("instagram", emoji ? `😀 reacción de contacto: ${emoji}` : "😀 reacción de contacto retirada");
              }
              continue;
            }
          }
          // FIRMA-IG-1: aceptamos dos vías de entrega → el MISMO mensaje puede llegar
          // dos veces. Dedup por mid para no responder dos veces al mismo DM.
          const _mid = String(m?.message?.mid || (m as { postback?: { mid?: string } }).postback?.mid || "");
          if (_mid && !(await dbClaimOnce("_ig_msg", _mid))) continue;
          // ── IG ADS (2026-08-14): DM que llega DESDE UN ANUNCIO → Meta lo marca
          // con m.referral (source ADS, ad_id). Primer toque de atribución: con
          // esta señal, «Instagram sin señal = orgánico» deja de ser una apuesta.
          try {
            const _ref = (m as { referral?: { source?: string; type?: string; ad_id?: string; ref?: string; ads_context_data?: { ad_title?: string } } }).referral
              || (m as { postback?: { referral?: { source?: string; ad_id?: string; ref?: string; ads_context_data?: { ad_title?: string } } } }).postback?.referral;
            if (_ref && (String(_ref.source || "").toUpperCase() === "ADS" || _ref.ad_id)) {
              // NOTIFICACIONES-1 · lead_nuevo: la ficha nace con este mensaje (dedup por contacto).
              if (await touchContact(sid, "", "", acctId ? "ig:" + acctId : "", "instagram")) avisarLeadNuevo(sid, { channel: "instagram", origen: "Te ha escrito por Instagram desde un anuncio." });
              const fij = await dbSetContactUtmIfEmpty(sid, {
                utm_source: "instagram",
                utm_medium: "paid-social",
                utm_campaign: String(_ref.ads_context_data?.ad_title || "").slice(0, 120) || "Anuncio IG",
                utm_content: String(_ref.ad_id || _ref.ref || "").slice(0, 160),
              });
              recordWebhook("instagram", "🎯 DM desde ANUNCIO: " + (String(_ref.ads_context_data?.ad_title || _ref.ad_id || "").slice(0, 60) || "sin título") + (fij ? " → atribuido al contacto" : " (ya tenía atribución)"));
            }
          } catch { /* la atribución nunca rompe el webhook */ }
          // Adjunto sin texto (audio, foto, GIF…): el bot no lo responde, pero NO puede
          // desaparecer — con el bot apagado la Bandeja es donde el dueño ve al cliente.
          // Se guarda como marcador y se sigue con el resto de mensajes.
          if (!mtext) {
            // MEDIA-BANDEJA-1: antes solo se leía `.type` y se TIRABA `payload.url`,
            // que es donde viene la foto → en la Bandeja salía el texto "[image]".
            const a0 = m?.message?.attachments?.[0];
            const att = a0?.type;
            // PLANTILLA-ENTRANTE-1 · un mensaje CON BOTONES que nos escribe otra cuenta de empresa
            // (p. ej. un flujo de nuestra otra cuenta) se guardaba como «[template]». Se guarda su
            // texto y sus botones, como el eco. No se le pasa al bot: dos cuentas con flujos se
            // contestarían la una a la otra sin fin.
            if (att === "template") {
              const pay = ((a0 as { payload?: { text?: string; title?: string; buttons?: Array<{ title?: string; url?: string }> } })?.payload) || {};
              const ttext = String(pay.text || pay.title || "").trim();
              const tbtns = (Array.isArray(pay.buttons) ? pay.buttons : [])
                .map((b) => ({ t: String(b?.title || "").trim(), ...(b?.url ? { u: String(b.url) } : {}) }))
                .filter((b) => b.t);
              if (ttext || tbtns.length) {
                await logInboundAttachment(sid, "template", "instagram", igId ? "ig:" + igId : "", "", undefined, String(m?.message?.mid || ""),
                  { content: ttext || "👇", btns: tbtns });
                continue;
              }
            }
            if (att) {
              await logInboundAttachment(sid, String(att), "instagram", igId ? "ig:" + igId : "", "",
                a0?.payload?.url ? { url: String(a0.payload.url) } : undefined, String(m?.message?.mid || ""));
            }
            continue;
          }
          // Respuesta a una Historia: Meta marca message.reply_to.story (con su id).
          const story = m?.message?.reply_to?.story;
          try {
            await handleIgDm(sid, mtext, !!story, story?.id, igId, esBoton, _mid);
          } catch (e) {
            app.log.error({ sid, err: (e as Error).message }, "Instagram DM: fallo al responder");
          }
        }
      });
      });
    }
  } catch (err) {
    app.log.error(err, "Instagram webhook");
  }
});

// ---------- Facebook Messenger (Fase 2) ----------
//
// Misma Meta App que IG (mismo appSecret para firma; mismo verifyToken para el
// challenge). Cada `entry` lleva `id`=pageId; usamos getFbAccount(pageId) para
// resolver el page_token y poder responder con sendFbText().
//
// Si la app no tiene `pages_messaging` aprobada todavía, este endpoint sigue
// recibiendo events de usuarios de prueba (cualquier admin/dev de la app).
// Útil para QA antes de App Review.

async function handleFbDm(psid: string, text: string, pageId: string): Promise<void> {
  // Comando de reinicio — solo si el canal está ENCENDIDO (ver WhatsApp para el detalle:
  // apagado, el mensaje debe seguir hasta la Bandeja en vez de morir aquí).
  if (autoReplyOn("facebook") && /^\/?(reset|reiniciar|empezar)$/i.test(text.trim())) {
    reset(psid);
    await cancelSequences(psid);
    try { await sendFbText(psid, "Conversación reiniciada. ¿En qué te ayudo?", pageId); } catch {}
    return;
  }

  // "Primer contacto" (saludo) vs "qué bot atiende" (pegajoso): ver WhatsApp.
  const existing = await getSession(psid);
  const firstContact = botHasNotSpoken(existing);
  // BOT-POR-CUENTA-1 · igual que Instagram: cada Página puede tener su perfil
  // fijo o quedarse en «solo humano».
  const cuentaBot = botForAccount("fb:" + pageId);
  const soloHumano = cuentaBot === "__none__";
  const chanOn = autoReplyOn("facebook") && !soloHumano;
  const fijo = cuentaBot && !soloHumano ? cuentaBot : "";
  // QUIÉN ATIENDE · una sola regla para los tres canales (bots.ts). Un perfil
  // pausado NO atiende ni en la cuenta que lo tiene fijado, y un perfil borrado
  // no deja su conversación en manos de otro con distinto catálogo.
  const at = quienAtiende(existing?.botId || "", fijo);
  const bot = at.estado === "atiende" ? at.bot : at.estado === "enrutar" && chanOn ? await classifyBot(text) : null;
  const mudoPorPerfil = at.estado === "callar" ? at.motivo : !bot && chanOn && at.estado === "enrutar" ? "no hay ningún perfil activo" : "";
  const assignedBotId = existing?.botId || fijo || (chanOn && bot ? bot.id : "");
  if (existing && assignedBotId && existing.botId !== assignedBotId) await repinBot(psid, assignedBotId);

  // CRM: registra contacto canal "facebook" + enriquece con perfil Messenger
  // (name + profile_pic) si todavía no estaban — solo 1 vez por contacto.
  // NOTIFICACIONES-1 · lead_nuevo: la ficha nace con este mensaje (dedup por contacto).
  // NTF-SIN-ID-1 · el aviso sale DESPUÉS de pedir su nombre a Messenger.
  const leadNuevoFb = await touchContact(psid, "", assignedBotId, "fb:" + pageId);
  try {
    const cur = await getContact(psid);
    const upd: { source: string; name?: string; avatar_url?: string } = { source: "facebook" };
    const edadFb = await dbAvatarAge(psid).catch(() => null);
    if (!cur?.name || !(edadFb != null && edadFb < 7 * 24 * 3600 * 1000)) {
      const prof = await fetchFbUserProfile(psid, pageId);
      if (prof) {
        if (prof.name) upd.name = prof.name;
        if (prof.profilePic && (await cacheProfilePic(psid, prof.profilePic)))
          upd.avatar_url = "/admin/api/inbox/avatar/" + encodeURIComponent(psid);
      }
    }
    await updateContact(psid, upd);
  } catch { /* best effort */ }
  if (leadNuevoFb) avisarLeadNuevo(psid, { channel: "facebook" });

  await cancelSequences(psid);

  const c = await getContact(psid);

  // difusion-flow D5/SEC-3: hook broadcast-flows FB Messenger. Mismo
  // razonamiento que WA e IG: si este psid tiene jobs 'sent' recientes
  // (≤7d) en el WS, marca replied_at y actualiza contadores. ANTES del
  // motor de flujos para que 'jobs_replied' se refleje aunque luego un
  // flujo retome. Swallow errors: el reply hook NUNCA debe dejar mudo
  // al bot. Se ejecuta dentro de runWithWorkspace (BIG-1 webhook routing
  // FB) → currentWorkspaceId() resuelve al WS del canal.
  try { await onBroadcastInboundReply(psid, "fb_msg", currentWorkspaceId()); } catch (e) {
    // Swallow para no dejar mudo al bot, pero logueamos para no perder fallos
    // del hook en silencio (antes era `catch {}` — invisible al admin).
    await logActivity({
      source: "broadcast",
      level: "error",
      summary: "Reply hook fallo en FB",
      payload: {
        recipient: psid,
        channel: "fb_msg",
        error: String((e as Error)?.message || e),
        _redacted: [],
      },
      status: "error",
    });
  }

  // Las AUTOMATIZACIONES van SIEMPRE: con la IA encendida o apagada, y también con el
  // contacto en modo humano (ver el comentario largo en WhatsApp e Instagram: el handoff
  // estaba arriba con su propio return y desactivaba todos los flujos del contacto).
  const fbDerivado = await noteReplyToActiveRuns(psid, text); // respuesta durante un DELAY → enciende la ventana; con rdEnabled deriva YA
  if (await resumeFlow(psid, text, "fb")) return;
  if (fbDerivado) return; // la derivación ya contestó y avisó → la IA calla

  // Handoff humano: ningún flujo se ha hecho cargo → la IA calla y el mensaje solo se
  // registra para la Bandeja. «Atender yo» = "que no conteste la IA", nunca "cancela lo
  // que el dueño configuró".
  if (c?.human) {
    // NOTIFICACIONES-1 · mensaje_sin_bot: la IA no contesta, así que alguien tiene que hacerlo.
    avisarContacto("mensaje_sin_bot", psid, (nm) => ({ title: nm + " te ha escrito", body: "«" + String(text || "").replace(/\s+/g, " ").trim().slice(0, 140) + "»" + " — la conversación la atiendes tú: el bot no contesta." }), { name: c?.name, channel: "facebook", dedup: dedupVentana("sinbot:" + psid, 30) });
    await ensureSession(psid, assignedBotId);
    await append(psid, { role: "user", content: text });
    recordWebhook("facebook", "🙋 contacto en modo HUMANO (Atender yo) → la IA calla; los flujos SÍ se han ejecutado");
    app.log.info({ sid: psid, pageId }, "FB modo humano: bot en silencio");
    return;
  }

  // ── INTERRUPTOR DE LA IA (Facebook) ──────────────────────────────────────
  // Apagado ⇒ ni saludo ni respuesta libre. Los flujos de arriba ya han corrido.
  // HORARIO DE ATENCIÓN · fuera de él la IA no improvisa. Los flujos y las
  // automatizaciones siguen funcionando: esto solo calla la charla libre.
  const fh = fueraDeHorario();
  if (fh.fuera) {
    await ensureSession(psid, assignedBotId);
    await append(psid, { role: "user", content: text });
    if (fh.aviso) {
      const ult = [...(((await getSession(psid))?.turns) || [])].reverse().find((m) => m.role === "assistant");
      if (!ult || ult.content !== fh.aviso) {
        try { await sendFbText(psid, fh.aviso, pageId); await append(psid, { role: "assistant", content: fh.aviso }); } catch { /* el aviso es secundario */ }
      }
    }
    recordWebhook("facebook", "🌙 fuera del horario de atención: la IA no improvisa. El mensaje está en la Bandeja");
    return;
  }
  // El motivo del silencio por perfil (pausado / sin perfiles) se calculaba pero
  // no se usaba en Facebook: se caía en la red genérica sin explicar nada.
  if (mudoPorPerfil) {
    await ensureSession(psid, assignedBotId);
    await append(psid, { role: "user", content: text });
    recordWebhook("facebook", "🔇 sin respuesta: " + mudoPorPerfil + " (las automatizaciones SÍ funcionan). El mensaje está en la Bandeja");
    return;
  }
  if (!chanOn) {
    await ensureSession(psid, assignedBotId);
    await append(psid, { role: "user", content: text });
    recordWebhook("facebook", "🔇 IA apagada en Facebook → sin respuesta libre (las automatizaciones SÍ funcionan). El mensaje está en la Bandeja.");
    app.log.info({ sid: psid, pageId }, "IA OFF (facebook): sin respuesta libre; los flujos siguen activos");
    return;
  }
  // Red explícita: llegados aquí siempre hay perfil (los guardas de arriba
  // devuelven antes). Si un camino futuro lo dejara vacío, se calla y se anota
  // en vez de reventar la petición del webhook.
  if (!bot) { recordWebhook("facebook", "🔇 sin respuesta: no hay perfil que atienda"); return; }

  // AI-ACT-1 · Messenger comparte el cerebro y aplica el mismo control.
  if (needsAiDisclosure(existing)) {
    await ensureSession(psid, bot.id);
    try {
      const notice = aiTransparencyNotice();
      await sendFbText(psid, notice, pageId);
      await append(psid, { role: "assistant", content: notice, notice: "ai" })
        .catch((e) => app.log.error({ sid: psid, err: (e as Error).message }, "FB: aviso IA enviado pero no persistido"));
      recordWebhook("facebook", "🤖 aviso de transparencia IA enviado");
    } catch (e) {
      app.log.error({ sid: psid, err: (e as Error).message }, "FB: fallo enviando aviso IA (respuesta IA cancelada)");
      await append(psid, { role: "user", content: text }).catch(() => {});
      return;
    }
  }

  // Saludo solo en el primer mensaje. Se registra como turno del bot: es lo que marca
  // "el bot ya ha hablado" y evita saludar dos veces (ver WhatsApp).
  if (firstContact && bot.greeting) {
    await ensureSession(psid, bot.id);
    try {
      await sendFbText(psid, bot.greeting, pageId);
      await append(psid, { role: "assistant", content: bot.greeting });
    } catch (e) { app.log.error({ sid: psid, err: (e as Error).message }, "FB: fallo enviando saludo (sigue)"); }
  }

  // Anti-loop: mismo texto <60s para este usuario → IA omitida.
  const dedupKey = `fb:${psid}:${text.trim().toLowerCase()}`;
  const lastTs = recentDedupe.get(dedupKey);
  if (lastTs && Date.now() - lastTs < DEDUPE_WINDOW_MS) {
    app.log.info({ sid: psid }, "FB dedup: mismo texto <60s, IA omitida");
    return;
  }
  recentDedupe.set(dedupKey, Date.now());

  const raw = await think({ userId: psid, bot, userText: text, channel: "facebook", account: pageId ? "fb:" + pageId : "" });
  const ctl = extractControls(raw);
  if (ctl.tags.length || Object.keys(ctl.fields).length)
    await enrichContact(psid, { tags: ctl.tags, fields: ctl.fields });
  if (ctl.escalate) await setHuman(psid, true);
  if (ctl.escalate) avisarContacto("pide_persona", psid, (nm) => ({ title: nm + " pasa a tu equipo", body: "El asistente ha decidido pasarle con una persona. El bot ya no le contesta." }), { channel: "facebook", dedup: dedupVentana("persona:ia:" + psid, 30) }); // NOTIFICACIONES-1
  try { await sendFbText(psid, ctl.clean, pageId); }
  catch (e) { app.log.error({ sid: psid, err: (e as Error).message }, "FB: fallo enviando respuesta (conversación ya registrada)"); }
}

app.get("/webhook/facebook", async (req, reply) => {
  const q = req.query as Record<string, string>;
  if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === get("whatsapp.verifyToken"))
    return reply.code(200).send(q["hub.challenge"]);
  return reply.code(403).send("forbidden");
});

app.post("/webhook/facebook", async (req, reply) => {
  const { raw, json } = req.body as { raw: Buffer; json: any };
  const _pas = entregaDePasarela(raw, req.headers);
  if (_pas === "repetida") return reply.code(200).send("ok"); // PASARELA-META-2 · ya entró: no se procesa dos veces
  const _dePas = _pas === "nueva";
  if (!_dePas && !verifySignatureAny(raw, req.headers["x-hub-signature-256"] as string, metaSecretCandidates()))
    return reply.code(401).send("bad signature");
  reply.code(200).send("ok");

  try {
    // WEBHOOK-RELAY-1 · igual que en Instagram: el objeto `page` tiene una sola URL de
    // callback por app. Facebook no se vende como canal, pero la Página del cliente
    // sigue conectada porque Instagram la exige, y sus eventos —incluidos los que
    // sostienen la mensajería de IG— tienen que llegar a SU panel, y solo los suyos.
    const _repFb = await relayRepartir(
      "/webhook/facebook",
      String(json?.object || "page"),
      (json?.entry ?? []) as any[],
      (e: any) => ({ canal: "page" as const, id: String(e?.id ?? "") }),
      get("meta.appSecret") || get("whatsapp.appSecret"),
      _dePas || String(req.headers[RELAY_HEADER] || "") === RELAY_HEADER_VALUE,
    );
    for (const _e of _repFb.enviados) {
      recordWebhook("facebook", _e.entregado
        ? "↪️ evento de la Página " + _e.ids.join(", ") + " entregado a su panel"
        : "⚠️ evento de la Página " + _e.ids.join(", ") + " NO se pudo entregar: " + (_e.error || "sin detalle"));
      if (!_e.entregado) app.log.warn({ ids: _e.ids, destino: _e.destino, error: _e.error }, "FB webhook: reenvío fallido, evento perdido");
    }
    for (const entry of _repFb.mias) {
      const pageId: string = String(entry?.id ?? "");
      if (!pageId) continue;
      // W6: routing canal→workspace por pageId. Fail-safe a 'default'. Se resuelve
      // ANTES de leer la Página: meta.fbAccounts es per-WS (WS_STRICT_SECRETS), así
      // que getFbAccount debe correr DENTRO del scope del workspace dueño; si no,
      // leería solo las Páginas de 'default' y descartaría las de otros workspaces.
      const _wsId = await resolveWorkspaceByChannel("fb", pageId);
      // WS-ARCHIVED-ROUTING: Página de un negocio ARCHIVADO → sumidero. Ya
      // contestamos 200 arriba; descartamos sin procesar. Jamás bajo 'default'.
      if (isSuspendedRoute(_wsId)) {
        recordWebhook("facebook", "⏸️ Página de un negocio archivado (" + pageId + ") — entrega aceptada y descartada sin procesar");
        console.warn(`[channel-routing] fb:${pageId} → sumidero: evento descartado (workspace archivado)`);
        continue;
      }
      await runWithWorkspace(_wsId, async () => {
      // Si la Page no está registrada en este workspace (p.ej. el user la
      // desconectó), descartamos el event silenciosamente.
      const acct = getFbAccount(pageId);
      if (!acct) {
        app.log.info({ pageId, wsId: _wsId }, "FB webhook: Page no registrada, evento descartado");
        return;
      }
      // TELEMETRIA-FB-1 (espejo de TELEMETRIA-IG-1): la cadena del webhook de Página
      // ya funcionaba, pero no dejaba NI UN rastro en Conexiones → "no responde" y
      // "no llega" eran indistinguibles. recordWebhook es un buffer en memoria: no
      // toca BD y no puede lanzar.
      {
        const _kinds = (entry?.changes ?? []).map((c: { field?: string }) => c.field).concat((entry?.messaging ?? []).length ? ["messaging"] : []).join(",") || "(vacío)";
        recordWebhook("facebook", "📥 evento de Página " + pageId + " · " + _kinds);
      }
      for (const m of entry?.messaging ?? []) {
        const sid: string = m?.sender?.id ?? "";
        const mtext: string = m?.message?.text ?? "";
        // Filtra echos de la propia Page y mensajes vacíos (delivery/read events).
        if (!sid || m?.message?.is_echo || sid === pageId) continue;
        // PASARELA-META-2 · el MISMO mensaje puede llegar más de una vez (Meta reintenta, y
        // la pasarela vuelve a entregar si la primera no se confirmó) y aquí no había
        // candado: el bot contestaba dos veces y la Bandeja lo apuntaba dos veces. Mismo
        // candado por mid que Instagram y WhatsApp; cubre también los adjuntos sin texto.
        const _fbMid = String(m?.message?.mid || "");
        if (_fbMid && !(await dbClaimOnce("_fb_msg", _fbMid))) {
          recordWebhook("facebook", "🔁 entrega repetida del mismo mensaje — descartada (" + _fbMid.slice(-12) + ")");
          continue;
        }
        // Adjunto sin texto: el bot no lo responde, pero se registra en la Bandeja
        // (ver logInboundAttachment: antes desaparecía sin dejar rastro).
        if (!mtext) {
          // MEDIA-BANDEJA-1: igual que en Instagram, la URL del adjunto se tiraba.
          const a0 = m?.message?.attachments?.[0];
          const att = a0?.type;
          if (att) {
            await logInboundAttachment(sid, String(att), "facebook", pageId ? "fb:" + pageId : "", "",
              a0?.payload?.url ? { url: String(a0.payload.url) } : undefined, String(m?.message?.mid || ""));
          }
          continue;
        }
        try {
          await handleFbDm(sid, mtext, pageId);
        } catch (e) {
          app.log.error({ sid, pageId, err: (e as Error).message }, "FB DM: fallo al responder");
        }
      }
      // Lead Ads (formularios nativos) llegan como entry.changes field=leadgen.
      // Aceptamos leadgen TAMBIÉN por este endpoint para que baste UN solo webhook
      // de Página (suscribiendo los campos `messages` + `leadgen`).
      for (const ch of entry?.changes ?? []) {
        if (ch?.field === "leadgen" && ch?.value) {
          try { await handleLeadgen(ch.value); }
          catch (e) { app.log.error({ pageId, err: (e as Error).message }, "leadgen (vía /webhook/facebook)"); }
        }
        // Comentarios en publicaciones de Página → motor de automatizaciones (paridad IG).
        // El campo 'feed' agrupa muchos eventos; filtramos solo comment/add ajenos a la Página.
        // NO lo gobierna el interruptor de la IA: es una automatización configurada a mano
        // (igual que en Instagram). Para pausarla, se pausa esa automatización.
        if (ch?.field === "feed" && ch?.value?.item === "comment" && (!ch.value.verb || ch.value.verb === "add")) {
          const val = ch.value;
          const cid = String(val.comment_id ?? "");
          if (!cid) continue;
          // no responder a la propia Página. Se descarta A PROPÓSITO, pero antes era
          // invisible: el owner probaba comentando desde la propia Página, no pasaba
          // nada y creía que la automatización estaba rota (espejo del anti-self IG).
          if (val.from?.id && String(val.from.id) === pageId) {
            recordWebhook("facebook", "💬 comentario propio de la Página descartado (anti-self: prueba desde OTRA cuenta)");
            continue;
          }
          // dedup reintentos Meta: el mismo comentario puede llegar varias veces.
          if (!(await dbClaimOnce("_fb_comment", cid))) {
            recordWebhook("facebook", "🔁 reintento de Meta del comentario " + cid + " · ya procesado, no se responde dos veces");
            continue;
          }
          // NOTIFICACIONES-1 · comentario (una vez por comentario: el claim de arriba)
          // NOTIF-COMENTARIO-ENLACE-1 · post de la Página con el comentario a la vista
          // (post_id = «{pageId}_{postId}», comment_id = «{postId}_{commentId}»).
          const fbPost = String(val.post_id ?? "").split("_");
          const fbLink = fbPost.length === 2 && /^\d+$/.test(fbPost[0]) && /^\d+$/.test(fbPost[1])
            ? "https://www.facebook.com/" + fbPost[0] + "/posts/" + fbPost[1] + "?comment_id=" + encodeURIComponent(cid.split("_").pop() || cid)
            : "";
          notificar({ kind: "comentario", title: "Comentario nuevo en Facebook" + (val.from?.name ? " de " + val.from.name : ""), body: "«" + String(val.message || "").replace(/\s+/g, " ").trim().slice(0, 140) + "»", channel: "facebook", account: pageId ? "fb:" + pageId : null, link: fbLink || null, dedup: "comentario:facebook:" + cid });
          // POSTID-FB-1 · el picker de publicaciones guarda el id tal cual lo devuelve
          // /{pageId}/published_posts (facebook.ts → listFbPosts), que SIEMPRE tiene el
          // formato "{pageId}_{postId}". Meta manda ese mismo formato en val.post_id, así
          // que lo normal es que esto sea un no-op. Pero matches() (automations.ts) compara
          // a.mediaId con ev.mediaId por igualdad ESTRICTA: si algún evento llegara con el
          // postId pelado, TODA automatización con publicación fijada moriría en silencio
          // (sin error, sin log, aparentemente configurada). Red de seguridad barata:
          // normalizamos al formato del picker y lo dejamos escrito en la telemetría, para
          // poder cotejar en vivo (Conexiones → Diagnóstico) el id que enseña el picker
          // con el que entrega Meta al comentar en un post de la Página.
          const rawPostId = String(val.post_id ?? "");
          const fbMediaId = rawPostId ? (rawPostId.includes("_") ? rawPostId : pageId + "_" + rawPostId) : "any";
          recordWebhook(
            "facebook",
            "💬 comentario de " + (val.from?.name || "?") + " en el post " + fbMediaId +
              (rawPostId && rawPostId !== fbMediaId ? " (Meta envió el id pelado " + rawPostId + ", normalizado)" : "") +
              ": \"" + String(val.message ?? "").slice(0, 40) + "\"",
          );
          const desdeFb = Date.now(); // PIEZAS-FB-1
          try {
            await handleCommentEvent({
              platform: "facebook",
              commentId: cid,
              text: val.message ?? "",
              username: val.from?.name ?? "",
              userId: val.from?.id ?? cid,
              mediaId: fbMediaId,
              pageId,
            });
          } catch (e) {
            app.log.error({ pageId, err: (e as Error).message }, "FB comment automation");
          }
          // PIEZAS-FB-1 (MET-FB-02) · si este comentario abrió una conversación por Messenger
          // (nació un run de flujo), se anota de qué publicación vino. Métricas → Facebook
          // lo enseña por publicación; sin run nuevo no se anota nada.
          if (fbMediaId !== "any" && val.from?.id) {
            await dbFbAnotarEntrada({ pageId, postId: fbMediaId, commentId: cid, phone: String(val.from.id), desde: desdeFb }).catch(() => false);
          }
        }
      }
      });
    }
  } catch (err) {
    app.log.error(err, "Facebook webhook");
  }
});

// ---------- Meta Lead Ads (formularios nativos) → CRM ----------
// Endpoint dedicado del use case "Capture & manage ad leads". Cada envío de formulario
// llega como webhook `leadgen` → leemos el lead (nombre/email/teléfono + campaña) y lo
// damos de alta en el CRM. Requiere permiso leads_retrieval (App Review) + suscribir el
// campo `leadgen` con esta Callback URL.
function leadsToken(): string {
  return get("meta.adsToken") || get("meta.igAccessToken") || get("meta.pageToken") || get("whatsapp.accessToken") || "";
}
async function handleLeadgen(value: any): Promise<void> {
  const leadgenId = String(value?.leadgen_id || "");
  if (!leadgenId) return;
  // Preferimos el PAGE access token de la Página dueña del formulario (tiene
  // leads_retrieval tras reconectar) y caemos al token de Ads como respaldo.
  const pageId = String(value?.page_id || "");
  const token = (pageId && getFbAccount(pageId)?.token) || leadsToken();
  if (!token) { app.log.warn("leadgen: no hay token con leads_retrieval configurado"); return; }
  recordWebhook("leadgen", `🎯 lead recibido (form ${value?.form_id || "?"} · page ${pageId || "?"})`);
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${leadgenId}?fields=field_data,campaign_name,form_name,ad_name,created_time&access_token=${encodeURIComponent(token)}`);
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(d.field_data)) { app.log.error({ err: d?.error?.message || r.status }, "leadgen fetch"); return; }
    const f: Record<string, string> = {};
    for (const it of d.field_data) f[String(it.name || "").toLowerCase()] = (it.values || [])[0] || "";
    const phone = (f["phone_number"] || f["phone"] || "").replace(/[^\d+]/g, "");
    const name = f["full_name"] || `${f["first_name"] || ""} ${f["last_name"] || ""}`.trim();
    const email = f["email"] || "";
    const key = phone || email || `lead_${leadgenId}`;          // clave de contacto: teléfono > email > id
    const campaign = String(d.campaign_name || "");
    const tags = campaign ? ["lead-ad", campaign] : ["lead-ad"];
    const fields: Record<string, string> = { lead_form: String(d.form_name || ""), lead_campaign: campaign, lead_ad: String(d.ad_name || "") };
    if (email) fields.email = email;
    const existing = await getContact(key);
    if (existing) await enrichContact(key, { tags, fields }); // ya existe → fusiona, no pisa
    else {
      await createContact({ phone: key, name: name || key, email, source: "meta-lead-ad", tags, fields });
      // NOTIFICACIONES-1 · lead_nuevo: la ficha nace con este mensaje (dedup por contacto).
      avisarLeadNuevo(key, { name: name || email, channel: "facebook", origen: "Ha rellenado el formulario de tu anuncio" + (campaign ? " «" + campaign + "»" : "") + "." });
    }
    app.log.info({ key, campaign }, "lead-ad guardado en CRM");
  } catch (e) {
    app.log.error({ err: (e as Error).message }, "leadgen");
  }
}

app.get("/webhook/meta-ads-leads", async (req, reply) => {
  const q = req.query as Record<string, string>;
  if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === get("whatsapp.verifyToken"))
    return reply.code(200).send(q["hub.challenge"]);
  return reply.code(403).send("forbidden");
});
app.post("/webhook/meta-ads-leads", async (req, reply) => {
  const { raw, json } = req.body as { raw: Buffer; json: any };
  const _pas = entregaDePasarela(raw, req.headers);
  if (_pas === "repetida") return reply.code(200).send("ok"); // PASARELA-META-2 · ya entró: no se procesa dos veces
  if (_pas !== "nueva" && !verifySignatureAny(raw, req.headers["x-hub-signature-256"] as string, metaSecretCandidates()))
    return reply.code(401).send("bad signature");
  reply.code(200).send("ok");
  try {
    for (const entry of json?.entry ?? []) {
      for (const ch of entry?.changes ?? []) {
        if (ch?.field === "leadgen" && ch?.value) {
          // W6: routing por page_id del lead → workspace. Solo cae a 'default'
          // si esa Página no está dada de alta en ningún workspace.
          const _pageId = String(ch.value.page_id || entry?.id || "");
          const _wsId = await resolveWorkspaceByChannel("fb", _pageId);
          // WS-ARCHIVED-ROUTING: lead de un negocio ARCHIVADO → sumidero. No se
          // guarda en el CRM de nadie (nunca en el del owner por caer a 'default').
          if (isSuspendedRoute(_wsId)) {
            console.warn(`[channel-routing] fb-lead:${_pageId} → sumidero: lead descartado (workspace archivado)`);
            continue;
          }
          await runWithWorkspace(_wsId, () => handleLeadgen(ch.value));
        }
      }
    }
  } catch (err) {
    app.log.error(err, "leadgen webhook");
  }
});

// ---------- Webhook de systeme.io / leadmatch-lab ----------
// systeme.io hace POST aquí en los eventos elegidos (Registro / Asignación de etiqueta…).
// Guardado por clave compartida (?k=…). v1: registra el payload para inspección; la
// correlación token↔contacto (para el gate "¿Abrió el correo?" con landing) se cablea
// tras confirmar el payload real. Ver systemeio-webhook.ts.
app.post("/webhook/systemeio", handleSystemeioWebhook);

// ---------- VENTA-WEBHOOK-1 · webhook de ventas universal ----------
// Cualquier plataforma de pago avisa de una venta: ?ws=<workspace>&k=<clave del negocio>.
// Como en Typeform, el ws de la URL no se cree sin más: la clave vive cifrada EN ese
// workspace. JSON (llega envuelto {raw,json}) o formulario (objeto plano).
app.post("/webhook/ventas", async (req, reply) => {
  const q = req.query as Record<string, string>;
  const wsId = String(q.ws || "").slice(0, 80);
  const clave = String(q.k || req.headers["x-clave"] || "").slice(0, 200);
  if (!wsId || !clave) return reply.code(400).send({ error: "falta ws o k" });
  const ws = await dbGetWorkspace(wsId).catch(() => null);
  if (!ws || ws.archived || ws.archived_at) return reply.code(410).send({ error: "gone" });
  const b = req.body as { raw?: Buffer; json?: unknown } | Record<string, unknown> | undefined;
  let cuerpo: unknown = b && Buffer.isBuffer((b as { raw?: unknown }).raw) ? (b as { json?: unknown }).json : b;
  // text/plain (algunos Zaps y webhooks caseros): Fastify lo entrega como texto. Se prueba
  // JSON, luego formulario; si no es ninguno, el texto entero (puede llevar ?ref= o un correo).
  if (typeof cuerpo === "string") {
    const t = cuerpo.trim();
    try { cuerpo = JSON.parse(t); }
    catch {
      const o: Record<string, string> = {};
      if (/^[^=\s&]+=/.test(t)) new URLSearchParams(t).forEach((v, k) => (o[k] = v));
      cuerpo = Object.keys(o).length ? o : { texto: t.slice(0, 5000) };
    }
  }
  return runWithWorkspace(wsId, async () => {
    const { claveVentasValida, procesarVenta } = await import("./ventas-webhook.js");
    if (!claveVentasValida(clave)) return reply.code(401).send({ error: "clave no válida" });
    // Error → 500 para que la plataforma reintente (el reintento lo frena last_purchase_ref).
    try { return reply.code(200).send(await procesarVenta(cuerpo ?? {})); }
    catch (err) { app.log.error(err, "webhook ventas"); return reply.code(500).send({ error: "retry" }); }
  });
});

// ---------- FORMULARIOS-1 · formularios propios: página pública /f/<slug> ----------
// El slug es único en toda la plataforma y la fila trae su workspace: todo lo demás
// corre dentro de ese ámbito. Negocio archivado o formulario borrado → «no disponible».
async function formularioPublico(slug: string) {
  const s = String(slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60);
  if (!s) return null;
  const form = await dbFormBySlugPublico(s).catch(() => null);
  if (!form) return null;
  const ws = await dbGetWorkspace(form.tenant_id || "").catch(() => null);
  if (!ws || ws.archived || ws.archived_at) return null;
  return { form, ws };
}
function origenDe(req: any): string {
  const proto = String((req.headers["x-forwarded-proto"] as string) || req.protocol || "https").split(",")[0].trim();
  return proto + "://" + String(req.headers.host || "");
}
function ipDe(req: any): string {
  return String(req.ip || (req.socket && req.socket.remoteAddress) || "").slice(0, 80);
}
// FORMULARIOS-8 · imagen o vídeo de una pregunta: sin sesión (lo ve quien responde) y sólo filas
// source='form'. Sirve por trozos (Range): Safari no reproduce un vídeo que no se sirva así.
app.get("/f/m/:id", async (req, reply) => {
  const id = String((req.params as any).id || "");
  const m = /^[0-9a-f-]{36}$/.test(id) ? await dbGetFormMedia(id).catch(() => null) : null;
  if (!m || !m.data) return reply.code(404).type("text/plain; charset=utf-8").send("No encontrado");
  const data = m.data as Buffer, total = data.length;
  // cross-origin: la vista previa del editor es un marco aislado (origen opaco).
  reply.header("Cache-Control", "public, max-age=31536000, immutable").header("X-Content-Type-Options", "nosniff")
    .header("Accept-Ranges", "bytes").header("Cross-Origin-Resource-Policy", "cross-origin");
  const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (rg && (rg[1] || rg[2])) {
    const ini = rg[1] ? parseInt(rg[1], 10) : Math.max(0, total - parseInt(rg[2], 10));
    const fin = rg[1] && rg[2] ? Math.min(total - 1, parseInt(rg[2], 10)) : total - 1;
    if (ini > fin || ini >= total) return reply.code(416).header("Content-Range", "bytes */" + total).send();
    return reply.code(206).header("Content-Range", "bytes " + ini + "-" + fin + "/" + total).type(m.content_type).send(data.subarray(ini, fin + 1));
  }
  return reply.type(m.content_type).send(data);
});
// FORM-ARCHIVO-1 · lo que adjuntó quien responde. Sin sesión: el enlace va en el aviso por
// correo y en la exportación; el id es un UUID imposible de adivinar. Nunca se interpreta
// como página (nosniff + sandbox): sólo JPG, PNG, HEIC o PDF comprobados por sus bytes.
app.get("/f/a/:id", async (req, reply) => {
  const id = String((req.params as any).id || "");
  const m = /^[0-9a-f-]{36}$/.test(id) ? await dbGetFormRespMedia(id).catch(() => null) : null;
  if (!m || !m.data) return reply.code(404).type("text/plain; charset=utf-8").send("No encontrado");
  return reply.header("Cache-Control", "private, max-age=3600").header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "sandbox").header("X-Robots-Tag", "noindex").header("Referrer-Policy", "no-referrer")
    .header("Content-Disposition", m.content_type === "image/heic" ? "attachment" : "inline")
    .type(m.content_type).send(m.data);
});
// FORM-ARCHIVO-1 · subida previa de un archivo (base64 en JSON: 20 MB ≈ 27 MB de cuerpo).
app.post("/f/:slug/archivo", { bodyLimit: 30 * 1024 * 1024 }, async (req, reply) => {
  const r = await formularioPublico((req.params as any).slug);
  reply.header("Cache-Control", "no-store");
  if (!r) return reply.code(404).send({ ok: false, error: "Este formulario ya no está disponible." });
  const { json } = (req.body || {}) as { json?: any };
  const body = json && typeof json === "object" ? json : {};
  return runWithWorkspace(r.form.tenant_id!, async () => {
    const res = await subirArchivoFormulario(r.form, body, ipDe(req));
    if (!res.ok) return reply.code(res.status).send({ ok: false, error: res.error });
    return reply.send(res);
  });
});
app.get("/f/:slug", async (req, reply) => {
  const r = await formularioPublico((req.params as any).slug);
  // FORMULARIOS-DISENO-1 · el HTML y el CSS propios del formulario comparten dominio con el
  // panel: sólo corre NUESTRO script (nonce), aunque algo se colara en el saneado.
  const nonce = crypto.randomBytes(16).toString("base64");
  reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex").header("Content-Security-Policy", cspFormulario(nonce, r ? origenCita(r.form) : "")).header("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!r) return reply.code(404).type("text/html; charset=utf-8").send(paginaNoEncontrada());
  return runWithWorkspace(r.form.tenant_id!, async () => {
    // Los robots de vista previa (WhatsApp, Instagram…) no cuentan como visita.
    const ua = String(req.headers["user-agent"] || "");
    if (r.form.status === "active" && !/bot|crawler|spider|facebookexternalhit|whatsapp|preview|slurp/i.test(ua)) await contarVisita(r.form, ipDe(req));
    return reply.type("text/html; charset=utf-8").send(paginaFormulario(r.form, String((r.ws as any).name || ""), nonce));
  });
});
// FORM-CITA-1 · vuelta del calendario de reservas de la web. Además de cerrar el paso,
// adelanta la copia de reservas de ESE workspace: la confirmación por WhatsApp (flujos
// «Reserva») sale en segundos en vez de esperar a la pasada de cada 10 min.
app.get("/f/:slug/reservada", async (req, reply) => {
  const r = await formularioPublico((req.params as any).slug);
  const nonce = crypto.randomBytes(16).toString("base64");
  reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex").header("Content-Security-Policy", cspFormulario(nonce)).header("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!r) return reply.code(404).type("text/html; charset=utf-8").send(paginaNoEncontrada());
  return runWithWorkspace(r.form.tenant_id!, async () => {
    if (citaDe(r.form)) {
      // FORM-CITA-2 · los datos de quien reservó (?bs=…&nombre=…&email=…&telefono=…) se unen a
      // su respuesta ANTES de la copia de reservas, que la encuentra por el correo y manda la
      // confirmación. Con tope de espera: la página de vuelta nunca se queda colgada.
      await Promise.race([completarReserva(r.form, (req.query || {}) as Record<string, unknown>), new Promise((ok) => setTimeout(ok, 5_000))]);
      sioBookingsPokeWorkspace(r.form.tenant_id!);
    }
    return reply.type("text/html; charset=utf-8").send(paginaReservada(r.form, String((r.ws as any).name || ""), nonce));
  });
});
app.post("/f/:slug", async (req, reply) => {
  const r = await formularioPublico((req.params as any).slug);
  reply.header("Cache-Control", "no-store");
  if (!r) return reply.code(404).send({ ok: false, error: "Este formulario ya no está disponible." });
  const { json } = (req.body || {}) as { json?: any };
  const body = json && typeof json === "object" ? json : {};
  return runWithWorkspace(r.form.tenant_id!, async () => {
    const res = await enviarFormulario(r.form, body, ipDe(req), origenDe(req));
    if (!res.ok) return reply.code(res.status).send({ ok: false, error: res.error, campo: res.campo });
    return reply.send(res);
  });
});

// ---------- Chatfuel JSON API (puente TikTok) ----------
// Chatfuel es partner oficial de TikTok. Su API de salida NO expone TikTok, pero
// su plugin "JSON API" sí: el flow de TikTok en Chatfuel llama AQUÍ, nuestro
// cerebro IA calcula la respuesta y la devolvemos en el formato de Chatfuel
// ({messages:[{text}]}) → Chatfuel la envía por TikTok (lo hace su flow, que sí
// puede). Síncrono (timeout Chatfuel = 10s; think() ~2s). El lead entra en CRM
// como canal del query (?channel=tiktok). Config en Chatfuel: bloque JSON API a
//   /chatfuel/json?k=<secret>&uid={{chatfuel user id}}&text={{last user freeform input}}&channel=tiktok&name={{first name}}
async function chatfuelJson(req: any, reply: any) {
  const q = (req.query || {}) as Record<string, string>;
  const body = (req.body && (req.body as { json?: any }).json) || {};
  const secret = get("chatfuel.jsonSecret");
  if (!secret) {
    return reply.code(503).send({ error: "chatfuel.jsonSecret no configurado", messages: [] });
  }
  const provided = String((req.headers["x-chatfuel-secret"] as string) || q.k || "");
  const secretBuf = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);
  const ok = providedBuf.length === secretBuf.length && crypto.timingSafeEqual(providedBuf, secretBuf);
  if (!ok) return reply.code(401).send({ messages: [] });
  const uid = String(
    q.uid || body["chatfuel user id"] || body["messenger user id"] || body.id || body.uid || "",
  ).trim();
  const text = String(
    q.text || body["last user freeform input"] || body.text || body.message || "",
  ).trim();
  const channel = String(q.channel || body.channel || "tiktok").toLowerCase();
  const name = String(q.name || body["first name"] || body.name || "").trim();
  if (!uid || !text) return reply.send({ messages: [] });
  try {
    // AI-ACT-CHATFUEL-1 · esta vía devolvía la respuesta del cerebro SIN identificar que
    // la escribe una IA, y la ficha de cumplimiento delegaba el aviso en el integrador
    // sin comprobar que existiera: quien montara el flujo en Chatfuel podía presentarla
    // como si contestara una persona. No hace falta cambiar nada en Chatfuel: su bloque
    // JSON API ya envía TODOS los mensajes del array en orden, así que el aviso viaja
    // como primer mensaje, una sola vez por conversación y con la MISMA marca que el
    // resto de canales (quien ya lo recibió por WhatsApp o Instagram no lo repite aquí).
    const previa = await getSession(uid);
    const avisoIa = needsAiDisclosure(previa) ? aiTransparencyNotice() : "";
    const out = await brainReply(uid, text, channel, name);
    if (!out) return reply.send({ messages: [] });
    if (avisoIa) {
      // Se marca DESPUÉS de saber que hay respuesta que enviar: si el bot está apagado
      // o la conversación pasó a atención humana, no se da por avisado a nadie.
      try {
        await ensureSession(uid, (await getSession(uid))?.botId || "");
        await append(uid, { role: "assistant", content: avisoIa, notice: "ai" });
      } catch { /* el aviso sale igual; como mucho se repite en el siguiente mensaje */ }
    }
    return reply.send({ messages: avisoIa ? [{ text: avisoIa }, { text: out }] : [{ text: out }] });
  } catch (e) {
    app.log.error({ uid, err: (e as Error).message }, "Chatfuel JSON API");
    return reply.send({ messages: [] });
  }
}
app.post("/chatfuel/json", chatfuelJson);
app.get("/chatfuel/json", chatfuelJson);

// Cerebro para canales-vía-Chatfuel (TikTok): registra el contacto con su canal,
// corre el cerebro y DEVUELVE el texto (Chatfuel lo envía). No usa los senders de
// WhatsApp/IG (no aplican a este canal); no dispara flows (enviarían por el canal
// equivocado). Persiste la conversación → aparece en la Bandeja.
async function brainReply(uid: string, text: string, channel: string, name: string): Promise<string | null> {
  const chanOn = autoReplyOn("tiktok");
  // Comando de reinicio — solo si el canal está ENCENDIDO (ver los otros canales: con el
  // bot apagado el mensaje debe seguir hasta la Bandeja en vez de morir aquí).
  if (chanOn && /^\/?(reset|reiniciar|empezar)$/i.test(text.trim())) {
    reset(uid);
    await cancelSequences(uid);
    return "Conversación reiniciada. ¿En qué te ayudo?";
  }
  // Bot pegajoso; con el canal apagado no se consulta a la IA (ver WhatsApp).
  const existing = await getSession(uid);
  // Misma regla que el resto de canales (bots.ts): pausado no atiende, borrado
  // no hereda. Sin perfil que atienda, se calla con el motivo escrito.
  const at = quienAtiende(existing?.botId || "", "");
  const bot = at.estado === "atiende" ? at.bot : at.estado === "enrutar" && chanOn ? await classifyBot(text) : null;
  if (!bot) {
    const motivo = at.estado === "callar" ? at.motivo : chanOn ? "no hay ningún perfil activo" : "el canal está apagado";
    recordWebhook("tiktok", "🔇 sin respuesta: " + motivo + ". El mensaje está en la Bandeja");
    return "";
  }
  const assignedBotId = existing?.botId || (chanOn ? bot.id : "");
  if (existing && assignedBotId && existing.botId !== assignedBotId) await repinBot(uid, assignedBotId);
  // NOTIFICACIONES-1 · lead_nuevo: la ficha nace con este mensaje (dedup por contacto).
  if (await touchContact(uid, name || "", assignedBotId)) avisarLeadNuevo(uid, { name, channel: "tiktok" });
  try {
    await updateContact(uid, { source: channel });
  } catch {
    /* best effort */
  }
  await cancelSequences(uid);
  const c = await getContact(uid);
  if (c?.human) {
    // NOTIFICACIONES-1 · mensaje_sin_bot: la IA no contesta, así que alguien tiene que hacerlo.
    avisarContacto("mensaje_sin_bot", uid, (nm) => ({ title: nm + " te ha escrito", body: "«" + String(text || "").replace(/\s+/g, " ").trim().slice(0, 140) + "»" + " — la conversación la atiendes tú: el bot no contesta." }), { name: c?.name, channel: "tiktok", dedup: dedupVentana("sinbot:" + uid, 30) });
    // Handoff humano: registra el mensaje, sin auto-respuesta.
    await ensureSession(uid, assignedBotId);
    await append(uid, { role: "user", content: text });
    return null;
  }

  // INTERRUPTOR DEL CANAL. Este puente (Chatfuel → TikTok) es un canal más: si el panel
  // dice que el bot no contesta, aquí tampoco puede contestar. Devolvemos null (Chatfuel
  // no envía nada) y dejamos el mensaje registrado en la Bandeja, igual que los demás.
  if (!chanOn) {
    await ensureSession(uid, assignedBotId);
    await append(uid, { role: "user", content: text });
    app.log.info({ uid, channel }, "auto-reply OFF (tiktok): bot en silencio");
    return null;
  }
  const raw2 = await think({ userId: uid, bot, userText: text, channel: "tiktok" });
  const ctl = extractControls(raw2);
  if (ctl.tags.length || Object.keys(ctl.fields).length)
    await enrichContact(uid, { tags: ctl.tags, fields: ctl.fields });
  // AI-ACT-ESCALAR-1 · el aviso promete «Puedes pedir atención personal», y aquí se
  // ignoraba ESCALAR_HUMANO: el bot seguía contestando. Mismo traspaso que IG y FB.
  if (ctl.escalate) await setHuman(uid, true);
  if (ctl.escalate) avisarContacto("pide_persona", uid, (nm) => ({ title: nm + " pasa a tu equipo", body: "El asistente ha decidido pasarle con una persona. El bot ya no le contesta." }), { channel: "tiktok", dedup: dedupVentana("persona:ia:" + uid, 30) }); // NOTIFICACIONES-1
  return ctl.clean;
}

// ---------- Boot ----------

/**
 * RED-1 · Que un error suelto NO tumbe el bot entero.
 *
 * Desde Node 15, una promesa rechazada que nadie captura MATA el proceso. Aquí hay
 * varios temporizadores de fondo (scheduler de flujos, sondeo de Instagram, autopost,
 * YouTube) que se lanzan sin await: un fallo transitorio de Postgres o de red dentro de
 * cualquiera de ellos bastaba para tirar el servidor, y con él las automatizaciones de
 * WhatsApp que están en producción — que es el peor resultado posible, porque el fallo
 * no tenía NADA que ver con WhatsApp.
 *
 * Se registra bien alto (y en Actividad, para que se vea en el panel) y se sigue vivo.
 * Un mensaje perdido es mucho menos grave que el bot caído: Railway tarda minutos en
 * reiniciar y mientras tanto no se atiende ni un webhook.
 */
function installCrashGuards(): void {
  process.on("unhandledRejection", (reason) => {
    const msg = (reason as Error)?.stack || String(reason);
    console.error("[CRASH-GUARD] promesa sin capturar (el proceso SIGUE vivo):", msg);
    void logActivity({
      source: "app",
      level: "error",
      summary: "Error de fondo no capturado: " + String((reason as Error)?.message || reason).slice(0, 120),
      payload: { file: "index.ts", fn: "unhandledRejection", error: msg.slice(0, 800) },
    }).catch(() => { /* si ni esto se puede registrar, al menos queda en consola */ });
  });
  process.on("uncaughtException", (err) => {
    console.error("[CRASH-GUARD] excepción no capturada (el proceso SIGUE vivo):", err?.stack || err);
    void logActivity({
      source: "app",
      level: "error",
      summary: "Excepción de fondo no capturada: " + String(err?.message || err).slice(0, 120),
      payload: { file: "index.ts", fn: "uncaughtException", error: (err?.stack || String(err)).slice(0, 800) },
    }).catch(() => { /* idem */ });
  });
}

/**
 * PASARELA-META-2 · Declara a la pasarela los canales de esta instancia. Antes sólo se
 * hacía al arrancar y cada 5 min: un número recién conectado se quedaba hasta 5 min sin
 * recibir (la pasarela no sabía que era nuestro) y uno quitado seguía reclamándose.
 * Ahora la llama cada cambio de canales (alInvalidarRutas). Se puede llamar a ráfagas:
 *   · las llamadas juntas se agrupan en UNA declaración, como mucho `esperaMs` después
 *     de la primera, y ésa lee los canales del momento (incluye los cambios de la ráfaga);
 *   · nunca hay dos declaraciones a la vez: si algo cambia con una en vuelo, se repite
 *     al acabar, para que la última palabra la tenga siempre la lista más reciente.
 */
let _pasTimer: ReturnType<typeof setTimeout> | null = null;
let _pasEnVuelo = false;
let _pasRepetir = false;
let _pasForzar = false;
// PASARELA-META-2 · cualquier escritura de ajustes invalida las rutas: sin esto, cada guardado
// mandaba a la pasarela la misma lista otra vez. El arranque y el repaso periódico sí fuerzan.
let _pasUltima = { lista: "", en: 0 };
export function sincronizarPasarela(esperaMs = 2_000, forzar = false): void {
  if (forzar) _pasForzar = true;
  if (_pasTimer) return; // ya hay una en camino: recogerá también este cambio
  _pasTimer = setTimeout(() => {
    _pasTimer = null;
    if (_pasEnVuelo) { _pasRepetir = true; return; }
    _pasEnVuelo = true;
    void (async () => {
      try {
        do {
          _pasRepetir = false;
          const f = _pasForzar; _pasForzar = false;
          await declararPasarelaAhora(f);
        } while (_pasRepetir);
      } finally { _pasEnVuelo = false; }
    })();
  }, esperaMs);
  _pasTimer.unref?.();
}

async function declararPasarelaAhora(forzar: boolean): Promise<void> {
  if (modoMetaApp() !== "pasarela") return;
  try {
    const canales = await canalesParaPasarela();
    // Lista vacía: la pasarela la rechaza (soltar todos los canales es cosa del operador),
    // así que no se manda. Antes salía un aviso de error cada 5 min sin que nada fallara.
    if (!canales.length) { app.log.info("[pasarela] sin canales que declarar"); return; }
    const lista = [...canales].sort().join(",");
    if (!forzar && lista === _pasUltima.lista && Date.now() - _pasUltima.en < 60_000) return;
    const r = await declararCanales(canales);
    _pasUltima = { lista, en: Date.now() };
    if (r?.conflictos.length) {
      app.log.warn(`[pasarela] canales que ya son de otra instancia: ${r.conflictos.join(", ")}`);
      // PASARELA-META-2 · que se vea también en el Diagnóstico del panel, no sólo en el log
      // del servidor: el cliente veía su número «Operativo» y no le llegaba nada.
      const nombre = (c: string) => c.replace(/^wa:/, "número ").replace(/^waba:/, "cuenta de WhatsApp ").replace(/^ig:/, "Instagram ").replace(/^page:/, "Página ");
      recordWebhook("pasarela", "⚠️ ya está conectado en otro panel, sus mensajes no llegarán aquí: " + r.conflictos.map(nombre).join(", "));
    }
  } catch (e) { app.log.warn(`[pasarela] no se pudieron declarar los canales: ${(e as Error).message}`); }
}

async function main() {
  installCrashGuards();
  // SECRETOS-ARRANQUE-1 · avisa en el log de los secretos que faltan o son débiles; no
  // bloquea (el único bloqueo sigue siendo el de F5 en assertEncKeyOrMigrate).
  comprobarSecretosDeArranque();
  await initDb();
  // SESION-REVOCABLE-1 · la lista de sesiones cerradas, antes de atender peticiones.
  await iniciarSesionesRevocadas();
  // F5 · verifica/migra la cripto ANTES de leer secretos (fail-fast si en prod
  // falta APP_ENC_KEY; migra secretos dev-key→key real si los hubiera).
  // ROTACION-ENC-1 · y re-cifra con APP_ENC_KEY lo que abra solo con APP_ENC_KEY_OLD.
  await assertEncKeyOrMigrate();
  await loadSettings();
  startScheduler();
  startFlowScheduler();
  startPostScheduler();
  startAutopostScheduler();
  // Copia horaria incremental de los leads de systeme.io con su URL de origen
  // (atribución en Métricas → Origen). Sin cuentas con API key no hace nada.
  startSioLeadsScheduler();
  // Reservas del calendario de booking de cada web (API pública oficial) →
  // vista Reuniones. Sin cuentas con API key no hace nada.
  startSioBookingsScheduler();
  // FUNNELS-1 · la estructura de los funnels de cada web (todas las cuentas, todos los workspaces).
  startSioFunnelsScheduler();
  // T03-CORREOS · reconciliación de eventos de correo (etiqueta puente) — red
  // de seguridad del webhook. Sin flujos de correo activos no llama a nada.
  startEmailEventsScheduler();
  startPurchaseReconcileScheduler();
  // YouTube no tiene webhooks de comentarios (WebSub solo avisa de vídeos
  // nuevos) → el auto-reply necesita preguntar cada X. No hace nada si el
  // interruptor está apagado, que es como viene de fábrica.
  startYoutubeCommentPoller();
  // LinkedIn tampoco tiene webhook de comentarios (app CM self-serve) → mismo poller.
  // Apagado de fábrica (linkedin.autoreply.enabled); no gasta API si no está encendido.
  startLinkedinCommentPoller();
  // Facebook sí tiene webhook, pero si Meta no lo entrega (campo feed sin suscribir) el comentario se pierde en silencio:
  // este sondeo lo rescata por API. Solo mira si hay flujos/disparadores de Facebook activos.
  startFacebookCommentSafetyNet();
  startSaludConexiones(); // AVISO-CONEXION-1
  startMcpBridgeWorker();
  startSnapshotWorker();
  startAnalyticsWarmer();
  // difusion-flow D3: worker periódico que procesa la cola de jobs (15 s)
  // y dispara followups vencidos (60 s). Idempotente: si ya está activo,
  // no duplica timers. Multi-tenant safe vía SKIP LOCKED + runWithWorkspace.
  registerBroadcastFlowsWorker();
  const port = Number(process.env.PORT || 8080);
  await app.listen({ port, host: "0.0.0.0" });
  void qrRestoreAll().catch(e => app.log.error({err:e},"No se pudieron recuperar las conexiones por QR"));
  // MARCA-EDITABLE-1 · qué tenants tienen logo propio; sin esto page() pintaría el de fábrica.
  void warmLogoVersions();
  // PASARELA-META-1 · declarar a la pasarela los canales de esta instancia (al arrancar y
  // cada 5 min). Un canal que ya es de otra instancia se queda fuera y se avisa en el log.
  // PASARELA-META-2 · y además en cuanto cambian (ver sincronizarPasarela).
  {
    // PASARELA-META-2 · pasarela a medio configurar: sin esto la instancia se quedaba sin
    // Meta y nadie sabía por qué. Dice QUÉ falla, nunca los valores.
    const _falla = pasarelaIncompleta();
    if (_falla) app.log.warn(`[pasarela] META_GATEWAY_URL/META_GATEWAY_KEY puestas, pero la pasarela no se puede usar: ${_falla}`);
  }
  alInvalidarRutas(() => sincronizarPasarela());
  sincronizarPasarela(0, true);
  setInterval(() => sincronizarPasarela(0, true), Number(process.env.PASARELA_SYNC_MS || 300_000)).unref();
  app.log.info(`stack app escuchando en :${port} — panel en /admin`);
  // CHAT-POR-NUMERO-1 · backfill del resumen por número de las conversaciones viejas.
  // DESPUÉS de listen y sin await: si fallara, se loguea y el servicio sigue — un
  // backfill jamás puede costar un healthcheck. Después corre PLANTILLA-REPARA-1
  // (secuencial: no acaparar el pool).
  setTimeout(() => {
    void dbBackfillConvAccts()
      .then((r) => { if (r.updated) app.log.info(`[chat-por-numero] backfill accts: ${r.updated} conversaciones actualizadas`); })
      .then(() => backfillPlantillaTurns())
      // BANDEJA-FIX-2 · la limpieza del histórico (fusión de cuentas + dedup) va
      // ENCADENADA detrás de las dos de arriba, no en paralelo: las tres reescriben
      // app_conversations, y solaparlas solo multiplicaría los reintentos por bloqueo
      // optimista sin ganar nada (ninguna es urgente — todas corren en segundo plano).
      .then(() => limpiarHistoricoAlArrancar())
      .then(() => repararQrHuerfanas())
      .catch((e) => app.log.warn("[chat-por-numero] backfill falló (se reintenta en el próximo arranque): " + (e as Error).message));
  }, 5000);
}

// NUM-RETIRADO-1 · Backfill de arranque, una sola vez: sesiones QR que murieron por
// logout ANTES de que existiera el evento `disabled` (más abajo) se quedaron sin
// registro de retirado, con su teléfono ya borrado de la fila. Si se llegó a cachear
// mientras estaba viva (BANDEJA-FIX-1), aquí se recupera y se completa lo que faltó —
// así el chat deja de decir «Número retirado» a secas y, si el mismo teléfono ya
// reconectó por QR, gruposWaPorTelefono() puede fundir las dos filas en la Bandeja.
async function repararQrHuerfanas(): Promise<void> {
  const huerfanas = await qrHuerfanas();
  if (!huerfanas.length) return;
  let reparadas = 0;
  for (const h of huerfanas) {
    const ws = await dbGetWorkspace(h.workspaceId);
    if (!ws || ws.archived || ws.archived_at) continue;
    await runWithWorkspace(h.workspaceId, async () => {
      const acct = "wa:" + h.sessionId;
      if (retiradoPorAcct(acct)) return;
      const tel = telefonoRecordado(h.sessionId);
      if (!tel) return;
      await retirarNumero({ acct, phone: tel, label: h.label });
      reparadas++;
    });
  }
  if (reparadas) app.log.info(`[num-retirado] backfill: ${reparadas} sesión(es) QR huérfanas recuperadas`);
}

// PLANTILLA-REPARA-1 · Repara los turnos históricos «🧩 Plantilla · nombre — params»
// (guardados antes de PLANTILLA-BANDEJA-1): el nombre está en el propio texto y el
// cuerpo real sigue en el catálogo de Meta del workspace, así que la burbuja puede
// enseñar POR FIN el mensaje que recibió el cliente, con su insignia y sus botones.
// Reglas: catálogo por tenant (runWithWorkspace, cacheado); si la plantilla ya no
// existe o las variables no casan, el turno se queda como está (no se inventa nada);
// escritura con bloqueo optimista (dbRewriteConversationTurns) — una carrera con un
// mensaje entrante deja la fila intacta y se reintenta en el próximo arranque.
async function backfillPlantillaTurns(): Promise<void> {
  const convs = await dbScanLegacyTplConvs();
  if (!convs.length) return;
  const porTenant = new Map<string, string[]>();
  for (const c of convs) {
    const l = porTenant.get(c.tenant_id) || [];
    l.push(c.user_id);
    porTenant.set(c.tenant_id, l);
  }
  const RX = /^🧩 Plantilla · ([A-Za-z0-9_]+)(?: — ([\s\S]+))?$/;
  const nVarsDe = (body: string): number => {
    let n = 0;
    for (const x of body.matchAll(/\{\{(\d+)\}\}/g)) n = Math.max(n, Number(x[1]) || 0);
    return n;
  };
  let reparadas = 0;
  for (const [tenant, users] of porTenant) {
    await runWithWorkspace(tenant, async () => {
      let cat = new Map<string, WaTemplate>();
      try {
        cat = new Map((await listTemplates()).filter((t) => t.body).map((t) => [t.name, t]));
      } catch { /* sin catálogo (número desconectado): no se inventa nada */ }
      if (!cat.size) return;
      for (const user of users) {
        const ok = await dbRewriteConversationTurns(tenant, user, (turns) => {
          let cambio = false;
          const out = turns.map((raw) => {
            const t = raw as { role?: string; content?: string; tpl?: string };
            if (t?.role !== "assistant" || t.tpl) return raw;
            const m = RX.exec(String(t.content || ""));
            if (!m) return raw;
            const tpl = cat.get(m[1]);
            if (!tpl) return raw;
            let params = m[2] ? m[2].split(" · ") : [];
            const nVars = nVarsDe(String(tpl.body || ""));
            if (nVars === 0) params = [];
            else if (params.length !== nVars) {
              if (nVars === 1 && m[2]) params = [m[2]]; // el separador « · » iba dentro del único parámetro
              else return raw; // variables que no casan: mejor el literal viejo que un texto inventado
            }
            cambio = true;
            return {
              ...(raw as Record<string, unknown>),
              content: tplRenderText(tpl, params),
              tpl: tpl.name,
              ...(tpl.buttons?.length ? { btns: tpl.buttons } : {}),
            };
          });
          return cambio ? out : null;
        });
        if (ok) reparadas++;
        await new Promise((r) => setTimeout(r, 50)); // pacing
      }
    });
  }
  if (reparadas) app.log.info(`[plantilla-repara] ${reparadas} conversaciones enseñan ya el texto real de su plantilla`);
}
let cerrando = false;
for (const senal of ["SIGTERM", "SIGINT"]) {
  process.on(senal, () => {
    if (cerrando) return; // una segunda señal no reentra: dejaría el cierre a medias
    cerrando = true;
    app.log.info({ senal }, "Cerrando: se liberan las conexiones de WhatsApp por QR");
    const tope = setTimeout(() => {
      app.log.warn("El cierre limpio tardó demasiado; se sale igual");
      process.exit(0);
    }, 8_000);
    tope.unref();
    app.close()
      .catch((e) => app.log.error({ err: (e as Error).message }, "Fallo al cerrar limpiamente"))
      .finally(() => { clearTimeout(tope); process.exit(0); });
  });
}

main().catch((e) => {
  app.log.error(e);
  process.exit(1);
});
