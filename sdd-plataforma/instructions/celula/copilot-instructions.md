# Instrucciones de Copilot · __REPO__ (repo de la célula __CELULA__)

<!-- Generado desde sdd-plataforma/instructions/celula. Aplica solo a esta carpeta. -->

- En la gerencia se habla de **funcionalidades** (botón de pago genérico, nóminas MTN, transferencias…). En Jira, una **épica** es un pedido FUID, FDT o MAU de una funcionalidad nueva o existente, y se divide en historias. Hoy la funcionalidad va en el título de la épica (`Migración Node 24 - Nóminas MTN`).
- Este repo guarda las **decisiones de las funcionalidades y sus pruebas E2E**, una carpeta por funcionalidad en `funcionalidades/<funcionalidad>/`:
  - `jira/`: Jira simulado del piloto; `jira/<CLAVE>.md` es la épica o la historia tal como la escribió el PO, con sus comentarios.
  - `specs/NNN-nombre/`: `spec.md` por historia (sin capas ni tecnología) e `impacto.md`.
  - `contracts/<repo>/`: contratos de los servicios propios de la funcionalidad.
  - `e2e/NNN-nombre/`: tests Playwright de la spec.
  - `<funcionalidad>.code-workspace`: la declaración de sus repos (app, BFF, API y MS, propios o compartidos). Los nombres de repo no se deducen de la funcionalidad.
- Los API y MS **compartidos** entre funcionalidades tienen sus contratos en `servicios/<repo>/contracts/` (tags `servicios/<repo>/contracts-vX.Y.Z`). No tienen specs ni E2E propios.
- **Numeración única en la célula:** el número de una spec nueva sale de `sh ci/siguiente-spec.sh` (o del campo **Spec** de la historia), nunca del siguiente libre dentro de la funcionalidad. Es el mismo número en todos los repos de capa de la historia, incluidos los compartidos.
- **Una historia, una funcionalidad:** una rama de historia cambia solo `funcionalidades/<funcionalidad>/`. No toques otras funcionalidades. Un contrato compartido (`servicios/<repo>/`) lo cambia su dueño en su propio MR.
- Flujo aquí (historias de una épica FUID): `/speckit-specify` (con `SPECIFY_FEATURE_DIRECTORY=funcionalidades/<funcionalidad>/specs/NNN-nombre`) → `/speckit-clarify` → `/speckit-sdd-impacto` → `/speckit-sdd-resumen-po`. **No se corren `/speckit-plan`, `/speckit-tasks` ni `/speckit-implement`**; eso pasa en cada repo de capa. La carpeta `specs/` de la raíz no se usa. Las historias de FDT y MAU cambian la spec existente (regla de oro), sin spec nueva.
- Los contratos se cambian solo por MR propio, con tag `<funcionalidad>/contracts-vX.Y.Z` o `servicios/<repo>/contracts-vX.Y.Z` (semver; incompatible = mayor).
- Los tests E2E los escribe el SDD Tester, en la última fase de `tasks.md` del repo de capa. Se corren con `sh ci/e2e.sh <funcionalidad> "@spec-NNN"`, o `sh ci/e2e.sh --todos "<tags>"` cuando cambia un servicio compartido.
- Antes de pedir el MR: `sh ci/sdd-checks.sh "<título del MR>"`.
