import { listDiagnosticSessions, listOrphanedPendingRelationEvidence } from '../store/diagnostic.js';
import { goTrim } from '../store/text.js';
import { CHECK, REASON_QUARANTINED_PULLED_SESSION_IDENTITY } from './checks.js';
import { normalizeProjectName } from './core.js';
import {
  decideSessionProjectAuthority, detectSessionDirectoryProject, knownManualSessionTarget, manualSessionNameTarget, sessionProjectAliases,
} from './evidence.js';
import { REPAIRABLE_CODES } from './repair-codes.js';

export const REPAIR_MODE = Object.freeze({ plan: 'plan', dryRun: 'dry_run', apply: 'apply' });

/** Chequeos reparables cuya reparación necesita el diario de nube (llega con la nube). */
export const CLOUD_JOURNAL_REPAIRS = Object.freeze([CHECK.invalidSessionIdentity, CHECK.syncMutationRequiredFields, CHECK.syncTargetClosedSpace]);

const isTrustedDirectoryEvidence = (source) => ['git_remote', 'git_root'].includes(goTrim(source ?? ''));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const counts = () => ({
  sessions_planned: 0, observations_planned: 0, prompts_planned: 0, sessions_applied: 0, observations_applied: 0, prompts_applied: 0,
  corrected_mutations_planned: 0, corrected_mutations_applied: 0, relations_planned: 0, relations_applied: 0,
});

/** Los hallazgos de un informe cuyos `reason_code` son `reason`. */
function* findings(report, reason) {
  for (const check of report.checks) for (const f of check.findings ?? []) if (reason === undefined || f.reason_code === reason) yield f;
}

function planDirectoryMismatch(plan, report) {
  for (const f of findings(report)) {
    const ev = f.evidence ?? {};
    const from = normalizeProjectName(ev.session_project ?? '');
    const decision = decideSessionProjectAuthority(ev.session_project ?? '', '', false, { project: ev.directory_project ?? '', source: ev.directory_project_source ?? '', path: ev.directory_project_path ?? '' });
    if (!isTrustedDirectoryEvidence(ev.directory_project_source)) {
      plan.skipped.push({ session_id: ev.session_id ?? '', reason_code: 'untrusted_directory_evidence', message: 'directory evidence is not git_remote or git_root' });
      continue;
    }
    if (!ev.session_id || from === '' || decision.authority !== 'trusted_directory' || from === decision.repairTarget || from !== plan.project) {
      plan.skipped.push({ session_id: ev.session_id ?? '', reason_code: 'invalid_reclassification_evidence', message: 'doctor evidence does not describe a supported project move' });
      continue;
    }
    plan.actions.push(action(ev.session_id, from, decision.repairTarget, f.reason_code, decision.repairEvidenceSource, decision.repairEvidencePath));
  }
}

function action(sessionId, from, to, reason, source, path) {
  const out = { session_id: sessionId, from_project: from, to_project: to, reason_code: reason };
  if (source) out.evidence_source = source;
  if (path) out.evidence_path = path;
  return out;
}

function planManualSession(plan, scope) {
  const sessions = listDiagnosticSessions(scope.store, '');
  const known = new Set(sessions.map((s) => normalizeProjectName(s.project)).filter((p) => p !== ''));
  const detected = new Map();
  for (const session of sessions) {
    const from = normalizeProjectName(session.project);
    if (from !== plan.project) continue;
    const nameTarget = manualSessionNameTarget(session.name);
    if (nameTarget === '' || from === nameTarget) continue;
    const [, knownManualTarget] = knownManualSessionTarget(session.name, known);
    const directoryProject = detectSessionDirectoryProject(scope, detected, goTrim(session.directory)) ?? { project: '', source: '', path: '' };
    const decision = decideSessionProjectAuthority(session.project, nameTarget, knownManualTarget, directoryProject);
    if (decision.directoryBasenameCorroboratesPersisted) {
      plan.skipped.push({ session_id: session.id, reason_code: 'directory_basename_corroborates_persisted_project', message: 'directory basename corroborates the persisted project and cannot authorize a conflicting manual-name move' });
      continue;
    }
    if (!knownManualTarget) {
      plan.skipped.push({ session_id: session.id, reason_code: 'manual_name_unknown_project', message: 'manual session suffix is not a known local project' });
      continue;
    }
    if (decision.authority !== 'manual_name' || decision.repairTarget === from) continue;
    plan.actions.push(action(session.id, from, decision.repairTarget, CHECK.manualSessionNameProjectMismatch, decision.repairEvidenceSource, decision.repairEvidencePath));
  }
}

/** Agrupa la evidencia por ID: una sesión referenciada desde varios proyectos se omite. */
function planOrphanedObservationSession(plan, report) {
  const candidates = new Map();
  const ambiguous = new Set();
  for (const f of findings(report, CHECK.orphanedObservationSession)) {
    const ev = f.evidence ?? {};
    const project = normalizeProjectName(ev.project ?? '');
    if (goTrim(ev.session_id ?? '') === '' || project === '' || goTrim(ev.first_observed_at ?? '') === '') {
      plan.skipped.push({ session_id: ev.session_id ?? '', reason_code: 'invalid_orphaned_session_evidence', message: 'orphaned session repair requires a non-blank session ID, project, and first observation timestamp' });
      continue;
    }
    const candidate = { session_id: ev.session_id, project, observation_count: Number(ev.observation_count ?? 0), started_at: ev.first_observed_at };
    const existing = candidates.get(candidate.session_id);
    if (existing && existing.project !== candidate.project) {
      ambiguous.add(candidate.session_id);
      continue;
    }
    candidates.set(candidate.session_id, candidate);
  }
  for (const [sessionId, candidate] of candidates) {
    if (ambiguous.has(sessionId)) {
      plan.skipped.push({ session_id: sessionId, reason_code: 'ambiguous_orphaned_session_project', message: 'the same missing session ID is referenced by multiple projects' });
      continue;
    }
    plan.placeholder_sessions.push(candidate);
  }
  plan.placeholder_sessions.sort((a, b) => compare(a.session_id, b.session_id));
}

