// Contraste diferencial de doctor: el mismo almacén dañado produce el mismo informe en la referencia y en odin.
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
  base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-doctor-')));
});
after(() => {
  for (const close of closers) close();
  if (base) rmSync(base, { recursive: true, force: true });
  binary?.cleanup();
});

const MASKS = [
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
  out = out.replace(/\/[^\s"']*?conformance-doctor-[A-Za-z0-9]+\/[a-z]+-\d+\/(ref|odin)\/[^/\s"']*/g, '<DIR>');
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

test('almacén sano: informe y ayuda iguales', { skip }, async () => {
  const world = newWorld('sano');
  await seed(world);
  world.same(['doctor']);
  world.same(['doctor', '--json']);
  world.same(['doctor', '--project', 'demo']);
  world.same(['doctor', '--project', 'demo', '--json']);
  world.same(['doctor', '--check', 'sqlite_lock_contention', '--json']);
  world.same(['doctor', '--check', 'unowned_session_project']);
  world.same(['doctor', '--help']);
  world.same(['doctor', '--check', 'no_existe']);
  world.same(['doctor', '--check', 'no_existe', '--json']);
  world.same(['doctor', '--bogus']);
  world.same(['doctor', '--project']);
  world.same(['doctor', '--check']);
});

test('almacén dañado: cada chequeo informa lo mismo', { skip }, async () => {
  const world = newWorld('danado');
  await seed(world);
  both(world, [
    // Observaciones huérfanas (sin sesión) y sin título.
    ["PRAGMA foreign_keys = OFF"],
    ["UPDATE observations SET session_id = 'sesion-perdida' WHERE id = 3"],
    ["UPDATE observations SET title = '' WHERE id = 4"],
    // Sesión sin propiedad clasificada.
    ["INSERT INTO sessions (id, project, directory, started_at) VALUES ('s-sin-modo', 'demo', '/tmp/x', '2026-01-01 00:00:00')"],
    ["UPDATE sessions SET ownership_mode = 'bogus' WHERE id = 's-sin-modo'"],
    // Relación pendiente con extremos inexistentes.
    ["INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status, marked_by_actor, marked_by_kind) VALUES ('rel-0000000000000001', 'obs-x', 'obs-y', 'related', 'pending', 'sys', 'system')"],
    // Destino de sincronización ajeno.
    ["INSERT INTO sync_state (target_key, lifecycle) VALUES ('cloud:fantasma', 'idle')"],
  ]);
  world.same(['doctor']);
  world.same(['doctor', '--json']);
  world.same(['doctor', '--project', 'demo', '--json']);
  for (const code of ['orphaned_observation_session', 'unowned_session_project', 'orphaned_pending_relations', 'sync_target_closed_space', 'sync_mutation_required_fields']) {
    world.same(['doctor', '--check', code, '--json']);
    world.same(['doctor', '--check', code]);
  }
});

test('diario con cargas incompletas, cuarentena y reemplazos', { skip }, async () => {
  const world = newWorld('diario');
  await seed(world);
  both(world, [
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'observation', 'obs-a', 'upsert', '{\"sync_id\":\"obs-a\",\"session_id\":\"sesion-1\"}', 'demo')"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'session', 'ses-b', 'upsert', '', 'demo')"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, disposition, disposition_reason, disposition_evidence, disposition_at) VALUES ('cloud', 'observation', 'obs-c', 'upsert', '{}', 'demo', 'quarantined', 'r', 'e', '2026-01-01 00:00:00')"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, disposition) VALUES ('cloud', 'prompt', 'p-d', 'upsert', '{}', 'demo', 'superseded')"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'widget', 'w', 'upsert', '{}', 'demo')"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'relation', 'r', 'upsert', '{\"sync_id\":\"r\"}', 'demo')"],
  ]);
  world.same(['doctor', '--check', 'sync_mutation_required_fields', '--json']);
  world.same(['doctor', '--check', 'sync_mutation_required_fields', '--project', 'demo']);
  // Con un proyecto inscrito, el atraso de otro proyecto bloquea.
  both(world, [["INSERT INTO sync_enrolled_projects (project) VALUES ('inscrito')"]]);
  world.same(['doctor', '--check', 'sync_mutation_required_fields', '--json']);
  world.same(['doctor', '--check', 'sync_target_closed_space', '--json']);
});

test('identidad de sesión inválida y cuarentena de recibidas', { skip }, async () => {
  const world = newWorld('identidad');
  await seed(world);
  both(world, [
    ["PRAGMA foreign_keys = OFF"],
    ["INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES (' ', 'demo', '/tmp/x', '2026-01-01 00:00:00', 'shared')"],
    ["UPDATE observations SET session_id = ' ' WHERE id = 2"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'session', ' ', 'upsert', '{\"id\":\" \"}', 'demo')"],
    ["INSERT INTO sync_apply_deferred (sync_id, entity, payload, target_key, project, scope_class, apply_status, reason_code, first_seen_at, entity_key, op, remote_seq) VALUES ('d1', 'session', '{}', 'local', 'demo', 'scoped', 'dead', 'sync_session_identity_invalid', '2026-01-01 00:00:00', ' ', 'upsert', 3)"],
  ]);
  world.same(['doctor', '--check', 'invalid_session_identity', '--json']);
  world.same(['doctor', '--check', 'invalid_session_identity', '--project', 'demo']);
});

test('sesiones: ambigüedad de ejecución y proyecto distinto del directorio', { skip }, async () => {
  const world = newWorld('sesiones');
  await seed(world);
  both(world, [
    ["INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES ('rt-a', 'demo', '/tmp/amb', datetime('now'), 'shared')"],
    ["INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES ('rt-b', 'demo', '/tmp/amb', datetime('now'), 'shared')"],
    ["INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES ('manual-save-otro', 'demo', '/tmp/zzz', datetime('now'), 'shared')"],
    ["INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES ('rt-o', 'otro', '/tmp/zzz2', datetime('now'), 'shared')"],
  ]);
  world.same(['doctor', '--check', 'ambiguous_active_runtime_sessions', '--json']);
  world.same(['doctor', '--check', 'manual_session_name_project_mismatch', '--json']);
  world.same(['doctor', '--check', 'session_project_directory_mismatch', '--json']);
  world.same(['doctor', '--json']);
});
