import { existsSync, readFileSync, rmSync, rmdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HOOKS_FILE_NAME, hooksConfig } from './hooks-config.js';
import { jsonText, readJsonFile, writeFileAtomic, writeIfChanged } from './files.js';
import { copilotHome, odinInvocation, vscodeUserDir } from './paths.js';
import { instructionsFile, removeProtocolBlock, upsertProtocolBlock } from './protocol.js';

/** Nombre con el que odin se registra como servidor MCP. */
export const SERVER_NAME = 'odin-memory';
export const INSTRUCTIONS_FILE_NAME = 'odin-memory.instructions.md';
export const SLUGS = Object.freeze(['vscode-copilot', 'copilot-cli']);

/** @typedef {{ item: string, path: string, action: 'created'|'updated'|'unchanged'|'removed'|'absent' }} SetupChange */

const mcpArgs = (invocation) => [...invocation.args, 'mcp', '--tools=agent'];

/** Ubicaciones de cada pieza según el destino. */
export function targets(slug, { env, home, cwd, workspace = false, insiders = false, platform }) {
  const hooksUser = join(copilotHome(env, home), 'hooks', HOOKS_FILE_NAME);
  if (slug === 'copilot-cli') {
    return {
      mcp: join(copilotHome(env, home), 'mcp-config.json'),
      instructions: join(copilotHome(env, home), 'copilot-instructions.md'),
      hooks: hooksUser,
    };
  }
  if (workspace) {
    return {
      mcp: join(cwd, '.vscode', 'mcp.json'),
      instructions: join(cwd, '.github', 'instructions', INSTRUCTIONS_FILE_NAME),
      hooks: join(cwd, '.github', 'hooks', HOOKS_FILE_NAME),
    };
  }
  const user = vscodeUserDir(env, home, { platform, insiders });
  return { mcp: join(user, 'mcp.json'), instructions: join(user, 'prompts', INSTRUCTIONS_FILE_NAME), hooks: hooksUser };
}

/** Entrada del servidor MCP en el formato de cada destino. */
export function serverEntry(slug, invocation) {
  if (slug === 'copilot-cli') return { type: 'local', command: invocation.command, args: mcpArgs(invocation), env: {}, tools: ['*'] };
  return { type: 'stdio', command: invocation.command, args: mcpArgs(invocation) };
}

const topKey = (slug) => (slug === 'copilot-cli' ? 'mcpServers' : 'servers');

function registerServer(slug, path, invocation, { dryRun }) {
  const { value, existed, hadComments } = readJsonFile(path);
  const key = topKey(slug);
  const servers = value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]) ? value[key] : {};
  const entry = serverEntry(slug, invocation);
  const before = JSON.stringify(servers[SERVER_NAME]);
  const next = { ...value, [key]: { ...servers, [SERVER_NAME]: entry } };
  if (before === JSON.stringify(entry)) return { item: 'mcp', path, action: 'unchanged' };
  const action = existed ? 'updated' : 'created';
  if (!dryRun) writeIfChanged(path, jsonText(next), { backupSuffix: hadComments ? '.odin-backup' : null });
  return { item: 'mcp', path, action };
}

function unregisterServer(slug, path, { dryRun }) {
  if (!existsSync(path)) return { item: 'mcp', path, action: 'absent' };
  const { value, hadComments } = readJsonFile(path);
  const key = topKey(slug);
  if (!value[key] || !Object.hasOwn(value[key], SERVER_NAME)) return { item: 'mcp', path, action: 'absent' };
  const { [SERVER_NAME]: _removed, ...rest } = value[key];
  if (!dryRun) writeIfChanged(path, jsonText({ ...value, [key]: rest }), { backupSuffix: hadComments ? '.odin-backup' : null });
  return { item: 'mcp', path, action: 'removed' };
}

