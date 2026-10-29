import { normalizeProject } from '../project/canonical.js';
import { now } from '../timeutil/index.js';
import { StoreError, storeError } from './errors.js';
import { SELECT_COLUMNS, toObservation } from './observations.js';
import { recordPromptTombstone } from './prompts.js';
import { journalMutation, sessionProject, SYNC_ENTITY, SYNC_OP_DELETE } from './journal.js';
import { validSessionOwnershipMode, validateSessionId } from './sessions.js';
import { goTrim, hashNormalized, newSyncId, normalizeScope, normalizeTopicKey, nullableString } from './text.js';

// Copia de seguridad directa de toda la base (o de un proyecto): exportar y
// reimportar sesiones, observaciones, prompts, lápidas de prompts y relaciones.

/** Versión actual del formato de exportación y la anterior, que también se acepta. */
export const EXPORT_VERSION = '0.2.0';
export const LEGACY_EXPORT_VERSION = '0.1.0';

const PROJECT_OBSERVATION_SET = `
	SELECT sync_id FROM observations WHERE project = ?
	UNION ALL
	SELECT o.sync_id FROM sessions s
	JOIN observations o ON o.session_id = s.id
	WHERE s.project = ? AND (o.project IS NULL OR o.project = '')`;

/**
 * Exporta toda la base, o solo lo relevante para un proyecto normalizado.
 * @param {import('./store.js').Store} store
 * @param {string} [project] vacío = todo
 * @returns {object} `{ version, exported_at, sessions, observations, prompts, prompt_tombstones, relations }`
 */
export function exportData(store, project = '') {
  return store.db.readTransaction((db) => {
    const data = { version: EXPORT_VERSION, exported_at: now(), sessions: [], observations: [], prompts: [], prompt_tombstones: [], relations: [] };

    let sql = "SELECT id, ifnull(project, '') AS project, directory, ifnull(ownership_mode, '') AS ownership_mode, started_at, ended_at, summary FROM sessions";
    let args = [];
    if (project !== '') {
      sql += ` WHERE id IN (
			SELECT id FROM sessions WHERE project = ?
			UNION
			SELECT session_id FROM observations WHERE project = ?
			UNION
			SELECT session_id FROM user_prompts WHERE project = ?
		)`;
      args = [project, project, project];
    }
    data.sessions = db.all(`${sql} ORDER BY started_at`, ...args);

    sql = `SELECT ${SELECT_COLUMNS} FROM observations`;
    args = [];
    if (project !== '') {
      sql += ` WHERE id IN (SELECT id FROM observations WHERE project = ?
			UNION ALL
			SELECT o.id FROM sessions s JOIN observations o ON o.session_id = s.id
			WHERE s.project = ? AND (o.project IS NULL OR o.project = ''))`;
      args = [project, project];
    }
    data.observations = db.all(`${sql} ORDER BY id`, ...args).map(toObservation);

    sql = "SELECT id, ifnull(sync_id, '') AS sync_id, session_id, content, ifnull(project, '') AS project, created_at, ifnull(source_inbox_id, '') AS source_inbox_id FROM user_prompts";
    args = [];
    if (project !== '') {
      sql += ` WHERE id IN (SELECT id FROM user_prompts WHERE project = ?
			UNION ALL
			SELECT p.id FROM sessions s JOIN user_prompts p ON p.session_id = s.id
			WHERE s.project = ? AND (p.project IS NULL OR p.project = ''))`;
      args = [project, project];
    }
    data.prompts = db.all(`${sql} ORDER BY id`, ...args);

    const owner = "coalesce(nullif(t.project, ''), nullif(s.project, ''), (SELECT st.project FROM sync_delete_tombstones st WHERE st.entity = 'session' AND st.entity_key = t.session_id AND st.active = 1), '')";
    sql = `SELECT t.sync_id, ifnull(t.session_id, '') AS session_id, ${owner} AS project, ifnull(t.source_inbox_id, '') AS source_inbox_id, t.deleted_at FROM prompt_tombstones t LEFT JOIN sessions s ON s.id = t.session_id`;
    args = [];
    if (project !== '') {
      sql += ` WHERE ${owner} = ?`;
      args = [project];
    }
    data.prompt_tombstones = db.all(`${sql} ORDER BY t.sync_id`, ...args);

    // Las relaciones son metadatos de la copia directa: se leen aparte para conservar
    // todos los campos de juicio y sustitución.
    sql = `SELECT r.sync_id, ifnull(r.source_id, '') AS source_id, ifnull(r.target_id, '') AS target_id, r.relation,
		       r.reason, r.evidence, r.confidence, r.judgment_status,
		       r.marked_by_actor, r.marked_by_kind, r.marked_by_model, r.session_id,
		       r.superseded_at, superseding.sync_id AS superseded_by_relation_sync_id, r.created_at, r.updated_at
		FROM memory_relations r
		LEFT JOIN memory_relations superseding ON superseding.id = r.superseded_by_relation_id`;
    args = [];
    if (project !== '') {
      sql = `WITH project_observations AS (${PROJECT_OBSERVATION_SET})
			SELECT r.sync_id, ifnull(r.source_id, '') AS source_id, ifnull(r.target_id, '') AS target_id, r.relation,
			       r.reason, r.evidence, r.confidence, r.judgment_status,
			       r.marked_by_actor, r.marked_by_kind, r.marked_by_model, r.session_id,
			       r.superseded_at, superseding.sync_id AS superseded_by_relation_sync_id, r.created_at, r.updated_at
			FROM memory_relations r
			LEFT JOIN memory_relations superseding ON superseding.id = r.superseded_by_relation_id
			WHERE r.source_id IN (SELECT sync_id FROM project_observations)
			  AND r.target_id IN (SELECT sync_id FROM project_observations)`;
      args = [project, project];
    }
    data.relations = db.all(`${sql} ORDER BY r.created_at, r.sync_id`, ...args);
    return data;
  });
}

