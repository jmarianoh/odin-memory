/** El archivo de base de datos fue reemplazado mientras el proceso estaba en marcha. */
export class DatabaseGenerationChangedError extends Error {
  constructor() {
    super('Database generation changed; restart odin');
    this.name = 'DatabaseGenerationChangedError';
    this.code = 'database_generation_changed';
  }
}

/** El directorio de datos está en un sistema de archivos remoto (WAL inseguro). */
export class NetworkFilesystemError extends Error {
  /**
   * @param {string} dataDir
   * @param {string} filesystem
   */
  constructor(dataDir, filesystem) {
    super(
      `odin-memory: data directory "${dataDir}" is on ${filesystem}; persistent SQLite WAL is unsafe on network filesystems — set ODIN_DATA_DIR to a local directory`,
    );
    this.name = 'NetworkFilesystemError';
    this.code = 'network_filesystem';
    this.dataDir = dataDir;
    this.filesystem = filesystem;
  }
}

/** Error de uso del store con código estable. */
export class StoreError extends Error {
  /**
   * @param {string} code identificador estable en snake_case
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}
