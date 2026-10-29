# 30/02 — Servidor de la nube

Módulos: `src/cloud/server/{config,db,store,validate,mutations,server,index}.js` y la orden `odin cloud serve` (`src/cli/commands/cloud.js`).

## Arranque (`odin cloud serve`)

1. `validateCloudServeAuthConfig(env, warn)` (reglas abajo); un fallo sale como `odin: <mensaje>`.
2. Importa dinámicamente el servidor (así `pg` solo se carga aquí), abre el pool (`pg.Pool`, máx. 10 conexiones; los errores de clientes ociosos se ignoran) y ejecuta `migrate()`. Si falla, cierra y sale con `odin: <error>`. Después aplica `backfillMutationChunks(proyecto, true)` a cada proyecto de la lista (nombres canónicos); si hubo candidatos o chunks insertados escribe en el error estándar `odin cloud repair materialize-mutations: project=<p> candidates=<n> already_materialized=<n> chunks_planned=<n> chunks_inserted=<n>`; un fallo sale como `odin: cloud repair materialize-mutations for project: <detalle>`.
3. Imprime `Starting odin cloud server on port <n>` y escucha en `ODIN_CLOUD_HOST:ODIN_PORT`. En modo inseguro ignora token y administración.
4. Espera `SIGINT`/`SIGTERM` (o `Cli.cloudServe.signal`), cierra el servidor y el pool y sale con 0. Ganchos de prueba en `Cli.cloudServe`: `port`, `signal`, `ready({ server, address })`, `log`, `processRef`.

### Reglas de autenticación y lista (`validateCloudServeAuthConfig`)

En este orden:

1. `ODIN_CLOUD_INSECURE_NO_AUTH` verdadero con `ODIN_CLOUD_TOKEN` → `conflicting cloud auth configuration: ODIN_CLOUD_INSECURE_NO_AUTH=1 cannot be used together with ODIN_CLOUD_TOKEN`.
2. Token **y** lista no vacía: exige `ODIN_JWT_SECRET` explícito (`authenticated cloud serve requires explicit ODIN_JWT_SECRET (non-default); refusing implicit default secret`) distinto del de desarrollo `odin-dev-jwt-secret-for-local-smoke-1234` (`authenticated cloud serve requires a non-default ODIN_JWT_SECRET; refusing development default`). Válido.
3. Modo inseguro: lista vacía → `cloud project allowlist is required even in insecure mode: set ODIN_CLOUD_ALLOWED_PROJECTS to one or more project names`; con `ODIN_CLOUD_ADMIN` → `ODIN_CLOUD_ADMIN is not supported when ODIN_CLOUD_INSECURE_NO_AUTH=1; remove ODIN_CLOUD_ADMIN or enable authenticated mode`; si no, avisa `warning: ODIN_CLOUD_INSECURE_NO_AUTH=1 disables cloud API authentication; do not use in production`. Válido.
4. Sin token → `cloud auth token is required: set ODIN_CLOUD_TOKEN (or ODIN_CLOUD_INSECURE_NO_AUTH=1 for local insecure development)`.
5. Token sin lista → `cloud project allowlist is required: set ODIN_CLOUD_ALLOWED_PROJECTS to one or more project names`.

`cloudServeConfigFromEnv` lee las variables del capítulo (todo recortado; `ODIN_PORT` y `ODIN_CLOUD_MAX_PUSH_BYTES` ≤ 0 o no enteros usan el defecto; la lista se separa por comas sin vacíos ni repetidos; el modo inseguro solo cuenta si no hay token).

## Rutas

Todas las respuestas JSON se escriben con `sendJson` (`<`, `>`, `&` escapados, salto de línea final). Las de objetos libres (`/health`, errores, 409) emiten las **claves en orden alfabético**; el manifiesto sale en el orden de su estructura. Rutas desconocidas: 404 `404 page not found`; método no admitido: 405 `Method Not Allowed` con `Allow` (`GET` implica `HEAD`).

