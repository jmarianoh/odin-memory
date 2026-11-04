# sdd-dev-process

Forma de trabajo de los desarrolladores con **GitHub Copilot** en VS Code: agentes, skills, hooks e instrucciones que guían un pedido de Jira (FUID, FDT o MAU) dentro de un repo de capa, desde la spec hasta el MR.

Es la **fase 1** del SDD de la gerencia: se prueba con los devs (piloto en la célula Hades) y después entra tal cual como la capa de repo del estándar macro. Toma las ideas de ai-dev-process (orquestador, TDD, seguridad, evidencia) y las lleva a la plataforma de la gerencia: Copilot, Spec Kit y GitLab CE.

**Versión**: ver [VERSION](VERSION) y [CHANGELOG.md](CHANGELOG.md)

## Relación con sdd-plataforma

| Repo | Qué aporta | Quién lo usa |
| --- | --- | --- |
| `sdd-plataforma` | Spec Kit, preset `sdd-gerencia`, extensiones (`git`, `bug`, `fdt`, `sdd`), controles `ci/`, plantillas de MR, `copilot-instructions.md` | Todos los repos (capa y célula) |
| `sdd-dev-process` | Agentes, skills de proceso y de stack, hooks, instrucciones por arquetipo | Repos de capa |

Se instala primero `sdd-plataforma` y después `sdd-dev-process`. Los agentes SDD Planner, Tester, Implementer y Reviewer de este repo reemplazan a los de `sdd-plataforma` (son los mismos, ampliados); por eso hay que correr este instalador después de cada actualización de `sdd-plataforma`.

## Arquetipos

3 subgerencias × 2 canales × 3 templates = 18 arquetipos ([arquetipos/catalogo.tsv](arquetipos/catalogo.tsv)).

| Subgerencia | Web | App |
| --- | --- | --- |
| Personas | `express` · `nest` · `angular` | `express` · `nest` · `flutter` |
| Empresas | `express` · `nest` · `angular` | `express` · `nest` · `flutter` |
| Adquirencia | `express` · `nest` · `angular` | `express` · `nest` · `flutter` |

El id es `<subgerencia>-<canal>-<stack>`, por ejemplo `personas-web-nest` o `adquirencia-app-flutter`. Cada stack tiene un perfil en [arquetipos/stacks/](arquetipos/stacks/) con su skill, sus comandos y sus patrones de test. El repo de template de cada arquetipo queda **por confirmar** en el catálogo.

## Agentes

| Agente | Qué hace | Puede editar |
| --- | --- | --- |
| **SDD Orquestador** | Punto de entrada. Clasifica el pedido, detecta el paso leyendo el repo y deriva con un botón de handoff | Nada |
| SDD Planner | specify → clarify → plan → tasks → analyze; `bug-assess` (MAU) y `fdt-assess` (FDT) | `specs/`, `.specify/`, `jira/` |
| SDD Tester | Tests antes del código: tareas `[tester]`, test que reproduce un MAU, ajuste de tests de un FDT, planes JMeter | Solo tests y `perf/` |
| SDD Implementer | Código por fases, `converge`, `bug-fix` y `bug-test`, `fdt-apply` y `fdt-test` | Código; un hook le bloquea los tests |
| SDD Reviewer | Revisión de solo lectura antes del MR | Nada |
| **SDD Seguridad** | Superficie sensible (auth, datos personales, pagos, endpoint público con efecto); escribe `seguridad.md` | Solo `seguridad.md`; un hook bloquea lo demás |

Los handoffs (`send: false`) son las pausas del proceso: cada paso termina con un botón y el desarrollador decide cuándo seguir.

**FUID:** Orquestador → Planner → Tester ⇄ Implementer (por fase) → Implementer (`converge`) → Reviewer → Seguridad si aplica → `ci/sdd-checks.sh` → MR.
**MAU:** Orquestador → Planner (`bug-assess`) → Tester (test que reproduce) → Implementer (`bug-fix`, `bug-test`) → Reviewer → Seguridad si aplica.
**FDT:** Orquestador → Planner (`fdt-assess`, regla de oro) → Tester si cambia comportamiento → Implementer (`fdt-apply`, `fdt-test`) → Reviewer.
**Certificación antes del pase:** QA (cada historia y la versión) → **performance** (sobre la versión completa en QA, el área de performance ejecuta los planes JMeter de BFF, API y MS con la carga y los umbrales del arquitecto) → **ethical hacking** (la versión completa en QA). **Sin los tres OK no hay pase.** Un hallazgo de cualquiera es un defecto enlazado a la historia: Orquestador (clasifica contra la spec, el umbral o la severidad) → Tester (test o plan JMeter que lo reproduce) → Implementer → Reviewer, y Seguridad si es de ethical hacking → MR en `feature/NNN-<qa|perf|eh>-<CLAVE>-<slug>` → el área vuelve a certificar. Si la spec no lo dice, decide el PO (regla de oro).

## Skills

