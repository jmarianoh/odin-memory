# 10.2 — Observaciones y sesiones

Módulos: `src/project/canonical.js`, `src/store/{text,journal,sessions,observations}.js`; también amplían `errors.js` (catálogo de errores), `store.js` (límites) e `index.js` (exportaciones).

## Convenciones de esta capa

- Las funciones reciben el `store` como primer argumento y son síncronas.
- Los objetos de entrada y salida usan `snake_case` (`session_id`, `tool_name`, `topic_key`, `operation_id`, `revision_count`…): coinciden con las cargas JSON de MCP y HTTP, de modo que no hace falta traducir.
- Los campos opcionales ausentes son `undefined` en la entrada; en la salida, una columna nula es `null`. `pinned` sale como booleano.
- Los errores de uso se crean con `storeError(code, detalle?)`: `StoreError` cuyo mensaje es `<mensaje base>` o `<mensaje base>: <detalle>`. Los mensajes base están en el catálogo de `errors.js` (ver más abajo).
- Longitudes y límites se miden en **bytes UTF-8** (`byteLength`), no en caracteres.
- Los criterios de «espacio» son los de Go (`unicode.IsSpace`), no los de `\s` de JavaScript: ver `goTrim`/`goFields`.

## `errors.js` — catálogo

`storeError(code, detail?)` usa estos mensajes base:

| code | mensaje base |
|---|---|
| `session_not_found` | session not found |
| `session_id_required` | session id is required |
| `session_already_ended` | session has already ended |
| `observation_not_found` | observation not found |
| `prompt_not_found` | prompt not found |
| `project_required` | project identity is required |
| `invalid_session_ownership_mode` | invalid session ownership mode |
| `session_ownership_mismatch` | session ownership does not match write project |
| `project_ownership_ambiguous` | session project ownership is ambiguous |
| `expected_project_required` | expected_project must be a valid non-empty project name |
| `observation_project_mismatch` | expected_project does not match observation owner |
| `observation_project_immutable` | observation project cannot be reassigned |
| `observation_title_required` | observation title is required |
| `observation_content_required` | observation content is required |
| `observation_operation_conflict` | observation operation id conflicts with a different payload |
| `observation_operation_expired` | observation operation id is outside the replay horizon |
| `observation_find_replace_pair_required` | find and replace must be provided together |
| `observation_find_replace_content_conflict` | find and replace cannot be combined with content |
| `observation_find_replace_input_too_large` | find and replace inputs exceed maximum observation length |
| `observation_find_replace_result_too_large` | replacement result exceeds maximum observation length |
| `observation_find_replace_legacy_content_large` | cannot partially replace oversized legacy observation |
| `prompt_content_required` | prompt content is required |
| `invalid_project_name` | invalid project name |
| `sync_journal_unavailable` | sync journal is not available for enrolled projects yet |

`SessionProjectConflictError(sessionId, ownerProject, requestedProject)` extiende `StoreError` con `code = 'session_ownership_mismatch'`, mensaje `session ownership does not match write project: session "<id>" belongs to "<dueño>", not "<pedido>"` (los valores entre comillas con `JSON.stringify`) y propiedades `sessionId`, `ownerProject`, `requestedProject`.

## `store.js` — límites

`Store.settings` combina `config` con `DEFAULT_SETTINGS = { maxObservationLength: 50000, maxContextResults: 20, maxSearchResults: 20, dedupeWindowMs: 900000 }`. Se pueden sustituir al abrir (`Store.open({ dataDir, maxObservationLength: 10, … })`).

## `project/canonical.js`

