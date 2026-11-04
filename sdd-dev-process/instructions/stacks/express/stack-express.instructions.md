---
applyTo: "src/**/*.js,src/**/*.mjs,src/**/*.cjs,src/**/*.ts"
---

# Express (sdd-dev-process)

- Usa la skill `node-express`. Sigue el sistema de módulos (ESM o CommonJS) y el lenguaje (JavaScript o TypeScript) que ya usa el template.
- Capas: `routes` → `controllers` → `services` → `clients` o repositorios. Un controller no habla con la base de datos ni con otros servicios.
- `app` separado de `server`, para testear con supertest sin abrir puertos.
- Validación de `params`, `query` y `body` con esquema en un middleware; límite explícito en `express.json`.
- Un solo manejador de errores de cuatro argumentos, después de las rutas, más un 404 propio. En Express 5 no hace falta `try/catch` en handlers `async`; en callbacks y timers sí.
- `helmet()`, `app.disable('x-powered-by')`, CORS con lista de orígenes por ambiente.
- Cada endpoint cumple exactamente el contrato del `plan.md`.
- Nada de `console.log` en código productivo: usa el logger del template.
