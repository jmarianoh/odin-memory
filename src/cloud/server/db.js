import pg from 'pg';

/**
 * Envoltorio mínimo del pool de Postgres: consultas y transacciones.
 * Las consultas devuelven las filas (`rows`).
 */
export class Database {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
  }

  /** @param {string} dsn @param {{ max?: number }} [options] */
  static connect(dsn, { max = 10 } = {}) {
    const pool = new pg.Pool({ connectionString: dsn, max });
    // Un cliente ocioso que falla no debe tumbar el proceso.
    pool.on('error', () => {});
    return new Database(pool);
  }

  /** @returns {Promise<any[]>} */
  async query(text, params = []) {
    return (await this.pool.query(text, params)).rows;
  }

  /**
   * Ejecuta `fn` dentro de una transacción; la deshace si falla.
   * @template T
   * @param {(tx: { query: (text: string, params?: unknown[]) => Promise<any[]> }) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({ query: async (text, params = []) => (await client.query(text, params)).rows });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // la conexión ya está rota; se descarta con el error original
      }
      throw err;
    } finally {
      client.release();
    }
  }

  close() {
    return this.pool.end();
  }
}

/** Código de Postgres de una violación de unicidad. */
export const isUniqueViolation = (err) => err?.code === '23505';
