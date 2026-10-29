import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ackSyncMutationSeqs, acquireSyncLease, applyCloudMutation, countPendingNonEnrolledSyncMutations, ensureEnrolledProjectSyncMutations, listDeferredProjectsForTarget,
  listPendingSyncMutationsAfterSeq, maxPendingSyncMutationSeq, releaseSyncLease,
} from '../../../src/store/sync-queue.js';
import { deleteSession } from '../../../src/store/session-delete.js';
import { backfillProjectSyncMutations } from '../../../src/store/journal.js';
import { judgeRelation, saveRelation } from '../../../src/store/relations.js';
import {
  addObservation, addPrompt, createSession, deleteObservation, deletePrompt, enrollProject, getObservation, getSyncState, isActivelyDegradedState, markSyncBlocked, markSyncBlockedAfterSuccess,
  markSyncFailure, unenrollProject,
} from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const insert = (store, project, entity = 'session', key = 'x', extra = {}) => insertRow(store, project, entity, key, extra);
const insertRow = (store, project, entity, key, extra) => store.db.run(
  'INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  (store.db.run("INSERT OR IGNORE INTO sync_state (target_key, lifecycle) VALUES (?, 'idle')", extra.target ?? 'cloud'), extra.target ?? 'cloud'), entity, key, 'upsert', '{}', 'local', project, extra.disposition ?? 'pending',
);

test('la cola de salida solo ofrece pendientes de proyectos inscritos o sin proyecto, por orden', (t) => {
  const store = openTempStore(t);
  enrollProject(store, 'demo');
  insert(store, 'demo', 'session', 'a');
  insert(store, 'fuera', 'session', 'b');
  insert(store, '', 'session', 'c');
  insert(store, 'demo', 'session', 'd', { disposition: 'quarantined' });
  insert(store, 'demo', 'session', 'e', { target: 'cloud:demo' });
  store.db.run("UPDATE sync_mutations SET acked_at = datetime('now') WHERE entity_key = 'c'");
  insert(store, '', 'session', 'f');
  const keys = (rows) => rows.map((r) => r.entity_key);
  assert.deepEqual(keys(listPendingSyncMutationsAfterSeq(store, 'cloud', 0, 10)), ['a', 'f']);
  assert.deepEqual(keys(listPendingSyncMutationsAfterSeq(store, ' CLOUD ', 0)), ['a', 'f']);
  const first = listPendingSyncMutationsAfterSeq(store, 'cloud', 0, 1);
  assert.equal(first.length, 1);
  assert.deepEqual(Object.keys(first[0]), ['seq', 'target_key', 'entity', 'entity_key', 'op', 'payload', 'source', 'project', 'occurred_at', 'acked_at', 'disposition', 'disposition_reason', 'disposition_evidence', 'disposition_at']);
  assert.deepEqual(keys(listPendingSyncMutationsAfterSeq(store, 'cloud', first[0].seq, 10)), ['f']);
  assert.equal(maxPendingSyncMutationSeq(store, 'cloud'), store.db.get("SELECT seq FROM sync_mutations WHERE entity_key = 'f'").seq);
  assert.equal(maxPendingSyncMutationSeq(store, 'cloud:nada'), 0);
  assert.deepEqual(countPendingNonEnrolledSyncMutations(store, 'cloud'), [{ project: 'fuera', count: 1 }]);
  insert(store, 'demo', 'session', 'g', { target: 'cloud:inbox' });
  insert(store, 'fuera', 'session', 'h');
  assert.equal(maxPendingSyncMutationSeq(store, 'cloud'), store.db.get("SELECT seq FROM sync_mutations WHERE entity_key = 'f'").seq, 'una pendiente sin inscribir no cuenta para el tope');
  assert.deepEqual(countPendingNonEnrolledSyncMutations(store, 'cloud'), [{ project: 'fuera', count: 2 }]);
  for (const inbox of ['cloud:inbox']) {
    assert.deepEqual(listPendingSyncMutationsAfterSeq(store, inbox), []);
    assert.equal(maxPendingSyncMutationSeq(store, inbox), 0);
    assert.deepEqual(countPendingNonEnrolledSyncMutations(store, inbox), []);
  }
});

