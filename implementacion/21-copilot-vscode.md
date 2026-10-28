# 21 — Integración con VS Code Copilot

## Qué cubre este capítulo

`odin setup vscode-copilot` deja listo el agente de Copilot de VS Code: registra odin como servidor MCP, le entrega el protocolo de memoria como instrucciones y le instala los hooks (`23-hooks-copilot.md`). Código: `src/setup/{install,paths,files,protocol,hooks-config}.js` y `src/cli/commands/setup.js`. Las rutas y los formatos se verificaron con la documentación vigente de VS Code y GitHub Copilot; los hooks de VS Code pueden cambiar, así que cada formato está aislado en una función.

## Comando

```
odin setup vscode-copilot [--workspace] [--insiders] [--no-hooks] [--remove] [--dry-run]
```

- Sin `--workspace` escribe en el perfil de usuario de VS Code; con `--workspace`, en la carpeta actual.
- `--insiders` usa el perfil `Code - Insiders`. `--no-hooks` omite los hooks. `--remove` deshace lo instalado. `--dry-run` calcula y muestra todo sin escribir.
- Salida: `Setting up odin for VS Code Copilot:` (o `Removing …`, con `(dry run, nothing is written)` si procede), una línea por pieza `  <pieza padded 12> <acción padded 9> <ruta>` con piezas `MCP server`, `Instructions`, `Hooks` y acciones `created`, `updated`, `unchanged`, `removed`, `absent`, y —si algo cambió y no es simulacro— `Reload VS Code (Developer: Reload Window) to pick up the changes.`.
- Errores: sin destino → uso y código 1; destino o argumento desconocido → `unknown setup target "x"` / `unknown setup argument "x"` seguido de una línea en blanco y el uso (código 1); un archivo de configuración ilegible → `odin setup vscode-copilot failed: cannot parse <ruta>: <causa>` (código 1) sin modificar nada.

## Rutas

Carpeta `User` del perfil: macOS `~/Library/Application Support/Code/User`; Linux `$XDG_CONFIG_HOME/Code/User` (o `~/.config/Code/User`); Windows `%APPDATA%\Code\User` (o `~\AppData\Roaming\Code\User`). Con `--insiders`, `Code - Insiders` en lugar de `Code`. `COPILOT_HOME` (o `~/.copilot`) es la carpeta de Copilot.

| Pieza | Perfil de usuario | Con `--workspace` |
|---|---|---|
| Servidor MCP | `<User>/mcp.json` | `.vscode/mcp.json` |
| Instrucciones | `<User>/prompts/odin-memory.instructions.md` | `.github/instructions/odin-memory.instructions.md` |
| Hooks | `<COPILOT_HOME>/hooks/odin-memory.json` | `.github/hooks/odin-memory.json` |

## Servidor MCP

Clave raíz `servers`. La entrada `servers["odin-memory"]` es `{ "type": "stdio", "command": <orden>, "args": [<args de la orden>…, "mcp", "--tools=agent"] }`. Se conservan los demás servidores y las demás claves (`inputs`, …). Si la entrada ya existe igual, la acción es `unchanged`.

- `<orden>`: `odin` si hay un ejecutable `odin` en el PATH (`odin.cmd`/`.exe`/`.bat` en Windows); si no, la ruta absoluta del Node en ejecución con `args = [<ruta absoluta de bin/odin.js>]`.
- `mcp.json` admite comentarios y comas finales (JSONC). Se leen con `stripJsonc` (respeta las cadenas, incluidas las comillas escapadas); si el archivo tenía comentarios, el original se guarda antes como `mcp.json.odin-backup`. Un JSON ilegible o que no sea un objeto detiene la operación.
- Escritura atómica: archivo temporal en la misma carpeta y renombrado; JSON con sangría de dos espacios y salto de línea final.

## Instrucciones

Archivo propio completo (`instructionsFile()`, ver `13-protocolo-memoria.md`) con `applyTo: '**'`, de modo que VS Code lo adjunta siempre. `--remove` lo borra.

## Hooks

Ver `23-hooks-copilot.md`. El archivo de hooks de usuario es el mismo que usa el CLI de Copilot: instalarlo desde cualquiera de los dos clientes produce el mismo contenido.

## Aviso de registros obsoletos

`odin doctor` (informe completo, sin `--project` ni `--check`) llama a `staleMcpCommands` y añade el chequeo `stale_mcp_command` por cada registro de odin (VS Code estable, Insiders y CLI de Copilot) cuya orden sea una **ruta absoluta que ya no existe**, con `safe_next_step: odin setup <slug>`. Si no se puede leer la configuración, añade `mcp_inspection_error`. Ver `18-doctor.md`.

## Criterios de aceptación

```bash
node --test test/unit/setup/setup.test.js test/unit/cli/setup.test.js
```

Manual: `HOME=$(mktemp -d) node bin/odin.js setup vscode-copilot`, después abrir el `mcp.json` generado; en VS Code, reiniciar la ventana y comprobar que el agente lista las herramientas `mem_*`.
