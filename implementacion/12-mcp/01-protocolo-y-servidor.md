# 12.1 — Protocolo, perfiles y estado de sesión

Módulos: `src/mcp/{json,protocol,profiles,activity,errors,envelope,args,serialize,projects,server,index}.js`. `projects.js` exporta además `captureProjectDetector(store)` (detección con historial exigiendo proyecto explícito en HOME) y `workingDirectory(ctx)` (`ctx.cwd()` o `process.cwd()`).

## `json.js`

- `jsonMarshal(valor)`: `JSON.stringify` tras ordenar **alfabéticamente las claves de todos los objetos** (recursivo; los arreglos conservan el orden) y escapar `<` → `<`, `>` → `>`, `&` → `&`, U+2028 → ` `, U+2029 → ` `. Toda respuesta estructurada de una herramienta pasa por aquí.
- `goQuote(texto)`: cita una cadena como el verbo `%q` de Go (`strconv.Quote`): comillas dobles; `"` y `\` escapados; `\a \b \f \n \r \t \v` para esos controles; `\xNN` para otros controles (< 0x20 y 0x7f); los caracteres Unicode imprimibles (letras, marcas, números, puntuación y símbolos) se conservan; los no imprimibles se escriben `\uNNNN` (BMP) o `\UNNNNNNNN`; un sustituto suelto se escribe como U+FFFD. **Todos los mensajes que citan un valor del usuario con comillas usan `goQuote`**, no `JSON.stringify`.
- `textResult(texto)` → `{ content: [{ type: 'text', text }] }`.
- `errorResult(texto)` → igual, con `isError: true`. Es el error de **uso** de una herramienta (texto plano); los errores de proyecto usan `errorWithMeta` (JSON).

## `protocol.js` — `McpServer`

`SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']`.

`new McpServer({ name, version, instructions = '', tools })`, con `tools: { definition, handler }[]`. Los manejadores reciben el objeto de argumentos y devuelven un resultado MCP (pueden ser asíncronos). `listTools()` devuelve las definiciones ordenadas por `name` (`localeCompare`).

### `handle(mensaje)` → respuesta o `null`

1. Si el mensaje no es un objeto, es un arreglo, no trae `jsonrpc: "2.0"` o `method` no es cadena → error `-32600` «Invalid Request» (con el `id` del mensaje o `null`).
2. Sin `id` (notificación) → `null`, sea cual sea el método.
3. `initialize` → `{ protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name, version }, instructions? }`. `protocolVersion` es la solicitada si está soportada; si no (o falta), la primera de la lista. `instructions` solo si no es vacía.
4. `ping` → `{}`. `tools/list` → `{ tools }`.
5. `tools/call`: sin herramienta con ese `name` → error `-32602` `tool '<name>' not found`. `arguments` ausente o `null` se trata como `{}`; si no es un objeto (arreglo, cadena, número) → `-32602` `arguments must be an object`. Si el manejador lanza → resultado `{ content: [{ type: 'text', text: 'Internal error: <mensaje>' }], isError: true }` (no es un error de protocolo).
6. Cualquier otro método → `-32601` `method '<m>' not found`. Una excepción inesperada → `-32603`.

Las respuestas son `{ jsonrpc: '2.0', id, result }` o `{ jsonrpc: '2.0', id, error: { code, message } }`.

### `serve({ input, output, graceMs = 5000 })`

Lee `input` línea a línea (`readline`, `crlfDelay: Infinity`). Las líneas en blanco se ignoran. Cada mensaje se procesa **en orden de llegada** encadenando promesas (una petición lenta retrasa las siguientes; así las respuestas salen en el mismo orden). Una línea que no es JSON responde `-32700` «Parse error» con `id: null`. Cada respuesta se escribe como `JSON.stringify(respuesta) + '\n'`.

Al cerrarse la entrada la promesa devuelta espera a que termine la cadena de peticiones en curso, con un máximo de `graceMs` (así un manejador colgado no retiene el proceso).

## `profiles.js`

