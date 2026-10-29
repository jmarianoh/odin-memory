import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkId } from '../../../src/cloud/codec.js';
import { buildDashboardModel, CloudServer, CloudStore, Database, DashboardView, ManagedTokenHasher } from '../../../src/cloud/server/index.js';
import { DashboardSessions } from '../../../src/cloud/dashboard/session.js';
import {
  inlinePreview, loginPathWithNext, Pagination, parsePaginationRaw, pathEscape, queryEscape, reclampPagination, renderStructuredContent, sanitizeNext, truncate,
} from '../../../src/cloud/dashboard/format.js';
import { escapeHtml, html, raw, toText } from '../../../src/cloud/dashboard/html.js';
import { startPostgres } from './pg-helper.js';

let pg;
before(async () => {
  pg = await startPostgres();
});
after(async () => {
  await pg?.stop();
});

const PEPPER = 'una-pimienta-dedicada-de-mas-de-treinta-y-dos-bytes';
const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, n, 0));
const chunkRow = (chunkId, project, createdBy, minute, parsed) => ({ chunkId, project, createdBy, createdAt: at(minute), parsed });
const mutation = (seq, project, entity, entity_key, op, payload) => ({ seq, project, entity, entity_key, op, payload: JSON.stringify(payload) });

// ─── Piezas puras ────────────────────────────────────────────────────────────

test('las plantillas escapan todo valor salvo el marcado como seguro', () => {
  assert.equal(toText(html`<p>${'<b>&"\''}</p>`), '<p>&lt;b&gt;&amp;&#34;&#39;</p>');
  assert.equal(toText(html`<p>${raw('<b>x</b>')}${null}${false}${undefined}${0}</p>`), '<p><b>x</b>0</p>');
  assert.equal(toText(html`${[html`<i>${'a'}</i>`, 'b&']}`), '<i>a</i>b&amp;');
  assert.equal(escapeHtml(5), '5');
});

test('los escapes de URL siguen el formato de ruta y de consulta', () => {
  assert.equal(pathEscape('a b/c:d@e!;,?'), 'a%20b%2Fc:d@e%21%3B%2C%3F');
  assert.equal(queryEscape('a b*é'), 'a+b%2A%C3%A9');
  assert.equal(pathEscape('$&+='), '$&+=');
});

test('la paginación calcula rangos, números de página y reajusta al total', () => {
  const pg7 = new Pagination(1, 10, 70, 7);
  assert.deepEqual(pg7.numbers(), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(new Pagination(1, 10, 100, 10).numbers(), [1, 2, 10].slice(0, 2).concat([-1, 10]).slice(0, 4).length === 4 ? [1, 2, -1, 10] : []);
  assert.deepEqual(new Pagination(5, 10, 100, 10).numbers(), [1, -1, 4, 5, 6, -1, 10]);
  assert.deepEqual(new Pagination(9, 10, 100, 10).numbers(), [1, -1, 8, 9, 10]);
  const mid = new Pagination(2, 25, 60, 3);
  assert.deepEqual([mid.offset, mid.start, mid.end, mid.hasPrev, mid.hasNext, mid.show], [25, 26, 50, true, true, true]);
  assert.deepEqual([new Pagination(1, 10, 0, 1).start, new Pagination(1, 10, 0, 1).show], [0, false]);
  assert.equal(new Pagination(3, 10, 25, 3).end, 25);
  const parse = (q) => parsePaginationRaw(new URLSearchParams(q));
  assert.deepEqual(parse(''), { page: 1, pageSize: 10 });
  assert.deepEqual(parse('page=3&pageSize=50'), { page: 3, pageSize: 50 });
  assert.deepEqual(parse('page=-4&pageSize=5'), { page: 1, pageSize: 10 });
  assert.deepEqual(parse('page=x&pageSize=500'), { page: 1, pageSize: 100 });
  const clamped = reclampPagination(9, 10, 25);
  assert.deepEqual([clamped.pg.page, clamped.pg.totalPages, clamped.refetch], [3, 3, true]);
  assert.deepEqual([reclampPagination(1, 10, 0).pg.totalPages, reclampPagination(1, 10, 0).refetch], [1, false]);
});

test('el destino posterior al acceso solo admite rutas internas del panel', () => {
  assert.equal(sanitizeNext('/dashboard/projects?b=2&a=1'), '/dashboard/projects?a=1&b=2');
  assert.equal(sanitizeNext('/dashboard'), '/dashboard');
  assert.equal(sanitizeNext('/dashboard/x/../projects'), '/dashboard/projects');
  for (const bad of ['', '//evil.example/dashboard', 'https://evil.example/dashboard', '/other', '/dashboardx', '/dashboard/../admin', 'dashboard/x', '/dashboard/%zz']) assert.equal(sanitizeNext(bad), '', bad);
  assert.equal(loginPathWithNext('/dashboard/browser?q=a b'), '/dashboard/login?next=%2Fdashboard%2Fbrowser%3Fq%3Da%2Bb');
  assert.equal(loginPathWithNext('/etc/passwd'), '/dashboard/login');
});

test('el contenido estructurado se muestra por secciones o párrafos', () => {
  assert.match(renderStructuredContent('**What**: uno\n\n**Why**: dos & tres'), /<h4>What<\/h4><p>uno<\/p>.*<h4>Why<\/h4><p>dos &amp; tres<\/p>/);
  assert.match(renderStructuredContent('## A\nx\n\n## B\ny'), /<h4>A<\/h4><p>x<\/p>.*<h4>B<\/h4><p>y<\/p>/);
  assert.equal(renderStructuredContent('  '), '<p class="muted">No content captured.</p>');
  assert.equal(renderStructuredContent('a\nb\n\nc <d>'), '<p>a b</p><p>c &lt;d&gt;</p>');
  assert.equal(inlinePreview('**What**: x\n y **Why**: z', 100), 'What: x y • Why: z');
  assert.equal(inlinePreview('', 5), 'No content captured.');
  assert.equal(inlinePreview('abcdefghij', 4), 'abcd...');
  assert.equal(truncate('éééé', 2), 'éé...');
  assert.equal(truncate('ab', 2), 'ab');
});

test('la sesión firmada se rechaza si se altera, caduca o cambia de clave', () => {
  const sessions = new DashboardSessions('secreto-del-servidor');
  const principal = { id: '7', kind: 'human', displayName: 'Ana', role: 'admin', source: 'managed_token', tokenId: '3' };
  const cookie = sessions.mint(principal, 1_000_000);
  assert.deepEqual(sessions.parse(cookie, 1_000_000), { id: '7', kind: 'human', displayName: 'Ana', role: 'admin', enabled: true, source: 'managed_token', tokenId: '3' });
  assert.equal(sessions.parse(cookie, 1_000_000 + 8 * 3600 * 1000), null, 'caduca a las 8 horas');
  assert.notEqual(sessions.parse(cookie, 1_000_000 + 8 * 3600 * 1000 - 2000), null);
  const [payload, signature] = cookie.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), role: 'member' })).toString('base64url');
  assert.equal(sessions.parse(`${forged}.${signature}`, 1_000_000), null);
  assert.equal(sessions.parse(`${payload}.${signature}x`, 1_000_000), null);
  assert.equal(new DashboardSessions('otro-secreto').parse(cookie, 1_000_000), null);
  assert.equal(new DashboardSessions().parse(cookie, 1_000_000), null, 'sin secreto la clave es aleatoria');
  for (const bad of ['', 'a', 'a.b.c', '.x', 'x.']) assert.equal(sessions.parse(bad), null, bad);
  const noToken = sessions.mint({ ...principal, tokenId: '' }, 1_000_000);
  assert.equal(sessions.parse(noToken, 1_000_000).tokenId, '');
});

