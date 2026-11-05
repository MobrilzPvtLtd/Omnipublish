# Variables de los dos despliegues

Una instancia de cliente son **dos servicios y una base de datos** en un mismo proyecto de
Railway:

| Pieza | Qué es | ¿Obligatoria? |
|---|---|---|
| **Business Stack** | Este repositorio. El panel, la bandeja, el CRM, los flujos y el bot | Sí |
| **PostgreSQL** | Complemento de Railway. Es el único almacén: ajustes, cuentas, contactos y conversaciones | Sí |
| **systemeio-mcp** | Repositorio aparte. Publica páginas en systeme.io y renueva la sesión sola | Prácticamente sí — ver el apartado 3 |

> Los valores marcados **por cliente** se generan nuevos en cada alta y no se reutilizan
> jamás entre clientes. Los marcados **compartidos** son los mismos en toda la flota:
> son la identidad ante Meta, y viven en el documento de arquitectura en Notion.

---

## 1 · La base de datos

Añadir el complemento PostgreSQL al proyecto **no basta**: no inyecta nada en el servicio
de la aplicación. Hay que crear la variable a mano, y su valor es una **referencia**:

```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
```

Si falta, la aplicación **arranca igual**, `/health` devuelve `{"ok":true}` y Railway da el
despliegue por bueno — pero trabaja en memoria y cada reinicio borra cuentas, contactos y
conversaciones. En el registro de arranque aparece:

```
[db] DATABASE_URL no definida — almacén en memoria (no persiste).
```

Es el fallo más caro de todos porque no se nota hasta el primer reinicio. Compruébalo
siempre antes de dar el alta por buena.

**El MCP no necesita base de datos** (apartado 3).

---

## 2 · Servicio **Business Stack**

### 2.1 · Sin estas tres no hay instancia

| Variable | Valor | Si falta |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` · **por cliente** | Arranca en verde y no persiste nada (apartado 1) |
| `APP_ENC_KEY` | Aleatoria, 32+ caracteres · **por cliente** | El proceso **muere al arrancar** en producción. Es lo único que falla ruidosamente |
| `ADMIN_PASSWORD` | Contraseña fuerte · **por cliente** | El panel muestra «Panel desactivado» y no entra nadie |

**No cambies `APP_ENC_KEY` después del primer arranque.** Cifra los secretos guardados en
la base de datos: al cambiarla quedan ilegibles y hay que reconectar todas las cuentas.
Y la firma de las sesiones deriva de ella y de `ADMIN_PASSWORD`, así que tocar cualquiera
de las dos cierra la sesión de todo el mundo.

### 2.2 · Muy recomendadas

| Variable | Valor | Por qué |
|---|---|---|
| `STATE_SECRET` | Aleatoria · **por cliente** | Firma el `state` de los inicios de sesión con Meta. Sin ella se usa un literal **público** compartido por todos los despliegues, y el arranque lo avisa |
| `PUBLIC_BASE_URL` | `https://panel.sudominio.com` | Solo si el cliente tiene dominio propio. **https y sin barra final.** Manda sobre el dominio de Railway. De aquí salen los enlaces cortos y la dirección que se le da a Meta como destino de los webhooks de cada número |
| `ADMIN_USER` | Por defecto `admin` | Solo si quieres otro usuario de acceso |

### 2.3 · La app de Meta compartida

Son **las mismas para toda la flota**: es la identidad ante Meta que evita repetir el App
Review con cada cliente. Los valores están en el documento de arquitectura en Notion.

| Variable | Qué es |
|---|---|
| `META_APP_ID` | Identificador de la app compartida |
| `IG_APP_SECRET` | Secreto de la app. **Ojo con el nombre** (ver el aviso) |
| `WHATSAPP_APP_SECRET` | El **mismo valor** que la anterior. Firma los webhooks de WhatsApp |
| `WHATSAPP_VERIFY_TOKEN` | **Por cliente.** Es el que se registra en la redirección de webhooks de cada número, y el que compara la verificación de `/webhook` |
| `META_WA_EMBEDDED_CONFIG_ID` | Identificador de configuración del alta guiada de WhatsApp |
| `META_WA_COEXISTENCE_CONFIG_ID` | El de la coexistencia con la app verde |

> **La trampa del nombre.** El secreto de la app se lee de `IG_APP_SECRET`, no de
> `META_APP_SECRET`. Poner solo la segunda deja Conexiones en «configuración incompleta»
> sin decir por qué.

