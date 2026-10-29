import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkMaterializedMutations, entrySignature, materializeChunkMutation, mutationBatchChunks, mutationEntityKey, mutationSignature, parseTypedChunk, validateRelationPayload,
} from '../../../src/cloud/materialize.js';
import { canonicalMutationEntry, normalizeLegacyMutationPayload } from '../../../src/cloud/server/mutations.js';

const obs = (id, session = 's1', extra = {}) => ({ sync_id: id, session_id: session, type: 't', title: 'x', content: 'c', scope: 'project', ...extra });

test('el chunk se decodifica con los campos tipados de cada fila', () => {
  const chunk = parseTypedChunk(JSON.stringify({
    sessions: [{ id: 's1', directory: '/x', desconocido: 1 }, null],
    observations: [{ ...obs('o'), id: 7, deleted: true }],
    prompts: null,
    mutations: [{ entity: 'prompt', op: 'delete', payload: '{}', otro: 1 }],
  }));
  assert.deepEqual(chunk.sessions, [{ id: 's1', directory: '/x' }, {}]);
  assert.deepEqual(chunk.observations, [{ id: 7, sync_id: 'o', session_id: 's1', type: 't', title: 'x', content: 'c', scope: 'project' }]);
  assert.deepEqual(chunk.prompts, []);
  assert.deepEqual(chunk.mutations, [{ entity: 'prompt', op: 'delete', payload: '{}' }]);
  assert.deepEqual(parseTypedChunk('{}'), { sessions: [], observations: [], prompts: [], mutations: [] });
});

test('un chunk con tipos erróneos se rechaza con el campo y el tipo', () => {
  const bad = (doc, pattern) => assert.throws(() => parseTypedChunk(JSON.stringify(doc)), pattern);
  bad([], /cannot unmarshal array into Go value of type sync\.ChunkData/);
  bad({ sessions: {} }, /cannot unmarshal object into Go struct field ChunkData\.sessions of type \[\]store\.Session/);
  bad({ prompts: [5] }, /cannot unmarshal number into Go struct field ChunkData\.prompts of type store\.Prompt/);
  bad({ observations: [{ title: 5 }] }, /cannot unmarshal number into Go struct field Observation\.observations\.title of type string/);
  bad({ observations: [{ revision_count: 1.5 }] }, /Observation\.observations\.revision_count of type int/);
  bad({ sessions: [{ id: 's', ownership_mode: 'project_owned', directory: null }] }, /^Error: sessions\[0\]: pulled session directory is invalid: directory must be a string$/);
  assert.doesNotThrow(() => parseTypedChunk(JSON.stringify({ sessions: [{ id: 's', ownership_mode: 'project_owned' }] })));
  assert.throws(() => parseTypedChunk('{'), SyntaxError);
});

test('la carga de una relación exige sus campos como cadenas no vacías', () => {
  const ok = { sync_id: 'r', source_id: 'a', target_id: 'b', relation: 'x', judgment_status: 'j', marked_by_actor: 'a', marked_by_kind: 'k' };
  assert.deepEqual(validateRelationPayload(JSON.stringify(ok)), { field: '', ok: true });
  for (const field of Object.keys(ok)) {
    const missing = { ...ok };
    delete missing[field];
    assert.deepEqual(validateRelationPayload(JSON.stringify(missing)), { field, ok: false }, field);
    assert.deepEqual(validateRelationPayload(JSON.stringify({ ...ok, [field]: '  ' })), { field, ok: false }, `${field} en blanco`);
    assert.deepEqual(validateRelationPayload(JSON.stringify({ ...ok, [field]: 5 })), { field, ok: false }, `${field} numérico`);
  }
  assert.deepEqual(validateRelationPayload('no json'), { field: 'sync_id', ok: false });
  assert.deepEqual(validateRelationPayload('[]'), { field: 'sync_id', ok: false });
  assert.deepEqual(validateRelationPayload('"{}"'), { field: 'sync_id', ok: false });
});

