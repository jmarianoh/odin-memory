---
type: Domain Glossary
title: Glosario del proceso y de las subgerencias
description: Términos del proceso SDD de la gerencia y de cada subgerencia (Personas, Empresas, Adquirencia) que los agentes deben usar con el mismo significado.
tags: [glosario, proceso, personas, empresas, adquirencia]
---

# Glosario

## Proceso

| Término | Significado |
| --- | --- |
| **Funcionalidad** | Lo que la gerencia construye y mantiene (Botón Pago Genérico, Autorizar Otros Comercios, Consultar Otros Comercios, nóminas MTN, transferencias…). Tiene su app y su BFF; la API y el MS pueden ser propios o compartidos. En el repo de la célula es la carpeta `funcionalidades/<funcionalidad>/` |
| **Épica** | Pedido del PO en Jira: un FUID, un FDT o un MAU de una funcionalidad nueva o existente. Toda épica se divide en historias. Hoy la funcionalidad va en el título de la épica (`Migración Node 24 - Nóminas MTN`) |
| **Historia** | Unidad de trabajo dentro de una épica. Su clave va en la rama de FDT y MAU, en el título del MR, en los commits y en los tags de los tests |
| **FUID** | Ficha Única de Ingreso de la Demanda. Épica de funcionalidad completa; cada pantalla o capacidad que se prueba por separado es una historia con su spec |
| **FDT** | Épica de cambio puntual sobre una funcionalidad existente: actualizar un endpoint, migrar una versión de runtime o librería. Sus historias siguen la regla de oro sobre la spec vigente |
| **MAU** | Épica de corrección de un incidente en producción. Sus historias siempre agregan un test de regresión |
| **Servicio compartido** | API o MS que usan varias funcionalidades (p. ej. `botonpago-api` y `botonpago-ms`). Sus contratos van en `servicios/<repo>/contracts/` del repo de la célula; no tiene specs ni E2E propios |
| **Certificación de QA** | Validación de QA en Jira, por historia y por versión antes de cada pase. Es la primera de tres certificaciones (QA, performance, ethical hacking); sin las tres no hay pase |
| **Defecto de certificación** | Hallazgo de QA, performance o ethical hacking, registrado en Jira y enlazado a la historia. Se corrige dentro del pedido, no es un MAU |
| **Pruebas de performance** | Las ejecuta el área de performance sobre la versión completa, en el ambiente de QA, después del OK de QA y antes del pase, con los planes JMeter de BFF, API y MS. La carga y los umbrales los define el arquitecto. Requisito del pase |
| **Ethical hacking** | Pruebas de seguridad del área de ethical hacking sobre la versión completa, en el ambiente de QA, después de performance y antes del pase. Requisito del pase |
| **Plan JMeter** | `perf/NNN-nombre/NNN-nombre.jmx` en cada repo BFF, API y MS: un plan por spec que agrega o cambia endpoints. Lo escribe el SDD Tester |
| **Historia habilitadora** | Spec base de un FUID (por ejemplo, la 001): navegación, estado compartido y contratos. No es una pantalla, pero las demás dependen de ella |
| **Regla de oro** | Si un cambio toca un contrato, primero el dueño del contrato; si cambia comportamiento, primero `spec.md` y después el código; si es solo técnico, regresión completa |
| **Cambios posteriores** | Sección fija de `spec.md` donde se registra cada cambio de comportamiento después de aprobada la spec |
| **Spec de la historia** | `spec.md` en el repo de la célula (`funcionalidades/<funcionalidad>/specs/NNN-*`): qué y por qué, sin capas |
| **Repo de la célula** | `celula-<célula>`: specs de las historias, contratos y E2E de todas las funcionalidades de la célula, una carpeta por funcionalidad, más los contratos de los servicios compartidos. Numeración de specs única en la célula |
| **Spec técnica** | `spec.md`, `plan.md` y `tasks.md` en cada repo de capa: cómo se implementa en esa capa |
| **Contrato** | Interfaz entre capas, versionada con tags `<funcionalidad>/contracts-vX.Y.Z` o, si es de un servicio compartido, `servicios/<repo>/contracts-vX.Y.Z`. Solo la cambia su dueño; un cambio incompatible es versión mayor |
| **Desarrollo-CI** | Rama destino de todos los MR; se certifica en QA y desde ahí se despliega a producción |
| **master** | Respaldo de lo que está en producción |
| **Feature flag** | Interruptor que mantiene apagada en producción una funcionalidad que todavía no está certificada |
| **Nivel N0 · N1 · N2** | Cuánta ceremonia lleva un pedido según su tamaño y riesgo (ver la skill `sdd-clasificar`) |
| **Superficie sensible** | Código que exige revisión de seguridad: auth, datos personales, pagos, endpoint público con efecto, secretos, despliegue, acceso a datos |
| **Handoff** | Botón con el que un agente entrega el control al siguiente. Es la pausa del proceso |
| **Memoria del proceso** | Lo que los agentes guardan en odin-memory (servidor MCP local, `~/.odin-memory/`) para no perder contexto entre chats: estado, decisiones con su porqué, tests en rojo, avance y revisión de cada historia, con claves `sdd/<CLAVE>/<artefacto>` (skill `sdd-memoria`). Complementa al repo, que sigue siendo la fuente de verdad |
| **Arquetipo** | Combinación de subgerencia, canal y template (por ejemplo `personas-web-nest`) que define la skill y el knowledge de un repo |
| **Célula** | Equipo de 4 desarrolladores full-stack, dueño de los repos de sus funcionalidades |
| **Capa** | App, BFF, API o MS. Cada capa vive en su propio repo |

## Subgerencias

Cada subgerencia completa su sección con los términos de negocio que el agente debe conocer: definición, estados y reglas. Los términos de una funcionalidad específica van en su carpeta del repo de la célula.

### Personas

<!-- Por completar por la subgerencia de Personas. Formato: **Término** · definición · estados · reglas. -->

### Empresas

<!-- Por completar por la subgerencia de Empresas. Formato: **Término** · definición · estados · reglas. -->

### Adquirencia

<!-- Por completar por la subgerencia de Adquirencia. Formato: **Término** · definición · estados · reglas. -->

## Datos y formatos comunes

| Término | Regla |
| --- | --- |
| **Monto en CLP** | Entero, sin decimales. Nunca `float` ni `double` |
| **RUT** | Se valida con dígito verificador; se enmascara en logs y en pantallas que no lo necesitan completo |
| **Datos de prueba** | Valores ficticios del dominio (`OP-TEST-001`, RUT de prueba válidos). Nunca datos reales de clientes |
