import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addObservation, createSession } from '../../../src/store/index.js';
import { httpWorld } from './helpers.js';

const AUTH = { Authorization: 'Bearer secreto' };

test('replay de relaciones diferidas sin pendientes devuelve ceros', async (t) => {
  const w = await httpWorld(t);
  const r = await w.call('POST', '/conflicts/deferred/replay', {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { retried: 0, succeeded: 0, failed: 0, dead: 0 });
  assert.equal((await w.call('GET', '/conflicts/deferred/replay')).status, 405);
});

test('rescue-ownership exige un token configurado aunque la ruta sea de escritura', async (t) => {
  const w = await httpWorld(t);
  const sin = await w.call('POST', '/projects/rescue-ownership', { target_project: 'demo', confirmed: true, session_ids: ['s1'] });
  assert.equal(sin.status, 503, sin.text);
  assert.deepEqual(sin.json, { error: 'server authorization is not configured' });

  w.env.ODIN_HTTP_TOKEN = 'secreto';
  const anonimo = await w.call('POST', '/projects/rescue-ownership', { target_project: 'demo', confirmed: true, session_ids: ['s1'] });
  assert.equal(anonimo.status, 401);
});

test('rescue-ownership valida la petición', async (t) => {
  const w = await httpWorld(t, { env: { ODIN_HTTP_TOKEN: 'secreto' } });
  const post = (body) => w.call('POST', '/projects/rescue-ownership', body, AUTH);
  assert.deepEqual((await post('no json')).json, { error: 'invalid JSON' });
  assert.deepEqual((await post({ target_project: 'demo', extra: 1, confirmed: 'si' })).json, { error: 'invalid JSON' });
  assert.deepEqual((await post({ confirmed: true, session_ids: ['s'] })).json, { error: 'target_project is required' });
  assert.deepEqual((await post({ target_project: 'demo', session_ids: ['s'] })).json, { error: 'confirmed must be true' });
  assert.deepEqual((await post({ target_project: 'demo', confirmed: false, session_ids: ['s'] })).json, { error: 'confirmed must be true' });
  const vacio = await post({ target_project: 'demo', confirmed: true });
  assert.equal(vacio.status, 400);
  assert.equal(vacio.json.error, 'invalid ownership rescue request: provide a target project and at least one positive record ID or non-blank session ID');
  const grande = await post({ target_project: 'demo', confirmed: true, session_ids: ['x'.repeat(9000)] });
  assert.deepEqual(grande.json, { error: 'invalid JSON' });
});

test('rescue-ownership asigna el proyecto, avisa de la escritura y reporta lo bloqueado', async (t) => {
  const w = await httpWorld(t, { env: { ODIN_HTTP_TOKEN: 'secreto' } });
  createSession(w.store, 'huerfana', 'tmp', '/tmp/x');
  const { id } = addObservation(w.store, { session_id: 'huerfana', type: 'manual', title: 'Huérfana', content: 'sin proyecto', project: 'tmp' });
  w.store.db.run("UPDATE sessions SET project = '', ownership_mode = NULL WHERE id = 'huerfana'");
  w.store.db.run('UPDATE observations SET project = NULL WHERE id = ?', id);
  const before = w.writes.length;
  const r = await w.call('POST', '/projects/rescue-ownership', { target_project: 'Demo-Rescate', confirmed: true, session_ids: ['huerfana'], observation_ids: [id] }, AUTH);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, {
    status: 'rescued', complete: true, blocked: [], target_project: 'demo-rescate', rescued_observations: 1, rescued_sessions: 1, rescued_prompts: 0,
    conflicting_records: 0, skipped_records: 0, journaled_local: false, reconciliation_status: 'local journal pending autosync',
  });
  assert.equal(w.writes.length, before + 1);
  assert.equal(w.store.db.get('SELECT project FROM observations WHERE id = ?', id).project, 'demo-rescate');

  const parcial = await w.call('POST', '/projects/rescue-ownership', { target_project: 'demo-rescate', confirmed: true, observation_ids: [id, 9999] }, AUTH);
  assert.equal(parcial.status, 200, parcial.text);
  assert.equal(parcial.json.status, 'partially_rescued');
  assert.equal(parcial.json.complete, false);
  assert.ok(parcial.json.blocked.length >= 1);
  assert.deepEqual(Object.keys(parcial.json.blocked[0]).sort(), ['id', 'kind', 'reason'], 'owned_by solo aparece si hay dueño');
  assert.equal(w.writes.length, before + 1, 'sin cambios no hay aviso de escritura');
});

test('migrate comparte el manejador del rescate', async (t) => {
  const w = await httpWorld(t, { env: { ODIN_HTTP_TOKEN: 'secreto' } });
  const r = await w.call('POST', '/projects/migrate', { target_project: 'demo', confirmed: true }, AUTH);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /^invalid ownership rescue request/);
});
