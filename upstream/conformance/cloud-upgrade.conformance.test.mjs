// Contraste diferencial de `cloud upgrade`: el mismo almacén produce el mismo diagnóstico, la misma reparación y el mismo
// estado por etapas en la referencia y en odin.
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
  base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-upgrade-')));
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
  out = out.replace(/\/[^\s"']*?conformance-upgrade-[A-Za-z0-9]+\/[a-z]+-\d+\/(ref|odin)\/[^/\s"']*/g, '<DIR>');
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

const payloads = (world, side) => {
  const db = new DatabaseSync(dbPath(world, side), { readOnly: true });
  try {
    return db.prepare('SELECT seq, entity, entity_key, op, project, disposition, payload FROM sync_mutations ORDER BY seq').all().map((r) => {
      let payload = r.payload;
      try {
        payload = JSON.parse(r.payload);
        for (const key of ['revision_count', 'duplicate_count']) if (payload[key] === 0) delete payload[key];
      } catch {
        // las cargas ilegibles se comparan tal cual
      }
      return { ...r, payload };
    });
  } finally {
    db.close();
  }
};
const upgradeState = (world, side) => {
  const db = new DatabaseSync(dbPath(world, side), { readOnly: true });
  try {
    return db.prepare('SELECT project, stage, repair_class, snapshot_json, last_error_code, last_error_message FROM cloud_upgrade_state ORDER BY project').all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const sameState = (world, label) => assert.deepEqual(maskValue(upgradeState(world, 'odin'), world), maskValue(upgradeState(world, 'ref'), world), `${label}: cloud_upgrade_state`);

test('cloud upgrade: ayuda, errores de uso y estado inicial', { skip }, async () => {
  const world = newWorld('uso');
  await seed(world);
  world.same(['cloud', 'upgrade']);
  for (const help of ['--help', '-h', 'help']) world.same(['cloud', 'upgrade', help]);
  world.same(['cloud', 'upgrade', 'nada']);
  world.same(['cloud', 'upgrade', 'DOCTOR']);
  for (const command of ['doctor', 'repair', 'bootstrap', 'remirror', 'status', 'rollback']) world.same(['cloud', 'upgrade', command]);
  world.same(['cloud', 'upgrade', 'status', '--project']);
  world.same(['cloud', 'upgrade', 'status', '--project', 'demo']);
  world.same(['cloud', 'upgrade', 'status', '--project', 'Demo']);
  world.same(['cloud', 'upgrade', 'rollback', '--project', 'demo']);
  world.same(['cloud', 'upgrade', 'bootstrap', '--project', 'demo']);
  world.same(['cloud', 'upgrade', 'remirror', '--project', 'demo']);
  world.same(['cloud', 'help']);
});

test('cloud upgrade doctor: configuración, inscripción y política', { skip }, async () => {
  const world = newWorld('doctor');
  await seed(world);
  const env = { ENGRAM_CLOUD_SERVER: 'https://nube.example' };
  world.same(['cloud', 'upgrade', 'doctor', '--project', 'demo']);
  sameState(world, 'sin configurar');
  world.same(['cloud', 'upgrade', 'doctor', '--project', 'demo'], { env });
  sameState(world, 'sin inscribir');
  world.same(['cloud', 'upgrade', 'status', '--project', 'demo']);
  world.same(['cloud', 'enroll', 'demo']);
  world.same(['cloud', 'upgrade', 'doctor', '--project', 'demo'], { env });
  sameState(world, 'inscrito');
  world.same(['cloud', 'upgrade', 'status', '--project', 'demo']);
  both(world, [["INSERT OR REPLACE INTO sync_state (target_key, lifecycle, reason_code, reason_message) VALUES ('cloud:demo', 'degraded', 'policy_forbidden', 'prohibido')"]]);
  world.same(['cloud', 'upgrade', 'doctor', '--project', 'demo'], { env });
  sameState(world, 'política');
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo']);
  both(world, [["UPDATE sync_state SET reason_code = 'auth_required', reason_message = '' WHERE target_key = 'cloud:demo'"]]);
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo', '--apply']);
  both(world, [["UPDATE sync_state SET reason_code = 'cloud_config_error', reason_message = 'mala URL' WHERE target_key = 'cloud:demo'"]]);
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo']);
});

test('cloud upgrade repair: mutaciones heredadas reparables y bloqueadas', { skip }, async () => {
  const world = newWorld('reparar');
  await seed(world);
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo']);
  world.same(['cloud', 'enroll', 'demo']);
  both(world, [
    ["DELETE FROM sync_mutations"],
    // Sesión sin proyecto en el diario: se atribuye por su sesión local.
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'session', 'sesion-1', 'upsert', '{\"id\":\"sesion-1\"}', '')"],
    // Observación con campos vacíos que la tabla local completa.
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) SELECT 'cloud', 'observation', sync_id, 'upsert', '{\"sync_id\":\"' || sync_id || '\"}', 'demo' FROM observations WHERE id = 1"],
    // Prompt sin contenido ni sesión.
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) SELECT 'cloud', 'prompt', sync_id, 'upsert', '{\"sync_id\":\"' || sync_id || '\"}', 'demo' FROM user_prompts WHERE id = 1"],
  ]);
  world.same(['cloud', 'upgrade', 'doctor', '--project', 'demo'], { env: { ENGRAM_CLOUD_SERVER: 'https://nube.example' } });
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo']);
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo', '--dry-run']);
  assert.deepEqual(maskValue(payloads(world, 'odin'), world), maskValue(payloads(world, 'ref'), world), 'el simulacro no escribe');
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo', '--apply']);
  const [ref, odin] = [maskValue(payloads(world, 'ref'), world), maskValue(payloads(world, 'odin'), world)];
  assert.equal(odin.length, ref.length);
  for (const [i, row] of ref.entries()) {
    assert.deepEqual({ ...odin[i], payload: undefined }, { ...row, payload: undefined }, `fila ${i}`);
    assert.deepEqual(odin[i].payload, row.payload, `carga ${i}`);
  }
  sameState(world, 'reparado');
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo', '--apply']);
  world.same(['cloud', 'upgrade', 'status', '--project', 'demo']);

  // Bloqueadas: carga vacía, entidad desconocida, clave distinta y campos que el almacén no puede completar.
  both(world, [
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'observation', 'obs-z', 'upsert', '{\"sync_id\":\"obs-z\"}', 'demo')"],
    ["INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'prompt', 'p-y', 'upsert', '', 'demo')"],
  ]);
  world.same(['cloud', 'upgrade', 'doctor', '--project', 'demo'], { env: { ENGRAM_CLOUD_SERVER: 'https://nube.example' } });
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo']);
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo', '--apply']);
  for (const [entity, key, op, payload, project] of [
    ['widget', 'w', 'upsert', '{}', 'demo'], ['observation', 'obs-k', 'upsert', '{"sync_id":"otra"}', 'demo'], ['session', 'sesion-1', 'upsert', '[1]', 'demo'], ['relation', 'rel-1', 'upsert', '{"sync_id":"rel-1"}', 'demo'],
    ['observation', 'obs-p', 'upsert', '{"sync_id":"obs-p"}', ' demo '], ['session', 's-x', 'upsert', '{"id":"s-x"}', ''],
  ]) {
    both(world, [["DELETE FROM sync_mutations WHERE entity_key NOT IN ('sesion-1')"], ['INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES (?, ?, ?, ?, ?, ?)', 'cloud', entity, key, op, payload, project]]);
    world.same(['cloud', 'upgrade', 'doctor', '--project', 'demo'], { env: { ENGRAM_CLOUD_SERVER: 'https://nube.example' } });
    world.same(['cloud', 'upgrade', 'repair', '--project', 'demo']);
  }
});

