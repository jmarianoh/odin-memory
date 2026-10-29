# 30.06 — Panel web

Spec 0.28.0 (F9.3). Un panel HTML renderizado en el servidor (`odin cloud serve`), con htmx para los fragmentos y Pico como base de estilos. Muestra lo replicado en la nube (proyectos, sesiones, observaciones, prompts, contribuidores) y, a quien administra, los controles de sincronización, los usuarios gestionados y el registro de rechazos.

## Piezas

| Módulo | Contenido |
|---|---|
| `src/cloud/server/dashboard-model.js` | `buildDashboardModel` (pliegue puro), `DashboardView` (consultas con alcance), errores `DashboardError` |
| `src/cloud/server/dashboard-store.js` | Mixin de `CloudStore`: caché del modelo, vistas, controles de proyecto, registro de rechazos, pulso de la base |
| `src/cloud/dashboard/html.js` | Etiqueta `html` con escape automático y `raw` |
| `src/cloud/dashboard/format.js` | Escapes de URL, paginación, fechas, contenido estructurado, saneamiento del destino tras el acceso |
| `src/cloud/dashboard/views.js` | Páginas y fragmentos |
| `src/cloud/dashboard/session.js` | Cookie de sesión firmada |
| `src/cloud/dashboard/routes.js` | `installDashboard(server, {secret, version})`: todas las rutas `/dashboard/*` |
| `static/styles.css` | Hoja de estilos propia (literal en `fuentes/static/styles.css`) |

Dependencias nuevas (exactas): `htmx.org` 2.0.8 y `@picocss/pico` 2.1.1. No se copian al repositorio: `GET /dashboard/static/htmx.min.js` y `…/pico.min.css` leen `node_modules/htmx.org/dist/htmx.min.js` y `node_modules/@picocss/pico/css/pico.min.css` (ubicados con `createRequire(import.meta.url).resolve('<paquete>/package.json')`); `styles.css` sale de `static/styles.css`. Los archivos se leen una vez y se sirven con `Cache-Control: public, max-age=300` y los tipos `text/javascript; charset=utf-8` / `text/css; charset=utf-8`; cualquier otro nombre (incluido `constructor`) da 404 `404 page not found`.

`CloudServer` acepta dos opciones nuevas: `jwtSecret` (clave de las sesiones; `odin cloud serve` pasa `ODIN_JWT_SECRET`) y `version` (`v<versión>` o `dev`, que el pie de página muestra tal cual; vacía = `version unknown`). El constructor llama a `installDashboard`.

## Modelo de lectura

Se calcula en memoria a partir de tres fuentes, en este orden:

1. **Chunks** (`SELECT chunk_id, project_name, created_by, created_at, payload::text FROM cloud_chunks ORDER BY created_at, chunk_id COLLATE "C", project_name COLLATE "C", created_by COLLATE "C"`), cada uno con su JSON.
2. **Mutaciones** (`cloud_mutations ORDER BY seq`).
3. **Controles** (`listProjectSyncControls()`): los proyectos registrados sin contenido aparecen vacíos.

Entidades (mapas por clave): sesión `(proyecto, id)` — el id **sin recortar** —, observación y prompt `(proyecto, sync_id recortado)`. Todos los textos se recortan al guardarse; `ChunkID` es el del primer chunk que trajo la entidad y las mutaciones lo conservan.

Por cada chunk (con proyecto no vacío): suma 1 al contador de chunks del proyecto; después

