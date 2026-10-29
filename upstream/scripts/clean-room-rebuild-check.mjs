#!/usr/bin/env node
// F10 — validación en sala limpia (parte automática).
// Copia SOLO `implementacion/` a un directorio vacío (como en el repositorio cerrado) y comprueba, sobre esa copia, que
// contiene todo lo necesario para reconstruir el producto:
//   1. ningún término prohibido en ningún archivo;
//   2. los enlaces entre documentos se resuelven dentro de la copia;
//   3. manifest.json: cada módulo, documento y test existe en la copia, y cada módulo se nombra en su documento;
//   4. fuentes/ contiene todos los tests y cada test sólo importa módulos declarados en el manifiesto;
//   5. toda variable ODIN_* y todo subcomando de `odin` que usa el código figura en los documentos;
//   6. las dependencias de fuentes/package.json coinciden con las que documenta 03-entorno-dependencias.md;
//   7. cada versión de cambios/ tiene su VERSION coherente y los archivos de fuentes/ son copia exacta del repositorio;
//   8. con `--rebuild`: monta fuentes/ + src/ del repositorio en un directorio nuevo, instala las dependencias declaradas
//      (npm install) y ejecuta check:clean-room, check:implementacion y la suite completa sobre esa copia.
// Uso: node upstream/scripts/clean-room-rebuild-check.mjs [--rebuild]
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const rebuild = process.argv.includes('--rebuild');
const failures = [];
const fail = (message) => failures.push(message);
const posix = (p) => p.split(sep).join('/');

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

