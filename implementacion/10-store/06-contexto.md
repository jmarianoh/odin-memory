# 10.6 — Contexto de sesión

Módulo: `src/store/context.js`. Amplían: `src/timeutil/index.js` (`parseStored`, `formatLocal`), `text.js` (`truncate`), `observations.js` (`recentUnpinnedObservations`, `compactionObservations`), `prompts.js` (`compactionPrompts`), `db.js` (`readTransaction`), `store.js` (reloj opcional) e `index.js`.

El contexto es el texto que el agente recibe al empezar (`mem_context`) o al recuperarse de una compactación: un resumen en Markdown de sesiones, prompts y observaciones.

## `timeutil`

- `parseStored(text)` → `Date` o `null`: acepta `YYYY-MM-DD HH:MM:SS` con fracción opcional (UTC) y RFC 3339 (`...T...Z` o con desfase `±HH:MM`); cualquier otra cosa → `null`.
- `formatLocal(utc, env = process.env)`: convierte una marca guardada a la zona horaria de `env.ODIN_TIMEZONE` (nombre IANA, con `Intl.DateTimeFormat('en-CA', { hourCycle: 'h23', … })`) o, si falta o es inválida, a la hora local del proceso; formato `YYYY-MM-DD HH:MM:SS` sin fracción. Un texto que no es fecha se devuelve tal cual.

## Ampliaciones

- `truncate(s, max)` (en `text.js`): recorta a `max` **caracteres** (puntos de código) y añade `...` si hubo recorte.
- `recentUnpinnedObservations(store, project, scope, limit)`: como `recentObservations` pero con `AND o.pinned = 0`; `limit <= 0` → `maxContextResults`.
- `compactionObservations(store, sessionId, project, pinned, limit)`: `WHERE o.deleted_at IS NULL AND o.session_id = ? AND LOWER(o.project) = ? AND o.pinned = ? ORDER BY datetime(o.created_at) DESC, o.id DESC [LIMIT ?]` (`project` ya normalizado).
- `compactionPrompts(store, sessionId, project, limit = 10)`: `WHERE session_id = ? AND LOWER(ifnull(project,'')) = ? ORDER BY created_at DESC LIMIT ?`.
- `Database.readTransaction(fn)`: ejecuta `fn` en una transacción diferida (`BEGIN`, siempre `ROLLBACK` al terminar): ve una instantánea coherente y no toma el bloqueo de escritura. Dentro de otra transacción solo ejecuta `fn`. Una `fn` asíncrona lanza `TypeError('readTransaction(fn): fn debe ser síncrona')`.
- `StoreConfig.now` (opcional): reloj `() => Date` del historial antiguo, solo para pruebas; se expone en `store.settings.now`.

## `formatContext(store, project = '', scope = '', opts = {})`

`opts`: `older_history`, `max_bytes`, `observations`, `prompts`, `sessions`, `pinned`, `compact`, `now`. En los cuatro contadores, **negativo omite la sección** y `0`/ausente usa el valor por defecto.

1. **Sesiones**: si `sessions >= 0`, `recentSessions(project, sessions || 5)`.
2. **Fijadas**: si `pinned >= 0`, `pinnedObservations(project, scope, pinned)` (con `0` sin tope).
3. **Observaciones**:
   - con `older_history`: `contextHistory(project, scope, observations, now)` devuelve las recientes y los grupos antiguos (ver abajo); si `observations < 0`, las recientes se descartan;
   - si no, y `observations >= 0`: `recentUnpinnedObservations(project, scope, observations || maxContextResults)`.
