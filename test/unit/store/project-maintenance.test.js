import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESERVED_INBOX_PROJECT_NAME, addObservation, addPrompt, createSession, deleteObservation, deleteProject, getObservation,
  listProjectNames, mergeExplicitProjectVariants, mergeProjects, migrateProject, previewExplicitProjectMerge, pruneProject,
  stats,
} from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const code = (c) => (err) => err.code === c;

/** Inserta filas con un nombre de proyecto exacto (variantes heredadas que la API normalizaría). */
function legacy(store, project, n = 1) {
  const session = `legacy-${project}`;
  store.db.run('INSERT OR IGNORE INTO sessions (id, project, directory) VALUES (?, ?, ?)', session, project, '/d');
  for (let i = 0; i < n; i++) {
    store.db.run(
      "INSERT INTO observations (sync_id, session_id, type, title, content, project) VALUES (?, ?, 'manual', ?, 'c', ?)",
      `obs-${project}-${i}`, session, `t${i}`, project,
    );
  }
  store.db.run("INSERT INTO user_prompts (sync_id, session_id, content, project) VALUES (?, ?, 'p', ?)", `prompt-${project}`, session, project);
  return session;
}
const counts = (store, project) => ({
  o: Number(store.db.get('SELECT COUNT(*) AS n FROM observations WHERE project = ?', project).n),
  s: Number(store.db.get('SELECT COUNT(*) AS n FROM sessions WHERE project = ?', project).n),
  p: Number(store.db.get('SELECT COUNT(*) AS n FROM user_prompts WHERE project = ?', project).n),
});

test('migrateProject renombra observaciones, sesiones y prompts', (t) => {
  const store = openTempStore(t);
  legacy(store, 'viejo', 3);
  legacy(store, 'otro', 1);
  const res = migrateProject(store, 'viejo', 'Nuevo--Nombre');
  assert.deepEqual(res, { migrated: true, observations_updated: 3, sessions_updated: 1, prompts_updated: 1 });
  assert.deepEqual(counts(store, 'viejo'), { o: 0, s: 0, p: 0 });
  assert.deepEqual(counts(store, 'nuevo-nombre'), { o: 3, s: 1, p: 1 });
  assert.deepEqual(counts(store, 'otro'), { o: 1, s: 1, p: 1 });
});

test('migrateProject no hace nada con nombres vacíos, iguales o inexistentes', (t) => {
  const store = openTempStore(t);
  legacy(store, 'a', 1);
  const none = { migrated: false, observations_updated: 0, sessions_updated: 0, prompts_updated: 0 };
  assert.deepEqual(migrateProject(store, '', 'b'), none);
  assert.deepEqual(migrateProject(store, 'a', ''), none);
  assert.deepEqual(migrateProject(store, 'a', 'A'), none); // se normaliza a 'a'
  assert.deepEqual(migrateProject(store, 'fantasma', 'b'), none);
  assert.deepEqual(counts(store, 'a'), { o: 1, s: 1, p: 1 });
});

test('migrateProject reescribe el proyecto de las mutaciones pendientes', (t) => {
  const store = openTempStore(t);
  legacy(store, 'viejo', 1);
  const insert = (key, project, payloadProject, acked) =>
    store.db.run(
      "INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, acked_at) VALUES ('cloud', 'observation', ?, 'upsert', ?, ?, ?)",
      key, JSON.stringify({ sync_id: key, project: payloadProject }), project, acked,
    );
  insert('pendiente', 'viejo', 'viejo', null);
  insert('solo-payload', '', 'viejo', null);
  insert('confirmada', 'viejo', 'viejo', '2026-01-01 00:00:00');
  insert('ajena', 'otro', 'otro', null);
  migrateProject(store, 'viejo', 'nuevo');
  const row = (key) => store.db.get('SELECT project, payload FROM sync_mutations WHERE entity_key = ?', key);
  assert.deepEqual([row('pendiente').project, JSON.parse(row('pendiente').payload).project], ['nuevo', 'nuevo']);
  assert.deepEqual([row('solo-payload').project, JSON.parse(row('solo-payload').payload).project], ['nuevo', 'nuevo']);
  assert.deepEqual([row('confirmada').project, JSON.parse(row('confirmada').payload).project], ['viejo', 'viejo']); // ya enviada: intacta
  assert.deepEqual([row('ajena').project, JSON.parse(row('ajena').payload).project], ['otro', 'otro']);
});

