import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DASHBOARD_MENU, DELETE_STATE, SCREEN, detailContentLines, detailLayout, detailMetadata, initialCommands, initialState, sessionDeleteErrorMessage, timelineRows, timelineViewport, update,
} from '../../../src/tui/model.js';
import { inputValue } from '../../../src/tui/text-input.js';

const AGENTS = [{ name: 'vscode-copilot', description: 'VS Code', installDir: '/a' }, { name: 'copilot-cli', description: 'CLI', installDir: '/b' }];
const deps = { agents: () => AGENTS };
const obs = (id, over = {}) => ({ id, type: 'decision', title: `T${id}`, content: `contenido ${id}`, project: 'demo', created_at: '2026-01-01 00:00:00', session_id: 's1', pinned: false, review_after: null, ...over });
const many = (n) => Array.from({ length: n }, (_, i) => obs(i + 1));

/** Aplica mensajes en cadena y devuelve el estado final con todos los comandos emitidos. */
function run(state, ...msgs) {
  const cmds = [];
  let current = state;
  for (const msg of msgs) {
    const out = update(current, typeof msg === 'string' ? { type: 'key', key: msg, input: msg.length === 1 ? msg : '' } : msg, deps);
    current = out.state;
    cmds.push(...out.cmds);
  }
  return { state: current, cmds };
}
const at = (screen, extra = {}) => ({ ...initialState({ version: '1.2.3' }), screen, height: 40, width: 100, ...extra });

test('estado inicial y comandos de arranque', () => {
  const s = initialState({ version: '9' });
  assert.deepEqual([s.screen, s.version, s.cursor, s.stats, s.searchInput.placeholder, s.searchInput.charLimit], ['dashboard', '9', 0, null, 'Search memories...', 256]);
  assert.deepEqual(initialCommands(), [{ type: 'load-stats' }, { type: 'check-update' }]);
  assert.deepEqual(DASHBOARD_MENU, ['Search memories', 'Recent observations', 'Browse sessions', 'Set up Copilot', 'Quit']);
});

test('ctrl+c sale desde cualquier pantalla, incluso con el campo de búsqueda activo', () => {
  for (const screen of Object.values(SCREEN)) assert.deepEqual(run(at(screen), 'ctrl+c').cmds, [{ type: 'quit' }], screen);
  const searching = run(at(SCREEN.dashboard), 's').state;
  assert.equal(searching.searchInput.focused, true);
  assert.deepEqual(run(searching, 'ctrl+c').cmds, [{ type: 'quit' }]);
});

test('panel: navegación, selección y atajos', () => {
  let { state } = run(at(SCREEN.dashboard), 'j', 'j', 'j', 'j', 'j', 'j');
  assert.equal(state.cursor, 4, 'no pasa del último');
  assert.equal(run(state, 'k', 'k', 'k', 'k', 'k', 'up').state.cursor, 0);
  assert.deepEqual(run(state, 'enter').cmds, [{ type: 'quit' }]);
  assert.deepEqual(run(at(SCREEN.dashboard), 'q').cmds, [{ type: 'quit' }]);
  const recent = run(at(SCREEN.dashboard, { cursor: 1 }), 'enter');
  assert.deepEqual([recent.state.screen, recent.state.cursor, recent.state.prevScreen, recent.cmds], ['recent', 0, 'dashboard', [{ type: 'load-recent' }]]);
  const sessions = run(at(SCREEN.dashboard, { cursor: 2 }), ' ');
  assert.deepEqual([sessions.state.screen, sessions.cmds], ['sessions', [{ type: 'load-sessions' }]]);
  const setup = run(at(SCREEN.dashboard, { cursor: 3, setupDone: true, setupError: 'x' }), 'enter');
  assert.deepEqual([setup.state.screen, setup.state.setupAgents, setup.state.setupDone, setup.state.setupError], ['setup', AGENTS, false, '']);
  for (const key of ['s', '/']) {
    const search = run(at(SCREEN.dashboard), key);
    assert.deepEqual([search.state.screen, search.state.prevScreen, search.state.searchInput.focused, inputValue(search.state.searchInput)], ['search', 'dashboard', true, '']);
  }
  assert.equal(run(at(SCREEN.dashboard, { cursor: 0 }), 'enter').state.screen, 'search');
  assert.equal(run(at(SCREEN.dashboard), 'x').state.screen, 'dashboard');
});

