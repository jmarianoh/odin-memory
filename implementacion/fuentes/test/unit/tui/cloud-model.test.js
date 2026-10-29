import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_CONFIG_ACTIONS, CLOUD_CONFIG_FOCUS, CLOUD_SETTINGS_MENU, SCREEN, initialState, update,
} from '../../../src/tui/model.js';
import { inputValue, setValue } from '../../../src/tui/text-input.js';

/** Aplica mensajes en cadena y devuelve el estado final con todos los comandos emitidos. */
function run(state, ...msgs) {
  const cmds = [];
  let current = state;
  for (const msg of msgs) {
    const out = update(current, typeof msg === 'string' ? { type: 'key', key: msg, input: msg.length === 1 ? msg : '' } : msg, {});
    current = out.state;
    cmds.push(...out.cmds);
  }
  return { state: current, cmds };
}
const at = (screen, extra = {}) => ({ ...initialState({ version: '1' }), screen, height: 40, width: 100, ...extra });
const typed = (text) => [...text].map((ch) => ({ type: 'key', key: ch, input: ch }));
const withUrl = (url, extra = {}) => at(SCREEN.cloudConfig, { cloudConfigInput: setValue(initialState().cloudConfigInput, url), ...extra });
const err = (message) => new Error(message);

test('constantes del menú y del formulario', () => {
  assert.deepEqual(CLOUD_SETTINGS_MENU, ['Configure server', 'View status', 'Enroll projects', 'Back']);
  assert.deepEqual(CLOUD_CONFIG_ACTIONS, ['Test connection', 'Save server', 'Cancel']);
  assert.deepEqual(CLOUD_CONFIG_FOCUS, { input: 0, test: 1, save: 2, cancel: 3 });
});

test('menú de la nube: navegar, elegir y volver al panel', () => {
  const s = at(SCREEN.cloudSettings);
  assert.equal(run(s, 'k').state.cursor, 0);
  assert.equal(run(s, 'j', 'j', 'j', 'j', 'down').state.cursor, 3, 'no pasa del último');
  assert.equal(run(s, 'down', 'up').state.cursor, 0);
  const config = run(s, 'enter');
  assert.deepEqual([config.state.screen, config.state.cloudGeneration, config.state.cloudConfigFocus, config.cmds], ['cloud-config', 1, 0, [{ type: 'load-cloud-config', generation: 1 }]]);
  const status = run(at(SCREEN.cloudSettings, { cursor: 1, cloudGeneration: 4 }), ' ');
  assert.deepEqual([status.state.screen, status.state.cloudStatusLoading, status.state.cloudGeneration, status.cmds], ['cloud-status', true, 5, [{ type: 'load-cloud-status', generation: 5 }]]);
  const stale = run(at(SCREEN.cloudSettings, { cursor: 1, cloudStatusLastError: 'x', cloudStatusHealthError: 'y' }), 'enter').state;
  assert.deepEqual([stale.cloudStatusLastError, stale.cloudStatusHealthError], ['', '']);
  const enroll = run(at(SCREEN.cloudSettings, { cursor: 2, cloudEnrollmentError: 'x' }), 'enter');
  assert.deepEqual([enroll.state.screen, enroll.state.cursor, enroll.state.cloudEnrollmentLoading, enroll.state.cloudEnrollmentError, enroll.cmds], ['cloud-enrollment', 0, true, '', [{ type: 'load-cloud-enrollment' }]]);
  for (const key of ['esc', 'q']) assert.deepEqual([run(s, key).state.screen, run(s, key).cmds], ['dashboard', [{ type: 'load-stats' }]]);
  const back = run(at(SCREEN.cloudSettings, { cursor: 3 }), 'enter');
  assert.deepEqual([back.state.screen, back.state.cursor, back.cmds], ['dashboard', 0, [{ type: 'load-stats' }]]);
  assert.deepEqual(run(s, 'x').state, s);
});

test('abrir la configuración limpia los avisos anteriores', () => {
  const dirty = at(SCREEN.cloudSettings, { cloudConfigError: 'e', cloudConfigPingStatus: 'reachable', cloudConfigFocus: 3, cloudConfigSaving: true });
  const { state } = run(dirty, 'enter');
  assert.deepEqual([state.cloudConfigError, state.cloudConfigPingStatus, state.cloudConfigFocus, state.cloudConfigSaving], ['', '', 0, false]);
});

