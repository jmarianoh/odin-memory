import { createHash } from 'node:crypto';
import { normalizeProject } from '../project/canonical.js';
import { normalizeComparableTimestamp, isStalePromptUpsert, preserveObservationProvenance } from './backup.js';
import { StoreError } from './errors.js';
import { SYNC_ENTITY, SYNC_OP_DELETE, SYNC_OP_UPSERT } from './journal.js';
import { recordDeleteTombstone, SELECT_COLUMNS } from './observations.js';
import { recordPromptTombstone } from './prompts.js';
import { validateSessionId } from './sessions.js';
import { SYNC_LIFECYCLE, normalizeSyncTargetKey } from './sync-state.js';
import { SQL_WHITESPACE_TRIM_SET, goTrim, hashNormalized, normalizeScope, nullableString } from './text.js';
import { now } from '../timeutil/index.js';

/** Destino con el que se registran los chunks locales (Git). */
export const LOCAL_CHUNK_TARGET_KEY = 'local';
export const SYNC_SOURCE_REMOTE = 'remote';

export const SYNC_SESSION_IDENTITY_INVALID = 'sync_session_identity_invalid';
export const SYNC_OBSERVATION_IDENTITY_INVALID = 'sync_observation_identity_invalid';
export const SYNC_PROMPT_IDENTITY_INVALID = 'sync_prompt_identity_invalid';
export const SYNC_PARENT_SESSION_MISSING = 'pulled_parent_session_missing';
/** Una relación diferida cuya mutación traía un proyecto externo: ese proyecto manda al reintentar. */
export const RELATION_OUTER_PROJECT_AUTHORITATIVE = 'relation_outer_project_authoritative';

export const RELATION_FK_MISSING = 'relation FK precondition not met: referenced observation missing';
export const RELATION_PROJECT_MISMATCH = 'relation FK precondition not met: referenced observation effective project mismatch';
const APPLY_DEAD = 'relation apply permanently failed: payload invalid or undecodable';

/** Meses hasta la primera revisión de las observaciones heredadas sin `review_after`. */
const LEGACY_REVIEW_AFTER_MONTHS = { decision: 6, policy: 12, preference: 3 };

const DEAD_THRESHOLD = 5;
const REPLAY_BATCH = 50;

/** Error de aplicación con código estable y, en los de relación, el texto base del contrato. */
class ApplyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApplyError';
    this.code = code;
  }
}

const relationFkMissing = () => new ApplyError('relation_fk_missing', RELATION_FK_MISSING);
const relationProjectMismatch = () => new ApplyError('relation_project_mismatch', RELATION_PROJECT_MISMATCH);
const applyDead = (detail) => new ApplyError('apply_dead', `${APPLY_DEAD}: ${detail}`);
const parentSessionMissing = (sessionId) => new ApplyError('parent_session_missing', `pulled parent session is missing: session ${JSON.stringify(sessionId)}`);
const identityInvalid = (code, detail) => new ApplyError(code, detail);

// ─── Carga de una mutación ───────────────────────────────────────────────────

/**
 * Decodifica la carga de una mutación: JSON, o JSON dentro de una cadena JSON.
 * @param {string} payload
 * @returns {any}
 */
export function decodeSyncPayload(payload) {
  const trimmed = goTrim(payload ?? '');
  if (trimmed === '') throw new Error('empty payload');
  if (trimmed[0] !== '"') return JSON.parse(trimmed);
  const encoded = JSON.parse(trimmed);
  return JSON.parse(encoded);
}

const text = (v) => (typeof v === 'string' ? v : '');
const optional = (v) => (v === undefined || v === null ? null : v);

function parseObservationTime(value) {
  const trimmed = goTrim(value);
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed) ? `${trimmed.replace(' ', 'T')}Z` : trimmed;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`parsing time ${JSON.stringify(value)}`);
  return new Date(ms);
}

const formatTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// ─── Sesiones ────────────────────────────────────────────────────────────────

const isSessionDeletePayload = (p) => p.deleted === true || p.hard_delete === true || (typeof p.deleted_at === 'string' && goTrim(p.deleted_at) !== '');

function validSessionOwnershipMode(mode) {
  return mode === 'shared' || mode === 'project_owned';
}

function applySessionPayload(db, p) {
  validateSessionId(p.id);
  if (isSessionDeletePayload(p)) return applySessionDelete(db, p);
  if (goTrim(text(p.ownership_mode)) !== '' && !validSessionOwnershipMode(p.ownership_mode)) {
    throw new StoreError('invalid_session_ownership_mode', `invalid session ownership mode ${JSON.stringify(p.ownership_mode)}`);
  }
  db.run(
    `INSERT INTO sessions (id, project, ownership_mode, directory, started_at, ended_at, summary)
     VALUES (?, ?, COALESCE(?, 'shared'), ?, COALESCE(NULLIF(?, ''), datetime('now')), ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project = CASE WHEN sessions.ownership_mode = 'project_owned' THEN sessions.project ELSE excluded.project END,
       ownership_mode = CASE
         WHEN sessions.ownership_mode = 'project_owned' OR excluded.ownership_mode IS NULL THEN sessions.ownership_mode
         ELSE excluded.ownership_mode END,
       directory = CASE WHEN trim(sessions.directory, ?) = '' THEN excluded.directory ELSE sessions.directory END,
       started_at = COALESCE(NULLIF(excluded.started_at, ''), sessions.started_at),
       ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
       summary = COALESCE(excluded.summary, sessions.summary)`,
    p.id, text(p.project), validSessionOwnershipMode(p.ownership_mode) ? p.ownership_mode : null, text(p.directory), goTrim(text(p.started_at)),
    optional(p.ended_at), optional(p.summary), SQL_WHITESPACE_TRIM_SET,
  );
  clearDeleteTombstoneForUpsert(db, SYNC_ENTITY.session, p.id);
}

function applySessionDelete(db, p) {
  validateSessionId(p.id);
  db.run('DELETE FROM user_prompts WHERE session_id = ?', p.id);
  db.run('DELETE FROM sessions WHERE id = ?', p.id);
}

function validateSessionMutationIdentity(payloadId, entityKey) {
  try {
    validateSessionId(payloadId);
  } catch (err) {
    throw new Error(`session mutation payload id: ${err.message}`);
  }
  try {
    validateSessionId(entityKey);
  } catch (err) {
    throw new Error(`session mutation entity_key: ${err.message}`);
  }
  if (payloadId !== entityKey) throw new Error(`session mutation entity_key ${JSON.stringify(entityKey)} does not match payload id ${JSON.stringify(payloadId)}`);
}

