import { transform } from "esbuild";

// PANEL-MINIFY-1 · el JS y el CSS del panel se generan en tiempo de ejecución a partir del
// template de admin.ts (APP_HTML y page()), así que no hay fichero que minificar en el build:
// se minifican UNA vez por proceso, en segundo plano, tras arrancar.
//
// Asíncrono a propósito: esbuild trabaja en su propio proceso y no bloquea el event loop. Con
// 4 MB de JS tarda de 2 a 60 s según la carga de la máquina (medido el 26-oct en Windows);
// hacerlo síncrono al cargar el módulo retrasaba el arranque ese tiempo entero. Mientras
// tanto se sirve el original, que es equivalente.
//
// JS: el panel es un <script> clásico (no módulo) y el HTML llama a sus funciones por nombre
// desde onclick=, oninput=… Sin `format`, esbuild NO renombra los símbolos de nivel superior
// (podrían ser globales que usa otro script), solo los locales; y sin `format` tampoco hace
// tree shaking, así que no quita funciones «sin usar» que en realidad usa el HTML.
// `target: "esnext"` → no se rebaja ninguna sintaxis. `charset: "utf8"` → las tildes y los
// emojis no se convierten a \uXXXX (pesarían más).
//
// Si esbuild falla (sintaxis que no entiende, binario ausente…), se resuelve con el original
// y se avisa en el log: nunca se tumba el arranque por esto. PANEL_SIN_MINIFICAR=1 lo apaga.
export async function minificar(contenido: string, tipo: "js" | "css"): Promise<string> {
  if (!contenido || process.env.PANEL_SIN_MINIFICAR === "1") return contenido;
  try {
    const t0 = Date.now();
    const r = await transform(contenido, {
      loader: tipo,
      minify: true,
      target: "esnext",
      charset: "utf8",
      legalComments: "none",
      logLevel: "silent",
    });
    const salida = r.code;
    if (!salida || salida.length < contenido.length * 0.3) {
      console.warn(`[PANEL-MINIFY-1] ${tipo}: salida sospechosa (${salida.length} de ${contenido.length} B); se sirve el original`);
      return contenido;
    }
    console.log(`[PANEL-MINIFY-1] ${tipo}: ${contenido.length} → ${salida.length} B en ${Date.now() - t0} ms`);
    return salida;
  } catch (e) {
    console.warn(`[PANEL-MINIFY-1] ${tipo}: no se pudo minificar, se sirve el original:`, String((e as Error)?.message || e).slice(0, 500));
    return contenido;
  }
}