test('búsqueda: escribir, enviar, cancelar y volver a enfocar', () => {
  let { state } = run(at(SCREEN.dashboard), 's');
  const typed = run(state, { type: 'key', key: 'r', input: 'r' }, { type: 'key', key: 'e', input: 'e' }, { type: 'key', key: 'x', input: 'x' }, { type: 'key', key: 'backspace', input: '' });
  assert.equal(inputValue(typed.state.searchInput), 're');
  assert.deepEqual(run(typed.state, 'enter').cmds, [{ type: 'search', query: 're' }]);
  assert.equal(run(typed.state, 'enter').state.searchInput.focused, false);
  assert.deepEqual(run(state, 'enter').cmds, [], 'una consulta vacía no busca');
  const esc = run(typed.state, 'esc');
  assert.deepEqual([esc.state.screen, esc.state.searchInput.focused], ['dashboard', false]);
  const blurred = run(typed.state, 'enter').state;
  assert.equal(run(blurred, 'i').state.searchInput.focused, true);
  assert.equal(run(blurred, '/').state.searchInput.focused, true);
  assert.equal(run(blurred, 'q').state.screen, 'dashboard');
  assert.equal(run(blurred, 'esc').state.screen, 'dashboard');
  assert.deepEqual(run(blurred, 'z').state, blurred);
  const pasted = run(state, { type: 'key', key: 'texto pegado', input: 'texto pegado' });
  assert.equal(inputValue(pasted.state.searchInput), 'texto pegado');
});

test('resultados de búsqueda: mensajes, lista con desplazamiento y acciones', () => {
  const results = many(30);
  let state = run(at(SCREEN.search, { height: 20 }), { type: 'search-results', results, query: 'redis' }).state;
  assert.deepEqual([state.screen, state.searchResults.length, state.searchQuery, state.cursor, state.scroll], ['search-results', 30, 'redis', 0, 0]);
  // altura 20: (20-10)/2 = 5 elementos visibles
  state = run(state, 'j', 'j', 'j', 'j', 'j').state;
  assert.deepEqual([state.cursor, state.scroll], [5, 1], 'baja la ventana al pasar del último visible');
  state = run(state, 'k', 'k', 'k', 'k', 'k').state;
  assert.deepEqual([state.cursor, state.scroll], [0, 0], 'y la sube al volver');
  assert.equal(run(state, 'up').state.cursor, 0);
  assert.equal(run(at(SCREEN.searchResults, { height: 20, searchResults: results, cursor: 29, scroll: 25 }), 'j').state.cursor, 29, 'no pasa del último');
  assert.deepEqual(run(state, 'enter').cmds, [{ type: 'load-detail', id: 1 }]);
  assert.equal(run(state, 'enter').state.prevScreen, 'search-results');
  assert.deepEqual(run(state, 'c').cmds, [{ type: 'copy', content: 'contenido 1' }]);
  assert.deepEqual(run(state, 't').cmds, [{ type: 'load-timeline', id: 1 }]);
  const again = run(state, '/');
  assert.deepEqual([again.state.screen, again.state.prevScreen, again.state.searchInput.focused], ['search', 'search-results', true]);
  assert.equal(run(state, 's').state.screen, 'search');
  const back = run(state, 'esc');
  assert.deepEqual([back.state.screen, back.state.prevScreen, back.state.cursor, back.state.scroll, back.state.searchInput.focused], ['search', 'dashboard', 0, 0, true]);
  const empty = at(SCREEN.searchResults);
  assert.deepEqual(run(empty, 'enter', 'c', 't').cmds, [], 'sin resultados no hay acciones');
});

test('el tamaño de la ventana mínima de una lista es de tres elementos', () => {
  const state = at(SCREEN.searchResults, { height: 0, searchResults: many(10) });
  assert.deepEqual(run(state, 'j', 'j', 'j', 'j').state.scroll, 2, 'con 3 visibles y el cursor en 4 la ventana empieza en 2');
});

