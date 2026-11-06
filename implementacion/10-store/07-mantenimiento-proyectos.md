# 10.7 — Mantenimiento de proyectos

Módulo: `src/store/project-maintenance.js`; amplían `errors.js`, `journal.js` (`backfillProjectSyncMutations`), `observations.js` (se exporta `recordDeleteTombstone`) e `index.js`.

Operaciones para ordenar los nombres de proyecto: renombrar, fusionar variantes, podar proyectos vacíos y borrar proyectos enteros. Todas actúan sobre el **nombre exacto** guardado (no sobre su forma normalizada), porque su finalidad es reparar nombres heredados que la API ya no produciría.

## Ampliaciones

- **`errors.js`**, códigos nuevos: `project_not_found` («project not found»), `project_name_required` («project name must not be empty»), `project_prune_blocked` («project still has observations») e `invalid_project_merge` («invalid project merge»). Los errores de fusión y de poda llevan el mensaje completo indicado abajo.
- **`journal.js`**: `backfillProjectSyncMutations(db, project)`. Tras renombrar o fusionar, el diario de sincronización debe reflejar el estado local del proyecto. Desde F9.2b rellena de verdad el diario del proyecto inscrito (`30-cloud/04-autosync.md`, «Relleno del diario»); un proyecto no inscrito no hace nada.
- **`observations.js`**: `recordDeleteTombstone(db, entity, entityKey, sessionId, project, deletedAt)` pasa a exportarse (ya la usaba el borrado duro de observaciones).

## `project-maintenance.js`

Constante `RESERVED_INBOX_PROJECT_NAME = 'inbox'`: ningún proyecto puede fusionarse hacia ese nombre.

### `migrateProjectSyncIdentity(db, sources, canonical)` (interna)

Recorta cada fuente con `goTrim`, descarta las vacías, las iguales a `canonical` y las repetidas; si no queda ninguna, termina. Con las `variants` restantes, en este orden:

1. Reescribe las mutaciones pendientes: `UPDATE sync_mutations SET payload = CASE WHEN json_valid(payload) AND json_extract(payload, '$.project') IN (<variants>) THEN json_set(payload, '$.project', ?) ELSE payload END, project = ? WHERE acked_at IS NULL AND (project IN (<variants>) OR (json_valid(payload) AND json_extract(payload, '$.project') IN (<variants>)))`, con argumentos `variants…, canonical, canonical, variants…, variants…`. Las mutaciones ya enviadas (`acked_at` no nulo) no se tocan.
2. Traspasa la inscripción: `INSERT OR IGNORE INTO sync_enrolled_projects (project) SELECT ? WHERE EXISTS (SELECT 1 FROM sync_enrolled_projects WHERE project IN (<variants>))` con `canonical, variants…`.
3. Retira las inscripciones de origen: `DELETE FROM sync_enrolled_projects WHERE project IN (<variants>)`.

### `migrateProject(store, oldName, newName)` → `{ migrated, observations_updated, sessions_updated, prompts_updated }`

1. `newName` se normaliza (`normalizeProject`). Si `oldName` o `newName` están vacíos, o son iguales, devuelve `migrated: false` con ceros.
2. Si no existe ninguna fila con `project = oldName` en observaciones, sesiones o prompts (`SELECT EXISTS(… UNION ALL …)`), devuelve `migrated: false` con ceros.
3. En `writeTransaction`: `UPDATE observations SET project = ? WHERE project = ?` y lo mismo en `sessions` y `user_prompts` (cuentas por `changes`); `migrateProjectSyncIdentity(db, [oldName], newName)`; `backfillProjectSyncMutations(db, newName)`. Devuelve `migrated: true` con las cuentas.

### Fusión

- Un origen normalizado `n` es **fusionable** con el canónico `c` si `n === c` o, solo en modo explícito, si `n !== c` y quitando todos los `-` y `_` de ambos resulta lo mismo.
- Las variantes de un origen son `[goTrim(origen)]` salvo que esté vacío, sea igual a `c` o no sea fusionable (entonces ninguna).

