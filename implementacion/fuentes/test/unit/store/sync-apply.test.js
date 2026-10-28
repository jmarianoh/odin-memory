import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_CHUNK_TARGET_KEY, RELATION_FK_MISSING, RELATION_PROJECT_MISMATCH, addObservation, applyPulledChunk, createSession, decodeSyncPayload, enqueueDeferredRelation,
  getObservation, getSession, getSyncedChunksForTarget, listDeferred, rearmEligibleDeadRelationsForScope, replayDeferred, replayDeferredForScope,
} from '../../../src/store/index.js';
import { newMutation } from '../../../src/store/sync-chunks.js';
import { openTempStore } from './helpers.js';

const T = LOCAL_CHUNK_TARGET_KEY;
const mutation = (entity, entityKey, op, payload, project = '') => newMutation({ entity, entity_key: entityKey, op, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), project });
const session = (id, extra = {}) => mutation('session', id, 'upsert', { id, project: 'demo', directory: '/tmp/x', started_at: '2026-01-01 10:00:00', ...extra });
const observation = (syncId, extra = {}) => mutation('observation', syncId, 'upsert', {
  sync_id: syncId, session_id: 's1', type: 'decision', title: `Título ${syncId}`, content: 'contenido', project: 'demo', scope: 'project', revision_count: 1, duplicate_count: 1,
  created_at: '2026-01-01 10:00:00', updated_at: '2026-01-01 10:00:00', ...extra,
});
const observationDelete = (syncId, extra = {}) => mutation('observation', syncId, 'delete', { sync_id: syncId, session_id: 's1', project: 'demo', deleted: true, deleted_at: '2026-02-01 10:00:00', ...extra });
const relation = (syncId, source, target, extra = {}, outer = '') => mutation('relation', syncId, 'upsert', {
  sync_id: syncId, source_id: source, target_id: target, relation: 'related', judgment_status: 'judged', project: 'demo', created_at: '2026-01-01 10:00:00', updated_at: '2026-01-01 10:00:00', ...extra,
}, outer);
const prompt = (syncId, extra = {}) => mutation('prompt', syncId, 'upsert', { sync_id: syncId, session_id: 's1', content: 'un prompt', project: 'demo', created_at: '2026-01-01 10:00:00', ...extra });

const apply = (store, id, mutations) => applyPulledChunk(store, T, id, mutations);
const obsRow = (store, syncId) => store.db.get('SELECT * FROM observations WHERE sync_id = ?', syncId);
const deferredRows = (store) => store.db.all('SELECT sync_id, entity, apply_status, reason_code, retry_count, project, scope_class, target_key FROM sync_apply_deferred ORDER BY sync_id');

test('un chunk crea sesiones, observaciones, prompts y relaciones y queda registrado', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [session('s1'), observation('obs-1'), observation('obs-2'), prompt('prompt-1'), relation('rel-1', 'obs-1', 'obs-2')]);
  assert.equal(getSession(store, 's1').project, 'demo');
  assert.equal(obsRow(store, 'obs-1').title, 'Título obs-1');
  assert.equal(store.db.get('SELECT content FROM user_prompts WHERE sync_id = ?', 'prompt-1').content, 'un prompt');
  assert.equal(store.db.get('SELECT relation FROM memory_relations WHERE sync_id = ?', 'rel-1').relation, 'related');
  assert.deepEqual([...getSyncedChunksForTarget(store, T)], ['c1']);
  const state = store.db.get("SELECT lifecycle, last_pulled_seq, consecutive_failures FROM sync_state WHERE target_key = 'local'");
  assert.deepEqual({ ...state }, { lifecycle: 'healthy', last_pulled_seq: 5, consecutive_failures: 0 });
});

test('aplicar dos veces el mismo chunk no hace nada y exige un identificador', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [session('s1'), observation('obs-1')]);
  store.db.run("UPDATE observations SET title = 'cambiado localmente' WHERE sync_id = 'obs-1'");
  apply(store, 'c1', [session('s1'), observation('obs-1')]);
  assert.equal(obsRow(store, 'obs-1').title, 'cambiado localmente');
  assert.equal(store.db.get("SELECT last_pulled_seq FROM sync_state WHERE target_key = 'local'").last_pulled_seq, 2);
  assert.throws(() => apply(store, '  ', []), { message: 'chunk id is required' });
});

