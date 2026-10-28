# 50 — Plan de construcción

Cada fase termina cuando **todos** sus comandos de aceptación finalizan con éxito. No se avanza antes.

## F0 — Andamiaje

1. Copiar `fuentes/` a la raíz del repositorio.
2. Crear `bin/odin.js` y `src/version/index.js` (ya incluidos en `fuentes/`).
3. Registrar los archivos en `manifest.json` (ya incluido).

Aceptación:
```bash
npm test
npm run check:implementacion
npm run check:clean-room
node bin/odin.js version      # imprime: odin-memory 0.1.0
```

## F1 — Store

### F1.1 — Conexión, identidad y migraciones (spec 0.2.0)

1. Copiar de `fuentes/`: `src/store/schema.js`, `test/contract/fixtures/sqlite-schema.json` y todos los tests nuevos.
2. Crear, en este orden, según `10-store/01-conexion-y-migraciones.md`: `src/timeutil/index.js`, `src/runtime/warnings.js`, `src/store/errors.js`, `data-dir.js`, `instance-id.js`, `generation.js`, `db.js`, `migrate.js`, `store.js`, `index.js`.
3. Cargar `silenceSqliteWarning()` en `bin/odin.js` antes de cualquier import del store.

Aceptación:
```bash
node --test "test/unit/store/*.test.js" test/unit/timeutil.test.js test/unit/runtime-warnings.test.js
npm test
npm run check:implementacion
npm run check:clean-room
```

### F1.2 — Observaciones y sesiones (spec 0.3.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/store/{text,sessions,observations}.test.js`, `test/unit/project-canonical.test.js`).
2. Crear, según `10-store/02-observaciones-sesiones.md`: `src/project/canonical.js`, `src/store/text.js`, ampliar `errors.js` y `store.js`, y crear `journal.js`, `sessions.js`, `observations.js`; actualizar `src/store/index.js` para exportarlos.

Aceptación:
```bash
node --test "test/unit/store/*.test.js" test/unit/project-canonical.test.js
npm test
npm run check:implementacion
npm run check:clean-room
```

### F1.3 — Búsqueda, línea de tiempo y prompts (spec 0.4.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/store/{search,prompts}.test.js`).
2. Crear, según `10-store/03-busqueda-prompts.md`: ampliar `errors.js` y `text.js`; crear `search.js` y `prompts.js`; exportarlos desde `src/store/index.js`.

Aceptación:
```bash
node --test "test/unit/store/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

### F1.4 — Relaciones y juicios (spec 0.5.0)

1. Copiar de `fuentes/` el test nuevo (`test/unit/store/relations.test.js`).
2. Crear, según `10-store/04-relaciones.md`: ampliar `errors.js`; crear `relation-udf.js` y `relations.js`; registrar la función SQL desde `openDatabase` (`db.js`); exportarlos desde `src/store/index.js`.

Aceptación:
```bash
node --test "test/unit/store/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

### F1.5 — Proyectos, captura pasiva y consolidación (spec 0.6.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/store/{projects,passive,consolidate}.test.js`).
2. Crear, según `10-store/05-proyectos-captura.md`: ampliar `errors.js`; exportar `cutBytes` en `text.js` y `getObservationRow`/`journalObservation` en `observations.js`; crear `projects.js`, `passive.js` y `consolidate.js`; exportarlos desde `src/store/index.js`.

Aceptación:
```bash
node --test "test/unit/store/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

### F1.6 — Contexto de sesión (spec 0.7.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/store/context.test.js`).
2. Crear, según `10-store/06-contexto.md`: ampliar `timeutil` (`parseStored`, `formatLocal`), `text.js` (`truncate`), `observations.js`, `prompts.js`, `db.js` (`readTransaction`) y `store.js` (reloj opcional); crear `context.js`; exportarlo desde `src/store/index.js`.

