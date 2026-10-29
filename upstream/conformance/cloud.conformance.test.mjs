// Contraste diferencial de la sincronización por chunks con la nube: las mismas peticiones HTTP sobre
// el servidor de la referencia y sobre el de odin (cada uno con su base en un Postgres real) dan el
// mismo estado, el mismo cuerpo y los mismos chunks guardados; y cada cliente sincroniza contra el
// servidor del otro.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { startPostgres } from '../../test/unit/cloud/pg-helper.js';
import { resolveBinary } from './engram-mcp.mjs';

const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';
const ODIN_BIN = fileURLToPath(new URL('../../bin/odin.js', import.meta.url));
const TOKEN = 'conformance-token-123';
const JWT = 'conformance-jwt-secret-with-more-than-32-chars';
const MAX_PUSH = 4096;

let base;
let postgres;
const children = [];
const pools = [];

before(async () => {
  if (!binary) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-cloud-')));
  postgres = await startPostgres();
});
after(async () => {
  for (const child of children) child.kill('SIGKILL');
  for (const pool of pools) await pool.end().catch(() => {});
  await postgres?.stop();
  if (base) rmSync(base, { recursive: true, force: true });
  binary?.cleanup();
});

const MASKS = [
  [/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<T>'],
  [/vnd\.engram\.sync/g, 'vnd.odin.sync'],
  [/engram-cloud/g, 'odin-cloud'],
  [/ENGRAM_/g, 'ODIN_'],
  [/engram/g, 'odin'],
];
const mask = (text) => MASKS.reduce((out, [pattern, to]) => out.replace(pattern, to), String(text ?? ''));

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

function spawnServer(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderrText = '';
  child.stderr.on('data', (d) => { child.stderrText += d; });
  child.stdout.resume();
  children.push(child);
  return child;
}

async function waitHealthy(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`el servidor terminó antes de estar listo: ${child.stderrText}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // aún no escucha
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`el servidor no respondió a tiempo: ${child.stderrText}`);
}

let counter = 0;

/** Un par de servidores de nube (referencia y odin), cada uno con su base en el mismo Postgres. */
async function cloudPair({ token = TOKEN, allowed = 'proj-a,proj-b,proj-c' } = {}) {
  counter += 1;
  const dir = join(base, `pair-${counter}`);
  mkdirSync(dir);
  const [refDsn, odinDsn] = [await postgres.createDatabase(), await postgres.createDatabase()];
  const [refPort, odinPort] = [await freePort(), await freePort()];
  const insecure = token === '' ? { CLOUD_INSECURE_NO_AUTH: '1' } : { CLOUD_TOKEN: token, JWT_SECRET: JWT };
  const envFor = (prefix, dsn, port, dataVar) => {
    const env = { [dataVar]: join(dir, `${prefix}-data`), HOME: dir, [`${prefix}_DATABASE_URL`]: dsn, [`${prefix}_PORT`]: String(port), [`${prefix}_CLOUD_HOST`]: '127.0.0.1', [`${prefix}_CLOUD_ALLOWED_PROJECTS`]: allowed, [`${prefix}_CLOUD_MAX_PUSH_BYTES`]: String(MAX_PUSH) };
    for (const [k, v] of Object.entries(insecure)) env[`${prefix}_${k}`] = v;
    return env;
  };
  const refChild = spawnServer(binary.bin, ['cloud', 'serve'], { ...envFor('ENGRAM', refDsn, refPort, 'ENGRAM_DATA_DIR'), ENGRAM_NO_UPDATE_CHECK: '1' }, dir);
  const odinChild = spawnServer(process.execPath, ['--no-warnings', ODIN_BIN, 'cloud', 'serve'], envFor('ODIN', odinDsn, odinPort, 'ODIN_DATA_DIR'), dir);
  await Promise.all([waitHealthy(refPort, refChild), waitHealthy(odinPort, odinChild)]);
  const [refPool, odinPool] = [new pg.Pool({ connectionString: refDsn }), new pg.Pool({ connectionString: odinDsn })];
  pools.push(refPool, odinPool);
  return { dir, refPort, odinPort, refPool, odinPool, refUrl: `http://127.0.0.1:${refPort}`, odinUrl: `http://127.0.0.1:${odinPort}` };
}

const bearer = { Authorization: `Bearer ${TOKEN}` };

async function send(port, method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] ??= 'application/json';
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const buf = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') ?? '';
  const text = type.includes('+gzip') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, type: mask(type), text, json, allow: response.headers.get('allow'), cache: response.headers.get('cache-control'), vary: response.headers.get('vary') };
}

