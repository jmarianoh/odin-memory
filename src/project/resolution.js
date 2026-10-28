import { normalizeProjectName } from './canonical.js';
import { SOURCE_ALL_PROJECTS, SOURCE_EXPLICIT_OVERRIDE, detectProjectFull, processOverride, SOURCE_PROCESS_OVERRIDE } from './detect.js';
import { UnknownProjectError } from './errors.js';

export const RESOLUTION_CURRENT = 'current';
export const RESOLUTION_EXPLICIT = 'explicit';
export const RESOLUTION_ALL = 'all';

function requireKnown(project, required, exists) {
  if (!required) return;
  if (!exists) throw new Error(`project existence check is required for ${JSON.stringify(project)}`);
  if (!exists(project)) throw new UnknownProjectError(project);
}

/**
 * Resuelve el proyecto de una operación. Orden: proyecto explícito, proyecto fijado
 * para el proceso (`--project` / `ODIN_PROJECT`) y detección por directorio.
 *
 * @param {object} options
 * @param {'current'|'explicit'|'all'} [options.mode] `all` no resuelve ningún proyecto; `explicit` exige uno
 * @param {string} [options.explicit]
 * @param {string} [options.processOverride] valor de `--project`
 * @param {string} [options.directory]
 * @param {(dir: string) => import('./detect.js').DetectionResult} [options.detect] por defecto `detectProjectFull`
 * @param {(name: string) => boolean} [options.projectExists]
 * @param {boolean} [options.requireKnownExplicit]
 * @param {boolean} [options.requireKnownProcess]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {import('./detect.js').DetectionResult}
 * @throws {Error} con la propiedad `result` cuando la detección falla (resultado parcial: ruta, candidatos…)
 */
export function resolve(options = {}) {
  if (options.mode === RESOLUTION_ALL) return { source: SOURCE_ALL_PROJECTS };
  const explicit = (options.explicit ?? '').trim();
  if (options.mode === RESOLUTION_EXPLICIT && explicit === '') {
    normalizeProjectName(options.explicit ?? ''); // lanza invalid_project_name: project is required
  }
  if (explicit !== '') {
    const project = normalizeProjectName(explicit);
    requireKnown(project, options.requireKnownExplicit, options.projectExists);
    return { project, source: SOURCE_EXPLICIT_OVERRIDE };
  }
  const override = processOverride(options.processOverride, options.env);
  if (override.ok) {
    const project = normalizeProjectName(override.value);
    requireKnown(project, options.requireKnownProcess, options.projectExists);
    return { project, source: SOURCE_PROCESS_OVERRIDE };
  }
  const result = (options.detect ?? detectProjectFull)(options.directory ?? '');
  if (result.error) throw Object.assign(result.error, { result });
  return result;
}
