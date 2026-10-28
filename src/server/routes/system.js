import { createHash } from 'node:crypto';
import { stats } from '../../store/index.js';
import { jsonMarshal } from '../../mcp/json.js';
import { HttpError, sendJson } from '../http.js';
import { projectOrThrow } from '../project.js';
import { SOURCE_ALL_PROJECTS } from '../../project/detect.js';
import { ROUTES } from './table.js';

export const SERVICE_NAME = 'odin-memory';
const CONTRACT_ID = 'odin-memory.http-runtime/v1';

export function healthRoute(ctx) {
  try {
    stats(ctx.store);
  } catch {
    throw new HttpError(500, 'health check failed');
  }
  sendJson(ctx.res, 200, {
    status: 'ok',
    service: SERVICE_NAME,
    version: ctx.version,
    instance_id: ctx.store.instanceId,
    capabilities: { isolated_session_registration: true, root_session_resume: true, runtime_session_resolution: true },
  });
}

/** Enlaces de cada operación de agente a las rutas HTTP que la atienden. */
const OPERATION_BINDINGS = {
  mem_search: ['search'], mem_context: ['context'], mem_search_prompts: ['prompt-search'], mem_get_observation: ['observation-get'],
  mem_save: ['observation-add', 'observation-save-result'], mem_session_summary: ['observation-add'], mem_update: ['observation-update'],
  mem_suggest_topic_key: ['topic-key-suggest'], mem_consolidate: ['observation-consolidate'], mem_judge_many: ['conflict-judge-many'],
  mem_session_finalize: ['session-finalize'], mem_save_prompt: ['prompt-add'], mem_session_start: ['session-create'], mem_session_end: ['session-end'],
  mem_current_project: ['current-project'], mem_doctor: ['doctor', 'caller-binding'], mem_capture_passive: ['observation-passive'],
  mem_review: ['review-list', 'review-mark'], mem_judge: ['conflict-judge'], mem_compare: ['conflict-compare'], mem_list_projects: ['projects'],
  mem_pin: ['observation-pin'], mem_unpin: ['observation-unpin'],
};
const SUPPORTING = ['runtime-session-resolve', 'runtime-session-end', 'prompt-capture-decision', 'compaction-context'];

const sortedKeys = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));

/** Contrato estable de las rutas: no depende de ningún almacén ni servidor en marcha. */
export function runtimeContractProjection() {
  const routes = {};
  for (const route of ROUTES) {
    if (route.id === undefined) continue;
    const space = route.pattern.indexOf(' ');
    const descriptor = { method: route.pattern.slice(0, space), path: route.pattern.slice(space + 1), server_contract: `${route.id}/v1` };
    if (route.auth) descriptor.configured_auth = true;
    routes[route.id] = descriptor;
  }
  const operations = {};
  for (const [name, ids] of Object.entries(OPERATION_BINDINGS)) {
    const bindings = ids.filter((id) => routes[id]).map((id) => routes[id]);
    operations[name] = { kind: 'http', bindings };
  }
  const supporting = {};
  for (const id of SUPPORTING) supporting[id] = routes[id];
  const contract = {
    contract_id: CONTRACT_ID, revision: 1, status: 'http-server-contract', operations: sortedKeys(operations), supporting_routes: sortedKeys(supporting),
  };
  const digest = createHash('sha256').update(jsonMarshal(contract)).digest('hex');
  return { ...contract, digest };
}

export function runtimeContractRoute(ctx) {
  sendJson(ctx.res, 200, { ...runtimeContractProjection(), instance_id: ctx.store.instanceId });
}

export function syncStatusRoute(ctx) {
  const res = projectOrThrow(ctx);
  if (res.source === SOURCE_ALL_PROJECTS) throw new HttpError(400, 'all_projects is not supported for sync status', { code: 'unsupported_project_scope' });
  if (!ctx.syncStatus) {
    sendJson(ctx.res, 200, { enabled: false, message: 'background sync is not configured' });
    return;
  }
  const s = ctx.syncStatus(res.project ?? '');
  sendJson(ctx.res, 200, {
    enabled: s.enabled, phase: s.phase, last_error: s.last_error ?? '', consecutive_failures: s.consecutive_failures ?? 0,
    backoff_until: s.backoff_until ?? null, last_sync_at: s.last_sync_at ?? null, reason_code: s.reason_code ?? '', reason_message: s.reason_message ?? '',
    deferred_count: s.deferred_count ?? 0, dead_count: s.dead_count ?? 0,
    upgrade: { stage: s.upgrade_stage ?? '', reason_code: s.upgrade_reason_code ?? '', reason_message: s.upgrade_reason_message ?? '' },
  });
}
