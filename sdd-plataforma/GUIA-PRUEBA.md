# Guía de prueba: WCAP-104 con GitHub Copilot

Esta guía recorre de punta a punta, desde instalar el estándar en tu repo, la historia **WCAP-104 · Autorizar un pago** (spec 004 de la épica FUID WCAP-100, funcionalidad Botón Pago Genérico) con Copilot en VS Code, en los repos locales del piloto. El andamiaje está listo; **todo el SDD lo hace Copilot**: spec, plan, tasks, tests y código. Tu papel es hacer de célula, de PO y de revisor, y anotar lo que pasa en [resultados-prueba.md](resultados-prueba.md).

```
~/Documents/harness/
├── sdd-plataforma/      estándar (preset, extensiones, agentes, hook, controles, scripts)
├── celula-hades/        repo de la célula Hades; funcionalidad en funcionalidades/boton-pago-generico/: Jira simulado
│                        (jira/), contrato v1.0.0 (contracts/), carpeta e2e/ sin tests y workspace. Contratos de los
│                        servicios compartidos en servicios/botonpago-api/ y servicios/botonpago-ms/
├── boton-pago-generico-bff/  BFF NestJS 12 de la funcionalidad, SIN el estándar SDD (lo instalas tú en el paso 0)
└── botonpago-ms/        MS compartido entre funcionalidades: el estándar instalado como compartido, sin código
```

Todos los repos están en `Desarrollo-CI`, sin remoto. El "MR" se simula con `ci/sdd-checks.sh` y un `git merge --no-ff`.

---

## Paso 0 · Preparación (una vez)

1. VS Code y la extensión de GitHub Copilot actualizadas, con tu sesión iniciada. Requisitos en la terminal: `specify` (`uv tool install specify-cli`), `git` y `node`.

### 0.1 Instalar el estándar SDD en tu repo (eres el dev)

Tu repo `boton-pago-generico-bff` tiene solo el código NestJS. Instala el bloque SDD desde `sdd-plataforma`. Es un cambio como cualquier otro, así que va en una rama `feature/` y entra por "MR":

```bash
cd ~/Documents/harness/boton-pago-generico-bff
git switch Desarrollo-CI
git switch -c feature/sdd-plataforma

sh ../sdd-plataforma/scripts/sdd-instalar.sh --revisar . capa hades/boton-pago-generico   # qué falta (todo FALTA)
sh ../sdd-plataforma/scripts/sdd-instalar.sh . capa hades/boton-pago-generico             # instala
git status                                                       # mira qué llegó
```

Qué debería llegar:
- `.specify/`: Spec Kit, el preset `sdd-gerencia` y las extensiones `git`, `bug`, `fdt` y `sdd`.
- `.github/`: skills, agentes, hook, instrucciones y versión registrada (con célula `hades` y funcionalidad `boton-pago-generico`).
- `ci/`: los controles.
- `.gitlab/merge_request_templates/`: las plantillas de MR.
- `specs/mapa.txt`.

### 0.2 Completar `.github/copilot-instructions.md`

El instalador deja una plantilla con el repo, la célula y la funcionalidad ya puestos, y marcas `<...>` que escribe la célula. Reemplázalas así:

| Marca | Valor |
| --- | --- |
| `<capa: App \| BFF \| API \| MS>` y `<capa>` | `BFF` (borra el comentario de repo compartido: este BFF es propio de la funcionalidad) |
| `<framework, lenguaje, versión de Node>` | NestJS 12, TypeScript con ESM (los imports relativos llevan `.js`), Node 22 o superior; tests con vitest y supertest; lint con oxlint `--type-aware` |
| `<reglas propias del template del equipo>` | ver el bloque de abajo |

Deja como están `<CLAVE>`, `<nombre>`, `<resumen>` y `<título del MR>`: no son marcas para llenar, son parte de las convenciones (p. ej. `feature/fdt-<CLAVE>-<nombre>`).

En "Reglas de código", pega esto:

```markdown
- Un módulo de Nest por capacidad (`src/<capacidad>/`): controller, service, DTO y puerto con su adaptador.
- Los errores responden el cuerpo `{ codigo, mensaje }` del contrato con su código HTTP.
- En el piloto `botonpago-api` no existe y `botonpago-ms` (compartido) no tiene código: el BFF usa un puerto
  (interfaz inyectable) con un adaptador en memoria precargado con los datos de prueba de la historia
  (`../celula-hades/funcionalidades/boton-pago-generico/jira/WCAP-<clave>.md`, sección "Datos de prueba"). El estado se reinicia con el proceso.
- No agregar dependencias sin justificarlas en `plan.md`.
```

