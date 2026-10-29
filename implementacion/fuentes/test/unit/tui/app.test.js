import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS, mountTui } from './helpers.js';
import { addObservation, createSession, endSession, getSession } from '../../../src/store/index.js';
import { osc52Sequence } from '../../../src/tui/format.js';
import { openTempStore, tempDir } from '../store/helpers.js';

function world(t, { rows = 40, columns = 100, checkLatest } = {}) {
  const store = openTempStore(t);
  const home = tempDir(t);
  const cwd = join(home, 'proyecto');
  mkdirSync(cwd);
  createSession(store, 's1', 'demo', '/x');
  createSession(store, 'vacia', 'otro', '/y');
  const content = Array.from({ length: 40 }, (_, i) => `línea ${i} del contenido`).join('\n');
  const ids = [['Usar Redis', 'elegimos Redis como caché'], ['Usar Postgres', 'elegimos Postgres'], ['Contenido largo', content]]
    .map(([title, body]) => addObservation(store, { session_id: 's1', type: 'decision', title, content: body, project: 'demo' }).id);
  const tui = mountTui({ store, version: '1.2.3', env: {}, home: () => home, cwd: () => cwd, platform: 'darwin', checkLatest: checkLatest ?? (async () => ({ status: '' })) }, { rows, columns });
  t.after(() => tui.unmount());
  return { tui, store, ids, home };
}

const rows = (frame) => frame.split('\n').length;

test('el panel muestra el logotipo, las estadísticas y el menú', async (t) => {
  const { tui } = world(t);
  await tui.settle(120);
  const frame = tui.frame();
  for (const text of ['SYSTEM ONLINE', '> odin 1.2.3', '3  observations', '1  projects', 'Projects', '• demo', '▸ Search memories', 'Set up Copilot', 'j/k navigate • enter select • s search • q quit']) {
    assert.ok(frame.includes(text), `falta «${text}»\n${frame}`);
  }
});

test('el aviso de versión nueva aparece en el panel', async (t) => {
  const { tui } = world(t, { checkLatest: async () => ({ status: 'update_available', message: 'Update available: 1.2.3 -> 9.9.9' }) });
  await tui.settle(120);
  assert.ok(tui.frame().includes('Update available: 1.2.3 -> 9.9.9'));
});

test('buscar, ver el resultado, el detalle y volver', async (t) => {
  const { tui } = world(t);
  await tui.settle(100);
  await tui.press('s');
  assert.ok(tui.frame().includes('Search Memories'));
  assert.ok(tui.frame().includes('Type a query and press enter'));
  await tui.press('R', 'e', 'd', 'i', 's');
  assert.ok(tui.frame().includes('> Redis'));
  await tui.press(KEYS.enter);
  await tui.settle(80);
  const results = tui.frame();
  assert.ok(results.includes('Search: "Redis" — 1 result'), results);
  assert.ok(results.includes('Usar Redis'));
  assert.ok(results.includes('[decision'));
  await tui.press(KEYS.enter);
  await tui.settle(80);
  const detail = tui.frame();
  assert.ok(detail.includes('Observation #1') && detail.includes('Content') && detail.includes('elegimos Redis como caché'), detail);
  assert.ok(detail.includes('Project:') && detail.includes('demo'));
  await tui.press('q');
  await tui.settle(60);
  assert.ok(tui.frame().includes('Search: "Redis"'), 'q vuelve a los resultados');
});

test('una búsqueda sin resultados lo dice', async (t) => {
  const { tui } = world(t);
  await tui.press('s', 'z', 'z', 'z', 'z', KEYS.enter);
  await tui.settle(80);
  assert.ok(tui.frame().includes('No memories found. Try a different query.'));
});

test('copiar con c envía la secuencia OSC 52 y muestra el aviso un momento', async (t) => {
  const { tui } = world(t);
  await tui.press('j', KEYS.enter);
  await tui.settle(80);
  assert.ok(tui.frame().includes('Recent Observations — 3 total'));
  await tui.press('c');
  await tui.settle(80);
  assert.ok(tui.raw().includes(osc52Sequence('elegimos Redis como caché'.replace('Redis como caché', 'Redis como caché'))) || tui.raw().includes('\x1b]52;c;'), 'se emitió la secuencia');
  assert.ok(tui.frame().includes('✓ Copied!'));
  await tui.settle(2100);
  assert.ok(!tui.frame().includes('✓ Copied!'), 'el aviso desaparece a los dos segundos');
});

test('la lista de recientes se desplaza y el detalle largo tiene ventana', async (t) => {
  const { tui } = world(t, { rows: 24 });
  await tui.press('j', KEYS.enter);
  await tui.settle(80);
  assert.ok(tui.frame().includes('#3'));
  await tui.press(KEYS.enter);
  await tui.settle(80);
  const first = tui.frame();
  assert.ok(first.includes('línea 0 del contenido'), first);
  assert.match(first, /line 1-\d+ of 40/);
  await tui.press('j', 'j', 'j');
  const scrolled = tui.frame();
  assert.ok(!scrolled.includes('línea 0 del contenido') && scrolled.includes('línea 3 del contenido'), scrolled);
  assert.match(scrolled, /line 4-\d+ of 40/);
});

