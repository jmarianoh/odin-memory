# 10-store/12 — Errores y utilidades de texto (referencia consolidada)

Este documento reúne en un solo lugar las firmas y los mensajes de `src/store/errors.js` y `src/store/text.js`, que el resto de capítulos usan por su nombre. Los textos de los mensajes son contrato: los comprueban las pruebas y los reciben los clientes.

## `src/store/errors.js`

### Clases

| Clase | `name` / `code` | Constructor | Mensaje |
|---|---|---|---|
| `DatabaseGenerationChangedError` | `DatabaseGenerationChangedError` / `database_generation_changed` | `()` | `Database generation changed; restart odin` |
| `NetworkFilesystemError` | `NetworkFilesystemError` / `network_filesystem` | `(dataDir, filesystem)`; guarda `dataDir` y `filesystem` | `odin-memory: data directory "<dataDir>" is on <filesystem>; persistent SQLite WAL is unsafe on network filesystems — set ODIN_DATA_DIR to a local directory` |
| `StoreError` | `StoreError` / el `code` recibido | `(code, message)` | el recibido |
| `SessionProjectConflictError` (extiende `StoreError`) | `SessionProjectConflictError` / `session_ownership_mismatch` | `(sessionId, ownerProject, requestedProject)`; guarda los tres | `session ownership does not match write project: session <id> belongs to <dueño>, not <pedido>` (los tres valores con `JSON.stringify`) |

`DatabaseGenerationChangedError` y `NetworkFilesystemError` extienden `Error` directamente (no son `StoreError`).

### `storeError(code, detail?)`

Devuelve `new StoreError(code, mensajeBase)` con el mensaje base del código de la tabla siguiente; si hay `detail` (cadena no vacía) el mensaje es `<mensajeBase>: <detail>`. Un código que no está en la tabla produce `undefined` como mensaje base: no se debe pedir.

### Catálogo de códigos de `storeError`

| Código | Mensaje base |
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
| `prompt_inbox_deleted` | prompt inbox identity was deleted |
| `pulled_prompt_identity_invalid` | pulled prompt identity is invalid |
| `invalid_match_mode` | invalid match_mode |
| `search_failed` | search |
| `cross_project_relation` | relation rejected: source and target observations are in different projects |
| `invalid_project_name` | invalid project name |
| `session_isolation_conflict` | isolated session registration requires an empty directory; existing runtime-bound sessions cannot be reused |
| `runtime_session_scope_conflict` | runtime session scope conflict |
| `project_not_found` | project not found |
| `project_name_required` | project name must not be empty |
| `project_prune_blocked` | project still has observations |
| `invalid_project_merge` | invalid project merge |
| `consolidate_need_two_sources` | consolidate needs at least two source observations |
| `consolidate_duplicate_id` | consolidate source list contains duplicate ids |
| `consolidate_missing_observation` | consolidate source missing or already deleted |
| `consolidate_cross_project` | consolidate sources span multiple projects |
| `consolidate_provenance_cycle` | consolidate provenance cycle detected |
| `consolidate_fingerprint_mismatch` | consolidate sources changed since plan; re-plan required |
| `invalid_project_alias` | invalid project alias |
| `passive_capture_failed` | passive capture save |
| `relation_not_found` | relation not found |
| `invalid_relation_verb` | invalid relation verb |
| `invalid_confidence` | invalid confidence |
| `relation_endpoint_required` | relation endpoint is required |
| `sync_journal_unavailable` | sync journal is not available for enrolled projects yet |
| `invalid_project_provenance` | invalid project_provenance |
| `session_has_observations` | session still has observations |

## `src/store/text.js`

Utilidades puras (sin acceso a la base). «Espacio» significa lo que Go llama `unicode.IsSpace`: `\t \n \v \f \r`, espacio, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F y U+3000. **No** incluye U+FEFF (que la `\s` de JavaScript sí trata como espacio): por eso no se usa `trim()` ni `\s` para los datos del usuario.

