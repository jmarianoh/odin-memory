import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudSyncFailureMessage, markCloudSyncFailure, preflightCloudSync } from '../../../src/cloud/client.js';
import { cloudConfigPath, saveCloudConfig } from '../../../src/cloud/config.js';
import { appendGuidance, guidance, isPolicyFailure, isRepairableCloudSyncError, policyGuidance, projectFromTargetKey } from '../../../src/cloud/guidance.js';
import { HttpStatusError, statusError } from '../../../src/cloud/remote.js';
import { enrollProject } from '../../../src/store/enrollment.js';
import { getSyncState } from '../../../src/store/sync-state.js';
import { openTempStore } from '../store/helpers.js';

function world(t) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'odin-cloudclient-')));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: openTempStore(t) };
}

const http = (statusCode, extra = {}) => new HttpStatusError({ operation: 'push', statusCode, ...extra });

test('la guía de recuperación nombra los comandos del proyecto', () => {
  assert.equal(guidance('Mi-Repo'), `Known repairable cloud sync failure detected.
Run these commands, then retry sync:
  odin cloud upgrade doctor --project mi-repo
  odin cloud upgrade repair --project mi-repo --dry-run
  odin cloud upgrade repair --project mi-repo --apply
  odin sync --cloud --project mi-repo`);
  assert.match(guidance(''), /--project <project>/);
  assert.match(policyGuidance('mi-repo'), /^Cloud sync is blocked by server policy\.\nThe server denied access to project "mi-repo"\. Ask the server administrator to check ODIN_CLOUD_ALLOWED_PROJECTS\./);
});

test('los fallos reparables se reconocen por su clase o por su mensaje', () => {
  assert.equal(isRepairableCloudSyncError(null), false);
  assert.equal(isRepairableCloudSyncError(http(400, { errorClass: 'repairable' })), true);
  assert.equal(isRepairableCloudSyncError(http(400, { errorClass: 'blocked' })), false);
  assert.equal(isRepairableCloudSyncError({ isRepairableMigrationFailure: true }), true);
  for (const message of [
    'Known repairable cloud sync failure detected.', 'canonicalize push chunk: boom', 'canonicalize cloud chunk: boom', 'sessions[0].directory is required',
    'legacy mutation payload broken', 'bad payload in cloud sync', 'sync upsert failed',
  ]) assert.equal(isRepairableCloudSyncError(new Error(message)), true, message);
  for (const message of ['connection refused', 'payload', 'upsert']) assert.equal(isRepairableCloudSyncError(new Error(message)), false, message);
  assert.equal(isPolicyFailure(http(403)), true);
  assert.equal(isPolicyFailure(http(401)), false);
  assert.equal(isPolicyFailure(null), false);
});

test('appendGuidance conserva el mensaje y añade la ayuda una sola vez', () => {
  assert.equal(appendGuidance('connection refused', 'p', new Error('connection refused')), 'connection refused');
  const repairable = new Error('bad payload in cloud sync');
  const once = appendGuidance(repairable.message, 'p', repairable);
  assert.equal(once, `bad payload in cloud sync\n\n${guidance('p')}`);
  assert.equal(appendGuidance(once, 'p', repairable), once, 'no se duplica');
  const policy = http(403);
  assert.equal(appendGuidance('denegado', 'p', policy), `denegado\n\n${policyGuidance('p')}`);
  assert.equal(appendGuidance(`x\n\n${policyGuidance('p')}`, 'p', policy), `x\n\n${policyGuidance('p')}`);
  assert.equal(appendGuidance('Cloud sync is blocked by server policy.', 'p', policy), policyGuidance('p'));
  assert.equal(appendGuidance('', 'p', new Error('vacío')), 'vacío');
  assert.equal(projectFromTargetKey('cloud:Mi-Repo'), 'mi-repo');
  assert.equal(projectFromTargetKey('cloud'), '');
  assert.equal(projectFromTargetKey('otro:x'), '');
});

test('el error de estado conserva la clasificación que trae el cuerpo', () => {
  const err = statusError('push chunk abc', 400, JSON.stringify({ error_class: 'repairable', error_code: 'upgrade_repairable_payload_invalid', error: 'invalid push payload' }));
  assert.equal(err.message, 'cloud: push chunk abc: status 400: invalid push payload');
  assert.deepEqual([err.errorClass, err.errorCode, err.isRepairable, err.isAuthFailure, err.isPolicyFailure], ['repairable', 'upgrade_repairable_payload_invalid', true, false, false]);
  const plain = statusError('fetch manifest', 401, 'unauthorized: missing authorization header\n');
  assert.equal(plain.message, 'cloud: fetch manifest: status 401: unauthorized: missing authorization header');
  assert.equal(plain.isAuthFailure, true);
  assert.equal(statusError('x', 403, '{"error":"no"}').isPolicyFailure, true);
  assert.equal(statusError('x', 500, 'null').message, 'cloud: x: status 500: null');
});

