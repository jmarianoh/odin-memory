// Contraste diferencial de las reparaciones del diario de `doctor repair`: la misma base dañada produce el mismo informe y la misma base resultante.
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
  base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-jrepair-')));
});
after(() => {
  for (const close of closers) close();
  if (base) rmSync(base, { recursive: true, force: true });
  binary?.cleanup();
});

const MASKS = [
  [/<DIR>\/backups\/(?:engram|odin)-repair-[0-9TZ.]+\.db/g, '<BACKUP>'],
  [/"checkpoint_log": \d+/g, '"checkpoint_log": N'],
  [/"checkpointed_frames": \d+/g, '"checkpointed_frames": N'],
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
  out = out.replace(/\/[^\s"']*?conformance-jrepair-[A-Za-z0-9]+\/[a-z]+-\d+\/(ref|odin)\/[^/\s"']*/g, '<DIR>');
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

/** Ejecuta sentencias en ambos almacenes. */
function both(world, statements) {
  for (const side of ['ref', 'odin']) {
    const db = new DatabaseSync(dbPath(world, side), { timeout: 5000 });
    for (const [text, ...params] of statements) db.prepare(text).run(...params);
    db.close();
  }
}

const dump = (world, side, sql) => {
  const db = new DatabaseSync(dbPath(world, side), { readOnly: true });
  try {
    return db.prepare(sql).all().map((r) => {
      const row = { ...r };
      for (const key of ['payload', 'disposition_evidence']) {
        if (typeof row[key] === 'string') {
          try {
            const parsed = JSON.parse(row[key]);
            for (const k of ['revision_count', 'duplicate_count']) if (parsed && parsed[k] === 0) delete parsed[k];
            row[key] = parsed;
          } catch { /* texto */ }
        }
      }
      return row;
    });
  } finally {
    db.close();
  }
};
const journal = (world, side) => dump(world, side, "SELECT seq, entity, entity_key, op, project, source, acked_at IS NOT NULL AS acked, disposition, disposition_reason, disposition_evidence, payload FROM sync_mutations ORDER BY seq");
const observations = (world, side) => dump(world, side, 'SELECT id, sync_id, title, type, content FROM observations ORDER BY id');
const lifecycle = (world, side) => dump(world, side, "SELECT target_key, lifecycle FROM sync_state ORDER BY target_key");
const sameDb = (world, label) => {
  for (const [name, read] of [['diario', journal], ['observaciones', observations], ['ciclo de vida', lifecycle]]) {
    assert.deepEqual(maskValue(read(world, 'odin'), world), maskValue(read(world, 'ref'), world), `${label}: ${name}`);
  }
};
const repair = (world, args) => {
  const r = world.same(['doctor', 'repair', '--check', 'sync_mutation_required_fields', ...args]);
  return r;
};

test('sync_mutation_required_fields: títulos, directorios, sustituciones y cuarentena', { skip }, async () => {
  const world = newWorld('campos');
  await seed(world);
  world.same(['cloud', 'enroll', 'demo']);
  // Diario con cargas incompletas de todos los tipos.
  both(world, [
    ['DELETE FROM sync_mutations'],
    ["UPDATE sessions SET directory = '/work/demo', project = 'demo' WHERE id = 'sesion-1'"],
    // Observación 1: título vacío en la carga (se restaura del local); observación 2: título local vacío (se deriva del contenido).
    ["UPDATE observations SET title = '' WHERE id = 2"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, source) SELECT 'cloud', 'observation', sync_id, 'upsert', json_object('sync_id', sync_id, 'session_id', session_id, 'type', type, 'title', '', 'content', content, 'scope', scope, 'project', project), 'demo', 'local' FROM observations WHERE id IN (1, 2)"],
    // Sesión sin directorio, atribuida por la sesión local.
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'session', 'sesion-1', 'upsert', '{\"id\":\"sesion-1\",\"project\":\"demo\"}', 'demo')"],
    // Irreparables.
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'widget', 'w', 'upsert', '{}', 'demo')"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'prompt', 'p-x', 'upsert', '{\"sync_id\":\"p-x\"}', 'demo')"],
  ]);
  repair(world, ['--plan']);
  repair(world, ['--dry-run']);
  repair(world, ['--project', 'demo']);
  sameDb(world, 'tras simulacro');
  const applied = JSON.parse(repair(world, ['--apply']).odin.stdout);
  assert.ok(applied.repairs.length >= 2 && applied.directory_repairs.length >= 1 && applied.actions.length >= 2, 'el escenario ejercita títulos, directorios y cuarentena');
  sameDb(world, 'tras aplicar');
  repair(world, ['--apply']);
  repair(world, ['--project', 'otro', '--apply']);
  world.same(['doctor', '--check', 'sync_mutation_required_fields', '--json']);
});

