# 15.4 — `mcp`, `version`, `help` y el texto de uso

## `mcp`

Módulo `src/cli/commands/mcp.js`. Exporta `parseMcpArgs` y `cmdMcp`.

```
odin mcp [--tools=PROFILE] [--project NAME]
```

`parseMcpArgs(args, proyectoInicial)` → `{ toolsFilter, defaultProject }`. `proyectoInicial` es el valor de `ODIN_PROJECT` (vía `processOverride('', env)`), que `--project` sustituye. Se recorren los argumentos en orden:

- `--tools=X` → filtro `X` (el prefijo se compara tal cual: `--tools=`).
- `--tools X` (con otro argumento detrás) → filtro `X`; `--tools` como último argumento se ignora.
- `--project=X` y `--project X`: el valor se recorta; vacío, o `--project` sin valor, lanza `--project requires a value`.
- Cualquier otro argumento se ignora.

`cmdMcp`: un fallo de análisis es `fatal` **antes de abrir el almacén**. Abre el almacén y construye el servidor con `createServer(store, { defaultProject, version: VERSION }, resolveTools(toolsFilter), { env, cwd })`; `await runMcp(server, cli.mcp ?? {})` (ciclo de vida en `12-mcp/05-herramientas-curacion.md`: EOF con gracia, SIGINT/SIGTERM). Un error es `fatal`; el almacén se cierra siempre. La salida estándar queda reservada al protocolo: el comando no escribe nada en ella.

Mientras no se registre `mem_doctor` (F6), `tools/list` devuelve 22 herramientas aunque los perfiles declaren 23 `agent` y 27 `all`.

## `version`

`odin <versión>` + salto de línea (`odin 0.15.0`). Acepta `version`, `--version` y `-v` (sin distinguir mayúsculas). No abre el almacén.

## `help` y sin comando

`help`, `--help`, `-h` imprimen `usageText()` en la salida estándar (código 0). Sin comando, o con un comando desconocido, lo imprimen igual pero el código es 1 (el desconocido añade `unknown command: <x>\n\n` en el error estándar).

## `usageText()` (`src/cli/usage.js`)

Devuelve el texto de ayuda. **No se escribe a mano: se copia de `fuentes/src/cli/usage.js`**, que contiene la plantilla literal. Estructura:

1. Primera línea: `odin v<versión> — Persistent memory for GitHub Copilot`, línea en blanco, `Usage:`, `  odin <command> [arguments]`, línea en blanco, `Commands:`.
2. Una entrada por comando, en este orden: `mcp`, `search`, `save`, `delete` (observación, `session`, `prompt`, `project`), `timeline`, `context`, `stats`, `export`, `import`, `init`, `projects` (`list`, `merge`, `consolidate`, `prune`, `alias`), línea en blanco, `version`, `help`.
3. `Environment:` con `ODIN_DATA_DIR`, `ODIN_PROJECT` y `ODIN_TIMEZONE`.
4. `MCP Configuration (add to your agent's config):` seguido del JSON de ejemplo con `servers` → `odin-memory` → `{ "type": "stdio", "command": "odin", "args": ["mcp", "--tools=agent"] }`.

El número de herramientas del perfil `mcp` se calcula: `agent (<PROFILE_AGENT.size> tools), admin (<PROFILE_ADMIN.size> tools), all (default, <resolveTools('agent,admin').size>)` — hoy `23`, `6` y `27`.

El texto lista **solo los comandos implementados**: cada entrega posterior (HTTP, sincronización, diagnóstico, preparación de Copilot, etc.) añade sus entradas en el lugar que le corresponde y actualiza `fuentes/src/cli/usage.js`. La prueba `dispatch.test.js` fija su primera línea, los conteos de perfiles y la ausencia de puertos heredados.
