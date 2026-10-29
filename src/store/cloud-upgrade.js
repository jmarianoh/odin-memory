import { normalizeProject } from '../project/canonical.js';
import { backfillProjectSyncMutations } from './journal.js';
import { enrollProject, unenrollProject } from './enrollment.js';
import { DEFAULT_SYNC_TARGET_KEY, cloudTargetKeyForProject, getSyncState, isProjectEnrolled } from './sync-state.js';
import { goTrim } from './text.js';

/**
 * Migración de un proyecto a la sincronización por mutaciones de la nube: estado por etapas, diagnóstico y reparación
 * de las mutaciones pendientes heredadas, y regreso al estado anterior mientras no se haya verificado.
 */

export const UPGRADE_STAGE = Object.freeze({
  planned: 'planned', doctorReady: 'doctor_ready', doctorBlocked: 'doctor_blocked', repairApplied: 'repair_applied',
  bootstrapEnrolled: 'bootstrap_enrolled', bootstrapPushed: 'bootstrap_pushed', bootstrapVerified: 'bootstrap_verified', rolledBack: 'rolled_back',
});
export const REPAIR_CLASS = Object.freeze({ none: 'none', ready: 'ready', repairable: 'repairable', blocked: 'blocked', policy: 'policy' });
export const UPGRADE_REASON = Object.freeze({
  repairableLegacyPayload: 'upgrade_repairable_legacy_mutation_payload',
  blockedLegacyManual: 'upgrade_blocked_legacy_mutation_manual',
  blockedProjectRequired: 'upgrade_blocked_project_required',
  blockedManual: 'upgrade_blocked_manual',
  repairNoop: 'upgrade_repair_noop',
  repairBackfill: 'upgrade_repair_backfill_sync_journal',
});

const STAGES = new Set(Object.values(UPGRADE_STAGE));
const CLASSES = new Set(Object.values(REPAIR_CLASS));
const SUPPORTED = new Map([['session', ['upsert', 'delete']], ['observation', ['upsert', 'delete']], ['prompt', ['upsert', 'delete']], ['relation', ['upsert']]]);
const canonical = (project) => goTrim(normalizeProject(project ?? '').normalized);
const text = (value) => (typeof value === 'string' ? goTrim(value) : '');
const present = (value) => typeof value === 'string' && goTrim(value) !== '';

// ─── Estado por etapas ──────────────────────────────────────────────────────

/** Estado completo, con la instantánea previa al arranque. @returns {object|null} */
export function readUpgradeState(store, project) {
  const name = canonical(project);
  if (name === '') return null;
  const row = store.db.get(
    `SELECT project, stage, repair_class, snapshot_json, ifnull(last_error_code, '') AS last_error_code, ifnull(last_error_message, '') AS last_error_message,
            ifnull(findings_json, '') AS findings_json, ifnull(applied_actions, '') AS applied_actions, updated_at FROM cloud_upgrade_state WHERE project = ?`,
    name,
  );
  if (!row) return null;
  let snapshot = { captured: false, project_enrolled: false };
  if (goTrim(row.snapshot_json) !== '') snapshot = { ...snapshot, ...JSON.parse(row.snapshot_json) };
  const stage = goTrim(row.stage).toLowerCase();
  const repairClass = goTrim(row.repair_class).toLowerCase();
  return { ...row, snapshot, stage: STAGES.has(stage) ? stage : UPGRADE_STAGE.planned, repair_class: CLASSES.has(repairClass) ? repairClass : REPAIR_CLASS.none };
}

