---
applyTo: "**/*.test.js,**/*.spec.js,**/*.test.ts,**/*.spec.ts,test/**,tests/**"
---

# Tests en Express (sdd-dev-process)

- Los tests los escribe el agente **SDD Tester**; el SDD Implementer no los modifica.
- Servicios con tests unitarios sin HTTP; rutas con `supertest` contra `app`, sin levantar el servidor.
- Mocks solo en los bordes (clientes HTTP, base de datos), nunca del servicio que se está probando.
- El nombre de cada test que cubre un escenario de la spec empieza con el número de la spec y el escenario: `004 › responde 422 si el monto supera el límite`.
- Usa el runner del template (Jest, Vitest o `node:test`) y su comando de `package.json`.
- Los tests deben fallar por la razón correcta antes de la implementación.
