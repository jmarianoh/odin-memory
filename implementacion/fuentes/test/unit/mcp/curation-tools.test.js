import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServer } from '../../../src/mcp/server.js';
import { getSession } from '../../../src/store/index.js';
import { initRepo, tempDir as repoTempDir } from '../project/helpers.js';
import { openTempStore } from '../store/helpers.js';

function setup(t) {
  const store = openTempStore(t);
  const cwd = initRepo(join(repoTempDir(t), 'mi-repo'));
  const server = createServer(store, {}, null, { env: {}, cwd: () => cwd });
  const run = async (name, args = {}) => {
    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    const text = res.result.content[0].text;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // texto plano
    }
    return { text, json, isError: res.result.isError === true };
  };
  return { store, server, run, cwd };
}

/** Guarda dos decisiones parecidas para que la segunda ofrezca un candidato. */
async function seedConflict(run) {
  await run('mem_save', { title: 'Decisión de caché', content: 'usamos Redis como caché distribuida', type: 'decision' });
  return run('mem_save', { title: 'Decisión de caché con Redis', content: 'Redis guarda las sesiones', type: 'decision' });
}

test('mem_judge valida los argumentos y registra el veredicto del agente', async (t) => {
  const { run, store } = setup(t);
  const saved = await seedConflict(run);
  const id = saved.json.judgment_id;
  assert.equal((await run('mem_judge', { relation: 'related' })).text, 'judgment_id is required');
  assert.equal((await run('mem_judge', { judgment_id: id })).text, 'relation is required');
  assert.equal((await run('mem_judge', { judgment_id: id, relation: 'related', confidence: 1.5 })).text, 'confidence must be between 0.0 and 1.0');
  assert.match((await run('mem_judge', { judgment_id: 'rel-0000000000000000', relation: 'related' })).text, /not found/);
  assert.match((await run('mem_judge', { judgment_id: id, relation: 'amigos' })).text, /invalid relation verb/);

  const ok = await run('mem_judge', { judgment_id: id, relation: 'supersedes', reason: 'más reciente', evidence: 'lo dijo el usuario', confidence: 0.8, session_id: 'sesion-j' });
  assert.equal(ok.isError, false);
  const { relation } = ok.json;
  assert.equal(relation.relation, 'supersedes');
  assert.equal(relation.judgment_status, 'judged');
  assert.equal(relation.reason, 'más reciente');
  assert.equal(relation.evidence, 'lo dijo el usuario');
  assert.equal(relation.confidence, 0.8);
  assert.equal(relation.marked_by_actor, 'agent');
  assert.equal(relation.marked_by_kind, 'agent');
  assert.equal(relation.session_id, 'sesion-j');
  assert.equal(relation.sync_id, id);
  assert.equal(store.db.get('SELECT judgment_status FROM memory_relations WHERE sync_id = ?', id).judgment_status, 'judged');

  // los campos opcionales vacíos no se envían: la relación queda sin razón ni evidencia
  const bare = await run('mem_judge', { judgment_id: id, relation: 'compatible', reason: '', evidence: '' });
  assert.equal(bare.json.relation.relation, 'compatible');
  assert.equal('reason' in bare.json.relation, false);
  assert.equal('evidence' in bare.json.relation, false);
});

