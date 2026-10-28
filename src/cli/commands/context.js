import { formatContext } from '../../store/context.js';
import { goTrim } from '../../store/text.js';
import { resolveCliProjectScope } from '../project.js';
import { fatal, println, withStore } from '../runtime.js';

/**
 * `odin context [proyecto] [--project P|--all] [--scope S] [--older-history]`:
 * contexto reciente de sesiones anteriores.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdContext(cli, config) {
  const args = cli.args.slice(1);
  let olderHistory = false;
  let projectName = '';
  let legacyProject = '';
  let scope = '';
  let projectFlagSeen = false;
  let allProjects = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--older-history':
        olderHistory = true;
        break;
      case '--project':
        if (i + 1 >= args.length || goTrim(args[i + 1]) === '') return fatal(cli, 'context project selector requires a value');
        if (projectFlagSeen) return fatal(cli, 'context project selector may only be specified once');
        projectName = args[++i];
        projectFlagSeen = true;
        break;
      case '--all':
        if (allProjects) return fatal(cli, 'context all-project selector may only be specified once');
        allProjects = true;
        break;
      case '--scope':
        if (i + 1 < args.length) scope = args[++i];
        break;
      default:
        if (args[i].startsWith('-')) return fatal(cli, `unknown context flag: ${args[i]}`);
        if (legacyProject !== '') return fatal(cli, 'context project selector may only be specified once');
        legacyProject = args[i];
    }
  }
  if (projectFlagSeen && legacyProject !== '') return fatal(cli, 'context project selector cannot combine legacy positional project with --project');
  if (allProjects && (projectFlagSeen || legacyProject !== '')) return fatal(cli, 'context all-project selector cannot be combined with a project selector');
  if (legacyProject !== '') projectName = legacyProject;

  withStore(cli, config, (store) => {
    let text;
    try {
      const resolved = resolveCliProjectScope(cli, store, projectName, allProjects, true);
      text = formatContext(store, resolved, scope, olderHistory ? { older_history: true } : {});
    } catch (err) {
      return fatal(cli, err);
    }
    if (text === '') println(cli, 'No previous session memories found.');
    else cli.out(text);
  });
}
