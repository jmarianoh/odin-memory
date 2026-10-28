// Detalles que las pruebas de ruta no fijan: límites, avisos de escritura, redondeos y errores opacos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { requireConfiguredAuth } from '../../../src/server/auth.js';
import { HttpError } from '../../../src/server/http.js';
import { HttpServer, runtimeContractProjection } from '../../../src/server/index.js';
import { clampLimit, contextBytes } from '../../../src/server/routes/context.js';
import { storeSyncStatus } from '../../../src/server/sync-status.js';
import { removeOwnedSocket } from '../../../src/server/unix-socket.js';
import { jsonMarshal } from '../../../src/mcp/json.js';
import { getObservation, saveRelation } from '../../../src/store/index.js';
import { openTempStore } from '../store/helpers.js';
import { resolveServeOptions, validateSessionOwned } from '../../../src/cli/commands/serve.js';
import { httpWorld } from './helpers.js';

const ok = (r, status = 200) => {
  assert.equal(r.status, status, r.text);
  return r.json;
};

test('requireConfiguredAuth exige un token configurado y luego lo valida', () => {
  const ctx = (env, authorization, sessionOwned = false) => ({ env, req: { headers: authorization ? { authorization } : {} }, sessionOwned });
  assert.throws(() => requireConfiguredAuth(ctx({}, undefined)), (e) => e instanceof HttpError && e.status === 503 && e.message === 'server authorization is not configured');
  assert.throws(() => requireConfiguredAuth(ctx({ ODIN_HTTP_TOKEN: '' }, 'Bearer x')), (e) => e.status === 503);
  assert.throws(() => requireConfiguredAuth(ctx({ ODIN_HTTP_TOKEN: 's' }, undefined)), (e) => e.status === 401);
  assert.throws(() => requireConfiguredAuth(ctx({ ODIN_HTTP_TOKEN: 's' }, 'Bearer x')), (e) => e.status === 401 && e.message === 'invalid token');
  assert.doesNotThrow(() => requireConfiguredAuth(ctx({ ODIN_HTTP_TOKEN: 's' }, 'Bearer s')));
  assert.doesNotThrow(() => requireConfiguredAuth(ctx({}, undefined, true)));
});

test('el servidor escucha solo en el bucle local y su puerto por defecto es 7438', async (t) => {
  const w = await httpWorld(t);
  assert.equal(w.server.http.address().address, '127.0.0.1');
  assert.equal(new HttpServer(openTempStore(t)).port, 7438);
});

test('removeOwnedSocket solo borra el socket que creó el proceso', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'odin-own-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spawnSocket = async (path) => {
    const child = spawn(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("listo"))', path], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((resolve) => child.stdout.once('data', resolve));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  };
  const path = join(dir, 'a.sock');
  await spawnSocket(path);
  const mine = lstatSync(path);
  rmSync(path);
  await spawnSocket(path); // otro proceso lo vuelve a crear: otro inodo
  removeOwnedSocket(path, mine);
  assert.equal(existsSync(path), true, 'no borra un socket ajeno');
  removeOwnedSocket(path, lstatSync(path));
  assert.equal(existsSync(path), false);
  removeOwnedSocket(path, mine); // ya no existe: no falla
  removeOwnedSocket('', mine);
  removeOwnedSocket(path, null);
  writeFileSync(path, 'x');
  removeOwnedSocket(path, lstatSync(path));
  assert.equal(existsSync(path), true, 'un archivo que no es socket no se toca');
});

test('proyecto: exactamente un valor, ambigüedad y lista vacía', async (t) => {
  const w = await httpWorld(t);
  assert.equal((await w.call('GET', '/stats?project=a&project=b')).json.code, 'invalid_project');
  assert.equal((await w.call('GET', '/stats?all_projects=true&all_projects=false')).json.code, 'invalid_project');
  assert.equal((await w.call('GET', '/stats?all_projects=true&project=demo')).json.error, 'project resolution failed: invalid project name: project and all_projects cannot be used together');
  const unknown = await w.call('GET', '/sessions/recent?project=nada');
  assert.equal(unknown.json.available_projects, null);
  await w.seed();
  assert.deepEqual((await w.call('GET', '/sessions/recent?project=nada')).json.available_projects, ['demo']);

  // Un directorio con dos repositorios hijos es ambiguo y lo dice con sus datos.
  const parent = join(w.root, 'padre');
  for (const name of ['uno', 'dos']) {
    mkdirSync(join(parent, name), { recursive: true });
    execFileSync('git', ['init', '-q', join(parent, name)]);
  }
  const ambiguous = await w.call('GET', `/search?q=x&cwd=${encodeURIComponent(parent)}`);
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.json.code, 'ambiguous_project');
  assert.deepEqual(ambiguous.json.available_projects, ['dos', 'uno']);
  assert.equal(ambiguous.json.project_source, 'ambiguous');
  assert.equal(ambiguous.json.project_path, parent);
});

