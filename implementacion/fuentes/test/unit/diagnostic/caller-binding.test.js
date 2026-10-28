import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCallerBinding } from '../../../src/diagnostic/index.js';

const COLLECT = 'Collect caller context without registering a session.';
const INSPECT = 'Inspect the runtime binding; diagnosis does not repair it.';
const RESUME = 'Resume through a host that can persist effective identity; do not reopen the ended session.';

const reader = (sessions) => ({ getSession: (id) => sessions[id] ?? null });
const session = (project, ended = false) => ({ project, ended_at: ended ? '2026-01-01 00:00:00' : null });
const host = { append_entry_available: true, branch_available: true };
const base = { project: 'demo', runtime_session_id: 'rt', effective_session_id: 'rt', host_context: host };
const assess = (sessions, input) => assessCallerBinding(reader(sessions), { ...base, ...input });
const expectation = (status, root, effective, reason, next) => ({ status, root_state: root, effective_state: effective, reason_code: reason, safe_next_step: next, write_success_guaranteed: false });

test('falta de contexto', () => {
  for (const input of [{ project: '' }, { runtime_session_id: ' ' }, { effective_session_id: '' }, { project: '   ' }]) {
    assert.deepEqual(assess({}, input), expectation('unknown', 'unknown', 'unknown', 'caller_context_missing', COLLECT), JSON.stringify(input));
  }
  assert.equal(assess({}, { project: 'a/\u0000b' }).reason_code, 'caller_context_missing', 'un proyecto inválido cuenta como contexto ausente');
});

test('sin lector el diagnóstico no está disponible', () => {
  assert.deepEqual(assessCallerBinding(null, base), expectation('unknown', 'unknown', 'unknown', 'caller_binding_unavailable', 'Verify support and availability of the caller diagnostic.'));
  const failing = { getSession: () => { throw new Error('boom'); } };
  assert.equal(assessCallerBinding(failing, base).reason_code, 'caller_binding_unavailable');
});

test('sesión raíz y efectiva ausentes', () => {
  assert.deepEqual(assess({}, {}), expectation('unknown', 'missing', 'unknown', 'session_not_registered', 'Use the normal runtime registration path; diagnosis does not register sessions.'));
  const r = assess({ rt: session('demo') }, { effective_session_id: 'rt:resume:2' });
  assert.deepEqual(r, expectation('unknown', 'active', 'missing', 'effective_session_missing', INSPECT));
});

test('proyecto de la sesión en conflicto', () => {
  assert.deepEqual(assess({ rt: session('otro') }, {}), expectation('blocked', 'active', 'active', 'session_project_conflict', INSPECT));
  assert.equal(assess({ rt: session('') }, {}).reason_code, 'session_project_conflict');
  assert.equal(assess({ rt: session('Demo') }, {}).status, 'ok', 'se comparan los nombres canónicos');
  assert.equal(assess({ rt: session('demo'), 'rt:resume:2': session('otro') }, { effective_session_id: 'rt:resume:2' }).reason_code, 'session_project_conflict');
});

test('la identidad efectiva debe ser rt:resume:N con N entero canónico ≥ 2', () => {
  const sessions = (id) => ({ rt: session('demo', true), [id]: session('demo') });
  for (const id of ['rt:resume:2', 'rt:resume:10', 'rt:resume:99999999999999999999']) {
    assert.equal(assess(sessions(id), { effective_session_id: id }).status, 'ok', id);
  }
  for (const id of ['rt:resume:1', 'rt:resume:0', 'rt:resume:02', 'rt:resume:+2', 'rt:resume:-3', 'rt:resume:', 'rt:resume:x', 'otro', 'rt:resume:2:resume:3']) {
    const r = assess(sessions(id), { effective_session_id: id });
    assert.deepEqual([r.status, r.reason_code], ['blocked', 'effective_mapping_invalid'], id);
  }
});

test('evidencia del anfitrión y estados finales', () => {
  const active = { rt: session('demo') };
  const ended = { rt: session('demo', true) };
  assert.deepEqual(assess(active, { host_context: null }), expectation('unknown', 'active', 'active', 'host_context_missing', COLLECT));
  assert.equal(assess(active, { host_context: { append_entry_available: null, branch_available: true } }).reason_code, 'host_context_missing');
  assert.equal(assess(active, { host_context: { append_entry_available: true, branch_available: null } }).reason_code, 'host_context_missing');
  assert.deepEqual(assess(active, {}), expectation('ok', 'active', 'active', 'binding_observed', 'No action required; a later write is not guaranteed.'));
  assert.deepEqual(assess(ended, {}), expectation('warning', 'ended', 'ended', 'resume_required', RESUME));
  for (const hostContext of [{ append_entry_available: false, branch_available: true }, { append_entry_available: true, branch_available: false }]) {
    assert.deepEqual(assess(ended, { host_context: hostContext }), expectation('blocked', 'ended', 'ended', 'ended_session_without_persistence', RESUME));
  }
  const resumed = assess({ rt: session('demo', true), 'rt:resume:2': session('demo') }, { effective_session_id: 'rt:resume:2' });
  assert.deepEqual([resumed.status, resumed.root_state, resumed.effective_state], ['ok', 'ended', 'active']);
});
