import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_CHUNK_TARGET_KEY, applyPulledChunk, deleteObservation, addObservation, createSession, getObservation } from '../../../src/store/index.js';
import { newMutation } from '../../../src/store/sync-chunks.js';
import { openTempStore } from './helpers.js';

const T = LOCAL_CHUNK_TARGET_KEY;
const mutation = (entity, key, op, payload) => newMutation({ entity, entity_key: key, op, payload: JSON.stringify(payload), project: '' });
const session = () => mutation('session', 's1', 'upsert', { id: 's1', project: 'demo', directory: '/tmp/x', started_at: '2026-01-01 10:00:00' });
const observation = (syncId, extra = {}) => mutation('observation', syncId, 'upsert', {
  sync_id: syncId, session_id: 's1', type: 'decision', title: 'Título', content: 'contenido', project: 'demo', scope: 'project', revision_count: 1, duplicate_count: 1,
  created_at: '2026-01-01 10:00:00', updated_at: '2026-01-01 10:00:00', ...extra,
});
const softDelete = (syncId, deletedAt) => mutation('observation', syncId, 'delete', { sync_id: syncId, session_id: 's1', project: 'demo', deleted: true, deleted_at: deletedAt });
const row = (store, syncId) => store.db.get('SELECT deleted_at, title FROM observations WHERE sync_id = ?', syncId);

test('un snapshot local obsoleto no resucita una observación con borrado suave', (t) => {
  const store = openTempStore(t);
  applyPulledChunk(store, T, 'c1', [session(), observation('obs-1')]);
  applyPulledChunk(store, T, 'c2', [softDelete('obs-1', '2026-02-01 10:00:00')]);
  assert.equal(row(store, 'obs-1').deleted_at, '2026-02-01 10:00:00');

  // Generación anterior o igual al borrado: sigue borrada y sin cambios.
  applyPulledChunk(store, T, 'c3', [observation('obs-1', { updated_at: '2026-01-15 10:00:00', title: 'Obsoleta' })]);
  assert.deepEqual({ ...row(store, 'obs-1') }, { deleted_at: '2026-02-01 10:00:00', title: 'Título' });
  applyPulledChunk(store, T, 'c4', [observation('obs-1', { updated_at: '2026-02-01 10:00:00', title: 'Igual' })]);
  assert.equal(row(store, 'obs-1').deleted_at, '2026-02-01 10:00:00');

  // Una generación posterior sí la restaura.
  applyPulledChunk(store, T, 'c5', [observation('obs-1', { updated_at: '2026-03-01 10:00:00', title: 'Restaurada' })]);
  assert.deepEqual({ ...row(store, 'obs-1') }, { deleted_at: null, title: 'Restaurada' });
});

test('una observación viva se actualiza con normalidad y una borrada localmente no vuelve con un snapshot anterior', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/tmp/x');
  const { id } = addObservation(store, { session_id: 's1', type: 'decision', title: 'Local', content: 'contenido', project: 'demo' });
  const syncId = getObservation(store, id).sync_id;
  applyPulledChunk(store, T, 'c1', [observation(syncId, { updated_at: '2026-01-02 10:00:00', title: 'Remota' })]);
  assert.equal(row(store, syncId).title, 'Remota');

  deleteObservation(store, id);
  const deletedAt = row(store, syncId).deleted_at;
  assert.ok(deletedAt);
  applyPulledChunk(store, T, 'c2', [observation(syncId, { updated_at: '2026-01-03 10:00:00', title: 'Vieja' })]);
  assert.equal(row(store, syncId).deleted_at, deletedAt, 'el snapshot anterior al borrado local no la restaura');
});
