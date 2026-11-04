# Changelog

## 3.0.0 · 2026-11-04

**Cambio incompatible:** la gerencia trabaja por **funcionalidades** (Botón Pago Genérico, Autorizar Otros Comercios, Consultar Otros Comercios, nóminas MTN, transferencias…). El repo de la célula se organiza en `funcionalidades/<funcionalidad>/`, y los API y MS que comparten varias funcionalidades tienen sus contratos en `servicios/<repo>/`.

- **Épicas FUID, FDT o MAU.** En Jira, una épica es un pedido de cualquiera de los tres tipos, de una funcionalidad nueva o existente, y toda épica se divide en historias. Se trabaja siempre una historia: la rama de FDT y MAU usa la clave de la historia (`feature/fdt-WCAP-211-node-26`) y el tipo de pedido se lee de la épica padre. La funcionalidad hoy va en el título de la épica (`Migración Node 24 - Nóminas MTN`); no hay campo estándar.
- **Repos.** Cada funcionalidad tiene su app y su BFF; los API y MS pueden ser propios o compartidos (p. ej. `botonpago-api` y `botonpago-ms`). Los nombres de repo no se deducen de la funcionalidad: los declara `<funcionalidad>.code-workspace`, con la capa en el `name` de cada carpeta.
- `sdd-instalar.sh`: `capa <célula>/<funcionalidad>` (propio) o `capa <célula>` (compartido). `.github/sdd-plataforma.json` registra `funcionalidad` y `compartido`.
- Nuevos `scripts/sdd-funcionalidad.sh` y `scripts/sdd-servicio.sh` (crea `servicios/<repo>/contracts/`), con las plantillas `plantillas/funcionalidad/` y `plantillas/servicio/`.
- `sdd-abrir.sh`: recibe la clave de una historia, toma el tipo de pedido de su épica y agrega `sdd.funcionalidad` a `OTEL_RESOURCE_ATTRIBUTES`.
- `ci/sdd-checks.sh`: control `[funcionalidad]` (una historia toca una sola funcionalidad; también aplica a ramas `feature/fdt-*` y `feature/mau-*`; avisa cuando una rama mezcla un contrato compartido con una funcionalidad); `[numeracion]` y `validar-specs` sobre `funcionalidades/*/specs/`; `[e2e]` en un repo compartido saca la funcionalidad de la spec o propone `e2e.sh --todos "<tags>"`.
- `ci/e2e.sh <funcionalidad>` y `--todos ["<tags>"]`; `playwright.config.ts` con proyectos `<funcionalidad>-api` y `<funcionalidad>-ui`. La capa de presentación se llama **App**: las variables son `BFF_URL_<FUNCIONALIDAD>` y `APP_URL_<FUNCIONALIDAD>`.
- Tags de contrato: `<funcionalidad>/contracts-vX.Y.Z` y `servicios/<repo>/contracts-vX.Y.Z`.
- Preset `sdd-gerencia` 2.0.0 (spec con `Épica`, `Tipo de pedido` de la épica y `Funcionalidad`; specify solo para historias de FUID; rutas), extensión `sdd` 1.2.0 (`impacto` lee los repos del workspace, marca los compartidos y registra las otras funcionalidades afectadas) y `fdt` 1.1.0 (historia de una épica FDT; en un repo compartido revisa las specs de todas las funcionalidades que lo usan). Agentes Planner y Tester, plantillas de MR (historia, épica y funcionalidad) e instrucciones de capa y de célula.
- Ejemplo: célula Hades, tablero WCAP, funcionalidad `boton-pago-generico` (WCAP-100 a WCAP-105, WCAP-210/211, WCAP-300/301), repos `boton-pago-generico-app`, `boton-pago-generico-bff`, `botonpago-api` y `botonpago-ms`.

## 2.0.0 · 2026-11-04

**Cambio incompatible:** un repo por célula (`celula-<célula>`) reemplaza a los repos separados de specs y de E2E. Reúne `jira/`, `specs/NNN-nombre/` (spec de la historia e `impacto.md`), `contracts/` y `e2e/NNN-nombre/` (Playwright).

