import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../../../src/store/index.js';
import { openTempStore, tempDir } from './helpers.js';

const noLog = () => {};

function seed(db) {
  db.run("INSERT INTO sessions (id, project, directory) VALUES ('s', 'proj', '/d')");
  return db.run(
    "INSERT INTO observations (session_id, type, title, content, project) VALUES ('s', 'decision', 'Arquitectura hexagonal', 'separar puertos y adaptadores', 'proj')",
  ).lastInsertRowid;
}

const search = (db, term) =>
  db.all('SELECT rowid FROM observations_fts WHERE observations_fts MATCH ? ORDER BY rowid', `"${term}"`).map((r) => Number(r.rowid));

test('la búsqueda trigram encuentra subcadenas y los triggers mantienen el índice', (t) => {
  const { db } = openTempStore(t);
  const id = Number(seed(db));
  assert.deepEqual(search(db, 'tectu'), [id]);
  assert.deepEqual(search(db, 'adaptad'), [id]);

  db.run("UPDATE observations SET title = 'Persistencia' WHERE id = ?", id);
  assert.deepEqual(search(db, 'tectu'), []);
  assert.deepEqual(search(db, 'sisten'), [id]);

  db.run("UPDATE observations SET deleted_at = datetime('now') WHERE id = ?", id);
  assert.deepEqual(search(db, 'sisten'), []);

  db.run('UPDATE observations SET deleted_at = NULL WHERE id = ?', id);
  assert.deepEqual(search(db, 'sisten'), [id]);

  db.run('DELETE FROM observations WHERE id = ?', id);
  assert.deepEqual(search(db, 'sisten'), []);
});

test('prompts_fts sigue los cambios de user_prompts', (t) => {
  const { db } = openTempStore(t);
  db.run("INSERT INTO sessions (id, project, directory) VALUES ('s', 'proj', '/d')");
  const id = Number(db.run("INSERT INTO user_prompts (session_id, content, project) VALUES ('s', 'refactoriza el módulo de pagos', 'proj')").lastInsertRowid);
  const find = (term) => db.all('SELECT rowid FROM prompts_fts WHERE prompts_fts MATCH ?', `"${term}"`).map((r) => Number(r.rowid));
  assert.deepEqual(find('factoriz'), [id]);
  db.run("UPDATE user_prompts SET content = 'documenta la API' WHERE id = ?", id);
  assert.deepEqual(find('factoriz'), []);
  assert.deepEqual(find('documen'), [id]);
  db.run('DELETE FROM user_prompts WHERE id = ?', id);
  assert.deepEqual(find('documen'), []);
});

test('al abrir se reconstruyen los triggers de FTS que faltan o difieren y se repuebla el índice', (t) => {
  const dataDir = join(tempDir(t), 'data');
  const first = Store.open({ dataDir, log: noLog });
  const id = Number(seed(first.db));
  first.db.exec('DROP TRIGGER obs_fts_insert; DROP TRIGGER obs_fts_update_insert;');
  // Observación escrita sin triggers: no entra en el índice hasta la reconstrucción.
  first.db.run(
    "INSERT INTO observations (session_id, type, title, content, project) VALUES ('s', 'bugfix', 'Corrección de bloqueo', 'reintentos ante contención', 'proj')",
  );
  first.close();

  const store = Store.open({ dataDir, log: noLog });
  t.after(() => store.close());
  const triggers = store.db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").map((r) => r.name);
  assert.ok(triggers.includes('obs_fts_insert'));
  assert.ok(triggers.includes('obs_fts_update_insert'));
  assert.deepEqual(search(store.db, 'tectu'), [id]);
  assert.equal(search(store.db, 'contenc').length, 1);
});

test('una tabla FTS con otro tokenizador se reconstruye', (t) => {
  const dataDir = join(tempDir(t), 'data');
  const first = Store.open({ dataDir, log: noLog });
  const id = Number(seed(first.db));
  first.db.exec(`
    DROP TRIGGER obs_fts_insert; DROP TRIGGER obs_fts_update_insert; DROP TRIGGER obs_fts_update; DROP TRIGGER obs_fts_delete;
    DROP TABLE observations_fts;
    CREATE VIRTUAL TABLE observations_fts USING fts5(title, content, tool_name, type, project, topic_key, content='observations', content_rowid='id');
  `);
  first.close();
  const store = Store.open({ dataDir, log: noLog });
  t.after(() => store.close());
  assert.match(store.db.get("SELECT sql FROM sqlite_master WHERE name = 'observations_fts'").sql, /trigram/);
  assert.deepEqual(search(store.db, 'tectu'), [id]);
});
