import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLOUD_HEALTH_PATH, PING_STATUS, listCloudEnrollment, loadCloudSettings, loadCloudStatus, pingCloudServer, saveCloudServerUrl, toggleCloudEnrollment } from '../../../src/tui/cloud.js';
import { executeCommand } from '../../../src/tui/commands.js';
import { loadCloudConfig, saveCloudConfig } from '../../../src/cloud/config.js';
import { addObservation, createSession, enrollProject, isProjectEnrolled } from '../../../src/store/index.js';
import { openTempStore } from '../store/helpers.js';

/** Un puerto en el que no escucha nadie. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Servidor de pruebas que responde con `status` y registra las cabeceras recibidas. */
async function healthServer(t, status) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, authorization: req.headers.authorization });
    res.writeHead(status).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test('el ping distingue 2xx, 401 y el resto de respuestas', async (t) => {
  assert.equal(CLOUD_HEALTH_PATH, '/health');
  const ok = await healthServer(t, 200);
  assert.deepEqual(await pingCloudServer(ok.url, '', fetch), { status: PING_STATUS.reachable, error: null });
  assert.deepEqual(await pingCloudServer(`${ok.url}///`, 'tok', fetch), { status: PING_STATUS.reachable, error: null });
  assert.deepEqual(ok.seen.map((r) => [r.method, r.url, r.authorization]), [['GET', '/health', undefined], ['GET', '/health', 'Bearer tok']]);
  const denied = await healthServer(t, 401);
  assert.deepEqual(await pingCloudServer(denied.url, 'x', fetch), { status: PING_STATUS.unauthorized, error: null });
  const bad = await healthServer(t, 500);
  const res = await pingCloudServer(bad.url, '', fetch);
  assert.deepEqual([res.status, res.error.message], [PING_STATUS.unreachable, 'unexpected status 500']);
  const redirect = await healthServer(t, 300);
  assert.equal((await pingCloudServer(redirect.url, '', fetch)).error.message, 'unexpected status 300');
  const created = await healthServer(t, 299);
  assert.equal((await pingCloudServer(created.url, '', fetch)).status, PING_STATUS.reachable);
  const low = await healthServer(t, 199);
  assert.equal((await pingCloudServer(low.url, '', fetch)).status, PING_STATUS.unreachable);
});

test('el ping valida la URL y informa de los fallos de red', async (t) => {
  const invalid = await pingCloudServer('ftp://x', '', fetch);
  assert.deepEqual([invalid.status, invalid.error.message], [PING_STATUS.unreachable, 'scheme must be http or https']);
  assert.equal((await pingCloudServer('', '', fetch)).error.message, 'server URL is required');
  const refused = await pingCloudServer(`http://127.0.0.1:${await freePort()}`, '', fetch);
  assert.equal(refused.status, PING_STATUS.unreachable);
  assert.match(refused.error.message, /ECONNREFUSED|refused/);
  const thrown = await pingCloudServer('http://x.test', '', async () => { throw new Error('boom'); });
  assert.equal(thrown.error.message, 'boom');
  const text = await pingCloudServer('http://x.test', '', async () => { throw 'plano'; });
  assert.equal(text.error.message, 'plano');
});

test('la configuración mostrada aplica el reemplazo del entorno y dice de dónde sale el token', (t) => {
  const store = openTempStore(t);
  assert.deepEqual(loadCloudSettings(store.dataDir, {}), { serverUrl: '', tokenSource: 'not set' });
  saveCloudConfig(store.dataDir, { server_url: 'http://guardado', token: 'abc' });
  assert.deepEqual(loadCloudSettings(store.dataDir, {}), { serverUrl: 'http://guardado', tokenSource: 'read from cloud.json' });
  assert.deepEqual(loadCloudSettings(store.dataDir, { ODIN_CLOUD_SERVER: ' http://entorno ', ODIN_CLOUD_TOKEN: 't' }), { serverUrl: 'http://entorno', tokenSource: 'set via ODIN_CLOUD_TOKEN' });
});

test('guardar la URL conserva el token y no toca otros campos', (t) => {
  const store = openTempStore(t);
  saveCloudConfig(store.dataDir, { server_url: 'http://a', token: 'secreto' });
  saveCloudServerUrl(store.dataDir, 'http://b');
  assert.deepEqual(loadCloudConfig(store.dataDir), { server_url: 'http://b', token: 'secreto' });
  const fresh = openTempStore(t);
  saveCloudServerUrl(fresh.dataDir, 'http://c');
  assert.deepEqual(loadCloudConfig(fresh.dataDir), { server_url: 'http://c', token: '' });
  writeFileSync(join(fresh.dataDir, 'cloud.json'), '{no es json');
  assert.throws(() => saveCloudServerUrl(fresh.dataDir, 'http://d'), SyntaxError);
  assert.equal(readFileSync(join(fresh.dataDir, 'cloud.json'), 'utf8'), '{no es json', 'un archivo ilegible no se pisa');
});

