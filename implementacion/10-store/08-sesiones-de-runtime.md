# 10.8 — Sesiones de runtime

Módulos: `src/store/runtime-sessions.js` y `src/project/worktree.js`; amplían `errors.js`, `observations.js` (`insertObservationRow`), `sessions.js` (exporta `foreignRecordOwner`, `sessionRow`, `journalSession` y `endSessionInTransaction`) e `index.js`.

Una **sesión de runtime** es la sesión que el agente anfitrión (Copilot) abre al empezar a trabajar y cierra al terminar. Tiene un identificador raíz que decide el anfitrión, una política de propiedad (`shared` o `project_owned`), un directorio de trabajo y una **concesión** local de 30 minutos. Si la sesión raíz ya terminó, el trabajo continúa en una sesión nueva `<raíz>:resume:<n>`.

## Ampliaciones

- **`errors.js`**: códigos `session_isolation_conflict` («isolated session registration requires an empty directory; existing runtime-bound sessions cannot be reused») y `runtime_session_scope_conflict` («runtime session scope conflict»).
- **`observations.js`**: `insertObservationRow(db, { session_id, type, title, content, tool_name, project, scope, topic_key, hash })` → `id`: `INSERT INTO observations (sync_id, session_id, type, title, content, tool_name, project, scope, topic_key, normalized_hash, revision_count, duplicate_count, last_seen_at, updated_at) VALUES (newSyncId('obs'), …, CAST(? AS TEXT), …, 1, 1, datetime('now'), datetime('now'))` y fija `review_after` si el tipo tiene plazo. `addObservation` pasa a usarla (comportamiento idéntico).
- **`sessions.js`**: `endSession` delega en `endSessionInTransaction(db, id, summary)`, que ejecuta `UPDATE sessions SET ended_at = datetime('now'), summary = ? WHERE id = ?` (sin filas afectadas: termina sin error) y anota la sesión en el diario. Se exportan `foreignRecordOwner`, `sessionRow` y `journalSession`.

## `project/worktree.js`

- `detectGitWorktreeDir(dir)`: ejecuta `git -C <dir> rev-parse --show-toplevel` (sin shell, `windowsHide`, tiempo máximo 2 s, stderr descartado) y devuelve la salida recortada, o `''` si falla.
- `canonicalizePath(path)`: `''` → `''`; si se puede resolver con `realpathSync`, esa ruta normalizada; si no, la ruta normalizada.
- `runtimeWorktreeDirectory(dir)`: `dir` recortado (vacío → `.`) → `path.resolve` → la raíz del worktree de git si la hay, o el propio directorio → `canonicalizePath`; en Windows en minúsculas. Cada worktree enlazado conserva su propia raíz.
- `directoryIdentity(path)`: `canonicalizePath(path.resolve(path))`, en minúsculas en Windows.

La capa HTTP/MCP debe aplicar `runtimeWorktreeDirectory` al directorio recibido **antes** de llamar al store (el store guarda y compara el directorio tal cual se le da).

## `runtime-sessions.js`

Constantes: `RUNTIME_SESSION_LEASE = '+30 minutes'`, `ACTIVE_RUNTIME_SESSION_WINDOW = '-7 days'`.

### `continuationSession(db, root)`

1. Si `root` no existe o no ha terminado (`ended_at` nulo) → `root`.
2. Si terminó: `prefix = root + ':resume:'`; lee `SELECT id, ended_at FROM sessions WHERE id >= prefix+'0' AND id < prefix+':' ORDER BY id`. Ignora los ids que no empiezan por el prefijo o cuyo sufijo está vacío o contiene algo que no sean dígitos ASCII. Con `BigInt`: `max` empieza en 1 y sube al mayor ordinal visto; entre las **vivas** (`ended_at` nulo) se elige la de **menor** ordinal.
3. Devuelve la viva de menor ordinal si existe; si no, `prefix + (max + 1)` (la primera continuación es `:resume:2`). Los ordinales no se desbordan.

### `registerSession` (núcleo de `startSession`, `resumeSession` y `registerIsolatedSession`)

