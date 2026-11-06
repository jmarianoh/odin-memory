import { normalizeProject } from '../project/canonical.js';
import {
  SOURCE_CONFIG, SOURCE_EXPLICIT_OVERRIDE, SOURCE_SESSION_PROJECT, SOURCE_USER_SELECTED_AFTER_AMBIGUOUS_PROJECT, detectProjectFull, processOverride,
} from '../project/detect.js';
import { resolve } from '../project/resolution.js';
import {
  SESSION_OWNERSHIP_PROJECT_OWNED, SESSION_OWNERSHIP_SHARED, getSession, projectExists, registerSessionWithProvenance, stats, storeError,
} from '../store/index.js';
import { goTrim } from '../store/text.js';
import { resolveAmbiguousChoicePath } from './activity.js';
import {
  invalidExplicitProject, invalidProjectChoice, invalidRecoveryToken, missingRecoveryToken, projectNameCollision, sessionProjectMismatch,
  unknownProject, unknownSession,
} from './errors.js';
import { goQuote } from './json.js';
import { captureProjectDetector, resolveReadProject, workingDirectory } from './projects.js';
import { captureProjectEvidence } from './session-helpers.js';

// Resolución del proyecto de una ESCRITURA. A diferencia de las lecturas, la
// escritura jamás adivina: el proyecto sale de la sesión, de una configuración
// o de un repositorio, y una elección explícita solo se admite como
// recuperación de una ambigüedad genuina (con su token) o si el proyecto ya
// existe. Cada función devuelve `{ res, err }` (resultado, posiblemente parcial,
// y error o `null`) en lugar de lanzar.

const SELECTED = SOURCE_USER_SELECTED_AFTER_AMBIGUOUS_PROJECT;
const isAmbiguous = (err) => err?.code === 'ambiguous_project';
const isInvalidConfig = (err) => err?.code === 'invalid_config';

/**
 * Proyecto detectado desde el directorio de trabajo (o desde `directory`, el de una sola llamada),
 * exigiendo proyecto explícito en HOME.
 */
export function resolveWriteProject(ctx, directory = '') {
  const res = captureProjectDetector(ctx.store)(directory === '' ? workingDirectory(ctx) : directory);
  return { res, err: res.error ?? null };
}

/** Aplica el proyecto fijado para el proceso (`ODIN_PROJECT` / `--project`) si lo hay. */
export function processProjectResult(ctx) {
  const defaultProject = ctx.config.defaultProject ?? '';
  if (!processOverride(defaultProject, ctx.env).ok) return { ok: false };
  try {
    return { ok: true, res: resolve({ mode: 'current', processOverride: defaultProject, env: ctx.env }), err: null };
  } catch (err) {
    return { ok: true, res: {}, err };
  }
}

/** Proyecto de escritura sin elección: proceso, configuración o detección. */
export function resolveWriteProjectWithProcessOverride(ctx, requireKnownProcess) {
  return resolveReadProject(ctx, '', captureProjectDetector(ctx.store), requireKnownProcess);
}

export const containsProjectChoice = (available, choice) => (available ?? []).some((c) => goTrim(c) === goTrim(choice));

/** Proyectos disponibles que, normalizados, coinciden con la elección. Si son menos de dos devuelve lista vacía. */
export function normalizedProjectCollisions(candidates, choice) {
  const normalized = normalizeProject(goTrim(choice)).normalized;
  if (normalized === '') return ['', []];
  const colliding = [];
  const seen = new Set();
  for (const candidate of candidates ?? []) {
    const trimmed = goTrim(candidate);
    if (trimmed === '' || normalizeProject(trimmed).normalized !== normalized || seen.has(trimmed)) continue;
    seen.add(trimmed);
    colliding.push(trimmed);
  }
  return colliding.length < 2 ? [normalized, []] : [normalized, colliding];
}

/**
 * Recupera una ambigüedad con la elección del usuario: la elección debe ser uno de
 * los proyectos disponibles, no chocar al normalizarse y venir con un token válido.
 * @param {(res: object, choice: string) => { provided: boolean, valid: boolean }|null} validateToken
 */
export function resolveWriteProjectWithChoice(ctx, projectChoice, reason, validateToken, directory = '') {
  const { res, err } = resolveWriteProject(ctx, directory);
  if (!err) return { res, err: null }; // lo no ambiguo manda: la elección se ignora
  if (!isAmbiguous(err)) return { res, err };
  if (goTrim(reason) !== SELECTED) return { res, err };

  const choice = goTrim(projectChoice);
  if (choice === '' || !containsProjectChoice(res.available_projects, choice)) {
    return { res, err: invalidProjectChoice(choice, res.available_projects) };
  }
  const [normalized, colliding] = normalizedProjectCollisions(res.available_projects, choice);
  if (colliding.length > 1) return { res, err: projectNameCollision(choice, normalized, colliding) };
  const { provided, valid } = validateToken ? validateToken(res, choice) : { provided: false, valid: false };
  if (!provided) return { res, err: missingRecoveryToken(choice, res.available_projects) };
  if (!valid) return { res, err: invalidRecoveryToken(choice, res.available_projects) };
  return {
    res: {
      ...res,
      project: choice,
      source: SELECTED,
      path: resolveAmbiguousChoicePath(res.path, choice),
      warning: 'project selected by user after ambiguous_project recovery',
    },
    err: null,
  };
}

