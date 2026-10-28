import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer, SERVER_NAME } from '../../../src/mcp/server.js';
import { MEM_CONTEXT_DEFAULT_MAX_BYTES, MEM_CONTEXT_MAX_BYTES_CEILING, formatContextProjects, memContextMaxBytes } from '../../../src/mcp/tools/context.js';
import { addObservation, createSession, addPrompt, pinObservation } from '../../../src/store/index.js';
import { openTempStore } from '../store/helpers.js';
import { initRepo, tempDir as repoTemp } from '../project/helpers.js';
import { VERSION } from '../../../src/version/index.js';

function setup(t, { allowlist = null, config = {} } = {}) {
  const store = openTempStore(t);
  createSession(store, 's1', 'alfa', '/d');
  createSession(store, 's2', 'beta', '/d');
  const server = createServer(store, { defaultProject: 'alfa', ...config }, allowlist, { env: {} });
  const run = async (name, args = {}) => {
    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    if (res.error) return { rpcError: res.error };
    const result = res.result;
    const text = result.content[0].text;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // texto plano
    }
    return { result, text, json, isError: result.isError === true };
  };
  return { store, server, run };
}

test('el servidor se presenta con su nombre, versión y las herramientas registradas (todas menos mem_doctor)', async (t) => {
  const { server } = setup(t);
  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, SERVER_NAME);
  assert.equal(init.result.serverInfo.version, VERSION);
  const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((x) => x.name), [
    // lectura
    'mem_current_project', 'mem_context', 'mem_get_observation', 'mem_list_projects', 'mem_search', 'mem_search_prompts', 'mem_stats', 'mem_suggest_topic_key', 'mem_timeline',
    // escritura
    'mem_capture_passive', 'mem_delete', 'mem_pin', 'mem_review', 'mem_save', 'mem_save_prompt', 'mem_session_end', 'mem_session_start', 'mem_session_summary', 'mem_unpin',
    'mem_update',
    // curación (mem_doctor se registra con el diagnóstico)
    'mem_compare', 'mem_consolidate', 'mem_judge', 'mem_judge_many', 'mem_merge_projects', 'mem_session_finalize',
  ].sort());
  assert.ok(list.result.tools.filter((x) => x.defer_loading).length > 0);
});

test('la lista permitida limita las herramientas expuestas', async (t) => {
  const { server, run } = setup(t, { allowlist: new Set(['mem_search']) });
  const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((x) => x.name), ['mem_search']);
  assert.equal((await run('mem_stats')).rpcError.code, -32602);
});

test('mem_search encuentra por proyecto, formatea y respeta match_mode / response_format', async (t) => {
  const { store, run } = setup(t);
  const a = addObservation(store, { session_id: 's1', type: 'decision', title: 'Usar SQLite', content: 'elegimos sqlite embebido' }).id;
  addObservation(store, { session_id: 's2', type: 'decision', title: 'Usar Postgres', content: 'elegimos postgres para beta' });
  const found = await run('mem_search', { query: 'elegimos' });
  assert.equal(found.json.project, 'alfa');
  assert.equal(found.json.project_source, 'process_override');
  assert.match(found.json.result, new RegExp(`^Found 1 memories:\\n\\n\\[1\\] #${a} \\(decision\\) — Usar SQLite`));
  assert.deepEqual(found.json.results.map((r) => r.id), [a]);
  const all = await run('mem_search', { query: 'elegimos', all_projects: true });
  assert.equal(all.json.project_source, 'all_projects');
  assert.equal(all.json.results.length, 2);
  const compact = await run('mem_search', { query: 'elegimos', response_format: 'compact' });
  assert.equal(compact.json.result, 'Found 1 memories.');
  assert.equal(compact.json.results[0].id, a);
  const none = await run('mem_search', { query: 'inexistente' });
  assert.equal(none.json.result, 'No memories found for: "inexistente"');
  assert.match((await run('mem_search', { query: 'x', match_mode: 'mal' })).text, /^invalid match_mode "mal"/);
  assert.match((await run('mem_search', { query: 'x', response_format: 'full' })).text, /^invalid response_format "full"/);
});

test('un proyecto explícito inexistente da un error estructurado con los proyectos disponibles', async (t) => {
  const { store, run } = setup(t);
  addObservation(store, { session_id: 's1', type: 'manual', title: 'A', content: 'c' });
  addObservation(store, { session_id: 's2', type: 'manual', title: 'B', content: 'c' });
  const r = await run('mem_search', { query: 'x', project: 'nada' });
  assert.equal(r.isError, true);
  assert.equal(r.json.error_code, 'unknown_project');
  assert.deepEqual([...r.json.available_projects].sort(), ['alfa', 'beta']);
  assert.equal(r.json.message, 'Project "nada" not found in store');
});

