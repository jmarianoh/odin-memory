import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeEqual } from '../../../src/server/auth.js';
import { DecodeError, decodeBody, firstJsonValue, pickFields } from '../../../src/server/decode.js';
import { parseBool, queryBool, queryInt } from '../../../src/server/http.js';
import { Router } from '../../../src/server/router.js';
import { cleanPath } from '../../../src/server/server.js';
import { trustedSocketDirectory } from '../../../src/server/unix-socket.js';

test('el enrutador prefiere el segmento literal al comodín y reporta métodos', () => {
  const router = new Router();
  router.add('GET /items/{id}', 'comodín');
  router.add('GET /items/recent', 'literal');
  router.add('DELETE /items/{id}', 'borrar');
  router.add('POST /items/{id}/pin', 'fijar');
  assert.equal(router.match('GET', '/items/recent').route.handler, 'literal');
  assert.deepEqual(router.match('GET', '/items/7').params, { id: '7' });
  assert.equal(router.match('HEAD', '/items/7').route.handler, 'comodín');
  assert.equal(router.match('DELETE', '/items/7').route.handler, 'borrar');
  assert.deepEqual(router.match('PUT', '/items/7'), { kind: 'method', allow: ['DELETE', 'GET', 'HEAD'] });
  assert.deepEqual(router.match('GET', '/nada'), { kind: 'none' });
  assert.deepEqual(router.match('GET', '/items/'), { kind: 'none' });
  assert.deepEqual(router.match('GET', '/items/7/pin/x'), { kind: 'none' });
  assert.deepEqual(router.match('POST', '/items/a%20b/pin').params, { id: 'a b' });
  assert.deepEqual(router.match('POST', '/items/%E0%A4/pin').params, { id: '%E0%A4' });
});

test('cleanPath resuelve barras repetidas y puntos conservando la barra final', () => {
  assert.equal(cleanPath('/a//b'), '/a/b');
  assert.equal(cleanPath('/a/./b'), '/a/b');
  assert.equal(cleanPath('/a/b/../c'), '/a/c');
  assert.equal(cleanPath('/a/b/'), '/a/b/');
  assert.equal(cleanPath('/../a'), '/a');
  assert.equal(cleanPath('/'), '/');
  assert.equal(cleanPath('//'), '/');
  assert.equal(cleanPath('/health'), '/health');
});

