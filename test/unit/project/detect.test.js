import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AmbiguousProjectError, ExplicitProjectRequiredError, InvalidConfigError, ProjectHistoryUnavailableError, ProjectTransitionError,
  REPOSITORY_BINDING_FILENAME, RepositoryBindingError, SOURCE_AMBIGUOUS, SOURCE_CONFIG, SOURCE_DIR_BASENAME, SOURCE_GIT_CHILD,
  SOURCE_GIT_REMOTE, SOURCE_GIT_ROOT, SOURCE_UNBOUND_GIT, detectProjectFull, extractRepoName, processOverride, scanClock,
} from '../../../src/project/index.js';
import { git, initRepo, tempDir, write } from './helpers.js';

const config = (dir, body) => write(join(dir, '.odin-memory', 'config.json'), typeof body === 'string' ? body : JSON.stringify(body));

test('extractRepoName acepta URLs https, ssh y rutas locales', () => {
  assert.equal(extractRepoName('https://github.com/org/Mi-Repo.git'), 'Mi-Repo');
  assert.equal(extractRepoName('git@github.com:org/otro.git'), 'otro');
  assert.equal(extractRepoName('/srv/git/local'), 'local');
  assert.equal(extractRepoName('ssh://git@host:2222/grupo/sub/proyecto'), 'proyecto');
  assert.equal(extractRepoName(''), '');
  assert.equal(extractRepoName('///'), '');
});

test('processOverride: el valor explícito gana a la variable de entorno', () => {
  assert.deepEqual(processOverride('  Mi  ', { ODIN_PROJECT: 'env' }), { value: 'Mi', ok: true });
  assert.deepEqual(processOverride('', { ODIN_PROJECT: ' desde-env ' }), { value: 'desde-env', ok: true });
  assert.deepEqual(processOverride(undefined, {}), { value: '', ok: false });
  assert.deepEqual(processOverride('   ', { ODIN_PROJECT: '  ' }), { value: '', ok: false });
});

test('un directorio sin git ni configuración usa su nombre', (t) => {
  const dir = join(tempDir(t), 'Mi--Carpeta');
  mkdirSync(dir);
  assert.deepEqual(detectProjectFull(dir), { project: 'mi-carpeta', source: SOURCE_DIR_BASENAME, path: dir });
});

test('la configuración fija el proyecto y se busca hacia arriba solo dentro del worktree', (t) => {
  const base = tempDir(t);
  const repo = initRepo(join(base, 'repo'));
  config(repo, { project_name: '  Nombre--Configurado ' });
  const sub = join(repo, 'src', 'modulo');
  mkdirSync(sub, { recursive: true });
  assert.deepEqual(detectProjectFull(repo), { project: 'nombre-configurado', source: SOURCE_CONFIG, path: repo });
  assert.equal(detectProjectFull(sub).project, 'nombre-configurado'); // desde un subdirectorio
  assert.equal(detectProjectFull(sub).path, repo);
  // fuera de git solo cuenta el propio directorio
  const plain = join(base, 'plano');
  const nested = join(plain, 'hijo');
  mkdirSync(nested, { recursive: true });
  config(plain, { project_name: 'plano-cfg' });
  assert.equal(detectProjectFull(plain).project, 'plano-cfg');
  assert.deepEqual(detectProjectFull(nested), { project: 'hijo', source: SOURCE_DIR_BASENAME, path: nested });
});

test('la configuración inválida produce un error explícito', (t) => {
  const cases = [
    ['{no es json', /^invalid \.odin-memory\/config\.json: parse .*config\.json: /],
    [{}, /^invalid \.odin-memory\/config\.json: invalid \.odin-memory\/config\.json: project_name is required$/],
    [{ project_name: '   ' }, /project_name is required$/],
    [{ project_name: 'a/b' }, /project_name must be a name, not a path$/],
    [{ project_name: 'a\\b' }, /project_name must be a name, not a path$/],
    [{ project_name: 'a\u0007b' }, /project_name contains control characters$/],
    [{ project_name: 12 }, /project_name must be a string$/],
    ['null', /project_name is required$/],
  ];
  for (const [body, pattern] of cases) {
    const dir = join(tempDir(t), 'p');
    mkdirSync(dir);
    config(dir, body);
    const result = detectProjectFull(dir);
    assert.equal(result.source, SOURCE_CONFIG);
    assert.equal(result.project, '');
    assert.ok(result.error instanceof InvalidConfigError, JSON.stringify(body));
    assert.match(result.error.message, pattern, JSON.stringify(body));
  }
});

