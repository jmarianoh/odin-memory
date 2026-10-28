import { normalizeProject } from '../project/canonical.js';
import { now } from '../timeutil/index.js';
import { storeError } from './errors.js';
import { SYNC_ENTITY, SYNC_OP_DELETE, SYNC_OP_UPSERT, journalMutation, sessionProject } from './journal.js';
import { prepareStoredContent } from './observations.js';
import { resolveWriteProject } from './sessions.js';
import { escapeLike, goTrim, hasShortFtsTerm, newSyncId, nullableString, sanitizeFts, searchTerms } from './text.js';

const PROMPT_COLUMNS = "id, ifnull(sync_id, '') AS sync_id, session_id, content, ifnull(project, '') AS project, created_at";

/**
 * Guarda un prompt del usuario. Con `source_inbox_id`, la inserción es idempotente
 * por (sesión, bandeja): repetirla devuelve el prompt existente.
 *
 * @param {import('./store.js').Store} store
 * @param {{ session_id: string, content: string, project?: string, source_inbox_id?: string }} p
 * @returns {{ id: number, inserted: boolean }}
 */
export function addPrompt(store, p) {
  const sessionId = p.session_id ?? '';
  const inboxId = p.source_inbox_id ?? '';
  const content = prepareStoredContent(store, p.content).content;
  if (content === '') throw storeError('prompt_content_required');

  return store.db.writeTransaction((db) => {
    const project = resolveWriteProject(db, sessionId, normalizeProject(p.project ?? '').normalized);
    if (inboxId !== '') {
      const deleted = db.get(
        'SELECT EXISTS(SELECT 1 FROM prompt_tombstones WHERE session_id = ? AND source_inbox_id = ?) AS deleted',
        sessionId, inboxId,
      ).deleted;
      if (deleted === 1) throw storeError('prompt_inbox_deleted');
    }
    const syncId = newSyncId('prompt');
    let sql =
      'INSERT INTO user_prompts (sync_id, session_id, content, project, source_inbox_id, local_creation_session_id, local_creation_inbox_id, local_creation_project) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    if (inboxId !== '') sql += ' ON CONFLICT(session_id, source_inbox_id) WHERE source_inbox_id IS NOT NULL DO NOTHING';
    const res = db.run(
      sql,
      syncId, sessionId, content, nullableString(project), nullableString(inboxId),
      inboxId !== '' ? sessionId : null, nullableString(inboxId), inboxId !== '' ? nullableString(project) : null,
    );
    if (inboxId !== '' && Number(res.changes) === 0) {
      const existing = db.get('SELECT id FROM user_prompts WHERE session_id = ? AND source_inbox_id = ?', sessionId, inboxId);
      return { id: Number(existing.id), inserted: false };
    }
    const id = Number(res.lastInsertRowid);
    const createdAt = db.get('SELECT created_at FROM user_prompts WHERE id = ?', id).created_at;
    db.run('DELETE FROM prompt_tombstones WHERE sync_id = ?', syncId);
    journalMutation(db, {
      entity: SYNC_ENTITY.prompt,
      entityKey: syncId,
      op: SYNC_OP_UPSERT,
      project,
      sessionId,
      payload: () => ({ sync_id: syncId, session_id: sessionId, content, project: nullableString(project), created_at: createdAt, source_inbox_id: inboxId }),
    });
    return { id, inserted: true };
  });
}

/**
 * Prompts recientes. El filtro de proyecto es exacto tras normalizarlo.
 * @param {import('./store.js').Store} store
 * @param {string} [project]
 * @param {number} [limit] por defecto 20
 */
