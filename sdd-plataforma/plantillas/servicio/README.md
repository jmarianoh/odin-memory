# Servicio compartido __SERVICIO__ · célula __CELULA__

API o MS que usan varias funcionalidades de la célula. No tiene specs ni E2E propios: cada historia que lo toca tiene su spec en la funcionalidad que la pidió (`funcionalidades/<funcionalidad>/specs/NNN-*`), y se prueba a través del BFF de esa funcionalidad.

| Carpeta | Qué contiene | Quién lo cambia |
| --- | --- | --- |
| `contracts/` | Contratos del servicio, versionados con tags `servicios/__SERVICIO__/contracts-vX.Y.Z` | El dueño del contrato, en su propio MR |

Reglas:

- Un cambio de contrato afecta a todas las funcionalidades que usan el servicio. Antes del MR se revisa en qué workspaces aparece: `grep -l "__SERVICIO__" funcionalidades/*/*.code-workspace`.
- Un cambio incompatible es versión mayor: v1 y v2 conviven hasta que ninguna funcionalidad use v1.
- El repo se instala como compartido: `sh sdd-plataforma/scripts/sdd-instalar.sh ../__SERVICIO__ capa __CELULA__`.

Funcionalidades que lo usan:

| Funcionalidad | Versión del contrato |
| --- | --- |

Contratos publicados:

| Tag | Contrato | Historia |
| --- | --- | --- |
