/**
 * Formato de las marcas de tiempo escritas por la aplicación: UTC con 9 decimales,
 * `YYYY-MM-DD HH:MM:SS.fffffffff`. Se ordenan lexicográficamente igual que
 * cronológicamente. Los `DEFAULT (datetime('now'))` del esquema usan el formato
 * corto sin decimales; ambos conviven en las mismas columnas.
 * @param {Date} [date] instante a formatear; por defecto, ahora.
 * @returns {string}
 */
export function now(date = new Date()) {
  const iso = date.toISOString(); // 2026-10-27T22:00:00.123Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${iso.slice(20, 23)}000000`;
}

/**
 * Formato corto de SQLite (`datetime('now')`): `YYYY-MM-DD HH:MM:SS`.
 * @param {Date} [date]
 * @returns {string}
 */
export function sqliteDatetime(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Espera síncrona sin consumir CPU. Solo para rutas de arranque y reintentos
 * de bloqueo, donde la API de SQLite es síncrona.
 * @param {number} ms
 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
