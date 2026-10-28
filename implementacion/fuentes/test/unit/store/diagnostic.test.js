import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countPendingNonEnrolledSyncMutations, listDiagnosticObservationRequiredFields, listDiagnosticSessions, listEnrolledProjects, listInvalidSessionIdentityEvidence,
  listOrphanedObservationSessionEvidence, listOrphanedPendingRelationEvidence, listOrphanedPendingRelationEvidenceBounded, listPendingProjectMutations,
  listQuarantinedPulledSessionEvidence, listSyncStates, readSqliteLockSnapshot, validateSyncMutationPayload,
} from '../../../src/store/diagnostic.js';
import { addObservation, createSession } from '../../../src/store/index.js';
import { SYNC_INBOX_TARGET_KEY } from '../../../src/store/sync-state.js';
import { openTempStore } from './helpers.js';

const mutation = (store, fields) => {
  const m = { target_key: 'cloud', entity: 'observation', entity_key: 'obs-1', op: 'upsert', payload: '{}', project: 'demo', disposition: 'pending', ...fields };
  store.db.run('INSERT OR IGNORE INTO sync_state (target_key) VALUES (?)', m.target_key);
  store.db.run(
    'INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, disposition, acked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    m.target_key, m.entity, m.entity_key, m.op, m.payload, m.project, m.disposition, m.acked_at ?? null,
  );
};

test('la bandeja de entrada usa la clave reservada del esquema', (t) => {
  assert.equal(SYNC_INBOX_TARGET_KEY, 'cloud:inbox');
  const store = openTempStore(t);
  assert.ok(store.db.get('SELECT 1 AS x FROM sync_state WHERE target_key = ?', SYNC_INBOX_TARGET_KEY));
});

test('listDiagnosticSessions ordena por inicio descendente, filtra por proyecto y colapsa NULL', (t) => {
  const store = openTempStore(t);
  createSession(store, 'a', 'demo', '/x');
  createSession(store, 'b', 'otro', '/y');
  store.db.run("UPDATE sessions SET started_at = '2026-01-01 00:00:00' WHERE id = 'a'");
  store.db.run("UPDATE sessions SET started_at = '2026-02-01 00:00:00' WHERE id = 'b'");
  assert.deepEqual(listDiagnosticSessions(store).map((s) => s.id), ['b', 'a']);
  assert.deepEqual(listDiagnosticSessions(store, ' DEMO ').map((s) => [s.id, s.name, s.directory, s.project]), [['a', 'a', '/x', 'demo']]);
  store.db.run("UPDATE sessions SET ownership_mode = NULL WHERE id = 'a'");
  assert.equal(listDiagnosticSessions(store, 'demo')[0].ownership_mode, '');
});

test('observaciones huérfanas: agrupa por referencia, incluye borradas y omite ID en blanco', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  const ids = [1, 2, 3].map((n) => addObservation(store, { session_id: 's1', type: 'manual', title: `t${n}`, content: `c${n}`, project: 'demo' }).id);
  store.db.run('PRAGMA foreign_keys = OFF');
  store.db.run("UPDATE observations SET session_id = 'perdida' WHERE id IN (?, ?)", ids[0], ids[1]);
  store.db.run("UPDATE observations SET deleted_at = datetime('now') WHERE id = ?", ids[1]);
  store.db.run("UPDATE observations SET session_id = '  ' WHERE id = ?", ids[2]);
  const evidence = listOrphanedObservationSessionEvidence(store);
  assert.deepEqual(evidence.map((e) => [e.project, e.session_id, e.observation_count]), [['demo', 'perdida', 2]]);
  assert.deepEqual(Object.keys(evidence[0]), ['project', 'session_id', 'observation_count', 'first_observed_at']);
  assert.deepEqual(listOrphanedObservationSessionEvidence(store, 'otro'), []);
});