- **sesiones**: proyecto = `session.project` o el del chunk; cada campo vacío hereda el de la sesión ya conocida (`started_at`, `ended_at`, `summary`, `directory`); sin id se ignora.
- **observaciones**: proyecto = `obs.project` (si es texto) o el del chunk; con `deleted_at` no vacío se borra; si no, se guarda (`sync_id`, `session_id`, `type`, `title`, `content`, `topic_key`, `tool_name`, `created_at`).
- **prompts**: igual con `sync_id`, `session_id`, `content`, `created_at`.
- **mutaciones del chunk** (`chunk.mutations`): se aplican con la regla de abajo; un fallo aborta con `cloudstore: invalid dashboard mutation payload in chunk "<id>": …`.
- **contribuidor** (`created_by` recortado, si no está vacío): +1 chunk global y por proyecto, proyectos distintos y `LastChunkAt` (el `created_at` más reciente en RFC 3339 sin fracciones, UTC).

Regla de una mutación (`entity` ∈ `session`, `observation`, `prompt`; otras, como `relation`, se ignoran). La carga se decodifica con `decodeMutationPayload` (objeto, o cadena JSON, también anidada). La clave es `entity_key` (para sesiones tal cual; para el resto recortada).

- **sesión**: clave vacía → `payload.id`; si ambas existen y difieren → error `dashboard: session mutation key "k" does not match payload id "i"`. Proyecto = `payload.project` o el de la mutación. Se borra con `op = delete`, `deleted`, `hard_delete` o `deleted_at` no vacío; si no, los campos vacíos heredan de la sesión conocida.
- **observación / prompt**: clave = `entity_key` o `payload.sync_id`; proyecto = `payload.project` (si es texto) o el de la mutación; si queda vacío se toma el de la sesión conocida con ese id. Se borra con `op = delete`, `deleted` o `hard_delete`; si no, **cada campo vacío hereda el valor guardado** (`session_id`, `type`, `title`, `content`, `topic_key`, `tool_name`, `created_at`; el prompt solo `session_id`, `content`, `created_at`) y se conserva el `ChunkID`.

Las mutaciones del diario usan el proyecto de la fila, y además registran su clave por entidad y proyecto. **Poda**: si el diario tiene alguna fila de `observation`, se descartan las observaciones cuyo `(proyecto, clave)` no esté en el diario; igual con `prompt`; con filas de `session` se descartan las sesiones fuera del diario **salvo** las que alguna observación o prompt vivo referencia. Un proyecto sin filas de esa entidad en el diario no se poda.

Resultado: contadores por proyecto (`Chunks`, `Sessions`, `Observations`, `Prompts`), proyectos ordenados por nombre (bytes), detalle por proyecto (sesiones por `StartedAt` descendente; observaciones y prompts por `CreatedAt` descendente, con desempate determinista por proyecto e id; contribuidores del proyecto por chunks descendentes y nombre), contribuidores (chunks descendentes, nombre) y totales (`Projects`, `Contributors`, `Chunks` = suma de chunks de los proyectos). Las filas usan claves `Project`, `SessionID`, `StartedAt`, `EndedAt`, `Summary`, `Directory`, `SyncID`, `ChunkID`, `Type`, `Title`, `Content`, `TopicKey`, `ToolName`, `CreatedAt`, `CreatedBy`, `Chunks`, `Projects`, `LastChunkAt`.

### Caché

`CloudStore.dashboardModel()` devuelve el modelo guardado o lo calcula; los cálculos simultáneos comparten una sola promesa y un cálculo cuyo estado quedó obsoleto por una escritura intermedia no se guarda. `invalidateDashboard()` se llama tras `writeChunk` (solo si insertó), `insertMutationBatch`, `backfillMutationChunks` y `setProjectSyncEnabled`.

### Vistas (`DashboardView(model, allowed)`)

`allowed` nulo = todos los proyectos; un conjunto de nombres canónicos (aunque vacío) restringe: el modelo se recorta a esos proyectos (contribuidores recalculados con solo la actividad visible; totales recalculados). `DashboardView.forGrants(model, permisos)`: un permiso `*` ve todo; cada permiso se compara con `normalizeProjectGrant` de los proyectos del modelo y **un nombre normalizado que corresponde a dos proyectos no autoriza a ninguno**.

