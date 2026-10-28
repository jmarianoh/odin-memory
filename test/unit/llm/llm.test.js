import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CopilotRunner, ESTIMATED_INPUT_TOKENS_PER_PAIR, ESTIMATED_OUTPUT_TOKENS_PER_PAIR, LlmError, buildPrompt, buildStorePrompt, defaultRunCli, estimateScanCost, newRunner,
  parseVerdict, resolveAgentRunner,
} from '../../../src/llm/index.js';

test('buildPrompt incrusta ambas observaciones en la plantilla canónica', () => {
  const prompt = buildPrompt({ id: 'obs-1', title: 'T1', content: 'C1' }, { id: 'obs-2', title: 'T2', content: 'C2' });
  assert.ok(prompt.startsWith('You are a semantic memory auditor. Compare the two observations below and classify their relationship.\n\n=== Observation A ===\nID: obs-1\nTitle: T1\nContent: C1\n\n=== Observation B ===\nID: obs-2\nTitle: T2\nContent: C2\n\nChoose EXACTLY ONE'));
  assert.ok(prompt.endsWith('{"Relation":"<verb>","Confidence":<0.0–1.0>,"Reasoning":"<≤200 chars>"}'));
  for (const verb of ['conflicts_with', 'supersedes', 'scoped', 'related', 'compatible', 'not_conflict']) assert.ok(prompt.includes(`- ${verb}`), verb);
  assert.match(buildPrompt({}, {}), /ID: \nTitle: \nContent: \n/);
});

test('buildStorePrompt usa el sync_id como identificador', () => {
  const prompt = buildStorePrompt({ sync_id: 'obs-a', title: 'A', type: 'decision', content: 'x' }, { sync_id: 'obs-b', title: 'B', type: 'bugfix', content: 'y' });
  assert.match(prompt, /ID: obs-a\nTitle: A\nContent: x/);
  assert.match(prompt, /ID: obs-b\nTitle: B\nContent: y/);
});

test('estimateScanCost multiplica por par', () => {
  assert.equal(ESTIMATED_INPUT_TOKENS_PER_PAIR, 300);
  assert.equal(ESTIMATED_OUTPUT_TOKENS_PER_PAIR, 50);
  assert.deepEqual(estimateScanCost(100), { input: 30000, output: 5000 });
  assert.deepEqual(estimateScanCost(0), { input: 0, output: 0 });
});

test('parseVerdict acepta el objeto solo, con valla de código, con texto alrededor y con colores', () => {
  const json = '{"Relation":"conflicts_with","Confidence":0.8,"Reasoning":"se contradicen"}';
  const expected = { relation: 'conflicts_with', confidence: 0.8, reasoning: 'se contradicen', model: '' };
  assert.deepEqual(parseVerdict(json), expected);
  assert.deepEqual(parseVerdict(`\n  ${json}\n`), expected);
  assert.deepEqual(parseVerdict(`\`\`\`json\n${json}\n\`\`\``), expected);
  assert.deepEqual(parseVerdict(`\`\`\`\n${json}\n\`\`\``), expected);
  assert.deepEqual(parseVerdict(`Claro, aquí está: ${json} Espero que ayude.`), expected);
  assert.deepEqual(parseVerdict(`\u001b[32m${json}\u001b[0m`), expected);
  assert.deepEqual(parseVerdict('{\u001b[1m"Relation"\u001b[0m:\u001b[32m"conflicts_with"\u001b[0m,"Confidence":0.8,"Reasoning":"se contradicen"}'), expected, 'códigos de color dentro del objeto')
  assert.deepEqual(parseVerdict(`{"nota":{"x":1}} ${json}`), expected, 'salta objetos sin Relation');
  assert.deepEqual(parseVerdict('{"Relation":"related","Confidence":1,"Model":"gpt-x"}'), { relation: 'related', confidence: 1, reasoning: '', model: 'gpt-x' });
  assert.equal(parseVerdict('{"Relation":"related","Confidence":0,"Reasoning":"con } llave y \\" comilla"}').reasoning, 'con } llave y " comilla');
});

