// ENL-04-PASOS-1 · Qué pasos POSTERIORES al clic tiene sentido contar para cada enlace.
//
// El detalle de un enlace enseñaba siempre «Después de abrirlo: web y compras», con un porcentaje de
// «compraron», aunque el enlace llevase a un directo de Zoom o a un documento: ahí el panel no ve nada
// después del clic y cualquier cifra de compra sería inventada. Según a dónde lleva el enlace:
//
//  - "pago":  el enlace personal de pago de UN producto → solo su compra confirmada.
//  - "web":   lleva a una web propia con el píxel instalado → páginas que vieron, reservas y compras.
//  - "clics": lleva fuera de lo que el panel mide (un directo, un documento, un grupo, una agenda de
//             otra plataforma, un enlace de pago antiguo sin producto) → solo se cuentan los clics.
import { esWebConPixel } from "./web-analytics.js";

export type PasosEnlace = {
  tipo: "pago" | "web" | "clics";
  /** Producto del enlace personal de pago (solo tipo "pago"). */
  productId?: string;
  /** Por qué solo se cuentan clics (solo tipo "clics"). */
  motivo?: "externo" | "agenda" | "producto";
};

/** Agendas ajenas: el panel solo sincroniza el calendario de systeme.io, no estas (misma lista que lnkTipo del panel). */
const RE_AGENDA_AJENA = /cal\.com|calendly|meetings\./i;

export async function pasosDelEnlace(
  sel: { context_kind: string; url: string; dest?: string; productId?: string },
  tenant: string,
): Promise<PasosEnlace> {
  if (sel.context_kind === "payment") {
    const pid = String(sel.productId || "");
    if (pid && pid !== "__sin_identificar__") return { tipo: "pago", productId: pid };
    return { tipo: "clics", motivo: "producto" };
  }
  const destino = String(sel.dest || sel.url || "");
  if (await esWebConPixel(tenant, destino).catch(() => false)) return { tipo: "web" };
  return { tipo: "clics", motivo: RE_AGENDA_AJENA.test(destino) ? "agenda" : "externo" };
}
