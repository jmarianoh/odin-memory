import { estimateScanCost, buildStorePrompt, resolveAgentRunner } from '../../llm/index.js';
import {
  DEFAULT_DEAD_ROW_MAX_AGE_DAYS, DEFAULT_DEAD_ROW_MAX_PER_SCOPE, DEFAULT_SCAN_LIMIT, countRelations, getActionableRelationStats, getDeferred,
  getRelationByIntId, listDeferred, listRelations, pruneDeadRows, replayDeferred, scanAllProjects, scanProject,
} from '../../store/index.js';
import { resolveCliProjectScope } from '../project.js';
import { CliExit, fatal, padRight, parseInt64, println, truncate, withStore } from '../runtime.js';

const USAGE_LINES = [
  'usage: odin conflicts <subcommand> [options]',
  'subcommands: list, show, stats, scan, deferred, prune',
  '',
  '  list       [--project P|--all]  [--status S]  [--since RFC3339]  [--limit N]',
  '  show       <relation_id>',
  '  stats      [--project P|--all]',
  '             list/stats omit known cross-project pending pairs; show retains evidence.',
  '  scan       [--project P|--all]  [--since RFC3339]  [--limit N]  [--cursor ID]  [--dry-run]  [--apply]  [--max-insert N]',
  '             [--semantic]  [--concurrency N]  [--timeout-per-call SECONDS]',
  '             [--max-semantic N]  [--yes]',
  '  deferred   [--status S]  [--limit N]  [--inspect SYNC_ID]  [--replay]',
  '  prune      [--max-age-days N]  [--max-per-scope N]  [--dry-run]  [--apply]',
  '             Unknown arguments are rejected; use space-separated option values.',
  '             Potentially recoverable retry-cap relations are preserved.',
];

const printUsage = (cli) => cli.err(`${USAGE_LINES.join('\n')}\n`);

/** `error: <mensaje>` en el error estándar y código 1. */
function failWith(cli, message) {
  cli.err(`error: ${message}\n`);
  throw new CliExit(1);
}

const LAYOUT = '2006-01-02T15:04:05Z07:00';
const DIGITS = (n) => new RegExp(`^\\d{${n}}`);

/**
 * Fecha RFC 3339 (`time.Parse`): un `Date`, o el texto de error del analizador de la referencia
 * (`parsing time "x" as "2006-01-02T15:04:05Z07:00": cannot parse "x" as "2006"`).
 * @param {string} text
 * @returns {{ date: Date } | { error: string }}
 */
export function parseRfc3339(text) {
  const quoted = JSON.stringify(text);
  const cannot = (rest, element) => ({ error: `parsing time ${quoted} as ${JSON.stringify(LAYOUT)}: cannot parse ${JSON.stringify(rest)} as ${JSON.stringify(element)}` });
  const range = (what) => ({ error: `parsing time ${quoted}: ${what} out of range` });
  let rest = text;
  const take = (n) => {
    const part = rest.slice(0, n);
    rest = rest.slice(n);
    return Number(part);
  };
  const steps = [['2006', 4], ['-', 0], ['01', 2], ['-', 0], ['02', 2], ['T', 0], ['15', 2], [':', 0], ['04', 2], [':', 0], ['05', 2]];
  const values = [];
  for (const [element, width] of steps) {
    if (width === 0) {
      if (!rest.startsWith(element)) return cannot(rest, element);
      rest = rest.slice(1);
    } else {
      if (!DIGITS(width).test(rest)) return cannot(rest, element);
      values.push(take(width));
    }
  }
  const [year, month, day, hour, minute, second] = values;
  if (month < 1 || month > 12) return range('month');
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return range('day');
  if (hour > 23) return range('hour');
  if (minute > 59) return range('minute');
  if (second > 59) return range('second');
  const fraction = /^[.,]\d+/.exec(rest);
  if (fraction) rest = rest.slice(fraction[0].length);
  let offsetMinutes = 0;
  if (rest.startsWith('Z')) {
    rest = rest.slice(1);
  } else {
    const zone = /^([+-])(\d{2}):(\d{2})/.exec(rest);
    if (!zone) return cannot(rest, 'Z07:00');
    if (Number(zone[2]) > 24) return { error: `parsing time ${quoted}: time zone offset hour out of range` };
    if (Number(zone[3]) > 60) return { error: `parsing time ${quoted}: time zone offset minute out of range` };
    offsetMinutes = (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]));
    rest = rest.slice(zone[0].length);
  }
  if (rest !== '') return { error: `parsing time ${quoted}: extra text: ${JSON.stringify(rest)}` };
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
  return { date: new Date(ms) };
}

