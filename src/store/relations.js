import { StoreError, storeError } from './errors.js';
import { SYNC_ENTITY, SYNC_OP_UPSERT, journalMutation } from './journal.js';
import { SAVE_CANDIDATE_RELEVANT_FN, TERM_SEPARATOR, saveCandidateTerms } from './relation-udf.js';
import { newSyncId, nullableString, sanitizeFtsCandidates } from './text.js';

export const RELATION = Object.freeze({
  pending: 'pending',
  related: 'related',
  compatible: 'compatible',
  scoped: 'scoped',
  conflicts_with: 'conflicts_with',
  supersedes: 'supersedes',
  not_conflict: 'not_conflict',
});
export const JUDGMENT_STATUS = Object.freeze({ pending: 'pending', judged: 'judged', orphaned: 'orphaned', ignored: 'ignored' });

/** Verbos que un juicio puede asignar. */
export const VALID_RELATION_VERBS = Object.freeze(['related', 'compatible', 'scoped', 'conflicts_with', 'supersedes', 'not_conflict']);

const DEFAULT_CANDIDATE_LIMIT = 3;
/** Actor con el que se marcan los juicios automáticos. */
export const SYSTEM_ACTOR = 'odin';
export const SYSTEM_KIND = 'system';

const q = (s) => JSON.stringify(s);
const isFinite_ = (n) => typeof n === 'number' && Number.isFinite(n);
export const isValidConfidence = (c) => isFinite_(c) && c >= 0 && c <= 1;

const verbError = (fn, verb) =>
  new StoreError('invalid_relation_verb', `${fn}: invalid relation verb ${q(verb)} — must be one of: related, compatible, scoped, conflicts_with, supersedes, not_conflict`);

const RELATION_COLUMNS = `id, sync_id, ifnull(source_id,'') AS source_id, ifnull(target_id,'') AS target_id,
  relation, reason, evidence, confidence, judgment_status, marked_by_actor, marked_by_kind, marked_by_model,
  session_id, created_at, updated_at`;

const FIND_CANDIDATES_SQL = (op) => `
  WITH ranked AS MATERIALIZED (
    SELECT o.id, ifnull(o.sync_id,'') AS sync_id, o.title, o.type, o.topic_key,
           fts.rank AS score
    FROM observations_fts fts
    CROSS JOIN observations o ON o.id = fts.rowid
    WHERE observations_fts MATCH ?
      AND o.id != ?
      AND NOT EXISTS (
        SELECT 1 FROM memory_relations r
        WHERE ((r.source_id = ? AND r.target_id = ifnull(o.sync_id,''))
            OR (r.source_id = ifnull(o.sync_id,'') AND r.target_id = ?))
          AND r.judgment_status = 'judged'
      )
      AND o.deleted_at IS NULL
      AND ifnull(o.project,'') = ifnull(?,'')
      AND o.scope = ?
  )
  SELECT id, sync_id, title, type, topic_key, score FROM ranked
  WHERE score ${op} ?
  ORDER BY score
  LIMIT ?
`;

/**
 * Busca observaciones que podrían relacionarse (o contradecirse) con una recién
 * guardada y, salvo `skip_insert`, registra una relación `pending` por cada una
 * que aún no tenga ninguna relación con la guardada.
 *
 * Los candidatos salen de FTS5 con los términos del título (unidos por OR), del
 * mismo proyecto y ámbito, vivos, sin un juicio previo con la guardada, y con
 * `bm25 <= bm25_max_rank` (por defecto 0, es decir, cualquier coincidencia).
 *
 * @param {import('./store.js').Store} store
 * @param {number} savedId
 * @param {object} [opts]
 * @param {string} [opts.project] sustituye al proyecto de la observación
 * @param {string} [opts.scope] sustituye a su ámbito
 * @param {string} [opts.query] sustituye al título como texto de búsqueda
 * @param {number} [opts.limit] por defecto 3
 * @param {number} [opts.bm25_max_rank] umbral superior de `rank` (por defecto 0)
 * @param {number} [opts.bm25_floor] obsoleto: umbral inferior (`rank >= valor`); incompatible con `bm25_max_rank`
 * @param {boolean} [opts.require_save_relevance] exige relevancia de título/topic_key
 * @param {boolean} [opts.skip_insert] no crea relaciones
 * @returns {{ candidates: object[], errors: Error[] }} `errors` recoge fallos individuales de inserción
 */