4. **Prompts**: si `prompts >= 0`, `recentPrompts(project, prompts || 10)`.
5. Si sesiones, fijadas, observaciones, prompts y grupos antiguos están todos vacíos → `''`.
6. **Texto**, con saltos de línea exactos:
   ```
   ## Memory from Previous Sessions\n\n
   ### Recent Sessions\n            (si hay sesiones)
   - **<project>** (<formatLocal(started_at)>)[: <summary a 200 caracteres>] [<n> observations]\n   … \n
   ### Recent User Prompts\n        (si hay prompts)
   - <formatLocal(created_at)>: <contenido a 200 caracteres>\n   … \n
   ### Pinned\n                     (si hay fijadas)
   <viñeta de observación>\n   … \n
   ### Recent Observations\n        (si hay observaciones)
   <viñeta de observación>\n   … \n
   ```
   - El resumen de sesión, solo si no es nulo, va como `: <truncate(summary, 200)>` justo tras el paréntesis.
   - Viñeta de observación: normal `- [<type>] **<title>**: <truncate(content, 300)>\n`; con `compact`: `- [<type>] **<title>**\n`.
   - Cada sección termina con una línea en blanco.
7. **Historial antiguo** (`older_history`): `budget = 2048`; si `max_bytes > 0`, `budget = min(budget, floor(max_bytes / 4))`. `older = renderContextHistory(grupos, budget)`. Si `older !== ''`, el resultado es `limitContextBytes(texto, max_bytes <= 0 ? 0 : max_bytes - bytes(older)) + older` (la parte antigua queda fuera del recorte). Si no, se sigue.
8. Resultado: `limitContextBytes(texto, max_bytes)`.

### `limitContextBytes(context, maxBytes)`

`maxBytes <= 0` o el texto cabe → igual. Marcador `"\n[truncated]\n"` (13 bytes). Si `maxBytes < 13`, devuelve solo el prefijo de `maxBytes` bytes; si no, el prefijo de `maxBytes - 13` bytes más el marcador. El prefijo se corta retrocediendo mientras el byte siguiente sea de continuación UTF-8, sin partir caracteres.

### Historial: `historyPeriods(now)` y `contextHistory`

`historyPeriods(now)` (todo en UTC) devuelve periodos del más reciente al más antiguo, ordenados por inicio descendente:

- **Semanas del mes en curso.** `month` = día 1 del mes; `next` = día 1 del mes siguiente. Desde `month`, cada periodo dura `days = (8 - díaSemana(start)) % 7` días (0 domingo … 6 sábado; si da 0 → 7), es decir, hasta el lunes siguiente, y se recorta a `next`. Etiqueta `<YYYY-MM-DD inicio>–<YYYY-MM-DD último día>` con un guion largo `–` (U+2013). `samples = 3` si `now` cae dentro del periodo, si no `1`.
- **Meses del trimestre en curso anteriores al mes actual.** Desde el primer mes del trimestre hasta antes del mes actual: etiqueta `YYYY-MM`, `samples = 0`, `monthly = true`.
- **Trimestres anteriores del año en curso.** Desde el 1 de enero en pasos de 3 meses hasta antes del trimestre actual: etiqueta `<año> Q<n>`, `samples = 0`.
- Lo anterior al 1 de enero del año en curso se agrupa por año (`strftime('%Y', created_at)`).

`contextHistory(store, project, scope, limit, now)` (en `readTransaction`):

