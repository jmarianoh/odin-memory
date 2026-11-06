import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addObservation, consolidateObservations, createSession, deleteObservation, deleteProject, updateObservation,
} from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

// Marca de la aplicación: `YYYY-MM-DD HH:MM:SS.fffffffff` (9 decimales); la corta de SQLite no lleva decimales.
const APP_TIMESTAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{9}$/;

function seed(t) {
  const store = openTempStore(t);
  createSession(store, 's1', 'proj', '/d');
  const save = (title, extra = {}) => addObservation(store, { session_id: 's1', type: 'decision', title, content: `contenido de ${title}`, project: 'proj', ...extra }).id;
  return { store, save };
}
const row = (store, id) => store.db.get('SELECT deleted_at, updated_at FROM observations WHERE id = ?', id);

test('el borrado suave marca deleted_at y updated_at con la misma marca de la aplicación', (t) => {
  const { store, save } = seed(t);
  const id = save('A');
  deleteObservation(store, id);
  const { deleted_at: deletedAt, updated_at: updatedAt } = row(store, id);
  assert.match(deletedAt, APP_TIMESTAMP);
  assert.equal(updatedAt, deletedAt);
  const journaled = JSON.parse(store.db.get("SELECT payload FROM sync_mutations WHERE entity = 'observation' AND op = 'delete'")?.payload ?? 'null');
  assert.ok(journaled === null || journaled.deleted_at === deletedAt, 'el diario lleva la misma marca');
});

test('actualizar, repetir por topic_key y duplicar usan la marca de la aplicación en updated_at', (t) => {
  const { store, save } = seed(t);
  const id = save('A');
  updateObservation(store, id, { content: 'nuevo contenido' });
  assert.match(row(store, id).updated_at, APP_TIMESTAMP);

  const keyed = save('B', { topic_key: 'decision/b' });
  store.db.run("UPDATE observations SET updated_at = datetime('now', '-1 day') WHERE id = ?", keyed);
  save('B2', { topic_key: 'decision/b', content: 'otra versión' });
  assert.match(row(store, keyed).updated_at, APP_TIMESTAMP);

  const dup = save('C');
  store.db.run("UPDATE observations SET updated_at = datetime('now', '-1 day') WHERE id = ?", dup);
  save('C');
  assert.match(row(store, dup).updated_at, APP_TIMESTAMP);
});

test('borrar un proyecto y consolidar marcan deleted_at con la marca de la aplicación', (t) => {
  const { store, save } = seed(t);
  const a = save('A');
  const b = save('B');
  const { plan } = consolidateObservations(store, { ids: [a, b] });
  consolidateObservations(store, { ids: [a, b], confirm: true, fingerprint: plan.fingerprint });
  for (const id of [a, b]) {
    const { deleted_at: deletedAt, updated_at: updatedAt } = row(store, id);
    assert.match(deletedAt, APP_TIMESTAMP);
    assert.equal(updatedAt, deletedAt);
  }
  const c = save('C');
  deleteProject(store, 'proj');
  const { deleted_at: deletedAt, updated_at: updatedAt } = row(store, c);
  assert.match(deletedAt, APP_TIMESTAMP);
  assert.equal(updatedAt, deletedAt);
});