- `PROFILE_AGENT` (23 herramientas): `mem_save mem_search mem_search_prompts mem_context mem_session_summary mem_session_start mem_session_end mem_consolidate mem_get_observation mem_suggest_topic_key mem_capture_passive mem_save_prompt mem_update mem_current_project mem_list_projects mem_judge_many mem_session_finalize mem_judge mem_compare mem_doctor mem_review mem_pin mem_unpin`.
- `PROFILE_ADMIN` (6): `mem_judge_many mem_session_finalize mem_delete mem_stats mem_timeline mem_merge_projects`. Se solapa con `agent` en `mem_judge_many` y `mem_session_finalize`.
- `resolveTools(texto)`: recorta; vacío o `all` → `null` (todas). Separa por comas, recorta cada elemento, ignora vacíos; `all` en cualquier posición → `null`; `agent`/`admin` añaden su perfil; cualquier otra cosa se añade como nombre de herramienta. Si no queda ningún elemento → `null`.
- `shouldRegister(nombre, allowlist)`: `true` si `allowlist` es `null`/`undefined` o la contiene.
- `ALL_TOOL_NAMES`: nombres de `TOOL_DEFINITIONS` (ya vienen ordenados).

### `buildServerInstructions(allowlist)`

Texto que el servidor entrega en `initialize`. Se arma por bloques, **solo con las herramientas permitidas**, y el resultado final se recorta con `trim()`:

1. `odin-memory provides persistent memory that survives across sessions and compactions.` + `\n\n`.
2. Si queda alguna herramienta núcleo permitida: `CORE TOOLS (always available):\n` + una línea `  <descripción>\n` por herramienta + `\n`. Núcleo, en orden:

| Herramienta | Descripción |
|---|---|
| `mem_save` | `mem_save — save verified durable conclusions, grouped by topic` |
| `mem_search` | `mem_search — find past work, decisions, or context from previous sessions` |
| `mem_context` | `mem_context — get recent history for useful recall or relevant recovery` |
| `mem_session_summary` | `mem_session_summary — significant explicit closure or handoff; ordinary completion does not require it` |
| `mem_get_observation` | `mem_get_observation — get full untruncated content of a search result by ID` |
| `mem_save_prompt` | `mem_save_prompt — save user prompt for context` |
| `mem_current_project` | `mem_current_project — detect current project from cwd (recommended first call)` |
| `mem_judge` | `mem_judge — record a verdict on a pending memory conflict (judgment_required flow)` |
| `mem_compare` | `mem_compare — persist a semantic verdict you have already judged externally` |

3. Si queda alguna diferida permitida: `DEFERRED TOOLS (load them through your host's tool discovery when needed):\n  <nombres separados por ", ">\n\n`. Orden: `mem_update mem_review mem_pin mem_unpin mem_suggest_topic_key mem_session_start mem_session_end mem_doctor mem_capture_passive mem_stats mem_delete mem_timeline mem_merge_projects mem_judge_many mem_session_finalize mem_consolidate`.
4. Si `mem_save` está permitida: `PROACTIVE SAVE RULE: Persist verified durable knowledge costly to reconstruct; group related conclusions, not every event.\n\n`.
5. Si alguna herramienta de escritura está permitida (`mem_save mem_update mem_review mem_delete mem_save_prompt mem_pin mem_unpin mem_session_summary mem_session_start mem_session_end mem_capture_passive mem_merge_projects mem_judge mem_judge_many mem_compare mem_session_finalize mem_consolidate`):
   `## DELIVERY GUARANTEE\n\nMemory operations are internal bookkeeping, never the user-facing answer. Complete required memory work before composing the completed-task reply; send the complete answer as the final message of the turn with no later tool calls. If memory work fails or needs follow-up, still send the answer.\n\n`.
