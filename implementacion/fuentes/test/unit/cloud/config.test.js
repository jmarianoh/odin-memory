import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SOURCE, applyServerOverride, clearCloudConfig, cloudConfigPath, effectiveToken, loadCloudConfig, resolveCloudRuntimeConfig, saveCloudConfig, validateServerUrl,
} from '../../../src/cloud/config.js';
import {
  DEFAULT_JWT_SECRET, cloudServeConfigFromEnv, envBool, isDefaultJwtSecret, normalizeAllowedProjects, validateCloudServeAuthConfig,
} from '../../../src/cloud/server/config.js';

function tempData(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'odin-cloudcfg-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('la configuración del cliente se guarda con permisos 0600 y se lee de vuelta', (t) => {
  const dir = join(tempData(t), 'datos');
  assert.deepEqual(loadCloudConfig(dir), { server_url: '', token: '' }, 'sin archivo, vacía');
  saveCloudConfig(dir, { server_url: 'https://nube.example', token: 'secreto' });
  assert.equal(statSync(cloudConfigPath(dir)).mode & 0o777, 0o600);
  assert.deepEqual(loadCloudConfig(dir), { server_url: 'https://nube.example', token: 'secreto' });
  chmodSync(cloudConfigPath(dir), 0o644);
  saveCloudConfig(dir, { server_url: 'https://nube.example', token: 'otro' });
  assert.equal(statSync(cloudConfigPath(dir)).mode & 0o777, 0o600, 'un archivo previo más abierto se cierra al guardar');
  clearCloudConfig(dir);
  assert.deepEqual(loadCloudConfig(dir), { server_url: '', token: '' });
  assert.equal(JSON.parse(readFileSync(cloudConfigPath(dir), 'utf8')).server_url, '');
  writeFileSync(cloudConfigPath(dir), JSON.stringify({ server_url: 5, token: null }));
  assert.deepEqual(loadCloudConfig(dir), { server_url: '', token: '' }, 'los tipos erróneos se ignoran');
  writeFileSync(cloudConfigPath(dir), '{');
  assert.throws(() => loadCloudConfig(dir), SyntaxError);
});

test('el entorno sustituye a lo guardado', (t) => {
  const dir = tempData(t);
  saveCloudConfig(dir, { server_url: 'https://guardado.example', token: 'del-archivo' });
  assert.deepEqual(effectiveToken(dir, {}), { token: 'del-archivo', source: SOURCE.file });
  assert.deepEqual(effectiveToken(dir, { ODIN_CLOUD_TOKEN: '  del-entorno ' }), { token: 'del-entorno', source: SOURCE.env });
  assert.deepEqual(applyServerOverride({ server_url: 'a', token: 't' }, { ODIN_CLOUD_SERVER: ' https://b.example ' }), { server_url: 'https://b.example', token: 't' });
  assert.deepEqual(applyServerOverride({ server_url: 'a' }, { ODIN_CLOUD_SERVER: '  ' }), { server_url: 'a' });
  assert.deepEqual(resolveCloudRuntimeConfig(dir, { ODIN_CLOUD_SERVER: 'https://env.example' }), { server_url: 'https://env.example', token: 'del-archivo' });
  assert.deepEqual(effectiveToken(join(dir, 'no-existe'), {}), { token: '', source: SOURCE.none });
  writeFileSync(cloudConfigPath(dir), '{');
  assert.deepEqual(effectiveToken(dir, {}), { token: '', source: SOURCE.none }, 'un archivo roto no da token');
});

