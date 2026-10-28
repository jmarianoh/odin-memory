import { HttpServer } from '../../server/index.js';
import { DatabaseGenerationChangedError } from '../../store/errors.js';
import { goTrim } from '../../store/text.js';
import { VERSION } from '../../version/index.js';
import { fatal } from '../runtime.js';

/** El proceso padre cerró su extremo antes de que el servidor estuviera listo: no es un fallo. */
class ParentClosedError extends Error {}

/** Protocolo de la línea de disponibilidad que emite `serve --session-owned`. */
export const SESSION_OWNED_PROTOCOL = 'odin-session-owned-v1';
export const DEFAULT_PORT = 7438;

/**
 * Valida `--session-owned`: no admite puerto ni socket, ni sus variables, y exige
 * un `ODIN_TOKEN` privado de 256 bits en hexadecimal.
 * @param {string[]} args argumentos tras `serve`
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean} si el servidor es de sesión propia
 * @throws {Error}
 */
export function validateSessionOwned(args, env) {
  if (!args.includes('--session-owned')) return false;
  for (const key of ['ODIN_URL', 'ODIN_PORT', 'ODIN_SOCKET']) {
    if (Object.hasOwn(env, key)) throw new Error(`session-owned serve conflicts with ${key}; unset it`);
  }
  if (args.some((arg) => arg !== '--session-owned')) throw new Error('session-owned serve accepts no port or socket arguments');
  if (!/^[0-9a-fA-F]{64}$/.test(env.ODIN_TOKEN ?? '')) throw new Error('session-owned serve requires a private 256-bit hex ODIN_TOKEN');
  return true;
}

/**
 * Puerto, socket y modo de `odin serve`.
 * @param {string[]} args argumentos tras `serve`
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ sessionOwned: boolean, port: number, socketPath: string }}
 * @throws {Error}
 */
export function resolveServeOptions(args, env) {
  if (validateSessionOwned(args, env)) return { sessionOwned: true, port: 0, socketPath: '' };
  const options = { sessionOwned: false, port: DEFAULT_PORT, socketPath: goTrim(env.ODIN_SOCKET ?? '') };
  let portExplicit = false;
  const fromEnv = goTrim(env.ODIN_PORT ?? '');
  if (/^\d+$/.test(fromEnv) && Number(fromEnv) > 0 && Number(fromEnv) <= 65535) {
    options.port = Number(fromEnv);
    portExplicit = true;
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--socket') {
      if (i + 1 >= args.length || goTrim(args[i + 1]) === '') throw new Error('--socket requires a path');
      options.socketPath = goTrim(args[++i]);
    } else if (arg.startsWith('--socket=')) {
      options.socketPath = goTrim(arg.slice('--socket='.length));
      if (options.socketPath === '') throw new Error('--socket requires a path');
    } else if (/^[+-]?\d+$/.test(arg)) {
      options.port = Number(arg);
      portExplicit = true;
    } else {
      throw new Error(`unknown serve argument: ${arg}`);
    }
  }
  if (options.socketPath !== '' && portExplicit) throw new Error('socket transport cannot be combined with an explicit TCP port');
  return options;
}

/**
 * `odin serve [puerto] [--socket RUTA]` y `odin serve --session-owned`: API HTTP local.
 * En modo de sesión propia el proceso padre posee el servidor: el cierre de la
 * entrada estándar lo detiene.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export async function cmdServe(cli, config) {
  let options;
  try {
    options = resolveServeOptions(cli.args.slice(1), cli.env);
  } catch (err) {
    return fatal(cli, err);
  }
  const hooks = cli.serve ?? {};
  const input = hooks.input ?? process.stdin;
  const processRef = hooks.processRef ?? process;
  const log = hooks.log ?? ((message) => cli.err(`${message}\n`));

  let parentClosed = false;
  /** @type {Promise<'parent'>} */
  const parentEof = new Promise((resolve) => {
    if (!options.sessionOwned) return;
    const done = () => {
      parentClosed = true;
      resolve('parent');
    };
    input.on('end', done);
    input.on('close', done);
    input.resume();
  });

  let store;
  try {
    store = cli.openStore(config);
  } catch (err) {
    return fatal(cli, err);
  }
  // Deja que el bucle de eventos observe un cierre que ya ocurrió antes de enlazar.
  await new Promise((resolve) => setImmediate(resolve));
  if (options.sessionOwned && parentClosed) {
    store.close();
    return;
  }

  const server = new HttpServer(store, {
    port: options.port,
    version: VERSION,
    env: cli.env,
    cwd: cli.cwd,
    socketPath: options.socketPath,
    sessionOwnedToken: options.sessionOwned ? cli.env.ODIN_TOKEN : '',
    log,
    onReady: options.sessionOwned
      ? (address) => {
          if (parentClosed) throw new ParentClosedError('session-owned parent closed before readiness');
          const record = { protocol: SESSION_OWNED_PROTOCOL, endpoint: `http://127.0.0.1:${address.port}`, pid: process.pid, instance_id: store.instanceId };
          cli.out(`${JSON.stringify(record)}\n`);
        }
      : undefined,
  });

  let reason = 'closed';
  const signals = new Promise((resolve) => {
    const onSignal = () => resolve('signal');
    processRef.on('SIGINT', onSignal);
    processRef.on('SIGTERM', onSignal);
    hooks.signal?.addEventListener('abort', onSignal, { once: true });
    server.cleanupSignals = () => {
      processRef.off('SIGINT', onSignal);
      processRef.off('SIGTERM', onSignal);
    };
  });

  let failure = null;
  try {
    const listening = await server.listen();
    hooks.ready?.({ server, address: listening.address });
    if (listening.reused) {
      reason = 'reused';
    } else {
      reason = await Promise.race([server.generationInvalidated.then(() => 'generation'), parentEof, signals]);
    }
  } catch (err) {
    if (err instanceof ParentClosedError) reason = 'parent';
    else failure = err;
  }
  server.cleanupSignals?.();
  if (reason === 'parent') log('[odin] session owner disconnected; shutting down...');
  else if (reason === 'signal') log('[odin] shutting down...');
  await server.shutdown(hooks.graceMs ?? 5000);
  const generationChanged = reason === 'generation' || store.generationError() instanceof DatabaseGenerationChangedError;
  try {
    store.close();
  } catch {
    // cerrar es de mejor esfuerzo
  }
  if (generationChanged) {
    log('[odin] database generation changed; stopping server; restart Odin');
    return fatal(cli, new DatabaseGenerationChangedError());
  }
  if (failure) return fatal(cli, failure);
}
