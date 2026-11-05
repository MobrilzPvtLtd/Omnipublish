# Business Stack — instancia de cliente

Panel de operación digital multi-canal: bandeja unificada de conversaciones (WhatsApp,
Instagram, Facebook), CRM con contactos y pipelines, flujos y bots, programador de
contenido y analítica. Cada instancia sirve a **un cliente** y corre en **su propio
Railway**, con **su propia base de datos** y **sus propias cuentas**. Casi nada se
configura por variables de entorno: las cuentas y las claves se conectan desde el panel
(`/admin`) y se guardan cifradas en Postgres.

---

## 1 · Desplegar en Railway

Sigue los pasos en este orden. No cambies el orden: `DATABASE_URL` y `ADMIN_PASSWORD`
tienen que estar puestas **antes** del primer arranque útil.

1. **Crea el proyecto en Railway y conecta este repositorio.** El proyecto es del
   cliente y lo paga él; el repositorio es privado y **el cliente no tiene acceso**.
   Quien conecta el repositorio es el operador, invitado al proyecto de Railway del
   cliente con su propia cuenta de GitHub.

   Railway construye con el `Dockerfile` (lo fija `railway.json`), arranca con
   `node packages/whatsapp-bot/dist/index.js` y comprueba la salud en `/health`.
   La rama que se despliega es `main`, con autodespliegue en cada push.

2. **Añade el complemento PostgreSQL al mismo proyecto.** Añadirlo no basta: el
   complemento **no inyecta la cadena de conexión en el servicio de la app por sí solo**.

3. **Pon las variables del servicio de la app** (Settings → Variables), las cuatro de una
   sola tanda. La lista completa —incluidas las de la app de Meta, las del puente con
   systeme.io y **las que no hay que poner nunca**— está en [VARIABLES.md](VARIABLES.md):

   | Variable | Valor | Por qué |
   |---|---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referencia al complemento) | Único almacén de ajustes, tokens, contactos y conversaciones |
   | `APP_ENC_KEY` | Cadena aleatoria, **distinta por cliente**, 32+ caracteres | Cifra los secretos en Postgres. Sin ella el proceso no arranca en producción |
   | `ADMIN_PASSWORD` | Contraseña fuerte | Acceso al panel. Sin ella el panel queda desactivado |
   | `STATE_SECRET` | Cadena aleatoria, distinta por cliente | Firma el `state` de los OAuth de Meta. Sin ella se usa un literal compartido por todos los despliegues |

   Opcional: `ADMIN_USER` si el usuario de acceso no va a ser `admin` (ese es el valor por
   defecto).

   **No rotes `APP_ENC_KEY` ni `ADMIN_PASSWORD` después del primer arranque** sin plan:
   la firma de las sesiones se deriva de ambas, así que cambiarlas invalida todas las
   cookies emitidas; y cambiar `APP_ENC_KEY` deja **ilegibles** los secretos ya cifrados
   en la base de datos (habría que reconectar todas las cuentas).

4. **Genera el dominio público** del servicio. Railway inyecta entonces
   `RAILWAY_PUBLIC_DOMAIN`, que es de donde salen los enlaces cortos y —lo importante— la
   URL que se le da a Meta como destino de los webhooks de cada número.
   Si el cliente usa dominio propio, añade además
   `PUBLIC_BASE_URL=https://panel.sudominio.com` — **https y sin barra final**.

5. **Despliega** y espera a que el healthcheck pase.

6. **Comprueba `/health`:**

   ```sh
   curl https://<dominio-de-la-instancia>/health
   # {"ok":true}
   ```

7. **Comprueba el log de arranque** — esto es imprescindible, porque `/health` responde
   `{"ok":true}` **también cuando falta la base de datos**. En los registros del
   despliegue **NO** deben aparecer estas dos líneas:

   ```
   [db] DATABASE_URL no definida — almacén en memoria (no persiste).
   [seguridad] STATE_SECRET sin definir y admin.pass vacio — usando fallback hardcoded.
   ```

   Si aparece la primera, el despliegue está verde pero **no persiste nada**: vuelve al
   paso 2.

8. **Entra en `/admin`** con `ADMIN_USER` + `ADMIN_PASSWORD`. Si ves la pantalla «Panel
   desactivado», falta `ADMIN_PASSWORD`.

### Variables que NO se ponen en el Railway de un cliente

Ponerlas de más rompe cosas de forma silenciosa. Esta lista es tan importante como la
anterior.

