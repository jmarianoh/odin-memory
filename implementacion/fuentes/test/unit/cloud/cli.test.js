import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { probeLocalDaemon } from '../../../src/cli/commands/cloud.js';
import { markSyncFailure } from '../../../src/store/sync-state.js';
import { cliWorld } from '../cli/helpers.js';
import { startPostgres } from './pg-helper.js';

const SERVER = 'https://nube.example';

test('cloud sin subcomando, con ayuda o con uno desconocido', async (t) => {
  const w = cliWorld(t);
  const none = await w.odin(['cloud']);
  assert.deepEqual([none.code, none.out, none.err], [1, '', 'usage: odin cloud <subcommand> [options]\nsupported subcommands: status, enroll, unenroll, config, serve, repair, bootstrap\n']);
  for (const flag of ['--help', '-h', 'help']) {
    const help = await w.odin(['cloud', flag]);
    assert.deepEqual([help.code, help.out], [0, 'usage: odin cloud <subcommand> [options]\nsupported subcommands: status, enroll, unenroll, config, serve, repair, bootstrap\n']);
  }
  const unknown = await w.odin(['cloud', 'upgrade']);
  assert.deepEqual([unknown.code, unknown.err], [1, 'unknown cloud command: upgrade\nsupported subcommands: status, enroll, unenroll, config, serve, repair, bootstrap\n']);
  assert.match((await w.odin(['help'])).out, /cloud <subcommand> Cloud integration commands \(opt-in\)\n/);
});

test('cloud config guarda la URL con permisos privados y --clear la borra', async (t) => {
  const w = cliWorld(t);
  const set = await w.odin(['cloud', 'config', '--server', ` ${SERVER} `]);
  assert.deepEqual([set.code, set.out], [0, `✓ Cloud server set to ${SERVER}\n`]);
  assert.equal(statSync(join(w.dataDir, 'cloud.json')).mode & 0o777, 0o600);
  const bad = async (args, err) => {
    const r = await w.odin(args);
    assert.deepEqual([r.code, r.err], [1, err], args.join(' '));
  };
  await bad(['cloud', 'config'], 'usage: odin cloud config --server <url> | --clear\n');
  await bad(['cloud', 'config', '--server'], 'usage: odin cloud config --server <url> | --clear\n');
  await bad(['cloud', 'config', '--url', 'x'], 'usage: odin cloud config --server <url> | --clear\n');
  await bad(['cloud', 'config', '--server', '  '], 'error: server URL is required\n');
  await bad(['cloud', 'config', '--server', 'ftp://x'], 'error: invalid server URL: scheme must be http or https\n');
  const cleared = await w.odin(['cloud', 'config', '--clear'], { env: { ODIN_CLOUD_SERVER: 'https://env.example', ODIN_CLOUD_TOKEN: 't' } });
  assert.equal(cleared.out, '✓ Persisted cloud server URL and token cleared\nNote: ODIN_CLOUD_SERVER remains active and overrides the cleared persisted server URL.\nNote: ODIN_CLOUD_TOKEN remains active and overrides the cleared persisted token.\n');
  assert.equal((await w.odin(['cloud', 'status'])).out.split('\n')[0], 'Cloud status: not configured (no effective server URL)');
});

