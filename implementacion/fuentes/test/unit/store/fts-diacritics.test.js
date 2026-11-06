import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  Store, addObservation, addPrompt, createSession, searchObservations, searchPrompts,
} from '../../../src/store/index.js';
import { openTempStore, tempDir } from './helpers.js';

const noLog = () => {};

test('la búsqueda trigram ignora diacríticos en observaciones y prompts', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'proj', '/d');
  const { id } = addObservation(store, { session_id: 's1', type: 'decision', title: 'Configuración del café', content: 'usar canción nueva en la cafetería', project: 'proj' });
  addPrompt(store, { session_id: 's1', content: 'revisa la canción de la cafetería', project: 'proj' });

  assert.deepEqual(searchObservations(store, 'cafe').map((r) => r.id), [id]);
  assert.deepEqual(searchObservations(store, 'café').map((r) => r.id), [id]);
  assert.deepEqual(searchObservations(store, 'configuracion').map((r) => r.id), [id]);
  assert.equal(searchPrompts(store, 'cancion cafeteria', 'proj').length, 1);
  assert.equal(searchPrompts(store, 'canción cafetería', 'proj').length, 1);
});

test('el DDL de FTS declara el tokenizador con diacríticos y los índices de proyecto existen', (t) => {
  const { db } = openTempStore(t);
  for (const table of ['observations_fts', 'prompts_fts']) {
    assert.match(db.get("SELECT sql FROM sqlite_master WHERE name = ?", table).sql, /tokenize='trigram remove_diacritics 1'/);
  }
  const indexes = db.all("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
  assert.ok(indexes.includes('idx_sessions_project_lower'));
  assert.ok(indexes.includes('idx_prompts_project_lower'));
});

test('una base creada con el tokenizador anterior se reconstruye al abrir y busca sin diacríticos', (t) => {
  const dataDir = join(tempDir(t), 'data');
  const old = Store.open({ dataDir, log: noLog });
  createSession(old, 's1', 'proj', '/d');
  const { id } = addObservation(old, { session_id: 's1', type: 'decision', title: 'Decisión sobre el café', content: 'contenido', project: 'proj' });
  addPrompt(old, { session_id: 's1', content: 'ajusta la configuración', project: 'proj' });
  // Esquema de 0.31.0: trigram sin remove_diacritics y sin los índices nuevos.
  old.db.exec(`
    DROP TRIGGER obs_fts_insert; DROP TRIGGER obs_fts_update_insert; DROP TRIGGER obs_fts_update; DROP TRIGGER obs_fts_delete;
    DROP TRIGGER prompt_fts_insert; DROP TRIGGER prompt_fts_update_insert; DROP TRIGGER prompt_fts_update; DROP TRIGGER prompt_fts_delete;
    DROP TABLE observations_fts; DROP TABLE prompts_fts;
    CREATE VIRTUAL TABLE observations_fts USING fts5(title, content, tool_name, type, project, topic_key, tokenize='trigram', content='observations', content_rowid='id');
    CREATE VIRTUAL TABLE prompts_fts USING fts5(content, project, tokenize='trigram', content='user_prompts', content_rowid='id');
    INSERT INTO observations_fts(rowid, title, content, tool_name, type, project, topic_key) SELECT id, title, content, tool_name, type, project, topic_key FROM observations;
    INSERT INTO prompts_fts(rowid, content, project) SELECT id, content, project FROM user_prompts;
    DROP INDEX idx_sessions_project_lower; DROP INDEX idx_prompts_project_lower;
  `);
  old.close();

  const store = Store.open({ dataDir, log: noLog });
  assert.match(store.db.get("SELECT sql FROM sqlite_master WHERE name = 'observations_fts'").sql, /remove_diacritics 1/);
  assert.match(store.db.get("SELECT sql FROM sqlite_master WHERE name = 'prompts_fts'").sql, /remove_diacritics 1/);
  assert.deepEqual(searchObservations(store, 'cafe').map((r) => r.id), [id]);
  assert.equal(searchPrompts(store, 'configuracion', 'proj').length, 1);
  assert.ok(store.db.all("SELECT name FROM sqlite_master WHERE type = 'index'").some((r) => r.name === 'idx_sessions_project_lower'));

  // Idempotente: una segunda apertura no reconstruye ni pierde filas.
  store.close();
  const again = Store.open({ dataDir, log: noLog });
  t.after(() => again.close());
  assert.deepEqual(searchObservations(again, 'cafe').map((r) => r.id), [id]);
});
