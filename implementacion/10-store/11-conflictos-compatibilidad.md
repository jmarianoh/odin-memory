# 10.11 — Conflictos, cola de diferidos, compatibilidad y copia

Cuatro módulos de `src/store/` que se añaden en la entrega F4.3 (spec 0.17.0): `conflicts.js`, `sync-state.js` (ya descrito en `14-http-api/02-servidor-y-serve.md`), `compatibility.js` y `migrate-copy.js`. Todos exportan sus funciones desde `src/store/index.js`.

## `conflicts.js`

### Constantes

| Constante | Valor |
|---|---|
| `DEFAULT_SCAN_LIMIT` | 100 (observaciones por página de escaneo) |
| `SCAN_CANDIDATE_LIMIT` (interna) | 10 candidatos por observación |
| `CHUNK` (interna) | 500 elementos por lista `IN (…)` |
| `DEFAULT_DEAD_ROW_MAX_AGE_DAYS` | 30 |
| `DEFAULT_DEAD_ROW_MAX_PER_SCOPE` | 1000 |
| `RELATION_FK_MISSING_ERROR` | `relation FK precondition not met: referenced observation missing` |
| `RELATION_PROJECT_MISMATCH_ERROR` | `relation FK precondition not met: referenced observation effective project mismatch` |

### `countDeferredAndDead(store, targetKey = '', project = '') → { deferred, dead }`

Cuenta las filas de `sync_apply_deferred` con `apply_status` `deferred` y `dead`.

* Con `targetKey` no vacío (recortado, en minúsculas): añade `AND target_key = ? AND scope_class != 'legacy_unscoped'`.
* Con `project` (normalizado) no vacío: añade `AND project = ? AND scope_class = 'scoped'`.

### `listDeferred(store, { status, limit, offset }) → DeferredRow[]` y `getDeferred(store, syncId)`

`ORDER BY first_seen_at`; `limit`/`offset` solo si son positivos. `getDeferred` lanza `StoreError('deferred_not_found', 'GetDeferred: deferred row "<id>" not found')`.

Forma de una fila (`toDeferredRow`), claves en este orden:

```
sync_id, entity, target_key, project, scope_class,
remote_seq        (solo si ≠ 0)
entity_key        (solo si no vacío)
op                (solo si no vacío)
reason_code       (solo si no vacío)
payload           (solo si la carga es un objeto JSON con al menos una clave)
payload_raw       (el texto guardado)
payload_valid     (true si es un objeto JSON o el literal null; false si no es JSON o es un array/escalar)
apply_status, retry_count,
last_error        (solo si no es NULL)
last_attempted_at (solo si no es NULL)
first_seen_at
```

### `getActionableRelationStats(store, project = '')`

```js
{ project, by_relation: { <verbo>: n }, by_judgment_status: { <estado>: n }, deferred, dead }
```

Agrupa `memory_relations` por `(relation, judgment_status)` uniendo las observaciones origen y destino **vivas**; aplica el predicado de «accionable» (el mismo de `listRelations`: omite los pares **pendientes** entre proyectos conocidos distintos), excluye `relation = 'not_conflict'` y, si hay `project`, exige que el origen o el destino sean de ese proyecto. `deferred` y `dead` salen de `countDeferredAndDead(store, '', project)`.

### `scanProject(store, opts, allProjects = false)` (asíncrona) y `scanAllProjects`

Recorre **una página** de observaciones vivas ordenadas por id y busca pares candidatos a contradicción.

Opciones: `project` (nombre exacto; se ignora con `allProjects`), `since` (`Date`), `limit` (1..100, por defecto 100), `cursor` (último id visto, ≥ 0), `apply`, `max_insert` (por defecto 100), `semantic`, `concurrency` (5), `timeout_per_call_ms` (60000), `max_semantic` (100), `runner` (`{ compare(prompt, signal) }`), `build_prompt(a, b)`.

