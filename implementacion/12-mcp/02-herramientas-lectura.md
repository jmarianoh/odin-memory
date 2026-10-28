# 12.2 — Herramientas de lectura

Módulos: `src/mcp/tools/{projects,context,search}.js`. Los esquemas de parámetros, descripciones y anotaciones de cada herramienta están en `tool-definitions.js` (copiado de `fuentes/`); aquí se especifica el **comportamiento**. Cada herramienta es una función `(ctx) => (args) => resultado`, con `ctx = { store, config, activity, env }`.

Convenciones comunes:

- Toda respuesta correcta que depende del proyecto usa `respondWithProject` (`01-protocolo-y-servidor.md`): `{ project, project_source, project_path, result, ... }`.
- Un error de proyecto (desconocido, ambiguo, configuración inválida…) se devuelve con `readProjectErrorResult`. Un error de uso (argumento ausente o inválido) es **texto plano** con `isError: true` (`errorResult`).
- El proyecto se normaliza con `normalizeProject(res.project ?? '').normalized` (`src/project/canonical.js`) antes de usarlo como filtro.
- `sessionId` de actividad = `defaultSessionId(proyecto)`.
- «Aviso de guardado» = `activity.nudgeIfNeeded(sessionId, proyecto)` (`''` o el texto de aviso).

## `mem_current_project`

Argumentos: `directory` y su alias `cwd`.

1. `cwd = process.cwd()`; si `directory` (recortado) no es vacío se usa; si no, `cwd` (recortado) si no es vacío.
2. Si hay proyecto fijado para el proceso (`processOverride(config.defaultProject, env).ok`): resuelve con `resolve({ mode: 'current', processOverride, env })`; un error se devuelve como resultado `{ source: 'process_override', error }`.
3. Si no: `detectProject(store, cwd, { requireExplicitHomeProject: true })` (detección con historial, exigiendo proyecto explícito en el directorio personal).
4. Respuesta: **texto JSON** (no usa `result`): `{ project, project_source, project_path, cwd, available_projects, warning?, error_hint? }`, con `available_projects` `null` si no hay y `error_hint` = mensaje del error si lo hubo. Nunca es `isError`.

## `mem_list_projects`

Sin argumentos. `{ projects: listProjectsWithStats(store), count }` en JSON ordenado (sin envelope de proyecto).

## `mem_suggest_topic_key`

Argumentos `type`, `title`, `content` (texto). Si `title` y `content` recortados están vacíos → error de uso `provide title or content to suggest a topic_key`. Calcula `suggestTopicKey(type, title, content)` (`10-store/02`); si diera vacío → `could not suggest topic_key from input`. Éxito: texto plano `Suggested topic_key: <clave>`.

## `mem_stats`

Argumento opcional `project`. Si hay `project` (recortado no vacío) o proyecto fijado para el proceso, se resuelve con `resolveReadProject` (un error → `readProjectErrorResult`); si no, el origen es `all_projects`. Resultado (envelope):

```
Memory System Stats:
- Sessions: <n>
- Observations: <n>
- Prompts: <n>
- Projects: <nombres separados por ", " o "none yet">
```

Las estadísticas son **globales** (`stats(store)`); el proyecto solo etiqueta el envelope. `Projects` lista los proyectos que tienen observaciones.

## `mem_context`

Argumentos: `project`, `scope`, `max_bytes`, `compact`, `older_history`.