test('acusar recibo marca las filas, cuenta lo que queda y recalcula cada proyecto', (t) => {
  const store = openTempStore(t);
  enrollProject(store, 'demo');
  enrollProject(store, 'otro');
  createSession(store, 's1', 'demo', '/x');
  createSession(store, 's2', 'otro', '/y');
  const rows = store.db.all("SELECT seq, project FROM sync_mutations WHERE target_key = 'cloud' ORDER BY seq");
  assert.equal(rows.length, 2);
  ackSyncMutationSeqs(store, 'cloud', [rows[0].seq, 0, -3, 9999]);
  assert.equal(getSyncState(store, 'cloud').lifecycle, 'pending');
  assert.equal(getSyncState(store, 'cloud').last_acked_seq, 9999, 'el mayor número acusado');
  assert.equal(getSyncState(store, 'cloud:demo').lifecycle, 'healthy');
  assert.equal(getSyncState(store, 'cloud:otro').lifecycle, 'pending');
  ackSyncMutationSeqs(store, 'cloud', [rows[1].seq]);
  assert.equal(getSyncState(store, 'cloud').lifecycle, 'healthy');
  assert.equal(getSyncState(store, 'cloud:otro').lifecycle, 'healthy');
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE acked_at IS NOT NULL").n, 2);
  ackSyncMutationSeqs(store, 'cloud', []);
  ackSyncMutationSeqs(store, 'cloud:inbox', [1]);
});

test('acusar solo parte de un proyecto lo deja pendiente', (t) => {
  const store = openTempStore(t);
  enrollProject(store, 'demo');
  createSession(store, 's1', 'demo', '/x');
  addObservation(store, { session_id: 's1', type: 'note', title: 'T', content: 'c', project: 'demo' });
  const [first] = store.db.all("SELECT seq FROM sync_mutations WHERE target_key = 'cloud' ORDER BY seq");
  ackSyncMutationSeqs(store, 'cloud', [first.seq]);
  assert.equal(getSyncState(store, 'cloud:demo').lifecycle, 'pending');
  assert.equal(getSyncState(store, 'cloud:demo').last_acked_seq, first.seq);
});

test('las diferidas de un destino solo cuentan si son de un proyecto concreto', (t) => {
  const store = openTempStore(t);
  const add = (id, scope, status, project) => store.db.run(
    `INSERT INTO sync_apply_deferred (sync_id, entity, payload, target_key, remote_seq, entity_key, op, reason_code, project, scope_class, apply_status, retry_count, first_seen_at)
     VALUES (?, 'relation', '{}', 'cloud', 0, ?, 'upsert', 'x', ?, ?, ?, 0, datetime('now'))`, id, id, project, scope, status);
  add('a', 'scoped', 'deferred', 'beta');
  add('b', 'target_scoped', 'deferred', 'alfa');
  add('c', 'scoped', 'dead', 'gama');
  add('d', 'scoped', 'deferred', '');
  assert.deepEqual(listDeferredProjectsForTarget(store, 'cloud'), ['beta']);
});

test('arrancar vuelve a encolar lo que falte de los proyectos inscritos', (t) => {
  const store = openTempStore(t);
  enrollProject(store, 'demo');
  createSession(store, 's1', 'demo', '/x');
  store.db.run('DELETE FROM sync_mutations');
  ensureEnrolledProjectSyncMutations(store);
  assert.deepEqual(store.db.all('SELECT entity FROM sync_mutations').map((r) => r.entity), ['session']);
});

test('acusar recibo no borra un bloqueo vigente', (t) => {
  const store = openTempStore(t);
  enrollProject(store, 'demo');
  createSession(store, 's1', 'demo', '/x');
  markSyncBlocked(store, 'cloud', 'auth_required', 'falta token');
  const seq = store.db.get("SELECT seq FROM sync_mutations WHERE target_key = 'cloud'").seq;
  ackSyncMutationSeqs(store, 'cloud', [seq]);
  const state = getSyncState(store, 'cloud');
  assert.deepEqual([state.lifecycle, state.reason_code, state.last_error], ['degraded', 'auth_required', 'falta token']);
  assert.equal(state.last_acked_seq, seq);
});

