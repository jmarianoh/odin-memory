import { errorResult } from './json.js';

/** Capacidad por defecto de la cola de escritura. */
export const DEFAULT_WRITE_QUEUE_SIZE = 32;

/** La cola está llena: se rechaza la escritura en lugar de acumular trabajo. */
export const WRITE_QUEUE_FULL_MESSAGE = 'odin: mcp write queue is full; retry shortly';

/**
 * Cola de escritura serializada. Toda herramienta que modifica la memoria se
 * ejecuta de una en una, en orden de llegada. Admite como máximo `size` trabajos
 * pendientes o en curso; el siguiente se rechaza al instante.
 *
 * Un trabajo ya iniciado termina siempre y devuelve su resultado: una cancelación
 * posterior no interrumpe una escritura a medias.
 */
export class WriteQueue {
  /** @param {number} [size] */
  constructor(size = DEFAULT_WRITE_QUEUE_SIZE) {
    this.size = size > 0 ? size : DEFAULT_WRITE_QUEUE_SIZE;
    this.pending = 0;
    this.tail = Promise.resolve();
  }

  /**
   * @template T
   * @param {() => T|Promise<T>} run
   * @returns {Promise<T>}
   * @throws {Error} `WRITE_QUEUE_FULL_MESSAGE` si no hay hueco
   */
  do(run) {
    if (this.pending >= this.size) return Promise.reject(new Error(WRITE_QUEUE_FULL_MESSAGE));
    this.pending++;
    const result = this.tail.then(run);
    this.tail = result.then(() => {}, () => {}).finally(() => {
      this.pending--;
    });
    return result;
  }
}

/**
 * Envuelve el manejador de una herramienta de escritura para que pase por la
 * cola. Una cola llena se informa como error de herramienta; cualquier otro fallo
 * se propaga.
 * @param {WriteQueue} queue
 * @param {(args: object) => object|Promise<object>} handler
 */
export function queuedWriteHandler(queue, handler) {
  return async (args) => {
    try {
      return await queue.do(() => handler(args));
    } catch (err) {
      if (err?.message === WRITE_QUEUE_FULL_MESSAGE) return errorResult(`MCP write queue error: ${err.message}`);
      throw err;
    }
  };
}
