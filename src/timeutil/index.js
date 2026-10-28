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

const STORED_UTC = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.\d+)?$/;
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

/**
 * Interpreta una marca de tiempo guardada: `YYYY-MM-DD HH:MM:SS[.fff]` (UTC) o RFC 3339.
 * @param {string} text
 * @returns {Date|null} null si no tiene ninguno de los dos formatos
 */
export function parseStored(text) {
  const m = STORED_UTC.exec(text);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  if (RFC3339.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Convierte una marca de tiempo guardada (UTC) a la zona horaria configurada
 * (`ODIN_TIMEZONE`, o la local si falta o es inválida) con el formato
 * `YYYY-MM-DD HH:MM:SS`. Un texto que no es una fecha se devuelve tal cual.
 * @param {string} utc
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function formatLocal(utc, env = process.env) {
  const date = parseStored(utc);
  if (date === null) return utc;
  const zone = env.ODIN_TIMEZONE;
  if (zone) {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }).formatToParts(date).map((p) => [p.type, p.value]),
      );
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    } catch {
      // zona desconocida: se usa la local
    }
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
