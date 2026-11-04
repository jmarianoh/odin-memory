---
name: sdd-memoria
description: Convención para usar la memoria persistente odin-memory (herramientas mem_*) dentro del proceso SDD. Indica qué guarda cada agente en cada paso, con qué topic_key (sdd/<CLAVE>/<artefacto>), qué lee al empezar un chat, qué no se guarda nunca y qué hacer si la memoria no está disponible. Usar al empezar un chat sobre una historia, antes de cada handoff, al cerrar una fase y al retomar un pedido después de días o de una compactación.
---

# Memoria del proceso (odin-memory)

El proceso abre un chat nuevo por fase y cada agente empieza sin contexto. **odin-memory** es la memoria de trabajo que une esos chats: guarda el estado de la historia, las decisiones con su porqué, lo que quedó en rojo y lo que falta. Es local (SQLite en `~/.odin-memory/odin.db` de cada dev) y se usa con las herramientas `mem_*` del servidor MCP `odin-memory`.

El protocolo general (cuándo guardar, cómo buscar, cierre de sesión, qué hacer tras una compactación) lo entrega odin-memory en sus propias instrucciones. Esta skill agrega solo lo del proceso SDD.

## 1. Reglas

1. **El repo manda.** La spec, `tasks.md`, los reportes de MAU y FDT y los commits son la fuente de verdad. La memoria agrega contexto (por qué, supuestos, pendientes), nunca decide el paso. Si la memoria contradice al repo, vale el repo y se corrige la memoria con `mem_update` sobre la misma observación.
2. **Leer al empezar.** `mem_search` con `sdd/<CLAVE>/` y, de los resultados, `mem_get_observation` solo de las claves que el paso necesita (tabla de la sección 2). La búsqueda devuelve vistas previas recortadas: para usar el contenido, léelo completo.
3. **Guardar antes del handoff.** El handoff cierra el chat: antes de mostrar el botón, guarda tu artefacto con `mem_save` (con `topic_key` y `capture_prompt: false`) y después `mem_session_summary`.
4. **Una clave, una observación.** Usa siempre el mismo `topic_key` para el mismo artefacto: odin actualiza la observación existente en lugar de duplicarla. Para aprendizajes del repo, pide la clave con `mem_suggest_topic_key`.
5. **Qué no se guarda nunca:** secretos, tokens, contraseñas, RUT, números de tarjeta o cuenta, montos o datos de clientes, datos de producción, ni el detalle explotable de un hallazgo de seguridad. Tampoco se copia la spec ni el plan: se guarda la ruta. Si el texto viene con un dato sensible, se resume sin él.
6. **Fail-open.** Si las herramientas `mem_*` no aparecen o fallan, dilo en una línea ("Memoria no disponible: sigo con el repo") y continúa. El proceso no depende de la memoria.
7. **Guardar no es editar.** El SDD Orquestador y el SDD Reviewer no editan archivos, pero sí guardan en la memoria.
8. **Proyecto.** odin detecta el proyecto desde el repo git: la memoria de una historia vive en el repo de capa donde se trabaja (en el paso 0 de un FUID, en el repo de la célula). Si odin responde `ambiguous_project` (workspace con varios repos), no elijas tú: pregunta al desarrollador en qué repo se está trabajando y sigue la instrucción del error. Siempre `scope: project`.

## 2. Qué guarda y qué lee cada agente

`<CLAVE>` es la clave de la historia (o del defecto de certificación). `<N>` es el número de fase de `tasks.md`; en MAU y FDT, que no tienen fases, se omite el sufijo (`tests`, `avance`).

