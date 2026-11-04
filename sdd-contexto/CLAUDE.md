# Contexto: SDD en Gerencia de Canales Digitales

Este repo implementa la metodología Spec-Driven Development (SDD) de la gerencia: Jira → Spec Kit → GitHub Copilot → GitLab CE → Playwright.
El detalle completo está en `docs/sdd-playbook.md`; este archivo resume las decisiones que no se discuten.

@docs/sdd-playbook.md

## Organización

- Gerencia con 6 equipos; cada equipo tiene su template de app (web o móvil) y de BFF/API/MS.
- Subgerencias Personas, Empresas y Adquirencia, cada una con canal web (templates Express, NestJS, Angular) y app (Express, NestJS, Flutter): 18 arquetipos, id `<subgerencia>-<canal>-<stack>`.
- Unas 20 células de 4 devs, todos full-stack. Cada célula es dueña de sus repos.
- **La gerencia trabaja por funcionalidades**: botón de pago SII, Botón Pago Genérico, Autorizar Otros Comercios, Consultar Otros Comercios, nóminas MTN, transferencias… Cada funcionalidad tiene su **app y su BFF**; la **API y el MS pueden ser propios o compartidos** entre funcionalidades (en Hades, Botón Pago Genérico, Autorizar Otros Comercios y Consultar Otros Comercios comparten `botonpago-api` y `botonpago-ms`). Los nombres de repo no siguen una convención fija (`boton-pago-generico-bff`, `boton-pago-generico-nwe-app`, `btpgconsult-generic-app`, `btnconsulta-bff`…).
- Herramientas: Jira (PO/Scrum; el PO solo tiene acceso a Jira), GitHub Copilot en VS Code con Spec Kit, GitLab Community Edition self-managed (código, CI/CD y despliegue), Playwright (E2E), Backstage (catálogo).
- Design system: **Arándano**, paquete npm `@arandano` (nombre exacto bajo el scope por confirmar).

## Tipos de pedido (el PO solo puede abrir estos tres)

En Jira, una **épica** es un pedido FUID, FDT o MAU de una funcionalidad nueva o existente, y **toda épica se divide en historias**; se trabaja siempre una historia. Por ahora la funcionalidad va en el título de la épica (`Migración Node 24 - Nóminas MTN`); no hay un campo estándar.

| Tipo de épica | Qué es | Camino de cada historia |
| --- | --- | --- |
| FUID (Ficha Única de Ingreso de la Demanda) | Funcionalidad completa, nueva o sobre una existente; cada pantalla o capacidad es una historia y una spec nueva | Flujo SDD completo: specify → clarify → plan → tasks → analyze → implement → converge |
| FDT | Cambio puntual sobre una funcionalidad existente (actualizar un endpoint, migrar Node) | Extensión corporativa `fdt`: fdt-assess → fdt-apply → fdt-test, con la regla de oro sobre la spec vigente |
| MAU | Corrección de incidente en producción | Extensión `bug` de Spec Kit: bug-assess → bug-fix → bug-test |

Ejemplo (tablero de Jira de Hades: **WCAP**; los números son de ejemplo), funcionalidad Botón Pago Genérico:
- Épica FUID WCAP-100 `Pago con autorización - Botón Pago Genérico`: WCAP-101 base del flujo (spec 001, habilitadora), WCAP-102 selección de cuenta de cargo (002), WCAP-103 resumen del pago (003), WCAP-104 autorización del pago (004), WCAP-105 comprobante (005).
- Épicas FDT: WCAP-200 `Contrato v2 - Botón Pago Genérico` (historia WCAP-201 · actualizar a versión 2); WCAP-210 `Migración Node 24 - Botón Pago Genérico` (historia WCAP-211 · migrar Node 24 a 26).
- Épica MAU: WCAP-300 `Autorización con monto cero - Botón Pago Genérico` (historia WCAP-301).

**Regla de oro (FDT):** si toca un contrato, primero el dueño del contrato; si cambia comportamiento, se actualiza `spec.md` y luego el código; si es solo técnico, regresión completa.

**Certificación antes del pase (sin los tres OK no hay pase, tampoco en la ruta rápida de un MAU):** 1) **QA** trabaja en Jira y certifica cada historia (estado "En certificación QA", después del E2E verde) y la versión completa; 2) **performance** (otra área) ejecuta sobre la **versión completa**, en el **ambiente de QA**, los planes JMeter que entregan BFF, API y MS en `perf/NNN-nombre/NNN-nombre.jmx` (los escribe el SDD Tester con la skill `sdd-jmeter`; `plan.md` declara `**JMeter**: sí | no`; la carga y los umbrales los define el **arquitecto**; la plantilla `.jmx` es provisional hasta el template de la gerencia); 3) **ethical hacking** (otra área) prueba la versión completa en QA, con `seguridad.md` como insumo. Las historias con OK de QA esperan en "Lista para producción" hasta que su versión tenga los tres OK. Un hallazgo de cualquiera es un defecto de Jira enlazado a la historia, no un MAU: se clasifica (contra la spec, el umbral o la severidad) y, si hay código, se corrige con Prove-It en `feature/NNN-<qa|perf|eh>-<CLAVE>-<nombre>` con el número de la spec.