/** Entero (`strconv.Atoi`) del argumento que sigue a `args[i]`, o `null` si no es válido. */
const atoi = (args, i) => (i + 1 < args.length ? parseInt64(args[i + 1]) : null);

const sinceOption = (cli, text) => {
  if (text === '') return undefined;
  const parsed = parseRfc3339(text);
  if (parsed.error) failWith(cli, `--since must be RFC3339 format: ${parsed.error}`);
  return parsed.date;
};

function listCommand(cli, config) {
  const args = cli.args.slice(2);
  let project = '';
  let status = '';
  let sinceText = '';
  let all = false;
  let limit = 50;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--project': if (i + 1 < args.length) project = args[++i]; break;
      case '--all': all = true; break;
      case '--status': if (i + 1 < args.length) status = args[++i]; break;
      case '--since': if (i + 1 < args.length) sinceText = args[++i]; break;
      case '--limit': {
        const n = atoi(args, i);
        if (n !== null) limit = n;
        i++;
        break;
      }
      default:
    }
  }
  const since = sinceOption(cli, sinceText);
  if (limit > 500) failWith(cli, '--limit cannot exceed 500');
  withStore(cli, config, (store) => {
    let proj;
    try {
      proj = resolveCliProjectScope(cli, store, project, all, true);
    } catch (err) {
      return fatal(cli, err);
    }
    const filter = { project: proj, status, since_time: since, exclude_not_conflict: true, actionable_only: true };
    let items;
    let total;
    try {
      items = listRelations(store, { ...filter, limit });
      total = countRelations(store, filter);
    } catch (err) {
      return fatal(cli, err);
    }
    println(cli, `Conflicts List (project: ${proj})`);
    println(cli, `  Total:  ${total}`);
    println(cli, `  Showing: ${items.length}`);
    if (items.length === 0) return println(cli, '  No relations found.');
    println(cli);
    for (const item of items) {
      println(cli, `  id:             ${item.id}`);
      println(cli, `  sync_id:        ${item.sync_id}`);
      println(cli, `  relation:       ${item.relation}`);
      println(cli, `  judgment_status: ${item.judgment_status}`);
      println(cli, `  source:         ${item.source_id} — ${truncate(item.source_title, 60)}`);
      println(cli, `  target:         ${item.target_id} — ${truncate(item.target_title, 60)}`);
      println(cli, `  created_at:     ${item.created_at}`);
      println(cli);
    }
  });
}

function showCommand(cli, config) {
  if (cli.args.length < 3) {
    cli.err('usage: odin conflicts show <relation_id>\n');
    throw new CliExit(1);
  }
  const id = parseInt64(cli.args[2].trim());
  if (id === null) failWith(cli, `relation_id must be an integer: strconv.ParseInt: parsing ${JSON.stringify(cli.args[2].trim())}: invalid syntax`);
  withStore(cli, config, (store) => {
    let found;
    try {
      found = getRelationByIntId(store, id);
    } catch {
      return failWith(cli, `relation ${id} not found`);
    }
    println(cli, 'Conflict Detail');
    println(cli, `  relation_id:     ${found.id}`);
    println(cli, `  sync_id:         ${found.sync_id}`);
    println(cli, `  relation:        ${found.relation}`);
    println(cli, `  judgment_status: ${found.judgment_status}`);
    println(cli, `  created_at:      ${found.created_at}`);
    println(cli, `  updated_at:      ${found.updated_at}`);
    println(cli);
    println(cli, `  source_id:       ${found.source_id}`);
    println(cli, `  source_title:    ${found.source_title}`);
    println(cli);
    println(cli, `  target_id:       ${found.target_id}`);
    println(cli, `  target_title:    ${found.target_title}`);
  });
}

const FIRST_STATUSES = ['pending', 'accepted', 'rejected', 'orphaned'];

