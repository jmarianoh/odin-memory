import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutosyncManager, PHASE, classifyTransportError, DEFAULT_CONFIG } from '../../../src/cloud/autosync.js';
import { HttpStatusError } from '../../../src/cloud/remote.js';
import { addObservation, createSession, enrollProject, getSyncState, saveRelation, judgeRelation, applyCloudMutation } from '../../../src/store/index.js';
import { openTempStore } from '../store/helpers.js';

const http = (statusCode, extra = {}) => new HttpStatusError({ operation: 'push', statusCode, ...extra });

/** Transporte en memoria: guarda lo empujado y sirve lo que se le indique. */
function fakeTransport({ push, pull } = {}) {
  const calls = { push: [], pull: [] };
  return {
    calls,
    pushMutations: async (entries) => {
      calls.push.push(entries);
      if (push) return push(entries, calls.push.length);
      return entries.map((_, i) => i + 1);
    },
    pullMutations: async (since, limit) => {
      calls.pull.push([since, limit]);
      if (pull) return pull(since, limit, calls.pull.length);
      return { mutations: [], has_more: false, latest_seq: 0 };
    },
  };
}

function setup(t, transport, config = {}) {
  const store = openTempStore(t);
  enrollProject(store, 'demo');
  createSession(store, 's1', 'demo', '/tmp/x');
  addObservation(store, { session_id: 's1', type: 'note', title: 'Una', content: 'contenido', project: 'demo' });
  let clock = 1_800_000_000_000;
  const manager = new AutosyncManager(store, transport, { log: () => {}, random: () => 0.5, now: () => clock, ...config });
  return { store, manager, advance: (ms) => { clock += ms; } };
}

test('un ciclo empuja el diario por proyecto, acusa recibo y deja el destino sano', async (t) => {
  const transport = fakeTransport();
  const { store, manager } = setup(t, transport);
  await manager.runOnce();
  assert.equal(transport.calls.push.length, 1, 'un lote por proyecto');
  assert.deepEqual(transport.calls.push[0].map((e) => [e.project, e.entity, e.op]), [['demo', 'session', 'upsert'], ['demo', 'observation', 'upsert']]);
  assert.equal(typeof transport.calls.push[0][0].payload, 'string');
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE acked_at IS NULL").n, 0);
  const status = manager.status();
  assert.deepEqual([status.phase, status.lastError, status.consecutiveFailures, status.reasonCode], [PHASE.healthy, '', 0, '']);
  assert.ok(status.lastSyncAt instanceof Date);
  assert.equal(getSyncState(store, 'cloud').lifecycle, 'healthy');
  assert.equal(getSyncState(store, 'cloud:demo').lifecycle, 'healthy', 'también el del proyecto');
  assert.equal(store.db.get("SELECT lease_owner FROM sync_state WHERE target_key = 'cloud'").lease_owner, manager.leaseOwner);
  await manager.runOnce();
  assert.equal(transport.calls.push.length, 1, 'sin pendientes no hay nada que empujar');
});

test('un lote con menos aceptadas de las enviadas no se acusa', async (t) => {
  const { store, manager } = setup(t, fakeTransport({ push: () => [1] }));
  await manager.runOnce();
  assert.match(manager.status().lastError, /cloud accepted 1 of 2 mutations; refusing to ack local seqs/);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE acked_at IS NULL").n, 2);
  const none = setup(t, fakeTransport({ push: () => undefined }));
  await none.manager.runOnce();
  assert.match(none.manager.status().lastError, /missing accepted seqs for 2 mutations/);
});

