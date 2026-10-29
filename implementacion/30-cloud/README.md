# 30 — Cloud

## Qué cubre este capítulo

Cloud replica la memoria de proyectos concretos en un servidor compartido con Postgres. El almacén SQLite local sigue siendo la fuente de verdad; la nube es una réplica opt-in por proyecto. F9 se entrega en cuatro porciones; este capítulo se amplía en cada una:

| Porción | Spec | Contenido | Estado |
|---|---|---|---|
| F9.1 | 0.24.0 | Sincronización **por chunks** con la nube: servidor `/sync/*`, `odin cloud …`, `odin sync --cloud`, estado del destino | hecha |
| F9.2a | 0.25.0 | Servidor de mutaciones: `/sync/mutations/push` y `/sync/mutations/pull`, materialización en las dos direcciones entre `cloud_chunks` y `cloud_mutations`, `odin cloud repair materialize-mutations` | hecha |
| F9.2b | 0.26.0 | Cliente de mutaciones: transporte, cola de salida con acuses y arriendo, relleno del diario al inscribir, autosync en `serve` y `mcp` | hecha |
| F9.2c-1 | 0.27.0 | Identidades gestionadas (personas, tokens con pimienta, permisos por proyecto), API `/admin/*`, auditoría de autenticación, procedencia de prompts (autoridad de sesión, reclamos, atestación) y su comprobación previa en el autosync, `odin cloud bootstrap` | hecha |
| F9.2c-2 | 0.29.0 | Exportación de la nube respaldada por el diario, `cloud upgrade doctor|repair|bootstrap|remirror|status|rollback`, `cloud attest-prompt-source`, Docker del servidor | hecha |
| F9.4a | 0.30.0 | Reparaciones del diario de `doctor` (campos requeridos con cuarentena, destinos ajenos, sustitución de identidad), `doctor discard-empty-prompt`, rescate de propiedad sobre proyectos inscritos | hecha |
| F9.3 | 0.28.0 | Panel web (HTML en servidor + htmx + Pico): acceso con token y sesión firmada, navegador de memoria, proyectos, contribuidores, administración, controles de sincronización, usuarios gestionados y registro de rechazos | hecha |
| F9.4 | — | Pantallas de la TUI, reparaciones del diario, `rescue-ownership` sobre proyectos inscritos, Docker | pendiente |

Pendiente tras 0.30.0: las pantallas de nube de la TUI.

## Documentos

| Documento | Contenido |
|---|---|
| [`01-cliente.md`](01-cliente.md) | Configuración del cliente, `odin cloud …`, `odin sync --cloud`, comprobaciones previas, estado del destino, transporte remoto, guía de recuperación |
| [`02-servidor.md`](02-servidor.md) | Servidor HTTP, almacén Postgres (DDL), autenticación, lista de proyectos, pausa y auditoría, `odin cloud serve` |
| [`03-formato-de-chunks.md`](03-formato-de-chunks.md) | Sobre comprimido, forma canónica del chunk y de las cargas de mutación, validación de referencias, materialización |
| [`04-autosync.md`](04-autosync.md) | Transporte de mutaciones, gestor de autosync, cola de salida, dominio de la nube al aplicar, relleno del diario |
| [`05-identidad-y-procedencia.md`](05-identidad-y-procedencia.md) | Tokens gestionados, almacén de identidades, auditoría de autenticación, API de administración, procedencia de prompts, `odin cloud bootstrap` |
| [`06-panel-web.md`](06-panel-web.md) | Modelo de lectura, sesión firmada, rutas `/dashboard/*`, paginación y formato, marcado que fijan las pruebas |
| [`07-actualizacion-y-atestacion.md`](07-actualizacion-y-atestacion.md) | Modo nube del `Syncer`, `odin cloud upgrade …`, `odin cloud attest-prompt-source`, Docker |
| [`08-reparaciones-del-diario.md`](08-reparaciones-del-diario.md) | Reparaciones del diario de `doctor`, descarte de prompt vacío, rescate de propiedad sobre inscritos |

## Módulos

