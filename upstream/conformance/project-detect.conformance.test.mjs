// Contraste diferencial de la detección de proyecto sobre un árbol de directorios real.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectProjectFull } from '../../src/project/index.js';
import { resolveBinary, startMcp } from './engram-mcp.mjs';

const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';

let base;
let engram;
before(() => {
  if (!binary) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-detect-')));
  engram = startMcp(binary.bin, { cwd: base });
});
after(() => {
  engram?.close();
  if (base) rmSync(base, { recursive: true, force: true });
  binary?.cleanup();
});

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
const dir = (...parts) => {
  const path = join(base, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
};
const repo = (path, remote) => {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q');
  if (remote) git(path, 'remote', 'add', 'origin', remote);
  return path;
};
/** Escribe la configuración con el nombre de carpeta de cada implementación. */
const config = (path, body) => {
  for (const folder of ['.engram', '.odin-memory']) {
    mkdirSync(join(path, folder), { recursive: true });
    writeFileSync(join(path, folder, 'config.json'), typeof body === 'string' ? body : JSON.stringify(body));
  }
};

/** Traduce los textos de la referencia a la identidad de odin. */
const translate = (text) => text.replaceAll('.engram', '.odin-memory').replaceAll('ENGRAM_PROJECT', 'ODIN_PROJECT').replaceAll('engram init', 'odin init');

async function compare(label, directory) {
  const ref = await engram.call('mem_current_project', { directory });
  assert.equal(ref.isError, false, ref.text);
  const mine = detectProjectFull(directory);
  const r = ref.json;
  assert.deepEqual(
    { project: mine.project ?? '', source: mine.source ?? '', path: mine.path ?? '', error: mine.error?.message ?? '', available: mine.available_projects ?? null },
    { project: r.project, source: r.project_source, path: r.project_path, error: translate(r.error_hint ?? ''), available: r.available_projects },
    label,
  );
}

test('directorios sin git', { skip }, async () => {
  await compare('nombre del directorio', dir('Mi--Carpeta'));
  await compare('nombre con espacios y mayúsculas', dir('Con Espacios Y MAYÚSCULAS'));
  await compare('directorio inexistente', join(base, 'no-existe'));
  await compare('nombre con caracteres especiales', dir('año_nuevo--2026'));
});

test('configuración válida e inválida', { skip }, async () => {
  const ok = dir('cfg-ok');
  config(ok, { project_name: '  Nombre--Cfg ' });
  await compare('configuración válida', ok);
  for (const [name, body] of [
    ['vacía', {}], ['en blanco', { project_name: '  ' }], ['ruta', { project_name: 'a/b' }], ['ruta inversa', { project_name: 'a\\b' }],
    ['control', { project_name: 'a\u0007b' }], ['nula', 'null'],
  ]) {
    const d = dir(`cfg-${name}`);
    config(d, body);
    await compare(`configuración ${name}`, d);
  }
  const root = repo(join(base, 'cfg-repo'));
  config(root, { project_name: 'desde-la-raiz' });
  const sub = dir('cfg-repo', 'src', 'modulo');
  await compare('configuración heredada de la raíz del repositorio', sub);
  config(sub, { project_name: 'mas-cercana' });
  await compare('la configuración más cercana gana', sub);
});

test('repositorios: remoto, raíz, subdirectorio, vínculo persistente y worktrees', { skip }, async () => {
  const withRemote = repo(join(base, 'carpeta-local'), 'git@github.com:org/Nombre-Remoto.git');
  await compare('con remoto', withRemote);
  await compare('subdirectorio', dir('carpeta-local', 'a', 'b'));
  git(withRemote, 'remote', 'set-url', 'origin', 'https://example.com/org/cambiado.git');
  await compare('el vínculo conserva el nombre tras cambiar el remoto', withRemote);

  const noRemote = repo(join(base, 'Sin--Remoto'));
  await compare('sin remoto', noRemote);
  const moved = join(base, 'movido');
  renameSync(noRemote, moved);
  await compare('el vínculo sobrevive a renombrar el directorio', moved);

  for (const [i, url] of ['https://github.com/org/Repo-Https.git', 'ssh://git@host:2222/grupo/sub/proyecto', '/srv/git/Local-Path.git', 'host:Repo-Scp'].entries()) {
    await compare(`remoto ${url}`, repo(join(base, `urls-${i}`), url));
  }

  const principal = repo(join(base, 'principal'));
  git(principal, 'commit', '--allow-empty', '-q', '-m', 'inicio');
  await compare('repositorio principal', principal);
  const linked = join(base, 'enlazado');
  git(principal, 'worktree', 'add', '-q', linked, '-b', 'rama');
  await compare('worktree enlazado', linked);
});

test('repositorios hijos: único, ambiguo y ruido', { skip }, async () => {
  const single = dir('padre-unico');
  repo(join(single, 'el-hijo'));
  mkdirSync(join(single, 'node_modules', '.git'), { recursive: true });
  mkdirSync(join(single, '.oculto', '.git'), { recursive: true });
  for (const noise of ['vendor', 'dist', 'build', 'target', '.idea']) mkdirSync(join(single, noise, '.git'), { recursive: true });
  writeFileSync(join(single, 'archivo.txt'), 'x');
  await compare('un único hijo', single);

  const ambiguous = dir('padre-ambiguo');
  repo(join(ambiguous, 'Beta'));
  repo(join(ambiguous, 'alfa'));
  repo(join(ambiguous, 'gamma')); // el escaneo se detiene al segundo: con tres solo se listan dos
  await compare('dos hijos', ambiguous);

  const onlyNoise = dir('padre-ruido');
  for (const noise of ['vendor', 'dist', 'build', 'target', '__pycache__', '.venv']) mkdirSync(join(onlyNoise, noise, '.git'), { recursive: true });
  await compare('solo ruido', onlyNoise);
});
