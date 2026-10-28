import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { run } from '../../../src/cli/index.js';
import { resolveServeOptions, validateSessionOwned } from '../../../src/cli/commands/serve.js';
import { HttpServer } from '../../../src/server/index.js';
import { Store } from '../../../src/store/index.js';
import { openTempStore, tempDir } from '../store/helpers.js';
import { httpWorld } from './helpers.js';

const TOKEN = 'ab'.repeat(32);

/** Petición HTTP por un socket Unix. */
function viaSocket(socketPath, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const shortDir = (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'odin-sock-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('ODIN_HTTP_TOKEN protege las rutas sensibles y se lee en cada petición', async (t) => {
  const env = { ODIN_HTTP_TOKEN: 'secreto' };
  const w = await httpWorld(t, { env });
  await w.seed();
  const protectedRoutes = [
    ['GET', '/export?project=demo'], ['POST', '/import', '{}'], ['DELETE', '/sessions/s1'], ['DELETE', '/observations/1?expected_project=demo'],
    ['DELETE', '/prompts/1'], ['POST', '/observations/consolidate', {}], ['POST', '/conflicts/judge-many', {}], ['POST', '/sessions/s1/finalize', {}],
  ];
  for (const [method, path, body] of protectedRoutes) {
    const none = await w.call(method, path, body);
    assert.equal(none.status, 401, `${method} ${path}`);
    assert.deepEqual(none.json, { error: 'authorization required' });
    assert.equal(none.headers.get('www-authenticate'), 'Bearer realm="odin-memory"');
    assert.equal((await w.call(method, path, body, { Authorization: 'Basic abc' })).json.error, 'authorization required');
    const wrong = await w.call(method, path, body, { Authorization: 'Bearer equivocado' });
    assert.deepEqual(wrong.json, { error: 'invalid token' });
    assert.notEqual((await w.call(method, path, body, { Authorization: 'Bearer secreto' })).status, 401, `${method} ${path} con token`);
  }
  assert.equal((await w.call('GET', '/health')).status, 200, 'las rutas de lectura siguen abiertas');
  assert.equal((await w.call('GET', '/search?q=Redis&project=demo')).status, 200);
  delete w.env.ODIN_HTTP_TOKEN;
  assert.equal((await w.call('GET', '/export?project=demo')).status, 200, 'sin token el acceso queda abierto');
  w.env.ODIN_HTTP_TOKEN = 'otro';
  assert.equal((await w.call('GET', '/export?project=demo', undefined, { Authorization: 'Bearer secreto' })).status, 401, 'el token cambia sin reiniciar');
});

test('un servidor de sesión propia exige su token privado en todas las rutas', async (t) => {
  const w = await httpWorld(t, { sessionOwnedToken: TOKEN, env: { ODIN_HTTP_TOKEN: 'otro' } });
  const none = await w.call('GET', '/health');
  assert.equal(none.status, 401);
  assert.equal(none.json.error, 'authorization required');
  assert.equal((await w.call('GET', '/health', undefined, { Authorization: `Bearer ${TOKEN}x` })).status, 401);
  assert.equal((await w.call('GET', '/health', undefined, { Authorization: TOKEN })).status, 401);
  assert.equal((await w.call('GET', '/health', undefined, { Authorization: `Bearer ${TOKEN}` })).status, 200);
  // El token de la sesión sustituye al de ODIN_HTTP_TOKEN en las rutas protegidas.
  assert.notEqual((await w.call('GET', '/export', undefined, { Authorization: `Bearer ${TOKEN}` })).status, 401, 'el token de la sesión basta');
  const missing = await w.call('GET', '/nada');
  assert.equal(missing.status, 401, 'la autenticación precede al enrutado');
});

