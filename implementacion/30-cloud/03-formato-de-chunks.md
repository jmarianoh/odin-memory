# 30/03 — Formato de chunks en la nube

Módulo: `src/cloud/codec.js`. Lo comparten el cliente (`RemoteTransport.writeChunk`) y el servidor, de modo que ambos calculan el mismo identificador.

## Identificador y sobre comprimido

- `chunkId(payload)`: los 8 primeros hexadecimales del SHA-256 de la carga (cadena o bytes).
- Tipo del sobre: `application/vnd.odin.sync+gzip; version=1` (`compressedContentType()`).
- `isCompressedContentType(ct)`: vacío o de otro tipo → `false`; el tipo del sobre con versión distinta de `1` (o sin versión) → lanza `UnsupportedEnvelopeVersionError` (`unsupported compressed envelope version`). Los parámetros se comparan sin distinguir mayúsculas y admiten comillas.
- `acceptsCompressed(accept)`: lista separada por comas; cuenta un elemento con el tipo y `version=1` salvo que traiga `q` fuera de `(0, 1]` o no numérico.
- `hasGzipMagic(buf)`: empieza por `1f 8b`. `encodeCompressed` = gzip. `decodeCompressed(buf, max = 8 MiB)`: `max ≤ 0` → `decoded size limit must be positive`; más de `max` bytes descomprimidos → `PayloadTooLargeError` (`compressed payload exceeds decoded size limit`); gzip inválido → `decode compressed payload: <detalle>`.

## Cargas de mutación

`decodeMutationPayload(texto)`: recorta; vacío → `empty payload`; si es una cadena JSON se vuelve a analizar su contenido; el resultado debe ser un objeto (`payload must be a JSON object`).

## Forma canónica

`canonicalJson(valor)`: copia con **las claves de todos los objetos en orden alfabético** (por unidades de código), `JSON.stringify` compacto y escape de `<`, `>`, `&`, U+2028 y U+2029 como `<`, `>`, `&`, ` `, ` `.

`canonicalizeForProject(carga, proyecto)` devuelve el chunk canónico para un proyecto:

1. Analiza la carga: no JSON → `decode chunk data: <detalle>`; no objeto → `decode chunk data: chunk must be a JSON object`.
2. Si existe `mutations`: debe ser un arreglo (`mutations must be an array`; `null` pasa a `[]`). Se calculan las **sesiones dueñas** (entidad `session`, operación `upsert` o `delete`: su `entity_key` no vacío y el `id` de su carga, si es legible) y las **sesiones requeridas** (`session_id` de las observaciones y prompts del chunk y de las cargas de mutaciones `upsert` de observación o prompt).
3. Para `sessions`, `observations` y `prompts` (si están): `null` → `[]`; no arreglo → `<clave> must be an array`; cada fila debe ser un objeto (`<clave>[i] must be an object`). Las observaciones y prompts toman `project = proyecto`. Una sesión de modo `project_owned` exige que `directory`, si viene, sea cadena (`sessions[i]: pulled session directory is invalid: directory must be a string`). Una sesión toma el proyecto si no hay lista de mutaciones, si su `id` está en blanco, o si es dueña o requerida; en otro caso se deja tal cual.
4. Cada mutación se normaliza (abajo; error: `mutations[i]: <detalle>`).
5. Serializa con `canonicalJson`.

### Mutación

La fila se proyecta sobre los campos de `SyncMutation` y se vuelve a emitir (después, `canonicalJson` ordena las claves): `seq` (entero), `target_key`, `entity`, `entity_key`, `op`, `payload` (**cadena**), `source`, `project`, `occurred_at`, `acked_at` (opcional), `disposition`, `disposition_reason` y `disposition_evidence` (omitidos si vacíos), `disposition_at` (opcional). Los campos desconocidos se descartan; los ausentes salen vacíos/0. Un campo de otro tipo → `decode mutation: json: cannot unmarshal <tipo> into Go struct field SyncMutation.<campo> of type <tipo>`. Después:

- `entity` y `op` recortados; `entity_key` recortada salvo en sesiones (se respeta byte a byte).
- Combinaciones admitidas: `session`, `observation` y `prompt` con `upsert` o `delete`; `relation` solo con `upsert`. Otra: `unsupported mutation "<entidad>"/"<op>"`.
- `payload` recortado y no vacío (`payload is required`).
- La carga se normaliza según la entidad (abajo); `entity_key` vacía toma la clave de la carga y, si no coincide, `entity_key "<k>" does not match payload key "<c>"`. `project` pasa a ser el del chunk.

