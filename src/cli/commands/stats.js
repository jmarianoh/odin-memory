import { stats, statsProject } from '../../store/projects.js';
import { requiredProjectValue, resolveCliProjectScope } from '../project.js';
import { fatal, println, withStore } from '../runtime.js';

/**
 * `odin stats [--project P|--all]`: totales del sistema de memoria.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdStats(cli, config) {
  const args = cli.args.slice(1);
  let projectName = '';
  let allProjects = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') {
      try {
        projectName = requiredProjectValue(args, i);
      } catch (err) {
        return fatal(cli, err);
      }
      i++;
    } else if (args[i] === '--all') {
      allProjects = true;
    }
  }
  withStore(cli, config, (store) => {
    let totals;
    try {
      const resolved = resolveCliProjectScope(cli, store, projectName, allProjects, true);
      totals = resolved !== '' ? statsProject(store, resolved) : stats(store);
    } catch (err) {
      return fatal(cli, err);
    }
    const projects = totals.projects.length > 0 ? totals.projects.join(', ') : 'none yet';
    println(cli, 'Odin Memory Stats');
    println(cli, `  Sessions:     ${totals.total_sessions}`);
    println(cli, `  Observations: ${totals.total_observations}`);
    println(cli, `  Prompts:      ${totals.total_prompts}`);
    println(cli, `  Projects:     ${projects}`);
    println(cli, `  Database:     ${config.dataDir}/odin.db`);
  });
}