/** Guarda el estado; una instantánea ya capturada no se pierde por una posterior sin capturar. */
export function saveUpgradeState(store, state) {
  const project = canonical(state.project);
  if (project === '') throw new Error('cloud upgrade project must not be empty');
  const stage = STAGES.has(goTrim(state.stage ?? '').toLowerCase()) ? goTrim(state.stage).toLowerCase() : UPGRADE_STAGE.planned;
  const repairClass = CLASSES.has(goTrim(state.repair_class ?? '').toLowerCase()) ? goTrim(state.repair_class).toLowerCase() : REPAIR_CLASS.none;
  const snapshot = JSON.stringify({ captured: Boolean(state.snapshot?.captured), project_enrolled: Boolean(state.snapshot?.project_enrolled) });
  const nullable = (value) => (goTrim(value ?? '') === '' ? null : value);
  store.db.run(
    `INSERT INTO cloud_upgrade_state (project, stage, repair_class, snapshot_json, last_error_code, last_error_message, findings_json, applied_actions, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(project) DO UPDATE SET stage = excluded.stage, repair_class = excluded.repair_class,
       snapshot_json = CASE WHEN json_extract(excluded.snapshot_json, '$.captured') = 0 AND json_extract(cloud_upgrade_state.snapshot_json, '$.captured') = 1 THEN cloud_upgrade_state.snapshot_json ELSE excluded.snapshot_json END,
       last_error_code = excluded.last_error_code, last_error_message = excluded.last_error_message, findings_json = excluded.findings_json, applied_actions = excluded.applied_actions, updated_at = datetime('now')`,
    project, stage, repairClass, snapshot, nullable(state.last_error_code), nullable(state.last_error_message), nullable(state.findings_json), nullable(state.applied_actions),
  );
}

/** ¿Se puede volver atrás? Solo con instantánea capturada y antes de verificar. */
export function canRollbackUpgrade(store, project) {
  const state = readUpgradeState(store, project);
  return state !== null && state.snapshot.captured && state.stage !== UPGRADE_STAGE.bootstrapVerified;
}

/** Restaura la inscripción de la instantánea y marca la etapa `rolled_back`. @throws {Error} */
export function rollbackUpgrade(store, project) {
  const name = canonical(project);
  if (name === '') throw new Error('cloud upgrade rollback requires project');
  const state = readUpgradeState(store, name);
  if (state === null) throw new Error('rollback requires existing upgrade checkpoint state');
  if (!state.snapshot.captured) throw new Error('rollback requires a captured pre-bootstrap snapshot');
  if (state.stage === UPGRADE_STAGE.bootstrapVerified) throw new Error('rollback is unavailable post-bootstrap; use explicit disconnect/unenroll flows');
  if (state.snapshot.project_enrolled) enrollProject(store, name);
  else unenrollProject(store, name);
  saveUpgradeState(store, { ...state, stage: UPGRADE_STAGE.rolledBack, last_error_code: '', last_error_message: '', findings_json: '', applied_actions: '' });
  return readUpgradeState(store, name);
}

/**
 * Guarda la inscripción actual antes de empezar y rechaza puntos de control inseguros.
 * @returns {{ project: string, state: object }}
 */
export function captureUpgradeSnapshot(store, project) {
  const name = canonical(project);
  if (name === '') throw new Error('cloud upgrade bootstrap requires project');
  const state = readUpgradeState(store, name);
  const stage = state?.stage ?? UPGRADE_STAGE.planned;
  if (state && [UPGRADE_STAGE.bootstrapEnrolled, UPGRADE_STAGE.bootstrapPushed, UPGRADE_STAGE.bootstrapVerified].includes(stage) && !state.snapshot.captured) {
    throw new Error('bootstrap checkpoint requires a captured pre-bootstrap snapshot');
  }
  if (state?.snapshot.captured) return { project: name, state };
  const next = { ...(state ?? { project: name, stage: UPGRADE_STAGE.planned, repair_class: REPAIR_CLASS.none }), snapshot: { captured: true, project_enrolled: isProjectEnrolled(store, name) } };
  saveUpgradeState(store, next);
  return { project: name, state: next };
}

// ─── Mutaciones pendientes heredadas ────────────────────────────────────────

