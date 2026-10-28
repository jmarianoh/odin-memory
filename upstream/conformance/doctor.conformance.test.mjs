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

/** Estado de propiedad y proyecto de ambos almacenes, para compararlo tras reparar. */
function snapshot(world, side) {
  const db = new DatabaseSync(dbPath(world, side), { readOnly: true, timeout: 5000 });
  const rows = (query) => db.prepare(query).all().map((r) => ({ ...r }));
  const out = {
    sessions: rows('SELECT id, project, ownership_mode, directory, ended_at IS NOT NULL AS ended, summary FROM sessions ORDER BY id'),
    observations: rows('SELECT id, session_id, project FROM observations ORDER BY id'),
    prompts: rows('SELECT id, session_id, project FROM user_prompts ORDER BY id'),
    relations: rows('SELECT sync_id, judgment_status FROM memory_relations ORDER BY sync_id'),
  };
  db.close();
  return JSON.parse(maskText(JSON.stringify(out), world));
}

function sameState(world, label) {
  assert.deepEqual(snapshot(world, 'odin'), snapshot(world, 'ref'), label);
}

test('reparar: validación de argumentos y ayuda', { skip }, async () => {
  const world = newWorld('repara-args');
  await seed(world);
  for (const args of [
    ['doctor', 'repair'], ['doctor', 'repair', '--help'], ['doctor', 'repair', '--project', 'demo'], ['doctor', 'repair', '--check', 'orphaned_observation_session'],
    ['doctor', 'repair', '--project', 'demo', '--check', 'orphaned_observation_session'], ['doctor', 'repair', '--project', 'demo', '--check', 'orphaned_observation_session', '--plan', '--apply'],
    ['doctor', 'repair', '--project', 'demo', '--check', 'unowned_session_project', '--plan'], ['doctor', 'repair', '--project', 'demo', '--check', 'no_existe', '--plan'],
    ['doctor', 'repair', '--project', 'demo', '--check', 'sqlite_lock_contention', '--plan'], ['doctor', 'repair', '--bogus'], ['doctor', 'repair', '--project'], ['doctor', 'repair', '--check'],
    ['doctor', 'repair', '--project', 'demo', '--check', 'orphaned_observation_session', '--plan', '--replacement-id', 'x'],
    ['doctor', 'repair', '--project', 'demo', '--check', 'invalid_session_identity', '--source-id', 'x', '--plan'], ['doctor', 'repair', '--replacement-id'],
    ['doctor', 'repair', '--check', 'orphaned_pending_relations', '--plan'], ['doctor', 'repair', '--check', 'orphaned_pending_relations', '--dry-run'],
  ]) world.same(args);
});

test('reparar sesiones huérfanas: plan, simulacro, aplicación y repetición', { skip }, async () => {
  const world = newWorld('repara-huerfanas');
  await seed(world);
  both(world, [
    ['PRAGMA foreign_keys = OFF'],
    ["UPDATE observations SET session_id = 'perdida-a' WHERE id IN (1, 2)"],
    ["UPDATE observations SET session_id = 'perdida-b' WHERE id = 3"],
    ["UPDATE observations SET project = 'otro' WHERE id = 3"],
  ]);
  for (const mode of ['--plan', '--dry-run']) {
    world.same(['doctor', 'repair', '--project', 'demo', '--check', 'orphaned_observation_session', mode]);
    world.same(['doctor', 'repair', '--project', 'otro', '--check', 'orphaned_observation_session', mode]);
  }
  sameState(world, 'tras plan y simulacro nada cambia');
  world.same(['doctor', 'repair', '--project', 'demo', '--check', 'orphaned_observation_session', '--apply']);
  sameState(world, 'tras aplicar');
  const placeholders = snapshot(world, 'odin').sessions.filter((x) => x.id.startsWith('perdida'));
  assert.deepEqual(placeholders.map((x) => [x.id, x.project, x.ownership_mode, x.ended]), [['perdida-a', 'demo', 'project_owned', 1]], 'solo la sesión del proyecto pedido se repone');
  world.same(['doctor', 'repair', '--project', 'demo', '--check', 'orphaned_observation_session', '--apply']);
  world.same(['doctor', 'repair', '--project', 'otro', '--check', 'orphaned_observation_session', '--apply']);
  sameState(world, 'tras repetir');
  world.same(['doctor', '--check', 'orphaned_observation_session', '--json']);
});

