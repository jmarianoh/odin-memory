import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudServer, CloudStore, Database, ManagedTokenHasher, generateManagedToken } from '../../../src/cloud/server/index.js';
import { addPrompt, createSession, deletePrompt } from '../../../src/store/index.js';
import { PromptSourceConfirmationError, confirmPromptSourceAttestation, previewPromptSource } from '../../../src/store/prompt-source.js';
import { cliWorld } from '../cli/helpers.js';
import { startPostgres } from './pg-helper.js';

let pg;
before(async () => {
  pg = await startPostgres();
});
after(async () => {
  await pg?.stop();
});

const PEPPER = 'una-pimienta-dedicada-de-mas-de-treinta-y-dos-bytes';
const REMOTE = 'https://nube.example';

/** Servidor real con una persona que tiene permiso sobre `dueno` y `demo`, y un `fetch` que lo alcanza desde la URL ficticia. */
async function remote(t) {
  const store = new CloudStore(Database.connect(await pg.createDatabase()));
  await store.migrate();
  const server = new CloudServer(store, { allowedProjects: ['*'], token: 'tok', hasher: new ManagedTokenHasher(PEPPER), port: 0, log: () => {} });
  const { port } = await server.listen();
  t.after(async () => {
    await server.close();
    await store.close();
  });
  const admin = await store.createFirstAdminHumanUser({ username: 'root' });
  const ana = await store.createHumanUser({ username: 'ana', role: 'member' });
  const token = generateManagedToken('live');
  await store.createPrincipalTokenWithAudit({ principalId: ana.principal_id, tokenPrefix: token.prefix, tokenHash: server.hasher.hash(token.raw), createdByPrincipalId: admin.principal_id }, null);
  for (const project of ['dueno', 'demo']) await store.createProjectGrant({ principalId: ana.principal_id, project, grantedByPrincipalId: admin.principal_id });
  const calls = [];
  const fetchThrough = (url, init) => {
    calls.push(String(url));
    return fetch(String(url).replace(REMOTE, `http://127.0.0.1:${port}`), init);
  };
  return { store, token: token.raw, fetch: fetchThrough, calls, ana };
}

function seededWorld(t, r) {
  const w = cliWorld(t);
  const local = w.store();
  createSession(local, 's1', 'dueno', '/x');
  const { id } = addPrompt(local, { session_id: 's1', content: 'hola', project: 'demo', source_inbox_id: 'in1' });
  const syncId = local.db.get('SELECT sync_id FROM user_prompts WHERE id = ?', id).sync_id;
  local.close();
  const run = (args, input, extra = {}) => w.odin(['cloud', 'attest-prompt-source', ...args], { input, env: { ODIN_CLOUD_SERVER: REMOTE, ODIN_CLOUD_TOKEN: r.token, ...extra.env }, overrides: { fetch: r.fetch } });
  return { w, syncId, run };
}

test('la atestación muestra el origen observado, pide confirmación y guarda la respuesta remota', async (t) => {
  const r = await remote(t);
  const { w, syncId, run } = seededWorld(t, r);
  const ok = await run(['--sync-id', syncId, '--owner-project', 'dueno'], 'yes\n');
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, `Observed source: session="s1" source_inbox="in1" sync_id="${syncId}" prompt_project="demo" kind="live"\nHuman-asserted owner: "dueno"\nSend this exact tuple for remote attestation? Type yes or no: Remote attestation ID 1 confirmed locally for sync ID "${syncId}"\n`);
  const [confirmation] = w.store().db.all('SELECT * FROM prompt_source_confirmations');
  assert.deepEqual([confirmation.remote_target, confirmation.sync_id, confirmation.session_id, confirmation.source_inbox_id, confirmation.prompt_project, confirmation.kind, confirmation.asserted_owner_project, confirmation.remote_attestation_id],
    [REMOTE, syncId, 's1', 'in1', 'demo', 'live', 'dueno', 1]);
  const remoteRows = await r.store.db.query('SELECT session_id, source_inbox_id, sync_id, owner_project, prompt_project, actor_id FROM cloud_prompt_source_attestations');
  assert.deepEqual(remoteRows, [{ session_id: 's1', source_inbox_id: 'in1', sync_id: syncId, owner_project: 'dueno', prompt_project: 'demo', actor_id: r.ana.principal_id }]);

  const again = await run(['--sync-id', syncId, '--owner-project', 'dueno'], 'yes\n');
  assert.equal(again.code, 0, 'repetir deja una atestación remota nueva y actualiza la confirmación');
  assert.equal(w.store().db.get('SELECT remote_attestation_id AS id FROM prompt_source_confirmations').id, 2);
});

