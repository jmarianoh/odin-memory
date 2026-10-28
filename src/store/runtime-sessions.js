import { runtimeWorktreeDirectory } from '../project/worktree.js';
import { normalizeProject } from '../project/canonical.js';
import { now } from '../timeutil/index.js';
import { SessionProjectConflictError, StoreError, storeError } from './errors.js';
import { getObservationRow, insertObservationRow, journalObservation, prepareStoredContent } from './observations.js';
import {
  SESSION_OWNERSHIP_PROJECT_OWNED, SESSION_OWNERSHIP_SHARED, endSessionInTransaction, foreignRecordOwner, journalSession,
  sessionOwnership, sessionProjectWriteError, sessionRow, validSessionOwnershipMode, validateSessionId,
} from './sessions.js';
import { SQL_WHITESPACE_TRIM_SET, goTrim, hashNormalized, stripPrivateTags } from './text.js';

/** Duración de la concesión local de una sesión de runtime. */
export const RUNTIME_SESSION_LEASE = '+30 minutes';
/** Ventana de actividad para considerar activa una sesión sin concesión. */
export const ACTIVE_RUNTIME_SESSION_WINDOW = '-7 days';

const q = (s) => JSON.stringify(s);
const isMismatch = (err) => err?.code === 'session_ownership_mismatch';

/**
 * Aplica a un registro las reglas normales de propiedad: una sesión
 * `project_owned` rechaza a otro proyecto con un conflicto explícito.
 * @returns {Error|null}
 */
function registrationProjectError(id, owner, ownerMode, project, mode) {
  if (mode === SESSION_OWNERSHIP_PROJECT_OWNED && owner !== '' && owner !== project) {
    return new SessionProjectConflictError(id, owner, project);
  }
  return sessionProjectWriteError(id, owner, ownerMode, project);
}

/**
 * Identificador de la sesión que continúa a `root`. Si `root` no existe o sigue
 * viva, es ella misma. Si terminó, las continuaciones son `<root>:resume:<n>`:
 * se reutiliza la viva de menor ordinal o, si no hay ninguna, se crea la
 * siguiente al mayor ordinal existente (empezando por 2).
 * @param {import('./db.js').Database} db
 * @param {string} root
 */
export function continuationSession(db, root) {
  const row = db.get('SELECT ended_at FROM sessions WHERE id = ?', root);
  if (!row || row.ended_at === null) return root;
  const prefix = `${root}:resume:`;
  let max = 1n;
  let liveOrdinal = null;
  let liveId = '';
  for (const r of db.all('SELECT id, ended_at FROM sessions WHERE id >= ? AND id < ? ORDER BY id', `${prefix}0`, `${prefix}:`)) {
    if (!r.id.startsWith(prefix)) continue;
    const suffix = r.id.slice(prefix.length);
    if (suffix === '' || /[^0-9]/.test(suffix)) continue;
    const n = BigInt(suffix);
    if (n > max) max = n;
    if (r.ended_at === null && (liveOrdinal === null || n < liveOrdinal)) {
      liveOrdinal = n;
      liveId = r.id;
    }
  }
  return liveId !== '' ? liveId : `${prefix}${max + 1n}`;
}

/** Registra la sesión o renueva su concesión; falla si ya terminó. */
function startSessionRow(db, id, project, directory, mode) {
  const res = db.run(
    `INSERT INTO sessions (id, project, ownership_mode, directory, started_at, runtime_lease_expires_at, local_creation_project)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?), ?)
     ON CONFLICT(id) DO UPDATE SET
       project = CASE WHEN ifnull(trim(sessions.project, ?), '') = '' THEN excluded.project ELSE sessions.project END,
       ownership_mode = CASE WHEN ifnull(trim(sessions.ownership_mode, ?), '') = '' THEN excluded.ownership_mode ELSE sessions.ownership_mode END,
       directory = CASE WHEN trim(sessions.directory, ?) = '' THEN excluded.directory ELSE sessions.directory END,
       runtime_lease_expires_at = excluded.runtime_lease_expires_at
     WHERE sessions.ended_at IS NULL`,
    id, project, mode, directory, now(), RUNTIME_SESSION_LEASE, project,
    SQL_WHITESPACE_TRIM_SET, SQL_WHITESPACE_TRIM_SET, SQL_WHITESPACE_TRIM_SET,
  );
  if (Number(res.changes) === 0) throw storeError('session_already_ended');
}