- `canonicalizeProjectName(name)`: `name.normalize('NFC').toLowerCase()` → `goTrim` → `normalize('NFC')`; luego colapsa repetidamente `--` en `-` y `__` en `_` hasta que no queden.
- `normalizeProject(project)` → `{ normalized, warning }`: vacío → ambos vacíos; si `canonicalizeProjectName(project) === project`, aviso vacío; si no, `⚠️ Project name normalized: "<original>" → "<canónico>"` (con `JSON.stringify`).
- `normalizeProjectName(name)` (entrada externa): recorta con `goTrim`; vacío → `invalid_project_name` con detalle `<name> (project is required)`; contiene `/` o `\` → `(project must be a name, not a path)`; contiene algún carácter de control (`< 0x20` o `0x7f`) → `(project contains control characters)`; si no, devuelve el nombre canónico.

## `text.js`

- `goTrim(s)`, `goFields(s)`: el espacio es `\t \n \v \f \r`, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000. **No** incluye U+FEFF. `SQL_WHITESPACE_TRIM_SET` es la cadena con esos mismos caracteres, para `trim(X, ?)` en SQL.
- `isBlankSessionId(id)`: `goTrim(id) === ''`.
- `stripPrivateTags(s)`: sustituye `/<private>[\s\S]*?<\/private>/gi` por `[REDACTED]` y aplica `goTrim`. Una etiqueta sin cerrar no se toca.
- `truncateContent(content, max)`: si `byteLength <= max` devuelve el contenido; si no, corta el búfer UTF-8 en `max` y retrocede mientras el byte de corte sea de continuación (`(byte & 0xC0) === 0x80`), y añade `TRUNCATION_MARKER = '... [truncated]'`.
- `hashNormalized(content)`: SHA-256 hexadecimal de `goFields(content).join(' ').toLowerCase()`.
- `normalizeScope(s)`: `goTrim`+minúsculas; `personal` y `global` se conservan; cualquier otra cosa (incluido `undefined`) es `project`.
- `normalizeTopicKey(s)`: `goTrim`+minúsculas; vacío → `''`; `goFields(...).join('-')`; si supera 120 bytes se corta a 120 sin partir un carácter.
- `normalizeTopicSegment(s)`: `goTrim`+minúsculas; vacío → `''`; sustituye `/[^a-z0-9]+/g` por un espacio, `goFields(...).join('-')`, máximo 100 caracteres.
- `suggestTopicKey(type, title, content)`:
  1. `family = inferTopicFamily(type, title, content)`.
  2. `segmentSource = stripPrivateTags(title)`; `segment = normalizeTopicSegment(segmentSource)`.
  3. Si el segmento queda vacío: `segmentSource` = primeras 8 palabras (`goFields`) de `stripPrivateTags(content)` unidas por espacios; se recalcula el segmento.
  4. Si sigue vacío: `general`. Si empieza por `<familia>-`, se quita ese prefijo. Si queda vacío o igual a la familia: `general`.
  5. `segment = appendUnicodeTopicIdentity(segment, segmentSource, 120 - familia.length - 1)`.
  6. Devuelve `<familia>/<segmento>`.
  - `inferTopicFamily`: con `t = goTrim(type).toLowerCase()`: `architecture|design|adr|refactor` → `architecture`; `bug|bugfix|fix|incident|hotfix` → `bug`; `decision`; `pattern|convention|guideline` → `pattern`; `config|setup|infra|infrastructure|ci` → `config`; `discovery|investigation|root_cause|root-cause` → `discovery`; `learning|learn` → `learning`; `session_summary` → `session`. Si no coincide, se busca en `(título + ' ' + contenido).toLowerCase()` por este orden: `bug`(`bug fix panic error crash regression incident hotfix`), `architecture`(`architecture design adr boundary hexagonal refactor`), `decision`(`decision tradeoff chose choose decide`), `pattern`(`pattern convention naming guideline`), `config`(`config setup environment env docker pipeline`), `discovery`(`discovery investigate investigation found root cause`), `learning`(`learned learning`). Si nada coincide: si `t` no es `''` ni `manual`, `normalizeTopicSegment(t)`; si no, `topic`.
  - `appendUnicodeTopicIdentity(segment, source, maxLen)`: si `source` contiene algún carácter con punto de código > 0x7F, `suffix = '-u-' + sha256hex(source).slice(0, 12)`; `limit = min(maxLen, 100)`; si `segment.length > limit - suffix.length` se recorta a `limit - suffix.length`; devuelve `segment + suffix`. Si todo es ASCII, devuelve el segmento intacto.
- `sanitizeFts(query)`: cada palabra de `goFields(query)` pierde las comillas `"` de los extremos, duplica las interiores y se entrecomilla; se unen con un espacio.
- `nullableString(v)`: `''`, `null` o `undefined` → `null`.
- `newSyncId(prefix)`: `<prefix>-` + 8 bytes aleatorios en hexadecimal.