/** Mutaciones pendientes de salida de un proyecto, incluidas las sesiones sin dueño que su sesión local o su carga atribuyen a él. */
function listPendingProjectMutations(db, project) {
  const columns = 'seq, target_key, entity, entity_key, op, payload, source, project, occurred_at, acked_at';
  const direct = db.all(`SELECT ${columns} FROM sync_mutations WHERE target_key = ? AND project = ? AND acked_at IS NULL AND disposition = 'pending' ORDER BY seq ASC`, DEFAULT_SYNC_TARGET_KEY, project);
  const blank = db.all(`SELECT ${columns} FROM sync_mutations WHERE target_key = ? AND project = '' AND entity = 'session' AND op = 'upsert' AND acked_at IS NULL AND disposition = 'pending' ORDER BY seq`, DEFAULT_SYNC_TARGET_KEY);
  for (const row of blank) {
    const owner = db.get('SELECT project FROM sessions WHERE id = ?', row.entity_key);
    const normalized = canonical(owner?.project ?? '');
    if (normalized === project) {
      direct.push(row);
      continue;
    }
    if (owner && normalized !== '') continue;
    try {
      if (canonical(JSON.parse(row.payload)?.project ?? '') === project) direct.push(row);
    } catch {
      // Una carga ilegible no se atribuye a ningún proyecto.
    }
  }
  return direct.sort((a, b) => a.seq - b.seq);
}

