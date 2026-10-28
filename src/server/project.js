import { SOURCE_ALL_PROJECTS } from '../project/detect.js';
import { resolve } from '../project/resolution.js';
import { detectProject, inspectProject, listProjectNames, projectExists } from '../store/index.js';
import { goTrim } from '../store/text.js';
import { goQuote } from '../mcp/json.js';
import { parseBool, HttpError } from './http.js';

/** Error de nombre de proyecto inválido en la petición (400 `invalid_project`). */
const invalidProject = (message) => Object.assign(new Error(`invalid project name: ${message}`), { code: 'invalid_project_name' });

/**
 * Resuelve el proyecto de una petición. Los parámetros `project`, `all_projects`
 * y `cwd` de la consulta se interpretan como en los demás transportes.
 * @param {import('./context.js').RequestContext} ctx
 * @param {object} [options]
 * @param {'current'|'explicit'|'all'} [options.mode]
 * @param {boolean} [options.requireKnown] el proyecto explícito o fijado debe existir
 * @param {(dir: string) => import('../project/detect.js').DetectionResult} [options.detect]
 * @returns {{ res: import('../project/detect.js').DetectionResult, err: Error|null }}
 */
export function resolveRequestProject(ctx, { mode = 'current', requireKnown = true, detect } = {}) {
  const { store, query } = ctx;
  let resolutionMode = mode;
  const projectValues = query.getAll('project');
  const projectProvided = projectValues.length > 0;
  if (projectProvided && (projectValues.length !== 1 || goTrim(projectValues[0]) === '')) {
    return { res: {}, err: invalidProject('project parameter must be specified exactly once and must not be blank') };
  }
  const allValues = query.getAll('all_projects');
  if (allValues.length > 0) {
    const all = allValues.length === 1 ? parseBool(allValues[0]) : null;
    if (all === null) return { res: {}, err: invalidProject('all_projects must be a boolean') };
    if (all) {
      if (projectProvided) return { res: {}, err: invalidProject('project and all_projects cannot be used together') };
      resolutionMode = 'all';
    }
  }
  try {
    const res = resolve({
      mode: resolutionMode,
      explicit: query.get('project') ?? '',
      directory: query.get('cwd') ?? '',
      projectExists: (name) => projectExists(store, name),
      detect: detect ?? ((dir) => detectProject(store, dir)),
      requireKnownExplicit: requireKnown,
      requireKnownProcess: requireKnown,
      env: ctx.env,
    });
    return { res, err: null };
  } catch (err) {
    return { res: err.result ?? {}, err };
  }
}

/** Detector que no escribe el vínculo del repositorio (consultas de diagnóstico). */
export const inspectDetector = (store) => (dir) => inspectProject(store, dir);

/** Detector de capturas: usa el historial y exige un proyecto explícito en HOME. */
export function captureDetector(store, inspectOnly = false) {
  return (dir) => detectProject(store, dir, { inspectOnly, requireExplicitHomeProject: true });
}

/**
 * Convierte un error de resolución de proyecto en la respuesta HTTP que le corresponde.
 * @param {import('./context.js').RequestContext} ctx
 * @param {import('../project/detect.js').DetectionResult} res
 * @param {Error & { code?: string }} err
 * @returns {HttpError}
 */
export function projectResolutionError(ctx, res, err) {
  if (err.code === 'unknown_project') {
    let available;
    try {
      available = listProjectNames(ctx.store);
    } catch (listErr) {
      return new HttpError(500, `project resolution failed: ${listErr.message}`, { code: 'project_resolution_failed' });
    }
    return new HttpError(404, `project ${goQuote(err.projectName)} not found`, { code: 'unknown_project', available_projects: available.length ? available : null });
  }
  let code = 'project_resolution_failed';
  let status = 500;
  if (err.code === 'invalid_project_name') [code, status] = ['invalid_project', 400];
  if (err.code === 'ambiguous_project') [code, status] = ['ambiguous_project', 409];
  if (err.code === 'explicit_project_required') [code, status] = ['explicit_project_required', 409];
  if (err.code === 'project_transition') [code, status] = ['project_transition_conflict', 409];
  const fields = { code };
  if (err.code === 'project_transition') {
    fields.candidate_project = err.candidate;
    fields.available_projects = res.available_projects ?? null;
  }
  if (err.code === 'ambiguous_project') {
    fields.available_projects = res.available_projects ?? null;
    fields.project_source = res.source ?? '';
    fields.project_path = res.path ?? '';
  }
  return new HttpError(status, `project resolution failed: ${err.message}`, fields);
}

/**
 * Resuelve el proyecto o lanza el `HttpError` correspondiente.
 * @param {import('./context.js').RequestContext} ctx
 * @param {Parameters<typeof resolveRequestProject>[1]} [options]
 * @returns {import('../project/detect.js').DetectionResult}
 */
export function projectOrThrow(ctx, options) {
  const { res, err } = resolveRequestProject(ctx, options);
  if (err) throw projectResolutionError(ctx, res, err);
  return res;
}

/** Datos de proyecto de `current-project` y de la decisión de captura. */
export function currentProjectPayload(cwd, res) {
  const payload = {
    project: res.project ?? '',
    project_source: res.source ?? '',
    project_path: res.path ?? '',
    cwd,
    available_projects: res.available_projects ?? null,
  };
  if (res.warning) payload.warning = res.warning;
  if (res.error) payload.error_hint = res.error.message;
  return payload;
}

export { SOURCE_ALL_PROJECTS };
