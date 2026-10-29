import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Syncer, splitCloudExportChunk } from '../../../src/sync/syncer.js';
import { addObservation, addPrompt, createSession, enrollProject, getSyncState } from '../../../src/store/index.js';
import { listPendingSyncMutationsAfterSeq } from '../../../src/store/sync-queue.js';
import { openTempStore } from '../store/helpers.js';

/** Transporte en memoria que guarda lo que se le envía. */
function memoryTransport() {
  const chunks = new Map();
  const manifest = { version: 1, chunks: [] };
  return {
    chunks,
    manifest,
    readManifest: async () => ({ ...manifest, chunks: [...manifest.chunks] }),
    writeManifest: async (m) => { manifest.chunks = [...m.chunks]; manifest.version = m.version; },
    writeChunk: async (id, json) => { chunks.set(id, json); },
    readChunk: async (id) => {
      if (!chunks.has(id)) throw new Error('not found');
      return chunks.get(id);
    },
  };
}

const cloudSyncer = (store, transport, project = 'demo') => new Syncer(store, { transport, project, targetKey: `cloud:${project}`, cloudMode: true, log: () => {} });
const pending = (store) => listPendingSyncMutationsAfterSeq(store, 'cloud', 0, 1000);

function seed(store, project = 'demo') {
  createSession(store, 's1', project, '/tmp/x');
  addObservation(store, { session_id: 's1', type: 'decision', title: 'Usar Postgres', content: 'para la nube', project });
  addPrompt(store, { session_id: 's1', content: 'hola', project });
}

test('en modo nube se exporta lo pendiente del diario y se acusa al escribir el chunk', async (t) => {
  const store = openTempStore(t);
  seed(store);
  enrollProject(store, 'demo');
  assert.ok(pending(store).length >= 3);
  const transport = memoryTransport();
  const result = await cloudSyncer(store, transport).export('ana', 'demo');
  assert.deepEqual([result.is_empty, result.chunks_exported, result.sessions_exported, result.observations_exported, result.prompts_exported, result.mutations_exported], [false, 1, 1, 1, 1, 3]);
  const [json] = transport.chunks.values();
  const chunk = JSON.parse(json);
  assert.deepEqual(chunk.mutations.map((m) => m.entity).sort(), ['observation', 'prompt', 'session']);
  assert.equal(chunk.mutations.every((m) => m.disposition === 'pending' && m.target_key === 'cloud'), true);
  assert.equal(pending(store).length, 0, 'las filas del chunk quedan acusadas');
  assert.equal(transport.manifest.chunks.length, 1);
  assert.equal(transport.manifest.chunks[0].created_by, 'ana');
  assert.equal(getSyncState(store, 'cloud:demo').lifecycle, 'healthy');

  const again = await cloudSyncer(store, transport).export('ana', 'demo');
  assert.deepEqual([again.is_empty, again.mutations_exported], [true, 0], 'sin pendientes no hay chunk');
});

test('el modo nube exige proyecto explícito e inscripción y rechaza sesiones sin proyecto en el diario', async (t) => {
  const store = openTempStore(t);
  seed(store);
  const transport = memoryTransport();
  await assert.rejects(cloudSyncer(store, transport, '').export('ana', ''), /cloud sync requires an explicit --project scope; --all is not supported in cloud mode/);
  await assert.rejects(cloudSyncer(store, transport).export('ana', 'demo'), /cloud sync blocked_unenrolled: project "demo" is not enrolled for cloud sync/);
  const state = getSyncState(store, 'cloud:demo');
  assert.deepEqual([state.lifecycle, state.reason_code], ['degraded', 'blocked_unenrolled']);

  enrollProject(store, 'demo');
  store.db.run("UPDATE sync_mutations SET project = '' WHERE entity = 'session'");
  await assert.rejects(cloudSyncer(store, transport).export('ana', 'demo'), /blank-project session mutation seq=\d+ entity_key="s1" requires cloud upgrade diagnosis and repair before export/);
  assert.equal(transport.chunks.size, 0);
});

test('las mutaciones de otros proyectos no salen y un chunk repetido solo acusa', async (t) => {
  const store = openTempStore(t);
  seed(store);
  seed(store, 'otro');
  enrollProject(store, 'demo');
  enrollProject(store, 'otro');
  const transport = memoryTransport();
  const result = await cloudSyncer(store, transport).export('ana', 'demo');
  assert.equal(result.mutations_exported, 3);
  assert.equal(pending(store).filter((m) => m.project === 'otro').length > 0, true, 'lo del otro proyecto sigue pendiente');
  assert.equal(pending(store).filter((m) => m.project === 'demo').length, 0);

  // Devolver lo acusado al diario produce el mismo chunk: ya figura como conocido y solo se vuelve a acusar.
  store.db.run("UPDATE sync_mutations SET acked_at = NULL WHERE project = 'demo'");
  const repeat = await cloudSyncer(store, transport).export('ana', 'demo');
  assert.deepEqual([repeat.is_empty, transport.chunks.size], [true, 1]);
  assert.equal(pending(store).filter((m) => m.project === 'demo').length, 0);
});

// ─── Partición ───────────────────────────────────────────────────────────────

const mutation = (seq, entity, key, payload = '{}') => ({ seq, entity, entity_key: key, op: 'upsert', payload });
const session = (id) => ({ id, project: 'p', directory: '/x', started_at: 't' });
const observation = (id, sessionId) => ({ sync_id: id, session_id: sessionId, type: 't', title: 'x', content: 'c', scope: 'project' });
const prompt = (id, sessionId) => ({ sync_id: id, session_id: sessionId, content: 'p' });

