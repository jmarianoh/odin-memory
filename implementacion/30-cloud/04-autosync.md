# 30/04 — Sincronización por mutaciones y autosync

Módulos: `src/cloud/autosync.js`, `src/cli/autosync.js`, `MutationTransport` en `src/cloud/remote.js`, `src/store/sync-queue.js`, el relleno del diario en `src/store/journal.js` y el dominio de la nube en `src/store/sync-apply.js`.

Complementa a la sincronización por chunks (`01-cliente.md`): en lugar de intercambiar chunks bajo demanda, un trabajador en segundo plano empuja el **diario local** (`sync_mutations`) a la nube y lee por cursor las mutaciones de los demás. Es opcional y vive en los procesos largos (`odin serve` y `odin mcp`).

## Activación

`tryStartAutosync(cli, store, config)` (`src/cli/autosync.js`) arranca el gestor solo si `ODIN_CLOUD_AUTOSYNC` vale exactamente `1` (recortado). Nunca es fatal; lo que falta se anota en el error estándar y no arranca:

1. Configuración ilegible → `[autosync] ERROR: cannot read cloud config: <detalle>`.
2. Sin token (el de `ODIN_CLOUD_TOKEN` o el de `cloud.json`) → `[autosync] ERROR: cloud token is not configured (set ODIN_CLOUD_TOKEN or store token in cloud.json via \`odin cloud config\`); autosync disabled`.
3. Sin servidor → `[autosync] ERROR: cloud server URL is not configured (set ODIN_CLOUD_SERVER or run \`odin cloud config --server <url>\`); autosync disabled`.
4. URL inválida o `http` con token → `[autosync] ERROR: invalid server URL "<url>": <detalle>; autosync disabled`.
5. Si todo está bien: crea un `MutationTransport` y un `AutosyncManager`, lo arranca y escribe `[autosync] started (server=<url>)`.

`odin serve` lo arranca antes de escuchar, avisa al gestor tras cada escritura local (`onWrite` → `notifyDirty`) y lo para (`await stop()`) al apagarse; `odin mcp` lo arranca antes del servidor y lo para al terminar. `Cli.autosync` permite sustituir la configuración del gestor y `Cli.fetch` el `fetch` (pruebas).

### Estado que ve la API local

`GET /sync/status` usa `localSyncStatus` (el estado del almacén con la configuración de la nube real y, sin proyecto en la petición, el proyecto del proceso —`ODIN_PROJECT`— o el del directorio sin escribir vínculos) y, con el gestor activo, `autosyncSyncStatus`, que lo traduce:

| Fase del gestor | `phase` | `reason_code` / `reason_message` |
|---|---|---|
| `healthy` | `healthy` | vacíos |
| `pushing`, `pulling`, `idle` | `running` | vacíos |
| `push_failed`, `pull_failed`, `backoff` | `degraded` | el del gestor o `transport_failed`; el mensaje del gestor o el último error |
| `disabled` | `degraded` | `upgrade_paused`; el mensaje del gestor |

Además: `enabled: true`, `last_error`, `consecutive_failures`, `backoff_until` y `last_sync_at` (RFC 3339 con `Z`, o `null`), `deferred_count`, `dead_count` y los campos `upgrade_*` del estado del almacén.

## Transporte (`MutationTransport`)

`new MutationTransport(baseUrl, token, { fetch, log })`: mismas reglas de URL y token que `RemoteTransport` (un token exige HTTPS).

- `pushMutations(entries)`: `POST /sync/mutations/push` con `{ entries: [ { project, entity, entity_key, op, payload } ] }`; la carga (texto JSON del diario) se envía como valor JSON (una carga ilegible lanza `cloud: marshal mutation push: <detalle>`). Devuelve `accepted_seqs`.
- `pullMutations(sinceSeq, limit)`: `GET /sync/mutations/pull?since_seq=<n>&limit=<n>` → `{ mutations, has_more, latest_seq }`.
- Errores: como los de chunks (`cloud: mutation push|pull: status <n>: <detalle>`, con clase, código y clasificación 401/403), y un 404 recibe `errorCode = "server_unsupported"` y se anota `[autosync] cloud mutation endpoint returned 404 (server_unsupported); deploy the new server first before enabling ODIN_CLOUD_AUTOSYNC=1`. Fallos de red: `cloud: mutation push: <detalle>`.

## Gestor (`AutosyncManager`)

`new AutosyncManager(store, transport, config)` con `config` (todo opcional; un valor no positivo usa el defecto): `targetKey` (`cloud`), `leaseInterval` 60 000 ms, `debounce` 500, `pollInterval` 30 000, `pushBatchSize` 100, `pullBatchSize` 100, `maxConsecutiveFailures` 10, `baseBackoff` 1 000, `maxBackoff` 300 000, y por inyección `leaseOwner`, `log`, `random`, `now`.

