import { formatLocal } from '../timeutil/index.js';

/** Una sola línea de a lo sumo `max` caracteres (por puntos de código), con `...` si se recorta. */
export function truncateStr(text, max) {
  const flat = String(text ?? '').replaceAll('\n', ' ');
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join('')}...`;
}

/** Fecha de revisión `YYYY-MM-DD` a partir de una fecha con o sin hora; lo que no se reconoce se recorta. */
export function formatReviewDate(value) {
  const trimmed = String(value ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(trimmed);
  if (match) return match[1];
  return trimmed.length >= 10 ? trimmed.slice(0, 10) : trimmed;
}

export const localTime = (utc) => formatLocal(utc ?? '');

/**
 * Parte el texto en líneas de a lo sumo `width` caracteres: respeta los saltos de línea, rompe por
 * palabras y corta las palabras que no caben.
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrapLines(text, width) {
  const limit = Math.max(1, width);
  const out = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(' ')) {
      let rest = [...word];
      if (line !== '' && [...line].length + 1 + rest.length <= limit) {
        line += ` ${word}`;
        continue;
      }
      if (line !== '') {
        out.push(line);
        line = '';
      }
      while (rest.length > limit) {
        out.push(rest.slice(0, limit).join(''));
        rest = rest.slice(limit);
      }
      line = rest.join('');
    }
    out.push(line);
  }
  return out;
}

/** Secuencia OSC 52 que pide al terminal copiar `content` al portapapeles: `ESC ] 52 ; c ; <base64> BEL`. */
export const osc52Sequence = (content) => `\x1b]52;c;${Buffer.from(String(content), 'utf8').toString('base64')}\x07`;
