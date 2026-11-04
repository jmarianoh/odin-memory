---
description: "En el repo de la célula, genera impacto.md de una historia: capas que cambian, contratos, orden de despliegue y flag"
---

# Impacto por capas de una historia

Este es el "plan de sistema" de una historia en el repo de la célula (`celula-<célula>`). No es un plan técnico: dice **qué capas cambian, qué contratos se necesitan y en qué orden se despliega**, para que cada repo de capa corra después su propio flujo (`specify` → … → `implement`).

## Entrada del usuario

```text
$ARGUMENTS
```

Puede traer la ruta de la spec o la clave. Si no, usa la spec activa (`.specify/feature.json`).

## Ejecución

1. Lee `spec.md` de la historia (`funcionalidades/<funcionalidad>/specs/<NNN-nombre>/`) y, si existen, el `impacto.md` de la épica (FUID) y la spec base de la misma épica, en la misma funcionalidad.
2. Revisa `funcionalidades/<funcionalidad>/contracts/` (contratos de los servicios propios de la funcionalidad, por repo) y `servicios/<repo>/contracts/` de los API y MS compartidos que usa.
3. Lee el workspace de la funcionalidad (`funcionalidades/<funcionalidad>/<funcionalidad>.code-workspace`): es la declaración de sus repos. Toma de ahí el nombre real de cada repo y su capa (el `name` de cada carpeta, p. ej. `BFF · boton-pago-generico-bff` o `MS · botonpago-ms (compartido)`). **No deduzcas nombres de repo** a partir de la funcionalidad.
4. Para cada repo compartido que cambia, busca qué otras funcionalidades lo usan (`grep -l "<repo>" funcionalidades/*/*.code-workspace`) y regístralas en "Otras funcionalidades afectadas".
5. Escribe `funcionalidades/<funcionalidad>/specs/<NNN-nombre>/impacto.md`:

   ```markdown
   # Impacto · <CLAVE> · spec <NNN>

   ## Capas que cambian
   | Capa | Repo (del workspace) | Propio o compartido | ¿Cambia? | Qué hace en esta historia | Rama |
   | --- | --- | --- | --- | --- | --- |
   | App | <repo> | propio | sí/no/no existe | | feature/<NNN-nombre> |
   | BFF | <repo> | propio | | | |
   | API | <repo> | propio/compartido | | | |
   | MS | <repo> | propio/compartido | | | |

   ## Otras funcionalidades afectadas *(solo si cambia un repo compartido)*
   | Repo compartido | Funcionalidades que lo usan | Qué deben revisar |
   | --- | --- | --- |

   ## Contratos
   | Contrato | Dueño | Versión que se usa | ¿Hay que publicar versión nueva? | Compatible |
   | --- | --- | --- | --- | --- |

   ## Dependencias de otras historias
   - <spec 001 base, contrato de otro servicio de la célula, brecha en Arándano…>

   ## Orden de despliegue
   MS → API → BFF → app, cada capa compatible con la anterior en producción. <ajustar si alguna no cambia>

   ## Feature flag
   - Nombre propuesto: <…> · Dónde se evalúa: app

   ## Pruebas E2E
   | Escenario | Proyecto (api/ui) | Corre cuando llega a integración |
   | --- | --- | --- |
   ```

6. Si falta un contrato o hay que cambiar uno, **no lo edites aquí sin acuerdo**: regístralo en "Contratos" como versión nueva pendiente y avisa que el cambio se hace por MR propio en este repo: en `funcionalidades/<funcionalidad>/contracts/` (tag `<funcionalidad>/contracts-vX.Y.Z`) o, si es de un servicio compartido, en `servicios/<repo>/contracts/` (tag `servicios/<repo>/contracts-vX.Y.Z`), por su dueño y avisando a las otras funcionalidades que lo usan.

## Reglas

- No escribas `plan.md`, `tasks.md` ni código en el repo de la célula.
- No toques carpetas de otras funcionalidades.
- Usa solo repos que declare el workspace o que nombre la spec; si una capa no existe, márcala "no existe".
