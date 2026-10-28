// Pruebas diferenciales: el mismo escenario contra el binario de engram y contra odin.
// Requieren ENGRAM_BIN (binario) o ENGRAM_SRC (checkout para compilar); sin ellos se omiten.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeProjectName } from '../../src/project/canonical.js';
import { Store, addObservation, createSession, getObservation, stripPrivateTags, suggestTopicKey, truncateContent } from '../../src/store/index.js';
import { resolveBinary, startMcp } from './engram-mcp.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';

let engram;
let tmp;
let odin;
before(() => {
  if (!binary) return;
  // El cwd de engram debe ser un repositorio git para autodetectar el proyecto.
  engram = startMcp(binary.bin, { cwd: repoRoot });
  tmp = mkdtempSync(join(tmpdir(), 'conformance-odin-'));
  odin = Store.open({ dataDir: join(tmp, 'data'), log: () => {} });
  createSession(odin, 'conf', 'odin-memory', repoRoot);
});
after(() => {
  engram?.close();
  odin?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  binary?.cleanup();
});

const TOPIC_CASES = [
  ['architecture', 'Hexagonal Boundary', ''],
  ['bugfix', 'Bug: login crash', ''],
  ['decision', 'decision', ''],
  ['decision', 'Decisión de caché', ''],
  ['decision', 'Decisión de cache', ''],
  ['manual', '', 'uno dos tres cuatro cinco seis siete ocho nueve diez'],
  // ['manual', '', ''] lo rechaza la herramienta MCP ("provide title or content") antes de llegar a la función: se cubre en F3.
  ['manual', 'Crash in prod', ''],
  ['manual', 'Algo sobre diseño', 'texto'],
  ['nota', 'Algo', ''],
  ['', 'Sin tipo ni pistas', ''],
  ['pattern', 'Naming   conventions   for   handlers', ''],
  ['config', 'CI: pipeline & Docker setup!!', ''],
  ['discovery', 'Root cause found', ''],
  ['learning', 'Lo aprendido hoy', 'learned a lot'],
  ['session_summary', 'Resumen de la sesión', ''],
  ['manual', 'Título <private>secreto</private> público', ''],
  ['manual', '日本語のタイトル', ''],
  ['manual', 'Emoji 😀 title', ''],
  ['manual', 'a'.repeat(300), ''],
  ['architecture', `architecture-${'x'.repeat(200)}`, ''],
  ['manual', '', '日本語 の 内容 です これは テスト'],
  ['bug', 'Fix: ÁÉÍÓÚ ñ ü', ''],
  ['  Decision  ', '  espacios   ', ''],
  ['adr', 'ADR-0007: Use Postgres', ''],
  ['manual', 'error handling in the parser', ''],
  ['manual', 'We chose Redis over Memcached', ''],
  ['manual', 'Set up the environment variables', ''],
];

test('suggestTopicKey coincide con la herramienta de referencia', { skip }, async () => {
  for (const [type, title, content] of TOPIC_CASES) {
    const res = await engram.call('mem_suggest_topic_key', { type, title, content });
    const expected = res.text.replace(/^Suggested topic_key: /, '');
    assert.equal(suggestTopicKey(type, title, content), expected, JSON.stringify({ type, title, content }));
  }
});

const PROJECT_CASES = ['  Mi--App__X ', 'MAYÚSCULAS', 'a----b____c', 'Café-Bar', 'ñandú', ' nbsp ', 'tab\tinside', 'Ünïcödé--Ñ', 'x_-_y'];

test('canonicalizeProjectName coincide con la normalización de la referencia', { skip }, async () => {
  for (const raw of PROJECT_CASES) {
    const res = await engram.call('mem_save', { title: 't', content: 'c', type: 'manual', project: raw });
    const message = res.json?.message ?? '';
    const expected = canonicalizeProjectName(raw);
    // Si el nombre es inválido para la referencia, el caso no aplica a la canonicalización.
    if (!message.includes('is not backed by known context')) continue;
    assert.ok(message.includes(`Project ${JSON.stringify(expected)} `), `${JSON.stringify(raw)} → esperado ${JSON.stringify(expected)}; referencia: ${message}`);
  }
});

