import { normalizeProject } from '../project/canonical.js';
import { SYNC_LIFECYCLE, cloudTargetKeyForProject, getCloudUpgradeState, getSyncState, isProjectEnrolled } from '../store/index.js';
import { goTrim } from '../store/text.js';

export const REASON_BLOCKED_UNENROLLED = 'blocked_unenrolled';

const text = (v) => (v == null ? '' : v);

/** Marca de tiempo `YYYY-MM-DD HH:MM:SS` (UTC) o RFC 3339 → ISO 8601; `null` si no es válida. */
function parseTimestamp(value) {
  const trimmed = goTrim(text(value));
  if (trimmed === '') return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed) ? `${trimmed.replace(' ', 'T')}Z` : trimmed;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace('.000Z', 'Z');
}

function hasMeaningfulState(state) {
  if (!state) return false;
  if (state.lifecycle && state.lifecycle !== SYNC_LIFECYCLE.idle) return true;
  if (state.last_enqueued_seq > 0 || state.last_acked_seq > 0 || state.last_pulled_seq > 0) return true;
  if (state.consecutive_failures > 0) return true;
  if (state.backoff_until != null || state.lease_owner != null || state.lease_until != null) return true;
  return state.reason_code != null || state.reason_message != null || state.last_error != null;
}

function statusFromState(state) {
  return {
    phase: state.lifecycle, last_error: text(state.last_error), consecutive_failures: state.consecutive_failures ?? 0,
    backoff_until: parseTimestamp(state.backoff_until), last_sync_at: parseTimestamp(state.last_success_at),
    reason_code: text(state.reason_code), reason_message: text(state.reason_message),
  };
}

/**
 * Proveedor de estado de sincronización a partir del almacén local. La
 * configuración de la nube es un gancho (`cloudConfig`): sin ella, la nube
 * figura como no configurada.
 * @param {import('../store/store.js').Store} store
 * @param {object} [options]
 * @param {string} [options.defaultProject] proyecto cuando la petición no trae ninguno
 * @param {() => ({ server_url?: string } | null)} [options.cloudConfig]
 * @returns {(project: string) => object}
 */
export function storeSyncStatus(store, { defaultProject = '', cloudConfig = () => null } = {}) {
  return (project) => {
    let resolved = goTrim(normalizeProject(project ?? '').normalized);
    if (resolved === '') resolved = goTrim(normalizeProject(defaultProject).normalized);
    let upgrade = { stage: '', code: '', message: '' };
    if (resolved !== '') {
      try {
        const state = getCloudUpgradeState(store, resolved);
        if (state) upgrade = { stage: state.stage, code: goTrim(state.last_error_code), message: goTrim(state.last_error_message) };
      } catch (err) {
        upgrade = { stage: '', code: 'upgrade_status_unavailable', message: `cloud upgrade status is unavailable: ${err.message}` };
      }
    }
    const base = { upgrade_stage: upgrade.stage, upgrade_reason_code: upgrade.code, upgrade_reason_message: upgrade.message };
    const disabled = (code, message) => ({ enabled: false, phase: SYNC_LIFECYCLE.idle, reason_code: code, reason_message: message, ...base });

    const config = cloudConfig();
    const targetKey = cloudTargetKeyForProject(resolved);
    if (config == null || goTrim(config.server_url ?? '') === '') {
      if (resolved === '') return disabled('cloud_not_configured', 'cloud sync is not configured');
      if (!isProjectEnrolled(store, resolved)) return disabled(REASON_BLOCKED_UNENROLLED, `project ${JSON.stringify(resolved)} is not enrolled for cloud sync`);
      const state = getSyncState(store, targetKey);
      if (hasMeaningfulState(state)) return { ...statusFromState(state), enabled: true, ...base };
      return disabled('cloud_not_configured', 'cloud sync is not configured');
    }
    if (resolved === '') return disabled('project_required', 'cloud sync status requires an explicit project scope');
    if (!isProjectEnrolled(store, resolved)) return disabled(REASON_BLOCKED_UNENROLLED, `project ${JSON.stringify(resolved)} is not enrolled for cloud sync`);
    const state = getSyncState(store, targetKey);
    return { ...statusFromState(state), enabled: true, ...base };
  };
}
