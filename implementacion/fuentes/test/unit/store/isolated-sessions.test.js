import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addObservation, createSession, deleteObservation, enrollProject, registerIsolatedSession, startSession } from '../../../src/store/index.js';
import { evaluateMutationForRepair } from '../../../src/store/cloud-upgrade.js';
import { backfillProjectSyncMutations } from '../../../src/store/journal.js';
import { repairPendingSessionDirectories } from '../../../src/store/journal-repair.js';
import { openTempStore } from './helpers.js';

const journal = (store, entity, key, payload, { project = 'demo', op = 'upsert' } = {}) => store.db.run(
  "INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, source) VALUES ('cloud', ?, ?, ?, ?, ?, 'local')", entity, key, op, JSON.stringify(payload), project,
);
const sessionMutations = (store) => store.db.all("SELECT entity_key, payload FROM sync_mutations WHERE entity = 'session' AND op = 'upsert' ORDER BY seq").map((r) => ({ ...r, payload: JSON.parse(r.payload) }));

function enrolled(t) {
  const store = openTempStore(t);
  enrollProject(store, 'demo');
  store.db.run('DELETE FROM sync_mutations');
  return store;
}

test('una sesión aislada (project_owned, sin directorio) se encola; una compartida sin directorio no', (t) => {
  const store = enrolled(t);
  registerIsolatedSession(store, 'iso-1', 'demo');
  assert.deepEqual(sessionMutations(store).map((m) => [m.entity_key, m.payload.ownership_mode, m.payload.directory]), [['iso-1', 'project_owned', '']]);

  store.db.run("INSERT INTO sessions (id, project, ownership_mode, directory) VALUES ('shared-sin-dir', 'demo', 'shared', '')");
  startSession(store, 'shared-sin-dir', 'demo', '');
  assert.deepEqual(sessionMutations(store).map((m) => m.entity_key), ['iso-1'], 'la compartida sin directorio no viaja');
});

test('volver a registrar una sesión aislada no repite la mutación', (t) => {
  const store = enrolled(t);
  registerIsolatedSession(store, 'iso-1', 'demo');
  assert.equal(sessionMutations(store).length, 1);
  registerIsolatedSession(store, 'iso-1', 'demo', true);
  assert.equal(sessionMutations(store).length, 1);
});

test('el relleno del diario incluye las sesiones project_owned sin directorio y omite las compartidas sin él', (t) => {
  const store = openTempStore(t);
  store.db.run("INSERT INTO sessions (id, project, ownership_mode, directory) VALUES ('iso', 'demo', 'project_owned', ''), ('sin', 'demo', 'shared', ''), ('con', 'demo', 'shared', '/d')");
  enrollProject(store, 'demo');
  store.db.run('DELETE FROM sync_mutations');
  store.db.writeTransaction((db) => backfillProjectSyncMutations(db, 'demo'));
  assert.deepEqual(sessionMutations(store).map((m) => m.entity_key).sort(), ['con', 'iso']);
});

test('la lápida con un borrado ya acusado no se vuelve a encolar en el relleno', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/d');
  const { id } = addObservation(store, { session_id: 's1', type: 'decision', title: 'A', content: 'c', project: 'demo' });
  enrollProject(store, 'demo');
  deleteObservation(store, id, { hardDelete: true });
  const deletes = () => store.db.all("SELECT seq, acked_at FROM sync_mutations WHERE entity = 'observation' AND op = 'delete'").map((r) => ({ ...r }));
  assert.equal(deletes().length, 1);
  store.db.run("UPDATE sync_mutations SET acked_at = datetime('now') WHERE entity = 'observation' AND op = 'delete'");
  store.db.writeTransaction((db) => backfillProjectSyncMutations(db, 'demo'));
  assert.equal(deletes().length, 1, 'un borrado acusado no se repite');
});

test('la reparación de directorios no toca sesiones project_owned, ni por la carga ni por la sesión local', (t) => {
  const store = openTempStore(t);
  createSession(store, 'local-iso', 'demo', '/work/iso', 'project_owned');
  createSession(store, 'local-shared', 'demo', '/work/demo');
  enrollProject(store, 'demo');
  store.db.run('DELETE FROM sync_mutations');
  journal(store, 'session', 'local-iso', { id: 'local-iso', project: 'demo' });
  journal(store, 'session', 'payload-iso', { id: 'payload-iso', project: 'demo', ownership_mode: 'project_owned' });
  journal(store, 'session', 'local-shared', { id: 'local-shared', project: 'demo' });
  const actions = repairPendingSessionDirectories(store, 'demo', true);
  assert.deepEqual(actions.map((a) => a.entity_key), ['local-shared']);
});

test('la evaluación hereda project_owned de la sesión local cuando la carga no lo trae', (t) => {
  const store = openTempStore(t);
  createSession(store, 'local-iso', 'demo', '', 'project_owned');
  createSession(store, 'local-shared', 'demo', '', 'shared');
  const evaluate = (id, payload, project = 'demo') => store.db.readTransaction((db) => evaluateMutationForRepair(db, {
    seq: 1, target_key: 'cloud', entity: 'session', entity_key: id, op: 'upsert', payload: JSON.stringify(payload), source: 'local', project, occurred_at: '', acked_at: null,
  }));

  const inherited = evaluate('local-iso', { id: 'local-iso', project: 'demo' });
  assert.equal(inherited.canRepair, true);
  assert.equal(JSON.parse(inherited.repairedPayload).ownership_mode, 'project_owned');

  // Un directorio null no se confunde con uno en blanco por la propiedad inferida.
  const nulled = evaluate('local-iso', { id: 'local-iso', project: 'demo', directory: null });
  assert.equal(nulled.canRepair, false);
  assert.match(nulled.finding.message, /directory must be a string/);

  // Con propiedad explícita en la carga no se infiere nada de la sesión local.
  assert.equal(evaluate('local-iso', { id: 'local-iso', project: 'demo', ownership_mode: 'shared' }).canRepair, false);

  // Una sesión local compartida sin directorio sigue sin poder repararse.
  const shared = evaluate('local-shared', { id: 'local-shared', project: 'demo' });
  assert.equal(shared.canRepair, false);
  assert.match(shared.finding.message, /directory is required/);

  // Proyecto de la carga distinto del dueño local: bloqueada.
  const conflict = evaluate('local-iso', { id: 'local-iso', project: 'otro' }, 'demo');
  assert.equal(conflict.canRepair, false);
});
