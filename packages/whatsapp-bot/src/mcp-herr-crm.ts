/** MCP-TOTAL-1 · Herramientas MCP de CRM: registro de Actividad, búsqueda de contactos con TODOS los filtros de la vista,
 *  embudos y respuestas de formulario de un contacto, borrar o mandar contactos a una web, reuniones (listar, agendar,
 *  cancelar, zona horaria), oportunidades y pipelines (conteo real, guardar uno o todos, borrar, desenlaces), descripción,
 *  uso y sincronización de etiquetas con systeme.io, enlaces medidos (asistencia, ver, crear, editar, ocultar, borrar,
 *  etiquetar a quien abrió) y catálogo de productos de pago (detalle, guardar uno o todos, quitar).
 *  Contratos: admin.ts (activity 4224-4380, contacts 5921-7036, contacts/etiquetas 6418, sync-bulk 6659, meetings 6469-6660,
 *  PUT contacts/:phone 6873, funnels 7276, form-responses 15425, links 7416-7680, link-attendance 7485-7630,
 *  payment-products 7117-7240, opps 13195-13300, pipelines 13325-13420, tags 21673-21789).
 *  Fuera a propósito: directorio/* y sync/* (vista «leads», retirada en todas las ediciones); /me y /me/avatar (sesión
 *  del actor; el avatar es binario y está vetado); contacts/sio-backfill (mantenimiento de una sola vez); activity/stream
 *  (SSE, vetado) y activity/mark-seen (solo pone una cookie); opps/move-stage (lo cubre `movimientos` al guardar un
 *  pipeline); contacts/:phone/flow-runs y flow-runs/cancel (ya los dan automatizaciones_contacto y
 *  parar_automatizaciones_contacto, del módulo de Bandeja). */
import { type Args, type Ctx, type Herramienta, type Kit, PAGINA, coincide, paginar, parse } from "./mcp-tipos.js";

const ORIGENES_ACTIVIDAD = ["autopost", "scheduled-post", "broadcast", "mcp-job", "lead-job", "webhook", "llm", "meta-api", "wa-send", "ig-send", "fb-send", "yt-send", "newsletter", "app"];
const NIVELES_ACTIVIDAD = ["info", "warn", "error"];
const DIAS_VACIADO = [0, 7, 30, 90, 365];
const ORDEN_CONTACTOS = ["last_inbound", "created_at", "name", "stage", "score"];
const CAMPOS_ENLACE = ["token", "label", "url", "target", "short", "kind", "context_kind", "context_id", "context_label"];

