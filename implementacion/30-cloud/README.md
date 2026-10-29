# 30 — Cloud

## Qué cubre este capítulo

Cloud replica la memoria de proyectos concretos en un servidor compartido con Postgres. El almacén SQLite local sigue siendo la fuente de verdad; la nube es una réplica opt-in por proyecto. F9 se entrega en cuatro porciones; este capítulo se amplía en cada una:

| Porción | Spec | Contenido | Estado |
|---|---|---|---|
| F9.1 | 0.24.0 | Sincronización **por chunks** con la nube: servidor `/sync/*`, `odin cloud …`, `odin sync --cloud`, estado del destino | hecha |
| F9.2 | — | Sincronización por mutaciones (`/sync/mutations/*`), autosync, relleno del diario al inscribir, materialización de chunks en `cloud_mutations` | pendiente |
| F9.3 | — | Panel web (SSR + htmx + Pico), sesión HMAC, administración | pendiente |
| F9.4 | — | Pantallas de la TUI, reparaciones del diario, `rescue-ownership` sobre proyectos inscritos, Docker | pendiente |

Fuera de alcance de F9.1 y sin fecha: principales y tokens gestionados, autoridad de sesión, reclamos de pares de prompts, atestación de origen de prompts y las órdenes `cloud upgrade|repair|bootstrap|attest-prompt-source`.

## Documentos

| Documento | Contenido |
|---|---|
| [`01-cliente.md`](01-cliente.md) | Configuración del cliente, `odin cloud …`, `odin sync --cloud`, comprobaciones previas, estado del destino, transporte remoto, guía de recuperación |
| [`02-servidor.md`](02-servidor.md) | Servidor HTTP, almacén Postgres (DDL), autenticación, lista de proyectos, pausa y auditoría, `odin cloud serve` |
| [`03-formato-de-chunks.md`](03-formato-de-chunks.md) | Sobre comprimido, forma canónica del chunk y de las cargas de mutación, validación de referencias |

## Módulos

| Módulo | Documento |
|---|---|
| `src/cloud/constants.js`, `config.js`, `client.js`, `guidance.js`, `remote.js` | 01 |
| `src/cli/commands/cloud.js`, `src/cli/commands/sync.js` (rama `--cloud`) | 01 |
| `src/store/enrollment.js`, `src/store/sync-state.js` (ciclo de vida), `src/store/journal.js` | 01 |
| `src/cloud/server/{config,db,store,validate,server,index}.js` | 02 |
| `src/cloud/codec.js` | 03 |

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
| `ODIN_CLOUD_SYNC` | cliente | Verdadero (`1`, `true`, `yes`, `on`) equivale a `--cloud` en `odin sync` |
| `ODIN_DATABASE_URL` | servidor | DSN de Postgres (por defecto `postgres://odin:odin_dev@localhost:5433/odin_cloud?sslmode=disable`) |
| `ODIN_PORT` | servidor | Puerto (por defecto 8080). El mismo nombre fija el puerto del servidor local (7438) y el que sondea `cloud status` |
| `ODIN_CLOUD_HOST` | servidor | Dirección de escucha (por defecto `127.0.0.1`) |
| `ODIN_CLOUD_MAX_PUSH_BYTES` | servidor | Tope de una subida (por defecto 8388608); valores no positivos o no numéricos usan el defecto |
| `ODIN_CLOUD_ALLOWED_PROJECTS` | servidor | Lista separada por comas; `*` admite todos. Obligatoria |
| `ODIN_CLOUD_INSECURE_NO_AUTH` | servidor | `1` desactiva la autenticación (solo desarrollo); incompatible con `ODIN_CLOUD_TOKEN` y con `ODIN_CLOUD_ADMIN` |
| `ODIN_CLOUD_ADMIN` | servidor | Segundo secreto, de administración; también autentica en `/sync/*` |
| `ODIN_JWT_SECRET` | servidor | Obligatorio y distinto del valor de desarrollo cuando hay token; firmará las sesiones del panel (F9.3) |
| `ODIN_CLOUD_TOKEN_PEPPER` | servidor | Reservada para los tokens gestionados (sin efecto en F9.1) |

## Estrategia de pruebas

- Pruebas de producto en `test/unit/cloud/` (`codec`, `config`, `client`, `remote`, `server`, `cli`, `e2e`) y `test/unit/store/sync-lifecycle.test.js`. Las que necesitan servidor arrancan un Postgres real con `test/unit/cloud/pg-helper.js` (no es una prueba): `startPostgres()` devuelve `createDatabase()` (DSN de una base nueva) y `stop()`.
- `e2e.test.js` conecta dos almacenes SQLite a un servidor real y comprueba el intercambio completo, el bloqueo por proyecto sin inscribir, por lista permitida y por pausa.
- Todas las pruebas de red usan `http://127.0.0.1`: sin token (modo inseguro) porque el cliente solo envía tokens por HTTPS.
