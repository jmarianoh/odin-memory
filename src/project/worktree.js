import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { goTrim } from '../store/text.js';

const GIT_TIMEOUT_MS = 2000;

/**
 * Raíz del árbol de trabajo de git que contiene `dir` (`git rev-parse
 * --show-toplevel`), o `''` si no es un repositorio, git falla o tarda más de 2 s.
 * @param {string} dir
 * @returns {string}
 */
export function detectGitWorktreeDir(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Ruta con los enlaces simbólicos resueltos y limpia; si no se puede resolver
 * (no existe), solo se limpia.
 * @param {string} path
 */
export function canonicalizePath(path) {
  if (path === '') return '';
  try {
    return normalize(realpathSync(path));
  } catch {
    return normalize(path);
  }
}

const runtimeCanonicalize = (path, platform = process.platform) => {
  const canonical = canonicalizePath(path);
  return platform === 'win32' ? canonical.toLowerCase() : canonical;
};

/**
 * Identidad estable del directorio de trabajo para enlazar sesiones de runtime:
 * la raíz de su árbol de trabajo de git (cada worktree enlazado conserva su
 * propia raíz) o, fuera de git, el propio directorio. Rutas absolutas y
 * canónicas; en Windows, en minúsculas.
 * @param {string} dir directorio; vacío equivale a `.`
 */
export function runtimeWorktreeDirectory(dir) {
  let target = goTrim(dir ?? '');
  if (target === '') target = '.';
  target = resolve(target);
  const root = detectGitWorktreeDir(target);
  return runtimeCanonicalize(root !== '' ? root : target);
}

/** Identidad canónica de una ruta (absoluta y con enlaces resueltos). */
export function directoryIdentity(path) {
  return runtimeCanonicalize(resolve(path));
}