test('ninguna pantalla se pasa de la altura del terminal', async (t) => {
  for (const height of [14, 18, 24, 30]) {
    const { tui } = world(t, { rows: height });
    await tui.settle(100);
    const check = async (label) => {
      await tui.settle(60);
      assert.ok(rows(tui.frame().replace(/\n+$/, '')) <= height, `${label} a ${height}: ${rows(tui.frame())} filas\n${tui.frame()}`);
    };
    await tui.press('j', KEYS.enter); await check('recientes');
    await tui.press(KEYS.enter); await check('detalle');
    await tui.press('t'); await check('cronología');
    tui.unmount();
  }
});

test('la cronología muestra lo anterior, lo posterior y la sesión', async (t) => {
  const { tui } = world(t);
  await tui.press('j', KEYS.enter);
  await tui.settle(80);
  await tui.press('j', 't');
  await tui.settle(80);
  const frame = tui.frame();
  assert.ok(frame.includes('Timeline — Observation #2 (3 total in session)'), frame);
  assert.ok(frame.includes('Before') && frame.includes('After'));
  assert.ok(frame.includes('Session: s1') && frame.includes('Project: demo'));
  assert.ok(frame.includes('Usar Postgres'));
  await tui.press('q');
  await tui.settle(60);
  assert.ok(tui.frame().includes('Recent Observations'));
});

test('sesiones: ver, abrir y borrar una vacía con confirmación', async (t) => {
  const { tui, store } = world(t);
  await tui.press('j', 'j', KEYS.enter);
  await tui.settle(80);
  const list = tui.frame();
  assert.ok(list.includes('Sessions — 2 total'), list);
  assert.ok(list.includes('demo') && list.includes('otro'));
  await tui.press('d');
  const prompt = tui.frame();
  assert.ok(prompt.includes('Confirm Session Delete') && prompt.includes('Delete session "vacia" from project "otro"?'), prompt);
  assert.ok(prompt.includes('[y] Delete  [n] Cancel  [esc] Cancel'));
  await tui.press('n');
  assert.ok(tui.frame().includes('Sessions — 2 total'));
  await tui.press('d', 'y');
  await tui.settle(120);
  assert.ok(tui.frame().includes('Sessions — 1 total'), tui.frame());
  assert.equal(getSession(store, 'vacia'), null);
  // la sesión con observaciones no se puede borrar y se explica por qué
  await tui.press('d', 'y');
  await tui.settle(80);
  assert.ok(tui.frame().includes('Error: Cannot delete session "s1": it still has observations.'), tui.frame());
  await tui.press(KEYS.enter);
  await tui.settle(80);
  assert.ok(tui.frame().includes('Session: demo') && tui.frame().includes('Observations (3)'), tui.frame());
  await tui.press('q');
  await tui.settle(60);
  assert.ok(tui.frame().includes('Sessions — 1 total'));
});

test('preparar Copilot: elegir un destino, instalar y ver los cambios', async (t) => {
  const { tui, home } = world(t);
  await tui.press('j', 'j', 'j', KEYS.enter);
  const choose = tui.frame();
  assert.ok(choose.includes('Select where to set up odin') && choose.includes('VS Code Copilot') && choose.includes('Copilot CLI'), choose);
  assert.ok(choose.includes(join(home, '.copilot', 'mcp-config.json')));
  await tui.press('j', KEYS.enter);
  await tui.settle(150);
  const done = tui.frame();
  assert.ok(done.includes('✓ Registered copilot-cli'), done);
  assert.ok(done.includes('MCP server') && done.includes('created') && done.includes('Restart the Copilot CLI'), done);
  assert.ok(existsSync(join(home, '.copilot', 'mcp-config.json')));
  await tui.press(KEYS.enter);
  await tui.settle(80);
  assert.ok(tui.frame().includes('Actions'), 'vuelve al panel');
});

test('salir con q, con Ctrl+C y con la opción Quit', async (t) => {
  const quit = world(t);
  await quit.tui.press('q');
  await quit.tui.exited;
  const ctrl = world(t);
  await ctrl.tui.press('s');
  await ctrl.tui.press(KEYS.ctrlC);
  await ctrl.tui.exited;
  const menu = world(t);
  await menu.tui.press('j', 'j', 'j', 'j', KEYS.enter);
  await menu.tui.exited;
});

test('cambiar el tamaño del terminal vuelve a calcular la ventana', async (t) => {
  const { tui } = world(t, { rows: 40 });
  await tui.press('j', KEYS.enter);
  await tui.press(KEYS.enter);
  await tui.settle(60);
  tui.resize(100, 12);
  await tui.settle(80);
  assert.ok(rows(tui.frame().replace(/\n+$/, '')) <= 12, tui.frame());
});

test('un directorio con sesión terminada no rompe la TUI', async (t) => {
  const { tui, store } = world(t);
  endSession(store, 's1', 'resumen de prueba');
  await tui.press('j', 'j', KEYS.enter);
  await tui.settle(100);
  assert.ok(tui.frame().includes('resumen de prueba'));
});