test('un destino se considera degradado mientras dura su bloqueo o su espera', () => {
  const state = (extra) => ({ lifecycle: 'degraded', reason_code: null, backoff_until: null, ...extra });
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(isActivelyDegradedState(null), false);
  assert.equal(isActivelyDegradedState({ lifecycle: 'healthy', reason_code: 'paused' }), false);
  for (const code of ['blocked_unenrolled', 'paused', 'auth_required', 'policy_forbidden', 'cloud_config_error']) assert.equal(isActivelyDegradedState(state({ reason_code: code }), now), true, code);
  assert.equal(isActivelyDegradedState(state({ reason_code: 'transport_failed' }), now), false);
  assert.equal(isActivelyDegradedState(state({ backoff_until: '2026-01-01T00:00:10Z' }), now), true);
  assert.equal(isActivelyDegradedState(state({ backoff_until: '2025-12-31T23:59:59Z' }), now), false);
  assert.equal(isActivelyDegradedState(state({ backoff_until: 'ayer' }), now), false);
});

test('marcar un bloqueo tras una lectura exitosa anota el éxito', (t) => {
  const store = openTempStore(t);
  markSyncBlocked(store, 'cloud', 'paused', 'm');
  assert.equal(getSyncState(store, 'cloud').last_success_at, null);
  markSyncBlockedAfterSuccess(store, 'cloud', 'paused', 'm');
  assert.ok(getSyncState(store, 'cloud').last_success_at);
});

test('el arriendo es de uno solo mientras no venza', (t) => {
  const store = openTempStore(t);
  const t0 = new Date('2026-01-01T00:00:00Z');
  assert.equal(acquireSyncLease(store, 'cloud', 'a', 60_000, t0), true);
  assert.equal(store.db.get("SELECT lease_until FROM sync_state WHERE target_key = 'cloud'").lease_until, '2026-01-01T00:01:00Z');
  assert.equal(acquireSyncLease(store, 'cloud', 'b', 60_000, new Date(t0.getTime() + 30_000)), false);
  assert.equal(acquireSyncLease(store, 'cloud', 'a', 60_000, new Date(t0.getTime() + 30_000)), true, 'el dueño lo renueva');
  assert.equal(acquireSyncLease(store, 'cloud', 'b', 60_000, new Date(t0.getTime() + 200_000)), true, 'vencido, otro lo toma');
  releaseSyncLease(store, 'cloud', 'a');
  assert.equal(store.db.get("SELECT lease_owner FROM sync_state WHERE target_key = 'cloud'").lease_owner, 'b', 'quien no es dueño no lo suelta');
  releaseSyncLease(store, 'cloud', 'b');
  assert.equal(store.db.get("SELECT lease_owner FROM sync_state WHERE target_key = 'cloud'").lease_owner, null);
  assert.equal(acquireSyncLease(store, 'cloud', 'c', 0, t0), true);
  assert.equal(store.db.get("SELECT lease_until FROM sync_state WHERE target_key = 'cloud'").lease_until, '2026-01-01T00:01:00Z', 'sin duración, un minuto');
});