export function recentPrompts(store, project = '', limit = 20) {
  project = normalizeProject(project).normalized;
  let sql = `SELECT ${PROMPT_COLUMNS} FROM user_prompts`;
  const args = [];
  if (project !== '') {
    sql += ' WHERE project = ?';
    args.push(project);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(limit > 0 ? limit : 20);
  return store.db.all(sql, ...args);
}

/**
 * Busca prompts. Con algún término corto usa LIKE; si no, FTS5 trigram ordenado
 * por `rank`. El filtro de proyecto es exacto (no se normaliza).
 * @param {import('./store.js').Store} store
 * @param {string} query
 * @param {string} [project]
 * @param {number} [limit] por defecto 10
 */
export function searchPrompts(store, query, project = '', limit = 10) {
  limit = limit > 0 ? limit : 10;
  const args = [];
  let sql;
  if (hasShortFtsTerm(query)) {
    const groups = searchTerms(query).map((term) => {
      const pattern = `%${escapeLike(term)}%`;
      args.push(pattern, pattern);
      return "(p.content LIKE ? ESCAPE '\\' OR p.project LIKE ? ESCAPE '\\')";
    });
    sql = `SELECT p.id, ifnull(p.sync_id, '') AS sync_id, p.session_id, p.content, ifnull(p.project, '') AS project, p.created_at
      FROM user_prompts p WHERE (${groups.join(' AND ')})`;
    if (project !== '') {
      sql += ' AND p.project = ?';
      args.push(project);
    }
    sql += ' ORDER BY p.created_at DESC, p.id DESC LIMIT ?';
  } else {
    args.push(sanitizeFts(query));
    sql = `SELECT p.id, ifnull(p.sync_id, '') AS sync_id, p.session_id, p.content, ifnull(p.project, '') AS project, p.created_at
      FROM prompts_fts fts CROSS JOIN user_prompts p ON p.id = fts.rowid WHERE prompts_fts MATCH ?`;
    if (project !== '') {
      sql += ' AND p.project = ?';
      args.push(project);
    }
    sql += ' ORDER BY fts.rank LIMIT ?';
  }
  args.push(limit);
  try {
    return store.db.all(sql, ...args);
  } catch (err) {
    throw new Error(`search prompts: ${err.message}`, { cause: err });
  }
}

/** Lápida de un prompt borrado; rechaza identidades que contradicen la ya establecida. */
function recordPromptTombstone(db, syncId, sessionId, project, inboxId, deletedAt) {
  if (project != null) project = nullableString(normalizeProject(goTrim(project)).normalized);
  const existing = db.get(
    "SELECT ifnull(session_id, '') AS session_id, ifnull(source_inbox_id, '') AS source_inbox_id, ifnull(project, '') AS project FROM prompt_tombstones WHERE sync_id = ?",
    syncId,
  );
  if (
    existing &&
    ((sessionId !== '' && existing.session_id !== '' && sessionId !== existing.session_id) ||
      (inboxId !== '' && existing.source_inbox_id !== '' && inboxId !== existing.source_inbox_id) ||
      (project != null && existing.project !== '' && project !== existing.project))
  ) {
    throw storeError('pulled_prompt_identity_invalid', `prompt tombstone ${JSON.stringify(syncId)} conflicts with established identity`);
  }
  db.run(
    `INSERT INTO prompt_tombstones (sync_id, session_id, project, source_inbox_id, deleted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sync_id) DO UPDATE SET session_id = COALESCE(NULLIF(excluded.session_id, ''), prompt_tombstones.session_id),
       project = COALESCE(excluded.project, prompt_tombstones.project),
       source_inbox_id = COALESCE(excluded.source_inbox_id, prompt_tombstones.source_inbox_id),
       deleted_at = excluded.deleted_at`,
    syncId, sessionId, project ?? null, nullableString(inboxId), deletedAt,
  );
}

/** Como `recordPromptTombstone`, y conserva la marca de creación local original si se verifica. */
function recordLocalPromptTombstone(db, id, syncId, sessionId, project, inboxId, deletedAt) {
  let existing = 0;
  let count = 0;
  if (syncId !== '') {
    existing = db.get('SELECT EXISTS(SELECT 1 FROM prompt_tombstones WHERE sync_id = ?) AS n', syncId).n;
    count = db.get('SELECT COUNT(*) AS n FROM user_prompts WHERE sync_id = ?', syncId).n;
  }
  const original = db.get('SELECT local_creation_session_id, local_creation_inbox_id, local_creation_project FROM user_prompts WHERE id = ?', id);
  recordPromptTombstone(db, syncId, sessionId, project, inboxId, deletedAt);
  const oSession = original?.local_creation_session_id ?? '';
  const oInbox = original?.local_creation_inbox_id ?? '';
  const oProject = original?.local_creation_project ?? '';
  if (
    existing !== 0 || Number(count) !== 1 || oSession === '' || oInbox === '' || oProject === '' ||
    oSession !== sessionId || oInbox !== inboxId || oProject !== (project ?? '')
  ) {
    return;
  }
  db.run(
    `UPDATE prompt_tombstones SET local_creation_session_id = ?, local_creation_inbox_id = ?, local_creation_project = ?
     WHERE sync_id = ? AND local_creation_session_id IS NULL AND local_creation_inbox_id IS NULL AND local_creation_project IS NULL`,
    oSession, oInbox, oProject, syncId,
  );
}

/**
 * Borra un prompt (siempre duro) dejando una lápida.
 * @param {import('./store.js').Store} store
 * @param {number} id
 */
export function deletePrompt(store, id) {
  store.db.writeTransaction((db) => {
    const row = db.get(
      "SELECT sync_id, session_id, ifnull(project, '') AS project, ifnull(source_inbox_id, '') AS source_inbox_id FROM user_prompts WHERE id = ?",
      id,
    );
    if (!row) throw storeError('prompt_not_found', `prompt #${id}`);
    let project = normalizeProject(row.project).normalized;
    if (project === '') project = sessionProject(db, row.session_id);
    const projectOrNull = nullableString(project);
    const deletedAt = now();
    recordLocalPromptTombstone(db, id, row.sync_id, row.session_id, projectOrNull, row.source_inbox_id, deletedAt);
    const res = db.run('DELETE FROM user_prompts WHERE id = ?', id);
    if (Number(res.changes) === 0) throw storeError('prompt_not_found', `prompt #${id}`);
    journalMutation(db, {
      entity: SYNC_ENTITY.prompt,
      entityKey: row.sync_id,
      op: SYNC_OP_DELETE,
      project,
      sessionId: row.session_id,
      payload: () => ({
        sync_id: row.sync_id, session_id: row.session_id, project: projectOrNull,
        source_inbox_id: row.source_inbox_id, deleted: true, hard_delete: true, deleted_at: deletedAt,
      }),
    });
  });
}
