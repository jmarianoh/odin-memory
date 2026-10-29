# 23 — Hooks de Copilot

## Qué cubre este capítulo

Los hooks hacen automático lo que el agente no debe olvidar: abrir y cerrar la sesión de memoria, inyectar el contexto previo, guardar cada prompt, recuperar el contexto tras una compactación y capturar lo que aprenden los subagentes. Cada hook ejecuta `odin hook <acción>`. Código: `src/hooks/{input,project,handlers}.js`, `src/cli/commands/hook.js` y `src/setup/hooks-config.js`.

## Reglas del anfitrión que se respetan

Verificadas con la referencia de hooks de GitHub Copilot:

- Archivos de configuración: `~/.copilot/hooks/*.json` (o `$COPILOT_HOME/hooks/`) y `.github/hooks/*.json` del repositorio. Forma: `{ "version": 1, "hooks": { "<evento>": [ { "type": "command", "bash"|"powershell"|"command": …, "timeoutSec": N } ] } }`. Plazo por defecto 30 s.
- La carga llega **por la entrada estándar** como JSON. Formato camelCase (`sessionId`, `timestamp`, `cwd`, `source`, `prompt`, `reason`, `trigger`, `response`…) y, en el formato de VS Code, snake_case con `hook_event_name` (`session_id`, `cwd`, …). `parseHookInput` acepta ambos.
- Salida: un único objeto JSON. Solo **`sessionStart`**, **`postToolUse`**, `subagentStart` y `notification` pueden aportar `additionalContext`. Para `userPromptSubmitted`, `preCompact` y `sessionEnd` la salida **se descarta**. Código de salida distinto de 0 que no sea 2: se registra y el agente continúa (fail-open); un plazo agotado también continúa.
- En el formato de VS Code la salida con contexto va anidada: `{ "hookSpecificOutput": { "hookEventName": "<Evento>", "additionalContext": "…" } }`; en camelCase es `{ "additionalContext": "…" }` (`contextOutput`).

## Eventos instalados (`HOOK_EVENTS`)

| Evento | Acción | Plazo (s) |
|---|---|---|
| `sessionStart` | `copilot-session-start` | 15 |
| `userPromptSubmitted` | `copilot-user-prompt-submit` | 5 |
| `preCompact` | `copilot-pre-compact` | 5 |
| `postToolUse` | `copilot-post-tool-use` | 5 |
| `subagentStop` | `copilot-subagent-stop` | 10 |
| `sessionEnd` | `copilot-session-end` | 5 |

Cada entrada lleva `type: "command"`, `bash`, `powershell`, `command` (igual que `bash`) y `timeoutSec`. Las órdenes son `odin hook <acción>` si `odin` está en el PATH; si no, `<node> <bin/odin.js> hook <acción>` con rutas absolutas. En `bash` cada palabra se cita con comillas simples solo si lo necesita (`'` se escribe `'\''`); en `powershell` una orden absoluta se escribe `& "ruta" "palabra" …`.

## `odin hook <acción>`

- Acciones válidas: las seis de arriba y `resolve-hook-project`. Otro nombre o argumentos de más: `usage: odin hook copilot-session-start|copilot-user-prompt-submit|copilot-pre-compact|copilot-post-tool-use|copilot-subagent-stop|copilot-session-end|resolve-hook-project` por el error estándar y código 1.
- Se despacha **antes** de resolver la configuración y de comprobar versión. **Nunca falla**: una carga ilegible, un directorio de datos inválido o cualquier error interno terminan con código 0 y sin salida. Escribe en la salida estándar a lo sumo una línea JSON (con los escapes HTML habituales).
- Lee la entrada con `Cli.readInput()` (descriptor 0; vacía si no se puede leer).

## Acciones

