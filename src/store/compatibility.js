import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, fstatSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { DatabaseGenerationChangedError } from './errors.js';
import { isValidInstanceId } from './instance-id.js';
import { DB_FILE_NAME } from './store.js';
import { SCHEMA_VERSION } from './schema.js';
import { goTrim } from './text.js';

/** Revisión de este contrato (no es una versión de la herramienta ni del esquema). */
export const COMPATIBILITY_REVISION = 1;

const INSTANCE_ID_FILE = '.instance-id';
const FAIL = 'compatibility: unsafe or invalid fixture metadata';

const metadataSnapshot = (dir) => readdirSync(dir).sort().map((name) => {
  const info = lstatSync(join(dir, name), { bigint: true });
  return { name, dev: info.dev, ino: info.ino, mode: info.mode, size: info.size, mtimeNs: info.mtimeNs };
});
const sameMetadata = (a, b) => a.length === b.length && a.every((x, i) => Object.keys(x).every((k) => x[k] === b[i][k]));

/**
 * Observación de solo lectura de un directorio de datos sin abrirlo: lee metadatos
 * del sistema de archivos, la cabecera de SQLite y la identidad local. Nunca abre
 * la base, migra ni repara; el resultado es una observación, no un permiso.
 * @param {string} dir ruta absoluta y limpia
 * @returns {{ revision: number, source: 'offline', status: string, offline_automatic_opening_authorized: boolean, active_reuse_authorized: boolean, instance_id?: string }}
 * @throws {Error} metadatos inseguros o inválidos
 */
export function probeCompatibility(dir) {
  const result = {
    revision: COMPATIBILITY_REVISION, source: 'offline', status: 'unknown', offline_automatic_opening_authorized: false, active_reuse_authorized: false,
  };
  const fail = () => new Error(FAIL);
  if (!isAbsolute(dir) || normalize(dir).replace(/(.)\/+$/, '$1') !== dir) throw fail();
  let canonical;
  try {
    canonical = realpathSync(dir);
  } catch {
    throw fail();
  }
  dir = canonical;
  try {
    if (!lstatSync(dir).isDirectory()) throw fail();
    const before = metadataSnapshot(dir);
    const names = readdirSync(dir);
    let hasDb = false;
    for (const name of names) {
      if (name.endsWith('-wal') || name.endsWith('-shm') || name.endsWith('-journal') || (name.endsWith('.db') && name !== DB_FILE_NAME)) throw fail();
      if (name === DB_FILE_NAME) hasDb = true;
    }
    if (!hasDb) {
      if (names.length !== 0) throw fail();
      result.status = 'fresh';
    } else {
      const dbPath = join(dir, DB_FILE_NAME);
      const dbInfo = lstatSync(dbPath);
      if (!dbInfo.isFile()) throw fail();
      const idInfo = lstatSync(join(dir, INSTANCE_ID_FILE));
      if (!idInfo.isFile() || idInfo.size > 128) throw fail();
      const id = goTrim(readFileSync(join(dir, INSTANCE_ID_FILE), 'utf8'));
      if (!isValidInstanceId(id)) throw fail();
      result.instance_id = id;
      const fd = openSync(dbPath, 'r');
      const header = Buffer.alloc(100);
      let read;
      let opened;
      try {
        read = readSync(fd, header, 0, 100, 0);
        opened = fstatSync(fd);
      } finally {
        closeSync(fd);
      }
      if (read !== 100 || opened.ino !== dbInfo.ino || opened.dev !== dbInfo.dev || header.toString('latin1', 0, 16) !== 'SQLite format 3\0') throw fail();
      // Los bytes 18 y 19 son las versiones de formato (1 = diario, 2 = WAL): la apertura normal usa WAL, así que ambas valen.
      let pageSize = header.readUInt16BE(16);
      if (pageSize === 1) pageSize = 65536;
      const validPage = pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0;
      if (!validPage || dbInfo.size % pageSize !== 0 || ![1, 2].includes(header[18]) || ![1, 2].includes(header[19])) throw fail();
      const schema = header.readUInt32BE(60);
      // La cabecera no prueba la forma: una base existente nunca pasa de «forma desconocida».
      if (schema > SCHEMA_VERSION) result.status = 'future_schema';
      else if (schema < SCHEMA_VERSION) result.status = 'legacy_schema';
      else result.status = 'unknown_shape';
    }
    if (!sameMetadata(before, metadataSnapshot(dir))) throw fail();
  } catch (err) {
    if (err.message === FAIL) throw err;
    throw fail();
  }
  return result;
}

/**
 * Compatibilidad del almacén abierto en este proceso. Solo observa: no abre
 * conexiones ni repara identidades.
 * @param {import('./store.js').Store} store
 */
export function activeCompatibility(store) {
  const result = {
    revision: COMPATIBILITY_REVISION, source: 'active', status: 'unknown', offline_automatic_opening_authorized: false, active_reuse_authorized: false,
  };
  if (!store || store.closed || !store.runtimeId || !isValidInstanceId(store.instanceId ?? '')) return result;
  try {
    store.generation.check();
  } catch (err) {
    if (err instanceof DatabaseGenerationChangedError) return result;
    throw err;
  }
  return {
    ...result, status: 'ready', active_reuse_authorized: true, instance_id: store.instanceId, runtime_id: store.runtimeId, capability: 'startup-verified-store-v1',
  };
}
