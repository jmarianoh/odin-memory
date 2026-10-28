import { normalizeProject } from '../project/canonical.js';
import { storeError } from './errors.js';
import { goTrim } from './text.js';

/** Entidades del diario de sincronización. */
export const SYNC_ENTITY = Object.freeze({
  session: 'session',
  observation: 'observation',
  prompt: 'prompt',
  relation: 'relation',
  project: 'project',
});
export const SYNC_OP_UPSERT = 'upsert';
export const SYNC_OP_DELETE = 'delete';

/**
 * @param {import('./db.js').Database} db
 * @param {string} project nombre ya canónico
 * @returns {boolean} true si el proyecto está inscrito en la sincronización con Cloud.
 */
export function isProjectEnrolled(db, project) {
  return db.get('SELECT EXISTS(SELECT 1 FROM sync_enrolled_projects WHERE project = ?) AS enrolled', project).enrolled === 1;
}

/** Proyecto dueño de una sesión, canónico, o cadena vacía si no existe. */
export function sessionProject(db, sessionId) {
  if (goTrim(sessionId ?? '') === '') return '';
  const row = db.get("SELECT ifnull(project, '') AS project FROM sessions WHERE id = ?", sessionId);
  return row ? normalizeProject(goTrim(row.project)).normalized : '';
}

/**
 * Punto único donde cada escritura local anota su mutación para la sincronización.
 * La entrega a Cloud es opcional por proyecto: mientras el proyecto no esté
 * inscrito no se registra nada y la escritura local sigue siendo duradera.
 * Debe llamarse dentro de la transacción de la escritura.
 *
 * Estado actual: el diario de mutaciones aún no está implementado, de modo que
 * una escritura sobre un proyecto inscrito falla en lugar de perderse en silencio.
 * Hasta que exista el comando de inscripción ningún proyecto puede estarlo.
 *
 * @param {import('./db.js').Database} db
 * @param {object} mutation
 * @param {string} mutation.entity valor de SYNC_ENTITY
 * @param {string} mutation.entityKey sync_id o id de la entidad
 * @param {string} mutation.op SYNC_OP_UPSERT o SYNC_OP_DELETE
 * @param {string} [mutation.project] proyecto de la entidad
 * @param {string} [mutation.sessionId] sesión de la que derivar el proyecto si falta
 * @param {() => object} mutation.payload construye la carga; solo se invoca si hace falta
 */
export function journalMutation(db, { entity, entityKey, op, project = '', sessionId = '' }) {
  if (entity === SYNC_ENTITY.session && goTrim(entityKey ?? '') === '') throw storeError('session_id_required');
  let owner = normalizeProject(goTrim(project)).normalized;
  if (owner === '' && sessionId) owner = sessionProject(db, sessionId);
  if (owner === '' || !isProjectEnrolled(db, owner)) return;
  throw storeError('sync_journal_unavailable', `${entity} ${op} for project ${JSON.stringify(owner)}`);
}