/**
 * Exporta lo relevante para un proyecto (normalizado y recortado).
 * @throws {Error} `project is required`
 */
export function exportProject(store, project) {
  const normalized = goTrim(normalizeProject(project ?? '').normalized);
  if (normalized === '') throw new StoreError('project_required', 'project is required');
  return exportData(store, normalized);
}

// ─── Forma JSON ──────────────────────────────────────────────────────────────

/** Copia solo las claves presentes y no nulas. */
function withOptional(target, source, keys) {
  for (const key of keys) {
    if (source[key] !== null && source[key] !== undefined) target[key] = source[key];
  }
  return target;
}

/**
 * La exportación con la forma exacta del formato: los campos opcionales se omiten si
 * son nulos, las listas obligatorias vacías son `null`, las opcionales vacías se omiten,
 * y cada observación lleva su estado `pinned`.
 * @param {object} data
 */
export function exportToJsonValue(data) {
  const out = { version: data.version, exported_at: data.exported_at };
  out.sessions = data.sessions.length === 0 ? null : data.sessions.map((s) => {
    const session = { id: s.id, project: s.project };
    if (s.ownership_mode) session.ownership_mode = s.ownership_mode;
    session.directory = s.directory;
    session.started_at = s.started_at;
    return withOptional(session, s, ['ended_at', 'summary']);
  });
  out.observations = data.observations.length === 0 ? null : data.observations.map((o) => {
    const obs = {
      id: o.id, sync_id: o.sync_id, session_id: o.session_id, type: o.type, title: o.title, content: o.content,
    };
    withOptional(obs, o, ['tool_name', 'project']);
    obs.scope = o.scope;
    withOptional(obs, o, ['topic_key']);
    obs.revision_count = o.revision_count;
    obs.duplicate_count = o.duplicate_count;
    withOptional(obs, o, ['last_seen_at', 'review_after', 'superseded_by_sync_id']);
    obs.created_at = o.created_at;
    obs.updated_at = o.updated_at;
    withOptional(obs, o, ['deleted_at']);
    obs.pinned = Boolean(o.pinned);
    return obs;
  });
  out.prompts = data.prompts.length === 0 ? null : data.prompts.map((p) => {
    const prompt = {};
    if (p.source_inbox_id) prompt.source_inbox_id = p.source_inbox_id;
    Object.assign(prompt, { id: p.id, sync_id: p.sync_id, session_id: p.session_id, content: p.content });
    if (p.project) prompt.project = p.project;
    prompt.created_at = p.created_at;
    return prompt;
  });
  if (data.relations.length > 0) {
    out.relations = data.relations.map((r) => {
      const rel = { sync_id: r.sync_id, source_id: r.source_id, target_id: r.target_id, relation: r.relation };
      withOptional(rel, r, ['reason', 'evidence', 'confidence']);
      rel.judgment_status = r.judgment_status;
      withOptional(rel, r, ['marked_by_actor', 'marked_by_kind', 'marked_by_model', 'session_id', 'superseded_at', 'superseded_by_relation_sync_id']);
      rel.created_at = r.created_at;
      rel.updated_at = r.updated_at;
      return rel;
    });
  }
  if (data.prompt_tombstones.length > 0) {
    out.prompt_tombstones = data.prompt_tombstones.map((t) => {
      const tombstone = { sync_id: t.sync_id, session_id: t.session_id };
      withOptional(tombstone, t, ['project']);
      if (t.source_inbox_id) tombstone.source_inbox_id = t.source_inbox_id;
      tombstone.deleted_at = t.deleted_at;
      return tombstone;
    });
  }
  return out;
}

