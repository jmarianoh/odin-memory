# Constitution de [NOMBRE DEL REPO]

Base: preset `sdd-gerencia` de `sdd-plataforma`. La célula puede agregar principios propios al final, en "Ajustes de la célula", por MR.

## Principios de la gerencia

### I. La spec dice qué y por qué; el plan dice cómo
`spec.md` no menciona capas, frameworks ni librerías. App, BFF, API y MS aparecen solo en el plan, los contratos y las tareas.

### II. Una capacidad que se prueba por separado
La unidad de trabajo es una capacidad demostrable y probable en E2E por sí sola, no una pantalla.

### III. Contratos primero (NO NEGOCIABLE)
Los contratos se acuerdan y versionan por su dueño antes de implementar. Un repo de capa consume una versión fija y nunca edita un contrato que no es suyo. Un cambio incompatible es versión mayor.

### IV. Tests primero y separados del código (NO NEGOCIABLE)
El agente que escribe los tests (SDD Tester) no es el que escribe el código (SDD Implementer). El Implementer no modifica tests para hacerlos pasar; si un test parece incorrecto, se detiene y lo reporta.

### V. Implementar por fases
Una fase o rango de tareas por vez, chat nuevo por fase, commit al cerrar cada una, y `/speckit-converge` hasta "Converged".

### VI. Revisión humana entre fases
El PO aprueba la spec (en Jira), ingeniería el plan y un revisor el código. Tests y CI son la fuente de verdad, no el "listo" del agente.

### VII. Regla de oro
Si un cambio altera un comportamiento descrito en una spec, primero se actualiza la spec (sección "Cambios posteriores") y después el código. Si es solo técnico, regresión completa.

### VIII. Terminado = E2E verde
Una spec está terminada solo con todos sus escenarios E2E verdes en integración y la suite funcional sin regresiones.

### IX. Trazabilidad con Jira
Toda épica de Jira (FUID, FDT o MAU) se divide en historias, y se trabaja siempre una historia. La clave de la historia va en el encabezado de `spec.md` (con su épica y su funcionalidad), en el título de cada MR, en los commits y en los tags de los tests (`@WCAP-NNN`). No se usa `Closes WCAP-NNN` en MR de capa.

### X. Versión fijada
Spec Kit, el preset y las extensiones se fijan por versión y se actualizan de forma centralizada desde `sdd-plataforma`.

## Ramas

- Las ramas salen de `Desarrollo-CI` actualizada: `feature/NNN-nombre` (FUID), `feature/fdt-<clave>-<nombre>` (FDT), `feature/mau-<clave>-<nombre>` (MAU).
- Los MR van siempre a `Desarrollo-CI`, nunca a `master`.

## Ajustes de la célula

[Principios propios de la célula o del repo, con justificación]

## Gobierno

Esta constitution prevalece sobre otras prácticas. Cambios a los principios de la gerencia: MR en `sdd-plataforma`. Cambios a "Ajustes de la célula": MR revisado por el líder técnico.

**Versión**: 1.0.0 | **Ratificada**: [FECHA] | **Última modificación**: [FECHA]
