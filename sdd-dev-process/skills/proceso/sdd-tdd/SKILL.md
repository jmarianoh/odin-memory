---
name: sdd-tdd
description: Ciclo RED-GREEN-REFACTOR con roles separados (SDD Tester escribe el test, SDD Implementer el código) y Prove-It para incidentes (MAU) y defectos de QA. Usar al escribir tests antes del código, al implementar una fase de tasks.md, al corregir un MAU o un defecto de QA, o al ajustar tests de un FDT.
---

# TDD con roles separados

El agente que escribe los tests no es el que escribe el código. El SDD Tester deja el test en rojo; el SDD Implementer lo lleva a verde sin tocarlo. Un hook (`tests-intactos`) y el control de `ci/sdd-checks.sh` lo aseguran.

## Antes del primer test

1. Lee los comandos del repo en `.github/instructions/arquetipo.instructions.md` y confírmalos contra `package.json`, `pubspec.yaml` o el pipeline. Si no calzan, gana lo que dice el repo y lo avisas.
2. Mira dónde viven los tests vecinos y cómo se nombran. Sigue esa convención.
3. Usa el comando focalizado durante el ciclo (un archivo o un nombre de test) y la suite completa al cerrar.

## RED · SDD Tester

- Un test por escenario de aceptación de `spec.md`, con el número de la spec al inicio del nombre: `004 › rechaza montos sobre el límite`.
- Arrange / Act / Assert explícitos, con datos del dominio (`OP-TEST-001`, montos en CLP, RUT de prueba válido).
- El test debe **fallar por la razón correcta**: falta la implementación, o se reproduce el incidente. Un fallo por import, sintaxis, configuración o mock mal armado no cuenta. Corrígelo hasta que falle por lo que debe.
- Un test que pasa al primer intento no prueba nada: revisa si el comportamiento ya existía o si el test no verifica lo que dice.
- No pruebes detalles de implementación (métodos privados, orden de llamadas internas).
- Commit: `[tester] <CLAVE> fase N: <resumen>`.

## GREEN · SDD Implementer

- Código mínimo para pasar los tests de la fase. Nada fuera de las tareas.
- No edites tests. Si un test parece incorrecto o contradice la spec, detente y explícalo; el SDD Tester decide.
- Verde significa: comando ejecutado y salida revisada. "Debería pasar" no es verde.

## REFACTOR · SDD Implementer

- Con todo en verde: nombres, duplicación, funciones largas, retornos tempranos.
- Corre la suite completa después de refactorizar.
- Commit: `[implementer] <CLAVE> fase N: <resumen>`.

## Prove-It para MAU

1. El SDD Tester escribe el test que reproduce el incidente según `assessment.md`. Debe fallar con el síntoma reportado (por ejemplo, espera 422 y hoy recibe 500).
2. El SDD Implementer corrige con `/speckit-bug-fix` hasta que ese test pase sin romper los demás.
3. `/speckit-bug-test` deja el veredicto. El test queda como regresión, con `@mau` y la clave si es E2E.

## Prove-It para un defecto de QA

Igual que un MAU, pero dentro del pedido: el SDD Tester reproduce el hallazgo con un test que hoy falla (tags `@spec-NNN` y la clave del defecto), el SDD Implementer corrige hasta verde y el test queda como regresión. Así lo que QA encontró a mano no vuelve a aparecer.

## FDT

- Con cambio de comportamiento: el SDD Tester ajusta primero los tests afectados (deben quedar en rojo con el comportamiento nuevo); luego el Implementer aplica.
- Solo técnico (runtime, librerías): no se escriben tests nuevos; corre la suite completa y la regresión de la funcionalidad (de todas las que usan el repo, si es un API o MS compartido).

## Evidencia

En el chat, pega solo el resumen de la salida (cuántos pasaron, cuántos fallaron y por qué). Si algo falla, muestra la parte relevante tal cual, con su traducción.
