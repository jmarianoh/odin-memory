# 14.2 — Servidor, `odin serve` y sesión propia

## `HttpServer` (`src/server/server.js`)

```js
new HttpServer(store, {
  port,              // 7438 por defecto; 0 = puerto libre
  version,           // 'dev' por defecto; lo informa /health
  env,               // process.env; ODIN_HTTP_TOKEN se lee de aquí en cada petición
  cwd,               // () => process.cwd()
  socketPath,        // escucha en un socket Unix en lugar de TCP
  sessionOwnedToken, // autentica TODAS las rutas con este token
  onWrite,           // () => void tras cada escritura local (aviso al sincronizador)
  syncStatus,        // (proyecto) => estado; por defecto storeSyncStatus(store, { defaultProject })
  defaultProject,    // proyecto del estado de sincronización cuando la petición no trae ninguno
  onReady,           // (dirección) => void tras enlazar y antes de atender; si lanza, el servidor se cierra
  log,               // (mensaje) => void; stderr por defecto
})
```

| Miembro | Comportamiento |
|---|---|
| `await listen()` | Enlaza y empieza a atender. Devuelve `{ address, reused }`. TCP: solo `127.0.0.1`. Socket: `prepareSocket` + `listenSecure`. Con `EADDRINUSE` (y sin token de sesión ni socket): si `GET /health` del puerto (hasta 5 intentos, 500 ms cada uno, 50 ms entre ellos) devuelve **el mismo `instance_id`**, registra `[odin] HTTP server did not bind on 127.0.0.1:<puerto>: an existing instance owns the port` y devuelve `reused: true`; si no, lanza `odin server: listen 127.0.0.1:<puerto>: already owned by a different or legacy instance`. Cualquier otro fallo: `odin server: listen <destino>: <causa>`. Registra `[odin] HTTP server listening on <destino>` |
| `generationInvalidated` | Promesa que se resuelve una sola vez cuando, tras una petición, `store.generationError()` es `DatabaseGenerationChangedError` |
| `await close()` | Deja de aceptar conexiones y borra el socket propio. Idempotente |
| `await shutdown(graceMs = 5000)` | `close()` esperando a las peticiones en curso; pasado el plazo corta las conexiones |
| `requestTimeout` | Desactivado (`0`); `headersTimeout` 60 s |

## Socket Unix (`src/server/unix-socket.js`)

`prepareSocket(ruta)` (solo plataformas Unix):

1. Ruta vacía o `.` → `odin server: socket path is required`.
2. `secureSocketPath`: resuelve el directorio padre con `realpath` y recorre **cada componente** desde `/`: debe ser un directorio, no un enlace simbólico, y de confianza (`trustedSocketDirectory(mode, uid, euid)`: sin permiso de escritura para grupo ni otros, **o** con *sticky* y dueño root o el usuario efectivo). Errores: `odin server: resolve socket parent: …`, `… socket parent hierarchy contains an unsafe directory`, `… is writable by an untrusted user`.
3. Si la ruta existe: no es un socket → `socket path "<ruta>" exists and is not a Unix socket`; se sondea con una conexión de 250 ms: conecta → `socket "<ruta>" is already in use`; `ECONNREFUSED` → es huérfano y se borra (solo si sigue siendo el mismo inodo); `ENOENT` → libre; otro error → `cannot verify socket "<ruta>" is stale: <causa>`.

`listenSecure(servidor, ruta)` enlaza con la máscara `0o177` activa durante el enlace (en un proceso monohilo nadie puede intercalarse), restaura la máscara, aplica `chmod 0600` y devuelve el `stat` del socket creado. `removeOwnedSocket(ruta, stat)` borra el archivo **solo** si sigue siendo un socket con el mismo `dev` e `ino`.

## `odin serve` (`src/cli/commands/serve.js`)

```
odin serve [puerto]
odin serve --socket RUTA          (o --socket=RUTA)
odin serve --session-owned
```

`resolveServeOptions(args, env)`:

* Modo de sesión propia (`validateSessionOwned`): si aparece `--session-owned`, no puede estar definida **ninguna** de `ODIN_URL`, `ODIN_PORT`, `ODIN_SOCKET` (aunque esté vacía; `session-owned serve conflicts with <VAR>; unset it`), ningún otro argumento (`session-owned serve accepts no port or socket arguments`) y `ODIN_TOKEN` debe ser hexadecimal de 64 caracteres (`session-owned serve requires a private 256-bit hex ODIN_TOKEN`). Puerto 0 (libre).
* Si no: puerto 7438; `ODIN_PORT` (1–65535; lo demás se ignora) fija el puerto; `ODIN_SOCKET` (recortado) el socket; los argumentos: `--socket RUTA` / `--socket=RUTA` (vacío: `--socket requires a path`), o un entero (cualquier entero con signo opcional) como puerto; otro texto: `unknown serve argument: <texto>`. Socket y puerto explícito juntos: `socket transport cannot be combined with an explicit TCP port`.

