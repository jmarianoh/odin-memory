import { createServer } from '../../mcp/server.js';
import { resolveTools } from '../../mcp/profiles.js';
import { runMcp } from '../../mcp/run.js';
import { processOverride } from '../../project/detect.js';
import { VERSION } from '../../version/index.js';
import { goTrim } from '../../store/text.js';
import { fatal } from '../runtime.js';

/**
 * Interpreta `--tools` y `--project` de `odin mcp`.
 * @param {string[]} args
 * @param {string} initialProject proyecto fijado por `ODIN_PROJECT`, si lo hay
 * @returns {{ toolsFilter: string, defaultProject: string }}
 */
export function parseMcpArgs(args, initialProject) {
  let toolsFilter = '';
  let defaultProject = initialProject;
  const projectValue = (raw) => {
    const value = goTrim(raw ?? '');
    if (value === '') throw new Error('--project requires a value');
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--tools=')) {
      toolsFilter = arg.slice('--tools='.length);
    } else if (arg === '--tools' && i + 1 < args.length) {
      toolsFilter = args[++i];
    } else if (arg.startsWith('--project=')) {
      defaultProject = projectValue(arg.slice('--project='.length));
    } else if (arg === '--project') {
      if (i + 1 >= args.length) throw new Error('--project requires a value');
      defaultProject = projectValue(args[++i]);
    }
  }
  return { toolsFilter, defaultProject };
}

/**
 * `odin mcp [--tools=PERFIL] [--project NOMBRE]`: servidor MCP por stdio.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export async function cmdMcp(cli, config) {
  const override = processOverride('', cli.env);
  let parsed;
  try {
    parsed = parseMcpArgs(cli.args.slice(1), override.ok ? override.value : '');
  } catch (err) {
    return fatal(cli, err);
  }
  let store;
  try {
    store = cli.openStore(config);
  } catch (err) {
    return fatal(cli, err);
  }
  try {
    const server = createServer(
      store,
      { defaultProject: parsed.defaultProject, version: VERSION },
      resolveTools(parsed.toolsFilter),
      { env: cli.env, cwd: cli.cwd },
    );
    await runMcp(server, cli.mcp ?? {});
  } catch (err) {
    return fatal(cli, err);
  } finally {
    try {
      store.close();
    } catch {
      // cerrar es de mejor esfuerzo
    }
  }
}
