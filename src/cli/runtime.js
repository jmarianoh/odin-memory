import { readSync } from 'node:fs';

/** Fin del programa con un código de salida; lo lanzan `fatal` y `exit` y lo captura `run`. */
export class CliExit extends Error {
  /** @param {number} code */
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'CliExit';
    this.code = code;
  }
}

/**
 * Lee una línea de la entrada estándar de forma síncrona (sin el salto final).
 * Devuelve `null` en EOF sin ningún carácter.
 * @param {number} [fd]
 * @returns {string|null}
 */
export function readLineSync(fd = 0) {
  const chunks = [];
  const byte = Buffer.alloc(1);
  for (;;) {
    let n;
    try {
      n = readSync(fd, byte, 0, 1, null);
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      if (err.code === 'EOF') break;
      throw err;
    }
    if (n === 0) break;
    if (byte[0] === 0x0a) return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
    chunks.push(Buffer.from(byte));
  }
  return chunks.length === 0 ? null : Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
}

/**
 * Contexto de ejecución de un comando: argumentos, entorno y canales de E/S.
 * Todo es inyectable para poder probar los flujos sin tocar el proceso real.
 * @typedef {object} Cli
 * @property {string[]} args argumentos tras el nombre del programa (`args[0]` es el comando)
 * @property {NodeJS.ProcessEnv} env
 * @property {() => string} cwd
 * @property {(text: string) => void} out escribe en la salida estándar
 * @property {(text: string) => void} err escribe en el error estándar
 * @property {() => string|null} readLine lee una línea de la entrada (`null` en EOF)
 * @property {(config: { dataDir: string }) => import('../store/store.js').Store} openStore
 * @property {object} [mcp] sobrescrituras del servidor MCP (pruebas): `input`, `output`, `graceMs`, `processRef`
 * @property {object} [serve] sobrescrituras de `odin serve` (pruebas): `input`, `processRef`, `signal`, `graceMs`, `log`, `ready`
 */

/** `fmt.Println`. */
export const println = (cli, text = '') => cli.out(`${text}\n`);

/** Imprime `odin: <mensaje>` en el error estándar y termina con código 1. */
export function fatal(cli, error) {
  const message = error instanceof Error ? error.message : String(error);
  cli.err(`odin: ${message}\n`);
  throw new CliExit(1);
}

/** Termina con el código dado. */
export function exit(code) {
  throw new CliExit(code);
}

/**
 * Abre el almacén, ejecuta `fn` y lo cierra siempre.
 * @template T
 * @param {Cli} cli
 * @param {{ dataDir: string }} config
 * @param {(store: import('../store/store.js').Store) => T} fn
 * @returns {T}
 */
export function withStore(cli, config, fn) {
  let store;
  try {
    store = cli.openStore(config);
  } catch (err) {
    return fatal(cli, err);
  }
  try {
    return fn(store);
  } finally {
    try {
      store.close();
    } catch {
      // cerrar es de mejor esfuerzo
    }
  }
}

/** Cadena recortada a `max` caracteres (por puntos de código) más `...`. */
export function truncate(text, max) {
  const runes = [...text];
  return runes.length <= max ? text : `${runes.slice(0, max).join('')}...`;
}

/** Relleno a la derecha por puntos de código (`%-Ns`). */
export function padRight(text, width) {
  const length = [...text].length;
  return length >= width ? text : text + ' '.repeat(width - length);
}

/** Relleno a la izquierda (`%Nd`/`%Ns`). */
export function padLeft(text, width) {
  const length = [...String(text)].length;
  return length >= width ? String(text) : ' '.repeat(width - length) + String(text);
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * Entero decimal con signo opcional y rango de 64 bits (`strconv.ParseInt`/`Atoi`).
 * @param {string} text
 * @returns {number|null} `null` si no es un entero válido
 */
export function parseInt64(text) {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = BigInt(text);
  if (value < INT64_MIN || value > INT64_MAX) return null;
  return Number(value);
}

/** Pasa el texto por `fmt.Sscanf("%d")`: entero al inicio, o `null`. */
export function scanLeadingInt(text) {
  const match = /^\s*([+-]?\d+)/.exec(text);
  return match === null ? null : parseInt64(match[1]);
}

const ERRNO_TEXT = {
  ENOENT: 'no such file or directory',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EISDIR: 'is a directory',
  ENOTDIR: 'not a directory',
  EEXIST: 'file exists',
  ENOSPC: 'no space left on device',
  EROFS: 'read-only file system',
};

/**
 * Texto de un error de archivo al estilo `<operación> <ruta>: <causa>`
 * (`open /x: no such file or directory`), igual en todas las plataformas.
 * @param {NodeJS.ErrnoException} err
 * @param {string} path
 * @returns {string}
 */
export function fsErrorText(err, path) {
  const reason = ERRNO_TEXT[err.code];
  return reason === undefined ? err.message : `${err.syscall ?? 'open'} ${path}: ${reason}`;
}
