// Utilidades para las pruebas de conformidad: compila engram, lo arranca como
// servidor MCP en un directorio de datos temporal y permite llamar a sus herramientas.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Devuelve la ruta del binario: ENGRAM_BIN, o lo compila desde ENGRAM_SRC. */
export function resolveBinary() {
  if (process.env.ENGRAM_BIN) return { bin: process.env.ENGRAM_BIN, cleanup() {} };
  if (!process.env.ENGRAM_SRC) return null;
  const work = mkdtempSync(join(tmpdir(), 'conformance-bin-'));
  const bin = join(work, 'engram');
  execFileSync('go', ['build', '-o', bin, './cmd/engram'], { cwd: process.env.ENGRAM_SRC, stdio: 'pipe' });
  return { bin, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

/**
 * Arranca un servidor MCP por stdio (cualquier comando) y expone call(name, args).
 * `dataDir` se elimina al cerrar.
 */
export function startMcpCommand(command, args, { cwd, env = {}, dataDir } = {}) {
  const ownedDataDir = dataDir ?? mkdtempSync(join(tmpdir(), 'conformance-data-'));
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buf = '';
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout en ${method}`)), 30000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  let initialized;
  const initialize = () => {
    initialized ??= rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conformance', version: '0' } }).then((msg) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return msg;
    });
    return initialized;
  };
  initialize();
  return {
    dataDir: ownedDataDir,
    rpc,
    initialize,
    async listTools() {
      await initialize();
      return (await rpc('tools/list', {})).result.tools;
    },
    async call(name, toolArgs) {
      await initialize();
      const msg = await rpc('tools/call', { name, arguments: toolArgs });
      if (msg.error) return { isError: true, text: msg.error.message, json: null, rpcError: msg.error };
      const text = (msg.result.content ?? []).map((c) => c.text ?? '').join('\n');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // la respuesta no es JSON
      }
      return { isError: Boolean(msg.result.isError), text, json };
    },
    close() {
      child.stdin.end();
      child.kill();
      if (!dataDir) rmSync(ownedDataDir, { recursive: true, force: true });
    },
  };
}

/** Arranca `engram mcp` en un directorio de datos temporal. */
export function startMcp(bin, { cwd } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'conformance-data-'));
  const handle = startMcpCommand(bin, ['mcp', '--tools=all'], {
    cwd, dataDir, env: { ENGRAM_DATA_DIR: dataDir, ENGRAM_NO_UPDATE_CHECK: '1' },
  });
  const close = handle.close;
  handle.close = () => {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return handle;
}
