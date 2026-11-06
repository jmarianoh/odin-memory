# 12.3 — Herramientas de escritura

Módulos: `src/mcp/{write-projects,write-support,session-helpers,write-queue,warnings}.js` y `src/mcp/tools/{write,sessions}.js`. Registradas en `server.js`.

Herramientas: `mem_save`, `mem_update`, `mem_delete`, `mem_pin`, `mem_unpin`, `mem_review`, `mem_save_prompt`, `mem_session_summary`, `mem_session_start`, `mem_session_end`, `mem_capture_passive`. Las demás de escritura (juicios, comparación, fusión, consolidación, finalización) llegan en F3.3.

## Contexto y opciones del servidor

`createServer(store, config, allowlist, options)` añade al contexto de las herramientas:

| Campo | Origen | Uso |
|---|---|---|
| `cwd()` | `options.cwd` o `process.cwd()` | directorio de trabajo para detectar el proyecto (inyectable en pruebas) |
| `hostPid` | `options.hostPid` o `process.ppid` | proceso anfitrión (ver `04-vinculo-anfitrion.md`) |
| `hostbind` | `options.hostbind` | opciones del vínculo (`processStart` simulado en pruebas) |
| `writeQueue` | `options.writeQueue` o `new WriteQueue()` | cola de escritura |

`config` admite además `bm25Floor` (umbral inferior obsoleto para candidatos) y `limit` (máximo de candidatos de conflicto por guardado; por defecto 3).

## `write-queue.js` — cola de escritura serializada

`DEFAULT_WRITE_QUEUE_SIZE = 32`. `WriteQueue(size)` (un tamaño ≤ 0 usa 32) ejecuta los trabajos **de uno en uno, en orden de llegada**. `do(run)` acepta como máximo `size` trabajos pendientes o en curso; el siguiente se rechaza al instante con `Error('odin: mcp write queue is full; retry shortly')` (`WRITE_QUEUE_FULL_MESSAGE`). Un trabajo que falla no bloquea a los siguientes; un trabajo iniciado termina siempre.

`queuedWriteHandler(queue, handler)` envuelve un manejador: la cola llena se devuelve como error de herramienta `MCP write queue error: <mensaje>`; cualquier otro fallo se propaga (el servidor lo convierte en `Internal error: …`).

Pasan por la cola: `mem_save`, `mem_update`, `mem_review`, `mem_delete`, `mem_save_prompt`, `mem_session_summary`, `mem_session_start`, `mem_session_end`, `mem_capture_passive`. **No** pasan `mem_pin` ni `mem_unpin`. (El bucle de `serve` ya procesa las peticiones una a una; la cola protege el uso programático concurrente de `handle`.)

## `warnings.js`

