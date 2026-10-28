import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { HOOK_EVENTS, hooksConfig } from '../../../src/setup/hooks-config.js';
import { INSTRUCTIONS_FILE_NAME, SERVER_NAME, serverEntry, setupClient, staleMcpCommands, targets } from '../../../src/setup/install.js';
import { readJsonFile, stripJsonc, writeIfChanged } from '../../../src/setup/files.js';
import { copilotHome, findOnPath, odinInvocation, vscodeUserDir } from '../../../src/setup/paths.js';
import {
  MEMORY_PROTOCOL, PROTOCOL_BEGIN, PROTOCOL_END, instructionsFile, protocolBlock, removeProtocolBlock, upsertProtocolBlock,
} from '../../../src/setup/protocol.js';
import { tempDir } from '../store/helpers.js';

const fake = { command: '/opt/node', args: ['/opt/odin/bin/odin.js'] };
const ctx = (t, extra = {}) => {
  const home = tempDir(t);
  const cwd = join(home, 'proyecto');
  mkdirSync(cwd);
  return { env: {}, home: () => home, cwd, platform: 'darwin', invocation: fake, ...extra, _home: home };
};

test('el protocolo no menciona la herramienta de origen y trae los marcadores', () => {
  assert.ok(MEMORY_PROTOCOL.startsWith('## Odin Persistent Memory — Protocol'));
  assert.ok(MEMORY_PROTOCOL.includes('FIRST ACTION REQUIRED'));
  assert.ok(MEMORY_PROTOCOL.includes('odin setup vscode-copilot'));
  assert.equal(PROTOCOL_BEGIN, '<!-- BEGIN ODIN MEMORY PROTOCOL -->');
  assert.equal(PROTOCOL_END, '<!-- END ODIN MEMORY PROTOCOL -->');
  assert.ok(instructionsFile().startsWith("---\nname: 'Odin persistent memory'\ndescription: 'Protocol for using the Odin persistent memory tools.'\napplyTo: '**'\n---\n## Odin Persistent Memory"));
});

test('el bloque gestionado se inserta, se reemplaza y se quita sin tocar el resto', () => {
  assert.equal(upsertProtocolBlock(''), protocolBlock());
  const mine = '# Mis instrucciones\n\nUsa tabuladores.\n';
  const once = upsertProtocolBlock(mine);
  assert.ok(once.startsWith(`${mine}\n${PROTOCOL_BEGIN}\n`));
  assert.ok(once.endsWith(`${PROTOCOL_END}\n`));
  assert.equal(upsertProtocolBlock(once), once, 'idempotente');
  const stale = once.replace('Odin Persistent Memory', 'VIEJO');
  assert.equal(upsertProtocolBlock(stale), once, 'sustituye un bloque anterior');
  const withTail = `${once}\n# Después\n\nOtra cosa.\n`;
  const replaced = upsertProtocolBlock(withTail.replace('Odin Persistent Memory', 'VIEJO'));
  assert.ok(replaced.includes('## Odin Persistent Memory') && replaced.endsWith('# Después\n\nOtra cosa.\n'));
  assert.equal(removeProtocolBlock(once), mine);
  assert.equal(removeProtocolBlock(withTail), `${mine}\n# Después\n\nOtra cosa.\n`);
  assert.equal(removeProtocolBlock(protocolBlock()), '');
  assert.equal(removeProtocolBlock(mine), null);
  assert.equal(removeProtocolBlock(`${PROTOCOL_END}\n${PROTOCOL_BEGIN}\n`), null, 'marcas en orden inverso no son un bloque');
});

test('JSONC: comentarios y comas finales fuera, cadenas intactas', () => {
  const source = '{\n  // línea\n  "a": "http://x // no es comentario",\n  "c": "con \\" comilla // y barra",\n  /* bloque */ "b": [1, 2,],\n}\n';
  const { text, hadComments } = stripJsonc(source);
  assert.equal(hadComments, true);
  assert.deepEqual(JSON.parse(text), { a: 'http://x // no es comentario', c: 'con " comilla // y barra', b: [1, 2] });
  assert.equal(stripJsonc('{"a":1}').hadComments, false);
  assert.equal(stripJsonc('{"a":/* sin cerrar').hadComments, true);
});

