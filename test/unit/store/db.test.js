import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETRY_BACKOFFS_MS, isRetryableLockError, withLockRetry } from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const busy = () => Object.assign(new Error('database is locked'), { errcode: 5 });

test('isRetryableLockError reconoce BUSY y LOCKED, incluidos códigos extendidos', () => {
  assert.equal(isRetryableLockError(Object.assign(new Error('x'), { errcode: 5 })), true);
  assert.equal(isRetryableLockError(Object.assign(new Error('x'), { errcode: 6 })), true);
  assert.equal(isRetryableLockError(Object.assign(new Error('x'), { errcode: 517 })), true); // BUSY_SNAPSHOT
  assert.equal(isRetryableLockError(Object.assign(new Error('x'), { errcode: 19 })), false); // CONSTRAINT
  assert.equal(isRetryableLockError(new Error('database is locked')), true);
  assert.equal(isRetryableLockError(new Error('otra cosa')), false);
  assert.equal(isRetryableLockError('texto'), false);
});

test('withLockRetry reintenta y acaba en éxito', () => {
  let calls = 0;
  const result = withLockRetry(() => {
    calls++;
    if (calls < 4) throw busy();
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 4);
});

test('withLockRetry se rinde tras agotar las esperas', () => {
  let calls = 0;
  assert.throws(
    () => withLockRetry(() => {
      calls++;
      throw busy();
    }),
    /database is locked/,
  );
  assert.equal(calls, RETRY_BACKOFFS_MS.length + 1);
});

test('withLockRetry no reintenta errores que no son de contención', () => {
  let calls = 0;
  assert.throws(() => withLockRetry(() => {
    calls++;
    throw new Error('boom');
  }), /boom/);
  assert.equal(calls, 1);
});

test('transaction confirma al retornar y revierte al lanzar', (t) => {
  const { db } = openTempStore(t);
  db.run("INSERT INTO sessions (id, project, directory) VALUES ('s1', 'p', '/d')");
  assert.equal(db.inTransaction, false);

  const value = db.transaction((tx) => {
    assert.equal(tx.inTransaction, true);
    tx.run("INSERT INTO sessions (id, project, directory) VALUES ('s2', 'p', '/d')");
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(db.get('SELECT count(*) AS n FROM sessions').n, 2);

  assert.throws(() => db.transaction((tx) => {
    tx.run("INSERT INTO sessions (id, project, directory) VALUES ('s3', 'p', '/d')");
    throw new Error('fallo');
  }), /fallo/);
  assert.equal(db.get('SELECT count(*) AS n FROM sessions').n, 2);
  assert.equal(db.inTransaction, false);
});

test('las transacciones anidadas usan savepoints: el fallo interno no revierte lo externo', (t) => {
  const { db } = openTempStore(t);
  db.transaction((tx) => {
    tx.run("INSERT INTO sessions (id, project, directory) VALUES ('a', 'p', '/d')");
    assert.throws(() => tx.transaction((inner) => {
      inner.run("INSERT INTO sessions (id, project, directory) VALUES ('b', 'p', '/d')");
      throw new Error('interno');
    }), /interno/);
    tx.transaction((inner) => inner.run("INSERT INTO sessions (id, project, directory) VALUES ('c', 'p', '/d')"));
  });
  const ids = db.all('SELECT id FROM sessions ORDER BY id').map((r) => r.id);
  assert.deepEqual(ids, ['a', 'c']);
});

test('transaction rechaza una función asíncrona y revierte', (t) => {
  const { db } = openTempStore(t);
  assert.throws(
    () => db.transaction(async (tx) => tx.run("INSERT INTO sessions (id, project, directory) VALUES ('x', 'p', '/d')")),
    /síncrona/,
  );
  assert.equal(db.get('SELECT count(*) AS n FROM sessions').n, 0);
  assert.equal(db.inTransaction, false);
});

test('las claves foráneas están activas', (t) => {
  const { db } = openTempStore(t);
  assert.throws(() => db.run(
    "INSERT INTO observations (session_id, type, title, content) VALUES ('inexistente', 't', 'ti', 'c')",
  ), /FOREIGN KEY/);
});

test('un escritor concurrente real produce un error que isRetryableLockError reconoce', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const store = openTempStore(t);
  const other = new DatabaseSync(store.dbPath, { timeout: 30 });
  t.after(() => other.close());
  store.db.transaction(() => {
    assert.throws(
      () => other.exec('BEGIN IMMEDIATE'),
      (err) => err.errcode === 5 && isRetryableLockError(err),
    );
  });
  other.exec('BEGIN IMMEDIATE; ROLLBACK');
});