test('sesiones: aislamiento, evidencia y propiedad aparecen en las respuestas', async (t) => {
  const w = await httpWorld(t);
  const isolated = await w.call('POST', '/sessions', { id: 'i', project: 'demo', directory: w.repo, isolated: true, ownership_mode: 'project_owned' });
  assert.equal(isolated.status, 400);
  assert.equal(isolated.json.error, 'isolated registration requires project_owned ownership and an empty directory');
  ok(await w.call('POST', '/sessions', { id: 'o', project: 'demo', directory: w.repo, ownership_mode: 'project_owned', project_provenance: { source: 'git_root', directory: w.repo, raw_project: 'Demo' } }), 201);
  const session = ok(await w.call('GET', '/sessions/o'));
  assert.equal(session.ownership_mode, 'project_owned');
  assert.deepEqual(session.project_provenance, { source: 'git_root', directory: w.repo, raw_project: 'Demo' });
  assert.equal(ok(await w.call('GET', '/sessions/o')).directory, w.repo);
  const before = w.writes.length;
  ok(await w.call('POST', '/sessions/o/finalize', { project: 'demo', summary: 'cierre' }));
  assert.equal(w.writes.length, before + 1, 'finalizar avisa de la escritura');
  ok(await w.call('POST', '/sessions/o/finalize', { project: 'demo', summary: 'cierre' }));
  assert.equal(w.writes.length, before + 1, 'repetir no avisa');
});

test('una operación confirmada se reproduce aunque la sesión haya cambiado, y expira si se borra la observación', async (t) => {
  const w = await httpWorld(t);
  await w.call('POST', '/sessions', { id: 's1', project: 'demo', directory: w.repo });
  const body = { session_id: 's1', title: 'Con operación', content: 'contenido', project: 'demo', operation_id: 'op-1' };
  const first = ok(await w.call('POST', '/observations', body), 201);
  w.store.db.run("UPDATE sessions SET project = 'otro' WHERE id = 's1'");
  assert.equal(ok(await w.call('POST', '/observations', body), 201).id, first.id, 'la repetición confirmada no se bloquea');
  assert.equal((await w.call('POST', '/observations', { ...body, operation_id: 'op-2' })).status, 400, 'una operación nueva sí se valida');
  w.store.db.run("UPDATE sessions SET project = 'demo' WHERE id = 's1'");
  ok(await w.call('DELETE', `/observations/${first.id}?expected_project=demo&hard=true`));
  const expired = await w.call('POST', '/observations', body);
  assert.equal(expired.status, 410);
  assert.equal((await w.call('GET', '/observations/save-result?operation_id=op-1')).status, 410);
});

