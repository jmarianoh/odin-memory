import { normalizeProject } from '../project/canonical.js';
import { decodeSyncPayload, SYNC_SESSION_IDENTITY_INVALID } from './sync-apply.js';
import { SESSION_OWNERSHIP_PROJECT_OWNED, validateSessionId } from './sessions.js';
import { DEFAULT_SYNC_TARGET_KEY, SYNC_INBOX_TARGET_KEY } from './sync-state.js';
import { SQL_WHITESPACE_TRIM_SET, goTrim } from './text.js';

/** Razón de bloqueo para cargas que ningún reparador determinista sabe corregir. */
export const UPGRADE_REASON_BLOCKED_LEGACY_MUTATION_MANUAL = 'upgrade_blocked_legacy_mutation_manual';

export const SYNC_MUTATION_DISPOSITION = Object.freeze({ pending: 'pending', quarantined: 'quarantined', superseded: 'superseded' });

const normalized = (project) => goTrim(normalizeProject(goTrim(project ?? '')).normalized);

/**
 * Sesiones, sin cargas de observaciones ni prompts. `project` se lee con `ifnull`: una base
 * migrada desde el esquema en que era anulable aún puede traer NULL.
 * @param {import('./store.js').Store} store
 * @param {string} [project]
 * @returns {{ id: string, project: string, ownership_mode: string, directory: string, name: string }[]}
 */
export function listDiagnosticSessions(store, project = '') {
  const name = normalized(project);
  let sql = "SELECT id, ifnull(project, '') AS project, ifnull(ownership_mode, '') AS ownership_mode, ifnull(directory, '') AS directory, id AS name FROM sessions";
  const params = [];
  if (name !== '') {
    sql += ' WHERE project = ?';
    params.push(name);
  }
  sql += ' ORDER BY started_at DESC, id ASC';
  return store.db.all(sql, ...params);
}

/** Observaciones cuya sesión no existe, agrupadas por referencia (incluye las borradas). */
export function listOrphanedObservationSessionEvidence(store, project = '') {
  const name = normalized(project);
  let sql = `SELECT ifnull(o.project, '') AS project, o.session_id AS session_id, COUNT(*) AS observation_count, MIN(o.created_at) AS first_observed_at
    FROM observations o
    LEFT JOIN sessions s ON s.id = o.session_id
    WHERE s.id IS NULL
      AND length(trim(o.session_id, ?)) > 0`;
  const params = [SQL_WHITESPACE_TRIM_SET];
  if (name !== '') {
    sql += ' AND o.project = ?';
    params.push(name);
  }
  sql += " GROUP BY ifnull(o.project, ''), o.session_id ORDER BY ifnull(o.project, ''), o.session_id";
  return store.db.all(sql, ...params).map((r) => ({ ...r, observation_count: Number(r.observation_count) }));
}

const SOURCE_PRESENT = 'EXISTS (SELECT 1 FROM observations src WHERE src.sync_id = r.source_id AND src.deleted_at IS NULL)';
const TARGET_PRESENT = 'EXISTS (SELECT 1 FROM observations tgt WHERE tgt.sync_id = r.target_id AND tgt.deleted_at IS NULL)';

/** Relaciones pendientes con ambos extremos ausentes. */
export const ORPHANED_PENDING_RELATION_CANDIDATE = `r.judgment_status = 'pending' AND NOT ${SOURCE_PRESENT} AND NOT ${TARGET_PRESENT}`;
const ONE_ENDPOINT_MISSING = `r.judgment_status = 'pending' AND ((NOT ${SOURCE_PRESENT} AND ${TARGET_PRESENT}) OR (${SOURCE_PRESENT} AND NOT ${TARGET_PRESENT}))`;
const LIVE_PENDING = `r.judgment_status = 'pending' AND ${SOURCE_PRESENT} AND ${TARGET_PRESENT}`;

const count = (db, predicate) => Number(db.get(`SELECT count(*) AS n FROM memory_relations r WHERE ${predicate}`).n);

const RELATION_COLUMNS = "r.id AS id, ifnull(r.sync_id, '') AS sync_id, ifnull(r.source_id, '') AS source_id, ifnull(r.target_id, '') AS target_id";

