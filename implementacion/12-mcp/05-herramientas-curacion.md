# 12.5 — Herramientas de curación y ciclo de vida

Módulos: `src/mcp/tools/curation.js`, `src/mcp/run.js`, ampliación de `src/mcp/protocol.js` (`serve` con `signal`) y `src/mcp/serialize.js` (`observationJson`).

Herramientas: `mem_judge`, `mem_judge_many`, `mem_compare`, `mem_merge_projects`, `mem_consolidate`, `mem_session_finalize`. Con ellas están registradas **todas** las herramientas del catálogo salvo `mem_doctor`, que se registra cuando exista el diagnóstico (F6); mientras tanto `createServer` la omite aunque la lista permitida la nombre.

Pasan por la cola de escritura: `mem_judge`, `mem_judge_many`, `mem_merge_projects`, `mem_consolidate`, `mem_session_finalize`. **No** pasa `mem_compare`.

## `serialize.js` — `observationJson(obs)`

Observación para el cliente: siempre `id, sync_id, session_id, type, title, content, scope, revision_count, duplicate_count, created_at, updated_at`; y solo si no son nulos `tool_name, project, topic_key, last_seen_at, review_after, superseded_by_sync_id, deleted_at` (una cadena vacía sí se incluye). No incluye el estado fijado ni columnas internas.

## `mem_judge`

Argumentos: `judgment_id`, `relation`, `reason`, `evidence`, `confidence`, `session_id`. Errores de uso, en este orden: `judgment_id is required` (no es cadena o está vacío), `relation is required`, `confidence must be between 0.0 and 1.0` (si `confidence` es un número fuera de [0, 1]). `reason` y `evidence` solo se envían si son cadenas **no vacías**; `confidence` solo si es número; `session_id` se pasa como cadena (vacío si no lo es). El juicio se marca siempre con `marked_by_actor = 'agent'` y `marked_by_kind = 'agent'`. Llama a `judgeRelation` (`10-store/04`); un fallo es error de uso con el mensaje del store. Respuesta: JSON `{ "relation": relationJson(relación) }` (sin envelope de proyecto).

## `mem_judge_many`

Argumentos: `judgments` (arreglo de 1 a 32 elementos; si no: `judgments must be an array containing 1..32 items`) y `session_id` opcional (si está y no es cadena: `session_id must be a string`).

Cada elemento produce, en orden, un resultado `{ index, judgment_id, status, ... }`:
- `judgment_id` es el del elemento si es una cadena, o `null`.
- Validación de tipos sin coaccionar (primer error que aparezca): el elemento no es objeto → `judgment must be an object`; `judgment_id`, `relation`, `reason` o `evidence` presentes y no cadena → `<campo> must be a string`; `confidence` presente y no número finito entre 0 y 1 → `confidence must be a number between 0.0 and 1.0`.
- Si es válido se ejecuta como `mem_judge` con los argumentos del elemento y `session_id` = el del lote (cadena vacía si no hay). Un error de uso del juicio se copia a `error`. Un éxito copia **todos** los campos de la respuesta del juicio (`relation`), añade `judgment_status` (el de la relación) y `status: "success"`.
- Los fallos llevan `status: "error"` y `error`.
Respuesta: `{ "outcomes": [...] }`.

## `mem_compare`

Persiste un veredicto semántico que el agente ya juzgó fuera. Validaciones en orden (error de uso): `memory_id_a` no es número → `memory_id_a is required (integer observation id)`; ídem `memory_id_b`; `relation` ausente o vacía → `relation is required`; `reasoning` → `reasoning is required`; `confidence` no es número → `confidence is required (float 0.0..1.0)`; fuera de [0, 1] → `confidence must be between 0.0 and 1.0`. `model` opcional. Los identificadores se truncan hacia cero (`1.9` → `1`). Cada observación debe existir y no estar borrada; si falta: `observation id=<id> not found: sql: no rows in result set`. Llama a `judgeBySemantic({ source_id: sync_id de A, target_id: sync_id de B, relation, confidence, reasoning, model })` (un fallo es error de uso con su mensaje). Respuesta JSON `{ "sync_id": "<id de la relación>" }`. Usar el mismo par en sentido inverso actualiza la relación existente.

## `mem_merge_projects`

Argumentos `from` (nombres separados por comas) y `to`. Sin alguno → `both 'from' and 'to' are required`. Los nombres de `from` se recortan y se descartan los vacíos; ninguno → `at least one source project name is required in 'from'`. Llama a `mergeExplicitProjectVariants` (un fallo → `Merge failed: <mensaje>`). Respuesta de **texto plano**:

```
Merged <n> source(s) into "<canónico>":          (o: No records moved into "<canónico>".)
  Observations moved: <n>
  Sessions moved:     <n>
  Prompts moved:      <n>
```
(cada línea termina en `\n`). La primera línea es la de «No records moved» cuando no se fusionó ningún origen.

## `mem_consolidate`

Previsualiza sin escribir; para ejecutar hay que repetir los mismos argumentos con `confirm: true` y la huella de la previsualización.

