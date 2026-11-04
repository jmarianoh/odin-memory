# Tests E2E de __FUNCIONALIDAD__

| Convención | Ejemplo |
| --- | --- |
| Carpeta por spec | `e2e/004-autorizacion/` |
| Archivo api (contra el BFF, sin navegador) | `e2e/004-autorizacion/autorizar.api.spec.ts` |
| Archivo ui (Chromium contra la app) | `e2e/004-autorizacion/autorizar.ui.spec.ts` |
| Nombre del test | `004 › rechaza montos sobre el límite` (número de spec + escenario de `spec.md`) |
| Tags | `{ tag: ['@spec-004', '@WCAP-104'] }` (clave de la historia); regresión de MAU: agregar `@mau` y la clave de la historia del MAU |

Regla: el test va en la capa más externa que el cambio alcanza en integración. Un cambio solo de backend se prueba con el proyecto `api`; el MS no se prueba directo desde aquí. Un API o MS compartido se prueba a través del BFF de cada funcionalidad que lo usa.

Comandos (desde la raíz del repo de la célula):

```bash
sh ci/e2e.sh __FUNCIONALIDAD__ "@spec-004"                  # una spec
BFF_URL=http://localhost:3000 sh ci/e2e.sh __FUNCIONALIDAD__   # toda la funcionalidad
npx playwright test --list --project='__FUNCIONALIDAD__-*'     # ver qué tests hay
```

Los tests se escriben en la rama del repo de la célula con el mismo nombre que la del repo de capa (`feature/004-autorizacion`).
