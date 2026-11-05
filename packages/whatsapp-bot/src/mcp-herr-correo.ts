/** MCP-TOTAL-1 · Herramientas MCP de CORREO: boletines, rutinas de correo, catálogo de correos de la
 *  web, secuencias de goteo y lecturas de las webs conectadas (systeme.io). Cada herramienta llama a
 *  una ruta del panel con la identidad de la clave: la tenencia y los permisos los pone el panel.
 *  Contratos de las rutas: admin.ts (newsletters 20070-20475, email-catalog 19976, sequences 9656,
 *  connections/systemeio 13091-16400). */
import { type Args, type Herramienta, type Kit, PAGINA, coincide, paginar, parse } from "./mcp-tipos.js";

const ESTADOS_BOLETIN = ["draft", "scheduled", "sending", "sent", "error", "cancelled"];

export function herramientas(k: Kit): Herramienta[] {
  const { S, esquema, llamar, api, fallo, str, lista, qs, msEnZona, LEE, CAMBIA, IDEMP, BORRA, SALE, CONFIRMA } = k;
  const enc = encodeURIComponent;

  /** Campos de un boletín o de una rutina, del nombre en castellano al del panel. */
  const camposCorreo = (a: Args): Args => {
    const b: Args = {};
    if (str(a.cuenta)) b.accountId = str(a.cuenta);
    if (a.asunto !== undefined) b.subject = str(a.asunto);
    if (a.previsualizacion !== undefined) b.previewText = str(a.previsualizacion);
    if (a.cuerpo_html !== undefined) b.bodyHtml = String(a.cuerpo_html ?? "");
    if (a.remitente_nombre !== undefined) b.senderName = str(a.remitente_nombre);
    if (a.remitente_email !== undefined) b.senderEmail = str(a.remitente_email);
    if (a.instruccion_ia !== undefined) b.prompt = str(a.instruccion_ia);
    const inc = lista(a.etiquetas_incluidas); if (inc) b.includeTags = inc;
    const exc = lista(a.etiquetas_excluidas); if (exc) b.excludeTags = exc;
    const cs = lista(a.correos); if (cs) b.contacts = cs;
    return b;
  };
  const ARGS_CORREO = {
    cuenta: S.txt("Web conectada desde la que se envía (id de `cuentas` en listar_boletines). Por defecto, la activa."),
    asunto: S.txt("Asunto (hasta 255 caracteres)."),
    previsualizacion: S.txt("Texto de previsualización (hasta 140)."),
    cuerpo_html: S.txt("Cuerpo en HTML (sin script ni iframe; hasta 200.000 caracteres)."),
    remitente_nombre: S.txt("Nombre del remitente."),
    remitente_email: S.txt("Correo del remitente."),
    etiquetas_incluidas: S.lista("Etiquetas de la web cuyos contactos reciben el correo (nombres; ver audiencia_web)."),
    etiquetas_excluidas: S.lista("Etiquetas cuyos contactos NO lo reciben."),
    correos: S.lista("Correos sueltos añadidos a la audiencia (hasta 500)."),
  };

  return [
    // ── Boletines ──
    {
      name: "listar_boletines", title: "Listar boletines de correo", alcance: "lectura", annotations: LEE,
      description: "Boletines del negocio (borradores, programados, enviados, con error) y las webs conectadas desde las que se puede enviar. "
        + "Paginado y filtrable por estado y texto. Las fechas (scheduled_at, sent_at) son ms desde 1970.",
      inputSchema: esquema({
        estado: S.en("Solo los de este estado.", ESTADOS_BOLETIN),
        q: S.txt("Texto a buscar en el asunto."),
        ...PAGINA,
      }),
      rutas: ["/admin/api/newsletters"],
      run: async (a, c) => {
        const r = await api(c, "GET", "/admin/api/newsletters");
        if (r.status !== 200) return llamar(c, "GET", "/admin/api/newsletters");
        const j = (parse(r.texto) || {}) as { items?: Args[]; cuentas?: unknown };
        let items = Array.isArray(j.items) ? j.items : [];
        if (str(a.estado)) items = items.filter((x) => str(x.status) === str(a.estado));
        if (str(a.q)) items = items.filter((x) => coincide(x, str(a.q), ["subject", "preview_text", "sender_email"]));
        items = items.map((x) => { const { body_html, ...resto } = x; return { ...resto, cuerpo_caracteres: String(body_html ?? "").length }; });
        return { texto: k.compactar(JSON.stringify({ ...paginar(items, a), cuentas: j.cuentas ?? [] })) };
      },
    },
    {
      name: "ver_boletin", title: "Ver un boletín", alcance: "lectura", annotations: LEE,
      description: "Un boletín entero, con su cuerpo HTML, audiencia, estado y resultado del envío.",
      inputSchema: esquema({ id: S.txt("id del boletín.") }, ["id"]),
      rutas: ["/admin/api/newsletters"],
      run: async (a, c) => {
        const r = await api(c, "GET", "/admin/api/newsletters");
        if (r.status !== 200) return llamar(c, "GET", "/admin/api/newsletters");
        const j = (parse(r.texto) || {}) as { items?: Args[] };
        const it = (Array.isArray(j.items) ? j.items : []).find((x) => str(x.id) === str(a.id));
        if (!it) return fallo("No hay ningún boletín con ese id en este negocio.");
        return { texto: k.compactar(JSON.stringify(it)) };
      },
    },
    {
      name: "guardar_boletin", title: "Crear, editar, programar o desprogramar un boletín", alcance: "completo", annotations: CAMBIA,
      description: "Sin id crea un boletín; con id lo edita (no se puede editar uno enviado). accion «guardar» solo lo guarda como borrador "
        + "(OJO: si estaba programado, lo DESPROGRAMA en la web). «programar» lo sube a la web y lo deja programado para programar_para: a esa hora "
        + "saldrá a toda la audiencia sin más intervención, por eso pide confirmado_por_humano. «desprogramar» retira la programación. "
        + "Para redactarlo con IA, antes redactar_boletin_ia; para enviarlo ya, enviar_boletin.",
      inputSchema: esquema({
        id: S.txt("id del boletín a editar. Sin id, se crea."),
        accion: S.en("Qué hacer. Por defecto, guardar.", ["guardar", "programar", "desprogramar"]),
        ...ARGS_CORREO,
        instruccion_ia: S.txt("Instrucción con la que se redactó (informativo)."),
        programar_para: S.fecha("Cuándo sale (solo con accion «programar»; tiene que ser futuro)."),
        ...CONFIRMA,
      }),
      rutas: ["/admin/api/newsletters"],
      run: async (a, c) => {
        const acc = str(a.accion) || "guardar";
        // El panel desprograma en la web un boletín programado (o con error) al guardarlo: eso saca un envío
        // masivo de la cola sin pasar por pideConfirmacion, así que aquí se exige la aprobación humana. Falla cerrado.
        if (acc === "guardar" && str(a.id) && a.confirmado_por_humano !== true) {
          const aviso = "Guardar un boletín ya programado (o con error) lo desprograma en la web y no saldrá a la hora fijada: enséñale al usuario el asunto y la hora y repite con confirmado_por_humano: true solo si lo aprueba.";
          const r = await api(c, "GET", "/admin/api/newsletters");
          if (r.status !== 200) return fallo(aviso);
          const j = (parse(r.texto) || {}) as { items?: Args[] };
          const prev = (Array.isArray(j.items) ? j.items : []).find((x) => str(x.id) === str(a.id));
          if (prev && (str(prev.status) === "scheduled" || str(prev.status) === "error")) return fallo(aviso);
        }
        const b = camposCorreo(a);
        if (str(a.id)) b.id = str(a.id);
        b.action = acc === "programar" ? "schedule" : acc === "desprogramar" ? "unschedule" : "save";
        if (acc === "programar") {
          const ms = msEnZona(a.programar_para, c.zona);
          if (!ms) return fallo("Para programar hace falta programar_para (fecha futura, p. ej. 2026-11-02T09:30).");
          if (ms <= Date.now()) return fallo("programar_para tiene que ser una fecha futura.");
          b.scheduledAt = ms;
        }
        return llamar(c, "POST", "/admin/api/newsletters", b, a.confirmado_por_humano === true);
      },
    },
    {
      name: "enviar_boletin", title: "Enviar un boletín ahora (o una prueba)", alcance: "completo", annotations: SALE,
      description: "Con email_prueba manda UNA prueba real a ese correo (también sube el boletín a la web y puede crear allí las etiquetas que falten). "
        + "Sin email_prueba ENVÍA YA el boletín a toda su audiencia: irreversible. En los dos casos solo con confirmado_por_humano: true. "
        + "Si da timeout, NO lo repitas: mira el estado con ver_boletin.",
      inputSchema: esquema({
        id: S.txt("id del boletín (ya guardado, con asunto y cuerpo)."),
        email_prueba: S.txt("Si se da, solo se envía una prueba a este correo."),
        ...CONFIRMA,
      }, ["id"]),
      rutas: ["/admin/api/newsletters"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true)
          return fallo(str(a.email_prueba)
            ? "La prueba manda un correo real: dile al usuario a qué dirección y repite con confirmado_por_humano: true si lo aprueba."
            : "Es un envío masivo: enséñale al usuario el asunto y la audiencia (ver_boletin) y repite con confirmado_por_humano: true solo si lo aprueba.");
        const id = enc(str(a.id));
        if (str(a.email_prueba)) return llamar(c, "POST", "/admin/api/newsletters/" + id + "/test", { email: str(a.email_prueba) }, true);
        return llamar(c, "POST", "/admin/api/newsletters/" + id + "/send", {}, true);
      },
    },
    {
      name: "borrar_boletin", title: "Borrar un boletín", alcance: "completo", annotations: BORRA,
      description: "Borra el boletín del panel y de la web (retirando su programación). Si ya se envió, se pierde su histórico local. Pide confirmado_por_humano.",
      inputSchema: esquema({ id: S.txt("id del boletín."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/newsletters"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return fallo("Borrar un boletín no se deshace: confírmalo con el usuario y repite con confirmado_por_humano: true.");
        return llamar(c, "DELETE", "/admin/api/newsletters/" + enc(str(a.id)), undefined, true);
      },
    },
    {
      name: "redactar_boletin_ia", title: "Redactar un boletín con la IA del panel", alcance: "completo", annotations: CAMBIA,
      description: "La IA del panel redacta asunto, previsualización y cuerpo HTML a partir de una instrucción. No guarda nada: "
        + "revisa el resultado y pásalo a guardar_boletin. Consume una llamada de IA.",
      inputSchema: esquema({
        instruccion: S.txt("Qué contar y a quién (hasta 4.000 caracteres)."),
        negocio: S.txt("Nombre del negocio, si quieres forzarlo."),
        tono: S.txt("Tono (por defecto «cercano y profesional»)."),
        idioma: S.txt("Idioma (por defecto español)."),
        firmante: S.txt("Quién firma."),
        firma: S.obj("Firma: {despedida, cargo, web}."),
      }, ["instruccion"]),
      rutas: ["/admin/api/newsletters"],
      run: async (a, c) => {
        const b: Args = { prompt: str(a.instruccion) };
        for (const [es, en] of [["negocio", "negocio"], ["tono", "tono"], ["idioma", "idioma"], ["firmante", "firmante"]] as const) if (str(a[es])) b[en] = str(a[es]);
        if (a.firma && typeof a.firma === "object") b.firma = a.firma;
        return llamar(c, "POST", "/admin/api/newsletters/ai", b);
      },
    },
    {
      name: "audiencia_web", title: "Etiquetas de la web con sus contactos", alcance: "lectura", annotations: LEE,
      description: "Etiquetas de la web conectada (systeme.io) y cuántos contactos tiene cada una, para elegir a quién va un boletín. "
        + "Con conteo es lento (cuenta hasta 40 etiquetas).",
      inputSchema: esquema({
        cuenta: S.txt("Web conectada. Por defecto, la activa."),
        sin_conteo: S.bool("true para no contar contactos (más rápido)."),
      }),
      rutas: ["/admin/api/newsletters/audience"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/newsletters/audience" + qs({ acc: str(a.cuenta), conteo: a.sin_conteo === true ? "0" : "" })),
    },
    {
      name: "estadisticas_boletin", title: "Referencia de estadísticas de un boletín enviado", alcance: "lectura", annotations: LEE,
      description: "Para un boletín ya enviado, el identificador de su envío en la web (mailing_id), con el que la web muestra aperturas y clics. "
        + "Si salió uno a uno (directo), nunca tendrá estadísticas.",
      inputSchema: esquema({ id: S.txt("id del boletín.") }, ["id"]),
      rutas: ["/admin/api/newsletters"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/newsletters/" + enc(str(a.id)) + "/mailing"),
    },

    // ── Rutinas de correo ──
    {
      name: "listar_rutinas_correo", title: "Listar rutinas de correo automático", alcance: "lectura", annotations: LEE,
      description: "Rutinas: encargos periódicos a la IA que redacta y envía un correo a una audiencia (frecuencia, hora, próximo envío).",
      inputSchema: esquema({ ...PAGINA }),
      rutas: ["/admin/api/newsletters/routines"],
      run: async (a, c) => {
        const r = await api(c, "GET", "/admin/api/newsletters/routines");
        if (r.status !== 200) return llamar(c, "GET", "/admin/api/newsletters/routines");
        const j = (parse(r.texto) || {}) as { items?: Args[]; cuentas?: unknown };
        return { texto: k.compactar(JSON.stringify({ ...paginar(Array.isArray(j.items) ? j.items : [], a), cuentas: j.cuentas ?? [] })) };
      },
    },
    {
      name: "guardar_rutina_correo", title: "Crear o editar una rutina de correo", alcance: "completo", annotations: CAMBIA,
      description: "Sin id crea; con id edita. Una rutina activa hace que la IA redacte y ENVÍE correos reales en cada ejecución sin intervención, "
        + "por eso guardar pide confirmado_por_humano. Para encender o pausar una existente, activar_rutina_correo.",
      inputSchema: esquema({
        id: S.txt("id de la rutina a editar."),
        nombre: S.txt("Nombre (si falta, se toma de la instrucción)."),
        instruccion_ia: S.txt("Qué debe contar la IA cada vez (hasta 4.000 caracteres)."),
        cuenta: ARGS_CORREO.cuenta,
        remitente_nombre: ARGS_CORREO.remitente_nombre,
        remitente_email: ARGS_CORREO.remitente_email,
        etiquetas_incluidas: ARGS_CORREO.etiquetas_incluidas,
        etiquetas_excluidas: ARGS_CORREO.etiquetas_excluidas,
        correos: ARGS_CORREO.correos,
        frecuencia: S.en("Cada cuánto.", ["daily", "weekly", "monthly"]),
        dias_semana: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "Solo semanal: días (0 = domingo … 6 = sábado)." },
        dia_mes: S.int("Solo mensual: día del mes (1-28).", { minimum: 1, maximum: 28 }),
        hora: S.int("Hora (0-23).", { minimum: 0, maximum: 23 }),
        minuto: S.int("Minuto (0-59).", { minimum: 0, maximum: 59 }),
        zona: S.txt("Zona horaria IANA (por defecto la del negocio)."),
        firma: S.obj("Firma: {despedida, cargo, web}."),
        activa: S.bool("true la deja encendida (envíos reales desde la próxima ejecución); false la deja en pausa. Ausente: conserva."),
        ...CONFIRMA,
      }),
      rutas: ["/admin/api/newsletters/routines"],
      run: async (a, c) => {
        const b = camposCorreo(a);
        if (str(a.id)) b.id = str(a.id);
        if (str(a.nombre)) b.name = str(a.nombre);
        if (str(a.frecuencia)) b.freq = str(a.frecuencia);
        if (Array.isArray(a.dias_semana)) b.weekdays = a.dias_semana;
        if (a.dia_mes !== undefined) b.monthday = Number(a.dia_mes);
        if (a.hora !== undefined) b.atHour = Number(a.hora);
        if (a.minuto !== undefined) b.atMin = Number(a.minuto);
        if (str(a.zona)) b.tz = str(a.zona);
        if (a.firma && typeof a.firma === "object") b.signature = a.firma;
        if (typeof a.activa === "boolean") b.active = a.activa;
        return llamar(c, "POST", "/admin/api/newsletters/routines", b, a.confirmado_por_humano === true);
      },
    },
    {
      name: "activar_rutina_correo", title: "Encender o pausar una rutina de correo", alcance: "completo", annotations: IDEMP,
      description: "Encender deja envíos reales programados desde la próxima ejecución (pide confirmado_por_humano); pausar los detiene.",
      inputSchema: esquema({ id: S.txt("id de la rutina."), encender: S.bool("true enciende, false pausa."), ...CONFIRMA }, ["id", "encender"]),
      rutas: ["/admin/api/newsletters/routines"],
      run: async (a, c) => llamar(c, "POST", "/admin/api/newsletters/routines/" + enc(str(a.id)) + "/active", { active: a.encender === true }, a.confirmado_por_humano === true || a.encender !== true),
    },
    {
      name: "ejecutar_rutina_correo", title: "Ejecutar una rutina de correo ahora", alcance: "completo", annotations: SALE,
      description: "La IA redacta un correo nuevo y lo ENVÍA YA a la audiencia de la rutina (no mueve la próxima ejecución). Solo con confirmado_por_humano: true. "
        + "Si da timeout no lo repitas: mira listar_boletines.",
      inputSchema: esquema({ id: S.txt("id de la rutina."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/newsletters/routines"],
      run: async (a, c) => llamar(c, "POST", "/admin/api/newsletters/routines/" + enc(str(a.id)) + "/run", {}, a.confirmado_por_humano === true),
    },
    {
      name: "historial_rutina_correo", title: "Correos enviados por una rutina", alcance: "lectura", annotations: LEE,
      description: "Boletines que ha generado y enviado una rutina, paginados.",
      inputSchema: esquema({ id: S.txt("id de la rutina."), limite: S.int("Cuántos (1-100, 20 por defecto).", { minimum: 1, maximum: 100 }), desde_el: S.int("Desplazamiento (0 por defecto).", { minimum: 0 }) }, ["id"]),
      rutas: ["/admin/api/newsletters/routines"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/newsletters/routines/" + enc(str(a.id)) + "/history" + qs({ limit: a.limite, offset: a.desde_el })),
    },
    {
      name: "borrar_rutina_correo", title: "Borrar una rutina de correo", alcance: "completo", annotations: BORRA,
      description: "Borra la rutina (lo ya enviado se conserva en boletines). Pide confirmado_por_humano.",
      inputSchema: esquema({ id: S.txt("id de la rutina."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/newsletters/routines"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return fallo("Borrar una rutina no se deshace: confírmalo con el usuario y repite con confirmado_por_humano: true.");
        return llamar(c, "DELETE", "/admin/api/newsletters/routines/" + enc(str(a.id)), undefined, true);
      },
    },

    // ── Catálogo de correos de la web ──
    {
      name: "buscar_correos_web", title: "Buscar correos de la web (catálogo)", alcance: "lectura", annotations: LEE,
      description: "Correos que existen en la web conectada (boletines, campañas, workflows, reglas), para elegir uno como disparador «Correos» de un flujo. "
        + "Si responde building:true, el barrido aún no ha terminado: repite en unos segundos.",
      inputSchema: esquema({
        cuenta: S.txt("Web conectada (obligatoria)."),
        q: S.txt("Texto a buscar en el asunto o el origen."),
        tipo: S.txt("Tipo de origen exacto (newsletter, campaign, workflow, rule…)."),
        estado: S.txt("Estado, en minúsculas."),
        limite: S.int("Cuántos (1-200, 60 por defecto).", { minimum: 1, maximum: 200 }),
        desde_el: S.int("Desplazamiento.", { minimum: 0 }),
        refrescar: S.bool("true vuelve a barrer la web (lento)."),
      }, ["cuenta"]),
      rutas: ["/admin/api/email-catalog"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/email-catalog" + qs({ acc: str(a.cuenta), q: str(a.q), type: str(a.tipo), status: str(a.estado), limit: a.limite, offset: a.desde_el, refresh: a.refrescar === true ? "1" : "" })),
    },
    {
      name: "crear_etiqueta_web", title: "Crear una etiqueta en la web conectada", alcance: "completo", annotations: IDEMP,
      description: "Crea (o reutiliza si ya existe) una etiqueta en la web conectada (systeme.io). Gasta cupo de etiquetas de esa web.",
      inputSchema: esquema({ cuenta: S.txt("Web conectada."), nombre: S.txt("Nombre de la etiqueta (hasta 120).") }, ["cuenta", "nombre"]),
      rutas: ["/admin/api/email-catalog"],
      run: async (a, c) => llamar(c, "POST", "/admin/api/email-catalog/ensure-tag", { acc: str(a.cuenta), name: str(a.nombre) }),
    },

    // ── Secuencias de goteo ──
    {
      name: "listar_secuencias", title: "Listar secuencias de goteo", alcance: "lectura", annotations: LEE,
      description: "Secuencias de mensajes de WhatsApp con espera entre pasos (las arrancan los disparadores por palabra clave).",
      inputSchema: esquema({}),
      rutas: ["/admin/api/sequences"],
      run: async (_a, c) => llamar(c, "GET", "/admin/api/sequences"),
    },
    {
      name: "guardar_secuencia", title: "Crear o reemplazar una secuencia de goteo", alcance: "completo", annotations: CAMBIA,
      description: "Con id reemplaza la secuencia ENTERA (los pasos que no mandes desaparecen). Sin id crea una secuencia NUEVA en cada llamada: "
        + "tras un timeout o reintento, no la repitas sin id; mira listar_secuencias antes.",
      rutas: ["/admin/api/sequences"],
      inputSchema: esquema({
        id: S.txt("id de la secuencia a reemplazar."),
        nombre: S.txt("Nombre."),
        activa: S.bool("true activa (por defecto)."),
        pasos: { type: "array", description: "Pasos en orden: {espera_minutos, texto}.", items: { type: "object", properties: { espera_minutos: S.int("Minutos de espera antes de este paso.", { minimum: 0 }), texto: S.txt("Mensaje.") }, required: ["texto"], additionalProperties: false } },
      }, ["nombre"]),
      run: async (a, c) => {
        const pasos = (Array.isArray(a.pasos) ? a.pasos as Args[] : []).map((p) => ({ delayMin: Math.max(0, Number(p.espera_minutos) || 0), text: str(p.texto) }));
        const b: Args = { name: str(a.nombre), enabled: a.activa !== false, steps: pasos };
        if (str(a.id)) b.id = str(a.id);
        return llamar(c, "POST", "/admin/api/sequences", b);
      },
    },
    {
      name: "borrar_secuencia", title: "Borrar una secuencia de goteo", alcance: "completo", annotations: BORRA,
      description: "Borra la secuencia. Pide confirmado_por_humano.",
      inputSchema: esquema({ id: S.txt("id de la secuencia."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/sequences"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return fallo("Borrar una secuencia no se deshace: confírmalo con el usuario y repite con confirmado_por_humano: true.");
        return llamar(c, "DELETE", "/admin/api/sequences/" + enc(str(a.id)), undefined, true);
      },
    },

    // ── Webs conectadas (systeme.io): solo lectura ──
    {
      name: "webs_conectadas", title: "Webs conectadas (systeme.io)", alcance: "lectura", annotations: LEE,
      description: "Webs de systeme.io conectadas al panel y el estado del píxel de seguimiento de cada una. No muestra credenciales.",
      inputSchema: esquema({}),
      rutas: ["/admin/api/connections/systemeio/status", "/admin/api/connections/systemeio/seguimiento"],
      run: async (_a, c) => {
        const [s, g] = await Promise.all([api(c, "GET", "/admin/api/connections/systemeio/status"), api(c, "GET", "/admin/api/connections/systemeio/seguimiento")]);
        if (s.status !== 200) return llamar(c, "GET", "/admin/api/connections/systemeio/status");
        return { texto: k.compactar(JSON.stringify({ ...(parse(s.texto) as object || {}), seguimiento: g.status === 200 ? (parse(g.texto) as Args || {}).sitios ?? null : null })) };
      },
    },
    {
      name: "metricas_web", title: "Métricas de una web conectada", alcance: "lectura", annotations: LEE,
      description: "Métricas de una web de systeme.io (contactos, ventas, embudos) combinando sus fuentes. Lento; se cachea 60 s.",
      inputSchema: esquema({ cuenta: S.txt("Web conectada (ver webs_conectadas)."), refrescar: S.bool("true fuerza a volver a leer.") }, ["cuenta"]),
      rutas: ["/admin/api/connections/systemeio/metrics"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/connections/systemeio/metrics/" + enc(str(a.cuenta)) + qs({ refresh: a.refrescar === true ? "1" : "" }), undefined, false, ["accountId", "ok", "api", "internal", "mcp", "cookieExpired"]),
    },
    {
      name: "embudos_web", title: "Embudos de una web conectada", alcance: "lectura", annotations: LEE,
      description: "Embudos (funnels) de la web; con embudo, las páginas (steps) de ese embudo.",
      inputSchema: esquema({ cuenta: S.txt("Web conectada."), embudo: S.txt("id del embudo para ver sus páginas.") }, ["cuenta"]),
      rutas: ["/admin/api/connections/systemeio/:accountId/funnels"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/connections/systemeio/" + enc(str(a.cuenta)) + "/funnels" + (str(a.embudo) ? "/" + enc(str(a.embudo)) + "/steps" : "")),
    },
    {
      name: "etiquetas_web", title: "Etiquetas y campos de una web conectada", alcance: "lectura", annotations: LEE,
      description: "Nombres de las etiquetas de la web y sus campos personalizados de contacto. Si la web no tiene clave de API, devuelve hasApiKey:false.",
      inputSchema: esquema({ cuenta: S.txt("Web conectada."), que: S.en("etiquetas (por defecto) o campos.", ["etiquetas", "campos"]) }, ["cuenta"]),
      rutas: ["/admin/api/connections/systemeio/accounts/:id/tags", "/admin/api/connections/systemeio/accounts/:id/fields"],
      run: async (a, c) => {
        const ruta = "/admin/api/connections/systemeio/accounts/" + enc(str(a.cuenta)) + (str(a.que) === "campos" ? "/fields" : "/tags");
        const sinClave = { texto: JSON.stringify({ hasApiKey: false, aviso: "Esta web no tiene clave de API: añádela en Conexiones para leer sus etiquetas y campos." }) };
        // La rama de campos responde 400 «esa cuenta no tiene API key» (la de etiquetas ya responde hasApiKey:false).
        const r = await api(c, "GET", ruta);
        if (r.status === 400 && /no tiene API key/i.test(r.texto)) return sinClave;
        if (r.status >= 200 && r.status < 300 && !r.aviso) return { texto: k.compactar(r.texto) };
        return llamar(c, "GET", ruta);
      },
    },
  ];
}
