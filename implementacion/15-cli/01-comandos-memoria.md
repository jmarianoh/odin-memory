# 15.1 — Comandos de memoria: search, save, delete, timeline, context, stats

Todos reciben `(cli, config)`; `args = cli.args.slice(1)` son los argumentos tras el nombre del comando. "Salida" es la salida estándar; "error" el error estándar. `usage:` y `error:` literales salen por el error estándar con código 1.

## `search`

Módulo `src/cli/commands/search.js`.

```
odin search <query> [--type TYPE] [--project PROJECT|--all] [--scope SCOPE] [--limit N] [--match all|any]
```

- Sin ningún argumento: error `usage: odin search <query> [--type TYPE] [--project PROJECT|--all] [--scope SCOPE] [--limit N] [--match all|any]`, código 1.
- Todo lo que no es una opción conocida forma la consulta, unida con un espacio. Las opciones con valor toman el argumento siguiente; **si falta, se ignora la opción** sin error. `--limit` con un valor que no es un entero (`parseInt64`) conserva el valor por defecto 10 pero consume igualmente el argumento.
- Consulta vacía: error `error: search query is required`, código 1.
- Abre el almacén. Resuelve el proyecto con `resolveCliProjectScope(cli, store, --project, --all, true)` y busca con `searchObservations(store, consulta, { type, project, scope, limit, match_mode })` (`limit` 10 por defecto). Cualquier error es `fatal`.
- Sin resultados: salida `No memories found for: <consulta entre comillas>` (comillas al estilo `goQuote`).
- Con resultados: `Found N memories:` + línea en blanco, y por cada resultado (índice desde 1):

```
[1] #<id> (<tipo>) — <título>
    <contenido recortado a 300 caracteres>
    <fecha local>[ | project: <proyecto>] | scope: <ámbito>
<línea en blanco>
```

La fecha es `formatLocal(created_at, env)` (`ODIN_TIMEZONE`); el fragmento ` | project: …` solo aparece si el proyecto no es nulo.

## `save`

Módulo `src/cli/commands/save.js`. Exporta `parseSaveArgs` y `SAVE_USAGE`.

```
odin save <title> <content> [--type TYPE] [--project PROJECT] [--scope SCOPE] [--topic TOPIC_KEY]
```

`SAVE_USAGE` es:

```
usage: odin save <title> <content> [--type TYPE] [--project PROJECT] [--scope SCOPE] [--topic TOPIC_KEY]
Untracked folders inside a HOME Git repository require --project, ODIN_PROJECT, or .odin-memory/config.json project_name.
```

`parseSaveArgs(args)` devuelve `{ title, content, type, projectName, scope, topicKey }` con `type = 'manual'` y `scope = 'project'` por defecto. Las opciones pueden ir antes, entre o después de los dos posicionales; `--` termina las opciones (lo que sigue son posicionales aunque empiece por `-`). Errores (lanza `Error`):

- argumento que empieza por `-` y no es una de `--type --project --scope --topic` (antes de `--`): `unknown save flag: <arg>`;
- una de esas opciones sin valor, con valor en blanco o con valor que empieza por `-`: `<opción> requires a value`;
- más de dos posicionales: `save requires exactly two positional arguments` (se detecta al leer el tercero); menos de dos, el mismo mensaje.

Flujo de `cmdSave`:

1. Si `parseSaveArgs` falla: imprime `SAVE_USAGE` + salto en el error estándar y después `fatal` con el mensaje (dos escrituras: primero el uso, luego `odin: <mensaje>`).
2. `validateObservationTitle(título)`; si falla, `fatal` (antes de abrir el almacén).
3. **Verificación previa** sin abrir SQLite ni crear vínculo de git: `resolve({ mode: 'current', explicit: --project, directory: cwd, env, detect: detectProjectFull(dir, { inspectOnly: true, requireExplicitHomeProject: true }) })`. Si lanza, `fatal("cannot save without an unambiguous project identity: <causa>; use --project <name>")`.
4. Abre el almacén y resuelve de nuevo con el detector `detectProject(store, dir, { requireExplicitHomeProject: true })` (con historial). Mismo mensaje de error ante fallo; si `resolved.project` queda en blanco, el mismo mensaje sin causa (`cannot save without an unambiguous project identity; use --project <name>`).
5. Nombre bruto: `--project`, o si falta el proyecto fijado de `ODIN_PROJECT` (`processOverride('', env)`), o si no `resolved.project`. Se normaliza con `normalizeProject`; un aviso de normalización se escribe en el error estándar (línea completa). Si queda en blanco, el mismo error de identidad.
6. Procedencia: `{ source: resolved.source, directory: cwd }` más `raw_project` = el `--project` literal si no está en blanco, o si no el valor de `ODIN_PROJECT` si existe.
7. `sessionId = resolveManualSession(store, proyecto, cwd, procedencia)`; calcula `contentTruncation(store, contenido)`; `addObservation(store, { project_provenance, session_id, type, title, content, project, scope, topic_key })`.
8. Salida `Memory saved: #<id> <título entre comillas> (<tipo>)`. Si el contenido se truncó: error `⚠ WARNING: Content was truncated from <original> to <límite> bytes. Consider splitting into smaller observations.`.

Cualquier error del almacén es `fatal`.

## `delete`

Módulo `src/cli/commands/delete.js`.

```
odin delete <observation_id> [--hard]
odin delete session  <id>
odin delete prompt   <id>
odin delete project  <name> [--hard]
```