test('una observación existente se actualiza conservando lo que la carga no trae', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [session('s1'), observation('obs-1', { revision_count: 3, duplicate_count: 2, last_seen_at: '2026-01-05 10:00:00' })]);
  apply(store, 'c2', [mutation('observation', 'obs-1', 'upsert', { sync_id: 'obs-1', session_id: 's1', type: 'decision', title: 'Nuevo título', content: 'nuevo contenido', scope: 'project', project: 'demo' })]);
  const row = obsRow(store, 'obs-1');
  assert.equal(row.title, 'Nuevo título');
  assert.equal(row.revision_count, 3, 'sin revision_count en la carga se conserva');
  assert.equal(row.duplicate_count, 2);
  assert.equal(row.last_seen_at, '2026-01-05 10:00:00');
  assert.equal(row.created_at, '2026-01-01 10:00:00');
});

test('las observaciones heredadas sin review_after reciben la fecha de su tipo', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [
    session('s1'), observation('obs-d', { type: 'decision' }), observation('obs-p', { type: 'policy' }), observation('obs-f', { type: 'preference' }), observation('obs-m', { type: 'manual' }),
    observation('obs-x', { type: 'decision', review_after: null }), observation('obs-y', { type: 'decision', review_after: '2030-01-02 03:04:05' }),
  ]);
  const review = (id) => obsRow(store, id).review_after;
  assert.equal(review('obs-d'), '2026-07-01 10:00:00');
  assert.equal(review('obs-p'), '2027-01-01 10:00:00');
  assert.equal(review('obs-f'), '2026-04-01 10:00:00');
  assert.equal(review('obs-m'), null);
  assert.equal(review('obs-x'), null, 'un null explícito es un borrado de la fecha');
  assert.equal(review('obs-y'), '2030-01-02 03:04:05');
  apply(store, 'c2', [observation('obs-y', { review_after: null, updated_at: '2026-01-02 10:00:00' })]);
  assert.equal(review('obs-y'), null);
  apply(store, 'c3', [mutation('observation', 'obs-d', 'upsert', { sync_id: 'obs-d', session_id: 's1', type: 'decision', title: 'T', content: 'c', scope: 'project' })]);
  assert.equal(review('obs-d'), '2026-07-01 10:00:00', 'una carga sin review_after conserva la fecha');
  assert.throws(() => apply(store, 'c4', [observation('obs-z', { review_after: 5 })]), /decode review_after/);
  assert.throws(() => apply(store, 'c5', [observation('obs-z', { review_after: 'mañana' })]), /invalid review_after/);
});

test('los borrados suave y duro, las lápidas y las altas posteriores', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [session('s1'), observation('obs-1'), observation('obs-2')]);
  apply(store, 'c2', [observationDelete('obs-1')]);
  const soft = obsRow(store, 'obs-1');
  assert.equal(soft.deleted_at, '2026-02-01 10:00:00');
  assert.equal(soft.updated_at, '2026-02-01 10:00:00');
  assert.equal(store.db.get("SELECT count(*) AS n FROM sync_delete_tombstones WHERE entity_key = 'obs-1'").n, 0, 'un borrado suave no deja lápida');

  apply(store, 'c3', [observationDelete('obs-2', { hard_delete: true })]);
  assert.equal(obsRow(store, 'obs-2'), undefined);
  const tombstone = store.db.get("SELECT * FROM sync_delete_tombstones WHERE entity = 'observation' AND entity_key = 'obs-2'");
  assert.deepEqual([tombstone.hard_delete, tombstone.active, tombstone.deleted_at, tombstone.project], [1, 1, '2026-02-01 10:00:00', 'demo']);

  // Un alta anterior al borrado no resucita; una posterior sí.
  apply(store, 'c4', [observation('obs-2', { updated_at: '2026-01-15 10:00:00' })]);
  assert.equal(obsRow(store, 'obs-2'), undefined);
  apply(store, 'c5', [observation('obs-2', { updated_at: '2026-03-01 10:00:00', title: 'Resucitada' })]);
  assert.equal(obsRow(store, 'obs-2').title, 'Resucitada');
  assert.equal(store.db.get("SELECT active FROM sync_delete_tombstones WHERE entity_key = 'obs-2'").active, 0);
  apply(store, 'c6', [observationDelete('obs-nunca-vista', { hard_delete: true })]);
});

