import {
  consolidateObservations, finalizeSession, getObservation, getSession, judgeBySemantic, judgeRelation, mergeExplicitProjectVariants,
} from '../../store/index.js';
import { goTrim } from '../../store/text.js';
import { addErrorMetadata, errorWithMeta, respondWithProject, writeProjectErrorResult } from '../envelope.js';
import { errorResult, goQuote, jsonMarshal, textResult } from '../json.js';
import { observationJson, relationJson } from '../serialize.js';
import { resolveSaveWriteProjectForSession } from '../write-projects.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ─── mem_judge / mem_judge_many ──────────────────────────────────────────────

/** Parámetros de `judgeRelation` a partir de los argumentos de la herramienta, o un error de uso. */
function judgeParams(args) {
  const p = { marked_by_actor: 'agent', marked_by_kind: 'agent' };
  p.judgment_id = typeof args.judgment_id === 'string' ? args.judgment_id : '';
  p.relation = typeof args.relation === 'string' ? args.relation : '';
  p.session_id = typeof args.session_id === 'string' ? args.session_id : '';
  if (p.judgment_id === '') return { error: 'judgment_id is required' };
  if (p.relation === '') return { error: 'relation is required' };
  if (typeof args.reason === 'string' && args.reason !== '') p.reason = args.reason;
  if (typeof args.evidence === 'string' && args.evidence !== '') p.evidence = args.evidence;
  if (typeof args.confidence === 'number') {
    if (args.confidence < 0 || args.confidence > 1) return { error: 'confidence must be between 0.0 and 1.0' };
    p.confidence = args.confidence;
  }
  return { params: p };
}

export function judgeTool(ctx) {
  return (args) => {
    const parsed = judgeParams(args);
    if (parsed.error) return errorResult(parsed.error);
    let relation;
    try {
      relation = judgeRelation(ctx.store, parsed.params);
    } catch (err) {
      return errorResult(err.message);
    }
    return textResult(jsonMarshal({ relation: relationJson(relation) }));
  };
}

/** Error de tipo de un elemento del lote, sin forzar tipos; `''` si es válido. */
function judgmentItemError(raw) {
  if (!isObject(raw)) return 'judgment must be an object';
  for (const key of ['judgment_id', 'relation', 'reason', 'evidence']) {
    if (Object.hasOwn(raw, key) && typeof raw[key] !== 'string') return `${key} must be a string`;
  }
  if (Object.hasOwn(raw, 'confidence')) {
    const v = raw.confidence;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return 'confidence must be a number between 0.0 and 1.0';
  }
  return '';
}

export function judgeManyTool(ctx) {
  const judge = judgeTool(ctx);
  return (args) => {
    const items = args.judgments;
    if (!Array.isArray(items) || items.length < 1 || items.length > 32) return errorResult('judgments must be an array containing 1..32 items');
    let session = '';
    if (Object.hasOwn(args, 'session_id')) {
      if (typeof args.session_id !== 'string') return errorResult('session_id must be a string');
      session = args.session_id;
    }
    const outcomes = items.map((raw, index) => {
      const out = { index, judgment_id: null, status: 'error' };
      if (isObject(raw) && typeof raw.judgment_id === 'string') out.judgment_id = raw.judgment_id;
      let message = judgmentItemError(raw);
      if (message === '') {
        const result = judge({ ...raw, session_id: session });
        const text = result.content[0].text;
        if (result.isError) {
          message = text;
        } else {
          const envelope = JSON.parse(text);
          // Se conservan todos los campos de la respuesta individual.
          Object.assign(out, envelope);
          out.judgment_status = envelope.relation.judgment_status;
          out.status = 'success';
        }
      }
      if (message !== '') out.error = message;
      return out;
    });
    return textResult(jsonMarshal({ outcomes }));
  };
}

// ─── mem_compare ─────────────────────────────────────────────────────────────

