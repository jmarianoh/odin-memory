import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, addObservation, createSession, getObservation, migrateCopy } from '../../../src/store/index.js';

function world(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'odin-copy-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'origen');
  const store = Store.open({ dataDir: source, log: () => {} });
  createSession(store, 's1', 'demo', '/tmp/x');
  const { id } = addObservation(store, { session_id: 's1', type: 'decision', title: 'Guardada', content: 'contenido que debe sobrevivir', project: 'demo' });
  const instanceId = store.instanceId;
  store.close();
  return { root, source, output: join(root, 'destino'), id, instanceId };
}

test('copia el almacén detenido y devuelve el resultado', (t) => {
  const w = world(t);
  const result = migrateCopy(w.source, w.output, true);
  assert.deepEqual(result, { source_dir: w.source, output_dir: w.output, instance_id: w.instanceId, migration_completed: true });
  assert.equal(statSync(w.output).mode & 0o777, 0o700);
  const copied = Store.open({ dataDir: w.output, log: () => {} });
  try {
    assert.equal(copied.instanceId, w.instanceId);
    assert.equal(getObservation(copied, w.id).content, 'contenido que debe sobrevivir');
  } finally {
    copied.close();
  }
  assert.ok(existsSync(join(w.output, 'odin.db')));
  assert.equal(readFileSync(join(w.output, '.instance-id'), 'utf8'), readFileSync(join(w.source, '.instance-id'), 'utf8'));
});

test('exige confirmación y rutas absolutas, limpias y disjuntas', (t) => {
  const w = world(t);
  assert.throws(() => migrateCopy(w.source, w.output, false), { message: '--confirm-quiescent is required; stop every source client first' });
  assert.throws(() => migrateCopy('origen', w.output, true), { message: 'data and output directories must be absolute paths' });
  assert.throws(() => migrateCopy(w.source, 'destino', true), { message: 'data and output directories must be absolute paths' });
  assert.throws(() => migrateCopy(w.source, join(w.source, 'dentro'), true), { message: 'source and output must be disjoint directories' });
  assert.throws(() => migrateCopy(w.source, w.root, true), { message: 'source and output must be disjoint directories' });
  assert.throws(() => migrateCopy(w.source, w.source, true), { message: 'source and output must be disjoint directories' });
  mkdirSync(w.output);
  assert.throws(() => migrateCopy(w.source, w.output, true), { message: 'output directory must not exist' });
  assert.throws(() => migrateCopy(join(w.root, 'nada'), join(w.root, 'otro'), true), { message: `lstat ${join(w.root, 'nada')}: no such file or directory` });
  const file = join(w.root, 'archivo');
  writeFileSync(file, 'x');
  assert.throws(() => migrateCopy(file, join(w.root, 'otro'), true), { message: 'source must be a directory' });
  assert.throws(() => migrateCopy(join(file, 'sub'), join(w.root, 'otro'), true), { message: `lstat ${join(file, 'sub')}: not a directory` });
  const link = join(w.root, 'enlace');
  symlinkSync(w.source, link);
  assert.throws(() => migrateCopy(link, join(w.root, 'otro'), true), { message: `symlink path component is not allowed: ${link}` });
  assert.throws(() => migrateCopy(w.source, join(link, 'x'), true), { message: `symlink path component is not allowed: ${link}` });
});

test('rechaza orígenes sin base, sin identidad válida o con entradas inseguras', (t) => {
  const w = world(t);
  const noDb = join(w.root, 'vacio');
  mkdirSync(noDb);
  assert.throws(() => migrateCopy(noDb, join(w.root, 'o1'), true), { message: 'source has no odin.db' });
  rmSync(join(w.source, '.instance-id'));
  assert.throws(() => migrateCopy(w.source, join(w.root, 'o2'), true), { message: `source instance identity: open ${join(w.source, '.instance-id')}: no such file or directory` });
  writeFileSync(join(w.source, '.instance-id'), 'no-valida');
  assert.throws(() => migrateCopy(w.source, join(w.root, 'o3'), true), { message: 'source instance identity is invalid' });
  writeFileSync(join(w.source, '.instance-id'), 'c'.repeat(32));
  writeFileSync(join(w.source, 'odin.db-journal'), 'x');
  assert.throws(() => migrateCopy(w.source, join(w.root, 'o4'), true), { message: 'rollback journals are not supported: odin.db-journal' });
  rmSync(join(w.source, 'odin.db-journal'));
  symlinkSync('/etc/hosts', join(w.source, 'enlace'));
  assert.throws(() => migrateCopy(w.source, join(w.root, 'o5'), true), { message: `unsafe source entry: ${join(w.source, 'enlace')}` });
});

