import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addObservation, allObservations, createSession, deleteObservation, getObservation, getObservationSaveResult,
  getObservationVersions, markReviewed, observationOperationRecorded, observationState, observationsNeedingReview,
  pinObservation, pinnedObservations, recentObservations, replaceObservationContent, sessionObservations,
  unpinObservation, updateObservation,
} from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const code = (c) => (err) => err.code === c;

function setup(t, config = {}) {
  const store = openTempStore(t, config);
  createSession(store, 's1', 'proj', '/d');
  return store;
}
const save = (store, extra = {}) =>
  addObservation(store, { session_id: 's1', type: 'manual', title: 'Título', content: 'Contenido', ...extra });

test('guarda una observación con sus valores por defecto', (t) => {
  const store = setup(t);
  const { id, replayed } = save(store, { tool_name: 'editor' });
  assert.equal(replayed, false);
  const o = getObservation(store, id);
  assert.match(o.sync_id, /^obs-[0-9a-f]{16}$/);
  assert.deepEqual(
    { project: o.project, scope: o.scope, type: o.type, tool: o.tool_name, rev: o.revision_count, dup: o.duplicate_count, pinned: o.pinned, topic: o.topic_key },
    { project: 'proj', scope: 'project', type: 'manual', tool: 'editor', rev: 1, dup: 1, pinned: false, topic: null },
  );
  assert.equal(o.review_after, null); // 'manual' no caduca
  assert.equal(o.deleted_at, null);
  assert.ok(o.last_seen_at);
});

test('elimina las etiquetas privadas del título y del contenido antes de persistir', (t) => {
  const store = setup(t);
  const { id } = save(store, { title: 'Token <private>abc</private>', content: 'clave=<private>secreta</private> fin' });
  const o = getObservation(store, id);
  assert.equal(o.title, 'Token [REDACTED]');
  assert.equal(o.content, 'clave=[REDACTED] fin');
  assert.equal(store.db.all("SELECT 1 FROM observations WHERE content LIKE '%secreta%'").length, 0);
});

test('trunca el contenido por bytes y añade el marcador', (t) => {
  const store = setup(t, { maxObservationLength: 10 });
  const { id } = save(store, { content: 'ñ'.repeat(10) }); // 20 bytes
  assert.equal(getObservation(store, id).content, `${'ñ'.repeat(5)}... [truncated]`);
});

test('exige título y contenido, también después de quitar lo privado', (t) => {
  const store = setup(t);
  assert.throws(() => save(store, { title: '   ' }), code('observation_title_required'));
  assert.throws(() => save(store, { title: '' }), code('observation_title_required'));
  assert.throws(() => save(store, { content: '  ' }), code('observation_content_required'));
  assert.equal(store.db.get('SELECT count(*) AS n FROM observations').n, 0);
});