function statsCommand(cli, config) {
  const args = cli.args.slice(2);
  let project = '';
  let all = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') {
      if (i + 1 < args.length) project = args[++i];
    } else if (args[i] === '--all') {
      all = true;
    }
  }
  withStore(cli, config, (store) => {
    let stats;
    let proj;
    try {
      proj = resolveCliProjectScope(cli, store, project, all, true);
      stats = getActionableRelationStats(store, proj);
    } catch (err) {
      return fatal(cli, err);
    }
    println(cli, `Conflicts Stats (project: ${proj})`);
    println(cli);
    const statuses = Object.keys(stats.by_judgment_status);
    if (statuses.length === 0) {
      println(cli, '  No relations found.');
    } else {
      println(cli, '  By judgment_status:');
      // Orden estable: los conocidos primero y el resto alfabético.
      for (const status of [...FIRST_STATUSES.filter((s) => statuses.includes(s)), ...statuses.filter((s) => !FIRST_STATUSES.includes(s)).sort()]) {
        println(cli, `    ${padRight(`${status}:`, 12)} ${stats.by_judgment_status[status]}`);
      }
    }
    const relations = Object.keys(stats.by_relation).sort();
    if (relations.length > 0) {
      println(cli);
      println(cli, '  By relation type:');
      for (const relation of relations) println(cli, `    ${padRight(`${relation}:`, 20)} ${stats.by_relation[relation]}`);
    }
    println(cli);
    println(cli, `  Deferred:    ${stats.deferred}`);
    println(cli, `  Dead:        ${stats.dead}`);
  });
}

async function scanCommand(cli, config) {
  const args = cli.args.slice(2);
  let project = '';
  let sinceText = '';
  let all = false;
  let dryRun = false;
  let apply = false;
  let maxInsert = 100;
  let limit = 0;
  let cursor = 0;
  let semantic = false;
  let concurrency = 5;
  let timeoutPerCall = 60;
  let yes = false;
  let maxSemantic = 100;
  const intOption = (i, current) => {
    const n = atoi(args, i);
    return n === null ? current : n;
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--project': if (i + 1 < args.length) project = args[++i]; break;
      case '--all': all = true; break;
      case '--since': if (i + 1 < args.length) sinceText = args[++i]; break;
      case '--dry-run': dryRun = true; break;
      case '--apply': apply = true; break;
      case '--max-insert': maxInsert = intOption(i, maxInsert); i++; break;
      case '--limit': {
        if (i + 1 >= args.length) failWith(cli, '--limit requires a value');
        const value = parseInt64(args[i + 1]);
        if (value === null || value < 1 || value > DEFAULT_SCAN_LIMIT) failWith(cli, `--limit must be between 1 and ${DEFAULT_SCAN_LIMIT}`);
        limit = value;
        i++;
        break;
      }
      case '--cursor': {
        if (i + 1 >= args.length) failWith(cli, '--cursor requires a value');
        const value = parseInt64(args[i + 1]);
        if (value === null || value < 0) failWith(cli, '--cursor must be a non-negative observation ID');
        cursor = value;
        i++;
        break;
      }
      case '--semantic': semantic = true; break;
      case '--concurrency': concurrency = intOption(i, concurrency); i++; break;
      case '--timeout-per-call': timeoutPerCall = intOption(i, timeoutPerCall); i++; break;
      case '--yes': yes = true; break;
      case '--max-semantic': maxSemantic = intOption(i, maxSemantic); i++; break;
      default:
    }
  }
  if (dryRun && apply) failWith(cli, '--dry-run and --apply are mutually exclusive');
  if (concurrency < 1 || concurrency > 20) failWith(cli, `--concurrency must be between 1 and 20; got ${concurrency}`);
  const since = sinceOption(cli, sinceText);

  let store;
  try {
    store = cli.openStore(config);
  } catch (err) {
    return fatal(cli, err);
  }
  try {
    let proj;
    try {
      proj = resolveCliProjectScope(cli, store, project, all, true);
    } catch (err) {
      return fatal(cli, err);
    }
    const opts = { project: proj, since, limit, cursor, apply, max_insert: maxInsert };
    if (semantic) {
      let runner;
      try {
        runner = (cli.llm?.resolveRunner ?? resolveAgentRunner)(cli.env);
      } catch (err) {
        return failWith(cli, err.message);
      }
      if (!yes) {
        const cost = estimateScanCost(maxSemantic);
        println(cli, `Semantic scan will make up to ${maxSemantic} LLM calls (~${cost.input} input tokens, ~${cost.output} output tokens).`);
        println(cli, 'Subscription users: counts against your quota.');
        cli.out('Continue? [y/N] ');
        const answer = (cli.readLine() ?? '').trim().split(/\s+/)[0] ?? '';
        if (answer.toLowerCase() !== 'y') return println(cli, 'Aborted.');
      }
      Object.assign(opts, {
        semantic: true, concurrency, timeout_per_call_ms: timeoutPerCall * 1000, max_semantic: maxSemantic, runner, build_prompt: cli.llm?.buildPrompt ?? buildStorePrompt,
      });
    }
    let result;
    try {
      result = await (all ? scanAllProjects : scanProject)(store, opts);
    } catch (err) {
      return fatal(cli, err);
    }
    println(cli, `Conflicts Scan (project: ${proj})`);
    println(cli, `  inspected:        ${result.inspected}`);
    println(cli, `  ranked_queries:   ${result.ranked_queries}`);
    println(cli, `  candidates_found: ${result.candidates_found}`);
    println(cli, `  already_related:  ${result.already_related}`);
    println(cli, `  inserted:         ${result.inserted}`);
    println(cli, `  dry_run:          ${result.dry_run}`);
    if (result.next_cursor !== undefined) println(cli, `  next_cursor:      ${result.next_cursor}`);
    if (semantic) {
      println(cli, `  semantic_judged:  ${result.semantic_judged}`);
      println(cli, `  semantic_skipped: ${result.semantic_skipped}`);
      println(cli, `  semantic_errors:  ${result.semantic_errors}`);
    }
    if (result.capped) {
      const [name, cap] = semantic ? ['max-semantic', maxSemantic] : ['max-insert', maxInsert];
      println(cli, `WARNING: ${name} cap of ${cap} reached — this page has no continuation; re-run with --cursor ${cursor} and a higher cap.`);
    }
  } finally {
    try {
      store.close();
    } catch {
      // cerrar es de mejor esfuerzo
    }
  }
}

