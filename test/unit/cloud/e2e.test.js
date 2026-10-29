import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudServer, CloudStore, Database } from '../../../src/cloud/server/index.js';
import { getSyncState } from '../../../src/store/sync-state.js';
import { addObservation, createSession, getObservation, searchObservations } from '../../../src/store/index.js';
import { cliWorld } from '../cli/helpers.js';
import { startPostgres } from './pg-helper.js';

let pg;
let cloud;
let server;
let url;

before(async () => {
  pg = await startPostgres();
  cloud = new CloudStore(Database.connect(await pg.createDatabase()));
  await cloud.migrate();
  server = new CloudServer(cloud, { allowedProjects: ['mi-repo', 'otro', 'vacio'], port: 0, log: () => {} });
  url = `http://127.0.0.1:${(await server.listen()).port}`;
});

after(async () => {
  await server?.close();
  await cloud?.close();
  await pg?.stop();
});

async function enrolled(t, project = 'mi-repo') {
  const w = cliWorld(t);
  assert.equal((await w.odin(['cloud', 'config', '--server', url])).code, 0);
  assert.equal((await w.odin(['cloud', 'enroll', project])).code, 0);
  return w;
}

test('dos máquinas intercambian memoria por la nube', async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  const sa = a.store();
  createSession(sa, 's1', 'mi-repo', '/tmp/x');
  addObservation(sa, { session_id: 's1', type: 'decision', title: 'Usar Postgres', content: 'para la nube compartida', project: 'mi-repo' });
  // El manifiesto de la nube guarda la hora del chunk en segundos: la sesión debe ser anterior a ese segundo.
  sa.db.run("UPDATE sessions SET started_at = '2020-01-01 00:00:00'");
  sa.close();

  const pushed = await a.odin(['sync', '--cloud', '--project', 'mi-repo']);
  assert.equal(pushed.code, 0, pushed.err);
  assert.match(pushed.out, /^Exporting memories for project "mi-repo" to cloud\.\.\.\nCreated chunk [0-9a-f]{8}\n/);
  assert.match(pushed.out, /Cloud sync complete for project "mi-repo"\.\n$/);

  const sa2 = a.store();
  assert.equal(getSyncState(sa2, 'cloud:mi-repo').lifecycle, 'healthy', 'las filas del diario salieron en el chunk y se acusaron');
  assert.equal(sa2.db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE acked_at IS NULL AND disposition = 'pending'").n, 0);
  sa2.close();
  const again = await a.odin(['sync', '--cloud', '--project', 'mi-repo']);
  assert.match(again.out, /Nothing new to sync for project "mi-repo"/);

  const status = await b.odin(['sync', '--cloud', '--project', 'mi-repo', '--status']);
  assert.equal(status.out, 'Cloud sync status (project="mi-repo"):\n  Local chunks:    0\n  Remote chunks:   1\n  Pending import:  1\n');

  const pulled = await b.odin(['sync', '--cloud', '--project', 'mi-repo', '--import']);
  assert.equal(pulled.code, 0, pulled.err);
  assert.match(pulled.out, /Cloud import progress: local=0 remote=1 pending=1 progress=0%\n/);
  assert.match(pulled.out, /Imported 1 new remote chunk\(s\) for project "mi-repo"\n {2}Sessions: {5}1\n {2}Observations: 1\n/);

  const sb = b.store();
  const [found] = searchObservations(sb, 'Postgres', { project: 'mi-repo' });
  assert.equal(found.title, 'Usar Postgres');
  assert.equal(getObservation(sb, found.id).content, 'para la nube compartida');
  assert.equal(getSyncState(sb, 'cloud:mi-repo').lifecycle, 'healthy');
  sb.close();

  const repeat = await b.odin(['sync', '--cloud', '--project', 'mi-repo', '--import']);
  const progress = 'Cloud import progress: local=1 remote=1 pending=0 progress=100%\n';
  assert.match(repeat.out, new RegExp(`^${progress}${progress}No new chunks to import\\.\\n {2}\\(1 chunks already imported\\)\\n`));
});

