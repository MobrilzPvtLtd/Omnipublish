# Alta de cliente — de cero a operativo

Lista de comprobación para poner en marcha una instancia nueva del panel para un
cliente. Se sigue de arriba abajo, con el cliente al teléfono. No hace falta abrir el
código.

**Tiempo estimado:** 45–60 minutos de trabajo tuyo, más lo que tarde el cliente en
tener a mano sus cuentas de Meta.

**Antes de empezar, dos cosas que ya tienen que estar hechas** (no son parte de este
documento):

- El **repositorio de cliente** existe en GitHub, es privado y está limpio (sin la
  historia del repositorio interno). Si aún no está, párate aquí: no hay nada que
  desplegar.
- Tu **instancia central** —la que figura como URL de callback en el App Dashboard de
  la Meta App compartida— está viva y tiene `ROUTING_STRICT=1` en sus variables.

---

## Ficha del cliente (rellénala a la vez que avanzas)

```
Cliente ............................
Fecha de alta ......................
Panel (URL) ........................
Proyecto Railway ...................
Dominio propio (si lo hay) .........
ADMIN_USER .........................
ADMIN_PASSWORD .....................  -> gestor de contraseñas
APP_ENC_KEY ........................  -> gestor de contraseñas
STATE_SECRET .......................  -> gestor de contraseñas
WHATSAPP_VERIFY_TOKEN ..............  -> gestor de contraseñas
PIN de credenciales ................  -> gestor de contraseñas
phoneNumberId (WhatsApp) ...........
wabaId .............................
igBusinessId .......................
pageId (Facebook) ..................
adAccountId (Meta Ads) .............
Entrada en relay.routes de la central: [ ] hecha
Usuario del cliente en Equipo ......
```

---

# Fase 1 · Antes de empezar: qué le pides al cliente

Esta llamada decide si el alta se hace en una tarde o en dos semanas. Todo lo que
falte aquí se convierte en un paso bloqueado más adelante.

## 1.1 · Cuentas y pagos

- [ ] **Cuenta de Railway propia**, con tarjeta ya validada. El cliente paga su
      infraestructura: es su proyecto, su base de datos y sus costes.
- [ ] **Cuenta de GitHub** del cliente (o de quien administre el despliegue), para
      darle acceso de lectura al repositorio. Railway necesita que la cuenta que
      conecta el repositorio pueda leerlo.
- [ ] **Clave de API de DeepInfra** (deepinfra.com). Es la IA del bot y del Asistente,
      y se paga por uso: la pone el cliente y la paga el cliente. Es el único
      proveedor de IA que el panel usa hoy.

## 1.2 · Meta (lo que más tarda)

- [ ] **Meta Business** (Business Manager) del cliente, con él como administrador.
- [ ] **Número de WhatsApp** que se va a usar. Confírmalo por teléfono, porque es la
      causa habitual de que el alta se atasque:
      - No puede estar dado de alta en otra plataforma de WhatsApp Business API.
      - Si hoy tiene la app verde de WhatsApp Business instalada, hay que decidir si
        se migra o se usa el modo de coexistencia (son dos flujos distintos, ver 5.1).
      - Tiene que poder recibir un SMS o una llamada para verificarlo.
- [ ] **Cuenta de Instagram** profesional (empresa o creador) **vinculada a una Página
      de Facebook**. Instagram sin Página vinculada no se puede conectar.
- [ ] **Página de Facebook**, si quiere que los mensajes de la Página lleguen al panel.
- [ ] **Cuenta publicitaria de Meta** (opcional, sólo si quiere métricas de Ads).

## 1.3 · Identidad legal (obligatoria: se publica)

Estos datos se publican en `/privacidad`, `/terminos` y `/eliminar-datos` del panel del
cliente. Sin ellos esas páginas salen con marcadores del tipo «[Tu empresa]».

Pídelos todos de una vez, por escrito:

- [ ] Nombre o razón social — **obligatorio**
- [ ] Email de contacto legal — **obligatorio**
- [ ] Sitio web
- [ ] Forma jurídica (p. ej. Sociedad de Responsabilidad Limitada)
- [ ] Lugar de constitución
- [ ] Domicilio social
- [ ] NIF / CIF / EIN
- [ ] Representante legal (nombre y apellidos)
- [ ] Contacto de Protección de Datos (email o URL)
- [ ] Legislación aplicable
- [ ] Nº de registro, fecha de constitución, agente registrado y dirección del agente
      registrado — sólo si su forma jurídica los tiene

## 1.4 · Marca y opcionales

- [ ] **Nombre comercial** tal cual quiere verlo en la pantalla de acceso y el menú.
- [ ] **Dominio propio**, si lo quiere (p. ej. `panel.sunegocio.com`). Si no, se usa el
      dominio que genera Railway.
