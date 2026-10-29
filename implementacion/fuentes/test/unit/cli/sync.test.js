import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateSyncPromptPrivacy } from '../../../src/cli/commands/sync.js';
import { addObservation, addPrompt, createSession, getObservation, stats } from '../../../src/store/index.js';
import { cliWorld } from './helpers.js';

function seed(world, project = 'mi-repo') {
  const store = world.store();
  createSession(store, 's1', project, '/tmp/x');
  addObservation(store, { session_id: 's1', type: 'decision', title: 'Usar SQLite', content: 'por simplicidad', project });
  addPrompt(store, { session_id: 's1', content: 'prompt privado', project });
  store.close();
}

test('validateSyncPromptPrivacy rechaza combinar --include-prompts con otros modos', () => {
  assert.doesNotThrow(() => validateSyncPromptPrivacy(['--include-prompts'], false));
  assert.doesNotThrow(() => validateSyncPromptPrivacy(['--include-prompts', '--help'], true));
  assert.doesNotThrow(() => validateSyncPromptPrivacy(['--include-prompts', '--project'], true));
  assert.doesNotThrow(() => validateSyncPromptPrivacy(['--project', '--import', '--include-prompts'], false), 'el valor de --project no es un modo');
  for (const args of [['--include-prompts', '--import'], ['--status', '--include-prompts'], ['--include-prompts', '--cloud']]) {
    assert.throws(() => validateSyncPromptPrivacy(args, false), /^Error: --include-prompts is only supported for local Git sync export; cannot combine with --import, --status, or cloud sync$/, args.join(' '));
  }
  assert.throws(() => validateSyncPromptPrivacy(['--include-prompts'], true), /only supported for local Git sync export/);
});

test('sync exporta, informa y no repite', async (t) => {
  const w = cliWorld(t);
  seed(w);
  const r = await w.odin(['sync']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'Exporting memories for project "mi-repo"...');
  assert.equal(lines[1], 'Prompts excluded from Git sync (use --include-prompts to intentionally share them).');
  assert.match(lines[2], /^Created chunk [0-9a-f]{8}$/);
  assert.deepEqual(lines.slice(3, 6), ['  Sessions:     1', '  Observations: 1', '  Prompts:      0']);
  assert.ok(r.out.includes('Warning: sessions, observations, and any included prompts may contain sensitive content.\n'));
  assert.ok(r.out.includes('  git add .odin-memory/ && git commit -m "sync odin memories"\n'));
  assert.ok(existsSync(join(w.repoDir, '.odin-memory', 'manifest.json')));
  assert.equal(readdirSync(join(w.repoDir, '.odin-memory', 'chunks')).length, 1);

  const again = await w.odin(['sync']);
  assert.match(again.out, /Nothing new to sync for project "mi-repo" — all memories already exported\.\n$/);
});

test('sync --include-prompts comparte prompts y omite el aviso de exclusión', async (t) => {
  const w = cliWorld(t);
  seed(w);
  const r = await w.odin(['sync', '--include-prompts']);
  assert.ok(!r.out.includes('Prompts excluded'));
  assert.ok(r.out.includes('  Prompts:      1\n'));
  const bad = await w.odin(['sync', '--include-prompts', '--status']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--include-prompts is only supported for local Git sync export/);
});

test('sync --all exporta todos los proyectos', async (t) => {
  const w = cliWorld(t);
  seed(w, 'mi-repo');
  const store = w.store();
  createSession(store, 's2', 'otro', '/tmp/y');
  addObservation(store, { session_id: 's2', type: 'manual', title: 'Ajena', content: 'otro proyecto', project: 'otro' });
  store.close();
  const r = await w.odin(['sync', '--all']);
  assert.ok(r.out.startsWith('Exporting ALL memories (all projects)...\n'));
  assert.ok(r.out.includes('  Observations: 2\n'));
  assert.match((await w.odin(['sync', '--all'])).out, /^Exporting ALL memories \(all projects\)\.\.\.\nPrompts excluded.*\nNothing new to sync — all memories already exported\.\n$/);
});

test('sync --status e --import entre dos almacenes', async (t) => {
  const a = cliWorld(t);
  seed(a);
  await a.odin(['sync', '--include-prompts']);
  const b = cliWorld(t);
  // El segundo repositorio recibe la carpeta compartida tal cual.
  const { cpSync } = await import('node:fs');
  cpSync(join(a.repoDir, '.odin-memory'), join(b.repoDir, '.odin-memory'), { recursive: true });
  assert.equal((await b.odin(['sync', '--status'])).out, 'Sync status:\n  Local chunks:    0\n  Remote chunks:   1\n  Pending import:  1\n');
  const r = await b.odin(['sync', '--import']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    'Imported 1 new chunk(s) from .odin-memory/', '  Sessions:     1', '  Observations: 1', '  Prompts:      1',
    '  Relations replayed: 0', '  Relations deferred: 0', '  Relations dead:     0', '',
  ].join('\n'));
  const store = b.store();
  assert.deepEqual(stats(store), { total_sessions: 1, total_observations: 1, total_prompts: 1, projects: ['mi-repo'] });
  assert.equal(getObservation(store, 1).title, 'Usar SQLite');
  store.close();

  // Un segundo chunk ajeno se importa y el primero se cuenta como omitido.
  const { FileTransport } = await import('../../../src/sync/index.js');
  const transport = new FileTransport(join(b.repoDir, '.odin-memory'));
  transport.writeChunk('abcd1234', JSON.stringify({ sessions: [{ id: 's9', project: 'mi-repo', directory: '/d', started_at: '2026-01-01 00:00:00' }], observations: null, prompts: null }));
  const manifest = transport.readManifest();
  manifest.chunks.push({ id: 'abcd1234', created_by: 'x', created_at: '2999-01-01T00:00:00Z', sessions: 1, memories: 0, prompts: 0 });
  transport.writeManifest(manifest);
  const mixed = await b.odin(['sync', '--import']);
  assert.ok(mixed.out.startsWith('Imported 1 new chunk(s) from .odin-memory/\n  Sessions:     1\n  Observations: 0\n  Prompts:      0\n  Skipped:      1 (already imported)\n'), mixed.out);

  const again = await b.odin(['sync', '--import']);
  assert.equal(again.out, 'No new chunks to import.\n  (2 chunks already imported)\n  Relations replayed: 0\n  Relations deferred: 0\n  Relations dead:     0\n');
  assert.equal((await b.odin(['sync', '--status'])).out, 'Sync status:\n  Local chunks:    2\n  Remote chunks:   2\n  Pending import:  0\n');
});

