import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCAN_LIMIT, addObservation, countDeferredAndDead, createSession, getActionableRelationStats, getDeferred, getObservation, judgeRelation, listDeferred,
  listRelations, pruneDeadRows, scanAllProjects, scanProject,
} from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

function seed(t, rows = [
  ['Usar Redis para la caché', 'a'], ['Redis como caché distribuida', 'b'], ['Caché local en memoria', 'c'], ['Tokens de acceso', 'd'], ['Acceso con tokens', 'e'],
], project = 'demo') {
  const store = openTempStore(t);
  createSession(store, 's1', project, '/tmp/x');
  const ids = rows.map(([title, content]) => addObservation(store, { session_id: 's1', type: 'decision', title, content, project }).id);
  return { store, ids };
}

const insertDeferred = (store, row) => {
  const r = {
    entity: 'relation', payload: '{}', target_key: 'cloud:demo', remote_seq: 0, entity_key: '', op: 'upsert', reason_code: '', project: 'demo', scope_class: 'scoped',
    apply_status: 'dead', retry_count: 0, payload_sync_id: '', last_error: null, first_seen_at: '2026-03-01 10:00:00', ...row,
  };
  store.db.run(
    `INSERT INTO sync_apply_deferred (sync_id, entity, payload, target_key, remote_seq, entity_key, op, reason_code, project, scope_class, apply_status, retry_count, payload_sync_id, last_error, first_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    r.sync_id, r.entity, r.payload, r.target_key, r.remote_seq, r.entity_key, r.op, r.reason_code, r.project, r.scope_class, r.apply_status, r.retry_count, r.payload_sync_id, r.last_error, r.first_seen_at,
  );
};

test('scanProject sin apply no escribe y cuenta candidatos', async (t) => {
  const { store } = seed(t);
  const result = await scanProject(store, { project: 'demo' });
  assert.equal(result.dry_run, true);
  assert.equal(result.inspected, 5);
  assert.equal(result.ranked_queries, 5);
  assert.ok(result.candidates_found >= 4);
  assert.equal(result.inserted, 0);
  assert.equal(result.capped, false);
  assert.equal('next_cursor' in result, false);
  assert.equal(listRelations(store, {}).length, 0);
});

test('scanProject con apply registra relaciones pendientes una sola vez por par', async (t) => {
  const { store } = seed(t);
  const first = await scanProject(store, { project: 'demo', apply: true });
  assert.equal(first.dry_run, false);
  assert.ok(first.inserted > 0);
  const pairs = listRelations(store, {}).map((r) => [r.source_id, r.target_id].sort().join('|'));
  assert.equal(new Set(pairs).size, pairs.length, 'ningún par queda duplicado en ambos sentidos');
  const second = await scanProject(store, { project: 'demo', apply: true });
  assert.equal(second.inserted, 0);
  assert.equal(second.already_related, first.candidates_found);
  const stats = getActionableRelationStats(store, 'demo');
  assert.equal(stats.by_judgment_status.pending, first.inserted);
  assert.equal(stats.by_relation.pending, first.inserted);
});

test('scanProject pagina por id, respeta límite, cursor y topes', async (t) => {
  const { store, ids } = seed(t);
  const page = await scanProject(store, { project: 'demo', limit: 2 });
  assert.equal(page.inspected, 2);
  assert.equal(page.next_cursor, ids[1]);
  const next = await scanProject(store, { project: 'demo', limit: 2, cursor: page.next_cursor });
  assert.equal(next.inspected, 2);
  assert.equal(next.next_cursor, ids[3]);
  const last = await scanProject(store, { project: 'demo', limit: 2, cursor: next.next_cursor });
  assert.equal(last.inspected, 1);
  assert.equal('next_cursor' in last, false);

  const capped = await scanProject(store, { project: 'demo', apply: true, max_insert: 1 });
  assert.equal(capped.inserted, 1);
  assert.equal(capped.capped, true);
  assert.equal('next_cursor' in capped, false, 'una página topada no tiene continuación');

  await assert.rejects(scanProject(store, { project: 'demo', limit: DEFAULT_SCAN_LIMIT + 1 }), { code: 'invalid_scan_limit' });
  await assert.rejects(scanProject(store, { project: 'demo', limit: -1 }), { message: `ScanProject: limit must be between 1 and ${DEFAULT_SCAN_LIMIT}` });
  await assert.rejects(scanProject(store, { project: 'demo', cursor: -1 }), { message: 'ScanProject: cursor must be non-negative' });
});

test('scanProject filtra por proyecto, por ámbito y por fecha, y excluye lo ya juzgado', async (t) => {
  const { store, ids } = seed(t);
  createSession(store, 's2', 'otro', '/tmp/y');
  addObservation(store, { session_id: 's2', type: 'decision', title: 'Redis caché otro proyecto', content: 'x', project: 'otro' });
  addObservation(store, { session_id: 's1', type: 'decision', title: 'Redis caché personal', content: 'x', project: 'demo', scope: 'personal' });
  const scoped = await scanProject(store, { project: 'demo' });
  assert.equal(scoped.inspected, 6);
  const all = await scanAllProjects(store, {});
  assert.equal(all.inspected, 7);
  assert.equal(all.project, '');
  assert.equal((await scanProject(store, { project: 'nada' })).inspected, 0);
  assert.equal((await scanProject(store, { project: 'demo', since: new Date('2999-01-01T00:00:00Z') })).inspected, 0);

  await scanProject(store, { project: 'demo', apply: true });
  const relation = listRelations(store, {}).find((r) => [r.source_title, r.target_title].includes('Usar Redis para la caché'));
  judgeRelation(store, { judgment_id: relation.sync_id, relation: 'related', marked_by_actor: 'agent', marked_by_kind: 'agent' });
  const again = await scanProject(store, { project: 'demo' });
  assert.ok(again.candidates_found < scoped.candidates_found, 'un par ya juzgado deja de ser candidato');
  assert.ok(ids.length > 0);
});

const verdict = (relation, confidence = 0.9) => ({ relation, confidence, reasoning: 'porque sí', model: 'modelo-x' });

function fakeRunner(decide) {
  const calls = [];
  return {
    calls,
    async compare(prompt, signal) {
      calls.push({ prompt, signal });
      return decide(prompt, calls.length);
    },
  };
}

test('el escaneo semántico exige ejecutor y constructor de prompt', async (t) => {
  const { store } = seed(t);
  await assert.rejects(scanProject(store, { project: 'demo', semantic: true }), { code: 'semantic_runner_required' });
  await assert.rejects(scanProject(store, { project: 'demo', semantic: true, runner: fakeRunner(() => verdict('related')) }), { code: 'semantic_prompt_builder_required' });
});

test('el escaneo semántico juzga cada par una vez y contabiliza los resultados', async (t) => {
  const { store } = seed(t);
  const runner = fakeRunner((_, n) => (n === 1 ? verdict('not_conflict') : n === 2 ? Promise.reject(new Error('boom')) : verdict('conflicts_with')));
  const opts = { project: 'demo', semantic: true, runner, build_prompt: (a, b) => `${a.sync_id}+${b.sync_id}`, concurrency: 1, timeout_per_call_ms: 5000 };
  const dry = await scanProject(store, opts);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.semantic_skipped, 1, 'not_conflict en seco se descarta');
  assert.equal(dry.semantic_errors, 1);
  assert.ok(dry.semantic_judged >= 1);
  assert.equal(runner.calls.length, dry.semantic_judged + dry.semantic_skipped + dry.semantic_errors);
  assert.equal(new Set(runner.calls.map((c) => c.prompt)).size, runner.calls.length, 'cada par se consulta una vez');
  assert.ok(runner.calls.every((c) => c.signal instanceof AbortSignal));
  assert.equal(listRelations(store, {}).length, 0, 'en seco no se persiste nada');

  const applying = fakeRunner(() => verdict('conflicts_with'));
  const applied = await scanProject(store, { ...opts, runner: applying, apply: true });
  assert.equal(applied.semantic_judged, applying.calls.length);
  const judged = listRelations(store, {});
  assert.equal(judged.length, applied.semantic_judged);
  assert.ok(judged.every((r) => r.relation === 'conflicts_with' && r.judgment_status === 'judged'));
});

test('el escaneo semántico respeta el tope y reporta veredictos inválidos como errores al aplicar', async (t) => {
  const { store } = seed(t);
  const runner = fakeRunner(() => verdict('related'));
  const capped = await scanProject(store, { project: 'demo', semantic: true, runner, build_prompt: () => 'p', max_semantic: 2 });
  assert.equal(capped.capped, true);
  assert.equal(runner.calls.length, 2);

  const invalid = fakeRunner(() => verdict('inventada'));
  const result = await scanProject(store, { project: 'demo', semantic: true, apply: true, runner: invalid, build_prompt: () => 'p' });
  assert.equal(result.semantic_judged, 0);
  assert.equal(result.semantic_errors, invalid.calls.length);
});

test('las estadísticas omiten los pares pendientes entre proyectos y cuentan diferidos y muertos', (t) => {
  const { store } = seed(t);
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('demo')");
  insertDeferred(store, { sync_id: 'd1', apply_status: 'deferred' });
  insertDeferred(store, { sync_id: 'd2', apply_status: 'dead' });
  insertDeferred(store, { sync_id: 'd3', apply_status: 'dead', project: 'otro', target_key: 'cloud:otro' });
  insertDeferred(store, { sync_id: 'd4', apply_status: 'dead', scope_class: 'legacy_unscoped', project: '', target_key: 'cloud' });
  assert.deepEqual(countDeferredAndDead(store), { deferred: 1, dead: 3 });
  assert.deepEqual(countDeferredAndDead(store, '', 'demo'), { deferred: 1, dead: 1 });
  assert.deepEqual(countDeferredAndDead(store, 'CLOUD:demo'), { deferred: 1, dead: 1 });
  assert.deepEqual(countDeferredAndDead(store, 'cloud'), { deferred: 0, dead: 0 }, 'el ámbito global excluye lo heredado sin ámbito');
  const stats = getActionableRelationStats(store, 'demo');
  assert.deepEqual(stats, { project: 'demo', by_relation: {}, by_judgment_status: {}, deferred: 1, dead: 1 });
});

test('listDeferred y getDeferred decodifican la carga y marcan la inválida', (t) => {
  const { store } = seed(t);
  insertDeferred(store, { sync_id: 'a', payload: '{"x":1}', first_seen_at: '2026-03-01 10:00:00', remote_seq: 7, entity_key: 'rel-1', reason_code: 'fk', last_error: 'espera', apply_status: 'deferred', retry_count: 2 });
  insertDeferred(store, { sync_id: 'b', payload: 'no es json', first_seen_at: '2026-03-02 10:00:00' });
  insertDeferred(store, { sync_id: 'c', payload: '[1]', first_seen_at: '2026-03-03 10:00:00' });
  insertDeferred(store, { sync_id: 'd', payload: 'null', first_seen_at: '2026-03-04 10:00:00' });
  insertDeferred(store, { sync_id: 'e', payload: '{}', first_seen_at: '2026-03-05 10:00:00' });
  const rows = listDeferred(store);
  assert.deepEqual(rows.map((r) => r.sync_id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(rows.map((r) => r.payload_valid), [true, false, false, true, true]);
  assert.deepEqual(rows[0], {
    sync_id: 'a', entity: 'relation', target_key: 'cloud:demo', project: 'demo', scope_class: 'scoped', remote_seq: 7, entity_key: 'rel-1', op: 'upsert', reason_code: 'fk',
    payload: { x: 1 }, payload_raw: '{"x":1}', payload_valid: true, apply_status: 'deferred', retry_count: 2, last_error: 'espera', first_seen_at: '2026-03-01 10:00:00',
  });
  assert.equal('payload' in rows[3], false);
  assert.equal('payload' in rows[4], false, 'una carga vacía se omite');
  assert.equal('remote_seq' in rows[1], false);
  assert.equal('last_error' in rows[1], false);
  assert.deepEqual(listDeferred(store, { status: 'deferred' }).map((r) => r.sync_id), ['a']);
  assert.deepEqual(listDeferred(store, { limit: 2, offset: 1 }).map((r) => r.sync_id), ['b', 'c']);
  assert.equal(getDeferred(store, 'b').payload_raw, 'no es json');
  assert.throws(() => getDeferred(store, 'zzz'), { code: 'deferred_not_found', message: 'GetDeferred: deferred row "zzz" not found' });
});

test('pruneDeadRows poda por antigüedad y por tope de ámbito, y conserva lo recuperable', (t) => {
  const { store } = seed(t);
  const old = '2020-01-01 00:00:00';
  const recent = (n) => `2999-01-${String(n).padStart(2, '0')} 00:00:00`;
  insertDeferred(store, { sync_id: 'old', first_seen_at: old, entity: 'observation', reason_code: 'bad' });
  insertDeferred(store, { sync_id: 'r1', first_seen_at: recent(1), entity: 'observation', reason_code: 'bad' });
  insertDeferred(store, { sync_id: 'r2', first_seen_at: recent(2), entity: 'observation', reason_code: 'bad' });
  insertDeferred(store, { sync_id: 'r3', first_seen_at: recent(3), entity: 'session', reason_code: '' });
  insertDeferred(store, { sync_id: 'other', first_seen_at: recent(4), project: 'otro', target_key: 'cloud:otro' });
  insertDeferred(store, { sync_id: 'wait', first_seen_at: old, apply_status: 'deferred' });
  insertDeferred(store, {
    sync_id: 'rel-recoverable', first_seen_at: old, entity: 'relation', retry_count: 5, last_error: 'relation FK precondition not met: referenced observation missing',
    payload_sync_id: 'rel-recoverable', entity_key: 'rel-recoverable',
  });
  insertDeferred(store, {
    sync_id: 'rel-mismatch', first_seen_at: old, entity: 'relation', retry_count: 5, last_error: 'relation FK precondition not met: referenced observation effective project mismatch',
    payload_sync_id: 'rel-mismatch', entity_key: 'rel-mismatch',
  });
  insertDeferred(store, { sync_id: 'rel-other', first_seen_at: old, entity: 'relation', retry_count: 5, last_error: 'otro', payload_sync_id: 'rel-other', entity_key: 'rel-other' });

  const preview = pruneDeadRows(store, { max_age_days: 30, max_per_scope: 2 });
  assert.equal(preview.applied, false);
  assert.equal(preview.total, 3);
  assert.deepEqual(preview.scopes, [{ target_key: 'cloud:demo', project: 'demo', by_age: 2, by_cap: 1 }]);
  assert.deepEqual(preview.reasons.map((r) => [r.entity, r.reason_code, r.age_bucket, r.count]), [['observation', 'bad', '30d+', 1], ['observation', 'bad', 'unknown', 1], ['relation', '', '30d+', 1]]);
  assert.equal(store.db.get('SELECT count(*) AS n FROM sync_apply_deferred').n, 9, 'en seco no se borra');

  const applied = pruneDeadRows(store, { max_age_days: 30, max_per_scope: 2, apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.total, 3);
  const left = store.db.all('SELECT sync_id FROM sync_apply_deferred ORDER BY sync_id').map((r) => r.sync_id);
  assert.deepEqual(left, ['other', 'r2', 'r3', 'rel-mismatch', 'rel-recoverable', 'wait']);
  assert.equal(pruneDeadRows(store, { max_age_days: 30, max_per_scope: 2, apply: true }).total, 0);

  assert.throws(() => pruneDeadRows(store, { max_age_days: 0, max_per_scope: 1 }), { message: 'prune dead rows: max age days must be positive' });
  assert.throws(() => pruneDeadRows(store, { max_age_days: 1, max_per_scope: 0 }), { message: 'prune dead rows: max per scope must be positive' });
});

test('getObservation sigue disponible tras los escaneos', (t) => {
  const { store, ids } = seed(t);
  assert.equal(getObservation(store, ids[0]).title, 'Usar Redis para la caché');
});

// ─── Detalles del escaneo ────────────────────────────────────────────────────

test('el escaneo limita a diez los candidatos de cada observación', async (t) => {
  const rows = Array.from({ length: 13 }, (_, i) => [`Redis caché variante ${i}`, `c${i}`]);
  const { store } = seed(t, rows);
  const result = await scanProject(store, { project: 'demo' });
  assert.equal(result.inspected, 13);
  assert.equal(result.candidates_found, 13 * 10);
});

test('los candidatos respetan proyecto y ámbito', async (t) => {
  const { store } = seed(t, [['Redis caché distribuida', 'a'], ['Redis caché compartida', 'b']]);
  createSession(store, 's2', 'otro', '/tmp/y');
  addObservation(store, { session_id: 's2', type: 'decision', title: 'Redis caché distribuida', content: 'x', project: 'otro' });
  addObservation(store, { session_id: 's1', type: 'decision', title: 'Redis caché distribuida', content: 'x', project: 'demo', scope: 'personal' });
  const demo = await scanProject(store, { project: 'demo' });
  assert.equal(demo.inspected, 3);
  assert.equal(demo.candidates_found, 2, 'solo los dos del mismo proyecto y ámbito se ven entre sí');
  const all = await scanAllProjects(store, {});
  assert.equal(all.inspected, 4);
  assert.equal(all.candidates_found, 2 + 0 + 0 + 0, 'el escaneo global conserva los límites de ámbito y proyecto de cada fuente');
});

test('los candidatos se ordenan por coincidencias y luego por id, y no se repiten los pares', async (t) => {
  const { store, ids } = seed(t, [['alpha beta gamma', 'fuente'], ['alpha', 'uno'], ['alpha beta gamma', 'tres'], ['alpha beta', 'dos']]);
  const prompts = [];
  const runner = { compare: async (prompt) => { prompts.push(prompt); return { relation: 'related', confidence: 0.5, reasoning: '', model: '' }; } };
  await scanProject(store, { project: 'demo', semantic: true, runner, concurrency: 1, limit: 1, build_prompt: (a, b) => `${a.id}|${b.id}` });
  assert.deepEqual(prompts, [`${ids[0]}|${ids[2]}`, `${ids[0]}|${ids[3]}`, `${ids[0]}|${ids[1]}`]);
});

test('a igual puntuación los candidatos se ordenan por id ascendente', async (t) => {
  const { store, ids } = seed(t, [['alpha', 'fuente'], ['alpha', 'uno'], ['alpha', 'dos']]);
  const prompts = [];
  const runner = { compare: async (prompt) => { prompts.push(prompt); return { relation: 'related', confidence: 0.5, reasoning: '', model: '' }; } };
  await scanProject(store, { project: 'demo', semantic: true, runner, concurrency: 1, limit: 1, build_prompt: (a, b) => `${a.id}|${b.id}` });
  assert.deepEqual(prompts, [`${ids[0]}|${ids[1]}`, `${ids[0]}|${ids[2]}`]);
});

test('el tope de inserciones no marca como topada una página que termina justo en él', async (t) => {
  const { store, ids } = seed(t, [['alpha beta', 'a'], ['zzz unico', 'b'], ['alpha beta', 'c']]);
  const exact = await scanProject(store, { project: 'demo', apply: true, max_insert: 1, limit: 1 });
  assert.equal(exact.inserted, 1);
  assert.equal(exact.capped, false);
  assert.equal(exact.next_cursor, ids[0]);

  const { store: second } = seed(t, [['alpha beta', 'a'], ['zzz unico', 'b'], ['alpha beta', 'c']]);
  const page = await scanProject(second, { project: 'demo', apply: true, max_insert: 1, limit: 2 });
  assert.equal(page.inserted, 1);
  assert.equal(page.capped, false, 'una observación sin candidatos no agota el tope');
  assert.equal(typeof page.next_cursor, 'number');
});

test('una página topada con más observaciones por recorrer no tiene continuación', async (t) => {
  const { store } = seed(t, [['alpha beta', 'a'], ['alpha beta', 'b'], ['alpha beta', 'c'], ['alpha beta', 'd']]);
  const capped = await scanProject(store, { project: 'demo', apply: true, max_insert: 1, limit: 3 });
  assert.equal(capped.capped, true);
  assert.equal('next_cursor' in capped, false);
});

test('la concurrencia por defecto del escaneo semántico es 5 y cada llamada lleva su plazo', async (t) => {
  const { store } = seed(t, Array.from({ length: 6 }, (_, i) => [`alpha beta ${i}`, `c${i}`]));
  let running = 0;
  let peak = 0;
  const signals = [];
  const runner = {
    compare: async (_prompt, signal) => {
      running++;
      peak = Math.max(peak, running);
      signals.push(signal);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(signal.aborted, false, 'el plazo por defecto es de un minuto');
      running--;
      return { relation: 'related', confidence: 0.5, reasoning: '', model: '' };
    },
  };
  const result = await scanProject(store, { project: 'demo', semantic: true, runner, build_prompt: () => 'p' });
  assert.equal(peak, 5);
  assert.ok(result.semantic_judged > 5);
  assert.ok(signals.every((s) => s instanceof AbortSignal));
  const timed = [];
  const slow = { compare: async (_p, signal) => { timed.push(signal); await new Promise((r) => setTimeout(r, 120)); return { relation: 'related', confidence: 0.5, reasoning: '', model: '' }; } };
  await scanProject(store, { project: 'demo', semantic: true, runner: slow, build_prompt: () => 'p', timeout_per_call_ms: 40, max_semantic: 1 });
  assert.equal(timed[0].aborted, true, 'el plazo configurado vence');
});

test('si el lote de página falla, el escaneo usa el camino por observación y lo registra', async (t) => {
  const logs = [];
  const { store } = seed(t, [['alpha beta', 'a'], ['alpha beta gamma', 'b']]);
  store.config.log = (message) => logs.push(message);
  const original = store.db.all.bind(store.db);
  store.db.all = (sql, ...args) => {
    if (sql.startsWith('SELECT rowid FROM observations_fts')) throw new Error('lote roto');
    return original(sql, ...args);
  };
  const result = await scanProject(store, { project: 'demo', apply: true });
  assert.equal(result.inspected, 2);
  assert.ok(result.candidates_found > 0);
  assert.equal(result.inserted, 1);
  assert.match(logs[0], /^\[store\] ScanProject: batched candidates failed, falling back to per-source ranking: lote roto$/);
});

test('las estadísticas excluyen not_conflict y los pares pendientes entre proyectos', async (t) => {
  const { store, ids } = seed(t, [['alpha beta', 'a'], ['alpha beta', 'b']]);
  createSession(store, 's2', 'otro', '/tmp/y');
  const foreign = addObservation(store, { session_id: 's2', type: 'decision', title: 'alpha beta', content: 'x', project: 'otro' }).id;
  await scanProject(store, { project: 'demo', apply: true });
  const syncOf = (id) => getObservation(store, id).sync_id;
  const [first] = listRelations(store, {});
  judgeRelation(store, { judgment_id: first.sync_id, relation: 'not_conflict', marked_by_actor: 'agent', marked_by_kind: 'agent' });
  store.db.run("INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status) VALUES ('rel-cross', ?, ?, 'pending', 'pending')", syncOf(ids[0]), syncOf(foreign));
  assert.deepEqual(getActionableRelationStats(store, 'demo').by_relation, {}, 'solo había not_conflict y un par entre proyectos');
  assert.deepEqual(getActionableRelationStats(store, '').by_judgment_status, {});
  store.db.run("UPDATE memory_relations SET relation = 'related', judgment_status = 'judged' WHERE sync_id = 'rel-cross'");
  assert.deepEqual(getActionableRelationStats(store, '').by_relation, { related: 1 }, 'un juicio entre proyectos sí cuenta');
});

test('los diferidos de un proyecto no cuentan las filas heredadas sin ámbito', (t) => {
  const { store } = seed(t);
  insertDeferred(store, { sync_id: 'legacy', apply_status: 'dead', scope_class: 'legacy_unscoped' });
  insertDeferred(store, { sync_id: 'scoped', apply_status: 'dead' });
  assert.deepEqual(countDeferredAndDead(store, '', 'demo'), { deferred: 0, dead: 1 });
  assert.deepEqual(countDeferredAndDead(store), { deferred: 0, dead: 2 });
});

test('los cubos de edad de la poda separan 0-6, 7-29, 30+ y desconocida', (t) => {
  const { store } = seed(t);
  const ago = (days) => store.db.get(`SELECT datetime('now', '${days < 0 ? '+' : '-'}${Math.abs(days)} days') AS d`).d;
  insertDeferred(store, { sync_id: 'new1', first_seen_at: ago(-5), entity: 'a' });
  insertDeferred(store, { sync_id: 'new2', first_seen_at: ago(-3), entity: 'a' });
  insertDeferred(store, { sync_id: 'future', first_seen_at: ago(-1.5), entity: 'future' });
  insertDeferred(store, { sync_id: 'd3', first_seen_at: ago(3), entity: 'bucket' });
  insertDeferred(store, { sync_id: 'd7', first_seen_at: ago(7), entity: 'bucket' });
  insertDeferred(store, { sync_id: 'd29', first_seen_at: ago(29), entity: 'bucket' });
  insertDeferred(store, { sync_id: 'd30', first_seen_at: store.db.get("SELECT datetime('now', '-30 days', '-5 seconds') AS d").d, entity: 'bucket' });
  const result = pruneDeadRows(store, { max_age_days: 30, max_per_scope: 2 });
  const by = Object.fromEntries(result.reasons.map((r) => [`${r.entity}/${r.age_bucket}`, r.count]));
  assert.deepEqual(by, { 'future/unknown': 1, 'bucket/0-6d': 1, 'bucket/7-29d': 2, 'bucket/30d+': 1 });
  assert.deepEqual(result.reasons.map((r) => `${r.entity}/${r.age_bucket}`), ['bucket/0-6d', 'bucket/7-29d', 'bucket/30d+', 'future/unknown']);
});
