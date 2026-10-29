import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudServer, CloudStore, Database } from '../../../src/cloud/server/index.js';
import { addObservation, createSession } from '../../../src/store/index.js';
import { cliWorld } from '../cli/helpers.js';
import { startPostgres } from './pg-helper.js';

let pg;
before(async () => {
  pg = await startPostgres();
});
after(async () => {
  await pg?.stop();
});

const REMOTE = 'https://nube.example';

async function server(t) {
  const store = new CloudStore(Database.connect(await pg.createDatabase()));
  await store.migrate();
  const cloud = new CloudServer(store, { allowedProjects: ['*'], token: 'tok', port: 0, log: () => {} });
  const { port } = await cloud.listen();
  t.after(async () => {
    await cloud.close();
    await store.close();
  });
  return { store, fetch: (url, init) => fetch(String(url).replace(REMOTE, `http://127.0.0.1:${port}`), init) };
}

const withProject = (t) => {
  const w = cliWorld(t);
  const local = w.store();
  createSession(local, 's1', 'demo', '/work/demo');
  addObservation(local, { session_id: 's1', type: 'decision', title: 'Usar pg', content: 'por fiable', project: 'demo' });
  local.close();
  return w;
};

test('cloud upgrade: ayuda, errores de uso y órdenes desconocidas', async (t) => {
  const w = cliWorld(t);
  const usage = 'usage: odin cloud upgrade <doctor|repair|bootstrap|remirror|status|rollback> --project <name>\n';
  const none = await w.odin(['cloud', 'upgrade']);
  assert.deepEqual([none.code, none.out, none.err], [1, '', usage]);
  for (const flag of ['--help', '-h', 'help']) {
    const help = await w.odin(['cloud', 'upgrade', flag]);
    assert.deepEqual([help.code, help.out], [0, `odin cloud upgrade\nworkflow: doctor -> repair -> bootstrap -> status/rollback\nrecovery: use remirror only to rebuild cloud state from authoritative local data\ncloud is opt-in replication/shared access; local SQLite remains source of truth\n${usage}`]);
  }
  const unknown = await w.odin(['cloud', 'upgrade', 'wat']);
  assert.deepEqual([unknown.code, unknown.err], [1, 'unknown cloud upgrade command: wat\nsupported cloud upgrade commands: doctor, repair, bootstrap, remirror, status, rollback\n']);
  for (const command of ['doctor', 'repair', 'bootstrap', 'remirror', 'status', 'rollback']) {
    const missing = await w.odin(['cloud', 'upgrade', command]);
    assert.equal(missing.code, 1, command);
    assert.match(missing.err, new RegExp(`^usage: odin cloud upgrade ${command} --project <name>.*\\nerror: --project is required\\n$`), command);
  }
  assert.equal((await w.odin(['cloud', 'upgrade', 'status', '--project'])).code, 1, '--project sin valor');
  assert.equal((await w.odin(['cloud', 'upgrade', 'DOCTOR', '--project', 'demo'])).code, 0, 'sin distinguir mayúsculas');
});

test('cloud upgrade doctor, status y rollback siguen el estado por etapas', async (t) => {
  const w = withProject(t);
  const env = { ODIN_CLOUD_SERVER: REMOTE };
  assert.equal((await w.odin(['cloud', 'upgrade', 'status', '--project', 'Demo'])).out, 'project: demo\nstage: planned\n');
  const unconfigured = await w.odin(['cloud', 'upgrade', 'doctor', '--project', 'demo']);
  assert.equal(unconfigured.out, 'project: demo\nstatus: blocked\nclass: policy\nreason_code: cloud_config_error\nmessage: cloud configuration is required before upgrade bootstrap\n');
  const unenrolled = await w.odin(['cloud', 'upgrade', 'doctor', '--project', 'demo'], { env });
  assert.equal(unenrolled.out, 'project: demo\nstatus: blocked\nclass: repairable\nreason_code: upgrade_repairable_unenrolled\nmessage: project "demo" is not enrolled for cloud sync yet\n');
  assert.equal((await w.odin(['cloud', 'upgrade', 'status', '--project', 'demo'])).out, 'project: demo\nstage: doctor_blocked\nclass: repairable\nreason_code: upgrade_repairable_unenrolled\nreason_message: project "demo" is not enrolled for cloud sync yet\n');
  await w.odin(['cloud', 'enroll', 'demo']);
  const ready = await w.odin(['cloud', 'upgrade', 'doctor', '--project', 'demo'], { env });
  assert.match(ready.out, /^project: demo\nstatus: ready\nclass: ready\nreason_code: upgrade_ready\nmessage: project "demo" is ready for cloud bootstrap\n$/);
  const state = w.store();
  state.db.run("INSERT OR REPLACE INTO sync_state (target_key, lifecycle, reason_code) VALUES ('cloud:demo', 'degraded', 'policy_forbidden')");
  state.close();
  assert.match((await w.odin(['cloud', 'upgrade', 'doctor', '--project', 'demo'], { env })).out, /status: blocked\nclass: policy\nreason_code: policy_forbidden\nmessage: project "demo" is blocked by organization policy\n$/);

  assert.match((await w.odin(['cloud', 'upgrade', 'rollback', '--project', 'demo'])).err, /rollback is unavailable post-bootstrap/);
  const check = w.store();
  check.db.run("UPDATE cloud_upgrade_state SET snapshot_json = '{\"captured\":true,\"project_enrolled\":false}', stage = 'bootstrap_pushed' WHERE project = 'demo'");
  check.close();
  assert.equal((await w.odin(['cloud', 'upgrade', 'rollback', '--project', 'demo'])).out, 'project: demo\nstage: rolled_back\n');
  assert.match((await w.odin(['cloud', 'upgrade', 'rollback', '--project', 'otro'])).err, /rollback requires existing upgrade checkpoint state/);
});

