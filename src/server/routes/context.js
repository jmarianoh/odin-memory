import { resolve as resolveProject } from '../../project/resolution.js';
import {
  exportData, exportProject, exportToJsonValue, formatCompactionContext, formatContext, importData, listProjectNames, listProjectsWithStats, parseExportData,
  stats, statsProject,
} from '../../store/index.js';
import { toGoJson } from '../../store/backup.js';
import { goTrim } from '../../store/text.js';
import { goQuote } from '../../mcp/json.js';
import { DecodeError, decodeBody, firstJsonValue } from '../decode.js';
import { BodyTooLargeError, HttpError, queryBool, queryInt, sendJson } from '../http.js';
import { captureDetector, currentProjectPayload, projectOrThrow, projectResolutionError, resolveRequestProject } from '../project.js';

const CONTEXT_MAX_SECTION_LIMIT = 500;
const CONTEXT_MAX_BYTES = 64 * 1024;

/** Tope de un límite positivo por sección; el cero y los negativos conservan su significado. */
export const clampLimit = (v) => (v > CONTEXT_MAX_SECTION_LIMIT ? CONTEXT_MAX_SECTION_LIMIT : v);

/**
 * Presupuesto de `max_bytes`: dígitos decimales (con un `+` inicial opcional), acotado a 64 KiB.
 * @param {URLSearchParams} query
 */
export function contextBytes(query) {
  let raw = query.get('max_bytes') ?? '';
  if (raw.startsWith('+')) raw = raw.slice(1);
  if (raw === '' || !/^\d+$/.test(raw)) return 0;
  const budget = Number(raw.length > 7 ? raw.slice(0, 7) : raw);
  return Math.min(Number.isFinite(budget) ? budget : CONTEXT_MAX_BYTES, CONTEXT_MAX_BYTES);
}

export function contextRoute(ctx) {
  const res = projectOrThrow(ctx);
  const q = ctx.query;
  const options = {
    max_bytes: contextBytes(q),
    observations: clampLimit(queryInt(q, 'observations', 0)),
    prompts: clampLimit(queryInt(q, 'prompts', 0)),
    sessions: clampLimit(queryInt(q, 'sessions', 0)),
    pinned: clampLimit(queryInt(q, 'pinned', 0)),
    compact: queryBool(q, 'compact', false),
    older_history: queryBool(q, 'older_history', false),
  };
  let text;
  try {
    text = formatContext(ctx.store, res.project ?? '', q.get('scope') ?? '', options);
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  sendJson(ctx.res, 200, { context: text });
}

export function compactionContextRoute(ctx) {
  const sessionId = goTrim(ctx.query.get('session_id') ?? '');
  if (sessionId === '') throw new HttpError(400, 'session_id is required');
  let text;
  try {
    text = formatCompactionContext(ctx.store, sessionId);
  } catch (err) {
    throw new HttpError(err.code === 'session_not_found' ? 404 : 500, err.code === 'session_not_found' ? 'session not found' : err.message);
  }
  sendJson(ctx.res, 200, { context: text });
}

export function listProjectsRoute(ctx) {
  let projects;
  try {
    projects = listProjectsWithStats(ctx.store);
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  sendJson(ctx.res, 200, { projects, count: projects.length });
}

export function statsRoute(ctx) {
  const { res, err } = resolveRequestProject(ctx);
  if (err) {
    if (err.code === 'unknown_project') {
      let available;
      try {
        available = listProjectNames(ctx.store);
      } catch {
        throw new HttpError(500, 'project resolution failed', { code: 'project_resolution_failed' });
      }
      throw new HttpError(404, `project ${goQuote(err.projectName)} not found`, { code: 'unknown_project', available_projects: available.length ? available : null });
    }
    const known = ['invalid_project_name', 'ambiguous_project', 'project_transition'].includes(err.code);
    if (!known) throw new HttpError(500, 'project resolution failed', { code: 'project_resolution_failed' });
    throw projectResolutionError(ctx, res, err);
  }
  let result;
  try {
    result = res.project ? statsProject(ctx.store, res.project) : stats(ctx.store);
  } catch {
    throw new HttpError(500, 'stats unavailable');
  }
  sendJson(ctx.res, 200, result);
}

export function currentProjectRoute(ctx) {
  let cwd = goTrim(ctx.query.get('cwd') ?? '');
  if (cwd === '') {
    try {
      cwd = ctx.cwd();
    } catch (err) {
      throw new HttpError(500, `failed to detect cwd: ${err.message}`);
    }
  }
  let res;
  try {
    res = resolveProject({ mode: 'current', directory: cwd, detect: captureDetector(ctx.store, false), env: ctx.env });
  } catch (err) {
    if (err.code !== 'ambiguous_project') throw projectResolutionError(ctx, err.result ?? {}, err);
    res = err.result ?? {};
  }
  sendJson(ctx.res, 200, currentProjectPayload(cwd, res));
}

/** Clasifica la entrada de un anfitrión sin guardarla ni avisar de escrituras. */
export async function promptCaptureDecisionRoute(ctx) {
  let body;
  try {
    body = decodeBody(await ctx.body(), { source: 'string', cwd: 'string', content: 'string' }, { strict: true, single: true });
  } catch (err) {
    if (err instanceof DecodeError) throw new HttpError(400, 'invalid json');
    throw err;
  }
  if (body.source !== 'copilot' || goTrim(body.cwd ?? '') === '' || body.content === undefined) {
    throw new HttpError(400, 'source must be copilot, cwd must be nonblank, and content must be a string');
  }
  const content = goTrim(body.content);
  if (content === '') {
    sendJson(ctx.res, 200, { decision: 'skip' });
    return;
  }
  const cwd = goTrim(body.cwd);
  let res;
  try {
    res = resolveProject({ mode: 'current', directory: cwd, detect: captureDetector(ctx.store, true), env: ctx.env });
  } catch (err) {
    throw projectResolutionError(ctx, err.result ?? {}, err);
  }
  sendJson(ctx.res, 200, { ...currentProjectPayload(cwd, res), decision: 'capture' });
}

// ─── Exportar / importar ─────────────────────────────────────────────────────

export function exportRoute(ctx) {
  const res = projectOrThrow(ctx);
  let data;
  try {
    data = res.project ? exportProject(ctx.store, res.project) : exportData(ctx.store);
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  ctx.res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename=odin-export.json' });
  ctx.res.end(`${toGoJson(exportToJsonValue(data))}\n`);
}

export async function importRoute(ctx) {
  let text;
  try {
    text = await ctx.body(50 << 20);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw new HttpError(400, `failed to read body: ${err.message}`);
    throw err;
  }
  let data;
  try {
    data = parseExportData(text);
  } catch (err) {
    let message = err.message;
    if (err instanceof SyntaxError) {
      try {
        firstJsonValue(text);
      } catch (decodeErr) {
        message = decodeErr.message === 'EOF' || decodeErr.message === 'unexpected EOF' ? 'unexpected end of JSON input' : decodeErr.message;
      }
    }
    throw new HttpError(400, `invalid json: ${message}`);
  }
  let result;
  try {
    result = importData(ctx.store, data);
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  ctx.notifyWrite();
  sendJson(ctx.res, 200, result);
}