test('reparar sesiones huérfanas referenciadas desde dos proyectos falla igual y no cambia nada', { skip }, async () => {
  const world = newWorld('repara-mixta');
  await seed(world);
  both(world, [
    ['PRAGMA foreign_keys = OFF'],
    ["INSERT INTO observations (sync_id, session_id, type, title, content, project, scope) VALUES ('obs-mix-1', 'perdida-c', 'manual', 't', 'c', 'demo', 'project'), ('obs-mix-2', 'perdida-c', 'manual', 't2', 'c2', 'otro', 'project')"],
  ]);
  world.same(['doctor', 'repair', '--project', 'demo', '--check', 'orphaned_observation_session', '--plan']);
  world.same(['doctor', 'repair', '--project', 'demo', '--check', 'orphaned_observation_session', '--apply']);
  sameState(world, 'el fallo no deja cambios');
});

test('reparar relaciones pendientes huérfanas', { skip }, async () => {
  const world = newWorld('repara-relaciones');
  await seed(world);
  world.same(['doctor', 'repair', '--check', 'orphaned_pending_relations', '--apply']);
  both(world, [
    ["INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status, marked_by_actor, marked_by_kind) VALUES ('rel-0000000000000001', 'x1', 'y1', 'related', 'pending', 's', 'system'), ('rel-0000000000000002', 'x2', 'y2', 'related', 'pending', 's', 'system'), ('rel-0000000000000003', 'x3', 'y3', 'related', 'judged', 's', 'system')"],
  ]);
  world.same(['doctor', 'repair', '--check', 'orphaned_pending_relations', '--plan']);
  world.same(['doctor', 'repair', '--project', 'cualquiera', '--check', 'orphaned_pending_relations', '--dry-run']);
  sameState(world, 'sin cambios en plan y simulacro');
  world.same(['doctor', 'repair', '--check', 'orphaned_pending_relations', '--apply']);
  sameState(world, 'tras aplicar');
  assert.deepEqual(snapshot(world, 'odin').relations.map((r) => r.judgment_status).filter((x) => x !== 'pending').sort(), ['judged', 'orphaned', 'orphaned']);
  world.same(['doctor', 'repair', '--check', 'orphaned_pending_relations', '--apply']);
  world.same(['doctor', '--check', 'orphaned_pending_relations']);
});

