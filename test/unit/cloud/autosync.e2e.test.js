import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { AutosyncManager, PHASE } from '../../../src/cloud/autosync.js';
import { MutationTransport } from '../../../src/cloud/remote.js';
import { CloudServer, CloudStore, Database } from '../../../src/cloud/server/index.js';
import {
  addObservation, addPrompt, createSession, deleteObservation, enrollProject, getObservation, getSyncState, searchObservations, updateObservation,
} from '../../../src/store/index.js';
import { openTempStore } from '../store/helpers.js';
import { startPostgres } from './pg-helper.js';

let pg;

before(async () => {
  pg = await startPostgres();
});
after(async () => {
  await pg?.stop();
});

/** Un servidor de la nube nuevo (con su base) por prueba: los cursores empiezan de cero. */
async function cloudServer(t, options = {}) {
  const cloud = new CloudStore(Database.connect(await pg.createDatabase()));
  await cloud.migrate();
  const server = new CloudServer(cloud, { allowedProjects: ['demo', 'otro'], port: 0, log: () => {}, ...options });
  const url = `http://127.0.0.1:${(await server.listen()).port}`;
  t.after(async () => {
    await server.close();
    await cloud.close();
  });
  return { cloud, url };
}

const manager = (store, url, extra = {}) => new AutosyncManager(store, new MutationTransport(url, ''), { log: () => {}, baseBackoff: 10, ...extra });
const titles = (store, project = 'demo') => searchObservations(store, 'x', { project }).map((o) => o.title).sort();

test('dos almacenes convergen por mutaciones: altas, cambios y borrados', async (t) => {
  const { url } = await cloudServer(t);
  const a = openTempStore(t);
  const b = openTempStore(t);
  enrollProject(a, 'demo');
  enrollProject(b, 'demo');
  createSession(a, 's1', 'demo', '/tmp/a');
  const { id } = addObservation(a, { session_id: 's1', type: 'decision', title: 'Uno x', content: 'primero x', project: 'demo' });
  addObservation(a, { session_id: 's1', type: 'decision', title: 'Dos x', content: 'segundo x', project: 'demo' });
  addPrompt(a, { session_id: 's1', content: 'pregunta x', project: 'demo' });

  const ma = manager(a, url);
  const mb = manager(b, url);
  await ma.runOnce();
  assert.equal(ma.status().phase, PHASE.healthy, ma.status().lastError);
  assert.equal(getSyncState(a, 'cloud').lifecycle, 'healthy');
  assert.equal(a.db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE acked_at IS NULL AND disposition = 'pending'").n, 0, 'todo acusado');

  await mb.runOnce();
  assert.equal(mb.status().phase, PHASE.healthy, mb.status().lastError);
  assert.deepEqual(titles(b), ['Dos x', 'Uno x']);
  assert.equal(b.db.get('SELECT COUNT(*) AS n FROM user_prompts').n, 1);

  updateObservation(a, id, { title: 'Uno cambiado x' });
  deleteObservation(a, id, { hardDelete: false });
  await ma.runOnce();
  await mb.runOnce();
  assert.deepEqual(titles(b), ['Dos x']);
  assert.equal(getSyncState(b, 'cloud').last_pulled_seq > 0, true);

  // Lo de B vuelve a A.
  addObservation(b, { session_id: 's1', type: 'note', title: 'Desde B x', content: 'c x', project: 'demo' });
  await mb.runOnce();
  await ma.runOnce();
  assert.deepEqual(titles(a), ['Desde B x', 'Dos x']);
  await ma.stop();
  await mb.stop();
});

test('inscribir un proyecto sube lo que ya existía', async (t) => {
  const { url } = await cloudServer(t);
  const a = openTempStore(t);
  const b = openTempStore(t);
  createSession(a, 'p1', 'otro', '/tmp/o');
  addObservation(a, { session_id: 'p1', type: 'note', title: 'Previa x', content: 'ya estaba x', project: 'otro' });
  addPrompt(a, { session_id: 'p1', content: 'antes x', project: 'otro' });
  enrollProject(a, 'otro');
  enrollProject(b, 'otro');
  await manager(a, url).runOnce();
  await manager(b, url).runOnce();
  assert.deepEqual(titles(b, 'otro'), ['Previa x']);
  assert.equal(b.db.get('SELECT COUNT(*) AS n FROM user_prompts').n, 1);
});

test('un proyecto sin inscribir bloquea la salida pero no la lectura', async (t) => {
  const { url } = await cloudServer(t);
  const a = openTempStore(t);
  const b = openTempStore(t);
  enrollProject(b, 'demo');
  createSession(b, 's9', 'demo', '/tmp/b');
  addObservation(b, { session_id: 's9', type: 'note', title: 'Remota x', content: 'c x', project: 'demo' });
  await manager(b, url).runOnce();

  enrollProject(a, 'demo');
  createSession(a, 'loc', 'sinnube', '/tmp/l');
  a.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, source, project) VALUES ('cloud', 'session', 'loc', 'upsert', '{}', 'local', 'sinnube')");
  const ma = manager(a, url);
  await ma.runOnce();
  const state = getSyncState(a, 'cloud');
  assert.deepEqual([state.lifecycle, state.reason_code], ['degraded', 'non_enrolled_pending_mutations']);
  assert.match(state.last_error, /project\(s\) are not enrolled: sinnube=1/);
  assert.deepEqual(titles(a), ['Remota x'], 'aun así se lee');
  assert.equal(ma.status().consecutiveFailures, 0);
  assert.equal(ma.status().phase, PHASE.pushFailed);
});
