/**
 * Orquestador del autopost: brief (settings) → generar (Groq) → render (canvas)
 * → publicar (Upload-Post) → historial. Equivale a publisher.py del skill.
 */
import { get as getSetting, resolveLlm } from "../settings.js";
import {
  dbAddAutopostHistory,
  dbListAutopostHistory,
  type AutopostHistory,
} from "../db.js";
import { generateCarousel, type Brief, type Carousel, type Slide } from "./generate.js";
import { renderCarousel } from "./render.js";
import { renderCarouselOpenDesign } from "./opendesign.js";
import { paletteFromImage } from "./palette.js";
import { uploadToSocials, parsePlatforms, type PerPlatform, type UploadResult } from "./upload.js";
import { zernioPublish, platformBlock, ZERNIO_BLOCK_SETTING } from "./zernio.js";
import { publishX } from "./xpublish.js";
import { getActiveUpAccount, getUpAccount } from "./accounts.js";
import { publishCarousel as igPublishCarousel, publishImage as igPublishImage, listIgAccounts } from "../instagram.js";

/** Proveedor de publicación activo: Zernio (por defecto) o Upload-Post (legacy). */
export function publishProvider(): "zernio" | "upload-post" {
  // Upload-Post retirado de la app: Zernio es el ÚNICO proveedor. Ignoramos cualquier
  // ajuste antiguo "upload-post" que pudiera quedar guardado por workspace (si no, el
  // Programador/Carruseles caerían a la rama UP vacía → "0 redes conectadas").
  return "zernio";
}

// --- Hosting efímero de imágenes para Zernio (publica por URL pública) ---
// Zernio descarga las imágenes por URL, así que servimos las del carrusel desde
// una ruta pública del propio business-stack, con id aleatorio y TTL corto.
const _mediaStore = new Map<string, { images: { name: string; buffer: Buffer }[]; ts: number }>();
export function getHostedMedia(id: string): { name: string; buffer: Buffer }[] | null {
  const e = _mediaStore.get(id);
  if (!e) return null;
  if (Date.now() - e.ts > 30 * 60 * 1000) { _mediaStore.delete(id); return null; }
  return e.images;
}
function hostMedia(images: { name: string; buffer: Buffer }[]): string[] {
  // Limpieza perezosa de entradas viejas.
  const now = Date.now();
  for (const [k, v] of _mediaStore) if (now - v.ts > 30 * 60 * 1000) _mediaStore.delete(k);
  const id = Math.abs((now ^ (images.length * 2654435761)) >>> 0).toString(36) + Math.floor(now % 1e7).toString(36);
  _mediaStore.set(id, { images, ts: now });
  const host = getSetting("autopost.publicHost") || process.env.RAILWAY_PUBLIC_DOMAIN || "";
  if (!host) return [];
  const base = `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/admin/api/autopost/media/${id}`;
  return images.map((_, i) => `${base}/${i}.png`);
}

export interface PreviewResult {
  idea: string;
  caption: string;
  ctaKeyword: string;
  platforms: string[];
  slides: { name: string; dataUri: string }[];
  warnings: string[];
  engine: "opendesign" | "canvas";
  /** Carrusel completo (estructura). El cliente lo reenvía como `previous` al
   *  corregir → las correcciones no dependen del estado en memoria del servidor
   *  (sobrevive a multi-réplica / reinicios). */
  carousel: Carousel;
}
export interface PublishResult {
  idea: string;
  caption: string;
  platforms: string[];
  perPlatform: PerPlatform[];
  warnings: string[];
  ok: boolean;
}

function brief(): Brief {
  return {
    niche: getSetting("autopost.niche") || "negocio digital",
    handle: getSetting("autopost.handle") || "@mimarca",
    tone: getSetting("autopost.tone") || "storytelling",
    language: getSetting("autopost.language") || "es_ES",
    // Briefing persistente del usuario (normas de marca / errores a evitar).
    extra: getSetting("autopost.brief") || "",
  };
}
function color(): string {
  return getSetting("autopost.color") || "#18181B";
}
function accent(): string {
  return getSetting("autopost.accent") || "";
}

/**
 * Maqueta las slides con Open Design (premium, sin navegador). Si por lo que sea
 * fallara (p. ej. sin fuentes en el host), cae al render canvas para no dejar
 * nunca al usuario sin poder publicar — y avisa de qué motor se usó.
 */