// ─── Lápidas ─────────────────────────────────────────────────────────────────

function clearDeleteTombstoneForUpsert(db, entity, entityKey) {
  if (entity !== SYNC_ENTITY.session && entity !== SYNC_ENTITY.observation) return;
  db.run('UPDATE sync_delete_tombstones SET active = 0 WHERE entity = ? AND entity_key = ?', entity, entityKey);
}

/** Una lápida de borrado duro bloquea el alta si la generación entrante no es posterior al borrado. */
function localUpsertBlockedByTombstone(db, entity, entityKey, generation) {
  const row = db.get('SELECT deleted_at, hard_delete FROM sync_delete_tombstones WHERE entity = ? AND entity_key = ?', entity, entityKey);
  if (!row || !row.hard_delete) return false;
  const incoming = normalizeComparableTimestamp(generation);
  const deletedAt = normalizeComparableTimestamp(row.deleted_at);
  return incoming !== '' && deletedAt !== '' && incoming <= deletedAt;
}

// ─── Observaciones ───────────────────────────────────────────────────────────

function requireParentSession(db, sessionId) {
  const found = db.get('SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?) AS found', sessionId).found;
  if (Number(found) === 0) throw parentSessionMissing(sessionId);
}

function observationBySyncId(db, syncId) {
  return db.get(`SELECT ${SELECT_COLUMNS} FROM observations WHERE sync_id = ? ORDER BY id DESC LIMIT 1`, syncId);
}

function observationProvenance(db, syncId, incoming) {
  if (typeof incoming === 'string' && incoming !== '') return incoming;
  return db.get(
    `SELECT COALESCE(
  (SELECT superseded_by_sync_id FROM observations WHERE sync_id = ?),
  (SELECT superseded_by_sync_id FROM sync_delete_tombstones WHERE entity = 'observation' AND entity_key = ?)) AS link`,
    syncId, syncId,
  ).link ?? null;
}

