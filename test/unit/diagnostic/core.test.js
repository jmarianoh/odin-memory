import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidCheckError, Registry, Runner, buildReport, errorReport, registeredCodes } from '../../../src/diagnostic/index.js';
import { completeResult, mapEvidence, okResult, resultFromFindings } from '../../../src/diagnostic/core.js';
import { openTempStore } from '../store/helpers.js';

const f = (severity, extra = {}) => ({ check_id: 'c', severity, reason_code: `r_${severity}`, message: 'm', why: `why_${severity}`, evidence: {}, safe_next_step: `next_${severity}`, requires_confirmation: false, ...extra });

test('hay diez chequeos con códigos estables y ordenados', () => {
  assert.deepEqual(registeredCodes(), [
    'ambiguous_active_runtime_sessions', 'invalid_session_identity', 'manual_session_name_project_mismatch', 'orphaned_observation_session', 'orphaned_pending_relations',
    'session_project_directory_mismatch', 'sqlite_lock_contention', 'sync_mutation_required_fields', 'sync_target_closed_space', 'unowned_session_project',
  ]);
});

test('resultFromFindings: sin hallazgos es correcto', () => {
  const r = okResult('x', { n: 1 });
  assert.deepEqual(r, {
    check_id: 'x', result: 'ok', severity: 'info', reason_code: 'x_ok', message: 'No issues detected.',
    why: 'The evaluated store evidence matches expected operational invariants.', evidence: { n: 1 }, safe_next_step: 'No action required.', requires_confirmation: false,
  });
  assert.deepEqual(resultFromFindings('x', { n: 1 }, []), r);
});

test('resultFromFindings: la gravedad del peor hallazgo manda y el primero da el motivo', () => {
  const warn = resultFromFindings('c', {}, [f('warning')]);
  assert.deepEqual([warn.result, warn.severity, warn.reason_code, warn.message, warn.why, warn.safe_next_step], ['warning', 'warning', 'r_warning', '1 finding(s) detected.', 'why_warning', 'next_warning']);
  assert.deepEqual(warn.evidence, { finding_count: 1 });
  assert.equal(warn.requires_confirmation, false);
  assert.equal(warn.findings.length, 1);
  const err = resultFromFindings('c', {}, [f('warning'), f('error')]);
  assert.deepEqual([err.result, err.severity, err.reason_code], ['error', 'error', 'r_warning']);
  const blocked = resultFromFindings('c', {}, [f('warning'), f('error'), f('blocking')]);
  assert.deepEqual([blocked.result, blocked.severity], ['blocked', 'blocking']);
  const infoOnly = resultFromFindings('c', {}, [f('info')]);
  assert.deepEqual([infoOnly.result, infoOnly.severity, infoOnly.message, infoOnly.safe_next_step], ['ok', 'info', 'No actionable issues detected.', 'No action required.']);
  assert.equal(infoOnly.findings.length, 1, 'la evidencia informativa se conserva');
  assert.deepEqual(Object.keys(warn), ['check_id', 'result', 'severity', 'reason_code', 'message', 'why', 'evidence', 'safe_next_step', 'requires_confirmation', 'findings']);
});

test('completeResult rellena lo que falta', () => {
  assert.deepEqual(completeResult({}, 'code'), { check_id: 'code', result: 'ok', severity: 'info', reason_code: 'code_ok', evidence: { evaluated: true } });
  assert.equal(completeResult({ check_id: '  propio  ' }, 'code').check_id, 'propio');
  assert.equal(completeResult({ result: 'error', severity: 'error', reason_code: 'x', evidence: null }, 'c').evidence.evaluated, true);
});

test('buildReport suma por estado y el peor estado manda', () => {
  const check = (result) => ({ result });
  assert.deepEqual(buildReport('', []), { status: 'ok', summary: { total: 0, ok: 0, warnings: 0, blocked: 0, errors: 0 }, checks: [] });
  assert.equal(buildReport('p', [check('ok'), check('warning')]).status, 'warning');
  assert.equal(buildReport('p', [check('warning'), check('blocked')]).status, 'blocked');
  const worst = buildReport('p', [check('blocked'), check('error'), check('ok'), check('info')]);
  assert.deepEqual([worst.status, worst.project, worst.summary], ['error', 'p', { total: 4, ok: 2, warnings: 0, blocked: 1, errors: 1 }]);
  assert.deepEqual(Object.keys(worst), ['status', 'project', 'summary', 'checks']);
});

test('errorReport distingue el chequeo inválido del fallo interno', () => {
  const invalid = errorReport('p', new InvalidCheckError('nada'));
  assert.deepEqual(invalid.checks[0].check_id, 'invalid_check');
  assert.equal(invalid.checks[0].message, 'invalid diagnostic check: "nada"');
  assert.deepEqual(invalid.summary, { total: 1, ok: 0, warnings: 0, blocked: 0, errors: 1 });
  assert.equal(invalid.checks[0].safe_next_step, 'Run `odin doctor` without --check to list registered diagnostics.');
  const other = errorReport('', new Error('boom'));
  assert.deepEqual([other.checks[0].check_id, other.checks[0].reason_code, other.checks[0].evidence, other.status], ['diagnostic_error', 'diagnostic_error', { error: 'boom' }, 'error']);
  assert.ok(!('project' in other));
});

test('mapEvidence ordena las claves como un mapa', () => {
  assert.deepEqual(Object.keys(mapEvidence({ zeta: 1, alfa: 2, medio: 3 })), ['alfa', 'medio', 'zeta']);
});

test('Registry ignora entradas vacías, ordena y rechaza códigos desconocidos', () => {
  const run = () => ({});
  const registry = new Registry([{ code: 'b', run }, null, { code: '  ', run }, { code: 'a', run }, { code: 'b', run: () => ({ v: 2 }) }]);
  assert.deepEqual(registry.codes(), ['a', 'b']);
  assert.deepEqual(registry.checks().map((c) => c.code), ['a', 'b']);
  assert.equal(registry.lookup(' a ').code, 'a');
  assert.throws(() => registry.lookup('z'), InvalidCheckError);
  assert.throws(() => registry.lookup(''), { message: 'invalid diagnostic check: ""' });
});

test('Runner ejecuta todos o uno y completa los campos ausentes', (t) => {
  const store = openTempStore(t);
  const registry = new Registry([{ code: 'dos', run: () => ({ result: 'warning', severity: 'warning', message: 'm' }) }, { code: 'uno', run: () => ({}) }]);
  const runner = new Runner({ registry });
  const all = runner.runAll({ store, project: 'demo' });
  assert.deepEqual(all.checks.map((c) => [c.check_id, c.result]), [['dos', 'warning'], ['uno', 'ok']]);
  assert.equal(all.project, 'demo');
  assert.equal(all.status, 'warning');
  const one = runner.runOne({ store, project: '' }, ' uno ');
  assert.deepEqual([one.summary.total, one.checks[0].reason_code, one.checks[0].evidence], [1, 'uno_ok', { evaluated: true }]);
  assert.throws(() => runner.runOne({ store }, 'tres'), InvalidCheckError);
  const real = new Runner().runAll({ store, project: '' });
  assert.deepEqual([real.status, real.summary.total, real.summary.ok], ['ok', 10, 10]);
});
