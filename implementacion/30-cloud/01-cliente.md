# 30/01 — Cliente de la nube

Módulos: `src/cloud/{constants,config,client,guidance,remote}.js`, `src/cli/commands/cloud.js`, rama `--cloud` de `src/cli/commands/sync.js`, `src/store/enrollment.js`, ciclo de vida en `src/store/sync-state.js` y diario real en `src/store/journal.js`.

## Configuración (`src/cloud/config.js`)

Archivo `<datos>/cloud.json` (permisos `0600`, carpeta `0755`): `{ "server_url": "…", "token": "…" }`.

- `loadCloudConfig(dataDir)`: sin archivo devuelve `{ server_url: '', token: '' }`; un valor que no sea cadena se toma vacío; JSON roto lanza.
- `saveCloudConfig` crea la carpeta, escribe con sangría de dos espacios y fuerza `chmod 0600`. `clearCloudConfig` guarda ambos campos vacíos (el archivo permanece).
- `ODIN_CLOUD_SERVER` (recortada, si no está vacía) sustituye a `server_url` (`applyServerOverride`).
- `effectiveToken(dataDir, env)`: `ODIN_CLOUD_TOKEN` recortada → origen `env`; si no, el de `cloud.json` → `file`; si no (o el archivo está roto) → `none`.
- `resolveCloudRuntimeConfig` = URL efectiva + token efectivo.
- `validateServerUrl(raw)`: recorta; vacía → `server URL is required`; no analizable → `parse "<url>": invalid URI for request`; esquema distinto de `http`/`https` → `scheme must be http or https`; sin host → `host is required`; con `?` → `query is not allowed`; con `#` → `fragment is not allowed`. Devuelve la URL recortada tal cual.

`src/cloud/constants.js` reúne los motivos de bloqueo (`blocked_unenrolled`, `non_enrolled_pending_mutations`, `paused`, `auth_required`, `policy_forbidden`, `transport_failed`, `cloud_config_error`), las clases y códigos de error accionables (`upgrade_blocked_project_required`, `upgrade_repairable_payload_invalid`, `upgrade_repairable_payload_too_large`, `upgrade_repairable_chunk_conflict`, `upgrade_blocked_internal`; clases `repairable`, `blocked`, `policy`), el tipo de contenido del sobre (`application/vnd.odin.sync+gzip`, versión `1`) y el tope descomprimido (8 MiB).

## Inscripción (`src/store/enrollment.js`)

- `enrollProject(store, project)`: nombre canónico no vacío; `inbox` está reservado (`project name "inbox" is reserved for the cloud inbox and cannot be enrolled`). `INSERT OR IGNORE` en `sync_enrolled_projects`; si la fila es nueva, llama a `backfillProjectSyncMutations` en la misma transacción de escritura (rellena el diario con el estado previo del proyecto). Idempotente.
- `unenrollProject`: borra la fila; conserva datos locales, remotos y filas pendientes del diario. Idempotente.
- `hasPendingSyncMutationsForProject(store, project)`: ¿hay filas del destino `cloud` con ese proyecto, sin acuse y con disposición `pending`?

## Diario local (`src/store/journal.js`)

`journalMutation(db, { entity, entityKey, op, project, sessionId, payload, source })` deja de ser un gancho que falla y escribe de verdad:

1. Una sesión sin clave lanza `session_id_required`.
2. `payload` puede ser una función (solo se evalúa aquí). `source` vacío = `local`.
3. Una sesión local con `upsert` y sin directorio no viaja (se omite).
4. Un `upsert` de sesión u observación desactiva la lápida (`sync_delete_tombstones.active = 0`).
5. Proyecto dueño = proyecto normalizado o, si falta, el de `sessionId`. Una mutación **local** con dueño no inscrito se omite (la escritura local sigue siendo duradera); sin dueño siempre se registra.
6. Un `upsert` local de sesión sustituye a otro pendiente idéntico (mismo destino, entidad, clave, operación, origen y proyecto).
7. Inserta la fila en `sync_mutations` con `target_key = 'cloud'`, el proyecto en su columna, `occurred_at = now()` y `payload = JSON.stringify(carga)`; deja `sync_state` de `cloud` en `pending` con `last_enqueued_seq`; con dueño, hace lo mismo con `cloud:<proyecto>`.

`backfillProjectSyncMutations` rellena el diario con el estado previo del proyecto al inscribirlo (ver `04-autosync.md`).

## Ciclo de vida del destino (`src/store/sync-state.js`)

Destinos: `cloud` (global), `cloud:<proyecto>` y el reservado `cloud:inbox` (nunca cambia de estado). Todas las funciones crean la fila en `idle` si falta y actualizan en una transacción de escritura:

