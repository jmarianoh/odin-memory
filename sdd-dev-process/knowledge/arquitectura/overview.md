---
type: Architecture Overview
title: Arquitectura de la gerencia
description: Capas app, BFF, API y MS; funcionalidades con app y BFF propios y API y MS propios o compartidos; un repo por capa y uno por célula; contratos versionados; despliegue de abajo hacia arriba; design system y pruebas E2E.
tags: [arquitectura, capas, contratos, despliegue, overview]
---

# Arquitectura de la gerencia

## Capas

```
App web (Angular) · App móvil (Flutter) ── una por funcionalidad
        │  HTTPS, contrato del BFF
        ▼
BFF (NestJS o Express) ── uno por funcionalidad y canal
        │  contrato de la API
        ▼
API (NestJS o Express) ── propia o compartida entre funcionalidades
        │  contrato del MS
        ▼
MS (NestJS o Express) ── propio o compartido; datos propios
```

- La gerencia trabaja por **funcionalidades** (Botón Pago Genérico, Autorizar Otros Comercios, Consultar Otros Comercios, nóminas MTN, transferencias…). Cada funcionalidad tiene su **app y su BFF**; la **API y el MS pueden ser propios o compartidos**. Ejemplo de la célula Hades: Botón Pago Genérico, Autorizar Otros Comercios y Consultar Otros Comercios tienen cada una su app y su BFF, y comparten `botonpago-api` y `botonpago-ms`.
- Cada capa vive en su **propio repo** y la célula mantiene todos los de sus funcionalidades. Los nombres de repo no siguen una convención fija (`boton-pago-generico-bff`, `btnconsulta-bff`, `botonpago-ms`…): cada funcionalidad los declara en su workspace.
- En Jira, una **épica** es un pedido FUID, FDT o MAU de una funcionalidad nueva o existente, y se divide en historias.
- La app habla **solo con su BFF**. El BFF compone respuestas para el canal; no tiene reglas de negocio que pertenezcan a la API o al MS.

## Repos de una célula

| Repo | Qué tiene |
| --- | --- |
| App y BFF de cada funcionalidad; API y MS propios o compartidos (nombres declarados en el workspace de la funcionalidad) | Código, spec técnica (`specs/NNN-*`), `plan.md`, `tasks.md`. Un API o MS compartido registra `"compartido": true` en `.github/sdd-plataforma.json` |
| `celula-<célula>` (uno por célula) | Una carpeta por funcionalidad, `funcionalidades/<funcionalidad>/`, con `jira/`, la spec por historia e `impacto.md` (`specs/NNN-*`), los contratos de sus servicios propios (`contracts/<repo>/`), los tests Playwright (`e2e/NNN-*`: proyecto `<funcionalidad>-api` contra el BFF y `<funcionalidad>-ui` en el navegador) y el workspace con sus repos. Los contratos de los API y MS compartidos van en `servicios/<repo>/contracts/` |

- El número de spec es **único en la célula** (`ci/siguiente-spec.sh`), así no chocan ramas, tags `@spec-NNN` ni carpetas entre funcionalidades, ni en los API y MS compartidos. Una historia es de una sola funcionalidad.

## Contratos

- Se acuerdan y publican **antes** de implementar, para que las capas avancen en paralelo con mocks.
- Versionados con tags por funcionalidad, `<funcionalidad>/contracts-vX.Y.Z`, o por servicio compartido, `servicios/<repo>/contracts-vX.Y.Z`, y semver. Un contrato compartido lo cambia su dueño en su propio MR y afecta a todas las funcionalidades que lo usan; los repos de capa consumen una versión fija.
- Un cambio incompatible es versión mayor y convive con la anterior mientras haya consumidores.
- Al consumir otro servicio: tolerant reader (ignorar campos desconocidos, no fallar por opcionales ausentes).

## Despliegue

- Orden de abajo hacia arriba: MS → API → BFF → front. Cada capa es compatible con la anterior que está en producción.
- Lo que está en `Desarrollo-CI` sin certificar va con su **feature flag apagado**.
- Ningún desarrollo se da por terminado sin E2E verde, y ninguna versión llega a producción sin la suite funcional completa y tres certificaciones en Jira: **QA** (por historia y por versión), **performance** (planes JMeter de BFF, API y MS en `perf/`, con la carga y los umbrales del arquitecto) y **ethical hacking**. Performance y ethical hacking prueban la versión completa en el ambiente de QA.

## Design system

- Front web: **Arándano** (paquete npm `@arandano`). Ningún componente propio sin una brecha registrada en el plan; nada de otras librerías de UI.
- App Flutter: por definir el equivalente.

## Observabilidad y trazabilidad

- Logs estructurados, sin datos sensibles, con el identificador de correlación que defina el template.
- La clave de Jira viaja en la rama (FDT y MAU), en los commits, en el título del MR y en los tags de los tests E2E.
