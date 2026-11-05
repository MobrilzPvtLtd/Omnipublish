/**
 * Programador de publicaciones multi-plataforma (estilo Metricool).
 * Cada 60s revisa publicaciones pendientes vencidas y las despacha a las
 * plataformas seleccionadas. Instagram usa Graph API directo; el resto va
 * por los grupos de "Redes sociales" (cada grupo = su credencial).
 */
import {
  dbDueScheduledPosts,
  dbReelsPruebaRecientes,
  dbAplazarPost,
  dbSweepStuckSendingPosts,
  dbFinishScheduledPost,
  dbCongelarMiniatura,
  dbListContacts,
  dbClaimOnce,
  dbClaimsExisting,
  dbHasActiveFlowRun,
  dbSioBookingsRange,
  dbContactByEmail,
  dbClaimDueNewsletters,
  dbSweepStuckNewsletters,
  dbUpsertNewsletter,
  dbClaimDueNewsletterRoutines,
  dbGetNewsletterRoutine,
  type ScheduledPost,
} from "./db.js";
import { reconciliarNewsletter, refrescaSiProcede } from "./newsletter.js";
import { ejecutaRutina } from "./newsletter-rutinas.js";
import {
  publishImage,
  publishReel,
  publishCarousel,
  publishStory,
  resolveAccount,
  esVideoMedio,
  runWithAccount,
  commentOnMedia,
  type IgCreds,
} from "./instagram.js";
import { get, set, autoReplyOn, urlPublica, urlPublicaDeConfianza } from "./settings.js";
import { imagenesAShort, videoAHorizontal, videoAVertical, sondearVideo, esShortDeYoutube } from "./autopost/slideshow.js";
import { saveAsset, caducarMediosAntiguos, diasRetencionMedios } from "./page-builder.js";
import { posterParaCaducar } from "./autopost/poster.js";
import { miniaturaDePost } from "./media-snap.js";
import { flujosAlPublicarTick } from "./flujos-al-publicar.js";
import { runDueBroadcasts, reanudarDifusionesHuerfanas } from "./broadcasts.js";
import { zernioPublish, platformBlock, ZERNIO_BLOCK_SETTING } from "./autopost/zernio.js";
import { runWithWorkspace, listWorkspacesCached, currentWorkspaceId } from "./workspace.js";
import { logActivity } from "./activity.js";
import { publishX } from "./autopost/xpublish.js";
import { notificar } from "./notifications.js";
import { evaluateAllAlerts } from "./metaAdsAlerts.js";
import { inWindow, routeAccount, hasOptedOut } from "./contacts.js";
import { sendText, sendTemplate, resolveWaNumber, runWithWaNumber } from "./whatsapp.js";
import { listFlows, saveFlow, triggerReminderFlow, type Flow } from "./flows.js";

interface PlatformResult { platform: string; ok: boolean; message: string; }