6. Si `mem_save` y (`mem_judge` o `mem_judge_many`) están permitidas: `## CONFLICT SURFACING\n\n` y luego, según haya `mem_judge_many`:
   - con ella: `After mem_save: if judgment_required, prefer mem_judge_many (max 32) with candidates[].judgment_id; never reuse the top-level judgment_id.\n`
   - sin ella: `After mem_save: if judgment_required, call mem_judge once per entry using that entry's judgment_id; never reuse the top-level judgment_id.\n`
   
   seguido de las tres líneas (unidas por `\n`, sin salto final): `Ask conversationally when confidence < 0.7 OR (relation in` / `{supersedes, conflicts_with} AND type in {architecture, policy, decision}); else` / `resolve with related | compatible | scoped | not_conflict. Pass evidence from user reply.`

El texto con todas las herramientas está fijado en `fuentes/test/contract/fixtures/mcp-tools.json` (clave `instructions`) y no debe mencionar ningún otro producto ni un buscador de herramientas concreto.

## `activity.js` — `SessionActivity`

Estado **en memoria del proceso** (no se persiste). `new SessionActivity(nudgeAfterMs = 600000, now = Date.now)`; `AMBIGUOUS_PROJECT_RECOVERY_TTL_SECONDS = 300`.

Por sesión: `lastSaveAt`, `toolCallCount`, `saveCount`, `startedAt` (instante en que se crea el estado), `currentPrompt` y los tokens de recuperación. Por proyecto: `projectLastSaveAt`.

| Método | Comportamiento |
|---|---|
| `recordToolCall(s)` | `toolCallCount++` (crea el estado si no existe) |
| `recordSave(s)` | `saveCount++`, `lastSaveAt = ahora` |
| `recordProjectSave(p)` | recorta `p`; vacío se ignora; purga proyectos caducados y fija `projectLastSaveAt[p] = ahora` |
| `recordSaveForProject(s, p)` | ambos |
| `recordPrompt(s, p, texto)` / `currentPrompt(s, p)` | guarda `{project, content}`; `currentPrompt` devuelve el texto solo si el proyecto coincide y no es vacío, si no `null` |
| `clearSession(s)` | elimina el estado |
| `activityScore(s)` | `''` si no hay estado; si no `Session activity: <n> tool call(s), <m> save(s)` (singular exactamente con 1) y, si `m == 0` y `n > 5`, el sufijo ` — high activity with no saves, consider persisting important decisions` |
| `nudgeIfNeeded(s, p = '')` | ver abajo |

`nudgeIfNeeded` devuelve `''` salvo que se cumplan **todas**: la sesión existe; `ahora - startedAt ≥ plazo`; `saveCount > 0` o `toolCallCount > 5`; `ahora - (lastSaveAt || startedAt) ≥ plazo`; y el proyecto (recortado) no tiene un guardado reciente (la frescura del proyecto caduca a los `plazo` ms). Entonces devuelve `\n\n⚠️ No mem_save calls for this project in <min> minutes. Did you make any decisions, fix bugs, or discover something worth persisting?` con `<min>` = minutos enteros transcurridos desde la referencia.

### Tokens de recuperación de proyecto ambiguo

Cuando una escritura no puede decidir entre varios repositorios hijos, el error incluye un token con el que el agente, tras preguntar al usuario, repite la escritura eligiendo uno.

- `resolveAmbiguousChoicePath(padre, eleccion)`: entre los subdirectorios de `padre` cuyo nombre en minúsculas (recortado) es igual a `eleccion` y que contienen `.git` (cualquier tipo de entrada), devuelve la ruta real si hay **exactamente una**, o `''` (también si `padre`/`eleccion` son vacíos, si no se puede leer o si dos coinciden).
- Contexto de recuperación (interno): resuelve `contextPath` con `realpath`; ordena los candidatos; si alguno es vacío o está repetido, o no se resuelve a un repositorio hijo, el contexto no es válido; también es inválido con menos de 2 candidatos.
- `issueAmbiguousProjectRecoveryToken(sesion, candidatos, ruta)`: con contexto válido genera 16 bytes aleatorios en hexadecimal (32 caracteres) y guarda `{ candidatos ordenados, ruta real, rutas de candidatos, caducidad = ahora + 300 s, elegido: '' }` en la sesión; si el contexto no es válido devuelve `''`.
- `validateAmbiguousProjectRecoveryToken(sesion, token, elegido, candidatos, ruta)`: falso si falta `token` o `elegido`, la sesión o el token no existen. Si caducó, lo elimina y devuelve falso. Recalcula el contexto y exige: válido, `elegido` entre los candidatos, mismos candidatos, misma ruta real y mismas rutas de candidatos. La primera validación correcta fija `elegido` en el token y devuelve verdadero; las siguientes solo son verdaderas para ese mismo proyecto.