test('relaciones pendientes: candidatas, un extremo ausente y vivas', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  const liveId = addObservation(store, { session_id: 's1', type: 'manual', title: 'viva', content: 'c', project: 'demo' }).id;
  const live = store.db.get('SELECT sync_id FROM observations WHERE id = ?', liveId);
  const rel = (syncId, source, target, status = 'pending') => store.db.run(
    "INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status) VALUES (?, ?, ?, 'related', ?)", syncId, source, target, status,
  );
  rel('rel-1', 'x1', 'y1');
  rel('rel-2', 'x2', 'y2');
  rel('rel-3', live.sync_id, 'y3');
  rel('rel-4', live.sync_id, live.sync_id);
  rel('rel-5', 'x5', 'y5', 'judged');
  const full = listOrphanedPendingRelationEvidence(store);
  assert.deepEqual(full.candidates.map((c) => c.sync_id), ['rel-1', 'rel-2']);
  assert.deepEqual([full.one_endpoint_missing, full.live_pending], [1, 1]);
  const bounded = listOrphanedPendingRelationEvidenceBounded(store, 1);
  assert.deepEqual([bounded.candidate_count, bounded.sample.map((c) => c.sync_id)], [2, ['rel-1']]);
  assert.deepEqual(Object.keys(bounded.sample[0]), ['id', 'sync_id', 'source_id', 'target_id']);
  assert.deepEqual(listOrphanedPendingRelationEvidenceBounded(store, 0).sample, []);
  store.db.run("UPDATE observations SET deleted_at = datetime('now')");
  assert.equal(listOrphanedPendingRelationEvidenceBounded(store, 10).candidate_count, 4, 'un extremo borrado cuenta como ausente');
});

test('observaciones sin tipo, título o contenido', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  const id = addObservation(store, { session_id: 's1', type: 'manual', title: 't', content: 'c', project: 'demo' }).id;
  store.db.run("UPDATE observations SET title = '  ', type = '' WHERE id = ?", id);
  addObservation(store, { session_id: 's1', type: 'manual', title: 'bien', content: 'ok', project: 'demo' });
  const rows = listDiagnosticObservationRequiredFields(store);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].missing_fields, ['type', 'title']);
  assert.deepEqual(Object.keys(rows[0]), ['id', 'sync_id', 'project', 'missing_fields']);
  assert.deepEqual(listDiagnosticObservationRequiredFields(store, 'otro'), []);
});

test('mutaciones pendientes: solo el objetivo cloud sin confirmar, por proyecto', (t) => {
  const store = openTempStore(t);
  mutation(store, { entity_key: 'a' });
  mutation(store, { entity_key: 'b', project: 'otro' });
  mutation(store, { entity_key: 'c', acked_at: '2026-01-01 00:00:00' });
  mutation(store, { entity_key: 'd', target_key: 'local' });
  assert.deepEqual(listPendingProjectMutations(store).map((m) => m.entity_key), ['a', 'b']);
  assert.deepEqual(listPendingProjectMutations(store, 'OTRO').map((m) => m.entity_key), ['b']);
});

test('identidad de sesión: IDs en blanco con lo que cuelga y el diario inválido', (t) => {
  const store = openTempStore(t);
  store.db.run('PRAGMA foreign_keys = OFF');
  store.db.run("INSERT INTO sessions (id, project, directory, started_at) VALUES (' ', 'demo', '/x', '2026-01-01 00:00:00')");
  store.db.run("INSERT INTO observations (sync_id, session_id, type, title, content, project, scope) VALUES ('o1', ' ', 'manual', 't', 'c', 'demo', 'project')");
  mutation(store, { entity: 'session', entity_key: ' ', payload: '{"id":" "}' });
  mutation(store, { entity: 'session', entity_key: 'ok', payload: '{"id":"ok"}' });
  mutation(store, { entity: 'session', entity_key: 'x', payload: 'no json' });
  mutation(store, { entity: 'session', entity_key: 'y', payload: '{"id":"z"}' });
  const evidence = listInvalidSessionIdentityEvidence(store);
  assert.deepEqual(evidence, [{ project: 'demo', session_id: ' ', observation_count: 1, prompt_count: 0, invalid_journal_count: 1 }]);
  assert.deepEqual(listInvalidSessionIdentityEvidence(store, 'otro'), []);
});

test('sesiones recibidas en cuarentena', (t) => {
  const store = openTempStore(t);
  const defer = (id, reason, seq) => store.db.run(
    `INSERT INTO sync_apply_deferred (sync_id, entity, payload, target_key, project, scope_class, apply_status, reason_code, first_seen_at, entity_key, op, remote_seq)
     VALUES (?, 'session', '{}', 'local', 'demo', 'scoped', 'dead', ?, '2026-01-01 00:00:00', ' ', 'upsert', ?)`, id, reason, seq,
  );
  defer('d2', 'sync_session_identity_invalid', 2);
  defer('d1', 'sync_session_identity_invalid', 1);
  defer('d3', 'otra_razon', 3);
  const rows = listQuarantinedPulledSessionEvidence(store);
  assert.deepEqual(rows.map((r) => r.sync_id), ['d1', 'd2']);
  assert.deepEqual(Object.keys(rows[0]), ['sync_id', 'target_key', 'project', 'entity_key', 'op', 'remote_seq', 'reason_code', 'first_seen_at']);
  assert.deepEqual(listQuarantinedPulledSessionEvidence(store, 'otro'), []);
});