test('lecturas: cursor, borrado duro, proyecto del foco, páginas de historial y límites por defecto', async (t) => {
  const w = await httpWorld(t);
  const [cache] = await w.seed();
  assert.equal((await w.call('GET', `/observations/${cache}?include_history=true&history_cursor=9223372036854775807`)).status, 400);
  assert.equal((await w.call('GET', `/observations/${cache}?include_history=true&history_cursor=9223372036854775808`)).status, 400);
  assert.equal((await w.call('GET', `/observations/${cache}?include_history=true&history_cursor=4611686018427387904`)).status, 200);
  assert.equal((await w.call('GET', `/observations/${cache}?include_history=true&history_cursor=1e0`)).status, 200);

  // Otro proyecto con observaciones: el foco de otro proyecto no se lee.
  await w.call('POST', '/sessions', { id: 's9', project: 'otro', directory: join(w.root, 'otro') });
  const otro = ok(await w.call('POST', '/observations', { session_id: 's9', title: 'Aparte', content: 'algo aparte', project: 'otro' }), 201);
  const wrong = await w.call('GET', `/timeline?observation_id=${otro.id}&project=demo`);
  assert.equal(wrong.status, 404);
  assert.equal(wrong.json.error, 'observation not found in resolved project');
  assert.equal(ok(await w.call('GET', `/timeline?observation_id=${otro.id}&project=otro`)).focus.id, otro.id);

  // La proyección de estadísticas respeta el proyecto.
  assert.equal(ok(await w.call('GET', '/stats?project=otro')).total_observations, 1);
  assert.equal(ok(await w.call('GET', '/stats?all_projects=true')).total_observations, 4);

  // Borrado duro: la fila desaparece.
  const hard = ok(await w.call('DELETE', `/observations/${otro.id}?expected_project=otro&hard=true`));
  assert.equal(hard.hard_delete, true);
  assert.equal(w.store.db.get('SELECT COUNT(*) AS n FROM observations WHERE id = ?', otro.id).n, 0);

  // Páginas de historial: tras muchas versiones la respuesta indica cómo seguir.
  for (let i = 0; i < 52; i++) ok(await w.call('PATCH', `/observations/${cache}?expected_project=demo`, { content: `versión ${i}` }));
  const page = ok(await w.call('GET', `/observations/${cache}?include_history=true`));
  assert.equal(page.version_count, 52);
  assert.equal(page.history.length, 50);
  assert.equal(page.history_truncated, true);
  assert.equal(page.history_from_version, page.history[0].version);
  assert.equal(typeof page.history_cursor, 'number');
  const rest = ok(await w.call('GET', `/observations/${cache}?include_history=true&history_cursor=${page.history_cursor}`));
  assert.equal(rest.history.length, 2);
  assert.equal('history_truncated' in rest, false);

  // Límites por defecto de las listas.
  for (let i = 0; i < 25; i++) await w.call('POST', '/observations', { session_id: 's1', title: `Nota ${i}`, content: `palabra común ${i}`, project: 'demo' });
  assert.equal(ok(await w.call('GET', '/observations/recent?project=demo')).length, 20);
  assert.equal(ok(await w.call('GET', '/observations?project=demo')).length, 20);
  assert.equal(ok(await w.call('GET', '/search?q=palabra&project=demo')).length, 10);
  assert.equal(ok(await w.call('GET', '/search?q=palabra&project=demo&limit=3')).length, 3);
});

test('los avisos de escritura solo salen cuando algo cambió', async (t) => {
  const w = await httpWorld(t);
  const [cache, bug] = await w.seed();
  const count = () => w.writes.length;
  let before = count();
  ok(await w.call('POST', '/review/mark_reviewed?project=demo', { observation_id: cache }));
  assert.equal(count(), before, 'marcar revisada no avisa');
  await w.call('POST', '/prompts', { session_id: 's1', content: 'un prompt' });
  const prompt = ok(await w.call('GET', '/prompts/recent?project=demo'))[0];
  before = count();
  ok(await w.call('DELETE', `/prompts/${prompt.id}`));
  assert.equal(count(), before + 1, 'borrar un prompt avisa');
  before = count();
  const plan = { ids_to_delete: [cache, bug], new_title: 'Unido', new_content: 'contenido unido', expected_project: 'demo' };
  const preview = ok(await w.call('POST', '/observations/consolidate', plan));
  assert.equal(count(), before, 'la vista previa no avisa');
  const bad = await w.call('POST', '/observations/consolidate', { ...plan, confirm: true, fingerprint: 'mala' });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.plan.fingerprint, preview.plan.fingerprint, 'un conflicto de huella devuelve el plan vigente');
  assert.deepEqual(bad.json.plan.source_ids, [cache, bug]);
  assert.equal(count(), before);
  ok(await w.call('POST', '/observations/consolidate', { ...plan, confirm: true, fingerprint: preview.plan.fingerprint }), 201);
  assert.equal(count(), before + 1, 'consolidar avisa');
});