### `copilot-session-start`
1. Proyecto del directorio (`cwd`) con la misma detección que `GET /project/current` (`captureDetector(store, false)`, que fija el vínculo del repositorio). Sin proyecto (ambiguo, sin `cwd`…) no se registra nada.
2. Registra la sesión `sessionId` con `registerSessionWithProvenance`: modo `project_owned`, `resume: true`, directorio normalizado con `runtimeWorktreeDirectory`. Una sesión raíz ya terminada y compartida se reanuda como compartida; la reanudación crea la continuación `<id>:resume:N`.
3. Si existe `<cwd>/.odin-memory/manifest.json` y `ODIN_HOOK_AUTO_IMPORT` no es `0`, importa los chunks de Git (`await Syncer.local(...).import()`; desde F9.1 `Syncer` es asíncrono, así que `sessionStart` y `cmdHook` son `async`); cualquier fallo se ignora. Ojo: si ya existen sesiones propias del proyecto, un manifiesto de versión 1 se rechaza (ver `16-git-sync.md`).
4. Contexto: `formatContext(proyecto, '', { compact: true, pinned: 20, max_bytes: 16384, observations: 0, prompts: 0, sessions: 0, older_history: false })`.
5. Salida: `additionalContext` = `## Odin persistent memory — session context\n\nThe Odin memory tools are available. Follow the Odin memory protocol from your instructions.` y, si hay contexto, `\n\n<contexto>`. El protocolo completo no se repite: va en las instrucciones.

### `copilot-user-prompt-submit`
Guarda el prompt (`addPrompt`) con el proyecto del directorio resuelto **sin escribir el vínculo** (`captureDetector(store, true)`) y la procedencia `{ source: <origen del proyecto>, directory: cwd }`. Si la sesión no existe la registra primero. Sin prompt (solo espacios), sin sesión o sin proyecto no hace nada. El contenido se guarda como lo prepara el almacén (recortado, con `<private>` redactado). No produce salida (el anfitrión la descarta).

### `copilot-pre-compact` y `copilot-post-tool-use`
El anfitrión no procesa la salida de `preCompact`, así que `preCompact` solo deja una **marca** `<datos>/hook-state/compact-<sha256 de la sesión (32 hex)>.json` (directorio `0700`, archivo `0600`, contenido `{session_id, cwd, trigger, at}`) sin abrir el almacén. El siguiente `postToolUse` de esa sesión, si la marca tiene menos de 24 h, la borra y entrega **una sola vez** `additionalContext` con:

```
CRITICAL INSTRUCTION POST-COMPACTION — follow these steps IN ORDER:

FIRST ACTION REQUIRED:
1. IMMEDIATELY call mem_session_summary with the compacted summary content — this persists what was done before compaction.
2. Then call mem_context to recover any additional context from previous sessions.
3. Only THEN continue working.

Do not skip step 1. Without it, everything done before compaction is lost from memory.
```

seguido de `formatCompactionContext(sesión)` (o, si la sesión no existe, el contexto del proyecto). Sin marca, `postToolUse` termina sin abrir el almacén, para que no cueste nada en cada herramienta.

### `copilot-subagent-stop`
Pasa `response` (o `last_assistant_message`) por `passiveCapture` con `source: "subagent-stop"` y el proyecto del directorio (sin escribir el vínculo). Sin respuesta, sesión o proyecto no hace nada.

### `copilot-session-end`
Si la sesión existe y ya estaba terminada con proyecto y directorio, cierra su continuación viva con `endRuntimeSession`; si no, `endSession(id, '')`. Sesión desconocida: nada.

### `resolve-hook-project`
Entrada: un único objeto JSON con **exactamente un** campo `cwd` en minúsculas, de tipo cadena, a nivel raíz y sin nada después (una clave repetida —también si una se escribe con escapes—, un `cwd` anidado, otro tipo, mayúsculas o texto sobrante dejan la respuesta vacía). Si el `cwd` es absoluto se inspecciona con `inspectLocalProject` (no escribe nada; solo orígenes verificables: configuración, remoto/raíz con vínculo ya existente, hijo con vínculo, nombre del directorio validado). Salida: `{"project":…,"project_path":…,"project_source":…}` con las claves en **orden alfabético**, o `{}`. No abre el almacén.

## Criterios de aceptación

```bash
node --test test/unit/hooks/*.test.js test/unit/cli/hook.test.js
```

Manual:

```bash
T=$(mktemp -d); git init -q $T/repo; export ODIN_DATA_DIR=$T/data
echo '{"sessionId":"s1","cwd":"'$T'/repo"}' | node bin/odin.js hook copilot-session-start
echo '{"sessionId":"s1","cwd":"'$T'/repo","prompt":"hola"}' | node bin/odin.js hook copilot-user-prompt-submit
node bin/odin.js stats
```