// Concatena mentions y hashtags al caption (estilo IG: línea en blanco
// + @uno @dos · línea en blanco + #uno #dos). Universal para TODAS las redes
// porque cada plataforma parsea @ y # del texto plano.
// TEXTO-POR-RED-1 · con «red», el texto propio de esa red si lo tiene; si no, el general.
function captionWithTags(p: ScheduledPost, red?: string): string {
  const t = p.tags || {};
  const propio = red && t.captions && typeof t.captions[red] === "string" && t.captions[red].trim() ? t.captions[red] : "";
  const base = (propio || p.caption || "").trimEnd();
  const mentions = (t.mentions || []).filter(Boolean).map((m) => "@" + m.replace(/^@+/, ""));
  const hashtags = (t.hashtags || []).filter(Boolean).map((h) => "#" + h.replace(/^#+/, ""));
  const blocks: string[] = [base];
  if (mentions.length) blocks.push(mentions.join(" "));
  if (hashtags.length) blocks.push(hashtags.join(" "));
  return blocks.filter(Boolean).join("\n\n");
}

// media_url de un carrusel es JSON con varias URLs (así lo documenta el esquema,
// db.ts). Devuelve la lista real de medios del post (1..N).
function mediaUrlsOf(p: ScheduledPost): string[] {
  const raw = String(p.media_url || "").trim();
  if (!raw) return [];
  if (raw[0] === "[") {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        const urls = arr.map((x) => String(x)).filter((x) => /^https?:\/\//.test(x));
        if (urls.length) return urls;
      }
    } catch { /* no era JSON → URL simple */ }
  }
  return [raw];
}

async function publishInstagram(p: ScheduledPost): Promise<PlatformResult> {
  // T04 · sin fallback silencioso: si el post nombra una cuenta y ya no está
  // conectada, se falla con motivo claro. Antes caía al token principal del
  // workspace y publicaba desde OTRA cuenta sin avisar. El fallback a los
  // settings legacy queda solo para posts antiguos sin ig_id.
  const named = p.ig_id ? resolveAccount(p.ig_id) : null;
  if (p.ig_id && !named) {
    return { platform: "instagram", ok: false, message: "La cuenta de Instagram de este post ya no está conectada — reconéctala en Conexiones" };
  }
  const acct: IgCreds = named || {
    token: get("meta.igAccessToken"),
    igId: get("meta.igBusinessId"),
  };
  const caption = captionWithTags(p, "instagram");
  const opts = {
    collaborator: p.tags?.igCollab || undefined,
    userTags: p.tags?.igUserTags && p.tags.igUserTags.length ? p.tags.igUserTags : undefined,
    coverUrl: p.tags?.cover || undefined, // PORTADA-1
    coverOffsetMs: p.tags?.coverOffsetMs || undefined,
  };
  // REEL-PRUEBA-1 · una Foto o un Carrusel marcado «como Reel» se publica con el vídeo que se
  // monta con sus imágenes (el mismo que el Short de YouTube). El reel de prueba solo vale en Reels.
  const comoReel = (p.kind === "image" || p.kind === "carousel") && p.tags?.igComoReel === true;
  const trial = p.tags?.igTrial || undefined;
  let videoReel = "";
  if (comoReel) {
    try { videoReel = await shortDeImagenes(p); }
    catch (e) { return { platform: "instagram", ok: false, message: ("No se pudo montar el vídeo del reel: " + (e as Error).message).slice(0, 200) }; }
  }
  try {
    // CARRUSEL-IG-1 · el carrusel va con TODAS sus URLs (antes se rechazaba en Instagram).
    // HISTORIAS-1 · la historia no lleva texto (Instagram no lo admite en historias).
    const id = await runWithAccount(acct, async () =>
      p.kind === "story"
        ? publishStory(await storyAdaptada(p))
        : comoReel
        ? publishReel(videoReel, caption, { collaborator: opts.collaborator, trial })
        : p.kind === "carousel"
        ? publishCarousel(mediaUrlsOf(p), caption, opts)
        : p.kind === "reel" || p.kind === "video"
          ? publishReel(await verticalDeVideo(p, p.media_url), caption, { ...opts, trial })
          : publishImage(p.media_url, caption, opts),
    );
    // COMENTARIO-FIJADO-1 · primer comentario en Instagram (por la API de Meta: se publica; fijarlo hay que hacerlo
    // a mano desde la app, la API no ofrece «fijar»). Un fallo aquí no tumba la publicación.
    const ci = p.kind !== "story" ? p.tags?.firstComments?.instagram : "";
    if (ci && ci.trim()) {
      try { await runWithAccount(acct, async () => commentOnMedia(id, ci.trim())); }
      catch (e) { return { platform: "instagram", ok: true, message: (id + " · publicada, pero el primer comentario no salió: " + (e as Error).message).slice(0, 200) }; }
    }
    return { platform: "instagram", ok: true, message: id };
  } catch (e) {
    return { platform: "instagram", ok: false, message: (e as Error).message.slice(0, 200) };
  }
}

// SHORT-IMAGENES-1 · monta el vídeo con las imágenes del post, lo guarda con los demás
// archivos del Programador y devuelve su dirección pública (la que descarga YouTube).
// REEL-PRUEBA-1 · Instagram (como Reel) y YouTube (Short) comparten el mismo vídeo: se monta una
// sola vez por publicación. publishOne/publishNow lo sueltan al terminar.
const shortsEnCurso = new Map<string, Promise<string>>();
function shortDeImagenes(p: ScheduledPost, horizontal = false): Promise<string> {
  // YOUTUBE-NORMAL-1 · el vídeo normal 16:9 lleva su propia clave: el Short y él conviven.
  const k = horizontal ? p.id + ":h" : p.id;
  let pr = shortsEnCurso.get(k);
  if (!pr) {
    pr = montarShort(p, horizontal);
    shortsEnCurso.set(k, pr);
    pr.catch(() => shortsEnCurso.delete(k));
  }
  return pr;
}

// ADAPTAR-VIDEO-1 · un Reel/vídeo sale en 1080×1920 con la máxima calidad en todas las redes: si ya es
// óptimo se publica el original sin recomprimir; si no, se adapta una sola vez (compartido por IG, FB, TikTok, YouTube…).
function verticalDeVideo(p: ScheduledPost, url: string): Promise<string> {
  const k = p.id + ":v";
  let pr = shortsEnCurso.get(k);
  if (!pr) {
    pr = (async () => {
      try {
        const r = await videoAVertical(url);
        if (!r) return url;
        const a = await saveAsset(
          { draft_id: "__sched__", name: "vertical-" + p.id + ".mp4", content_type: "video/mp4", data: r.data },
          { allowedTypes: new Set(["video/mp4"]), maxBytes: 500 * 1024 * 1024 },
        );
        console.log(`[scheduler] ${p.id} vídeo adaptado a 1080×1920 (${r.plan})`);
        return (urlPublicaDeConfianza() || urlPublica()) + "/a/" + a.id;
      } catch (e) {
        console.warn(`[scheduler] ${p.id} no se pudo adaptar el vídeo, sale el original:`, (e as Error).message);
        return url;
      }
    })();
    shortsEnCurso.set(k, pr);
  }
  return pr;
}

// Una historia en vídeo también va a 1080×1920; las fotos no se tocan.
async function storyAdaptada(p: ScheduledPost): Promise<string> {
  const u = mediaUrlsOf(p)[0] || p.media_url;
  return (await esVideoMedio(u)) ? verticalDeVideo(p, u) : u;
}

function soltarVideos(id: string): void { shortsEnCurso.delete(id); shortsEnCurso.delete(id + ":h"); shortsEnCurso.delete(id + ":v"); }

async function montarShort(p: ScheduledPost, horizontal = false): Promise<string> {
  // SHORT-DURACION-MUSICA-1 · la duración y la música que se eligieron al programar.
  const mp4 = await imagenesAShort(mediaUrlsOf(p), { segundos: p.tags?.shortSecs, musica: p.tags?.shortMusic, formato: horizontal ? "horizontal" : "vertical" });
  const a = await saveAsset(
    { draft_id: "__sched__", name: (horizontal ? "normal-" : "short-") + p.id + ".mp4", content_type: "video/mp4", data: mp4 },
    { allowedTypes: new Set(["video/mp4"]), maxBytes: 100 * 1024 * 1024 },
  );
  return (urlPublicaDeConfianza() || urlPublica()) + "/a/" + a.id;
}

// YOUTUBE-NORMAL-1 · un Reel o vídeo vertical → vídeo normal 16:9 (fondo desenfocado, sin recortar).
function normalDeVideo(p: ScheduledPost): Promise<string> {
  const k = p.id + ":h";
  let pr = shortsEnCurso.get(k);
  if (!pr) {
    pr = (async () => {
      const mp4 = await videoAHorizontal(mediaUrlsOf(p)[0] || p.media_url);
      const a = await saveAsset(
        { draft_id: "__sched__", name: "normal-" + p.id + ".mp4", content_type: "video/mp4", data: mp4 },
        { allowedTypes: new Set(["video/mp4"]), maxBytes: 500 * 1024 * 1024 },
      );
      return (urlPublicaDeConfianza() || urlPublica()) + "/a/" + a.id;
    })();
    shortsEnCurso.set(k, pr);
    pr.catch(() => shortsEnCurso.delete(k));
  }
  return pr;
}

/** Añade «#Shorts» al final de la primera línea (el título en YouTube) si cabe en 100 caracteres; si no, al final. */
function conHashtagShorts(t: string): string {
  if (/#shorts\b/i.test(t)) return t;
  const i = t.indexOf("\n");
  const l1 = i < 0 ? t : t.slice(0, i);
  if (l1.length + 8 <= 100) return l1 + " #Shorts" + (i < 0 ? "" : t.slice(i));
  return t.replace(/\s+$/, "") + "\n\n#Shorts";
}

async function publishMultiSocial(p: ScheduledPost, platforms: string[]): Promise<PlatformResult[]> {
  // Las redes no-IG se publican por su grupo de "Redes sociales" (cada grupo = su
  // credencial). El medio es una URL pública que el proveedor descarga directamente.
  const caption = captionWithTags(p);
  const out: PlatformResult[] = [];
  const byBlock = new Map<number, string[]>();
  for (const pl of platforms) {
    // HISTORIAS-1 · fuera de Instagram, solo Facebook publica historias por API.
    if (p.kind === "story" && pl !== "facebook") { out.push({ platform: pl, ok: false, message: "Esta red no admite historias por API: solo Instagram y Facebook" }); continue; }
    // X va por Upload-Post (no tiene grupo de Zernio): texto propio de X + medios por URL.
    // Va ANTES de platformBlock: X no está en ningún bloque y daba «Red no disponible».
    if (pl === "x") {
      const esVideo = p.kind === "reel" || p.kind === "video";
      const rx = await publishX({ caption: captionWithTags(p, "x"), mediaUrls: mediaUrlsOf(p), mediaType: esVideo ? "video" : "image", hilo: p.tags?.xHilo });
      out.push(rx.result);
      continue;
    }
    const blk = platformBlock(pl);
    if (blk < 0) { out.push({ platform: pl, ok: false, message: "Red no disponible para publicar" }); continue; }
    const arr = byBlock.get(blk) || [];
    arr.push(pl);
    byBlock.set(blk, arr);
  }
  // SHORT-IMAGENES-1 · YouTube solo acepta vídeo: una Foto o un Carrusel se convierte en un
  // Short con las imágenes como diapositivas. YouTube va en un envío aparte con ese vídeo;
  // las demás redes de su grupo siguen recibiendo las imágenes originales.
  // YOUTUBE-NORMAL-1 · formato elegido: «short» (por defecto), «normal» (16:9) o «ambos». El vídeo
  // normal sale de las imágenes (montado en horizontal) o de un Reel/vídeo (fondo desenfocado).
  const comoShort = p.kind !== "story" && p.kind !== "reel" && p.kind !== "video";
  const esVideoP = p.kind === "reel" || p.kind === "video";
  // YT-SHORT-SIEMPRE-1 · el Short sale SIEMPRE; el vídeo normal 16:9 es una réplica que se añade. «normal»
  // (valor antiguo, que sustituía al Short y dejó un vídeo 16:9 sin Short el 14 oct) se trata como «ambos».
  // YT-FORMATO-REAL-1 · un Reel/vídeo que YouTube no trataría como Short (más de 3 min u horizontal)
  // sale tal cual, como vídeo normal: sin «#Shorts» y sin la réplica 16:9 (sería el mismo vídeo dos veces).
  // Si no se puede medir, se mantiene lo de siempre (se trata como Short).
  let ytEsShort = true;
  if (esVideoP && platforms.indexOf("youtube") >= 0) {
    const m = await sondearVideo(mediaUrlsOf(p)[0] || p.media_url);
    if (m) ytEsShort = esShortDeYoutube(m);
    else console.warn("[scheduler] YT-FORMATO-REAL-1 no se pudo medir el vídeo de", p.id, "· se trata como Short");
  }
  const fmtYt: "short" | "ambos" = p.kind === "story" || !ytEsShort ? "short" : p.tags?.ytFormato ? "ambos" : "short";
  const envios: { blk: number; plats: string[]; short?: boolean; normal?: boolean }[] = [];
  for (const [blk, plats] of byBlock) {
    const yt = plats.indexOf("youtube") >= 0 && p.kind !== "story" && (comoShort || (esVideoP && fmtYt !== "short"));
    const resto = yt ? plats.filter((x) => x !== "youtube") : plats;
    if (resto.length) envios.push({ blk, plats: resto });
    if (yt) {
      // Un Reel/vídeo con formato «ambos» ya sale como Short en el envío general (el original).
      if (comoShort) envios.push({ blk, plats: ["youtube"], short: true });
      if (esVideoP && fmtYt === "ambos") envios.push({ blk, plats: ["youtube"] });
      if (fmtYt === "ambos") envios.push({ blk, plats: ["youtube"], normal: true });
    }
  }
  // ADAPTAR-VIDEO-1 · Facebook y TikTok reciben el vídeo en 1080×1920; YouTube y LinkedIn conservan su
  // original (un 16:9 es nativo allí y no se pasa a vertical): si comparten envío, se separan.
  const NATIVAS = ["youtube", "linkedin", "linkedin_pagina"];
  for (let i = envios.length - 1; i >= 0; i--) {
    const e = envios[i];
    if (e.short || e.normal) continue;
    const nat = e.plats.filter((x) => NATIVAS.indexOf(x) >= 0), vert = e.plats.filter((x) => NATIVAS.indexOf(x) < 0);
    if (nat.length && vert.length) envios.splice(i, 1, { blk: e.blk, plats: vert }, { blk: e.blk, plats: nat });
  }
  for (const { blk, plats, short, normal } of envios) {
    const key = get(ZERNIO_BLOCK_SETTING[blk]) || "";
    const profileId = get(blk === 0 ? "autopost.zernioProfileId" : `autopost.zernioProfileId${blk + 1}`) || undefined;
    if (!key) { for (const pl of plats) out.push({ platform: pl, ok: false, message: "Red sin configurar: conéctala en Conexiones → Redes sociales" }); continue; }
    try {
      // T04 · el tipo real del medio viaja a Zernio (antes siempre 'image': un
      // Reel hacia TikTok/YouTube iba etiquetado como imagen y YouTube, que solo
      // acepta vídeo, no podía publicarse). Carrusel = todas sus URLs.
      // HISTORIAS-1 · una historia puede ser foto o vídeo: se mira el medio (las subidas no
      // llevan extensión). PORTADA-1 · la portada viaja a cada red en su campo.
      const mediaType = short || normal || p.kind === "reel" || p.kind === "video" ? "video" as const
        : p.kind === "story" ? ((await esVideoMedio(mediaUrlsOf(p)[0] || p.media_url)) ? "video" as const : "image" as const)
        : "image" as const;
      // TEXTO-POR-RED-1 · el texto de cada red (con sus menciones y hashtags) viaja aparte.
      const captions: Record<string, string> = {};
      // La Página de LinkedIn es la red «linkedin» de Zernio: su texto viaja con esa clave.
      if (p.kind !== "story") for (const pl of plats) captions[pl === "linkedin_pagina" ? "linkedin" : pl] = captionWithTags(p, pl);
      // YT-SHORTS-TAG-1 · YouTube solo clasifica como Short un vídeo vertical cuando el título o la
      // descripción lleva «#Shorts» (todos los Shorts del canal lo llevan; el del 14 oct, sin él,
      // salió como vídeo normal aunque medía 1080×1920 y 55 s). Se añade en los envíos verticales.
      if (!normal && plats.indexOf("youtube") >= 0 && (short || (esVideoP && ytEsShort)) && p.kind !== "story") captions.youtube = conHashtagShorts(captionWithTags(p, "youtube"));
      const original = short || normal ? [] : mediaUrlsOf(p);
      const adaptados = mediaType === "video" && original.length === 1 && plats.every((x) => NATIVAS.indexOf(x) < 0) && (p.kind === "reel" || p.kind === "video" || p.kind === "story")
        ? [await verticalDeVideo(p, original[0])] : original;
      const r = await zernioPublish({
        key, profileId, platforms: plats, caption: p.kind === "story" ? "" : caption,
        mediaUrls: short ? [await shortDeImagenes(p)] : normal ? [comoShort ? await shortDeImagenes(p, true) : await normalDeVideo(p)] : adaptados, mediaType, captions,
        contentType: p.kind === "story" ? "story" : undefined,
        coverUrl: short || normal ? undefined : p.tags?.cover || undefined,
        coverOffsetMs: short || normal ? undefined : p.tags?.coverOffsetMs || undefined,
        ytFirstComment: plats.indexOf("youtube") >= 0 ? p.tags?.ytFirstComment || undefined : undefined,
        // COMENTARIO-FIJADO-1 · uno por red; en LinkedIn, el de la Página si va a la Página y si no el del perfil.
        firstComments: (() => {
          const fc = p.tags?.firstComments || {};
          const o: Record<string, string> = {};
          if (plats.indexOf("youtube") >= 0) { const t = fc.youtube || p.tags?.ytFirstComment; if (t) o.youtube = t; }
          if (plats.indexOf("facebook") >= 0 && fc.facebook) o.facebook = fc.facebook;
          const li = plats.indexOf("linkedin_pagina") >= 0 ? fc.linkedin_pagina || fc.linkedin : plats.indexOf("linkedin") >= 0 ? fc.linkedin || fc.linkedin_pagina : "";
          if (li) o.linkedin = li;
          return o;
        })(),
      });
      if (r.perPlatform.length) {
        // Zernio la devuelve como «linkedin»: aquí se vuelve a llamar «linkedin_pagina».
        const esPag = plats.indexOf("linkedin_pagina") >= 0 && plats.indexOf("linkedin") < 0;
        out.push(...r.perPlatform.map((x) => (esPag && x.platform === "linkedin" ? { ...x, platform: "linkedin_pagina" } : x)));
      } else {
        // PUB-ERR-2026-06-04: antes el fallback era "Error sin detalle" lo cual
        // no ayudaba al user a diagnosticar. Cuando zernioPublish devuelve
        // perPlatform vacio significa que no hubo accounts matched -> propagamos
        // los warnings (que contienen el motivo real: "Ninguna red conectada en
        // Zernio coincide con las plataformas elegidas..." o un detalle HTTP).
        // Si no hay warnings tampoco, usamos r.raw (snippet de la respuesta).
        const msgParts: string[] = [];
        if (Array.isArray(r.warnings) && r.warnings.length) msgParts.push(r.warnings.join(" · "));
        if (r.status > 0) msgParts.push(`HTTP ${r.status}`);
        if (!msgParts.length && r.raw) msgParts.push(String(r.raw).slice(0, 160));
        const detail = msgParts.length ? msgParts.join(" · ") : `Zernio no devolvio resultado por plataforma. ${plats.join(",")} probablemente no esta conectada en Zernio (Integraciones -> Zernio -> Conectar Redes).`;
        for (const pl of plats) out.push({ platform: pl, ok: r.ok, message: r.ok ? "ok" : detail });
      }
    } catch (e) {
      for (const pl of plats) out.push({ platform: pl, ok: false, message: (e as Error).message.slice(0, 200) });
    }
  }
  return out;
}

// NOTIFICACIONES-1 · publicacion: una programada que no salió (o salió a medias).
function avisarPublicacion(p: ScheduledPost, status: string, detalle: string, fallidas: string[] = []): void {
  if (status !== "error" && status !== "partial") return;
  const pie = String(p.caption || "").replace(/\s+/g, " ").trim().slice(0, 60);
  notificar({ kind: "publicacion", title: status === "partial" ? "Publicación a medias" : "Publicación no publicada", body: (pie ? "«" + pie + "» · " : "") + detalle.slice(0, 180), link: "sched", channel: fallidas[0] || (p.platforms && p.platforms[0]) || null, dedup: "publicacion:" + p.id + ":" + status, payload: { postId: p.id } });
}

// REEL-PRUEBA-2 · Meta limita los reels de prueba que admite la API por cuenta en 24 h (subcode 2207078).
// El tope exacto NO está documentado (se comenta ~20/día, y hay cuentas con menos). REEL-PRUEBA-3: el
// contador interno (los reels de prueba ya publicados en 24 h, por cuenta) arranca en TRIAL_MAX_DIA_DEF y,
// la primera vez que Meta rechaza con 2207078, APRENDE el tope real de esa cuenta (los que hay publicados
// menos un margen), lo guarda y deja de empujar: espera a que caduque un hueco en vez de reintentar a ciegas.
// Un ajuste explícito del negocio manda siempre: ig.trialMaxDia (0 = sin control) e ig.trialSeparacionMin.
// Se aplaza la hora, no se pierde el post.
const TRIAL_MAX_DIA_DEF = 20;
const TRIAL_SEPARACION_MIN_DEF = 30;
const TRIAL_MAX_APLAZOS = 12;
const TRIAL_REINTENTO_MIN = 180; // suelo de espera tras un 2207078 real de Meta (nunca antes de 3 h si no hay hueco calculado)
const TRIAL_MARGEN = 1; // tope aprendido = publicados cuando Meta dijo basta − margen
const TRIAL_EVIDENCIA_MIN = 3; // con menos publicados que esto el rechazo no dice nada del tope (reels hechos fuera del panel): no se aprende
const TRIAL_TOPE_TTL_MS = 48 * 3600_000; // el tope aprendido caduca: Meta puede cambiarlo o venir de reels hechos fuera del panel

function esLimiteReelPrueba(msg: string): boolean { return /2207078|Trial Reel Publish Limit/i.test(msg || ""); }

const claveTopeAprendido = (igId: string): string => "ig.trialTopeAprendido." + (igId || "default");

/** Tope aprendido de esta cuenta (0 = no hay o caducó). Se guarda como "<tope>|<epoch ms>". */
function topeAprendido(igId: string, ahora: number): number {
  const [c, at] = String(get(claveTopeAprendido(igId)) || "").split("|").map(Number);
  return Number.isFinite(c) && c > 0 && Number.isFinite(at) && ahora - at < TRIAL_TOPE_TTL_MS ? Math.floor(c) : 0;
}

/**
 * REEL-PRUEBA-3 · Meta acaba de rechazar un reel de prueba (2207078): el tope real de esta cuenta es lo que ya
 * ha publicado en 24 h. Se guarda (menos TRIAL_MARGEN) para no volver a golpear a Meta. Con ig.trialMaxDia
 * explícito no se aprende: manda el ajuste. Devuelve el tope aprendido (0 = no se aprendió).
 */
async function aprenderTopeReelPrueba(p: ScheduledPost, ahora: number): Promise<number> {
  if (String(get("ig.trialMaxDia")).trim() !== "") return 0;
  const t = await dbReelsPruebaRecientes(p.tenant_id || "default", p.ig_id || "", ahora - 24 * 3600_000);
  if (t.length < TRIAL_EVIDENCIA_MIN) return 0;
  const cap = Math.max(1, t.length - TRIAL_MARGEN);
  await set(claveTopeAprendido(p.ig_id || ""), cap + "|" + ahora);
  console.log(`[scheduler] tope de reels de prueba aprendido para ${p.ig_id || "default"}: ${cap}/24 h (publicados ${t.length})`);
  notificar({ kind: "publicacion", title: "Instagram limita los reels de prueba", body: "Tope aprendido de esta cuenta: " + cap + " cada 24 h. Los que faltan salen solos cuando haya hueco; no hay que reprogramar nada.", link: "sched", channel: "instagram", dedup: "trialtope:" + (p.ig_id || "default") + ":" + cap, payload: { postId: p.id } });
  return cap;
}

/** Epoch ms a partir del cual este reel de prueba puede salir; 0 = ya puede salir. */
async function esperaReelPrueba(p: ScheduledPost, ahora: number): Promise<number> {
  if (!p.tags?.igTrial) return 0;
  const plats = (p.platforms && p.platforms.length ? p.platforms : ["instagram"]).map((s) => s.toLowerCase());
  if (plats.indexOf("instagram") < 0 || p.kind === "story") return 0;
  const num = (k: string, def: number): number => { const n = Number(get(k)); return Number.isFinite(n) && n >= 0 && String(get(k)).trim() !== "" ? n : def; };
  const explicito = String(get("ig.trialMaxDia")).trim() !== "";
  const max = explicito ? Math.floor(num("ig.trialMaxDia", TRIAL_MAX_DIA_DEF)) : (topeAprendido(p.ig_id || "", ahora) || TRIAL_MAX_DIA_DEF);
  if (max <= 0) return 0;
  const sepMs = num("ig.trialSeparacionMin", TRIAL_SEPARACION_MIN_DEF) * 60_000;
  const DIA = 24 * 3600_000;
  const t = await dbReelsPruebaRecientes(p.tenant_id || "default", p.ig_id || "", ahora - DIA);
  let hasta = 0;
  if (t.length >= max) hasta = t[t.length - max] + DIA + 60_000; // cuando caduca el que ocupa el hueco
  if (sepMs > 0 && t.length) hasta = Math.max(hasta, t[t.length - 1] + sepMs);
  return hasta > ahora ? hasta : 0;
}

/** Aplaza el post (sigue 'pending', otra hora). Devuelve true si lo ha aplazado. */
async function aplazarReelPrueba(p: ScheduledPost, hasta: number, motivo: string): Promise<boolean> {
  const aplazos = (p.tags?.igTrialAplazos || 0) + 1;
  if (aplazos > TRIAL_MAX_APLAZOS) return false; // no aplazar eternamente: que salga el error visible
  const ok = await dbAplazarPost(p.id, p.tenant_id || "default", hasta, motivo, aplazos);
  if (ok) console.log(`[scheduler] ${p.id} aplazado a ${new Date(hasta).toISOString()} · ${motivo}`);
  return ok;
}

async function publishOne(p: ScheduledPost): Promise<void> {
  const platforms = (p.platforms && p.platforms.length ? p.platforms : ["instagram"]).map((s) => s.toLowerCase());
  // REEL-PRUEBA-2 · antes de gastar nada: ¿toca esperar por el tope de reels de prueba?
  try {
    const hasta = await esperaReelPrueba(p, Date.now());
    if (hasta && await aplazarReelPrueba(p, hasta, "Aplazado: Instagram limita los reels de prueba por día; sale el " + new Date(hasta).toISOString())) return;
  } catch (e) { console.warn("[scheduler] control reel de prueba:", (e as Error).message); }
  const results: PlatformResult[] = [];
  // MINIATURA-CONGELADA-1 · foto de la pieza AHORA, antes de publicar: es cuando su archivo seguro existe.
  // Se guarda en tags.thumb y el calendario la usa aunque el original se borre o caduque (las historias
  // se quedaban en gris). Best-effort: sin miniatura se publica igual.
  if (!p.tags?.thumb) {
    try {
      const th = await miniaturaDePost(mediaUrlsOf(p)[0] || p.media_url);
      if (th) { await dbCongelarMiniatura(p.id, p.tenant_id || "default", th); p.tags = { ...(p.tags || {}), thumb: th }; }
    } catch (e) { console.warn("[scheduler] miniatura congelada de", p.id, (e as Error).message); }
  }
  try {
    // 1) Instagram via Graph API (preserva soporte Reel nativo).
    if (platforms.indexOf("instagram") >= 0) results.push(await publishInstagram(p));
    // 2) El resto vía Upload-Post.
    const others = platforms.filter((x) => x !== "instagram");
    if (others.length) {
      const r = await publishMultiSocial(p, others);
      results.push(...r);
    }
  } finally { soltarVideos(p.id); }
  // REEL-PRUEBA-2 · Meta dijo «límite de reels de prueba»: si el post era SOLO Instagram, se reintenta
  // más tarde en vez de darlo por perdido (con varias redes, un reintento duplicaría las demás).
  const igLimite = results.find((r) => r.platform === "instagram" && !r.ok && esLimiteReelPrueba(r.message));
  if (igLimite && p.tags?.igTrial) {
    try { await aprenderTopeReelPrueba(p, Date.now()); } catch (e) { console.warn("[scheduler] aprender tope reel de prueba:", (e as Error).message); }
  }
  if (igLimite && results.length === 1 && p.tags?.igTrial) {
    // Espera al hueco que calcula el contador con el tope ya aprendido; nunca antes del suelo de reintento.
    let hasta = Date.now() + TRIAL_REINTENTO_MIN * 60_000;
    try { hasta = Math.max(hasta, await esperaReelPrueba(p, Date.now())); } catch { /* se queda el suelo */ }
    if (await aplazarReelPrueba(p, hasta, "Aplazado: Meta rechazó el reel de prueba por límite diario; se reintenta solo cuando haya hueco")) return;
  }
  if (igLimite) igLimite.message = "Instagram limita los reels de prueba por día. Reprograma para más tarde o publícalo directo (sin prueba).";
  const okCount = results.filter((r) => r.ok).length;
  const status: ScheduledPost["status"] = okCount === results.length ? "published" : okCount === 0 ? "error" : "partial";
  await dbFinishScheduledPost(p.id, p.tenant_id || "default", status, JSON.stringify(results).slice(0, 1500)); // PROG-EDIT-1
  console.log(`[scheduler] ${p.id} → ${status} · ${results.map((r) => r.platform + ":" + (r.ok ? "ok" : "err")).join(", ")}`);
  avisarPublicacion(p, status, status === "partial" ? "Ha salido en " + results.filter((r) => r.ok).map((r) => r.platform).join(", ") + " pero no en " + results.filter((r) => !r.ok).map((r) => r.platform).join(", ") + "." : "No ha salido en " + results.map((r) => r.platform).join(", ") + ". Revisa el motivo en el Programador.", results.filter((r) => !r.ok).map((r) => r.platform));
}

async function tick(): Promise<void> {
  // INT-1: el try/catch + logActivity VIVE DENTRO de runWithWorkspace para
  // que el tenant_id de la telemetría sea el del post que falla (no
  // 'default' fallback). Antes el catch corría fuera del ALS → todas las
  // entradas de error se grababan con tenant_id='default'.
  // T04 · barrido de 'sending' huérfanos (proceso muerto a mitad de publicar):
  // pasan a 'error' con motivo visible en vez de fingir pendiente para siempre.
  try {
    const swept = await dbSweepStuckSendingPosts();
    if (swept) console.warn(`[scheduler] ${swept} post(s) colgados en 'sending' cerrados como error`);
  } catch { /* barrido best-effort */ }
  let due: Awaited<ReturnType<typeof dbDueScheduledPosts>> = [];
  try {
    due = await dbDueScheduledPosts();
  } catch (e) {
    console.error("[scheduler] tick:dueQuery:", (e as Error).message);
    // El error es de la BD al pedir el lote → no hay tenant que asociar.
    // Mantenemos logActivity fuera de scope (cae a 'default' por diseño).
    await logActivity({
      source: "mcp-job",
      level: "error",
      status: "error",
      summary: `Scheduler dueQuery falló: ${(e as Error).message.slice(0, 160)}`,
      payload: { file: "scheduler.ts", fn: "tick.dueQuery", error: (e as Error).message.slice(0, 400) },
    });
  }
  for (const p of due) {
    const tenant = (p as any).tenant_id || "default";
    await runWithWorkspace(tenant, async () => {
      try {
        await publishOne(p);
      } catch (e) {
        console.error(`[scheduler] tick:${p.id}:`, (e as Error).message);
        // El claim atómico dejó el post en 'sending'; si publishOne lanzó antes de
        // fijar estado, lo cerramos como 'error' para que NO quede colgado en
        // 'sending' ni se reintente (evitar re-publicar algo publicado a medias).
        try { await dbFinishScheduledPost(p.id, tenant, "error", ("error: " + (e as Error).message).slice(0, 1500)); } catch { /* best-effort */ }
        avisarPublicacion(p, "error", "Falló al publicar: " + (e as Error).message);
        // tenant_id auto vía ALS (runWithWorkspace activo) — registra bajo el ws del post.
        await logActivity({
          source: "scheduled-post",
          level: "error",
          status: "error",
          summary: `Scheduler publishOne falló: ${(e as Error).message.slice(0, 160)}`,
          payload: {
            file: "scheduler.ts",
            fn: "tick.publishOne",
            post_id: p.id,
            error: (e as Error).message.slice(0, 400),
          },
        });
      }
    });
  }
  // Difusiones de WhatsApp programadas (mismo latido de 60 s).
  // El wrap por tenant lo hace runDueBroadcasts (broadcasts.ts) en su loop interno
  // (cada broadcast individual ya corre dentro de su runWithWorkspace allí).
  try {
    await runDueBroadcasts();
  } catch (e) {
    console.error("[scheduler] broadcasts:", (e as Error).message);
    // FASE-5: telemetría — runDueBroadcasts reventó ANTES de poder abrir
    // scope (BD caída leyendo el lote). Sin tenant disponible: cae a 'default'.
    await logActivity({
      source: "mcp-job",
      level: "error",
      status: "error",
      summary: `Scheduler runDueBroadcasts falló: ${(e as Error).message.slice(0, 160)}`,
      payload: {
        file: "scheduler.ts",
        fn: "tick.runDueBroadcasts",
        error: (e as Error).message.slice(0, 400),
      },
    });
  }
  // DIFUSION-MARCA-1 · difusiones que un proceso anterior dejó a mitad («Enviando» sin
  // latido tras un reinicio o redespliegue): se retoman donde estaban.
  try {
    await reanudarDifusionesHuerfanas();
  } catch (e) {
    console.error("[scheduler] reanudar difusiones:", (e as Error).message);
  }
  // NEWSLETTER-1 · boletines vencidos (mismo latido de 60 s).
  await newslettersTick();
  // NEWSLETTER-RUTINA-1 · rutinas de correo a las que les ha llegado la hora.
  await rutinasCorreoTick();
}

/**
 * NEWSLETTER-RUTINA-1 · Aquí el reloj SÍ es nuestro: el contenido no existe
 * hasta que la IA lo escribe a la hora de ejecutar, así que no hay nada que
 * programar en la web por adelantado. El claim empuja next_run_at 10 min
 * (una réplica por rutina, y reintento si el proceso muere a mitad);
 * ejecutaRutina la deja luego en su próxima ocurrencia real.
 *
 * Se relee la fila antes de ejecutar: el cliente pudo pausarla entre el
 * claim y ahora, y una pausa tiene que ser una pausa.
 */
async function rutinasCorreoTick(): Promise<void> {
  let vencidas: Awaited<ReturnType<typeof dbClaimDueNewsletterRoutines>> = [];
  try {
    vencidas = await dbClaimDueNewsletterRoutines();
  } catch (e) {
    console.error("[scheduler] rutinas de correo:claim:", (e as Error).message);
    return;
  }
  for (const r of vencidas) {
    await runWithWorkspace(r.tenant_id || "default", async () => {
      try {
        const fresca = await dbGetNewsletterRoutine(r.id);
        if (!fresca || !fresca.active) return;
        await ejecutaRutina({ ...fresca, next_run_at: r.next_run_at });
      } catch (e) {
        // ejecutaRutina no lanza; esto solo cubre un fallo de la base al releer.
        console.error(`[scheduler] rutina:${r.id}:`, (e as Error).message);
      }
    });
  }
}

/**
 * NEWSLETTER-1 · Vigilancia de los boletines programados.
 *
 * Quien envía de verdad es la web (systeme.io programa y dispara con su propia
 * infraestructura). Esto es la RED, no el lanzador: si a la hora prevista el
 * boletín no consta enviado allí, se reconcilia — se comprueba el estado remoto
 * y, solo si sigue sin salir, se manda desde aquí.
 *
 * El claim es atómico ('scheduled' → 'sending' con SKIP LOCKED), así que dos
 * procesos del mismo despliegue no pueden coger el mismo boletín. Y antes de
 * actuar se relee la fila: el cliente pudo cancelarla entre el claim y ahora.
 */
async function newslettersTick(): Promise<void> {
  try {
    const colgados = await dbSweepStuckNewsletters();
    if (colgados) console.warn(`[scheduler] ${colgados} boletín(es) colgados en 'sending' cerrados como error`);
  } catch { /* barrido best-effort */ }

  let vencidos: Awaited<ReturnType<typeof dbClaimDueNewsletters>> = [];
  try {
    vencidos = await dbClaimDueNewsletters();
  } catch (e) {
    console.error("[scheduler] newsletters:claim:", (e as Error).message);
    // Falló la BD al pedir el lote → no hay tenant al que atribuirlo ('default').
    await logActivity({
      source: "mcp-job",
      level: "error",
      status: "error",
      summary: `Scheduler boletines falló al pedir el lote: ${(e as Error).message.slice(0, 160)}`,
      payload: { file: "scheduler.ts", fn: "newslettersTick.claim", error: (e as Error).message.slice(0, 400) },
    });
    return;
  }

  for (const n of vencidos) {
    const tenant = n.tenant_id || "default";
    await runWithWorkspace(tenant, async () => {
      try {
        // Dentro del scope del workspace: las credenciales de la web y los
        // settings se leen por tenant, así que esto NO puede salir fuera.
        const fresco = await refrescaSiProcede(n);
        if (!fresco) return;
        await reconciliarNewsletter(fresco);
      } catch (e) {
        console.error(`[scheduler] newsletter:${n.id}:`, (e as Error).message);
        try {
          await dbUpsertNewsletter({
            ...n,
            status: "error",
            result: ("error: " + (e as Error).message).slice(0, 400),
          });
        } catch { /* best-effort */ }
        await logActivity({
          source: "newsletter",
          level: "error",
          status: "error",
          summary: `Scheduler boletín falló: ${(e as Error).message.slice(0, 160)}`,
          payload: {
            file: "scheduler.ts",
            fn: "newslettersTick",
            newsletter: n.id,
            error: (e as Error).message.slice(0, 400),
          },
        });
      }
    });
  }
}

/**
 * Publica AHORA mismo (sin programar): útil para el botón "Publicar ahora" del
 * panel y para demostrar el permiso instagram_content_publish end-to-end.
 * Reutiliza la misma lógica que el scheduler. Devuelve el resultado por
 * plataforma. No persiste en app_scheduled_posts (es una publicación ad-hoc).
 */
export async function publishNow(input: {
  ig_id?: string;
  kind?: ScheduledPost["kind"];
  media_url: string;
  caption?: string;
  platforms?: string[];
  tags?: ScheduledPost["tags"];
  uploadPostAccountId?: string;
}): Promise<{ ok: boolean; results: PlatformResult[] }> {
  const p: ScheduledPost = {
    id: "now-" + Date.now(),
    ig_id: input.ig_id || "",
    kind: input.kind || "image",
    media_url: input.media_url,
    caption: input.caption || "",
    scheduled_at: Date.now(),
    status: "pending",
    result: "",
    platforms: (input.platforms && input.platforms.length ? input.platforms : ["instagram"]).map((s) => s.toLowerCase()),
    tags: input.tags || { mentions: [], hashtags: [], igCollab: "", igUserTags: [] },
    uploadPostAccountId: input.uploadPostAccountId || "",
  };
  const results: PlatformResult[] = [];
  // REEL-PRUEBA-2 · publicar ya NO se salta el tope de reels de prueba: si toca esperar, se dice cuándo y se programa.
  try {
    const hasta = await esperaReelPrueba(p, Date.now());
    if (hasta) {
      return { ok: false, results: [{ platform: "instagram", ok: false, message: "Instagram limita los reels de prueba por día: este no puede salir hasta " + new Date(hasta).toISOString() + ". Prográmalo para esa hora (o más tarde) o publícalo directo, sin prueba." }] };
    }
  } catch (e) { console.warn("[scheduler] control reel de prueba (ahora):", (e as Error).message); }
  try {
    if (p.platforms.indexOf("instagram") >= 0) results.push(await publishInstagram(p));
    const others = p.platforms.filter((x) => x !== "instagram");
    if (others.length) results.push(...(await publishMultiSocial(p, others)));
  } finally { soltarVideos(p.id); }
  const lim = results.find((r) => r.platform === "instagram" && !r.ok && esLimiteReelPrueba(r.message));
  if (lim && p.tags?.igTrial) { try { await aprenderTopeReelPrueba(p, Date.now()); } catch { /* best-effort */ } }
  if (lim) lim.message = "Instagram limita los reels de prueba por día. Prográmalo para más tarde o publícalo directo (sin prueba).";
  return { ok: results.every((r) => r.ok), results };
}

let timer: ReturnType<typeof setInterval> | null = null;
let alertsTimer: ReturnType<typeof setInterval> | null = null;
let remindersTimer: ReturnType<typeof setInterval> | null = null;
let mediaTimer: ReturnType<typeof setInterval> | null = null;
let flujosPubTimer: ReturnType<typeof setInterval> | null = null;

/**
 * MEDIA-CADUCA-1 · política de retención de los medios del Programador (vídeos e imágenes subidos).
 * Pasados MEDIA_RETENTION_DAYS (30 por defecto; 0 = nunca) desde que se subieron Y desde que se publicó
 * la última publicación que los usa, se borran los bytes de la BD y queda la miniatura + los datos
 * (nombre, tipo, tamaño) para el historial. Un medio que una publicación pendiente o en borrador aún
 * necesita no caduca nunca. Tandas de 20 por pasada (1 ffmpeg por miniatura), hasta vaciar la cola.
 */
async function mediaCaducaTick(): Promise<void> {
  try {
    const dias = diasRetencionMedios();
    if (dias <= 0) return;
    let total = 0, bytes = 0;
    for (let i = 0; i < 25; i++) {
      const r = await caducarMediosAntiguos(dias, posterParaCaducar, 20);
      total += r.caducados; bytes += r.bytes;
      if (r.caducados < 20) break;
    }
    if (total) console.log(`[scheduler] MEDIA-CADUCA-1 · ${total} medios caducados (${Math.round(bytes / 1048576)} MB liberados, retención ${dias} d)`);
  } catch (e) {
    console.error("[scheduler] mediaCaducaTick:", (e as Error).message);
  }
}

/**
 * A5: ciclo del evaluador de alertas Meta Ads. Cada 15 min itera
 * workspaces activos y dispara alertas que cumplen su condición. Lo
 * envolvemos en try/catch porque NO debe propagar nunca al event loop
 * (ya hay try/catch interno + logActivity, pero el setInterval no debe
 * romper si algo escapa). 15 min es el mínimo que evita rate-limit
 * Marketing API combinado con el cache de 5 min de insights.
 */
async function alertsTick(): Promise<void> {
  try {
    await evaluateAllAlerts();
  } catch (e) {
    // evaluateAllAlerts ya loguea cada error en activity. Esto es solo
    // seatbelt anti-process-crash: log a stderr y seguimos.
    console.error("[scheduler] alertsTick:", (e as Error).message);
  }
}

// RECORDATORIO-FLOW-1 · textos por defecto de los avisos sembrados.
const TXT_AVISO_DIA = "Hola {{nombre}}, te recuerdo {{evento}}: {{cuando}} 🗓️";
const TXT_AVISO_HORA = "{{nombre}}, en nada empezamos: {{evento}} a las {{hora}} ⏰";

/**
 * RECORDATORIO-FLOW-1 · Primera vez SIN flujos de aviso en el workspace: convierte
 * las reglas antiguas (reminders.rules) en flujos equivalentes — un flujo por
 * regla×escalón, con su on/off heredado del modo de la regla — o, si no había
 * reglas, siembra dos avisos por defecto (día antes + hora antes) listos para
 * editar en Flujos. Ids estables → el saveFlow (upsert) es idempotente; el claim
 * garantiza que borrar los flujos después NO los resucita.
 * (Exportada para poder probar la migración sin esperar al tick.)
 */
export async function siembraAvisos(): Promise<Flow[]> {
  // El claim se LEE sin consumir (se consume al final, con los flujos ya
  // guardados): si el proceso muere a medias, el siguiente tick reintenta —
  // los ids son estables y el upsert es idempotente. Con el claim ya puesto no
  // se resiembra: borrar los flujos a mano es una decisión, no un accidente.
  try { if ((await dbClaimsExisting("recordatorio-setup", ["v1"])).length) return []; } catch { return []; }
  const ws = currentWorkspaceId();
  const rMode = (get("reminders.mode") || "").trim();
  // Semántica legacy de '' («como el bot»): fotografiamos el estado actual de
  // los interruptores de canal — un negocio con el bot apagado NO empieza a
  // mandar avisos por el deploy; los flujos nacen pausados y él decide.
  const porDefectoOn = rMode === "on" ? true : rMode === "off" ? false :
    (autoReplyOn("whatsapp") || autoReplyOn("instagram") || autoReplyOn("facebook"));
  const tplLegacy = (get("appointment.template") || "").trim();
  const langLegacy = get("appointment.lang") || "es";
  interface ReglaVieja { ambito: string; modo: string; escalones: { min: number; texto: string }[] }
  let reglas: ReglaVieja[] = [];
  try {
    const raw = JSON.parse(get("reminders.rules") || "[]") as unknown;
    if (Array.isArray(raw)) {
      reglas = raw.map((r) => {
        const rr = (r || {}) as Record<string, unknown>;
        const modo = String(rr.modo || "");
        return {
          ambito: String(rr.ambito || "todos").slice(0, 220),
          modo: modo === "on" || modo === "off" ? modo : "",
          escalones: (Array.isArray(rr.escalones) ? rr.escalones : []).map((e) => {
            const ee = (e || {}) as Record<string, unknown>;
            return { min: Math.min(20160, Math.max(5, Number(ee.min) || 0)), texto: String(ee.texto || "").slice(0, 400) };
          }).filter((e) => e.min >= 5).slice(0, 4),
        };
      }).filter((r) => r.escalones.length).slice(0, 10);
    }
  } catch { /* reglas corruptas → por defecto */ }
  // Solo la PRIMERA regla de cada ámbito contaba en el motor viejo (la más
  // específica ganaba y los empates iban por orden): las repetidas eran
  // inertes y migrarlas las resucitaría.
  const vistos = new Set<string>();
  reglas = reglas.filter((r) => { const k = r.ambito.trim().toLowerCase(); if (vistos.has(k)) return false; vistos.add(k); return true; });
  const nombreDe = (a: string): string =>
    a.indexOf("evento:") === 0 ? a.slice(7).trim() : a === "manual" ? "reuniones del panel" : a === "webs" ? "reservas de tus webs" : "todas las reuniones";
  const antesTxt = (min: number): string =>
    min % 1440 === 0 ? min / 1440 + (min === 1440 ? " día" : " días") : min % 60 === 0 ? min / 60 + " h" : min + " min";
  // OJO: app_flows tiene PK (id) SIN tenant — los ids llevan el workspace o el
  // seed de un negocio le robaría la fila al anterior (ON CONFLICT (id)).
  const mkId = (suf: string): string => "aviso-" + ws + "-" + suf;
  const flujos: Flow[] = [];
  if (reglas.length) {
    reglas.forEach((r, i) => r.escalones.forEach((e, j) => {
      flujos.push({
        id: mkId("mig-" + (i + 1) + "-" + (j + 1)),
        name: "Aviso · " + nombreDe(r.ambito) + " · " + antesTxt(e.min) + " antes",
        enabled: r.modo === "off" ? false : r.modo === "on" ? true : porDefectoOn,
        trigger: { type: "recordatorio", ambito: r.ambito, antesMin: e.min, tpl: tplLegacy, tplLang: tplLegacy ? langLegacy : "" },
        start: "m1",
        nodes: { m1: { type: "message", text: e.texto || TXT_AVISO_HORA } },
      });
    }));
  } else {
    flujos.push(
      { id: mkId("dia"), name: "Aviso · todas las reuniones · 1 día antes", enabled: porDefectoOn, trigger: { type: "recordatorio", ambito: "todos", antesMin: 1440, tpl: tplLegacy, tplLang: tplLegacy ? langLegacy : "" }, start: "m1", nodes: { m1: { type: "message", text: TXT_AVISO_DIA } } },
      { id: mkId("hora"), name: "Aviso · todas las reuniones · 1 h antes", enabled: porDefectoOn, trigger: { type: "recordatorio", ambito: "todos", antesMin: 60, tpl: tplLegacy, tplLang: tplLegacy ? langLegacy : "" }, start: "m1", nodes: { m1: { type: "message", text: TXT_AVISO_HORA } } },
    );
  }
  let guardados = 0;
  for (const f of flujos) {
    try { await saveFlow(f); guardados++; } catch (e) { console.error("[scheduler] siembra aviso:", (e as Error).message); }
  }
  if (!guardados) return []; // nada persistió → sin claim, se reintenta al tick siguiente
  await dbClaimOnce("recordatorio-setup", "v1").catch(() => {});
  try {
    await logActivity({ source: "app", level: "info", summary: "Avisos de reunión creados como flujos (" + guardados + (reglas.length ? ", migrados de las reglas antiguas)" : ", plantillas por defecto)"), payload: { flujos: flujos.map((f) => f.id), activos: porDefectoOn } });
  } catch { /* telemetría, sin drama */ }
  return flujos;
}

/**
 * Recordatorio de REUNIONES: cada ~30 min revisa las reuniones que se acercan
 * (manuales del panel y reservas de las webs) y dispara los FLUJOS con
 * disparador «recordatorio» que les tocan — el aviso ES un flujo: su on/off es
 * el interruptor del flujo, su texto son los pasos del flujo, y se edita en
 * Flujos. Solo dentro de la ventana de 24 h de Meta; en WhatsApp, fuera de
 * ventana sale la plantilla aprobada del flujo (o la del negocio) en su lugar.
 * En WhatsApp envía desde el número por el que entró el contacto; en IG/FB,
 * desde su cuenta/Página.
 */
async function remindersTick(): Promise<void> {
  try {
    let workspaces: { id: string }[] = [];
    try { workspaces = await listWorkspacesCached(); }
    catch { workspaces = [{ id: "default" }]; }
    const now = Date.now();
    for (const ws of workspaces) {
      if (!ws.id || ws.id === "_global_") continue;
      await runWithWorkspace(ws.id, async () => {
        // INTERRUPTOR: el on/off de cada AVISO es el de su flujo (se apaga y
        // enciende en Flujos, como cualquier otro). El interruptor del canal solo
        // gobierna ya las felicitaciones de cumpleaños, que siguen siendo del bot.
        const waOn = autoReplyOn("whatsapp");
        // Plantilla de cita (solo WhatsApp): con la ventana de 24 h cerrada un texto
        // normal no puede salir, una plantilla aprobada por Meta sí (de pago, la
        // cobra Meta). Convención de variables: {{1}} el motivo, {{2}} cuándo.
        // La plantilla vive EN cada flujo de aviso (trigger.tpl; la legacy del
        // negocio se copia al migrar). IG/Messenger no tienen plantillas.
        const apptLang = get("appointment.lang") || "es";
        // Zona horaria del negocio (biz.timezone): las horas de los mensajes se
        // dicen en la del negocio, no en la del proceso (UTC en Railway = hora
        // equivocada en el mensaje). Inválida o vacía → la del proceso, como antes.
        let tz = (get("biz.timezone") || "").trim();
        if (tz) { try { new Date().toLocaleString("es-ES", { timeZone: tz }); } catch { tz = ""; } }
        const horaDe = (t: number): string =>
          new Date(t).toLocaleString("es-ES", tz ? { hour: "2-digit", minute: "2-digit", timeZone: tz } : { hour: "2-digit", minute: "2-digit" });
        const diaDe = (t: number): string => new Date(t).toLocaleDateString("es-ES", tz ? { timeZone: tz } : {});
        // ── AVISOS COMO FLUJOS (RECORDATORIO-FLOW-1) · cada aviso es un flujo con
        // disparador «recordatorio» ({ambito, antesMin}): se crea, edita, apaga y
        // borra en Flujos, como todo lo demás. La primera vez sin ninguno se
        // migran las reglas antiguas o se siembran las plantillas por defecto.
        let avisos: Flow[] = [];
        try { avisos = (await listFlows()).filter((f) => f.trigger?.type === "recordatorio"); }
        catch { /* sin flujos legibles → solo cumpleaños */ }
        if (!avisos.length) { try { avisos = await siembraAvisos(); } catch (e) { console.warn("[scheduler] siembra avisos:", (e as Error).message); } }
        const validos = avisos.filter((f) => f.start && f.nodes && f.nodes[f.start]);
        const activos = validos.filter((f) => f.enabled);
        if (!activos.length && !waOn) return; // ni avisos vivos ni cumpleaños posibles
        const ambDe = (f: Flow): string => String(f.trigger.ambito || "todos");
        const minDe = (f: Flow): number => Math.min(20160, Math.max(5, Number(f.trigger.antesMin) || 1440));
        const pesoDe = (a: string): number => (a.indexOf("evento:") === 0 ? 0 : a === "manual" || a === "webs" ? 1 : 2);
        // Los flujos que avisan a ESTE item: el ámbito más específico gana EN BLOQUE
        // (evento > manual/webs > todos) — un evento con flujos propios no recibe
        // además los generales (jamás mensajes duplicados), pero sí todas sus
        // antelaciones (día antes + hora antes = dos flujos del mismo ámbito).
        // La especificidad se resuelve sobre TODOS los flujos (apagados incluidos)
        // y el on/off filtra DESPUÉS: apagar el flujo de un evento lo SILENCIA —
        // no hace que hereden los generales que el dueño no quería para él.
        const flujosPara = (tipo: "manual" | "web", evento: string): Flow[] => {
          const casa = (a: string): boolean => {
            if (a.indexOf("evento:") === 0) return tipo === "web" && a.slice(7).trim().toLowerCase() === String(evento || "").trim().toLowerCase();
            if (a === "manual") return tipo === "manual";
            if (a === "webs") return tipo === "web";
            return true; // 'todos'
          };
          const m = validos.filter((f) => casa(ambDe(f)));
          if (!m.length) return m;
          const mejor = Math.min(...m.map((f) => pesoDe(ambDe(f))));
          return m.filter((f) => f.enabled && pesoDe(ambDe(f)) === mejor);
        };
        const maxMin = Math.max(60, ...activos.map(minDe));
        const fechaDe = (t: number): string =>
          new Date(t).toLocaleDateString("es-ES", tz ? { day: "numeric", month: "long", timeZone: tz } : { day: "numeric", month: "long" });
        // El aparato de envío de UN contacto: canal, número de origen y fuente de
        // actividad. Los mensajes de un aviso los manda el MOTOR de flujos (say());
        // aquí solo queda la plantilla de ventana cerrada y el cumpleaños.
        type CRow = Awaited<ReturnType<typeof dbListContacts>>[number];
        const preparaEnvio = (c: CRow) => {
          // CHAT-POR-NUMERO-1 · ruta = el par con la entrada más reciente (ventana viva).
          const acc = routeAccount(c);
          const canal = acc.startsWith("ig:") ? "ig" : acc.startsWith("fb:") ? "fb" : "wa";
          const waPid = acc.startsWith("wa:") ? acc.slice(3) : "";
          const waNum = waPid ? resolveWaNumber(waPid) : null;
          const sendVia = async (fn: () => Promise<unknown>): Promise<void> => {
            if (waNum) await runWithWaNumber({ token: waNum.token, phoneId: waNum.phoneNumberId }, fn);
            else await fn();
          };
          const fuente = (canal === "ig" ? "ig-send" : canal === "fb" ? "fb-send" : "wa-send") as "ig-send" | "fb-send" | "wa-send";
          return { canal, sendVia, fuente };
        };
        // UN item (reunión manual o reserva web) → sus flujos de aviso. Claims con
        // compatibilidad: las antelaciones clásicas de una manual (1440/60) siguen
        // usando las claves appt:/appt1h: — lo ya avisado antes de este cambio no
        // se re-avisa, y la vista Reuniones sigue leyendo sus badges de ahí. Dos
        // flujos con mismo ámbito y misma antelación comparten claim: avisa UNO.
        const avisaItem = async (c: CRow, at: number, evento: string, tipo: "manual" | "web", claimBase: string): Promise<void> => {
          // Ficha solo-email: no hay canal de mensajería por el que avisar — no
          // se intenta (antes se intentaba por WhatsApp contra un id «email:…»,
          // quemaba el claim y dejaba un fallo). La vista Reuniones lo enseña
          // como «Sin canal de notificación». Sin claim: si algún día gana un
          // canal real, los avisos vuelven a armarse solos.
          if (c.phone.indexOf("email:") === 0) return;
          // Baja pedida («no-molestar», el MISMO criterio que Difusión): a quien
          // pidió no recibir mensajes no se le mandan tampoco avisos de reunión.
          // Sin claim, por lo mismo: quitarle la etiqueta re-arma los avisos.
          if (hasOptedOut(c)) return;
          for (const f of flujosPara(tipo, evento)) {
            const min = minDe(f);
            if (!(at > now && at - now <= min * 60000)) continue;
            const env = preparaEnvio(c);
            // Plantilla de ventana cerrada: SOLO la del flujo. La legacy del
            // negocio se copió a los flujos al migrar; «sin plantilla» en el
            // editor significa de verdad que fuera de ventana no sale nada.
            const tpl = String(f.trigger.tpl || "").trim();
            const tplLang = String(f.trigger.tplLang || "").trim() || apptLang;
            const puedeTpl = env.canal === "wa" && !!tpl;
            if (!inWindow(c) && !puedeTpl) continue;
            // Si este flujo aún tiene un run vivo del contacto (aviso multi-paso
            // de otra reunión cercana), NO se pisa: sin claim, se reintenta al
            // tick siguiente, cuando el run anterior haya terminado.
            if (inWindow(c) && (await dbHasActiveFlowRun(c.phone, f.id).catch(() => false))) continue;
            const legacy = tipo === "manual" && min === 1440 ? "dia" : tipo === "manual" && min === 60 ? "hora" : "";
            const key = legacy === "dia" ? "appt:" + c.phone + ":" + at : legacy === "hora" ? "appt1h:" + c.phone + ":" + at : claimBase + ":" + min;
            const failKey = legacy === "dia" ? "apptfail:" + c.phone + ":" + at : legacy === "hora" ? "appt1hfail:" + c.phone + ":" + at : key + ":fail";
            if (!(await dbClaimOnce("reminders-appt", key))) continue;
            const first = (c.name || "").split(/\s+/)[0];
            const hora = horaDe(at);
            const esHoy = diaDe(at) === diaDe(now);
            const esManana = diaDe(at) === diaDe(now + 86400000);
            const cuando = (esHoy ? "hoy" : esManana ? "mañana" : "el " + fechaDe(at)) + " a las " + hora;
            // «lanzado», no «enviado»: la entrega del flujo la cuentan sus logs
            // (say() anota «paso NO entregado» si Meta rechaza sin lanzar error).
            const verbo = inWindow(c) ? "lanzado" : "enviado";
            const resumen = "Aviso de reunión " + verbo + " (flujo «" + String(f.name || f.id).slice(0, 60) + "», " + (min >= 1440 ? Math.round(min / 1440) + " día(s) antes" : min >= 60 ? Math.round(min / 60) + " h antes" : min + " min antes") + (tipo === "web" ? " · reserva web" : "") + ")";
            try {
              if (inWindow(c)) {
                // Ventana abierta: arranca el FLUJO de verdad — sus pasos son el
                // aviso, con {{nombre}} {{evento}} {{fecha}} {{hora}} {{cuando}}.
                const ok = await triggerReminderFlow(c.phone, f, { nombre: first, evento: evento || "tu reunión", fecha: fechaDe(at), hora, cuando });
                if (!ok) throw new Error("el flujo no pudo arrancar (canal del contacto; detalle en los logs del flujo)");
              } else {
                // Ventana cerrada (solo WhatsApp): sale la plantilla aprobada en
                // lugar del flujo — un texto normal no puede salir y no se finge.
                await env.sendVia(() => sendTemplate(c.phone, tpl, tplLang, [evento || "tu reunión", cuando]));
              }
              await logActivity({ source: env.fuente, level: "info", summary: resumen, payload: { to: c.phone.slice(0, 4) + "…", canal: env.canal, at, flujo: f.id, plantilla: !inWindow(c) } });
            } catch (err) {
              await dbClaimOnce("reminders-appt", failKey).catch(() => {});
              await logActivity({ source: env.fuente, level: "error", summary: resumen.replace(verbo, "NO " + verbo), payload: { to: c.phone.slice(0, 4) + "…", canal: env.canal, at, flujo: f.id, error: (err as Error).message.slice(0, 180) } }).catch(() => {});
              console.error("[scheduler] aviso:", (err as Error).message);
            }
          }
        };
        let contacts: Awaited<ReturnType<typeof dbListContacts>> = [];
        try { contacts = await dbListContacts(5000); } catch { return; }
        for (const c of contacts) {
          const env0 = preparaEnvio(c);
          const canal = env0.canal, sendVia = env0.sendVia;
          const first = (c.name || "").split(/\s+/)[0];
          const at = c.next_action_at;
          // Reunión manual del contacto → sus flujos de aviso (manual/todos; la
          // antelación y el interruptor van en cada flujo).
          if (at) await avisaItem(c, at, c.next_action_label || "", "manual", "apptn:" + c.phone + ":" + at);

          // 2) CUMPLEAÑOS          // 2) CUMPLEAÑOS (concierge): fields.cumple/birthday == hoy (DD/MM). Dentro de
          // ventana → texto; fuera → plantilla HSM si está configurada (si no, se omite).
          const bdayRaw = (c.fields && (c.fields.cumple || c.fields.birthday || c.fields.cumpleanos)) || "";
          const bm = String(bdayRaw).match(/(\d{1,2})[/\-.](\d{1,2})/);
          // waOn explícito: antes lo garantizaba el continue de arriba, que ahora
          // deja pasar contactos con el canal apagado si reminders.mode='on'.
          if (bm && canal === "wa" && waOn) {
            const t = new Date(now);
            if (+bm[1] === t.getUTCDate() && +bm[2] === t.getUTCMonth() + 1) {
              const tpl = get("birthday.template") || "";
              const canSend = inWindow(c) || !!tpl;
              if (canSend && (await dbClaimOnce("birthday", "bday:" + c.phone + ":" + t.getUTCFullYear()))) {
                try {
                  await sendVia(() =>
                    inWindow(c)
                      ? sendText(c.phone, first ? "¡Feliz cumpleaños, " + first + "! 🎉" : "¡Feliz cumpleaños! 🎉")
                      : sendTemplate(c.phone, tpl, get("birthday.lang") || "es", first ? [first] : []),
                  );
                  await logActivity({ source: "wa-send", level: "info", summary: "Felicitación de cumpleaños enviada", payload: { to: c.phone.slice(0, 4) + "***" + c.phone.slice(-3) } });
                } catch (e) { console.error("[scheduler] birthday:", (e as Error).message); }
              }
            }
          }
        }
        // ── AVISOS PARA RESERVAS WEB · los flujos de aviso cubren también el
        // calendario de tus webs: si la reserva casó con una ficha CON canal de
        // mensajería (WhatsApp/IG/Messenger), disparan los flujos de SU evento.
        // Una ficha solo-email no tiene por dónde recibir — no se finge. Claims
        // por reserva+antelación: reprogramar en la web re-arma los avisos.
        try {
          const bks = await dbSioBookingsRange(now - 3600000, now + maxMin * 60000 + 3600000);
          for (const b of bks) {
            if (String(b.status || "").toUpperCase() === "CANCELLED") continue;
            if (!b.email || !b.booked_at || b.booked_at <= now) continue;
            const c = await dbContactByEmail(b.email);
            if (!c || c.phone.indexOf("email:") === 0) continue;
            await avisaItem(c, b.booked_at, b.event_name || "", "web", "bkg:" + b.account_id + ":" + b.booking_id + ":" + b.booked_at);
          }
        } catch (err) { console.warn("[scheduler] avisos reservas:", (err as Error).message); }
      });
    }
  } catch (e) {
    console.error("[scheduler] remindersTick:", (e as Error).message);
  }
}

export function startPostScheduler(): void {
  if (timer) return;
  timer = setInterval(tick, 60_000);
  console.log("[scheduler] programador de publicaciones activo (60s)");
  // A5: evaluador de alertas Meta Ads cada 15 min. Lo arrancamos junto
  // con el scheduler de posts porque comparten el mismo loop multi-tenant
  // (runWithWorkspace por iteración). Si en el futuro queremos cadencia
  // independiente, se separa en su propia función startAdsAlertsScheduler.
  if (!alertsTimer) {
    alertsTimer = setInterval(alertsTick, 15 * 60 * 1000);
    console.log("[scheduler] evaluador de alertas Meta Ads activo (15m)");
  }
  // FLUJO-AL-PUBLICAR-1 · enciende los flujos asignados a una publicación cuando ya está publicada.
  if (!flujosPubTimer) {
    flujosPubTimer = setInterval(() => { void flujosAlPublicarTick().catch((e) => console.warn("[flujo-al-publicar]", (e as Error).message)); }, 2 * 60 * 1000);
    console.log("[scheduler] flujo-al-publicar activo (2m)");
  }
  if (!mediaTimer) {
    mediaTimer = setInterval(() => { void mediaCaducaTick(); }, 6 * 60 * 60 * 1000);
    setTimeout(() => { void mediaCaducaTick(); }, 5 * 60 * 1000);
    console.log(`[scheduler] caducidad de medios activa (6 h, retención ${diasRetencionMedios()} d)`);
  }
  if (!remindersTimer) {
    remindersTimer = setInterval(remindersTick, 30 * 60 * 1000);
    // Primer tick temprano: siembra los flujos de aviso por defecto en cuanto
    // arranca (RECORDATORIO-FLOW-1) — sin esto, un panel recién desplegado no
    // enseña nada en Flujos → Reuniones hasta pasada media hora. Idempotente.
    setTimeout(() => { void remindersTick(); }, 20_000);
    console.log("[scheduler] recordatorio de citas activo (30m, primer tick a los 20s)");
  }
}
