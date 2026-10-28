// Contraste diferencial de las herramientas MCP de escritura: mismas llamadas sobre
// bases vacías de ambos programas, mismas respuestas y mismo estado resultante.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolveBinary, startMcp, startMcpCommand } from './engram-mcp.mjs';

const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';
const SERVER = fileURLToPath(new URL('./odin-mcp-server.mjs', import.meta.url));

let base;
let repo;
let ambiguous;
const pairs = [];

/** Arranca un par (referencia, odin) en el mismo directorio de trabajo. */
async function startPair(cwd, { project } = {}) {
  const odinData = mkdtempSync(join(base, 'odin-data-'));
  const env = project ? { ENGRAM_PROJECT: project } : {};
  const reference = startMcpCommand(binary.bin, ['mcp', '--tools=all'], {
    cwd, env: { ...env, ENGRAM_DATA_DIR: join(base, `ref-${pairs.length}`), ENGRAM_NO_UPDATE_CHECK: '1' },
    dataDir: join(base, `ref-${pairs.length}`),
  });
  const odin = startMcpCommand(process.execPath, ['--no-warnings', SERVER], {
    cwd, dataDir: odinData, env: { ODIN_DATA_DIR: odinData, ...(project ? { ODIN_PROJECT: project } : {}) },
  });
  await Promise.all([reference.initialize(), odin.initialize()]);
  const pair = { reference, odin, refDb: join(base, `ref-${pairs.length}`, 'engram.db'), odinDb: join(odinData, 'odin.db') };
  pairs.push(pair);
  return pair;
}

before(() => {
  if (!binary) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-write-')));
  repo = join(base, 'repo-write');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  ambiguous = join(base, 'ambiguo');
  for (const name of ['uno', 'dos']) {
    mkdirSync(join(ambiguous, name), { recursive: true });
    execFileSync('git', ['init', '-q', join(ambiguous, name)]);
  }
});
after(() => {
  for (const { reference, odin } of pairs) {
    reference.close();
    odin.close();
  }
  if (base) rmSync(base, { recursive: true, force: true });
  binary?.cleanup();
});

/** Enmascara lo aleatorio y aplica los renombres de identidad. */
function normalize(value) {
  if (typeof value === 'string') {
    return value
      .replace(/obs-[0-9a-f]{16}/g, 'obs-X').replace(/rel-[0-9a-f]{16}/g, 'rel-X').replace(/prompt-[0-9a-f]{16}/g, 'prompt-X')
      .replace(/\b[0-9a-f]{32}\b/g, 'TOKEN')
      .replaceAll('.engram', '.odin-memory').replaceAll('ENGRAM_PROJECT', 'ODIN_PROJECT').replaceAll('engram save', 'odin save')
      .replaceAll('Restart Engram', 'Restart odin');
  }
  // bm25 puede diferir en la última cifra según cómo se compile SQLite.
  if (typeof value === 'number' && !Number.isInteger(value)) return Number(value.toPrecision(10));
  if (Array.isArray(value)) return value.map(normalize);
  // Un `review_after` calculado desde el reloj puede diferir un segundo entre los dos procesos; los sembrados (2020) no.
  const clockDerived = (k, v) => k === 'review_after' && typeof v === 'string' && !v.startsWith('2020-');
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clockDerived(k, v) ? '<T>' : normalize(v)]));
  return value;
}

/** Llama a ambos y compara. Devuelve las respuestas para encadenar valores propios de cada lado. */
async function same(pair, label, tool, args, argsOdin = args) {
  const [ref, mine] = await Promise.all([pair.reference.call(tool, args), pair.odin.call(tool, argsOdin)]);
  assert.equal(mine.isError, ref.isError, `${label}: isError\nref: ${ref.text}\nodin: ${mine.text}`);
  assert.deepEqual(normalize(mine.json ?? mine.text), normalize(ref.json ?? ref.text), label);
  return { ref, mine };
}

const rows = (path, sql) => {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    return db.prepare(sql).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};