test('la URL cargada rellena el campo y lo enfoca; las respuestas viejas se ignoran', () => {
  const opened = run(at(SCREEN.cloudSettings), 'enter').state;
  const loaded = run(opened, { type: 'cloud-config-loaded', generation: 1, serverUrl: 'http://a', tokenSource: 'read from cloud.json' }).state;
  assert.deepEqual([inputValue(loaded.cloudConfigInput), loaded.cloudConfigInput.focused, loaded.cloudConfigTokenSource], ['http://a', true, 'read from cloud.json']);
  assert.deepEqual(run(opened, { type: 'cloud-config-loaded', generation: 0, serverUrl: 'http://a', tokenSource: 'x' }).state, opened, 'generación vieja');
  assert.deepEqual(run(at(SCREEN.dashboard, { cloudGeneration: 1 }), { type: 'cloud-config-loaded', generation: 1, serverUrl: 'http://a', tokenSource: 'x' }).state.screen, 'dashboard');
  assert.equal(inputValue(run(at(SCREEN.dashboard, { cloudGeneration: 1 }), { type: 'cloud-config-loaded', generation: 1, serverUrl: 'http://a', tokenSource: 'x' }).state.cloudConfigInput), '');
  assert.equal(run(opened, { type: 'cloud-config-loaded', generation: 1, error: err('mal cloud.json') }).state.cloudConfigError, 'mal cloud.json');
});

test('con el campo enfocado se escribe; tab, shift+tab, enter y esc se reservan', () => {
  const focused = run(withUrl('http://a'), 'i').state;
  assert.equal(focused.cloudConfigInput.focused, true);
  const edited = run(focused, ...typed('bc'), { type: 'key', key: 'backspace', input: '' }, ...typed('q'));
  assert.equal(inputValue(edited.state.cloudConfigInput), 'http://abq', 'q y j se escriben');
  assert.deepEqual(edited.cmds, []);
  const tab = run(edited.state, 'tab').state;
  assert.deepEqual([tab.cloudConfigInput.focused, tab.cloudConfigFocus], [false, 1]);
  const enter = run(edited.state, 'enter').state;
  assert.deepEqual([enter.cloudConfigInput.focused, enter.cloudConfigFocus], [false, CLOUD_CONFIG_FOCUS.test]);
  const shift = run(edited.state, 'shift+tab').state;
  assert.deepEqual([shift.cloudConfigInput.focused, shift.cloudConfigFocus], [false, CLOUD_CONFIG_FOCUS.cancel]);
  const wrapped = run({ ...edited.state, cloudConfigFocus: 1 }, 'shift+tab').state;
  assert.deepEqual([wrapped.cloudConfigInput.focused, wrapped.cloudConfigFocus], [true, CLOUD_CONFIG_FOCUS.input], 'volver al campo lo enfoca');
  const esc = run(edited.state, 'esc').state;
  assert.deepEqual([esc.screen, esc.cursor, esc.cloudConfigInput.focused], ['cloud-settings', 0, false]);
  assert.equal(inputValue(esc.cloudConfigInput), 'http://abq', 'esc no descarta lo escrito');
});

test('sin el campo enfocado: foco con tab/flechas/jk, i para editar y salir con esc o q', () => {
  const s = withUrl('http://a');
  const order = [];
  let state = s;
  for (let i = 0; i < 5; i++) {
    state = run(state, 'tab').state;
    order.push(state.cloudConfigFocus);
  }
  assert.deepEqual(order, [1, 2, 3, 0, 1], 'tab da la vuelta');
  assert.deepEqual([run(s, 'down').state.cloudConfigFocus, run(s, 'j').state.cloudConfigFocus, run(s, 'up').state.cloudConfigFocus, run(s, 'k').state.cloudConfigFocus, run(s, 'shift+tab').state.cloudConfigFocus], [1, 1, 3, 3, 3]);
  const edit = run({ ...s, cloudConfigFocus: 2 }, 'i').state;
  assert.deepEqual([edit.cloudConfigFocus, edit.cloudConfigInput.focused], [0, true]);
  assert.equal(run(s, 'enter').state.cloudConfigInput.focused, true, 'enter sobre el campo lo enfoca');
  assert.equal(run(s, ' ').state.cloudConfigInput.focused, true);
  for (const key of ['esc', 'q']) assert.deepEqual([run(s, key).state.screen, run(s, key).state.cursor], ['cloud-settings', 0]);
  const cancel = run({ ...s, cloudConfigFocus: CLOUD_CONFIG_FOCUS.cancel }, 'enter');
  assert.deepEqual([cancel.state.screen, cancel.state.cursor, cancel.cmds], ['cloud-settings', 0, []]);
  assert.deepEqual(run(s, 'x').state, s);
});