test('la procedencia de sustitución se conserva entre el borrado y el alta', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [session('s1'), observation('obs-1'), observation('obs-new')]);
  apply(store, 'c2', [observationDelete('obs-1', { superseded_by_sync_id: 'obs-new' })]);
  assert.equal(obsRow(store, 'obs-1').superseded_by_sync_id, 'obs-new');
  apply(store, 'c3', [observationDelete('obs-1', { hard_delete: true })]);
  assert.equal(store.db.get("SELECT superseded_by_sync_id AS s, active FROM sync_delete_tombstones WHERE entity_key = 'obs-1'").s, 'obs-new');
  apply(store, 'c4', [observation('obs-1', { updated_at: '2026-04-01 10:00:00' })]);
  assert.equal(obsRow(store, 'obs-1').superseded_by_sync_id, 'obs-new', 'el alta posterior recupera el enlace');
});

test('las sesiones: propiedad, directorios y borrados con altas posteriores', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [session('s1', { ownership_mode: 'project_owned', directory: '/tmp/uno' })]);
  apply(store, 'c2', [session('s1', { project: 'otro', ownership_mode: 'shared', directory: '/tmp/dos', summary: 'resumen' })]);
  const kept = getSession(store, 's1');
  assert.deepEqual([kept.project, kept.ownership_mode, kept.directory, kept.summary], ['demo', 'project_owned', '/tmp/uno', 'resumen']);
  apply(store, 'c3', [session('s2', { directory: '   ' })]);
  apply(store, 'c4', [session('s2', { directory: '/tmp/real' })]);
  assert.equal(getSession(store, 's2').directory, '/tmp/real', 'un directorio en blanco se completa');
  assert.throws(() => apply(store, 'c5', [session('s3', { ownership_mode: 'raro' })]), /invalid session ownership mode "raro"/);
  assert.throws(() => apply(store, 'c6', [mutation('session', 's4', 'upsert', { id: 's4', project: 'demo', directory: null })]), /directory must be a string/);

  // Borrado de sesión: se lleva los prompts y deja lápida.
  apply(store, 'c7', [prompt('prompt-1', { session_id: 's2' })]);
  apply(store, 'c8', [mutation('session', 's2', 'delete', { id: 's2', project: 'demo', deleted: true, deleted_at: '2026-02-01 10:00:00', hard_delete: true })]);
  assert.equal(getSession(store, 's2'), null);
  assert.equal(store.db.get("SELECT count(*) AS n FROM user_prompts WHERE session_id = 's2'").n, 0);
  assert.equal(store.db.get("SELECT hard_delete FROM sync_delete_tombstones WHERE entity = 'session' AND entity_key = 's2'").hard_delete, 1);
  apply(store, 'c9', [session('s2', { started_at: '2026-01-02 10:00:00' })]);
  assert.equal(getSession(store, 's2'), null, 'un alta anterior al borrado no la resucita');

  // Si una alta posterior del mismo lote, más reciente que el borrado, la reclama, el borrado no la elimina.
  apply(store, 'c10', [
    session('s5'), mutation('session', 's5', 'delete', { id: 's5', project: 'demo', deleted: true, hard_delete: true, deleted_at: '2025-06-01 00:00:00' }), session('s5', { summary: 'viva' }),
  ]);
  assert.equal(getSession(store, 's5').summary, 'viva');
  // Si el alta es anterior al borrado, este se aplica y la sesión no vuelve.
  apply(store, 'c11', [
    session('s6'), mutation('session', 's6', 'delete', { id: 's6', project: 'demo', deleted: true, hard_delete: true, deleted_at: '2027-06-01 00:00:00' }), session('s6', { summary: 'vieja' }),
  ]);
  assert.equal(getSession(store, 's6'), null);
});

