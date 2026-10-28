# 17 — Conflictos, ejecutor semántico y herramientas de almacén

## Qué cubre este capítulo

La entrega F4.3 (spec 0.17.0) añade a la CLI y a la API HTTP las herramientas que trabajan sobre las relaciones de conflicto y sobre el almacén como conjunto:

| Pieza | Dónde | Descripción detallada |
|---|---|---|
| Escaneo, estadísticas, diferidos y poda | `src/store/conflicts.js` | `10-store/11-conflictos-compatibilidad.md` |
| Compatibilidad y `migrate-copy` | `src/store/compatibility.js`, `migrate-copy.js` | ídem |
| Ejecutor semántico (`copilot -p`) | `src/llm/` | abajo |
| Comandos `conflicts`, `instance-id`, `compatibility`, `migrate-copy` | `src/cli/commands/conflicts.js`, `admin.js` | abajo |
| Rutas `/conflicts/{stats,deferred,scan}` y `/compatibility` | `src/server/routes/` | `14-http-api/01-rutas.md` |

Quedan para la sincronización (F5): `conflicts deferred --replay` y `POST /conflicts/deferred/replay` (necesitan aplicar mutaciones remotas), `projects rescue-ownership` y `POST /projects/rescue-ownership`. Mientras tanto, `--replay` sale con `odin: deferred replay is not available in this build`; el comando acepta un gancho `Cli.syncApply.replayDeferred(store) → { retried, succeeded, failed, dead }` que F5 rellena.

## Ejecutor semántico (`src/llm/`)

Delega en una herramienta externa la comparación de dos observaciones.

| Archivo | Contenido |
|---|---|
| `prompt.js` | `buildPrompt(a, b)` (plantilla **bloqueada**) y `buildStorePrompt(a, b)` (adapta `sync_id` → `id`) |
| `cost.js` | `ESTIMATED_INPUT_TOKENS_PER_PAIR = 300`, `ESTIMATED_OUTPUT_TOKENS_PER_PAIR = 50`, `estimateScanCost(pares) → { input, output }` |
| `runner.js` | `LlmError`, `VALID_RELATIONS`, `parseVerdict`, `defaultRunCli`, `CopilotRunner` |
| `factory.js` | `RUNNER_NAMES = ['copilot']`, `newRunner(nombre, opciones)`, `resolveAgentRunner(env)` |
| `index.js` | Reexporta todo |

### Plantilla del prompt

`buildPrompt` produce exactamente este texto (con `${…}` sustituido; los campos ausentes son cadena vacía). No se modifica: cambiarla cambia el significado de los veredictos guardados.

```
You are a semantic memory auditor. Compare the two observations below and classify their relationship.

=== Observation A ===
ID: ${a.id}
Title: ${a.title}
Content: ${a.content}

=== Observation B ===
ID: ${b.id}
Title: ${b.title}
Content: ${b.content}

Choose EXACTLY ONE relation from this locked vocabulary:
- conflicts_with   — the observations make contradictory claims
- supersedes       — observation A replaces or overrides observation B (or vice versa)
- scoped           — one is a narrower instance of the other
- related          — they share a topic but do not conflict
- compatible       — they are consistent and complementary
- not_conflict     — they are unrelated; no meaningful semantic overlap

Respond with a single-line JSON object and nothing else:
{"Relation":"<verb>","Confidence":<0.0–1.0>,"Reasoning":"<≤200 chars>"}
```

### `CopilotRunner`

`new CopilotRunner({ runCli = defaultRunCli, env = process.env })`; `compare(prompt, signal)`:

1. Argumentos: `['-p', prompt, '--silent']` y, si `ODIN_AGENT_MODEL` (recortada) no está vacía, `'--model', <modelo>`. Se ejecuta `copilot` (no se pasa por un intérprete de órdenes).
2. `parseVerdict(salida)` → `{ relation, confidence, reasoning, model }`; si el modelo viene vacío y se configuró `ODIN_AGENT_MODEL`, se usa ese.
3. Devuelve además `duration_ms`.

