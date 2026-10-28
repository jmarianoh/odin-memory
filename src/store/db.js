import { DatabaseSync } from 'node:sqlite';
import { sleepSync } from '../timeutil/index.js';
import { registerSqlFunctions } from './relation-udf.js';

/** Códigos primarios de SQLite que indican contención y admiten reintento. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** Esperas (ms) entre reintentos ante contención. */
export const RETRY_BACKOFFS_MS = [10, 25, 50, 100, 200];

/**
 * @param {unknown} err
 * @returns {boolean} true si el error es contención de SQLite (BUSY/LOCKED).
 */
export function isRetryableLockError(err) {
  if (!(err instanceof Error)) return false;
  const code = /** @type {{ errcode?: number }} */ (err).errcode;
  if (typeof code === 'number') {
    const primary = code & 0xff;
    return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
  }
  return /database is locked|database is busy|sqlite_busy|sqlite_locked/i.test(err.message);
}

/**
 * Ejecuta fn reintentando ante contención con las esperas de RETRY_BACKOFFS_MS.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function withLockRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isRetryableLockError(err) || attempt >= RETRY_BACKOFFS_MS.length) throw err;
      sleepSync(RETRY_BACKOFFS_MS[attempt]);
    }
  }
}

/**
 * Conexión SQLite con fence de generación y transacciones inmediatas.
 * Una sola conexión por proceso; toda escritura serializa por BEGIN IMMEDIATE.
 */
export class Database {
  /** @type {DatabaseSync} */ #raw;
  /** @type {import('./generation.js').DatabaseGeneration|null} */ #generation;
  #depth = 0;

  /**
   * @param {DatabaseSync} raw
   * @param {import('./generation.js').DatabaseGeneration|null} generation
   */
  constructor(raw, generation) {
    this.#raw = raw;
    this.#generation = generation;
  }

  /** Conexión nativa; solo para código de infraestructura (funciones, pragmas). */
  get raw() {
    return this.#raw;
  }

  get inTransaction() {
    return this.#raw.isTransaction;
  }

  /** Las lecturas no se sondean durante el arranque; las escrituras siempre. */
  #fenceRead() {
    this.#generation?.checkRead();
  }

  #fenceWrite() {
    this.#generation?.check();
  }

  /** @param {string} sql */
  exec(sql) {
    this.#fenceWrite();
    this.#raw.exec(sql);
  }

  /**
   * @param {string} sql
   * @param {...any} params
   * @returns {{ changes: number|bigint, lastInsertRowid: number|bigint }}
   */
  run(sql, ...params) {
    this.#fenceWrite();
    return this.#raw.prepare(sql).run(...params);
  }

  /**
   * @param {string} sql
   * @param {...any} params
   * @returns {Record<string, any>|undefined}
   */
  get(sql, ...params) {
    this.#fenceRead();
    return this.#raw.prepare(sql).get(...params);
  }

  /**
   * @param {string} sql
   * @param {...any} params
   * @returns {Record<string, any>[]}
   */
  all(sql, ...params) {
    this.#fenceRead();
    return this.#raw.prepare(sql).all(...params);
  }

  /**
   * Ejecuta fn dentro de una transacción `BEGIN IMMEDIATE` (o de un savepoint si
   * ya hay una abierta). Confirma si fn retorna; revierte si lanza. fn debe ser
   * síncrona: una promesa devuelta se rechaza y la transacción se revierte.
   * @template T
   * @param {(db: Database) => T} fn
   * @returns {T}
   */
  transaction(fn) {
    this.#fenceWrite();
    const nested = this.#depth > 0;
    const savepoint = `odin_sp_${this.#depth}`;
    this.#raw.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.#depth++;
    try {
      const result = fn(this);
      if (result && typeof (/** @type {any} */ (result).then) === 'function') {
        throw new TypeError('transaction(fn): fn debe ser síncrona');
      }
      this.#raw.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (err) {
      try {
        this.#raw.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      } catch {
        // la transacción ya fue cerrada por SQLite
      }
      throw err;
    } finally {
      this.#depth--;
    }
  }

  /**
   * Transacción de escritura con reintentos ante contención. Solo la más externa
   * reintenta: dentro de una transacción abierta se comporta como `transaction`.
   * @template T
   * @param {(db: Database) => T} fn
   * @returns {T}
   */
  writeTransaction(fn) {
    if (this.#depth > 0) return this.transaction(fn);
    return withLockRetry(() => this.transaction(fn));
  }

  close() {
    this.#raw.close();
  }
}

/**
 * Abre la base con los pragmas de sesión: WAL, sincronía NORMAL, claves foráneas
 * y espera de bloqueo de 5 s. La conmutación a WAL se reintenta, porque arranques
 * simultáneos compiten por la conversión del diario.
 * @param {string} dbPath
 * @param {import('./generation.js').DatabaseGeneration|null} generation
 * @returns {Database}
 */
export function openDatabase(dbPath, generation) {
  const raw = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    withLockRetry(() => {
      raw.exec('PRAGMA busy_timeout = 5000');
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA synchronous = NORMAL');
      raw.exec('PRAGMA foreign_keys = ON');
    });
    registerSqlFunctions(raw);
  } catch (err) {
    raw.close();
    throw err;
  }
  return new Database(raw, generation);
}
