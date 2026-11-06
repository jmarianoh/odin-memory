import { basename } from 'node:path';
import { canonicalizeProjectName, normalizeProject } from '../../project/canonical.js';
import { SOURCE_USER_SELECTED_AFTER_AMBIGUOUS_PROJECT } from '../../project/detect.js';
import {
  SESSION_OWNERSHIP_SHARED, addObservation, addPrompt, contentTruncation, endSession, getObservation, observationState, passiveCapture,
  registerSessionWithProvenance,
} from '../../store/index.js';
import { goTrim, truncate } from '../../store/text.js';
import { strArg } from '../args.js';
import { addErrorMetadata, defaultSessionId, errorWithMeta, respondWithProject, writeProjectErrorResult } from '../envelope.js';
import { errorResult, goQuote } from '../json.js';
import { captureProjectDetector, workingDirectory } from '../projects.js';
import { promptWorkspaceDirectory, resolvePromptWorkspaceProject } from '../prompt-workspace.js';
import { captureProjectEvidence, ensureImplicitSession, resolveFallbackSessionId, runtimeSessionDirectory } from '../session-helpers.js';
import { truncationWarning } from '../warnings.js';
import {
  resolveSaveWriteProjectWithProcessOverride, resolveWriteProject, resolveWriteProjectWithProcessOverride,
} from '../write-projects.js';
import { prepareWriteProject, recoveryTokenValidator } from '../write-support.js';

const SELECTED = SOURCE_USER_SELECTED_AFTER_AMBIGUOUS_PROJECT;

export function savePromptTool(ctx) {
  return (args) => {
    const { store, activity, config } = ctx;
    const content = strArg(args, 'content');
    const { directory: workspaceDir, error: workspaceError } = promptWorkspaceDirectory(args);
    if (workspaceError) return errorResult(`Invalid workspace directory: ${workspaceError}`);
    let sessionId = strArg(args, 'session_id');
    let projectChoice = strArg(args, 'project');
    let reason = strArg(args, 'project_choice_reason');
    const { recoverySessionId, validate } = recoveryTokenValidator(ctx, args);

    let outcome = { res: {}, err: null };
    if (goTrim(sessionId) !== '') {
      // Los prompts ordinarios conservan la autoridad de la sesión: un motivo de
      // recuperación por sí solo no admite una elección fuera de una ambigüedad genuina.
      if (goTrim(reason) === SELECTED) {
        outcome = resolveWriteProject(ctx);
        if (outcome.err?.code === 'invalid_config') return writeProjectErrorResult(activity, recoverySessionId, outcome.res, outcome.err);
      }
      if (outcome.err?.code !== 'ambiguous_project') {
        projectChoice = '';
        reason = '';
      }
      outcome = resolveSaveWriteProjectWithProcessOverride(ctx, projectChoice, goTrim(projectChoice) !== '', reason, sessionId, validate);
    } else {
      outcome = resolvePromptWorkspaceProject(ctx, workspaceDir, projectChoice, reason, validate);
    }
    if (outcome.err) return writeProjectErrorResult(activity, recoverySessionId, outcome.res, outcome.err);
    const res = outcome.res;
    const project = normalizeProject(res.project ?? '').normalized;

    // La evidencia se captura antes de registrar, para que una sesión implícita nueva la conserve.
    const provenance = captureProjectEvidence(ctx, res, sessionId, projectChoice, config.defaultProject);
    if (workspaceDir !== '') provenance.directory = workspaceDir;
    if (sessionId === '') {
      try {
        sessionId = resolveFallbackSessionId(ctx, project, provenance, workspaceDir);
      } catch (err) {
        return errorResult(`Failed to save prompt: ${err.message}`);
      }
    }
    ensureImplicitSession(ctx, sessionId, project, provenance, workspaceDir);

    const truncation = contentTruncation(store, content);
    try {
      addPrompt(store, { project_provenance: provenance, session_id: sessionId, content, project });
    } catch (err) {
      return errorResult(`Failed to save prompt: ${err.message}`);
    }
    activity.recordPrompt(sessionId, project, content);
    const msg = `Prompt saved: ${goQuote(truncate(content, 80))}${truncationWarning(truncation)}`;
    return respondWithProject({ ...res, project }, msg, { truncation });
  };
}

