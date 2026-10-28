# 10.1 — Conexión, identidad y migraciones

Módulos: `src/store/{errors,schema,data-dir,instance-id,generation,db,migrate,store,index}.js`, `src/timeutil/index.js`, `src/runtime/warnings.js`.

`src/store/schema.js` se copia **literal** desde `fuentes/` (contiene el DDL completo). El resto se escribe desde esta especificación.

## Secuencia de apertura: `Store.open(config)`

`config = { dataDir: string, log?: (msg) => void }`. `log` por defecto escribe `msg + "\n"` en stderr.

1. `validateDataDirectory(dataDir)` — sin tocar el disco.
2. `mkdirSync(dataDir, { recursive: true, mode: 0o755 })`.
3. `instanceId = ensureInstanceId(dataDir)`.
4. `dbPath = join(dataDir, 'odin.db')`; `ensureDatabaseFile(dbPath)`.
5. `generation = new DatabaseGeneration(dbPath)` (antes de abrir la conexión).
6. `db = openDatabase(dbPath, generation)`.
7. `runStartupMigrations(db, generation, log)`; si lanza, se cierra `db` y se relanza el error.
8. Devuelve `new Store(config, db, generation, instanceId)`.

`Store` expone: `config`, `db`, `generation`, `instanceId`, `runtimeId` (16 bytes aleatorios en hexadecimal, nuevo en cada apertura), `dataDir`, `dbPath`, `generationError()` (el error permanente ya observado o `null`) y `close()`.

## `errors.js`

| Clase | `code` | Mensaje |
|---|---|---|
| `DatabaseGenerationChangedError` | `database_generation_changed` | `Database generation changed; restart odin` |
| `NetworkFilesystemError(dataDir, filesystem)` | `network_filesystem` | `odin-memory: data directory "<dataDir>" is on <filesystem>; persistent SQLite WAL is unsafe on network filesystems — set ODIN_DATA_DIR to a local directory` (propiedades `dataDir`, `filesystem`) |
| `StoreError(code, message)` | el indicado | el indicado |

## `data-dir.js`

- `validateDataDirectory(dataDir)`:
  - Si no es ruta absoluta: `StoreError('data_dir_not_absolute', 'odin-memory: data directory must be an absolute path, got "<dataDir>" — set ODIN_DATA_DIR or ensure your home directory is resolvable')`.
  - Sube desde `dataDir` hasta el primer directorio existente; si no hay ninguno, termina sin error.
  - Llama al inspector de sistema de archivos con esa ruta. Si el inspector lanza, se ignora (un fallo de detección nunca bloquea). Si devuelve `support: 'remote'`, lanza `NetworkFilesystemError(dataDir, info.type)`.
- `classifyFilesystemName(name)`: pasa a minúsculas y recorta; `nfs`/`nfs4` → `{type:'NFS', support:'remote'}`; `cifs`/`smb`/`smb2`/`smbfs` → `{type:'SMB/CIFS', support:'remote'}`; `afpfs` → `AFP`; `webdav` → `WebDAV`; cualquier otro → `{type: name, support: 'unknown'}`. **Solo se marca remoto lo que se identifica positivamente.**
- `detectFilesystem(path, platform = process.platform)`, mejor esfuerzo:
  - `linux`: `fs.statfsSync(path).type` contra los números mágicos remotos: NFS `0x6969`, SMB `0x517b`, SMB/CIFS `0xff534d42` y `0xfe534d42`, Coda `0x73757245`, NCP `0x564c`, OCFS2 `0x7461636f`, GPFS `0x47504653`. Si no coincide, `unknown`.
  - `darwin`: ejecuta `mount`, elige el punto de montaje más largo que sea prefijo de `realpath(path)` (líneas con forma `<dispositivo> on <punto> (<tipo>, …)`) y clasifica `<tipo>`.
  - `win32`: una ruta que empieza por `\\` es `{type:'SMB/CIFS', support:'remote'}`; el resto, `unknown`.
  - Otras plataformas: `unknown`.
- `setFilesystemInspector(fn)` reemplaza el inspector y devuelve una función que lo restaura (lo usan las pruebas).

## `instance-id.js`

- `isValidInstanceId(id)`: exactamente 32 caracteres `[0-9a-f]`.
- `ensureInstanceId(dataDir)` (síncrona), hasta 20 intentos:
  1. Lee `<dataDir>/.instance-id`. Si existe y su contenido recortado es válido, lo devuelve. Si existe pero no es válido, lo borra (ignorando `ENOENT`).
  2. Genera 16 bytes aleatorios en hexadecimal.
  3. Escribe `id + "\n"` en un temporal `<dataDir>/.instance-id-<12 hex>` creado con `wx`, hace `fsync` y lo cierra.
  4. Publica con `linkSync(temporal, '.instance-id')`: atómico y falla con `EEXIST` si otro proceso ganó. Devuelve `id` si publica.
  5. Ante `EEXIST`: lee el ganador y, si es válido, lo devuelve; si no, `sleepSync(5)` y reintenta.
  6. El temporal se borra siempre.
  7. Agotados los intentos: `StoreError('instance_id_race', 'odin-memory: read instance identity: concurrent initialization did not complete')`.
