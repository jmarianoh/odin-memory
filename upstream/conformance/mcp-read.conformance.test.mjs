// Contraste diferencial de las herramientas MCP de lectura: mismos datos, mismas llamadas, mismas respuestas.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  Store, addObservation, addPrompt, createSession, findCandidates, judgeRelation, pinObservation, endSession,
} from '../../src/store/index.js';
import { resolveBinary, startMcp, startMcpCommand } from './engram-mcp.mjs';

const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';
const SERVER = fileURLToPath(new URL('./odin-mcp-server.mjs', import.meta.url));
const PROJECT = 'proyecto-conf';
const SESSION = `manual-save-${PROJECT}`;

let base;
let repo;
let engram;
let odinProcess;
let odinStore;
let engramDbPath;
let odinDbPath;

before(async () => {
  if (!binary) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-mcp-')));
  repo = join(base, PROJECT);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  engram = startMcp(binary.bin, { cwd: repo });
  engramDbPath = join(engram.dataDir, 'engram.db');
  const odinData = join(base, 'odin-data');
  odinProcess = startMcpCommand(process.execPath, ['--no-warnings', SERVER], { cwd: repo, env: { ODIN_DATA_DIR: odinData } });
  await odinProcess.initialize();
  odinStore = Store.open({ dataDir: odinData, log: () => {} });
  odinDbPath = odinStore.dbPath;
  createSession(odinStore, SESSION, PROJECT, repo, 'project_owned');
  await seed();
});
after(() => {
  engram?.close();
  odinProcess?.close();
  odinStore?.close();
  if (base) rmSync(base, { recursive: true, force: true });
  binary?.cleanup();
});

const OBSERVATIONS = [
  { title: 'Arquitectura hexagonal', content: 'puertos y adaptadores para la capa de dominio', type: 'architecture', topic_key: 'architecture/hexagonal' },
  { title: 'Bug en login', content: 'el login falla con puertos cerrados', type: 'bugfix' },
  { title: 'Decisión de caché', content: 'usamos Redis como caché distribuida para sesiones', type: 'decision' },
  { title: 'Caché de sesiones con Redis', content: 'Redis guarda las sesiones de usuario', type: 'decision' },
  { title: 'Persistencia SQLite', content: 'WAL y FTS5 para búsqueda de texto completo', type: 'architecture' },
  { title: 'Preferencia de editor', content: 'el equipo prefiere tabulaciones de 2 espacios', type: 'preference', scope: 'personal' },
  { title: 'Nota larga', content: `contenido muy largo ${'palabra '.repeat(80)}`, type: 'manual' },
  { title: 'Convención de nombres', content: 'handlers terminan en Handler', type: 'pattern', scope: 'global' },
  { title: 'Migración de base de datos', content: 'plan para migrar la base de datos', type: 'decision' },
  { title: 'Migración de la base de datos a Postgres', content: 'se decidió migrar a Postgres', type: 'decision' },
  { title: 'Bug en login por puertos cerrados', content: 'el login sigue fallando con puertos cerrados', type: 'bugfix' },
];
const PROMPTS = ['refactoriza el módulo de pagos', 'documenta la API de pagos', 'añade tests de integración para el login', 'qué hace el índice trigram'];

const sqlBoth = (sql, ...params) => {
  for (const path of [engramDbPath, odinDbPath]) {
    const db = new DatabaseSync(path, { timeout: 5000 });
    db.prepare(sql).run(...params);
    db.close();
  }
};