| Skill | Para qué | Origen | Licencia |
| --- | --- | --- | --- |
| `sdd-clasificar` | Tipo de pedido, nivel N0/N1/N2 y superficie sensible | Propia (adaptada de ai-dev-process) | — |
| `sdd-tdd` | RED-GREEN-REFACTOR con roles separados y Prove-It | Propia (adaptada de ai-dev-process) | — |
| `sdd-seguridad` | Checklist por superficie y por stack, plantilla de `seguridad.md`, relación con ethical hacking | Propia (adaptada de ai-dev-process) | — |
| `sdd-memoria` | Qué guarda y lee cada agente en la memoria odin-memory (`sdd/<CLAVE>/<artefacto>`), qué no se guarda nunca y qué hacer si no está disponible | Propia | — |
| `sdd-jmeter` | Plan de rendimiento JMeter por spec en `perf/NNN-nombre/` (solo BFF, API y MS), con plantilla `.jmx` parametrizada y probada con JMeter 5.6.3. **Provisional** hasta el template JMeter de la gerencia | Propia | — |
| `angular-developer` | Angular moderno: signals, componentes, rutas, forms, SSR, tests, CLI | **Oficial** · [angular/skills](https://github.com/angular/skills) | MIT |
| `flutter` | Agrupa 14 skills oficiales: arquitectura, rutas, HTTP, JSON, layouts, localización, tests, mocks, análisis | **Oficial** · [flutter/agent-plugins](https://github.com/flutter/agent-plugins) y [dart-lang/skills](https://github.com/dart-lang/skills) | BSD-3-Clause |
| `nestjs-best-practices` | 40 reglas en 10 categorías: arquitectura, DI, errores, seguridad, rendimiento, tests | Comunidad, la más instalada en skills.sh · [Kadajett/agent-nestjs-skills](https://github.com/Kadajett/agent-nestjs-skills) | MIT |
| `node-express` | Express 5: capas, validación, errores, seguridad, operación, tests | Propia, basada en las guías oficiales de expressjs.com y nodejs.org (no existe una skill oficial de Express) | — |

En cada repo se instalan las de proceso (`sdd-jmeter` solo en Express y NestJS) y **solo la del stack** del arquetipo. El origen exacto (repo, commit, fecha) de las de terceros está en [vendor/upstream.tsv](vendor/upstream.tsv) y las licencias en [vendor/licencias/](vendor/licencias/). Las de terceros quedan en inglés, como las publica su autor.

## Memoria entre chats (odin-memory)

El proceso abre un chat nuevo por fase, y cada agente empieza sin contexto. **odin-memory** (servidor MCP `odin-memory`, herramientas `mem_*`, SQLite local en `~/.odin-memory/`) une esos chats: el Orquestador guarda el estado de la historia, el Planner las decisiones con su porqué, el Tester lo que quedó en rojo, el Implementer el avance y las causas raíz, el Reviewer los bloqueantes y Seguridad solo su veredicto. La convención está en la skill `sdd-memoria`.

- **El repo manda.** La spec, `tasks.md`, los reportes y los commits siguen siendo la fuente de verdad; la memoria agrega el porqué y lo pendiente. Si no coinciden, vale el repo.
- **Qué no se guarda nunca:** secretos, tokens, RUT, tarjetas, montos o datos de clientes, datos de producción ni el detalle de un hallazgo de seguridad.
- **Opcional y local.** Si un desarrollador no la tiene, los agentes siguen leyendo el estado del repo como siempre. En el piloto la memoria es de cada máquina y no se versiona; compartirla en la célula queda para la fase 2.
- **Instalación (una vez por máquina):**

```bash
npm install -g odin-memory        # desde el Nexus
odin setup vscode-copilot         # MCP, protocolo de memoria y hooks en el perfil de usuario de VS Code
```

Después, recargar VS Code (Developer: Reload Window). `instalar.sh` solo informa si `odin` está en el PATH; no lo cuenta como pendiente.

## Knowledge

Referencia estable que leen los agentes antes de planificar, implementar y revisar, y la guía de los flujos para las personas. Mapa y orden de lectura en [knowledge/README.md](knowledge/README.md).

| Documento | Para qué |
| --- | --- |
| [guias/flujos-sdd-dev-process.html](knowledge/guias/flujos-sdd-dev-process.html) | Guía visual: cómo se empieza, los seis agentes, clasificación, FUID, MAU, FDT y N0 paso a paso, reglas y arquetipos |
| [dominio/glosario.md](knowledge/dominio/glosario.md) | Términos del proceso; una sección por subgerencia para sus términos de negocio (por completar) |
| [arquitectura/overview.md](knowledge/arquitectura/overview.md) | Capas, funcionalidades y repos (propios y compartidos), contratos, despliegue, design system |
| [arquitectura/calidad-codigo.md](knowledge/arquitectura/calidad-codigo.md) | Condiciones de calidad sobre código nuevo y reglas para cumplirlas (umbrales por confirmar con la gerencia) |
| [arquitectura/arquetipos/](knowledge/arquitectura/arquetipos/) | Un archivo por arquetipo (18), en borrador: cada subgerencia lo completa con su template. Al repo llega solo el suyo |
| `integraciones/`, `operacion/` | Plantillas: el repo documenta sus sistemas externos y su operación |

Prioridad de las fuentes: knowledge del arquetipo → skill del stack → documentación oficial.

## Instalación en un repo de capa

```bash
# 0. Ver los arquetipos
sh sdd-dev-process/scripts/instalar.sh --listar

# 1. Bloque de la gerencia (Spec Kit, preset, extensiones, ci/)
sh sdd-plataforma/scripts/sdd-instalar.sh bff-boton-pago capa

# 2. Forma de trabajo con agentes, con el arquetipo del repo
sh sdd-dev-process/scripts/instalar.sh bff-boton-pago personas-web-nest

# ¿Está al día? (no cambia nada; sale con 1 si hay pendientes)
sh sdd-dev-process/scripts/instalar.sh --revisar bff-boton-pago

# Actualizar (lee el arquetipo de .github/sdd-dev-process.json)
sh sdd-dev-process/scripts/instalar.sh bff-boton-pago
```

Queda en el repo:

```
.github/
├── agents/            sdd-orquestador, sdd-planner, sdd-tester, sdd-implementer, sdd-reviewer, sdd-seguridad
├── hooks/             tests-intactos.mjs, solo-informe.mjs
├── skills/            sdd-clasificar, sdd-tdd, sdd-seguridad, sdd-memoria + la skill del stack (junto a las speckit-*)
├── instructions/      sdd-dev-process, arquetipo (generado) y las del stack
├── knowledge/         guía de flujos, glosario, arquitectura, calidad y el arquetipo del repo
└── sdd-dev-process.json   versión y arquetipo
```

`.github/copilot-instructions.md`, `knowledge/integraciones/` y `knowledge/operacion/` no se tocan después de crearlos: son del repo. En VS Code hay que activar `chat.useAgentSkills` y `chat.useHooks` y empezar el chat con el agente **SDD Orquestador**.

## Actualizar las skills de terceros

```bash
sh sdd-dev-process/scripts/actualizar-skills.sh todas      # o angular | nestjs | flutter
git -C sdd-dev-process diff -- skills/stack vendor        # revisar antes del commit
```

Las skills son instrucciones que el agente sigue: un cambio upstream se revisa igual que código, y entra con una versión nueva de este repo.

## Qué se tomó de ai-dev-process

| ai-dev-process | Aquí |
| --- | --- |
| `@orchestrator` y sus gates | SDD Orquestador + handoffs como pausas; el estado se lee de Spec Kit y de git, sin archivo de progreso propio |
| Niveles N0/N1/N2 y superficie sensible | Skill `sdd-clasificar` |
| `test-driven-development`, Prove-It | Skill `sdd-tdd`, con Tester e Implementer separados |
| `@security-auditor` | SDD Seguridad + skill `sdd-seguridad` |
| `@reviewer` | SDD Reviewer, con los puntos de stack y seguridad |
| Comportamiento estricto, evidencia, security baseline (`CLAUDE.md`) | `instructions/sdd-dev-process.instructions.md` |
| Skills por stack y arquetipos | Skills de stack + catálogo de arquetipos por subgerencia |
| `.claude/knowledge/` (arquitectura, calidad, dominio, guías HTML) | `knowledge/`, instalado en `.github/knowledge/` con solo el arquetipo del repo |
| Memoria persistente entre sesiones | odin-memory + skill `sdd-memoria`, como complemento de la spec versionada |
| OpenSpec, Bitbucket, Docker local | No: aquí se usan Spec Kit, la spec versionada en el repo y GitLab CE |

## Pendientes conocidos (0.1.0)

- **Templates por arquetipo:** confirmar el repo de template de cada uno de los 18 arquetipos, completar su archivo en `knowledge/arquitectura/arquetipos/` y ajustar los comandos de cada perfil contra su `package.json` o `pubspec.yaml`.
- **Glosario y calidad:** cada subgerencia completa sus términos de negocio, y la gerencia confirma los umbrales de calidad.
- **MCP de Angular y de Dart/Flutter:** las skills oficiales los aprovechan, pero la allowlist de MCP de la organización hoy permite solo Atlassian y Figma. Sin ellos, las skills funcionan con la terminal.
- **Campo `skills` del frontmatter:** es del esquema de Copilot; hay que validar en el piloto que VS Code lo respete. Si no, el agente igual encuentra la skill por su descripción.
- **Hooks por agente:** `solo-informe` usa el mismo formato que `tests-intactos`, que también está pendiente de validar en el piloto.
- **Design system en Flutter:** Arándano es para web; falta definir el equivalente para apps.
- **odin-memory:** agregarlo a la allowlist de MCP de la organización y publicarlo en el Nexus. Validar en el piloto que VS Code respeta `'odin-memory/*'` en el `tools` de los agentes y que los hooks de odin conviven con `tests-intactos` y `solo-informe`.
- **Fase 2:** decidir si los agentes salen de `sdd-plataforma` y quedan solo aquí, para tener una sola fuente; y si la memoria se comparte en la célula (Git Sync o nube de odin-memory) con reglas de qué se puede compartir.