test('probar la conexión valida la URL y lanza una sola comprobación', () => {
  const s = withUrl('  http://a:1  ', { cloudConfigFocus: CLOUD_CONFIG_FOCUS.test, cloudGeneration: 6, cloudConfigError: 'viejo' });
  const test = run(s, 'enter');
  assert.deepEqual(test.cmds, [{ type: 'ping-cloud', origin: 'config', generation: 7, serverUrl: 'http://a:1' }]);
  assert.deepEqual([test.state.cloudConfigSaving, test.state.cloudConfigTest, test.state.cloudConfigPingStatus, test.state.cloudConfigError, test.state.cloudGeneration], [true, true, 'checking', '', 7]);
  assert.deepEqual(run(test.state, 'enter', 'esc', 'tab', 'i', 'q').state, test.state, 'mientras comprueba no responde a las teclas');
  const save = run({ ...s, cloudConfigFocus: CLOUD_CONFIG_FOCUS.save }, ' ');
  assert.deepEqual([save.state.cloudConfigTest, save.cmds.length], [false, 1]);
  const empty = run(withUrl('', { cloudConfigFocus: CLOUD_CONFIG_FOCUS.test }), 'enter');
  assert.deepEqual([empty.state.cloudConfigError, empty.state.cloudConfigSaving, empty.cmds], ['server URL is required', false, []]);
  assert.equal(run(withUrl('ftp://x', { cloudConfigFocus: 2 }), 'enter').state.cloudConfigError, 'scheme must be http or https');
});

function pinged(over = {}) {
  const base = run(withUrl('http://a', { cloudConfigFocus: CLOUD_CONFIG_FOCUS.save }), 'enter').state;
  return { base, msg: { type: 'cloud-ping', origin: 'config', generation: base.cloudGeneration, serverUrl: 'http://a', status: 'reachable', error: null, ...over } };
}

test('probar: el resultado se muestra y no se guarda nada', () => {
  const base = run(withUrl('http://a', { cloudConfigFocus: CLOUD_CONFIG_FOCUS.test }), 'enter').state;
  const msg = { type: 'cloud-ping', origin: 'config', generation: base.cloudGeneration, serverUrl: 'http://a', status: 'reachable', error: null };
  const ok = run(base, msg);
  assert.deepEqual([ok.state.cloudConfigSaving, ok.state.cloudConfigPingStatus, ok.state.cloudConfigError, ok.cmds], [false, 'reachable', '', []]);
  const failed = run(base, { ...msg, status: 'unreachable', error: err('unexpected status 500') });
  assert.deepEqual([failed.state.cloudConfigPingStatus, failed.state.cloudConfigError, failed.cmds], ['unreachable', 'unexpected status 500', []]);
});

test('guardar: solo si el servidor responde (también con 401) y se conserva el foco en «Save»', () => {
  for (const status of ['reachable', 'unauthorized']) {
    const { base, msg } = pinged({ status });
    const out = run(base, msg);
    assert.deepEqual(out.cmds, [{ type: 'save-cloud-url', serverUrl: 'http://a' }], status);
    assert.equal(out.state.cloudConfigSaving, false);
  }
  const { base, msg } = pinged({ status: 'unreachable' });
  const down = run(base, msg);
  assert.deepEqual([down.cmds, down.state.cloudConfigError, down.state.cloudConfigPingStatus], [[], 'server is unreachable', 'unreachable']);
  const withError = run(base, { ...msg, status: 'unreachable', error: err('boom') });
  assert.deepEqual([withError.cmds, withError.state.cloudConfigError], [[], 'boom']);
  const saved = run({ ...base, cloudConfigFocus: 1, cloudConfigInput: { ...base.cloudConfigInput, focused: true } }, { type: 'cloud-url-saved' }).state;
  assert.deepEqual([saved.cloudConfigFocus, saved.cloudConfigInput.focused, saved.cloudConfigError], [CLOUD_CONFIG_FOCUS.save, false, '']);
  assert.equal(run(base, { type: 'cloud-url-saved', error: err('disco lleno') }).state.cloudConfigError, 'disco lleno');
  assert.equal(run(at(SCREEN.dashboard), { type: 'cloud-url-saved', error: err('x') }).state.cloudConfigError, '', 'fuera del formulario se ignora');
});

