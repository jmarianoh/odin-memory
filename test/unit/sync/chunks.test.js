import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportMutations, chunkId, chunkToJson, effectiveMutationsForImport, estimateImport, mutationIdentityKey, orderMutationsForApply, parseChunk, synthesizeMutations } from '../../../src/sync/index.js';
import { chunkObservationJson, promptJson, referencedSessionProjects, sessionJson } from '../../../src/sync/chunks.js';
import { newMutation } from '../../../src/store/sync-chunks.js';

const m = (entity, key, op, payload = {}) => newMutation({ entity, entity_key: key, op, payload: JSON.stringify(payload) });
const empty = (extra = {}) => ({ sessions: [], observations: [], prompts: [], mutations: [], review_clears: [], ...extra });

test('chunkId son los ocho primeros hexadecimales del SHA-256', () => {
  assert.equal(chunkId('hola'), 'b221d9db');
  assert.equal(chunkId(''), 'e3b0c442');
  assert.match(chunkId('{"a":1}'), /^[0-9a-f]{8}$/);
});

test('las proyecciones omiten lo ausente y respetan el orden de campos', () => {
  assert.deepEqual(Object.keys(sessionJson({ id: 's', project: 'p', ownership_mode: '', directory: '/d', started_at: 't', ended_at: null, summary: null })), ['id', 'project', 'directory', 'started_at']);
  assert.deepEqual(Object.keys(sessionJson({ id: 's', project: 'p', ownership_mode: 'shared', directory: '/d', started_at: 't', ended_at: 'e', summary: 'x' })), ['id', 'project', 'ownership_mode', 'directory', 'started_at', 'ended_at', 'summary']);
  assert.deepEqual(Object.keys(promptJson({ id: 1, sync_id: 'p', session_id: 's', content: 'c', project: '', source_inbox_id: '', created_at: 't' })), ['id', 'sync_id', 'session_id', 'content', 'created_at']);
  assert.deepEqual(Object.keys(promptJson({ id: 1, sync_id: 'p', session_id: 's', content: 'c', project: 'x', source_inbox_id: 'i', created_at: 't' })), ['source_inbox_id', 'id', 'sync_id', 'session_id', 'content', 'project', 'created_at']);
  const obs = {
    id: 1, sync_id: 'o', session_id: 's', type: 't', title: 'T', content: 'C', tool_name: 'mem', project: 'p', scope: 'project', topic_key: 'k', revision_count: 2, duplicate_count: 3,
    last_seen_at: 'l', review_after: 'r', superseded_by_sync_id: 'x', pinned: 1, created_at: 'c', updated_at: 'u', deleted_at: 'd',
  };
  assert.deepEqual(Object.keys(chunkObservationJson(obs)), [
    'id', 'sync_id', 'session_id', 'type', 'title', 'content', 'tool_name', 'project', 'scope', 'topic_key', 'revision_count', 'duplicate_count', 'last_seen_at', 'review_after',
    'superseded_by_sync_id', 'created_at', 'updated_at', 'deleted_at',
  ]);
  assert.deepEqual(Object.keys(chunkObservationJson({ ...obs, tool_name: null, project: null, topic_key: null, last_seen_at: null, review_after: null, superseded_by_sync_id: null, deleted_at: null })), [
    'id', 'sync_id', 'session_id', 'type', 'title', 'content', 'scope', 'revision_count', 'duplicate_count', 'created_at', 'updated_at',
  ]);
});

test('chunkToJson deja nulas las listas vacías y solo añade mutaciones y recibos si los hay', () => {
  assert.equal(chunkToJson(empty()), '{"sessions":null,"observations":null,"prompts":null}');
  assert.equal(chunkToJson(empty({ incremental: true })), '{"sessions":null,"observations":[],"prompts":null}');
  const json = JSON.parse(chunkToJson(empty({
    sessions: [{ id: 's', project: 'p', directory: '/d', started_at: 't' }], prompts: [{ id: 1, sync_id: 'p', session_id: 's', content: 'c', created_at: 't' }],
    mutations: [m('relation', 'rel-1', 'upsert')], review_clears: ['o:1:k'],
  })));
  assert.deepEqual(Object.keys(json), ['sessions', 'observations', 'prompts', 'mutations', 'review_clears']);
  assert.equal(json.observations, null);
  assert.deepEqual(json.review_clears, ['o:1:k']);
});

