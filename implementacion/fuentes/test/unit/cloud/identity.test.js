import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudServer, CloudStore, Database, ManagedTokenHasher, generateManagedToken, normalizeProjectGrant } from '../../../src/cloud/server/index.js';
import { cliWorld } from '../cli/helpers.js';
import { startPostgres } from './pg-helper.js';

let pg;
const PEPPER = 'una-pimienta-dedicada-de-mas-de-treinta-y-dos-bytes';
before(async () => {
  pg = await startPostgres();
});
after(async () => {
  await pg?.stop();
});

async function start(options = {}) {
  const store = new CloudStore(Database.connect(await pg.createDatabase()));
  await store.migrate();
  const server = new CloudServer(store, { allowedProjects: ['legado'], token: 'tok', adminToken: 'adm', hasher: new ManagedTokenHasher(PEPPER), port: 0, log: () => {}, ...options });
  const { port } = await server.listen();
  return { store, server, dsn: store.db.pool.options.connectionString, url: `http://127.0.0.1:${port}`, close: async () => { await server.close(); await store.close(); } };
}

async function call(base, token, method, path, body) {
  const init = { method, headers: token ? { Authorization: `Bearer ${token}` } : {} };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

/** Un administrador gestionado con token, listo para usar la API. */
async function adminWithToken(s) {
  const user = await s.store.createFirstAdminHumanUser({ username: 'root' });
  const managed = generateManagedToken('live');
  await s.store.createPrincipalTokenWithAudit({ principalId: user.principal_id, tokenPrefix: managed.prefix, tokenHash: s.server.hasher.hash(managed.raw), createdByPrincipalId: user.principal_id }, null);
  return { user, token: managed.raw };
}

test('el token gestionado lleva prefijo, secreto y un resumen con pimienta', () => {
  const token = generateManagedToken('Mi Entorno!');
  assert.match(token.raw, /^odc_mi-entorno_[0-9a-f]{8}_[A-Za-z0-9-]{43}$/);
  assert.equal(token.raw, `${token.prefix}_${token.secret}`);
  assert.match(generateManagedToken('').prefix, /^odc_live_/);
  assert.match(generateManagedToken('***').prefix, /^odc_live_/);
  assert.notEqual(generateManagedToken().raw, generateManagedToken().raw);
  const hasher = new ManagedTokenHasher(PEPPER);
  const hash = hasher.hash(token.raw);
  assert.match(hash, /^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/);
  assert.equal(hasher.hash(` ${token.raw} `), hash, 'recorta');
  assert.equal(hasher.verify(token.raw, hash), true);
  assert.equal(hasher.verify(`${token.raw}x`, hash), false);
  assert.equal(hasher.verify(token.raw, 'hmac-sha256:v1:AAAA'), false);
  assert.equal(hasher.verify(token.raw, 'otro'), false);
  assert.equal(hasher.verify('', hash), false);
  assert.equal(hasher.verify(token.raw, `${'x'.repeat('hmac-sha256:v1:'.length)}${hash.slice('hmac-sha256:v1:'.length)}`), false, 'sin el prefijo de versión no vale');
  for (let i = 0; i < 40; i++) assert.match(generateManagedToken().secret, /^[A-Za-z0-9-]{43}$/, 'el secreto no usa guion bajo');
  assert.notEqual(new ManagedTokenHasher(`${PEPPER}x`).hash(token.raw), hash, 'otra pimienta, otro resumen');
  assert.throws(() => hasher.hash(' '), /managed token is required/);
  assert.throws(() => new ManagedTokenHasher(''), /pepper is required/);
  assert.throws(() => new ManagedTokenHasher('corta'), /at least 32 bytes/);
});

test('los permisos usan nombres canónicos limitados a letras, números, punto y guion bajo', () => {
  assert.equal(normalizeProjectGrant('Mi Repo/Sub'), 'mi-repo-sub');
  assert.equal(normalizeProjectGrant('a.b_c'), 'a.b_c');
  assert.equal(normalizeProjectGrant('--x--'), 'x');
  assert.equal(normalizeProjectGrant('  '), '');
});

test('el almacén protege al último administrador activo', async (t) => {
  const s = await start();
  t.after(s.close);
  const root = await s.store.createFirstAdminHumanUser({ username: 'root', email: 'r@x.org' });
  assert.deepEqual([root.display_name, root.role, root.enabled, root.email], ['root', 'admin', true, 'r@x.org']);
  await assert.rejects(s.store.createFirstAdminHumanUser({ username: 'otro' }), (e) => e.code === 'admin_already_exists');
  await assert.rejects(s.store.setHumanUserEnabled(root.principal_id, false), (e) => e.code === 'last_active_admin');
  const second = await s.store.createHumanUser({ username: 'segundo', role: 'admin', displayName: 'Dos' });
  assert.equal(second.display_name, 'Dos');
  await s.store.setHumanUserEnabled(root.principal_id, false);
  await assert.rejects(s.store.setHumanUserEnabled(second.principal_id, false), (e) => e.code === 'last_active_admin');
  await s.store.setHumanUserEnabled(root.principal_id, true);
  await assert.rejects(s.store.setHumanUserEnabled('999', true), (e) => e.code === 'not_found');
  assert.equal(await s.store.hasActiveAdmin(), true);
  await assert.rejects(s.store.createHumanUser({ username: '', role: 'member' }), /username is required/);
  await assert.rejects(s.store.createHumanUser({ username: 'x', role: 'dios' }), (e) => e.code === 'invalid_role');
  await assert.rejects(s.store.createHumanUser({ username: 'root', role: 'member' }), /duplicate key/);
  assert.deepEqual((await s.store.listHumanUsers()).map((u) => u.username), ['root', 'segundo']);
});

test('los tokens se emiten, se usan, se revocan y se rechazan según su titular', async (t) => {
  const s = await start();
  t.after(s.close);
  const user = await s.store.createHumanUser({ username: 'ana', role: 'member' });
  const params = (n) => ({ principalId: user.principal_id, tokenPrefix: `odc_live_0000000${n}`, tokenHash: `hmac-sha256:v1:hash${n}`, name: ' portátil ', createdByPrincipalId: '' });
  const created = await s.store.createPrincipalTokenWithAudit(params(1), { actorSource: 'request', action: 'token.create', outcome: 'success', metadata: { token_prefix: 'odc_live_00000001' } });
  assert.deepEqual([created.name, created.tokenPrefix, created.revokedAt, created.lastUsedAt], ['portátil', 'odc_live_00000001', null, null]);
  assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  await assert.rejects(s.store.createPrincipalTokenWithAudit({ ...params(2), tokenHash: ' ' }, null), /token hash is required/);
  await assert.rejects(s.store.createPrincipalTokenWithAudit({ ...params(2), tokenPrefix: '' }, null), /token prefix is required/);
  await assert.rejects(s.store.createPrincipalTokenWithAudit({ ...params(2), principalId: '' }, null), /principal id is required/);
  await assert.rejects(s.store.createPrincipalTokenWithAudit({ ...params(2), principalId: '999' }, null), (e) => e.code === 'principal_not_found');
  await assert.rejects(s.store.createPrincipalTokenWithAudit(params(2), { actorSource: '', action: 'x', outcome: 'y' }), (e) => e.code === 'audit_insert_failed');
  assert.equal((await s.store.listPrincipalTokens(user.principal_id)).length, 1, 'un fallo de auditoría deshace el token');

  const found = await s.store.findPrincipalTokenByHash('hmac-sha256:v1:hash1');
  assert.deepEqual([found.token.id, found.principal.id, found.principal.role], [created.id, user.principal_id, 'member']);
  await assert.rejects(s.store.findPrincipalTokenByHash('nada'), (e) => e.code === 'token_not_found');
  await assert.rejects(s.store.findPrincipalTokenByHash(' '), /token hash is required/);

  await s.store.markPrincipalTokenUsed(created.id);
  assert.ok((await s.store.listPrincipalTokens(user.principal_id))[0].lastUsedAt);
  await assert.rejects(s.store.markPrincipalTokenUsed('999'), (e) => e.code === 'token_not_found');
  await s.store.setHumanUserEnabled(user.principal_id, false);
  await assert.rejects(s.store.markPrincipalTokenUsed(created.id), (e) => e.code === 'principal_disabled');
  await assert.rejects(s.store.createPrincipalTokenWithAudit(params(3), null), (e) => e.code === 'principal_disabled');
  await s.store.setHumanUserEnabled(user.principal_id, true);
  await s.store.revokePrincipalToken(created.id, '', ' perdido ');
  await assert.rejects(s.store.markPrincipalTokenUsed(created.id), (e) => e.code === 'token_revoked');
  const [revoked] = await s.store.listPrincipalTokens(user.principal_id);
  assert.deepEqual([Boolean(revoked.revokedAt), revoked.revocationReason], [true, 'perdido']);
  await assert.rejects(s.store.revokePrincipalToken('999', '', ''), (e) => e.code === 'not_found');
});

test('la auditoría de autenticación nunca guarda secretos', async (t) => {
  const s = await start();
  t.after(s.close);
  const ok = (metadata) => s.store.insertAuthAuditEvent({ actorSource: 'request', action: 'x.y', outcome: 'denied', metadata });
  await ok({ token_prefix: 'odc_live_aaaa', issued_token: true, nota: 'bien' });
  await ok(undefined);
  for (const key of ['token', 'Authorization', 'cookie_x', 'secreto_secret', 'password', 'hash', 'bearer', 'issued_token']) {
    await assert.rejects(ok({ [key]: key === 'issued_token' ? 'texto' : 'v' }), /sensitive auth audit metadata is not allowed/, key);
  }
  await assert.rejects(ok({ anidado: { raw_token: 'x' } }), /not allowed: raw_token/);
  await assert.rejects(ok({ lista: [{ hash: 'x' }] }), /not allowed: hash/);
  await assert.rejects(s.store.insertAuthAuditEvent({ actorSource: '', action: 'a', outcome: 'o' }), /actor source is required/);
  await assert.rejects(s.store.insertAuthAuditEvent({ actorSource: 's', action: '', outcome: 'o' }), /action is required/);
  await assert.rejects(s.store.insertAuthAuditEvent({ actorSource: 's', action: 'a', outcome: '' }), /outcome is required/);
  const events = await s.store.listAuthAuditEvents({ limit: 1 });
  assert.equal(events.length, 1);
  assert.equal((await s.store.listAuthAuditEvents({ limit: 0 })).length, 2);
  assert.deepEqual(events[0].metadata, {});
});

test('un principal gestionado entra con su token y solo ve los proyectos que se le concedieron', async (t) => {
  const s = await start();
  t.after(s.close);
  const { user: root, token: rootToken } = await adminWithToken(s);
  const created = await call(s.url, rootToken, 'POST', '/admin/users', { username: 'ana', display_name: 'Ana' });
  assert.equal(created.status, 201);
  const ana = created.json.principal_id;
  const issued = await call(s.url, rootToken, 'POST', `/admin/users/${ana}/tokens`, { name: 'x' });
  assert.equal(issued.status, 201);
  assert.match(issued.json.raw_token, /^odc_live_/);
  assert.equal(issued.json.token.created_by_principal_id, root.principal_id);
  const anaToken = issued.json.raw_token;
  assert.equal((await call(s.url, rootToken, 'POST', `/admin/users/${ana}/grants`, { project: 'Demo' })).status, 201);

  const chunk = { project: 'demo', created_by: 'ana', data: { sessions: [{ id: 's1', directory: '/x' }], observations: [], prompts: [] } };
  assert.equal((await call(s.url, anaToken, 'POST', '/sync/push', chunk)).status, 200);
  const other = await call(s.url, anaToken, 'POST', '/sync/push', { ...chunk, project: 'legado' });
  assert.deepEqual([other.status, other.json.error_code], [403, 'policy_forbidden'], 'la lista del servidor no vale para un principal gestionado');
  assert.equal((await s.store.db.query("SELECT created_by FROM cloud_chunks"))[0].created_by, 'ana');
  assert.equal((await call(s.url, 'tok', 'GET', '/sync/pull?project=legado')).status, 200, 'el token del entorno sigue la lista');
  assert.equal((await call(s.url, 'tok', 'GET', '/sync/pull?project=demo')).status, 403);
  const pull = await call(s.url, anaToken, 'GET', '/sync/mutations/pull');
  assert.deepEqual([pull.status, pull.json.mutations.map((m) => m.project), pull.json.project], [200, ['demo'], 'demo']);
  assert.equal((await call(s.url, 'tok', 'GET', '/sync/mutations/pull')).json.mutations.length, 0, 'el del entorno solo ve los suyos');
  assert.ok((await s.store.listPrincipalTokens(ana))[0].lastUsedAt, 'cada uso queda anotado');

  const denied = await s.store.listAuthAuditEvents({ limit: 50 });
  assert.ok(denied.some((e) => e.action === 'sync.authorize' && e.outcome === 'denied' && e.project === 'legado' && e.actorPrincipalId === ana && e.actorSource === 'managed_token'));
  assert.ok(denied.some((e) => e.action === 'grant.create'));

  await call(s.url, rootToken, 'POST', `/admin/users/${ana}/disable`);
  const off = await call(s.url, anaToken, 'GET', '/sync/pull?project=demo');
  assert.deepEqual([off.status, off.text], [401, 'unauthorized: principal is disabled\n']);
  await call(s.url, rootToken, 'POST', `/admin/users/${ana}/enable`);
  await call(s.url, rootToken, 'POST', `/admin/tokens/${issued.json.token.id}/revoke`, { reason: 'x' });
  assert.equal((await call(s.url, anaToken, 'GET', '/sync/pull?project=demo')).text, 'unauthorized: token is revoked\n');
  assert.equal((await call(s.url, 'odc_live_00000000_nada', 'GET', '/sync/pull?project=demo')).text, 'unauthorized: unknown token\n');
  const reasons = (await s.store.listAuthAuditEvents({ limit: 50 })).filter((e) => e.action === 'sync.auth').map((e) => e.reasonCode);
  assert.deepEqual(reasons.sort(), ['principal_disabled', 'token_revoked', 'unknown_token']);
});

test('sin pimienta solo valen los tokens del entorno', async (t) => {
  const s = await start({ hasher: null });
  t.after(s.close);
  const user = await s.store.createFirstAdminHumanUser({ username: 'root' });
  await s.store.createPrincipalTokenWithAudit({ principalId: user.principal_id, tokenPrefix: 'odc_live_aaaaaaaa', tokenHash: 'hmac-sha256:v1:x' }, null);
  assert.equal((await call(s.url, 'odc_live_aaaaaaaa_x', 'GET', '/sync/pull?project=legado')).text, 'unauthorized: unknown token\n');
  assert.equal((await call(s.url, 'adm', 'GET', '/sync/pull?project=legado')).status, 200);
  const admin = await call(s.url, 'adm', 'GET', '/admin/users');
  assert.deepEqual([admin.status, admin.json.error], [403, 'forbidden: managed admin principal is required'], 'el administrador del entorno no usa /admin');
  assert.equal((await call(s.url, 'tok', 'POST', '/admin/users/1/tokens', {})).status, 403);
});

test('la API de administración valida cuerpos y respeta las reglas', async (t) => {
  const s = await start();
  t.after(s.close);
  const { user: root, token } = await adminWithToken(s);
  const admin = (method, path, body) => call(s.url, token, method, path, body);
  const code = async (promise) => (await promise).json?.error_code;
  const status = async (promise) => (await promise).status;
  assert.equal(await code(admin('POST', '/admin/users', '{')), 'upgrade_repairable_payload_invalid');
  assert.equal(await code(admin('POST', '/admin/users', { username: 'x', extra: 'y' })), 'upgrade_repairable_payload_invalid');
  assert.equal(await code(admin('POST', '/admin/users', 'null')), 'upgrade_repairable_payload_invalid', 'null equivale a sin usuario');
  assert.equal(await code(admin('POST', '/admin/users', { username: 5 })), 'upgrade_repairable_payload_invalid');
  assert.equal(await code(admin('POST', '/admin/users', { username: 'x', role: 'dios' })), 'upgrade_repairable_payload_invalid');
  assert.equal(await status(admin('POST', '/admin/users', '')), 400, 'cuerpo vacío = sin usuario');
  const member = (await admin('POST', '/admin/users', { username: 'm' })).json;
  assert.equal(member.role, 'member', 'rol por defecto');
  assert.equal(await status(admin('POST', `/admin/users/${root.principal_id}/disable`)), 400, 'el último administrador');
  assert.equal(await status(admin('POST', '/admin/users/999/tokens', {})), 404);
  assert.equal(await status(admin('POST', `/admin/users/${member.principal_id}/disable`)), 200);
  const refused = await admin('POST', `/admin/users/${member.principal_id}/tokens`, {});
  assert.deepEqual([refused.status, refused.json.error_code, refused.json.error], [409, 'policy_forbidden', `managed user "${member.principal_id}" is disabled; enable the user before creating a managed token`]);
  assert.equal(await status(admin('POST', '/admin/tokens/999/revoke', {})), 400);
  assert.equal(await status(admin('POST', '/admin/tokens/1/revoke', { reason: 5 })), 400);
  assert.equal(await status(admin('POST', `/admin/users/${member.principal_id}/grants`, { project: ' ' })), 400);
  assert.equal(await status(admin('GET', '/admin/users/abc/grants')), 500);
  const grant = await admin('POST', `/admin/users/${member.principal_id}/grants`, { project: 'A B' });
  assert.deepEqual([grant.status, grant.json.project, grant.json.granted_by_principal_id], [201, 'a-b', root.principal_id]);
  assert.equal((await admin('POST', `/admin/users/${member.principal_id}/grants`, { project: 'a-b' })).status, 201, 'repetir es inocuo');
  assert.equal((await admin('GET', `/admin/users/${member.principal_id}/grants`)).json.length, 1);
  assert.equal(await status(admin('POST', `/admin/users/${member.principal_id}/grants/A%20B/revoke`)), 200);
  assert.equal((await admin('GET', `/admin/users/${member.principal_id}/grants`)).json.length, 0);
  const noHasher = await start({ hasher: null });
  t.after(noHasher.close);
  assert.equal(await status(call(noHasher.url, 'adm', 'POST', '/admin/users/1/tokens', {})), 403);
});

test('la autoridad de sesión, los reclamos y la atestación exigen permisos vigentes', async (t) => {
  const s = await start();
  t.after(s.close);
  const { token: rootToken } = await adminWithToken(s);
  const ana = (await call(s.url, rootToken, 'POST', '/admin/users', { username: 'ana' })).json.principal_id;
  const anaToken = (await call(s.url, rootToken, 'POST', `/admin/users/${ana}/tokens`, {})).json.raw_token;
  for (const project of ['dueno', 'prompts']) await call(s.url, rootToken, 'POST', `/admin/users/${ana}/grants`, { project });
  const post = (token, path, body) => call(s.url, token, 'POST', path, body);
  const claim = { session_id: 's1', source_inbox_id: 'in1', sync_id: 'p1', owner_project: 'dueno', project: 'prompts' };
  const attest = { session_id: 's1', source_inbox_id: 'in1', sync_id: 'p1', owner_project: 'dueno', prompt_project: 'prompts' };

  assert.equal((await post(anaToken, '/sync/prompt-pair-claims', claim)).json.error_code, 'session_authority_unavailable');
  assert.equal((await post(anaToken, '/sync/session-authorities', { session_id: 's1', project: 'dueno' })).status, 200);
  assert.equal((await post(anaToken, '/sync/session-authorities', { session_id: 's1', project: 'prompts' })).status, 409);
  assert.equal((await post(anaToken, '/sync/prompt-pair-claims', claim)).status, 200);
  assert.equal((await post(anaToken, '/sync/prompt-pair-claims', { ...claim, sync_id: 'p2' })).text, 'prompt pair claim conflict\n');
  assert.equal((await post(anaToken, '/sync/prompt-pair-claims', { ...claim, owner_project: 'prompts' })).status, 404);
  assert.equal((await post(anaToken, '/sync/prompt-pair-claims', { ...claim, extra: 1 })).text, 'invalid prompt pair claim request\n');
  assert.equal((await post(anaToken, '/sync/prompt-pair-claims', { ...claim, sync_id: ' ' })).status, 400);
  assert.equal((await post(anaToken, '/sync/prompt-pair-claims', { ...claim, sync_id: 5 })).text, 'invalid prompt pair claim request\n', 'tipos estrictos');

  const done = await post(anaToken, '/sync/prompt-source-attestations', attest);
  assert.deepEqual([done.status, done.json.status, done.json.attestation_id > 0], [200, 'ok', true]);
  assert.equal((await post(rootToken, '/sync/prompt-source-attestations', attest)).text, 'owner project forbidden\n', 'el administrador sin permiso no atestigua');
  const legacy = await post('tok', '/sync/prompt-source-attestations', attest);
  assert.deepEqual([legacy.status, legacy.text], [403, 'human principal required\n'], 'solo personas');
  assert.equal((await post(anaToken, '/sync/prompt-source-attestations', { ...attest, sync_id: 'otro' })).text, 'prompt pair conflict\n');
  assert.equal((await post(anaToken, '/sync/prompt-source-attestations', { ...attest, session_id: 's9', sync_id: 'p9', source_inbox_id: 'in9' })).status, 200, 'registra la sesión y el par');
  const verify = (body, token = anaToken) => post(token, '/sync/prompt-source-attestations/verify', body);
  assert.equal((await verify({ audit_id: done.json.attestation_id, ...attest })).status, 200);
  assert.equal((await verify({ audit_id: done.json.attestation_id, ...attest, sync_id: 'x' })).text, 'attestation binding conflict\n');
  assert.equal((await verify({ audit_id: 0, ...attest })).status, 400);
  assert.equal((await verify({ audit_id: 'uno', ...attest })).status, 400);
  assert.equal((await verify({ audit_id: done.json.attestation_id, ...attest }, 'tok')).status, 403, 'sin permisos vigentes');
  assert.equal((await post(anaToken, '/sync/prompt-source-attestations', attest)).json.attestation_id > done.json.attestation_id, true, 'cada atestación es un registro nuevo');
});

test('sin autenticación no hay procedencia de prompts', async (t) => {
  const s = await start({ token: '', allowedProjects: ['demo'] });
  t.after(s.close);
  assert.equal((await call(s.url, '', 'POST', '/sync/session-authorities', { session_id: 's', project: 'demo' })).text, 'authentication unavailable\n');
  assert.equal((await call(s.url, '', 'POST', '/sync/prompt-pair-claims', {})).status, 401);
  assert.equal((await call(s.url, '', 'POST', '/sync/prompt-source-attestations', {})).text, 'human authentication required\n');
  assert.equal((await call(s.url, '', 'POST', '/sync/prompt-source-attestations/verify', {})).status, 401);
});

test('cloud bootstrap crea el primer administrador y no admite un segundo', async (t) => {
  const w = cliWorld(t);
  const dsn = await pg.createDatabase();
  const env = { ODIN_DATABASE_URL: dsn, ODIN_CLOUD_TOKEN_PEPPER: PEPPER };
  const out = await w.odin(['cloud', 'bootstrap', 'admin', '--username', 'root', '--grant-project', 'Demo', '--issue-token', 'raíz'], { env });
  assert.equal(out.code, 0, out.err);
  assert.match(out.out, /^✓ Managed admin created: username=root principal_id=1\n✓ Project grant created: project=demo\n\nToken issued — SHOWN ONCE, copy and store it now, it cannot be retrieved again:\nodc_live_[0-9a-f]{8}_[A-Za-z0-9-]+\n$/);
  const dup = await w.odin(['cloud', 'bootstrap', 'admin', '--username', 'otro'], { env });
  assert.deepEqual([dup.code, dup.err], [1, 'error: a managed admin already exists; refusing to create a duplicate first admin via CLI bootstrap\n']);
  const store = new CloudStore(Database.connect(dsn));
  t.after(() => store.close());
  const audit = (await store.listAuthAuditEvents({ limit: 10 })).map((e) => `${e.action}/${e.outcome}/${e.reasonCode}`).reverse();
  assert.deepEqual(audit, ['bootstrap.cli/success/', 'bootstrap.cli/success/bootstrap_completed', 'bootstrap.cli/denied/managed_admin_already_exists']);
  assert.equal((await store.listPrincipalTokens('1'))[0].name, 'raíz');

  const noPepper = await w.odin(['cloud', 'bootstrap', 'admin', '--username', 'x', '--issue-token'], { env: { ODIN_DATABASE_URL: dsn } });
  assert.match(noPepper.err, /--issue-token requires ODIN_CLOUD_TOKEN_PEPPER/);
  const bad = await w.odin(['cloud', 'bootstrap', 'admin', '--username', 'x', '--wat'], { env });
  assert.match(bad.err, /error: unknown flag: --wat/);
  assert.match(bad.out, /usage: odin cloud bootstrap admin/);
  assert.match((await w.odin(['cloud', 'bootstrap'], { env })).err, /a bootstrap subcommand is required/);
  assert.match((await w.odin(['cloud', 'bootstrap', 'raro'], { env })).err, /unknown cloud bootstrap subcommand: raro/);
  assert.equal((await w.odin(['cloud', 'bootstrap', '--help'])).code, 0);

  // recover-token: el administrador atascado sin token.
  const stranded = await pg.createDatabase();
  const strandedEnv = { ODIN_DATABASE_URL: stranded, ODIN_CLOUD_TOKEN_PEPPER: PEPPER };
  await w.odin(['cloud', 'bootstrap', 'admin', '--username', 'solo'], { env: strandedEnv });
  const recovered = await w.odin(['cloud', 'bootstrap', 'recover-token', '--name', 'rescate'], { env: strandedEnv });
  assert.equal(recovered.code, 0, recovered.err);
  assert.match(recovered.out, /^Managed admin token recovered — SHOWN ONCE.*\nodc_live_/);
  const again = await w.odin(['cloud', 'bootstrap', 'recover-token'], { env: strandedEnv });
  assert.match(again.err, /requires zero principal tokens, found 1/);
  const replaced = await w.odin(['cloud', 'bootstrap', 'recover-token', '--revoke-existing'], { env: strandedEnv });
  assert.equal(replaced.code, 0, replaced.err);
  const noPep = await w.odin(['cloud', 'bootstrap', 'recover-token'], { env: { ODIN_DATABASE_URL: stranded } });
  assert.match(noPep.err, /recover-token requires ODIN_CLOUD_TOKEN_PEPPER/);
  assert.match((await w.odin(['cloud', 'bootstrap', 'recover-token', '--name'], { env: strandedEnv })).err, /--name requires a value/);
});

test('la recuperación del administrador atascado exige un único administrador y tokens sin uso', async (t) => {
  const s = await start();
  t.after(s.close);
  const recover = (revokeExisting = false) => s.store.recoverStrandedAdminTokenWithAudit({ tokenPrefix: `odc_live_${Math.random().toString(16).slice(2, 10)}`, tokenHash: `hmac-sha256:v1:${Math.random()}`, revokeExisting }, {});
  await assert.rejects(recover(), /found 0/);
  const a = await s.store.createHumanUser({ username: 'a', role: 'admin' });
  const b = await s.store.createHumanUser({ username: 'b', role: 'admin' });
  await assert.rejects(recover(), (e) => e.code === 'recovery_ineligible' && /found 2/.test(e.message));
  await s.store.setHumanUserEnabled(b.principal_id, false);
  const first = await recover();
  assert.equal(first.principalId, a.principal_id);
  await assert.rejects(recover(), /requires zero principal tokens, found 1/);
  await s.store.markPrincipalTokenUsed(first.id);
  await assert.rejects(recover(true), /unused active token/);
  const extra = await s.store.createPrincipalTokenWithAudit({ principalId: a.principal_id, tokenPrefix: 'odc_live_zzzzzzzz', tokenHash: 'hmac-sha256:v1:zz' }, null);
  await assert.rejects(recover(true), /exactly one active principal token, found 2/);
  await s.store.revokePrincipalToken(first.id, '', '');
  await s.store.revokePrincipalToken(extra.id, '', '');
  await assert.rejects(recover(true), /exactly one active principal token, found 0/);
});

test('un reclamo sin autoridad de sesión registrada se rechaza', async (t) => {
  const s = await start();
  t.after(s.close);
  await assert.rejects(s.store.claimPromptPair('s1', 'in1', 'p1', 'demo', 'a'), (e) => e.code === 'session_authority_not_found');
  await s.store.registerSessionAuthority('s1', 'dueno', 'a');
  await s.store.claimPromptPair('s1', 'in1', 'p1', 'demo', 'a');
  await assert.rejects(s.store.claimPromptPair('s1', 'in2', 'p1', 'demo', 'a'), (e) => e.code === 'prompt_pair_claim_conflict');
  await assert.rejects(s.store.claimPromptPair('s1', '', 'p1', 'demo', 'a'), /are required/);
  assert.equal(await s.store.verifyPromptSourceAttestation(0, 's1', 'in1', 'p1', 'dueno', 'demo'), false);
});