- [ ] **Logo** en PNG cuadrado, 512×512 mínimo. Lee el aviso de marca del paso 6.5.
- [ ] Canal de **YouTube**, si quiere métricas y comentarios.
- [ ] Cuenta de **systeme.io**, si tiene webs y formularios ahí.
- [ ] Cuenta de **Zernio**, si quiere publicar en redes desde el Programador.

---

# Fase 2 · Railway: proyecto, base de datos, repositorio y variables

## 2.1 · Crear el proyecto y la base de datos

- [ ] El cliente crea un **proyecto nuevo** en su cuenta de Railway y te invita como
      colaborador (o comparte pantalla).
- [ ] Añade el complemento **PostgreSQL al proyecto, ANTES del primer despliegue.**
      Este orden importa: si la aplicación arranca sin base de datos, arranca igual,
      responde bien, Railway da el despliegue por bueno y **no persiste nada** — cada
      reinicio borra tokens, contactos y conversaciones sin un solo error.

## 2.2 · Conectar el repositorio

- [ ] Pide al cliente que te **invite a su proyecto de Railway**. El proyecto y la
      factura son suyos; el repositorio es tuyo y privado, y él no lo ve.
- [ ] Con TU cuenta de GitHub, crea el **servicio de aplicación** apuntando a
      `ingenierobinario/business-stack-customers`, rama `main`.
- [ ] No des acceso de lectura al repositorio a la cuenta de GitHub del cliente: es el
      código fuente del producto que le vendes.
- [ ] Comprueba que el servicio usa el **Dockerfile** del repositorio (no Nixpacks). El
      repositorio ya lo declara en `railway.json`, junto con el comando de arranque y
      el healthcheck en `/health`.

## 2.2 bis · El segundo servicio: el puente con systeme.io

Publicar páginas en systeme.io y leer sus embudos los hace **`systemeio-mcp`**, un
servicio aparte. Cada cliente tiene **el suyo**, en su mismo proyecto de Railway: el
puente le manda el correo y la contraseña de systeme.io del cliente para abrir sesión,
así que apuntar a un MCP ajeno sacaría esas credenciales de su casa.

**Móntalo salvo que sepas que ese cliente no va a usar systeme.io.** El panel lee sus
datos por tres vías en paralelo (cookie de sesión, clave de API y MCP), así que sin el
MCP los datos siguen llegando mientras la cookie viva — pero el MCP es lo único que sabe
**abrir sesión solo** y renovarla. Sin él, cuando caduque, el cliente tendría que pegar
la cookie a mano. Y publicar páginas no funciona en absoluto.

Sincronizar contactos y etiquetas sí va por la API pública y no lo necesita.

- [ ] ¿El cliente va a usar systeme.io, aunque sea solo para ver sus estadísticas? Si
      no lo va a usar **nunca**, salta este apartado entero y anótalo en su ficha. Si
      lo va a usar, móntalo: es lo único que renueva la sesión sola cuando caduque.
- [ ] En el mismo proyecto de Railway, crea un segundo servicio desde
      `ingenierobinario/systemeio-mcp-customers` (rama `main`), también con tu cuenta de GitHub.
- [ ] Genérale dominio público.
- [ ] Variables del servicio `systemeio-mcp`:
      `INTERNAL_API_SECRET` (cadena aleatoria, propia de este cliente) ·
      `MASTER_KEY` (32 bytes en hexadecimal, 64 caracteres) ·
      `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.
- [ ] **No te saltes las dos de Supabase.** El MCP guarda la sesión de systeme.io que
      abre con un navegador, y el disco de Railway es efímero: sin ellas, cada
      redespliegue borra la sesión y el siguiente acceso pide verificación en dos pasos
      a mano. Deja de ser autónomo.
- [ ] En el servicio de **Business Stack**, añade con **referencias entre servicios**,
      no pegando la URL a mano:
      `MCP_URL` = `https://${{systemeio-mcp.RAILWAY_PUBLIC_DOMAIN}}/mcp` ·
      `MCP_TOKEN` = `${{systemeio-mcp.INTERNAL_API_SECRET}}`
- [ ] Comprueba en el panel: **Conexiones** no debe decir que falta la dirección del
      puente.

## 2.3 · Variables del servicio de aplicación

> Aquí van las imprescindibles para arrancar. La referencia completa de los **dos**
> servicios, con qué pasa si falta cada una y la lista de las que rompen en silencio,
> está en [VARIABLES.md](VARIABLES.md).

Ponlas **todas de una vez, antes del primer despliegue**. Nombre exacto y por qué:

