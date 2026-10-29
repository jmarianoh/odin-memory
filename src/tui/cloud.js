import { effectiveToken, applyServerOverride, loadCloudConfig, saveCloudConfig, SOURCE_LABEL, validateServerUrl } from '../cloud/config.js';
import { normalizeProject } from '../project/canonical.js';
import { cloudSyncSummary } from '../store/sync-state.js';
import { listEnrolledProjects } from '../store/diagnostic.js';
import { enrollProject, unenrollProject } from '../store/enrollment.js';
import { goTrim } from '../store/text.js';

/** Ruta que se consulta para comprobar el servidor y tiempo máximo de espera. */
export const CLOUD_HEALTH_PATH = '/health';
export const CLOUD_PING_TIMEOUT_MS = 3000;

/** Estados de una comprobación de conexión. */
export const PING_STATUS = Object.freeze({ reachable: 'reachable', unauthorized: 'unauthorized', unreachable: 'unreachable' });

/**
 * Comprueba que el servidor responde: `GET <url>/health` con el token como portador, si lo hay.
 * 2xx es `reachable`, 401 es `unauthorized` y cualquier otra cosa, `unreachable` (con el motivo).
 * @param {string} serverUrl
 * @param {string} token
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ status: string, error: Error|null }>}
 */
export async function pingCloudServer(serverUrl, token, fetchImpl = fetch) {
  let url;
  try {
    url = validateServerUrl(serverUrl);
  } catch (error) {
    return { status: PING_STATUS.unreachable, error };
  }
  const headers = token === '' ? {} : { Authorization: `Bearer ${token}` };
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}${CLOUD_HEALTH_PATH}`, { headers, signal: AbortSignal.timeout(CLOUD_PING_TIMEOUT_MS) });
    await res.body?.cancel();
    if (res.status === 401) return { status: PING_STATUS.unauthorized, error: null };
    if (res.status >= 200 && res.status < 300) return { status: PING_STATUS.reachable, error: null };
    return { status: PING_STATUS.unreachable, error: new Error(`unexpected status ${res.status}`) };
  } catch (error) {
    return { status: PING_STATUS.unreachable, error: new Error(error?.cause?.message ?? error?.message ?? String(error)) };
  }
}

/** URL del servidor (con el reemplazo del entorno) y de dónde sale el token. */
export function loadCloudSettings(dataDir, env) {
  const config = applyServerOverride(loadCloudConfig(dataDir), env);
  return { serverUrl: config.server_url, tokenSource: SOURCE_LABEL[effectiveToken(dataDir, env).source] };
}

/** Guarda solo la URL: este formulario no es dueño del token. */
export function saveCloudServerUrl(dataDir, serverUrl) {
  saveCloudConfig(dataDir, { ...loadCloudConfig(dataDir), server_url: serverUrl });
}

/** Resumen de sincronización más la URL configurada, para la pantalla de estado. */
export function loadCloudStatus(store, env) {
  const config = applyServerOverride(loadCloudConfig(store.dataDir), env);
  const summary = cloudSyncSummary(store);
  return { serverUrl: config.server_url, lastSync: summary.last_success_at, pendingCount: summary.pending_mutations, lastError: summary.last_error };
}

/**
 * Proyectos locales que se pueden inscribir (los de observaciones, sesiones, prompts e inscripciones),
 * normalizados y en orden, con su estado de inscripción.
 * @returns {{ project: string, enrolled: boolean }[]}
 */
export function listCloudEnrollment(store) {
  const rows = store.db.all(`SELECT project FROM (
    SELECT project FROM observations WHERE deleted_at IS NULL
    UNION SELECT project FROM sessions
    UNION SELECT project FROM user_prompts
    UNION SELECT project FROM sync_enrolled_projects
  ) WHERE project IS NOT NULL AND TRIM(project) != ''`);
  const names = new Set();
  for (const { project } of rows) {
    const name = normalizeProject(project).normalized;
    if (goTrim(name) !== '') names.add(name);
  }
  const enrolled = new Set(listEnrolledProjects(store).map((r) => normalizeProject(r.project).normalized).filter((n) => n !== ''));
  return [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((project) => ({ project, enrolled: enrolled.has(project) }));
}

/** Inscribe el proyecto si no lo estaba y lo desinscribe si lo estaba. */
export function toggleCloudEnrollment(store, item) {
  if (item.enrolled) unenrollProject(store, item.project);
  else enrollProject(store, item.project);
}
