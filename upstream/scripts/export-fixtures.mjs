#!/usr/bin/env node
// Convierte las instantáneas de upstream/contracts en fixtures de la zona
// Producto (test/contract/fixtures y su espejo en implementacion/fuentes),
// aplicando los renombres de identidad. Falla si queda algún término prohibido.
//
// Uso: node upstream/scripts/export-fixtures.mjs [nombre ...]
//   Sin argumentos exporta todos los fixtures definidos en FIXTURES.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const contracts = join(root, 'upstream', 'contracts');

/** Fixtures disponibles: nombre de instantánea → ruta del fixture en el producto. */
const FIXTURES = {
  'sqlite-schema.json': 'test/contract/fixtures/sqlite-schema.json',
};

/** Pares [expresión, reemplazo] aplicados en orden. */
const RENAMES = [
  [/ENGRAM_/g, 'ODIN_'],
  [/\.engram\b/g, '.odin-memory'],
  [/engram\.db/g, 'odin.db'],
  [/engram_/g, 'odin_'],
  [/engram-/g, 'odin-memory-'],
];

const forbidden = readFileSync(join(root, 'upstream', 'forbidden-terms.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => new RegExp(l, 'i'));

const wanted = process.argv.slice(2);
for (const [name, target] of Object.entries(FIXTURES)) {
  if (wanted.length && !wanted.includes(name)) continue;
  let text = readFileSync(join(contracts, name), 'utf8');
  for (const [from, to] of RENAMES) text = text.replace(from, to);
  const hit = forbidden.find((p) => p.test(text));
  if (hit) throw new Error(`${name}: queda un término prohibido (${hit}) tras los renombres`);
  for (const dest of [target, join('implementacion', 'fuentes', target)]) {
    const file = join(root, dest);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  console.log(`fixture escrito: ${target}`);
}
