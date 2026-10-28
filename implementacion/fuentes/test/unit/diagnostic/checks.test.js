import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../../../src/diagnostic/index.js';
import { REASON_FOREIGN_SYNC_TARGET, safeNextStepForForeignSyncTarget, syncMutationRequiredFieldsRepairHint } from '../../../src/diagnostic/checks.js';
import { decideSessionProjectAuthority, manualSessionNameTarget } from '../../../src/diagnostic/evidence.js';
import { addObservation, createSession } from '../../../src/store/index.js';
import { openTempStore } from '../store/helpers.js';

const run = (store, code, scope = {}) => new Runner().runOne({ store, project: '', ...scope }, code);
const only = (report) => report.checks[0];

function mutation(store, fields) {
  const m = { target_key: 'cloud', entity: 'observation', entity_key: 'obs-1', op: 'upsert', payload: '{}', project: 'demo', disposition: 'pending', ...fields };
  store.db.run('INSERT OR IGNORE INTO sync_state (target_key) VALUES (?)', m.target_key);
  store.db.run(
    `INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, disposition, disposition_reason, disposition_evidence, disposition_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    m.target_key, m.entity, m.entity_key, m.op, m.payload, m.project, m.disposition, m.reason ?? null, m.evidence ?? null, m.at ?? null,
  );
  if (m.acked_at) store.db.run('UPDATE sync_mutations SET acked_at = ? WHERE seq = last_insert_rowid()', m.acked_at);
}

test('un almacén vacío pasa todos los chequeos', (t) => {
  const store = openTempStore(t);
  const report = new Runner().runAll({ store, project: '' });
  assert.equal(report.status, 'ok');
  assert.deepEqual(only(run(store, 'unowned_session_project')).evidence, { sessions_evaluated: 0 });
  assert.deepEqual(only(run(store, 'sync_target_closed_space')).evidence, { enrolled_projects: 0, sync_targets_evaluated: 2 });
});

test('unowned_session_project: sin proyecto o con modo inválido, sin acotar por proyecto', (t) => {
  const store = openTempStore(t);
  createSession(store, 'ok', 'demo', '/x');
  createSession(store, 'propia', 'demo', '/p', 'project_owned');
  createSession(store, 'sin-modo', 'demo', '/y');
  store.db.run("UPDATE sessions SET ownership_mode = 'raro' WHERE id = 'sin-modo'");
  createSession(store, 'sin-proyecto', 'tmp', '/z');
  store.db.run("UPDATE sessions SET project = '', ownership_mode = NULL WHERE id = 'sin-proyecto'");
  const result = only(run(store, 'unowned_session_project', { project: 'demo' }));
  assert.equal(result.result, 'warning');
  assert.deepEqual(result.findings.map((f) => f.evidence.session_id).sort(), ['sin-modo', 'sin-proyecto']);
  assert.deepEqual(Object.keys(result.findings[0].evidence), ['directory', 'ownership_mode', 'session_id', 'session_project']);
  assert.match(result.findings.find((f) => f.evidence.session_id === 'sin-modo').safe_next_step, /^Assign ownership with `odin projects rescue-ownership --project <name> --session sin-modo` after confirming/);
  assert.equal(result.findings[0].requires_confirmation, true);
});

test('orphaned_observation_session informa la referencia sin exponer contenido', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  const id = addObservation(store, { session_id: 's1', type: 'manual', title: 'secreto', content: 'contenido privado', project: 'demo' }).id;
  store.db.run('PRAGMA foreign_keys = OFF');
  store.db.run("UPDATE observations SET session_id = 'perdida' WHERE id = ?", id);
  const result = only(run(store, 'orphaned_observation_session'));
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].message, '1 observation(s) reference missing session "perdida".');
  assert.ok(!JSON.stringify(result).includes('privado'));
  assert.equal(only(run(store, 'orphaned_observation_session', { project: 'otro' })).result, 'ok');
});

test('orphaned_pending_relations: resumen con muestra acotada a diez', (t) => {
  const store = openTempStore(t);
  for (let i = 0; i < 12; i++) {
    store.db.run("INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status) VALUES (?, 'x', 'y', 'related', 'pending')", `rel-${String(i).padStart(2, '0')}`);
  }
  const result = only(run(store, 'orphaned_pending_relations', { project: 'ignorado' }));
  const evidence = result.findings[0].evidence;
  assert.deepEqual(Object.keys(evidence), ['candidate_count', 'live_pending', 'one_endpoint_missing', 'sample']);
  assert.equal(evidence.candidate_count, 12);
  assert.equal(evidence.sample.length, 10);
  assert.equal(result.findings[0].message, '12 pending relation(s) reference missing observations on both endpoints and can never be judged.');
  assert.deepEqual(result.evidence, { finding_count: 1 });
});

test('sync_target_closed_space: destinos ajenos y gravedad según lo pendiente', (t) => {
  const store = openTempStore(t);
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('Inscrito')");
  for (const key of ['cloud:inscrito', 'local', 'cloud:fantasma', 'cloud:otro']) store.db.run('INSERT INTO sync_state (target_key) VALUES (?)', key);
  mutation(store, { project: 'otro' });
  mutation(store, { project: 'otro', disposition: 'quarantined' });
  mutation(store, { project: 'otro', disposition: 'pending', acked_at: '2026-01-01 00:00:00' });
  const result = only(run(store, 'sync_target_closed_space'));
  assert.equal(result.result, 'error');
  const byKey = Object.fromEntries(result.findings.map((f) => [f.evidence.target_key, f]));
  assert.deepEqual(Object.keys(byKey).sort(), ['cloud:fantasma', 'cloud:otro']);
  assert.equal(byKey['cloud:fantasma'].severity, 'warning');
  assert.equal(byKey['cloud:otro'].severity, 'error');
  assert.equal(byKey['cloud:fantasma'].reason_code, REASON_FOREIGN_SYNC_TARGET);
  assert.match(byKey['cloud:otro'].safe_next_step, /^Review the 1 unacknowledged mutation\(s\)/);
  assert.match(byKey['cloud:fantasma'].safe_next_step, /^If the target belongs to a project you want synced/);
  assert.equal(safeNextStepForForeignSyncTarget({ unacked_mutations: 0 }), byKey['cloud:fantasma'].safe_next_step);
  assert.deepEqual(result.evidence, { finding_count: 2 });
});

test('sync_mutation_required_fields: bloquea cargas incompletas y deja la cuarentena como evidencia', (t) => {
  const store = openTempStore(t);
  mutation(store, { entity_key: 'obs-a', payload: '{"sync_id":"obs-a","session_id":"s","type":"t","title":"","content":"c","scope":"project"}' });
  mutation(store, { entity: 'session', entity_key: 'ses-b', payload: '' });
  mutation(store, { entity_key: 'obs-q', disposition: 'quarantined', reason: 'r', evidence: 'e', at: '2026-01-01 00:00:00' });
  mutation(store, { entity_key: 'obs-s1', disposition: 'superseded' });
  mutation(store, { entity_key: 'obs-s2', disposition: 'superseded', reason: 'r', evidence: 'e', at: '2026-01-01 00:00:00' });
  const result = only(run(store, 'sync_mutation_required_fields'));
  assert.equal(result.result, 'blocked');
  assert.deepEqual(result.findings.map((f) => f.reason_code), [
    'sync_mutation_payload_missing_required_fields', 'upgrade_blocked_legacy_mutation_manual', 'sync_mutation_superseded_evidence_incomplete', 'sync_mutation_quarantined', 'sync_mutation_superseded',
  ]);
  assert.deepEqual(result.findings.map((f) => f.severity), ['blocking', 'blocking', 'blocking', 'info', 'info']);
  assert.deepEqual(result.findings[0].evidence, { entity: 'observation', entity_key: 'obs-a', missing_fields: ['title'], op: 'upsert', project: 'demo', seq: 1, target_key: 'cloud' });
  assert.deepEqual(result.findings[2].evidence, { missing_fields: ['disposition_reason', 'disposition_evidence', 'disposition_at'], seq: 4 });
  assert.equal(result.findings[3].requires_confirmation, false);
  assert.match(result.findings[0].safe_next_step, /^Run `odin doctor repair --check sync_mutation_required_fields --dry-run` to inspect local repairs/);
  assert.match(only(run(store, 'sync_mutation_required_fields', { project: 'demo' })).findings[0].safe_next_step, /repair --project demo --check/);
  assert.equal(syncMutationRequiredFieldsRepairHint('  p '), 'Run `odin doctor repair --project p --check sync_mutation_required_fields --dry-run` to inspect local repairs; cloud-upgrade tooling requires configured cloud sync.');
});

test('sync_mutation_required_fields: observaciones de origen corruptas y su pista', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  const a = addObservation(store, { session_id: 's1', type: 'manual', title: 'a', content: 'una línea', project: 'demo' }).id;
  const b = addObservation(store, { session_id: 's1', type: 'manual', title: 'b', content: 'otra', project: 'demo' }).id;
  store.db.run("UPDATE observations SET title = '' WHERE id = ?", a);
  store.db.run("UPDATE observations SET content = '', type = '' WHERE id = ?", b);
  const result = only(run(store, 'sync_mutation_required_fields'));
  assert.equal(result.result, 'blocked');
  assert.equal(result.findings[0].message, `Observation source row ${a} is missing required fields: title`);
  assert.match(result.findings[0].safe_next_step, /Only titles recoverable from existing content can be repaired/);
  assert.match(result.findings[1].safe_next_step, /Repair cannot reconstruct missing type or content/);
  assert.deepEqual(result.evidence, { finding_count: 2 });
  store.db.run("UPDATE observations SET title = 'ok', content = 'c', type = 't'");
  assert.deepEqual(only(run(store, 'sync_mutation_required_fields')).evidence, { corrupt_source_observations: 0, pending_mutations_evaluated: 0 });
});

test('sync_mutation_required_fields: el atraso sin inscribir solo bloquea si se usa la nube', (t) => {
  const store = openTempStore(t);
  const valid = '{"sync_id":"o","session_id":"s","type":"t","title":"x","content":"c","scope":"project"}';
  mutation(store, { entity_key: 'o1', payload: valid, project: 'libre' });
  assert.equal(only(run(store, 'sync_mutation_required_fields')).result, 'ok', 'sin proyectos inscritos es el estado normal');
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('inscrito')");
  const result = only(run(store, 'sync_mutation_required_fields'));
  assert.equal(result.result, 'blocked');
  assert.equal(result.findings[0].reason_code, 'non_enrolled_pending_mutations');
  assert.equal(result.findings[0].message, 'Pending cloud sync mutations for project "libre" are blocked because it is not enrolled.');
  assert.deepEqual(result.findings[0].evidence, { pending_mutations: 1, project: 'libre' });
  assert.equal(only(run(store, 'sync_mutation_required_fields', { project: 'inscrito' })).result, 'ok', 'el proyecto acotado no tiene atraso');
});

test('invalid_session_identity: bloquea el origen y avisa de lo recibido en cuarentena', (t) => {
  const store = openTempStore(t);
  store.db.run("INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES (' ', 'demo', '/x', '2026-01-01 00:00:00', 'shared')");
  store.db.run(
    `INSERT INTO sync_apply_deferred (sync_id, entity, payload, target_key, project, scope_class, apply_status, reason_code, first_seen_at, entity_key, op, remote_seq)
     VALUES ('d1', 'session', '{}', 'local', 'demo', 'scoped', 'dead', 'sync_session_identity_invalid', '2026-01-01 00:00:00', ' ', 'upsert', 1)`,
  );
  const result = only(run(store, 'invalid_session_identity'));
  assert.equal(result.result, 'blocked');
  assert.deepEqual(result.findings.map((f) => [f.severity, f.reason_code]), [['blocking', 'invalid_session_identity'], ['warning', 'quarantined_pulled_session_identity']]);
  assert.deepEqual(result.evidence, { finding_count: 2 });
  store.db.run("DELETE FROM sessions WHERE id = ' '");
  assert.equal(only(run(store, 'invalid_session_identity')).result, 'warning');
});

test('sqlite_lock_contention: sondeo fallido, contención y estado normal', (t) => {
  const store = openTempStore(t);
  const snapshot = (over) => () => ({ journal_mode: 'wal', busy_timeout_ms: 5000, checkpoint_busy: 0, checkpoint_log: 3, checkpointed_frames: 3, ...over });
  assert.equal(only(run(store, 'sqlite_lock_contention', { readSqliteLockSnapshot: snapshot({}) })).result, 'ok');
  const busy = only(run(store, 'sqlite_lock_contention', { readSqliteLockSnapshot: snapshot({ checkpoint_busy: 1 }) }));
  assert.deepEqual([busy.result, busy.findings[0].reason_code, busy.findings[0].requires_confirmation], ['warning', 'sqlite_lock_contention_detected', false]);
  assert.equal(busy.findings[0].evidence.checkpoint_busy, 1);
  assert.equal(only(run(store, 'sqlite_lock_contention', { readSqliteLockSnapshot: snapshot({ busy_timeout_ms: 0 }) })).result, 'warning');
  const failed = only(run(store, 'sqlite_lock_contention', { readSqliteLockSnapshot: () => { throw new Error('bloqueado'); } }));
  assert.deepEqual([failed.result, failed.findings[0].reason_code, failed.findings[0].message, failed.evidence], ['error', 'sqlite_lock_probe_failed', 'bloqueado', { finding_count: 1 }]);
});

test('ambiguous_active_runtime_sessions: dos sesiones activas en el mismo directorio', (t) => {
  const store = openTempStore(t);
  createSession(store, 'rt-a', 'demo', '/amb');
  createSession(store, 'rt-b', 'demo', '/amb');
  createSession(store, 'rt-c', 'demo', '/solo');
  createSession(store, 'manual-save-demo', 'demo', '/amb');
  const result = only(run(store, 'ambiguous_active_runtime_sessions'));
  assert.equal(result.result, 'warning');
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0].evidence, { active_candidate_count: 2, directories: ['/amb'], project: 'demo', session_ids: ['rt-a', 'rt-b'] });
  assert.equal(result.findings[0].message, 'Project "demo" has 2 active runtime session candidates across 1 directory or directories.');
  assert.deepEqual(result.findings[0].requires_confirmation, true);
  assert.equal(only(run(store, 'ambiguous_active_runtime_sessions', { project: 'otro' })).result, 'ok');
});

test('autoridad de proyecto de una sesión', () => {
  const git = { project: 'real', source: 'git_remote', path: '/r' };
  assert.equal(decideSessionProjectAuthority('viejo', '', false, git).authority, 'trusted_directory');
  assert.deepEqual([decideSessionProjectAuthority('viejo', '', false, git).repairTarget, decideSessionProjectAuthority('viejo', '', false, git).repairEvidencePath], ['real', '/r']);
  assert.equal(decideSessionProjectAuthority('real', '', false, git).authority, '', 'si coinciden no hay nada que mover');
  assert.equal(decideSessionProjectAuthority('', 'x', true, git).authority, '', 'sin proyecto persistido no se decide');
  const basename = { project: 'viejo', source: 'dir_basename' };
  assert.equal(decideSessionProjectAuthority('viejo', 'otro', true, basename).directoryBasenameCorroboratesPersisted, true);
  assert.equal(decideSessionProjectAuthority('viejo', 'otro', true, basename).authority, '', 'el nombre del directorio veta el traslado por nombre manual');
  assert.equal(decideSessionProjectAuthority('viejo', 'Otro', true, { project: '', source: '' }).authority, 'manual_name');
  assert.equal(decideSessionProjectAuthority('viejo', 'otro', false, { project: '', source: '' }).authority, '', 'un nombre manual sin sesión local que lo respalde no vale');
  assert.equal(decideSessionProjectAuthority('otro', 'otro', true, { project: '', source: '' }).authority, '');
  assert.equal(manualSessionNameTarget('manual-save-Mi--Proyecto'), 'mi-proyecto');
  assert.equal(manualSessionNameTarget('MANUAL-save-x'), '');
});

test('session_project_directory_mismatch usa la detección inyectada y conserva los alias como evidencia', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'viejo', '/repo');
  createSession(store, 's2', 'real', '/otro');
  createSession(store, 's3', 'viejo', '');
  const detectProject = (dir) => (dir === '/repo' ? { project: 'real', source: 'git_remote', path: '/repo' } : { project: 'x', source: 'config', path: '' });
  const result = only(run(store, 'session_project_directory_mismatch', { detectProject }));
  assert.equal(result.result, 'warning');
  assert.equal(result.findings.length, 1, 'un origen que no es de confianza no cuenta');
  assert.deepEqual(result.findings[0].evidence, {
    directory: '/repo', directory_project: 'real', directory_project_path: '/repo', directory_project_source: 'git_remote',
    project_aliases: { project: '', key_alias: null, cwd_alias: null, conflict: false }, session_id: 's1', session_project: 'viejo',
  });
});

test('manual_session_name_project_mismatch: el nombre manual solo vale si hay sesión local de ese proyecto', (t) => {
  const store = openTempStore(t);
  createSession(store, 'manual-save-otro', 'viejo', '');
  createSession(store, 'x', 'otro', '');
  createSession(store, 'manual-save-fantasma', 'viejo', '');
  const detectProject = () => null;
  const result = only(run(store, 'manual_session_name_project_mismatch', { detectProject }));
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0].evidence.session_id, 'manual-save-otro');
  assert.equal(result.findings[0].evidence.name_project, 'otro');
});
