# celula-__CELULA__

Repo de la célula **__CELULA__**: las decisiones y las pruebas E2E de todas sus funcionalidades, y los contratos de los API y MS que comparten. El código vive en los repos de capa: cada funcionalidad tiene su app y su BFF, y los API y MS pueden ser propios o compartidos. Los repos de cada funcionalidad se declaran en su workspace; sus nombres no se deducen de la funcionalidad.

En Jira, una **épica** es un pedido FUID, FDT o MAU de una funcionalidad nueva o existente, y se divide en historias.

```
celula-__CELULA__/
├── .specify/ y .github/       Spec Kit, preset sdd-gerencia, agentes e instrucciones (sdd-plataforma)
├── ci/                        sdd-checks.sh, siguiente-spec.sh, e2e.sh
├── playwright.config.ts       un proyecto api y uno ui por funcionalidad
├── funcionalidades/
│   └── <funcionalidad>/
│       ├── jira/              Jira simulado del piloto: épicas e historias
│       ├── specs/NNN-nombre/  spec.md de la historia e impacto.md
│       ├── contracts/<repo>/  contratos de los servicios propios de la funcionalidad
│       ├── e2e/NNN-nombre/    tests Playwright (*.api.spec.ts, *.ui.spec.ts)
│       └── <funcionalidad>.code-workspace   declaración de sus repos (app, BFF, API, MS)
└── servicios/
    └── <repo>/contracts/      contratos de un API o MS compartido entre funcionalidades
```

| Regla | Detalle |
| --- | --- |
| Numeración | Única en la célula, no por funcionalidad: `sh ci/siguiente-spec.sh`. Así no chocan ramas, tags `@spec-NNN` ni carpetas, tampoco en los repos compartidos |
| Una historia, una funcionalidad | Una rama de historia toca solo `funcionalidades/<funcionalidad>/` |
| Contratos | Tag por funcionalidad (`<funcionalidad>/contracts-vX.Y.Z`) o por servicio compartido (`servicios/<repo>/contracts-vX.Y.Z`); un contrato compartido lo cambia su dueño en su propio MR |
| Flujo | Historias de FUID: `/speckit-specify` → `/speckit-clarify` → `/speckit-sdd-impacto` → `/speckit-sdd-resumen-po`. Plan, tasks y código van en los repos de capa. Historias de FDT y MAU: cambian la spec existente (regla de oro) |
| E2E | `sh ci/e2e.sh <funcionalidad> "@spec-NNN"`; regresión: `sh ci/e2e.sh <funcionalidad>`; servicio compartido: `sh ci/e2e.sh --todos "<tags>"`; nocturna: `sh ci/e2e.sh --todos` |
| Funcionalidad nueva | `sh ../sdd-plataforma/scripts/sdd-funcionalidad.sh . <funcionalidad>` |
| Servicio compartido nuevo | `sh ../sdd-plataforma/scripts/sdd-servicio.sh . <repo>` |

Antes de pedir un MR: `sh ci/sdd-checks.sh "<título del MR>"`.

Estándar: `sdd-plataforma`, en la versión registrada en `.github/sdd-plataforma.json`.
