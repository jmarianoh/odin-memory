# Changelog

## 0.4.0 · 2026-11-04

- **Memoria entre chats con odin-memory** (opcional, local por desarrollador). Skill nueva `sdd-memoria`: convención `sdd/<CLAVE>/<artefacto>` (`estado`, `decisiones`, `tests-fase-N`, `avance-fase-N`, `revision`, `seguridad`) y `repo/<tema>` para aprendizajes del repo, qué lee y guarda cada agente, qué no se guarda nunca y fail-open si la memoria no está. El repo sigue siendo la fuente de verdad.
- Los seis agentes tienen `'odin-memory/*'` en `tools` y la skill `sdd-memoria`, con una sección de memoria: el Orquestador lee y guarda el estado (el paso lo sigue decidiendo el repo), el Planner las decisiones, el Tester los tests en rojo, el Implementer el avance y las causas raíz, el Reviewer los bloqueantes y SDD Seguridad solo su veredicto, sin detalles explotables.
- Instrucciones `sdd-dev-process`: sección "Memoria entre chats". `instalar.sh` instala `sdd-memoria` e informa si `odin` está en el PATH (no cuenta como pendiente).
- README, glosario (**Memoria del proceso**), knowledge README y guía de flujos (cómo se empieza, reglas y dónde queda cada cosa).

## 0.3.0 · 2026-11-04

- Requiere sdd-plataforma 3.0.0. La gerencia trabaja por **funcionalidades**: la spec de la historia, los contratos y los E2E viven en `celula-<célula>/funcionalidades/<funcionalidad>/`, y los contratos de los API y MS compartidos en `celula-<célula>/servicios/<repo>/contracts/`.
- **Épicas FUID, FDT o MAU.** SDD Orquestador: trabaja siempre la clave de una historia, toma el tipo de pedido de la épica padre, identifica la funcionalidad (carpeta del repo de la célula; en Jira, el título de la épica) y, en un API o MS compartido, avisa qué otras funcionalidades usan el repo. La línea de estado muestra la épica y la funcionalidad.
- SDD Planner y Tester, instrucciones `sdd-dev-process`, `sdd-tdd` (regresión de todas las funcionalidades que usan un repo compartido), perfiles de Angular y Flutter: rutas `funcionalidades/<funcionalidad>/` y "la app consume solo el BFF de su funcionalidad".
- Knowledge: glosario con **Funcionalidad**, **Épica**, **Historia** y **Servicio compartido**; FUID, FDT y MAU como tipos de épica. `overview.md` con app y BFF por funcionalidad y API y MS propios o compartidos (ejemplo: `botonpago-api` y `botonpago-ms`); los nombres de repo se declaran en el workspace de la funcionalidad. README, integraciones y guía de flujos.
- `sdd-jmeter`: la plantilla y `datos.csv` usan el ejemplo del Botón Pago Genérico (`pagoId`, WCAP-104).

## 0.2.0 · 2026-11-04

- Repo de la célula (sdd-plataforma 2.0.0): la spec de la historia, los contratos y los E2E viven en el repo `celula-<célula>`, en lugar de repos separados de specs y de E2E. La célula se lee de `.github/sdd-plataforma.json`.
- SDD Orquestador: paso 0 "Spec de la historia en el repo de la célula" (número único de la célula con `ci/siguiente-spec.sh`) y Jira simulado en el repo de la célula.
- SDD Planner, Tester e Implementer: rutas del repo de la célula; el Tester escribe los E2E en el repo de la célula y los corre con `sh ci/e2e.sh`; el hook `tests-intactos` protege la carpeta `e2e/`.
- Knowledge (overview, glosario, README, integraciones), instrucciones `sdd-dev-process`, perfil de Angular y la guía de flujos (paso 0 del FUID).

## 0.1.0 · 2026-11-03

Primera versión, para la fase 1 con los devs (célula Hades).

- Agentes de Copilot: **SDD Orquestador** (nuevo: clasifica el pedido, detecta el paso leyendo el repo y deriva con handoffs) y **SDD Seguridad** (nuevo: revisión de superficie sensible con informe `seguridad.md`). SDD Planner, Tester, Implementer y Reviewer, tomados de sdd-plataforma 1.0.2, con los pasos de MAU y FDT, las skills de proceso, la skill de stack del arquetipo y el retorno al Orquestador.
- Skills de proceso: `sdd-clasificar` (tipo, nivel N0/N1/N2 y superficie sensible), `sdd-tdd` (RED-GREEN-REFACTOR con roles separados y Prove-It) y `sdd-seguridad` (checklist por superficie y por stack, y plantilla del informe). Adaptadas de ai-dev-process.
- Skills de stack: `angular-developer` (oficial de Angular), `flutter` (agrupa 14 skills oficiales de Flutter y Dart), `nestjs-best-practices` (comunidad, la más instalada) y `node-express` (propia, basada en las guías oficiales de Express y Node.js).
- Hooks: `tests-intactos` (de sdd-plataforma, ahora también reconoce tests de Flutter) y `solo-informe` (SDD Seguridad solo escribe `seguridad.md`).
- Knowledge (`knowledge/`, se instala en `.github/knowledge/`): guía HTML de los flujos, glosario del proceso con secciones por subgerencia, arquitectura de la gerencia, calidad de código (umbrales por confirmar), 18 archivos de arquetipo en borrador y plantillas de integraciones y operación. Los agentes la leen antes de planificar, implementar y revisar.
- Certificación de QA: QA certifica en Jira cada historia y la versión antes del pase, y sin su OK no hay pase. Camino "defecto de QA" en el Orquestador, en `sdd-clasificar` (cinco tipos de hallazgo), en `sdd-tdd` (Prove-It), en el Tester y el Implementer, en el glosario y en la guía (hoja 08).
- Rendimiento y ethical hacking: después del OK de QA, el área de performance ejecuta los planes JMeter de BFF, API y MS y el área de ethical hacking prueba la versión; sin los tres OK no hay pase. Skill nueva `sdd-jmeter` (plantilla `.jmx` parametrizada, `datos.csv` y README de `perf/`), instalada solo en Express y NestJS. El Tester escribe los planes, el hook `tests-intactos` los protege del Implementer y el Reviewer los revisa. El "defecto de QA" pasa a "defecto de certificación" (QA, performance o ethical hacking).
- Catálogo de 18 arquetipos (Personas, Empresas y Adquirencia × web y app × tres templates) con perfil por stack.
- `scripts/instalar.sh` (instala, actualiza, `--revisar`, `--listar`) y `scripts/actualizar-skills.sh`.
