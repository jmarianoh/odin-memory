---
applyTo: "src/**/*.ts"
---

# NestJS (sdd-dev-process)

- Usa la skill `nestjs-best-practices`. Prioridad: arquitectura y módulos por feature, inyección de dependencias por constructor, manejo de errores con excepciones HTTP, seguridad.
- Un módulo por feature; controllers delgados que solo traducen HTTP; la lógica va en servicios; el acceso a datos en repositorios.
- `ValidationPipe` global con `whitelist` y `forbidNonWhitelisted`; un DTO con `class-validator` por entrada.
- Cada endpoint cumple exactamente el contrato del `plan.md`: ruta, campos, códigos de respuesta y de error. Si no coinciden, manda el contrato y se reporta la diferencia.
- Configuración con `ConfigModule`; nada de `process.env` disperso en servicios.
- Clientes HTTP salientes con timeout y tolerant reader (ignorar campos desconocidos).
- Logs con el logger del template, estructurados y sin datos sensibles.