test('recientes: acciones y vuelta al panel con las estadísticas actualizadas', () => {
  const loaded = run(at(SCREEN.recent), { type: 'recent-observations', observations: many(3) }).state;
  assert.equal(loaded.recentObservations.length, 3);
  assert.deepEqual(run(loaded, 'enter').cmds, [{ type: 'load-detail', id: 1 }]);
  assert.equal(run(loaded, 'enter').state.prevScreen, 'recent');
  assert.deepEqual(run(loaded, 'j', 't').cmds, [{ type: 'load-timeline', id: 2 }]);
  assert.deepEqual(run(loaded, 'j', 'j', 'c').cmds, [{ type: 'copy', content: 'contenido 3' }]);
  const back = run({ ...loaded, cursor: 2, scroll: 1 }, 'esc');
  assert.deepEqual([back.state.screen, back.state.cursor, back.state.scroll, back.cmds], ['dashboard', 0, 0, [{ type: 'load-stats' }]]);
  assert.deepEqual(run(at(SCREEN.recent), 'q').cmds, [{ type: 'load-stats' }]);
});

test('detalle: contenido partido, ventana, desplazamiento acotado y vuelta recargando', () => {
  const o = obs(7, { content: Array.from({ length: 60 }, (_, i) => `línea ${i}`).join('\n') });
  let state = run(at(SCREEN.recent, { height: 30, prevScreen: 'recent' }), { type: 'observation-detail', observation: o }).state;
  assert.deepEqual([state.screen, state.detailScroll], ['observation-detail', 0]);
  assert.equal(detailContentLines(state).length, 60);
  const layout = detailLayout(state);
  assert.deepEqual(layout, { metadata: detailMetadata(o).length, viewport: 30 - (detailMetadata(o).length + 10) });
  const max = 60 - layout.viewport;
  for (let i = 0; i < max + 5; i++) state = run(state, 'j').state;
  assert.equal(state.detailScroll, max, 'no pasa del máximo');
  state = run(state, { type: 'size', width: 100, height: 60 }).state;
  assert.equal(state.detailScroll, 60 - detailLayout(state).viewport, 'al crecer la ventana el desplazamiento se acota');
  assert.equal(run(state, 'up').state.detailScroll, state.detailScroll - 1);
  assert.deepEqual(run(state, 'c').cmds, [{ type: 'copy', content: o.content }]);
  assert.deepEqual(run(state, 't').cmds, [{ type: 'load-timeline', id: 7 }]);
  const back = run(state, 'esc');
  assert.deepEqual([back.state.screen, back.state.detailScroll, back.cmds], ['recent', 0, [{ type: 'load-recent' }]]);
  const fromSearch = run({ ...state, prevScreen: 'search-results' }, 'q');
  assert.deepEqual([fromSearch.state.screen, fromSearch.cmds], ['search-results', []]);
  assert.equal(run(at(SCREEN.observationDetail), 'c').cmds.length, 0, 'sin observación no hay nada que copiar');
});

test('el contenido del detalle se parte a la anchura del terminal menos los márgenes', () => {
  const content = Array.from({ length: 200 }, () => 'a').join(' ');
  const lines = detailContentLines(at(SCREEN.observationDetail, { width: 100, selectedObservation: obs(1, { content }) }));
  assert.equal(Math.max(...lines.map((l) => l.length)), 91, 'cada línea llega a 92 caracteres como máximo (46 letras y 45 espacios)');
  assert.equal(detailContentLines(at(SCREEN.observationDetail, { width: 0, selectedObservation: obs(1, { content: 'x'.repeat(45) }) })).length, 3, 'sin anchura conocida usa 20');
  assert.equal(detailContentLines(at(SCREEN.observationDetail, { width: 3, selectedObservation: obs(1, { content: 'abc' }) })).length, 3, 'una ventana muy estrecha usa 1');
});

test('un resultado de búsqueda nuevo vuelve al principio de la lista', () => {
  const out = run(at(SCREEN.searchResults, { cursor: 7, scroll: 4, searchResults: many(10) }), { type: 'search-results', results: many(3), query: 'otra' }).state;
  assert.deepEqual([out.cursor, out.scroll, out.searchResults.length, out.searchQuery], [0, 0, 3, 'otra']);
});

