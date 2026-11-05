/** MCP-TOTAL-1 · Tipos compartidos entre el servidor MCP (mcp-server.ts) y los módulos de herramientas
 *  por dominio (mcp-herr-*.ts). Viven aparte para que esos módulos no importen mcp-server.ts (sería un
 *  ciclo) y reciban en su lugar el «kit» de utilidades ya configurado. */
import type { McpKeyRec } from "./db.js";

export type Alcance = "lectura" | "completo";
export type Args = Record<string, unknown>;
export interface Ctx { key: McpKeyRec; cookie: string; email: string; negocio: string; zona: string; origen: string }
export interface Res { texto: string; error?: boolean; cambio?: { metodo: string; ruta: string; status: number } }
export interface Herramienta {
  name: string;
  title: string;
  description: string;
  alcance: Alcance;
  annotations: Record<string, boolean | string>;
  inputSchema: Record<string, unknown>;
  run: (a: Args, c: Ctx) => Promise<Res>;
  /** Rutas fijas de las que vive: si esta edición retira alguna (rutaRetirada), no se ofrece. */
  rutas?: string[];
}

/** Utilidades que mcp-server.ts entrega a cada módulo de herramientas. */
export interface Kit {
  /** Llama a una ruta del panel con los vetos, la cuota y la confirmación humana de la capa común. */
  llamar: (c: Ctx, metodo: string, ruta: string, cuerpo?: unknown, confirmado?: boolean, campos?: string[]) => Promise<Res>;
  /** Llamada cruda (status + texto) para componer respuestas a partir de varias rutas. */
  api: (c: Ctx, metodo: string, ruta: string, cuerpo?: unknown, confirmado?: boolean) => Promise<{ status: number; texto: string; aviso?: string }>;
  fallo: (texto: string) => Res;
  str: (v: unknown) => string;
  tel: (v: unknown) => string;
  lista: (v: unknown) => string[] | undefined;
  qs: (o: Record<string, unknown>) => string;
  /** Fecha del usuario (texto o número) → ms, interpretando las fechas sin zona en la del negocio. */
  msEnZona: (v: unknown, zona: string) => number | null;
  periodo: (a: Args, zona: string) => { from: number; to: number } | { error: string };
  dias: (a: Args, porDefecto?: number) => number;
  S: {
    txt: (d: string) => Record<string, unknown>;
    num: (d: string, extra?: Record<string, unknown>) => Record<string, unknown>;
    int: (d: string, extra?: Record<string, unknown>) => Record<string, unknown>;
    bool: (d: string) => Record<string, unknown>;
    lista: (d: string) => Record<string, unknown>;
    porRed: (d: string) => Record<string, unknown>;
    obj: (d: string) => Record<string, unknown>;
    en: (d: string, valores: string[]) => Record<string, unknown>;
    fecha: (d: string) => Record<string, unknown>;
  };
  esquema: (props: Record<string, unknown>, required?: string[]) => Record<string, unknown>;
  PERIODO: Record<string, unknown>;
  LEE: Record<string, boolean>;
  CAMBIA: Record<string, boolean>;
  IDEMP: Record<string, boolean>;
  BORRA: Record<string, boolean>;
  SALE: Record<string, boolean>;
  /** true si esta edición (operador / cliente) ha retirado la ruta. */
  rutaRetirada: (ruta: string) => boolean;
  /** Compacta un JSON del panel (misma proyección que `llamar`: `campos` deja solo esas claves por elemento). */
  compactar: (texto: string, campos?: string[]) => string;
  /** Argumentos comunes de confirmación humana: nunca `required`. */
  CONFIRMA: Record<string, unknown>;
}

/** JSON del panel → objeto, o null si no es JSON. */
export function parse(texto: string): unknown {
  try { return JSON.parse(texto); } catch { return null; }
}

/** Página de una lista que el panel devuelve entera (sin paginar): `pagina` (1..) y `por_pagina` (1-200, 50 por defecto). */
export function paginar<T>(items: T[], a: Args): { total: number; pagina: number; paginas: number; items: T[] } {
  const por = Math.min(200, Math.max(1, Math.round(Number(a.por_pagina) || 50)));
  const total = items.length;
  const paginas = Math.max(1, Math.ceil(total / por));
  const pagina = Math.min(paginas, Math.max(1, Math.round(Number(a.pagina) || 1)));
  return { total, pagina, paginas, items: items.slice((pagina - 1) * por, pagina * por) };
}

/** Filtro de texto libre sobre un elemento: busca `q` (sin mayúsculas ni tildes) en los campos dados. */
export function coincide(item: unknown, q: string, campos: string[]): boolean {
  const n = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const b = n(q).trim();
  if (!b) return true;
  const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
  return campos.some((c) => n(o[c]).includes(b));
}

export const PAGINA = {
  pagina: { type: "integer", minimum: 1, description: "Página (desde 1)." },
  por_pagina: { type: "integer", minimum: 1, maximum: 200, description: "Elementos por página (1-200, 50 por defecto)." },
};