Errores (`DashboardError.code`): `dashboard_project_invalid` (nombre vacío tras canonizar), `dashboard_project_forbidden` (fuera del alcance), `dashboard_project_not_found`, `dashboard_contributor_not_found`, `dashboard_session_not_found`, `dashboard_observation_not_found`, `dashboard_prompt_not_found`.

Consultas (nombres en minúscula inicial): `listProjects(q)`, `projectDetail(p)`, `listContributors(q)`, `listRecent{Sessions,Observations,Prompts}(proyecto, q, limite)` (proyecto vacío = todos; uno inexistente → `not_found`; `limite ≤ 0` = sin límite), `*Paginated` (devuelven `{rows, total}`; `offset > total` → vacío; `limit ≤ 0` → hasta el final), `getSessionDetail/getObservationDetail/getPromptDetail`, `getContributorDetail` (sin distinguir mayúsculas; reúne lo de todos los proyectos donde participó), `listDistinctTypes` (ordenados por bytes), `adminOverview`, `counts` y `canSee/canSeeAll/scopedProject`. Búsquedas sin distinguir mayúsculas: proyectos y contribuidores por nombre; observaciones por `título + " " + tipo`; sesiones por id; prompts por contenido; el filtro `type` compara el tipo sin distinguir mayúsculas.

### Controles y registro

`listProjectSyncControls()` une los proyectos con chunks y los de `cloud_project_controls`: `{project, syncEnabled (por defecto true), pausedReason|null, updatedBy|null, updatedAt (RFC 3339 o '')}`. `getProjectSyncControl(p)` → ese objeto o `null`. `listAuditEntriesPaginated({contributor, project, outcome, occurredAtFrom, occurredAtTo}, limit, offset)` filtra por igualdad y rango, ordena `occurred_at DESC, id DESC` y devuelve `{rows: [{ID, OccurredAt, Contributor, Project, Action, Outcome, EntryCount, ReasonCode, Metadata}], total}`. `ping()` ejecuta `SELECT 1` con tope de 500 ms. `getPrincipal(id)` (en `identity.js`) devuelve `{id, kind, displayName, role, enabled}` o `principal_not_found`.

## Sesión

Cookie `odin_dashboard_session`, `Path=/dashboard`, `HttpOnly`, `SameSite=Lax`, `Max-Age=28800` (y `Secure` si la petición llegó por TLS o `X-Forwarded-Proto` contiene `https`). Valor: `base64url(JSON).base64url(HMAC)` con

- JSON: `{principal_id, principal_source, kind, role, display_name, iat, exp, session_version: 1, token_id?}` (`exp = iat + 28800` s).
- Clave: con secreto, `HMAC-SHA256(secreto, "odin-dashboard-session-key:v1")`; sin él, 32 bytes aleatorios por arranque.
- Firma: `HMAC-SHA256(clave, "odin-dashboard-principal-session:v1:" + payloadBase64)`, comparada en tiempo constante.

`parse` devuelve `null` si hay menos o más de dos partes, la firma no coincide, el JSON es ilegible, `session_version ≠ 1`, ha caducado o falta `principal_id`, `principal_source` o `role`. La cookie **nunca contiene el token**. Cada petición revalida: las sesiones gestionadas consultan `getPrincipal` y se cortan si la persona se deshabilitó o ya no existe; las heredadas (`legacy_env_sync`, `legacy_env_admin`) valen mientras la firma valga.

Modo abierto (`server.token` vacío): no hay acceso ni principal; todo el panel es accesible (sin pestaña Admin ni rutas de administración, que dan 403), con el alcance de la lista permitida del servidor.

### Alcance de datos

- Principal gestionado (o `kind` persona/cuenta de servicio): `dashboardViewForGrants(permisos concedidos)`. **Los administradores gestionados también ven solo lo concedido.**
- Resto (heredados, abierto): `dashboardView(allowlist.enrolled())` (`null` = todos los proyectos).

