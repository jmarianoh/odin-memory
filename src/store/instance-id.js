import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { sleepSync } from '../timeutil/index.js';
import { StoreError } from './errors.js';

/**
 * @param {string} id
 * @returns {boolean} true si son exactamente 32 caracteres hexadecimales en minúscula.
 */
export function isValidInstanceId(id) {
  return /^[0-9a-f]{32}$/.test(id);
}

/**
 * Devuelve la identidad de esta instalación, creándola si no existe. La
 * publicación es atómica (enlace duro de un temporal): si varios procesos
 * compiten, todos obtienen el mismo identificador ganador.
 * @param {string} dataDir directorio de datos (se crea si falta)
 * @returns {string} identificador de 32 hexadecimales
 */
export function ensureInstanceId(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o755 });
  const path = join(dataDir, '.instance-id');
  for (let attempt = 0; attempt < 20; attempt++) {
    const existing = readIfPresent(path);
    if (existing !== null) {
      const id = existing.trim();
      if (isValidInstanceId(id)) return id;
      // Identidad incompleta o corrupta: se retira y se vuelve a publicar.
      try {
        unlinkSync(path);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    const id = randomBytes(16).toString('hex');
    const tmp = join(dataDir, `.instance-id-${randomBytes(6).toString('hex')}`);
    const fd = openSync(tmp, 'wx', 0o644);
    try {
      writeSync(fd, `${id}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path);
      return id;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const winner = readIfPresent(path)?.trim();
      if (winner && isValidInstanceId(winner)) return winner;
      sleepSync(5);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // el temporal ya no existe
      }
    }
  }
  throw new StoreError('instance_id_race', 'odin-memory: read instance identity: concurrent initialization did not complete');
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