test('sync valida sus banderas', async (t) => {
  const w = cliWorld(t);
  const fail = async (args, pattern) => {
    const r = await w.odin(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, pattern, args.join(' '));
  };
  await fail(['sync', '--all', '--project', 'x'], /--all and --project cannot be used together/);
  await fail(['sync', '--literal-project'], /--literal-project requires cloud sync with an explicit non-empty --project/);
  await fail(['sync', '--project'], /--project requires a value|requires/);
  await fail(['sync', '--project='], /--project requires a non-empty value/);
  await fail(['sync', '--cloud', '--project', 'x'], /cloud sync cloud_config_error: cloud server is missing: configure server URL with `odin cloud config --server <url>`/);
  await fail(['sync', '--cloud'], /cloud sync requires an explicit non-empty --project value/);
  await fail(['sync', '--cloud', '--all'], /cloud sync requires a single explicit --project scope; --all is not supported/);
  await fail(['sync', '--cloud', '--project', 'a%zz'], /cloud sync project: invalid cloud project URL encoding "a%zz": invalid URL escape "%zz"/);
  await fail(['sync', '--project', 'x', '--cloud', '--all'], /--all and --project cannot be used together/);
  const env = await w.odin(['sync', '--project', 'x'], { env: { ODIN_CLOUD_SYNC: 'true' } });
  assert.match(env.err, /cloud sync cloud_config_error: cloud server is missing/);
  const help = await w.odin(['sync', '--help']);
  assert.equal(help.code, 0);
  assert.ok(help.out.startsWith('usage: odin sync [--import | --status] [--all] [--include-prompts] [--cloud --project PROJECT [--literal-project]]\n'));
  assert.ok(!existsSync(join(w.repoDir, '.odin-memory')), 'ni la ayuda ni los errores crean la carpeta');
});

test('projects rescue-ownership asigna registros sin dueño', async (t) => {
  const w = cliWorld(t);
  const store = w.store();
  createSession(store, 's1', 'tmp', '/tmp/x');
  const { id } = addObservation(store, { session_id: 's1', type: 'manual', title: 'Huérfana', content: 'sin proyecto', project: 'tmp' });
  store.db.run("UPDATE sessions SET project = '', ownership_mode = NULL WHERE id = ?", 's1');
  store.db.run('UPDATE observations SET project = NULL WHERE id = ?', id);
  store.close();

  const r = await w.odin(['projects', 'rescue-ownership', '--project', 'mi-repo', '--session', 's1', '--observation', String(id)]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'Rescued ownership into "mi-repo": 1 sessions, 1 observations, 0 prompts\nEverything selected now belongs to the target project.\n');
  const check = w.store();
  assert.equal(getObservation(check, id).project, 'mi-repo');
  check.close();

  const blocked = await w.odin(['projects', 'rescue-ownership', '--project', 'mi-repo', '--observation', '999']);
  assert.equal(blocked.code, 0, blocked.err);
  assert.match(blocked.out, /^Rescued ownership into "mi-repo": 0 sessions, 0 observations, 0 prompts\n1 selected item\(s\) were left behind:\n/);
});

test('projects rescue-ownership valida sus argumentos', async (t) => {
  const w = cliWorld(t);
  const noProject = await w.odin(['projects', 'rescue-ownership', '--session', 's']);
  assert.equal(noProject.code, 1);
  assert.match(noProject.err, /^--project <name> is required\n/);
  assert.match(noProject.err, /odin projects rescue-ownership --project <name>/);
  const noSelection = await w.odin(['projects', 'rescue-ownership', '--project', 'x']);
  assert.equal(noSelection.code, 1);
  assert.match(noSelection.err, /^select at least one --session, --observation, or --prompt to rescue\n/);
  const badId = await w.odin(['projects', 'rescue-ownership', '--project', 'x', '--observation', 'abc']);
  assert.equal(badId.code, 1);
  assert.match(badId.err, /invalid --observation id "abc": strconv.ParseInt: parsing "abc": invalid syntax/);
  const big = await w.odin(['projects', 'rescue-ownership', '--project', 'x', '--prompt', '99999999999999999999']);
  assert.match(big.err, /value out of range/);
});

test('readFileSync del manifiesto refleja el formato con sangría de dos espacios', async (t) => {
  const w = cliWorld(t);
  seed(w);
  await w.odin(['sync']);
  const text = readFileSync(join(w.repoDir, '.odin-memory', 'manifest.json'), 'utf8');
  assert.ok(text.startsWith('{\n  "version": 1,\n  "chunks": [\n    {\n      "id": "'));
});