## Ramas (GitLab)

- `master`: respaldo de producción.
- `Desarrollo-CI`: rama que se despliega a producción.
- `feature/*`: ramas de trabajo; el pipeline solo corre en `feature/*`. Terminado el trabajo, MR a `Desarrollo-CI` para certificar en QA.
- Convención: `feature/NNN-nombre` (historia de FUID), `feature/fdt-<clave-historia>-<nombre>`, `feature/mau-<clave-historia>-<nombre>`.
- La clave de la historia va en el título de cada MR. No usar `Closes WCAP-xxx` en MR de capa.
- Ideal: Jira crea las ramas en GitLab (app GitLab for Jira Cloud; con Jira Data Center no se puede).

## Repos

- Un repo por capa: app, BFF, API, MS. App y BFF son de una funcionalidad; API y MS, propios o compartidos.
- `celula-<célula>`, uno por célula (ejemplo: `celula-hades`), con una carpeta por funcionalidad `funcionalidades/<funcionalidad>/`: `jira/` (simulado en el piloto), `specs/NNN-nombre/` (spec por historia e `impacto.md`), `contracts/<repo>/` (contratos de sus servicios propios, tags `<funcionalidad>/contracts-vX.Y.Z`), `e2e/NNN-nombre/` (Playwright, proyectos `<funcionalidad>-api` contra el BFF y `<funcionalidad>-ui`; tags `@spec-NNN`, `@WCAP-NNN`, `@mau`; se corre con `ci/e2e.sh <funcionalidad>`) y `<funcionalidad>.code-workspace`, que **declara sus repos** (los nombres no se deducen). El test va en la capa más externa que toca el cambio.
- API y MS compartidos: contratos en `servicios/<repo>/contracts/` del repo de la célula (tags `servicios/<repo>/contracts-vX.Y.Z`), sin specs ni E2E propios; los cambia su dueño en su propio MR. Su repo se instala con `capa <célula>` (sin funcionalidad) y la funcionalidad de cada historia sale de su spec; si sus specs son de varias funcionalidades, E2E con `ci/e2e.sh --todos "<tags>"`.
- Numeración de specs **única en la célula** (`ci/siguiente-spec.sh`); una historia es de una sola funcionalidad (control `[funcionalidad]`). Lo implementa sdd-plataforma 3.0.0.
- `sdd-plataforma`: fuente de verdad del estándar (preset, extensiones, controles de CI, plantillas de MR, catálogo de Spec Kit, scripts `sdd-instalar` y `sdd-abrir`).
- `sdd-dev-process`: forma de trabajo del desarrollador con agentes (fase 1). Agentes, skills de proceso y de stack, hooks, instrucciones, knowledge y catálogo de arquetipos. Se instala después de `sdd-plataforma` con `scripts/instalar.sh <repo> <arquetipo>`.
- Workspace `.code-workspace` por funcionalidad con sus repos de capa (propios y compartidos) + el repo de la célula; vive en `funcionalidades/<funcionalidad>/` del repo de la célula. Los repos de capa registran célula, funcionalidad y si son compartidos en `.github/sdd-plataforma.json` (`sdd-instalar.sh <repo> capa <célula>/<funcionalidad>`, o `capa <célula>` si es compartido).

## Copilot y Spec Kit

- Spec Kit 1.x (`uv tool install specify-cli`); comandos como skills `/speckit-*` en `.github/skills/`.
- Agentes en `.github/agents/*.agent.md`, desde `sdd-dev-process`: **SDD Orquestador** (punto de entrada: clasifica, detecta el paso leyendo el repo y deriva con handoffs), SDD Planner, SDD Tester, SDD Implementer, SDD Reviewer y **SDD Seguridad** (obligatorio con superficie sensible; escribe solo `seguridad.md`). El agente que escribe tests no es el que escribe código (tareas `[tester]`/`[implementer]`, hook PreToolUse y job de CI `tests-intactos`).
- Niveles N0/N1/N2 y superficie sensible (auth, datos personales, pagos, endpoint público con efecto…) en la skill `sdd-clasificar`; TDD en `sdd-tdd`; checklist de seguridad en `sdd-seguridad`.
- Skills de stack, una por repo según su arquetipo: `angular-developer` (oficial), `flutter` (agrupa las oficiales de Flutter y Dart), `nestjs-best-practices` (comunidad) y `node-express` (propia; no hay oficial).
- Knowledge en `.github/knowledge/` (guía de flujos, glosario, arquitectura, calidad de código, arquetipo del repo). Prioridad: knowledge del arquetipo > skill del stack > documentación oficial.
- Memoria entre chats con **odin-memory** (MCP propio de la gerencia, SQLite local por dev, `npm install -g odin-memory` desde el Nexus + `odin setup vscode-copilot`), opcional y local en el piloto. Skill `sdd-memoria` (sdd-dev-process 0.4.0): claves `sdd/<CLAVE>/<artefacto>`, el repo manda, nunca secretos, RUT, montos ni detalle de hallazgos de seguridad.
- Instrucciones: org (GitHub), `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` con `applyTo` (incluye `sdd-dev-process` y `arquetipo`).
- Preset y extensiones se instalan en cada repo desde el catálogo propio (`SPECKIT_CATALOG_URL`). todo va como archivos versionados en el repo.