Aceptación:
```bash
node --test "test/unit/store/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

### F1.7 — Mantenimiento de proyectos (spec 0.8.0)

1. Copiar de `fuentes/` el test nuevo (`test/unit/store/project-maintenance.test.js`).
2. Crear, según `10-store/07-mantenimiento-proyectos.md`: ampliar `errors.js`; añadir `backfillProjectSyncMutations` a `journal.js`; exportar `recordDeleteTombstone` en `observations.js`; crear `project-maintenance.js`; exportarlo desde `src/store/index.js`.

Aceptación:
```bash
node --test "test/unit/store/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

### F1.8 — Sesiones de runtime (spec 0.9.0)

1. Copiar de `fuentes/` el test nuevo (`test/unit/store/runtime-sessions.test.js`).
2. Crear, según `10-store/08-sesiones-de-runtime.md`: ampliar `errors.js`; extraer `insertObservationRow` en `observations.js`; extraer `endSessionInTransaction` y exportar `foreignRecordOwner`, `sessionRow` y `journalSession` en `sessions.js`; crear `src/project/worktree.js` y `src/store/runtime-sessions.js`; exportar este último desde `src/store/index.js`.

Aceptación:
```bash
node --test "test/unit/store/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

Con F1.8 queda completo el store (capítulos `10-store/01` a `08`).

## F2 — Proyecto (spec 0.10.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/project/{helpers,detect,resolution,inspect}.test.js`; `helpers.js` no es un test).
2. Crear, según `11-proyecto.md`: `src/project/{errors,identity,detect,resolution,inspect,similar,routing-candidate,index}.js`.