test('sync_mutation_required_fields: altas obsoletas de proyectos sin inscribir y títulos de origen', { skip }, async () => {
  const world = newWorld('origen');
  await seed(world);
  both(world, [
    ['DELETE FROM sync_mutations'],
    ["UPDATE observations SET title = '' WHERE id = 3"],
    ["UPDATE observations SET content = '' WHERE id = 4"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, source) SELECT 'cloud', 'observation', sync_id, 'upsert', json_object('sync_id', sync_id), 'demo', 'local' FROM observations WHERE id = 1"],
    ["INSERT INTO sync_delete_tombstones (entity, entity_key, project, deleted_at, hard_delete, active) SELECT 'observation', sync_id, 'demo', datetime('now'), 0, 1 FROM observations WHERE id = 1"],
  ]);
  repair(world, ['--dry-run']);
  const applied = JSON.parse(repair(world, ['--apply']).odin.stdout);
  assert.ok(applied.superseded.length >= 1 && applied.source_repairs.length >= 1 && applied.source_unrepairable.length >= 1, 'el escenario ejercita sustitución y títulos de origen');
  sameDb(world, 'origen');
  repair(world, ['--apply']);
  world.same(['doctor', '--check', 'sync_mutation_required_fields']);
});

test('sync_target_closed_space: destinos ajenos con y sin filas retenidas', { skip }, async () => {
  const world = newWorld('cerrado');
  await seed(world);
  world.same(['cloud', 'enroll', 'demo']);
  world.same(['doctor', 'repair', '--project', 'demo', '--check', 'sync_target_closed_space', '--dry-run']);
  both(world, [
    ["INSERT INTO sync_state (target_key, lifecycle) VALUES ('cloud:fantasma', 'idle')"],
    ["INSERT INTO sync_state (target_key, lifecycle) VALUES ('otro-destino', 'idle')"],
    ["INSERT INTO sync_state (target_key, lifecycle) VALUES ('cloud:retenido', 'idle')"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud:fantasma', 'session', 'sesion-1', 'upsert', '{}', 'demo')"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, acked_at) VALUES ('cloud:retenido', 'session', 'sesion-1', 'upsert', '{}', 'demo', datetime('now'))"],
  ]);
  for (const mode of ['--plan', '--dry-run']) world.same(['doctor', 'repair', '--project', 'demo', '--check', 'sync_target_closed_space', mode]);
  sameDb(world, 'sin cambios');
  world.same(['doctor', 'repair', '--project', 'demo', '--check', 'sync_target_closed_space', '--apply']);
  sameDb(world, 'aplicado');
  world.same(['doctor', 'repair', '--project', 'demo', '--check', 'sync_target_closed_space', '--apply']);
  world.same(['doctor', '--check', 'sync_target_closed_space', '--json']);
});

const sessions = (world, side) => dump(world, side, 'SELECT id, project, directory FROM sessions ORDER BY id');
const prompts = (world, side) => dump(world, side, 'SELECT id, session_id, content FROM user_prompts ORDER BY id');

test('invalid_session_identity: sustitución de una identidad en blanco', { skip }, async () => {
  const world = newWorld('identidad');
  await seed(world);
  world.same(['cloud', 'enroll', 'demo']);
  both(world, [
    ['PRAGMA foreign_keys = OFF'],
    ["INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES (' ', 'demo', '/work/demo', '2026-01-01 00:00:00', 'project_owned')"],
    ["UPDATE observations SET session_id = ' ' WHERE id IN (1, 2)"],
    ["UPDATE user_prompts SET session_id = ' ', project = 'demo'"],
    ["DELETE FROM sync_mutations"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, source) VALUES ('cloud', 'session', ' ', 'upsert', '{\"id\":\" \",\"project\":\"demo\",\"directory\":\"/work/demo\"}', 'demo', 'local')"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, source) SELECT 'cloud', 'observation', sync_id, 'upsert', json_object('sync_id', sync_id, 'session_id', ' ', 'project', 'demo'), 'demo', 'local' FROM observations WHERE id = 1"],
  ]);
  const base = ['doctor', 'repair', '--project', 'demo', '--check', 'invalid_session_identity'];
  for (const mode of ['--plan', '--dry-run']) world.same([...base, mode]);
  world.same([...base, '--replacement-id', 'ses-canonica', '--dry-run']);
  world.same([...base, '--replacement-id', 'ses-canonica', '--plan']);
  world.same([...base, '--replacement-id', 'sesion-1', '--dry-run']);
  world.same([...base, '--replacement-id', ' ', '--dry-run']);
  world.same([...base, '--replacement-id', 'ses-canonica', '--source-id', 'otra', '--dry-run']);
  world.same([...base, '--replacement-id', 'ses-canonica', '--source-id', ' ', '--dry-run']);
  const check = () => {
    sameDb(world, 'identidad');
    for (const [name, read] of [['sesiones', sessions], ['prompts', prompts]]) assert.deepEqual(maskValue(read(world, 'odin'), world), maskValue(read(world, 'ref'), world), name);
  };
  check();
  world.same([...base, '--replacement-id', 'ses-canonica', '--apply']);
  check();
  assert.ok(sessions(world, 'odin').some((r) => r.id === 'ses-canonica') && !sessions(world, 'odin').some((r) => r.id === ' '), 'la identidad se sustituyó');
  assert.ok(journal(world, 'odin').some((r) => r.disposition === 'superseded') && journal(world, 'odin').some((r) => r.entity === 'prompt'), 'se retiró lo pendiente y se publicó lo corregido');
  world.same([...base, '--replacement-id', 'ses-canonica', '--apply']);
  world.same(['doctor', '--check', 'invalid_session_identity', '--json']);
});