test('mem_judge_many aplica el lote en orden y describe cada resultado', async (t) => {
  const { run } = setup(t);
  const saved = await seedConflict(run);
  const id = saved.json.judgment_id;
  const batch = await run('mem_judge_many', {
    session_id: 'sesion-lote',
    judgments: [
      { judgment_id: id, relation: 'related', reason: 'misma área', confidence: 0.6 },
      { judgment_id: 'rel-0000000000000000', relation: 'related' },
      { relation: 'related' },
      { judgment_id: id, relation: 'inexistente' },
      { judgment_id: 5, relation: 'related' },
      'no es objeto',
      { judgment_id: id, relation: 'related', confidence: 2 },
      { judgment_id: id, relation: 'related', reason: 7 },
    ],
  });
  const outcomes = batch.json.outcomes;
  assert.equal(outcomes.length, 8);
  assert.deepEqual(outcomes.map((o) => o.status), ['success', 'error', 'error', 'error', 'error', 'error', 'error', 'error']);
  assert.deepEqual(outcomes.map((o) => o.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(outcomes[0].judgment_id, id);
  assert.equal(outcomes[0].judgment_status, 'judged');
  assert.equal(outcomes[0].relation.session_id, 'sesion-lote');
  assert.match(outcomes[1].error, /not found/);
  assert.equal(outcomes[2].judgment_id, null);
  assert.equal(outcomes[2].error, 'judgment_id is required');
  assert.match(outcomes[3].error, /invalid relation verb/);
  assert.equal(outcomes[4].judgment_id, null); // no es cadena
  assert.equal(outcomes[4].error, 'judgment_id must be a string');
  assert.equal(outcomes[5].error, 'judgment must be an object');
  assert.equal(outcomes[6].error, 'confidence must be a number between 0.0 and 1.0');
  assert.equal(outcomes[7].error, 'reason must be a string');

  assert.equal((await run('mem_judge_many', { judgments: [] })).text, 'judgments must be an array containing 1..32 items');
  assert.equal((await run('mem_judge_many', { judgments: 'x' })).text, 'judgments must be an array containing 1..32 items');
  assert.equal((await run('mem_judge_many', { judgments: Array.from({ length: 33 }, () => ({})) })).text, 'judgments must be an array containing 1..32 items');
  assert.equal((await run('mem_judge_many', { judgments: [{}], session_id: 4 })).text, 'session_id must be a string');
  assert.equal((await run('mem_judge_many', { judgments: Array.from({ length: 32 }, () => ({})) })).json.outcomes.length, 32);
});

test('mem_compare persiste un veredicto ya juzgado fuera', async (t) => {
  const { run, store } = setup(t);
  for (const title of ['Uno', 'Dos']) await run('mem_save', { title, content: `contenido ${title}` });
  const full = { memory_id_a: 1, memory_id_b: 2, relation: 'related', reasoning: 'comparten tema', confidence: 0.7 };
  assert.equal((await run('mem_compare', { memory_id_b: 2 })).text, 'memory_id_a is required (integer observation id)');
  assert.equal((await run('mem_compare', { memory_id_a: 1 })).text, 'memory_id_b is required (integer observation id)');
  assert.equal((await run('mem_compare', { ...full, relation: undefined })).text, 'relation is required');
  assert.equal((await run('mem_compare', { ...full, reasoning: undefined })).text, 'reasoning is required');
  assert.equal((await run('mem_compare', { ...full, confidence: undefined })).text, 'confidence is required (float 0.0..1.0)');
  assert.equal((await run('mem_compare', { ...full, confidence: -0.1 })).text, 'confidence must be between 0.0 and 1.0');
  assert.equal((await run('mem_compare', { ...full, memory_id_a: 99 })).text, 'observation id=99 not found: sql: no rows in result set');
  assert.equal((await run('mem_compare', { ...full, memory_id_b: 98 })).text, 'observation id=98 not found: sql: no rows in result set');
  assert.match((await run('mem_compare', { ...full, relation: 'amigos' })).text, /invalid relation verb/);

  const created = await run('mem_compare', { ...full, model: 'gpt-4.1' });
  assert.match(created.json.sync_id, /^rel-[0-9a-f]{16}$/);
  const row = store.db.get('SELECT relation, judgment_status, confidence, reason, marked_by_model FROM memory_relations WHERE sync_id = ?', created.json.sync_id);
  assert.deepEqual({ ...row }, { relation: 'related', judgment_status: 'judged', confidence: 0.7, reason: 'comparten tema', marked_by_model: 'gpt-4.1' });
  // el mismo par en sentido inverso actualiza la relación existente
  const inverse = await run('mem_compare', { memory_id_a: 2, memory_id_b: 1, relation: 'compatible', reasoning: 'ambas valen', confidence: 0.9 });
  assert.equal(inverse.json.sync_id, created.json.sync_id);
  assert.equal(Number(store.db.get('SELECT COUNT(*) AS n FROM memory_relations').n), 1);
});

test('mem_merge_projects fusiona variantes de un proyecto en el canónico', async (t) => {
  const { run, store } = setup(t);
  await run('mem_save', { title: 'Uno', content: 'primero' });
  await run('mem_save', { title: 'Dos', content: 'segundo' });
  await run('mem_save_prompt', { content: 'un prompt' });
  store.db.run("UPDATE observations SET project = 'mi_repo' WHERE id = 1");
  store.db.run("UPDATE sessions SET project = 'mi_repo'");
  store.db.run("UPDATE user_prompts SET project = 'mi_repo'");
  assert.equal((await run('mem_merge_projects', { to: 'mi-repo' })).text, "both 'from' and 'to' are required");
  assert.equal((await run('mem_merge_projects', { from: 'mi_repo' })).text, "both 'from' and 'to' are required");
  assert.equal((await run('mem_merge_projects', { from: ' , ,', to: 'mi-repo' })).text, "at least one source project name is required in 'from'");
  assert.match((await run('mem_merge_projects', { from: 'otro', to: 'mi-repo' })).text, /^Merge failed: /);
  const merged = await run('mem_merge_projects', { from: 'mi_repo', to: 'mi-repo' });
  assert.equal(merged.text, 'Merged 1 source(s) into "mi-repo":\n  Observations moved: 1\n  Sessions moved:     1\n  Prompts moved:      1\n');
  assert.equal(store.db.get('SELECT project FROM observations WHERE id = 1').project, 'mi-repo');
  // el origen ya no existe tras fusionarlo; con origen igual al destino no hay nada que mover
  assert.match((await run('mem_merge_projects', { from: 'mi_repo', to: 'mi-repo' })).text, /^Merge failed: source project "mi_repo" does not exist/);
  assert.equal((await run('mem_merge_projects', { from: 'mi-repo', to: 'mi-repo' })).text.split('\n')[0], 'No records moved into "mi-repo".');
});

test('mem_consolidate previsualiza, confirma con la huella y rechaza lo demás', async (t) => {
  const { run, store } = setup(t);
  for (const title of ['Uno', 'Dos', 'Tres']) await run('mem_save', { title, content: `contenido de ${title}`, type: 'decision' });
  const args = (extra = {}) => ({ ids_to_delete: [1, 2, 3], new_title: 'Consolidado', new_content: 'resumen consolidado', expected_project: 'mi-repo', ...extra });
  const error = async (a) => JSON.parse((await run('mem_consolidate', a)).text).error;

  const preview = await run('mem_consolidate', args());
  assert.equal(preview.isError, false);
  assert.equal(preview.json.status, 'preview');
  assert.deepEqual(preview.json.plan.source_ids, [1, 2, 3]);
  assert.equal(preview.json.plan.project, 'mi-repo');
  assert.match(preview.json.plan.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(preview.json.plan.sources.length, 3);
  assert.equal(preview.json.plan.sources[0].id, 3); // la más reciente primero
  assert.deepEqual(Object.keys(preview.json.plan.survivor).sort(), ['content', 'project', 'scope', 'session_id', 'title', 'topic_key', 'type']);
  assert.match(preview.json.plan.survivor.content, /^resumen consolidado/);
  assert.equal(Number(store.db.get('SELECT COUNT(*) AS n FROM observations').n), 3); // la previsualización no escribe

  assert.equal((await error(args({ project: 'otro' }))).message, 'unsupported argument "project"; source project/session/scope cannot be overridden');
  for (const [a, message] of [
    [{ new_title: ' ' }, 'new_title must be a non-empty string'],
    [{ new_content: undefined }, 'new_content must be a non-empty string'],
    [{ expected_project: undefined }, 'expected_project must be a non-empty string'],
    [{ ids_to_delete: [1] }, 'ids_to_delete must be an array of at least two positive integer IDs'],
    [{ ids_to_delete: [1, 2.5] }, 'ids_to_delete must contain positive exact JSON integers'],
    [{ ids_to_delete: [0, 2] }, 'ids_to_delete must contain positive exact JSON integers'],
    [{ ids_to_delete: [1, 9007199254740993] }, 'ids_to_delete must contain positive exact JSON integers'],
    [{ type: 4 }, 'type must be a string'],
    [{ confirm: 'si' }, 'confirm must be a boolean'],
    [{ confirm: true }, 'fingerprint is required when confirm is true'],
  ]) {
    const e = await error({ ...args(), ...a });
    assert.deepEqual(e, { code: 'invalid_arguments', message }, message);
  }
  assert.equal((await error(args({ ids_to_delete: [1, 1] }))).code, 'consolidation_refused');
  assert.equal((await error(args({ ids_to_delete: [1, 99] }))).code, 'consolidation_refused');
  assert.equal((await error(args({ expected_project: 'otro' }))).code, 'project_mismatch');
  assert.equal((await error(args({ expected_project: 'a/b' }))).code, 'invalid_arguments');

  const stale = JSON.parse((await run('mem_consolidate', args({ confirm: true, fingerprint: '0'.repeat(64) }))).text);
  assert.equal(stale.error.code, 'fingerprint_mismatch');
  assert.equal(stale.plan.fingerprint, preview.json.plan.fingerprint); // devuelve el plan vigente
  assert.equal(Number(store.db.get('SELECT COUNT(*) AS n FROM observations WHERE deleted_at IS NULL').n), 3);

  // cambiar el tipo o el tema cambia el plan resuelto, así que la huella anterior deja de valer
  const changed = JSON.parse((await run('mem_consolidate', args({ confirm: true, fingerprint: preview.json.plan.fingerprint, topic_key: 'decision/cache' }))).text);
  assert.equal(changed.error.code, 'fingerprint_mismatch');
  assert.equal(changed.plan.survivor.topic_key, 'decision/cache');
});

test('mem_consolidate confirmado consolida y deja las fuentes borradas', async (t) => {
  const { run, store } = setup(t);
  for (const title of ['Uno', 'Dos']) await run('mem_save', { title, content: `contenido de ${title}`, type: 'decision' });
  const args = { ids_to_delete: [1, 2], new_title: 'Consolidado', new_content: 'resumen', expected_project: 'mi-repo', topic_key: 'decision/cache' };
  const preview = await run('mem_consolidate', args);
  const done = await run('mem_consolidate', { ...args, confirm: true, fingerprint: preview.json.plan.fingerprint });
  assert.equal(done.isError, false);
  assert.equal(done.json.status, 'consolidated');
  assert.deepEqual(done.json.soft_deleted_ids, [1, 2]);
  assert.equal(done.json.survivor.title, 'Consolidado');
  assert.equal(done.json.survivor.topic_key, 'decision/cache');
  assert.equal(done.json.survivor.tool_name, 'mem_consolidate');
  assert.match(done.json.survivor.content, /## consolidated_from/);
  assert.equal(Number(store.db.get('SELECT COUNT(*) AS n FROM observations WHERE deleted_at IS NULL').n), 1);
  const again = JSON.parse((await run('mem_consolidate', { ...args, confirm: true, fingerprint: preview.json.plan.fingerprint })).text);
  assert.equal(again.error.code, 'consolidation_refused'); // las fuentes ya no existen
});

test('mem_session_finalize cierra la sesión con su resumen de forma idempotente', async (t) => {
  const { run, store } = setup(t);
  await run('mem_session_start', { id: 's1' });
  await run('mem_session_start', { id: 's2' });
  assert.deepEqual(await run('mem_session_finalize', { summary: 'x' }).then((r) => r.json.error_code), 'invalid_arguments');
  assert.equal((await run('mem_session_finalize', { session_id: 's1' })).json.message, 'session_id and summary are required and must be nonempty');
  assert.equal((await run('mem_session_finalize', { session_id: 5, summary: 'x' })).json.message, 'session_id must be a string');
  assert.equal((await run('mem_session_finalize', { session_id: 's1', summary: 'x', project: 3 })).json.message, 'project must be a string');
  const unknown = await run('mem_session_finalize', { session_id: 'nada', summary: 'x' });
  assert.equal(unknown.json.error_code, 'unknown_session');
  assert.equal(unknown.json.message, 'session_id must identify an existing exact session');
  assert.equal((await run('mem_session_finalize', { session_id: ' s1 ', summary: 'x' })).json.error_code, 'unknown_session'); // identidad exacta

  const first = await run('mem_session_finalize', { session_id: 's1', summary: '## Goal\nprobar' });
  assert.equal(first.isError, false);
  assert.equal(first.json.result, 'Session finalization completed');
  assert.equal(first.json.state, 'finalized');
  assert.equal(first.json.already_finalized, false);
  assert.equal(first.json.judgment_required, false);
  assert.equal(first.json.session_id, 's1');
  assert.match(first.json.summary_sync_id, /^obs-/);
  assert.equal(store.db.get('SELECT type FROM observations WHERE id = ?', first.json.summary_id).type, 'session_summary');
  assert.notEqual(getSession(store, 's1').ended_at, null);

  const retry = await run('mem_session_finalize', { session_id: 's1', summary: 'otro texto' });
  assert.equal(retry.json.state, 'already_finalized');
  assert.equal(retry.json.already_finalized, true);
  assert.equal(retry.json.summary_id, first.json.summary_id);
  assert.equal(Number(store.db.get("SELECT COUNT(*) AS n FROM observations WHERE type = 'session_summary'").n), 1);

  await run('mem_session_end', { id: 's2', summary: 'cerrada aparte' });
  const late = await run('mem_session_finalize', { session_id: 's2', summary: 'tarde' });
  assert.equal(late.json.error_code, 'session_already_ended');
  assert.equal(late.json.session_id, 's2');
});

test('mem_session_finalize respeta el dueño de la sesión', async (t) => {
  const { run, store } = setup(t);
  await run('mem_session_start', { id: 's3' });
  store.db.run("UPDATE sessions SET project = 'ajeno', ownership_mode = 'project_owned' WHERE id = 's3'");
  const explicit = await run('mem_session_finalize', { session_id: 's3', summary: 'x', project: 'mi-repo' });
  assert.equal(explicit.json.error_code, 'session_project_mismatch');
  assert.equal(explicit.json.message, 'Session "s3" belongs to project "ajeno", but request targeted "mi-repo"');
  // sin proyecto explícito manda el de la sesión
  const implicit = await run('mem_session_finalize', { session_id: 's3', summary: 'x' });
  assert.equal(implicit.isError, false);
  assert.equal(implicit.json.project, 'ajeno');
  assert.equal(implicit.json.project_source, 'session');

  // una sesión compartida admite otro proyecto, pero el almacén rechaza cerrar la de otro dueño
  await run('mem_session_start', { id: 's5' });
  const shared = await run('mem_session_finalize', { session_id: 's5', summary: 'x', project: 'otro' });
  assert.equal(shared.json.error_code, 'session_project_mismatch');
  assert.equal(shared.json.session_id, 's5');
});