test('un fallo del transporte entra en espera creciente y se reintenta al vencer', async (t) => {
  let fail = true;
  const transport = fakeTransport({ push: (entries) => { if (fail) throw new Error('connection refused'); return entries.map((_, i) => i + 1); } });
  const { store, manager, advance } = setup(t, transport, { baseBackoff: 1000, maxBackoff: 8000 });
  await manager.runOnce();
  let status = manager.status();
  assert.equal(status.phase, PHASE.pushFailed);
  assert.equal(status.reasonCode, 'transport_failed');
  assert.match(status.lastError, /^push: transport push project "demo": connection refused$/);
  assert.equal(status.consecutiveFailures, 1);
  assert.equal(status.backoffUntil.getTime() - 1_800_000_000_000, 1000, 'sin variación con random = 0,5');
  const state = getSyncState(store, 'cloud');
  assert.deepEqual([state.lifecycle, state.reason_code, state.consecutive_failures], ['degraded', 'transport_failed', 1]);

  await manager.runOnce();
  assert.equal(transport.calls.push.length, 1, 'dentro de la espera no se intenta');
  advance(1001);
  await manager.runOnce();
  assert.equal(manager.status().consecutiveFailures, 2);
  assert.equal(manager.status().backoffUntil.getTime() - 1_800_000_000_000 - 1001, 2000, 'duplica');
  fail = false;
  advance(2001);
  await manager.runOnce();
  status = manager.status();
  assert.deepEqual([status.phase, status.consecutiveFailures, status.lastError, status.backoffUntil], [PHASE.healthy, 0, '', null]);
});

test('401 y 403 dejan su motivo; el 403 añade la guía del proyecto', async (t) => {
  for (const [code, reason, guidance] of [[401, 'auth_required', null], [403, 'policy_forbidden', /Cloud sync is blocked by server policy\.\nThe server denied access to project "demo"/]]) {
    const { store, manager } = setup(t, fakeTransport({ push: () => { throw http(code); } }));
    await manager.runOnce();
    assert.equal(manager.status().reasonCode, reason);
    assert.equal(getSyncState(store, 'cloud').reason_code, reason);
    if (guidance) assert.match(manager.status().lastError, guidance);
  }
  assert.equal(classifyTransportError(new Error('x')), 'transport_failed');
  assert.equal(classifyTransportError(null), 'transport_failed');
  assert.equal(classifyTransportError(new Error('x', { cause: http(401) })), 'auth_required');
});

test('el tope de fallos mantiene la espera hasta que vence', async (t) => {
  const { manager, advance } = setup(t, fakeTransport({ push: () => { throw new Error('caído'); } }), { baseBackoff: 1000, maxBackoff: 1000, maxConsecutiveFailures: 2 });
  await manager.runOnce();
  advance(1001);
  await manager.runOnce();
  assert.equal(manager.status().consecutiveFailures, 2);
  await manager.runOnce();
  assert.equal(manager.status().phase, PHASE.backoff, 'en el tope, dentro de la espera, queda en espera');
  assert.equal(manager.status().consecutiveFailures, 2);
});

test('el arriendo de otro trabajador impide sincronizar y se libera al parar', async (t) => {
  const transport = fakeTransport();
  const { store, manager } = setup(t, transport);
  store.db.run("INSERT OR IGNORE INTO sync_state (target_key, lifecycle) VALUES ('cloud', 'idle')");
  store.db.run("UPDATE sync_state SET lease_owner = 'otro', lease_until = ? WHERE target_key = 'cloud'", new Date(1_800_000_000_000 + 60_000).toISOString());
  await manager.runOnce();
  assert.equal(transport.calls.push.length, 0);
  store.db.run("UPDATE sync_state SET lease_until = ? WHERE target_key = 'cloud'", new Date(1_800_000_000_000 - 1000).toISOString());
  manager.start();
  await manager.runOnce();
  assert.equal(transport.calls.push.length, 1, 'un arriendo vencido se toma');
  await manager.stop();
  assert.equal(store.db.get("SELECT lease_owner FROM sync_state WHERE target_key = 'cloud'").lease_owner, null);
  await manager.stop();
});