const work = mkdtempSync(join(tmpdir(), 'odin-clean-room-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
cpSync(join(repo, 'implementacion'), join(work, 'implementacion'), { recursive: true });
const impl = join(work, 'implementacion');
const files = [...walk(impl)].map((f) => posix(relative(impl, f)));
const text = (rel) => readFileSync(join(impl, rel), 'utf8');
const docs = files.filter((f) => f.endsWith('.md') && !f.startsWith('fuentes/') && !f.startsWith('cambios/'));
const allDocsText = [...files.filter((f) => f.endsWith('.md'))].map(text).join('\n');

// 1. términos prohibidos
const terms = readFileSync(join(repo, 'upstream/forbidden-terms.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => new RegExp(l, 'i'));
for (const f of files) {
  const body = text(f);
  for (const term of terms) if (term.test(body) || term.test(f)) fail(`término prohibido ${term} en ${f}`);
}

// 2. enlaces entre documentos
for (const f of files.filter((x) => x.endsWith('.md') && !x.startsWith('fuentes/'))) {
  for (const m of text(f).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/i.test(target)) fail(`${f}: enlace externo ${target}`);
    else if (!existsSync(resolve(join(impl, dirname(f)), target))) fail(`${f}: el enlace ${target} no existe`);
  }
}

// 3. manifiesto
const manifest = JSON.parse(text('manifest.json'));
const version = text('VERSION').trim();
if (manifest.version !== version) fail(`manifest.version ${manifest.version} ≠ VERSION ${version}`);
if (!files.includes(`cambios/${version}.md`)) fail(`falta cambios/${version}.md`);
for (const entry of manifest.files) {
  if (!files.includes(entry.doc) && !existsSync(join(impl, entry.doc))) fail(`${entry.path}: falta el documento ${entry.doc}`);
  else if (!text(entry.doc).includes(entry.path.split('/').at(-1).replace(/\.js$/, ''))) {
    const base = entry.path.split('/').at(-1);
    if (!text(entry.doc).includes(base) && !text(entry.doc).includes(base.replace(/\.js$/, ''))) fail(`${entry.path}: ${entry.doc} no nombra el módulo`);
  }
  for (const t of entry.tests ?? []) if (!files.includes(`fuentes/${t}`)) fail(`${entry.path}: el test ${t} no está en fuentes/`);
}
const manifested = new Set(manifest.files.map((e) => e.path));

// 4. tests completos y módulos que importan
const repoTests = [...walk(join(repo, 'test'))].map((f) => posix(relative(repo, f)));
for (const t of repoTests) if (!files.includes(`fuentes/${t}`)) fail(`el test ${t} no está en fuentes/`);
const known = (p) => manifested.has(p) || files.includes(`fuentes/${p}`);
for (const f of files.filter((x) => /^fuentes\/test\/.*\.(js|mjs)$/.test(x))) {
  for (const m of text(f).matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
    const resolved = posix(relative(join(impl, 'fuentes'), resolve(join(impl, 'fuentes', dirname(f.slice('fuentes/'.length))), m[1])));
    if (resolved.startsWith('test/') || resolved.startsWith('..')) continue;
    if (!known(resolved) && !known(`${resolved}.js`) && !known(`${resolved}/index.js`)) fail(`${f}: importa ${resolved}, que no figura en el manifiesto ni en fuentes/`);
  }
}

// 5. variables de entorno y subcomandos que usa el código
const srcFiles = [...walk(join(repo, 'src')), join(repo, 'bin/odin.js')];
const envVars = new Set();
for (const f of srcFiles) for (const m of readFileSync(f, 'utf8').matchAll(/\bODIN_[A-Z0-9_]+\b/g)) envVars.add(m[0]);
for (const v of [...envVars].sort()) if (!allDocsText.includes(v)) fail(`la variable ${v} no figura en ningún documento`);
const dispatch = readFileSync(join(repo, 'src/cli/index.js'), 'utf8');
for (const m of dispatch.matchAll(/case '([a-z][a-z-]+)':/g)) if (!allDocsText.includes(m[1])) fail(`el comando «${m[1]}» no figura en ningún documento`);
for (const m of readFileSync(join(repo, 'src/cli/commands/cloud.js'), 'utf8').matchAll(/case '([a-z][a-z-]+)':/g)) if (!allDocsText.includes(m[1])) fail(`el subcomando de cloud «${m[1]}» no figura en ningún documento`);

// 6. dependencias
const pkg = JSON.parse(text('fuentes/package.json'));
const depDoc = text('03-entorno-dependencias.md');
for (const [name, ver] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
  if (!new RegExp(`\`${name.replace(/[/@.]/g, '\\$&')}\`[^\\n]*\\|\\s*${ver.replace(/\./g, '\\.')}\\s*\\|`).test(depDoc) && !depDoc.includes(`${name}\` | ${ver}`) && !depDoc.includes(`| ${ver} |`)) fail(`dependencia ${name}@${ver} sin versión documentada en 03-entorno-dependencias.md`);
  if (/^[\^~]/.test(ver)) fail(`dependencia ${name} sin versión exacta (${ver})`);
}

// 7. cambios y copia exacta
for (const f of files.filter((x) => /^cambios\/.+\.md$/.test(x))) if (!/^\d+\.\d+\.\d+\.md$/.test(f.slice('cambios/'.length))) fail(`${f}: nombre de cambios no válido`);
for (const f of files.filter((x) => x.startsWith('fuentes/') && !x.endsWith('.md'))) {
  const original = join(repo, f.slice('fuentes/'.length));
  if (!existsSync(original)) fail(`${f}: no existe en el repositorio`);
  else if (!readFileSync(original).equals(readFileSync(join(impl, f)))) fail(`${f}: difiere del repositorio`);
}

// 8. reconstrucción (opcional)
if (rebuild) {
  const build = join(work, 'build');
  cpSync(join(impl, 'fuentes'), build, { recursive: true });
  for (const dir of ['src', 'bin', 'static', 'docker']) if (existsSync(join(repo, dir))) cpSync(join(repo, dir), join(build, dir), { recursive: true });
  cpSync(join(impl, ''), join(build, 'implementacion'), { recursive: true });
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: build, encoding: 'utf8' });
  if (install.status !== 0) fail(`npm install falló:\n${install.stderr}`);
  else {
    execFileSync('git', ['init', '-q'], { cwd: build });
    const run = (args, label) => {
      const r = spawnSync(process.execPath, args, { cwd: build, encoding: 'utf8', env: { ...process.env, ODIN_FORBIDDEN_TERMS: terms.map((t) => t.source).join(',') } });
      if (r.status !== 0) fail(`${label} falló:\n${(r.stdout + r.stderr).split('\n').slice(-25).join('\n')}`);
    };
    // El binario de Postgres embebido necesita sus enlaces simbólicos (el postinstall no se ejecuta con --ignore-scripts).
    const scopeDir = join(build, 'node_modules/@embedded-postgres');
    if (existsSync(scopeDir)) for (const name of readdirSync(scopeDir)) if (existsSync(join(scopeDir, name, 'scripts/hydrate-symlinks.js'))) spawnSync(process.execPath, ['scripts/hydrate-symlinks.js'], { cwd: join(scopeDir, name) });
    run(['scripts/check-clean-room.mjs'], 'check:clean-room');
    run(['scripts/check-implementacion.mjs'], 'check:implementacion');
    run(['--test', '--test-force-exit', 'test/**/*.test.js'], 'npm test');
  }
}

if (failures.length > 0) {
  console.error(`clean-room-rebuild-check: ${failures.length} fallo(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`clean-room-rebuild-check: ok (${files.length} archivos, ${manifest.files.length} módulos, ${repoTests.length} tests, ${envVars.size} variables ODIN_*)`);
