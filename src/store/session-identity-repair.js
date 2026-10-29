import { createHash } from 'node:crypto';
import { normalizeProject } from '../project/canonical.js';
import { validateSyncMutationPayload } from './diagnostic.js';
import { SYNC_ENTITY, SYNC_OP_UPSERT } from './journal.js';
import { backupSqlite } from './repair.js';
import { DEFAULT_SYNC_TARGET_KEY } from './schema.js';
import { refreshProjectSyncLifecycle, refreshSyncLifecycle } from './sync-queue.js';
import { goTrim } from './text.js';

/**
 * Sustituye la identidad en blanco de una sesión por un identificador canónico: copia la sesión, reasigna sus observaciones y
 * prompts, retira sus mutaciones pendientes y, si el proyecto está inscrito, publica las mutaciones corregidas.
 */

const MIGRATION_REASON = 'session_identity_migrated';
const fail = (message) => new Error(message);
const omitNull = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null && v !== undefined && v !== ''));

/** Pares clave/valor (texto crudo) del nivel superior de un objeto JSON; permite ver claves repetidas. */
function topLevelEntries(raw) {
  const entries = [];
  let i = raw.indexOf('{');
  if (i < 0) throw fail('not a JSON object');
  i++;
  const skipSpace = () => { while (/\s/.test(raw[i] ?? '')) i++; };
  const readString = () => {
    const start = i;
    i++;
    while (i < raw.length && raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
    i++;
    return raw.slice(start, i);
  };
  for (;;) {
    skipSpace();
    if (raw[i] === '}') return entries;
    if (raw[i] === ',') { i++; continue; }
    const key = JSON.parse(readString());
    skipSpace();
    i++; // :
    skipSpace();
    const start = i;
    let depth = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '"') { readString(); continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { if (depth === 0) break; depth--; } else if (c === ',' && depth === 0) break;
      i++;
    }
    entries.push([key, raw.slice(start, i).trim()]);
  }
}

function shadowedSource(raw, identifier, source) {
  let entries;
  try {
    entries = topLevelEntries(raw);
  } catch {
    return false;
  }
  let seen = false;
  let count = 0;
  for (const [key, value] of entries) {
    if (key.toLowerCase() !== identifier.toLowerCase()) continue;
    count++;
    try {
      if (JSON.parse(value) === source) seen = true;
    } catch {
      // valor ilegible
    }
  }
  return count > 1 && seen;
}

