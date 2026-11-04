<!-- Título: "WCAP-NNN <resumen> · <capa>" con la clave de la historia. Rama feature/fdt-WCAP-NNN-<slug>. -->
## Pedido

- **Historia**: WCAP-NNN · **Épica (FDT)**: WCAP-NNN · **Funcionalidad**: <funcionalidad>
- **Reportes**: `.specify/fdt/<slug>/{assessment,apply,test}.md`
- **Clasificación (regla de oro)**: contrato | comportamiento | técnico

## Checklist

- [ ] Si es contrato: nueva versión publicada por el dueño antes de este MR
- [ ] Si es comportamiento: fila en "Cambios posteriores" de la spec y resumen enviado al PO
- [ ] Si es técnico: etiqueta `sin-cambio-comportamiento` y regresión completa
- [ ] Si cambia un endpoint o el runtime de BFF, API o MS: planes JMeter afectados actualizados y corridos en modo humo
- [ ] `test.md` con resultado **verificado**
- [ ] `sh ci/sdd-checks.sh "<este título>"` en verde

## Evidencia de pruebas

<pegar resumen>

## Agente y modelo usados

<…>
