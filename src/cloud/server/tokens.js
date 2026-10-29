import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { goTrim } from '../../store/text.js';

const HASH_PREFIX = 'hmac-sha256:v1:';
const DOMAIN = 'odin-cloud-token:v1:';
export const PEPPER_MIN_BYTES = 32;

export const PRINCIPAL_SOURCE = Object.freeze({
  managedToken: 'managed_token', legacyEnvSync: 'legacy_env_sync', legacyEnvAdmin: 'legacy_env_admin', bootstrapCli: 'bootstrap_cli', insecureDev: 'insecure_dev',
});
export const ROLE = Object.freeze({ admin: 'admin', member: 'member' });
export const KIND = Object.freeze({ human: 'human', serviceAccount: 'service_account', legacy: 'legacy' });

/** El token no se reconoce, está revocado o su titular está deshabilitado. */
export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}
export const ERR = Object.freeze({
  pepperRequired: () => new AuthError('dedicated cloud token pepper is required', 'token_pepper_required'),
  pepperTooShort: () => new AuthError(`dedicated cloud token pepper must be at least ${PEPPER_MIN_BYTES} bytes`, 'token_pepper_too_short'),
  tokenRequired: () => new AuthError('managed token is required', 'managed_token_required'),
  unknownToken: () => new AuthError('unknown token', 'unknown_token'),
  tokenRevoked: () => new AuthError('token is revoked', 'token_revoked'),
  principalDisabled: () => new AuthError('principal is disabled', 'principal_disabled'),
  mismatch: () => new AuthError('token principal mismatch', 'token_principal_mismatch'),
});

/**
 * Genera un token gestionado: `odc_<entorno>_<8 hex>_<secreto>`. El prefijo se puede mostrar; el secreto, no.
 * @returns {{ raw: string, prefix: string, secret: string }}
 */
export function generateManagedToken(environment = 'live') {
  const env = goTrim(environment).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'live';
  const prefix = `odc_${env}_${randomBytes(4).toString('hex')}`;
  const secret = randomBytes(32).toString('base64url').replaceAll('_', '-');
  return { raw: `${prefix}_${secret}`, prefix, secret };
}

/** Resumen HMAC-SHA256 de un token con una pimienta dedicada (distinta del secreto de las sesiones). */
export class ManagedTokenHasher {
  #pepper;

  /** @param {Buffer|string} pepper al menos 32 bytes */
  constructor(pepper) {
    const bytes = Buffer.from(pepper ?? '');
    if (bytes.length === 0) throw ERR.pepperRequired();
    if (bytes.length < PEPPER_MIN_BYTES) throw ERR.pepperTooShort();
    this.#pepper = bytes;
  }

  #sum(raw) {
    return createHmac('sha256', this.#pepper).update(DOMAIN).update(raw).digest();
  }

  hash(rawToken) {
    const raw = goTrim(rawToken ?? '');
    if (raw === '') throw ERR.tokenRequired();
    return HASH_PREFIX + this.#sum(raw).toString('base64url');
  }

  verify(rawToken, verifier) {
    const raw = goTrim(rawToken ?? '');
    const stored = goTrim(verifier ?? '');
    if (raw === '' || !stored.startsWith(HASH_PREFIX)) return false;
    const provided = Buffer.from(stored.slice(HASH_PREFIX.length), 'base64url');
    const expected = this.#sum(raw);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
}
