# 10.4 — Relaciones y juicios

Módulos: `src/store/relation-udf.js`, `src/store/relations.js`; amplían `errors.js`, `db.js` e `index.js`.

Una **relación** une dos observaciones (por `sync_id`) y expresa si se refieren a lo mismo, se complementan o se contradicen. Al guardar una observación se buscan **candidatos** parecidos y se crea una relación `pending` con cada uno; el agente decide después el veredicto (**juicio**).

## Ampliaciones de `errors.js`

Códigos nuevos del catálogo: `cross_project_relation` («relation rejected: source and target observations are in different projects»), `relation_not_found` («relation not found»), `invalid_relation_verb` («invalid relation verb»), `invalid_confidence` («invalid confidence») y `relation_endpoint_required` («relation endpoint is required»). Las funciones de relaciones construyen el mensaje completo con `new StoreError(code, mensaje)` (ver abajo) para conservar los textos con prefijo (`JudgeRelation: …`).

## `relation-udf.js` — función SQL de relevancia

- `TERM_SEPARATOR = '\x1f'`.
- `saveCandidateTerms(title)`: pasa a minúsculas; separa con `/[^\p{L}\p{Nd}+#]+/u` (se conservan letras, dígitos decimales, `+` y `#`); descarta los vacíos, los que no contienen ninguna letra ni dígito (`/[\p{L}\p{Nd}]/u`) y las palabras vacías `a an the and or for to of in on with from by at as is are be was were we it this that use used using add added update updated fix fixed implement implemented`; elimina duplicados y ordena.
- `saveCandidateRelevant(sourceTerms, sourceTopic, title, topic)`: `true` si `sourceTopic !== ''`, `topic` no es nulo y son iguales; si no, calcula los términos de `title` y cuenta cuántos términos origen aparecen en ellos (`shared`); `true` si `shared >= 2` o si `shared === 1` y ambos conjuntos tienen exactamente un término.
- `registerSqlFunctions(raw)` registra en la conexión `odin_save_candidate_relevant(encodedTerms, sourceTopic, title, topic)` (determinista, 4 argumentos): `encodedTerms` son los términos origen unidos por `TERM_SEPARATOR` (vacío → ninguno); los argumentos que no son cadena se tratan como `''` (o `null` el último); devuelve `1` o `0`. `openDatabase` la registra tras los pragmas.

## `relations.js`

Constantes: `RELATION` (`pending related compatible scoped conflicts_with supersedes not_conflict`), `JUDGMENT_STATUS` (`pending judged orphaned ignored`), `VALID_RELATION_VERBS` (los seis verbos de juicio, sin `pending`), `SYSTEM_ACTOR = 'odin'`, `SYSTEM_KIND = 'system'`, `isValidConfidence(c)` (número finito en [0, 1]).

Columnas de relación: `id, sync_id, source_id (''), target_id (''), relation, reason, evidence, confidence, judgment_status, marked_by_actor, marked_by_kind, marked_by_model, session_id, created_at, updated_at`.

### `findCandidates(store, savedId, opts)` → `{ candidates, errors }`

Opciones: `project`, `scope`, `query`, `limit` (3 por defecto), `bm25_max_rank`, `bm25_floor`, `require_save_relevance`, `skip_insert`.

1. `bm25_max_rank` y `bm25_floor` juntos → error (`BM25MaxRank and deprecated BM25Floor cannot both be set`). Con `bm25_floor` el operador es `>=` y el umbral ese valor; si no, el operador es `<=` y el umbral `bm25_max_rank ?? 0`. Un umbral no finito → error (`BM25Floor must be finite` / `BM25MaxRank must be finite`).
2. Lee de la observación guardada `title, project (''), scope, sync_id (''), topic_key ('')`; si no existe → `observation_not_found` (`FindCandidates: observation <id> not found`). `project`/`scope` de las opciones, si vienen no vacíos, sustituyen a los de la observación.
3. Texto de búsqueda = `opts.query` si no está en blanco; si no, el título. `ftsQuery = sanitizeFtsCandidates(texto)`; vacío → `{ candidates: [], errors: [] }`.
4. Consulta (con `<op>` según el paso 1):
   ```sql
   WITH ranked AS MATERIALIZED (
     SELECT o.id, ifnull(o.sync_id,'') AS sync_id, o.title, o.type, o.topic_key, fts.rank AS score
     FROM observations_fts fts CROSS JOIN observations o ON o.id = fts.rowid
     WHERE observations_fts MATCH ?
       AND o.id != ?
       AND NOT EXISTS (SELECT 1 FROM memory_relations r
            WHERE ((r.source_id = ? AND r.target_id = ifnull(o.sync_id,'')) OR (r.source_id = ifnull(o.sync_id,'') AND r.target_id = ?))
              AND r.judgment_status = 'judged')
       AND o.deleted_at IS NULL
       AND ifnull(o.project,'') = ifnull(?,'')
       AND o.scope = ?
   )
   SELECT id, sync_id, title, type, topic_key, score FROM ranked WHERE score <op> ? ORDER BY score LIMIT ?
   ```
   Argumentos: `ftsQuery, savedId, sync_id, sync_id, project, scope, umbral, limit`. Con `require_save_relevance`, la primera aparición de `AND o.scope = ?` se sustituye por `AND o.scope = ?\n AND odin_save_candidate_relevant(?, ?, o.title, o.topic_key) = 1`, y se insertan antes del umbral los argumentos `saveCandidateTerms(texto).join(TERM_SEPARATOR)` y el `topic_key` de la observación guardada. Un error de SQLite → `StoreError('search_failed', 'FindCandidates: FTS5 query: …')`.
