import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import htm from 'htm';
import { App } from '../../../src/tui/app.js';

const html = htm.bind(createElement);

/** Quita secuencias de control de los fotogramas de Ink. */
export const plain = (text) => text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001B\][^\u0007]*\u0007/g, '');

/**
 * Monta la TUI real sobre flujos simulados. `frame()` devuelve el último fotograma completo y `press`
 * escribe teclas en la entrada.
 * @param {object} context
 * @param {{ columns?: number, rows?: number }} [size]
 */
export function mountTui(context, { columns = 100, rows = 40 } = {}) {
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = true;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const frames = [];
  const raw = [];
  stdout.on('data', (chunk) => {
    raw.push(chunk.toString());
    frames.push(chunk.toString());
  });
  const instance = render(createElement(App, { context: { env: {}, ...context }, stdout }), {
    stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    stdout,
    raw: () => raw.join(''),
    frame: () => plain(frames.at(-1) ?? ''),
    async press(...keys) {
      for (const key of keys) {
        stdin.write(key);
        await settle();
      }
    },
    settle,
    exited: instance.waitUntilExit(),
    unmount: () => instance.unmount(),
    resize(cols, rws) {
      stdout.columns = cols;
      stdout.rows = rws;
      stdout.emit('resize');
    },
    html,
  };
}

export const KEYS = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r', esc: '\x1b', backspace: '\x7f', ctrlC: '\x03' };
