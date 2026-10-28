import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Quita los comentarios de línea y de bloque, y las comas finales, de un texto JSONC respetando las cadenas.
 * @returns {{ text: string, hadComments: boolean }}
 */
export function stripJsonc(source) {
  let out = '';
  let hadComments = false;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && source[i + 1] === '/') {
      hadComments = true;
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '/' && source[i + 1] === '*') {
      hadComments = true;
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  const text = out.replace(/,(\s*[}\]])/g, '$1');
  return { text, hadComments };
}

/**
 * Lee un archivo JSON (con o sin comentarios). Un archivo ausente o vacío es un objeto vacío.
 * @returns {{ value: object, existed: boolean, hadComments: boolean }}
 * @throws {Error} si el contenido no es un objeto JSON
 */
export function readJsonFile(path) {
  if (!existsSync(path)) return { value: {}, existed: false, hadComments: false };
  const source = readFileSync(path, 'utf8');
  if (source.trim() === '') return { value: {}, existed: true, hadComments: false };
  const { text, hadComments } = stripJsonc(source);
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`cannot parse ${path}: ${err.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must contain a JSON object`);
  return { value, existed: true, hadComments };
}

/** Escritura atómica (archivo temporal y renombrado) creando los directorios que falten. */
export function writeFileAtomic(path, content, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, content, { mode });
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  try {
    chmodSync(path, mode);
  } catch {
    // los permisos son de mejor esfuerzo (p. ej. en Windows)
  }
}

/** JSON con sangría de dos espacios y salto de línea final. */
export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Escribe un archivo si su contenido cambia.
 * @returns {'created'|'updated'|'unchanged'}
 */
export function writeIfChanged(path, content, { mode = 0o644, backupSuffix = null } = {}) {
  const existed = existsSync(path);
  if (existed && readFileSync(path, 'utf8') === content) return 'unchanged';
  if (existed && backupSuffix) writeFileAtomic(`${path}${backupSuffix}`, readFileSync(path, 'utf8'), mode);
  writeFileAtomic(path, content, mode);
  return existed ? 'updated' : 'created';
}
