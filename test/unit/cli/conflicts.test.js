import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRfc3339 } from '../../../src/cli/commands/conflicts.js';
import { addObservation, createSession, judgeRelation, scanProject } from '../../../src/store/index.js';
import { cliWorld } from './helpers.js';

async function seeded(t, { apply = true } = {}) {
  const w = cliWorld(t, { repo: 'conflictos' });
  const store = w.store();
  createSession(store, 's1', 'conflictos', w.repoDir);
  for (const [title, content] of [
    ['Usar Redis para la caché', 'a'], ['Redis como caché distribuida', 'b'], ['Caché local en memoria', 'c'], ['Tokens de acceso', 'd'], ['Acceso con tokens', 'e'],
  ]) addObservation(store, { session_id: 's1', type: 'decision', title, content, project: 'conflictos' });
  if (apply) await scanProject(store, { project: 'conflictos', apply: true });
  store.db.run("UPDATE memory_relations SET created_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes')");
  return { w, store };
}

test('parseRfc3339 reproduce los errores del analizador de fechas', () => {
  assert.deepEqual(parseRfc3339('2026-03-01T10:00:00Z'), { date: new Date('2026-03-01T10:00:00Z') });
  assert.deepEqual(parseRfc3339('2026-03-01T10:00:00.123+02:00'), { date: new Date('2026-03-01T08:00:00.123Z'.replace('.123', '')) });
  assert.deepEqual(parseRfc3339('2026-03-01T10:00:00-05:30').date, new Date('2026-03-01T15:30:00Z'));
  const layout = '"2006-01-02T15:04:05Z07:00"';
  const error = (text) => parseRfc3339(text).error;
  assert.equal(error('ayer'), `parsing time "ayer" as ${layout}: cannot parse "ayer" as "2006"`);
  assert.equal(error(''), `parsing time "" as ${layout}: cannot parse "" as "2006"`);
  assert.equal(error('2026'), `parsing time "2026" as ${layout}: cannot parse "" as "-"`);
  assert.equal(error('2026-03-01'), `parsing time "2026-03-01" as ${layout}: cannot parse "" as "T"`);
  assert.equal(error('2026-3-01T00:00:00Z'), `parsing time "2026-3-01T00:00:00Z" as ${layout}: cannot parse "3-01T00:00:00Z" as "01"`);
  assert.equal(error('2026-03-01T10:00:00'), `parsing time "2026-03-01T10:00:00" as ${layout}: cannot parse "" as "Z07:00"`);
  assert.equal(error('2026-03-01T10:00:00+2'), `parsing time "2026-03-01T10:00:00+2" as ${layout}: cannot parse "+2" as "Z07:00"`);
  assert.equal(error('2026-03-01T10:00:00Zx'), 'parsing time "2026-03-01T10:00:00Zx": extra text: "x"');
  assert.equal(error('2026-13-01T00:00:00Z'), 'parsing time "2026-13-01T00:00:00Z": month out of range');
  assert.equal(error('2026-02-30T00:00:00Z'), 'parsing time "2026-02-30T00:00:00Z": day out of range');
  assert.equal(error('2026-03-01T24:00:00Z'), 'parsing time "2026-03-01T24:00:00Z": hour out of range');
  assert.equal(error('2026-03-01T10:60:00Z'), 'parsing time "2026-03-01T10:60:00Z": minute out of range');
  assert.equal(error('2026-03-01T10:00:60Z'), 'parsing time "2026-03-01T10:00:60Z": second out of range');
  assert.equal(error('2026-03-01T10:00:00+25:00'), 'parsing time "2026-03-01T10:00:00+25:00": time zone offset hour out of range');
  assert.equal(error('2026-03-01T10:00:00+01:61'), 'parsing time "2026-03-01T10:00:00+01:61": time zone offset minute out of range');
  assert.equal(parseRfc3339('2024-02-29T00:00:00Z').date.toISOString(), '2024-02-29T00:00:00.000Z');
  assert.equal(error('2025-02-29T00:00:00Z'), 'parsing time "2025-02-29T00:00:00Z": day out of range');
});

