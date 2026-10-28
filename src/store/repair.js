import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeProject } from '../project/canonical.js';
import { ORPHANED_PENDING_RELATION_CANDIDATE, countOrphanedPendingRelations } from './diagnostic.js';
import { manualSaveOwnerProject } from './migrate.js';
import { SESSION_OWNERSHIP_PROJECT_OWNED, SESSION_OWNERSHIP_SHARED, validateSessionId } from './sessions.js';
import { goTrim } from './text.js';

const normalized = (project) => goTrim(normalizeProject(project ?? '').normalized);

/** `20060102T150405.000000000Z`: UTC con nueve decimales. */
function backupStamp(date = new Date()) {
  const iso = date.toISOString(); // 2026-01-02T03:04:05.678Z
  return `${iso.slice(0, 19).replace(/[-:]/g, '')}.${iso.slice(20, 23)}000000Z`;
}

/** Reserva en privado el archivo de la copia antes de que SQLite lo abra. */
function reserveBackupPath(store) {
  const dir = join(store.config.dataDir, 'backups');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(`create sqlite backup dir: ${err.message}`, { cause: err });
  }
  const path = join(dir, `odin-repair-${backupStamp()}.db`);
  try {
    closeSync(openSync(path, 'wx', 0o600));
    chmodSync(path, 0o600);
  } catch (err) {
    throw new Error(`reserve sqlite backup: ${err.message}`, { cause: err });
  }
  return path;
}

/**
 * Copia consistente de la base (`VACUUM INTO`) en `<datos>/backups/`, con permisos privados.
 * @param {import('./store.js').Store} store
 * @returns {string} ruta de la copia
 */
export function backupSqlite(store) {
  const path = reserveBackupPath(store);
  try {
    store.db.run('VACUUM INTO ?', path);
  } catch (err) {
    throw new Error(`backup sqlite database: ${err.message}`, { cause: err });
  }
  return path;
}

/**
 * Igual que `backupSqlite`, pero para quien ya tiene el bloqueo de escritura: la copia sale de
 * otra conexión, que en modo WAL lee el último estado confirmado (el previo a lo que se aplica).
 */
export function backupSqliteUnderWriteLock(store) {
  const path = reserveBackupPath(store);
  let snapshot;
  try {
    snapshot = new DatabaseSync(store.dbPath);
    snapshot.exec('PRAGMA busy_timeout = 5000');
    snapshot.prepare('VACUUM INTO ?').run(path);
  } catch (err) {
    throw new Error(`backup sqlite database: ${err.message}`, { cause: err });
  } finally {
    snapshot?.close();
  }
  return path;
}

// ─── Sesiones huérfanas ──────────────────────────────────────────────────────

function orphanedObservationProjects(db, sessionId) {
  const projects = new Set();
  for (const row of db.all("SELECT DISTINCT ifnull(project, '') AS project FROM observations WHERE session_id = ?", sessionId)) {
    const project = normalized(row.project);
    if (project === '') throw new Error(`orphaned session ${JSON.stringify(sessionId)} has observation evidence without a project`);
    projects.add(project);
  }
  return projects;
}

/**
 * Crea marcadores locales (ya terminados, `project_owned`) para sesiones cuya referencia falta.
 * Valida la evidencia actual y la propiedad en una sola transacción y vuelve a derivar el
 * recuento y el inicio del marcador de las observaciones actuales; nunca modifica observaciones
 * ni emite mutaciones de sincronización.
 * @param {import('./store.js').Store} store
 * @param {{ session_id: string, project: string, observation_count?: number, started_at: string }[]} actions
 * @returns {{ session_id: string, project: string, observation_count: number, started_at: string }[]} los que se aplicaron
 */
export function restoreOrphanedObservationSessions(store, actions) {
  return store.db.writeTransaction((db) => {
    const applied = [];
    for (const original of actions) {
      const action = { ...original };
      validateSessionId(action.session_id);
      const project = normalized(action.project);
      if (project === '' || goTrim(action.started_at ?? '') === '') throw new Error('orphaned session placeholder requires project and first observation timestamp');

      const existing = db.get("SELECT ifnull(project, '') AS project FROM sessions WHERE id = ?", action.session_id);
      if (existing) {
        const existingProject = normalized(existing.project);
        if (existingProject !== project) throw new Error(`orphaned session ${JSON.stringify(action.session_id)} already belongs to project ${JSON.stringify(existingProject)}, not ${JSON.stringify(project)}`);
        continue; // el mismo proyecto ya es dueño: un plan anticuado no hace nada
      }
      const projects = orphanedObservationProjects(db, action.session_id);
      if (projects.size === 0) throw new Error(`orphaned session ${JSON.stringify(action.session_id)} has no supporting observations`);
      if (projects.size !== 1) throw new Error(`orphaned session ${JSON.stringify(action.session_id)} is referenced by multiple projects`);
      if (!projects.has(project)) throw new Error(`orphaned session ${JSON.stringify(action.session_id)} evidence belongs to a different project`);

      const row = db.get('SELECT COUNT(*) AS n, MIN(created_at) AS first FROM observations WHERE session_id = ?', action.session_id);
      const startedAt = row.first == null ? '' : goTrim(row.first);
      if (Number(row.n) === 0) throw new Error(`orphaned session ${JSON.stringify(action.session_id)} has no supporting observations`);
      if (startedAt === '') throw new Error(`orphaned session ${JSON.stringify(action.session_id)} has no first observation timestamp`);

      const result = db.run(
        `INSERT INTO sessions (id, project, ownership_mode, directory, started_at, ended_at, summary)
         VALUES (?, ?, ?, '', ?, ?, 'Recovered local placeholder for orphaned observations.')`,
        action.session_id, project, SESSION_OWNERSHIP_PROJECT_OWNED, startedAt, startedAt,
      );
      if (Number(result.changes) !== 1) throw new Error(`orphaned session ${JSON.stringify(action.session_id)} placeholder insert affected ${result.changes} rows`);
      applied.push({ session_id: action.session_id, project, observation_count: Number(row.n), started_at: startedAt });
    }
    return applied;
  });
}

