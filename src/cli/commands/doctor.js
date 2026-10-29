import { isAbsolute } from 'node:path';
import { staleMcpCommands } from '../../setup/install.js';
import { Runner, InvalidCheckError, errorReport, registeredCodes } from '../../diagnostic/index.js';
import { REPAIRABLE_CODES } from '../../diagnostic/repair-codes.js';
import { toGoJson } from '../../store/backup.js';
import { goTrim } from '../../store/text.js';
import { resolveCliProject } from '../project.js';
import { exit, fatal, println, withStore } from '../runtime.js';
import { cmdDoctorDiscardEmptyPrompt, DISCARD_PROMPT_USAGE } from './doctor-discard.js';
import { cmdDoctorRepair } from './doctor-repair.js';

export { DISCARD_PROMPT_USAGE };


/** Chequeos registrados que no tienen reparación. */
export const diagnosticOnlyCheckCodes = () => registeredCodes().filter((code) => !REPAIRABLE_CODES.includes(code));

export function printDoctorUsage(cli) {
  println(cli, 'note: project mismatch evidence includes local aliases; repair rereads aliases to veto contradictory moves.');
  println(cli, DISCARD_PROMPT_USAGE);
  println(cli, 'usage: odin doctor [--json] [--project PROJECT] [--check CODE]');
  println(cli, '       odin doctor repair --project PROJECT --check CODE (--plan|--dry-run|--apply)');
  println(cli, '       odin doctor repair [--project PROJECT] --check sync_mutation_required_fields [--plan|--dry-run|--apply] (default: --dry-run)');
  println(cli, '       odin doctor repair --project PROJECT --check invalid_session_identity --replacement-id ID [--source-id SOURCE] (--plan|--dry-run|--apply)');
  println(cli, 'note: --project is required for every repair check except sync_mutation_required_fields, where it optionally scopes title repair, supersession, quarantine, and source-title repair, and orphaned_pending_relations, which spans all projects because both-endpoints-absent relations belong to no project.');
  println(cli, 'note: source_unrepairable lists source fields requiring manual investigation; repair cannot reconstruct missing type or content.');
  println(cli, `checks: ${registeredCodes().join(', ')}`);
  println(cli, `diagnostic-only checks with no repair: ${diagnosticOnlyCheckCodes().join(', ')}`);
}

export function printDoctorRepairUsage(cli) {
  println(cli, 'note: project aliases veto contradictory reclassification; aliases never authorize historical moves.');
  println(cli, 'usage: odin doctor repair --project PROJECT --check CODE (--plan|--dry-run|--apply)');
  println(cli, '       odin doctor repair [--project PROJECT] --check sync_mutation_required_fields [--plan|--dry-run|--apply] (default: --dry-run)');
  println(cli, '       odin doctor repair --project PROJECT --check invalid_session_identity --replacement-id ID [--source-id SOURCE] (--plan|--dry-run|--apply)');
  println(cli, 'note: --project is required for every repair check except sync_mutation_required_fields, where it optionally scopes title repair, supersession, quarantine, and source-title repair, and orphaned_pending_relations, which spans all projects because both-endpoints-absent relations belong to no project.');
  println(cli, 'note: source_unrepairable lists source fields requiring manual investigation; repair cannot reconstruct missing type or content.');
  println(cli, `repairable checks: ${[...REPAIRABLE_CODES].sort().join(', ')}`);
  println(cli, `diagnostic-only checks with no repair: ${diagnosticOnlyCheckCodes().join(', ')}`);
}