Dos ajustes más:
- Si existe `AGENTS.md`, que apunte a `.github/copilot-instructions.md`.
- Opcional: en `.github/agents/*.agent.md`, descomenta la línea `model` y pon el nombre exacto del selector de modelos, con el formato `['<Nombre> (copilot)']`. Si no la tocas, anota a mano el modelo de cada fase.

Verifica, cierra el "MR" y comprueba que quedó al día:

```bash
npm test && npm run lint && npm run build
git add -A && git commit -m "Instalar estándar sdd-plataforma $(cat ../sdd-plataforma/VERSION) en el BFF"
git switch Desarrollo-CI && git merge --no-ff feature/sdd-plataforma -m "Merge branch 'feature/sdd-plataforma' into 'Desarrollo-CI'"
sh ../sdd-plataforma/scripts/sdd-instalar.sh --revisar .          # debe decir "al día"
```

Anota en resultados cuánto tomó y qué no se entendió del instalador.

### 0.3 Abrir el workspace de la historia

1. **Cierra VS Code por completo** (Cmd+Q), para que la ventana nueva herede la marca de telemetría.
2. Abre el workspace de la historia:

   ```bash
   cd ~/Documents/harness
   sh sdd-plataforma/scripts/sdd-abrir.sh WCAP-104
   ```

   Encuentra la historia en `celula-hades/funcionalidades/boton-pago-generico/jira/`, toma el tipo de pedido de su épica (WCAP-100, FUID), abre `boton-pago-generico.code-workspace`, deja el BFF, `botonpago-ms` y `celula-hades` en `Desarrollo-CI` (la spec 004 todavía no existe: la rama la crea `/speckit-specify`) y abre VS Code con `OTEL_RESOURCE_ATTRIBUTES=jira.clave=WCAP-104,jira.padre=WCAP-100,jira.tipo=FUID,sdd.funcionalidad=boton-pago-generico`.
3. Acepta **confiar en el workspace** (los hooks no corren en modo restringido).
4. Comprueba en el chat de Copilot:
   - En el selector de agentes aparecen **SDD Planner, SDD Tester, SDD Implementer y SDD Reviewer**.
   - Al escribir `/speckit-` aparecen las skills (`speckit-specify`, `speckit-fdt-assess`, `speckit-sdd-resumen-po`…).
   - Anota en resultados si aparecen **duplicadas** (una por carpeta): es uno de los puntos a validar del playbook.

> **Regla para todo el ejercicio:** cada prompt empieza diciendo en qué carpeta trabajar, porque el workspace tiene tres repos con skills (el BFF, el MS compartido y la célula).

---

## Paso 1 · Spec de la historia en `celula-hades`

**Agente: SDD Planner.** Chat nuevo.

### 1.1 Specify

```text
/speckit-specify Trabaja solo en la carpeta celula-hades, funcionalidad boton-pago-generico.
Usa la historia funcionalidades/boton-pago-generico/jira/WCAP-104.md como entrada. Es la spec 004 (campo Spec de la historia):
usa --number 004 para la rama y SPECIFY_FEATURE_DIRECTORY=funcionalidades/boton-pago-generico/specs/004-autorizacion.
Sus criterios de aceptación son los escenarios de la spec. Agrega "Jira: WCAP-104", "Épica: WCAP-100" (FUID)
y "Funcionalidad: boton-pago-generico" al encabezado.
```

Revisa:
- La rama creada es `feature/004-autorizacion` y la carpeta es `funcionalidades/boton-pago-generico/specs/004-autorizacion/` (no `specs/` en la raíz).
- Si la historia no trajera número, el agente debe usar `sh ci/siguiente-spec.sh` (número único en la célula), no el siguiente libre de Spec Kit.
- Los 5 criterios están tal cual como escenarios.
- La spec **no menciona** BFF, endpoints ni códigos HTTP.

### 1.2 Clarify (tú haces de PO)

```text
/speckit-clarify Trabaja solo en celula-hades, spec 004 de la funcionalidad boton-pago-generico.
Las preguntas que necesiten al PO déjalas también como comentario en funcionalidades/boton-pago-generico/jira/WCAP-104.md.
```