// ─── Relaciones pendientes huérfanas ─────────────────────────────────────────

/**
 * Mueve a la disposición auditada `orphaned` toda relación pendiente con ambos extremos
 * ausentes. El bloqueo de escritura cubre la copia previa y el cambio; el predicado se
 * revalida dentro de la transacción para no pisar un juicio posterior. Como los escritores de
 * borrado duro, no emite mutaciones de sincronización. Es idempotente.
 * @returns {{ reclassified: number, candidates_at_apply: number, one_endpoint_missing: number, live_pending: number, backup_path: string }}
 */
export function reclassifyOrphanedPendingRelations(store) {
  return store.db.writeTransaction((db) => {
    const backupPath = backupSqliteUnderWriteLock(store);
    const before = countOrphanedPendingRelations(db);
    const changed = db.run(`UPDATE memory_relations AS r SET judgment_status = 'orphaned', updated_at = datetime('now') WHERE ${ORPHANED_PENDING_RELATION_CANDIDATE}`);
    const after = countOrphanedPendingRelations(db);
    return {
      reclassified: Number(changed.changes), candidates_at_apply: before.candidates, one_endpoint_missing: after.one_endpoint_missing, live_pending: after.live_pending, backup_path: backupPath,
    };
  });
}

// ─── Reclasificación de proyecto de sesiones ─────────────────────────────────

/** Acciones válidas y únicas: ID no vacío, proyectos normalizados, distintos entre sí. */
export function normalizeSessionProjectReclassifications(actions) {
  const seen = new Set();
  const out = [];
  for (const original of actions) {
    const action = { session_id: goTrim(original.session_id ?? ''), from_project: normalized(original.from_project), to_project: normalized(original.to_project) };
    if (action.session_id === '' || action.from_project === '' || action.to_project === '' || action.from_project === action.to_project) continue;
    const key = `${action.session_id}\u0000${action.from_project}\u0000${action.to_project}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out;
}

/** Cuántas sesiones, observaciones y prompts cambiarían. */
export function estimateSessionProjectReclassification(store, actions) {
  const counts = { sessions: 0, observations: 0, prompts: 0 };
  for (const action of normalizeSessionProjectReclassifications(actions)) {
    counts.sessions += Number(store.db.get('SELECT count(*) AS n FROM sessions WHERE id = ? AND project = ?', action.session_id, action.from_project).n);
    counts.observations += Number(store.db.get('SELECT count(*) AS n FROM observations WHERE session_id = ? AND project = ?', action.session_id, action.from_project).n);
    counts.prompts += Number(store.db.get('SELECT count(*) AS n FROM user_prompts WHERE session_id = ? AND project = ?', action.session_id, action.from_project).n);
  }
  return counts;
}

/**
 * Reasigna proyecto a sesiones, observaciones y prompts tras una copia de la base. El modo de
 * propiedad resultante es `project_owned` solo si el ID es `manual-save-<proyecto destino>`.
 * @returns {{ counts: { sessions: number, observations: number, prompts: number }, backup_path: string }}
 */
export function applySessionProjectReclassification(store, actions) {
  const normalizedActions = normalizeSessionProjectReclassifications(actions);
  const backupPath = backupSqlite(store);
  const counts = { sessions: 0, observations: 0, prompts: 0 };
  store.db.writeTransaction((db) => {
    for (const action of normalizedActions) {
      const mode = manualSaveOwnerProject(action.session_id, action.to_project) ? SESSION_OWNERSHIP_PROJECT_OWNED : SESSION_OWNERSHIP_SHARED;
      const fail = (what, err) => new Error(`reclassify ${what}: ${err.message}`, { cause: err });
      try {
        counts.sessions += Number(db.run('UPDATE sessions SET project = ?, ownership_mode = ? WHERE id = ? AND project = ?', action.to_project, mode, action.session_id, action.from_project).changes);
      } catch (err) {
        throw fail(`session ${JSON.stringify(action.session_id)}`, err);
      }
      try {
        counts.observations += Number(db.run('UPDATE observations SET project = ? WHERE session_id = ? AND project = ?', action.to_project, action.session_id, action.from_project).changes);
      } catch (err) {
        throw fail(`observations for session ${JSON.stringify(action.session_id)}`, err);
      }
      try {
        counts.prompts += Number(db.run('UPDATE user_prompts SET project = ? WHERE session_id = ? AND project = ?', action.to_project, action.session_id, action.from_project).changes);
      } catch (err) {
        throw fail(`prompts for session ${JSON.stringify(action.session_id)}`, err);
      }
    }
  });
  return { counts, backup_path: backupPath };
}