- `start()` (idempotente) programa un ciclo cada `pollInterval`; `notifyDirty()` (solo si está en marcha) programa uno tras `debounce`, agrupando avisos seguidos; `runOnce()` lanza un ciclo ya. Nunca hay dos ciclos a la vez. `stop()` para los temporizadores, espera al ciclo en curso y suelta el arriendo.
- `status()` → `{ phase, lastError, consecutiveFailures, backoffUntil, lastSyncAt, reasonCode, reasonMessage, deferredCount, deadCount }` (los recuentos, del almacén para el destino).
- `stopForUpgrade(project)` / `resumeAfterUpgrade(project)`: pausa (fase `disabled`, motivo `paused`, mensaje `autosync paused for cloud upgrade rollback on project "<p>"`) sin soltar el arriendo, y reanuda (fase `idle`, aviso). Un proyecto en blanco lanza `autosync stop|resume requires project`. Mientras está en pausa no se ejecutan ciclos y el estado en memoria no cambia.
- Un error inesperado en un ciclo se anota (`[autosync] PANIC in cycle: …`), deja la fase `backoff` con motivo `internal_error`, cuenta un fallo y espera `computeBackoff` (la base si ni eso funciona).

### Ciclo

1. Pausado → nada. Con `consecutiveFailures ≥ maxConsecutiveFailures` y la espera vigente → fase `backoff` y nada. Con la espera vigente → nada.
2. `acquireSyncLease` (ver abajo): sin arriendo → nada.
3. **Empujar** (`#push`, fase `pushing`): la primera vez rellena el diario de los proyectos inscritos (`ensureEnrolledProjectSyncMutations`); toma `maxPendingSyncMutationSeq` como tope de la tanda; pagina `listPendingSyncMutationsAfterSeq` de `pushBatchSize` en `pushBatchSize` y empuja cada página con `#pushPage`. Si no había nada que empujar y quedan pendientes de proyectos sin inscribir → `NonEnrolledPendingError`.
4. Si el empuje falla con un error **no** seguro (ver abajo): `#recordFailure` y fin del ciclo.
5. Si falla con un bloqueo seguro: se anota el bloqueo (`markSyncBlocked`), se **lee igualmente** (`#pull(true)`, conservando el estado del destino) y, si la lectura funciona, `markSyncBlockedAfterSuccess` (anota el éxito, deja `consecutiveFailures = 0`, `lastSyncAt`); si la lectura falla, `#recordFailure`.
6. Si el empuje funciona: `#pull(false)`; si falla, `#recordFailure`; si no, `#recordSuccess`.

**`#pushPage(página)`**: agrupa por proyecto (orden de aparición). Una mutación cuyo proyecto está vacío o con espacios no se envía y suma el fallo `pending mutation seq <n> (<entidad>/<clave>) has an empty or padded project and was not sent; repair local project metadata or inspect \`odin doctor --check sync_mutation_required_fields\``. Cada mutación de **prompt** se comprueba antes (`promptIdentityProblem`): carga ilegible → `prompt seq <n>: invalid identity: <detalle>`; `sync_id` vacío o distinto de la clave, `project` distinto del del grupo o `session_id` vacío → `prompt seq <n>: invalid journal identity`; los prompts con `source_inbox_id` pasan además por la comprobación de procedencia descrita en `05-identidad-y-procedencia.md` («Comprobación previa en el autosync»). Con las entradas válidas de un proyecto: `pushMutations`; un fallo → `transport push project "<p>": <detalle>` (y se sigue con el siguiente proyecto); si el servidor no devuelve una lista o acepta un número distinto → `transport push project "<p>": missing accepted seqs for <n> mutations` / `…: cloud accepted <a> of <n> mutations; refusing to ack local seqs`; si todo va bien, `ackSyncMutationSeqs`. Los fallos de varios proyectos se acumulan en un error múltiple (mensajes unidos por salto de línea) cuya cadena recorre la clasificación 401/403 y la guía.

**Bloqueo seguro** (`safeOutboundBlock`): `NonEnrolledPendingError` —`pending cloud sync mutations are blocked because project(s) are not enrolled: <p>=<n>, …. Run \`odin cloud enroll <project>\` for each intended project or review enrollment.`—. El motivo anotado es `non_enrolled_pending_mutations`. También lo es `PromptPreflightError` (motivo `prompt_provenance_blocked`), solo o dentro de un error múltiple cuyos elementos sean todos seguros (ver 05). Cualquier otro fallo de empuje corta el ciclo.

