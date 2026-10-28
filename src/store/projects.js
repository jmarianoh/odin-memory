import { resolve } from 'node:path';
import { normalizeProject, normalizeProjectName } from '../project/canonical.js';
import { StoreError } from './errors.js';
import { goTrim } from './text.js';

/**
 * Totales de sesiones, observaciones vivas y prompts, y proyectos con
 * observaciones (el de actividad más reciente primero). Con `project` (ya
 * normalizado) filtra con `LOWER(project)`.
 * @param {import('./store.js').Store} store
 * @param {string} [project]
 * @returns {{ total_sessions: number, total_observations: number, total_prompts: number, projects: string[] }}
 */
function statsFor(store, project) {
  const { db } = store;
  const where = project ? ' WHERE LOWER(project) = ?' : '';
  const args = project ? [project] : [];
  const count = (sql) => Number(Object.values(db.get(sql, ...args))[0]);
  let projectsSql = 'SELECT project FROM observations WHERE project IS NOT NULL AND deleted_at IS NULL';
  if (project) projectsSql += ' AND LOWER(project) = ?';
  projectsSql += ' GROUP BY project ORDER BY MAX(created_at) DESC';
  return {
    total_sessions: count(`SELECT COUNT(*) FROM sessions${where}`),
    total_observations: count(`SELECT COUNT(*) FROM observations WHERE deleted_at IS NULL${project ? ' AND LOWER(project) = ?' : ''}`),
    total_prompts: count(`SELECT COUNT(*) FROM user_prompts${where}`),
    projects: db.all(projectsSql, ...args).map((r) => r.project),
  };
}

/** Estadísticas globales. */
export function stats(store) {
  return statsFor(store, '');
}

/**
 * Estadísticas de un proyecto.
 * @throws {StoreError} `project_required` si el nombre queda vacío.
 */
export function statsProject(store, project) {
  project = normalizeProject(project ?? '').normalized;
  if (goTrim(project) === '') throw new StoreError('project_required', 'project is required');
  return statsFor(store, project);
}

/**
 * true si el nombre (canónico) aparece en observaciones vivas, sesiones, prompts
 * o proyectos inscritos.
 * @param {import('./store.js').Store} store
 * @param {string} name
 */
export function projectExists(store, name) {
  return (
    store.db.get(
      `SELECT 1 AS found FROM (
         SELECT project FROM observations WHERE LOWER(project) = ? AND deleted_at IS NULL
         UNION ALL SELECT project FROM sessions WHERE LOWER(project) = ?
         UNION ALL SELECT project FROM user_prompts WHERE LOWER(project) = ?
         UNION ALL SELECT project FROM sync_enrolled_projects WHERE LOWER(project) = ?
       ) LIMIT 1`,
      name, name, name, name,
    ) !== undefined
  );
}

/** Nombres de proyecto con observaciones vivas, ordenados. */
export function listProjectNames(store) {
  return store.db
    .all("SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != '' AND deleted_at IS NULL ORDER BY project")
    .map((r) => r.project);
}

/**
 * Proyectos con sus recuentos, de más a menos observaciones.
 * @param {import('./store.js').Store} store
 * @returns {{ name: string, observation_count: number, session_count: number, prompt_count: number, directories: string[] }[]}
 */
export function listProjectsWithStats(store) {
  const { db } = store;
  const byName = new Map();
  const entry = (name) => {
    if (!byName.has(name)) byName.set(name, { name, observation_count: 0, session_count: 0, prompt_count: 0, directories: [] });
    return byName.get(name);
  };
  for (const r of db.all("SELECT project, COUNT(*) AS cnt FROM observations WHERE project IS NOT NULL AND project != '' AND deleted_at IS NULL GROUP BY project")) {
    entry(r.project).observation_count = Number(r.cnt);
  }
  const sessions = new Map();
  for (const r of db.all("SELECT project, COUNT(*) AS cnt, directory FROM sessions WHERE project IS NOT NULL AND project != '' GROUP BY project, directory")) {
    const data = sessions.get(r.project) ?? { count: 0, dirs: new Set() };
    data.count += Number(r.cnt);
    if (r.directory !== '') data.dirs.add(r.directory);
    sessions.set(r.project, data);
  }
  for (const [name, data] of sessions) {
    const e = entry(name);
    e.session_count = data.count;
    e.directories = [...data.dirs];
  }
  for (const r of db.all("SELECT project, COUNT(*) AS cnt FROM user_prompts WHERE project IS NOT NULL AND project != '' GROUP BY project")) {
    entry(r.project).prompt_count = Number(r.cnt);
  }
  return [...byName.values()].sort((a, b) => b.observation_count - a.observation_count);
}

