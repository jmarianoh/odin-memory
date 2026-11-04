# Instrucciones de Copilot · __REPO__ (capa <capa>)

<!-- Generado desde sdd-plataforma/instructions/capa. Completar las secciones marcadas <...>. -->

## Qué es este repo

- Capa **<capa: App | BFF | API | MS>** de la funcionalidad **__FUNCIONALIDAD__**, de la célula **__CELULA__**.
  <!-- Si este repo es un API o MS compartido entre funcionalidades (`"compartido": true` en .github/sdd-plataforma.json),
       reemplaza la línea anterior por: "Capa <API | MS> compartida por las funcionalidades <lista>, de la célula __CELULA__".
       En un repo compartido la funcionalidad de cada historia sale de su spec (campo **Funcionalidad**). -->
- Stack: <framework, lenguaje, versión de Node>.
- Comandos:
  - Instalar: `npm ci`
  - Build: `npm run build`
  - Lint: `npm run lint`
  - Tests unitarios: `npm test`
  - Tests de integración: `npm run test:e2e`
  - Levantar en local: `npm run start:dev`

## Proceso SDD (obligatorio)

- Este repo sigue Spec-Driven Development con Spec Kit y el preset `sdd-gerencia`. Los principios están en `.specify/memory/constitution.md`; léelos antes de planificar o implementar.
- En Jira, toda épica (FUID, FDT o MAU) se divide en historias; aquí se trabaja siempre una historia, con su clave.
- Las specs técnicas de este repo están en `specs/NNN-nombre/`. La spec de la historia vive en el repo de la célula (`../celula-__CELULA__/funcionalidades/<funcionalidad>/specs/`) y **se referencia, no se copia**.
- Los contratos viven en el repo de la célula y **no se editan desde este repo**: los de la funcionalidad en `../celula-__CELULA__/funcionalidades/<funcionalidad>/contracts/` (tags `<funcionalidad>/contracts-vX.Y.Z`) y los de los API y MS compartidos en `../celula-__CELULA__/servicios/<repo>/contracts/` (tags `servicios/<repo>/contracts-vX.Y.Z`).
- Los tests E2E viven en `../celula-__CELULA__/funcionalidades/<funcionalidad>/e2e/` y se corren con `sh ../celula-__CELULA__/ci/e2e.sh <funcionalidad> "@spec-NNN"` (en un repo compartido, si las specs son de varias funcionalidades: `e2e.sh --todos "<tags>"`).
- Usa los agentes de `.github/agents/`: SDD Planner (specify → analyze), SDD Tester (tareas `[tester]`), SDD Implementer (tareas `[implementer]`), SDD Reviewer (revisión antes del MR).
- Ramas: `feature/NNN-nombre` (FUID), `feature/fdt-<CLAVE>-<nombre>` (FDT), `feature/mau-<CLAVE>-<nombre>` (MAU). Siempre desde `Desarrollo-CI`.
- Commits: `[tester] WCAP-NNN ...` o `[implementer] WCAP-NNN ...` (clave de la historia). Título de MR: `WCAP-NNN <resumen> · <capa>`. Nunca `Closes WCAP-NNN`.
- En BFF, API y MS, cada spec que agrega o cambia endpoints lleva su plan JMeter en `perf/NNN-nombre/` (lo ejecuta el área de performance antes del pase). Lo escribe el SDD Tester.
- Antes de pedir el MR: `sh ci/sdd-checks.sh "<título del MR>"`.
- Cuando el código de una spec cambie de ruta o se agregue, actualiza `specs/mapa.txt`.

## Reglas de código

<reglas propias del template del equipo>

## Adiciones manuales

<!-- Lo que escribe el equipo va aquí. -->
