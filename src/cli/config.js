import { homedir } from 'node:os';
import { join } from 'node:path';

/** Directorio de datos por defecto, relativo al directorio personal. */
export const DEFAULT_DATA_DIR_NAME = '.odin-memory';

/**
 * Configuración del almacén para la CLI: el directorio de datos de `ODIN_DATA_DIR`
 * (un valor en blanco usa el de por defecto) y los límites predeterminados.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {() => string} [home]
 * @returns {{ dataDir: string }}
 */
export function resolveConfig(env = process.env, home = homedir) {
  const override = env.ODIN_DATA_DIR ?? '';
  const dataDir = override.trim() !== '' ? override : join(home(), DEFAULT_DATA_DIR_NAME);
  return { dataDir };
}
