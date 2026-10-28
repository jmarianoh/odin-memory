#!/usr/bin/env node
// Verifica que implementacion/ describe fielmente el repositorio:
//  1. VERSION es semver, coincide con package.json y existe implementacion/cambios/<VERSION>.md.
//  2. Cada archivo de bin/ y src/ está registrado en implementacion/manifest.json y viceversa.
//  3. Los hashes registrados (código y documento) coinciden con los actuales.
//     Tras revisar la documentación, `--update` vuelve a registrarlos.
//  4. Cada archivo de implementacion/fuentes/ es copia byte a byte del archivo
//     de la misma ruta relativa en la raíz del repositorio.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const impl = join(root, 'implementacion');
const update = process.argv.includes('--update');
const errors = [];

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const posix = (p) => p.split(sep).join('/');

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

// 1. VERSION y cambios
const versionFile = join(impl, 'VERSION');
let version = '';
if (!existsSync(versionFile)) {
  errors.push('falta implementacion/VERSION');
} else {
  version = readFileSync(versionFile, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) errors.push(`VERSION no es semver: "${version}"`);
  if (!existsSync(join(impl, 'cambios', `${version}.md`))) {
    errors.push(`falta implementacion/cambios/${version}.md`);
  }
  const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (pkgVersion !== version) errors.push(`package.json (${pkgVersion}) y implementacion/VERSION (${version}) difieren`);
}

// 2 y 3. manifest
const manifestFile = join(impl, 'manifest.json');
if (!existsSync(manifestFile)) {
  errors.push('falta implementacion/manifest.json');
} else {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (manifest.version !== version) {
    errors.push(`manifest.version (${manifest.version}) distinta de VERSION (${version})`);
  }
  const registered = new Map(manifest.files.map((f) => [f.path, f]));

  for (const dir of ['bin', 'src']) {
    for (const file of walk(join(root, dir))) {
      const rel = posix(relative(root, file));
      if (!registered.has(rel)) errors.push(`${rel} no está en manifest.json`);
    }
  }

  for (const entry of manifest.files) {
    const codeFile = join(root, entry.path);
    const docFile = join(impl, entry.doc);
    if (!existsSync(codeFile)) {
      errors.push(`manifest apunta a un archivo inexistente: ${entry.path}`);
      continue;
    }
    if (!existsSync(docFile)) {
      errors.push(`${entry.path}: documento inexistente (${entry.doc})`);
      continue;
    }
    const code = sha(codeFile);
    const doc = sha(docFile);
    if (update) {
      entry.sha256 = code;
      entry.docSha256 = doc;
    } else {
      if (entry.sha256 !== code) errors.push(`${entry.path}: el código cambió; revisa ${entry.doc} y ejecuta --update`);
      if (entry.docSha256 !== doc) errors.push(`${entry.path}: ${entry.doc} cambió; ejecuta --update tras revisarlo`);
    }
  }
  if (update && errors.length === 0) {
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log('check:implementacion: hashes actualizados.');
  }
}

// 4. fuentes espejo
for (const file of walk(join(impl, 'fuentes'))) {
  const rel = posix(relative(join(impl, 'fuentes'), file));
  const mirror = join(root, rel);
  if (!existsSync(mirror)) errors.push(`fuentes/${rel} no tiene copia en ${rel}`);
  else if (!readFileSync(file).equals(readFileSync(mirror))) errors.push(`fuentes/${rel} difiere de ${rel}`);
}

if (errors.length > 0) {
  console.error('check:implementacion: fallos');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (!update) console.log('check:implementacion: ok.');
