import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LIST_LIMIT, executeCommand, setupAgents } from '../../../src/tui/commands.js';
import { osc52Sequence } from '../../../src/tui/format.js';
import { addObservation, createSession, getSession } from '../../../src/store/index.js';
import { openTempStore, tempDir } from '../store/helpers.js';

function world(t) {
  const store = openTempStore(t);
  const home = tempDir(t);
  const cwd = join(home, 'proyecto');
  mkdirSync(cwd);
  createSession(store, 's1', 'demo', '/x');
  const ids = ['Usar Redis', 'Usar Postgres', 'Preferir tabulaciones'].map((title) => addObservation(store, { session_id: 's1', type: 'decision', title, content: `elegimos ${title}`, project: 'demo' }).id);
  return { store, ids, ctx: { store, version: '1.0.0', env: {}, home: () => home, cwd: () => cwd, platform: 'darwin', checkLatest: async () => ({ status: 'up_to_date' }) }, home, cwd };
}

test('cargar estadísticas, recientes, sesiones y detalle', (t) => {
  const { ctx, ids } = world(t);
  const stats = executeCommand({ type: 'load-stats' }, ctx);
  assert.deepEqual([stats.type, stats.stats.total_observations, stats.stats.projects], ['stats', 3, ['demo']]);
  const recent = executeCommand({ type: 'load-recent' }, ctx);
  assert.deepEqual([recent.type, recent.observations.map((o) => o.id)], ['recent-observations', [...ids].reverse()]);
  const sessions = executeCommand({ type: 'load-sessions' }, ctx);
  assert.deepEqual([sessions.type, sessions.sessions.map((s) => [s.id, s.observation_count])], ['recent-sessions', [['s1', 3]]]);
  const detail = executeCommand({ type: 'load-detail', id: ids[0] }, ctx);
  assert.deepEqual([detail.type, detail.observation.title], ['observation-detail', 'Usar Redis']);
  const missing = executeCommand({ type: 'load-detail', id: 999 }, ctx);
  assert.deepEqual([missing.type, missing.error.message], ['observation-detail', 'observation #999 not found']);
  assert.equal(executeCommand({ type: 'load-session-observations', id: 's1' }, ctx).observations.length, 3);
  assert.equal(LIST_LIMIT, 50);
});

test('buscar y ver la cronología', (t) => {
  const { ctx, ids } = world(t);
  const found = executeCommand({ type: 'search', query: 'Redis' }, ctx);
  assert.deepEqual([found.type, found.query, found.results.map((r) => r.title)], ['search-results', 'Redis', ['Usar Redis']]);
  const tl = executeCommand({ type: 'load-timeline', id: ids[1] }, ctx);
  assert.deepEqual([tl.type, tl.timeline.focus.id, tl.timeline.before.length, tl.timeline.after.length], ['timeline', ids[1], 1, 1]);
});

test('la cronología trae diez observaciones a cada lado', (t) => {
  const { ctx, store } = world(t);
  const more = Array.from({ length: 30 }, (_, i) => addObservation(store, { session_id: 's1', type: 'note', title: `Nota ${i}`, content: `c${i}`, project: 'demo' }).id);
  const tl = executeCommand({ type: 'load-timeline', id: more[15] }, ctx);
  assert.deepEqual([tl.timeline.before.length, tl.timeline.after.length], [10, 10]);
});

test('los fallos del almacén vuelven como mensajes y no se propagan', (t) => {
  const { ctx } = world(t);
  const cases = { 'load-timeline': 'timeline', search: 'search-results' };
  const timeline = executeCommand({ type: 'load-timeline', id: 12345 }, ctx);
  assert.deepEqual([timeline.type, timeline.error instanceof Error], [cases['load-timeline'], true]);
  const broken = { ...ctx, store: { db: { get() { throw new Error('rota'); }, all() { throw new Error('rota'); } } } };
  for (const [type, extra, msg] of [['load-stats', {}, 'stats'], ['load-recent', {}, 'recent-observations'], ['load-sessions', {}, 'recent-sessions'], ['load-session-observations', { id: 'x' }, 'session-observations']]) {
    const out = executeCommand({ type, ...extra }, broken);
    assert.equal(out.type, msg, type);
    assert.ok(out.error instanceof Error, type);
  }
});

test('borrar una sesión informa del motivo si no se puede', (t) => {
  const { ctx, store } = world(t);
  const blocked = executeCommand({ type: 'delete-session', id: 's1' }, ctx);
  assert.deepEqual([blocked.type, blocked.sessionId, blocked.error.code], ['session-deleted', 's1', 'session_has_observations']);
  const missing = executeCommand({ type: 'delete-session', id: 'nada' }, ctx);
  assert.equal(missing.error.code, 'session_not_found');
  createSession(store, 'vacia', 'demo', '/y');
  const ok = executeCommand({ type: 'delete-session', id: 'vacia' }, ctx);
  assert.deepEqual([ok.error, getSession(store, 'vacia')], [null, null]);
});

test('copiar produce la secuencia OSC 52 y los comandos desconocidos no responden', (t) => {
  const { ctx } = world(t);
  assert.deepEqual(executeCommand({ type: 'copy', content: 'hola ñ' }, ctx), { type: 'clipboard-copied', sequence: osc52Sequence('hola ñ') });
  assert.equal(executeCommand({ type: 'quit' }, ctx), null);
  assert.equal(executeCommand({ type: 'otra' }, ctx), null);
});

test('comprobar la versión usa el comprobador inyectado', async (t) => {
  const { ctx } = world(t);
  const calls = [];
  const out = await executeCommand({ type: 'check-update' }, { ...ctx, checkLatest: async (version, options) => { calls.push([version, options]); return { status: 'update_available', message: 'm' }; } });
  assert.deepEqual(out, { type: 'update-check', result: { status: 'update_available', message: 'm' } });
  assert.deepEqual(calls, [['1.0.0', { env: {} }]]);
  assert.deepEqual(await executeCommand({ type: 'check-update' }, { ...ctx, checkLatest: undefined }), { type: 'update-check', result: { status: '' } }, 'sin URL configurada no hay aviso');
});

test('los destinos de instalación y la instalación en una carpeta de usuario temporal', (t) => {
  const { ctx, home } = world(t);
  const agents = setupAgents(ctx);
  assert.deepEqual(agents.map((a) => a.name), ['vscode-copilot', 'copilot-cli']);
  assert.match(agents[0].description, /^VS Code Copilot/);
  assert.equal(agents[0].installDir, join(home, 'Library/Application Support/Code/User/mcp.json'));
  assert.equal(agents[1].installDir, join(home, '.copilot/mcp-config.json'));
  const out = executeCommand({ type: 'install', agent: 'copilot-cli' }, ctx);
  assert.equal(out.type, 'setup-installed');
  assert.deepEqual(out.result.changes.map((c) => [c.item, c.action]), [['mcp', 'created'], ['instructions', 'created'], ['hooks', 'created']]);
  assert.ok(existsSync(agents[1].installDir));
  const failing = executeCommand({ type: 'install', agent: 'otro' }, ctx);
  assert.deepEqual([failing.type, failing.error instanceof Error], ['setup-installed', true]);
});
