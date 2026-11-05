/** MCP-TOTAL-1 · Herramientas MCP de ANALÍTICA: tarjetas y detalle del Inicio, métricas y análisis de la cuenta
 *  de Instagram, los apartados de Métricas con todos sus filtros, las vistas avanzadas por red, atribución por
 *  periodo, recorridos (Instagram, LinkedIn, WhatsApp), web en vivo y registros de systeme.io, correos
 *  (estadísticas, ficha, automatizaciones, usos, atribución), preguntas a la analítica, exportación en JSON,
 *  registro de uso de IA y las utilidades de Formularios sin herramienta (dirección, vista previa, renombrar,
 *  borrar, medios, plantillas).
 *  Contratos: admin.ts (dashboard 9676-10598, metrics 17653-17760, analytics 17805-19700 y 21200,
 *  linkedin/origen 15559-15600, formularios 15206-15402, ai-compliance 4005).
 *  Fuera a propósito: dashboard/snapshot/manual (mantenimiento), analytics/sio-origin/diag, fb-cache-bust y
 *  fb-diag (diagnóstico), analytics/export y export.md (HTML y Markdown para descargar; export acepta ?ws= de
 *  otro negocio), metrics/export.csv y formularios/exportar (descargas vetadas por el servidor MCP). */
import { type Args, type Ctx, type Herramienta, type Kit, PAGINA, paginar, parse } from "./mcp-tipos.js";

const DIA = 86_400_000;
const CANALES_INICIO = ["todos", "whatsapp", "instagram", "facebook", "youtube", "web", "email"];
const FUENTES_INICIO = ["instagram", "facebook", "linkedin", "youtube", "tiktok", "google", "x", "email", "whatsapp", "web", "desconocido"];
const INICIOS_FLUJO = ["comentario", "peticion", "correo", "cita", "formulario"];
const FUNCIONES_FLUJO = ["vender", "agendar", "captar", "cualificar", "entregar", "conversar"];
const FUENTES_CAPTACION = ["organica", "pago", "identificar"];
const OBJETIVOS_CORREO = ["periodico", "promo", "reactivacion", "seguimiento", "operativo", "otro"];
const MIMES_FORMULARIO = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm"];
const METRICAS_DIARIAS = "contacts.total, contacts.in_human_mode, contacts.in_window, conversations.total, automations.total, ig.accounts, ig.automations_active, scheduled.pending, scheduled.published, sequences.total";

