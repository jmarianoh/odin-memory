import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { collectSessionIds, ChunkConflictError, ChunkNotFoundInCloud, CloudServer, CloudStore, Database, ProjectAllowlist } from '../../../src/cloud/server/index.js';
import { startPostgres } from './pg-helper.js';

let pg;
before(async () => {
  pg = await startPostgres();
});
after(async () => {
  await pg?.stop();
});

async function start(options = {}) {
  const store = new CloudStore(Database.connect(await pg.createDatabase()));
  await store.migrate();
  const server = new CloudServer(store, { allowedProjects: ['proj-a', 'proj-b'], port: 0, log: () => {}, ...options });
  const { port } = await server.listen();
  return { store, server, port, url: `http://127.0.0.1:${port}`, close: async () => { await server.close(); await store.close(); } };
}

async function call(base, method, path, { headers = {}, body, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${base}${path}`, init);
  const buf = Buffer.from(await response.arrayBuffer());
  const text = buf.toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json, buf, headers: response.headers };
}

const chunk = (project = 'proj-a') => ({
  sessions: [{ id: 's1', project, directory: '/tmp/x' }],
  observations: [{ sync_id: 'obs-1', session_id: 's1', type: 'decision', title: 't', content: 'c', scope: 'project' }],
  prompts: [],
});
const push = (base, data, extra = {}, headers = {}) => call(base, 'POST', '/sync/push', { headers, body: { created_by: 'ana', client_created_at: '2026-01-02T03:04:05Z', project: 'proj-a', data, ...extra } });

test('con token, solo se atiende a quien lo presenta', async (t) => {
  const s = await start({ token: 'tok', adminToken: 'adm' });
  t.after(s.close);
  assert.equal((await call(s.url, 'GET', '/health')).status, 200, '/health no pide autenticación');
  const denied = await call(s.url, 'GET', '/sync/pull?project=proj-a');
  assert.deepEqual([denied.status, denied.text], [401, 'unauthorized: missing authorization header\n']);
  assert.equal((await call(s.url, 'GET', '/sync/pull?project=proj-a', { headers: { Authorization: 'Basic x' } })).text, 'unauthorized: authorization must use Bearer token\n');
  assert.equal((await call(s.url, 'GET', '/sync/pull?project=proj-a', { headers: { Authorization: 'Bearer nope' } })).text, 'unauthorized: unknown token\n');
  assert.equal((await call(s.url, 'GET', '/sync/pull?project=proj-a', { headers: { Authorization: 'bearer   tok ' } })).status, 200);
  assert.equal((await call(s.url, 'GET', '/sync/pull?project=proj-a', { headers: { Authorization: 'Bearer adm' } })).status, 200, 'el token de administración también autentica');
  const unauth = await push(s.url, chunk());
  assert.equal(unauth.status, 401);
  assert.equal((await s.store.readManifest('proj-a')).chunks.length, 0, 'una subida sin autenticar no guarda nada');
});

test('sin token no se autentica pero la lista de proyectos sigue mandando', async (t) => {
  const s = await start({ token: '' });
  t.after(s.close);
  assert.equal((await call(s.url, 'GET', '/sync/pull?project=proj-a')).status, 200);
  const denied = await call(s.url, 'GET', '/sync/pull?project=ajeno');
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.json, { error: 'forbidden: project "ajeno" is not allowed', error_class: 'policy', error_code: 'policy_forbidden' });
});

test('la lista permitida admite comodín y compara por nombre canónico', () => {
  assert.equal(new ProjectAllowlist(['*']).allows('lo-que-sea'), true);
  assert.equal(new ProjectAllowlist(['a', '*']).allows('b'), true);
  assert.equal(new ProjectAllowlist([]).allows('a'), false);
  const list = new ProjectAllowlist(['Mi-Repo', ' ']);
  assert.equal(list.allows('MI-REPO'), true);
  assert.equal(list.allows('mi-repo'), true);
  assert.equal(list.allows('otro'), false);
  assert.equal(list.allows('  '), false);
});

test('rutas y métodos', async (t) => {
  const s = await start();
  t.after(s.close);
  const missing = await call(s.url, 'GET', '/nada');
  assert.deepEqual([missing.status, missing.text], [404, '404 page not found\n']);
  const wrong = await call(s.url, 'DELETE', '/sync/pull');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'GET, HEAD');
  assert.equal((await call(s.url, 'GET', '/sync/push')).headers.get('allow'), 'POST');
  assert.deepEqual((await call(s.url, 'GET', '/health')).json, { service: 'odin-cloud', status: 'ok' });
});

test('subir y volver a leer un chunk', async (t) => {
  const s = await start();
  t.after(s.close);
  const first = await push(s.url, chunk());
  assert.equal(first.status, 200);
  assert.equal(first.text, `{"chunk_id":"${first.json.chunk_id}","status":"ok"}\n`);
  assert.deepEqual((await push(s.url, chunk())).json, first.json, 'repetirlo no cambia nada');

  const manifest = (await call(s.url, 'GET', '/sync/pull?project=proj-a')).json;
  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest.chunks.map(({ id, created_by, created_at, sessions, memories, prompts }) => ({ id, created_by, created_at, sessions, memories, prompts })), [
    { id: first.json.chunk_id, created_by: 'ana', created_at: '2026-01-02T03:04:05Z', sessions: 1, memories: 1, prompts: 0 },
  ]);
  assert.deepEqual((await call(s.url, 'GET', '/sync/pull?project=proj-b')).json, { version: 2, chunks: [] }, 'cada proyecto tiene los suyos');

  const plain = await call(s.url, 'GET', `/sync/pull/${first.json.chunk_id}?project=proj-a`);
  assert.equal(plain.headers.get('content-type'), 'application/json');
  assert.equal(plain.headers.get('cache-control'), 'no-store');
  assert.equal(plain.headers.get('vary'), 'Accept');
  assert.equal(plain.json.sessions[0].project, 'proj-a');
  const zipped = await call(s.url, 'GET', `/sync/pull/${first.json.chunk_id}?project=proj-a`, { headers: { Accept: 'application/vnd.odin.sync+gzip; version=1' } });
  assert.equal(zipped.headers.get('content-type'), 'application/vnd.odin.sync+gzip; version=1');
  assert.equal(gunzipSync(zipped.buf).toString('utf8'), plain.text);

  const gone = await call(s.url, 'GET', '/sync/pull/ffffffff?project=proj-a');
  assert.deepEqual([gone.status, gone.text], [404, 'read chunk: cloudstore: chunk not found: "ffffffff"\n']);
  assert.equal((await call(s.url, 'GET', '/sync/pull/ffffffff?project=ajeno')).status, 403);
  assert.equal((await call(s.url, 'GET', '/sync/pull/ffffffff')).json.error_code, 'upgrade_blocked_project_required');
});

test('la subida acepta el proyecto en la consulta, el sobre comprimido y el sniffing de gzip', async (t) => {
  const s = await start();
  t.after(s.close);
  const body = { data: chunk() };
  const viaQuery = await call(s.url, 'POST', '/sync/push?project=proj-a', { body });
  assert.equal(viaQuery.status, 200);
  const zipped = await call(s.url, 'POST', '/sync/push', {
    headers: { 'Content-Type': 'application/vnd.odin.sync+gzip; version=1' }, raw: gzipSync(Buffer.from(JSON.stringify({ project: 'proj-a', data: chunk() }))),
  });
  assert.deepEqual(zipped.json, viaQuery.json);
  const sniffed = await call(s.url, 'POST', '/sync/push', { headers: { 'Content-Type': 'application/octet-stream' }, raw: gzipSync(Buffer.from(JSON.stringify({ project: 'proj-a', data: chunk() }))) });
  assert.equal(sniffed.status, 200, 'un proxy que cambia el tipo no impide decodificar gzip');
  const badVersion = await call(s.url, 'POST', '/sync/push', { headers: { 'Content-Type': 'application/vnd.odin.sync+gzip; version=7' }, raw: 'x' });
  assert.equal(badVersion.status, 415);
  assert.equal(badVersion.json.error_code, 'upgrade_repairable_payload_invalid');
});

test('la subida valida el sobre, las filas y las referencias de sesión', async (t) => {
  const s = await start();
  t.after(s.close);
  const bad = async (status, code, pattern, response) => {
    const r = await response;
    assert.equal(r.status, status, r.text);
    assert.equal(r.json.error_code, code, r.text);
    assert.match(r.json.error, pattern);
  };
  await bad(400, 'upgrade_repairable_payload_invalid', /^invalid push payload: /, call(s.url, 'POST', '/sync/push', { raw: '{' }));
  await bad(400, 'upgrade_repairable_payload_invalid', /^invalid push payload: /, call(s.url, 'POST', '/sync/push', { raw: '[]' }));
  await bad(400, 'upgrade_repairable_payload_invalid', /^invalid push payload: .*chunk_id/, call(s.url, 'POST', '/sync/push', { raw: '{"chunk_id":5}' }));
  await bad(400, 'upgrade_repairable_payload_invalid', /^data is required$/, call(s.url, 'POST', '/sync/push', { body: { project: 'proj-a' } }));
  await bad(400, 'upgrade_blocked_project_required', /^project is required$/, call(s.url, 'POST', '/sync/push', { body: { data: chunk() } }));
  await bad(403, 'policy_forbidden', /^forbidden: project "ajeno" is not allowed$/, push(s.url, chunk(), { project: 'ajeno' }));
  await bad(400, 'upgrade_repairable_payload_invalid', /decode chunk data/, push(s.url, 'texto'));
  await bad(400, 'upgrade_repairable_payload_invalid', /^invalid push payload: sessions\[0\]\.directory is required$/, push(s.url, { sessions: [{ id: 's9' }] }));
  await bad(400, 'upgrade_repairable_payload_invalid', /^invalid push payload: observations\[0\]\.title is required$/, push(s.url, { ...chunk(), observations: [{ sync_id: 'o', session_id: 's1', type: 't', content: 'c', scope: 's' }] }));
  await bad(400, 'upgrade_repairable_payload_invalid', /^invalid push payload: observations\[0\]\.scope is required$/, push(s.url, { ...chunk(), observations: [{ sync_id: 'o', session_id: 's1', type: 't', title: 'x', content: 'c' }] }));
  await bad(400, 'upgrade_repairable_payload_invalid', /^invalid push payload: prompts\[0\]\.content is required$/, push(s.url, { ...chunk(), prompts: [{ sync_id: 'p', session_id: 's1' }] }));
  await bad(400, 'upgrade_repairable_payload_invalid', /^invalid push payload: observations\[0\] references missing session_id "otra"$/, push(s.url, { ...chunk(), observations: [{ ...chunk().observations[0], session_id: 'otra' }] }));
  await bad(400, 'upgrade_repairable_payload_invalid', /^client_created_at must be RFC3339$/, push(s.url, chunk(), { client_created_at: 'ayer' }));
  assert.equal((await s.store.readManifest('proj-a')).chunks.length, 0, 'nada de lo rechazado se guarda');

  assert.equal((await push(s.url, chunk())).status, 200);
  const later = { sessions: [], prompts: [], observations: [{ ...chunk().observations[0], sync_id: 'obs-2' }] };
  assert.equal((await push(s.url, later)).status, 200, 'una sesión que el servidor ya conoce se puede referenciar');
});

test('los límites de tamaño distinguen lo enviado de lo descomprimido', async (t) => {
  const s = await start({ maxPushBodyBytes: 2048 });
  t.after(s.close);
  const big = await push(s.url, { ...chunk(), pad: 'x'.repeat(4000) });
  assert.equal(big.status, 413);
  assert.deepEqual([big.json.error_class, big.json.error_code, big.json.error], ['repairable', 'upgrade_repairable_payload_too_large', 'push payload too large (max 2048 bytes)']);
  const bomb = await call(s.url, 'POST', '/sync/push', {
    headers: { 'Content-Type': 'application/vnd.odin.sync+gzip; version=1' }, raw: gzipSync(Buffer.from(JSON.stringify({ project: 'proj-a', data: { ...chunk(), pad: 'x'.repeat(10_000) } }))),
  });
  assert.equal(bomb.status, 413);
  assert.equal(bomb.json.error, 'decoded push payload too large (max 2048 bytes)');
  assert.equal((await push(s.url, chunk())).status, 200, 'el servidor sigue atendiendo');
});

test('un proyecto en pausa rechaza la subida con 409 y la anota', async (t) => {
  const s = await start();
  t.after(s.close);
  await s.store.setProjectSyncEnabled('proj-a', false, 'ops', 'mantenimiento');
  assert.equal(await s.store.isProjectSyncEnabled('proj-a'), false);
  assert.equal(await s.store.isProjectSyncEnabled('proj-b'), true, 'sin fila, activo');
  const paused = await push(s.url, chunk());
  assert.equal(paused.status, 409);
  assert.deepEqual(paused.json, {
    error: 'sync is paused for project "proj-a"', error_class: 'policy', error_code: 'sync-paused', project: 'proj-a', project_path: '', project_source: 'request_body',
  });
  assert.deepEqual(Object.keys(paused.json), Object.keys(paused.json).slice().sort(), 'las claves salen en orden alfabético');
  await push(s.url, chunk(), { created_by: '' });
  const audit = await s.store.db.query('SELECT contributor, project, action, outcome, reason_code, metadata FROM cloud_sync_audit_log ORDER BY id');
  assert.deepEqual(audit, [
    { contributor: 'ana', project: 'proj-a', action: 'chunk_push', outcome: 'rejected_project_paused', reason_code: 'sync-paused', metadata: null },
    { contributor: 'unknown', project: 'proj-a', action: 'chunk_push', outcome: 'rejected_project_paused', reason_code: 'sync-paused', metadata: null },
  ]);
  assert.equal((await call(s.url, 'GET', '/sync/pull?project=proj-a')).status, 200, 'leer sigue permitido');
  await s.store.setProjectSyncEnabled('proj-a', true);
  assert.equal((await push(s.url, chunk())).status, 200);
  const control = await s.store.db.query("SELECT sync_enabled, paused_reason FROM cloud_project_controls WHERE project = 'proj-a'");
  assert.deepEqual(control, [{ sync_enabled: true, paused_reason: null }]);
});

test('el almacén detecta un chunk con otra carga y resuelve la carrera de dos subidas', async (t) => {
  const s = await start();
  t.after(s.close);
  const payload = '{"sessions":[],"observations":[],"prompts":[]}';
  await s.store.writeChunk('proj-a', 'abcd1234', 'ana', '', payload);
  await s.store.writeChunk('proj-a', 'abcd1234', 'ana', '', '{"prompts":[], "observations":[], "sessions":[]}');
  await assert.rejects(s.store.writeChunk('proj-a', 'abcd1234', 'ana', '', '{"sessions":[{"id":"x"}]}'), (err) => err instanceof ChunkConflictError && /existing chunk "abcd1234" has different payload/.test(err.message));
  await assert.rejects(s.store.readChunk('proj-a', 'no-existe'), ChunkNotFoundInCloud);
  // Dos subidas simultáneas del mismo chunk: una inserta y la otra comprueba que es lo mismo.
  const same = '{"sessions":[{"id":"carrera","directory":"/x"}]}';
  await Promise.all(Array.from({ length: 6 }, () => s.store.writeChunk('proj-a', 'carrera1', 'ana', '2026-01-01T00:00:00Z', same)));
  assert.equal((await s.store.readManifest('proj-a')).chunks.filter((c) => c.id === 'carrera1').length, 1);
  assert.deepEqual([...(await s.store.knownSessionIds('proj-a'))].sort(), ['carrera']);
});

test('el índice de sesiones recoge las filas y las altas por mutación', () => {
  const ids = collectSessionIds({
    sessions: [{ id: 'a' }, { id: ' ' }, {}],
    mutations: [
      { entity: 'session', op: 'upsert', entity_key: 'b', payload: JSON.stringify({ id: 'b' }) },
      { entity: 'session', op: 'upsert', payload: JSON.stringify({ id: 'sin-clave' }) },
      { entity: 'session', op: 'upsert', entity_key: 'c', payload: '{}' },
      { entity: 'session', op: 'delete', entity_key: 'd', payload: JSON.stringify({ id: 'd' }) },
      { entity: 'observation', op: 'upsert', payload: JSON.stringify({ id: 'e' }) },
      { entity: 'session', op: 'upsert', payload: '[' },
    ],
  });
  assert.deepEqual([...ids].sort(), ['a', 'b', 'c']);
});

test('el manifiesto sale por orden de llegada y migrar dos veces es inocuo', async (t) => {
  const s = await start();
  t.after(s.close);
  await s.store.migrate();
  for (const id of ['bbbbbbbb', 'aaaaaaaa', 'cccccccc']) {
    await s.store.writeChunk('proj-a', id, 'ana', '', `{"sessions":[],"tag":"${id}"}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual((await s.store.readManifest('proj-a')).chunks.map((c) => c.id), ['bbbbbbbb', 'aaaaaaaa', 'cccccccc']);
});

