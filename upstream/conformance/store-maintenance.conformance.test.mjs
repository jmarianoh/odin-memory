// Contraste diferencial del mantenimiento de proyectos (fusión, borrado, poda) mediante la CLI de referencia.
// Cada escenario siembra el mismo estado con SQL en ambas bases, ejecuta la operación y compara el estado final.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  Store, deleteProject, listProjectsWithStats, mergeExplicitProjectVariants, previewExplicitProjectMerge, pruneProject,
} from '../../src/store/index.js';
import { resolveBinary } from './engram-mcp.mjs';

const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';

let work;
let n = 0;
let engramDir;
let odin;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'conformance-maint-'));
});
after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  binary?.cleanup();
});

const run = (args, input = '') =>
  spawnSync(binary.bin, args, { env: { ...process.env, ENGRAM_DATA_DIR: engramDir, ENGRAM_NO_UPDATE_CHECK: '1' }, input, encoding: 'utf8' });

function seed(db) {
  const session = (id, project) => db.prepare('INSERT OR IGNORE INTO sessions (id, project, directory, started_at) VALUES (?, ?, ?, ?)').run(id, project, '/d', '2026-01-01 00:00:00');
  const obs = (key, sessionId, project, deleted = null) =>
    db.prepare("INSERT INTO observations (sync_id, session_id, type, title, content, project, deleted_at) VALUES (?, ?, 'manual', ?, 'c', ?, ?)").run(`obs-${key}`, sessionId, `t-${key}`, project, deleted);
  const prompt = (key, sessionId, project) =>
    db.prepare("INSERT INTO user_prompts (sync_id, session_id, content, project) VALUES (?, ?, 'p', ?)").run(`prompt-${key}`, sessionId, project);
  for (const [project, count] of [['my_app', 2], ['myapp', 1], ['my-app', 1], ['My-App', 1], ['to-delete', 2]]) {
    for (const k of [`${project}-1`, ...(project === 'to-delete' ? [`${project}-2`] : [])]) session(`s-${k}`, project);
    for (let i = 0; i < count; i++) obs(`${project}-${i}`, `s-${project}-1`, project);
    prompt(project, `s-${project}-1`, project);
  }
  session('s-empty-a', 'empty-a');
  prompt('empty-a', 's-empty-a', 'empty-a');
  session('s-empty-b', 'empty-b');
  obs('empty-b', 's-empty-b', 'empty-b', '2026-01-02 00:00:00'); // borrada: no cuenta como viva
  prompt('empty-b', 's-empty-b', 'empty-b');
  session('s-empty-c', 'empty-c'); // sesión sin prompts ni observaciones
  // Sesiones de to-delete que contienen registros de otro proyecto: el borrado duro no debe eliminarlas.
  session('s-mixed-p', 'to-delete');
  prompt('mixed-p', 's-mixed-p', 'ajeno');
  session('s-mixed-o', 'to-delete');
  obs('mixed-o', 's-mixed-o', 'ajeno');
  db.prepare("INSERT INTO memory_relations (sync_id, source_id, target_id) VALUES ('rel-1', 'obs-to-delete-0', 'obs-externa')").run();
  db.prepare("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', 'observation', 'obs-my_app-0', 'upsert', ?, 'my_app')").run(JSON.stringify({ project: 'my_app' }));
}

/** Estado observable, normalizado para compararlo entre ambas bases. */
function dump(db) {
  const all = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
  return {
    sessions: all('SELECT id, project FROM sessions ORDER BY id'),
    observations: all('SELECT sync_id, project, deleted_at IS NOT NULL AS deleted FROM observations ORDER BY sync_id'),
    prompts: all('SELECT sync_id, project FROM user_prompts ORDER BY sync_id'),
    relations: all('SELECT sync_id, judgment_status FROM memory_relations ORDER BY sync_id'),
    tombstones: all("SELECT entity, entity_key, project, hard_delete, active FROM sync_delete_tombstones WHERE entity = 'project' ORDER BY entity_key"),
    mutations: all("SELECT project, json_extract(payload, '$.project') AS payload_project FROM sync_mutations ORDER BY seq"),
  };
}

beforeEach(() => {
  if (!binary) return;
  n++;
  engramDir = join(work, `engram-${n}`);
  assert.equal(run(['stats']).status, 0);
  const reference = new DatabaseSync(join(engramDir, 'engram.db'), { timeout: 5000 });
  seed(reference);
  reference.close();
  odin?.close();
  odin = Store.open({ dataDir: join(work, `odin-${n}`), log: () => {} });
  seed(odin.db.raw);
});

