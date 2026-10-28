import { DecodeError, firstJsonValue } from '../decode.js';
import { BodyTooLargeError, HttpError } from '../http.js';

/** Los flujos compuestos aceptan cuerpos de hasta 1 MiB. */
export const WORKFLOW_BODY_LIMIT = 1 << 20;

/**
 * Cuerpo de un flujo compuesto: exactamente un objeto JSON, sin instrucciones
 * de escritura a continuación.
 * @param {import('../context.js').RequestContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 * @throws {HttpError} 413 si el cuerpo es demasiado grande; 400 si no es un único objeto
 */
export async function decodeWorkflow(ctx) {
  let text;
  try {
    text = await ctx.body(WORKFLOW_BODY_LIMIT);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      throw new HttpError(413, `body exceeds ${WORKFLOW_BODY_LIMIT}-byte limit`, { code: 'request_too_large' });
    }
    throw err;
  }
  let parsed;
  try {
    parsed = firstJsonValue(text);
  } catch (err) {
    if (err instanceof DecodeError) throw new HttpError(400, 'body must be a JSON object', { code: 'invalid_arguments' });
    throw err;
  }
  const { value, rest } = parsed;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'body must be a JSON object', { code: 'invalid_arguments' });
  if (/[^ \t\n\r]/.test(rest)) throw new HttpError(400, 'body must contain exactly one JSON object', { code: 'invalid_arguments' });
  return value;
}
