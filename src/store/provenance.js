import {
  SOURCE_AMBIGUOUS, SOURCE_CONFIG, SOURCE_DIR_BASENAME, SOURCE_EXPLICIT_OVERRIDE, SOURCE_GIT_CHILD, SOURCE_GIT_REMOTE, SOURCE_GIT_ROOT,
  SOURCE_PROCESS_OVERRIDE, SOURCE_REQUEST_BODY, SOURCE_SESSION_PROJECT, SOURCE_STORED_PROJECT, SOURCE_USER_SELECTED_AFTER_AMBIGUOUS_PROJECT,
  SOURCE_ALL_PROJECTS,
} from '../project/detect.js';
import { SOURCE_UNBOUND_GIT } from '../project/identity.js';
import { storeError } from './errors.js';

/**
 * Evidencia local de cómo se resolvió el proyecto al capturar un registro. Nunca
 * concede propiedad ni inscripción. `null`/`undefined` = el llamador no aportó evidencia.
 * @typedef {{ source?: string, directory?: string, raw_project?: string }} ProjectProvenance
 */

const SOURCES = new Set([
  '', 'unknown', SOURCE_GIT_REMOTE, SOURCE_GIT_ROOT, SOURCE_GIT_CHILD, SOURCE_DIR_BASENAME, SOURCE_AMBIGUOUS, SOURCE_EXPLICIT_OVERRIDE,
  SOURCE_SESSION_PROJECT, SOURCE_USER_SELECTED_AFTER_AMBIGUOUS_PROJECT, SOURCE_REQUEST_BODY, SOURCE_CONFIG, SOURCE_ALL_PROJECTS,
  SOURCE_PROCESS_OVERRIDE, SOURCE_STORED_PROJECT, SOURCE_UNBOUND_GIT,
]);

/**
 * @param {ProjectProvenance|null|undefined} p
 * @throws {StoreError} `invalid_project_provenance` si el origen no es uno conocido
 */
export function validateProvenance(p) {
  if (p === null || p === undefined) return;
  if (!SOURCES.has(p.source ?? '')) throw storeError('invalid_project_provenance', `unsupported source ${JSON.stringify(p.source)}`);
}

/**
 * Interpreta un valor JSON recibido de un cliente: un objeto cuyos campos
 * conocidos (`source`, `directory`, `raw_project`) son cadenas. Se aceptan campos
 * desconocidos.
 * @param {unknown} value
 * @returns {ProjectProvenance}
 * @throws {StoreError} `invalid_project_provenance`
 */
export function parseProvenance(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw storeError('invalid_project_provenance');
  const out = {};
  for (const key of ['source', 'directory', 'raw_project']) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== 'string') throw storeError('invalid_project_provenance', `${key} must be a string`);
    out[key] = value[key];
  }
  validateProvenance(out);
  return out;
}

/**
 * Guarda la evidencia de un registro recién creado (nunca en repeticiones ni
 * actualizaciones). Borra antes la evidencia que hubiera de un registro anterior
 * con el mismo identificador.
 * @param {import('./db.js').Database} db
 * @param {'session'|'observation'|'prompt'} kind
 * @param {string} id
 * @param {ProjectProvenance|null|undefined} p
 */
export function captureProvenance(db, kind, id, p) {
  db.run('DELETE FROM capture_project_provenance WHERE entity_kind = ? AND entity_id = ?', kind, id);
  if (p === null || p === undefined) return;
  db.run(
    `INSERT INTO capture_project_provenance (entity_kind, entity_id, source, directory, raw_project) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity_kind, entity_id) DO NOTHING`,
    kind, id, p.source || 'unknown', p.directory ?? '', p.raw_project ?? '',
  );
}

/**
 * Lee la evidencia guardada; `null` si no hay (registros importados o anteriores).
 * @param {import('./store.js').Store} store
 * @returns {{ source: string, directory: string, raw_project: string }|null}
 */
export function captureProjectProvenance(store, kind, id) {
  const row = store.db.get(
    'SELECT source, directory, raw_project FROM capture_project_provenance WHERE entity_kind = ? AND entity_id = ?',
    kind, String(id),
  );
  return row ? { source: row.source, directory: row.directory, raw_project: row.raw_project } : null;
}