test('la identidad de una sesión debe coincidir con su clave', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [mutation('session', 's1', 'upsert', { id: 'otra', project: 'demo', directory: '/tmp/x' })]);
  assert.equal(getSession(store, 's1'), null);
  const row = store.db.get('SELECT * FROM sync_apply_deferred');
  assert.deepEqual([row.apply_status, row.reason_code, row.entity, row.target_key], ['dead', 'sync_session_identity_invalid', 'session', 'local']);
  apply(store, 'c2', [mutation('session', '  ', 'upsert', { id: '', project: 'demo' })]);
  assert.equal(store.db.get('SELECT count(*) AS n FROM sync_apply_deferred').n, 2);
});

test('la identidad de una observación debe coincidir con su clave y el padre debe existir', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [session('s1'), mutation('observation', 'obs-a', 'upsert', { sync_id: 'obs-b', session_id: 's1', type: 'x', title: 't', content: 'c', scope: 'project' })]);
  assert.equal(store.db.get("SELECT reason_code FROM sync_apply_deferred WHERE entity = 'observation'").reason_code, 'sync_observation_identity_invalid');
  assert.equal(store.db.get("SELECT apply_status FROM sync_apply_deferred WHERE entity = 'observation'").apply_status, 'dead');
  apply(store, 'c2', [observation('obs-huerfana', { session_id: 's-ausente' })]);
  const parent = store.db.get("SELECT apply_status, reason_code, scope_class, project FROM sync_apply_deferred WHERE entity_key = 'obs-huerfana'");
  assert.deepEqual({ ...parent }, { apply_status: 'deferred', reason_code: 'pulled_parent_session_missing', scope_class: 'scoped', project: 'demo' });
  assert.equal(obsRow(store, 'obs-huerfana'), undefined);
  // Cuando llega el padre, la repetición aplica la observación.
  apply(store, 'c3', [session('s-ausente')]);
  const replay = replayDeferred(store);
  assert.deepEqual(replay, { retried: 1, succeeded: 1, failed: 0, dead: 0 });
  assert.equal(obsRow(store, 'obs-huerfana').title, 'Título obs-huerfana');
});

test('los prompts: lápidas, bandejas y borrados', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [session('s1'), prompt('prompt-1'), prompt('prompt-2', { source_inbox_id: 'inbox-1' })]);
  apply(store, 'c2', [mutation('prompt', 'prompt-1', 'delete', { sync_id: 'prompt-1', session_id: 's1', deleted: true, deleted_at: '2026-02-01 10:00:00', hard_delete: true })]);
  assert.equal(store.db.get("SELECT count(*) AS n FROM user_prompts WHERE sync_id = 'prompt-1'").n, 0);
  const tomb = store.db.get("SELECT * FROM prompt_tombstones WHERE sync_id = 'prompt-1'");
  assert.deepEqual([tomb.session_id, tomb.project, tomb.deleted_at], ['s1', 'demo', '2026-02-01 10:00:00'], 'el proyecto se deduce de la sesión');
  apply(store, 'c3', [prompt('prompt-1', { created_at: '2026-01-15 10:00:00' })]);
  assert.equal(store.db.get("SELECT count(*) AS n FROM user_prompts WHERE sync_id = 'prompt-1'").n, 0, 'un alta anterior al borrado es obsoleta');
  apply(store, 'c4', [prompt('prompt-1', { created_at: '2026-03-01 10:00:00' })]);
  assert.equal(store.db.get("SELECT count(*) AS n FROM user_prompts WHERE sync_id = 'prompt-1'").n, 1);
  assert.equal(store.db.get("SELECT count(*) AS n FROM prompt_tombstones WHERE sync_id = 'prompt-1'").n, 0);

  // Una bandeja borrada impide su reaparición; identidades contradictorias se archivan.
  apply(store, 'c5', [mutation('prompt', 'prompt-2', 'delete', { sync_id: 'prompt-2', session_id: 's1', source_inbox_id: 'inbox-1', deleted: true, hard_delete: true })]);
  apply(store, 'c6', [prompt('prompt-3', { source_inbox_id: 'inbox-1' }), prompt('prompt-2', { source_inbox_id: 'inbox-1', created_at: '2030-01-01 00:00:00' })]);
  assert.equal(store.db.get("SELECT count(*) AS n FROM user_prompts WHERE source_inbox_id = 'inbox-1'").n, 0);
  apply(store, 'c7', [prompt('prompt-4', { source_inbox_id: 'inbox-2' })]);
  apply(store, 'c8', [prompt('prompt-5', { source_inbox_id: 'inbox-2' })]);
  const dead = store.db.get("SELECT reason_code, apply_status FROM sync_apply_deferred WHERE entity = 'prompt'");
  assert.deepEqual({ ...dead }, { reason_code: 'sync_prompt_identity_invalid', apply_status: 'dead' });
  apply(store, 'c9', [prompt('prompt-6', { session_id: 's-ausente' })]);
  assert.equal(store.db.get("SELECT reason_code FROM sync_apply_deferred WHERE entity_key = 'prompt-6'").reason_code, 'pulled_parent_session_missing');
  apply(store, 'c10', [mutation('prompt', '  ', 'delete', { sync_id: '  ' })]);
});

