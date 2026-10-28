import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cliWorld } from './helpers.js';

const payload = (w, extra = {}) => JSON.stringify({ sessionId: 's1', cwd: w.repoDir, ...extra });
const hook = (w, name, input, overrides = {}) => w.odin(['hook', name], { overrides: { readInput: () => input, ...overrides } });

test('un nombre desconocido o argumentos de más muestran el uso y salen con 1', async (t) => {
  const w = cliWorld(t);
  for (const args of [['hook'], ['hook', 'nada'], ['hook', 'copilot-session-start', 'extra'], ['hook', 'constructor']]) {
    const r = await w.odin(args, { overrides: { readInput: () => '' } });
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.err, 'usage: odin hook copilot-session-start|copilot-user-prompt-submit|copilot-pre-compact|copilot-post-tool-use|copilot-subagent-stop|copilot-session-end|resolve-hook-project\n');
  }
});

test('sessionStart imprime un único objeto JSON con el contexto', async (t) => {
  const w = cliWorld(t);
  const r = await hook(w, 'copilot-session-start', payload(w));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim().split('\n').length, 1);
  assert.match(JSON.parse(r.out).additionalContext, /^## Odin persistent memory — session context/);
  const store = w.store();
  assert.equal(store.db.get("SELECT project FROM sessions WHERE id = 's1'").project, 'mi-repo');
});

test('el ciclo de una sesión: prompt, compactación y cierre', async (t) => {
  const w = cliWorld(t);
  await hook(w, 'copilot-session-start', payload(w));
  const prompt = await hook(w, 'copilot-user-prompt-submit', payload(w, { prompt: 'vamos a usar Redis' }));
  assert.deepEqual([prompt.code, prompt.out, prompt.err], [0, '', '']);
  assert.equal((await hook(w, 'copilot-post-tool-use', payload(w))).out, '', 'sin compactación no hay salida');
  assert.equal((await hook(w, 'copilot-pre-compact', payload(w, { trigger: 'auto' }))).out, '');
  const recovered = await hook(w, 'copilot-post-tool-use', payload(w));
  assert.match(JSON.parse(recovered.out).additionalContext, /^CRITICAL INSTRUCTION POST-COMPACTION/);
  assert.equal((await hook(w, 'copilot-post-tool-use', payload(w))).out, '');
  await hook(w, 'copilot-session-end', payload(w, { reason: 'complete' }));
  const store = w.store();
  assert.notEqual(store.db.get("SELECT ended_at FROM sessions WHERE id = 's1'").ended_at, null);
  assert.equal(store.db.get('SELECT content FROM user_prompts').content, 'vamos a usar Redis');
});

test('los hooks nunca fallan: carga ilegible, almacén inaccesible o error interno', async (t) => {
  const w = cliWorld(t);
  for (const name of ['copilot-session-start', 'copilot-user-prompt-submit', 'copilot-pre-compact', 'copilot-post-tool-use', 'copilot-subagent-stop', 'copilot-session-end']) {
    for (const input of ['', 'basura', 'null', '[]']) {
      const r = await hook(w, name, input);
      assert.deepEqual([r.code, r.out, r.err], [0, '', ''], `${name} con ${JSON.stringify(input)}`);
    }
    const broken = await hook(w, name, payload(w, { prompt: 'x' }), { openStore: () => { throw new Error('no se puede abrir'); } });
    assert.deepEqual([broken.code, broken.out, broken.err], [0, '', ''], `${name} sin almacén`);
  }
});

test('un directorio de datos inválido tampoco bloquea al agente', async (t) => {
  const w = cliWorld(t, { env: { ODIN_DATA_DIR: join('/dev/null', 'x') } });
  const r = await w.odin(['hook', 'copilot-session-start'], { overrides: { readInput: () => payload(w), openStore: undefined } });
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
});

test('resolve-hook-project responde con el proyecto verificable y no abre el almacén', async (t) => {
  const w = cliWorld(t);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(w.repoDir, '.odin-memory'));
  writeFileSync(join(w.repoDir, '.odin-memory', 'config.json'), '{"project_name":"configurado"}');
  const r = await hook(w, 'resolve-hook-project', JSON.stringify({ cwd: w.repoDir }), { openStore: () => { throw new Error('no debe abrirse'); } });
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(r.out)), ['project', 'project_path', 'project_source']);
  assert.equal(JSON.parse(r.out).project, 'configurado');
  assert.equal((await hook(w, 'resolve-hook-project', 'basura')).out, '{}\n');
});

test('el postToolUse sin marca ni siquiera abre el almacén', async (t) => {
  const w = cliWorld(t);
  let opened = 0;
  await hook(w, 'copilot-post-tool-use', payload(w), { openStore: () => { opened += 1; throw new Error('x'); } });
  assert.equal(opened, 0);
});