const STATE = {
  observations: "SELECT id, session_id, type, title, content, tool_name, project, scope, topic_key, revision_count, duplicate_count, pinned, deleted_at IS NOT NULL AS deleted, review_after IS NOT NULL AS has_review FROM observations ORDER BY id",
  versions: 'SELECT observation_id, version, title, content FROM observation_versions ORDER BY observation_id, version',
  sessions: "SELECT id, project, ownership_mode, directory, ended_at IS NOT NULL AS ended, summary FROM sessions ORDER BY id",
  prompts: "SELECT id, session_id, content, project FROM user_prompts ORDER BY id",
  provenance: 'SELECT entity_kind, entity_id, source, directory, raw_project FROM capture_project_provenance ORDER BY entity_kind, entity_id',
  relations: "SELECT relation, judgment_status FROM memory_relations ORDER BY id",
};

function assertSameState(pair, label) {
  for (const [name, sql] of Object.entries(STATE)) {
    assert.deepEqual(normalize(rows(pair.odinDb, sql)), normalize(rows(pair.refDb, sql)), `${label}: estado de ${name}`);
  }
}

test('mem_save: guardado, tema, duplicados, truncamiento, avisos y validaciones', { skip }, async () => {
  const pair = await startPair(repo);
  await same(pair, 'proyecto', 'mem_current_project', {});
  await same(pair, 'simple', 'mem_save', { title: 'Arquitectura hexagonal', content: 'puertos y adaptadores para el dominio', type: 'architecture' });
  await same(pair, 'tema', 'mem_save', { title: 'Decisión de caché', content: 'usamos Redis como caché', type: 'decision', topic_key: 'decision/cache' });
  await same(pair, 'mismo tema (revisión)', 'mem_save', { title: 'Decisión de caché', content: 'usamos Memcached como caché', type: 'decision', topic_key: 'decision/cache' });
  await same(pair, 'duplicado', 'mem_save', { title: 'Arquitectura hexagonal', content: 'puertos y adaptadores para el dominio', type: 'architecture' });
  await same(pair, 'alias observation', 'mem_save', { title: 'Alias', observation: 'contenido por el alias antiguo', type: 'manual' });
  await same(pair, 'personal', 'mem_save', { title: 'Preferencia personal', content: 'tabulaciones de dos espacios', type: 'preference', scope: 'personal' });
  await same(pair, 'ruta absoluta', 'mem_save', { title: 'Ruta', content: 'el archivo está en /Users/alguien/proyecto/src/main.go y C:\\datos\\x', type: 'manual' });
  await same(pair, 'ruta de Windows con barra invertida', 'mem_save', { title: 'Win1', content: 'abre C:\\datos\\x ahora', type: 'manual' });
  await same(pair, 'ruta de Windows con barra', 'mem_save', { title: 'Win2', content: 'abre d:/datos/x ahora', type: 'manual' });
  await same(pair, 'ruta UNC', 'mem_save', { title: 'Unc', content: 'abre \\\\servidor\\recurso ahora', type: 'manual' });
  await same(pair, 'ruta relativa', 'mem_save', { title: 'Relativa', content: 'edita src/main.go y docs/a.md', type: 'manual' });
  await same(pair, 'ruta tras palabra', 'mem_save', { title: 'Tras palabra', content: 'usa input/output y a/b/c', type: 'manual' });
  await same(pair, 'ruta de API', 'mem_save', { title: 'Api', content: 'llama a (/api/v1/items) o "/health"', type: 'manual' });
  await same(pair, 'URI no es ruta', 'mem_save', { title: 'Enlace', content: 'ver https://example.com/a/b y file:///tmp/x', type: 'manual' });
  await same(pair, 'truncamiento', 'mem_save', { title: 'Enorme', content: `inicio ${'palabra '.repeat(8000)}`, type: 'manual' });
  await same(pair, 'privado', 'mem_save', { title: 'Secreto', content: 'clave <private>abc123</private> visible', type: 'manual' });
  await same(pair, 'candidatos', 'mem_save', { title: 'Decisión de caché con Redis', content: 'Redis como caché distribuida', type: 'decision' });
  await same(pair, 'sin contenido', 'mem_save', { title: 'Vacío', content: '   ' });
  await same(pair, 'sin título', 'mem_save', { title: '  ', content: 'algo' });
  await same(pair, 'capture_prompt inválido', 'mem_save', { title: 'x', content: 'y', capture_prompt: 'si' });
  await same(pair, 'proyecto explícito desconocido', 'mem_save', { title: 'x', content: 'y', project: 'otro-proyecto' });
  await same(pair, 'proyecto explícito vacío', 'mem_save', { title: 'x', content: 'y', project: '  ' });
  await same(pair, 'proyecto con ruta', 'mem_save', { title: 'x', content: 'y', project: 'a/b' });
  await same(pair, 'proyecto igual al detectado', 'mem_save', { title: 'Explícito', content: 'mismo proyecto', project: 'repo-write' });
  await same(pair, 'sesión desconocida', 'mem_save', { title: 'x', content: 'y', session_id: 'no-existe' });
  // Un proyecto nuevo parecido a uno existente: la sesión se registra en otro repositorio.
  const similar = join(base, 'repo-writes');
  mkdirSync(similar, { recursive: true });
  execFileSync('git', ['init', '-q', similar]);
  await same(pair, 'sesión en proyecto parecido', 'mem_session_start', { id: 'parecido', directory: similar });
  await same(pair, 'aviso de proyecto parecido', 'mem_save', { title: 'Parecido', content: 'primer guardado del proyecto nuevo', session_id: 'parecido' });
  const distant = join(base, 'repo-wxyze'); // a distancia de edición 3 de «repo-write»
  mkdirSync(distant, { recursive: true });
  execFileSync('git', ['init', '-q', distant]);
  await same(pair, 'sesión en proyecto a distancia 3', 'mem_session_start', { id: 'distante', directory: distant });
  await same(pair, 'aviso por distancia de edición', 'mem_save', { title: 'Distante', content: 'primer guardado del proyecto lejano', session_id: 'distante' });
  await same(pair, 'proyecto con separadores colapsados', 'mem_save', { title: 'Colapso', content: 'nombre con doble guion', project: 'repo--write' });
  assertSameState(pair, 'tras mem_save');
});

