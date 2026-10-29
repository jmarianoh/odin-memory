import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { HttpStatusError, MutationTransport, RemoteTransport, validateBaseUrl, validateBearerBaseUrl } from '../../../src/cloud/remote.js';
import { ChunkNotFoundError } from '../../../src/sync/transport.js';

/** `fetch` simulado: registra las peticiones y responde con lo que dicte `reply`. */
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = await reply(url, init, calls.length);
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return { fn, calls };
}

test('la URL base debe ser http o https, con host y sin consulta ni fragmento', () => {
  assert.equal(validateBaseUrl(' https://nube.example/api/ '), 'https://nube.example/api');
  assert.throws(() => validateBaseUrl(''), /remote url is required/);
  assert.throws(() => validateBaseUrl('x'), /invalid remote url/);
  assert.throws(() => validateBaseUrl('ftp://x.example'), /scheme must be http or https/);
  assert.throws(() => validateBaseUrl('https://x.example?a=1'), /query is not allowed/);
  assert.throws(() => validateBaseUrl('https://x.example#a'), /fragment is not allowed/);
  assert.deepEqual(validateBearerBaseUrl('http://127.0.0.1:1', ''), { baseUrl: 'http://127.0.0.1:1', token: '' });
  assert.deepEqual(validateBearerBaseUrl('https://x.example', ' t '), { baseUrl: 'https://x.example', token: 't' });
  assert.throws(() => validateBearerBaseUrl('http://x.example', 't'), /bearer token requires an HTTPS remote URL/);
  assert.throws(() => new RemoteTransport('http://x.example', 't', 'p'), /requires an HTTPS/);
});

test('leer el manifiesto envía el proyecto y el token', async () => {
  const { fn, calls } = fakeFetch(() => ({ body: JSON.stringify({ version: 2, chunks: [{ id: 'abcd1234' }] }) }));
  const transport = new RemoteTransport('https://nube.example/base', 'tok', 'mi repo', { fetch: fn });
  assert.deepEqual(await transport.readManifest(), { version: 2, chunks: [{ id: 'abcd1234' }] });
  assert.equal(calls[0].url, 'https://nube.example/base/sync/pull?project=mi+repo');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  await transport.writeManifest({});
  assert.equal(calls.length, 1, 'el manifiesto lo lleva el servidor');

  const anon = fakeFetch(() => ({ body: '{"version":2}' }));
  assert.deepEqual(await new RemoteTransport('http://127.0.0.1:1', '', 'p', { fetch: anon.fn }).readManifest(), { version: 2, chunks: [] });
  assert.equal('Authorization' in anon.calls[0].init.headers, false);
});

test('los errores del manifiesto conservan el estado y la clasificación', async () => {
  const cases = [
    [{ status: 401, body: 'unauthorized: unknown token\n' }, 'cloud: fetch manifest: status 401: unauthorized: unknown token'],
    [{ status: 403, body: JSON.stringify({ error_class: 'policy', error_code: 'policy_forbidden', error: 'forbidden' }) }, 'cloud: fetch manifest: status 403: forbidden'],
  ];
  for (const [reply, message] of cases) {
    const transport = new RemoteTransport('http://127.0.0.1:1', '', 'p', { fetch: fakeFetch(() => reply).fn });
    await assert.rejects(transport.readManifest(), (err) => err instanceof HttpStatusError && err.message === message);
  }
  const broken = new RemoteTransport('http://127.0.0.1:1', '', 'p', { fetch: fakeFetch(() => ({ body: 'no json' })).fn });
  await assert.rejects(broken.readManifest(), /^Error: cloud: parse manifest: /);
  const down = new RemoteTransport('http://127.0.0.1:1', '', 'p', { fetch: async () => { throw new Error('connect ECONNREFUSED'); } });
  await assert.rejects(down.readManifest(), /^Error: cloud: fetch manifest: connect ECONNREFUSED$/);
});