test('materializar una mutación valida su identidad y descarta lo que no viaja', () => {
  const m = (entity, op, payload, entity_key = '') => materializeChunkMutation(' p ', { entity, op, entity_key, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  assert.equal(m('cosa', 'upsert', {}, 'k'), null);
  assert.equal(m('prompt', 'archive', {}, 'k'), null);
  assert.deepEqual(m(' prompt ', '', { sync_id: 'p1' }, ' p1 '), { project: 'p', entity: 'prompt', entity_key: 'p1', op: 'upsert', payload: '{"sync_id":"p1"}' });
  assert.equal(m('prompt', 'delete', '', 'k').payload, '{}', 'sin carga, objeto vacío');
  assert.equal(mutationEntityKey('session', ' s '), ' s ');
  assert.equal(mutationEntityKey('prompt', ' s '), 's');
  assert.throws(() => m('prompt', 'delete', {}, '  '), /entity_key is required for prompt/);
  assert.throws(() => m('relation', 'upsert', { sync_id: 'r' }, 'r'), /payload\.source_id is required for relation/);
  assert.throws(() => m('observation', 'upsert', 'null', 'o'), /invalid observation upsert payload: payload must be a JSON object/);
  assert.throws(() => m('observation', 'upsert', '"texto"', 'o'), /invalid observation upsert payload: json: cannot unmarshal string into Go value of type store\.Observation/);
  assert.throws(() => m('observation', 'upsert', { sync_id: 'otra' }, 'o'), /invalid observation upsert payload: payload\.sync_id "otra" does not match entity_key "o"/);
  assert.throws(() => m('prompt', 'upsert', { sync_id: 'otra' }, 'o'), /payload\.sync_id "otra" does not match/);
  assert.throws(() => m('session', 'upsert', { id: 'otra' }, 's'), /invalid session upsert payload: payload\.id "otra" does not match entity_key "s"/);
  assert.throws(() => m('session', 'delete', { id: 'otra' }, 's'), /payload\.id "otra" does not match entity_key "s"/);
  assert.equal(m('session', 'upsert', {}, 's').entity_key, 's', 'la sesión sin id toma la clave');
  assert.equal(m('observation', 'upsert', { sync_id: ' o ' }, 'o').entity_key, 'o', 'la identidad de observación y prompt se compara recortada');
  assert.equal(m('prompt', 'upsert', { sync_id: ' p ' }, 'p').entity_key, 'p');
  assert.throws(() => m('session', 'upsert', { id: ' s ' }, 's'), /does not match entity_key "s"/, 'la de sesión, byte a byte');
  assert.equal(m('observation', 'delete', { sync_id: 'otra' }, 'o').entity_key, 'o', 'una baja de observación no valida la identidad');
});

test('un chunk subido deja sus altas tipadas y sus mutaciones sin repetir', () => {
  const chunk = parseTypedChunk(JSON.stringify({
    sessions: [{ id: 's1', directory: '/x', started_at: 'hoy' }],
    observations: [obs('o1')],
    prompts: [{ sync_id: 'p1', session_id: 's1', content: 'hola' }],
    mutations: [
      { entity: 'observation', entity_key: 'o1', op: 'upsert', payload: JSON.stringify(obs('o1')) },
      { entity: 'observation', entity_key: 'o2', op: 'upsert', payload: JSON.stringify(obs('o2')) },
      { entity: 'prompt', entity_key: 'p1', op: 'delete', payload: '{"sync_id":"p1"}' },
      { entity: 'cosa', entity_key: 'x', op: 'upsert', payload: '{}' },
    ],
  }));
  const entries = chunkMaterializedMutations(' mi-repo ', chunk);
  assert.deepEqual(entries.map((e) => `${e.entity}/${e.entity_key}/${e.op}`), ['session/s1/upsert', 'observation/o1/upsert', 'prompt/p1/upsert', 'observation/o2/upsert', 'prompt/p1/delete']);
  assert.ok(entries.every((e) => e.project === 'mi-repo'));
  assert.equal(entries[0].payload, '{"id":"s1","project":"","directory":"/x","started_at":"hoy"}');
  assert.equal(entries[2].payload, '{"id":0,"sync_id":"p1","session_id":"s1","content":"hola","created_at":""}');
  assert.throws(() => chunkMaterializedMutations('p', { sessions: [{}], observations: [], prompts: [], mutations: [] }), /sessions\[0\]\.id is required/);
  assert.throws(() => chunkMaterializedMutations('p', { sessions: [], observations: [{}], prompts: [], mutations: [] }), /observations\[0\]\.sync_id is required/);
  assert.throws(() => chunkMaterializedMutations('p', { sessions: [], observations: [], prompts: [{}], mutations: [] }), /prompts\[0\]\.sync_id is required/);
  assert.throws(() => chunkMaterializedMutations('p', { sessions: [], observations: [], prompts: [], mutations: [{ entity: 'relation', entity_key: 'r', op: 'upsert', payload: '{}' }] }), /mutations\[0\]\.payload\.sync_id is required for relation/);
});

test('un lote de mutaciones se agrupa en un chunk por proyecto', () => {
  const batch = [
    { project: 'a', entity: 'session', entity_key: 's1', op: 'upsert', payload: JSON.stringify({ id: 's1', directory: '/x' }), created_by: 'ana' },
    { project: 'b', entity: 'prompt', entity_key: 'p1', op: 'delete', payload: '{"sync_id":"p1"}', created_by: 'ana' },
    { project: 'a', entity: 'observation', entity_key: 'o1', op: 'upsert', payload: JSON.stringify(obs('o1')) },
    { project: 'a', entity: 'cosa', entity_key: 'x', op: 'upsert', payload: '{}' },
  ];
  const chunks = mutationBatchChunks(batch);
  assert.deepEqual(chunks.map((c) => [c.project, c.created_by, c.counts]), [['a', 'ana', { sessions: 1, observations: 1, prompts: 0 }], ['b', 'ana', { sessions: 0, observations: 0, prompts: 0 }]]);
  assert.match(chunks[0].id, /^[0-9a-f]{8}$/);
  const doc = JSON.parse(chunks[0].payload);
  assert.deepEqual(doc.mutations.map((m) => m.entity), ['session', 'observation'], 'lo que no viaja se descarta');
  assert.equal(doc.sessions[0].project, 'a');
  assert.throws(() => mutationBatchChunks([{ project: 'a', entity: 'observation', entity_key: 'o9', op: 'upsert', payload: JSON.stringify({ session_id: 's', type: 't', title: 'x', content: 'c', scope: 'project' }) }]), /canonicalize materialized mutation batch chunk: mutations\[0\]: observation payload sync_id is required/, 'la canonicalización exige el sync_id de la carga');
  assert.equal(mutationBatchChunks([{ project: 'a', entity: 'cosa', entity_key: 'x', op: 'upsert', payload: '{}' }]).length, 0, 'sin nada que viaje, sin chunk');
  assert.deepEqual(mutationBatchChunks([]), []);
  assert.throws(() => mutationBatchChunks([{ project: ' ', entity: 'session', entity_key: 's', op: 'upsert', payload: '{}' }]), /entries\[0\]\.project is required/);
  assert.throws(() => mutationBatchChunks([{ project: 'a', entity: 'prompt', entity_key: 'p', op: 'upsert', payload: '"x"' }]), /materialize mutation batch entry 0: invalid prompt upsert payload/);
});

test('las firmas comparan la carga por valor', () => {
  const a = { project: 'p', entity: 'prompt', entity_key: 'p1', op: 'delete', payload: '{"b":1,"a":{"d":1,"c":2}}' };
  assert.equal(mutationSignature(a), mutationSignature({ ...a, payload: ' {"a":{"c":2,"d":1},"b":1} ' }));
  assert.notEqual(mutationSignature(a), mutationSignature({ ...a, op: 'upsert' }));
  assert.notEqual(mutationSignature(a), mutationSignature({ ...a, project: 'q' }));
  assert.throws(() => mutationSignature({ ...a, payload: 'no json' }), /payload is not valid JSON/);
  const row = { project: 'p', entity: 'prompt', entity_key: 'p1', op: 'delete', payload: '{"sync_id":"p1"}' };
  assert.equal(entrySignature(row), entrySignature({ ...row, payload: '{"sync_id": "p1", "extra": 1}' }), 'pasa por la canonicalización de chunks');
  assert.throws(() => entrySignature({ ...row, project: ' ' }), /project is required/);
  assert.throws(() => entrySignature({ ...row, entity: 'cosa' }), /unsupported mutation/);
});

test('las altas heredadas completan los campos que faltan', () => {
  const norm = (entity, op, payload, entity_key = 'k') => JSON.parse(normalizeLegacyMutationPayload({ entity, op, entity_key, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }, 'mi-repo'));
  assert.deepEqual(norm('session', 'upsert', {}), { directory: '.', id: 'k' });
  assert.deepEqual(norm('session', 'upsert', { id: 'x', directory: '/d' }), { directory: '/d', id: 'x' });
  assert.deepEqual(norm('observation', 'upsert', {}), { content: 'k', scope: 'project', session_id: 'legacy-k', sync_id: 'k', title: 'k', type: 'legacy' });
  assert.deepEqual(norm('observation', 'upsert', { sync_id: ' z ', title: 'mio' }), { content: 'z', scope: 'project', session_id: 'legacy-z', sync_id: ' z ', title: 'mio', type: 'legacy' });
  assert.deepEqual(norm('prompt', 'upsert', {}), { content: 'k', project: 'mi-repo', session_id: 'legacy-k', sync_id: 'k' });
  assert.deepEqual(norm('prompt', 'delete', {}), {}, 'una baja no se completa');
  assert.deepEqual(norm('prompt', 'upsert', JSON.stringify(JSON.stringify({ sync_id: 'q' }))), { content: 'q', project: 'mi-repo', session_id: 'legacy-q', sync_id: 'q' }, 'carga doblemente codificada');
  assert.equal(normalizeLegacyMutationPayload({ entity: 'relation', op: 'upsert', entity_key: 'k', payload: ' {"a": 1} ' }, 'p'), '{"a": 1}', 'otras entidades pasan tal cual');
  assert.equal(normalizeLegacyMutationPayload({ entity: 'session', op: 'upsert', entity_key: ' s ', payload: '{}' }, 'p').includes('" s "'), true, 'la clave de sesión no se recorta');
  assert.throws(() => norm('prompt', 'upsert', '[1]'), /payload must be an object/);
  assert.throws(() => norm('prompt', 'upsert', 'null'), /payload must be an object/);
  assert.throws(() => norm('prompt', 'upsert', 'no json'), SyntaxError);
});

test('canonicalMutationEntry devuelve la mutación tal como la guardaría un chunk', () => {
  assert.deepEqual(canonicalMutationEntry({ project: ' mi-repo ', entity: ' prompt ', entity_key: ' p1 ', op: 'upsert', payload: JSON.stringify({ sync_id: 'p1', session_id: 's', content: ' hola ' }) }), {
    project: 'mi-repo', entity: 'prompt', entity_key: 'p1', op: 'upsert', payload: '{"sync_id":"p1","session_id":"s","content":"hola","project":"mi-repo"}',
  });
  assert.throws(() => canonicalMutationEntry({ project: 'p', entity: 'cosa', entity_key: 'k', op: 'upsert', payload: '{}' }), /unsupported mutation/);
  assert.throws(() => canonicalMutationEntry({ project: 'p', entity: 'relation', entity_key: 'r', op: 'upsert', payload: '' }), /payload is required/);
});
