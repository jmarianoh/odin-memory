import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSaveArgs } from '../../../src/cli/commands/save.js';
import { addObservation, getObservation } from '../../../src/store/observations.js';
import { addPrompt } from '../../../src/store/prompts.js';
import { createSession } from '../../../src/store/sessions.js';
import { cliWorld } from './helpers.js';

const SAVE_USAGE =
  'usage: odin save <title> <content> [--type TYPE] [--project PROJECT] [--scope SCOPE] [--topic TOPIC_KEY]\nUntracked folders inside a HOME Git repository require --project, ODIN_PROJECT, or .odin-memory/config.json project_name.\n';

const rows = (world, sql = 'SELECT id, type, title, content, project, scope, topic_key FROM observations ORDER BY id') => {
  const store = world.store();
  try {
    return store.db.all(sql).map((row) => ({ ...row }));
  } finally {
    store.close();
  }
};

test('parseSaveArgs admite opciones antes y después de los posicionales y `--`', () => {
  assert.deepEqual(parseSaveArgs(['t', 'c']), { type: 'manual', scope: 'project', projectName: '', topicKey: '', title: 't', content: 'c' });
  assert.deepEqual(parseSaveArgs(['--type', 'decision', 't', 'c', '--topic', 'a/b', '--project', 'p', '--scope', 'personal']), {
    type: 'decision', scope: 'personal', projectName: 'p', topicKey: 'a/b', title: 't', content: 'c',
  });
  assert.equal(parseSaveArgs(['t', '--', '--c']).content, '--c');
  assert.throws(() => parseSaveArgs(['t']), /exactly two positional/);
  assert.throws(() => parseSaveArgs(['t', 'c', 'd']), /exactly two positional/);
  assert.throws(() => parseSaveArgs(['t', 'c', '--bogus', 'x']), /unknown save flag: --bogus/);
  assert.throws(() => parseSaveArgs(['t', 'c', '--type']), /--type requires a value/);
  assert.throws(() => parseSaveArgs(['t', 'c', '--type', '  ']), /--type requires a value/);
  assert.throws(() => parseSaveArgs(['t', 'c', '--type', '--project']), /--type requires a value/);
});

test('save guarda una memoria manual en el proyecto del repositorio', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['save', 'Primer título', 'Primer contenido']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Memory saved: #1 "Primer título" (manual)\n');
  assert.equal(r.err, '');
  assert.deepEqual(rows(w), [{ id: 1, type: 'manual', title: 'Primer título', content: 'Primer contenido', project: 'mi-repo', scope: 'project', topic_key: null }]);
  // la sesión de reserva queda registrada con su procedencia
  const store = w.store();
  assert.equal(store.db.get("SELECT project FROM sessions WHERE id = 'manual-save-mi-repo'").project, 'mi-repo');
  assert.ok(store.db.get('SELECT 1 AS found FROM capture_project_provenance LIMIT 1'));
  store.close();
});

test('save aplica tipo, ámbito, tema y proyecto, y avisa de la normalización', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['save', 'Decisión', 'usar Postgres', '--type', 'decision', '--topic', 'arq/db', '--scope', 'personal', '--project', 'Otro--Proyecto']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Memory saved: #1 "Decisión" (decision)\n');
  assert.equal(r.err, '⚠️ Project name normalized: "Otro--Proyecto" → "otro-proyecto"\n');
  assert.deepEqual(rows(w), [{ id: 1, type: 'decision', title: 'Decisión', content: 'usar Postgres', project: 'otro-proyecto', scope: 'personal', topic_key: 'arq/db' }]);
});

test('save usa ODIN_PROJECT cuando no hay --project', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['save', 'Env', 'por variable'], { env: { ODIN_PROJECT: 'desde-env' } });
  assert.equal(r.code, 0);
  assert.equal(rows(w)[0].project, 'desde-env');
  const store = w.store();
  const evidence = store.db.get("SELECT * FROM capture_project_provenance WHERE entity_kind = 'observation'");
  store.close();
  assert.equal(evidence.raw_project, 'desde-env');
  assert.equal(evidence.source, 'process_override');
});

