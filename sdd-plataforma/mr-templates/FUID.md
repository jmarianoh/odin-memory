<!-- Título: "WCAP-NNN <resumen> · <capa>" con la clave de la historia. No usar "Closes WCAP-NNN". -->
## Pedido

- **Historia**: WCAP-NNN · **Épica (FUID)**: WCAP-NNN · **Funcionalidad**: <funcionalidad>
- **Spec**: `specs/NNN-nombre/spec.md` · **Spec de la historia**: `../celula-<célula>/funcionalidades/<funcionalidad>/specs/NNN-nombre/spec.md`
- **Contrato**: `<ruta>@<funcionalidad>/contracts-vX.Y.Z` o `<ruta>@servicios/<repo>/contracts-vX.Y.Z` (servicio compartido)

## Checklist SDD

- [ ] `spec.md`, `plan.md` y `tasks.md` presentes y con la clave de Jira
- [ ] `/speckit-analyze` sin hallazgos CRITICAL
- [ ] `/speckit-converge` reporta "Converged"
- [ ] Tests escritos por SDD Tester; ningún commit `[implementer]` toca tests
- [ ] `specs/mapa.txt` actualizado
- [ ] BFF, API o MS: plan JMeter en `perf/NNN-nombre/` (o "JMeter: no" con motivo en `plan.md`) y corrida de humo
- [ ] Informe del SDD Reviewer: listo para MR
- [ ] `sh ci/sdd-checks.sh "<este título>"` en verde

## Evidencia E2E

- Rama del repo de la célula: `feature/NNN-nombre` (tests en `funcionalidades/<funcionalidad>/e2e/NNN-nombre/`)
- Comando: `sh ci/e2e.sh <funcionalidad> "@spec-NNN"`
- Resultado: <pegar resumen>

## Evidencia de rendimiento *(BFF, API y MS)*

- Plan: `perf/NNN-nombre/NNN-nombre.jmx`
- Comando: `jmeter -n -t perf/NNN-nombre/NNN-nombre.jmx -Jhost=<host> -Jpuerto=<puerto> -Jusuarios=1 -Jduracion=10 -l perf/resultados/NNN.jtl`
- Resultado: <pegar resumen: muestras, errores, tiempo promedio>

## Agentes y modelos usados

| Fase | Agente | Modelo |
| --- | --- | --- |
| specify → analyze | SDD Planner | |
| tests | SDD Tester | |
| implement / converge | SDD Implementer | |
| revisión | SDD Reviewer | |
