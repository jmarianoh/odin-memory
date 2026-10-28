#!/usr/bin/env node
// Extrae de un checkout de engram las "fuentes de verdad" que el port debe seguir
// y las escribe de forma determinista en un directorio de instantáneas.
//
// Uso: node upstream/scripts/snapshot-contracts.mjs --engram <dir> [--out <dir>] [--skip-binary]
//   --engram        checkout (o árbol exportado) de engram
//   --out           destino; por defecto upstream/contracts
//   --skip-binary   no compila engram: omite sqlite-schema.json y mcp-tools.json
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const defaultOut = join(here, '..', 'contracts');

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

/** Texto del protocolo de memoria: constante Go de cadena cruda. */
export function extractProtocol(engramDir) {
  const src = read(engramDir, 'internal/setup/setup.go');
  const m = src.match(/const memoryProtocolMarkdown = `([\s\S]*?)`\n/);
  if (!m) throw new Error('no se encontró memoryProtocolMarkdown en internal/setup/setup.go');
  return `${m[1]}\n`;
}

/** Cuerpo de printUsage() de la CLI. */
export function extractUsage(engramDir) {
  const src = read(engramDir, 'cmd/engram/main.go');
  const start = src.indexOf('func printUsage() {');
  if (start < 0) throw new Error('no se encontró printUsage en cmd/engram/main.go');
  const end = src.indexOf('\n}\n', start);
  return `${src.slice(start, end + 3)}`;
}

/** Rutas HTTP: registros directos del mux y la tabla runtimeRoutes. */
export function extractRoutes(engramDir) {
  const dir = join(engramDir, 'internal/server');
  const routes = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.go') || name.endsWith('_test.go')) continue;
    const src = readFileSync(join(dir, name), 'utf8');
    for (const line of src.split('\n')) {
      let m = line.match(/HandleFunc\("([A-Z]+ [^"]+)"(.*)/);
      if (m) {
        routes.set(m[1], { pattern: m[1], auth: /requireAuth\(/.test(m[2]), source: name });
        continue;
      }
      m = line.match(/^\s*\{"[a-z0-9-]+",\s*"([A-Z]+ \/[^"]*)",\s*[^,]+,\s*(true|false)\}/);
      if (m) routes.set(m[1], { pattern: m[1], auth: m[2] === 'true', source: name });
    }
  }
  return [...routes.values()].sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** Compila engram en un directorio temporal y ejecuta fn({ bin, dataDir }). */
export async function withBuiltEngram(engramDir, fn) {
  const work = mkdtempSync(join(tmpdir(), 'snapshot-'));
  try {
    const bin = join(work, 'bin');
    execFileSync('go', ['build', '-o', bin, './cmd/engram'], { cwd: engramDir, stdio: 'pipe' });
    const dataDir = join(work, 'data');
    mkdirSync(dataDir);
    return await fn({ bin, dataDir, env: { ...process.env, ENGRAM_DATA_DIR: dataDir, ENGRAM_NO_UPDATE_CHECK: '1' } });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Vuelca sqlite_master de una base recién creada por el binario. */
export function dumpSchema({ bin, dataDir, env }) {
  execFileSync(bin, ['stats'], { env, stdio: 'pipe' });
  const dbFile = readdirSync(dataDir).find((f) => f.endsWith('.db'));
  if (!dbFile) throw new Error('el binario no creó ninguna base de datos');
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const userVersion = db.prepare('PRAGMA user_version').get().user_version;
    process.stdout.write(JSON.stringify({ user_version: userVersion, objects }));
  `;
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', script, join(dataDir, dbFile)], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** Ejecuta `mcp` por stdio y devuelve el resultado de initialize y de tools/list. */
export function dumpMcp({ bin, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['mcp', '--tools=all'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let buf = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timeout esperando al servidor MCP'));
    }, 20000);
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
    child.on('error', reject);
    const call = (id, method, params) => new Promise((res) => {
      pending.set(id, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    (async () => {
      const init = await call(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'snapshot', version: '0' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const list = await call(2, 'tools/list', {});
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      const tools = [...list.result.tools].sort((a, b) => a.name.localeCompare(b.name));
      resolve({ initialize: init.result, tools });
    })().catch(reject);
  });
}

/** Escribe todas las instantáneas en outDir. */
export async function snapshot({ engramDir, outDir = defaultOut, skipBinary = false }) {
  mkdirSync(outDir, { recursive: true });
  const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
  copyFileSync(join(engramDir, 'internal/mcp/testdata/tool-contract-v1.json'), join(outDir, 'tool-contract.json'));
  copyFileSync(join(engramDir, 'docs/contracts/agent-contract-v1.json'), join(outDir, 'agent-contract.json'));
  writeFileSync(join(outDir, 'protocol.md'), extractProtocol(engramDir));
  writeFileSync(join(outDir, 'cli-usage.txt'), extractUsage(engramDir));
  writeFileSync(join(outDir, 'http-routes.json'), json(extractRoutes(engramDir)));
  if (skipBinary) return;
  await withBuiltEngram(engramDir, async (ctx) => {
    writeFileSync(join(outDir, 'sqlite-schema.json'), json(dumpSchema(ctx)));
    writeFileSync(join(outDir, 'mcp-tools.json'), json(await dumpMcp(ctx)));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const engramDir = opt('--engram');
  if (!engramDir) {
    console.error('uso: snapshot-contracts.mjs --engram <dir> [--out <dir>] [--skip-binary]');
    process.exit(2);
  }
  await snapshot({ engramDir, outDir: opt('--out') ?? defaultOut, skipBinary: args.includes('--skip-binary') });
  console.log(`instantáneas escritas en ${opt('--out') ?? defaultOut}`);
}