test('una subida cuyo identificador ya existe con otra carga responde 409', async (t) => {
  const s = await start();
  t.after(s.close);
  const first = await push(s.url, chunk());
  await s.store.db.query("UPDATE cloud_chunks SET payload = '{\"otra\": \"carga\"}'::jsonb WHERE chunk_id = $1", [first.json.chunk_id]);
  const clash = await push(s.url, chunk());
  assert.equal(clash.status, 409);
  assert.deepEqual([clash.json.error_class, clash.json.error_code], ['repairable', 'upgrade_repairable_chunk_conflict']);
  assert.match(clash.json.error, new RegExp(`^write chunk: existing chunk "${first.json.chunk_id}" has different payload$`));
});

test('repetir un chunk ya guardado vuelve a indexar sus sesiones', async (t) => {
  const s = await start();
  t.after(s.close);
  const payload = '{"sessions":[{"id":"indexada","directory":"/x"}]}';
  await s.store.writeChunk('proj-a', 'abcd1234', 'ana', '', payload);
  await s.store.db.query('DELETE FROM cloud_project_sessions');
  assert.deepEqual([...(await s.store.knownSessionIds('proj-a'))], []);
  await s.store.writeChunk('proj-a', 'abcd1234', 'ana', '', payload);
  assert.deepEqual([...(await s.store.knownSessionIds('proj-a'))], ['indexada']);
});