async function seed() {
  const judgments = new Map(); // id guardado → candidatos de la referencia
  for (const o of OBSERVATIONS) {
    const ref = await engram.call('mem_save', o);
    assert.equal(ref.isError, false, ref.text);
    const { id } = addObservation(odinStore, { session_id: SESSION, ...o });
    assert.equal(id, ref.json.id);
    findCandidates(odinStore, id, { project: PROJECT, scope: o.scope ?? 'project', require_save_relevance: true });
    judgments.set(id, ref.json.candidates ?? []);
  }
  // Dos juicios en ambos lados: la 4 sustituye a la 3; la 11 contradice a la 2.
  for (const [source, target, relation] of [[4, 3, 'supersedes'], [11, 2, 'conflicts_with']]) {
    const candidate = judgments.get(source).find((c) => c.id === target);
    assert.ok(candidate, `la referencia debe ofrecer #${target} como candidato de #${source}`);
    const ref = await engram.call('mem_judge', { judgment_id: candidate.judgment_id, relation, reason: 'prueba', confidence: 0.9 });
    assert.equal(ref.isError, false, ref.text);
    const mine = odinStore.db.get(
      'SELECT sync_id FROM memory_relations WHERE source_id = (SELECT sync_id FROM observations WHERE id = ?) AND target_id = (SELECT sync_id FROM observations WHERE id = ?)',
      source, target,
    );
    judgeRelation(odinStore, { judgment_id: mine.sync_id, relation, reason: 'prueba', confidence: 0.9, marked_by_actor: 'agent', marked_by_kind: 'agent' });
  }
  // Versiones: 60 revisiones de la misma observación con topic_key.
  for (let i = 1; i <= 60; i++) {
    const o = { title: `Registro versionado`, content: `revisión número ${i}`, type: 'manual', topic_key: 'notas/versionado' };
    await engram.call('mem_save', o);
    addObservation(odinStore, { session_id: SESSION, ...o });
  }
  for (const content of PROMPTS) {
    assert.equal((await engram.call('mem_save_prompt', { content })).isError, false);
    addPrompt(odinStore, { session_id: SESSION, content });
  }
  await engram.call('mem_pin', { id: 3 });
  pinObservation(odinStore, 3);
  // Fechas deterministas en ambas bases.
  sqlBoth("UPDATE observations SET created_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes'), updated_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes'), last_seen_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes'), review_after = CASE WHEN review_after IS NULL THEN NULL ELSE '2027-01-01 00:00:00' END");
  sqlBoth("UPDATE observation_versions SET created_at = datetime('2026-03-02 10:00:00', '+' || id || ' minutes')");
  sqlBoth("UPDATE user_prompts SET created_at = datetime('2026-03-03 10:00:00', '+' || id || ' minutes')");
  sqlBoth("UPDATE sessions SET started_at = '2026-03-01 09:00:00'");
  sqlBoth('UPDATE sessions SET summary = ?', `Resumen de sesión muy largo: ${'detalle '.repeat(40)}`);
  sqlBoth("UPDATE user_prompts SET project = '' WHERE id = 4"); // un prompt sin proyecto
  sqlBoth("UPDATE memory_relations SET created_at = '2026-03-04 10:00:00', updated_at = '2026-03-04 10:00:00'");
}