test('detalle en una terminal baja quita metadatos del final', () => {
  const o = obs(1, { review_after: '2027-01-01 00:00:00', tool_name: 'bash' });
  const full = detailMetadata(o);
  assert.deepEqual(full.map((r) => r[0]), ['Type', 'Title', 'Session', 'Created', 'State', 'Pinned', 'Review', 'Tool', 'Project']);
  const base = at(SCREEN.observationDetail, { selectedObservation: o });
  assert.deepEqual(detailLayout({ ...base, height: 0 }), { metadata: 9, viewport: 5 });
  assert.deepEqual(detailLayout({ ...base, height: 30 }), { metadata: 9, viewport: 11 });
  assert.deepEqual(detailLayout({ ...base, height: 19 }), { metadata: 8, viewport: 1 }, 'sin sitio para el contenido se quita un metadato');
  assert.deepEqual(detailLayout({ ...base, height: 14 }), { metadata: 3, viewport: 1 });
  assert.deepEqual(detailLayout({ ...base, height: 5 }), { metadata: 0, viewport: 0 });
  assert.deepEqual(detailLayout(at(SCREEN.observationDetail)), { metadata: 0, viewport: 0 });
  const sinOpcionales = detailMetadata(obs(1, { project: '', tool_name: '' }));
  assert.equal(sinOpcionales.length, 6);
  assert.deepEqual(detailMetadata(obs(1, { review_after: '2020-01-01 00:00:00' })).find((r) => r[0] === 'State'), ['State', 'needs_review', 'state']);
  assert.deepEqual(detailMetadata(obs(1, { pinned: 1 })).find((r) => r[0] === 'Pinned'), ['Pinned', 'true', 'plain']);
});

test('cronología: filas, ventana, desplazamiento acotado y vuelta', () => {
  const entries = (from, n) => Array.from({ length: n }, (_, i) => obs(from + i));
  const tl = { focus: obs(50), before: entries(1, 10), after: entries(60, 10), session_info: { id: 's1', project: 'demo' }, total_in_range: 21 };
  assert.deepEqual(timelineRows(null), []);
  const rows = timelineRows(tl);
  assert.deepEqual(rows.map((r) => r.kind).filter((k, i, a) => k !== a[i - 1]), ['session', 'heading', 'entry', 'connector', 'focus-title', 'focus-content', 'connector', 'heading', 'entry']);
  assert.equal(rows.length, 1 + 1 + 10 + 1 + 2 + 1 + 1 + 10);
  assert.equal(timelineRows({ ...tl, before: [], after: [], session_info: null }).length, 2, 'solo la observación enfocada');
  const base = at(SCREEN.timeline, { prevScreen: 'search-results', scroll: 0, timeline: tl, height: 20 });
  assert.equal(timelineViewport(base), 13);
  assert.equal(timelineViewport({ ...base, height: 5 }), 3);
  assert.equal(timelineViewport({ ...base, height: 0 }), 30);
  const max = rows.length - 13;
  assert.equal(run(base, 'up').state.scroll, 0);
  assert.equal(run(base, 'j', 'j').state.scroll, 2);
  assert.equal(run(base, 'j', 'j', 'k').state.scroll, 1);
  assert.equal(run(base, ...Array(max + 10).fill('j')).state.scroll, max, 'no pasa del final');
  assert.equal(run({ ...base, scroll: max }, { type: 'size', width: 100, height: 60 }).state.scroll, 0, 'al crecer la ventana se acota');
  const state = base;
  const back = run({ ...state, scroll: 4 }, 'esc');
  assert.deepEqual([back.state.screen, back.state.scroll, back.cmds], ['search-results', 0, []]);
  assert.deepEqual(run({ ...state, prevScreen: 'sessions' }, 'q').cmds, [{ type: 'load-sessions' }]);
  const loaded = run(at(SCREEN.recent), { type: 'timeline', timeline: { focus: obs(1), before: [], after: [], session_info: null, total_in_range: 1 } }).state;
  assert.deepEqual([loaded.screen, loaded.scroll], ['timeline', 0]);
});

const sessions = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, project: 'demo', started_at: '2026-01-01 00:00:00', summary: null, observation_count: i }));