## `errors.js`

`McpProjectError(kind, message, campos)` (`name = 'McpProjectError'`; los `campos` se copian a la instancia). Constructores y sus campos:

| Constructor | `kind` | Mensaje | Campos |
|---|---|---|---|
| `unknownProject(n, disp)` | `unknown_project` | `unknown project: <n>` | `projectName`, `availableProjects` |
| `invalidProjectChoice(n, disp)` | `invalid_project_choice` | `invalid project choice: <n>` | ídem |
| `missingRecoveryToken(n, disp)` | `missing_recovery_token` | `missing ambiguous project recovery token for project choice: <n>` | ídem |
| `invalidRecoveryToken(n, disp)` | `invalid_recovery_token` | `invalid ambiguous project recovery token for project choice: <n>` | ídem |
| `invalidExplicitProject(n, motivo)` | `invalid_explicit_project` | `invalid project: <n> (<motivo>)` o sin paréntesis si no hay motivo | `projectName`, `reason` |
| `projectNameCollision(n, norm, colisionan)` | `project_name_collision` | `project "<n>" collides after normalization to "<norm>"` | `projectName`, `normalized`, `collidingProjects` |
| `unknownSession(id)` | `unknown_session` | `unknown session: <id>` | `sessionId` |
| `sessionProjectMismatch(id, deSesion, explicito)` | `session_project_mismatch` | `session "<id>" belongs to project "<deSesion>", not "<explicito>"` | `sessionId`, `sessionProject`, `explicitProject` |

(Las comillas de los mensajes son `JSON.stringify` del valor.)

## `envelope.js`

- `defaultSessionId(proyecto)` = `manual-save-<proyecto>`, o `manual-save` si el proyecto es vacío.
- `respondWithProject(res, texto, extra = {})` → `textResult(jsonMarshal({ project, project_source, project_path, result: texto, warning?, ...extra }))`. `project` = `res.project ?? ''`, `project_source` = `res.source ?? ''`, `project_path` = `res.path ?? ''`; `warning` solo si hay. Es la forma de **toda respuesta de lectura correcta**.
- `errorWithMeta(codigo, mensaje, disponibles = null)` → resultado con `isError: true` y JSON `{ error_code, message, available_projects, hint? }`. `hint` según el código (tabla siguiente).
- `addErrorMetadata(resultado, metadatos)`: si el resultado tiene contenido, hay metadatos y el primer bloque es JSON, lo reescribe fusionando los metadatos (con `jsonMarshal`); si no es JSON, o no hay metadatos, lo devuelve intacto. Muta y devuelve el mismo objeto.