| Función | Efecto |
|---|---|
| `markSyncBlocked(store, key, reason, message)` | `degraded`, fallos 0, sin reintento, `reason_code`, `reason_message` y `last_error` = mensaje |
| `markSyncPaused` / `markSyncAuthRequired` | `markSyncBlocked` con `paused` / `auth_required` |
| `markSyncFailure(store, key, message, backoffUntil, reason = 'transport_failed')` | `degraded`, fallos + 1, `backoff_until` en RFC 3339 sin fracción; un motivo vacío usa `transport_failed` |
| `markSyncHealthy` | `healthy`, fallos 0, sin motivo ni error, `last_success_at = datetime('now')` |
| `markSyncPending` | `pending`, fallos 0, sin motivo ni error; conserva `last_success_at` |
| `cloudSyncSummary(store)` | Sobre los destinos `cloud:%` salvo `cloud:inbox`: `last_success_at` máximo, `last_error` y `reason_code` del más reciente con error, y `pending_mutations` = filas pendientes de proyectos inscritos cuyo destino sea `cloud:%` |

## Comprobaciones previas y fallos (`src/cloud/client.js`)

`preflightCloudSync(store, config, project, mutateState, env)` devuelve `{ server_url, token }` o lanza, y con `mutateState` deja el motivo en el estado del destino (`cloud:<proyecto>`, o `cloud` sin proyecto):

1. Configuración ilegible → `cloud sync config error: <detalle>` (no marca estado).
2. Sin servidor → `cloud sync cloud_config_error: cloud server is missing: configure server URL with \`odin cloud config --server <url>\``.
3. URL inválida → `cloud sync cloud_config_error: invalid cloud runtime server URL: <detalle>`.
4. Proyecto no inscrito → `cloud sync blocked_unenrolled: project "<p>" is not enrolled for cloud sync`.

(La comprobación de mutaciones heredadas que exige reparación llega con las órdenes `cloud upgrade`.)

`markCloudSyncFailure(store, targetKey, err)`: el mensaje es el del error más la guía; `err.isAuthFailure` → `markSyncAuthRequired`; `err.isPolicyFailure` → `markSyncBlocked(policy_forbidden)`; cualquier otro → `markSyncFailure` con reintento a 30 s.

## Guía de recuperación (`src/cloud/guidance.js`)

`appendGuidance(message, project, err)` conserva el mensaje y añade, una sola vez:

- Para una denegación de política (`err.isPolicyFailure`): `Cloud sync is blocked by server policy.` + `The server denied access to project "<p>". Ask the server administrator to check ODIN_CLOUD_ALLOWED_PROJECTS. If this client uses a managed principal, its project grant may also need checking. The client does not expose server allowlist contents.`
- Para un fallo reparable (`err.isRepairable`, o un mensaje que contenga el encabezado, `canonicalize push chunk:`, `canonicalize cloud chunk:`, `directory is required`, `legacy mutation`+`payload`, o `payload`/`upsert` junto a palabras de nube, sincronización, mutación o canonicalización): `Known repairable cloud sync failure detected.` seguido de los cuatro comandos `odin cloud upgrade doctor|repair --dry-run|repair --apply --project <p>` y `odin sync --cloud --project <p>`. Esas órdenes llegan en una porción posterior.

`projectFromTargetKey('cloud:<p>')` devuelve el proyecto canónico (`''` para otros destinos).

## Transporte remoto (`src/cloud/remote.js`)

`new RemoteTransport(baseUrl, token, project, { fetch })` cumple el contrato asíncrono del `Syncer` (`readManifest`, `writeManifest`, `writeChunk`, `readChunk`).

- `validateBaseUrl`: `http`/`https` con host, sin consulta ni fragmento; quita las barras finales. Un token solo se acepta con `https` (`cloud: bearer token requires an HTTPS remote URL`).
- Peticiones con `Authorization: Bearer <token>` si hay token; tiempo máximo 30 s (5 min para subir). Redirecciones manuales (máx. 5); con token solo se sigue una redirección a `https` (`cloud: bearer token redirect requires HTTPS`; `cloud: too many redirects`).
- `readManifest`: `GET /sync/pull?project=<p>` → `{ version, chunks }`. `writeManifest` no hace nada (lo lleva el servidor).
- `writeChunk(id, json, entry)`: canonicaliza el chunk para el proyecto (`cloud: canonicalize push chunk: …`), calcula el identificador del resultado y envía `POST /sync/push` con tipo `application/vnd.odin.sync+gzip; version=1` y cuerpo gzip de `{ chunk_id, created_by, client_created_at, project, data }`.
- `readChunk(id)`: `GET /sync/pull/<id>?project=<p>` con `Accept` del sobre comprimido. 404 → `ChunkNotFoundError`; cuerpo vacío → `cloud: empty chunk payload`; si la respuesta es el sobre, lo descomprime (tope 8 MiB).
- Errores de estado: `HttpStatusError` con `statusCode`, `errorClass`, `errorCode`, `body` y `message = "cloud: <operación>: status <n>: <detalle>"`. Si el cuerpo es JSON con `error_class`, `error_code` y `error`, se usan; si no, el texto recortado. `isAuthFailure` = 401, `isPolicyFailure` = 403, `isRepairable` = clase `repairable`.

## `odin cloud` (`src/cli/commands/cloud.js`)