test('mem_update, mem_delete, mem_pin y mem_review', { skip }, async () => {
  const pair = await startPair(repo);
  for (const o of [
    { title: 'Uno', content: 'primer contenido con una palabra clave', type: 'decision' },
    { title: 'Dos', content: 'segundo contenido', type: 'manual' },
    { title: 'Tres', content: 'tercero', type: 'bugfix' },
    { title: 'Cuatro', content: 'cuarto', type: 'learning' },
  ]) await same(pair, `siembra ${o.title}`, 'mem_save', o);
  const expected = { expected_project: 'repo-write' };
  await same(pair, 'update título', 'mem_update', { id: 1, title: 'Uno actualizado', ...expected });
  await same(pair, 'update contenido', 'mem_update', { id: 1, content: 'contenido nuevo completo', ...expected });
  await same(pair, 'update buscar/reemplazar', 'mem_update', { id: 1, find: 'nuevo', replace: 'viejo', ...expected });
  await same(pair, 'update sin coincidencia', 'mem_update', { id: 1, find: 'zzz', replace: 'yyy', ...expected });
  await same(pair, 'update metadatos', 'mem_update', { id: 2, type: 'pattern', scope: 'global', topic_key: 'patron/dos', ...expected });
  await same(pair, 'update truncado', 'mem_update', { id: 2, content: 'x'.repeat(60000), ...expected });
  await same(pair, 'update sin campos', 'mem_update', { id: 1, ...expected });
  await same(pair, 'update sin id', 'mem_update', { title: 'x', ...expected });
  await same(pair, 'update sin expected_project', 'mem_update', { id: 1, title: 'x' });
  await same(pair, 'update proyecto ajeno', 'mem_update', { id: 1, title: 'x', expected_project: 'otro' });
  await same(pair, 'update inexistente', 'mem_update', { id: 99, title: 'x', ...expected });
  await same(pair, 'update find sin replace', 'mem_update', { id: 1, find: 'a', ...expected });
  await same(pair, 'update título vacío', 'mem_update', { id: 1, title: ' ', ...expected });

  await same(pair, 'pin', 'mem_pin', { id: 1 });
  await same(pair, 'unpin', 'mem_unpin', { id: 1 });
  await same(pair, 'pin sin id', 'mem_pin', {});
  await same(pair, 'pin inexistente', 'mem_pin', { id: 99 });

  await same(pair, 'delete suave', 'mem_delete', { id: 3, ...expected });
  await same(pair, 'delete duro', 'mem_delete', { id: 4, hard_delete: true, ...expected });
  await same(pair, 'delete repetido', 'mem_delete', { id: 3, ...expected });
  await same(pair, 'delete sin expected', 'mem_delete', { id: 1 });
  await same(pair, 'delete sin id', 'mem_delete', { ...expected });

  await same(pair, 'review lista vacía', 'mem_review', { action: 'list' });
  for (const p of [pair]) {
    for (const path of [p.refDb, p.odinDb]) {
      const db = new DatabaseSync(path, { timeout: 5000 });
      db.prepare("UPDATE observations SET review_after = '2020-01-01 00:00:00' WHERE id IN (1, 2)").run();
      db.close();
    }
  }
  for (let i = 5; i <= 11; i++) await same(pair, `siembra revisión ${i}`, 'mem_save', { title: `Revisable ${i}`, content: `contenido revisable ${i}`, type: 'decision' });
  for (const path of [pair.refDb, pair.odinDb]) {
    const db = new DatabaseSync(path, { timeout: 5000 });
    db.prepare("UPDATE observations SET review_after = datetime('2020-01-01 00:00:00', '+' || id || ' days') WHERE id >= 5").run();
    db.close();
  }
  await same(pair, 'review lista', 'mem_review', { action: 'list' });
  await same(pair, 'review lista con proyecto', 'mem_review', { action: 'list', project: 'repo-write', limit: 1 });
  await same(pair, 'review proyecto desconocido', 'mem_review', { action: 'list', project: 'nada' });
  await same(pair, 'marcar revisada', 'mem_review', { action: 'mark_reviewed', observation_id: 1 });
  await same(pair, 'marcar con id', 'mem_review', { action: 'mark_reviewed', id: 2 });
  await same(pair, 'marcar sin id', 'mem_review', { action: 'mark_reviewed' });
  await same(pair, 'marcar inexistente', 'mem_review', { action: 'mark_reviewed', observation_id: 99 });
  await same(pair, 'acción inválida', 'mem_review', { action: 'borrar' });
  await same(pair, 'sin acción', 'mem_review', {});
  assertSameState(pair, 'tras mutaciones');
});

