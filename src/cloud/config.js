import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { goTrim } from '../store/text.js';

export const ENV_CLOUD_TOKEN = 'ODIN_CLOUD_TOKEN';
export const ENV_CLOUD_SERVER = 'ODIN_CLOUD_SERVER';

export const SOURCE = Object.freeze({ none: 'none', file: 'file', env: 'env' });
export const SOURCE_LABEL = Object.freeze({ none: 'not set', file: 'read from cloud.json', env: `set via ${ENV_CLOUD_TOKEN}` });

/** Archivo de configuración del cliente de la nube: `<datos>/cloud.json`. */
export const cloudConfigPath = (dataDir) => join(dataDir, 'cloud.json');

/** @returns {{ server_url: string, token: string }} vacío si el archivo no existe */
export function loadCloudConfig(dataDir) {
  const path = cloudConfigPath(dataDir);
  if (!existsSync(path)) return { server_url: '', token: '' };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return { server_url: typeof raw?.server_url === 'string' ? raw.server_url : '', token: typeof raw?.token === 'string' ? raw.token : '' };
}

/** Guarda la configuración con permisos `0600` (lleva el token). */
export function saveCloudConfig(dataDir, config) {
  mkdirSync(dataDir, { recursive: true, mode: 0o755 });
  const path = cloudConfigPath(dataDir);
  writeFileSync(path, JSON.stringify({ server_url: config.server_url ?? '', token: config.token ?? '' }, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export const clearCloudConfig = (dataDir) => saveCloudConfig(dataDir, { server_url: '', token: '' });

/** `ODIN_CLOUD_SERVER` sustituye a la URL guardada. */
export function applyServerOverride(config, env = process.env) {
  const value = goTrim(env[ENV_CLOUD_SERVER] ?? '');
  return value === '' ? config : { ...config, server_url: value };
}

/** El token de `ODIN_CLOUD_TOKEN` y, si falta, el guardado. */
export function effectiveToken(dataDir, env = process.env) {
  const fromEnv = goTrim(env[ENV_CLOUD_TOKEN] ?? '');
  if (fromEnv !== '') return { token: fromEnv, source: SOURCE.env };
  let config;
  try {
    config = loadCloudConfig(dataDir);
  } catch {
    return { token: '', source: SOURCE.none };
  }
  const saved = goTrim(config.token);
  return saved !== '' ? { token: saved, source: SOURCE.file } : { token: '', source: SOURCE.none };
}

/** Configuración efectiva: URL (con el reemplazo del entorno) y token. */
export function resolveCloudRuntimeConfig(dataDir, env = process.env) {
  const config = applyServerOverride(loadCloudConfig(dataDir), env);
  return { server_url: config.server_url, token: effectiveToken(dataDir, env).token };
}

/**
 * URL del servidor: `http` o `https`, con host, sin consulta ni fragmento.
 * @returns {string} la URL tal como se analiza (sin espacios alrededor)
 * @throws {Error}
 */
export function validateServerUrl(raw) {
  const value = goTrim(raw ?? '');
  if (value === '') throw new Error('server URL is required');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`parse ${JSON.stringify(value)}: invalid URI for request`);
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') throw new Error('scheme must be http or https');
  if (goTrim(parsed.host) === '' || goTrim(parsed.hostname) === '') throw new Error('host is required');
  if (parsed.search !== '' && parsed.search !== '?') throw new Error('query is not allowed');
  if (value.includes('?')) throw new Error('query is not allowed');
  if (value.includes('#')) throw new Error('fragment is not allowed');
  return value;
}
