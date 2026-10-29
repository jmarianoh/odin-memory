import {
  allObservations, allSessions, deleteSession, getObservation, searchObservations, sessionObservations, stats, timeline,
} from '../store/index.js';
import { SLUGS, setupClient, targets } from '../setup/install.js';
import { checkLatest } from '../version/check.js';
import { effectiveToken } from '../cloud/config.js';
import {
  listCloudEnrollment, loadCloudSettings, loadCloudStatus, pingCloudServer, saveCloudServerUrl, toggleCloudEnrollment,
} from './cloud.js';
import { osc52Sequence } from './format.js';

/** Cuántos resultados trae cada lista. */
export const LIST_LIMIT = 50;
export const SESSION_OBSERVATIONS_LIMIT = 200;
const TIMELINE_SPAN = 10;

const DESCRIPTIONS = Object.freeze({
  'vscode-copilot': 'VS Code Copilot — MCP server, instructions and hooks',
  'copilot-cli': 'Copilot CLI — MCP server, instructions and hooks',
});

/**
 * Destinos de instalación que ofrece la pantalla de preparación.
 * @param {{ env: NodeJS.ProcessEnv, home: () => string, cwd: () => string, platform?: string }} ctx
 */
export function setupAgents(ctx) {
  return SLUGS.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    installDir: targets(name, { env: ctx.env, home: ctx.home, cwd: ctx.cwd(), platform: ctx.platform ?? process.platform }).mcp,
  }));
}

/** Ejecuta una operación de la nube y devuelve su resultado (o el error) como mensaje `type`. */
function cloudResult(type, extra, fn) {
  try {
    return { type, ...extra, ...fn() };
  } catch (error) {
    return failure(type, error, extra);
  }
}

const failure = (type, error, extra = {}) => ({ type, error: error instanceof Error ? error : new Error(String(error)), ...extra });

/**
 * Ejecuta un comando de `model.js` y devuelve el mensaje con su resultado (o `null` si no tiene).
 * Los errores del almacén no se propagan: vuelven dentro del mensaje, como en el resto de la TUI.
 * @param {{ type: string, [k: string]: any }} cmd
 * @param {{ store: object, version: string, env: NodeJS.ProcessEnv, home: () => string, cwd: () => string, platform?: string, checkLatest?: Function }} ctx
 * @returns {Promise<object|null>|object|null}
 */
export function executeCommand(cmd, ctx) {
  const { store } = ctx;
  try {
    switch (cmd.type) {
      case 'load-stats': return { type: 'stats', stats: stats(store) };
      case 'check-update': return (ctx.checkLatest ?? checkLatest)(ctx.version, { env: ctx.env }).then((result) => ({ type: 'update-check', result }));
      case 'search': return { type: 'search-results', results: searchObservations(store, cmd.query, { limit: LIST_LIMIT }), query: cmd.query };
      case 'load-recent': return { type: 'recent-observations', observations: allObservations(store, '', '', LIST_LIMIT) };
      case 'load-detail': {
        const observation = getObservation(store, cmd.id);
        return observation ? { type: 'observation-detail', observation } : failure('observation-detail', `observation #${cmd.id} not found`);
      }
      case 'load-timeline': return { type: 'timeline', timeline: timeline(store, cmd.id, TIMELINE_SPAN, TIMELINE_SPAN) };
      case 'load-sessions': return { type: 'recent-sessions', sessions: allSessions(store, '', LIST_LIMIT) };
      case 'load-session-observations': return { type: 'session-observations', observations: sessionObservations(store, cmd.id, SESSION_OBSERVATIONS_LIMIT) };
      case 'delete-session':
        try {
          deleteSession(store, cmd.id);
          return { type: 'session-deleted', sessionId: cmd.id, error: null };
        } catch (error) {
          return { type: 'session-deleted', sessionId: cmd.id, error };
        }
      case 'install': {
        const changes = setupClient(cmd.agent, { env: ctx.env, home: ctx.home, cwd: ctx.cwd(), platform: ctx.platform ?? process.platform });
        return { type: 'setup-installed', result: { agent: cmd.agent, changes } };
      }
      case 'load-cloud-config': return cloudResult('cloud-config-loaded', { generation: cmd.generation }, () => loadCloudSettings(store.dataDir, ctx.env));
      case 'load-cloud-status': return cloudResult('cloud-status-loaded', { generation: cmd.generation }, () => loadCloudStatus(store, ctx.env));
      case 'load-cloud-enrollment': return cloudResult('cloud-enrollment-loaded', {}, () => ({ items: listCloudEnrollment(store) }));
      case 'toggle-cloud-enrollment': return cloudResult('cloud-enrollment-toggled', {}, () => toggleCloudEnrollment(store, cmd.item));
      case 'save-cloud-url': return cloudResult('cloud-url-saved', {}, () => saveCloudServerUrl(store.dataDir, cmd.serverUrl));
      case 'ping-cloud': {
        const { token } = effectiveToken(store.dataDir, ctx.env);
        return pingCloudServer(cmd.serverUrl, token, ctx.fetch).then(({ status, error }) => ({
          type: 'cloud-ping', origin: cmd.origin, generation: cmd.generation, serverUrl: cmd.serverUrl, status, error,
        }));
      }
      case 'copy': return { type: 'clipboard-copied', sequence: osc52Sequence(cmd.content) };
      default: return null;
    }
  } catch (error) {
    const types = {
      'load-stats': 'stats', search: 'search-results', 'load-recent': 'recent-observations', 'load-timeline': 'timeline', 'load-sessions': 'recent-sessions',
      'load-session-observations': 'session-observations', install: 'setup-installed',
    };
    return types[cmd.type] ? failure(types[cmd.type], error) : null;
  }
}