test('sesiones: lista, detalle y confirmación de borrado', () => {
  let state = run(at(SCREEN.dashboard), { type: 'size', width: 100, height: 20 }).state;
  state = run({ ...state, screen: 'sessions' }, { type: 'recent-sessions', sessions: sessions(30) }).state;
  state = run(state, ...Array(12).fill('j')).state;
  assert.deepEqual([state.cursor, state.scroll], [12, 1], 'altura 20 deja 12 filas visibles');
  state = run(state, 'k').state;
  assert.equal(state.cursor, 11);
  const detail = run(state, 'enter');
  assert.deepEqual([detail.state.selectedSessionIdx, detail.state.prevScreen, detail.cmds], [11, 'sessions', [{ type: 'load-session-observations', id: 's11' }]]);
  // borrado
  const asked = run(state, 'd');
  assert.deepEqual([asked.state.sessionDeleteState, asked.state.sessionDeleteId, asked.state.sessionDeleteProject], ['prompt', 's11', 'demo']);
  assert.deepEqual(run(asked.state, 'j', 'x').state, asked.state, 'durante la confirmación solo cuentan y/n/esc');
  for (const key of ['n', 'N', 'esc']) assert.equal(run(asked.state, key).state.sessionDeleteState, 'none', key);
  for (const key of ['y', 'Y']) {
    const confirmed = run(asked.state, key);
    assert.deepEqual([confirmed.state.sessionDeleteState, confirmed.cmds], ['deleting', [{ type: 'delete-session', id: 's11' }]], key);
  }
  assert.deepEqual(run({ ...asked.state, sessionDeleteId: '' }, 'y').state.sessionDeleteState, 'none');
  assert.deepEqual(run({ ...asked.state, sessionDeleteState: DELETE_STATE.deleting }, 'y', 'n', 'esc').cmds, [], 'borrando ignora las teclas');
  assert.equal(run(at(SCREEN.sessions), 'd', 'enter').state.sessionDeleteState, 'none', 'sin sesiones no hay nada');
  const out = run({ ...asked.state }, 'esc').state;
  const leaving = run(state, 'esc');
  assert.deepEqual([leaving.state.screen, leaving.cmds, out.screen], ['dashboard', [{ type: 'load-stats' }], 'sessions']);
});

test('sesiones: resultado del borrado y recarga acotando el cursor', () => {
  const base = at(SCREEN.sessions, { sessions: sessions(3), cursor: 2, scroll: 2, sessionDeleteState: 'deleting', sessionDeleteId: 's2', sessionDeleteProject: 'demo' });
  const ok = run(base, { type: 'session-deleted', sessionId: 's2', error: null });
  assert.deepEqual([ok.state.sessionDeleteState, ok.state.errorMsg, ok.cmds], ['none', '', [{ type: 'load-sessions' }]]);
  const reloaded = run(ok.state, { type: 'recent-sessions', sessions: sessions(2) }).state;
  assert.deepEqual([reloaded.cursor, reloaded.scroll], [1, 1]);
  assert.deepEqual([run(reloaded, { type: 'recent-sessions', sessions: [] }).state.cursor, run(reloaded, { type: 'recent-sessions', sessions: [] }).state.scroll], [0, 0]);
  const withObs = run(base, { type: 'session-deleted', sessionId: 's2', error: Object.assign(new Error('x'), { code: 'session_has_observations' }) });
  assert.equal(withObs.state.errorMsg, 'Cannot delete session "s2": it still has observations. Delete or move observations first.');
  assert.deepEqual(withObs.cmds, []);
  assert.equal(sessionDeleteErrorMessage('a', Object.assign(new Error('x'), { code: 'session_not_found' })), 'Cannot delete session "a": session not found.');
  assert.equal(sessionDeleteErrorMessage('a', new Error('boom')), 'Failed to delete session "a": boom');
});