// ─── Modelo de lectura ───────────────────────────────────────────────────────

function sampleModel() {
  return buildDashboardModel({
    chunks: [
      chunkRow('c1', 'alfa', 'ana', 1, {
        sessions: [{ id: 's1', project: 'alfa', started_at: '2026-01-01T00:00:00Z', directory: '/a' }, { id: 's2', project: 'alfa', started_at: '2026-01-02T00:00:00Z' }],
        observations: [
          { sync_id: 'o1', session_id: 's1', type: 'decision', title: 'Usar pg', content: 'porque sí', created_at: '2026-01-01T01:00:00Z', tool_name: 'mem_save', topic_key: 'db/pg' },
          { sync_id: 'o2', session_id: 's2', type: 'bugfix', title: 'Arreglo', content: 'x', created_at: '2026-01-02T01:00:00Z' },
        ],
        prompts: [{ sync_id: 'p1', session_id: 's1', content: 'hola mundo', created_at: '2026-01-01T02:00:00Z' }],
      }),
      chunkRow('c2', 'alfa', 'bea', 2, { sessions: [{ id: 's1', project: 'alfa', ended_at: '2026-01-01T05:00:00Z', summary: 'resumen' }], observations: [], prompts: [] }),
      chunkRow('c3', 'beta', 'ana', 3, {
        sessions: [{ id: 's9', project: 'beta', started_at: '2026-01-03T00:00:00Z' }],
        observations: [{ sync_id: 'o9', session_id: 's9', type: 'Decision', title: 'Otra', content: 'y', created_at: '2026-01-03T01:00:00Z' }],
        prompts: [],
      }),
    ],
    mutations: [],
    controls: [{ project: 'vacio' }, { project: 'beta' }],
  });
}

test('el modelo suma chunks, hereda campos de sesiones y ordena lo más reciente primero', () => {
  const model = sampleModel();
  assert.deepEqual(model.projects.map((p) => [p.Project, p.Chunks, p.Sessions, p.Observations, p.Prompts]), [['alfa', 2, 2, 2, 1], ['beta', 1, 1, 1, 0], ['vacio', 0, 0, 0, 0]]);
  const alfa = model.projectDetails.get('alfa');
  assert.deepEqual(alfa.Sessions.map((s) => s.SessionID), ['s2', 's1']);
  const s1 = alfa.Sessions.find((s) => s.SessionID === 's1');
  assert.deepEqual([s1.StartedAt, s1.EndedAt, s1.Summary, s1.Directory], ['2026-01-01T00:00:00Z', '2026-01-01T05:00:00Z', 'resumen', '/a'], 'el cierre conserva lo que dejó la apertura');
  assert.deepEqual(alfa.Observations.map((o) => o.SyncID), ['o2', 'o1']);
  assert.equal(alfa.Observations[1].ChunkID, 'c1');
  assert.deepEqual(model.contributors.map((c) => [c.CreatedBy, c.Chunks, c.Projects, c.LastChunkAt]), [['ana', 2, 2, '2026-01-01T00:03:00Z'], ['bea', 1, 1, '2026-01-01T00:02:00Z']]);
  assert.deepEqual(alfa.Contributors.map((c) => [c.CreatedBy, c.Chunks]), [['ana', 1], ['bea', 1]]);
  assert.deepEqual(model.admin, { Projects: 3, Contributors: 2, Chunks: 3 });
});

