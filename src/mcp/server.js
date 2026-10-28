import { VERSION } from '../version/index.js';
import { SessionActivity } from './activity.js';
import { McpServer } from './protocol.js';
import { buildServerInstructions, shouldRegister } from './profiles.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';
import { contextTool } from './tools/context.js';
import { currentProject, listProjects, statsTool, suggestTopicKeyTool } from './tools/projects.js';
import { getObservationTool, searchPromptsTool, searchTool, timelineTool } from './tools/search.js';

/** Nombre con el que el servidor se presenta al anfitrión. */
export const SERVER_NAME = 'odin-memory';

/**
 * @typedef {object} McpConfig
 * @property {string} [version] versión que se anuncia (por defecto la del producto)
 * @property {string} [defaultProject] proyecto fijado para el proceso (`--project` / `ODIN_PROJECT`)
 */

/**
 * Construye las herramientas disponibles: cada manejador recibe los argumentos de
 * la llamada y devuelve el resultado MCP.
 * @param {object} ctx contexto compartido (`store`, `config`, `activity`, `env`)
 * @returns {Record<string, (args: object) => object>}
 */
export function buildHandlers(ctx) {
  return {
    mem_current_project: currentProject(ctx),
    mem_list_projects: listProjects(ctx),
    mem_suggest_topic_key: suggestTopicKeyTool(),
    mem_stats: statsTool(ctx),
    mem_context: contextTool(ctx),
    mem_search: searchTool(ctx),
    mem_search_prompts: searchPromptsTool(ctx),
    mem_get_observation: getObservationTool(ctx),
    mem_timeline: timelineTool(ctx),
  };
}

/**
 * Crea el servidor MCP sobre un almacén abierto.
 * @param {import('../store/store.js').Store} store
 * @param {McpConfig} [config]
 * @param {Set<string>|null} [allowlist] herramientas permitidas (`null` = todas)
 * @param {{ activity?: SessionActivity, env?: NodeJS.ProcessEnv }} [options]
 * @returns {McpServer}
 */
export function createServer(store, config = {}, allowlist = null, options = {}) {
  const ctx = {
    store,
    config: { defaultProject: '', ...config },
    activity: options.activity ?? new SessionActivity(),
    env: options.env ?? process.env,
  };
  const handlers = buildHandlers(ctx);
  const tools = TOOL_DEFINITIONS.filter((d) => shouldRegister(d.name, allowlist) && handlers[d.name]).map((definition) => ({
    definition,
    handler: handlers[definition.name],
  }));
  return new McpServer({ name: SERVER_NAME, version: config.version ?? VERSION, instructions: buildServerInstructions(allowlist), tools });
}
