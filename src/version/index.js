import { readFileSync } from 'node:fs';

/** Versión del producto, leída de package.json. */
export const VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

/** Versión mínima de Node soportada (mayor). */
export const MIN_NODE_MAJOR = 24;

/**
 * Comprueba que el runtime cumple la versión mínima.
 * @param {string} [nodeVersion] versión de Node, por defecto la del proceso.
 * @returns {boolean}
 */
export function nodeIsSupported(nodeVersion = process.versions.node) {
  return Number.parseInt(nodeVersion.split('.')[0], 10) >= MIN_NODE_MAJOR;
}
