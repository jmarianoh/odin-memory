import { execFile } from 'node:child_process';

/** Verbos de relación admitidos en un veredicto. */
export const VALID_RELATIONS = Object.freeze(['conflicts_with', 'supersedes', 'scoped', 'related', 'compatible', 'not_conflict']);

/** Errores de un ejecutor de comparaciones semánticas. */
export class LlmError extends Error {
  /**
   * @param {'cli_not_installed'|'auth_missing'|'timeout'|'invalid_json'|'unknown_relation'|'invalid_runner_name'|'cli_failed'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
  }
}

export const ERR_CLI_NOT_INSTALLED = 'agent CLI binary not found in PATH';
export const ERR_TIMEOUT = 'agent CLI call exceeded timeout';
export const ERR_INVALID_JSON = 'agent CLI returned malformed JSON';
export const ERR_UNKNOWN_RELATION = 'agent returned a relation outside the locked vocabulary';
export const ERR_INVALID_RUNNER = 'invalid runner name';

/** Quita las secuencias de color y control de la salida de una herramienta de terminal. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');

/** Primer objeto JSON equilibrado del texto que contiene la clave `"Relation"`, o `null`. */
function findVerdictObject(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === '{') {
        depth++;
      } else if (c === '}' && --depth === 0) {
        const candidate = text.slice(start, i + 1);
        if (candidate.includes('"Relation"')) return candidate;
        break;
      }
    }
  }
  return null;
}

/**
 * Interpreta la respuesta del modelo: un objeto `{"Relation","Confidence","Reasoning"}`
 * solo o rodeado de texto adicional (una valla de código, por ejemplo).
 * @param {string} output
 * @returns {{ relation: string, confidence: number, reasoning: string, model: string }}
 * @throws {LlmError}
 */
export function parseVerdict(output) {
  const candidate = findVerdictObject(stripAnsi(output));
  if (candidate === null) throw new LlmError('invalid_json', `${ERR_INVALID_JSON}: inner verdict: no JSON object with a Relation field`);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new LlmError('invalid_json', `${ERR_INVALID_JSON}: inner verdict: ${err.message}`);
  }
  if (!VALID_RELATIONS.includes(parsed.Relation)) throw new LlmError('unknown_relation', `${ERR_UNKNOWN_RELATION}: ${JSON.stringify(parsed.Relation)}`);
  if (typeof parsed.Confidence !== 'number') throw new LlmError('invalid_json', `${ERR_INVALID_JSON}: inner verdict: Confidence must be a number`);
  return {
    relation: parsed.Relation,
    confidence: parsed.Confidence,
    reasoning: typeof parsed.Reasoning === 'string' ? parsed.Reasoning : '',
    model: typeof parsed.Model === 'string' ? parsed.Model : '',
  };
}

/** Ejecuta una herramienta con `execFile` y devuelve su salida estándar. */
export function defaultRunCli(name, args, { signal, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(name, args, { signal, env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new LlmError('cli_not_installed', `${ERR_CLI_NOT_INSTALLED}: ${JSON.stringify(name)}`));
      if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
        return reject(new LlmError('timeout', signal?.reason?.name === 'TimeoutError' ? ERR_TIMEOUT : 'agent CLI call aborted'));
      }
      return reject(new LlmError('cli_failed', `CLI ${JSON.stringify(name)} exited ${err.code}: ${stderr}`));
    });
  });
}

/**
 * Ejecutor que delega la comparación en la CLI de GitHub Copilot en modo no
 * interactivo (`copilot -p <prompt> --silent`).
 */
export class CopilotRunner {
  /**
   * @param {object} [options]
   * @param {typeof defaultRunCli} [options.runCli] sustituible en pruebas
   * @param {NodeJS.ProcessEnv} [options.env]
   */
  constructor({ runCli = defaultRunCli, env = process.env } = {}) {
    this.runCli = runCli;
    this.env = env;
  }

  /**
   * @param {string} prompt
   * @param {AbortSignal} [signal]
   */
  async compare(prompt, signal) {
    const args = ['-p', prompt, '--silent'];
    const model = (this.env.ODIN_AGENT_MODEL ?? '').trim();
    if (model !== '') args.push('--model', model);
    const started = Date.now();
    const output = await this.runCli('copilot', args, { signal, env: this.env });
    const verdict = parseVerdict(output);
    if (verdict.model === '' && model !== '') verdict.model = model;
    return { ...verdict, duration_ms: Date.now() - started };
  }
}
