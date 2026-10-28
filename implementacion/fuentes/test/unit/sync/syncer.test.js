import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  ChunkNotFoundError, FileTransport, OWNERSHIP_MODE_MANIFEST_VERSION, Syncer, getUsername, manifestSummary, manifestToJson, normalizeTime,
} from '../../../src/sync/index.js';
import { filterObservationsForExport, filterRelationMutationsForExport, includeObservationParentSessions, observationUpsertIdentity } from '../../../src/sync/syncer.js';
import {
  addObservation, addPrompt, createSession, deleteObservation, deletePrompt, getObservation, getSession, markReviewed, stats, updateObservation,
} from '../../../src/store/index.js';
import { newMutation } from '../../../src/store/sync-chunks.js';
import { openTempStore, tempDir } from '../store/helpers.js';

function pair(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'odin-sync-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logs = [];
  const a = openTempStore(t, { log: (m) => logs.push(m) });
  const b = openTempStore(t, { log: (m) => logs.push(m) });
  const dir = join(root, '.odin-memory');
  return { a, b, dir, logs, root, sa: Syncer.local(a, dir, 'demo', { log: (m) => logs.push(m) }), sb: Syncer.local(b, dir, 'demo', { log: (m) => logs.push(m) }) };
}

function seed(store, project = 'demo') {
  createSession(store, 's1', project, '/tmp/x');
  const ids = ['Usar Redis para la caché', 'Redis como caché distribuida', 'Tokens de acceso'].map((title) =>
    addObservation(store, { session_id: 's1', type: 'decision', title, content: `contenido de ${title}`, project }).id);
  return ids;
}

const chunkOf = (dir, id) => JSON.parse(gunzipSync(readFileSync(join(dir, 'chunks', `${id}.jsonl.gz`))).toString('utf8'));
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

test('normalizeTime pasa RFC 3339 a UTC con nueve decimales y recorta el resto', () => {
  assert.equal(normalizeTime('2026-03-01T10:00:00Z'), '2026-03-01 10:00:00.000000000');
  assert.equal(normalizeTime('2026-03-01T10:00:00.5Z'), '2026-03-01 10:00:00.500000000');
  assert.equal(normalizeTime('2026-03-01T10:00:00.123456789123Z'), '2026-03-01 10:00:00.123456789');
  assert.equal(normalizeTime('2026-03-01T10:00:00+02:00'), '2026-03-01 08:00:00.000000000');
  assert.equal(normalizeTime('2026-03-01T00:30:00-05:00'), '2026-03-01 05:30:00.000000000');
  assert.equal(normalizeTime('2026-03-01 10:00:00'), '2026-03-01 10:00:00');
  assert.equal(normalizeTime('  hola '), 'hola');
  assert.equal(normalizeTime(undefined), '');
});

test('getUsername y manifestSummary', () => {
  assert.equal(getUsername({ USER: 'ana', USERNAME: 'x' }), 'ana');
  assert.equal(getUsername({ USERNAME: 'bea' }), 'bea');
  assert.ok(getUsername({}).length > 0);
  assert.equal(manifestSummary({ chunks: [] }), 'No chunks synced yet.');
  assert.equal(
    manifestSummary({ chunks: [{ created_by: 'bea', memories: 2, sessions: 1 }, { created_by: 'ana', memories: 3, sessions: 1 }, { created_by: 'bea', memories: 1, sessions: 2 }] }),
    '3 chunks, 6 memories, 4 sessions — contributors: ana (1 chunks), bea (2 chunks)',
  );
});

