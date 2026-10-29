import { normalizeProject } from '../project/canonical.js';
import { goTrim } from '../store/text.js';
import {
  cloudTargetKeyForProject, isProjectEnrolled, markSyncAuthRequired, markSyncBlocked, markSyncFailure,
} from '../store/sync-state.js';
import { resolveCloudRuntimeConfig, validateServerUrl } from './config.js';
import { REASON } from './constants.js';
import { appendGuidance, projectFromTargetKey } from './guidance.js';

/** Segundos que se espera antes de reintentar tras un fallo de transporte. */
export const FAILURE_BACKOFF_MS = 30_000;

/**
 * Comprobaciones previas a sincronizar un proyecto con la nube: servidor configurado y válido, y proyecto
 * inscrito. Con `mutateState`, deja el motivo del bloqueo en el estado del destino.
 * @param {import('../store/store.js').Store} store
 * @param {{ dataDir: string }} config
 * @param {string} project
 * @param {boolean} mutateState
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ server_url: string, token: string }}
 * @throws {Error}
 */
export function preflightCloudSync(store, config, project, mutateState, env = process.env) {
  let name = goTrim(project ?? '');
  if (name !== '') name = normalizeProject(name).normalized;
  const targetKey = cloudTargetKeyForProject(name);
  const block = (reason, message) => {
    if (mutateState) markSyncBlocked(store, targetKey, reason, message);
    return new Error(`cloud sync ${reason}: ${message}`);
  };

  let runtime;
  try {
    runtime = resolveCloudRuntimeConfig(config.dataDir, env);
  } catch (err) {
    throw new Error(`cloud sync config error: ${err.message}`, { cause: err });
  }
  if (goTrim(runtime.server_url) === '') {
    throw block(REASON.cloudConfigError, 'cloud server is missing: configure server URL with `odin cloud config --server <url>`');
  }
  try {
    validateServerUrl(runtime.server_url);
  } catch (err) {
    throw block(REASON.cloudConfigError, `invalid cloud runtime server URL: ${err.message}`);
  }
  if (name !== '' && !isProjectEnrolled(store, name)) {
    throw block(REASON.blockedUnenrolled, `project ${JSON.stringify(name)} is not enrolled for cloud sync`);
  }
  return runtime;
}

/** Mensaje de un fallo de sincronización, con las instrucciones de recuperación que correspondan. */
export const cloudSyncFailureMessage = (project, err) => (err ? appendGuidance(err.message, project, err) : '');

/** Registra en el estado del destino el fallo de una sincronización y, según su clase, bloquea o reintenta. */
export function markCloudSyncFailure(store, targetKey, err) {
  if (!err) return;
  const message = cloudSyncFailureMessage(projectFromTargetKey(targetKey), err);
  if (err.isAuthFailure === true) return markSyncAuthRequired(store, targetKey, message);
  if (err.isPolicyFailure === true) return markSyncBlocked(store, targetKey, REASON.policyForbidden, message);
  return markSyncFailure(store, targetKey, message, new Date(Date.now() + FAILURE_BACKOFF_MS));
}
