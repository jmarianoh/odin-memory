# 12 — Servidor MCP

El servidor MCP expone la memoria al agente como herramientas `mem_*` sobre el protocolo Model Context Protocol, por la entrada y salida estándar. Se construye en tres entregas:

| Entrega | Capítulo | Contenido |
|---|---|---|
| F3.1 (spec 0.11.0) | `01-protocolo-y-servidor.md`, `02-herramientas-lectura.md` | Protocolo, perfiles, instrucciones, actividad de sesión, envelope de proyecto y errores; herramientas de lectura |
| F3.2 (spec 0.12.0) | `03-herramientas-escritura.md`, `04-vinculo-anfitrion.md` | Herramientas de escritura, resolución del proyecto de escritura, cola serializada y vínculo con el anfitrión |
| F3.3 (spec 0.13.0) | `05-herramientas-curacion.md` | Juicios, comparación, fusión de proyectos, consolidación, finalización de sesión y ciclo de vida del proceso (`mem_doctor` llega con el diagnóstico, F6) |

## Decisión de diseño: protocolo propio, sin SDK

El servidor **no usa `@modelcontextprotocol/sdk`**. Implementa a mano el subconjunto de JSON-RPC 2.0 que necesita (`initialize`, `ping`, `tools/list`, `tools/call`; las notificaciones se ignoran). Motivos:

- El catálogo de herramientas lleva campos que el SDK no deja controlar con fidelidad (`defer_loading` por herramienta, anotaciones, esquemas JSON literales). Escribirlos tal cual en la respuesta de `tools/list` es trivial; sortear la validación del SDK no.
- Menos dependencias en un entorno cerrado donde cada paquete debe estar en el Nexus.
- El transporte stdio es un mensaje JSON por línea; no justifica una librería.

Por eso `03-entorno-dependencias.md` ya no lista el SDK. Si en el futuro se necesitara otro transporte (HTTP streamable), se reevalúa.

## Estructura de `src/mcp/`

| Archivo | Responsabilidad |
|---|---|
| `json.js` | `jsonMarshal` (serialización estable), `textResult`, `errorResult`, `goQuote` |
| `protocol.js` | `McpServer`: manejo de mensajes y bucle por stdio |
| `tool-definitions.js` | Catálogo de las 27 herramientas. **No se escribe**: se copia de `fuentes/src/mcp/tool-definitions.js` |
| `profiles.js` | Perfiles `agent`/`admin`, `resolveTools`, instrucciones del servidor |
| `activity.js` | `SessionActivity`: avisos de guardado, prompt vigente, tokens de recuperación |
| `errors.js` | `McpProjectError` y sus constructores |
| `envelope.js` | Respuestas con proyecto y errores estructurados |
| `args.js` | Lectura tolerante de argumentos |
| `serialize.js` | Proyecciones JSON de prompts, relaciones y observaciones |
| `projects.js` | Resolución del proyecto de una lectura |
| `tools/projects.js`, `tools/context.js`, `tools/search.js` | Herramientas de lectura |
| `warnings.js`, `write-projects.js`, `write-support.js`, `session-helpers.js`, `write-queue.js` | Soporte de las herramientas de escritura (`03-herramientas-escritura.md`) |
| `tools/write.js`, `tools/sessions.js` | Herramientas de escritura |
| `tools/curation.js` | Juicios, comparación, fusión, consolidación y finalización (`05-herramientas-curacion.md`) |
| `run.js` | Ciclo de vida por stdio: EOF con gracia y señales |
| `server.js` | `createServer` y `buildHandlers` |
| `index.js` | Reexportaciones |

Otros archivos que esta entrega añade fuera de `src/mcp/`:

- `src/store/project-history.js`: `projectHistory`, `detectProject(store, dir, opciones)` e `inspectProject(store, dir)`. Conectan la detección de proyecto (`11-proyecto.md`) con el historial de sesiones del almacén.
- `src/store/observations.js`: `getObservationVersionPage` y las constantes `DEFAULT_OBSERVATION_VERSION_PAGE_SIZE` (50) y `MAX_OBSERVATION_VERSION_PAGE_SIZE` (100).
- `src/store/relations.js`: `searchPreviewRelations`.
- `src/store/search.js`: `compactSearchProjection`.

## Pruebas

`test/unit/mcp/{protocol,profiles,activity,envelope,tools}.test.js` y el contrato `test/contract/fixtures/mcp-tools.json` (el catálogo completo con instrucciones). Las pruebas de herramientas usan `createServer` y llaman a `server.handle(...)` sin lanzar procesos.

```bash
node --test "test/unit/mcp/*.test.js"
```
