import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { McpServer } from '../../../src/mcp/protocol.js';
import { runMcp } from '../../../src/mcp/run.js';

const server = (handler) => new McpServer({
  name: 's', version: '1', tools: [{ definition: { name: 't', description: 't', inputSchema: { type: 'object' } }, handler }],
});
const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: {} } };

test('runMcp termina por EOF tras atender las peticiones en curso', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c));
  const processRef = new EventEmitter();
  const running = runMcp(server(async () => {
    await new Promise((r) => setTimeout(r, 40));
    return { content: [{ type: 'text', text: 'hecho' }] };
  }), { input, output, processRef, log: () => {} });
  input.write(`${JSON.stringify(call)}\n`);
  input.end();
  assert.equal(await running, 'eof');
  assert.equal(JSON.parse(Buffer.concat(chunks).toString()).result.content[0].text, 'hecho');
  assert.equal(processRef.listenerCount('SIGINT'), 0); // los manejadores de señal se retiran
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
});

test('runMcp termina por SIGTERM o SIGINT sin esperar a una petición colgada', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const processRef = new EventEmitter();
    const logs = [];
    const input = new PassThrough();
    const running = runMcp(server(() => new Promise(() => {})), { input, output: new PassThrough(), processRef, graceMs: 60_000, log: (m) => logs.push(m) });
    input.write(`${JSON.stringify(call)}\n`);
    await new Promise((r) => setTimeout(r, 20));
    const start = Date.now();
    processRef.emit(signal);
    assert.equal(await running, 'signal');
    assert.ok(Date.now() - start < 500);
    assert.deepEqual(logs, ['[odin] shutting down...']);
    assert.equal(processRef.listenerCount(signal), 0);
  }
});

test('runMcp con EOF respeta el plazo de gracia ante una petición colgada', async () => {
  const input = new PassThrough();
  const running = runMcp(server(() => new Promise(() => {})), { input, output: new PassThrough(), processRef: new EventEmitter(), graceMs: 50, log: () => {} });
  input.write(`${JSON.stringify(call)}\n`);
  input.end();
  const start = Date.now();
  assert.equal(await running, 'eof');
  assert.ok(Date.now() - start < 1500);
});