const aOf = (n) => 'a'.repeat(n);
const CONTENT_CASES = [
  ['T1', 'clave=<private>x</private> fin'],
  ['T2', 'a <PRIVATE>multi\nlinea</Private> b <private>z</private> c'],
  ['T3', 'sin cerrar <private>abierto'],
  ['T4', 'anidado <private>uno <private>dos</private> tres</private> fin'],
  ['T5', ` espacios nbsp `],
  ['T6', `﻿con bom al inicio`],
  ['T7', `${aOf(49999)}é`], // la 'é' cruza el límite de 50000 bytes
  ['T8', `${aOf(49998)}é`], // cabe justo
  ['T9', `${aOf(49997)}😀`], // el emoji cruza el límite
  ['T10', `${aOf(50000)}`], // exactamente en el límite
  ['T11', `${aOf(50001)}`], // un byte de más
  ['T12', 'é'.repeat(25001)],
  ['Título <private>oculto</private> visible', 'contenido normal'],
  ['  título con espacios  ', '  contenido con espacios  '],
];

test('el contenido y el título guardados coinciden con la referencia', { skip }, async () => {
  for (const [i, [title, content]] of CONTENT_CASES.entries()) {
    const unique = `${title} #${i}`;
    const saved = await engram.call('mem_save', { title: unique, content, type: 'manual' });
    assert.equal(saved.isError, false, saved.text);
    const got = await engram.call('mem_get_observation', { id: saved.json.id });
    const body = got.json.result;
    const head = body.indexOf('\n');
    const tail = body.lastIndexOf('\nSession: ');
    const expectedContent = body.slice(head + 1, tail);
    const expectedTitle = body.slice(body.indexOf('] ') + 2, head);

    const { id } = addObservation(odin, { session_id: 'conf', type: 'manual', title: unique, content });
    const mine = getObservation(odin, id);
    assert.equal(mine.title, expectedTitle, `título del caso ${i}`);
    assert.equal(mine.content, expectedContent, `contenido del caso ${i} (${title})`);
    assert.equal(mine.content, truncateContent(stripPrivateTags(content), 50_000));
  }
});

async function refRow(id) {
  const got = await engram.call('mem_get_observation', { id });
  const body = got.json.result;
  return {
    duplicates: Number(body.match(/\nDuplicates: (\d+)/)[1]),
    revisions: Number(body.match(/\nRevisions: (\d+)/)[1]),
  };
}

test('deduplicación y upsert por topic_key se comportan igual', { skip }, async () => {
  // Deduplicación: variaciones de mayúsculas y espacios del mismo contenido.
  const a = await engram.call('mem_save', { title: 'Dedupe', content: 'Hola   Mundo', type: 'manual' });
  const b = await engram.call('mem_save', { title: 'Dedupe', content: 'hola mundo', type: 'manual' });
  assert.equal(a.json.id, b.json.id);
  const refDup = await refRow(a.json.id);
  const m1 = addObservation(odin, { session_id: 'conf', type: 'manual', title: 'Dedupe', content: 'Hola   Mundo' });
  const m2 = addObservation(odin, { session_id: 'conf', type: 'manual', title: 'Dedupe', content: 'hola mundo' });
  assert.equal(m1.id, m2.id);
  const mine = getObservation(odin, m1.id);
  assert.deepEqual({ duplicates: mine.duplicate_count, revisions: mine.revision_count }, refDup);

  // topic_key: la segunda llamada actualiza en el sitio.
  await engram.call('mem_save', { title: 'Tema v1', content: 'primera', type: 'manual', topic_key: 'Arq / Auth' });
  const t2 = await engram.call('mem_save', { title: 'Tema v2', content: 'segunda', type: 'manual', topic_key: 'arq / auth' });
  const refTopic = await refRow(t2.json.id);
  addObservation(odin, { session_id: 'conf', type: 'manual', title: 'Tema v1', content: 'primera', topic_key: 'Arq / Auth' });
  const mt = addObservation(odin, { session_id: 'conf', type: 'manual', title: 'Tema v2', content: 'segunda', topic_key: 'arq / auth' });
  const mineTopic = getObservation(odin, mt.id);
  assert.deepEqual({ duplicates: mineTopic.duplicate_count, revisions: mineTopic.revision_count }, refTopic);
  assert.equal(mineTopic.topic_key, 'arq-/-auth');
});