/** Evalúa una mutación: sin problema, reparable (con la carga corregida) o bloqueada. */
function evaluateMutation(db, mutation) {
  const entity = goTrim(mutation.entity);
  const op = goTrim(mutation.op);
  const base = { seq: mutation.seq, entity, op, entity_key: goTrim(mutation.entity_key), target_key: goTrim(mutation.target_key), project: goTrim(mutation.project) };
  const blocked = (message, reason = UPGRADE_REASON.blockedLegacyManual) => ({ hasIssue: true, canRepair: false, finding: { ...base, repairable: false, reason_code: reason, message } });
  const repairable = (message, hint, body) => ({
    hasIssue: true, canRepair: true, repairedPayload: JSON.stringify(body), finding: { ...base, repairable: true, reason_code: UPGRADE_REASON.repairableLegacyPayload, message, repair_hint: hint },
  });
  const MANUAL_PROJECT = 'mutation project must be non-empty and canonical for cloud transport and cannot be inferred from authoritative local state';

  let ownerProject = base.project;
  if (base.project === '') {
    if (entity !== 'session' || op !== 'upsert' || base.entity_key === '') return blocked(MANUAL_PROJECT);
    const owner = db.get('SELECT project FROM sessions WHERE id = ?', base.entity_key);
    if (!owner || goTrim(owner.project ?? '') === '') return blocked(MANUAL_PROJECT);
    ownerProject = canonical(owner.project);
    if (ownerProject === '') return blocked(MANUAL_PROJECT);
  } else if (base.project !== mutation.project) {
    return blocked('mutation project must be canonical');
  }
  const payload = goTrim(mutation.payload ?? '');
  if (payload === '') return blocked('legacy mutation payload is empty');
  if (!SUPPORTED.get(entity)?.includes(op)) return blocked(`unsupported legacy mutation "${entity}"/"${op}"`);

  let body;
  try {
    body = JSON.parse(payload);
  } catch (err) {
    return blocked(`decode ${entity} payload: ${err.message}`);
  }
  if (body === null) body = {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    const kind = Array.isArray(body) ? 'array' : typeof body === 'boolean' ? 'bool' : typeof body;
    return blocked(`decode ${entity} payload: json: cannot unmarshal ${kind} into Go value of type store.sync${entity[0].toUpperCase()}${entity.slice(1)}Payload`);
  }
  const key = base.entity_key;
  const mismatch = (label, id) => blocked(`${entity} entity_key ${JSON.stringify(key)} does not match payload ${label} ${JSON.stringify(id)}`);
  let changed = false;
  const fill = (field, value) => {
    if (!present(body[field]) && value != null && goTrim(String(value)) !== '') {
      body[field] = goTrim(String(value));
      changed = true;
    }
  };

  if (entity === 'session') {
    body.id = text(body.id);
    if (base.project === '') {
      if (text(body.project) !== '' && text(body.project) !== ownerProject) return blocked('session payload project conflicts with local session project');
      body.project = ownerProject;
      changed = true;
    }
    if (body.id === '' && key !== '') {
      body.id = key;
      changed = true;
    }
    if (body.id === '') return blocked('session payload id is required');
    if (key !== '' && key !== body.id) return blocked(`session entity_key ${JSON.stringify(key)} does not match payload id ${JSON.stringify(body.id)}`);
    const directory = text(body.directory);
    if (base.project === '' && op === 'upsert' && directory !== '') {
      const local = db.get("SELECT ifnull(directory, '') AS directory FROM sessions WHERE id = ?", body.id);
      if (goTrim(local?.directory ?? '') !== directory) return blocked('session payload directory conflicts with local session directory');
    }
    if (op === 'upsert' && body.ownership_mode === 'project_owned' && 'directory' in body && typeof body.directory !== 'string') return blocked('pulled session directory is invalid: directory must be a string');
    if (op === 'upsert' && directory === '' && body.ownership_mode !== 'project_owned') {
      const local = db.get("SELECT ifnull(directory, '') AS directory FROM sessions WHERE id = ?", body.id);
      if (!local || goTrim(local.directory) === '') return blocked('session payload directory is required and cannot be inferred from local state');
      body.directory = goTrim(local.directory);
      changed = true;
    }
    return changed ? repairable('session payload is missing required fields', 'repair fills session id/directory from local sessions table', body) : { hasIssue: false };
  }

  if (entity === 'observation' || entity === 'prompt') {
    body.sync_id = text(body.sync_id);
    if (body.sync_id === '' && key !== '') {
      body.sync_id = key;
      changed = true;
    }
    if (body.sync_id === '') return blocked(`${entity} payload sync_id is required`);
    if (key !== '' && key !== body.sync_id) return mismatch('sync_id', body.sync_id);
    if (op === 'upsert') {
      const missing = [];
      if (entity === 'observation') {
        const local = db.get('SELECT session_id, type, title, content, scope FROM observations WHERE sync_id = ?', body.sync_id);
        for (const field of ['session_id', 'type', 'title', 'content', 'scope']) fill(field, local?.[field]);
        for (const field of ['session_id', 'type', 'title', 'content', 'scope']) if (text(body[field]) === '') missing.push(field);
      } else {
        const local = db.get("SELECT session_id, content, ifnull(source_inbox_id, '') AS source_inbox_id FROM user_prompts WHERE sync_id = ? ORDER BY id DESC LIMIT 1", body.sync_id);
        fill('session_id', local?.session_id);
        fill('content', local?.content);
        if (!present(body.source_inbox_id) && local && local.source_inbox_id !== '') {
          body.source_inbox_id = local.source_inbox_id;
          changed = true;
        }
        for (const field of ['session_id', 'content']) if (text(body[field]) === '') missing.push(field);
      }
      if (missing.length > 0) return blocked(`${entity} payload missing required upsert fields: ${missing.join(', ')}`);
    }
    return changed
      ? repairable(`${entity} payload is missing required fields for canonical bootstrap`, `repair fills missing ${entity} fields from local ${entity === 'observation' ? 'observations' : 'prompts'} table`, body)
      : { hasIssue: false };
  }

  // relation
  body.sync_id = text(body.sync_id);
  if (body.sync_id === '' && key !== '') {
    body.sync_id = key;
    changed = true;
  }
  if (body.sync_id === '') return blocked('relation payload sync_id is required');
  if (key !== '' && key !== body.sync_id) return mismatch('sync_id', body.sync_id);
  const local = db.get(
    `SELECT ifnull(source_id, '') AS source_id, ifnull(target_id, '') AS target_id, ifnull(relation, '') AS relation, reason, evidence, confidence, ifnull(judgment_status, '') AS judgment_status,
            marked_by_actor, marked_by_kind, marked_by_model, session_id, ifnull(created_at, '') AS created_at, ifnull(updated_at, '') AS updated_at
     FROM memory_relations WHERE sync_id = ? ORDER BY id DESC LIMIT 1`,
    body.sync_id,
  );
  for (const field of ['source_id', 'target_id', 'relation', 'judgment_status']) body[field] = text(body[field]);
  body.project = text(body.project);
  if (local) {
    for (const field of ['source_id', 'target_id', 'relation', 'judgment_status', 'created_at', 'updated_at']) {
      if (text(body[field]) === '' && goTrim(local[field]) !== '') {
        body[field] = goTrim(local[field]);
        changed = true;
      }
    }
    for (const field of ['reason', 'evidence', 'confidence', 'marked_by_model', 'session_id']) {
      if ((body[field] === undefined || body[field] === null) && local[field] != null) {
        body[field] = local[field];
        changed = true;
      }
    }
    for (const field of ['marked_by_actor', 'marked_by_kind']) {
      if (!present(body[field]) && present(local[field])) {
        body[field] = goTrim(local[field]);
        changed = true;
      }
    }
  }
  if (body.project === '' && goTrim(mutation.project) !== '') {
    body.project = goTrim(mutation.project);
    changed = true;
  }
  const missing = ['source_id', 'target_id', 'relation', 'judgment_status', 'marked_by_actor', 'marked_by_kind', 'project'].filter((field) => text(body[field]) === '');
  if (missing.length > 0) return blocked(`relation payload missing required upsert fields: ${missing.join(', ')}`);
  return changed ? repairable('relation payload is missing required fields for canonical bootstrap', 'repair fills missing relation fields from local memory_relations table and mutation project', body) : { hasIssue: false };
}

