import { activeRuntimeSessions } from '../store/runtime-sessions.js';
import { RESCUE_OWNERSHIP_COMMAND, SESSION_OWNERSHIP_PROJECT_OWNED, SESSION_OWNERSHIP_SHARED } from '../store/sessions.js';
import { DEFAULT_SYNC_TARGET_KEY, SYNC_INBOX_TARGET_KEY, cloudTargetKeyForProject } from '../store/sync-state.js';
import { LOCAL_CHUNK_TARGET_KEY } from '../store/sync-apply.js';
import {
  SYNC_MUTATION_DISPOSITION, countPendingNonEnrolledSyncMutations, listDiagnosticObservationRequiredFields, listDiagnosticSessions, listEnrolledProjects,
  listInvalidSessionIdentityEvidence, listOrphanedObservationSessionEvidence, listOrphanedPendingRelationEvidenceBounded, listPendingProjectMutations,
  listQuarantinedPulledSessionEvidence, listSyncStates, readSqliteLockSnapshot, validateSyncMutationPayload,
} from '../store/diagnostic.js';
import { goTrim } from '../store/text.js';
import { SEVERITY, mapEvidence, normalizeProjectName, resultFromFindings } from './core.js';
import {
  decideSessionProjectAuthority, detectSessionDirectoryProject, knownManualSessionTarget, knownSessionProjects, sessionProjectAliases,
  shouldReportDirectoryMismatch, shouldReportManualNameMismatch,
} from './evidence.js';

export const CHECK = Object.freeze({
  sessionProjectDirectoryMismatch: 'session_project_directory_mismatch',
  manualSessionNameProjectMismatch: 'manual_session_name_project_mismatch',
  syncMutationRequiredFields: 'sync_mutation_required_fields',
  syncTargetClosedSpace: 'sync_target_closed_space',
  invalidSessionIdentity: 'invalid_session_identity',
  orphanedObservationSession: 'orphaned_observation_session',
  orphanedPendingRelations: 'orphaned_pending_relations',
  unownedSessionProject: 'unowned_session_project',
  sqliteLockContention: 'sqlite_lock_contention',
  ambiguousActiveRuntimeSessions: 'ambiguous_active_runtime_sessions',
});

/** Un hallazgo de pulled session omitido, no una fila fuente corrupta. */
export const REASON_QUARANTINED_PULLED_SESSION_IDENTITY = 'quarantined_pulled_session_identity';
/** Un `sync_state` con un destino fuera del conjunto cerrado. */
export const REASON_FOREIGN_SYNC_TARGET = 'foreign_sync_target';
export const REASON_NON_ENROLLED_PENDING_MUTATIONS = 'non_enrolled_pending_mutations';

/** Cuántas relaciones candidatas muestra el hallazgo agregado. */
const ORPHANED_PENDING_RELATION_SAMPLE_LIMIT = 10;

/** Un hallazgo con el orden de campos del informe. */
export function finding(checkId, f) {
  return {
    check_id: checkId,
    severity: f.severity,
    reason_code: f.reason_code,
    message: f.message,
    why: f.why,
    evidence: f.evidence,
    safe_next_step: f.safe_next_step,
    requires_confirmation: f.requires_confirmation,
  };
}

const sortedUnique = (values) => [...new Set(values)].sort();

// ─── ambiguous_active_runtime_sessions ───────────────────────────────────────

