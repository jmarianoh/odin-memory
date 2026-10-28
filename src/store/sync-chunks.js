import { normalizeProject } from '../project/canonical.js';
import { SYNC_ENTITY, SYNC_OP_DELETE, SYNC_OP_UPSERT } from './journal.js';
import { LOCAL_CHUNK_TARGET_KEY } from './sync-apply.js';
import { goTrim } from './text.js';

/** Clave de destino de un chunk: recortada y en minúsculas; vacía = el destino local. */
export function normalizeChunkTargetKey(targetKey) {
  const trimmed = goTrim(targetKey ?? '');
  return trimmed === '' ? LOCAL_CHUNK_TARGET_KEY : trimmed.toLowerCase();
}

/**
 * Identificadores de los chunks ya exportados o importados para un destino.
 * @param {import('./store.js').Store} store
 * @param {string} [targetKey]
 * @returns {Set<string>}
 */
export function getSyncedChunksForTarget(store, targetKey = LOCAL_CHUNK_TARGET_KEY) {
  const rows = store.db.all('SELECT chunk_id FROM sync_chunks WHERE target_key = ?', normalizeChunkTargetKey(targetKey));
  return new Set(rows.map((r) => r.chunk_id));
}

/** Anota un chunk como exportado o importado para un destino. */
export function recordSyncedChunkForTarget(store, targetKey, chunkId) {
  store.db.run('INSERT OR IGNORE INTO sync_chunks (target_key, chunk_id) VALUES (?, ?)', normalizeChunkTargetKey(targetKey), chunkId);
}

/** true si algún proyecto (o el indicado) tiene sesiones con propiedad de proyecto. */
export function hasProjectOwnedSessionsForProject(store, project = '') {
  const name = goTrim(normalizeProject(project ?? '').normalized);
  if (name === '') return store.db.get("SELECT EXISTS(SELECT 1 FROM sessions WHERE ownership_mode = 'project_owned') AS found").found === 1;
  return store.db.get("SELECT EXISTS(SELECT 1 FROM sessions WHERE project = ? AND ownership_mode = 'project_owned') AS found", name).found === 1;
}

/** Observaciones de un proyecto, incluidas las sin proyecto cuya sesión lo tiene. */
const PROJECT_OBSERVATION_SET = `
  SELECT sync_id FROM observations WHERE project = ?
  UNION ALL
  SELECT o.sync_id FROM sessions s
  JOIN observations o ON o.session_id = s.id
  WHERE s.project = ? AND (o.project IS NULL OR o.project = '')`;

/** Mutación con la forma de una fila del diario (los campos de control en su valor neutro). */
export function newMutation({ entity, entity_key, op, payload, project = '', occurred_at = '' }) {
  return {
    seq: 0, target_key: '', entity, entity_key, op, payload, source: '', project, occurred_at, disposition: '',
  };
}

const relationPayload = (r, project) => {
  const out = { sync_id: r.sync_id, source_id: r.source_id, target_id: r.target_id, relation: r.relation };
  for (const key of ['reason', 'evidence', 'confidence']) if (r[key] !== null) out[key] = r[key];
  out.judgment_status = r.judgment_status;
  for (const key of ['marked_by_actor', 'marked_by_kind', 'marked_by_model', 'session_id']) if (r[key] !== null) out[key] = r[key];
  out.project = project;
  out.created_at = r.created_at;
  out.updated_at = r.updated_at;
  return out;
};

/**
 * Mutaciones `upsert` de las relaciones no huérfanas cuyos dos extremos están vivos.
 * @param {import('./store.js').Store} store
 * @param {string} [project] limita a las que unen observaciones de ese proyecto
 */
export function exportRelationMutations(store, project = '') {
  const name = goTrim(normalizeProject(project ?? '').normalized);
  let sql = `
    SELECT r.sync_id, r.source_id, r.target_id, r.relation, r.reason, r.evidence, r.confidence,
           r.judgment_status, r.marked_by_actor, r.marked_by_kind, r.marked_by_model,
           r.session_id, coalesce(nullif(src.project, ''), src_s.project, '') AS project, r.created_at, r.updated_at
    FROM memory_relations r
    JOIN observations src ON src.sync_id = r.source_id AND src.deleted_at IS NULL
    JOIN observations tgt ON tgt.sync_id = r.target_id AND tgt.deleted_at IS NULL
    LEFT JOIN sessions src_s ON src_s.id = src.session_id
    LEFT JOIN sessions tgt_s ON tgt_s.id = tgt.session_id
    WHERE r.judgment_status != 'orphaned'`;
  let args = [];
  if (name !== '') {
    sql = `WITH project_observations AS (${PROJECT_OBSERVATION_SET})
      SELECT r.sync_id, r.source_id, r.target_id, r.relation, r.reason, r.evidence, r.confidence,
             r.judgment_status, r.marked_by_actor, r.marked_by_kind, r.marked_by_model,
             r.session_id, ? AS project, r.created_at, r.updated_at
      FROM memory_relations r
      JOIN observations src ON src.sync_id = r.source_id AND src.deleted_at IS NULL
      JOIN observations tgt ON tgt.sync_id = r.target_id AND tgt.deleted_at IS NULL
      WHERE r.judgment_status != 'orphaned'
        AND r.source_id IN (SELECT sync_id FROM project_observations)
        AND r.target_id IN (SELECT sync_id FROM project_observations)`;
    args = [name, name, name];
  }
  sql += ' ORDER BY r.created_at, r.sync_id';
  return store.db.all(sql, ...args).map((row) => {
    const payload = relationPayload(row, row.project);
    return newMutation({
      entity: SYNC_ENTITY.relation, entity_key: goTrim(row.sync_id), op: SYNC_OP_UPSERT, payload: JSON.stringify(payload), project: goTrim(row.project), occurred_at: row.updated_at,
    });
  });
}

