# 18 — Diagnóstico (doctor)

## Qué cubre este capítulo

La entrega F6.1 (spec 0.19.0) añade el diagnóstico operativo de **solo lectura**: diez chequeos con códigos estables, el comando `odin doctor`, las rutas `GET /doctor` y `POST /doctor/caller-binding` y la herramienta MCP `mem_doctor`. La reparación (`doctor repair`) llega en F6.2.

| Pieza | Dónde |
|---|---|
| Lecturas de evidencia del almacén | `src/store/diagnostic.js` |
| Tipos del informe, resumen de hallazgos, informe de error | `src/diagnostic/core.js` |
| Registro ordenado de chequeos | `src/diagnostic/registry.js` |
| Autoridad de proyecto, detección de directorio, alias | `src/diagnostic/evidence.js` |
| Los diez chequeos | `src/diagnostic/checks.js` |
| Evaluación del vínculo de llamador | `src/diagnostic/caller-binding.js` |
| `Runner`, `defaultRegistry`, reexportaciones | `src/diagnostic/index.js` |
| Lista de chequeos reparables | `src/diagnostic/repair-codes.js` |
| Comando | `src/cli/commands/doctor.js` |
| Rutas | `src/server/routes/doctor.js` |
| Herramienta MCP | `src/mcp/tools/doctor.js` |

## Modelo del informe

Todo es JSON con este orden de campos.

```
Report        { status, project?, summary, checks[] }
Summary       { total, ok, warnings, blocked, errors }
CheckResult   { check_id, result, severity, reason_code, message, why, evidence, safe_next_step, requires_confirmation, findings? }
Finding       { check_id, severity, reason_code, message, why, evidence, safe_next_step, requires_confirmation }
```

- `result` ∈ `ok | warning | blocked | error`; `severity` ∈ `info | warning | error | blocking`.
- `project` solo aparece si el diagnóstico está acotado; `findings` solo si hay hallazgos.
- **Evidencia**: la que se construye como mapa lleva las claves en **orden alfabético** (`mapEvidence`); la que proviene de una fila tipada conserva el orden de sus campos (p. ej. `{project, session_id, observation_count, first_observed_at}`). La serialización es la del formato (`toGoJson`): `<`, `>` y `&` escapados.
- `status` global: `error` si algún chequeo es `error`, si no `blocked`, si no `warning`, si no `ok`. El resumen cuenta cada chequeo por su `result` (cualquier otro valor cuenta como `ok`).

### `resultFromFindings(checkId, okEvidence, findings)`

- Sin hallazgos: resultado correcto (`check_id`, `ok`, `info`, `<id>_ok`, «No issues detected.», «The evaluated store evidence matches expected operational invariants.», evidencia dada, «No action required.», sin confirmación).
- Con hallazgos: `warning`/`warning`, `reason_code`, `why` y `safe_next_step` del **primer** hallazgo, `message` = `N finding(s) detected.`, `evidence` = `{finding_count: N}`, `findings`.
- La gravedad sube con el peor hallazgo: algún `blocking` → `blocked`/`blocking` (y termina); algún `error` → `error`/`error`; si todos son `info`, el chequeo es `ok`/`info` con «No actionable issues detected.» y «No action required.», conservando los hallazgos como evidencia.

`completeResult` rellena lo que un chequeo dejó vacío (`check_id`, `ok`, `info`, `<id>_ok`, evidencia `{evaluated: true}`).

### Informe de error

`errorReport(project, err)`: un chequeo único `invalid_check` (si el código no existe) o `diagnostic_error`, `result/severity: error`, `message` = el error, `why` «Doctor could not run the requested diagnostic safely.», evidencia `{error}`, `safe_next_step` «Run `odin doctor` without --check to list registered diagnostics.». El error de código desconocido es `invalid diagnostic check: "<código>"`.

## Los diez chequeos

Registrados y ejecutados en orden alfabético de código. `scope` = `{ store, project, readSqliteLockSnapshot?, detectProject? }` (los dos últimos son ganchos de prueba).