**`#pull(preservar)`** (fase `pulling`): cursor = `last_pulled_seq` del destino; pide páginas de `pullBatchSize` (`transport pull: <detalle>` si falla) hasta que `has_more` es falso; cada mutación remota se convierte (`payload` = `JSON.stringify` de la carga recibida, `target_key`, `occurred_at`) y se aplica con `applyCloudMutation` (un error → `apply pulled mutation seq=<n>: <detalle>` y la lectura se detiene sin mover el cursor de esa mutación). Después se reintentan las relaciones diferidas de los proyectos tocados y de los que ya tenían diferidas (`listDeferredProjectsForTarget`), por orden alfabético, con `replayDeferredForScope`; sus errores solo se registran.

**Estado**: `#recordFailure(mensaje, motivo)` suma un fallo, fija `backoffUntil = ahora + computeBackoff(fallos)`, la fase `push_failed` (si el fallo vino empujando) o `pull_failed`, y llama a `markSyncFailure` con el motivo. El mensaje de un fallo es `push: …` o `pull: …` más la guía (`appendGuidance` con el proyecto de la política denegada, el que cite el mensaje o el del destino). `#recordSuccess`: fase `healthy`, fallos 0, `lastError` vacío, `backoffUntil` nulo, `lastSyncAt` ahora, `markSyncHealthy`. La clasificación del motivo recorre la cadena de errores: 401 → `auth_required`, 403 → `policy_forbidden`, otro → `transport_failed`.

**`computeBackoff(n)`**: `n ≤ 0` → base; si no, la base se duplica `n − 1` veces con tope `maxBackoff`; se le suma una variación uniforme en `[−base/4, +base/4]` (`⌊random·(⌊base/2⌋+1)⌋ − ⌊base/4⌋`), saturando en el tope, con suelo `⌊base/2⌋`.

## Cola de salida y acuses (`src/store/sync-queue.js`)

Funciones sobre `store`; los destinos se normalizan y `cloud:inbox` no tiene cola.

- `listPendingSyncMutationsAfterSeq(store, target, afterSeq, limit)`: filas con `acked_at IS NULL`, disposición `pending`, `seq > afterSeq`, de proyectos inscritos **o** sin proyecto, por `seq` ascendente (límite ≤ 0 = 100). Columnas: `seq, target_key, entity, entity_key, op, payload, source, project, occurred_at, acked_at, disposition, disposition_reason, disposition_evidence, disposition_at`.
- `maxPendingSyncMutationSeq` (0 si no hay), `countPendingNonEnrolledSyncMutations` → `[{ project, count }]` por proyecto no vacío sin inscribir.
- `ackSyncMutationSeqs(store, target, seqs)`: en una transacción, marca `acked_at` de cada `seq > 0` aún pendiente, guarda el mayor como `last_acked_seq` y recalcula el ciclo de vida del destino (`healthy` si no queda nada pendiente, `pending` si no; `degraded` si el destino está activamente degradado, caso en que no se tocan fallos ni motivo; si no, se limpian). Para el destino global, recalcula además el de cada proyecto afectado (`cloud:<p>`: pendiente/sano según sus filas del diario global, `last_enqueued_seq` y `last_acked_seq` como máximos con lo ya guardado; solo se crea la fila de un proyecto inscrito).
- `isActivelyDegradedState(estado, ahora)` (en `sync-state.js`): `degraded` con motivo `blocked_unenrolled`, `paused`, `auth_required`, `policy_forbidden` o `cloud_config_error`, o con `backoff_until` en el futuro.
- `acquireSyncLease(store, target, owner, ttlMs, ahora)`: en una transacción; falla si hay un arriendo vigente de otro dueño; si no, fija `lease_owner` y `lease_until` (`ahora + ttl` en RFC 3339 sin fracción; ttl ≤ 0 = 60 s). `releaseSyncLease(store, target, owner)`: lo suelta si es de `owner` o está libre.
- `listDeferredProjectsForTarget`: proyectos con filas `deferred` de ámbito `scoped`.
- `ensureEnrolledProjectSyncMutations(store)`: ejecuta el relleno (abajo) de cada proyecto inscrito, uno por transacción.
- `applyCloudMutation(store, target, mutación, { preserveSyncState })`: en una transacción, ignora una `seq` ≤ `last_pulled_seq`; aplica con `applyTolerant` en el **dominio de la nube** (abajo) —una relación sin extremos, un padre ausente o una identidad inválida no detienen la lectura—; avanza `last_pulled_seq` y, salvo con `preserveSyncState`, deja el destino `healthy` sin fallos ni motivo.

