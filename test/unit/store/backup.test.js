import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addObservation, addPrompt, createSession, deleteObservation, deletePrompt, deleteSession, endSession, exportData, exportProject, exportToJsonValue,
  findCandidates, importData, isStalePromptUpsert, judgeRelation, normalizeComparableTimestamp, parseExportData, pinObservation, toGoJson,
} from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const code = (c) => (err) => err.code === c;
const roundtrip = (store, project) => exportToJsonValue(project ? exportProject(store, project) : exportData(store));
/** Exportación sin lo que cambia en cada ejecución. */
const stable = (value) => ({ ...value, exported_at: 'T' });

/** Base con dos proyectos: sesiones, observaciones (una borrada), prompts, relación juzgada y lápida. */
function seed(t, extra = {}) {
  const store = openTempStore(t, extra);
  createSession(store, 's1', 'alfa', '/d1');
  createSession(store, 's2', 'beta', '/d2');
  const a = addObservation(store, { session_id: 's1', type: 'decision', title: 'Caché con Redis', content: 'usamos Redis como caché distribuida', project: 'alfa' }).id;
  const b = addObservation(store, { session_id: 's1', type: 'decision', title: 'Caché Redis de sesiones', content: 'Redis guarda las sesiones', project: 'alfa' }).id;
  addObservation(store, { session_id: 's2', type: 'manual', title: 'Nota de beta', content: 'solo beta', project: 'beta' });
  const gone = addObservation(store, { session_id: 's2', type: 'manual', title: 'Borrada', content: 'se borrará', project: 'beta' }).id;
  pinObservation(store, a);
  deleteObservation(store, gone);
  addPrompt(store, { session_id: 's1', content: 'prompt de alfa', project: 'alfa' });
  const dropped = addPrompt(store, { session_id: 's2', content: 'prompt de beta', project: 'beta' }).id;
  deletePrompt(store, dropped);
  const { candidates } = findCandidates(store, b, { project: 'alfa' });
  judgeRelation(store, { judgment_id: candidates[0].judgment_id, relation: 'supersedes', reason: 'más reciente', confidence: 0.9, marked_by_actor: 'agent', marked_by_kind: 'agent' });
  endSession(store, 's2', 'cerrada');
  return store;
}

test('la exportación completa tiene el formato, el orden de claves y los nulos esperados', (t) => {
  const store = seed(t);
  const out = roundtrip(store);
  assert.deepEqual(Object.keys(out), ['version', 'exported_at', 'sessions', 'observations', 'prompts', 'relations', 'prompt_tombstones']);
  assert.equal(out.version, '0.2.0');
  assert.deepEqual(Object.keys(out.sessions[0]), ['id', 'project', 'ownership_mode', 'directory', 'started_at']);
  assert.deepEqual(Object.keys(out.sessions[1]), ['id', 'project', 'ownership_mode', 'directory', 'started_at', 'ended_at', 'summary']);
  assert.equal(out.sessions[1].summary, 'cerrada');
  assert.equal(out.observations.length, 4); // también la borrada suavemente
  assert.deepEqual(Object.keys(out.observations[0]), [
    'id', 'sync_id', 'session_id', 'type', 'title', 'content', 'project', 'scope', 'revision_count', 'duplicate_count', 'last_seen_at', 'review_after',
    'created_at', 'updated_at', 'pinned',
  ]);
  assert.equal(out.observations[0].pinned, true);
  assert.equal(out.observations[1].pinned, false);
  assert.ok(out.observations[3].deleted_at);
  assert.equal(out.observations[2].review_after, undefined); // los tipos sin caducidad no la llevan
  assert.deepEqual(Object.keys(out.prompts[0]), ['id', 'sync_id', 'session_id', 'content', 'project', 'created_at']);
  assert.equal(out.prompts.length, 1); // el otro se borró
  assert.equal(out.relations.length, 1);
  assert.deepEqual(Object.keys(out.relations[0]), [
    'sync_id', 'source_id', 'target_id', 'relation', 'reason', 'confidence', 'judgment_status', 'marked_by_actor', 'marked_by_kind', 'created_at', 'updated_at',
  ]);
  assert.equal(out.prompt_tombstones.length, 1);
  assert.deepEqual(Object.keys(out.prompt_tombstones[0]), ['sync_id', 'session_id', 'project', 'deleted_at']);
  assert.equal(out.prompt_tombstones[0].project, 'beta');
});

test('una base vacía exporta listas nulas y omite las opcionales', (t) => {
  const store = openTempStore(t);
  assert.deepEqual(stable(roundtrip(store)), { version: '0.2.0', exported_at: 'T', sessions: null, observations: null, prompts: null });
});

