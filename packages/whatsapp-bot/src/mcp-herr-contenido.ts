/** MCP-TOTAL-1 · Herramientas MCP de CONTENIDO: Programador (mover, duplicar, Short), galerías de las redes,
 *  YouTube (métricas, retención, enlaces de vídeo), métricas de Facebook, carruseles automáticos (autopost),
 *  Páginas (Page Studio), estudio de diseño, embudos de systeme.io, negocios web y píxel, marca y utilidades.
 *  Contratos: admin.ts (scheduled-posts 17303-17524, ig/fb/li-media 13425-15666, youtube 14976-15156,
 *  fb-metrics 14873, autopost 22337-22631, pages 7804-8011, opendesign 7670, funnels 18656-18673,
 *  web 18032-18065, brand 11619-11688, og-preview 4596, divisa 2182).
 *  Fuera a propósito: credenciales de autopost (config POST, accounts, reveal-key, connect), youtube/disconnect,
 *  miniaturas-backfill, assets/raw y opendesign/preview (binarios o mantenimiento). */
import { type Args, type Ctx, type Herramienta, type Kit, PAGINA, paginar, parse } from "./mcp-tipos.js";

const REDES_GALERIA = ["instagram", "historias_instagram", "facebook", "youtube", "linkedin"];
const PLATAFORMAS_PAGINA = ["systemeio", "leadmatch-lab", "standalone"];
const MIMES_LOGO = ["image/png", "image/jpeg", "image/webp"];