`applyTolerant(store, db, target, mutación, { later, cloud })` (en `sync-apply.js`) es la política de fallos que antes vivía dentro de `applyPulledChunk`: aplica dentro de un punto de guardado; una relación con `relation_fk_missing` o `relation_project_mismatch` se encola como `deferred`, con `apply_dead` como `dead`; `parent_session_missing` se difiere; una identidad inválida se archiva; cualquier otro error se propaga.

### Dominio de la nube al aplicar

Con `cloud` activo, `applyPulledMutation` usa las lápidas por **secuencia remota** en lugar de por fecha:

- Un borrado de sesión (o de observación, duro o blando) escribe una lápida activa (`recordCloudDeleteTombstone`: `hard_delete` según la carga, `deleted_at` o ahora) y el piso: en el destino global, `last_remote_mutation_seq` de la lápida (el mayor visto); en cualquier otro, una fila de `sync_delete_tombstone_remote_floors` (`target_key, entity, entity_key, last_mutation_seq`, el mayor). Un borrado de sesión no consulta lápidas locales para decidir si una alta posterior la salva.
- Un alta se descarta si la lápida la bloquea (`cloudUpsertBlockedByTombstone`): sin lápida, no; destino global con piso → `seq ≤ piso`, sin piso → lápida activa; otro destino con piso propio → `seq ≤ piso`, sin piso propio pero con piso de algún otro destino → no bloquea, y sin ningún piso → lápida activa.
- El borrado de observación conserva además el vínculo de sustitución (`preserveObservationDeleteProvenance(…, true)`) y cancela las altas diferidas de esa observación en el destino.

## Relleno del diario (`backfillProjectSyncMutations(db, proyecto, origen)`)

Deja de ser un no-op: al inscribir un proyecto (y al arrancar el gestor, para los ya inscritos) encola, vía `journalMutation`, lo que el proyecto ya tiene y que no tenga una mutación `pending` o `quarantined` del mismo destino, entidad, clave y origen. En este orden:

1. **Sesiones** del proyecto con id no vacío y con directorio no vacío o `ownership_mode = 'project_owned'`: `{ id, project, ownership_mode, directory, started_at, ended_at, summary }` (una `shared` sin directorio no viaja; una `project_owned` sin él sí, p. ej. los registros aislados).
2. **Observaciones vivas** (proyecto propio o, si no lo tienen, el de su sesión): `{ sync_id, session_id, type, title, content, tool_name, project, scope, topic_key, revision_count, duplicate_count, last_seen_at, created_at, updated_at, superseded_by_sync_id? }`.
3. **Observaciones borradas** (blandas) sin `delete` en cola: `{ sync_id, session_id, project, deleted_at, superseded_by_sync_id?, deleted: true, hard_delete: false }`.
4. **Lápidas** activas de `observation` y `session` del proyecto, sin piso remoto y sin una mutación `delete` del mismo origen en `pending` o `quarantined` **ni acusada con `seq` posterior a `last_mutation_seq` de la lápida** (un borrado ya acusado no se vuelve a encolar en cada sincronización; spec 0.32.0), ordenadas observaciones antes que sesiones: `delete` con `deleted: true`, `deleted_at` y `hard_delete` de la lápida.
5. **Prompts** vivos `{ sync_id, session_id, content, project, created_at, source_inbox_id }` y **lápidas de prompt** sin `delete` en cola `{ sync_id, session_id, project, deleted_at, source_inbox_id, deleted: true, hard_delete: true }`.
6. **Relaciones** con juicio (estado distinto de `orphaned` y `pending`) y con `marked_by_actor` y `marked_by_kind` no vacíos, entre observaciones vivas, cuyo origen es del proyecto: `{ sync_id, source_id, target_id, relation, reason, evidence, confidence, judgment_status, marked_by_actor, marked_by_kind, marked_by_model, session_id, project, created_at, updated_at }`.

Cada conjunto se lee entero antes de insertar. Es idempotente. Sirve también a la fusión y renombre de proyectos inscritos.

## Cargas del diario que cambian

Ahora que el diario viaja, estas escrituras anotan cargas completas (antes `{}`): borrado de sesión (`prompt`: `{ sync_id, session_id, project, source_inbox_id, deleted: true, hard_delete: true, deleted_at }` por cada prompt y `session`: `{ id, project, deleted: true, hard_delete: true, deleted_at }`); lápida de prompt al importar una copia (`{ sync_id, session_id, source_inbox_id, project, deleted: true, hard_delete: true, deleted_at }`); y prompt que adopta un buzón de origen al importar (`{ sync_id, session_id, content, created_at, source_inbox_id, project }`).
