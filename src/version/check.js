import { goTrim } from '../store/text.js';

export const ENV_NO_UPDATE_CHECK = 'ODIN_NO_UPDATE_CHECK';
export const ENV_UPDATE_CHECK_URL = 'ODIN_UPDATE_CHECK_URL';
export const ENV_UPDATE_TOKEN = 'ODIN_UPDATE_TOKEN';
export const CHECK_TIMEOUT_MS = 2000;

export const CHECK_STATUS = Object.freeze({ upToDate: 'up_to_date', updateAvailable: 'update_available', checkFailed: 'check_failed', disabled: '' });

const failed = (message) => ({ status: CHECK_STATUS.checkFailed, message });

/** `ODIN_NO_UPDATE_CHECK` en `1`, `true`, `yes` u `on`. */
export function updateCheckDisabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(goTrim(env[ENV_NO_UPDATE_CHECK] ?? '').toLowerCase());
}

/** Quita el prefijo `v`. */
export const normalizeVersion = (v) => goTrim(v ?? '').replace(/^v/, '');

/** Exactamente tres componentes numéricos, sin ceros a la izquierda ni sufijos, y dentro del rango entero. */
export function isPlainRelease(v) {
  const segments = String(v).split('.');
  if (segments.length !== 3) return false;
  return segments.every((s) => /^[0-9]+$/.test(s) && !(s.length > 1 && s[0] === '0') && Number.isSafeInteger(Number(s)));
}

/** `latest > current`; ambas ya validadas con `isPlainRelease`. */
export function isNewer(latest, current) {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export const updateInstructions = () => '  npm install -g odin-memory@latest';

const nonOkMessage = (status, statusText) => {
  let message = `Could not check for updates: the release server returned ${status} ${statusText}.`.replace(/ \.$/, '.');
  if (status === 401 || status === 403) message += ' Set ODIN_UPDATE_TOKEN to authenticate.';
  return message;
};

/**
 * Compara la versión en ejecución con la última publicada. La comprobación solo se hace si
 * `ODIN_UPDATE_CHECK_URL` apunta a un servicio que responda `{ "tag_name": "vX.Y.Z" }`
 * (el formato de la API de versiones de GitHub); sin esa variable no hay red ni mensaje.
 * @param {string} current
 * @param {{ env?: NodeJS.ProcessEnv, fetch?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: string, message?: string }>}
 */
export async function checkLatest(current, { env = process.env, fetch: fetchFn = globalThis.fetch, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const url = goTrim(env[ENV_UPDATE_CHECK_URL] ?? '');
  if (updateCheckDisabled(env) || url === '') return { status: CHECK_STATUS.disabled };
  if (!current) return failed('Could not check for updates: current version is unknown.');
  if (current === 'dev') return failed('Could not check for updates: development builds do not map to a release version.');
  const running = normalizeVersion(current);
  if (!isPlainRelease(running)) return failed('Could not check for updates: current version does not map to a plain release version.');

  const headers = { Accept: 'application/json' };
  const token = goTrim(env[ENV_UPDATE_TOKEN] ?? '');
  if (token !== '') headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return failed('Could not check for updates: the release server took too long to respond.');
    return failed(`Could not check for updates: ${err?.message ?? err}.`);
  }
  if (response.status !== 200) return failed(nonOkMessage(response.status, response.statusText ?? ''));
  let release;
  try {
    release = await response.json();
  } catch {
    return failed('Could not check for updates: could not read the release server response.');
  }
  const latest = normalizeVersion(typeof release?.tag_name === 'string' ? release.tag_name : '');
  if (!isPlainRelease(latest)) return failed('Could not check for updates: the release server did not return a release version.');
  if (latest === running || !isNewer(latest, running)) return { status: CHECK_STATUS.upToDate };
  return { status: CHECK_STATUS.updateAvailable, message: `Update available: ${running} -> ${latest}\nTo update:\n${updateInstructions()}` };
}

/** ¿Este comando comprueba si hay una versión nueva? Los de larga duración, el diagnóstico y los de ayuda no. */
export function shouldCheckForUpdates(args) {
  if (args.length === 0) return false;
  const command = goTrim(args[0]).toLowerCase();
  if (['mcp', 'serve', 'protocol-mode', 'tui', 'doctor', 'version', '--version', '-v', 'help', '--help', '-h', 'init', 'hook', 'test'].includes(command)) return false;
  if (command === 'cloud') return args.length < 2 || goTrim(args[1]).toLowerCase() !== 'serve';
  return true;
}