test('readJsonFile: ausente, vacío, con comentarios, inválido y no objeto', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readJsonFile(join(dir, 'no.json')), { value: {}, existed: false, hadComments: false });
  writeFileSync(join(dir, 'vacio.json'), '  \n');
  assert.deepEqual(readJsonFile(join(dir, 'vacio.json')), { value: {}, existed: true, hadComments: false });
  writeFileSync(join(dir, 'c.json'), '{"a":1} // fin');
  assert.deepEqual(readJsonFile(join(dir, 'c.json')), { value: { a: 1 }, existed: true, hadComments: true });
  writeFileSync(join(dir, 'mal.json'), '{rota');
  assert.throws(() => readJsonFile(join(dir, 'mal.json')), /^Error: cannot parse .*mal\.json: /);
  writeFileSync(join(dir, 'arr.json'), '[1]');
  assert.throws(() => readJsonFile(join(dir, 'arr.json')), /must contain a JSON object$/);
});

test('writeIfChanged crea, actualiza, no toca lo igual y guarda copia si se pide', (t) => {
  const path = join(tempDir(t), 'a', 'b.txt');
  assert.equal(writeIfChanged(path, 'uno'), 'created');
  assert.equal(writeIfChanged(path, 'uno'), 'unchanged');
  assert.equal(writeIfChanged(path, 'dos', { backupSuffix: '.bak' }), 'updated');
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), 'uno');
  assert.equal(readFileSync(path, 'utf8'), 'dos');
});

test('rutas de VS Code y de Copilot según el sistema', () => {
  const home = () => '/h';
  assert.equal(copilotHome({}, home), '/h/.copilot');
  assert.equal(copilotHome({ COPILOT_HOME: '/c' }, home), '/c');
  assert.equal(copilotHome({ COPILOT_HOME: '  ' }, home), '/h/.copilot');
  assert.equal(vscodeUserDir({}, home, { platform: 'darwin' }), '/h/Library/Application Support/Code/User');
  assert.equal(vscodeUserDir({}, home, { platform: 'darwin', insiders: true }), '/h/Library/Application Support/Code - Insiders/User');
  assert.equal(vscodeUserDir({}, home, { platform: 'linux' }), '/h/.config/Code/User');
  assert.equal(vscodeUserDir({ XDG_CONFIG_HOME: '/x' }, home, { platform: 'linux' }), '/x/Code/User');
  assert.equal(vscodeUserDir({ APPDATA: '/a' }, home, { platform: 'win32' }), '/a/Code/User');
  assert.equal(vscodeUserDir({}, home, { platform: 'win32' }), '/h/AppData/Roaming/Code/User');
});

test('odin se invoca por el PATH si está y, si no, con la ruta absoluta de Node', (t) => {
  const dir = tempDir(t);
  assert.equal(findOnPath({ PATH: dir }), null);
  writeFileSync(join(dir, 'odin'), '#!/bin/sh\n');
  assert.equal(findOnPath({ PATH: ['/no', dir].join(delimiter) }), join(dir, 'odin'));
  assert.deepEqual(odinInvocation({ PATH: dir }), { command: 'odin', args: [] });
  const none = odinInvocation({ PATH: '/vacio' }, { execPath: '/n', binPath: '/b/odin.js' });
  assert.deepEqual(none, { command: '/n', args: ['/b/odin.js'] });
  assert.ok(isAbsolute(odinInvocation({ PATH: '' }).args[0]));
});

test('la configuración de hooks tiene un hook por evento con el plazo y las órdenes de cada sistema', () => {
  const config = hooksConfig({ command: 'odin', args: [] });
  assert.deepEqual(Object.keys(config), ['version', 'hooks']);
  assert.equal(config.version, 1);
  assert.deepEqual(Object.keys(config.hooks), ['sessionStart', 'userPromptSubmitted', 'preCompact', 'postToolUse', 'subagentStop', 'sessionEnd']);
  assert.deepEqual(config.hooks.sessionStart, [{ type: 'command', bash: 'odin hook copilot-session-start', powershell: 'odin hook copilot-session-start', command: 'odin hook copilot-session-start', timeoutSec: 15 }]);
  assert.equal(HOOK_EVENTS.length, 6);
  const absolute = hooksConfig({ command: '/ruta con espacios/node', args: ['/o dín/bin.js'] }).hooks.sessionEnd[0];
  assert.equal(absolute.bash, "'/ruta con espacios/node' '/o dín/bin.js' hook copilot-session-end");
  assert.equal(absolute.powershell, '& "/ruta con espacios/node" "/o dín/bin.js" "hook" "copilot-session-end"');
  assert.equal(absolute.command, absolute.bash);
  assert.equal(hooksConfig({ command: "/it's/node", args: [] }).hooks.sessionEnd[0].bash, "'/it'\\''s/node' hook copilot-session-end");
});

