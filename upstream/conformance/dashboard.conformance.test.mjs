// Contraste diferencial del panel web: las mismas páginas sobre el servidor de la referencia y sobre el de
// odin (cada uno con su base en un Postgres real) muestran los mismos datos, en el mismo orden y con los
// mismos recuentos. Se comparan los textos de datos de cada página, no el marcado.
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
import { AutosyncManager } from '../../src/cloud/autosync.js';
import { MutationTransport } from '../../src/cloud/remote.js';
import { Store, addObservation, addPrompt, createSession, deleteObservation, enrollProject, searchObservations, updateObservation } from '../../src/store/index.js';
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
  [/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g, '<T>'],
  [/vnd\.engram\.sync/g, 'vnd.odin.sync'],
  [/engram-cloud/g, 'odin-cloud'],
  [/\b(egc|odc)_live_[0-9a-f]{8}_[\w-]+/g, '<TOKEN>'],
  [/\b(egc|odc)_live_[0-9a-f]{8}\b/g, '<PREFIX>'],
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
async function cloudPair({ token = TOKEN, allowed = 'proj-a,proj-b,proj-c', pepper = '', admin = '' } = {}) {
  counter += 1;
  const dir = join(base, `pair-${counter}`);
  mkdirSync(dir);
  const [refDsn, odinDsn] = [await postgres.createDatabase(), await postgres.createDatabase()];
  const [refPort, odinPort] = [await freePort(), await freePort()];
  const insecure = token === '' ? { CLOUD_INSECURE_NO_AUTH: '1' } : { CLOUD_TOKEN: token, JWT_SECRET: JWT };
  const envFor = (prefix, dsn, port, dataVar) => {
    const env = { [dataVar]: join(dir, `${prefix}-data`), HOME: dir, [`${prefix}_DATABASE_URL`]: dsn, [`${prefix}_PORT`]: String(port), [`${prefix}_CLOUD_HOST`]: '127.0.0.1', [`${prefix}_CLOUD_ALLOWED_PROJECTS`]: allowed, [`${prefix}_CLOUD_MAX_PUSH_BYTES`]: String(MAX_PUSH) };
    for (const [k, v] of Object.entries(insecure)) env[`${prefix}_${k}`] = v;
    if (pepper !== '') env[`${prefix}_CLOUD_TOKEN_PEPPER`] = pepper;
    if (admin !== '') env[`${prefix}_CLOUD_ADMIN`] = admin;
    return env;
  };
  const refChild = spawnServer(binary.bin, ['cloud', 'serve'], { ...envFor('ENGRAM', refDsn, refPort, 'ENGRAM_DATA_DIR'), ENGRAM_NO_UPDATE_CHECK: '1' }, dir);
  const odinChild = spawnServer(process.execPath, ['--no-warnings', ODIN_BIN, 'cloud', 'serve'], envFor('ODIN', odinDsn, odinPort, 'ODIN_DATA_DIR'), dir);
  await Promise.all([waitHealthy(refPort, refChild), waitHealthy(odinPort, odinChild)]);
  const [refPool, odinPool] = [new pg.Pool({ connectionString: refDsn }), new pg.Pool({ connectionString: odinDsn })];
  pools.push(refPool, odinPool);
  return { dir, refDsn, odinDsn, refPort, odinPort, refPool, odinPool, refUrl: `http://127.0.0.1:${refPort}`, odinUrl: `http://127.0.0.1:${odinPort}` };
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


/** Textos de la página que llevan datos: sin etiquetas, scripts ni estilos, con entidades resueltas. */
function dataTexts(html) {
  const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html;
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#34;': '"', '&quot;': '"', '&#39;': "'" };
  return main
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .split(/<[^>]+>/)
    .map((t) => t.replace(/&(amp|lt|gt|#34|quot|#39);/g, (m) => entities[m]).replace(/\s+/g, ' ').trim())
    .filter((t) => t !== '');
}

async function login(port) {
  const response = await fetch(`http://127.0.0.1:${port}/dashboard/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}` });
  assert.equal(response.status, 303);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

const page = async (port, cookie, path, htmx) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', headers: { Cookie: cookie, ...(htmx ? { 'HX-Request': 'true' } : {}) } });
  return { status: response.status, texts: dataTexts(await response.text()), location: response.headers.get('location') };
};

const minute = (n) => `2026-02-01T00:${String(n).padStart(2, '0')}:00Z`;

async function seedBoth(pair) {
  const push = async (project, createdBy, data) => {
    for (const port of [pair.refPort, pair.odinPort]) {
      const r = await send(port, 'POST', '/sync/push', { headers: bearer, body: { project, created_by: createdBy, client_created_at: '2026-02-01T00:00:00Z', data } });
      assert.equal(r.status, 200, r.text);
    }
  };
  const observations = Array.from({ length: 13 }, (_, i) => ({
    sync_id: `obs-${String(i).padStart(2, '0')}`, session_id: i % 2 === 0 ? 's1' : 's2', type: ['decision', 'bugfix', 'discovery', 'note'][i % 4], title: `Hallazgo ${i} <x> & más`,
    content: i % 3 === 0 ? `**What**: cosa ${i}\n\n**Why**: razón & ${i}` : i % 3 === 1 ? `## Contexto\nlínea ${i}\n\n## Cierre\nfin` : `texto plano ${i}\n\nsegundo párrafo`,
    scope: 'project', topic_key: i % 2 === 0 ? `tema/${i}` : '', tool_name: i % 3 === 0 ? 'mem_save' : '', created_at: minute(i),
  }));
  await push('proj-a', 'ana', {
    sessions: [{ id: 's1', project: 'proj-a', directory: '/work/a', started_at: minute(0) }, { id: 's2', project: 'proj-a', directory: '/work/b', started_at: minute(1) }],
    observations,
    prompts: Array.from({ length: 4 }, (_, i) => ({ sync_id: `prm-${i}`, session_id: 's1', content: `Pregunta ${i} sobre la base de datos`, project: 'proj-a', created_at: minute(20 + i) })),
  });
  await push('proj-a', 'bea', { sessions: [{ id: 's2', project: 'proj-a', directory: '/work/b', ended_at: minute(40), summary: 'Se cerró la sesión' }], observations: [], prompts: [] });
  await push('proj-b', 'ana', {
    sessions: [{ id: 's3', project: 'proj-b', directory: '/work/c', started_at: minute(5) }],
    observations: [{ sync_id: 'obs-b1', session_id: 's3', type: 'Decision', title: 'Otra decisión', content: 'x', scope: 'project', created_at: minute(30) }],
    prompts: [],
  });
  // Mutaciones: actualizar, borrar y añadir.
  const mutations = [
    { project: 'proj-a', entity: 'observation', entity_key: 'obs-01', op: 'upsert', payload: JSON.stringify({ sync_id: 'obs-01', session_id: 's2', type: 'bugfix', title: 'Hallazgo 1 corregido', content: 'nuevo contenido', scope: 'project', created_at: minute(1) }) },
    { project: 'proj-a', entity: 'prompt', entity_key: 'prm-3', op: 'delete', payload: JSON.stringify({ sync_id: 'prm-3', session_id: 's1', deleted: true }) },
    { project: 'proj-a', entity: 'observation', entity_key: 'obs-07', op: 'delete', payload: JSON.stringify({ sync_id: 'obs-07', session_id: 's2', deleted: true }) },
    { project: 'proj-a', entity: 'session', entity_key: 's1', op: 'upsert', payload: JSON.stringify({ id: 's1', project: 'proj-a', summary: 'Resumen de s1' }) },
  ];
  for (const port of [pair.refPort, pair.odinPort]) {
    const r = await send(port, 'POST', '/sync/mutations/push', { headers: bearer, body: { entries: mutations } });
    assert.equal(r.status, 200, r.text);
  }
}

const PAGES = [
  ['/dashboard/stats', true],
  ['/dashboard/projects/list', true],
  ['/dashboard/projects/list?q=b', true],
  ['/dashboard/projects/list?q=zzz', true],
  ['/dashboard/contributors/list', true],
  ['/dashboard/contributors/list?q=an', true],
  ['/dashboard/browser/observations', true],
  ['/dashboard/browser/observations?page=2', true],
  ['/dashboard/browser/observations?page=9', true],
  ['/dashboard/browser/observations?pageSize=25', true],
  ['/dashboard/browser/observations?project=proj-a&type=bugfix', true],
  ['/dashboard/browser/observations?type=DECISION', true],
  ['/dashboard/browser/observations?q=corregido', true],
  ['/dashboard/browser/observations?project=nada', true],
  ['/dashboard/browser/sessions', true],
  ['/dashboard/browser/sessions?project=proj-a&q=s1', true],
  ['/dashboard/browser/sessions/s2', true],
  ['/dashboard/browser/prompts', true],
  ['/dashboard/browser/prompts?q=PREGUNTA 1', true],
  ['/dashboard/projects/proj-a/observations', true],
  ['/dashboard/projects/proj-a/observations?type=note', true],
  ['/dashboard/projects/proj-a/sessions', true],
  ['/dashboard/projects/proj-a/prompts', true],
  ['/dashboard/projects/proj-b/observations', true],
  ['/dashboard/projects/proj-a', false],
  ['/dashboard/projects/proj-zzz', false],
  ['/dashboard/sessions/proj-a/s1', false],
  ['/dashboard/sessions/proj-a/s2', false],
  ['/dashboard/sessions/proj-a/zzz', false],
  ['/dashboard/observations/proj-a/s1/obs-00', false],
  ['/dashboard/observations/proj-a/s2/obs-01', false],
  ['/dashboard/observations/proj-a/s2/obs-07', false],
  ['/dashboard/observations/proj-a/s1/obs-02', false],
  ['/dashboard/prompts/proj-a/s1/prm-0', false],
  ['/dashboard/prompts/proj-a/s1/prm-3', false],
  ['/dashboard/contributors/ana', false],
  ['/dashboard/contributors/BEA', false],
  ['/dashboard/contributors/nadie', false],
  ['/dashboard/activity', false],
  ['/dashboard/activity?project=proj-b', false],
];

test('panel: las mismas páginas muestran los mismos datos', { skip }, async () => {
  const pair = await cloudPair({ allowed: '*' });
  await seedBoth(pair);
  const [refCookie, odinCookie] = await Promise.all([login(pair.refPort), login(pair.odinPort)]);
  for (const [path, htmx] of PAGES) {
    const [ref, odin] = await Promise.all([page(pair.refPort, refCookie, path, htmx), page(pair.odinPort, odinCookie, path, htmx)]);
    assert.equal(odin.status, ref.status, `${path}: estado`);
    const [r, o] = [ref.texts.map(mask), odin.texts.map(mask)];
    assert.deepEqual(o, r, `${path}: datos`);
    if (!/zzz|nada|nadie|s2\/obs-07|prm-3/.test(path)) assert.ok(r.length > 0, `${path}: la página no puede estar vacía`);
  }
});

const ADMIN = 'conformance-admin-token-456';
const loginAs = async (port, token) => {
  const response = await fetch(`http://127.0.0.1:${port}/dashboard/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${token}` });
  assert.equal(response.status, 303);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
};
const maskTimes = (text) => text.replace(/\d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}/g, '<T>');

test('panel: administración, controles de sincronización y registro de rechazos', { skip }, async () => {
  const pair = await cloudPair({ allowed: '*', admin: ADMIN });
  await seedBoth(pair);
  const [refCookie, odinCookie] = await Promise.all([loginAs(pair.refPort, ADMIN), loginAs(pair.odinPort, ADMIN)]);
  const postForm = async (port, cookie, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    return { status: response.status, location: response.headers.get('location'), text: await response.text() };
  };
  const both = async (path, body) => {
    const [ref, odin] = await Promise.all([postForm(pair.refPort, refCookie, path, body), postForm(pair.odinPort, odinCookie, path, body)]);
    assert.deepEqual([odin.status, odin.location], [ref.status, ref.location], `POST ${path}`);
    return [ref, odin];
  };
  // Pausar un proyecto desde el panel y comprobar que el servidor rechaza la subida.
  assert.equal((await both('/dashboard/admin/projects/proj-a/sync', 'enabled=maybe'))[0].status, 400);
  await both('/dashboard/admin/projects/proj-a/sync', 'enabled=false&reason=mantenimiento+programado');
  for (const port of [pair.refPort, pair.odinPort]) {
    const rejected = await send(port, 'POST', '/sync/push', { headers: bearer, body: { project: 'proj-a', created_by: 'ana', data: { sessions: [{ id: 's9', project: 'proj-a', directory: '/w', started_at: minute(50) }], observations: [], prompts: [] } } });
    assert.equal(rejected.status, 409);
  }
  const pages = [
    '/dashboard/admin', '/dashboard/admin/health', '/dashboard/admin/projects', '/dashboard/admin/projects/proj-a/sync/form', '/dashboard/projects/proj-a', '/dashboard/projects/list',
    '/dashboard/admin/audit-log/list', '/dashboard/admin/audit-log/list?contributor=ana', '/dashboard/admin/audit-log/list?outcome=nada', '/dashboard/admin/audit-log/list?from=ayer',
    '/dashboard/admin/users/list', '/dashboard/admin/users/1',
  ];
  for (const path of pages) {
    const [ref, odin] = await Promise.all([page(pair.refPort, refCookie, path, true), page(pair.odinPort, odinCookie, path, true)]);
    assert.equal(odin.status, ref.status, `${path}: estado`);
    assert.deepEqual(odin.texts.map((t) => maskTimes(mask(t))), ref.texts.map((t) => maskTimes(mask(t))), `${path}: datos`);
  }
  await both('/dashboard/admin/projects/proj-a/sync', 'enabled=true');
  const [ref, odin] = await Promise.all([page(pair.refPort, refCookie, '/dashboard/admin/projects', true), page(pair.odinPort, odinCookie, '/dashboard/admin/projects', true)]);
  assert.deepEqual(odin.texts.map((t) => maskTimes(mask(t))), ref.texts.map((t) => maskTimes(mask(t))));
  // Sin administración: el token de sincronización recibe 403 en las páginas de administración.
  const [refMember, odinMember] = await Promise.all([login(pair.refPort), login(pair.odinPort)]);
  for (const path of ['/dashboard/admin', '/dashboard/admin/users', '/dashboard/admin/audit-log/list']) {
    const [r, o] = await Promise.all([page(pair.refPort, refMember, path, true), page(pair.odinPort, odinMember, path, true)]);
    assert.equal(o.status, r.status, path);
  }
});
