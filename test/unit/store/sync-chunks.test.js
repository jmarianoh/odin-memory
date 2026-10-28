import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addObservation, addPrompt, createSession, deleteObservation, deletePrompt, deleteSession, exportLocalDeleteTombstones, exportRelationMutations, exportReviewClearEvents,
  getObservation, getSyncedChunksForTarget, hasProjectOwnedSessionsForProject, markReviewed, normalizeChunkTargetKey, recordSyncedChunkForTarget, saveRelation, scanProject,
} from '../../../src/store/index.js';
import { newMutation } from '../../../src/store/sync-chunks.js';
import { openTempStore } from './helpers.js';

test('los chunks se registran por destino, normalizado y sin duplicar', (t) => {
  const store = openTempStore(t);
  assert.equal(normalizeChunkTargetKey(''), 'local');
  assert.equal(normalizeChunkTargetKey('  CLOUD:Demo '), 'cloud:demo');
  assert.equal(normalizeChunkTargetKey(undefined), 'local');
  assert.deepEqual([...getSyncedChunksForTarget(store)], []);
  recordSyncedChunkForTarget(store, '', 'aaaa1111');
  recordSyncedChunkForTarget(store, 'local', 'aaaa1111');
  recordSyncedChunkForTarget(store, 'Cloud:demo', 'bbbb2222');
  assert.deepEqual([...getSyncedChunksForTarget(store)], ['aaaa1111']);
  assert.deepEqual([...getSyncedChunksForTarget(store, 'cloud:DEMO')], ['bbbb2222']);
  assert.deepEqual([...getSyncedChunksForTarget(store, 'otro')], []);
});

test('newMutation rellena los campos de control con su valor neutro, en orden', () => {
  const m = newMutation({ entity: 'relation', entity_key: 'rel-1', op: 'upsert', payload: '{}', project: 'demo', occurred_at: '2026-01-01' });
  assert.deepEqual(Object.keys(m), ['seq', 'target_key', 'entity', 'entity_key', 'op', 'payload', 'source', 'project', 'occurred_at', 'disposition']);
  assert.deepEqual(m, { seq: 0, target_key: '', entity: 'relation', entity_key: 'rel-1', op: 'upsert', payload: '{}', source: '', project: 'demo', occurred_at: '2026-01-01', disposition: '' });
  assert.equal(newMutation({ entity: 'a', entity_key: 'b', op: 'c', payload: 'd' }).project, '');
});

test('hasProjectOwnedSessionsForProject distingue proyectos y el conjunto', (t) => {
  const store = openTempStore(t);
  assert.equal(hasProjectOwnedSessionsForProject(store), false);
  createSession(store, 's1', 'demo', '/tmp/x', 'shared');
  createSession(store, 's2', 'otro', '/tmp/y', 'project_owned');
  assert.equal(hasProjectOwnedSessionsForProject(store, 'demo'), false);
  assert.equal(hasProjectOwnedSessionsForProject(store, 'otro'), true);
  assert.equal(hasProjectOwnedSessionsForProject(store, ''), true);
  assert.equal(hasProjectOwnedSessionsForProject(store), true);
  assert.equal(hasProjectOwnedSessionsForProject(store, 'OTRO'), true);
});

function relationsStore(t) {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/tmp/x');
  createSession(store, 's2', 'otro', '/tmp/y');
  const mk = (session, title, project) => addObservation(store, { session_id: session, type: 'decision', title, content: title, project }).id;
  const [a, b] = [mk('s1', 'Redis caché', 'demo'), mk('s1', 'Redis distribuida', 'demo')];
  const c = mk('s2', 'Otra cosa', 'otro');
  const sync = (id) => getObservation(store, id).sync_id;
  saveRelation(store, { sync_id: 'rel-0000000000000001', source_id: sync(a), target_id: sync(b) });
  saveRelation(store, { sync_id: 'rel-0000000000000002', source_id: sync(a), target_id: sync(c) });
  return { store, a, b, c, sync };
}

