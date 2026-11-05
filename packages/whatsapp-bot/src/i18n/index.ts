// IDIOMA-1 · idioma del panel (español, inglés, catalán y francés).
//
// El idioma es una preferencia DEL NAVEGADOR, como el tema: cookie `bs_lang`, que pone el
// selector de la cabecera (o Ajustes › Preferencias) antes de recargar. El servidor la lee
// al servir el panel o el acceso y, si no es español, marca <html lang> y mete el
// diccionario + el traductor (runtime.ts) como primer script de la página, antes de que
// se pinte nada. En español la página sale exactamente igual que antes.
import crypto from "node:crypto";
import { i18nRuntime } from "./runtime.js";
import EN from "./en.js";
import CA from "./ca.js";
import FR from "./fr.js";

export const IDIOMAS = ["es", "en", "ca", "fr"] as const;
export type Idioma = (typeof IDIOMAS)[number];

export function idiomaDeCookie(cookie: string | undefined): Idioma {
  const m = /(?:^|;\s*)bs_lang=(es|en|ca|fr)(?:;|$)/.exec(String(cookie || ""));
  return (m ? m[1] : "es") as Idioma;
}

type Asset = { file: string; body: string };
const ASSETS = new Map<Idioma, Asset>();
for (const [l, d] of [["en", EN], ["ca", CA], ["fr", FR]] as const) {
  // `__name` · tsx (desarrollo) compila con keepNames y mete llamadas a ese ayudante dentro
  // de las funciones; en el navegador no existe, así que se define inocuo.
  const body = `(function(){var __name=function(f){return f};(${i18nRuntime.toString()})(${JSON.stringify(l)},${JSON.stringify(d)});})();`;
  const hash = crypto.createHash("sha1").update(body).digest("hex").slice(0, 12);
  ASSETS.set(l, { file: `${l}.${hash}.js`, body });
}

/** El asset del diccionario pedido por /admin/i18n/:file, o null si no existe. */
export function assetIdioma(file: string): { body: string; actual: boolean } | null {
  for (const a of ASSETS.values()) if (a.file === file) return { body: a.body, actual: true };
  // Hash viejo durante un despliegue: se sirve el actual de ese idioma, sin caché.
  const m = /^(en|ca|fr)\.[0-9a-f]{6,}\.js$/.exec(file);
  if (m) {
    const a = ASSETS.get(m[1] as Idioma);
    if (a) return { body: a.body, actual: false };
  }
  return null;
}

/**
 * Pone el idioma a una página que empieza por `<html lang=es` (la de page()): cambia el
 * atributo y mete el diccionario justo detrás de `<meta charset=utf-8>`, antes que ningún
 * otro script, para que el primer pintado ya salga traducido.
 */
export function conIdioma(html: string, lang: Idioma): string {
  if (lang === "es") return html;
  const a = ASSETS.get(lang);
  if (!a) return html;
  return html
    .replace("<html lang=es ", `<html lang=${lang} `)
    .replace("<meta charset=utf-8>", `<meta charset=utf-8><script src="/admin/i18n/${a.file}"></script>`);
}