test('invalid_session_identity: proyecto sin inscribir y bloqueos', { skip }, async () => {
  const world = newWorld('identidad2');
  await seed(world);
  both(world, [
    ['PRAGMA foreign_keys = OFF'],
    ["INSERT INTO sessions (id, project, directory, started_at) VALUES (' ', 'demo', '/work/demo', '2026-01-01 00:00:00')"],
    ["UPDATE observations SET session_id = ' ' WHERE id = 1"],
  ]);
  const base = ['doctor', 'repair', '--project', 'demo', '--check', 'invalid_session_identity', '--replacement-id', 'canonica'];
  world.same([...base, '--apply']);
  assert.deepEqual(maskValue(sessions(world, 'odin'), world), maskValue(sessions(world, 'ref'), world));
  sameDb(world, 'sin inscribir');
  // Bloqueo por una relación que cuelga de la sesión.
  both(world, [
    ["INSERT INTO sessions (id, project, directory, started_at) VALUES ('\t', 'demo', '/work/demo', '2026-01-01 00:00:00')"],
    ["INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status, marked_by_actor, marked_by_kind, session_id) VALUES ('rel-0000000000000002', 'a', 'b', 'related', 'judged', 'x', 'human', '\t')"],
  ]);
  world.same(['doctor', 'repair', '--project', 'demo', '--check', 'invalid_session_identity', '--replacement-id', 'otra', '--source-id', '\t', '--dry-run']);
  world.same(['doctor', 'repair', '--project', 'demo', '--check', 'invalid_session_identity', '--replacement-id', 'otra', '--dry-run']);
});

