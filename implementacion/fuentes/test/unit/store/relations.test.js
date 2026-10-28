import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JUDGMENT_STATUS, VALID_RELATION_VERBS, addObservation, countRelations, createSession, deleteObservation, findCandidates,
  getObservation, getRelation, getRelationByIntId, getRelationsForObservations, judgeBySemantic, judgeRelation,
  listRelations, saveCandidateRelevant, saveCandidateTerms, saveRelation,
} from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const code = (c) => (err) => err.code === c;

function setup(t) {
  const store = openTempStore(t);
  createSession(store, 's1', 'proj', '/d');
  createSession(store, 's2', 'otro', '/d');
  return store;
}
const save = (store, title, extra = {}) =>
  addObservation(store, { session_id: 's1', type: 'manual', title, content: `contenido de ${title}`, ...extra }).id;
const syncId = (store, id) => getObservation(store, id).sync_id;

test('saveCandidateTerms: minúsculas, sin palabras vacías, únicos, ordenados, con + y #', () => {
  assert.deepEqual(saveCandidateTerms('Use the Redis cache for sessions'), ['cache', 'redis', 'sessions']);
  assert.deepEqual(saveCandidateTerms('C++ and C# fixed'), ['c#', 'c++']);
  assert.deepEqual(saveCandidateTerms('Decisión de caché: caché!'), ['caché', 'de', 'decisión']);
  assert.deepEqual(saveCandidateTerms('+ # -- !!'), []);
  assert.deepEqual(saveCandidateTerms('API v2'), ['api', 'v2']);
  assert.deepEqual(saveCandidateTerms(''), []);
});

test('saveCandidateRelevant: topic_key, dos términos en común o único término mutuo', () => {
  assert.equal(saveCandidateRelevant(['cache', 'redis'], 'a/b', 'Otro título', 'a/b'), true);
  assert.equal(saveCandidateRelevant(['cache', 'redis', 'sessions'], '', 'Redis cache layer', null), true); // 2 en común
  assert.equal(saveCandidateRelevant(['cache', 'redis', 'sessions'], '', 'Sessions in the browser', null), false); // 1 en común
  assert.equal(saveCandidateRelevant(['cache'], '', 'Cache', null), true); // único término en ambos
  assert.equal(saveCandidateRelevant(['cache'], '', 'Cache layer', null), false);
  assert.equal(saveCandidateRelevant(['cache', 'x'], '', 'cache', null), false);
  assert.equal(saveCandidateRelevant([], '', 'cualquier cosa', null), false);
});

test('la función SQL de relevancia está registrada en la conexión', (t) => {
  const { db } = setup(t);
  const call = (terms, topic, title, otherTopic) =>
    db.get('SELECT odin_save_candidate_relevant(?, ?, ?, ?) AS r', terms, topic, title, otherTopic).r;
  assert.equal(call('cache\x1fredis', '', 'Redis cache', null), 1);
  assert.equal(call('cache\x1fredis', '', 'Postgres', null), 0);
  assert.equal(call('', 'k', 'x', 'k'), 1);
  assert.equal(call(null, null, null, null), 0);
});

