# 10.5 — Proyectos, captura pasiva y consolidación

Módulos: `src/store/projects.js`, `src/store/passive.js`, `src/store/consolidate.js`; amplían `errors.js`, `text.js` (se exporta `cutBytes`) y `observations.js` (se exportan `getObservationRow` y `journalObservation`).

## Ampliaciones de `errors.js`

Códigos nuevos: `consolidate_need_two_sources` («consolidate needs at least two source observations»), `consolidate_duplicate_id` («consolidate source list contains duplicate ids»), `consolidate_missing_observation` («consolidate source missing or already deleted»), `consolidate_cross_project` («consolidate sources span multiple projects»), `consolidate_provenance_cycle` («consolidate provenance cycle detected»), `consolidate_fingerprint_mismatch` («consolidate sources changed since plan; re-plan required»), `invalid_project_alias` («invalid project alias») y `passive_capture_failed` («passive capture save»).

## `projects.js`

### Estadísticas y listados

- `stats(store)` y `statsProject(store, project)` → `{ total_sessions, total_observations, total_prompts, projects }`. Con proyecto (normalizado; vacío → `StoreError('project_required', 'project is required')`) se filtra con `WHERE LOWER(project) = ?` en `sessions` y `user_prompts`, y con `AND LOWER(project) = ?` en `observations`. Las observaciones cuentan solo las vivas. `projects` sale de `SELECT project FROM observations WHERE project IS NOT NULL AND deleted_at IS NULL [AND LOWER(project) = ?] GROUP BY project ORDER BY MAX(created_at) DESC`.
- `projectExists(store, name)`: `true` si `name` (ya canónico) aparece, comparado con `LOWER(project)`, en alguna de: observaciones vivas, sesiones, prompts o `sync_enrolled_projects` (`UNION ALL … LIMIT 1`).
- `listProjectNames(store)`: `SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != '' AND deleted_at IS NULL ORDER BY project`.
- `listProjectsWithStats(store)` → `[{ name, observation_count, session_count, prompt_count, directories }]`: cuenta observaciones vivas por proyecto; sesiones con `GROUP BY project, directory` (suma de cuentas y directorios no vacíos únicos); prompts por proyecto. Ordena de más a menos observaciones; el orden entre empates no está definido. Se omiten proyectos nulos o vacíos.
- `countObservationsForProject(store, name)`: observaciones vivas con `project = ?` exacto.

### Alias

Tipos: `key` (nombre alternativo de proyecto) y `cwd` (directorio). Constantes `PROJECT_ALIAS_KIND_KEY`, `PROJECT_ALIAS_KIND_CWD`.

- Clave de alias: para `key`, `normalizeProjectName(key)`; para `cwd`, la ruta resuelta con `path.resolve` (absoluta, sin barra final, `.` y `..` resueltos); una ruta en blanco o con `\0` → `invalid_project_alias` (`invalid project alias cwd: "<valor>"`); otro tipo → `invalid_project_alias` (`invalid project alias kind: "<tipo>"`).
- `setProjectAlias(store, kind, key, project)`: valida clave y destino (`normalizeProjectName`) y hace `INSERT INTO project_aliases(kind, alias_key, project) VALUES(?,?,?) ON CONFLICT(kind, alias_key) DO UPDATE SET project = excluded.project`; devuelve `{ kind, key, project }` canónicos.
- `listProjectAliases(store)`: `SELECT kind, alias_key AS key, project FROM project_aliases ORDER BY kind, alias_key`.
- `removeProjectAlias(store, kind, key)`: `true` si borró alguna fila.
- `resolveProjectAlias(store, key, cwd)` → `{ project, key_alias, cwd_alias, conflict }`: `project` parte de `key`; busca el alias `key` (si `key` no es vacío) y el `cwd` (si `cwd` no es vacío) con `WHERE (kind='key' AND alias_key=? AND ?!='') OR (kind='cwd' AND alias_key=? AND ?!='')`. Si hay alias de nombre, `project` es el suyo; si hay alias de directorio, este prevalece; si hay ambos y apuntan a proyectos distintos, `project = ''` y `conflict = true`. Los alias son informativos: hoy solo los consume el diagnóstico.

## `passive.js`

- `cleanMarkdown(text)`: quita `**negrita**`, `` `código` `` y `*cursiva*` (en ese orden, con `/\*\*([^*]+)\*\*/g`, ``/`([^`]+)`/g`` y `/\*([^*]+)\*/g`) y colapsa espacios con `goFields(...).join(' ')`.
- `extractLearnings(text)` → `string[]`:
  1. Encabezados con `/^#{2,3}\s+(?:Aprendizajes(?:\s+Clave)?|Key\s+Learnings?|Learnings?):?\s*$/gim`. Sin encabezados → `[]`.
  2. Se recorren de **el último al primero**. La sección es el texto tras el encabezado hasta el siguiente `\n#{1,3} ` (exclusive) o el final.
  3. Elementos numerados `/^\s*\d+[.)]\s+(.+)/gm`; cada uno pasa por `cleanMarkdown` y se acepta si ocupa **≥ 20 bytes** y tiene **≥ 4 palabras**. Si no hay ninguno aceptado, se prueban las viñetas `/^\s*[-*]\s+(.+)/gm` con la misma regla.
  4. La primera sección (empezando por la última) con algún elemento aceptado devuelve esa lista.
