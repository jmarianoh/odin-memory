import { normalizeProject } from '../../project/canonical.js';
import {
  addObservation, capturePromptForSave, contentTruncation, countObservationsForProject, deleteObservation, findCandidates, getObservation,
  listProjectNames, markReviewed, observationState, observationsNeedingReview, pinObservation, suggestTopicKey, unpinObservation, updateObservation,
  validateExpectedProject, validateObservationTitle,
} from '../../store/index.js';
import { findSimilar } from '../../project/similar.js';
import { goTrim } from '../../store/text.js';
import { boolArg, intArg, strArg } from '../args.js';
import { defaultSessionId, errorWithMeta, readProjectErrorResult, respondWithProject, addErrorMetadata } from '../envelope.js';
import { errorResult, jsonMarshal, textResult, goQuote } from '../json.js';
import { captureProjectDetector, resolveReadProject } from '../projects.js';
import { captureProjectEvidence, ensureImplicitSession, resolveFallbackSessionId } from '../session-helpers.js';
import { absolutePathWarning, truncationWarning } from '../warnings.js';
import { prepareWriteProject } from '../write-support.js';
import { resolve } from '../../project/resolution.js';
import { SOURCE_EXPLICIT_OVERRIDE } from '../../project/detect.js';

const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/** Sustituye un `expected_project` ausente por `''` para que el store lo rechace igual que si fuera inválido. */
function expectedProjectArg(args) {
  const expected = strArg(args, 'expected_project');
  try {
    validateExpectedProject(expected);
    return { expected };
  } catch (err) {
    return { error: errorResult(err.message) };
  }
}