1. Resuelve el proyecto (`resolveReadProject`); error → `readProjectErrorResult`.
2. `contextProject` es `''` (todos) si `scope === 'personal'` y no se pasó `project`; si no, el proyecto normalizado.
3. `activity.recordToolCall(sessionId)`.
4. `maxBytes` = `memContextMaxBytes(args.max_bytes)`: un número entero positivo, con tope **65536**; cualquier otro valor (ausente, 0, negativo, decimal, cadena) → **16384**. Constantes: `MEM_CONTEXT_DEFAULT_MAX_BYTES`, `MEM_CONTEXT_MAX_BYTES_CEILING`, `MEM_CONTEXT_MAX_PINNED = 20`, `MEM_CONTEXT_MAX_STATS_PROJECTS = 8`.
5. Pie: `\n---\nMemory stats: <sesiones> sessions, <observaciones> observations across projects: <lista>` + aviso de guardado. `<lista>` = `none` si no hay; hasta 8 nombres unidos por `, `; con más, los 8 primeros más `, +<resto> more`.
6. Presupuesto para el contexto = `max(1, maxBytes - bytes(pie))`; `formatContext(store, contextProject, scope, { max_bytes: presupuesto, pinned: 20, compact, older_history })` (`10-store/06`).
7. Si el contexto es vacío → resultado `No previous session memories found.` (sin pie), recortado a `maxBytes`. Si no, `contexto + pie` recortado a `maxBytes` con `limitContextBytes` (añade el marcador de truncado).

## `mem_search`

Argumentos: `query`, `type`, `project`, `scope`, `match_mode`, `response_format`, `all_projects`, `limit` (por defecto 10).

Validaciones (error de uso): `match_mode` distinto de vacío/`all`/`any` → `invalid match_mode "<v>": must be "all" or "any"`; `response_format` distinto de vacío/`compact` → `invalid response_format "<v>": must be "compact"`.

Proyecto: con `all_projects` el origen es `all_projects` y no hay proyecto; si no, `resolveReadProject`. El filtro es `''` si `scope === 'personal'` sin `project` explícito; si no, el proyecto normalizado. Se registra `recordToolCall`.

Búsqueda: `searchObservationPreviews(store, query, { type, project, scope, limit, match_mode })`; si lanza → error de uso `Search error: <mensaje>. Try simpler keywords.`. Sin resultados → envelope con `No memories found for: "<consulta>"`. Relaciones: `searchPreviewRelations`.

**Formato compacto** (`response_format: "compact"`): `result` = `Found <n> memories.` + aviso; `results` = `compactSearchProjection(resultados, relaciones)` donde cada entrada con relaciones lleva `relations: relationsJson(...)`.

**Formato completo**: `Found <n> memories:\n\n` y, por resultado `i` (desde 1):

```
[i] #<id> (<tipo>) — <título>
    <vista previa>[ [preview]]
    <fecha local> | project: <p> | scope: <ámbito>[ | state: needs_review]
    [líneas de relación]

```

- `[preview]` se añade a la vista previa si estaba truncada; la parte `| project: <p>` solo si el resultado tiene proyecto.
- `state` = `observationState(review_after)`; solo se muestra `needs_review`.
- Líneas de relación (cuatro espacios de sangría), en este orden: primero las relaciones donde el resultado es **origen**: `supersedes: #<id> (<título>)` si la relación es `supersedes` y está `judged`; `conflicts: #<id> (<título>)` si es `conflicts_with` y `judged`; `conflict: contested by #<target_id> (pending)` si está `pending`. Después las de **destino**: `superseded_by: #<id> (<título>)` (`supersedes` + `judged`) o `conflict: contested by #<source_id> (pending)` (`pending`). El título es `deleted` si el lado falta o está vacío.
- Si algún resultado estaba truncado se añade `---\nResults above are previews (300 chars). To read the full content of a specific memory, call mem_get_observation(id: <ID>).\n`, y al final el aviso de guardado.
- `results` (estructurado): por resultado `{ id, sync_id, title, type, state, scope, pinned }` más `project`, `topic_key` (si no es vacío) y `review_after` cuando existen.

## `mem_search_prompts`

Argumentos: `query` (obligatorio), `project`, `all_projects`, `limit` (10).