test('parseChunk acepta listas nulas y rechaza formas inválidas', () => {
  assert.deepEqual(parseChunk('{"sessions":null,"observations":null,"prompts":null}'), empty());
  assert.deepEqual(parseChunk('{}'), empty());
  assert.equal(parseChunk('{"mutations":[{"entity":"x"}]}').mutations.length, 1);
  assert.throws(() => parseChunk('[]'), { message: 'chunk must be a JSON object' });
  assert.throws(() => parseChunk('null'), { message: 'chunk must be a JSON object' });
  assert.throws(() => parseChunk('{"sessions":{}}'), { message: 'chunk sessions must be an array' });
  assert.throws(() => parseChunk('{"prompts":"x"}'), { message: 'chunk prompts must be an array' });
  assert.throws(() => parseChunk('rota'));
  assert.throws(() => parseChunk('{"sessions":[{"id":"s","ownership_mode":"project_owned","directory":null}]}'), { message: 'sessions[0]: pulled session directory is invalid: directory must be non-blank' });
  assert.equal(parseChunk('{"sessions":[{"id":"s","ownership_mode":"project_owned","directory":""}]}').sessions.length, 1);
  assert.equal(parseChunk('{"sessions":[{"id":"s","ownership_mode":"shared","directory":null}]}').sessions.length, 1);
});

test('synthesizeMutations convierte las listas en altas y borrados', () => {
  const chunk = empty({
    sessions: [{ id: 's1', project: 'p', directory: '/d', started_at: 't', ended_at: 'e', summary: 'r' }],
    observations: [
      { sync_id: ' obs-1 ', session_id: 's1', type: 'x', title: 'T', content: 'C', scope: 'project', revision_count: 1, duplicate_count: 1, created_at: 'c', updated_at: 'u', review_after: 'r', superseded_by_sync_id: 'o2' },
      { sync_id: 'obs-2', session_id: 's1', type: 'x', title: 'T', content: 'C', scope: 'project', revision_count: 1, duplicate_count: 1, created_at: 'c', updated_at: 'u', deleted_at: 'd' },
    ],
    prompts: [{ sync_id: ' p1 ', session_id: 's1', content: 'c', created_at: 't' }],
  });
  const [session, o1, o2, prompt] = synthesizeMutations(chunk);
  assert.deepEqual([session.entity, session.entity_key, session.op], ['session', 's1', 'upsert']);
  assert.deepEqual(JSON.parse(session.payload), { id: 's1', project: 'p', ownership_mode: '', directory: '/d', started_at: 't', ended_at: 'e', summary: 'r' });
  assert.deepEqual([o1.entity_key, o1.op], ['obs-1', 'upsert']);
  const fields = JSON.parse(o1.payload);
  assert.deepEqual([fields.review_after, fields.superseded_by_sync_id, fields.deleted, fields.hard_delete, fields.tool_name], ['r', 'o2', false, false, null]);
  assert.deepEqual([o2.op, JSON.parse(o2.payload).deleted, JSON.parse(o2.payload).deleted_at], ['delete', true, 'd']);
  assert.equal('review_after' in JSON.parse(o2.payload), false);
  assert.deepEqual([prompt.entity_key, prompt.op], ['p1', 'upsert']);
  assert.equal(JSON.parse(prompt.payload).project, null);
  assert.deepEqual(synthesizeMutations(empty()), []);
});

test('mutationIdentityKey recorta las claves salvo las de sesión', () => {
  assert.equal(mutationIdentityKey({ entity: 'observation', entity_key: '  obs-1 ' }), 'observation:obs-1');
  assert.equal(mutationIdentityKey({ entity: 'session', entity_key: ' s ' }), 'session: s ');
  assert.equal(mutationIdentityKey({ entity: 'relation', entity_key: undefined }), 'relation:');
});

test('buildImportMutations combina las listas con las mutaciones explícitas', () => {
  const sessions = [{ id: 's1', project: 'p', directory: '/d', started_at: 't' }, { id: 's2', project: 'p', directory: '/d', started_at: 't' }];
  const observation = { sync_id: 'obs-1', session_id: 's1', type: 'x', title: 'T', content: 'C', scope: 'project', revision_count: 1, duplicate_count: 1, created_at: 'c', updated_at: 'u' };
  // Sin mutaciones explícitas, solo las listas.
  assert.equal(buildImportMutations(empty({ sessions, observations: [observation] })).length, 3);
  // Con explícitas: las listas que repiten una explícita se descartan; una sesión implícita solo si algo la necesita.
  const explicit = m('observation', 'obs-1', 'upsert', { sync_id: 'obs-1', session_id: 's2' });
  const built = buildImportMutations(empty({ sessions, observations: [observation], mutations: [explicit] }));
  assert.deepEqual(built.map(mutationIdentityKey), ['session:s2', 'observation:obs-1']);
  assert.equal(built.at(-1), explicit);
  const rel = m('relation', 'rel-1', 'upsert', {});
  assert.deepEqual(buildImportMutations(empty({ sessions, observations: [observation], mutations: [rel] })).map(mutationIdentityKey), ['session:s1', 'observation:obs-1', 'relation:rel-1']);
  assert.deepEqual(buildImportMutations(empty({ mutations: [rel] })), [rel]);
});