| Función / constante | Firma | Comportamiento |
|---|---|---|
| `SQL_WHITESPACE_TRIM_SET` | `string` | Los mismos espacios, como segundo argumento de `trim(X, Y)` de SQLite |
| `goTrim` | `(s: string) => string` | Quita los espacios de ambos extremos |
| `goFields` | `(s: string) => string[]` | Divide por rachas de espacios y descarta las vacías |
| `isBlankSessionId` | `(id: string) => boolean` | `goTrim(id) === ''` |
| `TRUNCATION_MARKER` | `'... [truncated]'` | Se añade al contenido truncado |
| `stripPrivateTags` | `(s) => string` | Sustituye cada `<private>…</private>` (sin distinguir mayúsculas, multilínea, el más corto) por `[REDACTED]` y recorta con `goTrim` |
| `byteLength` | `(s) => number` | Bytes UTF-8 |
| `truncateContent` | `(content, max) => string` | Si cabe en `max` bytes, igual; si no, corta a `max` bytes sin partir un carácter y añade `TRUNCATION_MARKER` |
| `cutBytes` | `(s, max) => string` | Como `truncateContent` pero sin marcador |
| `hashNormalized` | `(content) => string` | SHA-256 hexadecimal de `goFields(content).join(' ').toLowerCase()` (UTF-8) |
| `normalizeScope` | `(scope?) => 'personal'\|'global'\|'project'` | `goTrim` + minúsculas; cualquier otro valor es `project` |
| `normalizeTopicKey` | `(topic?) => string` | `goTrim` + minúsculas; `''` si queda vacío; las palabras se unen con `-` y se corta a 120 bytes |
| `normalizeTopicSegment` | `(s?) => string` | `goTrim` + minúsculas; todo lo que no sea `a-z0-9` actúa de separador; las palabras se unen con `-`; máximo 100 caracteres |
| `suggestTopicKey` | `(type, title, content) => string` | `familia/segmento` (ver abajo) |
| `sanitizeFts` | `(query) => string` | Cada palabra (por `goFields`) sin comillas en los extremos, con las comillas internas duplicadas, entre comillas dobles y unidas por un espacio: `fix auth bug` → `"fix" "auth" "bug"` |
| `searchTerms` | `(query) => string[]` | Palabras de `goFields` sin comillas en los extremos, sin las vacías |
| `hasShortFtsTerm` | `(query) => boolean` | ¿Algún término tiene menos de 3 caracteres (puntos de código)? El índice trigram no lo cubre |
| `escapeLike` | `(term) => string` | Antepone `\` a `\`, `%` y `_` (para `LIKE … ESCAPE '\'`) |
| `candidateTerms` | `(title?) => string[]` | Como `sanitizeFts` pero una pareja de comillas consecutivas dentro de la palabra pasa a una sola `""` |
| `sanitizeFtsCandidates` | `(title?) => string` | `candidateTerms(title).join(' OR ')` |
| `truncate` | `(s, max) => string` | Recorta a `max` caracteres (puntos de código) y añade `...` solo si recortó |
| `nullableString` | `(v) => string\|null` | `undefined`, `null` y `''` → `null`; el resto, igual |
| `newSyncId` | `(prefix) => string` | `<prefix>-` + 16 dígitos hexadecimales aleatorios (8 bytes) |

### Sugerencia de `topic_key`

`suggestTopicKey(type, title, content)`:

1. **Familia** según `type` (`goTrim` + minúsculas): `architecture`/`design`/`adr`/`refactor` → `architecture`; `bug`/`bugfix`/`fix`/`incident`/`hotfix` → `bug`; `decision` → `decision`; `pattern`/`convention`/`guideline` → `pattern`; `config`/`setup`/`infra`/`infrastructure`/`ci` → `config`; `discovery`/`investigation`/`root_cause`/`root-cause` → `discovery`; `learning`/`learn` → `learning`; `session_summary` → `session`. Con otro tipo se busca en `título + " " + contenido` en minúsculas, por orden y con la primera coincidencia de subcadena: `bug` (bug, fix, panic, error, crash, regression, incident, hotfix), `architecture` (architecture, design, adr, boundary, hexagonal, refactor), `decision` (decision, tradeoff, chose, choose, decide), `pattern` (pattern, convention, naming, guideline), `config` (config, setup, environment, env, docker, pipeline), `discovery` (discovery, investigate, investigation, found, root cause), `learning` (learned, learning). Si nada coincide y el tipo no es vacío ni `manual`, la familia es `normalizeTopicSegment(tipo)`; si no, `topic`.
2. **Segmento**: `normalizeTopicSegment(stripPrivateTags(title))`; si queda vacío, el de las primeras 8 palabras de `stripPrivateTags(content)`; si sigue vacío, `general`.
3. Si el segmento empieza por `<familia>-` se quita ese prefijo; si queda vacío o igual a la familia, `general`.
4. Si el texto de origen del segmento tiene algún carácter no ASCII, se añade `-u-<12 primeros hex de SHA-256(origen)>` (el segmento se acorta para que el total quepa en `min(120 − familia − 1, 100)`).
5. Resultado: `<familia>/<segmento>`.