Argumentos: id raíz, proyecto, directorio, modo, `resume`, `isolated`. Valida el id (`session_id_required`), el modo (`invalid_session_ownership_mode`, detalle el modo entre comillas) y el proyecto normalizado (vacío → `project_required`). En `writeTransaction` (reiniciando las variables en cada intento):

1. `validateIsolation(id)` (solo si `isolated`): si la sesión existe y tiene directorio no vacío → `session_isolation_conflict` con detalle `"<id>"`; si no, si su modo es `shared` → `session_isolation_conflict` con detalle `"<id>" has shared ownership`. Se aplica a la raíz.
2. Si `resume`: lee la raíz. Si existe y **terminó**:
   - `owner`/`ownerMode` = propiedad de la raíz; `registrationProjectError(raíz, owner, ownerMode, proyecto, modo)`: si el modo pedido es `project_owned`, hay dueño y es otro → `SessionProjectConflictError`; si no, `sessionProjectWriteError`. Un error de tipo `session_ownership_mismatch` se relanza como `SessionProjectConflictError(raíz, owner, proyecto)`; otro error se relanza tal cual.
   - Si no es aislada, la raíz tiene dueño, directorio no vacío y modo válido: **alcance heredado** `{ proyecto: owner, directorio: el de la raíz, modo: el de la raíz }`.
   - Si el modo pedido es `project_owned` y la raíz no tiene dueño: si `foreignRecordOwner(raíz, proyecto)` encuentra otro proyecto → `SessionProjectConflictError(raíz, ese, proyecto)`.
   Después, `id = continuationSession(raíz)` y `effective = id`.
3. Si `id !== raíz`, `validateIsolation(id)`.
4. `{ project, mode, found } = sessionOwnership(id)`; `identityRepaired = !found`.
5. **Reclamación**: si existe, el modo pedido es `project_owned` y no tiene dueño, y está **terminada**: si `foreignRecordOwner` halla otro proyecto → `SessionProjectConflictError`; `UPDATE sessions SET project = ?, ownership_mode = ? WHERE id = ? AND ended_at IS NOT NULL AND ifnull(trim(project, <espacios>), '') = ''` debe afectar exactamente 1 fila (si no, error); anota la sesión; marca `claimed` y termina la transacción **confirmándola**. Tras confirmar, la función lanza `session_already_ended`: la propiedad queda asignada, pero no se reabre la sesión.
6. Si existe: `registrationProjectError(id, …)`; si hay error y se está reanudando a una continuación (`resume && id !== raíz`), se convierte en `SessionProjectConflictError(id, existingProject, proyecto)`; si no, se relanza. `identityRepaired` = falta proyecto, falta modo o el directorio está en blanco.
7. Datos de registro: los pedidos, salvo que la sesión no exista y haya alcance heredado (entonces los del alcance heredado).
8. `startSessionRow(id, proyecto, directorio, modo)`:
   ```sql
   INSERT INTO sessions (id, project, ownership_mode, directory, started_at, runtime_lease_expires_at, local_creation_project)
   VALUES (?, ?, ?, ?, ?, datetime('now', '+30 minutes'), ?)
   ON CONFLICT(id) DO UPDATE SET
     project = CASE WHEN ifnull(trim(sessions.project, ?), '') = '' THEN excluded.project ELSE sessions.project END,
     ownership_mode = CASE WHEN ifnull(trim(sessions.ownership_mode, ?), '') = '' THEN excluded.ownership_mode ELSE sessions.ownership_mode END,
     directory = CASE WHEN trim(sessions.directory, ?) = '' THEN excluded.directory ELSE sessions.directory END,
     runtime_lease_expires_at = excluded.runtime_lease_expires_at
   WHERE sessions.ended_at IS NULL
   ```
   (con `started_at = now()`, `local_creation_project = proyecto` y `SQL_WHITESPACE_TRIM_SET` en los tres `trim`). Si no afecta ninguna fila (la sesión terminó) → `session_already_ended`.
9. Si `identityRepaired`, anota la sesión en el diario (se omite si el directorio es vacío).

Funciones públicas:
- `startSession(store, id, project, directory, mode = 'shared')`: sin reanudar, sin aislar.
- `resumeSession(store, id, project, directory, mode = 'shared')` → id efectivo.
- `registerIsolatedSession(store, id, project, resume = false)` → id efectivo: directorio `''`, modo `project_owned`, `isolated`.