test('la atestación se rechaza sin confirmar, sin configuración o con datos que no cuadran', async (t) => {
  const r = await remote(t);
  const { w, syncId, run } = seededWorld(t, r);
  const fail = async (args, input, pattern, extra) => {
    const result = await run(args, input, extra);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.err, pattern, args.join(' '));
    return result;
  };
  const USAGE = 'usage: odin cloud attest-prompt-source --sync-id <exact-sync-id> --owner-project <asserted-owner>';
  assert.equal((await run(['--help'], '')).out, `${USAGE}\n`);
  await fail([], '', new RegExp(`^${USAGE}\nodin: one exact sync ID and an asserted owner project are required\n$`));
  await fail(['--sync-id', ' ', '--owner-project', 'x'], '', /one exact sync ID/);
  await fail(['--owner-project', 'x', '--sync-id', 'y'], '', /one exact sync ID/);
  await fail(['--sync-id', 'nada', '--owner-project', 'dueno'], 'yes\n', /no unambiguous complete prompt source preview for exact sync ID/);
  const declined = await fail(['--sync-id', syncId, '--owner-project', 'dueno'], 'no\n', /attestation declined; no remote call made/);
  assert.match(declined.out, /Type yes or no: $/);
  await fail(['--sync-id', syncId, '--owner-project', 'dueno'], 'tal vez\n', /invalid confirmation; type yes or no; no remote call made/);
  await fail(['--sync-id', syncId, '--owner-project', 'dueno'], '', /invalid confirmation/);
  assert.deepEqual(r.calls, [], 'sin confirmar no hay llamada remota');
  assert.equal((await r.store.db.query('SELECT 1 FROM cloud_prompt_source_attestations')).length, 0);

  const noServer = await w.odin(['cloud', 'attest-prompt-source', '--sync-id', syncId, '--owner-project', 'dueno']);
  assert.match(noServer.err, /^odin: cloud server URL is required\n$/);
  await fail(['--sync-id', syncId, '--owner-project', 'dueno'], 'yes\n', /^odin: invalid cloud server URL\n$/, { env: { ODIN_CLOUD_SERVER: 'ftp://x' } });
  await fail(['--sync-id', syncId, '--owner-project', 'dueno'], 'yes\n', /cloud server URL credentials are not allowed/, { env: { ODIN_CLOUD_SERVER: 'https://u:p@nube.example' } });
  await fail(['--sync-id', syncId, '--owner-project', 'dueno'], 'yes\n', /human bearer token required for remote dual-grant enforcement/, { env: { ODIN_CLOUD_TOKEN: '' } });
  // El dueño afirmado lo comprueba el servidor: un proyecto sin permiso concedido se rechaza.
  await fail(['--sync-id', syncId, '--owner-project', 'ajeno'], 'yes\n', /remote attestation failed: .*owner project forbidden/);
  await fail(['--sync-id', syncId, '--owner-project', 'dueno'], 'yes\n', /remote attestation failed/, { env: { ODIN_CLOUD_TOKEN: 'tok' } });
  assert.equal(w.store().db.all('SELECT 1 FROM prompt_source_confirmations').length, 0);
});

test('la vista previa y la confirmación local exigen un origen único y coherente', (t) => {
  const w = cliWorld(t);
  const store = w.store();
  createSession(store, 's1', 'dueno', '/x');
  const { id } = addPrompt(store, { session_id: 's1', content: 'hola', project: 'demo', source_inbox_id: 'in1' });
  const syncId = store.db.get('SELECT sync_id FROM user_prompts WHERE id = ?', id).sync_id;
  const preview = previewPromptSource(store, syncId);
  assert.deepEqual(preview, { sessionId: 's1', sourceInboxId: 'in1', project: 'demo', syncId, kind: 'live' });
  assert.equal(previewPromptSource(store, ''), null);
  assert.equal(previewPromptSource(store, 'otro'), null);
  addPrompt(store, { session_id: 's1', content: 'sin buzón', project: 'demo' });
  const plain = store.db.get('SELECT sync_id FROM user_prompts WHERE source_inbox_id IS NULL').sync_id;
  assert.equal(previewPromptSource(store, plain), null, 'sin buzón el origen está incompleto');

  const confirm = (overrides = {}) => confirmPromptSourceAttestation(store, overrides.target ?? REMOTE, 'preview' in overrides ? overrides.preview : preview, overrides.owner ?? 'dueno', overrides.id ?? 5);
  for (const bad of [{ target: ' ' }, { owner: ' ' }, { id: 0 }, { id: -1 }, { preview: { ...preview, project: '' } }, { preview: { ...preview, kind: 'otro' } }, { preview: null }]) {
    assert.throws(() => confirm(bad), PromptSourceConfirmationError, JSON.stringify(bad));
  }
  assert.throws(() => confirm({ preview: { ...preview, project: 'otro' } }), PromptSourceConfirmationError, 'lo observado cambió');
  assert.throws(() => confirm({ owner: 'ajeno' }), PromptSourceConfirmationError, 'la sesión viva contradice al dueño afirmado');
  confirm();
  const row = () => ({ ...store.db.get('SELECT kind, remote_attestation_id AS id FROM prompt_source_confirmations') });
  assert.deepEqual(row(), { kind: 'live', id: 5 });
  confirm();
  assert.equal(row().id, 5, 'el mismo id y tipo es inocuo');
  assert.throws(() => confirm({ id: 4 }), PromptSourceConfirmationError, 'un id menor retrocede');
  assert.throws(() => confirm({ owner: 'otro-dueno' }), PromptSourceConfirmationError, 'otro dueño para la misma confirmación');
  confirm({ id: 6 });
  assert.equal(row().id, 6);

  deletePrompt(store, id);
  const deleted = previewPromptSource(store, syncId);
  assert.equal(deleted.kind, 'deleted', 'la lápida también es origen observable');
  assert.throws(() => confirm({ preview: deleted, id: 6 }), PromptSourceConfirmationError, 'mismo id pero distinto tipo');
  confirm({ preview: deleted, id: 7 });
  assert.deepEqual(row(), { kind: 'deleted', id: 7 });
  store.db.run("UPDATE sessions SET project = '' WHERE id = 's1'");
  assert.doesNotThrow(() => confirm({ preview: deleted, id: 8 }), 'una sesión sin dueño no contradice');
  assert.throws(() => confirm({ preview: deleted, id: 9, owner: 'otro' }), PromptSourceConfirmationError, 'otro dueño para la misma confirmación');
  // Dos filas con el mismo sync_id (viva y lápida) son ambiguas.
  store.db.run("INSERT INTO user_prompts (sync_id, session_id, content, project, source_inbox_id) VALUES (?, 's1', 'otra', 'demo', 'in2')", syncId);
  assert.equal(previewPromptSource(store, syncId), null, 'ambiguo');
  store.close();
});
