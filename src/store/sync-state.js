import { normalizeProject } from '../project/canonical.js';
import { goTrim } from './text.js';

/** Destino de sincronización por defecto (el servidor remoto). */
export const DEFAULT_SYNC_TARGET_KEY = 'cloud';
/** Destino reservado de la bandeja de entrada de prompts. */
export const SYNC_INBOX_TARGET_KEY = 'cloud-inbox';

export const SYNC_LIFECYCLE = Object.freeze({ idle: 'idle', pending: 'pending', running: 'running', healthy: 'healthy', degraded: 'degraded', inbox: 'inbox' });

const UPGRADE_STAGES = new Set([
  'planned', 'doctor_ready', 'doctor_blocked', 'repair_applied', 'bootstrap_enrolled', 'bootstrap_pushed', 'bootstrap_verified', 'rolled_back',
]);

/** Destino de un proyecto: `cloud:<proyecto>`, o el global si no hay proyecto. */
export function cloudTargetKeyForProject(project) {
  const trimmed = goTrim(project ?? '');
  if (trimmed === '') return DEFAULT_SYNC_TARGET_KEY;
  const normalized = normalizeProject(trimmed).normalized;
  return goTrim(normalized) === '' ? DEFAULT_SYNC_TARGET_KEY : `${DEFAULT_SYNC_TARGET_KEY}:${normalized}`;
}

/** Clave de destino normalizada: recortada, en minúsculas; vacía = el destino por defecto. */
export function normalizeSyncTargetKey(targetKey) {
  const trimmed = goTrim(targetKey ?? '');
  return trimmed === '' ? DEFAULT_SYNC_TARGET_KEY : trimmed.toLowerCase();
}

/** Proyecto de un destino `cloud:<proyecto>`; `''` para el resto. */
export function foreignCloudProject(target) {
  if (target === SYNC_INBOX_TARGET_KEY || !target.startsWith(`${DEFAULT_SYNC_TARGET_KEY}:`)) return '';
  return target.slice(DEFAULT_SYNC_TARGET_KEY.length + 1);
}

/**
 * true si el proyecto (canónico) está inscrito para la sincronización.
 * @param {import('./store.js').Store} store
 * @param {string} project
 */
export function isProjectEnrolled(store, project) {
  const name = normalizeProject(project ?? '').normalized;
  if (name === '') return false;
  return store.db.get('SELECT 1 AS found FROM sync_enrolled_projects WHERE project = ? LIMIT 1', name) !== undefined;
}

const STATE_COLUMNS = `target_key, lifecycle, last_enqueued_seq, last_acked_seq, last_pulled_seq, consecutive_failures, backoff_until, lease_owner,
  lease_until, reason_code, reason_message, last_error, last_success_at, updated_at`;

/**
 * Estado de sincronización de un destino. Lo crea (en reposo) si falta, salvo
 * para el destino de un proyecto sin inscribir, que solo se lee.
 * @param {import('./store.js').Store} store
 * @param {string} targetKey
 */
export function getSyncState(store, targetKey) {
  const key = normalizeSyncTargetKey(targetKey);
  const project = foreignCloudProject(key);
  if (project !== '' && !isProjectEnrolled(store, project)) {
    const row = store.db.get(`SELECT ${STATE_COLUMNS} FROM sync_state WHERE target_key = ?`, key);
    return row ?? { target_key: key, lifecycle: SYNC_LIFECYCLE.idle };
  }
  store.db.run("INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES (?, ?, datetime('now'))", key, SYNC_LIFECYCLE.idle);
  return store.db.get(`SELECT ${STATE_COLUMNS} FROM sync_state WHERE target_key = ?`, key);
}

/**
 * Estado de la migración a la nube de un proyecto, o `null` si no hay.
 * @param {import('./store.js').Store} store
 * @param {string} project
 */
export function getCloudUpgradeState(store, project) {
  const name = goTrim(normalizeProject(project ?? '').normalized);
  if (name === '') return null;
  const row = store.db.get(
    "SELECT project, stage, repair_class, ifnull(last_error_code, '') AS last_error_code, ifnull(last_error_message, '') AS last_error_message, updated_at FROM cloud_upgrade_state WHERE project = ?",
    name,
  );
  if (!row) return null;
  const stage = goTrim(row.stage).toLowerCase();
  return { ...row, stage: UPGRADE_STAGES.has(stage) ? stage : 'planned' };
}