Responde como PO. Si pregunta por el **monto 0 o negativo**, es buena señal (anótalo). Para conservar el ejercicio MAU del final, responde: *"fuera de alcance de esta historia"*.

### 1.3 Impacto y resumen al PO

```text
/speckit-sdd-impacto Trabaja solo en celula-hades, spec 004 de la funcionalidad boton-pago-generico.
En este piloto solo tiene código el BFF (boton-pago-generico-bff); la app y botonpago-api no existen y botonpago-ms
(compartido) no tiene código.
```

```text
/speckit-sdd-resumen-po Trabaja solo en celula-hades, spec 004 de la funcionalidad boton-pago-generico.
```

El resumen se agrega a "Comentarios" de `funcionalidades/boton-pago-generico/jira/WCAP-104.md`. Revisa que esté en lenguaje de negocio, y que `impacto.md` tome los repos del workspace (sin inventar nombres como `front-…` o `ms-boton-pago-generico`) y marque `botonpago-ms` como compartido.

### 1.4 Aprobación del PO y merge

Simula la aprobación: en `funcionalidades/boton-pago-generico/jira/WCAP-104.md` cambia `**Estado**: Refinada` a `**Estado**: Lista para desarrollo` y agrega un comentario `### <fecha> · PO` con "Aprobado".

```bash
cd ~/Documents/harness/celula-hades
git add -A && git commit -m "WCAP-104 Spec 004 de autorización aprobada por el PO"
sh ci/sdd-checks.sh "WCAP-104 Spec de autorización · célula"     # [numeracion], [funcionalidad] y validar-specs en verde
git switch Desarrollo-CI && git merge --no-ff feature/004-autorizacion -m "Merge branch 'feature/004-autorizacion' into 'Desarrollo-CI'"
git branch -d feature/004-autorizacion                          # como GitLab al mergear; los E2E usan una rama nueva
```

---

## Paso 2 · Spec técnica, plan y tasks en `boton-pago-generico-bff`

**Agente: SDD Planner.** Chat nuevo.

### 2.1 Specify

```text
/speckit-specify Trabaja solo en la carpeta boton-pago-generico-bff (debe estar en Desarrollo-CI).
Spec técnica del BFF para la historia WCAP-104, spec 004: usa --number 004 para la rama y
SPECIFY_FEATURE_DIRECTORY=specs/004-autorizacion.
Referencia la spec de la historia ../celula-hades/funcionalidades/boton-pago-generico/specs/004-autorizacion/spec.md y el contrato
../celula-hades/funcionalidades/boton-pago-generico/contracts/boton-pago-generico-bff/autorizaciones.yaml en la versión
boton-pago-generico/contracts-v1.0.0.
No copies la spec de la historia: referencia sus escenarios.
```

### 2.2 Clarify, plan, tasks y analyze

```text
/speckit-clarify Trabaja solo en boton-pago-generico-bff, spec 004.
```

```text
/speckit-plan Trabaja solo en boton-pago-generico-bff, spec 004.
El downstream (botonpago-api y botonpago-ms, compartidos) no tiene código en el piloto: usa un puerto con adaptador
en memoria precargado con los datos de prueba de ../celula-hades/funcionalidades/boton-pago-generico/jira/WCAP-104.md. Llena la tabla "Trazabilidad SDD"
con el modelo que estás usando.
```

```text
/speckit-tasks Trabaja solo en boton-pago-generico-bff, spec 004.
```

```text
/speckit-analyze Trabaja solo en boton-pago-generico-bff, spec 004.
```

Revisa en `tasks.md`:
- Cada tarea tiene `[tester]` o `[implementer]`.
- Los tests van antes del código en cada fase.
- La última fase es la de E2E en `../celula-hades/funcionalidades/boton-pago-generico/e2e/004-autorizacion/`.
- Hay una tarea para `specs/mapa.txt`.

```bash
cd ~/Documents/harness/boton-pago-generico-bff
git add -A && git commit -m "WCAP-104 Spec técnica, plan y tasks del BFF (spec 004)"
```

---

## Paso 3 · Tests e implementación por fases

Por **cada fase** de `tasks.md`, en este orden:

1. **Chat nuevo con el agente SDD Tester:**

   ```text
   /speckit-implement Trabaja solo en boton-pago-generico-bff, spec 004. Ejecuta solo las tareas [tester] de la fase N.
   ```

   Verifica que los tests **fallan por la razón correcta** y que el commit empieza con `[tester] WCAP-104`.

