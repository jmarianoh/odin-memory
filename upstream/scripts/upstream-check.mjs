#!/usr/bin/env node
// Compara la versión de engram fijada en upstream/engram.lock.json con otra
// referencia (por defecto HEAD) y genera un reporte de qué hay que portar.
//
// Uso: node upstream/scripts/upstream-check.mjs --engram <checkout> [--to <ref>]
//        [--skip-binary] [--write-contracts] [--no-report]
//   --to               tag, rama o SHA destino (por defecto HEAD)
//   --skip-binary      no compila engram: omite esquema SQL y herramientas MCP
//   --write-contracts  reemplaza upstream/contracts por las instantáneas nuevas
//   --no-report        imprime el reporte sin escribirlo en upstream/reports/
// Código de salida: 0 sin cambios o reporte generado; 1 error; 3 hay cambios portables.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot } from './snapshot-contracts.mjs';

const upstreamDir = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const engram = opt('--engram');
if (!engram) {
  console.error('uso: upstream-check.mjs --engram <checkout> [--to <ref>] [--skip-binary] [--write-contracts] [--no-report]');
  process.exit(1);
}
const git = (...a) => execFileSync('git', ['-C', engram, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();

const lock = JSON.parse(readFileSync(join(upstreamDir, 'engram.lock.json'), 'utf8'));
const portMap = JSON.parse(readFileSync(join(upstreamDir, 'port-map.json'), 'utf8'));
const toRef = opt('--to') ?? 'HEAD';
const toSha = git('rev-parse', '--verify', `${toRef}^{commit}`);

if (toSha === lock.commit) {
  console.log(`sin cambios: engram sigue en ${lock.tag} (${lock.commit.slice(0, 7)})`);
  process.exit(0);
}
try {
  git('merge-base', '--is-ancestor', lock.commit, toSha);
} catch {
  console.error(`el commit fijado ${lock.commit.slice(0, 7)} no es ancestro de ${toRef} (${toSha.slice(0, 7)})`);
  process.exit(1);
}

// glob → RegExp: ** cruza directorios, * no.
const globRe = (g) =>
  new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
const matchesAny = (file, globs) => globs.some((g) => globRe(g).test(file));

function classify(file) {
  if (matchesAny(file, portMap.excluded)) return { kind: 'excluido' };
  if (file.endsWith('_test.go')) {
    const hit = portMap.map.find((m) => matchesAny(file, m.go));
    return { kind: 'test', ...(hit && { entry: hit }) };
  }
  if (matchesAny(file, portMap.docsOrCi)) return { kind: 'docs/ci' };
  const hit = portMap.map.find((m) => matchesAny(file, m.go));
  return hit ? { kind: 'portable', entry: hit } : { kind: 'sin-mapear' };
}

const changes = git('diff', '--name-status', '--no-renames', `${lock.commit}..${toSha}`)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [status, file] = l.split('\t');
    return { status, file, ...classify(file) };
  });

const commits = git('log', '--no-merges', '--format=%h%x09%s', `${lock.commit}..${toSha}`)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [sha, ...rest] = l.split('\t');
    const subject = rest.join('\t');
    const m = subject.match(/^(\w+)(\([^)]*\))?(!)?:/);
    return { sha, subject, type: m ? m[1] : 'otro', breaking: Boolean(m?.[3]) };
  });