test('toGoJson escapa los caracteres de HTML y de línea, y sangra', () => {
  assert.equal(toGoJson({ a: '<b>&  ' }), '{"a":"\\u003cb\\u003e\\u0026\\u2028\\u2029"}');
  assert.equal(toGoJson({ a: [1] }, 2), '{\n  "a": [\n    1\n  ]\n}');
});

test('exportProject filtra sesiones, observaciones, prompts, relaciones y lápidas', (t) => {
  const store = seed(t);
  const beta = roundtrip(store, 'beta');
  assert.deepEqual(beta.sessions.map((s) => s.id), ['s2']);
  assert.deepEqual(beta.observations.map((o) => o.title), ['Nota de beta', 'Borrada']);
  assert.equal(beta.prompts ?? null, null); // su único prompt se borró
  assert.equal(beta.relations, undefined);
  assert.equal(beta.prompt_tombstones.length, 1);
  const alfa = roundtrip(store, 'alfa');
  assert.deepEqual(alfa.sessions.map((s) => s.id), ['s1']);
  assert.equal(alfa.observations.length, 2);
  assert.equal(alfa.relations.length, 1);
  assert.equal(alfa.prompt_tombstones, undefined);
  // se normaliza el nombre; uno vacío falla; uno desconocido da una exportación vacía
  assert.deepEqual(roundtrip(store, '  ALFA ').observations.length, 2);
  assert.throws(() => exportProject(store, '  '), /project is required/);
  assert.equal(roundtrip(store, 'nada').sessions, null);
});

test('las observaciones sin proyecto propio se exportan con el de su sesión', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'alfa', '/d');
  addObservation(store, { session_id: 's1', type: 'manual', title: 'Sin proyecto propio', content: 'x', project: 'alfa' });
  store.db.run("UPDATE observations SET project = NULL");
  assert.equal(roundtrip(store, 'alfa').observations.length, 1);
  assert.equal(roundtrip(store, 'beta').observations ?? null, null);
});

test('importar una exportación en una base vacía reproduce el mismo contenido', (t) => {
  const source = seed(t);
  const text = toGoJson(exportToJsonValue(exportData(source)), 2);
  const target = openTempStore(t);
  const result = importData(target, parseExportData(text));
  assert.deepEqual(result, { sessions_imported: 2, observations_imported: 4, observations_updated: 0, observations_skipped_stale: 0, prompts_imported: 1 });
  assert.deepEqual(stable(roundtrip(target)), stable(roundtrip(source)));
  // repetirla no cambia nada: las observaciones son iguales (no más nuevas)
  const again = importData(target, parseExportData(text));
  assert.deepEqual(again, { sessions_imported: 0, observations_imported: 0, observations_updated: 0, observations_skipped_stale: 4, prompts_imported: 0 });
  assert.deepEqual(stable(roundtrip(target)), stable(roundtrip(source)));
});

test('importar actualiza solo lo más nuevo y reasigna los contadores ausentes', (t) => {
  const source = seed(t);
  const target = openTempStore(t);
  const base = parseExportData(toGoJson(exportToJsonValue(exportData(source))));
  importData(target, base);
  const next = structuredClone(base);
  next.observations[0].title = 'Más nuevo';
  next.observations[0].updated_at = '2099-01-01 00:00:00';
  next.observations[1].title = 'Más viejo';
  next.observations[1].updated_at = '2001-01-01 00:00:00';
  next.observations[2].title = 'Sin fecha';
  next.observations[2].updated_at = 'no es fecha';
  next.observations[3].updated_at = '2099-06-01T12:00:00+02:00';
  next.observations[3].created_at = 'tampoco';
  next.observations[3].revision_count = 0;
  next.observations[3].duplicate_count = 0;
  next.observations[3].pinned = true;
  next.observations.push({ ...next.observations[0], id: 99, sync_id: '', title: 'Nueva sin sync_id', content: 'contenido nuevo', revision_count: 0, duplicate_count: 0, pinned: true });
  const result = importData(target, next);
  assert.deepEqual(result, { sessions_imported: 0, observations_imported: 1, observations_updated: 2, observations_skipped_stale: 2, prompts_imported: 0 });
  const rows = Object.fromEntries(target.db.all('SELECT title, revision_count, duplicate_count, pinned, created_at, sync_id FROM observations').map((r) => [r.title, r]));
  assert.equal(rows['Más nuevo'].title, 'Más nuevo');
  assert.ok(!('Más viejo' in rows));
  assert.ok(!('Sin fecha' in rows));
  assert.equal(rows['Nueva sin sync_id'].revision_count, 1);
  assert.equal(rows['Nueva sin sync_id'].duplicate_count, 1);
  assert.equal(rows['Nueva sin sync_id'].pinned, 1);
  assert.match(rows['Nueva sin sync_id'].sync_id, /^obs-[0-9a-f]{16}$/);
  const restored = target.db.get("SELECT created_at, revision_count FROM observations WHERE title = 'Borrada'");
  assert.notEqual(restored.created_at, 'tampoco'); // sin fecha comparable se conserva la local
  assert.ok(restored.revision_count >= 1);
});