Estas variables son solo para **el número del bot**, el que entra por la API oficial de
Meta. El otro camino de WhatsApp —el número de siempre del cliente, vinculado **por
QR**— no usa ninguna de ellas: se conecta escaneando un código desde Conexiones y sus
credenciales se guardan cifradas en Postgres, igual que el resto de cuentas del cliente.

### 2.4 · El puente con systeme.io

Solo si despliegas el segundo servicio. Usa **referencias entre servicios**, no la URL
pegada a mano: si cambia el dominio, no hay que acordarse de actualizar este lado.

| Variable | Valor |
|---|---|
| `MCP_URL` | `https://${{systemeio-mcp.RAILWAY_PUBLIC_DOMAIN}}/mcp` |
| `MCP_TOKEN` | `${{systemeio-mcp.INTERNAL_API_SECRET}}` |
| `MCP_AUTH_HEADER` | Opcional. Por defecto ya es `X-Internal-Secret`, que es lo que pide el MCP |

### 2.5 · YouTube y opcionales

| Variable | Cuándo |
|---|---|
| `GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` | Solo si el cliente va a conectar YouTube. Son del proyecto de Google del operador, **compartidas**. Sin ellas el botón «Conectar YouTube» sale deshabilitado |
| `DATABASE_SSL=require` | Solo si conectas a un Postgres externo por SSL, no por la red interna de Railway |
| `BRAND_OPERATOR` · `LEGAL_*` | Respaldo de la marca y la identidad legal. Lo normal es ponerlas desde Ajustes, no aquí |

### 2.6 · Las que pone Railway sola

`PORT` · `RAILWAY_PUBLIC_DOMAIN` · `RAILWAY_ENVIRONMENT` · `RAILWAY_PROJECT_ID`.
`NODE_ENV` la fija el `Dockerfile` a `production`. **No las escribas.**

### 2.7 · Lista negra

Estas **no dan error**. Rompen en silencio, y en el panel de Meta todo sigue saliendo en
verde.

| Variable | Qué provoca |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID`<br>`IG_BUSINESS_ACCOUNT_ID` | **Todos** los espacios de trabajo reclaman ese canal. El enrutado lo declara en conflicto y **descarta los mensajes respondiendo 200 a Meta**: a la bandeja no entra nada y no hay ningún error en ninguna parte |
| `WHATSAPP_ACCESS_TOKEN`<br>`IG_ACCESS_TOKEN`<br>`META_ADS_TOKEN` · `META_AD_ACCOUNT_ID` | No rompen el enrutado, pero cualquier espacio de trabajo nuevo hereda esas credenciales |
| `ROUTING_STRICT` | Solo la lleva la instancia central del operador. Aquí descarta con 200 todo lo que llegue antes de conectar el canal |
| `ALLOW_INSECURE_ENC_KEY` | Arranca cifrando con una clave de desarrollo **pública**. Nunca |
| `DEEPINFRA_API_KEY` | No activa nada: esa clave no tiene respaldo por entorno. Se pega en Conexiones → Inteligencia Artificial |
| `OD_*` · `LINKEDIN_*` · `GOOGLE_ADS_*` | Credenciales de servicios del operador que el MVP no vende |
| `WS_STRICT_SECRETS` · `BIZGROUPS_ENFORCE`<br>`RBAC_VIEWS_ENFORCE` · `*_SKIP_*_MIGRATION` | Dejarlas **sin definir** es el aislamiento duro. Definirlas lo debilita |

Las cuentas de WhatsApp, Instagram, Facebook, Meta Ads y YouTube **se conectan siempre
desde la vista Conexiones**, nunca por variables.

---

## 3 · Servicio **systemeio-mcp**

Repositorio `ingenierobinario/systemeio-mcp-customers`, rama `main`. Se despliega en **el mismo
proyecto de Railway del cliente**, como un segundo servicio. Trae `Dockerfile` propio
(imagen de Playwright) y expone `/health`.

**No necesita base de datos.** Guarda la sesión de systeme.io en disco local y, si se lo
configuras, en Supabase Storage.

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

### 3.1 · Obligatorias

| Variable | Valor | Por qué |
|---|---|---|
| `INTERNAL_API_SECRET` | Aleatoria · **por cliente** | Es lo que Business Stack manda en `MCP_TOKEN`. El mismo valor a los dos lados |
| `MASTER_KEY` | 32 bytes en hexadecimal (64 caracteres) · **por cliente** | Cifra las cookies y los tokens de la sesión guardada |
| `SYSTEMEIO_BASE_URL` | `https://systeme.io` | **Léete el aviso de abajo antes de desplegar** |