const referenceState = () => {
  const db = new DatabaseSync(join(engramDir, 'engram.db'), { timeout: 5000 });
  try {
    return dump(db);
  } finally {
    db.close();
  }
};
const sameState = (label) => assert.deepEqual(dump(odin.db.raw), referenceState(), label);

for (const [from, to] of [['my_app', 'my-app'], ['myapp', 'my-app'], ['My-App', 'my-app']]) {
  test(`projects merge --from ${from} --to ${to} deja el mismo estado`, { skip }, () => {
    const ref = run(['projects', 'merge', '--from', from, '--to', to, '--apply']);
    assert.equal(ref.status, 0, ref.stderr);
    const res = mergeExplicitProjectVariants(odin, [from], to);
    assert.match(ref.stdout, new RegExp(`observations ${res.observations_updated}, sessions ${res.sessions_updated}, prompts ${res.prompts_updated}\\.`));
    sameState(`fusión ${from}`);
  });
}

test('la vista previa de fusión coincide con la referencia', { skip }, () => {
  const ref = run(['projects', 'merge', '--from', 'my_app', '--to', 'my-app', '--dry-run']);
  assert.equal(ref.status, 0, ref.stderr);
  const p = previewExplicitProjectMerge(odin, 'my_app', 'my-app');
  assert.match(ref.stdout, new RegExp(`observations ${p.observations_updated}, sessions ${p.sessions_updated}, prompts ${p.prompts_updated}\\. Sync identity changes: ${p.sync_identity_changes}\\.`));
  sameState('la vista previa no modifica nada');
});

test('las fusiones inválidas fallan con el mismo mensaje y sin cambios', { skip }, () => {
  for (const [from, to, fragment] of [
    ['inexistente_x', 'inexistente-x', 'does not exist'],
    ['otra', 'my-app', 'must be a distinct legacy case, separator or Unicode normalization variant'],
    ['my-app', 'my-app', 'must be a distinct legacy case'],
    ['my_app', 'inbox', 'reserved inbox project cannot be a merge destination'],
  ]) {
    const ref = run(['projects', 'merge', '--from', from, '--to', to, '--apply']);
    assert.notEqual(ref.status, 0);
    assert.ok(ref.stderr.includes(fragment), `${from}→${to}: ${ref.stderr}`);
    // La CLI valida primero con la vista previa; se replica ese flujo.
    assert.throws(() => previewExplicitProjectMerge(odin, from, to), (err) => err.message.includes(fragment), `${from}→${to}`);
  }
  sameState('sin cambios tras los errores');
});

for (const hard of [false, true]) {
  test(`delete project to-delete${hard ? ' --hard' : ''} deja el mismo estado`, { skip }, () => {
    const ref = run(['delete', 'project', 'to-delete', ...(hard ? ['--hard'] : [])]);
    assert.equal(ref.status, 0, ref.stderr);
    const res = deleteProject(odin, 'to-delete', hard);
    assert.match(ref.stdout, new RegExp(`${res.observations_deleted} observation\\(s\\), ${res.prompts_deleted} prompt\\(s\\), ${res.sessions_deleted} session\\(s\\)`));
    sameState(`borrado ${hard ? 'duro' : 'suave'}`);
  });
}

test('delete project de un proyecto inexistente falla igual', { skip }, () => {
  const ref = run(['delete', 'project', 'no-existe']);
  assert.notEqual(ref.status, 0);
  assert.ok(ref.stderr.includes('project not found'));
  assert.throws(() => deleteProject(odin, 'no-existe'), (err) => err.code === 'project_not_found');
  sameState('sin cambios');
});

test('projects prune elimina lo mismo que la poda del store', { skip }, () => {
  const ref = run(['projects', 'prune'], 'all\n');
  assert.equal(ref.status, 0, ref.stderr);
  const candidates = listProjectsWithStats(odin).filter((p) => p.observation_count === 0).map((p) => p.name).sort();
  assert.deepEqual(candidates, ['empty-a', 'empty-b', 'empty-c']); // sin observaciones vivas, aunque tengan sesión o prompts
  const totals = candidates.reduce((acc, name) => {
    const r = pruneProject(odin, name);
    return { sessions: acc.sessions + r.sessions_deleted, prompts: acc.prompts + r.prompts_deleted };
  }, { sessions: 0, prompts: 0 });
  assert.match(ref.stdout, new RegExp(`Pruned ${candidates.length} project\\(s\\): ${totals.sessions} sessions, ${totals.prompts} prompts removed\\.`));
  sameState('poda');
});
