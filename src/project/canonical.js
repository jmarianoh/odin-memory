import { goTrim } from '../store/text.js';
import { storeError } from '../store/errors.js';

/**
 * Forma canónica de almacenamiento de un nombre de proyecto: NFC, minúsculas,
 * sin espacios en los extremos y con `--` y `__` colapsados a un solo carácter.
 * Quien acepte entrada externa debe validarla antes con `normalizeProjectName`.
 * @param {string} name
 * @returns {string}
 */
export function canonicalizeProjectName(name) {
  let canonical = goTrim(name.normalize('NFC').toLowerCase()).normalize('NFC');
  while (canonical.includes('--')) canonical = canonical.replaceAll('--', '-');
  while (canonical.includes('__')) canonical = canonical.replaceAll('__', '_');
  return canonical;
}

/**
 * Normaliza un nombre de proyecto ya aceptado. Devuelve el nombre canónico y un
 * aviso (cadena vacía si no cambió).
 * @param {string} project
 * @returns {{ normalized: string, warning: string }}
 */
export function normalizeProject(project) {
  if (!project) return { normalized: '', warning: '' };
  const normalized = canonicalizeProjectName(project);
  if (normalized === project) return { normalized, warning: '' };
  return {
    normalized,
    warning: `⚠️ Project name normalized: ${JSON.stringify(project)} → ${JSON.stringify(normalized)}`,
  };
}

/**
 * Valida y canonicaliza un nombre de proyecto proveniente del exterior.
 * @param {string} name
 * @returns {string}
 * @throws {import('../store/errors.js').StoreError} `invalid_project_name`
 */
export function normalizeProjectName(name) {
  const trimmed = goTrim(name ?? '');
  const reject = (reason) => storeError('invalid_project_name', `${name} (${reason})`);
  if (trimmed === '') throw reject('project is required');
  if (/[/\\]/.test(trimmed)) throw reject('project must be a name, not a path');
  for (const ch of trimmed) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) throw reject('project contains control characters');
  }
  return canonicalizeProjectName(trimmed);
}
