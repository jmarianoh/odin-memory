import { runTui } from '../../tui/app.js';
import { VERSION } from '../../version/index.js';
import { fatal } from '../runtime.js';

/**
 * `odin tui`: interfaz de terminal para buscar, leer y administrar la memoria. Necesita un terminal
 * interactivo; `Cli.runTui` la sustituye en las pruebas.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export async function cmdTui(cli, config) {
  if (!cli.runTui && !(process.stdin.isTTY && process.stdout.isTTY)) {
    return fatal(cli, new Error('the tui needs an interactive terminal'));
  }
  const store = (() => {
    try {
      return cli.openStore(config);
    } catch (err) {
      return fatal(cli, err);
    }
  })();
  try {
    await (cli.runTui ?? runTui)({ store, version: VERSION, env: cli.env, home: cli.home, cwd: cli.cwd });
  } catch (err) {
    return fatal(cli, err);
  } finally {
    try {
      store.close();
    } catch {
      // ya cerrado
    }
  }
  return undefined;
}