function ambiguousActiveRuntimeSessions(scope) {
  const code = CHECK.ambiguousActiveRuntimeSessions;
  const sessions = listDiagnosticSessions(scope.store, scope.project);
  const directoriesByProject = new Map();
  const directoryBySessionId = new Map();
  for (const session of sessions) {
    const project = normalizeProjectName(session.project);
    if (project === '' || session.directory === '') continue;
    if (!directoriesByProject.has(project)) directoriesByProject.set(project, new Set());
    directoriesByProject.get(project).add(session.directory);
    directoryBySessionId.set(session.id, session.directory);
  }
  const projects = [...directoriesByProject.keys()].sort();
  const findings = [];
  for (const project of projects) {
    const directories = [...directoriesByProject.get(project)].sort();
    const candidateIds = activeRuntimeSessions(scope.store, project, ...directories);
    const byDirectory = new Map();
    for (const id of candidateIds) {
      const directory = directoryBySessionId.get(id);
      if (!byDirectory.has(directory)) byDirectory.set(directory, []);
      byDirectory.get(directory).push(id);
    }
    const ambiguousDirectories = [];
    const ambiguousIds = [];
    for (const directory of directories) {
      const ids = byDirectory.get(directory) ?? [];
      if (ids.length < 2) continue;
      ambiguousDirectories.push(directory);
      ambiguousIds.push(...ids);
    }
    if (ambiguousIds.length === 0) continue;
    ambiguousIds.sort();
    findings.push(finding(code, {
      severity: SEVERITY.warning,
      reason_code: code,
      message: `Project ${JSON.stringify(project)} has ${ambiguousIds.length} active runtime session candidates across ${ambiguousDirectories.length} directory or directories.`,
      why: 'Omitted-session writes fail closed when multiple active runtime sessions match the same project and directory, so doctor reports the ambiguity without selecting or changing a session.',
      evidence: mapEvidence({ project, active_candidate_count: ambiguousIds.length, directories: ambiguousDirectories, session_ids: ambiguousIds }),
      safe_next_step: 'Use `mem_session_end` to end only confirmed stale IDs; otherwise keep explicit runtime attribution with `session_id` on writes. Doctor is diagnostic-only and never selects, ends, or modifies sessions.',
      requires_confirmation: true,
    }));
  }
  return resultFromFindings(code, mapEvidence({ projects_evaluated: projects.length }), findings);
}

// ─── session_project_directory_mismatch / manual_session_name_project_mismatch ─

function sessionProjectDirectoryMismatch(scope) {
  const code = CHECK.sessionProjectDirectoryMismatch;
  const sessions = listDiagnosticSessions(scope.store, scope.project);
  const known = knownSessionProjects(scope);
  const findings = [];
  const detected = new Map();
  for (const session of sessions) {
    const [nameTarget, knownManualTarget] = knownManualSessionTarget(session.name, known);
    const directoryProject = detectSessionDirectoryProject(scope, detected, goTrim(session.directory)) ?? { project: '', source: '', path: '' };
    const decision = decideSessionProjectAuthority(session.project, nameTarget, knownManualTarget, directoryProject);
    if (!shouldReportDirectoryMismatch(decision)) continue;
    const aliases = sessionProjectAliases(scope, session.directory);
    findings.push(finding(code, {
      severity: SEVERITY.warning,
      reason_code: 'session_project_directory_mismatch',
      message: 'Session project does not match the project inferred from its directory.',
      why: 'Project/directory drift can cause agents to retrieve or save memories under the wrong project scope.',
      evidence: mapEvidence({
        session_id: session.id,
        session_project: session.project,
        directory: session.directory,
        directory_project: directoryProject.project,
        directory_project_source: directoryProject.source,
        directory_project_path: directoryProject.path ?? '',
        project_aliases: aliases,
      }),
      safe_next_step: 'Review the session evidence and use explicit `--project`/MCP project overrides until the project naming is consolidated.',
      requires_confirmation: true,
    }));
  }
  return resultFromFindings(code, mapEvidence({ sessions_evaluated: sessions.length }), findings);
}

function manualSessionNameProjectMismatch(scope) {
  const code = CHECK.manualSessionNameProjectMismatch;
  const sessions = listDiagnosticSessions(scope.store, scope.project);
  const known = knownSessionProjects(scope);
  const findings = [];
  const detected = new Map();
  for (const session of sessions) {
    const [nameProject, knownManualTarget] = knownManualSessionTarget(session.name, known);
    const directoryProject = detectSessionDirectoryProject(scope, detected, goTrim(session.directory)) ?? { project: '', source: '', path: '' };
    const decision = decideSessionProjectAuthority(session.project, nameProject, knownManualTarget, directoryProject);
    if (!shouldReportManualNameMismatch(decision)) continue;
    const aliases = sessionProjectAliases(scope, session.directory);
    findings.push(finding(code, {
      severity: SEVERITY.warning,
      reason_code: 'manual_session_name_project_mismatch',
      message: 'Manual session name suffix does not match sessions.project.',
      why: 'Manual session naming drift cannot prove project ownership and must not be auto-rescued.',
      evidence: mapEvidence({
        session_id: session.id, session_name: session.name, session_project: session.project, ownership_mode: session.ownership_mode, name_project: nameProject, project_aliases: aliases,
      }),
      safe_next_step: 'Review the persisted project, then use the ownership rescue command deliberately; its SQLite backup is the rollback point.',
      requires_confirmation: true,
    }));
  }
  return resultFromFindings(code, mapEvidence({ sessions_evaluated: sessions.length }), findings);
}