test('una respuesta de ping vieja, de otra pantalla o de otra URL se descarta', () => {
  const { base, msg } = pinged();
  assert.deepEqual(run(base, { ...msg, generation: msg.generation - 1 }).state, base);
  assert.deepEqual(run(base, { ...msg, serverUrl: 'http://otra' }).state, base);
  assert.deepEqual(run({ ...base, screen: SCREEN.dashboard }, msg).state.cloudConfigPingStatus, 'checking');
  const spaced = run({ ...base, cloudConfigInput: setValue(base.cloudConfigInput, ' http://a ') }, msg);
  assert.equal(spaced.cmds.length, 1, 'la URL se compara sin espacios sobrantes');
});

test('estado: carga, ping de salud, actualizar y volver', () => {
  const opened = run(at(SCREEN.cloudSettings, { cursor: 1 }), 'enter').state;
  const loaded = run(opened, { type: 'cloud-status-loaded', generation: 1, serverUrl: 'http://a', lastSync: '2026-01-02 03:04:05', pendingCount: 3, lastError: 'fallo' });
  assert.deepEqual(loaded.cmds, [{ type: 'ping-cloud', origin: 'status', generation: 1, serverUrl: 'http://a' }]);
  assert.deepEqual(
    [loaded.state.cloudStatusLoading, loaded.state.cloudStatusServerUrl, loaded.state.cloudStatusLastSync, loaded.state.cloudStatusPending, loaded.state.cloudStatusLastError, loaded.state.cloudStatusHealthError],
    [false, 'http://a', '2026-01-02 03:04:05', 3, 'fallo', ''],
  );
  const noUrl = run(opened, { type: 'cloud-status-loaded', generation: 1, serverUrl: '', lastSync: '', pendingCount: 0, lastError: '' });
  assert.deepEqual([noUrl.cmds, noUrl.state.cloudStatusLoading], [[], false], 'sin URL no hay ping');
  assert.equal(run(opened, { type: 'cloud-status-loaded', generation: 0, serverUrl: 'http://a', lastSync: '', pendingCount: 0, lastError: '' }).cmds.length, 0, 'generación vieja');
  assert.equal(run({ ...opened, screen: SCREEN.dashboard }, { type: 'cloud-status-loaded', generation: 1, serverUrl: 'http://a', lastSync: '', pendingCount: 0, lastError: '' }).state.cloudStatusServerUrl, '');
  const failed = run({ ...opened, cloudStatusHealthError: 'x' }, { type: 'cloud-status-loaded', generation: 1, error: err('no se pudo leer') }).state;
  assert.deepEqual([failed.cloudStatusLoading, failed.cloudStatusLastError, failed.cloudStatusHealthError], [false, 'no se pudo leer', '']);

  const health = run(loaded.state, { type: 'cloud-ping', origin: 'status', generation: 1, serverUrl: 'http://a', status: 'unreachable', error: err('unexpected status 502') }).state;
  assert.deepEqual([health.cloudStatusHealth, health.cloudStatusHealthError], ['unreachable', 'unexpected status 502']);
  const healed = run(health, { type: 'cloud-ping', origin: 'status', generation: 1, serverUrl: 'http://a', status: 'reachable', error: null }).state;
  assert.deepEqual([healed.cloudStatusHealth, healed.cloudStatusHealthError], ['reachable', '']);
  assert.deepEqual(run(loaded.state, { type: 'cloud-ping', origin: 'status', generation: 1, serverUrl: 'http://otra', status: 'reachable', error: null }).state, loaded.state);
  assert.deepEqual(run(loaded.state, { type: 'cloud-ping', origin: 'status', generation: 0, serverUrl: 'http://a', status: 'reachable', error: null }).state, loaded.state);
  assert.deepEqual(run({ ...loaded.state, screen: SCREEN.cloudSettings }, { type: 'cloud-ping', origin: 'status', generation: 1, serverUrl: 'http://a', status: 'reachable', error: null }).state.cloudStatusHealth, '');

  const refresh = run(health, 'r');
  assert.deepEqual([refresh.state.cloudGeneration, refresh.state.cloudStatusLoading, refresh.state.cloudStatusHealthError, refresh.cmds], [2, true, '', [{ type: 'load-cloud-status', generation: 2 }]]);
  for (const key of ['esc', 'q']) assert.deepEqual([run(loaded.state, key).state.screen, run(loaded.state, key).state.cursor], ['cloud-settings', 1]);
  assert.deepEqual(run(loaded.state, 'x').state, loaded.state);
});

