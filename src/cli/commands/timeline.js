import { goQuote } from '../../mcp/json.js';
import { getObservation } from '../../store/observations.js';
import { timeline } from '../../store/search.js';
import { formatLocal } from '../../timeutil/index.js';
import { goTrim } from '../../store/text.js';
import { requiredProjectValue, resolveCliProjectScope } from '../project.js';
import { exit, fatal, parseInt64, println, truncate, withStore } from '../runtime.js';

const NO_ROWS = 'sql: no rows in result set';

/**
 * `odin timeline <id> [--before N] [--after N] [--project P|--all]`: contexto
 * cronológico alrededor de una observación.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdTimeline(cli, config) {
  const args = cli.args.slice(1);
  if (args.length < 1) {
    cli.err('usage: odin timeline <observation_id> [--before N] [--after N] [--project PROJECT|--all]\n');
    exit(1);
  }
  const obsId = parseInt64(args[0]);
  if (obsId === null) {
    cli.err(`error: invalid observation id ${goQuote(args[0])}\n`);
    exit(1);
  }
  let before = 5;
  let after = 5;
  let projectName = '';
  let allProjects = false;
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--before':
        if (i + 1 < args.length) {
          const n = parseInt64(args[++i]);
          if (n !== null) before = n;
        }
        break;
      case '--after':
        if (i + 1 < args.length) {
          const n = parseInt64(args[++i]);
          if (n !== null) after = n;
        }
        break;
      case '--project':
        try {
          projectName = requiredProjectValue(args, i);
        } catch (err) {
          return fatal(cli, err);
        }
        i++;
        break;
      case '--all':
        allProjects = true;
        break;
      default:
    }
  }

  withStore(cli, config, (store) => {
    let result;
    try {
      const resolved = resolveCliProjectScope(cli, store, projectName, allProjects, true);
      if (resolved !== '') {
        const focus = getObservation(store, obsId);
        if (focus === null) throw new Error(NO_ROWS);
        if (focus.project == null || goTrim(focus.project).toLowerCase() !== resolved.toLowerCase()) throw new Error('observation not found in resolved project');
      }
      try {
        result = timeline(store, obsId, before, after);
      } catch (err) {
        if (err.code === 'observation_not_found') throw new Error(`timeline: observation #${obsId} not found: ${NO_ROWS}`);
        throw err;
      }
    } catch (err) {
      return fatal(cli, err);
    }
    const info = result.session_info;
    if (info) {
      const summary = info.summary != null ? ` — ${truncate(info.summary, 100)}` : '';
      println(cli, `Session: ${info.project} (${info.started_at})${summary}`);
      println(cli, `Total observations in session: ${result.total_in_range}\n`);
    }
    if (result.before.length > 0) {
      println(cli, '─── Before ───');
      for (const e of result.before) println(cli, `  #${e.id} [${e.type}] ${e.title} — ${truncate(e.content, 150)}`);
      println(cli);
    }
    println(cli, `>>> #${result.focus.id} [${result.focus.type}] ${result.focus.title} <<<`);
    println(cli, `    ${truncate(result.focus.content, 500)}`);
    println(cli, `    ${formatLocal(result.focus.created_at, cli.env)}\n`);
    if (result.after.length > 0) {
      println(cli, '─── After ───');
      for (const e of result.after) println(cli, `  #${e.id} [${e.type}] ${e.title} — ${truncate(e.content, 150)}`);
    }
  });
}
