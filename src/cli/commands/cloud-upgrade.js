import { cloudSyncFailureMessage, markCloudSyncFailure } from '../../cloud/client.js';
import { resolveCloudRuntimeConfig, validateServerUrl } from '../../cloud/config.js';
import { REASON } from '../../cloud/constants.js';
import { RemoteTransport } from '../../cloud/remote.js';
import { normalizeProject } from '../../project/canonical.js';
import { Syncer } from '../../sync/index.js';
import {
  REPAIR_CLASS, UPGRADE_REASON, UPGRADE_STAGE, canRollbackUpgrade, captureUpgradeSnapshot, diagnoseLegacyMutations, readUpgradeState, remirrorProject, repairUpgrade, rollbackUpgrade, saveUpgradeState,
} from '../../store/cloud-upgrade.js';
import { enrollProject } from '../../store/enrollment.js';
import { cloudTargetKeyForProject, getSyncState, isProjectEnrolled } from '../../store/sync-state.js';
import { goTrim } from '../../store/text.js';
import { CliExit, fatal, println } from '../runtime.js';

const COMMANDS = 'doctor, repair, bootstrap, remirror, status, rollback';
const STAGE_ORDER = new Map([[UPGRADE_STAGE.bootstrapEnrolled, 1], [UPGRADE_STAGE.bootstrapPushed, 2], [UPGRADE_STAGE.bootstrapVerified, 3]]);
const order = (stage) => STAGE_ORDER.get(goTrim(stage)) ?? 0;

/** Diagnóstico previo (`doctor`): el motivo por el que el proyecto no está listo, o que lo está. */
function diagnose({ project, cloudConfigured, enrolled, policyDenied }) {
  if (policyDenied) return { status: 'blocked', class: REPAIR_CLASS.policy, code: REASON.policyForbidden, message: `project ${JSON.stringify(project)} is blocked by organization policy` };
  if (!cloudConfigured) return { status: 'blocked', class: REPAIR_CLASS.policy, code: REASON.cloudConfigError, message: 'cloud configuration is required before upgrade bootstrap' };
  if (!enrolled) return { status: 'blocked', class: REPAIR_CLASS.repairable, code: 'upgrade_repairable_unenrolled', message: `project ${JSON.stringify(project)} is not enrolled for cloud sync yet` };
  return { status: 'ready', class: REPAIR_CLASS.ready, code: 'upgrade_ready', message: `project ${JSON.stringify(project)} is ready for cloud bootstrap` };
}

/** El valor de `--project`, normalizado; vacío si falta. */
function projectArg(args) {
  const at = args.findIndex((a) => goTrim(a) === '--project');
  if (at < 0 || at + 1 >= args.length) return '';
  return goTrim(normalizeProject(args[at + 1]).normalized);
}

function requireProject(cli, usage) {
  const project = projectArg(cli.args.slice(3));
  if (project === '') {
    cli.err(`${usage}\nerror: --project is required\n`);
    throw new CliExit(1);
  }
  return project;
}

/** Configuración de la nube ya validada, o termina con el error de la orden. */
function requireCloud(cli, config, command) {
  const runtime = resolveCloudRuntimeConfig(config.dataDir, cli.env);
  if (goTrim(runtime.server_url) === '') return fatal(cli, new Error(`cloud upgrade ${command} requires configured cloud server`));
  try {
    return { ...runtime, server_url: validateServerUrl(runtime.server_url) };
  } catch (err) {
    return fatal(cli, new Error(`invalid cloud runtime server URL: ${err.message}`));
  }
}

function cloudSyncer(cli, store, project, runtime) {
  const transport = new RemoteTransport(runtime.server_url, runtime.token, project, cli.fetch ? { fetch: cli.fetch } : {});
  return new Syncer(store, { transport, project, targetKey: cloudTargetKeyForProject(project), log: (m) => cli.err(`${m}\n`), cloudMode: true });
}