test('parseVerdict rechaza lo que no es un veredicto válido', () => {
  const fails = (text, code, message) => assert.throws(() => parseVerdict(text), (e) => e instanceof LlmError && e.code === code && message.test(e.message), text);
  fails('', 'invalid_json', /^agent CLI returned malformed JSON: inner verdict: no JSON object/);
  fails('sin json', 'invalid_json', /malformed JSON/);
  fails('{"Relation":"related","Confidence":}', 'invalid_json', /malformed JSON: inner verdict:/);
  fails('{"Relation":"related"', 'invalid_json', /no JSON object/);
  fails('{"Relation":"related","Confidence":"alta"}', 'invalid_json', /Confidence must be a number/);
  fails('{"Relation":"inventada","Confidence":1}', 'unknown_relation', /^agent returned a relation outside the locked vocabulary: "inventada"$/);
  fails('{"Relation":5,"Confidence":1}', 'unknown_relation', /: 5$/);
});

test('CopilotRunner invoca copilot en modo no interactivo y completa el modelo', async () => {
  const calls = [];
  const runCli = async (name, args, options) => {
    calls.push({ name, args, options });
    return '{"Relation":"supersedes","Confidence":0.7,"Reasoning":"nuevo"}';
  };
  const signal = AbortSignal.timeout(1000);
  const runner = new CopilotRunner({ runCli, env: { ODIN_AGENT_MODEL: ' gpt-x ' } });
  const verdict = await runner.compare('PROMPT', signal);
  assert.deepEqual(calls[0].name, 'copilot');
  assert.deepEqual(calls[0].args, ['-p', 'PROMPT', '--silent', '--model', 'gpt-x']);
  assert.equal(calls[0].options.signal, signal);
  assert.deepEqual({ ...verdict, duration_ms: 0 }, { relation: 'supersedes', confidence: 0.7, reasoning: 'nuevo', model: 'gpt-x', duration_ms: 0 });
  assert.ok(verdict.duration_ms >= 0);

  const plain = new CopilotRunner({ runCli, env: {} });
  await plain.compare('P2');
  assert.deepEqual(calls[1].args, ['-p', 'P2', '--silent']);
  await assert.rejects(new CopilotRunner({ runCli: async () => 'basura', env: {} }).compare('P'), { code: 'invalid_json' });
  const own = new CopilotRunner({ runCli: async () => '{"Relation":"related","Confidence":1,"Model":"propio"}', env: { ODIN_AGENT_MODEL: 'otro' } });
  assert.equal((await own.compare('P')).model, 'propio', 'el modelo que informa la herramienta prevalece');
});

test('defaultRunCli traduce los fallos de la herramienta', async () => {
  assert.equal((await defaultRunCli(process.execPath, ['-e', 'process.stdout.write("hola")'])).toString(), 'hola');
  await assert.rejects(defaultRunCli('odin-no-such-binary-xyz', []), (e) => e instanceof LlmError && e.code === 'cli_not_installed' && e.message === 'agent CLI binary not found in PATH: "odin-no-such-binary-xyz"');
  await assert.rejects(defaultRunCli(process.execPath, ['-e', 'process.stderr.write("mal"); process.exit(3)']), (e) => e.code === 'cli_failed' && /exited 3: mal$/.test(e.message));
  await assert.rejects(
    defaultRunCli(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { signal: AbortSignal.timeout(100) }),
    (e) => e.code === 'timeout' && e.message === 'agent CLI call exceeded timeout',
  );
  const controller = new AbortController();
  const pending = defaultRunCli(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.code === 'timeout' && e.message === 'agent CLI call aborted');
});

test('newRunner y resolveAgentRunner validan el nombre', () => {
  assert.ok(newRunner('copilot') instanceof CopilotRunner);
  assert.throws(() => newRunner(''), (e) => e.code === 'invalid_runner_name' && e.message === 'invalid runner name: ODIN_AGENT_CLI is not set; supported values are: copilot');
  assert.throws(() => newRunner('claude'), (e) => e.message === 'invalid runner name: "claude" is not a recognized runner; set ODIN_AGENT_CLI to one of: copilot');
  assert.ok(resolveAgentRunner({ ODIN_AGENT_CLI: 'copilot' }) instanceof CopilotRunner);
  assert.throws(() => resolveAgentRunner({}), { message: "ODIN_AGENT_CLI is not set; required for --semantic scan (set to 'copilot')" });
  assert.throws(() => resolveAgentRunner({ ODIN_AGENT_CLI: 'otro' }), { code: 'invalid_runner_name' });
});
