// Contraste diferencial del contexto de sesión (`mem_context`) contra el binario de referencia.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  Store, addObservation, addPrompt, createSession, endSession, formatContext, limitContextBytes, pinObservation, stats,
} from '../../src/store/index.js';
import { resolveBinary, startMcp } from './engram-mcp.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';
const SESSION = 'manual-save-odin-memory';

// Antigüedad (días) de cada observación: una ráfaga reciente (cada 1,2 h) que desborda la ventana de las
// 20 más recientes, y luego un reparto hasta casi 3 años.
const BURST = Array.from({ length: 44 }, (_, i) => i * 0.05);
const AGES = [...BURST, 3.5, 4, 5, 6, 7, 8, 10, 12, 13, 15, 17, 19, 20, 22, 25, 28, 30, 35, 45, 60, 75, 90, 110, 140, 170, 200, 260, 330, 400, 500, 700, 900, 1000, 1100, 1200, 1300, 1500, 1900, 2300, 2700, 3100, 3500];
const TYPES = ['manual', 'decision', 'bugfix', 'architecture', 'manual', 'discovery'];
const PINNED = [4, 12, 40];
const GLOBAL = [7, 9, 21, 33, 50];

let engram;
let tmp;
let odin;
let anchor;

const stamp = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const setCreated = (dbPath, table, id, when) => {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.prepare(`UPDATE ${table} SET ${table === 'sessions' ? 'started_at' : 'created_at'} = ? WHERE id = ?`).run(when, id);
  db.close();
};

before(async () => {
  if (!binary) return;
  anchor = new Date();
  engram = startMcp(binary.bin, { cwd: repoRoot });
  tmp = mkdtempSync(join(tmpdir(), 'conformance-odin-'));
  odin = Store.open({ dataDir: join(tmp, 'data'), log: () => {} });
  createSession(odin, SESSION, 'odin-memory', repoRoot, 'project_owned');
  const engramDb = join(engram.dataDir, 'engram.db');
  for (const [i, days] of AGES.entries()) {
    const id = i + 1;
    const o = {
      title: `Observación histórica ${id}: un título deliberadamente largo para ocupar espacio`, content: id % 5 === 0 ? `Contenido largo ${id}: ${'palabra '.repeat(70)}` : `Contenido de la observación ${id} ${'detalle '.repeat(id % 7)}`,
      type: TYPES[i % TYPES.length], ...(GLOBAL.includes(id) && { scope: 'global' }),
    };
    const ref = await engram.call('mem_save', o);
    assert.equal(ref.json.id, id);
    addObservation(odin, { session_id: SESSION, ...o });
    const when = stamp(new Date(anchor.getTime() - days * 86_400_000 - id * 60_000));
    setCreated(engramDb, 'observations', id, when);
    setCreated(odin.dbPath, 'observations', id, when);
  }
  for (const id of PINNED) {
    await engram.call('mem_pin', { id });
    pinObservation(odin, id);
  }
  for (const [i, content] of ['primer prompt', `segundo prompt largo: ${'texto '.repeat(60)}`, 'tercer prompt'].entries()) {
    await engram.call('mem_save_prompt', { content });
    addPrompt(odin, { session_id: SESSION, content });
    const when = stamp(new Date(anchor.getTime() - (i + 1) * 3_600_000));
    setCreated(engramDb, 'user_prompts', i + 1, when);
    setCreated(odin.dbPath, 'user_prompts', i + 1, when);
  }
  const summary = `Resumen largo: ${'detalle '.repeat(50)}`;
  const ended = await engram.call('mem_session_end', { id: SESSION, summary });
  assert.equal(ended.isError, false, ended.text);
  endSession(odin, SESSION, summary);
  const started = stamp(new Date(anchor.getTime() - 1_000 * 86_400_000));
  setCreated(engramDb, 'sessions', SESSION, started);
  setCreated(odin.dbPath, 'sessions', SESSION, started);
});
after(() => {
  engram?.close();
  odin?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  binary?.cleanup();
});

const SCENARIOS = [
  {},
  { compact: true },
  { max_bytes: 100 }, { max_bytes: 500 }, { max_bytes: 1500 }, { max_bytes: 5000 },
  { scope: 'global' }, { scope: 'project' }, { scope: 'personal' },
  { older_history: true },
  { older_history: true, compact: true },
  { older_history: true, max_bytes: 400 }, { older_history: true, max_bytes: 900 }, { older_history: true, max_bytes: 3000 },
  { older_history: true, scope: 'project' }, { older_history: true, scope: 'global' },
];

// Réplica de la lógica de la herramienta: presupuesto total menos el pie de estadísticas.
const DEFAULT_MAX_BYTES = 16_384;
const MAX_BYTES_CEILING = 65_536;
const MAX_PINNED = 20;
const MAX_STATS_PROJECTS = 8;

function handlerLikeContext(store, scenario) {
  const { scope = '', older_history: olderHistory, compact, max_bytes: rawMax } = scenario;
  const maxBytes = Number.isInteger(rawMax) && rawMax > 0 ? Math.min(rawMax, MAX_BYTES_CEILING) : DEFAULT_MAX_BYTES;
  const global = stats(store);
  const projects = global.projects.length === 0 ? 'none'
    : global.projects.length <= MAX_STATS_PROJECTS ? global.projects.join(', ')
      : `${global.projects.slice(0, MAX_STATS_PROJECTS).join(', ')}, +${global.projects.length - MAX_STATS_PROJECTS} more`;
  const suffix = `\n---\nMemory stats: ${global.total_sessions} sessions, ${global.total_observations} observations across projects: ${projects}`;
  const budget = Math.max(1, maxBytes - Buffer.byteLength(suffix));
  const context = formatContext(store, scope === 'personal' ? '' : 'odin-memory', scope, {
    max_bytes: budget, pinned: MAX_PINNED, compact, older_history: olderHistory,
  });
  const clamp = (text) => limitContextBytes(text, maxBytes);
  return clamp(context === '' ? 'No previous session memories found.' : context + suffix);
}

test('el contexto de sesión coincide con la referencia', { skip }, async () => {
  for (const scenario of SCENARIOS) {
    const ref = await engram.call('mem_context', scenario);
    assert.equal(ref.isError, false, ref.text);
    assert.equal(handlerLikeContext(odin, scenario), ref.json.result, `escenario ${JSON.stringify(scenario)}`);
  }
});

test('el historial antiguo del conjunto de datos supera 1 KiB (para ejercitar el presupuesto)', { skip }, () => {
  const text = formatContext(odin, 'odin-memory', '', { older_history: true });
  const older = text.slice(text.indexOf('### Older History'));
  assert.ok(Buffer.byteLength(older) > 1100, `el historial mide ${Buffer.byteLength(older)} bytes`);
  assert.ok(Buffer.byteLength(older) <= 2048);
});
