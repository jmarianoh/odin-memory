import { chmodSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, dirname, join, resolve, sep } from 'node:path';

const fail = (message) => new Error(`odin server: ${message}`);

/** Directorio de confianza: sin escritura para grupo ni otros, o con sticky y dueño root o el proceso. */
export function trustedSocketDirectory(mode, ownerUid, effectiveUid) {
  if ((mode & 0o022) === 0) return true;
  return (mode & 0o1000) !== 0 && (ownerUid === 0 || ownerUid === effectiveUid);
}

/**
 * Resuelve la jerarquía del directorio padre antes de enlazar para que ningún
 * directorio que pueda nombrar el socket sea reemplazable por otro usuario.
 * @param {string} socketPath
 * @returns {string} ruta canónica del socket
 */
export function secureSocketPath(socketPath) {
  let parent;
  try {
    parent = realpathSync(resolve(dirname(socketPath)));
  } catch (err) {
    throw fail(`resolve socket parent: ${err.message}`);
  }
  const euid = process.geteuid?.() ?? -1;
  const parts = parent.split(sep).filter((p) => p !== '');
  let component = sep;
  for (const name of ['', ...parts]) {
    if (name !== '') component = join(component, name);
    let info;
    try {
      info = lstatSync(component);
    } catch (err) {
      throw fail(`cannot inspect socket parent directory: ${err.message}`);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('socket parent hierarchy contains an unsafe directory');
    if (!trustedSocketDirectory(info.mode, info.uid, euid)) throw fail('socket parent hierarchy is writable by an untrusted user');
  }
  return join(parent, basename(socketPath));
}

/** Intenta conectar al socket: `connected`, `refused`, `missing` u `error`. */
function probe(path, timeoutMs = 250) {
  return new Promise((done) => {
    const socket = connect(path);
    const finish = (state, err) => {
      socket.destroy();
      done({ state, err });
    };
    socket.setTimeout(timeoutMs, () => finish('error', new Error('timeout')));
    socket.once('connect', () => finish('connected'));
    socket.once('error', (err) => {
      if (err.code === 'ECONNREFUSED') finish('refused');
      else if (err.code === 'ENOENT') finish('missing');
      else finish('error', err);
    });
  });
}

/** Borra el socket solo si sigue siendo el que creó este proceso. */
export function removeOwnedSocket(path, expected) {
  if (!path || !expected) return;
  let current;
  try {
    current = lstatSync(path);
  } catch {
    return;
  }
  if (!current.isSocket() || current.ino !== expected.ino || current.dev !== expected.dev) return;
  rmSync(path, { force: true });
}

/**
 * Valida la ruta del socket y limpia uno huérfano de una ejecución anterior.
 * @param {string} socketPath
 * @returns {Promise<string>} ruta canónica lista para enlazar
 */
export async function prepareSocket(socketPath) {
  if (process.platform === 'win32') throw fail('unix sockets are not supported on this platform');
  if (socketPath === '' || socketPath === '.') throw fail('socket path is required');
  const canonical = secureSocketPath(socketPath);
  let info;
  try {
    info = lstatSync(canonical);
  } catch (err) {
    if (err.code === 'ENOENT') return canonical;
    throw fail(`inspect socket ${JSON.stringify(canonical)}: ${err.message}`);
  }
  if (!info.isSocket()) throw fail(`socket path ${JSON.stringify(canonical)} exists and is not a Unix socket`);
  const { state, err } = await probe(canonical);
  if (state === 'connected') throw fail(`socket ${JSON.stringify(canonical)} is already in use`);
  if (state === 'refused') {
    removeOwnedSocket(canonical, info);
    return canonical;
  }
  if (state === 'missing') return canonical;
  throw fail(`cannot verify socket ${JSON.stringify(canonical)} is stale: ${err.message}`);
}

/**
 * Enlaza el socket con permisos 0600 desde el primer instante (máscara restrictiva
 * durante el enlace, que en un proceso de un solo hilo no admite intercalados).
 * @param {import('node:http').Server} server
 * @param {string} path ruta canónica
 * @returns {Promise<import('node:fs').Stats>} identidad del socket creado
 */
export function listenSecure(server, path) {
  return new Promise((done, reject) => {
    const previous = process.umask(0o177);
    const restore = () => process.umask(previous);
    const onError = (err) => {
      restore();
      reject(err);
    };
    server.once('error', onError);
    server.listen(path, () => {
      server.off('error', onError);
      restore();
      try {
        chmodSync(path, 0o600);
        done(lstatSync(path));
      } catch (err) {
        server.close();
        removeOwnedSocket(path, lstatSync(path));
        reject(err);
      }
    });
  });
}