async function renderSlides(
  slides: Slide[],
  colorOverride?: string,
  accentOverride?: string,
): Promise<{ images: { name: string; buffer: Buffer }[]; engine: "opendesign" | "canvas"; warning?: string }> {
  const handle = getSetting("autopost.handle") || "@mimarca";
  // Si llega override (paleta extraída de una imagen de referencia) manda sobre la marca.
  const primary = colorOverride || color();
  const acc = accentOverride || accent();
  try {
    const images = await renderCarouselOpenDesign(slides, primary, handle, acc);
    return { images, engine: "opendesign" };
  } catch (e) {
    return {
      images: renderCarousel(slides, primary),
      engine: "canvas",
      warning: `Open Design no estaba disponible (${(e as Error).message}); usé el render básico.`,
    };
  }
}
export function activePlatforms(): string[] {
  return parsePlatforms(getSetting("autopost.platforms") || "instagram");
}
async function upCreds(accountId?: string): Promise<{ token: string; user: string }> {
  // 1) accountId explícito → buscar exacto
  if (accountId) {
    const a = await getUpAccount(accountId);
    if (a) return { token: a.token, user: a.user };
  }
  // 2) Primera cuenta del array nuevo (migration legacy se aplica dentro)
  const a = await getActiveUpAccount();
  if (a) return { token: a.token, user: a.user };
  // 3) Fallback legacy (pre-migración)
  return {
    token: getSetting("autopost.uploadPostToken"),
    user: getSetting("autopost.uploadPostUser"),
  };
}

async function recentIdeas(): Promise<string[]> {
  const h = await dbListAutopostHistory(10);
  return h.map((x) => x.idea).filter(Boolean);
}

// Último carrusel generado en preview, para "publicar este" sin regenerar.
let lastPreview: { carousel: Carousel; images: { name: string; buffer: Buffer }[] } | null = null;

export async function preview(
  topic?: string,
  corrections?: string,
  referenceImages?: string[],
  note?: string,
  previous?: Carousel,
): Promise<PreviewResult> {
  // Correcciones: usa el carrusel que reenvía el CLIENTE (stateless); si no llega,
  // cae al último en memoria (single-replica). Así no se pierde en multi-réplica.
  const prev = (previous && Array.isArray(previous.slides) ? previous : undefined)
    || (corrections && corrections.trim() && lastPreview ? lastPreview.carousel : undefined);
  console.log(`[CAROUSEL preview] refImages=${referenceImages?.length || 0} corrections=${corrections ? JSON.stringify(corrections.slice(0, 80)) : "none"} previousProvided=${!!previous} prevSlides=${prev?.slides?.length ?? 0} note=${note ? "yes" : "no"}`);
  const carousel = await generateCarousel(brief(), await recentIdeas(), topic, { corrections, previous: prev, images: referenceImages, note });
  // Paleta de la imagen de referencia → el DISEÑO toma sus colores (determinista,
  // independiente de la visión del modelo). Sin imágenes = diseño por defecto.
  const pal = referenceImages && referenceImages.length ? await paletteFromImage(referenceImages[0]) : null;
  if (pal) console.log(`[CAROUSEL palette] primary=${pal.primary} accent=${pal.accent || "(auto)"}`);
  const { images, engine, warning } = await renderSlides(carousel.slides, pal?.primary, pal?.accent || undefined);
  lastPreview = { carousel, images };
  const platforms = activePlatforms();
  const warnings = warning ? [warning] : [];
  if (referenceImages && referenceImages.length) {
    const m = resolveLlm();
    warnings.push(`ℹ ${referenceImages.length} imagen(es) de referencia · texto generado con ${m.provider}/${m.model}${pal ? ` · paleta del diseño tomada de tu imagen (${pal.primary}${pal.accent ? " + " + pal.accent : ""})` : ""}.`);
  }
  return {
    idea: carousel.idea,
    caption: carousel.caption,
    ctaKeyword: carousel.cta_keyword,
    platforms,
    slides: images.map((im) => ({
      name: im.name,
      dataUri: `data:image/png;base64,${im.buffer.toString("base64")}`,
    })),
    warnings,
    engine,
    carousel,
  };
}

