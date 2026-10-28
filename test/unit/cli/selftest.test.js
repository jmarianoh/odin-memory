import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTestArgs } from '../../../src/cli/commands/selftest.js';
import { cliWorld } from './helpers.js';

const report = (over = {}) => ({
  schema_version: 'odin-self-test/v1', suite: 'all', quick: true, passed: true, duration_ms: 12,
  scenarios: [
    { name: 'a', suite: 'reliability', passed: true, duration_ms: 3 },
    { name: 'b', suite: 'performance', passed: true, duration_ms: 4, metrics: { operations: 20, throughput_ops_per_second: 1234.56 } },
  ],
  ...over,
});

test('parseTestArgs reconoce banderas, una sola suite y la ayuda', () => {
  assert.deepEqual(parseTestArgs([]), { options: { suite: 'all', quick: false }, json: false, help: false });
  assert.deepEqual(parseTestArgs(['--quick', '--json', ' Performance ']), { options: { suite: 'performance', quick: true }, json: true, help: false });
  for (const arg of ['--help', '-h', 'help']) assert.equal(parseTestArgs([arg]).help, true);
  assert.equal(parseTestArgs(['all']).options.suite, 'all');
  assert.throws(() => parseTestArgs(['--x']), { message: 'unknown test flag "--x"' });
  assert.throws(() => parseTestArgs(['reliability', 'performance']), { message: 'only one test suite may be selected' });
  assert.throws(() => parseTestArgs(['otra']), { message: 'unknown test suite "otra"' });
});

test('test imprime el informe de texto y devuelve 0', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['test', '--quick'], { overrides: { selfTest: async (options) => { assert.deepEqual(options, { suite: 'all', quick: true }); return report(); } } });
  assert.equal(r.code, 0);
  assert.equal(r.out, [
    'Odin self-test (all suite, quick mode)',
    'PASS  reliability/a  3ms',
    'PASS  performance/b  4ms  20 operations  1234.6 ops/s',
    'Result: PASS (12ms)',
    '',
  ].join('\n'));
});

test('un escenario fallido sale con 2 y muestra su error', async (t) => {
  const w = cliWorld(t);
  const failing = report({ passed: false, quick: false, scenarios: [{ name: 'a', suite: 'reliability', passed: false, duration_ms: 3, error: 'roto' }] });
  const r = await w.odin(['test'], { overrides: { selfTest: async () => failing } });
  assert.equal(r.code, 2);
  assert.equal(r.out, 'Odin self-test (all suite, full mode)\nFAIL  reliability/a  3ms  roto\nResult: FAIL (12ms)\n');
  const json = await w.odin(['test', '--json'], { overrides: { selfTest: async () => failing } });
  assert.equal(json.code, 2);
  assert.equal(JSON.parse(json.out).scenarios[0].error, 'roto');
});

test('--json emite el informe compacto en una línea', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['test', '--json'], { overrides: { selfTest: async () => report() } });
  assert.equal(r.code, 0);
  assert.equal(r.out, `${JSON.stringify(report())}\n`);
});

test('uso y errores de uso: el error va a stderr, el uso a stdout y el código es 1', async (t) => {
  const w = cliWorld(t);
  const help = await w.odin(['test', '--help']);
  assert.equal(help.code, 0);
  assert.ok(help.out.startsWith('usage: odin test [reliability|performance] [--quick] [--json]\n\nRun isolated local reliability and performance self-tests.\n'));
  assert.equal(help.err, '');
  const bad = await w.odin(['test', '--nada']);
  assert.equal(bad.code, 1);
  assert.equal(bad.err, 'error: unknown test flag "--nada"\n\n');
  assert.ok(bad.out.startsWith('usage: odin test'));
});

test('test no resuelve configuración ni abre el almacén del usuario', async (t) => {
  const w = cliWorld(t, { env: { ODIN_DATA_DIR: '/ruta/que/no/existe/ni/se/puede/crear' } });
  const r = await w.odin(['test'], { overrides: { selfTest: async () => report(), openStore: () => { throw new Error('no debe abrirse'); } } });
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
});

test('test de verdad: la suite rápida de rendimiento corre de principio a fin', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['test', 'performance', '--quick', '--json']);
  assert.equal(r.code, 0, r.err);
  const parsed = JSON.parse(r.out);
  assert.deepEqual([parsed.suite, parsed.passed, parsed.scenarios.length], ['performance', true, 1]);
});
