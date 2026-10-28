# 22 — Integración con el CLI de Copilot

## Qué cubre este capítulo

`odin setup copilot-cli` registra odin en el CLI de GitHub Copilot (`copilot`): servidor MCP, protocolo de memoria como instrucciones de usuario y hooks. Comparte código con `21-copilot-vscode.md` (`src/setup/install.js`).

## Comando

```
odin setup copilot-cli [--no-hooks] [--remove] [--dry-run]
```

`--workspace` y `--insiders` solo valen para VS Code: con ellos sale `--workspace and --insiders only apply to vscode-copilot` (código 1). La salida y los errores son los del capítulo 21 (`Setting up odin for the Copilot CLI:` y, al final, `Restart the Copilot CLI to pick up the changes.`).

## Rutas (`COPILOT_HOME` o `~/.copilot`)

| Pieza | Archivo |
|---|---|
| Servidor MCP | `mcp-config.json` |
| Instrucciones | `copilot-instructions.md` |
| Hooks | `hooks/odin-memory.json` |

## Servidor MCP

Clave raíz `mcpServers`; la entrada `mcpServers["odin-memory"]` es `{ "type": "local", "command": <orden>, "args": [<args de la orden>…, "mcp", "--tools=agent"], "env": {}, "tools": ["*"] }`. `local` y `stdio` son equivalentes para el CLI; se usa `local`, el valor que escribe el propio CLI. `tools: ["*"]` habilita todas las herramientas. Se conservan los demás servidores y las demás claves. Equivale a `copilot mcp add odin-memory -- <orden> mcp --tools=agent`.

## Instrucciones

Es un archivo personal y compartido con otras instrucciones del usuario, así que el protocolo se inserta como **bloque gestionado** entre `<!-- BEGIN ODIN MEMORY PROTOCOL -->` y `<!-- END ODIN MEMORY PROTOCOL -->` (`upsertProtocolBlock`): se añade al final con una línea en blanco de separación, se sustituye si ya estaba y no se toca nada más. `--remove` quita solo el bloque y borra el archivo si no quedaba otra cosa.

## Ejecutor semántico

`ODIN_AGENT_CLI=copilot` (ver `17-conflictos-llm.md`) invoca `copilot -p <prompt> --silent` y `--model <modelo>` con `ODIN_AGENT_MODEL`. Los indicadores se verificaron con la referencia vigente del CLI: `-p/--prompt` ejecuta un solo comando sin sesión interactiva, `-s/--silent` suprime estadísticas y decoración para dejar solo la respuesta, `--model` fija el modelo.

## Criterios de aceptación

```bash
node --test test/unit/setup/setup.test.js test/unit/cli/setup.test.js
```

Manual: `HOME=$(mktemp -d) node bin/odin.js setup copilot-cli`; con el CLI real, `copilot` y comprobar con `/mcp` que `odin-memory` aparece y expone las herramientas.