test('constantTimeEqual compara por contenido y longitud', () => {
  assert.equal(constantTimeEqual('secreto', 'secreto'), true);
  assert.equal(constantTimeEqual('secreto', 'secretO'), false);
  assert.equal(constantTimeEqual('secreto', 'secret'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual('é', 'é'), true);
});

test('parseBool y los parámetros de consulta siguen las reglas de ParseBool', () => {
  for (const yes of ['1', 't', 'T', 'TRUE', 'true', 'True']) assert.equal(parseBool(yes), true, yes);
  for (const no of ['0', 'f', 'F', 'FALSE', 'false', 'False']) assert.equal(parseBool(no), false, no);
  for (const bad of ['yes', 'sí', 'tRUE', ' true', '']) assert.equal(parseBool(bad), null, bad);
  const q = new URLSearchParams('n=12&m=x&k=%2B5&s=+5&big=99999999999999999999&b=true&c=zzz&e=');
  assert.equal(queryInt(q, 'n', 1), 12);
  assert.equal(queryInt(q, 'm', 1), 1);
  assert.equal(queryInt(q, 'k', 1), 5);
  assert.equal(queryInt(q, 's', 1), 1); // el + de una consulta es un espacio
  assert.equal(queryInt(q, 'big', 7), 7);
  assert.equal(queryInt(q, 'ausente', 3), 3);
  assert.equal(queryInt(q, 'e', 3), 3);
  assert.equal(queryBool(q, 'b', false), true);
  assert.equal(queryBool(q, 'c', true), true);
  assert.equal(queryBool(q, 'e', true), true);
});

test('firstJsonValue lee solo el primer valor y describe los errores como el decodificador', () => {
  assert.deepEqual(firstJsonValue(' {"a":1} {"b":2}'), { value: { a: 1 }, rest: ' {"b":2}' });
  assert.deepEqual(firstJsonValue('[1,2]x'), { value: [1, 2], rest: 'x' });
  assert.deepEqual(firstJsonValue('"a\\"b" resto'), { value: 'a"b', rest: ' resto' });
  assert.deepEqual(firstJsonValue('null'), { value: null, rest: '' });
  assert.deepEqual(firstJsonValue('-1.5e2,'), { value: -150, rest: ',' });
  assert.throws(() => firstJsonValue(''), { message: 'EOF' });
  assert.throws(() => firstJsonValue('   '), { message: 'EOF' });
  assert.throws(() => firstJsonValue('{"a":'), { message: 'unexpected EOF' });
  assert.throws(() => firstJsonValue('no'), { message: "invalid character 'o' in literal null (expecting 'u')" });
  assert.throws(() => firstJsonValue('tru'), { message: 'unexpected EOF' });
  assert.throws(() => firstJsonValue('fals?'), { message: "invalid character '?' in literal false (expecting 'e')" });
  assert.throws(() => firstJsonValue('x'), { message: "invalid character 'x' looking for beginning of value" });
  assert.throws(() => firstJsonValue('{"a":1,}'), DecodeError);
});

test('pickFields ignora mayúsculas, descarta nulos y valida los tipos', () => {
  const spec = { id: 'string', n: 'int', f: 'float', ok: 'bool', tags: 'string[]', ids: 'int[]', o: 'object', any: 'any' };
  assert.deepEqual(
    pickFields({ ID: 'x', N: 3, f: 1.5, ok: false, tags: ['a'], ids: [1, 2], o: { k: 1 }, any: null, extra: 1 }, spec),
    { id: 'x', n: 3, f: 1.5, ok: false, tags: ['a'], ids: [1, 2], o: { k: 1 } },
  );
  assert.deepEqual(pickFields(null, spec), {});
  assert.throws(() => pickFields({ id: 5 }, spec), /cannot unmarshal number into Go struct field \.id of type string/);
  assert.throws(() => pickFields({ n: 1.5 }, spec), /cannot unmarshal number into Go struct field \.n of type int/);
  assert.throws(() => pickFields({ tags: [1] }, spec), /of type string\[\]/);
  assert.throws(() => pickFields({ ok: 'sí' }, spec), /cannot unmarshal string/);
  assert.throws(() => pickFields([], spec), /cannot unmarshal array/);
  assert.throws(() => pickFields({ id: 'x', raro: 1 }, spec, { strict: true }), /unknown field "raro"/);
  assert.deepEqual(pickFields({ id: 'x', raro: 1 }, spec), { id: 'x' });
});

test('decodeBody con single rechaza datos tras el valor', () => {
  assert.deepEqual(decodeBody('{"id":"a"} \n', { id: 'string' }, { single: true }), { id: 'a' });
  assert.throws(() => decodeBody('{"id":"a"}{}', { id: 'string' }, { single: true }), { message: 'trailing data' });
  assert.deepEqual(decodeBody('{"id":"a"}{}', { id: 'string' }), { id: 'a' });
});

test('un directorio es de confianza si nadie más puede escribir en él, o si es sticky de root o propio', () => {
  assert.equal(trustedSocketDirectory(0o755, 1000, 501), true);
  assert.equal(trustedSocketDirectory(0o775, 1000, 501), false);
  assert.equal(trustedSocketDirectory(0o757, 1000, 501), false);
  assert.equal(trustedSocketDirectory(0o1777, 0, 501), true);
  assert.equal(trustedSocketDirectory(0o1777, 501, 501), true);
  assert.equal(trustedSocketDirectory(0o1777, 1000, 501), false);
  assert.equal(trustedSocketDirectory(0o777, 0, 501), false);
});