test('una exportación pequeña cabe en una sola tanda y una vacía no tiene ninguna', () => {
  assert.deepEqual(splitCloudExportChunk(null, [], 100), []);
  assert.deepEqual(splitCloudExportChunk({ sessions: [], observations: [], prompts: [], mutations: [] }, [], 100), []);
  const chunk = { sessions: [session('s1')], observations: [observation('o1', 's1')], prompts: [], mutations: [mutation(1, 'session', 's1'), mutation(2, 'observation', 'o1')] };
  const whole = splitCloudExportChunk(chunk, [1, 2], 1 << 20);
  assert.equal(whole.length, 1);
  assert.deepEqual([whole[0].seqs, whole[0].chunk.mutations.map((m) => m.seq), whole[0].chunk.sessions.map((x) => x.id), whole[0].chunk.observations.map((o) => o.sync_id)], [[1, 2], [1, 2], ['s1'], ['o1']]);
  assert.equal(splitCloudExportChunk(chunk, [1, 2], 0)[0].chunk, chunk, 'sin tope no se parte');
  assert.equal(splitCloudExportChunk(chunk, [1], 10)[0].chunk, chunk, 'seqs desalineadas: no se parte');
});

test('la partición respeta el tope, el orden y lleva a cada tanda las sesiones que necesita', () => {
  const chunk = {
    sessions: [session('s1'), session('s2')],
    observations: [observation('o1', 's1'), observation('o2', 's1'), observation('o3', 's2')],
    prompts: [prompt('p1', 's2')],
    mutations: [mutation(10, 'observation', 'o1'), mutation(11, 'observation', 'o2'), mutation(12, 'observation', 'o3'), mutation(13, 'prompt', 'p1'), mutation(14, 'session', 's2')],
  };
  const parts = splitCloudExportChunk(chunk, [10, 11, 12, 13, 14], 400);
  assert.ok(parts.length > 1, 'con un tope bajo se parte');
  assert.deepEqual(parts.flatMap((p) => p.seqs), [10, 11, 12, 13, 14], 'el orden se conserva');
  for (const part of parts) {
    assert.equal(part.seqs.length, part.chunk.mutations.length);
    assert.deepEqual(part.chunk.mutations.map((m) => m.seq), part.seqs);
    const have = new Set(part.chunk.sessions.map((s) => s.id));
    for (const o of part.chunk.observations) assert.ok(have.has(o.session_id), 'cada tanda es completa por sí sola');
    for (const p of part.chunk.prompts) assert.ok(have.has(p.session_id));
  }
  const ids = (key) => parts.flatMap((p) => p.chunk[key]).map((e) => e.sync_id ?? e.id);
  assert.deepEqual(ids('observations'), ['o1', 'o2', 'o3'], 'ninguna entidad se repite entre tandas');
  assert.deepEqual(ids('prompts'), ['p1']);

  const single = splitCloudExportChunk(chunk, [10, 11, 12, 13, 14], 1);
  assert.equal(single.length, 5, 'una mutación mayor que el tope viaja sola');
  const dedup = splitCloudExportChunk({ sessions: [session('s1')], observations: [observation('o1', 's1')], prompts: [], mutations: [mutation(1, 'observation', 'o1'), mutation(2, 'observation', 'o1')] }, [1, 2], 1 << 20);
  assert.deepEqual([dedup[0].chunk.observations.length, dedup[0].chunk.sessions.length], [1, 1], 'una entidad repetida en la tanda se incluye una vez');
});

test('en modo nube salen también las observaciones personales y no las mutaciones de otro proyecto ni las de un alcance vacío', async (t) => {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/tmp/x');
  addObservation(store, { session_id: 's1', type: 'note', title: 'Personal', content: 'solo mía', project: 'demo', scope: 'personal' });
  const { id } = addObservation(store, { session_id: 's1', type: 'note', title: 'Ajena', content: 'de otro', project: 'demo' });
  enrollProject(store, 'demo');
  const foreign = store.db.get('SELECT sync_id FROM observations WHERE id = ?', id).sync_id;
  store.db.run("UPDATE sync_mutations SET project = 'otro' WHERE entity = 'observation' AND entity_key = ?", foreign);
  store.db.run("INSERT INTO sync_enrolled_projects (project) VALUES ('otro')");
  const transport = memoryTransport();
  // Un syncer con proyecto pero exportando «todo» no produce chunk: la nube exige un proyecto.
  const unscoped = await cloudSyncer(store, transport).export('ana', '');
  assert.deepEqual([unscoped.is_empty, transport.chunks.size], [true, 0]);
  assert.ok(pending(store).length > 0, 'nada se acusó');

  const result = await cloudSyncer(store, transport).export('ana', 'demo');
  assert.equal(result.observations_exported, 1);
  const chunk = JSON.parse([...transport.chunks.values()][0]);
  assert.deepEqual(chunk.observations.map((o) => o.title), ['Personal'], 'el alcance personal también va a la nube y lo de otro proyecto se queda');
  assert.deepEqual(chunk.mutations.filter((m) => m.entity === 'observation').map((m) => m.entity_key), chunk.observations.map((o) => o.sync_id));
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM sync_mutations WHERE entity_key = ? AND acked_at IS NULL', foreign).n, 1, 'la mutación de otro proyecto sigue pendiente');
});