test('sesiones, prompts y captura pasiva', { skip }, async () => {
  const pair = await startPair(repo);
  await same(pair, 'prompt', 'mem_save_prompt', { content: 'refactoriza el módulo de pagos' });
  await same(pair, 'prompt repetido', 'mem_save_prompt', { content: 'refactoriza el módulo de pagos' });
  await same(pair, 'prompt vacío', 'mem_save_prompt', { content: '' });
  await same(pair, 'prompt largo', 'mem_save_prompt', { content: `${'detalle '.repeat(9000)}` });
  await same(pair, 'prompt unicode', 'mem_save_prompt', { content: 'añade pruebas 日本語 😀 y documenta' });

  await same(pair, 'inicio de sesión', 'mem_session_start', { id: 'sesion-1' });
  await same(pair, 'inicio repetido', 'mem_session_start', { id: 'sesion-1' });
  await same(pair, 'inicio con directorio', 'mem_session_start', { id: 'sesion-2', directory: repo });
  await same(pair, 'inicio sin id', 'mem_session_start', {});
  await same(pair, 'guardar en sesión', 'mem_save', { title: 'En sesión', content: 'guardado dentro de la sesión uno', session_id: 'sesion-1' });
  await same(pair, 'guardar con proyecto de la sesión', 'mem_save', { title: 'Otra', content: 'otra nota', session_id: 'sesion-1', project: 'repo-write' });
  await same(pair, 'guardar con proyecto de la sesión y separadores colapsados', 'mem_save', { title: 'Colapso', content: 'doble guion', session_id: 'sesion-1', project: 'repo--write' });
  await same(pair, 'guardar con proyecto ajeno a la sesión', 'mem_save', { title: 'Ajena', content: 'otra nota', session_id: 'sesion-1', project: 'otro' });
  await same(pair, 'prompt en sesión', 'mem_save_prompt', { content: 'prompt de la sesión', session_id: 'sesion-1' });
  await same(pair, 'prompt con motivo de recuperación sin ambigüedad', 'mem_save_prompt', {
    content: 'prompt con motivo inútil', session_id: 'sesion-1', project: 'otro', project_choice_reason: 'user_selected_after_ambiguous_project', recovery_token: 'x',
  });
  for (const path of [pair.refDb, pair.odinDb]) {
    const db = new DatabaseSync(path, { timeout: 5000 });
    db.prepare("DELETE FROM user_prompts WHERE content = 'prompt de la sesión'").run(); // el prompt sigue vigente solo en memoria
    db.close();
  }
  await same(pair, 'guardado con prompt capturado', 'mem_save', { title: 'Con prompt', content: 'tras el prompt', session_id: 'sesion-1' });
  await same(pair, 'guardado sin capturar prompt', 'mem_save', { title: 'Sin prompt', content: 'no capturar', session_id: 'sesion-1', capture_prompt: false });
  await same(pair, 'resumen', 'mem_session_summary', { content: '## Goal\nprobar\n## Accomplished\n- todo', session_id: 'sesion-1' });
  await same(pair, 'resumen sin sesión', 'mem_session_summary', { content: 'resumen implícito' });
  await same(pair, 'resumen vacío', 'mem_session_summary', { content: '  ' });
  await same(pair, 'fin de sesión', 'mem_session_end', { id: 'sesion-1', summary: 'cerrada' });
  await same(pair, 'fin repetido', 'mem_session_end', { id: 'sesion-1' });
  await same(pair, 'reinicio de sesión terminada', 'mem_session_start', { id: 'sesion-1' });
  await same(pair, 'fin de sesión inexistente', 'mem_session_end', { id: 'sesion-9' });

  const aprendizajes = '## Key Learnings:\n\n1. El índice trigram acelera las búsquedas parciales\n2. Los tests deben aislar el directorio de datos\n3. corto';
  await same(pair, 'captura pasiva', 'mem_capture_passive', { content: aprendizajes });
  await same(pair, 'captura repetida', 'mem_capture_passive', { content: aprendizajes });
  await same(pair, 'captura con fuente', 'mem_capture_passive', { content: '## Key Learnings:\n\n- Otra lección sobre transacciones inmediatas', source: 'subagent-stop' });
  await same(pair, 'captura sin aprendizajes', 'mem_capture_passive', { content: 'texto sin sección' });
  await same(pair, 'captura vacía', 'mem_capture_passive', { content: '' });
  await same(pair, 'captura en blanco', 'mem_capture_passive', { content: '   ' });
  assertSameState(pair, 'tras sesiones');
});