Sin subcomando, o uno desconocido, escribe en el error estándar (sin prefijo) `usage: odin cloud <subcommand> [options]` y `supported subcommands: status, enroll, unenroll, config, serve, upgrade, repair, bootstrap, attest-prompt-source` (desconocido: antes `unknown cloud command: <x>`) y sale con 1. `--help`, `-h` y `help` lo imprimen en la salida estándar y salen con 0.

- **`config --server <url> | --clear`**: `--clear` (única opción) vacía el archivo e imprime `✓ Persisted cloud server URL and token cleared`, más una nota por cada variable `ODIN_CLOUD_SERVER` / `ODIN_CLOUD_TOKEN` activa (`Note: <VAR> remains active and overrides the cleared persisted server URL.` / `… token.`). `--server`: URL vacía → `error: server URL is required`; inválida → `error: invalid server URL: <detalle>`; si no, guarda y escribe `✓ Cloud server set to <url>`. Cualquier otra forma: `usage: odin cloud config --server <url> | --clear`.
- **`enroll|unenroll <proyecto> [--literal-project]`**: el proyecto se decodifica como ruta URL (salvo `--literal-project`; `%zz` → `invalid cloud project URL encoding "%zz": invalid URL escape "%zz"`) y se normaliza (el aviso de normalización va al error estándar). Admite `--` y rechaza opciones desconocidas (`unknown option: --x`) y más de un proyecto (`cloud enroll requires exactly one project`). Salidas: `✓ Project "<p>" enrolled for cloud sync`; `✓ Project "<p>" unenrolled from future cloud sync` + `Local data, remote data, and pending journal rows were preserved.` + `Note: an already in-flight push is not cancelled.`
- **`status [--project <p>]`**: ver el orden de líneas en las pruebas (`test/unit/cloud/cli.test.js`): `Cloud status: configured (target=cloud)`, `Server: …`, `Server source: ODIN_CLOUD_SERVER | cloud.json`, `Auth status: …`, `Sync readiness: …`, avisos de modo inseguro o de token ausente, `Project enrollment: …`, `Local daemon: …` (sonda `GET http://127.0.0.1:<ODIN_PORT|7438>/health`, 1 s; inyectable con `Cli.probeDaemon`) y `Sync diagnostic: …` (último error del destino del proyecto, o de los destinos por proyecto, o el motivo `non_enrolled_pending_mutations` del global). Sin servidor: `Cloud status: not configured (no effective server URL)` y `Sync readiness: blocked (no effective server URL)`. Los errores de uso salen con `usage: odin cloud status [--project <name>]` + `error: …`.
- **`serve`** y **`repair`**: ver `02-servidor.md`.
- **`bootstrap admin|recover-token`**: ver `05-identidad-y-procedencia.md`.
- **`upgrade …`** y **`attest-prompt-source`**: ver `07-actualizacion-y-atestacion.md`.

## `odin sync --cloud`

Con `--cloud` o `ODIN_CLOUD_SYNC` verdadero, `sync` exige un `--project` explícito y no vacío (`cloud sync requires an explicit non-empty --project value`) y rechaza `--all` (`cloud sync requires a single explicit --project scope; --all is not supported`). El proyecto se decodifica como en `enroll` (`cloud sync project: <detalle>`). Flujo: abrir el almacén → resolver el proyecto → `preflightCloudSync(…, mutateState = !--status)` → `RemoteTransport` → `Syncer` con `targetKey = cloud:<proyecto>`.

- **`--status`**: `Cloud sync status (project="<p>"):` con `Local chunks`, `Remote chunks` y `Pending import` (mismos márgenes que el estado local). Un fallo no marca estado.
- **`--import`**: imprime líneas `Cloud import progress: local=<n> remote=<n> pending=<n> progress=<n>%` (como mucho unas diez: la primera, cada `ceil(pendientes/10)` chunks y la final; con 0 pendientes salen dos iguales) y, al terminar, `Imported <n> new remote chunk(s) for project "<p>"` seguido de los contadores de siempre.
- **Exportar**: `Exporting memories for project "<p>" to cloud...`, sin el aviso de prompts de Git; al terminar `Cloud sync complete for project "<p>".` (sin las advertencias de Git).
- **Resultado en el estado del destino**: un fallo de importar/exportar marca el destino con `markCloudSyncFailure` y sale con `odin: <mensaje + guía>`. Tras un éxito, el destino queda `pending` si hay mutaciones pendientes del proyecto o chunks por importar, y `healthy` si el estado remoto se pudo verificar y no queda nada; si no se pudo verificar, no cambia.
- `--include-prompts` sigue siendo incompatible con la nube.

## `Syncer` asíncrono

(En modo nube el `Syncer` exporta lo pendiente del diario; ver `07-actualizacion-y-atestacion.md`.)

Para admitir la red, los métodos `export`, `import`, `status` y los internos del `Syncer` son `async`, y el contrato del transporte puede devolver promesas (el transporte de archivos sigue siendo síncrono, `await` lo admite). El constructor acepta `targetKey` (por defecto el destino local de chunks) para anotar los chunks conocidos bajo `cloud:<proyecto>`. Todos los llamadores (`odin sync`, hook de `sessionStart` con importación automática, pruebas) esperan las promesas; `cmdHook` y `sessionStart` son `async`.
