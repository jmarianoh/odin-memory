import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTool, cleanMarkdown, createSession, extractLearnings, getObservation, passiveCapture } from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

test('cleanMarkdown quita negritas, código y cursivas y colapsa espacios', () => {
  assert.equal(cleanMarkdown('  **Usar** `node:sqlite`   en *lugar* de drivers  '), 'Usar node:sqlite en lugar de drivers');
  assert.equal(cleanMarkdown('sin formato'), 'sin formato');
});

test('extractLearnings: lista numerada, viñetas, longitud y palabras mínimas', () => {
  const numbered = `# Resumen\n\n## Key Learnings:\n\n1. La caché debe invalidarse al cambiar el esquema\n2. corto\n3) Usar **FTS5 trigram** para subcadenas útiles\n\n## Otra sección\n1. Esto no cuenta porque está fuera de la sección`;
  assert.deepEqual(extractLearnings(numbered), [
    'La caché debe invalidarse al cambiar el esquema',
    'Usar FTS5 trigram para subcadenas útiles',
  ]);
  const bullets = '### Aprendizajes Clave\n- Los reintentos deben usar espera exponencial\n* `WAL` permite lectores y un escritor\n- muy corto';
  assert.deepEqual(extractLearnings(bullets), ['Los reintentos deben usar espera exponencial', 'WAL permite lectores y un escritor']);
  // si hay lista numerada válida, las viñetas se ignoran
  assert.deepEqual(extractLearnings('## Learnings\n1. Primer aprendizaje con suficientes palabras\n- Viñeta ignorada porque hay numeradas'), ['Primer aprendizaje con suficientes palabras']);
  assert.deepEqual(extractLearnings('## Learning\n- Una viñeta con suficientes palabras largas'), ['Una viñeta con suficientes palabras largas']);
});

test('extractLearnings: usa la última sección con elementos y exige 20 bytes y 4 palabras', () => {
  const text = '## Learnings\n- Primera sección con contenido válido aquí\n\n## Learnings\n- tres palabras ok\n';
  assert.deepEqual(extractLearnings(text), ['Primera sección con contenido válido aquí']);
  assert.deepEqual(extractLearnings('## Learnings\n- exactamente cuatro palabras x'), ['exactamente cuatro palabras x']);
  assert.deepEqual(extractLearnings('## Learnings\n- a b c d'), []); // 4 palabras pero < 20 bytes
  assert.deepEqual(extractLearnings('sin encabezado\n- una viñeta cualquiera con palabras'), []);
  assert.deepEqual(extractLearnings('## Learnings extra\n- no es el encabezado exacto del formato'), []);
});

test('passiveCapture guarda aprendizajes como observaciones passive y omite duplicados', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'proj', '/d');
  const content = '## Key Learnings:\n1. Los reintentos deben usar espera exponencial\n2. WAL permite lectores concurrentes con un escritor\n';
  const first = passiveCapture(store, { session_id: 's1', content, project: 'Proj', source: 'subagent-stop' });
  assert.deepEqual(first, { extracted: 2, saved: 2, duplicates: 0 });
  const row = store.db.get("SELECT * FROM observations WHERE type = 'passive' ORDER BY id LIMIT 1");
  assert.deepEqual([row.project, row.scope, row.tool_name, row.content, row.title], ['proj', 'project', 'subagent-stop', 'Los reintentos deben usar espera exponencial', 'Los reintentos deben usar espera exponencial']);
  const again = passiveCapture(store, { session_id: 's1', content, project: 'proj' });
  assert.deepEqual(again, { extracted: 2, saved: 0, duplicates: 2 });
  assert.deepEqual(passiveCapture(store, { session_id: 's1', content: 'nada que extraer' }), { extracted: 0, saved: 0, duplicates: 0 });
});

test('passiveCapture acorta títulos a 60 bytes sin partir caracteres', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'proj', '/d');
  const long = `${'palabra '.repeat(12)}final`;
  passiveCapture(store, { session_id: 's1', content: `## Learnings\n- ${long}`, project: 'proj' });
  const o = getObservation(store, 1);
  assert.equal(o.title, `${long.slice(0, 60)}...`);
  assert.equal(o.content, long);
  const accents = 'é'.repeat(40); // 80 bytes
  passiveCapture(store, { session_id: 's1', content: `## Learnings\n- ${accents} y más palabras`, project: 'proj' });
  assert.equal(getObservation(store, 2).title, `${'é'.repeat(30)}...`);
});

test('passiveCapture informa del progreso si un guardado falla', (t) => {
  const store = openTempStore(t);
  const content = '## Learnings\n- Un aprendizaje con suficientes palabras\n';
  assert.throws(
    () => passiveCapture(store, { session_id: 'no-existe', content, project: '' }),
    (err) => err.code === 'passive_capture_failed' && err.result.extracted === 1 && err.result.saved === 0,
  );
});

test('classifyTool', () => {
  assert.deepEqual(['write', 'edit', 'patch'].map(classifyTool), ['file_change', 'file_change', 'file_change']);
  assert.equal(classifyTool('bash'), 'command');
  assert.deepEqual(['read', 'view'].map(classifyTool), ['file_read', 'file_read']);
  assert.deepEqual(['grep', 'glob', 'ls'].map(classifyTool), ['search', 'search', 'search']);
  assert.equal(classifyTool('otra'), 'tool_use');
});

test('passiveCapture corta el título en una frontera UTF-8 completa', (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'proj', '/d');
  // 25 letras de 2 bytes: el byte 60 cae en mitad de «é» y 3 palabras mínimas se cumplen de sobra.
  const learning = `${'é'.repeat(25)} ${'ñ'.repeat(10)} y más palabras de relleno suficientes`;
  passiveCapture(store, { session_id: 's1', content: `## Key Learnings:\n1. ${learning}\n`, project: 'proj', source: 'subagent-stop' });
  const { title } = store.db.get("SELECT title FROM observations WHERE type = 'passive'");
  assert.ok(title.endsWith('...'));
  assert.ok(!title.includes('�'), 'sin caracteres de reemplazo');
  assert.ok(Buffer.byteLength(title.slice(0, -3)) <= 60);
  assert.equal(Buffer.from(title, 'utf8').toString('utf8'), title);
});
