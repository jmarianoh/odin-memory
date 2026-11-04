# Playbook SDD en Gerencia de Canales Digitales

Spec Kit, GitHub Copilot y GitLab.

Nov 4, 2026 · @José

Versión visual: `docs/sdd-canales-digitales.html`, con las mismas partes y en el mismo orden.

## Parte I · Fundamentos

Las reglas que valen para todos los equipos y dónde vive el estándar.

### Contexto

La Gerencia de Canales Digitales adopta Spec-Driven Development (SDD) con Spec Kit y GitHub Copilot sobre GitLab, con un estándar común para sus 6 equipos y dos caminos de trabajo: funcionalidad completa y bugs o cambios menores.

| Aspecto | Situación actual |
| --- | --- |
| Organización | Gerencia con 6 equipos y 20 células |
| Unidad de trabajo | Células de 4 desarrolladores full-stack, con Scrum |
| Planificación | Jira (en Hades, tablero WCAP): los PO crean y priorizan épicas e historias. Una épica es un FUID, un FDT o un MAU de una funcionalidad nueva o existente |
| Funcionalidades | La gerencia trabaja por funcionalidades: Botón Pago Genérico, Autorizar Otros Comercios, Consultar Otros Comercios, botón de pago SII, nóminas MTN, transferencias… |
| Arquitectura | App (web o móvil), BFF, API y microservicios, cada capa en un repo aparte. Cada funcionalidad tiene su app y su BFF; la API y el MS pueden ser propios o compartidos entre funcionalidades. Cada célula es dueña de sus repos |
| Templates | Cada equipo tiene su template propio de app y de BFF/API/MS. Por subgerencia (Personas, Empresas, Adquirencia) y canal: web con Express, NestJS y Angular; app con Express, NestJS y Flutter. En total, 18 arquetipos |
| Design system | Arándano: repo propio con los componentes de UI y su documentación de implementación |
| Código y despliegue | GitLab Community Edition, self-managed: repos, MR, CI/CD y despliegue |
| Ramas | Toda rama comienza con `feature/`; es requisito para que corra el pipeline. Los MR van a Desarrollo-CI, que se certifica en QA y se despliega a producción; master es el respaldo de producción |
| Pruebas obligatorias | E2E con Playwright al final de cada desarrollo y pruebas funcionales completas |
| Agente de código | GitHub Copilot en el IDE, modo agente |
| Caminos de trabajo | Tres tipos de pedido del PO: FUID (funcionalidad completa), FDT (cambio puntual) y MAU (incidente en producción) |

Spec Kit trabaja sobre git plano, así que funciona igual con GitLab. Community Edition no incluye épicas, aprobaciones obligatorias, Code Owners, labels con alcance ni templates de proyecto de grupo; este playbook usa los equivalentes disponibles en CE: épicas en Jira, master y Desarrollo-CI protegidas, merge solo por maintainers y jobs de CI que bloquean.

### Principios y decisiones clave

El estándar vive en los repositorios y se verifica en GitLab CI; todo lo demás es comodidad opcional.

1. **Si es una regla, va en el repo; si es una comodidad, puede ir en un plugin.** Plantillas, constitution, agentes, skills y knowledge se versionan en GitLab (`sdd-plataforma` y `sdd-dev-process`). No se usa plugin de Copilot.
2. **La spec dice qué y por qué; el plan dice cómo.** `spec.md` no menciona capas. App, BFF, API y MS aparecen en el plan, los contratos y las tareas.
3. **La unidad es una capacidad que se prueba por separado, no una pantalla.** Si una pantalla crece, se parte; si dos son triviales, se juntan.
4. **Contratos primero.** Se acuerdan y versionan por su dueño antes de implementar, para que las capas avancen en paralelo con mocks.
5. **Implementar por fases.** Una fase o rango de tareas por vez, chat nuevo de Copilot por fase, commit al cerrar cada una, y `/speckit-converge` hasta que reporte "Converged". La memoria odin-memory une esos chats (estado, decisiones y pendientes de la historia); la spec versionada sigue siendo la fuente de verdad.
6. **Revisión humana entre fases.** El PO aprueba la spec, ingeniería el plan y un revisor el código. Tests y CI son la fuente de verdad, no el "listo" del agente.
7. **Regla de oro.** Si un cambio altera un comportamiento descrito en una spec, primero se actualiza la spec y después el código.
8. **Versión fijada.** Spec Kit (1.x, desde PyPI), el preset y las extensiones se fijan por versión y se actualizan de forma centralizada.

### Arquitectura de gobierno

Un equipo de plataforma (o grupo de champions) mantiene un paquete corporativo versionado; los 6 equipos lo consumen a través de sus templates.

| Capa | Qué contiene | Dónde vive | Dueño |
| --- | --- | --- | --- |
| Políticas de Copilot | Modelos permitidos, política de modelos y funciones nuevas, allowlist de MCP | Organización o enterprise de GitHub donde están las licencias | Administrador de Copilot |
| Catálogo corporativo | Preset (plantillas de spec, plan y tasks; constitution base; agentes por fase), extensiones (`bug`, impacto) | Repo de plataforma en GitLab; catálogo publicado en GitLab Pages o servidor interno | Equipo de plataforma |
| Forma de trabajo del desarrollador | Agentes de Copilot (Orquestador, Planner, Tester, Implementer, Reviewer, Seguridad), skills de proceso y de stack, hooks, instrucciones y knowledge por arquetipo | Repo `sdd-dev-process` en GitLab, instalado en cada repo de capa con su arquetipo | Equipo de plataforma; cada subgerencia completa el knowledge de sus arquetipos |
| Templates de equipo | Los templates de app y BFF/API/MS (18 arquetipos: subgerencia × canal × stack) con Spec Kit inicializado, preset, sdd-dev-process y jobs de CI ya incluidos | Repo plantilla por arquetipo, clonado con un script de bootstrap | Cada subgerencia, con un bloque Spec Kit común |
| Repo | Constitution de equipo, specs, overrides justificados | Cada repo | Célula |
| Máquina del desarrollador | Nada obligatorio. El plugin de Copilot quedó descartado (ver "Preset, npm o plugin") | Local | Cada desarrollador |

Cada template de equipo puede ser distinto en su stack, pero el bloque común (preset, extensiones y jobs de CI de `sdd-plataforma`; agentes, skills y knowledge de `sdd-dev-process`) es idéntico en todos. Un repo nuevo nace con el estándar ya puesto.

Spec Kit resuelve las plantillas en este orden: overrides locales, presets, extensiones y core. Los overrides en `.specify/templates/overrides/` quedan para excepciones justificadas y revisadas en MR. Los presets y extensiones de la comunidad entran solo después de revisar su código.

## Parte II · Jira y tipos de pedido

Todo parte de un pedido del PO en Jira: FUID, FDT o MAU, dividido en historias.

### Jira como punto de partida

Todo parte en Jira: el PO crea y prioriza épicas e historias allí, y la clave de cada historia viaja con la spec, los MR y los tests hasta volver a Jira.

**Una épica es un pedido.** Puede ser un FUID, un FDT o un MAU, de una funcionalidad nueva o existente, y **toda épica se divide en historias**: se trabaja siempre una historia. Por ahora la funcionalidad va en el título de la épica (`Migración Node 24 - Nóminas MTN`); no hay un campo estándar (ver puntos abiertos).

| En Jira (PO) | En el flujo SDD |
| --- | --- |
| Épica FUID | Funcionalidad completa, nueva o sobre una existente: spec base y una spec por capacidad en el repo de la célula, en la carpeta de la funcionalidad (Camino 1) |
| Épica FDT | Cambio puntual sobre una funcionalidad existente: extensión `fdt` y regla de oro sobre la spec vigente (Camino 2) |
| Épica MAU | Incidente en producción: extensión `bug` (Camino 3) |
| Historia de una épica FUID | Una spec de capacidad nueva (NNN). Sus criterios de aceptación son los escenarios de `spec.md` y los nombres de los tests E2E |
| Historia de una épica FDT o MAU | Un cambio o corrección sobre la spec existente de la funcionalidad. Su clave va en la rama (`feature/fdt-WCAP-211-node-26`) |
| Subtarea por capa (opcional) | Un MR en el repo de esa capa |

**Trazabilidad con la clave de Jira:**

- **`spec.md`:** lleva `Jira: WCAP-104`, la épica (`WCAP-100`, FUID) y la funcionalidad (`boton-pago-generico`) en su encabezado (campos de la plantilla del preset). Los criterios de aceptación de la historia, escritos como Dado / Cuando / Entonces, pasan a ser los escenarios de la spec.
- **MR y commits:** el título del MR empieza con la clave (`WCAP-104 Autorizar pago · BFF`) y los commits la mencionan. La integración de GitLab con Jira, disponible en la edición gratuita, comenta esa actividad en la historia. Exigir la clave para hacer merge es una función de Ultimate, así que se valida con un job de CI.
- **Tests de Playwright:** cada test lleva el tag `@WCAP-104` además de `@spec-NNN`.
- **Ramas:** siguen siendo `feature/NNN-nombre`; la clave viaja en el MR y los commits.

**Estados de la historia en Jira:**

| Estado | Condición para entrar | Quién la mueve |
| --- | --- | --- |
| Refinada | Criterios Dado / Cuando / Entonces y diseño enlazado (definición de listo) | PO |
| Spec en revisión | La célula publica en la historia el resumen de la spec y sus dudas; el PO responde ahí | Célula |
| Lista para desarrollo | El PO aprueba el resumen en Jira; contratos v1 publicados | PO y líder técnico |
| En desarrollo | Un MR por capa con la clave en el título | Célula |
| En integración | Todas las capas en integración; corre el E2E de la spec | Célula |
| En certificación QA | E2E de la spec en verde; QA certifica la historia en Jira | QA |
| Lista para producción | OK de QA de la historia, sin defectos abiertos que bloqueen. Queda en la versión del próximo pase | QA |
| Hecha | La versión pasó sus certificaciones, está en producción y con el flag encendido | PO |

**Certificación de la versión (antes de cada pase):** las historias en "Lista para producción" se agrupan en la versión del pase. En el ambiente de QA, la versión completa pasa por QA de la versión → Performance (planes JMeter de BFF, API y MS, con la carga y los umbrales que define el arquitecto) → Ethical hacking. Con los tres OK y las funcionales en verde se hace el pase, y las historias pasan a "Hecha" cuando el PO lo confirma.

Estos son los estados de un FUID. FDT y MAU usan flujos más cortos, descritos en "Tipos de pedido".

**Reglas:**

- **No usar `Closes WCAP-104` en los MR de capa.** Una historia cruza cuatro repos y se cerraría con el primer merge. Las palabras de cierre se desactivan en la integración o simplemente no se usan.
- **Dudas de `clarify`:** las que necesitan al PO se dejan como comentario en la historia, y la respuesta queda registrada en `spec.md`.
- **Revisión de la spec por el PO:** la célula publica en la historia un resumen de `spec.md` (escenarios, fuera de alcance y decisiones) junto con sus dudas. El PO responde ahí y aprueba moviendo la historia a "Lista para desarrollo"; nunca entra a GitLab. El resumen se genera con una extensión corporativa del preset, para que las 20 células lo hagan igual.
- **Spec un sprint adelante:** las specs de las historias del próximo sprint se escriben y aprueban durante el sprint actual, así el sprint planning parte con specs aprobadas.
- **Cambios del PO después de aprobar:** se aplica la regla de oro; si cambia el comportamiento, se actualiza la spec antes que el código.