test('cloud enroll y unenroll normalizan el proyecto y son idempotentes', async (t) => {
  const w = cliWorld(t);
  const enroll = await w.odin(['cloud', 'enroll', 'MiRepo']);
  assert.deepEqual([enroll.code, enroll.out, enroll.err], [0, '✓ Project "mirepo" enrolled for cloud sync\n', '⚠️ Project name normalized: "MiRepo" → "mirepo"\n']);
  assert.equal((await w.odin(['cloud', 'enroll', 'mirepo'])).code, 0, 'repetir no falla');
  assert.equal((await w.odin(['cloud', 'enroll', 'a%2Fb', '--literal-project'])).out, '✓ Project "a%2fb" enrolled for cloud sync\n');
  assert.equal((await w.odin(['cloud', 'enroll', 'con%20espacio'])).code, 0);
  const fail = async (args, pattern) => {
    const r = await w.odin(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, pattern, args.join(' '));
  };
  await fail(['cloud', 'enroll'], /^odin: usage: odin cloud enroll <project> \[--literal-project\]\n$/);
  await fail(['cloud', 'enroll', 'a', 'b'], /cloud enroll requires exactly one project/);
  await fail(['cloud', 'enroll', '--wat'], /unknown option: --wat/);
  await fail(['cloud', 'enroll', '%zz'], /invalid cloud project URL encoding "%zz": invalid URL escape "%zz"/);
  await fail(['cloud', 'enroll', 'inbox'], /project name "inbox" is reserved for the cloud inbox/);
  assert.equal((await w.odin(['cloud', 'enroll', '--', '-raro'])).code, 0, '-- permite nombres que empiezan por guion');
  for (const flag of ['--help', 'help']) assert.match((await w.odin(['cloud', 'enroll', flag])).out, /^usage: odin cloud enroll <project> \[--literal-project\]\nEnroll a local-first project for explicit cloud replication\.\n--literal-project skips URL decoding/);

  const unenroll = await w.odin(['cloud', 'unenroll', 'mirepo']);
  assert.equal(unenroll.out, '✓ Project "mirepo" unenrolled from future cloud sync\nLocal data, remote data, and pending journal rows were preserved.\nNote: an already in-flight push is not cancelled.\n');
  assert.equal((await w.odin(['cloud', 'unenroll', 'mirepo'])).code, 0);
  assert.match((await w.odin(['cloud', 'unenroll', '--help'])).out, /Stop future cloud replication/);
  const s = w.store();
  assert.deepEqual(s.db.all('SELECT project FROM sync_enrolled_projects ORDER BY project').map((r) => r.project), ['-raro', 'a%2fb', 'con espacio']);
});

test('cloud status resume la configuración, el token, la inscripción y el diagnóstico', async (t) => {
  const w = cliWorld(t);
  const probe = (result) => ({ overrides: { probeDaemon: async (port) => ({ port, ...result }) } });
  const status = (args = [], env = {}, result = { status: 'running' }) => w.odin(['cloud', 'status', ...args], { env, ...probe(result) });

  const unconfigured = await status();
  assert.equal(unconfigured.out, 'Cloud status: not configured (no effective server URL)\nAuth status: token not configured (client token is optional at preflight)\nSync readiness: blocked (no effective server URL)\nProject enrollment: not checked (use --project <name>)\n');

  await w.odin(['cloud', 'config', '--server', SERVER]);
  const configured = await status();
  assert.equal(configured.out, `Cloud status: configured (target=cloud)
Server: ${SERVER}
Server source: cloud.json
Auth status: token not configured (client token is optional at preflight)
Sync readiness: ready to attempt explicit --project sync (project must be enrolled)
Hint: if the remote server enforces bearer auth, set ODIN_CLOUD_TOKEN
Project enrollment: not checked (use --project <name>)
Local daemon: running on port 7438
`);

  const withToken = await status(['--project', 'MiRepo'], { ODIN_CLOUD_TOKEN: 'tok', ODIN_CLOUD_SERVER: 'https://env.example', ODIN_CLOUD_INSECURE_NO_AUTH: '' }, { status: 'not_running' });
  assert.equal(withToken.err, '⚠️ Project name normalized: "MiRepo" → "mirepo"\n');
  assert.equal(withToken.out, `Cloud status: configured (target=cloud)
Server: https://env.example
Server source: ODIN_CLOUD_SERVER
Auth status: ready (token provided via ODIN_CLOUD_TOKEN)
Sync readiness: ready for explicit --project sync (project must be enrolled)
Project enrollment: unavailable (${w.dataDir} has not been initialized)
Local daemon: not running on port 7438
Hint: run \`odin serve\` to resume autosync
`);

  await w.odin(['cloud', 'enroll', 'mirepo']);
  assert.match((await status(['--project', 'mirepo'])).out, /Project enrollment: enrolled \(mirepo\)\n/);
  assert.match((await status(['--project', 'otro'])).out, /Project enrollment: not enrolled \(otro\)\n/);

  const insecure = await status([], { ODIN_CLOUD_INSECURE_NO_AUTH: '1' }, { status: 'unreachable', error: new Error('timeout') });
  assert.match(insecure.out, /Auth status: ready \(insecure local-dev mode: ODIN_CLOUD_INSECURE_NO_AUTH=1\)\nSync readiness: ready for explicit --project sync/);
  assert.match(insecure.out, /Warning: bearer auth is disabled in insecure mode; do not use in production\n/);
  assert.match(insecure.out, /Local daemon: unreachable on port 7438 \(probe error: timeout\)\n/);
  assert.match((await status([], {}, { status: 'unreachable' })).out, /Local daemon: unreachable on port 7438\n$/);
  assert.match((await status([], { ODIN_PORT: '9999' })).out, /Local daemon: running on port 9999\n/);
  assert.match((await status([], { ODIN_PORT: '70000' })).out, /Local daemon: running on port 7438\n/);

  const s = w.store();
  markSyncFailure(s, 'cloud:mirepo', 'connection refused', new Date(Date.now() + 30_000));
  const diag = await status(['--project', 'mirepo']);
  assert.match(diag.out, /Sync diagnostic: project-scoped cloud state\nreason_code: transport_failed\nreason_message: connection refused\n$/);
  const summary = await status();
  assert.match(summary.out, /Sync diagnostic: project-scoped cloud state\nreason_code: transport_failed\nreason_message: connection refused\n$/);
});

