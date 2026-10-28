import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpWorld } from './helpers.js';

const ok = (r, status = 200) => {
  assert.equal(r.status, status, r.text);
  return r.json;
};

async function similar(w) {
  await w.call('POST', '/sessions', { id: 's1', project: 'demo', directory: w.repo });
  for (const [title, content] of [
    ['Usar Redis para la caché', 'a'], ['Redis como caché distribuida', 'b'], ['Caché local en memoria', 'c'], ['Tokens de acceso', 'd'], ['Acceso con tokens', 'e'],
  ]) ok(await w.call('POST', '/observations', { session_id: 's1', type: 'decision', title, content, project: 'demo' }), 201);
}

test('el escaneo en seco informa y con apply registra relaciones', async (t) => {
  const w = await httpWorld(t);
  await similar(w);
  const dry = ok(await w.call('POST', '/conflicts/scan', { project: 'demo' }));
  assert.deepEqual(Object.keys(dry), [
    'project', 'inspected', 'ranked_queries', 'candidates_found', 'already_related', 'inserted', 'capped', 'dry_run', 'semantic_judged', 'semantic_skipped', 'semantic_errors',
  ]);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.inspected, 5);
  assert.equal(dry.inserted, 0);
  const before = w.writes.length;
  const applied = ok(await w.call('POST', '/conflicts/scan', { project: 'demo', apply: true }));
  assert.equal(applied.dry_run, false);
  assert.ok(applied.inserted > 0);
  assert.equal(w.writes.length, before, 'el escaneo no avisa de escritura');
  const page = ok(await w.call('POST', '/conflicts/scan', { project: 'demo', limit: 2 }));
  assert.equal(typeof page.next_cursor, 'number');
  const capped = ok(await w.call('POST', '/conflicts/scan', { project: 'demo', apply: true, max_insert: 1, cursor: 0, limit: 5 }));
  assert.equal('warning' in capped, capped.capped);
  const fresh = await httpWorld(t);
  await similar(fresh);
  const cappedFresh = ok(await fresh.call('POST', '/conflicts/scan', { project: 'demo', apply: true, max_insert: 1 }));
  assert.equal(cappedFresh.capped, true);
  assert.equal(cappedFresh.warning, 'cap reached: this page has no continuation; rerun from the same cursor with a higher applicable cap');
  assert.equal('next_cursor' in cappedFresh, false);
  assert.equal(ok(await w.call('POST', '/conflicts/scan', { all_projects: true })).project, '');
});

test('el escaneo valida su cuerpo antes de trabajar', async (t) => {
  const w = await httpWorld(t);
  await similar(w);
  const bad = async (body, error, status = 400) => {
    const r = await w.call('POST', '/conflicts/scan', body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.json.error, error, JSON.stringify(body));
  };
  await bad({ project: 'demo', all_projects: true }, 'project and all_projects cannot be used together');
  await bad({ project: 'demo', limit: 0 }, 'limit must be between 1 and 100');
  await bad({ project: 'demo', limit: 101 }, 'limit must be between 1 and 100');
  await bad({ project: 'demo', cursor: -1 }, 'cursor must be non-negative');
  await bad({ project: 'demo', since: 'ayer' }, 'invalid since: must be RFC3339');
  await bad({ project: 'demo', semantic: true, concurrency: 0 }, 'concurrency must be between 1 and 20; got 0');
  await bad({ project: 'demo', semantic: true, concurrency: 21 }, 'concurrency must be between 1 and 20; got 21');
  await bad({ project: 'demo', semantic: true, timeout_per_call_seconds: 0 }, 'timeout_per_call_seconds must be between 1 and 600; got 0');
  await bad({ project: 'demo', semantic: true, timeout_per_call_seconds: 601 }, 'timeout_per_call_seconds must be between 1 and 600; got 601');
  await bad({ project: 'demo', concurrency: 0 }, undefined, 200); // sin semantic, los parámetros semánticos se ignoran
  await bad('no json', "invalid json: invalid character 'o' in literal null (expecting 'u')");
  assert.equal((await w.call('POST', '/conflicts/scan', { project: 'nada' })).json.code, 'unknown_project');
});