test('conflicts sin subcomando o con uno desconocido muestra el uso y sale con 1', async (t) => {
  const w = cliWorld(t);
  const none = await w.odin(['conflicts']);
  assert.equal(none.code, 1);
  assert.match(none.err, /^usage: odin conflicts <subcommand> \[options\]\nsubcommands: list, show, stats, scan, deferred, prune\n/);
  const unknown = await w.odin(['conflicts', 'nada']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /^unknown conflicts subcommand: nada\nusage: odin conflicts/);
  const proto = await w.odin(['conflicts', 'constructor']);
  assert.match(proto.err, /^unknown conflicts subcommand: constructor/);
});

test('conflicts list muestra las relaciones y valida sus opciones', async (t) => {
  const { w } = await seeded(t);
  const all = await w.odin(['conflicts', 'list', '--all']);
  assert.equal(all.code, 0, all.err);
  assert.match(all.out, /^Conflicts List \(project: \)\n  Total:  \d+\n  Showing: \d+\n\n  id:  /);
  const scoped = await w.odin(['conflicts', 'list', '--project', 'conflictos', '--limit', '2']);
  assert.match(scoped.out, /^Conflicts List \(project: conflictos\)\n  Total:  \d+\n  Showing: 2\n/);
  assert.match(scoped.out, /  judgment_status: pending\n  source:         obs-[0-9a-f]{16} — /);
  assert.match(scoped.out, /  created_at:     2026-03-01 10:0\d:00\n\n$/);
  assert.match((await w.odin(['conflicts', 'list', '--status', 'judged', '--project', 'conflictos'])).out, /  Showing: 0\n  No relations found\.\n$/);
  // La fecha se compara como texto con `created_at` (`YYYY-MM-DD HH:MM:SS`): solo el día distingue.
  assert.equal((await w.odin(['conflicts', 'list', '--project', 'conflictos', '--since', '2026-02-28T00:00:00Z'])).out.includes('id:'), true);
  assert.equal((await w.odin(['conflicts', 'list', '--project', 'conflictos', '--since', '2026-03-02T00:00:00Z'])).out.includes('No relations found.'), true);
  const badSince = await w.odin(['conflicts', 'list', '--since', 'ayer']);
  assert.equal(badSince.code, 1);
  assert.equal(badSince.err, 'error: --since must be RFC3339 format: parsing time "ayer" as "2006-01-02T15:04:05Z07:00": cannot parse "ayer" as "2006"\n');
  const tooMany = await w.odin(['conflicts', 'list', '--limit', '501']);
  assert.deepEqual([tooMany.code, tooMany.err], [1, 'error: --limit cannot exceed 500\n']);
  assert.match((await w.odin(['conflicts', 'list', '--limit', 'x', '--project', 'conflictos'])).out, /Showing: \d+/, 'un límite inválido conserva el de por defecto');
  assert.equal((await w.odin(['conflicts', 'list', '--project', 'nada'])).code, 1);
});

test('conflicts list limita a 50 por defecto', async (t) => {
  const w = cliWorld(t, { repo: 'muchos' });
  const store = w.store();
  createSession(store, 's1', 'muchos', w.repoDir);
  for (let i = 0; i < 12; i++) addObservation(store, { session_id: 's1', type: 'decision', title: `alpha beta caché ${i}`, content: `c${i}`, project: 'muchos' });
  await scanProject(store, { project: 'muchos', apply: true, max_insert: 500 });
  const listed = await w.odin(['conflicts', 'list', '--project', 'muchos']);
  assert.match(listed.out, /  Total:  65\n  Showing: 50\n/);
});

test('conflicts show detalla una relación y rechaza ids inválidos', async (t) => {
  const { w, store } = await seeded(t);
  const first = store.db.get('SELECT id, sync_id FROM memory_relations ORDER BY id LIMIT 1');
  const shown = await w.odin(['conflicts', 'show', ` ${first.id} `]);
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, new RegExp(`^Conflict Detail\\n  relation_id:     ${first.id}\\n  sync_id:         ${first.sync_id}\\n  relation:        pending\\n  judgment_status: pending\\n`));
  assert.match(shown.out, /\n  source_title:    .+\n\n  target_id:       obs-[0-9a-f]{16}\n  target_title:    .+\n$/);
  assert.deepEqual([(await w.odin(['conflicts', 'show', '99999'])).code, (await w.odin(['conflicts', 'show', '99999'])).err], [1, 'error: relation 99999 not found\n']);
  const bad = await w.odin(['conflicts', 'show', 'abc']);
  assert.equal(bad.err, 'error: relation_id must be an integer: strconv.ParseInt: parsing "abc": invalid syntax\n');
  const none = await w.odin(['conflicts', 'show']);
  assert.deepEqual([none.code, none.err], [1, 'usage: odin conflicts show <relation_id>\n']);
});