export function saveTool(ctx) {
  return (args) => {
    const { store, activity, config } = ctx;
    const title = strArg(args, 'title');
    let content = strArg(args, 'content');
    if (goTrim(content) === '') {
      const observation = strArg(args, 'observation');
      if (goTrim(observation) !== '') content = observation;
    }
    if (goTrim(content) === '') return errorResult('content is required for mem_save (use content, or observation for backward-compatible clients)');
    // Se rechazan los guardados sin título antes de resolver proyecto o crear sesión,
    // para que un guardado rechazado no deje una sesión huérfana.
    try {
      validateObservationTitle(title);
    } catch (err) {
      return errorResult(`Failed to save: ${err.message}`);
    }
    let type = strArg(args, 'type');
    let sessionId = strArg(args, 'session_id');
    const scope = strArg(args, 'scope');
    const topicKey = strArg(args, 'topic_key');
    const projectChoice = strArg(args, 'project');
    let capturePrompt;
    if (Object.hasOwn(args, 'capture_prompt')) {
      if (typeof args.capture_prompt !== 'boolean') return errorResult('capture_prompt must be a boolean');
      capturePrompt = args.capture_prompt;
    }
    const prepared = prepareWriteProject(ctx, args);
    if (prepared.error) return prepared.error;
    const { res, project, warning: normWarning } = prepared;

    if (type === '') type = 'manual';
    if (sessionId === '') {
      try {
        sessionId = resolveFallbackSessionId(ctx, project, captureProjectEvidence(ctx, res, sessionId, projectChoice, config.defaultProject));
      } catch (err) {
        return errorResult(`Failed to save: ${err.message}`);
      }
    }
    const suggestedTopicKey = suggestTopicKey(type, title, content);

    // Proyecto parecido a uno existente (solo si éste aún no tiene memorias).
    let similarWarning = '';
    if (project !== '') {
      const existingNames = listProjectNames(store);
      if (!existingNames.includes(project) && existingNames.length > 0) {
        const matches = findSimilar(project, existingNames, 3);
        if (matches.length > 0) {
          const best = matches[0].name;
          similarWarning = `⚠️ Project ${goQuote(project)} has no memories. Similar project found: ${goQuote(best)} (${countObservationsForProject(store, best)} memories). Consider using that name instead.`;
        }
      }
    }

    const provenance = captureProjectEvidence(ctx, res, sessionId, projectChoice, config.defaultProject);
    ensureImplicitSession(ctx, sessionId, project, provenance);
    const truncation = contentTruncation(store, content);

    let savedId;
    try {
      ({ id: savedId } = addObservation(store, {
        project_provenance: provenance, session_id: sessionId, type, title, content, project, scope, topic_key: topicKey,
      }));
    } catch (err) {
      return errorResult(`Failed to save: ${err.message}`);
    }
    const saved = getObservation(store, savedId);

    const currentPrompt = activity.currentPrompt(sessionId, project) ?? '';
    try {
      capturePromptForSave(store, capturePrompt, { project_provenance: provenance, session_id: sessionId, content: currentPrompt, project });
    } catch (err) {
      process.stderr.write(`odin: auto prompt capture error (non-fatal): ${err.message}\n`);
    }
    activity.recordSaveForProject(sessionId, project);

    let msg = `Memory saved: ${goQuote(title)} (${type})`;
    if (topicKey === '' && suggestedTopicKey !== '') msg += `\nSuggested topic_key: ${suggestedTopicKey}`;
    msg += truncationWarning(truncation);
    if (saved) msg += absolutePathWarning(saved.content);
    if (normWarning) msg += `\n${normWarning}`;
    if (similarWarning) msg += `\n${similarWarning}`;

    // Detección de conflictos tras confirmar el guardado: un fallo no lo revierte pero se informa.
    const extra = { truncation };
    const options = { project, scope, require_save_relevance: true };
    if (config.bm25Floor !== undefined && config.bm25Floor !== null) options.bm25_floor = config.bm25Floor;
    if (config.limit !== undefined && config.limit !== null) options.limit = config.limit;
    let candidates = [];
    let candidateError = null;
    try {
      const found = findCandidates(store, savedId, options);
      candidates = found.candidates;
      if (found.errors.length > 0) candidateError = found.errors[0];
    } catch (err) {
      candidateError = err;
    }
    if (candidateError) {
      process.stderr.write(`odin: FindCandidates error (non-fatal): ${candidateError.message}\n`);
      extra.candidate_detection_status = 'incomplete';
      msg += '\nCONFLICT DETECTION INCOMPLETE — observation saved; pending relations may be partially persisted. Returned candidates include only confirmed pending judgments.';
    }

    if (saved) {
      extra.id = savedId;
      extra.sync_id = saved.sync_id;
      extra.state = observationState(saved.review_after);
      if (saved.review_after !== null && saved.review_after !== undefined) extra.review_after = saved.review_after;
    }
    if (candidates.length > 0) {
      extra.judgment_required = true;
      extra.judgment_status = 'pending';
      extra.judgment_id = candidates[0].judgment_id; // sync_id de la primera relación (comodidad de diseño)
      extra.candidates = candidates.map((c) => {
        const entry = { id: c.id, sync_id: c.sync_id, title: c.title, type: c.type, score: c.score, judgment_id: c.judgment_id };
        if (c.topic_key !== null && c.topic_key !== undefined) entry.topic_key = c.topic_key;
        return entry;
      });
      msg += `\nCONFLICT REVIEW PENDING — ${candidates.length} candidate(s); use mem_judge to record verdicts.`;
    } else if (!candidateError) {
      extra.judgment_required = false;
    }
    return respondWithProject({ ...res, project }, msg, extra);
  };
}

export function updateTool(ctx) {
  return (args) => {
    const { store } = ctx;
    const checked = expectedProjectArg(args);
    if (checked.error) return checked.error;
    const id = intArg(args, 'id', 0);
    if (id === 0) return errorResult('id is required');

    const update = {};
    for (const key of ['title', 'content', 'find', 'replace', 'type', 'scope', 'topic_key']) {
      if (typeof args[key] === 'string') update[key] = args[key];
    }
    if (Object.keys(update).length === 0) return errorResult('provide at least one field to update');

    const truncation = update.content !== undefined ? contentTruncation(store, update.content) : null;
    let obs;
    try {
      obs = updateObservation(store, id, update, { expectedProject: checked.expected });
    } catch (err) {
      return errorResult(`Failed to update memory: ${err.message}`);
    }
    let msg = `Memory updated: #${obs.id} ${goQuote(obs.title)} (${obs.type}, scope=${obs.scope})`;
    const extra = {};
    if (truncation) {
      msg += truncationWarning(truncation);
      extra.truncation = truncation;
    }
    const owner = normalizeProject(obs.project ?? '').normalized;
    return respondWithProject({ project: owner, source: SOURCE_EXPLICIT_OVERRIDE }, msg, extra);
  };
}

