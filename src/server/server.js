import { createServer } from 'node:http';
import { DatabaseGenerationChangedError } from '../store/errors.js';
import { constantTimeEqual, requireAuth, requireConfiguredAuth } from './auth.js';
import { HttpError, readBody, sendError, sendText } from './http.js';
import { Router } from './router.js';
import { storeSyncStatus } from './sync-status.js';
import { ROUTES } from './routes/table.js';
import { listenSecure, prepareSocket, removeOwnedSocket } from './unix-socket.js';

/** `path.Clean` de Go conservando la barra final: `//`, `.` y `..` se resuelven con una redirección. */
export function cleanPath(path) {
  if (path === '') return '/';
  const out = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const cleaned = `/${out.join('/')}`;
  return path.endsWith('/') && cleaned !== '/' ? `${cleaned}/` : cleaned;
}

/**
 * Contexto de una petición que reciben los manejadores de ruta.
 * @typedef {object} RequestContext
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {string} path ruta sin consulta
 * @property {URLSearchParams} query
 * @property {Record<string, string>} params comodines de la ruta
 * @property {import('../store/store.js').Store} store
 * @property {NodeJS.ProcessEnv} env
 * @property {string} version
 * @property {boolean} sessionOwned la petición ya se autenticó con el token privado de la sesión
 * @property {() => string} cwd
 * @property {(limit?: number) => Promise<string>} body
 * @property {() => void} notifyWrite avisa de una escritura local (sincronización)
 * @property {((project: string) => object)|undefined} syncStatus
 * @property {{ runnerFactory?: Function, buildPrompt?: Function }|undefined} llm
 */

/**
 * Servidor HTTP de la API local. Escucha solo en el bucle local (o en un socket
 * Unix) y atiende las rutas de `ROUTES`.
 */
export class HttpServer {
  /**
   * @param {import('../store/store.js').Store} store
   * @param {object} [options]
   * @param {number} [options.port] 0 = puerto libre
   * @param {string} [options.version]
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {() => string} [options.cwd]
   * @param {string} [options.socketPath] escucha en un socket Unix en lugar de TCP
   * @param {string} [options.sessionOwnedToken] autentica todas las rutas (también `/health`)
   * @param {() => void} [options.onWrite] se llama tras cada escritura local
   * @param {{ runnerFactory?: (name: string) => object, buildPrompt?: (a: object, b: object) => string }} [options.llm] ejecutor semántico del escaneo de conflictos
   * @param {(project: string) => object} [options.syncStatus] por defecto, el estado local del almacén
   * @param {string} [options.defaultProject] proyecto del estado de sincronización cuando la petición no trae ninguno
   * @param {(address: import('node:net').AddressInfo | string) => void} [options.onReady] tras enlazar, antes de atender
   * @param {(message: string) => void} [options.log]
   */
  constructor(store, options = {}) {
    this.store = store;
    this.port = options.port ?? 7438;
    this.version = options.version ?? 'dev';
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? (() => process.cwd());
    this.socketPath = (options.socketPath ?? '').trim();
    this.sessionOwnedToken = options.sessionOwnedToken ?? '';
    this.onWrite = options.onWrite;
    this.llm = options.llm;
    this.syncStatus = options.syncStatus ?? storeSyncStatus(store, { defaultProject: options.defaultProject ?? '' });
    this.onReady = options.onReady;
    this.log = options.log ?? ((m) => process.stderr.write(`${m}\n`));
    this.router = new Router();
    for (const route of ROUTES) {
      this.router.add(route.pattern, { handler: route.handler, auth: route.auth === true, configured: route.configured === true });
    }
    this.http = createServer((req, res) => {
      this.#serve(req, res).catch((err) => this.#unexpected(res, err));
    });
    this.http.requestTimeout = 0;
    this.http.headersTimeout = 60_000;
    this.closed = false;
    this.socketInfo = null;
    /** @type {Promise<void>} resuelta la primera vez que el almacén pierde su generación */
    this.generationInvalidated = new Promise((resolve) => {
      this.#notifyGeneration = resolve;
    });
  }

  #notifyGeneration = () => {};

