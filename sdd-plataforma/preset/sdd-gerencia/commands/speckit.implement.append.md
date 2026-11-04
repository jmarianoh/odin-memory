
## Reglas de la gerencia para implement (preset sdd-gerencia)

Estas reglas prevalecen sobre las anteriores si hay conflicto.

1. **Por fases.** Ejecuta solo la fase o el rango de tareas que el usuario indique (p. ej. "fase 2" o "T010-T015"). Si no indica nada, ejecuta solo la siguiente fase pendiente y detente.
2. **Respeta los roles.**
   - Si eres el agente SDD Implementer, ejecuta solo tareas `[implementer]` y **no edites** archivos de test (`*.spec.ts`, `*.e2e-spec.ts`, carpeta `test/`, carpeta `e2e/` del repo de la célula). Si un test parece incorrecto, detente y repórtalo; no lo cambies para que pase.
   - Si eres el agente SDD Tester, ejecuta solo tareas `[tester]` y no edites código de producción.
3. **Commit al cerrar la fase** con el mensaje `[<rol>] <CLAVE> fase N: <resumen>`.
4. **Verifica antes de marcar.** Una tarea se marca `[X]` solo si los comandos de build, lint y test del repo pasan (ver `.github/copilot-instructions.md`).
5. **Contratos.** No edites contratos; si el código no puede cumplir el contrato, detente y repórtalo.
6. **Cierre.** Al terminar la última fase de código, sugiere correr `/speckit-converge` y luego el agente SDD Reviewer.