export function findCandidates(store, savedId, opts = {}) {
  const limit = opts.limit > 0 ? opts.limit : DEFAULT_CANDIDATE_LIMIT;
  if (opts.bm25_max_rank !== undefined && opts.bm25_floor !== undefined) {
    throw new StoreError('invalid_confidence', 'FindCandidates: BM25MaxRank and deprecated BM25Floor cannot both be set');
  }
  let operator = '<=';
  let threshold = opts.bm25_max_rank ?? 0;
  if (opts.bm25_floor !== undefined) {
    operator = '>=';
    threshold = opts.bm25_floor;
  }
  if (!isFinite_(threshold)) {
    throw new StoreError('invalid_confidence', `FindCandidates: ${opts.bm25_floor !== undefined ? 'BM25Floor' : 'BM25MaxRank'} must be finite`);
  }

  const saved = store.db.get(
    "SELECT title, ifnull(project,'') AS project, scope, ifnull(sync_id,'') AS sync_id, ifnull(topic_key,'') AS topic_key FROM observations WHERE id = ?",
    savedId,
  );
  if (!saved) throw new StoreError('observation_not_found', `FindCandidates: observation ${savedId} not found`);
  const project = opts.project ? opts.project : saved.project;
  const scope = opts.scope ? opts.scope : saved.scope;
  const queryText = (opts.query ?? '').trim() === '' ? saved.title : opts.query;
  const ftsQuery = sanitizeFtsCandidates(queryText);
  if (ftsQuery === '') return { candidates: [], errors: [] };

  let sql = FIND_CANDIDATES_SQL(operator);
  const args = [ftsQuery, savedId, saved.sync_id, saved.sync_id, project, scope];
  if (opts.require_save_relevance) {
    sql = sql.replace('AND o.scope = ?', `AND o.scope = ?\n      AND ${SAVE_CANDIDATE_RELEVANT_FN}(?, ?, o.title, o.topic_key) = 1`);
    args.push(saveCandidateTerms(queryText).join(TERM_SEPARATOR), saved.topic_key);
  }
  args.push(threshold, limit);
  let rows;
  try {
    rows = store.db.all(sql, ...args);
  } catch (err) {
    throw new StoreError('search_failed', `FindCandidates: FTS5 query: ${err.message}`);
  }
  if (rows.length === 0) return { candidates: [], errors: [] };
  const toCandidate = (r, judgmentId) => ({
    id: Number(r.id), sync_id: r.sync_id, title: r.title, type: r.type, topic_key: r.topic_key, score: r.score,
    ...(judgmentId && { judgment_id: judgmentId }),
  });
  if (opts.skip_insert) return { candidates: rows.map((r) => toCandidate(r)), errors: [] };

  const candidates = [];
  const errors = [];
  for (const r of rows) {
    const judgmentId = newSyncId('rel');
    try {
      const res = store.db.run(
        `INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status, created_at, updated_at)
         SELECT ?, ?, ?, 'pending', 'pending', datetime('now'), datetime('now')
         WHERE NOT EXISTS (
           SELECT 1 FROM memory_relations
           WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)
         )`,
        judgmentId, saved.sync_id, r.sync_id, saved.sync_id, r.sync_id, r.sync_id, saved.sync_id,
      );
      if (Number(res.changes) === 1) candidates.push(toCandidate(r, judgmentId));
    } catch (err) {
      errors.push(new Error(`FindCandidates: conditional insert src=${saved.sync_id} cand=${r.sync_id}: ${err.message}`, { cause: err }));
    }
  }
  return { candidates, errors };
}

/**
 * Crea una relación pendiente entre dos observaciones (por sync_id).
 * @param {import('./store.js').Store} store
 * @param {{ sync_id: string, source_id: string, target_id: string }} p
 */
export function saveRelation(store, p) {
  store.db.run(
    "INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status, created_at, updated_at) VALUES (?, ?, ?, 'pending', 'pending', datetime('now'), datetime('now'))",
    p.sync_id, p.source_id, p.target_id,
  );
  return getRelation(store, p.sync_id);
}

