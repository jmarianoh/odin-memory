
---

## Convenciones de la gerencia *(obligatorio; reemplaza lo anterior cuando choque)*

- **Tests siempre**: en esta gerencia los tests NO son opcionales. Cada historia lleva tareas de test unitario y, al final, la tarea E2E.
- **Rol de cada tarea**: toda tarea lleva `[tester]` o `[implementer]` después del ID.
  - `[tester]`: escribe o ajusta tests (`*.spec.ts`, `*.e2e-spec.ts`, `test/`, E2E en `funcionalidades/<funcionalidad>/e2e/` del repo de la célula) y planes JMeter (`perf/`). La ejecuta el agente **SDD Tester**. Los tests quedan en rojo.
  - `[implementer]`: escribe código de producción. La ejecuta el agente **SDD Implementer**, que NO puede editar archivos de test.
  - Formato: `- [ ] T010 [tester] [P] [US1] Test de ... en src/.../x.spec.ts`
- **Fases con commit**: cada fase termina con una tarea `[implementer]` o `[tester]` de commit: `git commit -m "[<rol>] WCAP-XXX fase N: <resumen>"` (clave de la historia). El prefijo `[tester]` / `[implementer]` en el mensaje lo usa el control `tests-intactos`.
- **Mapa de specs**: una tarea agrega las rutas nuevas a `specs/mapa.txt` (`<ruta> <###-nombre>`).

## Fase de rendimiento: plan JMeter *(BFF, API y MS, cuando plan.md dice "JMeter: sí"; antes de la fase E2E)*

- [ ] TXXX [tester] Crear o actualizar `perf/###-nombre/###-nombre.jmx` con los endpoints de la sección "Rendimiento (JMeter)" de `plan.md`: parametrizado con propiedades (`-Jhost`, `-Jpuerto`, `-Jusuarios`, `-Jduracion`, `-Jumbral_ms`, `-Jtoken`), datos de prueba ficticios en `perf/###-nombre/datos.csv` y sin secretos
- [ ] TXXX [tester] Correr el plan en modo humo (1 usuario, pocos segundos) contra el ambiente local o de integración y dejar la evidencia para el MR

## Fase final: E2E de la spec *(obligatoria, siempre la última)*

- [ ] TXXX [tester] Escribir o actualizar los casos E2E en `../celula-<célula>/funcionalidades/<funcionalidad>/e2e/###-nombre/`, un test por escenario de aceptación de `spec.md`, nombrados `### › <escenario>`, con tags `@spec-###` y `@<CLAVE-HISTORIA>`, en la rama `feature/###-nombre` del repo de la célula
- [ ] TXXX [tester] Correr `sh ci/e2e.sh <funcionalidad> "@spec-###"` en el repo de la célula contra el ambiente local o de integración y dejar la evidencia para el MR
