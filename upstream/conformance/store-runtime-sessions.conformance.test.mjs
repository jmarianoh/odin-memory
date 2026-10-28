// Contraste diferencial de las sesiones de runtime a través de la API HTTP de la referencia.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runtimeWorktreeDirectory } from '../../src/project/worktree.js';
import {
  Store, endRuntimeSession, endSession, finalizeSession, registerIsolatedSession, resolveRuntimeSession, resumeSession,
  startSession,
} from '../../src/store/index.js';
import { resolveBinary } from './engram-mcp.mjs';

const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';
const TOKEN = 'conformance-token';

let work;
let server;
let port;
let engramDir;
let odin;
let dirA;
let dirB;
let repo;
let repoSub;

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address();
      probe.close(() => resolve(p));
    });
    probe.on('error', reject);
  });

before(async () => {
  if (!binary) return;
  work = mkdtempSync(join(tmpdir(), 'conformance-runtime-'));
  const base = realpathSync(work);
  dirA = join(base, 'a');
  dirB = join(base, 'b');
  repo = join(base, 'repo');
  repoSub = join(repo, 'src', 'modulo');
  for (const d of [dirA, dirB, repoSub]) mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);

  engramDir = join(base, 'engram-data');
  port = await freePort();
  server = spawn(binary.bin, ['serve', String(port)], {
    env: { ...process.env, ENGRAM_DATA_DIR: engramDir, ENGRAM_HTTP_TOKEN: TOKEN, ENGRAM_NO_UPDATE_CHECK: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  odin = Store.open({ dataDir: join(base, 'odin-data'), log: () => {} });
  seedLegacy(odin.db.raw);
  const reference = new DatabaseSync(join(engramDir, 'engram.db'), { timeout: 5000 });
  seedLegacy(reference);
  reference.close();
});
after(() => {
  server?.kill();
  odin?.close();
  if (work) rmSync(work, { recursive: true, force: true });
  binary?.cleanup();
});

const http = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/** Traduce un error del store al estado HTTP que le asigna la referencia. */
const statusOf = (err) => {
  switch (err.code) {
    case 'session_isolation_conflict': case 'session_already_ended': case 'session_ownership_mismatch': case 'runtime_session_scope_conflict': return 409;
    case 'invalid_session_ownership_mode': return 400;
    case 'session_not_found': return 404;
    default: return 500;
  }
};

const attempt = (fn, map = statusOf) => {
  try {
    return { status: 201, value: fn() };
  } catch (err) {
    return { status: map(err), error: err };
  }
};

// El manejador de finalización asigna otros estados (403 a un conflicto de propiedad).
const finalizeStatusOf = (err) => (err.code === 'session_ownership_mismatch' ? 403 : statusOf(err));

const ops = {
  register: async (a) => {
    const body = { id: a.id, project: a.project, directory: a.directory ?? '', ownership_mode: a.mode, resume: a.resume ?? false, isolated: a.isolated ?? false };
    const ref = await http('POST', '/sessions', body);
    const mode = a.mode || 'shared';
    const mine = attempt(() => {
      const directory = runtimeWorktreeDirectory(a.directory ?? '');
      if (a.isolated) return registerIsolatedSession(odin, a.id, a.project, a.resume ?? false);
      return a.resume ? resumeSession(odin, a.id, a.project, directory, mode) : (startSession(odin, a.id, a.project, directory, mode), a.id);
    });
    return { ref, mine, id: mine.value };
  },
  end: async (a) => {
    const ref = await http('POST', `/sessions/${a.id}/end`, { summary: a.summary ?? '' });
    const mine = attempt(() => endSession(odin, a.id, a.summary ?? ''));
    return { ref, mine: { ...mine, status: mine.status === 201 ? 200 : mine.status } };
  },
  resolve: async (a) => {
    const ref = await http('POST', '/runtime-sessions/resolve', { id: a.id, project: a.project, directory: a.directory, ownership_mode: a.mode });
    const mine = attempt(() => resolveRuntimeSession(odin, a.id, a.project, runtimeWorktreeDirectory(a.directory), a.mode || 'shared'));
    return { ref, mine: { ...mine, status: mine.status === 201 ? 200 : mine.status }, id: mine.value };
  },
  runtimeEnd: async (a) => {
    const ref = await http('POST', '/runtime-sessions/end', { id: a.id, project: a.project, directory: a.directory, ownership_mode: a.mode, summary: a.summary ?? '' });
    const mine = attempt(() => endRuntimeSession(odin, a.id, a.project, runtimeWorktreeDirectory(a.directory), a.mode || 'shared', a.summary ?? ''));
    return { ref, mine: { ...mine, status: mine.status === 201 ? 200 : mine.status }, id: mine.value };
  },
  finalize: async (a) => {
    const ref = await http('POST', `/sessions/${a.id}/finalize`, { project: a.project, summary: a.summary });
    const mine = attempt(() => finalizeSession(odin, { session_id: a.id, project: a.project, summary: a.summary }), finalizeStatusOf);
    return { ref, mine: { ...mine, status: mine.status === 201 ? 200 : mine.status } };
  },
};

/** Filas que la API no puede producir (heredadas): se siembran con SQL en ambas bases. */
function seedLegacy(db) {
  const insert = db.prepare('INSERT INTO sessions (id, project, directory, ownership_mode, ended_at, summary) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('compartida-vacia', 'proy', '', 'shared', null, null); // compartida y sin directorio
  insert.run('vieja', '', dirA, null, '2026-01-01 00:00:00', null); // terminada y sin dueño
  insert.run('legacy-wt', 'proy', repoSub, 'shared', null, null); // directorio sin normalizar a la raíz del worktree
  insert.run('resumida', 'proy', dirA, 'shared', null, 'resumen previo'); // con resumen previo y viva
  insert.run('multi', 'proy', dirA, 'shared', '2026-01-01 00:00:00', null); // raíz terminada con dos continuaciones vivas
  insert.run('multi:resume:5', 'proy', dirA, 'shared', null, null);
  insert.run('multi:resume:3', 'proy', dirA, 'shared', null, null);
}

const dump = (db) => {
  const all = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
  return {
    sessions: all("SELECT id, project, ownership_mode, directory, ended_at IS NOT NULL AS ended, summary, runtime_lease_expires_at IS NOT NULL AS leased FROM sessions ORDER BY id"),
    observations: all("SELECT session_id, type, title, content, project FROM observations ORDER BY id"),
    finalizations: all('SELECT session_id, summary_id FROM session_finalizations ORDER BY session_id'),
  };
};

test('registro, reanudación, aislamiento, resolución y cierre coinciden con la referencia', { skip }, async () => {
  const steps = () => [
    ['register', { id: 'h1', project: 'proy', directory: dirA }],
    ['register', { id: 'h1', project: 'proy', directory: dirA }],
    ['register', { id: 'h1', project: 'otro-proyecto', directory: dirA }], // compartida: admite otro proyecto
    ['register', { id: 'dueña', project: 'proy-x', directory: dirA, mode: 'project_owned' }],
    ['register', { id: 'dueña', project: 'proy-y', directory: dirA, mode: 'project_owned' }], // conflicto
    ['register', { id: 'dueña', project: 'proy-x', directory: dirB, mode: 'project_owned' }],
    ['register', { id: 'mala', project: 'proy', directory: dirA, mode: 'raro' }],
    ['resolve', { id: 'h1', project: 'proy', directory: dirA }],
    ['resolve', { id: 'h1', project: 'proy', directory: dirB }], // otro árbol: conflicto
    ['resolve', { id: 'h1', project: 'proy', directory: dirA, mode: 'project_owned' }],
    ['resolve', { id: 'no-existe', project: 'proy', directory: dirA }], // 404
    ['end', { id: 'h1', summary: 'fin de h1' }],
    ['register', { id: 'h1', project: 'proy', directory: dirA }], // terminada: 409
    ['register', { id: 'h1', project: 'proy', directory: dirA, resume: true }], // continuación :resume:2
    ['register', { id: 'h1', project: 'proy', directory: dirA, resume: true }],
    ['resolve', { id: 'h1', project: 'proy', directory: dirA }],
    ['runtimeEnd', { id: 'h1', project: 'proy', directory: dirA, summary: 'fin de la continuación' }],
    ['register', { id: 'h1', project: 'proy', directory: dirA, resume: true }], // :resume:3
    ['runtimeEnd', { id: 'h1', project: 'proy', directory: dirA }],
    ['resolve', { id: 'h1', project: 'proy', directory: dirA }], // sin continuación viva
    ['register', { id: 'wt', project: 'proy', directory: repoSub }], // se normaliza a la raíz del repositorio
    ['resolve', { id: 'wt', project: 'proy', directory: repo }],
    ['register', { id: 'aislada', project: 'proy-z', directory: '', mode: 'project_owned', isolated: true }],
    ['register', { id: 'aislada', project: 'proy-z', directory: '', mode: 'project_owned', isolated: true }],
    ['register', { id: 'h2', project: 'proy', directory: dirB }],
    ['register', { id: 'h2', project: 'proy', directory: '', mode: 'project_owned', isolated: true }], // h2 tiene directorio: conflicto
    ['end', { id: 'aislada', summary: '' }],
    ['register', { id: 'aislada', project: 'proy-z', directory: '', mode: 'project_owned', isolated: true, resume: true }],
    // Aislamiento: cada regla por separado.
    ['register', { id: 'dueña', project: 'proy-x', directory: '', mode: 'project_owned', isolated: true }], // tiene directorio y es project_owned
    ['register', { id: 'compartida-vacia', project: 'proy', directory: '', mode: 'project_owned', isolated: true }], // sin directorio pero compartida
    // Una continuación hereda el alcance de la raíz aunque se pida otro directorio.
    ['register', { id: 'r1', project: 'proy', directory: dirA }],
    ['end', { id: 'r1', summary: '' }],
    ['register', { id: 'r1', project: 'proy', directory: dirB, resume: true }],
    ['resolve', { id: 'r1', project: 'proy', directory: dirA }],
    ['resolve', { id: 'r1', project: 'proy', directory: dirB }],
    // El alcance se compara por árbol de trabajo, no por texto.
    ['resolve', { id: 'legacy-wt', project: 'proy', directory: repo }],
    ['resolve', { id: 'legacy-wt', project: 'proy', directory: dirA }],
    // Reclamar una sesión terminada sin dueño asigna la propiedad pero informa que ya terminó.
    ['register', { id: 'vieja', project: 'reclamante', directory: dirA, mode: 'project_owned' }],
    ['register', { id: 'vieja', project: 'reclamante', directory: dirA, mode: 'project_owned' }],
    // Continuaciones: gana la viva de menor ordinal; y una raíz terminada project_owned rechaza a otro proyecto.
    ['register', { id: 'multi', project: 'proy', directory: dirA, resume: true }],
    ['register', { id: 'po', project: 'proy-x', directory: dirA, mode: 'project_owned' }],
    ['end', { id: 'po', summary: '' }],
    ['register', { id: 'po', project: 'proy-y', directory: dirA, mode: 'project_owned', resume: true }],
    ['register', { id: 'po', project: 'proy-x', directory: dirA, mode: 'project_owned', resume: true }],
    // La finalización conserva el resumen previo de la sesión.
    ['finalize', { id: 'resumida', project: 'proy', summary: 'resumen nuevo' }],
    ['register', { id: 'fin', project: 'proy', directory: dirA }],
    ['finalize', { id: 'fin', project: 'proy', summary: 'Resumen <private>x</private> final' }],
    ['finalize', { id: 'fin', project: 'proy', summary: 'otro' }],
    ['finalize', { id: 'fin', project: 'ajeno', summary: 'otro' }],
    ['finalize', { id: 'no-existe', project: 'proy', summary: 'otro' }],
    ['end', { id: 'h2', summary: 'a mano' }],
    ['finalize', { id: 'h2', project: 'proy', summary: 'tarde' }],
  ];
  let i = 0;
  for (const [op, args] of steps()) {
    i++;
    const { ref, mine, id } = await ops[op](args);
    const label = `paso ${i}: ${op} ${JSON.stringify(args).replaceAll(work, '…')}`;
    assert.equal(mine.status, ref.status, `${label}\n${ref.body.error ?? ''} | ${mine.error?.message ?? ''}`);
    if (ref.status < 300 && id !== undefined && ref.body.id) assert.equal(id, ref.body.id, label);
    if (op === 'finalize' && ref.status === 200) {
      assert.equal(mine.value.already_finalized, ref.body.already_finalized, label);
    }
  }
  // Estado final idéntico (el id de continuación y los resúmenes incluidos).
  const reference = new DatabaseSync(join(engramDir, 'engram.db'), { timeout: 5000 });
  try {
    assert.deepEqual(dump(odin.db.raw), dump(reference));
  } finally {
    reference.close();
  }
});