Validaciones (`StoreError`): `invalid_scan_limit` (`ScanProject: limit must be between 1 and 100`), `invalid_scan_cursor` (`ScanProject: cursor must be non-negative`), `semantic_runner_required` (`semantic scan requires a non-nil Runner`), `semantic_prompt_builder_required` (`semantic scan requires a non-nil BuildPrompt function`).

Algoritmo:

1. **Página.** `SELECT id, sync_id, scope, title, project FROM observations WHERE deleted_at IS NULL [AND ifnull(project,'') = ?] [AND created_at >= <since en ISO UTC sin fracción, con Z>] AND id > ? ORDER BY id LIMIT limit+1`. Si vuelve `limit+1` filas, hay más páginas y se recorta a `limit`.
2. **Candidatos por lotes** (`scanCandidateBatch`), una vez por página:
   * por cada término distinto de los títulos de la página (`candidateTerms(title)`: las palabras entrecomilladas para FTS5), una consulta `SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?`;
   * los metadatos de todos los ids encontrados (vivos), por lotes de 500;
   * los pares ya **juzgados** (`judgment_status = 'judged'`, en cualquier sentido) de los `sync_id` de la página;
   * por cada fuente: puntúa cada candidato por el número de términos distintos del título de la fuente que lo encuentran; descarta a sí misma, otro proyecto, otro ámbito (`scope`) y pares juzgados; ordena por puntuación descendente y, a igualdad, id ascendente; recorta a 10.
   * Si el lote falla, se registra por `store.config.log` y se usa el camino heredado: `findCandidates(store, id, { project, scope, limit: 10, skip_insert: true })` por observación (un fallo de una observación la omite).
3. Contadores: `inspected` y `ranked_queries` suben por observación; `candidates_found` suma los candidatos.
4. **Semántico** (`semantic`): acumula los pares sin repetir (clave desordenada) hasta `max_semantic` (al alcanzarlo con más pares pendientes: `capped = true` y se corta); cada par lleva los fragmentos `{ id, sync_id, title, type, content }` leídos de la base. Si no se puede leer el fragmento de la fuente (error o fila inexistente), se omite la observación entera; si no se puede leer el de un candidato, se omite ese par. En ambos casos se registra por `store.config.log` como `[store] ScanProject: source snippet obs=<sync_id>: <error>` o `[store] ScanProject: candidate snippet obs=<sync_id> cand=<sync_id>: <error>`, y el par no llega al juez. La clave del par solo se recuerda si el par se acumula.
5. **Aplicar** (sin `semantic`, con `apply`): si `inserted >= max_insert` y aún hay candidatos → `capped` y corte. Por cada candidato: si ya existe cualquier relación entre ambos en cualquier sentido → `already_related++`; si no, inserta una relación `pending/pending` (`rel-…`) y `inserted++`; al llegar `inserted === max_insert` con más candidatos de esa observación por procesar → `capped` y corte.
6. `next_cursor` = último id de la página, solo si hay más páginas **y no** `capped` (una página topada no tiene continuación: se repite desde el mismo cursor con un tope mayor).
7. **Veredictos** (`judgeSemanticPairs`): un grupo de `min(concurrency, pares)` consumidores toma pares de una cola; cada llamada recibe `AbortSignal.timeout(timeout_per_call_ms)`. Por par: veredicto `not_conflict` válido sin `apply` → `semantic_skipped`; sin `apply` y verbo/confianza válidos → `semantic_judged` sin persistir; en los demás casos `judgeBySemantic(store, …)` (crea o actualiza la relación como `judged`) y `semantic_judged`; cualquier excepción (también del constructor del prompt o del ejecutor) → `semantic_errors`, registrada por `store.config.log` como `[store] ScanProject: semantic pair=(a,b) error: …`.

Resultado: `{ project, inspected, ranked_queries, candidates_found, already_related, inserted, capped, dry_run, semantic_judged, semantic_skipped, semantic_errors [, next_cursor] }`. `dry_run = !apply`.