  #unexpected(res, err) {
    this.log(`[odin] unexpected request error: ${err?.stack ?? err}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, 500, 'internal error');
  }

  async #serve(req, res) {
    if (this.sessionOwnedToken !== '' && !constantTimeEqual(req.headers.authorization ?? '', `Bearer ${this.sessionOwnedToken}`)) {
      req.resume();
      sendError(res, 401, 'authorization required', {}, { 'WWW-Authenticate': 'Bearer realm="odin-memory"' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cleaned = cleanPath(url.pathname);
    if (cleaned !== url.pathname) {
      req.resume();
      res.writeHead(301, { Location: cleaned + url.search, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.method === 'GET' || req.method === 'HEAD' ? `<a href="${cleaned}${url.search}">Moved Permanently</a>.\n\n` : '');
      return;
    }
    const found = this.router.match(req.method ?? 'GET', url.pathname);
    if (found.kind === 'none') {
      req.resume();
      sendText(res, 404, '404 page not found');
    } else if (found.kind === 'method') {
      req.resume();
      sendText(res, 405, 'Method Not Allowed', { Allow: found.allow.join(', ') });
    } else {
      await this.#dispatch(req, res, url, found);
    }
    if (this.store.generationError() instanceof DatabaseGenerationChangedError) this.#notifyGeneration();
  }

  async #dispatch(req, res, url, found) {
    let bodyPromise;
    /** @type {RequestContext} */
    const ctx = {
      req, res, path: url.pathname, query: url.searchParams, params: found.params, store: this.store, env: this.env, version: this.version,
      sessionOwned: this.sessionOwnedToken !== '', cwd: this.cwd, syncStatus: this.syncStatus, llm: this.llm,
      body: (limit) => {
        bodyPromise ??= readBody(req, limit);
        return bodyPromise;
      },
      notifyWrite: () => this.onWrite?.(),
    };
    const { handler, auth, configured } = found.route.handler;
    try {
      if (configured) requireConfiguredAuth(ctx);
      else if (auth) requireAuth(ctx);
      await handler(ctx);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (!res.headersSent) sendError(res, err.status, err.message, err.fields, err.headers);
    }
    if (!bodyPromise) req.resume();
  }

  /**
   * Enlaza el listener y empieza a atender.
   * @returns {Promise<{ address: import('node:net').AddressInfo | string, reused: boolean }>}
   *   `reused`: otra instancia del mismo almacén ya posee el puerto (no es un error)
   */
  async listen() {
    if (this.closed) return { address: '', reused: false };
    let address;
    try {
      if (this.socketPath !== '') {
        this.socketPath = await prepareSocket(this.socketPath);
        this.socketInfo = await listenSecure(this.http, this.socketPath);
        address = this.socketPath;
      } else {
        await new Promise((resolve, reject) => {
          this.http.once('error', reject);
          this.http.listen(this.port, '127.0.0.1', () => {
            this.http.off('error', reject);
            resolve();
          });
        });
        address = this.http.address();
      }
    } catch (err) {
      if (err.code === 'EADDRINUSE' && this.sessionOwnedToken === '' && this.socketPath === '') {
        if (await this.#instanceOwnsPort()) {
          this.log(`[odin] HTTP server did not bind on 127.0.0.1:${this.port}: an existing instance owns the port`);
          return { address: `127.0.0.1:${this.port}`, reused: true };
        }
        throw new Error(`odin server: listen 127.0.0.1:${this.port}: already owned by a different or legacy instance`);
      }
      if (err.message?.startsWith('odin server:')) throw err;
      throw new Error(`odin server: listen ${this.socketPath || `127.0.0.1:${this.port}`}: ${err.message}`);
    }
    if (this.onReady) {
      try {
        this.onReady(address);
      } catch (err) {
        await this.close();
        throw err;
      }
    }
    this.log(`[odin] HTTP server listening on ${typeof address === 'string' ? address : `127.0.0.1:${address.port}`}`);
    return { address, reused: false };
  }

  async #instanceOwnsPort() {
    const instanceId = this.store.instanceId;
    if (!instanceId) return false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(500) });
        const health = await response.json();
        return health.instance_id === instanceId;
      } catch (err) {
        if (err.name === 'SyntaxError') return false;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return false;
  }

  /** Deja de aceptar conexiones y borra el socket propio. Es idempotente. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.http.listening) await new Promise((resolve) => this.http.close(() => resolve()));
    removeOwnedSocket(this.socketPath, this.socketInfo);
    this.socketInfo = null;
  }

  /**
   * Cierra el servidor esperando a las peticiones en curso hasta `graceMs`; pasado
   * ese plazo se cortan las conexiones que sigan abiertas.
   * @param {number} [graceMs]
   */
  async shutdown(graceMs = 5000) {
    const closing = this.close();
    this.http.closeIdleConnections();
    const timer = setTimeout(() => this.http.closeAllConnections(), graceMs);
    try {
      await closing;
    } finally {
      clearTimeout(timer);
    }
  }
}
