import { normalizeProject } from '../project/canonical.js';
import { goTrim } from './text.js';

/** Destino de sincronización por defecto (el servidor remoto). */
export const DEFAULT_SYNC_TARGET_KEY = 'cloud';
/** Destino reservado de la bandeja de entrada de prompts. */
export const SYNC_INBOX_TARGET_KEY = 'cloud:inbox';

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

// ─── Ciclo de vida del destino ───────────────────────────────────────────────

const isInboxTarget = (targetKey) => normalizeSyncTargetKey(targetKey) === SYNC_INBOX_TARGET_KEY;

/** Aplica `fn(db, targetKey)` con el estado del destino ya creado; el buzón de entrada nunca cambia. */
function updateTargetState(store, targetKey, fn) {
  const key = normalizeSyncTargetKey(targetKey);
  if (isInboxTarget(key)) return;
  store.db.writeTransaction((db) => {
    db.run("INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES (?, ?, datetime('now'))", key, SYNC_LIFECYCLE.idle);
    fn(db, key);
  });
}

/**
 * El destino queda degradado y bloqueado, con su motivo; no reintenta por sí solo. Con `recordSuccess` anota
 * además que la lectura de la nube acabó bien (el bloqueo es solo de salida).
 */
export function markSyncBlocked(store, targetKey, reasonCode, message, { recordSuccess = false } = {}) {
  updateTargetState(store, targetKey, (db, key) => {
    db.run(
      `UPDATE sync_state SET lifecycle = ?, consecutive_failures = 0, backoff_until = NULL, reason_code = ?, reason_message = ?, last_error = ?,
         last_success_at = CASE WHEN ? THEN datetime('now') ELSE last_success_at END, updated_at = datetime('now')
       WHERE target_key = ?`,
      SYNC_LIFECYCLE.degraded, reasonCode, message, message, recordSuccess ? 1 : 0, key,
    );
  });
}

export const markSyncBlockedAfterSuccess = (store, targetKey, reasonCode, message) => markSyncBlocked(store, targetKey, reasonCode, message, { recordSuccess: true });

/** ¿El destino está degradado por un bloqueo o por un reintento que aún no vence? */
export function isActivelyDegradedState(state, nowMs = Date.now()) {
  if (!state || state.lifecycle !== SYNC_LIFECYCLE.degraded) return false;
  if (['blocked_unenrolled', 'paused', 'auth_required', 'policy_forbidden', 'cloud_config_error'].includes(goTrim(state.reason_code ?? ''))) return true;
  if (state.backoff_until) {
    const until = Date.parse(goTrim(state.backoff_until));
    if (!Number.isNaN(until) && until > nowMs) return true;
  }
  return false;
}

export const markSyncPaused = (store, targetKey, message) => markSyncBlocked(store, targetKey, 'paused', message);

export const markSyncAuthRequired = (store, targetKey, message) => markSyncBlocked(store, targetKey, 'auth_required', message);

/**
 * El destino queda degradado con un fallo reintentable hasta `backoffUntil`.
 * @param {Date} backoffUntil
 */
export function markSyncFailure(store, targetKey, message, backoffUntil, reasonCode = 'transport_failed') {
  const reason = goTrim(reasonCode) === '' ? 'transport_failed' : goTrim(reasonCode);
  const backoff = backoffUntil.toISOString().replace(/\.\d{3}Z$/, 'Z');
  updateTargetState(store, targetKey, (db, key) => {
    const { consecutive_failures: failures } = db.get('SELECT consecutive_failures FROM sync_state WHERE target_key = ?', key);
    db.run(
      `UPDATE sync_state SET lifecycle = ?, consecutive_failures = ?, backoff_until = ?, reason_code = ?, reason_message = ?, last_error = ?, updated_at = datetime('now')
       WHERE target_key = ?`,
      SYNC_LIFECYCLE.degraded, Number(failures) + 1, backoff, reason, message, message, key,
    );
  });
}

/** El destino queda sano: sin fallos, sin motivo y con el éxito registrado. */
export function markSyncHealthy(store, targetKey) {
  updateTargetState(store, targetKey, (db, key) => {
    db.run(
      `UPDATE sync_state SET lifecycle = ?, consecutive_failures = 0, backoff_until = NULL, reason_code = NULL, reason_message = NULL, last_error = NULL,
         last_success_at = datetime('now'), updated_at = datetime('now')
       WHERE target_key = ?`,
      SYNC_LIFECYCLE.healthy, key,
    );
  });
}

/** El destino queda pendiente de enviar o de importar, sin errores. */
export function markSyncPending(store, targetKey) {
  updateTargetState(store, targetKey, (db, key) => {
    db.run(
      `UPDATE sync_state SET lifecycle = ?, consecutive_failures = 0, backoff_until = NULL, reason_code = NULL, reason_message = NULL, last_error = NULL, updated_at = datetime('now')
       WHERE target_key = ?`,
      SYNC_LIFECYCLE.pending, key,
    );
  });
}

/**
 * Resumen de los destinos por proyecto (`cloud:<proyecto>`), sin el global ni el buzón de entrada.
 * @returns {{ last_success_at: string, last_error: string, reason_code: string, pending_mutations: number }}
 */
export function cloudSyncSummary(store) {
  const inbox = SYNC_INBOX_TARGET_KEY;
  const pattern = `${DEFAULT_SYNC_TARGET_KEY}:%`;
  const row = store.db.get(
    `WITH latest_error AS (
       SELECT last_error, reason_code FROM sync_state
       WHERE target_key LIKE ? AND target_key <> ? AND last_error IS NOT NULL
       ORDER BY updated_at DESC, target_key ASC LIMIT 1
     )
     SELECT MAX(sync_state.last_success_at) AS last_success_at, latest_error.last_error AS last_error, latest_error.reason_code AS reason_code
     FROM sync_state LEFT JOIN latest_error ON TRUE
     WHERE sync_state.target_key LIKE ? AND sync_state.target_key <> ?`,
    pattern, inbox, pattern, inbox,
  );
  const pending = store.db.get(
    `SELECT COUNT(*) AS n FROM sync_mutations sm JOIN sync_enrolled_projects sep ON sm.project = sep.project
     WHERE sm.target_key LIKE ? AND sm.target_key <> ? AND sm.acked_at IS NULL AND sm.disposition = 'pending'`,
    pattern, inbox,
  );
  return { last_success_at: row?.last_success_at ?? '', last_error: row?.last_error ?? '', reason_code: row?.reason_code ?? '', pending_mutations: Number(pending.n) };
}
