import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALL_TOOL_NAMES, PROFILE_ADMIN, PROFILE_AGENT, buildServerInstructions, resolveTools, shouldRegister } from '../../../src/mcp/profiles.js';
import { TOOL_DEFINITIONS } from '../../../src/mcp/tool-definitions.js';

const fixture = JSON.parse(readFileSync(new URL('../../contract/fixtures/mcp-tools.json', import.meta.url), 'utf8'));

test('las definiciones coinciden con el contrato fijado: 27 herramientas, 16 diferidas', () => {
  assert.deepEqual(TOOL_DEFINITIONS, fixture.tools);
  assert.equal(TOOL_DEFINITIONS.length, 27);
  assert.equal(TOOL_DEFINITIONS.filter((t) => t.defer_loading).length, 16);
  assert.deepEqual([...ALL_TOOL_NAMES], [...ALL_TOOL_NAMES].sort());
  for (const t of TOOL_DEFINITIONS) {
    assert.match(t.name, /^mem_[a-z_]+$/);
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 10);
    assert.equal(typeof t.annotations.title, 'string');
    for (const required of t.inputSchema.required ?? []) assert.ok(required in t.inputSchema.properties, `${t.name}.${required}`);
  }
});

test('los perfiles solo nombran herramientas definidas y se solapan como se espera', () => {
  const names = new Set(ALL_TOOL_NAMES);
  for (const name of [...PROFILE_AGENT, ...PROFILE_ADMIN]) assert.ok(names.has(name), name);
  // toda herramienta pertenece a algún perfil
  for (const name of names) assert.ok(PROFILE_AGENT.has(name) || PROFILE_ADMIN.has(name), name);
  assert.deepEqual([...PROFILE_ADMIN].filter((n) => PROFILE_AGENT.has(n)).sort(), ['mem_judge_many', 'mem_session_finalize']);
});

test('resolveTools: perfiles, nombres sueltos, all y entradas vacías', () => {
  assert.equal(resolveTools(''), null);
  assert.equal(resolveTools('   '), null);
  assert.equal(resolveTools('all'), null);
  assert.equal(resolveTools('agent,all'), null);
  assert.equal(resolveTools(' , ,'), null);
  assert.equal(resolveTools(undefined), null);
  assert.deepEqual(resolveTools('agent'), PROFILE_AGENT);
  assert.deepEqual(resolveTools('admin'), PROFILE_ADMIN);
  assert.deepEqual([...resolveTools('mem_save, mem_search')].sort(), ['mem_save', 'mem_search']);
  const mixed = resolveTools('admin,mem_save');
  assert.ok(mixed.has('mem_delete') && mixed.has('mem_save') && !mixed.has('mem_search'));
});

test('shouldRegister', () => {
  assert.equal(shouldRegister('x', null), true);
  assert.equal(shouldRegister('x', undefined), true);
  assert.equal(shouldRegister('x', new Set(['y'])), false);
  assert.equal(shouldRegister('y', new Set(['y'])), true);
});

test('las instrucciones completas describen herramientas núcleo y diferidas, y las reglas del flujo', () => {
  const text = buildServerInstructions(null);
  assert.ok(text.startsWith('odin-memory provides persistent memory that survives across sessions and compactions.\n\nCORE TOOLS (always available):\n  mem_save — '));
  assert.match(text, /DEFERRED TOOLS \(load them through your host's tool discovery when needed\):\n  mem_update, mem_review,/);
  assert.match(text, /PROACTIVE SAVE RULE:/);
  assert.match(text, /## DELIVERY GUARANTEE\n\nMemory operations are internal bookkeeping/);
  assert.match(text, /## CONFLICT SURFACING\n\nAfter mem_save: if judgment_required, prefer mem_judge_many \(max 32\)/);
  assert.ok(text.endsWith('resolve with related | compatible | scoped | not_conflict. Pass evidence from user reply.'));
  assert.ok(!/toolsearch/i.test(text));
  for (const core of ['mem_save', 'mem_search', 'mem_context', 'mem_session_summary', 'mem_get_observation', 'mem_save_prompt', 'mem_current_project', 'mem_judge', 'mem_compare']) {
    assert.ok(text.includes(`  ${core} — `), core);
  }
});

test('las instrucciones se adaptan a las herramientas permitidas', () => {
  const readOnly = buildServerInstructions(new Set(['mem_search', 'mem_context']));
  assert.ok(!readOnly.includes('PROACTIVE SAVE RULE') && !readOnly.includes('DELIVERY GUARANTEE') && !readOnly.includes('CONFLICT SURFACING'));
  assert.ok(!readOnly.includes('DEFERRED TOOLS'));
  assert.match(readOnly, /CORE TOOLS[^]*mem_search[^]*mem_context/);
  const noJudgeMany = buildServerInstructions(new Set(['mem_save', 'mem_judge']));
  assert.match(noJudgeMany, /call mem_judge once per entry using that entry's judgment_id/);
  assert.ok(!noJudgeMany.includes('mem_judge_many'));
  const writeOnlyDeferred = buildServerInstructions(new Set(['mem_pin']));
  assert.ok(writeOnlyDeferred.includes('DELIVERY GUARANTEE') && !writeOnlyDeferred.includes('CORE TOOLS'));
  assert.equal(buildServerInstructions(new Set()), 'odin-memory provides persistent memory that survives across sessions and compactions.');
});