test('conflicts stats resume por estado y por relación, y cuenta las colas', async (t) => {
  const { w, store } = await seeded(t);
  const pending = store.db.get('SELECT sync_id FROM memory_relations ORDER BY id LIMIT 1');
  judgeRelation(store, { judgment_id: pending.sync_id, relation: 'conflicts_with', marked_by_actor: 'agent', marked_by_kind: 'agent' });
  store.db.run("UPDATE memory_relations SET judgment_status = 'orphaned' WHERE id = (SELECT id FROM memory_relations WHERE judgment_status = 'pending' ORDER BY id DESC LIMIT 1)");
  store.db.run("INSERT INTO sync_apply_deferred (sync_id, entity, payload, project, scope_class, apply_status) VALUES ('d1', 'relation', '{}', 'conflictos', 'scoped', 'deferred')");
  const stats = await w.odin(['conflicts', 'stats', '--project', 'conflictos']);
  assert.equal(stats.code, 0, stats.err);
  assert.match(stats.out, /^Conflicts Stats \(project: conflictos\)\n\n  By judgment_status:\n    pending:     \d+\n    orphaned:    1\n    judged:      1\n\n  By relation type:\n    conflicts_with:      1\n    pending:             \d+\n\n  Deferred:    1\n  Dead:        0\n$/);
  const empty = cliWorld(t);
  assert.equal((await empty.odin(['conflicts', 'stats', '--all'])).out, 'Conflicts Stats (project: )\n\n  No relations found.\n\n  Deferred:    0\n  Dead:        0\n');
});

test('conflicts scan: informe, continuación, topes y validaciones', async (t) => {
  const { w } = await seeded(t, { apply: false });
  const dry = await w.odin(['conflicts', 'scan']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /^Conflicts Scan \(project: conflictos\)\n  inspected:        5\n  ranked_queries:   5\n  candidates_found: \d+\n  already_related:  0\n  inserted:         0\n  dry_run:          true\n$/);
  assert.match((await w.odin(['conflicts', 'scan', '--limit', '2'])).out, /  dry_run:          true\n  next_cursor:      \d+\n$/);
  const capped = await w.odin(['conflicts', 'scan', '--apply', '--max-insert', '1', '--cursor', '0']);
  assert.match(capped.out, /\n  dry_run:          false\nWARNING: max-insert cap of 1 reached — this page has no continuation; re-run with --cursor 0 and a higher cap\.\n$/);
  const errors = [
    [['--dry-run', '--apply'], 'error: --dry-run and --apply are mutually exclusive\n'],
    [['--concurrency', '0'], 'error: --concurrency must be between 1 and 20; got 0\n'],
    [['--concurrency', '21'], 'error: --concurrency must be between 1 and 20; got 21\n'],
    [['--limit', '0'], 'error: --limit must be between 1 and 100\n'],
    [['--limit', '101'], 'error: --limit must be between 1 and 100\n'],
    [['--limit'], 'error: --limit requires a value\n'],
    [['--cursor', '-1'], 'error: --cursor must be a non-negative observation ID\n'],
    [['--cursor'], 'error: --cursor requires a value\n'],
  ];
  for (const [flags, message] of errors) {
    const r = await w.odin(['conflicts', 'scan', ...flags]);
    assert.deepEqual([r.code, r.err], [1, message], flags.join(' '));
  }
  assert.match((await w.odin(['conflicts', 'scan', '--since', 'ayer'])).err, /^error: --since must be RFC3339 format: parsing time "ayer"/);
  assert.match((await w.odin(['conflicts', 'scan', '--all'])).out, /^Conflicts Scan \(project: \)/);
});

