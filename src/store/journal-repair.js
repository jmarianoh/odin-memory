import { normalizeProject } from '../project/canonical.js';
import { now } from '../timeutil/index.js';
import { listObservationRequiredFieldRows, listPendingProjectMutations, SYNC_MUTATION_DISPOSITION, validateSyncMutationPayload } from './diagnostic.js';
import { DEFAULT_SYNC_TARGET_KEY, SYNC_INBOX_TARGET_KEY } from './schema.js';
import { SYNC_ENTITY, SYNC_OP_DELETE, SYNC_OP_UPSERT, SYNC_SOURCE_LOCAL, journalMutation } from './journal.js';
import { backupSqlite } from './repair.js';
import { refreshProjectSyncLifecycle, refreshSyncLifecycle } from './sync-queue.js';
import { normalizeSyncTargetKey } from './sync-state.js';
import { validateObservationTitle } from './observations.js';
import { SESSION_OWNERSHIP_PROJECT_OWNED } from './sessions.js';
import { goTrim, stripPrivateTags, truncate } from './text.js';
import { evaluateMutationForRepair } from './cloud-upgrade.js';

/**
 * Reparaciones del diario de mutaciones que ejecuta `odin doctor repair --check sync_mutation_required_fields`:
 * directorios de sesión, títulos de observación, sustitución de altas obsoletas, cuarentena de lo irreparable y títulos de origen.
 */

const canonical = (project) => goTrim(normalizeProject(project ?? '').normalized);
const pendingRows = (db, project, extra = '') => {
  const rows = db.all(
    `SELECT seq, target_key, entity, entity_key, op, payload, source, project, occurred_at, acked_at FROM sync_mutations WHERE target_key = ? AND acked_at IS NULL AND disposition = 'pending'${project !== '' ? ' AND project = ?' : ''}${extra} ORDER BY seq ASC`,
    ...[DEFAULT_SYNC_TARGET_KEY, ...(project !== '' ? [project] : [])],
  );
  return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
};

// ─── Directorios de sesión ──────────────────────────────────────────────────

/** Rellena el directorio de las sesiones pendientes desde la sesión local; no exige inscripción ni toca el resto del diario. */
export function repairPendingSessionDirectories(store, project, apply) {
  const name = canonical(project);
  const actions = [];
  const run = (db) => {
    const projects = new Set();
    for (const r of db.all(
      `SELECT DISTINCT project FROM sync_mutations WHERE target_key = ? AND disposition = 'pending' AND acked_at IS NULL AND project != ''
       UNION SELECT DISTINCT s.project FROM sessions s JOIN sync_mutations m ON m.entity_key = s.id
       WHERE m.target_key = ? AND m.project = '' AND m.entity = 'session' AND m.op = 'upsert' AND m.disposition = 'pending' AND m.acked_at IS NULL AND s.project != ''`,
      DEFAULT_SYNC_TARGET_KEY, DEFAULT_SYNC_TARGET_KEY,
    )) projects.add(r.project);
    for (const raw of [...projects]) {
      const c = canonical(raw);
      if (c !== '') projects.add(c);
    }
    for (const raw of projects) {
      const c = canonical(raw);
      if (c === '' || (name !== '' && c !== name)) continue;
      for (const mutation of listPendingFor(db, raw)) {
        if (mutation.entity !== SYNC_ENTITY.session || mutation.op !== SYNC_OP_UPSERT) continue;
        let body;
        try {
          body = JSON.parse(mutation.payload);
        } catch {
          continue;
        }
        if (body === null || typeof body !== 'object' || goTrim(body.directory ?? '') !== '' || goTrim(body.id ?? '') === '' || body.id !== mutation.entity_key) continue;
        if (goTrim(body.ownership_mode ?? '') === SESSION_OWNERSHIP_PROJECT_OWNED) continue;
        const local = db.get("SELECT project, ifnull(ownership_mode, '') AS ownership_mode FROM sessions WHERE id = ?", body.id);
        if (!local || goTrim(local.ownership_mode) === SESSION_OWNERSHIP_PROJECT_OWNED) continue;
        if (canonical(local.project) !== c || (mutation.project !== '' && canonical(mutation.project) !== c)) continue;
        const evaluation = evaluateMutationForRepair(db, mutation);
        if (!evaluation.canRepair || !evaluation.repairedPayload) continue;
        if (apply) {
          db.run(
            "UPDATE sync_mutations SET payload = ?, project = ? WHERE seq = ? AND target_key = ? AND project = ? AND acked_at IS NULL AND disposition = 'pending'",
            evaluation.repairedPayload, c, mutation.seq, DEFAULT_SYNC_TARGET_KEY, mutation.project,
          );
        }
        actions.push({ seq: mutation.seq, project: c, entity_key: mutation.entity_key });
      }
    }
  };
  if (apply) store.db.writeTransaction(run);
  else store.db.readTransaction(run);
  return actions;
}

