import { normalizeProject } from '../../project/canonical.js';
import { goTrim } from '../../store/text.js';

export const DEFAULT_JWT_SECRET = 'odin-dev-jwt-secret-for-local-smoke-1234';
export const DEFAULT_MAX_PUSH_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_DATABASE_URL = 'postgres://odin:odin_dev@localhost:5433/odin_cloud?sslmode=disable';

export const isDefaultJwtSecret = (secret) => goTrim(secret ?? '') === DEFAULT_JWT_SECRET;

const positiveInt = (raw) => (/^[+-]?\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : 0);

/** Valor booleano de una variable de entorno: `1`, `true`, `yes` u `on`. */
export function envBool(env, key) {
  return ['1', 'true', 'yes', 'on'].includes(goTrim(env[key] ?? '').toLowerCase());
}

/** Lista sin repeticiones de nombres de proyecto canónicos; descarta los vacíos. */
export function normalizeAllowedProjects(projects) {
  const seen = new Set();
  for (const project of projects) {
    const name = goTrim(normalizeProject(project).normalized);
    if (name !== '') seen.add(name);
  }
  return [...seen];
}

/**
 * Configuración del servidor de la nube a partir del entorno.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function cloudServeConfigFromEnv(env = process.env) {
  const text = (key) => goTrim(env[key] ?? '');
  const config = {
    dsn: text('ODIN_DATABASE_URL') || DEFAULT_DATABASE_URL,
    jwtSecret: text('ODIN_JWT_SECRET') || DEFAULT_JWT_SECRET,
    port: positiveInt(text('ODIN_PORT')) || 8080,
    bindHost: text('ODIN_CLOUD_HOST') || '127.0.0.1',
    adminToken: text('ODIN_CLOUD_ADMIN'),
    tokenPepper: text('ODIN_CLOUD_TOKEN_PEPPER'),
    maxPushBodyBytes: positiveInt(text('ODIN_CLOUD_MAX_PUSH_BYTES')) || DEFAULT_MAX_PUSH_BODY_BYTES,
    allowedProjects: /** @type {string[]} */ ([]),
    token: text('ODIN_CLOUD_TOKEN'),
    insecureNoAuth: false,
  };
  const list = text('ODIN_CLOUD_ALLOWED_PROJECTS');
  if (list !== '') {
    config.allowedProjects = [...new Set(list.split(',').map(goTrim).filter((p) => p !== ''))];
  }
  config.insecureNoAuth = config.token === '' && envBool(env, 'ODIN_CLOUD_INSECURE_NO_AUTH');
  return config;
}

/**
 * Reglas de arranque de `odin cloud serve`.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(message: string) => void} [warn]
 * @throws {Error} si la combinación de autenticación y lista de proyectos no es válida
 */
export function validateCloudServeAuthConfig(env = process.env, warn = () => {}) {
  const token = goTrim(env.ODIN_CLOUD_TOKEN ?? '');
  const adminToken = goTrim(env.ODIN_CLOUD_ADMIN ?? '');
  const insecure = envBool(env, 'ODIN_CLOUD_INSECURE_NO_AUTH');
  const allowlist = normalizeAllowedProjects(cloudServeConfigFromEnv(env).allowedProjects);
  const jwtSecret = goTrim(env.ODIN_JWT_SECRET ?? '');
  if (insecure && token !== '') {
    throw new Error('conflicting cloud auth configuration: ODIN_CLOUD_INSECURE_NO_AUTH=1 cannot be used together with ODIN_CLOUD_TOKEN');
  }
  if (token !== '' && allowlist.length > 0) {
    if (jwtSecret === '') throw new Error('authenticated cloud serve requires explicit ODIN_JWT_SECRET (non-default); refusing implicit default secret');
    if (isDefaultJwtSecret(jwtSecret)) throw new Error('authenticated cloud serve requires a non-default ODIN_JWT_SECRET; refusing development default');
    return;
  }
  if (insecure) {
    if (allowlist.length === 0) throw new Error('cloud project allowlist is required even in insecure mode: set ODIN_CLOUD_ALLOWED_PROJECTS to one or more project names');
    if (adminToken !== '') throw new Error('ODIN_CLOUD_ADMIN is not supported when ODIN_CLOUD_INSECURE_NO_AUTH=1; remove ODIN_CLOUD_ADMIN or enable authenticated mode');
    warn('warning: ODIN_CLOUD_INSECURE_NO_AUTH=1 disables cloud API authentication; do not use in production');
    return;
  }
  if (token === '') throw new Error('cloud auth token is required: set ODIN_CLOUD_TOKEN (or ODIN_CLOUD_INSECURE_NO_AUTH=1 for local insecure development)');
  throw new Error('cloud project allowlist is required: set ODIN_CLOUD_ALLOWED_PROJECTS to one or more project names');
}
