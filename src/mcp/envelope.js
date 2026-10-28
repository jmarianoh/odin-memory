import { AMBIGUOUS_PROJECT_RECOVERY_TTL_SECONDS } from './activity.js';
import { goQuote, jsonMarshal, textResult } from './json.js';

/** Identificador de la sesión de reserva de un proyecto. */
export const defaultSessionId = (project) => (project ? `manual-save-${project}` : 'manual-save');

/**
 * Respuesta con el proyecto resuelto: `{ project, project_source, project_path, result, … }`.
 * @param {import('../project/detect.js').DetectionResult} res
 * @param {string} text
 * @param {Record<string, unknown>} [extra]
 */
export function respondWithProject(res, text, extra = {}) {
  const envelope = { project: res.project ?? '', project_source: res.source ?? '', project_path: res.path ?? '', result: text };
  if (res.warning) envelope.warning = res.warning;
  return textResult(jsonMarshal({ ...envelope, ...extra }));
}

const HINTS = {
  explicit_project_required: 'Set ODIN_PROJECT or .odin-memory/config.json project_name, or supply a supported explicit project; do not guess a folder name.',
  ambiguous_project:
    'Ask the user to choose one of available_projects, then retry the same write tool (mem_save, mem_save_prompt, or mem_session_summary) with project and project_choice_reason=user_selected_after_ambiguous_project; alternatively cd into the target repo or add repo .odin-memory/config.json.',
  database_generation_changed: 'Restart odin and retry.',
  invalid_project_choice: 'Use exactly one of available_projects after asking the user, or cd into the target repo, or add repo .odin-memory/config.json.',
  missing_recovery_token: 'Retry with the recovery_token returned by the ambiguous_project error after the user selects one available_projects value.',
  invalid_recovery_token:
    'Request a fresh ambiguous_project recovery_token and retry with the same session, cwd context, and selected available_projects value before it expires.',
  unknown_project: 'Use one of the available_projects values, or omit project to auto-detect.',
  invalid_project_config: 'Fix .odin-memory/config.json so project_name is a non-empty project name.',
  repository_binding_unavailable: "Configure the repository's .odin-memory/config.json with the intended canonical project.",
  invalid_project: 'Use a non-empty project name, not a path.',
  unknown_session: 'Start the session first, omit session_id, or retry with an existing session_id.',
  session_already_ended: 'Choose a new session ID and retry mem_session_start; ended sessions cannot be reopened.',
  session_project_mismatch: 'Use a project that matches the existing session, or omit session_id and write to a different project.',
  session_project_ownership_ambiguous: 'Use ownership rescue to classify the historical session before writing to a different project.',
  project_required: 'Use ownership rescue before updating this historical record, then retry the field update.',
  project_mismatch: "Switch to the observation's owning project, then retry the field update.",
};

/**
 * Error estructurado para el agente: `{ error_code, message, available_projects, hint? }`.
 * @param {string} code
 * @param {string} message
 * @param {string[]|null} [availableProjects]
 */
export function errorWithMeta(code, message, availableProjects = null) {
  const envelope = { error_code: code, message, available_projects: availableProjects ?? null };
  if (HINTS[code]) envelope.hint = HINTS[code];
  return { ...textResult(jsonMarshal(envelope)), isError: true };
}

/** Añade campos al objeto JSON del primer bloque de texto de un resultado. */
export function addErrorMetadata(result, metadata) {
  if (!result?.content?.length || Object.keys(metadata).length === 0) return result;
  let envelope;
  try {
    envelope = JSON.parse(result.content[0].text);
  } catch {
    return result;
  }
  result.content[0] = { type: 'text', text: jsonMarshal({ ...envelope, ...metadata }) };
  return result;
}

/**
 * Traduce un error al resolver el proyecto de una escritura (o de una lectura
 * que no es «desconocido») en el error estructurado que corresponde.
 * @param {import('./activity.js').SessionActivity|null} activity
 * @param {string} sessionId
 * @param {import('../project/detect.js').DetectionResult} res
 * @param {Error} err
 */
