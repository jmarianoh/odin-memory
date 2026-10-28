import { closeSync, openSync, statSync } from 'node:fs';
import { DatabaseGenerationChangedError } from './errors.js';

/**
 * Detecta que los archivos SQLite (base, -wal, -shm) fueron reemplazados
 * mientras el proceso estaba en marcha, comparando dispositivo e inodo con los
 * observados al arrancar. Una vez detectado, el error es permanente.
 */
export class DatabaseGeneration {
  /** @type {string[]} */ #paths;
  /** @type {({ dev: bigint, ino: bigint }|null)[]} */ #files;
  /** @type {Error|null} */ #error = null;
  #startupReads = false;

  /**
   * @param {string} dbPath ruta de la base; debe existir.
   */
  constructor(dbPath) {
    this.#paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    this.#files = [null, null, null];
    this.check();
  }

  /** Error permanente ya observado, sin tocar el sistema de archivos. */
  get error() {
    return this.#error;
  }

  /**
   * Verifica los archivos. La base debe existir; -wal y -shm pueden no existir
   * hasta que se observen por primera vez.
   * @throws {DatabaseGenerationChangedError}
   */
  check() {
    if (this.#error) throw this.#error;
    for (let i = 0; i < this.#paths.length; i++) {
      let info;
      try {
        info = statSync(this.#paths[i], { bigint: true });
      } catch (err) {
        if (err.code === 'ENOENT') {
          if (i > 0 && this.#files[i] === null) continue;
          this.#error = new DatabaseGenerationChangedError();
          throw this.#error;
        }
        throw err;
      }
      const seen = this.#files[i];
      if (seen === null) {
        this.#files[i] = { dev: info.dev, ino: info.ino };
      } else if (seen.dev !== info.dev || seen.ino !== info.ino) {
        this.#error = new DatabaseGenerationChangedError();
        throw this.#error;
      }
    }
  }

  /** Como `check()`, salvo durante el arranque, donde las lecturas no se sondean. */
  checkRead() {
    if (!this.#startupReads) this.check();
  }

  /**
   * Ejecuta fn con las lecturas sin sondeo, verificando antes y después.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  withStartupChecks(fn) {
    this.check();
    this.#startupReads = true;
    try {
      return fn();
    } finally {
      this.#startupReads = false;
      this.check();
    }
  }
}

/**
 * Crea el archivo de base si no existe, sin truncarlo.
 * @param {string} path
 */
export function ensureDatabaseFile(path) {
  closeSync(openSync(path, 'a', 0o600));
}
