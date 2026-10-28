# 10.10 — Exportación, importación y borrado de sesiones

Módulos: `src/store/backup.js`, `src/store/session-delete.js`; cambios menores en `observations.js` (exporta `SELECT_COLUMNS` y `toObservation`), `prompts.js` (exporta `recordPromptTombstone` y `recordLocalPromptTombstone`), `errors.js` e `index.js`.

La **copia directa** exporta la base entera (o un proyecto) a un JSON y la reimporta en otra instalación. Es distinta de la sincronización (cuyos trozos tienen otro formato). Conserva sesiones, observaciones (con su estado fijado), prompts, lápidas de prompts y relaciones.

## Formato (versión `0.2.0`; `0.1.0` también se importa)

Objeto con las claves **en este orden**:

| Clave | Contenido | Si está vacío |
|---|---|---|
| `version` | `"0.2.0"` | — |
| `exported_at` | marca de tiempo `now()` | — |
| `sessions` | sesiones | `null` |
| `observations` | observaciones, también las borradas suavemente | `null` |
| `prompts` | prompts | `null` |
| `relations` | relaciones | se omite |
| `prompt_tombstones` | lápidas de prompts | se omite |

Campos de cada elemento (en este orden; los marcados `?` se omiten si son nulos o vacíos):
- **Sesión**: `id`, `project`, `ownership_mode?` (omitido si es cadena vacía), `directory`, `started_at`, `ended_at?`, `summary?`.
- **Observación**: `id`, `sync_id`, `session_id`, `type`, `title`, `content`, `tool_name?`, `project?`, `scope`, `topic_key?`, `revision_count`, `duplicate_count`, `last_seen_at?`, `review_after?`, `superseded_by_sync_id?`, `created_at`, `updated_at`, `deleted_at?`, `pinned` (siempre, booleano).
- **Prompt**: `source_inbox_id?` (omitido si es vacío; va **primero**), `id`, `sync_id`, `session_id`, `content`, `project?` (omitido si es vacío), `created_at`.
- **Relación**: `sync_id`, `source_id`, `target_id`, `relation`, `reason?`, `evidence?`, `confidence?`, `judgment_status`, `marked_by_actor?`, `marked_by_kind?`, `marked_by_model?`, `session_id?`, `superseded_at?`, `superseded_by_relation_sync_id?` (el `sync_id` de la relación que la sustituye), `created_at`, `updated_at`.
- **Lápida**: `sync_id`, `session_id`, `project` (siempre; puede ser `""`), `source_inbox_id?` (omitido si es vacío), `deleted_at`.

La escritura usa sangrado de 2 espacios y escapa `<`, `>`, `&`, U+2028 y U+2029 como `<` etc. (`toGoJson(valor, 2)`).

## `backup.js`

- `exportData(store, project = '')`: lee todo dentro de una transacción de lectura. Con `project` (ya normalizado) se filtra así:
  - sesiones: las del proyecto, más las de cualquier observación o prompt del proyecto; se ordenan por `started_at`;
  - observaciones: las del proyecto más las sin proyecto de sesiones del proyecto; orden por `id`;
  - prompts: igual que las observaciones; orden por `id`;
  - lápidas: dueño = `coalesce(nullif(t.project,''), nullif(s.project,''), proyecto activo de la lápida de borrado de la sesión, '')` igual al proyecto; orden por `sync_id`;
  - relaciones: las que tienen **ambos** extremos entre las observaciones del proyecto; orden por `created_at, sync_id`.
  Sin proyecto no se filtra nada. Devuelve `{ version, exported_at, sessions, observations, prompts, prompt_tombstones, relations }` con listas (vacías si no hay).