| Variable | Valor | Por qué |
|---|---|---|
| `DATABASE_URL` | referencia al Postgres del proyecto (`${{Postgres.DATABASE_URL}}`) | El complemento de Postgres **no** inyecta esta variable en el servicio de la aplicación por sí solo: hay que crear la referencia a mano en el servicio |
| `APP_ENC_KEY` | cadena aleatoria de 32+ caracteres, **distinta por cliente** | Cifra en la base de datos todos los tokens y claves de ese cliente. Es lo único que impide el arranque si falta |
| `ADMIN_PASSWORD` | contraseña fuerte, distinta por cliente | Acceso de administrador del stack. Sin ella el panel arranca pero enseña «Panel desactivado» a todo el mundo |
| `ADMIN_USER` | el correo con el que vas a entrar tú | Si no la pones, el usuario es `admin` |
| `STATE_SECRET` | cadena aleatoria de 32+ caracteres, **distinta por cliente** | Firma el paso de vuelta de los permisos de Meta. Si no la pones, se usa un texto fijo idéntico en todos los despliegues, y el arranque lo avisa por consola |
| `WHATSAPP_VERIFY_TOKEN` | cadena aleatoria, distinta por cliente | Token de verificación de los webhooks. **Si se queda vacío, cualquiera puede dar de alta sus propios webhooks contra el servidor del cliente**, porque un token vacío también encaja. Además, sin él no se puede redirigir la entrega del número de WhatsApp a esta instancia |
| `META_APP_ID` | App ID de la Meta App compartida | La app de Meta es tuya y se comparte entre clientes |
| `IG_APP_SECRET` | App Secret de esa misma app | **Este es el nombre canónico.** Es el que leen todos los sitios del código sin excepción |
| `META_APP_SECRET` | el mismo valor | Opcional, no estorba, y cubre las rutas que lo miran primero |
| `FB_APP_SECRET` | el mismo valor | Igual |
| `META_WA_EMBEDDED_CONFIG_ID` | Configuration ID del alta incrustada de WhatsApp | Sin él, el botón de conectar WhatsApp no puede abrir el alta de Meta |
| `META_WA_COEXISTENCE_CONFIG_ID` | Configuration ID de coexistencia | Sólo si el cliente va a seguir usando la app verde de WhatsApp en el móvil |
| `PUBLIC_BASE_URL` | `https://panel.sunegocio.com` | **Sólo si hay dominio propio.** Sin barra final y con https. Si no hay dominio propio, no la pongas: Railway ya inyecta `RAILWAY_PUBLIC_DOMAIN` sola |

Poner `META_APP_ID` y el secreto por variables de entorno tiene un efecto deseado: el
panel deja de enseñar la guía técnica de configuración de la Meta App. El cliente sólo
ve los botones de «Conectar», que es exactamente lo que queremos.

## 2.4 · LISTA NEGRA — variables que NO se ponen nunca en el Railway de un cliente

- [ ] Confirmado que **ninguna** de estas existe en el servicio:

| Variable | Qué rompe |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Identifica un canal. Todos los negocios de la instancia reclamarían ese número; el reparto lo declara en conflicto, Meta recibe 200 y **ni un mensaje entra al panel**. Y si uno de los negocios está archivado es peor: las conversaciones se entregan al negocio equivocado |
| `IG_BUSINESS_ACCOUNT_ID` | Lo mismo con Instagram |
| `WHATSAPP_ACCESS_TOKEN` | Cualquier negocio nuevo hereda ese acceso |
| `IG_ACCESS_TOKEN` | Igual |
| `META_ADS_TOKEN` | Igual |
| `META_AD_ACCOUNT_ID` | Igual |
| `ROUTING_STRICT` | Sólo la lleva tu instancia central. Aquí, con valor `1`, todo lo que llegue antes de que el canal esté guardado en Conexiones se descarta silenciosamente con un 200 |
| `ALLOW_INSECURE_ENC_KEY` | Anula la protección de `APP_ENC_KEY` y cifra los secretos del cliente con una clave pública que está en el repositorio |
| `DEEPINFRA_API_KEY` | No sirve para nada: no activa la IA (ver 4.4). Da falsa sensación de estar configurado |

Estas cuentas se conectan **siempre desde la vista Conexiones**, nunca por variables.

---

# Fase 3 · Primer arranque y comprobaciones

## 3.1 · Desplegar

- [ ] Lanza el despliegue y espera a que termine la construcción.
- [ ] Genera el **dominio público** del servicio en Railway (o apunta el dominio propio
      del cliente, y entonces vuelve a 2.3 y añade `PUBLIC_BASE_URL`).

## 3.2 · Leer el log de arranque (no te saltes esto)

Abre los registros del despliegue y busca, literalmente:

- [ ] **Tiene que aparecer:** `[crypto] APP_ENC_KEY OK`
- [ ] **NO puede aparecer:** `[db] DATABASE_URL no definida — almacén en memoria (no persiste).`
      Si aparece, la referencia al Postgres de 2.3 no está bien puesta. Párate y
      arréglalo: todo lo que configures a partir de aquí se perderá.
