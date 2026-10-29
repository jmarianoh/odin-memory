# 15 — CLI

`odin` es una sola herramienta de línea de comandos que sirve a la vez al agente (servidor MCP) y a la persona (consultas, copias, mantenimiento). Se construye en entregas:

| Entrega | Capítulos | Contenido |
|---|---|---|
| F4.1 (spec 0.15.0) | `01-comandos-memoria.md`, `02-respaldo-e-init.md`, `03-proyectos.md`, `04-mcp-y-uso.md` | Despachador, contexto de ejecución y los comandos `version`, `help`, `mcp`, `init`, `search`, `save`, `delete`, `timeline`, `context`, `stats`, `export`, `import`, `projects` (`list`, `merge`, `consolidate`, `prune`, `alias`) |
| F4.2 (spec 0.16.0) | `../14-http-api/` | `serve [puerto]`, `serve --socket`, `serve --session-owned` y la API HTTP local |
| F4.3 (spec 0.17.0) | `../17-conflictos-llm.md` | `conflicts` (`list`, `show`, `stats`, `scan`, `deferred`, `prune`), `instance-id`, `compatibility`, `migrate-copy` |
| F5 (spec 0.18.0) | `../16-git-sync.md` | `sync` (`--import`, `--status`, `--all`, `--include-prompts`), `projects rescue-ownership`, `conflicts deferred --replay` |
| F6.1 (spec 0.19.0) | `../18-doctor.md` | `doctor [--json] [--project P] [--check CODE]` |
| F6.3 (spec 0.20.0) | `../20-selftest.md` | `test [suite] [--quick] [--json]` y la comprobación de versión |
| F6.2 (spec 0.21.0) | `../18-doctor.md` | `doctor repair` (traslado de proyecto, sesiones y relaciones huérfanas) |
| F7 (spec 0.22.0) | `../21-copilot-vscode.md`, `../22-copilot-cli.md`, `../23-hooks-copilot.md` | `setup vscode-copilot`, `setup copilot-cli`, `hook <acción>` y `hook resolve-hook-project` |
| F8 (spec 0.23.0) | `../19-tui.md` | `tui` |
| F9 y siguientes | — | `doctor discard-empty-prompt` y las reparaciones del diario (nube), `cloud` |

## Decisiones de diseño

1. **La CLI es una función, no un script.** `run(args, overrides)` (en `src/cli/index.js`) recibe los argumentos **sin** el nombre del programa y devuelve el código de salida; nunca llama a `process.exit`. `bin/odin.js` solo comprueba la versión de Node, llama a `run(process.argv.slice(2))` y asigna `process.exitCode`. Así cada flujo se prueba sin lanzar procesos.
2. **Todo lo que toca el entorno es inyectable** (`Cli`, ver abajo). Las pruebas pasan sus propios `out`, `err`, `cwd`, `env`, `readLine` y `openStore`.
3. **Los comandos son síncronos** salvo `mcp` (que espera al servidor). El almacén es síncrono (`node:sqlite`).
4. **Salida de texto fija.** Los formatos de este capítulo son contrato: los usan personas, scripts y los tests. No se "mejoran" sin subir la versión.
5. **Errores**: `odin: <mensaje>` en el error estándar y código 1 (`fatal`). Los errores de uso (argumentos erróneos) imprimen su propia línea de `usage:` o `error:` y también salen con 1.

## El contexto `Cli` (`src/cli/runtime.js`)

```js
{
  args,        // argumentos tras el nombre del programa; args[0] es el comando
  env,         // variables de entorno (process.env)
  cwd(),       // directorio de trabajo
  out(text),   // salida estándar (sin salto de línea automático)
  err(text),   // error estándar
  readLine(),  // una línea de la entrada, sin el salto; null en EOF
  openStore(config), // abre el almacén: Store.open
  home(),      // directorio personal (os.homedir)
  mcp,         // opcional: input, output, graceMs, processRef, log para el servidor MCP (pruebas)
  serve,       // opcional: input, processRef, signal, graceMs, log, ready para `odin serve` (pruebas)
}
```

Utilidades del mismo módulo:

| Símbolo | Comportamiento |
|---|---|
| `CliExit` | Excepción que lleva el código de salida; `run` la captura. Cualquier otra excepción se propaga. |
| `fatal(cli, error)` | Escribe `odin: <mensaje>\n` en `err` y lanza `CliExit(1)`. Acepta un `Error` o una cadena. |
| `exit(code)` | Lanza `CliExit(code)`. |
| `println(cli, texto = '')` | `out(texto + '\n')`. |
| `withStore(cli, config, fn)` | Abre el almacén (un fallo es `fatal`), ejecuta `fn(store)` y lo cierra siempre (ignorando errores al cerrar). |
| `truncate(texto, max)` | Recorta a `max` **puntos de código**; si recorta añade `...`. |
| `padRight(texto, ancho)`, `padLeft(valor, ancho)` | Relleno con espacios contando puntos de código (`%-Ns` y `%Ns`). |
| `parseInt64(texto)` | Entero decimal con signo opcional y rango de 64 bits; `null` si no es válido (no admite espacios, decimales ni sufijos). |
| `scanLeadingInt(texto)` | Entero al inicio del texto (ignora lo que sigue); `null` si no hay. Equivale a leer `%d` de una cadena. |
| `fsErrorText(err, ruta)` | Texto de un error de archivo `"<operación> <ruta>: <causa>"` (`open /x: no such file or directory`) con causas fijas para `ENOENT`, `EACCES`, `EPERM`, `EISDIR`, `ENOTDIR`, `EEXIST`, `ENOSPC`, `EROFS`; para otros códigos, el mensaje original. |
| `readLineSync()` | Lee una línea de la entrada estándar de forma síncrona (descriptor 0), sin el salto (y sin `\r` final); `null` en EOF sin ningún carácter. |

