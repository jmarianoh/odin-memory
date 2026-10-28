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