- [ ] **NO puede aparecer:** `[seguridad] STATE_SECRET sin definir y admin.pass vacio — usando fallback hardcoded.`
      Si aparece, falta `STATE_SECRET`.
- [ ] **Tienen que aparecer** los trabajadores en marcha: `[scheduler] programador de
      publicaciones activo`, `[autopost]`, `[snapshots]`, `[broadcast-flows]`, y al
      final `stack app escuchando en :<puerto> — panel en /admin`.

**Aviso importante:** `/health` devuelve `{"ok":true}` aunque falte la base de datos. El
healthcheck verde de Railway **no** es prueba de que la instancia esté bien. La prueba
es el log.

## 3.3 · Entrar al panel

- [ ] Abre `https://<dominio>/admin`.
- [ ] Si sale la página **«Panel desactivado — el administrador del stack todavía no ha
      establecido la contraseña de acceso»**: falta `ADMIN_PASSWORD`. Añádela, espera
      al redespliegue y vuelve.
- [ ] Entra con `ADMIN_USER` + `ADMIN_PASSWORD`. Debes ver el Dashboard con el menú
      completo, incluida la sección CONFIGURACIÓN con **Grupos de negocio**,
      **Equipo**, **Workspaces**, **Ajustes** y **Actividad**. Si no ves esas cinco, no
      has entrado como administrador del stack.
- [ ] Abre `https://<dominio>/privacidad`. Debe responder. De momento saldrá con
      marcadores: se rellena en 4.2.

---

# Fase 4 · Lo que configuras TÚ, el operador, en ese panel

Todo lo de esta fase son **claves globales del stack**: sólo las puede guardar quien
entra con `ADMIN_USER` + `ADMIN_PASSWORD`. Un usuario normal del cliente recibe un
error al intentarlo y, en varios casos, ni siquiera ve la pantalla.

**Decisión de reparto que conviene dejar clara desde el principio:** las credenciales de
administrador del stack (`ADMIN_USER` / `ADMIN_PASSWORD`) **se quedan contigo**. Al
cliente se le crea un usuario en la vista **Equipo** (paso 4.7). El motivo no es
desconfianza: quien entra como administrador del stack puede desenmascarar, con el PIN
de credenciales, el App Secret de la Meta App **compartida por todos tus clientes**.

## 4.1 · Crear el PIN de credenciales

El PIN protege la lectura y la escritura de cualquier clave secreta del panel.

- [ ] Ve a **Conexiones** → tarjeta **Inteligencia Artificial**, pega la clave de
      DeepInfra del cliente y pulsa **Guardar IA**. La primera vez, el panel te pedirá
      **crear un PIN de 4 a 8 dígitos** en una ventana. Créalo ahí mismo.
- [ ] Apunta el PIN en tu ficha. No se puede recuperar leyéndolo: se guarda cifrado.

## 4.2 · Identidad legal

- [ ] **Ajustes → Identidad legal.** Rellena los 14 campos de 1.3.
      - *Nombre o razón social* (`legal.business`) y *Email de contacto legal*
        (`legal.email`) son **obligatorios**: sin ellos las páginas legales no
        identifican al responsable del tratamiento.
- [ ] Comprueba en `https://<dominio>/privacidad`, `/terminos` y `/eliminar-datos` que
      ya sale el nombre del cliente y no «[Tu empresa]».

**Por qué lo haces tú y no el cliente:** la vista **Ajustes** está reservada al
administrador del stack; un usuario del cliente no la ve en el menú. Y estas páginas son
únicas por dominio, así que no pueden depender de un negocio concreto.

## 4.3 · Marca del panel

- [ ] **Ajustes → Marca.**
      - *Nombre de tu empresa (pantalla de acceso y menú)* → el nombre comercial del
        cliente (`brand.operator`).
      - *Distintivo junto al nombre* → `Producción` (`brand.env`).

Lee el aviso de marca del paso 6.5 antes de enseñarle el panel al cliente.

## 4.4 · Inteligencia Artificial (ya hecha en 4.1, verifícala)

- [ ] **Conexiones → Inteligencia Artificial** debe decir **«Activo · DeepInfra»** y
      listar los tres modelos: *Contesta a tus clientes*, *Si ese falla* y *Asistente
      del panel*.
- [ ] Pulsa **Probar** y confirma que responde.

**Por qué la pones tú aunque la clave la pague el cliente:** `key.deepinfra` es una
clave global del stack. El propio panel se lo dice al cliente si lo intenta: «La IA la
activa el administrador del stack». Es una fricción conocida del modelo de reventa; de
momento se resuelve así, con el cliente dictándote la clave por teléfono.

**No pongas `DEEPINFRA_API_KEY` como variable de entorno.** No funciona: el desplegable
de modelos la lee, pero el bot no. El síntoma es traicionero — el panel parece
configurado y el bot no contesta.