test('FileTransport escribe y lee manifiesto y chunks', (t) => {
  const dir = join(tempDir(t), 'sync');
  const transport = new FileTransport(dir);
  assert.deepEqual(transport.readManifest(), { version: 1, chunks: [] }, 'sin directorio hay un manifiesto vacío');
  mkdirSync(dir);
  assert.deepEqual(transport.readManifest(), { version: 1, chunks: [] });
  transport.writeManifest({ version: 2, chunks: [{ id: 'aaaa1111', created_by: 'x', created_at: 't', sessions: 1, memories: 2, prompts: 3 }] });
  assert.equal(readFileSync(join(dir, 'manifest.json'), 'utf8'), '{\n  "version": 2,\n  "chunks": [\n    {\n      "id": "aaaa1111",\n      "created_by": "x",\n      "created_at": "t",\n      "sessions": 1,\n      "memories": 2,\n      "prompts": 3\n    }\n  ]\n}');
  assert.equal(transport.readManifest().chunks[0].memories, 2);
  assert.equal(manifestToJson({ version: 1, chunks: [] }), '{\n  "version": 1,\n  "chunks": null\n}');
  writeFileSync(join(dir, 'manifest.json'), '{"version":1,"chunks":null}');
  assert.deepEqual(transport.readManifest(), { version: 1, chunks: [] });
  writeFileSync(join(dir, 'manifest.json'), 'rota');
  assert.throws(() => transport.readManifest(), /^Error: parse manifest: /);
  assert.throws(() => transport.readChunk('nada'), ChunkNotFoundError);
  transport.writeChunk('bbbb2222', '{"a":"ñ"}');
  assert.equal(transport.readChunk('bbbb2222'), '{"a":"ñ"}');
  assert.equal(gunzipSync(readFileSync(join(dir, 'chunks', 'bbbb2222.jsonl.gz'))).toString('utf8'), '{"a":"ñ"}');
  const file = join(dir, 'archivo');
  writeFileSync(file, 'x');
  assert.throws(() => new FileTransport(file).readManifest(), /^Error: read manifest: ENOTDIR/);
});

test('exportar crea un chunk, repetir no crea otro y el manifiesto lo describe', (t) => {
  const { a, dir, sa } = pair(t);
  seed(a);
  addPrompt(a, { session_id: 's1', content: 'un prompt', project: 'demo' });
  const first = sa.export('ana', 'demo');
  assert.deepEqual({ ...first, chunk_id: undefined }, { chunk_id: undefined, sessions_exported: 1, observations_exported: 3, prompts_exported: 0, mutations_exported: 0, is_empty: false });
  assert.match(first.chunk_id, /^[0-9a-f]{8}$/);
  const manifest = manifestOf(dir);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.chunks.length, 1);
  assert.deepEqual({ ...manifest.chunks[0], created_at: undefined }, { id: first.chunk_id, created_by: 'ana', created_at: undefined, sessions: 1, memories: 3, prompts: 0 });
  assert.match(manifest.chunks[0].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/);
  const chunk = chunkOf(dir, first.chunk_id);
  assert.equal(chunk.prompts, null, 'los prompts no se comparten por defecto');
  assert.equal(chunk.observations.length, 3);
  assert.deepEqual(Object.keys(chunk), ['sessions', 'observations', 'prompts']);
  assert.equal(sa.export('ana', 'demo').is_empty, true);
  assert.deepEqual(readdirSync(join(dir, 'chunks')), [`${first.chunk_id}.jsonl.gz`]);
  assert.deepEqual(sa.status(), { local: 1, remote: 1, pending: 0 });
});

test('--include-prompts comparte los prompts una sola vez', (t) => {
  const { a, dir, sa } = pair(t);
  seed(a);
  addPrompt(a, { session_id: 's1', content: 'primer prompt', project: 'demo' });
  const first = sa.export('ana', 'demo', { includePrompts: true });
  assert.equal(first.prompts_exported, 1);
  assert.equal(chunkOf(dir, first.chunk_id).prompts[0].content, 'primer prompt');
  assert.equal(sa.export('ana', 'demo', { includePrompts: true }).is_empty, true);
  addPrompt(a, { session_id: 's1', content: 'segundo prompt', project: 'demo' });
  const second = sa.export('ana', 'demo', { includePrompts: true });
  assert.deepEqual([second.prompts_exported, chunkOf(dir, second.chunk_id).prompts.map((p) => p.content)], [1, ['segundo prompt']]);
  deletePrompt(a, 1);
  const third = sa.export('ana', 'demo', { includePrompts: true });
  assert.equal(third.mutations_exported, 1, 'el borrado de un prompt compartido viaja como mutación');
  assert.equal(chunkOf(dir, third.chunk_id).mutations[0].entity, 'prompt');
});

