import { deleteObservation } from '../../store/observations.js';
import { deleteProject } from '../../store/project-maintenance.js';
import { deletePrompt } from '../../store/prompts.js';
import { deleteSession } from '../../store/session-delete.js';
import { goQuote } from '../../mcp/json.js';
import { exit, fatal, parseInt64, println, withStore } from '../runtime.js';

const USAGE_OBSERVATION = 'odin delete <observation_id> [--hard]';
const USAGE_SESSION = 'odin delete session <id>';
const USAGE_PROMPT = 'odin delete prompt <id>';
const USAGE_PROJECT = 'odin delete project <name> [--hard]';

/**
 * Rechaza cualquier argumento que no sea una opción documentada antes de abrir
 * el almacén: ignorar en silencio una opción como `--dry-run` dejaría borrar de
 * todos modos.
 * @returns {Set<string>} las opciones soportadas presentes
 */
function parseTrailing(cli, args, usage, ...supported) {
  const flags = new Set();
  const unexpected = [];
  for (const arg of args) {
    if (supported.includes(arg)) flags.add(arg);
    else unexpected.push(goQuote(arg));
  }
  if (unexpected.length > 0) {
    cli.err(`error: unexpected argument(s): ${unexpected.join(' ')}\n`);
    cli.err(`usage: ${usage}\n`);
    exit(1);
  }
  return flags;
}

/** Rechaza los símbolos de ayuda estándar como destino del borrado. */
function rejectHelpTarget(cli, target, usage) {
  if (target !== '--help' && target !== '-h') return;
  cli.err(`usage: ${usage}\n`);
  exit(1);
}

function invalidId(cli, kind, value) {
  cli.err(`error: invalid ${kind} id ${goQuote(value)}\n`);
  exit(1);
}

/**
 * `odin delete …`: borra una observación, sesión, prompt o proyecto.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdDelete(cli, config) {
  if (cli.args.length < 2) {
    cli.err(`usage: ${USAGE_OBSERVATION}\n`);
    cli.err('       odin delete session  <id>\n');
    cli.err('       odin delete prompt   <id>\n');
    cli.err('       odin delete project  <name> [--hard]\n');
    exit(1);
  }
  switch (cli.args[1]) {
    case 'session':
      return deleteSessionCommand(cli, config);
    case 'prompt':
      return deletePromptCommand(cli, config);
    case 'project':
      return deleteProjectCommand(cli, config);
    default:
      return deleteObservationCommand(cli, config);
  }
}

function deleteObservationCommand(cli, config) {
  const id = parseInt64(cli.args[1]);
  if (id === null) invalidId(cli, 'observation', cli.args[1]);
  const hard = parseTrailing(cli, cli.args.slice(2), USAGE_OBSERVATION, '--hard').has('--hard');
  withStore(cli, config, (store) => {
    try {
      deleteObservation(store, id, { hardDelete: hard });
    } catch (err) {
      return fatal(cli, err);
    }
    println(cli, `Observation #${id} ${hard ? 'hard-deleted' : 'soft-deleted'}`);
  });
}

function deleteSessionCommand(cli, config) {
  if (cli.args.length < 3) {
    cli.err(`usage: ${USAGE_SESSION}\n`);
    exit(1);
  }
  const id = cli.args[2];
  rejectHelpTarget(cli, id, USAGE_SESSION);
  parseTrailing(cli, cli.args.slice(3), USAGE_SESSION);
  withStore(cli, config, (store) => {
    try {
      deleteSession(store, id);
    } catch (err) {
      return fatal(cli, err);
    }
    println(cli, `Session ${goQuote(id)} deleted`);
  });
}

function deletePromptCommand(cli, config) {
  if (cli.args.length < 3) {
    cli.err(`usage: ${USAGE_PROMPT}\n`);
    exit(1);
  }
  const id = parseInt64(cli.args[2]);
  if (id === null) invalidId(cli, 'prompt', cli.args[2]);
  parseTrailing(cli, cli.args.slice(3), USAGE_PROMPT);
  withStore(cli, config, (store) => {
    try {
      deletePrompt(store, id);
    } catch (err) {
      return fatal(cli, err);
    }
    println(cli, `Prompt #${id} deleted`);
  });
}

function deleteProjectCommand(cli, config) {
  if (cli.args.length < 3) {
    cli.err(`usage: ${USAGE_PROJECT}\n`);
    exit(1);
  }
  const name = cli.args[2];
  rejectHelpTarget(cli, name, USAGE_PROJECT);
  const hard = parseTrailing(cli, cli.args.slice(3), USAGE_PROJECT, '--hard').has('--hard');
  withStore(cli, config, (store) => {
    let result;
    try {
      result = deleteProject(store, name, hard);
    } catch (err) {
      return fatal(cli, err);
    }
    println(
      cli,
      `Project ${goQuote(result.project)} ${hard ? 'hard-deleted' : 'soft-deleted'}: ${result.observations_deleted} observation(s), ${result.prompts_deleted} prompt(s), ${result.sessions_deleted} session(s)`,
    );
  });
}