function deferredCommand(cli, config) {
  const args = cli.args.slice(2);
  let status = '';
  let inspect = '';
  let replay = false;
  let limit = 50;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--status': if (i + 1 < args.length) status = args[++i]; break;
      case '--limit': {
        const n = atoi(args, i);
        if (n !== null) limit = n;
        i++;
        break;
      }
      case '--inspect': if (i + 1 < args.length) inspect = args[++i]; break;
      case '--replay': replay = true; break;
      default:
    }
  }
  if (inspect !== '' && replay) failWith(cli, '--inspect and --replay are mutually exclusive');
  withStore(cli, config, (store) => {
    if (replay) {
      let result;
      try {
        result = (cli.syncApply?.replayDeferred ?? replayDeferred)(store);
      } catch (err) {
        return fatal(cli, err);
      }
      println(cli, 'Deferred Replay');
      println(cli, `  retried:   ${result.retried}`);
      println(cli, `  succeeded: ${result.succeeded}`);
      println(cli, `  failed:    ${result.failed}`);
      println(cli, `  dead:      ${result.dead}`);
      return;
    }
    if (inspect !== '') {
      let row;
      try {
        row = getDeferred(store, inspect);
      } catch (err) {
        return failWith(cli, err.message);
      }
      println(cli, 'Deferred Row');
      println(cli, `  sync_id:          ${row.sync_id}`);
      println(cli, `  entity:           ${row.entity}`);
      println(cli, `  entity_key:       ${row.entity_key ?? ''}`);
      println(cli, `  op:               ${row.op ?? ''}`);
      println(cli, `  apply_status:     ${row.apply_status}`);
      println(cli, `  retry_count:      ${row.retry_count}`);
      println(cli, `  payload_valid:    ${row.payload_valid}`);
      if (row.payload_valid) println(cli, `  payload:          ${formatPayload(row.payload)}`);
      else println(cli, `  payload_raw:      ${row.payload_raw}`);
      if (row.last_error !== undefined) println(cli, `  last_error:       ${row.last_error}`);
      println(cli, `  first_seen_at:    ${row.first_seen_at}`);
      return;
    }
    let rows;
    try {
      rows = listDeferred(store, { status, limit });
    } catch (err) {
      return fatal(cli, err);
    }
    println(cli, 'Deferred Queue');
    println(cli, `  Showing: ${rows.length}`);
    if (rows.length === 0) return println(cli, '  Queue is empty.');
    println(cli);
    for (const row of rows) {
      println(cli, `  sync_id:      ${row.sync_id}`);
      println(cli, `  entity_key:   ${row.entity_key ?? ''}`);
      println(cli, `  apply_status: ${row.apply_status}`);
      println(cli, `  retry_count:  ${row.retry_count}`);
      println(cli, `  first_seen_at: ${row.first_seen_at}`);
      println(cli);
    }
  });
}