test('una salida incompleta se conserva y el mensaje lo dice', (t) => {
  const w = world(t);
  const db = new DatabaseSync(join(w.source, 'odin.db'));
  db.exec('CREATE TABLE intrusa (x)');
  db.close();
  assert.throws(() => migrateCopy(w.source, w.output, true), (e) => {
    assert.match(e.message, /^unsupported database catalog; use a core supporting this store's exact shape; incomplete output retained at /);
    assert.ok(e.message.endsWith(`${w.output}; do not use or promote it`));
    return true;
  });
  assert.equal(existsSync(w.output), true, 'la salida no se borra');
});

test('rechaza una cabecera que no es SQLite y un esquema de otra versión', (t) => {
  const w = world(t);
  writeFileSync(join(w.source, 'odin.db'), Buffer.alloc(4096));
  assert.throws(() => migrateCopy(w.source, w.output, true), /invalid database header/);
  const w2 = world(t);
  const db = new DatabaseSync(join(w2.source, 'odin.db'));
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA user_version = 7');
  db.close();
  assert.throws(() => migrateCopy(w2.source, w2.output, true), /unsupported database schema version: 7/);
});

test('conserva permisos y subdirectorios, y no copia el SHM', (t) => {
  const w = world(t);
  mkdirSync(join(w.source, 'extra'));
  writeFileSync(join(w.source, 'extra', 'nota.txt'), 'hola');
  chmodSync(join(w.source, 'extra', 'nota.txt'), 0o640);
  writeFileSync(join(w.source, 'odin.db-shm'), 'cache');
  migrateCopy(w.source, w.output, true);
  assert.equal(readFileSync(join(w.output, 'extra', 'nota.txt'), 'utf8'), 'hola');
  assert.equal(statSync(join(w.output, 'extra', 'nota.txt')).mode & 0o777, 0o640);
  assert.equal(statSync(join(w.output, 'extra')).mode & 0o777, 0o700);
  assert.ok(!readdirSync(w.output).includes('odin.db-shm') || statSync(join(w.output, 'odin.db-shm')).size !== 'cache'.length);
});

test('detecta un origen que cambia mientras se copia o se migra, y una identidad alterada', (t) => {
  const touch = (w) => () => writeFileSync(join(w.source, 'nuevo.txt'), 'x');
  const during = world(t);
  assert.throws(() => migrateCopy(during.source, during.output, true, { afterValidate: touch(during) }), { message: /^source changed during copy; incomplete output retained at / });
  const migrating = world(t);
  assert.throws(() => migrateCopy(migrating.source, migrating.output, true, { afterMigrate: touch(migrating) }), { message: /^source changed during migration; incomplete output retained at / });
  const identity = world(t);
  assert.throws(
    () => migrateCopy(identity.source, identity.output, true, { afterCopy: () => writeFileSync(join(identity.output, '.instance-id'), 'd'.repeat(32)) }),
    { message: /^destination instance identity changed; incomplete output retained at / },
  );
  const clean = world(t);
  assert.equal(migrateCopy(clean.source, clean.output, true, { afterCopy() {}, afterValidate() {}, afterMigrate() {} }).migration_completed, true);
});

test('un alias físico del origen se rechaza aunque los nombres difieran (sistemas sin distinción de mayúsculas)', (t) => {
  const w = world(t);
  const alias = join(w.root, 'ORIGEN');
  if (!existsSync(alias)) return t.skip('el sistema de archivos distingue mayúsculas');
  assert.throws(() => migrateCopy(w.source, join(alias, 'dentro'), true), { message: 'source and output must be disjoint directories' });
});
