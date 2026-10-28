import { delimiter, join } from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { goTrim } from '../store/text.js';

/** Carpeta de configuración de Copilot: `COPILOT_HOME` o `~/.copilot`. */
export function copilotHome(env, home) {
  return goTrim(env.COPILOT_HOME ?? '') !== '' ? env.COPILOT_HOME : join(home(), '.copilot');
}

/** Carpeta `User` del perfil de VS Code según el sistema (`insiders` para la edición Insiders). */
export function vscodeUserDir(env, home, { platform = process.platform, insiders = false } = {}) {
  const product = insiders ? 'Code - Insiders' : 'Code';
  if (platform === 'darwin') return join(home(), 'Library', 'Application Support', product, 'User');
  if (platform === 'win32') return join(goTrim(env.APPDATA ?? '') !== '' ? env.APPDATA : join(home(), 'AppData', 'Roaming'), product, 'User');
  return join(goTrim(env.XDG_CONFIG_HOME ?? '') !== '' ? env.XDG_CONFIG_HOME : join(home(), '.config'), product, 'User');
}

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Ruta del ejecutable `odin` en el PATH, o `null`. */
export function findOnPath(env, platform = process.platform) {
  const names = platform === 'win32' ? ['odin.cmd', 'odin.exe', 'odin.bat'] : ['odin'];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const name of names) if (isFile(join(dir, name))) return join(dir, name);
  }
  return null;
}

/**
 * Cómo se invoca odin desde la configuración de otro programa: `odin` si está en el PATH y, si no,
 * el Node actual con la ruta absoluta de `bin/odin.js`.
 * @returns {{ command: string, args: string[] }}
 */
export function odinInvocation(env, { platform = process.platform, execPath = process.execPath, binPath = fileURLToPath(new URL('../../bin/odin.js', import.meta.url)) } = {}) {
  if (findOnPath(env, platform)) return { command: 'odin', args: [] };
  return { command: execPath, args: [binPath] };
}
