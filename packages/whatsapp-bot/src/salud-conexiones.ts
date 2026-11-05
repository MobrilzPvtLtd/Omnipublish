/**
 * AVISO-CONEXION-1 · Que se desconecte CUALQUIER cosa y salga en la campana.
 *
 * Antes sólo avisaban WhatsApp por QR y YouTube. El resto se caía en silencio y
 * sólo se veía al abrir Conexiones. Aquí se revisa cada 15 minutos, negocio a negocio, todo
 * lo demás, y se notifica «Conexión caída» (tipo «conexion») con enlace a Conexiones:
 *
 *  · Instagram y Páginas de Facebook — Meta dice que el acceso ya no sirve.
 *  · WhatsApp (API oficial, cada número) — ídem, con el acceso de ese número.
 *  · Meta Ads — ídem, con el acceso de anuncios (y el propio de cada cuenta, si lo tiene).
 *  · LinkedIn (anuncios y Páginas) y Google Ads — el acceso ha caducado y no se ha podido
 *    renovar (renovación rechazada o sin forma de renovarlo).
 *  · systeme.io (cuentas conectadas por clave) — la clave ya no la acepta systeme.io.
 *  · Publicación automática (TikTok, X, Pinterest…) — una red que estaba enlazada deja de
 *    aparecer en el proveedor.
 *
 * Una sola vez por caída: la clave de dedup identifica ESA caída (cola del token, fecha de
 * caducidad, momento en que la red se vio enlazada), así que ni se repite cada 15 minutos ni
 * al reiniciar, y reconectar rearma el aviso. Un hipo de red o un 5xx nunca avisa.
 *
 * AVISO-CONEXION-META-1 fue la primera versión (sólo Instagram y Facebook).
 */
import { runWithWorkspace, listWorkspacesCached } from "./workspace.js";
import { get, set } from "./settings.js";
import { notificar } from "./notifications.js";
import { listIgAccounts } from "./instagram.js";
import { listFbAccounts } from "./facebook.js";
import { listWaNumbers } from "./whatsapp.js";
import { metaAdsAccountsList } from "./metaAds.js";
import { linkedinFreshToken } from "./linkedinAds.js";
import { linkedinCmFreshToken } from "./linkedinCommunity.js";
import { googleAdsFreshToken } from "./googleAds.js";
import { listAccountsRaw as listSiAccounts } from "./systemeio-accounts.js";
import { listUpAccountsRaw } from "./autopost/accounts.js";
import { listConnectedAccounts } from "./autopost/upload.js";
import { listZernioAccounts, ZERNIO_BLOCK_SETTING } from "./autopost/zernio.js";

/** Meta responde «esta autorización ya no sirve» con code 190 o esos subcódigos. */
export function esAutorizacionMetaCaducada(status: number, cuerpo: unknown): boolean {
  if (status !== 401 && status !== 400) return false;
  const err = (cuerpo as { error?: { code?: unknown; error_subcode?: unknown } } | null | undefined)?.error;
  if (!err) return false;
  if (Number(err.code) === 190) return true;
  return [458, 460, 463, 467].includes(Number(err.error_subcode));
}

/** true = Meta ha retirado el acceso · false = vivo o no se sabe (red, 5xx). */
async function metaRetirado(objeto: string, token: string): Promise<boolean> {
  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(objeto)}?fields=id&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) return false;
    return esAutorizacionMetaCaducada(r.status, await r.json().catch(() => null));
  } catch {
    return false;
  }
}

const cola = (token: string) => String(token || "").slice(-12);

function caida(tenant: string, red: string, canal: string, nombre: string, body: string, dedup: string, account?: string, link?: string): void {
  notificar({
    kind: "conexion",
    title: red + " desconectado" + (nombre ? ": " + nombre : ""),
    body,
    channel: canal,
    link: link || "connections",
    account: account || null,
    dedup: "conexion:" + dedup,
    tenant,
  });
}

async function revisarMeta(tenant: string): Promise<void> {
  for (const a of listIgAccounts()) {
    if (!a.igId || !a.token || !(await metaRetirado(a.igId, a.token))) continue;
    caida(tenant, "Instagram", "instagram", a.label && a.label !== "Principal" ? a.label : "",
      "Instagram ha retirado el permiso de la cuenta. Vuelve a conectarla para seguir recibiendo mensajes y comentarios.",
      "ig:" + a.igId + ":" + cola(a.token), "ig:" + a.igId);
  }
  for (const p of listFbAccounts()) {
    if (!p.pageId || !p.token || !(await metaRetirado(p.pageId, p.token))) continue;
    caida(tenant, "Facebook", "facebook", p.name || "",
      "Facebook ha retirado el permiso de la Página. Vuelve a conectarla para seguir recibiendo mensajes y comentarios.",
      "fb:" + p.pageId + ":" + cola(p.token), "fb:" + p.pageId);
  }
  for (const n of listWaNumbers(false)) {
    if (n.transport === "qr" || !n.phoneNumberId || !n.token || !(await metaRetirado(n.phoneNumberId, n.token))) continue;
    caida(tenant, "WhatsApp", "whatsapp", n.label || "",
      "Meta ha retirado el permiso de este número. Vuelve a conectarlo para seguir recibiendo y enviando mensajes.",
      "wac:" + n.phoneNumberId + ":" + cola(n.token), "wa:" + n.phoneNumberId);
  }
  // Meta Ads: el acceso general y, si alguna cuenta trae el suyo, también ese.
  const tokens = new Map<string, string>();
  const general = get("meta.adsToken");
  if (general) tokens.set(general, "");
  for (const c of metaAdsAccountsList()) if (c.token && !tokens.has(c.token)) tokens.set(c.token, c.label || c.adAccountName || "");
  for (const [tk, nombre] of tokens) {
    if (!(await metaRetirado("me", tk))) continue;
    caida(tenant, "Meta Ads", "meta_ads", nombre,
      "Meta ha retirado el permiso de tus anuncios. Vuelve a conectarlos para seguir viendo resultados y gestionando campañas.",
      "ads:" + cola(tk));
  }
}

