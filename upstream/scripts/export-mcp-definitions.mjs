#!/usr/bin/env node
// Genera las definiciones de herramientas MCP del producto a partir del volcado de
// `tools/list` de la referencia (upstream/contracts/mcp-tools.json), aplicando los
// renombres de identidad. Escribe:
//   src/mcp/tool-definitions.js                       (y su espejo en implementacion/fuentes)
//   test/contract/fixtures/mcp-tools.json             (y su espejo)
// Falla si queda algún término prohibido.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const snapshot = JSON.parse(readFileSync(join(root, 'upstream', 'contracts', 'mcp-tools.json'), 'utf8'));

/** Renombres, de lo más específico a lo más general. */
const RENAMES = [
  ["'Engram,engram-memory,ENGRAM'", "'Odin,odin-memory,ODIN'"],
  ["(e.g. 'engram')", "(e.g. 'odin')"],
  ['marked_by_actor="engram"', 'marked_by_actor="odin"'],
  ['engram doctor --json', 'odin doctor --json'],
  ['engram projects list', 'odin projects list'],
  ['Run Engram Doctor', 'Run Odin Doctor'],
  ['"claude-haiku-4-5"', '"gpt-4.1"'],
  [/Engram/g, 'odin-memory'],
];
const rename = (value) => {
  if (typeof value === 'string') return RENAMES.reduce((text, [from, to]) => text.replaceAll(from, to), value);
  if (Array.isArray(value)) return value.map(rename);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v)]));
  return value;
};

const tools = rename(snapshot.tools).sort((a, b) => a.name.localeCompare(b.name));
const forbidden = readFileSync(join(root, 'upstream', 'forbidden-terms.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => new RegExp(l, 'i'));
const text = JSON.stringify(tools);
for (const pattern of forbidden) if (pattern.test(text)) throw new Error(`queda un término prohibido (${pattern}) en las definiciones`);

const source = `// Definiciones de las herramientas MCP (nombre, descripción, esquema de parámetros y anotaciones).
// Son contrato con el agente: no se editan a mano. \`defer_loading\` marca las herramientas que el
// anfitrión puede cargar bajo demanda.
/** @type {ReadonlyArray<{ name: string, description: string, inputSchema: object, annotations: object, defer_loading?: boolean }>} */
export const TOOL_DEFINITIONS = Object.freeze(${JSON.stringify(tools, null, 2)});
`;
const fixture = `${JSON.stringify({ tools }, null, 2)}\n`;
for (const [rel, content] of [['src/mcp/tool-definitions.js', source], ['test/contract/fixtures/mcp-tools.json', fixture]]) {
  for (const dest of [rel, join('implementacion', 'fuentes', rel)]) {
    mkdirSync(dirname(join(root, dest)), { recursive: true });
    writeFileSync(join(root, dest), content);
  }
  console.log(`escrito: ${rel}`);
}
