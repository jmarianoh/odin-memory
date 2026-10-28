# odin-memory — guía para agentes

Proyecto en JavaScript puro (ESM + JSDoc, sin paso de compilación). Runtime: Node.js ≥ 24. Base de datos: `node:sqlite` con FTS5.

## Antes de escribir código

1. Lee `implementacion/README.md` y el capítulo de la fase que tocas.
2. Respeta `implementacion/02-convenciones.md`.
3. Todo cambio de comportamiento lleva su test en `test/`.

## Reglas

- Sin TypeScript, sin transpiladores, sin bundlers. Tipos con JSDoc.
- Dependencias: solo las declaradas en `implementacion/03-entorno-dependencias.md`, con versión exacta. No añadir otras sin actualizar ese documento.
- Los tests usan `node:test` y `node:assert/strict`.
- Identidad fija: binario `odin`, datos en `~/.odin-memory/odin.db`, variables `ODIN_*`, servidor MCP `odin-memory`, puerto HTTP 7438.
- Cada cambio en `bin/` o `src/` actualiza su documento en `implementacion/` y se re-registra con `npm run check:implementacion -- --update`.
- Antes de terminar: `npm test`, `npm run check:implementacion`, `npm run check:clean-room`.
