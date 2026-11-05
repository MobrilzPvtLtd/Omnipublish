// ============================================================
// WEBS-LISTA-1 (CON-03) · Estado del seguimiento de cada web
// ------------------------------------------------------------
// La lista corta de «Webs» en Conexiones enseña, por cada cuenta, dos cosas que
// son distintas y no se pueden mezclar: si la CUENTA está conectada (eso lo dice
// su sincronización) y si el SEGUIMIENTO de visitas de esa web funciona. Este
// módulo responde a lo segundo:
//   · una web tiene el seguimiento ACTIVO cuando su píxel está dado de alta en
//     este workspace y ha llegado al menos una visita en los últimos `dias`;
//   · dado de alta pero sin visitas → pendiente (el píxel no está pegado, o la
//     web no tiene tráfico), y sin alta → pendiente (aún no se ha copiado).
// Todo va acotado por el workspace que se pasa: jamás se mezclan webs de otro.
// Solo usa lo que ya exporta web-analytics (el registro de píxeles y las visitas
// por web), sin consultas propias.
// ============================================================
import { listPixelSites, visitasPorWeb } from "./web-analytics.js";

export interface SeguimientoWeb {
  /** Identificador del píxel (el que viaja en la visita). */
  slug: string;
  /** Nombre con el que se copió el píxel. */
  nombre: string;
  /** Visitas registradas en la ventana de días. */
  vistas: number;
  /** true si ha llegado al menos una visita en la ventana. */
  activo: boolean;
}

export async function seguimientoWebs(tenant: string, dias = 30): Promise<SeguimientoWeb[]> {
  const t = String(tenant || "default");
  const [sitios, paginas] = await Promise.all([
    listPixelSites(t),
    visitasPorWeb(t, dias),
  ]);
  const vistasPorWeb = new Map<string, number>();
  for (const p of paginas) vistasPorWeb.set(p.web, (vistasPorWeb.get(p.web) || 0) + (Number(p.vistas) || 0));
  return sitios.map((s) => {
    const vistas = vistasPorWeb.get(s.slug) || 0;
    return { slug: s.slug, nombre: s.label || s.slug, vistas, activo: vistas > 0 };
  });
}