/**
 * OAuth con renovación (LinkedIn, Google Ads): se pide un acceso fresco; si tras eso sigue
 * caducado, la renovación no es posible y la conexión está muerta.
 */
async function revisarOAuth(tenant: string): Promise<void> {
  const casos: Array<{ red: string; canal: string; prefijo: string; hay: boolean; renovar: () => Promise<string>; body: string }> = [
    { red: "LinkedIn Ads", canal: "linkedin", prefijo: "linkedin", hay: !!get("linkedin.adsAccounts") || !!get("linkedin.adAccountId"), renovar: linkedinFreshToken,
      body: "LinkedIn ha dejado de dar acceso a tus anuncios. Vuelve a conectarlo para seguir viendo resultados." },
    { red: "LinkedIn", canal: "linkedin", prefijo: "linkedin.cm", hay: !!get("linkedin.cm.orgs") || !!get("linkedin.cm.orgId"), renovar: linkedinCmFreshToken,
      body: "LinkedIn ha dejado de dar acceso a tu Página. Vuelve a conectarla para seguir publicando y respondiendo comentarios." },
    { red: "Google Ads", canal: "google_ads", prefijo: "googleads", hay: !!get("googleads.accounts") || !!get("googleads.customerId"), renovar: googleAdsFreshToken,
      body: "Google ha dejado de dar acceso a tus anuncios. Vuelve a conectarlo para seguir viendo resultados." },
  ];
  for (const c of casos) {
    if (!c.hay || !get(c.prefijo + ".accessToken")) continue;
    try { await c.renovar(); } catch { continue; }
    const exp = Number(get(c.prefijo + ".tokenExpiry") || 0);
    const marca = "salud.caducado." + c.prefijo;
    if (!exp || Date.now() < exp) {
      if (get(marca)) await set(marca, "");
      continue;
    }
    // La renovación se traga el motivo: un corte de red y un permiso retirado se ven igual.
    // Por eso hace falta verlo caducado en DOS pasadas seguidas (15 min) antes de avisar.
    if (get(marca) !== String(exp)) { await set(marca, String(exp)); continue; }
    caida(tenant, c.red, c.canal, "", c.body, c.prefijo + ":" + exp);
  }
}

