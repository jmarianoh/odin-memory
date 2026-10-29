import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { KEYS, mountTui, plain } from './helpers.js';
import { SCREEN, initialState } from '../../../src/tui/model.js';
import { View } from '../../../src/tui/view.js';
import { loadCloudConfig, saveCloudConfig } from '../../../src/cloud/config.js';
import { addObservation, createSession, isProjectEnrolled } from '../../../src/store/index.js';
import { openTempStore, tempDir } from '../store/helpers.js';

async function healthServer(t, status = 200) {
  const server = createServer((req, res) => res.writeHead(status).end('{}'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function world(t, env = {}) {
  const store = openTempStore(t);
  const home = tempDir(t);
  const cwd = join(home, 'proyecto');
  mkdirSync(cwd);
  createSession(store, 's1', 'demo', '/x');
  createSession(store, 's2', 'otro', '/y');
  addObservation(store, { session_id: 's1', type: 'decision', title: 'T', content: 'C', project: 'demo' });
  const tui = mountTui({ store, version: '1.2.3', env, home: () => home, cwd: () => cwd, platform: 'darwin', checkLatest: async () => ({ status: '' }) });
  t.after(() => tui.unmount());
  return { tui, store };
}

/** Abre el menú de la nube desde el panel. */
async function openCloud(tui) {
  await tui.settle(100);
  await tui.press('j', 'j', 'j', 'j', KEYS.enter);
}

const type = async (tui, text) => { for (const ch of text) await tui.press(ch); };

test('el panel ofrece «Cloud sync settings» y abre su menú', async (t) => {
  const { tui } = world(t);
  await tui.settle(100);
  assert.ok(tui.frame().includes('Cloud sync settings'));
  await openCloud(tui);
  const frame = tui.frame();
  for (const text of ['Cloud sync settings', '▸ Configure server', 'View status', 'Enroll projects', 'Back', 'j/k navigate • enter select • esc/q back']) assert.ok(frame.includes(text), `falta «${text}»\n${frame}`);
  await tui.press('q');
  await tui.settle(80);
  assert.ok(tui.frame().includes('Actions') && tui.frame().includes('observations'), 'vuelve al panel');
});

test('configurar: probar la conexión sin guardar y guardar conservando el token', async (t) => {
  const url = await healthServer(t);
  const { tui, store } = world(t);
  saveCloudConfig(store.dataDir, { server_url: '', token: 'secreto' });
  await openCloud(tui);
  await tui.press(KEYS.enter);
  await tui.settle(80);
  let frame = tui.frame();
  for (const text of ['Configure cloud server', 'Server URL:', 'https://odin.example.com', 'Token source:', 'read from cloud.json', 'Set ODIN_CLOUD_TOKEN to override cloud.json.token', 'Test connection', 'Save server', 'Cancel', 'i edit URL']) {
    assert.ok(frame.includes(text), `falta «${text}»\n${frame}`);
  }
  await type(tui, url);
  assert.ok(tui.frame().includes(url));
  await tui.press(KEYS.enter);
  assert.ok(tui.frame().includes('▸ Test connection'), tui.frame());
  await tui.press(KEYS.enter);
  await tui.settle(200);
  frame = tui.frame();
  assert.ok(frame.includes('Connection: reachable'), frame);
  assert.equal(loadCloudConfig(store.dataDir).server_url, '', 'probar no guarda');
  await tui.press('j', KEYS.enter);
  await tui.settle(200);
  assert.deepEqual(loadCloudConfig(store.dataDir), { server_url: url, token: 'secreto' });
  assert.ok(tui.frame().includes('▸ Save server'));
});

test('configurar: una URL inválida y un servidor caído se muestran como error y no se guarda', async (t) => {
  const { tui, store } = world(t, { ODIN_CLOUD_TOKEN: 'x' });
  await openCloud(tui);
  await tui.press(KEYS.enter);
  await tui.settle(80);
  assert.ok(!tui.frame().includes('Set ODIN_CLOUD_TOKEN to override'), 'con el token del entorno no se sugiere');
  assert.ok(tui.frame().includes('set via ODIN_CLOUD_TOKEN'));
  await type(tui, 'ftp://x');
  await tui.press(KEYS.enter, KEYS.enter);
  assert.ok(tui.frame().includes('Error: scheme must be http or https'), tui.frame());
  await tui.press('i');
  await tui.press(...Array(7).fill(KEYS.backspace));
  await type(tui, 'http://127.0.0.1:9');
  await tui.press(KEYS.enter, 'j', KEYS.enter);
  await tui.settle(300);
  const frame = tui.frame();
  assert.ok(frame.includes('Connection: unreachable') && frame.includes('Error:'), frame);
  assert.equal(loadCloudConfig(store.dataDir).server_url, '');
  await tui.press(KEYS.esc);
  await tui.settle(60);
  assert.ok(tui.frame().includes('▸ Configure server'));
});

test('estado: URL, salud, sincronización, pendientes y error; r actualiza', async (t) => {
  const url = await healthServer(t, 401);
  const { tui, store } = world(t);
  saveCloudConfig(store.dataDir, { server_url: url, token: '' });
  store.db.run("INSERT INTO sync_state (target_key, lifecycle, last_success_at, last_error, updated_at) VALUES ('cloud:demo', 'degraded', '2026-02-03 04:05:06', 'fallo previo', '2026-02-03 04:05:07')");
  await openCloud(tui);
  await tui.press('j', KEYS.enter);
  await tui.settle(250);
  const frame = tui.frame().replace(/ +/g, ' ');
  for (const text of ['Cloud status', `Server URL: ${url}`, 'Connection health: unauthorized', 'Last successful sync: 2026-02-03 04:05:06', 'Pending mutations: 0', 'Last error: fallo previo', 'r refresh • esc/q back']) {
    assert.ok(frame.includes(text), `falta «${text}»\n${frame}`);
  }
  await tui.press('r');
  await tui.settle(250);
  assert.ok(tui.frame().replace(/ +/g, ' ').includes('Connection health: unauthorized'));
  await tui.press('q');
  await tui.settle(60);
  assert.ok(tui.frame().includes('▸ View status'));
});

test('estado sin servidor configurado', async (t) => {
  const { tui } = world(t);
  await openCloud(tui);
  await tui.press('j', KEYS.enter);
  await tui.settle(120);
  const frame = tui.frame().replace(/ +/g, ' ');
  for (const text of ['Server URL: not configured', 'Connection health: not checked', 'Last successful sync: never', 'Pending mutations: 0', 'Last error: none']) assert.ok(frame.includes(text), `falta «${text}»\n${frame}`);
});

test('inscripción: lista los proyectos y alterna con enter', async (t) => {
  const { tui, store } = world(t);
  await openCloud(tui);
  await tui.press('j', 'j', KEYS.enter);
  await tui.settle(120);
  let frame = tui.frame();
  for (const text of ['Enroll projects for cloud sync', '▸ [ ] demo', '  [ ] otro', 'enter toggle • r refresh']) assert.ok(frame.includes(text), `falta «${text}»\n${frame}`);
  await tui.press(KEYS.enter);
  await tui.settle(150);
  assert.equal(isProjectEnrolled(store, 'demo'), true);
  assert.ok(tui.frame().includes('▸ [x] demo'), tui.frame());
  await tui.press('j', ' ');
  await tui.settle(150);
  assert.equal(isProjectEnrolled(store, 'otro'), true);
  await tui.press('k', KEYS.enter);
  await tui.settle(150);
  assert.equal(isProjectEnrolled(store, 'demo'), false);
  frame = tui.frame();
  assert.ok(frame.includes('[ ] demo') && frame.includes('[x] otro'), frame);
  await tui.press('q');
  await tui.settle(60);
  assert.ok(tui.frame().includes('▸ Enroll projects'));
});

test('inscripción sin proyectos locales', async (t) => {
  const store = openTempStore(t);
  const home = tempDir(t);
  const tui = mountTui({ store, version: '1', env: {}, home: () => home, cwd: () => home, platform: 'darwin', checkLatest: async () => ({ status: '' }) });
  t.after(() => tui.unmount());
  await openCloud(tui);
  await tui.press('j', 'j', KEYS.enter);
  await tui.settle(120);
  assert.ok(tui.frame().includes('No local projects found.'), tui.frame());
});

/** Dibuja una vez la vista con un estado dado. */
function frameOf(state) {
  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.rows = 40;
  stdout.isTTY = true;
  const chunks = [];
  stdout.on('data', (chunk) => chunks.push(chunk.toString()));
  const instance = render(createElement(View, { state }), { stdout, debug: true, patchConsole: false });
  instance.unmount();
  return plain(chunks.join('\n'));
}

test('el error de la conexión tiene prioridad sobre el último error guardado en el estado', async (t) => {
  const down = createServer((req, res) => res.writeHead(500).end());
  await new Promise((resolve) => down.listen(0, '127.0.0.1', resolve));
  t.after(() => down.close());
  const { tui, store } = world(t);
  saveCloudConfig(store.dataDir, { server_url: `http://127.0.0.1:${down.address().port}`, token: '' });
  store.db.run("INSERT INTO sync_state (target_key, lifecycle, last_error, updated_at) VALUES ('cloud:demo', 'degraded', 'fallo previo', '2026-02-03 04:05:07')");
  await openCloud(tui);
  await tui.press('j', KEYS.enter);
  await tui.settle(250);
  const frame = tui.frame().replace(/ +/g, ' ');
  assert.ok(frame.includes('Connection health: unreachable') && frame.includes('Last error: unexpected status 500'), frame);
  assert.ok(!frame.includes('fallo previo'));
});

test('mientras carga la inscripción no se dice que no hay proyectos', () => {
  const base = { ...initialState({ version: '1' }), screen: SCREEN.cloudEnrollment, height: 40, width: 100 };
  assert.ok(frameOf({ ...base, cloudEnrollmentLoading: true }).includes('Loading projects...'));
  assert.ok(!frameOf({ ...base, cloudEnrollmentLoading: true }).includes('No local projects found.'));
  assert.ok(frameOf(base).includes('No local projects found.'));
  const withError = frameOf({ ...base, cloudEnrollmentError: 'sin base' });
  assert.ok(withError.includes('Error: sin base'), withError);
});