/** `fmt.Sprint` de un mapa: `map[clave:valor …]` con claves ordenadas. */
function formatPayload(payload) {
  if (payload === undefined || payload === null) return 'map[]';
  const fmt = (v) => {
    if (v === null || v === undefined) return '<nil>';
    if (Array.isArray(v)) return `[${v.map(fmt).join(' ')}]`;
    if (typeof v === 'object') return `map[${Object.keys(v).sort().map((k) => `${k}:${fmt(v[k])}`).join(' ')}]`;
    return String(v);
  };
  return fmt(payload);
}

function pruneCommand(cli, config) {
  const args = cli.args.slice(2);
  let maxAgeDays = DEFAULT_DEAD_ROW_MAX_AGE_DAYS;
  let maxPerScope = DEFAULT_DEAD_ROW_MAX_PER_SCOPE;
  let dryRun = false;
  let apply = false;
  let invalid = '';
  const positive = (i) => {
    const n = atoi(args, i);
    return { n: n ?? 0, ok: n !== null && n > 0 };
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--max-age-days': {
        const { n, ok } = positive(i);
        if (!ok && invalid === '') invalid = '--max-age-days';
        maxAgeDays = n;
        i++;
        break;
      }
      case '--max-per-scope': {
        const { n, ok } = positive(i);
        if (!ok && invalid === '') invalid = '--max-per-scope';
        maxPerScope = n;
        i++;
        break;
      }
      case '--dry-run': dryRun = true; break;
      case '--apply': apply = true; break;
      default: failWith(cli, `unknown prune argument: ${args[i]}`);
    }
  }
  if (invalid !== '') failWith(cli, `${invalid} must be a positive integer`);
  if (dryRun && apply) failWith(cli, '--dry-run and --apply are mutually exclusive');
  withStore(cli, config, (store) => {
    let result;
    try {
      result = pruneDeadRows(store, { max_age_days: maxAgeDays, max_per_scope: maxPerScope, apply });
    } catch (err) {
      return fatal(cli, err);
    }
    println(cli, apply ? 'Dead Row Prune (applied)' : 'Dead Row Prune (dry run)');
    println(cli, `  max_age_days:  ${maxAgeDays}`);
    println(cli, `  max_per_scope: ${maxPerScope}`);
    println(cli, apply ? `  evicted:       ${result.total}` : `  would_evict:   ${result.total}`);
    if (result.total === 0) return println(cli, '  Nothing to prune.');
    const orNone = (v) => (v === '' ? '(none)' : v);
    println(cli);
    println(cli, '  By scope:');
    for (const scope of result.scopes) println(cli, `    target=${orNone(scope.target_key)} project=${orNone(scope.project)} by_age=${scope.by_age} by_cap=${scope.by_cap}`);
    println(cli);
    println(cli, '  By reason:');
    for (const reason of result.reasons) println(cli, `    entity=${orNone(reason.entity)} reason_code=${orNone(reason.reason_code)} age=${reason.age_bucket} count=${reason.count}`);
    if (!apply) {
      println(cli);
      println(cli, 'Dry run: nothing was deleted. Re-run with --apply to delete these rows.');
    }
  });
}

const SUBCOMMANDS = { list: listCommand, show: showCommand, stats: statsCommand, scan: scanCommand, deferred: deferredCommand, prune: pruneCommand };

/**
 * `odin conflicts <subcomando>`: inspección y mantenimiento de las relaciones de conflicto.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export async function cmdConflicts(cli, config) {
  if (cli.args.length < 2) {
    printUsage(cli);
    throw new CliExit(1);
  }
  const name = cli.args[1];
  if (!Object.hasOwn(SUBCOMMANDS, name)) {
    cli.err(`unknown conflicts subcommand: ${name}\n`);
    printUsage(cli);
    throw new CliExit(1);
  }
  await SUBCOMMANDS[name](cli, config);
}
