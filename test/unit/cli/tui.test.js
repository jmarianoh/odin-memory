import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../../../src/version/index.js';
import { cliWorld } from './helpers.js';

test('sin un terminal interactivo, odin tui lo explica y sale con 1', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['tui']);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'odin: the tui needs an interactive terminal\n');
});

test('odin tui abre el almacén, entrega el contexto y lo cierra al salir', async (t) => {
  const w = cliWorld(t);
  let received;
  const r = await w.odin(['tui'], {
    overrides: {
      runTui: async (context) => {
        received = context;
        assert.equal(typeof context.store.db.get('SELECT 1 AS x').x, 'number', 'el almacén está abierto');
      },
    },
  });
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
  assert.equal(received.version, VERSION);
  assert.deepEqual(Object.keys(received).sort(), ['cwd', 'env', 'home', 'store', 'version']);
  assert.throws(() => received.store.db.get('SELECT 1'), 'el almacén se cerró');
});

test('un fallo de la TUI se informa y el almacén también se cierra', async (t) => {
  const w = cliWorld(t);
  let store;
  const r = await w.odin(['tui'], { overrides: { runTui: async (context) => { store = context.store; throw new Error('se rompió'); } } });
  assert.equal(r.code, 1);
  assert.equal(r.err, 'odin: se rompió\n');
  assert.throws(() => store.db.get('SELECT 1'));
});

test('un almacén que no se puede abrir se informa', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['tui'], { overrides: { runTui: async () => {}, openStore: () => { throw new Error('no abre'); } } });
  assert.deepEqual([r.code, r.err], [1, 'odin: no abre\n']);
});
