import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../../../src/diagnostic/index.js';
import { buildRepairPlan, planJson } from '../../../src/diagnostic/repair.js';
import { REPAIRABLE_CODES, isRepairableCode } from '../../../src/diagnostic/repair-codes.js';
import { addObservation, createSession } from '../../../src/store/index.js';
import { openTempStore } from '../store/helpers.js';

const plan = (store, project, check, mode = 'plan', scope = {}) => {
  const full = { store, project, ...scope };
  return buildRepairPlan(full, new Runner().runOne(full, check), check, mode);
};

test('qué chequeos se pueden reparar', () => {
  assert.deepEqual([...REPAIRABLE_CODES].sort(), [
    'invalid_session_identity', 'manual_session_name_project_mismatch', 'orphaned_observation_session', 'orphaned_pending_relations', 'session_project_directory_mismatch',
    'sync_mutation_required_fields', 'sync_target_closed_space',
  ]);
  assert.equal(isRepairableCode(' orphaned_observation_session '), true);
  assert.equal(isRepairableCode('unowned_session_project'), false);
  assert.equal(isRepairableCode(undefined), false);
});

test('el modo y el chequeo se validan', (t) => {
  const store = openTempStore(t);
  assert.throws(() => plan(store, 'demo', 'orphaned_observation_session', 'otro'), { message: 'unsupported repair mode "otro"' });
  assert.throws(() => plan(store, 'demo', 'unowned_session_project'), { message: 'unsupported repair check "unowned_session_project"' });
  const noop = plan(store, 'demo', 'orphaned_observation_session');
  assert.deepEqual([noop.status, noop.actions, noop.placeholder_sessions], ['noop', [], []]);
  assert.equal(plan(store, 'demo', 'orphaned_observation_session', 'dry_run').status, 'noop');
});

test('el estado inicial sale del modo y el JSON conserva el orden de campos', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  const id = addObservation(store, { session_id: 's1', type: 'manual', title: 't', content: 'c', project: 'demo' }).id;
  store.db.run('PRAGMA foreign_keys = OFF');
  store.db.run("UPDATE observations SET session_id = 'perdida' WHERE id = ?", id);
  const statuses = ['plan', 'dry_run', 'apply'].map((mode) => plan(store, 'demo', 'orphaned_observation_session', mode).status);
  assert.deepEqual(statuses, ['planned', 'dry_run', 'planned']);
  const json = planJson(plan(store, 'demo', 'orphaned_observation_session'));
  assert.deepEqual(Object.keys(json), ['project', 'check', 'mode', 'status', 'actions', 'placeholder_sessions', 'counts']);
  assert.deepEqual(Object.keys(json.counts), [
    'sessions_planned', 'observations_planned', 'prompts_planned', 'sessions_applied', 'observations_applied', 'prompts_applied', 'corrected_mutations_planned',
    'corrected_mutations_applied', 'relations_planned', 'relations_applied',
  ]);
  assert.deepEqual(Object.keys(json.placeholder_sessions[0]), ['session_id', 'project', 'observation_count', 'started_at']);
});

test('sesiones huérfanas: una por ID y las ambiguas se omiten', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  const ids = ['a', 'b', 'c'].map((n) => addObservation(store, { session_id: 's1', type: 'manual', title: n, content: n, project: 'demo' }).id);
  store.db.run('PRAGMA foreign_keys = OFF');
  store.db.run("UPDATE observations SET session_id = 'zeta' WHERE id = ?", ids[0]);
  store.db.run("UPDATE observations SET session_id = 'alfa' WHERE id = ?", ids[1]);
  store.db.run("UPDATE observations SET session_id = 'mixta', project = 'otro' WHERE id = ?", ids[2]);
  store.db.run("INSERT INTO observations (sync_id, session_id, type, title, content, project, scope) VALUES ('o-m', 'mixta', 'manual', 't', 'c', 'demo', 'project')");
  const p = plan(store, '', 'orphaned_observation_session');
  assert.deepEqual(p.placeholder_sessions.map((x) => x.session_id), ['alfa', 'zeta'], 'ordenadas por ID');
  assert.deepEqual(p.skipped, [{ session_id: 'mixta', reason_code: 'ambiguous_orphaned_session_project', message: 'the same missing session ID is referenced by multiple projects' }]);
  assert.ok(!('session_id' in planJson({ ...p, skipped: [{ reason_code: 'r', message: 'm', session_id: '' }] }).skipped[0]), 'un ID vacío no se serializa');
});

test('relaciones huérfanas: candidatas de todos los proyectos', (t) => {
  const store = openTempStore(t);
  store.db.run("INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status) VALUES ('r1', 'x', 'y', 'related', 'pending')");
  const p = plan(store, 'ignorado', 'orphaned_pending_relations');
  assert.equal(p.status, 'planned');
  assert.equal(p.counts.relations_planned, 1);
  assert.deepEqual(p.orphaned_pending_relations.candidates.map((c) => c.sync_id), ['r1']);
  assert.deepEqual(Object.keys(planJson(p)), ['project', 'check', 'mode', 'status', 'actions', 'orphaned_pending_relations', 'counts']);
});