test('subir un chunk lo canonicaliza para el proyecto y lo envía comprimido', async () => {
  const { fn, calls } = fakeFetch(() => ({ body: '{"status":"ok"}' }));
  const transport = new RemoteTransport('https://nube.example', 'tok', 'mi-repo', { fetch: fn });
  const chunk = JSON.stringify({ sessions: [{ id: 's1', directory: '/x', project: 'otro' }], observations: [], prompts: [] });
  await transport.writeChunk('local123', chunk, { created_by: 'ana', created_at: '2026-01-02T03:04:05Z' });
  const [{ url, init }] = calls;
  assert.equal(url, 'https://nube.example/sync/push');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/vnd.odin.sync+gzip; version=1');
  const sent = JSON.parse(gunzipSync(init.body));
  assert.deepEqual(Object.keys(sent), ['chunk_id', 'created_by', 'client_created_at', 'project', 'data']);
  assert.equal(sent.created_by, 'ana');
  assert.equal(sent.client_created_at, '2026-01-02T03:04:05Z');
  assert.equal(sent.project, 'mi-repo');
  assert.equal(sent.data.sessions[0].project, 'mi-repo');
  assert.match(sent.chunk_id, /^[0-9a-f]{8}$/);

  await assert.rejects(transport.writeChunk('x', '{', {}), /^Error: cloud: canonicalize push chunk: decode chunk data/);
  const refused = new RemoteTransport('https://nube.example', 't', 'p', { fetch: fakeFetch(() => ({ status: 409, body: JSON.stringify({ error_class: 'policy', error_code: 'sync-paused', error: 'sync is paused' }) })).fn });
  await assert.rejects(refused.writeChunk('x', '{}', {}), (err) => err.statusCode === 409 && err.errorCode === 'sync-paused' && /^cloud: push chunk x: status 409: sync is paused$/.test(err.message));
});

test('leer un chunk acepta el sobre comprimido o el JSON plano', async () => {
  const payload = '{"sessions":[],"observations":[],"prompts":[]}';
  const zipped = fakeFetch(() => ({ body: gzipSync(Buffer.from(payload)), headers: { 'Content-Type': 'application/vnd.odin.sync+gzip; version=1' } }));
  const a = new RemoteTransport('http://127.0.0.1:1', '', 'p', { fetch: zipped.fn });
  assert.equal(await a.readChunk('abcd1234'), payload);
  assert.equal(zipped.calls[0].url, 'http://127.0.0.1:1/sync/pull/abcd1234?project=p');
  assert.equal(zipped.calls[0].init.headers.Accept, 'application/vnd.odin.sync+gzip; version=1');

  const plain = new RemoteTransport('http://127.0.0.1:1', '', 'p', { fetch: fakeFetch(() => ({ body: payload, headers: { 'Content-Type': 'application/json' } })).fn });
  assert.equal(await plain.readChunk('abcd1234'), payload);

  const missing = new RemoteTransport('http://127.0.0.1:1', '', 'p', { fetch: fakeFetch(() => ({ status: 404, body: 'read chunk: not found' })).fn });
  await assert.rejects(missing.readChunk('x'), ChunkNotFoundError);
  const empty = new RemoteTransport('http://127.0.0.1:1', '', 'p', { fetch: fakeFetch(() => ({ body: '' })).fn });
  await assert.rejects(empty.readChunk('x'), /empty chunk payload/);
  const corrupt = new RemoteTransport('http://127.0.0.1:1', '', 'p', { fetch: fakeFetch(() => ({ body: 'basura', headers: { 'Content-Type': 'application/vnd.odin.sync+gzip; version=1' } })).fn });
  await assert.rejects(corrupt.readChunk('x'), /decode compressed chunk x/);
  const failing = new RemoteTransport('http://127.0.0.1:1', '', 'p', { fetch: fakeFetch(() => ({ status: 500, body: 'boom' })).fn });
  await assert.rejects(failing.readChunk('x'), /cloud: pull chunk x: status 500: boom/);
});

test('una redirección solo se sigue con token si va a HTTPS', async () => {
  const hops = [];
  const secure = fakeFetch((url) => {
    hops.push(url);
    return hops.length === 1 ? { status: 307, headers: { Location: 'https://otro.example/sync/pull?project=p' } } : { body: '{"version":2,"chunks":[]}' };
  });
  const ok = new RemoteTransport('https://nube.example', 't', 'p', { fetch: secure.fn });
  assert.deepEqual(await ok.readManifest(), { version: 2, chunks: [] });
  assert.equal(hops[1], 'https://otro.example/sync/pull?project=p');
  assert.equal(secure.calls[1].init.headers.Authorization, 'Bearer t');

  const downgrade = new RemoteTransport('https://nube.example', 't', 'p', { fetch: fakeFetch(() => ({ status: 302, headers: { Location: 'http://plano.example/' } })).fn });
  await assert.rejects(downgrade.readManifest(), /bearer token redirect requires HTTPS/);

  const loop = new RemoteTransport('https://nube.example', 't', 'p', { fetch: fakeFetch(() => ({ status: 302, headers: { Location: 'https://nube.example/otra' } })).fn });
  await assert.rejects(loop.readManifest(), /too many redirects/);

  const anon = new RemoteTransport('http://127.0.0.1:1', '', 'p', { fetch: fakeFetch((url) => (url.includes('/aqui') ? { body: '{"version":2}' } : { status: 302, headers: { Location: 'http://127.0.0.1:1/aqui' } })).fn });
  assert.deepEqual(await anon.readManifest(), { version: 2, chunks: [] }, 'sin token puede seguir a http');
});