// Instantáneas del destino (árbol exportado, sin tocar el checkout).
const work = mkdtempSync(join(tmpdir(), 'upstream-check-'));
let contractDiffs = [];
try {
  const tree = join(work, 'tree');
  mkdirSync(tree);
  const tar = execFileSync('git', ['-C', engram, 'archive', '--format=tar', toSha], { maxBuffer: 1024 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', tree], { input: tar });
  const fresh = join(work, 'contracts');
  await snapshot({ engramDir: tree, outDir: fresh, skipBinary: args.includes('--skip-binary') });
  const current = join(upstreamDir, 'contracts');
  for (const name of readdirSync(fresh).sort()) {
    const a = existsSync(join(current, name)) ? readFileSync(join(current, name), 'utf8') : null;
    const b = readFileSync(join(fresh, name), 'utf8');
    if (a !== b) contractDiffs.push({ name, summary: summarize(name, a, b), hint: portMap.contracts[name] ?? '' });
  }
  if (args.includes('--write-contracts')) cpSync(fresh, current, { recursive: true });
} finally {
  rmSync(work, { recursive: true, force: true });
}

function summarize(name, a, b) {
  if (a === null) return 'archivo nuevo';
  if (name === 'mcp-tools.json') {
    const names = (t) => new Set(JSON.parse(t).tools.map((x) => x.name));
    const [oa, ob] = [names(a), names(b)];
    const added = [...ob].filter((n) => !oa.has(n));
    const removed = [...oa].filter((n) => !ob.has(n));
    return `herramientas añadidas: [${added}] · eliminadas: [${removed}] · (descripciones/anotaciones pueden haber cambiado)`;
  }
  if (name === 'tool-contract.json') {
    const keys = (t) => new Set(Object.keys(JSON.parse(t).tools));
    const [oa, ob] = [keys(a), keys(b)];
    return `herramientas añadidas: [${[...ob].filter((n) => !oa.has(n))}] · eliminadas: [${[...oa].filter((n) => !ob.has(n))}]`;
  }
  if (name === 'http-routes.json') {
    const keys = (t) => new Set(JSON.parse(t).map((r) => r.pattern));
    const [oa, ob] = [keys(a), keys(b)];
    return `rutas añadidas: [${[...ob].filter((n) => !oa.has(n))}] · eliminadas: [${[...oa].filter((n) => !ob.has(n))}]`;
  }
  const [la, lb] = [new Set(a.split('\n')), new Set(b.split('\n'))];
  return `${[...lb].filter((l) => !la.has(l)).length} líneas nuevas · ${[...la].filter((l) => !lb.has(l)).length} líneas retiradas`;
}

// Reporte
const by = (kind) => changes.filter((c) => c.kind === kind);
const portable = by('portable');
const modules = new Map();
for (const c of [...portable, ...by('test')]) {
  if (!c.entry) continue;
  const key = c.entry.js.join(', ');
  const item = modules.get(key) ?? { js: c.entry.js, doc: c.entry.doc, phase: c.entry.phase, files: [] };
  item.files.push(`${c.status} ${c.file}`);
  modules.set(key, item);
}
const typeCount = {};
for (const c of commits) typeCount[c.type] = (typeCount[c.type] ?? 0) + 1;

const lines = [];
lines.push(`# Reporte upstream: ${lock.tag} (${lock.commit.slice(0, 7)}) → ${toRef} (${toSha.slice(0, 7)})`);
lines.push('', `Generado: ${new Date().toISOString()}`, '');
lines.push('## Resumen', '');
lines.push(`- Commits: ${commits.length} (${Object.entries(typeCount).map(([k, v]) => `${k}: ${v}`).join(', ') || 'ninguno'})`);
lines.push(`- Archivos: ${changes.length} · portables: ${portable.length} · tests: ${by('test').length} · docs/ci: ${by('docs/ci').length} · excluidos: ${by('excluido').length} · sin mapear: ${by('sin-mapear').length}`);
lines.push(`- Contratos modificados: ${contractDiffs.length}`);
const breaking = commits.filter((c) => c.breaking);
if (breaking.length) lines.push(`- **Cambios incompatibles**: ${breaking.map((c) => c.sha).join(', ')}`);
lines.push('', '## Contratos', '');
if (contractDiffs.length === 0) lines.push('Sin cambios en los contratos.');
for (const d of contractDiffs) lines.push(`- \`${d.name}\`: ${d.summary}${d.hint ? ` → ${d.hint}` : ''}`);
lines.push('', '## Módulos afectados', '');
if (modules.size === 0) lines.push('Ninguno.');
for (const m of modules.values()) {
  lines.push(`### ${m.js.join(', ')} (${m.phase}, doc: ${m.doc})`, '');
  for (const f of m.files.slice(0, 40)) lines.push(`- ${f}`);
  if (m.files.length > 40) lines.push(`- … y ${m.files.length - 40} más`);
  lines.push('');
}
if (by('sin-mapear').length) {
  lines.push('## Archivos sin mapear (decidir: portar o excluir en port-map.json)', '');
  for (const c of by('sin-mapear')) lines.push(`- ${c.status} ${c.file}`);
  lines.push('');
}
lines.push('## Commits', '');
for (const c of commits) lines.push(`- ${c.sha} ${c.subject}`);
lines.push('', '## Checklist', '');
lines.push('- [ ] Portar los cambios con los nombres de odin');
lines.push('- [ ] Actualizar implementacion/ y fuentes/');
lines.push('- [ ] Subir implementacion/VERSION y escribir cambios/<versión>.md');
lines.push('- [ ] npm test, check:implementacion y check:clean-room');
lines.push('- [ ] Tests de conformance contra el binario del destino');
lines.push('- [ ] Actualizar engram.lock.json y CHANGELOG.md');
const report = `${lines.join('\n')}\n`;

if (args.includes('--no-report')) {
  process.stdout.write(report);
} else {
  const dir = join(upstreamDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${lock.commit.slice(0, 7)}-${toSha.slice(0, 7)}.md`);
  writeFileSync(file, report);
  console.log(`reporte: ${file}`);
}
process.exit(portable.length > 0 || contractDiffs.length > 0 ? 3 : 0);