| topic_key | Escribe | Lee | `type` | Contenido |
| --- | --- | --- | --- | --- |
| `sdd/<CLAVE>/estado` | SDD Orquestador | Todos | `architecture` | Tipo de la épica, épica, funcionalidad, nivel, superficie sensible, paso actual, siguiente agente |
| `sdd/<CLAVE>/decisiones` | SDD Planner | Tester, Implementer, Reviewer | `decision` | Decisiones de clarify, plan, `bug-assess` o `fdt-assess` con su porqué; respuestas del PO; supuestos tomados |
| `sdd/<CLAVE>/tests-fase-<N>` | SDD Tester | Implementer | `architecture` | Tests que quedaron en rojo y por qué; fixtures, mocks y datos de prueba creados |
| `sdd/<CLAVE>/avance-fase-<N>` | SDD Implementer | Orquestador, Implementer al retomar | `architecture` | Tareas cerradas, desvíos del plan, lo que quedó pendiente |
| `sdd/<CLAVE>/revision` | SDD Reviewer | Implementer, Reviewer en la segunda vuelta | `architecture` | Puntos bloqueantes y no bloqueantes, y cuáles ya se cerraron |
| `sdd/<CLAVE>/seguridad` | SDD Seguridad | Orquestador, Reviewer | `architecture` | Solo veredicto, cantidad de hallazgos por severidad y ruta de `seguridad.md`. **Sin detalles explotables** |
| `repo/<tema>` | Cualquiera | Cualquiera | `bugfix`, `pattern` o `discovery` | Aprendizaje del repo que sirve para otras historias: causa raíz no obvia, trampa del template, comando que falla y su arreglo |

Un defecto de certificación usa su propia clave (`sdd/<CLAVE-DEFECTO>/…`) y en el contenido nombra la historia a la que está enlazado.

## 3. Formato del contenido

Título corto y buscable (el mismo `topic_key` sirve). Contenido con cuatro partes:

```
**Qué**: <lo que se decidió, hizo o encontró>
**Por qué**: <el motivo; la alternativa descartada si la hubo>
**Dónde**: <rutas, commits, sección de la spec>
**Aprendido**: <lo que el próximo agente o el próximo chat debe saber>
```

Para `sdd/<CLAVE>/estado`:

```
**Qué**: FUID WCAP-104 (épica WCAP-100) · boton-pago-generico · Paso 6 de 10 · Implementar la fase 2 | sigue: SDD Implementer
**Por qué**: tareas [tester] de la fase 2 en [X] y tests en rojo (commit a1b2c3d)
**Dónde**: specs/004-autorizacion/tasks.md, fase 2 (T010–T014)
**Aprendido**: N2, superficie sensible (pagos): SDD Seguridad obligatorio antes del MR
```

## 4. Ejemplo: WCAP-104 a lo largo de los chats

1. **Orquestador**, chat 1: lee el repo, detecta el paso 3 (sin `plan.md`), lee `sdd/WCAP-104/estado` (no existe) y guarda el estado.
2. **Planner**, chat 2: lee `estado`, hace `/speckit-plan` y guarda `sdd/WCAP-104/decisiones` ("autorización síncrona contra `botonpago-api` v2 porque el PO pidió el comprobante en la misma pantalla").
3. **Tester**, chat 3: lee `estado` y `decisiones`, escribe los tests de la fase 1 y guarda `sdd/WCAP-104/tests-fase-1`.
4. **Implementer**, chat 4: lee `tests-fase-1` y `decisiones`, deja los tests en verde y guarda `sdd/WCAP-104/avance-fase-1`. Encontró que el template exige `NODE_OPTIONS=--experimental-vm-modules` para Jest: lo guarda en `repo/jest-esm` con `type: discovery`.
5. Dos días después, el **Orquestador** recupera el contexto en un chat nuevo: el repo dice en qué paso va y la memoria dice por qué y qué quedó pendiente.

## 5. Al terminar cada chat

1. `mem_save` del artefacto de tu paso (sección 2).
2. `mem_save` de cada aprendizaje del repo que valga para otras historias.
3. `mem_session_summary` con Goal, Instructions, Discoveries, Accomplished, Next Steps y Relevant Files.
4. Recién entonces, el botón de handoff.