test('las relaciones sin extremos quedan diferidas y se aplican al llegar', (t) => {
  const logs = [];
  const store = openTempStore(t, { log: (m) => logs.push(m) });
  apply(store, 'c1', [session('s1'), observation('obs-1'), relation('rel-1', 'obs-1', 'obs-2')]);
  assert.equal(store.db.get("SELECT count(*) AS n FROM memory_relations").n, 0);
  assert.deepEqual(deferredRows(store).map((r) => [r.sync_id, r.apply_status, r.scope_class, r.project]), [['rel-1', 'deferred', 'scoped', 'demo']]);
  assert.match(logs[0], /^\[store\] relation apply seq=3 entity_key=rel-1 sync_id=rel-1 err=relation FK precondition not met: referenced observation missing - marking deferred$/);
  apply(store, 'c2', [observation('obs-2')]);
  const result = replayDeferred(store);
  assert.deepEqual(result, { retried: 1, succeeded: 1, failed: 0, dead: 0 });
  assert.equal(store.db.get('SELECT count(*) AS n FROM memory_relations').n, 1);
  assert.equal(store.db.get('SELECT count(*) AS n FROM sync_apply_deferred').n, 0);
  assert.ok(logs.some((m) => m === '[store] replayDeferred: applied sync_id=rel-1'));
  assert.equal(replayDeferred(store).retried, 0);
});

test('una relación entre extremos de distinto proyecto se difiere por desajuste de proyecto', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [session('s1'), observation('obs-1'), observation('obs-2', { project: 'otro' }), relation('rel-1', 'obs-1', 'obs-2')]);
  const [row] = deferredRows(store);
  assert.deepEqual([row.sync_id, row.apply_status], ['rel-1', 'deferred']);
  const result = replayDeferred(store);
  assert.deepEqual(result, { retried: 1, succeeded: 0, failed: 1, dead: 0 });
  assert.equal(store.db.get('SELECT last_error FROM sync_apply_deferred').last_error, RELATION_PROJECT_MISMATCH);
});

test('el proyecto externo de la mutación manda sobre el de la carga y se recuerda al reintentar', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [session('s1'), observation('obs-1'), relation('rel-1', 'obs-1', 'obs-2', { project: 'otro' }, 'demo')]);
  const [row] = deferredRows(store);
  assert.deepEqual([row.reason_code, row.project], ['relation_outer_project_authoritative', 'demo']);
  apply(store, 'c2', [observation('obs-2')]);
  assert.equal(replayDeferred(store).succeeded, 1, 'con el proyecto externo (demo) los extremos coinciden');
});

