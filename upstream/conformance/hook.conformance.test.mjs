// Contraste diferencial de `hook resolve-hook-project`: misma respuesta para las mismas cargas.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBinary } from './engram-mcp.mjs';

const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';
const ODIN_BIN = fileURLToPath(new URL('../../bin/odin.js', import.meta.url));
let base;

before(() => {
  if (binary) base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-hook-')));
});
after(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  binary?.cleanup();
});

function run(side, input, dir) {
  const env = { ...process.env, HOME: dir, ENGRAM_DATA_DIR: join(dir, 'ref-data'), ODIN_DATA_DIR: join(dir, 'odin-data'), ENGRAM_NO_UPDATE_CHECK: '1' };
  if (side === 'ref') return spawnSync(binary.bin, ['hook', 'resolve-hook-project'], { input, encoding: 'utf8', env });
  return spawnSync(process.execPath, ['--no-warnings', ODIN_BIN, 'hook', 'resolve-hook-project'], { input, encoding: 'utf8', env });
}

function world(name) {
  const dir = join(base, name);
  mkdirSync(dir);
  const repo = join(dir, 'mi-repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const configured = join(dir, 'configurado');
  mkdirSync(join(configured, '.odin-memory'), { recursive: true });
  mkdirSync(join(configured, '.engram'), { recursive: true });
  writeFileSync(join(configured, '.odin-memory', 'config.json'), '{"project_name":"desde-config"}');
  writeFileSync(join(configured, '.engram', 'config.json'), '{"project_name":"desde-config"}');
  const plain = join(dir, 'sin-git');
  mkdirSync(plain);
  const children = join(dir, 'hijos');
  mkdirSync(join(children, 'a'), { recursive: true });
  mkdirSync(join(children, 'b'), { recursive: true });
  execFileSync('git', ['init', '-q', join(children, 'a')]);
  execFileSync('git', ['init', '-q', join(children, 'b')]);
  return { dir, repo, configured, plain, children };
}

test('resolve-hook-project responde igual para cargas válidas e inválidas', { skip }, () => {
  const w = world('casos');
  const cwds = [w.repo, w.configured, w.plain, w.children, join(w.dir, 'no-existe'), 'relativo/ruta', '', `${w.repo}/`];
  const inputs = [
    ...cwds.map((cwd) => JSON.stringify({ cwd })),
    JSON.stringify({ cwd: w.repo, sessionId: 'x', prompt: 'hola' }),
    JSON.stringify({ cwd: 5 }),
    JSON.stringify({ cwd: null }),
    JSON.stringify({}),
    JSON.stringify({ nested: { cwd: w.repo } }),
    JSON.stringify({ CWD: w.repo }),
    JSON.stringify([w.repo]),
    `{"cwd":${JSON.stringify(w.repo)},"cwd":${JSON.stringify(w.plain)}}`,
    `{"nested":{"cwd":"x"},"cwd":${JSON.stringify(w.repo)}}`,
    `${JSON.stringify({ cwd: w.repo })} ${JSON.stringify({ cwd: w.repo })}`,
    `${JSON.stringify({ cwd: w.repo })}   \n`,
    '', 'no json', 'null', '"texto"',
  ];
  let answered = 0;
  const mask = (text) => text.replaceAll(w.dir, '<DIR>').replace(/engram/g, 'odin');
  for (const input of inputs) {
    const ref = run('ref', input, w.dir);
    const odin = run('odin', input, w.dir);
    assert.equal(odin.status, ref.status, `código: ${input}`);
    assert.equal(mask(odin.stdout), mask(ref.stdout), `stdout: ${input}`);
    assert.equal(odin.stderr, '', `sin ruido en stderr: ${input}`);
    if (odin.stdout.includes('desde-config')) answered += 1;
  }
  assert.ok(answered >= 1, 'el caso configurado responde con su proyecto');
});

test('resolve-hook-project no escribe el vínculo del repositorio', { skip }, () => {
  const w = world('sin-escritura');
  const before = execFileSync('git', ['-C', w.repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const odin = run('odin', JSON.stringify({ cwd: w.repo }), w.dir);
  assert.equal(odin.status, 0);
  const listing = execFileSync('ls', [join(w.repo, before === '.git' ? '.git' : before)], { encoding: 'utf8' });
  assert.ok(!listing.includes('odin-memory-project-identity.json'));
});