> ### ⛔ `SYSTEMEIO_BASE_URL` viene apuntando al laboratorio del operador
>
> El `.env.example` del MCP trae por defecto una URL que apunta al systeme.io con
> marca blanca **del operador** — la verás en ese mismo fichero. Si despliegas sin
> cambiarla, el MCP de tu cliente intenta abrir sesión contra el panel de otro.
>
> Para un cliente el valor es `https://systeme.io`, o su propio dominio si tiene
> systeme.io con marca blanca. **Ponla siempre, explícitamente.**

### 3.2 · Muy recomendadas: la sesión

| Variable | Por qué |
|---|---|
| `SUPABASE_URL`<br>`SUPABASE_SERVICE_ROLE_KEY` | El MCP abre sesión en systeme.io con un navegador y guarda las cookies. El disco de Railway es **efímero**: sin estas dos, cada redespliegue borra la sesión y el siguiente acceso responde 403 y pide **verificación en dos pasos a mano**. Deja de ser autónomo |

> **Pendiente de decidir.** Hoy estas dos apuntan al proyecto de Supabase compartido del
> operador (el bucket `systemeio-sessions`). Para una instancia de cliente hay que darle
> su propio proyecto, o al menos separar el bucket: si no, las sesiones de todos los
> clientes acaban en el mismo sitio.

### 3.3 · Las que ya fija el Dockerfile

`PORT` (3002) · `NODE_ENV` (`production`) · `AUTH_DIR` (`/app/data`). **No las escribas.**

### 3.4 · Lista negra del MCP

| Variable | Qué provoca |
|---|---|
| `AXIOM_TOKEN` · `AXIOM_DATASET` · `AXIOM_API_HOST` | Manda los registros de este cliente al conjunto de datos del operador, compartido con el curso. Déjalas vacías |
| `GUION_CERRADO_ENABLED` | Interruptor de una función del curso, ajena al producto que vendes |
| `SYSTEMEIO_DISABLE_SESSION_PERSISTENCE` | Vuelve al comportamiento sin persistencia: sesión en memoria y disco efímero. Es un botón de emergencia, no una configuración |
| `SYSTEMEIO_DISABLE_MAQUETA_BLOCK_STRIP` | Igual: interruptor de reversión de una función concreta |

---

## 3 bis · Para pegar en el editor en crudo de Railway

La pestaña **Variables** de cada servicio tiene un **Raw Editor** que acepta JSON. Todo lo
que ponga `CAMBIAME` hay que sustituirlo antes de guardar.

### Añadir Postgres primero, paso a paso

1. En el proyecto, **`+ New`** en el lienzo (o `Ctrl/Cmd + K`) → **Database** → **PostgreSQL**.
2. Se crea un servicio llamado **`Postgres`**. Ese nombre es el que usarás en la
   referencia: si lo renombras, cambia también la referencia.
3. Expone `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` y `DATABASE_URL`.
   `DATABASE_PUBLIC_URL` solo aparece si activas acceso público — **no lo actives**.
4. En el servicio **de la aplicación** (no en el de Postgres) → **Variables** →
   **New Variable** → `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`. Al escribir `${{`
   sale un desplegable que autocompleta.
5. Redespliega y mira el registro: **no** debe aparecer `[db] DATABASE_URL no definida`.

Por la red interna del proyecto **no** hace falta `DATABASE_SSL`.

> Las variables de un servicio **no** están disponibles automáticamente en otro servicio
> del mismo proyecto. Siempre hay que referenciarlas.

### Servicio **Business Stack**