## `journal.js` — gancho de sincronización

`journalMutation(db, { entity, entityKey, op, project, sessionId, payload })` es el único punto por el que las escrituras anotan su mutación para Cloud. Debe invocarse dentro de la transacción de la escritura.

Estado actual: valida que una sesión tenga clave; calcula el proyecto (`project` normalizado o, si falta, el de `sessionId`); si el proyecto es vacío o **no está inscrito** (`sync_enrolled_projects`) no hace nada; si está inscrito lanza `storeError('sync_journal_unavailable', '<entidad> <op> for project "<p>"')`. El diario completo llegará con la sincronización. `payload` es una función para no construir la carga cuando no se usa.

Exporta `SYNC_ENTITY` (`session`, `observation`, `prompt`, `relation`, `project`), `SYNC_OP_UPSERT = 'upsert'`, `SYNC_OP_DELETE = 'delete'`, `isProjectEnrolled(db, project)` y `sessionProject(db, sessionId)` (proyecto canónico de la sesión o `''`).

## `sessions.js`

Constantes: `SESSION_OWNERSHIP_SHARED = 'shared'`, `SESSION_OWNERSHIP_PROJECT_OWNED = 'project_owned'`, `MANUAL_SESSION_ID_PREFIX = 'manual-save-'`, `RESCUE_OWNERSHIP_COMMAND = 'odin projects rescue-ownership'`.

- `validateSessionId(id)`: `session_id_required` si es blanco. `validSessionOwnershipMode(m)`. `rescueOwnershipHint(id)` = `<RESCUE_OWNERSHIP_COMMAND> --project <name> --session <id>`.
- `sessionOwnership(db, id)` → `{ project, mode, found }`: lee `project, ownership_mode`; el proyecto se normaliza (vacío si es NULL o blanco) y el modo se recorta.
- `sessionProjectWriteError(id, sessionProject, mode, requested)`: `null` si `sessionProject === ''`, o es igual a `requested`, o el modo es `shared`. Con modo `project_owned`: `session_ownership_mismatch` con detalle `session "<id>" belongs to "<sessionProject>", not "<requested>"`. Con cualquier otro modo: `project_ownership_ambiguous` con detalle `session "<id>" has unclassified ownership for "<sessionProject>" and cannot accept "<requested>"`.
- `resolveWriteProject(db, sessionId, requested)` (dentro de una transacción), con `requested` normalizado:
  1. `requested === ''`: si la sesión no existe → `project_required` (`session "<id>" does not exist, so the write has no project to inherit`); si no tiene dueño → `project_required` (`session "<id>" carries no project ownership and the write supplied none; assign ownership with: <hint>`); si no, devuelve el dueño.
  2. Si `sessionProjectWriteError(...)` da error, lo lanza.
  3. Si la sesión no existe o ya es del proyecto pedido, devuelve `requested`. Si tiene otro dueño (modo `shared`), también.
  4. Sin dueño: busca el primer registro hijo (observaciones vivas, luego prompts) con un proyecto distinto del pedido; si lo hay → `project_ownership_ambiguous` (`session "<id>" carries no project ownership but already parents <an observation|a prompt> owned by "<otro>", so it cannot adopt "<requested>"; resolve it explicitly with: <hint>`).
  5. Si no, adopta: `UPDATE sessions SET project = ? WHERE id = ? AND ifnull(trim(project), '') = ''`, anota la sesión en el diario y devuelve `requested`.