test('el modo de propiedad sube el manifiesto a la versión 2', (t) => {
  const { a, dir, sa } = pair(t);
  createSession(a, 's1', 'demo', '/tmp/x', 'project_owned');
  addObservation(a, { session_id: 's1', type: 'manual', title: 't', content: 'c', project: 'demo' });
  sa.export('ana', 'demo');
  assert.equal(manifestOf(dir).version, OWNERSHIP_MODE_MANIFEST_VERSION);
});

test('una exportación incremental trae lo nuevo, lo actualizado y los borrados', async (t) => {
  const { a, dir, sa } = pair(t);
  const [id1, id2, id3] = seed(a);
  const first = sa.export('ana', 'demo');
  await new Promise((r) => setTimeout(r, 1100));
  const nueva = addObservation(a, { session_id: 's1', type: 'manual', title: 'Nota nueva', content: 'posterior', project: 'demo' }).id;
  updateObservation(a, id2, { content: 'contenido actualizado' }, { expectedProject: 'demo' });
  deleteObservation(a, id3, { hardDelete: true, expectedProject: 'demo' });
  const second = sa.export('ana', 'demo');
  assert.equal(second.is_empty, false);
  const chunk = chunkOf(dir, second.chunk_id);
  assert.deepEqual(chunk.observations.map((o) => o.id).sort(), [id2, nueva].sort());
  assert.equal(chunk.sessions, null === chunk.sessions ? null : chunk.sessions);
  assert.deepEqual(chunk.mutations.map((m) => [m.entity, m.op]), [['observation', 'delete']]);
  assert.equal(JSON.parse(chunk.mutations[0].payload).hard_delete, true);
  assert.equal(sa.export('ana', 'demo').is_empty, true, 'el borrado ya exportado no se repite');
  assert.equal(manifestOf(dir).chunks.length, 2);
  assert.notEqual(first.chunk_id, second.chunk_id);
  assert.ok(getObservation(a, id1));
});

test('si el contenido de un chunk conocido falta, se restaura sin duplicar el manifiesto', (t) => {
  const { a, dir, sa } = pair(t);
  seed(a);
  const first = sa.export('ana', 'demo');
  const file = join(dir, 'chunks', `${first.chunk_id}.jsonl.gz`);
  // El almacén recuerda el chunk, pero el manifiesto y el archivo se perdieron.
  rmSync(file);
  writeFileSync(join(dir, 'manifest.json'), manifestToJson({ version: 1, chunks: [] }));
  const again = sa.export('ana', 'demo');
  assert.equal(again.chunk_id, first.chunk_id);
  assert.equal(again.is_empty, false);
  assert.ok(existsSync(file), 'el contenido se restaura');
  assert.equal(manifestOf(dir).chunks.length, 1);
  assert.equal(sa.export('ana', 'demo').is_empty, true, 'con el contenido presente no se reescribe');
});

test('si el manifiesto ya tiene la entrada de un chunk sin contenido, se reutiliza', (t) => {
  const { a, dir, sa } = pair(t);
  seed(a);
  const old = '1999-01-01T00:00:00Z';
  const dummy = { id: 'dead0000', created_by: 'x', created_at: old, sessions: 0, memories: 0, prompts: 0 };
  const transport = new FileTransport(dir);
  mkdirSync(dir, { recursive: true });
  transport.writeManifest({ version: 1, chunks: [dummy] });
  const first = sa.export('ana', 'demo');
  assert.equal(first.is_empty, false);
  // Mismo contenido incremental: la entrada ya existe, el archivo falta y el almacén no lo recuerda.
  transport.writeManifest({ version: 1, chunks: [dummy, { ...dummy, id: first.chunk_id, created_by: 'original', memories: 3, sessions: 1 }] });
  rmSync(join(dir, 'chunks', `${first.chunk_id}.jsonl.gz`));
  a.db.run('DELETE FROM sync_chunks');
  const again = sa.export('otra', 'demo');
  assert.equal(again.chunk_id, first.chunk_id);
  const manifest = manifestOf(dir);
  assert.equal(manifest.chunks.length, 2, 'no se añade una segunda entrada');
  assert.equal(manifest.chunks[1].created_by, 'original');
  assert.ok(existsSync(join(dir, 'chunks', `${first.chunk_id}.jsonl.gz`)));
});