const decode = (raw) => {
  let value = JSON.parse(raw);
  if (typeof value === 'string') value = JSON.parse(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(`json: cannot unmarshal ${Array.isArray(value) ? 'array' : typeof value} into Go value of type struct`);
  return value;
};

function inspectBlockers(db, source, replacement, project, evidence) {
  const checks = [
    ['linked deferred key', "SELECT count(*) AS n FROM sync_apply_deferred WHERE (entity='session' AND entity_key=?) OR (entity='observation' AND entity_key IN (SELECT sync_id FROM observations WHERE session_id=?)) OR (entity='prompt' AND entity_key IN (SELECT sync_id FROM user_prompts WHERE session_id=?))", [source, source, source]],
    ['prompt tombstones', 'SELECT count(*) AS n FROM prompt_tombstones WHERE session_id=? OR sync_id IN (SELECT sync_id FROM user_prompts WHERE session_id=?)', [source, source]],
    ['delete tombstones', "SELECT count(*) AS n FROM sync_delete_tombstones WHERE session_id=? OR (entity='session' AND entity_key IN (?,?)) OR (entity='observation' AND entity_key IN (SELECT sync_id FROM observations WHERE session_id=?))", [source, source, replacement, source]],
    ['remote floors', "SELECT count(*) AS n FROM sync_delete_tombstone_remote_floors WHERE (entity='session' AND entity_key IN (?,?)) OR (entity='observation' AND entity_key IN (SELECT sync_id FROM observations WHERE session_id=?))", [source, replacement, source]],
    ['duplicate observation identity', 'SELECT count(*) AS n FROM observations WHERE sync_id IN (SELECT sync_id FROM observations WHERE session_id=?) AND session_id<>?', [source, source]],
    ['duplicate prompt identity', 'SELECT count(*) AS n FROM user_prompts WHERE sync_id IN (SELECT sync_id FROM user_prompts WHERE session_id=?) AND session_id<>?', [source, source]],
  ];
  for (const [name, sql, params] of checks) {
    const n = Number(db.get(sql, ...params).n);
    if (n !== 0) throw fail(`session identity blocked by ${name} (${n})`);
    evidence.push(n);
  }
  for (const row of db.all('SELECT sync_id, project, payload FROM sync_apply_deferred ORDER BY sync_id')) {
    let payload;
    try {
      payload = decode(row.payload);
    } catch (err) {
      if (row.project === project || row.project === '') throw fail(`ambiguous deferred payload ${JSON.stringify(row.sync_id)}: ${err.message}`);
      continue;
    }
    if ('session_id' in payload && (typeof payload.session_id !== 'string' || row.project === project || payload.session_id === source)) {
      throw fail(`session identity blocked by deferred payload ${JSON.stringify(row.sync_id)}`);
    }
  }
}

function inspect(db, source, replacement) {
  if (goTrim(source) !== '' || goTrim(replacement) === '' || source === replacement) throw fail('invalid session identity repair IDs');
  const sessionRow = db.get(
    "SELECT ifnull(project,'') AS project, ifnull(ownership_mode,'') AS mode, directory, started_at, ended_at, summary, runtime_lease_expires_at AS lease, local_creation_project AS creation FROM sessions WHERE id=?", source,
  );
  if (!sessionRow) throw fail('session identity source: sql: no rows in result set');
  const project = sessionRow.project;
  if (goTrim(project) === '' || normalizeProject(project).normalized !== project || goTrim(sessionRow.directory ?? '') === '') throw fail('session identity source lacks canonical project or directory');
  if (Number(db.get('SELECT count(*) AS n FROM sessions WHERE id=?', replacement).n) !== 0) throw fail('replacement session identity already exists');
  const session = omitNull({
    id: replacement, project, ownership_mode: sessionRow.mode, directory: sessionRow.directory, started_at: sessionRow.started_at, ended_at: sessionRow.ended_at, summary: sessionRow.summary,
  });
  const evidence = [source, replacement, project, sessionRow.mode, sessionRow.directory, sessionRow.started_at, sessionRow.ended_at, sessionRow.summary, sessionRow.lease, sessionRow.creation];
  const observations = [];
  for (const o of db.all(
    `SELECT id, ifnull(sync_id,'') AS sync_id, session_id, type, title, content, tool_name, project, scope, topic_key, normalized_hash, revision_count, duplicate_count, last_seen_at, pinned,
            created_at, updated_at, deleted_at FROM observations WHERE session_id=? ORDER BY id`, source,
  )) {
    evidence.push(Object.values(o));
    if (o.deleted_at != null || o.sync_id === '' || (o.project ?? '') !== project || o.session_id !== source) throw fail(`unsafe observation source ${o.id}`);
    const payload = omitNull({
      sync_id: o.sync_id, session_id: replacement, type: o.type, title: o.title, content: o.content, tool_name: o.tool_name, project, scope: o.scope, topic_key: o.topic_key,
      last_seen_at: o.last_seen_at, created_at: o.created_at, updated_at: o.updated_at,
    });
    payload.revision_count = Number(o.revision_count);
    payload.duplicate_count = Number(o.duplicate_count);
    const validation = validateSyncMutationPayload(SYNC_ENTITY.observation, SYNC_OP_UPSERT, JSON.stringify(payload), o.sync_id);
    if (validation.reason_code) throw fail(`observation ${o.id} cannot be published: ${validation.message}`);
    observations.push(payload);
  }
  const prompts = [];
  for (const p of db.all("SELECT id, ifnull(sync_id,'') AS sync_id, session_id, content, project, created_at FROM user_prompts WHERE session_id=? ORDER BY id", source)) {
    evidence.push(Object.values(p));
    if (p.sync_id === '' || (p.project ?? '') !== project || p.session_id !== source) throw fail(`unsafe prompt source ${p.id}`);
    const payload = omitNull({ sync_id: p.sync_id, session_id: replacement, content: p.content, project, created_at: p.created_at });
    const validation = validateSyncMutationPayload(SYNC_ENTITY.prompt, SYNC_OP_UPSERT, JSON.stringify(payload), p.sync_id);
    if (validation.reason_code) throw fail(`prompt ${p.id} cannot be published: ${validation.message}`);
    prompts.push(payload);
  }
  if (Number(db.get('SELECT count(*) AS n FROM memory_relations WHERE session_id=?', source).n) !== 0) throw fail('session identity has relation references (not safely publishable)');
  inspectBlockers(db, source, replacement, project, evidence);
  const mutations = inspectMutations(db, source, project, observations, prompts, evidence);
  const enrolled = Number(db.get('SELECT EXISTS(SELECT 1 FROM sync_enrolled_projects WHERE project=?) AS n', project).n) === 1;
  evidence.push(enrolled);
  const plan = { source_id: source, replacement_id: replacement, project, observations: observations.length, prompts: prompts.length, retired_mutations: mutations.length, enrolled };
  Object.defineProperty(plan, 'fingerprint', { value: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'), enumerable: false });
  return { plan, session, observations, prompts, mutations };
}

function inspectMutations(db, source, project, observations, prompts, evidence) {
  const observationKeys = new Set(observations.map((o) => o.sync_id));
  const promptKeys = new Set(prompts.map((p) => p.sync_id));
  const retired = [];
  for (const m of db.all(
    `SELECT seq, entity, entity_key, op, payload, source, project, acked_at, disposition, target_key, occurred_at, disposition_reason, disposition_evidence, disposition_at FROM sync_mutations ORDER BY seq`,
  )) {
    const seq = Number(m.seq);
    let linked = false;
    let valid = false;
    const identifier = m.entity === SYNC_ENTITY.session ? 'id' : [SYNC_ENTITY.observation, SYNC_ENTITY.prompt, SYNC_ENTITY.relation].includes(m.entity) ? 'session_id' : '';
    if (identifier !== '' && shadowedSource(m.payload, identifier, source)) throw fail(`ambiguous ${m.entity} mutation ${seq}: shadowed source identity`);
    const parse = (label, isLinked) => {
      try {
        return JSON.parse(m.payload);
      } catch (err) {
        if (isLinked) throw fail(`ambiguous ${label} mutation ${seq}: ${err.message}`);
        return undefined;
      }
    };
    if (m.entity === SYNC_ENTITY.session) {
      linked = m.entity_key === source;
      const payload = parse('session', linked);
      if (payload === undefined) continue;
      linked = linked || payload.id === source;
      valid = m.entity_key === source && payload.id === source && payload.project === project && !payload.deleted && !payload.hard_delete;
    } else if (m.entity === SYNC_ENTITY.observation) {
      linked = observationKeys.has(m.entity_key);
      const payload = parse('observation', linked);
      if (payload === undefined) continue;
      linked = linked || payload.session_id === source;
      valid = observationKeys.has(m.entity_key) && payload.sync_id === m.entity_key && payload.session_id === source && payload.project === project && !payload.deleted && !payload.hard_delete;
    } else if (m.entity === SYNC_ENTITY.prompt) {
      linked = promptKeys.has(m.entity_key);
      const payload = parse('prompt', linked);
      if (payload === undefined) continue;
      linked = linked || payload.session_id === source;
      valid = promptKeys.has(m.entity_key) && payload.sync_id === m.entity_key && payload.session_id === source && payload.project === project && !payload.deleted && !payload.hard_delete;
    } else if (m.entity === SYNC_ENTITY.relation) {
      let payload;
      try {
        payload = JSON.parse(m.payload);
      } catch (err) {
        if (m.project === project) throw fail(`ambiguous relation mutation ${seq}: ${err.message}`);
        continue;
      }
      if (payload?.session_id === source) throw fail(`linked relation mutation ${seq} cannot be repaired`);
    }
    if (!linked) continue;
    evidence.push(Object.values(m));
    if (m.target_key !== DEFAULT_SYNC_TARGET_KEY || m.project !== project || m.source !== 'local' || m.op !== SYNC_OP_UPSERT || m.acked_at != null || m.disposition !== 'pending'
      || m.disposition_reason != null || m.disposition_evidence != null || m.disposition_at != null || !valid) throw fail(`unsafe linked mutation ${seq}`);
    retired.push(seq);
  }
  return retired;
}

/** Plan de solo lectura del efecto de sustituir una identidad en blanco. @throws {Error} si no es seguro */
export function planSessionIdentityRepair(store, sourceId, replacementId) {
  return store.db.readTransaction((db) => inspect(db, sourceId, replacementId)).plan;
}

const expectRows = (result, expected, action) => {
  if (Number(result.changes) !== expected) throw fail(`${action}: affected ${result.changes} rows, expected ${expected}`);
};

function append(db, entity, key, project, payload) {
  const insert = db.run(
    "INSERT INTO sync_mutations(target_key,entity,entity_key,op,payload,source,project) VALUES (?,?,?,?,?,'local',?)", DEFAULT_SYNC_TARGET_KEY, entity, key, SYNC_OP_UPSERT, JSON.stringify(payload), project,
  );
  expectRows(insert, 1, 'append repaired mutation');
  expectRows(db.run("UPDATE sync_state SET lifecycle='pending', last_enqueued_seq=?, updated_at=datetime('now') WHERE target_key=?", Number(insert.lastInsertRowid), DEFAULT_SYNC_TARGET_KEY), 1, 'update cloud sync state');
}

/** Aplica el plan tras una copia de la base; si la evidencia cambió desde el plan, se rechaza. */
export function applySessionIdentityRepair(store, plan) {
  if (!plan?.fingerprint) throw fail('session identity repair requires a store plan');
  const backup = backupSqlite(store);
  const result = { ...plan, backup_path: backup, published_mutations: 0 };
  store.db.writeTransaction((db) => {
    result.published_mutations = 0;
    const current = inspect(db, plan.source_id, plan.replacement_id);
    if (current.plan.fingerprint !== plan.fingerprint) throw fail('session identity repair evidence changed since plan');
    Object.assign(result, current.plan);
    expectRows(db.run(
      `INSERT INTO sessions(id,project,ownership_mode,directory,started_at,ended_at,summary,runtime_lease_expires_at,local_creation_project)
       SELECT ?,project,ownership_mode,directory,started_at,ended_at,summary,runtime_lease_expires_at,local_creation_project FROM sessions WHERE id=?`, plan.replacement_id, plan.source_id,
    ), 1, 'insert canonical session');
    expectRows(db.run('UPDATE observations SET session_id=? WHERE session_id=?', plan.replacement_id, plan.source_id), current.plan.observations, 'remap observations');
    expectRows(db.run('UPDATE user_prompts SET session_id=? WHERE session_id=?', plan.replacement_id, plan.source_id), current.plan.prompts, 'remap user_prompts');
    for (const seq of current.mutations) {
      expectRows(db.run(
        `UPDATE sync_mutations SET disposition='superseded', disposition_reason=?, disposition_evidence=?, disposition_at=datetime('now')
         WHERE seq=? AND target_key=? AND source=? AND op=? AND disposition='pending' AND acked_at IS NULL`,
        MIGRATION_REASON, `replacement_id=${JSON.stringify(plan.replacement_id)}`, seq, DEFAULT_SYNC_TARGET_KEY, 'local', SYNC_OP_UPSERT,
      ), 1, `retire journal seq ${seq}`);
    }
    expectRows(db.run('DELETE FROM sessions WHERE id=?', plan.source_id), 1, 'remove legacy session');
    if (current.plan.enrolled) {
      append(db, SYNC_ENTITY.session, current.session.id, current.session.project, current.session);
      result.published_mutations++;
      for (const o of current.observations) {
        append(db, SYNC_ENTITY.observation, o.sync_id, current.session.project, o);
        result.published_mutations++;
      }
      for (const p of current.prompts) {
        append(db, SYNC_ENTITY.prompt, p.sync_id, current.session.project, p);
        result.published_mutations++;
      }
    }
    refreshSyncLifecycle(db, DEFAULT_SYNC_TARGET_KEY);
    refreshProjectSyncLifecycle(db, current.plan.project);
  });
  return result;
}

/**
 * Elige la única fuente diagnosticada y planifica su sustitución. Devuelve el plan de reparación actualizado.
 */
export function planSessionIdentityReplacement(store, report, plan, sourceId, sourceSelected, replacementId) {
  const sources = [];
  for (const check of report.checks ?? []) {
    for (const finding of check.findings ?? []) {
      if (finding.reason_code !== 'invalid_session_identity') continue;
      const evidence = finding.evidence ?? {};
      if (!sourceSelected || evidence.session_id === sourceId) sources.push(evidence.session_id);
    }
  }
  if (sources.length !== 1) {
    plan.status = 'blocked';
    (plan.blockers ??= []).push({ reason_code: 'ambiguous_or_missing_source', message: "select one exact source with --source-id (use --source-id '' for the empty identity)" });
    return plan;
  }
  let removed = false;
  plan.skipped = plan.skipped.filter((s) => {
    if (!removed && s.reason_code === 'cannot_repair_without_explicit_canonical_session_id' && s.session_id === sources[0]) {
      removed = true;
      return false;
    }
    return true;
  });
  let identity;
  try {
    identity = planSessionIdentityRepair(store, sources[0], replacementId);
  } catch (err) {
    plan.status = 'blocked';
    (plan.blockers ??= []).push({ session_id: sources[0], reason_code: 'identity_repair_blocked', message: err.message });
    return plan;
  }
  plan.identity_repair = identity;
  plan.counts.sessions_planned = 1;
  plan.counts.observations_planned = identity.observations;
  plan.counts.prompts_planned = identity.prompts;
  if (identity.enrolled) plan.counts.corrected_mutations_planned = 1 + identity.observations + identity.prompts;
  return plan;
}