| Código | Pista (`hint`) |
|---|---|
| `explicit_project_required` | `Set ODIN_PROJECT or .odin-memory/config.json project_name, or supply a supported explicit project; do not guess a folder name.` |
| `ambiguous_project` | `Ask the user to choose one of available_projects, then retry the same write tool (mem_save, mem_save_prompt, or mem_session_summary) with project and project_choice_reason=user_selected_after_ambiguous_project; alternatively cd into the target repo or add repo .odin-memory/config.json.` |
| `database_generation_changed` | `Restart odin and retry.` |
| `invalid_project_choice` | `Use exactly one of available_projects after asking the user, or cd into the target repo, or add repo .odin-memory/config.json.` |
| `missing_recovery_token` | `Retry with the recovery_token returned by the ambiguous_project error after the user selects one available_projects value.` |
| `invalid_recovery_token` | `Request a fresh ambiguous_project recovery_token and retry with the same session, cwd context, and selected available_projects value before it expires.` |
| `unknown_project` | `Use one of the available_projects values, or omit project to auto-detect.` |
| `invalid_project_config` | `Fix .odin-memory/config.json so project_name is a non-empty project name.` |
| `repository_binding_unavailable` | `Configure the repository's .odin-memory/config.json with the intended canonical project.` |
| `invalid_project` | `Use a non-empty project name, not a path.` |
| `unknown_session` | `Start the session first, omit session_id, or retry with an existing session_id.` |
| `session_already_ended` | `Choose a new session ID and retry mem_session_start; ended sessions cannot be reopened.` |
| `session_project_mismatch` | `Use a project that matches the existing session, or omit session_id and write to a different project.` |
| `session_project_ownership_ambiguous` | `Use ownership rescue to classify the historical session before writing to a different project.` |
| `project_required` | `Use ownership rescue before updating this historical record, then retry the field update.` |
| `project_mismatch` | `Switch to the observation's owning project, then retry the field update.` |

Sin pista: `project_transition_conflict`, `project_history_unavailable`, `project_name_collision`.

### `writeProjectErrorResult(activity, sessionId, res, err)`

`res` es el resultado (parcial) de la resolución y `disp = res.available_projects ?? null`. Primero se mira `err.code` (errores de `src/project`):

| `err.code` | `error_code` | Mensaje | Disponibles |
|---|---|---|---|
| `explicit_project_required` | igual | `err.message` | `null` |
| `project_transition` | `project_transition_conflict` | `err.message` | `disp` |
| `project_history_unavailable` | igual | `err.message` | `null` |
| `database_generation_changed` | igual | `err.message` | `disp` |
| `project_ownership_ambiguous` | `session_project_ownership_ambiguous` | `err.message` | `disp` |
| `repository_binding` | `repository_binding_unavailable` | `Cannot determine project: <err.message>. Configure the repository's .odin-memory/config.json with the intended canonical project.` | `null` |

Si no, el código por defecto es `ambiguous_project` (o `invalid_project_config` si `err.code === 'invalid_config'`), salvo que `err.kind` (de `McpProjectError`) indique otra cosa:

| `err.kind` | `error_code` | Mensaje | Disponibles |
|---|---|---|---|
| `invalid_project_choice` | igual | vacío: `Project choice is empty; choose exactly one value from available_projects and retry with project_choice_reason=user_selected_after_ambiguous_project`; si no: `Project choice "<n>" is not one of available_projects` | `err.availableProjects` |
| `missing_recovery_token` | igual | `project_choice_reason=user_selected_after_ambiguous_project for "<n>" requires the recovery_token from the ambiguous_project error` | `err.availableProjects` |
| `invalid_recovery_token` | igual | `recovery_token is invalid, stale, or not valid for selected project "<n>"` | `err.availableProjects` |
| `invalid_explicit_project` | `invalid_project` | `Project "<n>" is invalid: <motivo>` | `disp` |
| `project_name_collision` | igual | `Project "<n>" collapses to stored bucket "<norm>", but multiple exact candidates would share that bucket: <colisionan separados por ", ">. Refuse write until the colliding project names are disambiguated.` | `disp` |
| `unknown_session` | igual | `Session "<id>" was provided but does not exist` + metadatos `invalid_session_id` y `retry_without_session_id: true` | `disp` |
| `unknown_project` | igual | `Project "<n>" is not backed by known context. Use an existing project, a matching session, repo .odin-memory/config.json, or ambiguous-project recovery.` | `err.availableProjects` |
| `session_project_mismatch` | igual | `Session "<id>" belongs to project "<deSesion>", but request targeted "<explicito>"` | `disp` |

Si ninguno aplica: `errorWithMeta(codigo, 'Cannot determine project: <err.message>', disp)`. Cuando el código es `ambiguous_project` y hay `activity`, se añaden `recovery_token` (de `activity.issueAmbiguousProjectRecoveryToken(sesion o defaultSessionId(''), res.available_projects ?? [], res.path ?? '')`, que puede ser `''`) y `token_ttl_seconds: 300`.