/** Enmascara lo aleatorio y normaliza para comparar. */
function normalize(value) {
  if (typeof value === 'string') {
    return value.replace(/obs-[0-9a-f]{16}/g, 'obs-X').replace(/rel-[0-9a-f]{16}/g, 'rel-X').replace(/prompt-[0-9a-f]{16}/g, 'prompt-X')
      .replaceAll('.engram', '.odin-memory').replaceAll('ENGRAM_PROJECT', 'ODIN_PROJECT').replaceAll('Restart Engram', 'Restart odin');
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  return value;
}

async function same(label, tool, args) {
  const [ref, mine] = await Promise.all([engram.call(tool, args), odinProcess.call(tool, args)]);
  assert.equal(mine.isError, ref.isError, `${label}: isError\n${ref.text}\n${mine.text}`);
  assert.deepEqual(normalize(mine.json ?? mine.text), normalize(ref.json ?? ref.text), label);
}

test('mem_current_project, mem_list_projects, mem_stats y mem_suggest_topic_key', { skip }, async () => {
  const ambiguousParent = join(base, 'ambiguo');
  for (const name of ['uno', 'dos']) {
    mkdirSync(join(ambiguousParent, name), { recursive: true });
    execFileSync('git', ['init', '-q', join(ambiguousParent, name)]);
  }
  await same('proyecto actual', 'mem_current_project', {});
  await same('con directorio', 'mem_current_project', { directory: repo });
  await same('con alias cwd', 'mem_current_project', { cwd: repo });
  await same('ambiguo', 'mem_current_project', { directory: ambiguousParent });
  await same('inexistente', 'mem_current_project', { directory: join(base, 'no-existe') });
  await same('lista de proyectos', 'mem_list_projects', {});
  await same('estadísticas', 'mem_stats', {});
  await same('estadísticas con proyecto', 'mem_stats', { project: PROJECT });
  await same('estadísticas, proyecto desconocido', 'mem_stats', { project: 'desconocido' });
  for (const args of [{ type: 'decision', title: 'Usar SQLite' }, { title: 'Crash en producción' }, { content: 'solo contenido con varias palabras para sugerir' }, { title: 'Decisión de caché' }, {}, { title: '   ' }]) {
    await same(`topic_key ${JSON.stringify(args)}`, 'mem_suggest_topic_key', args);
  }
});

test('mem_search en todas sus variantes', { skip }, async () => {
  for (const args of [
    { query: 'puertos' }, { query: 'redis' }, { query: 'caché', limit: 1 }, { query: 'puertos', response_format: 'compact' },
    { query: 'redis', response_format: 'compact' }, { query: 'palabra' }, { query: 'nada que ver xyz' }, { query: 'db' },
    { query: 'caché', type: 'decision' }, { query: 'editor', scope: 'personal' }, { query: 'editor' }, { query: 'nombres', scope: 'global' },
    { query: 'puertos', project: PROJECT }, { query: 'puertos', all_projects: true }, { query: 'puertos', project: 'desconocido' },
    { query: 'login' }, { query: 'login', response_format: 'compact' }, { query: 'caché' }, { query: 'migración' }, { query: 'migración', response_format: 'compact' },
    { query: 'puertos', match_mode: 'xor' }, { query: 'puertos', response_format: 'raro' }, { query: 'puertos redis', match_mode: 'any' },
    { query: 'hexagonal', project: '  ' }, { query: 'architecture/hexagonal' },
  ]) {
    await same(`mem_search ${JSON.stringify(args)}`, 'mem_search', args);
  }
});

test('mem_search_prompts', { skip }, async () => {
  for (const args of [
    { query: 'pagos' }, { query: 'pagos', limit: 1 }, { query: 'de la' }, { query: 'inexistente' }, {}, { query: '' }, { query: 'pagos', project: '  ' },
    { query: 'pagos', all_projects: true }, { query: 'pagos', all_projects: 'si' }, { query: 'pagos', project: PROJECT, all_projects: true },
    { query: 'pagos', project: 'desconocido' }, { query: 'trigram', all_projects: true },
  ]) {
    await same(`mem_search_prompts ${JSON.stringify(args)}`, 'mem_search_prompts', args);
  }
});

test('mem_get_observation: contenido, historial y errores', { skip }, async () => {
  const versioned = (await engram.call('mem_search', { query: 'versionado', response_format: 'compact' })).json.results[0].id;
  for (const args of [
    { id: 1 }, { id: 3 }, { id: 7 }, { id: 99999 }, {}, { id: 1, project: 'desconocido' },
    { id: versioned, include_history: true }, { id: versioned, include_history: true, history_cursor: 20 }, { id: versioned, include_history: true, history_cursor: -1 },
    { id: versioned, include_history: true, history_cursor: 1.5 }, { id: 1, include_history: true },
  ]) {
    await same(`mem_get_observation ${JSON.stringify(args)}`, 'mem_get_observation', args);
  }
});

test('mem_timeline', { skip }, async () => {
  for (const args of [
    { observation_id: 3 }, { observation_id: 3, before: 1, after: 1 }, { observation_id: 1 }, { observation_id: 8, before: 2, after: 0 },
    { observation_id: 7 }, { observation_id: 7, before: 3, after: 3 },
    {}, { observation_id: 99999 }, { observation_id: 3, project: 'desconocido' },
  ]) {
    await same(`mem_timeline ${JSON.stringify(args)}`, 'mem_timeline', args);
  }
});

test('mem_context', { skip }, async () => {
  for (const args of [
    {}, { compact: true }, { max_bytes: 300 }, { max_bytes: 1500 }, { scope: 'global' }, { scope: 'personal' }, { scope: 'project' },
    { project: PROJECT }, { project: 'desconocido' }, { older_history: true },
  ]) {
    await same(`mem_context ${JSON.stringify(args)}`, 'mem_context', args);
  }
});
