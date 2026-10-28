import { createHash } from 'node:crypto';
import { normalizeProject } from '../project/canonical.js';
import { now } from '../timeutil/index.js';
import { SessionProjectConflictError, storeError } from './errors.js';
import { SYNC_ENTITY, SYNC_OP_UPSERT, journalMutation } from './journal.js';
import { SQL_WHITESPACE_TRIM_SET, goTrim, isBlankSessionId, nullableString } from './text.js';

export const SESSION_OWNERSHIP_SHARED = 'shared';
export const SESSION_OWNERSHIP_PROJECT_OWNED = 'project_owned';
/** Prefijo de los identificadores de sesión de guardado manual. */
export const MANUAL_SESSION_ID_PREFIX = 'manual-save-';
/** Comando que repara la propiedad de proyecto de una sesión. */
export const RESCUE_OWNERSHIP_COMMAND = 'odin projects rescue-ownership';

const q = (s) => JSON.stringify(s);

/** @throws {StoreError} `session_id_required` */
export function validateSessionId(id) {
  if (isBlankSessionId(id ?? '')) throw storeError('session_id_required');
}

export const validSessionOwnershipMode = (mode) =>
  mode === SESSION_OWNERSHIP_SHARED || mode === SESSION_OWNERSHIP_PROJECT_OWNED;

export function rescueOwnershipHint(sessionId) {
  return `${RESCUE_OWNERSHIP_COMMAND} --project <name> --session ${sessionId}`;
}

/**
 * Propiedad de una sesión. `project` queda vacío si la fila tiene NULL o blanco.
 * @param {import('./db.js').Database} db
 * @param {string} sessionId
 * @returns {{ project: string, mode: string, found: boolean }}
 */
export function sessionOwnership(db, sessionId) {
  const row = db.get('SELECT project, ownership_mode FROM sessions WHERE id = ?', sessionId);
  if (!row) return { project: '', mode: '', found: false };
  return {
    project: normalizeProject(goTrim(row.project ?? '')).normalized,
    mode: goTrim(row.ownership_mode ?? ''),
    found: true,
  };
}

/**
 * Error por escribir un proyecto distinto del dueño de la sesión, o null si se admite.
 * @returns {Error|null}
 */
export function sessionProjectWriteError(sessionId, sessionProject, mode, requested) {
  if (sessionProject === '' || sessionProject === requested || mode === SESSION_OWNERSHIP_SHARED) return null;
  if (mode === SESSION_OWNERSHIP_PROJECT_OWNED) {
    return storeError('session_ownership_mismatch', `session ${q(sessionId)} belongs to ${q(sessionProject)}, not ${q(requested)}`);
  }
  return storeError(
    'project_ownership_ambiguous',
    `session ${q(sessionId)} has unclassified ownership for ${q(sessionProject)} and cannot accept ${q(requested)}`,
  );
}

/** Primer proyecto, distinto de `exclude`, dueño de un registro hijo de la sesión. */
export function foreignRecordOwner(db, sessionId, exclude) {
  const sources = [
    ['an observation', "SELECT project FROM observations WHERE session_id = ? AND ifnull(trim(project), '') <> '' AND deleted_at IS NULL"],
    ['a prompt', "SELECT project FROM user_prompts WHERE session_id = ? AND ifnull(trim(project), '') <> ''"],
  ];
  for (const [kind, query] of sources) {
    for (const row of db.all(query, sessionId)) {
      const owned = normalizeProject(goTrim(row.project ?? '')).normalized;
      if (owned !== '' && owned !== exclude) return { kind, owner: owned };
    }
  }
  return { kind: '', owner: '' };
}

/** Fila de sesión con la forma de su carga de sincronización. */
export function sessionRow(db, id) {
  return db.get(
    "SELECT id, ifnull(project, '') AS project, ifnull(ownership_mode, '') AS ownership_mode, directory, started_at, ended_at, summary FROM sessions WHERE id = ?",
    id,
  );
}

