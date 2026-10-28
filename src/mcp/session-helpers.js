import { normalizeProject } from '../project/canonical.js';
import {
  SOURCE_EXPLICIT_OVERRIDE, SOURCE_PROCESS_OVERRIDE, SOURCE_SESSION_PROJECT, SOURCE_USER_SELECTED_AFTER_AMBIGUOUS_PROJECT, processOverride,
} from '../project/detect.js';
import { runtimeWorktreeDirectory } from '../project/worktree.js';
import { lookup } from '../hostbind/index.js';
import {
  SESSION_OWNERSHIP_SHARED, activeRuntimeSessions, captureProjectProvenance, createSession, getSession, resolveManualSession, resolveRuntimeSession,
} from '../store/index.js';
import { goTrim } from '../store/text.js';
import { defaultSessionId } from './envelope.js';
import { goQuote } from './json.js';
import { workingDirectory } from './projects.js';

/** Directorio de trabajo del proceso; `''` si no se puede determinar. */
export function currentWorkingDirectory(ctx) {
  try {
    return workingDirectory(ctx);
  } catch {
    return '';
  }
}

/** Clave de sesión de un árbol de trabajo: sin cambiar la identidad del proyecto. */
export function runtimeSessionDirectory(ctx, directory = '') {
  return runtimeWorktreeDirectory(goTrim(directory) === '' ? currentWorkingDirectory(ctx) : directory);
}

/**
 * Evidencia de captura de un resultado de resolución de proyecto. Es solo
 * evidencia local: nunca concede propiedad.
 * @returns {{ source: string, directory: string, raw_project?: string }}
 */
export function captureProjectEvidence(ctx, res, sessionId, rawProject, defaultProject) {
  const evidence = { source: res.source ?? '', directory: currentWorkingDirectory(ctx) };
  switch (res.source) {
    case SOURCE_SESSION_PROJECT: {
      const inherited = captureProjectProvenance(ctx.store, 'session', sessionId);
      if (inherited) {
        evidence.source = inherited.source;
        evidence.raw_project = inherited.raw_project;
        return evidence;
      }
      evidence.source = 'unknown';
      return evidence;
    }
    case SOURCE_EXPLICIT_OVERRIDE:
    case SOURCE_USER_SELECTED_AFTER_AMBIGUOUS_PROJECT:
      evidence.raw_project = rawProject;
      return evidence;
    case SOURCE_PROCESS_OVERRIDE: {
      const override = processOverride(defaultProject ?? '', ctx.env);
      if (override.ok) evidence.raw_project = override.value;
      return evidence;
    }
    default:
      return evidence;
  }
}

/** Registra (si falta) la sesión implícita con el directorio de trabajo; un fallo se ignora. */
export function ensureImplicitSession(ctx, sessionId, project, evidence = null) {
  try {
    createSession(ctx.store, sessionId, project, currentWorkingDirectory(ctx), SESSION_OWNERSHIP_SHARED, evidence);
  } catch {
    // Mejor esfuerzo: la escritura posterior informa del problema real.
  }
}

const HOST_BINDING_ERROR =
  'host session binding cannot resolve a live session for the requested project; provide session_id explicitly or restart the host session to refresh its binding';

/**
 * Resuelve un `session_id` omitido a través del proceso anfitrión que lanzó este
 * servidor: sus hooks publican qué sesión atiende y el servidor lo lee por su
 * proceso padre, de modo que las escrituras siguen vinculadas tras `/clear`,
 * reanudar o bifurcar. `''` = sin vínculo verificado; un vínculo verificado que
 * no se puede resolver rechaza la escritura en lugar de caer en otra sesión.
 * @returns {string}
 * @throws {Error}
 */
export function resolveHostBoundSession(ctx, project) {
  const { store } = ctx;
  const root = lookup(store.dataDir, ctx.hostPid ?? process.ppid, ctx.hostbind);
  if (root === null) return '';
  const bound = getSession(store, root);
  if (!bound) throw new Error(HOST_BINDING_ERROR);
  const wanted = normalizeProject(project).normalized;
  const owner = normalizeProject(bound.project).normalized;
  if (wanted === '' || owner !== wanted) throw new Error(HOST_BINDING_ERROR);
  let id;
  try {
    id = resolveRuntimeSession(store, bound.id, bound.project, bound.directory, bound.ownership_mode);
  } catch {
    throw new Error(HOST_BINDING_ERROR);
  }
  if (!id) throw new Error(HOST_BINDING_ERROR);
  return id;
}

/**
 * Resuelve un `session_id` omitido sin elegir entre sesiones concurrentes: el
 * directorio solo acota los candidatos; el identificador persistido es la única identidad.
 * @returns {string}
 * @throws {Error}
 */
export function resolveFallbackSessionId(ctx, project, evidence = null) {
  const bound = resolveHostBoundSession(ctx, project);
  if (bound !== '') return bound;
  const { store } = ctx;
  let ids = null;
  try {
    ids = activeRuntimeSessions(store, project, runtimeSessionDirectory(ctx));
  } catch {
    ids = null;
  }
  if (ids !== null) {
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) {
      throw new Error(
        'multiple active runtime sessions match the current project and directory; provide session_id, end other active matching sessions, ' +
          `or save independently with odin save. The resolved project is ${goQuote(project)}; pass that exact name as the --project value ` +
          'and never invent another. This writes to an independent project manual-save session and does not bind it to this MCP session',
      );
    }
  }
  return resolveManualSession(store, project, currentWorkingDirectory(ctx), evidence);
}

export { defaultSessionId };
