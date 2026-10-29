import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPrompt, createSession, deletePrompt, recentPrompts, searchPrompts } from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const code = (c) => (err) => err.code === c;

function setup(t) {
  const store = openTempStore(t);
  createSession(store, 's1', 'proj', '/d');
  return store;
}

test('addPrompt guarda con proyecto heredado, sync_id y contenido saneado', (t) => {
  const store = setup(t);
  const { id, inserted } = addPrompt(store, { session_id: 's1', content: 'usa la clave <private>abc</private> hoy' });
  assert.equal(inserted, true);
  const row = store.db.get('SELECT * FROM user_prompts WHERE id = ?', id);
  assert.match(row.sync_id, /^prompt-[0-9a-f]{16}$/);
  assert.equal(row.content, 'usa la clave [REDACTED] hoy');
  assert.equal(row.project, 'proj');
  assert.equal(row.source_inbox_id, null);
  assert.equal(row.local_creation_session_id, null);
});

test('addPrompt valida contenido y propiedad de sesión', (t) => {
  const store = setup(t);
  assert.throws(() => addPrompt(store, { session_id: 's1', content: '   ' }), code('prompt_content_required'));
  createSession(store, 'dueña', 'a', '/d', 'project_owned');
  assert.throws(() => addPrompt(store, { session_id: 'dueña', content: 'x', project: 'b' }), code('session_ownership_mismatch'));
  assert.throws(() => addPrompt(store, { session_id: 'no-existe', content: 'x' }), code('project_required'));
});

test('source_inbox_id hace la inserción idempotente y recuerda el origen local', (t) => {
  const store = setup(t);
  const a = addPrompt(store, { session_id: 's1', content: 'primero', source_inbox_id: 'inbox-1' });
  const b = addPrompt(store, { session_id: 's1', content: 'segundo distinto', source_inbox_id: 'inbox-1' });
  assert.equal(a.inserted, true);
  assert.deepEqual(b, { id: a.id, inserted: false });
  assert.equal(store.db.get('SELECT count(*) AS n FROM user_prompts').n, 1);
  const row = store.db.get('SELECT * FROM user_prompts WHERE id = ?', a.id);
  assert.deepEqual(
    [row.source_inbox_id, row.local_creation_session_id, row.local_creation_inbox_id, row.local_creation_project],
    ['inbox-1', 's1', 'inbox-1', 'proj'],
  );
});

test('recentPrompts filtra por proyecto normalizado y respeta el límite', (t) => {
  const store = setup(t);
  createSession(store, 's2', 'otro', '/d');
  addPrompt(store, { session_id: 's1', content: 'uno' });
  addPrompt(store, { session_id: 's2', content: 'dos' });
  addPrompt(store, { session_id: 's1', content: 'tres' });
  assert.equal(recentPrompts(store).length, 3);
  assert.deepEqual(recentPrompts(store, 'PROJ').map((p) => p.content).sort(), ['tres', 'uno']);
  assert.equal(recentPrompts(store, '', 1).length, 1);
  assert.deepEqual(Object.keys(recentPrompts(store)[0]).sort(), ['content', 'created_at', 'id', 'project', 'session_id', 'sync_id']);
});

test('searchPrompts: FTS con subcadenas, LIKE para términos cortos y filtro de proyecto exacto', (t) => {
  const store = setup(t);
  createSession(store, 's2', 'otro', '/d');
  const a = addPrompt(store, { session_id: 's1', content: 'refactoriza el módulo de pagos' }).id;
  const b = addPrompt(store, { session_id: 's2', content: 'documenta la API de pagos' }).id;
  assert.deepEqual(searchPrompts(store, 'factoriz').map((p) => p.id), [a]);
  assert.deepEqual(searchPrompts(store, 'pagos').map((p) => p.id).sort(), [a, b].sort());
  assert.deepEqual(searchPrompts(store, 'pagos', 'otro').map((p) => p.id), [b]);
  assert.deepEqual(searchPrompts(store, 'pagos', 'OTRO'), []); // no se normaliza
  assert.deepEqual(searchPrompts(store, 'de API').map((p) => p.id), [b]); // 'de' es corto → LIKE
  assert.deepEqual(searchPrompts(store, 'nada que ver'), []);
});

test('deletePrompt borra, deja lápida y rechaza ids inexistentes', (t) => {
  const store = setup(t);
  const { id } = addPrompt(store, { session_id: 's1', content: 'para borrar', source_inbox_id: 'inbox-9' });
  const syncId = store.db.get('SELECT sync_id FROM user_prompts WHERE id = ?', id).sync_id;
  deletePrompt(store, id);
  assert.equal(store.db.get('SELECT count(*) AS n FROM user_prompts').n, 0);
  assert.equal(searchPrompts(store, 'borrar').length, 0);
  const tomb = store.db.get('SELECT * FROM prompt_tombstones WHERE sync_id = ?', syncId);
  assert.deepEqual(
    [tomb.session_id, tomb.project, tomb.source_inbox_id, tomb.local_creation_session_id, tomb.local_creation_inbox_id, tomb.local_creation_project],
    ['s1', 'proj', 'inbox-9', 's1', 'inbox-9', 'proj'],
  );
  assert.throws(() => deletePrompt(store, id), code('prompt_not_found'));
  // la identidad de bandeja borrada no puede reutilizarse
  assert.throws(() => addPrompt(store, { session_id: 's1', content: 'otra vez', source_inbox_id: 'inbox-9' }), code('prompt_inbox_deleted'));
});

test('un prompt sin bandeja no guarda procedencia local en la lápida', (t) => {
  const store = setup(t);
  const { id } = addPrompt(store, { session_id: 's1', content: 'simple' });
  const syncId = store.db.get('SELECT sync_id FROM user_prompts WHERE id = ?', id).sync_id;
  deletePrompt(store, id);
  const tomb = store.db.get('SELECT * FROM prompt_tombstones WHERE sync_id = ?', syncId);
  assert.deepEqual([tomb.local_creation_session_id, tomb.source_inbox_id], [null, null]);
});

test('un prompt de un proyecto inscrito se anota en el diario y uno de un proyecto sin inscribir no', (t) => {
  const store = setup(t);
  addPrompt(store, { session_id: 's1', content: 'sin inscribir' });
  assert.equal(store.db.get("SELECT count(*) AS n FROM sync_mutations WHERE entity = 'prompt'").n, 0);
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('proj')");
  const { id } = addPrompt(store, { session_id: 's1', content: 'inscrito' });
  const rows = store.db.all("SELECT target_key, entity, op, source, project, payload FROM sync_mutations WHERE entity = 'prompt'");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].target_key, rows[0].op, rows[0].source, rows[0].project], ['cloud', 'upsert', 'local', 'proj']);
  assert.equal(JSON.parse(rows[0].payload).content, 'inscrito');
  assert.equal(store.db.get('SELECT content FROM user_prompts WHERE id = ?', id).content, 'inscrito');
});