test('identidad inválida: sin ID de reemplazo solo explica qué falta', (t) => {
  const store = openTempStore(t);
  store.db.run("INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES (' ', 'demo', '/x', '2026-01-01 00:00:00', 'shared')");
  store.db.run(
    `INSERT INTO sync_apply_deferred (sync_id, entity, payload, target_key, project, scope_class, apply_status, reason_code, first_seen_at, entity_key, op, remote_seq)
     VALUES ('d1', 'session', '{}', 'local', 'demo', 'scoped', 'dead', 'sync_session_identity_invalid', '2026-01-01 00:00:00', ' ', 'upsert', 1)`,
  );
  const p = plan(store, 'demo', 'invalid_session_identity');
  assert.equal(p.status, 'noop');
  // Se ordena por ID de sesión (el vacío primero) y luego por motivo.
  assert.deepEqual(p.skipped, [
    { reason_code: 'quarantined_pulled_session_identity', message: 'pulled session mutation was quarantined with a blank identity; it can only be applied once the remote side publishes a canonical session ID' },
    { session_id: ' ', reason_code: 'cannot_repair_without_explicit_canonical_session_id', message: 'supply --replacement-id with a valid unused canonical session ID to plan this local repair' },
  ]);
});

test('traslado por directorio: solo con Git de confianza, el mismo proyecto de origen y sin alias en contra', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'viejo', '/repo');
  createSession(store, 's2', 'viejo', '/otro');
  createSession(store, 's3', 'viejo', '/basename');
  const detectProject = (dir) => ({
    '/repo': { project: 'nuevo', source: 'git_remote', path: '/repo' }, '/otro': { project: 'otro-destino', source: 'git_root', path: '/otro' }, '/basename': { project: 'x', source: 'dir_basename', path: '' },
  }[dir]);
  const p = plan(store, 'viejo', 'session_project_directory_mismatch', 'plan', { detectProject });
  assert.deepEqual(p.actions.map((a) => [a.session_id, a.to_project, a.evidence_source]), [['s1', 'nuevo', 'git_remote'], ['s2', 'otro-destino', 'git_root']]);
  assert.deepEqual(Object.keys(p.actions[0]), ['session_id', 'from_project', 'to_project', 'reason_code', 'evidence_source', 'evidence_path']);
  // Un alias de cwd hacia otro proyecto veta el traslado de esa sesión; el resto sigue.
  store.db.run("INSERT INTO project_aliases (kind, alias_key, project) VALUES ('cwd', ?, 'otro-proyecto')", '/otro');
  const vetoed = plan(store, 'viejo', 'session_project_directory_mismatch', 'plan', { detectProject });
  assert.deepEqual(vetoed.actions.map((a) => a.session_id), ['s1']);
  assert.deepEqual(vetoed.skipped.map((s) => [s.session_id, s.reason_code]), [['s2', 'project_alias_contradicts_reclassification']]);
  // El informe de otro proyecto no mueve sesiones de este.
  assert.deepEqual(plan(store, 'nuevo', 'session_project_directory_mismatch', 'plan', { detectProject }).actions, []);
});

test('traslado por nombre manual: omisiones y veto del nombre del directorio', (t) => {
  const store = openTempStore(t);
  createSession(store, 'real', 'destino', '/d');
  createSession(store, 'manual-save-destino', 'origen', '/m1');
  createSession(store, 'manual-save-desconocido', 'origen', '/m2');
  createSession(store, 'manual-save-origen', 'origen', '/m3');
  createSession(store, 'manual-save-destino-b', 'origen', '/m4');
  createSession(store, 'ordinaria', 'origen', '/m5');
  const detectProject = (dir) => (dir === '/m4' ? { project: 'origen', source: 'dir_basename', path: '' } : null);
  const p = plan(store, 'origen', 'manual_session_name_project_mismatch', 'plan', { detectProject });
  assert.deepEqual(p.actions.map((a) => [a.session_id, a.to_project, a.reason_code]), [['manual-save-destino', 'destino', 'manual_session_name_project_mismatch']]);
  assert.deepEqual(p.skipped.map((s) => [s.session_id, s.reason_code]), [
    ['manual-save-desconocido', 'manual_name_unknown_project'],
    ['manual-save-destino-b', 'directory_basename_corroborates_persisted_project'],
  ]);
});

test('el plan por directorio descarta evidencia de un informe ajeno o sin confianza', (t) => {
  const store = openTempStore(t);
  const report = (...evidences) => ({ checks: [{ findings: evidences.map((evidence) => ({ reason_code: 'session_project_directory_mismatch', evidence })) }] });
  const ev = (over) => ({ session_id: 's1', session_project: 'viejo', directory_project: 'nuevo', directory_project_source: 'git_remote', directory_project_path: '/r', ...over });
  const build = (rep, project = 'viejo') => buildRepairPlan({ store, project }, rep, 'session_project_directory_mismatch', 'plan');
  const basename = build(report(ev({ directory_project_source: 'dir_basename' })));
  assert.deepEqual(basename.skipped.map((s) => s.reason_code), ['untrusted_directory_evidence']);
  const config = build(report(ev({ directory_project_source: 'config' })));
  assert.deepEqual(config.skipped.map((s) => s.reason_code), ['untrusted_directory_evidence']);
  const foreign = build(report(ev({ session_project: 'otro' })));
  assert.deepEqual(foreign.skipped.map((s) => s.reason_code), ['invalid_reclassification_evidence'], 'el proyecto de la sesión no es el del plan');
  const noSession = build(report(ev({ session_id: '' })));
  assert.deepEqual(noSession.skipped.map((s) => s.reason_code), ['invalid_reclassification_evidence']);
  const same = build(report(ev({ directory_project: 'viejo' })));
  assert.deepEqual(same.skipped.map((s) => s.reason_code), ['invalid_reclassification_evidence'], 'mover al mismo proyecto no es un traslado');
  const good = build(report(ev({}), ev({})));
  assert.equal(good.actions.length, 1, 'las acciones repetidas se funden');
  assert.deepEqual([good.actions[0].evidence_source, good.actions[0].evidence_path], ['git_remote', '/r']);
});
