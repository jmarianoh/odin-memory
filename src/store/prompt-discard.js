import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { normalizeProject } from '../project/canonical.js';
import { now } from '../timeutil/index.js';
import { SYNC_ENTITY, SYNC_OP_DELETE, SYNC_OP_UPSERT, SYNC_SOURCE_LOCAL, journalMutation } from './journal.js';
import { recordLocalPromptTombstone } from './prompts.js';
import { DEFAULT_SYNC_TARGET_KEY } from './schema.js';
import { goTrim } from './text.js';

/**
 * Descarte explícito de un prompt heredado con contenido vacío: retira sus altas pendientes, deja una lápida, borra el prompt y
 * encola una única baja. Solo efectos locales; nunca confirma nada remoto.
 */

const DISCARD_REASON = 'explicit_legacy_empty_prompt_discard';

export class DiscardBlocker extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'DiscardBlocker';
    this.code = code;
    this.detail = detail;
  }
}
const blocked = (code, detail) => new DiscardBlocker(code, detail);

const plain = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
const rows = (db, sql, ...params) => db.all(sql, ...params).map(plain);
const text = (row, key) => (typeof row[key] === 'string' ? row[key] : '');
const ALLOWED = new Set(['sync_id', 'session_id', 'source_inbox_id', 'content', 'project', 'created_at', 'deleted', 'hard_delete', 'deleted_at']);

/** Carga de un prompt sin campos repetidos ni desconocidos (que ocultarían otra identidad). */
function decodeStrict(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(err.message);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected prompt object');
  // Las claves repetidas desaparecen al analizar: se cuentan en el texto del nivel superior.
  const keys = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => m[1]);
  const top = Object.keys(value);
  for (const key of top) {
    if (!ALLOWED.has(key) || keys.filter((k) => k === key).length > 1) throw new Error('duplicate or unsupported prompt field');
  }
  return value;
}

function planInTransaction(db, project, seq) {
  const plan = { project, selected_seq: seq, prompt_id: 0, sync_id: '', session_id: '', source_inbox_id: '', sequences: null, snapshot: '' };
  try {
    return fillPlan(db, plan, project, seq);
  } catch (err) {
    err.plan = plan;
    throw err;
  }
}

