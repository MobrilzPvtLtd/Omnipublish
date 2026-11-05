/**
 * EDICION-CLIENTE-1 · qué producto es este despliegue.
 *
 *   false → el Business Stack COMPLETO del operador (business-stack.ingenierobinario.com):
 *           todas las vistas, todas las conexiones. Es el valor de este repositorio.
 *   true  → la EDICIÓN DE CLIENTE (repositorio business-stack-customers): el MVP que
 *           fijó el owner; fuera Meta Ads, LinkedIn Ads, Google Ads, Lead Ads, Carruseles
 *           y Páginas (SECCIONES_FUERA_DE_MVP en admin.ts). Desde MVP-CLIENTE-4
 *           (26-oct-2026) entran Facebook, Funnels, Formularios y la Página de LinkedIn.
 *
 * El sincronizador del repo de cliente (scripts/sincronizar-repo-cliente.mjs) pone FIJA a
 * true al regenerar el árbol de business-stack-customers, así que un cliente NO puede
 * olvidarse de una variable. EDICION_CLIENTE=1 en el entorno la fuerza desde el origen
 * (para probar el MVP en local sin sincronizar).
 */
const FIJA = true; // fijado por scripts/sincronizar-repo-cliente.mjs: edición de cliente (MVP) // <- el sincronizador del repo de cliente escribe true aquí
export const EDICION_CLIENTE: boolean = FIJA || process.env.EDICION_CLIENTE === "1";
