import { normalizeProject } from '../project/canonical.js';
import { storeError } from './errors.js';
import { now } from '../timeutil/index.js';
import { DEFAULT_SYNC_TARGET_KEY } from './schema.js';
import { SQL_WHITESPACE_TRIM_SET, goTrim } from './text.js';

/** Entidades del diario de sincronización. */
export const SYNC_ENTITY = Object.freeze({
  session: 'session',
  observation: 'observation',
  prompt: 'prompt',
  relation: 'relation',
  project: 'project',
});
export const SYNC_OP_UPSERT = 'upsert';
export const SYNC_OP_DELETE = 'delete';

/**
 * @param {import('./db.js').Database} db
 * @param {string} project nombre ya canónico
 * @returns {boolean} true si el proyecto está inscrito en la sincronización con Cloud.
 */
export function isProjectEnrolled(db, project) {
  return db.get('SELECT EXISTS(SELECT 1 FROM sync_enrolled_projects WHERE project = ?) AS enrolled', project).enrolled === 1;
}

/** Proyecto dueño de una sesión, canónico, o cadena vacía si no existe. */
export function sessionProject(db, sessionId) {
  if (goTrim(sessionId ?? '') === '') return '';
  const row = db.get("SELECT ifnull(project, '') AS project FROM sessions WHERE id = ?", sessionId);
  return row ? normalizeProject(goTrim(row.project)).normalized : '';
}

/** Origen de las mutaciones que genera una escritura local. */
export const SYNC_SOURCE_LOCAL = 'local';

/**
 * Punto único donde cada escritura local anota su mutación para la sincronización.
 * La entrega a Cloud es opcional por proyecto: una mutación con proyecto que no está
 * inscrito no se registra (la escritura local sigue siendo duradera) y el relleno de la
 * inscripción materializa después su estado. Las que no tienen proyecto sí se registran.
 * Debe llamarse dentro de la transacción de la escritura.
 *
 * Cada fila se guarda bajo el destino `cloud`, con el proyecto en su propia columna, y
 * marca como pendientes el destino global y el del proyecto (`cloud:<proyecto>`).
 *
 * @param {import('./db.js').Database} db
 * @param {object} mutation
 * @param {string} mutation.entity valor de SYNC_ENTITY
 * @param {string} mutation.entityKey sync_id o id de la entidad
 * @param {string} mutation.op SYNC_OP_UPSERT o SYNC_OP_DELETE
 * @param {string} [mutation.project] proyecto de la entidad
 * @param {string} [mutation.sessionId] sesión de la que derivar el proyecto si falta
 * @param {object|(() => object)} [mutation.payload] carga (o quien la construye); solo se evalúa si hace falta
 * @param {string} [mutation.source] por defecto `local`
 */
export function journalMutation(db, { entity, entityKey, op, project = '', sessionId = '', payload = {}, source = SYNC_SOURCE_LOCAL }) {
  if (entity === SYNC_ENTITY.session && goTrim(entityKey ?? '') === '') throw storeError('session_id_required');
  const body = typeof payload === 'function' ? payload() : payload;
  source = goTrim(source) === '' ? SYNC_SOURCE_LOCAL : goTrim(source);
  // Una sesión local sin directorio no viaja: la nube la rechazaría.
  if (source === SYNC_SOURCE_LOCAL && entity === SYNC_ENTITY.session && op === SYNC_OP_UPSERT && goTrim(body?.directory ?? '') === '') return;
  if (op === SYNC_OP_UPSERT && (entity === SYNC_ENTITY.session || entity === SYNC_ENTITY.observation)) {
    db.run('UPDATE sync_delete_tombstones SET active = 0 WHERE entity = ? AND entity_key = ?', entity, entityKey);
  }
  let owner = normalizeProject(goTrim(project)).normalized;
  if (owner === '' && sessionId) owner = sessionProject(db, sessionId);
  if (source === SYNC_SOURCE_LOCAL && owner !== '' && !isProjectEnrolled(db, owner)) return;
  if (source === SYNC_SOURCE_LOCAL && entity === SYNC_ENTITY.session && op === SYNC_OP_UPSERT) {
    db.run(
      `DELETE FROM sync_mutations WHERE target_key = ? AND entity = ? AND entity_key = ? AND op = ? AND source = ? AND project = ? AND acked_at IS NULL AND disposition = 'pending'`,
      DEFAULT_SYNC_TARGET_KEY, entity, entityKey, op, source, owner,
    );
  }
  db.run("INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES (?, 'idle', datetime('now'))", DEFAULT_SYNC_TARGET_KEY);
  const seq = Number(db.run(
    'INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    DEFAULT_SYNC_TARGET_KEY, entity, entityKey, op, JSON.stringify(body ?? {}), source, owner, now(),
  ).lastInsertRowid);
  db.run("UPDATE sync_state SET lifecycle = 'pending', last_enqueued_seq = ?, updated_at = datetime('now') WHERE target_key = ?", seq, DEFAULT_SYNC_TARGET_KEY);
  if (owner === '') return;
  const projectTarget = `${DEFAULT_SYNC_TARGET_KEY}:${owner}`;
  db.run("INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES (?, 'idle', datetime('now'))", projectTarget);
  db.run("UPDATE sync_state SET lifecycle = 'pending', last_enqueued_seq = ?, updated_at = datetime('now') WHERE target_key = ?", seq, projectTarget);
}