// ─── sync_mutation_required_fields ───────────────────────────────────────────

export function syncMutationRequiredFieldsRepairHint(project) {
  let command = 'odin doctor repair --check sync_mutation_required_fields --dry-run';
  if (goTrim(project ?? '') !== '') command = `odin doctor repair --project ${goTrim(project)} --check sync_mutation_required_fields --dry-run`;
  return `Run \`${command}\` to inspect local repairs; cloud-upgrade tooling requires configured cloud sync.`;
}

function observationSourceRepairHint(project, missingFields) {
  const hint = syncMutationRequiredFieldsRepairHint(project);
  if (missingFields.some((f) => f === 'type' || f === 'content')) return `${hint} Repair cannot reconstruct missing type or content; manual investigation is required. Inspect source_unrepairable in the repair output.`;
  return `${hint} Only titles recoverable from existing content can be repaired; sources without a recoverable title require manual investigation and appear in source_unrepairable.`;
}

function supersededEvidenceMissingFields(mutation) {
  const missing = [];
  if (goTrim(mutation.disposition_reason ?? '') === '') missing.push('disposition_reason');
  if (goTrim(mutation.disposition_evidence ?? '') === '') missing.push('disposition_evidence');
  if (mutation.disposition_at == null || goTrim(mutation.disposition_at) === '') missing.push('disposition_at');
  return missing;
}

const dispositionEvidence = (mutation) => mapEvidence({
  seq: mutation.seq,
  target_key: mutation.target_key,
  project: mutation.project,
  entity: mutation.entity,
  op: mutation.op,
  entity_key: mutation.entity_key,
  disposition: mutation.disposition,
  disposition_reason: mutation.disposition_reason,
  disposition_evidence: mutation.disposition_evidence,
  disposition_at: mutation.disposition_at,
});

