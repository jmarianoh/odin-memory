import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  PayloadTooLargeError, UnsupportedEnvelopeVersionError, acceptsCompressed, canonicalJson, canonicalizeForProject, chunkId, compressedContentType, decodeCompressed,
  decodeMutationPayload, encodeCompressed, hasGzipMagic, isCompressedContentType, normalizeJson, summarizeChunk, validateChunkSessionReferences,
} from '../../../src/cloud/codec.js';

const mutation = (entity, op, payload, extra = {}) => ({ entity, op, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), ...extra });

test('el identificador de un chunk son los 8 primeros hexadecimales de su SHA-256', () => {
  const payload = '{"a":1}';
  assert.equal(chunkId(payload), createHash('sha256').update(payload).digest('hex').slice(0, 8));
  assert.equal(chunkId(Buffer.from(payload)), chunkId(payload));
});

test('el sobre comprimido se negocia por tipo de contenido y versión', () => {
  assert.equal(compressedContentType(), 'application/vnd.odin.sync+gzip; version=1');
  assert.equal(isCompressedContentType(''), false);
  assert.equal(isCompressedContentType(undefined), false);
  assert.equal(isCompressedContentType('application/json'), false);
  assert.equal(isCompressedContentType('Application/VND.odin.sync+gzip; Version=1'), true);
  assert.equal(isCompressedContentType('application/vnd.odin.sync+gzip; version="1"'), true);
  assert.throws(() => isCompressedContentType('application/vnd.odin.sync+gzip; version=2'), UnsupportedEnvelopeVersionError);
  assert.throws(() => isCompressedContentType('application/vnd.odin.sync+gzip'), UnsupportedEnvelopeVersionError);

  assert.equal(acceptsCompressed('application/vnd.odin.sync+gzip; version=1'), true);
  assert.equal(acceptsCompressed('application/json, application/vnd.odin.sync+gzip; version=1; q=0.5'), true);
  assert.equal(acceptsCompressed('application/vnd.odin.sync+gzip; version=1; q=0'), false);
  assert.equal(acceptsCompressed('application/vnd.odin.sync+gzip; version=1; q=2'), false);
  assert.equal(acceptsCompressed('application/vnd.odin.sync+gzip; version=1; q=x'), false);
  assert.equal(acceptsCompressed('application/vnd.odin.sync+gzip; version=2'), false);
  assert.equal(acceptsCompressed('*/*'), false);
  assert.equal(acceptsCompressed(undefined), false);
});

test('comprimir y descomprimir respeta el tope de bytes descomprimidos', () => {
  const payload = Buffer.from('x'.repeat(1000));
  const packed = encodeCompressed(payload);
  assert.ok(hasGzipMagic(packed));
  assert.ok(!hasGzipMagic(payload));
  assert.ok(!hasGzipMagic(Buffer.from([0x1f])));
  assert.deepEqual(decodeCompressed(packed), payload);
  assert.deepEqual(decodeCompressed(packed, 1000), payload, 'justo en el tope');
  assert.throws(() => decodeCompressed(packed, 999), PayloadTooLargeError);
  assert.throws(() => decodeCompressed(packed, 0), /must be positive/);
  assert.throws(() => decodeCompressed(Buffer.from('no es gzip')), /decode compressed payload/);
  assert.throws(() => decodeCompressed(gzipSync(Buffer.alloc(0)).subarray(0, 5)), /decode compressed payload/);
});

test('la carga de una mutación puede venir como objeto o como cadena JSON anidada', () => {
  assert.deepEqual(decodeMutationPayload('{"a":1}'), { a: 1 });
  assert.deepEqual(decodeMutationPayload(JSON.stringify(JSON.stringify({ a: 1 }))), { a: 1 });
  assert.throws(() => decodeMutationPayload('  '), /empty payload/);
  assert.throws(() => decodeMutationPayload('[1]'), /must be a JSON object/);
  assert.throws(() => decodeMutationPayload('"[1]"'), /must be a JSON object/);
  assert.throws(() => decodeMutationPayload('{'), SyntaxError);
});

test('canonicalJson ordena las claves y escapa <, > y &', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: '<&>' } }), '{"a":{"c":"\\u003c\\u0026\\u003e","d":[{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson(' '), '"\\u2028"');
});