function applyObservationUpsert(db, p) {
  requireParentSession(db, p.session_id);
  const positive = (n, fallback) => Math.max(Number.isInteger(n) ? n : 0, fallback);
  let revisionCount = positive(p.revision_count, 1);
  let duplicateCount = positive(p.duplicate_count, 1);
  let createdAt = goTrim(text(p.created_at));
  let updatedAt = goTrim(text(p.updated_at));
  if (createdAt === '') createdAt = now();
  if (updatedAt === '') updatedAt = createdAt;

  const hasReviewAfter = Object.hasOwn(p, 'review_after');
  let reviewAfter = null;
  if (hasReviewAfter && p.review_after !== null) {
    if (typeof p.review_after !== 'string') throw new Error('decode review_after: expected a string or null');
    try {
      parseObservationTime(p.review_after);
    } catch (err) {
      throw new Error(`invalid review_after: ${err.message}`);
    }
    reviewAfter = p.review_after;
  }

  const existing = observationBySyncId(db, p.sync_id);
  if (!existing) {
    if (!hasReviewAfter && LEGACY_REVIEW_AFTER_MONTHS[p.type] !== undefined) {
      let created;
      try {
        created = parseObservationTime(createdAt);
      } catch (err) {
        throw new Error(`derive review_after from created_at: ${err.message}`);
      }
      reviewAfter = formatTime(new Date(Date.UTC(
        created.getUTCFullYear(), created.getUTCMonth() + LEGACY_REVIEW_AFTER_MONTHS[p.type], created.getUTCDate(),
        created.getUTCHours(), created.getUTCMinutes(), created.getUTCSeconds(),
      )));
    }
    db.run(
      `INSERT INTO observations (sync_id, session_id, type, title, content, tool_name, project, scope, topic_key, normalized_hash, revision_count, duplicate_count, last_seen_at, review_after, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS TEXT), ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      p.sync_id, p.session_id, text(p.type), text(p.title), text(p.content), optional(p.tool_name), optional(p.project), normalizeScope(p.scope),
      optional(p.topic_key), hashNormalized(text(p.content)), revisionCount, duplicateCount, optional(p.last_seen_at), reviewAfter, createdAt, updatedAt,
    );
    preserveObservationProvenance(db, p.sync_id, optional(p.superseded_by_sync_id));
    clearDeleteTombstoneForUpsert(db, SYNC_ENTITY.observation, p.sync_id);
    return;
  }

  if (!(p.revision_count > 0)) revisionCount = Math.max(existing.revision_count, 1);
  if (!(p.duplicate_count > 0)) duplicateCount = Math.max(existing.duplicate_count, 1);
  const lastSeenAt = p.last_seen_at === undefined || p.last_seen_at === null ? existing.last_seen_at : p.last_seen_at;
  if (!hasReviewAfter) reviewAfter = existing.review_after;
  if (goTrim(text(p.created_at)) === '') createdAt = existing.created_at;
  if (goTrim(text(p.updated_at)) === '') updatedAt = existing.updated_at;

  db.run(
    `UPDATE observations
     SET session_id = ?, type = ?, title = ?, content = ?, tool_name = ?, project = CAST(? AS TEXT), scope = ?, topic_key = ?, normalized_hash = ?, revision_count = ?, duplicate_count = ?, last_seen_at = ?, review_after = ?, created_at = ?, updated_at = ?, deleted_at = NULL
     WHERE id = ?`,
    p.session_id, text(p.type), text(p.title), text(p.content), optional(p.tool_name), optional(p.project), normalizeScope(p.scope), optional(p.topic_key),
    hashNormalized(text(p.content)), revisionCount, duplicateCount, lastSeenAt ?? null, reviewAfter, createdAt, updatedAt, existing.id,
  );
  preserveObservationProvenance(db, p.sync_id, optional(p.superseded_by_sync_id));
  clearDeleteTombstoneForUpsert(db, SYNC_ENTITY.observation, p.sync_id);
}

function applyObservationDelete(db, p) {
  const existing = observationBySyncId(db, p.sync_id);
  if (!existing) return;
  if (p.hard_delete) {
    db.run('DELETE FROM observations WHERE id = ?', existing.id);
    return;
  }
  let deletedAt = typeof p.deleted_at === 'string' ? p.deleted_at : null;
  let updatedAt = goTrim(text(p.updated_at));
  if (deletedAt === null) {
    deletedAt = now();
    if (updatedAt === '') updatedAt = deletedAt;
  }
  if (updatedAt === '') updatedAt = deletedAt;
  db.run(
    "UPDATE observations SET deleted_at = ?, updated_at = ?, superseded_by_sync_id = COALESCE(NULLIF(?, ''), superseded_by_sync_id) WHERE id = ?",
    deletedAt, updatedAt, text(p.superseded_by_sync_id), existing.id,
  );
}

function preserveObservationDeleteProvenance(db, p, active) {
  if (typeof p.superseded_by_sync_id !== 'string' || p.superseded_by_sync_id === '') return;
  const deletedAt = text(p.deleted_at) || now();
  db.run(
    `INSERT INTO sync_delete_tombstones
       (entity, entity_key, session_id, project, deleted_at, hard_delete, active, superseded_by_sync_id)
     VALUES ('observation', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity, entity_key) DO UPDATE SET superseded_by_sync_id = excluded.superseded_by_sync_id`,
    p.sync_id, nullableString(text(p.session_id)), text(p.project), deletedAt, p.hard_delete ? 1 : 0, active ? 1 : 0, p.superseded_by_sync_id,
  );
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

function applyPromptUpsert(db, p) {
  const tombstone = db.get("SELECT deleted_at, ifnull(source_inbox_id, '') AS source_inbox_id FROM prompt_tombstones WHERE sync_id = ?", p.sync_id);
  if (tombstone && tombstone.source_inbox_id !== '') return;
  if (tombstone && isStalePromptUpsert(text(p.created_at), tombstone.deleted_at)) return;
  const inboxId = text(p.source_inbox_id);
  if (inboxId !== '') {
    const deleted = db.get('SELECT EXISTS(SELECT 1 FROM prompt_tombstones WHERE session_id = ? AND source_inbox_id = ?) AS n', p.session_id, inboxId).n;
    if (Number(deleted) === 1) return;
  }
  requireParentSession(db, p.session_id);
  if (tombstone) db.run('DELETE FROM prompt_tombstones WHERE sync_id = ?', p.sync_id);

  if (inboxId !== '') {
    const owner = db.get('SELECT sync_id FROM user_prompts WHERE session_id = ? AND source_inbox_id = ?', p.session_id, inboxId);
    if (owner && owner.sync_id !== p.sync_id) {
      throw identityInvalid('pulled_prompt_identity_invalid', `prompt inbox identity conflict for session ${JSON.stringify(p.session_id)} and inbox ID ${JSON.stringify(inboxId)}`);
    }
  }
  const existing = db.get("SELECT id, session_id, ifnull(source_inbox_id, '') AS source_inbox_id FROM user_prompts WHERE sync_id = ? ORDER BY id DESC LIMIT 1", p.sync_id);
  if (existing && existing.source_inbox_id !== '' && (existing.session_id !== p.session_id || (inboxId !== '' && existing.source_inbox_id !== inboxId))) {
    throw identityInvalid(
      'pulled_prompt_identity_invalid',
      `prompt inbox identity conflict for sync ID ${JSON.stringify(p.sync_id)}: existing session ${JSON.stringify(existing.session_id)} and inbox ID ${JSON.stringify(existing.source_inbox_id)}, received session ${JSON.stringify(p.session_id)} and inbox ID ${JSON.stringify(inboxId)}`,
    );
  }
  const project = optional(p.project);
  if (!existing) {
    if (goTrim(text(p.created_at)) === '') {
      db.run('INSERT INTO user_prompts (sync_id, session_id, content, project, source_inbox_id) VALUES (?, ?, ?, ?, ?)', p.sync_id, p.session_id, text(p.content), project, nullableString(inboxId));
    } else {
      db.run('INSERT INTO user_prompts (sync_id, session_id, content, project, created_at, source_inbox_id) VALUES (?, ?, ?, ?, ?, ?)', p.sync_id, p.session_id, text(p.content), project, p.created_at, nullableString(inboxId));
    }
    return;
  }
  db.run(
    `UPDATE user_prompts
     SET session_id = ?, content = ?, project = ?, source_inbox_id = COALESCE(?, source_inbox_id),
         created_at = CASE WHEN ? = '' THEN created_at ELSE ? END
     WHERE id = ?`,
    p.session_id, text(p.content), project, nullableString(inboxId), goTrim(text(p.created_at)), text(p.created_at), existing.id,
  );
}

function applyPromptDelete(db, p) {
  if (goTrim(text(p.sync_id)) === '') return;
  const row = db.get("SELECT session_id, ifnull(source_inbox_id, '') AS source_inbox_id, ifnull(project, '') AS project FROM user_prompts WHERE sync_id = ?", p.sync_id);
  let sessionId = text(p.session_id);
  let inboxId = text(p.source_inbox_id);
  if (inboxId !== '' && goTrim(sessionId) !== '') {
    const other = db.get('SELECT sync_id FROM user_prompts WHERE session_id = ? AND source_inbox_id = ?', sessionId, inboxId);
    if (other && other.sync_id !== p.sync_id) {
      throw identityInvalid('pulled_prompt_identity_invalid', `pulled prompt identity is invalid: delete prompt ${JSON.stringify(p.sync_id)} conflicts with inbox identity owned by ${JSON.stringify(other.sync_id)}`);
    }
  }
  if (row) {
    sessionId = row.session_id;
    inboxId = row.source_inbox_id;
  }
  if (inboxId !== '' && goTrim(sessionId) === '') {
    throw identityInvalid('pulled_prompt_identity_invalid', `pulled prompt identity is invalid: delete prompt ${JSON.stringify(p.sync_id)}: session id is required for source inbox id`);
  }
  let project = typeof p.project === 'string' ? p.project : null;
  if (project === null || goTrim(project) === '') {
    let owner = row?.project ?? '';
    if (goTrim(owner) === '') owner = db.get('SELECT ifnull(project, \'\') AS project FROM prompt_tombstones WHERE sync_id = ?', p.sync_id)?.project ?? '';
    if (goTrim(owner) === '') {
      owner = db.get(
        `SELECT coalesce((SELECT nullif(project, '') FROM sessions WHERE id = ?), (SELECT project FROM sync_delete_tombstones WHERE entity = 'session' AND entity_key = ? AND active = 1), '') AS owner`,
        sessionId, sessionId,
      ).owner;
    }
    project = nullableString(owner);
  }
  db.run('DELETE FROM user_prompts WHERE sync_id = ?', p.sync_id);
  const deletedAt = typeof p.deleted_at === 'string' && goTrim(p.deleted_at) !== '' ? p.deleted_at : now();
  recordPromptTombstone(db, p.sync_id, sessionId, project, inboxId, deletedAt);
}

// ─── Relaciones ──────────────────────────────────────────────────────────────

/** Consulta que cuenta los extremos presentes (con el proyecto efectivo si lo hay). */
function relationEndpointQuery(sourceId, targetId, payloadProject, outerProject) {
  const effective = outerProject !== '' ? outerProject : payloadProject;
  let sql = 'SELECT count(DISTINCT sync_id) AS n FROM observations WHERE sync_id IN (?, ?)';
  const args = [sourceId, targetId];
  if (effective !== '') {
    sql = `SELECT count(DISTINCT o.sync_id) AS n
           FROM observations o
           LEFT JOIN sessions sess ON sess.id = o.session_id
           WHERE o.sync_id IN (?, ?)
             AND coalesce(nullif(o.project, ''), sess.project, '') = ?`;
    args.push(effective);
  }
  return { sql, args, required: sourceId === targetId ? 1 : 2 };
}

const trimmed = (v) => (typeof v === 'string' ? goTrim(v) : '');

function applyRelationUpsert(db, mutation) {
  if (mutation.op !== SYNC_OP_UPSERT) throw applyDead(`unsupported relation operation ${JSON.stringify(mutation.op)}`);
  let p;
  try {
    p = decodeSyncPayload(mutation.payload);
  } catch (err) {
    throw applyDead(`decode relation payload: ${err.message}`);
  }
  if (p === null || typeof p !== 'object' || Array.isArray(p)) throw applyDead('decode relation payload: expected an object');
  const syncId = trimmed(p.sync_id);
  const sourceId = trimmed(p.source_id);
  const targetId = trimmed(p.target_id);
  const relation = trimmed(p.relation);
  const status = trimmed(p.judgment_status);
  const payloadProject = normalizeProject(trimmed(p.project)).normalized;
  const outerProject = normalizeProject(trimmed(mutation.project)).normalized;
  const missing = [];
  if (syncId === '') missing.push('sync_id');
  if (sourceId === '') missing.push('source_id');
  if (targetId === '') missing.push('target_id');
  if (relation === '') missing.push('relation');
  if (status === '') missing.push('judgment_status');
  if (missing.length > 0) throw applyDead(`relation payload missing required fields: ${missing.join(', ')}`);
  const entityKey = trimmed(mutation.entity_key);
  if (entityKey === '' || entityKey !== syncId) {
    throw applyDead(`relation entity_key ${JSON.stringify(mutation.entity_key)} does not match payload sync_id ${JSON.stringify(syncId)}`);
  }

  const endpoints = relationEndpointQuery(sourceId, targetId, payloadProject, outerProject);
  if (Number(db.get(endpoints.sql, ...endpoints.args).n) < endpoints.required) {
    const existing = Number(db.get('SELECT count(DISTINCT sync_id) AS n FROM observations WHERE sync_id IN (?, ?)', sourceId, targetId).n);
    throw existing < endpoints.required ? relationFkMissing() : relationProjectMismatch();
  }

  const actor = p.marked_by_actor === undefined || p.marked_by_actor === null ? null : goTrim(p.marked_by_actor);
  const kind = p.marked_by_kind === undefined || p.marked_by_kind === null ? null : goTrim(p.marked_by_kind);
  db.run(
    `INSERT INTO memory_relations
       (sync_id, source_id, target_id, relation, reason, evidence, confidence,
        judgment_status, marked_by_actor, marked_by_kind, marked_by_model,
        session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sync_id) DO UPDATE SET
       source_id       = excluded.source_id,
       target_id       = excluded.target_id,
       relation        = excluded.relation,
       reason          = excluded.reason,
       evidence        = excluded.evidence,
       confidence      = excluded.confidence,
       judgment_status = excluded.judgment_status,
       marked_by_actor = excluded.marked_by_actor,
       marked_by_kind  = excluded.marked_by_kind,
       marked_by_model = excluded.marked_by_model,
       session_id      = excluded.session_id,
       updated_at      = excluded.updated_at`,
    syncId, sourceId, targetId, relation, optional(p.reason), optional(p.evidence), optional(p.confidence), status, actor, kind, optional(p.marked_by_model),
    optional(p.session_id), text(p.created_at), text(p.updated_at),
  );
  db.run(
    `DELETE FROM sync_apply_deferred
     WHERE entity = ? AND (sync_id = ? OR payload_sync_id = ?) AND payload_sync_id IN ('', ?)`,
    SYNC_ENTITY.relation, syncId, syncId, syncId,
  );
}

// ─── Lápidas del dominio de la nube ──────────────────────────────────────────

/**
 * Lápida de un borrado que llega de la nube, con el piso de secuencia remota: del destino global en la propia
 * lápida y de cualquier otro destino en `sync_delete_tombstone_remote_floors`.
 */
function recordCloudDeleteTombstone(db, targetKey, entity, entityKey, sessionId, project, deletedAt, hardDelete, seq) {
  const owner = normalizeProject(goTrim(project ?? '')).normalized;
  const deleted = deletedAt != null && goTrim(deletedAt) !== '' ? deletedAt : now();
  db.run(
    `INSERT INTO sync_delete_tombstones (entity, entity_key, session_id, project, deleted_at, hard_delete, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(entity, entity_key) DO UPDATE SET
       session_id = excluded.session_id, project = excluded.project, deleted_at = excluded.deleted_at,
       hard_delete = excluded.hard_delete, active = 1`,
    entity, entityKey, nullableString(sessionId), owner, deleted, hardDelete ? 1 : 0,
  );
  if (targetKey === 'cloud') {
    db.run(
      'UPDATE sync_delete_tombstones SET last_remote_mutation_seq = CASE WHEN last_remote_mutation_seq IS NULL OR ? > last_remote_mutation_seq THEN ? ELSE last_remote_mutation_seq END WHERE entity = ? AND entity_key = ?',
      seq, seq, entity, entityKey,
    );
    return;
  }
  db.run(
    `INSERT INTO sync_delete_tombstone_remote_floors (target_key, entity, entity_key, last_mutation_seq) VALUES (?, ?, ?, ?)
     ON CONFLICT(target_key, entity, entity_key) DO UPDATE SET last_mutation_seq = MAX(sync_delete_tombstone_remote_floors.last_mutation_seq, excluded.last_mutation_seq)`,
    targetKey, entity, entityKey, seq,
  );
}

/** ¿Una lápida de la nube impide aplicar esta alta, según su secuencia remota? */
function cloudUpsertBlockedByTombstone(db, targetKey, entity, entityKey, seq) {
  const row = db.get('SELECT active, last_remote_mutation_seq AS floor FROM sync_delete_tombstones WHERE entity = ? AND entity_key = ?', entity, entityKey);
  if (!row) return false;
  if (targetKey === 'cloud') return row.floor != null ? seq <= Number(row.floor) : Number(row.active) === 1;
  const own = db.get('SELECT last_mutation_seq AS floor FROM sync_delete_tombstone_remote_floors WHERE target_key = ? AND entity = ? AND entity_key = ?', targetKey, entity, entityKey);
  if (own) return seq <= Number(own.floor);
  const any = db.get('SELECT EXISTS(SELECT 1 FROM sync_delete_tombstone_remote_floors WHERE entity = ? AND entity_key = ?) AS found', entity, entityKey).found;
  if (Number(any) === 1) return false;
  return Number(row.active) === 1;
}

// ─── Despacho ────────────────────────────────────────────────────────────────

/** Si una mutación posterior vuelve a dar de alta la misma sesión, el borrado no la elimina. */
function supersededSessionDelete(db, mutation, later, cloud = false) {
  for (const candidate of later) {
    if (candidate.entity !== SYNC_ENTITY.session || candidate.op !== SYNC_OP_UPSERT || candidate.entity_key !== mutation.entity_key) continue;
    let next;
    try {
      next = decodeSyncPayload(candidate.payload);
    } catch {
      continue;
    }
    if (goTrim(text(next.id)) === '') next.id = candidate.entity_key;
    try {
      validateSessionMutationIdentity(next.id, candidate.entity_key);
    } catch {
      continue;
    }
    if (isSessionDeletePayload(next)) continue;
    if (!directoryIsString(candidate.payload)) continue;
    if (!cloud && localUpsertBlockedByTombstone(db, SYNC_ENTITY.session, next.id, text(next.started_at))) continue;
    return true;
  }
  return false;
}

/** La carga de una sesión, si trae `directory`, debe llevar una cadena. */
function directoryIsString(payload) {
  let fields;
  try {
    fields = decodeSyncPayload(payload);
  } catch {
    return false;
  }
  return !Object.hasOwn(fields, 'directory') || typeof fields.directory === 'string';
}

/**
 * Aplica una mutación remota al almacén local dentro de la transacción en curso.
 * @param {import('./db.js').Database} db
 * @param {object} mutation `{ entity, entity_key, op, payload, project?, target_key? }`
 * @param {{ later?: object[], targetKey?: string, cloud?: boolean }} [context] mutaciones posteriores del mismo lote y,
 * con `cloud`, aplicación de una mutación de la nube (lápidas por secuencia remota en vez de por fecha)
 */
export function applyPulledMutation(db, mutation, { later = [], targetKey = '', cloud = false } = {}) {
  switch (mutation.entity) {
    case SYNC_ENTITY.relation:
      return applyRelationUpsert(db, mutation);
    case SYNC_ENTITY.session: {
      const payload = decodeSyncPayload(mutation.payload);
      const entityKey = mutation.entity_key;
      if (goTrim(text(payload.id)) === '' && goTrim(entityKey ?? '') !== '') payload.id = entityKey;
      try {
        validateSessionMutationIdentity(text(payload.id), entityKey ?? '');
      } catch (err) {
        throw identityInvalid('pulled_session_identity_invalid', `pulled session identity is invalid: ${err.message}`);
      }
      if (mutation.op === SYNC_OP_DELETE || isSessionDeletePayload(payload)) {
        if (cloud) {
          if (!supersededSessionDelete(db, mutation, later, true)) applySessionDelete(db, payload);
          recordCloudDeleteTombstone(db, targetKey, SYNC_ENTITY.session, payload.id, '', text(payload.project), payload.deleted_at ?? null, payload.hard_delete === true, mutation.seq ?? 0);
          return undefined;
        }
        const recorded = later.length > 0;
        const deletedAt = goTrim(text(payload.deleted_at)) || now();
        if (recorded) recordDeleteTombstone(db, SYNC_ENTITY.session, payload.id, '', text(payload.project), deletedAt);
        if (!supersededSessionDelete(db, mutation, later)) applySessionDelete(db, payload);
        if (!recorded) recordDeleteTombstone(db, SYNC_ENTITY.session, payload.id, '', text(payload.project), deletedAt);
        return undefined;
      }
      if (cloud ? cloudUpsertBlockedByTombstone(db, targetKey, SYNC_ENTITY.session, payload.id, mutation.seq ?? 0) : localUpsertBlockedByTombstone(db, SYNC_ENTITY.session, payload.id, text(payload.started_at))) return undefined;
      if (!directoryIsString(mutation.payload)) throw new StoreError('pulled_session_directory_invalid', 'pulled session directory is invalid: directory must be a string');
      return applySessionPayload(db, payload);
    }
    case SYNC_ENTITY.observation: {
      const payload = decodeSyncPayload(mutation.payload);
      const entityKey = goTrim(mutation.entity_key ?? '');
      payload.sync_id = goTrim(text(payload.sync_id));
      if (payload.sync_id === '') payload.sync_id = entityKey;
      if (payload.sync_id !== entityKey) {
        throw identityInvalid(
          'pulled_observation_identity_invalid',
          `pulled observation identity is invalid: mutation entity_key ${JSON.stringify(entityKey)} does not match payload sync_id ${JSON.stringify(payload.sync_id)}`,
        );
      }
      if (mutation.op === SYNC_OP_DELETE) {
        payload.superseded_by_sync_id = observationProvenance(db, payload.sync_id, payload.superseded_by_sync_id);
        let deletedAt = goTrim(text(payload.deleted_at));
        applyObservationDelete(db, payload);
        db.run(
          "DELETE FROM sync_apply_deferred WHERE entity = ? AND entity_key = ? AND target_key = ? AND op = ? AND apply_status = 'deferred'",
          SYNC_ENTITY.observation, payload.sync_id, targetKey, SYNC_OP_UPSERT,
        );
        if (cloud) {
          recordCloudDeleteTombstone(db, targetKey, SYNC_ENTITY.observation, payload.sync_id, text(payload.session_id), text(payload.project), payload.deleted_at ?? null, payload.hard_delete === true, mutation.seq ?? 0);
          return preserveObservationDeleteProvenance(db, payload, true);
        }
        if (!payload.hard_delete) return preserveObservationDeleteProvenance(db, payload, false);
        if (deletedAt === '') deletedAt = now();
        recordDeleteTombstone(db, SYNC_ENTITY.observation, payload.sync_id, text(payload.session_id), text(payload.project), deletedAt);
        return preserveObservationDeleteProvenance(db, payload, true);
      }
      const generation = goTrim(text(payload.updated_at)) === '' ? text(payload.created_at) : payload.updated_at;
      if (cloud ? cloudUpsertBlockedByTombstone(db, targetKey, SYNC_ENTITY.observation, payload.sync_id, mutation.seq ?? 0) : localUpsertBlockedByTombstone(db, SYNC_ENTITY.observation, payload.sync_id, generation)) return undefined;
      return applyObservationUpsert(db, payload);
    }
    case SYNC_ENTITY.prompt: {
      const payload = decodeSyncPayload(mutation.payload);
      if (mutation.op === SYNC_OP_DELETE || payload.deleted === true || payload.hard_delete === true) return applyPromptDelete(db, payload);
      return applyPromptUpsert(db, payload);
    }
    default:
      throw new Error(`unknown sync entity ${JSON.stringify(mutation.entity)}`);
  }
}

// ─── Fallos de aplicación: diferidos y evidencia ────────────────────────────

function lengthPrefixedDigest(fields) {
  const hash = createHash('sha256');
  for (const field of fields) hash.update(`${Buffer.byteLength(field)}:${field}`);
  return hash.digest('hex');
}

/** Identidad de la fila de una relación que falló: la propia clave si queda diferida, o un resumen si murió. */
function relationApplyFailureSyncId(status, targetKey, mutation) {
  if (status === 'deferred' && goTrim(mutation.entity_key ?? '') !== '') return mutation.entity_key;
  return `relation-dead-${lengthPrefixedDigest([targetKey, mutation.entity, mutation.entity_key ?? '', mutation.op, mutation.payload])}`;
}

const logOf = (store) => store.config.log ?? (() => {});

function writeRelationApplyFailure(db, targetKey, mutation, status, allowDeadRearm) {
  let payload = null;
  try {
    const decoded = decodeSyncPayload(mutation.payload);
    if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) payload = decoded;
  } catch {
    payload = null;
  }
  const outerProject = normalizeProject(trimmed(mutation.project)).normalized;
  let project = outerProject;
  if (project === '' && payload) project = normalizeProject(trimmed(payload.project)).normalized;
  const reasonCode = outerProject !== '' ? RELATION_OUTER_PROJECT_AUTHORITATIVE : '';
  const scopeClass = project !== '' ? 'scoped' : 'target_scoped';
  const payloadSyncId = payload ? trimmed(payload.sync_id) : '';
  const syncId = relationApplyFailureSyncId(status, targetKey, mutation);
  const rearm = allowDeadRearm && syncId !== '' && syncId === trimmed(mutation.entity_key) && payloadSyncId === syncId ? 1 : 0;

  if (syncId !== mutation.entity_key) {
    db.run(
      "DELETE FROM sync_apply_deferred WHERE entity = ? AND sync_id = ? AND entity_key = '' AND payload = ? AND apply_status = 'dead'",
      mutation.entity, mutation.entity_key ?? '', mutation.payload,
    );
  }
  db.run(
    `INSERT INTO sync_apply_deferred
       (sync_id, entity, payload, target_key, entity_key, op, reason_code, payload_sync_id, project, scope_class, apply_status, retry_count, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
     ON CONFLICT(sync_id) DO UPDATE SET
       payload           = excluded.payload,
       target_key        = excluded.target_key,
       entity_key        = excluded.entity_key,
       op                = excluded.op,
       reason_code       = CASE
         WHEN sync_apply_deferred.reason_code = ? THEN sync_apply_deferred.reason_code
         ELSE excluded.reason_code
       END,
       payload_sync_id   = excluded.payload_sync_id,
       project           = CASE
         WHEN sync_apply_deferred.reason_code = ? AND excluded.reason_code <> ? THEN sync_apply_deferred.project
         ELSE excluded.project
       END,
       scope_class       = excluded.scope_class,
       apply_status      = CASE
         WHEN excluded.apply_status = 'dead' THEN 'dead'
         WHEN ? AND sync_apply_deferred.apply_status = 'dead' THEN 'deferred'
         ELSE sync_apply_deferred.apply_status
       END,
       retry_count       = CASE
         WHEN ? AND sync_apply_deferred.apply_status = 'dead' THEN 0
         ELSE sync_apply_deferred.retry_count
       END,
       last_attempted_at = datetime('now')
     WHERE sync_apply_deferred.apply_status <> 'dead'
        OR excluded.apply_status = 'dead'
        OR ?`,
    syncId, mutation.entity, mutation.payload, targetKey, mutation.entity_key ?? '', mutation.op, reasonCode, payloadSyncId, project, scopeClass, status,
    RELATION_OUTER_PROJECT_AUTHORITATIVE, RELATION_OUTER_PROJECT_AUTHORITATIVE, RELATION_OUTER_PROJECT_AUTHORITATIVE, rearm, rearm, rearm,
  );
  return syncId;
}

/** Mutación `deferred` por un padre que aún no existe. */
function deferParentSession(db, targetKey, mutation) {
  const { project, scopeClass } = evidenceScope(mutation);
  const syncId = `pulled-${mutation.entity}-${lengthPrefixedDigest([targetKey, mutation.entity, mutation.entity_key ?? '', mutation.op, mutation.payload])}`;
  db.run(
    `INSERT INTO sync_apply_deferred
       (sync_id, entity, payload, target_key, remote_seq, entity_key, op, reason_code, project, scope_class, apply_status, retry_count, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'deferred', 0, datetime('now'))
     ON CONFLICT(sync_id) DO UPDATE SET
       entity = excluded.entity, payload = excluded.payload, target_key = excluded.target_key,
       remote_seq = excluded.remote_seq, entity_key = excluded.entity_key, op = excluded.op,
       reason_code = excluded.reason_code, project = excluded.project, scope_class = excluded.scope_class,
       last_attempted_at = datetime('now')
     WHERE sync_apply_deferred.apply_status <> 'dead'`,
    syncId, mutation.entity, mutation.payload, targetKey, mutation.seq ?? 0, mutation.entity_key ?? '', mutation.op, SYNC_PARENT_SESSION_MISSING, project, scopeClass,
  );
}

/** Deja constancia de una mutación cuya identidad es inválida: nunca se reintenta. */
function deadLetterIdentity(db, targetKey, mutation, reasonCode) {
  const { project, scopeClass } = evidenceScope(mutation);
  const syncId = `pulled-${mutation.entity}-${lengthPrefixedDigest([targetKey, mutation.entity, mutation.entity_key ?? '', mutation.op, mutation.payload])}`;
  db.run(
    `INSERT INTO sync_apply_deferred
       (sync_id, entity, payload, target_key, remote_seq, entity_key, op, reason_code, project, scope_class, apply_status, retry_count, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dead', 0, datetime('now'))
     ON CONFLICT(sync_id) DO UPDATE SET
       entity = excluded.entity, payload = excluded.payload, target_key = excluded.target_key,
       remote_seq = excluded.remote_seq, entity_key = excluded.entity_key, op = excluded.op,
       reason_code = excluded.reason_code, project = excluded.project, scope_class = excluded.scope_class,
       apply_status = 'dead', last_attempted_at = datetime('now')`,
    syncId, mutation.entity, mutation.payload, targetKey, mutation.seq ?? 0, mutation.entity_key ?? '', mutation.op, reasonCode, project, scopeClass,
  );
}

/** Proyecto de la mutación (el externo o el de su carga) y la clase de ámbito de la evidencia. */
function evidenceScope(mutation) {
  let project = trimmed(mutation.project);
  if (project === '') {
    try {
      const payload = decodeSyncPayload(mutation.payload);
      project = trimmed(payload?.project);
    } catch {
      project = '';
    }
  }
  project = normalizeProject(project).normalized;
  return { project, scopeClass: project !== '' ? 'scoped' : 'target_scoped' };
}

const IDENTITY_REASON = {
  pulled_session_identity_invalid: SYNC_SESSION_IDENTITY_INVALID,
  pulled_observation_identity_invalid: SYNC_OBSERVATION_IDENTITY_INVALID,
  pulled_prompt_identity_invalid: SYNC_PROMPT_IDENTITY_INVALID,
};

// ─── Aplicar un chunk ────────────────────────────────────────────────────────

/** Cola de diferidos: encola una relación antes de aplicarla (la reintentará `replayDeferred`). */
export function enqueueDeferredRelation(store, targetKey, mutation) {
  if (mutation.entity !== SYNC_ENTITY.relation) throw new Error(`EnqueueDeferredRelation: unsupported entity ${JSON.stringify(mutation.entity)}`);
  const key = normalizeSyncTargetKey(targetKey);
  return store.db.writeTransaction((db) => {
    const syncId = writeRelationApplyFailure(db, key, mutation, 'deferred', true);
    logOf(store)(`[store] EnqueueDeferredRelation entity_key=${mutation.entity_key} sync_id=${syncId} - queued before apply (issue #1135)`);
    return syncId;
  });
}

/**
 * Aplica una mutación remota dentro de la transacción en curso. Una relación a la que le falta un extremo o con
 * el proyecto cruzado se encola (`deferred`), una irrecuperable se archiva (`dead`), un padre ausente se difiere
 * y una identidad inválida se guarda como evidencia; cualquier otro error se propaga tras deshacer la mutación.
 * @param {import('./store.js').Store} store
 * @param {import('./db.js').Database} db
 * @param {string} syncTarget
 * @param {object} mutation con `seq`, `target_key` y `source`
 * @param {{ later?: object[], cloud?: boolean }} [options]
 */
export function applyTolerant(store, db, syncTarget, mutation, { later = [], cloud = false } = {}) {
  try {
    db.run('SAVEPOINT apply_mutation');
    applyPulledMutation(db, mutation, { later, targetKey: syncTarget, cloud });
    db.run('RELEASE apply_mutation');
  } catch (err) {
    db.run('ROLLBACK TO apply_mutation');
    db.run('RELEASE apply_mutation');
    if (mutation.entity === SYNC_ENTITY.relation && (err.code === 'relation_fk_missing' || err.code === 'relation_project_mismatch')) {
      const syncId = writeRelationApplyFailure(db, syncTarget, mutation, 'deferred', false);
      logOf(store)(`[store] relation apply seq=${mutation.seq} entity_key=${mutation.entity_key} sync_id=${syncId} err=${err.message} - marking deferred`);
    } else if (mutation.entity === SYNC_ENTITY.relation && err.code === 'apply_dead') {
      const syncId = writeRelationApplyFailure(db, syncTarget, mutation, 'dead', false);
      logOf(store)(`[store] relation apply seq=${mutation.seq} entity_key=${mutation.entity_key} sync_id=${syncId} err=${err.message} - marking dead`);
    } else if (err.code === 'parent_session_missing') {
      deferParentSession(db, syncTarget, mutation);
    } else if (IDENTITY_REASON[err.code]) {
      deadLetterIdentity(db, syncTarget, mutation, IDENTITY_REASON[err.code]);
    } else {
      throw err;
    }
  }
}

/**
 * Aplica las mutaciones de un chunk remoto en una sola transacción y registra el
 * chunk como importado. Un fallo de una relación (extremo ausente o carga inválida)
 * o de un padre ausente se encola; una identidad inválida se archiva como evidencia;
 * cualquier otro error revierte el chunk entero.
 * @param {import('./store.js').Store} store
 * @param {string} targetKey `local` para Git
 * @param {string} chunkId
 * @param {object[]} mutations en el orden de aplicación
 */
export function applyPulledChunk(store, targetKey, chunkId, mutations) {
  const syncTarget = normalizeSyncTargetKey(targetKey);
  const chunkTarget = syncTarget;
  const id = goTrim(chunkId ?? '');
  if (id === '') throw new Error('chunk id is required');
  store.db.writeTransaction((db) => {
    db.run("INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES (?, ?, datetime('now'))", syncTarget, SYNC_LIFECYCLE.idle);
    if (Number(db.get('SELECT COUNT(*) AS n FROM sync_chunks WHERE target_key = ? AND chunk_id = ?', chunkTarget, id).n) > 0) return;
    let seq = Number(db.get('SELECT last_pulled_seq FROM sync_state WHERE target_key = ?', syncTarget).last_pulled_seq);
    for (const [i, original] of mutations.entries()) {
      seq += 1;
      const mutation = { ...original, seq, target_key: syncTarget, source: SYNC_SOURCE_REMOTE };
      try {
        applyTolerant(store, db, syncTarget, mutation, { later: mutations.slice(i + 1) });
      } catch (err) {
        throw new Error(`apply chunk mutation ${i}: ${err.message}`, { cause: err });
      }
    }
    db.run('INSERT OR IGNORE INTO sync_chunks (target_key, chunk_id) VALUES (?, ?)', chunkTarget, id);
    db.run(
      `UPDATE sync_state
       SET last_pulled_seq = ?, lifecycle = ?, consecutive_failures = 0, backoff_until = NULL, reason_code = NULL, reason_message = NULL, last_error = NULL, updated_at = datetime('now')
       WHERE target_key = ?`,
      seq, SYNC_LIFECYCLE.healthy, syncTarget,
    );
  });
}

// ─── Reintento de diferidos ──────────────────────────────────────────────────

/**
 * Reintenta hasta 50 filas diferidas (de un destino y/o proyecto). Cada intento corre
 * en su propia transacción: si triunfa, la fila se borra; si falla por un extremo o
 * un padre ausente se cuenta como intento y, al quinto, muere; cualquier otro fallo
 * la mata.
 * @param {import('./store.js').Store} store
 * @param {string} [targetKey]
 * @param {string} [project]
 * @returns {{ retried: number, succeeded: number, failed: number, dead: number }}
 */
export function replayDeferredForScope(store, targetKey = '', project = '') {
  const target = goTrim(targetKey);
  const name = normalizeProject(goTrim(project)).normalized;
  let sql = "SELECT sync_id, entity, payload, entity_key, op, project, reason_code, retry_count FROM sync_apply_deferred WHERE apply_status = 'deferred'";
  const args = [];
  if (target !== '') {
    sql += " AND target_key = ? AND scope_class != 'legacy_unscoped'";
    args.push(normalizeSyncTargetKey(target));
  }
  if (name !== '') {
    sql += " AND project = ? AND scope_class = 'scoped'";
    args.push(name);
  }
  sql += ' ORDER BY first_seen_at LIMIT ?';
  args.push(REPLAY_BATCH);
  const pending = store.db.all(sql, ...args);
  const log = store.config.log ?? (() => {});
  const result = { retried: 0, succeeded: 0, failed: 0, dead: 0 };
  for (const row of pending) {
    result.retried += 1;
    const mutation = {
      entity: row.entity, entity_key: row.entity_key === '' ? row.sync_id : row.entity_key, op: row.op === '' ? SYNC_OP_UPSERT : row.op, payload: row.payload,
      source: SYNC_SOURCE_REMOTE, target_key: target, project: row.reason_code === RELATION_OUTER_PROJECT_AUTHORITATIVE ? row.project : '',
    };
    try {
      store.db.writeTransaction((db) => applyPulledMutation(db, mutation, { targetKey: target }));
      store.db.run('DELETE FROM sync_apply_deferred WHERE sync_id = ?', row.sync_id);
      result.succeeded += 1;
      log(`[store] replayDeferred: applied sync_id=${row.sync_id}`);
      continue;
    } catch (err) {
      const retry = Number(row.retry_count) + 1;
      const retryable = ['relation_fk_missing', 'relation_project_mismatch', 'parent_session_missing'].includes(err.code);
      const status = retryable && retry < DEAD_THRESHOLD ? 'deferred' : 'dead';
      if (status === 'deferred') result.failed += 1;
      else {
        result.dead += 1;
        log(`[store] replayDeferred: marking dead sync_id=${row.sync_id} retry_count=${retry} err=${err.message}`);
      }
      store.db.run(
        "UPDATE sync_apply_deferred SET retry_count = ?, apply_status = ?, last_error = ?, last_attempted_at = datetime('now') WHERE sync_id = ?",
        retry, status, err.message, row.sync_id,
      );
    }
  }
  return result;
}

/** Reintenta todas las filas diferidas. */
export const replayDeferred = (store) => replayDeferredForScope(store, '', '');

/**
 * Devuelve a «diferida» las relaciones muertas por un extremo ausente (con 5 intentos)
 * cuyos extremos ya existen, para que la siguiente repetición las reintente.
 * @returns {number} filas reactivadas
 */
export function rearmEligibleDeadRelationsForScope(store, targetKey, project) {
  const target = normalizeSyncTargetKey(targetKey);
  const name = normalizeProject(goTrim(project ?? '')).normalized;
  if (name === '') return 0;
  const candidates = store.db.all(
    `SELECT sync_id, payload, entity_key, op, reason_code FROM sync_apply_deferred
     WHERE target_key = ? AND project = ? AND scope_class = 'scoped' AND entity = ? AND apply_status = 'dead' AND retry_count = ?
       AND last_error IN (?, ?) AND sync_id = payload_sync_id AND entity_key = payload_sync_id AND op = ?
     ORDER BY first_seen_at`,
    target, name, SYNC_ENTITY.relation, DEAD_THRESHOLD, RELATION_FK_MISSING, RELATION_PROJECT_MISMATCH, SYNC_OP_UPSERT,
  );
  let rearmed = 0;
  for (const row of candidates) {
    const outer = row.reason_code === RELATION_OUTER_PROJECT_AUTHORITATIVE ? name : '';
    if (!relationSatisfiable(store, { entity: SYNC_ENTITY.relation, entity_key: row.entity_key, op: row.op, payload: row.payload, project: outer })) continue;
    const res = store.db.run(
      `UPDATE sync_apply_deferred SET apply_status = 'deferred', retry_count = 0, last_attempted_at = datetime('now')
       WHERE sync_id = ? AND target_key = ? AND project = ? AND scope_class = 'scoped' AND entity = ? AND apply_status = 'dead' AND retry_count = ?
         AND last_error IN (?, ?) AND sync_id = payload_sync_id AND entity_key = payload_sync_id AND op = ?`,
      row.sync_id, target, name, SYNC_ENTITY.relation, DEAD_THRESHOLD, RELATION_FK_MISSING, RELATION_PROJECT_MISMATCH, SYNC_OP_UPSERT,
    );
    rearmed += Number(res.changes);
  }
  return rearmed;
}

function relationSatisfiable(store, mutation) {
  if (mutation.entity !== SYNC_ENTITY.relation || mutation.op !== SYNC_OP_UPSERT) return false;
  let p;
  try {
    p = decodeSyncPayload(mutation.payload);
  } catch {
    return false;
  }
  const syncId = trimmed(p?.sync_id);
  const sourceId = trimmed(p?.source_id);
  const targetId = trimmed(p?.target_id);
  if (syncId === '' || sourceId === '' || targetId === '' || trimmed(p.relation) === '' || trimmed(p.judgment_status) === '' || trimmed(mutation.entity_key) !== syncId) return false;
  const endpoints = relationEndpointQuery(sourceId, targetId, normalizeProject(trimmed(p.project)).normalized, normalizeProject(trimmed(mutation.project)).normalized);
  return Number(store.db.get(endpoints.sql, ...endpoints.args).n) >= endpoints.required;
}
