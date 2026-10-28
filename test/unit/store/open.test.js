import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DB_FILE_NAME,
  DatabaseGenerationChangedError,
  NetworkFilesystemError,
  Store,
  StoreError,
} from '../../../src/store/index.js';
import { classifyFilesystemName, setFilesystemInspector } from '../../../src/store/data-dir.js';
import { isValidInstanceId } from '../../../src/store/instance-id.js';
import { openTempStore, tempDir } from './helpers.js';

const noLog = () => {};

test('abre y crea el directorio, la base y la identidad', (t) => {
  const store = openTempStore(t);
  assert.ok(existsSync(store.dbPath));
  assert.ok(store.dbPath.endsWith(DB_FILE_NAME));
  assert.ok(isValidInstanceId(store.instanceId));
  assert.equal(readFileSync(join(store.dataDir, '.instance-id'), 'utf8').trim(), store.instanceId);
  assert.equal(store.db.get('PRAGMA journal_mode').journal_mode, 'wal');
  assert.equal(store.db.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.equal(store.db.get('PRAGMA synchronous').synchronous, 1);
});

test('la identidad de instalación se conserva al reabrir', (t) => {
  const dataDir = join(tempDir(t), 'data');
  const first = Store.open({ dataDir, log: noLog });
  const id = first.instanceId;
  first.close();
  const second = Store.open({ dataDir, log: noLog });
  t.after(() => second.close());
  assert.equal(second.instanceId, id);
  assert.notEqual(second.runtimeId, first.runtimeId);
});

test('una identidad corrupta se regenera', (t) => {
  const dataDir = join(tempDir(t), 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, '.instance-id'), 'no-es-valido\n');
  const store = Store.open({ dataDir, log: noLog });
  t.after(() => store.close());
  assert.ok(isValidInstanceId(store.instanceId));
});

test('rechaza un directorio de datos relativo sin crear nada', () => {
  assert.throws(
    () => Store.open({ dataDir: 'relativo/datos', log: noLog }),
    (err) => err instanceof StoreError && err.code === 'data_dir_not_absolute',
  );
  assert.equal(existsSync('relativo'), false);
});

test('rechaza un sistema de archivos remoto antes de tocar el disco', (t) => {
  const dataDir = join(tempDir(t), 'data');
  const restore = setFilesystemInspector(() => ({ type: 'NFS', support: 'remote' }));
  t.after(restore);
  assert.throws(
    () => Store.open({ dataDir, log: noLog }),
    (err) => err instanceof NetworkFilesystemError && err.filesystem === 'NFS',
  );
  assert.equal(existsSync(dataDir), false);
});

test('un fallo del inspector de sistema de archivos no impide abrir', (t) => {
  const restore = setFilesystemInspector(() => {
    throw new Error('sin permisos');
  });
  t.after(restore);
  openTempStore(t);
});

test('classifyFilesystemName solo marca como remoto lo que identifica', () => {
  assert.deepEqual(classifyFilesystemName('nfs'), { type: 'NFS', support: 'remote' });
  assert.deepEqual(classifyFilesystemName('SMBFS'), { type: 'SMB/CIFS', support: 'remote' });
  assert.equal(classifyFilesystemName('apfs').support, 'unknown');
  assert.equal(classifyFilesystemName('ext4').support, 'unknown');
});

test('reabrir es idempotente y siembra los destinos de sincronización', (t) => {
  const dataDir = join(tempDir(t), 'data');
  Store.open({ dataDir, log: noLog }).close();
  const store = Store.open({ dataDir, log: noLog });
  t.after(() => store.close());
  const rows = store.db.all('SELECT target_key, lifecycle FROM sync_state ORDER BY target_key');
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { target_key: 'cloud', lifecycle: 'idle' },
      { target_key: 'cloud:inbox', lifecycle: 'inbox' },
    ],
  );
});

test('repara la fila reservada de la bandeja de entrada', (t) => {
  const dataDir = join(tempDir(t), 'data');
  const first = Store.open({ dataDir, log: noLog });
  first.db.run("UPDATE sync_state SET lifecycle = 'pending', last_enqueued_seq = 7 WHERE target_key = 'cloud:inbox'");
  first.close();
  const store = Store.open({ dataDir, log: noLog });
  t.after(() => store.close());
  const row = store.db.get("SELECT lifecycle, last_enqueued_seq FROM sync_state WHERE target_key = 'cloud:inbox'");
  assert.equal(row.lifecycle, 'inbox');
  assert.equal(row.last_enqueued_seq, 0);
});

test('no escribe en una base con un esquema más nuevo y lo avisa', (t) => {
  const dataDir = join(tempDir(t), 'data');
  const first = Store.open({ dataDir, log: noLog });
  first.db.exec('PRAGMA user_version = 99');
  first.db.exec('DROP INDEX idx_obs_type');
  first.close();
  const logs = [];
  const store = Store.open({ dataDir, log: (m) => logs.push(m) });
  t.after(() => store.close());
  assert.equal(store.db.get('PRAGMA user_version').user_version, 99);
  assert.equal(store.db.get("SELECT count(*) AS n FROM sqlite_master WHERE name = 'idx_obs_type'").n, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /schema version 99 is newer/);
});

test('el fence detecta el reemplazo de la base y el error es permanente', (t) => {
  const store = openTempStore(t);
  assert.equal(store.generationError(), null);
  renameSync(store.dbPath, `${store.dbPath}.old`);
  writeFileSync(store.dbPath, '');
  assert.throws(() => store.db.run('SELECT 1'), DatabaseGenerationChangedError);
  assert.ok(store.generationError() instanceof DatabaseGenerationChangedError);
  assert.throws(() => store.db.get('SELECT 1'), DatabaseGenerationChangedError);
  assert.throws(() => store.db.transaction(() => 1), DatabaseGenerationChangedError);
});

test('arranques simultáneos de varios procesos convergen en la misma identidad', async (t) => {
  const dataDir = join(tempDir(t), 'data');
  const storeUrl = new URL('../../../src/store/index.js', import.meta.url).href;
  const script = `
    import { Store } from ${JSON.stringify(storeUrl)};
    const s = Store.open({ dataDir: process.argv[1], log: () => {} });
    process.stdout.write(s.instanceId);
    s.close();
  `;
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, dataDir]);
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
    });
  const ids = await Promise.all(Array.from({ length: 6 }, run));
  assert.equal(new Set(ids).size, 1);
  assert.ok(isValidInstanceId(ids[0]));
  assert.ok(fileURLToPath(storeUrl));
});
