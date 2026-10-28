// Contraste diferencial de la detección de candidatos de conflicto y de los juicios.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, addObservation, createSession, findCandidates, getRelation, judgeRelation } from '../../src/store/index.js';
import { resolveBinary, startMcp } from './engram-mcp.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';

const CORPUS = [
  { title: 'Redis cache layer' },
  { title: 'Cache strategy for redis' },
  { title: 'Sessions in the browser' },
  { title: 'Redis cache sessions' }, // candidatos: 1 y 2
  { title: 'Cache' },
  { title: 'Cache', content: 'otro contenido para no deduplicar' }, // único término en ambos
  { title: 'Decisión de caché distribuida' },
  { title: 'Caché distribuida para sesiones' }, // comparte dos términos con el anterior
  { title: 'C++ memory model' },
  { title: 'Memory model in C++' },
  { title: 'The and of' }, // solo palabras vacías
  { title: 'Redis cache layer', scope: 'global', content: 'otro ámbito' },
  { title: 'Redis cache layer v2', content: 'segunda versión' },
  { title: 'Hexagonal architecture ports adapters' },
  { title: 'Ports and adapters for hexagonal design' },
  { title: 'Persistencia con SQLite y FTS5' },
  { title: 'Búsqueda FTS5 sobre SQLite' },
  { title: 'Fix: fuga de memoria en el pool' },
  { title: 'Fuga de memoria del pool de conexiones' },
  { title: '日本語 のタイトル です' },
  { title: '日本語 のタイトル でした' },
  // Casos que dependen de las palabras vacías y de la tokenización de + y #.
  { title: 'We implemented cache' },
  { title: 'We implemented cache layer' },
  { title: 'C++ ports' },
  { title: 'C ports' },
  { title: 'C# tooling' },
  { title: 'C tooling' },
];

let engram;
let tmp;
let odin;
before(() => {
  if (!binary) return;
  engram = startMcp(binary.bin, { cwd: repoRoot });
  tmp = mkdtempSync(join(tmpdir(), 'conformance-odin-'));
  odin = Store.open({ dataDir: join(tmp, 'data'), log: () => {} });
  createSession(odin, 'manual-save-odin-memory', 'odin-memory', repoRoot, 'project_owned');
});
after(() => {
  engram?.close();
  odin?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  binary?.cleanup();
});

test('los candidatos de conflicto de cada guardado coinciden con la referencia', { skip }, async () => {
  let judged = 0;
  for (const [i, o] of CORPUS.entries()) {
    const content = o.content ?? `contenido de ${o.title}`;
    const ref = await engram.call('mem_save', { title: o.title, content, type: 'manual', ...(o.scope && { scope: o.scope }) });
    assert.equal(ref.isError, false, ref.text);
    const { id } = addObservation(odin, {
      session_id: 'manual-save-odin-memory', type: 'manual', title: o.title, content, ...(o.scope && { scope: o.scope }),
    });
    assert.equal(id, ref.json.id, `ids desalineados en el caso ${i + 1}`);

    const expected = (ref.json.candidates ?? []).map((c) => ({ id: c.id, title: c.title, score: c.score }));
    const { candidates, errors } = findCandidates(odin, id, {
      project: 'odin-memory', scope: o.scope ?? 'project', require_save_relevance: true,
    });
    assert.deepEqual(errors, []);
    const mine = candidates.map((c) => ({ id: c.id, title: c.title, score: c.score }));
    assert.deepEqual(mine.map((c) => [c.id, c.title]), expected.map((c) => [c.id, c.title]), `candidatos del caso ${i + 1} (${o.title})`);
    for (const [k, c] of mine.entries()) {
      assert.ok(Math.abs(c.score - expected[k].score) <= Math.abs(expected[k].score) * 1e-9, `puntuación ${c.score} vs ${expected[k].score}`);
    }
    assert.equal(ref.json.judgment_required, mine.length > 0);

    // Se juzga el primer candidato en ambos lados para que influya en los guardados siguientes.
    if (mine.length > 0 && judged < 4) {
      judged++;
      const j = await engram.call('mem_judge', { judgment_id: ref.json.candidates[0].judgment_id, relation: 'related', reason: 'x', confidence: 0.7 });
      assert.equal(j.isError, false, j.text);
      const rel = judgeRelation(odin, { judgment_id: candidates[0].judgment_id, relation: 'related', reason: 'x', confidence: 0.7 });
      assert.equal(rel.judgment_status, 'judged');
      assert.deepEqual([rel.relation, rel.reason, rel.confidence], [j.json.relation.relation, j.json.relation.reason, j.json.relation.confidence]);
      assert.equal(getRelation(odin, candidates[0].judgment_id).judgment_status, j.json.relation.judgment_status);
    }
  }
  assert.ok(judged > 0, 'el corpus debe producir al menos un juicio');
});

test('mem_judge con una relación inexistente falla con el mismo mensaje', { skip }, async () => {
  const ref = await engram.call('mem_judge', { judgment_id: 'rel-no-existe', relation: 'related' });
  assert.equal(ref.isError, true);
  assert.throws(() => judgeRelation(odin, { judgment_id: 'rel-no-existe', relation: 'related' }), (err) => ref.text.includes(err.message));
});