- `createSession(store, id, project, directory, mode = 'shared')`: valida id y modo (`invalid_session_ownership_mode`, detalle el modo entre comillas); normaliza el proyecto; vacío → `project_required`. En `writeTransaction`: si la sesión existe y `mode` es `project_owned` con dueño distinto → `SessionProjectConflictError`; luego `sessionProjectWriteError`. Inserta con
  ```sql
  INSERT INTO sessions (id, project, ownership_mode, directory, started_at, local_creation_project) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    project = CASE WHEN ifnull(trim(sessions.project, ?), '') = '' THEN excluded.project ELSE sessions.project END,
    ownership_mode = CASE WHEN ifnull(trim(sessions.ownership_mode, ?), '') = '' THEN excluded.ownership_mode ELSE sessions.ownership_mode END,
    directory = CASE WHEN trim(sessions.directory, ?) = '' THEN excluded.directory ELSE sessions.directory END
  ```
  con `started_at = now()`, `local_creation_project = project` y `SQL_WHITESPACE_TRIM_SET` en los tres `trim`. Es decir: nunca pisa un valor ya establecido. Después anota la sesión en el diario (omitida si el directorio queda vacío).
- `resolveManualSession(store, project, directory)`: `id = 'manual-save-' + proyecto`; intenta `createSession(..., project_owned)`; si falla con `SessionProjectConflictError`, usa `id = 'manual-fallback-' + sha256hex(proyecto)` y vuelve a crear. Devuelve el `id`.
- `endSession(store, id, summary = '')`: valida el id; `UPDATE sessions SET ended_at = datetime('now'), summary = ? WHERE id = ?` (resumen vacío → NULL). Si no afecta ninguna fila, termina sin error; si no, anota la sesión en el diario.
- `getSession(store, id)` → fila (`id, project, ownership_mode, directory, started_at, ended_at, summary, runtime_lease_expires_at`, con `project` `''` si es NULL) o `null`.
- `recentSessions(store, project = '', limit = 5)` y `allSessions(store, project = '', limit = 50)`:
  ```sql
  SELECT s.id, ifnull(s.project, '') AS project, s.started_at, s.ended_at, s.summary, COUNT(o.id) AS observation_count
  FROM sessions s LEFT JOIN observations o ON o.session_id = s.id AND o.deleted_at IS NULL
  WHERE 1=1 [AND LOWER(s.project) = ?  |  AND s.project = ?]
  GROUP BY s.id ORDER BY MAX(datetime(COALESCE(o.created_at, s.started_at))) DESC, s.id DESC LIMIT ?
  ```
  `recentSessions` normaliza el proyecto y filtra con `LOWER(s.project)`; `allSessions` filtra por igualdad exacta sin normalizar. `limit <= 0` usa el valor por defecto.

## `observations.js`

`SELECT_COLUMNS` = `id, ifnull(sync_id,'') AS sync_id, session_id, type, title, content, tool_name, project, scope, topic_key, revision_count, duplicate_count, last_seen_at, review_after, pinned, created_at, updated_at, deleted_at, superseded_by_sync_id`.

`DECAY_REVIEW_AFTER_MONTHS`: `decision 6`, `policy 12`, `preference 3`, `config 3`, `discovery 6`, `pattern 6`, `architecture 12`, `bugfix 12`. El resto de tipos no tiene plazo. `reviewAfterFrom(months)` = ahora (UTC) + `months` con `setUTCMonth` (el desbordamiento de día se normaliza como en `Date`), formateado `YYYY-MM-DD HH:MM:SS`.

`observationState(reviewAfter, at = new Date())`: `active` si es nulo/vacío/ilegible; `needs_review` si la fecha (interpretada en UTC, con ` ` → `T`) es ≤ `at`; si no, `active`.

`prepareStoredContent(store, content)` → `{ content, truncation: { original_bytes, limit_bytes, truncated } }`: quita lo privado, mide los bytes y trunca con `settings.maxObservationLength`.

`validateExpectedProject(expected)`: `normalizeProjectName`; si lanza o queda vacío → `expected_project_required`.

### `addObservation(store, p)` → `{ id, replayed }`