test('la lectura aplica las mutaciones remotas, avanza el cursor y sigue por páginas', async (t) => {
  const page = (seq) => ({
    seq, project: 'demo', entity: 'session', entity_key: `r${seq}`, op: 'upsert', occurred_at: '2026-01-01T00:00:00Z',
    payload: { id: `r${seq}`, project: 'demo', directory: '/r', started_at: '2026-01-01 00:00:00' },
  });
  const transport = fakeTransport({
    pull: (since, limit, call) => (call === 1 ? { mutations: [page(1), page(2)], has_more: true, latest_seq: 2 } : { mutations: [page(3)], has_more: false, latest_seq: 3 }),
  });
  const { store, manager } = setup(t, transport, { pullBatchSize: 2 });
  await manager.runOnce();
  assert.deepEqual(transport.calls.pull, [[0, 2], [2, 2]]);
  assert.deepEqual(store.db.all("SELECT id FROM sessions WHERE id LIKE 'r%' ORDER BY id").map((r) => r.id), ['r1', 'r2', 'r3']);
  assert.equal(getSyncState(store, 'cloud').last_pulled_seq, 3);
  await manager.runOnce();
  assert.deepEqual(transport.calls.pull.at(-1), [3, 2], 'el siguiente ciclo parte del cursor');
});

test('una mutación remota que no se puede aplicar detiene la lectura sin mover el cursor', async (t) => {
  const bad = { seq: 1, project: 'demo', entity: 'cosa', entity_key: 'x', op: 'upsert', payload: {}, occurred_at: '' };
  const { store, manager } = setup(t, fakeTransport({ pull: () => ({ mutations: [bad], has_more: false, latest_seq: 1 }) }));
  await manager.runOnce();
  assert.match(manager.status().lastError, /^pull: apply pulled mutation seq=1: unknown sync entity "cosa"$/);
  assert.equal(manager.status().phase, PHASE.pullFailed);
  assert.equal(getSyncState(store, 'cloud').last_pulled_seq, 0);
  const failed = setup(t, fakeTransport({ pull: () => { throw new Error('sin red'); } }));
  await failed.manager.runOnce();
  assert.match(failed.manager.status().lastError, /^pull: transport pull: sin red$/);
});

test('un pendiente de un proyecto sin inscribir bloquea la salida, pero se sigue leyendo', async (t) => {
  const transport = fakeTransport();
  const { store, manager } = setup(t, transport);
  store.db.run("UPDATE sync_mutations SET acked_at = datetime('now')");
  store.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project) VALUES ('cloud', 'session', 'z', 'upsert', '{}', 'local', 'zeta')");
  await manager.runOnce();
  assert.equal(transport.calls.push.length, 0);
  assert.equal(transport.calls.pull.length, 1, 'la lectura continúa');
  const state = getSyncState(store, 'cloud');
  assert.deepEqual([state.lifecycle, state.reason_code], ['degraded', 'non_enrolled_pending_mutations']);
  assert.match(state.last_error, /pending cloud sync mutations are blocked because project\(s\) are not enrolled: zeta=1\. Run `odin cloud enroll <project>`/);
  assert.ok(state.last_success_at, 'la lectura exitosa queda anotada');
  const status = manager.status();
  assert.deepEqual([status.phase, status.reasonCode, status.consecutiveFailures], [PHASE.pushFailed, 'non_enrolled_pending_mutations', 0]);

  const failing = setup(t, fakeTransport({ pull: () => { throw new Error('sin red'); } }));
  failing.store.db.run("UPDATE sync_mutations SET acked_at = datetime('now')");
  failing.store.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project) VALUES ('cloud', 'session', 'z', 'upsert', '{}', 'local', 'zeta')");
  await failing.manager.runOnce();
  assert.match(failing.manager.status().lastError, /^pull: transport pull: sin red$/);
});