test('effectiveMutationsForImport conserva la última mutación de cada identidad', () => {
  const first = m('observation', 'obs-1', 'upsert', { v: 1 });
  const second = m('observation', 'obs-1', 'delete', { v: 2 });
  const other = m('prompt', 'p1', 'upsert');
  const result = effectiveMutationsForImport(empty({ mutations: [first, other, second] }));
  assert.deepEqual(result, [other, second]);
  assert.deepEqual(effectiveMutationsForImport(empty({ mutations: [first] })), [first]);
});

test('estimateImport cuenta las altas efectivas', () => {
  const chunk = empty({
    mutations: [m('session', 's', 'upsert'), m('observation', 'o1', 'upsert'), m('observation', 'o2', 'delete'), m('prompt', 'p', 'upsert'), m('relation', 'r', 'upsert'), m('observation', 'o1', 'upsert')],
  });
  assert.deepEqual(estimateImport(chunk), { sessions: 1, observations: 1, prompts: 1 });
});

const ids = (list) => list.map((x) => `${x.entity[0]}${x.op === 'delete' ? '-' : '+'}${x.entity_key}`);

test('orderMutationsForApply: altas de sesión, otras altas, relaciones, borrados y borrados de sesión', () => {
  const list = [
    m('session', 's1', 'delete'), m('observation', 'o1', 'delete'), m('relation', 'r1', 'upsert'), m('observation', 'o2', 'upsert'), m('session', 's2', 'upsert'),
    m('prompt', 'p1', 'upsert'),
  ];
  assert.deepEqual(ids(orderMutationsForApply(list)), ['s+s2', 'o+o2', 'p+p1', 'r+r1', 'o-o1', 's-s1']);
  assert.deepEqual(orderMutationsForApply([]), []);
  const single = [m('relation', 'r', 'upsert')];
  assert.equal(orderMutationsForApply(single), single);
});

test('un borrado de sesión seguido de un alta de la misma sesión se coloca justo antes del alta', () => {
  const list = [m('session', 's1', 'upsert'), m('observation', 'o1', 'upsert'), m('session', 's1', 'delete'), m('session', 's1', 'upsert'), m('observation', 'o1', 'delete'), m('session', 's9', 'delete')];
  assert.deepEqual(ids(orderMutationsForApply(list)), ['s+s1', 's-s1', 's+s1', 'o+o1', 'o-o1', 's-s9']);
});

test('los borrados anteriores a un borrado de sesión relocalizado se vacían antes, con las altas previas de su identidad', () => {
  const list = [m('observation', 'o1', 'upsert'), m('relation', 'o1', 'upsert'), m('observation', 'o1', 'delete'), m('session', 's1', 'delete'), m('session', 's1', 'upsert')];
  // La relación comparte clave pero no entidad con la observación: no se reclama y va tras las altas.
  assert.deepEqual(ids(orderMutationsForApply(list)), ['o+o1', 'o-o1', 's-s1', 's+s1', 'r+o1']);
  const claimed = [m('observation', 'o2', 'upsert'), m('observation', 'o2', 'delete'), m('session', 's2', 'delete'), m('session', 's2', 'upsert'), m('prompt', 'p', 'upsert')];
  assert.deepEqual(ids(orderMutationsForApply(claimed)), ['o+o2', 'o-o2', 's-s2', 's+s2', 'p+p']);
});

test('referencedSessionProjects elige el proyecto menor y salta cargas inválidas', () => {
  const list = [
    newMutation({ entity: 'observation', entity_key: 'o1', op: 'upsert', payload: JSON.stringify({ session_id: 's1', project: 'zeta' }) }),
    newMutation({ entity: 'prompt', entity_key: 'p1', op: 'upsert', payload: JSON.stringify({ session_id: 's1', project: 'alfa' }), project: '' }),
    newMutation({ entity: 'observation', entity_key: 'o2', op: 'upsert', payload: JSON.stringify({ session_id: 's2' }), project: 'beta' }),
    newMutation({ entity: 'observation', entity_key: 'o3', op: 'upsert', payload: 'rota' }),
    newMutation({ entity: 'observation', entity_key: 'o4', op: 'delete', payload: JSON.stringify({ session_id: 's3' }) }),
    newMutation({ entity: 'observation', entity_key: 'o5', op: 'upsert', payload: JSON.stringify({ session_id: '  ' }) }),
    newMutation({ entity: 'session', entity_key: 's4', op: 'upsert', payload: JSON.stringify({ id: 's4' }) }),
  ];
  assert.deepEqual([...referencedSessionProjects(list)], [['s1', 'alfa'], ['s2', 'beta']]);
});
