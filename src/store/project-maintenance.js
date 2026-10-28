import { normalizeProject } from '../project/canonical.js';
import { now } from '../timeutil/index.js';
import { StoreError, storeError } from './errors.js';
import { backfillProjectSyncMutations } from './journal.js';
import { recordDeleteTombstone } from './observations.js';
import { countObservationsForProject } from './projects.js';
import { goTrim } from './text.js';

/** Nombre reservado de la bandeja de entrada de Cloud; no puede ser destino de una fusión. */
export const RESERVED_INBOX_PROJECT_NAME = 'inbox';

const fail = (message) => new StoreError('invalid_project_merge', message);
const q = (s) => JSON.stringify(s);
const marks = (n) => Array.from({ length: n }, () => '?').join(',');

/**
 * Traslada el estado de sincronización de varios nombres de proyecto a uno
 * canónico: reescribe el proyecto de las mutaciones pendientes (en la columna y
 * en el JSON de la carga) y traspasa la inscripción.
 */
function migrateProjectSyncIdentity(db, sources, canonical) {
  const variants = [...new Set(sources.map((s) => goTrim(s)).filter((s) => s !== '' && s !== canonical))];
  if (variants.length === 0) return;
  const ph = marks(variants.length);
  db.run(
    `UPDATE sync_mutations
     SET payload = CASE
           WHEN json_valid(payload) AND json_extract(payload, '$.project') IN (${ph})
           THEN json_set(payload, '$.project', ?)
           ELSE payload
         END,
         project = ?
     WHERE acked_at IS NULL
       AND (project IN (${ph}) OR (json_valid(payload) AND json_extract(payload, '$.project') IN (${ph})))`,
    ...variants, canonical, canonical, ...variants, ...variants,
  );
  db.run(
    `INSERT OR IGNORE INTO sync_enrolled_projects (project)
     SELECT ? WHERE EXISTS (SELECT 1 FROM sync_enrolled_projects WHERE project IN (${ph}))`,
    canonical, ...variants,
  );
  db.run(`DELETE FROM sync_enrolled_projects WHERE project IN (${ph})`, ...variants);
}

/**
 * Renombra un proyecto: actualiza observaciones, sesiones y prompts cuyo
 * `project` sea exactamente `oldName`. No hace nada (y devuelve `migrated: false`)
 * si algún nombre está vacío, son iguales o no hay datos del antiguo.
 * @param {import('./store.js').Store} store
 * @param {string} oldName nombre exacto actual
 * @param {string} newName nombre nuevo (se normaliza)
 * @returns {{ migrated: boolean, observations_updated: number, sessions_updated: number, prompts_updated: number }}
 */
export function migrateProject(store, oldName, newName) {
  newName = normalizeProject(newName ?? '').normalized;
  const none = { migrated: false, observations_updated: 0, sessions_updated: 0, prompts_updated: 0 };
  if (!oldName || !newName || oldName === newName) return none;
  const exists = store.db.get(
    `SELECT EXISTS(
       SELECT 1 FROM observations WHERE project = ?
       UNION ALL SELECT 1 FROM sessions WHERE project = ?
       UNION ALL SELECT 1 FROM user_prompts WHERE project = ?
     ) AS found`,
    oldName, oldName, oldName,
  ).found;
  if (exists !== 1) return none;
  return store.db.writeTransaction((db) => {
    const o = Number(db.run('UPDATE observations SET project = ? WHERE project = ?', newName, oldName).changes);
    const s = Number(db.run('UPDATE sessions SET project = ? WHERE project = ?', newName, oldName).changes);
    const p = Number(db.run('UPDATE user_prompts SET project = ? WHERE project = ?', newName, oldName).changes);
    migrateProjectSyncIdentity(db, [oldName], newName);
    backfillProjectSyncMutations(db, newName);
    return { migrated: true, observations_updated: o, sessions_updated: s, prompts_updated: p };
  });
}

/** Un origen es fusionable si normaliza al canónico o, en modo explícito, difiere solo en `-`/`_`. */
function mergeEligible(source, canonical, explicit) {
  if (source === canonical) return true;
  if (!explicit) return false;
  const strip = (name) => name.replace(/[-_]/g, '');
  return strip(source) === strip(canonical) && source !== canonical;
}

/**
 * Variante a fusionar de un origen: el nombre tal cual lo escribió quien llama
 * (recortado), o ninguna si es el canónico o no es fusionable.
 */
