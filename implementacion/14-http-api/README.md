# 14 — API HTTP local

`odin serve` publica la memoria por HTTP en el bucle local (`127.0.0.1`) o en un socket Unix, para los clientes que no hablan MCP: los *hooks* de Copilot, scripts y herramientas de diagnóstico. Es el mismo almacén que usan la CLI y el servidor MCP; el servidor no añade reglas de negocio, solo traduce peticiones y respuestas.

Se construye en la entrega **F4.2 (spec 0.16.0)**. `/conflicts/{stats,deferred,scan}` y `/compatibility` llegan en la entrega F4.3 (spec 0.17.0); `/conflicts/deferred/replay` y `/projects/rescue-ownership` en F5 (spec 0.18.0) y `/doctor` en F6. Todas se añaden a la misma tabla de rutas.

| Documento | Contenido |
|---|---|
| `README.md` (este) | Arquitectura, convenciones, ciclo de una petición, autenticación, errores y pruebas |
| `01-rutas.md` | Referencia ruta por ruta: parámetros, cuerpos, respuestas y errores |
| `02-servidor-y-serve.md` | `HttpServer`, el socket Unix, `odin serve`, el modo de sesión propia y el estado de sincronización |

## Módulos (`src/server/`)

| Archivo | Responsabilidad |
|---|---|
| `http.js` | `HttpError`, `sendJson`/`sendError`/`sendText`, `queryInt`/`queryBool`/`parseBool`, `readBody` |
| `decode.js` | Lectura del cuerpo JSON: `firstJsonValue`, `pickFields`, `decodeBody`, `DecodeError` |
| `router.js` | `Router`: patrones `MÉTODO /ruta/{comodín}` |
| `auth.js` | `requireAuth`, `requireConfiguredAuth`, `constantTimeEqual` |
| `project.js` | Resolución del proyecto de una petición y su traducción a respuestas de error |
| `sync-status.js` | `storeSyncStatus`: proveedor del estado de sincronización a partir del almacén |
| `unix-socket.js` | Validación de la ruta, limpieza de sockets huérfanos y enlace con permisos 0600 |
| `server.js` | `HttpServer` (ciclo de vida) y `cleanPath` |
| `routes/table.js` | `ROUTES`: la tabla única de rutas |
| `routes/sessions.js`, `observations.js`, `prompts.js`, `context.js`, `workflows.js`, `workflow-body.js`, `system.js` | Manejadores, agrupados por tema |
| `index.js` | Reexporta `HttpServer`, `ROUTES`, `runtimeContractProjection` |
| `../cli/commands/serve.js` | `odin serve` |

El módulo `src/mcp/tools/curation.js` exporta además `parseConsolidate`, `judgeParams` y `judgmentItemError`, que la API reutiliza para que MCP y HTTP validen igual.

## Convenciones de las respuestas

1. **JSON con escapes HTML**: se serializa con `toGoJson` (`<`, `>`, `&`, U+2028 y U+2029 como `\uXXXX`) y se termina con un salto de línea. Cabecera `Content-Type: application/json`.
2. **Errores**: `{"error": "<mensaje>"}` más, a veces, campos que el cliente puede usar (`code`, `available_projects`, `remedy`…). El mensaje es texto para personas; el `code` es el contrato.
3. **Listas vacías** son `[]`, salvo `available_projects`, que es `null` cuando no hay proyectos.
4. **Campos nulos se omiten** en observaciones, prompts y sesiones (`observationJson`, `promptJson` de `src/mcp/serialize.js`); `pinned` nunca se serializa.
5. **404 y 405 del enrutador** son texto plano: `404 page not found\n` y `Method Not Allowed\n` (con `Allow`).
6. **Rutas no limpias** (`//`, `.`, `..`) responden `301` a la ruta limpia conservando la consulta, como el enrutador estándar.
7. Los parámetros enteros de consulta que no son un entero decimal (`abc`, `1.5`, `99999999999999999999`) se ignoran y se usa el valor por defecto. Un `+` en la consulta es un espacio (`%2B` para un signo más).

## Ciclo de una petición (`HttpServer.#serve`)

1. Si el servidor es de **sesión propia**, la petición debe traer `Authorization: Bearer <ODIN_TOKEN>` exacto (comparación en tiempo constante); si no, `401 {"error":"authorization required"}` con `WWW-Authenticate: Bearer realm="odin-memory"`. Esta comprobación precede al enrutado: protege también `/health` y las rutas inexistentes.
2. `cleanPath` de la ruta; si cambia, `301`.
3. `Router.match(método, ruta)`: sin coincidencia → 404; ruta conocida con otro método → 405.
4. Se crea el contexto (`RequestContext`) y se ejecuta, según la ruta, `requireAuth` (rutas `auth`) o `requireConfiguredAuth` (rutas `configured`).
5. El manejador (síncrono o `async`) escribe la respuesta o lanza `HttpError`; cualquier otra excepción responde `500 {"error":"internal error"}` y se registra.
6. Si el cuerpo no se leyó, se descarta (`req.resume()`).
7. Tras responder, si el almacén ya observó que su base cambió de identidad (`DatabaseGenerationChangedError`), se resuelve **una vez** la promesa `generationInvalidated` para que el proceso dueño se detenga.

