/**
 * NEGOCIOS-BANDEJA-1 (BAN-01) · Qué NEGOCIOS conviven dentro de un workspace.
 *
 * Un workspace puede tener cuentas de varias marcas (caso real: el workspace
 * «Ingeniero Binario» tiene WhatsApp, Instagram y Facebook de «Ingeniero Binario» Y de
 * «LeadMatch»). La Bandeja deja elegir de qué negocio se ven las conversaciones, así
 * que hace falta agrupar las cuentas por marca sin pedirle nada a la usuaria.
 *
 * Regla: una marca es un nombre (normalizado) que comparten cuentas de AL MENOS DOS
 * canales distintos, o el propio nombre del workspace. Una página de Facebook y su
 * Instagram vinculado son siempre el mismo negocio. Las cuentas que no casan con
 * ninguna marca son del negocio principal (el del workspace). Con un único negocio,
 * la Bandeja no enseña el selector: no hay nada que elegir.
 *
 * Es una función pura (sin Graph, sin BD) para poder probarla con datos inventados.
 */

export type CanalNeg = "whatsapp" | "instagram" | "facebook";
export type CuentaNeg = {
  /** 'wa:<phoneNumberId>' · 'ig:<igId>' · 'fb:<pageId>' (la misma cadena que channel_account). */
  acct: string;
  canal: CanalNeg;
  /** Nombres con los que se reconoce la cuenta, del más fiable al menos. */
  nombres: string[];
  /** Facebook: el Instagram vinculado a la página ('ig:<igId>'). */
  vinculada?: string;
};
export type Negocio = { id: string; nombre: string; principal: boolean; cuentas: string[] };
export type MapaNegocios = { negocios: Negocio[]; principal: string; deCuenta: Map<string, string> };

/** «LeadMatch.co», «@leadmatch», «Lead Match» → «leadmatch». */
export function normalizaMarca(s: string): string {
  let t = String(s || "").trim().toLowerCase();
  t = t.normalize("NFD").replace(/[̀-ͯ]/g, "");
  t = t.replace(/^@+/, "").replace(/^www\./, "");
  t = t.replace(/\.(co|com|es|io|net|org|app|mx)$/, "");
  return t.replace(/[^a-z0-9]/g, "");
}

const casa = (a: string, k: string): boolean =>
  a === k || (a.length >= 4 && k.length >= 4 && (a.includes(k) || k.includes(a)));

export function inferirNegocios(cuentas: CuentaNeg[], nombreWs: string): MapaNegocios {
  const wsNorm = normalizaMarca(nombreWs);
  const nombresDe = new Map<string, string[]>();
  for (const c of cuentas) {
    const ns = [...new Set(c.nombres.map(normalizaMarca))].filter((n) => n.length >= 4 && !/^\d+$/.test(n));
    nombresDe.set(c.acct, ns);
  }
  // Marcas: de la más corta a la más larga; una que contiene a otra ya aceptada es la misma.
  const candidatas = new Set<string>();
  for (const ns of nombresDe.values()) for (const n of ns) candidatas.add(n);
  if (wsNorm.length >= 4) candidatas.add(wsNorm);
  const marcas: string[] = [];
  for (const k of [...candidatas].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    if (marcas.some((m) => casa(k, m))) continue;
    const canales = new Set<string>();
    for (const c of cuentas) if ((nombresDe.get(c.acct) || []).some((n) => casa(n, k))) canales.add(c.canal);
    if (canales.size >= 2 || k === wsNorm) marcas.push(k);
  }
  const marcaDe = new Map<string, string>();
  for (const c of cuentas) {
    const ns = nombresDe.get(c.acct) || [];
    const exacta = marcas.find((m) => ns.includes(m));
    const parcial = marcas.filter((m) => ns.some((n) => casa(n, m))).sort((a, b) => b.length - a.length)[0];
    const m = exacta || parcial;
    if (m) marcaDe.set(c.acct, m);
  }
  // Página de Facebook ↔ su Instagram: el que no tiene marca hereda la del otro.
  for (const c of cuentas) {
    if (!c.vinculada) continue;
    const a = marcaDe.get(c.acct);
    const b = marcaDe.get(c.vinculada);
    if (a && !b && cuentas.some((x) => x.acct === c.vinculada)) marcaDe.set(c.vinculada, a);
    else if (b && !a) marcaDe.set(c.acct, b);
  }
  const marcaWs = marcas.find((m) => wsNorm && casa(wsNorm, m)) || "";
  let principal = marcaWs || "__ws";
  for (const c of cuentas) if (!marcaDe.has(c.acct)) marcaDe.set(c.acct, principal);
  const cuentasDe = new Map<string, string[]>();
  for (const c of cuentas) {
    const m = marcaDe.get(c.acct) as string;
    cuentasDe.set(m, [...(cuentasDe.get(m) || []), c.acct]);
  }
  // Un principal sin cuentas (el workspace se llama distinto que todas sus marcas) cede
  // el puesto al negocio con más cuentas: ahí van las conversaciones sin cuenta conocida.
  if (!cuentasDe.has(principal) && cuentasDe.size) {
    principal = [...cuentasDe.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0][0];
  }
  if (!cuentasDe.has(principal)) cuentasDe.set(principal, []);
  const nombreDe = (m: string, accts: string[]): string => {
    if (m === principal && nombreWs && (m === "__ws" || m === marcaWs)) return nombreWs;
    const de = (canal: CanalNeg) => cuentas.filter((c) => c.canal === canal && accts.includes(c.acct));
    const fb = de("facebook").map((c) => c.nombres[0]).find((n) => n && casa(normalizaMarca(n), m));
    const wa = de("whatsapp").map((c) => c.nombres[0]).find((n) => n && casa(normalizaMarca(n), m));
    const ig = de("instagram").map((c) => c.nombres[0]).find((n) => n && casa(normalizaMarca(n), m));
    return fb || wa || ig || nombreWs || "Mi negocio";
  };
  const idDe = (m: string) => "n-" + (m === "__ws" ? "ws" : m);
  const negocios: Negocio[] = [...cuentasDe.entries()].map(([m, accts]) => ({
    id: idDe(m),
    nombre: nombreDe(m, accts),
    principal: m === principal,
    cuentas: accts,
  }));
  negocios.sort((a, b) => Number(b.principal) - Number(a.principal) || a.nombre.localeCompare(b.nombre, "es"));
  const deCuenta = new Map<string, string>();
  for (const [acct, m] of marcaDe) deCuenta.set(acct, idDe(m));
  return { negocios, principal: idDe(principal), deCuenta };
}
