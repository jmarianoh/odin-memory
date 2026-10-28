import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  SessionProjectConflictError, activeRuntimeSessions, addObservation, continuationSession, createSession, endRuntimeSession,
  endSession, finalizeSession, getObservation, getSession, registerIsolatedSession, resolveRuntimeSession, resumeSession,
  startSession,
} from '../../../src/store/index.js';
import { runtimeWorktreeDirectory } from '../../../src/project/worktree.js';
import { openTempStore, tempDir } from './helpers.js';

const code = (c) => (err) => err.code === c;
const minutesFromNow = (iso) => (Date.parse(`${iso.replace(' ', 'T')}Z`) - Date.now()) / 60_000;

test('startSession registra con concesión de 30 minutos y la renueva', (t) => {
  const store = openTempStore(t);
  startSession(store, 'host-1', 'Mi--Proyecto', '/work/app');
  let s = getSession(store, 'host-1');
  assert.deepEqual([s.project, s.directory, s.ownership_mode, s.ended_at], ['mi-proyecto', '/work/app', 'shared', null]);
  assert.ok(Math.abs(minutesFromNow(s.runtime_lease_expires_at) - 30) < 1);
  store.db.run("UPDATE sessions SET runtime_lease_expires_at = datetime('now', '+1 minutes') WHERE id = 'host-1'");
  startSession(store, 'host-1', 'mi-proyecto', '/work/app');
  s = getSession(store, 'host-1');
  assert.ok(minutesFromNow(s.runtime_lease_expires_at) > 25);
  assert.equal(store.db.get("SELECT local_creation_project FROM sessions WHERE id = 'host-1'").local_creation_project, 'mi-proyecto');
});

test('startSession valida y respeta sesiones terminadas y la propiedad', (t) => {
  const store = openTempStore(t);
  assert.throws(() => startSession(store, ' ', 'p', '/d'), code('session_id_required'));
  assert.throws(() => startSession(store, 's', '  ', '/d'), code('project_required'));
  assert.throws(() => startSession(store, 's', 'p', '/d', 'raro'), code('invalid_session_ownership_mode'));
  startSession(store, 's', 'p', '/d', 'project_owned');
  assert.throws(() => startSession(store, 's', 'otro', '/d', 'project_owned'), (e) => e instanceof SessionProjectConflictError);
  endSession(store, 's', 'fin');
  assert.throws(() => startSession(store, 's', 'p', '/d', 'project_owned'), code('session_already_ended'));
  assert.ok(getSession(store, 's').ended_at); // no se reabre
});

test('continuationSession: viva, terminada, ordinales y sufijos no numéricos', (t) => {
  const { db } = openTempStore(t);
  const add = (id, ended) => db.run("INSERT INTO sessions (id, project, directory, ended_at) VALUES (?, 'p', '/d', ?)", id, ended ? '2026-01-01 00:00:00' : null);
  assert.equal(continuationSession(db, 'raiz'), 'raiz'); // no existe
  add('raiz', false);
  assert.equal(continuationSession(db, 'raiz'), 'raiz'); // viva
  db.run("UPDATE sessions SET ended_at = '2026-01-01 00:00:00' WHERE id = 'raiz'");
  assert.equal(continuationSession(db, 'raiz'), 'raiz:resume:2'); // primera continuación
  add('raiz:resume:2', true);
  add('raiz:resume:x', false); // sufijo no numérico: se ignora
  add('raiz:resume:', false);
  add('raiz:resume:7', true);
  assert.equal(continuationSession(db, 'raiz'), 'raiz:resume:8'); // mayor ordinal + 1
  add('raiz:resume:5', false);
  add('raiz:resume:3', false);
  assert.equal(continuationSession(db, 'raiz'), 'raiz:resume:3'); // viva de menor ordinal
  db.run("UPDATE sessions SET ended_at = '2026-01-01 00:00:00' WHERE id IN ('raiz:resume:3', 'raiz:resume:5')");
  add('raiz:resume:99999999999999999999', true);
  assert.equal(continuationSession(db, 'raiz'), 'raiz:resume:100000000000000000000'); // sin desbordamiento
});