**Copilot leyendo Jira:** el servidor MCP de Atlassian (Rovo MCP Server) permite que Copilot en VS Code lea, busque y comente historias, con OAuth y los permisos de cada usuario. Funciona solo con Jira Cloud y requiere que la política de MCP de Copilot lo permita. Con Jira Data Center, se pega el texto de la historia en el prompt.

```
/speckit-specify Usa la historia WCAP-104 de Jira como entrada.
Sus criterios de aceptación son los escenarios de la spec.
Agrega "Jira: WCAP-104" al encabezado.
```

Fuentes: [GitLab Docs: Jira issue management](https://docs.gitlab.com/integration/jira/issues) · [Atlassian: Getting started with the Rovo MCP Server](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/)

### Tipos de pedido: FUID, FDT y MAU

El PO solo puede abrir tres tipos de pedido a una célula, siempre como **épica** de Jira sobre una funcionalidad nueva o existente. Toda épica se divide en historias, y cada tipo tiene su proceso, su rama y sus pruebas.

| Épica | Qué es | Proceso de cada historia | Rama (clave de la historia) | E2E |
| --- | --- | --- | --- | --- |
| FUID (Ficha Única de Ingreso de la Demanda) | Funcionalidad completa | Camino 1: flujo SDD completo, una spec nueva por capacidad | `feature/NNN-nombre` | Tests nuevos ui y api por escenario |
| FDT | Cambio puntual sobre una funcionalidad existente: actualizar un endpoint, migrar la versión de Node | Camino 2: extensión `fdt` y regla de oro sobre la spec vigente | `feature/fdt-<clave>-<nombre>` | Ajuste de los tests afectados, o regresión completa si es técnico |
| MAU | Corrección de un incidente en producción | Camino 3: extensión `bug` (assess, fix, test) | `feature/mau-<clave>-<nombre>` | Test que reproduce el incidente y regresión de la spec |

Ejemplos del tablero WCAP (Hades; números ilustrativos): épica FUID WCAP-100 `Pago con autorización - Botón Pago Genérico`; épica FDT WCAP-210 `Migración Node 24 - Botón Pago Genérico`, con la historia WCAP-211; épica MAU WCAP-300 `Autorización con monto cero - Botón Pago Genérico`, con la historia WCAP-301.

- **El tipo lo decide el PO al abrir la épica en Jira;** la célula no tiene que adivinar el camino, y cada historia hereda el tipo de su épica.
- **Si al evaluar un FDT resulta ser una funcionalidad nueva,** la célula lo devuelve al PO para que lo abra como FUID.
- **MAU es solo para producción.** Los defectos que aparecen durante un FUID o un FDT se corrigen dentro de ese mismo pedido.
- **La clave de la historia** (por ejemplo `WCAP-211`, no la de su épica WCAP-210) va en la rama de FDT y MAU, en el título del MR y en los tags de los tests.
- **La funcionalidad** hoy se reconoce por el título de la épica (`Migración Node 24 - Nóminas MTN`). En el repo de la célula es la carpeta `funcionalidades/<funcionalidad>/` donde está la historia.

**Flujo en Jira por tipo:**

| Pedido | Estados |
| --- | --- |
| FUID | Cada historia de la épica: Refinada → Spec en revisión → Lista para desarrollo → En desarrollo → En integración → En certificación QA → Lista para producción → Hecha (con el pase de su versión). La épica se cierra cuando todas sus historias están en Hecha |
| FDT | Cada historia de la épica: Refinada → En desarrollo → En integración → En certificación QA → Lista para producción → Hecha (con el pase de su versión). Si cambia un comportamiento, pasa antes por "Spec en revisión" con el resumen del cambio |
| MAU | Cada historia de la épica: Reportada → En diagnóstico → En corrección → Verificada (OK de QA) → En producción (con su versión certificada por performance y ethical hacking) → Cerrada con causa raíz |
| Versión del pase | Abierta → Certificación QA de la versión → Performance → Ethical hacking → Pase → Liberada. Todo en el ambiente de QA |
| Defecto de certificación (QA, performance o ethical hacking) | Abierto → En análisis → En corrección → En certificación (del área que lo abrió) → Cerrado. También puede cerrarse sin código: spec actualizada por el PO, caso o plan de prueba ajustado o problema de ambiente |

**Ruta rápida para MAU (propuesta):** antes del pase corren el test que reproduce el incidente y el E2E de la spec afectada, y QA verifica la corrección; performance y ethical hacking también dan su OK (ver puntos abiertos sobre una versión reducida para MAU urgente); la suite funcional completa corre en la siguiente corrida nocturna. La gerencia define si acepta ese riesgo.

#### Cómo se divide una épica

Toda épica se divide en historias. En una épica FUID, cada pantalla o capacidad que se puede probar por separado es una historia con su propia spec. En una épica FDT o MAU, las historias son los cambios o correcciones (normalmente una) y trabajan sobre la spec existente de la funcionalidad.

| Jira | Spec Kit | Qué entrega |
| --- | --- | --- |
| Épica FUID WCAP-100 · Pago con autorización - Botón Pago Genérico | `impacto.md` de la épica en `celula-hades/funcionalidades/boton-pago-generico/` | Objetivo y criterios generales del PO |
| Historia WCAP-101 · Base del flujo (habilitadora) | Spec 001 | Configuración del stepper, navegación, estado compartido y contratos |
| Historia WCAP-102 · Selección de cuenta de cargo | Spec 002 | Ver las cuentas disponibles y elegir una |
| Historia WCAP-103 · Resumen del pago | Spec 003 | Ver el pago completo antes de autorizar |
| Historia WCAP-104 · Autorización | Spec 004 | Autorizar, con sus validaciones |
| Historia WCAP-105 · Comprobante | Spec 005 | Mostrar y descargar el comprobante |

- **Una historia debe poder demostrarse y probarse en E2E por sí sola.** Por eso ver las cuentas y elegir una van juntos: elegir no se prueba sin ver la lista. Si la selección es compleja, se corta como "cuenta con selección básica" y luego "filtros de cuentas", para que cada parte siga siendo demostrable.
- **La spec 001 es una historia habilitadora.** No es una pantalla, pero las demás dependen de ella. La propone la célula en el refinamiento y el PO la acepta dentro de la épica.
- **Quién crea las historias:** el PO abre la épica con los criterios generales; en el refinamiento con la célula se divide en historias, que crea el PO o el líder técnico. El PO aprueba la división.
- **Cada historia** de un FUID tiene su spec en la carpeta de la funcionalidad del repo de la célula, su rama `feature/NNN-nombre` en cada repo de capa que toca y sus tests con `@spec-NNN` y la clave de la historia.

## Parte III · Repos de la célula

Qué repos tiene una célula, cómo se organizan por funcionalidad y quién mantiene cada cosa.

### Repos de la célula

Cada célula es dueña de todos sus repos: la app y el BFF de cada funcionalidad, las API y los MS (propios o compartidos entre funcionalidades) y un repo de la célula con las specs, los contratos y los E2E de todas sus funcionalidades.

Ejemplo de la célula Hades: Botón Pago Genérico, Autorizar Otros Comercios y Consultar Otros Comercios tienen cada una su app y su BFF, y comparten `botonpago-api` y `botonpago-ms`. Los nombres de repo no siguen una convención fija (`boton-pago-generico-bff`, `boton-pago-generico-nwe-app`, `btpgconsult-generic-app`, `btnconsulta-bff`), así que el estándar no los deduce: cada funcionalidad los declara en su workspace.

&#91;embedded content: repos por dominio · central, contratos, 4 capas, despliegue\]

Los cuatro repos de capa trabajan en paralelo contra los contratos aprobados y despliegan en orden, de abajo hacia arriba.

- **Repo de la célula `celula-<célula>`:** uno por célula; su líder técnico es el maintainer. Tiene una carpeta por funcionalidad, `funcionalidades/<funcionalidad>/`, con `jira/` (Jira simulado en el piloto), `specs/NNN-nombre/` (un `spec.md` por historia, con los criterios de Jira más estados, reglas y aclaraciones, y su `impacto.md`), `contracts/<repo>/` con los contratos de sus servicios propios, `e2e/NNN-nombre/` con sus tests Playwright y `<funcionalidad>.code-workspace`, que declara sus repos.
- **Servicios compartidos:** los contratos de una API o un MS que usan varias funcionalidades van en `servicios/<repo>/contracts/` (`servicios/botonpago-ms/contracts/`). No tienen specs ni E2E propios: cada historia que los toca tiene su spec en la funcionalidad que la pidió y se prueba a través del BFF de esa funcionalidad. Aquí no se ejecutan `plan`, `tasks` ni `implement`.
- **Numeración única en la célula:** el número de spec no se repite entre funcionalidades (`ci/siguiente-spec.sh`). Así las ramas `feature/NNN-*`, los tags `@spec-NNN` y las carpetas no chocan dentro del mismo repo ni en los repos compartidos, y cada repo de capa usa el mismo número.
- **Spec Kit en la raíz del repo de la célula:** un solo proyecto Spec Kit. La spec va en la carpeta de la funcionalidad con `SPECIFY_FEATURE_DIRECTORY=funcionalidades/<funcionalidad>/specs/NNN-nombre`, que Spec Kit 1.x acepta y guarda en `.specify/feature.json` para los comandos siguientes. La carpeta `specs/` de la raíz no se usa.
- **Una historia, una funcionalidad:** la rama de una historia en el repo de la célula solo cambia `funcionalidades/<funcionalidad>/` (control `[funcionalidad]` de `ci/sdd-checks.sh`).
- **Contratos versionados:** se publican con tag por funcionalidad (`boton-pago-generico/contracts-v1.0.0`) o por servicio compartido (`servicios/botonpago-ms/contracts-v1.0.0`), y los repos de capa consumen una versión fija. Un contrato solo lo cambia su dueño; un cambio incompatible es versión mayor. Un contrato compartido afecta a todas las funcionalidades que lo usan.
- **Repos de capa (MS, API, BFF, app):** se instalan con su funcionalidad (`capa hades/boton-pago-generico`) o, si son compartidos, solo con la célula (`capa hades`). Cada uno corre su propio flujo, con `/speckit-specify` haciendo referencia a la spec de la historia y al contrato que cumple.
- **Mismo identificador en todos:** rama `feature/004-autorizacion` en todos los repos de la célula y la clave de Jira al inicio del título de cada MR.
- **Despliegue de abajo hacia arriba:** MS, API, BFF y app, cada capa compatible con la anterior en producción; la app sale detrás de un feature flag.

### Propiedad, workspace e instrucciones de Copilot

El PO trabaja solo en Jira; cada célula mantiene todos sus repos, y el desarrollador abre el workspace de la funcionalidad: sus repos de capa (propios y compartidos) y el repo de la célula. El resto (preset, design system Arándano, instrucciones de organización) llega empaquetado.

#### Qué se sube a cada lugar

| Dónde | Quién lo mantiene | Qué se sube | Qué no se sube |
| --- | --- | --- | --- |
| Jira | PO | Historia, criterios Dado / Cuando / Entonces, respuestas a dudas, aprobación | Nada técnico |
| `celula-<célula>` | Célula dueña; su líder técnico es maintainer | Por funcionalidad: `spec.md` por historia con la clave, `impacto.md`, contratos de sus servicios propios, tests Playwright con `@spec-NNN` y `@WCAP-104`, workspace. En `servicios/`: contratos de los API y MS compartidos | Planes técnicos y código de la aplicación |
| Repo de capa | Célula dueña | Spec técnica, `plan.md`, `tasks.md`, código, tests unitarios y planes JMeter | La spec de la historia (se referencia, no se copia) |
| `sdd-plataforma` | Equipo de plataforma | Preset, extensiones, controles de CI, plantillas de MR, scripts `sdd-instalar` y `sdd-abrir` | Specs o contratos de las células |
| `sdd-dev-process` | Equipo de plataforma; las subgerencias completan sus arquetipos | Agentes, skills de proceso y de stack, hooks, instrucciones, knowledge, catálogo de arquetipos | Specs, contratos o código de las células |

#### Workspace del desarrollador

Como las células son full-stack, para una historia el desarrollador abre los repos de capa de la funcionalidad (app, BFF y los API y MS que usa, propios o compartidos) y el repo de la célula (specs, contratos y E2E). Cada funcionalidad guarda su workspace en su carpeta del repo de la célula, y ese workspace es la declaración de sus repos: `sdd-abrir`, `/speckit-sdd-impacto` y los agentes leen de ahí qué repos existen. Así, para que todos abran lo mismo; `sdd-abrir` lo elige según dónde está la historia. Los repos se clonan uno al lado del otro. Con cinco carpetas, las skills `speckit-*` aparecen en cada repo: en el piloto hay que verificar que Copilot ejecute cada comando sobre el repo correcto.

```json
// celula-hades/funcionalidades/boton-pago-generico/boton-pago-generico.code-workspace
{
  "folders": [
    { "name": "App · boton-pago-generico-app", "path": "../../../boton-pago-generico-app" },
    { "name": "BFF · boton-pago-generico-bff", "path": "../../../boton-pago-generico-bff" },
    { "name": "API · botonpago-api (compartido)", "path": "../../../botonpago-api" },
    { "name": "MS · botonpago-ms (compartido)", "path": "../../../botonpago-ms" },
    { "name": "Célula (specs y E2E)", "path": "../.." }
  ]
}
```

#### Dónde van las instrucciones de Copilot

| Archivo | Dónde vive | Cuándo aplica | Qué contiene |
| --- | --- | --- | --- |
| Instrucciones de organización | Configuración de la organización de GitHub con las licencias | En todas las sesiones, si el ajuste está activo en VS Code | Reglas generales: idioma, seguridad, no exponer secretos |
| `.github/copilot-instructions.md` | Cada repo, generado por el template del equipo | Siempre en ese repo | Qué capa es, stack, comandos de build y test, dónde están los contratos y que no se editan ahí |
| `.github/instructions/*.instructions.md` | Cada repo, desde el template | Según su patrón `applyTo` | Reglas por tipo de archivo: componentes, controllers, tests |
| `.specify/memory/constitution.md` | Cada repo, base del preset más ajustes de la célula | Cuando corren los comandos de Spec Kit | Principios SDD |
| `.github/agents/` y `.github/skills/` | Cada repo, desde el preset y `sdd-dev-process` | Al elegir un agente o invocar una skill | Agentes por fase; skills `speckit-*`, de proceso (`sdd-clasificar`, `sdd-tdd`, `sdd-seguridad`, `sdd-memoria`), la del stack del arquetipo y `arandano` |
| `.github/instructions/sdd-dev-process.instructions.md` y `arquetipo.instructions.md` | Cada repo, desde `sdd-dev-process` | Siempre (`applyTo: "**"`) | Comportamiento de los agentes, evidencia, seguridad base, git; arquetipo, comandos y skill del stack |
| `.github/knowledge/` | Cada repo, desde `sdd-dev-process` | Cuando un agente planifica, implementa o revisa | Guía de flujos, glosario, arquitectura, calidad de código y el arquetipo del repo |

- `copilot-instructions.md` apunta a la constitution, no la copia.
- Spec Kit agrega el stack y los cambios recientes a `copilot-instructions.md` durante el plan; lo que escribe el equipo va en la sección de adiciones manuales, que Spec Kit preserva.
- El repo de la célula lleva instrucciones cortas, solo sobre sí mismo (más `e2e.instructions.md` para `funcionalidades/*/e2e/**`), para no contradecir las del repo de capa. Cómo combina VS Code las instrucciones de varias carpetas de un workspace se verifica en el piloto.

#### Preset, npm o plugin

- **El estándar SDD va como preset de Spec Kit** en `sdd-plataforma`, instalado con `specify preset add` e incluido en los templates. Funciona en cualquier stack y deja las reglas versionadas dentro de cada repo.
- **npm, solo para código que se ejecuta:** el design system Arándano (`@arandano`, con su documentación) y, si varias células repiten helpers de E2E, un paquete opcional `@empresa/e2e-kit` con login y datos de prueba para Playwright.
- **La forma de trabajo con agentes va en `sdd-dev-process`**, como archivos en cada repo (`.github/agents`, `.github/skills`, `.github/instructions`, `.github/knowledge`), instalados con `scripts/instalar.sh <repo> <arquetipo>` después de `sdd-instalar.sh`. Quedan versionados y revisables por MR igual que el preset.
- **Plugin de Copilot: descartado.** En VS Code un plugin solo garantiza skills y MCP; los agentes, hooks y commands dependen de cada herramienta, no trae instrucciones siempre cargadas y su marketplace privado vive en GitHub, no en GitLab. Además, una regla que vive en la máquina del desarrollador no la ve CI.
- **Agentes de organización de GitHub (`.github-private/agents/`): solo para distribuir.** Se muestran solos en VS Code, pero no traen las skills, plantillas ni scripts que referencian y cambian para todos a la vez, sin versión por repo.

Fuentes: [VS Code: Use custom instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions.md) · [DeepWiki: Spec Kit agent context management](https://deepwiki.com/Linfee/spec-kit-cn/6.2-agent-context-management)

## Parte IV · Forma de trabajo con agentes

Cómo se lleva un pedido dentro de un repo de capa con sdd-dev-process: qué agente actúa, qué deja en el repo y dónde se detiene.

### Modelos y agentes

Qué modelos existen se impone desde la organización de Copilot; qué modelo usa cada fase se estandariza en el repo; qué se usó realmente solo se puede trazar, no verificar.

| Nivel | Qué controla | Mecanismo | Tipo de control |
| --- | --- | --- | --- |
| Organización | Modelos disponibles, modelos y funciones nuevas, servidores MCP | Políticas de Copilot Business o Enterprise en GitHub | Imposición |
| Repo | Modelo, herramientas y traspaso por fase | Agentes `.github/agents/*.agent.md` distribuidos por `sdd-dev-process` | Estandarización |
| MR y specs | Qué agente y modelo se usó en cada fase | Campo en el template de MR y metadatos en `spec.md` y `plan.md` | Trazabilidad |

**Agentes por fase.** Las skills de Spec Kit llevan el proceso; los agentes corporativos fijan modelo, herramientas y handoffs:

| Agente | Fases | Modelo | Herramientas |
| --- | --- | --- | --- |
| SDD Orquestador | Punto de entrada: clasifica el pedido, detecta el paso leyendo el repo y deriva | El de mejor razonamiento aprobado | Lectura y terminal de solo lectura; no edita; memoria (odin-memory) |
| SDD Planner | specify, clarify, plan, tasks, analyze; `bug-assess` (MAU) y `fdt-assess` (FDT) | El de mejor razonamiento aprobado | Lectura, edición de specs y terminal para los scripts de Spec Kit; memoria (odin-memory) |
| SDD Tester | Tareas `[tester]`, test que reproduce un MAU, ajuste de tests de un FDT | Uno aprobado para tests | Edición solo de tests; memoria (odin-memory) |
| SDD Implementer | implement y converge, por fases; `bug-fix`, `bug-test`, `fdt-apply`, `fdt-test` | Uno equilibrado y más rápido | Completas; hook `tests-intactos` le bloquea los tests; memoria (odin-memory) |
| SDD Reviewer | Revisión antes del MR | Distinto al que implementó | Solo lectura; memoria (odin-memory) |
| SDD Seguridad | Revisión de superficie sensible (auth, datos personales, pagos, endpoint público con efecto) | Distinto al que implementó | Lectura, terminal de solo lectura y escritura de `seguridad.md` (hook `solo-informe`); memoria (odin-memory) |

El `model` de un agente es una preferencia: el desarrollador puede cambiarlo en el selector. Por eso la lista de modelos aprobados se cierra en la política de la organización, y `.github/agents/` solo cambia por MR revisado por el equipo de plataforma. Cada repo usa una sola integración de Spec Kit (`--integration copilot`), porque presets y extensiones se registran solo para la integración activa.

#### Forma de trabajo con agentes (sdd-dev-process)

Toma las ideas del harness ai-dev-process (orquestador, niveles de ceremonia, TDD, seguridad, evidencia) y las lleva a Copilot, Spec Kit y GitLab CE. El detalle está en `sdd-dev-process/README.md` y en la guía `knowledge/guias/flujos-sdd-dev-process.html`.

- **Todo pedido empieza con el SDD Orquestador** y la clave de Jira. El Orquestador lee el repo (carpetas de Spec Kit, `tasks.md`, reportes de MAU y FDT, commits) para saber en qué paso va; no hay archivo de progreso aparte. Se invoca con `@SDD Orquestador WCAP-104 empezar` (o `¿en qué paso vamos?`) y la respuesta empieza con una línea de estado: `🧭 FUID WCAP-104 (épica WCAP-100) · boton-pago-generico · Paso 5 de 10 · Tests de la fase 2 | sigue: SDD Tester | arquetipo: Personas/web/nest`.
- **Los handoffs son las pausas.** Cada agente termina con un botón hacia el siguiente (`send: false`) y el desarrollador decide cuándo seguir.
- **Niveles N0, N1 y N2** (skill `sdd-clasificar`): cuánta ceremonia lleva un pedido según tamaño y riesgo. Un N0 nunca toca superficie sensible.
- **Superficie sensible**: auth, datos personales, pagos y dinero, endpoint público nuevo con efecto, secretos, despliegue, acceso a datos. Con ella, SDD Seguridad revisa antes del MR y deja `seguridad.md` con veredicto. En Personas, Empresas y Adquirencia casi todo lo que mueve dinero o identifica a un cliente cuenta.
- **Skills de stack**, una por repo según su arquetipo: `angular-developer` (oficial de Angular), `flutter` (agrupa las oficiales de Flutter y Dart), `nestjs-best-practices` (comunidad, la más instalada) y `node-express` (propia, basada en las guías oficiales, porque no existe una oficial). Las de terceros entran con commit fijado y revisión del diff al actualizarlas.
- **Knowledge** en `.github/knowledge/`: guía de flujos, glosario, arquitectura de la gerencia, calidad de código y el arquetipo del repo. Prioridad de las fuentes: knowledge del arquetipo, después la skill y después la documentación oficial.
- **Memoria entre chats** con **odin-memory**, el servidor MCP de memoria persistente de la gerencia (herramientas `mem_*`, SQLite local en `~/.odin-memory/` de cada desarrollador). Cada agente lee `sdd/<CLAVE>/…` al empezar y guarda su parte antes del handoff: el Orquestador el estado, el Planner las decisiones con su porqué, el Tester los tests en rojo, el Implementer el avance y las causas raíz, el Reviewer los bloqueantes y SDD Seguridad solo su veredicto (skill `sdd-memoria`).
  - **El repo manda:** sigue sin haber archivo de progreso aparte; la memoria agrega el porqué y lo pendiente, y si no coincide con el repo, vale el repo.
  - **Nunca se guardan** secretos, tokens, RUT, tarjetas, montos o datos de clientes, datos de producción ni el detalle de un hallazgo de seguridad.
  - **Opcional y local en el piloto:** sin odin-memory el proceso sigue igual; la memoria no se versiona ni se comparte en la célula.
  - **Instalación, una vez por máquina:** `npm install -g odin-memory` desde el Nexus y `odin setup vscode-copilot` (MCP, protocolo de memoria y hooks en el perfil de usuario de VS Code).

## Parte V · Caminos de trabajo

El recorrido de cada tipo de pedido, paso a paso.

### Camino 1: FUID, funcionalidad completa

Una épica se divide en una spec base y una spec por capacidad; los contratos se acuerdan primero y luego cada capa implementa en paralelo.

1. **Épica FUID e historias en Jira:** el PO abre la épica FUID con la funcionalidad en el título (por ejemplo "Pago con autorización - Botón Pago Genérico") y una historia por capacidad, con criterios Dado / Cuando / Entonces. Las historias llegan en estado "Refinada".
2. **Taller inicial de la célula (1 a 2 días):** se revisa la constitution y se hace en conjunto la spec 001 base: configuración del stepper, reglas de navegación, estado compartido y contratos.
3. **Specs por capacidad en el repo de la célula:** en `funcionalidades/<funcionalidad>/specs/`, una por historia (002 cuenta de cargo, 003 resumen, 004 autorización, 005 comprobante) con `specify` (desde la historia de Jira) → `clarify` → plan de sistema → `impacto.md`. El PO aprueba el resumen en Jira y se publican los contratos v1.
4. **Spec técnica en cada repo de capa**, en la rama `feature/NNN-nombre`: `specify` (referenciando la spec de la historia y el contrato) → `clarify` → `plan` → `tasks` → `analyze` → `implement` por fases → `converge`. En BFF, API y MS, `tasks.md` incluye la fase del plan JMeter (`perf/NNN-nombre/`); la última tarea es escribir o actualizar los casos E2E de la spec.
5. **Un MR por repo**, con la clave de Jira al inicio del título: CI valida specs, contratos y tests; un maintainer revisa y hace merge.
6. **Despliegue a integración** de cada capa con el feature flag de la funcionalidad.
7. **E2E del desarrollo:** con todas las capas en integración, corre la suite E2E de la spec. La spec se cierra solo con E2E verde.
8. **Certificación de QA de la historia:** QA certifica la historia en Jira. Si encuentra algo, abre un defecto enlazado (ver "Certificación y defectos"). Con el OK, la historia queda en "Lista para producción", dentro de la versión del próximo pase.
9. **Pruebas de performance de la versión:** en el ambiente de QA, el área de performance ejecuta los planes JMeter de BFF, API y MS de toda la versión, con la carga y los umbrales que define el arquitecto.
10. **Ethical hacking de la versión:** en el ambiente de QA, el área de ethical hacking prueba la seguridad de la versión completa, con los `seguridad.md` como insumo.
11. **Funcionales completas y pase a producción:** la suite funcional de la funcionalidad (y de las que comparten un API o MS que cambió) corre antes del pase; con los OK de QA, performance y ethical hacking y todo verde, despliegue manual en orden MS → API → BFF → app y luego se enciende el flag.
12. **Cierre:** el PO mueve la historia a "Hecha"; demo y retro.

**Regla de navegación:** las flechas entre pantallas no son specs. Viven en la spec 001; cada pantalla solo declara qué recibe y qué entrega.

**Componentes comunes como el stepper:** viven en la librería compartida, con su propia spec y versiones. La spec 001 de cada épica FUID solo lo configura (pasos y cuándo se completan).

**Reparto en una célula de 4 full-stack:** cada dev toma una historia del FUID y la lleva por las cuatro capas, con los agentes Tester e Implementer. El líder técnico toma la base y la historia más liviana, porque además revisa los MR del resto.

| Persona | Historia | Fase 1 · base | Fase 2 · paralelo |
| --- | --- | --- | --- |
| Dev 1 · líder técnico | WCAP-101 base y WCAP-105 comprobante | Implementa la base (001) en las cuatro capas | Comprobante (005) y revisión de los MR |
| Dev 2 | WCAP-102 cuenta de cargo | Specs técnicas y tests de 002, contra mocks | Implementa 002 en MS, API, BFF y app |
| Dev 3 | WCAP-103 resumen del pago | Specs técnicas y tests de 003, contra mocks | Implementa 003 en las cuatro capas |
| Dev 4 | WCAP-104 autorización | Specs técnicas y tests de 004; la de mayor riesgo va primero | Implementa 004 en las cuatro capas |

Como cada dev lleva su historia por las cuatro capas, los cuatro trabajan en los mismos repos al mismo tiempo, cada uno en su rama `feature/NNN-nombre`. Los conflictos se reducen porque cada historia toca archivos distintos y la base (001) se mergea primero. Un cambio de contrato durante la implementación se hace donde vive el contrato (carpeta `contracts/` de la funcionalidad, o `servicios/<repo>/contracts/` si es un API o MS compartido, en el repo de la célula), con su propio MR, nunca dentro de la spec de una pantalla.

**Reparto con varias funcionalidades en curso (ejemplo de Hades):** con las tres funcionalidades del botón de pago abiertas a la vez, cada dev sigue llevando su historia por todas las capas.

| Persona | Funcionalidad | Foco |
| --- | --- | --- |
| Dev 1 · líder técnico | Botón Pago Genérico | Base 001, revisión de los MR de la célula y de los contratos de `servicios/` |
| Dev 2 | Botón Pago Genérico | Capacidades del genérico (002 a 005) |
| Dev 3 | Autorizar Otros Comercios | Sus historias, contra mocks de `botonpago-api` y `botonpago-ms` hasta que se mergee el contrato |
| Dev 4 | Consultar Otros Comercios | Sus historias, con el mismo criterio |

Los cuatro pueden tener ramas abiertas en `botonpago-ms` al mismo tiempo; se coordinan en el daily. En `celula-hades` cada rama toca solo la carpeta de su funcionalidad. Una ventana de VS Code por historia (`sdd-abrir`); si alguien necesita dos historias a la vez en el repo de la célula, usa un `git worktree` por rama.

### Design system Arándano

El repo de Arándano, el design system, es la fuente de verdad de los componentes de UI. Copilot lee su documentación en la versión que la app web tiene instalada, y el plan de la app web deja escrito qué componente cubre cada elemento de pantalla.

| Paso | Qué se hace con Arándano |
| --- | --- |
| `specify` | No menciona componentes. Describe pantallas y estados (cargando, vacío, error) y enlaza el diseño. |
| `plan` de la app web | Sección obligatoria "Componentes de Arándano": elemento, componente y variante. Lo que falta va a "Brechas". |
| `analyze` | Ningún componente propio sin una brecha registrada. |
| `tasks` | Cada tarea de pantalla cita sus componentes; cada brecha genera la tarea de pedirlo a Arándano. |
| `implement` | Copilot lee la documentación del componente antes de usarlo. |
| MR y CI | Lint que prohíbe otras librerías de UI e imports internos de Arándano; versión fijada en `package.json`. |

#### Cómo llega la documentación a Copilot

1. **Dentro del paquete (recomendado):** el paquete de Arándano publica su carpeta `docs/` y un `catalogo.md`. Así la documentación que lee Copilot es siempre la de la versión instalada.
2. **Skill corporativa `arandano`** en el preset: le dice a Copilot cuándo y dónde leer esa documentación.
3. **Workspace con el repo de Arándano:** útil para el equipo de Arándano; para los equipos de app web tiene el riesgo de leer documentación de otra versión.
4. **A futuro, un servidor MCP de documentación:** sujeto a la allowlist de MCP de la organización.

El `catalogo.md` se genera en el CI de Arándano a partir de su documentación. Lista cada componente con cuándo usarlo, cuándo no, sus props principales y el archivo de su documentación. Es lo primero que lee Copilot, para no recorrer toda la carpeta.

`.github/skills/arandano/SKILL.md` (en el preset, para los repos de app web):

```markdown
---
name: arandano
description: Usar al planificar o implementar pantallas de la app web. Indica qué componente de Arándano, el design system, usar y dónde está su documentación.
---
1. Lee node_modules/@arandano/docs/catalogo.md para elegir componentes. Es la documentación de la versión instalada.
2. Antes de usar un componente, lee su archivo en node_modules/@arandano/docs/componentes/.
3. En plan.md, llena la sección "Componentes de Arándano": elemento de pantalla, componente y variante.
4. Si ningún componente sirve, no crees uno: regístralo en "Brechas" con lo que necesita la pantalla.
5. No importes componentes de otra librería de UI ni copies código fuente de Arándano.
```

Sección de la plantilla de plan para la app web (en el preset):

```markdown
## Componentes de Arándano (@arandano 4.2.0)
| Elemento de pantalla | Componente | Variante o props | Documentación |
| --- | --- | --- | --- |
| Pasos del flujo | Stepper | horizontal, 4 pasos | componentes/stepper.md |
| Monto a autorizar | CurrencyInput | moneda CLP | componentes/currency-input.md |

## Brechas
| Necesidad | Por qué no sirve lo existente | Issue en Arándano |
| --- | --- | --- |
| Resumen descargable del comprobante | No existe un componente de documento | arandano#123 |
```

Regla de lint en la app web (`eslint.config.js`):

```js
rules: {
  'no-restricted-imports': ['error', { patterns: [
    { group: ['@mui/*', 'antd'], message: 'Usa los componentes de @arandano' },
    { group: ['@arandano/src/*'], message: 'Importa solo la API pública de Arándano' },
  ] }],
},
```

Nombres de paquete, versiones y rutas son de ejemplo; el nombre real del paquete npm de Arándano se confirma con su equipo.

#### Brechas y versiones

- **Brecha:** la app web abre un issue en el repo de Arándano. Arándano también usa Spec Kit: la brecha se vuelve una spec propia, se implementa, se publica una versión y la app web la adopta.
- **Mientras llega la versión:** conviene definir si se permite un componente temporal (por ejemplo, solo en `src/componentes-temporales/` con el issue enlazado y fecha de retiro) o si la pantalla espera.
- **Subir de versión de Arándano:** se trata como cambio sin comportamiento, salvo que cambie algo visible. En ambos casos corre la regresión UI de las specs afectadas.
- **El stepper** de la spec 001 es un componente de Arándano; la spec 001 solo lo configura.

### Caminos 2 y 3: FDT y MAU

Los FDT y los MAU no pasan por el flujo completo: los FDT usan la extensión corporativa `fdt` junto con la regla de oro, y los MAU la extensión `bug` de Spec Kit.

| Tipo de FDT | Ejemplo | Proceso |
| --- | --- | --- |
| Toca un contrato | Agregar un campo en la respuesta del BFF | El dueño del contrato primero: MR en el repo de la célula (`funcionalidades/<funcionalidad>/contracts/` o, si es compartido, `servicios/<repo>/contracts/`), y nueva versión |
| Cambia comportamiento | Endurecer la validación de un endpoint | Actualizar `spec.md` en "Cambios posteriores", resumen al PO en Jira e implementar directo |
| Solo técnico | Migrar Node 24 a 26, actualizar librerías | Sin cambio de spec; regresión completa de la funcionalidad (de todas las que usan el repo, si es compartido) |
| Necesita un componente nuevo | La pantalla pide algo que Arándano no tiene | Brecha: issue y spec en el repo de Arándano |

**FDT: extensión corporativa `fdt`.** Spec Kit no trae un proceso para cambios puntuales. El equipo de plataforma lo mantiene en `sdd-plataforma` con el mismo patrón de la extensión `bug`, y los reportes quedan en `.specify/fdt/<slug>/`:

```
/speckit-fdt-assess "WCAP-211: migrar el BFF de Node 24 a Node 26" slug=node-26
/speckit-fdt-apply slug=node-26
/speckit-fdt-test slug=node-26
```

- `fdt-assess` no toca código: clasifica el cambio con la regla de oro (contrato, comportamiento o técnico), lista las specs y contratos afectados y define qué pruebas corren.
- `fdt-apply` aplica el cambio y registra cualquier desvío del alcance evaluado.
- `fdt-test` corre las pruebas definidas y deja el veredicto.

Ejemplos:

- **Actualizar a versión 2 (épica FDT WCAP-200, historia WCAP-201):** el assess detecta un cambio incompatible, así que es versión mayor. Se publica el contrato v2 en el repo de la célula, conviviendo con v1, se actualiza `spec.md`, se envía el resumen al PO en Jira y se avisa a los consumidores de v1. Se escriben tests api para v2, y los de v1 siguen corriendo mientras ambas versiones convivan.
- **Migrar Node 24 a 26 (épica FDT WCAP-210, historia WCAP-211):** el assess lo clasifica como técnico. Rama `feature/fdt-WCAP-211-node-26` (clave de la historia), cambio de imagen base, `package.json` y lockfile, y regresión completa de la funcionalidad, porque el runtime afecta a todo el repo. El script `specs-tocadas.sh` debe devolver todas las specs cuando cambian esos archivos.

**MAU: extensión `bug` de Spec Kit.** Se instala una vez por repo (`specify extension add bug`, incluida en el template). En el chat de Copilot:

```
/speckit-bug-assess "<síntoma, pasos y comportamiento esperado>" slug=<nombre-corto>
/speckit-bug-fix slug=<nombre-corto>
/speckit-bug-test slug=<nombre-corto>
```

`assess` diagnostica sin tocar código; `fix` es la única etapa que edita y registra cualquier desvío; `test` vuelve a reproducir y deja un veredicto (verificado, parcial o fallido). Los reportes quedan en `.specify/bugs/<slug>/`. Si el assess muestra que el origen está en otra capa, se abre el bug en ese repo.

Cada historia de un MAU trabaja en una rama `feature/mau-<clave-historia>-<slug>`, para que el pipeline corra. Todo MAU agrega su caso de regresión, con el tag `@mau`, a la suite funcional de la funcionalidad, así el incidente no vuelve a aparecer. Al cerrar, la célula registra la causa raíz en Jira y, si el incidente reveló un escenario que faltaba en la spec, lo agrega a `spec.md` (regla de oro).

Como `Desarrollo-CI` es la rama que va a producción, la rama del MAU sale de `Desarrollo-CI` actualizada. Cualquier cambio sin certificar que esté ahí debe ir con su flag apagado; si no, el pase del MAU arrastraría trabajo sin certificar.

**Regla de oro.** La pregunta es: después de este cambio, ¿algún criterio de aceptación o regla de una spec quedaría falso o incompleto? Cualquier "sí" a estas señales cuenta como cambio de comportamiento:

- Cambia lo que el usuario ve, ingresa o puede hacer.
- Cambia una regla de negocio, una validación o un límite, aunque sea un valor de configuración.
- Cambia un dato que se guarda, se muestra o se envía.
- Cambia un contrato entre capas.

Cuando aplica, se edita `spec.md` directamente (no con `/speckit-specify`, que crea una feature nueva) y se registra en la sección fija "Cambios posteriores" de la plantilla, con fecha, issue y cambio. Para encontrar la spec afectada, el desarrollador le pide a Copilot que revise `specs/` y cite el criterio que cambia; a futuro, como extensión corporativa `/speckit-impacto`.

## Parte VI · Calidad, pruebas y pase

E2E, certificaciones y ramas: qué tiene que pasar para que un cambio llegue a producción.

### Pipeline y pruebas

Ningún desarrollo se da por terminado sin E2E verde, y ninguna versión llega a producción sin la suite funcional completa y los OK de QA, performance y ethical hacking.

| Etapa | Dónde corre | Cuándo | Qué valida | Si falla |
| --- | --- | --- | --- | --- |
| Validación SDD | Cada repo de capa | Cada push a `feature/*` | Specs presentes, regla de oro, veredicto de FDT y MAU | Bloquea el MR (la regla de oro solo avisa) |
| Build, unitarias y contrato | Cada repo de capa | Cada push a `feature/*` | El código y su lado del contrato | Bloquea el MR |
| Despliegue a QA | Cada repo de capa | Al hacer merge a `Desarrollo-CI` | La capa queda en QA con el flag de la funcionalidad | No corre el E2E |
| E2E del desarrollo | Repo de la célula, proyectos de la funcionalidad | Cuando todas las capas de la spec están en QA | Los escenarios de aceptación de la spec | La spec no se cierra |
| Certificación de QA por historia | QA, en Jira | Con el E2E de la spec en verde | La historia contra su spec | Defecto enlazado; la historia no pasa a "Lista para producción" |
| Funcionales completas | Repo de la célula, toda la funcionalidad (`ci/e2e.sh <funcionalidad>`; todas con `--todos`) | Antes de cada pase a producción; también cada noche | Toda la regresión de la funcionalidad | No hay pase a producción |
| Certificación de QA de la versión | QA, en Jira | Antes de cada pase | La versión de `Desarrollo-CI` que sale, con lo no certificado detrás de su flag | No hay pase a producción |
| Pruebas de performance de la versión | Área de performance, en el ambiente de QA, con los planes JMeter de BFF, API y MS | Después del OK de QA de la versión | Carga y umbrales que define el arquitecto, para todos los endpoints de la versión | No hay pase a producción |
| Ethical hacking de la versión | Área de ethical hacking, en el ambiente de QA | Después del OK de performance | Seguridad de la versión completa | No hay pase a producción (crítico y alto bloquean) |
| Despliegue a producción | Cada repo de capa | Job manual desde `Desarrollo-CI`, en orden MS → API → BFF → app | Que E2E y funcionales estén verdes y que QA, performance y ethical hacking hayan dado el OK | Se detiene el pase |
| Respaldo | Cada repo de capa | Después de un pase exitoso | `Desarrollo-CI` se integra a `master` y se etiqueta la versión | Se revisa antes del siguiente pase |

- **De la spec al test:** cada escenario de aceptación de `spec.md` (Dado / Cuando / Entonces) se convierte en un caso E2E con el número de la spec en su nombre, por ejemplo `004-autorizacion › monto sobre el límite`. Así se sabe qué criterio cubre cada test.
- **Tarea obligatoria:** el preset agrega al final de `tasks.md` la tarea de escribir o actualizar esos casos en `funcionalidades/<funcionalidad>/e2e/` del repo de la célula.
- **Disparo del E2E:** cada repo de capa, al desplegar en integración, lanza el pipeline del repo de la célula con su funcionalidad (en un API o MS compartido, la de la historia, o todas con `--todos`), las specs que tocó (según `specs/mapa.txt`) y la rama de tests del mismo nombre, mediante un token de disparo. La corrida nocturna de todas las funcionalidades usa pipeline schedules. Detalle en "E2E con Playwright".
- **Definición de terminado de una spec:** MR de todas las capas mergeados, E2E de la spec verde en integración, plan JMeter en BFF, API y MS (o "JMeter: no" con motivo), OK de QA, performance y ethical hacking sin defectos abiertos que bloqueen y suite funcional sin regresiones.
- **Constitution:** se agrega el principio "una spec está terminada solo con sus escenarios E2E verdes en integración".

#### Certificación y defectos

Antes de cada pase hay tres certificaciones en Jira, en este orden. **Sin los tres OK no hay pase.**

| Etapa | Quién | Qué certifica |
| --- | --- | --- |
| QA | QA (trabaja en Jira) | Cada historia contra su spec y, antes del pase, la versión completa |
| Performance | Área de performance | La versión completa: ejecuta los planes JMeter que entregan BFF, API y MS con la carga y los umbrales del arquitecto |
| Ethical hacking | Área de ethical hacking | La seguridad de la versión completa |

Performance y ethical hacking prueban **la versión completa** en el **ambiente de QA**: todas las historias del pase esperan juntas en "Lista para producción" hasta que la versión tiene los tres OK.

- **Casos desde la spec:** QA recibe en la historia el mismo resumen de `spec.md` que aprueba el PO y arma sus casos desde los escenarios Dado / Cuando / Entonces. Los casos que agregue y la spec no tenga son una señal de spec incompleta.
- **Un hallazgo es un defecto de Jira enlazado a la historia** ("bloquea a WCAP-104"), con su propia clave. No es un MAU: se corrige dentro del mismo pedido.
- **Se clasifica contra la spec** (SDD Orquestador, skill `sdd-clasificar`):

| El hallazgo es… | Qué se hace |
| --- | --- |
| El código no cumple la spec | Prove-It: test que lo reproduce (SDD Tester), corrección (SDD Implementer), revisión, MR y nueva certificación |
| La spec no lo dice | Regla de oro: decide el PO. Si lo acepta, primero se actualiza `spec.md` y después el código; si es alcance nuevo, va como otra historia o FDT |
| El caso de QA no calza con la spec aprobada | Gana la spec: se responde en el defecto con el escenario y QA ajusta su caso |
| Diferencia entre capas | El contrato manda: se corrige la capa que no lo cumple, o primero el contrato si está mal |
| Ambiente o datos | Sin cambio de código: se resuelve con quien opera QA y se vuelve a probar |
| Performance: el código no cumple el umbral | El SDD Implementer optimiza; el plan JMeter con su umbral es la prueba |
| Performance: el plan JMeter está mal | El SDD Tester corrige el plan; sin cambio de código |
| Ethical hacking: vulnerabilidad | Crítica y alta bloquean el pase. Corrección revisada por el SDD Seguridad; el control que faltaba entra a la checklist de `sdd-seguridad` |

- **Rama y MR:** `feature/NNN-<qa|perf|eh>-<CLAVE-DEFECTO>-<nombre>` desde `Desarrollo-CI`, con el número de la spec de la historia, así `validar-specs` encuentra la spec existente. Commits y título del MR con la clave del defecto.
- **Regresión:** el test que reproduce el hallazgo lleva `@spec-NNN` y la clave del defecto, y queda en la suite: lo que QA encontró a mano no vuelve.
- **Defecto que no bloquea:** el PO decide si la historia sale con el defecto registrado; la corrección pasa a un FDT.
- **Plan JMeter en BFF, API y MS:** cada spec que agrega o cambia endpoints lleva `perf/NNN-nombre/NNN-nombre.jmx` y `datos.csv`, escrito por el SDD Tester con la skill `sdd-jmeter`: parametrizado con propiedades (`-Jhost`, `-Jusuarios`, `-Jduracion`, `-Jumbral_ms`, `-Jtoken`), sin secretos y con aserciones del contrato. El dev lo corre en modo humo antes del MR; el área de performance lo corre en el ambiente de QA con la carga y los umbrales que define el **arquitecto**, que quedan en la sección "Rendimiento (JMeter)" de `plan.md`. La plantilla `.jmx` actual es provisional: se reemplaza por el template de la gerencia (versión de JMeter y headers obligatorios) cuando esté definido. `plan.md` declara `**JMeter**: sí | no` y el control `[jmeter]` de `ci/sdd-checks.sh` exige el plan cuando dice sí.
- **Medición:** defectos de QA, performance y ethical hacking por historia y su costo en tokens (por `jira.padre`), como señal de la calidad de la spec.

### E2E con Playwright

Un cambio solo de backend se prueba en E2E con el proyecto `api` de Playwright contra el BFF, sin navegador, y la UI de la spec corre como regresión.

El repo de la célula tiene dos proyectos de Playwright por funcionalidad, generados desde las carpetas `funcionalidades/<funcionalidad>/e2e/`:

- **`<funcionalidad>-ui`:** abre Chromium y recorre app → BFF → API → MS.
- **`<funcionalidad>-api`:** usa el cliente HTTP de Playwright (`request`) contra el BFF, con el mismo contrato que usa la app, y llega hasta el MS.

Cada funcionalidad tiene sus URLs (`BFF_URL_<FUNCIONALIDAD>`, `APP_URL_<FUNCIONALIDAD>`) y se corre aparte con `sh ci/e2e.sh <funcionalidad> ["<tags>"]`. Los API y MS compartidos no tienen E2E propio: se prueban a través del BFF de cada funcionalidad que los usa, y como la numeración es única en la célula, `sh ci/e2e.sh --todos "<tags>"` corre las specs que tocó un cambio compartido en todas las funcionalidades sin mezclar tests.

| Qué cambió | Proyecto `api` | Proyecto `ui` |
| --- | --- | --- |
| MS o API, con comportamiento | Test nuevo o ajustado | Regresión de la spec |
| MS, API o BFF, sin comportamiento | Regresión de la spec | Regresión de la spec |
| BFF, con comportamiento | Test nuevo o ajustado | Regresión de la spec |
| App | Regresión de la spec | Test nuevo o ajustado |

**Regla:** el test se escribe en la capa más externa que el cambio ya alcanza en integración. El MS no se prueba directo desde el E2E; eso lo cubren sus tests unitarios y de contrato.

**Convenciones:** tests en `funcionalidades/<funcionalidad>/e2e/NNN-nombre/`, archivos `*.ui.spec.ts` y `*.api.spec.ts`, tag `@spec-NNN` (más `@mau` en regresiones de MAU). Los tests nuevos se escriben en una rama del repo de la célula con el mismo nombre que la del repo de capa, y se corren local contra integración antes de pedir el merge.

#### Qué hace el desarrollador en cada caso

**1. FUID · spec 004 autorización**

1. Abre `feature/004-autorizacion` también en el repo de la célula.
2. Escribe un test por escenario de `spec.md`, en `*.ui.spec.ts` y `*.api.spec.ts`, con el tag `@spec-004`.
3. Los corre contra integración: `sh ci/e2e.sh boton-pago-generico "@spec-004"`.
4. Cuando la última capa llega a integración, su deploy corre el E2E sobre esa rama de tests. Con verde, se mergea la rama de tests.

**2. FDT solo backend, con comportamiento · monto máximo de 1M a 2M en el MS**

1. Actualiza `spec.md` de 004 en "Cambios posteriores".
2. Cambia el MS en `feature/004-monto-maximo`.
3. En el repo de la célula, misma rama: ajusta `monto.api.spec.ts` (1,5M responde 201; 2,1M responde 422). No escribe test de UI, salvo que la pantalla muestre el límite.
4. El deploy del MS corre `@spec-004`: el test api ajustado y la UI de 004 como regresión.

**3. FDT solo backend, sin comportamiento · refactor de `botonpago-ms` (compartido)**

1. Rama `feature/fdt-<clave-historia>-repositorio-cuentas` en `botonpago-ms` y etiqueta `sin-cambio-comportamiento` en el MR.
2. No escribe tests E2E.
3. El deploy corre las specs que salen de `specs/mapa.txt` (p. ej. `@spec-002` de Botón Pago Genérico y una spec de Consultar Otros Comercios): como el repo es compartido, `sh ci/e2e.sh --todos "<tags>"`, con api y ui como regresión en cada funcionalidad.
4. Si la regresión falla, no era un refactor: vuelve al triage.

**4. MAU en backend · error 500 al autorizar con monto 0**

1. `bug-assess` ubica el origen en el MS; la historia WCAP-301 del MAU se trabaja allí, en `feature/mau-WCAP-301-monto-cero`.
2. Antes del fix, escribe en el repo de la célula un test api que reproduce el incidente: espera 422 y hoy recibe 500. Tags `@spec-004`, `@mau` y `@WCAP-301`.
3. `bug-fix` en el MS; `bug-test` corre los unitarios y ese test.
4. El test queda en la suite funcional como regresión, y la causa raíz se registra en Jira.

**5. Cambio de contrato · agregar glosa al comprobante**

1. MR en el repo de la célula, carpeta de la funcionalidad: contratos v1.1 y spec 005 actualizada.
2. MS, API y BFF implementan; la app sale después, con el flag apagado.
3. Test api de 005: la respuesta trae `glosa`. Corre apenas el BFF llega a integración.
4. El test ui de la glosa entra con la app; hasta entonces, la UI de 005 corre como regresión.

#### Código de referencia

Rutas, campos y códigos de error son de ejemplo; cada equipo los toma de sus contratos.

`celula-hades/playwright.config.ts` (resumen; el archivo lo administra `sdd-plataforma`)

```ts
import { defineConfig, devices } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const raiz = join(__dirname, 'funcionalidades');
const funcionalidades = readdirSync(raiz, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(raiz, d.name, 'e2e')))
  .map((d) => d.name);
const url = (tipo: 'BFF' | 'APP', f: string) =>
  process.env[`${tipo}_URL_${f.toUpperCase().replace(/-/g, '_')}`] ?? process.env[`${tipo}_URL`];

export default defineConfig({
  reporter: [['html'], ['junit', { outputFile: 'results.xml' }]],
  projects: funcionalidades.flatMap((f) => [
    { name: `${f}-api`, testDir: join(raiz, f, 'e2e'), testMatch: /.*\.api\.spec\.ts/,
      use: { baseURL: url('BFF', f) } },
    { name: `${f}-ui`, testDir: join(raiz, f, 'e2e'), testMatch: /.*\.ui\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: url('APP', f) } },
  ]),
});
```

`funcionalidades/boton-pago-generico/e2e/004-autorizacion/monto.api.spec.ts`

```ts
import { test, expect } from '@playwright/test';

test('004 › autoriza montos hasta 2M', { tag: ['@spec-004'] }, async ({ request }) => {
  const res = await request.post('/autorizaciones', {
    data: { pagoId: 'PG-E2E-001', monto: 1_500_000 },
  });
  expect(res.status()).toBe(201);
});

test('WCAP-104 › rechaza montos sobre 2M', { tag: ['@spec-004', '@WCAP-104'] }, async ({ request }) => {
  const res = await request.post('/autorizaciones', {
    data: { pagoId: 'PG-E2E-002', monto: 2_100_000 },
  });
  expect(res.status()).toBe(422);
  expect((await res.json()).codigo).toBe('MONTO_SOBRE_LIMITE');
});
```

Repo de capa, `ci/specs-tocadas.sh`: arma el filtro de tags con las specs que toca el merge.

```bash
#!/bin/sh
CAMBIOS=$(git diff --name-only HEAD~1 HEAD)
while read -r ruta spec; do
  [ -z "$ruta" ] && continue
  echo "$CAMBIOS" | grep -q "^$ruta" && echo "@spec-${spec%%-*}"
done < specs/mapa.txt | sort -u | paste -sd'|' -
```

Notas para el piloto:

- El disparo del E2E le pasa al repo de la célula la funcionalidad (o `--todos` si el repo es compartido), las specs a correr (las que devuelve `ci/specs-tocadas.sh`) y la rama de tests. Si la rama se toma del commit de merge, los proyectos deben usar merge con commit de merge, sin squash ni fast-forward.
- La versión de la imagen de Playwright del pipeline debe coincidir con la de `@playwright/test` en `package.json`.
- El token de disparo del repo de la célula se guarda como variable protegida y enmascarada en cada repo de capa.
- El job de validación de specs busca la carpeta por número (`specs/004-*`), así una rama `feature/004-monto-maximo` encuentra la spec 004 existente.

### Controles en GitLab

Los controles vienen incluidos en los templates de cada arquetipo, para que cada repo nuevo los tenga desde el primer commit.

| Control | Archivo o configuración | Para qué |
| --- | --- | --- |
| Ramas | Convención obligatoria | `feature/NNN-nombre` para FUID, `feature/fdt-<clave>-<nombre>` para FDT y `feature/mau-<clave>-<nombre>` para MAU; el pipeline solo corre en `feature/*` y todos los MR van a `Desarrollo-CI` |
| Pedido en Jira | Campos del FUID, FDT y MAU | Dejar escrita la decisión de la regla de oro y la spec afectada |
| Templates de MR | `.gitlab/merge_request_templates/FUID.md`, `FDT.md` y `MAU.md` | Enlace a la spec o al reporte, checklist SDD, evidencia E2E, agente y modelo usados |
| Job `validar-specs` | `.gitlab-ci.yml` | En `feature/NNN-*`, exigir `spec.md`, `plan.md` y `tasks.md`; en el repo de la célula, `spec.md` e `impacto.md` en `funcionalidades/<funcionalidad>/specs/NNN-*` |
| Jobs `numeracion` y `funcionalidad` | `.gitlab-ci.yml` del repo de la célula | Que ningún número de spec se repita entre funcionalidades y que la rama de una historia toque solo la carpeta de su funcionalidad (un contrato compartido, `servicios/<repo>/`, va en su propio MR) |
| Job `regla-de-oro` | `.gitlab-ci.yml` + `specs/mapa.txt` | Avisar (sin bloquear) cuando se toca código de una spec sin tocar la spec; se omite con la etiqueta `sin-cambio-comportamiento` |
| Job de FDT y MAU | `.gitlab-ci.yml` | En `feature/fdt-*`, exigir `.specify/fdt/<slug>/test.md`; en `feature/mau-*`, `.specify/bugs/<slug>/test.md`; ambos con veredicto verificado |
| Job `clave-jira` | `.gitlab-ci.yml` | Que el título del MR empiece con la clave del pedido |
| Job `jmeter` | `.gitlab-ci.yml` + `perf/` | En BFF, API y MS, si `plan.md` dice "JMeter: sí", exigir `perf/NNN-*/*.jmx`; el control tests-intactos también protege `perf/` |
| Pruebas de contrato | `.gitlab-ci.yml` | Cada repo valida su lado del contrato como proveedor o consumidor |
| Ramas protegidas: master y Desarrollo-CI | Protected branches | Nadie hace push directo; solo los maintainers (líderes técnicos) hacen merge |
| Pipelines obligatorios | Ajuste del proyecto "Pipelines must succeed" | Que un job fallido bloquee el merge |
| Labels | Grupo | `tipo-fuid`, `tipo-fdt`, `tipo-mau`, `spec-NNN`, `capa-app`, `capa-bff`, `capa-api`, `capa-ms` |

En Community Edition no hay aprobaciones obligatorias ni Code Owners, así que la revisión se asegura limitando el merge a los maintainers y con el checklist del template de MR. Los labels con alcance (`tipo::bug`) tampoco existen; por eso se usan nombres con guion.

Spec Kit crea por defecto ramas `NNN-nombre`. Hay que configurarlo para que use `feature/NNN-nombre` y verificar en el piloto que los comandos posteriores siguen encontrando `specs/NNN-nombre/`. Los jobs de CI buscan el número de spec después del prefijo `feature/`.

#### Ramas y ambientes

Todo pedido vive en una rama `feature/*`, entra por MR a `Desarrollo-CI`, se certifica en QA y desde ahí se despliega a producción; `master` guarda el respaldo de lo que está en producción.

| Rama | Rol | Quién escribe en ella |
| --- | --- | --- |
| `master` | Respaldo de producción | Solo el proceso de pase, después de cada despliegue exitoso |
| `Desarrollo-CI` | Destino de todos los MR; se certifica en QA y desde ahí va a producción | Maintainers, por MR |
| `feature/*` | Un pedido (FUID, FDT o MAU); única rama donde corre el pipeline de validación | La célula |

- **Las ramas nuevas salen de `Desarrollo-CI` actualizada.** Antes de `/speckit-specify`, `/speckit-fdt-assess` o `/speckit-bug-assess`, el desarrollador corre `git switch Desarrollo-CI && git pull`, porque Spec Kit crea la rama desde donde esté parado.
- **Los MR siempre van a `Desarrollo-CI`,** nunca a `master`.
- **Feature flags obligatorios.** Lo que está en `Desarrollo-CI` sin certificar va con su flag apagado. Un FUID toca cuatro repos que se mergean en momentos distintos, y el flag evita que una funcionalidad a medias llegue a producción con el siguiente pase.
- **`master` se actualiza después de cada pase,** con un merge desde `Desarrollo-CI` y un tag de versión. En ese mismo paso se registra el despliegue en el Pact Broker (`record-deployment`).
- **El repo de la célula sigue la misma convención:** la spec y los tests nuevos se trabajan en `feature/*` (la spec se mergea un sprint antes; los E2E vuelven a abrir una rama con el mismo nombre) y el pipeline de E2E corre sobre `Desarrollo-CI`.
- **Glosario:** en este playbook, "integración" y "QA" son el mismo ambiente, el que certifica `Desarrollo-CI`.

## Parte VII · Simulación

Los mismos caminos en una línea de tiempo, con quién actúa en cada momento.

La simulación interactiva (FUID, FDT, MAU, defecto de QA y una historia con 4 devs en conjunto) está en la hoja "Simulador de Jira a producción" de `docs/sdd-canales-digitales.html`. Las duraciones son de ejemplo, para mostrar el orden y quién actúa en cada momento.

## Parte VIII · Operación y adopción

Integraciones, costo y cómo se extiende el estándar.

### Integraciones y accesos para agentes

Conviene habilitar cuatro integraciones antes del piloto: que Jira cree las ramas en GitLab, que los agentes lean Jira y Figma con accesos personales y que tengan la memoria local odin-memory.

| Integración | Para qué | Qué habilitar | Quién lo habilita |
| --- | --- | --- | --- |
| Jira → GitLab | Crear la rama desde la historia o el pedido, y ver ramas, MR, pipelines y despliegues en Jira | App GitLab for Jira Cloud conectada al GitLab self-managed. Crear ramas desde Jira solo es posible con esa app; el conector DVCS de Jira Data Center no lo permite | Administradores de Jira y de GitLab |
| Jira para agentes | Copilot lee la historia en `/speckit-specify` y deja las dudas de `/speckit-clarify` como comentario | Servidor MCP de Atlassian con OAuth (solo Jira Cloud), o tokens API con scopes y vencimiento. En Data Center, tokens personales habilitados por el administrador | Administrador de Atlassian |
| Figma para agentes | Copilot lee frames, estados y componentes del diseño enlazado en la historia, y los cruza con Arándano | Servidor MCP remoto de Figma (`https://mcp.figma.com/mcp`). Tokens personales solo si se usa un MCP basado en la API REST. El servidor de escritorio requiere asiento Dev o Full | Administrador de Figma |
| Memoria para agentes | Los agentes recuperan entre chats el estado, las decisiones y lo pendiente de cada historia | Servidor MCP local `odin-memory` (stdio, sin tokens ni red) publicado en el Nexus. Cada desarrollador lo registra con `odin setup vscode-copilot` en su perfil de usuario, no en el `.vscode/mcp.json` versionado, porque escribe rutas de su máquina | Equipo de plataforma (paquete en el Nexus) |
| Copilot | Que esos servidores se puedan usar | Agregar Atlassian, Figma, Backstage y odin-memory a la allowlist de MCP de Copilot | Administrador de Copilot |

**Ramas creadas desde Jira:**

- Salen de `Desarrollo-CI` y siguen la convención: `feature/004-WCAP-104-autorizacion` para una historia de FUID, `feature/fdt-WCAP-211-node-26` para una historia de FDT y `feature/mau-WCAP-301-monto-cero` para una historia de MAU.
- En un FUID se crea una rama por cada repo de capa que toca la historia, todas con el mismo nombre.
- Con la clave de Jira en el nombre, la rama aparece sola en el panel de desarrollo de la historia. Para las historias de FUID esto cambia la convención a `feature/NNN-CLAVE-nombre`.
- Spec Kit crea su propia rama en `/speckit-specify`. Si la rama ya viene de Jira, se usa con la variable `GIT_BRANCH_NAME` de la extensión git de Spec Kit, que toma el nombre tal cual. En el piloto hay que verificar que los comandos siguientes encuentren la carpeta de la spec.

**Tokens para agentes:**

- **Personales:** cada desarrollador usa el suyo, con sus propios permisos. Nunca se comparten.
- **Scopes mínimos:** lectura de historias y escritura de comentarios en Jira; lectura de archivos en Figma.
- **Vencimiento corto:** los tokens API de Atlassian permiten de 1 a 365 días. Se revocan cuando alguien deja la célula.
- **Nunca en el repo:** se piden como entrada secreta de VS Code. El archivo `.vscode/mcp.json` sí se versiona en el template, porque no contiene secretos:

```json
{
  "inputs": [
    { "type": "promptString", "id": "jira-token", "description": "Token API personal de Jira", "password": true }
  ],
  "servers": {
    "figma": { "type": "http", "url": "https://mcp.figma.com/mcp" },
    "jira": {
      "type": "stdio",
      "command": "<servidor MCP de Jira con token>",
      "env": { "JIRA_API_TOKEN": "${input:jira-token}" }
    }
  }
}
```

Los servidores remotos de Figma y Atlassian se autentican en el navegador; la entrada secreta solo se usa con servidores que piden token.

Fuentes: [GitLab Docs: Jira development panel](https://docs.gitlab.com/integration/jira/development_panel) · [Atlassian: Manage API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/) · [Figma: Guide to the Figma MCP server](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server)

### Telemetría y costo por pedido

GitHub muestra el consumo de Copilot por persona, modelo y periodo, pero no conoce Jira: no dice cuánto costó la historia WCAP-104, la épica WCAP-100 ni la funcionalidad Botón Pago Genérico. Para medir el costo por pedido, Copilot exporta telemetría OpenTelemetry y cada sesión se marca con la clave de Jira.

#### Qué entrega GitHub sin configurar nada

| Fuente | Qué muestra | Para qué sirve |
| --- | --- | --- |
| Facturación por uso (AI Credits, desde el 1 de junio de 2026) | Créditos calculados con los tokens de entrada, salida y caché, al precio de cada modelo | Costo oficial del mes |
| Créditos incluidos | Business: USD 19 por usuario al mes; Enterprise: USD 39. Se comparten entre toda la organización | Saber cuánto uso ya está pagado |
| Presupuestos | Topes por empresa, por cost center y por usuario; al agotarse, se permite el uso adicional o se corta | Un cost center por equipo da el costo de cada uno de los 6 equipos |
| API de métricas de uso | Tokens, sesiones y peticiones en reportes de 1 y 28 días, por organización | Adopción y tendencia |

Nada de esto entrega el costo por historia, por FUID, FDT o MAU, por célula ni por fase de Spec Kit.

#### Telemetría OpenTelemetry de Copilot

- Copilot en VS Code exporta trazas, métricas y eventos con las convenciones GenAI de OpenTelemetry. Se activa con `github.copilot.chat.otel.enabled`.
- Cada sesión del agente y cada llamada al modelo trae los tokens de entrada, salida, caché y razonamiento, y el modelo pedido y el que respondió.
- Por defecto solo envía metadatos (tokens, modelo, duración). Los prompts, el código y los resultados de herramientas quedan fuera salvo que se active `captureContent`; la gerencia lo deja apagado.
- Se envía por OTLP a un OpenTelemetry Collector propio y de ahí a cualquier backend compatible (Grafana, Langfuse, Datadog, Application Insights).
- El administrador puede fijar de forma central el destino, el protocolo, el nombre del servicio, los atributos `equipo` y `celula`, el token del Collector y la prohibición de capturar contenido. Ningún dev configura nada a mano.

#### Marcar cada sesión con la clave de Jira

Copilot agrega atributos propios desde `OTEL_RESOURCE_ATTRIBUTES`. El script corporativo `sdd-abrir`, que vive en `sdd-plataforma`, recibe la clave de la historia, toma el tipo de su épica, deja los repos de la historia en su rama `feature/…` y abre VS Code con la clave y la funcionalidad puestas (Jira no tiene un campo estándar para la funcionalidad, así que sale de la carpeta del repo de la célula):

```bash
sdd-abrir WCAP-104
# hace checkout de feature/004-autorizacion en los repos del workspace y luego:
OTEL_RESOURCE_ATTRIBUTES="jira.clave=WCAP-104,jira.padre=WCAP-100,jira.tipo=FUID,sdd.funcionalidad=boton-pago-generico" \
  code boton-pago-generico.code-workspace
```

Regla para los devs: una ventana de VS Code por historia. Sumar tokens por `jira.clave` da el costo de la historia; sumarlos por `jira.padre`, el de la épica (FUID, FDT o MAU); y por `sdd.funcionalidad`, el de la funcionalidad. En el modo en conjunto se suman los cuatro devs de la historia.

#### Tablero de costo

| Métrica | Pregunta que responde |
| --- | --- |
| Tokens y créditos por historia y por épica (FUID, FDT y MAU) | Cuánto cuesta cada pedido |
| Tokens y créditos por funcionalidad (`sdd.funcionalidad`) | Cuánto cuesta mantener cada funcionalidad |
| Tokens por fase o agente (Planner, Tester, Implementer, Reviewer) | Dónde se gasta; una spec débil se nota en implement |
| Tokens por modelo | Si se cumple la política de modelos por fase |
| Costo frente a tiempo de ciclo en Jira | Si el gasto se traduce en entregas más rápidas |
| Costo de una épica MAU frente a la épica FUID que lo originó | Calidad de la spec original |

#### A validar en el piloto

- Si el administrador fija los atributos de forma central, sus valores pisan las variables de entorno. Hay que confirmar que `jira.clave` se combina con los atributos centrales y no se pierde.
- Confirmar si el nombre del agente propio llega como atributo. Si no llega, la fase se deduce del comando `/speckit-*`.
- El costo calculado desde tokens es una estimación; la cifra oficial es la factura de GitHub. Se comparan cada mes.
- En GitLab CE self-managed los minutos de CI no se cobran. Si interesa su tiempo, se obtiene de la API de pipelines por rama, aparte del costo de tokens.

Fuentes: [GitHub: Copilot is moving to usage-based billing](https://github.blog/changelog/2026/04/27/github-copilot-is-moving-to-usage-based-billing/) · [VS Code: Monitor agent usage with OpenTelemetry](https://code.visualstudio.com/docs/agents/guides/monitoring-agents) · [GitHub: Enterprise-managed OpenTelemetry export](https://github.blog/changelog/2026-07-08-enterprise-managed-opentelemetry-export-for-vs-code-and-cli/) · [GitHub: Copilot app in the usage metrics API](https://github.blog/changelog/2026-07-17-github-copilot-app-now-available-in-the-usage-metrics-api)

### Plan de adopción y métricas

Se empieza por la forma de trabajo de los desarrolladores y, con sus resultados, se propone el estándar macro a la gerencia. El estándar se extiende a los 6 equipos solo si mejora los cambios aceptados.

**Fase 1 · Desarrolladores (célula Hades):** `sdd-dev-process` sobre el bloque de `sdd-plataforma`, un dev, una historia y un repo de capa a la vez, con controles locales (`ci/sdd-checks.sh`). Se mide desde el primer pedido.

**Fase 2 · Propuesta macro:** un repo por célula (`celula-<célula>`) con specs, contratos y E2E por funcionalidad, contratos de servicios compartidos, contratos versionados, jobs de CI que bloquean, aprobación del PO en Jira y telemetría. `sdd-dev-process` entra tal cual como la capa de repo.

1. **Preparar (equipo de plataforma):** preset v1, extensiones (`bug`, `fdt`), `sdd-dev-process` con sus agentes, skills y knowledge, catálogo publicado, bloque Spec Kit agregado a los templates y políticas de Copilot revisadas.
2. **Piloto con 1 o 2 células:** de 3 a 5 funcionalidades representativas, que incluyan un cambio pequeño, uno sobre código existente y uno con datos o seguridad, más algunos bugs. En Hades: botón de pago genérico, botón de pago de Impuestos Internos, nóminas CDS y nóminas MTN.
3. **Ajustar:** lo aprendido entra al preset y se publica una nueva versión.
4. **Extender** a los 6 equipos con la versión ajustada; cada equipo actualiza su template.
5. **Retro periódica entre equipos** para alimentar las siguientes versiones del preset.

**Métricas** (comparadas contra trabajo similar sin Spec Kit):

- Tiempo de aclaración y de revisión
- Defectos escapados a producción y defectos de QA por historia
- Retrabajo y MR reabiertos
- Lead time por funcionalidad
- Porcentaje de MR con spec enlazada y uso de la etiqueta `sin-cambio-comportamiento`
- Costo en tokens y créditos por historia y por FUID, desde la telemetría (ver Telemetría y costo por pedido)

## Puntos abiertos

Estas decisiones cambian la configuración final y conviene cerrarlas antes del piloto.

- [ ] Ruta rápida para MAU: qué pruebas se exigen antes del pase y cuáles después
- [ ] Cómo registrar en Jira la historia habilitadora (spec 001) dentro del FUID
- [ ] Jira Cloud o Data Center: define si Jira puede crear ramas en GitLab y si Copilot lee historias con el servidor MCP de Atlassian. Adoptar la clave de Jira en las ramas de FUID (feature/NNN-CLAVE-nombre)
- [ ] Estados del flujo de Jira por tipo de pedido y quién administra el tablero de cada equipo
- [ ] Verificar en el piloto que Spec Kit, con ramas `feature/NNN-nombre` (`branch_prefix: feature`), encuentra `specs/NNN-nombre/`
- [ ] Si su versión de CE permite `trigger:` entre proyectos o se usa token de disparo
- [ ] Formato actual de la documentación de Arándano (Markdown, MDX, Storybook) y si el paquete puede publicarla con `catalogo.md`
- [ ] Verificar que Copilot lee la documentación dentro de `node_modules` en su configuración de VS Code
- [ ] Política de componentes temporales mientras Arándano publica una brecha
- [ ] Cómo se reparten las historias cuando un FUID tiene más historias que devs
- [ ] Acceso de red a PyPI y GitHub para instalar la CLI, o mirror interno
- [ ] Lista de modelos aprobados y su asignación por fase
- [ ] Cómo homologar el bloque común en los templates de los 18 arquetipos
- [ ] Si el comprobante también puede volver al detalle
- [ ] Montar el OpenTelemetry Collector y el tablero de costo por pedido, y crear un cost center de Copilot por equipo
- [ ] Validar en el piloto que `sdd-abrir` deja `jira.clave` en la telemetría junto con los atributos centrales
- [ ] Repo de template de cada uno de los 18 arquetipos y completar su knowledge en `sdd-dev-process/knowledge/arquitectura/arquetipos/`
- [ ] Términos de negocio de cada subgerencia en el glosario de `sdd-dev-process`
- [ ] Umbrales de calidad de código de la gerencia (hoy son una propuesta en `calidad-codigo.md`)
- [ ] Agregar a la allowlist de MCP el servidor del Angular CLI y el de Dart y Flutter, o trabajar sin ellos
- [ ] Design system para las apps Flutter (Arándano es para web)
- [ ] Validar en VS Code el campo `skills` de los agentes y los hooks por agente (`tests-intactos`, `solo-informe`)
- [ ] Publicar `odin-memory` en el Nexus y agregarlo a la allowlist de MCP de Copilot
- [ ] Validar en el piloto que VS Code respeta `'odin-memory/*'` en el `tools` de los agentes y que los hooks de odin-memory conviven con `tests-intactos` y `solo-informe`
- [ ] Fase 2: memoria compartida en la célula (Git Sync o nube de odin-memory) y qué se puede compartir
- [ ] Fase 2: dejar los agentes en un solo repo (hoy `sdd-plataforma` también instala cuatro de ellos)
- [ ] Template JMeter de la gerencia (versión de JMeter y headers obligatorios) para reemplazar la plantilla provisional de `sdd-jmeter`
- [ ] Cómo registra el arquitecto la carga y los umbrales por endpoint (en `plan.md` o en otro documento enlazado)
- [ ] Ethical hacking: qué insumos recibe (`seguridad.md`, contratos) y tiempos
- [ ] MAU urgente: si exige performance y ethical hacking completos o una versión reducida
- [ ] Verificar en el piloto que `/speckit-clarify`, `/speckit-sdd-impacto` y `/speckit-sdd-resumen-po` encuentran la spec en `funcionalidades/<funcionalidad>/specs/` del repo de la célula (vía `.specify/feature.json`)
- [ ] Al pasar al repo de la célula una funcionalidad que ya tiene specs, renumerar las que choquen con otra funcionalidad de la célula (repo de la célula, repos de capa, tags `@spec-NNN` y `specs/mapa.txt`)
- [ ] Estándar para registrar la funcionalidad en la épica de Jira: hoy va en el título (`Migración Node 24 - Nóminas MTN`); definir si es componente, etiqueta o campo propio
- [ ] Repos de app y BFF de Autorizar Otros Comercios y Consultar Otros Comercios, y a qué funcionalidad corresponden `boton-pago-generico-nwe-*`, `btpgconsult-generic-app` y `btnconsulta-bff`
- [ ] Quién es el dueño de los contratos de un API o MS compartido (`botonpago-api`, `botonpago-ms`) y cómo se avisa a las demás funcionalidades de un cambio

## Fuentes

- [Spec Kit: Supported AI Coding Agent Integrations](https://github.github.com/spec-kit/reference/integrations.html)
- [Spec Kit: Presets reference](https://github.github.com/spec-kit/reference/presets.html)
- [Spec Kit: Customize Spec Kit](https://github.github.io/spec-kit/guides/customization.html)
- [Spec Kit: Bug Fixing Quickstart](https://github.github.io/spec-kit/guides/bugfix.html)
- [specify-cli en PyPI](https://pypi.org/project/specify-cli/1.2.1/)
- [Spec Kit: upgrade guide](https://github.com/github/spec-kit/blob/main/docs/upgrade.md)
- [Spec Kit: discusión sobre microservicios con múltiples repos](https://github.com/github/spec-kit/discussions/5018)
- [Spec Kit: propuesta de nombres de rama configurables](https://github.com/github/spec-kit/issues/2047)
- [Spec Kit: extensión git y variables de rama](https://github.com/github/spec-kit/issues/1940)
- [GitLab Docs: Labels](https://docs.gitlab.com/user/project/labels)
- [VS Code: Custom agent file reference](https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference)
- [GitHub Docs: Default availability (enterprise)](https://docs.github.com/en/copilot/concepts/enterprise/default-availability)
- [Wavect: GitHub Spec Kit para equipos de producción](https://wavect.io/es/blog/github-spec-kit-production-guide/)