test('si otra subida inserta el mismo chunk entre la lectura y la escritura, se comprueba que es igual', async (t) => {
  const s = await start();
  t.after(s.close);
  const payload = '{"sessions":[{"id":"carrera","directory":"/x"}]}';
  await s.store.writeChunk('proj-a', 'abcd1234', 'ana', '', payload);
  // La primera lectura no ve la fila: simula haber perdido la carrera contra otra subida.
  const blind = (store) => {
    const real = store.db.query.bind(store.db);
    let hidden = false;
    store.db.query = async (text, params) => {
      if (!hidden && /SELECT payload::text AS payload FROM cloud_chunks/.test(text)) {
        hidden = true;
        return [];
      }
      return real(text, params);
    };
  };
  blind(s.store);
  await s.store.writeChunk('proj-a', 'abcd1234', 'ana', '', '{"sessions": [{"directory": "/x", "id": "carrera"}]}');
  blind(s.store);
  await assert.rejects(s.store.writeChunk('proj-a', 'abcd1234', 'ana', '', '{"sessions":[{"id":"distinta","directory":"/x"}]}'), ChunkConflictError);
  assert.equal((await s.store.readManifest('proj-a')).chunks.length, 1);
});

// ─── Mutaciones ──────────────────────────────────────────────────────────────