## 4.5 · Registrar el dominio del cliente en la Meta App compartida

En el App Dashboard de la Meta App:

- [ ] Añade a **Valid OAuth Redirect URIs** exactamente:
      `https://<dominio-del-cliente>/admin/auth/meta/callback`

Sin esto, todos los botones «Conectar» de Instagram, Facebook y Meta Ads fallan al
volver del permiso. Cada instancia de cliente tiene su propio dominio, así que hay que
añadir uno por alta.

## 4.6 · YouTube y otras integraciones que dependen de una app tuya (opcional)

Estas conexiones usan proyectos de Google o de LinkedIn que son **tuyos**, no del
cliente. Mientras no pongas sus credenciales, el botón sale deshabilitado con la
etiqueta «Pendiente de activar por el administrador».

Estas claves **no tienen campo en el panel**: se ponen con una llamada a la API, con tu
sesión de administrador del stack abierta.

- [ ] YouTube: `youtube.clientId` y `youtube.clientSecret`.
- [ ] LinkedIn Ads: `linkedin.clientId` y `linkedin.clientSecret`.
- [ ] LinkedIn Página: `linkedin.cmClientId` y `linkedin.cmClientSecret`.
- [ ] Google Ads: `googleads.clientId`, `googleads.clientSecret`, `googleads.developerToken`.

La llamada es `POST /admin/api/settings` con cuerpo `{"key":"...","value":"..."}` y tu
cookie de sesión. Salta este paso entero si el cliente no va a usar esas conexiones.

## 4.7 · Crear el usuario del cliente

- [ ] **Equipo** → crea el usuario del cliente con su correo.
- [ ] Dale las vistas que necesite. Ten presente qué **no** va a ver nunca, por diseño:
      **Ajustes**, **Actividad** y **Grupos de negocio** están reservadas al
      administrador del stack.
- [ ] Comprueba en una ventana de incógnito que entra y que ve Conexiones y Bandeja.

## 4.8 · Reparto de webhooks de Instagram — VUELVE AQUÍ DESPUÉS DEL PASO 5.2

Este paso no se puede hacer todavía: necesita el identificador de la cuenta de Instagram
del cliente, y ese identificador aparece cuando el cliente conecta Instagram.

**Por qué existe este paso.** WhatsApp permite decirle a Meta, número a número, a qué
servidor entregar los mensajes — y el panel lo hace solo al conectar el número.
**Instagram y Facebook no:** la Meta App tiene **una sola** dirección de entrega para
todos. Así que Meta entrega todo a tu **instancia central**, y la central reparte cada
evento a la instancia del cliente que corresponde, recortado a sus propias cuentas y
vuelto a firmar. Ese mapa de reparto es el ajuste `relay.routes`.

**No tiene pantalla en el panel.** Se escribe con una llamada a la API contra tu
instancia central, con tu sesión de administrador del stack:

```
POST https://<tu-central>/admin/api/settings
{"key":"relay.routes","value":"{\"ig:<igBusinessId>\":\"https://<dominio-cliente>\",\"page:<pageId>\":\"https://<dominio-cliente>\"}"}
```

Reglas que hay que respetar al dedillo, porque los errores aquí **fallan en silencio**:

- [ ] El valor es **el mapa completo**, con las entradas de todos los clientes. Este
      ajuste se sobrescribe entero: si mandas sólo la entrada nueva, borras las demás.
      Lee primero `GET /admin/api/settings` y añade sobre lo que ya hay.
- [ ] La clave es `ig:<id>` o `page:<id>`. **Sólo esos dos prefijos.** Una clave `wa:`
      se acepta y no hace nada.
- [ ] El valor de cada entrada es la **URL base** de la instancia del cliente, **con
      `https://`** y **sin ruta al final**. Una entrada con `http://`, con un espacio o
      con credenciales dentro se descarta sin avisar, y ese cliente se queda sin
      Instagram con todo lo demás funcionando.
- [ ] Si el JSON está mal formado, **se ignora entero**: ningún cliente recibe nada.
- [ ] **Después de guardar, vuelve a leer** `GET /admin/api/settings` y confirma con los
      ojos que la entrada nueva está y que las viejas siguen.
- [ ] La instancia del cliente tiene el **mismo App Secret** que la central
      (`IG_APP_SECRET`, paso 2.3). Si no coincide, la central reenvía, el cliente
      rechaza por firma inválida y el evento se pierde. En el Diagnóstico de la central
      lo verás como «NO se pudo entregar a su panel».

---

# Fase 5 · Lo que configura el CLIENTE, desde su panel

A partir de aquí conduce el cliente, con su usuario. Todo esto es suyo: sus cuentas, sus
tokens, su base de conocimiento. Se guarda cifrado en su base de datos.