| Variable | Qué provoca |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Todos los espacios de trabajo reclaman ese número. Con dos o más activos, el enrutado lo declara en conflicto y descarta los mensajes contestando 200 a Meta: en Meta todo sale verde y al panel no entra nada |
| `IG_BUSINESS_ACCOUNT_ID` | Lo mismo para la cuenta de Instagram |
| `WHATSAPP_ACCESS_TOKEN`, `IG_ACCESS_TOKEN`, `META_ADS_TOKEN`, `META_AD_ACCOUNT_ID` | No rompen el enrutado, pero cualquier espacio de trabajo nuevo hereda esas credenciales |
| `ROUTING_STRICT` | Solo la lleva la instancia central del operador (la que figura en el App Dashboard de Meta). En una instancia de cliente descarta con 200 todo lo que llegue antes de conectar el canal |
| `ALLOW_INSECURE_ENC_KEY` | Degrada el fallo por `APP_ENC_KEY` a un aviso y arranca cifrando con una clave de desarrollo pública. Nunca |
| `DEEPINFRA_API_KEY` | No activa la IA: no existe respaldo por entorno para esa clave. Se pega en el panel (ver §2) |

Las cuentas de WhatsApp, Instagram, Facebook, Meta Ads y YouTube **se conectan siempre
desde la vista Conexiones**, nunca por variables.

### El segundo servicio: el puente con systeme.io

Publicar páginas en systeme.io y leer sus embudos no lo hace esta aplicación, sino
**`systemeio-mcp`**, un servicio aparte que se despliega **en el mismo proyecto de
Railway del cliente**, desde el repositorio `ingenierobinario/systemeio-mcp-customers` (rama `main`; es la versión reducida a lo que usa el panel).

Cada cliente tiene el suyo, y eso no se negocia: el puente le manda **el correo y la
contraseña de systeme.io del cliente** para abrir sesión. Apuntar varias instancias a un
mismo MCP significaría que las credenciales de unos clientes pasan por un servidor que no
es suyo.

**No es opcional en el sentido en que lo decía antes esta página.** El panel consulta
systeme.io por **tres vías en paralelo** —la API interna con la cookie de sesión, la API
pública con la clave, y el MCP— y se queda con la que responda; para las estadísticas de
correo el orden es explícito: cookie primero, MCP de respaldo.

Pero hay dos cosas que **solo** hace el MCP:

- **Publicar páginas** en systeme.io. No hay otra vía.
- **Abrir sesión solo.** Es lo que consigue la cookie que usan las otras vías, con un
  navegador y resolviendo la verificación en dos pasos.

Así que sin MCP, mientras la cookie siga viva los datos siguen llegando — pero **nadie
puede renovarla desde el panel**. El cliente tendría que pegar el PHPSESSID a mano cada
vez que caduque, que es exactamente lo que el producto promete que no pasa. Lo que sí
sigue funcionando sin él pase lo que pase: sincronizar contactos y ponerles etiquetas,
que va por la API pública con la clave del cliente y es lo que dispara sus
automatizaciones.

| En el servicio | Variable | Valor |
|---|---|---|
| Business Stack | `MCP_URL` | `https://${{systemeio-mcp.RAILWAY_PUBLIC_DOMAIN}}/mcp` |
| Business Stack | `MCP_TOKEN` | `${{systemeio-mcp.INTERNAL_API_SECRET}}` |
| systemeio-mcp | `INTERNAL_API_SECRET` | Cadena aleatoria, propia de este cliente |
| systemeio-mcp | `MASTER_KEY` | 32 bytes en hexadecimal (64 caracteres) |
| systemeio-mcp | `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` | Ver el aviso de abajo |

Usa **referencias entre servicios** (`${{servicio.VARIABLE}}`) en vez de pegar valores:
si el dominio cambia, no hay que acordarse de actualizar el otro lado.

> **La sesión de systeme.io no sobrevive a un redespliegue sin Supabase.** El MCP abre
> sesión con un navegador y guarda las cookies. En Railway el disco es efímero, así que
> sin `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` cada redespliegue borra la sesión y
> el siguiente acceso a systeme.io pide verificación en dos pasos **a mano**. Con ellas,
> la sesión se restaura sola al arrancar.

**Si no despliegas el MCP**, la instancia funciona igual: el panel, la bandeja, los
flujos, el CRM y la sincronización de contactos con systeme.io no dependen de él —
sincronizar un contacto y ponerle etiquetas va por la API pública con la clave del
cliente. Lo que queda apagado es **publicar páginas** y **renovar la sesión sola**
cuando la cookie caduque (el cliente tendría que pegar el PHPSESSID a mano), y
Conexiones lo dice en vez de fallar sin explicación.

---

## 2 · Quién configura qué

La frontera no es de criterio: está en el código. Hay dos tipos de ajuste.

**Ajustes globales del stack.** Solo los escribe una sesión abierta con `ADMIN_USER` +
`ADMIN_PASSWORD` (el «administrador del sistema»). A cualquier otro usuario el servidor
le devuelve 403.

**Ajustes del negocio.** Son por espacio de trabajo, se cifran en Postgres y los pone
quien use el panel.