/** Candidatas completas, más los recuentos de relaciones que no se tocan. */
export function listOrphanedPendingRelationEvidence(store, db = store.db) {
  return {
    candidates: db.all(`SELECT ${RELATION_COLUMNS} FROM memory_relations r WHERE ${ORPHANED_PENDING_RELATION_CANDIDATE} ORDER BY r.id`),
    one_endpoint_missing: count(db, ONE_ENDPOINT_MISSING),
    live_pending: count(db, LIVE_PENDING),
  };
}

/** Lectura acotada para el chequeo: el total y solo las primeras `limit` filas. */
export function listOrphanedPendingRelationEvidenceBounded(store, limit) {
  const report = {
    candidate_count: count(store.db, ORPHANED_PENDING_RELATION_CANDIDATE),
    one_endpoint_missing: count(store.db, ONE_ENDPOINT_MISSING),
    live_pending: count(store.db, LIVE_PENDING),
    sample: [],
  };
  if (report.candidate_count === 0 || limit <= 0) return report;
  report.sample = store.db.all(`SELECT ${RELATION_COLUMNS} FROM memory_relations r WHERE ${ORPHANED_PENDING_RELATION_CANDIDATE} ORDER BY r.id LIMIT ?`, limit);
  return report;
}

/** Contadores de relaciones tras reclasificar (para el reparador). */
export function countOrphanedPendingRelations(db) {
  return {
    candidates: count(db, ORPHANED_PENDING_RELATION_CANDIDATE),
    one_endpoint_missing: count(db, ONE_ENDPOINT_MISSING),
    live_pending: count(db, LIVE_PENDING),
  };
}

const MUTATION_COLUMNS = `seq, target_key, entity, entity_key, op, payload, source, project, occurred_at, acked_at, disposition,
  ifnull(disposition_reason, '') AS disposition_reason, ifnull(disposition_evidence, '') AS disposition_evidence, disposition_at`;

/** Mutaciones pendientes del objetivo `cloud`, sin filtrar por inscripción. */
export function listPendingProjectMutations(store, project = '', db = store.db) {
  const name = normalized(project);
  let sql = `SELECT ${MUTATION_COLUMNS} FROM sync_mutations WHERE target_key = ? AND acked_at IS NULL`;
  const params = [DEFAULT_SYNC_TARGET_KEY];
  if (name !== '') {
    sql += ' AND project = ?';
    params.push(name);
  }
  sql += ' ORDER BY seq ASC';
  return db.all(sql, ...params).map((m) => ({ ...m, seq: Number(m.seq), acked_at: m.acked_at ?? null, disposition_at: m.disposition_at ?? null }));
}

/**
 * Observaciones activas a las que les falta tipo, título o contenido (vacíos o en blanco).
 * No depende de `sync_mutations`.
 * @returns {{ id: number, sync_id: string, project: string, missing_fields: string[], title: string, content: string }[]}
 */
export function listObservationRequiredFieldRows(store, project = '', db = store.db) {
  const name = normalized(project);
  let sql = "SELECT id, ifnull(sync_id, '') AS sync_id, ifnull(project, '') AS project, ifnull(type, '') AS type, ifnull(title, '') AS title, ifnull(content, '') AS content FROM observations WHERE deleted_at IS NULL";
  const params = [];
  if (name !== '') {
    sql += ' AND project = ?';
    params.push(name);
  }
  sql += ' ORDER BY id ASC';
  const rows = [];
  for (const row of db.all(sql, ...params)) {
    const missing = [];
    if (goTrim(row.type) === '') missing.push('type');
    if (goTrim(row.title) === '') missing.push('title');
    if (goTrim(row.content) === '') missing.push('content');
    if (missing.length > 0) rows.push({ id: Number(row.id), sync_id: row.sync_id, project: normalized(row.project), missing_fields: missing, title: row.title, content: row.content });
  }
  return rows;
}

/** Igual que `listObservationRequiredFieldRows` sin los textos (evidencia publicable). */
export function listDiagnosticObservationRequiredFields(store, project = '') {
  return listObservationRequiredFieldRows(store, project).map(({ id, sync_id, project: p, missing_fields }) => ({ id, sync_id, project: p, missing_fields }));
}

function validateSessionMutationIdentity(payloadId, entityKey) {
  try {
    validateSessionId(payloadId);
    validateSessionId(entityKey);
  } catch {
    return false;
  }
  return payloadId === entityKey;
}