export function herramientas(k: Kit): Herramienta[] {
  const { S, esquema, llamar, api, fallo, str, lista, qs, msEnZona, dias, PERIODO, LEE, CAMBIA, BORRA, CONFIRMA } = k;
  const enc = encodeURIComponent;
  // Como APARTADOS en mcp-server: la analítica de anuncios se ofrece sólo si la edición la tiene.
  const sinAnuncios = k.rutaRetirada("/admin/api/meta-ads");
  const APARTADOS = ["overview", "leads", "whatsapp", "ig", "web", "automation", "content", "fbaporte", ...(sinAnuncios ? [] : ["ads"]), "all"];
  const REDES_PRO = ["facebook", "instagram", "youtube", ...(sinAnuncios ? [] : ["anuncios"])];
  const noConfirmado = (que: string) => fallo(que + " Confírmalo con el usuario y repite con confirmado_por_humano: true.");
  /** Un embudo sólo se aplica dentro de un negocio: webAmbitoQ lo descarta si no hay negocio ni comparación. */
  const embudoSinNegocio = (a: Args, cmp: boolean) => str(a.embudo_web).trim() !== "" && str(a.negocio_web).trim() === "" && !cmp;
  const AVISO_EMBUDO = "El embudo solo se aplica dentro de un negocio: pasa también negocio_web (o «auto» para el principal) o quita embudo_web.";
  const sinPrefijo = (v: unknown) => String(v || "").replace(/^data:[^,]*,/, "");
  /** Lee una ruta JSON; si falla devuelve la respuesta tal cual (con el error explicado). */
  const lee = async (c: Ctx, ruta: string) => {
    const r = await api(c, "GET", ruta);
    return r.status === 200 ? { json: (parse(r.texto) || {}) as Args } : { res: await llamar(c, "GET", ruta) };
  };
  /** Igual que lee, por POST (sólo para rutas que calculan o guardan de forma idempotente). */
  const envia = async (c: Ctx, ruta: string, cuerpo: unknown) => {
    const r = await api(c, "POST", ruta, cuerpo);
    return r.status === 200 ? { json: (parse(r.texto) || {}) as Args } : { res: await llamar(c, "POST", ruta, cuerpo) };
  };
  const salida = (o: unknown) => ({ texto: k.compactar(JSON.stringify(o)) });
  const conFechas = (a: Args) => a.desde !== undefined || a.hasta !== undefined;
  /** Periodo de Métricas (days + from/to opcionales): la query lista para pegar. */
  const qPeriodo = (a: Args, c: Ctx, def = 30): { q: Record<string, unknown> } | { error: string } => {
    if (!conFechas(a)) return { q: { days: dias(a, def) } as Record<string, unknown> };
    const p = k.periodo(a, c.zona);
    if ("error" in p) return { error: p.error };
    return { q: { from: p.from, to: p.to, days: Math.max(1, Math.round((p.to - p.from) / DIA)) } as Record<string, unknown> };
  };
  /** Periodo del Inicio (sólo from/to en milisegundos): sin fechas, los últimos N días. */
  const rango = (a: Args, c: Ctx, def = 30) => {
    if (conFechas(a)) return k.periodo(a, c.zona);
    const to = Date.now();
    return { from: to - dias(a, def) * DIA, to };
  };
  /** Resuelve un formulario por id, por dirección (slug) o por título (si es único). */
  const buscaFormulario = async (c: Ctx, ref: string) => {
    const r = await lee(c, "/admin/api/formularios");
    if (r.res) return { res: r.res };
    const forms = Array.isArray(r.json.forms) ? (r.json.forms as Args[]) : [];
    const q = ref.trim().toLowerCase();
    let f = q ? forms.find((x) => str(x.id) === ref.trim()) || forms.find((x) => str(x.slug).toLowerCase() === q) : undefined;
    if (!f && q) {
      const parecidos = forms.filter((x) => str(x.title).toLowerCase().includes(q));
      if (parecidos.length === 1) f = parecidos[0];
      else if (parecidos.length > 1) return { res: fallo("Hay " + parecidos.length + " formularios con ese título: " + parecidos.map((x) => str(x.title) + " (" + str(x.id) + ")").join(", ") + ". Pásame el id.") };
    }
    if (!f) return { res: fallo("No encuentro ese formulario. Pásame su id, su dirección o su título exacto (listar_formularios).") };
    return { form: f };
  };
  const idCorreo = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };

  return [
    // ── Inicio ──
    {
      name: "actividad_reciente", title: "Actividad reciente del Inicio", alcance: "lectura", annotations: LEE,
      description: "La actividad que enseña el Inicio: contactos nuevos, registros en la web y ventas del periodo (por defecto los últimos 30 días), de más reciente a más antiguo. Cada elemento trae tipo (contacto, registro o venta), fecha, canal y nombre; las ventas, además producto e importe.",
      inputSchema: esquema({ ...PERIODO, canal: S.en("Canal. Por defecto, todos.", CANALES_INICIO), limite: S.int("Cuántos elementos como máximo de cada tipo (10-200, 60 por defecto).", { minimum: 10, maximum: 200 }) }),
      run: async (a, c) => {
        const r = rango(a, c);
        if ("error" in r) return fallo(r.error);
        return llamar(c, "GET", "/admin/api/dashboard/feed" + qs({ from: r.from, to: r.to, canal: str(a.canal), limit: a.limite }));
      },
    },
    {
      name: "detalle_cifra_inicio", title: "Detalle de una cifra del Inicio", alcance: "lectura", annotations: LEE,
      description: "Las filas que hay detrás de una cifra del Inicio: los contactos nuevos (leads), las ventas o las citas reservadas en el periodo, con el mismo criterio que la tarjeta. Paginado. En ventas la lista es de UNA moneda: euros y dólares no se mezclan.",
      inputSchema: esquema({
        que: S.en("Qué cifra: leads (contactos nuevos), ventas o citas.", ["leads", "ventas", "citas"]),
        ...PERIODO,
        canal: S.en("Canal. Por defecto, todos.", CANALES_INICIO),
        fuente: S.en("Sólo en leads: la barra de «De dónde llegan tus contactos». Sin ella, todas.", FUENTES_INICIO),
        moneda: S.txt("Sólo en ventas: código de 3 letras (EUR, USD). Por defecto, la que enseña la tarjeta."),
        ...PAGINA,
      }, ["que"]),
      run: async (a, c) => {
        const r = rango(a, c);
        if ("error" in r) return fallo(r.error);
        const m = await lee(c, "/admin/api/dashboard/detalle" + qs({ from: r.from, to: r.to, que: str(a.que), canal: str(a.canal), fuente: str(a.fuente), moneda: str(a.moneda) }));
        if (m.res) return m.res;
        const filas = Array.isArray(m.json.filas) ? (m.json.filas as unknown[]) : [];
        return salida({ ...m.json, filas: paginar(filas, a) });
      },
    },
    {
      name: "campanas_whatsapp_periodo", title: "Difusiones de WhatsApp del periodo", alcance: "lectura", annotations: LEE,
      description: "La tarjeta «Campañas» del Inicio: las difusiones de WhatsApp enviadas en el periodo, con personas alcanzadas, aceptados, respuestas, clics en el enlace y compradores, y las mejores ordenadas. Con comparar: true, además el periodo anterior de la misma duración.",
      inputSchema: esquema({ ...PERIODO, comparar: S.bool("true = añadir el periodo anterior de la misma duración para ver la diferencia.") }),
      run: async (a, c) => {
        const r = rango(a, c);
        if ("error" in r) return fallo(r.error);
        const prev = a.comparar === true ? { pfrom: r.from - (r.to - r.from), pto: r.from - 1 } : {};
        return llamar(c, "GET", "/admin/api/dashboard/campanas" + qs({ from: r.from, to: r.to, ...prev }));
      },
    },
    {
      name: "que_esta_funcionando", title: "Qué está funcionando", alcance: "lectura", annotations: LEE,
      description: "La tarjeta «Qué está funcionando» del Inicio: la pieza (recorrido automático o difusión) con resultado demostrado en el periodo, medida igual que en Métricas › Automatización y WhatsApp.",
      inputSchema: esquema({ ...PERIODO }),
      run: async (a, c) => {
        const r = rango(a, c);
        if ("error" in r) return fallo(r.error);
        return llamar(c, "GET", "/admin/api/dashboard/funciona" + qs({ from: r.from, to: r.to }));
      },
    },
    {
      name: "evolucion_metrica_diaria", title: "Evolución diaria de una cifra", alcance: "lectura", annotations: LEE,
      description: "La serie diaria (una cifra por día, de la más antigua a la más reciente) que dibujan las líneas pequeñas del Inicio. Métricas fijas: " + METRICAS_DIARIAS + ". Seguidores por cuenta: ig_followers_<id de la cuenta de Instagram>, fb_followers_<id de la Página>, li_followers_<id de la organización de LinkedIn>. Un día sin foto guardada vale 0.",
      inputSchema: esquema({ metrica: S.txt("Nombre de la métrica (ver la descripción)."), dias: S.int("Cuántos días (1-400, 14 por defecto).", { minimum: 1, maximum: 400 }) }, ["metrica"]),
      run: async (a, c) => {
        const m = str(a.metrica).trim();
        if (!/^[a-z0-9_.-]{1,80}$/i.test(m)) return fallo("La métrica no es válida: usa uno de los nombres de la descripción.");
        return llamar(c, "GET", "/admin/api/dashboard/sparkline/" + enc(m) + qs({ days: dias(a, 14) }));
      },
    },

    // ── Cuenta de Instagram ──
    {
      name: "metricas_instagram", title: "Métricas de la cuenta de Instagram", alcance: "lectura", annotations: LEE,
      description: "La cuenta de Instagram tal y como la ve Métricas: seguidores, alcance, visitas al perfil, toques de contacto y las 12 publicaciones con más interacción. Con series: true, además la evolución de seguidores y los mejores días y horas para publicar. Ojo: «toques de contacto» no es el enlace de la bio, y una métrica ausente no es 0 (Instagram no la da para esa cuenta o periodo). Si la cuenta indicada no es del negocio, se devuelve la principal sin avisar.",
      inputSchema: esquema({ cuenta: S.txt("Id de la cuenta de Instagram (estado_conexiones). Por defecto, la principal."), series: S.bool("true = añadir la evolución de seguidores y los mejores momentos para publicar.") }),
      run: async (a, c) => {
        const q = qs({ ig_id: str(a.cuenta) });
        const m = await lee(c, "/admin/api/metrics" + q);
        if (m.res) return m.res;
        if (a.series !== true) return salida(m.json);
        const x = await api(c, "GET", "/admin/api/metrics/extra" + q);
        return salida({ ...m.json, extra: x.status === 200 ? parse(x.texto) : { error: x.texto } });
      },
    },
    {
      name: "analizar_instagram", title: "Análisis con IA de la cuenta de Instagram", alcance: "lectura", annotations: LEE,
      description: "El análisis en texto que escribe la IA del panel sobre la cuenta de Instagram (qué funciona y qué cambiar). Tarda varios segundos y gasta una llamada de IA. El texto viene en «analysis»; si viene vacío, «error» dice por qué.",
      inputSchema: esquema({ cuenta: S.txt("Id de la cuenta de Instagram. Por defecto, la principal.") }),
      run: async (a, c) => llamar(c, "GET", "/admin/api/metrics/analysis" + qs({ ig_id: str(a.cuenta) })),
    },

    // ── Métricas: apartados con filtros y vistas avanzadas ──
    {
      name: "analitica_detalle", title: "Analítica de un apartado con filtros", alcance: "lectura", annotations: LEE,
      description: "Lo mismo que «analitica», con los filtros que tiene cada apartado de Métricas. ig: cuenta_instagram, con las horas en la zona del negocio. whatsapp: numero_whatsapp (uno o varios separados por comas; tienen que ser del negocio). web: sitio, canal_web, fuente_web, campana_web, dispositivo, pais, ruta_web, negocio_web, embudo_web y comparar_negocios. automation: ambito_automatizacion, inicio, funcion y fuente_captacion. ads: cuenta_anuncios. fbaporte: lo que Facebook trajo al negocio. «all» devuelve todos los apartados a la vez (respuesta muy larga).",
      inputSchema: esquema({
        apartado: S.en("Qué apartado.", APARTADOS),
        ...PERIODO,
        cuenta_instagram: S.txt("Apartado ig: id de la cuenta de Instagram. Por defecto, la principal."),
        numero_whatsapp: S.txt("Apartado whatsapp: id del número (o varios separados por comas)."),
        cuenta_anuncios: S.txt("Apartado ads: id de la cuenta publicitaria (act_...)."),
        sitio: S.txt("Apartado web: id de la web medida (negocios_web)."),
        canal_web: S.txt("Apartado web: canal exacto, tal y como lo enseña la vista (p. ej. social, search, direct)."),
        fuente_web: S.txt("Apartado web: fuente exacta (utm_source)."),
        campana_web: S.txt("Apartado web: campaña exacta (utm_campaign)."),
        dispositivo: S.txt("Apartado web: dispositivo exacto (mobile, desktop, tablet)."),
        pais: S.txt("Apartado web: país exacto, tal y como lo enseña la vista."),
        ruta_web: S.txt("Apartado web: ruta exacta de la página (p. ej. /gracias)."),
        negocio_web: S.txt("Apartado web: negocio de systeme.io (negocios_web). «auto» = el principal."),
        embudo_web: S.txt("Apartado web: embudo dentro de ese negocio (embudos_web)."),
        comparar_negocios: S.bool("Apartado web: true = comparar todos los negocios entre sí."),
        ambito_automatizacion: S.txt("Apartado automation: wa, ig, fb, yt, email, o canal:idDeLaCuenta."),
        inicio: S.en("Apartado automation: cómo arrancan los flujos.", INICIOS_FLUJO),
        funcion: S.en("Apartado automation: para qué sirven.", FUNCIONES_FLUJO),
        fuente_captacion: S.en("Apartado automation: de dónde viene la gente.", FUENTES_CAPTACION),
      }, ["apartado"]),
      run: async (a, c) => {
        const seg = str(a.apartado) || "overview";
        if (!APARTADOS.includes(seg)) return fallo("Apartado desconocido. Usa uno de: " + APARTADOS.join(", ") + ".");
        if (seg === "web" && embudoSinNegocio(a, a.comparar_negocios === true)) return fallo(AVISO_EMBUDO);
        const p = qPeriodo(a, c);
        if ("error" in p) return fallo(p.error);
        const q: Record<string, unknown> = { ...p.q };
        if (seg === "ig") { q.ig_id = str(a.cuenta_instagram); q.tz = c.zona; }
        if (seg === "whatsapp") q.wa_phone = str(a.numero_whatsapp);
        if (seg === "ads") q.act_id = str(a.cuenta_anuncios);
        if (seg === "web") Object.assign(q, {
          site_id: str(a.sitio), ch: str(a.canal_web), src: str(a.fuente_web), camp: str(a.campana_web), dev: str(a.dispositivo), geo: str(a.pais), pa: str(a.ruta_web),
          biz: str(a.negocio_web), fun: str(a.embudo_web), ...(a.comparar_negocios === true ? { cmp: 1 } : {}),
        });
        if (seg === "automation") Object.assign(q, { auto_scope: str(a.ambito_automatizacion), auto_inicio: str(a.inicio), auto_funcion: str(a.funcion), auto_fuente: str(a.fuente_captacion) });
        const ruta = seg === "overview" ? "/admin/api/analytics/overview" : "/admin/api/analytics/" + enc(seg);
        return llamar(c, "GET", ruta + qs(q));
      },
    },
    {
      name: "analitica_avanzada_red", title: "Analítica avanzada de una red", alcance: "lectura", annotations: LEE,
      description: "Las tarjetas avanzadas de Métricas para una red: facebook (una Página), instagram (una cuenta, con la audiencia conectada por hora en la zona del negocio), youtube (un canal) y anuncios (una cuenta publicitaria de Meta). En instagram y youtube el periodo sólo admite «dias»: las fechas se ignoran. Si la red no está conectada o la cuenta no es del negocio, devuelve configured: false con el aviso.",
      inputSchema: esquema({ red: S.en("Red.", REDES_PRO), cuenta: S.txt("Id de la cuenta en esa red: Página de Facebook, cuenta de Instagram, canal de YouTube o cuenta publicitaria (act_...). Por defecto, la principal."), ...PERIODO }, ["red"]),
      run: async (a, c) => {
        const red = str(a.red);
        if (!REDES_PRO.includes(red)) return fallo("Red desconocida. Usa una de: " + REDES_PRO.join(", ") + ".");
        const cuenta = str(a.cuenta);
        if (red === "instagram") return llamar(c, "GET", "/admin/api/analytics/instagram-pro" + qs({ days: dias(a), ig_id: cuenta, tz: c.zona }));
        if (red === "youtube") return llamar(c, "GET", "/admin/api/analytics/youtube-pro" + qs({ days: dias(a), yt_channel: cuenta }));
        const p = qPeriodo(a, c);
        if ("error" in p) return fallo(p.error);
        if (red === "facebook") return llamar(c, "GET", "/admin/api/analytics/facebook-pro" + qs({ ...p.q, fb_page: cuenta }));
        return llamar(c, "GET", "/admin/api/analytics/ads-pro" + qs({ ...p.q, act_id: cuenta }));
      },
    },

    // ── Origen y recorridos ──
    {
      name: "atribucion_periodo", title: "Origen de los contactos por periodo", alcance: "lectura", annotations: LEE,
      description: "Lo mismo que «atribucion» pero con fechas exactas: de qué plataforma, campaña y contenido vienen los contactos creados en el periodo, con el periodo anterior para comparar y la serie diaria (fechas en UTC).",
      inputSchema: esquema({ ...PERIODO }),
      run: async (a, c) => {
        const p = qPeriodo(a, c);
        if ("error" in p) return fallo(p.error);
        return llamar(c, "GET", "/admin/api/analytics/attribution" + qs(p.q));
      },
    },
    {
      name: "que_ayudo_a_cerrar", title: "Qué ayudó a cerrar", alcance: "lectura", annotations: LEE,
      description: "Métricas › Origen › «Qué ayudó a cerrar»: de los contactos que compraron o reservaron en el periodo, por qué origen llegaron y qué piezas tocaron antes de cerrar.",
      inputSchema: esquema({ ...PERIODO }),
      run: async (a, c) => {
        const p = qPeriodo(a, c);
        if ("error" in p) return fallo(p.error);
        return llamar(c, "GET", "/admin/api/analytics/origen/cierre" + qs(p.q));
      },
    },
    {
      name: "recorrido_instagram", title: "Recorrido desde Instagram", alcance: "lectura", annotations: LEE,
      description: "Métricas › Instagram › recorrido: por cada publicación o story con flujo de comentario o de respuesta, cuántos comentaron o respondieron, cuántos pasaron a privado, cuántos dejaron contacto y cuántos compraron, en el periodo. Con tipo y pieza, el detalle de una sola publicación (comentario) o story.",
      inputSchema: esquema({ ...PERIODO, cuenta: S.txt("Id de la cuenta de Instagram. Por defecto, la principal."), tipo: S.en("Para ver una pieza concreta.", ["comentario", "story"]), pieza: S.txt("Con tipo: id de la publicación o de la story.") }),
      run: async (a, c) => {
        const r = rango(a, c);
        if ("error" in r) return fallo(r.error);
        return llamar(c, "GET", "/admin/api/analytics/ig-recorrido" + qs({ from: r.from, to: r.to, ig_id: str(a.cuenta), tipo: str(a.tipo), media: str(a.pieza) }));
      },
    },
    {
      name: "contactos_desde_instagram", title: "Contactos que llegaron por Instagram", alcance: "lectura", annotations: LEE,
      description: "Métricas › Instagram › «De qué publicación viene cada contacto»: los contactos creados en el periodo que llegaron por Instagram, agrupados por la publicación o el flujo que los trajo.",
      inputSchema: esquema({ ...PERIODO, cuenta: S.txt("Id de la cuenta de Instagram. Por defecto, la principal.") }),
      run: async (a, c) => {
        const r = rango(a, c);
        if ("error" in r) return fallo(r.error);
        return llamar(c, "GET", "/admin/api/analytics/ig-contactos" + qs({ from: r.from, to: r.to, ig_id: str(a.cuenta) }));
      },
    },
    {
      name: "recorrido_linkedin", title: "Recorrido desde LinkedIn", alcance: "lectura", annotations: LEE,
      description: "Métricas › LinkedIn: qué trajo LinkedIn al negocio en el periodo (visitas que llegaron desde LinkedIn, contactos y ventas), publicación a publicación cuando se puede atar.",
      inputSchema: esquema({ ...PERIODO }),
      run: async (a, c) => {
        const p = qPeriodo(a, c);
        if ("error" in p) return fallo(p.error);
        return llamar(c, "GET", "/admin/api/analytics/linkedin/recorrido" + qs(p.q));
      },
    },
    {
      name: "seguimiento_flujo_whatsapp", title: "Seguimiento de un flujo de WhatsApp", alcance: "lectura", annotations: LEE,
      description: "Métricas › WhatsApp › seguimiento: cuántos entraron en un flujo en el periodo y cuántos llegaron a cada etapa (cada espera suma una etapa), con la ventana de 7 días para contar respuestas, compras, reservas y clics. Sin flujo, el de diagnóstico o el que más entradas tuvo. La respuesta lista los flujos con entradas y los valores válidos de entrada y campana para filtrar.",
      inputSchema: esquema({ ...PERIODO, flujo: S.txt("Id del flujo (listar_flujos)."), entrada: S.txt("Filtrar por cómo entraron: uno de los valores que devuelve «entradas»."), campana: S.txt("Filtrar por campaña: uno de los valores que devuelve «campanas».") }),
      run: async (a, c) => {
        const p = qPeriodo(a, c);
        if ("error" in p) return fallo(p.error);
        return llamar(c, "GET", "/admin/api/analytics/whatsapp/seguimiento" + qs({ ...p.q, flow: str(a.flujo), entrada: str(a.entrada), campana: str(a.campana) }));
      },
    },

    // ── Web ──
    {
      name: "web_en_vivo", title: "Web en vivo", alcance: "lectura", annotations: LEE,
      description: "Quién está ahora mismo en la web medida con el píxel (últimos 30 minutos): visitantes activos, páginas y de dónde vienen. Se puede acotar a una web, a un negocio de systeme.io o a un embudo.",
      inputSchema: esquema({ sitio: S.txt("Id de la web medida (negocios_web)."), negocio_web: S.txt("Negocio de systeme.io. «auto» = el principal."), embudo_web: S.txt("Embudo dentro de ese negocio.") }),
      run: async (a, c) => {
        if (embudoSinNegocio(a, false)) return fallo(AVISO_EMBUDO);
        return llamar(c, "GET", "/admin/api/analytics/web-live" + qs({ site_id: str(a.sitio), biz: str(a.negocio_web), fun: str(a.embudo_web) }));
      },
    },
    {
      name: "origen_registros_web", title: "Origen de los registros de la web", alcance: "lectura", annotations: LEE,
      description: "Métricas › Web › registros de systeme.io: de dónde vienen las personas que se registraron en la web en el periodo (celdas por plataforma y campaña, páginas de entrada y estadísticas) y la lista de registros, paginada. Sólo con cuentas de systeme.io con clave API; la respuesta lista las cuentas. Si faltan registros recientes, sincronizar_registros_web.",
      inputSchema: esquema({ ...PERIODO, cuenta: S.txt("Id de la cuenta de systeme.io (la respuesta las lista). Por defecto, la primera con clave API."), ...PAGINA }),
      run: async (a, c) => {
        const p = qPeriodo(a, c);
        if ("error" in p) return fallo(p.error);
        const m = await lee(c, "/admin/api/analytics/sio-origin" + qs({ ...p.q, si_acc: str(a.cuenta) }));
        if (m.res) return m.res;
        const leads = Array.isArray(m.json.leads) ? (m.json.leads as unknown[]) : [];
        return salida({ ...m.json, leads: paginar(leads, a) });
      },
    },
    {
      name: "sincronizar_registros_web", title: "Traer los registros y ventas de systeme.io", alcance: "completo", annotations: CAMBIA,
      description: "Pide a systeme.io los registros y las ventas más recientes de una cuenta y los guarda en el panel (el botón «Sincronizar» de Métricas › Web). No envía nada a nadie: sólo lee de systeme.io. Puede tardar un rato.",
      inputSchema: esquema({ cuenta: S.txt("Id de la cuenta de systeme.io con clave API (origen_registros_web las lista).") }, ["cuenta"]),
      run: async (a, c) => {
        const cuenta = str(a.cuenta).trim();
        if (!cuenta) return fallo("Falta la cuenta de systeme.io (origen_registros_web las lista).");
        return llamar(c, "POST", "/admin/api/analytics/sio-origin/sync", { si_acc: cuenta });
      },
    },

    // ── Correo ──
    {
      name: "estadisticas_correos", title: "Estadísticas de los correos enviados", alcance: "lectura", annotations: LEE,
      description: "Métricas › Correo: envíos, aperturas, clics y bajas de los correos de systeme.io en el periodo, con el resumen y la lista de correos (paginada). Sin cuenta, el agregado de todas; con varias separadas por comas, el agregado de esas. completo: true pide la lista entera del periodo en vez de los ~100 más recientes (tarda más).",
      inputSchema: esquema({ ...PERIODO, cuentas: S.txt("Id de una cuenta de systeme.io, varios separados por comas, o «all». Por defecto, todas."), completo: S.bool("true = la lista completa del periodo."), ...PAGINA }),
      run: async (a, c) => {
        const p = qPeriodo(a, c);
        if ("error" in p) return fallo(p.error);
        const m = await lee(c, "/admin/api/analytics/email" + qs({ ...p.q, si_acc: str(a.cuentas), ...(a.completo === true ? { full: 1 } : {}) }));
        if (m.res) return m.res;
        const emails = Array.isArray(m.json.emails) ? (m.json.emails as unknown[]) : [];
        return salida({ ...m.json, emails: paginar(emails, a) });
      },
    },
    {
      name: "ficha_correo", title: "Ficha de un correo", alcance: "lectura", annotations: LEE,
      description: "El detalle de un correo de systeme.io: contenido y cifras (parte content, rápida) y destinatarios y recorrido por el puente (parte bridge, lenta: decenas de segundos). Sin parte, las dos. El id del correo sale en estadisticas_correos.",
      inputSchema: esquema({
        correo: S.int("Id numérico del correo."),
        cuenta: S.txt("Id de la cuenta de systeme.io. Por defecto, la primera."),
        asunto: S.txt("Pista con el asunto, por si el id no basta para localizarlo."),
        tipo: S.txt("Tipo de correo si se sabe: newsletter, automation o campaign."),
        enviado: S.fecha("Fecha de envío, si se sabe (ayuda a localizarlo)."),
        parte: S.en("Qué parte pedir. Sin ella, todas.", ["content", "recipients", "bridge"]),
      }, ["correo"]),
      run: async (a, c) => {
        const id = idCorreo(a.correo);
        if (!id) return fallo("Falta el id del correo (estadisticas_correos lo da).");
        const env = a.enviado !== undefined ? msEnZona(a.enviado, c.zona) : null;
        if (a.enviado !== undefined && env === null) return fallo("«enviado» no es una fecha válida (usa 2026-09-30).");
        return llamar(c, "GET", "/admin/api/analytics/email/mailing" + qs({ mailing_id: id, si_acc: str(a.cuenta), subject: str(a.asunto), etype: str(a.tipo), scheduled: env ? new Date(env).toISOString() : "", part: str(a.parte) }));
      },
    },
    {
      name: "mapa_automatizaciones_correo", title: "Automatizaciones de correo", alcance: "lectura", annotations: LEE,
      description: "Las automatizaciones (workflows) y campañas de correo de una cuenta de systeme.io con los asuntos de sus correos: el mapa que usa Métricas › Correo para saber de dónde sale cada envío. Puede tardar.",
      inputSchema: esquema({ cuenta: S.txt("Id de la cuenta de systeme.io. Por defecto, la primera.") }),
      run: async (a, c) => llamar(c, "GET", "/admin/api/analytics/email/workflows" + qs({ si_acc: str(a.cuenta) })),
    },
    {
      name: "usos_de_correos", title: "Para qué sirve cada correo", alcance: "lectura", annotations: LEE,
      description: "La clasificación que el equipo ha dado a cada correo enviado (objetivo «o» y audiencia «a»), tal y como la usa Métricas › Correo. Para cambiarla, clasificar_correo.",
      inputSchema: esquema({}),
      run: async (_a, c) => llamar(c, "GET", "/admin/api/analytics/email/usos"),
    },
    {
      name: "clasificar_correo", title: "Clasificar un correo", alcance: "completo", annotations: CAMBIA,
      description: "Guarda para qué sirvió un correo enviado: objetivo (periodico, promo, reactivacion, seguimiento, operativo u otro) y audiencia (texto corto). Se guardan los dos a la vez: pasa siempre objetivo y audiencia; sin ninguno de los dos, se quita la clasificación.",
      inputSchema: esquema({ correo: S.int("Id numérico del correo (estadisticas_correos)."), cuenta: S.txt("Id de la cuenta de systeme.io a la que pertenece (debe ser del negocio)."), objetivo: S.en("Objetivo del correo.", OBJETIVOS_CORREO), audiencia: S.txt("A quién iba (hasta 80 caracteres).") }, ["correo"]),
      run: async (a, c) => {
        const id = idCorreo(a.correo);
        if (!id) return fallo("Falta el id del correo (estadisticas_correos lo da).");
        return llamar(c, "POST", "/admin/api/analytics/email/uso", { mailingId: id, cuenta: str(a.cuenta), objetivo: str(a.objetivo), audiencia: str(a.audiencia) });
      },
    },
    {
      name: "atribucion_correo", title: "Qué consiguió un correo", alcance: "lectura", annotations: LEE,
      description: "Para un correo enviado: cuántos destinatarios pulsaron, reservaron cita, compraron o volvieron a la web en los días siguientes (la ventana viene en «ventanaDias»). Hace falta la fecha de envío. Si devuelve cargando: true, los datos se están calculando: repite al cabo de unos segundos.",
      inputSchema: esquema({ correo: S.int("Id numérico del correo."), enviado: S.fecha("Fecha y hora de envío (estadisticas_correos la da)."), cuenta: S.txt("Id de la cuenta de systeme.io. Por defecto, la primera.") }, ["correo", "enviado"]),
      run: async (a, c) => {
        const id = idCorreo(a.correo);
        if (!id) return fallo("Falta el id del correo (estadisticas_correos lo da).");
        const env = msEnZona(a.enviado, c.zona);
        if (env === null) return fallo("«enviado» no es una fecha válida (usa 2026-09-30T10:00).");
        return llamar(c, "GET", "/admin/api/analytics/email/atribucion" + qs({ mailing_id: id, scheduled_at: env, si_acc: str(a.cuenta) }));
      },
    },

    // ── Preguntar, exportar y registro de IA ──
    {
      name: "preguntar_a_la_analitica", title: "Preguntar a la analítica", alcance: "lectura", annotations: LEE,
      description: "Hace una pregunta en lenguaje natural sobre las métricas del periodo y la IA del panel responde con los datos delante (el botón «Analizar» de Métricas). Gasta una llamada de IA y tarda varios segundos. No cambia nada.",
      inputSchema: esquema({ pregunta: S.txt("Qué quieres saber."), ...PERIODO, cuenta_instagram: S.txt("Id de la cuenta de Instagram sobre la que razonar. Por defecto, la principal.") }, ["pregunta"]),
      run: async (a, c) => {
        const pregunta = str(a.pregunta).trim();
        if (!pregunta) return fallo("Escribe la pregunta.");
        const p = qPeriodo(a, c);
        if ("error" in p) return fallo(p.error);
        return llamar(c, "POST", "/admin/api/analytics/reason" + qs({ ig_id: str(a.cuenta_instagram) }), { ...p.q, question: pregunta });
      },
    },
    {
      name: "exportar_analitica", title: "Exportar toda la analítica (JSON)", alcance: "lectura", annotations: LEE,
      description: "El paquete completo de Métricas del periodo en JSON, con el nombre del negocio: lo que el panel descarga para analizarlo con otra IA. Es MUY largo: pide sólo las claves que necesites con «campos» (overview, leads, whatsapp, ig, web, automation, content, ads, facebookAporte, negocio).",
      inputSchema: esquema({
        ...PERIODO,
        campos: S.lista("Claves de primer nivel que quieres recibir (admite rutas con punto, p. ej. overview.totals). Sin ellas, todo."),
        cuenta_instagram: S.txt("Id de la cuenta de Instagram."),
        numero_whatsapp: S.txt("Id del número de WhatsApp."),
        pagina_facebook: S.txt("Id de la Página de Facebook."),
        negocio_web: S.txt("Negocio de systeme.io para el apartado web."),
        embudo_web: S.txt("Embudo de ese negocio."),
        comparar_negocios: S.bool("true = comparar los negocios de la web entre sí."),
      }),
      run: async (a, c) => {
        const p = qPeriodo(a, c);
        if ("error" in p) return fallo(p.error);
        if (embudoSinNegocio(a, a.comparar_negocios === true)) return fallo(AVISO_EMBUDO);
        const q = qs({ ...p.q, ig_id: str(a.cuenta_instagram), wa_phone: str(a.numero_whatsapp), fb_page: str(a.pagina_facebook), biz: str(a.negocio_web), fun: str(a.embudo_web), ...(a.comparar_negocios === true ? { cmp: 1 } : {}) });
        return llamar(c, "GET", "/admin/api/analytics/export.json" + q, undefined, undefined, lista(a.campos));
      },
    },
    {
      name: "registro_uso_ia", title: "Registro de uso de la IA", alcance: "lectura", annotations: LEE,
      description: "El registro de las conversaciones recientes en las que intervino la IA, con los datos que Ajustes exporta para cumplir la normativa de IA (qué hizo la IA en cada conversación y cuándo). Hasta 5.000 conversaciones, paginadas.",
      inputSchema: esquema({ ...PAGINA }),
      run: async (a, c) => {
        const m = await lee(c, "/admin/api/ai-compliance/export.json");
        if (m.res) return m.res;
        const records = Array.isArray(m.json.records) ? (m.json.records as unknown[]) : [];
        return salida({ exportado: m.json.exportedAt, registros: paginar(records, a) });
      },
    },

    // ── Formularios: utilidades sin herramienta ──
    {
      name: "comprobar_direccion_formulario", title: "Comprobar la dirección de un formulario", alcance: "lectura", annotations: LEE,
      description: "¿Está libre esta dirección (la parte final del enlace /f/...) para un formulario? Es única en toda la plataforma. Devuelve la dirección normalizada, si está libre y, si no, una sugerencia.",
      inputSchema: esquema({ direccion: S.txt("Dirección deseada (se normaliza a minúsculas y guiones)."), formulario: S.txt("Id del formulario que se está editando, para no chocar consigo mismo.") }, ["direccion"]),
      rutas: ["/admin/api/formularios/direccion"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/formularios/direccion" + qs({ s: str(a.direccion), id: str(a.formulario) })),
    },
    {
      name: "vista_previa_formulario", title: "Vista previa de un formulario", alcance: "lectura", annotations: LEE,
      description: "Pinta un formulario sin guardarlo (título, intro, preguntas y opciones, con los mismos campos que guardar_formulario) y dice lo primero que falte en «aviso». inicio abre la vista previa en esa pregunta. Devuelve el HTML completo sólo con con_html: true; sin él, su longitud y el aviso. No guarda nada.",
      inputSchema: esquema({
        titulo: S.txt("Título del formulario."),
        intro: S.txt("Texto de introducción."),
        preguntas: { type: "array", items: { type: "object" }, description: "Preguntas, con la misma forma que en guardar_formulario." },
        opciones: S.obj("Opciones de diseño y comportamiento (las de guardar_formulario)."),
        inicio: S.int("Número de la pregunta donde abre la vista previa (0 = la primera). Sin él, abre en la bienvenida.", { minimum: 0 }),
        con_html: S.bool("true = devolver el HTML entero."),
      }),
      rutas: ["/admin/api/formularios/vista-previa"],
      run: async (a, c) => {
        const cuerpo: Args = {
          title: str(a.titulo), intro: str(a.intro),
          questions: Array.isArray(a.preguntas) ? a.preguntas : [],
          opts: a.opciones && typeof a.opciones === "object" ? a.opciones : {},
        };
        if (a.inicio !== undefined && a.inicio !== null) {
          if (!Number.isInteger(a.inicio) || (a.inicio as number) < 0) return fallo("inicio es un número: la pregunta donde abre la vista previa (0 = la primera). No admite una pantalla de inicio.");
          cuerpo.inicio = a.inicio;
        }
        const m = await envia(c, "/admin/api/formularios/vista-previa", cuerpo);
        if (m.res) return m.res;
        const html = str(m.json.html);
        return salida({ ok: m.json.ok, aviso: str(m.json.aviso), barra: m.json.barra, html_caracteres: html.length, ...(a.con_html === true ? { html } : {}) });
      },
    },
    {
      name: "renombrar_formulario", title: "Renombrar un formulario", alcance: "completo", annotations: CAMBIA,
      description: "Cambia sólo el título de un formulario (hasta 200 caracteres). El resto no se toca.",
      inputSchema: esquema({ formulario: S.txt("Id, dirección o título del formulario."), titulo: S.txt("Título nuevo.") }, ["formulario", "titulo"]),
      rutas: ["/admin/api/formularios/renombrar"],
      run: async (a, c) => {
        const titulo = str(a.titulo).trim();
        if (!titulo) return fallo("Ponle un título al formulario.");
        const f = await buscaFormulario(c, str(a.formulario));
        if (f.res) return f.res;
        return llamar(c, "POST", "/admin/api/formularios/renombrar", { id: str(f.form.id), title: titulo });
      },
    },
    {
      name: "borrar_formulario", title: "Borrar un formulario", alcance: "completo", annotations: BORRA,
      description: "Borra un formulario del todo, con sus respuestas. No se puede deshacer: pide confirmación al usuario.",
      inputSchema: esquema({ formulario: S.txt("Id, dirección o título del formulario."), ...CONFIRMA }, ["formulario"]),
      rutas: ["/admin/api/formularios/borrar"],
      run: async (a, c) => {
        const f = await buscaFormulario(c, str(a.formulario));
        if (f.res) return f.res;
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar «" + str(f.form.title) + "» elimina el formulario y sus respuestas para siempre.");
        return llamar(c, "POST", "/admin/api/formularios/borrar", { id: str(f.form.id) }, true);
      },
    },
    {
      name: "subir_medio_formulario", title: "Subir una foto o un vídeo para un formulario", alcance: "completo", annotations: CAMBIA,
      description: "Sube una imagen (JPG, PNG, WebP o GIF, hasta 8 MB) o un vídeo (MP4 o WebM, hasta 25 MB) para usarlo en un formulario (fondo, pantalla de inicio o página propia). Devuelve la dirección del archivo (/f/m/...) para ponerla en las opciones con guardar_formulario.",
      inputSchema: esquema({ tipo: S.en("Tipo del archivo.", MIMES_FORMULARIO), archivo_base64: S.txt("El archivo en base64 (con o sin el prefijo data:...).") }, ["tipo", "archivo_base64"]),
      rutas: ["/admin/api/formularios/medio"],
      run: async (a, c) => {
        const mime = str(a.tipo).toLowerCase().trim();
        if (!MIMES_FORMULARIO.includes(mime)) return fallo("Tipo no admitido. Usa uno de: " + MIMES_FORMULARIO.join(", ") + ".");
        const datos = sinPrefijo(a.archivo_base64).trim();
        if (!datos) return fallo("El archivo ha llegado vacío.");
        return llamar(c, "POST", "/admin/api/formularios/medio", { mime, dataB64: datos });
      },
    },
    {
      name: "plantillas_formulario", title: "Plantillas de página propia de Formularios", alcance: "lectura", annotations: LEE,
      description: "Las plantillas guardadas para la página propia (HTML) de los formularios: id, nombre y fecha. Con con_html: true, también el HTML de cada una. Para crear, cambiar o borrar una, gestionar_plantilla_formulario.",
      inputSchema: esquema({ con_html: S.bool("true = incluir el HTML de cada plantilla."), ...PAGINA }),
      rutas: ["/admin/api/formularios/plantillas"],
      run: async (a, c) => {
        const m = await lee(c, "/admin/api/formularios");
        if (m.res) return m.res;
        const todas = Array.isArray(m.json.plantillas) ? (m.json.plantillas as Args[]) : [];
        const items = a.con_html === true ? todas : todas.map((p) => ({ id: p.id, nombre: p.nombre, actualizada: p.upd, html_caracteres: str(p.html).length }));
        return salida(paginar(items, a));
      },
    },
    {
      name: "gestionar_plantilla_formulario", title: "Guardar o borrar una plantilla de Formularios", alcance: "completo", annotations: BORRA,
      description: "guardar: crea una plantilla de página propia (nombre hasta 60 caracteres + HTML) o la sustituye si das su id (si no existe, se rechaza) o repites el nombre. borrar: la elimina (pide confirmación). Borrar una plantilla no toca los formularios que ya la usaron.",
      inputSchema: esquema({
        accion: S.en("Qué hacer.", ["guardar", "borrar"]),
        id: S.txt("Id de la plantilla (plantillas_formulario). Obligatorio para borrar; al guardar, sustituye esa (si no existe, se rechaza)."),
        nombre: S.txt("Al guardar: nombre de la plantilla."),
        html: S.txt("Al guardar: el HTML de la página."),
        ...CONFIRMA,
      }, ["accion"]),
      rutas: ["/admin/api/formularios/plantillas"],
      run: async (a, c) => {
        const accion = str(a.accion);
        const id = str(a.id).trim();
        if (accion === "borrar") {
          if (!id) return fallo("Falta el id de la plantilla (plantillas_formulario).");
          if (a.confirmado_por_humano !== true) return noConfirmado("Borrar la plantilla " + id + " no se puede deshacer.");
          const m = await envia(c, "/admin/api/formularios/plantillas", { accion: "borrar", id });
          if (m.res) return m.res;
          const quedan = Array.isArray(m.json.plantillas) ? (m.json.plantillas as Args[]) : [];
          return salida({ ok: true, borrada: id, quedan: quedan.map((p) => ({ id: p.id, nombre: p.nombre })) });
        }
        if (accion !== "guardar") return fallo("Acción desconocida: usa guardar o borrar.");
        const nombre = str(a.nombre).trim();
        const html = str(a.html);
        if (!nombre) return fallo("Ponle un nombre a la plantilla.");
        if (!html.trim()) return fallo("La página está vacía: pasa el HTML.");
        if (id) {
          const r = await lee(c, "/admin/api/formularios");
          if (r.res) return r.res;
          const existentes = Array.isArray(r.json.plantillas) ? (r.json.plantillas as Args[]) : [];
          if (!existentes.some((p) => str(p.id) === id)) return fallo("No existe ninguna plantilla con id " + id + ", así que no la sustituyo ni creo otra. Mira plantillas_formulario; para crear una nueva, quita id.");
        }
        const m = await envia(c, "/admin/api/formularios/plantillas", { ...(id ? { id } : {}), nombre, html });
        if (m.res) return m.res;
        const p = (m.json.plantilla || {}) as Args;
        const todas = Array.isArray(m.json.plantillas) ? (m.json.plantillas as Args[]) : [];
        return salida({ ok: true, plantilla: { id: p.id, nombre: p.nombre, actualizada: p.upd, html_caracteres: str(p.html).length }, total: todas.length });
      },
    },
  ];
}
