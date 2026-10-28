import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateDataDirectory } from './data-dir.js';
import { openDatabase } from './db.js';
import { DatabaseGeneration, ensureDatabaseFile } from './generation.js';
import { ensureInstanceId } from './instance-id.js';
import { runStartupMigrations } from './migrate.js';

/** Nombre del archivo de base de datos dentro del directorio de datos. */
export const DB_FILE_NAME = 'odin.db';

/**
 * @typedef {object} StoreConfig
 * @property {string} dataDir ruta absoluta del directorio de datos
 * @property {(message: string) => void} [log] destino de avisos; por defecto stderr
 * @property {number} [maxObservationLength] bytes máximos de contenido (por defecto 50000)
 * @property {number} [maxContextResults] resultados por defecto en contexto y listados (20)
 * @property {number} [maxSearchResults] resultados máximos de búsqueda (20)
 * @property {number} [dedupeWindowMs] ventana de deduplicación en ms (900000 = 15 min)
 * @property {() => Date} [now] reloj del historial de contexto (solo pruebas)
 */

/** Valores por defecto de los límites configurables. */
export const DEFAULT_SETTINGS = Object.freeze({
  maxObservationLength: 50_000,
  maxContextResults: 20,
  maxSearchResults: 20,
  dedupeWindowMs: 15 * 60 * 1000,
});

/** Almacén de memoria: base SQLite con FTS5 e identidad de instalación. */
export class Store {
  /**
   * @param {StoreConfig} config
   * @param {import('./db.js').Database} db
   * @param {DatabaseGeneration} generation
   * @param {string} instanceId
   */
  constructor(config, db, generation, instanceId) {
    this.config = config;
    /** Límites efectivos: los de `config` sobre los valores por defecto. */
    this.settings = {
      maxObservationLength: config.maxObservationLength ?? DEFAULT_SETTINGS.maxObservationLength,
      maxContextResults: config.maxContextResults ?? DEFAULT_SETTINGS.maxContextResults,
      maxSearchResults: config.maxSearchResults ?? DEFAULT_SETTINGS.maxSearchResults,
      dedupeWindowMs: config.dedupeWindowMs ?? DEFAULT_SETTINGS.dedupeWindowMs,
      now: config.now,
    };
    this.db = db;
    this.generation = generation;
    this.instanceId = instanceId;
    /** Identificador del proceso en ejecución; cambia en cada apertura. */
    this.runtimeId = randomBytes(16).toString('hex');
    /** El almacén ya se cerró. */
    this.closed = false;
  }

  /**
   * Abre (y crea o migra si hace falta) el almacén del directorio de datos.
   * @param {StoreConfig} config
   * @returns {Store}
   */
  static open(config) {
    validateDataDirectory(config.dataDir);
    mkdirSync(config.dataDir, { recursive: true, mode: 0o755 });
    const log = config.log ?? ((m) => process.stderr.write(`${m}\n`));
    const instanceId = ensureInstanceId(config.dataDir);
    const dbPath = join(config.dataDir, DB_FILE_NAME);
    ensureDatabaseFile(dbPath);
    const generation = new DatabaseGeneration(dbPath);
    const db = openDatabase(dbPath, generation);
    try {
      runStartupMigrations(db, generation, log);
    } catch (err) {
      db.close();
      throw err;
    }
    return new Store({ ...config, log }, db, generation, instanceId);
  }

  get dataDir() {
    return this.config.dataDir;
  }

  get dbPath() {
    return join(this.config.dataDir, DB_FILE_NAME);
  }

  /** Error permanente de generación ya observado, o null. */
  generationError() {
    return this.generation.error;
  }

  close() {
    this.closed = true;
    this.db.close();
  }
}
