import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { goTrim } from '../store/text.js';
import { processProjectResult, resolveWriteProjectWithChoice, resolveWriteProjectWithChoiceAndProcessOverride } from './write-projects.js';

// El contexto de workspace pertenece a una sola llamada: nunca cambia el cwd del proceso ni la
// autoridad del descubrimiento o de la escritura de otro cliente. Se conservan los bytes de la ruta.

/**
 * Directorio de workspace de `mem_save_prompt` (`directory`, o su alias `cwd`).
 * @param {Record<string, unknown>} args
 * @returns {{ directory: string, error: string|null }} `directory` vacío si no se indicó ninguno
 */
export function promptWorkspaceDirectory(args) {
  for (const key of ['directory', 'cwd']) {
    if (!Object.hasOwn(args, key)) continue;
    const directory = args[key];
    if (typeof directory !== 'string') return { directory: '', error: `${key} must be a string` };
    if (goTrim(directory) === '') continue;
    if (!isAbsolute(directory)) return { directory: '', error: `${key} must be an absolute directory` };
    let info;
    try {
      info = statSync(directory);
    } catch (err) {
      const cause = err.code === 'ENOENT' ? 'no such file or directory' : err.code === 'ENOTDIR' ? 'not a directory' : err.message;
      return { directory: '', error: `${key} is unavailable: stat ${directory}: ${cause}` };
    }
    if (!info.isDirectory()) return { directory: '', error: `${key} must name a directory` };
    return { directory, error: null };
  }
  return { directory: '', error: null };
}

/** Proyecto de escritura de un prompt: el fijado para el proceso manda; si no, se detecta en `directory`. */
export function resolvePromptWorkspaceProject(ctx, directory, choice, reason, validateToken) {
  if (directory === '') return resolveWriteProjectWithChoiceAndProcessOverride(ctx, choice, reason, validateToken);
  const fixed = processProjectResult(ctx);
  if (fixed.ok) return { res: fixed.res, err: fixed.err };
  return resolveWriteProjectWithChoice(ctx, choice, reason, validateToken, directory);
}
