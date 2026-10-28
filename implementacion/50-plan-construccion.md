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

### F1.2 y F1.3

Se detallan en `10-store/02-…` y `10-store/03-…` al completarse.

## F2 — Proyecto · F3 — MCP · F4 — CLI y HTTP · F5 — Git Sync · F6 — Doctor, self-tests, LLM · F7 — Integración Copilot · F8 — TUI · F9 — Cloud

Se detallan en sus capítulos al completarse cada fase. Este documento recibe, por fase, la lista ordenada de archivos a crear y los comandos de aceptación `npm test -- test/<área>`.
