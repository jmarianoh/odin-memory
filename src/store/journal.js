import { normalizeProject } from '../project/canonical.js';
import { storeError } from './errors.js';
import { now } from '../timeutil/index.js';
import { DEFAULT_SYNC_TARGET_KEY } from './schema.js';
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

/** Origen de las mutaciones que genera una escritura local. */
export const SYNC_SOURCE_LOCAL = 'local';

/**
 * Punto único donde cada escritura local anota su mutación para la sincronización.
 * La entrega a Cloud es opcional por proyecto: una mutación con proyecto que no está
 * inscrito no se registra (la escritura local sigue siendo duradera) y el relleno de la
 * inscripción materializa después su estado. Las que no tienen proyecto sí se registran.
 * Debe llamarse dentro de la transacción de la escritura.
 *
 * Cada fila se guarda bajo el destino `cloud`, con el proyecto en su propia columna, y
 * marca como pendientes el destino global y el del proyecto (`cloud:<proyecto>`).
 *
 * @param {import('./db.js').Database} db
 * @param {object} mutation
 * @param {string} mutation.entity valor de SYNC_ENTITY
 * @param {string} mutation.entityKey sync_id o id de la entidad
 * @param {string} mutation.op SYNC_OP_UPSERT o SYNC_OP_DELETE
 * @param {string} [mutation.project] proyecto de la entidad
 * @param {string} [mutation.sessionId] sesión de la que derivar el proyecto si falta
 * @param {object|(() => object)} [mutation.payload] carga (o quien la construye); solo se evalúa si hace falta
 * @param {string} [mutation.source] por defecto `local`
 */
export function journalMutation(db, { entity, entityKey, op, project = '', sessionId = '', payload = {}, source = SYNC_SOURCE_LOCAL }) {
  if (entity === SYNC_ENTITY.session && goTrim(entityKey ?? '') === '') throw storeError('session_id_required');
  const body = typeof payload === 'function' ? payload() : payload;
  source = goTrim(source) === '' ? SYNC_SOURCE_LOCAL : goTrim(source);
  // Una sesión local sin directorio no viaja: la nube la rechazaría.
  if (source === SYNC_SOURCE_LOCAL && entity === SYNC_ENTITY.session && op === SYNC_OP_UPSERT && goTrim(body?.directory ?? '') === '') return;
  if (op === SYNC_OP_UPSERT && (entity === SYNC_ENTITY.session || entity === SYNC_ENTITY.observation)) {
    db.run('UPDATE sync_delete_tombstones SET active = 0 WHERE entity = ? AND entity_key = ?', entity, entityKey);
  }
  let owner = normalizeProject(goTrim(project)).normalized;
  if (owner === '' && sessionId) owner = sessionProject(db, sessionId);
  if (source === SYNC_SOURCE_LOCAL && owner !== '' && !isProjectEnrolled(db, owner)) return;
  if (source === SYNC_SOURCE_LOCAL && entity === SYNC_ENTITY.session && op === SYNC_OP_UPSERT) {
    db.run(
      `DELETE FROM sync_mutations WHERE target_key = ? AND entity = ? AND entity_key = ? AND op = ? AND source = ? AND project = ? AND acked_at IS NULL AND disposition = 'pending'`,
      DEFAULT_SYNC_TARGET_KEY, entity, entityKey, op, source, owner,
    );
  }
  db.run("INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES (?, 'idle', datetime('now'))", DEFAULT_SYNC_TARGET_KEY);
  const seq = Number(db.run(
    'INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    DEFAULT_SYNC_TARGET_KEY, entity, entityKey, op, JSON.stringify(body ?? {}), source, owner, now(),
  ).lastInsertRowid);
  db.run("UPDATE sync_state SET lifecycle = 'pending', last_enqueued_seq = ?, updated_at = datetime('now') WHERE target_key = ?", seq, DEFAULT_SYNC_TARGET_KEY);
  if (owner === '') return;
  const projectTarget = `${DEFAULT_SYNC_TARGET_KEY}:${owner}`;
  db.run("INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES (?, 'idle', datetime('now'))", projectTarget);
  db.run("UPDATE sync_state SET lifecycle = 'pending', last_enqueued_seq = ?, updated_at = datetime('now') WHERE target_key = ?", seq, projectTarget);
}

/**
 * Materializa en el diario el estado local de un proyecto inscrito. El relleno de lo que
 * ya existía (sesiones, observaciones, prompts, relaciones y lápidas) pertenece a la
 * sincronización por mutaciones y llega con ella; hasta entonces no hace nada, y la
 * sincronización por chunks (`odin sync --cloud`) no lo necesita.
 * @param {import('./db.js').Database} db
 * @param {string} project proyecto canónico
 */
export function backfillProjectSyncMutations(db, project) {
  void db;
  void project;
}
