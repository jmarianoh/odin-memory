// Contraste diferencial de las herramientas MCP de curación: juicios, comparación,
// fusión de proyectos, consolidación y finalización de sesión.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolveBinary, startMcpCommand } from './engram-mcp.mjs';

const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';
const SERVER = fileURLToPath(new URL('./odin-mcp-server.mjs', import.meta.url));

let base;
let repo;
const pairs = [];

async function startPair(cwd) {
  const n = pairs.length;
  const refData = join(base, `ref-${n}`);
  const odinData = join(base, `odin-${n}`);
  const reference = startMcpCommand(binary.bin, ['mcp', '--tools=all'], {
    cwd, dataDir: refData, env: { ENGRAM_DATA_DIR: refData, ENGRAM_NO_UPDATE_CHECK: '1' },
  });
  const odin = startMcpCommand(process.execPath, ['--no-warnings', SERVER], { cwd, dataDir: odinData, env: { ODIN_DATA_DIR: odinData } });
  await Promise.all([reference.initialize(), odin.initialize()]);
  const pair = { reference, odin, refDb: join(refData, 'engram.db'), odinDb: join(odinData, 'odin.db') };
  pairs.push(pair);
  return pair;
}

before(() => {
  if (!binary) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-curation-')));
  repo = join(base, 'my-proj');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
});
after(() => {
  for (const { reference, odin } of pairs) {
    reference.close();
    odin.close();
  }
  if (base) rmSync(base, { recursive: true, force: true });
  binary?.cleanup();
});

function normalize(value) {
  if (value === 'engram') return 'odin'; // actor del sistema
  if (typeof value === 'string') {
    return value
      .replace(/obs-[0-9a-f]{16}/g, 'obs-X').replace(/rel-[0-9a-f]{16}/g, 'rel-X').replace(/prompt-[0-9a-f]{16}/g, 'prompt-X')
      .replace(/\b[0-9a-f]{64}\b/g, 'FP').replace(/\b[0-9a-f]{32}\b/g, 'TOKEN')
      .replaceAll('.engram', '.odin-memory').replaceAll('ENGRAM_PROJECT', 'ODIN_PROJECT').replaceAll('engram save', 'odin save');
  }
  if (typeof value === 'number' && !Number.isInteger(value)) return Number(value.toPrecision(10));
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  return value;
}

/** Quita las marcas de tiempo del texto o JSON: dependen del instante de la prueba. */
function withoutTimes(value) {
  if (typeof value === 'string') return value.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, 'T');
  if (Array.isArray(value)) return value.map(withoutTimes);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutTimes(v)]));
  return value;
}

async function same(pair, label, tool, args, argsOdin = args) {
  const [ref, mine] = await Promise.all([pair.reference.call(tool, args), pair.odin.call(tool, argsOdin)]);
  assert.equal(mine.isError, ref.isError, `${label}: isError\nref: ${ref.text}\nodin: ${mine.text}`);
  assert.deepEqual(withoutTimes(normalize(mine.json ?? mine.text)), withoutTimes(normalize(ref.json ?? ref.text)), label);
  return { ref, mine };
}