/** Envía lo mismo a ambos y exige igual estado, tipo y cuerpo; `make(side)` ajusta lo propio de cada lado. */
async function same(pair, method, path, make = () => ({}), { exactText = true } = {}) {
  const [ref, odin] = await Promise.all([send(pair.refPort, method, path, make('ref')), send(pair.odinPort, method, path, make('odin'))]);
  const label = `${method} ${path}`;
  assert.equal(odin.status, ref.status, `${label}: estado\n--- ref ${ref.text}\n--- odin ${odin.text}`);
  assert.equal(odin.type, ref.type, `${label}: Content-Type`);
  assert.equal(odin.allow, ref.allow, `${label}: Allow`);
  assert.equal(odin.cache, ref.cache, `${label}: Cache-Control`);
  assert.equal(odin.vary, ref.vary, `${label}: Vary`);
  if (exactText) assert.equal(mask(odin.text), mask(ref.text), `${label}: cuerpo`);
  return { ref, odin };
}

const sample = (project = 'proj-a', session = 's1', title = 'Usar Postgres') => ({
  sessions: [{ id: session, project, directory: '/tmp/x', started_at: '2026-01-01 00:00:00' }],
  observations: [{ id: 1, sync_id: 'obs-aaaaaaaaaaaaaaaa', session_id: session, type: 'decision', title, content: 'contenido', scope: 'project', project, created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' }],
  prompts: [{ id: 1, sync_id: 'prompt-bbbbbbbbbbbbbbbb', session_id: session, content: 'pregunta', project, created_at: '2026-01-01 00:00:00' }],
});
const envelope = (data, extra = {}) => ({ chunk_id: '', created_by: 'tester', client_created_at: '2026-01-02T03:04:05Z', project: 'proj-a', data, ...extra });

test('autenticación y rutas', { skip }, async () => {
  const pair = await cloudPair();
  await same(pair, 'GET', '/health');
  for (const headers of [{}, { Authorization: 'Basic abc' }, { Authorization: 'Bearer' }, { Authorization: 'Bearer wrong' }, { Authorization: 'Bearer a b' }, { Authorization: 'Token xyz' }]) {
    const r = await same(pair, 'GET', '/sync/pull?project=proj-a', () => ({ headers }));
    assert.equal(r.ref.status, 401, JSON.stringify(headers));
  }
  const lower = await same(pair, 'GET', '/sync/pull?project=proj-a', () => ({ headers: { Authorization: `bearer ${TOKEN}` } }));
  assert.equal(lower.ref.status, 200);
  await same(pair, 'GET', '/nope');
  await same(pair, 'DELETE', '/sync/pull', () => ({ headers: bearer }));
  await same(pair, 'GET', '/sync/push', () => ({ headers: bearer }));
});

test('lectura: proyecto obligatorio, lista permitida y manifiesto vacío', { skip }, async () => {
  const pair = await cloudPair();
  const h = { headers: bearer };
  await same(pair, 'GET', '/sync/pull', () => h);
  await same(pair, 'GET', '/sync/pull?project=', () => h);
  await same(pair, 'GET', '/sync/pull?project=%20', () => h);
  await same(pair, 'GET', '/sync/pull?project=ajeno', () => h);
  const empty = await same(pair, 'GET', '/sync/pull?project=proj-a', () => h);
  assert.deepEqual(empty.ref.json, { version: 2, chunks: [] });
  await same(pair, 'GET', '/sync/pull?project=PROJ-A', () => h);
  await same(pair, 'GET', '/sync/pull/abcd1234?project=proj-a', () => h);
  await same(pair, 'GET', '/sync/pull/abcd1234', () => h);
  await same(pair, 'GET', '/sync/pull/abcd1234?project=ajeno', () => h);
});

test('subida: validaciones y chunk guardado idéntico', { skip }, async () => {
  const pair = await cloudPair();
  const post = (body, extra = {}) => () => ({ headers: bearer, body, ...extra });
  const gz = (body) => (side) => ({
    headers: { ...bearer, 'Content-Type': `application/vnd.${side === 'ref' ? 'engram' : 'odin'}.sync+gzip; version=1` },
    raw: gzipSync(Buffer.from(JSON.stringify(body))),
  });

  // El texto del error de análisis lo da cada decodificador: se contrasta la clasificación.
  for (const raw of ['{', '[]', 'no es json']) {
    const [ref, odin] = await Promise.all([send(pair.refPort, 'POST', '/sync/push', { headers: bearer, raw }), send(pair.odinPort, 'POST', '/sync/push', { headers: bearer, raw })]);
    assert.equal(odin.status, 400, raw);
    assert.equal(ref.status, 400, raw);
    for (const key of ['error_class', 'error_code']) assert.equal(odin.json[key], ref.json[key], `${raw}: ${key}`);
    assert.match(odin.json.error, /^invalid push payload: /);
  }
  await same(pair, 'POST', '/sync/push', post({ project: 'proj-a' }));
  await same(pair, 'POST', '/sync/push', post({ data: sample() }));
  await same(pair, 'POST', '/sync/push', post(envelope(sample(), { project: 'ajeno' })));
  await same(pair, 'POST', '/sync/push?project=proj-a', post({ data: sample() }));
  await same(pair, 'POST', '/sync/push', post(envelope(sample(), { client_created_at: 'ayer' })));
  await same(pair, 'POST', '/sync/push', post(envelope({ sessions: [{ id: ' ', directory: '/x' }] })));
  await same(pair, 'POST', '/sync/push', post(envelope({ sessions: [{ id: 's1' }] })));
  await same(pair, 'POST', '/sync/push', post(envelope({ ...sample(), observations: [{ sync_id: 'obs-x' }] })));
  await same(pair, 'POST', '/sync/push', post(envelope({ ...sample(), prompts: [{ sync_id: 'p', session_id: 's1' }] })));
  await same(pair, 'POST', '/sync/push', post(envelope({ sessions: [], observations: sample().observations, prompts: [] })));
  await same(pair, 'POST', '/sync/push', (side) => ({ headers: { ...bearer, 'Content-Type': `application/vnd.${side === 'ref' ? 'engram' : 'odin'}.sync+gzip; version=9` }, raw: 'x' }));
  await same(pair, 'POST', '/sync/push', () => ({ headers: bearer, raw: JSON.stringify(envelope({ ...sample(), pad: 'x'.repeat(MAX_PUSH) })) }));
  await same(pair, 'POST', '/sync/push', gz(envelope({ ...sample(), pad: 'x'.repeat(MAX_PUSH * 2) })));

  // Subidas válidas: JSON plano, sobre comprimido y repetición.
  const first = await same(pair, 'POST', '/sync/push', post(envelope(sample())));
  assert.equal(first.ref.status, 200);
  assert.match(first.ref.json.chunk_id, /^[0-9a-f]{8}$/);
  assert.equal(first.odin.json.chunk_id, first.ref.json.chunk_id, 'el mismo identificador de chunk');
  await same(pair, 'POST', '/sync/push', post(envelope(sample())));
  const zipped = await same(pair, 'POST', '/sync/push', gz(envelope(sample('proj-a', 's1', 'Otro título'))));
  assert.equal(zipped.ref.status, 200);
  // Una sesión conocida de una subida anterior se puede referenciar sin repetirla.
  const refOnly = { observations: [{ ...sample().observations[0], sync_id: 'obs-cccccccccccccccc' }], sessions: [], prompts: [] };
  await same(pair, 'POST', '/sync/push', post(envelope(refOnly)));
  await same(pair, 'POST', '/sync/push', post(envelope({ ...refOnly, observations: [{ ...refOnly.observations[0], session_id: 'desconocida' }] })));
  // Con mutaciones.
  const withMutation = {
    ...sample('proj-a', 's2'),
    mutations: [{ entity: 'observation', entity_key: 'obs-dddddddddddddddd', op: 'delete', payload: JSON.stringify({ sync_id: 'obs-dddddddddddddddd', deleted: true, hard_delete: false }) }],
  };
  await same(pair, 'POST', '/sync/push', post(envelope(withMutation)));
  // Con lista de mutaciones solo toman el proyecto las sesiones que algo necesita.
  const owned = {
    sessions: [{ id: 'duena', directory: '/a', project: 'ajeno' }, { id: 'usada', directory: '/b', project: 'ajeno' }, { id: 'libre', directory: '/c', project: 'ajeno' }],
    observations: [{ ...sample().observations[0], sync_id: 'obs-hhhhhhhhhhhhhhhh', session_id: 'usada' }],
    prompts: [],
    mutations: [{ entity: 'session', op: 'upsert', payload: JSON.stringify({ id: 'duena', directory: '/a' }) }, { entity: 'prompt', op: 'delete', payload: JSON.stringify({ sync_id: 'prompt-iiiiiiiiiiiiiiii', session_id: 'libre' }) }],
  };
  await same(pair, 'POST', '/sync/push', post(envelope(owned)));
  // Mutaciones de todas las clases: la carga se reescribe con la forma de la estructura de cada entidad.
  const relation = { sync_id: 'rel-eeeeeeeeeeeeeeee', source_id: 'obs-aaaaaaaaaaaaaaaa', target_id: 'obs-cccccccccccccccc', relation: 'related', judgment_status: 'judged', marked_by_actor: ' alguien ', marked_by_kind: 'human', extra: 'se descarta', confidence: 0.5, reason: '<b>&</b>' };
  const mutations = [
    { entity: 'relation', entity_key: 'rel-eeeeeeeeeeeeeeee', op: 'upsert', payload: JSON.stringify(relation) },
    { entity: 'session', entity_key: 's3', op: 'delete', payload: JSON.stringify({ id: 's3', directory: '/x', started_at: 'ayer', deleted: true, deleted_at: '  ' }) },
    { entity: 'session', op: 'upsert', payload: JSON.stringify({ id: 's4', directory: ' /d ', started_at: '2026-01-01 00:00:00', summary: 'resumen', ownership_mode: 'shared' }) },
    { entity: 'observation', op: 'upsert', payload: JSON.stringify({ sync_id: ' obs-ffffffffffffffff ', session_id: 's4', type: ' note ', title: 't', content: 'c', scope: 'project', review_after: null, revision_count: 2, tool_name: 'x', Topic_Key: 'a/b' }) },
    { entity: 'prompt', entity_key: 'prompt-gggggggggggggggg', op: 'upsert', payload: JSON.stringify(JSON.stringify({ sync_id: 'prompt-gggggggggggggggg', session_id: 's4', content: ' hola ', created_at: 'hoy' })) },
  ];
  await same(pair, 'POST', '/sync/push', post(envelope({ sessions: [], observations: [], prompts: [], mutations })));
  for (const [label, mutation] of [
    ['operación no admitida', { entity: 'relation', entity_key: 'r', op: 'delete', payload: '{}' }],
    ['entidad desconocida', { entity: 'cosa', op: 'upsert', payload: '{}' }],
    ['sin carga', { entity: 'prompt', op: 'upsert' }],
    ['clave que no coincide', { entity: 'prompt', entity_key: 'otra', op: 'delete', payload: JSON.stringify({ sync_id: 'prompt-hhhhhhhhhhhhhhhh' }) }],
    ['relación sin autor', { entity: 'relation', op: 'upsert', payload: JSON.stringify({ ...relation, marked_by_actor: '' }) }],
    ['carga de otro tipo', { entity: 'prompt', op: 'upsert', payload: JSON.stringify({ sync_id: 5 }) }],
    ['carga como objeto', { entity: 'prompt', op: 'upsert', payload: { sync_id: 'x' } }],
    ['sesión sin directorio', { entity: 'session', op: 'upsert', payload: JSON.stringify({ id: 's5' }) }],
  ]) {
    const [ref, odin] = await Promise.all([
      send(pair.refPort, 'POST', '/sync/push', { headers: bearer, body: envelope({ sessions: [], observations: [], prompts: [], mutations: [mutation] }) }),
      send(pair.odinPort, 'POST', '/sync/push', { headers: bearer, body: envelope({ sessions: [], observations: [], prompts: [], mutations: [mutation] }) }),
    ]);
    assert.equal(odin.status, ref.status, `${label}\n--- ref ${ref.text}\n--- odin ${odin.text}`);
    assert.equal(ref.status, 400, label);
    assert.equal(odin.json.error_code, ref.json.error_code, label);
    // El texto de un tipo mal formado cita la estructura Go: se contrasta sin ese detalle.
    const plain = (t) => t.replace(/Go struct field \S+ of type \S+/, 'Go struct field').replace(/json: cannot unmarshal \w+ into Go value of type .*?"/, 'json: cannot unmarshal "');
    assert.equal(plain(odin.json.error), plain(ref.json.error), label);
  }

  const manifests = await same(pair, 'GET', '/sync/pull?project=proj-a', () => ({ headers: bearer }), { exactText: false });
  assert.equal(manifests.ref.json.chunks.length >= 3, true);
  const strip = (m) => m.chunks.map((c) => ({ ...c, created_at: c.created_at.slice(0, 10) })).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(strip(manifests.odin.json), strip(manifests.ref.json));

  for (const entry of manifests.ref.json.chunks) {
    const plain = await same(pair, 'GET', `/sync/pull/${entry.id}?project=proj-a`, () => ({ headers: bearer }));
    assert.equal(plain.ref.status, 200);
    const compressed = await same(pair, 'GET', `/sync/pull/${entry.id}?project=proj-a`, (side) => ({ headers: { ...bearer, Accept: `application/vnd.${side === 'ref' ? 'engram' : 'odin'}.sync+gzip; version=1` } }));
    assert.match(compressed.ref.type, /\+gzip/);
  }
  const rows = (pool) => pool.query('SELECT project_name, chunk_id, created_by, sessions_count, observations_count, prompts_count, payload::text AS payload FROM cloud_chunks ORDER BY chunk_id').then((r) => r.rows);
  assert.deepEqual(await rows(pair.odinPool), await rows(pair.refPool), 'las filas de cloud_chunks');
  const sessions = (pool) => pool.query('SELECT project_name, session_id FROM cloud_project_sessions ORDER BY 1, 2').then((r) => r.rows);
  assert.deepEqual(await sessions(pair.odinPool), await sessions(pair.refPool), 'el índice de sesiones');
});

test('proyecto en pausa: 409 y auditoría', { skip }, async () => {
  const pair = await cloudPair();
  for (const pool of [pair.refPool, pair.odinPool]) {
    await pool.query("INSERT INTO cloud_project_controls (project, sync_enabled, paused_reason, updated_by) VALUES ('proj-b', false, 'mantenimiento', 'ops')");
  }
  const paused = await same(pair, 'POST', '/sync/push', () => ({ headers: bearer, body: envelope(sample('proj-b'), { project: 'proj-b' }) }));
  assert.equal(paused.ref.status, 409);
  assert.equal(paused.ref.json.error_code, 'sync-paused');
  await same(pair, 'POST', '/sync/push', () => ({ headers: bearer, body: { data: sample('proj-b'), project: 'proj-b' } }));
  const audit = (pool) => pool.query('SELECT contributor, project, action, outcome, entry_count, reason_code, metadata::text AS metadata FROM cloud_sync_audit_log ORDER BY id').then((r) => r.rows);
  const [ref, odin] = [await audit(pair.refPool), await audit(pair.odinPool)];
  assert.equal(ref.length, 2);
  assert.deepEqual(odin, ref);
  await same(pair, 'GET', '/sync/pull?project=proj-b', () => ({ headers: bearer }));
});

// ─── Clientes cruzados ───────────────────────────────────────────────────────

function cliRun(side, dir, args, cwd, env = {}) {
  const common = { cwd, encoding: 'utf8', timeout: 60_000 };
  if (side === 'ref') {
    return spawnSync(binary.bin, args, { ...common, env: { ...process.env, ENGRAM_DATA_DIR: join(dir, 'ref-client'), ENGRAM_NO_UPDATE_CHECK: '1', HOME: dir, ...env } });
  }
  return spawnSync(process.execPath, ['--no-warnings', ODIN_BIN, ...args], { ...common, env: { ...process.env, ODIN_DATA_DIR: join(dir, 'odin-client'), HOME: dir, ...env } });
}

function countObservations(dir, side, title) {
  const db = new DatabaseSync(join(dir, side === 'ref' ? 'ref-client' : 'odin-client', side === 'ref' ? 'engram.db' : 'odin.db'));
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM observations WHERE title = ? AND deleted_at IS NULL').get(title).n;
  } finally {
    db.close();
  }
}

for (const [writer, reader] of [['odin', 'ref'], ['ref', 'odin']]) {
  test(`cliente ${writer} sube y el cliente ${reader} importa (servidor de la referencia y de odin)`, { skip }, async () => {
    const pair = await cloudPair({ token: '' });
    for (const [serverSide, url] of [['ref', pair.refUrl], ['odin', pair.odinUrl]]) {
      const dir = join(pair.dir, `cross-${writer}-${serverSide}`);
      mkdirSync(dir);
      const repo = join(dir, 'proj-c');
      mkdirSync(repo);
      execFileSync('git', ['init', '-q', repo]);
      const title = `Memoria de ${writer} en ${serverSide}`;
      const run = (side, args) => cliRun(side, dir, args, repo);
      for (const side of [writer, reader]) {
        assert.equal(run(side, ['cloud', 'config', '--server', url]).status, 0, `${side}: cloud config`);
        assert.equal(run(side, ['cloud', 'enroll', 'proj-c']).status, 0, `${side}: cloud enroll`);
      }
      const saved = run(writer, ['save', title, 'cuerpo de la memoria', '--project', 'proj-c']);
      assert.equal(saved.status, 0, saved.stderr);
      const pushed = run(writer, ['sync', '--cloud', '--project', 'proj-c']);
      assert.equal(pushed.status, 0, `${writer} → ${serverSide}: ${pushed.stderr}${pushed.stdout}`);
      assert.match(pushed.stdout, /Created chunk [0-9a-f]{8}/);
      const pulled = run(reader, ['sync', '--cloud', '--project', 'proj-c', '--import']);
      assert.equal(pulled.status, 0, `${reader} ← ${serverSide}: ${pulled.stderr}${pulled.stdout}`);
      assert.match(pulled.stdout, /Imported 1 new remote chunk\(s\) for project "proj-c"/);
      assert.equal(countObservations(dir, reader, title), 1, 'la memoria llegó al lector');
    }
  });
}