test('un repositorio sin remoto usa la raíz y fija un vínculo persistente', (t) => {
  const base = tempDir(t);
  const repo = initRepo(join(base, 'Mi-Repo'));
  const result = detectProjectFull(repo);
  assert.deepEqual(result, { project: 'mi-repo', source: SOURCE_GIT_ROOT, path: repo });
  const bindingFile = join(repo, '.git', REPOSITORY_BINDING_FILENAME);
  const binding = JSON.parse(readFileSync(bindingFile, 'utf8'));
  assert.deepEqual([binding.version, binding.project, /^[0-9a-f]{32}$/.test(binding.id)], [1, 'mi-repo', true]);
  assert.equal(statSync(bindingFile).mode & 0o777, 0o600);
  // el vínculo sobrevive a renombrar el directorio
  const renamed = join(base, 'otro-nombre');
  renameSync(repo, renamed);
  assert.equal(detectProjectFull(renamed).project, 'mi-repo');
});

test('con remoto origin se usa su nombre, también desde subdirectorios, y el vínculo fija el proyecto', (t) => {
  const base = tempDir(t);
  const repo = initRepo(join(base, 'carpeta-local'), 'git@github.com:org/Nombre-Remoto.git');
  const sub = join(repo, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  assert.deepEqual(detectProjectFull(sub), { project: 'nombre-remoto', source: SOURCE_GIT_REMOTE, path: repo });
  git(repo, 'remote', 'set-url', 'origin', 'https://example.com/org/cambiado.git');
  assert.equal(detectProjectFull(repo).project, 'nombre-remoto'); // ya está fijado
  assert.equal(detectProjectFull(repo).source, SOURCE_GIT_REMOTE);
});

test('un worktree enlazado comparte el proyecto del repositorio principal', (t) => {
  const base = tempDir(t);
  const repo = initRepo(join(base, 'principal'));
  git(repo, 'commit', '--allow-empty', '-q', '-m', 'inicio');
  const linked = join(base, 'enlazado');
  git(repo, 'worktree', 'add', '-q', linked, '-b', 'rama');
  assert.equal(detectProjectFull(repo).project, 'principal');
  const fromLinked = detectProjectFull(linked);
  assert.equal(fromLinked.project, 'principal');
  assert.equal(fromLinked.path, repo); // la raíz del repositorio principal
});

test('un vínculo inválido se rechaza y no se sobrescribe', (t) => {
  const repo = initRepo(join(tempDir(t), 'repo'));
  const file = join(repo, '.git', REPOSITORY_BINDING_FILENAME);
  for (const body of ['basura', JSON.stringify({ version: 2, id: 'a'.repeat(32), project: 'x' }), JSON.stringify({ version: 1, id: 'corto', project: 'x' }), JSON.stringify({ version: 1, id: 'a'.repeat(32), project: 'Mayúsculas' })]) {
    write(file, body);
    const result = detectProjectFull(repo);
    assert.ok(result.error instanceof RepositoryBindingError, body);
    assert.equal(result.source, SOURCE_GIT_ROOT);
    assert.equal(readFileSync(file, 'utf8'), body);
  }
});

test('un único repositorio hijo se promueve; varios son ambiguos; el ruido se ignora', (t) => {
  const base = tempDir(t);
  const parent = join(base, 'padre');
  mkdirSync(parent);
  initRepo(join(parent, 'unico'));
  for (const noise of ['node_modules', 'vendor', 'dist', 'build', 'target', '__pycache__', '.idea', '.vscode', '.venv']) mkdirSync(join(parent, noise, '.git'), { recursive: true }); // ruido
  mkdirSync(join(parent, '.oculto', '.git'), { recursive: true }); // oculto
  write(join(parent, 'archivo.txt'));
  const single = detectProjectFull(parent);
  assert.equal(single.source, SOURCE_GIT_CHILD);
  assert.equal(single.project, 'unico');
  assert.equal(single.path, join(parent, 'unico'));
  assert.equal(single.warning, 'auto-promoted child repository: unico');

  initRepo(join(parent, 'Segundo'));
  const ambiguous = detectProjectFull(parent);
  assert.equal(ambiguous.source, SOURCE_AMBIGUOUS);
  assert.ok(ambiguous.error instanceof AmbiguousProjectError);
  assert.equal(ambiguous.project, '');
  assert.deepEqual(ambiguous.available_projects, ['segundo', 'unico']); // ordenados y en minúsculas
  assert.equal(ambiguous.path, parent);

  // el escaneo se detiene al encontrar el segundo repositorio: con tres solo se listan dos
  initRepo(join(parent, 'alfa'));
  const three = detectProjectFull(parent);
  assert.equal(three.source, SOURCE_AMBIGUOUS);
  assert.equal(three.available_projects.length, 2);
  assert.deepEqual(three.available_projects, [...three.available_projects].sort());
  assert.ok(three.available_projects.every((name) => ['alfa', 'segundo', 'unico'].includes(name)));
});

test('si el escaneo de hijos excede 200 ms se usa el nombre del directorio', (t) => {
  const parent = join(tempDir(t), 'padre');
  mkdirSync(parent);
  initRepo(join(parent, 'hijo'));
  const real = scanClock.now;
  let calls = 0;
  scanClock.now = () => (calls++ < 2 ? 1_000 : 1_000_000); // arranca bien y pronto pasa el plazo
  t.after(() => {
    scanClock.now = real;
  });
  assert.deepEqual(detectProjectFull(parent), { project: 'padre', source: SOURCE_DIR_BASENAME, path: parent });
});

test('inspectOnly no crea el vínculo y marca el origen como sin vincular', (t) => {
  const repo = initRepo(join(tempDir(t), 'repo'));
  assert.deepEqual(detectProjectFull(repo, { inspectOnly: true }), { project: 'repo', source: SOURCE_UNBOUND_GIT, path: repo });
  assert.throws(() => statSync(join(repo, '.git', REPOSITORY_BINDING_FILENAME)), { code: 'ENOENT' });
  assert.equal(detectProjectFull(repo).source, SOURCE_GIT_ROOT); // sin inspectOnly sí se crea
  assert.equal(detectProjectFull(repo, { inspectOnly: true }).source, SOURCE_GIT_ROOT); // ya vinculado
});

test('el historial del directorio puede obligar a elegir explícitamente', (t) => {
  const repo = initRepo(join(tempDir(t), 'nuevo-nombre'));
  const transition = detectProjectFull(repo, { historyLookup: () => ['nombre-viejo'] });
  assert.ok(transition.error instanceof ProjectTransitionError);
  assert.deepEqual([transition.error.candidate, transition.error.historicalProjects, transition.available_projects], ['nuevo-nombre', ['nombre-viejo'], ['nombre-viejo', 'nuevo-nombre']]);
  assert.match(transition.error.message, /would select project "nuevo-nombre", but this directory has history under nombre-viejo; choose explicitly or run odin init <project>/);
  assert.throws(() => statSync(join(repo, '.git', REPOSITORY_BINDING_FILENAME)), { code: 'ENOENT' }); // no se vincula
  // si el historial coincide, se vincula con normalidad
  assert.equal(detectProjectFull(repo, { historyLookup: () => ['nuevo-nombre'] }).project, 'nuevo-nombre');
  const other = initRepo(join(tempDir(t), 'otro'));
  const failing = detectProjectFull(other, { historyLookup: () => { throw new Error('base bloqueada'); } });
  assert.ok(failing.error instanceof ProjectHistoryUnavailableError);
  assert.match(failing.error.message, /project history unavailable: base bloqueada/);
});

test('un directorio que empieza por guion se trata como ruta relativa (el nombre conserva el guion)', (t) => {
  const base = tempDir(t);
  mkdirSync(join(base, '-raro'));
  const previous = process.cwd();
  process.chdir(base);
  t.after(() => process.chdir(previous));
  const result = detectProjectFull('-raro');
  assert.equal(result.project, '-raro');
  assert.equal(result.path, join(base, '-raro'));
});

test('en el repositorio de HOME exige un proyecto explícito salvo en carpetas con archivos versionados', (t) => {
  const home = initRepo(join(tempDir(t), 'home'));
  const tracked = join(home, 'proyectos', 'con-archivos');
  const untracked = join(home, 'proyectos', 'sin-archivos');
  write(join(tracked, 'a.txt'));
  mkdirSync(untracked, { recursive: true });
  git(home, 'add', 'proyectos/con-archivos/a.txt');
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previous;
  });
  const options = { requireExplicitHomeProject: true };
  assert.equal(detectProjectFull(tracked, options).error, undefined);
  const refused = detectProjectFull(untracked, options);
  assert.ok(refused.error instanceof ExplicitProjectRequiredError);
  assert.match(refused.error.message, /explicit project required: use --project, ODIN_PROJECT, or \.odin-memory\/config\.json project_name/);
  assert.equal(detectProjectFull(home, options).error, undefined); // la raíz de HOME no se restringe
  assert.equal(detectProjectFull(untracked).error, undefined); // sin la opción no se exige
  chmodSync(home, 0o755);
});