/** Relación por sync_id. @throws {StoreError} `relation_not_found` */
export function getRelation(store, syncId) {
  const row = store.db.get(`SELECT ${RELATION_COLUMNS} FROM memory_relations WHERE sync_id = ?`, syncId);
  if (!row) throw new StoreError('relation_not_found', `GetRelation: relation ${q(syncId)} not found`);
  return row;
}

/** Relación por id numérico, con los títulos de sus extremos vivos. */
export function getRelationByIntId(store, id) {
  const row = store.db.get(
    `SELECT r.id, r.sync_id, r.relation, r.judgment_status,
            ifnull(r.source_id,'') AS source_id, ifnull(src.title,'') AS source_title,
            ifnull(r.target_id,'') AS target_id, ifnull(tgt.title,'') AS target_title,
            r.created_at, r.updated_at
     FROM memory_relations r
     LEFT JOIN observations src ON src.sync_id = r.source_id AND src.deleted_at IS NULL
     LEFT JOIN observations tgt ON tgt.sync_id = r.target_id AND tgt.deleted_at IS NULL
     WHERE r.id = ?`,
    id,
  );
  if (!row) throw new StoreError('relation_not_found', `GetRelationByIntID: relation id ${id} not found`);
  return row;
}

/** Proyecto efectivo de una observación por sync_id: el suyo o el de su sesión. */
function observationProject(db, syncId) {
  const row = db.get(
    `SELECT coalesce(nullif(o.project,''), s.project, '') AS project
     FROM observations o LEFT JOIN sessions s ON s.id = o.session_id
     WHERE o.sync_id = ?`,
    syncId,
  );
  return row?.project ?? '';
}

/** Rechaza relaciones entre proyectos distintos (si ambos se conocen). */
function validateCrossProjectGuard(db, sourceId, targetId) {
  const src = observationProject(db, sourceId);
  const tgt = observationProject(db, targetId);
  if (src !== '' && tgt !== '' && src !== tgt) throw storeError('cross_project_relation');
}

function journalRelation(store, db, syncId, project) {
  journalMutation(db, {
    entity: SYNC_ENTITY.relation,
    entityKey: syncId,
    op: SYNC_OP_UPSERT,
    project,
    payload: () => ({ ...db.get(`SELECT ${RELATION_COLUMNS} FROM memory_relations WHERE sync_id = ?`, syncId), project }),
  });
}

/**
 * Registra el veredicto de un juicio pendiente (o rejuzga uno existente).
 * @param {import('./store.js').Store} store
 * @param {object} p
 * @param {string} p.judgment_id sync_id de la relación
 * @param {string} p.relation uno de VALID_RELATION_VERBS
 * @param {string} [p.reason]
 * @param {string} [p.evidence]
 * @param {number} [p.confidence]
 * @param {string} [p.marked_by_actor]
 * @param {string} [p.marked_by_kind]
 * @param {string} [p.marked_by_model]
 * @param {string} [p.session_id]
 */
export function judgeRelation(store, p) {
  if (!VALID_RELATION_VERBS.includes(p.relation)) throw verbError('JudgeRelation', p.relation);
  const existing = store.db.get("SELECT ifnull(source_id,'') AS source_id, ifnull(target_id,'') AS target_id FROM memory_relations WHERE sync_id = ?", p.judgment_id);
  if (!existing) throw new StoreError('relation_not_found', `JudgeRelation: relation ${q(p.judgment_id)} not found`);

  store.db.writeTransaction((db) => {
    const srcProject = observationProject(db, existing.source_id);
    validateCrossProjectGuard(db, existing.source_id, existing.target_id);
    db.run(
      `UPDATE memory_relations
       SET relation = ?, reason = ?, evidence = ?, confidence = ?, judgment_status = 'judged',
           marked_by_actor = ?, marked_by_kind = ?, marked_by_model = ?, session_id = ?, updated_at = datetime('now')
       WHERE sync_id = ?`,
      p.relation, p.reason ?? null, p.evidence ?? null, p.confidence ?? null,
      p.marked_by_actor ?? '', p.marked_by_kind ?? '', nullableString(p.marked_by_model), nullableString(p.session_id),
      p.judgment_id,
    );
    if (srcProject === '') {
      (store.config.log ?? (() => {}))(`[store] WARNING: JudgeRelation kept relation ${p.judgment_id} local-only; source observation project is unavailable, so no cloud mutation was enqueued`);
      return;
    }
    journalRelation(store, db, p.judgment_id, srcProject);
  });
  return getRelation(store, p.judgment_id);
}

