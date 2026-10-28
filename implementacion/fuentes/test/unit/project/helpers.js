import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Directorio temporal (con rutas reales) que se elimina al terminar la prueba. */
export function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'odin-project-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Ejecuta git con una identidad fija y sin configuración global. */
export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Prueba', '-c', 'user.email=prueba@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

/** Crea un repositorio git en `dir` (con remoto `origin` opcional). */
export function initRepo(dir, remote) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

/** Escribe un archivo creando los directorios necesarios. */
export function write(path, content = 'x') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
