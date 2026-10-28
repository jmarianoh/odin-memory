import { resolve as resolveProject } from '../project/resolution.js';
import { detectProject } from '../store/project-history.js';
import { projectExists } from '../store/projects.js';
import { goTrim } from '../store/text.js';

/**
 * Resuelve el proyecto de una operación de lectura de la CLI. El proyecto
 * explícito o el del proceso deben existir cuando `requireKnownOverrides`; la
 * detección por directorio sigue siendo válida antes de la primera escritura.
 * @param {import('./runtime.js').Cli} cli
 * @param {import('../store/store.js').Store} store
 * @param {string} explicit
 * @param {boolean} requireKnownOverrides
 * @returns {string}
 */
export function resolveCliProject(cli, store, explicit, requireKnownOverrides) {
  const result = resolveProject({
    mode: 'current',
    explicit,
    directory: cli.cwd(),
    detect: (dir) => detectProject(store, dir),
    projectExists: (name) => projectExists(store, name),
    requireKnownExplicit: requireKnownOverrides && goTrim(explicit ?? '') !== '',
    requireKnownProcess: requireKnownOverrides,
    env: cli.env,
  });
  return result.project ?? '';
}

/**
 * Como `resolveCliProject`, pero `all` pide todos los proyectos (cadena vacía) y
 * no se combina con un proyecto explícito.
 * @param {import('./runtime.js').Cli} cli
 * @param {import('../store/store.js').Store} store
 * @param {string} explicit
 * @param {boolean} all
 * @param {boolean} requireKnownOverrides
 * @returns {string}
 */
export function resolveCliProjectScope(cli, store, explicit, all, requireKnownOverrides) {
  if (all) {
    if (goTrim(explicit ?? '') !== '') throw new Error('--all and --project cannot be used together');
    return '';
  }
  return resolveCliProject(cli, store, explicit, requireKnownOverrides);
}

/**
 * Valor de `--project` en `args[index + 1]`: no vacío y que no parezca otra opción.
 * @param {string[]} args
 * @param {number} index
 * @returns {string}
 */
export function requiredProjectValue(args, index) {
  const value = index + 1 < args.length ? goTrim(args[index + 1]) : '';
  if (value === '' || value.startsWith('-')) throw new Error('--project requires a non-empty value');
  return value;
}