### Cargas por entidad

Cada carga se decodifica sobre una estructura con campos tipados (los nombres de clave se emparejan primero exactos y luego sin distinguir mayúsculas; un tipo erróneo → `decode mutation payload: json: cannot unmarshal <tipo> into Go struct field <Estructura>.<campo> of type <tipo>`; una carga que no es objeto → `decode mutation payload: payload must be a JSON object`) y se **vuelve a emitir con los campos en este orden y omitiendo los vacíos marcados** (`~`):

| Entidad | Campos (orden de salida) |
|---|---|
| sesión | `id`, `project`, `ownership_mode~`, `directory~`, `started_at~`, `ended_at~`, `summary~`, `deleted~`, `deleted_at~`, `hard_delete~` |
| observación | `superseded_by_sync_id~`, `sync_id`, `session_id`, `type`, `title`, `content`, `tool_name~`, `project~`, `scope`, `topic_key~`, `revision_count~`, `duplicate_count~`, `last_seen_at~`, `review_after~` (JSON tal cual; `null` explícito se conserva), `created_at~`, `updated_at~`, `deleted~`, `deleted_at~`, `hard_delete~` |
| prompt | `sync_id`, `session_id`, `content`, `project~`, `created_at~`, `deleted~`, `deleted_at~`, `hard_delete~` |
| relación | `sync_id`, `source_id`, `target_id`, `relation`, `reason~`, `evidence~`, `confidence~`, `judgment_status`, `marked_by_actor~`, `marked_by_kind~`, `marked_by_model~`, `session_id~`, `project`, `created_at~`, `updated_at~` |

Tipos: cadena (vacía si falta o es `null`), cadena opcional (`~`: se omite si falta o es `null`; una cadena vacía **no** se omite), booleano, entero (`~` omite el 0) y número opcional (`confidence`).

Reglas de normalización (mensajes literales):

- **Sesión**: `id` no vacío (`session payload id is required`); `directory` recortado; en `upsert`, si el modo no es `project_owned`, `directory` obligatorio (`session payload directory is required for upsert`); en `delete` se eliminan `directory`, `started_at`, `ended_at` y `summary`, y un `deleted_at` en blanco se elimina; `project` = el del chunk.
- **Observación**: `sync_id` recortado y no vacío (`observation payload sync_id is required`); en `upsert`, `session_id` obligatorio (`… session_id is required for upsert`) y `type`, `title`, `content` y `scope` recortados y no vacíos (`observation payload <campo> is required for upsert`); `project` = el del chunk.
- **Prompt**: `sync_id` (`prompt payload sync_id is required`); en `upsert`, `session_id` obligatorio y `content` recortado y no vacío (`prompt payload content is required for upsert`); `project` = el del chunk.
- **Relación**: `sync_id`, `source_id`, `target_id`, `relation` y `judgment_status` recortados y no vacíos (`relation payload <campo> is required for upsert`); `marked_by_actor` y `marked_by_kind` recortados, presentes y no vacíos; `project` = el del chunk.

## Resumen y comparación

- `summarizeChunk(carga)`: `{ sessions, observations, prompts }` = longitudes de esos arreglos (0 si no hay o la carga es ilegible).
- `normalizeJson(carga)`: el JSON con las claves ordenadas, para comparar por valor (si no es JSON, devuelve el texto).

## Validación de referencias

`validateChunkSessionReferences(chunk, conocidas)` — una sesión «existe» si está en `sessions`, en una mutación `session`/`upsert` del chunk (id de la carga o clave de entidad) o en `conocidas`:

- Sesión sin `id` → `sessions[i].id is required`.
- Mutación de sesión `upsert` sin carga legible → `mutations[i] invalid payload: <detalle>`; sin id ni clave → `mutations[i].payload.id is required for session upsert`.
- Observación o prompt sin `session_id` → `<clave>[i].session_id is required`; con una sesión inexistente → `<clave>[i] references missing session_id "<id>"`.
- Mutación de observación o prompt: carga ilegible → `mutations[i] invalid payload: …`; solo en `upsert`: sin `session_id` → `mutations[i].payload.session_id is required for upsert`; inexistente → `mutations[i] references missing session_id "<id>"`.