test('las mutaciones borran, completan y filtran lo que ya no vigila el diario', () => {
  const base = { sessions: [{ id: 's1', project: 'p', started_at: '2026-01-01T00:00:00Z' }, { id: 's2', project: 'p', started_at: '2026-01-02T00:00:00Z' }], observations: [
    { sync_id: 'o1', session_id: 's1', type: 'a', title: 'uno', content: 'c1', created_at: '2026-01-01T01:00:00Z' },
    { sync_id: 'o2', session_id: 's1', type: 'a', title: 'dos', content: 'c2', created_at: '2026-01-01T02:00:00Z' },
    { sync_id: 'o3', session_id: 's2', type: 'a', title: 'tres', content: 'c3', created_at: '2026-01-01T03:00:00Z' },
  ], prompts: [{ sync_id: 'p1', session_id: 's1', content: 'texto', created_at: '2026-01-01T04:00:00Z' }] };
  const run = (mutations, extraChunks = []) => buildDashboardModel({ chunks: [chunkRow('c1', 'p', 'ana', 1, base), ...extraChunks], mutations });
  const detail = (model) => model.projectDetails.get('p');

  const updated = detail(run([mutation(1, 'p', 'observation', 'o1', 'upsert', { sync_id: 'o1', title: 'nuevo' }), mutation(2, 'p', 'observation', 'o2', 'upsert', { sync_id: 'o2' }), mutation(3, 'p', 'observation', 'o3', 'upsert', { sync_id: 'o3' })]));
  const o1 = updated.Observations.find((o) => o.SyncID === 'o1');
  assert.deepEqual([o1.Title, o1.Content, o1.SessionID, o1.Type, o1.ChunkID], ['nuevo', 'c1', 's1', 'a', 'c1'], 'la mutación parcial conserva el resto');

  const pruned = detail(run([mutation(1, 'p', 'observation', 'o1', 'upsert', { sync_id: 'o1', title: 'x' })]));
  assert.deepEqual(pruned.Observations.map((o) => o.SyncID), ['o1'], 'con diario, solo cuentan sus claves');
  assert.deepEqual(pruned.Prompts.map((p) => p.SyncID), ['p1'], 'sin mutaciones de prompts no se filtran');
  assert.deepEqual(pruned.Sessions.map((s) => s.SessionID).sort(), ['s1', 's2'].filter((id) => id === 's1' || id === 's2'), 'las sesiones sin diario se conservan');

  const sessionPruned = detail(run([mutation(1, 'p', 'session', 's1', 'upsert', { id: 's1' })]));
  assert.deepEqual(sessionPruned.Sessions.map((s) => s.SessionID).sort(), ['s1', 's2'], 's2 sigue porque alguien la referencia');
  const orphan = buildDashboardModel({ chunks: [chunkRow('c1', 'p', 'ana', 1, { sessions: [{ id: 'huerfana', project: 'p' }, { id: 's1', project: 'p' }], observations: [], prompts: [] })], mutations: [mutation(1, 'p', 'session', 's1', 'upsert', { id: 's1' })] });
  assert.deepEqual(orphan.projectDetails.get('p').Sessions.map((s) => s.SessionID), ['s1'], 'una sesión que nadie referencia ni conoce el diario desaparece');

  const deleted = detail(run([
    mutation(1, 'p', 'observation', 'o1', 'delete', { sync_id: 'o1' }), mutation(2, 'p', 'observation', 'o2', 'upsert', { sync_id: 'o2', deleted: true }),
    mutation(3, 'p', 'observation', 'o3', 'upsert', { sync_id: 'o3', hard_delete: true }), mutation(4, 'p', 'prompt', 'p1', 'delete', { sync_id: 'p1' }), mutation(5, 'p', 'session', 's2', 'delete', { id: 's2' }),
  ]));
  assert.deepEqual([deleted.Observations.length, deleted.Prompts.length, deleted.Sessions.map((s) => s.SessionID)], [0, 0, []], 'sin nada que la referencie y fuera del diario, s1 desaparece');

  const tombstoned = detail(run([mutation(1, 'p', 'session', 's2', 'upsert', { id: 's2', deleted_at: '2026-01-05T00:00:00Z' })]));
  assert.equal(tombstoned.Sessions.some((s) => s.SessionID === 's2'), false);

  const viaChunk = detail(run([], [chunkRow('c2', 'p', 'bea', 2, { sessions: [], observations: [{ sync_id: 'o1', deleted_at: '2026-01-04T00:00:00Z', session_id: 's1' }], prompts: [], mutations: [{ entity: 'prompt', entity_key: 'p9', op: 'upsert', payload: JSON.stringify({ sync_id: 'p9', session_id: 's1', content: 'nuevo' }) }] })]));
  assert.equal(viaChunk.Observations.some((o) => o.SyncID === 'o1'), false, 'un chunk puede borrar con deleted_at');
  assert.equal(viaChunk.Prompts.some((p) => p.SyncID === 'p9'), true, 'y traer mutaciones tipadas');

  assert.throws(() => run([{ seq: 4, project: 'p', entity: 'observation', entity_key: 'o1', op: 'upsert', payload: '[1]' }]), /invalid dashboard mutation payload in cloud_mutations seq 4/);
  assert.throws(() => run([mutation(5, 'p', 'session', 's1', 'upsert', { id: 'otra' })]), /does not match payload id/);
  assert.throws(() => run([], [chunkRow('c9', 'p', 'x', 9, { mutations: [{ entity: 'prompt', entity_key: 'k', op: 'upsert', payload: '[]' }] })]), /in chunk "c9"/);
  const ignored = detail(run([mutation(6, 'p', 'relation', 'r1', 'upsert', { sync_id: 'r1' })]));
  assert.equal(ignored.Observations.length, 3, 'las relaciones no afectan al panel');
});