/**
 * Núcleo del registro de sesiones de runtime.
 * @returns {string} identificador efectivo (distinto de `root` si se continuó una sesión terminada)
 */
function registerSession(store, rootId, projectInput, directory, mode, { resume, isolated }) {
  validateSessionId(rootId);
  if (!validSessionOwnershipMode(mode)) throw storeError('invalid_session_ownership_mode', q(mode));
  const project = normalizeProject(projectInput ?? '').normalized;
  if (goTrim(project) === '') throw storeError('project_required');

  let claimed = false;
  let effective = rootId;
  store.db.writeTransaction((db) => {
    claimed = false;
    let id = rootId;
    effective = rootId;
    let resumeScope = null;

    /** Una sesión aislada exige no tener directorio ni propiedad compartida. */
    const validateIsolation = (sessionId) => {
      if (!isolated) return;
      const row = db.get("SELECT ifnull(directory, '') AS directory, ifnull(ownership_mode, '') AS mode FROM sessions WHERE id = ?", sessionId);
      if (!row) return;
      if (goTrim(row.directory) !== '') throw new StoreError('session_isolation_conflict', `${storeError('session_isolation_conflict').message}: ${q(sessionId)}`);
      if (goTrim(row.mode) === SESSION_OWNERSHIP_SHARED) {
        throw new StoreError('session_isolation_conflict', `${storeError('session_isolation_conflict').message}: ${q(sessionId)} has shared ownership`);
      }
    };

    validateIsolation(rootId);
    if (resume) {
      const root = db.get("SELECT ended_at, ifnull(directory, '') AS directory, ifnull(ownership_mode, '') AS mode FROM sessions WHERE id = ?", rootId);
      if (root && root.ended_at !== null) {
        const { project: owner, mode: ownerMode } = sessionOwnership(db, rootId);
        const err = registrationProjectError(rootId, owner, ownerMode, project, mode);
        if (err) throw isMismatch(err) ? new SessionProjectConflictError(rootId, owner, project) : err;
        if (!isolated && owner !== '' && goTrim(root.directory) !== '' && validSessionOwnershipMode(goTrim(root.mode))) {
          resumeScope = { project: owner, directory: root.directory, mode: goTrim(root.mode) };
        }
        if (mode === SESSION_OWNERSHIP_PROJECT_OWNED && owner === '') {
          const { owner: foreign } = foreignRecordOwner(db, rootId, project);
          if (foreign !== '') throw new SessionProjectConflictError(rootId, foreign, project);
        }
      }
      id = continuationSession(db, rootId);
      effective = id;
    }
    if (id !== rootId) validateIsolation(id);

    const { project: existingProject, mode: existingMode, found } = sessionOwnership(db, id);
    let identityRepaired = !found;

    if (found && mode === SESSION_OWNERSHIP_PROJECT_OWNED && existingProject === '') {
      const ended = db.get('SELECT ended_at FROM sessions WHERE id = ?', id).ended_at;
      if (ended !== null) {
        // Sesión terminada sin dueño: se reclama la propiedad, pero no se reabre.
        const { owner: foreign } = foreignRecordOwner(db, id, project);
        if (foreign !== '') throw new SessionProjectConflictError(id, foreign, project);
        const res = db.run(
          "UPDATE sessions SET project = ?, ownership_mode = ? WHERE id = ? AND ended_at IS NOT NULL AND ifnull(trim(project, ?), '') = ''",
          project, mode, id, SQL_WHITESPACE_TRIM_SET,
        );
        if (Number(res.changes) !== 1) throw new Error(`ended legacy session ownership claim lost for ${q(id)}`);
        journalSession(db, sessionRow(db, id));
        claimed = true;
        return;
      }
    }
    if (found) {
      const err = registrationProjectError(id, existingProject, existingMode, project, mode);
      if (err) {
        if (resume && id !== rootId) throw new SessionProjectConflictError(id, existingProject, project);
        throw err;
      }
      const existingDirectory = db.get("SELECT ifnull(directory, '') AS directory FROM sessions WHERE id = ?", id).directory;
      identityRepaired = existingProject === '' || existingMode === '' || goTrim(existingDirectory) === '';
    }
    let regProject = project;
    let regDirectory = directory ?? '';
    let regMode = mode;
    if (!found && resumeScope) ({ project: regProject, directory: regDirectory, mode: regMode } = resumeScope);
    startSessionRow(db, id, regProject, regDirectory, regMode);
    if (identityRepaired) journalSession(db, sessionRow(db, id));
  });
  if (claimed) throw storeError('session_already_ended');
  return effective;
}