1. `filter = "deleted_at IS NULL AND pinned = 0"` más `AND LOWER(project) = ?` y `AND scope = ?` si procede; `limit <= 0` → `maxContextResults`.
2. `recent` = las `limit` más recientes (como `recentUnpinnedObservations`).
3. `base` = `WITH recent AS (SELECT id FROM observations WHERE <filter> ORDER BY datetime(created_at) DESC,id DESC LIMIT ?), old AS (SELECT id,type,title,created_at FROM observations WHERE <filter> AND id NOT IN (SELECT id FROM recent)) ` con los argumentos `[filtro…, limit, filtro…]`.
4. Agregado: `base + SELECT <expr> AS period,type,count(*) AS cnt FROM old GROUP BY period,type HAVING period IS NOT NULL ORDER BY period DESC,type`, con `expr` = `CASE WHEN datetime(created_at) < datetime(?) THEN strftime('%Y',created_at)` (argumento: 1 de enero del año en curso en RFC 3339 `YYYY-MM-DDTHH:MM:SSZ`) seguido de, por cada periodo, ` WHEN datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?) THEN ?` (inicio, fin y etiqueta) y ` END`.
5. Grupos por `period`: `count` = suma; `types` = `"<historyLine(type)>: <n>"` por tipo (`historyLine` colapsa espacios con `goFields`).
6. Se recorren los periodos en orden: si hay grupo, `types` solo se conserva en los mensuales; si `samples > 0` se añaden hasta `samples` líneas `  - Sample #<id>: <historyLine(title)>\n` con `base + SELECT id,title FROM old WHERE datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?) ORDER BY datetime(created_at) DESC,id DESC LIMIT ?`. Los grupos restantes (años) se añaden al final por etiqueta descendente, sin tipos.

`renderContextHistory(groups, budget)` (los tamaños son **bytes UTF-8**):
- Cabecera `### Older History\nSamples are titles, not summaries; use mem_get_observation with an ID to drill in.\n`. Sin grupos o `budget <= bytes(cabecera)` → `''`.
- Líneas: por grupo `- <label>: <count> observations[ (<types separados por ", ">)]\n` seguida de sus muestras.
- Si cabecera + líneas + `\n` caben en `budget`, se devuelve completo.
- Si no, se añade línea a línea: una línea no cabe si `bytes(out) + bytes(línea) + reserva > budget`, con `reserva = 1` para la última línea y `1 + bytes("- [older groups omitted]\n")` para las demás. Al no caber: si ya se añadió alguna, se añade `- [older groups omitted]\n` si cabe (`bytes(out) + bytes(omitido) + 1 <= budget`); se detiene. Si no se añadió ninguna línea → `''`. En otro caso, `out + "\n"`.

## `formatCompactionContext(store, sessionId)`

Sesión inexistente → `session_not_found`. `project` = proyecto normalizado de la sesión. Cuenta las observaciones vivas de la sesión y proyecto (`LOWER(project) = ?`). Fijadas (sin tope), observaciones no fijadas (`maxContextResults`) y prompts (10) de esa sesión. Texto:
```
## Memory from This Session\n\n
### Session\n
- **<id>** (<formatLocal(started_at)>)[: <resumen a 200>] [<n> observations]\n\n
### Recent User Prompts\n  - <fecha>: <contenido a 200>\n …\n      (si hay prompts)
### Pinned\n  - [<type>] **<title>**: <truncate(content, 300)>\n …\n  (si hay fijadas)
### Recent Observations\n  (igual)                                  (si hay observaciones)
```

## Lógica de la herramienta `mem_context` (se implementa en la fase MCP)

El manejador usa `formatContext` así: `max_bytes` es el valor de la herramienta si es un entero positivo (por defecto 16384, tope 65536); calcula el pie `"\n---\nMemory stats: <sesiones> sessions, <observaciones> observations across projects: <proyectos>"` con las estadísticas del proyecto efectivo (`statsProject(contextProject)`; con `contextProject === ''`, es decir, ámbito `personal` sin proyecto explícito, las globales de `stats`) (`none` si no hay proyectos; con más de 8, los 8 primeros más `, +<n> more`); `budget = max(1, max_bytes - bytes(pie))`; llama a `formatContext(proyecto, ámbito, { max_bytes: budget, pinned: 20, compact, older_history })` (con ámbito `personal` y sin proyecto explícito, el proyecto es `''`); si el contexto es `''` devuelve «No previous session memories found.»; si no, `limitContextBytes(contexto + pie, max_bytes)`.

## Criterios de aceptación

```bash
node --test "test/unit/store/*.test.js" test/unit/timeutil.test.js
npm test
npm run check:implementacion
npm run check:clean-room
```