test('canonicalizeForProject fija el proyecto de las filas y ordena el documento', () => {
  const out = JSON.parse(canonicalizeForProject(JSON.stringify({
    sessions: [{ id: 's1', project: 'otro', directory: '/x' }],
    observations: [{ sync_id: 'o', session_id: 's1', project: 'otro' }],
    prompts: [{ sync_id: 'p', session_id: 's1' }],
    extra: { keep: true },
  }), 'mi-repo'));
  assert.equal(out.sessions[0].project, 'mi-repo');
  assert.equal(out.observations[0].project, 'mi-repo');
  assert.equal(out.prompts[0].project, 'mi-repo');
  assert.deepEqual(out.extra, { keep: true });
  assert.equal(canonicalizeForProject('{"b":1,"a":2}', 'p'), '{"a":2,"b":1}');
  assert.equal(canonicalizeForProject('{"sessions":null,"prompts":null}', 'p'), '{"prompts":[],"sessions":[]}');
});

test('con lista de mutaciones solo las sesiones que algo necesita toman el proyecto', () => {
  const doc = {
    sessions: [{ id: 'dueña', directory: '/a', project: 'ajeno' }, { id: 'usada', directory: '/b', project: 'ajeno' }, { id: 'libre', directory: '/c', project: 'ajeno' }, { id: '  ', directory: '/d' }],
    observations: [{ sync_id: 'o', session_id: 'usada' }],
    mutations: [mutation('session', 'upsert', { id: 'dueña', directory: '/a' })],
  };
  const out = JSON.parse(canonicalizeForProject(JSON.stringify(doc), 'mi-repo'));
  assert.deepEqual(out.sessions.map((s) => s.project), ['mi-repo', 'mi-repo', 'ajeno', 'mi-repo']);
});

test('una mutación se reescribe con la forma de su estructura', () => {
  const out = JSON.parse(canonicalizeForProject(JSON.stringify({
    mutations: [
      mutation('observation', 'upsert', { sync_id: ' obs-1 ', session_id: 's1', type: ' note ', title: 't', content: 'c', scope: 'project', review_after: null, revision_count: 0, desconocido: 1, Topic_Key: 'a/b' }),
      mutation('session', 'delete', { id: 's9', directory: '/x', started_at: 'ayer', deleted: true, deleted_at: '  ' }),
    ],
  }), 'mi-repo'));
  assert.equal(out.mutations[0].entity_key, 'obs-1');
  assert.equal(out.mutations[0].project, 'mi-repo');
  assert.equal(out.mutations[0].payload, '{"sync_id":"obs-1","session_id":"s1","type":"note","title":"t","content":"c","project":"mi-repo","scope":"project","topic_key":"a/b","review_after":null}');
  assert.equal(out.mutations[1].payload, '{"id":"s9","project":"mi-repo","deleted":true}');
  assert.deepEqual(Object.keys(out.mutations[0]), ['disposition', 'entity', 'entity_key', 'op', 'payload', 'project', 'occurred_at', 'seq', 'source', 'target_key'].sort());
});

test('una carga con comillas anidadas y una relación completa se aceptan', () => {
  const relation = { sync_id: 'rel-1', source_id: 'a', target_id: 'b', relation: 'related', judgment_status: 'judged', marked_by_actor: ' yo ', marked_by_kind: 'human', confidence: 0.5, reason: '<x>' };
  const out = JSON.parse(canonicalizeForProject(JSON.stringify({
    mutations: [mutation('relation', 'upsert', relation), mutation('prompt', 'upsert', JSON.stringify({ sync_id: 'p', session_id: 's', content: ' hola ' }))],
  }), 'mi-repo'));
  assert.equal(out.mutations[0].payload, '{"sync_id":"rel-1","source_id":"a","target_id":"b","relation":"related","reason":"\\u003cx\\u003e","confidence":0.5,"judgment_status":"judged","marked_by_actor":"yo","marked_by_kind":"human","project":"mi-repo"}');
  assert.equal(out.mutations[1].payload, '{"sync_id":"p","session_id":"s","content":"hola","project":"mi-repo"}');
});

