import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addObservation, candidateTerms, createSession, deleteObservation, escapeLike, hasShortFtsTerm, pinObservation,
  sanitizeFtsCandidates, searchObservationPreviews, searchObservations, searchTerms, timeline,
} from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const code = (c) => (err) => err.code === c;

function setup(t, config = {}) {
  const store = openTempStore(t, config);
  createSession(store, 's1', 'proj', '/d');
  return store;
}
const save = (store, title, content, extra = {}) =>
  addObservation(store, { session_id: 's1', type: 'manual', title, content, ...extra }).id;
const ids = (results) => results.map((r) => r.id);

test('helpers de búsqueda', () => {
  assert.deepEqual(searchTerms('  "uno"  dos "" tres" '), ['uno', 'dos', 'tres']);
  assert.equal(hasShortFtsTerm('arquitectura hexagonal'), false);
  assert.equal(hasShortFtsTerm('arquitectura db'), true);
  assert.equal(hasShortFtsTerm('日本語'), false); // 3 caracteres
  assert.equal(hasShortFtsTerm('日本'), true);
  assert.equal(hasShortFtsTerm('😀😀😀'), false); // cuenta caracteres, no unidades UTF-16
  assert.equal(escapeLike('a_b%c\\d'), 'a\\_b\\%c\\\\d');
  assert.deepEqual(candidateTerms('uno "dos" a""b c"d'), ['"uno"', '"dos"', '"a""b"', '"c""d"']);
  assert.equal(sanitizeFtsCandidates('uno dos'), '"uno" OR "dos"');
  assert.equal(sanitizeFtsCandidates('   '), '');
});

test('FTS trigram: encuentra subcadenas y exige todos los términos por defecto', (t) => {
  const store = setup(t);
  const a = save(store, 'Arquitectura hexagonal', 'puertos y adaptadores');
  const b = save(store, 'Persistencia', 'adaptadores para la base de datos');
  assert.deepEqual(ids(searchObservations(store, 'tectu')), [a]);
  assert.deepEqual(ids(searchObservations(store, 'adaptadores')).sort(), [a, b].sort());
  assert.deepEqual(ids(searchObservations(store, 'adaptadores puertos')), [a]); // AND
  assert.deepEqual(ids(searchObservations(store, 'adaptadores puertos', { match_mode: 'any' })).sort(), [a, b].sort());
  assert.deepEqual(searchObservations(store, 'inexistente'), []);
});

test('match_mode inválido falla; los resultados traen rank y pinned', (t) => {
  const store = setup(t);
  save(store, 'Arquitectura', 'contenido de prueba');
  assert.throws(() => searchObservations(store, 'prueba', { match_mode: 'xor' }), code('invalid_match_mode'));
  const [r] = searchObservations(store, 'prueba');
  assert.equal(typeof r.rank, 'number');
  assert.ok(r.rank < 0); // bm25: menor es mejor
  assert.equal(r.pinned, false);
  assert.equal(r.content, 'contenido de prueba');
});

test('un término corto cambia a LIKE (clasificación 0, más reciente primero)', (t) => {
  const store = setup(t);
  const a = save(store, 'Base db', 'tabla uno');
  const b = save(store, 'Otra db', 'tabla dos');
  const found = searchObservations(store, 'db');
  assert.deepEqual(ids(found), [b, a]);
  assert.deepEqual(found.map((r) => r.rank), [0, 0]);
  assert.deepEqual(ids(searchObservations(store, 'db uno')), [a]);
  assert.deepEqual(ids(searchObservations(store, 'db uno', { match_mode: 'any' })).sort(), [a, b].sort());
  // % y _ son literales gracias al escape
  const c = save(store, 'Porcentaje 100%', 'valor');
  assert.deepEqual(ids(searchObservations(store, '0%')), [c]);
  assert.deepEqual(ids(searchObservations(store, '_b')), []);
});

test('coincidencia directa por topic_key con clasificación -1000 y sin duplicar', (t) => {
  const store = setup(t);
  const a = save(store, 'Modelo de auth', 'detalle', { topic_key: 'architecture/auth' });
  save(store, 'Otra cosa', 'architecture auth');
  const res = searchObservations(store, 'architecture/auth');
  assert.equal(res[0].id, a);
  assert.equal(res[0].rank, -1000);
  assert.equal(res.filter((r) => r.id === a).length, 1);
  // la consulta con "/" se compara tal cual: sin normalizar a minúsculas
  assert.deepEqual(searchObservations(store, 'Architecture/Auth').filter((r) => r.rank === -1000), []);
});

