---
name: flutter
description: Desarrollo de apps Flutter y Dart con las skills oficiales del equipo de Flutter y Dart (flutter/agent-plugins). Usar al crear o revisar widgets, pantallas, arquitectura por capas, navegación con go_router, llamadas HTTP, serialización JSON, layouts responsivos, localización, tests unitarios, de widget y de integración, mocks, análisis estático o conflictos de paquetes.
license: BSD-3-Clause
metadata:
  author: sdd-dev-process (gerencia), con referencias oficiales de The Flutter Authors y the Dart project authors
  version: "0.1.0"
  upstream: "https://github.com/flutter/agent-plugins @ 774dc2c1e7fa748b792ef4d12580ca73686f82a5"
---

# Flutter y Dart

Esta skill agrupa las **skills oficiales** de Flutter y Dart en una sola entrada. Cada referencia de abajo es la skill oficial tal cual, sin cambios. **El template del arquetipo manda**: si el repo ya usa un gestor de estado, una estructura de carpetas o un paquete HTTP distinto, síguelo y avisa si choca con la referencia.

## Antes de escribir código

1. Revisa las versiones de Flutter y Dart (`pubspec.yaml` → `environment`, `.fvmrc` si existe) y usa solo APIs disponibles en esas versiones.
2. Revisa el gestor de estado, el router y la estructura de `lib/` que ya usa el template.
3. Después de cada cambio: `dart format .`, `flutter analyze` sin errores y `flutter test` en verde.

## Qué referencia leer

| Tarea | Referencia oficial |
| --- | --- |
| Estructurar una feature o el proyecto (UI, lógica, datos) | [flutter-apply-architecture-best-practices](references/flutter-apply-architecture-best-practices.md) |
| Navegación, deep links | [flutter-setup-declarative-routing](references/flutter-setup-declarative-routing.md) |
| Llamar a una API REST (el BFF) | [flutter-use-http-package](references/flutter-use-http-package.md) |
| Modelos con `fromJson` y `toJson` | [flutter-implement-json-serialization](references/flutter-implement-json-serialization.md) |
| Layout para distintos tamaños de pantalla | [flutter-build-responsive-layout](references/flutter-build-responsive-layout.md) |
| Errores de layout (overflow, constraints) | [flutter-fix-layout-issues](references/flutter-fix-layout-issues.md) |
| Textos e idiomas | [flutter-setup-localization](references/flutter-setup-localization.md) |
| Test de un widget | [flutter-add-widget-test](references/flutter-add-widget-test.md) |
| Test de integración de un flujo | [flutter-add-integration-test](references/flutter-add-integration-test.md) |
| Test unitario de lógica | [dart-add-unit-test](references/dart-add-unit-test.md) |
| Mocks de servicios externos | [dart-generate-test-mocks](references/dart-generate-test-mocks.md) |
| Análisis estático y `dart fix` | [dart-run-static-analysis](references/dart-run-static-analysis.md) |
| `pub get` falla por versiones | [dart-resolve-package-conflicts](references/dart-resolve-package-conflicts.md) |
| Error en tiempo de ejecución | [dart-fix-runtime-errors](references/dart-fix-runtime-errors.md) |

Algunas referencias (errores de layout, errores en ejecución y parte de los tests de integración) usan las herramientas del **servidor MCP de Dart y Flutter** (`dart mcp-server`). Si ese servidor no está habilitado en la organización, sigue los pasos manuales de la referencia y usa la terminal.

## Reglas de la gerencia para apps

- Los tests van en `test/` (unitarios y de widget) e `integration_test/`, con archivos `*_test.dart`. El nombre del test que cubre un escenario empieza con el número de la spec: `004 › muestra error si el monto supera el límite`.
- La app consume solo el BFF de su funcionalidad, con el contrato referenciado en `plan.md`. No llama directo a APIs ni MS.
- Datos sensibles y tokens en almacenamiento seguro; ningún secreto en el código ni en `assets/`. Si el pedido tiene superficie sensible, aplica además la skill `sdd-seguridad`.
- Componentes visuales del design system de la gerencia cuando existan para Flutter; lo que falte se registra como brecha en el plan.

## Origen

Referencias copiadas de [flutter/agent-plugins](https://github.com/flutter/agent-plugins) (commit `774dc2c`, 2026-11-03), licencia BSD-3-Clause (ver `vendor/licencias/` en sdd-dev-process). Las skills `dart-*` vienen de [dart-lang/skills](https://github.com/dart-lang/skills) a través de ese repo. Se actualizan con `scripts/actualizar-skills.sh flutter`.