test('resumeSession: raíz viva, terminada y continuaciones sucesivas', (t) => {
  const store = openTempStore(t);
  assert.equal(resumeSession(store, 'r', 'p', '/work/a'), 'r'); // nueva
  assert.equal(resumeSession(store, 'r', 'p', '/work/a'), 'r'); // viva: se reutiliza
  endSession(store, 'r', 'uno');
  const second = resumeSession(store, 'r', 'p', '/work/a');
  assert.equal(second, 'r:resume:2');
  assert.equal(resumeSession(store, 'r', 'p', '/work/a'), 'r:resume:2'); // viva
  endSession(store, 'r:resume:2');
  assert.equal(resumeSession(store, 'r', 'p', '/work/a'), 'r:resume:3');
  assert.equal(getSession(store, 'r:resume:3').directory, '/work/a');
});

test('la continuación hereda proyecto, directorio y política de la sesión raíz', (t) => {
  const store = openTempStore(t);
  startSession(store, 'r', 'dueño', '/work/real', 'project_owned');
  endSession(store, 'r');
  assert.equal(resumeSession(store, 'r', 'dueño', '/otro/lugar', 'project_owned'), 'r:resume:2');
  const s = getSession(store, 'r:resume:2');
  assert.deepEqual([s.project, s.directory, s.ownership_mode], ['dueño', '/work/real', 'project_owned']); // no los pedidos
  // otro proyecto sobre una raíz terminada project_owned: conflicto
  assert.throws(() => resumeSession(store, 'r', 'intruso', '/work/real', 'project_owned'), (e) => e instanceof SessionProjectConflictError && e.ownerProject === 'dueño');
});

test('reclamar una sesión terminada sin dueño asigna la propiedad pero informa que ya terminó', (t) => {
  const store = openTempStore(t);
  store.db.run("INSERT INTO sessions (id, project, directory, ended_at) VALUES ('vieja', '', '/d', '2026-01-01 00:00:00')");
  assert.throws(() => startSession(store, 'vieja', 'nuevo-dueño', '/d', 'project_owned'), code('session_already_ended'));
  const s = getSession(store, 'vieja');
  assert.deepEqual([s.project, s.ownership_mode], ['nuevo-dueño', 'project_owned']); // la reclamación se confirmó
  // con registros de otro proyecto no se puede reclamar
  store.db.run("INSERT INTO sessions (id, project, directory, ended_at) VALUES ('mixta', '', '/d', '2026-01-01 00:00:00')");
  store.db.run("INSERT INTO observations (session_id, type, title, content, project) VALUES ('mixta', 't', 'x', 'y', 'ajeno')");
  assert.throws(() => startSession(store, 'mixta', 'otro', '/d', 'project_owned'), (e) => e instanceof SessionProjectConflictError && e.ownerProject === 'ajeno');
  assert.equal(getSession(store, 'mixta').project, '');
});

test('registerIsolatedSession: sin directorio, project_owned y con reglas de aislamiento', (t) => {
  const store = openTempStore(t);
  assert.equal(registerIsolatedSession(store, 'aislada', 'proy'), 'aislada');
  const s = getSession(store, 'aislada');
  assert.deepEqual([s.directory, s.ownership_mode, s.project], ['', 'project_owned', 'proy']);
  assert.equal(registerIsolatedSession(store, 'aislada', 'proy'), 'aislada'); // idempotente
  startSession(store, 'con-dir', 'proy', '/work/x', 'project_owned');
  assert.throws(() => registerIsolatedSession(store, 'con-dir', 'proy'), code('session_isolation_conflict'));
  store.db.run("INSERT INTO sessions (id, project, directory, ownership_mode) VALUES ('compartida', 'proy', '', 'shared')");
  assert.throws(() => registerIsolatedSession(store, 'compartida', 'proy'), (e) => e.code === 'session_isolation_conflict' && /has shared ownership/.test(e.message));
  // reanudación aislada
  endSession(store, 'aislada');
  assert.equal(registerIsolatedSession(store, 'aislada', 'proy', true), 'aislada:resume:2');
  assert.equal(getSession(store, 'aislada:resume:2').directory, '');
});