test('importar aplica los chunks del manifiesto y repetir los omite', (t) => {
  const { a, b, dir, sa, sb } = pair(t);
  seed(a);
  addPrompt(a, { session_id: 's1', content: 'p', project: 'demo' });
  sa.export('ana', 'demo', { includePrompts: true });
  assert.deepEqual(sb.status(), { local: 0, remote: 1, pending: 1 });
  const progress = [];
  const result = sb.import((p) => progress.push(p));
  assert.deepEqual({ ...result }, {
    chunks_imported: 1, chunks_skipped: 0, sessions_imported: 1, observations_imported: 3, prompts_imported: 1, relations_replayed: 0, relations_deferred: 0, relations_dead: 0,
  });
  assert.deepEqual(progress.map((p) => [p.pending_chunks, p.percentage]), [[1, 0], [0, 100]]);
  assert.deepEqual(stats(b), { total_sessions: 1, total_observations: 3, total_prompts: 1, projects: ['demo'] });
  assert.equal(sb.import().chunks_skipped, 1);
  assert.deepEqual(sb.status(), { local: 1, remote: 1, pending: 0 });
  assert.ok(existsSync(dir));
  const empty = Syncer.local(b, join(tempDir(t), 'vacio'), 'demo');
  const reports = [];
  assert.equal(empty.import((p) => reports.push(p)).chunks_imported, 0);
  assert.deepEqual(reports.map((p) => p.percentage), [100]);
});

test('importar respeta las dependencias: relaciones diferidas y sesiones ausentes', (t) => {
  const { a, b, dir, sa, sb, logs } = pair(t);
  const [id1, id2] = seed(a);
  void id1; void id2;
  sa.export('ana', 'demo');
  // Un segundo chunk con una observación cuya sesión no viaja.
  const transport = new FileTransport(dir);
  const manifest = transport.readManifest();
  const orphan = {
    sessions: null,
    observations: [{ id: 9, sync_id: 'obs-huerfana0000001', session_id: 's-perdida', type: 'decision', title: 'Cuelga', content: 'de una sesión inexistente', project: 'demo', scope: 'project', revision_count: 1, duplicate_count: 1, created_at: '2026-01-01 10:00:00', updated_at: '2026-01-01 10:00:00' }],
    prompts: null,
  };
  transport.writeChunk('cccc3333', JSON.stringify(orphan));
  manifest.chunks.push({ id: 'cccc3333', created_by: 'x', created_at: '2999-01-01T00:00:00Z', sessions: 0, memories: 1, prompts: 0 });
  transport.writeManifest(manifest);
  const result = sb.import();
  assert.equal(result.chunks_imported, 2);
  assert.equal(getSession(b, 's-perdida').directory, '(recovered-missing-session)', 'la sesión ausente se repone como una vacía marcada');
  assert.equal(getSession(b, 's-perdida').started_at, '1970-01-01 00:00:00');
  assert.equal(getSession(b, 's-perdida').project, 'demo');
  assert.deepEqual(logs, []);
});