/**
 * JSON como lo escribe el formato: `<`, `>`, `&`, U+2028 y U+2029 escapados y, con
 * `indent`, sangrado de esa anchura.
 * @param {unknown} value
 * @param {number} [indent]
 */
export function toGoJson(value, indent = 0) {
  return JSON.stringify(value, null, indent || undefined)
    .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

// ─── Lectura de una exportación ──────────────────────────────────────────────

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function fail(path, expected, value) {
  return new StoreError('invalid_export', `invalid export: ${path} must be ${expected}, got ${typeName(value)}`);
}

const text = (v, path, fallback = '') => {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') throw fail(path, 'a string', v);
  return v;
};
const optionalText = (v, path) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw fail(path, 'a string', v);
  return v;
};
const integer = (v, path, fallback = 0) => {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw fail(path, 'an integer', v);
  return v;
};
const list = (v, path) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw fail(path, 'an array', v);
  return v;
};
const object = (v, path) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw fail(path, 'an object', v);
  return v;
};

/**
 * Interpreta el texto JSON de una exportación (la actual o la 0.1.0, sin `pinned` ni
 * relaciones). El directorio de cada sesión, si está, debe ser una cadena.
 * @param {string} source
 * @returns {object} datos listos para `importData`
 * @throws {Error} JSON inválido, o un tipo que no corresponde
 */
