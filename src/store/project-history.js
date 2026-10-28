import { isAbsolute, normalize } from 'node:path';
import { detectProjectFull } from '../project/detect.js';
import { normalizeProjectName } from '../project/canonical.js';

const DEFAULT_WINDOWS = process.platform === 'win32';

/** Directorio histórico de una sesión, comparable; `''` si no es una ruta absoluta. */
function historicalDirectoryIdentity(directory) {
  if (!isAbsolute(directory)) return '';
  const cleaned = normalize(directory).replace(/(.)[/\\]+$/, '$1');
  return DEFAULT_WINDOWS ? cleaned.toLowerCase() : cleaned;
}

/**
 * Proyectos (canónicos, ordenados y sin repetir) con sesiones registradas en
 * exactamente ese directorio.
 * @param {import('./store.js').Store} store
 * @param {string} directory identidad del directorio (`directoryIdentity`)
 * @returns {string[]}
 */
export function projectHistory(store, directory) {
  const rows = store.db.all("SELECT DISTINCT project, directory FROM sessions WHERE project IS NOT NULL AND project != '' AND directory != ''");
  const projects = new Set();
  for (const { project, directory: stored } of rows) {
    let canonical;
    try {
      canonical = normalizeProjectName(project);
    } catch {
      continue;
    }
    const identity = historicalDirectoryIdentity(stored);
    if (identity !== '' && identity === directory) projects.add(canonical);
  }
  return [...projects].sort();
}

/**
 * Detecta el proyecto de un directorio con el historial del almacén (puede exigir
 * una elección explícita si el directorio tuvo otro proyecto antes).
 * @param {import('./store.js').Store} store
 * @param {string} directory
 * @param {import('../project/detect.js').DetectionOptions} [options]
 */
export function detectProject(store, directory, options = {}) {
  return detectProjectFull(directory, { historyLookup: (dir) => projectHistory(store, dir), ...options });
}

/** Como `detectProject` pero sin escribir el vínculo del repositorio. */
export function inspectProject(store, directory) {
  return detectProject(store, directory, { inspectOnly: true });
}