const mut = (project, entity, entity_key, op, payload) => ({ project, entity, entity_key, op, payload });
const sess = (id) => JSON.stringify({ id, directory: '/x', started_at: '2026-01-01 00:00:00' });
const pushMutations = (base, entries, extra = {}, headers = {}) => call(base, 'POST', '/sync/mutations/push', { headers, body: { entries, ...extra } });

test('el empuje de mutaciones valida el lote antes de guardar nada', async (t) => {
  const s = await start();
  t.after(s.close);
  const err = async (status, pattern, response) => {
    const r = await response;
    assert.equal(r.status, status, r.text);
    assert.match(r.text, pattern);
    return r;
  };
  await err(400, /^invalid request body: /, call(s.url, 'POST', '/sync/mutations/push', { raw: '{' }));
  await err(400, /^invalid request body: /, call(s.url, 'POST', '/sync/mutations/push', { raw: '[]' }));
  await err(400, /^invalid request body: /, call(s.url, 'POST', '/sync/mutations/push', { raw: '{"entries":5}' }));
  await err(400, /^invalid request body: /, call(s.url, 'POST', '/sync/mutations/push', { raw: '{"entries":[{"project":5}]}' }));
  await err(400, /^invalid request body: /, call(s.url, 'POST', '/sync/mutations/push', { raw: '{"created_by":5}' }));
  await err(400, /^batch too large: max 100 entries per request\n$/, pushMutations(s.url, Array.from({ length: 101 }, (_, i) => mut('proj-a', 'prompt', `p${i}`, 'delete', '{}'))));
  const empty = await err(400, /empty_batch/, pushMutations(s.url, []));
  assert.deepEqual(empty.json, { error: 'mutation batch must contain at least one entry', error_class: 'repairable', error_code: 'empty_batch' });
  assert.equal((await call(s.url, 'POST', '/sync/mutations/push', { raw: '{}' })).json.error_code, 'empty_batch');
  const noProject = await pushMutations(s.url, [mut('proj-a', 'session', 's', 'upsert', sess('s')), mut('  ', 'session', 's2', 'upsert', sess('s2'))]);
  assert.deepEqual([noProject.status, noProject.json.error_class, noProject.json.error_code], [400, 'invalid_request', 'empty_project']);
  const forbidden = await pushMutations(s.url, [mut('proj-a', 'session', 's', 'upsert', sess('s')), mut('ajeno', 'session', 's2', 'upsert', sess('s2'))]);
  assert.deepEqual([forbidden.status, forbidden.json.error_code], [403, 'policy_forbidden']);
  assert.deepEqual(await s.store.db.query('SELECT 1 FROM cloud_mutations'), [], 'un proyecto no permitido rechaza todo el lote');
});