export function parseExportData(source) {
  const raw = object(JSON.parse(source), 'export');
  const data = {
    version: text(raw.version, 'version'),
    exported_at: text(raw.exported_at, 'exported_at'),
    sessions: [], observations: [], prompts: [], relations: [], prompt_tombstones: [],
  };
  for (const [i, s] of list(raw.sessions, 'sessions').entries()) {
    const path = `sessions[${i}]`;
    object(s, path);
    const id = text(s.id, `${path}.id`);
    if (Object.hasOwn(s, 'directory') && typeof s.directory !== 'string') {
      throw new StoreError('invalid_export', `import session ${JSON.stringify(id)}: directory must be a JSON string`);
    }
    data.sessions.push({
      id, project: text(s.project, `${path}.project`), ownership_mode: text(s.ownership_mode, `${path}.ownership_mode`),
      directory: text(s.directory, `${path}.directory`), started_at: text(s.started_at, `${path}.started_at`),
      ended_at: optionalText(s.ended_at, `${path}.ended_at`), summary: optionalText(s.summary, `${path}.summary`),
    });
  }
  for (const [i, o] of list(raw.observations, 'observations').entries()) {
    const path = `observations[${i}]`;
    object(o, path);
    data.observations.push({
      id: integer(o.id, `${path}.id`), sync_id: text(o.sync_id, `${path}.sync_id`), session_id: text(o.session_id, `${path}.session_id`),
      type: text(o.type, `${path}.type`), title: text(o.title, `${path}.title`), content: text(o.content, `${path}.content`),
      tool_name: optionalText(o.tool_name, `${path}.tool_name`), project: optionalText(o.project, `${path}.project`),
      scope: text(o.scope, `${path}.scope`), topic_key: optionalText(o.topic_key, `${path}.topic_key`),
      revision_count: integer(o.revision_count, `${path}.revision_count`), duplicate_count: integer(o.duplicate_count, `${path}.duplicate_count`),
      last_seen_at: optionalText(o.last_seen_at, `${path}.last_seen_at`), review_after: optionalText(o.review_after, `${path}.review_after`),
      superseded_by_sync_id: optionalText(o.superseded_by_sync_id, `${path}.superseded_by_sync_id`),
      pinned: o.pinned === true, created_at: text(o.created_at, `${path}.created_at`), updated_at: text(o.updated_at, `${path}.updated_at`),
      deleted_at: optionalText(o.deleted_at, `${path}.deleted_at`),
    });
  }
  for (const [i, p] of list(raw.prompts, 'prompts').entries()) {
    const path = `prompts[${i}]`;
    object(p, path);
    data.prompts.push({
      id: integer(p.id, `${path}.id`), sync_id: text(p.sync_id, `${path}.sync_id`), session_id: text(p.session_id, `${path}.session_id`),
      content: text(p.content, `${path}.content`), project: text(p.project, `${path}.project`), created_at: text(p.created_at, `${path}.created_at`),
      source_inbox_id: text(p.source_inbox_id, `${path}.source_inbox_id`),
    });
  }
  for (const [i, t] of list(raw.prompt_tombstones, 'prompt_tombstones').entries()) {
    const path = `prompt_tombstones[${i}]`;
    object(t, path);
    data.prompt_tombstones.push({
      sync_id: text(t.sync_id, `${path}.sync_id`), session_id: text(t.session_id, `${path}.session_id`), project: optionalText(t.project, `${path}.project`),
      source_inbox_id: text(t.source_inbox_id, `${path}.source_inbox_id`), deleted_at: text(t.deleted_at, `${path}.deleted_at`),
    });
  }
  for (const [i, r] of list(raw.relations, 'relations').entries()) {
    const path = `relations[${i}]`;
    object(r, path);
    let confidence = null;
    if (r.confidence !== undefined && r.confidence !== null) {
      if (typeof r.confidence !== 'number') throw fail(`${path}.confidence`, 'a number', r.confidence);
      confidence = r.confidence;
    }
    data.relations.push({
      sync_id: text(r.sync_id, `${path}.sync_id`), source_id: text(r.source_id, `${path}.source_id`), target_id: text(r.target_id, `${path}.target_id`),
      relation: text(r.relation, `${path}.relation`), reason: optionalText(r.reason, `${path}.reason`), evidence: optionalText(r.evidence, `${path}.evidence`),
      confidence, judgment_status: text(r.judgment_status, `${path}.judgment_status`),
      marked_by_actor: optionalText(r.marked_by_actor, `${path}.marked_by_actor`), marked_by_kind: optionalText(r.marked_by_kind, `${path}.marked_by_kind`),
      marked_by_model: optionalText(r.marked_by_model, `${path}.marked_by_model`), session_id: optionalText(r.session_id, `${path}.session_id`),
      superseded_at: optionalText(r.superseded_at, `${path}.superseded_at`),
      superseded_by_relation_sync_id: optionalText(r.superseded_by_relation_sync_id, `${path}.superseded_by_relation_sync_id`),
      created_at: text(r.created_at, `${path}.created_at`), updated_at: text(r.updated_at, `${path}.updated_at`),
    });
  }
  return data;
}

// ─── Importación ─────────────────────────────────────────────────────────────

