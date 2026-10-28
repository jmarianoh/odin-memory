# 14.1 — Referencia de rutas

Convenciones: «proyecto» = el resuelto de la petición (ver `README.md`). Salvo que se diga otra cosa, las lecturas aceptan `?project=`, `?all_projects=` y `?cwd=`. `auth` = protegida por `ODIN_HTTP_TOKEN`. Todos los 400 por cuerpo inválido usan `invalid json: <causa>`.

Las rutas con **id** forman el *contrato de runtime* (`GET /runtime-contract`); su id aparece entre paréntesis.

## Sistema

| Ruta | Respuesta |
|---|---|
| `GET /health` | `200 {"status":"ok","service":"odin-memory","version":<VERSION>,"instance_id":<id del almacén>,"capabilities":{"isolated_session_registration":true,"root_session_resume":true,"runtime_session_resolution":true}}`. Si leer las estadísticas falla: `500 health check failed` |
| `GET /runtime-contract` | El contrato (abajo) más `instance_id` |
| `GET /sync/status` | Estado de sincronización del proyecto (ver `02-servidor-y-serve.md`). Con `all_projects` verdadero: `400 unsupported_project_scope` («all_projects is not supported for sync status») |

### Contrato de runtime

`runtimeContractProjection()` es estable (no abre almacén ni servidor): `{"contract_id":"odin-memory.http-runtime/v1","revision":1,"status":"http-server-contract","operations":{…},"supporting_routes":{…},"digest":<sha256 hex>}`.

* `operations`: por cada herramienta de agente (`mem_search`, `mem_save`, …) `{"kind":"http","bindings":[{"method","path","server_contract":"<id>/v1","configured_auth"?:true}]}`. Los enlaces salen de la tabla `OPERATION_BINDINGS` de `routes/system.js` y de los **ids** de `ROUTES`.
* `supporting_routes`: `runtime-session-resolve`, `runtime-session-end`, `prompt-capture-decision`, `compaction-context`.
* `digest`: SHA-256 (hex) del JSON compacto del contrato **sin** `digest` (claves en orden alfabético, escapes HTML), serializado con `jsonMarshal`.
* `configured_auth` se emite (`true`) para las rutas con `auth`; se omite en las demás.
* Las operaciones cuyos enlaces apuntan a rutas aún no registradas (`mem_doctor`) conservan solo los enlaces existentes.

## Sesiones

| Ruta (id) | Detalle |
|---|---|
| `POST /sessions` (`session-create`) | Cuerpo: `id`, `project` (obligatorios), `directory`, `ownership_mode` (`shared` por defecto o `project_owned`), `resume`, `isolated`, `project_provenance` (`{source,directory,raw_project}`). `isolated` exige `project_owned` y directorio vacío (`400 isolated registration requires project_owned ownership and an empty directory`). El directorio se guarda con `runtimeWorktreeDirectory`. Éxito `201 {"id":<efectivo>,"status":"created"}` y, si la sesión raíz ya había terminado y se reanudó, `"resumed_from":<id pedido>`. Errores: `400 id and project are required`; `400 invalid session ownership mode "x"`; `400 invalid json: invalid project_provenance: unsupported source "x"`; `409 session_isolation_conflict`; `409 session_already_ended` (+`session_id`); `409 session_project_conflict` (+`session_id`, `owner_project`, `requested_project`). Avisa de escritura |
| `POST /sessions/{id}/end` (`session-end`) | Cuerpo opcional `{"summary"}` (un cuerpo ausente o inválido cierra sin resumen). `200 {"id","status":"completed"}`. Avisa de escritura |
| `GET /sessions/recent` | `?limit=` (5). Lista `[{id,project,started_at,ended_at?,summary?,observation_count}]` |
| `GET /sessions/{id}` | La sesión `{id,project,ownership_mode?,directory,started_at,ended_at?,summary?}` más `project_provenance` (`{source,directory?,raw_project?}`) si hay. `404 session not found` |
| `DELETE /sessions/{id}` (`auth`) | `200 {"id","status":"deleted"}`; `409` si conserva observaciones; `404`. No avisa de escritura |
| `POST /sessions/{id}/finalize` (`session-finalize`, `auth`) | Cuerpo: un único objeto JSON ≤ 1 MiB con exactamente `project` y `summary` no vacíos. `200 {"session_id","state":"finalized"\|"already_finalized","summary_id","summary_sync_id","already_finalized","judgment_required":false}`. Errores con `code`: `invalid_arguments` (400), `unknown_session` (404), `session_project_mismatch` (403), `session_already_ended` (409), `session_finalize_failed` (500, mensaje `session finalization failed`); siempre con `session_id`. Cuerpo mayor de 1 MiB: `413 request_too_large` |
| `POST /runtime-sessions/resolve` y `POST /runtime-sessions/end` (`runtime-session-resolve`, `runtime-session-end`) | Cuerpo estricto y único: `id`, `project`, `directory` no vacíos, `ownership_mode` y (solo `end`) `summary`. Nunca registran ni reparan identidades. `200 {"id":<sesión viva>,"status":"resolved"\|"ended"}` (+`resumed_from` si el id vivo difiere). Errores: `400 id, project and directory are required in one valid JSON object`; `400 invalid ownership_mode`; `404 sql: no rows in result set` (sesión desconocida); `409 runtime session scope conflict`. `end` avisa de escritura |

