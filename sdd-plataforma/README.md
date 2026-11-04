# sdd-plataforma

Fuente de verdad del estándar **SDD de la gerencia** (Jira → Spec Kit → GitHub Copilot → GitLab CE → Playwright). Lo mantiene el equipo de plataforma; los repos lo consumen en versión fija. El detalle de la metodología está en el playbook (`sdd-contexto-claude-code/docs/sdd-playbook.md`).

**Versión**: ver [VERSION](VERSION) y [CHANGELOG.md](CHANGELOG.md) · **Spec Kit**: 1.0.3 (`uv tool install specify-cli`)

## Contenido

| Carpeta | Qué es | Se instala en |
| --- | --- | --- |
| `preset/sdd-gerencia/` | Preset de Spec Kit: plantillas de spec (Jira, Cambios posteriores), plan (contratos, agente y modelo, Arándano, E2E, rendimiento JMeter), tasks (roles `[tester]`/`[implementer]`, fase de rendimiento, fase E2E) y constitution; agregados a `specify`, `tasks` e `implement` | `.specify/presets/` (capa y célula) |
| `extensions/fdt/` | Extensión FDT: `/speckit-fdt-assess` (regla de oro), `/speckit-fdt-apply`, `/speckit-fdt-test` | `.specify/extensions/` (capa) |
| `extensions/sdd/` | Comandos corporativos: `/speckit-sdd-resumen-po` (resumen para Jira) y `/speckit-sdd-impacto` (impacto por capas) | `.specify/extensions/` (capa y célula) |
| `agents/` | SDD Planner, SDD Tester, SDD Implementer, SDD Reviewer. Si el repo usa `sdd-dev-process`, sus seis agentes los reemplazan | `.github/agents/` |
| `hooks/tests-intactos.mjs` | Hook PreToolUse del Implementer: bloquea editar tests y planes JMeter (`perf/`) | `.github/hooks/` |
| `ci/sdd-checks.sh` | Controles de la gerencia en local: rama, clave de Jira, numeración y funcionalidad (célula), specs, veredicto FDT/MAU, tests intactos, plan JMeter, regla de oro | `ci/` |
| `ci/specs-tocadas.sh` | Tags `@spec-NNN` a correr en E2E según `specs/mapa.txt` | `ci/` (capa) |
| `ci/siguiente-spec.sh` | Siguiente número de spec libre en toda la célula | `ci/` (célula) |
| `ci/e2e.sh` | Corre el E2E de una funcionalidad (`<funcionalidad> ["<tags>"]`) o de todas (`--todos ["<tags>"]`) | `ci/` (célula) |
| `plantillas/celula/` | `playwright.config.ts` (un proyecto api y uno ui por funcionalidad), `package.json`, `.gitignore` y README del repo de la célula | raíz (célula) |
| `plantillas/funcionalidad/` | README, README de E2E y workspace de VS Code de una funcionalidad (la declaración de sus repos) | `funcionalidades/<funcionalidad>/` |
| `plantillas/servicio/` | README de un API o MS compartido entre funcionalidades | `servicios/<repo>/` |
| `instructions/` | Plantillas de `copilot-instructions.md` e `*.instructions.md` por tipo de repo | `.github/` |
| `mr-templates/` | Plantillas de MR FUID, FDT y MAU | `.gitlab/merge_request_templates/` |
| `scripts/sdd-instalar.sh` | Instala el bloque SDD en un repo (`capa <célula>/<funcionalidad>`, `capa <célula>` si es compartido, o `celula`) | — |
| `scripts/sdd-funcionalidad.sh` | Agrega una funcionalidad al repo de la célula | — |
| `scripts/sdd-servicio.sh` | Agrega un API o MS compartido al repo de la célula (`servicios/<repo>/contracts/`) | — |
| `scripts/sdd-abrir.sh` | Abre el workspace de una historia de Jira con ramas y marca OTEL | — |
| `GUIA-PRUEBA.md` | Guion de la prueba de WCAP-104 con Copilot | — |