test('un lote con entradas inválidas las enumera y no guarda ninguna', async (t) => {
  const s = await start();
  t.after(s.close);
  const bad = await pushMutations(s.url, [
    mut('proj-a', 'session', 's', 'upsert', sess('s')),
    mut('proj-a', 'cosa', 'x', 'upsert', '{}'),
    mut('proj-a', 'relation', 'r', 'upsert', { sync_id: 'r' }),
    mut('proj-a', 'prompt', 'p', 'upsert', '[1]'),
  ]);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json, {
    error: 'invalid mutation payload', error_class: 'repairable', error_code: 'upgrade_repairable_payload_invalid', reason_code: 'validation_error',
    invalid: [{ entity: 'cosa', field: 'payload', index: 1 }, { entity: 'relation', field: 'source_id', index: 2 }, { entity: 'prompt', field: 'payload', index: 3 }],
  });
  assert.deepEqual(await s.store.db.query('SELECT 1 FROM cloud_mutations'), []);
});

test('el empuje guarda el diario, deja su chunk y se lee por páginas', async (t) => {
  const s = await start({ token: 'tok' });
  t.after(s.close);
  const auth = { Authorization: 'Bearer tok' };
  const relation = { sync_id: 'rel-1', source_id: 'o1', target_id: 'o2', relation: 'related', judgment_status: 'judged', marked_by_actor: 'ana', marked_by_kind: 'human' };
  const ok = await pushMutations(s.url, [
    mut('Proj-A', 'session', 's1', 'upsert', sess('s1')),
    mut('proj-a', 'observation', 'o1', 'upsert', JSON.stringify({ sync_id: 'o1', session_id: 's1', type: 't', title: 'x', content: 'c', scope: 'project' })),
    mut('proj-a', 'relation', 'rel-1', 'upsert', relation),
    mut('proj-b', 'prompt', 'viejo', 'upsert', '{}'),
  ], {}, auth);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json, { accepted_seqs: ok.json.accepted_seqs, project: 'proj-a', project_path: '', project_source: 'request_body' });
  assert.equal(ok.json.accepted_seqs.length, 4);
  assert.deepEqual(Object.keys(ok.json), ['accepted_seqs', 'project', 'project_path', 'project_source']);

  const chunks = await s.store.db.query('SELECT project_name, created_by, sessions_count, observations_count, prompts_count FROM cloud_chunks ORDER BY project_name');
  assert.deepEqual(chunks, [
    { project_name: 'proj-a', created_by: 'LEGACY_SYNC', sessions_count: 1, observations_count: 1, prompts_count: 0 },
    { project_name: 'proj-b', created_by: 'LEGACY_SYNC', sessions_count: 0, observations_count: 0, prompts_count: 1 },
  ]);
  assert.deepEqual([...(await s.store.knownSessionIds('proj-a'))], ['s1']);
  const stored = await s.store.db.query("SELECT payload FROM cloud_mutations WHERE entity = 'prompt'");
  assert.deepEqual(stored[0].payload, { content: 'viejo', project: 'proj-b', session_id: 'legacy-viejo', sync_id: 'viejo' });

  const page1 = await call(s.url, 'GET', '/sync/mutations/pull?limit=3', { headers: auth });
  assert.equal(page1.status, 200);
  assert.deepEqual([page1.json.mutations.length, page1.json.has_more, page1.json.latest_seq, page1.json.project], [3, true, ok.json.accepted_seqs[2], 'proj-a']);
  assert.deepEqual(Object.keys(page1.json.mutations[0]), ['seq', 'project', 'entity', 'entity_key', 'op', 'payload', 'occurred_at']);
  const page2 = await call(s.url, 'GET', `/sync/mutations/pull?since_seq=${page1.json.latest_seq}&limit=3`, { headers: auth });
  assert.deepEqual([page2.json.mutations.length, page2.json.has_more, page2.json.latest_seq], [1, false, ok.json.accepted_seqs[3]]);
  const beyond = await call(s.url, 'GET', '/sync/mutations/pull?since_seq=99999', { headers: auth });
  assert.deepEqual([beyond.json.mutations, beyond.json.has_more, beyond.json.latest_seq], [[], false, 0]);
  assert.equal((await call(s.url, 'GET', '/sync/mutations/pull?limit=900', { headers: auth })).json.mutations.length, 4, 'el tope es 100');
  assert.equal((await call(s.url, 'GET', '/sync/mutations/pull?limit=-2&since_seq=zz', { headers: auth })).json.mutations.length, 4, 'valores inválidos usan los defectos');
  assert.equal((await call(s.url, 'GET', '/sync/mutations/pull')).status, 401);
  assert.equal((await call(s.url, 'POST', '/sync/mutations/pull')).status, 405);
});