test('doctor discard-empty-prompt: simulacro, bloqueos y aplicación', { skip }, async () => {
  const world = newWorld('descarte');
  await seed(world);
  world.same(['cloud', 'enroll', 'demo']);
  const base = ['doctor', 'discard-empty-prompt'];
  world.same([...base, '--help']);
  for (const args of [[], ['--project', 'demo'], ['--project', 'demo', '--seq', 'x'], ['--project', 'demo', '--seq', '0'], ['--project', 'demo', '--seq', '1', '--apply'], ['--project', 'demo', '--seq', '1', '--backup', 'x'],
    ['--project', 'demo', '--seq', '1', '--apply', '--dry-run', '--backup', 'x'], ['--project', 'demo', '--seq', '1', '--seq', '2'], ['--bogus'], ['--project'], ['--project', 'demo', '--seq', '999999']]) {
    world.same([...base, ...args, '--json']);
    world.same([...base, ...args]);
  }
  both(world, [
    ['DELETE FROM sync_mutations'],
    ["UPDATE sessions SET project = 'demo', local_creation_project = 'demo' WHERE id = 'sesion-1'"],
    ["INSERT INTO user_prompts (sync_id, session_id, content, project, source_inbox_id, local_creation_session_id, local_creation_inbox_id, local_creation_project) VALUES ('prompt-vacio-0001', 'sesion-1', '', 'demo', 'in-1', 'sesion-1', 'in-1', 'demo')"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, source) VALUES ('cloud', 'prompt', 'prompt-vacio-0001', 'upsert', '{\"sync_id\":\"prompt-vacio-0001\",\"session_id\":\"sesion-1\",\"content\":\"\",\"project\":\"demo\",\"source_inbox_id\":\"in-1\"}', 'demo', 'local')"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, source) VALUES ('cloud', 'prompt', 'prompt-vacio-0001', 'upsert', '{\"sync_id\":\"prompt-vacio-0001\",\"session_id\":\"sesion-1\",\"content\":\" \",\"project\":\"demo\",\"source_inbox_id\":\"in-1\"}', 'demo', 'local')"],
  ]);
  const seqs = dump(world, 'ref', 'SELECT seq FROM sync_mutations ORDER BY seq').map((r) => String(r.seq));
  world.same([...base, '--project', 'demo', '--seq', seqs[0], '--json']);
  world.same([...base, '--project', 'demo', '--seq', seqs[1], '--dry-run']);
  world.same([...base, '--project', 'otro', '--seq', seqs[0], '--json']);
  world.same([...base, '--project', 'demo', '--seq', '999', '--json']);
  sameDb(world, 'sin cambios');
  // Aplicar: cada lado escribe su copia en su propio directorio.
  const out = {};
  for (const side of ['ref', 'odin']) {
    const dir = side === 'ref' ? world.refDir : world.odinDir;
    out[side] = world.run(side, [...base, '--project', 'demo', '--seq', seqs[0], '--apply', '--backup', join(dir, 'descarte.db'), '--json']);
  }
  assert.equal(out.odin.status, out.ref.status, out.odin.stderr);
  const clean = (text) => maskText(text, world).replace(/<DIR>\/descarte\.db/g, '<BK>');
  assert.equal(clean(out.odin.stdout), clean(out.ref.stdout));
  assert.ok(existsSync(join(world.odinDir, 'descarte.db')));
  const strip = (rows) => rows.map((r) => ({ ...r, disposition_evidence: r.disposition_evidence && typeof r.disposition_evidence === 'object' ? { ...r.disposition_evidence, snapshot_sha256: '<SHA>' } : r.disposition_evidence }));
  assert.deepEqual(maskValue(strip(journal(world, 'odin')), world), maskValue(strip(journal(world, 'ref')), world), 'diario');
  assert.deepEqual(dump(world, 'odin', 'SELECT sync_id, session_id, project, source_inbox_id FROM prompt_tombstones'), dump(world, 'ref', 'SELECT sync_id, session_id, project, source_inbox_id FROM prompt_tombstones'));
  assert.deepEqual(prompts(world, 'odin'), prompts(world, 'ref'));
  assert.ok(journal(world, 'odin').some((r) => r.op === 'delete' && r.entity === 'prompt'), 'se encoló la baja');
  // Repetir: el plan ya no es elegible.
  const again = ['ref', 'odin'].map((side) => world.run(side, [...base, '--project', 'demo', '--seq', seqs[0], '--apply', '--backup', join(side === 'ref' ? world.refDir : world.odinDir, 'otro.db'), '--json']));
  assert.equal(clean(again[1].stdout), clean(again[0].stdout));
  assert.equal(again[1].status, again[0].status);
});

test('projects rescue-ownership: sobre un proyecto inscrito anota lo rescatado en el diario', { skip }, async () => {
  const world = newWorld('rescate');
  await seed(world);
  world.same(['cloud', 'enroll', 'demo']);
  both(world, [
    ["INSERT INTO sessions (id, project, directory, started_at) VALUES ('huerfana', '', '/work/h', '2026-01-01 00:00:00')"],
    ["INSERT INTO observations (sync_id, session_id, type, title, content, project, scope) VALUES ('obs-huerfana-01', 'huerfana', 'note', 'Suelta', 'texto', NULL, 'project')"],
    ["INSERT INTO user_prompts (sync_id, session_id, content, project) VALUES ('prm-huerfano-01', 'huerfana', 'hola', NULL)"],
    ['DELETE FROM sync_mutations'],
  ]);
  const ids = dump(world, 'ref', "SELECT (SELECT id FROM observations WHERE sync_id = 'obs-huerfana-01') AS o, (SELECT id FROM user_prompts WHERE sync_id = 'prm-huerfano-01') AS p")[0];
  const args = ['projects', 'rescue-ownership', '--project', 'demo', '--session', 'huerfana', '--observation', String(ids.o), '--prompt', String(ids.p)];
  world.same(args);
  sameDb(world, 'rescate');
  assert.ok(journal(world, 'odin').length >= 3, 'quedaron anotadas la sesión, la observación y el prompt');
  world.same(args);
  sameDb(world, 'repetido');
  world.same(['projects', 'rescue-ownership', '--project', 'otro', '--session', 'huerfana']);
});