- `truncationWarning({original_bytes, limit_bytes, truncated})` → `''` o `\n⚠ WARNING: Content was truncated from <o> to <l> bytes. Consider splitting into smaller observations.`
- `absolutePathWarning(texto)` → `''` o `\n⚠ WARNING: Content contains an absolute filesystem path that may not be portable across machines. Use a repository-relative path instead.`
- `containsAbsoluteFilesystemPath(texto)`: recorre los puntos de código. En cada posición: (1) si empieza un **URI** se salta entero; (2) letra ASCII + `:` + (`/` o `\`) → verdadero; (3) `\` `\` y un tercer carácter que no sea `\` ni `/` → verdadero (UNC); (4) `/` que no esté seguido de otra `/` (o sea el último carácter) y cuyo carácter anterior no exista, o no sea `/` ni «de palabra» → verdadero. Carácter «de palabra» = letra, dígito decimal o marca Unicode, o `.`, `-`, `_`. Por eso `src/main.go`, `input/output` y `a//b` no avisan, pero `(/api/v1)`, `"/health"` y `/` sí (aviso a propósito ambiguo).
- Un **URI** empieza en una letra ASCII que no siga a un carácter de palabra, continúa con letras, dígitos, `+`, `-`, `.` hasta `:`, y requiere `//` a continuación o ser `file:/` (sin autoridad; sin distinguir mayúsculas); se extiende mientras haya caracteres de palabra o de `:/?#[]@!$&'()*+,;=%~`.

## `session-helpers.js`

- `currentWorkingDirectory(ctx)`: `ctx.cwd()` o `''` si falla. `runtimeSessionDirectory(ctx, dir = '')` = `runtimeWorktreeDirectory(dir recortado vacío ? cwd : dir)`.
- `captureProjectEvidence(ctx, res, sessionId, rawProject, defaultProject)` → `{ source: res.source, directory: cwd, raw_project? }`:
  - `source = session`: busca la evidencia de la sesión; si existe, hereda su `source` y su `raw_project`; si no, `source = 'unknown'`.
  - `explicit_override` o `user_selected_after_ambiguous_project`: `raw_project = rawProject`.
  - `process_override`: `raw_project` = valor del proyecto fijado (`processOverride(defaultProject, env).value`).
  - otros: sin `raw_project`.
- `ensureImplicitSession(ctx, id, project, evidence, directory = '')`: `createSession(id, project, directory o cwd, shared, evidence)`; cualquier error se ignora.
- `resolveHostBoundSession(ctx, project)`: consulta `hostbind.lookup(store.dataDir, ctx.hostPid ?? process.ppid)`. Sin vínculo → `''`. Con vínculo: la sesión raíz debe existir y su proyecto normalizado debe ser el solicitado (no vacío); luego `resolveRuntimeSession(raíz, proyecto, directorio, modo)`. Cualquier fallo (o id vacío) lanza `host session binding cannot resolve a live session for the requested project; provide session_id explicitly or restart the host session to refresh its binding`: un vínculo verificado que no se puede resolver **rechaza** la escritura.
- `resolveFallbackSessionId(ctx, project, evidence, directory = '')`: `directory` es el espacio de trabajo de una sola llamada (`mem_save_prompt`); vacío = el `cwd` del proceso. (1) la sesión vinculada al anfitrión si la hay; (2) `activeRuntimeSessions(project, runtimeSessionDirectory(ctx, directory))`: una sola → esa; varias → error `multiple active runtime sessions match the current project and directory; provide session_id, end other active matching sessions, or save independently with odin save. The resolved project is "<proyecto>"; pass that exact name as the --project value and never invent another. This writes to an independent project manual-save session and does not bind it to this MCP session`; ninguna (o si la consulta falla) → `resolveManualSession(project, cwd, evidence)`.

## `write-projects.js` — proyecto de una escritura

Cada función devuelve `{ res, err }`. A diferencia de las lecturas, una escritura **no adivina**: el proyecto sale de la sesión, de una configuración o del repositorio; una elección explícita solo vale si el proyecto ya existe, si coincide con la configuración, o como recuperación de una ambigüedad genuina con su token. `isAmbiguous(err)` = `err.code === 'ambiguous_project'`; el detector de capturas es `detectProject(store, dir, { requireExplicitHomeProject: true })`.

- `resolveWriteProject(ctx, directory = '')`: detecta desde `directory` o, si está vacío, desde `cwd`; el error es `res.error`.
- `resolveWriteProjectWithProcessOverride(ctx, requireKnownProcess)`: `resolveReadProject(ctx, '', detectorDeCaptura, requireKnownProcess)` (`projects.js`).
- `processProjectResult(ctx)` (exportada para `prompt-workspace.js`): si hay proyecto fijado para el proceso, `resolve({ mode: 'current', processOverride, env })`; devuelve `{ ok, res, err }`.
- `containsProjectChoice(disponibles, eleccion)`: comparación con recorte. `normalizedProjectCollisions(candidatos, eleccion)` → `[normalizado, lista]`: los candidatos (recortados, sin repetir) que al normalizarse coinciden con la elección; si son menos de dos la lista es vacía.
- `resolveWriteProjectWithChoice(ctx, eleccion, motivo, validarToken, directory = '')`: resuelve normalmente (desde `directory` si se indica); **sin error** devuelve eso e ignora la elección; un error que no es de ambigüedad se devuelve tal cual; si `motivo` recortado no es `user_selected_after_ambiguous_project` se devuelve la ambigüedad. Si lo es: la elección recortada debe ser una de las disponibles (si no, `invalidProjectChoice`); no debe chocar al normalizarse con otra (`projectNameCollision`); `validarToken(res, eleccion)` → `{ provided, valid }`: no proporcionado → `missingRecoveryToken`, inválido → `invalidRecoveryToken`. Éxito: `{ ...res, project: eleccion, source: 'user_selected_after_ambiguous_project', path: resolveAmbiguousChoicePath(res.path, eleccion), warning: 'project selected by user after ambiguous_project recovery' }`.
- `resolveWriteProjectWithChoiceAndProcessOverride(ctx, eleccion, motivo, validarToken)`: sin elección → proyecto del proceso/detección; con elección → `…WithChoice`.
- `normalizeExplicitWriteProject(nombre)` → `{ project, err }`. Errores `invalidExplicitProject(nombre, motivo)` con motivo `project is required` (vacío, o vacío tras normalizar), `project must be a name, not a path` (contiene `/` o `\`), `project contains control characters` (carácter < 0x20 o 0x7f).
- `knownWriteProjects(ctx, contexto)`: `stats.projects` ∪ `contexto.project` ∪ `contexto.available_projects`, recortados y sin repetir.
- `resolveSaveWriteProjectForSession(ctx, eleccion, eleccionPresente, motivo, sesion, validarToken, permitirSesionDesconocida)` es la regla completa. Con `trimmedChoice` = elección recortada:

  1. **Sesión** (si `sesion` no es vacío): si no existe → con `permitirSesionDesconocida = false`, `unknownSession(sesion)`; si no, se detecta el proyecto: si **no** es ambigüedad → `unknownSession(sesion recortada)`; si es ambigüedad y no hay `motivo = user_selected…` con elección → se devuelve la ambigüedad; si los hay, se resuelve con `…WithChoice`, se normaliza el nombre y se **registra la sesión** (`project_owned`, directorio = `res.path`, con evidencia) devolviendo ese resultado. Si existe: `sessionProject` = su proyecto normalizado (inválido → su error), `sessionMode` = su modo recortado, `sessionPath` = su directorio recortado.
  2. Si la clave `project` vino pero está en blanco → `invalidExplicitProject(eleccion, 'project is required')`.
  3. **Con elección explícita**:
     1. Se inspecciona el directorio (`detectProjectFull(cwd, { inspectOnly: true })`). Configuración inválida → error. Ambigüedad: si la elección choca al normalizarse entre los disponibles → `projectNameCollision`. Cualquier otro error → se devuelve.
     2. `project` = nombre explícito normalizado (error → se devuelve).
     3. Choque por separadores (`explicitWriteProjectCollision`): solo si `lower(trim(raw)) !== normalizado`; si el proyecto de la sesión es el normalizado → colisión `[raw, normalizado]`; si el origen del directorio es `config`, su nombre recortado difiere de `raw` y normalizado coincide → colisión con `[raw, canónico, normalizado]` sin repetir.
     4. Sesión: si `sessionProject` no es vacío, ni igual al pedido, ni la sesión es `shared`: modo `project_owned` → `sessionProjectMismatch`; otro modo → `project_ownership_ambiguous` («session "<id>" has unclassified ownership for "<p>" and cannot accept "<q>"»).
     5. Directorio ambiguo con `motivo = user_selected…` → `…WithChoice`.
     6. Si el proyecto **existe**: con separadores colapsados → colisión `[raw, normalizado]`; si no → `{ project, source: 'explicit_override', path: '' }`.
     7. Si hay `sessionProject` → `{ project, source: 'explicit_override', path: sessionPath }` (una sesión compartida admite escribir en otro proyecto).
     8. Error del directorio: ambigüedad con motivo → `…WithChoice`; si no, se devuelve el error.
     9. Origen `config` cuyo proyecto normalizado es el pedido → `{ project, source: 'explicit_override', path: cwdRes.path }`.
     10. Si nada aplica → `unknownProject(project, knownWriteProjects(...))` con `res = { available_projects }`.
  4. **Sin elección**: con proyecto de sesión → `{ project: sessionProject, source: 'session', path: sessionPath }`; si no, `resolveWriteProject`.
- `resolveSaveWriteProject(...)` = lo anterior con la sesión recortada y permitiendo la sesión desconocida.
- `resolveSaveWriteProjectWithProcessOverride(ctx, eleccion, presente, motivo, sesion, validarToken)`: si no vino `project`, ni elección, ni sesión, ni motivo (todo vacío) y hay proyecto fijado para el proceso → ese proyecto (un error al resolverlo se devuelve); en cualquier otro caso `resolveSaveWriteProject`. Por eso **una sesión o una elección anulan el proyecto fijado**.

## `write-support.js`

- `recoveryTokenValidator(ctx, args)` → `{ recoverySessionId, validate }`: `recoverySessionId` = `session_id` o, si está en blanco, `manual-save`. `validate(res, eleccion)` → `{ provided: false, valid: false }` si `recovery_token` está en blanco; si no `{ provided: true, valid: activity.validateAmbiguousProjectRecoveryToken(recoverySessionId, token, eleccion recortada, res.available_projects ?? [], res.path ?? '') }`.
- `prepareWriteProject(ctx, args)`: lee `project` (y si la clave estaba presente), `project_choice_reason`, `session_id`, `recovery_token`; llama a `resolveSaveWriteProjectWithProcessOverride`; con error devuelve `{ error: writeProjectErrorResult(activity, recoverySessionId, res, err) }`; si no `{ res, project: normalizado, warning: aviso de normalización }`.

## Las herramientas

Un argumento de tipo incorrecto se trata como ausente (`strArg`/`intArg`/`boolArg`). `Failed to …:` antecede al mensaje del store en los errores de uso.

### `mem_save`

1. `content` en blanco → se usa `observation` si no está en blanco; si sigue en blanco: `content is required for mem_save (use content, or observation for backward-compatible clients)`.
2. Título en blanco → `Failed to save: observation title is required` (**antes** de resolver proyecto o crear sesiones: un rechazo no deja sesión).
3. `capture_prompt` presente y no booleano → `capture_prompt must be a boolean`.
4. `prepareWriteProject` (error → se devuelve). `type` por defecto `manual`.
5. Sin `session_id`: `resolveFallbackSessionId` con la evidencia (error → `Failed to save: <mensaje>`).
6. `suggestedTopicKey = suggestTopicKey(type, title, content)`.
7. **Proyecto parecido**: si el proyecto no tiene observaciones y existen otros nombres, `findSimilar(proyecto, nombres, 3)`; con coincidencia: `⚠️ Project "<p>" has no memories. Similar project found: "<mejor>" (<n> memories). Consider using that name instead.`
8. Evidencia, `ensureImplicitSession`, `truncation = contentTruncation(content)`.
9. `addObservation({ project_provenance, session_id, type, title, content, project, scope, topic_key })` (error → `Failed to save: …`).
10. Prompt vigente: `activity.currentPrompt(session, project)` → `capturePromptForSave(store, capture_prompt, …)`; un error se escribe en stderr (`odin: auto prompt capture error (non-fatal): …`) y se ignora. `activity.recordSaveForProject(session, project)`.
11. Texto: `Memory saved: "<título>" (<tipo>)`; si no se pasó `topic_key` y hay sugerida: `\nSuggested topic_key: <clave>`; + aviso de truncamiento; + aviso de ruta absoluta (sobre el contenido **guardado**); + `\n<aviso de normalización>`; + `\n<aviso de proyecto parecido>`.
12. **Candidatos de conflicto** (tras confirmar): `findCandidates(id, { project, scope, require_save_relevance: true, bm25_floor?, limit? })`. Un fallo no revierte el guardado: se escribe en stderr, el envelope lleva `candidate_detection_status: "incomplete"` y el texto `\nCONFLICT DETECTION INCOMPLETE — observation saved; pending relations may be partially persisted. Returned candidates include only confirmed pending judgments.`
13. Envelope extra: `truncation`; `id`, `sync_id`, `state` y `review_after` (si hay) de la observación guardada; con candidatos: `judgment_required: true`, `judgment_status: "pending"`, `judgment_id` (el del primero), `candidates` (`{id, sync_id, title, type, score, judgment_id, topic_key?}`) y el texto `\nCONFLICT REVIEW PENDING — <n> candidate(s); use mem_judge to record verdicts.`; sin candidatos y sin fallo: `judgment_required: false`.

### `mem_update`

`expected_project` es **obligatorio y válido** (`validateExpectedProject`; si no, el mensaje `expected_project must be a valid non-empty project name` como error de uso). Luego `id` (`id is required`). Campos aceptados (solo si son cadenas): `title content find replace type scope topic_key`; ninguno → `provide at least one field to update`. Con `content` se calcula `truncation`. `updateObservation(id, campos, { expectedProject })` (error → `Failed to update memory: <mensaje>`). Texto `Memory updated: #<id> "<título>" (<tipo>, scope=<ámbito>)` + aviso de truncamiento; el envelope usa como proyecto el dueño de la observación con origen `explicit_override` y, con `content`, `truncation`.

### `mem_delete`

`expected_project` obligatorio; `id`; `hard_delete` (booleano). Error → `Failed to delete memory: …`. Respuesta de texto plano (sin envelope): `Memory #<id> soft-deleted` o `Memory #<id> permanently deleted`.

### `mem_pin` / `mem_unpin`

`id` (`id is required`); error → `Failed to update pin state: …`. Respuesta JSON sin envelope: `{ result: "Memory #<id> pinned|unpinned", id, sync_id, pinned }`.

### `mem_review`

`action` recortada. `list`: filtro `project` (opcional) y `limit` (10). Sin filtro el envelope tiene origen `all_projects`; con filtro se resuelve como lectura (desconocido → `unknown_project` con `Project "<p>" not found in store`; otro fallo → `Project resolution failed: <mensaje>`). `observationsNeedingReview(proyecto, limite)` (fallo → `Review list error: …`). Vacío → `No memories need review.` con `observations: []`. Si no, `Found <n> memories needing review:\n\n` y por entrada `[i] #<id> (<tipo>) — <título>\n    state: <estado>[ | project: <p>][ | review_after: <fecha>]\n`; el envelope lleva `observations` (`{id, sync_id, title, type, state, project?, review_after?}`).
`mark_reviewed`: `observation_id` (o `id`); falta → `observation_id is required for mark_reviewed`. El proyecto se resuelve como lectura con el detector de capturas; un error es `readProjectErrorResult` y, si es ambigüedad, su `hint` pasa a `Ask the user to choose a project, then retry mem_review action=mark_reviewed with an explicit project.` `markReviewed(id, proyecto)`: no encontrada con proyecto resuelto → `Failed to mark reviewed: observation not found in resolved project`; otro fallo → `Failed to mark reviewed: <mensaje>`. Éxito: `Memory marked reviewed: #<id> "<título>" (<tipo>)` con `id`, `sync_id`, `state`, `review_after?`.
Otra acción → `action must be one of: list, mark_reviewed`.

### `mem_save_prompt`

Argumentos `content`, `directory`, `cwd`, `session_id`, `project`, `project_choice_reason`, `recovery_token`.
- **Espacio de trabajo de la llamada** (`src/mcp/prompt-workspace.js`, spec 0.32.0). `promptWorkspaceDirectory(args)` → `{ directory, error }` se evalúa justo después de leer `content`, antes de cualquier otra cosa: recorre `directory` y luego `cwd` (gana el primero con texto no en blanco; uno en blanco cede ante el siguiente). Una clave presente que no es cadena → `<clave> must be a string`; ruta no absoluta → `<clave> must be an absolute directory`; no accesible → `<clave> is unavailable: stat <ruta>: no such file or directory` (u otra causa); no es directorio → `<clave> must name a directory`. Un error se devuelve como `Invalid workspace directory: <detalle>` (resultado de error, sin guardar nada). La ruta se conserva byte a byte. Nunca cambia el `cwd` del proceso ni vincula escrituras posteriores; y el descubrimiento (`mem_current_project`) sigue sin asociar nada.
- **Con `session_id`** el prompt conserva la autoridad de la sesión: si el motivo es `user_selected…` se resuelve antes el proyecto (configuración inválida → su error); si ese primer resultado **no** es una ambigüedad, se descartan `project` y el motivo (no pueden forzar un proyecto fuera de una ambigüedad genuina). Luego `resolveSaveWriteProjectWithProcessOverride(proyecto, presente = proyecto recortado no vacío, motivo, sesión)`.
- **Sin `session_id`**: `resolvePromptWorkspaceProject(ctx, directory, eleccion, motivo, validarToken)`: sin `directory` es `resolveWriteProjectWithChoiceAndProcessOverride`; con él, el proyecto fijado para el proceso (`processProjectResult`) manda y, si no lo hay, se resuelve con `resolveWriteProjectWithChoice(…, directory)` (la ambigüedad se recupera con el mismo token, ligado a ese espacio de trabajo).
- Errores → `writeProjectErrorResult(activity, recoverySessionId, …)`. La evidencia se captura una sola vez (con `directory = <espacio de trabajo>` si lo hubo). Sin sesión: `resolveFallbackSessionId(ctx, proyecto, evidencia, directory)` (fallo → `Failed to save prompt: …`). `ensureImplicitSession(…, directory)` → `addPrompt` (fallo → `Failed to save prompt: …`). `activity.recordPrompt(sesión, proyecto, contenido)`.
- Respuesta: `Prompt saved: "<contenido truncado a 80 caracteres>"` + aviso de truncamiento (el truncado añade `...`), con `truncation` en el envelope.

### `mem_session_summary`

`content` en blanco → `content is required for mem_session_summary` (antes de resolver proyecto). `prepareWriteProject`; sin `session_id`: reserva (fallo → `Failed to save session summary: …`); `ensureImplicitSession`; `addObservation` de tipo `session_summary`, título `Session summary: <proyecto>`, con evidencia (fallo → `Failed to save session summary: …`). `activity.recordProjectSave(proyecto)`. Texto: `Session summary saved for project "<p>"` y, si `activity.activityScore(manual-save-<p>)` no es vacío, `\n<puntuación>` (cuenta las llamadas de lectura y de sesión de la sesión de reserva, no los guardados). Envelope: `judgment_required: false`, `id`, `sync_id`, `state`, `review_after?`.

### `mem_session_start`

`id`; `directory` (opcional, recortado); `project` **no se lee**. Proyecto: sin `directory` → proceso/detección; con él → detector de capturas sobre ese directorio (un error en `res.error`). Error → `writeProjectErrorResult(null, '', …)`. `activity.recordToolCall(manual-save-<p>)`. El directorio de registro es `runtimeSessionDirectory(directory)`. `registerSessionWithProvenance({ id, project, directory, mode: shared, provenance })`: `session_already_ended` → error `session_already_ended` («Session "<id>" has already ended. Choose a new session ID and retry mem_session_start.») con `session_id` en los metadatos; otro fallo → `Failed to start session: …`. Éxito: `Session "<id>" started for project "<p>"`.

### `mem_session_end`

`id`, `summary`; `project` no se lee. Proyecto del proceso/detección; si hay error que **no** es ambigüedad → `writeProjectErrorResult(null, '', …)`; ante ambigüedad se conserva el cierre heredado con `{ project: canonicalizeProjectName(basename(cwd)), source: 'dir_basename', path: cwd }`. `endSession(id, summary)` (fallo → `Failed to end session: …`); `activity.clearSession(manual-save-<p>)`. Respuesta: `Session "<id>" completed`.

### `mem_capture_passive`

`content`, `session_id`, `source`; `project` no se lee. Proyecto con `resolveSaveWriteProjectWithProcessOverride('', false, '', session_id)` (error → `writeProjectErrorResult(activity, session_id, …)`, con el `session_id` **sin** sustituir). `recordToolCall(manual-save-<p>)`. `content` vacío (exactamente `''`) → `content is required — include text with a '## Key Learnings:' section`. Sin sesión: reserva + `ensureImplicitSession`. `source` por defecto `mcp-passive`. `passiveCapture(...)` (fallo → `Passive capture failed: …`). Respuesta: `Passive capture complete: extracted=<n> saved=<n> duplicates=<n>`.

## Omisiones deliberadas

- No hay medición de tiempos de `mem_save` por variable de entorno ni sus registros de diagnóstico.

## Pruebas

`test/unit/mcp/{write-tools,support}.test.js` (y `test/unit/hostbind/`, `test/unit/store/provenance.test.js`). Las pruebas de `write-tools` usan un repositorio git temporal y `createServer(…, { cwd })`.
