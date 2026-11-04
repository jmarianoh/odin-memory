---
type: Quality Gate
title: Calidad del código
description: Condiciones de calidad sobre código nuevo y reglas para cumplirlas al escribir. Fuente única para planificar, implementar y revisar en todos los stacks.
tags: [calidad, cobertura, duplicacion, complejidad, fiabilidad, todos-los-stacks]
---

# Calidad del código

Aplica a todos los stacks. Los agentes leen este archivo junto con el knowledge del arquetipo, **antes** de escribir código, y el SDD Reviewer lo usa al revisar. Los arquetipos no repiten estos números: apuntan aquí.

> **Umbrales por confirmar con la gerencia.** Los valores de la tabla son una propuesta basada en los Quality Gates habituales (SonarQube). Cuando la gerencia fije los suyos, este es el único lugar donde cambiarlos.

## Condiciones sobre código nuevo

| Condición | Umbral propuesto |
| --- | --- |
| Cobertura de tests | ≥ 80 % |
| Líneas duplicadas | ≤ 3 % |
| Mantenibilidad | A |
| Fiabilidad | A |
| Hotspots de seguridad revisados | 100 % |
| Seguridad | A |

## Cobertura

- Sobre el código nuevo del cambio, no sobre el proyecto completo.
- El umbral va configurado en el runner del template, no solo documentado. Si no lo está, se avisa.
- **Un test que falla se arregla en el código, no en el contrato.** Antes de cambiar algo, se decide cuál de los dos tiene razón. Bajar un tipo o volver opcional un campo para que el test pase no arregla nada.

## Duplicación

- Un bloque que aparece tres veces se extrae. Dos puede ser coincidencia.
- Lo transversal (mappers, validaciones, manejo de errores, clientes HTTP) va en la capa compartida del template, no copiado en cada feature.
- Los tests también son código: un setup repetido en varios archivos va a una fixture o helper.

## Mantenibilidad

| Métrica | Límite |
| --- | --- |
| Complejidad ciclomática por función | ≤ 10 |
| Profundidad de anidamiento | ≤ 3 |
| Largo de función | ≤ 50 líneas |
| Parámetros por función | ≤ 5 |

Un `if` anidado tres niveles se resuelve con retornos tempranos o extrayendo la condición a una función con nombre.

## Fiabilidad

- Recursos siempre cerrados: conexiones, archivos, streams, suscripciones (`finally`, `dispose()` en Flutter, `takeUntilDestroyed` o `DestroyRef` en Angular).
- Ninguna excepción tragada. Un `catch {}` vacío es un bug; si de verdad se ignora, lleva un comentario con el motivo.
- Comparaciones correctas: igualdad estricta en TypeScript, `null` frente a cadena vacía, tipos distintos.
- Sin código muerto ni ramas inalcanzables.
- **Dinero nunca en coma flotante:** montos en enteros (CLP) o en un tipo decimal exacto, con el redondeo explícito.
- Aritmética con cuidado: división por cero, porcentajes frente a montos absolutos.

## Hotspots de seguridad

- No generar los evitables: nada de `eval`, ejecución de comandos con entrada concatenada ni deserialización de datos del cliente sin validar.
- Los inevitables (criptografía, expresiones regulares complejas, permisos de archivo) llevan una línea que explique por qué existen y qué los acota.

## Seguridad

Es la seguridad base de `.github/instructions/sdd-dev-process.instructions.md` y, con superficie sensible, la skill `sdd-seguridad`. No se repite aquí.