test('fija review_after según el tipo solo al insertar', (t) => {
  const store = setup(t);
  const { id } = save(store, { type: 'decision' });
  const reviewAfter = getObservation(store, id).review_after;
  assert.match(reviewAfter, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const months = (Date.parse(`${reviewAfter.replace(' ', 'T')}Z`) - Date.now()) / (30 * 86_400_000);
  assert.ok(months > 5 && months < 7, `~6 meses, fue ${months}`);
  assert.equal(getObservation(store, save(store, { type: 'preference', title: 'p' }).id).review_after !== null, true);
  assert.equal(getObservation(store, save(store, { type: 'otro', title: 'q' }).id).review_after, null);
});

test('deduplica contenido idéntico dentro de la ventana', (t) => {
  const store = setup(t);
  const a = save(store, { content: 'Hola   Mundo' });
  const b = save(store, { content: 'hola mundo' }); // mismo hash normalizado
  assert.equal(b.id, a.id);
  assert.equal(getObservation(store, a.id).duplicate_count, 2);
  assert.equal(getObservation(store, a.id).revision_count, 1);
  assert.notEqual(save(store, { content: 'hola mundo', title: 'Otro título' }).id, a.id);
  assert.notEqual(save(store, { content: 'hola mundo', type: 'decision' }).id, a.id);
  assert.notEqual(save(store, { content: 'hola mundo', project: 'otro-proy' }).id, a.id);
  assert.notEqual(save(store, { content: 'hola mundo', scope: 'personal' }).id, a.id);
});

test('fuera de la ventana de deduplicación se crea una observación nueva', (t) => {
  const store = setup(t);
  const a = save(store);
  store.db.run("UPDATE observations SET created_at = datetime('now', '-20 minutes') WHERE id = ?", a.id);
  assert.notEqual(save(store).id, a.id);
});

test('upsert por topic_key: actualiza en el sitio y guarda la versión previa', (t) => {
  const store = setup(t);
  const a = save(store, { topic_key: 'Architecture / Auth', title: 'Modelo v1', content: 'primera' });
  const b = save(store, { topic_key: 'architecture / auth', title: 'Modelo v2', content: 'segunda', type: 'decision' });
  assert.equal(b.id, a.id);
  const o = getObservation(store, a.id);
  assert.deepEqual([o.title, o.content, o.type, o.revision_count, o.topic_key], ['Modelo v2', 'segunda', 'decision', 2, 'architecture-/-auth']);
  const versions = getObservationVersions(store, a.id);
  assert.deepEqual(versions.map((v) => [v.version, v.title, v.content]), [[1, 'Modelo v1', 'primera']]);
  save(store, { topic_key: 'architecture / auth', title: 'Modelo v3', content: 'tercera' });
  assert.deepEqual(getObservationVersions(store, a.id).map((v) => v.version), [1, 2]);
  // otro proyecto o ámbito: observación aparte
  assert.notEqual(save(store, { topic_key: 'architecture / auth', project: 'otro' }).id, a.id);
  assert.notEqual(save(store, { topic_key: 'architecture / auth', scope: 'global' }).id, a.id);
});

test('operation_id: el reintento idéntico es una repetición y una carga distinta es un conflicto', (t) => {
  const store = setup(t);
  const first = save(store, { operation_id: 'op-1' });
  assert.equal(first.replayed, false);
  const again = save(store, { operation_id: 'op-1' });
  assert.deepEqual(again, { id: first.id, replayed: true });
  assert.equal(getObservation(store, first.id).duplicate_count, 1); // no se repitió la mutación
  assert.throws(() => save(store, { operation_id: 'op-1', content: 'otro' }), code('observation_operation_conflict'));
  assert.equal(getObservationSaveResult(store, 'op-1'), first.id);
  assert.equal(getObservationSaveResult(store, 'desconocida'), 0);
  assert.equal(getObservationSaveResult(store, ''), 0);
  assert.equal(observationOperationRecorded(store, 'op-1'), true);
  assert.equal(observationOperationRecorded(store, 'desconocida'), false);
});

test('operation_id caduca cuando la observación se borra', (t) => {
  const store = setup(t);
  const { id } = save(store, { operation_id: 'op-2' });
  deleteObservation(store, id, { hardDelete: true });
  assert.throws(() => save(store, { operation_id: 'op-2' }), code('observation_operation_expired'));
  assert.throws(() => getObservationSaveResult(store, 'op-2'), code('observation_operation_expired'));
  assert.equal(observationOperationRecorded(store, 'op-2'), true); // la lápida sigue
});

test('el proyecto de escritura se hereda de la sesión o se valida contra ella', (t) => {
  const store = setup(t);
  assert.equal(getObservation(store, save(store).id).project, 'proj');
  assert.equal(getObservation(store, save(store, { project: 'Otra--App', title: 'z' }).id).project, 'otra-app');
  createSession(store, 'dueña', 'a', '/d', 'project_owned');
  assert.throws(() => save(store, { session_id: 'dueña', project: 'b' }), code('session_ownership_mismatch'));
  assert.throws(() => save(store, { session_id: 'no-existe', project: '' }), code('project_required'));
});

test('una escritura sobre un proyecto inscrito falla y se revierte entera', (t) => {
  const store = setup(t);
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('proj')");
  assert.throws(() => save(store), code('sync_journal_unavailable'));
  assert.equal(store.db.get('SELECT count(*) AS n FROM observations').n, 0);
  assert.equal(store.db.get('SELECT count(*) AS n FROM observation_save_operations').n, 0);
});

test('updateObservation: parcial, con versión solo si cambia título o contenido', (t) => {
  const store = setup(t);
  const { id } = save(store, { title: 'T1', content: 'C1' });
  let o = updateObservation(store, id, { scope: 'global', topic_key: 'Mi Tema' });
  assert.deepEqual([o.scope, o.topic_key, o.revision_count, getObservationVersions(store, id).length], ['global', 'mi-tema', 2, 0]);
  o = updateObservation(store, id, { title: 'T2', content: 'C2', type: 'decision' });
  assert.deepEqual([o.title, o.content, o.type, o.revision_count], ['T2', 'C2', 'decision', 3]);
  assert.deepEqual(getObservationVersions(store, id).map((v) => [v.title, v.content]), [['T1', 'C1']]);
  assert.throws(() => updateObservation(store, 999, { title: 'x' }), code('observation_not_found'));
  assert.throws(() => updateObservation(store, id, { title: '   ' }), code('observation_title_required'));
  assert.throws(() => updateObservation(store, id, { content: '  ' }), code('observation_content_required'));
  // lo privado se redacta, no se vacía: sigue siendo un título y un contenido válidos
  o = updateObservation(store, id, { title: '<private>x</private>', content: '<private>y</private>' });
  assert.deepEqual([o.title, o.content], ['[REDACTED]', '[REDACTED]']);
});

test('updateObservation: find/replace y sus errores', (t) => {
  const store = setup(t, { maxObservationLength: 30 });
  const { id } = save(store, { content: 'uno dos dos tres' });
  let o = updateObservation(store, id, { find: 'dos', replace: '2' });
  assert.equal(o.content, 'uno 2 2 tres');
  assert.equal(o.revision_count, 2);
  o = updateObservation(store, id, { find: 'no-está', replace: 'x' }); // sin cambios y sin metadatos: no toca nada
  assert.equal(o.revision_count, 2);
  assert.throws(() => updateObservation(store, id, { find: 'a' }), code('observation_find_replace_pair_required'));
  assert.throws(() => updateObservation(store, id, { find: 'a', replace: 'b', content: 'c' }), code('observation_find_replace_content_conflict'));
  assert.throws(() => updateObservation(store, id, { find: 'x'.repeat(31), replace: 'y' }), code('observation_find_replace_input_too_large'));
  assert.throws(() => updateObservation(store, id, { find: '2', replace: 'z'.repeat(20) }), code('observation_find_replace_result_too_large'));
});

test('updateObservation: el proyecto es inmutable y expectedProject protege', (t) => {
  const store = setup(t);
  const { id } = save(store);
  assert.throws(() => updateObservation(store, id, { project: 'otro' }), code('observation_project_immutable'));
  updateObservation(store, id, { project: 'PROJ', title: 'ok' }); // mismo proyecto canónico
  assert.throws(() => updateObservation(store, id, { title: 'x' }, { expectedProject: 'otro' }), code('observation_project_mismatch'));
  assert.throws(() => updateObservation(store, id, { title: 'x' }, { expectedProject: '  ' }), code('expected_project_required'));
  assert.equal(updateObservation(store, id, { title: 'x' }, { expectedProject: 'Proj' }).title, 'x');
});

test('replaceObservationContent respeta marcador de truncado, límite y contenido heredado grande', () => {
  assert.deepEqual(replaceObservationContent('abc', '', 'x', 100), { content: 'abc', noop: true });
  assert.deepEqual(replaceObservationContent('abc', 'z', 'x', 100), { content: 'abc', noop: true });
  assert.deepEqual(replaceObservationContent('abcabc', 'b', 'XX', 100), { content: 'aXXcaXXc', noop: false });
  assert.deepEqual(replaceObservationContent('abc', 'b', 'b', 100), { content: 'abc', noop: true });
  assert.equal(replaceObservationContent('abc... [truncated]', 'b', 'B', 100).content, 'aBc... [truncated]');
  assert.throws(() => replaceObservationContent('a'.repeat(11), 'a', 'b', 10), code('observation_find_replace_legacy_content_large'));
  assert.throws(() => replaceObservationContent('abc', 'abc', '', 100), code('observation_content_required'));
  assert.throws(() => replaceObservationContent('aaaa', 'a', 'bb', 5), code('observation_find_replace_result_too_large'));
  assert.equal(replaceObservationContent('aaaa', 'a', 'bb', 8).content, 'bbbbbbbb');
});

test('deleteObservation suave oculta la observación y la saca del índice', (t) => {
  const store = setup(t);
  const { id } = save(store, { title: 'Arquitectura hexagonal' });
  const fts = () => store.db.all("SELECT rowid FROM observations_fts WHERE observations_fts MATCH '\"tectu\"'").length;
  assert.equal(fts(), 1);
  deleteObservation(store, id);
  assert.equal(getObservation(store, id), null);
  assert.equal(fts(), 0);
  assert.ok(store.db.get('SELECT deleted_at FROM observations WHERE id = ?', id).deleted_at);
  assert.throws(() => deleteObservation(store, id), code('observation_not_found'));
  assert.equal(store.db.get('SELECT count(*) AS n FROM sync_delete_tombstones').n, 0);
});

test('deleteObservation duro elimina la fila, deja lápida y deja huérfanas las relaciones', (t) => {
  const store = setup(t);
  const { id } = save(store);
  const syncId = getObservation(store, id).sync_id;
  store.db.run("INSERT INTO memory_relations (sync_id, source_id, target_id) VALUES ('rel-1', ?, 'obs-otro')", syncId);
  save(store, { title: 'versionada', topic_key: 'k' });
  save(store, { title: 'versionada 2', content: 'otro', topic_key: 'k' });
  deleteObservation(store, id, { hardDelete: true });
  assert.equal(store.db.get('SELECT count(*) AS n FROM observations WHERE id = ?', id).n, 0);
  const tomb = store.db.get("SELECT * FROM sync_delete_tombstones WHERE entity = 'observation' AND entity_key = ?", syncId);
  assert.deepEqual([tomb.session_id, tomb.project, tomb.hard_delete, tomb.active], ['s1', 'proj', 1, 1]);
  assert.equal(store.db.get("SELECT judgment_status FROM memory_relations WHERE sync_id = 'rel-1'").judgment_status, 'orphaned');
  // el borrado duro también alcanza observaciones ya borradas de forma suave
  const other = save(store, { title: 'otra', content: 'distinta' }).id;
  deleteObservation(store, other);
  deleteObservation(store, other, { hardDelete: true });
  assert.equal(store.db.get('SELECT count(*) AS n FROM observations WHERE id = ?', other).n, 0);
});

test('deleteObservation con expectedProject protege al dueño', (t) => {
  const store = setup(t);
  const { id } = save(store);
  assert.throws(() => deleteObservation(store, id, { expectedProject: 'otro' }), code('observation_project_mismatch'));
  deleteObservation(store, id, { expectedProject: 'PROJ' });
  assert.equal(getObservation(store, id), null);
});

test('pin y unpin; recientes, fijadas, todas y por sesión', (t) => {
  const store = setup(t);
  createSession(store, 's2', 'otro', '/d');
  const a = save(store, { title: 'a', content: '1' }).id;
  const b = save(store, { title: 'b', content: '2' }).id;
  const c = save(store, { title: 'c', content: '3', session_id: 's2', project: 'otro' }).id;
  pinObservation(store, a);
  assert.equal(getObservation(store, a).pinned, true);
  assert.deepEqual(pinnedObservations(store, 'PROJ').map((o) => o.id), [a]);
  unpinObservation(store, a);
  assert.deepEqual(pinnedObservations(store).map((o) => o.id), []);
  assert.throws(() => pinObservation(store, 999), code('observation_not_found'));
  assert.deepEqual(recentObservations(store, 'proj').map((o) => o.id), [b, a]); // más nueva primero (desempate por id)
  assert.deepEqual(recentObservations(store, '', 'project', 2).map((o) => o.id), [c, b]);
  assert.deepEqual(allObservations(store, 'PROJ').map((o) => o.id), []); // filtro exacto: no normaliza
  assert.deepEqual(allObservations(store, 'proj').map((o) => o.id), [b, a]);
  assert.deepEqual(sessionObservations(store, 's1').map((o) => o.id), [a, b]);
  assert.deepEqual(recentObservations(store, 'proj', 'global'), []);
});

test('revisión: lista las vencidas y markReviewed reprograma o limpia', (t) => {
  const store = setup(t);
  const dec = save(store, { type: 'decision', title: 'd' }).id;
  const man = save(store, { type: 'manual', title: 'm', content: 'otro' }).id;
  assert.deepEqual(observationsNeedingReview(store), []);
  store.db.run("UPDATE observations SET review_after = datetime('now', '-1 day') WHERE id IN (?, ?)", dec, man);
  assert.deepEqual(observationsNeedingReview(store, 'PROJ').map((o) => o.id).sort(), [dec, man].sort());
  assert.equal(observationState(getObservation(store, dec).review_after), 'needs_review');

  markReviewed(store, dec, 'proj');
  const after = getObservation(store, dec);
  assert.equal(observationState(after.review_after), 'active');
  assert.equal(store.db.get('SELECT count(*) AS n FROM review_clear_events').n, 0);

  markReviewed(store, man); // sin plazo para su tipo: se limpia y se anota
  assert.equal(getObservation(store, man).review_after, null);
  assert.equal(store.db.get('SELECT count(*) AS n FROM review_clear_events').n, 1);
  assert.throws(() => markReviewed(store, dec, 'otro'), code('observation_not_found'));
  assert.throws(() => markReviewed(store, 999), code('observation_not_found'));
});

test('observationState', () => {
  assert.equal(observationState(null), 'active');
  assert.equal(observationState(''), 'active');
  assert.equal(observationState('no es fecha'), 'active');
  assert.equal(observationState('2020-01-01 00:00:00'), 'needs_review');
  assert.equal(observationState('2999-01-01 00:00:00'), 'active');
  assert.equal(observationState('2026-01-01 00:00:00', new Date('2026-01-01T00:00:00Z')), 'needs_review');
});
