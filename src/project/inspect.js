import { lstatSync, opendirSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { goTrim } from '../store/text.js';
import { normalizeProjectName } from './canonical.js';
import { SOURCE_CONFIG, SOURCE_DIR_BASENAME, SOURCE_GIT_CHILD, SOURCE_GIT_REMOTE, SOURCE_GIT_ROOT, detectProjectFull } from './detect.js';
import { RepositoryBindingError } from './errors.js';
import { SOURCE_UNBOUND_GIT } from './identity.js';
import { canonicalizePath, directoryIdentity } from './worktree.js';

/** Sube desde `directory` buscando metadatos de git que la detección por nombre no habría visto. */
function validateBasenameInspection(directory, env) {
  let current = canonicalizePath(resolve(directory));
  const start = directoryIdentity(current);
  const ceilings = new Set(
    (env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter).filter((c) => c !== '' && isAbsolute(c)).map((c) => directoryIdentity(c)),
  );
  for (;;) {
    const identity = directoryIdentity(current);
    if (identity !== start && ceilings.has(identity)) return;
    try {
      lstatSync(join(current, '.git'));
      throw new RepositoryBindingError();
    } catch (err) {
      if (err instanceof RepositoryBindingError) throw err;
      if (err.code !== 'ENOENT') throw new RepositoryBindingError(`cannot verify Git metadata: ${err.message}`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/**
 * Determina el proyecto de un directorio sin escribir nada (no crea vínculos de
 * repositorio) y solo con orígenes verificables: configuración, remoto/raíz de
 * git con vínculo o repositorio hijo con vínculo. Es la base de los hooks, que
 * no deben adivinar. Lanza si el directorio no es utilizable o si el resultado
 * no está respaldado.
 * @param {string} directory
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('./detect.js').DetectionResult}
 */
export function inspectLocalProject(directory, env = process.env) {
  if (goTrim(directory ?? '') === '' || String(directory).includes('\0')) throw new Error('inspection requires a usable cwd');
  let directoryHandle;
  try {
    if (!statSync(directory).isDirectory()) throw new Error('inspection requires a readable directory');
    directoryHandle = opendirSync(directory);
    directoryHandle.readSync();
  } finally {
    directoryHandle?.closeSync();
  }
  const options = { inspectOnly: true, requireExplicitHomeProject: true };
  const result = detectProjectFull(directory, options);
  if (result.error) throw result.error;
  if (result.source === SOURCE_GIT_CHILD) {
    const child = detectProjectFull(result.path, options);
    if (child.error) throw child.error;
    if (child.source === SOURCE_UNBOUND_GIT || child.source === SOURCE_DIR_BASENAME || child.project !== result.project) {
      throw new RepositoryBindingError();
    }
  }
  switch (result.source) {
    case SOURCE_DIR_BASENAME:
      validateBasenameInspection(directory, env);
      break;
    case SOURCE_CONFIG: case SOURCE_GIT_REMOTE: case SOURCE_GIT_ROOT: case SOURCE_GIT_CHILD:
      break;
    default:
      throw new RepositoryBindingError();
  }
  return { ...result, project: normalizeProjectName(result.project) };
}
