import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE } from '../project/detect.js';

const DISPLAY = `${CONFIG_DIR}/${CONFIG_FILE}`;

function ensureConfigDirectory(path) {
  try {
    mkdirSync(path, { mode: 0o755 });
    return;
  } catch (err) {
    if (err.code !== 'EEXIST') throw new Error(`create ${CONFIG_DIR} directory: ${err.message}`);
  }
  let info;
  try {
    info = lstatSync(path);
  } catch (err) {
    throw new Error(`inspect ${CONFIG_DIR} directory: ${err.message}`);
  }
  if (info.isSymbolicLink()) throw new Error(`${CONFIG_DIR} must be a real directory, not a symlink`);
  if (!info.isDirectory()) throw new Error(`${CONFIG_DIR} must be a directory`);
}

function rejectSymlink(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw new Error(`inspect ${DISPLAY}: ${err.message}`);
  }
  if (info.isSymbolicLink()) throw new Error(`${DISPLAY} must not be a symlink`);
}

function writeAndClose(fd, data) {
  try {
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset);
  } finally {
    closeSync(fd);
  }
}

function createConfig(path, data) {
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`${DISPLAY} already exists (use --force to overwrite)`);
    throw new Error(`write ${DISPLAY}: ${err.message}`);
  }
  try {
    writeAndClose(fd, data);
  } catch (err) {
    rmSync(path, { force: true });
    throw new Error(`write ${DISPLAY}: ${err.message}`);
  }
}

function replaceConfig(path, data) {
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  let published = false;
  try {
    let fd;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (err) {
      throw new Error(`create replacement config: ${err.message}`);
    }
    try {
      fchmodSync(fd, 0o644);
      writeAndClose(fd, data);
    } catch (err) {
      throw new Error(`write replacement config: ${err.message}`);
    }
    try {
      renameSync(temporary, path);
    } catch (err) {
      throw new Error(`publish replacement config: ${err.message}`);
    }
    published = true;
  } finally {
    if (!published) rmSync(temporary, { force: true });
  }
}

/**
 * Crea o reemplaza la configuración de proyecto local del directorio.
 * @param {string} cwd
 * @param {string} data contenido ya serializado
 * @param {boolean} force sobrescribir si existe
 */
export function writeInitConfig(cwd, data, force) {
  const directory = join(cwd, CONFIG_DIR);
  ensureConfigDirectory(directory);
  const path = join(directory, CONFIG_FILE);
  rejectSymlink(path);
  const bytes = Buffer.from(data, 'utf8');
  if (force) replaceConfig(path, bytes);
  else createConfig(path, bytes);
}
