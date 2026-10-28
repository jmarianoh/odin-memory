import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../../src/cli/index.js';
import { Store } from '../../../src/store/index.js';

/**
 * Entorno de pruebas de la CLI: un repositorio git, un directorio de datos propio y
 * una función que ejecuta comandos capturando la salida.
 * @param {import('node:test').TestContext} t
 * @param {{ repo?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function cliWorld(t, { repo = 'mi-repo', env = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'odin-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoDir = join(root, repo);
  mkdirSync(repoDir);
  execFileSync('git', ['init', '-q', repoDir]);
  const dataDir = join(root, 'data');
  const baseEnv = { PATH: process.env.PATH, HOME: root, ODIN_DATA_DIR: dataDir, ODIN_TIMEZONE: 'UTC', ...env };

  /**
   * Ejecuta `odin <args>` y devuelve el código y lo escrito.
   * @param {string[]} args
   * @param {{ input?: string, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
   */
  async function odin(args, { input, cwd = repoDir, env: extra, overrides = {} } = {}) {
    let out = '';
    let err = '';
    const lines = input === undefined ? [] : input.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const code = await run(args, {
      env: { ...baseEnv, ...extra },
      cwd: () => cwd,
      out: (text) => { out += text; },
      err: (text) => { err += text; },
      readLine: () => (lines.length > 0 ? lines.shift() : null),
      openStore: (config) => Store.open({ ...config, log: () => {} }),
      home: () => root,
      ...overrides,
    });
    return { code, out, err };
  }

  /** Abre el almacén de la prueba para inspeccionarlo o sembrarlo. */
  function store() {
    const s = Store.open({ dataDir, log: () => {} });
    t.after(() => {
      try {
        s.close();
      } catch {
        // ya cerrado
      }
    });
    return s;
  }

  return { root, repoDir, dataDir, env: baseEnv, odin, store };
}