test('un proyecto sin inscribir queda bloqueado antes de tocar la red', async (t) => {
  const w = cliWorld(t);
  await w.odin(['cloud', 'config', '--server', url]);
  const r = await w.odin(['sync', '--cloud', '--project', 'mi-repo']);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'odin: cloud sync blocked_unenrolled: project "mi-repo" is not enrolled for cloud sync\n');
  const s = w.store();
  const state = getSyncState(s, 'cloud:mi-repo');
  assert.equal(state.lifecycle, 'degraded');
  assert.equal(state.reason_code, 'blocked_unenrolled');
  s.close();
});

test('un proyecto fuera de la lista permitida bloquea con la guía de política', async (t) => {
  const w = await enrolled(t, 'privado');
  const r = await w.odin(['sync', '--cloud', '--project', 'privado']);
  assert.equal(r.code, 1);
  assert.match(r.err, /cloud: push chunk|cloud: fetch manifest: status 403|status 403/);
  assert.match(r.err, /Cloud sync is blocked by server policy\./);
  assert.match(r.err, /ODIN_CLOUD_ALLOWED_PROJECTS/);
  const s = w.store();
  const state = getSyncState(s, 'cloud:privado');
  assert.equal(state.lifecycle, 'degraded');
  assert.equal(state.reason_code, 'policy_forbidden');
  s.close();
});

test('un proyecto en pausa rechaza la subida y la deja en el registro de auditoría', async (t) => {
  const w = await enrolled(t, 'otro');
  const s = w.store();
  createSession(s, 's1', 'otro', '/tmp/x');
  addObservation(s, { session_id: 's1', type: 'manual', title: 'En pausa', content: 'no debe subir', project: 'otro' });
  s.close();
  await cloud.setProjectSyncEnabled('otro', false, 'ops', 'mantenimiento');
  const r = await w.odin(['sync', '--cloud', '--project', 'otro']);
  assert.equal(r.code, 1);
  assert.match(r.err, /sync is paused for project "otro"/);
  const audit = await cloud.db.query("SELECT contributor, action, outcome, reason_code FROM cloud_sync_audit_log WHERE project = 'otro'");
  assert.equal(audit.length, 1);
  assert.deepEqual({ ...audit[0], contributor: undefined }, { contributor: undefined, action: 'chunk_push', outcome: 'rejected_project_paused', reason_code: 'sync-paused' });
  await cloud.setProjectSyncEnabled('otro', true);
  const ok = await w.odin(['sync', '--cloud', '--project', 'otro']);
  assert.equal(ok.code, 0, ok.err);
});

test('sin datos pendientes ni por importar, el destino queda sano', async (t) => {
  const w = await enrolled(t, 'vacio');
  const r = await w.odin(['sync', '--cloud', '--project', 'vacio']);
  assert.equal(r.code, 0, r.err);
  const s = w.store();
  const state = getSyncState(s, 'cloud:vacio');
  assert.deepEqual([state.lifecycle, state.reason_code], ['healthy', null]);
  s.close();
});

test('importar muchos chunks informa del progreso unas diez veces', async (t) => {
  for (let i = 0; i < 12; i++) {
    await cloud.writeChunk('mi-repo', `bulk${String(i).padStart(4, '0')}`, 'ana', '', JSON.stringify({
      sessions: [{ id: `bulk-s${i}`, project: 'mi-repo', directory: '/x', started_at: '2026-01-01 00:00:00' }],
      observations: [{ sync_id: `obs-bulk${i}`, session_id: `bulk-s${i}`, type: 'note', title: `Masa ${i}`, content: 'c', scope: 'project', project: 'mi-repo', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' }],
      prompts: [],
    }));
  }
  const w = await enrolled(t);
  const r = await w.odin(['sync', '--cloud', '--project', 'mi-repo', '--import']);
  assert.equal(r.code, 0, r.err);
  const pending = [...r.out.matchAll(/pending=(\d+)/g)].map((m) => Number(m[1]));
  const total = pending[0];
  assert.ok(total >= 12, `quedan al menos los 12 chunks nuevos (${total})`);
  const interval = Math.ceil(total / 10);
  const expected = [total];
  for (let left = total - 1; left > 0; left--) if ((total - left) % interval === 0) expected.push(left);
  expected.push(0);
  assert.deepEqual(pending, expected);
  assert.ok(pending.length < total / 1.5, 'menos líneas que chunks');
});