const TIMESTAMP_SPACE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const TIMESTAMP_RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const TIMESTAMP_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Marca de tiempo comparable (UTC, 9 decimales) o `''` si no se reconoce. Acepta
 * `YYYY-MM-DD HH:MM:SS[.f]`, RFC 3339 y `YYYY-MM-DD`.
 * @param {string} value
 */
export function normalizeComparableTimestamp(value) {
  const trimmed = goTrim(value ?? '');
  let m = TIMESTAMP_SPACE.exec(trimmed) ?? TIMESTAMP_RFC3339.exec(trimmed);
  let date = false;
  if (!m) {
    m = TIMESTAMP_DATE.exec(trimmed);
    date = true;
  }
  if (!m) return '';
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [hour, minute, second] = date ? [0, 0, 0] : [Number(m[4]), Number(m[5]), Number(m[6])];
  if (hour > 23 || minute > 59 || second > 59) return '';
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return '';
  let offsetMinutes = 0;
  const zone = date ? undefined : m[8];
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  }
  const fraction = ((date ? '' : m[7]) ?? '').slice(0, 9).padEnd(9, '0');
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}.${fraction}`;
}

/** Un upsert de prompt anterior (o sin fecha comparable) a la lápida no puede resucitar el prompt. */
export function isStalePromptUpsert(createdAt, tombstoneDeletedAt) {
  const upsert = normalizeComparableTimestamp(createdAt);
  const tombstone = normalizeComparableTimestamp(tombstoneDeletedAt);
  if (upsert === '' || tombstone === '') return true;
  return upsert <= tombstone;
}

/** Conserva el enlace de sustitución de una observación: el entrante, o el que ya había. */
export function preserveObservationProvenance(db, syncId, incoming) {
  let link = incoming;
  if (link === null || link === undefined || link === '') {
    link = db.get(
      `SELECT COALESCE(
  (SELECT superseded_by_sync_id FROM observations WHERE sync_id = ?),
  (SELECT superseded_by_sync_id FROM sync_delete_tombstones WHERE entity = 'observation' AND entity_key = ?)) AS link`,
      syncId, syncId,
    ).link;
  }
  db.run('UPDATE observations SET superseded_by_sync_id = ? WHERE sync_id = ?', link ?? null, syncId);
}

const existingSyncId = (existing, prefix) => (goTrim(existing ?? '') !== '' ? existing : newSyncId(prefix));
const dbBool = (v) => (v ? 1 : 0);

function importError(message) {
  return new StoreError('import_failed', message);
}

/**
 * Importa una exportación. Las sesiones y relaciones existentes se omiten; las
 * observaciones existentes solo se actualizan si la entrante es más reciente; los
 * identificadores numéricos se reasignan. Todo ocurre en una transacción: cualquier
 * conflicto revierte la importación entera.
 * @param {import('./store.js').Store} store
 * @param {object} data de `parseExportData`
 * @returns {{ sessions_imported: number, observations_imported: number, observations_updated: number, observations_skipped_stale: number, prompts_imported: number }}
 */
export function importData(store, data) {
  if (!data) throw importError('import: export data is required');
  if (data.version !== '' && data.version !== LEGACY_EXPORT_VERSION && data.version !== EXPORT_VERSION) {
    throw importError(`import: unsupported export version ${JSON.stringify(data.version)}`);
  }
  // Un directorio en blanco es una sesión local parcial legítima: se acepta tal cual.
  for (const sess of data.sessions) {
    try {
      validateSessionId(sess.id);
    } catch (err) {
      throw importError(`import session: ${err.message}`);
    }
    if (goTrim(sess.ownership_mode) !== '' && !validSessionOwnershipMode(sess.ownership_mode)) {
      throw importError(`import session ${sess.id}: invalid session ownership mode ${JSON.stringify(sess.ownership_mode)}`);
    }
  }

  return store.db.writeTransaction((db) => {
    const result = { sessions_imported: 0, observations_imported: 0, observations_updated: 0, observations_skipped_stale: 0, prompts_imported: 0 };

    for (const sess of data.sessions) {
      const res = db.run(
        `INSERT OR IGNORE INTO sessions (id, project, ownership_mode, directory, started_at, ended_at, summary)
         VALUES (?, ?, COALESCE(?, 'shared'), ?, ?, ?, ?)`,
        sess.id, sess.project, validSessionOwnershipMode(sess.ownership_mode) ? sess.ownership_mode : null, sess.directory, sess.started_at, sess.ended_at, sess.summary,
      );
      result.sessions_imported += Number(res.changes);
    }

    for (const obs of data.observations) {
      const syncId = existingSyncId(obs.sync_id, 'obs');
      const existing = db.get(`SELECT ${SELECT_COLUMNS} FROM observations WHERE sync_id = ? ORDER BY id DESC LIMIT 1`, syncId);
      const scope = normalizeScope(obs.scope);
      const topicKey = nullableString(normalizeTopicKey(obs.topic_key ?? ''));
      if (existing) {
        // Las instantáneas se ordenan por fecha: sin una fecha comparable no se sabe si la
        // entrante es más nueva, así que la fila local queda intacta.
        const incoming = normalizeComparableTimestamp(obs.updated_at);
        const current = normalizeComparableTimestamp(existing.updated_at);
        if (incoming === '' || current === '' || incoming <= current) {
          result.observations_skipped_stale++;
          continue;
        }
        const createdAt = normalizeComparableTimestamp(obs.created_at) === '' ? existing.created_at : obs.created_at;
        const revisionCount = obs.revision_count <= 0 ? existing.revision_count : obs.revision_count;
        const duplicateCount = obs.duplicate_count <= 0 ? existing.duplicate_count : obs.duplicate_count;
        db.run(
          `UPDATE observations SET session_id = ?, type = ?, title = ?, content = ?, tool_name = CAST(? AS TEXT), project = ?, scope = ?, topic_key = ?, normalized_hash = ?, revision_count = ?, duplicate_count = ?, last_seen_at = ?, review_after = ?, pinned = ?, created_at = ?, updated_at = ?, deleted_at = ? WHERE id = ?`,
          obs.session_id, obs.type, obs.title, obs.content, obs.tool_name, obs.project, scope, topicKey, hashNormalized(obs.content),
          revisionCount, duplicateCount, obs.last_seen_at, obs.review_after, dbBool(obs.pinned), createdAt, obs.updated_at, obs.deleted_at, existing.id,
        );
        preserveObservationProvenance(db, syncId, obs.superseded_by_sync_id);
        result.observations_updated++;
        continue;
      }
      const res = db.run(
        `INSERT INTO observations (sync_id, session_id, type, title, content, tool_name, project, scope, topic_key, normalized_hash, revision_count, duplicate_count, last_seen_at, review_after, pinned, created_at, updated_at, deleted_at)
         SELECT ?, ?, ?, ?, ?, ?, CAST(? AS TEXT), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM observations WHERE sync_id = ?)`,
        syncId, obs.session_id, obs.type, obs.title, obs.content, obs.tool_name, obs.project, scope, topicKey, hashNormalized(obs.content),
        Math.max(obs.revision_count, 1), Math.max(obs.duplicate_count, 1), obs.last_seen_at, obs.review_after, dbBool(obs.pinned),
        obs.created_at, obs.updated_at, obs.deleted_at, syncId,
      );
      preserveObservationProvenance(db, syncId, obs.superseded_by_sync_id);
      result.observations_imported += Number(res.changes);
    }

    // Se restauran las identidades de borrado antes de admitir los prompts de la copia.
    for (const tombstone of data.prompt_tombstones) {
      if (tombstone.sync_id === '') throw importError('import prompt tombstone: sync id is required');
      if (tombstone.source_inbox_id !== '' && goTrim(tombstone.session_id) === '') {
        throw importError(`import prompt tombstone ${JSON.stringify(tombstone.sync_id)}: session id is required for source inbox id`);
      }
      const established = db.get("SELECT ifnull(session_id, '') AS session_id, ifnull(source_inbox_id, '') AS source_inbox_id FROM prompt_tombstones WHERE sync_id = ?", tombstone.sync_id);
      if (
        established &&
        ((tombstone.session_id !== '' && established.session_id !== '' && tombstone.session_id !== established.session_id) ||
          (tombstone.source_inbox_id !== '' && established.source_inbox_id !== '' && tombstone.source_inbox_id !== established.source_inbox_id))
      ) {
        throw new StoreError('pulled_prompt_identity_invalid', `import prompt tombstone ${JSON.stringify(tombstone.sync_id)}: pulled prompt identity is invalid`);
      }
      const matched = db.all(
        `SELECT p.sync_id, p.session_id, ifnull(p.project, '') AS project, ifnull(p.source_inbox_id, '') AS inbox_id, ifnull(s.project, '') AS session_project
         FROM user_prompts p LEFT JOIN sessions s ON s.id = p.session_id
         WHERE p.sync_id = ? OR (? != '' AND p.session_id = ? AND p.source_inbox_id = ?)`,
        tombstone.sync_id, tombstone.source_inbox_id, tombstone.session_id, tombstone.source_inbox_id,
      );
      for (const prompt of matched) {
        const owner = normalizeProject(goTrim(prompt.project) === '' ? prompt.session_project : prompt.project).normalized;
        const incomingOwner = normalizeProject(goTrim(tombstone.project ?? '') === '' ? prompt.session_project : tombstone.project).normalized;
        if (owner !== incomingOwner) {
          throw new StoreError('pulled_prompt_identity_invalid', `import prompt tombstone ${JSON.stringify(tombstone.sync_id)}: pulled prompt identity is invalid: project ownership conflict`);
        }
        let project = normalizeProject(prompt.project).normalized;
        if (project === '') project = sessionProject(db, prompt.session_id);
        db.run('DELETE FROM user_prompts WHERE sync_id = ?', prompt.sync_id);
        recordPromptTombstone(db, prompt.sync_id, prompt.session_id, nullableString(project), prompt.inbox_id, tombstone.deleted_at);
        journalMutation(db, {
          entity: SYNC_ENTITY.prompt,
          entityKey: prompt.sync_id,
          op: SYNC_OP_DELETE,
          project,
          sessionId: prompt.session_id,
          payload: () => ({
            sync_id: prompt.sync_id, session_id: prompt.session_id, source_inbox_id: prompt.inbox_id, project: nullableString(project), deleted: true, hard_delete: true, deleted_at: tombstone.deleted_at,
          }),
        });
      }
      recordPromptTombstone(db, tombstone.sync_id, tombstone.session_id, tombstone.project, tombstone.source_inbox_id, tombstone.deleted_at);
    }

    for (const p of data.prompts) {
      if (p.source_inbox_id !== '') {
        const deleted = db.get('SELECT EXISTS(SELECT 1 FROM prompt_tombstones WHERE session_id = ? AND source_inbox_id = ?) AS deleted', p.session_id, p.source_inbox_id).deleted;
        if (deleted === 1) continue;
      }
      const syncId = existingSyncId(p.sync_id, 'prompt');
      const tombstone = db.get("SELECT deleted_at, ifnull(source_inbox_id, '') AS source_inbox_id FROM prompt_tombstones WHERE sync_id = ?", syncId);
      if (tombstone) {
        if (tombstone.source_inbox_id !== '' || isStalePromptUpsert(p.created_at, tombstone.deleted_at)) continue;
        db.run('DELETE FROM prompt_tombstones WHERE sync_id = ?', syncId);
      }
      if (p.source_inbox_id !== '') {
        const found = db.get(
          `SELECT p.id, p.session_id, ifnull(p.source_inbox_id, '') AS identity, ifnull(p.project, '') AS project, ifnull(s.project, '') AS session_project
           FROM user_prompts p LEFT JOIN sessions s ON s.id = p.session_id WHERE p.sync_id = ? ORDER BY p.id DESC LIMIT 1`,
          syncId,
        );
        if (found) {
          let localProject = goTrim(found.project);
          let incomingProject = goTrim(p.project);
          if (localProject === '') localProject = goTrim(found.session_project);
          if (incomingProject === '') incomingProject = goTrim(found.session_project);
          localProject = normalizeProject(localProject).normalized;
          incomingProject = normalizeProject(incomingProject).normalized;
          if (found.session_id !== p.session_id || localProject !== incomingProject || (found.identity !== '' && found.identity !== p.source_inbox_id)) {
            throw importError(`import prompt ${p.id}: conflicting inbox identity`);
          }
          if (found.identity === '') {
            const res = db.run(
              `UPDATE user_prompts SET source_inbox_id = ? WHERE id = ? AND (source_inbox_id IS NULL OR source_inbox_id = '')
               AND NOT EXISTS (SELECT 1 FROM user_prompts WHERE session_id = ? AND source_inbox_id = ?)`,
              p.source_inbox_id, found.id, p.session_id, p.source_inbox_id,
            );
            if (Number(res.changes) !== 1) throw importError(`import prompt ${p.id}: inbox identity already owned`);
            journalMutation(db, {
              entity: SYNC_ENTITY.prompt,
              entityKey: syncId,
              op: 'upsert',
              project: localProject,
              payload: () => {
                const adopted = db.get('SELECT sync_id, session_id, content, created_at, source_inbox_id FROM user_prompts WHERE id = ?', found.id);
                return { ...adopted, project: nullableString(localProject) };
              },
            });
          }
        }
      }
      const res = db.run(
        `INSERT INTO user_prompts (sync_id, session_id, content, project, created_at, source_inbox_id)
         SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM user_prompts WHERE sync_id = ? OR (session_id = ? AND source_inbox_id = ?))`,
        syncId, p.session_id, p.content, p.project, p.created_at, nullableString(p.source_inbox_id), syncId, p.session_id, nullableString(p.source_inbox_id),
      );
      result.prompts_imported += Number(res.changes);
    }

    // Las relaciones se importan al final, con todos los extremos ya escritos; un extremo
    // ausente revierte la importación salvo en las relaciones huérfanas (auditoría).
    const imported = new Map();
    for (const relation of data.relations) {
      if (goTrim(relation.sync_id) === '') throw importError('import relation: sync id is required');
      let status = relation.judgment_status;
      if (goTrim(status).toLowerCase() === 'orphaned') status = 'orphaned';
      for (const [role, endpoint] of [['source', relation.source_id], ['target', relation.target_id]]) {
        if (goTrim(endpoint) === '') throw importError(`import relation ${relation.sync_id}: relation endpoint ${role} is required`);
        const exists = db.get('SELECT EXISTS(SELECT 1 FROM observations WHERE sync_id = ?) AS found', endpoint).found === 1;
        if (!exists && status !== 'orphaned') throw importError(`import relation ${relation.sync_id}: relation endpoint ${role} not found`);
      }
      const res = db.run(
        `INSERT OR IGNORE INTO memory_relations
          (sync_id, source_id, target_id, relation, reason, evidence, confidence, judgment_status,
           marked_by_actor, marked_by_kind, marked_by_model, session_id, superseded_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        relation.sync_id, relation.source_id, relation.target_id, relation.relation, relation.reason, relation.evidence, relation.confidence, status,
        relation.marked_by_actor, relation.marked_by_kind, relation.marked_by_model, relation.session_id, relation.superseded_at,
        relation.created_at, relation.updated_at,
      );
      imported.set(relation.sync_id, Number(res.changes) === 1);
    }
    for (const relation of data.relations) {
      if (relation.superseded_by_relation_sync_id === null) continue;
      const superseding = db.get('SELECT id FROM memory_relations WHERE sync_id = ?', relation.superseded_by_relation_sync_id);
      if (!superseding) {
        throw importError(`import relation ${relation.sync_id}: superseding relation ${relation.superseded_by_relation_sync_id} not found`);
      }
      if (!imported.get(relation.sync_id)) continue;
      db.run('UPDATE memory_relations SET superseded_by_relation_id = ? WHERE sync_id = ?', superseding.id, relation.sync_id);
    }
    return result;
  });
}
