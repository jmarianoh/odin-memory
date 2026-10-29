import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutosyncManager, PHASE } from '../../../src/cloud/autosync.js';
import { writeFileSync } from 'node:fs';
import { cloudConfigPath, saveCloudConfig } from '../../../src/cloud/config.js';
import { autosyncSyncStatus, localSyncStatus, tryStartAutosync } from '../../../src/cli/autosync.js';
import { enrollProject } from '../../../src/store/index.js';
import { cliWorld } from '../cli/helpers.js';

function context(w, env = {}, extra = {}) {
  const errors = [];
  const cli = { env: { ...w.env, ...env }, cwd: () => w.repoDir, err: (text) => errors.push(text), ...extra };
  return { cli, errors, config: { dataDir: w.dataDir } };
}

test('el autosync solo arranca con ODIN_CLOUD_AUTOSYNC=1 exacto y con servidor y token', (t) => {
  const w = cliWorld(t);
  const store = w.store();
  const attempt = (env, extra) => {
    const c = context(w, env, extra);
    const manager = tryStartAutosync(c.cli, store, c.config);
    t.after(() => manager?.stop());
    return { manager, errors: c.errors.join('') };
  };
  assert.deepEqual(attempt({}), { manager: null, errors: '' });
  const complete = { ODIN_CLOUD_TOKEN: 't', ODIN_CLOUD_SERVER: 'https://nube.example' };
  for (const value of ['true', 'yes', ' 0 ', '11']) assert.deepEqual(attempt({ ODIN_CLOUD_AUTOSYNC: value, ...complete }), { manager: null, errors: '' }, value);
  assert.equal(attempt({ ODIN_CLOUD_AUTOSYNC: ' 1 ', ODIN_CLOUD_SERVER: 'https://nube.example' }).errors, '[autosync] ERROR: cloud token is not configured (set ODIN_CLOUD_TOKEN or store token in cloud.json via `odin cloud config`); autosync disabled\n');
  assert.equal(attempt({ ODIN_CLOUD_AUTOSYNC: '1', ODIN_CLOUD_TOKEN: 't' }).errors, '[autosync] ERROR: cloud server URL is not configured (set ODIN_CLOUD_SERVER or run `odin cloud config --server <url>`); autosync disabled\n');
  assert.match(attempt({ ODIN_CLOUD_AUTOSYNC: '1', ODIN_CLOUD_TOKEN: 't', ODIN_CLOUD_SERVER: 'http://plano.example' }).errors, /^\[autosync\] ERROR: invalid server URL "http:\/\/plano\.example": cloud: bearer token requires an HTTPS remote URL; autosync disabled\n$/);
  const ok = attempt({ ODIN_CLOUD_AUTOSYNC: '1', ODIN_CLOUD_TOKEN: 't', ODIN_CLOUD_SERVER: 'https://nube.example' }, { autosync: { pollInterval: 3_600_000 } });
  assert.ok(ok.manager instanceof AutosyncManager);
  assert.equal(ok.errors, '[autosync] started (server=https://nube.example)\n');
  assert.equal(ok.manager.running, true);

  saveCloudConfig(w.dataDir, { server_url: 'https://guardada.example', token: 'del-archivo' });
  const stored = attempt({ ODIN_CLOUD_AUTOSYNC: '1' }, { autosync: { pollInterval: 3_600_000 } });
  assert.equal(stored.errors, '[autosync] started (server=https://guardada.example)\n', 'sirve lo guardado en cloud.json');
  writeBrokenConfig(w);
  assert.match(attempt({ ODIN_CLOUD_AUTOSYNC: '1' }).errors, /^\[autosync\] ERROR: cannot read cloud config: /);
});

function writeBrokenConfig(w) {
  writeFileSync(cloudConfigPath(w.dataDir), '{');
}

test('el estado local conoce el servidor configurado y el proyecto del directorio', (t) => {
  const w = cliWorld(t);
  const store = w.store();
  enrollProject(store, 'mi-repo');
  const none = context(w);
  const status = localSyncStatus(none.cli, store, none.config);
  assert.equal(status('mi-repo').reason_code, 'cloud_not_configured');
  saveCloudConfig(w.dataDir, { server_url: 'https://nube.example', token: '' });
  const configured = context(w);
  const after = localSyncStatus(configured.cli, store, configured.config);
  assert.equal(after('mi-repo').enabled, true);
  assert.equal(after('').enabled, true, 'sin proyecto en la petición usa el del directorio');
  assert.equal(after('otro').reason_code, 'blocked_unenrolled');
  const withEnv = context(w, { ODIN_PROJECT: 'otro' });
  assert.equal(localSyncStatus(withEnv.cli, store, withEnv.config)('').reason_code, 'blocked_unenrolled', 'ODIN_PROJECT manda sobre el directorio');
  writeBrokenConfig(w);
  const broken = context(w);
  assert.equal(localSyncStatus(broken.cli, store, broken.config)('mi-repo').reason_code !== undefined, true);
});

test('el estado del gestor se traduce a las fases de la API local', () => {
  const fallback = () => ({ upgrade_stage: 'bootstrap_pushed', upgrade_reason_code: 'c', upgrade_reason_message: 'm' });
  const manager = (state) => ({ status: () => ({ phase: PHASE.idle, lastError: '', consecutiveFailures: 0, backoffUntil: null, lastSyncAt: null, reasonCode: '', reasonMessage: '', deferredCount: 2, deadCount: 1, ...state }) });
  const at = new Date('2026-01-02T03:04:05.000Z');
  const status = (state) => autosyncSyncStatus(manager(state), fallback)('p');
  assert.equal(autosyncSyncStatus(null, fallback), fallback);
  assert.deepEqual(status({ phase: PHASE.healthy, lastSyncAt: at }), {
    enabled: true, last_error: '', consecutive_failures: 0, backoff_until: null, last_sync_at: '2026-01-02T03:04:05Z', deferred_count: 2, dead_count: 1,
    upgrade_stage: 'bootstrap_pushed', upgrade_reason_code: 'c', upgrade_reason_message: 'm', phase: 'healthy', reason_code: '', reason_message: '',
  });
  for (const phase of [PHASE.pushing, PHASE.pulling, PHASE.idle]) assert.equal(status({ phase }).phase, 'running', phase);
  for (const phase of [PHASE.pushFailed, PHASE.pullFailed, PHASE.backoff]) {
    assert.deepEqual([status({ phase, lastError: 'x' }).phase, status({ phase, lastError: 'x' }).reason_code, status({ phase, lastError: 'x' }).reason_message], ['degraded', 'transport_failed', 'x'], phase);
  }
  const blocked = status({ phase: PHASE.pushFailed, reasonCode: 'auth_required', reasonMessage: 'falta', lastError: 'otra', backoffUntil: at, consecutiveFailures: 3 });
  assert.deepEqual([blocked.reason_code, blocked.reason_message, blocked.backoff_until, blocked.consecutive_failures], ['auth_required', 'falta', '2026-01-02T03:04:05Z', 3]);
  const paused = status({ phase: PHASE.disabled, reasonCode: 'paused', reasonMessage: 'migración' });
  assert.deepEqual([paused.phase, paused.reason_code, paused.reason_message], ['degraded', 'upgrade_paused', 'migración']);
  assert.equal(status({ phase: 'raro', reasonCode: 'r' }).phase, 'raro');
});
