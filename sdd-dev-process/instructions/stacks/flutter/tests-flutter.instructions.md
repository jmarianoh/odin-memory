---
applyTo: "test/**,integration_test/**,**/*_test.dart"
---

# Tests en Flutter (sdd-dev-process)

- Los tests los escribe el agente **SDD Tester**; el SDD Implementer no los modifica.
- Unitarios y de widget en `test/`; flujos completos en `integration_test/`. Archivos `*_test.dart`.
- El nombre de cada test que cubre un escenario de la spec empieza con el número de la spec y el escenario: `004 › muestra error si el monto supera el límite`.
- Widget tests con `WidgetTester` y finders por texto, key o semántica; mocks solo de los bordes (cliente HTTP, almacenamiento) con `mockito` o el paquete del template.
- Arrange / Act / Assert explícitos y datos de prueba con valores del dominio (montos en CLP, RUT de prueba).
- Los tests deben fallar por la razón correcta antes de la implementación.