test('las mutaciones con proyecto vacío o con identidad de prompt inválida no salen y el resto sí', async (t) => {
  const transport = fakeTransport();
  const { store, manager } = setup(t, transport);
  store.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project) VALUES ('cloud', 'prompt', 'p1', 'upsert', '{\"sync_id\":\"otro\",\"session_id\":\"s1\",\"project\":\"demo\"}', 'local', 'demo')");
  store.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project) VALUES ('cloud', 'prompt', 'p2', 'upsert', '{\"sync_id\":\"p2\",\"session_id\":\"s1\",\"project\":\"demo\",\"source_inbox_id\":\"inbox\"}', 'local', 'demo')");
  store.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project) VALUES ('cloud', 'prompt', 'p3', 'upsert', 'no json', 'local', 'demo')");
  store.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project) VALUES ('cloud', 'prompt', 'p4', 'upsert', '{\"sync_id\":\"p4\",\"session_id\":\"s1\",\"project\":\"demo\",\"content\":\"c\"}', 'local', 'demo')");
  store.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project) VALUES ('cloud', 'session', 'sinproyecto', 'upsert', '{}', 'local', '')");
  await manager.runOnce();
  const sent = transport.calls.push.flat().map((e) => e.entity_key);
  assert.equal(sent.length, 3, 'la sesión, la observación y el prompt válido');
  assert.ok(sent.includes('p4'));
  for (const rejected of ['p1', 'p2', 'p3', 'sinproyecto']) assert.ok(!sent.includes(rejected), rejected);
  const error = manager.status().lastError;
  assert.match(error, /prompt seq \d+: invalid journal identity/);
  assert.match(error, /prompt seq \d+: local prompt provenance unavailable/);
  assert.match(error, /prompt seq \d+: invalid identity: /);
  assert.match(error, /has an empty or padded project and was not sent/);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE entity_key = 'p4' AND acked_at IS NOT NULL").n, 1, 'lo válido sí se acusa');
});

test('un fallo en un proyecto no impide empujar los demás', async (t) => {
  const transport = fakeTransport({ push: (entries) => { if (entries[0].project === 'demo') throw http(403); return entries.map((_, i) => i + 1); } });
  const { store, manager } = setup(t, transport);
  enrollProject(store, 'otro');
  createSession(store, 's2', 'otro', '/tmp/o');
  await manager.runOnce();
  assert.deepEqual(transport.calls.push.map((c) => c[0].project), ['demo', 'otro']);
  assert.equal(manager.status().reasonCode, 'policy_forbidden');
  assert.match(manager.status().lastError, /The server denied access to project "demo"/);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE project = 'otro' AND acked_at IS NOT NULL").n, 1);
});

test('el empuje se divide en páginas y respeta el tope de la fotografía inicial', async (t) => {
  const transport = fakeTransport();
  const { store, manager } = setup(t, transport, { pushBatchSize: 1 });
  addObservation(store, { session_id: 's1', type: 'note', title: 'Dos', content: 'otro', project: 'demo' });
  await manager.runOnce();
  assert.equal(transport.calls.push.length, 3, 'una página por mutación');
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE acked_at IS NULL").n, 0);
});

test('parar para una migración deja el estado pausado hasta reanudar', async (t) => {
  const transport = fakeTransport();
  const { manager } = setup(t, transport);
  assert.throws(() => manager.stopForUpgrade(' '), /autosync stop requires project/);
  assert.throws(() => manager.resumeAfterUpgrade(''), /autosync resume requires project/);
  manager.resumeAfterUpgrade('demo');
  manager.stopForUpgrade('Demo');
  assert.deepEqual([manager.status().phase, manager.status().reasonCode], [PHASE.disabled, 'paused']);
  assert.match(manager.status().reasonMessage, /autosync paused for cloud upgrade rollback on project "demo"/);
  await manager.runOnce();
  assert.equal(transport.calls.push.length, 0);
  manager.resumeAfterUpgrade('demo');
  assert.equal(manager.status().phase, PHASE.idle);
  await manager.runOnce();
  assert.equal(transport.calls.push.length, 1);
});

test('la espera crece al doble, se acota y varía un 25 %', (t) => {
  const store = openTempStore(t);
  const make = (random) => new AutosyncManager(store, fakeTransport(), { baseBackoff: 1000, maxBackoff: 10_000, random, log: () => {} });
  const mid = make(() => 0.5);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => mid.computeBackoff(n)), [1000, 1000, 2000, 4000, 8000, 10_000, 10_000]);
  assert.equal(make(() => 0).computeBackoff(1), 750);
  assert.equal(make(() => 0.999999).computeBackoff(1), 1250);
  assert.equal(make(() => 0.999999).computeBackoff(5), 10_000, 'nunca pasa del tope');
  assert.equal(make(() => 0).computeBackoff(2), 1500);
  const defaults = new AutosyncManager(store, fakeTransport(), { log: () => {}, pushBatchSize: 0, pollInterval: -5 });
  assert.deepEqual([defaults.cfg.pushBatchSize, defaults.cfg.pollInterval, defaults.cfg.targetKey], [DEFAULT_CONFIG.pushBatchSize, DEFAULT_CONFIG.pollInterval, 'cloud']);
});