5. Sin filas → vacío. Con `skip_insert` → candidatos `{ id, sync_id, title, type, topic_key, score }` sin `judgment_id`.
6. Si no, para cada fila (cada inserción en su propia sentencia): `judgment_id = newSyncId('rel')` y
   ```sql
   INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status, created_at, updated_at)
   SELECT ?, ?, ?, 'pending', 'pending', datetime('now'), datetime('now')
   WHERE NOT EXISTS (SELECT 1 FROM memory_relations WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))
   ```
   con `(judgment_id, sync_id origen, sync_id candidato, origen, candidato, candidato, origen)`. Solo si se insertó 1 fila el candidato se devuelve (con `judgment_id`); un par que ya tiene cualquier relación, en cualquier sentido y estado, no se vuelve a ofrecer. Los fallos individuales se acumulan en `errors` sin abortar.

`mem_save` llama con `{ project, scope, require_save_relevance: true }`.

### Lectura

- `saveRelation(store, { sync_id, source_id, target_id })`: inserta una relación `pending` y la devuelve.
- `getRelation(store, syncId)`: fila de relación o `relation_not_found` (`GetRelation: relation "<id>" not found`).
- `getRelationByIntId(store, id)`: `id, sync_id, relation, judgment_status, source_id, source_title, target_id, target_title, created_at, updated_at`; los títulos salen de observaciones **vivas** (`''` si no); falta → `relation_not_found` (`GetRelationByIntID: relation id <id> not found`).
- `getRelationsForObservations(store, syncIds)`: `{}` si no hay ids. Una consulta con `LEFT JOIN observations` por ambos extremos, `WHERE (r.source_id IN (…) OR r.target_id IN (…)) AND r.judgment_status != 'orphaned'`. Cada fila lleva además `source_int_id` (0 si no existe), `source_title`, `source_missing` (booleano: no existe o está borrada) y lo mismo para el destino. El resultado es `{ [syncId]: { as_source: [], as_target: [] } }` (solo para los ids que aparecen).
- `listRelations(store, opts)` / `countRelations(store, opts)`: opciones `actionable_only`, `project`, `status`, `since_time`, `limit`, `offset`, `exclude_not_conflict`. Base: `FROM memory_relations r LEFT JOIN observations src ON src.sync_id = r.source_id AND src.deleted_at IS NULL LEFT JOIN observations tgt … WHERE 1=1`. Filtros: `actionable_only` añade el predicado «no es (pendiente **y** ambos extremos tienen proyecto efectivo **y** son distintos)», donde el proyecto efectivo es `coalesce(nullif(o.project,''), s.project, '')`; `project` → `(ifnull(src.project,'') = ? OR ifnull(tgt.project,'') = ?)`; `status` → `r.judgment_status = ?`; `since_time` → `r.created_at >= ?` con la fecha formateada `YYYY-MM-DDTHH:MM:SSZ` (la `T` se compara tal cual con el formato de la columna, que usa espacio: es el comportamiento heredado); `exclude_not_conflict` → `r.relation != 'not_conflict'`. El listado ordena `r.created_at DESC, r.id DESC` y aplica `LIMIT`/`OFFSET` si son positivos; `countRelations` usa `SELECT count(*)` sin orden ni paginación.

### Juicios

- `judgeRelation(store, p)` con `p = { judgment_id, relation, reason, evidence, confidence, marked_by_actor, marked_by_kind, marked_by_model, session_id }`:
  1. Verbo fuera de `VALID_RELATION_VERBS` → `invalid_relation_verb`: `JudgeRelation: invalid relation verb "<v>" — must be one of: related, compatible, scoped, conflicts_with, supersedes, not_conflict`.
  2. La relación debe existir → `relation_not_found`: `JudgeRelation: relation "<id>" not found`.
  3. En `writeTransaction`: proyecto de la observación origen (`coalesce(nullif(o.project,''), s.project, '')` por `sync_id`); guardia entre proyectos (ambos conocidos y distintos → `cross_project_relation`); `UPDATE memory_relations SET relation, reason, evidence, confidence, judgment_status = 'judged', marked_by_actor, marked_by_kind, marked_by_model, session_id, updated_at = datetime('now') WHERE sync_id = ?`. `reason`, `evidence` y `confidence` ausentes → NULL; `marked_by_actor` y `marked_by_kind` ausentes → `''` (no NULL); `marked_by_model` y `session_id` vacíos → NULL. Si el proyecto origen es vacío, avisa por `config.log` («JudgeRelation kept relation … local-only») y no anota nada; si no, anota la relación en el diario.
  4. Devuelve la relación actualizada.
- `judgeBySemantic(store, p)` con `p = { source_id, target_id, relation, confidence, reasoning, model }` → `sync_id`: valida `source_id` y `target_id` no vacíos (`relation_endpoint_required`: `JudgeBySemantic: SourceID is required` / `TargetID is required`), el verbo (`JudgeBySemantic: invalid relation verb …`) y la confianza (`invalid_confidence`: `JudgeBySemantic: confidence <v> is out of range [0.0, 1.0]`). En `writeTransaction`: guardia entre proyectos; busca una relación existente entre el par en cualquier sentido (`LIMIT 1`). Si no hay, inserta una `judged` con `newSyncId('rel')`, `confidence`, `reason = reasoning ?? ''`, `marked_by_actor = 'odin'`, `marked_by_kind = 'system'`, `marked_by_model = model` (NULL si vacío). Si hay, la actualiza con los mismos valores y fija `source_id`/`target_id` según la llamada. Anota la relación en el diario con el proyecto del origen (o el del destino si el origen no tiene).

## Criterios de aceptación

```bash
node --test "test/unit/store/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```
