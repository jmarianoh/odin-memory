import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfillLegacySessionOwnershipModes, manualSaveOwnerProject } from '../../../src/store/migrate.js';
import { Store } from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const mode = (store, id) => store.db.get('SELECT ownership_mode AS mode FROM sessions WHERE id = ?', id).mode;

test('manualSaveOwnerProject canonicaliza ambos lados y exige el prefijo exacto', () => {
  assert.equal(manualSaveOwnerProject('manual-save-demo', 'demo'), true);
  assert.equal(manualSaveOwnerProject('manual-save-Mi--Proyecto', 'mi-proyecto'), true);
  assert.equal(manualSaveOwnerProject('manual-save-demo', 'otro'), false);
  assert.equal(manualSaveOwnerProject('Manual-Save-demo', 'demo'), false);
  assert.equal(manualSaveOwnerProject('manual-save-demo', ''), false);
  assert.equal(manualSaveOwnerProject('sesion', 'demo'), false);
});

test('las filas anteriores a la columna de propiedad se clasifican de forma determinista', (t) => {
  const store = openTempStore(t);
  const insert = (id, project) => store.db.run("INSERT INTO sessions (id, project, directory, started_at) VALUES (?, ?, '/x', '2026-01-01 00:00:00')", id, project);
  insert('normal', 'demo');
  insert('manual-save-demo', 'demo');
  insert('manual-save-Demo', 'demo');
  insert('manual-save-otro', 'demo');
  insert('MANUAL-SAVE-x', 'demo');
  insert('sin-proyecto', '   ');
  insert('ya-clasificada', 'demo');
  store.db.run("UPDATE sessions SET ownership_mode = 'project_owned' WHERE id = 'ya-clasificada'");
  store.db.run('UPDATE sessions SET ownership_mode = NULL WHERE id != ?', 'ya-clasificada');
  backfillLegacySessionOwnershipModes(store.db);
  assert.deepEqual(['normal', 'manual-save-demo', 'manual-save-Demo', 'manual-save-otro', 'MANUAL-SAVE-x', 'sin-proyecto', 'ya-clasificada'].map((id) => mode(store, id)), [
    'shared', 'project_owned', 'project_owned', null, null, null, 'project_owned',
  ]);
  backfillLegacySessionOwnershipModes(store.db);
  // LIKE no distingue mayúsculas: 'MANUAL-SAVE-x' cuenta como guardado manual y, sin dueño demostrable, queda sin clasificar.
  assert.equal(mode(store, 'manual-save-otro'), null, 'es idempotente y nunca infiere la propiedad solo por el ID');
});

test('abrir el almacén clasifica las filas sin modo', (t) => {
  const store = openTempStore(t);
  store.db.run("INSERT INTO sessions (id, project, directory, started_at) VALUES ('vieja', 'demo', '/x', '2026-01-01 00:00:00')");
  store.close();
  const reopened = Store.open({ dataDir: store.config.dataDir, log: () => {} });
  t.after(() => reopened.close());
  assert.equal(mode(reopened, 'vieja'), 'shared');
});
