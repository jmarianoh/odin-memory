import { HANDLERS, hasCompactionMarker } from '../../hooks/handlers.js';
import { parseHookInput } from '../../hooks/input.js';
import { resolveHookProject } from '../../hooks/project.js';
import { toGoJson } from '../../store/backup.js';
import { resolveConfig } from '../config.js';
import { exit } from '../runtime.js';

export const HOOK_USAGE = `usage: odin hook ${Object.keys(HANDLERS).join('|')}|resolve-hook-project`;

/**
 * `odin hook <nombre>`: acciones que los hooks de Copilot ejecutan. Leen la carga JSON de la
 * entrada estándar, **nunca fallan** (salen con 0 aunque algo se rompa, para no bloquear al
 * agente) y solo escriben en la salida estándar un único objeto JSON cuando aportan contexto.
 * `resolve-hook-project` no necesita configuración ni almacén.
 * @param {import('../runtime.js').Cli} cli
 */
export function cmdHook(cli) {
  const [, name, ...extra] = cli.args;
  if (extra.length > 0 || (name !== 'resolve-hook-project' && !Object.hasOwn(HANDLERS, name ?? ''))) {
    cli.err(`${HOOK_USAGE}\n`);
    return exit(1);
  }
  const text = cli.readInput ? cli.readInput() : '';
  if (name === 'resolve-hook-project') {
    cli.out(`${JSON.stringify(resolveHookProject(text, cli.env))}\n`);
    return undefined;
  }
  const input = parseHookInput(text);
  if (!input.ok) return undefined;
  let store;
  try {
    const config = resolveConfig(cli.env, cli.home);
    // Sin marca de compactación el postToolUse no necesita abrir el almacén.
    if (name === 'copilot-post-tool-use' && !hasCompactionMarker(config.dataDir, input.sessionId)) return undefined;
    if (name === 'copilot-pre-compact') {
      HANDLERS[name]({ input, dataDir: config.dataDir });
      return undefined;
    }
    store = cli.openStore(config);
    const output = HANDLERS[name]({ store, input, env: cli.env, dataDir: config.dataDir });
    if (output) cli.out(`${toGoJson(output)}\n`);
  } catch {
    // fail-open
  } finally {
    try {
      store?.close();
    } catch {
      // ya cerrado
    }
  }
  return undefined;
}
