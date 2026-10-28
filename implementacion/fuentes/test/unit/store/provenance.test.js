import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addObservation, addPrompt, addPromptIfMissing, capturePromptForSave, captureProjectProvenance, contentTruncation, createSession,
  parseProvenance, passiveCapture, registerSessionWithProvenance, resolveManualSession, startSession, validateProvenance,
} from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const code = (c) => (err) => err.code === c;
const prov = (source, extra = {}) => ({ source, directory: '/d', raw_project: 'Raw', ...extra });

test('validateProvenance acepta orígenes conocidos y rechaza el resto', () => {
  validateProvenance(null);
  validateProvenance(undefined);
  validateProvenance({});
  for (const s of ['', 'unknown', 'git_remote', 'git_root', 'git_child', 'dir_basename', 'ambiguous', 'explicit_override', 'session', 'user_selected_after_ambiguous_project', 'request_body', 'config', 'all_projects', 'process_override', 'stored_project', 'unbound_git']) {
    validateProvenance({ source: s });
  }
  assert.throws(() => validateProvenance({ source: 'raro' }), (e) => e.code === 'invalid_project_provenance' && e.message === 'invalid project_provenance: unsupported source "raro"');
});

test('parseProvenance valida los tipos y conserva solo los campos conocidos', () => {
  assert.deepEqual(parseProvenance({ source: 'config', directory: '/x', raw_project: 'p', futuro: 1 }), { source: 'config', directory: '/x', raw_project: 'p' });
  assert.deepEqual(parseProvenance({}), {});
  for (const bad of [null, [], 'x', 4]) assert.throws(() => parseProvenance(bad), code('invalid_project_provenance'));
  for (const key of ['source', 'directory', 'raw_project']) {
    assert.throws(() => parseProvenance({ [key]: null }), (e) => e.message === `invalid project_provenance: ${key} must be a string`);
    assert.throws(() => parseProvenance({ [key]: 3 }), (e) => e.message === `invalid project_provenance: ${key} must be a string`);
  }
  assert.throws(() => parseProvenance({ source: 'raro' }), code('invalid_project_provenance'));
});

test('una observación nueva guarda su evidencia; repetir, deduplicar o actualizar no la cambia', (t) => {
  const store = openTempStore(t);
  createSession(store, 's', 'p', '/d');
  const first = addObservation(store, { session_id: 's', type: 'manual', title: 'T', content: 'c', project: 'p', topic_key: 'a/b', project_provenance: prov('config') });
  assert.deepEqual(captureProjectProvenance(store, 'observation', first.id), { source: 'config', directory: '/d', raw_project: 'Raw' });
  // mismo tema: se actualiza la misma fila y la evidencia original se conserva
  const again = addObservation(store, { session_id: 's', type: 'manual', title: 'T2', content: 'c2', project: 'p', topic_key: 'a/b', project_provenance: prov('git_root') });
  assert.equal(again.id, first.id);
  assert.equal(captureProjectProvenance(store, 'observation', first.id).source, 'config');
  // duplicado dentro de la ventana
  const dup = addObservation(store, { session_id: 's', type: 'manual', title: 'U', content: 'x', project: 'p', project_provenance: prov('git_root') });
  const dup2 = addObservation(store, { session_id: 's', type: 'manual', title: 'U', content: 'x', project: 'p', project_provenance: prov('process_override') });
  assert.equal(dup2.id, dup.id);
  assert.equal(captureProjectProvenance(store, 'observation', dup.id).source, 'git_root');
});

test('sin evidencia no hay fila, y un origen vacío se guarda como unknown', (t) => {
  const store = openTempStore(t);
  createSession(store, 's', 'p', '/d');
  const a = addObservation(store, { session_id: 's', type: 'manual', title: 'A', content: 'a', project: 'p' });
  assert.equal(captureProjectProvenance(store, 'observation', a.id), null);
  const b = addObservation(store, { session_id: 's', type: 'manual', title: 'B', content: 'b', project: 'p', project_provenance: {} });
  assert.deepEqual(captureProjectProvenance(store, 'observation', b.id), { source: 'unknown', directory: '', raw_project: '' });
  assert.throws(() => addObservation(store, { session_id: 's', type: 'manual', title: 'C', content: 'c', project: 'p', project_provenance: { source: 'raro' } }), code('invalid_project_provenance'));
  assert.equal(Number(store.db.get('SELECT COUNT(*) AS n FROM observations').n), 2);
});

test('las sesiones guardan la evidencia solo al crearse', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'p', '/d', 'shared', prov('git_remote'));
  assert.equal(captureProjectProvenance(store, 'session', 's1').source, 'git_remote');
  createSession(store, 's1', 'p', '/d', 'shared', prov('config'));
  assert.equal(captureProjectProvenance(store, 'session', 's1').source, 'git_remote');
  assert.throws(() => createSession(store, 's2', 'p', '/d', 'shared', { source: 'raro' }), code('invalid_project_provenance'));
  assert.equal(Number(store.db.get("SELECT COUNT(*) AS n FROM sessions WHERE id = 's2'").n), 0);
});