function runtimeFixture(t) {
  const store = openTempStore(t);
  const base = realpathSync(tempDir(t));
  const dirA = join(base, 'a');
  const dirB = join(base, 'b');
  mkdirSync(dirA);
  mkdirSync(dirB);
  return { store, dirA, dirB };
}

test('resolveRuntimeSession valida proyecto, política y árbol de trabajo', (t) => {
  const { store, dirA, dirB } = runtimeFixture(t);
  startSession(store, 'h', 'proy', dirA, 'shared');
  assert.equal(resolveRuntimeSession(store, 'h', 'proy', dirA, 'shared'), 'h');
  assert.throws(() => resolveRuntimeSession(store, 'h', 'proy', dirB, 'shared'), code('runtime_session_scope_conflict'));
  assert.throws(() => resolveRuntimeSession(store, 'h', 'proy', dirA, 'project_owned'), code('runtime_session_scope_conflict'));
  assert.throws(() => resolveRuntimeSession(store, 'h', 'proy', '', 'shared'), code('runtime_session_scope_conflict'));
  assert.throws(() => resolveRuntimeSession(store, 'nada', 'proy', dirA, 'shared'), code('session_not_found'));
  assert.throws(() => resolveRuntimeSession(store, 'h', '', dirA, 'shared'), code('project_required'));
  assert.throws(() => resolveRuntimeSession(store, 'h', 'proy', dirA, 'raro'), code('invalid_session_ownership_mode'));
  // una sesión terminada sin continuación viva no se resuelve
  endSession(store, 'h');
  assert.throws(() => resolveRuntimeSession(store, 'h', 'proy', dirA, 'shared'), code('session_not_found'));
});

test('endRuntimeSession cierra la sesión viva con su resumen', (t) => {
  const { store, dirA } = runtimeFixture(t);
  startSession(store, 'h', 'proy', dirA, 'shared');
  assert.equal(endRuntimeSession(store, 'h', 'proy', dirA, 'shared', 'terminado'), 'h');
  const s = getSession(store, 'h');
  assert.ok(s.ended_at);
  assert.equal(s.summary, 'terminado');
  // la continuación viva es la que se cierra
  const next = resumeSession(store, 'h', 'proy', dirA, 'shared');
  assert.equal(next, 'h:resume:2');
  assert.equal(endRuntimeSession(store, 'h', 'proy', dirA, 'shared'), 'h:resume:2');
  assert.equal(getSession(store, 'h:resume:2').summary, null);
});

test('runtimeWorktreeDirectory usa la raíz de git y trata igual los subdirectorios', (t) => {
  const repo = realpathSync(tempDir(t));
  execFileSync('git', ['init', '-q', repo]);
  const sub = join(repo, 'src', 'modulo');
  mkdirSync(sub, { recursive: true });
  assert.equal(runtimeWorktreeDirectory(sub), repo);
  assert.equal(runtimeWorktreeDirectory(repo), repo);
  const outside = realpathSync(tempDir(t));
  assert.equal(runtimeWorktreeDirectory(outside), outside);
  // misma sesión registrada desde un subdirectorio se resuelve desde la raíz
  const store = openTempStore(t);
  startSession(store, 'h', 'proy', sub, 'shared');
  assert.equal(resolveRuntimeSession(store, 'h', 'proy', repo, 'shared'), 'h');
});