/** Parte de evidencia nueva: las relaciones con ambos extremos ausentes no pertenecen a ningún proyecto. */
function planOrphanedPendingRelations(plan, scope) {
  const evidence = listOrphanedPendingRelationEvidence(scope.store);
  if (evidence.candidates.length === 0) return;
  plan.orphaned_pending_relations = evidence;
  plan.counts.relations_planned = evidence.candidates.length;
}

function planInvalidSessionIdentity(plan, report) {
  for (const f of findings(report)) {
    if (f.reason_code === CHECK.invalidSessionIdentity) {
      plan.skipped.push({ session_id: f.evidence?.session_id ?? '', reason_code: 'cannot_repair_without_explicit_canonical_session_id', message: 'supply --replacement-id with a valid unused canonical session ID to plan this local repair' });
    } else if (f.reason_code === REASON_QUARANTINED_PULLED_SESSION_IDENTITY) {
      plan.skipped.push({ reason_code: REASON_QUARANTINED_PULLED_SESSION_IDENTITY, message: 'pulled session mutation was quarantined with a blank identity; it can only be applied once the remote side publishes a canonical session ID' });
    }
  }
}

/** Vuelve a leer alias y directorios: el informe puede ser anterior a un cambio de alias. Ni crea acciones ni elige dueño. */
function vetoProjectAliasMoves(plan, scope) {
  const directories = new Map(listDiagnosticSessions(scope.store, '').map((s) => [s.id, s.directory]));
  const kept = [];
  for (const a of plan.actions) {
    const aliases = sessionProjectAliases(scope, directories.get(a.session_id));
    if (aliases.conflict || ((aliases.key_alias || aliases.cwd_alias) && aliases.project !== a.to_project)) {
      plan.skipped.push({ session_id: a.session_id, reason_code: 'project_alias_contradicts_reclassification', message: 'Local project aliases conflict with this move; review alias evidence. Aliases never authorize historical reclassification.' });
      continue;
    }
    kept.push(a);
  }
  plan.actions = kept;
}

function dedupeAndSort(plan) {
  const seen = new Map();
  for (const a of plan.actions) seen.set(`${a.session_id}\u0000${a.from_project}\u0000${a.to_project}`, a);
  plan.actions = [...seen.values()].sort((a, b) => compare(a.session_id, b.session_id));
  plan.skipped.sort((a, b) => (a.session_id === b.session_id ? compare(a.reason_code, b.reason_code) : compare(a.session_id ?? '', b.session_id ?? '')));
}

/**
 * Plan de reparación de un chequeo, sin escribir nada.
 * @param {{ store: object, project?: string }} scope
 * @param {object} report informe del chequeo
 * @param {string} check
 * @param {'plan'|'dry_run'|'apply'} mode
 */
export function buildRepairPlan(scope, report, check, mode) {
  const project = normalizeProjectName(scope.project ?? '');
  check = goTrim(check ?? '');
  const plan = {
    project, check, mode, status: 'planned', actions: [], placeholder_sessions: [], skipped: [], counts: counts(),
  };
  if (mode === REPAIR_MODE.dryRun) plan.status = 'dry_run';
  else if (mode !== REPAIR_MODE.plan && mode !== REPAIR_MODE.apply) throw new Error(`unsupported repair mode ${JSON.stringify(mode)}`);

  switch (check) {
    case CHECK.sessionProjectDirectoryMismatch: planDirectoryMismatch(plan, report); break;
    case CHECK.manualSessionNameProjectMismatch: planManualSession(plan, scope); break;
    case CHECK.invalidSessionIdentity: planInvalidSessionIdentity(plan, report); break;
    case CHECK.orphanedObservationSession: planOrphanedObservationSession(plan, report); break;
    case CHECK.orphanedPendingRelations: planOrphanedPendingRelations(plan, scope); break;
    default: throw new Error(`unsupported repair check ${JSON.stringify(check)}`);
  }
  if (check === CHECK.sessionProjectDirectoryMismatch || check === CHECK.manualSessionNameProjectMismatch) vetoProjectAliasMoves(plan, scope);
  dedupeAndSort(plan);
  if (plan.actions.length === 0 && plan.placeholder_sessions.length === 0 && !plan.orphaned_pending_relations) plan.status = 'noop';
  return plan;
}

/** Orden de campos del plan al serializarlo; los opcionales aparecen solo si tienen contenido. */
export function planJson(plan) {
  const out = { project: plan.project, check: plan.check, mode: plan.mode, status: plan.status, actions: plan.actions };
  if (plan.target_actions?.length) out.target_actions = plan.target_actions;
  if (plan.placeholder_sessions.length) out.placeholder_sessions = plan.placeholder_sessions;
  if (plan.identity_repair) out.identity_repair = plan.identity_repair;
  if (plan.orphaned_pending_relations) out.orphaned_pending_relations = plan.orphaned_pending_relations;
  if (plan.blockers?.length) out.blockers = plan.blockers;
  if (plan.skipped.length) out.skipped = plan.skipped.map(({ session_id: id, ...rest }) => (id ? { session_id: id, ...rest } : rest));
  out.counts = plan.counts;
  if (plan.backup_path) out.backup_path = plan.backup_path;
  return out;
}

export { REPAIRABLE_CODES };