test('cloud status rechaza argumentos y configuraciones inválidas', async (t) => {
  const w = cliWorld(t);
  for (const args of [['--project'], ['--wat', 'x'], ['--project', 'a', 'b']]) {
    const r = await w.odin(['cloud', 'status', ...args]);
    assert.deepEqual([r.code, r.err], [1, 'usage: odin cloud status [--project <name>]\nerror: --project <name> is the only supported status option\n'], args.join(' '));
  }
  assert.equal((await w.odin(['cloud', 'status', '--project', ' '])).err, '⚠️ Project name normalized: " " → ""\nusage: odin cloud status [--project <name>]\nerror: --project is required\n');
  const bad = await w.odin(['cloud', 'status'], { env: { ODIN_CLOUD_SERVER: 'ftp://x' } });
  assert.deepEqual([bad.code, bad.err], [1, 'error: invalid cloud runtime server URL: scheme must be http or https\n']);
});

test('la sonda del servidor local distingue ausente, activo y no disponible', async () => {
  const reply = (status) => async () => new Response('', { status });
  assert.deepEqual(await probeLocalDaemon(7438, { fetch: reply(200) }), { status: 'running', port: 7438 });
  assert.deepEqual(await probeLocalDaemon(7438, { fetch: reply(503) }), { status: 'unreachable', port: 7438 });
  const refused = await probeLocalDaemon(1, { fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  assert.equal(refused.status, 'not_running');
  const timeout = await probeLocalDaemon(1, { fetch: async () => { throw new Error('timed out'); } });
  assert.equal(timeout.status, 'unreachable');
  assert.equal(timeout.error.message, 'timed out');
});

// ─── cloud serve ─────────────────────────────────────────────────────────────

let pg;
before(async () => {
  pg = await startPostgres();
});
after(async () => {
  await pg?.stop();
});

test('cloud serve rechaza una configuración incoherente antes de abrir la base', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['cloud', 'serve']);
  assert.deepEqual([r.code, r.out, r.err], [1, '', 'odin: cloud auth token is required: set ODIN_CLOUD_TOKEN (or ODIN_CLOUD_INSECURE_NO_AUTH=1 for local insecure development)\n']);
  const down = await w.odin(['cloud', 'serve'], { env: { ODIN_CLOUD_TOKEN: 't', ODIN_CLOUD_ALLOWED_PROJECTS: 'a', ODIN_JWT_SECRET: 'un-secreto-propio-largo-1234567890', ODIN_DATABASE_URL: 'postgres://odin:x@127.0.0.1:1/nada' } });
  assert.equal(down.code, 1);
  assert.match(down.err, /^odin: (connect ECONNREFUSED|.*ECONNREFUSED)/);
});

