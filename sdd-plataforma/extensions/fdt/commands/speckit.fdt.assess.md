---
description: "Clasifica un FDT con la regla de oro (contrato, comportamiento o técnico), lista specs y contratos afectados y define las pruebas. No toca código"
---

# Evaluar FDT

Un FDT es un cambio puntual pedido por el PO en Jira (actualizar un endpoint, migrar Node, subir una librería). Este comando **no toca código**: clasifica el cambio con la regla de oro, encuentra las specs y contratos afectados y define qué pruebas deben correr. El resultado es `.specify/fdt/<slug>/assessment.md`, que consumen `__SPECKIT_COMMAND_FDT_APPLY__` y `__SPECKIT_COMMAND_FDT_TEST__`.

## Entrada del usuario

```text
$ARGUMENTS
```

La entrada trae la clave de la **historia** de Jira (p. ej. `WCAP-211`), que pertenece a una épica de tipo FDT, la descripción del cambio y, opcionalmente, `slug=<nombre-corto>`. Si hay un servidor MCP de Jira disponible, lee la historia y su épica desde ahí; si no, busca `../celula-<célula>/funcionalidades/*/jira/<CLAVE>.md` (célula en `.github/sdd-plataforma.json`; la funcionalidad es la carpeta donde está la historia) o usa el texto pegado. Si la clave es de la épica, pide la historia. Un FDT trabaja sobre una funcionalidad existente: si resulta ser funcionalidad nueva, se devuelve al PO como FUID.

## Slug y rama

1. Usa el slug que entrega el usuario (normalizado a minúsculas con guiones). Si no hay, propone uno de 2 a 4 palabras y pide confirmación.
2. `FDT_DIR = .specify/fdt/<slug>/`. Si `assessment.md` ya existe, pregunta antes de sobrescribir.
3. La rama debe ser `feature/fdt-<CLAVE>-<slug>` y salir de `Desarrollo-CI` actualizada. Si el repo está en otra rama, avisa; si está en `Desarrollo-CI`, ofrece crearla con `git switch -c feature/fdt-<CLAVE>-<slug>`.

## Ejecución

1. **Resumir el pedido** en una o dos frases: qué cambia y por qué.
2. **Buscar specs afectadas**: revisa `specs/*/spec.md` de este repo y las specs vigentes de la funcionalidad en `../celula-<célula>/funcionalidades/<funcionalidad>/specs/`. En un API o MS compartido, revisa las specs de **todas** las funcionalidades cuyo workspace incluye este repo (`../celula-<célula>/funcionalidades/*/*.code-workspace`). Cita el escenario, requisito (FR-xxx) o regla que el cambio toca, con su ruta.
3. **Buscar contratos afectados**: revisa los contratos que este repo cumple o consume (ver `plan.md` de las specs y `../celula-<célula>/funcionalidades/<funcionalidad>/contracts/` y, si es compartido, `../celula-<célula>/servicios/<repo>/contracts/`).
4. **Aplicar la regla de oro.** Pregunta: después de este cambio, ¿algún criterio de aceptación o regla de una spec quedaría falso o incompleto? Cualquier "sí" a estas señales es cambio de comportamiento:
   - Cambia lo que el usuario ve, ingresa o puede hacer.
   - Cambia una regla de negocio, una validación o un límite, aunque sea un valor de configuración.
   - Cambia un dato que se guarda, se muestra o se envía.
   - Cambia un contrato entre capas.
5. **Clasificar** en una sola categoría (la más restrictiva gana):
   - **contrato**: toca un contrato. Primero el dueño del contrato: MR en el repo dueño y nueva versión (mayor si es incompatible). Este repo espera esa versión o trabaja contra un mock.
   - **comportamiento**: cambia una spec. Se edita `spec.md` en "Cambios posteriores" (no con `/speckit-specify`), se envía el resumen al PO en Jira y luego se cambia el código.
   - **tecnico**: no cambia comportamiento. Sin cambio de spec; regresión completa de la funcionalidad (de todas las que usan el repo, si es compartido).
   - **devolver**: en realidad es funcionalidad nueva. Se devuelve al PO para que la abra como FUID. Detente aquí.
6. **Definir pruebas**:
   - Unitarias y de contrato del repo.
   - E2E: tags a correr (`@spec-NNN` de las specs afectadas; si es técnico, la suite completa). Indica si hay que escribir o ajustar tests en `funcionalidades/<funcionalidad>/e2e/` del repo de la célula y en qué proyecto (`api` o `ui`), según la regla de la capa más externa.
7. **Escribir** `FDT_DIR/assessment.md`:

   ```markdown
   # FDT: <título>

   - **Jira**: <CLAVE>
   - **Slug**: <slug>
   - **Rama**: feature/fdt-<CLAVE>-<slug>
   - **Fecha**: <ISO 8601>
   - **Clasificación**: contrato | comportamiento | tecnico | devolver

   ## Pedido
   <resumen>

   ## Regla de oro
   | Señal | ¿Aplica? | Evidencia |
   | --- | --- | --- |
   | Cambia lo que el usuario ve, ingresa o puede hacer | sí/no | |
   | Cambia una regla, validación o límite | sí/no | |
   | Cambia un dato guardado, mostrado o enviado | sí/no | |
   | Cambia un contrato entre capas | sí/no | |

   ## Specs y contratos afectados
   - `<ruta>` — <escenario o FR> — <qué queda falso o incompleto>

   ## Alcance del cambio
   **Archivos que probablemente cambian**:
   - `<ruta>`

   **Actualización de spec** (si es comportamiento): fila a agregar en "Cambios posteriores".

   ## Pruebas definidas
   | Prueba | Comando | Obligatoria |
   | --- | --- | --- |
   | Unitarias | `npm test` | sí |
   | E2E | `npx playwright test --grep "<tags>"` | sí |

   ## Riesgos
   - <riesgo>

   ## Preguntas abiertas
   - [NEEDS CLARIFICATION: …]
   ```

8. **Informar**: slug, ruta del reporte, clasificación y siguiente paso (`__SPECKIT_COMMAND_FDT_APPLY__ slug=<slug>`, o el MR al dueño del contrato, o devolver al PO).

## Reglas

- Nunca modifiques código ni specs en este comando; solo escribes dentro de `.specify/fdt/<slug>/`.
- No inventes specs ni rutas que no existan.
- Si la clasificación es dudosa entre técnico y comportamiento, elige comportamiento y explica por qué.
