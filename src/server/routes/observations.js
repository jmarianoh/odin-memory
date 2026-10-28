import { normalizeProject } from '../../project/canonical.js';
import {
  DEFAULT_OBSERVATION_VERSION_PAGE_SIZE, addObservation, capturePromptForSave, compactSearchProjection, deleteObservation, getObservation,
  getObservationSaveResult, getObservationVersionPage, getSession, markReviewed, observationOperationRecorded, observationState,
  observationsNeedingReview, passiveCapture, pinObservation, recentObservations, searchObservationPreviews, searchObservations,
  searchPreviewRelations, suggestTopicKey, timeline, unpinObservation, updateObservation, validateObservationTitle,
} from '../../store/index.js';
import { goTrim } from '../../store/text.js';
import { observationJson, relationJson } from '../../mcp/serialize.js';
import { goQuote } from '../../mcp/json.js';
import { DecodeError, decodeBody } from '../decode.js';
import { BodyTooLargeError, HttpError, queryBool, queryInt, sendJson } from '../http.js';
import { captureDetector, projectOrThrow, resolveRequestProject, projectResolutionError } from '../project.js';
import { ownershipError, readProvenance } from './sessions.js';

const badJson = (err) => new HttpError(400, `invalid json: ${err.message}`);

/** Decodifica el cuerpo de la petición o lanza el 400 `invalid json`. */
export async function readFields(ctx, spec, options) {
  try {
    return decodeBody(await ctx.body(), spec, options);
  } catch (err) {
    if (err instanceof DecodeError) throw badJson(err);
    throw err;
  }
}

/**
 * Comprueba que `projectName` (si lo hay) coincide con el dueño de la sesión.
 * @throws {HttpError} 404 si la sesión no existe; 400 si pertenece a otro proyecto
 */