Administración (`isAdmin`): rol `admin` con origen `managed_token` o `legacy_env_admin`. Gestión de usuarios (`canManage`): administrador gestionado (`isManagedAdmin`).

## Acceso

- `GET /dashboard/login[?next=]`: con sesión (o modo abierto) → 303 al destino; si no, la página de acceso (formulario `token` tipo contraseña y `next` oculto si es válido).
- `POST /dashboard/login` (formulario, tope 16 KiB → 413 `login payload too large (max 16384 bytes)`; ilegible → 400 `invalid form payload`): `token` recortado, `next` del formulario o de la consulta. Con sesión/modo abierto → 303. Vacío → página con `token is required`. Se resuelve con `server.principalForToken(token)` (token de sincronización, de administración o gestionado); si falla → página con `invalid token` y evento de auditoría `dashboard.login` `denied` `invalid_token` (`actorSource: unauthenticated`, de mejor esfuerzo). Si acierta: auditoría `dashboard.login` `success` (`actorSource` = origen del principal; `actorPrincipalId` solo si es gestionado; metadatos `{source, role}` más `recovery: true` si el acceso es el de administración heredado y ya existe un administrador gestionado, o `recovery_check_failed: true` si esa consulta falló). **La auditoría del éxito falla cerrada**: si no se puede escribir → 500 `unable to create dashboard session` sin cookie. Después 303 a `postLoginPath(next)` con la cookie.
- `POST /dashboard/logout` → 303 `/dashboard/login` borrando la cookie (`Max-Age=-1`).
- Una página protegida sin sesión → 303 `/dashboard/login?next=<ruta saneada>`; con `HX-Request: true` → 401 con `HX-Redirect` a esa misma ruta.
- `sanitizeNext`: admite solo rutas que empiezan por `/` (no `//`), de origen interno, que tras decodificar y normalizar (`..`) sean `/dashboard` o cuelguen de `/dashboard/`; reescribe la ruta con `pathEscape` por segmento y la consulta ordenada por clave. Vacío/otro → `""`. `postLoginPath("")` = `/dashboard/`.

## Rutas

Las páginas completas llevan el `layout`; con `HX-Request: true` las que son pestañas devuelven solo el fragmento. Las listas parciales (`…/list`, navegador, proyecto) devuelven siempre fragmento (las del navegador, sin htmx, devuelven la página del navegador).