1. `project = normalizeProject(p.project)`; `title = stripPrivateTags(p.title)`; `content = prepareStoredContent(...).content`; `validateObservationTitle(title)` (`goTrim(title) === ''` → `observation_title_required`); `content === ''` → `observation_content_required`. `session_id` ausente se trata como `''`.
2. `scope = normalizeScope`, `hash = hashNormalized(content)`, `topicKey = normalizeTopicKey(p.topic_key)`.
3. `fingerprint` = `'v1:' + sha256hex(...)` de los campos `session_id, type, title, content, tool_name, project(normalizado, antes de resolver), scope, topic_key`, cada uno precedido de su longitud en bytes como entero de 8 bytes *big endian*.
4. Todo en `writeTransaction`:
   - **Idempotencia** (solo con `operation_id`): `SELECT o.id, operation.fingerprint FROM observation_save_operations operation LEFT JOIN observations o ON o.id = operation.observation_id AND o.deleted_at IS NULL WHERE operation.operation_id = ?`. Si hay fila: huella que no empieza por `v1:` → `observation_operation_expired`; huella distinta → `observation_operation_conflict`; igual con observación inexistente → `observation_operation_expired`; igual y existente → `{ id, replayed: true }` sin más escrituras.
   - `project = resolveWriteProject(db, session_id, project)`.
   - **Upsert por topic_key** (solo si `topicKey !== ''`): busca `SELECT id FROM observations WHERE topic_key = ? AND ifnull(project,'') = ifnull(?, '') AND scope = ? AND deleted_at IS NULL ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC LIMIT 1`. Si existe: guarda su versión (`captureVersion`) y la actualiza en el sitio (`session_id, type, title, content, tool_name, topic_key, normalized_hash`, `revision_count + 1`, `last_seen_at = updated_at = datetime('now')`); registra la operación y devuelve `{ id, replayed: false }`.
   - **Deduplicación**: `SELECT id FROM observations WHERE normalized_hash = ? AND ifnull(project,'') = ifnull(?, '') AND scope = ? AND type = ? AND title = ? AND deleted_at IS NULL AND datetime(created_at) >= datetime('now', '-N minutes') ORDER BY created_at DESC LIMIT 1`, con `N = max(1, floor(dedupeWindowMs / 60000))`. Si existe: `duplicate_count + 1`, `last_seen_at = updated_at = datetime('now')`; registra la operación.
   - **Inserción**: `INSERT INTO observations (sync_id, session_id, type, title, content, tool_name, project, scope, topic_key, normalized_hash, revision_count, duplicate_count, last_seen_at, updated_at) VALUES (newSyncId('obs'), …, CAST(? AS TEXT), …, 1, 1, datetime('now'), datetime('now'))`. Si el tipo tiene plazo: `UPDATE observations SET review_after = ? WHERE id = ?`. Registra la operación.
   - **Registrar la operación** (`recordSaveOperation`): si hay `operation_id`, `INSERT INTO observation_save_operations (operation_id, fingerprint, observation_id)`; en todos los casos anota la observación en el diario.
   - **Versión** (`captureVersion`): `INSERT INTO observation_versions (observation_id, title, content, version, created_at) SELECT ?, ?, ?, COALESCE(MAX(version), 0) + 1, datetime('now') FROM observation_versions WHERE observation_id = ?` con el título y contenido previos.
5. Devuelve `{ id, replayed }`.

### Resto de operaciones

- `getObservation(store, id)`: observación viva o `null`. `getObservationVersions(store, id)`: `id, observation_id, title (''), content, version, created_at ('')`, orden por `version ASC`.
- `getObservationSaveResult(store, operationId)`: `0` si el id es vacío o no hay registro; `observation_operation_expired` si el registro existe pero la observación no; si no, su id. `observationOperationRecorded(store, operationId)`: existe alguna fila (incluidas las lápidas de borrado duro).
- `replaceObservationContent(content, find, replacement, max)` → `{ content, noop }`:
  1. `find === ''` → sin cambios (`noop`).
  2. Si el contenido termina en `TRUNCATION_MARKER`, el marcador se separa y `oversized` se mide sobre el prefijo; si no, sobre todo el contenido.
  3. Si el prefijo no contiene `find` → `noop`. Si `oversized` → `observation_find_replace_legacy_content_large`.
  4. Si `replacement` ocupa más bytes que `find` (`growth`): `remaining = max - bytes(prefijo)`; si `remaining < 0` o `ocurrencias > floor(remaining / growth)` → `observation_find_replace_result_too_large`.
  5. `prefijo = stripPrivateTags(prefijo.split(find).join(replacement))`; vacío → `observation_content_required`; más de `max` bytes → `..._result_too_large`.
  6. Resultado = prefijo + marcador; `noop` si es igual al original.
