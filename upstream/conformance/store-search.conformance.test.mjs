// Contraste diferencial de búsqueda, línea de tiempo y prompts contra el binario de referencia.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  Store, addObservation, addPrompt, createSession, pinObservation, searchObservationPreviews, searchObservations,
  searchPrompts, timeline,
} from '../../src/store/index.js';
import { resolveBinary, startMcp } from './engram-mcp.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';

const OBSERVATIONS = [
  { title: 'Arquitectura hexagonal', content: 'puertos y adaptadores para la capa de dominio', type: 'architecture', topic_key: 'architecture/hexagonal' },
  { title: 'Bug en login', content: 'el login falla con puertos cerrados', type: 'bugfix' },
  { title: 'Decisión de caché', content: 'usamos Redis como caché distribuida para sesiones', type: 'decision' },
  { title: 'Persistencia SQLite', content: 'WAL y FTS5 para búsqueda de texto completo', type: 'architecture' },
  { title: 'Configuración de CI', content: 'pipeline en GitHub Actions con caché de dependencias', type: 'config' },
  { title: 'Convención de nombres', content: 'handlers terminan en Handler; puertos en Port', type: 'pattern' },
  { title: 'Hallazgo: fuga de memoria', content: 'el pool de conexiones no liberaba los puertos', type: 'discovery' },
  { title: 'Preferencia de editor', content: 'el equipo prefiere tabulaciones de 2 espacios', type: 'preference' },
  { title: 'Política de ramas', content: 'ramas cortas, merge por pull request, sin force push', type: 'policy' },
  { title: 'DB migrations', content: 'las migraciones son idempotentes y se aplican al arrancar', type: 'decision' },
  { title: 'API REST', content: 'versionado en la ruta: /v1/observaciones', type: 'architecture', topic_key: 'architecture/api-rest' },
  { title: 'Notas de la reunión', content: 'se habló de caché, puertos y de la migración a Postgres', type: 'manual' },
  { title: 'Índice trigram', content: 'el tokenizador trigram no soporta términos de menos de tres caracteres', type: 'discovery' },
  { title: 'Cache invalidation', content: 'there are only two hard things: cache invalidation and naming', type: 'learning' },
  { title: 'Seguridad: tokens', content: 'los tokens se comparan en tiempo constante', type: 'policy' },
  { title: 'Rendimiento de búsqueda', content: 'bm25 con pesos de título 5 y contenido 1', type: 'architecture' },
  { title: 'Puertos de red', content: 'el servidor HTTP escucha en el puerto 7438', type: 'config' },
  { title: 'Retrospectiva', content: 'qué salió bien: tests; qué mejorar: documentación de puertos', type: 'manual' },
  { title: '100% cobertura', content: 'la cobertura al 100% no garantiza calidad', type: 'learning' },
  { title: 'snake_case y camelCase', content: 'los payloads JSON usan snake_case', type: 'pattern' },
  // Gemelos: mismo texto, solo difieren en fijado, duplicados o revisiones (el orden depende de los refuerzos).
  { title: 'Gemelo', content: 'texto gemelo idéntico', type: 'twin-a' }, // 21: fijado
  { title: 'Gemelo', content: 'texto gemelo idéntico', type: 'twin-b' }, // 22: duplicate_count 3
  { title: 'Gemelo', content: 'texto gemelo idéntico', type: 'twin-c', topic_key: 'twin/c' }, // 23: revision_count 2
  { title: 'Gemelo', content: 'texto gemelo idéntico', type: 'twin-d' }, // 24: sin nada
  { title: 'Gemelo', content: 'texto gemelo idéntico', type: 'twin-e' }, // 25: duplicate_count 2
  { title: 'Gemelo', content: 'texto gemelo idéntico', type: 'twin-f' }, // 26: visto hace 10 días
  { title: 'Gemelo', content: 'texto gemelo idéntico', type: 'twin-g' }, // 27: visto hace 90 días
  { title: 'Gemelo', content: 'texto gemelo idéntico', type: 'twin-h' }, // 28: visto hace 365 días
];
const AGED = [[26, 10], [27, 90], [28, 365]]; // [posición, días]
const PINNED = [3, 11, 21]; // posiciones (base 1)
const REPEATS = [2, 4, 22, 22, 23, 25]; // se vuelven a guardar tal cual (duplicate_count; con topic_key, revision_count)
const UPDATED = [1, 11]; // observaciones con topic_key que se re-guardan (revision_count)

const QUERIES = [
  { query: 'puertos' }, { query: 'caché' }, { query: 'cache' }, { query: 'hexagonal' }, { query: 'adaptadores puertos' },
  { query: 'adaptadores puertos', match_mode: 'any' }, { query: 'caché puertos migración', match_mode: 'any' },
  { query: 'db' }, { query: 'db migraciones' }, { query: '100%' }, { query: 'snake_case' }, { query: 'v1' },
  { query: 'architecture/hexagonal' }, { query: 'architecture/api-rest' }, { query: 'architecture/ap' },
  { query: 'puertos', type: 'bugfix' }, { query: 'puertos', type: 'config' }, { query: 'caché', scope: 'project' },
  { query: 'caché', project: 'ODIN-MEMORY' }, { query: 'puertos', limit: 3 },
  { query: 'trigram' }, { query: 'tokenizador trigram caracteres' }, { query: 'bm25' }, { query: 'equipo' },
  { query: 'sqlite fts5' }, { query: 'GitHub Actions' }, { query: 'naming' }, { query: 'búsqueda' }, { query: 'busqueda' },
  { query: 'redis' }, { query: 'gemelo' }, { query: 'texto gemelo' }, { query: 'gemelo', limit: 2 }, { query: '"puertos"' }, { query: 'puer"tos' },
];