test('inscripción: lista, cursor acotado, alternar, recargar y volver', () => {
  const items = [{ project: 'a', enrolled: true }, { project: 'b', enrolled: false }, { project: 'c', enrolled: false }];
  const opened = at(SCREEN.cloudEnrollment, { cloudEnrollmentLoading: true });
  const loaded = run(opened, { type: 'cloud-enrollment-loaded', items }).state;
  assert.deepEqual([loaded.cloudEnrollmentItems, loaded.cloudEnrollmentLoading, loaded.cloudEnrollmentError], [items, false, '']);
  assert.equal(run(loaded, 'j', 'j', 'j', 'down').state.cursor, 2);
  assert.equal(run(loaded, 'k', 'up').state.cursor, 0);
  const toggle = run(loaded, 'j', 'enter');
  assert.deepEqual([toggle.cmds, toggle.state.cloudEnrollmentLoading], [[{ type: 'toggle-cloud-enrollment', item: items[1] }], true]);
  assert.deepEqual(run(toggle.state, 'enter').cmds, [], 'no alterna mientras carga');
  assert.equal(run(loaded, ' ').cmds[0].item.project, 'a');
  assert.deepEqual(run(at(SCREEN.cloudEnrollment), 'enter').cmds, [], 'sin proyectos no hay nada que alternar');
  assert.deepEqual(run(loaded, 'r').cmds, [{ type: 'load-cloud-enrollment' }]);
  assert.equal(run(loaded, 'r').state.cloudEnrollmentLoading, true);
  assert.deepEqual(run(toggle.state, { type: 'cloud-enrollment-toggled' }).cmds, [{ type: 'load-cloud-enrollment' }]);
  assert.equal(run(toggle.state, { type: 'cloud-enrollment-toggled' }).state.cloudEnrollmentLoading, true);
  const failed = run(toggle.state, { type: 'cloud-enrollment-toggled', error: err('no se pudo') });
  assert.deepEqual([failed.state.cloudEnrollmentLoading, failed.state.cloudEnrollmentError, failed.cmds], [false, 'no se pudo', []]);
  const loadFailed = run(opened, { type: 'cloud-enrollment-loaded', error: err('sin base') }).state;
  assert.deepEqual([loadFailed.cloudEnrollmentLoading, loadFailed.cloudEnrollmentError], [false, 'sin base']);
  for (const key of ['esc', 'q']) assert.deepEqual([run(loaded, key).state.screen, run(loaded, key).state.cursor], ['cloud-settings', 2]);
  assert.deepEqual(run(loaded, 'x').state, loaded);
});

test('inscripción: tras recargar el cursor no queda fuera de la lista', () => {
  const items = [{ project: 'a', enrolled: false }];
  const shrunk = run(at(SCREEN.cloudEnrollment, { cursor: 5 }), { type: 'cloud-enrollment-loaded', items }).state;
  assert.equal(shrunk.cursor, 0);
  const empty = run(at(SCREEN.cloudEnrollment, { cursor: 2 }), { type: 'cloud-enrollment-loaded', items: [] }).state;
  assert.equal(empty.cursor, 0);
  const kept = run(at(SCREEN.cloudEnrollment, { cursor: 1 }), { type: 'cloud-enrollment-loaded', items: [...items, ...items, ...items] }).state;
  assert.equal(kept.cursor, 1);
  assert.equal(run(at(SCREEN.dashboard, { cursor: 4 }), { type: 'cloud-enrollment-loaded', items }).state.cursor, 4, 'fuera de la pantalla no toca el cursor');
});

test('un error de la nube limpia al pulsar cualquier tecla, como en el resto de pantallas', () => {
  assert.equal(run(at(SCREEN.cloudSettings, { errorMsg: 'x' }), 'j').state.errorMsg, '');
});
