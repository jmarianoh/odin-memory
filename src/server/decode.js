/**
 * Lectura tolerante del cuerpo JSON de una petición. Imita al decodificador del
 * contrato: se lee solo el primer valor del texto (el resto se ignora salvo que
 * la ruta lo prohíba), las claves se comparan sin distinguir mayúsculas, un
 * `null` deja el campo ausente y un tipo que no corresponde invalida la petición.
 */

/** Cuerpo que no es JSON válido o no tiene la forma esperada. */
export class DecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecodeError';
  }
}

const WS = new Set([' ', '\t', '\n', '\r']);

/** Índice del primer carácter que no es espacio, o `text.length`. */
function skipWhitespace(text, from = 0) {
  let i = from;
  while (i < text.length && WS.has(text[i])) i++;
  return i;
}

/** Fin (exclusivo) del valor compuesto o de la cadena que empieza en `start`. */
function scanCompound(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') {
        inString = false;
        if (depth === 0) return i + 1;
      }
    } else if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new DecodeError('unexpected EOF');
}

/**
 * Primer valor JSON del texto y lo que queda tras él.
 * @param {string} text
 * @returns {{ value: unknown, rest: string }}
 * @throws {DecodeError} texto vacío, truncado o con un valor inválido
 */
export function firstJsonValue(text) {
  const start = skipWhitespace(text);
  if (start >= text.length) throw new DecodeError('EOF');
  const first = text[start];
  let end;
  if (first === '{' || first === '[' || first === '"') {
    end = scanCompound(text, start);
  } else {
    const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(start));
    if (!match) throw new DecodeError(literalMessage(text, start));
    end = start + match[0].length;
  }
  try {
    return { value: JSON.parse(text.slice(start, end)), rest: text.slice(end) };
  } catch (err) {
    throw new DecodeError(err.message);
  }
}

/** Mensaje del decodificador ante un comienzo de valor inválido, incluido un literal mal escrito. */
function literalMessage(text, start) {
  const first = text[start];
  const literal = { t: 'true', f: 'false', n: 'null' }[first];
  if (literal) {
    for (let i = 1; i < literal.length; i++) {
      const c = text[start + i];
      if (c === undefined) return 'unexpected EOF';
      if (c !== literal[i]) return `invalid character '${c}' in literal ${literal} (expecting '${literal[i]}')`;
    }
  }
  return `invalid character '${first}' looking for beginning of value`;
}

/** Nombre del tipo JSON de un valor, como lo cita Go. */
const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);

const CHECKS = {
  string: (v) => typeof v === 'string',
  int: (v) => typeof v === 'number' && Number.isInteger(v),
  float: (v) => typeof v === 'number',
  bool: (v) => typeof v === 'boolean',
  'string[]': (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  'int[]': (v) => Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isInteger(x)),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  any: () => true,
};

/**
 * Convierte un objeto JSON en los campos declarados por `spec`.
 * @param {unknown} value
 * @param {Record<string, keyof typeof CHECKS>} spec nombre de campo → tipo
 * @param {{ strict?: boolean }} [options] `strict` rechaza campos desconocidos
 * @returns {Record<string, unknown>} solo los campos presentes y no nulos
 * @throws {DecodeError}
 */
export function pickFields(value, spec, options = {}) {
  if (value === null) return {};
  if (!CHECKS.object(value)) throw new DecodeError(`json: cannot unmarshal ${kindOf(value)} into Go value of type struct`);
  const byLowerName = new Map(Object.keys(spec).map((name) => [name.toLowerCase(), name]));
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = byLowerName.get(key.toLowerCase());
    if (name === undefined) {
      if (options.strict) throw new DecodeError(`json: unknown field ${JSON.stringify(key)}`);
      continue;
    }
    if (raw === null) continue;
    if (!CHECKS[spec[name]](raw)) {
      throw new DecodeError(`json: cannot unmarshal ${kindOf(raw)} into Go struct field .${name} of type ${spec[name]}`);
    }
    out[name] = raw;
  }
  return out;
}

/**
 * Decodifica el cuerpo (solo el primer valor) en los campos de `spec`.
 * @param {string} body
 * @param {Record<string, keyof typeof CHECKS>} spec
 * @param {{ strict?: boolean, single?: boolean }} [options] `single` exige que no haya nada tras el valor
 * @returns {Record<string, unknown>}
 * @throws {DecodeError}
 */
export function decodeBody(body, spec, options = {}) {
  const { value, rest } = firstJsonValue(body);
  if (options.single && skipWhitespace(rest) < rest.length) throw new DecodeError('trailing data');
  return pickFields(value, spec, options);
}

/** Campos de la evidencia de captura; se rechazan tipos que no corresponden y se aceptan campos futuros. */
export const PROVENANCE_SPEC = { source: 'string', directory: 'string', raw_project: 'string' };
