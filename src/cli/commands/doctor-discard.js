import { toGoJson } from '../../store/backup.js';
import { DiscardBlocker, applyLegacyEmptyPromptDiscard, planLegacyEmptyPromptDiscard } from '../../store/prompt-discard.js';
import { goTrim } from '../../store/text.js';
import { exit } from '../runtime.js';
import { resolveCliProject } from '../project.js';

export const DISCARD_PROMPT_USAGE = 'usage: odin doctor discard-empty-prompt --project PROJECT --seq SEQ [--dry-run|--apply --backup PATH] [--json]';

function writeReport(cli, report, jsonOut) {
  if (jsonOut) {
    cli.out(`${toGoJson(report)}\n`);
    return;
  }
  const list = (values) => `[${(values ?? []).join(' ')}]`;
  cli.out(`status: ${report.status}\nproject: ${report.project}\nselected_seq: ${report.selected_seq}\nprompt_id: ${report.prompt_id}\nsync_id: ${report.sync_id}\nsession_id: ${report.session_id}\nsource_inbox_id: ${report.source_inbox_id}\nsequences: ${list(report.sequences)}\nplanned_effects: ${list(report.planned_effects)}\ntombstone: ${report.tombstone}\ndelete_queued: ${report.delete_queued}\ndelete_seq: ${report.delete_seq}\n`);
  if (report.backup_path !== '') cli.out(`backup_path: ${report.backup_path} (${report.backup_path_meaning})\n`);
  if (report.blocker) cli.out(`blocker: ${report.blocker.code}: ${report.blocker.detail}\n`);
  cli.out('NO REMOTE CONFIRMATION: older in-flight sends or other devices may write afterward.\n');
}

/**
 * `odin doctor discard-empty-prompt --project P --seq N [--dry-run | --apply --backup PATH] [--json]`.
 * @param {import('../runtime.js').Cli} cli
 */
export function cmdDoctorDiscardEmptyPrompt(cli, config) {
  const args = cli.args.slice(2);
  const jsonOut = args.includes('--json');
  const report = {
    status: 'error', project: '', selected_seq: 0, prompt_id: 0, sync_id: '', session_id: '', source_inbox_id: '', sequences: null, planned_effects: null, tombstone: false, delete_queued: false,
    delete_seq: 0, backup_path: '',
  };
  const emit = (err) => {
    if (err) {
      report.blocker = { code: 'command_error', detail: err.message };
      if (err instanceof DiscardBlocker) {
        report.blocker = { code: err.code, detail: err.detail };
        report.status = 'blocked';
      }
    }
    const ordered = { ...report };
    const { backup_path_meaning: meaning, blocker, ...rest } = ordered;
    writeReport(cli, { ...rest, backup_path: report.backup_path, ...(meaning ? { backup_path_meaning: meaning } : {}), remote_confirmation: false, ...(blocker ? { blocker } : {}) }, jsonOut);
    if (err) exit(1);
  };
  const seen = new Set();
  let project = '';
  let seqText = '';
  let backup = '';
  let apply = false;
  let dry = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      cli.out(`${DISCARD_PROMPT_USAGE}\n`);
      return undefined;
    }
    if (seen.has(arg)) return emit(new Error(`duplicate argument ${JSON.stringify(arg)}`));
    seen.add(arg);
    if (arg === '--json') continue;
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dry = true;
    else if (arg === '--project' || arg === '--seq' || arg === '--backup') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) return emit(new Error(`${arg} requires a value`));
      i++;
      if (arg === '--project') project = args[i];
      else if (arg === '--seq') seqText = args[i];
      else backup = args[i];
    } else {
      return emit(new Error(`unknown argument ${JSON.stringify(arg)}`));
    }
  }
  report.project = project;
  const valid = /^[+-]?\d+$/.test(seqText) && BigInt(seqText) >= -(2n ** 63n) && BigInt(seqText) < 2n ** 63n;
  const seq = valid ? Number(seqText) : 0;
  report.selected_seq = seq;
  if (goTrim(project) === '' || !valid || seq <= 0) return emit(new Error('explicit project and positive int64 --seq required'));
  if (apply && dry) return emit(new Error('--apply and --dry-run are mutually exclusive'));
  if ((apply && goTrim(backup) === '') || (!apply && seen.has('--backup'))) return emit(new Error('--backup is required with --apply and forbidden without it'));

  let store;
  try {
    store = cli.openStore(config);
  } catch (err) {
    return emit(err);
  }
  try {
    let resolved;
    try {
      resolved = resolveCliProject(cli, store, project, false);
    } catch (err) {
      return emit(err);
    }
    report.project = resolved;
    let plan;
    try {
      plan = planLegacyEmptyPromptDiscard(store, resolved, seq);
    } catch (err) {
      const partial = err.plan ?? {};
      Object.assign(report, { prompt_id: partial.prompt_id ?? 0, sync_id: partial.sync_id ?? '', session_id: partial.session_id ?? '', source_inbox_id: partial.source_inbox_id ?? '', sequences: partial.sequences ?? null });
      return emit(err);
    }
    Object.assign(report, { prompt_id: plan.prompt_id, sync_id: plan.sync_id, session_id: plan.session_id, source_inbox_id: plan.source_inbox_id, sequences: plan.sequences });
    report.planned_effects = ['supersede_exact_blank_upserts', 'create_prompt_tombstone', 'delete_canonical_prompt_and_fts', 'enqueue_one_prompt_delete'];
    report.status = 'dry_run';
    if (apply) {
      let result;
      try {
        result = applyLegacyEmptyPromptDiscard(store, plan, backup);
      } catch (err) {
        report.backup_path = err.result?.backup_path ?? '';
        report.status = 'error';
        if (report.backup_path !== '') report.backup_path_meaning = 'INTENDED destination; may contain a backup or empty reservation; not proof of a valid backup';
        return emit(err);
      }
      report.backup_path = result.backup_path;
      Object.assign(report, { status: result.status, sequences: result.sequences, delete_seq: result.delete_seq, tombstone: true, delete_queued: true, backup_path_meaning: 'successful backup' });
    }
    return emit(null);
  } finally {
    store.close();
  }
}