export function resolveWriteProjectWithChoiceAndProcessOverride(ctx, projectChoice, reason, validateToken) {
  if (goTrim(projectChoice) === '') return resolveWriteProjectWithProcessOverride(ctx, false);
  return resolveWriteProjectWithChoice(ctx, projectChoice, reason, validateToken);
}

/** Nombre explícito válido y normalizado, o el error de proyecto inválido. */
export function normalizeExplicitWriteProject(projectName) {
  const trimmed = goTrim(projectName);
  const invalid = (reason) => ({ project: '', err: invalidExplicitProject(projectName, reason) });
  if (trimmed === '') return invalid('project is required');
  if (/[/\\]/.test(trimmed)) return invalid('project must be a name, not a path');
  for (const ch of trimmed) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return invalid('project contains control characters');
  }
  const project = normalizeProject(trimmed).normalized;
  if (project === '') return invalid('project is required');
  return { project, err: null };
}

const hasSeparatorCollapse = (rawProject, normalizedProject) => {
  const lower = goTrim(rawProject).toLowerCase();
  return lower !== '' && lower !== normalizedProject;
};

function uniqueTrimmed(...names) {
  const seen = new Set();
  const result = [];
  for (const name of names) {
    const trimmed = goTrim(name);
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** Choque de una elección explícita cuyo nombre se colapsa al normalizarse. */
function explicitWriteProjectCollision(rawProject, normalizedProject, sessionProject, cwdRes) {
  rawProject = goTrim(rawProject);
  if (rawProject === '' || normalizedProject === '' || !hasSeparatorCollapse(rawProject, normalizedProject)) return null;
  if (sessionProject !== '' && sessionProject === normalizedProject) {
    return projectNameCollision(rawProject, normalizedProject, [rawProject, normalizedProject]);
  }
  if (cwdRes.source === SOURCE_CONFIG) {
    const canonical = goTrim(cwdRes.project ?? '');
    if (canonical === rawProject) return null;
    if (normalizeProject(canonical).normalized === normalizedProject) {
      return projectNameCollision(rawProject, normalizedProject, uniqueTrimmed(rawProject, canonical, normalizedProject));
    }
  }
  return null;
}

/** Proyectos conocidos para ofrecer al agente: los del almacén más los del contexto. */
export function knownWriteProjects(ctx, context) {
  return uniqueTrimmed(...stats(ctx.store).projects, context.project, ...(context.available_projects ?? []));
}

/** Error al escribir un proyecto distinto del dueño de la sesión, o `null` si se admite. */
function sessionProjectResolutionError(sessionId, sessionProject, sessionMode, requested) {
  if (sessionProject === '' || sessionProject === requested || sessionMode === SESSION_OWNERSHIP_SHARED) return null;
  if (sessionMode === SESSION_OWNERSHIP_PROJECT_OWNED) return sessionProjectMismatch(sessionId, sessionProject, requested);
  return storeError(
    'project_ownership_ambiguous',
    `session ${goQuote(sessionId)} has unclassified ownership for ${goQuote(sessionProject)} and cannot accept ${goQuote(requested)}`,
  );
}

/**
 * Proyecto de una escritura con la precedencia completa: parámetro explícito,
 * sesión existente, configuración o detección del directorio.
 * @param {object} ctx
 * @param {string} projectChoice
 * @param {boolean} explicitProjectProvided la clave `project` vino en la petición
 * @param {string} reason `project_choice_reason`
 * @param {string} sessionId identidad ya elegida por el llamador
 * @param {Function|null} validateToken
 * @param {boolean} allowUnknownSessionRecovery admite una sesión no registrada solo para recuperar una ambigüedad
 */
export function resolveSaveWriteProjectForSession(ctx, projectChoice, explicitProjectProvided, reason, sessionId, validateToken, allowUnknownSessionRecovery) {
  const { store } = ctx;
  const trimmedSessionId = sessionId;
  const trimmedChoice = goTrim(projectChoice);
  const trimmedReason = goTrim(reason);
  let sessionProject = '';
  let sessionMode = '';
  let sessionPath = '';

  if (trimmedSessionId !== '') {
    const sess = getSession(store, trimmedSessionId);
    if (!sess) {
      if (!allowUnknownSessionRecovery) return { res: {}, err: unknownSession(sessionId) };
      // Solo una ambigüedad genuina del detector admite un identificador no registrado.
      const detected = resolveWriteProject(ctx);
      if (!isAmbiguous(detected.err)) return { res: {}, err: unknownSession(trimmedSessionId) };
      if (trimmedReason !== SELECTED || trimmedChoice === '') return detected;
      const chosen = resolveWriteProjectWithChoice(ctx, projectChoice, reason, validateToken);
      if (chosen.err) return chosen;
      const normalized = normalizeExplicitWriteProject(chosen.res.project);
      if (normalized.err) return { res: chosen.res, err: normalized.err };
      try {
        registerSessionWithProvenance(store, {
          id: trimmedSessionId, project: normalized.project, directory: chosen.res.path, mode: SESSION_OWNERSHIP_PROJECT_OWNED,
          provenance: captureProjectEvidence(ctx, chosen.res, trimmedSessionId, projectChoice, ''),
        });
      } catch (err) {
        return { res: chosen.res, err };
      }
      return chosen;
    }
    const normalizedSession = normalizeExplicitWriteProject(sess.project);
    if (normalizedSession.err) return { res: {}, err: normalizedSession.err };
    sessionProject = normalizedSession.project;
    sessionMode = goTrim(sess.ownership_mode);
    sessionPath = goTrim(sess.directory);
  }

  if (explicitProjectProvided && trimmedChoice === '') {
    return { res: {}, err: invalidExplicitProject(projectChoice, 'project is required') };
  }

  if (trimmedChoice !== '') {
    const cwdRes = detectProjectFull(workingDirectory(ctx), { inspectOnly: true });
    const cwdErr = cwdRes.error ?? null;
    if (cwdErr) {
      if (isInvalidConfig(cwdErr)) return { res: cwdRes, err: cwdErr };
      if (isAmbiguous(cwdErr)) {
        const [normalized, colliding] = normalizedProjectCollisions(cwdRes.available_projects, trimmedChoice);
        if (colliding.length > 1) return { res: cwdRes, err: projectNameCollision(trimmedChoice, normalized, colliding) };
      } else {
        return { res: cwdRes, err: cwdErr };
      }
    }

    const explicit = normalizeExplicitWriteProject(projectChoice);
    if (explicit.err) return { res: {}, err: explicit.err };
    const project = explicit.project;
    const collision = explicitWriteProjectCollision(trimmedChoice, project, sessionProject, cwdRes);
    if (collision) return { res: cwdRes, err: collision };
    const mismatch = sessionProjectResolutionError(trimmedSessionId, sessionProject, sessionMode, project);
    if (mismatch) return { res: {}, err: mismatch };

    if (isAmbiguous(cwdErr) && trimmedReason === SELECTED) return resolveWriteProjectWithChoice(ctx, projectChoice, reason, validateToken);
    if (projectExists(store, project)) {
      if (hasSeparatorCollapse(trimmedChoice, project)) {
        return { res: cwdRes, err: projectNameCollision(trimmedChoice, project, [trimmedChoice, project]) };
      }
      return { res: { project, source: SOURCE_EXPLICIT_OVERRIDE, path: '' }, err: null };
    }
    if (sessionProject !== '') return { res: { project, source: SOURCE_EXPLICIT_OVERRIDE, path: sessionPath }, err: null };

    if (cwdErr) {
      if (isAmbiguous(cwdErr) && trimmedReason === SELECTED) return resolveWriteProjectWithChoice(ctx, projectChoice, reason, validateToken);
      return { res: cwdRes, err: cwdErr };
    }
    if (cwdRes.source === SOURCE_CONFIG) {
      const configured = normalizeExplicitWriteProject(cwdRes.project);
      if (configured.err) return { res: {}, err: configured.err };
      if (configured.project === project) return { res: { project, source: SOURCE_EXPLICIT_OVERRIDE, path: cwdRes.path }, err: null };
    }
    const known = knownWriteProjects(ctx, cwdRes);
    return { res: { available_projects: known }, err: unknownProject(project, known) };
  }

  // Sin elección explícita (la rama `reason == selected && choice != ''` de la
  // referencia es inalcanzable aquí: ya se atendió arriba).
  if (sessionProject !== '') return { res: { project: sessionProject, source: SOURCE_SESSION_PROJECT, path: sessionPath }, err: null };
  return resolveWriteProject(ctx);
}

export function resolveSaveWriteProject(ctx, projectChoice, explicitProjectProvided, reason, sessionId, validateToken) {
  return resolveSaveWriteProjectForSession(ctx, projectChoice, explicitProjectProvided, reason, goTrim(sessionId), validateToken, true);
}

/** Como `resolveSaveWriteProject`, aplicando antes el proyecto fijado para el proceso si no hay nada más. */
export function resolveSaveWriteProjectWithProcessOverride(ctx, projectChoice, explicitProjectProvided, reason, sessionId, validateToken) {
  if (!explicitProjectProvided && goTrim(projectChoice) === '' && goTrim(sessionId) === '' && goTrim(reason) === '') {
    const fixed = processProjectResult(ctx);
    if (fixed.ok) {
      if (fixed.err) return { res: {}, err: fixed.err };
      return resolveWriteProjectWithProcessOverride(ctx, false);
    }
  }
  return resolveSaveWriteProject(ctx, projectChoice, explicitProjectProvided, reason, sessionId, validateToken);
}