const ENTITY_RANK = { observation: 0, prompt: 1, session: 2 };

/**
 * Mutaciones de borrado de las lápidas locales activas (observaciones y sesiones) y de
 * las lápidas de prompts, ordenadas por entidad, fecha y clave.
 * @param {import('./store.js').Store} store
 * @param {string} [project]
 */
export function exportLocalDeleteTombstones(store, project = '') {
  const name = goTrim(normalizeProject(project ?? '').normalized);
  const mutations = [];
  let where = 'active = 1';
  const args = [];
  if (name !== '') {
    where += ' AND project = ?';
    args.push(name);
  }
  const rows = store.db.all(
    `SELECT entity, entity_key, ifnull(session_id, '') AS session_id, project, deleted_at, hard_delete, superseded_by_sync_id
     FROM sync_delete_tombstones WHERE entity IN ('observation', 'session') AND ${where}`,
    ...args,
  );
  for (const r of rows) {
    let payload;
    if (r.entity === SYNC_ENTITY.observation) {
      payload = { sync_id: r.entity_key, session_id: r.session_id, type: '', title: '', content: '' };
      if (r.project !== '') payload.project = r.project;
      payload.scope = '';
      payload.revision_count = 0;
      payload.duplicate_count = 0;
      if (r.superseded_by_sync_id !== null) payload.superseded_by_sync_id = r.superseded_by_sync_id;
      payload.deleted = true;
      payload.deleted_at = r.deleted_at;
      if (Number(r.hard_delete) === 1) payload.hard_delete = true;
    } else {
      payload = { id: r.entity_key, project: r.project, deleted: true, deleted_at: r.deleted_at };
      if (Number(r.hard_delete) === 1) payload.hard_delete = true;
    }
    mutations.push(newMutation({ entity: r.entity, entity_key: r.entity_key, op: SYNC_OP_DELETE, payload: JSON.stringify(payload), project: r.project, occurred_at: r.deleted_at }));
  }

  let promptWhere = '1 = 1';
  const promptArgs = [];
  if (name !== '') {
    promptWhere += " AND coalesce(nullif(p.project, ''), nullif(s.project, ''), ifnull((SELECT st.project FROM sync_delete_tombstones st WHERE st.entity = 'session' AND st.entity_key = p.session_id AND st.active = 1), '')) = ?";
    promptArgs.push(name);
  }
  const prompts = store.db.all(
    `SELECT p.sync_id, ifnull(p.session_id, '') AS session_id,
       coalesce(nullif(p.project, ''), nullif(s.project, ''), ifnull((SELECT st.project FROM sync_delete_tombstones st WHERE st.entity = 'session' AND st.entity_key = p.session_id AND st.active = 1), '')) AS project,
       p.deleted_at, ifnull(p.source_inbox_id, '') AS source_inbox_id
     FROM prompt_tombstones p LEFT JOIN sessions s ON s.id = p.session_id WHERE ${promptWhere}`,
    ...promptArgs,
  );
  for (const r of prompts) {
    const payload = { source_inbox_id: r.source_inbox_id || undefined, sync_id: r.sync_id, session_id: r.session_id, content: '' };
    if (r.project !== '') payload.project = r.project;
    payload.deleted = true;
    payload.deleted_at = r.deleted_at;
    payload.hard_delete = true;
    mutations.push(newMutation({ entity: SYNC_ENTITY.prompt, entity_key: r.sync_id, op: SYNC_OP_DELETE, payload: JSON.stringify(payload), project: r.project, occurred_at: r.deleted_at }));
  }
  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return mutations.sort((a, b) => ENTITY_RANK[a.entity] - ENTITY_RANK[b.entity] || byText(a.occurred_at, b.occurred_at) || byText(a.entity_key, b.entity_key));
}

/**
 * Eventos locales de «se quitó la fecha de revisión» de observaciones vivas que siguen
 * sin ella: prueban la intención de borrarla aunque no haya sincronización con la nube.
 * @returns {{ id: number, key: string, sync_id: string }[]}
 */
export function exportReviewClearEvents(store) {
  return store.db
    .all(
      `SELECT e.id, e.event_key, e.sync_id FROM review_clear_events e
       JOIN observations o ON o.sync_id = e.sync_id
       WHERE o.review_after IS NULL AND o.deleted_at IS NULL ORDER BY e.id`,
    )
    .map((r) => ({ id: Number(r.id), key: r.event_key, sync_id: r.sync_id }));
}
