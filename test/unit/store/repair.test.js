import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  applySessionProjectReclassification, backupSqlite, backupSqliteUnderWriteLock, estimateSessionProjectReclassification, normalizeSessionProjectReclassifications,
  reclassifyOrphanedPendingRelations, restoreOrphanedObservationSessions,
} from '../../../src/store/repair.js';
import { addObservation, addPrompt, createSession } from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const obs = (store, session, project, title = 't') => addObservation(store, { session_id: session, type: 'manual', title, content: `c ${title}`, project }).id;
const session = (store, id) => { const row = store.db.get('SELECT id, project, ownership_mode, directory, started_at, ended_at, summary FROM sessions WHERE id = ?', id); return row && { ...row }; };

test('la copia de seguridad es privada, nombrada con la marca de tiempo y contiene los datos', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  obs(store, 's1', 'demo');
  const path = backupSqlite(store);
  assert.match(path, /\/backups\/odin-repair-\d{8}T\d{6}\.\d{3}000000Z\.db$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(path.replace(/\/[^/]+$/, '')).mode & 0o777, 0o700);
  const copy = new DatabaseSync(path, { readOnly: true });
  assert.equal(copy.prepare('SELECT count(*) AS n FROM observations').get().n, 1);
  copy.close();
});

test('la copia bajo el bloqueo de escritura ve el último estado confirmado', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  obs(store, 's1', 'demo', 'antes');
  let path;
  store.db.writeTransaction((db) => {
    db.run("INSERT INTO sessions (id, project, directory, started_at) VALUES ('sin-confirmar', 'demo', '/y', '2026-01-01 00:00:00')");
    path = backupSqliteUnderWriteLock(store);
  });
  const copy = new DatabaseSync(path, { readOnly: true });
  assert.equal(copy.prepare('SELECT count(*) AS n FROM observations').get().n, 1);
  assert.equal(copy.prepare("SELECT count(*) AS n FROM sessions WHERE id = 'sin-confirmar'").get().n, 0, 'lo no confirmado no entra en la copia');
  copy.close();
  assert.ok(session(store, 'sin-confirmar'));
});

test('dos copias seguidas no comparten archivo', (t) => {
  const store = openTempStore(t);
  const a = backupSqlite(store);
  const b = backupSqlite(store);
  assert.notEqual(a, b);
  assert.ok(existsSync(a) && existsSync(b));
});

test('restoreOrphanedObservationSessions repone la sesión con datos derivados de las observaciones actuales', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  const a = obs(store, 's1', 'demo', 'a');
  const b = obs(store, 's1', 'demo', 'b');
  store.db.run('PRAGMA foreign_keys = OFF');
  store.db.run("UPDATE observations SET session_id = 'perdida', created_at = '2026-02-02 02:02:02' WHERE id = ?", a);
  store.db.run("UPDATE observations SET session_id = 'perdida', created_at = '2026-01-01 01:01:01' WHERE id = ?", b);
  // Los datos del plan están anticuados a propósito: manda lo que hay en la base.
  const applied = restoreOrphanedObservationSessions(store, [{ session_id: 'perdida', project: ' DEMO ', observation_count: 99, started_at: '1999-01-01 00:00:00' }]);
  assert.deepEqual(applied, [{ session_id: 'perdida', project: 'demo', observation_count: 2, started_at: '2026-01-01 01:01:01' }]);
  assert.deepEqual(session(store, 'perdida'), {
    id: 'perdida', project: 'demo', ownership_mode: 'project_owned', directory: '', started_at: '2026-01-01 01:01:01', ended_at: '2026-01-01 01:01:01', summary: 'Recovered local placeholder for orphaned observations.',
  });
  assert.equal(store.db.get("SELECT count(*) AS n FROM sync_mutations WHERE entity = 'session'").n, 0, 'no emite mutaciones de sincronización');
  assert.deepEqual(restoreOrphanedObservationSessions(store, [{ session_id: 'perdida', project: 'demo', started_at: 'x' }]), [], 'repetir es una operación nula');
});

