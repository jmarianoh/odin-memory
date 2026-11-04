---
description: "Corre las pruebas definidas en el assess y deja el veredicto del FDT"
---

# Verificar FDT

Corre las pruebas que definió `__SPECKIT_COMMAND_FDT_ASSESS__` y deja el veredicto en `.specify/fdt/<slug>/test.md`. El control `veredicto-fdt-mau` de la gerencia exige este archivo con resultado `verificado` antes del MR.

## Entrada del usuario

```text
$ARGUMENTS
```

## Slug

En orden: el `slug=` del usuario; el de esta sesión; el único `.specify/fdt/*/apply.md` sin `test.md`; si hay varios, pregunta.

## Requisitos previos

- `assessment.md` y `apply.md` DEBEN existir en `FDT_DIR`.
- Si `test.md` existe, pregunta antes de sobrescribir.

## Ejecución

1. Lee "Pruebas definidas" del assessment. Si es **técnico**, la regresión completa (unitarias del repo y suite E2E completa) es obligatoria.
2. Corre cada prueba. Registra comando, resultado y un extracto corto de la salida. Si una prueba no se puede correr (falta el ambiente o la herramienta), regístrala como `no-corrida` con el motivo; nunca inventes un resultado.
3. Veredicto:
   - **verificado**: todas las pruebas obligatorias pasan.
   - **parcial**: alguna obligatoria quedó `no-corrida` o es inconclusa.
   - **fallido**: alguna obligatoria falla.
4. Escribe `FDT_DIR/test.md`:

   ```markdown
   # Verificación FDT: <título>

   - **Jira**: <CLAVE> · **Slug**: <slug> · **Fecha**: <ISO 8601>
   - **Clasificación**: <del assessment>
   - **Resultado**: verificado | parcial | fallido

   ## Pruebas
   | Prueba | Comando | Resultado | Nota |
   | --- | --- | --- | --- |

   ## Extractos de salida
   <solo líneas relevantes>

   ## Riesgos residuales
   - <…>

   ## Recomendación
   <MR a Desarrollo-CI con título "<CLAVE> <resumen> · <capa>" | volver a apply | volver a assess>
   ```

5. Informa el resultado y, si es `verificado`, recuerda el título del MR con la clave al inicio.

## Reglas

- Este comando no modifica código ni specs.
- No marques `verificado` si una prueba obligatoria no se corrió.