test('findCandidates: relevantes del mismo proyecto y ámbito, relaciones pendientes, sin repetir', (t) => {
  const store = setup(t);
  const b = save(store, 'Redis cache layer');
  const d = save(store, 'Cache strategy for redis');
  save(store, 'Sessions in the browser');
  save(store, 'Postgres pooling');
  save(store, 'Redis cache layer', { project: 'otro', session_id: 's2' });
  save(store, 'Redis cache layer', { scope: 'global', content: 'otro ámbito' });
  const a = save(store, 'Redis cache sessions');

  const { candidates, errors } = findCandidates(store, a, { require_save_relevance: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(candidates.map((c) => c.id).sort(), [b, d].sort());
  for (const c of candidates) {
    assert.match(c.judgment_id, /^rel-[0-9a-f]{16}$/);
    assert.equal(c.sync_id, syncId(store, c.id));
    assert.equal(typeof c.score, 'number');
    const rel = getRelation(store, c.judgment_id);
    assert.deepEqual([rel.source_id, rel.target_id, rel.relation, rel.judgment_status], [syncId(store, a), c.sync_id, 'pending', 'pending']);
  }
  assert.ok(candidates[0].score <= candidates[1].score); // mejor (más negativo) primero
  // segunda llamada: los pares ya tienen relación, no se crean más
  assert.deepEqual(findCandidates(store, a, { require_save_relevance: true }).candidates, []);
  assert.equal(store.db.get('SELECT count(*) AS n FROM memory_relations').n, 2);
});

test('findCandidates sin exigir relevancia devuelve más; skip_insert no crea relaciones; limit', (t) => {
  const store = setup(t);
  save(store, 'Redis cache layer');
  save(store, 'Cache strategy for redis');
  save(store, 'Sessions in the browser');
  const a = save(store, 'Redis cache sessions');
  const loose = findCandidates(store, a, { skip_insert: true }).candidates;
  assert.equal(loose.length, 3); // cualquier término en común
  assert.ok(loose.every((c) => c.judgment_id === undefined));
  assert.equal(store.db.get('SELECT count(*) AS n FROM memory_relations').n, 0);
  assert.equal(findCandidates(store, a, { skip_insert: true, limit: 1 }).candidates.length, 1);
  assert.equal(findCandidates(store, a, { skip_insert: true }).candidates.length, 3); // el límite por defecto es 3
});

test('findCandidates excluye pares ya juzgados y observaciones borradas', (t) => {
  const store = setup(t);
  save(store, 'Redis cache layer');
  save(store, 'Cache strategy for redis');
  const a = save(store, 'Redis cache sessions');
  const first = findCandidates(store, a, { require_save_relevance: true }).candidates;
  assert.equal(first.length, 2);
  judgeRelation(store, { judgment_id: first[0].judgment_id, relation: 'related' });
  deleteObservation(store, first[1].id);
  const again = findCandidates(store, a, { skip_insert: true, require_save_relevance: true }).candidates;
  assert.deepEqual(again, []); // uno juzgado, el otro borrado
});

test('findCandidates valida opciones y la observación', (t) => {
  const store = setup(t);
  const a = save(store, 'Algo');
  assert.throws(() => findCandidates(store, 999), code('observation_not_found'));
  assert.throws(() => findCandidates(store, a, { bm25_max_rank: 0, bm25_floor: 0 }), /cannot both be set/);
  assert.throws(() => findCandidates(store, a, { bm25_max_rank: Number.NaN }), /must be finite/);
  assert.throws(() => findCandidates(store, a, { bm25_floor: Infinity }), /BM25Floor must be finite/);
  assert.deepEqual(findCandidates(store, a, { query: '   ' }).candidates, []);
  // un umbral muy estricto descarta todo; un suelo permisivo lo admite
  save(store, 'Algo parecido');
  assert.deepEqual(findCandidates(store, a, { skip_insert: true, bm25_max_rank: -1000 }).candidates, []);
  assert.equal(findCandidates(store, a, { skip_insert: true, bm25_floor: -1000 }).candidates.length, 1);
});

test('judgeRelation: valida el verbo, registra el veredicto y marca quién lo hizo', (t) => {
  const store = setup(t);
  const a = save(store, 'Redis cache layer');
  const b = save(store, 'Cache strategy for redis');
  const rel = saveRelation(store, { sync_id: 'rel-x', source_id: syncId(store, a), target_id: syncId(store, b) });
  assert.equal(rel.judgment_status, 'pending');
  assert.throws(() => judgeRelation(store, { judgment_id: 'rel-x', relation: 'amigos' }), code('invalid_relation_verb'));
  assert.throws(() => judgeRelation(store, { judgment_id: 'no-existe', relation: 'related' }), code('relation_not_found'));
  const judged = judgeRelation(store, {
    judgment_id: 'rel-x', relation: 'supersedes', reason: 'más reciente', evidence: 'ver #2', confidence: 0.9,
    marked_by_actor: 'copilot', marked_by_kind: 'agent', marked_by_model: 'gpt', session_id: 's1',
  });
  assert.deepEqual(
    [judged.relation, judged.judgment_status, judged.reason, judged.evidence, judged.confidence, judged.marked_by_actor, judged.marked_by_kind, judged.marked_by_model, judged.session_id],
    ['supersedes', 'judged', 'más reciente', 'ver #2', 0.9, 'copilot', 'agent', 'gpt', 's1'],
  );
  const bare = judgeRelation(store, { judgment_id: 'rel-x', relation: 'related' });
  assert.deepEqual([bare.reason, bare.confidence, bare.marked_by_actor, bare.marked_by_model, bare.session_id], [null, null, '', null, null]);
  assert.deepEqual([...VALID_RELATION_VERBS].sort(), ['compatible', 'conflicts_with', 'not_conflict', 'related', 'scoped', 'supersedes']);
  assert.equal(JUDGMENT_STATUS.judged, 'judged');
});

test('judgeRelation rechaza relaciones entre proyectos distintos y no escribe', (t) => {
  const store = setup(t);
  const a = save(store, 'Mismo tema');
  const b = addObservation(store, { session_id: 's2', type: 'manual', title: 'Mismo tema', content: 'x' }).id;
  saveRelation(store, { sync_id: 'rel-cross', source_id: syncId(store, a), target_id: syncId(store, b) });
  assert.throws(() => judgeRelation(store, { judgment_id: 'rel-cross', relation: 'related' }), code('cross_project_relation'));
  assert.equal(getRelation(store, 'rel-cross').judgment_status, 'pending');
  assert.throws(() => judgeBySemantic(store, { source_id: syncId(store, a), target_id: syncId(store, b), relation: 'related', confidence: 0.5 }), code('cross_project_relation'));
});

test('judgeBySemantic crea o reutiliza la relación en cualquier sentido', (t) => {
  const store = setup(t);
  const a = syncId(store, save(store, 'Uno'));
  const b = syncId(store, save(store, 'Dos distinto'));
  const id = judgeBySemantic(store, { source_id: a, target_id: b, relation: 'conflicts_with', confidence: 0.8, reasoning: 'se contradicen', model: 'm1' });
  let rel = getRelation(store, id);
  assert.deepEqual(
    [rel.relation, rel.judgment_status, rel.confidence, rel.reason, rel.marked_by_actor, rel.marked_by_kind, rel.marked_by_model],
    ['conflicts_with', 'judged', 0.8, 'se contradicen', 'odin', 'system', 'm1'],
  );
  // el mismo par en sentido inverso reutiliza la fila y reorienta los extremos
  const again = judgeBySemantic(store, { source_id: b, target_id: a, relation: 'compatible', confidence: 1, reasoning: '' });
  assert.equal(again, id);
  rel = getRelation(store, id);
  assert.deepEqual([rel.source_id, rel.target_id, rel.relation, rel.marked_by_model], [b, a, 'compatible', null]);
  assert.equal(store.db.get('SELECT count(*) AS n FROM memory_relations').n, 1);
});

test('judgeBySemantic valida entradas', (t) => {
  const store = setup(t);
  const base = { source_id: 'a', target_id: 'b', relation: 'related', confidence: 0.5 };
  assert.throws(() => judgeBySemantic(store, { ...base, source_id: '' }), /SourceID is required/);
  assert.throws(() => judgeBySemantic(store, { ...base, target_id: '' }), /TargetID is required/);
  assert.throws(() => judgeBySemantic(store, { ...base, relation: 'x' }), code('invalid_relation_verb'));
  for (const bad of [-0.1, 1.1, Number.NaN, Infinity]) {
    assert.throws(() => judgeBySemantic(store, { ...base, confidence: bad }), code('invalid_confidence'));
  }
  judgeBySemantic(store, { ...base, confidence: 0 }); // los extremos son válidos
  judgeBySemantic(store, { source_id: 'c', target_id: 'd', relation: 'related', confidence: 1 });
});

test('getRelationsForObservations: como origen y destino; sin huérfanas; marca extremos ausentes', (t) => {
  const store = setup(t);
  const a = save(store, 'Alfa');
  const b = save(store, 'Beta');
  const c = save(store, 'Gamma');
  const [sa, sb, sc] = [a, b, c].map((id) => syncId(store, id));
  saveRelation(store, { sync_id: 'r1', source_id: sa, target_id: sb });
  saveRelation(store, { sync_id: 'r2', source_id: sc, target_id: sa });
  saveRelation(store, { sync_id: 'r3', source_id: sb, target_id: sc });
  const rels = getRelationsForObservations(store, [sa]);
  assert.deepEqual(rels[sa].as_source.map((r) => r.sync_id), ['r1']);
  assert.deepEqual(rels[sa].as_target.map((r) => r.sync_id), ['r2']);
  assert.equal(rels[sa].as_source[0].target_title, 'Beta');
  assert.equal(rels[sa].as_source[0].source_missing, false);
  assert.deepEqual(getRelationsForObservations(store, []), {});
  assert.equal(getRelationsForObservations(store, ['nada']).nada, undefined);

  deleteObservation(store, b); // borrado suave: la relación sigue, con el extremo marcado como ausente
  assert.equal(getRelationsForObservations(store, [sa])[sa].as_source[0].target_missing, true);
  deleteObservation(store, c, { hardDelete: true }); // borrado duro: sus relaciones quedan huérfanas y se excluyen
  const after = getRelationsForObservations(store, [sa])[sa];
  assert.deepEqual(after.as_target, []);
});

test('listRelations y countRelations: filtros, orden, paginación y relaciones accionables', (t) => {
  const store = setup(t);
  const a = syncId(store, save(store, 'Alfa'));
  const b = syncId(store, save(store, 'Beta'));
  const o = syncId(store, addObservation(store, { session_id: 's2', type: 'manual', title: 'Otra', content: 'x' }).id);
  saveRelation(store, { sync_id: 'r1', source_id: a, target_id: b });
  saveRelation(store, { sync_id: 'r2', source_id: a, target_id: o }); // entre proyectos y pendiente
  judgeBySemantic(store, { source_id: b, target_id: a, relation: 'not_conflict', confidence: 0.5 });
  assert.equal(countRelations(store), 2); // r2 + la relación a↔b reorientada
  const all = listRelations(store);
  assert.deepEqual(all.map((r) => r.sync_id), ['r2', 'r1']); // más reciente primero (desempate por id)
  assert.equal(all[0].source_title, 'Alfa');
  assert.equal(all[0].target_title, 'Otra');
  assert.deepEqual(listRelations(store, { status: 'judged' }).map((r) => r.sync_id), ['r1']);
  assert.deepEqual(listRelations(store, { exclude_not_conflict: true }).map((r) => r.sync_id), ['r2']);
  assert.deepEqual(listRelations(store, { actionable_only: true }).map((r) => r.sync_id), ['r1']); // r2 cruza proyectos
  assert.equal(countRelations(store, { actionable_only: true }), 1);
  assert.deepEqual(listRelations(store, { limit: 1 }).map((r) => r.sync_id), ['r2']);
  assert.deepEqual(listRelations(store, { limit: 1, offset: 1 }).map((r) => r.sync_id), ['r1']);
  assert.deepEqual(listRelations(store, { project: 'otro' }).map((r) => r.sync_id), ['r2']);
  assert.deepEqual(listRelations(store, { since_time: new Date('2999-01-01T00:00:00Z') }), []);
  assert.equal(getRelationByIntId(store, all[0].id).target_title, 'Otra');
  assert.throws(() => getRelationByIntId(store, 999), code('relation_not_found'));
});