### `pruneDeadRows(store, { max_age_days, max_per_scope, apply })`

Acota el crecimiento de las filas **muertas** (`apply_status = 'dead'`) de `sync_apply_deferred`. Errores: `max_age_days` o `max_per_scope` no positivos → `StoreError('invalid_prune_limit', 'prune dead rows: max age days must be positive' | 'prune dead rows: max per scope must be positive')`.

Selecciona (con `ROW_NUMBER() OVER (PARTITION BY target_key, project ORDER BY first_seen_at DESC, sync_id DESC)`) las filas más antiguas que `max_age_days` **o** por encima del tope de su ámbito. **Nunca** toca filas diferidas ni relaciones muertas potencialmente recuperables: `scope_class = 'scoped' AND project <> '' AND entity = 'relation' AND retry_count = 5 AND last_error IN (RELATION_FK_MISSING_ERROR, RELATION_PROJECT_MISMATCH_ERROR) AND sync_id = payload_sync_id AND entity_key = payload_sync_id AND op = 'upsert'`; se excluyen **antes** de numerar, para que no desplacen evidencia terminal del tope.

Con `apply` borra en una transacción de escritura, por lotes de 500 y con la guarda `apply_status = 'dead'` en el `DELETE` (una fila rearmada como diferida queda fuera). Devuelve:

```js
{ applied, total,
  scopes:  [{ target_key, project, by_age, by_cap }],            // por ámbito; una fila vencida cuenta como by_age aunque también exceda el tope
  reasons: [{ entity, reason_code, age_bucket, count }] }        // age_bucket: '0-6d' | '7-29d' | '30d+' | 'unknown' (edad negativa o no calculable)
```

Orden: `scopes` por `target_key` y `project`; `reasons` por `entity`, `reason_code` y orden de cubo (`0-6d`, `7-29d`, `30d+`, `unknown`).

## `compatibility.js`

`COMPATIBILITY_REVISION = 1` describe este contrato, no una versión de la herramienta ni del esquema.

### `probeCompatibility(dir)` — observación sin abrir

Solo lee metadatos del sistema de archivos, la cabecera de 100 bytes de SQLite y la identidad local; nunca abre la base con SQLite. Devuelve `{ revision, source: 'offline', status, offline_automatic_opening_authorized: false, active_reuse_authorized: false [, instance_id] }`. Cualquier anomalía lanza el mismo mensaje: `compatibility: unsafe or invalid fixture metadata`.

1. `dir` debe ser absoluta y ya limpia (sin barra final, `.`, `..`); se resuelve con `realpath` (los alias del directorio valen).
2. Debe ser un directorio. Se toma una *instantánea* de metadatos (nombre, dispositivo, inodo, modo, tamaño, mtime) de sus entradas.
3. Rechaza cualquier entrada que termine en `-wal`, `-shm` o `-journal`, o en `.db` distinta de `odin.db`.
4. Sin `odin.db`: el directorio debe estar **vacío** → `status: "fresh"`.
5. Con `odin.db`: archivo regular; `.instance-id` archivo regular de ≤ 128 bytes con 32 hexadecimales en minúscula (se devuelve como `instance_id`); cabecera de 100 bytes: empieza por `SQLite format 3\0`, mismo inodo que el `lstat`, tamaño de página (bytes 16–17 big-endian, `1` = 65536) potencia de dos entre 512 y 65536 y divisor del tamaño del archivo, bytes 18 y 19 (versiones de formato) en {1, 2}.
6. `status`: según `user_version` (bytes 60–63): mayor que el esquema soportado → `future_schema`; menor → `legacy_schema`; igual → `unknown_shape` (la cabecera no prueba la forma, así que nunca hay «forma conocida»).
7. Se vuelve a tomar la instantánea y debe ser idéntica.

### `activeCompatibility(store)`