function mergeSourceVariants(rawSource, normalizedSource, canonical, explicit) {
  const raw = goTrim(rawSource);
  if (raw === '' || raw === canonical || !mergeEligible(normalizedSource, canonical, explicit)) return [];
  return [raw];
}

function countSource(db, name) {
  let count = 0;
  let enrolled = false;
  for (const table of ['observations', 'sessions', 'user_prompts', 'sync_enrolled_projects']) {
    const n = Number(db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE project = ?`, name).n);
    count += n;
    if (table === 'sync_enrolled_projects' && n > 0) enrolled = true;
  }
  const pending = Number(
    db.get(
      `SELECT COUNT(*) AS n FROM sync_mutations WHERE acked_at IS NULL AND
       (project = ? OR (json_valid(payload) AND json_extract(payload, '$.project') = ?))`,
      name, name,
    ).n,
  );
  return { count: count + pending, syncIdentityPresent: enrolled || pending > 0 };
}

/**
 * Vista previa de una fusión explícita: cuántos registros cambiarían.
 * @param {import('./store.js').Store} store
 * @param {string} source
 * @param {string} canonical
 * @returns {{ canonical: string, source: string, observations_updated: number, sessions_updated: number, prompts_updated: number, sync_identity_changes: boolean }}
 */
export function previewExplicitProjectMerge(store, source, canonical) {
  canonical = normalizeProject(canonical ?? '').normalized;
  const normalizedSource = normalizeProject(source ?? '').normalized;
  if (canonical === RESERVED_INBOX_PROJECT_NAME) throw fail('reserved inbox project cannot be a merge destination');
  if (canonical === '' || normalizedSource === '' || goTrim(source) === canonical || !mergeEligible(normalizedSource, canonical, true)) {
    throw fail(`source project ${q(source)} must be a distinct legacy case, separator or Unicode normalization variant of canonical project ${q(canonical)}`);
  }
  const name = goTrim(source);
  return store.db.readTransaction((db) => {
    const count = (table) => Number(db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE project = ?`, name).n);
    const preview = {
      canonical, source: name,
      observations_updated: count('observations'), sessions_updated: count('sessions'), prompts_updated: count('user_prompts'),
      sync_identity_changes: false,
    };
    const enrolled = count('sync_enrolled_projects');
    const pending = Number(
      db.get(
        `SELECT COUNT(*) AS n FROM sync_mutations WHERE acked_at IS NULL AND
         (project = ? OR (json_valid(payload) AND json_extract(payload, '$.project') = ?))`,
        name, name,
      ).n,
    );
    preview.sync_identity_changes = enrolled > 0 || pending > 0;
    if (preview.observations_updated + preview.sessions_updated + preview.prompts_updated + enrolled + pending === 0) {
      throw fail(`source project ${q(name)} does not exist`);
    }
    return preview;
  });
}

function merge(store, sources, canonical, explicit) {
  canonical = normalizeProject(canonical ?? '').normalized;
  if (canonical === '') throw fail('canonical project name must not be empty');
  if (canonical === RESERVED_INBOX_PROJECT_NAME) throw fail('reserved inbox project cannot be a merge destination');
  const normalized = sources.map((source) => {
    const n = normalizeProject(source ?? '').normalized;
    if (n === '') throw fail('source project name must not be empty');
    if (!mergeEligible(n, canonical, explicit)) {
      throw fail(
        explicit
          ? `source project ${q(source)} must normalize to canonical project ${q(canonical)} or differ only by corresponding '-' and '_' separators`
          : `source project ${q(source)} must normalize to canonical project ${q(canonical)}`,
      );
    }
    return n;
  });

  const result = { canonical, sources_merged: [], observations_updated: 0, sessions_updated: 0, prompts_updated: 0 };
  return store.db.writeTransaction((db) => {
    const seen = new Set();
    for (const [i, input] of sources.entries()) {
      if (seen.has(input)) continue;
      seen.add(input);
      const variants = mergeSourceVariants(input, normalized[i], canonical, explicit);
      let syncIdentityPresent = false;
      if (explicit) {
        const { count, syncIdentityPresent: present } = countSource(db, goTrim(input));
        syncIdentityPresent = present;
        if (count === 0) throw fail(`source project ${q(goTrim(input))} does not exist`);
      }
      if (input === canonical || variants.length === 0) continue;
      const ph = marks(variants.length);
      let updated = false;
      for (const [table, key] of [['observations', 'observations_updated'], ['sessions', 'sessions_updated'], ['user_prompts', 'prompts_updated']]) {
        const n = Number(db.run(`UPDATE ${table} SET project = ? WHERE project IN (${ph})`, canonical, ...variants).changes);
        result[key] += n;
        updated = updated || n > 0;
      }
      migrateProjectSyncIdentity(db, variants, canonical);
      if (updated || syncIdentityPresent) result.sources_merged.push(variants[0]);
    }
    backfillProjectSyncMutations(db, canonical);
    return result;
  });
}