/**
 * Registra un veredicto semántico entre dos observaciones (por sync_id): crea la
 * relación como juzgada o actualiza la existente (en cualquier sentido).
 * @param {import('./store.js').Store} store
 * @param {{ source_id: string, target_id: string, relation: string, confidence: number, reasoning?: string, model?: string }} p
 * @returns {string} sync_id de la relación
 */
export function judgeBySemantic(store, p) {
  if (!p.source_id) throw new StoreError('relation_endpoint_required', 'JudgeBySemantic: SourceID is required');
  if (!p.target_id) throw new StoreError('relation_endpoint_required', 'JudgeBySemantic: TargetID is required');
  if (!VALID_RELATION_VERBS.includes(p.relation)) throw verbError('JudgeBySemantic', p.relation);
  if (!isValidConfidence(p.confidence)) {
    throw new StoreError('invalid_confidence', `JudgeBySemantic: confidence ${p.confidence} is out of range [0.0, 1.0]`);
  }
  return store.db.writeTransaction((db) => {
    validateCrossProjectGuard(db, p.source_id, p.target_id);
    const found = db.get(
      `SELECT sync_id FROM memory_relations
       WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)
       LIMIT 1`,
      p.source_id, p.target_id, p.target_id, p.source_id,
    );
    const model = nullableString(p.model);
    let syncId;
    if (!found) {
      syncId = newSyncId('rel');
      db.run(
        `INSERT INTO memory_relations
           (sync_id, source_id, target_id, relation, judgment_status, confidence, reason,
            marked_by_actor, marked_by_kind, marked_by_model, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'judged', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        syncId, p.source_id, p.target_id, p.relation, p.confidence, p.reasoning ?? '', SYSTEM_ACTOR, SYSTEM_KIND, model,
      );
    } else {
      syncId = found.sync_id;
      db.run(
        `UPDATE memory_relations
         SET relation = ?, source_id = ?, target_id = ?, judgment_status = 'judged', confidence = ?, reason = ?,
             marked_by_actor = ?, marked_by_kind = ?, marked_by_model = ?, updated_at = datetime('now')
         WHERE sync_id = ?`,
        p.relation, p.source_id, p.target_id, p.confidence, p.reasoning ?? '', SYSTEM_ACTOR, SYSTEM_KIND, model, syncId,
      );
    }
    const srcProject = observationProject(db, p.source_id);
    journalRelation(store, db, syncId, srcProject || observationProject(db, p.target_id));
    return syncId;
  });
}

/**
 * Relaciones de varias observaciones (por sync_id), excluyendo las huérfanas.
 * @param {import('./store.js').Store} store
 * @param {string[]} syncIds
 * @returns {Record<string, { as_source: object[], as_target: object[] }>}
 */
export function getRelationsForObservations(store, syncIds) {
  if (syncIds.length === 0) return {};
  const marks = syncIds.map(() => '?').join(',');
  const rows = store.db.all(
    `SELECT r.id, r.sync_id, ifnull(r.source_id,'') AS source_id, ifnull(r.target_id,'') AS target_id,
            r.relation, r.reason, r.evidence, r.confidence, r.judgment_status,
            r.marked_by_actor, r.marked_by_kind, r.marked_by_model, r.session_id, r.created_at, r.updated_at,
            ifnull(src.id,0) AS source_int_id, ifnull(src.title,'') AS source_title,
            (src.id IS NULL OR src.deleted_at IS NOT NULL) AS source_missing,
            ifnull(tgt.id,0) AS target_int_id, ifnull(tgt.title,'') AS target_title,
            (tgt.id IS NULL OR tgt.deleted_at IS NOT NULL) AS target_missing
     FROM memory_relations r
     LEFT JOIN observations src ON src.sync_id = r.source_id
     LEFT JOIN observations tgt ON tgt.sync_id = r.target_id
     WHERE (r.source_id IN (${marks}) OR r.target_id IN (${marks})) AND r.judgment_status != 'orphaned'`,
    ...syncIds, ...syncIds,
  );
  const result = {};
  for (const row of rows) {
    const rel = { ...row, source_int_id: Number(row.source_int_id), target_int_id: Number(row.target_int_id), source_missing: row.source_missing !== 0, target_missing: row.target_missing !== 0 };
    for (const id of syncIds) {
      if (rel.source_id === id) (result[id] ??= { as_source: [], as_target: [] }).as_source.push(rel);
      if (rel.target_id === id) (result[id] ??= { as_source: [], as_target: [] }).as_target.push(rel);
    }
  }
  return result;
}

const ACTIONABLE_PREDICATE = ` AND NOT coalesce((r.judgment_status = 'pending' AND
 (SELECT coalesce(nullif(o.project,''), s.project, '') FROM observations o
  LEFT JOIN sessions s ON s.id = o.session_id WHERE o.sync_id = r.source_id) != '' AND
 (SELECT coalesce(nullif(o.project,''), s.project, '') FROM observations o
  LEFT JOIN sessions s ON s.id = o.session_id WHERE o.sync_id = r.target_id) != '' AND
 (SELECT coalesce(nullif(o.project,''), s.project, '') FROM observations o
  LEFT JOIN sessions s ON s.id = o.session_id WHERE o.sync_id = r.source_id) !=
 (SELECT coalesce(nullif(o.project,''), s.project, '') FROM observations o
  LEFT JOIN sessions s ON s.id = o.session_id WHERE o.sync_id = r.target_id)), 0)`;

function relationsQuery(opts, countOnly) {
  const args = [];
  let sql = `${countOnly
    ? 'SELECT count(*)'
    : `SELECT r.id, r.sync_id, r.relation, r.judgment_status, ifnull(r.source_id,'') AS source_id, ifnull(src.title,'') AS source_title,
       ifnull(r.target_id,'') AS target_id, ifnull(tgt.title,'') AS target_title, r.created_at, r.updated_at`}
    FROM memory_relations r
    LEFT JOIN observations src ON src.sync_id = r.source_id AND src.deleted_at IS NULL
    LEFT JOIN observations tgt ON tgt.sync_id = r.target_id AND tgt.deleted_at IS NULL
    WHERE 1=1`;
  if (opts.actionable_only) sql += ACTIONABLE_PREDICATE;
  if (opts.project) {
    sql += " AND (ifnull(src.project,'') = ? OR ifnull(tgt.project,'') = ?)";
    args.push(opts.project, opts.project);
  }
  if (opts.status) {
    sql += ' AND r.judgment_status = ?';
    args.push(opts.status);
  }
  if (opts.since_time) {
    sql += ' AND r.created_at >= ?';
    args.push(new Date(opts.since_time).toISOString().slice(0, 19).concat('Z'));
  }
  if (opts.exclude_not_conflict) sql += " AND r.relation != 'not_conflict'";
  if (!countOnly) {
    sql += ' ORDER BY r.created_at DESC, r.id DESC';
    if (opts.limit > 0) {
      sql += ' LIMIT ?';
      args.push(opts.limit);
    }
    if (opts.offset > 0) {
      sql += ' OFFSET ?';
      args.push(opts.offset);
    }
  }
  return { sql, args };
}

/**
 * Lista relaciones, las más recientes primero.
 * @param {import('./store.js').Store} store
 * @param {{ actionable_only?: boolean, project?: string, status?: string, since_time?: Date|string, limit?: number, offset?: number, exclude_not_conflict?: boolean }} [opts]
 */
export function listRelations(store, opts = {}) {
  const { sql, args } = relationsQuery(opts, false);
  return store.db.all(sql, ...args);
}

/** Cuenta las relaciones que listaría `listRelations` (sin límite ni desplazamiento). */
export function countRelations(store, opts = {}) {
  const { sql, args } = relationsQuery(opts, true);
  return Number(Object.values(store.db.get(sql, ...args))[0]);
}

/**
 * Relaciones de los resultados de una búsqueda con vista previa. Un fallo al
 * leerlas se ignora (la búsqueda sigue sin relaciones).
 * @param {import('./store.js').Store} store
 * @param {{ sync_id: string }[]} results
 */
export function searchPreviewRelations(store, results) {
  const ids = results.map((r) => r.sync_id).filter((id) => id !== '');
  if (ids.length === 0) return {};
  try {
    return getRelationsForObservations(store, ids);
  } catch {
    return {};
  }
}
