import { normalizeProject } from '../project/canonical.js';
import { goTrim } from '../store/text.js';
import { DEFAULT_SYNC_TARGET_KEY } from '../store/sync-state.js';

const HEADER = 'Known repairable cloud sync failure detected.';
const POLICY_HEADER = 'Cloud sync is blocked by server policy.';

const containsAny = (text, ...needles) => needles.some((n) => text.includes(n));

/** Nombre canónico del proyecto para las instrucciones; `<project>` si no hay. */
function displayProject(project) {
  const name = goTrim(normalizeProject(project ?? '').normalized);
  return name === '' ? '<project>' : name;
}

/** ¿El error es una denegación de la política del servidor? */
export const isPolicyFailure = (err) => err?.isPolicyFailure === true;

/**
 * ¿Es un fallo conocido que el flujo de reparación explícito puede diagnosticar?
 * No modifica nada.
 */
export function isRepairableCloudSyncError(err) {
  if (!err) return false;
  if (err.isRepairable === true || err.isRepairableMigrationFailure === true) return true;
  const msg = String(err.message ?? err).toLowerCase();
  if (msg.includes(HEADER.toLowerCase())) return true;
  if (msg.includes('canonicalize cloud chunk:') || msg.includes('canonicalize push chunk:')) return true;
  if (msg.includes('directory is required')) return true;
  if (msg.includes('legacy mutation') && msg.includes('payload')) return true;
  if (msg.includes('payload') && containsAny(msg, 'cloud', 'sync', 'mutation', 'upsert', 'canonicalize')) return true;
  if (msg.includes('upsert') && containsAny(msg, 'cloud', 'sync', 'payload', 'mutation', 'canonicalize')) return true;
  return false;
}

export function guidance(project) {
  const p = displayProject(project);
  return `${HEADER}
Run these commands, then retry sync:
  odin cloud upgrade doctor --project ${p}
  odin cloud upgrade repair --project ${p} --dry-run
  odin cloud upgrade repair --project ${p} --apply
  odin sync --cloud --project ${p}`;
}

export function policyGuidance(project) {
  const p = displayProject(project);
  return `${POLICY_HEADER}
The server denied access to project ${JSON.stringify(p)}. Ask the server administrator to check ODIN_CLOUD_ALLOWED_PROJECTS. If this client uses a managed principal, its project grant may also need checking. The client does not expose server allowlist contents.`;
}

/**
 * Conserva el mensaje original y añade, para un fallo conocido, las instrucciones de recuperación.
 * @param {string} message
 * @param {string} project
 * @param {Error|null} [err]
 */
export function appendGuidance(message, project, err = null) {
  let text = goTrim(message ?? '');
  if (text === '' && err) text = err.message;
  if (isPolicyFailure(err)) {
    const advice = policyGuidance(project);
    if (text.includes(advice)) return text;
    if (text === POLICY_HEADER) return advice;
    return `${text}\n\n${advice}`;
  }
  if (!isRepairableCloudSyncError(err) || text.includes(HEADER)) return text;
  return `${text}\n\n${guidance(project)}`;
}

/** Proyecto de un destino `cloud:<proyecto>`; `''` para el resto. */
export function projectFromTargetKey(targetKey) {
  const trimmed = goTrim(targetKey ?? '');
  const prefix = `${DEFAULT_SYNC_TARGET_KEY}:`;
  if (!trimmed.startsWith(prefix)) return '';
  return goTrim(normalizeProject(trimmed.slice(prefix.length)).normalized);
}