### `readProjectErrorResult(activity, res, err)`

Si `err.kind === 'unknown_project'`: `unknown_project` con `Project "<n>" not found in store` y `err.availableProjects`. Si no, `writeProjectErrorResult(activity, defaultSessionId(''), res, err)`. Si `err.code === 'ambiguous_project'` añade `hint: 'Ask the user to choose a project, then retry the same read tool with its project filter; alternatively cd into the target repo or configure repo .odin-memory/config.json. Do not retry a write tool to recover this read.'` (sustituye la pista anterior). Siempre añade `project`, `project_source` y `project_path` del resultado parcial.

## `args.js`

Lectura tolerante: `intArg(args, clave, defecto)` (número → `Math.trunc`; otro tipo → defecto), `boolArg`, `strArg` (otro tipo → `''`) y `historyCursorArg(args)`: `0` si falta la clave; si está, debe ser un número entero, ≥ 0 y < 2⁶³; si no, lanza `Error('history_cursor must be a non-negative integer')`.

## `serialize.js`

- `promptJson(p)`: `{ id, sync_id, session_id, content, created_at }` más `project` si no es vacío y `source_inbox_id` si no es vacío.
- `relationJson(rel)`: solo las claves `id sync_id source_id target_id relation reason evidence confidence judgment_status marked_by_actor marked_by_kind marked_by_model session_id created_at updated_at`, omitiendo las nulas o indefinidas (así no salen `source_int_id`, `*_title` ni `*_missing`).
- `relationsJson({ as_source, as_target })`: cada lado es la lista de `relationJson` o **`null`** si está vacía (no `[]`).

## `projects.js`

- `firstProjectValue(explicito, porDefecto, env)`: el proyecto explícito si no es vacío; si no, el del proceso (`processOverride`); si no, `''`. Es el valor que se cita en un error.
- `resolveReadProject(ctx, explicito, detect?, requireKnownProcess = true)`: llama a `resolve` (`11-proyecto.md`) con `mode: 'current'`, `processOverride = ctx.config.defaultProject`, `directory = process.cwd()`, `projectExists = (n) => projectExists(store, n)`, `detect` (por defecto `detectProject(store, dir)` con historial), `requireKnownExplicit` cuando hay proyecto explícito, y `env = ctx.env`. **No lanza**: devuelve `{ res, err }`. Un `unknown_project` se convierte en `unknownProject(nombre, stats(store).projects)`; un `invalid_project_name` en `invalidExplicitProject(firstProjectValue(...), err.message)`; cualquier otro error pasa tal cual, con el resultado parcial en `err.result` (o `{}`).
- `storedProjectFallback(observacion, res, err)`: si el error es `ambiguous_project` y la observación tiene un proyecto propio no vacío, la lectura continúa con ese proyecto (`source: 'stored_project'`, `path: ''`) y sin error; en cualquier otro caso devuelve `{ res, err }` sin cambios.

## `server.js`

`SERVER_NAME = 'odin-memory'`. `buildHandlers(ctx)` devuelve el mapa nombre → manejador de las herramientas implementadas. `createServer(store, config = {}, allowlist = null, options = {})` construye el contexto `{ store, config: { defaultProject: '', ...config }, activity: options.activity ?? new SessionActivity(), env: options.env ?? process.env }`, registra **solo** las herramientas que están en `TOOL_DEFINITIONS`, permitidas por la lista y con manejador implementado, y devuelve un `McpServer` con `name = SERVER_NAME`, `version = config.version ?? VERSION` e `instructions = buildServerInstructions(allowlist)`.

El contexto de las herramientas también incluye `cwd()`, `hostPid`, `hostbind` y `writeQueue` (ver `03-herramientas-escritura.md`).

`config.defaultProject` es el proyecto fijado para el proceso (opción `--project` o variable `ODIN_PROJECT` resueltas por la CLI en F4).