const sqlBoth = (pair, sql, ...params) => {
  for (const path of [pair.refDb, pair.odinDb]) {
    const db = new DatabaseSync(path, { timeout: 5000 });
    db.prepare(sql).run(...params);
    db.close();
  }
};
const rows = (path, sql) => {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    return db.prepare(sql).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const STATE = {
  observations: "SELECT id, session_id, type, title, content, tool_name, project, scope, topic_key, deleted_at IS NOT NULL AS deleted, superseded_by_sync_id IS NOT NULL AS superseded FROM observations ORDER BY id",
  sessions: "SELECT id, project, ownership_mode, ended_at IS NOT NULL AS ended, summary FROM sessions ORDER BY id",
  prompts: 'SELECT id, session_id, content, project FROM user_prompts ORDER BY id',
  relations: 'SELECT (SELECT id FROM observations o WHERE o.sync_id = r.source_id) AS source, (SELECT id FROM observations o WHERE o.sync_id = r.target_id) AS target, relation, judgment_status, reason, evidence, confidence, marked_by_actor, marked_by_kind, marked_by_model, session_id FROM memory_relations r ORDER BY id',
  finalizations: 'SELECT session_id, summary_id FROM session_finalizations ORDER BY session_id',
};
function assertSameState(pair, label) {
  for (const [name, sql] of Object.entries(STATE)) {
    assert.deepEqual(normalize(rows(pair.odinDb, sql)), normalize(rows(pair.refDb, sql)), `${label}: estado de ${name}`);
  }
}

/** Siembra observaciones que generan candidatos de conflicto. */
async function seed(pair) {
  const saved = [];
  for (const o of [
    { title: 'Decisión de caché', content: 'usamos Redis como caché distribuida para sesiones', type: 'decision' },
    { title: 'Caché de sesiones con Redis', content: 'Redis guarda las sesiones de usuario', type: 'decision' },
    { title: 'Migración de base de datos', content: 'plan para migrar la base de datos', type: 'decision' },
    { title: 'Migración de la base de datos a Postgres', content: 'se decidió migrar a Postgres', type: 'decision' },
    { title: 'Persistencia SQLite', content: 'WAL y FTS5 para búsqueda de texto completo', type: 'architecture' },
  ]) {
    const { ref, mine } = await same(pair, `siembra ${o.title}`, 'mem_save', o);
    saved.push({ ref: ref.json, mine: mine.json });
  }
  sqlBoth(pair, "UPDATE observations SET created_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes'), updated_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes'), last_seen_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes')");
  return saved;
}

test('mem_judge, mem_judge_many y mem_compare', { skip }, async () => {
  const pair = await startPair(repo);
  const saved = await seed(pair);
  const second = saved[1]; // candidato: #1
  const fourth = saved[3]; // candidato: #3
  assert.equal(second.ref.candidates.length, second.mine.candidates.length);
  const judge = (side, extra) => ({ judgment_id: side.candidates[0].judgment_id, ...extra });

  await same(pair, 'sin judgment_id', 'mem_judge', { relation: 'related' });
  await same(pair, 'sin relation', 'mem_judge', { judgment_id: 'rel-x' });
  await same(pair, 'confianza fuera de rango', 'mem_judge', { judgment_id: 'rel-x', relation: 'related', confidence: 1.5 });
  await same(pair, 'relación inexistente', 'mem_judge', { judgment_id: 'rel-0000000000000000', relation: 'related' });
  await same(pair, 'verbo inválido', 'mem_judge', judge(second.ref, { relation: 'amigos' }), judge(second.mine, { relation: 'amigos' }));
  await same(pair, 'juicio completo', 'mem_judge', judge(second.ref, { relation: 'supersedes', reason: 'más reciente', evidence: 'el usuario lo confirmó', confidence: 0.8, session_id: 'sesion-j' }), judge(second.mine, { relation: 'supersedes', reason: 'más reciente', evidence: 'el usuario lo confirmó', confidence: 0.8, session_id: 'sesion-j' }));
  await same(pair, 'rejuzgar', 'mem_judge', judge(second.ref, { relation: 'compatible' }), judge(second.mine, { relation: 'compatible', }));
  await same(pair, 'juicio mínimo', 'mem_judge', judge(fourth.ref, { relation: 'conflicts_with', confidence: 0 }), judge(fourth.mine, { relation: 'conflicts_with', confidence: 0 }));

  // lote: dos candidatos nuevos y errores de formato
  const more = [];
  for (const o of [
    { title: 'Caché con Redis y sesiones de usuario', content: 'otra nota sobre Redis y sesiones', type: 'decision' },
    { title: 'Migración de base de datos a Postgres plan', content: 'otra nota sobre migrar la base de datos', type: 'decision' },
  ]) {
    const { ref, mine } = await same(pair, `siembra lote ${o.title}`, 'mem_save', o);
    more.push({ ref: ref.json, mine: mine.json });
  }
  const refIds = more.flatMap((m) => m.ref.candidates.map((c) => c.judgment_id));
  const mineIds = more.flatMap((m) => m.mine.candidates.map((c) => c.judgment_id));
  assert.equal(refIds.length, mineIds.length);
  assert.ok(refIds.length >= 2, 'se necesitan candidatos para el lote');
  const batch = (ids) => ({
    session_id: 'sesion-lote',
    judgments: [
      { judgment_id: ids[0], relation: 'related', reason: 'misma área', confidence: 0.6 },
      { judgment_id: ids[1], relation: 'scoped' },
      { judgment_id: 'rel-0000000000000000', relation: 'related' },
      { relation: 'related' },
      { judgment_id: ids[0], relation: 'inexistente' },
      { judgment_id: 5, relation: 'related' },
      'no es objeto',
      { judgment_id: ids[0], relation: 'related', confidence: 2 },
      { judgment_id: ids[0], relation: 'related', reason: 7 },
    ],
  });
  await same(pair, 'lote mixto', 'mem_judge_many', batch(refIds), batch(mineIds));
  await same(pair, 'lote vacío', 'mem_judge_many', { judgments: [] });
  await same(pair, 'lote sin arreglo', 'mem_judge_many', { judgments: 'x' });
  await same(pair, 'lote demasiado grande', 'mem_judge_many', { judgments: Array.from({ length: 33 }, () => ({ judgment_id: 'a', relation: 'related' })) });
  await same(pair, 'lote con session_id inválido', 'mem_judge_many', { judgments: [{ judgment_id: 'a', relation: 'related' }], session_id: 4 });

  const extra = await same(pair, 'siembra con candidato vacío', 'mem_save', { title: 'Persistencia SQLite con WAL', content: 'WAL y FTS5 en SQLite', type: 'architecture' });
  assert.ok(extra.ref.json.candidates?.length >= 1, 'se necesita un candidato');
  await same(pair, 'juicio con razón y evidencia vacías', 'mem_judge', judge(extra.ref.json, { relation: 'related', reason: '', evidence: '' }), judge(extra.mine.json, { relation: 'related', reason: '', evidence: '' }));

  await same(pair, 'compare sin a', 'mem_compare', { memory_id_b: 2 });
  await same(pair, 'compare sin b', 'mem_compare', { memory_id_a: 1 });
  await same(pair, 'compare sin relación', 'mem_compare', { memory_id_a: 1, memory_id_b: 2 });
  await same(pair, 'compare sin razonamiento', 'mem_compare', { memory_id_a: 1, memory_id_b: 2, relation: 'related' });
  await same(pair, 'compare sin confianza', 'mem_compare', { memory_id_a: 1, memory_id_b: 2, relation: 'related', reasoning: 'x' });
  await same(pair, 'compare confianza fuera', 'mem_compare', { memory_id_a: 1, memory_id_b: 2, relation: 'related', reasoning: 'x', confidence: -0.1 });
  await same(pair, 'compare observación inexistente', 'mem_compare', { memory_id_a: 99, memory_id_b: 2, relation: 'related', reasoning: 'x', confidence: 0.5 });
  await same(pair, 'compare segunda inexistente', 'mem_compare', { memory_id_a: 1, memory_id_b: 99, relation: 'related', reasoning: 'x', confidence: 0.5 });
  await same(pair, 'compare verbo inválido', 'mem_compare', { memory_id_a: 1, memory_id_b: 5, relation: 'amigos', reasoning: 'x', confidence: 0.5 });
  await same(pair, 'compare con identificadores decimales', 'mem_compare', { memory_id_a: 1.9, memory_id_b: 3.2, relation: 'scoped', reasoning: 'acotado', confidence: 0.4, model: 'gpt-4.1' });
  await same(pair, 'compare nuevo', 'mem_compare', { memory_id_a: 1, memory_id_b: 5, relation: 'related', reasoning: 'comparten tema', confidence: 0.7, model: 'gpt-4.1' });
  await same(pair, 'compare existente en sentido inverso', 'mem_compare', { memory_id_a: 5, memory_id_b: 1, relation: 'compatible', reasoning: 'ambas valen', confidence: 0.9 });
  await same(pair, 'compare mismo par', 'mem_compare', { memory_id_a: 2, memory_id_b: 2, relation: 'related', reasoning: 'x', confidence: 0.5 });
  assertSameState(pair, 'tras juicios');
});

test('mem_merge_projects', { skip }, async () => {
  const pair = await startPair(repo);
  await seed(pair);
  await same(pair, 'prompt', 'mem_save_prompt', { content: 'un prompt del proyecto' });
  await same(pair, 'segundo prompt', 'mem_save_prompt', { content: 'otro prompt del proyecto' });
  await same(pair, 'segunda sesión', 'mem_session_start', { id: 'extra' });
  await same(pair, 'tercera sesión', 'mem_session_start', { id: 'extra-2' });
  sqlBoth(pair, "UPDATE observations SET project = 'my_proj' WHERE id IN (1, 2)");
  sqlBoth(pair, "UPDATE sessions SET project = 'my_proj'");
  sqlBoth(pair, "UPDATE user_prompts SET project = 'my_proj'");
  await same(pair, 'sin from', 'mem_merge_projects', { to: 'my-proj' });
  await same(pair, 'sin to', 'mem_merge_projects', { from: 'my_proj' });
  await same(pair, 'from solo comas', 'mem_merge_projects', { from: ' , ,', to: 'my-proj' });
  await same(pair, 'origen inexistente', 'mem_merge_projects', { from: 'nada', to: 'my-proj' });
  await same(pair, 'origen que no es variante', 'mem_merge_projects', { from: 'otro', to: 'my-proj' });
  await same(pair, 'destino reservado', 'mem_merge_projects', { from: 'my_proj', to: '_inbox' });
  await same(pair, 'fusión', 'mem_merge_projects', { from: 'my_proj', to: 'my-proj' });
  await same(pair, 'fusión repetida', 'mem_merge_projects', { from: 'my_proj', to: 'my-proj' });
  await same(pair, 'fusión sin movimientos', 'mem_merge_projects', { from: 'my-proj', to: 'my-proj' });
  assertSameState(pair, 'tras fusionar');
});

test('mem_consolidate: previsualización, confirmación y rechazos', { skip }, async () => {
  const pair = await startPair(repo);
  await seed(pair);
  const args = (extra = {}) => ({ ids_to_delete: [1, 2, 3], new_title: 'Consolidado', new_content: 'resumen consolidado', expected_project: 'my-proj', ...extra });
  const preview = await same(pair, 'previsualización', 'mem_consolidate', args());
  assert.equal(preview.ref.json.status, 'preview');
  const confirm = (fp, extra = {}) => ({ ...args(extra), confirm: true, fingerprint: fp });

  await same(pair, 'argumento no admitido', 'mem_consolidate', args({ project: 'otro' }));
  await same(pair, 'sin título', 'mem_consolidate', { ...args(), new_title: ' ' });
  await same(pair, 'sin contenido', 'mem_consolidate', { ...args(), new_content: undefined });
  await same(pair, 'sin proyecto esperado', 'mem_consolidate', { ...args(), expected_project: undefined });
  await same(pair, 'un solo id', 'mem_consolidate', args({ ids_to_delete: [1] }));
  await same(pair, 'id no entero', 'mem_consolidate', args({ ids_to_delete: [1, 2.5] }));
  await same(pair, 'id cero', 'mem_consolidate', args({ ids_to_delete: [0, 2] }));
  await same(pair, 'id enorme', 'mem_consolidate', args({ ids_to_delete: [1, 9007199254740993] }));
  await same(pair, 'ids repetidos', 'mem_consolidate', args({ ids_to_delete: [1, 1] }));
  await same(pair, 'id inexistente', 'mem_consolidate', args({ ids_to_delete: [1, 99] }));
  await same(pair, 'tipo no cadena', 'mem_consolidate', args({ type: 4 }));
  await same(pair, 'confirm no booleano', 'mem_consolidate', args({ confirm: 'si' }));
  await same(pair, 'confirm sin huella', 'mem_consolidate', args({ confirm: true }));
  await same(pair, 'proyecto esperado ajeno', 'mem_consolidate', args({ expected_project: 'otro' }));
  await same(pair, 'proyecto esperado inválido', 'mem_consolidate', args({ expected_project: 'a/b' }));
  await same(pair, 'huella falsa', 'mem_consolidate', confirm('0'.repeat(64)));
  await same(pair, 'con tipo y tema', 'mem_consolidate', args({ type: 'decision', topic_key: 'decision/cache' }));
  await same(pair, 'confirmación', 'mem_consolidate', confirm(preview.ref.json.plan.fingerprint), confirm(preview.mine.json.plan.fingerprint));
  await same(pair, 'fuente ya consolidada', 'mem_consolidate', confirm(preview.ref.json.plan.fingerprint), confirm(preview.mine.json.plan.fingerprint));
  assertSameState(pair, 'tras consolidar');
});

test('mem_session_finalize', { skip }, async () => {
  const pair = await startPair(repo);
  await same(pair, 'inicio', 'mem_session_start', { id: 's1' });
  await same(pair, 'otro inicio', 'mem_session_start', { id: 's2' });
  await same(pair, 'sesión ajena', 'mem_session_start', { id: 's3' });
  sqlBoth(pair, "UPDATE sessions SET project = 'ajeno', ownership_mode = 'project_owned' WHERE id = 's3'");
  await same(pair, 'sin session_id', 'mem_session_finalize', { summary: 'x' });
  await same(pair, 'sin resumen', 'mem_session_finalize', { session_id: 's1' });
  await same(pair, 'resumen en blanco', 'mem_session_finalize', { session_id: 's1', summary: '  ' });
  await same(pair, 'tipo inválido', 'mem_session_finalize', { session_id: 5, summary: 'x' });
  await same(pair, 'proyecto no cadena', 'mem_session_finalize', { session_id: 's1', summary: 'x', project: 3 });
  await same(pair, 'sesión desconocida', 'mem_session_finalize', { session_id: 'nada', summary: 'x' });
  await same(pair, 'sesión con espacios', 'mem_session_finalize', { session_id: ' s1 ', summary: 'x' });
  await same(pair, 'proyecto en blanco', 'mem_session_finalize', { session_id: 's1', summary: 'x', project: ' ' });
  await same(pair, 'proyecto ajeno a una sesión propietaria', 'mem_session_finalize', { session_id: 's3', summary: 'x', project: 'my-proj' });
  await same(pair, 'sesión de otro proyecto', 'mem_session_finalize', { session_id: 's3', summary: 'x' });
  await same(pair, 'sesión compartida', 'mem_session_start', { id: 's5' });
  await same(pair, 'proyecto distinto en sesión compartida', 'mem_session_finalize', { session_id: 's5', summary: 'x', project: 'otro' });
  await same(pair, 'finalizar', 'mem_session_finalize', { session_id: 's1', summary: '## Goal\nprobar\n## Accomplished\n- todo' });
  await same(pair, 'reintento idéntico', 'mem_session_finalize', { session_id: 's1', summary: '## Goal\nprobar\n## Accomplished\n- todo' });
  await same(pair, 'reintento distinto', 'mem_session_finalize', { session_id: 's1', summary: 'otro texto' });
  await same(pair, 'cerrada aparte', 'mem_session_end', { id: 's2', summary: 'cerrada' });
  await same(pair, 'finalizar cerrada', 'mem_session_finalize', { session_id: 's2', summary: 'tarde' });
  await same(pair, 'finalizar con proyecto', 'mem_session_start', { id: 's4' });
  await same(pair, 'proyecto explícito igual', 'mem_session_finalize', { session_id: 's4', summary: 'con proyecto', project: 'my-proj' });
  assertSameState(pair, 'tras finalizar');
});
