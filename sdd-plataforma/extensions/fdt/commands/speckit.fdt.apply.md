---
description: "Aplica el FDT evaluado y registra cualquier desvío del alcance"
---

# Aplicar FDT

Aplica el cambio evaluado por `__SPECKIT_COMMAND_FDT_ASSESS__` y deja el registro en `.specify/fdt/<slug>/apply.md`.

## Entrada del usuario

```text
$ARGUMENTS
```

## Slug

En orden: el `slug=` del usuario; el slug que reportó el assess en esta misma sesión; el único `.specify/fdt/*/assessment.md` sin `apply.md`; si hay varios, pregunta.

## Requisitos previos

- `FDT_DIR/assessment.md` DEBE existir; si no, indica correr `__SPECKIT_COMMAND_FDT_ASSESS__`.
- La rama actual debe ser `feature/fdt-<CLAVE>-<slug>`. Si no lo es, detente y avisa.
- Si la clasificación es `devolver`, detente: no hay nada que aplicar.
- Si la clasificación es `contrato` y la nueva versión del contrato todavía no está publicada, detente y recuerda que primero va el MR al dueño del contrato.

## Ejecución

1. **Confirmar el plan** en 3 a 6 viñetas a partir del assessment.
2. **Si es comportamiento**: primero edita `spec.md` de la spec afectada y agrega la fila en "Cambios posteriores" (fecha, clave, cambio, escenarios afectados). Después cambia el código.
3. **Aplicar el cambio** dentro de los archivos del assessment. Si necesitas tocar otros, regístralo en "Desvíos".
4. **Tests**: ajusta o agrega los tests unitarios que fija el assessment. Si el repo usa roles tester/implementer, los tests los escribe el agente SDD Tester.
5. **Correr verificaciones locales** (build, lint, unitarias).
6. **Commit** con el mensaje `[implementer] <CLAVE> <resumen>`.
7. **Escribir** `FDT_DIR/apply.md`:

   ```markdown
   # FDT aplicado: <título>

   - **Jira**: <CLAVE> · **Slug**: <slug> · **Fecha**: <ISO 8601>
   - **Estado**: aplicado | parcial | no-aplicado

   ## Cambios
   | Archivo | Cambio | Nota |
   | --- | --- | --- |

   ## Spec actualizada
   <ruta y fila agregada, o "no aplica (técnico)">

   ## Desvíos del assessment
   - <ninguno | desvío y motivo>

   ## Verificaciones locales
   | Comando | Resultado |
   | --- | --- |
   ```

8. **Informar** y sugerir `__SPECKIT_COMMAND_FDT_TEST__ slug=<slug>`.

## Reglas

- Cambio mínimo: no refactorices código fuera del alcance.
- Si descubres que la clasificación era incorrecta (p. ej. lo "técnico" cambia comportamiento), detén los cambios, regístralo en "Desvíos" y recomienda volver a correr el assess.
