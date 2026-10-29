import { Runner, registeredCodes } from '../../diagnostic/index.js';
import { CLOUD_JOURNAL_REPAIRS, REPAIR_MODE, buildRepairPlan, planJson } from '../../diagnostic/repair.js';
import { CHECK } from '../../diagnostic/checks.js';
import { isRepairableCode } from '../../diagnostic/repair-codes.js';
import { normalizeProject } from '../../project/canonical.js';
import { toGoJson } from '../../store/backup.js';
import {
  applySessionProjectReclassification, estimateSessionProjectReclassification, reclassifyOrphanedPendingRelations, restoreOrphanedObservationSessions,
} from '../../store/repair.js';
import { applySessionIdentityRepair, planSessionIdentityReplacement } from '../../store/session-identity-repair.js';
import { cleanupForeignSyncTargets, repairSyncMutationRequiredFields } from '../../store/journal-repair.js';
import { goTrim } from '../../store/text.js';
import { exit, withStore } from '../runtime.js';
import { printDoctorRepairUsage } from './doctor.js';

function fail(cli, message) {
  cli.err(`odin doctor repair failed: ${message}\n`);
  printDoctorRepairUsage(cli);
  return exit(1);
}

const print = (cli, value) => cli.out(`${toGoJson(value, 2)}\n`);

