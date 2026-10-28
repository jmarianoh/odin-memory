import { normalizeProject } from '../project/canonical.js';
import { StoreError, storeError } from './errors.js';
import { MANUAL_SESSION_ID_PREFIX, SESSION_OWNERSHIP_PROJECT_OWNED, SESSION_OWNERSHIP_SHARED, foreignRecordOwner, sessionOwnership } from './sessions.js';
import { isProjectEnrolled } from './sync-state.js';
import { SQL_WHITESPACE_TRIM_SET, goTrim } from './text.js';

export const RESCUE_BLOCKED_OWNED_BY_OTHER_PROJECT = 'owned_by_other_project';
export const RESCUE_BLOCKED_SESSION_OWNED_BY_OTHER_PROJECT = 'session_owned_by_other_project';
export const RESCUE_BLOCKED_DEPENDENT_RECORD_OWNED_BY_OTHER_PROJECT = 'dependent_record_owned_by_other_project';
export const RESCUE_BLOCKED_MISSING = 'missing';

const invalidRequest = (detail) => new StoreError('project_rescue_invalid_request', `project rescue request is invalid: ${detail}`);

const OBSERVATION = {
  selectSessionId: 'SELECT session_id FROM observations WHERE id = ?',
  selectProject: 'SELECT project FROM observations WHERE id = ?',
  updateProject: "UPDATE observations SET project = ? WHERE id = ? AND ifnull(trim(project), '') = ''",
};
const PROMPT = {
  selectSessionId: 'SELECT session_id FROM user_prompts WHERE id = ?',
  selectProject: 'SELECT project FROM user_prompts WHERE id = ?',
  updateProject: "UPDATE user_prompts SET project = ? WHERE id = ? AND ifnull(trim(project), '') = ''",
};
const SESSION_UPDATE_PROJECT = "UPDATE sessions SET project = ? WHERE id = ? AND ifnull(trim(project), '') = ''";
const SESSION_STAMP_MODE = "UPDATE sessions SET project = ?, ownership_mode = ? WHERE id = ? AND ifnull(trim(ownership_mode, ?), '') = ''";

/** La sesión de guardado manual de este proyecto (`manual-save-<proyecto>`). */
function manualSaveOwnerProject(id, project) {
  if (!id.startsWith(MANUAL_SESSION_ID_PREFIX)) return false;
  const canonical = normalizeProject(project).normalized;
  if (canonical === '') return false;
  return normalizeProject(id.slice(MANUAL_SESSION_ID_PREFIX.length)).normalized === canonical;
}

function loadRecords(db, query, ids) {
  return ids.map((id) => {
    const row = db.get(query.selectSessionId, id);
    return { id, sessionId: row?.session_id ?? '', exists: row !== undefined };
  });
}

