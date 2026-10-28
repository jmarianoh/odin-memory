import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSelfTest, SCHEMA_VERSION } from '../../../src/selftest/index.js';
import { runConcurrentLocalWrites, runDatabaseSaveSearchContext, runStoreSearch } from '../../../src/selftest/scenarios.js';

test('el informe rápido de todas las suites pasa y tiene la forma estable', async () => {
  const report = await runSelfTest({ quick: true });
  assert.deepEqual(Object.keys(report), ['schema_version', 'suite', 'quick', 'passed', 'duration_ms', 'scenarios']);
  assert.deepEqual([report.schema_version, report.suite, report.quick, report.passed], [SCHEMA_VERSION, 'all', true, true]);
  assert.equal(SCHEMA_VERSION, 'odin-self-test/v1');
  assert.deepEqual(report.scenarios.map((s) => `${s.suite}/${s.name}`), ['reliability/database_save_search_context', 'reliability/concurrent_local_writes', 'performance/store_search']);
  for (const s of report.scenarios) {
    assert.equal(s.passed, true, s.error);
    assert.ok(Number.isInteger(s.duration_ms) && s.duration_ms >= 0);
    assert.ok(!('error' in s));
  }
  assert.deepEqual(Object.keys(report.scenarios[2]), ['name', 'suite', 'passed', 'duration_ms', 'metrics']);
  assert.deepEqual(Object.keys(report.scenarios[2].metrics), ['operations', 'throughput_ops_per_second']);
  assert.equal(report.scenarios[2].metrics.operations, 20);
  assert.ok(report.scenarios[2].metrics.throughput_ops_per_second > 0);
});

test('cada suite ejecuta solo sus escenarios y el nombre se normaliza', async () => {
  const names = async (suite) => (await runSelfTest({ suite, quick: true })).scenarios.map((s) => s.name);
  assert.deepEqual(await names('reliability'), ['database_save_search_context', 'concurrent_local_writes']);
  assert.deepEqual(await names('  PERFORMANCE '), ['store_search']);
  assert.deepEqual((await runSelfTest({ suite: 'performance', quick: true })).suite, 'performance');
  assert.equal((await runSelfTest({ suite: '', quick: true })).suite, 'all');
  const unknown = await runSelfTest({ suite: 'Otra' });
  assert.deepEqual([unknown.suite, unknown.passed, unknown.scenarios], ['otra', true, []], 'una suite desconocida no ejecuta nada');
});

test('cada ejecución usa un directorio temporal propio y lo borra', async () => {
  const dirs = [];
  const removed = [];
  const makeTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'odin-selftest-unit-'));
    dirs.push(dir);
    return dir;
  };
  const removeDir = (dir) => {
    removed.push(dir);
    rmSync(dir, { recursive: true, force: true });
  };
  await runSelfTest({ suite: 'reliability', quick: true }, { makeTempDir, removeDir });
  assert.equal(dirs.length, 1);
  assert.deepEqual(removed, dirs);
  assert.equal(existsSync(dirs[0]), false);
});

test('si no se puede crear el directorio temporal, falla el escenario setup', async () => {
  const report = await runSelfTest({ suite: 'performance' }, { makeTempDir: () => { throw new Error('sin espacio'); } });
  assert.equal(report.passed, false);
  assert.equal(report.scenarios.length, 1);
  assert.deepEqual(report.scenarios[0].name, 'setup');
  assert.equal(report.scenarios[0].suite, 'performance');
  assert.equal(report.scenarios[0].passed, false);
  assert.equal(report.scenarios[0].error, 'create temporary directory: sin espacio');
});

test('un fallo al borrar el directorio no cambia el resultado', async () => {
  const report = await runSelfTest({ suite: 'performance', quick: true }, { removeDir: () => { throw new Error('ocupado'); } });
  assert.equal(report.passed, true);
});

test('los escenarios se pueden ejecutar sueltos', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'odin-selftest-scn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runDatabaseSaveSearchContext(join(root, 'a'));
  await runConcurrentLocalWrites(join(root, 'b'), true);
  const metrics = runStoreSearch(join(root, 'c'), true);
  assert.equal(metrics.operations, 20);
  // Un directorio de datos que no se puede usar hace fallar el escenario con un error claro.
  assert.throws(() => runDatabaseSaveSearchContext(join(root, 'a', 'odin.db', 'dentro')));
});

test('un escenario que falla marca el informe, conserva su mensaje y no detiene a los demás', async () => {
  const seen = [];
  const report = await runSelfTest({ quick: true }, {
    scenarios: {
      databaseSaveSearchContext: () => { throw new Error('search did not return the saved observation'); },
      concurrentLocalWrites: async (dir, quick) => { seen.push(['concurrent', dir.endsWith('reliability-concurrent'), quick]); },
      storeSearch: (dir, quick) => { seen.push(['search', dir.endsWith('performance-search'), quick]); return { operations: 1, throughput_ops_per_second: 2 }; },
    },
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.scenarios.map((s) => [s.name, s.passed]), [['database_save_search_context', false], ['concurrent_local_writes', true], ['store_search', true]]);
  assert.deepEqual(Object.keys(report.scenarios[0]), ['name', 'suite', 'passed', 'duration_ms', 'error']);
  assert.equal(report.scenarios[0].error, 'search did not return the saved observation');
  assert.deepEqual(seen, [['concurrent', true, true], ['search', true, true]]);
  assert.deepEqual(report.scenarios[2].metrics, { operations: 1, throughput_ops_per_second: 2 });
  const perf = await runSelfTest({ suite: 'performance' }, { scenarios: { storeSearch: () => { throw 'texto'; } } });
  assert.deepEqual([perf.passed, perf.scenarios[0].error, perf.scenarios[0].suite], [false, 'texto', 'performance']);
});