async function revisarSystemeio(tenant: string): Promise<void> {
  let cuentas: Awaited<ReturnType<typeof listSiAccounts>> = [];
  try { cuentas = await listSiAccounts(); } catch { return; }
  for (const a of cuentas) {
    if (a.method !== "apikey" || !a.apiKey) continue;
    try {
      const r = await fetch("https://api.systeme.io/api/tags?limit=10", { headers: { "X-API-Key": a.apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (r.status !== 401 && r.status !== 403) continue;
    } catch { continue; }
    caida(tenant, "systeme.io", "systemeio", a.label || a.accountEmail || "",
      "systeme.io ya no acepta la clave de esta cuenta. Vuelve a conectarla para seguir recibiendo registros y ventas.",
      "sio:" + a.id + ":" + cola(a.apiKey));
  }
}

const NOMBRE_RED: Record<string, string> = {
  tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", youtube: "YouTube", linkedin: "LinkedIn", linkedin_pagina: "LinkedIn (página)",
  x: "X", twitter: "X", threads: "Threads", pinterest: "Pinterest", bluesky: "Bluesky", reddit: "Reddit",
  google_business: "Google Business", googlebusiness: "Google Business", telegram: "Telegram", snapchat: "Snapchat",
};
const nombreRed = (p: string) => NOMBRE_RED[p.toLowerCase()] || (p ? p[0].toUpperCase() + p.slice(1) : "Red social");

/**
 * Publicación automática: dos formas de caerse.
 *  · La red deja de salir en la lista del proveedor. Se guarda qué redes se vieron enlazadas
 *    (y desde cuándo) y se avisa cuando una desaparece. Si el proveedor no responde, nada.
 *  · RECONECTAR-RED-1 · la red sigue en la lista pero ha retirado el permiso (el cliente cambió
 *    la contraseña, caducó…). Zernio lo marca y se avisa UNA vez por caída: `caida` guarda
 *    desde cuándo está caída, va en la clave de dedup y se borra al volver a estar bien, así
 *    que la siguiente caída avisa de nuevo.
 * Los avisos de Zernio llevan a la fila de esa red en Conexiones (connections:z:<red>), donde
 * el cliente solo tiene que pulsar «Reconectar».
 */
const AJUSTE_VISTAS = "salud.autopost.vistas";
const linkRed = (clave: string, red: string) => (clave.startsWith("zn:") ? "connections:z:" + red : "connections");
async function revisarAutopost(tenant: string): Promise<void> {
  const ahora: Array<{ clave: string; red: string; nombre: string; rota: boolean }> = [];
  let completo = true;
  try {
    for (const u of await listUpAccountsRaw()) {
      if (!u.token) continue;
      const r = await listConnectedAccounts(u.token, u.user);
      if (r.degraded) { completo = false; continue; }
      for (const a of r.accounts) ahora.push({ clave: "up:" + u.id + ":" + a.platform, red: a.platform, nombre: a.displayName, rota: false });
    }
    for (let blk = 0; blk < ZERNIO_BLOCK_SETTING.length; blk++) {
      const key = get(ZERNIO_BLOCK_SETTING[blk]);
      if (!key) continue;
      const profileId = get(blk === 0 ? "autopost.zernioProfileId" : `autopost.zernioProfileId${blk + 1}`) || undefined;
      const r = await listZernioAccounts(key, profileId, blk);
      if (r.degraded) { completo = false; continue; }
      for (const a of r.accounts) ahora.push({ clave: "zn:" + blk + ":" + a.platform + ":" + a.displayName, red: a.platform, nombre: a.displayName, rota: !!a.needsReconnect });
    }
  } catch { return; }
  let vistas: Record<string, { red: string; nombre: string; desde: number; caida?: number }> = {};
  try { vistas = JSON.parse(get(AJUSTE_VISTAS) || "{}") || {}; } catch { vistas = {}; }
  const presentes = new Set(ahora.map((a) => a.clave));
  const nuevas: typeof vistas = {};
  for (const a of ahora) {
    const v = { ...(vistas[a.clave] || { red: a.red, nombre: a.nombre, desde: Date.now() }) };
    if (!a.rota) { delete v.caida; nuevas[a.clave] = v; continue; }
    if (!v.caida) v.caida = Date.now();
    nuevas[a.clave] = v;
    caida(tenant, nombreRed(a.red), a.red, a.nombre && a.nombre !== a.red ? a.nombre : "",
      "La red ha retirado el permiso (pasa al cambiar la contraseña o cuando caduca). Pulsa «Reconectar» en esta red y vuelve a iniciar sesión: tus publicaciones programadas seguirán saliendo.",
      "ap-rc:" + a.clave + ":" + v.caida, undefined, linkRed(a.clave, a.red));
  }
  for (const [clave, v] of Object.entries(vistas)) {
    if (presentes.has(clave)) continue;
    // Si algún proveedor no contestó, lo que falta puede ser suyo: se conserva sin avisar.
    if (!completo) { nuevas[clave] = v; continue; }
    caida(tenant, nombreRed(v.red), v.red, v.nombre && v.nombre !== v.red ? v.nombre : "",
      "Esta red se ha desconectado de la publicación automática. Pulsa «Conectar» en esta red para volver a enlazarla y que tus publicaciones programadas salgan también ahí.",
      "ap:" + clave + ":" + v.desde, undefined, linkRed(clave, v.red));
  }
  const antes = JSON.stringify(vistas), despues = JSON.stringify(nuevas);
  if (antes !== despues) await set(AJUSTE_VISTAS, despues);
}

async function revisarWorkspaceActual(tenant: string): Promise<void> {
  for (const [nombre, fn] of [["meta", revisarMeta], ["oauth", revisarOAuth], ["systemeio", revisarSystemeio], ["autopost", revisarAutopost]] as const) {
    try {
      await fn(tenant);
    } catch (e) {
      console.error(`[salud-conexiones] ws=${tenant} ${nombre}:`, (e as Error).message);
    }
  }
}

async function tick(): Promise<void> {
  let ids: string[] = ["default"];
  try {
    const wss = await listWorkspacesCached();
    if (wss.length) ids = wss.map((w) => w.id);
  } catch { /* BD no disponible → sólo 'default' */ }
  for (const id of ids) {
    try {
      await runWithWorkspace(id, () => revisarWorkspaceActual(id));
    } catch (e) {
      console.error(`[salud-conexiones] ws=${id}:`, (e as Error).message);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startSaludConexiones(): void {
  if (timer) return;
  setTimeout(() => void tick(), 60_000); // primera pasada al minuto de arrancar
  timer = setInterval(() => void tick(), 15 * 60_000);
  console.log("[salud-conexiones] comprobación de todas las conexiones activa (cada 15 min)");
}

export const __test = { tick, revisarWorkspaceActual };