test('una relación mal formada muere sin reintentos y una repetida se acumula', (t) => {
  const store = openTempStore(t);
  const bad = [
    mutation('relation', 'rel-a', 'upsert', 'no es json'),
    mutation('relation', 'rel-b', 'upsert', { sync_id: 'rel-b' }),
    mutation('relation', 'rel-c', 'upsert', { sync_id: 'rel-x', source_id: 'a', target_id: 'b', relation: 'related', judgment_status: 'judged' }),
    mutation('relation', 'rel-d', 'delete', { sync_id: 'rel-d', source_id: 'a', target_id: 'b', relation: 'related', judgment_status: 'judged' }),
  ];
  apply(store, 'c1', [session('s1'), ...bad]);
  const rows = deferredRows(store);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.apply_status === 'dead' && r.sync_id.startsWith('relation-dead-') && r.scope_class === 'target_scoped' && r.target_key === 'local'));
  apply(store, 'c2', [...bad]);
  assert.equal(deferredRows(store).length, 4, 'el mismo fallo no duplica la evidencia');
});

test('encolar una relación antes de aplicarla la deja diferida y reactiva la muerta', (t) => {
  const logs = [];
  const store = openTempStore(t, { log: (m) => logs.push(m) });
  const rel = relation('rel-1', 'obs-1', 'obs-2');
  enqueueDeferredRelation(store, 'local', rel);
  assert.deepEqual(deferredRows(store).map((r) => r.apply_status), ['deferred']);
  assert.match(logs[0], /^\[store\] EnqueueDeferredRelation entity_key=rel-1 sync_id=rel-1 - queued before apply/);
  store.db.run("UPDATE sync_apply_deferred SET apply_status = 'dead', retry_count = 5");
  enqueueDeferredRelation(store, 'local', rel);
  assert.deepEqual(deferredRows(store).map((r) => [r.apply_status, r.retry_count]), [['deferred', 0]]);
  assert.throws(() => enqueueDeferredRelation(store, 'local', observation('obs-1')), { message: 'EnqueueDeferredRelation: unsupported entity "observation"' });
});

test('replayDeferred cuenta intentos, mata al quinto y filtra por destino y proyecto', (t) => {
  const logs = [];
  const store = openTempStore(t, { log: (m) => logs.push(m) });
  apply(store, 'c1', [session('s1'), observation('obs-1'), relation('rel-1', 'obs-1', 'obs-ausente')]);
  for (let i = 1; i <= 4; i++) {
    assert.deepEqual(replayDeferred(store), { retried: 1, succeeded: 0, failed: 1, dead: 0 }, `intento ${i}`);
    assert.equal(store.db.get('SELECT retry_count FROM sync_apply_deferred').retry_count, i);
  }
  assert.deepEqual(replayDeferred(store), { retried: 1, succeeded: 0, failed: 0, dead: 1 });
  assert.deepEqual(deferredRows(store).map((r) => [r.apply_status, r.retry_count]), [['dead', 5]]);
  assert.match(logs.at(-1), /^\[store\] replayDeferred: marking dead sync_id=rel-1 retry_count=5 err=relation FK precondition not met/);
  assert.equal(replayDeferred(store).retried, 0, 'las muertas no se reintentan');

  // Filtros de ámbito.
  const scoped = openTempStore(t);
  apply(scoped, 'c1', [session('s1'), observation('obs-1'), relation('rel-1', 'obs-1', 'obs-x'), relation('rel-2', 'obs-1', 'obs-y', { project: 'otro' })]);
  scoped.db.run("UPDATE sync_apply_deferred SET target_key = 'cloud:otro' WHERE sync_id = 'rel-2'");
  assert.equal(replayDeferredForScope(scoped, 'local', '').retried, 1);
  assert.equal(replayDeferredForScope(scoped, 'cloud:otro', 'demo').retried, 0);
  assert.equal(replayDeferredForScope(scoped, '', 'otro').retried, 1);
  scoped.db.run("UPDATE sync_apply_deferred SET scope_class = 'legacy_unscoped'");
  assert.equal(replayDeferredForScope(scoped, 'local', '').retried, 0, 'lo heredado sin ámbito no se reintenta por destino');
  assert.equal(replayDeferred(scoped).retried, 2);
});