const NOT_QUEUED = `NOT EXISTS (
    SELECT 1 FROM sync_mutations sm
    WHERE sm.target_key = ? AND sm.entity = ? AND sm.entity_key = %KEY% AND sm.source = ? %OP% AND sm.disposition IN ('pending', 'quarantined')
  )`;
const notQueued = (key, withOp = false) => NOT_QUEUED.replace('%KEY%', key).replace('%OP%', withOp ? 'AND sm.op = ?' : '');

/**
 * Materializa en el diario el estado local de un proyecto inscrito: sus sesiones, observaciones (vivas y
 * borradas), prompts (vivos y con lápida), lápidas de borrado duro y relaciones ya juzgadas, salvo lo que ya
 * tenga una mutación pendiente o en cuarentena. Debe llamarse dentro de una transacción; es idempotente.
 * @param {import('./db.js').Database} db
 * @param {string} project proyecto canónico
 * @param {string} [source]
 */
export function backfillProjectSyncMutations(db, project, source = SYNC_SOURCE_LOCAL) {
  const name = goTrim(project ?? '');
  if (name === '') return;
  const src = goTrim(source) === '' ? SYNC_SOURCE_LOCAL : goTrim(source);
  const target = DEFAULT_SYNC_TARGET_KEY;
  const enqueue = (entity, entityKey, op, payload, owner = name, sessionId = '') => {
    journalMutation(db, { entity, entityKey, op, project: owner, sessionId, payload, source: src });
  };

  // Primero se recoge cada conjunto y después se inserta: así la consulta no ve sus propias escrituras.
  const sessions = db.all(
    `SELECT id, project, ifnull(ownership_mode, '') AS ownership_mode, directory, started_at, ended_at, summary FROM sessions
     WHERE project = ? AND trim(id, ?) <> '' AND ${notQueued('sessions.id')} ORDER BY started_at ASC, id ASC`,
    name, SQL_WHITESPACE_TRIM_SET, target, SYNC_ENTITY.session, src,
  );
  for (const row of sessions) enqueue(SYNC_ENTITY.session, row.id, SYNC_OP_UPSERT, { ...row });

  const ownedBy = 'ifnull(o.project, \'\') = ? OR (ifnull(o.project, \'\') = \'\' AND ifnull(s.project, \'\') = ?)';
  const live = db.all(
    `SELECT o.sync_id, o.session_id, o.type, o.title, o.content, o.tool_name, o.project, o.scope, o.topic_key, o.revision_count, o.duplicate_count,
            o.last_seen_at, o.created_at, o.updated_at, o.superseded_by_sync_id
     FROM observations o LEFT JOIN sessions s ON s.id = o.session_id
     WHERE (${ownedBy}) AND o.deleted_at IS NULL AND ${notQueued('o.sync_id')} ORDER BY o.id ASC`,
    name, name, target, SYNC_ENTITY.observation, src,
  );
  for (const row of live) enqueue(SYNC_ENTITY.observation, row.sync_id, SYNC_OP_UPSERT, withoutNulls(row, OPTIONAL_OBSERVATION_FIELDS), row.project ?? '', row.session_id);

  const removed = db.all(
    `SELECT o.sync_id, o.session_id, o.project, o.deleted_at, o.superseded_by_sync_id
     FROM observations o LEFT JOIN sessions s ON s.id = o.session_id
     WHERE (${ownedBy}) AND o.deleted_at IS NOT NULL AND ${notQueued('o.sync_id', true)} ORDER BY o.id ASC`,
    name, name, target, SYNC_ENTITY.observation, src, SYNC_OP_DELETE,
  );
  for (const row of removed) {
    enqueue(SYNC_ENTITY.observation, row.sync_id, SYNC_OP_DELETE, { ...withoutNulls(row, OPTIONAL_OBSERVATION_FIELDS), deleted: true, hard_delete: false }, row.project ?? '', row.session_id);
  }

  const tombstones = db.all(
    `SELECT entity, entity_key, ifnull(session_id, '') AS session_id, project, deleted_at, hard_delete FROM sync_delete_tombstones tombstone
     WHERE project = ? AND tombstone.active = 1 AND tombstone.entity IN ('observation', 'session') AND tombstone.last_remote_mutation_seq IS NULL
       AND NOT EXISTS (SELECT 1 FROM sync_mutations sm WHERE sm.target_key = ? AND sm.entity = tombstone.entity AND sm.entity_key = tombstone.entity_key
                       AND sm.op = ? AND sm.source = ? AND sm.acked_at IS NULL AND sm.disposition IN ('pending', 'quarantined'))
     ORDER BY CASE entity WHEN 'observation' THEN 0 WHEN 'session' THEN 1 ELSE 2 END, deleted_at ASC, entity_key ASC`,
    name, target, SYNC_OP_DELETE, src,
  );
  for (const t of tombstones) {
    const hard = Number(t.hard_delete) === 1;
    const payload = t.entity === SYNC_ENTITY.observation
      ? { sync_id: t.entity_key, session_id: t.session_id, project: t.project, deleted: true, deleted_at: t.deleted_at, hard_delete: hard }
      : { id: t.entity_key, project: t.project, deleted: true, deleted_at: t.deleted_at, hard_delete: hard };
    enqueue(t.entity, t.entity_key, SYNC_OP_DELETE, payload, t.project, t.session_id);
  }

  const promptOwner = 'ifnull(p.project, \'\') = ? OR (ifnull(p.project, \'\') = \'\' AND ifnull(s.project, \'\') = ?)';
  const prompts = db.all(
    `SELECT p.sync_id, p.session_id, p.content, p.project, p.created_at, ifnull(p.source_inbox_id, '') AS source_inbox_id
     FROM user_prompts p LEFT JOIN sessions s ON s.id = p.session_id
     WHERE (${promptOwner}) AND ${notQueued('p.sync_id')} ORDER BY p.id ASC`,
    name, name, target, SYNC_ENTITY.prompt, src,
  );
  for (const row of prompts) enqueue(SYNC_ENTITY.prompt, row.sync_id, SYNC_OP_UPSERT, { ...row, project: row.project ?? name }, row.project ?? '', row.session_id);

  const gone = db.all(
    `SELECT t.sync_id, t.session_id, t.project, t.deleted_at, ifnull(t.source_inbox_id, '') AS source_inbox_id
     FROM prompt_tombstones t LEFT JOIN sessions s ON s.id = t.session_id
     WHERE (ifnull(t.project, '') = ? OR (ifnull(t.project, '') = '' AND ifnull(s.project, '') = ?))
       AND NOT EXISTS (SELECT 1 FROM sync_mutations sm WHERE sm.target_key = ? AND sm.entity = ? AND sm.entity_key = t.sync_id AND sm.source = ? AND sm.op = ?
                       AND sm.disposition IN ('pending', 'quarantined'))
     ORDER BY t.deleted_at ASC`,
    name, name, target, SYNC_ENTITY.prompt, src, SYNC_OP_DELETE,
  );
  for (const row of gone) enqueue(SYNC_ENTITY.prompt, row.sync_id, SYNC_OP_DELETE, { ...row, deleted: true, hard_delete: true }, row.project ?? '', row.session_id);

  // Solo relaciones juzgadas por alguien: la nube rechaza las que no traen autor.
  const relations = db.all(
    `SELECT r.sync_id, r.source_id, r.target_id, r.relation, r.reason, r.evidence, r.confidence, r.judgment_status, r.marked_by_actor, r.marked_by_kind,
            r.marked_by_model, r.session_id, coalesce(nullif(src.project, ''), src_s.project, '') AS project, r.created_at, r.updated_at
     FROM memory_relations r
     JOIN observations src ON src.sync_id = r.source_id AND src.deleted_at IS NULL
     JOIN observations tgt ON tgt.sync_id = r.target_id AND tgt.deleted_at IS NULL
     LEFT JOIN sessions src_s ON src_s.id = src.session_id
     WHERE r.judgment_status NOT IN ('orphaned', 'pending') AND ifnull(r.marked_by_actor, '') != '' AND ifnull(r.marked_by_kind, '') != ''
       AND coalesce(nullif(src.project, ''), src_s.project, '') = ? AND ${notQueued('r.sync_id')}
     ORDER BY r.created_at ASC, r.sync_id ASC`,
    name, target, SYNC_ENTITY.relation, src,
  );
  for (const row of relations) enqueue(SYNC_ENTITY.relation, row.sync_id, SYNC_OP_UPSERT, { ...row }, row.project, row.session_id ?? '');
}

const OPTIONAL_OBSERVATION_FIELDS = ['tool_name', 'project', 'topic_key', 'last_seen_at', 'review_after', 'superseded_by_sync_id'];

/** Copia sin las claves indicadas cuando valen `null` (los opcionales ausentes no viajan). */
function withoutNulls(row, keys) {
  const out = { ...row };
  for (const key of keys) if (out[key] === null || out[key] === undefined) delete out[key];
  return out;
}