Aceptación:
```bash
node --test "test/unit/project/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

## F3 — MCP

### F3.1 — Protocolo y herramientas de lectura (spec 0.11.0)

1. Copiar de `fuentes/`: `src/mcp/tool-definitions.js`, `test/contract/fixtures/mcp-tools.json` y los tests nuevos (`test/unit/mcp/*.test.js`).
2. Crear, según `12-mcp/`: en el store, `src/store/project-history.js` (exportarlo desde `index.js`), `getObservationVersionPage` en `observations.js`, `searchPreviewRelations` en `relations.js` y `compactSearchProjection` en `search.js`; y en `src/mcp/`: `json.js`, `args.js`, `errors.js`, `serialize.js`, `protocol.js`, `profiles.js`, `activity.js`, `envelope.js`, `projects.js`, `tools/projects.js`, `tools/context.js`, `tools/search.js`, `server.js`, `index.js`.
3. No instalar `@modelcontextprotocol/sdk`: el protocolo se implementa a mano (`12-mcp/README.md`).

Aceptación:
```bash
node --test "test/unit/mcp/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

### F3.2 — Herramientas de escritura (spec 0.12.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/store/provenance.test.js`, `test/unit/hostbind/hostbind.test.js`, `test/unit/mcp/{write-tools,support}.test.js`) y la versión actualizada de `test/unit/mcp/tools.test.js`.
2. Crear, según `10-store/09-procedencia.md`: `src/store/provenance.js`; ampliar `errors.js`, `observations.js`, `prompts.js`, `sessions.js`, `runtime-sessions.js`, `passive.js`; exportarlo desde `src/store/index.js`.
3. Crear, según `12-mcp/04-vinculo-anfitrion.md`: `src/hostbind/index.js`.
4. Crear, según `12-mcp/03-herramientas-escritura.md`: `src/mcp/{warnings,write-queue,session-helpers,write-projects,write-support}.js` y `src/mcp/tools/{write,sessions}.js`; añadir `goQuote` a `json.js` y sustituir con ella las citas de valores; mover `captureProjectDetector` a `projects.js` y añadir `workingDirectory`; registrar las herramientas en `server.js`.

Aceptación:
```bash
node --test "test/unit/store/provenance.test.js" "test/unit/hostbind/*.test.js" "test/unit/mcp/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

### F3.3 — Curación y ciclo de vida (spec 0.13.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/mcp/{curation-tools,run}.test.js`) y las versiones actualizadas de `protocol.test.js` y `tools.test.js`.
2. Crear, según `12-mcp/05-herramientas-curacion.md`: `observationJson` en `serialize.js`; `src/mcp/tools/curation.js`; `src/mcp/run.js`; ampliar `serve` con `signal`; registrar las herramientas en `server.js` y exportar `run.js` desde `index.js`.

Aceptación:
```bash
node --test "test/unit/mcp/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

Con F3.3 queda completo el servidor MCP salvo `mem_doctor` (F6).

## F4 — CLI y HTTP

### F4.0 — Exportación e importación del store (spec 0.14.0)

1. Copiar de `fuentes/` el test nuevo (`test/unit/store/backup.test.js`).
2. Crear, según `10-store/10-exportacion-importacion.md`: `src/store/backup.js` y `src/store/session-delete.js`; exportar `SELECT_COLUMNS` y `toObservation` desde `observations.js`, `recordPromptTombstone` y `recordLocalPromptTombstone` desde `prompts.js`; añadir el código `session_has_observations` a `errors.js`; exportar ambos módulos desde `src/store/index.js`.

Aceptación:
```bash
node --test "test/unit/store/backup.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

### F4.1 — CLI base (spec 0.15.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/cli/{helpers,dispatch,read,write,backup,init,projects}.test.js`), la versión actualizada de `test/unit/version.test.js` y `src/cli/usage.js`.
2. Crear, según `15-cli/`: `src/cli/runtime.js`, `config.js`, `project.js`, `init-config.js`, `index.js` y `src/cli/commands/{search,save,delete,timeline,context,stats,backup,init,mcp,projects}.js`; reemplazar `bin/odin.js` por el lanzador de `fuentes/bin/odin.js`.

Aceptación:
```bash
node --test "test/unit/cli/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

Pruebas manuales: `ODIN_DATA_DIR=$(mktemp -d) node bin/odin.js save "Título" "Contenido" --project demo`, luego `search Contenido --project demo`, `stats --all`, `projects` y `context --all`.

### F4.2 — API HTTP y `odin serve` (spec 0.16.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/server/{helpers,router,routes,serve,details}.test.js`) y `src/cli/usage.js`.
2. Crear, según `14-http-api/`, en este orden: `src/store/sync-state.js`; `src/server/{http,decode,router,auth,project,sync-status,unix-socket}.js`; `src/server/routes/{workflow-body,sessions,observations,prompts,context,workflows,system,table}.js`; `src/server/{server,index}.js`; `src/cli/commands/serve.js`.
3. Modificar: `src/store/index.js` (reexporta `sync-state.js`), `src/mcp/tools/curation.js` (exporta `parseConsolidate`, `judgeParams`, `judgmentItemError`), `src/cli/index.js` (registra `serve`) y `src/cli/runtime.js` (documenta `Cli.serve`).

Aceptación:
```bash
node --test "test/unit/server/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

Pruebas manuales: `ODIN_DATA_DIR=$(mktemp -d) node bin/odin.js serve 7438` y, en otra terminal, `curl localhost:7438/health`; con `ODIN_HTTP_TOKEN=secreto` las rutas `DELETE`, `/export` e `/import` piden `Authorization: Bearer secreto`.

### F4.3 — Conflictos, ejecutor semántico y herramientas de almacén (spec 0.17.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/store/{conflicts,compatibility,migrate-copy}.test.js`, `test/unit/llm/llm.test.js`, `test/unit/cli/conflicts.test.js`, `test/unit/server/conflicts.test.js`), `test/unit/cli/helpers.js` (acepta `overrides`) y `src/cli/usage.js`.
2. Crear, según `10-store/11-conflictos-compatibilidad.md` y `17-conflictos-llm.md`: `src/runtime/fs-error.js` (mover `fsErrorText` desde `src/cli/runtime.js`, que lo reexporta); `src/store/{conflicts,compatibility,migrate-copy}.js`; `src/llm/{prompt,cost,runner,factory,index}.js`; `src/cli/commands/{conflicts,admin}.js`.
3. Modificar: `src/store/store.js` (campo `closed`), `src/store/index.js` (reexporta los tres módulos nuevos), `src/cli/index.js` (`conflicts`, `instance-id`, y `migrate-copy`/`compatibility` antes de resolver la configuración), `src/cli/commands/serve.js` (opción `llm`), `src/server/server.js` (opción `llm`), `src/server/routes/{workflows,system,table}.js` (rutas nuevas).

Aceptación:
```bash
node --test "test/unit/store/*.test.js" "test/unit/llm/*.test.js" "test/unit/cli/*.test.js" "test/unit/server/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

Pruebas manuales: `node bin/odin.js save "Usar Redis para la caché" "..." --project demo` (varias parecidas), `node bin/odin.js conflicts scan --project demo --apply`, `conflicts list --project demo`, `conflicts stats --all`, `instance-id`, y `compatibility --data-dir <ruta absoluta> --json` sobre un directorio de datos.

`projects rescue-ownership` y `conflicts deferred --replay` se entregan con el diario de sincronización (F5); `hook resolve-hook-project` con los hooks de Copilot (F7).

### F5 — Sincronización por Git (spec 0.18.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/store/{sync-apply,sync-chunks,project-rescue}.test.js`, `test/unit/sync/{chunks,syncer}.test.js`, `test/unit/cli/sync.test.js`, `test/unit/server/maintenance.test.js`) y `src/cli/usage.js`.
2. Crear, según `16-git-sync.md`: `src/store/{sync-chunks,sync-apply,project-rescue}.js`; `src/sync/{chunks,transport,syncer,index}.js`; `src/cli/commands/sync.js`; `src/server/routes/maintenance.js`.
3. Modificar: `src/store/index.js` (reexporta los tres módulos), `src/store/store.js` (`Store.open` fija siempre `config.log`), `src/cli/index.js` (`sync` entre los comandos con almacén), `src/cli/commands/projects.js` (`rescue-ownership`), `src/cli/commands/conflicts.js` (`--replay`), `src/server/routes/table.js` (rutas de mantenimiento).

Aceptación:
```bash
node --test "test/unit/store/*.test.js" "test/unit/sync/*.test.js" "test/unit/cli/*.test.js" "test/unit/server/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

Pruebas manuales: en un repositorio con memorias, `node bin/odin.js sync`, `git add .odin-memory`, y en otro almacén (otro `ODIN_DATA_DIR`) `node bin/odin.js sync --import` y `sync --status`.

### F6.1 — Diagnóstico de solo lectura (spec 0.19.0)

1. Copiar de `fuentes/` los tests nuevos y modificados (`test/unit/store/{diagnostic,ownership-backfill}.test.js`, `test/unit/diagnostic/*.test.js`, `test/unit/cli/{doctor,dispatch}.test.js`, `test/unit/server/doctor.test.js`, `test/unit/mcp/tools.test.js`) y `src/cli/usage.js`.
2. Crear, según `18-doctor.md`: `src/store/diagnostic.js`; `src/diagnostic/{core,registry,evidence,checks,caller-binding,repair-codes,index}.js`; `src/cli/commands/doctor.js`; `src/server/routes/doctor.js`; `src/mcp/tools/doctor.js`.
3. Modificar: `src/store/migrate.js` (relleno de modos de propiedad), `src/store/sync-state.js` (`cloud:inbox`), `src/cli/index.js`, `src/server/routes/table.js`, `src/mcp/server.js`.

Aceptación:
```bash
node --test "test/unit/diagnostic/*.test.js" "test/unit/store/*.test.js" "test/unit/cli/*.test.js" "test/unit/server/*.test.js" "test/unit/mcp/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```

Pruebas manuales: `node bin/odin.js doctor`, `doctor --json --project demo`, `doctor --check unowned_session_project`, `doctor --help`; con `serve`, `curl localhost:7438/doctor`.

### F6.3 y F6.4 — Autopruebas y comprobación de versión (spec 0.20.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/selftest/selftest.test.js`, `test/unit/cli/selftest.test.js`, `test/unit/version-check.test.js`) y `src/cli/usage.js`.
2. Crear, según `20-selftest.md`: `src/selftest/{index,scenarios,worker}.js`, `src/cli/commands/selftest.js`, `src/version/check.js`.
3. Modificar `src/cli/index.js` (despacho de `test` antes de la configuración y comprobación de versión).

Aceptación:
```bash
node --test test/unit/selftest/*.test.js test/unit/cli/selftest.test.js test/unit/version-check.test.js
npm test
npm run check:implementacion
npm run check:clean-room
```

Pruebas manuales: `node bin/odin.js test --quick`, `test performance --json`, `test --help`; `ODIN_UPDATE_CHECK_URL=<servicio> node bin/odin.js stats`.

### F6.2 — Reparación (spec 0.21.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/store/repair.test.js`, `test/unit/diagnostic/repair.test.js`, `test/unit/cli/{doctor,doctor-repair}.test.js`).
2. Crear, según `18-doctor.md`: `src/store/repair.js`, `src/diagnostic/repair.js`, `src/cli/commands/doctor-repair.js`.
3. Modificar `src/cli/commands/doctor.js` (despacha `repair`; `discard-empty-prompt` sigue sin estar disponible).

Aceptación:
```bash
node --test test/unit/store/repair.test.js test/unit/diagnostic/repair.test.js test/unit/cli/doctor-repair.test.js test/unit/cli/doctor.test.js
npm test
npm run check:implementacion
npm run check:clean-room
```

Pruebas manuales: con una base de pruebas con una observación cuya sesión falta, `node bin/odin.js doctor repair --project demo --check orphaned_observation_session --plan`, `--dry-run` y `--apply`; después `odin doctor --check orphaned_observation_session`.

### F7 — Integración con Copilot (spec 0.22.0)

1. Copiar de `fuentes/` los tests nuevos (`test/unit/hooks/*.test.js`, `test/unit/setup/setup.test.js`, `test/unit/cli/{hook,setup}.test.js`) y `src/cli/usage.js`.
2. Crear, según `13-protocolo-memoria.md`, `21-copilot-vscode.md`, `22-copilot-cli.md` y `23-hooks-copilot.md`: `src/setup/{protocol,files,paths,hooks-config,install}.js`, `src/hooks/{input,project,handlers}.js`, `src/cli/commands/{hook,setup}.js`.
3. Modificar `src/cli/index.js` (`readInput`; `hook` y `setup` se despachan antes de resolver la configuración) y `src/cli/commands/doctor.js` (chequeo de registros obsoletos por defecto).

Aceptación:
```bash
node --test "test/unit/hooks/*.test.js" test/unit/setup/setup.test.js test/unit/cli/hook.test.js test/unit/cli/setup.test.js test/unit/cli/doctor.test.js
npm test
npm run check:implementacion
npm run check:clean-room
```

Pruebas manuales: `HOME=$(mktemp -d) node bin/odin.js setup vscode-copilot` y `setup copilot-cli`; el ciclo de hooks del capítulo 23; en VS Code y con el CLI real, comprobar que el agente lista las herramientas y que `sessionStart` inyecta el contexto.

## F8 — Integración Copilot · F8 — TUI · F9 — Cloud

Se detallan en sus capítulos al completarse cada fase. Este documento recibe, por fase, la lista ordenada de archivos a crear y los comandos de aceptación `npm test -- test/<área>`.