Validaciones, en este orden, todas error de uso: `query` no es cadena o es vacía → `query parameter is required`; si la clave `project` está presente y no es una cadena con contenido → `project must not be blank`; si `all_projects` está presente y no es booleano → `all_projects must be a boolean`; `all_projects` verdadero con `project` → `project and all_projects cannot be used together`.

Con `all_projects` el origen es `all_projects` (sin filtro de proyecto); si no, `resolveReadProject`. `searchPrompts(store, query, proyecto, limit)`; un fallo → `Search prompts error: <mensaje>`. Respuesta: `Found <n> stored prompts.` y `results: prompts.map(promptJson)`.

## `mem_get_observation`

Argumentos: `id` (entero, obligatorio), `project`, `include_history`, `history_cursor`.

1. `id` 0 o ausente → `id is required`. No existe → `Observation #<id> not found`.
2. El proyecto se resuelve con `resolveReadProject` y, si falla por ambigüedad y la observación tiene proyecto propio, se usa ese (`storedProjectFallback`). El error de proyecto, si persiste, se devuelve **después** de preparar el historial.
3. Texto: `#<id> [<tipo>] <título>\n<contenido>\nSession: <sesión>` + `\nProject: <p>` (si tiene) + `\nScope: <ámbito>` + `\nTopic: <clave>` (si tiene) + `\nTool: <herramienta>` (si tiene) + `\nDuplicates: <n>\nRevisions: <n>\nCreated: <fecha local>`.
4. Con `include_history`: `historyCursorArg` (error → su mensaje como error de uso); `getObservationVersionPage(store, id, 50, cursor)` (fallo → `Failed to read observation history: <mensaje>`). El envelope añade `version_count` (total real) e `history` (lista de `{ version, title, content, created_at }`, de la más antigua a la más reciente de la página). Si hay versiones se añade al texto `\n\nHistory (<n> previous version[s]):` —o, si hay más páginas, `\n\nHistory (<n> of <total> previous versions — older versions omitted):`— y por versión `\n\n--- Version <v> (<fecha local>) ---\n<título>\n<contenido>`. Con más páginas, el envelope añade `history_truncated: true`, `history_from_version` (primera versión de la página) e `history_cursor` (`next_cursor`).

## `mem_timeline`

Argumentos: `observation_id` (obligatorio), `before` (5), `after` (5), `project`.

`observation_id` 0 → `observation_id is required`; error de proyecto → `readProjectErrorResult`; observación inexistente → `Timeline error: observation not found`; si su proyecto no coincide (sin distinguir mayúsculas, recortado) con el resuelto → `Timeline error: observation not found in resolved project`. Un fallo de `timeline(store, id, before, after)` → `Timeline error: <mensaje>`.

Texto (en este orden, omitiendo lo vacío):

```
Session: <proyecto> (<inicio>) — <resumen truncado a 100>      (solo si hay sesión; " — resumen" solo si lo tiene)
Total observations in session: <n>

─── Before ───
  #<id> [<tipo>] <título> — <contenido truncado a 150>

>>> #<id> [<tipo>] <título> <<<
    <contenido truncado a 500>
    <fecha local>

─── After ───
  #<id> [<tipo>] <título> — <contenido truncado a 150>
```

`truncate` es el de `src/store/text.js`. Los bloques `Before`/`After` solo aparecen si tienen entradas.

## Verificación

El oráculo son las pruebas de `test/unit/mcp/tools.test.js`: cubren la búsqueda (formatos completo y compacto, validaciones), `mem_get_observation` con historial, `mem_timeline`, la validación de `mem_search_prompts`, el presupuesto de `mem_context`, `mem_stats`, `mem_list_projects`, `mem_suggest_topic_key` y `mem_current_project`. Las líneas de relación de `mem_search` se especifican arriba; si se implementan desde este capítulo, compruébalas además a mano con una relación `supersedes` juzgada y un conflicto pendiente. Cualquier diferencia de formato con este capítulo debe resolverse corrigiendo el código, no la prueba.
