import { AutosyncManager, PHASE } from '../cloud/autosync.js';
import { resolveCloudRuntimeConfig } from '../cloud/config.js';
import { MutationTransport } from '../cloud/remote.js';
import { processOverride } from '../project/detect.js';
import { normalizeProject } from '../project/canonical.js';
import { inspectProject } from "../store/project-history.js";
import { storeSyncStatus } from '../server/sync-status.js';
import { goTrim } from '../store/text.js';

/**
 * Arranca la sincronización en segundo plano si `ODIN_CLOUD_AUTOSYNC` vale exactamente `1` y hay servidor y token.
 * Nunca es fatal: ante una configuración incompleta o inválida lo anota en el error estándar y no arranca.
 * @param {import('./runtime.js').Cli} cli
 * @param {import('../store/store.js').Store} store
 * @param {{ dataDir: string }} config
 * @returns {AutosyncManager|null}
 */
export function tryStartAutosync(cli, store, config) {
  if (goTrim(cli.env.ODIN_CLOUD_AUTOSYNC ?? '') !== '1') return null;
  const log = (message) => cli.err(`${message}\n`);
  let runtime;
  try {
    runtime = resolveCloudRuntimeConfig(config.dataDir, cli.env);
  } catch (err) {
    log(`[autosync] ERROR: cannot read cloud config: ${err.message}`);
    return null;
  }
  const token = goTrim(runtime.token);
  const serverUrl = goTrim(runtime.server_url);
  if (token === '') {
    log('[autosync] ERROR: cloud token is not configured (set ODIN_CLOUD_TOKEN or store token in cloud.json via `odin cloud config`); autosync disabled');
    return null;
  }
  if (serverUrl === '') {
    log('[autosync] ERROR: cloud server URL is not configured (set ODIN_CLOUD_SERVER or run `odin cloud config --server <url>`); autosync disabled');
    return null;
  }
  let transport;
  try {
    transport = new MutationTransport(serverUrl, token, { log, ...(cli.fetch ? { fetch: cli.fetch } : {}) });
  } catch (err) {
    log(`[autosync] ERROR: invalid server URL ${JSON.stringify(serverUrl)}: ${err.message}; autosync disabled`);
    return null;
  }
  const manager = new AutosyncManager(store, transport, { log, ...(cli.autosync ?? {}) });
  manager.start();
  log(`[autosync] started (server=${serverUrl})`);
  return manager;
}

/** Proyecto del estado de sincronización cuando la petición no trae ninguno: el del proceso o el del directorio. */
export function serveStatusProject(cli, store) {
  const override = processOverride('', cli.env);
  let project = override.ok ? override.value : '';
  if (!override.ok) {
    try {
      project = inspectProject(store, cli.cwd()).project;
    } catch {
      project = '';
    }
  }
  return goTrim(normalizeProject(project ?? '').normalized);
}

/** Estado de sincronización local, con la configuración de la nube del cliente. */
export function localSyncStatus(cli, store, config) {
  return storeSyncStatus(store, {
    defaultProject: serveStatusProject(cli, store),
    cloudConfig: () => {
      try {
        return resolveCloudRuntimeConfig(config.dataDir, cli.env);
      } catch {
        return null;
      }
    },
  });
}

/**
 * Estado que ve la API local: el del gestor de segundo plano si lo hay (más el de migración del almacén)
 * y, si no, el del almacén.
 * @param {AutosyncManager|null} manager
 * @param {(project: string) => object} fallback
 * @returns {(project: string) => object}
 */
export function autosyncSyncStatus(manager, fallback) {
  if (manager === null) return fallback;
  return (project) => {
    const base = fallback(project);
    const st = manager.status();
    const result = {
      enabled: true, last_error: st.lastError, consecutive_failures: st.consecutiveFailures,
      backoff_until: st.backoffUntil ? st.backoffUntil.toISOString().replace('.000Z', 'Z') : null,
      last_sync_at: st.lastSyncAt ? st.lastSyncAt.toISOString().replace('.000Z', 'Z') : null,
      deferred_count: st.deferredCount, dead_count: st.deadCount,
      upgrade_stage: base.upgrade_stage, upgrade_reason_code: base.upgrade_reason_code, upgrade_reason_message: base.upgrade_reason_message,
    };
    switch (st.phase) {
      case PHASE.healthy:
        return { ...result, phase: 'healthy', reason_code: '', reason_message: '' };
      case PHASE.pushing: case PHASE.pulling: case PHASE.idle:
        return { ...result, phase: 'running', reason_code: '', reason_message: '' };
      case PHASE.pushFailed: case PHASE.pullFailed: case PHASE.backoff:
        return { ...result, phase: 'degraded', reason_code: st.reasonCode || 'transport_failed', reason_message: st.reasonMessage || st.lastError };
      case PHASE.disabled:
        return { ...result, phase: 'degraded', reason_code: 'upgrade_paused', reason_message: st.reasonMessage };
      default:
        return { ...result, phase: st.phase, reason_code: st.reasonCode, reason_message: st.reasonMessage };
    }
  };
}
