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

## F1 — Store · F2 — Proyecto · F3 — MCP · F4 — CLI y HTTP · F5 — Git Sync · F6 — Doctor, self-tests, LLM · F7 — Integración Copilot · F8 — TUI · F9 — Cloud

Se detallan en sus capítulos al completarse cada fase. Este documento recibe, por fase, la lista ordenada de archivos a crear y los comandos de aceptación `npm test -- test/<área>`.