/** Añade el chequeo de registros MCP obsoletos al informe completo. */
function addStaleMcpCheck(cli, report) {
  let stale;
  try {
    stale = cli.staleMcpCommands ? cli.staleMcpCommands() : staleMcpCommands({ env: cli.env, home: cli.home, platform: process.platform, isAbsolutePath: isAbsolute });
  } catch (err) {
    report.checks.push({
      check_id: 'mcp_inspection_error', result: 'error', severity: 'error', reason_code: 'mcp_inspection_error',
      message: `Could not inspect generic MCP registrations: ${err.message}`,
      why: 'Client configuration could not be read safely.', evidence: null, safe_next_step: 'Review the client configuration and rerun odin doctor.', requires_confirmation: false,
    });
    report.summary.total += 1;
    report.summary.errors += 1;
    report.status = 'error';
    return;
  }
  if (stale.length === 0) return;
  const findings = stale.map((item) => ({
    check_id: 'stale_mcp_command', severity: 'warning', reason_code: 'stale_mcp_command', message: `${item.slug} odin MCP executable path is missing`,
    why: 'The configured absolute command no longer exists.', evidence: item, safe_next_step: `odin setup ${item.slug}`, requires_confirmation: false,
  }));
  report.checks.push({
    check_id: 'stale_mcp_command', result: 'warning', severity: 'warning', reason_code: 'stale_mcp_command', message: 'Generic MCP registrations reference missing odin binaries.',
    why: 'A configured absolute command no longer exists.', evidence: null, safe_next_step: 'Run odin setup <slug> for each affected client.', requires_confirmation: false, findings,
  });
  report.summary.total += 1;
  report.summary.warnings += 1;
  if (report.status === 'ok') report.status = 'warning';
}

export function renderDoctorText(cli, report) {
  println(cli, `Odin Doctor: ${report.status}`);
  if (report.project) println(cli, `Project: ${report.project}`);
  println(cli, `Checks: ${report.summary.total} ok=${report.summary.ok} warnings=${report.summary.warnings} blocked=${report.summary.blocked} errors=${report.summary.errors}`);
  println(cli);
  for (const check of report.checks) {
    println(cli, `[${check.result}] ${check.check_id} — ${check.message}`);
    if (check.why) println(cli, `  why: ${check.why}`);
    if (check.safe_next_step) println(cli, `  next: ${check.safe_next_step}`);
    for (const f of check.findings ?? []) {
      println(cli, `  - ${f.reason_code}: ${f.message}`);
      if (f.safe_next_step) println(cli, `    next: ${f.safe_next_step}`);
      if (f.evidence !== undefined && f.evidence !== null) println(cli, `    evidence: ${toGoJson(f.evidence)}`);
    }
  }
}

/** Un informe como lo emite el comando: JSON con sangría de dos espacios. */
export const doctorJson = (value) => toGoJson(value, 2);

/**
 * `odin doctor [--json] [--project P] [--check CODE]`: diagnósticos operativos de solo lectura.
 * `doctor repair` lo atiende `doctor-repair.js`; `doctor discard-empty-prompt` llega con la nube.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdDoctor(cli, config) {
  const args = cli.args.slice(1);
  if (args[0] === 'repair') return cmdDoctorRepair(cli, config);
  if (args[0] === 'discard-empty-prompt') return cmdDoctorDiscardEmptyPrompt(cli, config);
  let jsonOut = false;
  let project = '';
  let check = '';
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--json': jsonOut = true; break;
      case '--project':
        if (i + 1 >= args.length) {
          cli.err('error: --project requires a value\n');
          return exit(1);
        }
        project = args[++i];
        break;
      case '--check':
        if (i + 1 >= args.length) {
          cli.err('error: --check requires a value\n');
          return exit(1);
        }
        check = args[++i];
        break;
      case '--help': case '-h': case 'help':
        return printDoctorUsage(cli);
      default:
        cli.err(`error: unknown doctor argument ${JSON.stringify(args[i])}\n`);
        printDoctorUsage(cli);
        return exit(1);
    }
  }
  return withStore(cli, config, (store) => {
    if (goTrim(project) !== '') {
      // Doctor puede inspeccionar un proyecto con sincronización pendiente que aún no tiene observaciones.
      try {
        project = resolveCliProject(cli, store, project, false);
      } catch (err) {
        return fatal(cli, err);
      }
    }
    project = goTrim(project);
    check = goTrim(check);
    const scope = { store, project, ...cli.doctorScope };
    let report;
    try {
      const runner = new Runner();
      report = check === '' ? runner.runAll(scope) : runner.runOne(scope, check);
    } catch (err) {
      report = errorReport(project, err);
      if (jsonOut) cli.out(`${doctorJson(report)}\n`);
      else cli.err(`odin doctor failed: ${err.message}\n`);
      if (err instanceof InvalidCheckError) return exit(1);
      return undefined;
    }
    if (project === '' && check === '') addStaleMcpCheck(cli, report);
    if (jsonOut) {
      cli.out(`${doctorJson(report)}\n`);
      return undefined;
    }
    renderDoctorText(cli, report);
    return undefined;
  });
}