test('importar rechaza versiones, sesiones y relaciones inválidas sin dejar nada a medias', (t) => {
  const source = seed(t);
  const base = parseExportData(toGoJson(exportToJsonValue(exportData(source))));
  const attempt = (mutate) => {
    const target = openTempStore(t);
    const data = structuredClone(base);
    mutate(data);
    let error = null;
    try {
      importData(target, data);
    } catch (err) {
      error = err;
    }
    return { target, error };
  };
  const unsupported = attempt((d) => { d.version = '9.9.9'; });
  assert.equal(unsupported.error.message, 'import: unsupported export version "9.9.9"');
  assert.equal(attempt((d) => { d.version = '0.1.0'; }).error, null);
  assert.equal(attempt((d) => { d.version = ''; }).error, null);
  assert.match(attempt((d) => { d.sessions[0].ownership_mode = 'raro'; }).error.message, /^import session s1: invalid session ownership mode "raro"/);
  assert.match(attempt((d) => { d.sessions[0].id = ''; }).error.message, /^import session: /);
  const missing = attempt((d) => { d.relations[0].source_id = 'obs-nada'; });
  assert.match(missing.error.message, /^import relation rel-[0-9a-f]{16}: relation endpoint source not found$/);
  assert.equal(Number(missing.target.db.get('SELECT COUNT(*) AS n FROM observations').n), 0); // se revirtió todo
  const orphan = attempt((d) => { d.relations[0].source_id = 'obs-nada'; d.relations[0].judgment_status = ' Orphaned '; });
  assert.equal(orphan.error, null);
  assert.equal(orphan.target.db.get('SELECT judgment_status FROM memory_relations').judgment_status, 'orphaned');
  assert.match(attempt((d) => { d.relations[0].sync_id = ' '; }).error.message, /^import relation: sync id is required$/);
  assert.match(attempt((d) => { d.relations[0].target_id = ''; }).error.message, /relation endpoint target is required$/);
  assert.match(attempt((d) => { d.relations[0].superseded_by_relation_sync_id = 'rel-x'; }).error.message, /superseding relation rel-x not found$/);
});

test('importar restaura las lápidas de prompts y no resucita lo borrado', (t) => {
  const source = seed(t);
  const base = parseExportData(toGoJson(exportToJsonValue(exportData(source))));
  const target = openTempStore(t);
  importData(target, base);
  assert.equal(Number(target.db.get('SELECT COUNT(*) AS n FROM prompt_tombstones').n), 1);
  // un prompt que la lápida ya cubre no vuelve
  const tombstone = base.prompt_tombstones[0];
  const revived = structuredClone(base);
  revived.prompts.push({ id: 77, sync_id: tombstone.sync_id, session_id: tombstone.session_id, content: 'resucitado', project: 'beta', created_at: '2000-01-01 00:00:00', source_inbox_id: '' });
  const result = importData(target, revived);
  assert.equal(result.prompts_imported, 0);
  assert.equal(Number(target.db.get("SELECT COUNT(*) AS n FROM user_prompts WHERE content = 'resucitado'").n), 0);
  // una lápida entrante borra el prompt local coincidente
  const del = structuredClone(base);
  del.prompt_tombstones = [{ sync_id: base.prompts[0].sync_id, session_id: base.prompts[0].session_id, project: 'alfa', source_inbox_id: '', deleted_at: '2099-01-01 00:00:00' }];
  importData(target, del);
  assert.equal(Number(target.db.get('SELECT COUNT(*) AS n FROM user_prompts').n), 0);
  // dueños distintos: conflicto
  importData(target, base);
  const clash = { ...base, prompt_tombstones: [{ sync_id: base.prompts[0].sync_id, session_id: base.prompts[0].session_id, project: 'beta', source_inbox_id: '', deleted_at: '2099-01-01 00:00:00' }] };
  assert.throws(() => importData(target, clash), code('pulled_prompt_identity_invalid'));
  assert.throws(() => importData(openTempStore(t), { ...base, prompt_tombstones: [{ sync_id: 'p', session_id: ' ', source_inbox_id: 'i', project: null, deleted_at: 'x' }] }), /session id is required for source inbox id/);
  assert.throws(() => importData(openTempStore(t), { ...base, prompt_tombstones: [{ sync_id: '', session_id: 's', source_inbox_id: '', project: null, deleted_at: 'x' }] }), /sync id is required/);
});