Argumentos admitidos (otro nombre → error): `ids_to_delete`, `new_title`, `new_content`, `expected_project`, `type`, `topic_key`, `confirm`, `fingerprint`. Validación, en este orden, con código `invalid_arguments`:
1. clave no admitida → `unsupported argument "<clave>"; source project/session/scope cannot be overridden`;
2. `new_title`, `new_content`, `expected_project` deben ser cadenas no vacías tras recortar (`<campo> must be a non-empty string`);
3. `ids_to_delete` debe ser un arreglo de al menos dos elementos (`ids_to_delete must be an array of at least two positive integer IDs`) y cada uno un número entero finito entre 1 y 9007199254740991 (`ids_to_delete must contain positive exact JSON integers`);
4. `type`, `topic_key`, `fingerprint`, si están, deben ser cadenas (`<campo> must be a string`);
5. `confirm`, si está, debe ser booleano (`confirm must be a boolean`);
6. `confirm` verdadero exige `fingerprint` no vacío (`fingerprint is required when confirm is true`).

Se llama a `consolidateObservations({ ids, overrides: { title: new_title, content: new_content, type, topic_key }, expected_project, confirm, fingerprint })` (`10-store/05`). Un fallo del store se traduce a un error de herramienta cuyo texto es JSON `{ "error": { "code", "message" }, "plan"? }`:

| Fallo del store | `code` | `plan` |
|---|---|---|
| `consolidate_fingerprint_mismatch` | `fingerprint_mismatch` | el plan vigente (`err.plan`) |
| `observation_project_mismatch` | `project_mismatch` | no |
| `expected_project_required` | `invalid_arguments` | no |
| cualquier otro | `consolidation_refused` | no |

Respuesta correcta (texto JSON): `{ "status": "preview", "plan": plan }`; si se ejecutó, `status: "consolidated"` más `survivor` (`observationJson`) y `soft_deleted_ids` (los `ids` del plan, tal como se pasaron).

**Plan** (`consolidationPlanJson`): `{ source_ids: ids, sources: [observationJson…] (la más reciente primero), project, fingerprint, survivor: { session_id, title, content, type, scope, project, topic_key } }`.

## `mem_session_finalize`

Guarda de forma atómica un resumen estructurado y cierra una sesión existente; es idempotente.

1. Los argumentos `session_id`, `summary`, `project`, `project_choice_reason`, `recovery_token`, si están, deben ser cadenas: `invalid_arguments` con `<campo> must be a string`.
2. `session_id` y `summary` no vacíos (recortados): `invalid_arguments` con `session_id and summary are required and must be nonempty`.
3. La sesión debe existir **con ese identificador exacto** (sin recortar): `unknown_session` con `session_id must identify an existing exact session`.
4. Proyecto: `resolveSaveWriteProjectForSession(ctx, project, claveProjectPresente, project_choice_reason, session_id, validarToken, false)` (no admite crear sesiones). El token se valida contra el `session_id` y `res.available_projects`/`res.path`. Un error se traduce con `writeProjectErrorResult(activity, session_id, …)`.
5. `finalizeSession({ session_id, project: resolved.project, summary })` (`10-store/08`). Códigos de error (con `message` del store y `session_id` en los metadatos): `session_already_ended` → `session_already_ended`; `session_not_found` → `unknown_session`; `session_ownership_mismatch` → `session_project_mismatch`; `observation_content_required` → `invalid_arguments`; otro → `session_finalize_failed`.
6. Respuesta con envelope de proyecto: `result: "Session finalization completed"`, `session_id`, `state` (`finalized` o `already_finalized`), `summary_id`, `summary_sync_id`, `already_finalized`, `judgment_required: false`. Solo cuando es nueva se registra `activity.recordProjectSave(proyecto)`.

Una sesión compartida admite un `project` distinto al suyo en la resolución, pero el almacén lo rechaza al finalizar (`session_project_mismatch`); una sin `project` explícito usa el proyecto de la sesión.

## Ciclo de vida: `serve` y `runMcp`

- `McpServer.serve({ input, output, graceMs = 5000, signal })`: además de lo descrito en `01-protocolo-y-servidor.md`, si `signal` (un `AbortSignal`) se aborta, deja de leer y la promesa se resuelve **de inmediato**, sin esperar a las peticiones en curso; con la señal ya abortada ni empieza. Al cerrarse la entrada (EOF) el temporizador de gracia no retiene el proceso (`unref`).
- `runMcp(server, { input = process.stdin, output = process.stdout, graceMs = 5000, processRef = process, log })` → `'eof' | 'signal'`: crea un `AbortController`, registra manejadores de `SIGINT` y `SIGTERM` en `processRef`, sirve, y siempre retira los manejadores al terminar. Una señal escribe `[odin] shutting down...` por `log` (stderr por defecto) y termina limpiamente (la CLI cierra el almacén y sale con código 0). EOF espera a las peticiones en curso hasta `graceMs`.

La CLI (F4) resuelve `--tools`, `--project` y `ODIN_PROJECT`, abre el almacén, llama a `createServer` y a `runMcp`, y cierra el almacén al terminar.

## Pruebas

`test/unit/mcp/curation-tools.test.js`, `test/unit/mcp/run.test.js` y los casos de señal en `protocol.test.js`.