`previewExplicitProjectMerge(store, source, canonical)` → `{ canonical, source, observations_updated, sessions_updated, prompts_updated, sync_identity_changes }` (en `readTransaction`):
1. `canonical` y `source` se normalizan. Si `canonical` es `inbox` → `invalid_project_merge`: `reserved inbox project cannot be a merge destination`.
2. Si `canonical` o el origen normalizado están vacíos, `goTrim(source) === canonical` o el origen no es fusionable en modo explícito → `source project "<source>" must be a distinct legacy case, separator or Unicode normalization variant of canonical project "<canonical>"`.
3. Con `name = goTrim(source)`: cuenta las filas con `project = name` en observaciones, sesiones y prompts, las inscripciones (`sync_enrolled_projects`) y las mutaciones pendientes (`acked_at IS NULL AND (project = ? OR (json_valid(payload) AND json_extract(payload, '$.project') = ?))`). `sync_identity_changes = inscripciones > 0 || pendientes > 0`. Si la suma de todo es 0 → `source project "<name>" does not exist`.

`mergeProjects(store, sources, canonical)` (modo normal) y `mergeExplicitProjectVariants(store, sources, canonical)` (modo explícito) → `{ canonical, sources_merged, observations_updated, sessions_updated, prompts_updated }`:
1. `canonical` normalizado: vacío → `canonical project name must not be empty`; `inbox` → `reserved inbox project cannot be a merge destination`.
2. Cada origen se normaliza: vacío → `source project name must not be empty`; no fusionable → en modo explícito `source project "<origen>" must normalize to canonical project "<canonical>" or differ only by corresponding '-' and '_' separators`, en modo normal `source project "<origen>" must normalize to canonical project "<canonical>"`. Todos son `invalid_project_merge`. La validación ocurre antes de escribir.
3. En `writeTransaction`, para cada origen sin repetir (por el texto de entrada):
   - En modo explícito: cuenta como en la vista previa (con `goTrim(origen)`); suma 0 → `source project "<nombre>" does not exist`. Guarda si hay identidad de sincronización (inscripción o mutaciones pendientes).
   - Si el origen es igual al canónico o no tiene variantes, pasa al siguiente.
   - Para `observations`, `sessions` y `user_prompts`: `UPDATE <tabla> SET project = ? WHERE project IN (<variantes>)`; suma las filas. 
   - `migrateProjectSyncIdentity(db, variantes, canonical)`.
   - Si se actualizó alguna fila **o** había identidad de sincronización, añade `variantes[0]` a `sources_merged`.
4. Al final, `backfillProjectSyncMutations(db, canonical)`.

### `pruneProject(store, project)` → `{ project, sessions_deleted, prompts_deleted }`

Nombre vacío → `project_name_required`. Si `countObservationsForProject` (observaciones **vivas**) es > 0 → `project_prune_blocked`: `project "<project>" still has <n> observations — cannot prune`. En `writeTransaction`: `DELETE FROM user_prompts WHERE project = ?` y `DELETE FROM sessions WHERE project = ? AND NOT EXISTS (SELECT 1 FROM observations WHERE observations.session_id = sessions.id)` (cualquier observación, incluso borrada, mantiene la sesión).

### `deleteProject(store, project, hardDelete = false)` → `{ project, observations_deleted, prompts_deleted, sessions_deleted, hard_delete }`

`project = goTrim(project)`; vacío → `project_name_required`. En `writeTransaction`:
1. Cuenta sesiones y observaciones (también borradas) con `project = ?`; ambas 0 → `project_not_found` con detalle `"<project>"` (mensaje `project not found: "<project>"`).
2. **Duro**: `UPDATE memory_relations SET judgment_status = 'orphaned', updated_at = datetime('now') WHERE source_id IN (SELECT sync_id FROM observations WHERE project = ?) OR target_id IN (…)`; `DELETE FROM observations WHERE project = ?` (cuenta = `observations_deleted`). **Suave**: `deletedAt = now()` y `UPDATE observations SET deleted_at = ?, updated_at = ? WHERE project = ? AND deleted_at IS NULL` (misma marca de la aplicación en ambas columnas).
3. `DELETE FROM user_prompts WHERE project = ?` (`prompts_deleted`).
4. Solo en el borrado duro: `DELETE FROM sessions WHERE project = ? AND NOT EXISTS (observaciones de la sesión) AND NOT EXISTS (prompts de la sesión)` (`sessions_deleted`; una sesión con registros de otro proyecto se conserva) y `recordDeleteTombstone(db, 'project', normalizeProject(project), '', project, now())`. El borrado suave **no** borra sesiones ni deja lápida.

## Criterios de aceptación

```bash
node --test "test/unit/store/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```