export function compareTool(ctx) {
  return (args) => {
    const { store } = ctx;
    if (typeof args.memory_id_a !== 'number') return errorResult('memory_id_a is required (integer observation id)');
    if (typeof args.memory_id_b !== 'number') return errorResult('memory_id_b is required (integer observation id)');
    const idA = Math.trunc(args.memory_id_a);
    const idB = Math.trunc(args.memory_id_b);
    const relation = typeof args.relation === 'string' ? args.relation : '';
    if (relation === '') return errorResult('relation is required');
    const reasoning = typeof args.reasoning === 'string' ? args.reasoning : '';
    if (reasoning === '') return errorResult('reasoning is required');
    if (typeof args.confidence !== 'number') return errorResult('confidence is required (float 0.0..1.0)');
    if (args.confidence < 0 || args.confidence > 1) return errorResult('confidence must be between 0.0 and 1.0');
    const model = typeof args.model === 'string' ? args.model : '';

    const obsA = getObservation(store, idA);
    if (!obsA) return errorResult(`observation id=${idA} not found: sql: no rows in result set`);
    const obsB = getObservation(store, idB);
    if (!obsB) return errorResult(`observation id=${idB} not found: sql: no rows in result set`);
    let syncId;
    try {
      syncId = judgeBySemantic(store, { source_id: obsA.sync_id, target_id: obsB.sync_id, relation, confidence: args.confidence, reasoning, model });
    } catch (err) {
      return errorResult(err.message);
    }
    return textResult(jsonMarshal({ sync_id: syncId }));
  };
}

// ─── mem_merge_projects ──────────────────────────────────────────────────────

export function mergeProjectsTool(ctx) {
  return (args) => {
    const from = typeof args.from === 'string' ? args.from : '';
    const to = typeof args.to === 'string' ? args.to : '';
    if (from === '' || to === '') return errorResult("both 'from' and 'to' are required");
    const sources = from.split(',').map(goTrim).filter((s) => s !== '');
    if (sources.length === 0) return errorResult("at least one source project name is required in 'from'");
    let result;
    try {
      result = mergeExplicitProjectVariants(ctx.store, sources, to);
    } catch (err) {
      return errorResult(`Merge failed: ${err.message}`);
    }
    let msg = result.sources_merged.length === 0
      ? `No records moved into ${goQuote(result.canonical)}.\n`
      : `Merged ${result.sources_merged.length} source(s) into ${goQuote(result.canonical)}:\n`;
    msg += `  Observations moved: ${result.observations_updated}\n`;
    msg += `  Sessions moved:     ${result.sessions_updated}\n`;
    msg += `  Prompts moved:      ${result.prompts_updated}\n`;
    return textResult(msg);
  };
}

// ─── mem_consolidate ─────────────────────────────────────────────────────────

const CONSOLIDATE_KEYS = new Set(['ids_to_delete', 'new_title', 'new_content', 'expected_project', 'type', 'topic_key', 'confirm', 'fingerprint']);
const MAX_JSON_ID = 9007199254740991;

/** Argumentos de `mem_consolidate`; nunca admite sustituir el dueño. */
function parseConsolidate(args) {
  for (const key of Object.keys(args)) {
    if (!CONSOLIDATE_KEYS.has(key)) return { error: `unsupported argument ${goQuote(key)}; source project/session/scope cannot be overridden` };
  }
  for (const key of ['new_title', 'new_content', 'expected_project']) {
    if (typeof args[key] !== 'string' || goTrim(args[key]) === '') return { error: `${key} must be a non-empty string` };
  }
  const ids = args.ids_to_delete;
  if (!Array.isArray(ids) || ids.length < 2) return { error: 'ids_to_delete must be an array of at least two positive integer IDs' };
  for (const n of ids) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 1 || n > MAX_JSON_ID || n !== Math.trunc(n)) {
      return { error: 'ids_to_delete must contain positive exact JSON integers' };
    }
  }
  const overrides = { title: args.new_title, content: args.new_content, type: '', topic_key: '' };
  let fingerprint = '';
  for (const key of ['type', 'topic_key', 'fingerprint']) {
    if (!Object.hasOwn(args, key)) continue;
    if (typeof args[key] !== 'string') return { error: `${key} must be a string` };
    if (key === 'fingerprint') fingerprint = args[key];
    else overrides[key] = args[key];
  }
  let confirm = false;
  if (Object.hasOwn(args, 'confirm')) {
    if (typeof args.confirm !== 'boolean') return { error: 'confirm must be a boolean' };
    confirm = args.confirm;
  }
  if (confirm && goTrim(fingerprint) === '') return { error: 'fingerprint is required when confirm is true' };
  return { params: { ids: [...ids], overrides, expected_project: args.expected_project, confirm, fingerprint } };
}

