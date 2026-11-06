import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '../../../src/mcp/server.js';
import { promptWorkspaceDirectory } from '../../../src/mcp/prompt-workspace.js';
import { createSession, getSession, recentPrompts } from '../../../src/store/index.js';
import { runtimeWorktreeDirectory } from '../../../src/project/worktree.js';
import { tempDir as repoTempDir } from '../project/helpers.js';
import { openTempStore } from '../store/helpers.js';

/** Servidor cuyo directorio de trabajo es neutro: el proyecto debe salir del `directory` de cada llamada. */
function setup(t, { env = {}, config = {} } = {}) {
  const store = openTempStore(t);
  const root = repoTempDir(t);
  const neutral = join(root, 'neutral');
  mkdirSync(neutral);
  const server = createServer(store, config, null, { env, cwd: () => neutral });
  const run = async (name, args = {}) => {
    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    const text = res.result.content[0].text;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // texto plano
    }
    return { text, json, isError: res.result.isError === true };
  };
  const workspace = (name, owner) => {
    const dir = join(root, name);
    mkdirSync(join(dir, '.odin-memory'), { recursive: true });
    writeFileSync(join(dir, '.odin-memory', 'config.json'), JSON.stringify({ project_name: owner }));
    return dir;
  };
  return { store, run, root, workspace, neutral };
}

test('promptWorkspaceDirectory valida tipo, ruta absoluta y existencia, con directory antes que cwd', (t) => {
  const root = repoTempDir(t);
  const file = join(root, 'archivo');
  writeFileSync(file, 'x');
  assert.deepEqual(promptWorkspaceDirectory({}), { directory: '', error: null });
  assert.deepEqual(promptWorkspaceDirectory({ directory: '   ', cwd: root }), { directory: root, error: null }, 'un directory en blanco cede ante cwd');
  assert.deepEqual(promptWorkspaceDirectory({ directory: root, cwd: '/no/existe' }), { directory: root, error: null }, 'directory manda sobre cwd');
  assert.equal(promptWorkspaceDirectory({ directory: 7 }).error, 'directory must be a string');
  assert.equal(promptWorkspaceDirectory({ cwd: null }).error, 'cwd must be a string');
  assert.equal(promptWorkspaceDirectory({ directory: 'relativo/x' }).error, 'directory must be an absolute directory');
  assert.match(promptWorkspaceDirectory({ directory: join(root, 'nada') }).error, /^directory is unavailable: stat .+: no such file or directory$/);
  assert.equal(promptWorkspaceDirectory({ cwd: file }).error, 'cwd must name a directory');
});

test('mem_save_prompt atribuye el prompt al workspace de la llamada y a su sesión de runtime', async (t) => {
  const { store, run, workspace } = setup(t);
  for (const [name, owner, key] of [['alpha-first', 'alpha', 'directory'], ['alpha-second', 'alpha', 'cwd'], ['beta', 'beta', 'directory']]) {
    const dir = workspace(name, owner);
    createSession(store, name, owner, runtimeWorktreeDirectory(dir));
    const res = await run('mem_save_prompt', { content: name, [key]: dir });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.project, owner);
    assert.ok(recentPrompts(store, owner, 10).some((p) => p.content === name && p.session_id === name), `${name}: sin la sesión exacta del workspace`);
  }
});

test('sin sesión de runtime, el prompt usa la sesión de reserva del proyecto con el directorio de la llamada', async (t) => {
  const { store, run, workspace } = setup(t);
  const dir = workspace('gamma', 'gamma');
  const res = await run('mem_save_prompt', { content: 'sin sesión previa', directory: dir });
  assert.equal(res.isError, false, res.text);
  const session = getSession(store, 'manual-save-gamma');
  assert.deepEqual([session.project, session.directory, session.ownership_mode], ['gamma', dir, 'project_owned']);
  assert.equal(recentPrompts(store, 'gamma', 10)[0].session_id, 'manual-save-gamma');
});

test('un directory inválido se rechaza antes de guardar nada', async (t) => {
  const { store, run, root } = setup(t);
  const bad = await run('mem_save_prompt', { content: 'x', directory: join(root, 'no-existe') });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /^Invalid workspace directory: directory is unavailable: /);
  assert.equal((await run('mem_save_prompt', { content: 'x', cwd: 'relativa' })).text, 'Invalid workspace directory: cwd must be an absolute directory');
  assert.equal(recentPrompts(store, '', 10).length, 0);
});

test('el proyecto fijado para el proceso manda sobre el directory de la llamada', async (t) => {
  const { run, workspace, store } = setup(t, { config: { defaultProject: 'fijo' } });
  const dir = workspace('delta', 'delta');
  const res = await run('mem_save_prompt', { content: 'con proyecto fijo', directory: dir });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.json.project, 'fijo');
  assert.equal(recentPrompts(store, 'fijo', 10).length, 1);
});

test('mem_save_prompt publica directory y cwd en su esquema', async (t) => {
  const { store } = setup(t);
  const server = createServer(store, {}, null, { env: {} });
  const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const props = list.result.tools.find((x) => x.name === 'mem_save_prompt').inputSchema.properties;
  assert.equal(props.directory.type, 'string');
  assert.equal(props.cwd.description, 'Alias for directory; directory takes precedence.');
});