## Observaciones

| Ruta (id) | Detalle |
|---|---|
| `POST /observations` (`observation-add`) | Cuerpo: `session_id`, `title`, `content` (obligatorios), `type`, `tool_name`, `project`, `scope`, `topic_key`, `operation_id`, `capture_prompt` (bool), `current_prompt`, `project_provenance`. Orden de validación: título (`ValidateObservationTitle`) → `session_id`/`content` (`400 session_id and content are required`) → si `operation_id` ya está confirmada se salta la comprobación de sesión → `validateSessionProject`. `201 {"id","status":"saved"}`. Si no es una repetición: captura el prompt (`current_prompt`, salvo `capture_prompt:false`; un fallo se registra y se ignora) y avisa de escritura. Errores: 400 título/contenido, `409` operación en conflicto, `410` operación expirada, `409` de propiedad (ver `README.md`) |
| `GET /observations/save-result` (`observation-save-result`) | `?operation_id=` (obligatorio, `400`). `200 {"id","status":"committed"}`; `404 {"code":"observation_save_result_not_found"}`; `410` si la observación fue borrada |
| `POST /observations/passive` (`observation-passive`) | Cuerpo: `session_id` (obligatorio), `content`, `project`, `source`, `project_provenance`. `200 {"extracted","saved","duplicates"}`. Avisa de escritura |
| `GET /observations`, `GET /observations/recent` | `?scope=`, `?limit=` (20). `GET /observations` acepta `?sort=created_at:desc` (otro valor: `400 unsupported sort: use created_at:desc`). Lista de observaciones |
| `GET /observations/{id}` (`observation-get`) | Observación. `404 observation not found`; `400 invalid observation id`. Con `?include_history=true` añade `history` (`[{version,title,content,created_at}]`), `version_count` y, si hay más páginas, `history_truncated`, `history_from_version`, `history_cursor`. `?history_cursor=` debe ser un entero JSON ≥ 0 y < 2^63 (`400 history_cursor must be a non-negative integer`; acepta `1e0`; rechaza `null`, `-1`, `1.5`, texto) |
| `PATCH /observations/{id}` (`observation-update`) | `?expected_project=` obligatorio. Cuerpo con al menos uno de `type`, `title`, `content`, `find`, `replace`, `project`, `scope`, `topic_key` (`400 at least one field is required`). `200` la observación actualizada. Errores: 400 (proyecto esperado, título/contenido, parejas de buscar/reemplazar, tamaños), 409 (`observation_project_mismatch`, `observation_project_immutable`), 404 para el resto. Avisa de escritura |
| `PUT /observations/{id}/pin`, `DELETE /observations/{id}/pin` (`observation-pin`, `observation-unpin`) | `200 {"id","pinned"}`; `400 invalid observation id` (también para `id <= 0`); `404` |
| `DELETE /observations/{id}` (`observation-delete`, `auth`) | `?expected_project=` obligatorio, `?hard=true`. `200 {"id","status":"deleted","hard_delete"}`; 400/409/404/500. Avisa de escritura |
| `POST /topic-keys/suggest` (`topic-key-suggest`) | Cuerpo único ≤ 50 MiB con `type`, `title`, `content`. `200 {"topic_key"}`. `400 provide title or content to suggest a topic_key`; `400 invalid json: trailing data`; `400 request body too large` |
| `POST /observations/consolidate` (`observation-consolidate`, `auth`) | Cuerpo de flujo (ver arriba) con los argumentos de `mem_consolidate` (`parseConsolidate`). Vista previa `200 {"status":"preview","plan":…}`; consolidado `201 {"status":"consolidated","plan","survivor","soft_deleted_ids"}` y avisa de escritura. Errores con `code`: `invalid_arguments` 400, `consolidation_refused` 400, `fingerprint_mismatch` 409 (+`plan`), `project_mismatch` 403, `consolidation_failed` 500 (mensaje `consolidation failed`) |

## Búsqueda y lectura