- No usa archivos de bloqueo: la publicación atómica basta para que todos los procesos converjan en el mismo identificador.

## `generation.js`

`DatabaseGeneration(dbPath)` vigila `dbPath`, `dbPath-wal` y `dbPath-shm` comparando `dev` e `ino` (`statSync(path, { bigint: true })`) con lo observado la primera vez.

- `check()`: si ya hay error permanente, lo lanza. Para cada ruta: si `stat` da `ENOENT`, la base principal ausente es error; `-wal`/`-shm` ausentes solo son error si ya se habían observado. Si la ruta no se había observado, registra `dev`/`ino`; si difieren de lo registrado, error. El error es siempre `DatabaseGenerationChangedError` y queda **permanente** (`error` lo expone sin tocar el disco). Otros errores de `stat` se propagan sin volverse permanentes.
- El constructor llama a `check()`, así que la base debe existir.
- `checkRead()`: igual que `check()` salvo mientras `withStartupChecks` está activo.
- `withStartupChecks(fn)`: `check()`, activa la omisión de lecturas, ejecuta `fn`, y en `finally` desactiva la omisión y vuelve a llamar a `check()`.
- `ensureDatabaseFile(path)`: abre con modo `'a'` y permisos `0o600` y cierra (crea sin truncar).

## `db.js`

- `isRetryableLockError(err)`: si `err.errcode` es numérico, es reintentable cuando `errcode & 0xff` es 5 (BUSY) o 6 (LOCKED) (los extendidos, como 517, cuentan); si no, cuando el mensaje contiene `database is locked`, `database is busy`, `sqlite_busy` o `sqlite_locked` (sin distinguir mayúsculas). Un valor que no es `Error` no lo es.
- `RETRY_BACKOFFS_MS = [10, 25, 50, 100, 200]`.
- `withLockRetry(fn)`: ejecuta `fn`; ante error reintentable duerme `RETRY_BACKOFFS_MS[intento]` (con `sleepSync`) y reintenta, hasta `RETRY_BACKOFFS_MS.length` reintentos (6 ejecuciones en total); el último error se propaga. Los errores no reintentables se propagan de inmediato.
- `Database` envuelve un `DatabaseSync` y un `DatabaseGeneration` (puede ser `null`):
  - `raw`, `inTransaction` (`raw.isTransaction`).
  - `exec(sql)` y `run(sql, ...params)` verifican con `generation.check()`; `get` y `all` con `generation.checkRead()`. `run` devuelve `{ changes, lastInsertRowid }`. Las filas son objetos con prototipo nulo.
  - `transaction(fn)`: verifica con `check()`; si no hay transacción abierta ejecuta `BEGIN IMMEDIATE`, si la hay `SAVEPOINT odin_sp_<profundidad>`. Llama a `fn(this)`. Si `fn` devuelve un objeto con `then` (asíncrona) lanza `TypeError('transaction(fn): fn debe ser síncrona')`. Confirma con `COMMIT`/`RELEASE`; ante cualquier excepción hace `ROLLBACK` (o `ROLLBACK TO` + `RELEASE`) y relanza. Mantiene el contador de profundidad con `try/finally`.
  - `writeTransaction(fn)`: dentro de una transacción abierta equivale a `transaction(fn)`; fuera, `withLockRetry(() => transaction(fn))`.
  - `close()`.
- `openDatabase(dbPath, generation)`: `new DatabaseSync(dbPath, { timeout: 5000 })` y, dentro de `withLockRetry`: `PRAGMA busy_timeout = 5000`, `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`, `PRAGMA foreign_keys = ON`. Si falla, cierra la conexión y relanza.

## `migrate.js`

- `COLUMN_MIGRATIONS`: lista (vacía) de `{ table, column, definition }` aplicadas con `addColumnIfNotExists`, que consulta `PRAGMA table_info(<tabla>)` y, si falta, ejecuta `ALTER TABLE <tabla> ADD COLUMN <columna> <definición>`.
- `migrate(db)` (dentro de una transacción), en este orden:
  1. `db.exec(TABLES_AND_INDEXES)`.
  2. `COLUMN_MIGRATIONS`.
  3. `migrateFts(db)`.
  4. `INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES ('cloud', 'idle', datetime('now'))`.
  5. Lo mismo para `('cloud:inbox', 'inbox')`.
  6. `UPDATE sync_state SET lifecycle='inbox', last_enqueued_seq=0, last_acked_seq=0, last_pulled_seq=0 WHERE target_key='cloud:inbox' AND (lifecycle <> 'inbox' OR last_enqueued_seq <> 0 OR last_acked_seq <> 0 OR last_pulled_seq <> 0)`.