async function doctor(cli, config, store) {
  const project = requireProject(cli, 'usage: odin cloud upgrade doctor --project <name>');
  let cloudConfigured = false;
  try {
    cloudConfigured = goTrim(validateServerUrl(resolveCloudRuntimeConfig(config.dataDir, cli.env).server_url)) !== '';
  } catch {
    cloudConfigured = false;
  }
  const state = getSyncState(store, cloudTargetKeyForProject(project));
  let report = diagnose({ project, cloudConfigured, enrolled: isProjectEnrolled(store, project), policyDenied: goTrim(state?.reason_code ?? '') === REASON.policyForbidden });
  const legacy = diagnoseLegacyMutations(store, project);
  if (legacy.blocked_count > 0) {
    const first = legacy.findings[0];
    report = { status: 'blocked', class: REPAIR_CLASS.blocked, code: UPGRADE_REASON.blockedLegacyManual, message: `manual-action-required: ${first.message} (seq=${first.seq} entity=${first.entity} op=${first.op})` };
  } else if (legacy.repairable_count > 0) {
    report = { status: 'blocked', class: REPAIR_CLASS.repairable, code: UPGRADE_REASON.repairableLegacyPayload, message: `project ${JSON.stringify(project)} has ${legacy.repairable_count} repairable legacy mutation payload issue(s); run \`odin cloud upgrade repair --project ${project} --apply\`` };
  }
  try {
    saveUpgradeState(store, {
      project, stage: report.status === 'ready' ? UPGRADE_STAGE.doctorReady : UPGRADE_STAGE.doctorBlocked, repair_class: report.class, last_error_code: report.code, last_error_message: report.message,
    });
  } catch {
    // El diagnóstico se muestra aunque no se pueda anotar.
  }
  println(cli, `project: ${project}`);
  println(cli, `status: ${report.status}`);
  println(cli, `class: ${report.class}`);
  println(cli, `reason_code: ${report.code}`);
  println(cli, `message: ${report.message}`);
}

function repair(cli, store) {
  const project = requireProject(cli, 'usage: odin cloud upgrade repair --project <name> [--dry-run|--apply]');
  const report = repairUpgrade(store, project, cli.args.slice(3).some((a) => goTrim(a) === '--apply'));
  println(cli, `project: ${project}`);
  println(cli, `class: ${report.class}`);
  println(cli, `reason_code: ${report.reason_code}`);
  println(cli, `message: ${report.message}`);
  println(cli, `applied: ${report.applied}`);
}

async function bootstrapProject(cli, store, project, runtime) {
  const { state } = captureUpgradeSnapshot(store, project);
  let stage = state?.stage ?? UPGRADE_STAGE.planned;
  if (stage === UPGRADE_STAGE.bootstrapVerified) return { project, stage, resumed: true, noop: true };
  const resumed = stage !== UPGRADE_STAGE.planned;
  const save = (next, repairClass) => saveUpgradeState(store, { project, stage: next, repair_class: repairClass });

  if (order(stage) < order(UPGRADE_STAGE.bootstrapEnrolled)) {
    enrollProject(store, project);
    save(UPGRADE_STAGE.bootstrapEnrolled, REPAIR_CLASS.repairable);
    stage = UPGRADE_STAGE.bootstrapEnrolled;
  }
  const syncer = cloudSyncer(cli, store, project, runtime);
  if (!isProjectEnrolled(store, project)) enrollProject(store, project);
  if (order(stage) < order(UPGRADE_STAGE.bootstrapPushed)) {
    try {
      await syncer.export('odin-cloud-upgrade', project);
    } catch (err) {
      throw new Error(`bootstrap first push: ${err.message}`, { cause: err });
    }
    save(UPGRADE_STAGE.bootstrapPushed, REPAIR_CLASS.repairable);
    stage = UPGRADE_STAGE.bootstrapPushed;
  }
  if (order(stage) < order(UPGRADE_STAGE.bootstrapVerified)) {
    try {
      await syncer.import();
    } catch (err) {
      throw new Error(`bootstrap verification pull: ${err.message}`, { cause: err });
    }
    try {
      await syncer.status();
    } catch (err) {
      throw new Error(`bootstrap verification status: ${err.message}`, { cause: err });
    }
    save(UPGRADE_STAGE.bootstrapVerified, REPAIR_CLASS.ready);
    stage = UPGRADE_STAGE.bootstrapVerified;
  }
  return { project, stage, resumed, noop: false };
}