| Ruta | Auth | Respuesta |
|---|---|---|
| `GET /health` | no | `{"service":"odin-cloud","status":"ok"}` |
| `GET /sync/pull?project=P` | sí | Manifiesto v2 del proyecto |
| `GET /sync/pull/{chunkID}?project=P` | sí | Carga del chunk |
| `POST /sync/push` | sí | `{"chunk_id":"…","status":"ok"}` |
| `POST /sync/mutations/push` | sí | `{"accepted_seqs":[…],"project":"…","project_path":"","project_source":"request_body"}` |
| `GET /sync/mutations/pull` | sí | Página del diario de mutaciones |
| `/admin/*` | administrador gestionado | Usuarios, tokens y permisos (ver 05) |
| `/dashboard/*` | sesión del panel | Panel web (ver 06) |
| `POST /sync/session-authorities`, `/sync/prompt-pair-claims`, `/sync/prompt-source-attestations[/verify]` | sí | Procedencia de prompts (ver 05) |

### Autenticación

Sin token configurado no se pide. Con token: cabecera `Authorization` recortada; vacía → 401 `unauthorized: missing authorization header`; no son exactamente dos campos separados por espacios en blanco o el esquema no es `bearer` (sin distinguir mayúsculas) → 401 `unauthorized: authorization must use Bearer token`; secreto distinto del token y del de administración → si hay pimienta se busca como token gestionado (ver 05); si no, 401 `unauthorized: unknown token`. Respuesta de texto plano. La comparación es en tiempo constante (SHA-256 de ambos y `timingSafeEqual`; un secreto vacío nunca coincide).

### Proyecto y lista permitida

El proyecto se toma de `?project=` (en la subida, antes del campo `project` del cuerpo y, si falta, de la consulta), se recorta y se normaliza (canónico). Vacío → 400 `{error_class:"blocked", error_code:"upgrade_blocked_project_required", error:"project is required"}`. `ProjectAllowlist` compara por nombre canónico; `*` admite todos; una lista vacía no admite ninguno. Denegado → 403 `{error_class:"policy", error_code:"policy_forbidden", error:"forbidden: project \"<p>\" is not allowed"}` (y se registra en el log del servidor). La comprobación va **antes** de leer nada del almacén.

### Lectura

- Manifiesto: `{ "version": 2, "chunks": [ { "id", "created_by", "created_at", "sessions", "memories", "prompts" } ] }` ordenado por `created_at` del servidor y luego `chunk_id`. `created_at` es `client_created_at` (si la subida lo trajo) o la hora del servidor, en RFC 3339 con `Z` y sin fracción. Errores de almacén → 500 de texto `read manifest: <error>`.
- Chunk: `payload::text` tal como lo devuelve Postgres. Cabeceras `Cache-Control: no-store` y `Vary: Accept`. Si `Accept` pide el sobre comprimido (`acceptsCompressed`) y la carga no supera 8 MiB: tipo `application/vnd.odin.sync+gzip; version=1` y cuerpo gzip; si no, `application/json`. No existe → 404 de texto `read chunk: cloudstore: chunk not found: "<id>"`; otro error → 500 `read chunk: …`.

### Subida (`POST /sync/push`)

Tope `ODIN_CLOUD_MAX_PUSH_BYTES` (defecto 8 MiB) sobre el cuerpo recibido y, de nuevo, sobre el descomprimido. Todos los errores son JSON accionables `{error_class, error_code, error}` (claves alfabéticas). En este orden:

1. `Content-Type` con el sobre pero otra versión → 415 `repairable`/`upgrade_repairable_payload_invalid`, `unsupported push payload: unsupported compressed envelope version`.
2. Lee el cuerpo. Con el tipo del sobre —o, si no lo trae, con cuerpo que empieza por la marca gzip `1f 8b` (se anota en el log)— lo descomprime. Se analiza como `{ chunk_id, created_by, client_created_at, project, data }`; un cuerpo que no es un objeto o cuyos campos de texto no son cadenas → 400 `invalid push payload: <detalle> (content-type: "<tipo>")`. Cuerpo mayor que el tope → 413 `repairable`/`upgrade_repairable_payload_too_large` `push payload too large (max N bytes)`; descomprimido mayor → 413 `decoded push payload too large (max N bytes)`.
3. Sin `data` → 400 `data is required`. Sin proyecto → 400 `project is required` (`blocked`).
4. Proyecto no permitido → 403 (arriba).
5. **Pausa**: si `isProjectSyncEnabled(project)` es falso, anota en `cloud_sync_audit_log` (`contributor = created_by` o `unknown`, `action = chunk_push`, `outcome = rejected_project_paused`, `reason_code = sync-paused`; un fallo al anotar solo se registra en el log) y responde 409 `{error, error_class:"policy", error_code:"sync-paused", project, project_source:"request_body", project_path:""}` con `error = sync is paused for project "<p>"`. Si la consulta de control falla → 500 `blocked`/`upgrade_blocked_internal` `check project control: …`.
6. `canonicalizeForProject(JSON.stringify(data), project)` (fallo → 400 `invalid push payload: <detalle>`); después se decodifica con campos tipados (`parseTypedChunk`; fallo → 400 `invalid push payload: chunk schema: <detalle>`) y se validan las filas (`validateChunkRows`; fallo → 400 `invalid push payload: <detalle>`). Filas: sesión con `id` y (`directory` o `ownership_mode = project_owned`); observación con `sync_id`, `session_id`, `type`, `title`, `content`, `scope`; prompt con `sync_id`, `session_id`, `content` (`<entidad>[<i>].<campo> is required`).
7. Referencias de sesión (`validateChunkSessionReferences`) contra las sesiones que el servidor ya conoce del proyecto: fallo → 400 `invalid push payload: …`; fallo al leer el índice → 500 `validate push payload: …`.
8. El identificador lo calcula el servidor sobre la carga canónica (si el cliente envió otro, solo se anota en el log). `client_created_at` no vacío debe ser RFC 3339 (`client_created_at must be RFC3339`).
9. `writeChunk`: conflicto → 409 `repairable`/`upgrade_repairable_chunk_conflict` `write chunk: existing chunk "<id>" has different payload`; otro error → 500 `blocked`/`upgrade_blocked_internal` `write chunk: …`.

### Empuje de mutaciones (`POST /sync/mutations/push`)

Cuerpo JSON `{ "entries": [ { project, entity, entity_key, op, payload } ], "created_by": "…" }` (sin sobre comprimido). `payload` puede ser cualquier valor JSON; se conserva como texto. Tope de tamaño como la subida de chunks. En este orden:

1. Cuerpo mayor que el tope → 413 `upgrade_repairable_payload_too_large`. JSON ilegible, entradas que no son un arreglo de objetos, o campos de texto con otro tipo → 400 de texto `invalid request body: <detalle>`.
2. Más de 100 entradas → 400 de texto `batch too large: max 100 entries per request`. Ninguna → 400 `repairable`/`empty_batch` `mutation batch must contain at least one entry`.
3. Alguna sin proyecto → 400 `invalid_request`/`empty_project` `mutation entries must specify a project`. Los proyectos pasan a su nombre canónico.
4. Cada proyecto distinto debe estar permitido (403 como siempre, y se rechaza todo el lote).
5. **Pausa**: por cada entrada, en orden, si su proyecto está en pausa: auditoría (`contributor` = `created_by` o `unknown`, `action = mutation_push`, `entry_count` = nº de entradas del lote, `reason_code = sync-paused`) y 409 igual que el de chunks, con `project` = el proyecto de la **primera** entrada.
6. Cada entrada se valida y canonicaliza (`canonicalMutationEntry`, abajo). Las inválidas se enumeran: 400 `repairable`/`upgrade_repairable_payload_invalid`, `error: "invalid mutation payload"`, `reason_code: "validation_error"` e `invalid: [ { entity, field, index } ]` (`field` es el campo de la relación que falta o `payload`). Una relación se valida antes con `validateRelationPayload` sobre la carga tal como llegó (debe ser un objeto, no una cadena).
7. `insertMutationBatch`: todo en una transacción. Un fallo al insertar una fila → 500 de texto `insert mutations: batch_index=<i> entity=<…> entity_key=<…>` (identificadores recortados a 64 y entre comillas); otro fallo → 500 `insert mutations failed`.
8. 200 con `accepted_seqs` (un `seq` por entrada, en orden), `project` (el de la primera entrada) y los campos de procedencia.

`created_by` del chunk que se materializa: el nombre de quien autentica (`LEGACY_SYNC` con el token de sincronización, `OPERATOR` con el de administración) o `unknown` si no hay autenticación.