test('reparar el proyecto de una sesión por el directorio y por el nombre manual', { skip }, async () => {
  const world = newWorld('repara-proyecto');
  await seed(world);
  both(world, [
    ["INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES ('s-dir', 'viejo', '__DIR__', '2026-01-01 00:00:00', 'shared')"],
  ]);
  // El directorio de cada lado es el suyo: se escribe aparte para que el nombre del repositorio coincida.
  for (const [side, repo] of [['ref', world.refRepo], ['odin', world.odinRepo]]) {
    const db = new DatabaseSync(dbPath(world, side), { timeout: 5000 });
    db.prepare("UPDATE sessions SET directory = ? WHERE id = 's-dir'").run(repo);
    db.prepare("INSERT INTO observations (sync_id, session_id, type, title, content, project, scope) VALUES ('obs-dir', 's-dir', 'manual', 't', 'c', 'viejo', 'project')").run();
    db.prepare("INSERT INTO user_prompts (sync_id, session_id, content, project) VALUES ('prompt-dir', 's-dir', 'p', 'viejo')").run();
    db.close();
  }
  world.same(['doctor', '--check', 'session_project_directory_mismatch', '--project', 'viejo', '--json']);
  world.same(['doctor', 'repair', '--project', 'viejo', '--check', 'session_project_directory_mismatch', '--plan']);
  world.same(['doctor', 'repair', '--project', 'viejo', '--check', 'session_project_directory_mismatch', '--dry-run']);
  sameState(world, 'sin cambios en el simulacro');
  world.same(['doctor', 'repair', '--project', 'viejo', '--check', 'session_project_directory_mismatch', '--apply']);
  sameState(world, 'tras aplicar');
  const moved = snapshot(world, 'odin');
  assert.equal(moved.sessions.find((x) => x.id === 's-dir').project, 'repara-proyecto');
  assert.equal(moved.observations.find((x) => x.session_id === 's-dir').project, 'repara-proyecto');
  assert.equal(moved.prompts.find((x) => x.session_id === 's-dir').project, 'repara-proyecto');
  world.same(['doctor', 'repair', '--project', 'viejo', '--check', 'session_project_directory_mismatch', '--apply']);

  // Alias local que contradice el traslado.
  both(world, [["INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES ('s-dir2', 'viejo2', '/nada', '2026-01-02 00:00:00', 'shared')"]]);
  world.same(['doctor', 'repair', '--project', 'viejo2', '--check', 'session_project_directory_mismatch', '--plan']);

  // Nombre manual que apunta a un proyecto conocido.
  both(world, [
    ["INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES ('s-demo', 'demo', '/tmp/inexistente', '2026-01-03 00:00:00', 'shared')"],
    ["INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES ('manual-save-demo', 'otro', '/tmp/inexistente', '2026-01-03 00:00:00', 'shared')"],
    ["INSERT INTO observations (sync_id, session_id, type, title, content, project, scope) VALUES ('obs-man', 'manual-save-demo', 'manual', 't', 'c', 'otro', 'project')"],
    ["INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES ('manual-save-fantasma', 'otro', '/tmp/inexistente', '2026-01-03 00:00:00', 'shared')"],
  ]);
  world.same(['doctor', '--check', 'manual_session_name_project_mismatch', '--project', 'otro', '--json']);
  world.same(['doctor', 'repair', '--project', 'otro', '--check', 'manual_session_name_project_mismatch', '--plan']);
  world.same(['doctor', 'repair', '--project', 'otro', '--check', 'manual_session_name_project_mismatch', '--apply']);
  sameState(world, 'tras reparar el nombre manual');
  const manual = snapshot(world, 'odin').sessions.find((x) => x.id === 'manual-save-demo');
  assert.deepEqual([manual.project, manual.ownership_mode], ['demo', 'project_owned']);
  world.same(['doctor', 'repair', '--project', 'otro', '--check', 'manual_session_name_project_mismatch', '--apply']);
});

test('identidad de sesión inválida: el plan sin ID de reemplazo explica qué falta', { skip }, async () => {
  const world = newWorld('repara-identidad');
  await seed(world);
  both(world, [
    ['PRAGMA foreign_keys = OFF'],
    ["INSERT INTO sessions (id, project, directory, started_at, ownership_mode) VALUES (' ', 'demo', '/tmp/x', '2026-01-01 00:00:00', 'shared')"],
    ["INSERT INTO sync_apply_deferred (sync_id, entity, payload, target_key, project, scope_class, apply_status, reason_code, first_seen_at, entity_key, op, remote_seq) VALUES ('d1', 'session', '{}', 'local', 'demo', 'scoped', 'dead', 'sync_session_identity_invalid', '2026-01-01 00:00:00', ' ', 'upsert', 1)"],
  ]);
  world.same(['doctor', 'repair', '--project', 'demo', '--check', 'invalid_session_identity', '--plan']);
  world.same(['doctor', 'repair', '--project', 'demo', '--check', 'invalid_session_identity', '--apply']);
  sameState(world, 'sin cambios');
});
