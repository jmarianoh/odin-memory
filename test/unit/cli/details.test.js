import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addObservation } from '../../../src/store/observations.js';
import { addPrompt } from '../../../src/store/prompts.js';
import { createSession, endSession } from '../../../src/store/sessions.js';
import { cliWorld } from './helpers.js';

/** Crea `count` observaciones del proyecto `mi-repo` en la sesión `s1`; devuelve sus ids. */
function seedMany(world, count, { content = (i) => `palabra común número ${i}`, project = 'mi-repo', session = 's1' } = {}) {
  const store = world.store();
  createSession(store, session, project, '/tmp/a');
  const ids = [];
  for (let i = 1; i <= count; i++) {
    ids.push(addObservation(store, { session_id: session, type: 'manual', title: `Nota ${i}`, content: content(i), project, scope: 'project' }).id);
  }
  store.close();
  return ids;
}

const sql = (world, statement, ...args) => {
  const store = world.store();
  try {
    return store.db.run(statement, ...args);
  } finally {
    store.close();
  }
};

test('search limita a 10 resultados por defecto', async (t) => {
  const w = cliWorld(t);
  seedMany(w, 12);
  assert.match((await w.odin(['search', 'palabra'])).out, /^Found 10 memories:/);
  assert.match((await w.odin(['search', 'palabra', '--limit', '12'])).out, /^Found 12 memories:/);
});

test('search recorta el contenido a 300 caracteres', async (t) => {
  const w = cliWorld(t);
  seedMany(w, 1, { content: () => `palabra ${'x'.repeat(400)}` });
  const long = (await w.odin(['search', 'palabra'])).out.split('\n').find((line) => line.includes('xxxx'));
  assert.equal(long, `    palabra ${'x'.repeat(292)}...`);
  seedMany(w, 1, { content: () => `otra ${'y'.repeat(295)}`, session: 's2' });
  const exact = (await w.odin(['search', 'otra'])).out.split('\n').find((line) => line.includes('yyyy'));
  assert.equal(exact, `    otra ${'y'.repeat(295)}`, 'justo 300 caracteres no se recorta');
});

test('search muestra la fecha en la zona de ODIN_TIMEZONE y omite el proyecto nulo', async (t) => {
  const w = cliWorld(t, { env: { ODIN_TIMEZONE: 'Asia/Tokyo' } });
  seedMany(w, 1);
  sql(w, "UPDATE observations SET created_at = '2026-03-01 10:00:00'");
  assert.ok((await w.odin(['search', 'palabra'])).out.includes('\n    2026-03-01 19:00:00 | project: mi-repo | scope: project\n'));
  sql(w, 'UPDATE observations SET project = NULL');
  const all = await w.odin(['search', 'palabra', '--all']);
  assert.ok(all.out.includes('\n    2026-03-01 19:00:00 | scope: project\n'), all.out);
});

test('timeline usa cinco vecinos por lado, recorta y muestra el resumen de la sesión', async (t) => {
  const w = cliWorld(t);
  const ids = seedMany(w, 13, { content: (i) => (i === 3 ? 'c'.repeat(200) : i === 7 ? 'f'.repeat(600) : i === 9 ? 'd'.repeat(200) : `contenido ${i}`) });
  const store = w.store();
  endSession(store, 's1', 's'.repeat(150));
  store.close();
  const r = await w.odin(['timeline', String(ids[6])]);
  assert.equal(r.code, 0);
  const lines = r.out.split('\n');
  assert.equal(lines[0], `Session: mi-repo (${lines[0].slice(lines[0].indexOf('(') + 1, lines[0].indexOf(')'))}) — ${'s'.repeat(100)}...`);
  assert.equal(lines[1], 'Total observations in session: 13');
  const before = lines.slice(lines.indexOf('─── Before ───') + 1, lines.indexOf('>>> #' + ids[6] + ' [manual] Nota 7 <<<') - 1);
  const afterStart = lines.indexOf('─── After ───');
  assert.equal(before.length, 5, 'cinco anteriores por defecto');
  assert.equal(lines.slice(afterStart + 1).filter((line) => line.startsWith('  #')).length, 5, 'cinco posteriores por defecto');
  assert.equal(before[0], `  #${ids[1]} [manual] Nota 2 — contenido 2`);
  const focusContent = lines[lines.indexOf(`>>> #${ids[6]} [manual] Nota 7 <<<`) + 1];
  assert.equal(focusContent, `    ${'f'.repeat(500)}...`);
  assert.ok(lines.includes(`  #${ids[8]} [manual] Nota 9 — ${'d'.repeat(150)}...`), 'los posteriores también se recortan a 150');
  const far = await w.odin(['timeline', String(ids[3]), '--before', '2']);
  assert.ok(far.out.includes(`  #${ids[2]} [manual] Nota 3 — ${'c'.repeat(150)}...\n`), far.out);
});

