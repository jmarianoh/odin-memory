import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addObservation } from '../../../src/store/observations.js';
import { addPrompt } from '../../../src/store/prompts.js';
import { createSession } from '../../../src/store/sessions.js';
import { cliWorld } from './helpers.js';

/** Siembra dos sesiones con observaciones y un prompt en el proyecto `mi-repo`. */
function seed(world) {
  const store = world.store();
  createSession(store, 's1', 'mi-repo', '/tmp/a');
  createSession(store, 's2', 'mi-repo', '/tmp/a');
  const save = (session_id, title, content, extra = {}) => addObservation(store, { session_id, type: 'manual', title, content, project: 'mi-repo', scope: 'project', ...extra }).id;
  const ids = [
    save('s1', 'Decisión de caché', 'usamos Redis como caché distribuida', { type: 'decision' }),
    save('s1', 'Bug del login', 'el login falla con tokens expirados', { type: 'bugfix' }),
    save('s1', 'Preferencia', 'tabulaciones de dos espacios', { scope: 'personal' }),
    save('s2', 'Otra nota', 'sobre Redis en la segunda sesión'),
  ];
  addPrompt(store, { session_id: 's1', content: 'primer prompt', project: 'mi-repo' });
  store.close();
  return ids;
}

test('search lista los resultados con tipo, proyecto, ámbito y fecha', async (t) => {
  const w = cliWorld(t);
  seed(w);
  const r = await w.odin(['search', 'Redis']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Found 2 memories:\n\n\[1\] #\d+ \((decision|manual)\) — /);
  assert.match(r.out, /\n {4}\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| project: mi-repo \| scope: project\n\n/);
  assert.equal(r.err, '');
});

test('search filtra por tipo, ámbito y límite, y admite coincidencia parcial', async (t) => {
  const w = cliWorld(t);
  seed(w);
  assert.match((await w.odin(['search', 'Redis', '--type', 'decision'])).out, /^Found 1 memories:/);
  assert.match((await w.odin(['search', 'tabulaciones', '--scope', 'personal'])).out, /^Found 1 memories:/);
  assert.match((await w.odin(['search', 'Redis', '--limit', '1'])).out, /^Found 1 memories:/);
  assert.match((await w.odin(['search', 'login', 'inexistente'])).out, /^No memories found for: "login inexistente"\n$/);
  assert.match((await w.odin(['search', 'login', 'inexistente', '--match', 'any'])).out, /^Found 1 memories:/);
  const bad = await w.odin(['search', 'Redis', '--match', 'raro']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^odin: .*match_mode/);
});

test('search valida argumentos y proyectos', async (t) => {
  const w = cliWorld(t);
  seed(w);
  const none = await w.odin(['search']);
  assert.equal(none.code, 1);
  assert.equal(none.err, 'usage: odin search <query> [--type TYPE] [--project PROJECT|--all] [--scope SCOPE] [--limit N] [--match all|any]\n');
  const empty = await w.odin(['search', '--type', 'decision']);
  assert.equal(empty.code, 1);
  assert.equal(empty.err, 'error: search query is required\n');
  const unknown = await w.odin(['search', 'Redis', '--project', 'no-existe']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /^odin: .*no-existe/);
  const both = await w.odin(['search', 'Redis', '--all', '--project', 'mi-repo']);
  assert.equal(both.code, 1);
  assert.equal(both.err, 'odin: --all and --project cannot be used together\n');
  assert.match((await w.odin(['search', 'Redis', '--all'])).out, /^Found 2 memories:/);
  assert.match((await w.odin(['search', 'Redis', '--project', 'MI-REPO'])).out, /^Found 2 memories:/);
});

test('search resuelve el proyecto desde ODIN_PROJECT', async (t) => {
  const w = cliWorld(t);
  seed(w);
  assert.match((await w.odin(['search', 'Redis'], { env: { ODIN_PROJECT: 'mi-repo' } })).out, /^Found 2 memories:/);
  const unknown = await w.odin(['search', 'Redis'], { env: { ODIN_PROJECT: 'otro' } });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /otro/);
});

test('timeline muestra la sesión, el antes, el foco y el después', async (t) => {
  const w = cliWorld(t);
  const ids = seed(w);
  const r = await w.odin(['timeline', String(ids[1])]);
  assert.equal(r.code, 0);
  const lines = r.out.split('\n');
  assert.match(lines[0], /^Session: mi-repo \(.+\)$/);
  assert.equal(lines[1], 'Total observations in session: 3');
  assert.ok(r.out.includes('─── Before ───\n'));
  assert.ok(r.out.includes(`>>> #${ids[1]} [bugfix] Bug del login <<<\n    el login falla con tokens expirados\n`));
  assert.ok(r.out.includes('─── After ───\n'));
  const narrow = await w.odin(['timeline', String(ids[1]), '--before', '1', '--after', '1']);
  assert.equal(narrow.code, 0);
  assert.ok(narrow.out.includes(`#${ids[0]} [decision]`) && narrow.out.includes(`#${ids[2]} [manual]`));
});

