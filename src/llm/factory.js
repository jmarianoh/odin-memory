import { CopilotRunner, ERR_INVALID_RUNNER, LlmError } from './runner.js';

/** Ejecutores disponibles, por el nombre que se da en `ODIN_AGENT_CLI`. */
export const RUNNER_NAMES = Object.freeze(['copilot']);

/**
 * Ejecutor semántico para el nombre dado (normalmente `ODIN_AGENT_CLI`).
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv, runCli?: Function }} [options]
 * @throws {LlmError} `invalid_runner_name` si el nombre falta o no se reconoce
 */
export function newRunner(name, options = {}) {
  if (name === 'copilot') return new CopilotRunner(options);
  if (name === '') {
    throw new LlmError('invalid_runner_name', `${ERR_INVALID_RUNNER}: ODIN_AGENT_CLI is not set; supported values are: ${RUNNER_NAMES.join(', ')}`);
  }
  throw new LlmError(
    'invalid_runner_name',
    `${ERR_INVALID_RUNNER}: ${JSON.stringify(name)} is not a recognized runner; set ODIN_AGENT_CLI to one of: ${RUNNER_NAMES.join(', ')}`,
  );
}

/**
 * Ejecutor según `ODIN_AGENT_CLI` del entorno, con el error de uso del escaneo semántico.
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveAgentRunner(env = process.env) {
  const name = env.ODIN_AGENT_CLI ?? '';
  if (name === '') throw new Error("ODIN_AGENT_CLI is not set; required for --semantic scan (set to 'copilot')");
  return newRunner(name, { env });
}