test('proyecto de configuración: elección explícita igual o distinta', { skip }, async () => {
  const configured = join(base, 'con-config');
  for (const dir of ['.engram', '.odin-memory']) {
    mkdirSync(join(configured, dir), { recursive: true });
    writeFileSync(join(configured, dir, 'config.json'), '{"project_name":"Proyecto-Config"}');
  }
  execFileSync('git', ['init', '-q', configured]);
  const pair = await startPair(configured);
  await same(pair, 'proyecto actual', 'mem_current_project', {});
  await same(pair, 'explícito distinto al configurado (nuevo)', 'mem_save', { title: 'Distinto', content: 'otro nombre', project: 'proyecto-config-nuevo' });
  await same(pair, 'explícito igual al configurado (aún sin memorias)', 'mem_save', { title: 'Igual', content: 'mismo nombre', project: 'proyecto-config' });
  await same(pair, 'guardar', 'mem_save', { title: 'Uno', content: 'primero' });
  await same(pair, 'explícito con otra caja', 'mem_save', { title: 'Caja', content: 'otra caja', project: 'Proyecto-Config' });
  await same(pair, 'explícito con doble guion', 'mem_save', { title: 'Guion', content: 'doble guion', project: 'proyecto--config' });
  assertSameState(pair, 'proyecto de configuración');
});

