// Contraste diferencial de `test`: mismas suites, mismos escenarios, mismo uso y mismos códigos de salida.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBinary } from './engram-mcp.mjs';

const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';
const ODIN_BIN = fileURLToPath(new URL('../../bin/odin.js', import.meta.url));
after(() => binary?.cleanup());

const mask = (text) => String(text)
  .replace(/"duration_ms":\d+/g, '"duration_ms":N')
  .replace(/"throughput_ops_per_second":[0-9.e+-]+/g, '"throughput_ops_per_second":T')
  .replace(/\d+ms/g, 'Nms')
  .replace(/[0-9.]+ ops\/s/g, 'T ops/s')
  .replace(/engram-self-test/g, 'odin-self-test')
  .replace(/Engram/g, 'Odin')
  .replace(/engram/g, 'odin');

function both(args) {
  const env = { ...process.env, HOME: '/nonexistent', ENGRAM_DATA_DIR: '/nonexistent/ref', ODIN_DATA_DIR: '/nonexistent/odin' };
  const ref = spawnSync(binary.bin, args, { encoding: 'utf8', env });
  const odin = spawnSync(process.execPath, ['--no-warnings', ODIN_BIN, ...args], { encoding: 'utf8', env });
  return { ref, odin };
}

function same(args) {
  const { ref, odin } = both(args);
  const label = `odin ${args.join(' ')}`;
  assert.equal(odin.status, ref.status, `${label}: código\n${ref.stderr}\n--\n${odin.stderr}`);
  assert.equal(mask(odin.stdout), mask(ref.stdout), `${label}: stdout`);
  assert.equal(mask(odin.stderr), mask(ref.stderr), `${label}: stderr`);
  return { ref, odin };
}

test('uso, errores y códigos de salida', { skip }, () => {
  for (const args of [['test', '--help'], ['test', '-h'], ['test', 'help'], ['test', '--bogus'], ['test', 'otra'], ['test', 'reliability', 'performance'], ['Test', '--help'], ['test', '--quick', '--help']]) same(args);
});

test('informe de texto de cada suite', { skip }, () => {
  for (const args of [['test', '--quick'], ['test', 'reliability', '--quick'], ['test', 'performance', '--quick'], ['test', ' Reliability ', '--quick']]) same(args);
});

test('informe JSON: mismas claves, orden y escenarios', { skip }, () => {
  for (const args of [['test', '--quick', '--json'], ['test', 'performance', '--json', '--quick'], ['test', 'reliability', '--quick', '--json']]) {
    const { ref, odin } = same(args);
    const shape = (text) => JSON.parse(text);
    assert.deepEqual(Object.keys(shape(odin.stdout)), Object.keys(shape(ref.stdout)));
    assert.deepEqual(shape(odin.stdout).scenarios.map((s) => Object.keys(s)), shape(ref.stdout).scenarios.map((s) => Object.keys(s)));
  }
});
