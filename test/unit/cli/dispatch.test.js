import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { parseMcpArgs } from '../../../src/cli/commands/mcp.js';
import { resolveConfig } from '../../../src/cli/config.js';
import { run } from '../../../src/cli/index.js';
import { fsErrorText, padLeft, padRight, parseInt64, scanLeadingInt, truncate } from '../../../src/cli/runtime.js';
import { usageText } from '../../../src/cli/usage.js';
import { VERSION } from '../../../src/version/index.js';
import { Store } from '../../../src/store/index.js';
import { cliWorld } from './helpers.js';

test('version se imprime sin abrir el almacén', async (t) => {
  const w = cliWorld(t);
  for (const flag of ['version', '--version', '-v']) {
    const r = await w.odin([flag]);
    assert.deepEqual(r, { code: 0, out: `odin ${VERSION}\n`, err: '' });
  }
  assert.equal(existsSync(w.dataDir), false);
});

test('help y la ausencia de comando muestran el uso', async (t) => {
  const w = cliWorld(t);
  for (const args of [['help'], ['--help'], ['-h']]) {
    const r = await w.odin(args);
    assert.equal(r.code, 0);
    assert.equal(r.out, usageText());
    assert.equal(r.err, '');
  }
  const none = await w.odin([]);
  assert.equal(none.code, 1);
  assert.equal(none.out, usageText());
  assert.equal(existsSync(w.dataDir), false);
});

test('el uso describe la identidad y los perfiles reales', () => {
  const text = usageText();
  assert.ok(text.startsWith(`odin v${VERSION} — Persistent memory for GitHub Copilot\n\nUsage:\n  odin <command> [arguments]\n`));
  assert.ok(text.includes('Profiles: agent (23 tools), admin (6 tools), all (default, 27)'));
  assert.ok(text.includes('ODIN_DATA_DIR'));
  assert.ok(text.includes('"odin-memory"'));
  assert.doesNotMatch(text, /7437/);
});

test('un comando desconocido falla con el uso en la salida estándar', async (t) => {
  const w = cliWorld(t);
  for (const name of ['nada', 'toString', '__proto__', 'constructor']) {
    const r = await w.odin([name]);
    assert.equal(r.code, 1, name);
    assert.equal(r.err, `unknown command: ${name}\n\n`);
    assert.equal(r.out, usageText());
  }
  assert.equal(existsSync(w.dataDir), false);
});

test('los comandos no distinguen mayúsculas solo para version y help', async (t) => {
  const w = cliWorld(t);
  assert.equal((await w.odin(['VERSION'])).out, `odin ${VERSION}\n`);
  assert.equal((await w.odin(['Help'])).code, 0);
  assert.equal((await w.odin(['STATS'])).code, 1);
});

test('la configuración usa ODIN_DATA_DIR o el directorio personal', () => {
  assert.deepEqual(resolveConfig({ ODIN_DATA_DIR: '/datos' }, () => '/home/u'), { dataDir: '/datos' });
  assert.deepEqual(resolveConfig({}, () => '/home/u'), { dataDir: '/home/u/.odin-memory' });
  assert.deepEqual(resolveConfig({ ODIN_DATA_DIR: '  \t ' }, () => '/home/u'), { dataDir: '/home/u/.odin-memory' });
  assert.deepEqual(resolveConfig({ ODIN_DATA_DIR: ' /con espacios ' }, () => '/home/u'), { dataDir: ' /con espacios ' });
});

test('un directorio de datos relativo se rechaza', async (t) => {
  const w = cliWorld(t, { env: { ODIN_DATA_DIR: 'relativo' } });
  const r = await w.odin(['stats']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^odin: odin-memory: data directory must be an absolute path/);
});

test('parseMcpArgs interpreta --tools y --project en todas sus formas', () => {
  assert.deepEqual(parseMcpArgs([], ''), { toolsFilter: '', defaultProject: '' });
  assert.deepEqual(parseMcpArgs(['--tools=agent'], 'env'), { toolsFilter: 'agent', defaultProject: 'env' });
  assert.deepEqual(parseMcpArgs(['--tools', 'agent,admin', '--project', 'p'], 'env'), { toolsFilter: 'agent,admin', defaultProject: 'p' });
  assert.deepEqual(parseMcpArgs(['--project=  q  '], ''), { toolsFilter: '', defaultProject: 'q' });
  assert.deepEqual(parseMcpArgs(['--tools'], ''), { toolsFilter: '', defaultProject: '' }, '--tools sin valor se ignora');
  assert.deepEqual(parseMcpArgs(['--otro', 'x'], 'e'), { toolsFilter: '', defaultProject: 'e' });
  assert.throws(() => parseMcpArgs(['--project'], ''), /--project requires a value/);
  assert.throws(() => parseMcpArgs(['--project='], ''), /--project requires a value/);
  assert.throws(() => parseMcpArgs(['--project', '   '], ''), /--project requires a value/);
});

