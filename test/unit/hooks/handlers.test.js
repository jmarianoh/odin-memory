import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPACTION_INSTRUCTION, HANDLERS, SESSION_START_HEADER, hasCompactionMarker, postToolUse, preCompact, sessionEnd, sessionStart, subagentStop, userPromptSubmitted,
} from '../../../src/hooks/handlers.js';
import { parseHookInput } from '../../../src/hooks/input.js';
import { addObservation, createSession, endSession, getSession, pinObservation } from '../../../src/store/index.js';
import { Syncer } from '../../../src/sync/index.js';
import { openTempStore, tempDir as dataTemp } from '../store/helpers.js';
import { initRepo, tempDir } from '../project/helpers.js';

function world(t) {
  const root = tempDir(t);
  const repo = initRepo(join(root, 'mi-repo'));
  const store = openTempStore(t);
  const dataDir = dataTemp(t);
  // Dos repositorios hijos: el proyecto es ambiguo y los hooks no adivinan.
  const ambiguous = join(root, 'varios');
  initRepo(join(ambiguous, 'a'));
  initRepo(join(ambiguous, 'b'));
  const input = (fields, style = 'camel') => parseHookInput(JSON.stringify(style === 'camel'
    ? { sessionId: 's1', cwd: repo, ...fields }
    : { session_id: 's1', hook_event_name: 'X', cwd: repo, ...fields }));
  return { root, repo, ambiguous, store, dataDir, env: process.env, input };
}
const call = (handler, w, fields, style) => handler({ store: w.store, input: w.input(fields, style), env: w.env, dataDir: w.dataDir });
const prompts = (store) => store.db.all('SELECT session_id, content, project FROM user_prompts ORDER BY id').map((r) => ({ ...r }));

test('los nombres de acción coinciden con los eventos que instala setup', () => {
  assert.deepEqual(Object.keys(HANDLERS), [
    'copilot-session-start', 'copilot-user-prompt-submit', 'copilot-pre-compact', 'copilot-post-tool-use', 'copilot-subagent-stop', 'copilot-session-end',
  ]);
});

test('sessionStart registra la sesión del proyecto y entrega el contexto', async (t) => {
  const w = world(t);
  createSession(w.store, 'previa', 'mi-repo', w.repo);
  const id = addObservation(w.store, { session_id: 'previa', type: 'decision', title: 'Usar Redis', content: 'decisión previa', project: 'mi-repo' }).id;
  pinObservation(w.store, id);
  const out = await call(sessionStart, w, {});
  assert.deepEqual(Object.keys(out), ['additionalContext']);
  assert.ok(out.additionalContext.startsWith(`${SESSION_START_HEADER}\n\n## Memory from Previous Sessions`), out.additionalContext);
  assert.ok(out.additionalContext.includes('Usar Redis'));
  const session = getSession(w.store, 's1');
  assert.deepEqual([session.project, session.ownership_mode, session.ended_at], ['mi-repo', 'project_owned', null]);
  assert.equal((await call(sessionStart, w, {})).additionalContext.length > 0, true, 'repetir es idempotente');
});

test('sessionStart en el formato de VS Code anida la salida', async (t) => {
  const w = world(t);
  const out = await call(sessionStart, w, {}, 'pascal');
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith(SESSION_START_HEADER));
});

test('sessionStart sin proyecto verificable solo entrega la cabecera y no registra nada', async (t) => {
  const w = world(t);
  const out = await call(sessionStart, w, { cwd: w.ambiguous });
  assert.deepEqual(out, { additionalContext: SESSION_START_HEADER });
  assert.equal(getSession(w.store, 's1'), null);
  assert.deepEqual((await call(sessionStart, w, { sessionId: '' })).additionalContext.startsWith(SESSION_START_HEADER), true, 'sin sesión no se registra pero sí se entrega contexto');
});