/**
 * Registra una sesión de runtime compartida (o renueva su concesión de 30 min).
 * @param {import('./store.js').Store} store
 * @param {string} id
 * @param {string} project
 * @param {string} directory
 * @param {string} [mode] `shared` (por defecto) o `project_owned`
 * @throws {StoreError} `session_already_ended` si la sesión ya terminó
 */
export function startSession(store, id, project, directory, mode = SESSION_OWNERSHIP_SHARED) {
  registerSession(store, id, project, directory, mode, { resume: false, isolated: false });
}

/**
 * Como `startSession`, pero si la sesión raíz ya terminó continúa en
 * `<id>:resume:<n>`. Devuelve el identificador efectivo.
 * @returns {string}
 */
export function resumeSession(store, id, project, directory, mode = SESSION_OWNERSHIP_SHARED) {
  return registerSession(store, id, project, directory, mode, { resume: true, isolated: false });
}

/**
 * Registra una sesión aislada: sin directorio y con propiedad de proyecto. No
 * puede reutilizar sesiones enlazadas a un directorio ni compartidas.
 * @param {import('./store.js').Store} store
 * @param {string} id
 * @param {string} project
 * @param {boolean} [resume]
 * @returns {string} identificador efectivo
 */
export function registerIsolatedSession(store, id, project, resume = false) {
  return registerSession(store, id, project, '', SESSION_OWNERSHIP_PROJECT_OWNED, { resume, isolated: true });
}

/**
 * Resuelve la sesión viva de un host: valida que `root` (y su continuación)
 * pertenezcan al proyecto, tengan la misma política de propiedad y el mismo árbol
 * de trabajo que `directory`.
 * @param {import('./db.js').Database} db
 */
function runtimeSession(db, root, projectInput, directory, mode) {
  validateSessionId(root);
  if (!validSessionOwnershipMode(mode)) throw storeError('invalid_session_ownership_mode');
  const project = normalizeProject(projectInput ?? '').normalized;
  if (project === '') throw storeError('project_required');

  const validate = (id, live) => {
    const row = db.get("SELECT ifnull(project, '') AS owner, ifnull(ownership_mode, '') AS ownership, ifnull(directory, '') AS scope, ended_at FROM sessions WHERE id = ?", id);
    if (!row) throw storeError('session_not_found');
    const owner = normalizeProject(goTrim(row.owner)).normalized;
    const ownership = goTrim(row.ownership);
    if (
      registrationProjectError(id, owner, ownership, project, mode) !== null ||
      ownership !== mode ||
      goTrim(directory ?? '') === '' ||
      goTrim(row.scope) === '' ||
      runtimeWorktreeDirectory(row.scope) !== runtimeWorktreeDirectory(directory)
    ) {
      throw storeError('runtime_session_scope_conflict');
    }
    if (live && row.ended_at !== null) throw storeError('session_not_found');
  };
  validate(root, false);
  const id = continuationSession(db, root);
  validate(id, true);
  return id;
}

/**
 * Identificador de la sesión viva que corresponde a una sesión raíz del host.
 * @param {import('./store.js').Store} store
 * @returns {string}
 */
export function resolveRuntimeSession(store, root, project, directory, mode) {
  return store.db.writeTransaction((db) => runtimeSession(db, root, project, directory, mode));
}

/**
 * Cierra la sesión viva de un host con un resumen opcional.
 * @param {import('./store.js').Store} store
 * @returns {string} identificador de la sesión cerrada
 */
export function endRuntimeSession(store, root, project, directory, mode, summary = '') {
  return store.db.writeTransaction((db) => {
    const id = runtimeSession(db, root, project, directory, mode);
    endSessionInTransaction(db, id, summary === '' ? null : summary);
    return id;
  });
}