test('juicios: la sesión compartida, los rechazos conocidos y los fallos opacos', async (t) => {
  const w = await httpWorld(t);
  const [cache, bug] = await w.seed();
  const syncOf = (id) => getObservation(w.store, id).sync_id;
  saveRelation(w.store, { sync_id: 'rel-0000000000000001', source_id: syncOf(cache), target_id: syncOf(bug) });
  const many = ok(await w.call('POST', '/conflicts/judge-many', {
    session_id: 's1', judgments: [{ judgment_id: 'rel-0000000000000001', relation: 'related', session_id: 'ignorada' }],
  }));
  assert.equal(many.outcomes[0].relation.session_id, 's1', 'la sesión del lote sustituye a la de cada elemento');

  // Una relación entre proyectos distintos se rechaza con su mensaje.
  await w.call('POST', '/sessions', { id: 's9', project: 'otro', directory: join(w.root, 'otro') });
  const otro = ok(await w.call('POST', '/observations', { session_id: 's9', title: 'Aparte', content: 'algo', project: 'otro' }), 201);
  saveRelation(w.store, { sync_id: 'rel-0000000000000002', source_id: syncOf(cache), target_id: syncOf(otro.id) });
  const cross = ok(await w.call('POST', '/conflicts/judge-many', { judgments: [{ judgment_id: 'rel-0000000000000002', relation: 'related' }] }));
  assert.equal(cross.outcomes[0].error, 'relation rejected: source and target observations are in different projects');

  // Avisos de comparación y límites.
  const before = w.writes.length;
  ok(await w.call('POST', '/conflicts/compare', { memory_id_a: cache, memory_id_b: bug, relation: 'related', confidence: 0.5, reasoning: 'x' }));
  assert.equal(w.writes.length, before + 1);
  assert.equal(ok(await w.call('GET', '/conflicts?project=demo&limit=100000')).limit, 500);
  assert.equal(ok(await w.call('GET', '/conflicts?project=demo&limit=0')).limit, 50);
  assert.equal(ok(await w.call('GET', '/conflicts?project=demo&limit=-5')).limit, 50);
  for (const since of ['2020-01-01', '2020-01-01 00:00:00', '2020-13-45T00:00:00Z', '2020-01-01T00:00:00', 'hoy']) {
    assert.equal((await w.call('GET', `/conflicts?project=demo&since=${encodeURIComponent(since)}`)).status, 400, since);
  }
  for (const since of ['2020-01-01T00:00:00Z', '2020-01-01T00:00:00.123Z', '2020-01-01T00:00:00+02:00']) {
    assert.equal((await w.call('GET', `/conflicts?project=demo&since=${encodeURIComponent(since)}`)).status, 200, since);
  }
});

test('un almacén roto produce errores opacos y no filtra detalles', async (t) => {
  const w = await httpWorld(t);
  await w.seed();
  const plan = { ids_to_delete: [1, 2], new_title: 'Unido', new_content: 'contenido', expected_project: 'demo' };
  w.store.db.close();
  const health = await w.call('GET', '/health');
  assert.equal(health.status, 500);
  assert.equal(health.json.error, 'health check failed');
  const consolidate = await w.call('POST', '/observations/consolidate', plan);
  assert.equal(consolidate.status, 500);
  assert.deepEqual(consolidate.json, { error: 'consolidation failed', code: 'consolidation_failed' });
  const finalize = await w.call('POST', '/sessions/s1/finalize', { project: 'demo', summary: 'x' });
  assert.equal(finalize.status, 500);
  assert.deepEqual(finalize.json, { error: 'session finalization failed', code: 'session_finalize_failed', session_id: 's1' });
  const many = await w.call('POST', '/conflicts/judge-many', { judgments: [{ judgment_id: 'rel-x', relation: 'related' }] });
  assert.equal(many.json.outcomes[0].error, 'judgment failed');
});

test('límites de contexto: secciones, presupuesto y signo', () => {
  assert.equal(clampLimit(500), 500);
  assert.equal(clampLimit(501), 500);
  assert.equal(clampLimit(2147483647), 500);
  assert.equal(clampLimit(0), 0);
  assert.equal(clampLimit(-3), -3);
  const bytes = (q) => contextBytes(new URLSearchParams(q));
  assert.equal(bytes(''), 0);
  assert.equal(bytes('max_bytes=300'), 300);
  assert.equal(bytes('max_bytes=%2B300'), 300);
  assert.equal(bytes('max_bytes=+300'), 0, 'un + sin codificar es un espacio');
  assert.equal(bytes('max_bytes=65536'), 65536);
  assert.equal(bytes('max_bytes=65537'), 65536);
  assert.equal(bytes('max_bytes=99999999999999999999'), 65536);
  assert.equal(bytes('max_bytes=-5'), 0);
  assert.equal(bytes('max_bytes=1.5'), 0);
  assert.equal(bytes('max_bytes=%2B'), 0);
  assert.equal(bytes('max_bytes=0'), 0);
});

