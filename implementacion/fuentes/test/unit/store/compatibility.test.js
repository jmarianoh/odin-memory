import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { COMPATIBILITY_REVISION, activeCompatibility, probeCompatibility } from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

function dataDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'odin-compat-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const base = { revision: COMPATIBILITY_REVISION, source: 'offline', offline_automatic_opening_authorized: false, active_reuse_authorized: false };

test('un directorio vacío es «fresh» y uno con una base es «unknown_shape» con su identidad', (t) => {
  const empty = dataDir(t);
  assert.deepEqual(probeCompatibility(empty), { ...base, status: 'fresh' });
  const store = openTempStore(t);
  store.close();
  const result = probeCompatibility(store.dataDir);
  assert.equal(result.status, 'unknown_shape');
  assert.equal(result.instance_id, readFileSync(join(store.dataDir, '.instance-id'), 'utf8').trim());
  assert.equal(result.offline_automatic_opening_authorized, false);
});

test('el esquema de la cabecera distingue futuro y heredado', (t) => {
  const store = openTempStore(t);
  store.close();
  const dbPath = join(store.dataDir, 'odin.db');
  for (const [version, status] of [[2, 'future_schema'], [0, 'legacy_schema'], [1, 'unknown_shape']]) {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec(`PRAGMA user_version = ${version}`);
    db.close();
    assert.equal(probeCompatibility(store.dataDir).status, status, `schema ${version}`);
  }
});

test('rechaza rutas y contenidos inseguros con un único mensaje', (t) => {
  const fail = (dir) => assert.throws(() => probeCompatibility(dir), { message: 'compatibility: unsafe or invalid fixture metadata' });
  fail('relativa');
  fail('');
  fail(`${dataDir(t)}/`);
  fail(join(dataDir(t), 'no-existe'));
  const withFile = dataDir(t);
  writeFileSync(join(withFile, 'otro.txt'), 'x');
  fail(withFile);

  for (const name of ['odin.db-wal', 'odin.db-shm', 'odin.db-journal', 'otra.db']) {
    const dir = dataDir(t);
    writeFileSync(join(dir, name), 'x');
    fail(dir);
  }
  const noId = dataDir(t);
  writeFileSync(join(noId, 'odin.db'), Buffer.alloc(4096));
  fail(noId);
  const badId = dataDir(t);
  writeFileSync(join(badId, 'odin.db'), Buffer.alloc(4096));
  writeFileSync(join(badId, '.instance-id'), 'no-es-un-id');
  fail(badId);
  const badHeader = dataDir(t);
  writeFileSync(join(badHeader, 'odin.db'), Buffer.alloc(4096));
  writeFileSync(join(badHeader, '.instance-id'), 'a'.repeat(32));
  fail(badHeader);
  const dbIsDir = dataDir(t);
  mkdirSync(join(dbIsDir, 'odin.db'));
  fail(dbIsDir);

  const store = openTempStore(t);
  store.close();
  const target = dataDir(t);
  const link = join(dataDir(t), 'enlace');
  symlinkSync(target, link);
  assert.deepEqual(probeCompatibility(link).status, 'fresh', 'un alias del directorio se resuelve');
  const linked = dataDir(t);
  symlinkSync(join(store.dataDir, 'odin.db'), join(linked, 'odin.db'));
  writeFileSync(join(linked, '.instance-id'), 'a'.repeat(32));
  fail(linked);
});

test('rechaza una cabecera con tamaño de página o versiones de formato inválidos', (t) => {
  const store = openTempStore(t);
  store.close();
  const header = readFileSync(join(store.dataDir, 'odin.db'));
  const make = (mutate, size = header.length) => {
    const dir = dataDir(t);
    const copy = Buffer.from(header.subarray(0, size));
    mutate(copy);
    writeFileSync(join(dir, 'odin.db'), copy);
    writeFileSync(join(dir, '.instance-id'), 'b'.repeat(32));
    return dir;
  };
  const fail = (dir) => assert.throws(() => probeCompatibility(dir), { message: 'compatibility: unsafe or invalid fixture metadata' });
  assert.equal(probeCompatibility(make(() => {})).status, 'unknown_shape');
  fail(make((b) => b.writeUInt16BE(1000, 16)));
  fail(make((b) => b.writeUInt16BE(256, 16)));
  fail(make((b) => { b[18] = 3; }));
  fail(make((b) => { b[19] = 0; }));
  fail(make(() => {}, header.length - 1));
  // El valor 1 codifica un tamaño de página de 65536 bytes: el archivo debe ser múltiplo de él.
  fail(make((b) => b.writeUInt16BE(1, 16)));
  const big = dataDir(t);
  const page = Buffer.alloc(65536 * 2);
  header.copy(page, 0, 0, 100);
  page.writeUInt16BE(1, 16);
  writeFileSync(join(big, 'odin.db'), page);
  writeFileSync(join(big, '.instance-id'), 'b'.repeat(32));
  assert.equal(probeCompatibility(big).status, 'unknown_shape');
});

test('la compatibilidad activa solo es «ready» mientras el almacén está abierto y sano', (t) => {
  const store = openTempStore(t);
  const active = activeCompatibility(store);
  assert.deepEqual(active, {
    revision: 1, source: 'active', status: 'ready', offline_automatic_opening_authorized: false, active_reuse_authorized: true, instance_id: store.instanceId,
    runtime_id: store.runtimeId, capability: 'startup-verified-store-v1',
  });
  rmSync(store.dbPath);
  assert.throws(() => store.db.get('SELECT 1'));
  assert.equal(activeCompatibility(store).status, 'unknown');
  assert.equal(activeCompatibility(store).active_reuse_authorized, false);
  const other = openTempStore(t);
  other.close();
  assert.equal(activeCompatibility(other).status, 'unknown');
  assert.equal(activeCompatibility(null).status, 'unknown');
});

test('la cabecera exige un tamaño de página potencia de dos y una identidad válida y pequeña', (t) => {
  const store = openTempStore(t);
  store.close();
  const real = readFileSync(join(store.dataDir, 'odin.db'));
  const fail = (dir) => assert.throws(() => probeCompatibility(dir), { message: 'compatibility: unsafe or invalid fixture metadata' });
  const make = (mutate, id = 'b'.repeat(32), size = real.length) => {
    const dir = dataDir(t);
    const copy = Buffer.alloc(size);
    real.copy(copy, 0, 0, Math.min(size, real.length));
    mutate(copy);
    writeFileSync(join(dir, 'odin.db'), copy);
    writeFileSync(join(dir, '.instance-id'), id);
    return dir;
  };
  assert.equal(probeCompatibility(make(() => {})).status, 'unknown_shape');
  fail(make((b) => b.writeUInt16BE(3000, 16), 'b'.repeat(32), 6000));
  fail(make(() => {}, 'no-es-un-identificador-valido'));
  fail(make(() => {}, 'B'.repeat(32)));
  fail(make(() => {}, `${'b'.repeat(32)}${' '.repeat(200)}`));
  assert.equal(probeCompatibility(make(() => {}, `${'b'.repeat(32)}\n`)).instance_id, 'b'.repeat(32));
});
