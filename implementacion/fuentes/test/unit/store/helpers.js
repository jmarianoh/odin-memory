import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../src/store/index.js';

/**
 * Crea un directorio temporal que se elimina al terminar la prueba.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'odin-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Abre un Store en un directorio temporal y lo cierra al terminar la prueba.
 * @param {import('node:test').TestContext} t
 * @param {Partial<import('../../../src/store/store.js').StoreConfig>} [overrides]
 * @returns {Store}
 */
export function openTempStore(t, overrides = {}) {
  const dataDir = overrides.dataDir ?? join(tempDir(t), 'data');
  const store = Store.open({ log: () => {}, ...overrides, dataDir });
  t.after(() => {
    try {
      store.close();
    } catch {
      // ya cerrado por la prueba
    }
  });
  return store;
}
