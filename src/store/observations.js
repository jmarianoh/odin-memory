import { createHash } from 'node:crypto';
import { normalizeProject, normalizeProjectName } from '../project/canonical.js';
import { now } from '../timeutil/index.js';
import { storeError } from './errors.js';
import { SYNC_ENTITY, SYNC_OP_DELETE, SYNC_OP_UPSERT, journalMutation, sessionProject } from './journal.js';
import { resolveWriteProject, validateSessionId } from './sessions.js';
import {
  TRUNCATION_MARKER,
  byteLength,
  goTrim,
  hashNormalized,
  newSyncId,
  normalizeScope,
  normalizeTopicKey,
  nullableString,
  stripPrivateTags,
  truncateContent,
} from './text.js';

export const OBSERVATION_STATE_ACTIVE = 'active';
export const OBSERVATION_STATE_NEEDS_REVIEW = 'needs_review';

/** Meses hasta la primera revisión, por tipo. Los tipos no listados no caducan. */
export const DECAY_REVIEW_AFTER_MONTHS = Object.freeze({
  decision: 6,
  policy: 12,
  preference: 3,
  config: 3,
  discovery: 6,
  pattern: 6,
  architecture: 12,
  bugfix: 12,
});

const SELECT_COLUMNS = `id, ifnull(sync_id, '') AS sync_id, session_id, type, title, content, tool_name, project,
  scope, topic_key, revision_count, duplicate_count, last_seen_at, review_after, pinned, created_at, updated_at, deleted_at, superseded_by_sync_id`;

/** Fila de la base → observación (`pinned` pasa a booleano). */
function toObservation(row) {
  if (!row) return null;
  return { ...row, pinned: Boolean(row.pinned) };
}

/**
 * Estado virtual derivado de `review_after`.
 * @param {string|null|undefined} reviewAfter
 * @param {Date} [at]
 * @returns {'active'|'needs_review'}
 */
export function observationState(reviewAfter, at = new Date()) {
  if (reviewAfter == null || goTrim(reviewAfter) === '') return OBSERVATION_STATE_ACTIVE;
  const ms = Date.parse(`${reviewAfter.replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(reviewAfter) ? '' : 'Z'}`);
  if (Number.isNaN(ms)) return OBSERVATION_STATE_ACTIVE;
  return ms <= at.getTime() ? OBSERVATION_STATE_NEEDS_REVIEW : OBSERVATION_STATE_ACTIVE;
}