test('cloud upgrade repair: hueco del diario y proyecto sin inscribir', { skip }, async () => {
  const world = newWorld('hueco');
  await seed(world);
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo']);
  world.same(['cloud', 'enroll', 'demo']);
  both(world, [['DELETE FROM sync_mutations']]);
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo']);
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo', '--apply']);
  assert.deepEqual(maskValue(payloads(world, 'odin').map((r) => [r.entity, r.entity_key, r.op, r.project]).sort(), world), maskValue(payloads(world, 'ref').map((r) => [r.entity, r.entity_key, r.op, r.project]).sort(), world));
  world.same(['cloud', 'upgrade', 'repair', '--project', 'demo']);
  sameState(world, 'tras el relleno');
});

test('cloud upgrade rollback: restaura la inscripción y no admite lo verificado', { skip }, async () => {
  const world = newWorld('rollback');
  await seed(world);
  world.same(['cloud', 'upgrade', 'rollback', '--project', 'demo']);
  // Una instantánea capturada con el proyecto sin inscribir; luego se inscribe y se vuelve atrás.
  both(world, [
    ["INSERT INTO cloud_upgrade_state (project, stage, repair_class, snapshot_json) VALUES ('demo', 'bootstrap_enrolled', 'repairable', '{\"captured\":true,\"project_enrolled\":false}')"],
    ["INSERT INTO sync_enrolled_projects (project) VALUES ('demo')"],
  ]);
  world.same(['cloud', 'upgrade', 'rollback', '--project', 'demo']);
  sameState(world, 'revertido');
  world.same(['cloud', 'upgrade', 'status', '--project', 'demo']);
  both(world, [["UPDATE cloud_upgrade_state SET stage = 'bootstrap_verified' WHERE project = 'demo'"]]);
  world.same(['cloud', 'upgrade', 'rollback', '--project', 'demo']);
  both(world, [["UPDATE cloud_upgrade_state SET stage = 'doctor_ready', snapshot_json = '{\"captured\":false,\"project_enrolled\":false}' WHERE project = 'demo'"]]);
  world.same(['cloud', 'upgrade', 'rollback', '--project', 'demo']);
  world.same(['cloud', 'upgrade', 'status', '--project', 'demo']);
});