test('timeline imprime el guion de un resumen vacío y rechaza una observación sin proyecto', async (t) => {
  const w = cliWorld(t);
  const ids = seedMany(w, 1);
  sql(w, "UPDATE sessions SET summary = ''");
  assert.match((await w.odin(['timeline', String(ids[0])])).out, /^Session: mi-repo \(.+\) — \nTotal/);
  sql(w, 'UPDATE sessions SET summary = NULL');
  assert.match((await w.odin(['timeline', String(ids[0])])).out, /^Session: mi-repo \([^)]+\)\nTotal/);
  sql(w, 'UPDATE observations SET project = NULL');
  const r = await w.odin(['timeline', String(ids[0]), '--project', 'mi-repo']);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'odin: observation not found in resolved project\n');
  assert.equal((await w.odin(['timeline', String(ids[0]), '--all'])).code, 0);
});

test('context filtra por ámbito y resume el historial anterior con --older-history', async (t) => {
  const w = cliWorld(t);
  const ids = seedMany(w, 25);
  sql(w, "UPDATE observations SET scope = 'personal' WHERE id = ?", ids[24]);
  const scoped = await w.odin(['context', '--scope', 'personal']);
  assert.ok(scoped.out.includes('**Nota 25**') && !scoped.out.includes('**Nota 24**'), scoped.out);
  const plain = await w.odin(['context']);
  assert.ok(!plain.out.includes('### Older History'));
  sql(w, "UPDATE observations SET created_at = datetime('now', '-400 days') WHERE id <= 3");
  const older = await w.odin(['context', '--older-history']);
  assert.ok(older.out.includes('### Older History\nSamples are titles, not summaries;'), older.out);
});

test('stats, export y consolidate distinguen proyectos', async (t) => {
  const w = cliWorld(t);
  seedMany(w, 2);
  seedMany(w, 3, { project: 'otro', session: 's2' });
  const mine = await w.odin(['stats', '--project', 'otro']);
  assert.match(mine.out, /Sessions:     1\n  Observations: 3\n/);
  assert.match((await w.odin(['stats', '--all'])).out, /Sessions:     2\n  Observations: 5\n/);
  assert.match((await w.odin(['export', 'solo-otro.json', '--project', 'otro'])).out, /Sessions:     1\n  Observations: 3\n/);
  assert.match((await w.odin(['export', 'todo.json', '--all'])).out, /Observations: 5\n/);
  assert.match((await w.odin(['export', 'actual.json'])).out, /Observations: 2\n/, 'sin opciones, el proyecto actual');
  assert.equal(JSON.parse(readFileSync(join(w.repoDir, 'solo-otro.json'), 'utf8')).observations.length, 3);
});

test('export ignora opciones desconocidas y import resuelve rutas relativas', async (t) => {
  const w = cliWorld(t);
  seedMany(w, 1);
  const r = await w.odin(['export', '--bogus', '--all']);
  assert.equal(r.out.split('\n')[0], 'Exported to odin-export.json');
  assert.ok(existsSync(join(w.repoDir, 'odin-export.json')) && !existsSync(join(w.repoDir, '--bogus')));
  const other = cliWorld(t, { repo: 'destino' });
  writeFileSync(join(other.repoDir, 'copia.json'), readFileSync(join(w.repoDir, 'odin-export.json'), 'utf8'));
  const imported = await other.odin(['import', 'copia.json']);
  assert.equal(imported.code, 0);
  assert.match(imported.out, /^Imported from copia\.json\n/);
});

test('delete session rechaza argumentos de más sin borrar', async (t) => {
  const w = cliWorld(t);
  const store = w.store();
  createSession(store, 'vacia', 'mi-repo', '/tmp/a');
  store.close();
  const r = await w.odin(['delete', 'session', 'vacia', 'extra']);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'error: unexpected argument(s): "extra"\nusage: odin delete session <id>\n');
  assert.equal((await w.odin(['delete', 'session', 'vacia'])).code, 0);
});

test('save registra el proyecto literal de --project como evidencia y no abre el almacén si es ambiguo', async (t) => {
  const w = cliWorld(t);
  await w.odin(['save', 'T', 'C', '--project', 'Otro--Proyecto']);
  const store = w.store();
  const evidence = store.db.get("SELECT source, raw_project FROM capture_project_provenance WHERE entity_kind = 'observation'");
  store.close();
  assert.equal(evidence.raw_project, 'Otro--Proyecto');
  assert.equal(evidence.source, 'explicit_override');

  const fresh = cliWorld(t);
  const parent = join(fresh.root, 'monorepo');
  for (const child of ['a', 'b']) {
    mkdirSync(join(parent, child), { recursive: true });
    execFileSync('git', ['init', '-q', join(parent, child)]);
  }
  const ambiguous = await fresh.odin(['save', 't', 'c'], { cwd: parent });
  assert.equal(ambiguous.code, 1);
  assert.equal(existsSync(fresh.dataDir), false, 'la verificación previa falla antes de abrir el almacén');
});