El menú lateral marca **Conexiones** con la etiqueta «EMPIEZA AQUÍ». Ese es el orden.

## 5.1 · WhatsApp

WhatsApp entra por **dos caminos independientes**, y el cliente puede usar uno, el otro
o los dos a la vez: conviven en la misma bandeja y en la misma lista de canales.

**Camino A — su número de siempre, por QR.** Sin tocar Meta para nada.

- [ ] **Conexiones → WhatsApp → Vincular por QR.** El panel muestra un código; el
      cliente lo escanea desde el móvil, como al vincular WhatsApp Web. Ese número no
      pasa por la app de Meta ni necesita alta ni verificación.
- [ ] Al vincular, importa el histórico de los últimos **90 días** por un canal aparte,
      para que el bot no conteste mensajes viejos.
- [ ] Explícale al cliente sus dos límites, y que son **a propósito**: no puede mandar
      difusiones (proteger su número del baneo por volumen no solicitado) y no hay
      ventana de 24 horas ni plantillas, porque no le hacen falta.
- [ ] Este número exige un **socket permanente**: la instancia no puede escalar a cero
      ni correr más de una réplica mientras tenga un número vinculado por QR.

**Camino B — el número del bot, por Meta.**

- [ ] **Conexiones → WhatsApp Business → Conectar WhatsApp.** Se abre una ventana de
      Meta (alta incrustada). El cliente elige o crea su cuenta de WhatsApp Business,
      añade su número y lo verifica por SMS o llamada.
- [ ] Si el cliente quiere **seguir usando la app verde en el móvil con ese mismo
      número**, hay que usar el flujo de **coexistencia** de Meta, no el normal. Esto
      es distinto de vincular por QR: la coexistencia sigue pasando por la app de Meta.
- [ ] Al terminar, el número aparece en la tarjeta. Comprueba que **no** lleva la
      etiqueta roja «No puede enviar».
- [ ] Si sale el aviso «los mensajes de este número se están entregando en otro panel»:
      abre **Diagnóstico** y pulsa **«Traerlos a este panel»**.

El panel, al conectar el número de Meta, le dice a Meta que entregue los mensajes de
**ese número concreto** a esta instancia. Por eso WhatsApp no necesita el reparto del
paso 4.8. Para que eso funcione hacen falta dos cosas que ya deberías tener: dominio
público en https y `WHATSAPP_VERIFY_TOKEN` puesto. El número vinculado por QR no
necesita nada de esto: no pasa por Meta ni por el paso 4.8.

## 5.2 · Instagram

- [ ] **Conexiones → Instagram → Conectar Instagram.** Se entra con la cuenta de
      Facebook que administra la Página vinculada.
- [ ] La cuenta aparece en la tarjeta. **Apunta su identificador**: lo necesitas para el
      paso 4.8.
- [ ] **Vuelve ahora al paso 4.8** y da de alta la ruta en la central. Hasta que no lo
      hagas, los mensajes directos de Instagram **no llegan** a este panel.

## 5.3 · Facebook

- [ ] **Conexiones → Facebook → Conectar Facebook.** Selecciona las Páginas.
- [ ] Apunta el identificador de cada Página y añádelas también al mapa del paso 4.8,
      con el prefijo `page:`.

## 5.4 · El resto de conexiones (opcionales)

- [ ] **Conexiones → Meta Ads → Conectar Meta Ads.** Métricas de inversión publicitaria.
- [ ] **Conexiones → YouTube → Conectar YouTube.** Requiere el paso 4.6.
- [ ] **Conexiones → Webs.** Cuenta y clave de API de systeme.io del cliente.
- [ ] **Conexiones → Avisos de tu web.** Si el cliente tiene webs en systeme.io: copia
      la dirección y la clave secreta que muestra la tarjeta y pégalas en su web, en
      *Ajustes → Webhooks → Crear*, marcando los eventos **Registro** y **Asignación de
      etiqueta**.
- [ ] **Conexiones → Redes sociales.** Cuenta de Zernio **del cliente** para publicar
      desde el Programador.
- [ ] **Conexiones → LinkedIn Ads / LinkedIn Página / Google Ads.** Requieren el 4.6.

## 5.5 · Bots y conocimiento

- [ ] **Bots y Conocimiento** → escribe **lo que el bot sabe del negocio**: qué vende,
      precios, horarios, cómo se pide cita, qué no debe prometer.
- [ ] **Bots y Conocimiento → Canales** → decide, canal por canal y cuenta por cuenta,
      quién contesta: la IA, un bot concreto, o nadie (y la conversación queda esperando
      en la Bandeja).

**Muy importante, dilo en voz alta al cliente:** **la respuesta automática viene apagada
de fábrica en todos los canales.** Es a propósito. Si nadie enciende el interruptor
aquí, los mensajes entran a la Bandeja y ahí se quedan, esperando a una persona. Si el
cliente dice «el bot no contesta», esto es lo primero que hay que mirar.

