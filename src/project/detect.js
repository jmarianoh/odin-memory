import { execFileSync } from 'node:child_process';
import { opendirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { goTrim } from '../store/text.js';
import { canonicalizeProjectName } from './canonical.js';
import {
  AmbiguousProjectError, ExplicitProjectRequiredError, InvalidConfigError, ProjectHistoryUnavailableError,
  ProjectTransitionError, RepositoryBindingError,
} from './errors.js';
import { SOURCE_UNBOUND_GIT, loadOrCreateRepositoryBinding, readRepositoryBinding } from './identity.js';
import { canonicalizePath, detectGitWorktreeDir, directoryIdentity } from './worktree.js';

// Cómo se determinó el proyecto.
export const SOURCE_GIT_REMOTE = 'git_remote';
export const SOURCE_GIT_ROOT = 'git_root';
export const SOURCE_GIT_CHILD = 'git_child';
export const SOURCE_DIR_BASENAME = 'dir_basename';
export const SOURCE_AMBIGUOUS = 'ambiguous';
export const SOURCE_EXPLICIT_OVERRIDE = 'explicit_override';
export const SOURCE_SESSION_PROJECT = 'session';
export const SOURCE_USER_SELECTED_AFTER_AMBIGUOUS_PROJECT = 'user_selected_after_ambiguous_project';
export const SOURCE_REQUEST_BODY = 'request_body';
export const SOURCE_CONFIG = 'config';
export const SOURCE_ALL_PROJECTS = 'all_projects';
export const SOURCE_PROCESS_OVERRIDE = 'process_override';
export const SOURCE_STORED_PROJECT = 'stored_project';
export { SOURCE_UNBOUND_GIT };

/** Variable de entorno que fija el proyecto de todo el proceso. */
export const ENV_PROJECT_OVERRIDE = 'ODIN_PROJECT';
/** Carpeta y archivo de configuración de proyecto. */
export const CONFIG_DIR = '.odin-memory';
export const CONFIG_FILE = 'config.json';

const GIT_TIMEOUT_MS = 2000;
const CHILD_SCAN_TIMEOUT_MS = 200;
/** Directorios que no se consideran al buscar repositorios hijos. */
const NOISE = new Set(['node_modules', 'vendor', '.venv', '__pycache__', 'target', 'dist', 'build', '.idea', '.vscode']);

/** Reloj del escaneo de hijos (sustituible en pruebas). */
export const scanClock = { now: () => Date.now() };

/**
 * @typedef {object} DetectionResult
 * @property {string} [project]
 * @property {string} [source]
 * @property {string} [path]
 * @property {string} [warning]
 * @property {Error} [error]
 * @property {string[]} [available_projects]
 */

/**
 * @typedef {object} DetectionOptions
 * @property {(directoryIdentity: string) => string[]} [historyLookup] proyectos con historial en el directorio
 * @property {boolean} [inspectOnly] no crea el vínculo del repositorio
 * @property {boolean} [requireExplicitHomeProject] exige proyecto explícito en el repositorio de HOME
 */

/**
 * Valor del proyecto fijado para el proceso: el explícito (p. ej. `--project`) o `ODIN_PROJECT`.
 * @param {string} [explicit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ value: string, ok: boolean }}
 */
export function processOverride(explicit, env = process.env) {
  const given = goTrim(explicit ?? '');
  if (given !== '') return { value: given, ok: true };
  const fromEnv = goTrim(env[ENV_PROJECT_OVERRIDE] ?? '');
  return fromEnv !== '' ? { value: fromEnv, ok: true } : { value: '', ok: false };
}

/** Nombre canónico, o `unknown` si queda vacío o parece una ruta. */
function normalize(name) {
  const n = canonicalizeProjectName(name);
  return n === '' || /[/\\]/.test(n) ? 'unknown' : n;
}

/** Nombre para listar proyectos disponibles: minúsculas y recorte, sin canonicalización completa. */
function normalizeAvailableProject(name) {
  const n = goTrim(name).toLowerCase();
  return n === '' || /[/\\]/.test(n) ? 'unknown' : n;
}

function fallbackProjectName(dir) {
  const base = basename(dir);
  return base === '' || base === '.' ? 'unknown' : normalize(base);
}

// ─── git ──────────────────────────────────────────────────────────────────────

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
  } catch {
    return null;
  }
}

/** Ruta absoluta devuelta por `git rev-parse --path-format=absolute <arg>`, o `''`. */
function gitRevParsePath(dir, argument) {
  const out = git(dir, ['rev-parse', '--path-format=absolute', argument]);
  if (out === null) return '';
  const path = join(out.trim()); // limpia la ruta
  return path === '.' || path === '' ? '' : path;
}

const detectGitCommonDir = (dir) => gitRevParsePath(dir, '--git-common-dir');

