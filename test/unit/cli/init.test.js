import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliWorld } from './helpers.js';

const config = (world) => readFileSync(join(world.repoDir, '.odin-memory', 'config.json'), 'utf8');

test('init escribe la configuración con el nombre dado o el del directorio', async (t) => {
  const w = cliWorld(t);
  const named = await w.odin(['init', 'mi-proyecto']);
  assert.equal(named.code, 0);
  assert.equal(named.out, 'Initialized Odin project "mi-proyecto" in .odin-memory/config.json\n');
  assert.equal(config(w), '{\n  "project_name": "mi-proyecto"\n}\n');
  assert.equal(lstatSync(join(w.repoDir, '.odin-memory', 'config.json')).mode & 0o777, 0o644 & ~process.umask());
  const byDir = cliWorld(t, { repo: 'nombre-del-dir' });
  assert.equal((await byDir.odin(['init'])).out, 'Initialized Odin project "nombre-del-dir" in .odin-memory/config.json\n');
  assert.equal(existsSync(byDir.dataDir), false, 'init no abre el almacén');
});

test('init no sobrescribe sin --force y no deja temporales', async (t) => {
  const w = cliWorld(t);
  await w.odin(['init', 'uno']);
  const second = await w.odin(['init', 'dos']);
  assert.equal(second.code, 1);
  assert.equal(second.err, 'odin: .odin-memory/config.json already exists (use --force to overwrite)\n');
  assert.match(config(w), /uno/);
  assert.equal((await w.odin(['init', 'dos', '--force'])).code, 0);
  assert.equal((await w.odin(['init', '-f', 'tres'])).code, 0);
  assert.match(config(w), /tres/);
  assert.deepEqual(readdirSync(join(w.repoDir, '.odin-memory')), ['config.json']);
});

test('init valida el nombre y las opciones', async (t) => {
  const w = cliWorld(t);
  const usage = 'usage: odin init [project_name] [--force]';
  assert.equal((await w.odin(['init', '--help'])).out, `${usage}\n`);
  assert.equal((await w.odin(['init', 'help'])).out, `${usage}\n`);
  assert.equal((await w.odin(['init', '-h'])).out, `${usage}\n`);
  assert.equal((await w.odin(['init', '--bogus'])).err, `odin: unknown flag: --bogus\n\n${usage}\n`);
  assert.equal((await w.odin(['init', 'uno', 'dos'])).err, `odin: unexpected argument: dos\n\n${usage}\n`);
  assert.equal((await w.odin(['init', 'a/b'])).err, 'odin: project name must be a name, not a path\n');
  assert.equal((await w.odin(['init', 'a\\b'])).err, 'odin: project name must be a name, not a path\n');
  assert.equal((await w.odin(['init', '   '])).err, 'odin: project name is required\n');
  assert.equal((await w.odin(['init', 'tab\tname'])).err, 'odin: project name contains control characters\n');
  assert.equal((await w.odin(['init', 'del\x7f'])).err, 'odin: project name contains control characters\n');
  assert.equal(existsSync(join(w.repoDir, '.odin-memory')), false);
  await w.odin(['init', '<html>&']);
  assert.equal(config(w), '{\n  "project_name": "\\u003chtml\\u003e\\u0026"\n}\n');
});

test('init rechaza enlaces simbólicos y archivos en lugar de directorios', async (t) => {
  const w = cliWorld(t);
  mkdirSync(join(w.root, 'otro'));
  symlinkSync(join(w.root, 'otro'), join(w.repoDir, '.odin-memory'));
  assert.equal((await w.odin(['init', 'x'])).err, 'odin: .odin-memory must be a real directory, not a symlink\n');

  const file = cliWorld(t);
  writeFileSync(join(file.repoDir, '.odin-memory'), 'x');
  assert.equal((await file.odin(['init', 'x'])).err, 'odin: .odin-memory must be a directory\n');

  const link = cliWorld(t);
  mkdirSync(join(link.repoDir, '.odin-memory'));
  writeFileSync(join(link.root, 'destino.json'), '{}');
  symlinkSync(join(link.root, 'destino.json'), join(link.repoDir, '.odin-memory', 'config.json'));
  assert.equal((await link.odin(['init', 'x', '--force'])).err, 'odin: .odin-memory/config.json must not be a symlink\n');
  assert.equal(readFileSync(join(link.root, 'destino.json'), 'utf8'), '{}');
});

test('el proyecto de init se usa al guardar', async (t) => {
  const w = cliWorld(t);
  await w.odin(['init', 'configurado']);
  await w.odin(['save', 't', 'c']);
  assert.match((await w.odin(['stats', '--all'])).out, /Projects:     configurado/);
});