test('restoreOrphanedObservationSessions rechaza lo que no puede probar y no deja cambios', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  createSession(store, 'ajena', 'otro', '/y');
  const a = obs(store, 's1', 'demo');
  const b = obs(store, 's1', 'otro', 'otra');
  store.db.run('PRAGMA foreign_keys = OFF');
  store.db.run("UPDATE observations SET session_id = 'mixta' WHERE id IN (?, ?)", a, b);
  const act = (over) => [{ session_id: 'mixta', project: 'demo', started_at: '2026-01-01 00:00:00', ...over }];
  assert.throws(() => restoreOrphanedObservationSessions(store, act({ session_id: ' ' })), { code: 'session_id_required' });
  assert.throws(() => restoreOrphanedObservationSessions(store, act({ project: '  ' })), { message: 'orphaned session placeholder requires project and first observation timestamp' });
  assert.throws(() => restoreOrphanedObservationSessions(store, act({ started_at: ' ' })), { message: 'orphaned session placeholder requires project and first observation timestamp' });
  assert.throws(() => restoreOrphanedObservationSessions(store, act({})), { message: 'orphaned session "mixta" is referenced by multiple projects' });
  assert.throws(() => restoreOrphanedObservationSessions(store, act({ session_id: 'nada' })), { message: 'orphaned session "nada" has no supporting observations' });
  assert.throws(() => restoreOrphanedObservationSessions(store, act({ session_id: 's1' }).map((x) => ({ ...x, project: 'otro' }))), { message: 'orphaned session "s1" already belongs to project "demo", not "otro"' });
  store.db.run("UPDATE observations SET project = NULL WHERE id = ?", a);
  store.db.run("UPDATE observations SET session_id = 'sin-proyecto' WHERE id = ?", a);
  assert.throws(() => restoreOrphanedObservationSessions(store, act({ session_id: 'sin-proyecto' })), { message: 'orphaned session "sin-proyecto" has observation evidence without a project' });
  store.db.run("UPDATE observations SET project = 'demo' WHERE id = ?", b);
  store.db.run("UPDATE observations SET session_id = 'otra' WHERE id = ?", b);
  assert.throws(() => restoreOrphanedObservationSessions(store, act({ session_id: 'otra', project: 'otro' })), { message: 'orphaned session "otra" evidence belongs to a different project' });
  // Una acción buena seguida de una mala revierte la buena.
  store.db.run("UPDATE observations SET session_id = 'buena' WHERE id = ?", b);
  assert.throws(() => restoreOrphanedObservationSessions(store, [{ session_id: 'buena', project: 'demo', started_at: 'x' }, { session_id: 'nada', project: 'demo', started_at: 'x' }]));
  assert.equal(session(store, 'buena'), undefined);
});

