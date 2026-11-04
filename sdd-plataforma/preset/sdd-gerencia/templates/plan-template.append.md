
## Trazabilidad SDD *(obligatorio, estándar de la gerencia)*

**Jira**: [CLAVE DE LA HISTORIA] · **Épica**: [CLAVE] ([FUID | FDT | MAU]) · **Funcionalidad**: [funcionalidad] · **Spec de la historia**: [ruta]

| Fase | Agente | Modelo usado |
| --- | --- | --- |
| specify / clarify / plan | SDD Planner | [modelo del selector] |
| tests | SDD Tester | [modelo] |
| implement / converge | SDD Implementer | [modelo] |
| revisión | SDD Reviewer | [modelo, distinto al del Implementer] |

## Contratos que cumple *(obligatorio)*

<!--
  Los contratos se consumen en versión fija y NO se editan en este repo.
  Si el plan necesita cambiar un contrato, detener el plan y abrir un MR en el repo dueño
  del contrato: `funcionalidades/<funcionalidad>/contracts/` del repo de la célula (tag `<funcionalidad>/contracts-vX.Y.Z`)
  o, si es de un API o MS compartido, `servicios/<repo>/contracts/` (tag `servicios/<repo>/contracts-vX.Y.Z`).
  Un cambio en un contrato compartido afecta a todas las funcionalidades que lo usan.
-->

| Contrato | Versión | Rol de esta capa (proveedor / consumidor) | Endpoints |
| --- | --- | --- | --- |
| [ruta] | [<funcionalidad>/contracts-vX.Y.Z o servicios/<repo>/contracts-vX.Y.Z] | [rol] | [método y ruta] |

## Componentes de Arándano *(solo apps web; borrar en otras capas)*

| Elemento de pantalla | Componente | Variante o props | Documentación |
| --- | --- | --- | --- |

### Brechas

| Necesidad | Por qué no sirve lo existente | Issue en Arándano |
| --- | --- | --- |

## Pruebas E2E de la spec *(obligatorio)*

<!--
  Regla: el test va en la capa más externa que el cambio alcanza en integración.
  Backend con comportamiento → proyecto `api` (contra el BFF). App → proyecto `ui`.
-->

| Escenario de la spec | Proyecto Playwright (api / ui) | Archivo en el repo de la célula | Tags |
| --- | --- | --- | --- |
| [###] › [escenario] | [api] | `funcionalidades/<funcionalidad>/e2e/###-nombre/[archivo].api.spec.ts` | `@spec-###` `@CLAVE` |

## Rendimiento (JMeter) *(obligatorio en BFF, API y MS; borrar en la app)*

<!--
  Antes del pase, el área de performance ejecuta en el ambiente de QA los planes JMeter de toda la versión.
  "sí" exige perf/###-nombre/###-nombre.jmx en este repo (control [jmeter] de ci/sdd-checks.sh).
  "no" solo si la spec no agrega ni cambia endpoints de esta capa; escribir el motivo.
  Carga y umbrales: los define el arquitecto.
-->

**JMeter**: sí | no — [motivo si es no]

| Endpoint | Carga esperada | Umbral de respuesta | Plan |
| --- | --- | --- | --- |
| [método y ruta] | [usuarios o req/s, los define el arquitecto] | [ms, los define el arquitecto] | `perf/###-nombre/###-nombre.jmx` |

## Mapa de specs

Rutas de código de este repo que pertenecen a esta spec (se agregan a `specs/mapa.txt` con el formato `<ruta> <###-nombre>`):

- `[ruta]` → `[###-nombre]`