Las extensiones `git` (ramas `feature/NNN-nombre` vía `branch_prefix: feature`) y `bug` (MAU) son las que trae Spec Kit; el instalador las agrega y configura.

## Repos de una célula

La gerencia trabaja por **funcionalidades** (Botón Pago Genérico, Autorizar Otros Comercios, Consultar Otros Comercios, nóminas MTN, transferencias…). En Jira, una **épica** es un pedido FUID, FDT o MAU de una funcionalidad nueva o existente, y se divide en historias. Hoy la funcionalidad va en el título de la épica (`Migración Node 24 - Nóminas MTN`).

Un repo por célula; cada funcionalidad tiene su app y su BFF, y los API y MS pueden ser propios o **compartidos** entre funcionalidades. Ejemplo de la célula Hades (tablero WCAP):

```
celula-hades/                         tipo celula
├── funcionalidades/
│   ├── boton-pago-generico/
│   │   ├── jira/  specs/NNN-nombre/  contracts/<repo>/  e2e/NNN-nombre/
│   │   └── boton-pago-generico.code-workspace     declara sus repos: app, BFF, botonpago-api, botonpago-ms
│   ├── autorizar-otros-comercios/
│   └── consultar-otros-comercios/
└── servicios/                        API y MS compartidos: solo contratos
    ├── botonpago-api/contracts/
    └── botonpago-ms/contracts/
boton-pago-generico-app/  boton-pago-generico-bff/    tipo capa (hades/boton-pago-generico)
botonpago-api/  botonpago-ms/                         tipo capa compartida (hades)
```

- **Los nombres de repo no se deducen de la funcionalidad** (`boton-pago-generico-bff`, `btnconsulta-bff`, `botonpago-ms`…): cada funcionalidad declara los suyos en su `<funcionalidad>.code-workspace`, y de ahí los leen `sdd-abrir`, `/speckit-sdd-impacto` y los agentes.
- **Numeración única en la célula** (`ci/siguiente-spec.sh`): la spec 006 de una funcionalidad no puede repetirse en otra. Así las ramas `feature/NNN-*`, los tags `@spec-NNN` y las carpetas no chocan dentro del mismo repo ni en los API y MS compartidos, y cada repo de capa usa el mismo número con `--number`.
- **Una historia es de una sola funcionalidad:** su rama del repo de la célula solo cambia `funcionalidades/<funcionalidad>/` (control `[funcionalidad]`). Un contrato compartido (`servicios/<repo>/`) lo cambia su dueño en su propio MR.
- **Un proyecto Spec Kit en la raíz** del repo de la célula; la spec va en `funcionalidades/<funcionalidad>/specs/NNN-nombre/` con `SPECIFY_FEATURE_DIRECTORY` (Spec Kit 1.x lo admite y lo persiste en `.specify/feature.json`).
- **Contratos con tag:** `boton-pago-generico/contracts-v1.0.0` (propios de la funcionalidad) y `servicios/botonpago-ms/contracts-v1.0.0` (compartidos).
- **E2E:** el repo de capa, al desplegar, dispara el pipeline del repo de la célula con la funcionalidad, los tags (`ci/specs-tocadas.sh`) y la rama de tests: `sh ci/e2e.sh boton-pago-generico "@spec-004"`. Un repo compartido cuyas specs son de varias funcionalidades corre `sh ci/e2e.sh --todos "<tags>"`. La nocturna corre `sh ci/e2e.sh --todos`.

## Uso

