/** MCP-TOTAL-1 · Herramientas MCP de AUTOMATIZACIÓN: perfiles de IA (bots), fichas de conocimiento y agenda,
 *  ajustes de la IA (marca, horario, canales, cumpleaños), reparto de perfiles por cuenta, números de WhatsApp
 *  (nombre, perfil público, recepción de mensajes), disparadores por palabra clave (Instagram, Facebook, YouTube,
 *  LinkedIn y WhatsApp) y su conversión a flujos, extras de flujos (borrar, vaciar, registro, embudo), extras de
 *  difusiones (detalle, anular, emisor, borrar) y difusiones por flujo, comentarios y autorespuesta de LinkedIn,
 *  cuentas de Instagram/Facebook con diagnóstico, goteo de Instagram y rescate de comentarios perdidos.
 *  Contratos: admin.ts (content 3060-3215, bot-accounts 3215-3374, bots/ensayo 3263, quien-contesta 3317,
 *  wa-numbers 3430-3918, automations 3940-3991, wa-automations 9633-9649, convertir-disparadores 19941-19963,
 *  flows 20637-21013, broadcasts 8420-8519, broadcasts/flows|runs|jobs 8555-8794 (solo administradores),
 *  linkedin-comments 15645-15705, linkedin(-community)-accounts 15471-15723, ig-accounts 13825-14252,
 *  fb-accounts 14794, fb-debug 14802, ig-drip 14008-14159, backfill-comments 21419-21443).
 *  Fuera a propósito: alta, baja y credenciales de números y cuentas (wa-numbers POST, wa-numbers/main, discover,
 *  diagnose, connect, reveal-token; ig-accounts POST, poll-test, follow-check, bizdisco-test; linkedin/disconnect y
 *  linkedin-community/disconnect), mantenimiento (ig/deliver-flow-link, ig/purchase-guard-selftest,
 *  flows/media-snap-backfill), flows/runs/cancel (ya lo cubre parar_automatizaciones_contacto) y
 *  linkedin-page[/audience] (son métricas: módulo de analítica). */
import { type Args, type Ctx, type Herramienta, type Kit, type Res, PAGINA, coincide, paginar, parse } from "./mcp-tipos.js";

const REDES_DISPARADOR = ["instagram", "facebook", "youtube", "linkedin", "whatsapp"];
const CANALES_IA = ["whatsapp", "instagram", "facebook", "tiktok"];
const DIAS_SEMANA = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"];
const DIAS_LIMPIEZA = [0, 7, 30, 90, 365];
const ESTADOS_EJECUCION = ["queued", "running", "completed", "cancelled", "failed"];
const ESTADOS_ENVIO = ["queued", "sent", "failed", "cancelled", "skipped"];
const CANALES_ENVIO = ["wa", "ig_dm", "fb_msg", "email", "sms"];
const TOPE_FICHAS = 12;
const TOPE_TEXTO_FICHA = 20000;