2. **Chat nuevo con el agente SDD Implementer:**

   ```text
   /speckit-implement Trabaja solo en boton-pago-generico-bff, spec 004. Ejecuta solo las tareas [implementer] de la fase N.
   ```

   Verifica `npm test`, `npm run lint` y `npm run build` en verde, y que el commit empieza con `[implementer] WCAP-104`.

**Prueba del hook (hazla una vez, en un chat del Implementer):**

```text
Agrega un comentario "// prueba" en la primera línea de src/app.controller.spec.ts.
```

Debe responder que lo bloqueó la regla **tests-intactos**. Si lo edita:
- Anota en resultados que el hook por agente no funcionó en tu versión, y revierte con `git checkout src/app.controller.spec.ts`.
- El control `tests-intactos` de `ci/sdd-checks.sh` igual lo detecta en el commit.
- Revisa en **Output → GitHub Copilot Chat** (o en los logs de depuración del agente) si el hook se ejecutó.

Al terminar todas las fases de código, **en el chat del Implementer**:

```text
/speckit-converge Trabaja solo en boton-pago-generico-bff, spec 004.
```

Repite hasta que reporte "Converged".

---

## Paso 4 · E2E de la spec

La última fase de `tasks.md` es `[tester]` y escribe en el repo de la célula. Primero abre ahí la rama de tests, con el mismo nombre que la del BFF:

```bash
cd ~/Documents/harness/celula-hades
git switch Desarrollo-CI && git switch -c feature/004-autorizacion
npm ci                                   # una vez, instala Playwright
```

**Agente: SDD Tester**, chat nuevo:

```text
/speckit-implement Trabaja en boton-pago-generico-bff, spec 004. Ejecuta la fase final de E2E: los tests van en
../celula-hades/funcionalidades/boton-pago-generico/e2e/004-autorizacion/*.api.spec.ts (proyecto boton-pago-generico-api de Playwright),
uno por escenario de la spec de la historia, con tag ['@spec-004', '@WCAP-104']. Usa los datos de prueba de
../celula-hades/funcionalidades/boton-pago-generico/jira/WCAP-104.md.
```

Córrelos contra el BFF local:

```bash
# terminal 1
cd ~/Documents/harness/boton-pago-generico-bff && npm run start:dev
# terminal 2
cd ~/Documents/harness/celula-hades && sh ci/e2e.sh boton-pago-generico "@spec-004"
git add -A && git commit -m "[tester] WCAP-104 E2E de la spec 004"
```

Reinicia el BFF antes de cada corrida, porque el estado en memoria cambia cuando se autoriza un pago.

---

## Paso 5 · Revisión, controles y "MR"

1. **Chat nuevo con el agente SDD Reviewer:**

   ```text
   Trabaja solo en boton-pago-generico-bff. Revisa la rama feature/004-autorizacion contra Desarrollo-CI con tu checklist.
   El título del MR será "WCAP-104 Autorizar pago · BFF".
   ```

2. Controles locales y merge, con la plantilla `.gitlab/merge_request_templates/FUID.md` como checklist:

   ```bash
   cd ~/Documents/harness/boton-pago-generico-bff
   sh ci/sdd-checks.sh "WCAP-104 Autorizar pago · BFF"
   git switch Desarrollo-CI && git merge --no-ff feature/004-autorizacion -m "Merge branch 'feature/004-autorizacion' into 'Desarrollo-CI'"

   cd ../celula-hades
   sh ci/sdd-checks.sh "WCAP-104 E2E de autorización · célula"
   git switch Desarrollo-CI && git merge --no-ff feature/004-autorizacion -m "Merge branch 'feature/004-autorizacion' into 'Desarrollo-CI'"
   ```

3. "Despliegue a integración" y E2E sobre `Desarrollo-CI`: reinicia el BFF desde `Desarrollo-CI` y corre `sh ci/e2e.sh boton-pago-generico "@spec-004"` en `celula-hades`. Con verde, pon `**Estado**: En certificación QA` en `funcionalidades/boton-pago-generico/jira/WCAP-104.md` (QA certifica la historia; con su OK pasa a "Lista para producción").

---

## Paso 6 · Opcionales (si sobra tiempo)

**FDT técnico, épica WCAP-210 · historia WCAP-211: migrar el BFF a Node 26.** Requiere Node 26 instalado (por ejemplo `mise use node@26`).