El `RequestContext` expone: `req`, `res`, `path`, `query` (`URLSearchParams`), `params` (comodines), `store`, `env`, `version`, `sessionOwned`, `cwd()`, `body(limite?)` (lee y memoriza el cuerpo; lanza `BodyTooLargeError` si lo supera), `notifyWrite()` y `syncStatus`.

## Autenticación

| Mecanismo | Cuándo |
|---|---|
| Ninguno | `ODIN_HTTP_TOKEN` sin definir: acceso abierto (cero configuración) |
| `requireAuth` | Rutas marcadas `auth` en la tabla: con `ODIN_HTTP_TOKEN` definido exigen `Authorization: Bearer <token>`. Sin cabecera `Bearer ` → `401 authorization required`; token distinto → `401 invalid token`. La variable se lee **en cada petición** |
| `requireConfiguredAuth` | Rutas `configured` (reservadas a F5): sin token configurado → `503 server authorization is not configured` |
| Sesión propia | El token privado `ODIN_TOKEN` sustituye a lo anterior en **todas** las rutas |

Rutas con `auth`: `DELETE /sessions/{id}`, `DELETE /observations/{id}`, `DELETE /prompts/{id}`, `GET /export`, `POST /import`, `POST /observations/consolidate`, `POST /conflicts/judge-many`, `POST /sessions/{id}/finalize`.

## Lectura del cuerpo JSON (`decode.js`)

El contrato espera el comportamiento del decodificador de JSON de Go; hay que reproducirlo porque los clientes dependen de qué se acepta:

* Se lee **solo el primer valor** del texto; lo que sigue se ignora, salvo en las rutas que exigen un único valor (`single`).
* Las claves se comparan **sin distinguir mayúsculas** (`"Session_ID"` vale `session_id`).
* Un valor `null` equivale a campo ausente.
* Un tipo que no corresponde invalida la petición: `invalid json: json: cannot unmarshal <tipo> into Go struct field .<campo> of type <tipo>`. Un cuerpo que no es un objeto: `... into Go value of type struct`.
* Los campos desconocidos se ignoran, salvo en las rutas `strict` (sesiones de runtime, decisión de captura).
* Mensajes de sintaxis fijos: cuerpo vacío o solo espacios → `EOF`; truncado → `unexpected EOF`; literal mal escrito → `invalid character 'o' in literal null (expecting 'u')`; otro inicio inválido → `invalid character 'x' looking for beginning of value`. Dentro de un objeto o array con sintaxis rota se usa el mensaje del analizador de JavaScript.
* Los enteros deben ser integrales (`1.5` en un campo entero invalida la petición).

## Resolución de proyecto (`project.js`)

`resolveRequestProject(ctx, opciones)` aplica a las lecturas el mismo orden que los demás transportes: proyecto explícito (`?project=`) → proyecto fijado para el proceso (`ODIN_PROJECT`) → detección por el directorio (`?cwd=`, o el del proceso).

* `project` presente exige exactamente un valor no en blanco; si no, `400 invalid_project` (`invalid project name: project parameter must be specified exactly once and must not be blank`).
* `all_projects` debe ser un booleano (`ParseBool`); verdadero resuelve «todos los proyectos» y no se combina con `project` (`... project and all_projects cannot be used together`).
* Con `requireKnown` (por defecto) el proyecto explícito o fijado **debe existir**.

Traducción de errores (`projectResolutionError`):

| Causa | Estado | `code` | Campos extra |
|---|---|---|---|
| Proyecto desconocido | 404 | `unknown_project` | `available_projects` (o `null`); mensaje `project "x" not found` |
| Nombre inválido | 400 | `invalid_project` | |
| Directorio ambiguo | 409 | `ambiguous_project` | `available_projects`, `project_source`, `project_path` |
| Proyecto explícito requerido (p. ej. HOME) | 409 | `explicit_project_required` | |
| Transición de proyecto | 409 | `project_transition_conflict` | `candidate_project`, `available_projects` |
| Cualquier otro | 500 | `project_resolution_failed` | |

Todos llevan el mensaje `project resolution failed: <causa>` salvo el desconocido. `GET /stats` es más estricto: un error de resolución no reconocido responde el mensaje opaco `project resolution failed`.

## Propiedad de registros históricos

Los errores `project_ownership_ambiguous` y `project_required` del almacén se convierten en `409` con `code` (`project_ownership_ambiguous` / `project_ownership_required`) y `remedy: "odin projects rescue-ownership --project <name>"` (con ` --session <id>` si se conoce).

## Pruebas

* `test/unit/server/router.test.js` — enrutador, `cleanPath`, comparación en tiempo constante, `ParseBool`/consultas, `firstJsonValue`, `pickFields`, directorios de confianza.
* `test/unit/server/routes.test.js` — todas las rutas de punta a punta contra un servidor real sobre un almacén temporal.
* `test/unit/server/serve.test.js` — token, sesión propia, socket Unix (permisos, huérfanos, directorios inseguros), puerto ocupado, cambio de generación, `odin serve` (opciones, señales, línea de disponibilidad).

Estos archivos están en `fuentes/test/unit/server/` y son el oráculo de aceptación: el código reconstruido debe pasarlos tal cual.
