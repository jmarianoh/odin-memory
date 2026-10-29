# 16 — Sincronización por Git

## Qué cubre este capítulo

La entrega F5 (spec 0.18.0) permite compartir la memoria de un proyecto mediante archivos versionables en Git: `odin sync` exporta lo nuevo a una carpeta `.odin-memory/` del repositorio y `odin sync --import` aplica lo que otros han exportado. La nube (`--cloud`) reutiliza este mismo `Syncer` con un transporte remoto (F9.1, `30-cloud/`); por eso sus métodos son asíncronos.

| Pieza | Dónde |
|---|---|
| Formato y funciones puras de los chunks | `src/sync/chunks.js` |
| Transporte sobre el sistema de archivos | `src/sync/transport.js` |
| Orquestador (`Syncer`) | `src/sync/syncer.js`, reexportado por `src/sync/index.js` |
| Seguimiento de chunks, mutaciones exportables | `src/store/sync-chunks.js` |
| Aplicación de mutaciones remotas, cola de diferidas, reintentos | `src/store/sync-apply.js` |
| Rescate de propiedad de registros sin proyecto | `src/store/project-rescue.js` |
| Comando `sync` | `src/cli/commands/sync.js` |
| Rutas `POST /conflicts/deferred/replay` y `POST /projects/rescue-ownership` (alias `/projects/migrate`) | `src/server/routes/maintenance.js` |

## Formato en disco

```
.odin-memory/
├── manifest.json
└── chunks/
    └── <id>.jsonl.gz
```

### Manifiesto

JSON con sangría de dos espacios, sin salto de línea final:

```json
{
  "version": 1,
  "chunks": [
    { "id": "a1b2c3d4", "created_by": "ana", "created_at": "2026-03-01T10:00:00Z", "sessions": 1, "memories": 3, "prompts": 0 }
  ]
}
```

- `chunks` es `null` si no hay ninguno (nunca `[]`); al leer, `null` y ausente equivalen a lista vacía.
- `version` es 1; sube a **2** en cuanto el proyecto exportado tiene sesiones con `ownership_mode = 'project_owned'`. Un manifiesto de versión menor no se puede importar si trae sesiones propias (ver «Rechazos de degradación»).
- Un directorio sin `manifest.json` equivale a `{ "version": 1, "chunks": [] }`. Cualquier otro error de lectura es `read manifest: <causa>`; un JSON ilegible es `parse manifest: <causa>`.

### Chunk

Un objeto JSON comprimido con gzip (un único documento, no una línea por registro). Orden de claves: `sessions`, `observations`, `prompts`, y después, solo si no están vacías, `mutations` y `review_clears`. Las listas vacías de un chunk **incremental** se escriben como `[]` para `observations`; las demás vacías, como `null`.

- **Identificador**: los 8 primeros hexadecimales del SHA-256 del JSON sin comprimir (`chunkId`). Dos exportaciones con el mismo contenido producen el mismo ID.
- Proyecciones: `sessionJson`, `promptJson` y `chunkObservationJson` fijan el orden y los nombres de campo de cada entidad.
- `mutations` lleva operaciones que no caben en una fila: borrados (observación, prompt, sesión), relaciones y la anulación de `review_after`. Cada mutación tiene, en este orden, `seq`, `target_key`, `entity`, `entity_key`, `op`, `payload` (una cadena JSON), `source`, `project`, `occurred_at`, `disposition`.
- `review_clears` es una lista de recibos `"<sync_id>:<id>:<key>"` que evita reexportar una anulación ya compartida.

## Exportar (`Syncer.export`)

`Syncer.local(store, syncDir, project, { log })` crea el sincronizador. `export(createdBy, project, { includePrompts })`:

1. Crea `chunks/` y lee el manifiesto.
2. Conoce los chunks ya exportados por la unión de los registrados en la tabla `sync_chunks` (clave de destino `local`) y los del manifiesto.
3. Reúne los datos: un proyecto (solo observaciones de ámbito `project`) o todo si el proyecto es vacío.
4. **Incremental**: el instante del último chunk del manifiesto (`lastChunkTime`, el mayor `created_at` normalizado) filtra sesiones por `started_at`, prompts por `created_at` y observaciones por `created_at` o `updated_at`. Además se incluyen las observaciones que ningún chunk contiene (la historia de identidades manda sobre la fecha).
5. Los prompts solo viajan con `includePrompts`, y cada prompt una única vez (su `sync_id` figura en la historia de chunks previos, también si se borró después).
6. Las sesiones de las que cuelgan las observaciones y prompts elegidos se añaden al chunk.
7. Las mutaciones salen de: relaciones nuevas o modificadas, borrados locales no compartidos todavía (observaciones, prompts) y anulaciones de `review_after` con recibo nuevo.
8. Si no hay nada, devuelve `{ is_empty: true }` y no escribe.
9. Se calcula el ID. Si el chunk figura como conocido **y su contenido existe**, no se escribe nada (se registra en `sync_chunks` si faltaba). Si figura pero su contenido falta, se restaura el archivo sin duplicar la entrada del manifiesto.
10. Se escribe el chunk, se añade la entrada (`created_at` en RFC 3339 con fracción sin ceros finales) y se registra en `sync_chunks`.