function syncMutationRequiredFields(scope) {
  const code = CHECK.syncMutationRequiredFields;
  const sourceObservations = listDiagnosticObservationRequiredFields(scope.store, scope.project);
  const mutations = listPendingProjectMutations(scope.store, scope.project);
  const blocking = [];
  const terminal = [];
  for (const observation of sourceObservations) {
    blocking.push(finding(code, {
      severity: SEVERITY.blocking,
      reason_code: 'observation_source_missing_required_fields',
      message: `Observation source row ${observation.id} is missing required fields: ${observation.missing_fields.join(', ')}`,
      why: 'A corrupt local observation source can produce rejected cloud payloads even when no pending mutation remains to diagnose.',
      evidence: observation,
      safe_next_step: observationSourceRepairHint(scope.project, observation.missing_fields),
      requires_confirmation: true,
    }));
  }
  for (const mutation of mutations) {
    // Una fila en cuarentena ya no llega al transporte: se informa como evidencia, no bloquea.
    if (goTrim(mutation.disposition) === SYNC_MUTATION_DISPOSITION.quarantined) {
      terminal.push(finding(code, {
        severity: SEVERITY.info,
        reason_code: 'sync_mutation_quarantined',
        message: 'Sync mutation is quarantined and no longer blocks cloud replication.',
        why: 'Quarantine keeps the irreparable journal row as durable local evidence while removing it from transport, so doctor reports it instead of staying blocked forever.',
        evidence: dispositionEvidence(mutation),
        safe_next_step: 'No action required. Inspect the recorded disposition evidence if you need to know what was dropped from cloud sync.',
        requires_confirmation: false,
      }));
      continue;
    }
    if (goTrim(mutation.disposition) === SYNC_MUTATION_DISPOSITION.superseded) {
      const missing = supersededEvidenceMissingFields(mutation);
      if (missing.length > 0) {
        blocking.push(finding(code, {
          severity: SEVERITY.blocking,
          reason_code: 'sync_mutation_superseded_evidence_incomplete',
          message: `Superseded sync mutation is missing required audit evidence: ${missing.join(', ')}`,
          why: 'A terminal supersession without its reason, evidence, and timestamp cannot prove why transport was suppressed.',
          evidence: mapEvidence({ seq: mutation.seq, missing_fields: missing }),
          safe_next_step: 'Inspect the local journal evidence and repair it deliberately; automatic supersession metadata repair is unavailable.',
          requires_confirmation: true,
        }));
      } else {
        terminal.push(finding(code, {
          severity: SEVERITY.info,
          reason_code: 'sync_mutation_superseded',
          message: 'Sync mutation is superseded by current local lifecycle evidence and no longer blocks cloud replication.',
          why: 'Supersession preserves the obsolete local journal row and its reason without acknowledging or transporting it, so doctor keeps audit evidence without treating it as active work.',
          evidence: dispositionEvidence(mutation),
          safe_next_step: 'No action required. Inspect the recorded disposition evidence if you need to audit the local reconciliation.',
          requires_confirmation: false,
        }));
      }
      continue;
    }
    const validation = validateSyncMutationPayload(mutation.entity, mutation.op, mutation.payload, mutation.entity_key);
    if (!validation.reason_code) continue;
    blocking.push(finding(code, {
      severity: SEVERITY.blocking,
      reason_code: validation.reason_code,
      message: validation.message,
      why: 'A pending sync mutation with missing required fields can block safe cloud replication and must fail loudly instead of being silently dropped.',
      evidence: mapEvidence({
        seq: mutation.seq, target_key: mutation.target_key, project: mutation.project, entity: mutation.entity, op: mutation.op, entity_key: mutation.entity_key, missing_fields: validation.missing_fields ?? null,
      }),
      safe_next_step: syncMutationRequiredFieldsRepairHint(scope.project),
      requires_confirmation: true,
    }));
  }
  const evidence = mapEvidence({ pending_mutations_evaluated: mutations.length - terminal.length, corrupt_source_observations: sourceObservations.length, ...(terminal.length > 0 ? { terminal_mutations: terminal.length } : {}) });
  const rollUp = () => [...blocking, ...terminal];

  // Un atraso de proyectos no inscritos solo es un fallo si este equipo usa la nube.
  if (listEnrolledProjects(scope.store).length === 0) return resultFromFindings(code, evidence, rollUp());
  const scoped = normalizeProjectName(scope.project);
  for (const entry of countPendingNonEnrolledSyncMutations(scope.store, DEFAULT_SYNC_TARGET_KEY)) {
    const project = normalizeProjectName(entry.project);
    if (scoped !== '' && project !== scoped) continue;
    blocking.push(finding(code, {
      severity: SEVERITY.blocking,
      reason_code: REASON_NON_ENROLLED_PENDING_MUTATIONS,
      message: `Pending cloud sync mutations for project ${JSON.stringify(project)} are blocked because it is not enrolled.`,
      why: 'Cloud delivery cannot continue while pending mutations belong to a project that is not enrolled.',
      evidence: mapEvidence({ project, pending_mutations: entry.count }),
      safe_next_step: 'Run `odin cloud enroll <project>` for each intended project or review enrollment, then rerun `odin doctor`.',
      requires_confirmation: true,
    }));
  }
  return resultFromFindings(code, evidence, rollUp());
}

// ─── sync_target_closed_space ────────────────────────────────────────────────

export function safeNextStepForForeignSyncTarget(state) {
  if (state.unacked_mutations === 0) {
    return 'If the target belongs to a project you want synced, run `odin cloud enroll <project>`. Otherwise no action is required: the row is inert drift left by the removed derivation fallback, it cannot advance and no data is at risk, and a later cloud-inbox slice removes these legacy rows automatically.';
  }
  return `Review the ${state.unacked_mutations} unacknowledged mutation(s) recorded for this target before removing the row: they record writes that no configured pipeline will deliver. If the target belongs to a project you want synced, run \`odin cloud enroll <project>\` so delivery can resume; otherwise clear or re-ack the pending mutations through a supported repair workflow first.`;
}

function syncTargetClosedSpace(scope) {
  const code = CHECK.syncTargetClosedSpace;
  const states = listSyncStates(scope.store);
  const enrolled = listEnrolledProjects(scope.store);
  const closed = new Set([DEFAULT_SYNC_TARGET_KEY, SYNC_INBOX_TARGET_KEY, LOCAL_CHUNK_TARGET_KEY]);
  for (const project of enrolled) {
    const name = normalizeProjectName(project.project);
    if (name !== '') closed.add(cloudTargetKeyForProject(name));
  }
  const findings = [];
  for (const state of states) {
    if (closed.has(state.target_key)) continue;
    findings.push(finding(code, {
      severity: state.unacked_mutations === 0 ? SEVERITY.warning : SEVERITY.error,
      reason_code: REASON_FOREIGN_SYNC_TARGET,
      message: `Sync target ${JSON.stringify(state.target_key)} is outside the closed set of legitimate sync targets.`,
      why: 'A sync_state row for an unknown target records sync progress no configured delivery pipeline can ever advance, so its state can silently rot while appearing live.',
      evidence: mapEvidence({ target_key: state.target_key, lifecycle: state.lifecycle, unacked_mutations: state.unacked_mutations }),
      safe_next_step: safeNextStepForForeignSyncTarget(state),
      requires_confirmation: true,
    }));
  }
  return resultFromFindings(code, mapEvidence({ sync_targets_evaluated: states.length, enrolled_projects: enrolled.length }), findings);
}