test('sin autenticación las escrituras se anotan como desconocidas y la lectura respeta la lista', async (t) => {
  const s = await start({ token: '', allowedProjects: ['proj-a'] });
  t.after(s.close);
  assert.equal((await pushMutations(s.url, [mut('proj-a', 'session', 's1', 'upsert', sess('s1'))])).status, 200);
  assert.equal((await s.store.db.query('SELECT created_by FROM cloud_chunks'))[0].created_by, 'unknown');
  await s.store.db.query("INSERT INTO cloud_mutations (project, entity, entity_key, op) VALUES ('proj-ajeno', 'prompt', 'p', 'delete')");
  const pull = await call(s.url, 'GET', '/sync/mutations/pull');
  assert.deepEqual(pull.json.mutations.map((m) => m.project), ['proj-a'], 'otro proyecto no se ve');

  const open = await start({ token: '', allowedProjects: ['*'] });
  t.after(open.close);
  await open.store.db.query("INSERT INTO cloud_mutations (project, entity, entity_key, op) VALUES ('cualquiera', 'prompt', 'p', 'delete')");
  const all = await call(open.url, 'GET', '/sync/mutations/pull');
  assert.deepEqual([all.json.mutations.map((m) => m.project), all.json.project], [['cualquiera'], ''], 'con comodín no hay filtro ni proyecto principal');

  const none = await start({ token: '', allowedProjects: [] });
  t.after(none.close);
  await none.store.db.query("INSERT INTO cloud_mutations (project, entity, entity_key, op) VALUES ('x', 'prompt', 'p', 'delete')");
  assert.deepEqual((await call(none.url, 'GET', '/sync/mutations/pull')).json.mutations, []);
});