/** Observaciones vivas de un proyecto (nombre exacto). */
export function countObservationsForProject(store, name) {
  return Number(store.db.get('SELECT COUNT(*) AS n FROM observations WHERE project = ? AND deleted_at IS NULL', name).n);
}

// ─── Alias de proyecto ────────────────────────────────────────────────────────

export const PROJECT_ALIAS_KIND_KEY = 'key';
export const PROJECT_ALIAS_KIND_CWD = 'cwd';

const aliasError = (message) => new StoreError('invalid_project_alias', message);

/** Clave canónica de un alias: nombre de proyecto para `key`, ruta absoluta limpia para `cwd`. */
function aliasLookupKey(kind, key) {
  if (kind === PROJECT_ALIAS_KIND_KEY) return normalizeProjectName(key);
  if (kind === PROJECT_ALIAS_KIND_CWD) {
    if (goTrim(key ?? '') === '' || String(key).includes('\0')) throw aliasError(`invalid project alias cwd: ${JSON.stringify(key)}`);
    return resolve(key); // limpia (sin barra final ni `.`/`..`) y hace absoluta la ruta
  }
  throw aliasError(`invalid project alias kind: ${JSON.stringify(kind)}`);
}

/**
 * Crea o actualiza un alias. `key`: nombre alternativo de proyecto; `cwd`: directorio.
 * @param {import('./store.js').Store} store
 * @param {'key'|'cwd'} kind
 * @param {string} key
 * @param {string} project proyecto al que apunta
 * @returns {{ kind: string, key: string, project: string }}
 */
export function setProjectAlias(store, kind, key, project) {
  const normalized = aliasLookupKey(kind, key);
  const target = normalizeProjectName(project);
  store.db.run(
    'INSERT INTO project_aliases(kind, alias_key, project) VALUES(?,?,?) ON CONFLICT(kind,alias_key) DO UPDATE SET project=excluded.project',
    kind, normalized, target,
  );
  return { kind, key: normalized, project: target };
}

/** Todos los alias, ordenados por tipo y clave. */
export function listProjectAliases(store) {
  return store.db.all('SELECT kind, alias_key AS key, project FROM project_aliases ORDER BY kind, alias_key');
}

/** Elimina un alias; devuelve true si existía. */
export function removeProjectAlias(store, kind, key) {
  const normalized = aliasLookupKey(kind, key);
  return Number(store.db.run('DELETE FROM project_aliases WHERE kind = ? AND alias_key = ?', kind, normalized).changes) !== 0;
}

/**
 * Resuelve un nombre y/o directorio a su proyecto vía alias. El alias de
 * directorio prevalece; si ambos existen y apuntan a proyectos distintos hay
 * conflicto y el proyecto queda vacío.
 * @param {import('./store.js').Store} store
 * @param {string} key
 * @param {string} cwd
 * @returns {{ project: string, key_alias: object|null, cwd_alias: object|null, conflict: boolean }}
 */
export function resolveProjectAlias(store, key, cwd) {
  const result = { project: key, key_alias: null, cwd_alias: null, conflict: false };
  const normalizedKey = key ? aliasLookupKey(PROJECT_ALIAS_KIND_KEY, key) : '';
  const normalizedCwd = cwd ? aliasLookupKey(PROJECT_ALIAS_KIND_CWD, cwd) : '';
  const rows = store.db.all(
    "SELECT kind, alias_key AS key, project FROM project_aliases WHERE (kind='key' AND alias_key=? AND ?!='') OR (kind='cwd' AND alias_key=? AND ?!='')",
    normalizedKey, normalizedKey, normalizedCwd, normalizedCwd,
  );
  for (const row of rows) {
    const alias = { ...row };
    if (alias.kind === PROJECT_ALIAS_KIND_KEY) result.key_alias = alias;
    else result.cwd_alias = alias;
  }
  if (result.key_alias) result.project = result.key_alias.project;
  if (result.cwd_alias) result.project = result.cwd_alias.project;
  if (result.key_alias && result.cwd_alias && result.key_alias.project !== result.cwd_alias.project) {
    result.project = '';
    result.conflict = true;
  }
  return result;
}
