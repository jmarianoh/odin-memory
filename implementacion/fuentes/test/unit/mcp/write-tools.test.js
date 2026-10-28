import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '../../../src/mcp/server.js';
import { publish } from '../../../src/hostbind/index.js';
import { captureProjectProvenance, createSession, getSession, startSession } from '../../../src/store/index.js';
import { initRepo, tempDir as repoTempDir } from '../project/helpers.js';
import { openTempStore } from '../store/helpers.js';

/** Servidor sobre un directorio de trabajo simulado. */
function setup(t, { dir, config = {}, options = {} } = {}) {
  const store = openTempStore(t);
  const root = repoTempDir(t);
  const cwd = dir ?? initRepo(join(root, 'mi-repo'));
  const server = createServer(store, config, null, { env: {}, cwd: () => cwd, ...options });
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
  return { store, server, run, cwd, root };
}

test('mem_save guarda en el proyecto del repositorio y devuelve el envelope con el estado', async (t) => {
  const { store, run } = setup(t);
  const r = await run('mem_save', { title: 'Arquitectura hexagonal', content: 'puertos y adaptadores', type: 'architecture' });
  assert.equal(r.isError, false);
  assert.equal(r.json.project, 'mi-repo');
  assert.equal(r.json.project_source, 'git_root');
  assert.match(r.json.result, /^Memory saved: "Arquitectura hexagonal" \(architecture\)\nSuggested topic_key: architecture\/arquitectura-hexagonal$/);
  assert.equal(r.json.id, 1);
  assert.match(r.json.sync_id, /^obs-[0-9a-f]{16}$/);
  assert.equal(r.json.state, 'active');
  assert.equal(typeof r.json.review_after, 'string'); // los tipos con caducidad la fijan
  assert.deepEqual(r.json.truncation, { original_bytes: 21, limit_bytes: 50000, truncated: false });
  assert.equal(r.json.judgment_required, false);
  const row = store.db.get('SELECT project, session_id, type, scope FROM observations WHERE id = 1');
  assert.equal(row.project, 'mi-repo');
  assert.equal(row.session_id, 'manual-save-mi-repo');
  // la sesión de reserva y la observación conservan la evidencia de cómo se resolvió el proyecto
  assert.equal(captureProjectProvenance(store, 'observation', 1).source, 'git_root');
  assert.equal(captureProjectProvenance(store, 'session', 'manual-save-mi-repo').source, 'git_root');
});

test('mem_save: tipo por defecto, alias observation, tema, duplicados y validaciones', async (t) => {
  const { store, run } = setup(t);
  const alias = await run('mem_save', { title: 'Alias', observation: 'contenido antiguo' });
  assert.match(alias.json.result, /^Memory saved: "Alias" \(manual\)/);
  assert.equal(store.db.get('SELECT content FROM observations WHERE id = 1').content, 'contenido antiguo');

  const first = await run('mem_save', { title: 'Caché', content: 'Redis', type: 'decision', topic_key: 'decision/cache' });
  assert.ok(!first.json.result.includes('Suggested topic_key')); // ya trae uno
  const again = await run('mem_save', { title: 'Caché', content: 'Memcached', type: 'decision', topic_key: 'decision/cache' });
  assert.equal(again.json.id, first.json.id);
  assert.equal(Number(store.db.get('SELECT revision_count FROM observations WHERE id = ?', first.json.id).revision_count), 2);

  assert.equal((await run('mem_save', { title: 'x', content: '   ' })).text, 'content is required for mem_save (use content, or observation for backward-compatible clients)');
  assert.equal((await run('mem_save', { title: '  ', content: 'algo' })).text, 'Failed to save: observation title is required');
  assert.equal((await run('mem_save', { title: 'x', content: 'y', capture_prompt: 'si' })).text, 'capture_prompt must be a boolean');
  assert.equal(Number(store.db.get('SELECT COUNT(*) AS n FROM sessions').n), 1); // los rechazos no dejan sesiones
});

