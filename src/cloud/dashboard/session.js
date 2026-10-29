import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { goTrim } from '../../store/text.js';

/**
 * Sesión del panel: una cookie firmada con HMAC-SHA256 que lleva la identidad ya verificada (nunca el token).
 * Formato: `base64url(JSON).base64url(firma)`, vigente 8 horas.
 */

export const SESSION_COOKIE = 'odin_dashboard_session';
export const SESSION_TTL_SECONDS = 8 * 3600;
const SESSION_VERSION = 1;
const KEY_DOMAIN = 'odin-dashboard-session-key:v1';
const SIGN_DOMAIN = 'odin-dashboard-principal-session:v1:';

export class DashboardSessions {
  #key;

  /** @param {string} [secret] secreto del servidor; sin él cada arranque usa una clave aleatoria */
  constructor(secret = '') {
    this.#key = goTrim(secret) === '' ? randomBytes(32) : createHmac('sha256', secret).update(KEY_DOMAIN).digest();
  }

  #sign(payloadPart) {
    return createHmac('sha256', this.#key).update(SIGN_DOMAIN).update(payloadPart).digest();
  }

  /** Cookie para un principal ya autenticado. @param {object} principal */
  mint(principal, now = Date.now()) {
    const issuedAt = Math.floor(now / 1000);
    const claims = {
      principal_id: goTrim(principal.id), principal_source: principal.source, kind: principal.kind, role: principal.role, display_name: goTrim(principal.displayName ?? ''),
      iat: issuedAt, exp: issuedAt + SESSION_TTL_SECONDS, session_version: SESSION_VERSION, ...(goTrim(principal.tokenId ?? '') === '' ? {} : { token_id: goTrim(principal.tokenId) }),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${this.#sign(payload).toString('base64url')}`;
  }

  /** Principal que la cookie afirma, o `null` si es ilegible, está alterada o caducó. */
  parse(token, now = Date.now()) {
    const parts = goTrim(token ?? '').split('.');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
    const provided = Buffer.from(parts[1], 'base64url');
    const expected = this.#sign(parts[0]);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (claims === null || typeof claims !== 'object' || claims.session_version !== SESSION_VERSION || !(claims.exp > Math.floor(now / 1000))) return null;
    const text = (value) => (typeof value === 'string' ? goTrim(value) : '');
    const principal = { id: text(claims.principal_id), kind: text(claims.kind), displayName: text(claims.display_name), role: text(claims.role), enabled: true, source: text(claims.principal_source), tokenId: text(claims.token_id) };
    return principal.id === '' || principal.source === '' || principal.role === '' ? null : principal;
  }
}

/** Valor de una cookie de la petición. */
export function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

/** ¿Llegó la petición por HTTPS (directo o tras un proxy)? */
export function isSecureRequest(req) {
  if (req.socket?.encrypted) return true;
  return String(req.headers['x-forwarded-proto'] ?? '').split(',').some((proto) => goTrim(proto).toLowerCase() === 'https');
}

/** Cabecera `Set-Cookie` de la sesión; `clear` la borra. */
export function sessionCookie(req, value, clear = false) {
  const attrs = [`${SESSION_COOKIE}=${clear ? '' : value}`, 'Path=/dashboard', 'HttpOnly', 'SameSite=Lax', `Max-Age=${clear ? -1 : SESSION_TTL_SECONDS}`];
  if (isSecureRequest(req)) attrs.push('Secure');
  return attrs.join('; ');
}