test('validateServerUrl exige http o https con host y sin consulta ni fragmento', () => {
  assert.equal(validateServerUrl('  https://nube.example:8443/base  '), 'https://nube.example:8443/base');
  assert.equal(validateServerUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.throws(() => validateServerUrl(''), /server URL is required/);
  assert.throws(() => validateServerUrl('   '), /server URL is required/);
  assert.throws(() => validateServerUrl('ftp://x.example'), /scheme must be http or https/);
  assert.throws(() => validateServerUrl('nube.example'), /invalid URI for request/);
  assert.throws(() => validateServerUrl('https://x.example?a=1'), /query is not allowed/);
  assert.throws(() => validateServerUrl('https://x.example?'), /query is not allowed/);
  assert.throws(() => validateServerUrl('https://x.example#f'), /fragment is not allowed/);
  assert.throws(() => validateServerUrl('https://'), /invalid URI for request|host is required/);
});

test('el servidor lee su configuración del entorno con valores por defecto', () => {
  const cfg = cloudServeConfigFromEnv({});
  assert.deepEqual({ ...cfg }, {
    dsn: 'postgres://odin:odin_dev@localhost:5433/odin_cloud?sslmode=disable', jwtSecret: DEFAULT_JWT_SECRET, port: 8080, bindHost: '127.0.0.1', adminToken: '', tokenPepper: '',
    maxPushBodyBytes: 8 * 1024 * 1024, allowedProjects: [], token: '', insecureNoAuth: false,
  });
  const set = cloudServeConfigFromEnv({
    ODIN_DATABASE_URL: ' postgres://x ', ODIN_JWT_SECRET: 's', ODIN_PORT: '9000', ODIN_CLOUD_HOST: '0.0.0.0', ODIN_CLOUD_ADMIN: 'adm', ODIN_CLOUD_TOKEN_PEPPER: 'pep',
    ODIN_CLOUD_MAX_PUSH_BYTES: '100', ODIN_CLOUD_ALLOWED_PROJECTS: ' a , b,,a ', ODIN_CLOUD_TOKEN: 'tok',
  });
  assert.deepEqual({ ...set }, {
    dsn: 'postgres://x', jwtSecret: 's', port: 9000, bindHost: '0.0.0.0', adminToken: 'adm', tokenPepper: 'pep', maxPushBodyBytes: 100, allowedProjects: ['a', 'b'], token: 'tok', insecureNoAuth: false,
  });
  for (const bad of ['0', '-3', 'x', '1.5', '']) assert.equal(cloudServeConfigFromEnv({ ODIN_PORT: bad, ODIN_CLOUD_MAX_PUSH_BYTES: bad }).port, 8080, bad);
  assert.equal(cloudServeConfigFromEnv({ ODIN_CLOUD_MAX_PUSH_BYTES: '0' }).maxPushBodyBytes, 8 * 1024 * 1024);
  assert.equal(cloudServeConfigFromEnv({ ODIN_CLOUD_INSECURE_NO_AUTH: 'yes' }).insecureNoAuth, true);
  assert.equal(cloudServeConfigFromEnv({ ODIN_CLOUD_INSECURE_NO_AUTH: '1', ODIN_CLOUD_TOKEN: 't' }).insecureNoAuth, false, 'con token no hay modo inseguro');
});

test('envBool, el secreto por defecto y la lista permitida', () => {
  for (const v of ['1', 'true', 'YES', ' on ']) assert.equal(envBool({ K: v }, 'K'), true, v);
  for (const v of ['0', 'false', '', 'si']) assert.equal(envBool({ K: v }, 'K'), false, v);
  assert.equal(envBool({}, 'K'), false);
  assert.equal(isDefaultJwtSecret(` ${DEFAULT_JWT_SECRET} `), true);
  assert.equal(isDefaultJwtSecret('otro'), false);
  assert.deepEqual(normalizeAllowedProjects(['MiRepo', 'mirepo', '  ', 'B']), ['mirepo', 'b']);
});

test('el arranque del servidor exige autenticación y lista de proyectos coherentes', () => {
  const warnings = [];
  const check = (env) => validateCloudServeAuthConfig(env, (m) => warnings.push(m));
  const fail = (env, pattern) => assert.throws(() => check(env), pattern, JSON.stringify(env));
  const secret = 'un-secreto-propio-largo-1234567890abcdef';

  assert.doesNotThrow(() => check({ ODIN_CLOUD_TOKEN: 't', ODIN_CLOUD_ALLOWED_PROJECTS: 'a', ODIN_JWT_SECRET: secret }));
  assert.doesNotThrow(() => check({ ODIN_CLOUD_TOKEN: 't', ODIN_CLOUD_ALLOWED_PROJECTS: '*', ODIN_JWT_SECRET: secret, ODIN_CLOUD_ADMIN: 'adm' }));
  assert.deepEqual(warnings, []);
  fail({ ODIN_CLOUD_TOKEN: 't', ODIN_CLOUD_ALLOWED_PROJECTS: 'a' }, /requires explicit ODIN_JWT_SECRET/);
  fail({ ODIN_CLOUD_TOKEN: 't', ODIN_CLOUD_ALLOWED_PROJECTS: 'a', ODIN_JWT_SECRET: DEFAULT_JWT_SECRET }, /requires a non-default ODIN_JWT_SECRET/);
  fail({ ODIN_CLOUD_TOKEN: 't', ODIN_CLOUD_INSECURE_NO_AUTH: '1' }, /conflicting cloud auth configuration/);
  fail({ ODIN_CLOUD_TOKEN: 't', ODIN_JWT_SECRET: secret }, /^Error: cloud project allowlist is required: set ODIN_CLOUD_ALLOWED_PROJECTS/);
  fail({}, /cloud auth token is required: set ODIN_CLOUD_TOKEN/);
  fail({ ODIN_CLOUD_INSECURE_NO_AUTH: '1' }, /allowlist is required even in insecure mode/);
  fail({ ODIN_CLOUD_INSECURE_NO_AUTH: '1', ODIN_CLOUD_ALLOWED_PROJECTS: 'a', ODIN_CLOUD_ADMIN: 'x' }, /ODIN_CLOUD_ADMIN is not supported/);
  assert.doesNotThrow(() => check({ ODIN_CLOUD_INSECURE_NO_AUTH: '1', ODIN_CLOUD_ALLOWED_PROJECTS: 'a' }));
  assert.deepEqual(warnings, ['warning: ODIN_CLOUD_INSECURE_NO_AUTH=1 disables cloud API authentication; do not use in production']);
});
