# MCP y systeme.io — guía para sesiones nuevas de desarrollo

`MCP.md` es la guía que lee la IA conectada (herramienta `guia`). Este fichero es para
**quien desarrolla**: qué hay, en qué estado está y qué falta. Viaja con el repo de cliente
y con staging. Actualízalo al cerrar cada fase.

## 1 · Qué es el MCP

- Servidor escrito a mano en `src/mcp-server.ts`. Las herramientas se definen en
  `HERRAMIENTAS`, repartidas en `src/mcp-herr-*.ts`. OAuth en `src/mcp-oauth.ts`.
- Cada herramienta llama a una ruta `/admin/api/…` con `app.inject()`. Pasa por `guard()`,
  `ROUTE_VIEW` y el aislamiento por negocio. **Una ruta sin `ROUTE_VIEW` tampoco existe
  para el MCP.**
- Arneses: `scripts/test-mcp.mjs`, `test-mcp-oauth.mjs`, `test-mcp-llamadas.mjs`,
  `test-mcp-cobertura.mjs`, `test-mcp-catalogo-seguridad.mjs`.

## 2 · systeme.io: tres vías

| Vía | Fichero | Cuándo |
|---|---|---|
| **API oficial** (clave) | `systemeio-public-api.ts` | **Por defecto.** Contactos, etiquetas, newsletters, correos de automatización, ventas por webhook |
| Sesión del panel (cookie) | `systemeio-internal-api.ts` | Solo lo que la API no da: copia de ventas (hasta el corte de F8), destinatarios y clics por enlace |
| Puente de editor | `mcp-bridge.ts` | Páginas y plantillas. Se retira en F9 |

- El catálogo y la orquestación están en `systemeio-catalogo.ts` y en
  `systemeio-orquestacion.ts`.
- Las cuentas están en `systemeio-accounts.ts`.
- El receptor de avisos está en `systemeio-webhook.ts`.

**Cuentas del negocio Ingeniero Binario:**

| Cuenta | Clave de API | Estado |
|---|---|---|
| a8f6bf4b | sí | En uso |
| 5d5bda96 | sí | En uso |
| 403a3e5d (leadmatch-lab) | no (da 409) | Fuera de alcance |

**Toda prueba contra systeme.io es real.** No publiques páginas ni mandes correos sin la
confirmación del owner.

## 3 · Migración a la API oficial — estado (30-oct-2026)

El plan completo está en `docs/SYSTEME-API-OFICIAL-vs-MCP.md`, en el repo principal.

| Fase | Estado |
|---|---|
| F1–F6 | Desplegadas |
| F7 · correo | Tramos 1 y 2 desplegados (CORREO-API-2…5)<br>Pendiente: reglas por paso, capturas a los 5 anchos y paridad cookie↔API con newsletters reales |
| F2 · ventas por webhook | Desplegada (VENTAS-WEBHOOK-1) |
| F8 · corte de ventas | **Desplegada el 30-oct** (VENTAS-CORTE-1, `0d53082a`), por orden del owner sin esperar al 12-nov.<br>El aviso escribe en `app_sio_sales` con `origen='webhook'`; lo copiado antes queda `origen='cookie'`.<br>`VENTAS_POR_SONDEO=false` en `sio-ventas.ts`: el sondeo por sesión ya no lee ventas. |
| F9 · puente del editor | **Desplegada el 30-oct** (PUENTE-EDITOR-1, `598633c4`): ajuste por negocio `systemeio.puenteEditor="0"` lo apaga y explica por qué; sin valor sigue encendido. |

**Por qué el puente NO se retira:** el esquema de páginas de la API oficial
(`POST /api/page-editor/page-schema`) solo admite bloques fijos (Headline, Text, BulletList,
Faq, Image, Button, Logo, Menu): no hay HTML libre. Publicar páginas propias sigue
necesitando el puente, y el puente entra con el autologin. Ingeniero Binario lo usa.

El worker `startMcpBridgeWorker` arranca siempre: procesa `contact-upsert` por la API
oficial.

**Limpieza hecha (SIO-LIMPIEZA-1, 30-oct-2026):**

- `method` es siempre `apikey`. Al leer las cuentas guardadas se descarta `sessionCookie`,
  y el endpoint `connect-cookie` ya no existe.
- `systemeio-internal-api.ts` está borrado, y con él `validateCookie`,
  `siMailingRecipients*` y `getMailingClicksInternal`. También el verificador
  `check-simetria-correo`.
- Se mantienen `sandboxEmail` y `sandboxPass`, porque el puente entra con ellos para
  publicar páginas. `recJobs` también se mantiene, porque pagina destinatarios solo por el
  puente.
- El catálogo de correos ya no trae agregados internos (`aggregates: false`).

**Arneses de la migración**, en `test/`. Los de la carpeta `test/` no están en `npm test`:
lánzalos a mano.

- `sio-ventas-webhook`: necesita `PG_URL` de un postgres:16 y un `TEST_PORT` propio.
- `sio-paridad-correo`.
- `sio-credenciales`.

## 4 · Despliegue (tres destinos, siempre los tres)

Antes de nada, comprueba que pasan `npx tsc --noEmit`, `npm run build`,
`npm run check-panel` y el arnés de la zona.

1. **Producción.** Ejecuta
   `git fetch && git rebase origin/main && git push origin HEAD:main`.
   Hecho cuando el `commit` de `/admin/api/version` en la instancia de producción (la
   URL está en el `CLAUDE.md` del repo principal) es tu SHA.
2. **Cliente.** Ejecuta
   `node scripts/sincronizar-repo-cliente.mjs --destino ../business-stack-customers --aplicar`.
   Luego, en `business-stack-customers`: `build`, `git add -A`, el commit
   «Sincronizado desde digital-business-stack@<sha>» y `git push origin HEAD:main`.
   Hecho cuando lo sirve
   `https://business-stack-customers-development.up.railway.app/admin/api/version`.
3. **Staging.** En customers, ejecuta
   `git push staging origin/main:refs/heads/main`.
   Hecho cuando lo sirve `https://staging.ingenierobinario.com/admin/api/version`.

Sube de uno en uno y espera a que el anterior sirva el SHA. «Desplegado» solo con los tres
SHA confirmados.

**Reglas de commit:**

- `git add` con rutas explícitas en este repo.
- Ningún commit menciona a Claude, ni con `Co-Authored-By`.