export function herramientas(k: Kit): Herramienta[] {
  const { S, esquema, llamar, api, fallo, str, lista, qs, msEnZona, dias, PERIODO, LEE, CAMBIA, IDEMP, BORRA, SALE, CONFIRMA } = k;
  const enc = encodeURIComponent;
  const noConfirmado = (que: string) => fallo(que + " Confírmalo con el usuario y repite con confirmado_por_humano: true.");
  const sinPrefijo = (v: unknown) => String(v || "").replace(/^data:[^,]*,/, "");
  const fechaISO = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : "";
  /** Lee una ruta JSON; si falla devuelve la respuesta tal cual (con el error explicado). */
  const lee = async (c: Ctx, ruta: string) => {
    const r = await api(c, "GET", ruta);
    return r.status === 200 ? { json: (parse(r.texto) || {}) as Args } : { res: await llamar(c, "GET", ruta) };
  };
  const salida = (o: unknown) => ({ texto: k.compactar(JSON.stringify(o)) });
  /** Error de un POST que NO se reintenta: repetirlo volvería a gastar IA o a escribir dos veces. */
  const errorDe = (r: { status: number; texto: string; aviso?: string }) => {
    const j = (parse(r.texto) || {}) as Args;
    const msg = String(j.error || j.message || r.aviso || r.texto || "").slice(0, 1500).replace(/[.\s]+$/, "");
    return fallo("Error " + r.status + (msg ? ": " + msg : ": sin detalle") + ".");
  };
  const elementos = (a: Args, zona: string) => {
    const items = Array.isArray(a.publicaciones) ? (a.publicaciones as Args[]) : [];
    const out: Args[] = [];
    for (const it of items) {
      const cuando = msEnZona(it.fecha, zona);
      if (!str(it.id) || cuando === null) continue;
      out.push({ id: str(it.id), scheduled_at: cuando, ...(lista(it.redes) ? { platforms: lista(it.redes) } : {}) });
    }
    return out;
  };

  return [
    // ── Programador ──
    {
      name: "mover_publicaciones", title: "Mover publicaciones a otra fecha", alcance: "completo", annotations: CAMBIA,
      description: "Cambia la fecha de publicaciones pendientes o en borrador (hasta 50). Con «redes» en un elemento, separa solo esas redes a la nueva fecha "
        + "(la respuesta trae el id de la fila nueva). Como deja publicaciones preparadas para salir, pide confirmado_por_humano: true.",
      inputSchema: esquema({
        publicaciones: { type: "array", maxItems: 50, items: { type: "object", properties: { id: { type: "string" }, fecha: { type: "string", description: "Nueva fecha y hora (ISO; sin zona = la del negocio)." }, redes: { type: "array", items: { type: "string" } } }, required: ["id", "fecha"] }, description: "Qué mover y a cuándo." },
        ...CONFIRMA,
      }, ["publicaciones"]),
      rutas: ["/admin/api/scheduled-posts"],
      run: async (a, c) => {
        const items = elementos(a, c.zona);
        if (!items.length) return fallo("Pasa al menos una publicación con «id» y «fecha» válidos.");
        return llamar(c, "POST", "/admin/api/scheduled-posts/move", { items }, a.confirmado_por_humano === true);
      },
    },
    {
      name: "duplicar_publicaciones", title: "Duplicar publicaciones a otra fecha", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Copia publicaciones (incluso ya publicadas) a otra fecha como pendientes nuevas; la copia de un borrador sigue borrador. "
        + "Las copias SALDRÁN publicadas a su hora: pide confirmado_por_humano: true. Errores por elemento: cuenta desconectada, medio caducado.",
      inputSchema: esquema({
        publicaciones: { type: "array", maxItems: 50, items: { type: "object", properties: { id: { type: "string" }, fecha: { type: "string", description: "Fecha y hora de la copia (ISO)." }, redes: { type: "array", items: { type: "string" } } }, required: ["id", "fecha"] }, description: "Qué duplicar y a cuándo." },
        ...CONFIRMA,
      }, ["publicaciones"]),
      rutas: ["/admin/api/scheduled-posts"],
      run: async (a, c) => {
        const items = elementos(a, c.zona);
        if (!items.length) return fallo("Pasa al menos una publicación con «id» y «fecha» válidos.");
        return llamar(c, "POST", "/admin/api/scheduled-posts/copy", { items }, a.confirmado_por_humano === true);
      },
    },
    {
      name: "sacar_short_youtube", title: "Sacar el Short de una publicación", alcance: "completo", annotations: { ...SALE, openWorldHint: true },
      description: "Publica YA en YouTube, como Short (y opcionalmente también como vídeo normal), una publicación existente del Programador. "
        + "No es idempotente: cada llamada sube el vídeo otra vez. Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({ id: S.txt("Id de la publicación."), tambien_normal: S.bool("true = además como vídeo normal."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/scheduled-posts"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Sacar el Short publica en YouTube inmediatamente.");
        return llamar(c, "POST", "/admin/api/scheduled-posts/" + enc(str(a.id)) + "/youtube-short", { conNormal: a.tambien_normal === true }, true);
      },
    },

    // ── Galerías de las redes ──
    {
      name: "publicaciones_en_red", title: "Últimas publicaciones de una red", alcance: "lectura", annotations: LEE,
      description: "Lo ya publicado en una red, según la propia red: Instagram (hasta 100; ids válidos para flujos de comentarios), historias de Instagram vivas (24 h), "
        + "Páginas de Facebook, canales de YouTube o Páginas de LinkedIn. Las stories no salen en «instagram»: usa historias_instagram.",
      inputSchema: esquema({
        red: S.en("Qué red.", REDES_GALERIA), cuenta_ig: S.txt("Id de la cuenta de Instagram, si hay varias (instagram / historias_instagram)."),
        refrescar: S.bool("true = volver a pedirlas a la red en vez de la copia reciente."), q: S.txt("Texto a buscar en el pie."), ...PAGINA,
      }, ["red"]),
      run: async (a, c) => {
        const red = str(a.red);
        const ruta = red === "historias_instagram" ? "/admin/api/ig-stories" : red === "instagram" ? "/admin/api/ig-media" : red === "facebook" ? "/admin/api/fb-media" : red === "youtube" ? "/admin/api/yt-media" : red === "linkedin" ? "/admin/api/li-media" : "";
        if (!ruta) return fallo("«red» debe ser " + REDES_GALERIA.join(", ") + ".");
        const r = await lee(c, ruta + qs({ ig_id: /instagram/.test(red) ? str(a.cuenta_ig) : "", refresh: a.refrescar === true ? "1" : "" }));
        if (r.res) return r.res;
        const j = r.json;
        if (j.configured === false) return fallo(red === "instagram" || red === "historias_instagram" ? "Esa cuenta de Instagram no está conectada (o el id no es de este negocio)." : "Esa red no está conectada.");
        let media = Array.isArray(j.media) ? (j.media as Args[]) : [];
        if (str(a.q)) { const q = str(a.q).toLowerCase(); media = media.filter((m) => String(m.caption || m.message || "").toLowerCase().includes(q)); }
        const { media: _m, ...resto } = j;
        return salida({ ...resto, ...paginar(media, a) });
      },
    },

    // ── YouTube ──
    {
      name: "metricas_youtube", title: "Canales y métricas de YouTube", alcance: "lectura", annotations: LEE,
      description: "Los canales de YouTube conectados con sus últimos vídeos. Con «dias», además la analítica del periodo (visualizaciones, tiempo de visionado, suscriptores…) y 12 vídeos. "
        + "«caducado» en un canal = hay que reconectarlo en Conexiones.",
      inputSchema: esquema({ dias: S.int("Periodo de la analítica (1-365). Sin él, solo el estado y los 6 últimos vídeos.", { minimum: 1, maximum: 365 }), refrescar: S.bool("true = saltar la copia reciente.") }),
      rutas: ["/admin/api/youtube"],
      run: async (a, c) => Number(a.dias) > 0
        ? llamar(c, "GET", "/admin/api/youtube/full" + qs({ days: dias(a), refresh: a.refrescar === true ? "1" : "" }))
        : llamar(c, "GET", "/admin/api/youtube" + qs({ refresh: a.refrescar === true ? "1" : "" })),
    },
    {
      name: "retencion_video_youtube", title: "Curva de retención de un vídeo", alcance: "lectura", annotations: LEE,
      description: "Qué porcentaje de la audiencia sigue viendo el vídeo en cada punto (puntos de la curva y duración). Fechas en formato AAAA-MM-DD.",
      inputSchema: esquema({ video: S.txt("Id del vídeo de YouTube."), desde: S.txt("Inicio AAAA-MM-DD."), hasta: S.txt("Fin AAAA-MM-DD."), canal: S.txt("Id del canal, si hay varios.") }, ["video", "desde", "hasta"]),
      rutas: ["/admin/api/youtube/retencion"],
      run: async (a, c) => {
        if (!fechaISO(a.desde) || !fechaISO(a.hasta)) return fallo("«desde» y «hasta» van en formato AAAA-MM-DD.");
        return llamar(c, "GET", "/admin/api/youtube/retencion" + qs({ id: str(a.video), acct: str(a.canal), from: fechaISO(a.desde), to: fechaISO(a.hasta) }));
      },
    },
    {
      name: "resultado_video_youtube", title: "Qué consigue un vídeo fuera de YouTube", alcance: "lectura", annotations: LEE,
      description: "Enlaces de la descripción del vídeo, enlaces medidos creados para él, clics y visitas a la web que vinieron de él (y los eventos uno a uno).",
      inputSchema: esquema({ video: S.txt("Id del vídeo."), canal: S.txt("Id del canal."), desde: S.txt("Inicio AAAA-MM-DD (opcional)."), hasta: S.txt("Fin AAAA-MM-DD (opcional).") }, ["video"]),
      rutas: ["/admin/api/youtube/oferta"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/youtube/oferta" + qs({ id: str(a.video), acct: str(a.canal), from: fechaISO(a.desde), to: fechaISO(a.hasta) })),
    },
    {
      name: "crear_enlace_video_youtube", title: "Enlace medido para un vídeo", alcance: "completo", annotations: CAMBIA,
      description: "Crea un enlace corto con seguimiento (UTM youtube / video / id) para ponerlo en la descripción de un vídeo. No toca YouTube: el enlace lo pega el usuario.",
      inputSchema: esquema({ video: S.txt("Id del vídeo."), url: S.txt("Destino (http/https, hasta 2000 caracteres)."), titulo: S.txt("Nombre del enlace (hasta 80).") }, ["video", "url"]),
      rutas: ["/admin/api/youtube/oferta"],
      run: async (a, c) => llamar(c, "POST", "/admin/api/youtube/oferta/enlace", { id: str(a.video), url: str(a.url), ...(str(a.titulo) ? { title: str(a.titulo) } : {}) }),
    },
    {
      name: "marcar_short_youtube", title: "Añadir #Shorts a un vídeo", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Añade «#Shorts» al título de un vídeo ya subido a YouTube (cambia el vídeo público). Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({ video: S.txt("Id del vídeo."), canal: S.txt("Id del canal, si hay varios."), ...CONFIRMA }, ["video"]),
      rutas: ["/admin/api/youtube"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Cambiar el título de un vídeo público en YouTube.");
        return llamar(c, "POST", "/admin/api/youtube/marcar-short", { videoId: str(a.video), ...(str(a.canal) ? { accountId: str(a.canal) } : {}) }, true);
      },
    },

    // ── Facebook ──
    {
      name: "metricas_facebook", title: "Métricas de una Página de Facebook", alcance: "lectura", annotations: LEE,
      description: "Alcance, seguidores, interacción y publicaciones de una Página de Facebook en el periodo. Con piezas: true, además qué publicaciones con anuncio trajeron conversaciones y quién llegó por cada una.",
      inputSchema: esquema({ pagina: S.txt("Id de la Página (estado_conexiones)."), ...PERIODO, piezas: S.bool("true = añadir las publicaciones con anuncio y sus conversaciones.") }, ["pagina"]),
      rutas: ["/admin/api/fb-metrics"],
      run: async (a, c) => {
        const p = str(a.desde) || str(a.hasta) ? k.periodo(a, c.zona) : null;
        if (p && "error" in p) return fallo(p.error);
        const q = qs({ pageId: str(a.pagina), ...(p ? { from: p.from, to: p.to } : { days: dias(a, 28) }) });
        const m = await lee(c, "/admin/api/fb-metrics" + q);
        if (m.res) return m.res;
        if (a.piezas !== true) return salida(m.json);
        const pz = await api(c, "GET", "/admin/api/fb-piezas" + qs({ pageId: str(a.pagina) }));
        return salida({ ...m.json, piezas: pz.status === 200 ? parse(pz.texto) : { error: pz.texto } });
      },
    },

    // ── Carruseles automáticos ──
    {
      name: "config_carruseles", title: "Generador de carruseles: configuración", alcance: "lectura", annotations: LEE,
      description: "Cómo está configurado el generador de carruseles con IA (nicho, marca, tono, colores, redes, publicación automática y su próximo pase) y su historial. "
        + "Las claves y credenciales no se enseñan ni se cambian desde aquí.",
      inputSchema: esquema({ historial: S.bool("true = incluir el historial de carruseles generados (paginado)."), ...PAGINA }),
      rutas: ["/admin/api/autopost/config"],
      run: async (a, c) => {
        const r = await lee(c, "/admin/api/autopost/config");
        if (r.res) return r.res;
        const { history, uploadPostUser, hasToken, hasZernioKey, socialKeys, ...resto } = r.json;
        return salida({ ...resto, ...(a.historial === true ? paginar(Array.isArray(history) ? (history as Args[]) : [], a) : { historial: Array.isArray(history) ? history.length : 0 }) });
      },
    },
    {
      name: "programar_carruseles_automaticos", title: "Publicación automática de carruseles", alcance: "completo", annotations: { ...SALE, openWorldHint: true },
      description: "Enciende o apaga que el panel genere con IA y publique carruseles solo, y a qué hora y días. Los campos que no pases se conservan. "
        + "Encenderlo deja publicaciones automáticas en marcha: pide confirmado_por_humano: true.",
      inputSchema: esquema({
        activar: S.bool("true = encender; false = apagar."), cadencia: S.txt("Cadencia (p. ej. 3xweek, daily, weekly)."), hora: S.int("Hora (0-23).", { minimum: 0, maximum: 23 }),
        minuto: S.int("Minuto (0-59).", { minimum: 0, maximum: 59 }), dias_semana: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "Días (0 = domingo … 6 = sábado); vacío = según la cadencia." },
        zona: S.txt("Zona horaria IANA."), ...CONFIRMA,
      }, ["activar"]),
      rutas: ["/admin/api/autopost/schedule"],
      run: async (a, c) => {
        const r = await lee(c, "/admin/api/autopost/config");
        if (r.res) return r.res;
        const cur = r.json;
        const b: Args = {
          enabled: a.activar === true, cadence: str(a.cadencia) || str(cur.cadence) || "3xweek",
          hour: a.hora !== undefined ? Number(a.hora) : Number(cur.hour ?? 19), minute: a.minuto !== undefined ? Number(a.minuto) : Number(cur.minute ?? 0),
          days: Array.isArray(a.dias_semana) ? a.dias_semana : Array.isArray(cur.days) ? cur.days : [], timezone: str(a.zona) || str(cur.timezone) || c.zona,
        };
        return llamar(c, "POST", "/admin/api/autopost/schedule", b, a.confirmado_por_humano === true);
      },
    },
    {
      name: "generar_carrusel", title: "Generar un carrusel con IA", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Genera con IA un carrusel (idea, pie, palabra clave y diapositivas) para revisarlo; gasta IA pero no publica: pide confirmado_por_humano: true. Admite correcciones sobre el anterior "
        + "(pasa «anterior» = el objeto carrusel devuelto). Devuelve los textos y cuántas diapositivas hay (las imágenes quedan en el panel); publicar_carrusel con usar_ultimo publica este.",
      inputSchema: esquema({
        tema: S.txt("Tema del carrusel."), correcciones: S.txt("Qué cambiar respecto al anterior."), nota: S.txt("Indicaciones extra."),
        imagenes: S.lista("Hasta 6 imágenes (URL http/https o data:image/...)."), anterior: S.obj("El objeto «carrusel» devuelto por la generación anterior, para corregirlo."),
        ...CONFIRMA,
      }),
      rutas: ["/admin/api/autopost/preview"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return fallo("Generar un carrusel gasta IA (un modelo de pago). Enséñale al usuario el tema y repite con confirmado_por_humano: true solo si lo aprueba.");
        const b: Args = {};
        if (str(a.tema)) b.topic = str(a.tema); if (str(a.correcciones)) b.corrections = str(a.correcciones); if (str(a.nota)) b.note = str(a.nota);
        const im = lista(a.imagenes); if (im) b.images = im.slice(0, 6);
        if (a.anterior && typeof a.anterior === "object") b.previous = a.anterior;
        const r = await api(c, "POST", "/admin/api/autopost/preview", b);
        if (r.status !== 200) return errorDe(r);
        const j = (parse(r.texto) || {}) as Args;
        const slides = Array.isArray(j.slides) ? (j.slides as Args[]) : [];
        return salida({ idea: j.idea, pie: j.caption, palabra_clave: j.ctaKeyword, redes: j.platforms, diapositivas: slides.length, nombres: slides.map((s) => s.name), avisos: j.warnings, motor: j.engine, carrusel: j.carousel });
      },
    },
    {
      name: "publicar_carrusel", title: "Publicar un carrusel", alcance: "completo", annotations: { ...SALE, openWorldHint: true },
      description: "Publica en las redes configuradas el último carrusel generado (usar_ultimo: true) o genera y publica uno nuevo a partir de «tema». "
        + "Es público e irreversible: pide confirmado_por_humano: true. «usar_ultimo» depende de que el panel no se haya reiniciado desde la generación.",
      inputSchema: esquema({ usar_ultimo: S.bool("true = el último generado con generar_carrusel."), tema: S.txt("Tema (si no se usa el último)."), nota: S.txt("Indicaciones extra."), imagenes: S.lista("Imágenes (si no se usa el último)."), cuenta: S.txt("Id de cuenta de publicación, si hay varias."), ...CONFIRMA }),
      rutas: ["/admin/api/autopost/publish"],
      run: async (a, c) => {
        if (a.usar_ultimo !== true && !str(a.tema)) return fallo("Pasa usar_ultimo: true o un «tema».");
        const b: Args = a.usar_ultimo === true ? { useLast: true } : { topic: str(a.tema) };
        if (str(a.nota)) b.note = str(a.nota); const im = lista(a.imagenes); if (im) b.images = im; if (str(a.cuenta)) b.accountId = str(a.cuenta);
        return llamar(c, "POST", "/admin/api/autopost/publish", b, a.confirmado_por_humano === true);
      },
    },
    {
      name: "redes_de_publicacion", title: "Redes conectadas para publicar", alcance: "lectura", annotations: LEE,
      description: "Qué redes están conectadas al servicio de publicación (Programador y carruseles) y en qué estado. Con probar: true, comprueba las claves contra el servicio.",
      inputSchema: esquema({ cuenta: S.txt("Id de cuenta de publicación (modo upload-post)."), refrescar: S.bool("true = volver a consultar."), probar: S.bool("true = probar las claves de publicación.") }),
      rutas: ["/admin/api/autopost/connections", "/admin/api/autopost/zernio/test"],
      run: async (a, c) => {
        const r = await lee(c, "/admin/api/autopost/connections" + qs({ accountId: str(a.cuenta), refresh: a.refrescar === true ? "1" : "" }));
        if (r.res) return r.res;
        if (a.probar !== true) return salida(r.json);
        const t = await api(c, "GET", "/admin/api/autopost/zernio/test");
        return salida({ ...r.json, prueba: t.status === 200 ? parse(t.texto) : { error: t.texto } });
      },
    },

    // ── Páginas (Page Studio) ──
    {
      name: "plantillas_pagina", title: "Plantillas de página", alcance: "lectura", annotations: LEE,
      description: "Las plantillas de Páginas con sus huecos (slots): la clave de cada hueco es la que va en «datos» de guardar_pagina. html-paste-v1 publica un HTML pegado tal cual.",
      inputSchema: esquema({}),
      rutas: ["/admin/api/pages"],
      run: async (_a, c) => llamar(c, "GET", "/admin/api/pages/templates"),
    },
    {
      name: "listar_paginas", title: "Páginas (borradores y publicadas)", alcance: "lectura", annotations: LEE,
      description: "Las páginas del Page Studio con su plantilla, estado, destino (systeme.io: funnel / paso / página) y URL publicada. Sin el HTML: ver_pagina lo trae.",
      inputSchema: esquema({ q: S.txt("Texto a buscar en el nombre."), estado: S.txt("Solo este estado (draft, published…)."), ...PAGINA }),
      rutas: ["/admin/api/pages"],
      run: async (a, c) => {
        const r = await lee(c, "/admin/api/pages/drafts");
        if (r.res) return r.res;
        let ds: Args[] = (Array.isArray(r.json.drafts) ? (r.json.drafts as Args[]) : []).map((d) => { const { rendered_html, data, ...resto } = d; return { ...resto, tiene_html: !!rendered_html, huecos: data && typeof data === "object" ? Object.keys(data as object).length : 0 } as Args; });
        if (str(a.q)) { const q = str(a.q).toLowerCase(); ds = ds.filter((d) => String(d.label || "").toLowerCase().includes(q)); }
        if (str(a.estado)) ds = ds.filter((d) => str(d.status) === str(a.estado));
        return salida(paginar(ds, a));
      },
    },
    {
      name: "ver_pagina", title: "Ver una página", alcance: "lectura", annotations: LEE,
      description: "Una página del Page Studio: datos de los huecos, destino, estado y URL publicada. Con html: true, también el HTML generado (pesado).",
      inputSchema: esquema({ id: S.txt("Id de la página."), html: S.bool("true = incluir el HTML renderizado.") }, ["id"]),
      rutas: ["/admin/api/pages"],
      run: async (a, c) => {
        const r = await lee(c, "/admin/api/pages/drafts/" + enc(str(a.id)));
        if (r.res) return r.res;
        const d = (r.json.draft || {}) as Args;
        if (a.html === true) return salida(d);
        const { rendered_html, ...resto } = d;
        return salida({ ...resto, tiene_html: !!rendered_html });
      },
    },
    {
      name: "previsualizar_pagina", title: "Previsualizar una página", alcance: "lectura", annotations: LEE,
      description: "Genera el HTML de una plantilla con unos datos, sin guardar nada (sin píxel ni SEO).",
      inputSchema: esquema({ plantilla: S.txt("Id de la plantilla."), datos: S.obj("Valores por hueco { CLAVE: valor }.") }, ["plantilla"]),
      rutas: ["/admin/api/pages"],
      run: async (a, c) => llamar(c, "POST", "/admin/api/pages/preview", { template_id: str(a.plantilla), data: a.datos && typeof a.datos === "object" ? a.datos : {} }),
    },
    {
      name: "guardar_pagina", title: "Crear o editar una página", alcance: "completo", annotations: CAMBIA,
      description: "Crea (sin «id») o actualiza una página del Page Studio: plantilla, nombre, datos de los huecos (claves en MAYÚSCULAS de plantillas_pagina, más __custom_css, __custom_js, __custom_html y seo) "
        + "y destino en systeme.io (funnel, paso o id numérico de página). Cada guardado la vuelve a borrador; publicar_pagina la publica.",
      inputSchema: esquema({
        id: S.txt("Id de la página a editar."), plantilla: S.txt("Id de la plantilla."), nombre: S.txt("Nombre de la página."), datos: S.obj("Valores por hueco."),
        destino: S.txt("Dónde se publicará: " + PLATAFORMAS_PAGINA.join(", ") + " o el id de una web conectada (la del selector de cuenta del panel). Por defecto systemeio."), funnel: S.txt("Id del funnel de systeme.io."), paso: S.txt("Id del paso del funnel."), pagina_systeme: S.txt("Id numérico de la página de systeme.io."),
      }, ["plantilla"]),
      rutas: ["/admin/api/pages"],
      run: async (a, c) => {
        const b: Args = { template_id: str(a.plantilla) };
        if (str(a.id)) b.id = str(a.id); if (str(a.nombre)) b.label = str(a.nombre); if (a.datos && typeof a.datos === "object") b.data = a.datos;
        if (str(a.destino)) b.target_platform = str(a.destino); if (str(a.funnel)) b.target_funnel_id = str(a.funnel); if (str(a.paso)) b.target_step_id = str(a.paso); if (str(a.pagina_systeme)) b.target_page_id = str(a.pagina_systeme);
        const r = await api(c, "POST", "/admin/api/pages/drafts", b);
        if (r.status !== 200) return errorDe(r);
        const j = (parse(r.texto) || {}) as Args;
        const d = (j.draft || {}) as Args; const { rendered_html, ...resto } = d;
        return salida({ ok: j.ok, pagina_guardada: resto });
      },
    },
    {
      name: "borrar_pagina", title: "Borrar una página", alcance: "completo", annotations: BORRA,
      description: "Borra la página del Page Studio (no la despublica de systeme.io). Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({ id: S.txt("Id de la página."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/pages"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar la página es irreversible.");
        return llamar(c, "DELETE", "/admin/api/pages/drafts/" + enc(str(a.id)), undefined, true);
      },
    },
    {
      name: "publicar_pagina", title: "Publicar una página en systeme.io", alcance: "completo", annotations: { ...SALE, openWorldHint: true },
      description: "Publica la página en su destino de systeme.io SUSTITUYENDO todo el contenido de esa página, a la vista de todo el público. Es asíncrono: devuelve un trabajo; "
        + "el resultado se ve en el estado y la URL publicada de ver_pagina (o en consultar_operacion). Pide confirmado_por_humano: true.",
      inputSchema: esquema({ id: S.txt("Id de la página."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/pages"],
      run: async (a, c) => llamar(c, "POST", "/admin/api/pages/drafts/" + enc(str(a.id)) + "/publish", {}, a.confirmado_por_humano === true),
    },
    {
      name: "archivos_pagina", title: "Archivos subidos para páginas", alcance: "lectura", annotations: LEE,
      description: "Imágenes y archivos subidos para las páginas (url relativa /a/<id>, pública). Con «id_pagina», solo los de esa página.",
      inputSchema: esquema({ id_pagina: S.txt("Id de la página."), ...PAGINA }),
      rutas: ["/admin/api/pages"],
      run: async (a, c) => {
        const r = await lee(c, "/admin/api/pages/assets" + qs({ draftId: str(a.id_pagina) }));
        if (r.res) return r.res;
        return salida(paginar(Array.isArray(r.json.assets) ? (r.json.assets as Args[]) : [], a));
      },
    },
    {
      name: "subir_archivo_pagina", title: "Subir un archivo para una página", alcance: "completo", annotations: CAMBIA,
      description: "Sube una imagen u otro archivo (base64) para usarlo en una página; queda público en /a/<id>. Para medios del Programador usa subir_archivo.",
      inputSchema: esquema({ archivo_base64: S.txt("Contenido en base64 (admite prefijo data:)."), nombre: S.txt("Nombre del archivo."), mime: S.txt("Tipo (image/png, image/jpeg…)."), pagina: S.txt("Id de la página a la que pertenece.") }, ["archivo_base64"]),
      rutas: ["/admin/api/pages"],
      run: async (a, c) => llamar(c, "POST", "/admin/api/pages/assets", { dataBase64: sinPrefijo(a.archivo_base64), ...(str(a.nombre) ? { name: str(a.nombre) } : {}), ...(str(a.mime) ? { contentType: str(a.mime) } : {}), ...(str(a.pagina) ? { draftId: str(a.pagina) } : {}) }),
    },
    {
      name: "borrar_archivo_pagina", title: "Borrar un archivo de páginas", alcance: "completo", annotations: BORRA,
      description: "Borra un archivo subido. Las páginas publicadas que lo usen se quedan sin él. Confirma: confirmado_por_humano: true.",
      inputSchema: esquema({ id: S.txt("Id del archivo."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/pages"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar el archivo rompe las páginas que lo usan.");
        return llamar(c, "DELETE", "/admin/api/pages/assets/" + enc(str(a.id)), undefined, true);
      },
    },
    {
      name: "generar_diseno_ia", title: "Generar un diseño HTML con IA", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Pide al estudio de diseño del panel un HTML a partir de una descripción (gasta IA; no guarda nada): pide confirmado_por_humano: true. Sin «prompt», dice si el estudio está configurado y con qué modelo.",
      inputSchema: esquema({ prompt: S.txt("Qué diseñar."), modelo: S.txt("Modelo (opcional)."), max_tokens: S.int("Tope de tokens (opcional)."), ...CONFIRMA }),
      rutas: ["/admin/api/opendesign"],
      run: async (a, c) => {
        if (!str(a.prompt)) return llamar(c, "GET", "/admin/api/opendesign/status");
        if (a.confirmado_por_humano !== true) return fallo("Generar un diseño gasta IA (un modelo de pago). Enséñale al usuario qué se va a diseñar y repite con confirmado_por_humano: true solo si lo aprueba.");
        return llamar(c, "POST", "/admin/api/opendesign/generate", { prompt: str(a.prompt), ...(str(a.modelo) ? { model: str(a.modelo) } : {}), ...(Number(a.max_tokens) > 0 ? { maxTokens: Number(a.max_tokens) } : {}) });
      },
    },

    // ── Embudos de systeme.io ──
    {
      name: "embudos_systeme", title: "Funnels de systeme.io (métricas)", alcance: "completo", annotations: CAMBIA,
      description: "Los funnels de una web de systeme.io con visitas, registros, ventas e ingresos del periodo (null = no medible, no cero). Con «funnel», el detalle paso a paso. "
        + "Con sincronizar: true, antes vuelve a leer los funnels de systeme.io (escribe en el panel: solo con una conexión de «Consultar y actuar»).",
      inputSchema: esquema({ cuenta: S.txt("Id de la cuenta de systeme.io (webs_conectadas), si hay varias."), dias: S.en("Periodo. Por defecto 30.", ["7", "30", "90", "365"]), funnel: S.txt("Id de un funnel para ver su detalle."), sincronizar: S.bool("true = releer los funnels de systeme.io antes."), ...PAGINA }),
      rutas: ["/admin/api/funnels"],
      run: async (a, c) => {
        if (a.sincronizar === true) {
          // Una sola llamada, sin reintento: sin cuenta en el cuerpo el panel sincronizaría OTRA web.
          const s = await llamar(c, "POST", "/admin/api/funnels/sync", str(a.cuenta) ? { si_acc: str(a.cuenta) } : {});
          if (s.error) return s;
        }
        const q = qs({ si_acc: str(a.cuenta), days: str(a.dias) || "30" });
        if (str(a.funnel)) return llamar(c, "GET", "/admin/api/funnels/" + enc(str(a.funnel)) + q);
        const r = await lee(c, "/admin/api/funnels" + q);
        if (r.res) return r.res;
        const { funnels, ...resto } = r.json;
        return salida({ ...resto, ...paginar(Array.isArray(funnels) ? (funnels as Args[]) : [], a) });
      },
    },

    // ── Web: negocios, embudos medidos y píxel ──
    {
      name: "negocios_web", title: "Negocios y embudos web medidos", alcance: "lectura", annotations: LEE,
      description: "El mapa de negocios (webs agrupadas) y embudos web que mide la analítica, las páginas vistas en 90 días y los eventos registrados.",
      inputSchema: esquema({}),
      rutas: ["/admin/api/web/negocios"],
      run: async (_a, c) => llamar(c, "GET", "/admin/api/web/negocios"),
    },
    {
      name: "guardar_negocios_web", title: "Guardar negocios y embudos web", alcance: "completo", annotations: IDEMP,
      description: "Guarda el mapa COMPLETO de negocios y embudos web: negocios [{id, nombre, webs[]}] (hasta 20) y embudos [{id, negocio, nombre, objetivo registro|reserva|venta|otro, etapas[{nombre, tipo pagina|accion|externa, web, ruta, evento, confirma, url}]}] (hasta 50). "
        + "Sustituye lo anterior: lee negocios_web, modifica y manda todo.",
      inputSchema: esquema({ mapa: S.obj("{ negocios: [...], embudos: [...] }") }, ["mapa"]),
      rutas: ["/admin/api/web/negocios"],
      run: async (a, c) => llamar(c, "POST", "/admin/api/web/negocios", { mapa: a.mapa }),
    },
    {
      name: "codigo_pixel_web", title: "Código del píxel de analítica", alcance: "completo", annotations: IDEMP,
      description: "El fragmento HTML/JS que mide una web en el panel. Con registrar: true, además da de alta esa web (por nombre) en la analítica.",
      inputSchema: esquema({ nombre: S.txt("Nombre corto de la web (hasta 60). Por defecto mi-sitio."), registrar: S.bool("true = registrar la web en la analítica.") }),
      rutas: ["/admin/api/web/pixel-snippet"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/web/pixel-snippet" + qs({ name: str(a.nombre), reg: a.registrar === true ? "" : "0" })),
    },

    // ── Marca y utilidades ──
    {
      name: "cambiar_marca", title: "Nombre y logo del panel", alcance: "completo", annotations: IDEMP,
      description: "Cambia el nombre de marca del panel (vacío = el de fábrica), sube un logo (PNG/JPEG/WebP ≤512 KB en base64) o lo quita. Solo lo puede hacer un administrador.",
      inputSchema: esquema({ nombre: S.txt("Nuevo nombre (hasta 60); cadena vacía = el de fábrica."), logo_base64: S.txt("Logo en base64 (admite prefijo data:)."), logo_mime: S.en("Tipo del logo.", MIMES_LOGO), quitar_logo: S.bool("true = volver al logo de fábrica.") }),
      rutas: ["/admin/api/brand"],
      run: async (a, c) => {
        const out: Args = {};
        if (a.nombre !== undefined) { const r = await api(c, "POST", "/admin/api/brand/name", { name: str(a.nombre) }); out.nombre = r.status === 200 ? parse(r.texto) : { error: r.status, detalle: r.texto }; }
        if (str(a.logo_base64)) {
          const mime = str(a.logo_mime) || (String(a.logo_base64).match(/^data:([^;,]+)/)?.[1] ?? "image/png");
          if (!MIMES_LOGO.includes(mime)) return fallo("El logo debe ser image/png, image/jpeg o image/webp.");
          const r = await api(c, "POST", "/admin/api/brand/logo", { mime, dataB64: sinPrefijo(a.logo_base64) }); out.logo = r.status === 200 ? parse(r.texto) : { error: r.status, detalle: r.texto };
        } else if (a.quitar_logo === true) { const r = await api(c, "DELETE", "/admin/api/brand/logo"); out.logo = r.status === 200 ? parse(r.texto) : { error: r.status, detalle: r.texto }; }
        if (!Object.keys(out).length) return fallo("Pasa «nombre», «logo_base64» o quitar_logo: true.");
        return salida(out);
      },
    },
    {
      name: "vista_previa_enlace", title: "Vista previa de un enlace", alcance: "lectura", annotations: { ...LEE, openWorldHint: true },
      description: "Título, descripción e imagen (Open Graph) de una URL, como la enseñaría WhatsApp. ok: false si la página no da datos.",
      inputSchema: esquema({ url: S.txt("URL http/https.") }, ["url"]),
      rutas: ["/admin/api/og-preview"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/og-preview" + qs({ url: str(a.url) })),
    },
    {
      name: "tipos_de_cambio", title: "Tipos de cambio del día", alcance: "lectura", annotations: LEE,
      description: "Las tasas de cambio que usa el panel para convertir ingresos a la moneda base.",
      inputSchema: esquema({}),
      rutas: ["/admin/api/divisa"],
      run: async (_a, c) => llamar(c, "GET", "/admin/api/divisa"),
    },
  ];
}