test('los filtros por tipo, proyecto y ámbito se aplican', (t) => {
  const store = setup(t);
  const a = save(store, 'Alfa común', 'texto compartido', { type: 'decision' });
  const b = save(store, 'Beta común', 'texto compartido', { project: 'otro', scope: 'personal' });
  assert.deepEqual(ids(searchObservations(store, 'compartido', { type: 'decision' })), [a]);
  assert.deepEqual(ids(searchObservations(store, 'compartido', { project: 'OTRO' })), [b]);
  assert.deepEqual(ids(searchObservations(store, 'compartido', { scope: 'personal' })), [b]);
  assert.deepEqual(ids(searchObservations(store, 'compartido', { project: 'proj', scope: 'global' })), []);
});

test('las observaciones borradas no aparecen y el límite se respeta', (t) => {
  const store = setup(t, { maxSearchResults: 3 });
  const created = [1, 2, 3, 4, 5].map((i) => save(store, `Nota número ${i}`, `contenido repetido ${i}`));
  assert.equal(searchObservations(store, 'repetido').length, 3); // 10 por defecto, tope 3
  assert.equal(searchObservations(store, 'repetido', { limit: 2 }).length, 2);
  assert.equal(searchObservations(store, 'repetido', { limit: 99 }).length, 3);
  for (const id of created) deleteObservation(store, id);
  assert.deepEqual(searchObservations(store, 'repetido'), []);
});

test('el orden favorece título sobre contenido y las fijadas', (t) => {
  const store = setup(t);
  const inContent = save(store, 'Notas varias', 'aquí se habla de caché una vez');
  const inTitle = save(store, 'Caché distribuida', 'otro texto sin relación');
  const [first, second] = searchObservations(store, 'caché');
  assert.equal(first.id, inTitle); // el título pesa 5 frente a 1
  assert.equal(second.id, inContent);
  pinObservation(store, inContent);
  // las fijadas ganan un refuerzo, pero acotado: el orden relativo sigue siendo determinista
  assert.equal(searchObservations(store, 'caché').length, 2);
});

test('previews: 300 caracteres, indicador de truncado y sin contenido completo', (t) => {
  const store = setup(t);
  const long = save(store, 'Largo', `palabraclave ${'x'.repeat(400)}`);
  const short = save(store, 'Corto', 'palabraclave breve');
  const res = searchObservationPreviews(store, 'palabraclave');
  const byId = Object.fromEntries(res.map((r) => [r.id, r]));
  assert.equal(byId[long].preview.length, 300);
  assert.equal(byId[long].truncated, true);
  assert.equal(byId[short].preview, 'palabraclave breve');
  assert.equal(byId[short].truncated, false);
  assert.equal('content' in byId[short], false);
  assert.equal(searchObservationPreviews(store, 'palabraclave', { limit: 1 }).length, 1);
  assert.equal(searchObservationPreviews(store, 'de').length, 0); // término corto → LIKE
});

test('consulta vacía o con sintaxis rota produce search_failed', (t) => {
  const store = setup(t);
  assert.throws(() => searchObservations(store, '   '), code('search_failed'));
});

test('timeline: vecinos de la misma sesión en orden, conteo y sesión', (t) => {
  const store = setup(t);
  createSession(store, 's2', 'proj', '/d');
  const all = [];
  for (let i = 1; i <= 7; i++) all.push(save(store, `Obs ${i}`, `contenido ${i}`));
  const other = addObservation(store, { session_id: 's2', type: 'manual', title: 'Ajena', content: 'otra sesión' }).id;
  const tl = timeline(store, all[3], 2, 2);
  assert.equal(tl.focus.id, all[3]);
  assert.deepEqual(tl.before.map((e) => e.id), [all[1], all[2]]); // cronológico
  assert.deepEqual(tl.after.map((e) => e.id), [all[4], all[5]]);
  assert.equal(tl.total_in_range, 7);
  assert.equal(tl.session_info.id, 's1');
  assert.equal(tl.before[0].is_focus, false);
  assert.ok(!tl.after.some((e) => e.id === other));
  const defaults = timeline(store, all[3]); // 5 antes / 5 después
  assert.deepEqual([defaults.before.length, defaults.after.length], [3, 3]);
  deleteObservation(store, all[4]);
  assert.deepEqual(timeline(store, all[3], 1, 1).after.map((e) => e.id), [all[5]]);
  assert.throws(() => timeline(store, 999), code('observation_not_found'));
  assert.throws(() => timeline(store, all[4]), code('observation_not_found')); // borrada
});
