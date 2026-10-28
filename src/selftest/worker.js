import { parentPort, workerData } from 'node:worker_threads';
import { Store, addObservation } from '../store/index.js';

const { dataDir, worker, writesPerWorker, project } = workerData;
try {
  const store = Store.open({ dataDir, log: () => {} });
  try {
    for (let write = 0; write < writesPerWorker; write++) {
      addObservation(store, {
        session_id: `selftest-concurrent-${worker}`, type: 'note', title: `Concurrent local write ${worker}-${write}`,
        content: `Self-test concurrent local write ${worker}-${write}`, project, scope: 'project',
      });
    }
  } finally {
    store.close();
  }
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({ error: err.message });
}
