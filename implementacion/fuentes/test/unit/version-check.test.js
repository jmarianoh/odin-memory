import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_STATUS, checkLatest, isNewer, isPlainRelease, normalizeVersion, shouldCheckForUpdates, updateCheckDisabled } from '../../src/version/check.js';
import { cliWorld } from './cli/helpers.js';

const URL_ENV = { ODIN_UPDATE_CHECK_URL: 'https://releases.invalid/latest' };
const reply = (status, body, statusText = '') => async () => ({ status, statusText, json: async () => (typeof body === 'function' ? body() : body) });

test('versiones: prefijo v, tres componentes sin ceros a la izquierda y comparación numérica', () => {
  assert.equal(normalizeVersion(' v1.2.3 '), '1.2.3');
  assert.equal(normalizeVersion(undefined), '');
  for (const ok of ['0.0.0', '1.2.3', '10.20.30', '1.0.100']) assert.equal(isPlainRelease(ok), true, ok);
  for (const bad of ['1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.x', '1.2.3-rc1', '', '1..3', '-1.2.3', '1.2.99999999999999999999']) assert.equal(isPlainRelease(bad), false, bad);
  assert.equal(isNewer('1.10.0', '1.9.9'), true);
  assert.equal(isNewer('1.2.3', '1.2.3'), false);
  assert.equal(isNewer('0.9.9', '1.0.0'), false);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
});

test('la comprobación se desactiva con la variable y no se hace sin URL', async () => {
  for (const value of ['1', 'true', 'YES', ' on ']) assert.equal(updateCheckDisabled({ ODIN_NO_UPDATE_CHECK: value }), true, value);
  for (const value of ['0', 'no', '', undefined]) assert.equal(updateCheckDisabled({ ODIN_NO_UPDATE_CHECK: value }), false, String(value));
  let calls = 0;
  const fetch = async () => { calls += 1; return { status: 200, json: async () => ({ tag_name: 'v9.9.9' }) }; };
  assert.deepEqual(await checkLatest('0.1.0', { env: {}, fetch }), { status: '' });
  assert.deepEqual(await checkLatest('0.1.0', { env: { ...URL_ENV, ODIN_NO_UPDATE_CHECK: '1' }, fetch }), { status: '' });
  assert.equal(calls, 0);
});

test('versión en ejecución desconocida, de desarrollo o con sufijo', async () => {
  const fetch = reply(200, { tag_name: 'v9.9.9' });
  const check = (current) => checkLatest(current, { env: URL_ENV, fetch });
  assert.deepEqual(await check(''), { status: 'check_failed', message: 'Could not check for updates: current version is unknown.' });
  assert.equal((await check('dev')).message, 'Could not check for updates: development builds do not map to a release version.');
  for (const current of ['1.2.3-rc1', '1.2', 'abc']) assert.equal((await check(current)).message, 'Could not check for updates: current version does not map to a plain release version.', current);
});

test('hay una versión nueva, la misma o una más antigua', async () => {
  const run = (current, tag) => checkLatest(current, { env: URL_ENV, fetch: reply(200, { tag_name: tag }) });
  assert.deepEqual(await run('0.19.0', 'v0.20.0'), {
    status: CHECK_STATUS.updateAvailable, message: 'Update available: 0.19.0 -> 0.20.0\nTo update:\n  npm install -g odin-memory@latest',
  });
  assert.deepEqual(await run('v0.19.0', '0.19.0'), { status: 'up_to_date' });
  assert.deepEqual(await run('0.19.0', 'v0.18.9'), { status: 'up_to_date' });
});

test('la petición lleva el token y acepta JSON', async () => {
  let seen;
  const fetch = async (url, init) => { seen = { url, headers: init.headers, hasSignal: init.signal instanceof AbortSignal }; return { status: 200, json: async () => ({ tag_name: 'v0.1.0' }) }; };
  await checkLatest('0.1.0', { env: { ...URL_ENV, ODIN_UPDATE_TOKEN: ' secreto ' }, fetch });
  assert.deepEqual(seen, { url: 'https://releases.invalid/latest', headers: { Accept: 'application/json', Authorization: 'Bearer secreto' }, hasSignal: true });
  await checkLatest('0.1.0', { env: URL_ENV, fetch });
  assert.deepEqual(seen.headers, { Accept: 'application/json' });
});

test('fallos de red, de estado y de formato', async () => {
  const env = URL_ENV;
  const message = async (fetch) => (await checkLatest('0.1.0', { env, fetch, timeoutMs: 50 })).message;
  assert.equal(await message(async () => { throw new Error('connect ECONNREFUSED'); }), 'Could not check for updates: connect ECONNREFUSED.');
  assert.equal(await message(async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); }), 'Could not check for updates: the release server took too long to respond.');
  assert.equal(await message((_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))), 'Could not check for updates: the release server took too long to respond.');
  assert.equal(await message(reply(500, {}, 'Internal Server Error')), 'Could not check for updates: the release server returned 500 Internal Server Error.');
  assert.equal(await message(reply(403, {}, 'Forbidden')), 'Could not check for updates: the release server returned 403 Forbidden. Set ODIN_UPDATE_TOKEN to authenticate.');
  assert.equal(await message(reply(401, {})), 'Could not check for updates: the release server returned 401. Set ODIN_UPDATE_TOKEN to authenticate.');
  assert.equal(await message(reply(200, () => { throw new Error('json'); })), 'Could not check for updates: could not read the release server response.');
  for (const body of [{}, { tag_name: 5 }, { tag_name: 'v1.2' }, { tag_name: 'latest' }, null]) {
    assert.equal(await message(reply(200, body)), 'Could not check for updates: the release server did not return a release version.', JSON.stringify(body));
  }
});

test('qué comandos comprueban si hay versión nueva', () => {
  assert.equal(shouldCheckForUpdates([]), false);
  for (const command of ['mcp', 'serve', 'protocol-mode', 'tui', 'doctor', 'version', '--version', '-v', 'help', '--help', '-h', 'init', 'hook', 'test', ' DOCTOR ']) assert.equal(shouldCheckForUpdates([command]), false, command);
  for (const command of ['search', 'sync', 'stats', 'projects', 'conflicts']) assert.equal(shouldCheckForUpdates([command]), true, command);
  assert.equal(shouldCheckForUpdates(['cloud']), true);
  assert.equal(shouldCheckForUpdates(['cloud', 'status']), true);
  assert.equal(shouldCheckForUpdates(['cloud', ' SERVE ']), false);
});

test('la CLI avisa por stderr, solo en los comandos que comprueban', async (t) => {
  const w = cliWorld(t);
  const calls = [];
  const checkForUpdates = async (current) => { calls.push(current); return { status: 'update_available', message: 'Update available: 0.1.0 -> 9.9.9\nTo update:\n  x' }; };
  const stats = await w.odin(['stats'], { overrides: { checkForUpdates } });
  assert.equal(stats.code, 0, stats.err);
  assert.ok(stats.err.startsWith('Update available: 0.1.0 -> 9.9.9\nTo update:\n  x\n\n'));
  assert.equal(calls.length, 1);
  const quiet = await w.odin(['doctor'], { overrides: { checkForUpdates } });
  assert.equal(quiet.err, '');
  assert.equal(calls.length, 1, 'doctor no comprueba');
  const upToDate = await w.odin(['stats'], { overrides: { checkForUpdates: async () => ({ status: 'up_to_date', message: 'no debe verse' }) } });
  assert.equal(upToDate.err, '');
  const silent = await w.odin(['stats'], { overrides: { checkForUpdates: async () => ({ status: '' }) } });
  assert.equal(silent.err, '');
});