// ─── Transporte de mutaciones ────────────────────────────────────────────────


test('empujar mutaciones envía las cargas como JSON y devuelve las secuencias aceptadas', async () => {
  const { fn, calls } = fakeFetch(() => ({ body: JSON.stringify({ accepted_seqs: [4, 5], project: 'p' }) }));
  const transport = new MutationTransport('https://nube.example/', 'tok', { fetch: fn });
  const seqs = await transport.pushMutations([
    { project: 'p', entity: 'prompt', entity_key: 'a', op: 'delete', payload: '{"sync_id":"a"}' },
    { project: 'p', entity: 'session', entity_key: 'b', op: 'upsert', payload: '"{\\"id\\":\\"b\\"}"' },
  ]);
  assert.deepEqual(seqs, [4, 5]);
  const [{ url, init }] = calls;
  assert.equal(url, 'https://nube.example/sync/mutations/push');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(init.body), {
    entries: [
      { project: 'p', entity: 'prompt', entity_key: 'a', op: 'delete', payload: { sync_id: 'a' } },
      { project: 'p', entity: 'session', entity_key: 'b', op: 'upsert', payload: '{"id":"b"}' },
    ],
  });
  const none = new MutationTransport('http://127.0.0.1:1', '', { fetch: fakeFetch(() => ({ body: '{}' })).fn });
  assert.deepEqual(await none.pushMutations([]), []);
  await assert.rejects(none.pushMutations([{ project: 'p', entity: 'x', entity_key: 'k', op: 'upsert', payload: 'no json' }]), /^Error: cloud: marshal mutation push: /);
  assert.throws(() => new MutationTransport('http://x.example', 't'), /requires an HTTPS/);
});

test('leer mutaciones pide por cursor y normaliza la respuesta', async () => {
  const { fn, calls } = fakeFetch(() => ({ body: JSON.stringify({ mutations: [{ seq: 3, project: 'p', entity: 'prompt', entity_key: 'a', op: 'delete', payload: { sync_id: 'a' }, occurred_at: 'x' }], has_more: true, latest_seq: 3 }) }));
  const transport = new MutationTransport('http://127.0.0.1:1', '', { fetch: fn });
  const page = await transport.pullMutations(2, 50);
  assert.equal(calls[0].url, 'http://127.0.0.1:1/sync/mutations/pull?since_seq=2&limit=50');
  assert.deepEqual([page.mutations.length, page.has_more, page.latest_seq], [1, true, 3]);
  const empty = new MutationTransport('http://127.0.0.1:1', '', { fetch: fakeFetch(() => ({ body: '{}' })).fn });
  assert.deepEqual(await empty.pullMutations(0, 10), { mutations: [], has_more: false, latest_seq: 0 });
});

test('los fallos de las mutaciones conservan su clasificación y un 404 es «servidor sin soporte»', async () => {
  const logs = [];
  const refused = (status, body) => new MutationTransport('http://127.0.0.1:1', '', { fetch: fakeFetch(() => ({ status, body })).fn, log: (m) => logs.push(m) });
  const missing = await refused(404, '404 page not found').pushMutations([]).catch((e) => e);
  assert.deepEqual([missing.statusCode, missing.errorCode, missing.message], [404, 'server_unsupported', 'cloud: mutation push: status 404: 404 page not found']);
  assert.match(logs[0], /\[autosync\] cloud mutation endpoint returned 404 \(server_unsupported\); deploy the new server first before enabling ODIN_CLOUD_AUTOSYNC=1/);
  const auth = await refused(401, 'unauthorized: unknown token\n').pullMutations(0, 1).catch((e) => e);
  assert.deepEqual([auth.isAuthFailure, auth.message], [true, 'cloud: mutation pull: status 401: unauthorized: unknown token']);
  const policy = await refused(403, JSON.stringify({ error_class: 'policy', error_code: 'policy_forbidden', error: 'forbidden' })).pushMutations([]).catch((e) => e);
  assert.deepEqual([policy.isPolicyFailure, policy.errorCode, logs.length], [true, 'policy_forbidden', 1]);
  const down = new MutationTransport('http://127.0.0.1:1', '', { fetch: async () => { throw new Error('refused'); } });
  await assert.rejects(down.pushMutations([]), /^Error: cloud: mutation push: refused$/);
  await assert.rejects(down.pullMutations(0, 1), /^Error: cloud: mutation pull: refused$/);
  const broken = new MutationTransport('http://127.0.0.1:1', '', { fetch: fakeFetch(() => ({ body: 'no json' })).fn });
  await assert.rejects(broken.pushMutations([]), /decode mutation push response/);
  await assert.rejects(broken.pullMutations(0, 1), /decode mutation pull response/);
});
