---
applyTo: "src/**/*.ts,src/**/*.html,src/**/*.scss,src/**/*.css"
---

# Angular (sdd-dev-process)

- Usa la skill oficial `angular-developer` y revisa la versión de Angular del repo antes de proponer APIs.
- Componentes standalone, signals para el estado (`signal`, `computed`, `linkedSignal`, `resource`), control flow nativo (`@if`, `@for` con `track`, `@switch`) e `inject()` para dependencias.
- Usa el Angular CLI (`ng generate`) para crear componentes, servicios, guards y pipes, respetando la estructura del template.
- Componentes visuales del design system de la gerencia (Arándano); no importes otras librerías de UI. Lo que falte se registra como brecha en el plan.
- La app web consume solo el BFF de su funcionalidad, con el contrato del `plan.md`.
- Sin `bypassSecurityTrust*` ni `[innerHTML]` con contenido de usuario. Ningún secreto en `environment*.ts`.
- Al terminar un cambio: `ng build` sin errores.
