import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getObservation, saveRelation } from '../../../src/store/index.js';
import { httpWorld } from './helpers.js';

const ok = (r, status = 200) => {
  assert.equal(r.status, status, r.text);
  return r.json;
};

test('salud, 404, 405 y redirección de rutas no limpias', async (t) => {
  const w = await httpWorld(t);
  const health = ok(await w.call('GET', '/health'));
  assert.equal(health.status, 'ok');
  assert.equal(health.service, 'odin-memory');
  assert.equal(health.instance_id, w.store.instanceId);
  assert.deepEqual(health.capabilities, { isolated_session_registration: true, root_session_resume: true, runtime_session_resolution: true });
  const missing = await w.call('GET', '/no-existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.text, '404 page not found\n');
  assert.match(missing.headers.get('content-type'), /^text\/plain/);
  const wrongMethod = await w.call('POST', '/health');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD');
  assert.equal(wrongMethod.text, 'Method Not Allowed\n');
  const redirect = await w.call('GET', '/sessions//recent?limit=2');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), '/sessions/recent?limit=2');
  const head = await fetch(`${w.base}/health`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('las respuestas JSON escapan HTML y terminan en salto de línea', async (t) => {
  const w = await httpWorld(t);
  await w.call('POST', '/sessions', { id: 's1', project: 'demo', directory: w.repo });
  const saved = await w.call('POST', '/observations', { session_id: 's1', title: 'a<b>&c', content: 'x<y', project: 'demo' });
  assert.equal(saved.status, 201);
  const got = await w.call('GET', `/observations/${saved.json.id}`);
  assert.ok(got.text.endsWith('\n'));
  assert.ok(got.text.includes('a\\u003cb\\u003e\\u0026c'));
  assert.equal(got.headers.get('content-type'), 'application/json');
});

test('sesiones: registro, resume, aislamiento, lectura, cierre y borrado', async (t) => {
  const w = await httpWorld(t);
  assert.deepEqual(ok(await w.call('POST', '/sessions', { id: 'a', project: 'demo', directory: w.repo }), 201), { id: 'a', status: 'created' });
  assert.equal(w.writes.length, 1);
  assert.deepEqual(ok(await w.call('POST', '/sessions', { id: 'a', project: 'otro', directory: w.repo }), 201), { id: 'a', status: 'created' }, 'una sesión compartida admite otro proyecto');
  ok(await w.call('POST', '/sessions', { id: 'p', project: 'demo', directory: w.repo, ownership_mode: 'project_owned' }), 201);
  const conflict = await w.call('POST', '/sessions', { id: 'p', project: 'otro', directory: w.repo, ownership_mode: 'project_owned' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'session_project_conflict');
  assert.equal(conflict.json.session_id, 'p');
  assert.equal(conflict.json.owner_project, 'demo');
  assert.equal(conflict.json.requested_project, 'otro');
  assert.equal((await w.call('POST', '/sessions', { project: 'demo' })).json.error, 'id and project are required');
  assert.equal((await w.call('POST', '/sessions', { id: 'd', project: 'demo', ownership_mode: 'raro' })).json.error, 'invalid session ownership mode "raro"');
  assert.equal((await w.call('POST', '/sessions', { id: 'f', project: 'demo', isolated: true })).json.error, 'isolated registration requires project_owned ownership and an empty directory');
  assert.equal((await w.call('POST', '/sessions', { id: 'i', project: 'demo', project_provenance: { source: 'inventada' } })).status, 400);
  assert.equal((await w.call('POST', '/sessions', 'esto no es json')).json.error, "invalid json: invalid character 'e' looking for beginning of value");

  ok(await w.call('POST', '/sessions', { id: 'j', project: 'demo', project_provenance: { source: 'explicit_override', raw_project: 'Demo' } }), 201);
  const session = ok(await w.call('GET', '/sessions/j'));
  assert.equal(session.project, 'demo');
  assert.deepEqual(session.project_provenance, { source: 'explicit_override', raw_project: 'Demo' });
  assert.equal('summary' in session, false);
  assert.equal((await w.call('GET', '/sessions/nada')).json.error, 'session not found');

  assert.deepEqual(ok(await w.call('POST', '/sessions/a/end', { summary: 'listo' })), { id: 'a', status: 'completed' });
  assert.equal(ok(await w.call('GET', '/sessions/a')).summary, 'listo');
  const resumed = ok(await w.call('POST', '/sessions', { id: 'a', project: 'demo', directory: w.repo, resume: true }), 201);
  assert.equal(resumed.resumed_from, 'a');
  assert.notEqual(resumed.id, 'a');
  assert.equal((await w.call('POST', '/sessions', { id: 'a', project: 'demo', directory: w.repo })).json.code, 'session_already_ended');

  const recent = ok(await w.call('GET', '/sessions/recent?project=demo&limit=1'));
  assert.equal(recent.length, 1);
  assert.deepEqual(Object.keys(recent[0]), ['id', 'project', 'started_at', 'observation_count']);
  assert.equal((await w.call('GET', '/sessions/recent?project=nada')).json.code, 'unknown_project');

  assert.deepEqual(ok(await w.call('DELETE', '/sessions/j')), { id: 'j', status: 'deleted' });
  assert.equal((await w.call('DELETE', '/sessions/j')).status, 404);
});

test('observaciones: guardar, leer, actualizar, fijar, borrar', async (t) => {
  const w = await httpWorld(t);
  const [cache, bug] = await w.seed();
  const obs = ok(await w.call('GET', `/observations/${cache}`));
  assert.equal(obs.title, 'Decisión de caché');
  assert.equal('pinned' in obs, false);
  assert.equal((await w.call('GET', '/observations/999')).json.error, 'observation not found');
  assert.equal((await w.call('GET', '/observations/abc')).json.error, 'invalid observation id');

  assert.equal((await w.call('PATCH', `/observations/${cache}?expected_project=demo`, {})).json.error, 'at least one field is required');
  assert.equal((await w.call('PATCH', `/observations/${cache}`, { title: 'x' })).status, 400);
  assert.equal((await w.call('PATCH', `/observations/${cache}?expected_project=otro`, { title: 'x' })).status, 409);
  const updated = ok(await w.call('PATCH', `/observations/${cache}?expected_project=demo`, { find: 'Redis', replace: 'Valkey' }));
  assert.equal(updated.content, 'usamos Valkey como caché distribuida');
  const history = ok(await w.call('GET', `/observations/${cache}?include_history=true`));
  assert.equal(history.version_count, 1);
  assert.equal(history.history[0].content, 'usamos Redis como caché distribuida');
  assert.equal((await w.call('GET', `/observations/${cache}?include_history=true&history_cursor=-1`)).json.error, 'history_cursor must be a non-negative integer');
  assert.equal((await w.call('GET', `/observations/${cache}?include_history=true&history_cursor=1.5`)).status, 400);
  assert.equal((await w.call('GET', `/observations/${cache}?include_history=true&history_cursor=null`)).status, 400);

  assert.deepEqual(ok(await w.call('PUT', `/observations/${bug}/pin`)), { id: bug, pinned: true });
  assert.deepEqual(ok(await w.call('DELETE', `/observations/${bug}/pin`)), { id: bug, pinned: false });
  assert.equal((await w.call('PUT', '/observations/999/pin')).status, 404);
  assert.equal((await w.call('PUT', '/observations/0/pin')).status, 400);

  const listed = ok(await w.call('GET', '/observations?project=demo&limit=2'));
  assert.equal(listed.length, 2);
  assert.equal((await w.call('GET', '/observations?project=demo&sort=otro')).json.error, 'unsupported sort: use created_at:desc');
  assert.equal(ok(await w.call('GET', '/observations/recent?project=demo&scope=personal')).length, 0);

  assert.equal((await w.call('DELETE', `/observations/${bug}`)).status, 400);
  assert.deepEqual(ok(await w.call('DELETE', `/observations/${bug}?expected_project=demo`)), { id: bug, status: 'deleted', hard_delete: false });
  assert.equal((await w.call('DELETE', `/observations/${bug}?expected_project=demo`)).status, 404);
});

test('guardado: operación idempotente, captura de prompt, validaciones y pasiva', async (t) => {
  const w = await httpWorld(t);
  await w.call('POST', '/sessions', { id: 's1', project: 'demo', directory: w.repo });
  const body = { session_id: 's1', title: 'Con operación', content: 'contenido', project: 'demo', operation_id: 'op-1', current_prompt: 'qué hacemos con la caché' };
  const first = ok(await w.call('POST', '/observations', body), 201);
  const writes = w.writes.length;
  const replay = ok(await w.call('POST', '/observations', body), 201);
  assert.equal(replay.id, first.id);
  assert.equal(w.writes.length, writes, 'una repetición no avisa de escritura');
  assert.equal((await w.call('POST', '/observations', { ...body, content: 'otro' })).status, 409);
  assert.deepEqual(ok(await w.call('GET', '/observations/save-result?operation_id=op-1')), { id: first.id, status: 'committed' });
  assert.equal((await w.call('GET', '/observations/save-result?operation_id=op-2')).json.code, 'observation_save_result_not_found');
  assert.equal((await w.call('GET', '/observations/save-result')).json.error, 'operation_id is required');
  const prompts = ok(await w.call('GET', '/prompts/recent?project=demo'));
  assert.deepEqual(prompts.map((p) => p.content), ['qué hacemos con la caché']);
  await w.call('POST', '/observations', { session_id: 's1', title: 'Sin prompt', content: 'otro contenido', project: 'demo', current_prompt: 'ignorado', capture_prompt: false });
  assert.equal(ok(await w.call('GET', '/prompts/recent?project=demo')).length, 1);

  assert.equal((await w.call('POST', '/observations', { session_id: 's1', title: '   ', content: 'x', project: 'demo' })).status, 400);
  assert.equal((await w.call('POST', '/observations', { session_id: 's1', title: 'x', content: '', project: 'demo' })).json.error, 'session_id and content are required');
  assert.equal((await w.call('POST', '/observations', { session_id: 'nueva', title: 'x', content: 'y', project: 'demo' })).status, 404);
  const mismatch = await w.call('POST', '/observations', { session_id: 's1', title: 'x', content: 'y', project: 'otro' });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.code, 'session_project_mismatch');
  assert.equal(mismatch.json.session_project, 'demo');

  const privado = ok(await w.call('POST', '/observations', { session_id: 's1', title: 'Privado', content: 'público <private>secreto</private> fin', project: 'demo' }), 201);
  assert.equal(ok(await w.call('GET', `/observations/${privado.id}`)).content, 'público [REDACTED] fin');

  const passive = ok(await w.call('POST', '/observations/passive', { session_id: 's1', project: 'demo', content: '## Key Learnings:\n- aprendimos algo útil sobre la caché de Redis\n- otra cosa distinta para recordar' }));
  assert.deepEqual(passive, { extracted: 2, saved: 2, duplicates: 0 });
  assert.equal((await w.call('POST', '/observations/passive', { project: 'demo', content: 'x' })).json.error, 'session_id is required');
});

test('búsqueda, línea de tiempo, revisión y clave de tema', async (t) => {
  const w = await httpWorld(t);
  const [cache] = await w.seed();
  const found = ok(await w.call('GET', '/search?q=Redis&project=demo'));
  assert.deepEqual(found.map((r) => r.title).sort(), ['Decisión de caché', 'Nota suelta']);
  assert.equal(typeof found[0].rank, 'number');
  const compact = ok(await w.call('GET', '/search?q=Redis&project=demo&response_format=compact'));
  assert.equal(compact.result, 'Found 2 memories.');
  assert.equal(compact.results[0].state, 'active');
  assert.equal(ok(await w.call('GET', '/search?q=inexistente&project=demo&response_format=compact')).result, 'No memories found for: "inexistente"');
  assert.equal((await w.call('GET', '/search?project=demo')).json.error, 'q parameter is required');
  assert.equal((await w.call('GET', '/search?q=x&project=demo&match_mode=raro')).json.error, 'invalid match_mode "raro": must be "all" or "any"');
  assert.equal((await w.call('GET', '/search?q=x&project=demo&response_format=largo')).status, 400);

  const line = ok(await w.call('GET', `/timeline?observation_id=${cache}&project=demo`));
  assert.equal(line.focus.id, cache);
  assert.equal(line.after.length, 2);
  assert.equal(line.before, null, 'sin entradas anteriores la lista es null');
  assert.equal(line.session_info.id, 's1');
  assert.equal((await w.call('GET', `/timeline?observation_id=${cache}&project=otro`)).status, 404);
  assert.equal((await w.call('GET', '/timeline?project=demo')).json.error, 'observation_id parameter is required');
  assert.equal((await w.call('GET', '/timeline?observation_id=x&project=demo')).json.error, 'invalid observation_id');

  assert.deepEqual(ok(await w.call('GET', '/review?project=demo')), { observations: [], count: 0 });
  const marked = ok(await w.call('POST', '/review/mark_reviewed?project=demo', { observation_id: cache }));
  assert.equal(marked.id, cache);
  assert.equal(marked.state, 'active');
  assert.equal((await w.call('POST', '/review/mark_reviewed?project=demo', {})).json.error, 'observation_id is required');
  assert.equal((await w.call('POST', '/review/mark_reviewed?project=demo', { observation_id: 999 })).json.error, 'observation not found in resolved project');

  assert.equal(ok(await w.call('POST', '/topic-keys/suggest', { type: 'decision', title: 'Auth model' })).topic_key, 'decision/auth-model');
  assert.equal((await w.call('POST', '/topic-keys/suggest', { title: ' ' })).json.error, 'provide title or content to suggest a topic_key');
  assert.equal((await w.call('POST', '/topic-keys/suggest', '{"title":"a"}{"title":"b"}')).json.error, 'invalid json: trailing data');
});

test('prompts: alta, búsqueda, bandeja idempotente y borrado', async (t) => {
  const w = await httpWorld(t);
  await w.call('POST', '/sessions', { id: 's1', project: 'demo', directory: w.repo });
  const first = ok(await w.call('POST', '/prompts', { session_id: 's1', content: 'primer prompt sobre Redis' }), 201);
  assert.equal(ok(await w.call('GET', '/prompts/recent?project=demo'))[0].project, 'demo', 'el prompt hereda el proyecto de su sesión');
  const inbox = { session_id: 's1', content: 'con bandeja', source_inbox_id: 'inbox-1' };
  const a = ok(await w.call('POST', '/prompts', inbox), 201);
  const writes = w.writes.length;
  const b = ok(await w.call('POST', '/prompts', inbox), 201);
  assert.equal(b.id, a.id);
  assert.equal(w.writes.length, writes);
  assert.equal(ok(await w.call('GET', '/prompts/search?q=Redis&project=demo')).length, 1);
  assert.equal((await w.call('GET', '/prompts/search?project=demo')).json.error, 'q parameter is required');
  assert.equal((await w.call('POST', '/prompts', { session_id: 's1', content: '' })).json.error, 'session_id and content are required');
  assert.equal((await w.call('POST', '/prompts', { session_id: 'nueva', content: 'x', project: 'demo' })).status, 404);
  assert.deepEqual(ok(await w.call('DELETE', `/prompts/${first.id}`)), { id: first.id, status: 'deleted' });
  assert.equal((await w.call('DELETE', `/prompts/${first.id}`)).status, 404);
  assert.equal((await w.call('DELETE', '/prompts/abc')).json.error, 'invalid prompt id');
});

test('contexto, compactación, estadísticas, proyectos y proyecto actual', async (t) => {
  const w = await httpWorld(t);
  await w.seed();
  const context = ok(await w.call('GET', '/context?project=demo')).context;
  assert.match(context, /## Memory from Previous Sessions/);
  assert.match(context, /Decisión de caché/);
  assert.equal(ok(await w.call('GET', '/context?project=demo&observations=-1&sessions=-1&prompts=-1&pinned=-1')).context, '');
  assert.ok(ok(await w.call('GET', '/context?project=demo&max_bytes=10')).context.length <= 10 + 200);
  assert.equal((await w.call('GET', '/context?project=nada')).status, 404);
  assert.match(ok(await w.call('GET', '/context/compaction?session_id=s1')).context, /s1/);
  assert.equal((await w.call('GET', '/context/compaction?session_id=nada')).json.error, 'session not found');
  assert.equal((await w.call('GET', '/context/compaction')).json.error, 'session_id is required');

  const stats = ok(await w.call('GET', '/stats?project=demo'));
  assert.equal(stats.total_observations, 3);
  assert.deepEqual(stats.projects, ['demo']);
  assert.equal(ok(await w.call('GET', '/stats?all_projects=true')).total_sessions, 1);
  assert.equal((await w.call('GET', '/stats?project=nada')).json.code, 'unknown_project');
  assert.equal((await w.call('GET', '/stats?project=')).json.code, 'invalid_project');

  const projects = ok(await w.call('GET', '/projects'));
  assert.equal(projects.count, 1);
  assert.equal(projects.projects[0].name, 'demo');

  // Un directorio sin historial se resuelve por git.
  const fresh = join(w.root, 'otro-repo');
  mkdirSync(fresh);
  execFileSync('git', ['init', '-q', fresh]);
  const current = ok(await w.call('GET', `/project/current?cwd=${encodeURIComponent(fresh)}`));
  assert.equal(current.project, 'otro-repo');
  assert.equal(current.cwd, fresh);
  assert.equal(current.project_source, 'git_root');
  // El directorio del servidor tiene historial bajo otro proyecto: sin elegir uno explícito hay conflicto de transición.
  const transition = await w.call('GET', '/project/current');
  assert.equal(transition.status, 409);
  assert.equal(transition.json.code, 'project_transition_conflict');
  assert.equal(transition.json.candidate_project, 'mi-repo');
});

test('exportar e importar viajan entre almacenes', async (t) => {
  const w = await httpWorld(t);
  await w.seed();
  const exported = await w.call('GET', '/export?project=demo');
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('content-disposition'), 'attachment; filename=odin-export.json');
  assert.equal(exported.json.observations.length, 3);
  const other = await httpWorld(t);
  const imported = ok(await other.call('POST', '/import', exported.text));
  assert.equal(imported.observations_imported, 3);
  assert.equal(ok(await other.call('GET', '/stats?project=demo')).total_observations, 3);
  assert.equal((await other.call('POST', '/import', 'no json')).status, 400);
  assert.equal((await other.call('POST', '/import', '')).json.error, 'invalid json: unexpected end of JSON input');
  assert.equal((await other.call('POST', '/import', '{"sessions":"mal"}')).status, 400);
});

test('flujos compuestos: finalizar, consolidar, juzgar y comparar', async (t) => {
  const w = await httpWorld(t);
  const [cache, bug, nota] = await w.seed();
  const finalized = ok(await w.call('POST', '/sessions/s1/finalize', { project: 'demo', summary: 'resumen de cierre' }));
  assert.equal(finalized.state, 'finalized');
  assert.equal(finalized.already_finalized, false);
  assert.equal(ok(await w.call('POST', '/sessions/s1/finalize', { project: 'demo', summary: 'resumen de cierre' })).state, 'already_finalized');
  assert.equal((await w.call('POST', '/sessions/nada/finalize', { project: 'demo', summary: 'x' })).json.code, 'unknown_session');
  assert.equal((await w.call('POST', '/sessions/s1/finalize', { project: 'otro', summary: 'x' })).json.code, 'session_project_mismatch');
  assert.equal((await w.call('POST', '/sessions/s1/finalize', { project: 'demo' })).json.code, 'invalid_arguments');
  assert.equal((await w.call('POST', '/sessions/s1/finalize', { project: 'demo', summary: 'x', extra: 1 })).json.error, 'unsupported argument extra');
  assert.equal((await w.call('POST', '/sessions/s1/finalize', '[]')).json.error, 'body must be a JSON object');
  assert.equal((await w.call('POST', '/sessions/s1/finalize', '{"project":"demo","summary":"x"}{}')).json.error, 'body must contain exactly one JSON object');
  assert.equal((await w.call('POST', '/sessions/s1/finalize', 'x'.repeat((1 << 20) + 1))).status, 413);

  const plan = { ids_to_delete: [bug, nota], new_title: 'Consolidado', new_content: 'contenido unido', expected_project: 'demo' };
  const preview = ok(await w.call('POST', '/observations/consolidate', plan));
  assert.equal(preview.status, 'preview');
  assert.deepEqual(preview.plan.source_ids, [bug, nota]);
  assert.equal((await w.call('POST', '/observations/consolidate', { ...plan, ids_to_delete: [bug] })).json.code, 'invalid_arguments');
  assert.equal((await w.call('POST', '/observations/consolidate', { ...plan, ids_to_delete: [bug, 999] })).json.code, 'consolidation_refused');
  assert.equal((await w.call('POST', '/observations/consolidate', { ...plan, expected_project: 'otro' })).json.code, 'project_mismatch');
  assert.equal((await w.call('POST', '/observations/consolidate', { ...plan, confirm: true, fingerprint: 'mala' })).json.code, 'fingerprint_mismatch');
  const done = ok(await w.call('POST', '/observations/consolidate', { ...plan, confirm: true, fingerprint: preview.plan.fingerprint }), 201);
  assert.equal(done.status, 'consolidated');
  assert.deepEqual(done.soft_deleted_ids, [bug, nota]);
  assert.equal(done.survivor.title, 'Consolidado');

  // Una relación pendiente entre dos observaciones se lista y se juzga.
  const created = await w.call('POST', '/observations', { session_id: 's1', type: 'decision', title: 'Usar Redis para la caché', content: 'decisión sobre Redis', project: 'demo' });
  assert.equal(created.status, 201);
  const syncOf = (id) => getObservation(w.store, id).sync_id;
  saveRelation(w.store, { sync_id: 'rel-0000000000000001', source_id: syncOf(cache), target_id: syncOf(created.json.id) });
  const conflicts = ok(await w.call('GET', '/conflicts?project=demo'));
  assert.ok(conflicts.total >= 1);
  assert.equal(conflicts.limit, 50);
  const relation = conflicts.relations[0];
  const detail = ok(await w.call('GET', `/conflicts/${relation.id}`));
  assert.equal(detail.relation_id, relation.id);
  assert.equal((await w.call('GET', '/conflicts/999999')).status, 404);
  assert.equal((await w.call('GET', '/conflicts/abc')).json.error, 'invalid relation_id: must be an integer');
  assert.equal((await w.call('GET', '/conflicts?project=demo&since=ayer')).json.error, 'invalid since parameter: must be RFC3339');

  const judged = ok(await w.call('POST', '/conflicts/judge', { judgment_id: detail.sync_id, relation: 'related', reason: 'mismo tema', confidence: 0.8 }));
  assert.equal(judged.relation.judgment_status, 'judged');
  assert.equal((await w.call('POST', '/conflicts/judge', { judgment_id: 'x', relation: 'related', confidence: 2 })).json.error, 'confidence must be between 0.0 and 1.0');
  assert.equal((await w.call('POST', '/conflicts/judge', { relation: 'related' })).json.error, 'judgment_id is required');
  const many = ok(await w.call('POST', '/conflicts/judge-many', {
    judgments: [{ judgment_id: detail.sync_id, relation: 'compatible' }, { judgment_id: 5 }, 'mal', { judgment_id: 'rel-nada', relation: 'related' }, { judgment_id: detail.sync_id, relation: 'rara' }],
  }));
  assert.deepEqual(many.outcomes.map((o) => o.status), ['success', 'error', 'error', 'error', 'error']);
  assert.equal(many.outcomes[1].error, 'judgment_id must be a string');
  assert.equal(many.outcomes[3].error, 'JudgeRelation: relation "rel-nada" not found');
  assert.match(many.outcomes[4].error, /^JudgeRelation: invalid relation verb "rara"/);
  assert.equal((await w.call('POST', '/conflicts/judge-many', { judgments: [] })).json.error, 'judgments must be an array containing 1..32 items');
  const compared = ok(await w.call('POST', '/conflicts/compare', { memory_id_a: cache, memory_id_b: created.json.id, relation: 'related', confidence: 0.9, reasoning: 'parecidas', model: 'm' }));
  assert.match(compared.sync_id, /^rel-/);
  assert.equal((await w.call('POST', '/conflicts/compare', { memory_id_a: cache, memory_id_b: 999, relation: 'related', confidence: 0.9, reasoning: 'x' })).status, 404);
  assert.equal((await w.call('POST', '/conflicts/compare', { memory_id_a: cache, memory_id_b: created.json.id, relation: 'related', reasoning: 'x' })).json.error, 'confidence is required');
});

test('sesiones de runtime: resolver y cerrar', async (t) => {
  const w = await httpWorld(t);
  await w.call('POST', '/sessions', { id: 'raiz', project: 'demo', directory: w.repo });
  const body = { id: 'raiz', project: 'demo', directory: w.repo };
  assert.deepEqual(ok(await w.call('POST', '/runtime-sessions/resolve', body)), { id: 'raiz', status: 'resolved' });
  assert.equal((await w.call('POST', '/runtime-sessions/resolve', { ...body, id: 'nada' })).json.error, 'sql: no rows in result set');
  assert.equal((await w.call('POST', '/runtime-sessions/resolve', { ...body, directory: '/otro/directorio' })).status, 409);
  assert.equal((await w.call('POST', '/runtime-sessions/resolve', { ...body, extra: 1 })).status, 400);
  assert.equal((await w.call('POST', '/runtime-sessions/resolve', { id: 'raiz', project: 'demo' })).status, 400);
  assert.equal((await w.call('POST', '/runtime-sessions/resolve', { ...body, ownership_mode: 'raro' })).json.error, 'invalid ownership_mode');
  const before = w.writes.length;
  assert.deepEqual(ok(await w.call('POST', '/runtime-sessions/end', { ...body, summary: 'fin' })), { id: 'raiz', status: 'ended' });
  assert.equal(w.writes.length, before + 1);
});

test('decisión de captura de prompt', async (t) => {
  const w = await httpWorld(t);
  const decide = (body) => w.call('POST', '/prompts/capture-decision', body);
  assert.deepEqual(ok(await decide({ source: 'copilot', cwd: w.repo, content: '   ' })), { decision: 'skip' });
  const capture = ok(await decide({ source: 'copilot', cwd: w.repo, content: 'haz algo' }));
  assert.equal(capture.decision, 'capture');
  assert.equal(capture.project, 'mi-repo');
  assert.equal((await decide({ source: 'otro', cwd: w.repo, content: 'x' })).status, 400);
  assert.equal((await decide({ source: 'copilot', cwd: ' ', content: 'x' })).status, 400);
  assert.equal((await decide({ source: 'copilot', cwd: w.repo })).status, 400);
  assert.equal((await decide({ source: 'copilot', cwd: w.repo, content: 'x', extra: 1 })).json.error, 'invalid json');
  assert.equal(ok(await w.call('GET', '/projects')).count, 0, 'no persiste nada');
});

test('contrato de runtime: estable, con digest y sin depender del almacén', async (t) => {
  const { runtimeContractProjection } = await import('../../../src/server/index.js');
  const w = await httpWorld(t);
  const contract = ok(await w.call('GET', '/runtime-contract'));
  const projection = runtimeContractProjection();
  assert.equal(contract.contract_id, 'odin-memory.http-runtime/v1');
  assert.equal(contract.digest, projection.digest);
  assert.match(contract.digest, /^[0-9a-f]{64}$/);
  assert.equal(contract.instance_id, w.store.instanceId);
  assert.deepEqual(contract.operations.mem_save.bindings.map((b) => `${b.method} ${b.path}`), ['POST /observations', 'GET /observations/save-result']);
  assert.equal(contract.operations.mem_consolidate.bindings[0].configured_auth, true);
  assert.deepEqual(Object.keys(contract.supporting_routes).sort(), ['compaction-context', 'prompt-capture-decision', 'runtime-session-end', 'runtime-session-resolve']);
  assert.equal(runtimeContractProjection().digest, projection.digest);
});

test('estado de sincronización sin nube configurada', async (t) => {
  const w = await httpWorld(t);
  await w.seed();
  const status = ok(await w.call('GET', '/sync/status?project=demo'));
  assert.equal(status.enabled, false);
  assert.equal(status.reason_code, 'blocked_unenrolled');
  assert.equal(status.reason_message, 'project "demo" is not enrolled for cloud sync');
  assert.equal(status.phase, 'idle');
  assert.deepEqual(status.upgrade, { stage: '', reason_code: '', reason_message: '' });
  w.store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('demo')");
  assert.equal(ok(await w.call('GET', '/sync/status?project=demo')).reason_code, 'cloud_not_configured');
  assert.equal((await w.call('GET', '/sync/status?all_projects=true')).json.code, 'unsupported_project_scope');
});