test('save rechaza argumentos inválidos mostrando el uso', async (t) => {
  const w = cliWorld(t);
  for (const [args, message] of [
    [['save'], 'save requires exactly two positional arguments'],
    [['save', 'solo'], 'save requires exactly two positional arguments'],
    [['save', 'a', 'b', 'c'], 'save requires exactly two positional arguments'],
    [['save', 'a', 'b', '--bogus', 'x'], 'unknown save flag: --bogus'],
    [['save', 'a', 'b', '--type'], '--type requires a value'],
  ]) {
    const r = await w.odin(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.err, `${SAVE_USAGE}odin: ${message}\n`, args.join(' '));
    assert.equal(r.out, '');
  }
  const noTitle = await w.odin(['save', '   ', 'contenido']);
  assert.equal(noTitle.code, 1);
  assert.equal(noTitle.err, 'odin: observation title is required\n');
  const noContent = await w.odin(['save', 'Título', '   ']);
  assert.equal(noContent.code, 1);
  assert.equal(noContent.err, 'odin: observation content is required\n');
  const path = await w.odin(['save', 'Ruta', 'x', '--project', 'a/b']);
  assert.equal(path.code, 1);
  assert.match(path.err, /^odin: cannot save without an unambiguous project identity: .*a\/b.*; use --project <name>\n$/);
  assert.deepEqual(rows(w), []);
});

test('save avisa cuando el contenido se trunca y elimina las etiquetas privadas', async (t) => {
  const w = cliWorld(t);
  const big = await w.odin(['save', 'Enorme', 'x'.repeat(50_010)]);
  assert.equal(big.code, 0);
  assert.equal(big.err, '⚠ WARNING: Content was truncated from 50010 to 50000 bytes. Consider splitting into smaller observations.\n');
  const priv = await w.odin(['save', 'Privado', 'abre <private>secreto</private> cierra']);
  assert.equal(priv.code, 0);
  assert.equal(rows(w).at(-1).content, 'abre [REDACTED] cierra');
});