### `runtimeSession` (núcleo de la resolución)

`resolveRuntimeSession(store, root, project, directory, mode)` y `endRuntimeSession(store, root, project, directory, mode, summary = '')` (en `writeTransaction`; la segunda además cierra la sesión con `endSessionInTransaction`, resumen vacío → NULL, y devuelve el id cerrado):

1. Valida id (`session_id_required`), modo (`invalid_session_ownership_mode`) y proyecto normalizado (`project_required`).
2. `validate(id, live)`: lee `project`, `ownership_mode`, `directory`, `ended_at`; si la fila no existe → `session_not_found`. Lanza `runtime_session_scope_conflict` si: `registrationProjectError(...)` no es nulo, **o** el modo guardado difiere del pedido, **o** el directorio pedido o el guardado están en blanco, **o** `runtimeWorktreeDirectory(guardado) !== runtimeWorktreeDirectory(pedido)`. Si `live` y la sesión terminó → `session_not_found`.
3. `validate(raíz, false)`; `id = continuationSession(raíz)`; `validate(id, true)`; devuelve `id`. Si la raíz terminó y su continuación aún no existe, `validate(id, true)` falla con `session_not_found`.

### `activeRuntimeSessions(store, project, ...directories)` → `string[]`

Proyecto normalizado vacío o sin directorios (se descartan los vacíos y los repetidos) → `[]`. Consulta:
```sql
WITH runtime_candidates AS (
  SELECT s.id, s.directory, s.runtime_lease_expires_at, COALESCE(MAX(o.created_at), s.started_at) AS effective_activity
  FROM sessions s LEFT JOIN observations o ON o.session_id = s.id
  WHERE LOWER(s.project) = ? AND s.directory IN (<directorios>) AND s.ended_at IS NULL
    AND s.id NOT LIKE 'manual-save%' AND s.id NOT LIKE 'manual-fallback-%'
  GROUP BY s.id
), live_leased_directories AS (
  SELECT directory FROM runtime_candidates
  WHERE runtime_lease_expires_at IS NOT NULL AND runtime_lease_expires_at <> '' AND datetime(runtime_lease_expires_at) > datetime('now')
  GROUP BY directory
)
SELECT candidate.id FROM runtime_candidates candidate
WHERE (candidate.runtime_lease_expires_at IS NOT NULL AND candidate.runtime_lease_expires_at <> '' AND datetime(candidate.runtime_lease_expires_at) > datetime('now'))
   OR ((candidate.runtime_lease_expires_at IS NULL OR candidate.runtime_lease_expires_at = '')
       AND candidate.effective_activity >= datetime('now', '-7 days')
       AND NOT EXISTS (SELECT 1 FROM live_leased_directories live WHERE live.directory = candidate.directory))
ORDER BY candidate.id
```
Es decir: cuenta toda sesión con concesión vigente; y las que no tienen concesión solo si tuvieron actividad en los últimos 7 días y ningún candidato del mismo directorio tiene concesión vigente.

### `finalizeSession(store, { session_id, project, summary })` → `{ summary_id, summary_sync_id, already_finalized }`

1. Valida el id (`session_id_required`), el proyecto normalizado (vacío → `project_required`) y el resumen (`prepareStoredContent`; en blanco → `observation_content_required`).
2. En `writeTransaction`: lee `project`, `ended_at` y `summary` de la sesión (no existe → `session_not_found`). Si el proyecto normalizado de la sesión difiere → `session_ownership_mismatch` (sin detalle).
3. Si ya hay fila en `session_finalizations` → devuelve ese `summary_id`/`summary_sync_id` con `already_finalized: true`, sin escribir.
4. Si la sesión ya terminó → `session_already_ended`.
5. Inserta una observación `session_summary` con título `stripPrivateTags("Session summary: " + proyecto)`, el contenido preparado, `scope: 'project'`, sin `topic_key` (con `insertObservationRow`); anota la observación; cierra la sesión **conservando el resumen que ya tenía** (`endSessionInTransaction(db, id, <summary previo>)`); inserta `session_finalizations (session_id, summary_id, summary_sync_id)`.

## Criterios de aceptación

```bash
node --test "test/unit/store/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```