/**
 * `odin doctor repair --project P --check CODE (--plan|--dry-run|--apply)`. Solo `--apply` escribe,
 * siempre tras una copia de la base. Las reparaciones que reescriben el diario de la nube
 * (`sync_mutation_required_fields`, `sync_target_closed_space` y la sustitución de identidad de
 * `invalid_session_identity`) llegan con la nube.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdDoctorRepair(cli, config) {
  const args = cli.args.slice(2);
  let project = '';
  let check = '';
  let mode = '';
  let modeCount = 0;
  let replacementSelected = false;
  let sourceSelected = false;
  let replacementId = '';
  let sourceId = '';
  let identityFlags = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--replacement-id': case '--source-id':
        if (i + 1 >= args.length) return fail(cli, `${args[i]} requires a value`);
        identityFlags = true;
        if (args[i] === '--replacement-id') {
          replacementSelected = true;
          replacementId = args[i + 1];
        } else {
          sourceSelected = true;
          sourceId = args[i + 1];
        }
        i++;
        break;
      case '--project':
        if (i + 1 >= args.length) return fail(cli, '--project requires a value');
        project = args[++i];
        break;
      case '--check':
        if (i + 1 >= args.length) return fail(cli, '--check requires a value');
        check = args[++i];
        break;
      case '--plan': mode = REPAIR_MODE.plan; modeCount++; break;
      case '--dry-run': mode = REPAIR_MODE.dryRun; modeCount++; break;
      case '--apply': mode = REPAIR_MODE.apply; modeCount++; break;
      case '--help': case '-h': case 'help':
        return printDoctorRepairUsage(cli);
      default:
        return fail(cli, `unknown doctor repair argument ${JSON.stringify(args[i])}`);
    }
  }
  project = goTrim(normalizeProject(project).normalized);
  check = goTrim(check);
  if (project === '' && check !== CHECK.syncMutationRequiredFields && check !== CHECK.orphanedPendingRelations) return fail(cli, '--project is required');
  if (check === '') return fail(cli, '--check is required');
  if (modeCount === 0 && check === CHECK.syncMutationRequiredFields) mode = REPAIR_MODE.dryRun;
  else if (modeCount !== 1) return fail(cli, 'exactly one of --plan, --dry-run, or --apply is required');
  if (identityFlags && check !== CHECK.invalidSessionIdentity) return fail(cli, 'identity flags require --check invalid_session_identity');
  if (sourceSelected && !replacementSelected) return fail(cli, '--source-id requires --replacement-id');
  if (!isRepairableCode(check)) {
    if (registeredCodes().includes(check)) return fail(cli, `${check} is a diagnostic-only check with no repair; run odin doctor --check ${check}`);
    return fail(cli, `unsupported repair check ${check}`);
  }
  if (CLOUD_JOURNAL_REPAIRS.includes(check) && check !== CHECK.syncMutationRequiredFields && check !== CHECK.syncTargetClosedSpace && check !== CHECK.invalidSessionIdentity) {
    return fail(cli, `${check} repair rewrites the cloud sync journal, which is not available in this build`);
  }

  return withStore(cli, config, (store) => {
    if (check === CHECK.syncMutationRequiredFields) {
      let result;
      try {
        result = repairSyncMutationRequiredFields(store, project, mode);
      } catch (err) {
        return fail(cli, err.message);
      }
      return print(cli, {
        ...result.quarantine, directory_repairs: result.directory_repairs, repairs: result.repairs, superseded: result.superseded, source_repairs: result.source_repairs,
        ...(result.source_repair_backup_path ? { source_repair_backup_path: result.source_repair_backup_path } : {}), source_unrepairable: result.source_unrepairable,
      });
    }
    let report;
    try {
      report = new Runner().runOne({ store, project }, check);
    } catch (err) {
      return fail(cli, err.message);
    }
    let plan;
    try {
      plan = buildRepairPlan({ store, project, ...cli.doctorScope }, report, check, mode);
    } catch (err) {
      return fail(cli, err.message);
    }
    const apply = mode === REPAIR_MODE.apply;
    if (check === CHECK.invalidSessionIdentity && replacementSelected) {
      plan = planSessionIdentityReplacement(store, report, plan, sourceId, sourceSelected, replacementId);
      if (plan.status === 'blocked') return print(cli, planJson(plan));
      try {
        if (apply) {
          const result = applySessionIdentityRepair(store, plan.identity_repair);
          plan.status = plan.skipped.length > 0 ? 'partial' : 'applied';
          plan.backup_path = result.backup_path;
          plan.counts.sessions_applied = 1;
          plan.counts.observations_applied = plan.identity_repair.observations;
          plan.counts.prompts_applied = plan.identity_repair.prompts;
          plan.counts.corrected_mutations_applied = result.published_mutations;
        } else {
          plan.status = mode === REPAIR_MODE.plan ? 'planned' : 'dry_run';
        }
      } catch (err) {
        return fail(cli, err.message);
      }
      return print(cli, planJson(plan));
    }
    try {
      if (check === CHECK.orphanedObservationSession) {
        plan.counts.sessions_planned = plan.placeholder_sessions.length;
        for (const p of plan.placeholder_sessions) plan.counts.observations_planned += p.observation_count;
        if (apply && plan.placeholder_sessions.length > 0) {
          const applied = restoreOrphanedObservationSessions(store, plan.placeholder_sessions);
          plan.status = applied.length > 0 ? 'applied' : 'noop';
          for (const a of applied) {
            plan.counts.sessions_applied += 1;
            plan.counts.observations_applied += a.observation_count;
          }
        }
      } else if (check === CHECK.orphanedPendingRelations) {
        // Las relaciones sin ambos extremos no pertenecen a ningún proyecto: cualquier --project se acepta pero no las acota.
        if (apply && plan.orphaned_pending_relations?.candidates.length > 0) {
          const result = reclassifyOrphanedPendingRelations(store);
          plan.status = result.reclassified > 0 ? 'applied' : 'noop';
          plan.counts.relations_applied = result.reclassified;
          plan.backup_path = result.backup_path;
        }
      } else if (check === CHECK.syncTargetClosedSpace) {
        const cleanup = cleanupForeignSyncTargets(store, apply);
        plan.target_actions = cleanup.actions;
        if (apply && cleanup.actions.length > 0) plan.status = 'applied';
        for (const action of cleanup.actions) {
          if (action.retained_mutations > 0 && apply) plan.status = cleanup.applied ? 'partial' : 'blocked';
        }
      } else if (check !== CHECK.invalidSessionIdentity) {
        const moves = plan.actions.map((a) => ({ session_id: a.session_id, from_project: a.from_project, to_project: a.to_project }));
        const estimate = estimateSessionProjectReclassification(store, moves);
        plan.counts.sessions_planned = estimate.sessions;
        plan.counts.observations_planned = estimate.observations;
        plan.counts.prompts_planned = estimate.prompts;
        if (apply && moves.length > 0) {
          const result = applySessionProjectReclassification(store, moves);
          plan.status = 'applied';
          plan.backup_path = result.backup_path;
          plan.counts.sessions_applied = result.counts.sessions;
          plan.counts.observations_applied = result.counts.observations;
          plan.counts.prompts_applied = result.counts.prompts;
        }
      }
    } catch (err) {
      return fail(cli, err.message);
    }
    print(cli, planJson(plan));
    return undefined;
  });
}