export function journalSession(db, row) {
  if (goTrim(row.directory ?? '') === '') return; // una sesión sin directorio no se sincroniza
  journalMutation(db, {
    entity: SYNC_ENTITY.session,
    entityKey: row.id,
    op: SYNC_OP_UPSERT,
    project: row.project,
    payload: () => ({ ...row }),
  });
}

/** Reclama una sesión sin dueño para `project`; anota el cambio en el diario. */
function adoptSessionOwnership(db, sessionId, project) {
  const res = db.run("UPDATE sessions SET project = ? WHERE id = ? AND ifnull(trim(project), '') = ''", project, sessionId);
  if (Number(res.changes) === 0) return;
  journalSession(db, sessionRow(db, sessionId));
}

/**
 * Determina el proyecto de una escritura que cuelga de una sesión: el solicitado
 * si la sesión lo admite o, si no se indicó, el de la sesión. Una sesión sin dueño
 * adopta el proyecto solicitado salvo que ya tenga registros de otro.
 * Debe llamarse dentro de una transacción.
 * @param {import('./db.js').Database} db
 * @param {string} sessionId
 * @param {string} requested
 * @returns {string}
 */
export function resolveWriteProject(db, sessionId, requested) {
  requested = normalizeProject(goTrim(requested ?? '')).normalized;
  const { project: owner, mode, found } = sessionOwnership(db, sessionId);

  if (requested === '') {
    if (!found) throw storeError('project_required', `session ${q(sessionId)} does not exist, so the write has no project to inherit`);
    if (owner === '') {
      throw storeError(
        'project_required',
        `session ${q(sessionId)} carries no project ownership and the write supplied none; assign ownership with: ${rescueOwnershipHint(sessionId)}`,
      );
    }
    return owner;
  }
  const mismatch = sessionProjectWriteError(sessionId, owner, mode, requested);
  if (mismatch) throw mismatch;
  if (!found || owner === requested) return requested;
  if (owner !== '') return requested; // las sesiones compartidas admiten varios proyectos

  const { kind, owner: foreign } = foreignRecordOwner(db, sessionId, requested);
  if (foreign !== '') {
    throw storeError(
      'project_ownership_ambiguous',
      `session ${q(sessionId)} carries no project ownership but already parents ${kind} owned by ${q(foreign)}, so it cannot adopt ${q(requested)}; resolve it explicitly with: ${rescueOwnershipHint(sessionId)}`,
    );
  }
  adoptSessionOwnership(db, sessionId, requested);
  return requested;
}

/**
 * Crea una sesión con una política de propiedad explícita, o la completa si ya existe.
 * @param {import('./store.js').Store} store
 * @param {string} id
 * @param {string} project
 * @param {string} directory
 * @param {string} [mode] `shared` (por defecto) o `project_owned`
 */
export function createSession(store, id, project, directory, mode = SESSION_OWNERSHIP_SHARED) {
  validateSessionId(id);
  if (!validSessionOwnershipMode(mode)) throw storeError('invalid_session_ownership_mode', q(mode));
  project = normalizeProject(project).normalized;
  if (goTrim(project) === '') throw storeError('project_required');

  store.db.writeTransaction((db) => {
    const { project: existing, mode: existingMode, found } = sessionOwnership(db, id);
    if (found) {
      if (mode === SESSION_OWNERSHIP_PROJECT_OWNED && existing !== '' && existing !== project) {
        throw new SessionProjectConflictError(id, existing, project);
      }
      const mismatch = sessionProjectWriteError(id, existing, existingMode, project);
      if (mismatch) throw mismatch;
    }
    db.run(
      `INSERT INTO sessions (id, project, ownership_mode, directory, started_at, local_creation_project) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project   = CASE WHEN ifnull(trim(sessions.project, ?), '') = '' THEN excluded.project ELSE sessions.project END,
         ownership_mode = CASE WHEN ifnull(trim(sessions.ownership_mode, ?), '') = '' THEN excluded.ownership_mode ELSE sessions.ownership_mode END,
         directory = CASE WHEN trim(sessions.directory, ?) = '' THEN excluded.directory ELSE sessions.directory END`,
      id, project, mode, directory, now(), project,
      SQL_WHITESPACE_TRIM_SET, SQL_WHITESPACE_TRIM_SET, SQL_WHITESPACE_TRIM_SET,
    );
    journalSession(db, sessionRow(db, id));
  });
}