test('reclassifyOrphanedPendingRelations mueve solo las candidatas, con copia previa y sin diario', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/x');
  const viva = obs(store, 's1', 'demo');
  const sync = store.db.get('SELECT sync_id FROM observations WHERE id = ?', viva).sync_id;
  const rel = (id, source, target, status = 'pending') => store.db.run(
    "INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status, updated_at) VALUES (?, ?, ?, 'related', ?, '2000-01-01 00:00:00')", id, source, target, status,
  );
  rel('r-huerfana-1', 'x', 'y');
  rel('r-huerfana-2', 'x2', 'y2');
  rel('r-uno', sync, 'y3');
  rel('r-viva', sync, sync);
  rel('r-juzgada', 'x4', 'y4', 'judged');
  const result = reclassifyOrphanedPendingRelations(store);
  assert.deepEqual({ ...result, backup_path: typeof result.backup_path }, { reclassified: 2, candidates_at_apply: 2, one_endpoint_missing: 1, live_pending: 1, backup_path: 'string' });
  const states = Object.fromEntries(store.db.all('SELECT sync_id, judgment_status, updated_at FROM memory_relations').map((r) => [r.sync_id, [r.judgment_status, r.updated_at === '2000-01-01 00:00:00']]));
  assert.deepEqual(states, { 'r-huerfana-1': ['orphaned', false], 'r-huerfana-2': ['orphaned', false], 'r-uno': ['pending', true], 'r-viva': ['pending', true], 'r-juzgada': ['judged', true] });
  assert.equal(store.db.get('SELECT count(*) AS n FROM sync_mutations').n, 0);
  const copy = new DatabaseSync(result.backup_path, { readOnly: true });
  assert.equal(copy.prepare("SELECT count(*) AS n FROM memory_relations WHERE judgment_status = 'pending'").get().n, 4, 'la copia es la de antes del cambio');
  copy.close();
  assert.equal(reclassifyOrphanedPendingRelations(store).reclassified, 0, 'es idempotente');
});

test('normalizeSessionProjectReclassifications descarta lo inválido y lo repetido', () => {
  const list = normalizeSessionProjectReclassifications([
    { session_id: ' s1 ', from_project: 'A', to_project: 'B' },
    { session_id: 's1', from_project: 'a', to_project: 'b' },
    { session_id: '', from_project: 'a', to_project: 'b' },
    { session_id: 's2', from_project: '', to_project: 'b' },
    { session_id: 's3', from_project: 'a', to_project: '' },
    { session_id: 's4', from_project: 'x', to_project: 'X' },
    { session_id: 's5', from_project: 'a', to_project: 'c' },
  ]);
  assert.deepEqual(list, [{ session_id: 's1', from_project: 'a', to_project: 'b' }, { session_id: 's5', from_project: 'a', to_project: 'c' }]);
});

test('estimar y aplicar la reclasificación de proyecto', (t) => {
  const store = openTempStore(t);
  createSession(store, 'manual-save-nuevo', 'viejo', '/x');
  createSession(store, 'otra', 'viejo', '/y');
  const a = obs(store, 'manual-save-nuevo', 'viejo', 'a');
  obs(store, 'manual-save-nuevo', 'viejo', 'b');
  obs(store, 'otra', 'viejo', 'c');
  addPrompt(store, { session_id: 'manual-save-nuevo', content: 'p', project: 'viejo' });
  store.db.run("UPDATE observations SET project = 'ajeno' WHERE id = ?", a);
  const moves = [{ session_id: 'manual-save-nuevo', from_project: 'viejo', to_project: 'nuevo' }, { session_id: 'otra', from_project: 'viejo', to_project: 'destino' }, { session_id: 'nada', from_project: 'x', to_project: 'y' }];
  assert.deepEqual(estimateSessionProjectReclassification(store, moves), { sessions: 2, observations: 2, prompts: 1 });
  assert.equal(session(store, 'otra').project, 'viejo', 'estimar no escribe');
  const result = applySessionProjectReclassification(store, moves);
  assert.deepEqual(result.counts, { sessions: 2, observations: 2, prompts: 1 });
  assert.ok(existsSync(result.backup_path));
  assert.deepEqual([session(store, 'manual-save-nuevo').project, session(store, 'manual-save-nuevo').ownership_mode], ['nuevo', 'project_owned'], 'el ID manual-save-<destino> queda como propia');
  assert.deepEqual([session(store, 'otra').project, session(store, 'otra').ownership_mode], ['destino', 'shared']);
  assert.equal(store.db.get('SELECT project FROM observations WHERE id = ?', a).project, 'ajeno', 'solo se mueve lo que tenía el proyecto de origen');
  assert.deepEqual(applySessionProjectReclassification(store, moves).counts, { sessions: 0, observations: 0, prompts: 0 }, 'repetir no mueve nada');
});
