import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findNormalizationEquivalentProjects, groupSimilarProjects } from '../../../src/cli/commands/projects.js';
import { addObservation } from '../../../src/store/observations.js';
import { addPrompt } from '../../../src/store/prompts.js';
import { createSession } from '../../../src/store/sessions.js';
import { cliWorld } from './helpers.js';

/**
 * Dos nombres que normalizan igual (`mi-proyecto` y `Mi-Proyecto`), uno con guion bajo
 * (`mi_proyecto`, que no es equivalente), uno distinto y tres proyectos sin observaciones
 * (dos con nombre de ruta).
 */
function seed(world) {
  const store = world.store();
  const save = (session, project, title) => {
    createSession(store, session, 'tmp', '/tmp/x');
    store.db.run('UPDATE sessions SET project = ? WHERE id = ?', project, session);
    addObservation(store, { session_id: session, type: 'manual', title, content: `contenido ${title}`, project: 'tmp', scope: 'project' });
    store.db.run('UPDATE observations SET project = ? WHERE session_id = ?', project, session);
  };
  save('a', 'mi-proyecto', 'A');
  save('b', 'Mi-Proyecto', 'B');
  save('c', 'mi_proyecto', 'C');
  save('d', 'otro', 'D');
  for (const [id, project] of [['v1', 'vacio'], ['v2', 'ruta/vacia'], ['v3', 'otra\\ruta']]) {
    createSession(store, id, 'tmp', '/tmp/y');
    store.db.run('UPDATE sessions SET project = ? WHERE id = ?', project, id);
  }
  addPrompt(store, { session_id: 'v1', content: 'prompt huérfano', project: 'vacio' });
  store.close();
}

test('projects list muestra los recuentos con singular y plural', async (t) => {
  const w = cliWorld(t);
  assert.equal((await w.odin(['projects'])).out, 'No projects found.\n');
  seed(w);
  const r = await w.odin(['projects', 'list']);
  assert.equal(r.code, 0);
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'Projects (7):');
  assert.ok(lines.includes('  otro                              1 obs     1 session      0 prompts'), r.out);
  assert.ok(lines.includes('  vacio                             0 obs     1 session      1 prompt'), r.out);
  assert.equal((await w.odin(['projects'])).out, r.out);
});

test('projects rechaza subcomandos desconocidos mostrando el uso', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['projects', 'bogus']);
  assert.equal(r.code, 1);
  assert.ok(r.err.startsWith('unknown projects subcommand: bogus\nusage: odin projects alias set'));
  assert.ok(r.err.includes('usage: odin projects list\n       odin projects merge --from <source> --to <canonical> (--dry-run|--apply)\n'));
});