test('conflicts scan --semantic pide confirmación, usa el ejecutor y resume los veredictos', async (t) => {
  const { w } = await seeded(t, { apply: false });
  const prompts = [];
  const llm = {
    resolveRunner: () => ({ compare: async (prompt) => { prompts.push(prompt); return { relation: 'conflicts_with', confidence: 0.9, reasoning: 'x', model: 'm' }; } }),
    buildPrompt: (a, b) => `${a.sync_id} vs ${b.sync_id}`,
  };
  const declined = await w.odin(['conflicts', 'scan', '--semantic', '--max-semantic', '7'], { input: 'n\n', overrides: { llm } });
  assert.equal(declined.code, 0);
  assert.equal(declined.out, 'Semantic scan will make up to 7 LLM calls (~2100 input tokens, ~350 output tokens).\nSubscription users: counts against your quota.\nContinue? [y/N] Aborted.\n');
  assert.equal(prompts.length, 0);
  const empty = await w.odin(['conflicts', 'scan', '--semantic'], { input: '', overrides: { llm } });
  assert.match(empty.out, /Aborted\.\n$/);

  const accepted = await w.odin(['conflicts', 'scan', '--semantic', '--apply', '--concurrency', '2'], { input: 'Y siempre\n', overrides: { llm } });
  assert.equal(accepted.code, 0, accepted.err);
  assert.match(accepted.out, /Continue\? \[y\/N\] Conflicts Scan \(project: conflictos\)\n/);
  assert.match(accepted.out, /  semantic_judged:  \d+\n  semantic_skipped: 0\n  semantic_errors:  0\n$/);
  assert.ok(prompts.length > 0 && prompts.every((p) => /^obs-\w+ vs obs-\w+$/.test(p)));

  const fresh = await seeded(t, { apply: false });
  const yes = await fresh.w.odin(['conflicts', 'scan', '--semantic', '--yes', '--max-semantic', '1'], { overrides: { llm } });
  assert.ok(!yes.out.includes('Continue?'));
  assert.match(yes.out, /WARNING: max-semantic cap of 1 reached — this page has no continuation; re-run with --cursor 0 and a higher cap\.\n$/);

  const unset = await w.odin(['conflicts', 'scan', '--semantic'], { env: { ODIN_AGENT_CLI: '' } });
  assert.deepEqual([unset.code, unset.err], [1, "error: ODIN_AGENT_CLI is not set; required for --semantic scan (set to 'copilot')\n"]);
});

test('conflicts deferred lista, inspecciona y exige reanudación de la sincronización', async (t) => {
  const { w, store } = await seeded(t);
  assert.equal((await w.odin(['conflicts', 'deferred'])).out, 'Deferred Queue\n  Showing: 0\n  Queue is empty.\n');
  store.db.run(`INSERT INTO sync_apply_deferred (sync_id, entity, payload, entity_key, op, apply_status, retry_count, last_error, first_seen_at)
    VALUES ('d1', 'relation', '{"b":[1,{"c":null}],"a":"x"}', 'rel-1', 'upsert', 'deferred', 2, 'espera', '2026-03-01 10:00:00'),
           ('d2', 'observation', 'roto', 'obs-1', 'upsert', 'dead', 5, NULL, '2026-03-02 10:00:00')`);
  assert.equal((await w.odin(['conflicts', 'deferred'])).out, `Deferred Queue
  Showing: 2

  sync_id:      d1
  entity_key:   rel-1
  apply_status: deferred
  retry_count:  2
  first_seen_at: 2026-03-01 10:00:00

  sync_id:      d2
  entity_key:   obs-1
  apply_status: dead
  retry_count:  5
  first_seen_at: 2026-03-02 10:00:00

`);
  assert.match((await w.odin(['conflicts', 'deferred', '--status', 'dead'])).out, /Showing: 1\n\n  sync_id:      d2/);
  assert.match((await w.odin(['conflicts', 'deferred', '--limit', '1'])).out, /Showing: 1\n/);
  assert.equal((await w.odin(['conflicts', 'deferred', '--inspect', 'd1'])).out, `Deferred Row
  sync_id:          d1
  entity:           relation
  entity_key:       rel-1
  op:               upsert
  apply_status:     deferred
  retry_count:      2
  payload_valid:    true
  payload:          map[a:x b:[1 map[c:<nil>]]]
  last_error:       espera
  first_seen_at:    2026-03-01 10:00:00
`);
  const raw = await w.odin(['conflicts', 'deferred', '--inspect', 'd2']);
  assert.match(raw.out, /  payload_valid:    false\n  payload_raw:      roto\n  first_seen_at:    2026-03-02 10:00:00\n$/);
  assert.ok(!raw.out.includes('last_error'));
  const missing = await w.odin(['conflicts', 'deferred', '--inspect', 'nada']);
  assert.deepEqual([missing.code, missing.err], [1, 'error: GetDeferred: deferred row "nada" not found\n']);
  const both = await w.odin(['conflicts', 'deferred', '--inspect', 'd1', '--replay']);
  assert.deepEqual([both.code, both.err], [1, 'error: --inspect and --replay are mutually exclusive\n']);
  const noReplay = await w.odin(['conflicts', 'deferred', '--replay']);
  assert.deepEqual([noReplay.code, noReplay.err], [1, 'odin: deferred replay is not available in this build\n']);
  const replay = await w.odin(['conflicts', 'deferred', '--replay'], { overrides: { syncApply: { replayDeferred: () => ({ retried: 3, succeeded: 2, failed: 1, dead: 0 }) } } });
  assert.equal(replay.out, 'Deferred Replay\n  retried:   3\n  succeeded: 2\n  failed:    1\n  dead:      0\n');
});