/** @returns {{ project: string, repairable_count: number, blocked_count: number, findings: object[] }} */
export function diagnoseLegacyMutations(store, project) {
  const name = canonical(project);
  const report = { project: name, repairable_count: 0, blocked_count: 0, findings: [] };
  if (name === '') return report;
  return store.db.readTransaction((db) => collect(db));

  function collect(db) {
    for (const mutation of listPendingProjectMutations(db, name)) {
      const evaluation = evaluateMutation(db, mutation);
      if (!evaluation.hasIssue) continue;
      report.findings.push(evaluation.finding);
      if (evaluation.canRepair) report.repairable_count++;
      else report.blocked_count++;
    }
    return report;
  }
}

function applyLegacyRepairs(store, project) {
  store.db.writeTransaction((db) => {
    for (const mutation of listPendingProjectMutations(db, project)) {
      const evaluation = evaluateMutation(db, mutation);
      if (!evaluation.hasIssue || !evaluation.canRepair || goTrim(evaluation.repairedPayload ?? '') === '') continue;
      db.run(
        "UPDATE sync_mutations SET payload = ?, project = ? WHERE target_key = ? AND project = ? AND seq = ? AND acked_at IS NULL AND disposition = 'pending'",
        evaluation.repairedPayload, project, DEFAULT_SYNC_TARGET_KEY, mutation.project, mutation.seq,
      );
    }
  });
}

const MANUAL_REASONS = new Map([['auth_required', 'upgrade_policy_auth_required'], ['policy_forbidden', 'upgrade_policy_forbidden'], ['cloud_config_error', 'upgrade_policy_cloud_config_error']]);

/** ¿Faltan filas del diario para lo que ya hay en el almacén del proyecto? */
function backfillRequired(db, project) {
  const missing = (entity, entityKey) => `NOT EXISTS (SELECT 1 FROM sync_mutations sm WHERE sm.target_key = ? AND sm.entity = '${entity}' AND sm.entity_key = ${entityKey} AND sm.source = 'local' AND sm.disposition IN ('pending', 'quarantined'))`;
  const sessions = db.get(`SELECT EXISTS(SELECT 1 FROM sessions sess WHERE sess.project = ? AND ${missing('session', 'sess.id')}) AS n`, project, DEFAULT_SYNC_TARGET_KEY);
  const observations = db.get(
    `SELECT EXISTS(SELECT 1 FROM observations obs LEFT JOIN sessions sess ON sess.id = obs.session_id
       WHERE (ifnull(obs.project, '') = ? OR (ifnull(obs.project, '') = '' AND ifnull(sess.project, '') = ?)) AND obs.deleted_at IS NULL AND ${missing('observation', 'obs.sync_id')}) AS n`,
    project, project, DEFAULT_SYNC_TARGET_KEY,
  );
  return Number(sessions.n) > 0 || Number(observations.n) > 0;
}

/**
 * Plan o aplicación de la reparación local previa al arranque.
 * @returns {{ class: string, reason_code: string, message: string, planned_action?: string, applied: boolean }}
 */
