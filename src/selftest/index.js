import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { goTrim } from '../store/text.js';
import { runConcurrentLocalWrites, runDatabaseSaveSearchContext, runStoreSearch } from './scenarios.js';

export const SUITE_ALL = 'all';
export const SUITE_RELIABILITY = 'reliability';
export const SUITE_PERFORMANCE = 'performance';
export const SCHEMA_VERSION = 'odin-self-test/v1';

const SCENARIOS = { databaseSaveSearchContext: runDatabaseSaveSearchContext, concurrentLocalWrites: runConcurrentLocalWrites, storeSearch: runStoreSearch };

const normalizeSuite = (suite) => {
  const s = goTrim(suite ?? '').toLowerCase();
  return s === '' ? SUITE_ALL : s;
};

const ms = (started) => Math.floor(Number(process.hrtime.bigint() - started) / 1e6);

function failed(name, suite, started, err) {
  return { name, suite, passed: false, duration_ms: ms(started), error: err instanceof Error ? err.message : String(err) };
}

async function scenario(name, suite, fn) {
  const started = process.hrtime.bigint();
  try {
    await fn();
  } catch (err) {
    return failed(name, suite, started, err);
  }
  return { name, suite, passed: true, duration_ms: ms(started) };
}

async function performanceScenario(name, fn) {
  const started = process.hrtime.bigint();
  let metrics;
  try {
    metrics = await fn();
  } catch (err) {
    return failed(name, SUITE_PERFORMANCE, started, err);
  }
  return { name, suite: SUITE_PERFORMANCE, passed: true, duration_ms: ms(started), metrics };
}

/**
 * Ejecuta las autopruebas locales en un directorio temporal propio; nunca lee el directorio de
 * datos configurado ni la configuración de la nube.
 * @param {{ suite?: string, quick?: boolean }} [options]
 * @param {{ makeTempDir?: () => string, removeDir?: (dir: string) => void, scenarios?: Partial<typeof SCENARIOS> }} [hooks] ganchos de prueba
 * @returns {Promise<{ schema_version: string, suite: string, quick: boolean, passed: boolean, duration_ms: number, scenarios: object[] }>}
 */
export async function runSelfTest(options = {}, hooks = {}) {
  const suite = normalizeSuite(options.suite);
  const quick = options.quick === true;
  const started = process.hrtime.bigint();
  const report = { schema_version: SCHEMA_VERSION, suite, quick, passed: true, duration_ms: 0, scenarios: [] };
  const add = (s) => {
    report.scenarios.push(s);
    if (!s.passed) report.passed = false;
  };
  const run = { ...SCENARIOS, ...hooks.scenarios };
  const makeTempDir = hooks.makeTempDir ?? (() => mkdtempSync(join(tmpdir(), 'odin-self-test-')));
  const removeDir = hooks.removeDir ?? ((dir) => rmSync(dir, { recursive: true, force: true }));

  let root;
  try {
    root = resolve(makeTempDir());
  } catch (err) {
    report.passed = false;
    report.scenarios.push(failed('setup', suite, started, new Error(`create temporary directory: ${err.message}`)));
    report.duration_ms = ms(started);
    return report;
  }
  try {
    if (suite === SUITE_ALL || suite === SUITE_RELIABILITY) {
      add(await scenario('database_save_search_context', SUITE_RELIABILITY, () => run.databaseSaveSearchContext(join(root, 'reliability-core'))));
      add(await scenario('concurrent_local_writes', SUITE_RELIABILITY, () => run.concurrentLocalWrites(join(root, 'reliability-concurrent'), quick)));
    }
    if (suite === SUITE_ALL || suite === SUITE_PERFORMANCE) {
      add(await performanceScenario('store_search', () => run.storeSearch(join(root, 'performance-search'), quick)));
    }
  } finally {
    try {
      removeDir(root);
    } catch {
      // la limpieza es de mejor esfuerzo
    }
  }
  report.duration_ms = ms(started);
  return report;
}