/** Pendientes de un proyecto (con la grafía indicada) más las sesiones sin proyecto que su sesión local le atribuye. */
function listPendingFor(db, project) {
  const columns = 'seq, target_key, entity, entity_key, op, payload, source, project, occurred_at, acked_at';
  const rows = db.all(`SELECT ${columns} FROM sync_mutations WHERE target_key = ? AND project = ? AND acked_at IS NULL AND disposition = 'pending' ORDER BY seq`, DEFAULT_SYNC_TARGET_KEY, project);
  const wanted = canonical(project);
  for (const row of db.all(`SELECT ${columns} FROM sync_mutations WHERE target_key = ? AND project = '' AND entity = 'session' AND op = 'upsert' AND acked_at IS NULL AND disposition = 'pending' ORDER BY seq`, DEFAULT_SYNC_TARGET_KEY)) {
    const owner = db.get('SELECT project FROM sessions WHERE id = ?', row.entity_key);
    const normalized = canonical(owner?.project ?? '');
    if (normalized === wanted) {
      rows.push(row);
      continue;
    }
    if (owner && normalized !== '') continue;
    try {
      if (canonical(JSON.parse(row.payload)?.project ?? '') === wanted) rows.push(row);
    } catch {
      // carga ilegible: no se atribuye
    }
  }
  return rows.map((r) => ({ ...r, seq: Number(r.seq) })).sort((a, b) => a.seq - b.seq);
}

// ─── Títulos de observación ─────────────────────────────────────────────────

const deriveTitle = (content) => {
  const text = goTrim(stripPrivateTags(content ?? ''));
  const runes = Array.from(text);
  const end = runes.findIndex((r) => '.!?。！？'.includes(r));
  return truncate((end >= 0 ? runes.slice(0, end + 1) : runes).join(''), 300);
};
const deriveSourceTitle = (content) => {
  let text = goTrim(stripPrivateTags(content ?? ''));
  const eol = text.indexOf('\n');
  if (eol >= 0) text = text.slice(0, eol);
  return deriveTitle(text);
};
const titleValid = (title) => {
  try {
    validateObservationTitle(title);
    return true;
  } catch {
    return false;
  }
};

