import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { render, useApp, useInput, useStdout } from 'ink';
import { executeCommand, setupAgents } from './commands.js';
import { keyName } from './keys.js';
import { initialCommands, initialState, update } from './model.js';
import { View } from './view.js';

const html = htm.bind(createElement);

const SPINNER_INTERVAL_MS = 80;

/**
 * Componente raíz: guarda el estado de `model.js`, traduce las teclas a mensajes y ejecuta los comandos.
 * @param {{ context: object, stdout: NodeJS.WriteStream }} props
 */
export function App({ context, stdout }) {
  const { exit } = useApp();
  const { stdout: inkStdout } = useStdout();
  const out = stdout ?? inkStdout;
  const [state, setState] = useState(() => initialState({ version: context.version }));
  const ref = useRef(state);
  const timers = useRef(new Set());

  const dispatch = useCallback((msg) => {
    const { state: next, cmds } = update(ref.current, msg, { agents: () => setupAgents(context) });
    ref.current = next;
    setState(next);
    for (const cmd of cmds) run(cmd);
  }, []);

  const run = useCallback((cmd) => {
    switch (cmd.type) {
      case 'quit': exit(); return;
      case 'print': out.write(cmd.text); return;
      case 'clear-feedback': {
        const timer = setTimeout(() => {
          timers.current.delete(timer);
          dispatch({ type: 'clipboard-clear' });
        }, cmd.ms);
        timers.current.add(timer);
        return;
      }
      default:
        Promise.resolve(executeCommand(cmd, context)).then((msg) => msg && dispatch(msg));
    }
  }, []);

  useEffect(() => {
    const size = () => dispatch({ type: 'size', width: out.columns ?? 0, height: out.rows ?? 0 });
    size();
    out.on?.('resize', size);
    for (const cmd of initialCommands()) run(cmd);
    return () => {
      out.off?.('resize', size);
      for (const timer of timers.current) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!state.setupInstalling) return undefined;
    const timer = setInterval(() => dispatch({ type: 'spinner-tick' }), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state.setupInstalling]);

  useInput((input, key) => dispatch({ type: 'key', key: keyName(input, key), input }));

  return html`<${View} state=${state} />`;
}

/**
 * Abre la TUI en la pantalla alternativa y espera a que el usuario salga.
 * @param {{ store: object, version: string, env?: NodeJS.ProcessEnv, home: () => string, cwd: () => string, stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream, altScreen?: boolean, checkLatest?: Function }} context
 */
export async function runTui(context) {
  const stdout = context.stdout ?? process.stdout;
  const stdin = context.stdin ?? process.stdin;
  const altScreen = context.altScreen ?? true;
  if (altScreen) stdout.write('\x1b[?1049h');
  try {
    const instance = render(html`<${App} context=${{ env: process.env, ...context }} stdout=${stdout} />`, {
      stdout, stdin, exitOnCtrlC: false, patchConsole: false,
    });
    await instance.waitUntilExit();
  } finally {
    if (altScreen) stdout.write('\x1b[?1049l');
  }
}
