import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudSyncSummary, getSyncState, markSyncAuthRequired, markSyncBlocked, markSyncFailure, markSyncHealthy, markSyncPaused, markSyncPending,
} from '../../../src/store/sync-state.js';
import { enrollProject, hasPendingSyncMutationsForProject, unenrollProject } from '../../../src/store/enrollment.js';
import { addObservation, createSession } from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const fields = (store, key) => {
  const { lifecycle, consecutive_failures: failures, backoff_until: backoff, reason_code: code, reason_message: message, last_error: error, last_success_at: success } = getSyncState(store, key);
  return { lifecycle, failures, backoff, code, message, error, success: success !== null && success !== undefined };
};

test('un destino pasa de pendiente a sano, a fallo y a bloqueado', (t) => {
  const store = openTempStore(t);
  enrollProject(store, 'demo');
  const key = 'cloud:demo';
  assert.equal(fields(store, key).lifecycle, 'idle');

  markSyncPending(store, key);
  assert.deepEqual(fields(store, key), { lifecycle: 'pending', failures: 0, backoff: null, code: null, message: null, error: null, success: false });

  markSyncFailure(store, key, 'sin red', new Date('2030-01-02T03:04:05.678Z'));
  assert.deepEqual(fields(store, key), { lifecycle: 'degraded', failures: 1, backoff: '2030-01-02T03:04:05Z', code: 'transport_failed', message: 'sin red', error: 'sin red', success: false });
  markSyncFailure(store, key, 'otra vez', new Date('2030-01-02T03:04:35Z'), '  ');
  assert.equal(fields(store, key).failures, 2, 'cada fallo suma');
  markSyncFailure(store, key, 'x', new Date('2030-01-02T03:04:35Z'), 'custom');
  assert.equal(fields(store, key).code, 'custom');

  markSyncBlocked(store, key, 'blocked_unenrolled', 'no inscrito');
  assert.deepEqual(fields(store, key), { lifecycle: 'degraded', failures: 0, backoff: null, code: 'blocked_unenrolled', message: 'no inscrito', error: 'no inscrito', success: false });
  markSyncPaused(store, key, 'en pausa');
  assert.equal(fields(store, key).code, 'paused');
  markSyncAuthRequired(store, key, 'falta token');
  assert.equal(fields(store, key).code, 'auth_required');

  markSyncHealthy(store, key);
  assert.deepEqual(fields(store, key), { lifecycle: 'healthy', failures: 0, backoff: null, code: null, message: null, error: null, success: true });
  markSyncPending(store, key);
  const pending = fields(store, key);
  assert.equal(pending.lifecycle, 'pending');
  assert.equal(pending.success, true, 'pasar a pendiente conserva el último éxito');
});

test('el buzón de entrada nunca cambia de estado y un destino nuevo se crea al marcarlo', (t) => {
  const store = openTempStore(t);
  markSyncFailure(store, 'cloud:inbox', 'x', new Date());
  markSyncBlocked(store, 'cloud:inbox', 'c', 'x');
  markSyncHealthy(store, 'cloud:inbox');
  markSyncPending(store, 'cloud:inbox');
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_state WHERE target_key = 'cloud:inbox' AND lifecycle <> 'inbox'").n, 0);
  markSyncPending(store, ' Cloud:Nuevo ');
  assert.equal(store.db.get("SELECT lifecycle FROM sync_state WHERE target_key = 'cloud:nuevo'").lifecycle, 'pending', 'la clave se normaliza');
});

test('el resumen de la nube agrega solo los destinos por proyecto', (t) => {
  const store = openTempStore(t);
  assert.deepEqual(cloudSyncSummary(store), { last_success_at: '', last_error: '', reason_code: '', pending_mutations: 0 });
  enrollProject(store, 'a');
  enrollProject(store, 'b');
  markSyncHealthy(store, 'cloud:a');
  markSyncFailure(store, 'cloud:b', 'caído', new Date());
  markSyncFailure(store, 'cloud', 'global', new Date());
  markSyncFailure(store, 'cloud:inbox', 'ignorado', new Date());
  const summary = cloudSyncSummary(store);
  assert.equal(summary.last_error, 'caído', 'ni el destino global ni el buzón cuentan');
  assert.equal(summary.reason_code, 'transport_failed');
  assert.notEqual(summary.last_success_at, '');

  createSession(store, 's1', 'a', '/tmp/x');
  addObservation(store, { session_id: 's1', type: 'manual', title: 't', content: 'c', project: 'a' });
  assert.equal(cloudSyncSummary(store).pending_mutations, 0, 'las mutaciones del destino global no cuentan en el resumen por proyecto');
  assert.equal(hasPendingSyncMutationsForProject(store, 'a'), true);
  store.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project) VALUES ('cloud:a', 'observation', 'obs-1', 'upsert', '{}', 'local', 'a')");
  assert.equal(cloudSyncSummary(store).pending_mutations, 1);
  assert.equal(hasPendingSyncMutationsForProject(store, 'b'), false);
  assert.equal(hasPendingSyncMutationsForProject(store, ''), false);
  unenrollProject(store, 'a');
  assert.equal(cloudSyncSummary(store).pending_mutations, 0, 'un proyecto sin inscribir no cuenta como pendiente');
});