function fillPlan(db, plan, project, seq) {
  const normalized = normalizeProject(project).normalized;
  if (project === '' || normalized !== project || !(seq > 0)) throw blocked('invalid_selection', 'exact normalized project and positive sequence required');
  const selected = rows(db, 'SELECT * FROM sync_mutations WHERE seq = ?', seq);
  if (selected.length !== 1) throw blocked('missing_mutation', 'selected sequence does not exist');
  plan.sync_id = text(selected[0], 'entity_key');
  if (goTrim(plan.sync_id) === '' || goTrim(plan.sync_id) !== plan.sync_id) throw blocked('missing_identity', 'mutation has no exact sync identity');
  const enrollment = rows(db, 'SELECT * FROM sync_enrolled_projects WHERE project = ?', project);
  if (enrollment.length !== 1) throw blocked('not_enrolled', 'initial support requires an enrolled project');
  let canonical = rows(db, 'SELECT * FROM user_prompts WHERE sync_id = ? ORDER BY id', plan.sync_id);
  if (canonical.length !== 1) throw blocked('ambiguous_canonical', 'exactly one canonical prompt required');
  const row = canonical[0];
  plan.prompt_id = Number(row.id);
  plan.session_id = text(row, 'session_id');
  plan.source_inbox_id = text(row, 'source_inbox_id');
  if (text(row, 'project') !== project || goTrim(plan.session_id) === '' || goTrim(plan.session_id) !== plan.session_id || goTrim(plan.source_inbox_id) !== plan.source_inbox_id) {
    throw blocked('conflicting_identity', 'canonical project/session/source does not match exact identity');
  }
  if (goTrim(text(row, 'content')) !== '') throw blocked('recoverable_content', 'canonical content is recoverable');
  for (const [key, expected] of [['local_creation_project', project], ['local_creation_session_id', plan.session_id], ['local_creation_inbox_id', plan.source_inbox_id]]) {
    const value = text(row, key);
    if (value !== '' && value !== expected) throw blocked('conflicting_provenance', 'canonical creation provenance conflicts');
  }
  canonical = rows(db, "SELECT * FROM user_prompts WHERE sync_id = ? OR (? != '' AND session_id = ? AND source_inbox_id = ?) ORDER BY id", plan.sync_id, plan.source_inbox_id, plan.session_id, plan.source_inbox_id);
  if (canonical.length !== 1) throw blocked('ambiguous_canonical', 'canonical inbox identity has aliases');
  const sessions = rows(db, 'SELECT * FROM sessions WHERE id = ?', plan.session_id);
  if (sessions.length !== 1 || text(sessions[0], 'project') !== project) throw blocked('conflicting_session', 'session must exist in the selected project');
  const original = text(sessions[0], 'local_creation_project');
  if (original !== '' && original !== project) throw blocked('conflicting_session', 'session creation provenance conflicts with the project');
  const tombstones = rows(db, "SELECT * FROM prompt_tombstones WHERE sync_id = ? OR (? != '' AND session_id = ? AND source_inbox_id = ?) ORDER BY sync_id", plan.sync_id, plan.source_inbox_id, plan.session_id, plan.source_inbox_id);
  if (tombstones.length !== 0) throw blocked('prior_tombstone', 'existing tombstone makes retirement ambiguous');
  const lineage = rows(
    db,
    `SELECT * FROM sync_mutations
     WHERE entity_key = ? OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END) WHERE lower(key) = 'sync_id' AND value = ?)
        OR (? != '' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END) WHERE lower(key) = 'session_id' AND value = ?)
            AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END) WHERE lower(key) = 'source_inbox_id' AND value = ?))
     ORDER BY seq`,
    plan.sync_id, plan.sync_id, plan.source_inbox_id, plan.session_id, plan.source_inbox_id,
  );
  let selectedFound = false;
  for (const mutation of lineage) {
    let payload;
    try {
      payload = decodeStrict(text(mutation, 'payload'));
    } catch (err) {
      throw blocked('malformed_payload', err.message);
    }
    if (goTrim(typeof payload.content === 'string' ? payload.content : '') !== '') throw blocked('recoverable_content', 'journal lineage contains recoverable content');
    if (text(mutation, 'entity') !== SYNC_ENTITY.prompt || text(mutation, 'entity_key') !== plan.sync_id || text(mutation, 'target_key') !== DEFAULT_SYNC_TARGET_KEY
      || text(mutation, 'source') !== SYNC_SOURCE_LOCAL || text(mutation, 'project') !== project || text(mutation, 'op') !== SYNC_OP_UPSERT || mutation.acked_at != null
      || text(mutation, 'disposition') !== 'pending' || mutation.disposition_reason != null || mutation.disposition_evidence != null || mutation.disposition_at != null) {
      throw blocked('unsupported_lineage', 'all lineage must be unaudited pending unacknowledged local cloud prompt upserts');
    }
    if (payload.sync_id !== plan.sync_id || payload.session_id !== plan.session_id || typeof payload.project !== 'string' || payload.project !== project
      || (payload.source_inbox_id ?? '') !== plan.source_inbox_id || payload.deleted || payload.hard_delete || (payload.deleted_at != null)) {
      throw blocked('conflicting_payload_identity', 'frozen deletion identity differs from canonical prompt');
    }
    (plan.sequences ??= []).push(Number(mutation.seq));
    selectedFound = selectedFound || Number(mutation.seq) === seq;
  }
  if (!selectedFound) throw blocked('unsupported_lineage', 'selected mutation is outside the exact lineage');
  plan.snapshot = JSON.stringify([project, seq, canonical, lineage, enrollment, sessions, tombstones]);
  return plan;
}

/** Vista previa de solo lectura; el plan lleva una instantánea privada que debe seguir igual al aplicarlo. @throws {DiscardBlocker} */
export function planLegacyEmptyPromptDiscard(store, project, seq) {
  let plan = { project, selected_seq: seq, prompt_id: 0, sync_id: '', session_id: '', source_inbox_id: '', sequences: null };
  plan = store.db.readTransaction((db) => planInTransaction(db, project, seq));
  Object.defineProperty(plan, 'owner', { value: store, enumerable: false });
  return plan;
}

function validate(db, plan, store) {
  if (plan.owner !== store || !plan.snapshot) throw blocked('invalid_plan', 'plan must originate from this store');
  let current;
  try {
    current = planInTransaction(db, plan.project, plan.selected_seq);
  } catch (err) {
    if (err instanceof DiscardBlocker) throw blocked('stale_plan', `current eligibility changed: ${err.message}`);
    throw err;
  }
  if (JSON.stringify({ ...current }) !== JSON.stringify({ ...plan })) throw blocked('stale_plan', 'snapshot or public plan fields changed');
}

