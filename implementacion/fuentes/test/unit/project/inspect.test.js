import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RepositoryBindingError, detectProjectFull, inspectLocalProject } from '../../../src/project/index.js';
import { initRepo, tempDir, write } from './helpers.js';

const bind = (repo) => detectProjectFull(repo); // crea el vínculo

test('inspectLocalProject exige un directorio utilizable', () => {
  assert.throws(() => inspectLocalProject(''), /inspection requires a usable cwd/);
  assert.throws(() => inspectLocalProject('a\0b'), /inspection requires a usable cwd/);
  assert.throws(() => inspectLocalProject('/no/existe/en/ningun/lado'), { code: 'ENOENT' });
});

test('acepta configuración y repositorios ya vinculados, sin escribir nada', (t) => {
  const base = tempDir(t);
  const withConfig = join(base, 'cfg');
  write(join(withConfig, '.odin-memory', 'config.json'), JSON.stringify({ project_name: 'Configurado' }));
  assert.equal(inspectLocalProject(withConfig).project, 'configurado');

  const repo = initRepo(join(base, 'repo-vinculado'));
  bind(repo);
  const result = inspectLocalProject(repo);
  assert.deepEqual([result.project, result.source], ['repo-vinculado', 'git_root']);
});

test('rechaza un repositorio todavía sin vínculo (no adivina)', (t) => {
  const repo = initRepo(join(tempDir(t), 'sin-vinculo'));
  assert.equal(detectProjectFull(repo, { inspectOnly: true }).source, 'unbound_git');
  // inspectOnly de la detección lo devuelve como no respaldado: inspectLocalProject lo rechaza
  assert.throws(() => inspectLocalProject(repo), (err) => err instanceof RepositoryBindingError);
});

test('un repositorio hijo se acepta solo si está vinculado y coincide', (t) => {
  const parent = join(tempDir(t), 'padre');
  mkdirSync(parent);
  const child = initRepo(join(parent, 'hijo'));
  assert.throws(() => inspectLocalProject(parent), RepositoryBindingError); // el hijo no tiene vínculo
  bind(child);
  const result = inspectLocalProject(parent);
  assert.deepEqual([result.project, result.source], ['hijo', 'git_child']);
});

test('un directorio sin git se acepta por nombre, salvo que haya metadatos de git por encima', (t) => {
  const base = tempDir(t);
  const plain = join(base, 'Carpeta--Suelta');
  mkdirSync(plain);
  assert.equal(inspectLocalProject(plain).project, 'carpeta-suelta');
  // dentro de un repo con .git directamente accesible pero no detectable por git: se rechaza
  const fake = join(base, 'falso');
  mkdirSync(join(fake, '.git'), { recursive: true }); // .git vacío: git no lo reconoce como repositorio
  const inside = join(fake, 'sub');
  mkdirSync(inside);
  assert.throws(() => inspectLocalProject(inside), RepositoryBindingError);
  // GIT_CEILING_DIRECTORIES corta la búsqueda hacia arriba
  const result = inspectLocalProject(inside, { GIT_CEILING_DIRECTORIES: fake });
  assert.equal(result.project, 'sub');
});