function resolveSessionScope(explicitIds, ...groups) {
  const ordered = [];
  const explicit = new Set(explicitIds);
  const seen = new Set();
  const add = (id) => {
    if (id === '' || seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
  };
  for (const id of explicitIds) add(id);
  for (const group of groups) for (const record of group) if (record.exists) add(record.sessionId);
  return { ordered, explicit };
}

const counted = { alreadyOwned: 'skipped_records', missing: 'skipped_records', conflict: 'conflicting_records' };

/**
 * Asigna un proyecto a registros históricos que no tenían dueño (proyecto vacío): las
 * sesiones indicadas, las observaciones y los prompts. Nunca quita un registro a otro
 * proyecto; lo que no puede mover queda en `blocked` con el motivo.
 *
 * @param {import('./store.js').Store} store
 * @param {{ target_project: string, observation_ids?: number[], session_ids?: string[], prompt_ids?: number[] }} p
 * @returns {{ rescued_observations: number, rescued_sessions: number, rescued_prompts: number, conflicting_records: number, skipped_records: number, journaled: boolean, complete: boolean, blocked: { kind: string, id: string, reason: string, owned_by?: string }[] }}
 * @throws {StoreError} `project_required`, `project_rescue_invalid_request`
 */
export function rescueNullProjectOwnership(store, p) {
  const target = normalizeProject(p.target_project ?? '').normalized;
  if (goTrim(target) === '') throw storeError('project_required');
  const observationIds = p.observation_ids ?? [];
  const sessionIds = p.session_ids ?? [];
  const promptIds = p.prompt_ids ?? [];
  if (observationIds.length === 0 && sessionIds.length === 0 && promptIds.length === 0) throw invalidRequest('at least one record id is required');
  if ([...observationIds, ...promptIds].some((id) => !(id > 0))) throw invalidRequest('record ids must be positive');
  if (sessionIds.some((id) => goTrim(id) === '')) throw invalidRequest('session ids must not be blank');

  const result = {
    rescued_observations: 0, rescued_sessions: 0, rescued_prompts: 0, conflicting_records: 0, skipped_records: 0, journaled: false, complete: false, blocked: [],
  };
  const block = (kind, id, reason, ownedBy = '') => {
    const entry = { kind, id, reason };
    if (ownedBy !== '') entry.owned_by = ownedBy;
    result.blocked.push(entry);
  };
  const count = (outcome) => {
    if (counted[outcome]) result[counted[outcome]] += 1;
  };

  return store.db.writeTransaction((db) => {
    const observations = loadRecords(db, OBSERVATION, observationIds);
    const prompts = loadRecords(db, PROMPT, promptIds);
    const scope = resolveSessionScope(sessionIds, observations, prompts);

    // Plan de sesiones.
    const claim = [];
    const stampMode = new Set();
    const willOwn = new Set();
    for (const id of scope.ordered) {
      const { project, mode, found } = sessionOwnership(db, id);
      if (!found) {
        if (scope.explicit.has(id)) {
          count('missing');
          block('session', id, RESCUE_BLOCKED_MISSING);
        }
      } else if (project === target) {
        willOwn.add(id);
        if (mode === '') stampMode.add(id);
        else if (scope.explicit.has(id)) count('alreadyOwned');
      } else if (project !== '') {
        if (scope.explicit.has(id)) count('conflict');
        block('session', id, RESCUE_BLOCKED_OWNED_BY_OTHER_PROJECT, project);
      } else {
        const { owner } = foreignRecordOwner(db, id, target);
        if (owner !== '') {
          if (scope.explicit.has(id)) count('conflict');
          block('session', id, RESCUE_BLOCKED_DEPENDENT_RECORD_OWNED_BY_OTHER_PROJECT, owner);
          continue;
        }
        claim.push(id);
        willOwn.add(id);
        if (mode === '') stampMode.add(id);
      }
    }

    // Plan de observaciones y prompts.
    const planRecords = (query, kind, records) => {
      const moves = [];
      for (const record of records) {
        const id = String(record.id);
        if (!record.exists) {
          count('missing');
          block(kind, id, RESCUE_BLOCKED_MISSING);
          continue;
        }
        const owned = normalizeProject(goTrim(db.get(query.selectProject, record.id)?.project ?? '')).normalized;
        if (owned === target) {
          count('alreadyOwned');
          continue;
        }
        if (owned !== '') {
          count('conflict');
          block(kind, id, RESCUE_BLOCKED_OWNED_BY_OTHER_PROJECT, owned);
          continue;
        }
        if (!willOwn.has(record.sessionId)) {
          count('conflict');
          block(kind, id, RESCUE_BLOCKED_SESSION_OWNED_BY_OTHER_PROJECT);
          continue;
        }
        moves.push(record.id);
      }
      return moves;
    };
    const observationMoves = planRecords(OBSERVATION, 'observation', observations);
    const promptMoves = planRecords(PROMPT, 'prompt', prompts);

    for (const id of claim) {
      if (stampMode.has(id)) continue;
      db.run(SESSION_UPDATE_PROJECT, target, id);
      result.rescued_sessions += 1;
    }
    for (const id of scope.ordered) {
      if (!stampMode.has(id)) continue;
      const mode = manualSaveOwnerProject(id, target) ? SESSION_OWNERSHIP_PROJECT_OWNED : SESSION_OWNERSHIP_SHARED;
      const changed = Number(db.run(SESSION_STAMP_MODE, target, mode, id, SQL_WHITESPACE_TRIM_SET).changes);
      if (changed !== 1) throw new Error(`stamp ownership mode for session ${JSON.stringify(id)}: updated ${changed} rows, want 1`);
      result.rescued_sessions += 1;
    }
    for (const id of observationMoves) {
      db.run(OBSERVATION.updateProject, target, id);
      result.rescued_observations += 1;
    }
    for (const id of promptMoves) {
      db.run(PROMPT.updateProject, target, id);
      result.rescued_prompts += 1;
    }

    // El diario de sincronización solo existe para proyectos inscritos en la nube (F9):
    // mover registros de uno de ellos sin anotarlo dejaría la réplica desalineada.
    if (result.rescued_sessions + result.rescued_observations + result.rescued_prompts > 0 && isProjectEnrolled(store, target)) {
      throw storeError('sync_journal_unavailable', `project ownership rescue for project ${JSON.stringify(target)}`);
    }
    result.complete = result.blocked.length === 0;
    return result;
  });
}