Ciclo de `cmdServe`:

1. Abre el almacén (fallo → `odin: <causa>`, código 1).
2. En sesión propia espera un turno del bucle de eventos para observar un cierre previo de la entrada; si ya se cerró, sale con 0 sin enlazar.
3. Crea el `HttpServer` (`sessionOwnedToken` = `ODIN_TOKEN` en sesión propia) y llama a `listen()`. Atiende hasta lo primero que ocurra: `generationInvalidated`, cierre de la entrada estándar (solo sesión propia), `SIGINT`/`SIGTERM`, o `reused` (sale enseguida con 0).
4. Registra `[odin] session owner disconnected; shutting down...` o `[odin] shutting down...`, hace `shutdown(5000)` y cierra el almacén.
5. Si la base cambió de identidad: `[odin] database generation changed; stopping server; restart Odin` y `odin: Database generation changed; restart odin` (código 1). Si `listen()` falló: `odin: <causa>` (código 1).

### Línea de disponibilidad de la sesión propia

Tras enlazar, **antes de atender**, escribe en la salida estándar una línea JSON (claves en este orden):

```json
{"protocol":"odin-session-owned-v1","endpoint":"http://127.0.0.1:<puerto>","pid":<pid>,"instance_id":"<id del almacén>"}
```

El proceso padre la lee, usa `endpoint` con `Authorization: Bearer <ODIN_TOKEN>` y, al cerrar el extremo de la entrada estándar del hijo, lo detiene. Si el padre ya cerró la entrada cuando el servidor está listo, no emite nada y sale con 0.

### Ganchos de prueba (`Cli.serve`)

`run(args, { serve: { input, processRef, signal, graceMs, log, ready } })`: `input` sustituye a `process.stdin`; `processRef` a `process` para las señales; `signal` (un `AbortSignal`) equivale a una señal; `graceMs` al plazo de 5000; `ready({ server, address })` se llama al enlazar.

## Estado de sincronización (`src/server/sync-status.js`, `src/store/sync-state.js`)

`GET /sync/status` usa `storeSyncStatus(store, { defaultProject, cloudConfig })`. `cloudConfig()` devuelve `{ server_url }` o `null` (la nube llega en F9; hasta entonces es siempre `null`).

Resolución (`proyecto` = el de la petición normalizado; si está vacío, `defaultProject`):

1. Estado de la migración a la nube del proyecto (`cloud_upgrade_state`) → `upgrade_stage`, `upgrade_reason_code`, `upgrade_reason_message`. Un fallo al leerlo → código `upgrade_status_unavailable`.
2. **Sin nube configurada** (o sin `server_url`):
   * sin proyecto → deshabilitado, `cloud_not_configured` («cloud sync is not configured»);
   * proyecto sin inscribir (`sync_enrolled_projects`) → `blocked_unenrolled` («project "x" is not enrolled for cloud sync»);
   * inscrito y con estado de sincronización significativo (ciclo distinto de `idle`, secuencias > 0, fallos, espera, concesión, razón o error) → habilitado con ese estado;
   * en otro caso → `cloud_not_configured`.
3. **Con nube configurada**: sin proyecto → `project_required` («cloud sync status requires an explicit project scope»); sin inscribir → `blocked_unenrolled`; inscrito → habilitado con el estado del destino `cloud:<proyecto>` (se crea en reposo si falta).

Los estados deshabilitados llevan `phase: "idle"`. La respuesta HTTP serializa: `enabled`, `phase`, `last_error`, `consecutive_failures`, `backoff_until`, `last_sync_at` (RFC 3339 o `null`), `reason_code`, `reason_message`, `deferred_count`, `dead_count` y `upgrade: {stage, reason_code, reason_message}`. Sin proveedor (`syncStatus` no configurado) responde `{"enabled":false,"message":"background sync is not configured"}`.

`src/store/sync-state.js` aporta: `DEFAULT_SYNC_TARGET_KEY` (`cloud`), `SYNC_INBOX_TARGET_KEY`, `SYNC_LIFECYCLE`, `cloudTargetKeyForProject`, `normalizeSyncTargetKey`, `foreignCloudProject`, `isProjectEnrolled`, `getSyncState` y `getCloudUpgradeState` y, desde F9.1, las funciones de ciclo de vida del destino (`markSyncBlocked`, `markSyncPaused`, `markSyncAuthRequired`, `markSyncFailure`, `markSyncHealthy`, `markSyncPending`) y `cloudSyncSummary` (`30-cloud/01-cliente.md`; el resto —cola, acuses, errores— llega con F9.2).