**`canonicalMutationEntry(entry)`** (`src/cloud/server/mutations.js`): primero `normalizeLegacyMutationPayload` y después el mismo canonicalizador de chunks, para que lo guardado coincida con lo que daría reproducir un chunk.

- Para `session`, `observation` y `prompt`: la carga recortada, si empieza por `"` se decodifica como cadena, y debe ser un objeto (`payload must be an object`). Solo en `upsert` se completan los campos **ausentes** (presentes pero mal formados siguen siendo inválidos): sesión `id` (el `sync_id` de la carga o la clave) y `directory = "."`; observación `sync_id` (la clave recortada), `session_id = legacy-<id>`, `type = legacy`, `title = <id>`, `content = <id>`, `scope = project`; prompt `sync_id`, `session_id = legacy-<id>`, `content = <id>`, `project`. `<id>` es el `sync_id` de la carga (recortado, si no está vacío) o la clave. Se reserializa con `canonicalJson`.
- Otras entidades: la carga recortada tal cual.
- Se envuelve como `{ mutations: [ { project, entity, entity_key, op, payload } ] }`, se canonicaliza y se devuelve la única mutación resultante.

### Lectura de mutaciones (`GET /sync/mutations/pull`)

Parámetros: `since_seq` (entero; ausente o inválido = 0) y `limit` (entero positivo; ausente o inválido = 100; máximo 100). Filtra por los proyectos de la lista permitida: con `*` no hay filtro; con una lista, solo esos; con una lista vacía, nada. Respuesta: `{ has_more, latest_seq, mutations, project, project_path, project_source }`, donde `project` es el primer proyecto (ordenado) de la lista, o vacío si se admiten todos o ninguno, y cada mutación es `{ seq, project, entity, entity_key, op, payload, occurred_at }` (en ese orden; `payload` es el JSON guardado, `occurred_at` RFC 3339 con `Z`). `latest_seq` es el `seq` de la última devuelta (0 si no hay).

## Almacén (`src/cloud/server/store.js`, `db.js`)

`Database` envuelve el pool: `query(text, params)` → filas, `transaction(fn)` (BEGIN/COMMIT/ROLLBACK) y `close()`.

DDL de `migrate()` (idempotente, en este orden):

```sql
CREATE TABLE IF NOT EXISTS cloud_chunks (
  project_name TEXT NOT NULL DEFAULT 'default', chunk_id TEXT NOT NULL, created_by TEXT NOT NULL,
  client_created_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), payload JSONB NOT NULL,
  sessions_count INTEGER NOT NULL DEFAULT 0, observations_count INTEGER NOT NULL DEFAULT 0, prompts_count INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_chunks_project_chunk_uidx ON cloud_chunks (project_name, chunk_id);
CREATE TABLE IF NOT EXISTS cloud_project_sessions (
  project_name TEXT NOT NULL, session_id TEXT NOT NULL, indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (project_name, session_id));
CREATE TABLE IF NOT EXISTS cloud_project_controls (
  project TEXT PRIMARY KEY, sync_enabled BOOLEAN NOT NULL DEFAULT TRUE, paused_reason TEXT, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_cloud_project_controls_enabled ON cloud_project_controls(sync_enabled);
CREATE TABLE IF NOT EXISTS cloud_mutations (
  seq BIGSERIAL PRIMARY KEY, project TEXT NOT NULL, entity TEXT NOT NULL, entity_key TEXT NOT NULL, op TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}', occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_cloud_mutations_project ON cloud_mutations(project);
CREATE INDEX IF NOT EXISTS idx_cloud_mutations_seq ON cloud_mutations(seq);
CREATE TABLE IF NOT EXISTS cloud_sync_audit_log (
  id SERIAL PRIMARY KEY, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), contributor TEXT NOT NULL, project TEXT NOT NULL,
  action TEXT NOT NULL, outcome TEXT NOT NULL, entry_count INT NOT NULL DEFAULT 0, reason_code TEXT, metadata JSONB);
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at ON cloud_sync_audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_contributor_project ON cloud_sync_audit_log (contributor, project);
CREATE INDEX IF NOT EXISTS idx_audit_log_outcome ON cloud_sync_audit_log (outcome);
```