test('destinos y entrada del servidor de cada cliente', (t) => {
  const c = ctx(t);
  const vs = targets('vscode-copilot', c);
  assert.deepEqual(vs, {
    mcp: join(c._home, 'Library/Application Support/Code/User/mcp.json'),
    instructions: join(c._home, `Library/Application Support/Code/User/prompts/${INSTRUCTIONS_FILE_NAME}`),
    hooks: join(c._home, '.copilot/hooks/odin-memory.json'),
  });
  assert.deepEqual(targets('vscode-copilot', { ...c, workspace: true }), {
    mcp: join(c.cwd, '.vscode/mcp.json'), instructions: join(c.cwd, `.github/instructions/${INSTRUCTIONS_FILE_NAME}`), hooks: join(c.cwd, '.github/hooks/odin-memory.json'),
  });
  assert.deepEqual(targets('copilot-cli', c), { mcp: join(c._home, '.copilot/mcp-config.json'), instructions: join(c._home, '.copilot/copilot-instructions.md'), hooks: join(c._home, '.copilot/hooks/odin-memory.json') });
  assert.deepEqual(serverEntry('vscode-copilot', fake), { type: 'stdio', command: '/opt/node', args: ['/opt/odin/bin/odin.js', 'mcp', '--tools=agent'] });
  assert.deepEqual(serverEntry('copilot-cli', { command: 'odin', args: [] }), { type: 'local', command: 'odin', args: ['mcp', '--tools=agent'], env: {}, tools: ['*'] });
});

const actions = (changes) => Object.fromEntries(changes.map((x) => [x.item, x.action]));

test('instalar en VS Code crea los tres archivos, conserva lo ajeno y es idempotente', (t) => {
  const c = ctx(t);
  const paths = targets('vscode-copilot', c);
  mkdirSync(join(paths.mcp, '..'), { recursive: true });
  writeFileSync(paths.mcp, JSON.stringify({ servers: { otro: { type: 'stdio', command: 'x' } }, inputs: [1] }));
  assert.deepEqual(actions(setupClient('vscode-copilot', c)), { mcp: 'updated', instructions: 'created', hooks: 'created' });
  const mcp = JSON.parse(readFileSync(paths.mcp, 'utf8'));
  assert.deepEqual(Object.keys(mcp.servers), ['otro', SERVER_NAME]);
  assert.deepEqual(mcp.inputs, [1]);
  assert.equal(mcp.servers[SERVER_NAME].type, 'stdio');
  assert.ok(readFileSync(paths.instructions, 'utf8').includes("applyTo: '**'"));
  assert.equal(JSON.parse(readFileSync(paths.hooks, 'utf8')).hooks.sessionStart[0].bash, '/opt/node /opt/odin/bin/odin.js hook copilot-session-start');
  assert.deepEqual(actions(setupClient('vscode-copilot', c)), { mcp: 'unchanged', instructions: 'unchanged', hooks: 'unchanged' });
  // Si cambia cómo se invoca odin, se actualiza la entrada.
  assert.deepEqual(actions(setupClient('vscode-copilot', { ...c, invocation: { command: 'odin', args: [] } })), { mcp: 'updated', instructions: 'unchanged', hooks: 'updated' });
});

test('--no-hooks y --dry-run', (t) => {
  const c = ctx(t);
  const paths = targets('vscode-copilot', c);
  assert.deepEqual(actions(setupClient('vscode-copilot', { ...c, dryRun: true })), { mcp: 'created', instructions: 'created', hooks: 'created' });
  assert.equal(existsSync(paths.mcp) || existsSync(paths.hooks), false, 'el simulacro no escribe');
  assert.deepEqual(Object.keys(actions(setupClient('vscode-copilot', { ...c, hooks: false }))), ['mcp', 'instructions']);
  assert.equal(existsSync(paths.hooks), false);
});

test('un mcp.json con comentarios se reescribe guardando una copia', (t) => {
  const c = ctx(t);
  const paths = targets('vscode-copilot', c);
  mkdirSync(join(paths.mcp, '..'), { recursive: true });
  const original = '{\n  // mis servidores\n  "servers": {},\n}\n';
  writeFileSync(paths.mcp, original);
  setupClient('vscode-copilot', c);
  assert.equal(readFileSync(`${paths.mcp}.odin-backup`, 'utf8'), original);
  assert.ok(JSON.parse(readFileSync(paths.mcp, 'utf8')).servers[SERVER_NAME]);
  writeFileSync(paths.mcp, '{rota');
  assert.throws(() => setupClient('vscode-copilot', c), /cannot parse/);
});

