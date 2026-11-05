// IDIOMA-1 · traductor del panel en el navegador.
//
// El panel está escrito en español dentro de APP_HTML (HTML + JS de cliente que compone
// el texto con concatenaciones). Traducirlo reescribiendo 10.000 cadenas en el fuente
// chocaría con cada sesión que toca admin.ts a la vez; así que el texto se traduce al
// PINTARSE: un MutationObserver mira cada nodo que entra en el DOM y cambia el texto
// español por el del idioma elegido usando un diccionario generado a partir del fuente
// (scripts/i18n-extraer.mjs). Con el idioma en español este fichero ni se descarga.
//
// Esta función NO se ejecuta en el servidor: se serializa con toString() y viaja como
// asset (/admin/i18n/<idioma>.<hash>.js). Por eso no puede usar nada de fuera de su
// cuerpo, y por eso vive aquí y no dentro de APP_HTML (sin dobles barras invertidas).
export function i18nRuntime(lang: string, dic: Record<string, string>): void {
  const W = window as any;
  const doc = document;
  const LOCALE: Record<string, string> = { en: "en-GB", ca: "ca-ES", fr: "fr-FR" };
  const LOC = LOCALE[lang] || "es-ES";
  const M = new Map<string, string>();
  for (const k in dic) if (Object.prototype.hasOwnProperty.call(dic, k)) M.set(k, dic[k]);

  // ── Claves con huecos ({0}, {1}…): el texto pintado lleva el valor, no el hueco.
  // Se indexan por la primera palabra literal para no probar 1.300 expresiones por nodo.
  type Patron = { re: RegExp; tr: string; lit: number };
  const PAT = new Map<string, Patron[]>();
  const PREF = new Map<string, Patron[]>();
  const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  M.forEach((tr, k) => {
    if (k.indexOf("{0}") < 0) return;
    // {{1}} y {{nombre}} (variables de plantilla) son texto, no huecos.
    const trozos: string[] = [""];
    const orden: string[] = [];
    k.split(/(\{\{[^{}]*\}\}|\{\d+\})/).forEach((p, i) => {
      if (i % 2 && p.charAt(1) !== "{") { orden.push(p.slice(1, -1)); trozos.push(""); }
      else trozos[trozos.length - 1] += p;
    });
    if (!orden.length) return;
    // El ancla es la primera palabra entera. Una pegada a un hueco («contacto{1}») cambia en el
    // texto («contactos»): solo se usa si no hay otra, y va a PREF, que se busca quitando cola.
    let ancla = "", pegada = "";
    trozos.forEach((t, i) => {
      const w = t.split(" ").filter((x) => /[A-Za-zÀ-ÿ]/.test(x));
      const colaPegada = i < trozos.length - 1 && /[A-Za-zÀ-ÿ]$/.test(t);
      for (let j = 0; j < w.length && !ancla; j++) {
        if (colaPegada && j === w.length - 1) pegada = pegada || w[j];
        else ancla = w[j];
      }
    });
    if (!ancla && !pegada) return;
    let src = "^";
    trozos.forEach((t, i) => {
      src += escRe(t);
      // Pegado a una palabra («contacto{1}») es un sufijo, que en singular va vacío. Seguido de
      // otro hueco («{2}{3}» = «120» + « vistas») se lleva el número entero, no solo «1».
      if (i < trozos.length - 1) {
        src += /[A-Za-zÀ-ÿ]$/.test(t) || (/\s$/.test(t) && /^[A-ZÁÉÍÓÚÑ]/.test(trozos[i + 1])) ? "([\\s\\S]*?)"
          : trozos[i + 1] === "" && i + 1 < trozos.length - 1 ? "(\\d[\\d.,]*\\d|\\d|[\\s\\S]+?)" : "([\\s\\S]+?)";
      }
    });
    const re = new RegExp(src + "$");
    // El orden de los huecos en la clave: {1} puede ir antes que {0}.
    (re as any).__orden = orden;
    const p: Patron = { re, tr, lit: trozos.join("").length };
    const idx = ancla ? PAT : PREF;
    const a = ancla || pegada;
    const l = idx.get(a);
    if (l) l.push(p); else idx.set(a, [p]);
  });
  PAT.forEach((l) => l.sort((a, b) => b.lit - a.lit));
  PREF.forEach((l) => l.sort((a, b) => b.lit - a.lit));

  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const LETRA = /[A-Za-zÀ-ÿ]/;

  // Un hueco lleva un número, un nombre o un título; nunca un trozo de frase. Sin este filtro
  // «Página {0}» se tragaba «Página de venta con precio tachado…» (sin traducción propia) y
  // salía «Page de venta con…», mitad y mitad: mejor dejar el texto entero sin traducir.
  const NEXO = new Set("de del la las el los lo le les y o con para por en que a al se un una unos unas este esta estos estas ese esa esos esas tu tus su sus mi mis no más muy ya aquí hoy si cuando como sin hay es son está están todo todos toda todas".split(" "));
  function esFrase(v: string): boolean {
    if (M.has(v)) return false;
    // Un rango de fechas ya localizado («28 d’ag. – 27 de set. del 2026») lleva «de/del» y no es frase.
    if (/^\d{1,2}\b.*\b\d{4}$/.test(v)) return false;
    const w = v.split(" ");
    if (NEXO.has(w[0]) || NEXO.has(w[w.length - 1])) return true;
    let n = 0;
    for (const x of w) if (NEXO.has(x)) n++;
    return w.length >= 4 && n >= 2;
  }
  function huecosLimpios(m: RegExpExecArray): boolean {
    // «es» es palabra de enlace y también el sufijo de «perfil{2}»: un sufijo no es frase.
    for (let i = 1; i < m.length; i++) if (!/^[a-záéíóú]{0,5}$/.test(m[i]) && esFrase(m[i])) return false;
    return true;
  }

  // Literal de la clave del último porPatron que casó: cuanto más largo, más concreta la clave.
  let ultLit = 0;
  function porPatron(t: string): string | null {
    const vistas = new Set<string>();
    let mejor: { p: Patron; m: RegExpExecArray } | null = null;
    for (const w of t.split(" ")) {
      if (vistas.has(w)) continue;
      vistas.add(w);
      const ls = [PAT.get(w)];
      for (let k = 0; PREF.size && k <= 5 && w.length - k >= 2; k++) ls.push(PREF.get(w.slice(0, w.length - k)));
      for (const l of ls) {
        if (!l) continue;
        for (const p of l) {
          if (mejor && mejor.p.lit >= p.lit) break;
          const m = p.re.exec(t);
          if (m && huecosLimpios(m)) { mejor = { p, m }; break; }
        }
      }
    }
    if (!mejor) return null;
    const orden: string[] = (mejor.p.re as any).__orden;
    const val: Record<string, string> = {};
    orden.forEach((n, i) => {
      const v = mejor!.m[i + 1];
      // Un valor que es a su vez un texto del panel («Estado: Activo») también se traduce,
      // con sus espacios de borde: «+(n===1?' vista':' vistas')» llega como « vistas».
      const s = v.trim();
      const r = s && !/\d/.test(s) ? M.get(s) : undefined;
      val[n] = r == null ? v : v.replace(s, () => r);
    });
    const tr = mejor.p.tr;
    const re = /\{\{[^{}]*\}\}|\{(\d+)\}/g;
    let out = "", ult = 0, h: RegExpExecArray | null;
    while ((h = re.exec(tr))) {
      out += tr.slice(ult, h.index);
      ult = h.index + h[0].length;
      const n = h[1];
      if (n === undefined || !(n in val)) { out += h[0]; continue; }
      const pal = /[A-Za-zÀ-ÿ]+$/.exec(out);
      if (pal && SUFIJO.test(val[n])) out = out.slice(0, pal.index) + plural(pal[0], val[n]);
      else out += val[n];
    }
    ultLit = mejor.p.lit;
    return out + tr.slice(ult);
  }
  // «'contacto'+(n===1?'':'s')», «'necesita'+(n===1?'':'n')», «'recibi'+(n===1?'ó':'eron')»:
  // el hueco pegado a una palabra trae el sufijo español. Se cambia por el del idioma: plural
  // del sustantivo o adjetivo que lo lleva; los de verbo se quitan (la traducción ya conjuga).
  // IDIOMA-1 · también género y «-ón» («conectad'+(…'o':'os')», «difusi'+(…'ón':'ones')»): en la
  // traducción el hueco va pegado a la palabra ya entera («connecté{2}»). El mismo conjunto lo
  // usa scripts/i18n-extraer.mjs (esSufijo) para decidir qué frases acaban en plural.
  const SUFIJO = /^(|s|es|n|an|en|ó|ió|aron|eron|ieron|o|os|a|as|ón|ones)$/;
  const CA_A: Record<string, string> = { "": "", c: "qu", g: "gu", "ç": "c", j: "g", qu: "qü" };
  function plural(p: string, suf: string): string {
    // Plural: s, es, os, as, ones. Los de verbo (aron, eron, n…) y los singulares, fuera.
    if (!/s$/.test(suf)) return p;
    const w = p.toLowerCase();
    if (lang === "en") {
      // Ya en plural («leads»), participio o adjetivo: no cambia.
      if (/(ed|ive|ing|[^su]s)$/.test(w)) return p;
      if (w === "person") return p.charAt(0) === "P" ? "People" : "people";
      if (/[^aeiou]y$/.test(w)) return p.slice(0, -1) + "ies";
      return p + (/(s|x|z|ch|sh)$/.test(w) ? "es" : "s");
    }
    if (lang === "fr") {
      if (/[sxz]$/.test(w)) return p;
      if (/al$/.test(w)) return p.slice(0, -1) + "ux";
      return p + (/eau$/.test(w) ? "x" : "s");
    }
    if (lang === "ca") {
      const r = /(qu|c|g|ç|j)?a$/.exec(w);
      if (r) return p.slice(0, p.length - r[0].length) + CA_A[r[1] || ""] + "es";
      if (/ó$/.test(w)) return p.slice(0, -1) + "ons";
      return p + (/[sçx]$/.test(w) ? "os" : "s");
    }
    return p + suf;
  }

  // Los bordes que el código añade suelto («✅ » delante, «:» o «…» detrás) no forman parte
  // de la clave: se separan, se traduce el núcleo y se vuelven a poner. PORTADA-IG-1 · también la
  // flecha final de los pies «'+x.pie+' →'» («Ver quiénes entraron →» se quedaba en español).
  const BORDES = /^([^A-Za-zÀ-ÿ0-9{"“«]*)([\s\S]*?)([\s:.…!?)\]·•,;→]*)$/;
  function buscar1(t: string): string | null {
    const v = M.get(t);
    if (v !== undefined) return v;
    const b = BORDES.exec(t);
    if (b && (b[1] || b[3]) && b[2] && LETRA.test(b[2])) {
      const exacta = M.get(b[2]);
      const nucleo = exacta ?? porPatron(b[2]);
      // VIDEOS-YT-1 · sin el punto final, «Se publicó dentro del rango: solo 3 días medidos» la
      // casaba la genérica «{0} día{1}» (hueco = media frase) antes de probar la clave entera, que
      // lleva el punto: salía «… solo 3 days medidos.». Si la frase con sus bordes casa con una
      // clave más concreta (más texto fijo), gana esa.
      if (exacta === undefined && nucleo != null) {
        const litNucleo = ultLit;
        const entera = porPatron(t);
        if (entera != null && ultLit > litNucleo) return entera;
      }
      if (nucleo != null) {
        const pre = lang === "es" ? b[1] : b[1].replace(/[¿¡]/g, "");
        return pre + nucleo + b[3];
      }
    }
    return porPatron(t);
  }
  // Textos que el código compone pegando otros con «. » («Leads nuevos. Personas que…»): se
  // parten en frases y se traduce cada tramo (juntando frases seguidas si así hay clave). Si un
  // tramo no tiene traducción, nada: nunca medio traducido.
  function porFrases(t: string): string | null {
    const fr: string[] = [];
    const re = /[.!?;:…]+\s+/g;
    let ini = 0, m: RegExpExecArray | null;
    while ((m = re.exec(t))) { fr.push(t.slice(ini, m.index + m[0].length).trim()); ini = m.index + m[0].length; }
    if (ini < t.length) fr.push(t.slice(ini).trim());
    if (fr.length < 2 || fr.length > 16) return null;
    // mejor[i]: traducción de las i primeras frases con el menor número de tramos.
    const mejor: ({ s: string; n: number } | null)[] = [{ s: "", n: 0 }];
    for (let i = 1; i <= fr.length; i++) {
      mejor[i] = null;
      for (let j = 0; j < i; j++) {
        const a = mejor[j];
        if (!a || (j === 0 && i === fr.length)) continue;
        const r = buscar1(fr.slice(j, i).join(" "));
        if (r != null && (!mejor[i] || a.n + 1 < mejor[i]!.n)) mejor[i] = { s: a.s ? a.s + " " + r : r, n: a.n + 1 };
      }
    }
    return mejor[fr.length] ? mejor[fr.length]!.s : null;
  }
  // «12 publicaciones», «6.490 suscriptores · 40.969 visualizaciones» (mxCuenta): la cifra va delante
  // y no forma parte de la clave; cada trozo unido por « · » se traduce por su nombre. Si un trozo
  // no tiene traducción, nada: nunca medio traducido.
  function porCifras(t: string): string | null {
    const out: string[] = [];
    for (const z of t.split(" · ")) {
      const c = /^(\d[\d.,]*\s+)([\s\S]+)$/.exec(z);
      if (!c || !LETRA.test(c[2])) return null;
      const r = M.get(c[2]) ?? porPatron(c[2]);
      if (r == null) return null;
      out.push(c[1] + r);
    }
    return out.join(" · ");
  }
  function buscar(t: string): string | null {
    return buscar1(t) ?? porFrases(t) ?? porCifras(t);
  }

  const cache = new Map<string, string | null>();
  function tr(raw: string): string | null {
    if (!raw || !LETRA.test(raw)) return null;
    const t = norm(raw);
    let r = cache.get(t);
    if (r === undefined) {
      r = buscar(t);
      if (r === t) r = null;
      if (cache.size > 30000) cache.clear();
      cache.set(t, r);
    }
    if (r == null) return null;
    // Se conservan los espacios de los bordes: separan este nodo de sus vecinos.
    const ini = /^\s*/.exec(raw)![0];
    const fin = /\s*$/.exec(raw)![0];
    return (ini ? " " : "") + r + (fin ? " " : "");
  }
  // Mensajes de varias líneas (alert/confirm): línea a línea.
  function trTexto(s: any): any {
    if (typeof s !== "string") return s;
    return s.split("\n").map((l) => tr(l) ?? l).join("\n");
  }

  // ── Lo que NO se traduce: código, lo que escribe el usuario y lo marcado translate=no
  // (mensajes de clientes, nombres de contactos, textos de plantillas…). Los chips
  // .fx-kwchip-t son siempre datos: la palabra clave «CONTACTO» que el lead debe escribir tal cual.
  const TAG_FUERA: Record<string, 1> = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, INPUT: 1 };
  const SEL_FUERA = '[translate="no"],.notranslate,.fx-kwchip-t,[contenteditable=""],[contenteditable="true"]';
  const ATRS = ["title", "placeholder", "aria-label", "alt", "data-tip"];
  const hecho = new WeakMap<Node, string>();
  const hechoAtr = new WeakMap<Element, Record<string, string>>();

  function fuera(el: Element | null): boolean {
    return !!el && (TAG_FUERA[el.tagName] === 1 || !!el.closest(SEL_FUERA));
  }
  function textoNodo(n: Text) {
    const v = n.nodeValue || "";
    if (hecho.get(n) === v) return;
    const t = tr(v);
    if (t != null && t !== v) { n.nodeValue = t; hecho.set(n, t); }
    else hecho.set(n, v);
  }
  function atributos(el: Element) {
    let memo = hechoAtr.get(el);
    for (const a of ATRS) {
      const v = el.getAttribute(a);
      if (v == null || (memo && memo[a] === v)) continue;
      const t = tr(v);
      const final = t != null && t !== v ? t : v;
      if (final !== v) el.setAttribute(a, final);
      if (!memo) { memo = {}; hechoAtr.set(el, memo); }
      memo[a] = final;
    }
    // Botones <input type=button|submit>: su texto es el value.
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test((el as HTMLInputElement).type)) {
      const inp = el as HTMLInputElement;
      const v = inp.value;
      if (!memo || memo.value !== v) {
        const t = tr(v);
        if (t != null && t !== v) inp.value = t;
        if (!memo) { memo = {}; hechoAtr.set(el, memo); }
        memo.value = inp.value;
      }
    }
  }
  const filtro = {
    acceptNode(n: Node): number {
      if (n.nodeType === 1) {
        const el = n as Element;
        if (TAG_FUERA[el.tagName] === 1 && el.tagName !== "INPUT") return NodeFilter.FILTER_REJECT;
        if (el.getAttribute("translate") === "no" || el.classList.contains("notranslate") || el.classList.contains("fx-kwchip-t") || (el as HTMLElement).isContentEditable) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  };
  function recorrer(raiz: Node) {
    if (raiz.nodeType === 3) {
      const p = raiz.parentElement;
      if (!fuera(p)) textoNodo(raiz as Text);
      return;
    }
    if (raiz.nodeType !== 1 && raiz.nodeType !== 11) return;
    if (raiz.nodeType === 1) {
      const el = raiz as Element;
      if (el.tagName !== "INPUT" && fuera(el)) return;
      if (el.parentElement && fuera(el.parentElement)) return;
      atributos(el);
      if (el.tagName === "INPUT") return;
    }
    const tw = doc.createTreeWalker(raiz, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, filtro as any);
    let n: Node | null;
    while ((n = tw.nextNode())) {
      if (n.nodeType === 3) textoNodo(n as Text);
      else atributos(n as Element);
    }
  }

  const obs = new MutationObserver((lista) => {
    for (const m of lista) {
      if (m.type === "childList") m.addedNodes.forEach((n) => recorrer(n));
      else if (m.type === "characterData") {
        const p = (m.target as Text).parentElement;
        if (!fuera(p)) textoNodo(m.target as Text);
      } else if (m.type === "attributes") {
        const el = m.target as Element;
        if (el.tagName === "INPUT" || !fuera(el)) atributos(el);
      }
    }
  });
  obs.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATRS.concat("value"),
  });
  // El parser ya pudo meter nodos antes de observar (el <head> hasta este script).
  recorrer(doc.documentElement);
  // ── Rótulos que viven en el CSS («content:'CONECTADO'» de un ::after): el observador no
  // los ve. Se traducen una vez, en las hojas del propio panel (las ajenas no dejan leer reglas).
  function hojas(reglas: CSSRuleList) {
    for (const r of Array.from(reglas) as any[]) {
      if (r.cssRules) hojas(r.cssRules);
      const m = r.style && /^"([^"\\]+)"$/.exec(r.style.content || "");
      const t = m && tr(m[1]);
      if (t) r.style.content = '"' + t.replace(/["\\]/g, "\\$&") + '"';
    }
  }
  // La hoja del panel (APP_CSS) va enlazada: casi siempre está al DOMContentLoaded, y si no, al load.
  const todasLasHojas = () => { for (const h of Array.from(doc.styleSheets)) { try { hojas(h.cssRules); } catch { /* hoja ajena */ } } };
  doc.addEventListener("DOMContentLoaded", () => { recorrer(doc.documentElement); todasLasHojas(); });
  W.addEventListener("load", todasLasHojas);

  // ── Diálogos nativos.
  const _alert = W.alert, _confirm = W.confirm, _prompt = W.prompt;
  W.alert = function (m?: any) { return _alert.call(W, trTexto(m)); };
  W.confirm = function (m?: any) { return _confirm.call(W, trTexto(m)); };
  W.prompt = function (m?: any, d?: any) { return _prompt.call(W, trTexto(m), d); };

  // ── Fechas y números: el panel formatea con 'es-ES' (y a veces sin locale). Se cambia
  // por el del idioma para que los meses y días salgan traducidos sin tocar cada sitio.
  const loc = (l: any): any => {
    if (l == null) return LOC;
    if (typeof l === "string") return /^es(-|$)/i.test(l) ? LOC : l;
    if (Array.isArray(l)) return l.map(loc);
    return l;
  };
  const D = Date.prototype as any;
  for (const f of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) {
    const orig = D[f];
    D[f] = function (this: Date, l?: any, o?: any) { return orig.call(this, loc(l), o); };
  }
  const N = Number.prototype as any;
  const nOrig = N.toLocaleString;
  N.toLocaleString = function (this: number, l?: any, o?: any) { return nOrig.call(this, loc(l), o); };
  const I = Intl as any;
  for (const c of ["DateTimeFormat", "NumberFormat", "RelativeTimeFormat", "PluralRules", "ListFormat"]) {
    const Orig = I[c];
    if (typeof Orig !== "function") continue;
    const Envuelto: any = function (l?: any, o?: any) { return new Orig(loc(l), o); };
    Envuelto.prototype = Orig.prototype;
    Envuelto.supportedLocalesOf = Orig.supportedLocalesOf;
    I[c] = Envuelto;
  }

  // Para el código que necesite traducir a mano (texto en <canvas>, títulos de pestaña…).
  W.__LANG = lang;
  W.__t = (s: string) => tr(s) ?? s;
}
