import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goQuote } from '../../../src/mcp/json.js';
import { WRITE_QUEUE_FULL_MESSAGE, WriteQueue, queuedWriteHandler } from '../../../src/mcp/write-queue.js';
import { absolutePathWarning, containsAbsoluteFilesystemPath, truncationWarning } from '../../../src/mcp/warnings.js';

test('goQuote cita como %q de Go', () => {
  assert.equal(goQuote('simple'), '"simple"');
  assert.equal(goQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(goQuote('l1\nl2\tx\r'), '"l1\\nl2\\tx\\r"');
  assert.equal(goQuote('\u0007\b\f\v'), '"\\a\\b\\f\\v"');
  assert.equal(goQuote('\u0001\u007f'), '"\\x01\\x7f"');
  assert.equal(goQuote('añb 日本 😀'), '"añb 日本 😀"'); // imprimible: se conserva
  assert.equal(goQuote('a\u00a0b\u200bc'), '"a\\u00a0b\\u200bc"'); // espacio duro y ancho cero: no imprimibles
  assert.equal(goQuote('\u{E0001}'), '"\\U000e0001"');
  assert.equal(goQuote(''), '""');
  assert.equal(goQuote('\ud800'), '"\ufffd"'); // sustituto suelto
});

test('truncationWarning solo avisa cuando hubo truncamiento', () => {
  assert.equal(truncationWarning({ original_bytes: 5, limit_bytes: 10, truncated: false }), '');
  assert.equal(truncationWarning(null), '');
  assert.equal(
    truncationWarning({ original_bytes: 60000, limit_bytes: 50000, truncated: true }),
    '\n⚠ WARNING: Content was truncated from 60000 to 50000 bytes. Consider splitting into smaller observations.',
  );
});

test('rutas absolutas: se reconocen las habituales y se ignoran URI y rutas relativas', () => {
  const yes = [
    '/usr/local/bin', 'abre /etc/hosts ahora', 'C:\\datos\\x', 'd:/datos/x', '\\\\servidor\\recurso', '(/api/v1)', '"/health"', '/', 'ver /', 'en\n/tmp/x',
    'a:\\b', 'x /y', 'tras ñ /ruta',
  ];
  const no = [
    'src/main.go', 'docs/a.md', 'input/output', 'a/b/c', 'https://example.com/a/b', 'file:///tmp/x', 'ftp://host/x', 'http://localhost:7438/health',
    'a//b', '//cdn.example.com', 'C:fichero', 'sin rutas', '', 'ruta-a/b',
  ];
  for (const text of yes) assert.equal(containsAbsoluteFilesystemPath(text), true, text);
  for (const text of no) assert.equal(containsAbsoluteFilesystemPath(text), false, text);
  assert.match(absolutePathWarning('/tmp/x'), /^\n⚠ WARNING: Content contains an absolute filesystem path/);
  assert.equal(absolutePathWarning('relativo/x'), '');
});

test('la cola de escritura ejecuta en orden de llegada, de una en una', async () => {
  const queue = new WriteQueue(8);
  const events = [];
  const job = (name, ms) => queue.do(async () => {
    events.push(`inicio ${name}`);
    await new Promise((r) => setTimeout(r, ms));
    events.push(`fin ${name}`);
    return name;
  });
  const results = await Promise.all([job('a', 30), job('b', 1), job('c', 1)]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(events, ['inicio a', 'fin a', 'inicio b', 'fin b', 'inicio c', 'fin c']);
});

test('la cola rechaza al llenarse y se recupera al vaciarse', async () => {
  const queue = new WriteQueue(2);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const first = queue.do(() => gate);
  const second = queue.do(() => 'segundo');
  await assert.rejects(queue.do(() => 'tercero'), { message: WRITE_QUEUE_FULL_MESSAGE });
  release('ok');
  assert.deepEqual(await Promise.all([first, second]), ['ok', 'segundo']);
  assert.equal(await queue.do(() => 'después'), 'después');
  assert.equal(new WriteQueue(0).size, 32);
});

test('un fallo del trabajo no bloquea la cola', async () => {
  const queue = new WriteQueue(4);
  await assert.rejects(queue.do(() => {
    throw new Error('boom');
  }), { message: 'boom' });
  assert.equal(await queue.do(() => 'sigue'), 'sigue');
});

test('queuedWriteHandler informa la cola llena como error de herramienta y propaga el resto', async () => {
  const queue = new WriteQueue(1);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const handler = queuedWriteHandler(queue, () => gate);
  const first = handler({});
  const second = await handler({});
  assert.deepEqual(second, { content: [{ type: 'text', text: `MCP write queue error: ${WRITE_QUEUE_FULL_MESSAGE}` }], isError: true });
  release({ content: [{ type: 'text', text: 'listo' }] });
  assert.equal((await first).content[0].text, 'listo');
  const failing = queuedWriteHandler(new WriteQueue(), () => {
    throw new Error('inesperado');
  });
  await assert.rejects(failing({}), { message: 'inesperado' });
});
