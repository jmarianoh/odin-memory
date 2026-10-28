// Contraste diferencial de la sincronización por Git: los mismos comandos sobre la referencia y
// sobre odin producen la misma salida y los mismos chunks (decodificados), y cada lado importa
// los chunks del otro con el mismo resultado.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolveBinary, startMcpCommand } from './engram-mcp.mjs';

const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';
const ODIN_BIN = fileURLToPath(new URL('../../bin/odin.js', import.meta.url));

let base;
const closers = [];
let counter = 0;

before(() => {
  if (!binary) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-sync-')));
});
after(() => {
  for (const close of closers) close();
  if (base) rmSync(base, { recursive: true, force: true });
  binary?.cleanup();
});

const MASKS = [
  [/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /gm, ''],
  [/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<T>'],
  [/(obs|rel|prompt|ses)-[0-9a-f]{16}/g, '$1-X'],
  [/\b[0-9a-f]{8}\b(?=[".\s])/g, '<CHUNK>'],
  [/\.engram/g, '.odin-memory'],
  [/ENGRAM_/g, 'ODIN_'],
  [/Engram/g, 'Odin'],
  [/engram/g, 'odin'],
];

function maskText(text, world) {
  let out = String(text ?? '');
  for (const dir of [world.refRepo, world.odinRepo, world.refDir, world.odinDir]) out = out.split(dir).join('<DIR>');
  out = out.replace(/\/[^\s"']*?conformance-sync-[A-Za-z0-9]+\/[a-z]+-\d+\/(ref|odin)\/[^/\s"']*/g, '<DIR>');
  for (const [pattern, replacement] of MASKS) out = out.replace(pattern, replacement);
  return out;
}

function maskValue(value, world) {
  if (typeof value === 'string') return maskText(value, world);
  if (typeof value === 'number' && !Number.isInteger(value)) return Number(value.toPrecision(10));
  if (Array.isArray(value)) return value.map((v) => maskValue(v, world));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskValue(v, world)]));
  return value;
}

/** Un par de repositorios (referencia y odin) con almacenes de datos propios. */
function newWorld(name) {
  counter += 1;
  const dir = join(base, `${name}-${counter}`);
  mkdirSync(dir);
  const make = (label) => {
    mkdirSync(join(dir, label));
    const repo = join(dir, label, name);
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    return repo;
  };
  const world = { dir, name, refRepo: make('ref'), odinRepo: make('odin'), refDir: join(dir, 'ref-data'), odinDir: join(dir, 'odin-data') };
  const run = (side, args, { input, cwd, env = {} } = {}) => {
    if (side === 'ref') {
      return spawnSync(binary.bin, args, {
        cwd: cwd ?? world.refRepo, input, encoding: 'utf8', env: { ...process.env, ENGRAM_DATA_DIR: world.refDir, ENGRAM_NO_UPDATE_CHECK: '1', HOME: dir, USER: 'tester', ...env },
      });
    }
    const odinEnv = Object.fromEntries(Object.entries(env).map(([k, v]) => [k.replace(/^ENGRAM_/, 'ODIN_'), v]));
    return spawnSync(process.execPath, ['--no-warnings', ODIN_BIN, ...args], {
      cwd: cwd ?? world.odinRepo, input, encoding: 'utf8', env: { ...process.env, ODIN_DATA_DIR: world.odinDir, HOME: dir, USER: 'tester', ...odinEnv },
    });
  };
  world.run = run;
  /** Ejecuta el mismo comando en ambos y exige la misma salida y código. */
  world.same = (args, options = {}) => {
    const ref = run('ref', args, options);
    const odin = run('odin', args, options);
    const label = `odin ${args.join(' ')}`;
    assert.equal(odin.status, ref.status, `${label}: código\n--- ref stderr\n${ref.stderr}\n--- odin stderr\n${odin.stderr}`);
    assert.equal(maskText(odin.stdout, world), maskText(ref.stdout, world), `${label}: stdout`);
    assert.equal(maskText(odin.stderr, world), maskText(ref.stderr, world), `${label}: stderr`);
    return { ref, odin };
  };
  /** Chunks decodificados (en orden de manifiesto) de cada lado. */
  world.chunks = (side) => {
    const repo = side === 'ref' ? world.refRepo : world.odinRepo;
    const dirName = side === 'ref' ? '.engram' : '.odin-memory';
    const manifestPath = join(repo, dirName, 'manifest.json');
    if (!existsSync(manifestPath)) return { manifest: null, chunks: [] };
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const chunks = manifest.chunks.map((entry) => JSON.parse(gunzipSync(readFileSync(join(repo, dirName, 'chunks', `${entry.id}.jsonl.gz`))).toString('utf8')));
    return { manifest, chunks };
  };
  return world;
}

/** Siembra los dos almacenes por MCP con el mismo contenido. */
async function seed(world, extra = async () => {}) {
  const ref = startMcpCommand(binary.bin, ['mcp', '--tools=all'], { cwd: world.refRepo, dataDir: world.refDir, env: { ENGRAM_DATA_DIR: world.refDir, ENGRAM_NO_UPDATE_CHECK: '1' } });
  const odin = startMcpCommand(process.execPath, ['--no-warnings', ODIN_BIN, 'mcp', '--tools=all'], { cwd: world.odinRepo, dataDir: world.odinDir, env: { ODIN_DATA_DIR: world.odinDir } });
  closers.push(() => ref.close(), () => odin.close());
  await Promise.all([ref.initialize(), odin.initialize()]);
  const both = async (tool, args) => {
    const [a, b] = await Promise.all([ref.call(tool, args), odin.call(tool, args)]);
    assert.equal(b.isError, a.isError, `${tool}: ${a.text} / ${b.text}`);
    return [a, b];
  };
  await both('mem_session_start', { id: 'sesion-1' });
  for (const [title, content, type] of [
    ['Usar Redis para la caché', 'decidimos Redis como caché distribuida', 'decision'],
    ['Redis como caché distribuida', 'la caché distribuida vive en Redis', 'decision'],
    ['Preferencia de formato', 'tabulaciones de dos espacios', 'preference'],
    ['Bug del login', 'el login falla con tokens expirados', 'bugfix'],
  ]) await both('mem_save', { title, content, type, project: 'demo', session_id: 'sesion-1' });
  await both('mem_save_prompt', { content: 'primer prompt', session_id: 'sesion-1', project: 'demo' });
  await extra(both);
  ref.close();
  odin.close();
}

const dbPath = (world, side) => join(side === 'ref' ? world.refDir : world.odinDir, side === 'ref' ? 'engram.db' : 'odin.db');

function sql(world, side, query) {
  const db = new DatabaseSync(dbPath(world, side), { readOnly: true, timeout: 5000 });
  try {
    return db.prepare(query).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

const STATE_QUERIES = {
  observations: 'SELECT id, type, title, content, project, scope, topic_key, revision_count, duplicate_count, review_after IS NOT NULL AS has_review, deleted_at IS NOT NULL AS deleted, superseded_by_sync_id IS NOT NULL AS superseded FROM observations ORDER BY title, id',
  sessions: 'SELECT id, project, ownership_mode, directory, summary, ended_at IS NOT NULL AS ended FROM sessions ORDER BY id',
  prompts: 'SELECT session_id, content, project FROM user_prompts ORDER BY content',
  relations: 'SELECT relation, judgment_status FROM memory_relations ORDER BY relation, judgment_status',
  tombstones: 'SELECT entity, entity_key, hard_delete, active FROM sync_delete_tombstones ORDER BY entity, entity_key',
  deferred: 'SELECT entity, apply_status, reason_code, retry_count FROM sync_apply_deferred ORDER BY entity, apply_status',
  chunks: 'SELECT target_key, COUNT(*) AS n FROM sync_chunks GROUP BY target_key',
};

/** Estado normalizado de los dos almacenes: deben coincidir tabla a tabla. */
function assertSameState(world, label) {
  for (const [name, query] of Object.entries(STATE_QUERIES)) {
    const ref = sql(world, 'ref', query).map((row) => ({ ...row, entity_key: undefined }));
    const odin = sql(world, 'odin', query).map((row) => ({ ...row, entity_key: undefined }));
    assert.deepStrictEqual(maskValue(odin, world), maskValue(ref, world), `${label}: ${name}`);
  }
}

test('uso y validaciones de sync', { skip }, () => {
  const w = newWorld('uso');
  for (const args of [
    ['sync', '--help'], ['sync', '-h'], ['sync', 'help'], ['sync', '--include-prompts', '--import'], ['sync', '--include-prompts', '--status'],
    ['sync', '--all', '--project', 'demo'], ['sync', '--project'], ['sync', '--project='], ['sync', '--literal-project'], ['sync', '--import', '--include-prompts', '--help'],
  ]) w.same(args);
});

test('exportar: primer chunk, repetición vacía y salida de estado', { skip }, async () => {
  const w = newWorld('exportar');
  await seed(w);
  w.same(['sync', '--status', '--project', 'demo']);
  w.same(['sync', '--project', 'demo']);
  w.same(['sync', '--project', 'demo']);
  w.same(['sync', '--status', '--project', 'demo']);
  const ref = w.chunks('ref');
  const odin = w.chunks('odin');
  assert.equal(odin.manifest.version, ref.manifest.version);
  assert.deepStrictEqual(maskValue(odin.chunks, w), maskValue(ref.chunks, w));
  assert.deepStrictEqual(maskValue(odin.manifest.chunks.map(({ id, created_at, ...rest }) => rest), w), maskValue(ref.manifest.chunks.map(({ id, created_at, ...rest }) => rest), w));
  assert.equal(odin.manifest.chunks[0].created_by, 'tester');
  assert.match(odin.manifest.chunks[0].id, /^[0-9a-f]{8}$/);
  assert.match(odin.manifest.chunks[0].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  // El archivo del manifiesto lleva sangría de dos espacios y los chunks son gzip de un único objeto JSON.
  assert.match(readFileSync(join(w.odinRepo, '.odin-memory', 'manifest.json'), 'utf8'), /^\{\n {2}"version": 1,\n {2}"chunks": \[\n {4}\{/);
  assert.deepStrictEqual(readdirSync(join(w.odinRepo, '.odin-memory', 'chunks')).map((f) => f.length), [`${odin.manifest.chunks[0].id}.jsonl.gz`.length]);
});

test('exportar todos los proyectos y con prompts', { skip }, async () => {
  const w = newWorld('todos');
  await seed(w);
  w.same(['sync', '--all']);
  w.same(['sync', '--all', '--include-prompts']);
  w.same(['sync', '--project', 'demo', '--include-prompts']);
  w.same(['sync', '--project', 'demo', '--include-prompts']);
  const ref = w.chunks('ref');
  const odin = w.chunks('odin');
  assert.equal(odin.chunks.length, ref.chunks.length);
  assert.deepStrictEqual(maskValue(odin.chunks, w), maskValue(ref.chunks, w));
});

test('exportación incremental: nuevas, actualizadas, borradas y relaciones', { skip }, async () => {
  const w = newWorld('incremental');
  await seed(w);
  w.same(['sync', '--project', 'demo']);
  // Cambios posteriores en ambos lados.
  const ref = startMcpCommand(binary.bin, ['mcp', '--tools=all'], { cwd: w.refRepo, dataDir: w.refDir, env: { ENGRAM_DATA_DIR: w.refDir, ENGRAM_NO_UPDATE_CHECK: '1' } });
  const odin = startMcpCommand(process.execPath, ['--no-warnings', ODIN_BIN, 'mcp', '--tools=all'], { cwd: w.odinRepo, dataDir: w.odinDir, env: { ODIN_DATA_DIR: w.odinDir } });
  closers.push(() => ref.close(), () => odin.close());
  await Promise.all([ref.initialize(), odin.initialize()]);
  const both = async (tool, args) => {
    const [a, b] = await Promise.all([ref.call(tool, args), odin.call(tool, args)]);
    assert.equal(b.isError, a.isError, `${tool}: ${a.text} / ${b.text}`);
  };
  await new Promise((r) => setTimeout(r, 1100));
  await both('mem_save', { title: 'Nota nueva', content: 'una nota posterior al primer chunk', type: 'manual', project: 'demo', session_id: 'sesion-1' });
  await both('mem_update', { id: 3, content: 'tabulaciones de cuatro espacios', project: 'demo' });
  await both('mem_delete', { id: 4, hard_delete: true, project: 'demo' });
  ref.close();
  odin.close();
  w.same(['sync', '--project', 'demo']);
  w.same(['sync', '--project', 'demo']);
  w.same(['conflicts', 'scan', '--project', 'demo', '--apply']);
  w.same(['sync', '--project', 'demo']);
  w.same(['sync', '--project', 'demo']);
  const a = w.chunks('ref');
  const b = w.chunks('odin');
  assert.equal(b.chunks.length, a.chunks.length);
  assert.deepStrictEqual(maskValue(b.chunks, w), maskValue(a.chunks, w));
});

/** Fechas deterministas en ambas bases: el orden de la búsqueda depende de ellas. */
function freezeDates(world) {
  for (const side of ['ref', 'odin']) {
    const db = new DatabaseSync(dbPath(world, side), { timeout: 5000 });
    db.exec(`UPDATE observations SET created_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes'), updated_at = created_at, last_seen_at = created_at`);
    db.exec("UPDATE user_prompts SET created_at = datetime('2026-03-03 10:00:00', '+' || id || ' minutes')");
    db.exec("UPDATE sessions SET started_at = '2026-03-01 09:00:00'");
    db.exec("UPDATE memory_relations SET created_at = '2026-03-01 12:00:00', updated_at = '2026-03-01 12:00:00'");
    db.close();
  }
}

test('importar: cada lado importa los chunks del otro y queda el mismo estado', { skip }, async () => {
  const src = newWorld('origen');
  await seed(src);
  freezeDates(src);
  src.same(['sync', '--project', 'demo']);
  src.same(['conflicts', 'scan', '--project', 'demo', '--apply']);
  src.same(['sync', '--project', 'demo']);

  // Los chunks de la referencia los importa odin, y viceversa; el destino de cada uno es un almacén vacío.
  const dst = newWorld('destino');
  cpSync(join(src.refRepo, '.engram'), join(dst.odinRepo, '.odin-memory'), { recursive: true });
  cpSync(join(src.odinRepo, '.odin-memory'), join(dst.refRepo, '.engram'), { recursive: true });
  const { ref, odin } = dst.same(['sync', '--import', '--project', 'demo']);
  assert.match(ref.stdout, /Imported \d+ new chunk/);
  assert.match(odin.stdout, /Imported \d+ new chunk/);
  assertSameState(dst, 'tras importar');
  dst.same(['sync', '--import', '--project', 'demo']);
  dst.same(['sync', '--status', '--project', 'demo']);
  // Cada lado importó identidades aleatorias distintas: el desempate de la búsqueda por identidad
  // depende del azar, así que se fijan antes de comparar el orden de los resultados.
  for (const side of ['ref', 'odin']) {
    const db = new DatabaseSync(dbPath(dst, side), { timeout: 5000 });
    db.exec("UPDATE observations SET sync_id = 'obs-' || printf('%016d', id)");
    db.close();
  }
  dst.same(['search', 'Redis', '--project', 'demo']);
  dst.same(['conflicts', 'list', '--project', 'demo']);
  dst.same(['stats', '--project', 'demo']);
});

test('importar con manifiesto vacío, sin directorio y con un chunk ausente', { skip }, () => {
  const w = newWorld('vacio');
  w.same(['sync', '--import', '--project', 'demo']);
  w.same(['sync', '--status', '--project', 'demo']);
  for (const [side, dirName] of [['ref', '.engram'], ['odin', '.odin-memory']]) {
    const repo = side === 'ref' ? w.refRepo : w.odinRepo;
    mkdirSync(join(repo, dirName));
    writeFileSync(join(repo, dirName, 'manifest.json'), JSON.stringify({ version: 1, chunks: [{ id: 'deadbeef', created_by: 'x', created_at: '2026-01-01T00:00:00Z', sessions: 1, memories: 1, prompts: 0 }] }));
  }
  w.same(['sync', '--status', '--project', 'demo']);
  w.same(['sync', '--import', '--project', 'demo']);
});

test('importar cuando el chunk depende de una sesión que falta, relaciones diferidas y borrados', { skip }, async () => {
  const w = newWorld('dependencias');
  const chunk = {
    sessions: null,
    observations: [{
      id: 1, sync_id: 'obs-0000000000000001', session_id: 'ses-perdida', type: 'decision', title: 'Huérfana', content: 'cuelga de una sesión inexistente', project: 'demo',
      scope: 'project', revision_count: 1, duplicate_count: 1, created_at: '2026-01-01 10:00:00', updated_at: '2026-01-01 10:00:00',
    }],
    prompts: null,
    mutations: [
      {
        seq: 0, target_key: '', entity: 'relation', entity_key: 'rel-0000000000000001', op: 'upsert', source: '', project: 'demo', occurred_at: '2026-01-01 10:00:00', disposition: '',
        payload: JSON.stringify({ sync_id: 'rel-0000000000000001', source_id: 'obs-0000000000000001', target_id: 'obs-ausente0000000002', relation: 'related', judgment_status: 'judged', project: 'demo', created_at: '2026-01-01 10:00:00', updated_at: '2026-01-01 10:00:00' }),
      },
      {
        seq: 0, target_key: '', entity: 'observation', entity_key: 'obs-borrada000000003', op: 'delete', source: '', project: 'demo', occurred_at: '2026-01-02 10:00:00', disposition: '',
        payload: JSON.stringify({ sync_id: 'obs-borrada000000003', session_id: 'ses-perdida', type: '', title: '', content: '', project: 'demo', scope: '', revision_count: 0, duplicate_count: 0, deleted: true, deleted_at: '2026-01-02 10:00:00', hard_delete: true }),
      },
    ],
  };
  const { gzipSync } = await import('node:zlib');
  const json = JSON.stringify(chunk);
  const id = 'abcd1234';
  for (const [repo, dirName] of [[w.refRepo, '.engram'], [w.odinRepo, '.odin-memory']]) {
    mkdirSync(join(repo, dirName, 'chunks'), { recursive: true });
    writeFileSync(join(repo, dirName, 'chunks', `${id}.jsonl.gz`), gzipSync(json));
    writeFileSync(join(repo, dirName, 'manifest.json'), JSON.stringify({ version: 1, chunks: [{ id, created_by: 'x', created_at: '2026-01-03T00:00:00Z', sessions: 0, memories: 1, prompts: 0 }] }));
  }
  w.same(['sync', '--import', '--project', 'demo']);
  w.same(['sync', '--import', '--project', 'demo']);
  assertSameState(w, 'dependencias');
  w.same(['conflicts', 'deferred']);
  w.same(['conflicts', 'deferred', '--replay']);
  w.same(['conflicts', 'stats', '--all']);
});

test('rescue-ownership: propiedad de registros históricos', { skip }, async () => {
  const w = newWorld('rescate');
  await seed(w);
  for (const side of ['ref', 'odin']) {
    const db = new DatabaseSync(dbPath(w, side), { timeout: 5000 });
    db.exec("UPDATE observations SET project = NULL WHERE id IN (3, 4)");
    db.exec("UPDATE sessions SET project = ''");
    db.exec("UPDATE user_prompts SET project = NULL");
    db.close();
  }
  w.same(['projects', 'rescue-ownership']);
  w.same(['projects', 'rescue-ownership', '--project', 'demo']);
  w.same(['projects', 'rescue-ownership', '--session', 's']);
  w.same(['projects', 'rescue-ownership', '--project', 'demo', '--observation', 'x']);
  w.same(['projects', 'rescue-ownership', '--project', 'demo', '--observation', '0']);
  w.same(['projects', 'rescue-ownership', '--project', 'demo', '--session', ' ']);
  w.same(['projects', 'rescue-ownership', '--project', 'demo', '--observation', '3', '--observation', '999', '--session', 'sesion-1']);
  w.same(['projects', 'rescue-ownership', '--project', 'demo', '--observation', '3', '--prompt', '1']);
  w.same(['projects', 'rescue-ownership', '--project', 'otro', '--observation', '1']);
  w.same(['projects', 'rescue-ownership', '--project', 'otro', '--observation', '4']);
  w.same(['projects', 'rescue-ownership', '--project', 'demo', '--observation', '4', '--prompt', '1', '--prompt', '2']);
  assertSameState(w, 'tras el rescate');
  w.same(['projects']);
});
