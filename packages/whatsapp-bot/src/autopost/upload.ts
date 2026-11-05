/**
 * Publicación multi-plataforma vía Upload-Post (port de upload_to_socials.py).
 * Una sola llamada multipart publica en todas las redes activas. Usa fetch +
 * FormData nativos de Node (sin dependencias).
 */
const API_BASE = "https://api.upload-post.com/api";
const UPLOAD_URL = `${API_BASE}/upload_photos`;

export const SUPPORTED_PLATFORMS = [
  "instagram", "linkedin", "facebook", "x", "tiktok", "youtube", "threads", "pinterest", "bluesky",
  "reddit", "telegram", "discord", "whatsapp", "google_business",
] as const;

const ALIASES: Record<string, string> = {
  twitter: "x", ig: "instagram", fb: "facebook", li: "linkedin",
};

const CAPTION_WARN_LIMITS: Record<string, number> = {
  x: 280, bluesky: 300, threads: 500, pinterest: 500,
};
const PLATFORM_IMAGE_MAX: Record<string, number> = {
  instagram: 10, linkedin: 20, linkedin_pagina: 20, facebook: 10, x: 4,
  tiktok: 35, threads: 10, pinterest: 5, bluesky: 4,
};

export function parsePlatforms(raw: string): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let p of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    p = ALIASES[p] || p;
    if (!(SUPPORTED_PLATFORMS as readonly string[]).includes(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** `ref` = id o URL de la publicación que devolvió el proveedor (sirve para encadenar respuestas). */
export interface PerPlatform { platform: string; ok: boolean; message: string; ref?: string; }
export interface UploadResult {
  ok: boolean;
  status: number;
  perPlatform: PerPlatform[];
  warnings: string[];
  raw: string;
}

export interface UploadOpts {
  token: string;
  user: string;
  platforms: string[];
  caption: string;
  images: { name: string; buffer: Buffer }[];
}

export function captionWarnings(caption: string, platforms: string[]): string[] {
  const warns: string[] = [];
  for (const p of platforms) {
    const limit = CAPTION_WARN_LIMITS[p];
    if (limit && caption.length > limit) {
      warns.push(`El caption tiene ${caption.length} caracteres — ${p} lo recorta a ${limit}.`);
    }
  }
  const strictest = Math.min(...platforms.map((p) => PLATFORM_IMAGE_MAX[p] ?? 10));
  return warns.concat(
    [] as string[],
  ).concat(
    platforms.length && strictest < 7
      ? [`Algunas redes (${platforms.filter((p) => (PLATFORM_IMAGE_MAX[p] ?? 10) < 7).join(", ")}) solo aceptan ${strictest} imágenes; recibirán las primeras ${strictest}.`]
      : [],
  );
}

// ---------- Conexión de redes estilo SSO (hosted OAuth de Upload-Post) ----------
// En vez de pegar tokens por red, el usuario conecta sus cuentas en una página
// segura alojada por Upload-Post (igual que un "Iniciar sesión con…"). Aquí solo
// listamos lo conectado y generamos esa URL de conexión.
// accountId y needsReconnect solo los rellena Zernio: identifican la cuenta para reconectar
// ESA (y no otra de la misma red) y dicen si la red ha retirado el permiso aunque siga listada.
export interface ConnectedAccount { platform: string; displayName: string; image?: string; accountId?: string; needsReconnect?: boolean; }

const authHeader = (token: string) => ({ Authorization: `ApiKey ${token}` });

/** Cuentas sociales ya conectadas para el perfil `user`. degraded=true si la API no responde. */
export async function listConnectedAccounts(
  token: string,
  user: string,
): Promise<{ accounts: ConnectedAccount[]; degraded: boolean }> {
  if (!token) return { accounts: [], degraded: true };
  try {
    const res = await fetch(`${API_BASE}/uploadposts/users`, { headers: authHeader(token) });
    if (!res.ok) return { accounts: [], degraded: true };
    const j: any = await res.json();
    const profiles: any[] = j?.profiles || [];
    const prof = (user && profiles.find((p) => p?.username === user)) || profiles[0];
    const sa = prof?.social_accounts || {};
    const accounts: ConnectedAccount[] = Object.entries<any>(sa)
      .filter(([, v]) => v && (v.display_name || v.social_images || v.username))
      .map(([platform, v]) => ({
        platform,
        displayName: v.display_name || v.username || platform,
        image: v.social_images || undefined,
      }));
    return { accounts, degraded: false };
  } catch {
    return { accounts: [], degraded: true };
  }
}

/** Crea el perfil si no existe (best-effort; si ya existe, la API devuelve error y lo ignoramos). */
async function ensureProfile(token: string, user: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/uploadposts/users`, {
      method: "POST",
      headers: { ...authHeader(token), "Content-Type": "application/json" },
      body: JSON.stringify({ username: user }),
    });
  } catch {
    /* best-effort */
  }
}

/** URL de conexión hosted (OAuth) donde el usuario enlaza sus redes. null si no se pudo. */
export async function generateConnectUrl(
  token: string,
  user: string,
  redirectUrl: string,
  opts?: { logo?: string; platforms?: string[] },
): Promise<string | null> {
  if (!token || !user) return null;
  await ensureProfile(token, user);
  try {
    const res = await fetch(`${API_BASE}/uploadposts/users/generate-jwt`, {
      method: "POST",
      headers: { ...authHeader(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        username: user,
        redirect_url: redirectUrl,
        logo_image: opts?.logo || undefined,
        platforms: opts?.platforms && opts.platforms.length ? opts.platforms : undefined,
      }),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    return j?.access_url || null;
  } catch {
    return null;
  }
}

/**
 * Publica por URL pública (sin subir ficheros): imágenes (photos[]), un vídeo o solo texto.
 * Upload-Post descarga cada medio él mismo. En X el `title` ES el texto de la publicación.
 */
export async function uploadPostPublishUrls(opts: {
  token: string;
  user: string;
  platforms: string[];
  caption: string;
  mediaUrls: string[];
  mediaType: "image" | "video";
  /** Id o URL de la publicación a la que responde (X/Bluesky): así se encadena un hilo. */
  replyToId?: string;
}): Promise<UploadResult> {
  const { token, user, platforms, caption, mediaUrls, mediaType, replyToId } = opts;
  if (!token || !user) throw new Error("Falta el token o el usuario de Upload-Post");
  if (!platforms.length) throw new Error("No hay plataformas activas");
  const fd = new FormData();
  fd.append("user", user);
  fd.append("title", caption);
  if (replyToId) fd.append("reply_to_id", replyToId);
  for (const p of platforms) fd.append("platform[]", p);
  let url = `${API_BASE}/upload_text`;
  if (mediaUrls.length && mediaType === "video") {
    url = `${API_BASE}/upload`;
    fd.append("video", mediaUrls[0]);
  } else if (mediaUrls.length) {
    url = `${API_BASE}/upload_photos`;
    for (const m of mediaUrls) fd.append("photos[]", m);
  }
  const res = await fetch(url, { method: "POST", headers: { Authorization: `ApiKey ${token}` }, body: fd });
  const raw = await res.text();
  const perPlatform: PerPlatform[] = [];
  try {
    const parsed = JSON.parse(raw);
    const results = parsed?.results || parsed?.platforms || {};
    if (results && typeof results === "object") {
      for (const [plat, info] of Object.entries<any>(results)) {
        if (info && typeof info === "object") {
          const ref = info.post_id || info.tweet_id || info.id || info.url || info.post_url || "";
          perPlatform.push({ platform: plat, ok: info.success === true || info.status === "ok", message: info.message || info.error || "", ...(ref ? { ref: String(ref) } : {}) });
        } else perPlatform.push({ platform: plat, ok: !!info, message: String(info) });
      }
    }
  } catch { /* respuesta no-JSON */ }
  if (!perPlatform.length && res.ok) for (const p of platforms) perPlatform.push({ platform: p, ok: true, message: "" });
  return { ok: res.ok, status: res.status, perPlatform, warnings: captionWarnings(caption, platforms), raw: raw.slice(0, 2000) };
}

export async function uploadToSocials(opts: UploadOpts): Promise<UploadResult> {
  const { token, user, platforms, caption, images } = opts;
  if (!token || !user) throw new Error("Falta el token o el usuario de Upload-Post");
  if (!platforms.length) throw new Error("No hay plataformas activas");
  if (images.length < 2) throw new Error("Un carrusel necesita al menos 2 imágenes");

  const title = (caption.split("\n")[0] || "").slice(0, 150);
  const fd = new FormData();
  fd.append("title", title);
  fd.append("caption", caption);
  fd.append("user", user);
  for (const p of platforms) fd.append("platform[]", p);
  for (const img of images) {
    fd.append("photos[]", new Blob([new Uint8Array(img.buffer)], { type: "image/png" }), img.name);
  }

  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `ApiKey ${token}` },
    body: fd,
  });
  const raw = await res.text();

  const perPlatform: PerPlatform[] = [];
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* respuesta no-JSON */
  }
  if (parsed && typeof parsed === "object") {
    const results = parsed.results || parsed.platforms || {};
    if (results && typeof results === "object") {
      for (const [plat, info] of Object.entries<any>(results)) {
        if (info && typeof info === "object") {
          const ok = info.success === true || info.status === "ok";
          perPlatform.push({ platform: plat, ok, message: info.message || info.error || "" });
        } else {
          perPlatform.push({ platform: plat, ok: !!info, message: String(info) });
        }
      }
    }
  }
  // Si la API no devolvió desglose pero el HTTP fue OK, asumimos éxito por red.
  if (!perPlatform.length && res.ok) {
    for (const p of platforms) perPlatform.push({ platform: p, ok: true, message: "" });
  }

  return {
    ok: res.ok,
    status: res.status,
    perPlatform,
    warnings: captionWarnings(caption, platforms),
    raw: raw.slice(0, 2000),
  };
}
