import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { NetworkFilesystemError, StoreError } from './errors.js';

/**
 * @typedef {'local'|'remote'|'unknown'} FilesystemSupport
 * @typedef {{ type: string, support: FilesystemSupport }} FilesystemInfo
 */

// Números mágicos de f_type en Linux para sistemas de archivos remotos.
const LINUX_REMOTE_MAGIC = new Map([
  [0x6969, 'NFS'],
  [0x517b, 'SMB'],
  [0xff534d42, 'SMB/CIFS'],
  [0xfe534d42, 'SMB/CIFS'],
  [0x73757245, 'Coda'],
  [0x564c, 'NCP'],
  [0x7461636f, 'OCFS2'],
  [0x47504653, 'GPFS'],
]);

const REMOTE_NAMES = new Map([
  ['nfs', 'NFS'],
  ['nfs4', 'NFS'],
  ['cifs', 'SMB/CIFS'],
  ['smb', 'SMB/CIFS'],
  ['smb2', 'SMB/CIFS'],
  ['smbfs', 'SMB/CIFS'],
  ['afpfs', 'AFP'],
  ['webdav', 'WebDAV'],
]);

/**
 * Clasifica un nombre de sistema de archivos. Solo marca como remoto lo que
 * identifica positivamente; el resto es `unknown` y se acepta por compatibilidad.
 * @param {string} name
 * @returns {FilesystemInfo}
 */
export function classifyFilesystemName(name) {
  const key = String(name).trim().toLowerCase();
  const remote = REMOTE_NAMES.get(key);
  if (remote) return { type: remote, support: 'remote' };
  return { type: name, support: 'unknown' };
}

/**
 * Detecta el sistema de archivos de una ruta existente, mejor esfuerzo por plataforma.
 * @param {string} path
 * @param {NodeJS.Platform} [platform]
 * @returns {FilesystemInfo}
 */
export function detectFilesystem(path, platform = process.platform) {
  if (platform === 'linux') {
    const { type } = statfsSync(path);
    const remote = LINUX_REMOTE_MAGIC.get(Number(type));
    return remote ? { type: remote, support: 'remote' } : { type: `0x${Number(type).toString(16)}`, support: 'unknown' };
  }
  if (platform === 'darwin') {
    const real = realpathSync(path);
    const out = execFileSync('mount', { encoding: 'utf8' });
    let best = null;
    for (const line of out.split('\n')) {
      const m = line.match(/^(.*) on (\/.*?) \(([^,)]+)/);
      if (!m) continue;
      const mountPoint = m[2];
      const covers = real === mountPoint || real.startsWith(mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`);
      if (covers && (!best || mountPoint.length > best.mountPoint.length)) best = { mountPoint, fs: m[3] };
    }
    return best ? classifyFilesystemName(best.fs) : { type: 'unknown', support: 'unknown' };
  }
  if (platform === 'win32') {
    return path.startsWith('\\\\') ? { type: 'SMB/CIFS', support: 'remote' } : { type: 'local', support: 'unknown' };
  }
  return { type: 'unknown', support: 'unknown' };
}

let inspector = detectFilesystem;

/**
 * Sustituye el inspector de sistema de archivos (para pruebas).
 * @param {(path: string) => FilesystemInfo} fn
 * @returns {() => void} función que restaura el inspector original
 */
export function setFilesystemInspector(fn) {
  const previous = inspector;
  inspector = fn;
  return () => {
    inspector = previous;
  };
}

/** Sube hasta el primer directorio existente. */
function existingPath(path) {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

/**
 * Valida el directorio de datos: ruta absoluta y sin sistema de archivos remoto.
 * No crea ni modifica nada.
 * @param {string} dataDir
 * @throws {StoreError} `data_dir_not_absolute`
 * @throws {NetworkFilesystemError}
 */
export function validateDataDirectory(dataDir) {
  if (!isAbsolute(dataDir)) {
    throw new StoreError(
      'data_dir_not_absolute',
      `odin-memory: data directory must be an absolute path, got "${dataDir}" — set ODIN_DATA_DIR or ensure your home directory is resolvable`,
    );
  }
  const probe = existingPath(dataDir);
  if (probe === null) return;
  let info;
  try {
    info = inspector(probe);
  } catch {
    return; // un fallo de detección nunca bloquea el arranque
  }
  if (info.support === 'remote') throw new NetworkFilesystemError(dataDir, info.type);
}
