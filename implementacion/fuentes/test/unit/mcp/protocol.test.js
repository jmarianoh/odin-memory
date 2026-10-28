import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from '../../../src/mcp/protocol.js';

const tool = (name, handler) => ({ definition: { name, description: name, inputSchema: { type: 'object' } }, handler });
const make = (tools = [], extra = {}) => new McpServer({ name: 'srv', version: '1.2.3', instructions: 'guía', tools, ...extra });
const call = (server, method, params, id = 1) => server.handle({ jsonrpc: '2.0', id, method, params });

test('initialize negocia la versión y anuncia nombre, capacidades e instrucciones', async () => {
  const server = make();
  const res = await call(server, 'initialize', { protocolVersion: '2025-03-26' });
  assert.deepEqual(res, {
    jsonrpc: '2.0', id: 1,
    result: {
      protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'srv', version: '1.2.3' }, instructions: 'guía',
    },
  });
  assert.equal((await call(server, 'initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.equal((await call(server, 'initialize', {})).result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.equal('instructions' in (await call(make([], { instructions: '' }), 'initialize', {})).result, false);
});

test('ping, notificaciones y métodos desconocidos', async () => {
  const server = make();
  assert.deepEqual(await call(server, 'ping'), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await call(server, 'resources/list')).error.code, -32601);
  assert.equal((await server.handle({ id: 4, method: 'ping' })).error.code, -32600); // falta jsonrpc
  assert.equal((await server.handle(null)).error.code, -32600);
  assert.equal((await server.handle([1])).error.code, -32600);
  assert.equal((await call(server, 'ping', undefined, 'texto')).id, 'texto');
});

test('tools/list devuelve las definiciones ordenadas por nombre', async () => {
  const server = make([tool('b_tool'), tool('a_tool'), tool('c_tool')]);
  const { result } = await call(server, 'tools/list');
  assert.deepEqual(result.tools.map((t) => t.name), ['a_tool', 'b_tool', 'c_tool']);
});

test('tools/call ejecuta el manejador, tolera async y convierte excepciones en error de herramienta', async () => {
  const server = make([
    tool('eco', (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] })),
    tool('lento', async () => ({ content: [{ type: 'text', text: 'hecho' }] })),
    tool('falla', () => {
      throw new Error('boom');
    }),
  ]);
  assert.equal((await call(server, 'tools/call', { name: 'eco', arguments: { a: 1 } })).result.content[0].text, '{"a":1}');
  assert.equal((await call(server, 'tools/call', { name: 'eco' })).result.content[0].text, '{}'); // sin argumentos
  assert.equal((await call(server, 'tools/call', { name: 'lento', arguments: {} })).result.content[0].text, 'hecho');
  const failed = await call(server, 'tools/call', { name: 'falla', arguments: {} });
  assert.deepEqual(failed.result, { content: [{ type: 'text', text: 'Internal error: boom' }], isError: true });
  const unknown = await call(server, 'tools/call', { name: 'nada', arguments: {} });
  assert.deepEqual(unknown.error, { code: -32602, message: "tool 'nada' not found" });
  for (const bad of [[], 'texto', 7]) {
    assert.equal((await call(server, 'tools/call', { name: 'eco', arguments: bad })).error.code, -32602);
  }
  assert.equal((await call(server, 'tools/call', { name: 'eco', arguments: null })).result.content[0].text, '{}'); // null equivale a ausente
  assert.equal((await call(server, 'tools/call', {})).error.code, -32602);
});

async function runStream(server, lines, { closeAfterWrite = true } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c));
  const done = server.serve({ input, output, graceMs: 2000 });
  for (const line of lines) input.write(`${line}\n`);
  if (closeAfterWrite) input.end();
  await done;
  return Buffer.concat(chunks).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('serve: responde en orden, ignora líneas vacías y notificaciones, y avisa de JSON inválido', async () => {
  const order = [];
  const server = make([
    tool('lenta', async () => {
      await new Promise((r) => setTimeout(r, 40));
      order.push('lenta');
      return { content: [{ type: 'text', text: 'lenta' }] };
    }),
    tool('rapida', () => {
      order.push('rapida');
      return { content: [{ type: 'text', text: 'rapida' }] };
    }),
  ]);
  const responses = await runStream(server, [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lenta', arguments: {} } }),
    '',
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rapida', arguments: {} } }),
    '{no es json',
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
  ]);
  assert.deepEqual(order, ['lenta', 'rapida']); // el orden de llegada se respeta
  assert.deepEqual(responses.map((r) => r.id), [1, 2, null, 3]);
  assert.equal(responses[2].error.code, -32700);
});

test('serve: al cerrarse la entrada espera a las peticiones en curso', async () => {
  const server = make([tool('tarda', async () => {
    await new Promise((r) => setTimeout(r, 80));
    return { content: [{ type: 'text', text: 'ok' }] };
  })]);
  const responses = await runStream(server, [JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'tarda', arguments: {} } })]);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.content[0].text, 'ok');
});

test('serve: el plazo de gracia evita esperar para siempre una petición colgada', async () => {
  const server = make([tool('colgada', () => new Promise(() => {}))]);
  const input = new PassThrough();
  const output = new PassThrough();
  const done = server.serve({ input, output, graceMs: 60 });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'colgada', arguments: {} } })}\n`);
  input.end();
  const start = Date.now();
  await done;
  assert.ok(Date.now() - start < 1500);
});

test('serve: una señal de apagado termina al instante, sin esperar a peticiones colgadas', async () => {
  const server = make([tool('colgada', () => new Promise(() => {}))]);
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const done = server.serve({ input, output, graceMs: 60_000, signal: controller.signal });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'colgada', arguments: {} } })}\n`);
  await new Promise((r) => setTimeout(r, 20));
  const start = Date.now();
  controller.abort();
  await done;
  assert.ok(Date.now() - start < 500);
  // con la señal ya abortada ni siquiera empieza
  const again = new AbortController();
  again.abort();
  await make().serve({ input: new PassThrough(), output: new PassThrough(), signal: again.signal });
});
