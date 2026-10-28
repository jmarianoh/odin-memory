import {
  DEFAULT_SCAN_LIMIT, consolidateObservations, countRelations, getActionableRelationStats, getObservation, getRelationByIntId, judgeBySemantic,
  judgeRelation, listDeferred, listRelations, scanAllProjects, scanProject,
} from '../../store/index.js';
import { goTrim } from '../../store/text.js';
import { consolidationPlanJson, judgeParams, judgmentItemError, parseConsolidate } from '../../mcp/tools/curation.js';
import { observationJson, relationJson } from '../../mcp/serialize.js';
import { HttpError, queryInt, sendJson } from '../http.js';
import { projectOrThrow, projectResolutionError } from '../project.js';
import { resolve as resolveProject } from '../../project/resolution.js';
import { detectProject, projectExists } from '../../store/index.js';
import { parseId, readFields } from './observations.js';
import { decodeWorkflow } from './workflow-body.js';

const CONFLICTS_DEFAULT_LIMIT = 50;
const CONFLICTS_MAX_LIMIT = 500;

/** Límite de `[1, 500]`; un valor no positivo usa el de por defecto. */
export function clampConflictsLimit(v, fallback) {
  if (v <= 0) return fallback;
  return Math.min(v, CONFLICTS_MAX_LIMIT);
}

// ─── Consolidar ──────────────────────────────────────────────────────────────

export async function consolidateRoute(ctx) {
  const args = await decodeWorkflow(ctx);
  const parsed = parseConsolidate(args);
  if (parsed.error) throw new HttpError(400, parsed.error, { code: 'invalid_arguments' });
  let result;
  try {
    result = consolidateObservations(ctx.store, parsed.params);
  } catch (err) {
    let status = 500;
    let code = 'consolidation_failed';
    const fields = {};
    if (err.code === 'consolidate_fingerprint_mismatch') {
      [status, code] = [409, 'fingerprint_mismatch'];
      if (err.plan) fields.plan = consolidationPlanJson(err.plan);
    } else if (err.code === 'observation_project_mismatch') {
      [status, code] = [403, 'project_mismatch'];
    } else if (err.code === 'expected_project_required') {
      [status, code] = [400, 'invalid_arguments'];
    } else if (['consolidate_need_two_sources', 'consolidate_duplicate_id', 'consolidate_missing_observation', 'consolidate_cross_project', 'consolidate_provenance_cycle', 'project_required'].includes(err.code)) {
      [status, code] = [400, 'consolidation_refused'];
    }
    throw new HttpError(status, status === 500 ? 'consolidation failed' : err.message, { ...fields, code });
  }
  const body = { status: 'preview', plan: consolidationPlanJson(result.plan) };
  let status = 200;
  if (result.survivor) {
    body.status = 'consolidated';
    body.survivor = observationJson(result.survivor);
    body.soft_deleted_ids = result.plan.ids;
    status = 201;
    ctx.notifyWrite();
  }
  sendJson(ctx.res, status, body);
}

// ─── Juicios ─────────────────────────────────────────────────────────────────

const VERB_ERROR = /^JudgeRelation: invalid relation verb ".*" — must be one of: /;

/** Solo los rechazos conocidos del almacén cruzan la frontera HTTP; el resto es un fallo opaco. */
function judgmentErrorMessage(err, params) {
  if (err.code === 'cross_project_relation') return err.message;
  if (err.message === `JudgeRelation: relation ${JSON.stringify(params.judgment_id)} not found`) return err.message;
  if (VERB_ERROR.test(err.message)) return err.message;
  return 'judgment failed';
}

export async function judgeManyRoute(ctx) {
  const args = await decodeWorkflow(ctx);
  const items = args.judgments;
  if (!Array.isArray(items) || items.length < 1 || items.length > 32) throw new HttpError(400, 'judgments must be an array containing 1..32 items');
  let session = '';
  if (Object.hasOwn(args, 'session_id')) {
    if (typeof args.session_id !== 'string') throw new HttpError(400, 'session_id must be a string');
    session = args.session_id;
  }
  const outcomes = items.map((raw, index) => {
    const out = { index, judgment_id: null, status: 'error' };
    const isObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
    if (isObject && typeof raw.judgment_id === 'string') out.judgment_id = raw.judgment_id;
    let message = judgmentItemError(raw);
    if (message === '') {
      const parsed = judgeParams({ ...raw, session_id: session });
      if (parsed.error) {
        message = parsed.error;
      } else {
        try {
          const relation = judgeRelation(ctx.store, parsed.params);
          out.status = 'success';
          out.relation = relationJson(relation);
          out.judgment_status = relation.judgment_status;
          ctx.notifyWrite();
        } catch (err) {
          message = judgmentErrorMessage(err, parsed.params);
        }
      }
    }
    if (message !== '') out.error = message;
    return out;
  });
  sendJson(ctx.res, 200, { outcomes });
}

