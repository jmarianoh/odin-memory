import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Vincula el proceso del anfitrión (el agente que lanza el servidor MCP) con la
// sesión de runtime que atiende. Los hooks y el servidor MCP son hijos del mismo
// proceso anfitrión; los hooks publican «anfitrión → sesión» y el servidor lo
// lee a través de su propio proceso padre cuando una escritura omite `session_id`.
//
// Un vínculo nunca crea ni elige una identidad: registra la sesión que el propio
// anfitrión comunicó y solo vale mientras el proceso que lo publicó siga siendo el
// mismo (PID más hora de inicio). Cualquier vínculo ausente, ilegible u obsoleto
// significa «sin vínculo».

const DIR_NAME = 'host-sessions';

/** El PID no corresponde a un proceso en ejecución. */
export class NoProcessError extends Error {
  constructor() {
    super('hostbind: no such process');
    this.name = 'NoProcessError';
  }
}

/**
 * Señal opaca que cambia cuando se reutiliza un PID: hora de arranque del núcleo
 * (Linux), `ps -o lstart=` (otros Unix) o hora de creación (Windows).
 * @param {number} pid
 * @returns {string}
 * @throws {NoProcessError}
 */
export function processStart(pid) {
  if (process.platform === 'linux') {
    let text;
    try {
      text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new NoProcessError();
      throw err;
    }
    // El nombre del comando va entre paréntesis y puede contener espacios o «)»:
    // los campos numéricos se cuentan desde el último «)». `starttime` es el campo 22.
    const idx = text.lastIndexOf(')');
    const fields = idx < 0 ? [] : text.slice(idx + 1).trim().split(/\s+/);
    if (fields.length < 20) throw new Error('hostbind: unexpected /proc stat format');
    return fields[19];
  }
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true },
      ).trim();
      if (out === '') throw new NoProcessError();
      return out;
    } catch (err) {
      if (err instanceof NoProcessError) throw err;
      if (typeof err.status === 'number') throw new NoProcessError();
      throw err;
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
    if (out === '') throw new NoProcessError();
    return out;
  } catch (err) {
    if (err instanceof NoProcessError) throw err;
    if (typeof err.status === 'number') throw new NoProcessError();
    throw err;
  }
}

const bindingPath = (dataDir, pid) => join(dataDir, DIR_NAME, `${pid}.json`);

/**
 * Registra que el proceso anfitrión `pid` atiende `sessionId`. La escritura es
 * atómica: una consulta concurrente ve el vínculo anterior o el nuevo, nunca uno parcial.
 * @param {string} dataDir
 * @param {number} pid
 * @param {string} sessionId
 * @param {{ processStart?: (pid: number) => string, now?: () => Date }} [options]
 */
export function publish(dataDir, pid, sessionId, options = {}) {
  const start = options.processStart ?? processStart;
  sessionId = (sessionId ?? '').trim();
  if (!dataDir || !Number.isInteger(pid) || pid <= 1 || sessionId === '') {
    throw new Error('hostbind: data directory, host pid, and session id are required');
  }
  const startToken = start(pid);
  const updatedAt = (options.now ? options.now() : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const data = JSON.stringify({ pid, start: startToken, session_id: sessionId, updated_at: updatedAt });
  const dir = join(dataDir, DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.bind-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, bindingPath(dataDir, pid));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  prune(dir, pid, start);
}

/**
 * Sesión vinculada al proceso anfitrión `pid`, o `null` si no hay vínculo, no se
 * puede leer o el proceso que lo publicó ya no existe (el PID es otro proceso).
 * @param {string} dataDir
 * @param {number} pid
 * @param {{ processStart?: (pid: number) => string }} [options]
 * @returns {string|null}
 */
export function lookup(dataDir, pid, options = {}) {
  const start = options.processStart ?? processStart;
  if (!dataDir || !Number.isInteger(pid) || pid <= 1) return null;
  let binding;
  try {
    binding = JSON.parse(readFileSync(bindingPath(dataDir, pid), 'utf8'));
  } catch {
    return null;
  }
  if (binding === null || typeof binding !== 'object' || binding.pid !== pid || typeof binding.session_id !== 'string' || binding.session_id.trim() === '' || !binding.start) {
    return null;
  }
  try {
    if (start(pid) !== binding.start) return null;
  } catch {
    return null;
  }
  return binding.session_id;
}

/** Elimina los vínculos de anfitriones que ya terminaron (mejor esfuerzo; nunca el recién escrito). */
function prune(dir, keepPid, start) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const pid = Number(name.slice(0, -'.json'.length));
    if (!Number.isInteger(pid) || pid === keepPid) continue;
    let binding;
    try {
      binding = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    try {
      if (start(pid) === binding?.start) continue;
    } catch (err) {
      // Si no se pudo determinar la identidad (plataforma no soportada), se conserva el archivo.
      if (!(err instanceof NoProcessError)) continue;
    }
    rmSync(join(dir, name), { force: true });
  }
}
