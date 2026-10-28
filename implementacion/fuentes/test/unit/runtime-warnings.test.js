import { test } from 'node:test';
import assert from 'node:assert/strict';
import { silenceSqliteWarning } from '../../src/runtime/warnings.js';

test('silencia solo la advertencia experimental de SQLite', (t) => {
  const seen = [];
  const original = process.emitWarning;
  process.emitWarning = (w) => seen.push(String(w));
  const restore = silenceSqliteWarning();
  t.after(() => {
    restore();
    process.emitWarning = original;
  });

  process.emitWarning('SQLite is an experimental feature', 'ExperimentalWarning');
  process.emitWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning' });
  process.emitWarning('Otra característica experimental', 'ExperimentalWarning');
  process.emitWarning('algo en SQLite que no es experimental', 'Warning');

  assert.deepEqual(seen, ['Otra característica experimental', 'algo en SQLite que no es experimental']);
});

test('restore devuelve emitWarning a su estado anterior', () => {
  const before = process.emitWarning;
  const restore = silenceSqliteWarning();
  assert.notEqual(process.emitWarning, before);
  restore();
  assert.equal(process.emitWarning, before);
});