export function deleteTool(ctx) {
  return (args) => {
    const checked = expectedProjectArg(args);
    if (checked.error) return checked.error;
    const id = intArg(args, 'id', 0);
    if (id === 0) return errorResult('id is required');
    const hardDelete = boolArg(args, 'hard_delete', false);
    try {
      deleteObservation(ctx.store, id, { hardDelete, expectedProject: checked.expected });
    } catch (err) {
      return errorResult(`Failed to delete memory: ${err.message}`);
    }
    return textResult(`Memory #${id} ${hardDelete ? 'permanently deleted' : 'soft-deleted'}`);
  };
}

export function pinTool(ctx, pinned) {
  return (args) => {
    const id = intArg(args, 'id', 0);
    if (id === 0) return errorResult('id is required');
    try {
      if (pinned) pinObservation(ctx.store, id);
      else unpinObservation(ctx.store, id);
    } catch (err) {
      return errorResult(`Failed to update pin state: ${err.message}`);
    }
    const obs = getObservation(ctx.store, id);
    if (!obs) return errorResult('Updated pin state but failed to reload observation: observation not found');
    return textResult(jsonMarshal({ result: `Memory #${id} ${pinned ? 'pinned' : 'unpinned'}`, id: obs.id, sync_id: obs.sync_id, pinned: obs.pinned }));
  };
}

export function reviewTool(ctx) {
  return (args) => {
    const { store, activity } = ctx;
    const action = goTrim(strArg(args, 'action'));
    if (action === 'list') {
      let projectFilter = strArg(args, 'project');
      const limit = intArg(args, 'limit', 10);
      let res = resolve({ mode: 'all' });
      if (goTrim(projectFilter) !== '') {
        const resolved = resolveReadProject(ctx, projectFilter);
        if (resolved.err) {
          if (resolved.err.kind === 'unknown_project') {
            return errorWithMeta('unknown_project', `Project ${goQuote(resolved.err.projectName)} not found in store`, resolved.err.availableProjects);
          }
          return errorResult(`Project resolution failed: ${resolved.err.message}`);
        }
        res = resolved.res;
        projectFilter = res.project;
      }
      let observations;
      try {
        observations = observationsNeedingReview(store, projectFilter, limit);
      } catch (err) {
        return errorResult(`Review list error: ${err.message}`);
      }
      const structured = [];
      if (observations.length === 0) return respondWithProject(res, 'No memories need review.', { observations: structured });
      let out = `Found ${observations.length} memories needing review:\n\n`;
      for (const [i, obs] of observations.entries()) {
        const state = observationState(obs.review_after);
        const projectDisplay = obs.project != null ? ` | project: ${obs.project}` : '';
        const reviewDisplay = obs.review_after != null ? ` | review_after: ${obs.review_after}` : '';
        out += `[${i + 1}] #${obs.id} (${obs.type}) — ${obs.title}\n    state: ${state}${projectDisplay}${reviewDisplay}\n`;
        const entry = { id: obs.id, sync_id: obs.sync_id, title: obs.title, type: obs.type, state };
        if (obs.project != null) entry.project = obs.project;
        if (obs.review_after != null) entry.review_after = obs.review_after;
        structured.push(entry);
      }
      return respondWithProject(res, out, { observations: structured });
    }

    if (action === 'mark_reviewed') {
      let id = intArg(args, 'observation_id', 0);
      if (id === 0) id = intArg(args, 'id', 0);
      if (id === 0) return errorResult('observation_id is required for mark_reviewed');
      const { res, err } = resolveReadProject(ctx, strArg(args, 'project'), captureProjectDetector(store), true);
      if (err) {
        const result = readProjectErrorResult(activity, res, err);
        if (err.code === 'ambiguous_project') {
          addErrorMetadata(result, { hint: 'Ask the user to choose a project, then retry mem_review action=mark_reviewed with an explicit project.' });
        }
        return result;
      }
      try {
        markReviewed(store, id, res.project);
      } catch (e) {
        if ((res.project ?? '') !== '' && e.code === 'observation_not_found') return errorResult('Failed to mark reviewed: observation not found in resolved project');
        return errorResult(`Failed to mark reviewed: ${messageOf(e)}`);
      }
      const obs = getObservation(store, id);
      if (!obs) return errorResult('Marked reviewed but failed to reload observation: observation not found');
      const extra = { id: obs.id, sync_id: obs.sync_id, state: observationState(obs.review_after) };
      if (obs.review_after != null) extra.review_after = obs.review_after;
      return respondWithProject(res, `Memory marked reviewed: #${obs.id} ${goQuote(obs.title)} (${obs.type})`, extra);
    }
    return errorResult('action must be one of: list, mark_reviewed');
  };
}


