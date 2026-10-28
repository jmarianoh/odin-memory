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
