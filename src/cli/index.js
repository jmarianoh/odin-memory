import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Store } from '../store/store.js';
import { VERSION } from '../version/index.js';
import { checkLatest, CHECK_STATUS, shouldCheckForUpdates } from '../version/check.js';
import { cmdInstanceId, runCompatibility, runMigrateCopy } from './commands/admin.js';
import { cmdConflicts } from './commands/conflicts.js';
import { cmdContext } from './commands/context.js';
import { cmdDelete } from './commands/delete.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdHook } from './commands/hook.js';
import { cmdSetup } from './commands/setup.js';
import { EXPORT_HELP, IMPORT_HELP, cmdExport, cmdImport } from './commands/backup.js';
import { cmdInit } from './commands/init.js';
import { cmdMcp } from './commands/mcp.js';
import { cmdProjects } from './commands/projects.js';
import { cmdSave } from './commands/save.js';
import { cmdSearch } from './commands/search.js';
import { cmdServe } from './commands/serve.js';
import { cmdStats } from './commands/stats.js';
import { runTest } from './commands/selftest.js';
import { cmdSync } from './commands/sync.js';
import { cmdTimeline } from './commands/timeline.js';
import { resolveConfig } from './config.js';
import { CliExit, fatal, println, readLineSync } from './runtime.js';
import { usageText } from './usage.js';

/** Comandos que usan el almacén: reciben la configuración ya resuelta. */
const STORE_COMMANDS = {
  serve: cmdServe,
  conflicts: cmdConflicts,
  'instance-id': cmdInstanceId,
  mcp: cmdMcp,
  search: cmdSearch,
  save: cmdSave,
  delete: cmdDelete,
  timeline: cmdTimeline,
  context: cmdContext,
  stats: cmdStats,
  export: cmdExport,
  import: cmdImport,
  projects: cmdProjects,
  sync: cmdSync,
  doctor: cmdDoctor,
};

/**
 * Contexto real del proceso, con sobrescrituras para pruebas.
 * @param {string[]} args
 * @param {Partial<import('./runtime.js').Cli>} [overrides]
 * @returns {import('./runtime.js').Cli}
 */
export function createCli(args, overrides = {}) {
  return {
    args,
    env: process.env,
    cwd: () => process.cwd(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    readLine: () => readLineSync(),
    readInput: () => {
      try {
        return readFileSync(0, 'utf8');
      } catch {
        return '';
      }
    },
    openStore: (config) => Store.open(config),
    home: homedir,
    ...overrides,
  };
}

/**
 * Despacha un comando. Devuelve el código de salida; no llama a `process.exit`.
 * @param {string[]} args argumentos tras el nombre del programa
 * @param {Partial<import('./runtime.js').Cli>} [overrides] E/S y entorno (pruebas)
 * @returns {Promise<number>}
 */
export async function run(args, overrides = {}) {
  const cli = createCli(args, overrides);
  try {
    await dispatch(cli);
    return 0;
  } catch (err) {
    if (err instanceof CliExit) return err.code;
    throw err;
  }
}

async function dispatch(cli) {
  const [command] = cli.args;
  if (command === undefined) {
    cli.out(usageText());
    throw new CliExit(1);
  }

  // Los hooks no deben fallar nunca ni exigir configuración válida; `setup` solo edita archivos de configuración.
  if (command === 'hook') {
    cmdHook(cli);
    return;
  }
  if (command === 'setup') {
    cmdSetup(cli);
    return;
  }

  // Las autopruebas se despachan antes que la configuración: nunca tocan los datos del usuario.
  if (command.trim().toLowerCase() === 'test') throw new CliExit(await runTest(cli));

  // Estos dos no resuelven configuración ni abren el almacén y devuelven su propio código.
  if (command === 'migrate-copy') throw new CliExit(runMigrateCopy(cli));
  if (command === 'compatibility') throw new CliExit(runCompatibility(cli));

  // La ayuda de exportar e importar no resuelve configuración ni abre el almacén.
  if ((command === 'export' || command === 'import') && cli.args.slice(1).includes('--help')) {
    println(cli, command === 'export' ? EXPORT_HELP : IMPORT_HELP);
    return;
  }

  if (shouldCheckForUpdates(cli.args)) {
    const result = await (cli.checkForUpdates ?? ((current) => checkLatest(current, { env: cli.env })))(VERSION);
    if (result.status !== CHECK_STATUS.upToDate && result.message) cli.err(`${result.message}\n\n`);
  }

  switch (command.toLowerCase().trim()) {
    case 'version':
    case '--version':
    case '-v':
      println(cli, `odin ${VERSION}`);
      return;
    case 'help':
    case '--help':
    case '-h':
      cli.out(usageText());
      return;
    case 'init':
      cmdInit(cli);
      return;
    default:
  }

  const handler = STORE_COMMANDS[command];
  if (handler === undefined || !Object.hasOwn(STORE_COMMANDS, command)) {
    cli.err(`unknown command: ${command}\n\n`);
    cli.out(usageText());
    throw new CliExit(1);
  }
  let config;
  try {
    config = resolveConfig(cli.env, cli.home);
  } catch (err) {
    return fatal(cli, err);
  }
  await handler(cli, config);
}
