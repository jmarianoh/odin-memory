---
applyTo: "**/*.spec.ts,**/*.e2e-spec.ts,test/**"
---

# Tests (estándar SDD)

- Los tests los escribe el agente **SDD Tester**; el SDD Implementer no los modifica.
- Nombre de cada test que cubre un escenario de la spec: empieza con el número de la spec y el escenario, por ejemplo `004 › rechaza montos sobre el límite`.
- Un test por regla de negocio o escenario; nada de tests que verifiquen detalles de implementación (nombres de métodos privados, orden de llamadas internas).
- Arrange / Act / Assert explícitos y datos de prueba con valores del dominio (`OP-TEST-001`, montos en CLP).
- Los tests deben fallar por la razón correcta antes de la implementación.