test('detalle de sesión: lista, acciones y vuelta a la sesión elegida', () => {
  let state = at(SCREEN.sessions, { sessions: sessions(5), cursor: 3, selectedSessionIdx: 3 });
  state = run(state, { type: 'session-observations', observations: many(4) }).state;
  assert.deepEqual([state.screen, state.cursor, state.sessionDetailScroll], ['session-detail', 0, 0]);
  assert.deepEqual(run(state, 'j', 'enter').cmds, [{ type: 'load-detail', id: 2 }]);
  assert.equal(run(state, 'enter').state.prevScreen, 'session-detail');
  assert.deepEqual(run(state, 'c').cmds, [{ type: 'copy', content: 'contenido 1' }]);
  assert.deepEqual(run(state, 't').cmds, [{ type: 'load-timeline', id: 1 }]);
  const back = run(state, 'esc');
  assert.deepEqual([back.state.screen, back.state.cursor, back.cmds], ['sessions', 3, [{ type: 'load-sessions' }]]);
});

test('preparación: elegir, instalar, resultado y vuelta', () => {
  let state = run(at(SCREEN.dashboard, { cursor: 3 }), 'enter').state;
  state = run(state, 'j', 'j', 'k').state;
  assert.equal(state.cursor, 0);
  assert.equal(run(state, 'j', 'j', 'j').state.cursor, 1);
  const installing = run(state, 'enter');
  assert.deepEqual([installing.state.setupInstalling, installing.state.setupInstallingName, installing.cmds], [true, 'vscode-copilot', [{ type: 'install', agent: 'vscode-copilot' }]]);
  assert.deepEqual(run(installing.state, 'j', 'enter', 'esc', 'q').cmds, [], 'instalando se ignoran las teclas');
  assert.equal(run(installing.state, { type: 'spinner-tick' }).state.spinnerFrame, 1);
  assert.equal(run(state, { type: 'spinner-tick' }).state.spinnerFrame, 0, 'fuera de la instalación el giro no avanza');
  const done = run(installing.state, { type: 'setup-installed', result: { agent: 'vscode-copilot', changes: [] } }).state;
  assert.deepEqual([done.setupInstalling, done.setupDone, done.setupError], [false, true, '']);
  assert.deepEqual(run(done, 'j', 'x').state, done);
  for (const key of ['esc', 'q', 'enter']) {
    const back = run(done, key);
    assert.deepEqual([back.state.screen, back.state.setupDone, back.state.setupResult, back.cmds], ['dashboard', false, null, [{ type: 'load-stats' }]], key);
  }
  const failed = run(installing.state, { type: 'setup-installed', error: new Error('no se pudo') }).state;
  assert.deepEqual([failed.setupDone, failed.setupError], [true, 'no se pudo']);
  assert.deepEqual(run(state, 'esc').cmds, [{ type: 'load-stats' }]);
  assert.deepEqual(run(at(SCREEN.setup), 'enter').cmds, [], 'sin destinos no instala');
});

test('mensajes de error, de versión y de portapapeles', () => {
  const state = at(SCREEN.dashboard);
  for (const type of ['stats', 'search-results', 'recent-observations', 'observation-detail', 'timeline', 'recent-sessions', 'session-observations']) {
    const out = run(state, { type, error: new Error('falló') }).state;
    assert.equal(out.errorMsg, 'falló', type);
    assert.equal(out.screen, 'dashboard', `${type} no cambia de pantalla`);
  }
  assert.equal(run({ ...state, errorMsg: 'viejo' }, 'j').state.errorMsg, '', 'cualquier tecla limpia el error');
  assert.deepEqual(run(state, { type: 'stats', stats: { total_sessions: 1 } }).state.stats, { total_sessions: 1 });
  const upd = run(state, { type: 'update-check', result: { status: 'update_available', message: 'hay nueva' } }).state;
  assert.deepEqual([upd.updateStatus, upd.updateMsg], ['update_available', 'hay nueva']);
  assert.deepEqual(run(state, { type: 'update-check', result: { status: '' } }).state.updateMsg, '');
  const copied = run(state, { type: 'clipboard-copied', sequence: 'SEQ' });
  assert.equal(copied.state.copyFeedback, '✓ Copied!');
  assert.deepEqual(copied.cmds, [{ type: 'print', text: 'SEQ' }, { type: 'clear-feedback', ms: 2000 }]);
  assert.equal(run(copied.state, { type: 'clipboard-clear' }).state.copyFeedback, '');
  assert.equal(run(state, { type: 'desconocido' }).state, state);
});