export function validateSessionProject(ctx, sessionId, projectName) {
  if (goTrim(projectName ?? '') === '') return;
  const wanted = normalizeProject(projectName).normalized;
  let session;
  try {
    session = getSession(ctx.store, sessionId);
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  if (!session) throw new HttpError(404, 'session not found');
  const owner = normalizeProject(session.project).normalized;
  if (owner !== '' && owner !== wanted) {
    throw new HttpError(400, 'session project does not match requested project', { code: 'session_project_mismatch', session_project: owner, project: wanted });
  }
}

const OBSERVATION_BODY = {
  project_provenance: 'any', session_id: 'string', type: 'string', title: 'string', content: 'string', tool_name: 'string', project: 'string',
  scope: 'string', topic_key: 'string', operation_id: 'string', capture_prompt: 'bool', current_prompt: 'string',
};

export function getSaveResult(ctx) {
  const operationId = ctx.query.get('operation_id') ?? '';
  if (operationId === '') throw new HttpError(400, 'operation_id is required');
  let id;
  try {
    id = getObservationSaveResult(ctx.store, operationId);
  } catch (err) {
    if (err.code === 'observation_operation_expired') throw new HttpError(410, err.message);
    throw new HttpError(500, err.message);
  }
  if (id === 0) throw new HttpError(404, 'no committed result found for operation_id', { code: 'observation_save_result_not_found' });
  sendJson(ctx.res, 200, { id, status: 'committed' });
}

export async function addObservationRoute(ctx) {
  const body = await readFields(ctx, OBSERVATION_BODY);
  const provenance = readProvenance(body.project_provenance);
  try {
    validateObservationTitle(body.title ?? '');
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  if (!body.session_id || !body.content) throw new HttpError(400, 'session_id and content are required');
  let recorded = false;
  if (body.operation_id) {
    try {
      recorded = observationOperationRecorded(ctx.store, body.operation_id);
    } catch (err) {
      throw new HttpError(500, err.message);
    }
  }
  if (!recorded) validateSessionProject(ctx, body.session_id, body.project);

  let result;
  try {
    result = addObservation(ctx.store, {
      project_provenance: provenance, session_id: body.session_id, type: body.type ?? '', title: body.title ?? '', content: body.content,
      tool_name: body.tool_name, project: body.project ?? '', scope: body.scope, topic_key: body.topic_key, operation_id: body.operation_id,
    });
  } catch (err) {
    if (err.code === 'observation_title_required' || err.code === 'observation_content_required') throw new HttpError(400, err.message);
    if (err.code === 'observation_operation_conflict') throw new HttpError(409, err.message);
    if (err.code === 'observation_operation_expired') throw new HttpError(410, err.message);
    throw ownershipError(body.session_id, err) ?? new HttpError(500, err.message);
  }
  if (!result.replayed) {
    try {
      capturePromptForSave(ctx.store, body.capture_prompt, {
        session_id: body.session_id, project: body.project ?? '', content: body.current_prompt ?? '', project_provenance: provenance,
      });
    } catch (err) {
      process.stderr.write(`odin: auto prompt capture error (non-fatal): ${err.message}\n`);
    }
    ctx.notifyWrite();
  }
  sendJson(ctx.res, 201, { id: result.id, status: 'saved' });
}

export async function passiveCaptureRoute(ctx) {
  const body = await readFields(ctx, { project_provenance: 'any', session_id: 'string', content: 'string', project: 'string', source: 'string' });
  const provenance = readProvenance(body.project_provenance);
  if (!body.session_id) throw new HttpError(400, 'session_id is required');
  validateSessionProject(ctx, body.session_id, body.project);
  let result;
  try {
    result = passiveCapture(ctx.store, {
      project_provenance: provenance, session_id: body.session_id, content: body.content ?? '', project: body.project ?? '', source: body.source ?? '',
    });
  } catch (err) {
    throw ownershipError(body.session_id, err) ?? new HttpError(500, err.message);
  }
  ctx.notifyWrite();
  sendJson(ctx.res, 200, result);
}

export function listObservationsRoute(ctx) {
  const sort = ctx.query.get('sort') ?? '';
  if (sort !== '' && sort !== 'created_at:desc') throw new HttpError(400, 'unsupported sort: use created_at:desc');
  recentObservationsRoute(ctx);
}

export function recentObservationsRoute(ctx) {
  const res = projectOrThrow(ctx);
  let rows;
  try {
    rows = recentObservations(ctx.store, res.project ?? '', ctx.query.get('scope') ?? '', queryInt(ctx.query, 'limit', 20));
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  sendJson(ctx.res, 200, rows.map(observationJson));
}

export function searchRoute(ctx) {
  const { query } = ctx;
  const responseFormat = query.get('response_format') ?? '';
  if (responseFormat !== '' && responseFormat !== 'compact') {
    throw new HttpError(400, `invalid response_format ${goQuote(responseFormat)}: must be "compact"`);
  }
  const text = query.get('q') ?? '';
  if (text === '') throw new HttpError(400, 'q parameter is required');
  const res = projectOrThrow(ctx);
  const matchMode = query.get('match_mode') ?? '';
  if (matchMode !== '' && matchMode !== 'all' && matchMode !== 'any') {
    throw new HttpError(400, `invalid match_mode ${goQuote(matchMode)}: must be "all" or "any"`);
  }
  const options = { type: query.get('type') ?? '', project: res.project ?? '', scope: query.get('scope') ?? '', limit: queryInt(query, 'limit', 10), match_mode: matchMode };
  try {
    if (responseFormat === 'compact') {
      const previews = searchObservationPreviews(ctx.store, text, options);
      const relations = searchPreviewRelations(ctx.store, previews);
      const summary = previews.length === 0 ? `No memories found for: ${goQuote(text)}` : `Found ${previews.length} memories.`;
      const projection = compactSearchProjection(previews, relations).map((entry) =>
        entry.relations
          ? { ...entry, relations: { as_source: entry.relations.as_source.length ? entry.relations.as_source.map(relationJson) : null, as_target: entry.relations.as_target.length ? entry.relations.as_target.map(relationJson) : null } }
          : entry);
      sendJson(ctx.res, 200, { result: summary, results: projection });
      return;
    }
    const results = searchObservations(ctx.store, text, options);
    sendJson(ctx.res, 200, results.map((r) => ({ ...observationJson(r), rank: r.rank })));
  } catch (err) {
    throw new HttpError(500, err.message);
  }
}

/** Cursor de historial: entero JSON no negativo por debajo de 2^63. */
function historyCursor(values) {
  const fail = () => new HttpError(400, 'history_cursor must be a non-negative integer');
  const raw = values[0] ?? '';
  let numeric;
  try {
    numeric = JSON.parse(raw);
  } catch {
    throw fail();
  }
  if (typeof numeric !== 'number' || numeric < 0 || !Number.isInteger(numeric) || numeric >= 2 ** 63) throw fail();
  return numeric;
}

export function getObservationRoute(ctx) {
  const id = parseId(ctx.params.id);
  if (id === null) throw new HttpError(400, 'invalid observation id');
  const obs = getObservation(ctx.store, id);
  if (!obs) throw new HttpError(404, 'observation not found');
  if (ctx.query.get('include_history') !== 'true') {
    sendJson(ctx.res, 200, observationJson(obs));
    return;
  }
  const cursor = ctx.query.has('history_cursor') ? historyCursor(ctx.query.getAll('history_cursor')) : 0;
  let page;
  try {
    page = getObservationVersionPage(ctx.store, id, DEFAULT_OBSERVATION_VERSION_PAGE_SIZE, cursor);
  } catch (err) {
    throw new HttpError(500, `Failed to read observation history: ${err.message}`);
  }
  const out = {
    ...observationJson(obs),
    history: page.versions.map((v) => ({ version: v.version, title: v.title, content: v.content, created_at: v.created_at })),
    version_count: page.total,
  };
  if (page.has_more) {
    out.history_truncated = true;
    out.history_from_version = page.versions[0].version;
    out.history_cursor = page.next_cursor;
  }
  sendJson(ctx.res, 200, out);
}

/** Entero decimal con signo de 64 bits (`strconv.ParseInt`), o `null`. */
export function parseId(text) {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

const UPDATE_FIELDS = ['type', 'title', 'content', 'find', 'replace', 'project', 'scope', 'topic_key'];
const UPDATE_BAD_REQUEST = new Set([
  'expected_project_required', 'observation_title_required', 'observation_content_required', 'observation_find_replace_pair_required',
  'observation_find_replace_content_conflict', 'observation_find_replace_input_too_large', 'observation_find_replace_result_too_large',
  'observation_find_replace_legacy_content_large',
]);

export async function updateObservationRoute(ctx) {
  const id = parseId(ctx.params.id);
  if (id === null) throw new HttpError(400, 'invalid observation id');
  const body = await readFields(ctx, Object.fromEntries(UPDATE_FIELDS.map((f) => [f, 'string'])));
  if (UPDATE_FIELDS.every((f) => body[f] === undefined)) throw new HttpError(400, 'at least one field is required');
  let obs;
  try {
    obs = updateObservation(ctx.store, id, body, { expectedProject: ctx.query.get('expected_project') ?? '' });
  } catch (err) {
    if (UPDATE_BAD_REQUEST.has(err.code)) throw new HttpError(400, err.message);
    if (err.code === 'observation_project_mismatch' || err.code === 'observation_project_immutable') throw new HttpError(409, err.message);
    throw new HttpError(404, err.message);
  }
  ctx.notifyWrite();
  sendJson(ctx.res, 200, observationJson(obs));
}

export function pinRoute(pinned) {
  return (ctx) => {
    const id = parseId(ctx.params.id);
    if (id === null || id <= 0) throw new HttpError(400, 'invalid observation id');
    try {
      if (pinned) pinObservation(ctx.store, id);
      else unpinObservation(ctx.store, id);
    } catch (err) {
      throw new HttpError(err.code === 'observation_not_found' ? 404 : 500, err.message);
    }
    sendJson(ctx.res, 200, { id, pinned });
  };
}

export async function suggestTopicKeyRoute(ctx) {
  let text;
  try {
    text = await ctx.body(50 << 20);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw new HttpError(400, 'request body too large');
    throw err;
  }
  let body;
  try {
    body = decodeBody(text, { type: 'string', title: 'string', content: 'string' }, { single: true });
  } catch (err) {
    if (err instanceof DecodeError) throw badJson(err);
    throw err;
  }
  if (goTrim(body.title ?? '') === '' && goTrim(body.content ?? '') === '') throw new HttpError(400, 'provide title or content to suggest a topic_key');
  sendJson(ctx.res, 200, { topic_key: suggestTopicKey(body.type ?? '', body.title ?? '', body.content ?? '') });
}

export function deleteObservationRoute(ctx) {
  const id = parseId(ctx.params.id);
  if (id === null) throw new HttpError(400, 'invalid observation id');
  const hard = queryBool(ctx.query, 'hard', false);
  try {
    deleteObservation(ctx.store, id, { hardDelete: hard, expectedProject: ctx.query.get('expected_project') ?? '' });
  } catch (err) {
    if (err.code === 'expected_project_required') throw new HttpError(400, err.message);
    if (err.code === 'observation_project_mismatch') throw new HttpError(409, err.message);
    if (err.code === 'observation_not_found') throw new HttpError(404, err.message);
    throw new HttpError(500, err.message);
  }
  ctx.notifyWrite();
  sendJson(ctx.res, 200, { id, status: 'deleted', hard_delete: hard });
}

export function timelineRoute(ctx) {
  const raw = ctx.query.get('observation_id') ?? '';
  if (raw === '') throw new HttpError(400, 'observation_id parameter is required');
  const id = parseId(raw);
  if (id === null) throw new HttpError(400, 'invalid observation_id');
  const before = queryInt(ctx.query, 'before', 5);
  const after = queryInt(ctx.query, 'after', 5);
  const res = projectOrThrow(ctx);
  const focus = getObservation(ctx.store, id);
  if (!focus) throw new HttpError(404, 'observation not found');
  const project = res.project ?? '';
  if (project !== '' && (focus.project == null || goTrim(focus.project).toLowerCase() !== project.toLowerCase())) {
    throw new HttpError(404, 'observation not found in resolved project');
  }
  let result;
  try {
    result = timeline(ctx.store, id, before, after);
  } catch (err) {
    throw new HttpError(404, err.message);
  }
  sendJson(ctx.res, 200, {
    focus: observationJson(result.focus),
    // Una lista vacía se serializa como null, igual que el contrato.
    before: result.before.length ? result.before.map(timelineEntryJson) : null,
    after: result.after.length ? result.after.map(timelineEntryJson) : null,
    session_info: result.session_info ? sessionInfoJson(result.session_info) : null,
    total_in_range: result.total_in_range,
  });
}

function timelineEntryJson(entry) {
  const out = observationJson(entry);
  out.is_focus = entry.is_focus;
  return out;
}

function sessionInfoJson(s) {
  const out = { id: s.id, project: s.project };
  if (s.ownership_mode) out.ownership_mode = s.ownership_mode;
  out.directory = s.directory;
  out.started_at = s.started_at;
  if (s.ended_at != null) out.ended_at = s.ended_at;
  if (s.summary != null) out.summary = s.summary;
  return out;
}

function reviewPayload(obs) {
  const payload = { id: obs.id, sync_id: obs.sync_id, title: obs.title, type: obs.type, state: observationState(obs.review_after) };
  if (obs.project != null) payload.project = obs.project;
  if (obs.review_after != null) payload.review_after = obs.review_after;
  return payload;
}

export function reviewListRoute(ctx) {
  const res = projectOrThrow(ctx);
  let rows;
  try {
    rows = observationsNeedingReview(ctx.store, res.project ?? '', queryInt(ctx.query, 'limit', 10));
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  const observations = rows.map(reviewPayload);
  sendJson(ctx.res, 200, { observations, count: observations.length });
}

export async function reviewMarkRoute(ctx) {
  const body = await readFields(ctx, { observation_id: 'int', id: 'int' });
  const id = body.observation_id || body.id || 0;
  if (id === 0) throw new HttpError(400, 'observation_id is required');
  const { res, err } = resolveRequestProject(ctx, { detect: captureDetector(ctx.store, false) });
  if (err) throw projectResolutionError(ctx, res, err);
  const project = res.project ?? '';
  try {
    markReviewed(ctx.store, id, project);
  } catch (e) {
    if (e.code === 'observation_not_found') {
      throw new HttpError(404, project !== '' ? 'observation not found in resolved project' : e.message);
    }
    throw new HttpError(500, e.message);
  }
  const obs = getObservation(ctx.store, id);
  if (!obs) throw new HttpError(500, 'marked reviewed but failed to reload observation: observation not found');
  sendJson(ctx.res, 200, reviewPayload(obs));
}