```bash
# Repo de la célula (una vez), sus funcionalidades y sus servicios compartidos
sh sdd-plataforma/scripts/sdd-instalar.sh celula-hades celula
sh sdd-plataforma/scripts/sdd-funcionalidad.sh celula-hades boton-pago-generico
sh sdd-plataforma/scripts/sdd-servicio.sh celula-hades botonpago-ms

# Repos de capa propios de una funcionalidad (app y BFF; API y MS si no se comparten)
sh sdd-plataforma/scripts/sdd-instalar.sh boton-pago-generico-bff capa hades/boton-pago-generico

# API o MS compartido entre funcionalidades: solo la célula
sh sdd-plataforma/scripts/sdd-instalar.sh botonpago-ms capa hades

# ¿Qué repos están atrasados? (no cambia nada; sale con 1 si hay pendientes)
for r in celula-hades boton-pago-generico-bff botonpago-ms; do sh sdd-plataforma/scripts/sdd-instalar.sh --revisar $r; done

# Actualizar a la versión actual de sdd-plataforma (tipo, célula y funcionalidad se leen de .github/sdd-plataforma.json)
sh sdd-plataforma/scripts/sdd-instalar.sh boton-pago-generico-bff

# Abrir una historia (el tipo de pedido sale de su épica)
sh sdd-plataforma/scripts/sdd-abrir.sh WCAP-104
```

Qué hace el instalador con cada componente:

| Componente | Al actualizar |
| --- | --- |
| Preset `sdd-gerencia`, extensiones `fdt` y `sdd` | Se reinstalan si cambió la versión, o si cambió el contenido sin subir la versión (lo marca como `MODIFICADO`: es un error de quien publicó) |
| Extensiones `git` y `bug` (de Spec Kit) | Solo se exige que estén instaladas; su versión la fija la de `specify-cli` |
| Agentes, hook, `ci/`, plantillas de MR, `*.instructions.md`, `playwright.config.ts` | Se sobrescriben si son distintos |
| `copilot-instructions.md`, constitution ratificada, `specs/mapa.txt`, `package.json`, `.gitignore`, `README.md` (célula), `funcionalidades/`, `servicios/` | Se conservan: los adapta cada repo. Los cambios de la base se llevan a mano |

En el piloto, el preset y las extensiones se instalan desde carpeta local (`--dev`). Con ese modo, Spec Kit deja los skills de las extensiones como enlaces simbólicos hacia `.specify/extensions/<id>/.specify-dev/`; en Windows hay que clonar con `core.symlinks=true`. En producción se publican en un catálogo corporativo (`SPECKIT_CATALOG_URL`, en GitLab Pages) y se instalan con versión fijada.

## Cambiar el estándar

1. MR a este repo con el cambio. Se sube la versión del componente que cambió (`preset.yml` o `extension.yml`), la de `VERSION` y se agrega una entrada en `CHANGELOG.md`.
2. Merge y tag `vX.Y.Z`.
3. En cada repo: `sdd-instalar.sh --revisar` para ver qué cambia, `sdd-instalar.sh` para aplicarlo y un MR "Actualizar sdd-plataforma a X.Y.Z" a `Desarrollo-CI`. Lo mismo en los templates de cada arquetipo.

## Pendientes conocidos (v3.0.x)

- **Sintaxis del hook por agente**: el frontmatter `hooks` del SDD Implementer usa el mapa de eventos `PreToolUse`. La documentación de VS Code confirma el campo, pero no muestra el YAML exacto; se valida en el paso 3 de la guía. Si no corre, el respaldo es el control `tests-intactos` de `ci/sdd-checks.sh`.
- **Modelos por agente**: la línea `model` va comentada hasta cerrar la lista de modelos aprobados (punto abierto del playbook).
- **Skills en workspace multi-carpeta**: cada repo trae sus skills `speckit-*`; se valida en el piloto si Copilot las resuelve en el repo correcto.
- **Spec fuera de `specs/`**: en el repo de la célula la spec va en `funcionalidades/<funcionalidad>/specs/` con `SPECIFY_FEATURE_DIRECTORY`; se valida en el piloto que `/speckit-clarify` y las extensiones la encuentren por `.specify/feature.json`.
- **Jira**: simulado con `celula-<célula>/funcionalidades/<funcionalidad>/jira/*.md`. Con Jira Cloud se reemplaza por el servidor MCP de Atlassian.
- **Funcionalidad en Jira**: no hay un campo estándar; hoy va en el título de la épica. Mientras no se defina, la telemetría la toma de la carpeta (`sdd.funcionalidad`, puesta por `sdd-abrir`).
- **Sin `.gitlab-ci.yml`**: en este ejemplo los controles corren solo en local con `ci/sdd-checks.sh`.