test('mem_save avisa de truncamiento, ruta absoluta, nombre normalizado y proyecto parecido', async (t) => {
  const { run, store } = setup(t);
  const big = await run('mem_save', { title: 'Enorme', content: 'p'.repeat(50010) });
  assert.match(big.json.result, /⚠ WARNING: Content was truncated from 50010 to 50000 bytes/);
  assert.deepEqual(big.json.truncation, { original_bytes: 50010, limit_bytes: 50000, truncated: true });
  const path = await run('mem_save', { title: 'Ruta', content: 'edita /Users/alguien/proyecto/main.go' });
  assert.match(path.json.result, /absolute filesystem path/);
  assert.ok(!(await run('mem_save', { title: 'Relativa', content: 'edita src/main.go' })).json.result.includes('absolute'));
  assert.match((await run('mem_save', { title: 'Privado', content: 'clave <private>abc</private>' })).json.result, /^Memory saved/);
  assert.equal(store.db.get("SELECT content FROM observations WHERE title = 'Privado'").content, 'clave [REDACTED]');

  // proyecto nuevo con un nombre parecido a uno que ya tiene memorias
  const other = initRepo(join(repoTempDir(t), 'mi-repos'));
  assert.equal((await run('mem_session_start', { id: 'otra', directory: other })).isError, false);
  const similar = await run('mem_save', { title: 'Nuevo', content: 'primer guardado', session_id: 'otra' });
  assert.match(similar.json.result, /\n⚠️ Project "mi-repos" has no memories\. Similar project found: "mi-repo" \(\d+ memories\)\. Consider using that name instead\.$/);
});

test('mem_save ofrece candidatos de conflicto y mem_judge los cierra', async (t) => {
  const { run } = setup(t);
  await run('mem_save', { title: 'Decisión de caché', content: 'usamos Redis como caché distribuida', type: 'decision' });
  const second = await run('mem_save', { title: 'Decisión de caché con Redis', content: 'Redis guarda las sesiones', type: 'decision' });
  assert.equal(second.json.judgment_required, true);
  assert.equal(second.json.judgment_status, 'pending');
  assert.equal(second.json.candidates.length, 1);
  const [candidate] = second.json.candidates;
  assert.equal(candidate.id, 1);
  assert.equal(candidate.judgment_id, second.json.judgment_id);
  assert.match(candidate.judgment_id, /^rel-[0-9a-f]{16}$/);
  assert.equal(typeof candidate.score, 'number');
  assert.match(second.json.result, /\nCONFLICT REVIEW PENDING — 1 candidate\(s\); use mem_judge to record verdicts\.$/);
});

test('un proyecto explícito solo se admite si existe o coincide con la configuración', async (t) => {
  const { run } = setup(t);
  await run('mem_save', { title: 'Uno', content: 'primero' });
  const unknown = await run('mem_save', { title: 'x', content: 'y', project: 'otro' });
  assert.equal(unknown.json.error_code, 'unknown_project');
  assert.deepEqual(unknown.json.available_projects, ['mi-repo']);
  assert.equal(unknown.json.message, 'Project "otro" is not backed by known context. Use an existing project, a matching session, repo .odin-memory/config.json, or ambiguous-project recovery.');
  const same = await run('mem_save', { title: 'Explícito', content: 'mismo proyecto', project: 'mi-repo' });
  assert.equal(same.json.project_source, 'explicit_override');
  assert.equal((await run('mem_save', { title: 'x', content: 'y', project: '  ' })).json.error_code, 'invalid_project');
  assert.equal((await run('mem_save', { title: 'x', content: 'y', project: 'a/b' })).json.message, 'Project "a/b" is invalid: project must be a name, not a path');
  const collision = await run('mem_save', { title: 'x', content: 'y', project: 'mi--repo' });
  assert.equal(collision.json.error_code, 'project_name_collision');
  assert.deepEqual(collision.json.available_projects, null);
});

test('la configuración del repositorio fija el proyecto y admite su nombre explícito', async (t) => {
  const root = repoTempDir(t);
  const repo = initRepo(join(root, 'repo'));
  mkdirSync(join(repo, '.odin-memory'));
  writeFileSync(join(repo, '.odin-memory', 'config.json'), '{"project_name":"Nombre-Config"}');
  const { run } = setup(t, { dir: repo });
  const saved = await run('mem_save', { title: 'Uno', content: 'primero' });
  assert.equal(saved.json.project, 'nombre-config');
  assert.equal(saved.json.project_source, 'config');
  const other = await run('mem_save', { title: 'x', content: 'y', project: 'otro' });
  assert.equal(other.json.error_code, 'unknown_project');
});