test('cloud serve arranca, atiende y se detiene con la señal', async (t) => {
  const w = cliWorld(t);
  const dsn = await pg.createDatabase();
  const controller = new AbortController();
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const running = w.odin(['cloud', 'serve'], {
    env: { ODIN_CLOUD_INSECURE_NO_AUTH: '1', ODIN_CLOUD_ALLOWED_PROJECTS: 'demo', ODIN_DATABASE_URL: dsn },
    overrides: { cloudServe: { port: 0, signal: controller.signal, ready, log: () => {} } },
  });
  const { address } = await started;
  const health = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.deepEqual(await health.json(), { service: 'odin-cloud', status: 'ok' });
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/sync/pull?project=demo`)).status, 200);
  controller.abort();
  const result = await running;
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^Starting odin cloud server on port 0\n$/);
  assert.match(result.err, /warning: ODIN_CLOUD_INSECURE_NO_AUTH=1 disables cloud API authentication/);
});

test('cloud repair materialize-mutations valida sus argumentos, informa y repara', async (t) => {
  const w = cliWorld(t);
  const usage = 'usage: odin cloud repair materialize-mutations --project <name> (--dry-run|--apply)\n';
  const help = await w.odin(['cloud', 'repair']);
  assert.deepEqual([help.code, help.out], [0, `${usage}repairs existing cloud_mutations into compatible cloud_chunks without deleting remote data\n`]);
  assert.equal((await w.odin(['cloud', 'repair', 'help'])).code, 0);
  assert.deepEqual((await w.odin(['cloud', 'repair', 'otra'])).err, 'unknown cloud repair command: otra\nsupported cloud repair commands: materialize-mutations\n');
  assert.equal((await w.odin(['cloud', 'repair', 'materialize-mutations', '--dry-run'])).err, `${usage}error: --project is required\n`);
  assert.equal((await w.odin(['cloud', 'repair', 'materialize-mutations', '--project'])).err, `${usage}error: --project is required\n`);
  assert.equal((await w.odin(['cloud', 'repair', 'materialize-mutations', '--project', 'a'])).err, `${usage}error: exactly one of --dry-run or --apply is required\n`);
  assert.equal((await w.odin(['cloud', 'repair', 'materialize-mutations', '--project', 'a', '--dry-run', '--apply'])).err, `${usage}error: exactly one of --dry-run or --apply is required\n`);

  const dsn = await pg.createDatabase();
  const { CloudStore, Database } = await import('../../../src/cloud/server/index.js');
  const store = new CloudStore(Database.connect(dsn));
  await store.migrate();
  await store.db.query(`INSERT INTO cloud_mutations (project, entity, entity_key, op, payload) VALUES ('demo', 'prompt', 'p1', 'delete', '{"sync_id":"p1"}')`);
  const env = { ODIN_DATABASE_URL: dsn };
  const dry = await w.odin(['cloud', 'repair', 'materialize-mutations', '--project', 'Demo', '--dry-run'], { env });
  assert.deepEqual(JSON.parse(dry.out), { project: 'demo', applied: false, candidate_mutations: 1, already_materialized: 0, invalid_mutations: 0, chunks_planned: 1, chunks_inserted: 0 });
  assert.equal(dry.out, `${JSON.stringify(JSON.parse(dry.out), null, 2)}\n`, 'JSON con sangría de dos espacios');
  assert.equal(JSON.parse((await w.odin(['cloud', 'repair', 'materialize-mutations', '--project', 'demo', '--apply'], { env })).out).chunks_inserted, 1);
  assert.equal((await store.db.query('SELECT 1 FROM cloud_chunks')).length, 1);
  await store.close();
});

test('cloud serve repara al arrancar los proyectos de su lista', async (t) => {
  const w = cliWorld(t);
  const dsn = await pg.createDatabase();
  const { CloudStore, Database } = await import('../../../src/cloud/server/index.js');
  const seed = new CloudStore(Database.connect(dsn));
  await seed.migrate();
  await seed.db.query(`INSERT INTO cloud_mutations (project, entity, entity_key, op, payload) VALUES ('demo', 'prompt', 'p1', 'delete', '{"sync_id":"p1"}')`);
  const controller = new AbortController();
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const running = w.odin(['cloud', 'serve'], {
    env: { ODIN_CLOUD_INSECURE_NO_AUTH: '1', ODIN_CLOUD_ALLOWED_PROJECTS: 'demo, otro', ODIN_DATABASE_URL: dsn },
    overrides: { cloudServe: { port: 0, signal: controller.signal, ready, log: () => {} } },
  });
  await started;
  controller.abort();
  const result = await running;
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /odin cloud repair materialize-mutations: project=demo candidates=1 already_materialized=0 chunks_planned=1 chunks_inserted=1\n/);
  assert.doesNotMatch(result.err, /project=otro/);
  assert.equal((await seed.db.query('SELECT 1 FROM cloud_chunks')).length, 1);
  await seed.close();
});