| Código | Qué detecta | Alcance |
|---|---|---|
| `ambiguous_active_runtime_sessions` | Dos o más sesiones de ejecución activas (`activeRuntimeSessions`) en el mismo proyecto y directorio. Un hallazgo por proyecto, `warning` | Proyecto |
| `invalid_session_identity` | Sesiones con ID en blanco (con lo que cuelga de ellas y las entradas inválidas del diario): `blocking`, `reason_code = invalid_session_identity`. Mutaciones de sesión recibidas y omitidas (`sync_session_identity_invalid`): `warning`, `quarantined_pulled_session_identity`. Los bloqueantes van primero | Proyecto |
| `manual_session_name_project_mismatch` | Sesión `manual-save-<x>` cuyo `<x>` normalizado es un proyecto con sesiones locales y no coincide con su proyecto | Proyecto |
| `orphaned_observation_session` | Observaciones (borradas incluidas) cuya sesión no existe; una por referencia | Proyecto |
| `orphaned_pending_relations` | Relaciones `pending` con **ambos** extremos ausentes (una observación borrada cuenta como ausente). Un solo hallazgo con recuento, extremos únicos ausentes, vivas y una muestra de **10** | **Todos** (no pertenecen a ningún proyecto) |
| `session_project_directory_mismatch` | Sesión cuyo proyecto difiere del que se deduce de su directorio con evidencia de Git de confianza | Proyecto |
| `sqlite_lock_contention` | `PRAGMA journal_mode`, `busy_timeout` y `wal_checkpoint(PASSIVE)`; avisa si `checkpoint_busy > 0` o `busy_timeout_ms <= 0`. Si el sondeo falla: `error`, `sqlite_lock_probe_failed` | Global |
| `sync_mutation_required_fields` | Ver abajo | Proyecto |
| `sync_target_closed_space` | Filas de `sync_state` fuera del conjunto cerrado `{cloud, cloud:inbox, local, cloud:<proyecto inscrito>}`: `foreign_sync_target`, `warning` sin mutaciones pendientes y `error` con ellas | Global |
| `unowned_session_project` | Sesiones sin proyecto o con `ownership_mode` distinto de `shared` / `project_owned` | **Todos** |

La razón de los chequeos «Todos» es que sus filas no pertenecen a ningún proyecto: una consulta acotada nunca las devolvería, y quien ejecuta `odin doctor --project X` tras un fallo de propiedad debe verlas.

### Autoridad de proyecto de una sesión (`decideSessionProjectAuthority`)

Jerarquía compartida por los hallazgos y (en F6.2) el plan de reparación. Con el proyecto persistido vacío no se decide nada.

1. Evidencia de Git de confianza (`git_remote`, `git_root`) con un proyecto distinto del persistido → autoridad `trusted_directory`, destino = proyecto del directorio.
2. Origen `dir_basename`: solo **corrobora** el proyecto persistido o **veta**; nunca establece un destino.
3. Nombre manual conocido (`manual-save-<x>` con `<x>` normalizado presente como proyecto de alguna sesión local) distinto del persistido → autoridad `manual_name`.

El directorio de cada sesión se evalúa con `detectProjectFull(dir, { inspectOnly: true })` si existe, aceptando solo los orígenes `git_remote`, `git_root`, `dir_basename`; los alias (`resolveProjectAlias` con el candidato de raíz y el directorio) se incluyen como evidencia (`project_aliases`) y nunca autorizan.

### `sync_mutation_required_fields`

Lee las observaciones activas con tipo, título o contenido en blanco y las mutaciones pendientes del objetivo `cloud` (`acked_at IS NULL`).

- Observación de origen corrupta: `blocking`, `observation_source_missing_required_fields`, evidencia = la fila tipada, pista de reparación distinta si faltan `type` o `content`.
- Mutación en cuarentena: `info`, `sync_mutation_quarantined` (evidencia, no bloquea).
- Mutación sustituida: con razón, evidencia y fecha → `info`, `sync_mutation_superseded`; si falta alguno → `blocking`, `sync_mutation_superseded_evidence_incomplete`.
- El resto se valida con `validateSyncMutationPayload`; si falla → `blocking` con su `reason_code` y `message`.
- El atraso de mutaciones de proyectos **no inscritos** (`non_enrolled_pending_mutations`, `blocking`) solo se evalúa si hay al menos un proyecto inscrito: en un equipo solo local el diario guarda todo sin inscribir y eso es lo normal.
- Los bloqueantes encabezan el resumen; la evidencia correcta es `{corrupt_source_observations, pending_mutations_evaluated, terminal_mutations?}`.

### `validateSyncMutationPayload(entity, op, payload, entityKey)`

Devuelve `{entity, op, entity_key?, missing_fields?, reason_code?, message?}`. Sin `reason_code` la carga es válida.

- Vacía → `upgrade_blocked_legacy_mutation_manual` / `sync mutation payload is empty`; ilegible o no objeto → mismo código con `decode sync mutation payload: <causa>`; entidad desconocida → `unsupported sync mutation "<e>"/"<op>"`. Una carga puede venir como cadena JSON anidada.
- Faltantes → `sync_mutation_payload_missing_required_fields`, `<entidad> payload missing required fields: a, b`.
- `session`: `id` y `entity_key` no vacíos; si ambos existen deben ser iguales (`sync_session_mutation_identity_mismatch`, `session entity_key "k" does not match payload id "i"`); en `upsert`, `directory` obligatorio salvo en una sesión `project_owned`, donde basta con que, si existe, sea una cadena.
- `observation`: `sync_id` (o `entity_key`); en `upsert` además `session_id`, `type`, `title`, `content`, `scope`.
- `prompt`: `sync_id` (o `entity_key`); en `upsert` `session_id`, `content`.
- `relation`: en `upsert` `sync_id`, `source_id`, `target_id`, `relation`, `judgment_status`, `marked_by_actor`, `marked_by_kind`, `project`.

## Vínculo del llamador (`assessCallerBinding`)