test('instalar en el CLI de Copilot usa mcpServers y un bloque dentro de las instrucciones del usuario', (t) => {
  const c = ctx(t);
  const paths = targets('copilot-cli', c);
  mkdirSync(join(paths.mcp, '..'), { recursive: true });
  writeFileSync(paths.instructions, '# Mías\n\nSé breve.\n');
  writeFileSync(paths.mcp, JSON.stringify({ mcpServers: { otro: { type: 'local', command: 'y', tools: ['*'] } }, extra: true }));
  assert.deepEqual(actions(setupClient('copilot-cli', c)), { mcp: 'updated', instructions: 'updated', hooks: 'created' });
  const mcp = JSON.parse(readFileSync(paths.mcp, 'utf8'));
  assert.deepEqual([Object.keys(mcp.mcpServers), mcp.extra, mcp.mcpServers[SERVER_NAME].type, mcp.mcpServers[SERVER_NAME].tools], [['otro', SERVER_NAME], true, 'local', ['*']]);
  assert.ok(readFileSync(paths.instructions, 'utf8').startsWith('# Mías\n\nSé breve.\n\n<!-- BEGIN ODIN MEMORY PROTOCOL -->'));
  assert.deepEqual(actions(setupClient('copilot-cli', c)), { mcp: 'unchanged', instructions: 'unchanged', hooks: 'unchanged' });
});

test('COPILOT_HOME cambia dónde escribe el CLI', (t) => {
  const c = ctx(t);
  const custom = join(c._home, 'otro-copilot');
  setupClient('copilot-cli', { ...c, env: { COPILOT_HOME: custom } });
  assert.ok(existsSync(join(custom, 'mcp-config.json')) && existsSync(join(custom, 'hooks', 'odin-memory.json')) && existsSync(join(custom, 'copilot-instructions.md')));
});

test('quitar deshace lo instalado y respeta lo ajeno', (t) => {
  const c = ctx(t);
  const cliPaths = targets('copilot-cli', c);
  mkdirSync(join(cliPaths.mcp, '..'), { recursive: true });
  writeFileSync(cliPaths.instructions, '# Mías\n');
  writeFileSync(cliPaths.mcp, JSON.stringify({ mcpServers: { otro: { type: 'local', command: 'y' } } }));
  setupClient('copilot-cli', c);
  assert.deepEqual(actions(setupClient('copilot-cli', { ...c, remove: true })), { mcp: 'removed', instructions: 'removed', hooks: 'removed' });
  assert.deepEqual(JSON.parse(readFileSync(cliPaths.mcp, 'utf8')), { mcpServers: { otro: { type: 'local', command: 'y' } } });
  assert.equal(readFileSync(cliPaths.instructions, 'utf8'), '# Mías\n');
  assert.equal(existsSync(cliPaths.hooks), false);
  assert.deepEqual(actions(setupClient('copilot-cli', { ...c, remove: true })), { mcp: 'absent', instructions: 'absent', hooks: 'absent' });
  // El archivo de instrucciones propio de VS Code se borra entero.
  const vs = targets('vscode-copilot', c);
  setupClient('vscode-copilot', c);
  assert.deepEqual(actions(setupClient('vscode-copilot', { ...c, remove: true, dryRun: true })), { mcp: 'removed', instructions: 'removed', hooks: 'removed' });
  assert.ok(existsSync(vs.instructions), 'el simulacro no borra');
  setupClient('vscode-copilot', { ...c, remove: true });
  assert.equal(existsSync(vs.instructions), false);
  // Un archivo de instrucciones que solo tenía el bloque desaparece.
  setupClient('copilot-cli', { ...c, hooks: false });
  rmSyncIfExists(cliPaths.instructions);
  setupClient('copilot-cli', { ...c, hooks: false });
  setupClient('copilot-cli', { ...c, remove: true, hooks: false });
  assert.equal(existsSync(cliPaths.instructions), false);
});

function rmSyncIfExists(path) {
  writeFileSync(path, protocolBlock());
}

test('los registros con un ejecutable inexistente se detectan', (t) => {
  const c = ctx(t);
  const exists = (path) => existsSync(path) && !path.endsWith('desaparecido');
  setupClient('vscode-copilot', { ...c, invocation: { command: '/opt/desaparecido', args: [] } });
  setupClient('copilot-cli', { ...c, invocation: { command: 'odin', args: [] } });
  const found = staleMcpCommands({ env: {}, home: c.home, platform: 'darwin', exists: (p) => (p === '/opt/desaparecido' ? false : existsSync(p)), isAbsolutePath: isAbsolute });
  assert.deepEqual(found.map((x) => [x.slug, x.command]), [['vscode-copilot', '/opt/desaparecido']]);
  assert.deepEqual(staleMcpCommands({ env: {}, home: c.home, platform: 'darwin', exists, isAbsolutePath: isAbsolute }).length, 1);
  const clean = ctx(t);
  assert.deepEqual(staleMcpCommands({ env: {}, home: clean.home, platform: 'darwin', exists: existsSync, isAbsolutePath: isAbsolute }), []);
});
