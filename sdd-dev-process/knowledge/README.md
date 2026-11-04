# Knowledge

Referencia estable que leen los agentes y las personas al trabajar en un repo de capa. El instalador la copia a `.github/knowledge/`.

Cada documento de contenido lleva un encabezado YAML con `type`, `title`, `description` y `tags`, para que el agente elija qué leer sin abrir todo. Los README y el HTML de `guias/` no lo llevan.

## Mapa

| Necesito… | Dónde | Lo mantiene |
| --- | --- | --- |
| Entender los flujos FUID, MAU, FDT y N0 | [guias/flujos-sdd-dev-process.html](guias/flujos-sdd-dev-process.html) | sdd-dev-process |
| Términos del proceso y de las subgerencias | [dominio/glosario.md](dominio/glosario.md) | sdd-dev-process (cada subgerencia completa su sección) |
| Capas, contratos, despliegue y design system de la gerencia | [arquitectura/overview.md](arquitectura/overview.md) | sdd-dev-process |
| Reglas de calidad para escribir y revisar código | [arquitectura/calidad-codigo.md](arquitectura/calidad-codigo.md) | sdd-dev-process |
| Estructura y convenciones del template de este repo | `arquitectura/arquetipos/<arquetipo>.md` (solo el del repo) | La subgerencia dueña del template, vía sdd-dev-process |
| Sistemas externos que usa este servicio | `integraciones/` | El repo |
| Cómo se levanta, despliega y diagnostica este servicio | `operacion/` | El repo |

Lo que mantiene sdd-dev-process se sobrescribe al actualizar: los cambios se proponen por MR a sdd-dev-process. `integraciones/` y `operacion/` son del repo: el instalador las crea si faltan y no las vuelve a tocar.

## Orden de lectura para los agentes

1. La spec del pedido (`specs/NNN-*/` o el `assessment.md` de MAU y FDT) y la spec de la historia en `../celula-<célula>/funcionalidades/<funcionalidad>/specs/`.
2. `arquitectura/arquetipos/<arquetipo>.md` y `arquitectura/calidad-codigo.md`, antes de planificar o escribir código.
3. `arquitectura/overview.md` y `dominio/glosario.md` cuando el pedido cruza capas o usa términos de negocio.
4. `integraciones/` y `operacion/` si el pedido toca un sistema externo o el despliegue.
5. La skill del stack y, después, la documentación oficial del framework.

Si el knowledge del arquetipo y la skill del stack chocan, gana el knowledge del arquetipo, porque describe el template real de la subgerencia. Si el código del repo y el knowledge chocan, se avisa: uno de los dos está desactualizado.

## Qué no va aquí

| Contenido | Dónde |
| --- | --- |
| Spec, plan y tasks de un pedido | `specs/NNN-nombre/` del repo de capa |
| Spec de la historia, impacto por capa | `celula-<célula>/funcionalidades/<funcionalidad>/specs/` |
| Contratos de los servicios propios de la funcionalidad | `celula-<célula>/funcionalidades/<funcionalidad>/contracts/` |
| Contratos de los API y MS compartidos | `celula-<célula>/servicios/<repo>/contracts/` |
| Repos de la funcionalidad (app, BFF, API, MS) | `celula-<célula>/funcionalidades/<funcionalidad>/<funcionalidad>.code-workspace` |
| Tests E2E de la funcionalidad | `celula-<célula>/funcionalidades/<funcionalidad>/e2e/` |
| Reportes de MAU y FDT | `.specify/bugs/<slug>/` y `.specify/fdt/<slug>/` |
| Estado, decisiones y avance entre chats | Memoria odin-memory de cada desarrollador (`sdd/<CLAVE>/…`, skill `sdd-memoria`); no se versiona |
| Secretos y credenciales | Fuera del repo |