test('proyecto ambiguo: error con token y recuperación', { skip }, async () => {
  const pair = await startPair(ambiguous);
  const { ref, mine } = await same(pair, 'ambiguo', 'mem_save', { title: 'x', content: 'y' });
  assert.equal(ref.json.error_code, 'ambiguous_project');
  assert.equal(typeof mine.json.recovery_token, 'string');
  assert.equal(mine.json.recovery_token.length, ref.json.recovery_token.length);
  const retry = (token) => ({ title: 'Elegido', content: 'tras elegir', project: 'dos', project_choice_reason: 'user_selected_after_ambiguous_project', recovery_token: token });
  await same(pair, 'sin token', 'mem_save', { ...retry(''), recovery_token: undefined });
  await same(pair, 'token falso', 'mem_save', retry('0'.repeat(32)));
  await same(pair, 'elección inválida', 'mem_save', { ...retry(ref.json.recovery_token), project: 'tres' }, { ...retry(mine.json.recovery_token), project: 'tres' });
  await same(pair, 'recuperación', 'mem_save', retry(ref.json.recovery_token), retry(mine.json.recovery_token));
  const promptAmbiguous = await same(pair, 'prompt ambiguo con sesión', 'mem_save_prompt', { content: 'prompt en sesión nueva', session_id: 'sess-amb' });
  assert.equal(promptAmbiguous.ref.json.error_code, 'ambiguous_project');
  const promptRetry = (token) => ({ content: 'prompt en sesión nueva', session_id: 'sess-amb', project: 'uno', project_choice_reason: 'user_selected_after_ambiguous_project', recovery_token: token });
  await same(pair, 'prompt recuperado con sesión', 'mem_save_prompt', promptRetry(promptAmbiguous.ref.json.recovery_token), promptRetry(promptAmbiguous.mine.json.recovery_token));
  await same(pair, 'prompt con motivo sin ambigüedad en sesión', 'mem_save_prompt', { content: 'otro', session_id: 'sess-amb', project: 'dos', project_choice_reason: 'user_selected_after_ambiguous_project', recovery_token: 'x' });
  await same(pair, 'prompt ambiguo', 'mem_save_prompt', { content: 'un prompt' });
  await same(pair, 'resumen ambiguo', 'mem_session_summary', { content: 'un resumen' });
  await same(pair, 'captura ambigua', 'mem_capture_passive', { content: '## Key Learnings:\n\n1. Una lección suficientemente larga' });
  await same(pair, 'inicio ambiguo', 'mem_session_start', { id: 's' });
  await same(pair, 'fin ambiguo', 'mem_session_end', { id: 's' });
  await same(pair, 'lectura ambigua', 'mem_search', { query: 'x' });
  assertSameState(pair, 'tras la recuperación');
});

test('proyecto fijado para el proceso', { skip }, async () => {
  const pair = await startPair(repo, { project: 'fijo' });
  await same(pair, 'proyecto actual', 'mem_current_project', {});
  await same(pair, 'guardar fijo', 'mem_save', { title: 'Fijo', content: 'en el proyecto fijado' });
  await same(pair, 'prompt fijo', 'mem_save_prompt', { content: 'prompt fijo' });
  await same(pair, 'explícito distinto', 'mem_save', { title: 'x', content: 'y', project: 'otro' });
  await same(pair, 'explícito igual', 'mem_save', { title: 'Mismo', content: 'explícito igual al fijo', project: 'fijo' });
  await same(pair, 'resumen fijo', 'mem_session_summary', { content: 'resumen fijo' });
  await same(pair, 'sesión fija', 'mem_session_start', { id: 'sesion-fija' });
  await same(pair, 'guardar en sesión fija', 'mem_save', { title: 'En sesión fija', content: 'dentro de la sesión', session_id: 'sesion-fija' });
  await same(pair, 'sesión desconocida con proyecto fijo', 'mem_save', { title: 'x', content: 'y', session_id: 'no-existe' });
  await same(pair, 'prompt en sesión desconocida con proyecto fijo', 'mem_save_prompt', { content: 'z', session_id: 'no-existe' });
  assertSameState(pair, 'proyecto fijado');
});
