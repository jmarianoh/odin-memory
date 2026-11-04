# Funcionalidad __FUNCIONALIDAD__ · célula __CELULA__

| Carpeta | Qué contiene | Quién lo cambia |
| --- | --- | --- |
| `jira/` | Jira simulado del piloto: épicas (FUID, FDT o MAU) y sus historias tal como las escribe el PO, con sus comentarios | PO (épica e historia) y célula (comentarios) |
| `specs/NNN-nombre/` | `spec.md` de cada historia (sin capas) e `impacto.md` (qué repos cambian). El número es único en la célula | Célula, por MR |
| `contracts/<repo>/` | Contratos de los servicios propios de la funcionalidad (app, BFF y, si no se comparten, API y MS), versionados con tags `__FUNCIONALIDAD__/contracts-vX.Y.Z`. Los contratos de un API o MS compartido están en `servicios/<repo>/contracts/` | Célula, por MR propio |
| `e2e/NNN-nombre/` | Tests Playwright de la spec: `*.api.spec.ts` contra el BFF y `*.ui.spec.ts` en el navegador | SDD Tester, en la última fase de `tasks.md` del repo de capa |
| `__FUNCIONALIDAD__.code-workspace` | Declaración de los repos de la funcionalidad: app, BFF, API y MS (propios o compartidos) y el repo de la célula | Célula |

Los nombres de los repos no se deducen del nombre de la funcionalidad. Los declara el workspace:

| Capa | Repo | Propio o compartido |
| --- | --- | --- |
| App | | propio |
| BFF | | propio |
| API | | |
| MS | | |

E2E de la funcionalidad: `sh ci/e2e.sh __FUNCIONALIDAD__` (desde la raíz del repo de la célula).

Contratos publicados:

| Tag | Contrato | Historia |
| --- | --- | --- |