test('activeRuntimeSessions: concesión vigente, actividad reciente y exclusiones', (t) => {
  const store = openTempStore(t);
  const lease = (id, dir, leaseSql, extra = '') => {
    store.db.run(`INSERT INTO sessions (id, project, directory, runtime_lease_expires_at, started_at ${extra ? ', ended_at' : ''}) VALUES (?, 'proy', ?, ${leaseSql}, datetime('now', '-8 days') ${extra ? `, ${extra}` : ''})`, id, dir);
  };
  lease('con-concesion', '/d1', "datetime('now', '+10 minutes')");
  lease('concesion-vencida', '/d2', "datetime('now', '-10 minutes')");
  lease('terminada', '/d1', "datetime('now', '+10 minutes')", "'2026-01-01 00:00:00'");
  lease('manual-save-proy', '/d1', "datetime('now', '+10 minutes')");
  lease('manual-fallback-abc', '/d1', "datetime('now', '+10 minutes')");
  store.db.run("INSERT INTO sessions (id, project, directory, started_at) VALUES ('reciente-sin-concesion', 'proy', '/d3', datetime('now', '-2 days'))");
  store.db.run("INSERT INTO sessions (id, project, directory, started_at) VALUES ('antigua-sin-concesion', 'proy', '/d3', datetime('now', '-9 days'))");
  store.db.run("INSERT INTO sessions (id, project, directory, started_at) VALUES ('rival-sin-concesion', 'proy', '/d1', datetime('now', '-1 days'))");
  store.db.run("INSERT INTO sessions (id, project, directory, started_at) VALUES ('otro-proyecto', 'otro', '/d3', datetime('now', '-1 days'))");

  assert.deepEqual(activeRuntimeSessions(store, 'PROY', '/d1'), ['con-concesion']); // la sin concesión pierde ante la concesionaria del mismo directorio
  assert.deepEqual(activeRuntimeSessions(store, 'proy', '/d3'), ['reciente-sin-concesion']); // 2 días sí, 9 no
  assert.deepEqual(activeRuntimeSessions(store, 'proy', '/d2'), []); // concesión vencida y actividad antigua
  assert.deepEqual(activeRuntimeSessions(store, 'proy', '/d1', '/d3', '/d1'), ['con-concesion', 'reciente-sin-concesion']);
  assert.deepEqual(activeRuntimeSessions(store, 'proy'), []);
  assert.deepEqual(activeRuntimeSessions(store, 'proy', ''), []);
  assert.deepEqual(activeRuntimeSessions(store, '', '/d1'), []);
  // la actividad (observaciones) cuenta como reciente aunque la sesión sea antigua
  addObservation(store, { session_id: 'antigua-sin-concesion', type: 'manual', title: 't', content: 'c' });
  assert.deepEqual(activeRuntimeSessions(store, 'proy', '/d3'), ['antigua-sin-concesion', 'reciente-sin-concesion']);
});

test('finalizeSession guarda el resumen como observación, cierra la sesión y es idempotente', (t) => {
  const store = openTempStore(t);
  createSession(store, 's', 'proy', '/d');
  store.db.run("UPDATE sessions SET summary = 'resumen previo' WHERE id = 's'");
  const first = finalizeSession(store, { session_id: 's', project: 'PROY', summary: 'Hecho <private>secreto</private> y listo' });
  assert.equal(first.already_finalized, false);
  assert.match(first.summary_sync_id, /^obs-[0-9a-f]{16}$/);
  const obs = getObservation(store, first.summary_id);
  assert.deepEqual([obs.type, obs.title, obs.content, obs.project, obs.scope, obs.review_after], ['session_summary', 'Session summary: proy', 'Hecho [REDACTED] y listo', 'proy', 'project', null]);
  const session = getSession(store, 's');
  assert.ok(session.ended_at);
  assert.equal(session.summary, 'resumen previo'); // conserva el resumen previo de la sesión
  assert.equal(store.db.get('SELECT summary_id FROM session_finalizations WHERE session_id = ?', 's').summary_id, first.summary_id);
  assert.deepEqual(finalizeSession(store, { session_id: 's', project: 'proy', summary: 'otro texto' }), { ...first, already_finalized: true });
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM observations').n, 1);
});

test('finalizeSession valida sesión, propiedad y contenido', (t) => {
  const store = openTempStore(t);
  createSession(store, 's', 'proy', '/d');
  const base = { session_id: 's', project: 'proy', summary: 'ok' };
  assert.throws(() => finalizeSession(store, { ...base, session_id: ' ' }), code('session_id_required'));
  assert.throws(() => finalizeSession(store, { ...base, project: ' ' }), code('project_required'));
  assert.throws(() => finalizeSession(store, { ...base, summary: '  ' }), code('observation_content_required'));
  assert.throws(() => finalizeSession(store, { ...base, session_id: 'nada' }), code('session_not_found'));
  assert.throws(() => finalizeSession(store, { ...base, project: 'otro' }), code('session_ownership_mismatch'));
  endSession(store, 's', 'terminada a mano');
  assert.throws(() => finalizeSession(store, base), code('session_already_ended'));
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM session_finalizations').n, 0);
});
