import { timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';

const REALM = { 'WWW-Authenticate': 'Bearer realm="odin-memory"' };

/** Igualdad en tiempo constante; las longitudes distintas ya no coinciden. */
export function constantTimeEqual(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Exige `Authorization: Bearer <ODIN_HTTP_TOKEN>` cuando la variable está
 * definida; sin ella el acceso queda abierto (cero configuración). La variable
 * se lee en cada petición, de modo que cambiarla no requiere reiniciar.
 * @param {import('./context.js').RequestContext} ctx
 * @throws {HttpError} 401
 */
export function requireAuth(ctx) {
  if (ctx.sessionOwned) return;
  const token = ctx.env.ODIN_HTTP_TOKEN ?? '';
  if (token === '') return;
  const header = ctx.req.headers.authorization ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) throw new HttpError(401, 'authorization required', {}, REALM);
  if (!constantTimeEqual(header.slice(prefix.length), token)) throw new HttpError(401, 'invalid token', {}, REALM);
}

/**
 * Como `requireAuth`, pero rechaza con 503 si el servidor no tiene token
 * configurado: reservado a operaciones que nunca deben usar el acceso abierto.
 * @param {import('./context.js').RequestContext} ctx
 */
export function requireConfiguredAuth(ctx) {
  if (ctx.sessionOwned) return;
  if ((ctx.env.ODIN_HTTP_TOKEN ?? '') === '') throw new HttpError(503, 'server authorization is not configured');
  requireAuth(ctx);
}