- `passiveCapture(store, { session_id, content, project, source })` → `{ extracted, saved, duplicates }`: `extracted` = nº de aprendizajes. Para cada uno: si ya existe una observación viva con el mismo `normalized_hash` y el mismo proyecto (`ifnull(project,'') = ifnull(?, '')`, sin mirar tipo ni ámbito) cuenta como duplicado; si no, guarda con `addObservation` `{ type: 'passive', title, content: aprendizaje, project, scope: 'project', tool_name: source }`, donde el título es el aprendizaje, o sus primeros 60 bytes (`cutBytes`) más `...` si ocupa más de 60 bytes. Un fallo de guardado lanza `StoreError('passive_capture_failed', 'passive capture save: <mensaje>')` con `cause` y `result` (el progreso hasta ese momento).
- `classifyTool(name)`: `write|edit|patch` → `file_change`; `bash` → `command`; `read|view` → `file_read`; `grep|glob|ls` → `search`; otro → `tool_use`.

## `consolidate.js`

Fusiona varias observaciones en una nueva. Constantes: `CONSOLIDATED_FROM_MARKER = '## consolidated_from'`, `CONSOLIDATE_FINGERPRINT_VERSION = 'consolidate:v2'`.

`consolidateObservations(store, { ids, overrides, confirm, fingerprint, expected_project })` → `{ plan, survivor? }`:

1. `expected_project` (si se da) pasa por `validateExpectedProject`. `ids.length < 2` → `consolidate_need_two_sources`; ids repetidos → `consolidate_duplicate_id`.
2. **Plan** (`buildPlan`, dentro de una transacción):
   - Lee cada fuente viva (si no existe → `consolidate_missing_observation`) y las ordena por `created_at` descendente y, a igualdad, `id` descendente.
   - Proyecto de cada fuente: el suyo o el de su sesión, normalizado; vacío → `project_required`; si difiere del de la primera → `consolidate_cross_project`. Se asigna a `src.project`.
   - Ciclo de procedencia: para cada fuente, busca con `/obs-[0-9a-f]+/g` en lo que sigue al marcador `## consolidated_from` de su contenido; si algún `sync_id` pertenece al lote → `consolidate_provenance_cycle`.
   - `survivor`: `session_id` y `type` de la fuente más reciente (el tipo se puede sustituir con `overrides.type`), `scope = normalizeScope(scope de la más reciente)`, `project` canónico, `topic_key = normalizeTopicKey(overrides.topic_key)`, `title = overrides.title` o los títulos unidos con ` · `, y `content` = (`overrides.content` o los contenidos unidos con `\n\n`) sin saltos de línea finales + `\n\n## consolidated_from\n` + una línea `- <sync_id>\n` por fuente (en el orden del plan).
   - `fingerprint` = SHA-256 hexadecimal de `JSON.stringify({ version: 'consolidate:v2', sources: <fuentes ordenadas por id>, survivor })`. Es determinista: no depende del orden de `ids` y cambia si cambia cualquier fuente (incluido `pinned`) o el superviviente. No necesita coincidir con ninguna otra implementación: solo se compara plan contra confirmación.
   - Devuelve `{ ids, sources, survivor, project, fingerprint }`.
3. Sin `confirm`: devuelve `{ plan }` sin escribir (tras comprobar `expected_project`: distinto → `observation_project_mismatch`).
4. Con `confirm`, en `writeTransaction`: reconstruye el plan; comprueba `expected_project`; si `plan.fingerprint !== fingerprint` lanza `consolidate_fingerprint_mismatch` con la propiedad `plan` (el plan nuevo); si coincide, ejecuta:
   - `INSERT INTO observations (sync_id, session_id, type, title, content, tool_name, project, scope, topic_key, normalized_hash, revision_count, duplicate_count, last_seen_at, updated_at) VALUES (newSyncId('obs'), …, 'mem_consolidate', …, hashNormalized(content), 1, 1, datetime('now'), datetime('now'))` y anota el superviviente en el diario.
   - Para cada fuente, por `id` ascendente: `UPDATE observations SET deleted_at = datetime('now'), superseded_by_sync_id = <sync_id del superviviente>, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL` y anota el borrado en el diario.
   - Devuelve `{ plan, survivor }` con el superviviente leído de la base.

## Criterios de aceptación

```bash
node --test "test/unit/store/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

## Ampliaciones posteriores

- `passiveCapture` valida y propaga `project_provenance` a cada observación guardada (`09-procedencia.md`).