test('conflicts prune informa en seco y borra con --apply', async (t) => {
  const { w, store } = await seeded(t);
  for (const [id, seen] of [['old1', '2020-01-01 00:00:00'], ['old2', '2020-01-02 00:00:00']]) {
    store.db.run(`INSERT INTO sync_apply_deferred (sync_id, entity, payload, target_key, project, scope_class, apply_status, reason_code, first_seen_at) VALUES (?, 'observation', '{}', 'cloud:conflictos', 'conflictos', 'scoped', 'dead', 'bad', ?)`, id, seen);
  }
  const dry = await w.odin(['conflicts', 'prune']);
  assert.equal(dry.out, `Dead Row Prune (dry run)
  max_age_days:  30
  max_per_scope: 1000
  would_evict:   2

  By scope:
    target=cloud:conflictos project=conflictos by_age=2 by_cap=0

  By reason:
    entity=observation reason_code=bad age=30d+ count=2

Dry run: nothing was deleted. Re-run with --apply to delete these rows.
`);
  assert.equal(store.db.get('SELECT count(*) AS n FROM sync_apply_deferred').n, 2);
  const applied = await w.odin(['conflicts', 'prune', '--apply', '--max-age-days', '90', '--max-per-scope', '5']);
  assert.match(applied.out, /^Dead Row Prune \(applied\)\n  max_age_days:  90\n  max_per_scope: 5\n  evicted:       2\n/);
  assert.equal(store.db.get('SELECT count(*) AS n FROM sync_apply_deferred').n, 0);
  assert.equal((await w.odin(['conflicts', 'prune'])).out, 'Dead Row Prune (dry run)\n  max_age_days:  30\n  max_per_scope: 1000\n  would_evict:   0\n  Nothing to prune.\n');
  const errors = [
    [['--bogus'], 'error: unknown prune argument: --bogus\n'],
    [['--max-age-days', '0'], 'error: --max-age-days must be a positive integer\n'],
    [['--max-per-scope', 'x'], 'error: --max-per-scope must be a positive integer\n'],
    [['--max-age-days'], 'error: --max-age-days must be a positive integer\n'],
    [['--dry-run', '--apply'], 'error: --dry-run and --apply are mutually exclusive\n'],
  ];
  for (const [flags, message] of errors) {
    const r = await w.odin(['conflicts', 'prune', ...flags]);
    assert.deepEqual([r.code, r.err], [1, message], flags.join(' '));
  }
});

test('instance-id imprime una identidad estable', async (t) => {
  const w = cliWorld(t);
  const first = await w.odin(['instance-id']);
  assert.match(first.out, /^[0-9a-f]{32}\n$/);
  assert.equal((await w.odin(['instance-id'])).out, first.out);
  assert.equal(existsSync(join(w.dataDir, '.instance-id')), true);
});

