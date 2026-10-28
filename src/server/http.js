import { toGoJson } from '../store/backup.js';

/** Error de petición que el enrutador convierte en una respuesta JSON `{ "error": … }`. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {Record<string, unknown>} [fields] campos extra de la respuesta
   * @param {Record<string, string>} [headers] cabeceras extra
   */
  constructor(status, message, fields = {}, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.fields = fields;
    this.headers = headers;
  }
}

/** El cuerpo supera el límite que admite la ruta. */
export class BodyTooLargeError extends Error {
  constructor() {
    super('http: request body too large');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Escribe una respuesta JSON como el contrato: cabecera `application/json`,
 * `<`, `>` y `&` escapados y un salto de línea final.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 * @param {Record<string, string>} [headers]
 */
export function sendJson(res, status, data, headers = {}) {
  const body = `${toGoJson(data)}\n`;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}

/** `{ "error": mensaje, …campos }`. */
export function sendError(res, status, message, fields = {}, headers = {}) {
  sendJson(res, status, { error: message, ...fields }, headers);
}

/** Texto plano (`http.Error`): lo usan el 404 y el 405 del enrutador. */
export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(`${text}\n`);
}

/**
 * Entero de un parámetro de consulta; el valor ausente o que no es un entero
 * decimal devuelve `fallback`.
 * @param {URLSearchParams} query
 * @param {string} key
 * @param {number} fallback
 */
export function queryInt(query, key, fallback) {
  const raw = query.get(key);
  if (raw === null || raw === '') return fallback;
  if (!/^[+-]?\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
}

const TRUE_VALUES = new Set(['1', 't', 'T', 'TRUE', 'true', 'True']);
const FALSE_VALUES = new Set(['0', 'f', 'F', 'FALSE', 'false', 'False']);

/** `strconv.ParseBool`: `null` si el texto no es un booleano. */
export function parseBool(text) {
  if (TRUE_VALUES.has(text)) return true;
  if (FALSE_VALUES.has(text)) return false;
  return null;
}

/** Booleano de un parámetro de consulta; ausente o inválido devuelve `fallback`. */
export function queryBool(query, key, fallback) {
  const raw = query.get(key);
  if (raw === null || raw === '') return fallback;
  return parseBool(raw) ?? fallback;
}

/**
 * Lee el cuerpo completo como texto UTF-8.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit] bytes máximos
 * @returns {Promise<string>}
 * @throws {BodyTooLargeError}
 */
export function readBody(req, limit = Infinity) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    const done = (fn, value) => {
      if (finished) return;
      finished = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        done(reject, new BodyTooLargeError());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => done(reject, err));
    req.on('aborted', () => done(reject, new Error('unexpected EOF')));
  });
}