/**
 * Sesiones de runtime activas del proyecto en los directorios dados. Una sesión
 * cuenta si tiene una concesión vigente o, sin concesión, si tuvo actividad en
 * los últimos 7 días y ningún otro candidato del mismo directorio tiene
 * concesión vigente. Se excluyen las de guardado manual.
 * @param {import('./store.js').Store} store
 * @param {string} project
 * @param {...string} directories
 * @returns {string[]} ids ordenados
 */
export function activeRuntimeSessions(store, project, ...directories) {
  project = normalizeProject(project ?? '').normalized;
  if (project === '') return [];
  const dirs = [...new Set(directories.filter((d) => d !== ''))];
  if (dirs.length === 0) return [];
  const marks = dirs.map(() => '?').join(', ');
  const rows = store.db.all(
    `WITH runtime_candidates AS (
       SELECT s.id, s.directory, s.runtime_lease_expires_at, COALESCE(MAX(o.created_at), s.started_at) AS effective_activity
       FROM sessions s
       LEFT JOIN observations o ON o.session_id = s.id
       WHERE LOWER(s.project) = ?
         AND s.directory IN (${marks})
         AND s.ended_at IS NULL
         AND s.id NOT LIKE 'manual-save%'
         AND s.id NOT LIKE 'manual-fallback-%'
       GROUP BY s.id
     ), live_leased_directories AS (
       SELECT directory FROM runtime_candidates
       WHERE runtime_lease_expires_at IS NOT NULL AND runtime_lease_expires_at <> ''
         AND datetime(runtime_lease_expires_at) > datetime('now')
       GROUP BY directory
     )
     SELECT candidate.id
     FROM runtime_candidates candidate
     WHERE (candidate.runtime_lease_expires_at IS NOT NULL AND candidate.runtime_lease_expires_at <> ''
            AND datetime(candidate.runtime_lease_expires_at) > datetime('now'))
        OR ((candidate.runtime_lease_expires_at IS NULL OR candidate.runtime_lease_expires_at = '')
            AND candidate.effective_activity >= datetime('now', '${ACTIVE_RUNTIME_SESSION_WINDOW}')
            AND NOT EXISTS (SELECT 1 FROM live_leased_directories live WHERE live.directory = candidate.directory))
     ORDER BY candidate.id`,
    project, ...dirs,
  );
  return rows.map((r) => r.id);
}

/**
 * Cierra una sesión dejando constancia de un resumen como observación
 * `session_summary`. Es idempotente: repetirla devuelve el resumen ya guardado.
 * @param {import('./store.js').Store} store
 * @param {{ session_id: string, project: string, summary: string }} p
 * @returns {{ summary_id: number, summary_sync_id: string, already_finalized: boolean }}
 */
export function finalizeSession(store, p) {
  validateSessionId(p.session_id);
  const project = normalizeProject(p.project ?? '').normalized;
  if (project === '') throw storeError('project_required');
  const content = prepareStoredContent(store, p.summary).content;
  if (goTrim(content) === '') throw storeError('observation_content_required');

  return store.db.writeTransaction((db) => {
    const row = db.get("SELECT ifnull(project, '') AS owner, ended_at, summary FROM sessions WHERE id = ?", p.session_id);
    if (!row) throw storeError('session_not_found');
    if (normalizeProject(row.owner).normalized !== project) throw storeError('session_ownership_mismatch');
    const done = db.get('SELECT summary_id, summary_sync_id FROM session_finalizations WHERE session_id = ?', p.session_id);
    if (done) return { summary_id: Number(done.summary_id), summary_sync_id: done.summary_sync_id, already_finalized: true };
    if (row.ended_at !== null) throw storeError('session_already_ended');

    const title = stripPrivateTags(`Session summary: ${project}`);
    const id = insertObservationRow(db, {
      session_id: p.session_id, type: 'session_summary', title, content, project, scope: 'project', topic_key: '', hash: hashNormalized(content),
    });
    const obs = getObservationRow(db, id);
    journalObservation(db, obs);
    endSessionInTransaction(db, p.session_id, row.summary); // conserva el resumen previo de la sesión
    db.run('INSERT INTO session_finalizations (session_id, summary_id, summary_sync_id) VALUES (?, ?, ?)', p.session_id, id, obs.sync_id);
    return { summary_id: id, summary_sync_id: obs.sync_id, already_finalized: false };
  });
}