test('compatibility valida su uso y observa un almacén sin abrirlo', async (t) => {
  const w = cliWorld(t);
  const usage = 'Usage: odin compatibility --data-dir <absolute-directory> --json\n';
  for (const args of [[], ['--json'], ['--data-dir', w.dataDir], ['--json', '--json', '--data-dir', w.dataDir], ['--data-dir', w.dataDir, '--data-dir', w.dataDir, '--json'], ['--data-dir'], ['--json', '--otro']]) {
    const r = await w.odin(['compatibility', ...args]);
    assert.deepEqual([r.code, r.out, r.err], [2, '', usage], args.join(' '));
  }
  const relative = await w.odin(['compatibility', '--data-dir', 'relativa', '--json']);
  assert.deepEqual([relative.code, relative.err], [2, 'compatibility: unsafe or invalid fixture metadata\n']);
  mkdirSync(w.dataDir, { recursive: true });
  const fresh = await w.odin(['compatibility', '--data-dir', w.dataDir, '--json']);
  assert.equal(fresh.code, 0, fresh.err);
  assert.deepEqual(JSON.parse(fresh.out), { revision: 1, source: 'offline', status: 'fresh', offline_automatic_opening_authorized: false, active_reuse_authorized: false });
  assert.ok(fresh.out.endsWith('}\n'));
  await w.odin(['save', 'Título', 'Contenido']);
  const used = JSON.parse((await w.odin(['compatibility', '--data-dir', w.dataDir, '--json'])).out);
  assert.equal(used.status, 'unknown_shape');
  assert.match(used.instance_id, /^[0-9a-f]{32}$/);
});

test('migrate-copy valida todas las opciones antes de leer el origen', async (t) => {
  const w = cliWorld(t);
  const usage = 'Usage: odin migrate-copy --data-dir <absolute-source> --output-dir <new-absolute-destination> --confirm-quiescent --json\n';
  const help = await w.odin(['migrate-copy', '--help']);
  assert.deepEqual([help.code, help.out], [0, usage]);
  const out = join(w.root, 'salida');
  const base = ['--data-dir', w.dataDir, '--output-dir', out, '--confirm-quiescent', '--json'];
  const cases = [
    [[], 'required flag --data-dir'],
    [['--data-dir', w.dataDir], 'required flag --output-dir'],
    [['--data-dir', w.dataDir, '--output-dir', out], 'required flag --confirm-quiescent'],
    [['--data-dir', w.dataDir, '--output-dir', out, '--confirm-quiescent'], 'required flag --json'],
    [[...base, '--json'], 'duplicate flag --json'],
    [[...base, '--bogus'], 'unknown flag --bogus'],
    [['--data-dir', '--output-dir', out], 'missing value for --data-dir'],
    [['--data-dir'], 'missing value for --data-dir'],
    [['--data-dir', 'relativa', '--output-dir', out, '--confirm-quiescent', '--json'], '--data-dir must be absolute'],
    [['--data-dir', w.dataDir, '--output-dir', 'relativa', '--confirm-quiescent', '--json'], '--output-dir must be absolute'],
  ];
  for (const [args, message] of cases) {
    const r = await w.odin(['migrate-copy', ...args]);
    assert.deepEqual([r.code, r.err], [2, `odin migrate-copy: ${message}\n`], args.join(' '));
  }
  const missing = await w.odin(['migrate-copy', ...base]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^odin migrate-copy: lstat .*: no such file or directory\n$/);
  assert.equal(existsSync(out), false, 'no se crea nada si el origen no existe');
  await w.odin(['save', 'Título', 'Contenido']);
  const done = await w.odin(['migrate-copy', ...base]);
  assert.equal(done.code, 0, done.err);
  const result = JSON.parse(done.out);
  assert.deepEqual(Object.keys(result), ['source_dir', 'output_dir', 'instance_id', 'migration_completed']);
  assert.equal(result.output_dir, out);
  assert.equal(result.migration_completed, true);
  writeFileSync(join(w.root, 'x'), 'x');
  const again = await w.odin(['migrate-copy', ...base]);
  assert.deepEqual([again.code, again.err], [1, 'odin migrate-copy: output directory must not exist\n']);
});