test('parseExportData valida tipos y el directorio de las sesiones', () => {
  assert.throws(() => parseExportData('{no es json'), SyntaxError);
  for (const bad of ['[]', 'null', '3']) assert.throws(() => parseExportData(bad), code('invalid_export'));
  assert.throws(() => parseExportData('{"sessions":"x"}'), /invalid export: sessions must be an array, got string/);
  assert.throws(() => parseExportData('{"observations":[{"id":"1"}]}'), /observations\[0\]\.id must be an integer, got string/);
  assert.throws(() => parseExportData('{"sessions":[{"id":"s","directory":null}]}'), /import session "s": directory must be a JSON string$/);
  assert.throws(() => parseExportData('{"sessions":[{"id":"s","directory":4}]}'), /directory must be a JSON string/);
  const lenient = parseExportData('{"sessions":[{"id":"s"}],"observations":null}');
  assert.equal(lenient.sessions[0].directory, '');
  assert.deepEqual(lenient.observations, []);
  assert.equal(lenient.version, '');
});

test('normalizeComparableTimestamp y isStalePromptUpsert', () => {
  assert.equal(normalizeComparableTimestamp('2026-03-01 10:00:00'), '2026-03-01 10:00:00.000000000');
  assert.equal(normalizeComparableTimestamp(' 2026-03-01 10:00:00.5 '), '2026-03-01 10:00:00.500000000');
  assert.equal(normalizeComparableTimestamp('2026-03-01T10:00:00Z'), '2026-03-01 10:00:00.000000000');
  assert.equal(normalizeComparableTimestamp('2026-03-01T10:00:00.123456789123+02:00'), '2026-03-01 08:00:00.123456789');
  assert.equal(normalizeComparableTimestamp('2026-03-01T01:30:00-03:00'), '2026-03-01 04:30:00.000000000');
  assert.equal(normalizeComparableTimestamp('2026-03-01'), '2026-03-01 00:00:00.000000000');
  for (const bad of ['', 'ayer', '2026-02-30', '2026-13-01', '2026-03-01 25:00:00', '2026-03-01T10:00:00', '2026-03-01 10:00:00Z']) {
    assert.equal(normalizeComparableTimestamp(bad), '', bad);
  }
  assert.equal(isStalePromptUpsert('2026-01-01 00:00:00', '2026-01-01 00:00:00'), true);
  assert.equal(isStalePromptUpsert('2026-01-02 00:00:00', '2026-01-01 00:00:00'), false);
  assert.equal(isStalePromptUpsert('x', '2026-01-01 00:00:00'), true);
  assert.equal(isStalePromptUpsert('2026-01-02 00:00:00', 'x'), true);
});

test('deleteSession borra la sesión vacía y sus prompts, y rechaza las que tienen observaciones', (t) => {
  const store = openTempStore(t);
  createSession(store, 'con', 'alfa', '/d');
  createSession(store, 'vacia', 'alfa', '/d');
  addObservation(store, { session_id: 'con', type: 'manual', title: 'T', content: 'c', project: 'alfa' });
  addPrompt(store, { session_id: 'vacia', content: 'prompt', project: 'alfa' });
  assert.throws(() => deleteSession(store, 'con'), (e) => e.code === 'session_has_observations' && e.message === 'session still has observations: session "con" has 1 observation(s)');
  deleteObservation(store, 1); // incluso borrada suavemente sigue contando
  assert.throws(() => deleteSession(store, 'con'), code('session_has_observations'));
  assert.throws(() => deleteSession(store, 'nada'), (e) => e.code === 'session_not_found' && e.message === 'session not found: "nada"');
  assert.throws(() => deleteSession(store, ''), code('session_id_required'));

  deleteSession(store, 'vacia');
  assert.equal(store.db.get("SELECT id FROM sessions WHERE id = 'vacia'"), undefined);
  assert.equal(Number(store.db.get('SELECT COUNT(*) AS n FROM user_prompts').n), 0);
  assert.equal(Number(store.db.get('SELECT COUNT(*) AS n FROM prompt_tombstones').n), 1);
  const tombstone = store.db.get("SELECT entity, entity_key, project, hard_delete, active FROM sync_delete_tombstones WHERE entity = 'session'");
  assert.deepEqual({ ...tombstone }, { entity: 'session', entity_key: 'vacia', project: 'alfa', hard_delete: 1, active: 1 });
  assert.throws(() => deleteSession(store, 'vacia'), code('session_not_found'));
});
