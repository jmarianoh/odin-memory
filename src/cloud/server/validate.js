import { goTrim } from '../../store/text.js';

const blank = (v) => goTrim(typeof v === 'string' ? v : '') === '';

/**
 * Cada fila de un chunk trae los campos obligatorios de su entidad.
 * @param {object} chunk el chunk ya analizado
 * @throws {Error} con la fila y el campo que faltan
 */
export function validateChunkRows(chunk) {
  (chunk.sessions ?? []).forEach((s, i) => {
    if (blank(s.id)) throw new Error(`sessions[${i}].id is required`);
    if (blank(s.directory) && s.ownership_mode !== 'project_owned') throw new Error(`sessions[${i}].directory is required`);
  });
  (chunk.observations ?? []).forEach((o, i) => {
    for (const field of ['sync_id', 'session_id', 'type', 'title', 'content', 'scope']) {
      if (blank(o[field])) throw new Error(`observations[${i}].${field} is required`);
    }
  });
  (chunk.prompts ?? []).forEach((p, i) => {
    for (const field of ['sync_id', 'session_id', 'content']) {
      if (blank(p[field])) throw new Error(`prompts[${i}].${field} is required`);
    }
  });
}