export function writeProjectErrorResult(activity, sessionId, res, err) {
  const available = res.available_projects ?? null;
  switch (err.code) {
    case 'explicit_project_required': return errorWithMeta('explicit_project_required', err.message, null);
    case 'project_transition': return errorWithMeta('project_transition_conflict', err.message, available);
    case 'project_history_unavailable': return errorWithMeta('project_history_unavailable', err.message, null);
    case 'database_generation_changed': return errorWithMeta('database_generation_changed', err.message, available);
    case 'project_ownership_ambiguous': return errorWithMeta('session_project_ownership_ambiguous', err.message, available);
    case 'repository_binding':
      return errorWithMeta(
        'repository_binding_unavailable',
        `Cannot determine project: ${err.message}. Configure the repository's .odin-memory/config.json with the intended canonical project.`,
        null,
      );
    default:
  }
  let code = 'ambiguous_project';
  if (err.code === 'invalid_config') code = 'invalid_project_config';
  switch (err.kind) {
    case 'invalid_project_choice':
      return err.projectName === ''
        ? errorWithMeta('invalid_project_choice', 'Project choice is empty; choose exactly one value from available_projects and retry with project_choice_reason=user_selected_after_ambiguous_project', err.availableProjects)
        : errorWithMeta('invalid_project_choice', `Project choice ${goQuote(err.projectName)} is not one of available_projects`, err.availableProjects);
    case 'missing_recovery_token':
      return errorWithMeta('missing_recovery_token', `project_choice_reason=user_selected_after_ambiguous_project for ${goQuote(err.projectName)} requires the recovery_token from the ambiguous_project error`, err.availableProjects);
    case 'invalid_recovery_token':
      return errorWithMeta('invalid_recovery_token', `recovery_token is invalid, stale, or not valid for selected project ${goQuote(err.projectName)}`, err.availableProjects);
    case 'invalid_explicit_project':
      return errorWithMeta('invalid_project', `Project ${goQuote(err.projectName)} is invalid: ${err.reason}`, available);
    case 'project_name_collision':
      return errorWithMeta(
        'project_name_collision',
        `Project ${goQuote(err.projectName)} collapses to stored bucket ${goQuote(err.normalized)}, but multiple exact candidates would share that bucket: ${err.collidingProjects.join(', ')}. Refuse write until the colliding project names are disambiguated.`,
        available,
      );
    case 'unknown_session':
      return addErrorMetadata(
        errorWithMeta('unknown_session', `Session ${goQuote(err.sessionId)} was provided but does not exist`, available),
        { invalid_session_id: err.sessionId, retry_without_session_id: true },
      );
    case 'unknown_project':
      return errorWithMeta('unknown_project', `Project ${goQuote(err.projectName)} is not backed by known context. Use an existing project, a matching session, repo .odin-memory/config.json, or ambiguous-project recovery.`, err.availableProjects);
    case 'session_project_mismatch':
      return errorWithMeta('session_project_mismatch', `Session ${goQuote(err.sessionId)} belongs to project ${goQuote(err.sessionProject)}, but request targeted ${goQuote(err.explicitProject)}`, available);
    default:
  }
  const result = errorWithMeta(code, `Cannot determine project: ${err.message}`, available);
  if (code === 'ambiguous_project' && activity) {
    addErrorMetadata(result, {
      recovery_token: activity.issueAmbiguousProjectRecoveryToken(sessionId?.trim() ? sessionId : defaultSessionId(''), res.available_projects ?? [], res.path ?? ''),
      token_ttl_seconds: AMBIGUOUS_PROJECT_RECOVERY_TTL_SECONDS,
    });
  }
  return result;
}

/**
 * Error estructurado de una lectura cuyo proyecto no se pudo resolver, con el
 * proyecto parcial en los metadatos.
 */
export function readProjectErrorResult(activity, res, err) {
  let result;
  if (err.kind === 'unknown_project') {
    result = errorWithMeta('unknown_project', `Project ${goQuote(err.projectName)} not found in store`, err.availableProjects);
  } else {
    result = writeProjectErrorResult(activity, defaultSessionId(''), res, err);
  }
  if (err.code === 'ambiguous_project') {
    addErrorMetadata(result, {
      hint: 'Ask the user to choose a project, then retry the same read tool with its project filter; alternatively cd into the target repo or configure repo .odin-memory/config.json. Do not retry a write tool to recover this read.',
    });
  }
  return addErrorMetadata(result, { project: res.project ?? '', project_source: res.source ?? '', project_path: res.path ?? '' });
}