/** Raíz del repositorio principal aunque `dir` esté en un worktree enlazado. */
function detectGitRootDir(dir) {
  const commonDir = gitRevParsePath(dir, '--git-common-dir');
  if (commonDir === '') return '';
  const worktreeDir = gitRevParsePath(dir, '--show-toplevel');
  if (worktreeDir !== '' && gitRevParsePath(dir, '--git-dir') === commonDir) return worktreeDir;
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir.replace(/\.git$/, '');
}

/** Raíz del repositorio de `directory` (para enrutado), o `''`. */
export function observeGitRoot(directory) {
  return detectGitRootDir(directory);
}

/** Último segmento de la URL del remoto sin `.git` (`git@host:org/repo.git` → `repo`). */
export function extractRepoName(url) {
  const parts = url.replace(/\.git$/, '').split(/[/:]/).filter((p) => p !== '');
  return parts.length === 0 ? '' : goTrim(parts[parts.length - 1]);
}

function detectFromGitRemote(dir) {
  const out = git(dir, ['remote', 'get-url', 'origin']);
  return out === null ? '' : extractRepoName(goTrim(out));
}

// ─── configuración ────────────────────────────────────────────────────────────

function invalidConfigResult(path, detail) {
  return { project: '', source: SOURCE_CONFIG, path, error: new InvalidConfigError(detail) };
}

function normalizeConfigProjectName(projectName) {
  const trimmed = goTrim(projectName ?? '');
  if (trimmed === '') throw new InvalidConfigError('project_name is required');
  if (/[/\\]/.test(trimmed)) throw new InvalidConfigError('project_name must be a name, not a path');
  for (const ch of trimmed) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) throw new InvalidConfigError('project_name contains control characters');
  }
  return normalize(trimmed);
}

/** @returns {DetectionResult|null} `null` si no hay configuración en ese directorio */
function readConfigAt(projectDir) {
  const configPath = join(projectDir, CONFIG_DIR, CONFIG_FILE);
  let data;
  try {
    data = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return invalidConfigResult(projectDir, `read ${configPath}: ${err.message}`);
  }
  let config;
  try {
    config = JSON.parse(data);
  } catch (err) {
    return invalidConfigResult(projectDir, `parse ${configPath}: ${err.message}`);
  }
  const name = config?.project_name;
  if (name !== undefined && typeof name !== 'string') {
    return invalidConfigResult(projectDir, `parse ${configPath}: project_name must be a string`);
  }
  try {
    return { project: normalizeConfigProjectName(name), source: SOURCE_CONFIG, path: projectDir };
  } catch (err) {
    return invalidConfigResult(projectDir, err.message); // el prefijo queda duplicado, como en el original
  }
}