export async function judgeRoute(ctx) {
  const body = await readFields(ctx, { judgment_id: 'string', relation: 'string', reason: 'string', evidence: 'string', confidence: 'float', session_id: 'string' });
  if (goTrim(body.judgment_id ?? '') === '') throw new HttpError(400, 'judgment_id is required');
  if (goTrim(body.relation ?? '') === '') throw new HttpError(400, 'relation is required');
  if (body.confidence !== undefined && (body.confidence < 0 || body.confidence > 1)) throw new HttpError(400, 'confidence must be between 0.0 and 1.0');
  const params = { judgment_id: body.judgment_id, relation: body.relation, marked_by_actor: 'agent', marked_by_kind: 'agent', session_id: body.session_id ?? '' };
  if (body.reason) params.reason = body.reason;
  if (body.evidence) params.evidence = body.evidence;
  if (body.confidence !== undefined) params.confidence = body.confidence;
  let relation;
  try {
    relation = judgeRelation(ctx.store, params);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  ctx.notifyWrite();
  sendJson(ctx.res, 200, { relation: relationJson(relation) });
}

export async function compareRoute(ctx) {
  const body = await readFields(ctx, { memory_id_a: 'int', memory_id_b: 'int', relation: 'string', confidence: 'float', reasoning: 'string', model: 'string' });
  if (!body.memory_id_a) throw new HttpError(400, 'memory_id_a is required');
  if (!body.memory_id_b) throw new HttpError(400, 'memory_id_b is required');
  if (goTrim(body.relation ?? '') === '') throw new HttpError(400, 'relation is required');
  if (goTrim(body.reasoning ?? '') === '') throw new HttpError(400, 'reasoning is required');
  if (body.confidence === undefined) throw new HttpError(400, 'confidence is required');
  if (body.confidence < 0 || body.confidence > 1) throw new HttpError(400, 'confidence must be between 0.0 and 1.0');
  const a = getObservation(ctx.store, body.memory_id_a);
  if (!a) throw new HttpError(404, `observation id=${body.memory_id_a} not found: sql: no rows in result set`);
  const b = getObservation(ctx.store, body.memory_id_b);
  if (!b) throw new HttpError(404, `observation id=${body.memory_id_b} not found: sql: no rows in result set`);
  let syncId;
  try {
    syncId = judgeBySemantic(ctx.store, {
      source_id: a.sync_id, target_id: b.sync_id, relation: body.relation, confidence: body.confidence, reasoning: body.reasoning, model: body.model ?? '',
    });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  if (syncId !== '') ctx.notifyWrite();
  sendJson(ctx.res, 200, { sync_id: syncId });
}

// ─── Conflictos ──────────────────────────────────────────────────────────────

export function listConflictsRoute(ctx) {
  const res = projectOrThrow(ctx);
  const project = res.project ?? '';
  const status = ctx.query.get('status') ?? '';
  const limit = clampConflictsLimit(queryInt(ctx.query, 'limit', CONFLICTS_DEFAULT_LIMIT), CONFLICTS_DEFAULT_LIMIT);
  const offset = queryInt(ctx.query, 'offset', 0);
  const filter = { project, status, actionable_only: true, exclude_not_conflict: true };
  const since = ctx.query.get('since') ?? '';
  if (since !== '') {
    const time = parseRfc3339(since);
    if (!time) throw new HttpError(400, 'invalid since parameter: must be RFC3339');
    filter.since_time = time;
  }
  let relations;
  let total;
  try {
    relations = listRelations(ctx.store, { ...filter, limit, offset });
    total = countRelations(ctx.store, filter);
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  sendJson(ctx.res, 200, { total, limit, offset, relations });
}

/** Fecha RFC 3339 (`2006-01-02T15:04:05Z07:00`, con fracción opcional) o `null`. */
export function parseRfc3339(text) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export function getConflictRoute(ctx) {
  const id = parseId(ctx.params.relation_id);
  if (id === null) throw new HttpError(400, 'invalid relation_id: must be an integer');
  let item;
  try {
    item = getRelationByIntId(ctx.store, id);
  } catch (err) {
    throw new HttpError(404, err.message);
  }
  sendJson(ctx.res, 200, {
    relation_id: item.id, sync_id: item.sync_id, relation: item.relation, judgment_status: item.judgment_status, source_id: item.source_id,
    source_snippet: item.source_title, target_id: item.target_id, target_snippet: item.target_title, created_at: item.created_at, updated_at: item.updated_at,
  });
}

export function conflictStatsRoute(ctx) {
  const res = projectOrThrow(ctx);
  let stats;
  try {
    stats = getActionableRelationStats(ctx.store, res.project ?? '');
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  sendJson(ctx.res, 200, {
    project: stats.project, by_relation: stats.by_relation, by_judgment_status: stats.by_judgment_status, deferred: stats.deferred, dead: stats.dead,
  });
}

export function listDeferredRoute(ctx) {
  const status = ctx.query.get('status') ?? '';
  const limit = clampConflictsLimit(queryInt(ctx.query, 'limit', CONFLICTS_DEFAULT_LIMIT), CONFLICTS_DEFAULT_LIMIT);
  const offset = queryInt(ctx.query, 'offset', 0);
  let rows;
  let total;
  try {
    rows = listDeferred(ctx.store, { status, limit, offset });
    total = listDeferred(ctx.store, { status }).length;
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  sendJson(ctx.res, 200, { total, limit, rows });
}

const SCAN_BODY = {
  project: 'string', all_projects: 'bool', since: 'string', apply: 'bool', max_insert: 'int', limit: 'int', cursor: 'int', semantic: 'bool',
  concurrency: 'int', timeout_per_call_seconds: 'int', max_semantic: 'int',
};

export async function scanConflictsRoute(ctx) {
  const body = await readFields(ctx, SCAN_BODY);
  if (body.all_projects && goTrim(body.project ?? '') !== '') throw new HttpError(400, 'project and all_projects cannot be used together');
  let resolved;
  try {
    resolved = resolveProject({
      mode: body.all_projects ? 'all' : 'current', explicit: body.project ?? '', directory: ctx.query.get('cwd') ?? '',
      projectExists: (name) => projectExists(ctx.store, name), detect: (dir) => detectProject(ctx.store, dir),
      requireKnownExplicit: true, requireKnownProcess: true, env: ctx.env,
    });
  } catch (err) {
    throw projectResolutionError(ctx, err.result ?? {}, err);
  }
  if (body.limit !== undefined && (body.limit < 1 || body.limit > DEFAULT_SCAN_LIMIT)) throw new HttpError(400, `limit must be between 1 and ${DEFAULT_SCAN_LIMIT}`);
  if (body.cursor !== undefined && body.cursor < 0) throw new HttpError(400, 'cursor must be non-negative');
  let concurrency = 5;
  let timeoutSeconds = 60;
  let maxSemantic = 100;
  if (body.semantic) {
    concurrency = body.concurrency ?? concurrency;
    timeoutSeconds = body.timeout_per_call_seconds ?? timeoutSeconds;
    maxSemantic = body.max_semantic ?? maxSemantic;
    if (concurrency < 1 || concurrency > 20) throw new HttpError(400, `concurrency must be between 1 and 20; got ${concurrency}`);
    if (timeoutSeconds < 1 || timeoutSeconds > 600) throw new HttpError(400, `timeout_per_call_seconds must be between 1 and 600; got ${timeoutSeconds}`);
  }
  const opts = { project: resolved.project ?? '', apply: body.apply === true, max_insert: body.max_insert ?? 0 };
  if (body.limit !== undefined) opts.limit = body.limit;
  if (body.cursor !== undefined) opts.cursor = body.cursor;
  if (body.since) {
    const since = parseRfc3339(body.since);
    if (!since) throw new HttpError(400, 'invalid since: must be RFC3339');
    opts.since = since;
  }
  if (body.semantic) {
    if (!ctx.llm?.runnerFactory) throw new HttpError(500, 'ODIN_AGENT_CLI not set: server runnerFactory is not configured');
    let runner;
    try {
      runner = ctx.llm.runnerFactory(ctx.env.ODIN_AGENT_CLI ?? '');
    } catch (err) {
      throw new HttpError(500, `failed to resolve agent runner: ${err.message}`);
    }
    Object.assign(opts, {
      semantic: true, concurrency, timeout_per_call_ms: timeoutSeconds * 1000, max_semantic: maxSemantic, runner, build_prompt: ctx.llm.buildPrompt ?? (() => ''),
    });
  }
  let result;
  try {
    result = await (body.all_projects ? scanAllProjects : scanProject)(ctx.store, opts);
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  const out = {
    project: result.project, inspected: result.inspected, ranked_queries: result.ranked_queries, candidates_found: result.candidates_found,
    already_related: result.already_related, inserted: result.inserted, capped: result.capped, dry_run: result.dry_run,
    semantic_judged: result.semantic_judged, semantic_skipped: result.semantic_skipped, semantic_errors: result.semantic_errors,
  };
  if (result.next_cursor !== undefined) out.next_cursor = result.next_cursor;
  if (result.capped) out.warning = 'cap reached: this page has no continuation; rerun from the same cursor with a higher applicable cap';
  sendJson(ctx.res, 200, out);
}
