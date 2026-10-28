import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextOutput, parseHookInput } from '../../../src/hooks/input.js';
import { hookProjectCwd, resolveHookProject } from '../../../src/hooks/project.js';
import { initRepo, tempDir, write } from '../project/helpers.js';

test('el formato camelCase de Copilot', () => {
  const input = parseHookInput(JSON.stringify({ sessionId: ' s1 ', timestamp: 1, cwd: '/x', source: 'startup', prompt: 'hola', reason: 'complete', trigger: 'auto', response: 'r' }));
  assert.deepEqual({ ...input, raw: undefined }, {
    ok: true, style: 'camel', eventName: '', sessionId: 's1', cwd: '/x', prompt: 'hola', source: 'startup', reason: 'complete', trigger: 'auto', response: 'r', raw: undefined,
  });
});

test('el formato snake_case de VS Code', () => {
  const input = parseHookInput(JSON.stringify({ session_id: 's2', hook_event_name: 'UserPromptSubmit', cwd: '/y', prompt: 'p', last_assistant_message: 'dicho' }));
  assert.deepEqual([input.style, input.eventName, input.sessionId, input.response], ['pascal', 'UserPromptSubmit', 's2', 'dicho']);
  assert.equal(parseHookInput('{"session_id":"x"}').style, 'pascal');
});

test('una carga que no es un objeto JSON no es válida', () => {
  for (const text of ['', 'no json', 'null', '[]', '"x"', '5']) assert.equal(parseHookInput(text).ok, false, text);
  const odd = parseHookInput('{"sessionId":5,"cwd":null,"prompt":[]}');
  assert.deepEqual([odd.ok, odd.sessionId, odd.cwd, odd.prompt], [true, '', '', '']);
});

test('la salida con contexto sigue el formato de quien llama', () => {
  assert.deepEqual(contextOutput({ style: 'camel' }, 'SessionStart', 'texto'), { additionalContext: 'texto' });
  assert.deepEqual(contextOutput({ style: 'pascal' }, 'SessionStart', 'texto'), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'texto' } });
});

test('hookProjectCwd exige un único cwd en minúsculas, de cadena, en un solo objeto', () => {
  assert.equal(hookProjectCwd('{"cwd":"/a"}'), '/a');
  assert.equal(hookProjectCwd(' {"x":1,"cwd":"/a","y":{"cwd":"/b"}} \n'), '/a', 'un cwd anidado no cuenta');
  assert.equal(hookProjectCwd('{"cwd":"/a\\u0062"}'), '/ab');
  assert.equal(hookProjectCwd('{"cwd":"/a","cwd":"/b"}'), null, 'una clave repetida es ambigua');
  assert.equal(hookProjectCwd('{"\\u0063wd":"/a","cwd":"/b"}'), null, 'también si una se escribe con escapes');
  for (const text of ['{"CWD":"/a"}', '{"cwd":5}', '{"cwd":null}', '{}', '[]', '', 'no json', '{"cwd":"/a"}{"cwd":"/a"}', '{"cwd":"/a"} x', '{"cwd":"\uFFFD"}']) {
    assert.equal(hookProjectCwd(text), null, JSON.stringify(text));
  }
});

test('resolveHookProject solo responde con un directorio absoluto y verificable', (t) => {
  const root = tempDir(t);
  const repo = initRepo(`${root}/mi-repo`);
  // Sin vínculo de repositorio ni configuración no hay nada verificable: los hooks no adivinan.
  assert.deepEqual(resolveHookProject(JSON.stringify({ cwd: repo }), process.env), {});
  write(`${repo}/.odin-memory/config.json`, '{"project_name":"configurado"}');
  const found = resolveHookProject(JSON.stringify({ cwd: repo }), process.env);
  assert.deepEqual(Object.keys(found), ['project', 'project_path', 'project_source'], 'claves en orden alfabético');
  assert.deepEqual([found.project, found.project_source], ['configurado', 'config']);
  assert.deepEqual(resolveHookProject(JSON.stringify({ cwd: 'relativo' }), {}), {});
  // Un directorio relativo que sí existe tampoco vale: la carga debe traer una ruta absoluta.
  const previous = process.cwd();
  process.chdir(repo);
  try {
    assert.deepEqual(resolveHookProject(JSON.stringify({ cwd: '.' }), process.env), {});
    assert.equal(resolveHookProject(JSON.stringify({ cwd: repo }), process.env).project, 'configurado');
  } finally {
    process.chdir(previous);
  }
  assert.deepEqual(resolveHookProject(JSON.stringify({ cwd: `${root}/no-existe` }), {}), {});
  assert.deepEqual(resolveHookProject('basura', {}), {});
});
