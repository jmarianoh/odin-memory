
## Reglas de la gerencia para specify (preset sdd-gerencia)

Estas reglas complementan el proceso anterior y prevalecen si hay conflicto.

1. **Entrada desde Jira.** Si el usuario nombra una clave de Jira (p. ej. `WCAP-104`), es la de una **historia**: toda épica (FUID, FDT o MAU) se divide en historias. Si nombra una épica, pide la historia.
   - Si hay un servidor MCP de Jira disponible, lee la historia y su épica desde ahí.
   - Si no, busca el archivo `funcionalidades/<funcionalidad>/jira/<CLAVE>.md` en el repo de la célula (`celula-<célula>`; desde un repo de capa, `../celula-<célula>/funcionalidades/*/jira/<CLAVE>.md`, con la célula de `.github/sdd-plataforma.json`), o usa el texto pegado en el prompt.
   - El tipo de pedido es el de la épica (campo **Padre** de la historia). La funcionalidad es la carpeta donde está la historia; en Jira hoy va en el título de la épica (p. ej. `Migración Node 24 - Nóminas MTN`).
   - Los criterios de aceptación Dado / Cuando / Entonces de la historia pasan **tal cual** a "Escenarios de aceptación". No inventes criterios que el PO no escribió; lo que falte va como `[NEEDS CLARIFICATION]`.
   - Llena `Jira`, `Épica`, `Tipo de pedido` y `Funcionalidad` en el encabezado de `spec.md`.
   - `/speckit-specify` es para historias de una épica **FUID** (spec nueva). Una historia de FDT o MAU trabaja sobre la spec existente de la funcionalidad (`/speckit-fdt-assess` o `/speckit-bug-assess`, y regla de oro): si te piden specify para una de ellas, avisa y deriva.
2. **Número de spec y carpeta.** El número es **único en toda la célula** (no por funcionalidad) y es el mismo en el repo de la célula y en todos los repos de capa de la historia. Pasa siempre `--number <N>` al hook de rama (`speckit.git.feature`); nunca dejes que Spec Kit lo calcule solo.
   - En el **repo de la célula** (tipo `celula` en `.github/sdd-plataforma.json`): usa el número que indique el usuario o el campo **Spec** de la historia en Jira; si no hay, obtén el siguiente libre con `sh ci/siguiente-spec.sh`. La funcionalidad es la carpeta `funcionalidades/<funcionalidad>/` donde está la historia en `jira/`, o la que indique el usuario; si hay duda, pregunta. Usa `SPECIFY_FEATURE_DIRECTORY=funcionalidades/<funcionalidad>/specs/<NNN>-<nombre-corto>`. La carpeta `specs/` de la raíz no se usa.
   - En un **repo de capa**: usa el número y el nombre corto de la spec de la historia, con `SPECIFY_FEATURE_DIRECTORY=specs/<NNN>-<nombre-corto>`.
3. **Rama.** Las ramas siguen la convención `feature/NNN-nombre` (configurada en `.specify/extensions/git/git-config.yml` con `branch_prefix: feature`). Si el usuario entrega `GIT_BRANCH_NAME`, úsalo tal cual. Antes de crear la rama verifica que el repo esté parado en `Desarrollo-CI`; si no lo está, avisa y pide confirmación.
4. **Repo de la célula vs repo de capa.**
   - En el **repo de la célula** (`celula-<célula>`): la spec es la de la historia; no menciona capas. Si la historia es de un FUID nuevo, crea también la spec base o `impacto.md` del FUID en la misma funcionalidad.
   - En un **repo de capa** (app, BFF, API, MS): la spec técnica referencia la spec de la historia (campo "Spec de la historia") y el contrato que cumple (campo "Contratos", con versión). No copies la spec de la historia: referencia sus escenarios por número y redacta solo lo que esta capa debe cumplir. En un API o MS **compartido** (`"compartido": true` en `.github/sdd-plataforma.json`) la funcionalidad no está fija: sale de la historia, y el campo **Funcionalidad** de `spec.md` es obligatorio.
5. **Nunca edites contratos** fuera del repo dueño. Si la historia necesita un contrato que no existe o cambiarlo, regístralo como `[NEEDS CLARIFICATION: cambio de contrato]`.
6. **Escribe en español**, con los nombres técnicos en su forma original.
