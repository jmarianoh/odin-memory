
## Reglas de la gerencia para tasks (preset sdd-gerencia)

Estas reglas prevalecen sobre las anteriores si hay conflicto.

1. **Tests obligatorios.** Genera tareas de test aunque la spec no las pida explícitamente: test unitario por regla de negocio y test de integración del endpoint o pantalla.
2. **Rol en cada tarea.** Cada tarea lleva `[tester]` o `[implementer]` inmediatamente después del ID (`- [ ] T012 [tester] [P] [US1] ...`). Las tareas de test van **antes** que las de implementación de la misma historia, y deben quedar en rojo hasta que el Implementer termine.
3. **Fases pequeñas.** Agrupa en fases que se puedan implementar en un chat de Copilot. Cada fase termina con una tarea de commit con el mensaje `[<rol>] <CLAVE> fase N: <resumen>`.
4. **Mapa de specs.** Incluye una tarea `[implementer]` que agregue a `specs/mapa.txt` las rutas de código de esta spec (`<ruta> <###-nombre>`).
5. **Rendimiento en backend.** En repos BFF, API y MS, si `plan.md` dice "**JMeter**: sí", agrega antes de la fase E2E la fase de rendimiento de la plantilla: tareas `[tester]` para crear o actualizar `perf/###-nombre/###-nombre.jmx` y correrlo en modo humo.
6. **Última fase obligatoria: E2E.** La fase final es siempre la de E2E definida en la plantilla: un test por escenario de aceptación de `spec.md` en `../celula-<célula>/funcionalidades/<funcionalidad>/e2e/###-nombre/` (célula en `.github/sdd-plataforma.json`; la funcionalidad, en el mismo archivo o, en un repo compartido, en el campo **Funcionalidad** de `spec.md`), con tags `@spec-###` y `@<CLAVE>`, y su ejecución.
7. **Repo de la célula.** Si este repo es `celula-<célula>` (tipo `celula` en `.github/sdd-plataforma.json`), NO generes `tasks.md`: avisa que las tareas se generan en cada repo de capa.