test('preflight bloquea la sincronización antes de tocar la red y deja el motivo', (t) => {
  const { dataDir, store } = world(t);
  const blocked = (project, mutate) => {
    try {
      preflightCloudSync(store, { dataDir }, project, mutate, {});
    } catch (err) {
      return err.message;
    }
    return null;
  };
  assert.equal(blocked('mi-repo', true), 'cloud sync cloud_config_error: cloud server is missing: configure server URL with `odin cloud config --server <url>`');
  const state = getSyncState(store, 'cloud:mi-repo');
  assert.equal(state.lifecycle, 'degraded');
  assert.equal(state.reason_code, 'cloud_config_error');

  assert.match(blocked('otro', false), /cloud_config_error/);
  assert.equal(getSyncState(store, 'cloud:otro').lifecycle, 'idle', 'sin mutateState no se escribe');

  saveCloudConfig(dataDir, { server_url: 'ftp://x.example', token: '' });
  assert.equal(blocked('mi-repo', true), 'cloud sync cloud_config_error: invalid cloud runtime server URL: scheme must be http or https');

  saveCloudConfig(dataDir, { server_url: 'https://nube.example', token: 'tok' });
  assert.equal(blocked('Mi-Repo', true), 'cloud sync blocked_unenrolled: project "mi-repo" is not enrolled for cloud sync');
  assert.equal(getSyncState(store, 'cloud:mi-repo').reason_code, 'blocked_unenrolled');
  enrollProject(store, 'mi-repo');
  assert.equal(blocked('mi-repo', true), null);
  assert.deepEqual(preflightCloudSync(store, { dataDir }, 'mi-repo', true, {}), { server_url: 'https://nube.example', token: 'tok' });
  assert.deepEqual(preflightCloudSync(store, { dataDir }, '', true, { ODIN_CLOUD_SERVER: 'https://env.example', ODIN_CLOUD_TOKEN: 'e' }), { server_url: 'https://env.example', token: 'e' }, 'sin proyecto no exige inscripción');
  // un cloud.json ilegible no debe confundirse con «sin configurar»
  writeFileSync(cloudConfigPath(dataDir), '{');
  assert.match(blocked('mi-repo', true), /^cloud sync config error: /);
});

test('un fallo de sincronización bloquea o reintenta según su clase', (t) => {
  const { store } = world(t);
  enrollProject(store, 'mi-repo');
  markCloudSyncFailure(store, 'cloud:mi-repo', null);
  assert.equal(getSyncState(store, 'cloud:mi-repo').lifecycle, 'idle');

  markCloudSyncFailure(store, 'cloud:mi-repo', http(401));
  let state = getSyncState(store, 'cloud:mi-repo');
  assert.deepEqual([state.lifecycle, state.reason_code], ['degraded', 'auth_required']);
  assert.equal(state.backoff_until, null);

  markCloudSyncFailure(store, 'cloud:mi-repo', http(403));
  state = getSyncState(store, 'cloud:mi-repo');
  assert.equal(state.reason_code, 'policy_forbidden');
  assert.match(state.last_error, /Cloud sync is blocked by server policy\./);

  const before = Date.now();
  markCloudSyncFailure(store, 'cloud:mi-repo', new Error('connection refused'));
  state = getSyncState(store, 'cloud:mi-repo');
  assert.deepEqual([state.reason_code, state.consecutive_failures, state.last_error], ['transport_failed', 1, 'connection refused']);
  const backoff = Date.parse(state.backoff_until);
  assert.ok(backoff >= before + 29_000 && backoff <= Date.now() + 31_000, 'reintento a unos 30 s');
  markCloudSyncFailure(store, 'cloud:mi-repo', new Error('otra vez'));
  assert.equal(getSyncState(store, 'cloud:mi-repo').consecutive_failures, 2);

  assert.equal(cloudSyncFailureMessage('p', null), '');
  assert.equal(cloudSyncFailureMessage('p', new Error('x')), 'x');
});