test('canonicalizeForProject rechaza lo que no es un chunk válido', () => {
  const fail = (doc, pattern) => assert.throws(() => canonicalizeForProject(typeof doc === 'string' ? doc : JSON.stringify(doc), 'p'), pattern);
  fail('{', /^Error: decode chunk data: /);
  fail('[]', /chunk must be a JSON object/);
  fail({ sessions: {} }, /sessions must be an array/);
  fail({ sessions: [1] }, /sessions\[0\] must be an object/);
  fail({ mutations: {} }, /mutations must be an array/);
  fail({ mutations: [1] }, /mutations\[0\] must be an object/);
  fail({ mutations: [mutation('cosa', 'upsert', {})] }, /mutations\[0\]: unsupported mutation "cosa"\/"upsert"/);
  fail({ mutations: [mutation('relation', 'delete', {})] }, /unsupported mutation "relation"\/"delete"/);
  fail({ mutations: [{ entity: 'prompt', op: 'upsert' }] }, /payload is required/);
  fail({ mutations: [{ entity: 'prompt', op: 'upsert', payload: { sync_id: 'x' } }] }, /cannot unmarshal object into Go struct field SyncMutation\.payload of type string/);
  fail({ mutations: [mutation('prompt', 'upsert', { sync_id: 5 })] }, /decode mutation payload: json: cannot unmarshal number into Go struct field mutationPromptPayload\.sync_id of type string/);
  fail({ mutations: [mutation('prompt', 'upsert', '[1]')] }, /decode mutation payload: payload must be a JSON object/);
  fail({ mutations: [mutation('prompt', 'delete', { sync_id: ' ' })] }, /prompt payload sync_id is required/);
  fail({ mutations: [mutation('prompt', 'upsert', { sync_id: 'x' })] }, /prompt payload session_id is required for upsert/);
  fail({ mutations: [mutation('prompt', 'upsert', { sync_id: 'x', session_id: 's', content: ' ' })] }, /prompt payload content is required for upsert/);
  fail({ mutations: [mutation('observation', 'upsert', { sync_id: 'x', session_id: 's', type: 't', title: '', content: 'c', scope: 's' })] }, /observation payload title is required for upsert/);
  fail({ mutations: [mutation('session', 'upsert', { id: 's' })] }, /session payload directory is required for upsert/);
  fail({ mutations: [mutation('session', 'upsert', { id: '' })] }, /session payload id is required/);
  fail({ mutations: [mutation('prompt', 'delete', { sync_id: 'x' }, { entity_key: 'otra' })] }, /entity_key "otra" does not match payload key "x"/);
  fail({ mutations: [mutation('relation', 'upsert', { sync_id: 'r', source_id: 'a', target_id: 'b', relation: 'x', judgment_status: 'j', marked_by_kind: 'k' })] }, /relation payload marked_by_actor is required for upsert/);
  fail({ mutations: [{ entity: 'prompt', op: 'upsert', payload: '{}', seq: 1.5 }] }, /cannot unmarshal number into Go struct field SyncMutation\.seq of type int/);
});

test('normalizeJson compara por valor y summarizeChunk cuenta filas', () => {
  assert.equal(normalizeJson('{"b": 1, "a": [2, {"d":1,"c":2}]}'), normalizeJson('{"a":[2,{"c":2,"d":1}],"b":1}'));
  assert.notEqual(normalizeJson('{"a":1}'), normalizeJson('{"a":2}'));
  assert.equal(normalizeJson('no json'), 'no json');
  assert.deepEqual(summarizeChunk('{"sessions":[1,2],"observations":[1],"prompts":null}'), { sessions: 2, observations: 1, prompts: 0 });
  assert.deepEqual(summarizeChunk('roto'), { sessions: 0, observations: 0, prompts: 0 });
});

test('las referencias a sesión se resuelven con el propio chunk y con las que el servidor ya conoce', () => {
  const known = new Set(['vieja']);
  const ok = (chunk) => assert.doesNotThrow(() => validateChunkSessionReferences(chunk, known));
  const bad = (chunk, pattern) => assert.throws(() => validateChunkSessionReferences(chunk, known), pattern);
  ok({ sessions: [{ id: 'nueva' }], observations: [{ session_id: 'nueva' }, { session_id: 'vieja' }], prompts: [{ session_id: 'vieja' }] });
  ok({ mutations: [mutation('session', 'upsert', { id: 'm' }), mutation('observation', 'upsert', { session_id: 'm' }), mutation('prompt', 'delete', { session_id: 'nadie' })] });
  ok({ mutations: [mutation('session', 'upsert', {}, { entity_key: 'por-clave' }), mutation('prompt', 'upsert', { session_id: 'por-clave' })] });
  bad({ observations: [{ session_id: 'nadie' }] }, /^Error: observations\[0\] references missing session_id "nadie"$/);
  bad({ observations: [{ session_id: ' ' }] }, /observations\[0\]\.session_id is required/);
  bad({ prompts: [{ session_id: 'x' }] }, /prompts\[0\] references missing session_id "x"/);
  bad({ sessions: [{ id: ' ' }] }, /sessions\[0\]\.id is required/);
  bad({ mutations: [mutation('session', 'upsert', {})] }, /mutations\[0\]\.payload\.id is required for session upsert/);
  bad({ mutations: [mutation('prompt', 'upsert', { content: 'x' })] }, /mutations\[0\]\.payload\.session_id is required for upsert/);
  bad({ mutations: [mutation('observation', 'upsert', { session_id: 'x' })] }, /mutations\[0\] references missing session_id "x"/);
  bad({ mutations: [mutation('observation', 'upsert', '[1]')] }, /mutations\[0\] invalid payload: payload must be a JSON object/);
});