/** Sesiones con ID en blanco, con lo que cuelga de ellas y las entradas inválidas del diario. */
export function listInvalidSessionIdentityEvidence(store, project = '') {
  const name = normalized(project);
  let sql = "SELECT id, ifnull(project, '') AS project FROM sessions WHERE length(trim(id, ?)) = 0";
  const params = [SQL_WHITESPACE_TRIM_SET];
  if (name !== '') {
    sql += ' AND project = ?';
    params.push(name);
  }
  const evidence = store.db.all(sql, ...params).map((r) => ({
    project: r.project, session_id: r.id, observation_count: 0, prompt_count: 0, invalid_journal_count: 0,
  }));

  let mutationSql = 'SELECT entity_key, payload FROM sync_mutations WHERE entity = ?';
  const mutationParams = ['session'];
  if (name !== '') {
    mutationSql += ' AND project = ?';
    mutationParams.push(name);
  }
  const bySessionId = new Map(evidence.map((item, i) => [item.session_id, i]));
  for (const mutation of store.db.all(mutationSql, ...mutationParams)) {
    let payloadId = '';
    let decoded = false;
    let invalid;
    try {
      const payload = decodeSyncPayload(mutation.payload);
      payloadId = typeof payload?.id === 'string' ? payload.id : '';
      decoded = true;
      invalid = !validateSessionMutationIdentity(payloadId, mutation.entity_key);
    } catch {
      invalid = true;
    }
    if (!invalid) continue;
    const matched = new Set();
    if (bySessionId.has(mutation.entity_key)) matched.add(bySessionId.get(mutation.entity_key));
    if (decoded && bySessionId.has(payloadId)) matched.add(bySessionId.get(payloadId));
    for (const i of matched) evidence[i].invalid_journal_count += 1;
  }
  for (const item of evidence) {
    item.observation_count = Number(store.db.get('SELECT COUNT(*) AS n FROM observations WHERE session_id = ?', item.session_id).n);
    item.prompt_count = Number(store.db.get('SELECT COUNT(*) AS n FROM user_prompts WHERE session_id = ?', item.session_id).n);
  }
  return evidence;
}

/** Mutaciones de sesión recibidas que se omitieron por identidad en blanco o inconsistente. */
export function listQuarantinedPulledSessionEvidence(store, project = '') {
  const name = normalized(project);
  let sql = `SELECT sync_id, target_key, ifnull(project, '') AS project, entity_key, op, remote_seq, reason_code, ifnull(first_seen_at, '') AS first_seen_at
    FROM sync_apply_deferred WHERE entity = ? AND reason_code = ?`;
  const params = ['session', SYNC_SESSION_IDENTITY_INVALID];
  if (name !== '') {
    sql += ' AND project = ?';
    params.push(name);
  }
  sql += ' ORDER BY target_key ASC, remote_seq ASC, sync_id ASC';
  return store.db.all(sql, ...params).map((r) => ({ ...r, remote_seq: Number(r.remote_seq) }));
}

/** Proyectos inscritos en la nube, por nombre. */
export function listEnrolledProjects(store) {
  return store.db.all('SELECT project, enrolled_at FROM sync_enrolled_projects ORDER BY project ASC');
}

/** Mutaciones pendientes de proyectos no inscritos, por proyecto. */
export function countPendingNonEnrolledSyncMutations(store, targetKey = DEFAULT_SYNC_TARGET_KEY) {
  if (targetKey === SYNC_INBOX_TARGET_KEY) return [];
  return store.db.all(
    `SELECT sm.project AS project, COUNT(*) AS count
     FROM sync_mutations sm
     LEFT JOIN sync_enrolled_projects sep ON sm.project = sep.project
     WHERE sm.target_key = ? AND sm.acked_at IS NULL AND sm.disposition = 'pending' AND sm.project != '' AND sep.project IS NULL
     GROUP BY sm.project ORDER BY sm.project ASC`,
    targetKey,
  ).map((r) => ({ project: r.project, count: Number(r.count) }));
}

/** Cada fila de `sync_state` con sus mutaciones pendientes. */
export function listSyncStates(store) {
  return store.db.all(
    `SELECT ss.target_key AS target_key, ss.lifecycle AS lifecycle, (
       SELECT COUNT(*) FROM sync_mutations sm
       WHERE sm.acked_at IS NULL AND sm.disposition = 'pending'
         AND (sm.target_key = ss.target_key
           OR (ss.target_key LIKE ? AND ss.target_key <> ? AND sm.target_key = ? AND sm.project = substr(ss.target_key, 7)))
     ) AS unacked_mutations
     FROM sync_state ss ORDER BY ss.target_key ASC`,
    'cloud:%', SYNC_INBOX_TARGET_KEY, DEFAULT_SYNC_TARGET_KEY,
  ).map((r) => ({ ...r, unacked_mutations: Number(r.unacked_mutations) }));
}