/** El plan tal como lo ve el agente (la misma forma en todos los transportes). */
export function consolidationPlanJson(plan) {
  const s = plan.survivor;
  return {
    source_ids: plan.ids,
    sources: plan.sources.map(observationJson),
    project: plan.project,
    fingerprint: plan.fingerprint,
    survivor: { session_id: s.session_id, title: s.title, content: s.content, type: s.type, scope: s.scope, project: s.project, topic_key: s.topic_key },
  };
}

function consolidationToolError(code, message, plan = null) {
  const body = { error: { code, message } };
  if (plan) body.plan = consolidationPlanJson(plan);
  return errorResult(jsonMarshal(body));
}

export function consolidateTool(ctx) {
  return (args) => {
    const parsed = parseConsolidate(args);
    if (parsed.error) return consolidationToolError('invalid_arguments', parsed.error);
    let result;
    try {
      result = consolidateObservations(ctx.store, parsed.params);
    } catch (err) {
      let code = 'consolidation_refused';
      let plan = null;
      if (err.code === 'consolidate_fingerprint_mismatch') {
        code = 'fingerprint_mismatch';
        plan = err.plan ?? null;
      } else if (err.code === 'observation_project_mismatch') {
        code = 'project_mismatch';
      } else if (err.code === 'expected_project_required') {
        code = 'invalid_arguments';
      }
      return consolidationToolError(code, err.message, plan);
    }
    const body = { status: 'preview', plan: consolidationPlanJson(result.plan) };
    if (result.survivor) {
      body.status = 'consolidated';
      body.survivor = observationJson(result.survivor);
      body.soft_deleted_ids = result.plan.ids;
    }
    return textResult(jsonMarshal(body));
  };
}

// ─── mem_session_finalize ────────────────────────────────────────────────────

const FINALIZE_ERRORS = {
  session_already_ended: 'session_already_ended',
  session_not_found: 'unknown_session',
  session_ownership_mismatch: 'session_project_mismatch',
  observation_content_required: 'invalid_arguments',
};

export function sessionFinalizeTool(ctx) {
  return (args) => {
    const { store, activity } = ctx;
    for (const key of ['session_id', 'summary', 'project', 'project_choice_reason', 'recovery_token']) {
      if (Object.hasOwn(args, key) && typeof args[key] !== 'string') return errorWithMeta('invalid_arguments', `${key} must be a string`, null);
    }
    const sessionId = args.session_id ?? '';
    const summary = args.summary ?? '';
    if (goTrim(sessionId) === '' || goTrim(summary) === '') return errorWithMeta('invalid_arguments', 'session_id and summary are required and must be nonempty', null);
    // La identidad exacta se comprueba primero: la resolución compartida recorta los
    // identificadores y podría crear una sesión desconocida tras una recuperación.
    if (!getSession(store, sessionId)) return errorWithMeta('unknown_session', 'session_id must identify an existing exact session', null);

    const token = args.recovery_token ?? '';
    const validate = (res, project) => {
      if (goTrim(token) === '') return { provided: false, valid: false };
      return { provided: true, valid: activity.validateAmbiguousProjectRecoveryToken(sessionId, token, goTrim(project), res.available_projects ?? [], res.path ?? '') };
    };
    const { res: resolved, err } = resolveSaveWriteProjectForSession(
      ctx, args.project ?? '', Object.hasOwn(args, 'project'), args.project_choice_reason ?? '', sessionId, validate, false,
    );
    if (err) return writeProjectErrorResult(activity, sessionId, resolved, err);

    let result;
    try {
      result = finalizeSession(store, { session_id: sessionId, project: resolved.project, summary });
    } catch (e) {
      const response = errorWithMeta(FINALIZE_ERRORS[e.code] ?? 'session_finalize_failed', e.message, null);
      addErrorMetadata(response, { session_id: sessionId });
      return response;
    }
    let state = 'finalized';
    if (result.already_finalized) state = 'already_finalized';
    else activity.recordProjectSave(resolved.project);
    return respondWithProject(resolved, 'Session finalization completed', {
      session_id: sessionId, state, summary_id: result.summary_id, summary_sync_id: result.summary_sync_id,
      already_finalized: result.already_finalized, judgment_required: false,
    });
  };
}
