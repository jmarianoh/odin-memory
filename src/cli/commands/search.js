import { searchObservations } from '../../store/search.js';
import { formatLocal } from '../../timeutil/index.js';
import { goQuote } from '../../mcp/json.js';
import { resolveCliProjectScope } from '../project.js';
import { exit, fatal, parseInt64, println, truncate, withStore } from '../runtime.js';

export const SEARCH_USAGE = 'usage: odin search <query> [--type TYPE] [--project PROJECT|--all] [--scope SCOPE] [--limit N] [--match all|any]';

/**
 * `odin search <consulta> [opciones]`: busca memorias y las lista.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdSearch(cli, config) {
  const args = cli.args.slice(1);
  if (args.length < 1) {
    cli.err(`${SEARCH_USAGE}\n`);
    exit(1);
  }
  const queryParts = [];
  const opts = { limit: 10 };
  let allProjects = false;
  for (let i = 0; i < args.length; i++) {
    const hasNext = i + 1 < args.length;
    switch (args[i]) {
      case '--type':
        if (hasNext) opts.type = args[++i];
        break;
      case '--project':
        if (hasNext) opts.project = args[++i];
        break;
      case '--all':
        allProjects = true;
        break;
      case '--limit':
        if (hasNext) {
          const n = parseInt64(args[++i]);
          if (n !== null) opts.limit = n;
        }
        break;
      case '--scope':
        if (hasNext) opts.scope = args[++i];
        break;
      case '--match':
        if (hasNext) opts.match_mode = args[++i];
        break;
      default:
        queryParts.push(args[i]);
    }
  }
  const query = queryParts.join(' ');
  if (query === '') {
    cli.err('error: search query is required\n');
    exit(1);
  }
  withStore(cli, config, (store) => {
    let results;
    try {
      opts.project = resolveCliProjectScope(cli, store, opts.project ?? '', allProjects, true);
      results = searchObservations(store, query, opts);
    } catch (err) {
      return fatal(cli, err);
    }
    if (results.length === 0) {
      println(cli, `No memories found for: ${goQuote(query)}`);
      return;
    }
    println(cli, `Found ${results.length} memories:\n`);
    results.forEach((r, i) => {
      const project = r.project != null ? ` | project: ${r.project}` : '';
      cli.out(`[${i + 1}] #${r.id} (${r.type}) — ${r.title}\n    ${truncate(r.content, 300)}\n    ${formatLocal(r.created_at, cli.env)}${project} | scope: ${r.scope}\n\n`);
    });
  });
}