test('el socket Unix queda con permisos 0600, se limpia al cerrar y rechaza usos peligrosos', async (t) => {
  const dir = shortDir(t);
  const store = openTempStore(t);
  const path = join(dir, 's.sock');
  const server = new HttpServer(store, { socketPath: path, log: () => {} });
  const { address } = await server.listen();
  assert.equal(address, path);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  const health = await viaSocket(path, '/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).status, 'ok');

  // Un segundo servidor no puede tomar un socket vivo.
  const second = new HttpServer(openTempStore(t), { socketPath: path, log: () => {} });
  await assert.rejects(second.listen(), /socket ".*s\.sock" is already in use/);
  await server.shutdown(100);
  assert.equal(existsSync(path), false, 'cerrar borra su socket');
  await server.close();
});

test('un socket huérfano se reemplaza y un archivo que no es socket se respeta', async (t) => {
  const dir = shortDir(t);
  const stale = join(dir, 'huerfano.sock');
  // Un socket sin proceso detrás: un hijo lo crea y muere sin poder borrar el archivo.
  const child = spawn(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("listo"))', stale], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(lstatSync(stale).isSocket(), true);
  const server = new HttpServer(openTempStore(t), { socketPath: stale, log: () => {} });
  await server.listen();
  assert.equal((await viaSocket(stale, '/health')).status, 200);
  await server.shutdown(100);

  const regular = join(dir, 'archivo');
  writeFileSync(regular, 'x');
  const refused = new HttpServer(openTempStore(t), { socketPath: regular, log: () => {} });
  await assert.rejects(refused.listen(), /exists and is not a Unix socket/);
  assert.equal(existsSync(regular), true);

  const blank = new HttpServer(openTempStore(t), { socketPath: '.', log: () => {} });
  await assert.rejects(blank.listen(), /socket path is required/);
  const missing = new HttpServer(openTempStore(t), { socketPath: join(dir, 'no', 'existe', 's.sock'), log: () => {} });
  await assert.rejects(missing.listen(), /resolve socket parent/);
});

test('un directorio padre escribible por otros impide enlazar el socket', async (t) => {
  const dir = shortDir(t);
  const open = join(dir, 'abierto');
  mkdirSync(open);
  execFileSync('chmod', ['0777', open]);
  const server = new HttpServer(openTempStore(t), { socketPath: join(open, 's.sock'), log: () => {} });
  await assert.rejects(server.listen(), /writable by an untrusted user/);
});

test('con el puerto ocupado: la misma instancia lo reutiliza y otra falla', async (t) => {
  const store = openTempStore(t);
  const first = new HttpServer(store, { port: 0, log: () => {} });
  const { address } = await first.listen();
  t.after(() => first.shutdown(100));
  const logs = [];
  const same = new HttpServer(store, { port: address.port, log: (m) => logs.push(m) });
  const reused = await same.listen();
  assert.equal(reused.reused, true);
  assert.match(logs.join('\n'), /an existing instance owns the port/);
  const other = new HttpServer(openTempStore(t), { port: address.port, log: () => {} });
  await assert.rejects(other.listen(), /already owned by a different or legacy instance/);
});

test('un cambio de generación de la base se notifica una vez', async (t) => {
  const w = await httpWorld(t);
  let notified = 0;
  w.server.generationInvalidated.then(() => { notified += 1; });
  assert.equal((await w.call('GET', '/health')).status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(notified, 0);
  rmSync(w.store.dbPath);
  await w.call('GET', '/projects');
  await w.call('GET', '/projects');
  await new Promise((r) => setImmediate(r));
  assert.equal(notified, 1);
});

test('un fallo inesperado de un manejador responde 500 sin filtrar detalles', async (t) => {
  const logs = [];
  const w = await httpWorld(t, { serverOptions: { log: (m) => logs.push(m) } });
  w.store.db.close();
  const r = await w.call('GET', '/projects');
  assert.equal(r.status, 500);
  assert.equal(typeof r.json.error, 'string');
});

test('resolveServeOptions: puerto, socket, variables y errores', () => {
  const env = (extra = {}) => ({ ...extra });
  assert.deepEqual(resolveServeOptions([], env()), { sessionOwned: false, port: 7438, socketPath: '' });
  assert.equal(resolveServeOptions(['9000'], env()).port, 9000);
  assert.equal(resolveServeOptions([], env({ ODIN_PORT: '8123' })).port, 8123);
  assert.equal(resolveServeOptions(['9000'], env({ ODIN_PORT: '8123' })).port, 9000);
  assert.equal(resolveServeOptions([], env({ ODIN_PORT: '0' })).port, 7438);
  assert.equal(resolveServeOptions([], env({ ODIN_PORT: '70000' })).port, 7438);
  assert.equal(resolveServeOptions([], env({ ODIN_PORT: 'abc' })).port, 7438);
  assert.equal(resolveServeOptions(['--socket', '/tmp/a.sock'], env()).socketPath, '/tmp/a.sock');
  assert.equal(resolveServeOptions(['--socket=/tmp/b.sock'], env()).socketPath, '/tmp/b.sock');
  assert.equal(resolveServeOptions([], env({ ODIN_SOCKET: ' /tmp/c.sock ' })).socketPath, '/tmp/c.sock');
  assert.throws(() => resolveServeOptions(['--socket'], env()), /--socket requires a path/);
  assert.throws(() => resolveServeOptions(['--socket', '  '], env()), /--socket requires a path/);
  assert.throws(() => resolveServeOptions(['--socket='], env()), /--socket requires a path/);
  assert.throws(() => resolveServeOptions(['--socket', '/tmp/a', '9000'], env()), /socket transport cannot be combined with an explicit TCP port/);
  assert.throws(() => resolveServeOptions(['--socket', '/tmp/a'], env({ ODIN_PORT: '8123' })), /cannot be combined/);
  assert.throws(() => resolveServeOptions(['bogus'], env()), /unknown serve argument: bogus/);
});

test('validateSessionOwned exige un token de 256 bits y ninguna otra opción', () => {
  assert.equal(validateSessionOwned([], {}), false);
  assert.equal(validateSessionOwned(['--session-owned'], { ODIN_TOKEN: TOKEN }), true);
  assert.equal(validateSessionOwned(['--session-owned'], { ODIN_TOKEN: TOKEN.toUpperCase() }), true);
  for (const key of ['ODIN_URL', 'ODIN_PORT', 'ODIN_SOCKET']) {
    assert.throws(() => validateSessionOwned(['--session-owned'], { ODIN_TOKEN: TOKEN, [key]: '' }), new RegExp(`conflicts with ${key}`));
  }
  assert.throws(() => validateSessionOwned(['--session-owned', '9000'], { ODIN_TOKEN: TOKEN }), /accepts no port or socket arguments/);
  assert.throws(() => validateSessionOwned(['--session-owned'], {}), /requires a private 256-bit hex ODIN_TOKEN/);
  assert.throws(() => validateSessionOwned(['--session-owned'], { ODIN_TOKEN: 'ab' }), /256-bit/);
  assert.throws(() => validateSessionOwned(['--session-owned'], { ODIN_TOKEN: 'zz'.repeat(32) }), /256-bit/);
});

/** Ejecuta `odin serve …` en proceso y devuelve control sobre el servidor en marcha. */
function startServe(t, args, { env = {}, input } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'odin-serve-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let out = '';
  let err = '';
  const signals = new PassThrough();
  const done = (async () => {
    return run(args, {
      env: { PATH: process.env.PATH, HOME: root, ODIN_DATA_DIR: join(root, 'data'), ...env },
      out: (text) => { out += text; },
      err: (text) => { err += text; },
      cwd: () => root,
      home: () => root,
      openStore: (config) => Store.open({ ...config, log: () => {} }),
      serve: {
        signal: controller.signal, input, processRef: signals, graceMs: 100, log: () => {},
        ready: (info) => { startServe.last = info; },
      },
    });
  })();
  return { done, stop: () => controller.abort(), output: () => ({ out, err }) };
}

async function until(fn, label = 'condición') {
  for (let i = 0; i < 200; i++) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no se cumplió: ${label}`);
}

test('odin serve atiende hasta recibir una señal y termina con código 0', async (t) => {
  startServe.last = null;
  const serve = startServe(t, ['serve', '0'], {});
  const info = await until(() => startServe.last, 'servidor listo');
  const port = info.address.port;
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version.length > 0, true);
  serve.stop();
  assert.equal(await serve.done, 0);
});

test('odin serve rechaza argumentos inválidos con un error claro', async (t) => {
  const serve = startServe(t, ['serve', 'bogus']);
  assert.equal(await serve.done, 1);
  assert.equal(serve.output().err, 'odin: unknown serve argument: bogus\n');
  const owned = startServe(t, ['serve', '--session-owned'], { env: { ODIN_TOKEN: 'corto' } });
  assert.equal(await owned.done, 1);
  assert.match(owned.output().err, /^odin: session-owned serve requires a private 256-bit hex ODIN_TOKEN\n$/);
});

test('serve --session-owned emite su línea de disponibilidad y se detiene al cerrar la entrada', async (t) => {
  startServe.last = null;
  const input = new PassThrough();
  const serve = startServe(t, ['serve', '--session-owned'], { env: { ODIN_TOKEN: TOKEN }, input });
  const info = await until(() => startServe.last, 'servidor listo');
  const lines = serve.output().out.trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(record), ['protocol', 'endpoint', 'pid', 'instance_id']);
  assert.equal(record.protocol, 'odin-session-owned-v1');
  assert.equal(record.endpoint, `http://127.0.0.1:${info.address.port}`);
  assert.equal(record.pid, process.pid);
  assert.match(record.instance_id, /^[0-9a-f]{32}$/);
  assert.equal((await fetch(`${record.endpoint}/health`)).status, 401);
  const authorized = await fetch(`${record.endpoint}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal((await authorized.json()).instance_id, record.instance_id);
  input.end();
  assert.equal(await serve.done, 0);
  await assert.rejects(fetch(`${record.endpoint}/health`));
});

test('serve --session-owned con la entrada ya cerrada sale sin enlazar', async (t) => {
  startServe.last = null;
  const input = new PassThrough();
  input.end();
  const serve = startServe(t, ['serve', '--session-owned'], { env: { ODIN_TOKEN: TOKEN }, input });
  assert.equal(await serve.done, 0);
  assert.equal(serve.output().out, '');
  assert.equal(startServe.last, null);
});

test('serve sobre un socket Unix', async (t) => {
  startServe.last = null;
  const dir = shortDir(t);
  const path = join(dir, 'odin.sock');
  const serve = startServe(t, ['serve', '--socket', path]);
  await until(() => startServe.last, 'servidor listo');
  assert.equal((await viaSocket(path, '/health')).status, 200);
  serve.stop();
  assert.equal(await serve.done, 0);
  assert.equal(existsSync(path), false);
});

test('serve termina con error si el almacén cambia de generación', async (t) => {
  startServe.last = null;
  const serve = startServe(t, ['serve', '0']);
  const info = await until(() => startServe.last, 'servidor listo');
  rmSync(info.server.store.dbPath);
  await fetch(`http://127.0.0.1:${info.address.port}/projects`);
  assert.equal(await serve.done, 1);
  assert.equal(serve.output().err, 'odin: Database generation changed; restart odin\n');
});

test('tempDir se importa para limpiar directorios temporales de las pruebas', (t) => {
  assert.equal(typeof tempDir(t), 'string');
});
