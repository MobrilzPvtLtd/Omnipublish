/** MCP-TOTAL-1 · Herramientas MCP de la BANDEJA: conversaciones, quién atiende, envíos desde un número,
 *  reacciones, plantillas de WhatsApp, archivos del almacén, variables y avisos del panel.
 *  Cada herramienta llama a una ruta del panel con la identidad de la clave: la tenencia y los
 *  permisos los pone el panel. Contratos: admin.ts (inbox 11009-12999, reply 12087, react 12367,
 *  wa-templates 9298-9615, flow-media 19864, vars/preview 7792, notifications 4523-4584). */
import { type Args, type Herramienta, type Kit, PAGINA, coincide, paginar, parse } from "./mcp-tipos.js";

const CANALES = ["whatsapp", "instagram", "facebook", "tiktok", "linkedin"];
const TIPOS_AVISO = ["lead_nuevo", "flujo_salida", "pide_persona", "lead_cualificado", "mensaje_sin_bot", "comentario", "reunion", "pago", "difusion", "publicacion", "flujo_conflicto", "comentario_sin_flujo", "conexion"];

export function herramientas(k: Kit): Herramienta[] {
  const { S, esquema, llamar, api, fallo, str, tel, lista, qs, LEE, CAMBIA, IDEMP, BORRA, SALE, CONFIRMA } = k;
  const enc = encodeURIComponent;
  // El panel guarda el teléfono solo con dígitos (sin «+»): la clave del chat va sin «+».
  const clave = (a: Args) => (tel(a.telefono) || str(a.telefono)).replace(/\+/g, "");
  const cuentaWa = (v: unknown) => { const s = str(v); return !s ? "" : /^(wa|ig|fb):/.test(s) ? s : "wa:" + s; };
  /** Error del panel → respuesta de error con su texto (sin re-llamar). */
  const errorDe = (r: { status: number; texto: string }) => {
    const j = parse(r.texto) as { error?: unknown } | null;
    return fallo("El panel respondió " + r.status + (j && j.error ? ": " + String(j.error) : r.texto ? ": " + r.texto.slice(0, 300) : ""));
  };

  return [
    // ── Conversaciones ──
    {
      name: "listar_conversaciones", title: "Listar conversaciones de la Bandeja", alcance: "lectura", annotations: LEE,
      description: "Las conversaciones de la Bandeja (una fila por chat y número propio) con quién atiende, etapa, responsable, "
        + "si está en la ventana de 24 h, sin leer y el último mensaje. Filtra como la Bandeja y pagina aquí (el panel no pagina). "
        + "Devuelve también los contadores de pestañas, el equipo («closers»), los números y cuentas propias y las etapas. "
        + "Fechas en ms desde 1970. La clave de cada chat es «user_id» (teléfono sin «+» en WhatsApp; id de 15-17 cifras en Instagram/Facebook).",
      inputSchema: esquema({
        q: S.txt("Texto a buscar en nombre, identificador o último mensaje."),
        atiende: S.en("persona = la atiende alguien del equipo; bot = la atiende la IA.", ["persona", "bot"]),
        en_ventana: S.bool("true = solo chats de WhatsApp con la ventana de 24 h abierta; false = solo cerrados."),
        sin_leer: S.bool("true = solo los que tienen mensajes sin leer."),
        etapa: S.txt("Nombre exacto de la etapa del pipeline."),
        canales: S.lista("Canales: " + CANALES.join(", ") + " (varios)."),
        cuenta: S.txt("Cuenta propia: wa:<id del número>, ig:<id> o fb:<id de página>."),
        responsable: S.txt("mine = los míos; unassigned = sin responsable; o la clave de una persona (env-admin, u:<id>)."),
        negocios: S.lista("Ids de negocio (@principal = el principal)."),
        modo: S.en("Quién atiende ahora.", ["equipo", "ia", "flujo"]),
        ...PAGINA,
      }),
      run: async (a, c) => {
        const r = await api(c, "GET", "/admin/api/inbox" + qs({
          q: str(a.q),
          human: a.atiende === "persona" ? "true" : a.atiende === "bot" ? "false" : "",
          window: a.en_ventana === true ? "true" : a.en_ventana === false ? "false" : "",
          unread: a.sin_leer === true ? "1" : "",
          stage: str(a.etapa), channels: lista(a.canales), account: str(a.cuenta), owner: str(a.responsable),
          negocios: lista(a.negocios), modo: str(a.modo),
        }));
        if (r.status !== 200) return errorDe(r);
        const j = (parse(r.texto) || {}) as Args;
        const filas = Array.isArray(j.inbox) ? (j.inbox as Args[]) : [];
        const bots = (j.bots || {}) as Args;
        return { texto: k.compactar(JSON.stringify({
          ...paginar(filas.map(({ initials, colorSeed, avatar, avatarStored, ...f }) => f), a),
          contadores: j.counts, yo: j.me, equipo: j.closers,
          cuentas: { whatsapp: bots.whatsappNumbers ?? bots.whatsapp, instagram: bots.instagram, facebook: bots.facebook },
          negocios: j.negocios, etapas: (j.filters as Args | undefined)?.etapas,
        })) };
      },
    },
    {
      name: "contar_sin_leer", title: "Cuántos chats hay sin leer", alcance: "lectura", annotations: LEE,
      description: "Número de conversaciones con mensajes sin leer (lo que marca el menú lateral), opcionalmente por negocios o canales. "
        + "Las marcas de leído son por persona: cuenta lo que no ha leído quien usa esta conexión.",
      inputSchema: esquema({ negocios: S.lista("Ids de negocio."), canales: S.lista("whatsapp, instagram, facebook, tiktok, linkedin.") }),
      run: async (a, c) => llamar(c, "GET", "/admin/api/inbox/unread" + qs({ negocios: lista(a.negocios), channels: lista(a.canales) })),
    },
    {
      name: "leer_conversacion", title: "Leer una conversación", alcance: "lectura", annotations: LEE,
      description: "Abre un chat: sus mensajes (los últimos primero, «ultimos» por defecto 40) con estado de entrega y reacciones, la ficha del contacto, "
        + "si la ventana de 24 h está abierta, por qué número propio va (cloud o QR), el perfil de IA que atiende y los perfiles disponibles. "
        + "Si la persona tiene chats por varios números propios, «chats» los lista: pasa «cuenta» para ver uno concreto. "
        + "Contacto inexistente → contacto null y sin mensajes. Los «mid» de cada mensaje sirven para reaccionar_mensaje y para citar.",
      inputSchema: esquema({
        telefono: S.txt("Clave del chat: teléfono (WhatsApp) o identificador (Instagram/Facebook)."),
        cuenta: S.txt("Solo los mensajes de este número propio: wa:<id> (o el id a secas)."),
        ultimos: S.int("Cuántos mensajes, los más recientes (1-500). Por defecto 40.", { minimum: 1, maximum: 500 }),
      }, ["telefono"]),
      run: async (a, c) => {
        const p = clave(a);
        const [r, ch] = await Promise.all([
          api(c, "GET", "/admin/api/inbox/" + enc(p) + qs({ acct: cuentaWa(a.cuenta) })),
          api(c, "GET", "/admin/api/inbox/" + enc(p) + "/chats"),
        ]);
        if (r.status !== 200) return errorDe(r);
        const j = (parse(r.texto) || {}) as Args;
        const turns = Array.isArray(j.turns) ? (j.turns as unknown[]) : [];
        const n = Math.min(500, Math.max(1, Math.round(Number(a.ultimos) || 40)));
        const chats = (parse(ch.texto) as { chats?: unknown } | null)?.chats;
        return { texto: k.compactar(JSON.stringify({
          telefono: j.phone, contacto: j.contact, via: j.account, chats,
          ventana_24h_abierta: j.waWindowOpen, ultimo_mensaje_entrante: j.waLastInbound, transporte: j.waTransport,
          numero_propio: j.waAcct, numero_desconectado: j.waDesconectado, perfil_ia: j.botId, perfiles_ia: j.bots,
          mensajes_total: turns.length, mensajes: turns.slice(Math.max(0, turns.length - n)),
        })) };
      },
    },
    {
      name: "automatizaciones_contacto", title: "Automatizaciones de un contacto", alcance: "lectura", annotations: LEE,
      description: "En qué flujos está ahora un contacto (esperando su respuesta o en marcha, y en qué paso) y su recorrido por los flujos "
        + "de los últimos 90 días, con los cambios de quién atiende. Para sacarlo: parar_automatizaciones_contacto.",
      inputSchema: esquema({ telefono: S.txt("Clave del chat."), con_recorrido: S.bool("false = solo las activas, sin el recorrido. Por defecto true.") }, ["telefono"]),
      run: async (a, c) => {
        const p = enc(clave(a));
        const r = await api(c, "GET", "/admin/api/inbox/" + p + "/flow-runs");
        if (r.status !== 200) return errorDe(r);
        const activas = (parse(r.texto) as { runs?: unknown } | null)?.runs ?? [];
        if (a.con_recorrido === false) return { texto: k.compactar(JSON.stringify({ activas })) };
        const j = await api(c, "GET", "/admin/api/inbox/" + p + "/journey");
        const recorrido = (parse(j.texto) as { events?: unknown } | null)?.events ?? [];
        return { texto: k.compactar(JSON.stringify({ activas, recorrido })) };
      },
    },

    // ── Quién atiende ──
    {
      name: "cambiar_quien_atiende", title: "Atender yo / devolver al bot", alcance: "completo", annotations: IDEMP,
      description: "«Atender yo»: la IA deja de responder en ese chat y lo lleva una persona (persona: true). Con persona: false el bot vuelve a contestar.",
      inputSchema: esquema({ telefono: S.txt("Clave del chat."), persona: S.bool("true = lo atiende una persona; false = lo atiende el bot.") }, ["telefono", "persona"]),
      run: async (a, c) => llamar(c, "POST", "/admin/api/takeover", { phone: clave(a), human: a.persona === true }),
    },
    {
      name: "asignar_conversacion", title: "Asignar un chat a alguien del equipo", alcance: "completo", annotations: IDEMP,
      description: "Pone responsable a un chat (o lo libera). «responsable» es la clave de una persona tal como sale en «equipo» de listar_conversaciones "
        + "(env-admin o u:<id>); vacío = sin responsable. Con reclamar: true, lo toma quien usa esta conexión solo si nadie lo tenía (409 si ya estaba asignado). "
        + "El panel no comprueba que la persona exista: cópiala de «equipo».",
      inputSchema: esquema({ telefono: S.txt("Clave del chat."), responsable: S.txt("Clave de la persona; vacío = liberar."), reclamar: S.bool("true = reclamarlo para mí si está libre.") }, ["telefono"]),
      run: async (a, c) => {
        const p = enc(clave(a));
        if (a.reclamar === true) return llamar(c, "POST", "/admin/api/inbox/" + p + "/claim", {});
        return llamar(c, "POST", "/admin/api/inbox/" + p + "/assign", { owner: str(a.responsable) });
      },
    },
    {
      name: "cambiar_perfil_ia_chat", title: "Cambiar el perfil de IA de un chat", alcance: "completo", annotations: IDEMP,
      description: "Elige qué perfil de IA (bot) contesta en ese chat. Los ids válidos están en «perfiles_ia» de leer_conversacion; vacío = que lo decida la IA.",
      inputSchema: esquema({ telefono: S.txt("Clave del chat."), perfil: S.txt("id del perfil de IA; vacío = automático.") }, ["telefono"]),
      run: async (a, c) => llamar(c, "POST", "/admin/api/inbox/" + enc(clave(a)) + "/bot", { botId: str(a.perfil) }),
    },
    {
      name: "parar_automatizaciones_contacto", title: "Sacar a un contacto de sus flujos", alcance: "completo", annotations: CAMBIA,
      description: "El botón «Stop» de la Bandeja: saca al contacto de un flujo (o de todos) y pone el chat en «Atender yo» (la IA deja de contestar "
        + "aunque no hubiera nada que parar). Explícaselo al usuario y pide confirmado_por_humano: true.",
      inputSchema: esquema({ telefono: S.txt("Clave del chat."), flujo: S.txt("id del flujo; vacío = todos."), ...CONFIRMA }, ["telefono"]),
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return fallo("Parar los flujos deja el chat en «Atender yo» (la IA calla). Confírmalo con el usuario y repite con confirmado_por_humano: true.");
        return llamar(c, "POST", "/admin/api/inbox/" + enc(clave(a)) + "/stop-flows", str(a.flujo) ? { flowId: str(a.flujo) } : {});
      },
    },
    {
      name: "marcar_leido", title: "Marcar como leído", alcance: "completo", annotations: IDEMP,
      description: "Marca como leído un chat, una cuenta propia, canales enteros, negocios o todo (todo: true), para quien usa esta conexión.",
      inputSchema: esquema({
        telefono: S.txt("Clave de un chat."), cuenta: S.txt("Con telefono: wa:<id> para marcar solo ese número propio; sola: cuenta propia wa|ig|fb:<id> entera."),
        canales: S.lista("whatsapp, instagram, facebook, tiktok, linkedin."), negocios: S.lista("Ids de negocio."), todo: S.bool("true = todo."),
      }),
      run: async (a, c) => {
        const b: Args = {};
        if (a.todo === true) b.all = true;
        if (str(a.telefono)) { b.phone = clave(a); if (str(a.cuenta)) b.acct = cuentaWa(a.cuenta); }
        else if (str(a.cuenta)) b.account = cuentaWa(a.cuenta);
        const ch = lista(a.canales); if (ch) b.channels = ch;
        const ng = lista(a.negocios); if (ng) b.negocios = ng;
        if (!Object.keys(b).length) return fallo("Di qué marcar: telefono, cuenta, canales, negocios o todo: true.");
        return llamar(c, "POST", "/admin/api/inbox/read", b);
      },
    },
    {
      name: "borrar_conversacion", title: "Borrar los mensajes de un chat", alcance: "completo", annotations: BORRA,
      description: "Borra TODOS los mensajes de un chat (la ficha del contacto se queda). Irreversible: confirma con el usuario y pasa confirmado_por_humano: true.",
      inputSchema: esquema({ telefono: S.txt("Clave del chat."), ...CONFIRMA }, ["telefono"]),
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return fallo("Borrar un chat es irreversible. Confírmalo con el usuario y repite con confirmado_por_humano: true.");
        const p = enc(clave(a));
        // El panel reactiva el bot al borrar (db.ts dbDeleteConversation): si el chat estaba en «Atender yo», se restaura.
        const antes = await api(c, "GET", "/admin/api/inbox/" + p);
        if (antes.status !== 200) return errorDe(antes);
        const eraHumano = ((parse(antes.texto) as Args | null)?.contact as Args | null)?.human === true;
        const r = await llamar(c, "DELETE", "/admin/api/inbox/" + p);
        if (r.error || !eraHumano) return r;
        const t = await llamar(c, "POST", "/admin/api/takeover", { phone: clave(a), human: true });
        if (t.error) return fallo("Se borraron los mensajes, pero no pude dejar el chat en «Atender yo» (" + t.texto + "). Pulsa Atender yo en ese chat: ahora el bot puede contestar.");
        return { texto: "Mensajes borrados. El chat seguía en «Atender yo» antes del borrado y se ha mantenido así: la IA no contesta." };
      },
    },

    // ── Antes de escribir ──
    {
      // Usa POST (check-batch / check-recipient): el servidor solo deja POST de lectura a las rutas de CALCULOS, así que va como «completo».
      name: "comprobar_telefonos", title: "Comprobar teléfonos antes de escribir", alcance: "lectura", annotations: LEE,
      description: "Con un teléfono: si está bien escrito (con prefijo internacional), si ya es contacto, si admite texto libre ahora y por qué transporte iría "
        + "(con «numero» se comprueba desde ese número; si es QR consulta a WhatsApp si el teléfono tiene cuenta). "
        + "Con varios (hasta 500): los valida, quita repetidos y dice cuáles ya son contactos. Los fallos vienen como ok: false, no como error.",
      inputSchema: esquema({
        telefono: S.txt("Un teléfono con prefijo internacional."),
        telefonos: S.lista("Varios teléfonos (hasta 500)."),
        numero: S.txt("Id del número propio emisor (phoneNumberId) con el que se escribiría."),
      }),
      run: async (a, c) => {
        const varios = lista(a.telefonos);
        if (varios && varios.length) return llamar(c, "POST", "/admin/api/inbox/check-batch", { phones: varios });
        if (!str(a.telefono)) return fallo("Pasa telefono o telefonos.");
        return llamar(c, "POST", "/admin/api/inbox/check-recipient", { phone: str(a.telefono), ...(str(a.numero) ? { senderId: str(a.numero) } : {}) });
      },
    },
    {
      name: "plantillas_de_numero", title: "Plantillas aprobadas de un número", alcance: "lectura", annotations: LEE,
      description: "Las plantillas APROBADAS que puede enviar un número propio de WhatsApp para abrir conversación (nombre, idioma, texto, "
        + "cuántas variables, tipo). Un número conectado por QR no usa plantillas. Los ids de número están en «cuentas.whatsapp» de listar_conversaciones u opciones_flujo.",
      inputSchema: esquema({ numero: S.txt("Id del número propio (phoneNumberId).") }, ["numero"]),
      run: async (a, c) => llamar(c, "GET", "/admin/api/inbox/new-conversation/templates" + qs({ senderId: str(a.numero) })),
    },

    // ── Envíos ──
    {
      name: "reaccionar_mensaje", title: "Reaccionar a un mensaje", alcance: "completo", annotations: SALE,
      description: "Pone (o quita, con emoji vacío) una reacción a un mensaje del chat: el cliente la ve. «mensaje» es el «mid» de leer_conversacion. "
        + "En Instagram solo vale el corazón rojo; en Facebook no se puede. Confirma con el usuario (confirmado_por_humano: true).",
      inputSchema: esquema({
        telefono: S.txt("Clave del chat."), mensaje: S.txt("mid del mensaje."), emoji: S.txt("Un emoji; vacío = quitar la reacción."),
        es_mio: S.bool("true si el mensaje lo envió el negocio."), cuenta: S.txt("wa:<id> del número propio, si hay varios."), ...CONFIRMA,
      }, ["telefono", "mensaje"]),
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return fallo("La reacción la ve el cliente. Confírmalo con el usuario y repite con confirmado_por_humano: true.");
        return llamar(c, "POST", "/admin/api/react", { phone: clave(a), messageId: str(a.mensaje), emoji: str(a.emoji), fromMe: a.es_mio === true, ...(str(a.cuenta) ? { acct: cuentaWa(a.cuenta) } : {}) }, true);
      },
    },
    {
      name: "iniciar_conversacion", title: "Escribir a un teléfono desde un número propio", alcance: "completo", annotations: SALE,
      description: "«Enviar mensaje» de la Bandeja: escribe a un teléfono (sea contacto o no) desde el número propio que elijas. Texto libre solo si la "
        + "ventana de 24 h está abierta o el número es QR; si no, hace falta una plantilla aprobada con todos sus parámetros (plantillas_de_numero). "
        + "Antes: comprobar_telefonos. Enseña texto y destinatario al usuario y pasa confirmado_por_humano: true. «accepted» significa que WhatsApp lo aceptó, no que se entregó. "
        + "Guarda la ficha con «guardar_nombre» y «guardar_etiquetas» si no existía.",
      inputSchema: esquema({
        numero: S.txt("Id del número propio emisor (phoneNumberId)."), telefono: S.txt("Teléfono destino con prefijo internacional."),
        texto: S.txt("Texto libre (si no va plantilla)."),
        plantilla: S.txt("Nombre de la plantilla aprobada."), parametros: S.lista("Un valor por variable de la plantilla, en orden."),
        guardar_nombre: S.txt("Nombre para la ficha si es nueva."), guardar_etiquetas: S.lista("Etiquetas para la ficha (hasta 12)."),
        clave_idempotente: S.txt("Hasta 80 caracteres: repetir la llamada con la misma clave no reenvía."), ...CONFIRMA,
      }, ["numero", "telefono"]),
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return fallo("Escribir a un teléfono sale a WhatsApp de verdad. Enseña el texto o la plantilla y el destinatario al usuario y repite con confirmado_por_humano: true solo si lo aprueba.");
        if (!str(a.texto) && !str(a.plantilla)) return fallo("Pasa texto o plantilla.");
        const b: Args = { senderId: str(a.numero), phone: str(a.telefono) };
        if (str(a.texto)) b.text = str(a.texto);
        if (str(a.plantilla)) b.template = { name: str(a.plantilla), params: lista(a.parametros) || [] };
        if (str(a.guardar_nombre) || lista(a.guardar_etiquetas)) b.save = { ...(str(a.guardar_nombre) ? { name: str(a.guardar_nombre) } : {}), ...(lista(a.guardar_etiquetas) ? { tags: lista(a.guardar_etiquetas) } : {}) };
        if (str(a.clave_idempotente)) b.idemKey = str(a.clave_idempotente).slice(0, 80);
        return llamar(c, "POST", "/admin/api/inbox/new-conversation", b, true);
      },
    },
    {
      name: "enviar_plantilla_a_lista", title: "Enviar una plantilla a una lista de teléfonos", alcance: "completo", annotations: SALE,
      description: "Envío MASIVO: una plantilla aprobada a hasta 500 teléfonos desde un número propio (no QR). Queda como difusión en el historial. "
        + "Gasta dinero: enseña al usuario la plantilla, los parámetros y cuántos destinatarios, y pasa confirmado_por_humano: true. "
        + "Cada destinatario puede ser un teléfono o {phone, name, email, tags, fields, notes}. La respuesta trae el id de la difusión (listar_difusiones).",
      inputSchema: esquema({
        numero: S.txt("Id del número propio emisor (phoneNumberId)."), plantilla: S.txt("Nombre de la plantilla aprobada."),
        parametros: S.lista("Un valor por variable, en orden (igual para todos)."),
        destinatarios: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object" }] }, description: "Hasta 500 teléfonos o fichas {phone, name?, email?, tags?, fields?, notes?}." },
        guardar_contactos: S.bool("true = guardar como contactos a los que no lo sean."), etiquetas: S.lista("Etiquetas que se añaden a cada ficha (hasta 10)."),
        segundos_entre_envios: S.int("Pausa entre envíos: 0 = medio segundo; si no, entre 10 y 21600.", { minimum: 0, maximum: 21600 }),
        clave_idempotente: S.txt("Hasta 80 caracteres: repetirla no reenvía."), ...CONFIRMA,
      }, ["numero", "plantilla", "destinatarios"]),
      run: async (a, c) => {
        const dest = Array.isArray(a.destinatarios) ? a.destinatarios : lista(a.destinatarios) || [];
        if (a.confirmado_por_humano !== true) return fallo("Un envío masivo gasta dinero y sale a muchas personas. Enseña al usuario la plantilla, los parámetros y el número de destinatarios y repite con confirmado_por_humano: true solo si lo aprueba.");
        if (!dest.length) return fallo("La lista de destinatarios está vacía.");
        const pausa = Math.round(Number(a.segundos_entre_envios) || 0);
        if (pausa >= 1 && pausa <= 9) return fallo("La pausa entre envíos tiene que ser 0 (medio segundo) o entre 10 y 21600 segundos: el panel no admite de 1 a 9. Repite con una de esas cifras.");
        const b: Args = { senderId: str(a.numero), template: { name: str(a.plantilla), params: lista(a.parametros) || [] }, recipients: dest };
        if (a.guardar_contactos === true) b.save = true;
        const et = lista(a.etiquetas); if (et) b.tags = et;
        if (a.segundos_entre_envios !== undefined) b.paceSeconds = pausa;
        if (str(a.clave_idempotente)) b.idemKey = str(a.clave_idempotente).slice(0, 80);
        return llamar(c, "POST", "/admin/api/inbox/new-conversation/batch", b, a.confirmado_por_humano === true);
      },
    },
    {
      name: "cargar_mensajes_anteriores_qr", title: "Pedir al móvil los mensajes anteriores (QR)", alcance: "completo", annotations: CAMBIA,
      description: "En un número de WhatsApp conectado por QR, pide al móvil los mensajes anteriores de ese chat y los guarda. Tarda y, mientras dura, "
        + "ese número no puede enviar: no lo llames en bucle. Devuelve cuántos recibió y cuántos eran nuevos.",
      inputSchema: esquema({ telefono: S.txt("Clave del chat."), cuenta: S.txt("wa:<id> del número QR, si hay varios.") }, ["telefono"]),
      run: async (a, c) => llamar(c, "POST", "/admin/api/inbox/" + enc(clave(a)) + "/anteriores", str(a.cuenta) ? { acct: cuentaWa(a.cuenta) } : {}),
    },

    // ── Plantillas de WhatsApp ──
    {
      name: "listar_plantillas_whatsapp", title: "Plantillas de WhatsApp", alcance: "lectura", annotations: LEE,
      description: "Las plantillas de WhatsApp de la cuenta con su estado en Meta (APPROVED, PENDING, REJECTED), tipo, idioma, texto y botones; "
        + "las cuentas de WhatsApp Business del negocio y los números sin cuenta. Filtra por estado o texto y pagina.",
      inputSchema: esquema({
        cuenta_wa: S.txt("Id de la cuenta de WhatsApp Business (waba), si hay varias."),
        estado: S.txt("Solo las de este estado (APPROVED, PENDING, REJECTED…)."), q: S.txt("Texto a buscar en nombre o cuerpo."),
        refrescar: S.bool("true = volver a pedirlas a Meta en vez de usar la copia de 5 min."), ...PAGINA,
      }),
      rutas: ["/admin/api/wa-templates"],
      run: async (a, c) => {
        const r = await api(c, "GET", "/admin/api/wa-templates" + qs({ waba: str(a.cuenta_wa), refresh: a.refrescar === true ? "1" : "" }));
        if (r.status !== 200) return errorDe(r);
        const j = (parse(r.texto) || {}) as Args;
        let t = Array.isArray(j.templates) ? (j.templates as Args[]) : [];
        if (str(a.estado)) t = t.filter((x) => str(x.status).toUpperCase() === str(a.estado).toUpperCase());
        if (str(a.q)) t = t.filter((x) => coincide(x, str(a.q), ["name", "body", "text"]));
        return { texto: k.compactar(JSON.stringify({ conectado: j.connected, motivo: j.reason, cuenta_wa: j.wabaId, cuentas: j.accounts, numeros_sin_cuenta: j.sinCuenta, ...paginar(t, a) })) };
      },
    },
    {
      name: "editar_plantilla_whatsapp", title: "Editar una plantilla de WhatsApp", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Cambia el texto, el tipo o los botones de una plantilla: Meta la vuelve a revisar (deja de poder enviarse hasta que la aprueben). "
        + "Si pasas «botones», sustituyen a todos los que tenía (lista vacía = quitarlos). Sin «texto», Meta exige el cuerpo igualmente: se reutiliza el de la plantilla actual. "
        + "La cabecera con imagen, vídeo o documento NO se cambia desde aquí (cabecera_archivo se rechaza). Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({
        nombre: S.txt("Nombre de la plantilla."), texto: S.txt("Nuevo texto, con {{1}}, {{2}}… donde van los datos."),
        tipo: S.en("aviso = UTILITY; promocion = MARKETING. Vacío = sin cambio.", ["aviso", "promocion"]),
        botones: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", properties: { texto: { type: "string" }, url: { type: "string" } } }] }, description: "Botones nuevos: texto (respuesta rápida) o {texto, url} (abre una página). Sustituyen a los anteriores." },
        cabecera_archivo: S.txt("No admitido: la cabecera con archivo se cambia en el panel de plantillas."), cabecera_tipo: S.en("No admitido junto a cabecera_archivo.", ["image", "video", "document"]),
        cuenta_wa: S.txt("Id de la cuenta de WhatsApp Business, si hay varias."), ...CONFIRMA,
      }, ["nombre"]),
      rutas: ["/admin/api/wa-templates"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return fallo("Editar la plantilla la manda otra vez a revisión de Meta. Confírmalo con el usuario y repite con confirmado_por_humano: true.");
        if (str(a.cabecera_archivo) || str(a.cabecera_tipo)) return fallo("La cabecera con archivo no llega a Meta desde aquí: el panel solo guardaría una nota local. Quita cabecera_archivo y cabecera_tipo y cambia la cabecera en el panel de plantillas.");
        if (!str(a.texto) && !str(a.tipo) && a.botones === undefined) return fallo("Pasa texto, tipo o botones.");
        const nombre = str(a.nombre);
        let texto = str(a.texto);
        if (!texto) {
          // Meta y el panel exigen el cuerpo en cada edición: se reutiliza el de la plantilla actual, leído de Meta.
          const lis = await api(c, "GET", "/admin/api/wa-templates" + qs({ waba: str(a.cuenta_wa), refresh: "1" }));
          if (lis.status !== 200) return errorDe(lis);
          const plantillas = (parse(lis.texto) as Args | null)?.templates;
          const actual = (Array.isArray(plantillas) ? (plantillas as Args[]) : []).find((t) => str(t.name) === nombre);
          if (!actual) return fallo("No encuentro la plantilla «" + nombre + "» en esa cuenta de WhatsApp Business.");
          texto = str(actual.body);
          if (!texto) return fallo("No pude leer el texto actual de «" + nombre + "». Pasa texto junto con tipo o botones.");
        }
        const b: Args = { name: nombre, text: texto };
        if (a.tipo === "aviso") b.category = "UTILITY"; else if (a.tipo === "promocion") b.category = "MARKETING";
        if (Array.isArray(a.botones)) b.buttons = (a.botones as unknown[]).map((x) => typeof x === "string" ? { t: x } : { t: str((x as Args).texto), ...(str((x as Args).url) ? { u: str((x as Args).url) } : {}) });
        if (str(a.cuenta_wa)) b.waba = str(a.cuenta_wa);
        return llamar(c, "POST", "/admin/api/wa-templates/edit", b, true);
      },
    },
    {
      name: "borrar_plantilla_whatsapp", title: "Borrar una plantilla de WhatsApp", alcance: "completo", annotations: { ...BORRA, openWorldHint: true },
      description: "Borra la plantilla en Meta (irreversible; los flujos que la usen dejarán de poder enviarla). Confirma con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({ nombre: S.txt("Nombre de la plantilla."), cuenta_wa: S.txt("Id de la cuenta de WhatsApp Business, si hay varias."), ...CONFIRMA }, ["nombre"]),
      rutas: ["/admin/api/wa-templates"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return fallo("Borrar una plantilla es irreversible. Confírmalo con el usuario y repite con confirmado_por_humano: true.");
        return llamar(c, "DELETE", "/admin/api/wa-templates/" + enc(str(a.nombre)) + qs({ waba: str(a.cuenta_wa) }), undefined, true);
      },
    },
    {
      name: "probar_plantilla_whatsapp", title: "Enviar una plantilla a un número de prueba", alcance: "completo", annotations: SALE,
      description: "Envía de verdad una plantilla APROBADA a un teléfono de prueba (gasta un mensaje). Confirma destinatario y parámetros con el usuario: confirmado_por_humano: true.",
      inputSchema: esquema({
        nombre: S.txt("Nombre de la plantilla."), telefono: S.txt("Teléfono con prefijo internacional."), idioma: S.txt("Código de idioma; por defecto el de la plantilla (es)."),
        parametros: S.lista("Un valor por variable, en orden (hasta 10)."), cuenta_wa: S.txt("Id de la cuenta de WhatsApp Business, si hay varias."), ...CONFIRMA,
      }, ["nombre", "telefono"]),
      rutas: ["/admin/api/whatsapp/templates/test-send"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return fallo("Es un envío real. Confírmalo con el usuario y repite con confirmado_por_humano: true.");
        return llamar(c, "POST", "/admin/api/whatsapp/templates/test-send", { name: str(a.nombre), phone: tel(a.telefono) || str(a.telefono), language: str(a.idioma) || "es", params: lista(a.parametros) || [], ...(str(a.cuenta_wa) ? { waba: str(a.cuenta_wa) } : {}) }, true);
      },
    },

    // ── Almacén, variables, avisos ──
    {
      name: "subir_archivo_almacen", title: "Guardar un archivo pequeño en el almacén", alcance: "completo", annotations: CAMBIA,
      description: "Guarda un archivo (base64, hasta 15 MB: imagen JPG/PNG ≤5 MB, vídeo MP4, audio, PDF…) en el almacén del panel y devuelve su id, "
        + "que sirve para los nodos de archivo de los flujos. "
        + "Para vídeos grandes de publicaciones usa subir_archivo (enlace de subida).",
      inputSchema: esquema({ base64: S.txt("Contenido en base64 (sin prefijo data:)."), mime: S.txt("Tipo, p. ej. image/jpeg, video/mp4, application/pdf."), nombre: S.txt("Nombre del archivo.") }, ["base64"]),
      rutas: ["/admin/api/flow-media"],
      run: async (a, c) => llamar(c, "POST", "/admin/api/flow-media", { dataB64: String(a.base64 ?? "").replace(/^data:[^,]*,/, ""), mime: str(a.mime) || "application/octet-stream", name: str(a.nombre) || "archivo" }),
    },
    {
      name: "previsualizar_variables", title: "Probar un texto con variables", alcance: "lectura", annotations: LEE,
      description: "Dice qué variables usa un texto ({{nombre}}, {{etapa}}…) y cómo quedaría con los valores de ejemplo que pases. Sirve para mensajes de flujos, plantillas y difusiones.",
      inputSchema: esquema({ texto: S.txt("El texto con variables."), ejemplo: S.obj("Valores de ejemplo {variable: valor}.") }, ["texto"]),
      rutas: ["/admin/api/vars/preview"],
      run: async (a, c) => llamar(c, "POST", "/admin/api/vars/preview", { text: str(a.texto), sample: a.ejemplo && typeof a.ejemplo === "object" ? a.ejemplo : {} }),
    },
    {
      name: "listar_avisos", title: "Avisos del panel", alcance: "lectura", annotations: LEE,
      description: "Los avisos del panel (lead nuevo, pide persona, salida de flujo, comentario, reunión, pago, difusión, publicación, conexión…), con filtros y paginación "
        + "(limite/desde). Devuelve también cuántos hay sin leer, el recuento por tipo y qué tipos están silenciados.",
      inputSchema: esquema({
        tipos: S.lista("Solo estos tipos: " + TIPOS_AVISO.join(", ") + "."), sin_leer: S.bool("true = solo sin leer."), q: S.txt("Texto a buscar."),
        desde_ms: S.int("Solo desde esta fecha (ms desde 1970)."), hasta_ms: S.int("Solo hasta esta fecha (ms)."),
        limite: S.int("Cuántos (1-200). Por defecto 25.", { minimum: 1, maximum: 200 }), desde: S.int("Cuántos saltar (paginación).", { minimum: 0 }),
      }),
      rutas: ["/admin/api/notifications"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/notifications" + qs({
        kind: lista(a.tipos), unread: a.sin_leer === true ? "1" : "", q: str(a.q), from: a.desde_ms, to: a.hasta_ms,
        limit: Math.min(200, Math.max(1, Math.round(Number(a.limite) || 25))), offset: Math.max(0, Math.round(Number(a.desde) || 0)),
      })),
    },
    {
      name: "marcar_avisos_leidos", title: "Marcar avisos como leídos", alcance: "completo", annotations: IDEMP,
      description: "Marca como leídos los avisos con esos ids (hasta 500) o todos (todo: true).",
      inputSchema: esquema({ ids: { type: "array", items: { type: "integer" }, description: "Ids de los avisos." }, todo: S.bool("true = todos.") }),
      rutas: ["/admin/api/notifications"],
      run: async (a, c) => {
        const ids = Array.isArray(a.ids) ? (a.ids as unknown[]).map((x) => Math.round(Number(x))).filter((n) => Number.isFinite(n)) : [];
        if (a.todo !== true && !ids.length) return fallo("Pasa ids o todo: true.");
        return llamar(c, "POST", "/admin/api/notifications/read", a.todo === true ? { all: true } : { ids });
      },
    },
    {
      name: "configurar_avisos", title: "Qué avisos se silencian", alcance: "completo", annotations: IDEMP,
      description: "Sin argumentos, dice qué tipos de aviso existen y cuáles están silenciados. Con «silenciados», fija la lista COMPLETA de tipos que no avisan "
        + "(para todo el workspace; lista vacía = todos avisan). Tipos: " + TIPOS_AVISO.join(", ") + ".",
      inputSchema: esquema({ silenciados: S.lista("Lista completa de tipos silenciados; vacía = ninguno.") }),
      rutas: ["/admin/api/notifications"],
      run: async (a, c) => {
        if (a.silenciados === undefined) return llamar(c, "GET", "/admin/api/notifications/prefs");
        const s = lista(a.silenciados) || [];
        const malos = s.filter((x) => !TIPOS_AVISO.includes(x));
        if (malos.length) return fallo("Tipos desconocidos: " + malos.join(", ") + ". Válidos: " + TIPOS_AVISO.join(", ") + ".");
        return llamar(c, "POST", "/admin/api/notifications/prefs", { apagadas: s });
      },
    },
  ];
}