test('el contexto distingue el formato compacto y el historial antiguo', async (t) => {
  const w = await httpWorld(t);
  await w.call('POST', '/sessions', { id: 's1', project: 'demo', directory: w.repo });
  const content = `${'párrafo largo '.repeat(60)}`;
  ok(await w.call('POST', '/observations', { session_id: 's1', title: 'Larga', content, project: 'demo' }), 201);
  const full = ok(await w.call('GET', '/context?project=demo')).context;
  const compact = ok(await w.call('GET', '/context?project=demo&compact=true')).context;
  assert.notEqual(compact, full);
  assert.ok(compact.length < full.length);
  for (const title of ['Segunda', 'Tercera']) await w.call('POST', '/observations', { session_id: 's1', title, content: `nota ${title}`, project: 'demo' });
  w.store.db.run("UPDATE observations SET created_at = '2020-01-01 00:00:00' WHERE title != 'Tercera'");
  const plain = ok(await w.call('GET', '/context?project=demo&observations=1')).context;
  const older = ok(await w.call('GET', '/context?project=demo&observations=1&older_history=true')).context;
  assert.notEqual(older, plain);
  assert.match(older, /2020/);
});

test('importar admite cuerpos de varios megabytes', async (t) => {
  const w = await httpWorld(t);
  await w.seed();
  const exported = (await w.call('GET', '/export?project=demo')).text;
  const other = await httpWorld(t);
  const big = exported + ' '.repeat(6 * 1024 * 1024);
  assert.equal(ok(await other.call('POST', '/import', big)).observations_imported, 3);
});

test('el contrato de runtime se calcula como el SHA-256 de su JSON compacto sin digest', () => {
  const { digest, ...unsigned } = runtimeContractProjection();
  assert.equal(digest, createHash('sha256').update(jsonMarshal(unsigned)).digest('hex'));
  assert.equal(jsonMarshal(unsigned).startsWith('{"contract_id"'), true);
});

test('estado de sincronización con la nube configurada', (t) => {
  const store = openTempStore(t);
  const status = storeSyncStatus(store, { defaultProject: 'demo', cloudConfig: () => ({ server_url: 'https://nube.example' }) });
  assert.equal(status('').reason_code, 'blocked_unenrolled', 'usa el proyecto por defecto');
  assert.equal(status('otro').reason_message, 'project "otro" is not enrolled for cloud sync');
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('demo')");
  const enrolled = status('demo');
  assert.equal(enrolled.enabled, true);
  assert.equal(enrolled.phase, 'idle');
  const global = storeSyncStatus(store, { cloudConfig: () => ({ server_url: 'https://nube.example' }) })('');
  assert.deepEqual([global.enabled, global.reason_code], [false, 'project_required']);
  const unconfigured = storeSyncStatus(store, {});
  assert.equal(unconfigured('').reason_code, 'cloud_not_configured');
  assert.equal(storeSyncStatus(store, { cloudConfig: () => ({ server_url: '  ' }) })('').reason_code, 'cloud_not_configured');
  store.db.run("UPDATE sync_state SET lifecycle = 'degraded', last_error = 'boom', consecutive_failures = 2 WHERE target_key = 'cloud:demo'");
  const noCloud = unconfigured('demo');
  assert.deepEqual([noCloud.enabled, noCloud.phase, noCloud.last_error, noCloud.consecutive_failures], [true, 'degraded', 'boom', 2]);
});

test('serve: puerto de entorno acotado y token de sesión estricto', () => {
  assert.equal(resolveServeOptions([], { ODIN_PORT: '65535' }).port, 65535);
  assert.equal(resolveServeOptions([], { ODIN_PORT: '65536' }).port, 7438);
  assert.equal(resolveServeOptions([], { ODIN_PORT: '1' }).port, 1);
  assert.throws(() => validateSessionOwned(['--session-owned'], { ODIN_TOKEN: 'ab'.repeat(16) }), /256-bit/);
  assert.throws(() => validateSessionOwned(['--session-owned'], { ODIN_TOKEN: `${'ab'.repeat(32)}a` }), /256-bit/);
});
