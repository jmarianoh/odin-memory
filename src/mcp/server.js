import { VERSION } from '../version/index.js';
import { SessionActivity } from './activity.js';
import { McpServer } from './protocol.js';
import { buildServerInstructions, shouldRegister } from './profiles.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';
import { contextTool } from './tools/context.js';
import { doctorTool } from './tools/doctor.js';
import { currentProject, listProjects, statsTool, suggestTopicKeyTool } from './tools/projects.js';
import { getObservationTool, searchPromptsTool, searchTool, timelineTool } from './tools/search.js';
import { compareTool, consolidateTool, judgeManyTool, judgeTool, mergeProjectsTool, sessionFinalizeTool } from './tools/curation.js';
import { capturePassiveTool, savePromptTool, sessionEndTool, sessionStartTool, sessionSummaryTool } from './tools/sessions.js';
import { deleteTool, pinTool, reviewTool, saveTool, updateTool } from './tools/write.js';
import { WriteQueue, queuedWriteHandler } from './write-queue.js';

/** Nombre con el que el servidor se presenta al anfitrión. */
export const SERVER_NAME = 'odin-memory';

/**
 * @typedef {object} McpConfig
 * @property {string} [version] versión que se anuncia (por defecto la del producto)
 * @property {string} [defaultProject] proyecto fijado para el proceso (`--project` / `ODIN_PROJECT`)
 * @property {number} [bm25Floor] umbral inferior obsoleto para los candidatos de conflicto de `mem_save`
 * @property {number} [limit] máximo de candidatos de conflicto por `mem_save` (por defecto 3)
 */

/**
 * Construye las herramientas disponibles: cada manejador recibe los argumentos de
 * la llamada y devuelve el resultado MCP.
 * @param {object} ctx contexto compartido (`store`, `config`, `activity`, `env`)
 * @returns {Record<string, (args: object) => object>}
 */
export function buildHandlers(ctx) {
  const queued = (handler) => queuedWriteHandler(ctx.writeQueue, handler);
  return {
    mem_current_project: currentProject(ctx),
    mem_list_projects: listProjects(ctx),
    mem_suggest_topic_key: suggestTopicKeyTool(),
    mem_stats: statsTool(ctx),
    mem_doctor: doctorTool(ctx),
    mem_context: contextTool(ctx),
    mem_search: searchTool(ctx),
    mem_search_prompts: searchPromptsTool(ctx),
    mem_get_observation: getObservationTool(ctx),
    mem_timeline: timelineTool(ctx),
    // Escrituras: se serializan en la cola (salvo fijar/desfijar, que es una marca local).
    mem_save: queued(saveTool(ctx)),
    mem_update: queued(updateTool(ctx)),
    mem_review: queued(reviewTool(ctx)),
    mem_delete: queued(deleteTool(ctx)),
    mem_save_prompt: queued(savePromptTool(ctx)),
    mem_session_summary: queued(sessionSummaryTool(ctx)),
    mem_session_start: queued(sessionStartTool(ctx)),
    mem_session_end: queued(sessionEndTool(ctx)),
    mem_capture_passive: queued(capturePassiveTool(ctx)),
    mem_judge: queued(judgeTool(ctx)),
    mem_judge_many: queued(judgeManyTool(ctx)),
    mem_compare: compareTool(ctx),
    mem_merge_projects: queued(mergeProjectsTool(ctx)),
    mem_consolidate: queued(consolidateTool(ctx)),
    mem_session_finalize: queued(sessionFinalizeTool(ctx)),
    mem_pin: pinTool(ctx, true),
    mem_unpin: pinTool(ctx, false),
  };
}

/**
 * Crea el servidor MCP sobre un almacén abierto.
 * @param {import('../store/store.js').Store} store
 * @param {McpConfig} [config]
 * @param {Set<string>|null} [allowlist] herramientas permitidas (`null` = todas)
 * @param {{ activity?: SessionActivity, env?: NodeJS.ProcessEnv, cwd?: () => string, hostPid?: number, hostbind?: object, writeQueue?: WriteQueue }} [options]
 * @returns {McpServer}
 */
export function createServer(store, config = {}, allowlist = null, options = {}) {
  const ctx = {
    store,
    config: { defaultProject: '', ...config },
    activity: options.activity ?? new SessionActivity(),
    env: options.env ?? process.env,
    cwd: options.cwd ?? (() => process.cwd()),
    hostPid: options.hostPid,
    hostbind: options.hostbind,
    writeQueue: options.writeQueue ?? new WriteQueue(),
  };
  const handlers = buildHandlers(ctx);
  const tools = TOOL_DEFINITIONS.filter((d) => shouldRegister(d.name, allowlist) && handlers[d.name]).map((definition) => ({
    definition,
    handler: handlers[definition.name],
  }));
  return new McpServer({ name: SERVER_NAME, version: config.version ?? VERSION, instructions: buildServerInstructions(allowlist), tools });
}