- `migrateFts(db)`: para cada tabla FTS decide si hay que reconstruir.
  - Tabla correcta (`ftsTableMatches`): existe en `sqlite_master`; sus columnas visibles (`SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid`) son exactamente las esperadas en orden; y su DDL, sin espacios y en minúsculas, contiene `createvirtualtable<tabla>usingfts5(`, `tokenize='trigram'`, `content='<tabla de contenido>'` y `content_rowid='id'`.
  - Triggers correctos (`ftsTriggersMatch`): cada trigger existe y su DDL normalizado contiene los fragmentos indicados en el código de referencia de `migrate.js`:
    - `obs_fts_insert`: `afterinsertonobservations`, `whennew.deleted_atisnull`
    - `obs_fts_delete`: `beforedeleteonobservations`, `whenold.deleted_atisnull`, `deletefromobservations_ftswhererowid=old.id`
    - `obs_fts_update`: `beforeupdateonobservations`, `whenold.deleted_atisnull`, `deletefromobservations_ftswhererowid=old.id`
    - `obs_fts_update_insert`: `afterupdateonobservations`, `whennew.deleted_atisnull`
    - `prompt_fts_insert`: `afterinsertonuser_prompts`
    - `prompt_fts_delete`: `beforedeleteonuser_prompts`, `deletefromprompts_ftswhererowid=old.id`
    - `prompt_fts_update`: `beforeupdateonuser_prompts`, `deletefromprompts_ftswhererowid=old.id`
    - `prompt_fts_update_insert`: `afterupdateonuser_prompts`
  - Reconstrucción: `DROP` de los cuatro triggers y de la tabla, `CREATE VIRTUAL TABLE`, `CREATE TRIGGER` ×4 y repoblado con `INSERT … SELECT` desde la tabla de contenido (observaciones: solo `deleted_at IS NULL`; prompts: todas). Las sentencias de `schema.js` son las definitivas.
  - Los triggers de borrado usan `DELETE FROM <fts> WHERE rowid = old.id` y **nunca** el comando especial `'delete'` de FTS5: con el tokenizador trigram no es seguro.
- `readUserVersion(db)`: `PRAGMA user_version` como número.
- `runStartupMigrations(db, generation, log)` dentro de `generation.withStartupChecks`:
  1. Si `user_version > SCHEMA_VERSION`: `log("[store] database schema version <v> is newer than this program's <SCHEMA_VERSION> — skipping migrations (upgrade odin to manage this database)")` y devuelve `{ futureSchema: true }` sin escribir nada.
  2. `PRAGMA busy_timeout = 60000`.
  3. `db.writeTransaction`: relee `user_version` (otro proceso pudo migrar); si ahora es mayor, aviso y `{ futureSchema: true }`; si no, `migrate(db)` y, si `user_version < SCHEMA_VERSION`, `PRAGMA user_version = <SCHEMA_VERSION>`.
  4. En `finally`, `PRAGMA busy_timeout = 5000`.
  - La transacción `BEGIN IMMEDIATE` es la exclusión mutua entre procesos (SQLite libera el bloqueo si el proceso muere). **No hay archivos de bloqueo `.migrate.lock`.**
- Se ejecuta `migrate` en **cada** apertura (es idempotente), no solo cuando cambia la versión.

## `src/timeutil/index.js`

- `now(date = new Date())`: `YYYY-MM-DD HH:MM:SS.mmm000000` en UTC (milisegundos rellenados a 9 decimales).
- `sqliteDatetime(date)`: `YYYY-MM-DD HH:MM:SS`.
- `sleepSync(ms)`: `Atomics.wait` sobre un `SharedArrayBuffer`.

## `src/runtime/warnings.js`

`silenceSqliteWarning()` reemplaza `process.emitWarning` por un filtro que descarta solo las advertencias de tipo `ExperimentalWarning` cuyo texto contiene `SQLite` (el tipo puede llegar como segundo argumento de cadena o como `{ type }`), y devuelve una función que restaura el original. `bin/odin.js` la llama antes de cargar el store.

## Criterios de aceptación

```bash
node --test "test/unit/store/*.test.js" test/unit/timeutil.test.js test/unit/runtime-warnings.test.js
npm run check:implementacion
```
