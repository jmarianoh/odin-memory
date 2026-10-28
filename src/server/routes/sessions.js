import { runtimeWorktreeDirectory } from '../../project/worktree.js';
import { SessionProjectConflictError } from '../../store/errors.js';
import {
  SESSION_OWNERSHIP_PROJECT_OWNED, SESSION_OWNERSHIP_SHARED, captureProjectProvenance, deleteSession, endRuntimeSession, endSession,
  finalizeSession, getSession, parseProvenance, recentSessions, registerSessionWithProvenance, resolveRuntimeSession,
} from '../../store/index.js';
import { goTrim } from '../../store/text.js';
import { goQuote } from '../../mcp/json.js';
import { DecodeError, PROVENANCE_SPEC, decodeBody, firstJsonValue, pickFields } from '../decode.js';
import { HttpError, queryInt, sendJson } from '../http.js';
import { projectOrThrow } from '../project.js';
import { decodeWorkflow } from './workflow-body.js';

const badJson = (err) => new HttpError(400, `invalid json: ${err.message}`);

/** Evidencia de captura del cuerpo, validada; `null` si no vino. */
export function readProvenance(value) {
  if (value === undefined) return null;
  const spec = pickFields(value, PROVENANCE_SPEC);
  try {
    return parseProvenance({ ...spec });
  } catch (err) {
    throw badJson(err);
  }
}

/** Errores de propiedad de un proyecto que el cliente puede corregir con el rescate. */
export function ownershipError(sessionId, err) {
  const codes = { project_ownership_ambiguous: 'project_ownership_ambiguous', project_required: 'project_ownership_required' };
  const code = codes[err.code];
  if (!code) return null;
  let remedy = 'odin projects rescue-ownership --project <name>';
  if (goTrim(sessionId ?? '') !== '') remedy += ` --session ${sessionId}`;
  return new HttpError(409, err.message, { code, remedy });
}

export async function createSession(ctx) {
  let body;
  try {
    const text = await ctx.body();
    const spec = { id: 'string', project: 'string', directory: 'string', ownership_mode: 'string', resume: 'bool', isolated: 'bool', project_provenance: 'any' };
    body = decodeBody(text, spec);
  } catch (err) {
    if (err instanceof DecodeError) throw badJson(err);
    throw err;
  }
  if (!body.id || !body.project) throw new HttpError(400, 'id and project are required');
  const provenance = readProvenance(body.project_provenance);
  const mode = body.ownership_mode || SESSION_OWNERSHIP_SHARED;
  const directory = body.directory ?? '';
  if (body.isolated && (mode !== SESSION_OWNERSHIP_PROJECT_OWNED || goTrim(directory) !== '')) {
    throw new HttpError(400, 'isolated registration requires project_owned ownership and an empty directory');
  }
  let effective;
  try {
    effective = registerSessionWithProvenance(ctx.store, {
      id: body.id, project: body.project, directory: runtimeWorktreeDirectory(directory), mode, resume: body.resume === true,
      isolated: body.isolated === true, provenance,
    });
  } catch (err) {
    if (err.code === 'session_isolation_conflict') throw new HttpError(409, err.message, { code: 'session_isolation_conflict' });
    if (err.code === 'session_already_ended') throw new HttpError(409, err.message, { code: 'session_already_ended', session_id: body.id });
    if (err instanceof SessionProjectConflictError) {
      throw new HttpError(409, err.message, {
        code: 'session_project_conflict', session_id: err.sessionId, owner_project: err.ownerProject, requested_project: err.requestedProject,
      });
    }
    if (err.code === 'invalid_session_ownership_mode') throw new HttpError(400, `invalid session ownership mode ${goQuote(mode)}`);
    throw new HttpError(500, err.message);
  }
  ctx.notifyWrite();
  const ack = { id: effective, status: 'created' };
  if (effective !== body.id) ack.resumed_from = body.id;
  sendJson(ctx.res, 201, ack);
}

