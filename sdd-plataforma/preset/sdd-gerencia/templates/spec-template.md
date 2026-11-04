# Especificación: [NOMBRE DE LA CAPACIDAD]

**Jira**: [CLAVE DE LA HISTORIA, p. ej. WCAP-104]

**Épica**: [CLAVE DE LA ÉPICA, p. ej. WCAP-100]

**Tipo de pedido**: [FUID | FDT | MAU] (el de la épica)

**Funcionalidad**: [carpeta de la funcionalidad en el repo de la célula, p. ej. boton-pago-generico]

**Rama**: `feature/[###-nombre]`

**Spec de la historia** *(solo en repos de capa)*: [ruta a `../celula-<célula>/funcionalidades/<funcionalidad>/specs/###-nombre/spec.md`, o N/A si este es el repo de la célula]

**Contratos**: [ruta y versión, p. ej. `../celula-hades/funcionalidades/boton-pago-generico/contracts/boton-pago-generico-bff/autorizaciones.yaml@boton-pago-generico/contracts-v1.0.0`; de un servicio compartido: `../celula-hades/servicios/botonpago-ms/contracts/<archivo>@servicios/botonpago-ms/contracts-v1.0.0`]

**Creada**: [FECHA]

**Estado**: Borrador

**Entrada**: Descripción o historia de Jira: "$ARGUMENTS"

<!--
  REGLAS DE LA GERENCIA (no borrar este comentario):
  - La spec dice QUÉ y POR QUÉ. No menciona capas (app, BFF, API, MS), frameworks ni librerías.
  - Los criterios de aceptación de la historia de Jira (Dado / Cuando / Entonces) pasan
    tal cual a "Escenarios de aceptación". Cada escenario será un test E2E con el número
    de la spec en su nombre, p. ej. "004 › monto sobre el límite".
  - Las dudas que necesitan al PO se marcan [NEEDS CLARIFICATION: ...] y se responden en
    Jira; la respuesta queda en la sección "Aclaraciones".
-->

## Escenarios de usuario y pruebas *(obligatorio)*

<!--
  Historias priorizadas (P1, P2, ...). Cada una debe poder probarse y demostrarse sola.
-->

### Historia 1 - [Título breve] (Prioridad: P1)

[Recorrido del usuario en lenguaje simple]

**Por qué esta prioridad**: [Valor y razón]

**Prueba independiente**: [Cómo se prueba sola]

**Escenarios de aceptación**:

1. **Dado** [estado inicial], **Cuando** [acción], **Entonces** [resultado esperado]
2. **Dado** [estado inicial], **Cuando** [acción], **Entonces** [resultado esperado]

---

### Historia 2 - [Título breve] (Prioridad: P2)

[Recorrido del usuario]

**Por qué esta prioridad**: [Valor y razón]

**Prueba independiente**: [Cómo se prueba sola]

**Escenarios de aceptación**:

1. **Dado** [estado inicial], **Cuando** [acción], **Entonces** [resultado esperado]

---

### Casos borde

- ¿Qué pasa cuando [condición límite]?
- ¿Cómo responde el sistema ante [escenario de error]?

## Requisitos *(obligatorio)*

### Requisitos funcionales

- **FR-001**: El sistema DEBE [capacidad específica]
- **FR-002**: El sistema DEBE [validación o regla de negocio]
- **FR-003**: El sistema DEBE [NEEDS CLARIFICATION: dato que falta]

### Entidades clave *(si hay datos)*

- **[Entidad 1]**: [Qué representa y atributos clave, sin implementación]

## Criterios de éxito *(obligatorio)*

### Resultados medibles

- **SC-001**: [Métrica medible, independiente de la tecnología]
- **SC-002**: [Métrica medible]

## Fuera de alcance

- [Lo que esta historia explícitamente NO cubre]

## Supuestos

- [Supuestos razonables tomados cuando la historia no lo especificaba]

## Aclaraciones

<!-- Las llena /speckit-clarify. Formato: ### Sesión AAAA-MM-DD, luego "- P: ... → R: ... (fuente: PO en Jira / célula)". -->

## Cambios posteriores

<!--
  Regla de oro: si un FDT o MAU cambia un comportamiento descrito aquí, se edita esta spec
  directamente (no con /speckit-specify) y se registra una fila. Nunca se borra una fila.
-->

| Fecha | Pedido | Cambio | Escenarios afectados |
| --- | --- | --- | --- |
