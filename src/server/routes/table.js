import { compactionContextRoute, contextRoute, currentProjectRoute, exportRoute, importRoute, listProjectsRoute, promptCaptureDecisionRoute, statsRoute } from './context.js';
import {
  addObservationRoute, deleteObservationRoute, getObservationRoute, getSaveResult, listObservationsRoute, passiveCaptureRoute, pinRoute,
  recentObservationsRoute, reviewListRoute, reviewMarkRoute, searchRoute, suggestTopicKeyRoute, timelineRoute, updateObservationRoute,
} from './observations.js';
import { addPromptRoute, deletePromptRoute, recentPromptsRoute, searchPromptsRoute } from './prompts.js';
import {
  createSession, deleteSessionRoute, endSessionRoute, finalizeSessionRoute, getSessionRoute, recentSessionsRoute, runtimeSessionRoute,
} from './sessions.js';
import {
  compareRoute, conflictStatsRoute, consolidateRoute, getConflictRoute, judgeManyRoute, judgeRoute, listConflictsRoute, listDeferredRoute, scanConflictsRoute,
} from './workflows.js';
import { compatibilityRoute, healthRoute, runtimeContractRoute, syncStatusRoute } from './system.js';

/**
 * Tabla de rutas. `id` identifica las que forman el contrato de runtime; `auth`
 * exige el token de `ODIN_HTTP_TOKEN` cuando está configurado; `configured` exige
 * además que esté configurado.
 * @type {{ id?: string, pattern: string, handler: Function, auth?: boolean, configured?: boolean }[]}
 */
export const ROUTES = [
  { id: 'session-create', pattern: 'POST /sessions', handler: createSession },
  { id: 'session-end', pattern: 'POST /sessions/{id}/end', handler: endSessionRoute },
  { id: 'runtime-session-resolve', pattern: 'POST /runtime-sessions/resolve', handler: runtimeSessionRoute },
  { id: 'runtime-session-end', pattern: 'POST /runtime-sessions/end', handler: runtimeSessionRoute },
  { id: 'observation-add', pattern: 'POST /observations', handler: addObservationRoute },
  { id: 'observation-passive', pattern: 'POST /observations/passive', handler: passiveCaptureRoute },
  { id: 'observation-save-result', pattern: 'GET /observations/save-result', handler: getSaveResult },
  { id: 'observation-pin', pattern: 'PUT /observations/{id}/pin', handler: pinRoute(true) },
  { id: 'observation-unpin', pattern: 'DELETE /observations/{id}/pin', handler: pinRoute(false) },
  { id: 'observation-update', pattern: 'PATCH /observations/{id}', handler: updateObservationRoute },
  { id: 'observation-delete', pattern: 'DELETE /observations/{id}', handler: deleteObservationRoute, auth: true },
  { id: 'topic-key-suggest', pattern: 'POST /topic-keys/suggest', handler: suggestTopicKeyRoute },
  { id: 'observation-consolidate', pattern: 'POST /observations/consolidate', handler: consolidateRoute, auth: true },
  { id: 'conflict-judge-many', pattern: 'POST /conflicts/judge-many', handler: judgeManyRoute, auth: true },
  { id: 'session-finalize', pattern: 'POST /sessions/{id}/finalize', handler: finalizeSessionRoute, auth: true },
  { id: 'search', pattern: 'GET /search', handler: searchRoute },
  { id: 'prompt-search', pattern: 'GET /prompts/search', handler: searchPromptsRoute },
  { id: 'timeline', pattern: 'GET /timeline', handler: timelineRoute },
  { id: 'observation-get', pattern: 'GET /observations/{id}', handler: getObservationRoute },
  { id: 'review-list', pattern: 'GET /review', handler: reviewListRoute },
  { id: 'review-mark', pattern: 'POST /review/mark_reviewed', handler: reviewMarkRoute },
  { id: 'prompt-add', pattern: 'POST /prompts', handler: addPromptRoute },
  { id: 'prompt-capture-decision', pattern: 'POST /prompts/capture-decision', handler: promptCaptureDecisionRoute },
  { id: 'context', pattern: 'GET /context', handler: contextRoute },
  { id: 'compaction-context', pattern: 'GET /context/compaction', handler: compactionContextRoute },
  { id: 'stats', pattern: 'GET /stats', handler: statsRoute },
  { id: 'projects', pattern: 'GET /projects', handler: listProjectsRoute },
  { id: 'current-project', pattern: 'GET /project/current', handler: currentProjectRoute },
  { id: 'conflict-judge', pattern: 'POST /conflicts/judge', handler: judgeRoute },
  { id: 'conflict-compare', pattern: 'POST /conflicts/compare', handler: compareRoute },

  { pattern: 'GET /compatibility', handler: compatibilityRoute, auth: true },
  { pattern: 'GET /runtime-contract', handler: runtimeContractRoute },
  { pattern: 'GET /health', handler: healthRoute },
  { pattern: 'GET /sessions/recent', handler: recentSessionsRoute },
  { pattern: 'GET /sessions/{id}', handler: getSessionRoute },
  { pattern: 'DELETE /sessions/{id}', handler: deleteSessionRoute, auth: true },
  { pattern: 'GET /observations', handler: listObservationsRoute },
  { pattern: 'GET /observations/recent', handler: recentObservationsRoute },
  { pattern: 'GET /prompts/recent', handler: recentPromptsRoute },
  { pattern: 'DELETE /prompts/{id}', handler: deletePromptRoute, auth: true },
  { pattern: 'GET /export', handler: exportRoute, auth: true },
  { pattern: 'POST /import', handler: importRoute, auth: true },
  { pattern: 'GET /sync/status', handler: syncStatusRoute },
  { pattern: 'GET /conflicts', handler: listConflictsRoute },
  { pattern: 'GET /conflicts/stats', handler: conflictStatsRoute },
  { pattern: 'GET /conflicts/deferred', handler: listDeferredRoute },
  { pattern: 'POST /conflicts/scan', handler: scanConflictsRoute },
  { pattern: 'GET /conflicts/{relation_id}', handler: getConflictRoute },
];