- Sin argumentos: error con las cuatro líneas de uso (`usage: odin delete <observation_id> [--hard]` y las otras tres con sangrado de 7 espacios: `       odin delete session  <id>`, `       odin delete prompt   <id>`, `       odin delete project  <name> [--hard]`), código 1.
- `args[0]` = `session`, `prompt` o `project` elige el subcomando; **cualquier otra cosa** es el identificador de una observación.
- `parseTrailing(args, uso, ...soportados)`: tras el destino solo se admiten las opciones documentadas; cualquier otro argumento se rechaza **antes de abrir el almacén** con `error: unexpected argument(s): <cada uno entre comillas, separados por espacio>` + `usage: <uso>` y código 1 (ignorar `--dry-run` borraría de todos modos).
- Los destinos `--help` y `-h` de session/project se rechazan con `usage: <uso>` y código 1.
- Identificador no entero (`parseInt64`): `error: invalid observation id "<x>"` / `error: invalid prompt id "<x>"`, código 1.

| Subcomando | Uso (para `parseTrailing`) | Acción | Salida |
|---|---|---|---|
| (observación) | `odin delete <observation_id> [--hard]` | `deleteObservation(store, id, { hardDelete })` | `Observation #<id> soft-deleted` o `hard-deleted` |
| `session` | `odin delete session <id>` | `deleteSession(store, id)` | `Session "<id>" deleted` |
| `prompt` | `odin delete prompt <id>` | `deletePrompt(store, id)` | `Prompt #<id> deleted` |
| `project` | `odin delete project <name> [--hard]` | `deleteProject(store, nombre, hard)` | `Project "<proyecto>" soft-deleted\|hard-deleted: N observation(s), N prompt(s), N session(s)` |

Sin argumento suficiente para session/prompt/project: `usage: odin delete session <id>` (resp. `prompt <id>`, `project <name> [--hard]`), código 1.

## `timeline`

Módulo `src/cli/commands/timeline.js`.

```
odin timeline <observation_id> [--before N] [--after N] [--project PROJECT|--all]
```

- Sin argumento: `usage: odin timeline <observation_id> [--before N] [--after N] [--project PROJECT|--all]`; id no entero: `error: invalid observation id "<x>"`; ambos con código 1.
- `--before`/`--after` (por defecto 5): valor no entero se ignora (se consume el argumento); `--project` usa `requiredProjectValue` (error `--project requires a non-empty value`); `--all`.
- Resuelve el proyecto con `resolveCliProjectScope(..., true)`. Si el proyecto resuelto no está vacío, lee la observación (`getObservation`): si no existe, el error es `sql: no rows in result set`; si no tiene proyecto o su proyecto en minúsculas difiere del resuelto, `observation not found in resolved project`.
- `timeline(store, id, before, after)`; si no existe: `timeline: observation #<id> not found: sql: no rows in result set` (texto fijo heredado del formato de errores de la base; se conserva por compatibilidad).
- Salida:

```
Session: <proyecto> (<started_at tal cual>)[ — <resumen recortado a 100>]      ← solo si hay sesión
Total observations in session: <total>
<línea en blanco>
─── Before ───                                                              ← solo si hay anteriores
  #<id> [<tipo>] <título> — <contenido recortado a 150>
<línea en blanco>
>>> #<id> [<tipo>] <título> <<<
    <contenido recortado a 500>
    <fecha local>
<línea en blanco>
─── After ───                                                               ← solo si hay posteriores
  #<id> [<tipo>] <título> — <contenido recortado a 150>
```

El resumen se imprime si `summary != null` (una cadena vacía imprime ` — `).

## `context`

Módulo `src/cli/commands/context.js`.

```
odin context [project] [--project PROJECT|--all] [--scope SCOPE] [--older-history]
```

Análisis (todos los fallos son `fatal`, código 1):

- `--older-history` activa el historial anterior.
- `--project`: sin valor o con valor en blanco → `context project selector requires a value`; repetido → `context project selector may only be specified once`.
- `--all` repetido → `context all-project selector may only be specified once`.
- `--scope` toma el siguiente argumento si existe.
- Cualquier otro argumento que empiece por `-` → `unknown context flag: <arg>`; el primer otro es el proyecto posicional; un segundo → `context project selector may only be specified once`.
- `--project` y posicional a la vez → `context project selector cannot combine legacy positional project with --project`.
- `--all` con cualquier selector → `context all-project selector cannot be combined with a project selector`.
- El posicional pasa a ser el proyecto.

Luego `resolveCliProjectScope(..., true)` y `formatContext(store, proyecto, ámbito, olderHistory ? { older_history: true } : {})`. Texto vacío → salida `No previous session memories found.`; si no, el texto tal cual (sin salto añadido).

## `stats`

Módulo `src/cli/commands/stats.js`.

```
odin stats [--project PROJECT|--all]
```

`--project` (con `requiredProjectValue`) y `--all`; los demás argumentos se ignoran. Con proyecto resuelto no vacío usa `statsProject`, si no `stats` global. Salida:

```
Odin Memory Stats
  Sessions:     <n>
  Observations: <n>
  Prompts:      <n>
  Projects:     <nombres separados por ", " o "none yet">
  Database:     <dataDir>/odin.db
```

(La ruta es `dataDir` + `/odin.db` con barra literal, no la ruta normalizada del sistema.)
