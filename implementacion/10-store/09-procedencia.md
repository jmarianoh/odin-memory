# 10.9 — Procedencia de captura y prompts al guardar

Módulos: `src/store/provenance.js` (nuevo) y cambios en `observations.js`, `prompts.js`, `sessions.js`, `runtime-sessions.js`, `passive.js`, `index.js`, `errors.js`.

La **procedencia** es evidencia local de cómo se resolvió el proyecto cuando se creó un registro (sesión, observación o prompt). Sirve para diagnóstico y reparaciones; **nunca concede propiedad ni inscripción** y no se sincroniza. Vive en la tabla `capture_project_provenance(entity_kind, entity_id, source, directory, raw_project)` con clave primaria `(entity_kind, entity_id)` (ya definida en el esquema).

## `provenance.js`

Tipo `ProjectProvenance = { source?, directory?, raw_project? }`. `null`/`undefined` significa «el llamador no aportó evidencia».

- Orígenes válidos de `source` (todos los de `src/project/detect.js` más `unknown` y la cadena vacía): `''`, `unknown`, `git_remote`, `git_root`, `git_child`, `dir_basename`, `ambiguous`, `explicit_override`, `session`, `user_selected_after_ambiguous_project`, `request_body`, `config`, `all_projects`, `process_override`, `stored_project`, `unbound_git`.
- `validateProvenance(p)`: nada si `p` es nulo; si `source` no está en la lista → `StoreError` `invalid_project_provenance` con mensaje `invalid project_provenance: unsupported source "<valor>"`. El mensaje base nuevo en `errors.js` es `invalid project_provenance`.
- `parseProvenance(valor)`: para valores JSON de clientes (HTTP). Debe ser un objeto (no nulo ni arreglo) o falla con `invalid project_provenance`; los campos `source`, `directory`, `raw_project`, si están, deben ser cadenas (`null` también falla: `invalid project_provenance: <campo> must be a string`); los campos desconocidos se aceptan y se descartan; el resultado se valida con `validateProvenance`.
- `captureProvenance(db, kind, id, p)` (dentro de una transacción): **primero borra** la evidencia de `(kind, id)` —un identificador de sesión borrado puede registrarse de nuevo y no hereda evidencia vieja— y, si `p` no es nulo, inserta `(kind, id, p.source || 'unknown', p.directory ?? '', p.raw_project ?? '')` con `ON CONFLICT(entity_kind, entity_id) DO NOTHING`.
- `captureProjectProvenance(store, kind, id)` → `{ source, directory, raw_project }` o `null` si no hay (registros importados o anteriores).

`kind` es `session`, `observation` o `prompt`; `id` es el id de sesión, o el id numérico en texto.

## Dónde se captura

La evidencia se guarda **solo cuando se crea un registro nuevo**, nunca en repeticiones, deduplicaciones ni actualizaciones:

| Operación | Cambio |
|---|---|
| `addObservation(store, p)` | acepta `p.project_provenance`; valida **antes** de cualquier otra cosa; llama a `captureProvenance(db, 'observation', String(id), …)` solo en la rama que inserta una fila nueva (no al actualizar por `topic_key`, ni al deduplicar, ni al repetir una operación) |
| `addPrompt(store, p)` | ídem con `'prompt'`, solo si la inserción ocurre (no si la bandeja ya tenía el prompt) |
| `createSession(store, id, project, directory, mode, provenance = null)` | valida primero; captura `'session'` solo si la sesión no existía |
| `resolveManualSession(store, project, directory, provenance = null)` | pasa la evidencia a `createSession` en ambos intentos (el identificador histórico y el derivado) |
| `passiveCapture(store, p)` | valida `p.project_provenance` al principio (aunque no haya aprendizajes) y la pasa a cada `addObservation` |
| `registerSessionWithProvenance(store, { id, project, directory, mode, resume, isolated, provenance })` | nueva, en `runtime-sessions.js`: valida; una sesión aislada fuerza `directory = ''` y `mode = project_owned`; devuelve el id efectivo; captura `'session'` solo si la sesión (la efectiva, tras una continuación) no existía |

`registerSession` (interna) recibe la evidencia como opción y la captura justo después de `startSessionRow` cuando la sesión no existía.

## Prompts al guardar

- `addPromptIfMissing(store, p)` → `{ id, inserted }`: valida la evidencia; el contenido pasa por `prepareStoredContent` (vacío → `prompt_content_required`); en una transacción resuelve el proyecto con `resolveWriteProject` y busca `SELECT id FROM user_prompts WHERE session_id = ? AND ifnull(project, '') = ? AND content = ? ORDER BY id DESC LIMIT 1`; si existe devuelve `{ id, inserted: false }`. Si no, inserta `(sync_id, session_id, content, project)` con un `sync_id` nuevo, borra una posible lápida de ese `sync_id`, captura la evidencia `'prompt'` y registra la mutación de sincronización con `source_inbox_id: ''`.
- `capturePromptForSave(store, enabled, prompt)`: no hace nada si `enabled === false` o si el contenido recortado está vacío; si no, llama a `addPromptIfMissing`. Se invoca tras un guardado correcto y sus errores **no son fatales**. Guarda una fila de prompt independiente, sin vincularla a la observación.

## Truncamiento

`contentTruncation(store, content)` → `{ original_bytes, limit_bytes, truncated }`: lo que `prepareStoredContent` calcula para ese contenido (tras quitar las etiquetas privadas), sin guardar nada.

## Pruebas

`test/unit/store/provenance.test.js`.
