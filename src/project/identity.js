import { randomBytes } from 'node:crypto';
import { closeSync, constants, linkSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeProjectName } from './canonical.js';
import { RepositoryBindingError } from './errors.js';

/** Archivo, dentro del directorio común de git, que fija el proyecto del repositorio. */
export const REPOSITORY_BINDING_FILENAME = 'odin-memory-project-identity.json';
export const REPOSITORY_BINDING_VERSION = 1;
/** Origen de un proyecto de git que aún no tiene vínculo (solo en modo de inspección). */
export const SOURCE_UNBOUND_GIT = 'unbound_git';

const bindingPath = (commonDir) => join(commonDir, REPOSITORY_BINDING_FILENAME);

/**
 * Publica `temporary` como `destination` de forma atómica y sin reemplazar: falla
 * con `EEXIST` si el destino ya existe (enlace duro).
 * @param {string} temporary
 * @param {string} destination
 */
export function publishFile(temporary, destination) {
  linkSync(temporary, destination);
}

/** @param {{ version: number, id: string, project: string }} binding */
function validBinding(binding) {
  if (binding === null || typeof binding !== 'object' || typeof binding.project !== 'string' || typeof binding.id !== 'string') return false;
  let project;
  try {
    project = normalizeProjectName(binding.project);
  } catch {
    return false;
  }
  return project === binding.project.normalize('NFC') && binding.version === REPOSITORY_BINDING_VERSION && /^[0-9a-fA-F]{32}$/.test(binding.id);
}

/**
 * Lee el vínculo del repositorio.
 * @param {string} commonDir directorio común de git
 * @returns {{ version: number, id: string, project: string }|null} `null` si no existe
 * @throws {RepositoryBindingError} si existe pero no se puede leer o no es válido
 */
export function readRepositoryBinding(commonDir) {
  let data;
  try {
    data = readFileSync(bindingPath(commonDir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new RepositoryBindingError('cannot read the binding; check Git metadata permissions or configure project_name explicitly');
  }
  let binding;
  try {
    binding = JSON.parse(data);
  } catch {
    binding = null;
  }
  if (!validBinding(binding)) throw new RepositoryBindingError('binding is invalid; configure project_name explicitly before retrying');
  return { ...binding, project: binding.project.normalize('NFC') };
}

/**
 * Devuelve el vínculo del repositorio, creándolo (de forma atómica y privada)
 * con `legacyProject` si no existe. Si varios procesos compiten, todos obtienen
 * el vínculo del que ganó.
 * @param {string} commonDir
 * @param {string} legacyProject nombre canónico a fijar
 * @returns {{ version: number, id: string, project: string }}
 */
export function loadOrCreateRepositoryBinding(commonDir, legacyProject) {
  const existing = readRepositoryBinding(commonDir);
  if (existing) return existing;
  let project;
  try {
    project = normalizeProjectName(legacyProject);
  } catch {
    project = null;
  }
  if (project === null || project !== legacyProject) {
    throw new RepositoryBindingError('cannot establish a canonical project label; configure project_name explicitly');
  }
  const id = randomBytes(16).toString('hex');
  const binding = { version: REPOSITORY_BINDING_VERSION, id, project };
  const path = bindingPath(commonDir);
  const temporary = `${path}.tmp-${id}`;
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (err) {
    throw new RepositoryBindingError(`cannot create the binding; check Git metadata permissions or configure project_name explicitly: ${err.message}`, { cause: err });
  }
  try {
    writeSync(fd, `${JSON.stringify(binding)}\n`);
  } catch {
    closeSync(fd);
    unlinkSync(temporary);
    throw new RepositoryBindingError('cannot persist the binding; check Git metadata permissions or configure project_name explicitly');
  }
  closeSync(fd);
  try {
    publishFile(temporary, path);
    return binding;
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw new RepositoryBindingError(`cannot atomically create the binding; check Git metadata permissions or configure project_name explicitly: ${err.message}`, { cause: err });
    }
    return readRepositoryBinding(commonDir);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // el temporal ya no existe
    }
  }
}