/** Una reparación de título para una mutación de alta de observación, o `null`. */
function titleRepair(db, mutation) {
  const validation = validateSyncMutationPayload(mutation.entity, mutation.op, mutation.payload, mutation.entity_key);
  const missing = validation.missing_fields ?? [];
  if (mutation.entity !== SYNC_ENTITY.observation || mutation.op !== SYNC_OP_UPSERT || missing.length !== 1 || missing[0] !== 'title') return null;
  let payload;
  try {
    payload = JSON.parse(mutation.payload);
    if (typeof payload === 'string') payload = JSON.parse(payload);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const text = (name) => (typeof payload[name] === 'string' ? goTrim(payload[name]) : '');
  const key = goTrim(mutation.entity_key);
  if (key === '' || text('sync_id') !== key || text('content') === '') return null;
  const observation = db.get(
    "SELECT id, session_id, ifnull(project, '') AS project, ifnull(title, '') AS title, content, scope FROM observations WHERE sync_id = ? AND deleted_at IS NULL", key,
  );
  if (!observation) return null;
  const observationProject = canonical(observation.project);
  const mutationProject = canonical(mutation.project);
  const payloadProject = canonical(text('project'));
  if ((mutationProject !== '' && mutationProject !== observationProject) || (payloadProject !== '' && payloadProject !== observationProject)) return null;
  let title;
  if (goTrim(observation.title) !== '') {
    if (mutation.source !== SYNC_SOURCE_LOCAL || observationProject === '' || text('session_id') !== observation.session_id || text('scope') !== observation.scope) return null;
    title = observation.title;
  } else {
    title = deriveTitle(observation.content);
  }
  if (!titleValid(title)) return null;
  const rewritten = JSON.stringify({ ...payload, title });
  if ((validateSyncMutationPayload(mutation.entity, mutation.op, rewritten, mutation.entity_key).reason_code ?? '') !== '') return null;
  return { action: { seq: mutation.seq, project: mutation.project, entity: mutation.entity, entity_key: mutation.entity_key, op: mutation.op, title }, payload: rewritten, observationId: Number(observation.id), sourceTitle: observation.title };
}

/** Restaura el título de una carga desde la observación local (o lo deriva de su contenido) sin crear otra mutación. */
export function repairObservationMutationTitles(store, project, apply) {
  const name = canonical(project);
  const report = { ...(name !== '' ? { project: name } : {}), applied: apply, actions: [] };
  const run = (db) => {
    const repairs = [];
    for (const mutation of pendingRows(db, name)) {
      const repair = titleRepair(db, mutation);
      if (repair) repairs.push(repair);
    }
    if (apply) {
      const done = new Set();
      for (const repair of repairs) {
        if (goTrim(repair.sourceTitle) !== '' || done.has(repair.observationId)) continue;
        const res = db.run('UPDATE observations SET title = ? WHERE id = ? AND sync_id = ? AND deleted_at IS NULL AND title = ?', repair.action.title, repair.observationId, repair.action.entity_key, repair.sourceTitle);
        if (Number(res.changes) !== 1) throw new Error(`repair observation title source for mutation ${repair.action.seq}`);
        done.add(repair.observationId);
      }
      for (const repair of repairs) {
        const res = db.run("UPDATE sync_mutations SET payload = ? WHERE target_key = ? AND seq = ? AND acked_at IS NULL AND disposition = 'pending'", repair.payload, DEFAULT_SYNC_TARGET_KEY, repair.action.seq);
        if (Number(res.changes) !== 1) throw new Error(`repair observation title mutation ${repair.action.seq}`);
      }
    }
    report.actions = repairs.map((r) => r.action);
  };
  try {
    if (apply) store.db.writeTransaction(run);
    else store.db.readTransaction(run);
  } catch (err) {
    throw new Error(`repair observation mutation titles: ${err.message}`, { cause: err });
  }
  return report;
}

// ─── Altas obsoletas de proyectos sin inscribir ─────────────────────────────

const comparableTimestamp = (value) => {
  const text = goTrim(value ?? '');
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(text) ? new Date(`${text.replace(' ', 'T')}${/(Z|[+-]\d{2}:\d{2})$/.test(text) ? '' : 'Z'}`) : null;
  return iso && !Number.isNaN(iso.getTime()) ? iso.toISOString() : '';
};

function localDeleteEvidence(db, mutation) {
  if (mutation.entity === SYNC_ENTITY.session || mutation.entity === SYNC_ENTITY.observation) {
    const found = db.get('SELECT EXISTS(SELECT 1 FROM sync_delete_tombstones WHERE entity = ? AND entity_key = ? AND project = ? AND active = 1) AS n', mutation.entity, mutation.entity_key, mutation.project).n;
    if (Number(found) === 1) return true;
  } else if (mutation.entity === SYNC_ENTITY.prompt) {
    if (Number(db.get('SELECT EXISTS(SELECT 1 FROM prompt_tombstones WHERE sync_id = ? AND project = ?) AS n', mutation.entity_key, mutation.project).n) === 1) return true;
  } else {
    return false;
  }
  return projectTombstoneSupersedes(db, mutation);
}

/** ¿Una lápida de borrado duro del proyecto es posterior a la mutación? */
function projectTombstoneSupersedes(db, mutation) {
  if (mutation.entity === SYNC_ENTITY.session && Number(db.get('SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?) AS n', mutation.entity_key).n) === 1) return false;
  const projectKey = canonical(mutation.project);
  if (projectKey === '') return false;
  const tombstone = db.get('SELECT deleted_at, hard_delete FROM sync_delete_tombstones WHERE entity = ? AND entity_key = ? AND project = ? AND active = 1', SYNC_ENTITY.project, projectKey, projectKey);
  if (!tombstone || Number(tombstone.hard_delete) !== 1) return false;
  const occurred = comparableTimestamp(mutation.occurred_at);
  const deleted = comparableTimestamp(tombstone.deleted_at);
  return occurred !== '' && deleted !== '' && occurred <= deleted;
}

/** Retira altas locales pendientes de proyectos sin inscribir cuando una evidencia local de borrado prueba que ya no son vigentes. */
export function supersedeUnenrolledLegacyMutations(store, targetKey, project, apply) {
  const key = normalizeSyncTargetKey(targetKey);
  const name = canonical(project);
  const report = { ...(name !== '' ? { project: name } : {}), applied: apply, actions: [] };
  const run = (db) => {
    const candidates = [];
    for (const row of db.all(
      `SELECT seq, target_key, entity, entity_key, op, payload, source, project, occurred_at, acked_at FROM sync_mutations sm
       WHERE sm.target_key = ? AND sm.acked_at IS NULL AND sm.disposition = 'pending' AND sm.source = ? AND sm.op = ? AND sm.project != '' ORDER BY sm.seq ASC`,
      key, SYNC_SOURCE_LOCAL, SYNC_OP_UPSERT,
    )) {
      const mutation = { ...row, seq: Number(row.seq) };
      const projectKey = canonical(mutation.project);
      if (projectKey === '' || (name !== '' && projectKey !== name)) continue;
      if (Number(db.get('SELECT EXISTS(SELECT 1 FROM sync_enrolled_projects WHERE project = ?) AS n', projectKey).n) === 1) continue;
      if (localDeleteEvidence(db, mutation)) candidates.push(mutation);
    }
    const affected = new Set();
    for (const mutation of candidates) {
      const evidence = JSON.stringify({ entity: mutation.entity, entity_key: mutation.entity_key, project: mutation.project, trigger: 'doctor_local_reconciliation' });
      const action = { seq: mutation.seq, project: mutation.project, entity: mutation.entity, entity_key: mutation.entity_key, op: mutation.op, reason_code: 'local_entity_deleted', evidence };
      report.actions.push(action);
      if (!apply) continue;
      const res = db.run(
        `UPDATE sync_mutations SET disposition = ?, disposition_reason = ?, disposition_evidence = ?, disposition_at = datetime('now')
         WHERE target_key = ? AND seq = ? AND acked_at IS NULL AND disposition = 'pending' AND source = ? AND op = ?`,
        SYNC_MUTATION_DISPOSITION.superseded, action.reason_code, action.evidence, mutation.target_key, mutation.seq, SYNC_SOURCE_LOCAL, SYNC_OP_UPSERT,
      );
      if (Number(res.changes) > 0) affected.add(mutation.project);
    }
    if (!apply || affected.size === 0) return;
    refreshSyncLifecycle(db, key);
    for (const p of affected) refreshProjectSyncLifecycle(db, p);
  };
  try {
    if (apply) store.db.writeTransaction(run);
    else store.db.readTransaction(run);
  } catch (err) {
    throw new Error(`supersede unenrolled legacy mutations: ${err.message}`, { cause: err });
  }
  return report;
}

// ─── Cuarentena ─────────────────────────────────────────────────────────────

/** El hallazgo con las claves en el orden de su estructura; vacíos opcionales omitidos. */
function orderedFinding(f) {
  const out = { seq: f.seq, entity: f.entity, op: f.op, reason_code: f.reason_code, message: f.message, repairable: f.repairable };
  if (f.repair_hint) out.repair_hint = f.repair_hint;
  for (const key of ['entity_key', 'target_key', 'project']) if (f[key]) out[key] = f[key];
  return out;
}

/** Aparta del envío (sin acusar, reescribir ni borrar) las mutaciones pendientes que el validador heredado prueba irreparables. */
export function quarantineIrreparableSyncMutations(store, targetKey, project, apply) {
  const key = normalizeSyncTargetKey(targetKey);
  const name = canonical(project);
  const report = { ...(name !== '' ? { project: name } : {}), applied: apply, actions: [] };
  if (key === SYNC_INBOX_TARGET_KEY) return report;
  const run = (db) => {
    const affected = new Set();
    let any = false;
    const rows = db.all(
      `SELECT seq, target_key, entity, entity_key, op, payload, source, project, occurred_at, acked_at FROM sync_mutations WHERE target_key = ? AND acked_at IS NULL AND disposition = 'pending'${name !== '' ? ' AND project = ?' : ''} ORDER BY seq ASC`,
      ...[key, ...(name !== '' ? [name] : [])],
    );
    for (const raw of rows) {
      const mutation = { ...raw, seq: Number(raw.seq) };
      const evaluation = evaluateMutationForRepair(db, mutation);
      if (!evaluation.hasIssue || evaluation.canRepair) continue;
      const evidence = JSON.stringify({ check: 'sync_mutation_required_fields', finding: orderedFinding(evaluation.finding) });
      const action = {
        seq: mutation.seq, project: mutation.project, entity: mutation.entity, entity_key: mutation.entity_key, op: mutation.op, reason_code: evaluation.finding.reason_code, message: evaluation.finding.message, evidence,
      };
      report.actions.push(action);
      if (!apply) continue;
      const res = db.run(
        "UPDATE sync_mutations SET disposition = 'quarantined', disposition_reason = ?, disposition_evidence = ?, disposition_at = datetime('now') WHERE target_key = ? AND seq = ? AND acked_at IS NULL AND disposition = 'pending'",
        action.reason_code, action.evidence, key, action.seq,
      );
      if (Number(res.changes) === 0) continue;
      any = true;
      const p = canonical(mutation.project);
      if (p !== '') affected.add(p);
    }
    if (!apply || !any) return;
    refreshSyncLifecycle(db, key);
    if (key === DEFAULT_SYNC_TARGET_KEY) for (const p of affected) refreshProjectSyncLifecycle(db, p);
  };
  try {
    if (apply) store.db.writeTransaction(run);
    else store.db.readTransaction(run);
  } catch (err) {
    throw new Error(`quarantine irreparable sync mutations: ${err.message}`, { cause: err });
  }
  return report;
}

// ─── Títulos de origen ──────────────────────────────────────────────────────

function sourceTitleActions(rows) {
  const actions = [];
  for (const row of rows) {
    if (!row.missing_fields.includes('title')) continue;
    const title = deriveSourceTitle(row.content);
    if (!titleValid(title)) continue;
    actions.push({ id: row.id, sync_id: row.sync_id, project: row.project, title });
  }
  return actions;
}

function sourceUnrepairable(rows, actions) {
  const repaired = new Set(actions.map((a) => a.id));
  const issues = [];
  for (const row of rows) {
    const missing = row.missing_fields.filter((field) => field !== 'title' || !repaired.has(row.id));
    if (missing.length === 0) continue;
    const reason = missing.includes('type') || missing.includes('content')
      ? 'Repair cannot reconstruct missing type or content; manual investigation is required.'
      : 'Repair cannot derive a valid title from existing content; manual investigation is required.';
    issues.push({ id: row.id, sync_id: row.sync_id, project: row.project, missing_fields: missing, reason });
  }
  return issues;
}

/** Observación con el contenido de su carga de sincronización. */
function observationPayload(db, id) {
  const row = db.get(
    `SELECT o.sync_id, o.session_id, o.type, o.title, o.content, o.tool_name, o.project, o.scope, o.topic_key, o.revision_count, o.duplicate_count, o.last_seen_at,
            o.review_after, o.superseded_by_sync_id, o.created_at, o.updated_at FROM observations o WHERE o.id = ?`,
    id,
  );
  if (!row) throw new Error(`observation ${id} not found`);
  const payload = {};
  for (const [k, v] of Object.entries(row)) if (v !== null && v !== undefined) payload[k] = v;
  return payload;
}

function enqueueSourceObservationRepair(db, observation) {
  const payload = JSON.stringify(observation);
  const validation = validateSyncMutationPayload(SYNC_ENTITY.observation, SYNC_OP_UPSERT, payload, observation.sync_id);
  if ((validation.reason_code ?? '') !== '') return;
  const pendingDeletes = Number(db.get(
    "SELECT COUNT(*) AS n FROM sync_mutations WHERE target_key = ? AND entity = ? AND entity_key = ? AND op = ? AND source = ? AND acked_at IS NULL AND disposition = 'pending'",
    DEFAULT_SYNC_TARGET_KEY, SYNC_ENTITY.observation, observation.sync_id, SYNC_OP_DELETE, SYNC_SOURCE_LOCAL,
  ).n);
  if (pendingDeletes > 0) return;
  const updated = db.run(
    "UPDATE sync_mutations SET payload = ? WHERE target_key = ? AND entity = ? AND entity_key = ? AND op = ? AND source = ? AND acked_at IS NULL AND disposition = 'pending'",
    payload, DEFAULT_SYNC_TARGET_KEY, SYNC_ENTITY.observation, observation.sync_id, SYNC_OP_UPSERT, SYNC_SOURCE_LOCAL,
  );
  if (Number(updated.changes) > 0) return;
  journalMutation(db, { entity: SYNC_ENTITY.observation, entityKey: observation.sync_id, op: SYNC_OP_UPSERT, project: observation.project ?? '', sessionId: observation.session_id, payload: observation });
}

/** Restaura títulos de origen derivables de la primera línea del propio contenido; nunca inventa contenido ni tipo. */
export function repairObservationSourceTitles(store, project, apply) {
  const name = canonical(project);
  const report = { ...(name !== '' ? { project: name } : {}), applied: apply, actions: [], unrepairable: [] };
  let rows;
  try {
    rows = listObservationRequiredFieldRows(store, name);
  } catch (err) {
    throw new Error(`list source observation repairs: ${err.message}`, { cause: err });
  }
  let actions = sourceTitleActions(rows);
  report.unrepairable = sourceUnrepairable(rows, actions);
  if (!apply || actions.length === 0) {
    report.actions = actions;
    return report;
  }
  const backupPath = backupSqlite(store);
  try {
    store.db.writeTransaction((db) => {
      const current = listObservationRequiredFieldRows(store, name, db);
      actions = sourceTitleActions(current);
      report.unrepairable = sourceUnrepairable(current, actions);
      for (const action of actions) {
        const res = db.run("UPDATE observations SET title = ?, updated_at = ? WHERE id = ? AND ifnull(sync_id, '') = ? AND deleted_at IS NULL", action.title, now(), action.id, action.sync_id);
        if (Number(res.changes) !== 1) throw new Error(`repair source observation title ${action.id}`);
        enqueueSourceObservationRepair(db, observationPayload(db, action.id));
      }
    });
  } catch (err) {
    throw new Error(`repair source observation titles: ${err.message}`, { cause: err });
  }
  report.actions = actions;
  report.backup_path = backupPath;
  return report;
}

// ─── Orquestación ───────────────────────────────────────────────────────────

/**
 * Las cinco reparaciones, en orden; un error detiene las siguientes sin deshacer lo anterior.
 * @param {'plan'|'dry_run'|'apply'} mode
 */
export function repairSyncMutationRequiredFields(store, project, mode) {
  const apply = mode === 'apply';
  const directoryRepairs = repairPendingSessionDirectories(store, project, apply);
  const repairs = repairObservationMutationTitles(store, project, apply);
  const superseded = supersedeUnenrolledLegacyMutations(store, DEFAULT_SYNC_TARGET_KEY, project, apply);
  const report = quarantineIrreparableSyncMutations(store, DEFAULT_SYNC_TARGET_KEY, project, apply);
  if (!apply) {
    const handled = new Set([...directoryRepairs, ...repairs.actions, ...superseded.actions].map((a) => a.seq));
    report.actions = report.actions.filter((a) => !handled.has(a.seq));
  }
  const sourceRepairs = repairObservationSourceTitles(store, project, apply);
  if (apply) report.applied = directoryRepairs.length > 0 || repairs.actions.length > 0 || report.actions.length > 0 || superseded.actions.length > 0 || sourceRepairs.actions.length > 0;
  return {
    quarantine: report, directory_repairs: directoryRepairs, repairs: repairs.actions, superseded: superseded.actions, source_repairs: sourceRepairs.actions,
    ...(sourceRepairs.backup_path ? { source_repair_backup_path: sourceRepairs.backup_path } : {}), source_unrepairable: sourceRepairs.unrepairable,
  };
}

// ─── Destinos ajenos ────────────────────────────────────────────────────────

/**
 * Clasifica (y, con `apply`, limpia) los destinos de sincronización fuera del conjunto cerrado: reasigna al destino global sus
 * mutaciones pendientes de proyectos inscritos y borra el estado del destino cuando no conserva ninguna fila.
 * @returns {{ applied: boolean, actions: { target_key: string, retargeted_mutations: number, retained_mutations: number, state_removed: boolean }[] }}
 */
export function cleanupForeignSyncTargets(store, apply) {
  const report = { applied: false, actions: [] };
  const live = "sm.acked_at IS NULL AND sm.disposition = 'pending' AND EXISTS(SELECT 1 FROM sync_enrolled_projects sep WHERE sep.project = sm.project)";
  const run = (db) => {
    for (const r of db.all(
      `SELECT ss.target_key, SUM(CASE WHEN ${live} THEN 1 ELSE 0 END) AS moved, COUNT(sm.seq) - SUM(CASE WHEN ${live} THEN 1 ELSE 0 END) AS kept
       FROM sync_state ss LEFT JOIN sync_mutations sm ON sm.target_key = ss.target_key
       WHERE ss.target_key NOT IN (?, ?, ?) AND NOT EXISTS (SELECT 1 FROM sync_enrolled_projects sep WHERE ss.target_key = ? || sep.project)
       GROUP BY ss.target_key ORDER BY ss.target_key ASC`,
      DEFAULT_SYNC_TARGET_KEY, SYNC_INBOX_TARGET_KEY, 'local', `${DEFAULT_SYNC_TARGET_KEY}:`,
    )) {
      const kept = Number(r.kept ?? 0);
      report.actions.push({ target_key: r.target_key, retargeted_mutations: Number(r.moved ?? 0), retained_mutations: kept, state_removed: kept === 0 });
    }
    if (!apply || report.actions.length === 0) return;
    const affected = new Set();
    let moved = false;
    let removed = false;
    for (const action of report.actions) {
      if (action.retargeted_mutations > 0) {
        for (const p of db.all("SELECT DISTINCT sm.project FROM sync_mutations sm JOIN sync_enrolled_projects sep ON sep.project = sm.project WHERE sm.target_key = ? AND sm.acked_at IS NULL AND sm.disposition = 'pending'", action.target_key)) affected.add(p.project);
        db.run("UPDATE sync_mutations SET target_key = ? WHERE target_key = ? AND acked_at IS NULL AND disposition = 'pending' AND EXISTS(SELECT 1 FROM sync_enrolled_projects sep WHERE sep.project = sync_mutations.project)", DEFAULT_SYNC_TARGET_KEY, action.target_key);
        moved = true;
      }
      if (action.state_removed) {
        db.run('DELETE FROM sync_state WHERE target_key = ?', action.target_key);
        removed = true;
      }
    }
    if (moved) {
      db.run(
        `UPDATE sync_state SET last_enqueued_seq = MAX(last_enqueued_seq, (SELECT ifnull(MAX(seq), 0) FROM sync_mutations WHERE target_key = ?)),
           last_acked_seq = MAX(last_acked_seq, (SELECT ifnull(MAX(seq), 0) FROM sync_mutations WHERE target_key = ? AND acked_at IS NOT NULL)), updated_at = datetime('now') WHERE target_key = ?`,
        DEFAULT_SYNC_TARGET_KEY, DEFAULT_SYNC_TARGET_KEY, DEFAULT_SYNC_TARGET_KEY,
      );
      refreshSyncLifecycle(db, DEFAULT_SYNC_TARGET_KEY);
      for (const p of affected) refreshProjectSyncLifecycle(db, p);
    }
    report.applied = moved || removed;
  };
  try {
    if (apply) store.db.writeTransaction(run);
    else store.db.readTransaction(run);
  } catch (err) {
    throw new Error(`cleanup foreign sync targets: ${err.message}`, { cause: err });
  }
  return report;
}
