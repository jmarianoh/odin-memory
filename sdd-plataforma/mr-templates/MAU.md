<!-- Título: "WCAP-NNN <resumen> · <capa>" con la clave de la historia. Rama feature/mau-WCAP-NNN-<slug>. -->
## Incidente

- **Historia**: WCAP-NNN · **Épica (MAU)**: WCAP-NNN · **Funcionalidad**: <funcionalidad>
- **Reportes**: `.specify/bugs/<slug>/{assessment,fix,test}.md`
- **Spec afectada**: `specs/NNN-nombre/spec.md`

## Checklist

- [ ] Test que reproduce el incidente escrito antes del fix, con tags `@spec-NNN @mau @WCAP-NNN` (clave de la historia)
- [ ] `test.md` con resultado **verified**
- [ ] Si el incidente reveló un escenario faltante: agregado a `spec.md` (regla de oro)
- [ ] Causa raíz registrada en Jira
- [ ] `sh ci/sdd-checks.sh "<este título>"` en verde

## Evidencia

<pegar resumen>