test('los campos opcionales de la observación solo salen cuando vienen', () => {
  const payloadOf = (extra) => JSON.parse(canonicalizeForProject(JSON.stringify({
    mutations: [mutation('observation', 'upsert', { sync_id: 'o', session_id: 's', type: 't', title: 'x', content: 'c', scope: 'project', ...extra })],
  }), 'p')).mutations[0].payload;
  assert.equal(payloadOf({}), '{"sync_id":"o","session_id":"s","type":"t","title":"x","content":"c","project":"p","scope":"project"}', 'review_after ausente no se emite');
  assert.equal(payloadOf({ review_after: '2027-01-01 00:00:00' }), '{"sync_id":"o","session_id":"s","type":"t","title":"x","content":"c","project":"p","scope":"project","review_after":"2027-01-01 00:00:00"}');
  assert.equal(payloadOf({ review_after: 5 }), '{"sync_id":"o","session_id":"s","type":"t","title":"x","content":"c","project":"p","scope":"project","review_after":5}', 'el JSON crudo se conserva');
  assert.equal(payloadOf({ revision_count: 3, deleted: true, tool_name: '' }), '{"sync_id":"o","session_id":"s","type":"t","title":"x","content":"c","tool_name":"","project":"p","scope":"project","revision_count":3,"deleted":true}', 'una cadena opcional vacía no se omite');
});

test('la clave de entidad de una sesión se respeta byte a byte y la de las demás se recorta', () => {
  const key = (entity, entityKey, payload) => JSON.parse(canonicalizeForProject(JSON.stringify({ mutations: [mutation(entity, 'delete', payload, { entity_key: entityKey })] }), 'p')).mutations[0].entity_key;
  assert.equal(key('session', ' s1 ', { id: ' s1 ' }), ' s1 ');
  assert.equal(key('prompt', ' p1 ', { sync_id: 'p1' }), 'p1');
  assert.throws(() => key('session', 's1', { id: ' s1 ' }), /entity_key "s1" does not match payload key " s1 "/);
});

test('las sesiones que toman el proyecto dependen de operaciones concretas', () => {
  const projects = (doc) => JSON.parse(canonicalizeForProject(JSON.stringify({ sessions: [{ id: 'x', directory: '/x', project: 'ajeno' }], ...doc }), 'mi-repo')).sessions[0].project;
  assert.equal(projects({ mutations: [mutation('session', 'delete', { id: 'x' })] }), 'mi-repo', 'una baja de sesión la hace dueña');
  assert.equal(projects({ mutations: [mutation('prompt', 'delete', { sync_id: 'p', session_id: 'x' })] }), 'ajeno', 'una baja de prompt no la requiere');
  assert.equal(projects({ mutations: [mutation('prompt', 'upsert', { sync_id: 'p', session_id: 'x', content: 'c' })] }), 'mi-repo', 'un alta de prompt sí');
  assert.equal(projects({ mutations: [mutation('relation', 'upsert', { sync_id: 'r', source_id: 'a', target_id: 'b', relation: 'x', judgment_status: 'j', marked_by_actor: 'a', marked_by_kind: 'k', session_id: 'x' })] }), 'ajeno', 'una relación no requiere sesión');
  assert.equal(projects({ mutations: [] }), 'ajeno', 'con lista vacía solo mandan las filas');
  assert.equal(projects({}), 'mi-repo', 'sin lista, todas');
});

test('summarizeChunk cuenta cada clase por separado', () => {
  assert.deepEqual(summarizeChunk('{"sessions":[1],"observations":[1,2,3],"prompts":[1,2]}'), { sessions: 1, observations: 3, prompts: 2 });
});