/** Indicadores de bloqueo de SQLite: modo de diario, espera por bloqueo y punto de control pasivo. */
export function readSqliteLockSnapshot(store) {
  const db = store.db;
  const journal = db.get('PRAGMA journal_mode');
  const busy = db.get('PRAGMA busy_timeout');
  const checkpoint = db.get('PRAGMA wal_checkpoint(PASSIVE)');
  return {
    journal_mode: String(Object.values(journal)[0]),
    busy_timeout_ms: Number(Object.values(busy)[0]),
    checkpoint_busy: Number(checkpoint.busy),
    checkpoint_log: Number(checkpoint.log),
    checkpointed_frames: Number(checkpoint.checkpointed),
  };
}

/**
 * Validación pura de campos obligatorios de una carga de sincronización. Prudente: las
 * cargas vacías, ilegibles o de entidades desconocidas se informan como bloqueos manuales.
 * @returns {{ entity: string, op: string, entity_key?: string, missing_fields?: string[], reason_code?: string, message?: string }}
 */
export function validateSyncMutationPayload(entity, op, payload, entityKey) {
  entity = goTrim(entity ?? '');
  op = goTrim(op ?? '');
  const result = { entity, op };
  if (entityKey) result.entity_key = entityKey;
  const trimmed = goTrim(payload ?? '');
  if (trimmed === '') {
    result.reason_code = UPGRADE_REASON_BLOCKED_LEGACY_MUTATION_MANUAL;
    result.message = 'sync mutation payload is empty';
    return result;
  }
  let body;
  try {
    body = decodeSyncPayload(trimmed);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('payload is not an object');
  } catch (err) {
    result.reason_code = UPGRADE_REASON_BLOCKED_LEGACY_MUTATION_MANUAL;
    result.message = `decode sync mutation payload: ${err.message}`;
    return result;
  }
  const field = (name) => {
    const v = body[name];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? goTrim(v) : goTrim(JSON.stringify(v));
  };
  const rawString = (name) => (typeof body[name] === 'string' ? body[name] : '');
  const missing = [];
  const require = (name) => {
    if (field(name) === '') missing.push(name);
  };
  switch (entity) {
    case 'session': {
      const payloadId = rawString('id');
      if (goTrim(payloadId) === '') missing.push('id');
      if (goTrim(entityKey ?? '') === '') missing.push('entity_key');
      if (missing.length === 0 && payloadId !== entityKey) {
        result.reason_code = 'sync_session_mutation_identity_mismatch';
        result.message = `session entity_key ${JSON.stringify(entityKey)} does not match payload id ${JSON.stringify(payloadId)}`;
        return result;
      }
      if (op === 'upsert') {
        if (rawString('ownership_mode') === SESSION_OWNERSHIP_PROJECT_OWNED) {
          if (Object.hasOwn(body, 'directory') && typeof body.directory !== 'string') missing.push('directory');
        } else {
          require('directory');
        }
      }
      break;
    }
    case 'observation':
      if (field('sync_id') === '' && goTrim(entityKey ?? '') === '') missing.push('sync_id');
      if (op === 'upsert') for (const name of ['session_id', 'type', 'title', 'content', 'scope']) require(name);
      break;
    case 'prompt':
      if (field('sync_id') === '' && goTrim(entityKey ?? '') === '') missing.push('sync_id');
      if (op === 'upsert') for (const name of ['session_id', 'content']) require(name);
      break;
    case 'relation':
      if (op === 'upsert') for (const name of ['sync_id', 'source_id', 'target_id', 'relation', 'judgment_status', 'marked_by_actor', 'marked_by_kind', 'project']) require(name);
      break;
    default:
      result.reason_code = UPGRADE_REASON_BLOCKED_LEGACY_MUTATION_MANUAL;
      result.message = `unsupported sync mutation ${JSON.stringify(entity)}/${JSON.stringify(op)}`;
      return result;
  }
  if (missing.length > 0) {
    result.missing_fields = missing;
    result.reason_code = 'sync_mutation_payload_missing_required_fields';
    result.message = `${entity} payload missing required fields: ${missing.join(', ')}`;
  }
  return result;
}