```json
{
  "DATABASE_URL": "${{Postgres.DATABASE_URL}}",
  "APP_ENC_KEY": "CAMBIAME-aleatoria-48-caracteres",
  "ADMIN_PASSWORD": "CAMBIAME-contrasena-fuerte",
  "ADMIN_USER": "admin",
  "STATE_SECRET": "CAMBIAME-aleatoria-48-caracteres",
  "PUBLIC_BASE_URL": "https://panel.dominio-del-cliente.com",
  "META_APP_ID": "CAMBIAME-app-id-de-la-app-compartida",
  "IG_APP_SECRET": "CAMBIAME-app-secret-de-meta",
  "WHATSAPP_APP_SECRET": "CAMBIAME-el-mismo-app-secret-de-meta",
  "WHATSAPP_VERIFY_TOKEN": "CAMBIAME-aleatoria-32-caracteres",
  "META_WA_EMBEDDED_CONFIG_ID": "CAMBIAME-config-id-del-alta-guiada",
  "META_WA_COEXISTENCE_CONFIG_ID": "CAMBIAME-config-id-de-coexistencia",
  "GOOGLE_CLIENT_ID": "CAMBIAME-o-borra-esta-linea",
  "GOOGLE_CLIENT_SECRET": "CAMBIAME-o-borra-esta-linea",
  "MCP_URL": "https://${{systemeio-mcp.RAILWAY_PUBLIC_DOMAIN}}/mcp",
  "MCP_TOKEN": "${{systemeio-mcp.INTERNAL_API_SECRET}}"
}
```

Borra las líneas que no apliquen: `PUBLIC_BASE_URL` si no tiene dominio propio (Railway
aporta el suyo), las dos de Google si no va a usar YouTube, y las dos del puente si no
despliegas el segundo servicio. Los valores de la app de Meta son los mismos para toda la
flota y están en el documento de arquitectura.

### Servicio **systemeio-mcp**

```json
{
  "INTERNAL_API_SECRET": "CAMBIAME-aleatoria-48-caracteres",
  "MASTER_KEY": "CAMBIAME-64-caracteres-hexadecimales",
  "SYSTEMEIO_BASE_URL": "https://systeme.io",
  "SUPABASE_URL": "CAMBIAME",
  "SUPABASE_SERVICE_ROLE_KEY": "CAMBIAME"
}
```

`INTERNAL_API_SECRET` y el `MCP_TOKEN` del otro servicio son **el mismo valor**. Por eso
el otro lado va por referencia: no se copia dos veces y no se puede desincronizar.

### Generar los secretos

```sh
# APP_ENC_KEY · ADMIN_PASSWORD · STATE_SECRET · WHATSAPP_VERIFY_TOKEN · INTERNAL_API_SECRET
openssl rand -base64 36

# MASTER_KEY — exactamente 64 caracteres hexadecimales
openssl rand -hex 32
```

Uno distinto por variable y por cliente. **Nunca reutilices `APP_ENC_KEY` ni
`ADMIN_PASSWORD` entre instancias:** la firma de las sesiones deriva de las dos, así que
repetirlas haría válida en una instancia la cookie de otra.

### Lo que rompe estas plantillas sin avisar

- **Los nombres de servicio.** `${{Postgres.…}}` y `${{systemeio-mcp.…}}` dependen de cómo
  se llamen los servicios en ese proyecto. Si Railway los nombra distinto, o los renombras
  después, la referencia apunta a la nada y nadie te lo dice.
- **`SYSTEMEIO_BASE_URL`.** Si la borras de la plantilla, el MCP cae a su valor por
  defecto, que es el panel del operador.

---

## 4 · Resumen para copiar en el alta

**PostgreSQL** → complemento de Railway, y crear `DATABASE_URL` como referencia.

**Business Stack** — por cliente: `APP_ENC_KEY`, `ADMIN_PASSWORD`, `STATE_SECRET`,
`WHATSAPP_VERIFY_TOKEN`, `DATABASE_URL`. Compartidas: `META_APP_ID`, `IG_APP_SECRET`,
`WHATSAPP_APP_SECRET`, los dos identificadores de configuración, y las de Google si va a
usar YouTube. Y `PUBLIC_BASE_URL` si tiene dominio propio.

**systemeio-mcp** (si lo despliegas) — por cliente: `INTERNAL_API_SECRET`, `MASTER_KEY`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Y **siempre**
`SYSTEMEIO_BASE_URL=https://systeme.io`.

**De vuelta en Business Stack**: `MCP_URL` y `MCP_TOKEN`, por referencia al otro servicio.

---

## 5 · Comprobar que quedó bien

```sh
curl https://<dominio-del-cliente>/health          # {"ok":true}
```

Y en el registro de arranque del despliegue **no** deben aparecer estas dos líneas:

```
[db] DATABASE_URL no definida — almacén en memoria (no persiste).
[seguridad] STATE_SECRET sin definir y admin.pass vacio — usando fallback hardcoded.
```

Si desplegaste el MCP, Conexiones no debe decir que falta la dirección del puente.