`{ revision: 1, source: 'active', status: 'unknown', offline_automatic_opening_authorized: false, active_reuse_authorized: false }` por defecto. Pasa a `status: 'ready'`, `active_reuse_authorized: true` y añade `instance_id`, `runtime_id` (`store.runtimeId`) y `capability: 'startup-verified-store-v1'` solo si el almacén existe, no está cerrado (`store.closed`), tiene `runtimeId`, una identidad válida y `store.generation.check()` no lanza `DatabaseGenerationChangedError`. Requiere el campo `store.closed` (se pone a `true` en `Store.close()`).

## `migrate-copy.js`

`migrateCopy(source, output, confirmed)` copia por completo un almacén **detenido** a un directorio nuevo y migra solo la copia. Nunca abre el origen con SQLite. El operador debe haber detenido todo cliente y conservar el control exclusivo de ambos directorios durante la copia y cualquier promoción posterior.

Orden y mensajes de error (`Error`):

1. `confirmed` falso → `--confirm-quiescent is required; stop every source client first`.
2. `canonicalPath` de cada ruta: no absoluta → `data and output directories must be absolute paths`; enlace simbólico en cualquier componente existente → `symlink path component is not allowed: <ruta>`; un componente existente que no es directorio → `non-directory path component: <ruta>`; error de `lstat` (salvo `ENOENT`) → texto `fsErrorText`.
3. Origen y salida disjuntos por nombre (en ambos sentidos) → `source and output must be disjoint directories`; la salida no puede existir (`output directory must not exist`); el origen debe existir y ser directorio (`source must be a directory`); y ningún ancestro existente de la salida puede ser **el mismo directorio físico** (dispositivo + inodo) que el origen (alias de mayúsculas) → el mismo mensaje de «disjoint».
4. Manifiesto del origen (`manifestOf`): recorre el árbol; solo directorios y archivos regulares (`unsafe source entry: <ruta>`); rechaza `*-journal` (`rollback journals are not supported: <relativa>`); guarda modo, tamaño, mtime en ns, dispositivo, inodo y SHA-256 de cada archivo.
5. Debe existir `odin.db` (`source has no odin.db`) y `.instance-id` válido (`source instance identity: <causa>` / `source instance identity is invalid`).
6. Crea la salida con modo `0700` y, **a partir de aquí**, cualquier fallo se relanza como `<causa>; incomplete output retained at <salida>; do not use or promote it` (la salida no se borra).
7. Copia (`copyDirectory`) verificando que cada entrada sigue siendo la del manifiesto: directorios con `0700`; archivos con creación exclusiva `0600`, `fsync`, comprobación de la huella (`source bytes changed: <relativa>`) y permisos finales iguales a los del origen. **No copia `odin.db-shm`** (SQLite lo regenera).
8. Comprueba la cabecera de la copia (`invalid database header`) y la abre **solo lectura** con SQLite (lee el WAL copiado): `PRAGMA user_version` debe ser el esquema soportado (`unsupported database schema version: N`), `PRAGMA integrity_check` debe dar una sola fila `ok` (`database integrity check failed` / `…returned no verdict`) y el **catálogo** (`sqlite_schema`: nombre, tipo, tabla, SQL con espacios fuera de comillas colapsados y las definiciones de columnas de cada `CREATE TABLE` ordenadas como conjunto) debe ser idéntico al de una base recién creada por esta versión (`unsupported database catalog; use a core supporting this store's exact shape`). No se admiten catálogos de otras versiones.
9. Vuelve a tomar el manifiesto del origen: debe ser idéntico (`source changed during copy`).
10. Abre la copia con `Store.open` (migra), repite `integrity_check`, comprueba que la identidad no cambió (`destination instance identity changed`) y la cierra.
11. Último manifiesto del origen idéntico (`source changed during migration`).

Devuelve `{ source_dir, output_dir, instance_id, migration_completed: true }`.