test('proyecto fijado para el proceso: lo usan las escrituras sin sesión y se ignora si hay sesión', async (t) => {
  const { run, store } = setup(t, { config: { defaultProject: 'Fijo' } });
  const saved = await run('mem_save', { title: 'Fijo', content: 'en el proyecto fijado' });
  assert.equal(saved.json.project, 'fijo');
  assert.equal(saved.json.project_source, 'process_override');
  assert.equal(captureProjectProvenance(store, 'observation', saved.json.id).raw_project, 'Fijo');
  const unknownSession = await run('mem_save', { title: 'x', content: 'y', session_id: 'no-existe' });
  assert.equal(unknownSession.json.error_code, 'unknown_session');
  assert.equal(unknownSession.json.retry_without_session_id, true);
});

test('mem_update: campos, buscar y reemplazar, proyecto esperado y errores', async (t) => {
  const { run, store } = setup(t);
  await run('mem_save', { title: 'Uno', content: 'contenido con una palabra clave', type: 'decision' });
  const expected = { expected_project: 'mi-repo' };
  const renamed = await run('mem_update', { id: 1, title: 'Uno bis', ...expected });
  assert.equal(renamed.json.result, 'Memory updated: #1 "Uno bis" (decision, scope=project)');
  assert.equal(renamed.json.project, 'mi-repo');
  assert.equal(renamed.json.project_source, 'explicit_override');
  await run('mem_update', { id: 1, find: 'palabra', replace: 'frase', ...expected });
  assert.equal(store.db.get('SELECT content FROM observations WHERE id = 1').content, 'contenido con una frase clave');
  const long = await run('mem_update', { id: 1, content: 'x'.repeat(50500), ...expected });
  assert.deepEqual(long.json.truncation, { original_bytes: 50500, limit_bytes: 50000, truncated: true });
  assert.match(long.json.result, /truncated from 50500 to 50000/);

  assert.equal((await run('mem_update', { id: 1 })).text, 'expected_project must be a valid non-empty project name');
  assert.equal((await run('mem_update', { title: 'x', ...expected })).text, 'id is required');
  assert.equal((await run('mem_update', { id: 1, ...expected })).text, 'provide at least one field to update');
  assert.equal((await run('mem_update', { id: 1, title: 'x', expected_project: 'otro' })).text, 'Failed to update memory: expected_project does not match observation owner');
  assert.equal((await run('mem_update', { id: 99, title: 'x', ...expected })).text, 'Failed to update memory: observation not found');
  assert.match((await run('mem_update', { id: 1, find: 'a', ...expected })).text, /^Failed to update memory:/);
});

test('mem_delete (suave y duro), mem_pin y mem_unpin', async (t) => {
  const { run, store } = setup(t);
  for (const title of ['Uno', 'Dos']) await run('mem_save', { title, content: `contenido ${title}` });
  const expected = { expected_project: 'mi-repo' };
  assert.equal((await run('mem_delete', { id: 1, ...expected })).text, 'Memory #1 soft-deleted');
  assert.ok(store.db.get('SELECT deleted_at FROM observations WHERE id = 1').deleted_at);
  assert.equal((await run('mem_delete', { id: 2, hard_delete: true, ...expected })).text, 'Memory #2 permanently deleted');
  assert.equal(store.db.get('SELECT id FROM observations WHERE id = 2'), undefined);
  assert.equal((await run('mem_delete', { id: 1 })).text, 'expected_project must be a valid non-empty project name');
  assert.equal((await run('mem_delete', { ...expected })).text, 'id is required');
  assert.match((await run('mem_delete', { id: 99, ...expected })).text, /^Failed to delete memory: observation not found/);

  await run('mem_save', { title: 'Tres', content: 'otra' });
  const pinned = await run('mem_pin', { id: 3 });
  assert.equal(pinned.json.result, 'Memory #3 pinned');
  assert.equal(pinned.json.pinned, true);
  assert.equal((await run('mem_unpin', { id: 3 })).json.pinned, false);
  assert.equal((await run('mem_pin', {})).text, 'id is required');
  assert.match((await run('mem_pin', { id: 99 })).text, /^Failed to update pin state:/);
});

