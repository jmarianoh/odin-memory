# 15.3 — `projects`

Módulo `src/cli/commands/projects.js`. Exporta `cmdProjects`, `groupSimilarProjects` y `findNormalizationEquivalentProjects`.

```
odin projects [list]
odin projects merge --from <source> --to <canonical> (--dry-run|--apply)
odin projects consolidate [--all] [--dry-run]
odin projects prune [--dry-run] [--paths-only]
odin projects alias <set|list|remove|resolve> …
```

(`projects rescue-ownership` llega con el diario de sincronización, F5; hasta entonces no está registrado y no aparece en el uso.)

Sin subcomando se usa `list`. Un subcomando desconocido imprime `unknown projects subcommand: <x>` y después el uso de `projects` en el error estándar, código 1. El uso de `projects` (`printProjectsUsage`) es, en el error estándar:

```
usage: odin projects alias set (--key <key>|--cwd <directory>) --project <project>
       odin projects alias list
       odin projects alias remove (--key <key>|--cwd <directory>)
       odin projects alias resolve [--designation <name>] [--cwd <directory>]
usage: odin projects list
       odin projects merge --from <source> --to <canonical> (--dry-run|--apply)
       odin projects consolidate [--all] [--dry-run]
       odin projects prune [--dry-run] [--paths-only]
```

## Entrada interactiva

`consolidate` y `prune` preguntan por la entrada estándar. `scanInputLine(cli)` lee **una línea** con `cli.readLine()` y toma su **primer token** (separado por espacios): `{ answer, n, error }`. Línea vacía: `n = 0`, `error = 'unexpected newline'`. EOF: `n = 0`, `error = 'EOF'`. `readAnswer` es el token recortado y en minúsculas (vacío si no hubo). Sin entrada, toda pregunta equivale a una respuesta vacía (se cancela).

## `list`

Sin proyectos: `No projects found.` Si no:

```
Projects (N):
  <nombre %-30s> <observaciones %4d> obs   <sesiones %3d> <session|sessions %-9s>  <prompts %3d> <prompt|prompts>
```

con el singular cuando la cuenta es exactamente 1. Orden: el de `listProjectsWithStats` (más observaciones primero).

## `merge`

Análisis: `--from X`, `--to X` (el valor no puede empezar por `--`), `--dry-run`, `--apply`. Cada opción solo puede aparecer una vez. Cualquier problema (opción repetida o desconocida, falta de valor, `--from`/`--to` en blanco, o `--dry-run` y `--apply` ambos o ninguno) imprime el uso de `projects` y sale con 1.

`previewExplicitProjectMerge(store, from, to)`:
- `--dry-run`: `[dry-run] Source "<origen>" -> target "<canónico>": observations N, sessions N, prompts N. Sync identity changes: <true|false>. No changes made. Point-in-time preview; apply revalidates and counts may differ.`
- `--apply`: `mergeExplicitProjectVariants(store, [from], to)` e imprime `Merged source "<origen>" into target "<canónico>": observations N, sessions N, prompts N. Sync identity may also change.` (el origen sale de la vista previa, el canónico y los recuentos del resultado).

Errores del almacén → `fatal`.

## `consolidate`

`--all` y `--dry-run` (los demás argumentos se ignoran). Los errores del almacén son `fatal`.

### Proyecto actual (sin `--all`)

1. `detectProject(store, cwd)`; si trae `error`, `fatal`. `canónico = normalizeProject(res.project)`.
2. Si el canónico no está entre `listProjectNames`: `Note: "<canónico>" has no existing memories. Merging will move memories into this new project name.`
3. `similar = findNormalizationEquivalentProjects(canónico, nombres)`: nombres existentes distintos del canónico (comparación exacta) que normalizan igual; cada uno `{ name, match_type: 'normalization-equivalent' }`. Si no hay: `No similar project names found for "<canónico>". Nothing to consolidate.` y termina.
4. Imprime `Detected project: "<canónico>"` + línea en blanco, `Found similar project names:` y cada candidato `  [i] <nombre %-30s> <obs %3d> obs  (<tipo>)`. Luego, **sin salto de línea final**: línea en blanco previa y `Select which to merge into "<canónico>" (comma-separated numbers, 'all', or 'none'): `.
5. Lee la respuesta. Si hubo error de lectura con `n = 0` y `--dry-run`: `fatal("dry-run requires a confirmed selection: <error>")`. Respuesta `none`, `n` o vacía: con `--dry-run` y vacía → `fatal("dry-run requires a confirmed selection")`; si no, `Cancelled.`.
6. `all`/`a` → todos; si no, lista separada por comas de índices: cada parte recortada pasa por `scanLeadingInt`; fuera de `1..N` o ilegible → error (no salida) `Invalid selection: "<parte>" (expected 1-N)` y, con `--dry-run`, código 1 (sin `--dry-run`, termina con 0).
7. `--dry-run`: línea en blanco y `[dry-run] Would merge N project(s) into "<canónico>"`.
8. Si no: línea en blanco, `Merging N project(s) into "<canónico>"...`, `mergeProjects(store, fuentes, canónico)`. Si no movió registros (`observations_updated + sessions_updated + prompts_updated == 0`): `Nothing merged into "<canónico>": the store moved no records for the N selected project(s).` Si movió: `Done! Merged <sources_merged.length> project(s) into "<canónico>":` y las tres líneas `  Observations: N`, `  Sessions:     N`, `  Prompts:      N`; después `reportUnmergedSources`.