test('una sesión reabierta conserva el cierre, el diario poda prompts y los contribuidores se ordenan por actividad', () => {
  const empty = { sessions: [], observations: [], prompts: [] };
  const model = buildDashboardModel({
    chunks: [
      chunkRow('c1', 'p', 'ana', 1, { ...empty, sessions: [{ id: 's1', project: 'p', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T09:00:00Z', summary: 'fin', directory: '/d' }], prompts: [{ sync_id: 'p1', session_id: 's1', content: 'uno' }, { sync_id: 'p2', session_id: 's1', content: 'dos' }] }),
      chunkRow('c2', 'p', 'bea', 2, { ...empty, sessions: [{ id: 's1', project: 'p', started_at: '2026-01-01T00:00:00Z' }] }),
      chunkRow('c3', 'p', 'bea', 3, empty),
      chunkRow('c4', 'p', 'bea', 4, empty),
    ],
    mutations: [mutation(1, 'p', 'prompt', 'p2', 'upsert', { sync_id: 'p2', session_id: 's1', content: 'dos' })],
  });
  const detail = model.projectDetails.get('p');
  const s1 = detail.Sessions[0];
  assert.deepEqual([s1.EndedAt, s1.Summary, s1.Directory], ['2026-01-01T09:00:00Z', 'fin', '/d'], 'reabrir sin cierre no lo borra');
  assert.deepEqual(detail.Prompts.map((p) => p.SyncID), ['p2'], 'con diario de prompts solo cuentan sus claves');
  assert.deepEqual(detail.Contributors.map((c) => [c.CreatedBy, c.Chunks]), [['bea', 3], ['ana', 1]]);
});

test('la vista restringe por proyectos y los permisos ambiguos no autorizan a nadie', () => {
  const model = sampleModel();
  const all = new DashboardView(model, null);
  assert.deepEqual(all.listProjects('').map((p) => p.Project), ['alfa', 'beta', 'vacio']);
  assert.deepEqual(all.listProjects('BE').map((p) => p.Project), ['beta']);
  const alfaOnly = new DashboardView(model, new Set(['alfa']));
  assert.deepEqual(alfaOnly.adminOverview(), { Projects: 1, Contributors: 2, Chunks: 2 });
  assert.deepEqual(alfaOnly.listContributors('').map((c) => [c.CreatedBy, c.Projects]), [['ana', 1], ['bea', 1]]);
  assert.throws(() => alfaOnly.projectDetail('beta'), (e) => e.code === 'dashboard_project_forbidden');
  assert.throws(() => alfaOnly.listRecentObservations('beta', '', 5), (e) => e.code === 'dashboard_project_forbidden');
  const none = new DashboardView(model, new Set());
  assert.deepEqual([none.listProjects('').length, none.adminOverview().Projects, none.listDistinctTypes()], [0, 0, []]);
  assert.equal(none.canSee('alfa'), false);
  assert.equal(all.canSeeAll(), true);
  assert.equal(none.canSeeAll(), false);
  assert.deepEqual(DashboardView.forGrants(model, ['Alfa']).listProjects('').map((p) => p.Project), ['alfa']);
  assert.equal(DashboardView.forGrants(model, ['*']).canSeeAll(), true);
  assert.equal(DashboardView.forGrants(model, ['nada']).listProjects('').length, 0);
  assert.equal(DashboardView.forGrants(model, []).listProjects('').length, 0, 'sin permisos no se ve nada');
  const ambiguous = buildDashboardModel({ chunks: [chunkRow('a', 'Mi App', 'x', 1, { sessions: [], observations: [], prompts: [] }), chunkRow('b', 'mi-app', 'x', 2, { sessions: [], observations: [], prompts: [] })], mutations: [] });
  assert.equal(DashboardView.forGrants(ambiguous, ['mi-app']).listProjects('').length, 0, 'dos nombres con el mismo permiso: ninguno');
});

test('las consultas filtran, paginan y devuelven detalles con errores precisos', () => {
  const view = new DashboardView(sampleModel(), null);
  assert.deepEqual(view.listRecentObservations('', '', 0).map((o) => o.SyncID), ['o9', 'o2', 'o1']);
  assert.deepEqual(view.listRecentObservations('alfa', 'ARREGLO', 5).map((o) => o.SyncID), ['o2']);
  assert.deepEqual(view.listRecentObservations('', 'bugfix', 5).map((o) => o.SyncID), ['o2'], 'busca en título y tipo');
  assert.deepEqual(view.listRecentObservations('', '', 2).map((o) => o.SyncID), ['o9', 'o2']);
  assert.deepEqual(view.listRecentSessions('', 's1', 5).map((s) => s.SessionID), ['s1']);
  assert.deepEqual(view.listRecentPrompts('', 'MUNDO', 5).map((p) => p.SyncID), ['p1']);
  const page = view.listRecentObservationsPaginated('', '', '', 2, 0);
  assert.deepEqual([page.rows.length, page.total], [2, 3]);
  assert.deepEqual(view.listRecentObservationsPaginated('', '', '', 2, 2).rows.map((o) => o.SyncID), ['o1']);
  assert.deepEqual(view.listRecentObservationsPaginated('', '', '', 2, 9), { rows: [], total: 3 });
  assert.deepEqual(view.listRecentObservationsPaginated('', '', 'decision', 10, 0).rows.map((o) => o.SyncID), ['o9', 'o1'], 'el tipo no distingue mayúsculas');
  assert.equal(view.listRecentObservationsPaginated('', '', '', 0, 1).rows.length, 2, 'sin límite devuelve el resto');
  assert.deepEqual(view.listProjectsPaginated('', 2, 1).rows.map((p) => p.Project), ['beta', 'vacio']);
  assert.deepEqual(view.listContributorsPaginated('AN', 5, 0).rows.map((c) => c.CreatedBy), ['ana']);
  assert.deepEqual(view.listDistinctTypes(), ['Decision', 'bugfix', 'decision']);
  assert.deepEqual(view.counts(), { Projects: 3, Contributors: 2, Sessions: 3, Observations: 3, Prompts: 1, Chunks: 3 });

  assert.throws(() => view.projectDetail('  '), (e) => e.code === 'dashboard_project_invalid');
  assert.throws(() => view.projectDetail('nope'), (e) => e.code === 'dashboard_project_not_found');
  assert.throws(() => view.listRecentSessions('nope', '', 1), (e) => e.code === 'dashboard_project_not_found');
  const session = view.getSessionDetail('alfa', 's1');
  assert.deepEqual([session.session.Summary, session.observations.map((o) => o.SyncID), session.prompts.map((p) => p.SyncID)], ['resumen', ['o1'], ['p1']]);
  assert.throws(() => view.getSessionDetail('alfa', 'zz'), (e) => e.code === 'dashboard_session_not_found');
  const obs = view.getObservationDetail('alfa', 's1', ' o1 ');
  assert.deepEqual([obs.observation.Title, obs.session.SessionID, obs.related.length], ['Usar pg', 's1', 0]);
  assert.throws(() => view.getObservationDetail('alfa', 's2', 'o1'), (e) => e.code === 'dashboard_observation_not_found');
  const prompt = view.getPromptDetail('alfa', 's1', 'p1');
  assert.deepEqual([prompt.prompt.Content, prompt.session.Summary], ['hola mundo', 'resumen']);
  assert.throws(() => view.getPromptDetail('alfa', 's1', 'p0'), (e) => e.code === 'dashboard_prompt_not_found');
  const contributor = view.getContributorDetail(' ANA ');
  assert.deepEqual([contributor.contributor.CreatedBy, contributor.sessions.map((s) => s.SessionID), contributor.observations.length], ['ana', ['s9', 's2', 's1'], 3]);
  assert.throws(() => view.getContributorDetail('nadie'), (e) => e.code === 'dashboard_contributor_not_found');
});

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function start(options = {}) {
  const store = new CloudStore(Database.connect(await pg.createDatabase()));
  await store.migrate();
  const server = new CloudServer(store, { allowedProjects: ['*'], port: 0, log: () => {}, jwtSecret: 'secreto-del-panel', version: 'v9.9.9', ...options });
  const { port } = await server.listen();
  return { store, server, url: `http://127.0.0.1:${port}`, close: async () => { await server.close(); await store.close(); } };
}

async function request(base, method, path, { cookie = '', headers = {}, form, htmx = false } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie) init.headers.Cookie = cookie;
  if (htmx) init.headers['HX-Request'] = 'true';
  if (form !== undefined) {
    init.body = new URLSearchParams(form).toString();
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, text: await response.text(), headers: response.headers, location: response.headers.get('location'), setCookie: response.headers.get('set-cookie') ?? '' };
}

const push = (s, project, createdBy, data) => {
  const payload = JSON.stringify({ sessions: data.sessions ?? [], observations: data.observations ?? [], prompts: data.prompts ?? [] });
  return s.store.writeChunk(project, chunkId(payload), createdBy, '', payload);
};

const seed = async (s) => {
  await push(s, 'alfa', 'ana', {
    sessions: [{ id: 's1', project: 'alfa', started_at: '2026-01-01T00:00:00Z', directory: '/work/a' }],
    observations: [{ sync_id: 'o1', session_id: 's1', type: 'decision', title: 'Usar <pg>', content: '**What**: motor\n\n**Why**: es fiable', scope: 'project', created_at: '2026-01-01T01:00:00Z' }],
    prompts: [{ sync_id: 'p1', session_id: 's1', content: 'hola', created_at: '2026-01-01T02:00:00Z' }],
  });
  await push(s, 'beta', 'bea', { sessions: [{ id: 's2', project: 'beta', started_at: '2026-01-02T00:00:00Z' }], observations: [{ sync_id: 'o2', session_id: 's2', type: 'bugfix', title: 'Arreglo', content: 'x', scope: 'project' }] });
};

/** Servidor con autenticación, una persona administradora gestionada y su cookie. */
async function authenticated(t) {
  const s = await start({ token: 'tok', adminToken: 'adm', hasher: new ManagedTokenHasher(PEPPER) });
  t.after(s.close);
  s.auth = 'tok';
  await seed(s);
  const loginWith = async (token) => {
    const response = await request(s.url, 'POST', '/dashboard/login', { form: { token } });
    return { response, cookie: response.setCookie.split(';')[0] };
  };
  s.loginWith = loginWith;
  return s;
}

test('sin token configurado el panel es abierto y no muestra la administración', async (t) => {
  const s = await start({ allowedProjects: ['alfa'] });
  t.after(s.close);
  await seed(s);
  const home = await request(s.url, 'GET', '/dashboard/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<title>Dashboard — Odin Cloud<\/title>/);
  assert.match(home.text, /ODIN CLOUD \/ SHARED MEMORY INDEX \/ LIVE SYNC READY · v9\.9\.9/);
  assert.doesNotMatch(home.text, />Admin</, 'sin sesión no hay administración');
  assert.equal((await request(s.url, 'GET', '/dashboard')).status, 200);
  assert.equal((await request(s.url, 'GET', '/dashboard/admin')).status, 403);
  const login = await request(s.url, 'GET', '/dashboard/login?next=/dashboard/projects');
  assert.deepEqual([login.status, login.location], [303, '/dashboard/projects'], 'abierto: el acceso no hace falta');
  const projects = await request(s.url, 'GET', '/dashboard/projects/list', { htmx: true });
  assert.match(projects.text, /alfa/);
  assert.doesNotMatch(projects.text, /beta/, 'la lista del servidor limita lo que se ve');
  assert.equal((await request(s.url, 'GET', '/dashboard/projects/beta')).status, 403);
  assert.equal((await request(s.url, 'GET', '/dashboard/health')).text, '{"status":"ok","subsystem":"dashboard"}');
  assert.equal((await request(s.url, 'GET', '/dashboard/stats', { htmx: true })).text.includes('Cloud Stats'), true);
});

test('los estáticos se sirven y los desconocidos dan 404', async (t) => {
  const s = await start();
  t.after(s.close);
  const css = await request(s.url, 'GET', '/dashboard/static/styles.css');
  assert.deepEqual([css.status, css.headers.get('content-type')], [200, 'text/css; charset=utf-8']);
  assert.match((await request(s.url, 'GET', '/dashboard/static/pico.min.css')).text, /Pico/);
  const js = await request(s.url, 'GET', '/dashboard/static/htmx.min.js');
  assert.deepEqual([js.status, js.headers.get('content-type')], [200, 'text/javascript; charset=utf-8']);
  assert.equal((await request(s.url, 'GET', '/dashboard/static/nada.js')).status, 404);
  assert.equal((await request(s.url, 'GET', '/dashboard/static/constructor')).status, 404);
});

test('el acceso con token abre una sesión firmada y la cierra al salir', async (t) => {
  const s = await authenticated(t);
  const page = await request(s.url, 'GET', '/dashboard/projects');
  assert.deepEqual([page.status, page.location], [303, '/dashboard/login?next=%2Fdashboard%2Fprojects']);
  const htmxDenied = await request(s.url, 'GET', '/dashboard/stats', { htmx: true });
  assert.deepEqual([htmxDenied.status, htmxDenied.headers.get('hx-redirect')], [401, '/dashboard/login?next=%2Fdashboard%2Fstats']);
  const form = await request(s.url, 'GET', '/dashboard/login?next=/dashboard/browser');
  assert.match(form.text, /name="next" value="\/dashboard\/browser"/);
  assert.match(form.text, /Odin Cloud/);

  assert.match((await request(s.url, 'POST', '/dashboard/login', { form: { token: '' } })).text, /token is required/);
  assert.match((await request(s.url, 'POST', '/dashboard/login', { form: { token: 'mal' } })).text, /invalid token/);
  const ok = await request(s.url, 'POST', '/dashboard/login', { form: { token: ' tok ', next: '/dashboard/browser?q=x' } });
  assert.deepEqual([ok.status, ok.location], [303, '/dashboard/browser?q=x']);
  assert.match(ok.setCookie, /^odin_dashboard_session=[\w-]+\.[\w-]+; Path=\/dashboard; HttpOnly; SameSite=Lax; Max-Age=28800$/);
  const evil = await request(s.url, 'POST', '/dashboard/login', { form: { token: 'tok', next: '//evil.example' } });
  assert.equal(evil.location, '/dashboard/', 'un destino externo se descarta');
  const secure = await request(s.url, 'POST', '/dashboard/login', { form: { token: 'tok' }, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(secure.setCookie, /; Secure$/);
  const tooBig = await request(s.url, 'POST', '/dashboard/login', { form: { token: 'x'.repeat(20000) } });
  assert.equal(tooBig.status, 413);

  const cookie = ok.setCookie.split(';')[0];
  const home = await request(s.url, 'GET', '/dashboard/', { cookie });
  assert.equal(home.status, 200);
  assert.match(home.text, /LEGACY_SYNC/);
  assert.doesNotMatch(home.text, />Admin</, 'el token de sincronización no administra');
  assert.equal((await request(s.url, 'GET', '/dashboard/login', { cookie })).location, '/dashboard/', 'ya con sesión se redirige');
  assert.equal((await request(s.url, 'GET', '/dashboard/', { cookie: `${cookie}x` })).status, 303, 'una cookie alterada no vale');
  const out = await request(s.url, 'POST', '/dashboard/logout', { cookie });
  assert.deepEqual([out.status, out.location], [303, '/dashboard/login']);
  assert.match(out.setCookie, /^odin_dashboard_session=; .*Max-Age=-1/);

  const audit = await s.store.listAuthAuditEvents({ limit: 20 });
  const logins = audit.filter((e) => e.action === 'dashboard.login');
  assert.ok(logins.some((e) => e.outcome === 'denied' && e.reasonCode === 'invalid_token' && e.actorSource === 'unauthenticated'));
  assert.ok(logins.some((e) => e.outcome === 'success' && e.actorSource === 'legacy_env_sync' && e.metadata.role === 'member'));
  assert.ok(JSON.stringify(logins).indexOf('"tok"') === -1, 'el token nunca queda en la auditoría');
});

test('las páginas muestran el contenido, escapan el texto y paginan', async (t) => {
  const s = await authenticated(t);
  const { cookie } = await s.loginWith('tok');
  const get = (path, opts = {}) => request(s.url, 'GET', path, { cookie, ...opts });

  const stats = await get('/dashboard/stats', { htmx: true });
  assert.match(stats.text, /<span class="metric-value">2<\/span><span class="metric-label">Projects<\/span>/);
  const projects = await get('/dashboard/projects/list', { htmx: true });
  assert.match(projects.text, /<h3>alfa<\/h3>/);
  assert.match(projects.text, /<span class="stat-value">1<\/span><span class="stat-label">Sessions<\/span>/);
  assert.match((await get('/dashboard/projects/list?q=bet', { htmx: true })).text, /beta/);
  assert.doesNotMatch((await get('/dashboard/projects/list?q=bet', { htmx: true })).text, /alfa/);
  assert.match((await get('/dashboard/projects/list?q=zzz', { htmx: true })).text, /No Projects/);

  const detail = await get('/dashboard/projects/alfa');
  assert.match(detail.text, /PROJECT DETAIL/);
  assert.match(detail.text, /hx-get="\/dashboard\/projects\/alfa\/observations"/);
  const obs = await get('/dashboard/projects/alfa/observations', { htmx: true });
  assert.match(obs.text, /Usar &lt;pg&gt;/, 'el título se escapa');
  assert.match(obs.text, /href="\/dashboard\/observations\/alfa\/s1\/o1"/);
  assert.match(obs.text, /What: motor • Why: es fiable/);
  assert.match((await get('/dashboard/projects/alfa/sessions', { htmx: true })).text, /Active/);
  assert.match((await get('/dashboard/projects/alfa/prompts', { htmx: true })).text, /hola/);
  assert.equal((await get('/dashboard/projects/nada')).status, 404);
  assert.match((await get('/dashboard/projects/nada')).text, /Project not found/);

  const browser = await get('/dashboard/browser?project=alfa&type=decision');
  assert.match(browser.text, /<option value="alfa" selected>alfa<\/option>/);
  assert.match(browser.text, /class="type-pill active">decision</);
  const list = await get('/dashboard/browser/observations?project=alfa', { htmx: true });
  assert.match(list.text, /Usar &lt;pg&gt;/);
  assert.doesNotMatch(list.text, /Arreglo/);
  assert.match((await get('/dashboard/browser/observations?type=bugfix', { htmx: true })).text, /Arreglo/);
  assert.match((await get('/dashboard/browser/observations')).text, /Knowledge Browser/, 'sin htmx se entrega la página entera');
  assert.match((await get('/dashboard/browser/sessions', { htmx: true })).text, /session s2/);
  assert.match((await get('/dashboard/browser/prompts?q=ho', { htmx: true })).text, /hola/);
  assert.match((await get('/dashboard/browser/sessions/s1', { htmx: true })).text, /session s1/);
  assert.doesNotMatch((await get('/dashboard/browser/sessions/s1', { htmx: true })).text, /session s2/);
  assert.match((await get('/dashboard/activity')).text, /Recent Observation Activity/);
  assert.equal((await get('/dashboard/activity?project=nada')).status, 404);

  const obsPage = await get('/dashboard/observations/alfa/s1/o1');
  assert.match(obsPage.text, /<h4>What<\/h4><p>motor<\/p>/);
  assert.match(obsPage.text, /<th>Tool<\/th><td><span class="muted">Unknown<\/span>/);
  assert.match(obsPage.text, /LINKED SESSION/);
  assert.equal((await get('/dashboard/observations/alfa/s1/nope')).status, 404);
  assert.match((await get('/dashboard/observations/alfa/s1/nope')).text, /Observation not found/);
  const longId = await get('/dashboard/observations/alfa/s1/' + 'x'.repeat(129));
  assert.deepEqual([longId.status, /Invalid observation identifier/.test(longId.text)], [404, true]);
  assert.match((await get('/dashboard/sessions/alfa/s1')).text, /Observations in this Session/);
  assert.equal((await get('/dashboard/sessions/alfa/nope')).status, 404);
  assert.match((await get('/dashboard/prompts/alfa/s1/p1')).text, /PROMPT DETAIL/);
  assert.equal((await get('/dashboard/prompts/alfa/s1/zz')).status, 404);

  const contributors = await get('/dashboard/contributors/list', { htmx: true });
  assert.match(contributors.text, /<a href="\/dashboard\/contributors\/ana">ana<\/a>/);
  assert.match((await get('/dashboard/contributors/ana')).text, /CONTRIBUTOR DETAIL/);
  assert.equal((await get('/dashboard/contributors/nadie')).status, 404);
  assert.match((await get('/dashboard/contributors')).text, /Search contributors/);
});

test('la paginación del navegador reajusta una página fuera de rango', async (t) => {
  const s = await authenticated(t);
  const observations = Array.from({ length: 23 }, (_, i) => ({ sync_id: `m${String(i).padStart(2, '0')}`, session_id: 's1', type: 'note', title: `Nota ${String(i).padStart(2, '0')}`, content: 'c', scope: 'project', created_at: `2026-02-01T00:${String(i).padStart(2, '0')}:00Z` }));
  await push(s, 'alfa', 'ana', { observations });
  const { cookie } = await s.loginWith('tok');
  const get = (path) => request(s.url, 'GET', path, { cookie, htmx: true });
  const first = await get('/dashboard/browser/observations?pageSize=10');
  assert.match(first.text, /1–10 of 25/);
  assert.match(first.text, /Nota 22/);
  assert.match(first.text, /hx-get="\/dashboard\/browser\/observations\?page=2&amp;pageSize=10"/);
  const beyond = await get('/dashboard/browser/observations?page=99&pageSize=10');
  assert.match(beyond.text, /21–25 of 25/, 'una página fuera de rango muestra la última');
  assert.match((await get('/dashboard/browser/observations?page=2&pageSize=25')).text, /^<div class="empty-state"|No Observations|./);
  assert.doesNotMatch((await get('/dashboard/browser/observations?pageSize=25')).text, /pagination-bar/, 'una sola página no lleva barra');
});

test('un principal gestionado solo ve lo que se le concedió y el administrador gestiona', async (t) => {
  const s = await authenticated(t);
  const admin = await s.store.createFirstAdminHumanUser({ username: 'root' });
  const issue = async (principalId) => {
    const token = (await import('../../../src/cloud/server/tokens.js')).generateManagedToken('live');
    await s.store.createPrincipalTokenWithAudit({ principalId, tokenPrefix: token.prefix, tokenHash: s.server.hasher.hash(token.raw), createdByPrincipalId: principalId }, null);
    return token.raw;
  };
  const adminToken = await issue(admin.principal_id);
  const ana = await s.store.createHumanUser({ username: 'ana', role: 'member', displayName: 'Ana M.' });
  const anaToken = await issue(ana.principal_id);
  await s.store.createProjectGrant({ principalId: ana.principal_id, project: 'alfa', grantedByPrincipalId: admin.principal_id });

  const member = await s.loginWith(anaToken);
  assert.equal(member.response.status, 303);
  const get = (cookie, path, opts = {}) => request(s.url, 'GET', path, { cookie, ...opts });
  const home = await get(member.cookie, '/dashboard/');
  assert.match(home.text, /Ana M\./);
  assert.doesNotMatch(home.text, />Admin</);
  const list = await get(member.cookie, '/dashboard/projects/list', { htmx: true });
  assert.match(list.text, /alfa/);
  assert.doesNotMatch(list.text, /beta/);
  assert.equal((await get(member.cookie, '/dashboard/projects/beta')).status, 403);
  assert.match((await get(member.cookie, '/dashboard/projects/beta')).text, /Project access denied/);
  assert.equal((await get(member.cookie, '/dashboard/contributors/bea')).status, 404, 'otro contribuidor no aparece');
  assert.equal((await get(member.cookie, '/dashboard/admin')).status, 403);
  assert.equal((await get(member.cookie, '/dashboard/admin/users')).status, 403);
  const forbiddenPost = await request(s.url, 'POST', '/dashboard/admin/users', { cookie: member.cookie, form: { username: 'x' } });
  assert.equal(forbiddenPost.status, 403);

  await s.store.setHumanUserEnabled(ana.principal_id, false);
  assert.equal((await get(member.cookie, '/dashboard/')).status, 303, 'deshabilitar corta la sesión viva');
  await s.store.setHumanUserEnabled(ana.principal_id, true);
  assert.equal((await get(member.cookie, '/dashboard/')).status, 200);

  const boss = await s.loginWith(adminToken);
  for (const project of ['alfa', 'beta']) await s.store.createProjectGrant({ principalId: admin.principal_id, project, grantedByPrincipalId: admin.principal_id });
  const dash = await get(boss.cookie, '/dashboard/');
  assert.match(dash.text, />Admin</);
  assert.equal((await s.store.listAuthAuditEvents({ limit: 30 })).some((e) => e.action === 'dashboard.login' && e.outcome === 'success' && e.actorSource === 'managed_token' && e.actorPrincipalId === admin.principal_id), true);
  const overview = await get(boss.cookie, '/dashboard/admin');
  assert.match(overview.text, /Admin Overview/);
  assert.match(overview.text, /Connected/);
  assert.match((await get(boss.cookie, '/dashboard/admin/health')).text, /Total Chunks/);

  // Controles de sincronización.
  const controls = await get(boss.cookie, '/dashboard/admin/projects');
  assert.match(controls.text, /Project Controls/);
  assert.match(controls.text, /action="\/dashboard\/admin\/projects\/alfa\/sync"/);
  const form = await get(boss.cookie, '/dashboard/admin/projects/alfa/sync/form', { htmx: true });
  assert.match(form.text, /name="enabled" value="false"/);
  const post = (path, formData, opts = {}) => request(s.url, 'POST', path, { cookie: boss.cookie, form: formData, ...opts });
  assert.equal((await post('/dashboard/admin/projects/alfa/sync', { enabled: 'maybe' })).status, 400);
  const paused = await post('/dashboard/admin/projects/alfa/sync', { enabled: 'false', reason: 'mantenimiento' });
  assert.deepEqual([paused.status, paused.location], [303, '/dashboard/admin/projects']);
  assert.equal(await s.store.isProjectSyncEnabled('alfa'), false);
  const control = await s.store.getProjectSyncControl('alfa');
  assert.deepEqual([control.pausedReason, control.updatedBy], ['mantenimiento', 'root']);
  assert.match((await get(boss.cookie, '/dashboard/projects/alfa')).text, /ORG POLICY/);
  assert.match((await get(boss.cookie, '/dashboard/projects/list', { htmx: true })).text, /Paused: mantenimiento/);
  const viaHtmx = await post('/dashboard/admin/projects/alfa/sync', { enabled: 'true' }, { htmx: true });
  assert.deepEqual([viaHtmx.status, viaHtmx.headers.get('hx-redirect')], [200, '/dashboard/admin/projects']);
  assert.equal(await s.store.isProjectSyncEnabled('alfa'), true);
  await push(s, 'gamma', 'ana', { sessions: [{ id: 's7', project: 'gamma', started_at: '2026-01-03T00:00:00Z' }] });
  assert.equal((await post('/dashboard/admin/projects/gamma/sync', { enabled: 'false' })).status, 403, 'no se pausa lo que no se ve');
  assert.equal(await s.store.isProjectSyncEnabled('gamma'), true);
  assert.match((await get(member.cookie, '/dashboard/admin/projects/alfa/sync/form', { htmx: true })).text, /forbidden/);
  assert.equal((await request(s.url, 'POST', '/dashboard/admin/projects/alfa/sync', { cookie: member.cookie, form: { enabled: 'false' } })).status, 403);

  // Usuarios gestionados.
  assert.match((await get(boss.cookie, '/dashboard/admin/users')).text, /CREATE MANAGED USER/);
  assert.equal((await post('/dashboard/admin/users', { username: '' })).status, 400);
  const created = await post('/dashboard/admin/users', { username: 'luis', email: 'l@x.org', display_name: 'Luis', role: 'member' });
  assert.deepEqual([created.status, created.location], [303, '/dashboard/admin/users']);
  assert.equal((await post('/dashboard/admin/users', { username: 'luis' })).status, 400, 'nombre repetido');
  const users = await get(boss.cookie, '/dashboard/admin/users/list', { htmx: true });
  assert.match(users.text, />luis</);
  const luis = (await s.store.listHumanUsers()).find((u) => u.username === 'luis');
  const detailUrl = `/dashboard/admin/users/${luis.principal_id}`;
  assert.match((await get(boss.cookie, detailUrl)).text, /No Tokens/);
  assert.equal((await get(boss.cookie, '/dashboard/admin/users/999')).status, 404);
  assert.equal((await post(`${detailUrl}/disable`, {})).status, 303);
  const refused = await post(`${detailUrl}/tokens`, { name: 'x' });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /User luis is currently disabled/);
  await post(`${detailUrl}/enable`, {});
  const issued = await post(`${detailUrl}/tokens`, { name: 'portátil' });
  assert.equal(issued.status, 200);
  const shown = issued.text.match(/<pre class="token-reveal">(odc_live_[\w-]+)<\/pre>/);
  assert.ok(shown, 'el token en claro se muestra una vez');
  const tokenRow = (await s.store.listPrincipalTokens(luis.principal_id))[0];
  assert.equal(shown[1].startsWith(tokenRow.tokenPrefix), true);
  assert.doesNotMatch((await get(boss.cookie, detailUrl)).text, new RegExp(shown[1]), 'no se vuelve a mostrar');
  assert.match((await get(boss.cookie, detailUrl)).text, /portátil/);
  assert.equal((await s.loginWith(shown[1])).response.status, 303, 'el token emitido sirve para entrar');
  assert.equal((await post(`${detailUrl}/grants`, { project: '' })).status, 400);
  assert.equal((await post(`${detailUrl}/grants`, { project: 'Alfa' })).location, detailUrl);
  assert.match((await get(boss.cookie, detailUrl)).text, /<td>alfa<\/td>/);
  assert.equal((await post(`${detailUrl}/grants/alfa/revoke`, {})).location, detailUrl);
  assert.equal((await s.store.listProjectGrants(luis.principal_id)).length, 0);
  const revoke = await post(`/dashboard/admin/tokens/${tokenRow.id}/revoke`, { principal_id: luis.principal_id, reason: 'x' });
  assert.equal(revoke.location, detailUrl);
  assert.match((await get(boss.cookie, detailUrl)).text, /Revoked/);
  assert.equal((await post('/dashboard/admin/tokens/999/revoke', {})).status, 400);
  const actions = (await s.store.listAuthAuditEvents({ limit: 50 })).map((e) => e.action);
  for (const action of ['user.create', 'user.disable', 'user.enable', 'token.create', 'grant.create', 'grant.revoke', 'token.revoke']) assert.ok(actions.includes(action), action);
  assert.equal((await request(s.url, 'POST', '/dashboard/admin/users', { cookie: (await s.loginWith('adm')).cookie, form: { username: 'otro' } })).status, 403, 'el administrador de entorno no gestiona usuarios');
  const envAdmin = await s.loginWith('adm');
  assert.match((await get(envAdmin.cookie, '/dashboard/admin/users')).text, /requires a managed admin token/);
  assert.match((await get(envAdmin.cookie, detailUrl)).text, /requires a managed admin token/);
  assert.equal((await s.store.listAuthAuditEvents({ limit: 50 })).some((e) => e.actorSource === 'legacy_env_admin' && e.metadata.recovery === true), true, 'el acceso heredado tras haber administradores se marca como recuperación');

  // Registro de sincronización: el administrador ve los rechazos por pausa.
  await s.store.setProjectSyncEnabled('beta', false, 'root', 'x');
  const rejected = await fetch(`${s.url}/sync/push`, { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'beta', created_by: 'bea', data: { sessions: [], observations: [], prompts: [] } }) });
  assert.equal(rejected.status, 409);
  const auditPage = await get(envAdmin.cookie, '/dashboard/admin/audit-log?contributor=bea');
  assert.match(auditPage.text, /hx-get="\/dashboard\/admin\/audit-log\/list\?contributor=bea"/);
  const auditList = await get(envAdmin.cookie, '/dashboard/admin/audit-log/list?contributor=bea', { htmx: true });
  assert.match(auditList.text, /<td>chunk_push<\/td><td>rejected_project_paused<\/td>/);
  assert.match((await get(envAdmin.cookie, '/dashboard/admin/audit-log/list?contributor=nadie', { htmx: true })).text, /No Audit Entries/);
  assert.equal((await get(envAdmin.cookie, '/dashboard/admin/audit-log/list?from=ayer')).status, 400);
  assert.match((await get(boss.cookie, '/dashboard/admin/audit-log/list?from=2020-01-01&to=2099-01-01T00:00:00Z', { htmx: true })).text, /No Audit Entries/, 'una vista acotada a proyectos no ve el registro');
  assert.match((await get(envAdmin.cookie, '/dashboard/admin/audit-log/list?from=2020-01-01&to=2099-01-01T00:00:00Z', { htmx: true })).text, /chunk_push/);
  assert.equal((await get(envAdmin.cookie, '/dashboard/admin/audit-log?to=2026-13-45')).status, 400);
});

test('la página de arranque solo sirve al acceso heredado de administración', async (t) => {
  const s = await authenticated(t);
  const anon = await request(s.url, 'GET', '/dashboard/bootstrap');
  assert.deepEqual([anon.status, anon.location], [303, '/dashboard/login?next=%2Fdashboard%2Fbootstrap']);
  const member = await s.loginWith('tok');
  const denied = await request(s.url, 'GET', '/dashboard/bootstrap', { cookie: member.cookie });
  assert.equal(denied.status, 403);
  assert.match(denied.text, /legacy dashboard recovery credential is required/);
  const envAdmin = await s.loginWith('adm');
  const page = await request(s.url, 'GET', '/dashboard/bootstrap', { cookie: envAdmin.cookie });
  assert.match(page.text, /Create first managed admin/);
  const empty = await request(s.url, 'POST', '/dashboard/bootstrap', { cookie: envAdmin.cookie, form: { username: ' ' } });
  assert.equal(empty.status, 400);
  const created = await request(s.url, 'POST', '/dashboard/bootstrap', { cookie: envAdmin.cookie, form: { username: 'primero', email: 'p@x.org' } });
  assert.deepEqual([created.status, created.location], [303, '/dashboard/login']);
  const again = await request(s.url, 'POST', '/dashboard/bootstrap', { cookie: envAdmin.cookie, form: { username: 'segundo' } });
  assert.equal(again.status, 409);
  const events = (await s.store.listAuthAuditEvents({ limit: 20 })).filter((e) => e.action === 'bootstrap.dashboard').map((e) => `${e.outcome}/${e.reasonCode}`);
  assert.deepEqual(events.sort(), ['denied/legacy_recovery_credential_required', 'denied/managed_admin_exists', 'denied/username_required', 'success/'].sort());
});

test('el panel convive con otra versión del navegador vacío', async (t) => {
  const s = await start({ token: 'tok' });
  t.after(s.close);
  const { response, cookie } = await (async () => {
    const r = await request(s.url, 'POST', '/dashboard/login', { form: { token: 'tok' } });
    return { response: r, cookie: r.setCookie.split(';')[0] };
  })();
  assert.equal(response.status, 303);
  assert.match((await request(s.url, 'GET', '/dashboard/browser/observations', { cookie, htmx: true })).text, /No Observations/);
  assert.match((await request(s.url, 'GET', '/dashboard/browser/sessions', { cookie, htmx: true })).text, /No Sessions/);
  assert.match((await request(s.url, 'GET', '/dashboard/browser/prompts', { cookie, htmx: true })).text, /No Prompts/);
  assert.match((await request(s.url, 'GET', '/dashboard/contributors/list', { cookie, htmx: true })).text, /No Contributors Yet/);
  assert.match((await request(s.url, 'GET', '/dashboard/browser', { cookie })).text, /All Projects/);
});