test('exportRelationMutations incluye las relaciones vivas y acota por proyecto', (t) => {
  const { store, sync, a, b } = relationsStore(t);
  store.db.run("UPDATE memory_relations SET reason = 'porque', confidence = 0.5, marked_by_actor = 'agent', session_id = 's1', updated_at = '2026-01-02 00:00:00' WHERE sync_id = 'rel-0000000000000001'");
  const all = exportRelationMutations(store);
  assert.deepEqual(all.map((m) => m.entity_key), ['rel-0000000000000001', 'rel-0000000000000002']);
  const first = all[0];
  assert.deepEqual([first.entity, first.op, first.occurred_at, first.project, first.seq, first.source], ['relation', 'upsert', '2026-01-02 00:00:00', 'demo', 0, '']);
  const payload = JSON.parse(first.payload);
  assert.deepEqual(Object.keys(payload), ['sync_id', 'source_id', 'target_id', 'relation', 'reason', 'confidence', 'judgment_status', 'marked_by_actor', 'session_id', 'project', 'created_at', 'updated_at']);
  assert.deepEqual([payload.source_id, payload.target_id, payload.reason, payload.confidence], [sync(a), sync(b), 'porque', 0.5]);
  assert.equal(payload.project, 'demo');

  assert.deepEqual(exportRelationMutations(store, 'demo').map((m) => m.entity_key), ['rel-0000000000000001'], 'el par que cruza proyectos queda fuera');
  assert.deepEqual(exportRelationMutations(store, 'DEMO').map((m) => m.entity_key), ['rel-0000000000000001']);
  assert.deepEqual(exportRelationMutations(store, 'nada'), []);
  assert.equal(JSON.parse(exportRelationMutations(store, 'demo')[0].payload).project, 'demo');

  store.db.run("UPDATE memory_relations SET judgment_status = 'orphaned' WHERE sync_id = 'rel-0000000000000001'");
  assert.deepEqual(exportRelationMutations(store).map((m) => m.entity_key), ['rel-0000000000000002'], 'las huérfanas no viajan');
  deleteObservation(store, b, { hardDelete: false });
  store.db.run("UPDATE memory_relations SET judgment_status = 'judged' WHERE sync_id = 'rel-0000000000000001'");
  assert.deepEqual(exportRelationMutations(store).map((m) => m.entity_key), ['rel-0000000000000002'], 'un extremo borrado la excluye');
});

test('exportLocalDeleteTombstones proyecta las lápidas activas ordenadas por entidad', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/tmp/x');
  createSession(store, 's2', 'otro', '/tmp/y');
  const o1 = addObservation(store, { session_id: 's1', type: 'manual', title: 'uno', content: 'a', project: 'demo' }).id;
  const o2 = addObservation(store, { session_id: 's2', type: 'manual', title: 'dos', content: 'b', project: 'otro' }).id;
  const { id: p1 } = addPrompt(store, { session_id: 's1', content: 'prompt uno', project: 'demo' });
  addPrompt(store, { session_id: 's2', content: 'prompt dos', project: 'otro' });
  createSession(store, 's3', 'demo', '/tmp/z');
  deleteObservation(store, o1, { hardDelete: true });
  deleteObservation(store, o2, { hardDelete: true });
  deletePrompt(store, p1);
  deleteSession(store, 's3');
  const all = exportLocalDeleteTombstones(store);
  assert.deepEqual(all.map((m) => [m.entity, m.op]), [['observation', 'delete'], ['observation', 'delete'], ['prompt', 'delete'], ['session', 'delete']]);
  // Dentro de una misma entidad y segundo, el orden lo fija la clave aleatoria: se elige por proyecto.
  const obs = JSON.parse(all.filter((m) => m.entity === 'observation').map((m) => m.payload).find((p) => JSON.parse(p).project === 'demo'));
  assert.deepEqual(Object.keys(obs), ['sync_id', 'session_id', 'type', 'title', 'content', 'project', 'scope', 'revision_count', 'duplicate_count', 'deleted', 'deleted_at', 'hard_delete']);
  assert.deepEqual([obs.deleted, obs.hard_delete, obs.project, obs.session_id], [true, true, 'demo', 's1']);
  const pr = JSON.parse(all[2].payload);
  assert.deepEqual(Object.keys(pr), ['sync_id', 'session_id', 'content', 'project', 'deleted', 'deleted_at', 'hard_delete']);
  assert.deepEqual([pr.content, pr.project, pr.hard_delete], ['', 'demo', true]);
  const ses = JSON.parse(all[3].payload);
  assert.deepEqual(Object.keys(ses), ['id', 'project', 'deleted', 'deleted_at', 'hard_delete']);
  assert.equal(ses.id, 's3');
  assert.deepEqual(exportLocalDeleteTombstones(store, 'demo').map((m) => m.entity), ['observation', 'prompt', 'session']);
  assert.deepEqual(exportLocalDeleteTombstones(store, 'otro').map((m) => m.entity), ['observation']);
  assert.deepEqual(exportLocalDeleteTombstones(store, 'nada'), []);
  store.db.run("UPDATE sync_delete_tombstones SET active = 0 WHERE entity = 'observation'");
  assert.deepEqual(exportLocalDeleteTombstones(store).map((m) => m.entity), ['prompt', 'session'], 'las lápidas inactivas no viajan');
  store.db.run("UPDATE sync_delete_tombstones SET superseded_by_sync_id = 'obs-nueva', active = 1 WHERE entity = 'observation' AND entity_key = (SELECT sync_id FROM observations LIMIT 1)");
});