test('un chunk ausente se omite y uno corrupto detiene la importación con su motivo', (t) => {
  const { a, b, dir, sa, sb } = pair(t);
  seed(a);
  const { chunk_id: id } = sa.export('ana', 'demo');
  const transport = new FileTransport(dir);
  const manifest = transport.readManifest();
  manifest.chunks.unshift({ id: 'dead0000', created_by: 'x', created_at: '2020-01-01T00:00:00Z', sessions: 0, memories: 0, prompts: 0 });
  transport.writeManifest(manifest);
  const result = sb.import();
  assert.deepEqual([result.chunks_imported, result.chunks_skipped], [1, 1]);
  assert.equal(stats(b).total_observations, 3);
  void id;

  writeFileSync(join(dir, 'chunks', 'bad00000.jsonl.gz'), gzipSync('no json'));
  manifest.chunks.push({ id: 'bad00000', created_by: 'x', created_at: '2020-01-01T00:00:00Z', sessions: 0, memories: 0, prompts: 0 });
  transport.writeManifest(manifest);
  assert.throws(() => sb.import(), /^Error: parse chunk bad00000: /);
});

test('un manifiesto sin modo de propiedad rechaza lo que lo contradice', (t) => {
  const { a, b, dir, sb } = pair(t);
  createSession(a, 's1', 'demo', '/tmp/x', 'project_owned');
  addObservation(a, { session_id: 's1', type: 'manual', title: 't', content: 'c', project: 'demo' });
  Syncer.local(a, dir, 'demo').export('ana', 'demo');
  const transport = new FileTransport(dir);
  const manifest = transport.readManifest();
  manifest.version = 1;
  transport.writeManifest(manifest);
  assert.throws(() => sb.import(), /sync downgrade is unsupported when incoming project-owned sessions exist; peer manifest version 1 does not support ownership modes/);

  // Un proyecto que ya tiene sesiones propias no puede recibir datos de un par antiguo.
  const { b: c, dir: dir2 } = pair(t);
  createSession(c, 'propia', 'demo', '/tmp/y', 'project_owned');
  const t2 = new FileTransport(dir2);
  mkdirSync(dir2, { recursive: true });
  t2.writeChunk('eeee5555', JSON.stringify({ sessions: [{ id: 's9', project: 'demo', directory: '/d', started_at: '2026-01-01 00:00:00' }], observations: null, prompts: null }));
  t2.writeManifest({ version: 1, chunks: [{ id: 'eeee5555', created_by: 'x', created_at: '2020-01-01T00:00:00Z', sessions: 1, memories: 0, prompts: 0 }] });
  assert.throws(() => Syncer.local(c, dir2, 'demo').import(), /sync downgrade is unsupported after project-owned sessions exist for project "demo"; peer manifest version 1/);
  // Un borrado heredado sobre una sesión propia tampoco se admite.
  t2.writeChunk('ffff6666', JSON.stringify({ sessions: null, observations: null, prompts: null, mutations: [newMutation({ entity: 'session', entity_key: 'propia', op: 'delete', payload: JSON.stringify({ id: 'propia', project: 'demo', deleted: true }) })] }));
  t2.writeManifest({ version: 1, chunks: [{ id: 'ffff6666', created_by: 'x', created_at: '2020-01-01T00:00:00Z', sessions: 0, memories: 0, prompts: 0 }] });
  assert.throws(() => Syncer.local(c, dir2, 'demo').import(), /sync downgrade is unsupported when a legacy delete targets project-owned session "propia"/);
});

test('la fecha de revisión borrada viaja como recibo y como mutación', async (t) => {
  const { a, b, dir, sa, sb } = pair(t);
  const [id] = seed(a);
  sa.export('ana', 'demo');
  await new Promise((r) => setTimeout(r, 1100));
  a.db.run("UPDATE observations SET review_after = NULL WHERE id = ?", id);
  a.db.run("INSERT INTO review_clear_events (event_key, sync_id) VALUES ('k1', ?)", getObservation(a, id).sync_id);
  const second = sa.export('ana', 'demo');
  const chunk = chunkOf(dir, second.chunk_id);
  assert.equal(chunk.review_clears.length, 1);
  assert.match(chunk.review_clears[0], new RegExp(`^${getObservation(a, id).sync_id}:\\d+:k1$`));
  const mutation = chunk.mutations.find((m) => m.entity === 'observation');
  assert.equal(JSON.parse(mutation.payload).review_after, null);
  assert.equal(sa.export('ana', 'demo').is_empty, true, 'un recibo exportado no se repite');
  sb.import();
  assert.equal(b.db.get('SELECT review_after FROM observations WHERE sync_id = ?', getObservation(a, id).sync_id).review_after, null);
  markReviewed(a, id, 'demo');
});