test('un proyecto en pausa rechaza el lote entero y lo anota con el número de entradas', async (t) => {
  const s = await start();
  t.after(s.close);
  await s.store.setProjectSyncEnabled('proj-b', false);
  const paused = await pushMutations(s.url, [mut('proj-a', 'session', 's', 'upsert', sess('s')), mut('proj-b', 'session', 's2', 'upsert', sess('s2'))], { created_by: 'ana' });
  assert.equal(paused.status, 409);
  assert.deepEqual(paused.json, { error: 'sync is paused for project "proj-b"', error_class: 'policy', error_code: 'sync-paused', project: 'proj-a', project_path: '', project_source: 'request_body' });
  assert.deepEqual(await s.store.db.query('SELECT contributor, project, action, entry_count FROM cloud_sync_audit_log'), [{ contributor: 'ana', project: 'proj-b', action: 'mutation_push', entry_count: 2 }]);
  assert.deepEqual(await s.store.db.query('SELECT 1 FROM cloud_mutations'), []);
});

test('un fallo al insertar una fila revierte el lote y no deja chunks', async (t) => {
  const s = await start();
  t.after(s.close);
  await s.store.db.query("ALTER TABLE cloud_mutations ADD CONSTRAINT sin_rel CHECK (entity <> 'relation')");
  const relation = { sync_id: 'rel-1', source_id: 'o1', target_id: 'o2', relation: 'related', judgment_status: 'judged', marked_by_actor: 'ana', marked_by_kind: 'human' };
  const failed = await pushMutations(s.url, [mut('proj-a', 'session', 's1', 'upsert', sess('s1')), mut('proj-a', 'relation', 'rel-1', 'upsert', relation)]);
  assert.equal(failed.status, 500);
  assert.equal(failed.text, 'insert mutations: batch_index=1 entity="relation" entity_key="rel-1"\n');
  assert.deepEqual(await s.store.db.query('SELECT 1 FROM cloud_mutations'), []);
  assert.deepEqual(await s.store.db.query('SELECT 1 FROM cloud_chunks'), []);
});

test('subir un chunk deja sus mutaciones en el diario y repetirlo no las duplica', async (t) => {
  const s = await start();
  t.after(s.close);
  const data = { ...chunk(), mutations: [{ entity: 'prompt', entity_key: 'p1', op: 'delete', payload: JSON.stringify({ sync_id: 'p1' }) }] };
  assert.equal((await push(s.url, data)).status, 200);
  assert.equal((await push(s.url, data)).status, 200);
  const rows = await s.store.db.query('SELECT entity, entity_key, op FROM cloud_mutations ORDER BY seq');
  assert.deepEqual(rows, [
    { entity: 'session', entity_key: 's1', op: 'upsert' }, { entity: 'observation', entity_key: 'obs-1', op: 'upsert' }, { entity: 'prompt', entity_key: 'p1', op: 'delete' },
  ]);
  const typed = await push(s.url, { ...chunk(), observations: [{ ...chunk().observations[0], title: 5 }] });
  assert.equal(typed.status, 400);
  assert.match(typed.json.error, /^invalid push payload: chunk schema: json: cannot unmarshal number into Go struct field Observation\.observations\.title of type string$/);
});

