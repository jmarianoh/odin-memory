import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addObservation, createSession } from '../../../src/store/index.js';
import { httpWorld } from './helpers.js';

test('GET /doctor devuelve el informe con 200, también cuando el chequeo no existe', async (t) => {
  const w = await httpWorld(t);
  const ok = await w.call('GET', '/doctor');
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, 'ok');
  assert.equal(ok.json.summary.total, 10);
  assert.ok(ok.text.endsWith('}\n'));
  const one = await w.call('GET', '/doctor?check=sqlite_lock_contention');
  assert.deepEqual(one.json.checks.map((c) => c.check_id), ['sqlite_lock_contention']);
  const invalid = await w.call('GET', '/doctor?check=nada');
  assert.equal(invalid.status, 200);
  assert.deepEqual([invalid.json.status, invalid.json.checks[0].check_id], ['error', 'invalid_check']);
});

test('GET /doctor acota por proyecto y valida el parámetro', async (t) => {
  const w = await httpWorld(t);
  createSession(w.store, 's1', 'demo', '/x');
  addObservation(w.store, { session_id: 's1', type: 'manual', title: 't', content: 'c', project: 'demo' });
  assert.equal((await w.call('GET', '/doctor?project=demo')).json.project, 'demo');
  const unknown = await w.call('GET', '/doctor?project=nada');
  assert.equal(unknown.status, 404, unknown.text);
  const blank = await w.call('GET', '/doctor?project=%20');
  assert.equal(blank.status, 400);
  assert.equal((await w.call('POST', '/doctor')).status, 405);
});

test('POST /doctor/caller-binding evalúa el vínculo y rechaza lo mal formado', async (t) => {
  const w = await httpWorld(t);
  createSession(w.store, 'rt', 'demo', '/x');
  const good = await w.call('POST', '/doctor/caller-binding', {
    project: 'demo', runtime_session_id: 'rt', effective_session_id: 'rt', host_context: { append_entry_available: true, branch_available: false },
  });
  assert.equal(good.status, 200, good.text);
  assert.deepEqual(good.json, {
    status: 'ok', root_state: 'active', effective_state: 'active', reason_code: 'binding_observed', safe_next_step: 'No action required; a later write is not guaranteed.', write_success_guaranteed: false,
  });
  const missing = await w.call('POST', '/doctor/caller-binding', { project: 'demo' });
  assert.equal(missing.json.reason_code, 'caller_context_missing');
  const caseInsensitive = await w.call('POST', '/doctor/caller-binding', { PROJECT: 'demo', Runtime_Session_Id: 'rt', effective_session_id: 'rt', host_context: { Append_Entry_Available: true, branch_available: true } });
  assert.equal(caseInsensitive.json.status, 'ok');
  for (const body of ['', 'no json', 'null', '[]', '{"project":1}', '{"extra":1}', '{"host_context":{"extra":true}}', '{"host_context":[]}', '{"host_context":{"branch_available":"si"}}', '{}{}', '{} basura']) {
    const r = await w.call('POST', '/doctor/caller-binding', body);
    assert.deepEqual([r.status, r.json], [400, { error: 'invalid caller-binding request' }], JSON.stringify(body));
  }
  const empty = await w.call('POST', '/doctor/caller-binding', '{}');
  assert.equal(empty.status, 200);
  const big = await w.call('POST', '/doctor/caller-binding', `{"project":"${'x'.repeat(17000)}"}`);
  assert.equal(big.status, 400);
});

test('el contrato de ejecución enlaza mem_doctor con las dos rutas', async (t) => {
  const w = await httpWorld(t);
  const contract = (await w.call('GET', '/runtime-contract')).json;
  assert.deepEqual(contract.operations.mem_doctor.bindings.map((b) => `${b.method} ${b.path}`), ['GET /doctor', 'POST /doctor/caller-binding']);
});