test('start programa ciclos periódicos y notifyDirty los adelanta', async (t) => {
  const transport = fakeTransport();
  const { manager } = setup(t, transport, { pollInterval: 20, debounce: 5 });
  manager.notifyDirty();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(transport.calls.pull.length, 0, 'parado no hace nada');
  manager.start();
  manager.start();
  manager.notifyDirty();
  manager.notifyDirty();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(transport.calls.pull.length >= 1, 'el aviso lanzó un ciclo');
  const before = transport.calls.pull.length;
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.ok(transport.calls.pull.length > before, 'el sondeo periódico sigue');
  await manager.stop();
});

test('un error inesperado en el ciclo no tumba el proceso', async (t) => {
  let calls = 0;
  const random = () => {
    if (calls++ === 0) throw new TypeError('inesperado');
    return 0.5;
  };
  const { manager } = setup(t, fakeTransport({ push: () => { throw new Error('caído'); } }), { random });
  await manager.runOnce();
  const status = manager.status();
  assert.deepEqual([status.phase, status.reasonCode, status.lastError === 'push: transport push project "demo": caído'], [PHASE.backoff, 'internal_error', true]);
  assert.ok(status.consecutiveFailures >= 1);
  assert.ok(status.backoffUntil > new Date(1_800_000_000_000));
  const hopeless = setup(t, fakeTransport({ push: () => { throw new Error('caído'); } }), { random: () => { throw new TypeError('siempre'); } });
  await hopeless.manager.runOnce();
  assert.equal(hopeless.manager.status().phase, PHASE.backoff);
});

test('lo que se anota durante el empuje espera al ciclo siguiente', async (t) => {
  let store;
  const transport = fakeTransport({
    push: (entries, call) => {
      if (call === 1) addObservation(store, { session_id: 's1', type: 'note', title: 'Tardía', content: 'llegó durante el empuje', project: 'demo' });
      return entries.map((_, i) => i + 1);
    },
  });
  const ctx = setup(t, transport, { pushBatchSize: 2 });
  store = ctx.store;
  addObservation(store, { session_id: 's1', type: 'note', title: 'Otra', content: 'segunda', project: 'demo' });
  await ctx.manager.runOnce();
  assert.deepEqual(transport.calls.push.map((c) => c.length), [2, 1], 'las tres que había al empezar, en dos páginas');
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE acked_at IS NULL").n, 1, 'la tardía queda pendiente');
  await ctx.manager.runOnce();
  assert.equal(transport.calls.push.length, 3);
});

test('las relaciones diferidas se reintentan en el ciclo siguiente aunque no llegue nada', async (t) => {
  const transport = fakeTransport();
  const { store, manager } = setup(t, transport);
  const relation = { sync_id: 'rel-d', source_id: 'obs-uno', target_id: 'obs-dos', relation: 'related', judgment_status: 'judged', marked_by_actor: 'a', marked_by_kind: 'human', project: 'demo' };
  applyCloudMutation(store, 'cloud', { seq: 1, project: 'demo', entity: 'relation', entity_key: 'rel-d', op: 'upsert', payload: JSON.stringify(relation), occurred_at: '' });
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM memory_relations WHERE sync_id = 'rel-d'").n, 0);
  store.db.run("UPDATE observations SET sync_id = 'obs-uno' WHERE title = 'Una'");
  addObservation(store, { session_id: 's1', type: 'note', title: 'Dos', content: 'otro', project: 'demo' });
  store.db.run("UPDATE observations SET sync_id = 'obs-dos' WHERE title = 'Dos'");
  await manager.runOnce();
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM memory_relations WHERE sync_id = 'rel-d'").n, 1, 'se reaplicó sin mutaciones nuevas');
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_apply_deferred WHERE apply_status = 'deferred'").n, 0);
});

