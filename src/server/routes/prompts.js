import { addPrompt, deletePrompt, recentPrompts, searchPrompts } from '../../store/index.js';
import { promptJson } from '../../mcp/serialize.js';
import { HttpError, queryInt, sendJson } from '../http.js';
import { projectOrThrow } from '../project.js';
import { readFields, parseId, validateSessionProject } from './observations.js';
import { ownershipError, readProvenance } from './sessions.js';

export async function addPromptRoute(ctx) {
  const body = await readFields(ctx, { project_provenance: 'any', session_id: 'string', content: 'string', project: 'string', source_inbox_id: 'string' });
  const provenance = readProvenance(body.project_provenance);
  if (!body.session_id || !body.content) throw new HttpError(400, 'session_id and content are required');
  validateSessionProject(ctx, body.session_id, body.project);
  let result;
  try {
    result = addPrompt(ctx.store, {
      project_provenance: provenance, session_id: body.session_id, content: body.content, project: body.project ?? '', source_inbox_id: body.source_inbox_id ?? '',
    });
  } catch (err) {
    if (err.code === 'prompt_content_required') throw new HttpError(400, err.message);
    if (err.code === 'prompt_inbox_deleted') throw new HttpError(409, err.message);
    throw ownershipError(body.session_id, err) ?? new HttpError(500, err.message);
  }
  if (result.inserted) ctx.notifyWrite();
  sendJson(ctx.res, 201, { id: result.id, status: 'saved' });
}

export function recentPromptsRoute(ctx) {
  const res = projectOrThrow(ctx);
  let rows;
  try {
    rows = recentPrompts(ctx.store, res.project ?? '', queryInt(ctx.query, 'limit', 20));
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  sendJson(ctx.res, 200, rows.map(promptJson));
}

export function searchPromptsRoute(ctx) {
  const text = ctx.query.get('q') ?? '';
  if (text === '') throw new HttpError(400, 'q parameter is required');
  const res = projectOrThrow(ctx);
  let rows;
  try {
    rows = searchPrompts(ctx.store, text, res.project ?? '', queryInt(ctx.query, 'limit', 10));
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  sendJson(ctx.res, 200, rows.map(promptJson));
}

export function deletePromptRoute(ctx) {
  const id = parseId(ctx.params.id);
  if (id === null) throw new HttpError(400, 'invalid prompt id');
  try {
    deletePrompt(ctx.store, id);
  } catch (err) {
    throw new HttpError(err.code === 'prompt_not_found' ? 404 : 500, err.message);
  }
  ctx.notifyWrite();
  sendJson(ctx.res, 200, { id, status: 'deleted' });
}
