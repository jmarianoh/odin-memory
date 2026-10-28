# 10 — Store (almacén de memoria)

El store es la capa de persistencia: una base SQLite con búsqueda de texto completo (FTS5) y toda la lógica de negocio de la memoria. Es la parte más grande del producto y se construye en varias entregas:

| Entrega | Capítulo | Contenido |
|---|---|---|
| 1 | `01-conexion-y-migraciones.md` | Directorio de datos, identidad de instalación, apertura de la base, migraciones, FTS, fence de generación, transacciones |
| 2 | `02-observaciones-sesiones.md` | Observaciones (guardado idempotente, `topic_key`, deduplicación, versiones, actualización, borrado, fijado, revisión) y sesiones básicas |
| 3 | `03-busqueda-prompts.md` | Búsqueda FTS y LIKE, línea de tiempo y prompts |
| 4 | `04-relaciones.md` | Candidatos de conflicto, relaciones y juicios |
| 5 | `05-proyectos-captura.md` | Estadísticas, listado y alias de proyectos, captura pasiva, consolidación |
| 6 | `06-contexto.md` | Contexto de sesión (`mem_context`), historial antiguo y contexto de compactación |
| 7 | `07-mantenimiento-proyectos.md` | Renombrado, fusión, poda y borrado de proyectos |
| 8 | `08-sesiones-de-runtime.md` | Registro de sesiones de runtime, continuación, concesiones, sesiones aisladas y finalización |
| 9 | `09-procedencia.md` | Procedencia de captura de proyecto, prompts al guardar y metadatos de truncamiento |
| 10 | `10-exportacion-importacion.md` | Copia directa: exportar e importar la base o un proyecto, y borrado de sesiones |

## Reglas generales del store

- **Un solo proceso, una sola conexión.** `node:sqlite` es síncrono; no hay pool. Varios procesos `odin` pueden usar la misma base a la vez gracias al modo WAL y a `BEGIN IMMEDIATE`.
- **API síncrona.** Las operaciones del store son funciones síncronas. Los llamadores asíncronos (servidor MCP, HTTP) las invocan directamente.
- **Estructura.** `Store` (en `store.js`) agrupa la conexión (`store.db`), la configuración y la identidad. Cada área funcional vive en su módulo como funciones que reciben el `store` como primer argumento: `addObservation(store, input)`.
- **Errores.** `StoreError` con `code` estable en `snake_case` para errores de uso; los errores de SQLite se propagan tal cual.
- **Marcas de tiempo.** Las escribe la aplicación con `now()` de `src/timeutil` (UTC, 9 decimales). Los `DEFAULT (datetime('now'))` del esquema usan el formato corto sin decimales.
- **Sin reparaciones de datos antiguos.** El store solo gestiona bases creadas por este programa; no incluye rutinas de saneamiento de esquemas históricos.

## Compatibilidad de formato

El esquema (tablas, columnas, orden de columnas, índices, triggers) es un contrato fijo guardado en `fuentes/test/contract/fixtures/sqlite-schema.json`. Una prueba compara la base creada con ese contrato objeto por objeto. Cualquier cambio de esquema es un cambio de especificación: sube `VERSION`, añade una migración idempotente y documenta el cambio en `cambios/`.