export function repairUpgrade(store, project, apply) {
  const name = canonical(project);
  if (name === '') return { class: REPAIR_CLASS.blocked, reason_code: UPGRADE_REASON.blockedProjectRequired, message: 'project is required for cloud upgrade repair', applied: false };

  const sync = getSyncState(store, cloudTargetKeyForProject(name));
  const manual = sync ? MANUAL_REASONS.get(goTrim(sync.reason_code ?? '')) : undefined;
  if (manual) {
    return { class: REPAIR_CLASS.policy, reason_code: manual, message: `manual-action-required: ${goTrim(sync.reason_message ?? '') || 'cloud policy/auth precondition must be resolved before repair'}`, applied: false };
  }
  if (!isProjectEnrolled(store, name)) {
    return { class: REPAIR_CLASS.blocked, reason_code: UPGRADE_REASON.blockedManual, message: `project ${JSON.stringify(name)} is not enrolled; run doctor/bootstrap guidance first`, applied: false };
  }

  const legacy = diagnoseLegacyMutations(store, name);
  let appliedRepairs = false;
  if (apply && legacy.repairable_count > 0) {
    applyLegacyRepairs(store, name);
    appliedRepairs = true;
  }
  if (legacy.blocked_count > 0) {
    const first = legacy.findings.find((f) => !f.repairable);
    const detail = `manual-action-required: ${first.message} (seq=${first.seq} entity=${first.entity} entity_key=${JSON.stringify(first.entity_key)} op=${first.op})`;
    let message = detail;
    if (appliedRepairs) message = `applied ${legacy.repairable_count} repairable payload(s); ${legacy.blocked_count} remain blocked: ${detail}`;
    else if (legacy.repairable_count > 0) message = `${legacy.repairable_count} repairable payload(s) would apply; ${legacy.blocked_count} would remain blocked: ${detail}`;
    return { class: REPAIR_CLASS.blocked, reason_code: UPGRADE_REASON.blockedLegacyManual, message, applied: appliedRepairs };
  }
  if (legacy.repairable_count > 0) {
    if (!appliedRepairs) {
      return { class: REPAIR_CLASS.repairable, reason_code: UPGRADE_REASON.repairableLegacyPayload, message: `project ${JSON.stringify(name)} has ${legacy.repairable_count} repairable legacy mutation payload issue(s)`, planned_action: 'repair_legacy_mutation_payloads', applied: false };
    }
    saveUpgradeState(store, { project: name, stage: UPGRADE_STAGE.repairApplied, repair_class: REPAIR_CLASS.repairable });
    return { class: REPAIR_CLASS.repairable, reason_code: UPGRADE_REASON.repairableLegacyPayload, message: `applied deterministic legacy mutation payload repairs for project ${JSON.stringify(name)}`, planned_action: 'repair_legacy_mutation_payloads', applied: true };
  }

  if (!backfillRequired(store.db, name)) {
    return { class: REPAIR_CLASS.ready, reason_code: UPGRADE_REASON.repairNoop, message: `project ${JSON.stringify(name)} has no deterministic local repairs to apply`, applied: false };
  }
  const report = { class: REPAIR_CLASS.repairable, reason_code: UPGRADE_REASON.repairBackfill, message: `project ${JSON.stringify(name)} has deterministic local sync metadata gaps`, planned_action: 'backfill_sync_journal', applied: false };
  if (!apply) return report;
  store.db.writeTransaction((db) => backfillProjectSyncMutations(db, name));
  saveUpgradeState(store, { project: name, stage: UPGRADE_STAGE.repairApplied, repair_class: REPAIR_CLASS.repairable });
  return { ...report, applied: true };
}

/** Vuelve a poner en el diario el estado actual de un proyecto inscrito con una fuente nueva, sin tocar las entregas anteriores. */
export function remirrorProject(store, project) {
  const name = canonical(project);
  if (name === '') throw new Error('cloud remirror requires project');
  if (!isProjectEnrolled(store, name)) throw new Error(`cloud remirror requires enrolled project ${JSON.stringify(name)}`);
  store.db.writeTransaction((db) => {
    const base = `remirror:${process.hrtime.bigint()}`;
    let source = base;
    for (let suffix = 1; db.get('SELECT EXISTS(SELECT 1 FROM sync_mutations WHERE source = ?) AS found', source).found; suffix++) source = `${base}:${suffix}`;
    backfillProjectSyncMutations(db, name, source);
  });
}