## Adopción en dos fases

- Fase 1: `sdd-dev-process` con los devs, empezando por la célula Hades (Botón Pago Genérico, Autorizar Otros Comercios, Consultar Otros Comercios, botón de pago SII, nóminas CDS y MTN).
- Fase 2: propuesta macro a la gerencia (un repo por célula con specs, contratos y E2E por funcionalidad, CI que bloquea, PO en Jira, telemetría), con `sdd-dev-process` como capa de repo.
- MCP permitidos: Atlassian (Jira) y Figma (`https://mcp.figma.com/mcp`); falta agregar `odin-memory` (local, stdio); tokens personales, scopes mínimos, vencimiento corto, nunca en el repo.

## Contratos

Versionados con tags y semver; Pact consumer-driven (Pact Broker, `can-i-deploy`); `oasdiff` para cambios incompatibles; majors coexisten; tolerant reader.

## CI en GitLab CE (jobs clave)

`validar-specs`, `jmeter` (BFF, API y MS), `regla-de-oro` (`specs/mapa.txt`, label `sin-cambio-comportamiento`), `clave-jira`, veredicto FDT/MAU, `tests-intactos`, `numeracion` y `funcionalidad` (repo de la célula), trigger E2E al repo de la célula con la funcionalidad, las specs tocadas (`ci/specs-tocadas.sh`) y la rama de tests, `deploy-qa`. Despliegue MS → API → BFF → app, con feature flag en la app.

## Telemetría

GitHub factura en AI Credits por persona y modelo, pero no por pedido. El costo por historia y FUID se mide con la telemetría OpenTelemetry de Copilot (`github.copilot.chat.otel.enabled`), sin capturar contenido, con `OTEL_RESOURCE_ATTRIBUTES="jira.clave=WCAP-104,jira.padre=WCAP-100,jira.tipo=FUID,sdd.funcionalidad=boton-pago-generico"` puesto por `sdd-abrir` (la clave es la de la historia; el padre, la épica; la funcionalidad sale de la carpeta). Una ventana de VS Code por historia.

## Puntos abiertos (no asumir)

- Validar en el piloto la extensión `fdt` (fdt-assess → fdt-apply → fdt-test).
- Ruta rápida para MAU; si `Desarrollo-CI` puede tener cambios sin certificar cuando llega un MAU.
- Jira Cloud o Data Center (creación de ramas y MCP).
- Adoptar la clave de Jira en ramas de FUID (`feature/004-WCAP-104-autorizacion`).
- Estándar para registrar la funcionalidad en la épica de Jira (hoy va en el título: `Migración Node 24 - Nóminas MTN`; ¿componente, etiqueta o campo?).
- Repos de app y BFF de Autorizar Otros Comercios y Consultar Otros Comercios (y a qué funcionalidad corresponden `boton-pago-generico-nwe-*`, `btpgconsult-generic-app` y `btnconsulta-bff`).
- Nombre exacto del paquete bajo `@arandano`.
- Collector OpenTelemetry, tablero de costo y cost center por equipo; validar `jira.clave` junto a los atributos centrales.
- Repo de template y knowledge de cada uno de los 18 arquetipos; términos de negocio por subgerencia; umbrales de calidad de la gerencia.
- MCP del Angular CLI y de Dart/Flutter en la allowlist; design system para apps.
- Validar en VS Code el campo `skills` de los agentes y los hooks por agente; en fase 2, dejar los agentes en un solo repo.
- odin-memory en la allowlist de MCP y en el Nexus; validar `'odin-memory/*'` en el `tools` de los agentes; en fase 2, memoria compartida en la célula.
- Validar en el piloto que los comandos de Spec Kit encuentran la spec en `funcionalidades/<funcionalidad>/specs/` (`SPECIFY_FEATURE_DIRECTORY` y `.specify/feature.json`).

## Cómo escribir en este repo

- Español en docs, specs y mensajes de MR; nombres técnicos en su forma original.
- No inventar claves de Jira, versiones ni nombres de repos: usar los de este archivo o preguntar.
