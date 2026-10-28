import { basename } from 'node:path';
import { goQuote } from '../../mcp/json.js';
import { toGoJson } from '../../store/backup.js';
import { goTrim } from '../../store/text.js';
import { writeInitConfig } from '../init-config.js';
import { exit, fatal, println } from '../runtime.js';

const USAGE = 'usage: odin init [project_name] [--force]';

/**
 * `odin init [nombre] [--force]`: escribe `.odin-memory/config.json` en el directorio actual.
 * No abre el almacén.
 * @param {import('../runtime.js').Cli} cli
 */
export function cmdInit(cli) {
  let force = false;
  let projectName = '';
  for (const token of cli.args.slice(1)) {
    if (token === '-h' || token === '--help' || token === 'help') {
      println(cli, USAGE);
      return;
    }
    if (token === '-f' || token === '--force') {
      force = true;
    } else if (token.startsWith('-')) {
      cli.err(`odin: unknown flag: ${token}\n\n${USAGE}\n`);
      exit(1);
    } else if (projectName === '') {
      projectName = token;
    } else {
      cli.err(`odin: unexpected argument: ${token}\n\n${USAGE}\n`);
      exit(1);
    }
  }
  const cwd = cli.cwd();
  if (projectName === '') projectName = basename(cwd);
  const trimmed = goTrim(projectName);
  if (trimmed === '') return fatal(cli, 'project name is required');
  if (/[/\\]/.test(trimmed)) return fatal(cli, 'project name must be a name, not a path');
  for (const ch of trimmed) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return fatal(cli, 'project name contains control characters');
  }
  try {
    writeInitConfig(cwd, `${toGoJson({ project_name: trimmed }, 2)}\n`, force);
  } catch (err) {
    return fatal(cli, err);
  }
  println(cli, `Initialized Odin project ${goQuote(trimmed)} in .odin-memory/config.json`);
}