export function herramientas(k: Kit): Herramienta[] {
  const { S, esquema, llamar, api, fallo, str, tel, lista, qs, msEnZona, LEE, CAMBIA, IDEMP, BORRA, SALE, CONFIRMA } = k;
  const enc = encodeURIComponent;
  const noConfirmado = (que: string) => fallo(que + " Confírmalo con el usuario y repite con confirmado_por_humano: true.");
  const sinPrefijo = (v: unknown) => String(v || "").replace(/^data:[^,]*,/, "");
  /** Lee una ruta JSON; si falla devuelve la respuesta tal cual (con el error explicado). */
  const lee = async (c: Ctx, ruta: string) => {
    const r = await api(c, "GET", ruta);
    return r.status === 200 ? { json: (parse(r.texto) || {}) as Args } : { res: await llamar(c, "GET", ruta) };
  };
  const salida = (o: unknown) => ({ texto: k.compactar(JSON.stringify(o)) });
  const arr = (v: unknown): Args[] => (Array.isArray(v) ? (v as Args[]) : []);
  const obj = (v: unknown): Args => (v && typeof v === "object" && !Array.isArray(v) ? (v as Args) : {});
  const dado = (v: unknown) => v !== undefined && v !== null;
  /** Copia de un objeto sin las claves indicadas (pesadas o sensibles). */
  const sin = (o: Args, ...claves: string[]): Args => {
    const y: Args = { ...o };
    for (const c of claves) delete y[c];
    return y;
  };
  /** Respuesta de un cambio: lo que dijo el panel más datos propios (id generado, resumen…). */
  const conResultado = (res: Res, extra: Args): Res => {
    if (res.error) return res;
    return { ...res, texto: k.compactar(JSON.stringify({ ...obj(parse(res.texto)), ...extra })) };
  };
  const sinTildes = (v: unknown) => str(v).normalize("NFD").split("").filter((ch) => { const n = ch.charCodeAt(0); return n < 768 || n > 879; }).join("");
  const slug = (v: unknown, tope: number) => sinTildes(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, tope);
  const idNuevo = (base: unknown, usados: Set<string>, prefijo: string) => {
    const raiz = slug(base, 36) || prefijo + Date.now().toString(36);
    let id = raiz;
    for (let n = 2; usados.has(id); n++) id = raiz + "-" + n;
    return id;
  };
  const entero = (v: unknown, min: number, max: number, porDefecto: number) => Math.min(max, Math.max(min, Math.round(Number(v) || porDefecto)));

  // ── Perfiles de IA y fichas: todo vive en GET/POST /admin/api/content (se lee, se toca solo lo pedido, se reenvía) ──
  const CONTENT = "/admin/api/content";
  const perfiles = (cur: Args): Args[] => arr(parse(str(cur.botsJson)));
  const fichas = (cur: Args): Args[] => arr(cur.packs);
  const resumenPerfil = (b: Args, texto: boolean): Args => {
    const out: Args = { ...sin(b, "system", "knowledge"), instrucciones_chars: str(b.system).length };
    if (str(b.knowledge)) out.conocimiento_propio_chars = str(b.knowledge).length;
    if (texto) { out.system = b.system; if (str(b.knowledge)) out.knowledge = b.knowledge; }
    return out;
  };
  const resumenFicha = (p: Args, texto: boolean): Args => ({ ...sin(p, "text"), texto_chars: str(p.text).length, ...(texto ? { text: p.text } : {}) });
  const usosDeFicha = (bots: Args[], id: string) =>
    bots.filter((b) => str(b.agendaPackId) === id || str(b.knowledgePackId) === id || (lista(b.knowledgePackIds) || []).includes(id)).map((b) => str(b.id));
  const AUT = "/admin/api/automations";
  const WAUT = "/admin/api/wa-automations";
  const redDe = (x: Args) => str(x.platform) || "instagram";
  const DIF = "/admin/api/broadcasts";

  return [
    // ── Perfiles de IA (bots) ──
    {
      name: "listar_bots", title: "Listar perfiles de IA", alcance: "lectura", annotations: LEE,
      description: "Perfiles de IA (bots) del negocio: nombre, si está activo, campaña, fichas de conocimiento y agenda que usan, palabras que los enrutan. "
        + "Las instrucciones completas solo con texto: true (o con ver_bot). Para saber qué perfil contesta en cada cuenta: ver_perfiles_por_cuenta.",
      inputSchema: esquema({ q: S.txt("Filtro por nombre, descripción, campaña o id."), texto: S.bool("true = incluye las instrucciones completas de cada perfil."), ...PAGINA }),
      rutas: [CONTENT],
      run: async (a, c) => {
        const r = await lee(c, CONTENT); if (r.res) return r.res;
        const bots = perfiles(r.json).filter((b) => coincide(b, str(a.q), ["name", "description", "campaign", "id"]));
        const fi = fichas(r.json).map((p) => ({ id: p.id, nombre: p.name, agenda: !!p.agenda }));
        return salida({ fichas: fi, ...paginar(bots.map((b) => resumenPerfil(b, a.texto === true)), a) });
      },
    },
    {
      name: "ver_bot", title: "Ver un perfil de IA", alcance: "lectura", annotations: LEE,
      description: "Un perfil de IA completo: instrucciones, saludo, conocimiento propio, fichas que usa (nombre y tamaño; el texto de una ficha con ver_paquete_conocimiento), agenda, palabras clave, estado.",
      inputSchema: esquema({ id: S.txt("Id del perfil (listar_bots).") }, ["id"]),
      rutas: [CONTENT],
      run: async (a, c) => {
        const r = await lee(c, CONTENT); if (r.res) return r.res;
        const b = perfiles(r.json).find((x) => str(x.id) === str(a.id));
        if (!b) return fallo("No hay ningún perfil con ese id. Mira listar_bots.");
        const ids = new Set([...(lista(b.knowledgePackIds) || []), str(b.knowledgePackId), str(b.agendaPackId)].filter(Boolean));
        const fi = fichas(r.json).filter((p) => ids.has(str(p.id))).map((p) => resumenFicha(p, false));
        return salida({ perfil: resumenPerfil(b, true), fichas: fi });
      },
    },
    {
      name: "guardar_bot", title: "Crear o editar un perfil de IA", alcance: "completo", annotations: CAMBIA,
      description: "Crea un perfil de IA (sin id; hacen falta nombre e instrucciones) o edita uno existente (con id) tocando solo los campos que pases. "
        + "El resto de perfiles y ajustes no se modifican. Las fichas se validan contra listar_paquetes_conocimiento. Se aplica al instante en las conversaciones.",
      inputSchema: esquema({
        id: S.txt("Id del perfil a editar. Sin id se crea uno nuevo (el id sale del nombre)."),
        nombre: S.txt("Nombre del perfil."),
        instrucciones: S.txt("Instrucciones del sistema: quién es, cómo habla, qué vende, qué no hace. Obligatorio al crear."),
        saludo: S.txt("Primer mensaje al abrir una conversación nueva."),
        descripcion: S.txt("Frase corta de cuándo usar este perfil (la lee el clasificador que reparte conversaciones)."),
        campana: S.txt("Campaña a la que pertenece."),
        conocimiento: S.txt("Conocimiento propio del perfil, en texto (además de las fichas)."),
        fichas: S.lista("Ids de las fichas de conocimiento que usa (sustituye la lista entera; [] = ninguna)."),
        ficha_agenda: S.txt("Id de la ficha cuya agenda usa para proponer citas; «» para que no proponga horas."),
        palabras_clave: S.txt("Palabras o expresión regular que enrutan a este perfil si la IA no decide."),
        activo: S.bool("false = pausado (no contesta)."),
        predeterminado: S.bool("true = perfil por defecto (se lo quita a los demás)."),
      }),
      rutas: [CONTENT],
      run: async (a, c) => {
        const r = await lee(c, CONTENT); if (r.res) return r.res;
        const bots = perfiles(r.json);
        const fi = fichas(r.json);
        let b = bots.find((x) => str(x.id) === str(a.id));
        if (!b) {
          if (str(a.id)) return fallo("No hay ningún perfil con ese id. Para crear uno nuevo no pases id.");
          if (!str(a.nombre) || !str(a.instrucciones)) return fallo("Para crear un perfil hacen falta nombre e instrucciones.");
          b = { id: idNuevo(a.nombre, new Set(bots.map((x) => str(x.id))), "perfil-"), system: "", enabled: true };
          bots.push(b);
        }
        if (dado(a.nombre)) b.name = str(a.nombre);
        if (dado(a.instrucciones)) b.system = str(a.instrucciones);
        if (dado(a.saludo)) b.greeting = str(a.saludo);
        if (dado(a.descripcion)) b.description = str(a.descripcion);
        if (dado(a.campana)) b.campaign = str(a.campana);
        if (dado(a.conocimiento)) b.knowledge = str(a.conocimiento);
        if (dado(a.palabras_clave)) b.routeKeywords = str(a.palabras_clave);
        if (typeof a.activo === "boolean") b.enabled = a.activo;
        if (dado(a.fichas)) {
          const ids = lista(a.fichas) || [];
          const conocidas = new Set(fi.map((p) => str(p.id)));
          const malas = ids.filter((x) => !conocidas.has(x));
          if (malas.length) return fallo("Fichas desconocidas: " + malas.join(", ") + ". Mira listar_paquetes_conocimiento.");
          b.knowledgePackIds = ids;
          delete b.knowledgePackId;
        }
        if (dado(a.ficha_agenda)) {
          const id = str(a.ficha_agenda);
          if (!id) delete b.agendaPackId;
          else {
            const p = fi.find((x) => str(x.id) === id);
            if (!p) return fallo("No hay ninguna ficha con ese id. Mira listar_paquetes_conocimiento.");
            if (!p.agenda) return fallo("Esa ficha no tiene agenda: ponle evento y horario con guardar_paquete_conocimiento.");
            b.agendaPackId = id;
          }
        }
        if (typeof a.predeterminado === "boolean") {
          if (a.predeterminado) for (const x of bots) x.isDefault = x === b;
          else delete b.isDefault;
        }
        return conResultado(await llamar(c, "POST", CONTENT, { botsJson: JSON.stringify(bots) }), { perfil: resumenPerfil(b, false) });
      },
    },
    {
      name: "borrar_bot", title: "Borrar un perfil de IA", alcance: "completo", annotations: BORRA,
      description: "Elimina un perfil de IA. No se puede deshacer; las cuentas que lo tenían asignado pasan a «la IA decide». Pide confirmado_por_humano: true.",
      inputSchema: esquema({ id: S.txt("Id del perfil."), ...CONFIRMA }, ["id"]),
      rutas: [CONTENT],
      run: async (a, c) => {
        const r = await lee(c, CONTENT); if (r.res) return r.res;
        const bots = perfiles(r.json);
        const i = bots.findIndex((x) => str(x.id) === str(a.id));
        if (i < 0) return fallo("No hay ningún perfil con ese id.");
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar el perfil «" + (str(bots[i].name) || str(a.id)) + "» no se puede deshacer.");
        const [b] = bots.splice(i, 1);
        return conResultado(await llamar(c, "POST", CONTENT, { botsJson: JSON.stringify(bots) }, true), { borrado: { id: b.id, nombre: b.name }, quedan: bots.length });
      },
    },

    // ── Fichas de conocimiento (y su agenda) ──
    {
      name: "listar_paquetes_conocimiento", title: "Listar fichas de conocimiento", alcance: "lectura", annotations: LEE,
      description: "Fichas de conocimiento del negocio (máximo 12): nombre, campaña, tamaño del texto, si tiene agenda y qué perfiles la usan. El texto completo solo con texto: true.",
      inputSchema: esquema({ q: S.txt("Filtro por nombre, campaña o id."), texto: S.bool("true = incluye el texto completo de cada ficha."), ...PAGINA }),
      rutas: [CONTENT],
      run: async (a, c) => {
        const r = await lee(c, CONTENT); if (r.res) return r.res;
        const bots = perfiles(r.json);
        const items = fichas(r.json).filter((p) => coincide(p, str(a.q), ["name", "campaign", "id"]))
          .map((p) => ({ ...resumenFicha(p, a.texto === true), usada_por: usosDeFicha(bots, str(p.id)) }));
        return salida({ tope: TOPE_FICHAS, ...paginar(items, a) });
      },
    },
    {
      name: "ver_paquete_conocimiento", title: "Ver una ficha de conocimiento", alcance: "lectura", annotations: LEE,
      description: "Una ficha completa: texto, campaña, agenda (evento, duración, horario por día) y qué perfiles la usan.",
      inputSchema: esquema({ id: S.txt("Id de la ficha."), texto: S.bool("false = sin el texto (solo cabecera y agenda).") }, ["id"]),
      rutas: [CONTENT],
      run: async (a, c) => {
        const r = await lee(c, CONTENT); if (r.res) return r.res;
        const p = fichas(r.json).find((x) => str(x.id) === str(a.id));
        if (!p) return fallo("No hay ninguna ficha con ese id. Mira listar_paquetes_conocimiento.");
        return salida({ ficha: resumenFicha(p, a.texto !== false), usada_por: usosDeFicha(perfiles(r.json), str(p.id)) });
      },
    },
    {
      name: "guardar_paquete_conocimiento", title: "Crear o editar una ficha de conocimiento", alcance: "completo", annotations: CAMBIA,
      description: "Crea una ficha (sin id; hace falta nombre) o edita una existente (con id) tocando solo lo que pases. Con «agenda» la ficha puede proponer citas: "
        + "evento, duración y tramos por día. Las demás fichas no se tocan. Para que un perfil la use: guardar_bot con fichas o ficha_agenda.",
      inputSchema: esquema({
        id: S.txt("Id de la ficha a editar; sin id se crea una (el id sale del nombre)."),
        nombre: S.txt("Nombre de la ficha."),
        texto: S.txt("Contenido en texto (hasta 20.000 caracteres)."),
        campana: S.txt("Campaña a la que pertenece."),
        agenda: {
          type: "object", description: "Agenda para proponer citas (se mezcla con la que tenga).",
          properties: {
            evento: S.txt("Nombre de la cita o evento (hasta 200 caracteres)."),
            duracion_min: S.int("Duración en minutos (10-240; 30 por defecto)."),
            horario: { type: "object", description: "Tramos por día: lun, mar, mie, jue, vie, sab, dom → «10:00-14:00, 16:00-19:00»; vacío = ese día no atiende.", additionalProperties: { type: "string" } },
          },
        },
        quitar_agenda: S.bool("true = la ficha deja de tener agenda."),
      }),
      rutas: [CONTENT],
      run: async (a, c) => {
        const r = await lee(c, CONTENT); if (r.res) return r.res;
        const packs = fichas(r.json);
        let p = packs.find((x) => str(x.id) === str(a.id));
        if (!p) {
          if (str(a.id)) return fallo("No hay ninguna ficha con ese id. Para crear una nueva no pases id.");
          if (!str(a.nombre)) return fallo("Para crear una ficha hace falta nombre.");
          if (packs.length >= TOPE_FICHAS) return fallo("Ya hay " + TOPE_FICHAS + " fichas, el máximo. Borra o reutiliza una.");
          p = { id: idNuevo(a.nombre, new Set(packs.map((x) => str(x.id))), "ficha-"), name: "", text: "" };
          packs.push(p);
        }
        if (dado(a.nombre)) p.name = str(a.nombre);
        if (dado(a.texto)) {
          if (str(a.texto).length > TOPE_TEXTO_FICHA) return fallo("El texto pasa de " + TOPE_TEXTO_FICHA.toLocaleString("es-ES") + " caracteres: recórtalo o reparte en dos fichas.");
          p.text = str(a.texto);
        }
        if (dado(a.campana)) p.campaign = str(a.campana);
        if (a.quitar_agenda === true) p.agenda = null;
        else if (dado(a.agenda)) {
          const ag = obj(a.agenda);
          const prev = obj(p.agenda);
          const horario: Args = { ...obj(prev.horario) };
          for (const [d, v] of Object.entries(obj(ag.horario))) {
            if (!DIAS_SEMANA.includes(d)) return fallo("Día desconocido en el horario: «" + d + "». Usa lun, mar, mie, jue, vie, sab o dom.");
            horario[d] = str(v);
          }
          const evento = dado(ag.evento) ? str(ag.evento).slice(0, 200) : str(prev.evento);
          if (!evento) return fallo("La agenda necesita un «evento» (qué cita se propone).");
          const dur = dado(ag.duracion_min) ? Number(ag.duracion_min) : Number(prev.duracionMin) || 30;
          if (!(dur >= 10 && dur <= 240)) return fallo("La duración va de 10 a 240 minutos.");
          // El panel descarta en silencio una agenda sin ningún día con horario: se dice aquí en vez de contestar «guardada».
          for (const d of Object.keys(horario)) horario[d] = str(horario[d]).trim();
          if (!Object.values(horario).some((h) => str(h))) return fallo("La agenda necesita al menos un día con horario (por ejemplo «10:00-14:00»). Para quitarla usa quitar_agenda: true.");
          p.agenda = { evento, duracionMin: Math.round(dur), horario };
        }
        return conResultado(await llamar(c, "POST", CONTENT, { packs }), { ficha: resumenFicha(p, false) });
      },
    },
    {
      name: "borrar_paquete_conocimiento", title: "Borrar una ficha de conocimiento", alcance: "completo", annotations: BORRA,
      description: "Elimina una ficha y la quita de los perfiles que la usaban (conocimiento y agenda). No se puede deshacer: pide confirmado_por_humano: true.",
      inputSchema: esquema({ id: S.txt("Id de la ficha."), ...CONFIRMA }, ["id"]),
      rutas: [CONTENT],
      run: async (a, c) => {
        const r = await lee(c, CONTENT); if (r.res) return r.res;
        const packs = fichas(r.json);
        const id = str(a.id);
        const i = packs.findIndex((x) => str(x.id) === id);
        if (i < 0) return fallo("No hay ninguna ficha con ese id.");
        const bots = perfiles(r.json);
        const usada = usosDeFicha(bots, id);
        if (a.confirmado_por_humano !== true) {
          return noConfirmado("Borrar la ficha «" + (str(packs[i].name) || id) + "» no se puede deshacer" + (usada.length ? " y la usan los perfiles " + usada.join(", ") : "") + ".");
        }
        packs.splice(i, 1);
        for (const b of bots) {
          if (str(b.agendaPackId) === id) delete b.agendaPackId;
          if (str(b.knowledgePackId) === id) delete b.knowledgePackId;
          if (Array.isArray(b.knowledgePackIds)) b.knowledgePackIds = (lista(b.knowledgePackIds) || []).filter((x) => x !== id);
        }
        const body: Args = { packs };
        if (usada.length) body.botsJson = JSON.stringify(bots);
        return conResultado(await llamar(c, "POST", CONTENT, body, true), { borrada: id, perfiles_actualizados: usada, quedan: packs.length });
      },
    },
    {
      name: "vista_previa_agenda", title: "Ver cómo queda la agenda de una ficha", alcance: "lectura", annotations: LEE,
      description: "Resumen legible de la agenda de una ficha (evento, duración, tramos por día) tal como la entiende la IA al proponer citas. No cambia nada.",
      inputSchema: esquema({ ficha: S.txt("Id de la ficha con agenda.") }, ["ficha"]),
      rutas: [CONTENT],
      run: async (a, c) => llamar(c, "GET", CONTENT + "/agenda-preview" + qs({ pack: str(a.ficha) })),
    },
    {
      name: "ajustes_bot", title: "Ver o cambiar los ajustes de la IA", alcance: "completo", annotations: IDEMP,
      description: "Sin argumentos devuelve los ajustes generales de la IA: marca, enlace de reserva, horario de atención, canales con respuesta automática, "
        + "conocimiento general (tamaño; completo con texto: true), felicitación de cumpleaños, nombre y etapas del pipeline, eventos. "
        + "Con argumentos cambia SOLO lo que pases (el horario y los canales se mezclan con lo que hay).",
      inputSchema: esquema({
        marca: S.txt("Nombre de marca con el que se presenta la IA."),
        enlace_reserva: S.txt("Enlace de reserva de citas que la IA puede ofrecer; «» para quitarlo."),
        horario: {
          type: "object", description: "Horario de atención de la IA (se mezcla con el actual).",
          properties: {
            activo: S.bool("true = fuera de horario la IA no contesta y deja el aviso."),
            dias: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "Días que atiende: 0 domingo, 1 lunes … 6 sábado." },
            desde: S.txt("Hora de inicio, HH:MM."),
            hasta: S.txt("Hora de fin, HH:MM."),
            zona: S.txt("Zona horaria, p. ej. Europe/Madrid."),
            aviso: S.txt("Mensaje que deja fuera de horario (hasta 400 caracteres)."),
          },
        },
        respuesta_automatica: { type: "object", description: "Qué canales contesta la IA sola: whatsapp, instagram, facebook, tiktok → true/false (solo los que pases).", additionalProperties: { type: "boolean" } },
        conocimiento_general: S.txt("Base de conocimiento común a todos los perfiles (texto)."),
        plantilla_cumpleanos: S.txt("Plantilla de WhatsApp con la que felicita los cumpleaños; «» para desactivarlo."),
        idioma_cumpleanos: S.txt("Idioma de esa plantilla (p. ej. es)."),
        nombre_pipeline: S.txt("Nombre visible del pipeline de ventas."),
        texto: S.bool("Al consultar: true = incluye el conocimiento general completo."),
      }),
      rutas: [CONTENT],
      run: async (a, c) => {
        const body: Args = {};
        if (dado(a.marca)) body.brand = str(a.marca);
        if (dado(a.enlace_reserva)) body.bookingUrl = str(a.enlace_reserva);
        if (dado(a.conocimiento_general)) body.knowledge = str(a.conocimiento_general);
        if (dado(a.plantilla_cumpleanos)) body.birthdayTemplate = str(a.plantilla_cumpleanos);
        if (dado(a.idioma_cumpleanos)) body.birthdayLang = str(a.idioma_cumpleanos);
        if (dado(a.nombre_pipeline)) body.pipelineName = str(a.nombre_pipeline);
        if (dado(a.respuesta_automatica)) {
          const ra: Args = {};
          for (const [canal, v] of Object.entries(obj(a.respuesta_automatica))) {
            if (!CANALES_IA.includes(canal)) return fallo("Canal desconocido: «" + canal + "». Vale whatsapp, instagram, facebook o tiktok.");
            ra[canal] = v === true;
          }
          if (Object.keys(ra).length) body.autoReply = ra;
        }
        const r = await lee(c, CONTENT); if (r.res) return r.res;
        const cur = r.json;
        if (dado(a.horario)) {
          const h: Args = { ...obj(cur.horario), ...obj(a.horario) };
          if (!/^\d{2}:\d{2}$/.test(str(h.desde)) || !/^\d{2}:\d{2}$/.test(str(h.hasta))) return fallo("Las horas van como HH:MM (p. ej. 09:00).");
          body.horario = h;
        }
        if (!Object.keys(body).length) {
          return salida({
            ...sin(cur, "botsJson", "packs", "knowledge"),
            conocimiento_general_chars: str(cur.knowledge).length,
            ...(a.texto === true ? { conocimiento_general: cur.knowledge } : {}),
            perfiles: perfiles(cur).length, fichas: fichas(cur).length,
          });
        }
        return llamar(c, "POST", CONTENT, body);
      },
    },
    {
      name: "ensayar_perfil_ia", title: "Ensayar un perfil de IA", alcance: "lectura", annotations: { ...LEE, idempotentHint: false },
      description: "Manda un mensaje de prueba a un perfil de IA y devuelve lo que contestaría, qué datos guardaría, qué etiquetas pondría, si pasaría a una persona "
        + "y qué haría con la agenda. No llega a ningún cliente ni se guarda nada; sí consume IA. Funciona aunque el perfil esté pausado.",
      inputSchema: esquema({
        id: S.txt("Id del perfil."),
        texto: S.txt("Mensaje del cliente (hasta 2.000 caracteres)."),
        historial: {
          type: "array", maxItems: 12, description: "Turnos anteriores, del más antiguo al más reciente (hasta 12).",
          items: { type: "object", properties: { rol: S.en("Quién habla.", ["usuario", "asistente"]), texto: S.txt("Texto del turno.") }, required: ["rol", "texto"] },
        },
      }, ["id", "texto"]),
      rutas: ["/admin/api/bots"],
      run: async (a, c) => {
        if (!str(a.texto)) return fallo("Pasa el mensaje del cliente en texto.");
        const historial = arr(a.historial).map((t) => ({ role: /^(asistente|assistant)$/i.test(str(t.rol)) ? "assistant" : "user", content: str(t.texto).slice(0, 2000) })).filter((t) => t.content);
        return llamar(c, "POST", "/admin/api/bots/" + enc(str(a.id)) + "/ensayo", { texto: str(a.texto).slice(0, 2000), ...(historial.length ? { historial } : {}) });
      },
    },
    {
      name: "quien_contestaria", title: "Saber qué perfil contestaría un mensaje", alcance: "lectura", annotations: LEE,
      description: "Dado un mensaje (y opcionalmente la cuenta por la que entra) explica qué perfil de IA lo atendería y por qué: fijo en la cuenta, solo humano, palabra clave, "
        + "decisión de la IA, predeterminado… No envía nada ni guarda nada.",
      inputSchema: esquema({
        texto: S.txt("Mensaje del cliente."),
        cuenta: S.txt("Cuenta por la que entra: «wa:<número>», «ig:<cuenta>» o «fb:<página>» (ver_perfiles_por_cuenta). Vacío = reparto general."),
      }, ["texto"]),
      rutas: ["/admin/api/bots"],
      run: async (a, c) => llamar(c, "POST", "/admin/api/bots/quien-contesta", { texto: str(a.texto), ...(str(a.cuenta) ? { cuenta: str(a.cuenta) } : {}) }),
    },
    {
      name: "ver_perfiles_por_cuenta", title: "Ver qué perfil atiende cada cuenta", alcance: "lectura", annotations: LEE,
      description: "Cuentas conectadas (WhatsApp, Instagram, Facebook) con el perfil de IA asignado a cada una: un perfil fijo, «solo humano» o «la IA decide». "
        + "Incluye qué está contestando ahora mismo en cada canal.",
      inputSchema: esquema({ ...PAGINA }),
      rutas: ["/admin/api/bot-accounts"],
      run: async (a, c) => {
        const r = await lee(c, "/admin/api/bot-accounts"); if (r.res) return r.res;
        const cuentas = arr(r.json.cuentas).map((x) => ({ ...sin(x, "ref"), perfil: str(x.botId) === "__none__" ? "solo humano" : str(x.botId) || "la IA decide" }));
        return salida({ perfiles: r.json.bots, ahora: r.json.ahora, ...paginar(cuentas, a) });
      },
    },
    {
      name: "asignar_perfil_a_cuenta", title: "Asignar un perfil de IA a una cuenta", alcance: "completo", annotations: IDEMP,
      description: "Fija qué perfil atiende una cuenta (o varias): un id de perfil, «humano» (nadie automático) o «ia» (la IA elige entre los perfiles activos). "
        + "El resto de cuentas no cambian. Se aplica al instante.",
      inputSchema: esquema({
        cuenta: S.txt("Cuenta: «wa:<número>», «ig:<cuenta>» o «fb:<página>», tal como la da ver_perfiles_por_cuenta."),
        perfil: S.txt("Id del perfil (listar_bots), «humano» o «ia»."),
        asignaciones: {
          type: "array", description: "Varias asignaciones de golpe, en vez de cuenta + perfil.",
          items: { type: "object", properties: { cuenta: S.txt("Cuenta."), perfil: S.txt("Perfil, «humano» o «ia».") }, required: ["cuenta", "perfil"] },
        },
      }),
      rutas: ["/admin/api/bot-accounts"],
      run: async (a, c) => {
        const pares = arr(a.asignaciones).length ? arr(a.asignaciones) : [{ cuenta: a.cuenta, perfil: a.perfil }];
        const r = await lee(c, "/admin/api/bot-accounts"); if (r.res) return r.res;
        const cuentas = arr(r.json.cuentas);
        const bots = new Set(arr(r.json.bots).map((b) => str(b.id)));
        const map: Args = {};
        for (const q of cuentas) if (str(q.botId)) map[str(q.key)] = str(q.botId);
        const cambios: Args[] = [];
        for (const p of pares) {
          const key = str(p.cuenta);
          const perfil = str(p.perfil);
          const q = cuentas.find((x) => str(x.key) === key);
          if (!q) return fallo("Cuenta desconocida: «" + key + "». Las que hay: " + (cuentas.map((x) => str(x.key)).join(", ") || "ninguna") + ".");
          let botId: string;
          if (/^(ia|auto|automatico|automático)$/i.test(perfil)) botId = "";
          else if (/^(humano|solo[ -]humano|nadie|__none__)$/i.test(perfil)) botId = "__none__";
          else if (bots.has(perfil)) botId = perfil;
          else return fallo("Perfil desconocido: «" + perfil + "». Vale un id de listar_bots, «humano» o «ia».");
          if (botId) map[key] = botId; else delete map[key];
          cambios.push({ cuenta: key, nombre: q.label, perfil: botId === "__none__" ? "solo humano" : botId || "la IA decide" });
        }
        return conResultado(await llamar(c, "POST", "/admin/api/bot-accounts", { map }), { cambios });
      },
    },

    // ── Números de WhatsApp ──
    {
      name: "listar_numeros_whatsapp", title: "Listar números de WhatsApp", alcance: "lectura", annotations: LEE,
      description: "Números de WhatsApp del negocio: teléfono, nombre, vía (nube o QR), perfil de IA asignado, cuál es el principal y si está en la app del móvil. "
        + "Conectar o quitar números se hace desde Conexiones en el panel.",
      inputSchema: esquema({ ...PAGINA }),
      rutas: ["/admin/api/wa-numbers"],
      run: async (a, c) => {
        const r = await lee(c, "/admin/api/wa-numbers"); if (r.res) return r.res;
        const numeros = arr(r.json.numbers).map((n) => sin(n, "tokenMask"));
        return salida({ perfil_principal: r.json.mainBotId, perfiles: arr(r.json.bots).map((b) => str(b.id)), ...paginar(numeros, a) });
      },
    },
    {
      name: "renombrar_numero_whatsapp", title: "Cambiar el nombre de un número", alcance: "completo", annotations: IDEMP,
      description: "Cambia el nombre interno con el que el panel muestra un número de WhatsApp (no cambia nada en WhatsApp).",
      inputSchema: esquema({ numero: S.txt("Número tal como lo da listar_numeros_whatsapp (phoneNumberId)."), nombre: S.txt("Nombre nuevo.") }, ["numero", "nombre"]),
      rutas: ["/admin/api/wa-numbers"],
      run: async (a, c) => llamar(c, "POST", "/admin/api/wa-numbers/label", { phoneNumberId: str(a.numero), label: str(a.nombre) }),
    },
    {
      name: "ver_perfil_whatsapp", title: "Ver el perfil público de un número", alcance: "lectura", annotations: LEE,
      description: "Perfil público de WhatsApp Business de un número: descripción, texto «sobre», dirección, correo, webs, sector y foto. Solo números de la nube.",
      inputSchema: esquema({ numero: S.txt("Número (phoneNumberId de listar_numeros_whatsapp).") }, ["numero"]),
      rutas: ["/admin/api/wa-numbers"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/wa-numbers/" + enc(str(a.numero)) + "/profile"),
    },
    {
      name: "cambiar_perfil_whatsapp", title: "Cambiar el perfil público de un número", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Cambia en WhatsApp el perfil público de un número de la nube: «sobre», descripción, dirección, correo, sector, webs y/o foto. "
        + "Lo ven todos los clientes al instante: pide confirmado_por_humano: true. Solo se envían los campos que pases.",
      inputSchema: esquema({
        numero: S.txt("Número (phoneNumberId de listar_numeros_whatsapp)."),
        sobre: S.txt("Texto «sobre» (hasta 139 caracteres)."),
        descripcion: S.txt("Descripción del negocio (hasta 512)."),
        direccion: S.txt("Dirección (hasta 256)."),
        email: S.txt("Correo de contacto."),
        sector: S.txt("Sector según WhatsApp: OTHER, AUTO, BEAUTY, APPAREL, EDU, ENTERTAIN, EVENT_PLAN, FINANCE, GROCERY, GOVT, HOTEL, HEALTH, NONPROFIT, PROF_SERVICES, RETAIL, TRAVEL, RESTAURANT."),
        webs: S.lista("Hasta dos webs."),
        foto: S.txt("Foto de perfil en base64 (vale con prefijo data:)."),
        foto_mime: S.txt("Tipo de la foto (image/jpeg por defecto)."),
        ...CONFIRMA,
      }, ["numero"]),
      rutas: ["/admin/api/wa-numbers"],
      run: async (a, c) => {
        const pid = enc(str(a.numero));
        const perfil: Args = {};
        if (dado(a.sobre)) perfil.about = str(a.sobre).slice(0, 139);
        if (dado(a.descripcion)) perfil.description = str(a.descripcion).slice(0, 512);
        if (dado(a.direccion)) perfil.address = str(a.direccion).slice(0, 256);
        if (dado(a.email)) perfil.email = str(a.email).slice(0, 128);
        if (dado(a.sector)) perfil.vertical = str(a.sector).toUpperCase();
        if (dado(a.webs)) perfil.websites = (lista(a.webs) || []).slice(0, 2);
        const foto = sinPrefijo(a.foto);
        if (!Object.keys(perfil).length && !foto) return fallo("Pasa algún dato del perfil (sobre, descripcion, direccion, email, sector, webs) o una foto.");
        if (a.confirmado_por_humano !== true) return noConfirmado("Cambiar el perfil público de WhatsApp lo ven todos los clientes al instante.");
        let res: Res | undefined;
        if (Object.keys(perfil).length) {
          res = await llamar(c, "POST", "/admin/api/wa-numbers/" + pid + "/profile", perfil, true);
          if (res.error) return res;
        }
        if (foto) {
          const r2 = await llamar(c, "POST", "/admin/api/wa-numbers/" + pid + "/photo", { photo: foto, mime: str(a.foto_mime) || "image/jpeg" }, true);
          if (r2.error || !res) return r2;
          res = { ...r2, texto: "Perfil guardado. Foto: " + r2.texto };
        }
        return res || fallo("No había nada que cambiar.");
      },
    },
    {
      name: "reparar_recepcion_mensajes", title: "Reparar la recepción de mensajes y comentarios", alcance: "completo", annotations: { ...IDEMP, openWorldHint: true },
      description: "Vuelve a suscribir en Meta los avisos de los números de WhatsApp y/o las cuentas de Instagram, para cuando dejan de llegar mensajes o comentarios al panel. "
        + "Repetible. Si delante del panel hay una pasarela que reparte los avisos, esto puede desviarlos: pide confirmado_por_humano: true. Diagnóstico previo: diagnosticar_cuenta_red.",
      inputSchema: esquema({ canal: S.en("Qué reparar (ambos por defecto).", ["whatsapp", "instagram", "ambos"]), ...CONFIRMA }),
      rutas: ["/admin/api/wa-numbers", "/admin/api/ig-accounts"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Esto vuelve a apuntar a este panel las entregas de Meta (mensajes y comentarios).");
        const canal = str(a.canal) || "ambos";
        const out: Args = {};
        let ultimo: Res | undefined;
        if (canal !== "instagram") {
          ultimo = await llamar(c, "POST", "/admin/api/wa-numbers/subscribe-webhooks", {}, true);
          out.whatsapp = ultimo.error ? { error: ultimo.texto } : parse(ultimo.texto) ?? ultimo.texto;
        }
        if (canal !== "whatsapp") {
          ultimo = await llamar(c, "POST", "/admin/api/ig-accounts/subscribe-webhooks", {}, true);
          out.instagram = ultimo.error ? { error: ultimo.texto } : parse(ultimo.texto) ?? ultimo.texto;
        }
        return { ...salida(out), ...(ultimo?.cambio ? { cambio: ultimo.cambio } : {}) };
      },
    },

    // ── Disparadores por palabra clave ──
    {
      name: "listar_disparadores", title: "Listar disparadores por palabra clave", alcance: "lectura", annotations: LEE,
      description: "Disparadores de todas las redes: comentarios de Instagram, Facebook, YouTube y LinkedIn (respuesta pública + mensaje privado) y mensajes de WhatsApp "
        + "(respuesta, etiqueta, secuencia, pasar a persona). Con su palabra clave, publicación y si están activos. Los flujos van aparte (listar_flujos).",
      inputSchema: esquema({ red: S.en("Solo los de una red.", REDES_DISPARADOR), q: S.txt("Filtro por nombre, palabra clave o id."), ...PAGINA }),
      rutas: [AUT],
      run: async (a, c) => {
        const r = await lee(c, AUT); if (r.res) return r.res;
        const red = str(a.red);
        const items = arr(r.json.automations).filter((x) => (!red || redDe(x) === red) && coincide(x, str(a.q), ["name", "keyword", "id"]));
        return salida(paginar(items, a));
      },
    },
    {
      name: "guardar_disparador", title: "Crear o editar un disparador", alcance: "completo", annotations: CAMBIA,
      description: "Crea un disparador (sin id: hacen falta red y nombre) o edita uno (con id) tocando solo lo que pases. En Instagram, Facebook, YouTube y LinkedIn reacciona "
        + "a comentarios: respuesta pública, mensaje privado con enlace y botón, o respuesta redactada por la IA. En WhatsApp reacciona a mensajes: respuesta, enlace, "
        + "etiqueta, secuencia, pasar a persona o parar la IA. Un disparador activo actúa al instante con clientes reales.",
      inputSchema: esquema({
        id: S.txt("Id del disparador a editar; sin id se crea uno."),
        red: S.en("Red (obligatoria al crear; no se puede cambiar después).", REDES_DISPARADOR),
        nombre: S.txt("Nombre (obligatorio al crear)."),
        activo: S.bool("false = pausado."),
        palabra_clave: S.txt("Palabra o frase que lo dispara; «» = cualquier comentario o mensaje."),
        una_vez_por_persona: S.bool("true = solo la primera vez que esa persona escribe (por defecto al crear)."),
        publicacion: S.txt("Comentarios: id de la publicación, o «any» para todas (por defecto)."),
        cuenta_youtube: S.txt("YouTube: id del canal, o «any» (por defecto)."),
        respuesta_comentario: S.txt("Comentarios: respuesta pública al comentario."),
        mensaje_privado: S.txt("Comentarios: mensaje privado que se envía a quien comenta."),
        enlace: S.txt("Enlace a incluir (en el mensaje privado, o en la respuesta de WhatsApp)."),
        texto_boton: S.txt("Comentarios: texto del botón del enlace."),
        respuesta_ia: S.bool("Comentarios: true = la IA redacta la respuesta."),
        instrucciones_ia: S.txt("Comentarios: instrucciones para esa IA."),
        respuesta: S.txt("WhatsApp: respuesta al mensaje."),
        etiqueta: S.txt("WhatsApp: etiqueta que se pone al contacto."),
        pasar_a_persona: S.bool("WhatsApp: true = avisa y pasa la conversación a una persona."),
        secuencia: S.txt("WhatsApp: id de la secuencia que arranca (listar_secuencias)."),
        parar_ia: S.bool("WhatsApp: true = la IA deja de contestar a ese contacto."),
        numero: S.txt("WhatsApp: número al que aplica (phoneNumberId); «» = todos."),
        ...CONFIRMA,
      }),
      rutas: [AUT, WAUT],
      run: async (a, c) => {
        const r = await lee(c, AUT); if (r.res) return r.res;
        const todos = arr(r.json.automations);
        const prev = str(a.id) ? todos.find((x) => str(x.id) === str(a.id)) : undefined;
        if (str(a.id) && !prev) return fallo("No hay ningún disparador con ese id. Para crear uno nuevo no pases id.");
        const red = prev ? redDe(prev) : str(a.red);
        if (!prev && !REDES_DISPARADOR.includes(red)) return fallo("Indica la red: " + REDES_DISPARADOR.join(", ") + ".");
        if (prev && str(a.red) && str(a.red) !== red) return fallo("Un disparador no cambia de red: crea otro para " + str(a.red) + ".");
        if (!prev && !str(a.nombre)) return fallo("Para crear un disparador hace falta nombre.");
        const b: Args = prev ? { ...prev } : {};
        const pon = (campo: string, v: unknown) => { if (dado(v)) b[campo] = str(v); };
        const ponBool = (campo: string, v: unknown, porDefecto: boolean) => { if (typeof v === "boolean") b[campo] = v; else if (!prev) b[campo] = porDefecto; };
        pon("name", a.nombre);
        pon("keyword", a.palabra_clave);
        b.enabled = typeof a.activo === "boolean" ? a.activo : prev ? prev.enabled !== false : true;
        ponBool("oncePerUser", a.una_vez_por_persona, true);
        // Un disparador activo contesta a clientes reales al entrar un comentario o mensaje: activarlo (o dejarlo activo al editarlo) exige aprobación. Guardarlo pausado no.
        if (b.enabled === true && a.confirmado_por_humano !== true) {
          return fallo("Un disparador activo contesta a clientes reales en cuanto entra un comentario o mensaje. Guárdalo con activo: false, o repite con confirmado_por_humano: true solo si lo aprueba.");
        }
        if (red === "whatsapp") {
          b.platform = "whatsapp";
          pon("reply", a.respuesta); pon("link", a.enlace); pon("tag", a.etiqueta); pon("startSequence", a.secuencia); pon("phoneNumberId", a.numero);
          ponBool("escalate", a.pasar_a_persona, false);
          ponBool("stopAi", a.parar_ia, false);
          return llamar(c, "POST", WAUT, b);
        }
        b.platform = red;
        pon("mediaId", a.publicacion); pon("ytAccountId", a.cuenta_youtube); pon("replyComment", a.respuesta_comentario); pon("dmText", a.mensaje_privado);
        pon("dmLink", a.enlace); pon("dmButtonText", a.texto_boton); pon("aiPrompt", a.instrucciones_ia);
        ponBool("aiReply", a.respuesta_ia, false);
        if (!str(b.mediaId)) b.mediaId = "any";
        return llamar(c, "POST", AUT, b);
      },
    },
    {
      name: "borrar_disparador", title: "Borrar un disparador", alcance: "completo", annotations: BORRA,
      description: "Elimina un disparador de cualquier red. No se puede deshacer: pide confirmado_por_humano: true. Para pausarlo sin borrar: guardar_disparador con activo: false.",
      inputSchema: esquema({ id: S.txt("Id del disparador."), ...CONFIRMA }, ["id"]),
      rutas: [AUT],
      run: async (a, c) => {
        const r = await lee(c, AUT); if (r.res) return r.res;
        const d = arr(r.json.automations).find((x) => str(x.id) === str(a.id));
        if (!d) return fallo("No hay ningún disparador con ese id.");
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar el disparador «" + (str(d.name) || str(a.id)) + "» (" + redDe(d) + ") no se puede deshacer.");
        return llamar(c, "DELETE", AUT + "/" + enc(str(a.id)), undefined, true);
      },
    },
    {
      name: "convertir_disparadores_a_flujos", title: "Convertir disparadores en flujos", alcance: "completo", annotations: CAMBIA,
      description: "Pasa los disparadores antiguos al motor de flujos. «simular» (por defecto) enseña qué pasaría sin tocar nada; «convertir» crea un flujo EN PAUSA por cada "
        + "disparador y pausa el original (revísalos y actívalos con activar_flujo); «deshacer» revierte la conversión de uno. Convertir y deshacer piden confirmado_por_humano: true.",
      inputSchema: esquema({ accion: S.en("Qué hacer.", ["simular", "convertir", "deshacer"]), id: S.txt("Para deshacer: id del disparador convertido."), ...CONFIRMA }),
      rutas: ["/admin/api/convertir-disparadores"],
      run: async (a, c) => {
        const accion = str(a.accion) || "simular";
        if (accion === "simular") return llamar(c, "GET", "/admin/api/convertir-disparadores");
        if (accion === "deshacer") {
          if (!str(a.id)) return fallo("Para deshacer indica el id del disparador.");
          if (a.confirmado_por_humano !== true) return noConfirmado("Deshacer revierte la conversión de ese disparador y lo deja como estaba.");
          return llamar(c, "POST", "/admin/api/convertir-disparadores/deshacer/" + enc(str(a.id)), {}, true);
        }
        if (accion !== "convertir") return fallo("accion: simular, convertir o deshacer.");
        if (a.confirmado_por_humano !== true) return noConfirmado("Convertir crea un flujo en pausa por cada disparador y pausa los disparadores originales.");
        return llamar(c, "POST", "/admin/api/convertir-disparadores", { simulacion: false }, true);
      },
    },

    // ── Flujos: extras ──
    {
      name: "borrar_flujo", title: "Borrar un flujo", alcance: "completo", annotations: BORRA,
      description: "Elimina un flujo con todo su recorrido. No se puede deshacer: pide confirmado_por_humano: true. Para pararlo sin borrar: activar_flujo con activo: false.",
      inputSchema: esquema({ id: S.txt("Id del flujo (listar_flujos)."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/flows"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar un flujo no se puede deshacer.");
        return llamar(c, "DELETE", "/admin/api/flows/" + enc(str(a.id)), undefined, true);
      },
    },
    {
      name: "vaciar_datos_flujo", title: "Vaciar el historial de un flujo", alcance: "completo", annotations: BORRA,
      description: "Borra el historial de un flujo (recorridos, eventos, clics y marcas) dejándolo como recién creado: todos los contactos podrán volver a entrar y las métricas "
        + "vuelven a cero. El flujo en sí no cambia. No se puede deshacer: pide confirmado_por_humano: true.",
      inputSchema: esquema({ id: S.txt("Id del flujo."), ...CONFIRMA }, ["id"]),
      rutas: ["/admin/api/flows"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Vaciar el historial de un flujo pone sus métricas a cero y no se puede deshacer.");
        return llamar(c, "POST", "/admin/api/flows/" + enc(str(a.id)) + "/reset", {}, true);
      },
    },
    {
      name: "registro_flujo", title: "Registro de eventos de un flujo", alcance: "lectura", annotations: LEE,
      description: "Qué ha pasado dentro de un flujo, evento a evento (mensajes, respuestas, esperas, saltos, errores) con el contacto y la hora. Útil para ver por qué alguien "
        + "se quedó en un paso. Para el resumen por paso: metricas_flujo; para el embudo: embudo_flujo.",
      inputSchema: esquema({
        id: S.txt("Id del flujo."),
        telefono: S.txt("Solo los eventos de ese contacto."),
        limite: S.int("Cuántos eventos recientes leer del panel antes de paginar (50-5.000; 2.000 por defecto)."),
        ...PAGINA,
      }, ["id"]),
      rutas: ["/admin/api/flows"],
      run: async (a, c) => {
        const lim = entero(a.limite, 50, 5000, 2000);
        const r = await lee(c, "/admin/api/flows/" + enc(str(a.id)) + "/events" + qs({ limit: lim })); if (r.res) return r.res;
        const t = tel(a.telefono);
        const events = arr(r.json.events).filter((e) => !t || tel(e.phone) === t);
        return salida({ flujo: r.json.flowName, pasos: r.json.totalSteps, contactos: arr(r.json.contacts).length, ...paginar(events, a) });
      },
    },
    {
      name: "embudo_flujo", title: "Embudo de un flujo", alcance: "lectura", annotations: LEE,
      description: "Embudo de conversión de un flujo: cuántos entraron, cuántos pulsaron el enlace, cuántos compraron y lo recaudado, con las etiquetas y combinaciones más frecuentes.",
      inputSchema: esquema({ id: S.txt("Id del flujo.") }, ["id"]),
      rutas: ["/admin/api/flows"],
      run: async (a, c) => llamar(c, "GET", "/admin/api/flows/" + enc(str(a.id)) + "/funnel"),
    },

    // ── Difusiones: extras ──
    {
      name: "detalle_difusion", title: "Detalle de entregas de una difusión", alcance: "lectura", annotations: LEE,
      description: "Una difusión con su resultado y la lista de entregas contacto a contacto (enviado, entregado, leído, fallo y motivo). Para la lista de difusiones: listar_difusiones.",
      inputSchema: esquema({ id: S.txt("Id de la difusión."), solo_errores: S.bool("true = solo las entregas que fallaron."), ...PAGINA }, ["id"]),
      rutas: [DIF],
      run: async (a, c) => {
        const r = await lee(c, DIF + "/" + enc(str(a.id)) + "/hits"); if (r.res) return r.res;
        const hits = arr(r.json.hits).filter((h) => a.solo_errores !== true || h.ok === false);
        return salida({ difusion: r.json.broadcast, resultado: r.json.resultado, segundos_limite: r.json.segLimite, ...paginar(hits, a) });
      },
    },
    {
      name: "anular_difusion", title: "Anular una difusión", alcance: "completo", annotations: IDEMP,
      description: "Para una difusión programada o en curso: lo que aún no ha salido no sale. Una ya enviada no se puede anular.",
      inputSchema: esquema({ id: S.txt("Id de la difusión.") }, ["id"]),
      rutas: [DIF],
      run: async (a, c) => llamar(c, "POST", DIF + "/" + enc(str(a.id)) + "/cancel", {}),
    },
    {
      name: "cambiar_emisor_difusion", title: "Cambiar el número que envía una difusión", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Reasigna el número emisor de una difusión programada o bloqueada (por número desconectado). Si estaba bloqueada vuelve a quedar programada y, si su hora ya pasó, "
        + "SALE en el siguiente ciclo: pide confirmado_por_humano: true.",
      inputSchema: esquema({ id: S.txt("Id de la difusión."), numero: S.txt("Número emisor (phoneNumberId de listar_numeros_whatsapp)."), ...CONFIRMA }, ["id", "numero"]),
      rutas: [DIF],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Cambiar el emisor puede hacer que la difusión salga en el siguiente ciclo.");
        return llamar(c, "POST", DIF + "/" + enc(str(a.id)) + "/sender", { senderId: str(a.numero) }, true);
      },
    },
    {
      name: "borrar_difusiones", title: "Borrar difusiones del historial", alcance: "completo", annotations: BORRA,
      description: "Con id borra una difusión terminada y sus entregas del historial (una programada o en curso no se borra: anúlala antes). Con mas_antiguas_que_dias limpia el historial: "
        + "7, 30, 90 o 365 días, o 0 = todo. No se puede deshacer: pide confirmado_por_humano: true.",
      inputSchema: esquema({ id: S.txt("Id de una difusión."), mas_antiguas_que_dias: S.int("Limpieza: 7, 30, 90, 365 o 0 (todo el historial)."), ...CONFIRMA }),
      rutas: [DIF],
      run: async (a, c) => {
        if (str(a.id)) {
          if (a.confirmado_por_humano !== true) return noConfirmado("Borrar una difusión elimina su registro y sus entregas del historial.");
          return llamar(c, "DELETE", DIF + "/" + enc(str(a.id)), undefined, true);
        }
        if (!dado(a.mas_antiguas_que_dias)) return fallo("Indica id (una difusión) o mas_antiguas_que_dias (limpieza: 7, 30, 90, 365 o 0 = todo).");
        const d = Number(a.mas_antiguas_que_dias);
        if (!DIAS_LIMPIEZA.includes(d)) return fallo("mas_antiguas_que_dias solo admite 7, 30, 90, 365 o 0 (todo). Cualquier otro valor lo borraría TODO.");
        if (a.confirmado_por_humano !== true) return noConfirmado(d === 0 ? "Esto borra TODO el historial de difusiones." : "Esto borra el historial de difusiones de hace más de " + d + " días.");
        return llamar(c, "POST", DIF + "/purgar", { olderThanDays: d }, true);
      },
    },

    // ── Difusiones por flujo (solo usuarios administradores) ──
    {
      name: "listar_difusiones_por_flujo", title: "Listar difusiones por flujo", alcance: "lectura", annotations: LEE,
      description: "Difusiones diseñadas como flujo (varios canales, esperas y condiciones) con su estado y el resumen de ejecuciones de cada una. Solo para usuarios administradores del panel.",
      inputSchema: esquema({ activas: S.bool("true = solo activas; false = solo inactivas."), q: S.txt("Filtro por nombre o id."), ...PAGINA }),
      rutas: [DIF + "/flows"],
      run: async (a, c) => {
        const q: Args = { limit: 500 };
        if (typeof a.activas === "boolean") q.enabled = a.activas ? 1 : 0;
        const r = await lee(c, DIF + "/flows" + qs(q)); if (r.res) return r.res;
        const runs = obj(r.json.runsByFlow);
        const flows = arr(r.json.flows).filter((f) => coincide(f, str(a.q), ["name", "id"]))
          .map((f) => ({ ...sin(f, "data"), nodos: arr(obj(f.data).nodes).length, ejecuciones: runs[str(f.id)] ?? null }));
        return salida(paginar(flows, a));
      },
    },
    {
      name: "ver_difusion_por_flujo", title: "Ver una difusión por flujo", alcance: "lectura", annotations: LEE,
      description: "Una difusión por flujo completa, con sus nodos, conexiones y nodo inicial. Solo para usuarios administradores.",
      inputSchema: esquema({ id: S.txt("Id de la difusión por flujo.") }, ["id"]),
      rutas: [DIF + "/flows"],
      run: async (a, c) => llamar(c, "GET", DIF + "/flows/" + enc(str(a.id))),
    },
    {
      name: "guardar_difusion_por_flujo", title: "Crear o editar una difusión por flujo", alcance: "completo", annotations: CAMBIA,
      description: "Crea una difusión por flujo (sin id; hace falta nombre) o edita una (con id) tocando solo lo que pases. Guardar no envía nada: para lanzarla, "
        + "simular_difusion_por_flujo y después lanzar_difusion_por_flujo. Solo para usuarios administradores.",
      inputSchema: esquema({
        id: S.txt("Id a editar; sin id se crea."),
        nombre: S.txt("Nombre."),
        datos: S.obj("Diseño: { nodes, edges, startId } (el mismo formato que devuelve ver_difusion_por_flujo)."),
        activa: S.bool("true = activa (al crear, inactiva por defecto)."),
      }),
      rutas: [DIF + "/flows"],
      run: async (a, c) => {
        const body: Args = {};
        if (str(a.id)) {
          const r = await lee(c, DIF + "/flows/" + enc(str(a.id))); if (r.res) return r.res;
          const f = obj(r.json.flow);
          if (!str(f.id)) return fallo("No hay ninguna difusión por flujo con ese id.");
          body.id = str(a.id);
          body.name = dado(a.nombre) ? str(a.nombre) : f.name;
          body.data = dado(a.datos) ? obj(a.datos) : f.data;
          body.enabled = typeof a.activa === "boolean" ? a.activa : f.enabled === true;
        } else {
          if (!str(a.nombre)) return fallo("Para crear una difusión por flujo hace falta nombre.");
          body.name = str(a.nombre);
          if (dado(a.datos)) body.data = obj(a.datos);
          body.enabled = a.activa === true;
        }
        return llamar(c, "POST", DIF + "/flows", body);
      },
    },
    {
      name: "borrar_difusion_por_flujo", title: "Borrar una difusión por flujo", alcance: "completo", annotations: BORRA,
      description: "Elimina una difusión por flujo con sus ejecuciones y envíos registrados. No se puede deshacer: pide confirmado_por_humano: true. Solo para usuarios administradores.",
      inputSchema: esquema({ id: S.txt("Id de la difusión por flujo."), ...CONFIRMA }, ["id"]),
      rutas: [DIF + "/flows"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("Borrar una difusión por flujo elimina también sus ejecuciones y no se puede deshacer.");
        return llamar(c, "DELETE", DIF + "/flows/" + enc(str(a.id)), undefined, true);
      },
    },
    {
      name: "simular_difusion_por_flujo", title: "Simular una difusión por flujo", alcance: "lectura", annotations: LEE,
      description: "Calcula, sin enviar nada, a quién llegaría una difusión por flujo y por qué canal. Hazlo siempre antes de lanzar_difusion_por_flujo. Solo para usuarios administradores.",
      inputSchema: esquema({ id: S.txt("Id de la difusión por flujo.") }, ["id"]),
      rutas: [DIF + "/flows"],
      run: async (a, c) => llamar(c, "POST", DIF + "/flows/" + enc(str(a.id)) + "/simulate", {}),
    },
    {
      name: "lanzar_difusion_por_flujo", title: "Lanzar una difusión por flujo", alcance: "completo", annotations: SALE,
      description: "Envío MASIVO: arranca una ejecución de la difusión por flujo, ahora o a una hora. Antes: simular_difusion_por_flujo y enseñar al usuario a cuántas personas llega. "
        + "Solo con confirmado_por_humano: true. Solo para usuarios administradores.",
      inputSchema: esquema({ id: S.txt("Id de la difusión por flujo."), cuando: S.fecha("Cuándo arrancar; vacío = ya."), ...CONFIRMA }, ["id"]),
      rutas: [DIF + "/flows", DIF + "/runs"],
      run: async (a, c) => {
        const body: Args = {};
        if (str(a.cuando)) {
          const ms = msEnZona(a.cuando, c.zona);
          if (ms === null) return fallo("No entiendo la fecha de «cuando».");
          body.scheduledFor = ms;
        }
        return llamar(c, "POST", DIF + "/flows/" + enc(str(a.id)) + "/run", body, a.confirmado_por_humano === true);
      },
    },
    {
      name: "cancelar_ejecucion_difusion", title: "Cancelar una ejecución de difusión por flujo", alcance: "completo", annotations: IDEMP,
      description: "Para una ejecución en cola o en curso de una difusión por flujo: los envíos pendientes no salen. Solo para usuarios administradores.",
      inputSchema: esquema({ ejecucion: S.txt("Id de la ejecución (ejecuciones_difusion_por_flujo).") }, ["ejecucion"]),
      rutas: [DIF + "/runs"],
      run: async (a, c) => llamar(c, "POST", DIF + "/runs/" + enc(str(a.ejecucion)) + "/cancel", {}),
    },
    {
      name: "ejecuciones_difusion_por_flujo", title: "Ejecuciones de las difusiones por flujo", alcance: "lectura", annotations: LEE,
      description: "Ejecuciones (lanzamientos) de las difusiones por flujo: estado, cuándo, totales. Las últimas 500 del panel, paginadas. Solo para usuarios administradores.",
      inputSchema: esquema({ flujo: S.txt("Solo las de esa difusión por flujo."), estado: S.en("Solo las de ese estado.", ESTADOS_EJECUCION), ...PAGINA }),
      rutas: [DIF + "/runs"],
      run: async (a, c) => {
        const r = await lee(c, DIF + "/runs" + qs({ flowId: str(a.flujo), status: str(a.estado), limit: 500 })); if (r.res) return r.res;
        return salida(paginar(arr(r.json.runs), a));
      },
    },
    {
      name: "envios_difusion_por_flujo", title: "Envíos de una ejecución de difusión por flujo", alcance: "lectura", annotations: LEE,
      description: "Envíos uno a uno de una ejecución: contacto, canal, estado (en cola, enviado, fallo, cancelado, omitido) y motivo. Los primeros 500, paginados. Solo para usuarios administradores.",
      inputSchema: esquema({
        ejecucion: S.txt("Id de la ejecución."),
        estado: S.en("Solo los de ese estado.", ESTADOS_ENVIO),
        canal: S.en("Solo los de ese canal.", CANALES_ENVIO),
        ...PAGINA,
      }, ["ejecucion"]),
      rutas: [DIF + "/jobs"],
      run: async (a, c) => {
        const r = await lee(c, DIF + "/jobs" + qs({ runId: str(a.ejecucion), status: str(a.estado), channel: str(a.canal), limit: 500 })); if (r.res) return r.res;
        return salida(paginar(arr(r.json.jobs), a));
      },
    },

    // ── LinkedIn: comentarios, autorespuesta y cuentas ──
    {
      name: "comentarios_linkedin", title: "Comentarios de la Página de LinkedIn", alcance: "lectura", annotations: LEE,
      description: "Últimos comentarios recibidos en las publicaciones de la Página de LinkedIn conectada, con el estado de la autorespuesta. Si no hay Página conectada lo dice.",
      inputSchema: esquema({ organizacion: S.txt("Página (organización) concreta si hay varias; vacío = la seleccionada."), ...PAGINA }),
      rutas: ["/admin/api/linkedin-comments"],
      run: async (a, c) => {
        const r = await lee(c, "/admin/api/linkedin-comments" + qs({ li_org: str(a.organizacion) })); if (r.res) return r.res;
        return salida({ ...sin(r.json, "comments"), ...paginar(arr(r.json.comments), a) });
      },
    },
    {
      name: "responder_comentario_linkedin", title: "Responder a un comentario de LinkedIn", alcance: "completo", annotations: SALE,
      description: "Publica una respuesta, en nombre de la Página, a un comentario de LinkedIn. Es público y no se puede retirar desde aquí: pide confirmado_por_humano: true.",
      inputSchema: esquema({
        publicacion: S.txt("Referencia de la publicación (objectUrn, tal como la da comentarios_linkedin)."),
        comentario: S.txt("Referencia del comentario (commentUrn)."),
        texto: S.txt("Respuesta."),
        organizacion: S.txt("Página (organización) si hay varias; vacío = la seleccionada."),
        ...CONFIRMA,
      }, ["publicacion", "comentario", "texto"]),
      rutas: ["/admin/api/linkedin-comments"],
      run: async (a, c) => {
        if (!str(a.texto)) return fallo("Pasa el texto de la respuesta.");
        if (a.confirmado_por_humano !== true) return noConfirmado("La respuesta se publica en LinkedIn en nombre de la Página.");
        return llamar(c, "POST", "/admin/api/linkedin-comments/reply", { objectUrn: str(a.publicacion), commentUrn: str(a.comentario), text: str(a.texto), ...(str(a.organizacion) ? { orgId: str(a.organizacion) } : {}) }, true);
      },
    },
    {
      name: "autorespuesta_linkedin", title: "Autorespuesta a comentarios de LinkedIn", alcance: "completo", annotations: IDEMP,
      description: "Sin argumentos muestra cómo está la autorespuesta de la Página de LinkedIn (encendida, tope diario, cada cuánto mira). Con argumentos la cambia. "
        + "Encenderla hace que la IA conteste en público a los comentarios: pide confirmado_por_humano: true.",
      inputSchema: esquema({
        activa: S.bool("true = encendida."),
        tope_diario: S.int("Máximo de respuestas al día (0-200)."),
        cada_segundos: S.int("Cada cuántos segundos revisa comentarios nuevos (300-86.400)."),
        ...CONFIRMA,
      }),
      rutas: ["/admin/api/li-autoreply", "/admin/api/linkedin-community-accounts"],
      run: async (a, c) => {
        const body: Args = {};
        if (typeof a.activa === "boolean") body.enabled = a.activa;
        if (dado(a.tope_diario)) body.dailyCap = entero(a.tope_diario, 0, 200, 0);
        if (dado(a.cada_segundos)) body.pollSec = entero(a.cada_segundos, 300, 86400, 300);
        if (!Object.keys(body).length) {
          const r = await lee(c, "/admin/api/linkedin-community-accounts"); if (r.res) return r.res;
          return salida({ autorespuesta: r.json.autoreply, conectado: r.json.connected, pagina_seleccionada: r.json.selectedId });
        }
        if (body.enabled === true && a.confirmado_por_humano !== true) return noConfirmado("Encender la autorespuesta hace que la IA conteste en público en LinkedIn.");
        return llamar(c, "POST", "/admin/api/li-autoreply", body, a.confirmado_por_humano === true);
      },
    },
    {
      name: "cuentas_linkedin", title: "Cuentas de LinkedIn conectadas", alcance: "completo", annotations: IDEMP,
      description: "Sin argumentos lista las Páginas (organizaciones) y las cuentas publicitarias de LinkedIn disponibles y cuál está seleccionada en cada caso. "
        + "Con elegir_organizacion o elegir_cuenta_anuncios cambia la selección. Conectar o desconectar LinkedIn se hace en Conexiones.",
      inputSchema: esquema({ elegir_organizacion: S.txt("Id de la Página (organización) a usar."), elegir_cuenta_anuncios: S.txt("Id de la cuenta publicitaria a usar.") }),
      rutas: ["/admin/api/linkedin-community-accounts", "/admin/api/linkedin-accounts"],
      run: async (a, c) => {
        if (str(a.elegir_organizacion)) return llamar(c, "POST", "/admin/api/linkedin-community-accounts/select", { orgId: str(a.elegir_organizacion) });
        if (str(a.elegir_cuenta_anuncios)) return llamar(c, "POST", "/admin/api/linkedin-accounts/select", { adAccountId: str(a.elegir_cuenta_anuncios) });
        const p = await lee(c, "/admin/api/linkedin-community-accounts");
        const ad = await lee(c, "/admin/api/linkedin-accounts");
        return salida({ paginas: p.res ? { error: p.res.texto } : p.json, anuncios: ad.res ? { error: ad.res.texto } : ad.json });
      },
    },

    // ── Instagram y Facebook: cuentas y diagnóstico ──
    {
      name: "listar_cuentas_redes", title: "Cuentas de Instagram y Facebook conectadas", alcance: "lectura", annotations: LEE,
      description: "Cuentas de Instagram (usuario, nombre, si hay que reconectarla) y Páginas de Facebook (nombre, desde cuándo, cuenta de Instagram ligada) conectadas al panel, "
        + "con los identificadores que piden otras herramientas. Conectar o quitar cuentas se hace en Conexiones.",
      inputSchema: esquema({}),
      rutas: ["/admin/api/ig-accounts", "/admin/api/fb-accounts"],
      run: async (_a, c) => {
        const ig = await lee(c, "/admin/api/ig-accounts");
        const fb = await lee(c, "/admin/api/fb-accounts");
        return salida({
          instagram: ig.res ? { error: ig.res.texto } : arr(ig.json.accounts).map((x) => sin(x, "avatar")),
          facebook: fb.res ? { error: fb.res.texto } : arr(fb.json.accounts).map((x) => sin(x, "pictureUrl")),
        });
      },
    },
    {
      name: "diagnosticar_cuenta_red", title: "Diagnosticar una cuenta de Instagram o Facebook", alcance: "lectura", annotations: LEE,
      description: "Instagram: si cada cuenta tiene los avisos de Meta suscritos (por eso dejan de llegar comentarios y mensajes) y con qué Página. "
        + "Facebook: estado del acceso de una Página (válido, caducidad, permisos concedidos y que faltan). Si algo falla: reparar_recepcion_mensajes o reconectar en Conexiones.",
      inputSchema: esquema({
        red: S.en("Qué red.", ["instagram", "facebook"]),
        cuenta: S.txt("Instagram: solo esa cuenta (igId); vacío = todas."),
        pagina: S.txt("Facebook: la Página (pageId de listar_cuentas_redes)."),
      }, ["red"]),
      rutas: ["/admin/api/ig-accounts", "/admin/api/fb-debug"],
      run: async (a, c) => {
        if (str(a.red) === "facebook") {
          if (!str(a.pagina)) return fallo("Para Facebook indica la Página (pageId de listar_cuentas_redes).");
          return llamar(c, "GET", "/admin/api/fb-debug/" + enc(str(a.pagina)));
        }
        const r = await lee(c, "/admin/api/ig-accounts/webhook-diag"); if (r.res) return r.res;
        return salida({ cuentas: arr(r.json.accounts).filter((x) => !str(a.cuenta) || str(x.igId) === str(a.cuenta)) });
      },
    },

    // ── Goteo de Instagram (respuestas escalonadas a los comentarios de una publicación) ──
    {
      name: "goteo_instagram_estado", title: "Estado y lectura del goteo de Instagram", alcance: "lectura", annotations: LEE,
      description: "El goteo responde poco a poco a los comentarios de una publicación de Instagram. «estado» (por defecto): si está encendido, pendientes, ritmo, errores y horas que quedan. "
        + "«escanear»: lee los comentarios de una publicación (o de las últimas) y quién los firma. «verificar»: si ya se respondió a un usuario en esa publicación. Nada de esto envía.",
      inputSchema: esquema({
        accion: S.en("Qué consultar.", ["estado", "escanear", "verificar"]),
        cuenta: S.txt("Cuenta de Instagram (igId de listar_cuentas_redes)."),
        publicacion: S.txt("Id de la publicación."),
        usuario: S.txt("Verificar: usuario de Instagram (con o sin @)."),
        profundo: S.bool("Escanear: true = incluye las respuestas anidadas."),
        max_publicaciones: S.int("Escanear sin publicación: cuántas recientes mirar (60 por defecto)."),
      }),
      rutas: ["/admin/api/ig-drip/status"],
      run: async (a, c) => {
        const accion = str(a.accion) || "estado";
        if (accion === "estado") return llamar(c, "GET", "/admin/api/ig-drip/status");
        if (accion === "verificar") {
          if (!str(a.cuenta) || !str(a.publicacion) || !str(a.usuario)) return fallo("Para verificar hacen falta cuenta, publicacion y usuario.");
          return llamar(c, "GET", "/admin/api/ig-drip/verify" + qs({ ig_id: str(a.cuenta), mediaId: str(a.publicacion), username: str(a.usuario).replace(/^@/, "") }));
        }
        if (accion !== "escanear") return fallo("accion: estado, escanear o verificar.");
        return llamar(c, "GET", "/admin/api/ig-drip/scan" + qs({ ig_id: str(a.cuenta), mediaId: str(a.publicacion), deep: a.profundo === true ? "1" : "", maxMedia: dado(a.max_publicaciones) ? entero(a.max_publicaciones, 1, 200, 60) : "" }));
      },
    },
    {
      name: "goteo_instagram_preparar", title: "Preparar la cola del goteo de Instagram", alcance: "completo", annotations: CAMBIA,
      description: "Lee los comentarios de la publicación y encola a cada persona (una vez) para responderle por goteo. No envía nada. Con reiniciar: true vacía la cola anterior "
        + "(pide confirmado_por_humano: true). Después: goteo_instagram_controlar con accion arrancar.",
      inputSchema: esquema({
        cuenta: S.txt("Cuenta de Instagram (igId)."),
        publicacion: S.txt("Id de la publicación."),
        excluir: S.lista("Usuarios a los que no responder (con o sin @)."),
        reiniciar: S.bool("true = vacía la cola antes de encolar."),
        ...CONFIRMA,
      }, ["cuenta", "publicacion"]),
      rutas: ["/admin/api/ig-drip/prepare"],
      run: async (a, c) => {
        if (a.reiniciar === true && a.confirmado_por_humano !== true) return noConfirmado("Reiniciar vacía la cola pendiente del goteo (se pierde lo que quedaba por responder).");
        const body: Args = { ig_id: str(a.cuenta), mediaId: str(a.publicacion) };
        const ex = (lista(a.excluir) || []).map((u) => "@" + u.replace(/^@/, ""));
        if (ex.length) body.exclude = ex.join(",");
        if (a.reiniciar === true) body.reset = true;
        return llamar(c, "POST", "/admin/api/ig-drip/prepare", body, a.confirmado_por_humano === true);
      },
    },
    {
      name: "goteo_instagram_controlar", title: "Arrancar, parar o reanudar el goteo de Instagram", alcance: "completo", annotations: SALE,
      description: "«arrancar» configura y enciende el goteo: responde en público, uno a uno y cada cierto tiempo, a los comentarios pendientes de una publicación con los textos que pases "
        + "(rotan; sin enlaces). «parar» lo detiene; «reanudar» lo retoma con la configuración guardada. Arrancar y reanudar publican de verdad: solo con confirmado_por_humano: true. "
        + "Hay un solo goteo a la vez en la instalación.",
      inputSchema: esquema({
        accion: S.en("Qué hacer.", ["arrancar", "parar", "reanudar"]),
        textos: S.lista("Arrancar: respuestas que rotan (sin enlaces)."),
        cuenta: S.txt("Arrancar: cuenta de Instagram (igId)."),
        publicacion: S.txt("Arrancar: id de la publicación."),
        cada_segundos: S.int("Arrancar: segundos entre respuestas (mínimo 60; 600 por defecto)."),
        recarga_min: S.int("Arrancar: cada cuántos minutos vuelve a buscar comentarios nuevos (mínimo 2; 10 por defecto)."),
        excluir: S.lista("Arrancar: usuarios a los que no responder."),
        ...CONFIRMA,
      }, ["accion"]),
      rutas: ["/admin/api/ig-drip/start", "/admin/api/ig-drip/stop", "/admin/api/ig-drip/resume"],
      run: async (a, c) => {
        const accion = str(a.accion);
        const ok = a.confirmado_por_humano === true;
        if (accion === "parar") return llamar(c, "POST", "/admin/api/ig-drip/stop", {});
        if (accion === "reanudar") return llamar(c, "POST", "/admin/api/ig-drip/resume", {}, ok);
        if (accion !== "arrancar") return fallo("accion: arrancar, parar o reanudar.");
        const textos = (lista(a.textos) || []).filter(Boolean);
        if (!textos.length) return fallo("Pasa al menos un texto en textos (sin enlaces).");
        if (!str(a.cuenta) || !str(a.publicacion)) return fallo("Para arrancar hacen falta cuenta y publicacion.");
        const body: Args = { variants: textos, ig_id: str(a.cuenta), mediaId: str(a.publicacion) };
        if (dado(a.cada_segundos)) body.intervalSec = Math.max(60, Math.round(Number(a.cada_segundos) || 600));
        if (dado(a.recarga_min)) body.refillMin = Math.max(2, Math.round(Number(a.recarga_min) || 10));
        const ex = (lista(a.excluir) || []).map((u) => "@" + u.replace(/^@/, ""));
        if (ex.length) body.exclude = ex.join(",");
        return llamar(c, "POST", "/admin/api/ig-drip/start", body, ok);
      },
    },
    {
      name: "responder_comentario_instagram_prueba", title: "Responder a un comentario de Instagram (prueba del goteo)", alcance: "completo", annotations: SALE,
      description: "Responde en público, una sola vez, al comentario de un usuario concreto en una publicación: sirve para probar el goteo antes de arrancarlo. "
        + "Es una respuesta real en Instagram: pide confirmado_por_humano: true.",
      inputSchema: esquema({
        cuenta: S.txt("Cuenta de Instagram (igId)."),
        publicacion: S.txt("Id de la publicación."),
        usuario: S.txt("Usuario que comentó (con o sin @)."),
        texto: S.txt("Respuesta."),
        ...CONFIRMA,
      }, ["cuenta", "publicacion", "usuario", "texto"]),
      rutas: ["/admin/api/ig-drip/test-reply"],
      run: async (a, c) => {
        if (a.confirmado_por_humano !== true) return noConfirmado("La respuesta se publica de verdad en Instagram.");
        return llamar(c, "POST", "/admin/api/ig-drip/test-reply", { ig_id: str(a.cuenta), mediaId: str(a.publicacion), username: str(a.usuario).replace(/^@/, ""), text: str(a.texto) }, true);
      },
    },

    // ── Rescate de comentarios que se quedaron sin atender ──
    {
      name: "rescatar_comentarios_perdidos", title: "Rescatar comentarios sin atender", alcance: "completo", annotations: { ...CAMBIA, openWorldHint: true },
      description: "Busca comentarios recientes de Instagram o Facebook que debieron disparar un flujo y no lo hicieron (avisos de Meta perdidos) y los atiende. "
        + "Por defecto simula y solo cuenta; con simular: false contesta y manda mensajes de verdad: pide confirmado_por_humano: true.",
      inputSchema: esquema({
        red: S.en("Qué red.", ["instagram", "facebook"]),
        horas: S.int("Cuántas horas hacia atrás (1-720; 24 por defecto)."),
        simular: S.bool("false = actuar de verdad (por defecto true: solo informa)."),
        flujo: S.txt("Instagram: limitar a los comentarios de ese flujo."),
        incluir_reclamados: S.bool("Instagram: true = también los que ya se marcaron como atendidos."),
        comentarios: S.lista("Instagram: solo esos comentarios (ids)."),
        ...CONFIRMA,
      }, ["red"]),
      rutas: ["/admin/api/ig/backfill-comments", "/admin/api/fb/backfill-comments"],
      run: async (a, c) => {
        const red = str(a.red);
        if (red !== "instagram" && red !== "facebook") return fallo("red: instagram o facebook.");
        const simular = a.simular !== false;
        const body: Args = { dryRun: simular ? "1" : "0" };
        if (dado(a.horas)) body.sinceHours = entero(a.horas, 1, 720, 24);
        if (red === "instagram") {
          if (str(a.flujo)) body.flowId = str(a.flujo);
          if (a.incluir_reclamados === true) body.incluirReclamados = "1";
          const ids = lista(a.comentarios) || [];
          if (ids.length) body.commentIds = ids;
        }
        if (!simular && a.confirmado_por_humano !== true) return noConfirmado("Sin simular, el rescate contesta y manda mensajes de verdad a quienes comentaron.");
        return llamar(c, "POST", "/admin/api/" + (red === "instagram" ? "ig" : "fb") + "/backfill-comments", body, !simular);
      },
    },
  ];
}