export async function endSessionRoute(ctx) {
  const id = ctx.params.id;
  let summary = '';
  try {
    const { value } = firstJsonValue(await ctx.body());
    summary = pickFields(value, { summary: 'string' }).summary ?? '';
  } catch {
    // El resumen es opcional: un cuerpo ausente o inválido cierra sin resumen.
  }
  try {
    endSession(ctx.store, id, summary);
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  ctx.notifyWrite();
  sendJson(ctx.res, 200, { id, status: 'completed' });
}

export function recentSessionsRoute(ctx) {
  const res = projectOrThrow(ctx);
  let sessions;
  try {
    sessions = recentSessions(ctx.store, res.project ?? '', queryInt(ctx.query, 'limit', 5));
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  sendJson(ctx.res, 200, sessions.map(sessionSummaryJson));
}

function sessionSummaryJson(s) {
  const out = { id: s.id, project: s.project, started_at: s.started_at };
  if (s.ended_at != null) out.ended_at = s.ended_at;
  if (s.summary != null) out.summary = s.summary;
  out.observation_count = s.observation_count;
  return out;
}

export function sessionJson(s) {
  const out = { id: s.id, project: s.project };
  if (s.ownership_mode) out.ownership_mode = s.ownership_mode;
  out.directory = s.directory;
  out.started_at = s.started_at;
  if (s.ended_at != null) out.ended_at = s.ended_at;
  if (s.summary != null) out.summary = s.summary;
  return out;
}

export function getSessionRoute(ctx) {
  const session = getSession(ctx.store, ctx.params.id);
  if (!session) throw new HttpError(404, 'session not found');
  const provenance = captureProjectProvenance(ctx.store, 'session', session.id);
  const out = sessionJson(session);
  if (provenance) {
    out.project_provenance = { source: provenance.source };
    if (provenance.directory) out.project_provenance.directory = provenance.directory;
    if (provenance.raw_project) out.project_provenance.raw_project = provenance.raw_project;
  }
  sendJson(ctx.res, 200, out);
}

export function deleteSessionRoute(ctx) {
  const id = ctx.params.id;
  if (id === '') throw new HttpError(400, 'session id is required');
  try {
    deleteSession(ctx.store, id);
  } catch (err) {
    if (err.code === 'session_delete_blocked' || err.code === 'session_has_observations') throw new HttpError(409, err.message);
    if (err.code === 'session_not_found') throw new HttpError(404, err.message);
    throw new HttpError(500, err.message);
  }
  sendJson(ctx.res, 200, { id, status: 'deleted' });
}

// ─── Sesiones de runtime ─────────────────────────────────────────────────────

const RUNTIME_SPEC = { id: 'string', project: 'string', directory: 'string', ownership_mode: 'string', summary: 'string' };

/** Resuelve o cierra la sesión viva de un anfitrión; nunca registra ni repara una identidad. */
export async function runtimeSessionRoute(ctx) {
  const text = await ctx.body();
  let body;
  try {
    body = decodeBody(text, RUNTIME_SPEC, { strict: true, single: true });
  } catch {
    body = null;
  }
  if (!body || goTrim(body.id ?? '') === '' || goTrim(body.project ?? '') === '' || goTrim(body.directory ?? '') === '') {
    throw new HttpError(400, 'id, project and directory are required in one valid JSON object');
  }
  const mode = body.ownership_mode || SESSION_OWNERSHIP_SHARED;
  if (mode !== SESSION_OWNERSHIP_SHARED && mode !== SESSION_OWNERSHIP_PROJECT_OWNED) throw new HttpError(400, 'invalid ownership_mode');
  const directory = runtimeWorktreeDirectory(body.directory);
  const ending = ctx.path === '/runtime-sessions/end';
  let id;
  try {
    id = ending
      ? endRuntimeSession(ctx.store, body.id, body.project, directory, mode, body.summary ?? '')
      : resolveRuntimeSession(ctx.store, body.id, body.project, directory, mode);
  } catch (err) {
    let status = 500;
    if (err.code === 'session_not_found') status = 404;
    if (err.code === 'runtime_session_scope_conflict') status = 409;
    throw new HttpError(status, err.code === 'session_not_found' ? 'sql: no rows in result set' : err.message);
  }
  const ack = { id, status: ending ? 'ended' : 'resolved' };
  if (ending) ctx.notifyWrite();
  if (id !== body.id) ack.resumed_from = body.id;
  sendJson(ctx.res, 200, ack);
}

// ─── Finalizar sesión ────────────────────────────────────────────────────────

export async function finalizeSessionRoute(ctx) {
  const args = await decodeWorkflow(ctx);
  for (const key of Object.keys(args)) {
    if (key !== 'project' && key !== 'summary') throw new HttpError(400, `unsupported argument ${key}`, { code: 'invalid_arguments' });
  }
  const { project, summary } = args;
  if (typeof project !== 'string' || typeof summary !== 'string' || goTrim(project) === '' || goTrim(summary) === '') {
    throw new HttpError(400, 'project and summary must be non-empty strings', { code: 'invalid_arguments' });
  }
  const sessionId = ctx.params.id;
  let result;
  try {
    result = finalizeSession(ctx.store, { session_id: sessionId, project, summary });
  } catch (err) {
    let status = 500;
    let code = 'session_finalize_failed';
    if (err.code === 'session_not_found') [status, code] = [404, 'unknown_session'];
    else if (err.code === 'session_ownership_mismatch') [status, code] = [403, 'session_project_mismatch'];
    else if (err.code === 'session_already_ended') [status, code] = [409, 'session_already_ended'];
    else if (err.code === 'observation_content_required' || err.code === 'project_required') [status, code] = [400, 'invalid_arguments'];
    else if (err.code === 'session_id_required') status = 400;
    throw new HttpError(status, status === 500 ? 'session finalization failed' : err.message, { code, session_id: sessionId });
  }
  if (!result.already_finalized) ctx.notifyWrite();
  sendJson(ctx.res, 200, {
    session_id: sessionId, state: result.already_finalized ? 'already_finalized' : 'finalized', summary_id: result.summary_id,
    summary_sync_id: result.summary_sync_id, already_finalized: result.already_finalized, judgment_required: false,
  });
}
