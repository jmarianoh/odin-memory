# Instrucciones para Copilot en odin-memory

- JavaScript ESM puro con JSDoc; Node.js ≥ 24; sin TypeScript ni compilación.
- Persistencia con `node:sqlite` (FTS5 trigram). No añadas drivers nativos.
- Tests con `node:test`; ejecuta `npm test` antes de dar una tarea por terminada.
- Mantén `implementacion/` sincronizada con el código: documenta el cambio y ejecuta `npm run check:implementacion -- --update`.
- Comentarios y documentación en español; identificadores de código en inglés.
- Lee `AGENTS.md` y `implementacion/02-convenciones.md` antes de empezar.