function installInstructions(slug, path, { dryRun }) {
  if (slug === 'vscode-copilot') {
    const content = instructionsFile();
    const action = existsSync(path) ? (readFileSync(path, 'utf8') === content ? 'unchanged' : 'updated') : 'created';
    if (!dryRun && action !== 'unchanged') writeIfChanged(path, content);
    return { item: 'instructions', path, action };
  }
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const next = upsertProtocolBlock(current);
  const action = !existsSync(path) ? 'created' : next === current ? 'unchanged' : 'updated';
  if (!dryRun && action !== 'unchanged') writeIfChanged(path, next);
  return { item: 'instructions', path, action };
}

function removeInstructions(slug, path, { dryRun }) {
  if (!existsSync(path)) return { item: 'instructions', path, action: 'absent' };
  if (slug === 'vscode-copilot') {
    if (!dryRun) rmSync(path, { force: true });
    return { item: 'instructions', path, action: 'removed' };
  }
  const current = readFileSync(path, 'utf8');
  const next = removeProtocolBlock(current);
  if (next === null) return { item: 'instructions', path, action: 'absent' };
  if (!dryRun) {
    if (next === '') rmSync(path, { force: true });
    else writeFileAtomic(path, next);
  }
  return { item: 'instructions', path, action: 'removed' };
}

function installHooks(path, invocation, { dryRun }) {
  const content = jsonText(hooksConfig(invocation));
  const action = existsSync(path) ? (readFileSync(path, 'utf8') === content ? 'unchanged' : 'updated') : 'created';
  if (!dryRun && action !== 'unchanged') writeIfChanged(path, content);
  return { item: 'hooks', path, action };
}

function removeHooks(path, { dryRun }) {
  if (!existsSync(path)) return { item: 'hooks', path, action: 'absent' };
  if (!dryRun) {
    rmSync(path, { force: true });
    try {
      if (readdirSync(dirname(path)).length === 0) rmdirSync(dirname(path));
    } catch {
      // la carpeta puede tener otros hooks
    }
  }
  return { item: 'hooks', path, action: 'removed' };
}

/**
 * Instala o quita (`remove`) la integración de odin en un cliente de Copilot.
 * @param {'vscode-copilot'|'copilot-cli'} slug
 * @param {{ env: NodeJS.ProcessEnv, home: () => string, cwd: string, workspace?: boolean, insiders?: boolean, hooks?: boolean, remove?: boolean, dryRun?: boolean, platform?: string, invocation?: { command: string, args: string[] } }} options
 * @returns {SetupChange[]}
 */
export function setupClient(slug, options) {
  const paths = targets(slug, options);
  const invocation = options.invocation ?? odinInvocation(options.env);
  const flags = { dryRun: options.dryRun === true };
  const withHooks = options.hooks !== false;
  const changes = [];
  if (options.remove) {
    changes.push(unregisterServer(slug, paths.mcp, flags), removeInstructions(slug, paths.instructions, flags));
    if (withHooks) changes.push(removeHooks(paths.hooks, flags));
    return changes;
  }
  changes.push(registerServer(slug, paths.mcp, invocation, flags), installInstructions(slug, paths.instructions, flags));
  if (withHooks) changes.push(installHooks(paths.hooks, invocation, flags));
  return changes;
}

/**
 * Registros de odin cuyo ejecutable (ruta absoluta) ya no existe.
 * @returns {{ slug: string, config: string, command: string }[]}
 */
export function staleMcpCommands({ env, home, platform, exists = existsSync, isAbsolutePath }) {
  const found = [];
  const candidates = [
    ['vscode-copilot', join(vscodeUserDir(env, home, { platform }), 'mcp.json'), 'servers'],
    ['vscode-copilot', join(vscodeUserDir(env, home, { platform, insiders: true }), 'mcp.json'), 'servers'],
    ['copilot-cli', join(copilotHome(env, home), 'mcp-config.json'), 'mcpServers'],
  ];
  for (const [slug, path, key] of candidates) {
    if (!exists(path)) continue;
    const { value } = readJsonFile(path);
    const command = value[key]?.[SERVER_NAME]?.command;
    if (typeof command === 'string' && isAbsolutePath(command) && !exists(command)) found.push({ slug, config: path, command });
  }
  return found;
}