// ─── invalid_session_identity ────────────────────────────────────────────────

function invalidSessionIdentity(scope) {
  const code = CHECK.invalidSessionIdentity;
  const evidence = listInvalidSessionIdentityEvidence(scope.store, scope.project);
  const quarantined = listQuarantinedPulledSessionEvidence(scope.store, scope.project);
  const findings = [];
  // Los hallazgos bloqueantes de origen van primero: el código del chequeo sale de findings[0].
  for (const item of evidence) {
    findings.push(finding(code, {
      severity: SEVERITY.blocking,
      reason_code: code,
      message: 'Session source ID is blank; affected references and journal entries cannot be repaired without an explicit canonical session ID.',
      why: 'A blank session ID is not accepted by cloud replication and re-emitting it would preserve corrupt identity data.',
      evidence: item,
      safe_next_step: 'Provide an explicit canonical session ID through a supported repair workflow; automatic ID generation is intentionally unavailable.',
      requires_confirmation: true,
    }));
  }
  for (const item of quarantined) {
    findings.push(finding(code, {
      severity: SEVERITY.warning,
      reason_code: REASON_QUARANTINED_PULLED_SESSION_IDENTITY,
      message: 'A pulled session mutation was skipped because its identity is blank or does not match its payload; the pull cursor advanced past it.',
      why: 'Halting the pull on a historical blank identity would pin the cursor forever, so the mutation is quarantined as evidence instead.',
      evidence: item,
      safe_next_step: 'Inspect the quarantined mutation with `odin conflicts deferred`; it can only be applied once the remote side publishes a canonical session ID.',
      requires_confirmation: true,
    }));
  }
  return resultFromFindings(code, mapEvidence({ invalid_source_sessions: evidence.length, quarantined_pulled_sessions: quarantined.length }), findings);
}

// ─── unowned_session_project ─────────────────────────────────────────────────

/**
 * Sesiones sin proyecto o con propiedad sin clasificar. Sin acotar por proyecto: una sesión sin
 * dueño no pertenece a ninguno y una consulta acotada nunca la devolvería.
 */
function unownedSessionProject(scope) {
  const code = CHECK.unownedSessionProject;
  const sessions = listDiagnosticSessions(scope.store, '');
  const findings = [];
  for (const session of sessions) {
    const mode = goTrim(session.ownership_mode);
    if (normalizeProjectName(session.project) !== '' && (mode === SESSION_OWNERSHIP_SHARED || mode === SESSION_OWNERSHIP_PROJECT_OWNED)) continue;
    findings.push(finding(code, {
      severity: SEVERITY.warning,
      reason_code: code,
      message: `Session ${JSON.stringify(session.id)} has unclassified or invalid ownership metadata.`,
      why: 'Legacy, blank, and invalid ownership metadata cannot safely establish a project-owned session, so an operator must classify it explicitly before relying on ownership enforcement.',
      evidence: mapEvidence({ session_id: session.id, session_project: session.project, ownership_mode: session.ownership_mode, directory: session.directory }),
      safe_next_step: `Assign ownership with \`${RESCUE_OWNERSHIP_COMMAND} --project <name> --session ${session.id}\` after confirming which project the session belongs to.`,
      requires_confirmation: true,
    }));
  }
  return resultFromFindings(code, mapEvidence({ sessions_evaluated: sessions.length }), findings);
}

// ─── orphaned_observation_session ────────────────────────────────────────────

function orphanedObservationSession(scope) {
  const code = CHECK.orphanedObservationSession;
  const evidence = listOrphanedObservationSessionEvidence(scope.store, scope.project);
  const findings = evidence.map((item) => finding(code, {
    severity: SEVERITY.warning,
    reason_code: code,
    message: `${item.observation_count} observation(s) reference missing session ${JSON.stringify(item.session_id)}.`,
    why: 'Observations reference a missing session, so their canonical session cannot be reconstructed automatically.',
    evidence: item,
    safe_next_step: 'Review the affected reference, then run `odin doctor repair --project <project> --check orphaned_observation_session --plan`; apply only after confirming the local placeholder session is appropriate.',
    requires_confirmation: true,
  }));
  return resultFromFindings(code, mapEvidence({ orphaned_session_references_evaluated: evidence.length }), findings);
}