let engram;
let tmp;
let odin;
before(async () => {
  if (!binary) return;
  engram = startMcp(binary.bin, { cwd: repoRoot });
  tmp = mkdtempSync(join(tmpdir(), 'conformance-odin-'));
  odin = Store.open({ dataDir: join(tmp, 'data'), log: () => {} });
  createSession(odin, 'manual-save-odin-memory', 'odin-memory', repoRoot, 'project_owned');
  const ids = [];
  for (const [i, o] of OBSERVATIONS.entries()) {
    const ref = await engram.call('mem_save', { ...o });
    const mine = addObservation(odin, { session_id: 'manual-save-odin-memory', ...o });
    assert.equal(mine.id, ref.json.id, `ids desalineados en ${i + 1}`);
    ids.push(mine.id);
  }
  for (const pos of REPEATS) {
    const o = OBSERVATIONS[pos - 1];
    await engram.call('mem_save', { ...o });
    addObservation(odin, { session_id: 'manual-save-odin-memory', ...o });
  }
  for (const pos of UPDATED) {
    const o = { ...OBSERVATIONS[pos - 1], content: `${OBSERVATIONS[pos - 1].content} (revisado)` };
    await engram.call('mem_save', o);
    addObservation(odin, { session_id: 'manual-save-odin-memory', ...o });
  }
  // Envejece las filas directamente en ambas bases para ejercitar el refuerzo por recencia.
  const age = (dbPath, id, days) => {
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    db.prepare("UPDATE observations SET last_seen_at = datetime('now', ?), updated_at = datetime('now', ?), created_at = datetime('now', ?) WHERE id = ?").run(`-${days} days`, `-${days} days`, `-${days} days`, id);
    db.close();
  };
  for (const [pos, days] of AGED) {
    age(join(engram.dataDir, 'engram.db'), pos, days);
    age(odin.dbPath, pos, days);
  }
  for (const pos of PINNED) {
    const ref = await engram.call('mem_pin', { id: pos });
    assert.equal(ref.isError, false, ref.text);
    pinObservation(odin, pos);
  }
});
after(() => {
  engram?.close();
  odin?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  binary?.cleanup();
});

const refIds = async (args) => {
  const res = await engram.call('mem_search', { ...args, response_format: 'compact' });
  assert.equal(res.isError, false, res.text);
  return (res.json.results ?? []).map((r) => r.id);
};

test('el orden de los resultados de búsqueda coincide con la referencia', { skip }, async () => {
  for (const q of QUERIES) {
    const { query, ...rest } = q;
    const expected = await refIds({ query, ...rest });
    const mine = searchObservationPreviews(odin, query, rest).map((r) => r.id);
    assert.deepEqual(mine, expected, `consulta ${JSON.stringify(q)}`);
    const full = searchObservations(odin, query, rest).map((r) => r.id);
    assert.deepEqual(full, expected, `consulta (completa) ${JSON.stringify(q)}`);
  }
});

const PROMPTS = [
  'refactoriza el módulo de pagos', 'documenta la API de pagos', 'añade tests de integración para el login',
  'explica por qué falla el pipeline de CI', 'migra la base de datos a Postgres', 'revisa el diseño de la caché',
  'qué hace el índice trigram', 'corrige el bug en db', 'optimiza las consultas de búsqueda',
];
const PROMPT_QUERIES = ['pagos', 'factoriz', 'login', 'pipeline', 'db', 'de la', 'trigram', 'búsqueda', 'consultas búsqueda', 'inexistente'];

test('la búsqueda de prompts coincide con la referencia', { skip }, async () => {
  createSession(odin, 'prompts-conf', 'odin-memory', repoRoot);
  for (const content of PROMPTS) {
    const ref = await engram.call('mem_save_prompt', { content });
    assert.equal(ref.isError, false, ref.text);
    addPrompt(odin, { session_id: 'prompts-conf', content });
  }
  for (const query of PROMPT_QUERIES) {
    const res = await engram.call('mem_search_prompts', { query });
    assert.equal(res.isError, false, res.text);
    const expected = (res.json.results ?? []).map((r) => r.content);
    const mine = searchPrompts(odin, query).map((p) => p.content);
    assert.deepEqual(mine, expected, `prompts: ${query}`);
  }
});

test('la línea de tiempo devuelve los mismos vecinos', { skip }, async () => {
  const idsIn = (section) => [...section.matchAll(/^\s+#(\d+) /gm)].map((m) => Number(m[1]));
  for (const [id, before_, after_] of [[10, 2, 2], [1, 3, 3], [20, 5, 5], [12, 1, 4], [7, 0, 0]]) {
    const res = await engram.call('mem_timeline', { observation_id: id, before: before_, after: after_ });
    assert.equal(res.isError, false, res.text);
    const text = res.json.result;
    const total = Number(text.match(/Total observations in session: (\d+)/)[1]);
    const [head, afterPart = ''] = text.split('─── After ───');
    const beforePart = (head.split('─── Before ───')[1] ?? '').split('>>>')[0];
    const mine = timeline(odin, id, before_, after_);
    assert.deepEqual(mine.before.map((e) => e.id), idsIn(beforePart), `antes de #${id}`);
    assert.deepEqual(mine.after.map((e) => e.id), idsIn(afterPart), `después de #${id}`);
    assert.equal(mine.total_in_range, total, `total para #${id}`);
  }
});
