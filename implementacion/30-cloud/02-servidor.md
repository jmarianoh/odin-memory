# 30/02 — Servidor de la nube

Módulos: `src/cloud/server/{config,db,store,validate,server,index}.js` y la orden `odin cloud serve` (`src/cli/commands/cloud.js`).

## Arranque (`odin cloud serve`)

1. `validateCloudServeAuthConfig(env, warn)` (reglas abajo); un fallo sale como `odin: <mensaje>`.
2. Importa dinámicamente el servidor (así `pg` solo se carga aquí), abre el pool (`pg.Pool`, máx. 10 conexiones; los errores de clientes ociosos se ignoran) y ejecuta `migrate()`. Si falla, cierra y sale con `odin: <error>`.
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

### Autenticación

Sin token configurado no se pide. Con token: cabecera `Authorization` recortada; vacía → 401 `unauthorized: missing authorization header`; no son exactamente dos campos separados por espacios en blanco o el esquema no es `bearer` (sin distinguir mayúsculas) → 401 `unauthorized: authorization must use Bearer token`; secreto distinto del token y del de administración → 401 `unauthorized: unknown token`. Respuesta de texto plano. La comparación es en tiempo constante (SHA-256 de ambos y `timingSafeEqual`; un secreto vacío nunca coincide).

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
6. `canonicalizeForProject(JSON.stringify(data), project)` y validación de filas (`validateChunkRows`): fallo → 400 `invalid push payload: <detalle>`. Filas: sesión con `id` y (`directory` o `ownership_mode = project_owned`); observación con `sync_id`, `session_id`, `type`, `title`, `content`, `scope`; prompt con `sync_id`, `session_id`, `content` (`<entidad>[<i>].<campo> is required`).
7. Referencias de sesión (`validateChunkSessionReferences`) contra las sesiones que el servidor ya conoce del proyecto: fallo → 400 `invalid push payload: …`; fallo al leer el índice → 500 `validate push payload: …`.
8. El identificador lo calcula el servidor sobre la carga canónica (si el cliente envió otro, solo se anota en el log). `client_created_at` no vacío debe ser RFC 3339 (`client_created_at must be RFC3339`).
9. `writeChunk`: conflicto → 409 `repairable`/`upgrade_repairable_chunk_conflict` `write chunk: existing chunk "<id>" has different payload`; otro error → 500 `blocked`/`upgrade_blocked_internal` `write chunk: …`.

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

`cloud_mutations` existe pero F9.1 no la rellena (los chunks se guardan solo en `cloud_chunks`); F9.2 la usará.

Operaciones:

- `readManifest(project)`, `readChunk(project, id)` (`ChunkNotFoundInCloud`, mensaje `cloudstore: chunk not found: "<id>"`), `knownSessionIds(project)` (ids no vacíos).
- `writeChunk(project, id, createdBy, clientCreatedAt, payload)`: si ya existe, compara por valor (`normalizeJson`): igual → solo reindexa sesiones; distinto → `ChunkConflictError` (`existing chunk "<id>" has different payload`). Si no existe, inserta chunk y sesiones indexadas en una transacción, con los contadores de `summarizeChunk`, `created_by` recortado y `client_created_at` como fecha. Si dos subidas iguales compiten (violación de unicidad `23505`), la perdedora relee y comprueba que es la misma carga (si ya no está: conflicto «concurrently inserted»).
- Índice de sesiones (`collectSessionIds`): ids no vacíos de `sessions` y de las mutaciones de sesión con `upsert` (id de la carga o, si falta, la clave de entidad).
- `isProjectSyncEnabled(project)`: sin fila, verdadero. `setProjectSyncEnabled(project, enabled, updatedBy, reason)`: upsert; al activar guarda `paused_reason` nulo.
- `insertAuditEntry({ contributor, project, action, outcome, entryCount, reasonCode, metadata })`: `reason_code` vacío y metadatos vacíos se guardan como `NULL`.

El almacén **no** reordena nada: el JSONB que devuelve Postgres es la forma estable de la carga (claves ordenadas por longitud y luego alfabéticamente, con `": "` y `", "`); los clientes solo la interpretan como JSON.