```bash
sh sdd-plataforma/scripts/sdd-abrir.sh WCAP-211      # la historia; el tipo FDT sale de la épica WCAP-210
```

```text
/speckit-fdt-assess Trabaja solo en boton-pago-generico-bff. WCAP-211: migrar el BFF de Node 24 a Node 26. slug=node-26
/speckit-fdt-apply slug=node-26
/speckit-fdt-test slug=node-26
```

Esperado:
- La clasificación es **técnico**.
- El trabajo va en la rama `feature/fdt-WCAP-211-node-26` (clave de la historia, no de la épica).
- Corre la regresión completa.
- Pasa `SIN_CAMBIO_COMPORTAMIENTO=1 sh ci/sdd-checks.sh "WCAP-211 Migrar a Node 26 · BFF"`.

**MAU, épica WCAP-300 · historia WCAP-301: monto cero.**

```bash
sh sdd-plataforma/scripts/sdd-abrir.sh WCAP-301
```

1. Primero, con el **Tester**, escribe en `celula-hades/funcionalidades/boton-pago-generico/e2e/004-autorizacion/` (rama `feature/mau-WCAP-301-monto-cero`, que `sdd-abrir` crea en la célula) el test que reproduce el incidente, con tags `['@spec-004', '@mau', '@WCAP-301']`.
2. Luego corre:

   ```text
   /speckit-bug-assess Trabaja solo en boton-pago-generico-bff. WCAP-301: <pega el incidente de jira/WCAP-301.md> slug=monto-cero
   /speckit-bug-fix slug=monto-cero
   /speckit-bug-test slug=monto-cero
   ```

Esperado:
- El trabajo va en la rama `feature/mau-WCAP-301-monto-cero`.
- El escenario nuevo queda en la `spec.md` de la historia (`celula-hades/funcionalidades/boton-pago-generico/specs/004-autorizacion/`), en "Cambios posteriores" (regla de oro).
- `test.md` queda con resultado `verified`.

**Telemetría (opcional).** Levanta un OpenTelemetry Collector local en `localhost:4318` y activa `github.copilot.chat.otel.enabled` en el workspace (los demás ajustes de exportación están en la [documentación de VS Code](https://code.visualstudio.com/docs/agents/guides/monitoring-agents)). Valida que las trazas traigan `jira.clave=WCAP-104`, `jira.padre=WCAP-100` y `sdd.funcionalidad=boton-pago-generico`.

---

## Qué observar (y anotar en resultados)

| # | Punto del playbook a validar | Dónde se ve |
| --- | --- | --- |
| 1 | ¿Las skills y agentes de cada carpeta se resuelven en el repo correcto del workspace multi-carpeta? | Paso 0.3 y cada prompt |
| 2 | ¿`feature/NNN-nombre` y `--number 004` producen `funcionalidades/boton-pago-generico/specs/004-autorizacion/` en la célula y `specs/004-autorizacion/` en el BFF? | Pasos 1.1 y 2.1 |
| 2b | ¿`/speckit-clarify` y `/speckit-sdd-impacto` encuentran la spec fuera de `specs/` (por `.specify/feature.json`)? | Pasos 1.2 y 1.3 |
| 3 | ¿Copilot respeta las instrucciones de cada carpeta (specs sin capas, contrato sin editar, sin tocar otras funcionalidades ni `servicios/`)? | Pasos 1 y 2 |
| 4 | ¿El hook por agente bloquea al Implementer al editar tests? | Paso 3 |
| 5 | ¿El Tester deja los tests en rojo y el Implementer no los toca? | Paso 3 y `tests-intactos` |
| 6 | ¿`/speckit-converge` llega a "Converged" y en cuántas vueltas? | Paso 3 |
| 7 | ¿El código cumple el contrato (códigos 201/400/404/409/422 y cuerpo de error)? | Pasos 4 y 5 |
| 8 | Consumo: premium requests o créditos por fase, y tiempo por fase | Todo el ejercicio |
| 9 | Intervenciones: cuántas veces hubo que corregir o repetir un prompt | Todo el ejercicio |

Límites de esta prueba:
- Con una suscripción individual de Copilot no se validan las instrucciones de organización, las políticas de modelos, la allowlist de MCP ni la telemetría central.
- Jira se simula con archivos.
- No hay GitLab: los controles los corre `ci/sdd-checks.sh` y no se ejecuta ningún pipeline.
