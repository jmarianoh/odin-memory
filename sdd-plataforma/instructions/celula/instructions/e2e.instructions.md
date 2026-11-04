---
applyTo: "funcionalidades/*/e2e/**"
---

# Tests E2E con Playwright (estándar SDD)

- Dos proyectos por funcionalidad: `<funcionalidad>-api` (archivos `*.api.spec.ts`, cliente `request` contra el BFF) y `<funcionalidad>-ui` (archivos `*.ui.spec.ts`, Chromium contra la app). Ver `playwright.config.ts`. Los API y MS compartidos se prueban a través del BFF de cada funcionalidad.
- Regla: el test va en la capa más externa que el cambio alcanza. Un cambio solo de backend se prueba con `api`; el MS nunca se prueba directo.
- Estructura: `funcionalidades/<funcionalidad>/e2e/NNN-nombre/<tema>.api.spec.ts`. Un test por escenario de aceptación de la spec, nombrado `NNN › <escenario>`.
- Tags obligatorios: `{ tag: ['@spec-NNN', '@<CLAVE>'] }`; las regresiones de MAU agregan `@mau` y la clave del MAU.
- Los escenarios salen de `funcionalidades/<funcionalidad>/specs/NNN-nombre/spec.md`; los datos y códigos, del contrato en `funcionalidades/<funcionalidad>/contracts/` o, si es de un servicio compartido, en `servicios/<repo>/contracts/`.
- No importes helpers ni datos de la carpeta de otra funcionalidad.
- Comandos: `sh ci/e2e.sh <funcionalidad> "@spec-NNN"`, `sh ci/e2e.sh <funcionalidad>` (regresión), `sh ci/e2e.sh --todos "<tags>"` (cambio de un servicio compartido), `npx playwright test --list --project='<funcionalidad>-*'`.
- Ramas con el mismo nombre que la del repo de capa (`feature/NNN-nombre`).