// ─── orphaned_pending_relations ──────────────────────────────────────────────

/** Relaciones pendientes con ambos extremos ausentes; sin acotar por proyecto. */
function orphanedPendingRelations(scope) {
  const code = CHECK.orphanedPendingRelations;
  const evidence = listOrphanedPendingRelationEvidenceBounded(scope.store, ORPHANED_PENDING_RELATION_SAMPLE_LIMIT);
  const findings = [];
  if (evidence.candidate_count > 0) {
    findings.push(finding(code, {
      severity: SEVERITY.warning,
      reason_code: code,
      message: `${evidence.candidate_count} pending relation(s) reference missing observations on both endpoints and can never be judged.`,
      why: 'A pending relation without an active source or target observation shows no titles and no verdict can ever be recorded against it, so it only inflates the pending backlog; reclassifying it into the audited `orphaned` disposition preserves the row as history without fabricating a verdict.',
      evidence: mapEvidence({ candidate_count: evidence.candidate_count, one_endpoint_missing: evidence.one_endpoint_missing, live_pending: evidence.live_pending, sample: evidence.sample }),
      safe_next_step: 'Review the sample, then run `odin doctor repair --check orphaned_pending_relations --dry-run`; apply reclassifies only these rows into the audited `orphaned` disposition after creating a SQLite backup.',
      requires_confirmation: true,
    }));
  }
  return resultFromFindings(code, mapEvidence({ candidate_count: evidence.candidate_count, one_endpoint_missing: evidence.one_endpoint_missing, live_pending: evidence.live_pending }), findings);
}

// ─── sqlite_lock_contention ──────────────────────────────────────────────────

function sqliteLockContention(scope) {
  const code = CHECK.sqliteLockContention;
  let snapshot;
  try {
    snapshot = (scope.readSqliteLockSnapshot ?? readSqliteLockSnapshot)(scope.store);
  } catch (err) {
    return resultFromFindings(code, mapEvidence({ probe: 'failed' }), [finding(code, {
      severity: SEVERITY.error,
      reason_code: 'sqlite_lock_probe_failed',
      message: err.message,
      why: 'Doctor could not read SQLite lock state, so contention cannot be ruled out.',
      evidence: mapEvidence({ error: err.message }),
      safe_next_step: 'Close other odin processes and rerun `odin doctor --check sqlite_lock_contention`.',
      requires_confirmation: false,
    })]);
  }
  const findings = [];
  if (snapshot.checkpoint_busy > 0 || snapshot.busy_timeout_ms <= 0) {
    findings.push(finding(code, {
      severity: SEVERITY.warning,
      reason_code: 'sqlite_lock_contention_detected',
      message: 'SQLite lock probe reported contention indicators.',
      why: 'Lock contention can cause writes or sync enrollment to fail; doctor only reports the condition and does not repair it.',
      evidence: snapshot,
      safe_next_step: 'Stop other odin processes, wait for active operations to finish, then rerun `odin doctor --check sqlite_lock_contention`.',
      requires_confirmation: false,
    }));
  }
  return resultFromFindings(code, snapshot, findings);
}

/** Los diez chequeos, cada uno `{ code, run(scope) }`. */
export const DEFAULT_CHECKS = [
  [CHECK.sessionProjectDirectoryMismatch, sessionProjectDirectoryMismatch],
  [CHECK.manualSessionNameProjectMismatch, manualSessionNameProjectMismatch],
  [CHECK.invalidSessionIdentity, invalidSessionIdentity],
  [CHECK.orphanedObservationSession, orphanedObservationSession],
  [CHECK.orphanedPendingRelations, orphanedPendingRelations],
  [CHECK.unownedSessionProject, unownedSessionProject],
  [CHECK.ambiguousActiveRuntimeSessions, ambiguousActiveRuntimeSessions],
  [CHECK.syncMutationRequiredFields, syncMutationRequiredFields],
  [CHECK.syncTargetClosedSpace, syncTargetClosedSpace],
  [CHECK.sqliteLockContention, sqliteLockContention],
].map(([code, run]) => ({ code, run }));