- `sdd-instalar.sh`: tipos `capa` y `celula`; los tipos `specs` y `e2e` ya no existen. `.github/sdd-plataforma.json` registra la célula.
- Numeración de specs **única en la célula**, con el nuevo `ci/siguiente-spec.sh`: así no chocan ramas `feature/NNN-*`, tags `@spec-NNN` ni carpetas dentro del mismo repo.
- Nuevo `ci/e2e.sh` y `playwright.config.ts` con un proyecto api y uno ui por carpeta.
- `ci/sdd-checks.sh`: control `[numeracion]`; `validar-specs` busca las specs en el repo de la célula; `[e2e]` indica el comando `ci/e2e.sh` del repo de la célula. El control tests-intactos y el hook protegen la carpeta `e2e/`.
- `sdd-abrir.sh`: busca la historia en el repo de la célula y abre su workspace. En el repo de la célula crea la rama si la spec ya existe (E2E) o si es FDT o MAU.
- Preset `sdd-gerencia` 1.1.0 (specify con `SPECIFY_FEATURE_DIRECTORY` y `--number` obligatorio; rutas de spec, contratos y E2E), extensión `sdd` 1.1.0 y `fdt` 1.0.2 (rutas), agentes Planner, Tester e Implementer, plantilla de MR FUID e instrucciones de capa. Instrucciones nuevas del repo de la célula (`instructions/celula`, con `e2e.instructions.md`).

## 1.0.4 · 2026-11-03

- Rendimiento con JMeter en BFF, API y MS: antes del pase, el área de performance ejecuta en el ambiente de QA los planes JMeter de toda la versión, con la carga y los umbrales que define el arquitecto.
  - Preset `sdd-gerencia` 1.0.3: sección "Rendimiento (JMeter)" en la plantilla de plan (`**JMeter**: sí | no`), fase de rendimiento con tareas `[tester]` en la plantilla de tasks y regla 5 en `/speckit-tasks`.
  - `ci/sdd-checks.sh`: control `[jmeter]` (bloquea si el plan dice "sí" y falta `perf/NNN-*/*.jmx`); el control tests-intactos también protege `perf/`, `*.jmx` y los tests de Flutter (`*_test.dart`, `integration_test/`).
  - Hook `tests-intactos`: mismo patrón.
  - Plantillas de MR FUID y FDT e instrucciones de capa.

## 1.0.3 · 2026-11-03

- Se quitan las APIs transversales del estándar: ya no existe `contracts/externos/` en el repo de specs y los contratos son solo los de los servicios de la célula.
- Preset `sdd-gerencia` 1.0.2 (plantilla de plan), extensión `fdt` 1.0.1 (`fdt-assess`) y extensión `sdd` 1.0.1 (`sdd-impacto`), más las instrucciones de Copilot de los repos `capa` y `specs`.

## 1.0.2 · 2026-11-03

- Preset `sdd-gerencia` 1.0.1: los ejemplos de la plantilla de spec usan los repos `specs-operaciones` y `bff-operaciones` (convención `<capa>-<nombre>`), y la constitution base ya no fija una versión del preset en el texto.
- Guía de prueba: el paso 0 parte con el BFF sin el estándar; el dev lo instala con `sdd-instalar.sh` y completa `copilot-instructions.md`.

## 1.0.1 · 2026-11-03

- `sdd-instalar.sh` ahora actualiza: reinstala el preset y las extensiones propias cuando cambia su versión o su contenido, y sobrescribe los archivos administrados que difieren.
- Nuevo modo `sdd-instalar.sh --revisar`: informa qué está atrasado sin cambiar nada y sale con 1 si hay pendientes.
- El tipo de repo se puede omitir al actualizar (se lee de `.github/sdd-plataforma.json`).
- Sin cambios en preset, extensiones ni agentes: en los repos solo cambia la versión registrada.

## 1.0.0 · 2026-11-03

Primera versión para el piloto de OPS-104 con Copilot.

- Preset `sdd-gerencia` 1.0.0 (plantillas de spec, plan, tasks y constitution; agregados a specify, tasks e implement).
- Extensiones `fdt` 1.0.0 y `sdd` 1.0.0.
- Agentes SDD Planner, Tester, Implementer y Reviewer; hook `tests-intactos`.
- Controles locales `ci/sdd-checks.sh` y `ci/specs-tocadas.sh`.
- Scripts `sdd-instalar.sh` y `sdd-abrir.sh`; guía de prueba.