`parseVerdict(texto)`: quita secuencias de escape ANSI; si todo el texto es una valla de código (```` ```json … ``` ````) usa su interior; busca el primer objeto JSON **equilibrado** (respetando cadenas y escapes) que contenga la clave `"Relation"`. Errores `LlmError`: sin objeto → `invalid_json` (`agent CLI returned malformed JSON: inner verdict: no JSON object with a Relation field`); JSON roto → `invalid_json` (`…: inner verdict: <causa>`); `Relation` fuera de `VALID_RELATIONS` → `unknown_relation` (`agent returned a relation outside the locked vocabulary: "<valor>"`); `Confidence` que no es número → `invalid_json` (`…: inner verdict: Confidence must be a number`). El resultado toma `Reasoning` y `Model` si son cadenas (`''` si no).

`defaultRunCli(nombre, args, { signal, env })` usa `execFile` (búfer de 16 MiB): éxito → salida estándar; `ENOENT` → `LlmError('cli_not_installed')` (`agent CLI binary not found in PATH: "<nombre>"`); aborto → `LlmError('timeout')` con `agent CLI call exceeded timeout` si la señal venció por tiempo (`signal.reason.name === 'TimeoutError'`) o `agent CLI call aborted`; otro fallo → `LlmError('cli_failed')` (`CLI "<nombre>" exited <código>: <stderr>`).

`newRunner('copilot', opciones)` devuelve un `CopilotRunner`. Nombre vacío: `LlmError('invalid_runner_name')` con `invalid runner name: ODIN_AGENT_CLI is not set; supported values are: copilot`; otro nombre: `invalid runner name: "<n>" is not a recognized runner; set ODIN_AGENT_CLI to one of: copilot`. `resolveAgentRunner(env)` lee `ODIN_AGENT_CLI`; vacío → `Error("ODIN_AGENT_CLI is not set; required for --semantic scan (set to 'copilot')")`.

> **Pendiente de verificar en F7:** las opciones exactas de la CLI de Copilot (`-p`, `--silent`, `--model`) se confirman contra la documentación vigente al integrar Copilot. El ejecutor es sustituible por `Cli.llm.resolveRunner` / `HttpServer({ llm: { runnerFactory } })`.

## Comandos de la CLI

### `odin conflicts <subcomando>` (`src/cli/commands/conflicts.js`)

Sin subcomando: el uso (15 líneas, ver `usage` abajo) por el **error estándar** y código 1. Subcomando desconocido: `unknown conflicts subcommand: <x>\n` y el uso, código 1. Errores de opciones: `error: <mensaje>` por el error estándar y código 1 (no el prefijo `odin:`); errores del almacén: `odin: <mensaje>`.

```
usage: odin conflicts <subcommand> [options]
subcommands: list, show, stats, scan, deferred, prune

  list       [--project P|--all]  [--status S]  [--since RFC3339]  [--limit N]
  show       <relation_id>
  stats      [--project P|--all]
             list/stats omit known cross-project pending pairs; show retains evidence.
  scan       [--project P|--all]  [--since RFC3339]  [--limit N]  [--cursor ID]  [--dry-run]  [--apply]  [--max-insert N]
             [--semantic]  [--concurrency N]  [--timeout-per-call SECONDS]
             [--max-semantic N]  [--yes]
  deferred   [--status S]  [--limit N]  [--inspect SYNC_ID]  [--replay]
  prune      [--max-age-days N]  [--max-per-scope N]  [--dry-run]  [--apply]
             Unknown arguments are rejected; use space-separated option values.
             Potentially recoverable retry-cap relations are preserved.
```

Proyecto: `resolveCliProjectScope(cli, store, project, all, true)` (el explícito debe existir).

**`list`**: opciones sin validar (un valor ausente o `--limit` no numérico se ignora; `--limit` por defecto 50). `--since` se analiza con `parseRfc3339` (abajo) → `error: --since must be RFC3339 format: <causa>`. `--limit` > 500 → `error: --limit cannot exceed 500` (tras analizar `--since`, antes de abrir el almacén). Salida:

```
Conflicts List (project: <proyecto>)
  Total:  <n>
  Showing: <n>
  No relations found.                     <- si no hay
```
y si hay, una línea en blanco y, por relación:
```
  id:             <id>
  sync_id:        <sync_id>
  relation:       <verbo>
  judgment_status: <estado>
  source:         <source_id> — <título recortado a 60>
  target:         <target_id> — <título recortado a 60>
  created_at:     <fecha>
<línea en blanco>
```
Filtros de `listRelations`: `actionable_only`, `exclude_not_conflict`, `status`, `since_time`, `project`. La fecha de `--since` se compara **como texto** con `created_at` (`YYYY-MM-DD HH:MM:SS` frente a `YYYY-MM-DDTHH:MM:SSZ`), de modo que solo el día es significativo.

**`show <id>`**: sin argumento → `usage: odin conflicts show <relation_id>` (código 1). Id no entero → `error: relation_id must be an integer: strconv.ParseInt: parsing "<x>": invalid syntax`. Inexistente → `error: relation <id> not found`. Salida: `Conflict Detail` y los campos `relation_id`, `sync_id`, `relation`, `judgment_status`, `created_at`, `updated_at`, línea en blanco, `source_id`, `source_title`, línea en blanco, `target_id`, `target_title` (sangría de 2 espacios y etiquetas alineadas como en el código).

**`stats`**: `Conflicts Stats (project: <p>)`, línea en blanco; sin relaciones `  No relations found.`; si hay, `  By judgment_status:` con `    <estado>: n` (relleno a la derecha a 12 columnas; primero `pending`, `accepted`, `rejected`, `orphaned` si existen y después el resto en orden alfabético); si hay relaciones, línea en blanco, `  By relation type:` con `    <verbo>: n` (relleno a 20, alfabético); línea en blanco; `  Deferred:    <n>` y `  Dead:        <n>`.

**`scan`**: opciones `--project`, `--all`, `--since`, `--dry-run`, `--apply`, `--max-insert N` (100), `--limit N` (1..100, obligatorio valor), `--cursor ID` (≥ 0, obligatorio valor), `--semantic`, `--concurrency N` (5; 1..20), `--timeout-per-call SEGUNDOS` (60), `--yes`, `--max-semantic N` (100). Los números no válidos de `--max-insert`, `--concurrency`, `--timeout-per-call` y `--max-semantic` se ignoran. Errores: `error: --dry-run and --apply are mutually exclusive`; `error: --concurrency must be between 1 and 20; got N`; `error: --limit requires a value`; `error: --limit must be between 1 and 100`; `error: --cursor requires a value`; `error: --cursor must be a non-negative observation ID`.

Con `--semantic`: resuelve el ejecutor (`Cli.llm.resolveRunner(env)` o `resolveAgentRunner`; un fallo → `error: <mensaje>`), y salvo `--yes` imprime
```
Semantic scan will make up to <max_semantic> LLM calls (~<input> input tokens, ~<output> output tokens).
Subscription users: counts against your quota.
Continue? [y/N] 
```
(sin salto de línea tras el `?`), lee una línea (se toma su primer token), y si no es `y`/`Y` imprime `Aborted.` y termina con 0. Informe:

```
Conflicts Scan (project: <p>)
  inspected:        n
  ranked_queries:   n
  candidates_found: n
  already_related:  n
  inserted:         n
  dry_run:          true|false
  next_cursor:      n            <- solo si existe
  semantic_judged:  n            <- estas tres solo con --semantic
  semantic_skipped: n
  semantic_errors:  n
WARNING: max-insert cap of <N> reached — this page has no continuation; re-run with --cursor <cursor> and a higher cap.
```
La advertencia solo sale si hubo tope (`max-semantic` en lugar de `max-insert` con `--semantic`); `<cursor>` es el de entrada. Con `--all` se usa `scanAllProjects`.

**`deferred`**: `--status`, `--limit N` (50), `--inspect SYNC_ID`, `--replay` (`--inspect` y `--replay` juntos: `error: --inspect and --replay are mutually exclusive`).
* Lista: `Deferred Queue`, `  Showing: n`, `  Queue is empty.` o, tras una línea en blanco, por fila `  sync_id:      …`, `  entity_key:   …`, `  apply_status: …`, `  retry_count:  …`, `  first_seen_at: …` y una línea en blanco.
* `--inspect`: `Deferred Row` con `sync_id`, `entity`, `entity_key`, `op`, `apply_status`, `retry_count`, `payload_valid`, `payload` (como `map[clave:valor …]` con claves ordenadas, listas `[a b]`, nulo `<nil>`) o `payload_raw`, `last_error` si existe y `first_seen_at` (etiquetas rellenas a 18 columnas). No encontrado: `error: GetDeferred: deferred row "x" not found`.
* `--replay`: ver arriba.

