import { normalizeProject } from '../project/canonical.js';
import { SYNC_SOURCE_REMOTE, applyTolerant } from './sync-apply.js';
import { DEFAULT_SYNC_TARGET_KEY } from './schema.js';
import { backfillProjectSyncMutations } from './journal.js';
import {
  SYNC_INBOX_TARGET_KEY, SYNC_LIFECYCLE, cloudTargetKeyForProject, foreignCloudProject, isActivelyDegradedState, normalizeSyncTargetKey,
} from './sync-state.js';
import { goTrim } from './text.js';

/**
 * Cola de salida del diario de sincronización: lo que se empuja a la nube, sus acuses, el arriendo que
 * evita dos trabajadores a la vez y la aplicación de lo que llega.
 */

const isInbox = (targetKey) => normalizeSyncTargetKey(targetKey) === SYNC_INBOX_TARGET_KEY;

const COLUMNS = `sm.seq, sm.target_key, sm.entity, sm.entity_key, sm.op, sm.payload, sm.source, sm.project, sm.occurred_at, sm.acked_at,
  sm.disposition, ifnull(sm.disposition_reason, '') AS disposition_reason, ifnull(sm.disposition_evidence, '') AS disposition_evidence, sm.disposition_at`;

/**
 * Mutaciones pendientes con `seq` mayor que `afterSeq`, de proyectos inscritos o sin proyecto, por orden.
 * @param {import('./store.js').Store} store
 * @returns {object[]}
 */
export function listPendingSyncMutationsAfterSeq(store, targetKey, afterSeq = 0, limit = 100) {
  const key = normalizeSyncTargetKey(targetKey);
  if (isInbox(key)) return [];
  return store.db.all(
    `SELECT ${COLUMNS} FROM sync_mutations sm LEFT JOIN sync_enrolled_projects sep ON sm.project = sep.project
     WHERE sm.target_key = ? AND sm.acked_at IS NULL AND sm.disposition = 'pending' AND sm.seq > ? AND (sm.project = '' OR sep.project IS NOT NULL)
     ORDER BY sm.seq ASC LIMIT ?`,
    key, afterSeq, limit > 0 ? limit : 100,
  );
}

/** Mayor `seq` que puede salir ahora (0 si no hay). */
export function maxPendingSyncMutationSeq(store, targetKey) {
  const key = normalizeSyncTargetKey(targetKey);
  if (isInbox(key)) return 0;
  return Number(store.db.get(
    `SELECT COALESCE(MAX(sm.seq), 0) AS seq FROM sync_mutations sm LEFT JOIN sync_enrolled_projects sep ON sm.project = sep.project
     WHERE sm.target_key = ? AND sm.acked_at IS NULL AND sm.disposition = 'pending' AND (sm.project = '' OR sep.project IS NOT NULL)`,
    key,
  ).seq);
}

/** Pendientes de proyectos sin inscribir, por proyecto: lo que impide salir. */
export function countPendingNonEnrolledSyncMutations(store, targetKey) {
  const key = normalizeSyncTargetKey(targetKey);
  if (isInbox(key)) return [];
  return store.db.all(
    `SELECT sm.project AS project, COUNT(*) AS count FROM sync_mutations sm LEFT JOIN sync_enrolled_projects sep ON sm.project = sep.project
     WHERE sm.target_key = ? AND sm.acked_at IS NULL AND sm.disposition = 'pending' AND sm.project != '' AND sep.project IS NULL
     GROUP BY sm.project ORDER BY sm.project ASC`,
    key,
  ).map((r) => ({ project: r.project, count: Number(r.count) }));
}

/** Estado de un destino para recalcular; `null` si es de un proyecto sin inscribir y no existe. */
function stateForRefresh(db, targetKey) {
  const project = foreignCloudProject(targetKey);
  const enrolled = project === '' || Number(db.get('SELECT EXISTS(SELECT 1 FROM sync_enrolled_projects WHERE project = ?) AS found', project).found) === 1;
  if (enrolled) db.run("INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES (?, ?, datetime('now'))", targetKey, SYNC_LIFECYCLE.idle);
  return db.get('SELECT * FROM sync_state WHERE target_key = ?', targetKey) ?? null;
}