/**
 * Registra la sesión de reserva de un proyecto para guardados sin sesión. Conserva
 * el identificador histórico `manual-save-<proyecto>` y, si pertenece a otro
 * proyecto, usa uno determinista derivado del nombre.
 * @param {import('./store.js').Store} store
 * @param {string} project
 * @param {string} directory
 * @returns {string} identificador de la sesión
 */
export function resolveManualSession(store, project, directory) {
  project = normalizeProject(project).normalized;
  let id = MANUAL_SESSION_ID_PREFIX + project;
  try {
    createSession(store, id, project, directory, SESSION_OWNERSHIP_PROJECT_OWNED);
    return id;
  } catch (err) {
    if (!(err instanceof SessionProjectConflictError)) throw err;
  }
  id = `manual-fallback-${createHash('sha256').update(project, 'utf8').digest('hex')}`;
  createSession(store, id, project, directory, SESSION_OWNERSHIP_PROJECT_OWNED);
  return id;
}

/**
 * Cierra una sesión con un resumen opcional. No falla si la sesión no existe.
 * @param {import('./store.js').Store} store
 * @param {string} id
 * @param {string} [summary]
 */
export function endSession(store, id, summary = '') {
  validateSessionId(id);
  store.db.writeTransaction((db) => endSessionInTransaction(db, id, nullableString(summary)));
}

/**
 * Cierra una sesión dentro de una transacción ya abierta, con el valor de
 * resumen indicado (`null` lo deja vacío). No falla si la sesión no existe.
 * @param {import('./db.js').Database} db
 * @param {string} id
 * @param {string|null} summary
 */
export function endSessionInTransaction(db, id, summary) {
  const res = db.run("UPDATE sessions SET ended_at = datetime('now'), summary = ? WHERE id = ?", summary, id);
  if (Number(res.changes) === 0) return;
  journalSession(db, sessionRow(db, id));
}

/**
 * @param {import('./store.js').Store} store
 * @param {string} id
 * @returns {object|null} la sesión, o null si no existe
 */
export function getSession(store, id) {
  const row = store.db.get(
    "SELECT id, project, ifnull(ownership_mode, '') AS ownership_mode, directory, started_at, ended_at, summary, runtime_lease_expires_at FROM sessions WHERE id = ?",
    id,
  );
  if (!row) return null;
  return { ...row, project: row.project ?? '' };
}

function listSessions(store, project, limit, canonicalFilter) {
  let sql = `SELECT s.id, ifnull(s.project, '') AS project, s.started_at, s.ended_at, s.summary,
       COUNT(o.id) AS observation_count
     FROM sessions s
     LEFT JOIN observations o ON o.session_id = s.id AND o.deleted_at IS NULL
     WHERE 1=1`;
  const args = [];
  if (project !== '') {
    sql += canonicalFilter ? ' AND LOWER(s.project) = ?' : ' AND s.project = ?';
    args.push(project);
  }
  sql += ' GROUP BY s.id ORDER BY MAX(datetime(COALESCE(o.created_at, s.started_at))) DESC, s.id DESC LIMIT ?';
  args.push(limit);
  return store.db.all(sql, ...args).map((r) => ({ ...r, observation_count: Number(r.observation_count) }));
}

/**
 * Sesiones recientes con su número de observaciones, filtradas por proyecto
 * (normalizado, sin distinguir mayúsculas).
 * @param {import('./store.js').Store} store
 * @param {string} [project]
 * @param {number} [limit] por defecto 5
 */
export function recentSessions(store, project = '', limit = 5) {
  return listSessions(store, normalizeProject(project).normalized, limit > 0 ? limit : 5, true);
}

/**
 * Todas las sesiones; el filtro de proyecto es exacto.
 * @param {import('./store.js').Store} store
 * @param {string} [project]
 * @param {number} [limit] por defecto 50
 */
export function allSessions(store, project = '', limit = 50) {
  return listSessions(store, project, limit > 0 ? limit : 50, false);
}