test('migrar un proyecto inscrito mueve también su inscripción', (t) => {
  const store = openTempStore(t);
  legacy(store, 'viejo', 2);
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('viejo')");
  migrateProject(store, 'viejo', 'nuevo');
  assert.deepEqual(counts(store, 'viejo'), { o: 0, s: 0, p: 0 });
  assert.deepEqual(counts(store, 'nuevo'), { o: 2, s: 1, p: 1 });
  assert.deepEqual(store.db.all('SELECT project FROM sync_enrolled_projects').map((r) => r.project), ['nuevo']);
});

test('mergeProjects fusiona variantes heredadas que normalizan al canónico', (t) => {
  const store = openTempStore(t);
  legacy(store, 'My-App', 2);
  legacy(store, 'MY-APP', 1);
  legacy(store, 'my-app', 1);
  const res = mergeProjects(store, ['My-App', 'MY-APP', 'My-App', 'my-app'], 'My-App');
  assert.deepEqual(res, {
    canonical: 'my-app', sources_merged: ['My-App', 'MY-APP'], observations_updated: 3, sessions_updated: 2, prompts_updated: 2,
  });
  assert.deepEqual(counts(store, 'my-app'), { o: 4, s: 3, p: 3 });
  assert.deepEqual(counts(store, 'My-App'), { o: 0, s: 0, p: 0 });
  assert.deepEqual(listProjectNames(store), ['my-app']);
});

test('mergeProjects valida canónico y orígenes', (t) => {
  const store = openTempStore(t);
  legacy(store, 'My-App', 1);
  assert.throws(() => mergeProjects(store, ['My-App'], ''), /canonical project name must not be empty/);
  assert.throws(() => mergeProjects(store, ['My-App'], RESERVED_INBOX_PROJECT_NAME), /reserved inbox project/);
  assert.throws(() => mergeProjects(store, [''], 'my-app'), /source project name must not be empty/);
  assert.throws(() => mergeProjects(store, ['otra'], 'my-app'), /must normalize to canonical project "my-app"$/);
  assert.throws(() => mergeProjects(store, ['my_app'], 'my-app'), code('invalid_project_merge')); // el modo normal no admite separadores
  assert.deepEqual(counts(store, 'My-App'), { o: 1, s: 1, p: 1 }); // nada cambió
  assert.deepEqual(mergeProjects(store, [], 'my-app'), { canonical: 'my-app', sources_merged: [], observations_updated: 0, sessions_updated: 0, prompts_updated: 0 });
});

test('mergeExplicitProjectVariants admite variantes de separador y exige que existan', (t) => {
  const store = openTempStore(t);
  legacy(store, 'my_app', 2);
  legacy(store, 'myapp', 1);
  legacy(store, 'my-app', 1);
  const res = mergeExplicitProjectVariants(store, ['my_app', 'myapp'], 'my-app');
  assert.deepEqual(res, { canonical: 'my-app', sources_merged: ['my_app', 'myapp'], observations_updated: 3, sessions_updated: 2, prompts_updated: 2 });
  assert.deepEqual(counts(store, 'my-app'), { o: 4, s: 3, p: 3 });
  assert.throws(() => mergeExplicitProjectVariants(store, ['my_app'], 'my-app'), /source project "my_app" does not exist/); // ya fusionado
  assert.throws(() => mergeExplicitProjectVariants(store, ['otra_cosa'], 'my-app'), /or differ only by corresponding '-' and '_' separators/);
});

test('previewExplicitProjectMerge cuenta lo que cambiaría y valida', (t) => {
  const store = openTempStore(t);
  legacy(store, 'my_app', 2);
  assert.deepEqual(previewExplicitProjectMerge(store, 'my_app', 'my-app'), {
    canonical: 'my-app', source: 'my_app', observations_updated: 2, sessions_updated: 1, prompts_updated: 1, sync_identity_changes: false,
  });
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('my_app')");
  assert.equal(previewExplicitProjectMerge(store, 'my_app', 'my-app').sync_identity_changes, true);
  assert.throws(() => previewExplicitProjectMerge(store, 'my-app', 'my-app'), /must be a distinct legacy case/);
  assert.throws(() => previewExplicitProjectMerge(store, 'nada_x', 'nada-x'), /does not exist/);
  assert.throws(() => previewExplicitProjectMerge(store, 'inbox_', 'inbox'), /reserved inbox project/);
  assert.throws(() => previewExplicitProjectMerge(store, 'zzz', 'my-app'), /must be a distinct legacy case/);
});