| Módulo | Documento |
|---|---|
| `src/cloud/constants.js`, `config.js`, `client.js`, `guidance.js`, `remote.js` | 01 |
| `src/cli/commands/cloud.js`, `src/cli/commands/sync.js` (rama `--cloud`) | 01 |
| `src/store/enrollment.js`, `src/store/sync-state.js` (ciclo de vida), `src/store/journal.js` | 01 |
| `src/cloud/server/{config,db,store,validate,server,index}.js` | 02 |
| `src/cloud/codec.js`, `src/cloud/materialize.js` | 03 |
| `src/cloud/server/mutations.js` | 02 |
| `src/cloud/autosync.js`, `src/cli/autosync.js`, `src/store/sync-queue.js` | 04 |
| `src/cloud/server/{tokens,identity,admin,provenance,respond}.js`, `src/cli/commands/cloud-bootstrap.js` | 05 |
| `src/cloud/server/{dashboard-model,dashboard-store}.js`, `src/cloud/dashboard/{html,format,views,session,routes}.js`, `static/styles.css` | 06 |
| `src/store/{journal-repair,session-identity-repair,prompt-discard}.js`, `src/cli/commands/doctor-discard.js`, `src/store/project-rescue.js` (diario) | 08 |
| `src/store/{cloud-upgrade,prompt-source}.js`, `src/cli/commands/{cloud-upgrade,cloud-attest}.js`, `src/sync/syncer.js` (modo nube), `docker/cloud/Dockerfile`, `docker-compose.cloud.yml` | 07 |

## Dependencias nuevas

| Paquete | Tipo | Versión | Uso |
|---|---|---|---|
| `pg` | ejecución | 8.23.1 | Cliente Postgres del servidor de la nube. Solo se carga con `odin cloud serve` (importación dinámica) |
| `embedded-postgres` | desarrollo | 18.4.0-beta.17 | Postgres real y desechable para las pruebas |

`embedded-postgres` descarga un binario por plataforma (`@embedded-postgres/<plataforma>`); su `postinstall` crea enlaces simbólicos (`node scripts/hydrate-symlinks.js` dentro del paquete de la plataforma). Si npm no lo ejecuta (política `allowScripts`), hay que lanzarlo una vez a mano. Alternativa sin binario: apuntar `ODIN_TEST_DATABASE_URL` a un Postgres existente (el usuario debe poder crear bases de datos); las pruebas crean y borran una base por prueba.

## Variables de entorno

| Variable | Lado | Efecto |
|---|---|---|
| `ODIN_CLOUD_SERVER` | cliente | URL del servidor; sustituye a la guardada en `cloud.json` |
| `ODIN_CLOUD_TOKEN` | cliente / servidor | Cliente: token Bearer que se envía (sustituye al guardado). Servidor: token que deben presentar los clientes |
| `ODIN_CLOUD_AUTOSYNC` | cliente | `1` activa el autosync en `odin serve` y `odin mcp` (necesita servidor y token) |
| `ODIN_CLOUD_SYNC` | cliente | Verdadero (`1`, `true`, `yes`, `on`) equivale a `--cloud` en `odin sync` |
| `ODIN_DATABASE_URL` | servidor | DSN de Postgres (por defecto `postgres://odin:odin_dev@localhost:5433/odin_cloud?sslmode=disable`) |
| `ODIN_PORT` | servidor | Puerto (por defecto 8080). El mismo nombre fija el puerto del servidor local (7438) y el que sondea `cloud status` |
| `ODIN_CLOUD_HOST` | servidor | Dirección de escucha (por defecto `127.0.0.1`) |
| `ODIN_CLOUD_MAX_PUSH_BYTES` | servidor | Tope de una subida (por defecto 8388608); valores no positivos o no numéricos usan el defecto |
| `ODIN_CLOUD_ALLOWED_PROJECTS` | servidor | Lista separada por comas; `*` admite todos. Obligatoria |
| `ODIN_CLOUD_INSECURE_NO_AUTH` | servidor | `1` desactiva la autenticación (solo desarrollo); incompatible con `ODIN_CLOUD_TOKEN` y con `ODIN_CLOUD_ADMIN` |
| `ODIN_CLOUD_ADMIN` | servidor | Segundo secreto, de administración; también autentica en `/sync/*` |
| `ODIN_JWT_SECRET` | servidor | Obligatorio y distinto del valor de desarrollo cuando hay token; firma las sesiones del panel (ver 06) |
| `ODIN_CLOUD_TOKEN_PEPPER` | servidor / bootstrap | Pimienta (≥ 32 bytes) de los tokens gestionados; ver 05 |

## Estrategia de pruebas

- Pruebas de producto en `test/unit/cloud/` (`codec`, `materialize`, `config`, `client`, `remote`, `server`, `cli`, `e2e`, `autosync`, `autosync.e2e`, `autosync-cli`) y `test/unit/store/sync-queue.test.js` y `test/unit/store/sync-lifecycle.test.js`. Las que necesitan servidor arrancan un Postgres real con `test/unit/cloud/pg-helper.js` (no es una prueba): `startPostgres()` devuelve `createDatabase()` (DSN de una base nueva) y `stop()`.
- `e2e.test.js` conecta dos almacenes SQLite a un servidor real y comprueba el intercambio completo, el bloqueo por proyecto sin inscribir, por lista permitida y por pausa.
- Todas las pruebas de red usan `http://127.0.0.1`: sin token (modo inseguro) porque el cliente solo envía tokens por HTTPS.
