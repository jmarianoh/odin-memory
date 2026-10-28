#!/usr/bin/env node
// Guardia de sala limpia: falla si algún archivo de la zona Producto contiene
// un término prohibido. Los términos se leen de upstream/forbidden-terms.txt
// (una expresión regular por línea) o, si no existe, de la variable de entorno
// ODIN_FORBIDDEN_TERMS (separadas por coma). Sin términos, no hay nada que comprobar.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Zona de seguimiento y artefactos que no forman parte del producto.
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'upstream', 'coverage']);
const EXCLUDED_FILES = new Set(['.github/workflows/upstream-watch.yml']);

function loadPatterns() {
  const file = join(root, 'upstream', 'forbidden-terms.txt');
  let lines = [];
  if (existsSync(file)) {
    lines = readFileSync(file, 'utf8').split('\n');
  } else if (process.env.ODIN_FORBIDDEN_TERMS) {
    lines = process.env.ODIN_FORBIDDEN_TERMS.split(',');
  }
  return lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => new RegExp(l, 'i'));
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

const patterns = loadPatterns();
if (patterns.length === 0) {
  console.log('check:clean-room: sin términos configurados, nada que comprobar.');
  process.exit(0);
}

const violations = [];
for (const file of walk(root)) {
  const rel = relative(root, file).split(sep).join('/');
  if (EXCLUDED_FILES.has(rel)) continue;
  const buf = readFileSync(file);
  if (isBinary(buf)) continue;
  const text = buf.toString('utf8');
  // También se revisa el nombre de la ruta.
  const targets = [['(ruta)', rel], ...text.split('\n').map((line, i) => [String(i + 1), line])];
  for (const [where, content] of targets) {
    if (patterns.some((p) => p.test(content))) violations.push(`${rel}:${where}`);
  }
}

if (violations.length > 0) {
  console.error(`check:clean-room: ${violations.length} coincidencias en la zona Producto:`);
  for (const v of violations.slice(0, 50)) console.error(`  ${v}`);
  process.exit(1);
}
console.log('check:clean-room: limpio.');