test('timeline valida el identificador, el proyecto y el alcance', async (t) => {
  const w = cliWorld(t);
  const ids = seed(w);
  assert.equal((await w.odin(['timeline'])).err, 'usage: odin timeline <observation_id> [--before N] [--after N] [--project PROJECT|--all]\n');
  const bad = await w.odin(['timeline', 'x']);
  assert.equal(bad.code, 1);
  assert.equal(bad.err, 'error: invalid observation id "x"\n');
  const missing = await w.odin(['timeline', '999', '--all']);
  assert.equal(missing.code, 1);
  assert.equal(missing.err, 'odin: timeline: observation #999 not found: sql: no rows in result set\n');
  const noRows = await w.odin(['timeline', '999']);
  assert.equal(noRows.err, 'odin: sql: no rows in result set\n');
  assert.equal((await w.odin(['timeline', String(ids[0]), '--project'])).err, 'odin: --project requires a non-empty value\n');
  assert.equal((await w.odin(['timeline', String(ids[0]), '--project', '--all'])).err, 'odin: --project requires a non-empty value\n');
  // el proyecto resuelto debe ser el dueño de la observación
  const store = w.store();
  createSession(store, 's3', 'otro', '/tmp/b');
  const foreign = addObservation(store, { session_id: 's3', type: 'manual', title: 'Ajena', content: 'otro proyecto', project: 'otro', scope: 'project' }).id;
  store.close();
  const mismatch = await w.odin(['timeline', String(foreign), '--project', 'mi-repo']);
  assert.equal(mismatch.err, 'odin: observation not found in resolved project\n');
  assert.equal((await w.odin(['timeline', String(foreign), '--all'])).code, 0);
});

test('context muestra sesiones, prompts y observaciones, o avisa de que no hay nada', async (t) => {
  const w = cliWorld(t);
  assert.equal((await w.odin(['context', '--all'])).out, 'No previous session memories found.\n');
  seed(w);
  const r = await w.odin(['context']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^## Memory from Previous Sessions\n/);
  assert.ok(r.out.includes('### Recent Observations'));
  assert.ok(r.out.includes('- [decision] **Decisión de caché**: usamos Redis como caché distribuida'));
  assert.equal((await w.odin(['context', 'mi-repo'])).out, r.out);
  assert.equal((await w.odin(['context', '--project', 'mi-repo'])).out, r.out);
  assert.equal((await w.odin(['context', '--scope', 'personal'])).out.includes('Preferencia'), true);
  assert.equal((await w.odin(['context', '--older-history'])).code, 0);
});

test('context rechaza combinaciones de selectores inválidas', async (t) => {
  const w = cliWorld(t);
  seed(w);
  const cases = [
    [['context', '--bogus'], 'unknown context flag: --bogus'],
    [['context', 'a', 'b'], 'context project selector may only be specified once'],
    [['context', '--project'], 'context project selector requires a value'],
    [['context', '--project', '  '], 'context project selector requires a value'],
    [['context', '--project', 'a', '--project', 'b'], 'context project selector may only be specified once'],
    [['context', '--all', '--all'], 'context all-project selector may only be specified once'],
    [['context', '--all', 'mi-repo'], 'context all-project selector cannot be combined with a project selector'],
    [['context', 'mi-repo', '--project', 'mi-repo'], 'context project selector cannot combine legacy positional project with --project'],
  ];
  for (const [args, message] of cases) {
    const r = await w.odin(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.err, `odin: ${message}\n`, args.join(' '));
  }
  const unknown = await w.odin(['context', '--project', 'no-existe']);
  assert.equal(unknown.code, 1);
});

test('stats resume sesiones, observaciones, prompts y proyectos', async (t) => {
  const w = cliWorld(t);
  const empty = await w.odin(['stats']);
  assert.equal(empty.out, `Odin Memory Stats\n  Sessions:     0\n  Observations: 0\n  Prompts:      0\n  Projects:     none yet\n  Database:     ${w.dataDir}/odin.db\n`);
  seed(w);
  const r = await w.odin(['stats']);
  assert.equal(r.out, `Odin Memory Stats\n  Sessions:     2\n  Observations: 4\n  Prompts:      1\n  Projects:     mi-repo\n  Database:     ${w.dataDir}/odin.db\n`);
  assert.equal((await w.odin(['stats', '--all'])).out, r.out);
  assert.equal((await w.odin(['stats', '--project', 'mi-repo'])).out, r.out);
  assert.equal((await w.odin(['stats', '--project'])).err, 'odin: --project requires a non-empty value\n');
  assert.equal((await w.odin(['stats', '--project', 'no-existe'])).code, 1);
  assert.equal((await w.odin(['stats', '--all', '--project', 'x'])).err, 'odin: --all and --project cannot be used together\n');
});