test('mcp con un valor de --project vacío falla antes de abrir el almacén', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['mcp', '--project']);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'odin: --project requires a value\n');
  assert.equal(existsSync(w.dataDir), false);
});

test('mcp atiende el protocolo por stdio con el perfil y el proyecto indicados', async (t) => {
  const w = cliWorld(t);
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk; });
  let out = '';
  let err = '';
  const running = run(['mcp', '--tools=agent', '--project', 'fijo'], {
    env: w.env,
    cwd: () => w.repoDir,
    out: (text) => { out += text; },
    err: (text) => { err += text; },
    home: () => w.root,
    openStore: (config) => Store.open({ ...config, log: () => {} }),
    mcp: { input, output, processRef: new EventEmitter(), graceMs: 1000, log: () => {} },
  });
  const send = (message) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'prueba', version: '0' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list', params: {} });
  send({ id: 3, method: 'tools/call', params: { name: 'mem_current_project', arguments: {} } });
  input.end();
  assert.equal(await running, 0);
  const replies = written.trim().split('\n').map((line) => JSON.parse(line));
  const byId = new Map(replies.map((reply) => [reply.id, reply]));
  assert.equal(byId.get(1).result.serverInfo.name, 'odin-memory');
  assert.equal(byId.get(1).result.serverInfo.version, VERSION);
  const names = byId.get(2).result.tools.map((tool) => tool.name);
  assert.equal(names.length, 22); // el perfil declara 23; mem_doctor se registra con el diagnóstico
  assert.ok(names.includes('mem_save') && !names.includes('mem_delete'));
  assert.equal(JSON.parse(byId.get(3).result.content[0].text).project, 'fijo');
  assert.equal(out, '');
  assert.equal(err, '');
});

test('mcp toma el proyecto de ODIN_PROJECT cuando no hay --project', async (t) => {
  const w = cliWorld(t, { env: { ODIN_PROJECT: 'del-entorno' } });
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk; });
  const running = run(['mcp'], {
    env: w.env, cwd: () => w.repoDir, out: () => {}, err: () => {}, home: () => w.root,
    openStore: (config) => Store.open({ ...config, log: () => {} }),
    mcp: { input, output, processRef: new EventEmitter(), graceMs: 1000, log: () => {} },
  });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p', version: '0' } } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mem_current_project', arguments: {} } })}\n`);
  input.end();
  await running;
  const reply = written.trim().split('\n').map((line) => JSON.parse(line)).find((r) => r.id === 2);
  assert.equal(JSON.parse(reply.result.content[0].text).project, 'del-entorno');
});

test('un fallo al abrir el almacén se informa como error fatal', async () => {
  let err = '';
  const code = await run(['stats'], {
    env: { ODIN_DATA_DIR: '/x' }, cwd: () => '/', out: () => {}, err: (text) => { err += text; }, home: () => '/',
    openStore: () => { throw new Error('no se puede abrir'); },
  });
  assert.equal(code, 1);
  assert.equal(err, 'odin: no se puede abrir\n');
});

test('utilidades de formato y análisis numérico', () => {
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate('abcd', 3), 'abc...');
  assert.equal(truncate('ñandú', 3), 'ñan...');
  assert.equal(truncate('😀😀😀', 2), '😀😀...');
  assert.equal(padRight('ab', 4), 'ab  ');
  assert.equal(padRight('ñandú', 3), 'ñandú');
  assert.equal(padRight('ñ', 3), 'ñ  ');
  assert.equal(padLeft(7, 3), '  7');
  assert.equal(padLeft(1234, 3), '1234');
  assert.equal(parseInt64('42'), 42);
  assert.equal(parseInt64('-7'), -7);
  assert.equal(parseInt64('+3'), 3);
  assert.equal(parseInt64('9223372036854775807'), 9223372036854775807);
  assert.equal(parseInt64('9223372036854775808'), null);
  assert.equal(parseInt64('1.5'), null);
  assert.equal(parseInt64(''), null);
  assert.equal(parseInt64('12x'), null);
  assert.equal(parseInt64(' 1'), null);
  assert.equal(scanLeadingInt('3abc'), 3);
  assert.equal(scanLeadingInt('abc'), null);
  assert.equal(scanLeadingInt('-2'), -2);
  assert.equal(fsErrorText({ code: 'ENOENT', syscall: 'open' }, '/x'), 'open /x: no such file or directory');
  assert.equal(fsErrorText({ code: 'EACCES', syscall: 'open' }, '/x'), 'open /x: permission denied');
  assert.equal(fsErrorText({ code: 'EISDIR', syscall: 'read' }, '/x'), 'read /x: is a directory');
  assert.equal(fsErrorText({ code: 'EOTHER', message: 'otro mensaje' }, '/x'), 'otro mensaje');
});
