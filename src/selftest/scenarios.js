import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, addObservation, createSession, formatContext, searchObservations, stats } from '../store/index.js';

/** Abre un almacén nuevo en un directorio de datos absoluto. */
export function openSelfTestStore(dataDir) {
  return Store.open({ dataDir: resolve(dataDir), log: () => {} });
}

/** Guarda, busca y recupera contexto sobre un almacén recién creado. */
export function runDatabaseSaveSearchContext(dataDir) {
  const store = openSelfTestStore(dataDir);
  try {
    const sessionId = 'selftest-reliability-session';
    const project = 'selftest-reliability';
    createSession(store, sessionId, project, dataDir);
    addObservation(store, {
      session_id: sessionId, type: 'decision', title: 'Self-test database migration',
      content: 'Self-test verifies local database initialization, save, search, and context.', project, scope: 'project',
    });
    const results = searchObservations(store, 'database migration', { project, scope: 'project', limit: 5 });
    if (results.length === 0 || results[0].title !== 'Self-test database migration') throw new Error('search did not return the saved observation');
    const context = formatContext(store, project, 'project');
    if (!context.includes('Self-test database migration')) throw new Error('context did not include the saved observation');
  } finally {
    store.close();
  }
}

const WORKER_URL = new URL('./worker.js', import.meta.url);

function runWorker(workerData) {
  return new Promise((resolveWorker, reject) => {
    const worker = new Worker(fileURLToPath(WORKER_URL), { workerData });
    worker.once('message', (message) => {
      if (message.error) reject(new Error(message.error));
      else resolveWorker();
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });
}

/** Varios hilos, cada uno con su propia conexión, escriben a la vez en la misma base. */
export async function runConcurrentLocalWrites(dataDir, quick) {
  const [workers, writesPerWorker] = quick ? [4, 10] : [8, 50];
  const project = 'selftest-concurrent';
  const absolute = resolve(dataDir);
  const store = openSelfTestStore(absolute);
  try {
    for (let worker = 0; worker < workers; worker++) createSession(store, `selftest-concurrent-${worker}`, project, absolute);
    const runs = Array.from({ length: workers }, (_, worker) => runWorker({ dataDir: absolute, worker, writesPerWorker, project }));
    const settled = await Promise.allSettled(runs);
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed) throw new Error(`concurrent write: ${failed.reason.message}`);
    const total = stats(store).total_observations;
    const want = workers * writesPerWorker;
    if (total !== want) throw new Error(`stored ${total} concurrent observations, want ${want}`);
  } finally {
    store.close();
  }
}

/** Mide el rendimiento de la búsqueda; ningún umbral de tiempo decide el resultado. */
export function runStoreSearch(dataDir, quick) {
  const store = openSelfTestStore(dataDir);
  try {
    const [records, searches] = quick ? [100, 20] : [1000, 200];
    const sessionId = 'selftest-performance-session';
    const project = 'selftest-performance';
    createSession(store, sessionId, project, dataDir);
    for (let i = 0; i < records; i++) {
      const n = String(i).padStart(4, '0');
      addObservation(store, {
        session_id: sessionId, type: 'note', title: `Self-test search record ${n}`, content: `Self-test search corpus shared keyword record ${n}`, project, scope: 'project',
      });
    }
    const started = process.hrtime.bigint();
    for (let i = 0; i < searches; i++) {
      const results = searchObservations(store, 'shared keyword', { project, scope: 'project', limit: 20 });
      if (results.length === 0) throw new Error(`search ${i} returned no seeded records`);
    }
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    return { operations: searches, throughput_ops_per_second: seconds > 0 ? searches / seconds : 0 };
  } finally {
    store.close();
  }
}