test('parar detiene el sondeo y los avisos agrupados lanzan un solo ciclo', async (t) => {
  const transport = fakeTransport();
  const { manager } = setup(t, transport, { pollInterval: 15, debounce: 5 });
  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await manager.stop();
  const stopped = transport.calls.pull.length;
  assert.ok(stopped >= 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(transport.calls.pull.length, stopped, 'sin sondeo tras parar');

  const quiet = fakeTransport();
  const grouped = setup(t, quiet, { pollInterval: 3_600_000, debounce: 10 });
  grouped.manager.start();
  for (let i = 0; i < 4; i++) grouped.manager.notifyDirty();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(quiet.calls.pull.length, 1, 'cuatro avisos seguidos, un ciclo');
  await grouped.manager.stop();
});

test('dos ciclos pedidos a la vez comparten ejecución', async (t) => {
  const transport = fakeTransport();
  const { manager } = setup(t, transport);
  await Promise.all([manager.runOnce(), manager.runOnce(), manager.runOnce()]);
  assert.equal(transport.calls.push.length, 1);
  assert.equal(transport.calls.pull.length, 1);
});

test('una mutación de prompt sin sesión o de otro proyecto no se envía', async (t) => {
  const transport = fakeTransport();
  const { store, manager } = setup(t, transport);
  const add = (key, payload) => store.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project) VALUES ('cloud', 'prompt', ?, 'upsert', ?, 'local', 'demo')", key, JSON.stringify(payload));
  add('a', { sync_id: 'a', session_id: '', project: 'demo' });
  add('b', { sync_id: 'b', session_id: 's1', project: 'otro' });
  add('c', { sync_id: 'c', session_id: 's1', project: null });
  await manager.runOnce();
  const sent = transport.calls.push.flat().map((e) => e.entity_key);
  for (const key of ['a', 'b', 'c']) assert.ok(!sent.includes(key), key);
  assert.equal((manager.status().lastError.match(/invalid journal identity/g) ?? []).length, 3);
});

test('reanudar sin haber parado no cambia nada, y una pausa durante un ciclo manda sobre su resultado', async (t) => {
  const transport = fakeTransport();
  const { manager } = setup(t, transport);
  await manager.runOnce();
  manager.resumeAfterUpgrade('demo');
  assert.equal(manager.status().phase, PHASE.healthy, 'no estaba parado: sigue sano');

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = fakeTransport({ pull: async () => { await gate; return { mutations: [], has_more: false, latest_seq: 0 }; } });
  const other = setup(t, slow);
  const cycle = other.manager.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  other.manager.stopForUpgrade('demo');
  release();
  await cycle;
  assert.equal(other.manager.status().phase, PHASE.disabled, 'el resultado del ciclo no pisa la pausa');
  assert.equal(other.manager.status().reasonCode, 'paused');
});

test('un ciclo correcto limpia en el almacén un fallo anterior aunque no haya nada que mover', async (t) => {
  let down = true;
  const transport = fakeTransport({ pull: () => { if (down) throw new Error('sin red'); return { mutations: [], has_more: false, latest_seq: 0 }; } });
  const { store, manager, advance } = setup(t, transport, { baseBackoff: 10 });
  store.db.run("UPDATE sync_mutations SET acked_at = datetime('now')");
  await manager.runOnce();
  assert.equal(getSyncState(store, 'cloud').lifecycle, 'degraded');
  down = false;
  advance(60_000);
  store.db.run("UPDATE sync_state SET backoff_until = NULL WHERE target_key = 'cloud'");
  await manager.runOnce();
  const state = getSyncState(store, 'cloud');
  assert.deepEqual([state.lifecycle, state.consecutive_failures, state.last_error, state.reason_code], ['healthy', 0, null, null]);
});