| Lo pone… | Qué | Dónde |
|---|---|---|
| **Operador** (variables de Railway) | `DATABASE_URL`, `APP_ENC_KEY`, `ADMIN_PASSWORD`, `STATE_SECRET`, `PUBLIC_BASE_URL` | Railway |
| **Operador** (global, en el panel) | App ID y App Secret de la Meta App compartida, token de verificación de webhooks, IDs de configuración del alta guiada de WhatsApp | Conexiones → Meta |
| **Operador** (global, en el panel) | Credenciales de las apps de YouTube, LinkedIn y Google Ads. Sin ellas, el botón «Conectar YouTube» sale deshabilitado con «Pendiente de activar por el administrador del panel» | API / Ajustes |
| **Operador** (global, en el panel) | **Clave de IA** (`key.deepinfra`) y modelos. Aunque la pague el cliente, hoy es un ajuste global: solo la guarda quien entra con `ADMIN_PASSWORD` | Conexiones → Inteligencia Artificial |
| **Operador** (global, en el panel) | Identidad legal publicada en `/privacidad`, `/terminos` y `/eliminar-datos`, y marca del panel (`brand.operator`) | Ajustes |
| **Cliente** | Su número de siempre (escanea un código QR, no pasa por Meta), el número del bot (alta guiada de Meta), cuenta de Instagram, páginas de Facebook, cuentas publicitarias, canal de YouTube, LinkedIn, Google Ads | Conexiones |
| **Cliente** | Sus webs, sus redes sociales de publicación (cuenta propia de Zernio) | Conexiones |
| **Cliente** | Bots, base de conocimiento, interruptor de quién contesta cada canal (**apagado de fábrica**), flujos, difusiones, plantillas | Bots & Conocimiento, Flujos |
| **Cliente** | Aviso de IA (art. 50 AI Act), dominio de enlaces cortos, equipo | Ajustes, Equipo |
| **Cliente** | Conexiones de IA (Claude, ChatGPT, Cursor…) que consultan y actúan sobre su negocio: «Solo consultar» o «Consultar y actuar», y desconectarlas | Conecta tu IA (menú, «Empieza aquí») |

**Dos consecuencias que hay que decidir a conciencia, no descubrir sobre la marcha:**

- Si el cliente entra con un **usuario de base de datos**, no puede guardar la clave de
  IA ni la identidad legal: son ajustes globales. Esas dos las deja puestas el operador
  durante el alta.
- Si el cliente entra como **administrador del sistema** (le das `ADMIN_PASSWORD`), puede
  leer y cambiar el App Secret de la Meta App **compartida entre todos los clientes**.
  Esto no se recomienda.

Del App Secret de la Meta App compartida, si va por entorno, la variable es
`IG_APP_SECRET` — no `META_APP_SECRET`. Poner solo `META_APP_SECRET` deja el reparto de
webhooks firmando en vacío y el destino descarta los eventos sin decir por qué.

---

## 3 · Actualizar una instancia

La verificación (verificadores del panel, suites de tenencia, arnés e2e) vive en el
repositorio interno del operador. **Este repositorio no puede verificarse a sí mismo**:
se verifica allí y desde allí se sincroniza aquí.

1. El operador verifica el cambio en su repositorio interno.
2. Sincroniza los ficheros al repositorio de cliente y hace commit en `main`.
3. Railway despliega solo al detectar el push.
4. Comprueba `/health` y el log de arranque (paso 7 del §1) antes de dar por buena la
   instancia.

**Nunca varios despliegues en ráfaga sobre la misma instancia**: espera a que el anterior
esté sano. Y si actualizas varias instancias de clientes distintos, de una en una.

Las migraciones de esquema corren solas al arrancar y son idempotentes: no hay paso
manual de base de datos.

---

## 4 · Si algo falla