export function herramientas(k: Kit): Herramienta[] {
  const { S, esquema, llamar, api, fallo, str, tel, lista, qs, msEnZona, LEE, CAMBIA, IDEMP, BORRA, SALE, CONFIRMA } = k;
  const enc = encodeURIComponent;
  const noConfirmado = (que: string) => fallo(que + " Confírmalo con el usuario y repite con confirmado_por_humano: true.");
  /** Lee una ruta JSON; si falla devuelve la respuesta tal cual (con el error explicado). */
  const lee = async (c: Ctx, ruta: string) => {
    const r = await api(c, "GET", ruta);
    return r.status === 200 ? { json: (parse(r.texto) || {}) as Args } : { res: await llamar(c, "GET", ruta) };
  };
  const salida = (o: unknown) => ({ texto: k.compactar(JSON.stringify(o)) });
  const arr = (j: Args, clave: string): Args[] => (Array.isArray(j[clave]) ? (j[clave] as Args[]) : []);
  const sin = (o: Args, claves: string[]): Args => { const r: Args = { ...o }; for (const q of claves) delete r[q]; return r; };
  /** Clave de contacto tal cual la usa el panel: teléfono (normalizado), id de Instagram/Facebook o «email:correo». */
  const claveContacto = (a: Args): string => {
    const v = str(a.telefono).trim();
    return /^email:/i.test(v) || v.includes("@") ? v : tel(v) || v;
  };
  /** Fecha opcional → ms en la zona del negocio. undefined = no viene; null = no se entiende. */
  const ms = (v: unknown, c: Ctx): number | null | undefined => (v === undefined || v === null || str(v).trim() === "") ? undefined : msEnZona(v, c.zona);
  const bool3 = (v: unknown): string => (v === undefined || v === null ? "" : v === true ? "true" : "false");
  const entero = (v: unknown, def: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || def)));
  const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const idLibre = (base: string, usados: Set<string>, porDefecto: string) => {
    const raiz = slug(base) || porDefecto;
    let id = raiz;
    for (let n = 2; usados.has(id); n++) id = raiz + "-" + n;
    return id;
  };
  /** La ficha de un contacto (detail) o null si no existe. */
  const ficha = async (c: Ctx, clave: string): Promise<Args | null> => {
    const r = await api(c, "GET", "/admin/api/contacts/" + enc(clave) + "/detail");
    if (r.status !== 200) return null;
    const j = (parse(r.texto) || {}) as Args;
    return j.contact && typeof j.contact === "object" ? (j.contact as Args) : null;
  };
  const nombreDe = (f: Args | null, clave: string) => str(f?.name).trim() || clave;
  /** Oportunidades de un pipeline según /pipelines/conteo (suma de porEtapa); null si la respuesta no se entiende. */
  const totalOportunidades = (j: unknown): number | null => {
    const pe = (j as Args | null | undefined)?.porEtapa;
    return pe && typeof pe === "object" ? Object.values(pe as Record<string, unknown>).reduce<number>((s, v) => s + (Number(v) || 0), 0) : null;
  };
  /** Pipelines tal cual están guardados (id, name, stages, won, lost), para reenviarlos enteros. */
  const pipelinesActuales = async (c: Ctx) => {
    const r = await lee(c, "/admin/api/pipelines");
    if (r.res) return { res: r.res };
    return { lista: arr(r.json, "pipelines").map((p) => ({ id: str(p.id), name: str(p.name), stages: lista(p.stages) || [], won: str(p.won), lost: str(p.lost) })) };
  };
  const movimientosDe = (a: Args, pipelineId: string) => {
    const movs = Array.isArray(a.movimientos) ? (a.movimientos as Args[]) : [];
    return movs.map((m) => ({ pipeline_id: str(m.pipeline) || pipelineId, from: str(m.de), to: str(m.a) }));
  };
  const productosActuales = async (c: Ctx) => {
    const r = await lee(c, "/admin/api/payment-products");
    if (r.res) return { res: r.res };
    return { lista: arr(r.json, "products") };
  };
  const limpiaProducto = (x: Args): Args => ({
    id: str(x.id).trim(), label: str(x.label).trim(), url: str(x.url).trim(),
    currency: str(x.currency).trim().toLowerCase(), msg: str(x.msg).trim(), site: str(x.site).trim(),
    price: Number(x.price) > 0 ? Number(x.price) : undefined, tag: str(x.tag).trim(), active: x.active === false ? false : true,
  });
  const zonaValida = (tz: string) => { try { new Intl.DateTimeFormat("es-ES", { timeZone: tz }); return true; } catch { return false; } };
  const MOVIMIENTO = S.obj("{ de, a, pipeline? }: a qué etapa pasan las oportunidades de una etapa que desaparece o cambia de nombre.");

  return [
    // ── Actividad ──
    {
      name: "listar_actividad", title: "Registro de actividad", alcance: "lectura", annotations: LEE,
      description: "Qué ha hecho el panel y qué ha fallado: publicaciones, difusiones, trabajos del stack, avisos de Meta, envíos, la IA, "
        + "boletines, webhooks… Filtra por origen, nivel, estado, texto y periodo. Solo pueden verlo los propietarios y administradores "
        + "del negocio (a otros roles el panel les dice que no). Sin con_detalle, cada registro llega sin su carga completa (payload).",
      inputSchema: esquema({
        origen: S.en("Origen del registro.", ORIGENES_ACTIVIDAD),
        nivel: S.en("info, warn o error.", NIVELES_ACTIVIDAD),
        estados: S.lista("Estados a incluir (hasta 12), p. ej. error, done, failed."),
        texto: S.txt("Texto a buscar (hasta 120 caracteres)."),
        desde: S.fecha("Desde cuándo."),
        hasta: S.fecha("Hasta cuándo."),
        orden: S.en("desc = lo más reciente primero (por defecto).", ["asc", "desc"]),
        con_detalle: S.bool("true = incluye la carga completa de cada registro (payload). Por defecto false."),
        ...PAGINA,
      }),
      rutas: ["/admin/api/activity"],
      run: async (a, c) => {
        const desde = ms(a.desde, c), hasta = ms(a.hasta, c);
        if (desde === null) return fallo("No entiendo la fecha de «desde».");
        if (hasta === null) return fallo("No entiendo la fecha de «hasta».");
        const por = entero(a.por_pagina, 50, 1, 200), pag = entero(a.pagina, 1, 1, 100000);
        const r = await lee(c, "/admin/api/activity?" + qs({
          source: str(a.origen), level: str(a.nivel), status: lista(a.estados), q: str(a.texto), from: desde, to: hasta,
          order: str(a.orden), limit: por, offset: (pag - 1) * por,
        }));
        if (r.res) return r.res;
        const p = (r.json.pagination && typeof r.json.pagination === "object" ? r.json.pagination : {}) as Args;
        const registros = arr(r.json, "activity").map((e) => (a.con_detalle === true ? e : sin(e, ["payload"])));
        return salida({ total_aprox: p.total, pagina: pag, por_pagina: por, truncado: p.truncated === true, registros });
      },
    },
    {
      name: "contadores_actividad", title: "Contadores de actividad", alcance: "lectura", annotations: LEE,
      description: "Cuántos registros y cuántos errores hubo en las últimas 24 h, y el reparto por origen. Solo propietarios y administradores.",
      inputSchema: esquema({}),
      rutas: ["/admin/api/activity/counters"],
      run: async (_a, c) => llamar(c, "GET", "/admin/api/activity/counters"),
    },
    {
      name: "borrar_registro_actividad", title: "Borrar un registro de actividad", alcance: "completo", annotations: BORRA,
      description: "Quita UN registro del registro de actividad. Los que vienen de otra parte (su id empieza por autopost:, scheduled-post:, "
        + "broadcast:, mcp-job: o lead-job:) no se borran aquí: habría que borrar la publicación, la difusión o el trabajo. "
        + "Para vaciar por antigüedad: vaciar_actividad. Solo propietarios y administradores.",
      inputSchema: esquema({ id: S.txt("id del registro (listar_actividad)."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/activity"],
      run: async (a, c) => {
        const id = str(a.id).trim();
        if (!id) return fallo("Falta el id del registro.");
        if (/^(autopost|scheduled-post|broadcast|mcp-job|lead-job):/.test(id)) return fallo("Ese registro viene de otra parte (" + id.split(":")[0] + ") y no se borra desde aquí.");
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar el registro «" + id + "» no tiene vuelta atrás.");
        return llamar(c, "DELETE", "/admin/api/activity/" + enc(id), undefined, true);
      },
    },
    {
      name: "vaciar_actividad", title: "Vaciar el registro de actividad", alcance: "completo", annotations: BORRA,
      description: "Borra los registros de actividad más antiguos que N días. dias_antiguedad admite SOLO 0, 7, 30, 90 o 365; 0 = TODO el "
        + "registro. Sin vuelta atrás. Solo propietarios y administradores.",
      inputSchema: esquema({ dias_antiguedad: S.int("0, 7, 30, 90 o 365. 0 = borrar TODO el registro."), ...CONFIRMA }, ["dias_antiguedad"]),
      rutas: ["/admin/api/activity/purgar"],
      run: async (a, c) => {
        const d = Number(a.dias_antiguedad);
        if (!DIAS_VACIADO.includes(d)) return fallo("dias_antiguedad solo admite 0, 7, 30, 90 o 365 (cualquier otro valor el panel lo trataría como 0 = todo).");
        if (a.confirmado_por_humano !== true) return noConfirmado(d === 0 ? "Vaciar TODO el registro de actividad no tiene vuelta atrás." : "Borrar los registros de más de " + d + " días no tiene vuelta atrás.");
        return llamar(c, "POST", "/admin/api/activity/purgar", { olderThanDays: d }, true);
      },
    },

    // ── Contactos ──
    {
      name: "buscar_contactos_avanzado", title: "Buscar contactos (todos los filtros)", alcance: "lectura", annotations: LEE,
      description: "La búsqueda de la vista Contactos con TODOS sus filtros: texto, etiquetas (todas a la vez), etapa, pipeline, origen, cuenta "
        + "propia por la que entró, web de systeme.io, con o sin mensajes, atendido por humano, dentro de la ventana de 24 h, puntuación "
        + "mínima, lista de claves, con compra, y periodo por fecha de alta o de último mensaje. Devuelve los contactos de la página y los "
        + "totales (filtrado, total, en ventana). Para una búsqueda sencilla vale buscar_contactos; para la ficha completa, ver_contacto.",
      inputSchema: esquema({
        texto: S.txt("Nombre, teléfono, correo o parte."),
        etiquetas: S.lista("Solo contactos con TODAS estas etiquetas (hasta 100)."),
        etapa: S.txt("Etapa; «__none__» = sin etapa."),
        pipeline: S.txt("id del pipeline; «__none__» = sin pipeline."),
        origen: S.txt("Origen (whatsapp, instagram, facebook, web…); «__none__» = sin origen."),
        cuenta: S.txt("Cuenta propia por la que entró; «(sin cuenta)» = ninguna."),
        web: S.txt("id de la web de systeme.io en la que está; «__none__» = en ninguna; «__sincuenta__» = sin web asignada."),
        mensajes: S.en("con = han escrito alguna vez; sin = nunca.", ["con", "sin"]),
        atendido_por_humano: S.bool("true = chats en «Atender yo»; false = los que lleva la IA."),
        en_ventana: S.bool("true = se les puede escribir sin plantilla (ventana de 24 h abierta); false = fuera de ventana."),
        puntuacion_minima: S.num("Puntuación mínima del contacto."),
        telefonos: S.lista("Solo estos contactos (hasta 800 claves)."),
        con_compra: S.bool("true = han comprado; false = no."),
        fecha_por: S.en("Qué fecha acotan desde/hasta: alta (created_at, por defecto) o último mensaje recibido (last_inbound).", ["created_at", "last_inbound"]),
        desde: S.fecha("Inicio del periodo."),
        hasta: S.fecha("Fin del periodo."),
        orden: S.en("Campo de orden (último mensaje por defecto).", ORDEN_CONTACTOS),
        direccion: S.en("asc o desc.", ["asc", "desc"]),
        campos: S.lista("Deja solo estas claves por contacto (p. ej. phone, name, email, tags, stage, last_inbound)."),
        ...PAGINA,
      }),
      rutas: ["/admin/api/contacts"],
      run: async (a, c) => {
        const desde = ms(a.desde, c), hasta = ms(a.hasta, c);
        if (desde === null) return fallo("No entiendo la fecha de «desde».");
        if (hasta === null) return fallo("No entiendo la fecha de «hasta».");
        const ruta = "/admin/api/contacts?" + qs({
          q: str(a.texto), tags: lista(a.etiquetas), stage: str(a.etapa), pipeline: str(a.pipeline), source: str(a.origen),
          account: str(a.cuenta), sio: str(a.web), msgs: str(a.mensajes), human: bool3(a.atendido_por_humano), window: bool3(a.en_ventana),
          minScore: a.puntuacion_minima === undefined || a.puntuacion_minima === null ? "" : Number(a.puntuacion_minima),
          phones: lista(a.telefonos), compra: a.con_compra === undefined || a.con_compra === null ? "" : a.con_compra === true ? 1 : 0,
          // Sin fecha_por, el periodo cuenta por alta (como dice la descripción): sin campo el panel no filtra por fechas.
          dfield: str(a.fecha_por) || (desde !== undefined || hasta !== undefined ? "created_at" : ""), dfrom: desde, dto: hasta, sort: str(a.orden), dir: str(a.direccion),
          page: entero(a.pagina, 1, 1, 100000), per: entero(a.por_pagina, 50, 1, 200),
        });
        return llamar(c, "GET", ruta, undefined, undefined, lista(a.campos));
      },
    },
    {
      name: "embudos_contacto", title: "Embudos de un contacto", alcance: "lectura", annotations: LEE,
      description: "En qué embudos de systeme.io ha entrado un contacto y hasta qué paso llegó (se cruza por teléfono y por correo).",
      inputSchema: esquema({ telefono: S.txt("Clave del contacto: teléfono, id de Instagram/Facebook o «email:correo».") }, ["telefono"]),
      rutas: ["/admin/api/contacts/:phone/funnels"],
      run: async (a, c) => {
        const p = claveContacto(a);
        if (!p) return fallo("Falta la clave del contacto.");
        return llamar(c, "GET", "/admin/api/contacts/" + enc(p) + "/funnels");
      },
    },
    {
      name: "respuestas_formulario_contacto", title: "Respuestas de formulario de un contacto", alcance: "lectura", annotations: LEE,
      description: "Lo que un contacto contestó en los formularios (las 100 respuestas más recientes), con el estado del envío a la web.",
      inputSchema: esquema({ telefono: S.txt("Clave del contacto: teléfono, id de Instagram/Facebook o «email:correo»."), ...PAGINA }, ["telefono"]),
      rutas: ["/admin/api/contacts/:phone/form-responses"],
      run: async (a, c) => {
        const p = claveContacto(a);
        if (!p) return fallo("Falta la clave del contacto.");
        const r = await lee(c, "/admin/api/contacts/" + enc(p) + "/form-responses");
        if (r.res) return r.res;
        return salida(paginar(arr(r.json, "rows"), a));
      },
    },
    {
      name: "borrar_contacto", title: "Borrar un contacto", alcance: "completo", annotations: BORRA,
      description: "Elimina la ficha de un contacto del CRM (nombre, etiquetas, etapa, notas…). No tiene vuelta atrás: confírmalo con el usuario.",
      inputSchema: esquema({ telefono: S.txt("Clave del contacto: teléfono, id de Instagram/Facebook o «email:correo»."), ...CONFIRMA }, ["telefono"]),
      rutas: ["/admin/api/contacts/:phone"],
      run: async (a, c) => {
        const p = claveContacto(a);
        if (!p) return fallo("Falta la clave del contacto.");
        const f = await ficha(c, p);
        if (!f) return fallo("No hay ningún contacto con la clave «" + p + "».");
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar a «" + nombreDe(f, p) + "» elimina su ficha y no tiene vuelta atrás.");
        return llamar(c, "DELETE", "/admin/api/contacts/" + enc(p), undefined, true);
      },
    },
    {
      name: "enviar_contactos_a_web", title: "Mandar contactos a una web", alcance: "completo", annotations: SALE,
      description: "Encola el envío de varios contactos (hasta 500) a UNA web de systeme.io conectada; crea o actualiza allí a cada persona por su "
        + "correo. Los que no tienen correo o no existen se devuelven aparte (sinEmail, fallaron). Sale fuera del panel: confírmalo.",
      inputSchema: esquema({
        telefonos: S.lista("Claves de los contactos (1-500)."),
        web: S.txt("id de la web de systeme.io conectada (estado_conexiones)."),
        ...CONFIRMA,
      }, ["telefonos", "web"]),
      rutas: ["/admin/api/contacts/sync-bulk"],
      run: async (a, c) => {
        const phones = (lista(a.telefonos) || []).map((v) => claveContacto({ telefono: v })).filter(Boolean);
        const web = str(a.web).trim();
        if (!phones.length) return fallo("Falta la lista de contactos.");
        if (phones.length > 500) return fallo("Como mucho 500 contactos de una vez (van " + phones.length + ").");
        if (!web) return fallo("Falta la web a la que mandarlos.");
        if (a.confirmado_por_humano !== true) return noConfirmado("Mandar " + phones.length + " contacto(s) a la web «" + web + "» los crea o actualiza allí.");
        return llamar(c, "POST", "/admin/api/contacts/sync-bulk", { phones, accountId: web }, true);
      },
    },
    {
      name: "etiquetas_con_contactos", title: "Etiquetas y cuántos contactos tienen cada una", alcance: "lectura", annotations: LEE,
      description: "Las etiquetas en uso con el número de contactos de cada una, filtradas por texto (las de etapa no cuentan). "
        + "Para el catálogo con descripciones: listar_etiquetas.",
      inputSchema: esquema({ texto: S.txt("Parte del nombre (hasta 80 caracteres)."), limite: S.int("Cuántas como mucho (1-200, 60 por defecto).", { minimum: 1, maximum: 200 }) }),
      rutas: ["/admin/api/contacts/etiquetas"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/contacts/etiquetas?" + qs({ q: str(a.texto).slice(0, 80), limit: entero(a.limite, 60, 1, 200) })),
    },

    // ── Reuniones ──
    {
      name: "listar_reuniones", title: "Reuniones", alcance: "lectura", annotations: LEE,
      description: "Las reuniones apuntadas en las fichas (reuniones), las reservas que llegan de las webs (reservas), las webs con calendario "
        + "(cuentas) y los ajustes de los avisos (ajustes: plantilla, idioma, zona horaria, eventos).",
      inputSchema: esquema({ solo_futuras: S.bool("true = solo las reuniones que aún no han pasado."), ...PAGINA }),
      rutas: ["/admin/api/meetings"],
      run: async (a, c) => {
        const r = await lee(c, "/admin/api/meetings");
        if (r.res) return r.res;
        const ahora = Date.now();
        const reuniones = arr(r.json, "meetings").filter((m) => a.solo_futuras !== true || Number(m.at) >= ahora);
        return salida({ reuniones: paginar(reuniones, a), reservas: paginar(arr(r.json, "bookings"), a), cuentas: r.json.cuentas, ajustes: r.json.ajustes });
      },
    },
    {
      name: "agendar_reunion", title: "Agendar una reunión", alcance: "completo", annotations: CAMBIA,
      description: "Apunta (o cambia) la reunión de un contacto: fecha y hora, título y, si procede, la web de systeme.io que la lleva. "
        + "Los flujos de aviso configurados mandan los recordatorios solos. Si la reunión va asociada a una web (la que indiques o la que "
        + "ya tenía), el panel la sincroniza allí: en ese caso pide confirmado_por_humano: true.",
      inputSchema: esquema({
        telefono: S.txt("Clave del contacto: teléfono, id de Instagram/Facebook o «email:correo»."),
        fecha: S.fecha("Cuándo es la reunión (con hora)."),
        titulo: S.txt("Qué reunión es (p. ej. «Llamada de descubrimiento»)."),
        web: S.txt("id de la web de systeme.io que lleva la reunión (listar_reuniones → cuentas). Vacío = no cambiarla."),
        ...CONFIRMA,
      }, ["telefono", "fecha"]),
      rutas: ["/admin/api/contacts/:phone"],
      run: async (a, c) => {
        const p = claveContacto(a);
        if (!p) return fallo("Falta la clave del contacto.");
        const cuando = msEnZona(a.fecha, c.zona);
        if (cuando === null) return fallo("No entiendo la fecha de la reunión.");
        const f = await ficha(c, p);
        if (!f) return fallo("No hay ningún contacto con la clave «" + p + "».");
        const web = str(a.web).trim();
        const conWeb = web || str(f.next_action_account).trim();
        if (conWeb && a.confirmado_por_humano !== true) return noConfirmado("La reunión de «" + nombreDe(f, p) + "» se sincroniza con la web «" + conWeb + "».");
        const cuerpo: Args = { next_action_at: cuando };
        if (a.titulo !== undefined) cuerpo.next_action_label = str(a.titulo).trim();
        if (web) cuerpo.next_action_account = web;
        // Sin syncAccountId el panel no encola nada y la cita queda «no enviada» en la web.
        if (conWeb) cuerpo.syncAccountId = conWeb;
        return llamar(c, "PUT", "/admin/api/contacts/" + enc(p), cuerpo, true);
      },
    },
    {
      name: "cancelar_reunion", title: "Cancelar la reunión de un contacto", alcance: "completo", annotations: CAMBIA,
      description: "Quita la reunión apuntada en la ficha de un contacto (fecha, título y web). Si estaba asociada a una web de systeme.io, "
        + "el panel la cancela allí también: en ese caso pide confirmado_por_humano: true.",
      inputSchema: esquema({ telefono: S.txt("Clave del contacto: teléfono, id de Instagram/Facebook o «email:correo»."), ...CONFIRMA }, ["telefono"]),
      rutas: ["/admin/api/contacts/:phone"],
      run: async (a, c) => {
        const p = claveContacto(a);
        if (!p) return fallo("Falta la clave del contacto.");
        const f = await ficha(c, p);
        if (!f) return fallo("No hay ningún contacto con la clave «" + p + "».");
        if (!Number(f.next_action_at)) return fallo("«" + nombreDe(f, p) + "» no tiene ninguna reunión apuntada.");
        const web = str(f.next_action_account).trim();
        if (web && a.confirmado_por_humano !== true) return noConfirmado("La reunión de «" + nombreDe(f, p) + "» está asociada a la web «" + web + "» y se cancelará también allí.");
        // Sin syncAccountId la baja solo se aplicaba en el CRM; con él el panel la encola en la web.
        const cuerpo: Args = { next_action_at: null, next_action_label: "" };
        if (web) cuerpo.syncAccountId = web;
        return llamar(c, "PUT", "/admin/api/contacts/" + enc(p), cuerpo, true);
      },
    },
    {
      name: "cambiar_zona_reuniones", title: "Zona horaria de las reuniones", alcance: "completo", annotations: IDEMP,
      description: "Cambia la zona horaria con la que se escriben las horas en los avisos de reunión de TODO el negocio (formato IANA, "
        + "p. ej. Europe/Madrid; vacío = volver a la del servidor). Afecta a todos los avisos: confírmalo con el usuario.",
      inputSchema: esquema({ zona: S.txt("Zona horaria IANA; vacío = quitarla."), ...CONFIRMA }),
      rutas: ["/admin/api/meetings/settings"],
      run: async (a, c) => {
        const tz = str(a.zona).trim();
        if (tz && !zonaValida(tz)) return fallo("«" + tz + "» no es una zona horaria válida: usa el formato IANA, p. ej. Europe/Madrid.");
        if (a.confirmado_por_humano !== true) return noConfirmado(tz ? "Todos los avisos de reunión pasarán a escribir la hora en " + tz + "." : "Los avisos de reunión volverán a la hora del servidor.");
        return llamar(c, "POST", "/admin/api/meetings/settings", { tz }, true);
      },
    },

    // ── Oportunidades y pipelines ──
    {
      name: "listar_oportunidades", title: "Oportunidades", alcance: "lectura", annotations: LEE,
      description: "Las tarjetas del tablero de un pipeline (o las de un contacto): etapa, valor, responsable, desenlace, siguiente paso. "
        + "Incluye cuántas hay por etapa (counts) y el equipo (closers). Con etapa, filtra las de esa etapa.",
      inputSchema: esquema({
        pipeline: S.txt("id del pipeline (listar_pipelines). Vacío = el primero."),
        telefono: S.txt("Solo las oportunidades de este contacto."),
        etapa: S.txt("Solo las que están en esta etapa."),
        ...PAGINA,
      }),
      rutas: ["/admin/api/opps"],
      run: async (a, c) => {
        // Vacío = el primero, como el tablero del panel: sin pipeline ni contacto, la ruta no devuelve tarjetas.
        let pipeline = str(a.pipeline).trim();
        if (!pipeline && !str(a.telefono).trim()) {
          const ps = await pipelinesActuales(c);
          if (ps.res) return ps.res;
          if (!ps.lista?.length) return fallo("No hay ningún pipeline (crea uno con guardar_pipeline).");
          pipeline = ps.lista[0].id;
        }
        const r = await lee(c, "/admin/api/opps?" + qs({ pipeline, phone: str(a.telefono) ? claveContacto(a) : "" }));
        if (r.res) return r.res;
        const etapa = str(a.etapa).trim();
        const opps = arr(r.json, "opps").filter((o) => !etapa || str(o.stage) === etapa);
        return salida({ ...paginar(opps, a), pipeline: pipeline || undefined, truncado: r.json.truncated === true, por_etapa: r.json.counts, equipo: r.json.closers });
      },
    },
    {
      name: "crear_oportunidad", title: "Crear una oportunidad", alcance: "completo", annotations: CAMBIA,
      description: "Añade una tarjeta al tablero para un contacto que ya existe, en una etapa del pipeline (la ficha del contacto pasa a esa etapa). "
        + "Para mover una ya creada: editar_oportunidad.",
      inputSchema: esquema({
        telefono: S.txt("Clave del contacto."),
        pipeline: S.txt("id del pipeline (listar_pipelines)."),
        etapa: S.txt("Etapa del pipeline en la que entra."),
        valor: S.num("Valor estimado (número)."),
        responsable: S.txt("Quién la lleva: clave del miembro del equipo (listar_oportunidades → closers)."),
      }, ["telefono", "pipeline", "etapa"]),
      rutas: ["/admin/api/opps"],
      run: async (a, c) => {
        const p = claveContacto(a);
        if (!p) return fallo("Falta la clave del contacto.");
        const cuerpo: Args = { phone: p, pipeline_id: str(a.pipeline).trim(), stage: str(a.etapa).trim() };
        if (a.valor !== undefined && a.valor !== null && str(a.valor) !== "") cuerpo.value = Number(a.valor);
        if (str(a.responsable).trim()) cuerpo.owner = str(a.responsable).trim();
        return llamar(c, "POST", "/admin/api/opps", cuerpo);
      },
    },
    {
      name: "editar_oportunidad", title: "Editar una oportunidad", alcance: "completo", annotations: CAMBIA,
      description: "Cambia una tarjeta del tablero: etapa (vacía = «Por colocar»), responsable (vacío = nadie), valor, y el siguiente paso con su fecha.",
      inputSchema: esquema({
        id: S.int("id de la oportunidad (listar_oportunidades)."),
        etapa: S.txt("Nueva etapa; «» = por colocar."),
        responsable: S.txt("Clave del miembro del equipo; «» = nadie."),
        valor: S.num("Valor estimado (número)."),
        siguiente_paso: S.txt("Qué toca hacer (hasta 160 caracteres); «» = quitarlo."),
        siguiente_paso_fecha: S.fecha("Para cuándo."),
        quitar_fecha_siguiente_paso: S.bool("true = borrar la fecha del siguiente paso."),
      }, ["id"]),
      rutas: ["/admin/api/opps"],
      run: async (a, c) => {
        const id = Number(a.id);
        if (!Number.isInteger(id) || id <= 0) return fallo("Falta el id de la oportunidad.");
        const cuerpo: Args = {};
        if (a.etapa !== undefined && a.etapa !== null) cuerpo.stage = str(a.etapa).trim();
        if (a.responsable !== undefined && a.responsable !== null) cuerpo.owner = str(a.responsable).trim();
        if (a.valor !== undefined && a.valor !== null && str(a.valor) !== "") cuerpo.value = Number(a.valor);
        if (a.siguiente_paso !== undefined && a.siguiente_paso !== null) cuerpo.next_action = str(a.siguiente_paso).trim().slice(0, 160);
        if (a.quitar_fecha_siguiente_paso === true) cuerpo.next_at = "";
        else if (a.siguiente_paso_fecha !== undefined && a.siguiente_paso_fecha !== null && str(a.siguiente_paso_fecha) !== "") {
          const cuando = msEnZona(a.siguiente_paso_fecha, c.zona);
          if (cuando === null) return fallo("No entiendo la fecha del siguiente paso.");
          cuerpo.next_at = cuando;
        }
        if (!Object.keys(cuerpo).length) return fallo("No has indicado ningún cambio.");
        return llamar(c, "POST", "/admin/api/opps/" + enc(String(id)), cuerpo);
      },
    },
    {
      name: "borrar_oportunidad", title: "Borrar una oportunidad", alcance: "completo", annotations: BORRA,
      description: "Quita una tarjeta del tablero (el contacto sigue existiendo). No tiene vuelta atrás: confírmalo con el usuario.",
      inputSchema: esquema({ id: S.int("id de la oportunidad."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/opps"],
      run: async (a, c) => {
        const id = Number(a.id);
        if (!Number.isInteger(id) || id <= 0) return fallo("Falta el id de la oportunidad.");
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar la oportunidad " + id + " no tiene vuelta atrás.");
        return llamar(c, "DELETE", "/admin/api/opps/" + enc(String(id)), undefined, true);
      },
    },
    {
      name: "conteo_pipeline", title: "Cuántas oportunidades hay por etapa", alcance: "lectura", annotations: LEE,
      description: "El recuento REAL de oportunidades en cada etapa de un pipeline (también las de etapas que ya no existen, «por colocar»). "
        + "Útil antes de quitar o renombrar una etapa.",
      inputSchema: esquema({ pipeline: S.txt("id del pipeline (listar_pipelines).") }, ["pipeline"]),
      rutas: ["/admin/api/pipelines/conteo"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/pipelines/conteo?" + qs({ id: str(a.pipeline).trim() })),
    },
    {
      name: "guardar_pipeline", title: "Crear o editar un pipeline", alcance: "completo", annotations: CAMBIA,
      description: "Crea un pipeline (sin id) o cambia uno (con id): nombre, etapas en orden, y cuál cuenta como ganada o perdida. Los demás "
        + "pipelines no se tocan. Si quitas o renombras una etapa con oportunidades dentro, el panel exige decir a dónde pasan "
        + "(movimientos: [{ de, a }]); si no, responde con las pendientes y no guarda nada. Editar uno existente pide confirmado_por_humano: true.",
      inputSchema: esquema({
        id: S.txt("id del pipeline a editar; vacío = crear uno nuevo."),
        nombre: S.txt("Nombre del pipeline."),
        etapas: S.lista("Etapas en orden (al editar, sustituyen a las actuales)."),
        ganada: S.txt("Etapa que cuenta como ganada; «» = ninguna."),
        perdida: S.txt("Etapa que cuenta como perdida; «» = ninguna."),
        movimientos: { type: "array", items: MOVIMIENTO, description: "A qué etapa pasan las oportunidades de cada etapa que desaparece: [{ de, a }]." },
        ...CONFIRMA,
      }),
      rutas: ["/admin/api/pipelines"],
      run: async (a, c) => {
        const actuales = await pipelinesActuales(c);
        if (actuales.res) return actuales.res;
        const todos = actuales.lista || [];
        const id = str(a.id).trim();
        const previo = id ? todos.find((p) => p.id === id) : undefined;
        if (id && !previo) return fallo("No hay ningún pipeline con id «" + id + "» (listar_pipelines).");
        const etapas = (lista(a.etapas) || []).map((s) => s.trim()).filter(Boolean);
        if (!previo && !etapas.length) return fallo("Un pipeline nuevo necesita sus etapas.");
        const nombre = str(a.nombre).trim() || previo?.name || "";
        if (!nombre) return fallo("Falta el nombre del pipeline.");
        const nuevo = {
          id: previo ? previo.id : idLibre(nombre, new Set(todos.map((p) => p.id)), "pipeline"),
          name: nombre,
          stages: etapas.length ? etapas : previo?.stages || [],
          won: a.ganada !== undefined && a.ganada !== null ? str(a.ganada).trim() : previo?.won || "",
          lost: a.perdida !== undefined && a.perdida !== null ? str(a.perdida).trim() : previo?.lost || "",
        };
        if (previo && a.confirmado_por_humano !== true) {
          const fuera = previo.stages.filter((s) => !nuevo.stages.includes(s));
          return noConfirmado("Editar el pipeline «" + previo.name + "»" + (fuera.length ? " quita las etapas " + fuera.join(", ") + " (sus oportunidades necesitan movimientos)." : "."));
        }
        const pipelines = previo ? todos.map((p) => (p.id === previo.id ? nuevo : p)) : [...todos, nuevo];
        const r = await llamar(c, "POST", "/admin/api/pipelines", { pipelines, moves: movimientosDe(a, nuevo.id) }, true);
        return r.error ? r : { ...r, texto: k.compactar(JSON.stringify({ ok: true, pipeline: nuevo })) };
      },
    },
    {
      name: "borrar_pipeline", title: "Borrar un pipeline", alcance: "completo", annotations: BORRA,
      description: "Elimina un pipeline que NO tenga oportunidades. El panel no borra las de un pipeline al quitarlo: si tiene, se rechaza y hay que "
        + "quitarlas antes con borrar_oportunidad. Tiene que quedar al menos otro. No tiene vuelta atrás: confírmalo con el usuario.",
      inputSchema: esquema({ id: S.txt("id del pipeline."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/pipelines"],
      run: async (a, c) => {
        const actuales = await pipelinesActuales(c);
        if (actuales.res) return actuales.res;
        const todos = actuales.lista || [];
        const id = str(a.id).trim();
        const previo = todos.find((p) => p.id === id);
        if (!previo) return fallo("No hay ningún pipeline con id «" + id + "».");
        if (todos.length < 2) return fallo("Es el único pipeline: el panel necesita al menos uno.");
        const cuenta = await api(c, "GET", "/admin/api/pipelines/conteo?" + qs({ id }));
        const total = cuenta.status === 200 ? totalOportunidades(parse(cuenta.texto)) : null;
        if (total === null) return fallo("No pude contar las oportunidades de «" + previo.name + "»: no se ha borrado nada.");
        if (total > 0) return fallo("El pipeline «" + previo.name + "» tiene " + total + " oportunidad(es) y el panel no las borra al quitarlo. Bórralas antes con borrar_oportunidad (listar_oportunidades con pipeline=" + id + ") y repite.");
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar el pipeline «" + previo.name + "» (sin oportunidades) no tiene vuelta atrás.");
        return llamar(c, "POST", "/admin/api/pipelines", { pipelines: todos.filter((p) => p.id !== id) }, true);
      },
    },
    {
      name: "guardar_pipelines", title: "Guardar todos los pipelines", alcance: "completo", annotations: CAMBIA,
      description: "Sustituye la lista COMPLETA de pipelines (orden incluido): cada uno con id, name, stages[], won y lost. Un pipeline que "
        + "no venga en la lista se BORRA (solo con permitir_borrar: true, y nunca si tiene oportunidades). Para tocar uno solo: guardar_pipeline. "
        + "Las etapas que desaparecen con oportunidades dentro exigen moves [{ pipeline_id, from, to }]. Pide confirmado_por_humano: true.",
      inputSchema: esquema({
        pipelines: { type: "array", items: S.obj("{ id, name, stages[], won?, lost? }"), description: "La lista completa, en el orden que tendrá el panel." },
        moves: { type: "array", items: S.obj("{ pipeline_id, from, to }"), description: "A qué etapa pasan las oportunidades de cada etapa que desaparece." },
        permitir_borrar: S.bool("true = acepta que los pipelines ausentes de la lista se eliminen."),
        ...CONFIRMA,
      }, ["pipelines"]),
      rutas: ["/admin/api/pipelines"],
      run: async (a, c) => {
        const pipelines = Array.isArray(a.pipelines) ? (a.pipelines as Args[]) : [];
        if (!pipelines.length) return fallo("Falta la lista de pipelines.");
        const actuales = await pipelinesActuales(c);
        if (actuales.res) return actuales.res;
        const ids = new Set(pipelines.map((p) => str(p.id)));
        const ausentes = (actuales.lista || []).filter((p) => !ids.has(p.id));
        if (ausentes.length && a.permitir_borrar !== true) return fallo("Faltan en la lista los pipelines " + ausentes.map((p) => p.name + " (" + p.id + ")").join(", ") + ": se borrarían. Añádelos o pasa permitir_borrar: true.");
        const conOpps: string[] = [];
        for (const p of ausentes) {
          const cuenta = await api(c, "GET", "/admin/api/pipelines/conteo?" + qs({ id: p.id }));
          const total = cuenta.status === 200 ? totalOportunidades(parse(cuenta.texto)) : null;
          if (total === null) return fallo("No pude contar las oportunidades de «" + p.name + "»: no se ha guardado nada.");
          if (total > 0) conOpps.push(p.name + " (" + total + ")");
        }
        if (conOpps.length) return fallo("Quitar " + conOpps.join(", ") + " borraría sus oportunidades, y el panel no las borra al quitar un pipeline. Quítalas antes con borrar_oportunidad o deja el pipeline en la lista.");
        if (a.confirmado_por_humano !== true) return noConfirmado("Guardar los pipelines sustituye la lista entera" + (ausentes.length ? " y borra " + ausentes.length + " pipeline(s)" : "") + ".");
        return llamar(c, "POST", "/admin/api/pipelines", { pipelines, moves: Array.isArray(a.moves) ? a.moves : [] }, true);
      },
    },

    // ── Etiquetas ──
    {
      name: "describir_etiqueta", title: "Describir una etiqueta", alcance: "completo", annotations: IDEMP,
      description: "Pone o cambia la descripción de una etiqueta (lo que ve el equipo al pasar por encima). Vacía = quitarla.",
      inputSchema: esquema({ nombre: S.txt("Nombre exacto de la etiqueta."), descripcion: S.txt("Descripción; vacía = quitarla.") }, ["nombre"]),
      rutas: ["/admin/api/tags"],
      run: async (a, c) => {
        const nombre = str(a.nombre).trim();
        if (!nombre) return fallo("Falta el nombre de la etiqueta.");
        return llamar(c, "POST", "/admin/api/tags", { action: "desc", name: nombre, desc: str(a.descripcion) });
      },
    },
    {
      name: "uso_etiqueta", title: "Qué usa una etiqueta", alcance: "lectura", annotations: LEE,
      description: "Cuántos contactos tienen la etiqueta, si es del sistema, y qué flujos, bots, difusiones o ajustes la nombran (usos). "
        + "Con nuevo_nombre, dice si se puede renombrar a ese nombre. Úsalo antes de renombrar o borrar una etiqueta.",
      inputSchema: esquema({ nombre: S.txt("Nombre exacto de la etiqueta."), nuevo_nombre: S.txt("Nombre al que se quiere renombrar (opcional).") }, ["nombre"]),
      rutas: ["/admin/api/tags/uso"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/tags/uso?" + qs({ name: str(a.nombre).trim(), nuevo: str(a.nuevo_nombre).trim() })),
    },
    {
      name: "sincronizar_etiquetas_web", title: "Sincronizar etiquetas con systeme.io", alcance: "completo", annotations: SALE,
      description: "Crea en una web de systeme.io las etiquetas del panel. Con etiquetas: solo esas (sin importar nada). Sin etiquetas: todas las "
        + "del catálogo y las usadas por contactos, e importa al panel las que la web tenga de más. Respuesta 207 = parcial (pushed/failed); "
        + "502 = no se creó ninguna. Sale fuera del panel: confírmalo.",
      inputSchema: esquema({
        web: S.txt("id de la web de systeme.io conectada (estado_conexiones). Vacío = la principal."),
        etiquetas: S.lista("Solo estas etiquetas; vacío = todas (y se importan las de la web)."),
        ...CONFIRMA,
      }),
      rutas: ["/admin/api/tags"],
      run: async (a, c) => {
        const etiquetas = (lista(a.etiquetas) || []).map((s) => s.trim()).filter(Boolean);
        if (a.confirmado_por_humano !== true) return noConfirmado(etiquetas.length ? "Se crearán " + etiquetas.length + " etiqueta(s) en la web." : "Se crearán en la web todas las etiquetas del panel y se importarán las suyas.");
        const cuerpo: Args = { action: "sync-systemeio" };
        if (str(a.web).trim()) cuerpo.accountId = str(a.web).trim();
        if (etiquetas.length) cuerpo.tags = etiquetas;
        return llamar(c, "POST", "/admin/api/tags", cuerpo, true);
      },
    },

    // ── Enlaces medidos ──
    {
      name: "listar_enlaces_medidos", title: "Enlaces medidos", alcance: "lectura", annotations: LEE,
      description: "Los enlaces cortos que mide el panel con sus clics y personas. Agrupados (por defecto) = una fila por enlace real aunque "
        + "cada contacto reciba el suyo; sin agrupar = una fila por enlace personal (máximo 500). dias recorta clics y personas a los últimos "
        + "N días (0 = todo). Devuelve también el resumen y las personas únicas.",
      inputSchema: esquema({
        agrupar: S.bool("false = una fila por enlace personal. Por defecto true."),
        incluir_ocultos: S.bool("true = también los ocultados."),
        dias: S.int("Últimos N días (0 = todo, por defecto).", { minimum: 0, maximum: 3650 }),
        texto: S.txt("Filtra por nombre, destino o clave."),
        ...PAGINA,
      }),
      rutas: ["/admin/api/link-attendance"],
      run: async (a, c) => {
        const r = await lee(c, "/admin/api/link-attendance?" + qs({ agrupado: a.agrupar === false ? "" : "1", archived: a.incluir_ocultos === true ? "1" : "", dias: entero(a.dias, 0, 0, 3650) || "" }));
        if (r.res) return r.res;
        const q = str(a.texto).trim();
        const links = arr(r.json, "links").filter((l) => coincide(l, q, CAMPOS_ENLACE));
        return salida({ ...paginar(links, a), personas_unicas: r.json.uniquePeople, resumen: r.json.resumen, dias: r.json.dias, desde: r.json.desde, wrapOn: r.json.wrapOn, previewNoImage: r.json.previewNoImage });
      },
    },
    {
      name: "ver_enlace_medido", title: "Ver un enlace medido", alcance: "lectura", annotations: LEE,
      description: "Un enlace corto con sus últimos 100 clics (quién, cuándo, desde dónde). Con con_asistencia, añade el detalle de asistencia: "
        + "personas, pasos posteriores al clic (pago, web con píxel) y los demás enlaces al mismo destino.",
      inputSchema: esquema({
        enlace: S.txt("Clave del enlace corto (campo token de listar_enlaces_medidos)."),
        con_asistencia: S.bool("true = añade el detalle de asistencia."),
        dias: S.int("Para la asistencia: últimos N días (0 = todo).", { minimum: 0, maximum: 3650 }),
        ...PAGINA,
      }, ["enlace"]),
      rutas: ["/admin/api/links", "/admin/api/link-attendance"],
      run: async (a, c) => {
        const token = str(a.enlace).trim();
        if (!token) return fallo("Falta la clave del enlace.");
        const r = await lee(c, "/admin/api/links/" + enc(token));
        if (r.res) return r.res;
        if (!r.json.link) return fallo("No hay ningún enlace medido con la clave «" + token + "».");
        const out: Args = { enlace: r.json.link, clics: paginar(arr(r.json, "clicks"), a) };
        if (a.con_asistencia === true) {
          const d = await lee(c, "/admin/api/link-attendance?" + qs({ token, archived: "1", dias: entero(a.dias, 0, 0, 3650) || "" }));
          if (d.res) return d.res;
          out.asistencia = { seleccionado: d.json.selected, detalle: d.json.detail, pasos: d.json.pasos, mismo_destino: d.json.mismoDestino, dias: d.json.dias };
        }
        return salida(out);
      },
    },
    {
      name: "crear_enlace_medido", title: "Crear un enlace medido", alcance: "completo", annotations: CAMBIA,
      description: "Acorta una dirección y la deja medida (clics y personas) con un nombre. Devuelve el enlace corto listo para usar. "
        + "tipo y contexto lo asocian a un flujo, difusión o producto; déjalos vacíos si es un enlace suelto.",
      inputSchema: esquema({
        url: S.txt("Dirección de destino (con https://)."),
        nombre: S.txt("Nombre con el que se verá en la lista."),
        tipo: S.txt("Tipo de uso (manual por defecto)."),
        contexto: S.txt("id del flujo, difusión o producto al que pertenece (opcional)."),
      }, ["url"]),
      rutas: ["/admin/api/links/wrap"],
      run: async (a, c) => {
        const url = str(a.url).trim();
        if (!/^https?:\/\//i.test(url)) return fallo("La dirección tiene que empezar por https://.");
        return llamar(c, "POST", "/admin/api/links/wrap", { url, kind: str(a.tipo).trim() || "manual", id: str(a.contexto).trim(), label: str(a.nombre).trim() });
      },
    },
    {
      name: "editar_enlace_medido", title: "Renombrar u ocultar un enlace medido", alcance: "completo", annotations: IDEMP,
      description: "Cambia el nombre de un enlace medido o lo oculta de la lista (oculto: sigue redirigiendo y conserva sus clics; es la "
        + "alternativa a borrar cuando algo vivo lo usa). Con todo_el_grupo, se aplica a todos los enlaces personales del mismo enlace real.",
      inputSchema: esquema({
        enlace: S.txt("Clave del enlace corto."),
        nombre: S.txt("Nuevo nombre."),
        oculto: S.bool("true = ocultar; false = volver a mostrar."),
        todo_el_grupo: S.bool("true = aplicar a todo el grupo (fila de «Todos los medidos»)."),
      }, ["enlace"]),
      rutas: ["/admin/api/links"],
      run: async (a, c) => {
        const token = str(a.enlace).trim();
        if (!token) return fallo("Falta la clave del enlace.");
        const cuerpo: Args = { grupo: a.todo_el_grupo === true };
        if (a.nombre !== undefined && a.nombre !== null) cuerpo.label = str(a.nombre);
        if (typeof a.oculto === "boolean") cuerpo.archived = a.oculto;
        if (cuerpo.label === undefined && cuerpo.archived === undefined) return fallo("Indica un nombre nuevo u oculto: true/false.");
        return llamar(c, "POST", "/admin/api/links/" + enc(token) + "/edit", cuerpo);
      },
    },
    {
      name: "borrar_enlace_medido", title: "Borrar un enlace medido", alcance: "completo", annotations: BORRA,
      description: "Elimina un enlace corto y TODOS sus clics. Solo si nada vivo lo usa (un flujo, una difusión, un pago o un vídeo): si lo usa "
        + "algo, el panel lo rechaza y dice qué; entonces lo que procede es ocultarlo (editar_enlace_medido). Sin vuelta atrás: confírmalo.",
      inputSchema: esquema({ enlace: S.txt("Clave del enlace corto."), todo_el_grupo: S.bool("true = borrar todos los enlaces personales del mismo enlace real."), ...CONFIRMA }, ["enlace"]),
      rutas: ["/admin/api/links"],
      run: async (a, c) => {
        const token = str(a.enlace).trim();
        if (!token) return fallo("Falta la clave del enlace.");
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar el enlace «" + token + "»" + (a.todo_el_grupo === true ? " y todo su grupo" : "") + " elimina también sus clics y no tiene vuelta atrás.");
        return llamar(c, "DELETE", "/admin/api/links/" + enc(token) + (a.todo_el_grupo === true ? "?grupo=1" : ""), undefined, true);
      },
    },
    {
      name: "etiquetar_asistentes", title: "Etiquetar a quienes abrieron un enlace", alcance: "completo", annotations: CAMBIA,
      description: "Añade una etiqueta a una lista de contactos (p. ej. los que abrieron un enlace, sacados de ver_enlace_medido). Es una acción en "
        + "masa: confírmala con el usuario. Las demás etiquetas de cada contacto se conservan.",
      inputSchema: esquema({ etiqueta: S.txt("Etiqueta a añadir."), telefonos: S.lista("Claves de los contactos."), ...CONFIRMA }, ["etiqueta", "telefonos"]),
      rutas: ["/admin/api/link-attendance/tag"],
      run: async (a, c) => {
        const tag = str(a.etiqueta).trim();
        const phones = (lista(a.telefonos) || []).map((v) => claveContacto({ telefono: v })).filter(Boolean);
        if (!tag) return fallo("Falta la etiqueta.");
        if (!phones.length) return fallo("Falta la lista de contactos.");
        if (a.confirmado_por_humano !== true) return noConfirmado("Se añadirá la etiqueta «" + tag + "» a " + phones.length + " contacto(s).");
        return llamar(c, "POST", "/admin/api/link-attendance/tag", { tag, phones }, true);
      },
    },

    // ── Productos de pago ──
    {
      name: "ver_producto_pago", title: "Ventas de un producto", alcance: "lectura", annotations: LEE,
      description: "El detalle de un producto del catálogo de pagos: quién recibió su enlace, quién abrió y quién compró (gente), la línea de "
        + "tiempo y las compras sin contacto. dias recorta el periodo (0 = todo). Para el resumen de todos: ventas_productos.",
      inputSchema: esquema({ id: S.txt("id del producto (ventas_productos)."), dias: S.int("Últimos N días (0 = todo).", { minimum: 0, maximum: 365 }), ...PAGINA }, ["id"]),
      rutas: ["/admin/api/payment-products/detalle"],
      run: async (a, c) => {
        const r = await lee(c, "/admin/api/payment-products/detalle?" + qs({ id: str(a.id).trim(), dias: a.dias === undefined || a.dias === null ? "" : entero(a.dias, 0, 0, 365) }));
        if (r.res) return r.res;
        return salida({ ...sin(r.json, ["gente"]), gente: paginar(arr(r.json, "gente"), a) });
      },
    },
    {
      name: "guardar_producto_pago", title: "Crear o editar un producto de pago", alcance: "completo", annotations: CAMBIA,
      description: "Crea un producto del catálogo de pagos (sin id) o cambia uno (con id): nombre, página de pago, divisa, frase que va delante del "
        + "enlace, web, precio, etiqueta al comprar y si está activo. Los demás productos no se tocan. Editar uno pide confirmado_por_humano: true.",
      inputSchema: esquema({
        id: S.txt("id del producto a editar; vacío = crear uno nuevo."),
        nombre: S.txt("Nombre que ve el equipo (p. ej. «Pago EUR»)."),
        url: S.txt("Página de pago real (con https://)."),
        divisa: S.txt("eur, usd… (al comprar se etiqueta compra-<divisa>)."),
        mensaje: S.txt("Frase que se inserta delante del enlace (opcional)."),
        web: S.txt("Web a la que pertenece (dominio); vacío = el de la página de pago."),
        precio: S.num("Precio, para calcular ingresos cuando la venta no trae importe."),
        etiqueta: S.txt("Etiqueta que se pone al comprar (opcional)."),
        activo: S.bool("false = no se ofrece (por defecto true)."),
        ...CONFIRMA,
      }),
      rutas: ["/admin/api/payment-products"],
      run: async (a, c) => {
        const actuales = await productosActuales(c);
        if (actuales.res) return actuales.res;
        const todos = (actuales.lista || []).map(limpiaProducto);
        const id = str(a.id).trim();
        const previo = id ? todos.find((p) => p.id === id) : undefined;
        if (id && !previo) return fallo("No hay ningún producto con id «" + id + "» (ventas_productos).");
        const base = previo || { id: "", label: "", url: "", currency: "", msg: "", site: "", price: undefined, tag: "", active: true };
        const nuevo: Args = {
          ...base,
          label: str(a.nombre).trim() || str(base.label),
          url: str(a.url).trim() || str(base.url),
          currency: a.divisa !== undefined && a.divisa !== null ? str(a.divisa).trim().toLowerCase() : base.currency,
          msg: a.mensaje !== undefined && a.mensaje !== null ? str(a.mensaje).trim() : base.msg,
          site: a.web !== undefined && a.web !== null ? str(a.web).trim() : base.site,
          price: a.precio !== undefined && a.precio !== null && str(a.precio) !== "" ? Number(a.precio) : base.price,
          tag: a.etiqueta !== undefined && a.etiqueta !== null ? str(a.etiqueta).trim() : base.tag,
          active: typeof a.activo === "boolean" ? a.activo : base.active,
        };
        if (!str(nuevo.label)) return fallo("Falta el nombre del producto.");
        if (!/^https?:\/\//i.test(str(nuevo.url))) return fallo("La página de pago tiene que empezar por https://.");
        if (!previo) nuevo.id = idLibre(str(nuevo.label), new Set(todos.map((p) => str(p.id))), "producto");
        if (previo && a.confirmado_por_humano !== true) return noConfirmado("Se cambiará el producto «" + str(previo.label) + "» del catálogo de pagos.");
        if (todos.length >= 60 && !previo) return fallo("El catálogo admite 60 productos como mucho.");
        const products = previo ? todos.map((p) => (p.id === previo.id ? nuevo : p)) : [...todos, nuevo];
        return llamar(c, "POST", "/admin/api/payment-products", { products }, true);
      },
    },
    {
      name: "quitar_producto_pago", title: "Quitar un producto de pago", alcance: "completo", annotations: BORRA,
      description: "Quita un producto del catálogo de pagos (los enlaces ya enviados y las ventas registradas no se borran, pero el producto deja "
        + "de ofrecerse). Para dejar de ofrecerlo sin quitarlo: guardar_producto_pago con activo: false. Confírmalo con el usuario.",
      inputSchema: esquema({ id: S.txt("id del producto."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/payment-products"],
      run: async (a, c) => {
        const actuales = await productosActuales(c);
        if (actuales.res) return actuales.res;
        const todos = (actuales.lista || []).map(limpiaProducto);
        const id = str(a.id).trim();
        const previo = todos.find((p) => p.id === id);
        if (!previo) return fallo("No hay ningún producto con id «" + id + "».");
        if (a.confirmado_por_humano !== true) return noConfirmado("Quitar «" + str(previo.label) + "» del catálogo de pagos.");
        return llamar(c, "POST", "/admin/api/payment-products", { products: todos.filter((p) => p.id !== id) }, true);
      },
    },
    {
      name: "guardar_catalogo_pagos", title: "Guardar el catálogo de pagos entero", alcance: "completo", annotations: CAMBIA,
      description: "Sustituye la lista COMPLETA de productos de pago (hasta 60): cada uno con id, label, url y, opcionalmente, currency, msg, site, "
        + "price, tag y active. Un producto que no venga en la lista se QUITA (solo con permitir_quitar: true). Para tocar uno solo: "
        + "guardar_producto_pago. Pide confirmado_por_humano: true.",
      inputSchema: esquema({
        products: { type: "array", items: S.obj("{ id, label, url, currency?, msg?, site?, price?, tag?, active? }"), description: "La lista completa." },
        permitir_quitar: S.bool("true = acepta que los productos ausentes de la lista se quiten."),
        ...CONFIRMA,
      }, ["products"]),
      rutas: ["/admin/api/payment-products"],
      run: async (a, c) => {
        const products = Array.isArray(a.products) ? (a.products as Args[]) : [];
        if (!products.length) return fallo("Falta la lista de productos.");
        if (products.length > 60) return fallo("El catálogo admite 60 productos como mucho.");
        const actuales = await productosActuales(c);
        if (actuales.res) return actuales.res;
        const ids = new Set(products.map((p) => str(p.id)));
        const ausentes = (actuales.lista || []).filter((p) => !ids.has(str(p.id)));
        if (ausentes.length && a.permitir_quitar !== true) return fallo("Faltan en la lista los productos " + ausentes.map((p) => str(p.label) + " (" + str(p.id) + ")").join(", ") + ": se quitarían. Añádelos o pasa permitir_quitar: true.");
        if (a.confirmado_por_humano !== true) return noConfirmado("Guardar el catálogo sustituye la lista entera" + (ausentes.length ? " y quita " + ausentes.length + " producto(s)" : "") + ".");
        return llamar(c, "POST", "/admin/api/payment-products", { products }, true);
      },
    },
  ];
}