test('fusionar hacia un proyecto inscrito conserva su inscripción', (t) => {
  const store = openTempStore(t);
  legacy(store, 'my_app', 1);
  legacy(store, 'my-app', 1);
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('my-app')");
  mergeExplicitProjectVariants(store, ['my_app'], 'my-app');
  assert.deepEqual(counts(store, 'my_app'), { o: 0, s: 0, p: 0 });
  assert.deepEqual(counts(store, 'my-app'), { o: 2, s: 2, p: 2 });
  assert.deepEqual(store.db.all('SELECT project FROM sync_enrolled_projects').map((r) => r.project), ['my-app']);
});

test('pruneProject borra prompts y sesiones vacías de un proyecto sin observaciones vivas', (t) => {
  const store = openTempStore(t);
  createSession(store, 's-vacia', 'poda', '/d');
  createSession(store, 's-con-borrada', 'poda', '/d');
  const id = addObservation(store, { session_id: 's-con-borrada', type: 'manual', title: 't', content: 'c' }).id;
  deleteObservation(store, id); // borrada: no cuenta como viva, pero la sesión sigue teniendo una fila
  addPrompt(store, { session_id: 's-vacia', content: 'un prompt' });
  const res = pruneProject(store, 'poda');
  assert.deepEqual(res, { project: 'poda', sessions_deleted: 1, prompts_deleted: 1 });
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sessions WHERE id = 's-con-borrada'").n, 1);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sessions WHERE id = 's-vacia'").n, 0);
});

test('pruneProject se niega si quedan observaciones vivas y valida el nombre', (t) => {
  const store = openTempStore(t);
  createSession(store, 's', 'activo', '/d');
  addObservation(store, { session_id: 's', type: 'manual', title: 't', content: 'c' });
  assert.throws(() => pruneProject(store, 'activo'), (err) => err.code === 'project_prune_blocked' && /project "activo" still has 1 observations — cannot prune/.test(err.message));
  assert.throws(() => pruneProject(store, ''), code('project_name_required'));
  assert.equal(stats(store).total_sessions, 1);
});

test('deleteProject suave marca las observaciones y borra los prompts, pero conserva las sesiones', (t) => {
  const store = openTempStore(t);
  createSession(store, 's', 'borrar', '/d');
  addObservation(store, { session_id: 's', type: 'manual', title: 'a', content: '1' });
  addObservation(store, { session_id: 's', type: 'manual', title: 'b', content: '2' });
  addPrompt(store, { session_id: 's', content: 'p' });
  const res = deleteProject(store, '  borrar ');
  assert.deepEqual(res, { project: 'borrar', observations_deleted: 2, prompts_deleted: 1, sessions_deleted: 0, hard_delete: false });
  assert.equal(getObservation(store, 1), null);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sessions WHERE project = 'borrar'").n, 1);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_delete_tombstones WHERE entity = 'project'").n, 0);
  assert.deepEqual(deleteProject(store, 'borrar').observations_deleted, 0); // ya no hay vivas, pero el proyecto existe
});

test('deleteProject duro elimina todo, deja huérfanas las relaciones y registra la lápida', (t) => {
  const store = openTempStore(t);
  createSession(store, 's', 'borrar', '/d');
  createSession(store, 's2', 'borrar', '/d');
  const a = addObservation(store, { session_id: 's', type: 'manual', title: 'a', content: '1' }).id;
  addPrompt(store, { session_id: 's', content: 'p' });
  store.db.run("INSERT INTO memory_relations (sync_id, source_id, target_id) VALUES ('rel-1', ?, 'obs-externa')", getObservation(store, a).sync_id);
  const res = deleteProject(store, 'borrar', true);
  assert.deepEqual(res, { project: 'borrar', observations_deleted: 1, prompts_deleted: 1, sessions_deleted: 2, hard_delete: true });
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM observations').n, 0);
  assert.equal(store.db.get("SELECT judgment_status FROM memory_relations WHERE sync_id = 'rel-1'").judgment_status, 'orphaned');
  const tomb = store.db.get("SELECT * FROM sync_delete_tombstones WHERE entity = 'project'");
  assert.deepEqual([tomb.entity_key, tomb.project, tomb.session_id, tomb.hard_delete, tomb.active], ['borrar', 'borrar', null, 1, 1]);
});

test('deleteProject valida el nombre y que el proyecto exista', (t) => {
  const store = openTempStore(t);
  assert.throws(() => deleteProject(store, '   '), code('project_name_required'));
  assert.throws(() => deleteProject(store, 'inexistente'), (err) => err.code === 'project_not_found' && err.message === 'project not found: "inexistente"');
});
