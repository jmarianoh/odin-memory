import { resolve } from '../project/resolution.js';
import { processOverride } from '../project/detect.js';
import { detectProject, projectExists, stats } from '../store/index.js';
import { goTrim } from '../store/text.js';
import { invalidExplicitProject, unknownProject } from './errors.js';

/** Detector de proyecto para capturas: con historial y exigiendo proyecto explícito en HOME. */
export const captureProjectDetector = (store) => (dir) => detectProject(store, dir, { requireExplicitHomeProject: true });

/** Directorio de trabajo del proceso (inyectable en pruebas con `ctx.cwd`). */
export const workingDirectory = (ctx) => (ctx.cwd ? ctx.cwd() : process.cwd());

/** Valor a citar en un error: el proyecto explícito o, si no, el del proceso. */
export function firstProjectValue(explicit, defaultProject, env = process.env) {
  if (goTrim(explicit ?? '') !== '') return explicit;
  const override = processOverride(defaultProject, env);
  return override.ok ? override.value : '';
}

/**
 * Resuelve el proyecto de una lectura: el explícito (debe existir), el fijado
 * para el proceso (debe existir) o el detectado desde el directorio de trabajo.
 * No lanza: devuelve el resultado (parcial si falla) y el error.
 * @param {{ store: import('../store/store.js').Store, config: { defaultProject?: string }, env?: NodeJS.ProcessEnv }} ctx
 * @param {string} explicit
 * @param {(dir: string) => import('../project/detect.js').DetectionResult} [detect]
 * @param {boolean} [requireKnownProcess]
 * @returns {{ res: import('../project/detect.js').DetectionResult, err: Error|null }}
 */
export function resolveReadProject(ctx, explicit, detect, requireKnownProcess = true) {
  const { store, config } = ctx;
  try {
    const res = resolve({
      mode: 'current',
      explicit,
      processOverride: config.defaultProject ?? '',
      directory: workingDirectory(ctx),
      projectExists: (name) => projectExists(store, name),
      detect: detect ?? ((dir) => detectProject(store, dir)),
      requireKnownExplicit: goTrim(explicit ?? '') !== '',
      requireKnownProcess,
      env: ctx.env,
    });
    return { res, err: null };
  } catch (err) {
    const partial = err.result ?? {};
    if (err.code === 'unknown_project') return { res: partial, err: unknownProject(err.projectName, stats(store).projects) };
    if (err.code === 'invalid_project_name') {
      return { res: partial, err: invalidExplicitProject(firstProjectValue(explicit, config.defaultProject ?? '', ctx.env), err.message) };
    }
    return { res: partial, err };
  }
}

/** Si la detección fue ambigua y la observación tiene proyecto propio, se usa el almacenado. */
export function storedProjectFallback(observation, res, err) {
  if (err?.code !== 'ambiguous_project' || !observation || observation.project == null || goTrim(observation.project) === '') {
    return { res, err };
  }
  return { res: { ...res, project: observation.project, source: 'stored_project', path: '', error: undefined }, err: null };
}
