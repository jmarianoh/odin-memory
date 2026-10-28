/**
 * Serializa a JSON como el protocolo espera: claves de objeto en orden alfabético
 * y `<`, `>`, `&`, U+2028 y U+2029 escapados (`<`…), de modo que el texto sea
 * seguro dentro de HTML y estable entre ejecuciones.
 * @param {unknown} value
 * @returns {string}
 */
export function jsonMarshal(value) {
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sorted(value))
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

/** Resultado de herramienta con un único bloque de texto. */
export const textResult = (text) => ({ content: [{ type: 'text', text }] });

/** Resultado de herramienta que informa un error de uso (no un fallo del protocolo). */
export const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true });

const GO_ESCAPES = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/**
 * Cita una cadena como el verbo `%q` de Go (`strconv.Quote`): comillas dobles,
 * escapes cortos (`\n`, `\t`…), `\xNN` para otros controles y `\uNNNN` /
 * `\UNNNNNNNN` para lo no imprimible. Los caracteres Unicode imprimibles se
 * conservan tal cual. Se usa en los mensajes que citan valores del usuario.
 * @param {string} text
 * @returns {string}
 */
export function goQuote(text) {
  let out = '"';
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (GO_ESCAPES[cp]) out += GO_ESCAPES[cp];
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else if (cp >= 0xd800 && cp <= 0xdfff) out += '�'; // sustituto suelto: Go lo ve como U+FFFD
    else if (PRINTABLE.test(ch)) out += ch;
    else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += `\\U${cp.toString(16).padStart(8, '0')}`;
  }
  return `${out}"`;
}