test('mem_review lista las observaciones vencidas y marca como revisadas', async (t) => {
  const { run, store } = setup(t);
  assert.equal((await run('mem_review', { action: 'list' })).json.result, 'No memories need review.');
  for (let i = 1; i <= 7; i++) await run('mem_save', { title: `Revisable ${i}`, content: `contenido ${i}`, type: 'decision' });
  store.db.run("UPDATE observations SET review_after = datetime('2020-01-01 00:00:00', '+' || id || ' days')");
  const list = await run('mem_review', { action: 'list' });
  assert.match(list.json.result, /^Found 7 memories needing review:\n\n\[1\] #1 \(decision\) — Revisable 1\n {4}state: needs_review \| project: mi-repo \| review_after: 2020-01-02 00:00:00\n/);
  assert.equal(list.json.observations.length, 7);
  assert.equal(list.json.project_source, 'all_projects');
  assert.equal((await run('mem_review', { action: 'list', limit: 2 })).json.observations.length, 2);
  assert.equal((await run('mem_review', { action: 'list', project: 'nada' })).json.error_code, 'unknown_project');

  const marked = await run('mem_review', { action: 'mark_reviewed', observation_id: 1 });
  assert.equal(marked.json.result, 'Memory marked reviewed: #1 "Revisable 1" (decision)');
  assert.equal(marked.json.state, 'active');
  assert.equal((await run('mem_review', { action: 'mark_reviewed', id: 2 })).json.id, 2);
  assert.equal((await run('mem_review', { action: 'mark_reviewed' })).text, 'observation_id is required for mark_reviewed');
  assert.equal((await run('mem_review', { action: 'mark_reviewed', observation_id: 99 })).text, 'Failed to mark reviewed: observation not found in resolved project');
  assert.equal((await run('mem_review', { action: 'borrar' })).text, 'action must be one of: list, mark_reviewed');
  assert.equal((await run('mem_review', {})).text, 'action must be one of: list, mark_reviewed');
});

test('prompts: se guardan una vez por sesión y se capturan al guardar con el prompt vigente', async (t) => {
  const { run, store } = setup(t);
  const saved = await run('mem_save_prompt', { content: 'refactoriza el módulo de pagos' });
  assert.equal(saved.json.result, 'Prompt saved: "refactoriza el módulo de pagos"');
  assert.deepEqual(saved.json.truncation, { original_bytes: 31, limit_bytes: 50000, truncated: false });
  assert.equal((await run('mem_save_prompt', { content: '' })).text, 'Failed to save prompt: prompt content is required');
  const long = await run('mem_save_prompt', { content: 'palabra '.repeat(20) });
  assert.equal(long.json.result, `Prompt saved: "${'palabra '.repeat(10).slice(0, 80)}..."`);

  // el prompt vigente se vuelve a guardar junto a la memoria si falta en la base
  store.db.run('DELETE FROM user_prompts');
  await run('mem_save', { title: 'Con prompt', content: 'tras el prompt' });
  assert.equal(Number(store.db.get('SELECT COUNT(*) AS n FROM user_prompts').n), 1);
  store.db.run('DELETE FROM user_prompts');
  await run('mem_save', { title: 'Sin prompt', content: 'no capturar', capture_prompt: false });
  assert.equal(Number(store.db.get('SELECT COUNT(*) AS n FROM user_prompts').n), 0);
});

test('sesiones: inicio, guardado con session_id, resumen y cierre', async (t) => {
  const { run, store } = setup(t);
  const started = await run('mem_session_start', { id: 'sesion-1' });
  assert.equal(started.json.result, 'Session "sesion-1" started for project "mi-repo"');
  assert.equal(getSession(store, 'sesion-1').ownership_mode, 'shared');
  assert.equal(captureProjectProvenance(store, 'session', 'sesion-1').source, 'git_root');
  assert.equal((await run('mem_session_start', { id: 'sesion-1' })).isError, false); // renovar
  assert.equal((await run('mem_session_start', {})).text, 'Failed to start session: session id is required');

  const saved = await run('mem_save', { title: 'En sesión', content: 'dentro', session_id: 'sesion-1' });
  assert.equal(saved.json.project_source, 'session');
  // una sesión compartida admite escribir en otro proyecto; una propietaria no
  const elsewhere = await run('mem_save', { title: 'Otra', content: 'otro proyecto', session_id: 'sesion-1', project: 'otro' });
  assert.equal(elsewhere.json.project, 'otro');
  assert.equal(elsewhere.json.project_source, 'explicit_override');
  createSession(store, 'duena', 'mi-repo', '/d', 'project_owned');
  const mismatch = await run('mem_save', { title: 'x', content: 'y', session_id: 'duena', project: 'otro' });
  assert.equal(mismatch.json.error_code, 'session_project_mismatch');
  assert.equal(mismatch.json.message, 'Session "duena" belongs to project "mi-repo", but request targeted "otro"');

  // la puntuación de actividad es la de la sesión de reserva del proyecto: cuenta las llamadas, no los guardados
  const bare = await run('mem_session_summary', { content: 'resumen previo', session_id: 'sesion-1' });
  assert.equal(bare.json.result, 'Session summary saved for project "mi-repo"\nSession activity: 3 tool calls, 0 saves');
  await run('mem_context');
  const summary = await run('mem_session_summary', { content: '## Goal\nprobar', session_id: 'sesion-1' });
  assert.equal(summary.json.result, 'Session summary saved for project "mi-repo"\nSession activity: 4 tool calls, 0 saves');
  assert.equal(summary.json.judgment_required, false);
  assert.equal(store.db.get("SELECT title FROM observations WHERE type = 'session_summary' ORDER BY id LIMIT 1").title, 'Session summary: mi-repo');
  assert.equal((await run('mem_session_summary', { content: '  ' })).text, 'content is required for mem_session_summary');

  assert.equal((await run('mem_session_end', { id: 'sesion-1', summary: 'cerrada' })).json.result, 'Session "sesion-1" completed');
  assert.equal(getSession(store, 'sesion-1').summary, 'cerrada');
  const again = await run('mem_session_start', { id: 'sesion-1' });
  assert.equal(again.json.error_code, 'session_already_ended');
  assert.equal(again.json.session_id, 'sesion-1');
  assert.equal(again.json.message, 'Session "sesion-1" has already ended. Choose a new session ID and retry mem_session_start.');
});

test('captura pasiva extrae los aprendizajes y omite los repetidos', async (t) => {
  const { run, store } = setup(t);
  const text = '## Key Learnings:\n\n1. El índice trigram acelera las búsquedas parciales\n2. Los tests deben aislar el directorio de datos\n3. corto';
  assert.equal((await run('mem_capture_passive', { content: text })).json.result, 'Passive capture complete: extracted=2 saved=2 duplicates=0');
  assert.equal((await run('mem_capture_passive', { content: text })).json.result, 'Passive capture complete: extracted=2 saved=0 duplicates=2');
  assert.equal(store.db.get("SELECT tool_name FROM observations WHERE id = 1").tool_name, 'mcp-passive');
  await run('mem_capture_passive', { content: '## Key Learnings:\n\n- Una lección más sobre transacciones', source: 'subagent-stop' });
  assert.equal(store.db.get("SELECT tool_name FROM observations WHERE id = 3").tool_name, 'subagent-stop');
  assert.equal((await run('mem_capture_passive', { content: '' })).text, "content is required — include text with a '## Key Learnings:' section");
  assert.match((await run('mem_capture_passive', { content: 'sin sección' })).json.result, /extracted=0 saved=0 duplicates=0/);
});

test('proyecto ambiguo: el error trae un token y la elección del usuario lo recupera', async (t) => {
  const parent = repoTempDir(t);
  initRepo(join(parent, 'uno'));
  initRepo(join(parent, 'dos'));
  const { run, store } = setup(t, { dir: parent });
  const failed = await run('mem_save', { title: 'x', content: 'y' });
  assert.equal(failed.json.error_code, 'ambiguous_project');
  assert.deepEqual(failed.json.available_projects, ['dos', 'uno']);
  assert.match(failed.json.recovery_token, /^[0-9a-f]{32}$/);
  assert.equal(failed.json.token_ttl_seconds, 300);

  const choose = (extra) => ({ title: 'Elegido', content: 'tras elegir', project: 'dos', project_choice_reason: 'user_selected_after_ambiguous_project', ...extra });
  assert.equal((await run('mem_save', choose({}))).json.error_code, 'missing_recovery_token');
  assert.equal((await run('mem_save', choose({ recovery_token: '0'.repeat(32) }))).json.error_code, 'invalid_recovery_token');
  assert.equal((await run('mem_save', choose({ recovery_token: failed.json.recovery_token, project: 'tres' }))).json.error_code, 'invalid_project_choice');
  const ok = await run('mem_save', choose({ recovery_token: failed.json.recovery_token }));
  assert.equal(ok.isError, false);
  assert.equal(ok.json.project, 'dos');
  assert.equal(ok.json.project_source, 'user_selected_after_ambiguous_project');
  assert.equal(ok.json.warning, 'project selected by user after ambiguous_project recovery');
  assert.equal(store.db.get('SELECT project FROM observations WHERE id = ?', ok.json.id).project, 'dos');
  assert.equal(captureProjectProvenance(store, 'observation', ok.json.id).raw_project, 'dos');

  // el resto de las escrituras sin sesión también quedan bloqueadas
  for (const [tool, args] of [['mem_save_prompt', { content: 'p' }], ['mem_session_summary', { content: 's' }], ['mem_capture_passive', { content: 'c' }], ['mem_session_start', { id: 'z' }]]) {
    assert.equal((await run(tool, args)).json.error_code, 'ambiguous_project', tool);
  }
  // cerrar una sesión conserva el comportamiento heredado: no falla
  assert.equal((await run('mem_session_end', { id: 'z' })).isError, false);
});

test('un prompt con sesión y recuperación pide el token emitido para esa sesión', async (t) => {
  const parent = repoTempDir(t);
  initRepo(join(parent, 'uno'));
  initRepo(join(parent, 'dos'));
  const { run, store } = setup(t, { dir: parent });
  const failed = await run('mem_save_prompt', { content: 'prompt', session_id: 'sess-amb' });
  assert.equal(failed.json.error_code, 'ambiguous_project');
  const retry = await run('mem_save_prompt', {
    content: 'prompt', session_id: 'sess-amb', project: 'uno', project_choice_reason: 'user_selected_after_ambiguous_project', recovery_token: failed.json.recovery_token,
  });
  assert.equal(retry.isError, false);
  assert.equal(retry.json.project, 'uno');
  assert.equal(getSession(store, 'sess-amb').ownership_mode, 'project_owned');
});

test('vínculo del anfitrión: un session_id omitido usa la sesión que publicó el host', async (t) => {
  const store = openTempStore(t);
  const root = repoTempDir(t);
  const repo = initRepo(join(root, 'mi-repo'));
  const hostbind = { processStart: (pid) => (pid === 4242 ? 'inicio-1' : (() => { throw new Error('sin proceso'); })()) };
  const server = createServer(store, {}, null, { env: {}, cwd: () => repo, hostPid: 4242, hostbind });
  const call = async (name, args) => JSON.parse((await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result.content[0].text);
  startSession(store, 'sesion-host', 'mi-repo', repo);
  publish(store.dataDir, 4242, 'sesion-host', hostbind);
  const saved = await call('mem_save', { title: 'Vinculada', content: 'a la sesión del host' });
  assert.equal(store.db.get('SELECT session_id FROM observations WHERE id = ?', saved.id).session_id, 'sesion-host');

  // un vínculo cuya sesión es de otro proyecto rechaza la escritura en lugar de caer en otra sesión
  startSession(store, 'sesion-ajena', 'ajeno', repo);
  publish(store.dataDir, 4242, 'sesion-ajena', hostbind);
  const result = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mem_save', arguments: { title: 'x', content: 'y' } } });
  assert.match(result.result.content[0].text, /^Failed to save: host session binding cannot resolve a live session/);
});

test('sin vínculo, dos sesiones activas del mismo directorio impiden adivinar', async (t) => {
  const { run, cwd, store } = setup(t);
  startSession(store, 'sesion-a', 'mi-repo', cwd);
  assert.equal((await run('mem_save', { title: 'Una', content: 'sola sesión activa' })).isError, false);
  assert.equal(store.db.get("SELECT session_id FROM observations WHERE title = 'Una'").session_id, 'sesion-a');
  startSession(store, 'sesion-b', 'mi-repo', cwd);
  const ambiguous = await run('mem_save', { title: 'Dos', content: 'dos sesiones activas' });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /^Failed to save: multiple active runtime sessions match the current project and directory; provide session_id,/);
  assert.match(ambiguous.text, /save independently with odin save\. The resolved project is "mi-repo"/);
});

test('las escrituras concurrentes se serializan y el servidor las atiende en orden', async (t) => {
  const { server } = setup(t);
  const calls = Array.from({ length: 12 }, (_, i) =>
    server.handle({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'mem_save', arguments: { title: `Concurrente ${i}`, content: `contenido ${i}` } } }));
  const results = await Promise.all(calls);
  const ids = results.map((r) => JSON.parse(r.result.content[0].text).id);
  assert.deepEqual(ids, Array.from({ length: 12 }, (_, i) => i + 1));
});