test('el estado resume la URL, la última sincronización, lo pendiente y el último error', (t) => {
  const store = openTempStore(t);
  assert.deepEqual(loadCloudStatus(store, {}), { serverUrl: '', lastSync: '', pendingCount: 0, lastError: '' });
  saveCloudConfig(store.dataDir, { server_url: 'http://guardado', token: '' });
  createSession(store, 's1', 'demo', '/x');
  enrollProject(store, 'demo');
  addObservation(store, { session_id: 's1', type: 'decision', title: 'T', content: 'C', project: 'demo' });
  store.db.run("INSERT INTO sync_state (target_key, lifecycle, last_success_at, last_error, updated_at) VALUES ('cloud:demo', 'degraded', '2026-02-03 04:05:06', 'fallo', '2026-02-03 04:05:07') ON CONFLICT(target_key) DO UPDATE SET last_success_at = excluded.last_success_at, last_error = excluded.last_error, updated_at = excluded.updated_at");
  store.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project) VALUES ('cloud:demo', 'observation', 'obs-1', 'upsert', '{}', 'local', 'demo')");
  assert.deepEqual(loadCloudStatus(store, { ODIN_CLOUD_SERVER: 'http://entorno' }), { serverUrl: 'http://entorno', lastSync: '2026-02-03 04:05:06', pendingCount: 1, lastError: 'fallo' });
});

test('la lista de inscripción une todas las fuentes, normaliza y ordena', (t) => {
  const store = openTempStore(t);
  assert.deepEqual(listCloudEnrollment(store), []);
  createSession(store, 's1', 'Zeta', '/x');
  createSession(store, 's2', 'alfa', '/y');
  addObservation(store, { session_id: 's1', type: 'decision', title: 'T', content: 'C', project: 'Zeta' });
  store.db.run("INSERT INTO user_prompts (session_id, content, project) VALUES ('s2', 'hola', 'Prompts')");
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('soloinscrito')");
  store.db.run("INSERT INTO sessions (id, project, directory) VALUES ('s3', '   ', '/z')");
  assert.deepEqual(listCloudEnrollment(store), [
    { project: 'alfa', enrolled: false },
    { project: 'prompts', enrolled: false },
    { project: 'soloinscrito', enrolled: true },
    { project: 'zeta', enrolled: false },
  ]);
});

test('una observación borrada no aporta su proyecto', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  const { id } = addObservation(store, { session_id: 's1', type: 'decision', title: 'T', content: 'C', project: 'borrado' });
  store.db.run("UPDATE observations SET deleted_at = '2026-01-01 00:00:00' WHERE id = ?", id);
  assert.deepEqual(listCloudEnrollment(store).map((p) => p.project), ['demo']);
});

test('alternar la inscripción inscribe y desinscribe', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  toggleCloudEnrollment(store, { project: 'demo', enrolled: false });
  assert.equal(isProjectEnrolled(store, 'demo'), true);
  assert.deepEqual(listCloudEnrollment(store), [{ project: 'demo', enrolled: true }]);
  toggleCloudEnrollment(store, { project: 'demo', enrolled: true });
  assert.equal(isProjectEnrolled(store, 'demo'), false);
});

test('los comandos de la nube devuelven su mensaje o el error dentro de él', async (t) => {
  const store = openTempStore(t);
  const server = await healthServer(t, 200);
  const ctx = { store, env: {}, fetch };
  createSession(store, 's1', 'demo', '/x');
  assert.deepEqual(executeCommand({ type: 'load-cloud-config', generation: 3 }, ctx), { type: 'cloud-config-loaded', generation: 3, serverUrl: '', tokenSource: 'not set' });
  assert.deepEqual(executeCommand({ type: 'load-cloud-status', generation: 4 }, ctx), { type: 'cloud-status-loaded', generation: 4, serverUrl: '', lastSync: '', pendingCount: 0, lastError: '' });
  assert.deepEqual(executeCommand({ type: 'load-cloud-enrollment' }, ctx), { type: 'cloud-enrollment-loaded', items: [{ project: 'demo', enrolled: false }] });
  assert.deepEqual(executeCommand({ type: 'toggle-cloud-enrollment', item: { project: 'demo', enrolled: false } }, ctx), { type: 'cloud-enrollment-toggled' });
  assert.equal(isProjectEnrolled(store, 'demo'), true);
  assert.deepEqual(executeCommand({ type: 'save-cloud-url', serverUrl: server.url }, ctx), { type: 'cloud-url-saved' });
  assert.equal(loadCloudConfig(store.dataDir).server_url, server.url);
  const ping = await executeCommand({ type: 'ping-cloud', origin: 'config', generation: 9, serverUrl: server.url }, { ...ctx, env: { ODIN_CLOUD_TOKEN: 'del-entorno' } });
  assert.deepEqual(ping, { type: 'cloud-ping', origin: 'config', generation: 9, serverUrl: server.url, status: 'reachable', error: null });
  assert.equal(server.seen.at(-1).authorization, 'Bearer del-entorno');
  writeFileSync(join(store.dataDir, 'cloud.json'), '{no es json');
  for (const [cmd, type, extra] of [['load-cloud-config', 'cloud-config-loaded', { generation: 5 }], ['load-cloud-status', 'cloud-status-loaded', { generation: 6 }], ['save-cloud-url', 'cloud-url-saved', {}]]) {
    const failed = executeCommand({ type: cmd, generation: extra.generation, serverUrl: 'http://x' }, ctx);
    assert.deepEqual([failed.type, failed.generation, failed.error instanceof SyntaxError], [type, extra.generation, true], cmd);
  }
  const unreadable = await executeCommand({ type: 'ping-cloud', origin: 'status', generation: 1, serverUrl: server.url }, { ...ctx, env: {} });
  assert.equal(unreadable.status, 'reachable', 'un cloud.json ilegible no impide el ping: el token queda vacío');
});
