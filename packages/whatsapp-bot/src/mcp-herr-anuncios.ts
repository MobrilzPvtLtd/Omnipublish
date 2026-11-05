/** MCP-TOTAL-1 · Herramientas MCP de ANUNCIOS: campañas, públicos, creatividades, tests A/B y alertas de
 *  Meta Ads; resúmenes de Google Ads y LinkedIn Ads; formularios de Lead Ads; y las campañas del panel
 *  (agrupaciones de flujos). Contratos: admin.ts (meta-ads 4699-5654, lead-forms 5683-5705,
 *  ads-accounts 13653-13799, linkedin-ads 15454, google-ads 15762-15788, campanas 19767-19804).
 *  En la edición de cliente las vistas ads/linkedinads/googleads/leadads están retiradas: cada
 *  herramienta declara sus `rutas` para no ofrecerse ahí. */
import { type Args, type Herramienta, type Kit, PAGINA, coincide, paginar, parse } from "./mcp-tipos.js";

const OBJETIVOS = ["OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_SALES", "OUTCOME_AWARENESS"];
const METRICAS_ALERTA = ["cpc", "ctr", "conversions", "spend", "reach"];
const OPERADORES = [">", "<", "=", ">=", "<="];

export function herramientas(k: Kit): Herramienta[] {
  const { S, esquema, llamar, api, fallo, str, lista, qs, msEnZona, dias, PERIODO, LEE, CAMBIA, IDEMP, BORRA, SALE, CONFIRMA } = k;
  const enc = encodeURIComponent;
  const cuentaMeta = (v: unknown) => str(v).replace(/^act_/, "");
  const euros = (v: unknown) => Math.round(Number(v) * 100) / 100;
  const noConfirmado = (que: string) => fallo(que + " Confírmalo con el usuario y repite con confirmado_por_humano: true.");
  const sinAprobar = (que: string) => fallo(que + " Confírmalo con el usuario y repite con confirmado_por_humano: true solo si lo aprueba.");
  const ADS = "/admin/api/ads";
  /** Lista paginada de una ruta que devuelve {clave: filas[]} sin total. */
  const listaPaginada = async (c: Parameters<Herramienta["run"]>[1], ruta: string, clave: string, a: Args, extra?: Record<string, unknown>) => {
    const r = await api(c, "GET", ruta);
    if (r.status !== 200) return llamar(c, "GET", ruta);
    const j = (parse(r.texto) || {}) as Args;
    const filas = Array.isArray(j[clave]) ? (j[clave] as Args[]) : [];
    return { texto: k.compactar(JSON.stringify({ ...paginar(filas, a), ...(extra || {}) })) };
  };

  return [
    // ── Resúmenes por red ──
    {
      name: "resumen_google_ads", title: "Google Ads", alcance: "lectura", annotations: LEE,
      description: "Rendimiento de Google Ads en el periodo (gasto, impresiones, clics, conversiones…) y las cuentas conectadas. "
        + "«dias» se redondea a un preset (hoy, 7, 14, 28, 30 o 90 días).",
      inputSchema: esquema({ dias: PERIODO.dias, cuenta: S.txt("Id de cliente de Google Ads (con o sin guiones), si hay varias.") }),
      rutas: ["/admin/api/google-ads"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/google-ads" + qs({ days: dias(a), ga_act: str(a.cuenta) })),
    },
    {
      name: "resumen_linkedin_ads", title: "LinkedIn Ads", alcance: "lectura", annotations: LEE,
      description: "Rendimiento de LinkedIn Ads en el periodo y las cuentas conectadas. «dias» se redondea a un preset.",
      inputSchema: esquema({ dias: PERIODO.dias, cuenta: S.txt("Id de la cuenta publicitaria de LinkedIn, si hay varias.") }),
      rutas: ["/admin/api/linkedin-ads"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/linkedin-ads" + qs({ days: dias(a), li_act: str(a.cuenta) })),
    },
    {
      name: "analizar_anuncios", title: "Análisis con IA de los anuncios", alcance: "lectura", annotations: LEE,
      description: "Texto de análisis (lo escribe la IA del panel, tarda unos segundos) del rendimiento de Meta Ads, Google Ads o LinkedIn Ads. "
        + "En Meta, si no se pudo generar, el propio texto lo dice.",
      inputSchema: esquema({ red: S.en("Qué red analizar.", ["meta", "google", "linkedin"]), refrescar: S.bool("true = generar de nuevo en vez de usar la copia reciente (solo Meta).") }, ["red"]),
      rutas: ["/admin/api/meta-ads", "/admin/api/google-ads", "/admin/api/linkedin-ads"],
      run: async (a, c) => {
        const ruta = a.red === "google" ? "/admin/api/google-ads/analysis" : a.red === "linkedin" ? "/admin/api/linkedin-ads/analysis" : "/admin/api/meta-ads/analysis";
        return llamar(c, "GET", ruta + (a.red === "meta" && a.refrescar === true ? "?refresh=1" : ""));
      },
    },
    {
      name: "cuentas_publicitarias", title: "Cuentas publicitarias conectadas", alcance: "lectura", annotations: LEE,
      description: "Las cuentas de Meta Ads (id sin «act_», nombre, moneda) y de Google Ads conectadas, y cuál está activa en cada red.",
      inputSchema: esquema({}),
      rutas: ["/admin/api/ads-accounts"],
      run: async (_a, c) => {
        const [m, g] = await Promise.all([api(c, "GET", "/admin/api/ads-accounts"), api(c, "GET", "/admin/api/googleads-accounts")]);
        if (m.status !== 200) return llamar(c, "GET", "/admin/api/ads-accounts");
        return { texto: k.compactar(JSON.stringify({ meta: parse(m.texto), google: g.status === 200 ? parse(g.texto) : { no_disponible: g.status } })) };
      },
    },
    {
      name: "elegir_cuenta_publicitaria", title: "Cambiar la cuenta publicitaria activa", alcance: "completo", annotations: IDEMP,
      description: "Cambia la cuenta activa de Meta Ads o de Google Ads: afecta a lo que ve toda la sección Anuncios del panel (avisa al usuario).",
      inputSchema: esquema({ red: S.en("meta o google.", ["meta", "google"]), cuenta: S.txt("Id de la cuenta (Meta sin act_; Google con o sin guiones).") }, ["red", "cuenta"]),
      rutas: ["/admin/api/ads-accounts"],
      run: async (a, c) => a.red === "google"
        ? llamar(c, "POST", "/admin/api/googleads-accounts/select", { customerId: str(a.cuenta) })
        : llamar(c, "POST", "/admin/api/ads-accounts/select", { adAccountId: cuentaMeta(a.cuenta) }),
    },

    // ── Campañas de Meta ──
    {
      name: "listar_campanas_meta", title: "Campañas de Meta Ads", alcance: "lectura", annotations: LEE,
      description: "Las campañas de la cuenta de Meta Ads activa: estado, objetivo, presupuesto diario o total (en la moneda de la cuenta), fechas. "
        + "Incluye los objetivos disponibles para crear campañas. Si Meta falla, «nota» lo dice y la lista viene vacía (no es «0 campañas»).",
      inputSchema: esquema({ estado: S.txt("Solo las de este estado (ACTIVE, PAUSED, ARCHIVED…)."), q: S.txt("Texto a buscar en el nombre."), refrescar: S.bool("true = volver a pedirlas a Meta."), ...PAGINA }),
      rutas: [ADS + "/campaigns"],
      run: async (a, c) => {
        const r = await api(c, "GET", ADS + "/campaigns" + (a.refrescar === true ? "?refresh=1" : ""));
        if (r.status !== 200) return llamar(c, "GET", ADS + "/campaigns");
        const j = (parse(r.texto) || {}) as Args;
        let cs = Array.isArray(j.campaigns) ? (j.campaigns as Args[]) : [];
        if (str(a.estado)) cs = cs.filter((x) => str(x.status).toUpperCase() === str(a.estado).toUpperCase() || str(x.effectiveStatus).toUpperCase() === str(a.estado).toUpperCase());
        if (str(a.q)) cs = cs.filter((x) => coincide(x, str(a.q), ["name", "id"]));
        return { texto: k.compactar(JSON.stringify({ configurado: j.configured, nota: j.note, moneda: j.currency, ...paginar(cs, a), objetivos: OBJETIVOS })) };
      },
    },
    {
      name: "crear_campana_meta", title: "Crear una campaña de Meta Ads", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Crea una campaña en la cuenta de Meta Ads activa, EN PAUSA (no gasta hasta activarla con cambiar_estado_campana_meta). "
        + "Presupuesto en la moneda de la cuenta (euros, no céntimos). Confirma nombre, objetivo y presupuesto con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({
        nombre: S.txt("Nombre de la campaña."), objetivo: S.en("Objetivo. Por defecto OUTCOME_TRAFFIC.", OBJETIVOS),
        presupuesto_diario: S.num("Presupuesto diario de la campaña (moneda de la cuenta). Sin él, el presupuesto se pone por conjunto de anuncios."), ...CONFIRMA,
      }, ["nombre"]),
      rutas: [ADS + "/campaigns"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Crear una campaña con presupuesto en Meta.");
        const b: Args = { name: str(a.nombre), objective: str(a.objetivo) || "OUTCOME_TRAFFIC" };
        if (Number(a.presupuesto_diario) > 0) b.dailyBudget = euros(a.presupuesto_diario);
        return llamar(c, "POST", ADS + "/campaigns", b, true);
      },
    },
    {
      name: "cambiar_estado_campana_meta", title: "Activar o pausar una campaña de Meta Ads", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "activar: true pone la campaña ACTIVA (empieza a gastar); false la PAUSA. Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({ campana: S.txt("Id de la campaña en Meta."), activar: S.bool("true = activar; false = pausar."), ...CONFIRMA }, ["campana", "activar"]),
      rutas: [ADS + "/campaigns"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado(a.activar === true ? "Activar la campaña hace que empiece a gastar." : "Pausar la campaña detiene sus anuncios.");
        return llamar(c, "POST", ADS + "/campaigns/" + enc(str(a.campana)) + "/status", { status: a.activar === true ? "ACTIVE" : "PAUSED" }, true);
      },
    },
    {
      name: "cambiar_presupuesto_campana_meta", title: "Cambiar el presupuesto diario de una campaña", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Fija el presupuesto diario de una campaña de Meta Ads (mínimo 1.00 en la moneda de la cuenta). Si la campaña tiene presupuesto por conjunto, Meta lo rechaza. "
        + "Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({ campana: S.txt("Id de la campaña en Meta."), presupuesto_diario: S.num("Nuevo presupuesto diario (≥ 1.00).", { minimum: 1 }), ...CONFIRMA }, ["campana", "presupuesto_diario"]),
      rutas: [ADS + "/campaigns"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Cambiar el presupuesto cambia lo que gasta la campaña.");
        return llamar(c, "POST", ADS + "/campaigns/" + enc(str(a.campana)) + "/budget", { dailyBudget: euros(a.presupuesto_diario) }, true);
      },
    },
    {
      name: "publicaciones_impulsables", title: "Publicaciones que se pueden impulsar", alcance: "lectura", annotations: LEE,
      description: "Las últimas 20 publicaciones de una Página de Facebook que se pueden promocionar (id completo para impulsar_publicacion, texto, enlace).",
      inputSchema: esquema({ pagina: S.txt("Id de la Página de Facebook (cuentas facebook en listar_conversaciones o estado_conexiones).") }, ["pagina"]),
      rutas: [ADS + "/boostable-posts"],
      run: async (a, c) => llamar(c, "GET", ADS + "/boostable-posts" + qs({ pageId: str(a.pagina) })),
    },
    {
      name: "impulsar_publicacion", title: "Impulsar una publicación de Facebook", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Crea en Meta una campaña de interacción (campaña + conjunto + creatividad + anuncio) para una publicación, todo EN PAUSA: hay que activar la campaña después. "
        + "No fija fecha de fin. Si falla a medias, devuelve los ids creados para que se limpien en Meta. Confirma presupuesto y países: confirmado_por_humano: true.",
      inputSchema: esquema({
        pagina: S.txt("Id de la Página."), publicacion: S.txt("Id completo de la publicación (pagina_post), de publicaciones_impulsables."),
        presupuesto_diario: S.num("Presupuesto diario (moneda de la cuenta; mínimo 1.00). Por defecto 5."), paises: S.lista("Países ISO-2. Por defecto ES."), ...CONFIRMA,
      }, ["pagina", "publicacion"]),
      rutas: [ADS + "/boost"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Impulsar crea objetos con presupuesto en Meta.");
        return llamar(c, "POST", ADS + "/boost", { pageId: str(a.pagina), postId: str(a.publicacion), dailyBudget: Number(a.presupuesto_diario) > 0 ? euros(a.presupuesto_diario) : 5, countries: lista(a.paises) || ["ES"] }, true);
      },
    },

    // ── Públicos ──
    {
      name: "listar_publicos_meta", title: "Públicos de Meta Ads", alcance: "lectura", annotations: LEE,
      description: "Los públicos guardados (segmentaciones) y los personalizados y similares de una cuenta de Meta Ads.",
      inputSchema: esquema({ cuenta: S.txt("Id de la cuenta de Meta Ads (sin act_)."), tipo: S.en("guardados, personalizados o ambos (por defecto).", ["guardados", "personalizados", "ambos"]) }, ["cuenta"]),
      rutas: [ADS + "/audiences/saved"],
      run: async (a, c) => {
        const q = qs({ adAccountId: cuentaMeta(a.cuenta) });
        const t = str(a.tipo) || "ambos";
        const [g, p] = await Promise.all([
          t !== "personalizados" ? api(c, "GET", ADS + "/audiences/saved" + q) : null,
          t !== "guardados" ? api(c, "GET", ADS + "/audiences/custom" + q) : null,
        ]);
        const malo = [g, p].find((r) => r && r.status !== 200);
        if (malo) return llamar(c, "GET", ADS + (malo === g ? "/audiences/saved" : "/audiences/custom") + q);
        return { texto: k.compactar(JSON.stringify({ guardados: g ? (parse(g.texto) as Args | null)?.audiences : undefined, personalizados: p ? (parse(p.texto) as Args | null)?.audiences : undefined })) };
      },
    },
    {
      name: "crear_publico_meta", title: "Crear un público en Meta Ads", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Crea en Meta un público personalizado (vacío, para rellenarlo luego) o uno similar (lookalike) a partir de otro público («origen» + «proporcion» 1-20 %). "
        + "No gasta dinero. Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({
        cuenta: S.txt("Id de la cuenta de Meta Ads (sin act_)."), nombre: S.txt("Nombre del público."),
        tipo: S.en("personalizado (por defecto) o similar.", ["personalizado", "similar"]), descripcion: S.txt("Descripción (personalizado)."),
        origen: S.txt("Id del público de origen (similar)."), pais: S.txt("País ISO-2 del público similar. Por defecto ES."),
        proporcion: S.num("Tamaño del público similar en % de la población (1-20). Por defecto 1.", { minimum: 1, maximum: 20 }), ...CONFIRMA,
      }, ["cuenta"]),
      rutas: [ADS + "/audiences/custom"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Crear un público en Meta.");
        const adAccountId = cuentaMeta(a.cuenta);
        if (a.tipo === "similar") {
          if (!str(a.origen)) return fallo("Un público similar necesita «origen» (id del público de partida).");
          return llamar(c, "POST", ADS + "/audiences/lookalike", { adAccountId, sourceAudienceId: str(a.origen), country: str(a.pais) || "ES", ratio: (Number(a.proporcion) || 1) / 100, ...(str(a.nombre) ? { name: str(a.nombre) } : {}) }, true);
        }
        if (!str(a.nombre)) return fallo("Pasa el nombre del público.");
        return llamar(c, "POST", ADS + "/audiences/custom", { adAccountId, name: str(a.nombre), subtype: "CUSTOM", ...(str(a.descripcion) ? { description: str(a.descripcion) } : {}) }, true);
      },
    },
    {
      name: "borrar_publico_meta", title: "Borrar un público de Meta Ads", alcance: "completo", annotations: { ...BORRA, openWorldHint: true },
      description: "Borra un público personalizado o similar en Meta (irreversible). Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({ cuenta: S.txt("Id de la cuenta de Meta Ads (sin act_)."), publico: S.txt("Id del público."), ...CONFIRMA }, ["cuenta", "publico"]),
      rutas: [ADS + "/audiences/custom"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar un público en Meta es irreversible.");
        return llamar(c, "DELETE", ADS + "/audiences/custom/" + enc(str(a.publico)) + qs({ adAccountId: cuentaMeta(a.cuenta) }), undefined, true);
      },
    },
    {
      name: "buscar_intereses_meta", title: "Buscar intereses para segmentar", alcance: "lectura", annotations: LEE,
      description: "Busca en Meta intereses de segmentación por texto (id, nombre, tamaño de audiencia).",
      inputSchema: esquema({ q: S.txt("Texto a buscar."), idioma: S.txt("Locale de Meta. Por defecto es_ES.") }, ["q"]),
      rutas: [ADS + "/interests/search"],
      run: async (a, c) => llamar(c, "GET", ADS + "/interests/search" + qs({ q: str(a.q), locale: str(a.idioma) || "es_ES" })),
    },

    // ── Creatividades ──
    {
      name: "listar_creatividades", title: "Creatividades guardadas", alcance: "lectura", annotations: LEE,
      description: "Las creatividades (imagen, vídeo, carrusel, texto) guardadas en el panel para anuncios, con su estado de subida a Meta "
        + "(draft, syncing, synced, failed). No incluye el archivo en sí.",
      inputSchema: esquema({
        cuenta: S.txt("Solo las de esta cuenta de Meta Ads (sin act_)."), tipo: S.en("Tipo.", ["image", "video", "carousel", "copy"]),
        estado: S.en("Estado.", ["draft", "syncing", "synced", "failed"]), ...PAGINA,
      }),
      rutas: [ADS + "/creatives"],
      run: async (a, c) => {
        const r = await api(c, "GET", ADS + "/creatives" + qs({ adAccountId: cuentaMeta(a.cuenta), type: str(a.tipo), status: str(a.estado), limit: 500 }));
        if (r.status !== 200) return llamar(c, "GET", ADS + "/creatives");
        const filas = ((parse(r.texto) as Args | null)?.creatives as Args[] | undefined) || [];
        const sinArchivo = filas.map((f) => { const { url, file_base64, fileBase64, ...resto } = f; return { ...resto, con_archivo: !!(url || file_base64 || fileBase64) }; });
        return { texto: k.compactar(JSON.stringify(paginar(sinArchivo, a))) };
      },
    },
    {
      name: "guardar_creatividad", title: "Guardar una creatividad", alcance: "completo", annotations: CAMBIA,
      description: "Guarda en el panel (sin tocar Meta) una creatividad para anuncios: imagen o vídeo en base64 (con «cuenta»), o un texto/carrusel con "
        + "titular, cuerpo, descripción, botón y enlace. Después, subir_creatividad_a_meta.",
      inputSchema: esquema({
        tipo: S.en("Tipo.", ["image", "video", "carousel", "copy"]), nombre: S.txt("Nombre (hasta 200)."), cuenta: S.txt("Cuenta de Meta Ads (obligatoria para imagen y vídeo)."),
        archivo_base64: S.txt("Imagen (≤30 MB) o vídeo (≤4 GB) en base64, sin prefijo data:."), mime: S.txt("Tipo del archivo. Por defecto image/jpeg o video/mp4."),
        titular: S.txt("Titular (≤255)."), cuerpo: S.txt("Texto principal (≤2000)."), descripcion: S.txt("Descripción (≤500)."), texto_boton: S.txt("Texto del botón (≤60)."), enlace: S.txt("Enlace (≤500)."),
      }, ["tipo"]),
      rutas: [ADS + "/creatives"],
      run: async (a, c) => {
        const b: Args = { type: str(a.tipo) };
        if (str(a.nombre)) b.name = str(a.nombre);
        if (str(a.cuenta)) b.adAccountId = cuentaMeta(a.cuenta);
        if (str(a.archivo_base64)) { b.fileBase64 = String(a.archivo_base64).replace(/^data:[^,]*,/, ""); if (str(a.mime)) b.mime = str(a.mime); }
        const body: Args = {};
        if (str(a.titular)) body.headline = str(a.titular); if (str(a.cuerpo)) body.body = str(a.cuerpo); if (str(a.descripcion)) body.description = str(a.descripcion);
        if (str(a.texto_boton)) body.cta_text = str(a.texto_boton); if (str(a.enlace)) body.link = str(a.enlace);
        if (Object.keys(body).length) b.body = body;
        return llamar(c, "POST", ADS + "/creatives", b);
      },
    },
    {
      name: "subir_creatividad_a_meta", title: "Subir una creatividad a Meta", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Sube a Meta una creatividad guardada (en segundo plano; el resultado se ve en su estado en listar_creatividades). No gasta. Confirma: confirmado_por_humano: true.",
      inputSchema: esquema({ creatividad: S.txt("Id de la creatividad."), ...CONFIRMA }, ["creatividad"]),
      rutas: [ADS + "/creatives"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Subir la creatividad a Meta.");
        return llamar(c, "POST", ADS + "/creatives/" + enc(str(a.creatividad)) + "/sync", {}, true);
      },
    },
    {
      name: "borrar_creatividad", title: "Borrar una creatividad del panel", alcance: "completo", annotations: BORRA,
      description: "Borra la creatividad del panel (no de Meta). Solo la puede usar un administrador del panel. Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({ creatividad: S.txt("Id de la creatividad."), ...CONFIRMA }, ["creatividad"]),
      rutas: [ADS + "/creatives"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return sinAprobar("Borrar una creatividad quita sus datos del panel.");
        return llamar(c, "DELETE", ADS + "/creatives/" + enc(str(a.creatividad)));
      },
    },

    // ── Tests A/B ──
    {
      name: "listar_tests_ab", title: "Tests A/B de anuncios", alcance: "lectura", annotations: LEE,
      description: "Los tests A/B creados desde el panel (running, completed, failed) y, con «test», los resultados por variante (CPC, CTR, gasto, conversiones, alcance).",
      inputSchema: esquema({ cuenta: S.txt("Solo los de esta cuenta (sin act_)."), estado: S.en("Estado.", ["running", "completed", "failed"]), test: S.txt("Id de un test: devuelve sus resultados."), ...PAGINA }),
      rutas: [ADS + "/experiments"],
      run: async (a, c) => {
        if (str(a.test)) return llamar(c, "GET", ADS + "/experiments/" + enc(str(a.test)) + "/kpis");
        return listaPaginada(c, ADS + "/experiments" + qs({ adAccountId: cuentaMeta(a.cuenta), status: str(a.estado), limit: 500 }), "experiments", a);
      },
    },
    {
      name: "crear_test_ab", title: "Crear un test A/B de anuncios", alcance: "completo", annotations: { ...SALE, openWorldHint: true },
      description: "Crea de 2 a 4 anuncios dentro de un conjunto existente de Meta, ACTIVOS desde el primer momento: GASTA DINERO en cuanto se crea. "
        + "Cada variante lleva una creatividad ya subida (creatividad) y/o un texto {mensaje, enlace, nombre, tipo_boton}. Tarda hasta 30 s. "
        + "Enseña al usuario las variantes y el conjunto, y pasa confirmado_por_humano: true.",
      inputSchema: esquema({
        cuenta: S.txt("Cuenta de Meta Ads (sin act_)."), campana: S.txt("Id de la campaña base."), conjunto: S.txt("Id del conjunto de anuncios base."),
        pagina: S.txt("Id de la Página de Facebook (opcional)."), nombre: S.txt("Nombre del test (≤200)."),
        variantes: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", properties: { etiqueta: { type: "string" }, creatividad: { type: "string" }, mensaje: { type: "string" }, enlace: { type: "string" }, nombre: { type: "string" }, tipo_boton: { type: "string" } } }, description: "2-4 variantes." },
        ...CONFIRMA,
      }, ["cuenta", "campana", "conjunto", "variantes"]),
      rutas: [ADS + "/experiments"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("El test crea anuncios ACTIVOS que gastan dinero desde ya.");
        const vs = Array.isArray(a.variantes) ? (a.variantes as Args[]) : [];
        if (vs.length < 2 || vs.length > 4) return fallo("Hacen falta entre 2 y 4 variantes.");
        const variants = vs.map((v) => {
          const copy: Args = {};
          if (str(v.mensaje)) copy.message = str(v.mensaje); if (str(v.enlace)) copy.link = str(v.enlace); if (str(v.nombre)) copy.name = str(v.nombre); if (str(v.tipo_boton)) copy.cta_type = str(v.tipo_boton);
          return { ...(str(v.etiqueta) ? { label: str(v.etiqueta) } : {}), ...(str(v.creatividad) ? { creativeId: str(v.creatividad) } : {}), ...(Object.keys(copy).length ? { copy } : {}) };
        });
        return llamar(c, "POST", ADS + "/experiments", { adAccountId: cuentaMeta(a.cuenta), baseCampaignId: str(a.campana), baseAdsetId: str(a.conjunto), ...(str(a.pagina) ? { pageId: str(a.pagina) } : {}), ...(str(a.nombre) ? { name: str(a.nombre) } : {}), variants }, true);
      },
    },
    {
      name: "cerrar_test_ab", title: "Declarar ganador de un test A/B", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Declara ganador un anuncio del test: pausa en Meta las demás variantes y cierra el test. Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({ test: S.txt("Id del test."), anuncio: S.txt("Id del anuncio ganador en Meta."), ...CONFIRMA }, ["test", "anuncio"]),
      rutas: [ADS + "/experiments"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Declarar ganador pausa las otras variantes en Meta.");
        return llamar(c, "POST", ADS + "/experiments/" + enc(str(a.test)) + "/winner", { adId: str(a.anuncio) }, true);
      },
    },
    {
      name: "borrar_test_ab", title: "Borrar un test A/B del panel", alcance: "completo", annotations: BORRA,
      description: "Quita el test del panel. Los anuncios siguen en Meta (y siguen gastando si están activos): páusalos antes con cerrar_test_ab o en Meta. "
        + "Solo la puede usar un administrador del panel. Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({ test: S.txt("Id del test."), ...CONFIRMA }, ["test"]),
      rutas: [ADS + "/experiments"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return sinAprobar("Quitar el test borra su registro del panel.");
        return llamar(c, "DELETE", ADS + "/experiments/" + enc(str(a.test)));
      },
    },

    // ── Alertas ──
    {
      name: "listar_alertas_anuncios", title: "Alertas de anuncios", alcance: "lectura", annotations: LEE,
      description: "Las alertas configuradas sobre métricas de Meta Ads (cpc, ctr, conversiones, gasto, alcance), el teléfono que las recibe por WhatsApp y, "
        + "con historial: true, los últimos disparos.",
      inputSchema: esquema({ cuenta: S.txt("Solo las de esta cuenta (sin act_)."), activas: S.bool("true = solo activas; false = solo apagadas."), historial: S.bool("true = incluir los últimos disparos."), alerta: S.txt("Con historial: solo los disparos de esta alerta."), ...PAGINA }),
      rutas: [ADS + "/alerts"],
      run: async (a, c) => {
        const r = await api(c, "GET", ADS + "/alerts" + qs({ adAccountId: cuentaMeta(a.cuenta), enabled: a.activas === true ? "true" : a.activas === false ? "false" : "", limit: 500 }));
        if (r.status !== 200) return llamar(c, "GET", ADS + "/alerts");
        const alertas = ((parse(r.texto) as Args | null)?.alerts as Args[] | undefined) || [];
        const tel = await api(c, "GET", ADS + "/alerts/owner-phone");
        let historial: unknown;
        if (a.historial === true) {
          const h = await api(c, "GET", ADS + "/alerts/log" + qs({ alertId: str(a.alerta), limit: 100 }));
          historial = (parse(h.texto) as Args | null)?.log;
        }
        return { texto: k.compactar(JSON.stringify({ ...paginar(alertas, a), telefono_avisos: (parse(tel.texto) as Args | null)?.phone, historial })) };
      },
    },
    {
      name: "crear_alerta_anuncios", title: "Crear una alerta de anuncios", alcance: "completo", annotations: CAMBIA,
      description: "Avisa (en el panel, por WhatsApp al teléfono configurado o por correo) cuando una métrica de Meta Ads cruza un umbral, a nivel de cuenta, campaña, conjunto o anuncio.",
      inputSchema: esquema({
        cuenta: S.txt("Cuenta de Meta Ads (sin act_)."), nombre: S.txt("Nombre (≤200)."), metrica: S.en("Métrica.", METRICAS_ALERTA), operador: S.en("Comparación.", OPERADORES),
        umbral: S.num("Valor umbral."), ambito: S.en("A qué se aplica.", ["account", "campaign", "adset", "ad"]), id_ambito: S.txt("Id de la campaña, conjunto o anuncio (no hace falta con account)."),
        canal: S.en("Por dónde avisa.", ["panel", "whatsapp", "email"]), activa: S.bool("false = crearla apagada."),
      }, ["cuenta", "metrica", "operador", "umbral", "ambito"]),
      rutas: [ADS + "/alerts"],
      run: async (a, c) => llamar(c, "POST", ADS + "/alerts", {
        adAccountId: cuentaMeta(a.cuenta), ...(str(a.nombre) ? { name: str(a.nombre) } : {}), metric: str(a.metrica), operator: str(a.operador), threshold: Number(a.umbral),
        scope: str(a.ambito), ...(str(a.id_ambito) ? { scope_id: str(a.id_ambito) } : {}), channel: str(a.canal) || "panel", enabled: a.activa !== false,
      }),
    },
    {
      name: "activar_alerta_anuncios", title: "Encender o apagar una alerta", alcance: "completo", annotations: IDEMP,
      description: "Enciende (activa: true) o apaga (false) una alerta de anuncios; sin «activa», la invierte.",
      inputSchema: esquema({ alerta: S.txt("Id de la alerta."), activa: S.bool("true = encender; false = apagar.") }, ["alerta"]),
      rutas: [ADS + "/alerts"],
      run: async (a, c) => llamar(c, "POST", ADS + "/alerts/" + enc(str(a.alerta)) + "/toggle", typeof a.activa === "boolean" ? { enabled: a.activa } : {}),
    },
    {
      name: "borrar_alerta_anuncios", title: "Borrar una alerta de anuncios", alcance: "completo", annotations: BORRA,
      description: "Borra una alerta de anuncios. Solo la puede usar un administrador del panel. Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({ alerta: S.txt("Id de la alerta."), ...CONFIRMA }, ["alerta"]),
      rutas: [ADS + "/alerts"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return sinAprobar("Borrar una alerta la elimina para siempre.");
        return llamar(c, "DELETE", ADS + "/alerts/" + enc(str(a.alerta)));
      },
    },
    {
      name: "telefono_alertas_anuncios", title: "Teléfono que recibe las alertas por WhatsApp", alcance: "completo", annotations: IDEMP,
      description: "Fija (o borra, con vacío) el teléfono con prefijo de país que recibe las alertas de anuncios por WhatsApp.",
      inputSchema: esquema({ telefono: S.txt("Teléfono con prefijo, p. ej. 34600111222; vacío = quitarlo.") }, ["telefono"]),
      rutas: [ADS + "/alerts"],
      run: async (a, c) => llamar(c, "POST", ADS + "/alerts/owner-phone", { phone: str(a.telefono) }),
    },

    // ── Lead Ads ──
    {
      name: "formularios_lead_ads", title: "Formularios de Lead Ads", alcance: "lectura", annotations: LEE,
      description: "Los formularios de captación de Facebook/Instagram de todas las Páginas conectadas (id, nombre, estado, leads, Página). "
        + "Con «formulario» y «pagina», previsualiza sus últimos 50 leads sin guardarlos (datos personales).",
      inputSchema: esquema({ formulario: S.txt("Id del formulario (para ver sus leads)."), pagina: S.txt("Id de la Página del formulario."), refrescar: S.bool("true = volver a pedirlos a Meta.") }),
      rutas: ["/admin/api/lead-forms"],
      run: async (a, c) => str(a.formulario)
        ? llamar(c, "GET", "/admin/api/lead-forms/leads" + qs({ formId: str(a.formulario), pageId: str(a.pagina) }))
        : llamar(c, "GET", "/admin/api/lead-forms" + (a.refrescar === true ? "?refresh=1" : "")),
    },
    {
      name: "importar_leads_formulario", title: "Importar los leads de un formulario al CRM", alcance: "completo", annotations: CAMBIA,
      description: "Crea o actualiza contactos con los leads de un formulario de Lead Ads (etiquetas «lead» y «lead-ads:<formulario>»). "
        + "Las etiquetas pueden disparar flujos: avisa al usuario y pasa confirmado_por_humano: true.",
      inputSchema: esquema({ formulario: S.txt("Id del formulario."), pagina: S.txt("Id de la Página."), nombre: S.txt("Nombre del formulario (va a la etiqueta)."), ...CONFIRMA }, ["formulario", "pagina"]),
      rutas: ["/admin/api/lead-forms"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Importar crea contactos con etiquetas que pueden disparar flujos.");
        return llamar(c, "POST", "/admin/api/lead-forms/sync", { formId: str(a.formulario), pageId: str(a.pagina), ...(str(a.nombre) ? { formName: str(a.nombre) } : {}) }, true);
      },
    },

    // ── Campañas del panel (agrupaciones de flujos) ──
    {
      name: "resultados_campanas", title: "Campañas del panel (grupos de flujos)", alcance: "lectura", annotations: LEE,
      description: "Las campañas del panel (agrupaciones de flujos con un objetivo: completar, reserva o compra) y sus resultados en el periodo frente al anterior: "
        + "personas, cuántas lo lograron, destacados. Con «campana», el mapa de su recorrido (tramos entre flujos). No son campañas de Meta Ads.",
      inputSchema: esquema({ ...PERIODO, campana: S.txt("Id de una campaña (cmp_…) para ver su mapa.") }),
      rutas: ["/admin/api/campanas"],
      run: async (a, c) => {
        const p = str(a.desde) || str(a.hasta) ? k.periodo(a, c.zona) : null;
        if (p && "error" in p) return fallo(p.error);
        const q = qs(p ? { from: p.from, to: p.to } : { days: dias(a) });
        return str(a.campana) ? llamar(c, "GET", "/admin/api/campanas/mapa" + q + "&id=" + enc(str(a.campana))) : llamar(c, "GET", "/admin/api/campanas" + q);
      },
    },
    {
      name: "guardar_campana", title: "Crear o editar una campaña del panel", alcance: "completo", annotations: CAMBIA,
      description: "Crea (sin «id») o edita una campaña del panel: nombre, oferta, objetivo, fechas y los flujos que la componen (ids de listar_flujos; los que no existan se descartan). "
        + "Al editar, lo que no pasas se conserva tal cual (la campaña se lee antes); para quitar la oferta o una fecha, pásalas vacías. Fechas: AAAA-MM-DD o AAAA-MM-DD HH:MM (hora de Madrid).",
      inputSchema: esquema({
        id: S.txt("Id de la campaña a editar (cmp_…)."), nombre: S.txt("Nombre (≤80)."), oferta: S.txt("Oferta (≤120)."),
        objetivo: S.en("Objetivo.", ["completar", "reserva", "compra"]), empieza: S.fecha("Inicio (fecha, en la zona del negocio)."), termina: S.fecha("Fin."),
        flujos: S.lista("Ids de los flujos (hasta 60)."),
      }, ["nombre"]),
      rutas: ["/admin/api/campanas"],
      run: async (a, c) => {
        const campos: Array<[string, unknown]> = [["empieza", a.empieza], ["termina", a.termina]];
        const invalida = campos.find(([, v]) => v !== undefined && str(v) !== "" && msEnZona(v, c.zona) === null);
        if (invalida) return fallo("La fecha de «" + invalida[0] + "» no se entiende. Usa AAAA-MM-DD o AAAA-MM-DD HH:MM (hora de Madrid), o vacía para quitarla.");
        const fechaDe = (v: unknown) => (str(v) === "" ? null : msEnZona(v, c.zona));
        const id = str(a.id);
        const b: Args = { name: str(a.nombre) };
        if (id) {
          // Edición: el panel manda la campaña entera; aquí se parte de la actual para no borrar lo que no se pasa.
          const r = await api(c, "GET", "/admin/api/campanas");
          if (r.status !== 200) return fallo("No he podido leer la campaña actual, así que no la he editado para no perder sus datos. Vuelve a intentarlo.");
          const j = (parse(r.texto) || {}) as Args;
          const actual = ((j.campanas as Args[] | undefined) || []).find((x) => str(x.id) === id);
          const def = ((j.definiciones as Args[] | undefined) || []).find((x) => str(x.id) === id);
          if (!actual || !def) return fallo("No existe ninguna campaña con id " + id + ". Usa resultados_campanas para ver las que hay.");
          b.id = id;
          b.offer = a.oferta !== undefined ? str(a.oferta) : actual.offer;
          b.objective = str(a.objetivo) || actual.objective;
          b.startsAt = a.empieza !== undefined ? fechaDe(a.empieza) : actual.startsAt;
          b.endsAt = a.termina !== undefined ? fechaDe(a.termina) : actual.endsAt;
          b.flowIds = lista(a.flujos) ?? def.flowIds ?? [];
        } else {
          b.offer = str(a.oferta); b.objective = str(a.objetivo);
          b.startsAt = a.empieza !== undefined ? fechaDe(a.empieza) : null;
          b.endsAt = a.termina !== undefined ? fechaDe(a.termina) : null;
          b.flowIds = lista(a.flujos) ?? [];
        }
        return llamar(c, "POST", "/admin/api/campanas", b);
      },
    },
    {
      name: "borrar_campana", title: "Borrar una campaña del panel", alcance: "completo", annotations: BORRA,
      description: "Borra una campaña del panel (los flujos se quedan). Un visor del workspace no puede borrarla. Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({ id: S.txt("Id de la campaña (cmp_…)."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/campanas"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return sinAprobar("Borrar una campaña la quita del panel.");
        return llamar(c, "POST", "/admin/api/campanas/borrar", { id: str(a.id) });
      },
    },
  ];
}
