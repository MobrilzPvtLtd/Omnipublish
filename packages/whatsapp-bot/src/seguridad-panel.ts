// Presupuestos del panel: capacidad finita, consumo antes de cualquier await y
// sin desalojar bloqueos vivos cuando llegan identidades nuevas.
export class LimiteIntentos {
  private entradas = new Map<string, { usos: number; hasta: number }>();
  private capacidad: number;
  private ventana: number;
  constructor(capacidad = 10000, ventana = 15 * 60 * 1000) {
    this.capacidad = capacidad; this.ventana = ventana;
  }
  admitir(clave: string, max: number, ahora = Date.now()): number {
    let entrada = this.entradas.get(clave);
    if (entrada && entrada.hasta <= ahora) { this.entradas.delete(clave); entrada = undefined; }
    if (!entrada) {
      if (this.entradas.size >= this.capacidad) {
        for (const [k, v] of this.entradas) if (v.hasta <= ahora) this.entradas.delete(k);
        if (this.entradas.size >= this.capacidad) return this.ventana;
      }
      entrada = { usos: 0, hasta: ahora + this.ventana }; this.entradas.set(clave, entrada);
    }
    if (entrada.usos >= max) return entrada.hasta - ahora;
    entrada.usos++;
    return 0;
  }
  borrar(clave: string): void { this.entradas.delete(clave); }
  get cantidad(): number { return this.entradas.size; }
}

const MB = 1024 * 1024;
// Únicamente las rutas que transportan archivos conservan el presupuesto anterior.
// Son límites del JSON/base64; los handlers mantienen sus límites binarios por MIME.
const CARGAS = new Set([
  '/admin/api/pages/assets', '/admin/api/ads/creatives', '/admin/api/reply',
  '/admin/api/formularios/medio', '/admin/api/flow-media',
  '/admin/api/brand/logo', '/admin/api/me/avatar',
  '/admin/api/workspaces/:id/logo', '/admin/api/wa-numbers/:pid/photo',
]);
export function limiteCuerpoPanel(ruta: string): number {
  if (CARGAS.has(ruta)) return 150 * MB;
  if (ruta === '/admin/api/settings') return 128 * 1024;
  // Edición de documentos y operaciones masivas: margen para HTML, árboles y listas.
  if (/^\/admin\/api\/(pages|flows|broadcasts|content|newsletter[s]?|formularios)(\/|$)/.test(ruta)
      || /\/(import|sync-bulk)$/.test(ruta)) return 16 * MB;
  return 2 * MB;
}

// Una cookie/contraseña de un proveedor está ligada a su origen. Cambiarlo obliga
// a conectar otra cuenta; nunca reenviamos credenciales guardadas a otro dominio.
export function mismoOrigenCredenciales(anterior: string, siguiente: string): boolean {
  try { return new URL(anterior || 'https://systeme.io').origin === new URL(siguiente).origin; }
  catch { return false; }
}

export function cambioOrigenLegadoPermitido(anterior: string, siguiente: string, cookie: string, password: string): boolean {
  return (!cookie && !password) || mismoOrigenCredenciales(anterior, siguiente || 'https://systeme.io');
}

// LIMITE-TASA-1 · Las rutas autenticadas que gastan dinero (IA) o cupo de Meta/correo
// (envíos, difusiones, publicar) no tenían freno: una sesión robada, una clave de IA
// en bucle o un doble clic sostenido vaciaban la cuota del negocio. Dos topes por
// minuto: por usuario y por workspace (el de workspace frena a varios usuarios a la vez).
export interface ClaseTasa { clase: string; usuario: number; negocio: number }
const TASAS: Array<[RegExp, ClaseTasa]> = [
  [/^\/admin\/api\/(assistant\/chat|newsletters\/ai|opendesign\/generate|llm\/probar|yt-autoreply\/test|ig-drip\/test-reply)$/,
    { clase: "ia", usuario: 30, negocio: 120 }],
  [/^\/admin\/api\/(broadcast|broadcasts\/flows\/:id\/run|publish-now|autopost\/publish|newsletters\/routines\/:id\/run|newsletters\/:id\/send|wa-templates)$/,
    { clase: "masivo", usuario: 10, negocio: 30 }],
  [/^\/admin\/api\/(reply|linkedin-comments\/reply|whatsapp\/templates\/test-send|newsletters\/:id\/test|flows\/:id\/probar)$/,
    { clase: "envio", usuario: 60, negocio: 240 }],
];
export function claseTasaPanel(ruta: string): ClaseTasa | null {
  for (const [re, c] of TASAS) if (re.test(ruta)) return c;
  return null;
}
const _tasaPanel = new LimiteIntentos(20000, 60_000);
/** Consume un uso de cada presupuesto; devuelve los ms de espera (0 = adelante). */
export function admitirTasaPanel(c: ClaseTasa, usuario: string, negocio: string, ahora = Date.now()): number {
  const u = _tasaPanel.admitir(`${c.clase}|u|${usuario}`, c.usuario, ahora);
  if (u) return u;
  return _tasaPanel.admitir(`${c.clase}|w|${negocio}`, c.negocio, ahora);
}

// LIMITE-TASA-1 · Rutas públicas sin sesión (registro y canje de OAuth de la IA): tope
// por IP. La IP es req.ip, que con TRUST_PROXY (2 saltos en Railway) es la del cliente
// y no la que alguien escriba en X-Forwarded-For.
const _tasaPublica = new LimiteIntentos(20000, 60_000);
export function frenoPublicoPorIp(nombre: string, max: number) {
  return async (req: { ip?: string }, reply: { code(n: number): { send(b: unknown): unknown }; header(k: string, v: string): unknown }) => {
    const espera = _tasaPublica.admitir(`${nombre}|${req.ip || "sin-ip"}`, max);
    if (!espera) return;
    reply.header("Retry-After", String(Math.ceil(espera / 1000)));
    return reply.code(429).send({ error: "too_many_requests", error_description: "Demasiadas peticiones. Espera un minuto y vuelve a intentarlo." });
  };
}