test('sessionStart reanuda una sesión terminada sin cambiar su modo compartido', async (t) => {
  const w = world(t);
  createSession(w.store, 's1', 'mi-repo', w.repo, 'shared');
  endSession(w.store, 's1', '');
  await call(sessionStart, w, {});
  const rows = w.store.db.all('SELECT id, ownership_mode, ended_at IS NULL AS live FROM sessions ORDER BY id').map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ id: 's1', ownership_mode: 'shared', live: 0 }, { id: 's1:resume:2', ownership_mode: 'shared', live: 1 }], 'la continuación hereda el modo compartido');
  // Cerrar la sesión reanudada cierra su continuación viva por el ámbito de ejecución.
  await call(sessionEnd, w, {});
  assert.equal(w.store.db.get('SELECT count(*) AS n FROM sessions WHERE ended_at IS NULL').n, 0);
});

test('una sesión raíz nueva se registra como propia del proyecto y su continuación también', async (t) => {
  const w = world(t);
  createSession(w.store, 's1', 'mi-repo', w.repo, 'project_owned');
  endSession(w.store, 's1', '');
  await call(sessionStart, w, {});
  const rows = w.store.db.all('SELECT id, ownership_mode FROM sessions ORDER BY id').map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ id: 's1', ownership_mode: 'project_owned' }, { id: 's1:resume:2', ownership_mode: 'project_owned' }]);
});

test('sessionStart importa lo compartido por Git si hay manifiesto y tolera que falle', async (t) => {
  const w = world(t);
  mkdirSync(join(w.repo, '.odin-memory'), { recursive: true });
  writeFileSync(join(w.repo, '.odin-memory', 'manifest.json'), 'roto');
  await assert.doesNotReject(async () => call(sessionStart, w, {}));
  writeFileSync(join(w.repo, '.odin-memory', 'manifest.json'), '{"version":1,"chunks":null}');
  await assert.doesNotReject(async () => call(sessionStart, w, {}));
});

test('la importación automática trae lo compartido y se puede apagar', async (t) => {
  const origin = openTempStore(t);
  // Las sesiones que registran los hooks son del proyecto: su manifiesto es de la versión 2.
  createSession(origin, 'ajena', 'mi-repo', '/otro', 'project_owned');
  addObservation(origin, { session_id: 'ajena', type: 'decision', title: 'Compartida', content: 'viene de Git', project: 'mi-repo' });
  const w = world(t);
  await Syncer.local(origin, join(w.repo, '.odin-memory'), 'mi-repo').export('ana', 'mi-repo');
  const off = { ...w, env: { ...process.env, ODIN_HOOK_AUTO_IMPORT: '0' } };
  await call(sessionStart, off, {});
  assert.equal(w.store.db.get("SELECT count(*) AS n FROM observations WHERE title = 'Compartida'").n, 0, 'apagada no importa');
  const out = await call(sessionStart, w, {});
  assert.equal(w.store.db.get("SELECT count(*) AS n FROM observations WHERE title = 'Compartida'").n, 1);
  assert.ok(out.additionalContext.includes('Compartida'), 'y el contexto ya la incluye');
});

test('userPromptSubmitted guarda el prompt original con el proyecto del directorio', async (t) => {
  const w = world(t);
  assert.equal(await call(userPromptSubmitted, w, { prompt: '  Vamos a usar Redis  ' }), null);
  assert.deepEqual(prompts(w.store), [{ session_id: 's1', content: 'Vamos a usar Redis', project: 'mi-repo' }], 'la sesión se registra si faltaba');
  assert.equal(getSession(w.store, 's1').project, 'mi-repo');
  await call(userPromptSubmitted, w, { prompt: 'otro' });
  assert.equal(prompts(w.store).length, 2);
});

test('userPromptSubmitted solo inspecciona: no escribe el vínculo del repositorio', async (t) => {
  const w = world(t);
  await call(userPromptSubmitted, w, { prompt: 'hola' });
  assert.equal(prompts(w.store).length, 1);
  assert.equal(existsSync(join(w.repo, '.git', 'odin-memory-project-identity.json')), false);
  await call(sessionStart, w, {});
  assert.equal(existsSync(join(w.repo, '.git', 'odin-memory-project-identity.json')), true, 'el arranque de sesión sí fija el vínculo');
});

