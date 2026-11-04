---
applyTo: "lib/**/*.dart,pubspec.yaml"
---

# Flutter (sdd-dev-process)

- Usa la skill `flutter`, que agrupa las skills oficiales de Flutter y Dart. Revisa las versiones de Flutter y Dart del repo antes de proponer APIs.
- Arquitectura por capas (UI, lógica, datos) según la referencia oficial, respetando el gestor de estado y la estructura de `lib/` del template.
- La app consume solo el BFF de su funcionalidad, con el contrato del `plan.md`; modelos con `fromJson` y `toJson` que ignoran campos desconocidos.
- Tokens y datos sensibles en almacenamiento seguro (Keychain o Keystore). Ningún secreto en el código Dart ni en `assets/`.
- Sin `print` ni `debugPrint` con datos sensibles.
- Al terminar un cambio: `dart format .`, `flutter analyze` sin errores y `flutter test` en verde.
- No agregues paquetes a `pubspec.yaml` que no estén justificados en el plan.
