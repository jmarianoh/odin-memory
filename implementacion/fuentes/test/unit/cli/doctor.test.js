import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addObservation, createSession } from '../../../src/store/index.js';
import { cliWorld } from './helpers.js';

function corrupt(world) {
  const store = world.store();
  createSession(store, 's1', 'mi-repo', '/tmp/x');
  const id = addObservation(store, { session_id: 's1', type: 'manual', title: 'huérfana', content: 'c', project: 'mi-repo' }).id;
  store.db.run('PRAGMA foreign_keys = OFF');
  store.db.run("UPDATE observations SET session_id = 'perdida' WHERE id = ?", id);
  store.close();
}

test('doctor sobre un almacén sano imprime el resumen y cada chequeo', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['doctor']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['Odin Doctor: ok', 'Checks: 10 ok=10 warnings=0 blocked=0 errors=0', '']);
  assert.equal(lines[3], '[ok] ambiguous_active_runtime_sessions — No issues detected.');
  assert.equal(lines[4], '  why: The evaluated store evidence matches expected operational invariants.');
  assert.equal(lines[5], '  next: No action required.');
  assert.equal(r.out.match(/^\[ok\] /gm).length, 10);
});

test('doctor --json emite el informe con sangría de dos espacios', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['doctor', '--json']);
  assert.ok(r.out.startsWith('{\n  "status": "ok",\n  "summary": {\n    "total": 10,'));
  const report = JSON.parse(r.out);
  assert.deepEqual(report.checks.map((c) => c.check_id), [...report.checks.map((c) => c.check_id)].sort());
  assert.ok(!('project' in report));
  const scoped = JSON.parse((await w.odin(['doctor', '--json', '--project', 'Mi-Repo'])).out);
  assert.equal(scoped.project, 'mi-repo', 'el proyecto se normaliza y no tiene que existir');
});

test('doctor informa hallazgos con evidencia y siguiente paso', async (t) => {
  const w = cliWorld(t);
  corrupt(w);
  const r = await w.odin(['doctor', '--check', 'orphaned_observation_session']);
  assert.equal(r.code, 0);
  const next = 'Review the affected reference, then run `odin doctor repair --project <project> --check orphaned_observation_session --plan`; apply only after confirming the local placeholder session is appropriate.';
  const observed = JSON.parse((await w.odin(['doctor', '--check', 'orphaned_observation_session', '--json'])).out).checks[0].findings[0].evidence.first_observed_at;
  assert.equal(r.out, [
    'Odin Doctor: warning',
    'Checks: 1 ok=0 warnings=1 blocked=0 errors=0',
    '',
    '[warning] orphaned_observation_session — 1 finding(s) detected.',
    '  why: Observations reference a missing session, so their canonical session cannot be reconstructed automatically.',
    `  next: ${next}`,
    '  - orphaned_observation_session: 1 observation(s) reference missing session "perdida".',
    `    next: ${next}`,
    `    evidence: {"project":"mi-repo","session_id":"perdida","observation_count":1,"first_observed_at":${JSON.stringify(observed)}}`,
    '',
  ].join('\n'));
});

test('doctor valida sus argumentos', async (t) => {
  const w = cliWorld(t);
  const bad = await w.odin(['doctor', '--bogus']);
  assert.equal(bad.code, 1);
  assert.equal(bad.err, 'error: unknown doctor argument "--bogus"\n');
  assert.ok(bad.out.includes('usage: odin doctor [--json] [--project PROJECT] [--check CODE]'));
  for (const flag of ['--project', '--check']) {
    const r = await w.odin(['doctor', flag]);
    assert.equal(r.code, 1);
    assert.equal(r.err, `error: ${flag} requires a value\n`);
  }
  const invalid = await w.odin(['doctor', '--check', 'nada']);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.err, 'odin doctor failed: invalid diagnostic check: "nada"\n');
  const json = await w.odin(['doctor', '--check', 'nada', '--json']);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.out).checks[0].check_id, 'invalid_check');
  assert.equal(json.err, '');
  const discard = await w.odin(['doctor', 'discard-empty-prompt']);
  assert.equal(discard.code, 1);
  assert.match(discard.err, /doctor discard-empty-prompt is not available in this build/);
});

test('doctor --help lista los chequeos y los que no tienen reparación', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['doctor', '--help']);
  assert.equal(r.code, 0);
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'note: project mismatch evidence includes local aliases; repair rereads aliases to veto contradictory moves.');
  assert.ok(lines.includes('checks: ambiguous_active_runtime_sessions, invalid_session_identity, manual_session_name_project_mismatch, orphaned_observation_session, orphaned_pending_relations, session_project_directory_mismatch, sqlite_lock_contention, sync_mutation_required_fields, sync_target_closed_space, unowned_session_project'));
  assert.ok(lines.includes('diagnostic-only checks with no repair: ambiguous_active_runtime_sessions, sqlite_lock_contention, unowned_session_project'));
});

test('doctor añade el aviso de registros MCP obsoletos solo en el informe completo', async (t) => {
  const w = cliWorld(t);
  const staleMcpCommands = () => [{ slug: 'vscode-copilot', path: '/no/existe' }];
  const full = await w.odin(['doctor', '--json'], { overrides: { staleMcpCommands } });
  const report = JSON.parse(full.out);
  assert.deepEqual([report.status, report.summary.total, report.summary.warnings], ['warning', 11, 1]);
  const stale = report.checks.at(-1);
  assert.deepEqual([stale.check_id, stale.evidence, stale.findings[0].message, stale.findings[0].safe_next_step], ['stale_mcp_command', null, 'vscode-copilot odin MCP executable path is missing', 'odin setup vscode-copilot']);
  const scoped = JSON.parse((await w.odin(['doctor', '--json', '--project', 'x'], { overrides: { staleMcpCommands } })).out);
  assert.equal(scoped.summary.total, 10);
  const broken = JSON.parse((await w.odin(['doctor', '--json'], { overrides: { staleMcpCommands: () => { throw new Error('ilegible'); } } })).out);
  assert.deepEqual([broken.status, broken.checks.at(-1).check_id, broken.checks.at(-1).message], ['error', 'mcp_inspection_error', 'Could not inspect generic MCP registrations: ilegible']);
});