test('projects merge previsualiza y aplica una variante legada', async (t) => {
  const w = cliWorld(t);
  seed(w);
  const dry = await w.odin(['projects', 'merge', '--from', 'Mi-Proyecto', '--to', 'mi-proyecto', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.equal(
    dry.out,
    '[dry-run] Source "Mi-Proyecto" -> target "mi-proyecto": observations 1, sessions 1, prompts 0. Sync identity changes: false. No changes made. Point-in-time preview; apply revalidates and counts may differ.\n',
  );
  assert.match((await w.odin(['projects'])).out, /Mi-Proyecto/);
  const applied = await w.odin(['projects', 'merge', '--from', 'Mi-Proyecto', '--to', 'mi-proyecto', '--apply']);
  assert.equal(applied.out, 'Merged source "Mi-Proyecto" into target "mi-proyecto": observations 1, sessions 1, prompts 0. Sync identity may also change.\n');
  assert.doesNotMatch((await w.odin(['projects'])).out, /Mi-Proyecto/);
});

test('projects merge valida las opciones', async (t) => {
  const w = cliWorld(t);
  seed(w);
  for (const args of [
    ['merge'], ['merge', '--from', 'a'], ['merge', '--from', 'a', '--to', 'b'], ['merge', '--from', 'a', '--to', 'b', '--dry-run', '--apply'],
    ['merge', '--from', 'a', '--from', 'b', '--dry-run'], ['merge', '--from', '--to', 'x', '--dry-run'], ['merge', '--bogus'], ['merge', '--from', ' ', '--to', 'x', '--dry-run'],
  ]) {
    const r = await w.odin(['projects', ...args]);
    assert.equal(r.code, 1, args.join(' '));
    assert.ok(r.err.startsWith('usage: odin projects alias set'), args.join(' '));
  }
  const notVariant = await w.odin(['projects', 'merge', '--from', 'otro', '--to', 'mi-proyecto', '--dry-run']);
  assert.equal(notVariant.code, 1);
  assert.match(notVariant.err, /^odin: .*must be a distinct legacy case, separator or Unicode normalization variant/);
});

test('projects prune lista, previsualiza y poda los proyectos sin observaciones', async (t) => {
  const w = cliWorld(t);
  assert.equal((await w.odin(['projects', 'prune'])).out, 'No empty projects to prune.\n');
  assert.equal((await w.odin(['projects', 'prune', '--paths-only'])).out, 'No path-named projects to prune.\n');
  seed(w);
  const dry = await w.odin(['projects', 'prune', '--dry-run']);
  assert.equal(
    dry.out,
    'Found 3 project(s) with 0 observations:\n\n  [1] otra\\ruta                        1 sessions    0 prompts\n  [2] ruta/vacia                       1 sessions    0 prompts\n  [3] vacio                            1 sessions    1 prompts\n\n[dry-run] Would prune 3 project(s)\n',
  );
  const paths = await w.odin(['projects', 'prune', '--dry-run', '--paths-only']);
  assert.match(paths.out, /^Found 2 project\(s\)/);
  const cancelled = await w.odin(['projects', 'prune'], { input: 'none\n' });
  assert.ok(cancelled.out.endsWith("(comma-separated numbers, 'all', or 'none'): Cancelled.\n"));
  assert.ok((await w.odin(['projects', 'prune'], { input: '\n' })).out.endsWith('Cancelled.\n'));
  assert.ok((await w.odin(['projects', 'prune'])).out.endsWith('Cancelled.\n'), 'sin entrada se cancela');
  const invalid = await w.odin(['projects', 'prune'], { input: '9\n' });
  assert.equal(invalid.err, 'Invalid selection: "9" (expected 1-3)\n');
  assert.equal((await w.odin(['projects', 'prune'], { input: '1,x\n' })).err, 'Invalid selection: "x" (expected 1-3)\n');
  const one = await w.odin(['projects', 'prune'], { input: '3\n' });
  assert.ok(one.out.endsWith('\nPruned 1 project(s): 1 sessions, 1 prompts removed.\n'), one.out);
  const all = await w.odin(['projects', 'prune', '--paths-only'], { input: 'all\n' });
  assert.ok(all.out.endsWith('\nPruned 2 project(s): 2 sessions, 0 prompts removed.\n'), all.out);
  assert.equal((await w.odin(['projects', 'prune'])).out, 'No empty projects to prune.\n');
});

test('projects consolidate --all agrupa por normalización y fusiona según la respuesta', async (t) => {
  const w = cliWorld(t);
  assert.equal((await w.odin(['projects', 'consolidate', '--all'])).out, 'No similar project name groups found.\n');
  seed(w);
  const dry = await w.odin(['projects', 'consolidate', '--all', '--dry-run']);
  assert.equal(
    dry.out,
    'Found 1 group(s) of similar project names:\n\nGroup 1:\n    [1] Mi-Proyecto                      1 obs\n  → [2] mi-proyecto                      1 obs\n  Suggested canonical: "mi-proyecto" (→)\n  [dry-run] Would merge into "mi-proyecto"\n\n',
  );
  const skipped = await w.odin(['projects', 'consolidate', '--all'], { input: 'skip\n' });
  assert.ok(skipped.out.endsWith('  Choice:   Skipped.\n\n'), skipped.out);
  const merged = await w.odin(['projects', 'consolidate', '--all'], { input: 'all\n' });
  assert.ok(merged.out.endsWith('  Choice:   Merged: 1 obs, 1 sessions, 0 prompts\n\n'), merged.out);
  assert.doesNotMatch((await w.odin(['projects'])).out, /Mi-Proyecto/);
});

test('projects consolidate --all permite renombrar el canónico', async (t) => {
  const w = cliWorld(t);
  seed(w);
  const r = await w.odin(['projects', 'consolidate', '--all'], { input: 'rename\nNuevo--Nombre\n' });
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('  Enter canonical name:   Merged: 1 obs, 1 sessions, 0 prompts\n'), r.out);
  assert.ok(r.out.includes('  Renamed "mi-proyecto" → "nuevo-nombre": 2 obs, 2 sessions, 0 prompts\n'), r.out);
  const names = (await w.odin(['projects'])).out;
  assert.match(names, /nuevo-nombre/);
});

test('projects consolidate del proyecto actual ofrece las variantes del nombre detectado', async (t) => {
  const w = cliWorld(t, { repo: 'Consol' });
  const store = w.store();
  createSession(store, 'x', 'tmp', '/tmp/x');
  store.db.run("UPDATE sessions SET project = 'Consol' WHERE id = 'x'");
  addObservation(store, { session_id: 'x', type: 'manual', title: 'X', content: 'contenido', project: 'tmp', scope: 'project' });
  store.db.run("UPDATE observations SET project = 'Consol'");
  store.close();
  const dry = await w.odin(['projects', 'consolidate', '--dry-run'], { input: 'all\n' });
  assert.equal(
    dry.out,
    'Note: "consol" has no existing memories. Merging will move memories into this new project name.\nDetected project: "consol"\n\nFound similar project names:\n  [1] Consol                           1 obs  (normalization-equivalent)\n\nSelect which to merge into "consol" (comma-separated numbers, \'all\', or \'none\'): \n[dry-run] Would merge 1 project(s) into "consol"\n',
  );
  const noAnswer = await w.odin(['projects', 'consolidate', '--dry-run']);
  assert.equal(noAnswer.code, 1);
  assert.equal(noAnswer.err, 'odin: dry-run requires a confirmed selection: EOF\n');
  const blank = await w.odin(['projects', 'consolidate', '--dry-run'], { input: '\n' });
  assert.equal(blank.err, 'odin: dry-run requires a confirmed selection: unexpected newline\n');
  const invalid = await w.odin(['projects', 'consolidate', '--dry-run'], { input: '7\n' });
  assert.equal(invalid.code, 1);
  assert.equal(invalid.err, 'Invalid selection: "7" (expected 1-1)\n');
  assert.equal((await w.odin(['projects', 'consolidate'], { input: '7\n' })).code, 0);
  const done = await w.odin(['projects', 'consolidate'], { input: '1\n' });
  assert.ok(done.out.endsWith('\nMerging 1 project(s) into "consol"...\nDone! Merged 1 project(s) into "consol":\n  Observations: 1\n  Sessions:     1\n  Prompts:      0\n'), done.out);
  const none = await w.odin(['projects', 'consolidate'], { input: 'all\n' });
  assert.equal(none.out, 'No similar project names found for "consol". Nothing to consolidate.\n');
  const empty = cliWorld(t, { repo: 'nuevo' });
  const fresh = await empty.odin(['projects', 'consolidate'], { input: 'all\n' });
  assert.equal(fresh.out, 'Note: "nuevo" has no existing memories. Merging will move memories into this new project name.\nNo similar project names found for "nuevo". Nothing to consolidate.\n');
});

test('agrupar y buscar equivalentes por normalización', () => {
  const projects = ['mi-proyecto', 'Mi-Proyecto', 'mi_proyecto', 'otro', 'Único', 'único'].map((name) => ({ name }));
  assert.deepEqual(groupSimilarProjects(projects), [
    { names: ['Mi-Proyecto', 'mi-proyecto'], canonical: 'mi-proyecto' },
    { names: ['Único', 'único'], canonical: 'único' },
  ]);
  assert.deepEqual(findNormalizationEquivalentProjects('mi-proyecto', ['mi-proyecto', 'Mi-Proyecto', 'otro', '  mi-proyecto ']), [
    { name: 'Mi-Proyecto', match_type: 'normalization-equivalent' },
    { name: '  mi-proyecto ', match_type: 'normalization-equivalent' },
  ]);
  assert.deepEqual(findNormalizationEquivalentProjects('', ['a']), []);
});

test('projects alias crea, lista, resuelve y elimina alias', async (t) => {
  const w = cliWorld(t);
  const usage = 'usage: odin projects alias set (--key <key>|--cwd <directory>) --project <project>\n       odin projects alias list\n       odin projects alias remove (--key <key>|--cwd <directory>)\n       odin projects alias resolve [--designation <name>] [--cwd <directory>]\n';
  assert.equal((await w.odin(['projects', 'alias', '--help'])).out, usage);
  assert.equal((await w.odin(['projects', 'alias', 'list'])).out, 'No project aliases.\n');
  assert.equal((await w.odin(['projects', 'alias', 'set', '--key', 'Viejo', '--project', 'nuevo'])).out, 'Alias set: key viejo -> nuevo\n');
  assert.equal((await w.odin(['projects', 'alias', 'set', '--cwd', '/tmp/alias/', '--project', 'nuevo'])).out, 'Alias set: cwd /tmp/alias -> nuevo\n');
  assert.equal((await w.odin(['projects', 'alias', 'list'])).out, 'cwd\t/tmp/alias\tnuevo\nkey\tviejo\tnuevo\n');
  const resolved = await w.odin(['projects', 'alias', 'resolve', '--designation', 'Viejo']);
  assert.deepEqual(JSON.parse(resolved.out), {
    candidate: { key: 'viejo', source: 'explicit_override', directory: w.repoDir, raw_project: 'Viejo' },
    aliases: { project: 'nuevo', key_alias: { kind: 'key', key: 'viejo', project: 'nuevo' }, cwd_alias: null, conflict: false },
    conflict: false,
    enrolled: false,
    disposition: 'inbox',
    project: 'viejo',
  });
  assert.ok(resolved.out.endsWith('}\n') && resolved.out.split('\n').length === 2, 'una sola línea compacta');
  const byGit = JSON.parse((await w.odin(['projects', 'alias', 'resolve', '--cwd', '/tmp/alias'])).out);
  assert.equal(byGit.candidate.source, 'unknown');
  assert.equal(byGit.project, 'unsorted');
  assert.equal(byGit.aliases.project, 'nuevo');
  assert.equal((await w.odin(['projects', 'alias', 'remove', '--key', 'viejo'])).out, 'Alias removed.\n');
  assert.equal((await w.odin(['projects', 'alias', 'remove', '--key', 'viejo'])).out, 'Alias not found.\n');
});

test('projects alias valida los argumentos', async (t) => {
  const w = cliWorld(t);
  for (const [args, message] of [
    [[], 'expected set, list, remove, or resolve'],
    [['bogus'], 'unknown command "bogus"'],
    [['list', 'x'], 'unexpected argument "x"'],
    [['set', '--key', 'a'], '--project is required'],
    [['set', '--project', 'x'], 'exactly one of --key or --cwd is required'],
    [['set', '--key', 'a', '--cwd', '/b', '--project', 'x'], 'exactly one of --key or --cwd is required'],
    [['set', '--key', 'a', '--key', 'b', '--project', 'x'], 'duplicate flag --key'],
    [['set', '--key', '--project', 'x'], '--key requires a value'],
    [['set', '--key'], '--key requires a value'],
    [['set', '--bogus', 'x'], 'unexpected argument "--bogus"'],
    [['remove'], 'exactly one of --key or --cwd is required'],
    [['resolve', '--designation', 'a/b'], null],
  ]) {
    const r = await w.odin(['projects', 'alias', ...args]);
    assert.equal(r.code, 1, args.join(' '));
    if (message !== null) assert.equal(r.err, `project alias: ${message}\n`, args.join(' '));
    else assert.match(r.err, /^project alias: /);
  }
});