test('el escaneo semántico usa el ejecutor configurado', async (t) => {
  const prompts = [];
  const llm = {
    runnerFactory: (name) => {
      if (name !== 'copilot') throw new Error(`runner desconocido ${name}`);
      return { compare: async (prompt) => { prompts.push(prompt); return { relation: 'related', confidence: 0.8, reasoning: 'x', model: 'm' }; } };
    },
    buildPrompt: (a, b) => `${a.sync_id}|${b.sync_id}`,
  };
  const w = await httpWorld(t, { env: { ODIN_AGENT_CLI: 'copilot' }, serverOptions: { llm } });
  await similar(w);
  const result = ok(await w.call('POST', '/conflicts/scan', { project: 'demo', semantic: true, concurrency: 2, max_semantic: 3 }));
  assert.ok(result.semantic_judged > 0);
  assert.equal(result.semantic_judged, prompts.length);
  assert.ok(prompts.length <= 3);

  const other = await httpWorld(t, { env: { ODIN_AGENT_CLI: 'otro' }, serverOptions: { llm } });
  await similar(other);
  const failed = await other.call('POST', '/conflicts/scan', { project: 'demo', semantic: true });
  assert.equal(failed.status, 500);
  assert.equal(failed.json.error, 'failed to resolve agent runner: runner desconocido otro');

  const bare = await httpWorld(t, { serverOptions: { llm: undefined } });
  await similar(bare);
  const missing = await bare.call('POST', '/conflicts/scan', { project: 'demo', semantic: true });
  assert.deepEqual([missing.status, missing.json.error], [500, 'ODIN_AGENT_CLI not set: server runnerFactory is not configured']);

  const noPrompt = await httpWorld(t, { env: { ODIN_AGENT_CLI: 'copilot' }, serverOptions: { llm: { runnerFactory: llm.runnerFactory } } });
  await similar(noPrompt);
  ok(await noPrompt.call('POST', '/conflicts/scan', { project: 'demo', semantic: true }));
});

test('estadísticas y cola de diferidos', async (t) => {
  const w = await httpWorld(t);
  await similar(w);
  ok(await w.call('POST', '/conflicts/scan', { project: 'demo', apply: true }));
  w.store.db.run(`INSERT INTO sync_apply_deferred (sync_id, entity, payload, entity_key, op, project, scope_class, apply_status, first_seen_at) VALUES
    ('d1', 'relation', '{"a":1}', 'rel-1', 'upsert', 'demo', 'scoped', 'deferred', '2026-03-01 10:00:00'),
    ('d2', 'observation', 'roto', 'obs-1', 'upsert', 'demo', 'scoped', 'dead', '2026-03-02 10:00:00'),
    ('d3', 'session', 'null', 'ses-1', 'upsert', 'demo', 'scoped', 'dead', '2026-03-03 10:00:00')`);
  const stats = ok(await w.call('GET', '/conflicts/stats?project=demo'));
  assert.deepEqual(Object.keys(stats), ['project', 'by_relation', 'by_judgment_status', 'deferred', 'dead']);
  assert.equal(stats.project, 'demo');
  assert.equal(stats.by_judgment_status.pending, stats.by_relation.pending);
  assert.deepEqual([stats.deferred, stats.dead], [1, 2]);
  assert.equal((await w.call('GET', '/conflicts/stats?project=nada')).json.code, 'unknown_project');

  const all = ok(await w.call('GET', '/conflicts/deferred'));
  assert.equal(all.total, 3);
  assert.equal(all.limit, 50);
  assert.deepEqual(all.rows.map((r) => r.sync_id), ['d1', 'd2', 'd3']);
  assert.deepEqual(all.rows[0].payload, { a: 1 });
  assert.equal(all.rows[1].payload_valid, false);
  assert.equal(all.rows[2].payload_valid, true);
  const dead = ok(await w.call('GET', '/conflicts/deferred?status=dead&limit=1&offset=1'));
  assert.deepEqual([dead.total, dead.limit, dead.rows.map((r) => r.sync_id)], [2, 1, ['d3']]);
  assert.equal(ok(await w.call('GET', '/conflicts/deferred?limit=99999')).limit, 500);
  assert.equal(ok(await w.call('GET', '/conflicts/deferred?limit=0')).limit, 50);
  assert.equal((await w.call('GET', '/conflicts/stats')).status, 200);
});

test('GET /compatibility describe el almacén activo y exige el token cuando existe', async (t) => {
  const w = await httpWorld(t);
  const r = await w.call('GET', '/compatibility');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(r.json, {
    revision: 1, source: 'active', status: 'ready', offline_automatic_opening_authorized: false, active_reuse_authorized: true, instance_id: w.store.instanceId,
    runtime_id: w.store.runtimeId, capability: 'startup-verified-store-v1',
  });
  const secured = await httpWorld(t, { env: { ODIN_HTTP_TOKEN: 's' } });
  assert.equal((await secured.call('GET', '/compatibility')).status, 401);
  assert.equal((await secured.call('GET', '/compatibility', undefined, { Authorization: 'Bearer s' })).status, 200);
});
