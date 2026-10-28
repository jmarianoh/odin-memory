import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NoProcessError, lookup, processStart, publish } from '../../../src/hostbind/index.js';
import { tempDir } from '../project/helpers.js';

/** Procesos simulados: pid → señal de arranque. */
function fake(starts) {
  return (pid) => {
    if (Object.hasOwn(starts, pid)) return starts[pid];
    throw new NoProcessError();
  };
}

test('publicar y consultar devuelve la sesión vinculada', (t) => {
  const dir = tempDir(t);
  const options = { processStart: fake({ 4242: 't1' }) };
  publish(dir, 4242, 'sess-a', options);
  assert.equal(lookup(dir, 4242, options), 'sess-a');
});

test('publicar de nuevo sustituye el vínculo (clear, resume, fork)', (t) => {
  const dir = tempDir(t);
  const options = { processStart: fake({ 4242: 't1' }) };
  for (const id of ['sess-a', 'sess-b']) publish(dir, 4242, id, options);
  assert.equal(lookup(dir, 4242, options), 'sess-b');
});

test('un PID reutilizado por otro proceso nunca coincide', (t) => {
  const dir = tempDir(t);
  const starts = { 4242: 't1' };
  const options = { processStart: fake(starts) };
  publish(dir, 4242, 'sess-a', options);
  starts[4242] = 't2';
  assert.equal(lookup(dir, 4242, options), null);
});

test('un vínculo ausente o corrupto no resuelve', (t) => {
  const dir = tempDir(t);
  const options = { processStart: fake({ 4242: 't1' }) };
  assert.equal(lookup(dir, 4242, options), null);
  mkdirSync(join(dir, 'host-sessions'), { recursive: true });
  writeFileSync(join(dir, 'host-sessions', '4242.json'), '{no es json');
  assert.equal(lookup(dir, 4242, options), null);
  writeFileSync(join(dir, 'host-sessions', '4242.json'), JSON.stringify({ pid: 99, start: 't1', session_id: 's' }));
  assert.equal(lookup(dir, 4242, options), null); // el pid del archivo no coincide
  writeFileSync(join(dir, 'host-sessions', '4242.json'), JSON.stringify({ pid: 4242, start: 't1', session_id: '  ' }));
  assert.equal(lookup(dir, 4242, options), null);
  assert.equal(lookup('', 4242, options), null);
  assert.equal(lookup(dir, 1, options), null);
});

test('publicar rechaza entradas inválidas y procesos desconocidos', (t) => {
  const dir = tempDir(t);
  const options = { processStart: fake({ 4242: 't1' }) };
  for (const [pid, id] of [[0, 's'], [1, 's'], [4242, '  ']]) assert.throws(() => publish(dir, pid, id, options), /required/);
  assert.throws(() => publish(dir, 9999, 's', options), NoProcessError);
  assert.throws(() => publish('', 4242, 's', options), /required/);
});

test('publicar poda los vínculos de anfitriones que ya terminaron', (t) => {
  const dir = tempDir(t);
  const starts = { 100: 'a', 200: 'b' };
  const options = { processStart: fake(starts) };
  publish(dir, 100, 'old', options);
  delete starts[100];
  publish(dir, 200, 'new', options);
  assert.equal(existsSync(join(dir, 'host-sessions', '100.json')), false);
  assert.equal(lookup(dir, 200, options), 'new');
});

test('la señal de arranque del proceso actual es estable y un PID inexistente da NoProcessError', (t) => {
  let a;
  try {
    a = processStart(process.pid);
  } catch (err) {
    t.skip(`señal de arranque no disponible: ${err.message}`);
    return;
  }
  assert.ok(a.length > 0);
  assert.equal(processStart(process.pid), a);
  assert.throws(() => processStart(2 ** 30), NoProcessError);
});