| Ruta | Quién | Contenido |
|---|---|---|
| `GET /dashboard`, `/dashboard/` | sesión | Portada; carga `/dashboard/stats` por htmx |
| `GET /dashboard/health` | nadie | `{"status":"ok","subsystem":"dashboard"}` |
| `GET /dashboard/stats` | sesión | Tres métricas: proyectos, contribuidores, chunks |
| `GET /dashboard/activity?project&q` | sesión | Tabla de las 25 observaciones más recientes |
| `GET /dashboard/browser?project&q&type` | sesión | Navegador: selector de proyecto, buscador, tipos y pestañas Observations/Sessions/Prompts |
| `GET /dashboard/browser/{observations,sessions,prompts}?project&q&type&page&pageSize` | sesión | Lista paginada (fragmento con htmx; la página del navegador sin él) |
| `GET /dashboard/browser/sessions/{sessionID}` | sesión | Lista de sesiones buscando ese id |
| `GET /dashboard/projects`, `/dashboard/projects/list?q&page&pageSize` | sesión | Buscador y tarjetas de proyecto (insignia «Paused» y motivo) |
| `GET /dashboard/projects/{project}` | sesión | Detalle con contadores, nota de política si está en pausa y pestañas |
| `GET /dashboard/projects/{name}/{observations,sessions,prompts}?q&type` | sesión | Primeras 50 filas del proyecto |
| `GET /dashboard/contributors`, `/list`, `/{contributor}` | sesión | Buscador, tabla paginada y detalle |
| `GET /dashboard/sessions/{project}/{sessionID}`, `/observations/{project}/{sessionID}/{syncID}`, `/prompts/…` | sesión | Detalles; un id de sesión mayor de 128 caracteres o `syncID` mayor de 128 o vacío → 404 con «Invalid … identifier.» |
| `GET /dashboard/admin`, `/health` | admin | Resumen y salud (recuentos del alcance, base conectada, proyectos en pausa) |
| `GET /dashboard/admin/projects`, `/projects/{name}/sync/form` | admin | Tabla de controles (solo proyectos del alcance) y formulario de uno |
| `POST /dashboard/admin/projects/{name}/sync` | admin | `enabled=true|false` (otro valor → 400 `invalid value for enabled: must be 'true' or 'false'`), `reason`; el proyecto debe estar en el alcance (si no 403 `forbidden`); guarda con `updatedBy` = nombre visible; 303 (o 200 con `HX-Redirect`) a `/dashboard/admin/projects` |
| `GET /dashboard/admin/audit-log`, `/list?contributor&project&outcome&from&to&page&pageSize` | admin | Registro de rechazos. `from`/`to` en RFC 3339 o `AAAA-MM-DD` (si no, 400 `invalid_time_format: "x" is not RFC3339 or YYYY-MM-DD`). **Una vista acotada a proyectos (la de los gestionados) no ve el registro: lista vacía** |
| `GET /dashboard/admin/users`, `/users/list`, `/users/{principalID}` | admin | Usuarios gestionados (el detalle: datos, tokens, permisos; 404 si no existe) |
| `POST /dashboard/admin/users` | admin gestionado | Crear (`username`, `email`, `display_name`, `role`; vacío → 400 `username is required`; error → 400 `create user: …`); 303 a `/dashboard/admin/users` |
| `POST /dashboard/admin/users/{id}/{enable,disable}` | admin gestionado | 303 a `/dashboard/admin/users` |
| `POST /dashboard/admin/users/{id}/tokens` | admin gestionado | Emite un token: página de «Token Created» con el token en claro **solo en esta respuesta**; usuario deshabilitado → 409 «Cannot Create Token» |
| `POST /dashboard/admin/tokens/{id}/revoke` | admin gestionado | `reason`, `principal_id`; 303 al detalle de la persona (o a la lista) |
| `POST /dashboard/admin/users/{id}/grants`, `…/grants/{project}/revoke` | admin gestionado | `project`; 303 al detalle |
| `GET /dashboard/bootstrap`, `POST /dashboard/bootstrap` | solo acceso heredado de administración | Primer administrador gestionado (`username`, `email`, `display_name`); sin sesión → 303 al acceso; otra sesión → 403 «forbidden: legacy dashboard recovery credential is required» con auditoría `bootstrap.dashboard` `denied` `legacy_recovery_credential_required`; nombre vacío → 400; ya hay administrador → 409 «first managed admin already exists»; éxito → 303 `/dashboard/login`. Cada resultado deja un evento `bootstrap.dashboard` (`username_required`, `managed_admin_exists`, `create_admin_failed`, `invalid_form`, éxito con el id del administrador) |

Un administrador no gestionado en una acción de gestión recibe 403 JSON `forbidden: managed admin principal is required`; sin administración en una página de administración, 403 de texto `forbidden`. Cada acción de gestión exitosa registra su evento (`user.create`, `user.enable`, `user.disable`, `token.create`, `token.revoke`, `grant.create`, `grant.revoke`) con las mismas funciones y metadatos que la API JSON (`auditEvent` de `admin.js`); si el evento falla → 500 `record audit: …`.

Los errores de lectura se traducen así (fragmento `empty-state` con `role="alert"`; con página completa va dentro de la sección «DEGRADED»): proyecto inválido o no encontrado 404 «Project not found»; fuera del alcance 403 «Project access denied»; contribuidor 404 «Contributor not found»; sesión/observación/prompt 404 «Session/Observation/Prompt not found»; cualquier otro 503 «<etiqueta> unavailable». Las listas parciales que fallan responden 502 «Service Unavailable».

