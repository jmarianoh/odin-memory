# 10.3 — Búsqueda, línea de tiempo y prompts

Módulos: `src/store/search.js`, `src/store/prompts.js`; amplían `text.js` y `errors.js`.

## Ampliaciones de `errors.js`

Códigos nuevos del catálogo: `prompt_inbox_deleted` («prompt inbox identity was deleted»), `pulled_prompt_identity_invalid` («pulled prompt identity is invalid»), `invalid_match_mode` («invalid match_mode») y `search_failed` («search»).

## Ampliaciones de `text.js`

- `searchTerms(query)`: `goFields(query)`, quita las comillas `"` de ambos extremos de cada palabra y descarta las vacías.
- `hasShortFtsTerm(query)`: algún término tiene menos de 3 **caracteres** (puntos de código: `[...term].length`).
- `escapeLike(term)`: antepone `\` a `\`, `%` y `_`.
- `candidateTerms(title)`: para cada palabra de `goFields`, quita las comillas de los extremos (descarta vacías) y recorre sus caracteres: cada `"` se escribe como `""` y, si el siguiente carácter también es `"`, se salta (un par de comillas seguidas queda como un solo `""`); la palabra resultante se entrecomilla. **Difiere de `sanitizeFts`**, que duplica todas las comillas interiores.
- `sanitizeFtsCandidates(title)`: `candidateTerms(title).join(' OR ')`.

## `search.js`

Constantes: pesos `bm25` título 5.0, contenido 1.0, topic_key 3.0; refuerzos `PINNED_BOOST = 0.10`, `RECENCY_BOOST = 0.06`, `RECENCY_HALF_SCORE_DAYS = 30.0`, `STABILITY_BOOST = 0.04`, `STABILITY_DIMINISHING_SCALE = 4.0`; límite por defecto 10; clasificación de coincidencia directa `-1000`; vista previa de 300 caracteres.

### Opciones (`SearchOptions`)

`{ type, project, scope, limit, match_mode }`. `match_mode` admite `''`/`undefined`, `all` o `any`; otro valor → `StoreError('invalid_match_mode', 'invalid match_mode "<valor>": must be "all" or "any"')`. `project` se normaliza (`normalizeProject`). `limit` es `10` si no es positivo y nunca supera `settings.maxSearchResults`.

### `searchObservations(store, query, opts)` y `searchObservationPreviews(store, query, opts)`

Devuelven un arreglo de resultados; cada uno es la fila (con `pinned` booleano) más `rank`. Las vistas previas llevan `id, sync_id, type, title, preview, truncated, project, topic_key, scope, review_after, pinned, created_at, rank` (sin `content`); `preview = substr(content, 1, 300)` y `truncated = length(content) > 300` (booleano). Las completas llevan las columnas de `SELECT_COLUMNS` de observaciones, con `rank`. Ambas siguen el mismo algoritmo:

1. **Coincidencia directa por topic_key.** Si `query` contiene `/`: `SELECT <columnas> FROM observations o WHERE o.topic_key = ? AND o.deleted_at IS NULL` con la consulta **tal cual** (sin normalizar), más los filtros `AND o.type = ?`, `AND LOWER(o.project) = ?` y `AND o.scope = ?` (ámbito normalizado) si se indicaron, `ORDER BY o.updated_at DESC LIMIT ?`. Cada fila entra con `rank = -1000`. Un error en esta consulta se ignora.
2. **Consulta principal.**
   - Si `hasShortFtsTerm(query)`: **LIKE**. Para cada término, un grupo `(o.title LIKE ? ESCAPE '\' OR o.content LIKE ? ESCAPE '\' OR o.tool_name LIKE ? ESCAPE '\' OR o.type LIKE ? ESCAPE '\' OR o.project LIKE ? ESCAPE '\' OR o.topic_key LIKE ? ESCAPE '\')` con el patrón `%<escapeLike(término)>%` repetido 6 veces. Los grupos se unen con `AND` (o `OR` si `match_mode = 'any'`). Filtros `AND o.type = ?`, `AND LOWER(o.project) = ?`, `AND o.scope = ?`. Columna `0.0 AS rank`. `ORDER BY datetime(o.updated_at) DESC, o.id DESC LIMIT ?`.
   - Si no: **FTS**. Expresión = `sanitizeFtsCandidates(query)` si `match_mode = 'any'`, o `sanitizeFts(query)` en otro caso. Con `rawRank = bm25(observations_fts, 5.0, 1.0, 0.0, 0.0, 0.0, 3.0)`:
     ```sql
     SELECT <columnas>, <rawRank> AS rank
     FROM observations_fts fts CROSS JOIN observations o ON o.id = fts.rowid
     WHERE observations_fts MATCH ? AND o.deleted_at IS NULL [filtros]
     ORDER BY <rawRank> * (
         1.0
         + CASE WHEN o.pinned THEN 0.10 ELSE 0.0 END
         + 0.06 * (1.0 / (1.0 + MAX(0.0, julianday('now') - COALESCE(julianday(o.last_seen_at), julianday(o.updated_at), julianday(o.created_at), julianday('now'))) / 30.0))
         + 0.04 * ((MAX(0, COALESCE(o.revision_count, 0)) + MAX(0, COALESCE(o.duplicate_count, 0)))
                   / (MAX(0, COALESCE(o.revision_count, 0)) + MAX(0, COALESCE(o.duplicate_count, 0)) + 4.0))
       ) ASC,
       COALESCE(NULLIF(o.sync_id, ''), printf('%020d', o.id)) ASC, o.id ASC
     LIMIT ?
     ```
     Los números se escriben con un decimal (`5.0`, `1.0`, `3.0`, `30.0`, `4.0`) o dos (`0.10`, `0.06`, `0.04`) como arriba. `rank` devuelto es el `bm25` **sin reforzar** (menor = mejor).
   - Un error de SQLite aquí se relanza como `StoreError('search_failed', 'search: <mensaje>')`. Una consulta vacía produce ese error.
3. **Mezcla.** Primero las coincidencias directas; luego las de la consulta principal cuyo `id` no se haya visto; se recorta a `limit`.

### `timeline(store, observationId, before = 5, after = 5)`

`before`/`after` no positivos valen 5. La observación foco debe estar viva (`observation_not_found` con detalle `timeline: observation #<id>` si no). Devuelve:

- `focus`: la observación (con `pinned` booleano).
- `before`: hasta `before` observaciones vivas de la misma sesión con `id < foco`, `ORDER BY id DESC`, devueltas en orden cronológico (se invierte el resultado).
- `after`: hasta `after` con `id > foco`, `ORDER BY id ASC`.
- Cada entrada tiene `id, session_id, type, title, content, tool_name, project, scope, topic_key, revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at, superseded_by_sync_id` e `is_focus: false`.
- `session_info`: `getSession(foco.session_id)` o `null`.
- `total_in_range`: número de observaciones vivas de la sesión.

## `prompts.js`

Columnas de prompt: `id, sync_id (''), session_id, content, project (''), created_at`.

- `addPrompt(store, { session_id, content, project, source_inbox_id })` → `{ id, inserted }`:
  1. `content = prepareStoredContent(...)`; vacío → `prompt_content_required`.
  2. En `writeTransaction`: `project = resolveWriteProject(db, session_id, normalizeProject(project))`.
  3. Con `source_inbox_id`: si existe una lápida en `prompt_tombstones` con ese (`session_id`, `source_inbox_id`) → `prompt_inbox_deleted`.
  4. `INSERT INTO user_prompts (sync_id, session_id, content, project, source_inbox_id, local_creation_session_id, local_creation_inbox_id, local_creation_project) VALUES (newSyncId('prompt'), …)`. Solo con bandeja se rellenan `local_creation_session_id = session_id`, `local_creation_inbox_id = source_inbox_id` y `local_creation_project = project`, y se añade `ON CONFLICT(session_id, source_inbox_id) WHERE source_inbox_id IS NOT NULL DO NOTHING`.
  5. Con bandeja y 0 filas afectadas: devuelve `{ id: <existente>, inserted: false }`.
  6. Si no: lee `created_at`, borra `prompt_tombstones WHERE sync_id = <nuevo>`, anota el prompt en el diario y devuelve `{ id, inserted: true }`.
- `recentPrompts(store, project = '', limit = 20)`: proyecto normalizado; `SELECT <cols> FROM user_prompts [WHERE project = ?] ORDER BY created_at DESC LIMIT ?`.
- `searchPrompts(store, query, project = '', limit = 10)`: el proyecto **no** se normaliza y el filtro es exacto.
  - Con término corto: `SELECT p.id, ifnull(p.sync_id,'') sync_id, p.session_id, p.content, ifnull(p.project,'') project, p.created_at FROM user_prompts p WHERE (<por término: (p.content LIKE ? ESCAPE '\' OR p.project LIKE ? ESCAPE '\')> unidos con AND) [AND p.project = ?] ORDER BY p.created_at DESC, p.id DESC LIMIT ?`.
  - Si no: `… FROM prompts_fts fts CROSS JOIN user_prompts p ON p.id = fts.rowid WHERE prompts_fts MATCH ? [AND p.project = ?] ORDER BY fts.rank LIMIT ?` con `sanitizeFts(query)`.
  - Los errores de SQLite se relanzan como `Error('search prompts: <mensaje>')`.
- `deletePrompt(store, id)`: borrado duro con lápida. En `writeTransaction`: lee `sync_id, session_id, project, source_inbox_id` o lanza `prompt_not_found` (`prompt #<id>`); el proyecto es el normalizado de la fila o, si falta, el de su sesión; `recordLocalPromptTombstone(...)`; `DELETE FROM user_prompts WHERE id = ?` (0 filas → `prompt_not_found`); anota el borrado en el diario.
  - `recordPromptTombstone(syncId, sessionId, project, inboxId, deletedAt)`: normaliza el proyecto; si ya hay lápida con ese `sync_id` y la nueva **contradice** su `session_id`, `source_inbox_id` o `project` (ambos no vacíos y distintos) → `pulled_prompt_identity_invalid` (`prompt tombstone "<sync_id>" conflicts with established identity`). Inserta `INSERT INTO prompt_tombstones (sync_id, session_id, project, source_inbox_id, deleted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sync_id) DO UPDATE SET session_id = COALESCE(NULLIF(excluded.session_id,''), prompt_tombstones.session_id), project = COALESCE(excluded.project, prompt_tombstones.project), source_inbox_id = COALESCE(excluded.source_inbox_id, prompt_tombstones.source_inbox_id), deleted_at = excluded.deleted_at`.
  - `recordLocalPromptTombstone(...)`: antes de registrar, mide si ya había lápida (`existing`) y cuántos prompts comparten el `sync_id` (`count`), y lee las columnas `local_creation_*` de la fila. Tras `recordPromptTombstone`, **solo** si `existing = 0`, `count = 1`, las tres marcas de creación local no están vacías y coinciden con la sesión, la bandeja y el proyecto del prompt, copia esas tres marcas a la lápida (`UPDATE prompt_tombstones SET local_creation_session_id = ?, local_creation_inbox_id = ?, local_creation_project = ? WHERE sync_id = ? AND` las tres son NULL).

## Criterios de aceptación

```bash
node --test "test/unit/store/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```