test('projects merge rechaza opciones repetidas y valores que parecen opciones', async (t) => {
  const w = cliWorld(t);
  const usage = (r) => r.err.startsWith('usage: odin projects alias set');
  const repeated = await w.odin(['projects', 'merge', '--from', 'x', '--from', 'y', '--to', 'z', '--dry-run']);
  assert.equal(repeated.code, 1);
  assert.ok(usage(repeated));
  const optionValue = await w.odin(['projects', 'merge', '--from', '--apply', '--to', 'z', '--dry-run']);
  assert.equal(optionValue.code, 1);
  assert.ok(usage(optionValue));
  const twice = await w.odin(['projects', 'merge', '--from', 'x', '--to', 'z', '--dry-run', '--dry-run']);
  assert.equal(twice.code, 1);
  assert.ok(usage(twice));
});

test('projects consolidate --all ordena los grupos por nombre canónico', async (t) => {
  const w = cliWorld(t);
  const store = w.store();
  const project = (session, name, observations) => {
    createSession(store, session, 'tmp', '/tmp/x');
    store.db.run('UPDATE sessions SET project = ? WHERE id = ?', name, session);
    for (let i = 0; i < observations; i++) {
      addObservation(store, { session_id: session, type: 'manual', title: `${session}-${i}`, content: `c ${session} ${i}`, project: 'tmp', scope: 'project' });
    }
    store.db.run('UPDATE observations SET project = ? WHERE session_id = ?', name, session);
  };
  project('z1', 'zeta', 3);
  project('z2', 'Zeta', 3);
  project('a1', 'alfa', 1);
  project('a2', 'Alfa', 1);
  store.close();
  const r = await w.odin(['projects', 'consolidate', '--all', '--dry-run']);
  assert.ok(r.out.indexOf('Suggested canonical: "alfa"') < r.out.indexOf('Suggested canonical: "zeta"'), r.out);
  assert.match(r.out, /^Found 2 group\(s\)/);
});

test('projects prune ordena los candidatos por nombre aunque vengan de prompts', async (t) => {
  const w = cliWorld(t);
  const store = w.store();
  createSession(store, 'v1', 'tmp', '/tmp/x');
  store.db.run("UPDATE sessions SET project = 'zzz' WHERE id = 'v1'");
  addPrompt(store, { session_id: 'v1', content: 'p', project: 'aaa-solo-prompt' });
  store.close();
  const r = await w.odin(['projects', 'prune', '--dry-run']);
  assert.ok(r.out.indexOf('[1] aaa-solo-prompt') > 0 && r.out.indexOf('[2] zzz') > 0, r.out);
});

test('projects alias resolve detecta la raíz de git y los proyectos inscritos', async (t) => {
  const w = cliWorld(t);
  const git = JSON.parse((await w.odin(['projects', 'alias', 'resolve'])).out);
  assert.equal(git.candidate.key, 'mi-repo');
  assert.equal(git.candidate.source, 'git_root');
  assert.equal(git.candidate.directory, w.repoDir);
  assert.equal(git.project, 'mi-repo');
  assert.equal(git.disposition, 'inbox');
  await w.odin(['projects', 'alias', 'set', '--key', 'mi-repo', '--project', 'destino']);
  sql(w, "INSERT INTO sync_enrolled_projects(project) VALUES ('destino')");
  const enrolled = JSON.parse((await w.odin(['projects', 'alias', 'resolve'])).out);
  assert.equal(enrolled.enrolled, true);
  assert.equal(enrolled.disposition, 'enrolled');
  assert.equal(enrolled.project, 'destino');
  // alias de clave y de directorio que apuntan a proyectos distintos: conflicto
  await w.odin(['projects', 'alias', 'set', '--cwd', w.repoDir, '--project', 'otro']);
  const conflict = JSON.parse((await w.odin(['projects', 'alias', 'resolve'])).out);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.enrolled, false);
  assert.equal(conflict.aliases.project, '');
});

test('init --force deja la configuración con permisos 0644', async (t) => {
  const w = cliWorld(t);
  await w.odin(['init', 'uno']);
  await w.odin(['init', 'dos', '--force']);
  const mode = lstatSync(join(w.repoDir, '.odin-memory', 'config.json')).mode & 0o777;
  assert.equal(mode, 0o644);
});