`cloud_mutations` es el diario: la rellenan tanto los chunks subidos como el empuje de mutaciones, y a su vez cada lote empujado deja su chunk en `cloud_chunks`.

Operaciones:

- `readManifest(project)`, `readChunk(project, id)` (`ChunkNotFoundInCloud`, mensaje `cloudstore: chunk not found: "<id>"`), `knownSessionIds(project)` (ids no vacíos).
- `writeChunk(project, id, createdBy, clientCreatedAt, payload)`: si ya existe, compara por valor (`normalizeJson`): igual → solo reindexa sesiones; distinto → `ChunkConflictError` (`existing chunk "<id>" has different payload`). Si no existe, decodifica el chunk con campos tipados (`cloudstore: parse chunk for materialization: …`), calcula sus mutaciones (`chunkMaterializedMutations`) e inserta en una transacción el chunk, las sesiones indexadas y esas mutaciones en `cloud_mutations`, con los contadores de `summarizeChunk`, `created_by` recortado y `client_created_at` como fecha. Si dos subidas iguales compiten (violación de unicidad `23505`), la perdedora relee y comprueba que es la misma carga (si ya no está: conflicto «concurrently inserted»).
- Índice de sesiones (`collectSessionIds`): ids no vacíos de `sessions` y de las mutaciones de sesión con `upsert` que se pueden materializar (id de la carga o, si falta, la clave de entidad; una mutación sin clave de entidad o ilegible se ignora).
- `insertMutationBatch(batch)`: en una transacción inserta cada entrada en `cloud_mutations` (`RETURNING seq`; un fallo lanza `MutationBatchEntryError` con el índice) y, por cada proyecto del lote, su chunk (`mutationBatchChunks`; `created_by` vacío = `unknown`; `ON CONFLICT DO NOTHING`) con sus sesiones indexadas. Los chunks se calculan antes de abrir la transacción.
- `listMutationsSince(sinceSeq, limit, allowedProjects)`: `limit` ≤ 0 o > 100 = 100; consulta `limit + 1` filas para saber si hay más; `allowedProjects` nulo = sin filtro, lista vacía = resultado vacío.
- `backfillMutationChunks(project, apply)`: informe `{ project, applied, candidate_mutations, already_materialized, invalid_mutations, chunks_planned, chunks_inserted }`. Recorre las filas del diario del proyecto que viajan en chunks; una cuya firma (`entrySignature`) ya figura entre las mutaciones de los chunks del proyecto cuenta como `already_materialized`, una que no se puede firmar como `invalid_mutations`, y el resto se agrupa de 100 en 100 en chunks nuevos (`created_by = mutation-backfill`). Con `apply` los inserta (`ON CONFLICT DO NOTHING`) e indexa sus sesiones en una transacción.
- `isProjectSyncEnabled(project)`: sin fila, verdadero. `setProjectSyncEnabled(project, enabled, updatedBy, reason)`: upsert; al activar guarda `paused_reason` nulo.
- `insertAuditEntry({ contributor, project, action, outcome, entryCount, reasonCode, metadata })`: `reason_code` vacío y metadatos vacíos se guardan como `NULL`.

El almacén **no** reordena nada: el JSONB que devuelve Postgres es la forma estable de la carga (claves ordenadas por longitud y luego alfabéticamente, con `": "` y `", "`); los clientes solo la interpretan como JSON.

## `odin cloud repair`

`odin cloud repair materialize-mutations --project <p> (--dry-run|--apply)` abre la base de `ODIN_DATABASE_URL`, migra y ejecuta `backfillMutationChunks`; imprime el informe como JSON con sangría de dos espacios. Sin argumentos o con `--help`, `-h`, `help`: `usage: odin cloud repair materialize-mutations --project <name> (--dry-run|--apply)` y `repairs existing cloud_mutations into compatible cloud_chunks without deleting remote data` por la salida estándar. Errores (salida 1, error estándar sin prefijo): `unknown cloud repair command: <x>` + `supported cloud repair commands: materialize-mutations`; falta `--project` (o su valor) → uso + `error: --project is required`; no exactamente una de las dos banderas → uso + `error: exactly one of --dry-run or --apply is required`. El proyecto se normaliza.