test('el reintento de más de 50 filas se hace por lotes y los fallos inesperados las matan', (t) => {
  const store = openTempStore(t);
  for (let i = 0; i < 55; i++) {
    store.db.run(
      "INSERT INTO sync_apply_deferred (sync_id, entity, payload, target_key, entity_key, op, project, scope_class, apply_status) VALUES (?, 'relation', ?, 'local', ?, 'upsert', 'demo', 'scoped', 'deferred')",
      `rel-${String(i).padStart(2, '0')}`, JSON.stringify({ sync_id: `rel-${String(i).padStart(2, '0')}`, source_id: 'a', target_id: 'b', relation: 'related', judgment_status: 'judged', project: 'demo' }), `rel-${String(i).padStart(2, '0')}`,
    );
  }
  assert.equal(replayDeferred(store).retried, 50);
  assert.equal(replayDeferred(store).retried, 50, 'cada pasada toma las 50 más antiguas');
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_apply_deferred WHERE retry_count = 2").n, 50);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_apply_deferred WHERE retry_count = 0").n, 5);
  store.db.run("INSERT INTO sync_apply_deferred (sync_id, entity, payload, entity_key, op, apply_status, scope_class, project, target_key) VALUES ('raro', 'wat', '{}', 'raro', 'upsert', 'deferred', 'scoped', 'demo', 'local')");
  store.db.run("DELETE FROM sync_apply_deferred WHERE sync_id LIKE 'rel-%'");
  assert.deepEqual(replayDeferred(store), { retried: 1, succeeded: 0, failed: 0, dead: 1 });
  assert.equal(store.db.get("SELECT last_error FROM sync_apply_deferred WHERE sync_id = 'raro'").last_error, 'unknown sync entity "wat"');
});

test('rearmEligibleDeadRelationsForScope reactiva las muertas cuyos extremos ya existen', (t) => {
  const store = openTempStore(t);
  apply(store, 'c1', [session('s1'), observation('obs-1'), relation('rel-1', 'obs-1', 'obs-2')]);
  for (let i = 0; i < 5; i++) replayDeferred(store);
  assert.equal(deferredRows(store)[0].apply_status, 'dead');
  assert.equal(rearmEligibleDeadRelationsForScope(store, 'local', 'demo'), 0, 'faltan extremos');
  apply(store, 'c2', [observation('obs-2')]);
  assert.equal(rearmEligibleDeadRelationsForScope(store, 'local', ''), 0, 'sin proyecto no hace nada');
  assert.equal(rearmEligibleDeadRelationsForScope(store, 'local', 'otro'), 0);
  assert.equal(rearmEligibleDeadRelationsForScope(store, 'local', 'demo'), 1);
  assert.deepEqual(deferredRows(store).map((r) => [r.apply_status, r.retry_count]), [['deferred', 0]]);
  assert.equal(replayDeferred(store).succeeded, 1);
});

test('un fallo inesperado revierte el chunk entero', (t) => {
  const store = openTempStore(t);
  assert.throws(
    () => apply(store, 'c1', [session('s1'), observation('obs-1'), mutation('wat', 'x', 'upsert', '{}')]),
    (e) => /^apply chunk mutation 2: unknown sync entity "wat"$/.test(e.message),
  );
  assert.equal(getSession(store, 's1'), null);
  assert.equal(getSyncedChunksForTarget(store, T).size, 0);
  const created = addObservation(store, { session_id: (createSession(store, 'x', 'demo', '/tmp'), 'x'), type: 'manual', title: 'local', content: 'c', project: 'demo' });
  assert.ok(getObservation(store, created.id));
});

test('decodeSyncPayload admite JSON directo o dentro de una cadena', () => {
  assert.deepEqual(decodeSyncPayload('{"a":1}'), { a: 1 });
  assert.deepEqual(decodeSyncPayload('  {"a":1}  '), { a: 1 });
  assert.deepEqual(decodeSyncPayload('"{\\"a\\":1}"'), { a: 1 });
  assert.throws(() => decodeSyncPayload(''), { message: 'empty payload' });
  assert.throws(() => decodeSyncPayload('   '), { message: 'empty payload' });
  assert.throws(() => decodeSyncPayload('{rota'));
  assert.equal(RELATION_FK_MISSING, 'relation FK precondition not met: referenced observation missing');
  assert.equal(listDeferred(openTempStore({ after() {} })).length, 0);
});