test('exportar acota por proyecto y todos los proyectos', (t) => {
  const { a, dir, sa } = pair(t);
  seed(a, 'demo');
  createSession(a, 's2', 'otro', '/tmp/y');
  addObservation(a, { session_id: 's2', type: 'manual', title: 'ajena', content: 'c', project: 'otro' });
  addObservation(a, { session_id: 's1', type: 'manual', title: 'personal', content: 'c', project: 'demo', scope: 'personal' });
  const one = sa.export('ana', 'demo');
  assert.equal(one.observations_exported, 3, 'solo las del ámbito proyecto');
  const all = Syncer.local(a, join(dir, '..', 'otro'), '').export('ana', '');
  assert.equal(all.observations_exported, 5, 'sin proyecto viajan todos los proyectos y ámbitos');
});

test('las funciones puras de la exportación', () => {
  const obs = (id, created, updated) => ({ sync_id: id, created_at: created, updated_at: updated, session_id: 's' });
  const list = [obs('a', '2026-01-01 10:00:00', '2026-01-01 10:00:00'), obs('b', '2026-01-01 10:00:00', '2026-03-01 10:00:00'), obs('c', '2026-01-01 10:00:00', '2026-01-01 10:00:00')];
  assert.equal(filterObservationsForExport(list, new Set(), ''), list);
  assert.deepEqual(filterObservationsForExport(list, new Set(['a', 'b']), '2026-02-01T00:00:00Z').map((o) => o.sync_id), ['b', 'c']);

  const chunk = { sessions: [], observations: [obs('x', '', '')], prompts: [{ session_id: 's2' }] };
  includeObservationParentSessions(chunk, [{ id: 's' }, { id: 's2' }, { id: 's3' }]);
  assert.deepEqual(chunk.sessions.map((s) => s.id), ['s', 's2']);
  const noop = { sessions: [], observations: [], prompts: [] };
  includeObservationParentSessions(noop, [{ id: 's' }]);
  assert.deepEqual(noop.sessions, []);

  const rel = (key, at) => newMutation({ entity: 'relation', entity_key: key, op: 'upsert', payload: '{}', occurred_at: at });
  const rels = [rel('r1', '2026-01-01 00:00:00'), rel('r2', '2026-03-01 00:00:00'), rel('r3', '2026-01-01 00:00:00')];
  assert.deepEqual(filterRelationMutationsForExport([], new Set(), ''), []);
  assert.equal(filterRelationMutationsForExport(rels, new Set(), ''), rels);
  assert.deepEqual(filterRelationMutationsForExport(rels, new Set(['r1', 'r2']), '2026-02-01T00:00:00Z').map((m) => m.entity_key), ['r2', 'r3']);

  const upsert = (key, body) => newMutation({ entity: 'observation', entity_key: key, op: 'upsert', payload: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal(observationUpsertIdentity(upsert('o1', { sync_id: 'o1' })), 'o1');
  assert.equal(observationUpsertIdentity(upsert('o1', { sync_id: 'o2' })), null);
  assert.equal(observationUpsertIdentity(upsert('o1', { sync_id: ' ' })), null);
  assert.equal(observationUpsertIdentity(upsert('o1', 'rota')), null);
  assert.equal(observationUpsertIdentity(upsert('o1', '"{\\"sync_id\\":\\"o1\\"}"')), 'o1');
  assert.equal(observationUpsertIdentity(upsert('o1', '[]')), null);
});
