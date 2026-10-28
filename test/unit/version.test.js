import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { VERSION, nodeIsSupported } from '../../src/version/index.js';

test('nodeIsSupported exige Node >= 24', () => {
  assert.equal(nodeIsSupported('24.0.0'), true);
  assert.equal(nodeIsSupported('25.1.0'), true);
  assert.equal(nodeIsSupported('22.22.3'), false);
  assert.equal(nodeIsSupported('18.13.0'), false);
});

test('odin version imprime la versión del paquete', () => {
  const out = execFileSync(process.execPath, ['bin/odin.js', 'version'], { encoding: 'utf8' });
  assert.equal(out.trim(), `odin ${VERSION}`);
});

test('odin con comando desconocido falla', () => {
  assert.throws(() => execFileSync(process.execPath, ['bin/odin.js', 'nope'], { stdio: 'pipe' }));
});
