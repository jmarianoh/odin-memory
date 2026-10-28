import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliWorld } from './helpers.js';

const userDir = (w) => join(w.root, process.platform === 'darwin' ? 'Library/Application Support/Code/User' : '.config/Code/User');

test('sin argumentos o con un destino desconocido muestra el uso y sale con 1', async (t) => {
  const w = cliWorld(t);
  const none = await w.odin(['setup']);
  assert.equal(none.code, 1);
  assert.ok(none.out.startsWith('usage: odin setup <vscode-copilot|copilot-cli> [--workspace] [--insiders] [--no-hooks] [--remove] [--dry-run]\n'));
  const bad = await w.odin(['setup', 'otro']);
  assert.equal(bad.code, 1);
  assert.equal(bad.err, 'unknown setup target "otro"\n\n');
  const help = await w.odin(['setup', '--help']);
  assert.deepEqual([help.code, help.err], [0, '']);
  const arg = await w.odin(['setup', 'vscode-copilot', '--nada']);
  assert.equal(arg.code, 1);
  assert.equal(arg.err, 'unknown setup argument "--nada"\n\n');
  const cli = await w.odin(['setup', 'copilot-cli', '--workspace']);
  assert.equal(cli.code, 1);
  assert.equal(cli.err, '--workspace and --insiders only apply to vscode-copilot\n');
});

test('setup vscode-copilot instala, informa y recomienda recargar', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['setup', 'vscode-copilot']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'Setting up odin for VS Code Copilot:');
  assert.match(lines[1], /^  MCP server   created   .*mcp\.json$/);
  assert.match(lines[2], /^  Instructions created   .*odin-memory\.instructions\.md$/);
  assert.match(lines[3], /^  Hooks        created   .*odin-memory\.json$/);
  assert.equal(lines[4], 'Reload VS Code (Developer: Reload Window) to pick up the changes.');
  assert.ok(existsSync(join(userDir(w), 'mcp.json')));
  const again = await w.odin(['setup', 'vscode-copilot']);
  assert.ok(!again.out.includes('Reload'), 'sin cambios no hay nada que recargar');
  assert.ok(again.out.includes('unchanged'));
});

test('--workspace escribe en la carpeta actual y --dry-run no escribe', async (t) => {
  const w = cliWorld(t);
  const dry = await w.odin(['setup', 'vscode-copilot', '--workspace', '--dry-run']);
  assert.ok(dry.out.startsWith('Setting up odin for VS Code Copilot (dry run, nothing is written):'));
  assert.equal(existsSync(join(w.repoDir, '.vscode')), false);
  await w.odin(['setup', 'vscode-copilot', '--workspace', '--no-hooks']);
  assert.ok(JSON.parse(readFileSync(join(w.repoDir, '.vscode', 'mcp.json'), 'utf8')).servers['odin-memory']);
  assert.ok(existsSync(join(w.repoDir, '.github', 'instructions', 'odin-memory.instructions.md')));
  assert.equal(existsSync(join(w.repoDir, '.github', 'hooks')), false);
});

test('setup copilot-cli y --remove', async (t) => {
  const w = cliWorld(t);
  const r = await w.odin(['setup', 'copilot-cli']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith('Setting up odin for the Copilot CLI:'));
  assert.ok(r.out.trimEnd().endsWith('Restart the Copilot CLI to pick up the changes.'));
  assert.ok(JSON.parse(readFileSync(join(w.root, '.copilot', 'mcp-config.json'), 'utf8')).mcpServers['odin-memory']);
  const removed = await w.odin(['setup', 'copilot-cli', '--remove']);
  assert.ok(removed.out.startsWith('Removing odin for the Copilot CLI:'));
  assert.match(removed.out, /MCP server   removed/);
  assert.equal(existsSync(join(w.root, '.copilot', 'copilot-instructions.md')), false);
});

test('un archivo ilegible detiene setup con un mensaje claro', async (t) => {
  const w = cliWorld(t);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(w.root, '.copilot'), { recursive: true });
  writeFileSync(join(w.root, '.copilot', 'mcp-config.json'), '{rota');
  const r = await w.odin(['setup', 'copilot-cli']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^odin setup copilot-cli failed: cannot parse .*mcp-config\.json: /);
});

test('doctor avisa de un registro cuyo ejecutable ya no existe', async (t) => {
  const w = cliWorld(t);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(w.root, '.copilot'), { recursive: true });
  writeFileSync(join(w.root, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { 'odin-memory': { type: 'local', command: join(w.root, 'se-borro', 'node'), args: [] } } }));
  const r = await w.odin(['doctor', '--json']);
  const report = JSON.parse(r.out);
  assert.equal(report.status, 'warning');
  const stale = report.checks.at(-1);
  assert.deepEqual([stale.check_id, stale.findings[0].evidence.slug, stale.findings[0].safe_next_step], ['stale_mcp_command', 'copilot-cli', 'odin setup copilot-cli']);
});