test('las lápidas ordenan por fecha y clave dentro de cada entidad', (t) => {
  const store = openTempStore(t);
  for (const [key, at] of [['obs-c', '2026-01-03 00:00:00'], ['obs-a', '2026-01-02 00:00:00'], ['obs-b', '2026-01-02 00:00:00']]) {
    store.db.run("INSERT INTO sync_delete_tombstones (entity, entity_key, session_id, project, deleted_at, hard_delete, active) VALUES ('observation', ?, 's', 'demo', ?, 1, 1)", key, at);
  }
  assert.deepEqual(exportLocalDeleteTombstones(store).map((m) => m.entity_key), ['obs-a', 'obs-b', 'obs-c']);
  store.db.run("UPDATE sync_delete_tombstones SET superseded_by_sync_id = 'obs-z', hard_delete = 0 WHERE entity_key = 'obs-a'");
  const a = JSON.parse(exportLocalDeleteTombstones(store)[0].payload);
  assert.equal(a.superseded_by_sync_id, 'obs-z');
  assert.equal('hard_delete' in a, false);
});

test('exportReviewClearEvents lista los borrados de fecha de observaciones vivas sin fecha', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/tmp/x');
  const { id } = addObservation(store, { session_id: 's1', type: 'decision', title: 'revisable', content: 'c', project: 'demo' });
  const other = addObservation(store, { session_id: 's1', type: 'manual', title: 'sin fecha', content: 'd', project: 'demo' }).id;
  assert.deepEqual(exportReviewClearEvents(store), []);
  markReviewed(store, other, 'demo');
  assert.deepEqual(exportReviewClearEvents(store), [], 'un tipo sin plazo ya estaba sin fecha: sin evento');
  store.db.run("UPDATE observations SET review_after = NULL WHERE id = ?", id);
  store.db.run("INSERT INTO review_clear_events (event_key, sync_id) VALUES ('k1', ?)", getObservation(store, id).sync_id);
  const events = exportReviewClearEvents(store);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].key, events[0].sync_id], ['k1', getObservation(store, id).sync_id]);
  store.db.run("UPDATE observations SET review_after = '2030-01-01 00:00:00' WHERE id = ?", id);
  assert.deepEqual(exportReviewClearEvents(store), [], 'si recupera una fecha deja de contar');
  store.db.run("UPDATE observations SET review_after = NULL, deleted_at = '2026-01-01 00:00:00' WHERE id = ?", id);
  assert.deepEqual(exportReviewClearEvents(store), [], 'una observación borrada tampoco');
});

test('scanProject sigue operando con relaciones guardadas por el sincronizador', async (t) => {
  const { store } = relationsStore(t);
  const result = await scanProject(store, { project: 'demo' });
  assert.equal(result.already_related, 0);
});