| Ruta (id) | Detalle |
|---|---|
| `GET /search` (`search`) | `?q=` obligatorio; `?type=`, `?scope=`, `?limit=` (10), `?match_mode=all\|any`, `?response_format=compact`. Sin formato: lista de observaciones con `rank`. `compact`: `{"result":"Found N memories."\|"No memories found for: \"q\"","results":[…proyección compacta, con relaciones]}`. Errores: `400 q parameter is required`, `400 invalid match_mode "x": must be "all" or "any"`, `400 invalid response_format "x": must be "compact"` |
| `GET /prompts/search` (`prompt-search`) | `?q=` obligatorio, `?limit=` (10). Lista de prompts |
| `GET /prompts/recent` | `?limit=` (20) |
| `GET /timeline` (`timeline`) | `?observation_id=` obligatorio; `?before=`, `?after=` (5). `{"focus","before","after","session_info","total_in_range"}` (las entradas de `before`/`after` llevan `is_focus`). `404 observation not found`; `404 observation not found in resolved project` |
| `GET /review` (`review-list`) | `?limit=` (10). `{"observations":[{id,sync_id,title,type,state,project?,review_after?}],"count"}` |
| `POST /review/mark_reviewed` (`review-mark`) | Cuerpo `observation_id` (o `id`); el proyecto se resuelve con el detector de capturas. `200` la carga de revisión. `400 observation_id is required`; `404 observation not found in resolved project` |
| `GET /context` (`context`) | `?scope=`, `?observations=`, `?prompts=`, `?sessions=`, `?pinned=` (0 = por defecto, negativo = omitir la sección, positivo ≤ 500), `?compact=`, `?older_history=`, `?max_bytes=` (dígitos con `+` opcional, ≤ 65536; lo no numérico = 0). `{"context":<texto>}` |
| `GET /context/compaction` (`compaction-context`) | `?session_id=` obligatorio (`400`); `404 session not found` |
| `GET /stats` (`stats`) | Estadísticas del proyecto, o globales con `all_projects`. `500 stats unavailable` |
| `GET /projects` (`projects`) | `{"projects":[{name,observation_count,session_count,prompt_count,directories}],"count"}` |
| `GET /project/current` (`current-project`) | `?cwd=` (por defecto el del proceso). `{"project","project_source","project_path","cwd","available_projects"}` (+`warning`, `error_hint`). Con directorio ambiguo responde `200` con los datos parciales |

## Prompts

| Ruta (id) | Detalle |
|---|---|
| `POST /prompts` (`prompt-add`) | Cuerpo: `session_id`, `content` (obligatorios), `project` (si falta hereda el de la sesión), `source_inbox_id` (idempotente por sesión y bandeja), `project_provenance`. `201 {"id","status":"saved"}`; avisa de escritura solo si se insertó. `409` si la bandeja se borró |
| `POST /prompts/capture-decision` (`prompt-capture-decision`) | Cuerpo estricto y único: `source` = `"copilot"`, `cwd` no vacío, `content` (cadena). Contenido vacío → `{"decision":"skip"}`. Si no, `{"decision":"capture", …datos de proyecto}`. No persiste nada ni avisa de escritura. `400 source must be copilot, cwd must be nonblank, and content must be a string` |
| `DELETE /prompts/{id}` (`auth`) | `200 {"id","status":"deleted"}`; `400 invalid prompt id`; `404`. Avisa de escritura |

## Copia de seguridad

| Ruta | Detalle |
|---|---|
| `GET /export` (`auth`) | Exportación del proyecto o de todos; `Content-Disposition: attachment; filename=odin-export.json` |
| `POST /import` (`auth`) | Cuerpo ≤ 50 MiB (`parseExportData`); `200` con los contadores de `importData`. `400 invalid json: unexpected end of JSON input` (vacío o truncado). Avisa de escritura |

## Conflictos y juicios

| Ruta (id) | Detalle |
|---|---|
| `GET /conflicts` | `?status=`, `?since=` (RFC 3339; `400 invalid since parameter: must be RFC3339`), `?limit=` (50, máx. 500, no positivo = 50), `?offset=`. `{"total","limit","offset","relations"}` (solo accionables, sin `not_conflict`) |
| `GET /conflicts/{relation_id}` | `{"relation_id","sync_id","relation","judgment_status","source_id","source_snippet","target_id","target_snippet","created_at","updated_at"}`; `400 invalid relation_id: must be an integer`; `404` |
| `POST /conflicts/judge` (`conflict-judge`) | Cuerpo: `judgment_id`, `relation` (obligatorios), `reason`, `evidence`, `confidence` (0–1), `session_id`. `200 {"relation":…}`; avisa de escritura |
| `POST /conflicts/judge-many` (`conflict-judge-many`, `auth`) | Cuerpo de flujo `{"judgments":[1..32],"session_id"?}`. `200 {"outcomes":[{index,judgment_id,status:"success"\|"error",relation?,judgment_status?,error?}]}`. Los mensajes de error solo exponen rechazos conocidos (`relation "x" not found`, verbo inválido, relación entre proyectos); el resto es `judgment failed` |
| `POST /conflicts/compare` (`conflict-compare`) | Cuerpo: `memory_id_a`, `memory_id_b`, `relation`, `confidence` (obligatoria), `reasoning`, `model`. `200 {"sync_id"}`; `404 observation id=N not found: sql: no rows in result set` |

## Fuera de esta entrega

`GET /compatibility` (F4.3), `GET /conflicts/stats`, `GET /conflicts/deferred`, `POST /conflicts/scan`, `POST /conflicts/deferred/replay` (F4.3), `GET /doctor`, `POST /doctor/caller-binding` (F6), `POST /projects/rescue-ownership` y su alias `POST /projects/migrate` (F5; usarán `requireConfiguredAuth`).