## Paginación y formato

- `page` (≥ 1) y `pageSize` (< 10 → 10; > 100 → 100; por defecto 10) se leen como enteros; texto no numérico = 0. Se pide la página al almacén, se reajusta al total (`totalPages = max(⌈total/pageSize⌉, 1)`) y, si la página pedida quedaba fuera, se vuelve a pedir la última. Tamaños ofrecidos: 10, 25, 50, 100.
- `Pagination`: `offset`, `start` (0 si no hay), `end` (tope en el total), `hasPrev/hasNext`, `show` (más de una página) y `numbers()`: hasta 7 páginas se listan todas; si no, `1`, elipsis (`-1`) si la actual > 3, la vecina anterior, la actual y la siguiente (solo entre 2 y la última − 1), elipsis si la actual < última − 2, y la última. La barra muestra `«start»–«end» of «total»`, flechas, números y tamaños; con htmx usa `hx-get` (`<ruta>?page=N&pageSize=M`) con `hx-target` e `hx-include`; sin htmx, enlaces con los filtros conservados.
- `formatTimestamp`: vacío → `-`; ilegible → el texto tal cual; si no `DD Mon AAAA HH:MM` en hora local. Contribuidor/fecha ausente → `Never`.
- `truncate(texto, n)`: por caracteres; si excede añade `...`.
- Contenido estructurado: si hay campos `**What|Why|Where|Learned**:` → secciones con `<h4>` por campo; si no, si hay encabezados `## Título` → una sección por encabezado; si no, párrafos separados por línea en blanco (las líneas internas se unen con un espacio); vacío → `<p class="muted">No content captured.</p>`. La vista previa de una línea une las secciones como `Etiqueta: texto • …`, colapsa los espacios y trunca (220 caracteres en observaciones, 300 en prompts, 100 en resúmenes). Todo el texto se escapa.
- Insignia por tipo: `decision`/`architecture` → éxito; `bugfix` → peligro; `discovery`/`learning` → aviso; otro → atenuado.
- Escapes: `pathEscape` deja sin escapar `-_.~` y `$&+=:@`; `queryEscape` escapa todo salvo `-_.~` y el espacio va como `+`; las consultas se emiten ordenadas por clave.

## Marcado que fijan las pruebas

`<title>«título» — Odin Cloud</title>`; pie `ODIN CLOUD / SHARED MEMORY INDEX / LIVE SYNC READY · «versión»`; pestañas `role="tab"` con `aria-selected`; la pestaña **Admin** solo si `isAdmin`; tarjetas de proyecto con `<h3>` y tres `stat-value`; métricas `metric-value`/`metric-label`; insignias `badge badge-«variante»`; barra `pagination-bar`; listas `observation-list`, `prompt-list`, `project-grid`; tablas `data-table`; fragmentos vacíos `empty-state` con `<h3>` del título; token revelado en `<pre class="token-reveal">`; ids `browser-project`, `browser-search`, `browser-type`, `browser-content`, `browser-tabs`, `project-content`, `project-tabs`, `projects-content`, `contributors-content`, `managed-users-content`, `audit-log-content`, `audit-contributor`, `audit-project`, `audit-outcome`, `audit-from`, `audit-to`; enlaces de detalle `/dashboard/observations/<proyecto>/<sesión>/<sync_id>` (segmentos con `pathEscape`). El resto del marcado es libre mientras conserve esos puntos.

## Pruebas

`test/unit/cloud/dashboard.test.js` (piezas puras, modelo, vistas y HTTP con Postgres real). Contraste con la referencia: `upstream/conformance/dashboard.conformance.test.mjs` compara, página a página, los textos de datos (no el marcado) de 40 páginas y de las pantallas de administración, controles de sincronización y registro de rechazos.