async function bootstrap(cli, config, store) {
  const project = requireProject(cli, 'usage: odin cloud upgrade bootstrap --project <name> [--resume]');
  const runtime = requireCloud(cli, config, 'bootstrap');
  let snapshot;
  try {
    snapshot = captureUpgradeSnapshot(store, project);
  } catch (err) {
    return fatal(cli, err);
  }
  const legacy = diagnoseLegacyMutations(store, snapshot.project);
  if (legacy.blocked_count > 0) {
    const first = legacy.findings[0];
    return fatal(cli, new Error(`legacy mutation payloads require manual action before bootstrap (seq=${first.seq} entity=${first.entity} op=${first.op}): ${first.message}`));
  }
  if (legacy.repairable_count > 0) return fatal(cli, new Error(`legacy mutation payloads require repair before bootstrap: run \`odin cloud upgrade repair --project ${snapshot.project} --apply\``));
  let result;
  try {
    result = await bootstrapProject(cli, store, snapshot.project, runtime);
  } catch (err) {
    return fatal(cli, new Error(cloudSyncFailureMessage(snapshot.project, err)));
  }
  println(cli, `project: ${result.project}`);
  println(cli, `stage: ${result.stage}`);
  println(cli, `resumed: ${result.resumed}`);
  println(cli, `noop: ${result.noop}`);
  return undefined;
}

async function remirror(cli, config, store) {
  const project = requireProject(cli, 'usage: odin cloud upgrade remirror --project <name>');
  const runtime = requireCloud(cli, config, 'remirror');
  let result;
  try {
    const syncer = cloudSyncer(cli, store, project, runtime);
    remirrorProject(store, project);
    result = await syncer.export('odin-cloud-remirror', project);
  } catch (err) {
    markCloudSyncFailure(store, cloudTargetKeyForProject(project), err);
    return fatal(cli, new Error(`cloud remirror: ${err.message}`));
  }
  println(cli, `project: ${project}`);
  println(cli, `chunks_exported: ${result.chunks_exported ?? 0}`);
  println(cli, `mutations_exported: ${result.mutations_exported ?? 0}`);
  return undefined;
}

function status(cli, store) {
  const project = requireProject(cli, 'usage: odin cloud upgrade status --project <name>');
  const state = readUpgradeState(store, project);
  println(cli, `project: ${project}`);
  println(cli, `stage: ${state?.stage ?? UPGRADE_STAGE.planned}`);
  if (state === null) return;
  println(cli, `class: ${state.repair_class}`);
  println(cli, `reason_code: ${goTrim(state.last_error_code)}`);
  println(cli, `reason_message: ${goTrim(state.last_error_message)}`);
}

function rollback(cli, store) {
  const project = requireProject(cli, 'usage: odin cloud upgrade rollback --project <name>');
  const state = readUpgradeState(store, project);
  if (state === null) return fatal(cli, new Error('rollback requires existing upgrade checkpoint state'));
  if (!canRollbackUpgrade(store, project)) {
    cli.err('rollback is unavailable post-bootstrap; use explicit disconnect/unenroll flows\n');
    throw new CliExit(1);
  }
  let rolledBack;
  try {
    rolledBack = rollbackUpgrade(store, project);
  } catch (err) {
    return fatal(cli, err);
  }
  println(cli, `project: ${project}`);
  println(cli, `stage: ${rolledBack.stage}`);
  return undefined;
}

/** `odin cloud upgrade <doctor|repair|bootstrap|remirror|status|rollback> --project <name>`. */
export async function cmdCloudUpgrade(cli, config) {
  const command = goTrim(cli.args[2] ?? '').toLowerCase();
  if (cli.args.length < 3) {
    cli.err(`usage: odin cloud upgrade <${COMMANDS.split(', ').join('|')}> --project <name>\n`);
    throw new CliExit(1);
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    println(cli, 'odin cloud upgrade');
    println(cli, 'workflow: doctor -> repair -> bootstrap -> status/rollback');
    println(cli, 'recovery: use remirror only to rebuild cloud state from authoritative local data');
    println(cli, 'cloud is opt-in replication/shared access; local SQLite remains source of truth');
    println(cli, `usage: odin cloud upgrade <${COMMANDS.split(', ').join('|')}> --project <name>`);
    return undefined;
  }
  if (!COMMANDS.split(', ').includes(command)) {
    cli.err(`unknown cloud upgrade command: ${command}\nsupported cloud upgrade commands: ${COMMANDS}\n`);
    throw new CliExit(1);
  }
  let store;
  try {
    store = cli.openStore(config);
  } catch (err) {
    return fatal(cli, err);
  }
  try {
    switch (command) {
      case 'doctor': return await doctor(cli, config, store);
      case 'repair': return repair(cli, store);
      case 'bootstrap': return await bootstrap(cli, config, store);
      case 'remirror': return await remirror(cli, config, store);
      case 'status': return status(cli, store);
      default: return rollback(cli, store);
    }
  } catch (err) {
    if (err instanceof CliExit) throw err;
    return fatal(cli, err);
  } finally {
    store.close();
  }
}