- `updateObservation(store, id, p, { expectedProject })`: validaciones previas (`find`/`replace` por parejas, sin `content`, entradas ≤ `max` bytes, título no vacío tras quitar lo privado, contenido no vacío tras quitar lo privado). En transacción: observación viva o `observation_not_found`; `expectedProject` debe coincidir con el dueño (`observation_project_mismatch`); el proyecto no puede estar vacío (`project_required`). Aplica `type`, `title` (sin privado), `content` (preparado), find/replace (si es `noop` y no hay metadatos devuelve la observación sin tocar), `project` (si, normalizado, difiere del actual → `observation_project_immutable`), `scope`, `topic_key`. Si cambia el título o el contenido, guarda la versión previa. `UPDATE … SET type, title, content, project, scope, topic_key, normalized_hash = hashNormalized(content), revision_count = revision_count + 1, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`. Anota en el diario y devuelve la observación actualizada.
- `deleteObservation(store, id, { hardDelete = false, expectedProject })`: en transacción, observación (con borradas si es duro) o `observation_not_found`; comprueba `expectedProject`; el proyecto es el de la observación o, si falta, el de su sesión. **Suave**: `UPDATE … SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`. **Duro**: registra la lápida en `sync_delete_tombstones` (`entity='observation'`, `entity_key=sync_id`, `session_id`, `project`, `deleted_at = now()`, `hard_delete = 1`, `active = 1`, `last_mutation_seq = max(floor existente, MAX(seq) de mutaciones de borrado de esa entidad)`; en conflicto actualiza y deja `last_remote_mutation_seq = NULL`), borra `sync_delete_tombstone_remote_floors` de esa entidad, elimina la fila y marca como `orphaned` las `memory_relations` cuyo `source_id` o `target_id` sea su `sync_id`. En ambos casos anota el borrado en el diario.
- Listados (todos devuelven observaciones vivas): `recentObservations(store, project, scope, limit)` y `pinnedObservations(...)` filtran con `LOWER(o.project) = <proyecto normalizado>`; `allObservations(...)` filtra con `o.project = <valor exacto>`; el ámbito, si se da, se normaliza. Orden `datetime(o.created_at) DESC, o.id DESC`. `limit <= 0` usa `maxContextResults` (en `pinned`, sin tope). `sessionObservations(store, sessionId, limit = 200)`: `ORDER BY created_at ASC`.
- `pinObservation` / `unpinObservation`: `UPDATE observations SET pinned = ? WHERE id = ? AND deleted_at IS NULL`; sin filas → `observation_not_found`. El estado de fijado es local y no se sincroniza.
- `observationsNeedingReview(store, project, limit)`: vivas con `review_after IS NOT NULL AND datetime(review_after) <= datetime('now')`, orden `datetime(review_after) ASC, id ASC`.
- `markReviewed(store, id, project = '')`: con `project`, la observación debe pertenecerle (`LOWER(project) = ?`). Recalcula `review_after` con el plazo de su tipo (o NULL si no tiene) y fija `updated_at = now()`. Si `review_after` pasa de tener valor a NULL, inserta en `review_clear_events (event_key = newSyncId('review-clear'), sync_id)`. Anota en el diario.

## Criterios de aceptación

```bash
node --test "test/unit/store/*.test.js" test/unit/project-canonical.test.js
npm test
npm run check:implementacion
npm run check:clean-room
```