- `exportProject(store, project)`: normaliza y recorta; vacío → `StoreError` `project_required` con `project is required`.
- `exportToJsonValue(data)` → objeto con la forma del formato (claves en orden, nulos omitidos, listas vacías según la tabla).
- `toGoJson(valor, indent = 0)`: `JSON.stringify` más los escapes anteriores.
- `parseExportData(texto)` → datos listos para importar. `JSON.parse` falla con su propio error; un valor de tipo equivocado lanza `StoreError` `invalid_export` (`invalid export: <ruta> must be <tipo>, got <tipo>`). Reglas: la raíz y cada elemento son objetos; las listas pueden faltar o ser `null`; los textos ausentes son `""` y los opcionales ausentes son `null`; los enteros ausentes son 0; `pinned` es verdadero solo si es `true`; **si una sesión trae `directory`, debe ser cadena** (`import session "<id>": directory must be a JSON string`), y si falta se toma `""`.
- `normalizeComparableTimestamp(valor)`: recorta y acepta `YYYY-MM-DD HH:MM:SS[.fracción]` (UTC), RFC 3339 (`...T...Z` o con desfase) y `YYYY-MM-DD`; devuelve UTC como `YYYY-MM-DD HH:MM:SS.fffffffff` (9 decimales, la fracción se trunca/rellena) o `""` si no se reconoce o la fecha no existe.
- `isStalePromptUpsert(createdAt, borradoEn)`: verdadero si alguna fecha no es comparable o `createdAt <= borradoEn`.
- `preserveObservationProvenance(db, syncId, entrante)`: fija `superseded_by_sync_id` de la observación al enlace entrante si no está vacío; si no, al que ya tenía o, en su defecto, al de su lápida de borrado de sincronización.
- `importData(store, datos)` → `{ sessions_imported, observations_imported, observations_updated, observations_skipped_stale, prompts_imported }`. Errores `StoreError` `import_failed` con el mensaje indicado. Antes de abrir la transacción se valida: versión (`""`, `0.1.0` o `0.2.0`; otra → `import: unsupported export version "<v>"`), y cada sesión (id válido: `import session: <causa>`; `ownership_mode` no vacío debe ser válido: `import session <id>: invalid session ownership mode "<m>"`). Un directorio en blanco es válido. Después, **en una transacción** (cualquier error la revierte entera):
  1. **Sesiones**: `INSERT OR IGNORE` con `ownership_mode = COALESCE(<modo válido o NULL>, 'shared')`; cuenta las insertadas.
  2. **Observaciones**, en orden: `sync_id` vacío → se genera uno `obs-…`. Si ya existe una fila con ese `sync_id` (incluidas las borradas): si la fecha comparable de `updated_at` entrante o local falta o `entrante <= local` → se cuenta como `skipped_stale` y no se toca; si no, se actualiza todo (incluidos `pinned` y `deleted_at`), con `created_at` = el entrante salvo que no sea comparable (entonces el local), `revision_count`/`duplicate_count` = el entrante salvo que sea ≤ 0 (entonces el local), `scope`/`topic_key` normalizados y `normalized_hash` recalculado; se cuenta como `updated`. Si no existe se inserta (`WHERE NOT EXISTS` por `sync_id`; los contadores valen al menos 1) y se cuenta lo insertado. En ambos casos se aplica `preserveObservationProvenance`.
  3. **Lápidas de prompts**, antes que los prompts: `sync_id` vacío → `import prompt tombstone: sync id is required`; con `source_inbox_id` y sesión en blanco → `import prompt tombstone "<id>": session id is required for source inbox id`; si ya hay una lápida con esa identidad y la sesión o la bandeja entrantes (no vacías) difieren de las establecidas → `pulled_prompt_identity_invalid`. Cada prompt local que coincida (por `sync_id`, o por sesión + bandeja si hay bandeja) debe tener el mismo dueño (proyecto propio o, si falta, el de su sesión; normalizados) que la lápida entrante (proyecto de la lápida o, si falta, el de la sesión), o falla con `pulled_prompt_identity_invalid` («… project ownership conflict»); se borra, se registra su lápida y se anota la mutación (falla si el proyecto está inscrito: aún no hay diario). Por último se registra la lápida entrante.
  4. **Prompts**: uno con bandeja cuya lápida existe para (sesión, bandeja) se omite; `sync_id` vacío → se genera `prompt-…`; si hay lápida por `sync_id`: se omite si tiene bandeja o es obsoleta (`isStalePromptUpsert`), y si no se elimina la lápida. Con bandeja y un prompt local de mismo `sync_id`: sesión, proyecto normalizado (propio o de su sesión) y bandeja deben coincidir, o falla `import prompt <id>: conflicting inbox identity`; si el local no tenía bandeja se le adopta (falla `import prompt <id>: inbox identity already owned` si otro la tiene). Finalmente `INSERT … WHERE NOT EXISTS` (por `sync_id`, o por sesión + bandeja) y se cuentan los insertados.
  5. **Relaciones**, al final: `sync_id` en blanco → `import relation: sync id is required`; un estado que recortado y en minúsculas es `orphaned` se guarda como `orphaned`; cada extremo debe estar en blanco → `import relation <id>: relation endpoint <source|target> is required`, y existir como observación salvo que la relación sea `orphaned` → `import relation <id>: relation endpoint <source|target> not found`. `INSERT OR IGNORE` (las existentes no cambian). Segunda pasada: las que traen `superseded_by_relation_sync_id` deben tener esa relación en la base (si no: `import relation <id>: superseding relation <otra> not found`) y, solo si se insertaron ahora, enlazan `superseded_by_relation_id`.
  La importación **no** anota mutaciones de sincronización de sesiones ni observaciones.

## `session-delete.js` — `deleteSession(store, id)`

`validateSessionId`; en una transacción: la sesión debe existir (`session_not_found` → `session not found: "<id>"`); el proyecto es el suyo normalizado; si conserva **alguna** observación, incluso borrada suavemente, `session_has_observations` → `session still has observations: session "<id>" has <n> observation(s)`. Se registra la lápida local de cada prompt de la sesión (proyecto del prompt o, si falta, el de la sesión), la lápida de borrado de la sesión (`recordDeleteTombstone`, entidad `session`), se borran los prompts y la sesión, y se anotan las mutaciones de borrado (falla si el proyecto está inscrito).

## Pruebas

`test/unit/store/backup.test.js`.