/** Recalcula el estado `cloud:<proyecto>` a partir de las filas del diario global de ese proyecto. */
function refreshProjectSyncState(db, project) {
  const name = goTrim(normalizeProject(project ?? '').normalized);
  if (name === '') return;
  const targetKey = cloudTargetKeyForProject(name);
  if (isInbox(targetKey)) return;
  const state = stateForRefresh(db, targetKey);
  if (!state) return;
  const acked = Number(db.get('SELECT ifnull(MAX(seq), 0) AS n FROM sync_mutations WHERE target_key = ? AND project = ? AND acked_at IS NOT NULL', DEFAULT_SYNC_TARGET_KEY, name).n);
  const enqueued = Number(db.get('SELECT ifnull(MAX(seq), 0) AS n FROM sync_mutations WHERE target_key = ? AND project = ?', DEFAULT_SYNC_TARGET_KEY, name).n);
  const pending = Number(db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE target_key = ? AND project = ? AND acked_at IS NULL AND disposition = 'pending'", DEFAULT_SYNC_TARGET_KEY, name).n);
  let lifecycle = pending > 0 ? SYNC_LIFECYCLE.pending : SYNC_LIFECYCLE.healthy;
  const degraded = isActivelyDegradedState(state);
  if (degraded) lifecycle = SYNC_LIFECYCLE.degraded;
  const lastAcked = Math.max(acked, Number(state.last_acked_seq));
  const lastEnqueued = Math.max(enqueued, Number(state.last_enqueued_seq));
  if (degraded) {
    db.run("UPDATE sync_state SET last_enqueued_seq = ?, last_acked_seq = ?, lifecycle = ?, updated_at = datetime('now') WHERE target_key = ?", lastEnqueued, lastAcked, lifecycle, targetKey);
  } else {
    db.run(
      `UPDATE sync_state SET last_enqueued_seq = ?, last_acked_seq = ?, lifecycle = ?, consecutive_failures = 0, backoff_until = NULL, reason_code = NULL, reason_message = NULL,
         last_error = NULL, updated_at = datetime('now') WHERE target_key = ?`,
      lastEnqueued, lastAcked, lifecycle, targetKey,
    );
  }
}

/** Recalcula el ciclo de vida de un destino a partir de sus filas pendientes (dentro de una transacción). */
export function refreshSyncLifecycle(db, targetKey) {
  const key = normalizeSyncTargetKey(targetKey);
  if (isInbox(key)) return;
  const state = stateForRefresh(db, key);
  if (!state) return;
  const pending = Number(db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE target_key = ? AND acked_at IS NULL AND disposition = 'pending'", key).n);
  let lifecycle = pending === 0 ? SYNC_LIFECYCLE.healthy : SYNC_LIFECYCLE.pending;
  const degraded = isActivelyDegradedState(state);
  if (degraded) lifecycle = SYNC_LIFECYCLE.degraded;
  if (degraded) {
    db.run("UPDATE sync_state SET lifecycle = ?, updated_at = datetime('now') WHERE target_key = ?", lifecycle, key);
  } else {
    db.run(
      `UPDATE sync_state SET lifecycle = ?, consecutive_failures = 0, backoff_until = NULL, reason_code = NULL, reason_message = NULL, last_error = NULL,
         updated_at = datetime('now') WHERE target_key = ?`,
      lifecycle, key,
    );
  }
}

export { refreshProjectSyncState as refreshProjectSyncLifecycle };

/**
 * Acusa recibo de mutaciones concretas (no tienen por qué ser contiguas) y recalcula el estado del destino y,
 * en el global, el de cada proyecto afectado.
 * @param {import('./store.js').Store} store
 * @param {number[]} seqs
 */
export function ackSyncMutationSeqs(store, targetKey, seqs) {
  const key = normalizeSyncTargetKey(targetKey);
  if (isInbox(key) || seqs.length === 0) return;
  store.db.writeTransaction((db) => {
    const affected = new Set();
    if (key === DEFAULT_SYNC_TARGET_KEY) {
      for (const seq of seqs) {
        if (seq <= 0) continue;
        const row = db.get("SELECT ifnull(project, '') AS project FROM sync_mutations WHERE target_key = ? AND seq = ?", key, seq);
        const project = row ? goTrim(normalizeProject(row.project).normalized) : '';
        if (project !== '') affected.add(project);
      }
    }
    const state = stateForRefresh(db, key);
    let maxSeq = Number(state.last_acked_seq);
    for (const seq of seqs) {
      if (seq <= 0) continue;
      db.run("UPDATE sync_mutations SET acked_at = datetime('now') WHERE target_key = ? AND seq = ? AND acked_at IS NULL AND disposition = 'pending'", key, seq);
      if (seq > maxSeq) maxSeq = seq;
    }
    const remaining = Number(db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE target_key = ? AND acked_at IS NULL AND disposition = 'pending'", key).n);
    let lifecycle = remaining === 0 ? SYNC_LIFECYCLE.healthy : SYNC_LIFECYCLE.pending;
    const degraded = isActivelyDegradedState(state);
    if (degraded) lifecycle = SYNC_LIFECYCLE.degraded;
    if (degraded) {
      db.run("UPDATE sync_state SET last_acked_seq = ?, lifecycle = ?, updated_at = datetime('now') WHERE target_key = ?", maxSeq, lifecycle, key);
    } else {
      db.run(
        `UPDATE sync_state SET last_acked_seq = ?, lifecycle = ?, consecutive_failures = 0, backoff_until = NULL, reason_code = NULL, reason_message = NULL, last_error = NULL,
           updated_at = datetime('now') WHERE target_key = ?`,
        maxSeq, lifecycle, key,
      );
    }
    for (const project of affected) refreshProjectSyncState(db, project);
  });
}

/**
 * Toma el arriendo del destino si nadie más lo tiene vigente.
 * @param {number} ttlMs
 * @param {Date} [now]
 * @returns {boolean}
 */
export function acquireSyncLease(store, targetKey, owner, ttlMs, now = new Date()) {
  const key = normalizeSyncTargetKey(targetKey);
  const ttl = ttlMs > 0 ? ttlMs : 60_000;
  return store.db.writeTransaction((db) => {
    db.run("INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES (?, ?, datetime('now'))", key, SYNC_LIFECYCLE.idle);
    const state = db.get('SELECT lease_owner, lease_until FROM sync_state WHERE target_key = ?', key);
    if (state.lease_until) {
      const until = Date.parse(state.lease_until);
      const holder = state.lease_owner ?? '';
      if (!Number.isNaN(until) && until > now.getTime() && holder !== '' && holder !== owner) return false;
    }
    const leaseUntil = new Date(now.getTime() + ttl).toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.run("UPDATE sync_state SET lease_owner = ?, lease_until = ?, updated_at = datetime('now') WHERE target_key = ?", owner, leaseUntil, key);
    return true;
  });
}

/** Suelta el arriendo si es de `owner` (o está libre). */
export function releaseSyncLease(store, targetKey, owner) {
  store.db.run(
    "UPDATE sync_state SET lease_owner = NULL, lease_until = NULL, updated_at = datetime('now') WHERE target_key = ? AND (lease_owner = ? OR lease_owner IS NULL OR lease_owner = '')",
    normalizeSyncTargetKey(targetKey), owner,
  );
}

/** Proyectos con relaciones diferidas pendientes de reintento en el destino. */
export function listDeferredProjectsForTarget(store, targetKey) {
  return store.db.all(
    "SELECT DISTINCT project FROM sync_apply_deferred WHERE target_key = ? AND scope_class = 'scoped' AND apply_status = 'deferred' AND project != '' ORDER BY project",
    normalizeSyncTargetKey(targetKey),
  ).map((r) => r.project);
}

/**
 * Aplica una mutación que llega de la nube y avanza el cursor de lectura. Una relación a la que le falta un
 * extremo, un padre ausente o una identidad inválida no detienen la lectura (se encolan o archivan); cualquier
 * otro error se propaga y el cursor no avanza.
 * @param {{ seq: number, project: string, entity: string, entity_key: string, op: string, payload: string, occurred_at?: string }} mutation
 * @param {{ preserveSyncState?: boolean }} [options] con `preserveSyncState` solo avanza el cursor
 */
export function applyCloudMutation(store, targetKey, mutation, { preserveSyncState = false } = {}) {
  const key = normalizeSyncTargetKey(targetKey);
  store.db.writeTransaction((db) => {
    db.run("INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES (?, ?, datetime('now'))", key, SYNC_LIFECYCLE.idle);
    const state = db.get('SELECT last_pulled_seq FROM sync_state WHERE target_key = ?', key);
    if (mutation.seq <= Number(state.last_pulled_seq)) return;
    applyTolerant(store, db, key, { ...mutation, target_key: key, source: SYNC_SOURCE_REMOTE }, { cloud: true });
    if (preserveSyncState) {
      db.run("UPDATE sync_state SET last_pulled_seq = ?, updated_at = datetime('now') WHERE target_key = ?", mutation.seq, key);
      return;
    }
    db.run(
      `UPDATE sync_state SET last_pulled_seq = ?, lifecycle = ?, consecutive_failures = 0, backoff_until = NULL, reason_code = NULL, reason_message = NULL, last_error = NULL,
         updated_at = datetime('now') WHERE target_key = ?`,
      mutation.seq, SYNC_LIFECYCLE.healthy, key,
    );
  });
}

/** Rellena el diario de cada proyecto inscrito con lo que aún no tiene mutación. */
export function ensureEnrolledProjectSyncMutations(store) {
  const projects = store.db.all('SELECT project FROM sync_enrolled_projects ORDER BY project').map((r) => r.project);
  for (const project of projects) store.db.writeTransaction((db) => backfillProjectSyncMutations(db, project));
}


/**
 * Dueño de una sesión y si se creó localmente bajo ese mismo proyecto (condición para afirmar su origen ante la nube).
 * @returns {{ owner: string, eligible: boolean }}
 */
export function localSessionProvenance(store, id) {
  const row = store.db.get("SELECT ifnull(project, '') AS owner, local_creation_project FROM sessions WHERE id = ?", id);
  if (!row) return { owner: '', eligible: false };
  return { owner: row.owner, eligible: row.local_creation_project != null && row.local_creation_project !== '' && row.owner === row.local_creation_project };
}

/**
 * Identidad con la que se creó un prompt localmente (sesión, buzón y proyecto), si no ha cambiado desde entonces;
 * la lápida de un prompt borrado conserva la misma evidencia.
 * @returns {{ session: string, inbox: string, project: string, eligible: boolean }}
 */
export function localPromptCreationIdentity(store, syncId) {
  const none = { session: '', inbox: '', project: '', eligible: false };
  if (!syncId) return none;
  const columns = "local_creation_session_id AS os, local_creation_inbox_id AS oi, local_creation_project AS op, ifnull(session_id, '') AS session, ifnull(source_inbox_id, '') AS inbox, ifnull(project, '') AS project";
  const live = store.db.all(`SELECT ${columns} FROM user_prompts WHERE sync_id = ? LIMIT 2`, syncId);
  if (live.length > 1) return none;
  const row = live[0] ?? store.db.get(`SELECT ${columns} FROM prompt_tombstones WHERE sync_id = ?`, syncId);
  if (!row) return none;
  const same = (original, current) => original != null && original !== '' && original === current;
  const eligible = same(row.os, row.session) && same(row.oi, row.inbox) && same(row.op, row.project);
  return eligible ? { session: row.session, inbox: row.inbox, project: row.project, eligible } : { session: row.session, inbox: row.inbox, project: row.project, eligible: false };
}
