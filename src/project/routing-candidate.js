import { basename, normalize } from 'node:path';
import { SOURCE_EXPLICIT_OVERRIDE, SOURCE_GIT_ROOT } from './detect.js';
import { RESOLUTION_EXPLICIT, resolve } from './resolution.js';

/**
 * Proyecto candidato con el que enrutar un registro: la designación explícita o,
 * si no hay, el nombre de la raíz de git. Sin ninguna de las dos, la clave queda vacía.
 * @param {{ designation?: string, git_root?: string, directory?: string }} input
 * @returns {{ key: string, source: string, directory: string, raw_project: string }}
 * @throws {Error} si el nombre no es válido (con `candidate` en la propiedad `candidate`)
 */
export function deriveRoutingCandidate(input) {
  const candidate = { key: '', source: 'unknown', directory: input.directory ?? '', raw_project: input.designation ?? '' };
  try {
    if (input.designation) {
      candidate.key = resolve({ mode: RESOLUTION_EXPLICIT, explicit: input.designation }).project;
      candidate.source = SOURCE_EXPLICIT_OVERRIDE;
    } else if (input.git_root) {
      candidate.key = resolve({ mode: RESOLUTION_EXPLICIT, explicit: basename(normalize(input.git_root)) }).project;
      candidate.source = SOURCE_GIT_ROOT;
    }
  } catch (err) {
    throw Object.assign(err, { candidate });
  }
  return candidate;
}