test('save en un directorio ambiguo exige un proyecto explícito', async (t) => {
  const w = cliWorld(t);
  const { mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const parent = join(w.root, 'monorepo');
  for (const child of ['a', 'b']) {
    mkdirSync(join(parent, child), { recursive: true });
    execFileSync('git', ['init', '-q', join(parent, child)]);
  }
  const r = await w.odin(['save', 't', 'c'], { cwd: parent });
  assert.equal(r.code, 1);
  assert.match(r.err, /^odin: cannot save without an unambiguous project identity: ambiguous project: multiple git repos found in cwd; use --project <name>\n$/);
  assert.equal((await w.odin(['save', 't', 'c', '--project', 'a'], { cwd: parent })).code, 0);
});

function seedDelete(world) {
  const store = world.store();
  createSession(store, 's1', 'mi-repo', '/tmp/a');
  createSession(store, 's2', 'mi-repo', '/tmp/a');
  createSession(store, 'vacia', 'mi-repo', '/tmp/a');
  for (const title of ['uno', 'dos', 'tres']) addObservation(store, { session_id: 's1', type: 'manual', title, content: `contenido ${title}`, project: 'mi-repo', scope: 'project' });
  addPrompt(store, { session_id: 's2', content: 'un prompt', project: 'mi-repo' });
  store.close();
}

test('delete borra una observación de forma suave o permanente', async (t) => {
  const w = cliWorld(t);
  seedDelete(w);
  assert.equal((await w.odin(['delete', '1'])).out, 'Observation #1 soft-deleted\n');
  assert.equal((await w.odin(['delete', '2', '--hard'])).out, 'Observation #2 hard-deleted\n');
  const store = w.store();
  assert.equal(getObservation(store, 1), null);
  assert.equal(store.db.get('SELECT deleted_at IS NOT NULL AS gone FROM observations WHERE id = 1').gone, 1);
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM observations WHERE id = 2').n, 0);
  store.close();
  const again = await w.odin(['delete', '1']);
  assert.equal(again.code, 1);
  assert.equal(again.err, 'odin: observation not found\n');
});

test('delete rechaza identificadores y argumentos inesperados antes de abrir el almacén', async (t) => {
  const w = cliWorld(t);
  seedDelete(w);
  const usage = 'usage: odin delete <observation_id> [--hard]\n       odin delete session  <id>\n       odin delete prompt   <id>\n       odin delete project  <name> [--hard]\n';
  assert.equal((await w.odin(['delete'])).err, usage);
  assert.equal((await w.odin(['delete', 'x'])).err, 'error: invalid observation id "x"\n');
  const dry = await w.odin(['delete', '3', '--dry-run']);
  assert.equal(dry.code, 1);
  assert.equal(dry.err, 'error: unexpected argument(s): "--dry-run"\nusage: odin delete <observation_id> [--hard]\n');
  assert.equal((await w.odin(['delete', '3', '--hard', 'x', 'y'])).err, 'error: unexpected argument(s): "x" "y"\nusage: odin delete <observation_id> [--hard]\n');
  assert.equal((await w.odin(['delete', 'prompt', 'x'])).err, 'error: invalid prompt id "x"\n');
  assert.equal((await w.odin(['delete', 'session'])).err, 'usage: odin delete session <id>\n');
  assert.equal((await w.odin(['delete', 'session', '--help'])).err, 'usage: odin delete session <id>\n');
  assert.equal((await w.odin(['delete', 'session', '-h'])).code, 1);
  assert.equal((await w.odin(['delete', 'prompt'])).err, 'usage: odin delete prompt <id>\n');
  assert.equal((await w.odin(['delete', 'project'])).err, 'usage: odin delete project <name> [--hard]\n');
  assert.equal((await w.odin(['delete', 'project', '-h'])).err, 'usage: odin delete project <name> [--hard]\n');
  assert.equal((await w.odin(['delete', 'project', 'mi-repo', '--dry-run'])).code, 1);
  assert.equal(rows(w).length, 3, 'nada se borró');
});

test('delete session solo borra sesiones sin observaciones', async (t) => {
  const w = cliWorld(t);
  seedDelete(w);
  assert.equal((await w.odin(['delete', 'session', 'vacia'])).out, 'Session "vacia" deleted\n');
  const blocked = await w.odin(['delete', 'session', 's1']);
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /^odin: session still has observations/);
  const missing = await w.odin(['delete', 'session', 'nada']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^odin: session not found/);
});

test('delete prompt borra un prompt de forma permanente', async (t) => {
  const w = cliWorld(t);
  seedDelete(w);
  assert.equal((await w.odin(['delete', 'prompt', '1'])).out, 'Prompt #1 deleted\n');
  const again = await w.odin(['delete', 'prompt', '1']);
  assert.equal(again.code, 1);
  assert.match(again.err, /^odin: prompt not found/);
  assert.equal((await w.odin(['delete', 'prompt', '1', 'extra'])).code, 1);
});

test('delete project borra en cascada de forma suave o permanente', async (t) => {
  const w = cliWorld(t);
  seedDelete(w);
  assert.equal((await w.odin(['delete', 'project', 'mi-repo'])).out, 'Project "mi-repo" soft-deleted: 3 observation(s), 1 prompt(s), 0 session(s)\n');
  assert.equal((await w.odin(['delete', 'project', 'mi-repo', '--hard'])).out, 'Project "mi-repo" hard-deleted: 3 observation(s), 0 prompt(s), 3 session(s)\n');
  const missing = await w.odin(['delete', 'project', 'nada']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^odin: project not found/);
});