/** Copia consistente en la ruta indicada: debe ser nueva, con su carpeta existente y distinta del almacenamiento vivo. */
function backupTo(store, path) {
  if (goTrim(path ?? '') === '') throw blocked('backup_path_required', 'explicit backup path required');
  const absolute = resolve(path);
  let parent;
  try {
    parent = realpathSync(dirname(absolute));
  } catch (err) {
    throw new Error(`resolve backup parent: ${err.message}`);
  }
  const destination = join(parent, basename(absolute));
  const live = realpathSync(join(store.config.dataDir, 'odin.db'));
  for (const protectedPath of [live, `${live}-wal`, `${live}-shm`]) {
    if (destination.toLowerCase() === protectedPath.toLowerCase()) throw blocked('unsafe_backup_path', 'destination aliases live SQLite storage');
  }
  let exists = true;
  try {
    lstatSync(destination);
  } catch {
    exists = false;
  }
  if (exists) throw blocked('backup_collision', 'destination already exists, including symlinks');
  closeSync(openSync(destination, 'wx', 0o600));
  try {
    store.db.run(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  } catch (err) {
    throw new Error(`backup sqlite database: ${err.message}`);
  }
  return destination;
}

/**
 * Aplica el plan: respalda primero y vuelve a derivar la elegibilidad dentro de la única transacción de escritura.
 * @returns {{ status: string, sequences: number[], delete_seq: number, backup_path: string }}
 */
export function applyLegacyEmptyPromptDiscard(store, plan, backupPath) {
  const result = { status: '', sequences: [], delete_seq: 0, backup_path: '' };
  store.db.readTransaction((db) => validate(db, plan, store));
  try {
    result.backup_path = backupTo(store, backupPath);
  } catch (err) {
    err.result = result;
    throw err;
  }
  try {
    store.db.writeTransaction((db) => {
      validate(db, plan, store);
      const deletedAt = now();
      const evidence = JSON.stringify({
        project: plan.project, prompt_id: plan.prompt_id, sequences: plan.sequences, session_id: plan.session_id, snapshot_sha256: createHash('sha256').update(plan.snapshot).digest('hex'),
        source_inbox_id: plan.source_inbox_id, sync_id: plan.sync_id, trigger: DISCARD_REASON,
      });
      const retired = db.run(
        `UPDATE sync_mutations SET disposition = 'superseded', disposition_reason = ?, disposition_evidence = ?, disposition_at = datetime('now')
         WHERE target_key = ? AND entity = ? AND entity_key = ? AND project = ? AND op = ? AND source = ? AND acked_at IS NULL AND disposition = 'pending'`,
        DISCARD_REASON, evidence, DEFAULT_SYNC_TARGET_KEY, SYNC_ENTITY.prompt, plan.sync_id, plan.project, SYNC_OP_UPSERT, SYNC_SOURCE_LOCAL,
      );
      if (Number(retired.changes) === 0) throw blocked('stale_plan', 'no pending upsert was retired');
      recordLocalPromptTombstone(db, plan.prompt_id, plan.sync_id, plan.session_id, plan.project, plan.source_inbox_id, deletedAt);
      if (Number(db.run('DELETE FROM user_prompts WHERE id = ?', plan.prompt_id).changes) !== 1) throw blocked('stale_plan', 'canonical prompt changed');
      const payload = {
        ...(plan.source_inbox_id !== '' ? { source_inbox_id: plan.source_inbox_id } : {}), sync_id: plan.sync_id, session_id: plan.session_id, content: '', project: plan.project,
        deleted: true, deleted_at: deletedAt, hard_delete: true,
      };
      journalMutation(db, { entity: SYNC_ENTITY.prompt, entityKey: plan.sync_id, op: SYNC_OP_DELETE, project: plan.project, sessionId: plan.session_id, payload });
      result.delete_seq = Number(db.get('SELECT last_enqueued_seq AS n FROM sync_state WHERE target_key = ?', DEFAULT_SYNC_TARGET_KEY).n);
    });
  } catch (err) {
    err.result = result;
    result.delete_seq = 0;
    throw err;
  }
  result.status = 'delete_queued';
  result.sequences = [...plan.sequences];
  return result;
}