| Síntoma | Causa probable | Cómo comprobarlo |
|---|---|---|
| El despliegue está verde pero al reiniciar se pierde todo: cuentas desconectadas, contactos vacíos | Falta `DATABASE_URL`. La app arranca en memoria y `/health` sigue devolviendo `{"ok":true}` | Busca en el log de arranque `[db] DATABASE_URL no definida`. Arréglalo con la referencia `${{Postgres.DATABASE_URL}}` (§1, paso 3) |
| El proceso muere al arrancar y reintenta en bucle | Falta `APP_ENC_KEY` | En el log: `APP_ENC_KEY ausente en producción`. Si la base de datos tampoco se puede leer, el mensaje es otro: `No se pudo leer settings para verificar cripto y falta APP_ENC_KEY` |
| «Panel desactivado» al abrir `/admin` | Falta `ADMIN_PASSWORD` | La propia pantalla lo dice y da los pasos. Crear usuarios en base de datos **no** es una salida alternativa: la puerta se comprueba antes que la sesión |
| Meta entrega 200 pero al panel no llega ningún mensaje | Hay variables de canal puestas en Railway (`WHATSAPP_PHONE_NUMBER_ID` / `IG_BUSINESS_ACCOUNT_ID`), o el webhook por número no se pudo fijar porque la instancia no tiene URL pública https | Quita esas variables **después** de haber conectado el canal desde Conexiones (si el espacio vivía del respaldo de entorno, al quitarlas se queda sin token). Para lo segundo: Conexiones → WhatsApp → Diagnóstico, y comprueba que `PUBLIC_BASE_URL` o el dominio de Railway existen |
| Conexiones dice «Sin conectar» en Inteligencia Artificial aunque la clave esté en Railway | `DEEPINFRA_API_KEY` no tiene respaldo por entorno | Pega la clave en Conexiones → Inteligencia Artificial, con sesión de administrador del sistema |
| Conexiones dice que el puente de systeme.io no tiene dirección configurada | Falta `MCP_URL`, o el segundo servicio no está desplegado | Comprueba que el servicio `systemeio-mcp` existe en el proyecto y que `MCP_URL` apunta a él. Si no lo has desplegado a propósito, no es un fallo: los datos siguen llegando mientras la cookie de systeme.io viva, pero nadie podrá renovarla desde el panel cuando caduque, y publicar páginas no funcionará |
| Todo va, pero systeme.io pide verificación en dos pasos cada vez que redespliegas | Al MCP le faltan `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` | El disco de Railway es efímero: sin ellas, cada redespliegue borra la sesión del navegador |
| Las páginas legales muestran «[Tu empresa]» | La identidad legal está sin rellenar | `curl https://<dominio>/privacidad`. Rellena Ajustes → Identidad legal; como mínimo negocio, correo y web. Meta exige esas URLs válidas para el App Review |

---

## 5 · Desarrollo local (opcional)

Node **22.12 o superior**.

```sh
npm ci
npm run build
npm start          # panel en http://localhost:8080/admin
```

`npm run dev` recompila en caliente. Sin `DATABASE_URL` el servidor arranca en memoria y
no persiste nada: útil para mirar el panel, inútil para probar de verdad.

## 6 · Estructura

| Ruta | Contenido |
|---|---|
| `packages/whatsapp-bot/src/` | El servicio completo: API, panel, CRM, motores de flujos e integraciones |
| `packages/whatsapp-bot/assets/` | Vacía a propósito. Deja aquí el `logo.png` del cliente y la app lo sirve como icono y logotipo del panel |
| `Dockerfile`, `railway.json` | Construcción y despliegue |
| `.env.example` | Las variables de arranque, documentadas |
| `DESPLIEGUE.md` | La lista de comprobación del alta de un cliente, de cero a operativo |
| `VARIABLES.md` | **Referencia completa** de las variables de los dos servicios y de la base de datos |
| `packages/whatsapp-bot/MCP.md` | La guía del servidor MCP del panel: la lee la IA que conecta el cliente (herramientas, permisos, recetas) |

Rutas públicas: el panel en `/admin`, el estado en `/health`, los webhooks en `/webhook`,
`/webhook/instagram` y `/webhook/facebook`, las páginas legales en `/privacidad`,
`/terminos` y `/eliminar-datos`, y `/mcp` para que el cliente conecte su IA entrando con su cuenta
del panel (o con una clave creada en Conecta tu IA). El alta de esa conexión usa
`/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`,
`/oauth/register`, `/oauth/authorize` y `/oauth/token`, también públicas. Ese `/mcp` es el del propio panel: no tiene nada que
ver con el puente `systemeio-mcp` del §1, que es un servicio aparte.

## 7 · Lo que este repositorio no trae, y lo que está sin verificar

- **No trae los verificadores del panel ni las suites de pruebas.** No se puede validar
  un cambio desde aquí; se valida en el repositorio interno del operador (§3).
- **La construcción de la imagen no se ha probado en local**: el demonio de Docker no
  estaba operativo en la máquina donde se preparó este recorte. Sí se han verificado
  `npm ci`, `npm run build`, el podado de dependencias y el arranque del binario
  resultante. Railway construye en sus propios runners Linux.
- **La marca del panel todavía no es blanca del todo.** El logotipo y la tarjeta de
  vista previa del operador **no viajan** en este repositorio: sin ellos la app cae a
  una marca genérica, y el cliente puede poner la suya dejando su `logo.png` en
  `packages/whatsapp-bot/assets/`. Lo que sí sigue escrito en el código es el **nombre
  del producto**, en la pantalla de acceso, la barra lateral, el título de la pestaña y
  los metadatos de vista previa. `BRAND_OPERATOR` añade el nombre del cliente **al
  lado**, no lo sustituye. Está pendiente de parametrizar en el repositorio interno, y
  hasta entonces conviene decírselo al cliente antes de la demo.