test('mem_get_observation: contenido completo, historial paginado y errores', async (t) => {
  const { store, run } = setup(t);
  const id = addObservation(store, { session_id: 's1', type: 'manual', title: 'Nota', content: 'v1', topic_key: 'nota/uno' }).id;
  addObservation(store, { session_id: 's1', type: 'manual', title: 'Nota', content: 'v2', topic_key: 'nota/uno' });
  const got = await run('mem_get_observation', { id });
  assert.match(got.json.result, /^#\d+ \[manual\] Nota\nv2\nSession: s1\nProject: alfa\nScope: project\nTopic: nota\/uno/);
  const withHistory = await run('mem_get_observation', { id, include_history: true });
  assert.equal(withHistory.json.version_count, 1);
  assert.match(withHistory.json.result, /History \(1 previous version\):/);
  assert.equal(withHistory.json.history[0].content, 'v1');
  assert.equal((await run('mem_get_observation', { id: 999 })).text, 'Observation #999 not found');
  assert.equal((await run('mem_get_observation', {})).text, 'id is required');
  assert.match((await run('mem_get_observation', { id, include_history: true, history_cursor: -2 })).text, /non-negative integer/);
  // una observación de otro proyecto se lee con el proyecto que tiene guardado
  const other = addObservation(store, { session_id: 's2', type: 'manual', title: 'Beta', content: 'c' }).id;
  assert.match((await run('mem_get_observation', { id: other })).json.result, /Project: beta/);
});

test('mem_timeline devuelve el entorno de una observación del proyecto', async (t) => {
  const { store, run } = setup(t);
  const ids = [1, 2, 3].map((n) => addObservation(store, { session_id: 's1', type: 'manual', title: `Obs ${n}`, content: `contenido ${n}` }).id);
  const out = await run('mem_timeline', { observation_id: ids[1], before: 1, after: 1 });
  assert.match(out.json.result, /─── Before ───\n {2}#\d+ \[manual\] Obs 1/);
  assert.match(out.json.result, />>> #\d+ \[manual\] Obs 2 <<</);
  assert.match(out.json.result, /─── After ───\n {2}#\d+ \[manual\] Obs 3/);
  assert.equal((await run('mem_timeline', {})).text, 'observation_id is required');
  assert.equal((await run('mem_timeline', { observation_id: 999 })).text, 'Timeline error: observation not found');
  const beta = addObservation(store, { session_id: 's2', type: 'manual', title: 'B', content: 'c' }).id;
  assert.equal((await run('mem_timeline', { observation_id: beta })).text, 'Timeline error: observation not found in resolved project');
});

test('mem_search_prompts valida los argumentos y filtra por proyecto', async (t) => {
  const { store, run } = setup(t);
  addPrompt(store, { session_id: 's1', content: 'refactorizar el módulo trigram', project: 'alfa' });
  addPrompt(store, { session_id: 's2', content: 'otro trigram distinto', project: 'beta' });
  assert.equal((await run('mem_search_prompts', {})).text, 'query parameter is required');
  assert.equal((await run('mem_search_prompts', { query: 'trigram', project: '  ' })).text, 'project must not be blank');
  assert.equal((await run('mem_search_prompts', { query: 'trigram', all_projects: 'si' })).text, 'all_projects must be a boolean');
  assert.equal((await run('mem_search_prompts', { query: 'trigram', all_projects: true, project: 'alfa' })).text, 'project and all_projects cannot be used together');
  const local = await run('mem_search_prompts', { query: 'trigram' });
  assert.equal(local.json.result, 'Found 1 stored prompts.');
  assert.equal(local.json.results[0].project, 'alfa');
  assert.equal((await run('mem_search_prompts', { query: 'trigram', all_projects: true })).json.results.length, 2);
});

test('mem_context aplica el presupuesto de bytes y añade el pie de estadísticas', async (t) => {
  const { store, run } = setup(t);
  const sessionsOnly = (await run('mem_context')).json.result;
  assert.match(sessionsOnly, /^## Memory from Previous Sessions\n\n### Recent Sessions\n- \*\*alfa\*\* \(.+\) \[0 observations\]/);
  assert.match(sessionsOnly, /Memory stats: 2 sessions, 0 observations across projects: none$/);
  const empty = createServer(openTempStore(t), {}, null, { env: {} });
  const emptyRes = await empty.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mem_context', arguments: {} } });
  assert.equal(JSON.parse(emptyRes.result.content[0].text).result, 'No previous session memories found.');
  for (let i = 0; i < 12; i++) addObservation(store, { session_id: 's1', type: 'manual', title: `Hallazgo ${i}`, content: 'x'.repeat(400) });
  const full = await run('mem_context');
  assert.match(full.json.result, /\n---\nMemory stats: 2 sessions, 12 observations across projects: alfa$/);
  const small = await run('mem_context', { max_bytes: 700 });
  assert.ok(Buffer.byteLength(small.json.result) <= 700);
  assert.ok(Buffer.byteLength(small.json.result) < Buffer.byteLength(full.json.result));
  assert.equal(memContextMaxBytes(undefined), MEM_CONTEXT_DEFAULT_MAX_BYTES);
  assert.equal(memContextMaxBytes(0), MEM_CONTEXT_DEFAULT_MAX_BYTES);
  assert.equal(memContextMaxBytes(1.5), MEM_CONTEXT_DEFAULT_MAX_BYTES);
  assert.equal(memContextMaxBytes('100'), MEM_CONTEXT_DEFAULT_MAX_BYTES);
  assert.equal(memContextMaxBytes(100), 100);
  assert.equal(memContextMaxBytes(10 ** 9), MEM_CONTEXT_MAX_BYTES_CEILING);
  assert.equal(formatContextProjects([]), 'none');
  assert.equal(formatContextProjects(['a', 'b']), 'a, b');
  assert.equal(formatContextProjects('abcdefghij'.split('')), 'a, b, c, d, e, f, g, h, +2 more');
});

test('mem_context incluye las observaciones fijadas', async (t) => {
  const { store, run } = setup(t);
  const id = addObservation(store, { session_id: 's1', type: 'manual', title: 'Regla fijada', content: 'no tocar' }).id;
  pinObservation(store, id, true);
  assert.match((await run('mem_context')).json.result, /Regla fijada/);
});

test('mem_stats, mem_list_projects y mem_suggest_topic_key', async (t) => {
  const { store, run } = setup(t);
  addObservation(store, { session_id: 's1', type: 'manual', title: 'A', content: 'c' });
  const all = await run('mem_stats');
  assert.equal(all.json.result, 'Memory System Stats:\n- Sessions: 2\n- Observations: 1\n- Prompts: 0\n- Projects: alfa');
  assert.equal(all.json.project, 'alfa'); // hay proyecto fijado para el proceso
  const listed = await run('mem_list_projects');
  assert.equal(listed.json.count, 2);
  assert.deepEqual(listed.json.projects.map((p) => p.name), ['alfa', 'beta']);
  assert.equal((await run('mem_suggest_topic_key', {})).text, 'provide title or content to suggest a topic_key');
  const suggested = await run('mem_suggest_topic_key', { type: 'architecture', title: 'Modelo de datos' });
  assert.equal(suggested.text, 'Suggested topic_key: architecture/modelo-de-datos');
  assert.equal((await run('mem_suggest_topic_key', { title: '!!!' })).text, 'Suggested topic_key: topic/general');
});

test('mem_current_project resuelve el proyecto fijado, el de un directorio git y el ambiguo', async (t) => {
  const { run } = setup(t);
  const pinned = await run('mem_current_project', { directory: '/tmp' });
  assert.equal(pinned.json.project, 'alfa');
  assert.equal(pinned.json.project_source, 'process_override');
  assert.equal(pinned.json.cwd, '/tmp');

  const store = openTempStore(t);
  const server = createServer(store, {}, null, { env: {} });
  const call = async (args) => JSON.parse((await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mem_current_project', arguments: args } })).result.content[0].text);
  const parent = repoTemp(t);
  const repo = initRepo(`${parent}/mi-repo`);
  const detected = await call({ directory: repo });
  assert.equal(detected.project, 'mi-repo');
  assert.equal(detected.project_source, 'git_root');
  assert.equal((await call({ cwd: repo })).project, 'mi-repo'); // alias de directory
  initRepo(`${parent}/segundo`);
  const ambiguous = await call({ directory: parent });
  assert.equal(ambiguous.project_source, 'ambiguous');
  assert.deepEqual(ambiguous.available_projects, ['mi-repo', 'segundo']);
  assert.match(ambiguous.error_hint, /multiple/i);
});

test('el protocolo completo por stdio responde initialize, tools/list y tools/call', async (t) => {
  const { server } = setup(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (c) => lines.push(...c.toString().split('\n').filter(Boolean)));
  const done = server.serve({ input, output, graceMs: 1000 });
  for (const msg of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mem_stats', arguments: {} } },
  ]) input.write(`${JSON.stringify(msg)}\n`);
  input.end();
  await done;
  const parsed = lines.map((l) => JSON.parse(l));
  assert.deepEqual(parsed.map((m) => m.id), [1, 2]);
  assert.match(JSON.parse(parsed[1].result.content[0].text).result, /^Memory System Stats:/);
});