// Publica en Zernio agrupando las plataformas por bloque (cada bloque = su cuenta/clave).
// Así el reparto FB+IG / LinkedIn+TikTok / YouTube usa la credencial correcta de cada
// grupo, manteniendo todo en plan gratis (≤2 redes por cuenta).
async function publishViaZernioBlocks(
  platforms: string[],
  caption: string,
  images: { name: string; buffer: Buffer }[],
): Promise<UploadResult> {
  const mediaUrls = hostMedia(images); // Zernio descarga las imágenes por URL pública
  // Sin URL pública, las redes (sobre todo Facebook/Instagram) suelen rechazar el
  // post → avisamos en vez de fallar en silencio.
  const hostWarn = !mediaUrls.length
    ? ["No se pudo generar la URL pública de las imágenes (falta el dominio público en RAILWAY_PUBLIC_DOMAIN o autopost.publicHost). Facebook/Instagram pueden rechazar el post sin imagen."]
    : [];
  const perPlatform: PerPlatform[] = [];
  const warnings: string[] = [];
  let okAll = true;
  // Instagram va por la Graph API de Meta (permiso instagram_content_publish de la cuenta
  // principal conectada): sin intermediario ni plaza en el plan de Zernio. Si Meta lo rechaza,
  // se reintenta por Zernio para no perder la publicación.
  let igNativo = platforms.includes("instagram") && mediaUrls.length > 0 && listIgAccounts().length > 0;
  if (igNativo) {
    try {
      const id = mediaUrls.length > 1
        ? await igPublishCarousel(mediaUrls, caption)
        : await igPublishImage(mediaUrls[0], caption);
      perPlatform.push({ platform: "instagram", ok: true, message: id });
    } catch (e) {
      warnings.push(`Instagram (directo con Meta) falló: ${(e as Error).message.slice(0, 160)} · lo reintento por Zernio.`);
      igNativo = false;
    }
  }
  // X va por Upload-Post (no tiene grupo de Zernio).
  if (platforms.includes("x")) {
    const rx = await publishX({ caption, mediaUrls, mediaType: "image" });
    perPlatform.push(rx.result);
    warnings.push(...rx.warnings);
    if (!rx.result.ok) okAll = false;
  }
  const byBlock = new Map<number, string[]>();
  for (const p of platforms) {
    if (p === "instagram" && igNativo) continue;
    if (p === "x") continue;
    const blk = platformBlock(p);
    if (blk < 0) continue;
    const arr = byBlock.get(blk) || [];
    arr.push(p);
    byBlock.set(blk, arr);
  }
  for (const [blk, plats] of byBlock) {
    const key = getSetting(ZERNIO_BLOCK_SETTING[blk]) || "";
    const profileId = getSetting(blk === 0 ? "autopost.zernioProfileId" : `autopost.zernioProfileId${blk + 1}`) || undefined;
    if (!key) { okAll = false; for (const p of plats) perPlatform.push({ platform: p, ok: false, message: "Red sin configurar" }); continue; }
    try {
      const r = await zernioPublish({ key, profileId, platforms: plats, caption, mediaUrls });
      if (r.perPlatform.length) {
        perPlatform.push(...r.perPlatform);
      } else {
        // Fallback: si zernioPublish no devolvio resultado por plataforma,
        // propagamos warnings + raw para que el user sepa por que fallo.
        const msgParts: string[] = [];
        if (Array.isArray(r.warnings) && r.warnings.length) msgParts.push(r.warnings.join(" · "));
        if (r.status > 0) msgParts.push(`HTTP ${r.status}`);
        if (!msgParts.length && r.raw) msgParts.push(String(r.raw).slice(0, 160));
        const detail = msgParts.length ? msgParts.join(" · ") : `Zernio no devolvio resultado para ${plats.join(",")} (probablemente no conectada en Zernio).`;
        for (const p of plats) perPlatform.push({ platform: p, ok: r.ok, message: r.ok ? "ok" : detail });
      }
      warnings.push(...r.warnings);
      if (!r.ok) okAll = false;
    } catch (e) {
      okAll = false;
      for (const p of plats) perPlatform.push({ platform: p, ok: false, message: (e as Error).message });
    }
  }
  return { ok: okAll, status: okAll ? 200 : 207, perPlatform, warnings: [...hostWarn, ...warnings], raw: "" };
}

async function publishCarousel(
  carousel: Carousel,
  images: { name: string; buffer: Buffer }[],
  platformsOverride?: string[],
  accountId?: string,
): Promise<PublishResult> {
  const platforms = platformsOverride && platformsOverride.length ? platformsOverride : activePlatforms();
  const res = publishProvider() === "zernio"
    ? await publishViaZernioBlocks(platforms, carousel.caption, images)
    : await (async () => {
        const { token, user } = await upCreds(accountId);
        return uploadToSocials({ token, user, platforms, caption: carousel.caption, images });
      })();
  await dbAddAutopostHistory({
    ts: Date.now(),
    idea: carousel.idea,
    cta_keyword: carousel.cta_keyword,
    caption: carousel.caption,
    platforms,
    status: res.perPlatform,
  });
  return {
    idea: carousel.idea,
    caption: carousel.caption,
    platforms,
    perPlatform: res.perPlatform,
    warnings: res.warnings,
    ok: res.ok,
  };
}

// Publica el carrusel previsualizado (sin regenerar). Falla si no hay preview.
export async function publishLast(accountId?: string): Promise<PublishResult> {
  if (!lastPreview) throw new Error("No hay una previsualización reciente. Genera una primero.");
  const { carousel, images } = lastPreview;
  lastPreview = null;
  return publishCarousel(carousel, images, undefined, accountId);
}

// Genera un carrusel nuevo y lo publica (a demanda o programado).
export async function publishNow(
  topic?: string,
  platformsOverride?: string[],
  accountId?: string,
  referenceImages?: string[],
  note?: string,
): Promise<PublishResult> {
  const carousel = await generateCarousel(brief(), await recentIdeas(), topic, { images: referenceImages, note });
  const pal = referenceImages && referenceImages.length ? await paletteFromImage(referenceImages[0]) : null;
  const { images } = await renderSlides(carousel.slides, pal?.primary, pal?.accent || undefined);
  return publishCarousel(carousel, images, platformsOverride, accountId);
}

export async function history(limit = 20): Promise<AutopostHistory[]> {
  return dbListAutopostHistory(limit);
}