test('la sesión de reserva conserva la evidencia', (t) => {
  const store = openTempStore(t);
  const id = resolveManualSession(store, 'proy', '/d', prov('dir_basename'));
  assert.equal(id, 'manual-save-proy');
  assert.equal(captureProjectProvenance(store, 'session', id).source, 'dir_basename');
  // otro proyecto dueño de la sesión: se usa la sesión derivada, también con evidencia
  createSession(store, 'manual-save-otro', 'ajeno', '/d', 'project_owned');
  const fallback = resolveManualSession(store, 'otro', '/d', prov('config'));
  assert.match(fallback, /^manual-fallback-[0-9a-f]{64}$/);
  assert.equal(captureProjectProvenance(store, 'session', fallback).source, 'config');
});

test('registerSessionWithProvenance: sesión nueva con evidencia, aislada y continuación', (t) => {
  const store = openTempStore(t);
  assert.equal(registerSessionWithProvenance(store, { id: 'r1', project: 'p', directory: '/d', provenance: prov('git_root') }), 'r1');
  assert.equal(captureProjectProvenance(store, 'session', 'r1').source, 'git_root');
  assert.equal(registerSessionWithProvenance(store, { id: 'r1', project: 'p', directory: '/d', provenance: prov('config') }), 'r1'); // renovación: no reetiqueta
  assert.equal(captureProjectProvenance(store, 'session', 'r1').source, 'git_root');
  const isolated = registerSessionWithProvenance(store, { id: 'iso', project: 'p', directory: '/ignorado', mode: 'shared', isolated: true, provenance: prov('config') });
  assert.equal(isolated, 'iso');
  const row = store.db.get("SELECT directory, ownership_mode FROM sessions WHERE id = 'iso'");
  assert.deepEqual({ ...row }, { directory: '', ownership_mode: 'project_owned' });
  assert.throws(() => registerSessionWithProvenance(store, { id: 'x', project: 'p', provenance: { source: 'raro' } }), code('invalid_project_provenance'));
  startSession(store, 'plain', 'p', '/d'); // sin evidencia
  assert.equal(captureProjectProvenance(store, 'session', 'plain'), null);
});

test('prompts: addPromptIfMissing evita repetidos y guarda evidencia; capturePromptForSave aplica la política', (t) => {
  const store = openTempStore(t);
  createSession(store, 's', 'p', '/d');
  const a = addPromptIfMissing(store, { session_id: 's', content: 'haz esto', project: 'p', project_provenance: prov('config') });
  assert.equal(a.inserted, true);
  assert.equal(captureProjectProvenance(store, 'prompt', a.id).source, 'config');
  const b = addPromptIfMissing(store, { session_id: 's', content: 'haz esto', project: 'p' });
  assert.deepEqual(b, { id: a.id, inserted: false });
  const c = addPromptIfMissing(store, { session_id: 's', content: 'haz otra cosa', project: 'p' });
  assert.equal(c.inserted, true);
  assert.throws(() => addPromptIfMissing(store, { session_id: 's', content: '   ', project: 'p' }), code('prompt_content_required'));

  capturePromptForSave(store, false, { session_id: 's', content: 'nuevo', project: 'p' });
  capturePromptForSave(store, undefined, { session_id: 's', content: '  ', project: 'p' });
  assert.equal(Number(store.db.get("SELECT COUNT(*) AS n FROM user_prompts WHERE content = 'nuevo'").n), 0);
  capturePromptForSave(store, undefined, { session_id: 's', content: 'nuevo', project: 'p' });
  capturePromptForSave(store, true, { session_id: 's', content: 'nuevo', project: 'p' });
  assert.equal(Number(store.db.get("SELECT COUNT(*) AS n FROM user_prompts WHERE content = 'nuevo'").n), 1);

  const d = addPrompt(store, { session_id: 's', content: 'con addPrompt', project: 'p', project_provenance: prov('request_body') });
  assert.equal(captureProjectProvenance(store, 'prompt', d.id).source, 'request_body');
  assert.throws(() => addPrompt(store, { session_id: 's', content: 'x', project: 'p', project_provenance: { source: 'raro' } }), code('invalid_project_provenance'));
});

test('la captura pasiva valida y propaga la evidencia a cada observación', (t) => {
  const store = openTempStore(t);
  createSession(store, 's', 'p', '/d');
  const text = '## Key Learnings:\n\n1. Aprendimos que el índice trigram acelera las búsquedas\n2. Los tests deben aislar el directorio de datos';
  assert.throws(() => passiveCapture(store, { session_id: 's', content: text, project: 'p', project_provenance: { source: 'raro' } }), code('invalid_project_provenance'));
  const r = passiveCapture(store, { session_id: 's', content: text, project: 'p', source: 'x', project_provenance: prov('config') });
  assert.equal(r.saved, 2);
  const ids = store.db.all('SELECT id FROM observations').map((row) => Number(row.id));
  for (const id of ids) assert.equal(captureProjectProvenance(store, 'observation', id).source, 'config');
});

test('contentTruncation informa de bytes originales, límite y truncamiento', (t) => {
  const store = openTempStore(t, { maxObservationLength: 10 });
  assert.deepEqual(contentTruncation(store, 'corto'), { original_bytes: 5, limit_bytes: 10, truncated: false });
  assert.deepEqual(contentTruncation(store, 'ñ'.repeat(8)), { original_bytes: 16, limit_bytes: 10, truncated: true });
  assert.deepEqual(contentTruncation(store, 'a<private>secreto</private>b'), { original_bytes: 'a[REDACTED]b'.length, limit_bytes: 10, truncated: true });
});
