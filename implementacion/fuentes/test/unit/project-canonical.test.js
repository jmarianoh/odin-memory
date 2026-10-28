import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeProjectName, normalizeProject, normalizeProjectName } from '../../src/project/canonical.js';

test('canonicalizeProjectName: minúsculas, NFC, recorte y colapso de -- y __', () => {
  assert.equal(canonicalizeProjectName('  My--Proj__X '), 'my-proj_x');
  assert.equal(canonicalizeProjectName('Café'), 'café'); // e + acento combinante → é precompuesta
  assert.equal(canonicalizeProjectName('a----b____c'), 'a-b_c');
  assert.equal(canonicalizeProjectName(''), '');
});

test('normalizeProject devuelve un aviso solo si el nombre cambió', () => {
  assert.deepEqual(normalizeProject(''), { normalized: '', warning: '' });
  assert.deepEqual(normalizeProject('ok-name'), { normalized: 'ok-name', warning: '' });
  const r = normalizeProject('Mi--App');
  assert.equal(r.normalized, 'mi-app');
  assert.equal(r.warning, '⚠️ Project name normalized: "Mi--App" → "mi-app"');
});

test('normalizeProjectName rechaza vacíos, rutas y caracteres de control', () => {
  assert.equal(normalizeProjectName('  Mi App '), 'mi app');
  for (const bad of ['', '   ', 'a/b', 'a\\b', 'a\u0007b', 'a\u007fb']) {
    assert.throws(() => normalizeProjectName(bad), (err) => err.code === 'invalid_project_name', JSON.stringify(bad));
  }
  assert.throws(() => normalizeProjectName('a/b'), /project must be a name, not a path/);
});
