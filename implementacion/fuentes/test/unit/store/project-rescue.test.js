import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addObservation, addPrompt, createSession, getSession, rescueNullProjectOwnership } from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

function orphaned(t) {
  const store = openTempStore(t);
  createSession(store, 'manual-save-demo', 'demo', '/tmp/x');
  createSession(store, 's1', 'demo', '/tmp/x');
  createSession(store, 's2', 'otro', '/tmp/y');
  const o1 = addObservation(store, { session_id: 's1', type: 'manual', title: 'uno', content: 'a', project: 'demo' }).id;
  const o2 = addObservation(store, { session_id: 's1', type: 'manual', title: 'dos', content: 'b', project: 'demo' }).id;
  const o3 = addObservation(store, { session_id: 's2', type: 'manual', title: 'tres', content: 'c', project: 'otro' }).id;
  const p1 = addPrompt(store, { session_id: 's1', content: 'prompt', project: 'demo' }).id;
  store.db.run("UPDATE observations SET project = NULL WHERE id IN (?, ?)", o1, o2);
  store.db.run("UPDATE user_prompts SET project = NULL");
  store.db.run("UPDATE sessions SET project = '' WHERE id IN ('s1', 'manual-save-demo')");
  store.db.run("UPDATE sessions SET ownership_mode = NULL WHERE id IN ('s1', 'manual-save-demo')");
  return { store, o1, o2, o3, p1 };
}

const run = (store, extra) => rescueNullProjectOwnership(store, { target_project: 'demo', ...extra });

test('rescata sesiones, observaciones y prompts sin dueño y marca el modo de propiedad', (t) => {
  const { store, o1, o2, p1 } = orphaned(t);
  const result = run(store, { session_ids: ['s1', 'manual-save-demo'], observation_ids: [o1], prompt_ids: [p1] });
  assert.deepEqual(result, {
    rescued_observations: 1, rescued_sessions: 2, rescued_prompts: 1, conflicting_records: 0, skipped_records: 0, journaled: false, complete: true, blocked: [],
  });
  assert.deepEqual([getSession(store, 's1').project, getSession(store, 's1').ownership_mode], ['demo', 'shared']);
  assert.equal(getSession(store, 'manual-save-demo').ownership_mode, 'project_owned', 'la sesión de guardado manual del proyecto es suya');
  assert.equal(store.db.get('SELECT project FROM observations WHERE id = ?', o1).project, 'demo');
  assert.equal(store.db.get('SELECT project FROM observations WHERE id = ?', o2).project, null, 'lo no seleccionado no se mueve');
  assert.equal(store.db.get('SELECT project FROM user_prompts WHERE id = ?', p1).project, 'demo');
});

test('registros sueltos reclaman su sesión; repetir cuenta lo ya asignado como omitido', (t) => {
  const { store, o1, p1 } = orphaned(t);
  const first = run(store, { observation_ids: [o1] });
  assert.deepEqual([first.rescued_sessions, first.rescued_observations, first.rescued_prompts, first.complete], [1, 1, 0, true]);
  assert.equal(getSession(store, 's1').project, 'demo');
  const second = run(store, { observation_ids: [o1], session_ids: ['s1'], prompt_ids: [p1] });
  assert.deepEqual([second.rescued_observations, second.rescued_sessions, second.rescued_prompts, second.skipped_records], [0, 0, 1, 2]);
});

test('lo que pertenece a otro proyecto o no existe queda bloqueado con su motivo', (t) => {
  const { store, o1, o3 } = orphaned(t);
  const result = run(store, { observation_ids: [o1, o3, 999], session_ids: ['s2', 'nada'], prompt_ids: [888] });
  assert.equal(result.complete, false);
  assert.deepEqual(result.blocked, [
    { kind: 'session', id: 's2', reason: 'owned_by_other_project', owned_by: 'otro' },
    { kind: 'session', id: 'nada', reason: 'missing' },
    { kind: 'observation', id: String(o3), reason: 'owned_by_other_project', owned_by: 'otro' },
    { kind: 'observation', id: '999', reason: 'missing' },
    { kind: 'prompt', id: '888', reason: 'missing' },
  ]);
  assert.deepEqual([result.rescued_observations, result.rescued_sessions, result.conflicting_records, result.skipped_records], [1, 1, 2, 3]);
});

test('una sesión con registros hijos de otro proyecto no se reclama', (t) => {
  const { store, o1 } = orphaned(t);
  store.db.run("UPDATE observations SET project = 'ajeno' WHERE session_id = 's1' AND id != ?", o1);
  const result = run(store, { session_ids: ['s1'], observation_ids: [o1] });
  assert.deepEqual(result.blocked, [
    { kind: 'session', id: 's1', reason: 'dependent_record_owned_by_other_project', owned_by: 'ajeno' },
    { kind: 'observation', id: String(o1), reason: 'session_owned_by_other_project' },
  ]);
  assert.equal(getSession(store, 's1').project, '');
  assert.equal(result.conflicting_records, 2);
});

test('valida la petición', (t) => {
  const store = openTempStore(t);
  assert.throws(() => rescueNullProjectOwnership(store, { target_project: '  ', session_ids: ['s'] }), { code: 'project_required' });
  assert.throws(() => rescueNullProjectOwnership(store, { target_project: 'demo' }), { code: 'project_rescue_invalid_request', message: 'project rescue request is invalid: at least one record id is required' });
  assert.throws(() => run(store, { observation_ids: [0] }), { message: 'project rescue request is invalid: record ids must be positive' });
  assert.throws(() => run(store, { prompt_ids: [-1] }), { message: 'project rescue request is invalid: record ids must be positive' });
  assert.throws(() => run(store, { session_ids: ['  '] }), { message: 'project rescue request is invalid: session ids must not be blank' });
});

test('mover registros de un proyecto inscrito sin diario revierte el rescate', (t) => {
  const { store, o1 } = orphaned(t);
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('demo')");
  assert.throws(() => run(store, { observation_ids: [o1] }), { code: 'sync_journal_unavailable' });
  assert.equal(store.db.get('SELECT project FROM observations WHERE id = ?', o1).project, null);
  assert.equal(getSession(store, 's1').project, '');
  const nothing = run(store, { observation_ids: [999] });
  assert.equal(nothing.rescued_observations, 0, 'si no se mueve nada no hace falta diario');
});