/**
 * Fusiona nombres de proyecto que normalizan al canónico (p. ej. variantes de
 * mayúsculas o Unicode heredadas) en `canonical`.
 * @param {import('./store.js').Store} store
 * @param {string[]} sources
 * @param {string} canonical
 * @returns {{ canonical: string, sources_merged: string[], observations_updated: number, sessions_updated: number, prompts_updated: number }}
 */
export function mergeProjects(store, sources, canonical) {
  return merge(store, sources, canonical, false);
}

/**
 * Como `mergeProjects`, pero además admite orígenes que solo difieren del
 * canónico en los separadores `-` y `_`, y exige que el origen exista.
 */
export function mergeExplicitProjectVariants(store, sources, canonical) {
  return merge(store, sources, canonical, true);
}

/**
 * Elimina los prompts y las sesiones vacías de un proyecto que ya no tiene
 * observaciones vivas.
 * @param {import('./store.js').Store} store
 * @param {string} project nombre exacto
 * @returns {{ project: string, sessions_deleted: number, prompts_deleted: number }}
 */
export function pruneProject(store, project) {
  if (!project) throw storeError('project_name_required');
  const count = countObservationsForProject(store, project);
  if (count > 0) throw new StoreError('project_prune_blocked', `project ${q(project)} still has ${count} observations — cannot prune`);
  return store.db.writeTransaction((db) => {
    const prompts = Number(db.run('DELETE FROM user_prompts WHERE project = ?', project).changes);
    const sessions = Number(
      db.run(
        `DELETE FROM sessions WHERE project = ?
         AND NOT EXISTS (SELECT 1 FROM observations WHERE observations.session_id = sessions.id)`,
        project,
      ).changes,
    );
    return { project, sessions_deleted: sessions, prompts_deleted: prompts };
  });
}

/**
 * Borra un proyecto entero. El borrado suave marca las observaciones y elimina
 * los prompts; el duro además elimina observaciones y sesiones vacías, deja
 * huérfanas sus relaciones y registra una lápida del proyecto.
 * @param {import('./store.js').Store} store
 * @param {string} project nombre exacto (se recorta)
 * @param {boolean} [hardDelete]
 * @returns {{ project: string, observations_deleted: number, prompts_deleted: number, sessions_deleted: number, hard_delete: boolean }}
 */
export function deleteProject(store, project, hardDelete = false) {
  project = goTrim(project ?? '');
  if (project === '') throw storeError('project_name_required');
  const result = { project, observations_deleted: 0, prompts_deleted: 0, sessions_deleted: 0, hard_delete: hardDelete };
  return store.db.writeTransaction((db) => {
    const sessionCount = Number(db.get('SELECT COUNT(*) AS n FROM sessions WHERE project = ?', project).n);
    const obsCount = Number(db.get('SELECT COUNT(*) AS n FROM observations WHERE project = ?', project).n);
    if (sessionCount === 0 && obsCount === 0) throw storeError('project_not_found', q(project));
    if (hardDelete) {
      db.run(
        `UPDATE memory_relations SET judgment_status = 'orphaned', updated_at = datetime('now')
         WHERE source_id IN (SELECT sync_id FROM observations WHERE project = ?)
            OR target_id IN (SELECT sync_id FROM observations WHERE project = ?)`,
        project, project,
      );
      result.observations_deleted = Number(db.run('DELETE FROM observations WHERE project = ?', project).changes);
    } else {
      result.observations_deleted = Number(
        db.run("UPDATE observations SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE project = ? AND deleted_at IS NULL", project).changes,
      );
    }
    result.prompts_deleted = Number(db.run('DELETE FROM user_prompts WHERE project = ?', project).changes);
    if (hardDelete) {
      result.sessions_deleted = Number(
        db.run(
          `DELETE FROM sessions WHERE project = ?
           AND NOT EXISTS (SELECT 1 FROM observations WHERE observations.session_id = sessions.id)
           AND NOT EXISTS (SELECT 1 FROM user_prompts WHERE user_prompts.session_id = sessions.id)`,
          project,
        ).changes,
      );
      recordDeleteTombstone(db, 'project', normalizeProject(project).normalized, '', project, now());
    }
    return result;
  });
}