`assessCallerBinding(reader, {project, runtime_session_id, effective_session_id, host_context})` → `{status, root_state, effective_state, reason_code, safe_next_step, write_success_guaranteed}`. Lee solo las identidades dadas: **nunca** elige una continuación, registra sesiones, renueva concesiones ni predice que una escritura vaya a funcionar (`write_success_guaranteed` es siempre `false`).

Orden de decisión (estados `unknown` salvo que se diga):

1. Falta proyecto o alguna identidad, o el proyecto no es un nombre válido → `unknown` / `caller_context_missing`.
2. Sin lector, o el lector falla → `caller_binding_unavailable`.
3. La sesión raíz no existe → `root_state: missing`, `session_not_registered`.
4. Si la efectiva difiere y no existe → `effective_state: missing`, `effective_session_missing`.
5. El proyecto canónico de la raíz o de la efectiva no coincide con el pedido → `blocked` / `session_project_conflict`.
6. Si la efectiva difiere, debe ser exactamente `<raíz>:resume:<N>` con `N` entero decimal canónico (sin signo ni ceros a la izquierda; puede ser mayor que 64 bits) y `N ≥ 2`; si no → `blocked` / `effective_mapping_invalid`.
7. Faltan `host_context` o alguno de sus dos booleanos → `host_context_missing`.
8. Efectiva activa → `ok` / `binding_observed`. Efectiva terminada: sin `append_entry_available` **o** sin `branch_available` → `blocked` / `ended_session_without_persistence`; con ambos → `warning` / `resume_required`.

Estados: `active` si `ended_at` es nulo, `ended` si no. Pasos siguientes (texto exacto) en `caller-binding.js`.

## Comando `odin doctor`

```
odin doctor [--json] [--project PROJECT] [--check CODE]
```

- `--project` se resuelve como en el resto de comandos pero **no** exige que exista (se puede inspeccionar un proyecto con sincronización pendiente sin observaciones); se normaliza.
- `--check` ejecuta uno solo. Un código desconocido: con `--json` imprime el informe de error y sale con 1; sin `--json`, `odin doctor failed: invalid diagnostic check: "x"` por el error estándar y sale con 1. Cualquier otro fallo del diagnóstico: mismo informe/mensaje, **sin** salir con 1.
- Argumentos: `--project` o `--check` sin valor → `error: --project requires a value` (código 1); argumento desconocido → `error: unknown doctor argument "x"` más el uso, código 1; `--help`/`-h`/`help` imprime el uso.
- Sin `--project` ni `--check`, el informe completo añade el chequeo `stale_mcp_command` si el gancho `Cli.staleMcpCommands()` devuelve registros con un ejecutable inexistente (lo aporta la integración con Copilot, F7), o `mcp_inspection_error` si el gancho falla. Cada uno suma 1 al total y al contador `warnings`/`errors` y sube el estado (`warning` solo si era `ok`; `error` siempre).
- Texto: `Odin Doctor: <estado>`, `Project: <p>` si lo hay, `Checks: N ok=… warnings=… blocked=… errors=…`, línea en blanco y, por chequeo, `[<result>] <check_id> — <message>`, `  why: …`, `  next: …` y, por hallazgo, `  - <reason_code>: <message>`, `    next: …`, `    evidence: <JSON compacto>`.
- `--json`: el informe con sangría de dos espacios y un salto de línea final.
- `doctor repair` y `doctor discard-empty-prompt` se despachan a `Cli.doctorRepair.repair` / `.discard-empty-prompt` (F6.2); sin ellos: `odin: doctor repair is not available in this build`.

El uso (`--help`) lista `checks:` (los diez, ordenados) y `diagnostic-only checks with no repair:` (los no reparables: `ambiguous_active_runtime_sessions`, `sqlite_lock_contention`, `unowned_session_project`).

## Rutas y herramienta MCP

- `GET /doctor` y `POST /doctor/caller-binding`: ver `14-http-api/01-rutas.md`. Ninguna exige autenticación.
- `mem_doctor` (perfil `agent`, diferida, solo lectura): argumentos `project` (se resuelve como una lectura sin crear el vínculo del repositorio; debe existir) y `check`. Devuelve el informe como texto JSON compacto con claves ordenadas; si su `status` es `error`, el resultado lleva `isError`. Con ella `tools/list` devuelve 23 herramientas con `--tools=agent` y 27 con `all`.

## Cambios de almacén que acompañan a esta entrega

- La clave reservada de la bandeja de entrada es `cloud:inbox` también en `sync-state.js` (antes se había escrito `cloud-inbox`).
- Migración `backfillLegacySessionOwnershipModes` (ver `10-store/01-conexion-y-migraciones.md`).

## Criterios de aceptación

```bash
node --test "test/unit/diagnostic/*.test.js" test/unit/store/diagnostic.test.js test/unit/store/ownership-backfill.test.js test/unit/cli/doctor.test.js test/unit/server/doctor.test.js test/unit/mcp/tools.test.js
npm test
```
