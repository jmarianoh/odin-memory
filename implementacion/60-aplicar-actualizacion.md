# 60 — Aplicar una actualización

Para pasar un repositorio ya construido de la versión A a la B:

1. Lee `VERSION` actual del repositorio (`implementacion/VERSION` antes de reemplazar la carpeta) y la nueva.
2. Reemplaza la carpeta `implementacion/` por la nueva.
3. Para cada `cambios/<versión>.md` con versión mayor que A y menor o igual que B, en orden ascendente:
   - Crear, modificar o borrar los archivos que indica.
   - Copiar a la raíz los archivos de `fuentes/` que cambiaron.
   - Aplicar las migraciones de esquema descritas (siempre idempotentes).
4. Ejecuta `npm test`, `npm run check:implementacion` y `npm run check:clean-room`.
5. Si algo falla, el documento del módulo afectado es la fuente de verdad.