/** Busca la configuración más cercana subiendo desde `startDir` hasta `stopDir`. */
function readNearestConfigAtOrBelow(startDir, stopDir) {
  let current = join(startDir);
  const stop = join(stopDir);
  for (;;) {
    const found = readConfigAt(current);
    if (found) return found;
    if (current === stop) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function detectFromConfig(dir) {
  const absDir = canonicalizePath(resolve(dir));
  const worktreeRoot = canonicalizePath(detectGitWorktreeDir(absDir));
  return worktreeRoot !== '' ? readNearestConfigAtOrBelow(absDir, worktreeRoot) : readConfigAt(absDir);
}

// ─── hijos ────────────────────────────────────────────────────────────────────

/**
 * Repositorios git entre los hijos directos de `dir`, leyendo de uno en uno. Se
 * detiene al encontrar el segundo, o si pasan 200 ms (`timedOut`).
 * @returns {{ repos: string[], timedOut: boolean }}
 */
function scanChildren(dir) {
  const deadline = scanClock.now() + CHILD_SCAN_TIMEOUT_MS;
  let directory;
  try {
    directory = opendirSync(dir);
  } catch {
    return { repos: [], timedOut: false };
  }
  const repos = [];
  try {
    if (scanClock.now() > deadline) return { repos, timedOut: true };
    for (;;) {
      if (scanClock.now() > deadline) return { repos, timedOut: true };
      const entry = directory.readSync();
      if (entry === null) return { repos, timedOut: false };
      if (scanClock.now() > deadline) return { repos, timedOut: true };
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith('.') || NOISE.has(name)) continue;
      const childPath = join(dir, name);
      try {
        statSync(join(childPath, '.git'));
      } catch {
        continue;
      }
      if (scanClock.now() > deadline) return { repos, timedOut: true };
      repos.push(childPath);
      if (repos.length > 1) return { repos, timedOut: false };
    }
  } finally {
    directory.closeSync();
  }
}

// ─── repositorio de HOME ──────────────────────────────────────────────────────

/** En el repositorio de HOME exige un proyecto explícito salvo en subcarpetas con archivos versionados. */
function requireHomeProjectContext(dir, root) {
  let home;
  try {
    home = directoryIdentity(homedir());
  } catch (err) {
    throw new Error(`cannot determine HOME for project selection: ${err.message}`);
  }
  if (directoryIdentity(root) !== home) return;
  const toplevel = git(dir, ['rev-parse', '--show-toplevel']);
  if (toplevel === null) throw new Error('cannot verify HOME checkout for project selection');
  if (directoryIdentity(toplevel.trim()) !== home) return;
  const rel = relative(home, directoryIdentity(dir));
  if (rel === '.' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
  const tracked = git(dir, ['ls-files', '--cached', '-z', '--', '.']);
  if (tracked === null) throw new Error('cannot verify tracked files for HOME project selection; configure project_name explicitly');
  if (tracked.length === 0) throw new ExplicitProjectRequiredError();
}

// ─── detección ────────────────────────────────────────────────────────────────

/** @returns {DetectionResult|null} `null` si `dir` no está en un repositorio git */
function detectFromGitBinding(dir, options, historyDirectory) {
  const commonDir = detectGitCommonDir(dir);
  if (commonDir === '') return null;
  const root = detectGitRootDir(dir);
  if (root === '') {
    return { source: SOURCE_GIT_ROOT, error: new RepositoryBindingError('cannot determine the repository root; configure project_name explicitly') };
  }
  if (options.requireExplicitHomeProject) {
    try {
      requireHomeProjectContext(dir, root);
    } catch (err) {
      return { path: root, error: err };
    }
  }
  let legacyProject = normalize(basename(root));
  let source = SOURCE_GIT_ROOT;
  const remote = detectFromGitRemote(dir);
  if (remote !== '') {
    legacyProject = normalize(remote);
    source = SOURCE_GIT_REMOTE;
  }
  let binding;
  try {
    binding = readRepositoryBinding(commonDir);
  } catch (err) {
    return { source, path: root, error: err };
  }
  if (binding === null) {
    if (options.historyLookup) {
      let history;
      try {
        history = options.historyLookup(historyDirectory);
      } catch (err) {
        return { source, path: root, error: new ProjectHistoryUnavailableError(err.message) };
      }
      if (history.some((previous) => previous !== legacyProject)) {
        const choices = [...new Set([legacyProject, ...history])].sort();
        return { source, path: root, available_projects: choices, error: new ProjectTransitionError(legacyProject, history) };
      }
    }
    if (options.inspectOnly) return { project: legacyProject, source: SOURCE_UNBOUND_GIT, path: root };
    try {
      binding = loadOrCreateRepositoryBinding(commonDir, legacyProject);
    } catch (err) {
      return { source, path: root, error: err };
    }
  }
  return { project: binding.project, source, path: root };
}

function detect(dir, options, historyDirectory) {
  if (dir === '') dir = '.';
  if (dir.startsWith('-')) dir = `./${dir}`;

  const fromConfig = detectFromConfig(dir);
  if (fromConfig) return fromConfig;
  const fromGit = detectFromGitBinding(dir, options, historyDirectory);
  if (fromGit) return fromGit;

  const { repos, timedOut } = scanChildren(dir);
  if (!timedOut) {
    if (repos.length === 1) {
      const child = detect(repos[0], options, historyDirectory);
      if (child.error) return child;
      return { project: child.project, source: SOURCE_GIT_CHILD, path: child.path, warning: `auto-promoted child repository: ${child.project}` };
    }
    if (repos.length > 1) {
      return {
        project: '', source: SOURCE_AMBIGUOUS, path: resolve(dir), error: new AmbiguousProjectError(),
        available_projects: repos.map((c) => normalizeAvailableProject(basename(c))).sort(),
      };
    }
  }
  return { project: fallbackProjectName(dir), source: SOURCE_DIR_BASENAME, path: resolve(dir) };
}

/**
 * Determina el proyecto de un directorio. Orden:
 *  1. `.odin-memory/config.json` más cercano (dentro del worktree de git, o solo en `dir` fuera de git).
 *  2. Repositorio git: nombre del remoto `origin` o de la raíz, fijado en un vínculo
 *     persistente dentro del directorio común de git (`git_remote` / `git_root`).
 *  3. Un único repositorio hijo directo (`git_child`); varios → ambigüedad (`ambiguous`).
 *  4. El nombre del directorio (`dir_basename`).
 * Los errores van en `result.error` (no se lanzan).
 * @param {string} dir
 * @param {DetectionOptions} [options]
 * @returns {DetectionResult}
 */
export function detectProjectFull(dir, options = {}) {
  return detect(dir, options, directoryIdentity(dir));
}