test('userPromptSubmitted ignora prompts vacíos, sin sesión o sin proyecto', async (t) => {
  const w = world(t);
  await call(userPromptSubmitted, w, { prompt: '   ' });
  await call(userPromptSubmitted, w, { prompt: 'x', sessionId: '' });
  await call(userPromptSubmitted, w, { prompt: 'x', cwd: w.ambiguous });
  await call(userPromptSubmitted, w, { prompt: 'x', cwd: '' });
  assert.deepEqual(prompts(w.store), []);
});

test('userPromptSubmitted no revienta si el almacén rechaza el prompt', async (t) => {
  const w = world(t);
  createSession(w.store, 's1', 'otro-proyecto', w.repo);
  await assert.doesNotReject(async () => call(userPromptSubmitted, w, { prompt: 'x' }));
});

test('preCompact deja una marca que postToolUse entrega una sola vez', async (t) => {
  const w = world(t);
  await call(sessionStart, w, {});
  await call(userPromptSubmitted, w, { prompt: 'trabajando en Redis' });
  assert.equal(hasCompactionMarker(w.dataDir, 's1'), false);
  assert.equal(await call(postToolUse, w, {}), null, 'sin marca no hay nada que entregar');
  assert.equal(await call(preCompact, w, { trigger: 'auto' }), null);
  assert.equal(hasCompactionMarker(w.dataDir, 's1'), true);
  assert.equal(hasCompactionMarker(w.dataDir, 'otra'), false);
  const out = await call(postToolUse, w, {});
  assert.deepEqual(Object.keys(out), ['additionalContext']);
  assert.ok(out.additionalContext.startsWith(COMPACTION_INSTRUCTION));
  assert.ok(out.additionalContext.includes('FIRST ACTION REQUIRED'));
  assert.ok(out.additionalContext.includes('trabajando en Redis'), 'incluye lo que sabe de la sesión');
  assert.equal(hasCompactionMarker(w.dataDir, 's1'), false);
  assert.equal(await call(postToolUse, w, {}), null, 'la entrega ocurre una sola vez');
});

test('postToolUse en formato de VS Code y con la sesión desconocida', async (t) => {
  const w = world(t);
  await call(preCompact, w, {});
  const out = await call(postToolUse, w, {}, 'pascal');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith(COMPACTION_INSTRUCTION));
});

test('una marca antigua caduca y preCompact sin sesión no escribe', async (t) => {
  const w = world(t);
  await call(preCompact, w, {});
  const dir = join(w.dataDir, 'hook-state');
  const [name] = readdirSync(dir);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(join(dir, name), old, old);
  assert.equal(hasCompactionMarker(w.dataDir, 's1'), false);
  rmSync(dir, { recursive: true });
  await call(preCompact, w, { sessionId: '' });
  assert.equal(existsSync(dir), false);
  assert.equal(await call(postToolUse, w, {}), null);
});

test('subagentStop pasa la respuesta por la captura pasiva', async (t) => {
  const w = world(t);
  await call(sessionStart, w, {});
  assert.equal(await call(subagentStop, w, { response: 'resumen\n\n## Key Learnings:\n1. Redis sirve para la caché distribuida\n2. El pool debe ser pequeño\n' }), null);
  const rows = w.store.db.all("SELECT type, title, tool_name, project FROM observations WHERE type = 'passive' ORDER BY id");
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].tool_name, rows[0].project], ['subagent-stop', 'mi-repo']);
  await call(subagentStop, w, { response: '   ' });
  await call(subagentStop, w, { response: 'x', sessionId: '' });
  assert.equal(w.store.db.get("SELECT count(*) AS n FROM observations WHERE type = 'passive'").n, 2);
});

test('sessionEnd cierra la sesión viva y no falla con una desconocida', async (t) => {
  const w = world(t);
  await call(sessionStart, w, {});
  assert.equal(await call(sessionEnd, w, {}), null);
  assert.notEqual(getSession(w.store, 's1').ended_at, null);
  await assert.doesNotReject(async () => call(sessionEnd, w, {}), 'cerrar otra vez es inofensivo');
  assert.equal(await call(sessionEnd, w, { sessionId: 'nunca' }), null);
  assert.equal(await call(sessionEnd, w, { sessionId: '' }), null);
});