## 5.6 · Puesta a punto del CRM

- [ ] **Etiquetas** → crea las que use el negocio.
- [ ] **Pipeline** → nombra las etapas de venta.
- [ ] **Plantillas** → si va a escribir a clientes fuera de la ventana de 24 horas de
      WhatsApp, necesita plantillas aprobadas por Meta. Créalas ahora: la aprobación
      tarda.
- [ ] **Equipo** → el cliente da de alta a su gente, con las vistas que cada uno
      necesite.

---

# Fase 6 · Comprobación final: que funciona de verdad

No des el alta por buena con el panel en verde. Estas cuatro pruebas son las que
cuentan. Hazlas **con el cliente delante**.

## 6.1 · Un mensaje real de WhatsApp que entra

- [ ] Desde **tu móvil personal** (un número que nunca haya escrito a ese negocio),
      envía un mensaje al número del cliente.
- [ ] El mensaje aparece en **Bandeja** en segundos.
- [ ] En **Contactos** aparece tu número como contacto nuevo.

## 6.2 · El bot contesta

- [ ] Con el interruptor de WhatsApp encendido en **Bots y Conocimiento → Canales**,
      manda una pregunta de las que el negocio recibe a diario.
- [ ] Llega la respuesta al móvil, y en la Bandeja se ve el intercambio completo.
- [ ] Si no contesta, en este orden: ¿está encendido el canal? ¿hay bot asignado a esa
      cuenta? ¿dice «Activo · DeepInfra» la tarjeta de IA?

## 6.3 · Un mensaje directo de Instagram que llega a la Bandeja

Esta es la prueba que valida el paso 4.8, y la que más se rompe.

- [ ] Desde **otra cuenta de Instagram**, manda un mensaje directo a la cuenta del
      cliente.
- [ ] El mensaje aparece en la **Bandeja** del cliente.
- [ ] Si no aparece, mira en **tu instancia central**, en **Conexiones → WhatsApp →
      Diagnóstico**, el registro de webhooks recibidos (guarda los **últimos 30**, en
      memoria y por réplica: míralo **justo después** de la prueba o se te va). Ahí
      distingues los tres fallos:
      - «evento de \<id\> **entregado** a su panel» → la central hizo su trabajo; el
        problema está en la instancia del cliente.
      - «evento de \<id\> **NO se pudo entregar** a su panel» → revisa la URL del mapa
        `relay.routes` y que el App Secret coincida en las dos instancias.
      - No aparece nada de esa cuenta → la entrada del mapa no existe, o se descartó por
        formato (paso 4.8).

## 6.4 · Diagnóstico y páginas públicas

- [ ] **Conexiones → WhatsApp → Diagnóstico:** el número sale con el acceso válido y
      entregando **a este panel**.
- [ ] `https://<dominio>/privacidad` muestra el nombre y el correo del cliente.
- [ ] `https://<dominio>/eliminar-datos` responde.

## 6.5 · Aviso de marca — declararlo, no ocultarlo

**Estado hoy: el panel sigue mostrando el nombre «LeadMatch» en la pantalla de acceso,
en la barra lateral, en el título de la pestaña del navegador y en la vista previa que
sale al compartir el enlace del panel.** El campo *Nombre de tu empresa* del paso 4.3
**añade** el nombre del cliente al lado, no lo sustituye.

El **logotipo** sí está resuelto: este repositorio no lleva el nuestro, así que de
fábrica sale una marca genérica, y en cuanto dejes el `logo.png` del cliente en
`packages/whatsapp-bot/assets/` pasa a verse el suyo como icono de pestaña, en el panel
y en la pantalla de acceso. Lo que queda pendiente es solo el texto.

- [ ] Dilo tú antes de que lo vea él, y con fecha de arreglo. No lo descubras junto al
      cliente en mitad de la demo.

---

# Fase 7 · Qué apuntar, y dónde

Sin esto, el primer incidente del cliente te cuesta media mañana de arqueología.

## 7.1 · Dónde va

- [ ] Las **credenciales** (`APP_ENC_KEY`, `ADMIN_PASSWORD`, `STATE_SECRET`,
      `WHATSAPP_VERIFY_TOKEN`, PIN de credenciales) van al **gestor de contraseñas**, en
      una entrada por cliente.
- [ ] La **ficha operativa** (identificadores, dominios, qué está conectado) va a tu
      documento local de clientes.
- [ ] **Nada de esto se commitea a ningún repositorio.** Ni al interno, ni al de cliente.

## 7.2 · Qué apuntar

