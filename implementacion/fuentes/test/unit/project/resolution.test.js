import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  AmbiguousProjectError, ProjectTransitionError, RESOLUTION_ALL, RESOLUTION_CURRENT, RESOLUTION_EXPLICIT, SOURCE_ALL_PROJECTS,
  SOURCE_EXPLICIT_OVERRIDE, SOURCE_PROCESS_OVERRIDE, UnknownProjectError, deriveRoutingCandidate, findSimilar, levenshtein, resolve,
} from '../../../src/project/index.js';
import { initRepo, tempDir } from './helpers.js';

const code = (c) => (err) => err.code === c;
const noEnv = {};

test('resolve: modo all, explícito y proyecto del proceso con su prioridad', () => {
  assert.deepEqual(resolve({ mode: RESOLUTION_ALL, explicit: 'x' }), { source: SOURCE_ALL_PROJECTS });
  assert.deepEqual(resolve({ explicit: '  Mi--App ', processOverride: 'otro', env: noEnv }), { project: 'mi-app', source: SOURCE_EXPLICIT_OVERRIDE });
  assert.deepEqual(resolve({ processOverride: ' Proc ', env: noEnv }), { project: 'proc', source: SOURCE_PROCESS_OVERRIDE });
  assert.deepEqual(resolve({ env: { ODIN_PROJECT: 'desde-env' }, detect: () => { throw new Error('no debe detectar'); } }), { project: 'desde-env', source: SOURCE_PROCESS_OVERRIDE });
});

test('resolve: el modo explícito exige un nombre válido', () => {
  assert.throws(() => resolve({ mode: RESOLUTION_EXPLICIT, explicit: '   ' }), code('invalid_project_name'));
  assert.throws(() => resolve({ mode: RESOLUTION_EXPLICIT }), /project is required/);
  assert.throws(() => resolve({ mode: RESOLUTION_EXPLICIT, explicit: 'a/b' }), /must be a name, not a path/);
  assert.throws(() => resolve({ explicit: 'mal\u0001nombre' }), /control characters/);
  assert.throws(() => resolve({ processOverride: 'a\\b', env: noEnv }), code('invalid_project_name'));
});

test('resolve: proyectos conocidos exigidos', () => {
  const exists = (name) => name === 'conocido';
  assert.equal(resolve({ explicit: 'Conocido', requireKnownExplicit: true, projectExists: exists }).project, 'conocido');
  assert.throws(() => resolve({ explicit: 'raro', requireKnownExplicit: true, projectExists: exists }), (e) => e instanceof UnknownProjectError && e.message === 'unknown project: raro');
  assert.throws(() => resolve({ explicit: 'raro', requireKnownExplicit: true }), /project existence check is required for "raro"/);
  assert.throws(() => resolve({ processOverride: 'raro', requireKnownProcess: true, projectExists: exists, env: noEnv }), code('unknown_project'));
  assert.equal(resolve({ explicit: 'raro', projectExists: exists }).project, 'raro'); // sin exigirlo no consulta
});

test('resolve: detecta por directorio y propaga los errores con el resultado parcial', (t) => {
  const repo = initRepo(join(tempDir(t), 'detectado'));
  assert.equal(resolve({ mode: RESOLUTION_CURRENT, directory: repo, env: noEnv }).project, 'detectado');
  const parent = join(tempDir(t), 'padre');
  mkdirSync(parent);
  initRepo(join(parent, 'uno'));
  initRepo(join(parent, 'dos'));
  try {
    resolve({ directory: parent, env: noEnv });
    assert.fail('debía lanzar');
  } catch (err) {
    assert.ok(err instanceof AmbiguousProjectError);
    assert.deepEqual(err.result.available_projects, ['dos', 'uno']);
  }
  const transition = initRepo(join(tempDir(t), 'nuevo'));
  assert.throws(
    () => resolve({ directory: transition, env: noEnv, detect: (dir) => ({ error: new ProjectTransitionError('nuevo', ['viejo']), path: dir }) }),
    (err) => err instanceof ProjectTransitionError && err.result.path === transition,
  );
});

test('deriveRoutingCandidate: designación explícita, raíz de git y sin datos', () => {
  assert.deepEqual(deriveRoutingCandidate({ designation: ' Mi--App ', directory: '/d' }), {
    key: 'mi-app', source: 'explicit_override', directory: '/d', raw_project: ' Mi--App ',
  });
  assert.deepEqual(deriveRoutingCandidate({ git_root: '/work/Mi-Repo/', directory: '/work/Mi-Repo/src' }), {
    key: 'mi-repo', source: 'git_root', directory: '/work/Mi-Repo/src', raw_project: '',
  });
  assert.deepEqual(deriveRoutingCandidate({ designation: 'ganadora', git_root: '/work/otra' }).key, 'ganadora');
  assert.deepEqual(deriveRoutingCandidate({ directory: '/d' }), { key: '', source: 'unknown', directory: '/d', raw_project: '' });
  assert.throws(() => deriveRoutingCandidate({ designation: 'a/b' }), (err) => err.code === 'invalid_project_name' && err.candidate.source === 'unknown');
});

test('levenshtein cuenta caracteres Unicode', () => {
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('abc', ''), 3);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('café', 'cafe'), 1);
  assert.equal(levenshtein('😀a', '😀b'), 1);
  assert.equal(levenshtein('igual', 'igual'), 0);
});

test('findSimilar: mayúsculas, subcadena y distancia, en ese orden', () => {
  const existing = ['Mi-App', 'mi-app-core', 'mi-ap', 'mi-aap', 'otra-cosa', 'MI-APP', 'x', 'mi-app'];
  const found = findSimilar('mi-app', existing, 2);
  assert.deepEqual(found.map((m) => [m.name, m.match_type, m.distance]), [
    ['Mi-App', 'case-insensitive', 0],
    ['MI-APP', 'case-insensitive', 0],
    ['mi-app-core', 'substring', 0],
    ['mi-ap', 'substring', 0],
    ['mi-aap', 'levenshtein', 1],
  ]);
  assert.deepEqual(findSimilar('mi-app', ['mi-app'], 3), []); // el propio nombre se omite
  // la distancia efectiva se acota a la mitad de la longitud (mínimo 1)
  assert.deepEqual(findSimilar('abcd', ['wxyz', 'abyz'], 5).map((m) => m.name), ['abyz']); // 2 ≤ 4/2; 'wxyz' está a 4
  assert.deepEqual(findSimilar('ab', ['xy', 'ax'], 5).map((m) => m.name), ['ax']); // 2/2 = 1
  assert.deepEqual(findSimilar('ab', ['xy'], -3), []);
  assert.deepEqual(findSimilar('  ', ['  '], 3), []);
});