## Configuración (`src/cli/config.js`)

`resolveConfig(env, home)` devuelve `{ dataDir }`: el valor de `ODIN_DATA_DIR` si no está en blanco (se usa **tal cual**, sin recortar) y, si no, `<home>/.odin-memory`. `Store.open` rechaza una ruta no absoluta.

No se implementa la migración de bases "huérfanas" en ubicaciones erróneas: es un problema de una versión antigua de otra herramienta que odin nunca tuvo.

## Despacho (`src/cli/index.js`)

Orden exacto de `dispatch(cli)`:

1. Sin comando: imprime el uso **en la salida estándar** y sale con 1.
2. `migrate-copy` y `compatibility` (comparados tal cual, sensibles a mayúsculas) se ejecutan sin resolver configuración ni abrir el almacén y su código de retorno (0, 1 o 2) es el de la CLI (`CliExit`); ver `../17-conflictos-llm.md`.
3. `export` o `import` con `--help` en cualquier posición posterior: imprime su ayuda corta (`EXPORT_HELP`/`IMPORT_HELP`, ver `02-respaldo-e-init.md`) en la salida estándar y termina con 0, sin resolver configuración ni abrir el almacén.
4. El comando se compara en minúsculas y sin espacios en los extremos **solo** para los que no usan el almacén: `version`/`--version`/`-v` imprime `odin <versión>`; `help`/`--help`/`-h` imprime el uso; `init` ejecuta `cmdInit`.
5. Los demás comandos distinguen mayúsculas y se buscan en la tabla `STORE_COMMANDS` con `Object.hasOwn` (para que `toString` o `__proto__` no cuenten como comandos). Si no existe: `unknown command: <comando>\n\n` en el error estándar, luego el uso en la estándar y código 1.
6. Resuelve la configuración y llama al manejador con `(cli, config)`.

Tabla `STORE_COMMANDS`: `serve` (ver `../14-http-api/`), `conflicts` e `instance-id` (ver `../17-conflictos-llm.md`), `mcp`, `search`, `save`, `delete`, `timeline`, `context`, `stats`, `export`, `import`, `projects`.

## Resolución de proyecto de las lecturas (`src/cli/project.js`)

- `resolveCliProject(cli, store, explicit, requireKnownOverrides)`: aplica `resolve` (ver `11-proyecto.md`) en modo `current` con el directorio `cli.cwd()`, el detector con historial del almacén (`detectProject`), `projectExists` del almacén y el entorno de `cli.env`. Con `requireKnownOverrides` el proyecto explícito y el de `ODIN_PROJECT` deben existir (si no, error de proyecto desconocido); la detección por directorio sigue siendo válida antes de la primera escritura. Devuelve `result.project` (cadena vacía si no hay).
- `resolveCliProjectScope(cli, store, explicit, all, requireKnownOverrides)`: con `all` devuelve `''` (todos los proyectos), y si además hay `--project` no vacío lanza `--all and --project cannot be used together`.
- `requiredProjectValue(args, índice)`: el valor que sigue a `--project`, recortado; si falta, está vacío o empieza por `-` lanza `--project requires a non-empty value`.

## Archivos

| Archivo | Contenido |
|---|---|
| `bin/odin.js` | Comprobación de Node, `run`, código de salida |
| `src/cli/index.js` | `createCli`, `run`, despacho |
| `src/cli/runtime.js` | Contexto, `fatal`, utilidades (arriba) |
| `src/cli/config.js` | `resolveConfig` |
| `src/cli/project.js` | Resolución de proyecto |
| `src/cli/usage.js` | `usageText()`. **Se copia de `fuentes/src/cli/usage.js`** |
| `src/cli/init-config.js` | `writeInitConfig` |
| `src/cli/commands/{search,save,delete,timeline,context,stats,backup,init,mcp,projects}.js` | Un módulo por comando (`backup.js` contiene `export` e `import`) |

## Pruebas

`test/unit/cli/{helpers,dispatch,read,write,backup,init,projects}.test.js` (`helpers.js` no es una prueba: crea el mundo de pruebas). `cliWorld(t, { repo, env })` crea un repositorio git temporal, un directorio de datos propio y devuelve `odin(args, { input, cwd, env })`, que ejecuta `run` con E/S capturada y resuelve `{ code, out, err }`; `store()` abre el almacén para sembrar o inspeccionar. `ODIN_TIMEZONE` vale `UTC` en esos tests.

```bash
node --test "test/unit/cli/*.test.js"
```
