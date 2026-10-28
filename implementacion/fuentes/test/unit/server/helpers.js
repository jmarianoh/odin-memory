import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpServer } from '../../../src/server/index.js';
import { Store } from '../../../src/store/index.js';

/**
 * Servidor HTTP de pruebas sobre un almacén temporal y un repositorio git.
 * @param {import('node:test').TestContext} t
 * @param {{ env?: NodeJS.ProcessEnv, sessionOwnedToken?: string, serverOptions?: object }} [options]
 */
export async function httpWorld(t, { env = {}, sessionOwnedToken = '', serverOptions = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'odin-http-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'mi-repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const store = Store.open({ dataDir: join(root, 'data'), log: () => {} });
  const writes = [];
  const serverEnv = { PATH: process.env.PATH, HOME: root, ...env };
  const server = new HttpServer(store, {
    port: 0, env: serverEnv, cwd: () => repo, sessionOwnedToken, log: () => {}, onWrite: () => writes.push(1), ...serverOptions,
  });
  const { address } = await server.listen();
  t.after(async () => {
    await server.shutdown(100);
    try {
      store.close();
    } catch {
      // ya cerrado
    }
  });
  const base = `http://127.0.0.1:${address.port}`;

  /** Hace una petición y devuelve estado, cabeceras y cuerpo (JSON si lo es). */
  async function call(method, path, body, headers = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(base + path, init);
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  /** Registra una sesión y guarda observaciones de ejemplo; devuelve los ids. */
  async function seed() {
    await call('POST', '/sessions', { id: 's1', project: 'demo', directory: repo });
    const ids = [];
    for (const [title, content, extra] of [
      ['Decisión de caché', 'usamos Redis como caché distribuida', { type: 'decision' }],
      ['Bug del login', 'el login falla con tokens expirados', { type: 'bugfix' }],
      ['Nota suelta', 'otra nota sobre Redis', {}],
    ]) {
      const r = await call('POST', '/observations', { session_id: 's1', title, content, project: 'demo', ...extra });
      ids.push(r.json.id);
    }
    return ids;
  }

  return { root, repo, store, server, base, call, seed, writes, env: serverEnv };
}
