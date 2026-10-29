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
      { entity: 'session', op: 'upsert', payload: JSON.stringify({ id: 'b' }) },
      { entity: 'session', op: 'upsert', entity_key: 'c', payload: '{}' },
      { entity: 'session', op: 'delete', payload: JSON.stringify({ id: 'd' }) },
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
