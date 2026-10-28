import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  addObservation, addPrompt, countObservationsForProject, createSession, deleteObservation, listProjectAliases,
  listProjectNames, listProjectsWithStats, projectExists, removeProjectAlias, resolveProjectAlias, setProjectAlias,
  stats, statsProject,
} from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const code = (c) => (err) => err.code === c;

function setup(t) {
  const store = openTempStore(t);
  createSession(store, 'a1', 'alfa', '/work/alfa');
  createSession(store, 'a2', 'alfa', '/work/alfa-b');
  createSession(store, 'b1', 'beta', '/work/beta');
  const obs = (session, title) => addObservation(store, { session_id: session, type: 'manual', title, content: `c ${title}` }).id;
  obs('a1', 'uno'); obs('a1', 'dos'); obs('b1', 'tres');
  addPrompt(store, { session_id: 'a1', content: 'prompt de alfa' });
  return { store, obs };
}

test('stats globales y por proyecto', (t) => {
  const { store } = setup(t);
  assert.deepEqual(
    (({ projects, ...rest }) => rest)(stats(store)),
    { total_sessions: 3, total_observations: 3, total_prompts: 1 },
  );
  assert.deepEqual(stats(store).projects.sort(), ['alfa', 'beta']);
  assert.deepEqual(statsProject(store, 'ALFA'), { total_sessions: 2, total_observations: 2, total_prompts: 1, projects: ['alfa'] });
  assert.throws(() => statsProject(store, '  '), code('project_required'));
  assert.deepEqual(statsProject(store, 'nada'), { total_sessions: 0, total_observations: 0, total_prompts: 0, projects: [] });
});

test('las observaciones borradas no cuentan en las estadísticas', (t) => {
  const { store, obs } = setup(t);
  const id = obs('b1', 'cuatro');
  assert.equal(stats(store).total_observations, 4);
  deleteObservation(store, id);
  assert.equal(stats(store).total_observations, 3);
  assert.equal(countObservationsForProject(store, 'beta'), 1);
});

test('projectExists mira observaciones vivas, sesiones, prompts y proyectos inscritos', (t) => {
  const { store } = setup(t);
  assert.equal(projectExists(store, 'alfa'), true);
  assert.equal(projectExists(store, 'desconocido'), false);
  createSession(store, 'solo-sesion', 'huerfano', '/d');
  assert.equal(projectExists(store, 'huerfano'), true);
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('inscrito')");
  assert.equal(projectExists(store, 'inscrito'), true);
});

test('listProjectNames y listProjectsWithStats', (t) => {
  const { store } = setup(t);
  assert.deepEqual(listProjectNames(store), ['alfa', 'beta']);
  const list = listProjectsWithStats(store);
  assert.deepEqual(list.map((p) => p.name), ['alfa', 'beta']); // más observaciones primero
  const alfa = list[0];
  assert.deepEqual(
    [alfa.observation_count, alfa.session_count, alfa.prompt_count, [...alfa.directories].sort()],
    [2, 2, 1, ['/work/alfa', '/work/alfa-b']],
  );
  createSession(store, 'x', 'sin-obs', '/x');
  const sinObs = listProjectsWithStats(store).find((p) => p.name === 'sin-obs');
  assert.deepEqual([sinObs.observation_count, sinObs.session_count], [0, 1]);
});

test('alias: crear, listar, resolver con conflicto y eliminar', (t) => {
  const { store } = setup(t);
  assert.deepEqual(setProjectAlias(store, 'key', 'Mi--Repo', 'ALFA'), { kind: 'key', key: 'mi-repo', project: 'alfa' });
  assert.deepEqual(setProjectAlias(store, 'cwd', '/work/./x/../alfa/', 'alfa'), { kind: 'cwd', key: '/work/alfa', project: 'alfa' });
  setProjectAlias(store, 'key', 'mi-repo', 'beta'); // actualiza
  assert.deepEqual(listProjectAliases(store).map((a) => [a.kind, a.key, a.project]), [['cwd', '/work/alfa', 'alfa'], ['key', 'mi-repo', 'beta']]);

  assert.deepEqual(resolveProjectAlias(store, 'otro', ''), { project: 'otro', key_alias: null, cwd_alias: null, conflict: false });
  const byKey = resolveProjectAlias(store, 'Mi-Repo', '');
  assert.equal(byKey.project, 'beta');
  assert.equal(byKey.key_alias.project, 'beta');
  const byCwd = resolveProjectAlias(store, '', '/work/alfa');
  assert.equal(byCwd.project, 'alfa');
  const conflict = resolveProjectAlias(store, 'mi-repo', '/work/alfa'); // beta ≠ alfa
  assert.deepEqual([conflict.project, conflict.conflict], ['', true]);
  setProjectAlias(store, 'key', 'mi-repo', 'alfa');
  const agree = resolveProjectAlias(store, 'mi-repo', '/work/alfa');
  assert.deepEqual([agree.project, agree.conflict], ['alfa', false]);

  assert.equal(removeProjectAlias(store, 'key', 'MI-REPO'), true);
  assert.equal(removeProjectAlias(store, 'key', 'mi-repo'), false);
});

test('alias: validación de tipo, claves y rutas relativas', (t) => {
  const { store } = setup(t);
  assert.throws(() => setProjectAlias(store, 'raro', 'x', 'alfa'), code('invalid_project_alias'));
  assert.throws(() => setProjectAlias(store, 'cwd', '   ', 'alfa'), code('invalid_project_alias'));
  assert.throws(() => setProjectAlias(store, 'cwd', 'a\0b', 'alfa'), code('invalid_project_alias'));
  assert.throws(() => setProjectAlias(store, 'key', 'a/b', 'alfa'), code('invalid_project_name'));
  assert.throws(() => setProjectAlias(store, 'key', 'ok', ''), code('invalid_project_name'));
  assert.equal(setProjectAlias(store, 'cwd', 'relativa/ruta', 'alfa').key, resolve('relativa/ruta'));
});