test('backfill materializa en chunks las mutaciones del diario que ninguno contiene', async (t) => {
  const s = await start();
  t.after(s.close);
  await pushMutations(s.url, [mut('proj-a', 'session', 's1', 'upsert', sess('s1')), mut('proj-a', 'prompt', 'p1', 'upsert', JSON.stringify({ sync_id: 'p1', session_id: 's1', content: 'hola' }))]);
  await s.store.db.query("INSERT INTO cloud_mutations (project, entity, entity_key, op, payload) VALUES ('proj-a', 'prompt', 'roto', 'upsert', '[1]'), ('proj-a', 'cosa', 'x', 'upsert', '{}')");
  assert.deepEqual(await s.store.backfillMutationChunks('proj-a', true), { project: 'proj-a', applied: true, candidate_mutations: 3, already_materialized: 2, invalid_mutations: 1, chunks_planned: 0, chunks_inserted: 0 });
  await s.store.db.query('DELETE FROM cloud_chunks');
  await s.store.db.query('DELETE FROM cloud_project_sessions');
  const dry = await s.store.backfillMutationChunks('proj-a', false);
  assert.deepEqual(dry, { project: 'proj-a', applied: false, candidate_mutations: 3, already_materialized: 0, invalid_mutations: 1, chunks_planned: 1, chunks_inserted: 0 });
  assert.deepEqual(await s.store.db.query('SELECT 1 FROM cloud_chunks'), [], 'sin apply no escribe');
  const applied = await s.store.backfillMutationChunks('proj-a', true);
  assert.equal(applied.chunks_inserted, 1);
  assert.deepEqual(await s.store.db.query('SELECT created_by, sessions_count, prompts_count FROM cloud_chunks'), [{ created_by: 'mutation-backfill', sessions_count: 1, prompts_count: 1 }]);
  assert.deepEqual([...(await s.store.knownSessionIds('proj-a'))], ['s1']);
  assert.equal((await s.store.backfillMutationChunks('proj-a', true)).chunks_inserted, 0, 'repetir no inserta');
  await assert.rejects(s.store.backfillMutationChunks('  ', true), /project is required/);
  assert.deepEqual(await s.store.backfillMutationChunks('otro', false), { project: 'otro', applied: false, candidate_mutations: 0, already_materialized: 0, invalid_mutations: 0, chunks_planned: 0, chunks_inserted: 0 });
});

test('el empuje de mutaciones respeta el tope de tamaño', async (t) => {
  const s = await start({ maxPushBodyBytes: 512 });
  t.after(s.close);
  const big = await pushMutations(s.url, [mut('proj-a', 'prompt', 'p', 'upsert', JSON.stringify({ sync_id: 'p', session_id: 's', content: 'x'.repeat(2000) }))]);
  assert.equal(big.status, 413);
  assert.deepEqual([big.json.error_code, big.json.error], ['upgrade_repairable_payload_too_large', 'push payload too large (max 512 bytes)']);
});

test('la lectura de mutaciones pagina con los límites exactos', async (t) => {
  const s = await start({ token: 'tok', adminToken: 'adm', allowedProjects: ['proj-b', 'proj-a'] });
  t.after(s.close);
  const auth = { Authorization: 'Bearer tok' };
  await s.store.db.query("INSERT INTO cloud_mutations (project, entity, entity_key, op) SELECT 'proj-a', 'prompt', 'p' || g, 'delete' FROM generate_series(1, 120) g");
  const first = await call(s.url, 'GET', '/sync/mutations/pull', { headers: auth });
  assert.deepEqual([first.json.mutations.length, first.json.has_more, first.json.project], [100, true, 'proj-a'], 'por defecto 100 y el primer proyecto ordenado');
  assert.equal((await call(s.url, 'GET', '/sync/mutations/pull?limit=-2', { headers: auth })).json.mutations.length, 100);
  const exact = await call(s.url, 'GET', '/sync/mutations/pull?since_seq=117&limit=3', { headers: auth });
  assert.deepEqual([exact.json.mutations.length, exact.json.has_more], [3, false], 'justo las que caben no es «hay más»');
  assert.equal((await s.store.listMutationsSince(0, 500, null)).mutations.length, 100, 'el almacén también limita a 100');
  assert.equal((await s.store.listMutationsSince(0, 0, ['proj-a'])).mutations.length, 100);
  assert.deepEqual((await s.store.listMutationsSince(0, 5, [])), { mutations: [], has_more: false, latest_seq: 0 });
});

test('las escrituras se anotan con el nombre de quien las empuja y los lotes sin autor como desconocidas', async (t) => {
  const s = await start({ token: 'tok', adminToken: 'adm' });
  t.after(s.close);
  const entry = (id) => mut('proj-a', 'prompt', id, 'delete', JSON.stringify({ sync_id: id }));
  await pushMutations(s.url, [entry('p1')], {}, { Authorization: 'Bearer tok' });
  await pushMutations(s.url, [entry('p2')], {}, { Authorization: 'Bearer adm' });
  assert.deepEqual((await s.store.db.query('SELECT created_by FROM cloud_chunks ORDER BY created_at, chunk_id')).map((r) => r.created_by).sort(), ['LEGACY_SYNC', 'OPERATOR']);
  await s.store.insertMutationBatch([{ project: 'proj-a', entity: 'prompt', entity_key: 'p3', op: 'delete', payload: '{"sync_id":"p3"}' }]);
  assert.equal((await s.store.db.query("SELECT created_by FROM cloud_chunks WHERE created_by NOT IN ('LEGACY_SYNC', 'OPERATOR')"))[0].created_by, 'unknown');
  assert.deepEqual(await s.store.insertMutationBatch([]), []);
});