- [ ] La **ficha de cabecera** de este documento, completa.
- [ ] Los cuatro identificadores de Meta: `phoneNumberId`, `wabaId`, `igBusinessId` y
      `pageId`. Son la única forma de resolver un problema de enrutado sin ir
      adivinando.
- [ ] La **entrada exacta** que añadiste a `relay.routes`, tal cual, con las comillas.
- [ ] Qué integraciones quedaron **pendientes** y por qué (p. ej. «YouTube sin activar:
      el cliente no lo quiso»). Lo pendiente no declarado es lo que después parece una
      avería.
- [ ] Los **plazos de Meta** que quedaron abiertos: plantillas en revisión, verificación
      del negocio, aumento del límite de mensajes.

## 7.3 · Tres avisos para el yo del futuro

- [ ] **No rotes `APP_ENC_KEY` nunca** después del primer arranque. Es la clave que
      descifra todos los tokens guardados de ese cliente: cambiarla los deja ilegibles y
      hay que reconectarlo todo desde Conexiones.
- [ ] **Cambiar `ADMIN_PASSWORD` cierra todas las sesiones abiertas** de ese panel,
      porque la firma de las sesiones se deriva de ella. Es lo que hay que hacer si
      sospechas de una fuga; no es algo que se toque por rutina.
- [ ] **Si el cliente cambia su contraseña desde el panel**, la variable
      `ADMIN_PASSWORD` deja de servir para entrar: el ajuste guardado manda sobre la
      variable, y deja de ser tu vía de acceso. Que te avise si lo hace.

---

# Anexo A · Qué hacer cuando algo no va

| Síntoma | Causa más probable | Dónde mirar |
|---|---|---|
| Todo se borra en cada redespliegue | Falta `DATABASE_URL` | Log de arranque: `[db] DATABASE_URL no definida` |
| «Panel desactivado» al entrar | Falta `ADMIN_PASSWORD` | Variables del servicio |
| El despliegue muere al arrancar | Falta `APP_ENC_KEY` | Log: `APP_ENC_KEY ausente en producción`. Si además falla la base de datos el mensaje es otro: `No se pudo leer settings para verificar cripto…` |
| Los botones «Conectar» de Meta fallan al volver | Falta la URL de retorno en la Meta App | Paso 4.5 |
| Botón «Conectar» gris con «Pendiente de activar por el administrador» | Falta la credencial de la app tuya | Paso 4.6 |
| El bot no contesta, pero los mensajes entran | Interruptor del canal apagado, o sin bot asignado | Bots y Conocimiento → Canales |
| El bot no contesta y la IA dice «Sin conectar» | Falta `key.deepinfra`, o se puso `DEEPINFRA_API_KEY` por variable creyendo que valía | Conexiones → Inteligencia Artificial |
| WhatsApp entra pero no sale nada | Número sin activar («No puede enviar») | Conexiones → WhatsApp → Diagnóstico |
| WhatsApp no entra nada | Los mensajes se entregan en otro panel | Diagnóstico → «Traerlos a este panel» |
| Instagram no entra nada | `relay.routes` sin la entrada, mal formada, o App Secret distinto | Paso 4.8 y Diagnóstico de la central |
| Un canal deja de entrar tras crear un segundo negocio en la instancia | Alguna variable de la lista negra (2.4) | Variables del servicio |
| Las páginas legales dicen «[Tu empresa]» | Falta la identidad legal | Ajustes → Identidad legal |

---

# Anexo B · Lo que este documento NO garantiza

Escrito para que lo declares tú antes de que te lo pregunten:

- **La construcción de la imagen en Railway no se ha probado de extremo a extremo desde
  el repositorio de cliente ya recortado.** El árbol recortado compila, pasa los
  verificadores y arranca; la construcción de la imagen no se llegó a ejecutar en la
  máquina donde se preparó esto. En el **primer** alta, mira el registro de construcción
  entero antes de seguir. Si falla, el sospechoso conocido es una línea del `Dockerfile`
  que copia un paquete que ya no existe en el repositorio de cliente.
- **No está comprobado si Meta hace su llamada de verificación contra la dirección de
  entrega alternativa** al dar de alta un número de WhatsApp. Por eso el orden de este
  documento es el que es: la instancia se despliega y responde **antes** de conectar
  ningún número.
- **El paso 4.8 no tiene ninguna interfaz ni ninguna validación en el servidor.** Un
  error de tecleo en ese JSON deja sin Instagram al cliente, o a todos, sin un solo
  aviso en el panel. La comprobación de 6.3 no es opcional.
- **La marca sigue siendo la nuestra** (6.5).
- **El repositorio de cliente no puede verificarse a sí mismo:** los verificadores del
  panel, la batería de aislamiento entre negocios y el arnés de extremo a extremo viven
  sólo en el repositorio interno. Cualquier cambio se verifica allí y de allí se
  sincroniza. No parchees nunca directamente el repositorio de un cliente.