/** `YYYY-MM-DD HH:MM:SS` UTC, `months` meses después de `from`. */
function reviewAfterFrom(months, from = new Date()) {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** @throws {StoreError} `observation_title_required` */
export function validateObservationTitle(title) {
  if (goTrim(title ?? '') === '') throw storeError('observation_title_required');
}

/** Valida y canonicaliza el proyecto esperado de una operación protegida. */
export function validateExpectedProject(expected) {
  try {
    const project = normalizeProjectName(expected);
    if (project !== '') return project;
  } catch {
    // se unifica en el error de abajo
  }
  throw storeError('expected_project_required');
}

function checkExpectedProject(obs, expected) {
  if (expected == null) return;
  if (normalizeProject(obs.project ?? '').normalized !== expected) throw storeError('observation_project_mismatch');
}

/** Contenido listo para guardar: sin etiquetas privadas y truncado por bytes. */
export function prepareStoredContent(store, content) {
  const stripped = stripPrivateTags(content ?? '');
  const limit = store.settings.maxObservationLength;
  return {
    content: truncateContent(stripped, limit),
    truncation: { original_bytes: byteLength(stripped), limit_bytes: limit, truncated: byteLength(stripped) > limit },
  };
}

/**
 * Huella canónica de las entradas con efecto de un guardado; se compara al
 * reintentar una operación idempotente. Cada campo va precedido de su longitud
 * en bytes (8 bytes, big endian).
 */
function saveFingerprint(p, title, content, project, scope, topicKey) {
  const h = createHash('sha256');
  for (const v of [p.session_id, p.type, title, content, p.tool_name ?? '', project, scope, topicKey]) {
    const bytes = Buffer.from(v ?? '', 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    h.update(length).update(bytes);
  }
  return `v1:${h.digest('hex')}`;
}

/** Observación por id leída desde una conexión (útil dentro de una transacción). */
export function getObservationRow(db, id, includeDeleted = false) {
  return toObservation(
    db.get(`SELECT ${SELECT_COLUMNS} FROM observations WHERE id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`, id),
  );
}

function captureVersion(db, obs) {
  db.run(
    `INSERT INTO observation_versions (observation_id, title, content, version, created_at)
     SELECT ?, ?, ?, COALESCE(MAX(version), 0) + 1, datetime('now')
     FROM observation_versions WHERE observation_id = ?`,
    obs.id, obs.title, obs.content, obs.id,
  );
}

/** Anota una observación en el diario de sincronización (dentro de su transacción). */
export function journalObservation(db, obs, op = SYNC_OP_UPSERT) {
  journalMutation(db, {
    entity: SYNC_ENTITY.observation,
    entityKey: obs.sync_id,
    op,
    project: obs.project ?? '',
    sessionId: obs.session_id,
    payload: () => ({ ...obs }),
  });
}

function recordSaveOperation(db, operationId, fingerprint, observationId, obs) {
  if (operationId) {
    db.run(
      'INSERT INTO observation_save_operations (operation_id, fingerprint, observation_id) VALUES (?, ?, ?)',
      operationId, fingerprint, observationId,
    );
  }
  journalObservation(db, obs);
}

/**
 * Inserta una observación nueva y le fija `review_after` según su tipo. Quien
 * llama es responsable de la preparación del texto, la propiedad de la sesión,
 * la deduplicación y el diario de sincronización.
 * @param {import('./db.js').Database} db
 * @param {{ session_id: string, type: string, title: string, content: string, tool_name?: string, project: string, scope: string, topic_key: string, hash: string }} row
 * @returns {number} id de la fila
 */
export function insertObservationRow(db, row) {
  const inserted = db.run(
    `INSERT INTO observations (sync_id, session_id, type, title, content, tool_name, project, scope, topic_key, normalized_hash, revision_count, duplicate_count, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CAST(? AS TEXT), ?, ?, ?, 1, 1, datetime('now'), datetime('now'))`,
    newSyncId('obs'), row.session_id, row.type, row.title, row.content,
    nullableString(row.tool_name), nullableString(row.project), row.scope, nullableString(row.topic_key), row.hash,
  );
  const id = Number(inserted.lastInsertRowid);
  const months = DECAY_REVIEW_AFTER_MONTHS[row.type];
  if (months !== undefined) db.run('UPDATE observations SET review_after = ? WHERE id = ?', reviewAfterFrom(months), id);
  return id;
}

/**
 * Guarda una observación.
 *
 * Reglas, en orden:
 *  1. Normaliza el proyecto, elimina `<private>…</private>` y trunca el contenido por bytes.
 *  2. Con `operation_id`, un reintento idéntico devuelve el resultado original
 *     (`replayed: true`); con otra carga falla con `observation_operation_conflict`.
 *  3. Resuelve el proyecto de escritura según la propiedad de la sesión.
 *  4. Con `topic_key`, si ya existe una observación viva con el mismo
 *     `topic_key`+proyecto+ámbito, la actualiza en el sitio guardando antes su versión.
 *  5. Si no, si hay una igual (mismo hash, proyecto, ámbito, tipo y título) dentro
 *     de la ventana de deduplicación, solo incrementa `duplicate_count`.
 *  6. Si no, inserta una nueva y le fija `review_after` según el tipo.
 *
 * @param {import('./store.js').Store} store
 * @param {object} p
 * @param {string} p.session_id
 * @param {string} p.type
 * @param {string} p.title
 * @param {string} p.content
 * @param {string} [p.tool_name]
 * @param {string} [p.project]
 * @param {string} [p.scope]
 * @param {string} [p.topic_key]
 * @param {string} [p.operation_id]
 * @returns {{ id: number, replayed: boolean }}
 */
export function addObservation(store, p) {
  const input = { ...p, session_id: p.session_id ?? '', project: normalizeProject(p.project ?? '').normalized };
  const title = stripPrivateTags(input.title ?? '');
  const { content } = prepareStoredContent(store, input.content);
  validateObservationTitle(title);
  if (content === '') throw storeError('observation_content_required');

  const scope = normalizeScope(input.scope);
  const hash = hashNormalized(content);
  const topicKey = normalizeTopicKey(input.topic_key);
  const fingerprint = saveFingerprint(input, title, content, input.project, scope, topicKey);
  const dedupeMinutes = Math.max(1, Math.floor(store.settings.dedupeWindowMs / 60_000));

  return store.db.writeTransaction((db) => {
    if (input.operation_id) {
      const committed = db.get(
        `SELECT o.id AS id, operation.fingerprint AS fingerprint
         FROM observation_save_operations AS operation
         LEFT JOIN observations AS o ON o.id = operation.observation_id AND o.deleted_at IS NULL
         WHERE operation.operation_id = ?`,
        input.operation_id,
      );
      if (committed) {
        if (!committed.fingerprint.startsWith('v1:')) throw storeError('observation_operation_expired');
        if (committed.fingerprint !== fingerprint) throw storeError('observation_operation_conflict');
        if (committed.id == null) throw storeError('observation_operation_expired');
        return { id: Number(committed.id), replayed: true };
      }
    }

    const project = resolveWriteProject(db, input.session_id, input.project);

    if (topicKey !== '') {
      const existing = db.get(
        `SELECT id FROM observations
         WHERE topic_key = ? AND ifnull(project, '') = ifnull(?, '') AND scope = ? AND deleted_at IS NULL
         ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
         LIMIT 1`,
        topicKey, nullableString(project), scope,
      );
      if (existing) {
        const id = Number(existing.id);
        captureVersion(db, getObservationRow(db, id));
        db.run(
          `UPDATE observations
           SET session_id = ?, type = ?, title = ?, content = ?, tool_name = ?, topic_key = ?, normalized_hash = ?,
               revision_count = revision_count + 1, last_seen_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`,
          input.session_id, input.type, title, content, nullableString(input.tool_name), nullableString(topicKey), hash, id,
        );
        recordSaveOperation(db, input.operation_id, fingerprint, id, getObservationRow(db, id));
        return { id, replayed: false };
      }
    }

    const duplicate = db.get(
      `SELECT id FROM observations
       WHERE normalized_hash = ? AND ifnull(project, '') = ifnull(?, '') AND scope = ? AND type = ? AND title = ?
         AND deleted_at IS NULL AND datetime(created_at) >= datetime('now', ?)
       ORDER BY created_at DESC
       LIMIT 1`,
      hash, nullableString(project), scope, input.type, title, `-${dedupeMinutes} minutes`,
    );
    if (duplicate) {
      const id = Number(duplicate.id);
      db.run(
        "UPDATE observations SET duplicate_count = duplicate_count + 1, last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        id,
      );
      recordSaveOperation(db, input.operation_id, fingerprint, id, getObservationRow(db, id));
      return { id, replayed: false };
    }

    const id = insertObservationRow(db, {
      session_id: input.session_id, type: input.type, title, content, tool_name: input.tool_name, project, scope, topic_key: topicKey, hash,
    });
    recordSaveOperation(db, input.operation_id, fingerprint, id, getObservationRow(db, id));
    return { id, replayed: false };
  });
}

/**
 * Id de la observación de una operación ya confirmada; 0 si no hay registro.
 * @throws {StoreError} `observation_operation_expired` si la observación fue borrada.
 */
export function getObservationSaveResult(store, operationId) {
  if (!operationId) return 0;
  const row = store.db.get(
    `SELECT o.id AS id FROM observation_save_operations AS operation
     LEFT JOIN observations AS o ON o.id = operation.observation_id AND o.deleted_at IS NULL
     WHERE operation.operation_id = ?`,
    operationId,
  );
  if (!row) return 0;
  if (row.id == null) throw storeError('observation_operation_expired');
  return Number(row.id);
}

/** true si existe algún registro (incluidas lápidas de borrado duro) de la operación. */
export function observationOperationRecorded(store, operationId) {
  if (!operationId) return false;
  return store.db.get('SELECT 1 AS found FROM observation_save_operations WHERE operation_id = ? LIMIT 1', operationId) !== undefined;
}

/** Observación viva por id, o null. */
export function getObservation(store, id) {
  return getObservationRow(store.db, id);
}

/** Versiones guardadas de una observación, de la más antigua a la más nueva. */
export function getObservationVersions(store, id) {
  return store.db.all(
    "SELECT id, observation_id, ifnull(title, '') AS title, content, version, ifnull(created_at, '') AS created_at FROM observation_versions WHERE observation_id = ? ORDER BY version ASC",
    id,
  );
}

export const DEFAULT_OBSERVATION_VERSION_PAGE_SIZE = 50;
export const MAX_OBSERVATION_VERSION_PAGE_SIZE = 100;

/**
 * Una página acotada del historial de versiones de una observación, de la más
 * antigua a la más reciente. `cursor` 0 empieza por las más recientes; un cursor
 * (`next_cursor` de la página anterior) continúa con las anteriores a esa versión.
 * `total` es siempre el número real de versiones guardadas.
 * @param {import('./store.js').Store} store
 * @param {number} id
 * @param {number} [limit] entre 1 y 100 (por defecto 50)
 * @param {number} [cursor]
 * @returns {{ versions: object[], total: number, has_more: boolean, next_cursor: number }}
 */
export function getObservationVersionPage(store, id, limit = DEFAULT_OBSERVATION_VERSION_PAGE_SIZE, cursor = 0) {
  if (limit < 1 || limit > MAX_OBSERVATION_VERSION_PAGE_SIZE) {
    throw new Error(`GetObservationVersionPage: limit must be between 1 and ${MAX_OBSERVATION_VERSION_PAGE_SIZE}`);
  }
  if (cursor < 0) throw new Error('GetObservationVersionPage: cursor must be non-negative');
  return store.db.readTransaction((db) => {
    const total = Number(db.get('SELECT COUNT(*) AS n FROM observation_versions WHERE observation_id = ?', id).n);
    let sql = "SELECT id, observation_id, ifnull(title, '') AS title, content, version, ifnull(created_at, '') AS created_at FROM observation_versions WHERE observation_id = ?";
    const args = [id];
    if (cursor > 0) {
      sql += ' AND version < ?';
      args.push(cursor);
    }
    sql += ' ORDER BY version DESC LIMIT ?';
    args.push(limit + 1);
    const fetched = db.all(sql, ...args);
    const hasMore = fetched.length > limit;
    const versions = (hasMore ? fetched.slice(0, limit) : fetched).reverse();
    return { versions, total, has_more: hasMore, next_cursor: hasMore ? versions[0].version : 0 };
  });
}

/**
 * Sustituye `find` por `replacement` respetando el límite de tamaño.
 * @returns {{ content: string, noop: boolean }}
 */
export function replaceObservationContent(content, find, replacement, max) {
  if (find === '') return { content, noop: true };
  let prefix = content;
  let marker = '';
  let oversized = byteLength(content) > max;
  if (content.endsWith(TRUNCATION_MARKER)) {
    marker = TRUNCATION_MARKER;
    prefix = content.slice(0, content.length - marker.length);
    oversized = byteLength(prefix) > max;
  }
  if (!prefix.includes(find)) return { content, noop: true };
  if (oversized) throw storeError('observation_find_replace_legacy_content_large');
  const growth = byteLength(replacement) - byteLength(find);
  if (growth > 0) {
    const remaining = max - byteLength(prefix);
    const occurrences = prefix.split(find).length - 1;
    if (remaining < 0 || occurrences > Math.floor(remaining / growth)) throw storeError('observation_find_replace_result_too_large');
  }
  prefix = stripPrivateTags(prefix.split(find).join(replacement));
  if (prefix === '') throw storeError('observation_content_required');
  if (byteLength(prefix) > max) throw storeError('observation_find_replace_result_too_large');
  const result = prefix + marker;
  return { content: result, noop: result === content };
}

/**
 * Actualiza una observación. Los campos ausentes (`undefined`) no se tocan; el
 * proyecto es inmutable. Solo se guarda una versión si cambian título o contenido,
 * pero `revision_count` sube siempre.
 *
 * @param {import('./store.js').Store} store
 * @param {number} id
 * @param {{ type?: string, title?: string, content?: string, find?: string, replace?: string, project?: string, scope?: string, topic_key?: string }} p
 * @param {{ expectedProject?: string }} [options] con `expectedProject`, exige que sea el dueño
 * @returns {object} la observación actualizada
 */
export function updateObservation(store, id, p, { expectedProject } = {}) {
  const expected = expectedProject === undefined ? null : validateExpectedProject(expectedProject);
  const max = store.settings.maxObservationLength;
  const hasFindReplace = p.find !== undefined || p.replace !== undefined;
  if (hasFindReplace && (p.find === undefined || p.replace === undefined)) throw storeError('observation_find_replace_pair_required');
  if (hasFindReplace && p.content !== undefined) throw storeError('observation_find_replace_content_conflict');
  if (hasFindReplace && (byteLength(p.find) > max || byteLength(p.replace) > max)) throw storeError('observation_find_replace_input_too_large');
  if (p.title !== undefined) validateObservationTitle(stripPrivateTags(p.title));
  if (p.content !== undefined && stripPrivateTags(p.content) === '') throw storeError('observation_content_required');
  const hasMetadata = [p.type, p.title, p.project, p.scope, p.topic_key].some((v) => v !== undefined);

  return store.db.writeTransaction((db) => {
    const obs = getObservationRow(db, id);
    if (!obs) throw storeError('observation_not_found');
    checkExpectedProject(obs, expected);
    const project = obs.project ?? '';
    if (goTrim(project) === '') throw storeError('project_required');

    let type = obs.type;
    let title = obs.title;
    let content = obs.content;
    let scope = obs.scope;
    let topicKey = obs.topic_key ?? '';
    if (p.type !== undefined) type = p.type;
    if (p.title !== undefined) title = stripPrivateTags(p.title);
    if (p.content !== undefined) content = prepareStoredContent(store, p.content).content;
    if (hasFindReplace) {
      const replaced = replaceObservationContent(content, p.find, p.replace, max);
      content = replaced.content;
      if (replaced.noop && !hasMetadata) return obs;
    }
    if (p.project !== undefined && normalizeProject(p.project).normalized !== project) throw storeError('observation_project_immutable');
    if (p.scope !== undefined) scope = normalizeScope(p.scope);
    if (p.topic_key !== undefined) topicKey = normalizeTopicKey(p.topic_key);

    if (title !== obs.title || content !== obs.content) captureVersion(db, obs);
    db.run(
      `UPDATE observations
       SET type = ?, title = ?, content = ?, project = CAST(? AS TEXT), scope = ?, topic_key = ?, normalized_hash = ?,
           revision_count = revision_count + 1, updated_at = datetime('now')
       WHERE id = ? AND deleted_at IS NULL`,
      type, title, content, nullableString(project), scope, nullableString(topicKey), hashNormalized(content), id,
    );
    const updated = getObservationRow(db, id);
    journalObservation(db, updated);
    return updated;
  });
}

/**
 * Borra una observación. El borrado suave marca `deleted_at`; el duro elimina la
 * fila, deja una lápida de sincronización y marca como huérfanas sus relaciones.
 * @param {import('./store.js').Store} store
 * @param {number} id
 * @param {{ hardDelete?: boolean, expectedProject?: string }} [options]
 */
export function deleteObservation(store, id, { hardDelete = false, expectedProject } = {}) {
  const expected = expectedProject === undefined ? null : validateExpectedProject(expectedProject);
  store.db.writeTransaction((db) => {
    const obs = getObservationRow(db, id, hardDelete);
    if (!obs) throw storeError('observation_not_found');
    checkExpectedProject(obs, expected);
    let project = obs.project ?? '';
    if (project === '') project = sessionProject(db, obs.session_id);
    project = normalizeProject(project).normalized;
    obs.project = nullableString(project);

    let deletedAt = now();
    if (hardDelete) {
      recordDeleteTombstone(db, SYNC_ENTITY.observation, obs.sync_id, obs.session_id, project, deletedAt);
      db.run('DELETE FROM observations WHERE id = ?', id);
      if (obs.sync_id !== '') {
        db.run(
          "UPDATE memory_relations SET judgment_status = 'orphaned', updated_at = datetime('now') WHERE source_id = ? OR target_id = ?",
          obs.sync_id, obs.sync_id,
        );
      }
    } else {
      db.run("UPDATE observations SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL", id);
      deletedAt = db.get('SELECT deleted_at FROM observations WHERE id = ?', id).deleted_at;
    }
    journalMutation(db, {
      entity: SYNC_ENTITY.observation,
      entityKey: obs.sync_id,
      op: SYNC_OP_DELETE,
      project,
      sessionId: obs.session_id,
      payload: () => ({ sync_id: obs.sync_id, session_id: obs.session_id, project: obs.project, deleted: true, deleted_at: deletedAt, hard_delete: hardDelete }),
    });
  });
}

/** Lápida de un borrado duro: evita que una réplica resucite la entidad. */
export function recordDeleteTombstone(db, entity, entityKey, sessionId, project, deletedAt) {
  entityKey = goTrim(entityKey ?? '');
  if (entityKey === '') throw new Error('sync delete tombstone entity key is required');
  const floorRow = db.get(
    'SELECT COALESCE(last_mutation_seq, 0) AS floor FROM sync_delete_tombstones WHERE entity = ? AND entity_key = ?',
    entity, entityKey,
  );
  const history = db.get(
    'SELECT COALESCE(MAX(seq), 0) AS history FROM sync_mutations WHERE entity = ? AND entity_key = ? AND op = ?',
    entity, entityKey, SYNC_OP_DELETE,
  ).history;
  const floor = Math.max(Number(floorRow?.floor ?? 0), Number(history));
  db.run(
    `INSERT INTO sync_delete_tombstones (entity, entity_key, session_id, project, deleted_at, hard_delete, active, last_mutation_seq)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?)
     ON CONFLICT(entity, entity_key) DO UPDATE SET
       session_id = excluded.session_id, project = excluded.project, deleted_at = excluded.deleted_at,
       hard_delete = excluded.hard_delete, active = 1,
       last_mutation_seq = MAX(sync_delete_tombstones.last_mutation_seq, excluded.last_mutation_seq),
       last_remote_mutation_seq = NULL`,
    entity, entityKey, nullableString(sessionId), normalizeProject(goTrim(project)).normalized, deletedAt, floor,
  );
  db.run('DELETE FROM sync_delete_tombstone_remote_floors WHERE entity = ? AND entity_key = ?', entity, entityKey);
}

function listObservations(store, { project = '', scope = '', limit, canonical, extra = '', order }) {
  let sql = `SELECT ${SELECT_COLUMNS} FROM observations o WHERE o.deleted_at IS NULL${extra}`;
  const args = [];
  if (project !== '') {
    sql += canonical ? ' AND LOWER(o.project) = ?' : ' AND o.project = ?';
    args.push(project);
  }
  if (scope !== '') {
    sql += ' AND o.scope = ?';
    args.push(normalizeScope(scope));
  }
  sql += ` ${order}`;
  if (limit > 0) {
    sql += ' LIMIT ?';
    args.push(limit);
  }
  return store.db.all(sql, ...args).map(toObservation);
}

const NEWEST_FIRST = 'ORDER BY datetime(o.created_at) DESC, o.id DESC';

/** Observaciones más recientes de un proyecto (normalizado) y ámbito. */
export function recentObservations(store, project = '', scope = '', limit = 0) {
  return listObservations(store, {
    project: normalizeProject(project).normalized,
    scope,
    limit: limit > 0 ? limit : store.settings.maxContextResults,
    canonical: true,
    order: NEWEST_FIRST,
  });
}

/** Todas las observaciones; el filtro de proyecto es exacto. */
export function allObservations(store, project = '', scope = '', limit = 0) {
  return listObservations(store, {
    project,
    scope,
    limit: limit > 0 ? limit : store.settings.maxContextResults,
    canonical: false,
    order: NEWEST_FIRST,
  });
}

/** Observaciones recientes que no están fijadas (las fijadas se muestran aparte). */
export function recentUnpinnedObservations(store, project = '', scope = '', limit = 0) {
  return listObservations(store, {
    project: normalizeProject(project).normalized,
    scope,
    limit: limit > 0 ? limit : store.settings.maxContextResults,
    canonical: true,
    extra: ' AND o.pinned = 0',
    order: NEWEST_FIRST,
  });
}

/** Observaciones de una sesión y proyecto para el contexto de compactación. */
export function compactionObservations(store, sessionId, project, pinned, limit = 0) {
  let sql = `SELECT ${SELECT_COLUMNS} FROM observations o
    WHERE o.deleted_at IS NULL AND o.session_id = ? AND LOWER(o.project) = ? AND o.pinned = ?
    ORDER BY datetime(o.created_at) DESC, o.id DESC`;
  const args = [sessionId, project, pinned ? 1 : 0];
  if (limit > 0) {
    sql += ' LIMIT ?';
    args.push(limit);
  }
  return store.db.all(sql, ...args).map(toObservation);
}

/** Observaciones fijadas (`pinned`) de un proyecto y ámbito; `limit` 0 = sin tope. */
export function pinnedObservations(store, project = '', scope = '', limit = 0) {
  return listObservations(store, {
    project: normalizeProject(project).normalized,
    scope,
    limit,
    canonical: true,
    extra: ' AND o.pinned = 1',
    order: NEWEST_FIRST,
  });
}

/** Observaciones de una sesión, de la más antigua a la más nueva (por defecto 200). */
export function sessionObservations(store, sessionId, limit = 200) {
  return store.db
    .all(
      `SELECT ${SELECT_COLUMNS} FROM observations WHERE session_id = ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT ?`,
      sessionId, limit > 0 ? limit : 200,
    )
    .map(toObservation);
}

function setPinned(store, id, pinned) {
  const res = store.db.run('UPDATE observations SET pinned = ? WHERE id = ? AND deleted_at IS NULL', pinned ? 1 : 0, id);
  if (Number(res.changes) === 0) throw storeError('observation_not_found');
}

/** Fija una observación; es un estado local que no se sincroniza. */
export function pinObservation(store, id) {
  setPinned(store, id, true);
}

export function unpinObservation(store, id) {
  setPinned(store, id, false);
}

/** Observaciones cuya fecha de revisión ya venció, la más atrasada primero. */
export function observationsNeedingReview(store, project = '', limit = 0) {
  return listObservations(store, {
    project: normalizeProject(project).normalized,
    limit: limit > 0 ? limit : store.settings.maxContextResults,
    canonical: true,
    extra: " AND o.review_after IS NOT NULL AND datetime(o.review_after) <= datetime('now')",
    order: 'ORDER BY datetime(o.review_after) ASC, o.id ASC',
  });
}

/**
 * Marca una observación como revisada y reprograma su próxima revisión según el
 * tipo (los tipos sin plazo quedan sin fecha). Con `project`, exige que sea el dueño.
 * @param {import('./store.js').Store} store
 * @param {number} id
 * @param {string} [project]
 */
export function markReviewed(store, id, project = '') {
  project = normalizeProject(project).normalized;
  store.db.writeTransaction((db) => {
    const scope = project !== '' ? ' AND LOWER(project) = ?' : '';
    const scopeArgs = project !== '' ? [project] : [];
    const current = db.get(`SELECT type, review_after FROM observations WHERE id = ? AND deleted_at IS NULL${scope}`, id, ...scopeArgs);
    if (!current) throw storeError('observation_not_found');
    const months = DECAY_REVIEW_AFTER_MONTHS[current.type];
    const reviewAfter = months === undefined ? null : reviewAfterFrom(months);
    const res = db.run(
      `UPDATE observations SET review_after = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL${scope}`,
      reviewAfter, now(), id, ...scopeArgs,
    );
    if (Number(res.changes) === 0) throw storeError('observation_not_found');
    const obs = getObservationRow(db, id);
    if (obs.review_after == null && current.review_after != null) {
      db.run('INSERT INTO review_clear_events (event_key, sync_id) VALUES (?, ?)', newSyncId('review-clear'), obs.sync_id);
    }
    journalObservation(db, obs);
  });
}
