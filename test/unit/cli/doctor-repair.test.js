import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { addObservation, addPrompt, createSession } from '../../../src/store/index.js';
import { cliWorld } from './helpers.js';

function orphan(world) {
  const store = world.store();
  createSession(store, 's1', 'demo', '/tmp/x');
  const id = addObservation(store, { session_id: 's1', type: 'manual', title: 'huérfana', content: 'c', project: 'demo' }).id;
  store.db.run('PRAGMA foreign_keys = OFF');
  store.db.run("UPDATE observations SET session_id = 'perdida' WHERE id = ?", id);
  store.close();
}

const repair = (w, ...args) => w.odin(['doctor', 'repair', ...args]);
const json = (r) => JSON.parse(r.out);

test('plan y simulacro no escriben y aplicar repone la sesión tras una copia', async (t) => {
  const w = cliWorld(t);
  orphan(w);
  const base = ['--project', 'demo', '--check', 'orphaned_observation_session'];
  const plan = await repair(w, ...base, '--plan');
  assert.equal(plan.code, 0, plan.err);
  assert.ok(plan.out.startsWith('{\n  "project": "demo",\n  "check": "orphaned_observation_session",\n  "mode": "plan",\n  "status": "planned",\n  "actions": [],\n  "placeholder_sessions": [\n'));
  assert.deepEqual([json(plan).counts.sessions_planned, json(plan).counts.observations_planned, json(plan).counts.sessions_applied], [1, 1, 0]);
  assert.equal(json(await repair(w, ...base, '--dry-run')).status, 'dry_run');
  const before = w.store();
  assert.equal(before.db.get("SELECT count(*) AS n FROM sessions WHERE id = 'perdida'").n, 0);
  before.close();

  const applied = json(await repair(w, ...base, '--apply'));
  assert.deepEqual([applied.status, applied.counts.sessions_applied, applied.counts.observations_applied], ['applied', 1, 1]);
  const after = w.store();
  assert.equal(after.db.get("SELECT ownership_mode AS m FROM sessions WHERE id = 'perdida'").m, 'project_owned');
  after.close();
  const again = json(await repair(w, ...base, '--apply'));
  assert.equal(again.status, 'noop');
});

test('las relaciones huérfanas se reclasifican con copia y sin pedir proyecto', async (t) => {
  const w = cliWorld(t);
  const store = w.store();
  store.db.run("INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status) VALUES ('r1', 'x', 'y', 'related', 'pending')");
  store.close();
  const plan = json(await repair(w, '--check', 'orphaned_pending_relations', '--plan'));
  assert.deepEqual([plan.project, plan.status, plan.counts.relations_planned], ['', 'planned', 1]);
  const applied = json(await repair(w, '--check', 'orphaned_pending_relations', '--apply'));
  assert.deepEqual([applied.status, applied.counts.relations_applied], ['applied', 1]);
  assert.ok(existsSync(applied.backup_path));
  assert.equal(json(await repair(w, '--check', 'orphaned_pending_relations', '--apply')).status, 'noop');
});

test('el traslado de proyecto reasigna sesión, observaciones y prompts', async (t) => {
  const w = cliWorld(t);
  const store = w.store();
  createSession(store, 'real', 'destino', '/d');
  createSession(store, 'manual-save-destino', 'origen', '/nada');
  addObservation(store, { session_id: 'manual-save-destino', type: 'manual', title: 't', content: 'c', project: 'origen' });
  addPrompt(store, { session_id: 'manual-save-destino', content: 'p', project: 'origen' });
  store.close();
  const plan = json(await repair(w, '--project', 'origen', '--check', 'manual_session_name_project_mismatch', '--dry-run'));
  assert.deepEqual(plan.actions.map((a) => [a.session_id, a.from_project, a.to_project]), [['manual-save-destino', 'origen', 'destino']]);
  assert.deepEqual([plan.counts.sessions_planned, plan.counts.observations_planned, plan.counts.prompts_planned], [1, 1, 1]);
  const applied = json(await repair(w, '--project', 'origen', '--check', 'manual_session_name_project_mismatch', '--apply'));
  assert.deepEqual([applied.status, applied.counts.sessions_applied, applied.counts.observations_applied, applied.counts.prompts_applied], ['applied', 1, 1, 1]);
  assert.ok(existsSync(applied.backup_path));
});

test('validación de argumentos: el error va a stderr, el uso a stdout y el código es 1', async (t) => {
  const w = cliWorld(t);
  const cases = [
    [[], '--project is required'],
    [['--project', 'demo'], '--check is required'],
    [['--project', 'demo', '--check', 'orphaned_observation_session'], 'exactly one of --plan, --dry-run, or --apply is required'],
    [['--project', 'demo', '--check', 'orphaned_observation_session', '--plan', '--apply'], 'exactly one of --plan, --dry-run, or --apply is required'],
    [['--project', 'demo', '--check', 'orphaned_observation_session', '--plan', '--replacement-id', 'x'], 'identity flags require --check invalid_session_identity'],
    [['--project', 'demo', '--check', 'invalid_session_identity', '--plan', '--source-id', 'x'], '--source-id requires --replacement-id'],
    [['--project', 'demo', '--check', 'unowned_session_project', '--plan'], 'unowned_session_project is a diagnostic-only check with no repair; run odin doctor --check unowned_session_project'],
    [['--project', 'demo', '--check', 'nada', '--plan'], 'unsupported repair check nada'],
    [['--bogus'], 'unknown doctor repair argument "--bogus"'],
    [['--project'], '--project requires a value'],
    [['--check'], '--check requires a value'],
    [['--replacement-id'], '--replacement-id requires a value'],
    [['--source-id'], '--source-id requires a value'],
  ];
  for (const [args, message] of cases) {
    const r = await repair(w, ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.err, `odin doctor repair failed: ${message}\n`, args.join(' '));
    assert.ok(r.out.startsWith('note: project aliases veto contradictory reclassification'), args.join(' '));
  }
  const help = await repair(w, '--help');
  assert.equal(help.code, 0);
  assert.ok(help.out.includes('repairable checks: invalid_session_identity, manual_session_name_project_mismatch, orphaned_observation_session, orphaned_pending_relations, session_project_directory_mismatch, sync_mutation_required_fields, sync_target_closed_space\n'));
  assert.equal(help.err, '');
});

test('las reparaciones del diario responden sobre un almacén sano', async (t) => {
  const w = cliWorld(t);
  const required = json(await repair(w, '--check', 'sync_mutation_required_fields'));
  assert.deepEqual([required.applied, required.actions, required.repairs, required.superseded, required.source_repairs, required.source_unrepairable], [false, [], [], [], [], []]);
  const closed = json(await repair(w, '--project', 'demo', '--check', 'sync_target_closed_space', '--plan'));
  assert.equal(closed.status, 'noop');
  const blocked = json(await repair(w, '--project', 'demo', '--check', 'invalid_session_identity', '--plan', '--replacement-id', 'nueva'));
  assert.deepEqual([blocked.status, blocked.blockers[0].reason_code], ['blocked', 'ambiguous_or_missing_source']);
  const plan = json(await repair(w, '--project', 'demo', '--check', 'invalid_session_identity', '--plan'));
  assert.equal(plan.status, 'noop', 'sin ID de reemplazo es solo un plan');
});
