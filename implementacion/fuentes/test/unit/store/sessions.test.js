import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_OWNERSHIP_PROJECT_OWNED, SESSION_OWNERSHIP_SHARED, SessionProjectConflictError, addObservation,
  allSessions, createSession, endSession, getSession, recentSessions, resolveManualSession, resolveWriteProject,
} from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const code = (c) => (err) => err.code === c;

test('createSession registra la sesión con proyecto canónico y es idempotente', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'Mi--App', '/work/app');
  createSession(store, 's1', 'mi-app', ''); // no pisa lo ya establecido
  const s = getSession(store, 's1');
  assert.equal(s.project, 'mi-app');
  assert.equal(s.directory, '/work/app');
  assert.equal(s.ownership_mode, SESSION_OWNERSHIP_SHARED);
  assert.equal(s.ended_at, null);
  assert.equal(getSession(store, 'nope'), null);
});

test('createSession valida identificador, modo y proyecto', (t) => {
  const store = openTempStore(t);
  assert.throws(() => createSession(store, '  ', 'p', '/d'), code('session_id_required'));
  assert.throws(() => createSession(store, 's', 'p', '/d', 'raro'), code('invalid_session_ownership_mode'));
  assert.throws(() => createSession(store, 's', '   ', '/d'), code('project_required'));
});

test('una sesión project_owned rechaza otro proyecto', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'a', '/d', SESSION_OWNERSHIP_PROJECT_OWNED);
  assert.throws(
    () => createSession(store, 's1', 'b', '/d', SESSION_OWNERSHIP_PROJECT_OWNED),
    (err) => err instanceof SessionProjectConflictError && err.ownerProject === 'a' && err.requestedProject === 'b',
  );
  assert.throws(() => createSession(store, 's1', 'b', '/d'), code('session_ownership_mismatch'));
  createSession(store, 's1', 'a', '/d'); // el mismo proyecto sí
});

test('una sesión shared admite varios proyectos', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'a', '/d');
  createSession(store, 's1', 'b', '/d');
  assert.equal(getSession(store, 's1').project, 'a');
});

test('resolveManualSession usa manual-save-<proyecto> y recurre a un id derivado si choca', (t) => {
  const store = openTempStore(t);
  assert.equal(resolveManualSession(store, 'App', '/d'), 'manual-save-app');
  assert.equal(resolveManualSession(store, 'app', '/d'), 'manual-save-app');
  // alguien ocupa ese id para otro proyecto
  createSession(store, 'manual-save-otro', 'x', '/d', SESSION_OWNERSHIP_PROJECT_OWNED);
  const id = resolveManualSession(store, 'otro', '/d');
  assert.match(id, /^manual-fallback-[0-9a-f]{64}$/);
  assert.equal(getSession(store, id).project, 'otro');
  assert.equal(resolveManualSession(store, 'otro', '/d'), id);
});

test('endSession cierra con resumen y no falla si la sesión no existe', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'p', '/d');
  endSession(store, 's1', 'Resumen final');
  const s = getSession(store, 's1');
  assert.ok(s.ended_at);
  assert.equal(s.summary, 'Resumen final');
  endSession(store, 'fantasma', 'x');
  assert.throws(() => endSession(store, '', 'x'), code('session_id_required'));
  endSession(store, 's1'); // sin resumen lo deja en NULL
  assert.equal(getSession(store, 's1').summary, null);
});

test('recentSessions y allSessions cuentan observaciones vivas y filtran por proyecto', (t) => {
  const store = openTempStore(t);
  createSession(store, 'a1', 'alfa', '/d');
  createSession(store, 'b1', 'beta', '/d');
  addObservation(store, { session_id: 'a1', type: 'manual', title: 'uno', content: 'x' });
  addObservation(store, { session_id: 'a1', type: 'manual', title: 'dos', content: 'y' });
  const alfa = recentSessions(store, 'ALFA');
  assert.deepEqual(alfa.map((s) => [s.id, s.observation_count]), [['a1', 2]]);
  assert.equal(recentSessions(store, '').length, 2);
  assert.equal(recentSessions(store, '', 1).length, 1);
  assert.deepEqual(allSessions(store, 'beta').map((s) => s.id), ['b1']);
  assert.deepEqual(allSessions(store, 'BETA'), []); // filtro exacto
});

test('resolveWriteProject: hereda de la sesión, adopta si no tiene dueño y detecta ambigüedad', (t) => {
  const store = openTempStore(t);
  const { db } = store;
  assert.throws(() => resolveWriteProject(db, 'nueva', ''), code('project_required'));
  assert.equal(resolveWriteProject(db, 'nueva', 'Proy'), 'proy'); // sesión inexistente: se acepta lo pedido

  createSession(store, 's1', 'p', '/d');
  assert.equal(resolveWriteProject(db, 's1', ''), 'p');
  assert.equal(resolveWriteProject(db, 's1', 'otro'), 'otro'); // shared admite varios

  createSession(store, 's2', 'p', '/d', SESSION_OWNERSHIP_PROJECT_OWNED);
  assert.throws(() => resolveWriteProject(db, 's2', 'q'), code('session_ownership_mismatch'));

  db.run("INSERT INTO sessions (id, project, directory) VALUES ('huerfana', '', '/d')");
  assert.throws(() => resolveWriteProject(db, 'huerfana', ''), /carries no project ownership/);
  assert.equal(resolveWriteProject(db, 'huerfana', 'adoptante'), 'adoptante');
  assert.equal(db.get("SELECT project FROM sessions WHERE id = 'huerfana'").project, 'adoptante');

  db.run("INSERT INTO sessions (id, project, directory) VALUES ('mixta', '', '/d')");
  db.run("INSERT INTO observations (session_id, type, title, content, project) VALUES ('mixta', 't', 'x', 'y', 'duenio')");
  assert.throws(() => resolveWriteProject(db, 'mixta', 'otro'), code('project_ownership_ambiguous'));
  assert.equal(resolveWriteProject(db, 'mixta', 'duenio'), 'duenio');
});