Resultado: `{ chunk_id?, sessions_exported, observations_exported, prompts_exported, mutations_exported, is_empty }`.

### Normalización de tiempos (`normalizeTime`)

Convierte RFC 3339 a UTC con el formato del almacén `YYYY-MM-DD HH:MM:SS.fffffffff` (nueve decimales: se rellena con ceros o se recorta). Un texto que no sea RFC 3339 se devuelve recortado tal cual. Esto permite comparar con orden léxico fechas del manifiesto y del almacén.

## Importar (`Syncer.import`)

`import(onProgress?)` recorre los chunks del manifiesto en orden:

- Un chunk ya registrado en `sync_chunks` se cuenta como omitido; uno cuyo archivo falta se omite sin error.
- Un chunk ilegible detiene la importación con `parse chunk <id>: <causa>`.
- Antes de aplicar se comprueban los rechazos de degradación y se calcula el trabajo (`estimateImport`) para informar del progreso: `onProgress({ pending_chunks, percentage, … })` se llama al empezar (0 %) y al terminar (100 %); sin chunks informa solo el 100 %.
- `buildImportMutations` convierte un chunk en mutaciones: las filas de sesiones, observaciones y prompts se sintetizan como `upsert`, y se suman las mutaciones explícitas. `effectiveMutationsForImport` descarta las que un borrado posterior anula, y `orderMutationsForApply` las ordena por dependencia (sesiones, observaciones, prompts, relaciones; los borrados al final).
- `applyPulledChunk(store, 'local', id, mutations)` las aplica dentro de un `SAVEPOINT` por mutación.
- Si una observación o prompt apunta a una sesión que no existe, se repone una sesión vacía: `directory = '(recovered-missing-session)'`, `started_at = '1970-01-01 00:00:00'` y el proyecto de la fila que la necesita.
- Una relación cuyos extremos aún no existen (`relation_fk_missing`), o que cruza proyectos (`relation_project_mismatch`), no falla el chunk: se encola en `sync_apply_deferred`. `replayDeferred` la reintenta; tras **5** intentos fallidos pasa a `dead`. Un payload ilegible va directamente a `dead`.
- Los borrados importados dejan lápida (`sync_delete_tombstones`, `prompt_tombstones`) para que una exportación posterior no los reviva.

Resultado: `{ chunks_imported, chunks_skipped, sessions_imported, observations_imported, prompts_imported, relations_replayed, relations_deferred, relations_dead }`.

### Rechazos de degradación

Con un manifiesto de versión < 2 se rechaza (`Error`) cuando:

- Llegan sesiones `project_owned`: `sync downgrade is unsupported when incoming project-owned sessions exist; peer manifest version <n> does not support ownership modes`.
- El proyecto de una sesión entrante ya tiene sesiones propias: `sync downgrade is unsupported after project-owned sessions exist for project "<p>"; peer manifest version <n> does not support ownership modes`.
- Un borrado heredado apunta a una sesión propia: `sync downgrade is unsupported when a legacy delete targets project-owned session "<id>"; …`.

### Estado

`status()` devuelve `{ local, remote, pending }`: chunks registrados en `sync_chunks`, chunks del manifiesto y los que faltan por importar.

## Funciones auxiliares

| Función | Comportamiento |
|---|---|
| `getUsername(env)` | `USER`, si no `USERNAME`, si no el nombre del equipo, si no `unknown` |
| `manifestSummary(manifest)` | `No chunks synced yet.` o `N chunks, M memories, S sessions — contributors: a (1 chunks), b (2 chunks)`, con los autores ordenados por nombre |
| `FileTransport` | `readManifest`, `writeManifest`, `readChunk(id)` (lanza `ChunkNotFoundError` si falta), `writeChunk(id, json)` (gzip). Es un contrato: los métodos pueden devolver promesas y la nube aporta otro transporte con los mismos métodos (`30-cloud/01-cliente.md`) |