`reportUnmergedSources(fuentes, resultado)`: lista las fuentes seleccionadas (sin repetir, ni en blanco, ni iguales al canónico) cuyo nombre recortado no está en `sources_merged`; si hay alguna: `  Not merged (no records moved): a, b`.

### `--all`

`groupSimilarProjects(listProjectsWithStats)`: agrupa por nombre normalizado no vacío; descarta grupos de un solo nombre; cada grupo `{ names (ordenados por bytes UTF-8), canonical }`; los grupos se ordenan por `canonical` (bytes). Sin grupos: `No similar project name groups found.` Si no: `Found N group(s) of similar project names:` + línea en blanco y por grupo:

```
Group i:
  <→ si es el canónico, "  " si no>[j] <nombre %-30s> <obs %3d> obs
  Suggested canonical: "<canónico>" (→)
```

- Con `--dry-run`: `  [dry-run] Would merge into "<canónico>"` + línea en blanco y pasa al siguiente grupo.
- Si no, imprime el menú (línea en blanco, `  Options:` y las cuatro opciones `all`, `1,3,...`, `rename`, `skip`) y, sin salto, `  Choice: `. Respuesta `skip`/`s`/`n`/vacía: `  Skipped.` + línea en blanco y siguiente grupo. `rename`/`r`: pide `  Enter canonical name: `; vacío → `  Empty input, skipping.` + línea en blanco; si no, el destino de renombrado es `normalizeProject(entrada)` y la acción pasa a `all`.
- Fuentes: con `all`/`a`/`y`/`yes`, todos los nombres del grupo distintos del canónico normalizado; si no, índices por comas (los inválidos imprimen en el error `  Invalid selection: "<x>" (expected 1-N)` y una línea en blanco, y se saltan). Sin fuentes: `  Nothing to merge.` + línea en blanco.
- `mergeProjects`; un error se imprime en el error estándar como `  Error merging: <mensaje>` y se pasa al siguiente grupo. Sin registros movidos: `  Nothing merged into "<canónico>": the store moved no records for the N selected project(s).` Si movió: `  Merged: N obs, N sessions, N prompts` y `reportUnmergedSources`.
- Si hay destino de renombrado distinto del canónico: `migrateProject(store, canónico, destino)` e imprime `  Renamed "<canónico>" → "<destino>": N obs, N sessions, N prompts` (error: `  Error renaming "<a>" → "<b>": <mensaje>` en el error estándar). Al final de cada grupo, una línea en blanco.

## `prune`

`--dry-run` y `--paths-only`. Candidatos: proyectos de `listProjectsWithStats` con 0 observaciones (con `--paths-only`, solo los que contienen `/` o `\`), ordenados por bytes del nombre. Sin candidatos: `No path-named projects to prune.` o `No empty projects to prune.`. Si no: `Found N project(s) with 0 observations:` + línea en blanco y `  [i] <nombre %-30s> <sesiones %3d> sessions  <prompts %3d> prompts`.

- `--dry-run`: línea en blanco y `[dry-run] Would prune N project(s)`.
- Si no: pregunta (sin salto) `\nSelect which to prune (comma-separated numbers, 'all', or 'none'): `. `none`/`n`/vacía: `Cancelled.`; `all`/`a`: todos; si no, índices (un inválido imprime en el error `Invalid selection: "<x>" (expected 1-N)` y termina sin podar nada).
- Poda cada uno con `pruneProject`; un error se imprime como `Error pruning "<nombre>": <mensaje>` en el error estándar y continúa. Final: línea en blanco y `Pruned N project(s): N sessions, N prompts removed.`

## `alias`

Gestión local de alias; solo afecta a capturas futuras. Todo error (de uso o del almacén) se imprime como `project alias: <mensaje>` en el error estándar con código 1.

Análisis de `args` (tras `alias`):
- Sin argumentos: `expected set, list, remove, or resolve`. `--help` solo: imprime el uso de alias (cuatro líneas, en la salida estándar) y termina con 0. Acción desconocida: `unknown command "<x>"`.
- Opciones permitidas por acción: `set` → `--key --cwd --project`; `remove` → `--key --cwd`; `resolve` → `--designation --cwd`; `list` → ninguna. Una no permitida: `unexpected argument "<x>"`; repetida: `duplicate flag <x>`; sin valor, con valor vacío o que empieza por `--`: `<x> requires a value`.
- `set` y `remove`: exactamente una de `--key`/`--cwd` (`exactly one of --key or --cwd is required`); `set` además exige `--project` (`--project is required`).

Acciones:
- `set`: `setProjectAlias(store, tipo, clave, proyecto)` → `Alias set: <tipo> <clave> -> <proyecto>`.
- `remove`: `Alias removed.` o `Alias not found.`.
- `list`: `No project aliases.` si no hay; si no una línea por alias `tipo<TAB>clave<TAB>proyecto`.
- `resolve`: el directorio es `--cwd` o el actual; la raíz de git solo se observa si no hay `--designation`. `deriveRoutingCandidate({ designation, git_root, directory })` y después `resolveProjectAlias(store, candidato.key, candidato.directory)`. `enrolled` es verdadero si no hay conflicto, el proyecto resuelto no está vacío y está inscrito. `disposition` es `inbox` (destino = clave del candidato o `unsorted` si está vacía) o `enrolled` (destino = proyecto del alias). Salida: **una línea** de JSON compacto (`toGoJson` sin sangrado) + `\n` con las claves, en orden, `candidate` (`key`, `source`, `directory`, `raw_project`), `aliases` (`project`, `key_alias`, `cwd_alias`, `conflict`), `conflict`, `enrolled`, `disposition`, `project`.