const session = (id, extra = {}) => JSON.stringify({ id, project: 'demo', directory: '/r', started_at: '2026-01-01 00:00:00', ...extra });
const obs = (id, extra = {}) => JSON.stringify({ sync_id: id, session_id: 'rs', type: 'note', title: id, content: 'c', scope: 'project', project: 'demo', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00', ...extra });
const remote = (seq, entity, key, op, payload, project = 'demo') => ({ seq, project, entity, entity_key: key, op, payload, occurred_at: '' });

test('aplicar lo que llega de la nube avanza el cursor una sola vez por mutación', (t) => {
  const store = openTempStore(t);
  applyCloudMutation(store, 'cloud', remote(1, 'session', 'rs', 'upsert', session('rs')));
  assert.equal(getSyncState(store, 'cloud').last_pulled_seq, 1);
  assert.equal(getSyncState(store, 'cloud').lifecycle, 'healthy');
  applyCloudMutation(store, 'cloud', remote(1, 'session', 'otra', 'upsert', session('otra')));
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sessions WHERE id = 'otra'").n, 0, 'una secuencia ya vista se ignora');
  markSyncBlocked(store, 'cloud', 'paused', 'm');
  applyCloudMutation(store, 'cloud', remote(2, 'session', 'dos', 'upsert', session('dos')), { preserveSyncState: true });
  const state = getSyncState(store, 'cloud');
  assert.deepEqual([state.last_pulled_seq, state.lifecycle, state.reason_code], [2, 'degraded', 'paused'], 'conserva el bloqueo');
  assert.throws(() => applyCloudMutation(store, 'cloud', remote(3, 'cosa', 'x', 'upsert', '{}')), /unknown sync entity "cosa"/);
  assert.equal(getSyncState(store, 'cloud').last_pulled_seq, 2);
});

test('con la nube, un borrado fija un piso: solo lo posterior vuelve a crear la entidad', (t) => {
  const store = openTempStore(t);
  const target = 'cloud';
  applyCloudMutation(store, target, remote(1, 'session', 'rs', 'upsert', session('rs')));
  applyCloudMutation(store, target, remote(2, 'observation', 'o1', 'upsert', obs('o1')));
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM observations WHERE sync_id = 'o1'").n, 1);
  applyCloudMutation(store, target, remote(5, 'observation', 'o1', 'delete', JSON.stringify({ sync_id: 'o1', session_id: 'rs', project: 'demo', deleted: true, hard_delete: true })));
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM observations WHERE sync_id = 'o1'").n, 0);
  const tomb = store.db.get("SELECT active, hard_delete, last_remote_mutation_seq FROM sync_delete_tombstones WHERE entity = 'observation' AND entity_key = 'o1'");
  assert.deepEqual({ ...tomb }, { active: 1, hard_delete: 1, last_remote_mutation_seq: 5 });
  const rewind = () => store.db.run("UPDATE sync_state SET last_pulled_seq = 0 WHERE target_key = ?", target);
  rewind();
  applyCloudMutation(store, target, remote(4, 'observation', 'o1', 'upsert', obs('o1')));
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM observations WHERE sync_id = 'o1'").n, 0, 'una alta anterior al borrado no lo resucita');
  applyCloudMutation(store, target, remote(7, 'observation', 'o1', 'upsert', obs('o1', { title: 'nueva' })));
  assert.equal(store.db.get("SELECT title FROM observations WHERE sync_id = 'o1'").title, 'nueva', 'una posterior sí');

  applyCloudMutation(store, target, remote(8, 'observation', 'o2', 'delete', JSON.stringify({ sync_id: 'o2', session_id: 'rs', project: 'demo', deleted: true })));
  const soft = store.db.get("SELECT active, hard_delete FROM sync_delete_tombstones WHERE entity_key = 'o2'");
  assert.deepEqual({ ...soft }, { active: 1, hard_delete: 0 }, 'un borrado blando también deja piso en la nube');
  rewind();
  applyCloudMutation(store, target, remote(6, 'observation', 'o2', 'upsert', obs('o2')));
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM observations WHERE sync_id = 'o2'").n, 0);

  applyCloudMutation(store, target, remote(11, 'session', 'sola', 'upsert', session('sola')));
  applyCloudMutation(store, target, remote(15, 'session', 'sola', 'delete', JSON.stringify({ id: 'sola', project: 'demo', hard_delete: true })));
  assert.equal(store.db.get("SELECT hard_delete FROM sync_delete_tombstones WHERE entity = 'session' AND entity_key = 'sola'").hard_delete, 1, 'la lápida de sesión guarda si el borrado era duro');
  rewind();
  applyCloudMutation(store, target, remote(14, 'session', 'sola', 'upsert', session('sola')));
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sessions WHERE id = 'sola'").n, 0, 'lo mismo para sesiones');
  applyCloudMutation(store, target, remote(16, 'session', 'sola', 'upsert', session('sola')));
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sessions WHERE id = 'sola'").n, 1);
});

test('en un destino por proyecto el piso se guarda aparte', (t) => {
  const store = openTempStore(t);
  const target = 'cloud:demo';
  applyCloudMutation(store, target, remote(1, 'session', 'rs', 'upsert', session('rs')));
  applyCloudMutation(store, target, remote(3, 'session', 'rs', 'delete', JSON.stringify({ id: 'rs', project: 'demo', hard_delete: true })));
  assert.equal(store.db.get("SELECT last_mutation_seq FROM sync_delete_tombstone_remote_floors WHERE target_key = ? AND entity = 'session'", target).last_mutation_seq, 3);
  assert.equal(store.db.get("SELECT last_remote_mutation_seq FROM sync_delete_tombstones WHERE entity = 'session'").last_remote_mutation_seq, null);
  store.db.run("UPDATE sync_state SET last_pulled_seq = 0 WHERE target_key = ?", target);
  applyCloudMutation(store, target, remote(2, 'session', 'rs', 'upsert', session('rs')));
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM sessions').n, 0, 'bloqueada por su propio piso');
  applyCloudMutation(store, target, remote(4, 'session', 'rs', 'upsert', session('rs')));
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM sessions').n, 1);
  // Otro destino sin piso propio, cuando ya existe uno de otro destino, no queda bloqueado por la lápida.
  applyCloudMutation(store, 'cloud:otro', remote(1, 'session', 'rs', 'upsert', session('rs'), 'otro'));
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM sessions').n, 1);
  store.db.run("DELETE FROM sessions WHERE id = 'rs'");
  store.db.run("UPDATE sync_delete_tombstones SET active = 1 WHERE entity = 'session'");
  applyCloudMutation(store, 'cloud:ajeno', remote(1, 'session', 'rs', 'upsert', session('rs'), 'ajeno'));
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM sessions').n, 1, 'con el piso de otro destino y ninguno propio, la lápida no bloquea');
  store.db.run("DELETE FROM sync_delete_tombstone_remote_floors");
  store.db.run("DELETE FROM sessions WHERE id = 'rs'");
  store.db.run("UPDATE sync_delete_tombstones SET active = 1 WHERE entity = 'session'");
  applyCloudMutation(store, 'cloud:nuevo', remote(1, 'session', 'rs', 'upsert', session('rs'), 'nuevo'));
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM sessions').n, 0, 'sin ningún piso, manda la lápida activa');
});

test('una relación sin extremos y un padre ausente no detienen la lectura', (t) => {
  const store = openTempStore(t);
  const relation = { sync_id: 'rel-1', source_id: 'nada-1', target_id: 'nada-2', relation: 'related', judgment_status: 'judged', marked_by_actor: 'a', marked_by_kind: 'human', project: 'demo' };
  applyCloudMutation(store, 'cloud', remote(1, 'relation', 'rel-1', 'upsert', JSON.stringify(relation)));
  assert.equal(getSyncState(store, 'cloud').last_pulled_seq, 1);
  assert.deepEqual(listDeferredProjectsForTarget(store, 'cloud'), ['demo']);
  applyCloudMutation(store, 'cloud', remote(2, 'observation', 'huerfana', 'upsert', obs('huerfana', { session_id: 'no-existe' })));
  assert.equal(getSyncState(store, 'cloud').last_pulled_seq, 2);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_apply_deferred WHERE apply_status = 'deferred'").n, 2);
  assert.deepEqual(listDeferredProjectsForTarget(store, 'cloud:demo'), []);
});

test('inscribir un proyecto rellena el diario con lo que ya había', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  createSession(store, 'ajena', 'otro', '/o');
  const keep = addObservation(store, { session_id: 's1', type: 'decision', title: 'Vive', content: 'c', project: 'demo' });
  const gone = addObservation(store, { session_id: 's1', type: 'note', title: 'Muere', content: 'c2', project: 'demo' });
  deleteObservation(store, gone.id, { hardDelete: false });
  const hard = addObservation(store, { session_id: 's1', type: 'note', title: 'Dura', content: 'c3', project: 'demo' });
  deleteObservation(store, hard.id, { hardDelete: true });
  const prompt = addPrompt(store, { session_id: 's1', content: 'hola', project: 'demo' });
  const dead = addPrompt(store, { session_id: 's1', content: 'adiós', project: 'demo' });
  deletePrompt(store, dead.id);
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM sync_mutations').n, 0, 'sin inscribir no se anota nada');

  enrollProject(store, 'demo');
  const queued = store.db.all("SELECT entity, op, project, source, entity_key FROM sync_mutations WHERE target_key = 'cloud' ORDER BY seq").map((r) => `${r.entity}/${r.op}/${r.project}/${r.source}`);
  assert.deepEqual(queued.sort(), [
    'observation/delete/demo/local', 'observation/delete/demo/local', 'observation/upsert/demo/local', 'prompt/delete/demo/local', 'prompt/upsert/demo/local', 'session/upsert/demo/local',
  ]);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE project = 'otro'").n, 0);
  const upsert = store.db.get("SELECT payload FROM sync_mutations WHERE entity = 'observation' AND op = 'upsert'").payload;
  assert.equal(JSON.parse(upsert).sync_id, getObservation(store, keep.id).sync_id);
  assert.equal(JSON.parse(store.db.get("SELECT payload FROM sync_mutations WHERE entity = 'prompt' AND op = 'upsert'").payload).sync_id, store.db.get('SELECT sync_id FROM user_prompts WHERE id = ?', prompt.id).sync_id);
  const deletes = store.db.all("SELECT payload FROM sync_mutations WHERE entity = 'observation' AND op = 'delete'").map((r) => JSON.parse(r.payload));
  assert.deepEqual(deletes.map((d) => d.hard_delete).sort(), [false, true], 'uno blando y uno duro');
  assert.ok(deletes.every((d) => d.deleted === true));

  const count = () => store.db.get('SELECT COUNT(*) AS n FROM sync_mutations').n;
  const before = count();
  ensureEnrolledProjectSyncMutations(store);
  assert.equal(count(), before, 'es idempotente');
  unenrollProject(store, 'demo');
  enrollProject(store, 'demo');
  assert.equal(count(), before, 'inscribir de nuevo tampoco duplica lo pendiente');
});

test('un fallo marcado mantiene su espera al acusar recibo', (t) => {
  const store = openTempStore(t);
  enrollProject(store, 'demo');
  createSession(store, 's1', 'demo', '/x');
  markSyncFailure(store, 'cloud', 'caído', new Date(Date.now() + 60_000));
  ackSyncMutationSeqs(store, 'cloud', [store.db.get("SELECT seq FROM sync_mutations WHERE target_key = 'cloud'").seq]);
  assert.equal(getSyncState(store, 'cloud').lifecycle, 'degraded');
  assert.equal(getSyncState(store, 'cloud').consecutive_failures, 1);
});

test('el relleno también lleva lápidas de sesión y relaciones juzgadas, y no hace nada sin proyecto', (t) => {
  const store = openTempStore(t);
  createSession(store, 'vieja', 'demo', '/old');
  deleteSession(store, 'vieja');
  createSession(store, 's1', 'demo', '/x');
  const a = addObservation(store, { session_id: 's1', type: 'note', title: 'A', content: 'uno', project: 'demo' });
  const b = addObservation(store, { session_id: 's1', type: 'note', title: 'B', content: 'dos', project: 'demo' });
  const c = addObservation(store, { session_id: 's1', type: 'note', title: 'C', content: 'tres', project: 'demo' });
  const sync = (id) => getObservation(store, id).sync_id;
  saveRelation(store, { sync_id: 'rel-juzgada', source_id: sync(a.id), target_id: sync(b.id) });
  judgeRelation(store, { judgment_id: 'rel-juzgada', relation: 'related', marked_by_actor: 'ana', marked_by_kind: 'human' });
  saveRelation(store, { sync_id: 'rel-pendiente', source_id: sync(a.id), target_id: sync(c.id) });
  store.db.run("INSERT INTO sessions (id, project, directory) VALUES ('sin-dueño', '', '/z')");
  saveRelation(store, { sync_id: 'rel-sin-autor', source_id: sync(a.id), target_id: sync(c.id) });
  store.db.run("UPDATE memory_relations SET judgment_status = 'judged', marked_by_actor = '', marked_by_kind = 'human' WHERE sync_id = 'rel-sin-autor'");
  store.db.writeTransaction((db) => backfillProjectSyncMutations(db, ''));
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM sync_mutations').n, 0, 'sin proyecto no se rellena nada, ni lo que no tiene dueño');
  enrollProject(store, 'demo');
  const rows = store.db.all("SELECT entity, op, entity_key, payload FROM sync_mutations WHERE entity IN ('session', 'relation') ORDER BY seq");
  const tomb = rows.find((r) => r.entity === 'session' && r.op === 'delete');
  assert.deepEqual(JSON.parse(tomb.payload), { id: 'vieja', project: 'demo', deleted: true, deleted_at: JSON.parse(tomb.payload).deleted_at, hard_delete: true });
  const relations = rows.filter((r) => r.entity === 'relation');
  assert.deepEqual(relations.map((r) => r.entity_key), ['rel-juzgada'], 'ni la pendiente ni la juzgada sin autor viajan');
  const payload = JSON.parse(relations[0].payload);
  assert.deepEqual([payload.marked_by_actor, payload.marked_by_kind, payload.judgment_status, payload.project], ['ana', 'human', 'judged', 'demo']);
});