test('inscripción, atraso sin inscribir y estados de sincronización', (t) => {
  const store = openTempStore(t);
  assert.deepEqual(listEnrolledProjects(store), []);
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('inscrito')");
  mutation(store, { entity_key: 'a', project: 'inscrito' });
  mutation(store, { entity_key: 'b', project: 'libre' });
  mutation(store, { entity_key: 'c', project: 'libre' });
  mutation(store, { entity_key: 'd', project: 'libre', disposition: 'quarantined' });
  mutation(store, { entity_key: 'e', project: '' });
  assert.deepEqual(countPendingNonEnrolledSyncMutations(store), [{ project: 'libre', count: 2 }]);
  assert.deepEqual(countPendingNonEnrolledSyncMutations(store, SYNC_INBOX_TARGET_KEY), []);
  store.db.run("INSERT INTO sync_state (target_key, lifecycle) VALUES ('cloud:inscrito', 'idle')");
  const states = listSyncStates(store);
  assert.deepEqual(states.map((s) => s.target_key), ['cloud', 'cloud:inbox', 'cloud:inscrito']);
  assert.equal(states.find((s) => s.target_key === 'cloud:inscrito').unacked_mutations, 1, 'un destino por proyecto cuenta lo pendiente del proyecto en cloud');
});

test('instantánea de bloqueo de SQLite', (t) => {
  const store = openTempStore(t);
  const snapshot = readSqliteLockSnapshot(store);
  assert.deepEqual(Object.keys(snapshot), ['journal_mode', 'busy_timeout_ms', 'checkpoint_busy', 'checkpoint_log', 'checkpointed_frames']);
  assert.equal(snapshot.journal_mode, 'wal');
  assert.equal(snapshot.busy_timeout_ms, 5000);
  assert.equal(snapshot.checkpoint_busy, 0);
});

test('validateSyncMutationPayload exige los campos de cada entidad', () => {
  const v = (entity, op, payload, key = 'k') => validateSyncMutationPayload(entity, op, typeof payload === 'string' ? payload : JSON.stringify(payload), key);
  assert.equal(v('observation', 'upsert', '').message, 'sync mutation payload is empty');
  assert.match(v('observation', 'upsert', 'no json').message, /^decode sync mutation payload: /);
  assert.equal(v('observation', 'upsert', '[]').reason_code, 'upgrade_blocked_legacy_mutation_manual');
  assert.equal(v('widget', 'upsert', {}).message, 'unsupported sync mutation "widget"/"upsert"');
  const obs = { sync_id: 'o', session_id: 's', type: 't', title: 'x', content: 'c', scope: 'project' };
  assert.equal(v('observation', 'upsert', obs).reason_code, undefined);
  assert.deepEqual(v('observation', 'upsert', { ...obs, title: ' ', content: '' }).missing_fields, ['title', 'content']);
  assert.equal(v('observation', 'upsert', { ...obs, title: ' ' }).message, 'observation payload missing required fields: title');
  assert.equal(v('observation', 'delete', {}, 'k').reason_code, undefined);
  assert.deepEqual(v('observation', 'delete', {}, '').missing_fields, ['sync_id']);
  assert.deepEqual(v('prompt', 'upsert', { sync_id: 'p' }).missing_fields, ['session_id', 'content']);
  assert.deepEqual(v('relation', 'upsert', {}).missing_fields.length, 8);
  assert.equal(v('relation', 'delete', {}).reason_code, undefined);
  // sesiones
  assert.equal(v('session', 'upsert', { id: 'k', directory: '/x' }).reason_code, undefined);
  assert.deepEqual(v('session', 'upsert', { id: 'k' }).missing_fields, ['directory']);
  assert.equal(v('session', 'upsert', { id: 'otro', directory: '/x' }).reason_code, 'sync_session_mutation_identity_mismatch');
  assert.match(v('session', 'upsert', { id: 'otro', directory: '/x' }).message, /^session entity_key "k" does not match payload id "otro"$/);
  assert.deepEqual(v('session', 'delete', {}, '').missing_fields, ['id', 'entity_key']);
  assert.equal(v('session', 'upsert', { id: 'k', ownership_mode: 'project_owned' }).reason_code, undefined, 'una sesión propia puede omitir el directorio');
  assert.deepEqual(v('session', 'upsert', { id: 'k', ownership_mode: 'project_owned', directory: null }).missing_fields, ['directory']);
  // la carga puede venir como cadena JSON anidada
  assert.equal(v('observation', 'upsert', JSON.stringify(JSON.stringify(obs))).reason_code, undefined);
});
