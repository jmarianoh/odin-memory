import { normalizeProject } from '../project/canonical.js';
import { backfillProjectSyncMutations } from './journal.js';
import { RESERVED_INBOX_PROJECT_NAME } from './project-maintenance.js';
import { goTrim } from './text.js';

/**
 * Inscribe un proyecto para la replicación con la nube. Es idempotente: inscribirlo de nuevo no
 * hace nada. Al inscribirse por primera vez se materializa su estado local en el diario.
 * @param {import('./store.js').Store} store
 * @param {string} project
 */
export function enrollProject(store, project) {
  const name = goTrim(normalizeProject(project ?? '').normalized);
  if (name === '') throw new Error('project name must not be empty');
  if (name === RESERVED_INBOX_PROJECT_NAME) throw new Error(`project name ${JSON.stringify(name)} is reserved for the cloud inbox and cannot be enrolled`);
  store.db.writeTransaction((db) => {
    const res = db.run('INSERT OR IGNORE INTO sync_enrolled_projects (project) VALUES (?)', name);
    if (Number(res.changes) === 0) return;
    backfillProjectSyncMutations(db, name);
  });
}

/**
 * Deja de replicar un proyecto con la nube sin borrar datos locales ni remotos ni lo pendiente
 * del diario. Es idempotente.
 */
export function unenrollProject(store, project) {
  const name = goTrim(normalizeProject(project ?? '').normalized);
  if (name === '') throw new Error('project name must not be empty');
  store.db.run('DELETE FROM sync_enrolled_projects WHERE project = ?', name);
}

/** ¿Hay mutaciones pendientes del proyecto en el diario? */
export function hasPendingSyncMutationsForProject(store, project) {
  const name = goTrim(normalizeProject(project ?? '').normalized);
  if (name === '') return false;
  return Number(store.db.get(
    "SELECT COUNT(*) AS n FROM sync_mutations WHERE target_key = 'cloud' AND project = ? AND acked_at IS NULL AND disposition = 'pending'", name,
  ).n) > 0;
}