**`prune`**: `--max-age-days N` (30), `--max-per-scope N` (1000) —ambos enteros positivos con valor obligatorio (`error: --max-age-days must be a positive integer`)—, `--dry-run`, `--apply` (excluyentes), cualquier otro argumento → `error: unknown prune argument: <x>`. Todo se valida antes de abrir el almacén. Salida: `Dead Row Prune (applied)` o `(dry run)`, `  max_age_days:  n`, `  max_per_scope: n`, `  evicted:       n` (o `  would_evict:   n`), `  Nothing to prune.` si 0; si no, `  By scope:` (`    target=<t|(none)> project=<p|(none)> by_age=n by_cap=n`), `  By reason:` (`    entity=<e|(none)> reason_code=<c|(none)> age=<cubo> count=n`) y, en seco, `Dry run: nothing was deleted. Re-run with --apply to delete these rows.` (cada bloque precedido de una línea en blanco).

### `parseRfc3339(texto)` (en `conflicts.js`)

Devuelve `{ date }` o `{ error }` con el texto de error del analizador de fechas de la referencia, porque la CLI lo muestra tal cual. Esquema `2006-01-02T15:04:05Z07:00`: año de 4 dígitos, `-`, mes y día de 2 dígitos, `T`, hora, minuto y segundo de 2 dígitos con `:`, fracción opcional (`.` o `,` seguido de dígitos) y zona `Z` o `±hh:mm`. Errores: `parsing time "<texto>" as "2006-01-02T15:04:05Z07:00": cannot parse "<resto>" as "<elemento>"` (elemento: `2006`, `-`, `01`, `-`, `02`, `T`, `15`, `:`, `04`, `:`, `05`, `Z07:00`); `parsing time "<texto>": <mes|día|hora|minuto|segundo> out of range`; `parsing time "<texto>": time zone offset <hour|minute> out of range` (hora > 24, minuto > 60); `parsing time "<texto>": extra text: "<resto>"`. El día se valida contra el mes y el año (bisiestos).

### `odin instance-id`

Imprime la identidad de la instalación (`ensureInstanceId(dataDir)`, la crea si falta) y una línea nueva.

### `odin compatibility --data-dir <ruta-absoluta> --json`

No resuelve configuración ni abre el almacén. Exige exactamente `--data-dir <ruta>` (una vez) y `--json` (una vez); cualquier otra cosa imprime `Usage: odin compatibility --data-dir <absolute-directory> --json` en el error estándar y sale con **2**. Éxito: `JSON.stringify(resultado)` + salto de línea, código 0. Metadatos inseguros: el mensaje de `probeCompatibility` por el error estándar y código 2.

### `odin migrate-copy --data-dir <origen> --output-dir <destino> --confirm-quiescent --json`

No resuelve configuración. `--help` (como único argumento) imprime `Usage: odin migrate-copy --data-dir <absolute-source> --output-dir <new-absolute-destination> --confirm-quiescent --json` y sale con 0. Se validan **todas** las opciones antes de leer el origen; errores con prefijo `odin migrate-copy: ` y código **2**: `duplicate flag <f>`, `missing value for <f>` (sin valor o el valor empieza por `--`), `<f> must be absolute`, `unknown flag <f>`, `required flag <f>` (en el orden `--data-dir`, `--output-dir`, `--confirm-quiescent`, `--json`). Un fallo de `migrateCopy` sale con código 1 y el mismo prefijo. Éxito: el resultado como JSON y salto de línea. Se despachan antes de `resolveConfig`, y los dos devuelven su propio código vía `CliExit`.

## Pruebas

`test/unit/store/{conflicts,compatibility,migrate-copy}.test.js`, `test/unit/llm/llm.test.js`, `test/unit/cli/conflicts.test.js` y `test/unit/server/conflicts.test.js` (en `fuentes/`).