export function sessionSummaryTool(ctx) {
  return (args) => {
    const { store, activity, config } = ctx;
    const content = strArg(args, 'content');
    let sessionId = strArg(args, 'session_id');
    const projectChoice = strArg(args, 'project');

    // Contenido vacío o en blanco se rechaza antes de resolver el proyecto.
    if (goTrim(content) === '') return errorResult('content is required for mem_session_summary');
    const prepared = prepareWriteProject(ctx, args);
    if (prepared.error) return prepared.error;
    const { res, project } = prepared;

    if (sessionId === '') {
      try {
        sessionId = resolveFallbackSessionId(ctx, project, captureProjectEvidence(ctx, res, sessionId, projectChoice, config.defaultProject));
      } catch (err) {
        return errorResult(`Failed to save session summary: ${err.message}`);
      }
    }
    // Conserva la evidencia de forma atómica cuando la sesión implícita se crea por primera vez.
    ensureImplicitSession(ctx, sessionId, project, captureProjectEvidence(ctx, res, sessionId, projectChoice, config.defaultProject));

    let savedId;
    try {
      ({ id: savedId } = addObservation(store, {
        project_provenance: captureProjectEvidence(ctx, res, sessionId, projectChoice, config.defaultProject),
        session_id: sessionId, type: 'session_summary', title: `Session summary: ${project}`, content, project,
      }));
    } catch (err) {
      return errorResult(`Failed to save session summary: ${err.message}`);
    }
    activity.recordProjectSave(project);

    let msg = `Session summary saved for project ${goQuote(project)}`;
    const score = activity.activityScore(defaultSessionId(project));
    if (score !== '') msg += `\n${score}`;
    const extra = { judgment_required: false };
    const obs = getObservation(store, savedId);
    if (obs) {
      extra.id = savedId;
      extra.sync_id = obs.sync_id;
      extra.state = observationState(obs.review_after);
      if (obs.review_after !== null && obs.review_after !== undefined) extra.review_after = obs.review_after;
    }
    return respondWithProject({ ...res, project }, msg, extra);
  };
}

export function sessionStartTool(ctx) {
  return (args) => {
    const { store, activity, config } = ctx;
    const id = strArg(args, 'id');
    let directory = goTrim(strArg(args, 'directory'));
    // El campo `project` no se lee: el proyecto solo se detecta.
    let outcome;
    if (directory === '') {
      outcome = resolveWriteProjectWithProcessOverride(ctx, false);
    } else {
      const detected = captureProjectDetector(store)(directory);
      outcome = { res: detected, err: detected.error ?? null };
    }
    if (outcome.err) return writeProjectErrorResult(null, '', outcome.res, outcome.err);
    const res = outcome.res;
    const project = normalizeProject(res.project ?? '').normalized;

    activity.recordToolCall(defaultSessionId(project));
    directory = runtimeSessionDirectory(ctx, directory);
    try {
      registerSessionWithProvenance(store, {
        id, project, directory, mode: SESSION_OWNERSHIP_SHARED, provenance: captureProjectEvidence(ctx, res, id, '', config.defaultProject),
      });
    } catch (err) {
      if (err.code === 'session_already_ended') {
        const result = errorWithMeta('session_already_ended', `Session ${goQuote(id)} has already ended. Choose a new session ID and retry mem_session_start.`, null);
        addErrorMetadata(result, { session_id: id });
        return result;
      }
      return errorResult(`Failed to start session: ${err.message}`);
    }
    return respondWithProject({ ...res, project }, `Session ${goQuote(id)} started for project ${goQuote(project)}`);
  };
}

export function sessionEndTool(ctx) {
  return (args) => {
    const { store, activity } = ctx;
    const id = strArg(args, 'id');
    const summary = strArg(args, 'summary');
    let { res, err } = resolveWriteProjectWithProcessOverride(ctx, false);
    if (err) {
      if (err.code !== 'ambiguous_project') return writeProjectErrorResult(null, '', res, err);
      // Se mantiene el cierre heredado ante la ambigüedad, pero nunca se recupera
      // un HOME designado ni una comprobación fallida de pertenencia con un nombre adivinado.
      const cwd = workingDirectory(ctx);
      res = { project: canonicalizeProjectName(basename(cwd)), source: 'dir_basename', path: cwd };
    }
    const project = normalizeProject(res.project ?? '').normalized;
    try {
      endSession(store, id, summary);
    } catch (e) {
      return errorResult(`Failed to end session: ${e.message}`);
    }
    activity.clearSession(defaultSessionId(project));
    return respondWithProject({ ...res, project }, `Session ${goQuote(id)} completed`);
  };
}

export function capturePassiveTool(ctx) {
  return (args) => {
    const { activity, config } = ctx;
    const content = strArg(args, 'content');
    let sessionId = strArg(args, 'session_id');
    let source = strArg(args, 'source');
    // El campo `project` no se lee: el proyecto solo se detecta.
    const { res, err } = resolveSaveWriteProjectWithProcessOverride(ctx, '', false, '', sessionId, null);
    if (err) return writeProjectErrorResult(activity, sessionId, res, err);
    const project = normalizeProject(res.project ?? '').normalized;

    activity.recordToolCall(defaultSessionId(project));
    if (content === '') return errorResult("content is required — include text with a '## Key Learnings:' section");

    if (sessionId === '') {
      try {
        sessionId = resolveFallbackSessionId(ctx, project, captureProjectEvidence(ctx, res, sessionId, '', config.defaultProject));
      } catch (e) {
        return errorResult(`Passive capture failed: ${e.message}`);
      }
      ensureImplicitSession(ctx, sessionId, project, captureProjectEvidence(ctx, res, sessionId, '', config.defaultProject));
    }
    if (source === '') source = 'mcp-passive';

    let result;
    try {
      result = passiveCapture(ctx.store, {
        project_provenance: captureProjectEvidence(ctx, res, sessionId, '', config.defaultProject), session_id: sessionId, content, project, source,
      });
    } catch (e) {
      return errorResult(`Passive capture failed: ${e.message}`);
    }
    return respondWithProject({ ...res, project }, `Passive capture complete: extracted=${result.extracted} saved=${result.saved} duplicates=${result.duplicates}`);
  };
}