test('cloud upgrade bootstrap pasa por las etapas, sube el estado y no se repite', async (t) => {
  const remote = await server(t);
  const w = withProject(t);
  const env = { ODIN_CLOUD_SERVER: REMOTE, ODIN_CLOUD_TOKEN: 'tok' };
  const run = (args, extra = {}) => w.odin(args, { env, overrides: { fetch: remote.fetch }, ...extra });
  const noServer = await w.odin(['cloud', 'upgrade', 'bootstrap', '--project', 'demo']);
  assert.match(noServer.err, /^odin: cloud upgrade bootstrap requires configured cloud server\n$/);
  assert.match((await w.odin(['cloud', 'upgrade', 'bootstrap', '--project', 'demo'], { env: { ODIN_CLOUD_SERVER: 'ftp://x' } })).err, /invalid cloud runtime server URL: scheme must be http or https/);

  // Una carga heredada pendiente impide arrancar hasta repararla.
  const local = w.store();
  local.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('demo')");
  local.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'widget', 'w', 'upsert', '{}', 'demo')");
  local.close();
  const blocked = await run(['cloud', 'upgrade', 'bootstrap', '--project', 'demo']);
  assert.match(blocked.err, /legacy mutation payloads require manual action before bootstrap \(seq=\d+ entity=widget op=upsert\): unsupported legacy mutation "widget"\/"upsert"/);
  const fix = w.store();
  fix.db.run("DELETE FROM sync_mutations WHERE entity = 'widget'");
  fix.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'session', 's1', 'upsert', '{\"id\":\"s1\"}', 'demo')");
  fix.close();
  assert.match((await run(['cloud', 'upgrade', 'bootstrap', '--project', 'demo'])).err, /legacy mutation payloads require repair before bootstrap: run `odin cloud upgrade repair --project demo --apply`/);
  assert.match((await run(['cloud', 'upgrade', 'repair', '--project', 'demo', '--apply'])).out, /class: repairable\nreason_code: upgrade_repairable_legacy_mutation_payload\n.*\napplied: true\n$/);

  const done = await run(['cloud', 'upgrade', 'bootstrap', '--project', 'demo']);
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out, 'project: demo\nstage: bootstrap_verified\nresumed: true\nnoop: false\n', 'venía de la reparación');
  const [pushed] = await remote.store.db.query('SELECT project_name, created_by, sessions_count, observations_count FROM cloud_chunks');
  assert.deepEqual({ ...pushed }, { project_name: 'demo', created_by: 'odin-cloud-upgrade', sessions_count: 1, observations_count: 1 });
  assert.equal((await remote.store.db.query('SELECT 1 FROM cloud_mutations')).length >= 2, true);
  assert.equal((await run(['cloud', 'upgrade', 'bootstrap', '--project', 'demo'])).out, 'project: demo\nstage: bootstrap_verified\nresumed: true\nnoop: true\n');
  assert.match((await run(['cloud', 'upgrade', 'rollback', '--project', 'demo'])).err, /rollback is unavailable post-bootstrap/);
  assert.equal((await run(['cloud', 'upgrade', 'status', '--project', 'demo'])).out.split('\n')[1], 'stage: bootstrap_verified');

  // Remirror vuelve a subir el estado actual.
  const before = (await remote.store.db.query('SELECT 1 FROM cloud_chunks')).length;
  const mirror = await run(['cloud', 'upgrade', 'remirror', '--project', 'demo']);
  assert.equal(mirror.code, 0, mirror.err);
  assert.match(mirror.out, /^project: demo\nchunks_exported: 1\nmutations_exported: [1-9]\d*\n$/);
  assert.equal((await remote.store.db.query('SELECT 1 FROM cloud_chunks')).length, before + 1);
  assert.match((await run(['cloud', 'upgrade', 'remirror', '--project', 'otro'])).err, /cloud remirror: cloud remirror requires enrolled project "otro"/);
});