## Comando `odin sync`

```
odin sync [--import | --status] [--all] [--include-prompts] [--cloud --project PROJECT [--literal-project]]
```

- La carpeta es `<cwd>/.odin-memory/`. Sin `--all`, el proyecto se resuelve como en el resto de comandos (`--project`, detección…).
- Exportar imprime `Exporting memories for project "<p>"...` (o `Exporting ALL memories (all projects)...`), el aviso de que los prompts se excluyen, `Created chunk <id>` con los recuentos, un aviso de contenido sensible y la orden `git add .odin-memory/ && git commit -m "sync odin memories"`. Si no hay nada nuevo: `Nothing new to sync for project "<p>" — all memories already exported.` (o la variante `--all`).
- `--import` imprime `Imported N new chunk(s) from .odin-memory/` y los recuentos, o `No new chunks to import.` (con `(N chunks already imported)` si hubo omitidos), y siempre los tres contadores de relaciones.
- `--status` imprime `Sync status:` con `Local chunks`, `Remote chunks` y `Pending import`.
- Validaciones: `--all` y `--project` no se combinan; `--literal-project` solo vale con nube, proyecto explícito y sin `--all`; `--include-prompts` no se combina con `--import`, `--status`, `--cloud` ni `ODIN_CLOUD_SYNC` (`validateSyncPromptPrivacy`); la ayuda (`--help`, `-h`, `help`) no abre el almacén ni crea carpetas.
- `--cloud` o `ODIN_CLOUD_SYNC` verdadero (`1`, `true`, `yes`, `on`) sincronizan con el servidor de la nube del proyecto indicado: ver `30-cloud/01-cliente.md` (exige `--project`, comprobaciones previas, estado del destino `cloud:<proyecto>`).
- `Syncer` es asíncrono: `export`, `import(report)` y `status` devuelven promesas y esperan al transporte; el constructor acepta `targetKey` (por defecto el destino local de chunks; la nube usa `cloud:<proyecto>`). Quien lo llame (`odin sync`, el hook `sessionStart`) debe esperarlo.

## Rescate de propiedad (`projects rescue-ownership`)

Registros históricos pueden carecer de proyecto. `rescueNullProjectOwnership(store, { target_project, session_ids, observation_ids, prompt_ids })` les asigna el proyecto destino y devuelve `{ rescued_sessions, rescued_observations, rescued_prompts, conflicting_records, skipped_records, journaled, complete, blocked[] }`; cada elemento de `blocked` es `{ kind, id, reason, owned_by? }` (`owned_by` solo si tiene dueño). Un registro cuyo dueño es otro proyecto, o que depende de uno que lo es, queda bloqueado y no se modifica.

Errores: `project_required` y `project_rescue_invalid_request` (`project rescue request is invalid: …`). Si el proyecto destino está inscrito en la nube lanza `sync_journal_unavailable`: el rescate de propiedad sobre proyectos inscritos llega con F9.4.

CLI: `odin projects rescue-ownership --project <p> [--session <id>]… [--observation <id>]… [--prompt <id>]…`. Imprime `Rescued ownership into "<p>": S sessions, O observations, P prompts` y `Everything selected now belongs to the target project.` o la lista de lo bloqueado.

HTTP: `POST /projects/rescue-ownership` (alias `POST /projects/migrate`) exige un token configurado (`503 server authorization is not configured` si no lo hay), cuerpo ≤ 8 KiB `{ target_project, confirmed: true, session_ids?, observation_ids?, prompt_ids? }`. Respuesta `200`: `status` (`rescued` o `partially_rescued`), `complete`, `blocked`, `target_project` (normalizado), los contadores, `journaled_local` y `reconciliation_status: "local journal pending autosync"`. Avisa de escritura solo si cambió algo.

## Reintento de relaciones diferidas

`odin conflicts deferred --replay` y `POST /conflicts/deferred/replay` ejecutan `replayDeferred(store)` y devuelven `{ retried, succeeded, failed, dead }`. La CLI usa `Cli.syncApply.replayDeferred` si existe (gancho de pruebas). También se reintenta de forma automática al importar.

## Omisiones deliberadas

- Sincronización por mutaciones, autosync y rescate de propiedad sobre proyectos inscritos (F9.2 y F9.4). La sincronización por chunks con la nube está en `30-cloud/`.
- El arranque desde un diario anterior a esta versión.
