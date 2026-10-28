import { normalizeProject } from '../project/canonical.js';
import { now } from '../timeutil/index.js';
import { storeError } from './errors.js';
import { SYNC_ENTITY, SYNC_OP_DELETE, journalMutation } from './journal.js';
import { recordDeleteTombstone } from './observations.js';
import { recordLocalPromptTombstone } from './prompts.js';
import { validateSessionId } from './sessions.js';
import { goTrim, nullableString } from './text.js';

/**
 * Borra una sesión y sus prompts. Falla si la sesión conserva observaciones (incluso
 * borradas suavemente) para no dejar filas huérfanas. Deja lápidas de los prompts y de
 * la sesión.
 * @param {import('./store.js').Store} store
 * @param {string} id
 * @throws {StoreError} `session_not_found`, `session_has_observations`
 */
export function deleteSession(store, id) {
  validateSessionId(id);
  store.db.writeTransaction((db) => {
    const row = db.get("SELECT ifnull(project, '') AS project FROM sessions WHERE id = ?", id);
    if (!row) throw storeError('session_not_found', JSON.stringify(id));
    const project = normalizeProject(goTrim(row.project)).normalized;

    const count = Number(db.get('SELECT COUNT(*) AS n FROM observations WHERE session_id = ?', id).n);
    if (count > 0) throw storeError('session_has_observations', `session ${JSON.stringify(id)} has ${count} observation(s)`);

    const deletedAt = now();
    const prompts = db.all(
      "SELECT id, sync_id, session_id, ifnull(project, '') AS project, ifnull(source_inbox_id, '') AS source_inbox_id FROM user_prompts WHERE session_id = ? ORDER BY id ASC",
      id,
    ).map((p) => ({ ...p, project: goTrim(p.project) === '' ? project : p.project }));
    for (const p of prompts) {
      recordLocalPromptTombstone(db, p.id, p.sync_id, p.session_id, nullableString(p.project), p.source_inbox_id, deletedAt);
    }
    recordDeleteTombstone(db, SYNC_ENTITY.session, id, '', project, deletedAt);
    db.run('DELETE FROM user_prompts WHERE session_id = ?', id);
    const res = db.run('DELETE FROM sessions WHERE id = ?', id);
    if (Number(res.changes) === 0) throw storeError('session_not_found', JSON.stringify(id));

    // Con el proyecto inscrito el diario anota los borrados (aún no disponible: falla);
    // si no, no hay nada que anotar.
    for (const p of prompts) {
      journalMutation(db, {
        entity: SYNC_ENTITY.prompt, entityKey: p.sync_id, op: SYNC_OP_DELETE, project: p.project, sessionId: p.session_id,
        payload: () => ({}),
      });
    }
    journalMutation(db, { entity: SYNC_ENTITY.session, entityKey: id, op: SYNC_OP_DELETE, project, payload: () => ({}) });
  });
}
