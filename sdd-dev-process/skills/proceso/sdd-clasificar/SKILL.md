---
name: sdd-clasificar
description: Clasifica un pedido de Jira antes de trabajarlo. Indica el tipo de pedido (FUID, FDT o MAU) o si es un defecto de QA, el nivel (N0, N1 o N2), si hay superficie sensible y qué agentes y pasos corresponden. Usar al iniciar un pedido, al recibir un defecto de QA, cuando el SDD Orquestador decide el camino o cuando cambia el alcance de un pedido en curso.
---

# Clasificar un pedido

## 1. Tipo de pedido

Lo decide el PO al abrir el pedido en Jira. Aquí solo se lee y se valida.

| Tipo | Qué es | Rama | Camino |
| --- | --- | --- | --- |
| FUID | Funcionalidad completa; cada historia es una spec | `feature/NNN-nombre` | specify → clarify → plan → tasks → analyze → tests e implementación por fases → converge |
| FDT | Cambio puntual (endpoint, versión de runtime, librería) | `feature/fdt-<CLAVE>-<nombre>` | fdt-assess → (tests) → fdt-apply → fdt-test |
| MAU | Incidente en producción | `feature/mau-<CLAVE>-<nombre>` | bug-assess → test que reproduce → bug-fix → bug-test |

- Si un FDT resulta ser una funcionalidad nueva, se devuelve al PO para abrirlo como FUID.
- Los defectos que aparecen durante un FUID o un FDT se corrigen dentro de ese mismo pedido; MAU es solo para producción.
- **Certificaciones antes del pase:** QA certifica cada historia y la versión; después, sobre la **versión completa** y en el **ambiente de QA**, el área de performance ejecuta los planes JMeter de BFF, API y MS (carga y umbrales del arquitecto) y el área de ethical hacking prueba la seguridad. **Sin los tres OK no hay pase.**
- **Defecto de certificación:** si QA, performance o ethical hacking encuentran algo, abren un defecto en Jira enlazado a la historia ("bloquea a <CLAVE>"). No es un pedido nuevo: se clasifica con la sección 3 bis y, si hay que corregir, se trabaja en `feature/NNN-<qa|perf|eh>-<CLAVE-DEFECTO>-<nombre>` con el número de la spec de la historia.
- **Regla de oro:** si el cambio toca un contrato, primero el dueño del contrato. Si cambia un comportamiento descrito en una spec, primero se actualiza `spec.md` ("Cambios posteriores") y después el código. Si es solo técnico, regresión completa.

## 2. Nivel

| Nivel | Criterio | Qué cambia |
| --- | --- | --- |
| **N0** | 1 archivo, cambio mecánico, reversible, sin lógica de negocio, sin contrato y **sin superficie sensible** | Sin plan ni tasks. El Implementer edita, muestra el diff real y corre build y tests. Igual lleva rama y clave |
| **N1** | Hasta 5 criterios de aceptación, sin superficie sensible, sin integración externa nueva | Camino completo del tipo de pedido |
| **N2** | 6 o más criterios, lógica de negocio relevante, integración externa nueva o superficie sensible | Camino completo, más SDD Seguridad obligatorio si hay superficie sensible |

- Un N0 que crece (2 o más archivos, lógica, contrato o superficie sensible) se detiene y sube a N1. No se termina "porque ya empezó".
- Ante la duda entre dos niveles, se elige el más alto.

## 3. Superficie sensible

Revisa la lista de [references/superficie-sensible.md](references/superficie-sensible.md). Si una superficie aplica:

- El pedido **nunca** es N0.
- Se deja escrito en `plan.md` o en `assessment.md`: qué superficies aplican y por qué.
- **SDD Seguridad** revisa antes del MR y deja `seguridad.md` con veredicto.

En las subgerencias de Personas, Empresas y Adquirencia, casi todo lo que mueve dinero o identifica a un cliente es superficie sensible: pagos, montos, nóminas, comercios, tarjetas, RUT y datos de contacto.

## 3 bis. Defecto de certificación

**De QA:** compara el hallazgo con `spec.md` (escenarios, aclaraciones, cambios posteriores) y con el contrato del `plan.md`:

| El hallazgo es… | Ejemplo | Qué se hace |
| --- | --- | --- |
| **El código no cumple la spec** | La spec dice 422 sobre 2M y responde 201 | Prove-It: SDD Tester escribe el test que lo reproduce, SDD Implementer corrige, revisión, MR y QA vuelve a certificar |
| **La spec no lo dice** | QA esperaba un redondeo que la spec no define | Regla de oro: decide el PO en Jira. Si lo acepta, el SDD Planner actualiza `spec.md` (Aclaraciones o Cambios posteriores) y sigue como el caso anterior. Si es alcance nuevo, va como otra historia o FDT |
| **El caso de QA no calza con la spec aprobada** | QA probó con un límite distinto al acordado | Gana la spec. Se responde en el defecto con el escenario de la spec y QA ajusta su caso. Si el PO le da la razón a QA, pasa a "la spec no lo dice" |
| **Diferencia entre capas** | El front envía un campo que el BFF no espera | El contrato manda: se corrige la capa que no lo cumple. Si el contrato está mal, primero el MR del contrato |
| **Ambiente o datos** | Servicio caído en QA, datos de prueba incompletos | Sin cambio de código: se resuelve con quien opera el ambiente y QA vuelve a probar |

**De performance:** compara con la sección "Rendimiento (JMeter)" de `plan.md` y con el plan en `perf/NNN-*/`:

| El hallazgo es… | Qué se hace |
| --- | --- |
| **El código no cumple el umbral** | SDD Implementer optimiza; el plan JMeter con su umbral es la prueba (humo antes del MR, carga la repite performance) |
| **El plan JMeter está mal** (ruta, cuerpo o aserción distintos al contrato, datos insuficientes) | SDD Tester corrige el plan; sin cambio de código |
| **El umbral o la carga no estaban definidos** | Los define el arquitecto y se registran en `plan.md` |
| **Ambiente o infraestructura** | Sin cambio de código: lo resuelve quien opera el ambiente |

**De ethical hacking:** siempre es superficie sensible. Clasifica la severidad que informó el área (crítica y alta bloquean el pase) y si es del código de la célula, de una dependencia (FDT de actualización) o de configuración del ambiente. La corrección del código pasa por el SDD Seguridad antes del MR, y el hallazgo se agrega a la checklist de `sdd-seguridad` si faltaba.

Deja escrito el texto para comentar en el defecto de Jira: la clasificación, el escenario de la spec, el umbral o la severidad que aplica, y el siguiente paso. Si el defecto no bloquea, el PO decide si la historia sale con el defecto registrado; la corrección pasa entonces a un FDT.

## 4. Supuestos

Si para clasificar llenaste un hueco (por ejemplo, el número de criterios no está claro), escríbelo en un bloque **Supuestos que estoy tomando** (máximo 4) y sigue. Si hay conflicto, superficie sensible dudosa o falta la clave de Jira, pregunta antes de seguir.

## 5. Salida

```
Tipo: <FUID|FDT|MAU> · Clave: <CLAVE> · Nivel: <N0|N1|N2>
Superficie sensible: <no | sí: pagos, datos personales, ...> (motivo)
Camino: <pasos y agentes>
```
