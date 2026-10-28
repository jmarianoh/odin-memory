// Contraste diferencial de la CLI: los mismos comandos sobre la referencia y sobre odin
// producen la misma salida (con la identidad renombrada), el mismo código de salida y el
// mismo estado en el almacén.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-cli-')));
});
after(() => {
  for (const close of closers) close();
  if (base) rmSync(base, { recursive: true, force: true });
  binary?.cleanup();
});

const MASKS = [
  [/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<T>'],
  [/(obs|rel|prompt|ses)-[0-9a-f]{16}/g, '$1-X'],
  [/\b[0-9a-f]{32}\b/g, '<ID>'],
  [/engram-export\.json/g, 'odin-export.json'],
  [/'claude' or 'opencode'/g, "'copilot'"],
  [/\.engram/g, '.odin-memory'],
  [/ENGRAM_/g, 'ODIN_'],
  [/engram\.db/g, 'odin.db'],
  [/Engram/g, 'Odin'],
  [/engram/g, 'odin'],
];

/** Enmascara lo que difiere por construcción: identidad, rutas, fechas e identificadores. */
/** La referencia ordena los proyectos con el mismo número de observaciones en un orden arbitrario (recorre un mapa). */
function sortProjectListing(text) {
  const match = /^(Projects \(\d+\):\n)((?:  .*\n)+)$/.exec(text);
  if (!match) return text;
  const lines = match[2].split('\n').filter(Boolean);
  const count = (line) => Number(/(\d+) obs/.exec(line)?.[1] ?? 0);
  lines.sort((a, b) => count(b) - count(a) || (a < b ? -1 : a > b ? 1 : 0));
  return `${match[1]}${lines.join('\n')}\n`;
}

function mask(text, world) {
  let out = sortProjectListing(String(text ?? ''));
  for (const dir of [world.refDir, world.odinDir]) out = out.split(dir).join('<DATA>');
  for (const dir of [join(world.dir, 'out-ref'), join(world.dir, 'out-odin')]) out = out.split(dir).join('<OUT>');
  out = out.split(world.repo).join('<REPO>');
  for (const [pattern, replacement] of MASKS) out = out.replace(pattern, replacement);
  return out;
}

/** Un par de directorios de datos y un repositorio compartido. */
function newWorld(name) {
  counter += 1;
  const dir = join(base, `${name}-${counter}`);
  mkdirSync(dir);
  const repo = join(dir, name);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const world = { dir, repo, refDir: join(dir, 'ref-data'), odinDir: join(dir, 'odin-data'), name };
  /** `args` es la misma lista para ambos o `{ ref, odin }` si difieren (p. ej. el archivo de salida). */
  world.run = (args, { input, cwd = repo, env = {} } = {}) => {
    const refArgs = Array.isArray(args) ? args : args.ref;
    const odinArgs = Array.isArray(args) ? args : args.odin;
    const ref = spawnSync(binary.bin, refArgs, {
      cwd, input, encoding: 'utf8', env: { ...process.env, ENGRAM_DATA_DIR: world.refDir, ENGRAM_NO_UPDATE_CHECK: '1', HOME: dir, ...env },
    });
    const odinEnv = Object.fromEntries(Object.entries(env).map(([k, v]) => [k.replace(/^ENGRAM_/, 'ODIN_'), v]));
    const odin = spawnSync(process.execPath, ['--no-warnings', ODIN_BIN, ...odinArgs], {
      cwd, input, encoding: 'utf8', env: { ...process.env, ODIN_DATA_DIR: world.odinDir, HOME: dir, ...odinEnv },
    });
    return { ref, odin };
  };
  /** Ejecuta en ambos y exige la misma salida, error y código. */
  world.same = (args, options = {}) => {
    const { ref, odin } = world.run(args, options);
    const label = `odin ${(Array.isArray(args) ? args : args.odin).join(' ')}`;
    assert.equal(odin.status, ref.status, `${label}: código\n--- ref stderr\n${ref.stderr}\n--- odin stderr\n${odin.stderr}`);
    assert.equal(mask(odin.stdout, world), mask(ref.stdout, world), `${label}: stdout`);
    assert.equal(mask(odin.stderr, world), mask(ref.stderr, world), `${label}: stderr`);
    return { ref, odin };
  };
  return world;
}

/** Siembra el mismo contenido en ambos almacenes por MCP y la CLI. */
async function seed(world) {
  const ref = startMcpCommand(binary.bin, ['mcp', '--tools=all'], { cwd: world.repo, dataDir: world.refDir, env: { ENGRAM_DATA_DIR: world.refDir, ENGRAM_NO_UPDATE_CHECK: '1' } });
  const odin = startMcpCommand(process.execPath, ['--no-warnings', ODIN_BIN, 'mcp', '--tools=all'], { cwd: world.repo, dataDir: world.odinDir, env: { ODIN_DATA_DIR: world.odinDir } });
  closers.push(() => ref.close(), () => odin.close());
  await Promise.all([ref.initialize(), odin.initialize()]);
  const both = async (tool, args) => {
    const [a, b] = await Promise.all([ref.call(tool, args), odin.call(tool, args)]);
    assert.equal(b.isError, a.isError, `${tool}: ${a.text} / ${b.text}`);
    assert.equal(a.isError, false, `${tool}: ${a.text}`);
  };
  await both('mem_session_start', { id: 'sesion-1' });
  await both('mem_session_start', { id: 'sesion-2' });
  const saves = [
    { title: 'Decisión de caché', content: 'usamos Redis como caché distribuida', type: 'decision', session_id: 'sesion-1' },
    { title: 'Tema versionado', content: 'primera versión del tema', type: 'manual', topic_key: 'notas/versionado', session_id: 'sesion-1' },
    { title: 'Preferencia de formato', content: 'tabulaciones de dos espacios para todo', type: 'preference', scope: 'personal', session_id: 'sesion-1' },
    { title: 'Bug del login', content: 'el login falla con tokens expirados', type: 'bugfix', session_id: 'sesion-1' },
    { title: 'Nota suelta', content: 'otra nota de la segunda sesión sobre Redis', type: 'manual', session_id: 'sesion-2' },
    { title: 'Para borrar', content: 'se borrará luego', type: 'manual', session_id: 'sesion-2' },
  ];
  for (const s of saves) await both('mem_save', s);
  await both('mem_save_prompt', { content: 'primer prompt', session_id: 'sesion-1' });
  await both('mem_save_prompt', { content: 'segundo prompt', session_id: 'sesion-2' });
  await both('mem_session_end', { id: 'sesion-1', summary: 'resumen de la primera sesión' });
  ref.close();
  odin.close();
  // Fechas deterministas en ambas bases.
  for (const path of [join(world.refDir, 'engram.db'), join(world.odinDir, 'odin.db')]) {
    const db = new DatabaseSync(path, { timeout: 5000 });
    db.exec(`UPDATE observations SET created_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes'), updated_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes'), last_seen_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes')`);
    db.exec("UPDATE user_prompts SET created_at = datetime('2026-03-03 10:00:00', '+' || id || ' minutes')");
    db.exec("UPDATE sessions SET started_at = '2026-03-01 09:00:00', ended_at = CASE WHEN ended_at IS NULL THEN NULL ELSE '2026-03-01 11:00:00' END");
    db.close();
  }
}

test('versión, ayuda y comandos desconocidos', { skip }, () => {
  const w = newWorld('basico');
  const { ref, odin } = w.run(['version']);
  assert.equal(ref.status, 0);
  assert.equal(odin.status, 0);
  assert.match(ref.stdout, /^engram \S+\n$/);
  assert.match(odin.stdout, /^odin \d+\.\d+\.\d+\n$/);
  for (const args of [[], ['help'], ['--help'], ['-h'], ['nada']]) {
    const r = w.run(args);
    assert.equal(r.odin.status, r.ref.status, args.join(' '));
    assert.match(r.odin.stdout, /Usage:\n {2}odin <command> \[arguments\]/, args.join(' '));
  }
  const unknown = w.run(['nada']);
  assert.equal(unknown.odin.stderr, unknown.ref.stderr);
  assert.match(unknown.odin.stderr, /^unknown command: nada\n\n/);
});

test('save: guardado, opciones, validaciones y avisos', { skip }, () => {
  const w = newWorld('guardar');
  w.same(['save', 'Primer título', 'Primer contenido']);
  w.same(['save', 'Decisión', 'usar Postgres', '--type', 'decision', '--topic', 'arq/db']);
  w.same(['save', '--scope', 'personal', 'Preferencia', 'modo oscuro']);
  w.same(['save', 'Con guiones', '--', '--contenido-que-empieza-con-guiones']);
  w.same(['save', 'Con proyecto', 'contenido', '--project', 'Otro--Proyecto']);
  w.same(['save', 'Con proyecto', 'contenido', '--project', 'Otro--Proyecto']);
  w.same(['save', 'Solo uno']);
  w.same(['save']);
  w.same(['save', 'a', 'b', 'c']);
  w.same(['save', 'a', 'b', '--bogus', 'x']);
  w.same(['save', 'a', 'b', '--type']);
  w.same(['save', 'a', 'b', '--type', '--project']);
  w.same(['save', '   ', 'contenido']);
  w.same(['save', 'Título', '   ']);
  w.same(['save', 'Ruta', 'x', '--project', 'a/b']);
  w.same(['save', 'Enorme', 'x'.repeat(50_010)]);
  w.same(['save', 'Privado', 'abre <private>secreto</private> cierra']);
  w.same(['save', 'Env', 'por variable'], { env: { ENGRAM_PROJECT: 'desde-env' } });
  const store = (path) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare('SELECT type, title, content, project, scope, topic_key, revision_count FROM observations ORDER BY id').all().map((r) => ({ ...r, content: r.content.slice(0, 60) }));
    } finally {
      db.close();
    }
  };
  assert.deepEqual(store(join(w.odinDir, 'odin.db')), store(join(w.refDir, 'engram.db')));
});

test('search, timeline, context y stats sobre un almacén sembrado', { skip }, async () => {
  const w = newWorld('lectura');
  await seed(w);
  for (const args of [
    ['search', 'Redis'], ['search', 'Redis', '--limit', '1'], ['search', 'caché', '--type', 'decision'], ['search', 'Redis', '--scope', 'personal'],
    ['search', 'login', 'tokens'], ['search', 'login', 'inexistente', '--match', 'any'], ['search', 'login', 'inexistente'],
    ['search', 'zzzzzz'], ['search', 'ab'], ['search', 'notas/versionado'], ['search', 'Redis', '--all'], ['search', 'Redis', '--project', 'lectura'],
    ['search', 'Redis', '--project', 'no-existe'], ['search', 'Redis', '--all', '--project', 'lectura'], ['search', 'Redis', '--match', 'raro'],
    ['search'], ['search', '--type', 'decision'], ['search', 'Redis', '--limit', 'x'], ['search', 'Redis', '--type'],
    ['timeline', '3'], ['timeline', '3', '--before', '1', '--after', '1'], ['timeline', '3', '--all'], ['timeline', '3', '--project', 'lectura'],
    ['timeline', '3', '--project', 'no-existe'], ['timeline', '999'], ['timeline', '999', '--all'], ['timeline', 'x'], ['timeline'],
    ['timeline', '3', '--project'], ['timeline', '3', '--project', '--all'], ['timeline', '5'], ['timeline', '1', '--before', '0'],
    ['context'], ['context', '--all'], ['context', 'lectura'], ['context', '--project', 'lectura'], ['context', '--scope', 'personal'],
    ['context', '--older-history'], ['context', '--project', 'no-existe'], ['context', '--bogus'], ['context', 'a', 'b'], ['context', '--project'],
    ['context', '--project', 'a', '--project', 'b'], ['context', '--all', '--all'], ['context', '--all', 'lectura'], ['context', 'lectura', '--project', 'lectura'],
    ['stats'], ['stats', '--all'], ['stats', '--project', 'lectura'], ['stats', '--project', 'no-existe'], ['stats', '--project'], ['stats', '--all', '--project', 'x'],
    ['projects'], ['projects', 'list'], ['projects', 'bogus'],
  ]) w.same(args);
  const empty = newWorld('vacio');
  for (const args of [['context'], ['stats'], ['stats', '--all'], ['projects'], ['search', 'algo'], ['search', 'algo', '--all'], ['timeline', '1', '--all']]) empty.same(args);
});

test('delete: observaciones, prompts, sesiones y proyectos', { skip }, async () => {
  const w = newWorld('borrar');
  await seed(w);
  for (const args of [
    ['delete'], ['delete', 'x'], ['delete', '6', '--dry-run'], ['delete', '6', '--hard', '--hard'], ['delete', '6'], ['delete', '6'], ['delete', '5', '--hard'], ['delete', '5', '--hard'],
    ['delete', '999'], ['delete', 'session'], ['delete', 'session', '--help'], ['delete', 'session', '-h'], ['delete', 'session', 'sesion-1'], ['delete', 'session', 'nada'],
    ['delete', 'session', 'sesion-2', 'extra'], ['delete', 'prompt'], ['delete', 'prompt', 'x'], ['delete', 'prompt', '2'], ['delete', 'prompt', '2'], ['delete', 'prompt', '1', '--hard'],
    ['delete', 'project'], ['delete', 'project', '-h'], ['delete', 'project', 'nada'], ['delete', 'project', 'borrar', '--dry-run'],
    ['stats', '--all'], ['export', join(w.dir, 'after-delete.json')],
  ]) {
    const r = w.same(args);
    void r;
  }
  const w2 = newWorld('borrar2');
  await seed(w2);
  w2.same(['delete', 'project', 'borrar']);
  w2.same(['delete', 'project', 'borrar', '--hard']);
  w2.same(['stats', '--all']);
});

test('export e import', { skip }, async () => {
  const w = newWorld('respaldo');
  await seed(w);
  w.same(['export', '--help']);
  w.same(['import', '--help']);
  w.same(['export', 'x', '--help']);
  w.same(['import']);
  w.same(['import', join(w.dir, 'no-existe.json')]);
  const bad = join(w.dir, 'malo.json');
  writeFileSync(bad, '{ no es json');
  const badRun = w.run(['import', bad]);
  assert.equal(badRun.odin.status, badRun.ref.status);
  assert.match(badRun.odin.stderr, /^odin: parse .*malo\.json: /);
  /** Exporta con un archivo por lado y exige salida y contenido iguales. */
  const exportBoth = (world, name, extra = []) => {
    const { ref: refSide, odin: odinSide } = world.run({ ref: ['export', `${name}-ref.json`, ...extra], odin: ['export', `${name}-odin.json`, ...extra] });
    assert.equal(odinSide.status, refSide.status, name);
    const unname = (text) => mask(text, world).replace(new RegExp(`${name}-(ref|odin)`, 'g'), name);
    assert.equal(unname(odinSide.stdout), unname(refSide.stdout), `${name}: stdout`);
    assert.equal(unname(odinSide.stderr), unname(refSide.stderr), `${name}: stderr`);
    const read = (side) => (existsSync(join(world.repo, `${name}-${side}.json`)) ? readFileSync(join(world.repo, `${name}-${side}.json`), 'utf8') : null);
    const [a, b] = [read('odin'), read('ref')];
    assert.equal(a === null, b === null, `${name}: archivo`);
    if (a !== null) assert.equal(mask(a, world), mask(b, world), `${name}: contenido`);
    return b;
  };
  const exp = w.run(['export', '--all']);
  assert.equal(exp.odin.status, exp.ref.status);
  assert.equal(mask(exp.odin.stdout, w), mask(exp.ref.stdout, w));
  assert.ok(existsSync(join(w.repo, 'odin-export.json')) && existsSync(join(w.repo, 'engram-export.json')));
  assert.equal(mask(readFileSync(join(w.repo, 'odin-export.json'), 'utf8'), w), mask(readFileSync(join(w.repo, 'engram-export.json'), 'utf8'), w));
  assert.ok(exportBoth(w, 'todo', ['--all']).includes('"observations"'));
  assert.ok(exportBoth(w, 'proyecto', ['--project', 'respaldo']).includes('"sesion-1"'));
  exportBoth(w, 'ninguno', ['--project', 'no-existe']);
  w.same(['export', join(w.dir, 'q.json'), '--project']);
  w.same(['export', join(w.dir, 'directorio-inexistente', 'x.json'), '--all']);

  // Importar la copia de la referencia en dos almacenes limpios.
  const fresh = newWorld('respaldo-importado');
  const source = join(w.repo, 'engram-export.json');
  fresh.same(['import', source]);
  fresh.same(['import', source]);
  fresh.same(['stats', '--all']);
  exportBoth(fresh, 'reimportado', ['--all']);
  // Cruzado: la copia de odin entra igual en la referencia.
  const crossed = newWorld('respaldo-cruzado');
  crossed.same(['import', join(w.repo, 'odin-export.json')]);
  exportBoth(crossed, 'cruzado', ['--all']);
});

test('init: configuración de proyecto local', { skip }, () => {
  const w = newWorld('iniciar');
  w.same(['init', '--help']);
  w.same(['init', 'help']);
  w.same(['init', 'mi-proyecto']);
  assert.equal(readFileSync(join(w.repo, '.odin-memory', 'config.json'), 'utf8'), readFileSync(join(w.repo, '.engram', 'config.json'), 'utf8'));
  w.same(['init', 'otro']);
  w.same(['init', 'otro', '--force']);
  w.same(['init', '-f', 'tercero']);
  assert.equal(readFileSync(join(w.repo, '.odin-memory', 'config.json'), 'utf8'), readFileSync(join(w.repo, '.engram', 'config.json'), 'utf8'));
  w.same(['init', 'a/b', '--force']);
  w.same(['init', 'a\\b', '--force']);
  w.same(['init', '   ', '--force']);
  w.same(['init', 'tab\tname', '--force']);
  w.same(['init', 'uno', 'dos']);
  w.same(['init', '--bogus']);
  w.same(['init', '<html>&', '--force']);
  assert.equal(readFileSync(join(w.repo, '.odin-memory', 'config.json'), 'utf8'), readFileSync(join(w.repo, '.engram', 'config.json'), 'utf8'));
});

test('projects: fusionar, consolidar, podar y alias', { skip }, async () => {
  const w = newWorld('proyectos');
  await seed(w);
  // Variantes de nombre del mismo proyecto y proyectos vacíos, en ambas bases.
  for (const path of [join(w.refDir, 'engram.db'), join(w.odinDir, 'odin.db')]) {
    const db = new DatabaseSync(path, { timeout: 5000 });
    db.exec("UPDATE sessions SET project = 'Mi-Proyecto' WHERE id = 'sesion-2'");
    db.exec("UPDATE observations SET project = 'Mi-Proyecto' WHERE session_id = 'sesion-2'");
    db.exec("UPDATE user_prompts SET project = 'Mi-Proyecto' WHERE session_id = 'sesion-2'");
    db.exec("INSERT INTO sessions (id, project, directory, started_at) VALUES ('vacia-1', 'mi_proyecto', '/tmp/x', '2026-03-02 09:00:00'), ('vacia-2', 'ruta/vacia', '/tmp/y', '2026-03-02 09:00:00'), ('vacia-3', 'solo-vacio', '/tmp/z', '2026-03-02 09:00:00')");
    db.close();
  }
  for (const args of [
    ['projects'],
    ['projects', 'merge'], ['projects', 'merge', '--from', 'Mi-Proyecto'], ['projects', 'merge', '--from', 'Mi-Proyecto', '--to', 'mi-proyecto'],
    ['projects', 'merge', '--from', 'Mi-Proyecto', '--to', 'mi-proyecto', '--dry-run', '--apply'], ['projects', 'merge', '--from', 'a', '--from', 'b', '--dry-run'],
    ['projects', 'merge', '--from', 'Mi-Proyecto', '--to', 'mi-proyecto', '--dry-run'], ['projects', 'merge', '--from', 'otro', '--to', 'lectura', '--dry-run'],
    ['projects', 'merge', '--from', '--to', 'x', '--dry-run'], ['projects', 'merge', '--bogus'],
    ['projects', 'prune', '--dry-run'], ['projects', 'prune', '--dry-run', '--paths-only'],
    ['projects', 'consolidate', '--dry-run', '--all'],
    ['projects', 'alias'], ['projects', 'alias', '--help'], ['projects', 'alias', 'list'], ['projects', 'alias', 'bogus'],
    ['projects', 'alias', 'set', '--key', 'Viejo', '--project', 'nuevo'], ['projects', 'alias', 'set', '--cwd', '/tmp/alias', '--project', 'nuevo'],
    ['projects', 'alias', 'set', '--key', 'a'], ['projects', 'alias', 'set', '--project', 'x'], ['projects', 'alias', 'set', '--key', 'a', '--cwd', '/b', '--project', 'x'],
    ['projects', 'alias', 'set', '--key', 'a', '--key', 'b', '--project', 'x'], ['projects', 'alias', 'set', '--key', '--project', 'x'],
    ['projects', 'alias', 'list'], ['projects', 'alias', 'remove', '--key', 'viejo'], ['projects', 'alias', 'remove', '--key', 'viejo'], ['projects', 'alias', 'remove'],
    ['projects', 'alias', 'resolve', '--designation', 'Hola'], ['projects', 'alias', 'resolve', '--designation', 'a/b'], ['projects', 'alias', 'resolve'],
    ['projects', 'alias', 'resolve', '--cwd', '/tmp/alias'], ['projects', 'alias', 'resolve', '--designation', 'nuevo', '--cwd', '/tmp/alias'],
  ]) w.same(args);
  // Interactivos, con la respuesta por la entrada estándar.
  w.same(['projects', 'prune'], { input: 'none\n' });
  w.same(['projects', 'prune'], { input: '\n' });
  w.same(['projects', 'prune'], { input: '9\n' });
  w.same(['projects', 'prune', '--paths-only'], { input: 'all\n' });
  w.same(['projects', 'prune'], { input: '1\n' });
  w.same(['projects']);
  w.same(['projects', 'consolidate', '--all'], { input: 'skip\n' });
  w.same(['projects', 'consolidate', '--all'], { input: 'all\n' });
  w.same(['projects']);
  w.same(['stats', '--all']);
  // Una fusión explícita real.
  w.same(['projects', 'merge', '--from', 'Mi-Proyecto', '--to', 'mi-proyecto', '--apply']);
  w.same(['projects', 'merge', '--from', 'Mi-Proyecto', '--to', 'mi-proyecto', '--apply']);
  w.same(['projects']);
});

test('projects consolidate: proyecto actual con selección interactiva', { skip }, async () => {
  const w = newWorld('consol');
  await seed(w);
  for (const path of [join(w.refDir, 'engram.db'), join(w.odinDir, 'odin.db')]) {
    const db = new DatabaseSync(path, { timeout: 5000 });
    db.exec("UPDATE sessions SET project = 'Consol' WHERE id = 'sesion-2'");
    db.exec("UPDATE observations SET project = 'Consol' WHERE session_id = 'sesion-2'");
    db.exec("UPDATE user_prompts SET project = 'Consol' WHERE session_id = 'sesion-2'");
    db.close();
  }
  w.same(['projects', 'consolidate', '--dry-run'], { input: 'all\n' });
  w.same(['projects', 'consolidate', '--dry-run'], { input: '' });
  w.same(['projects', 'consolidate', '--dry-run'], { input: '\n' });
  w.same(['projects', 'consolidate', '--dry-run'], { input: '7\n' });
  w.same(['projects', 'consolidate'], { input: 'none\n' });
  w.same(['projects', 'consolidate'], { input: '' });
  w.same(['projects', 'consolidate'], { input: '7\n' });
  w.same(['projects', 'consolidate'], { input: '1\n' });
  w.same(['projects']);
  const other = newWorld('consol');
  other.same(['projects', 'consolidate'], { input: 'all\n' });
});

test('mcp: arranca por stdio con --tools y --project', { skip }, async () => {
  const w = newWorld('servidor');
  const ref = startMcpCommand(binary.bin, ['mcp', '--tools=agent', '--project', 'fijo'], { cwd: w.repo, dataDir: w.refDir, env: { ENGRAM_DATA_DIR: w.refDir, ENGRAM_NO_UPDATE_CHECK: '1' } });
  const odin = startMcpCommand(process.execPath, ['--no-warnings', ODIN_BIN, 'mcp', '--tools=agent', '--project', 'fijo'], { cwd: w.repo, dataDir: w.odinDir, env: { ODIN_DATA_DIR: w.odinDir } });
  closers.push(() => ref.close(), () => odin.close());
  const [refTools, odinTools] = await Promise.all([ref.listTools(), odin.listTools()]);
  assert.deepEqual(odinTools.map((t) => t.name), refTools.map((t) => t.name));
  const [a, b] = await Promise.all([ref.call('mem_current_project', {}), odin.call('mem_current_project', {})]);
  assert.equal(b.isError, a.isError);
  assert.equal(b.json.project, a.json.project);
  assert.equal(b.json.project, 'fijo');
  ref.close();
  odin.close();
  for (const bad of [['mcp', '--project'], ['mcp', '--project='], ['mcp', '--project', '  ']]) {
    const r = w.run(bad, { input: '' });
    assert.equal(r.odin.status, r.ref.status, bad.join(' '));
    assert.equal(mask(r.odin.stderr, w), mask(r.ref.stderr, w), bad.join(' '));
  }
});

/** Siembra relaciones pendientes: guardados con títulos parecidos en la misma sesión. */
async function seedConflicts(world) {
  const ref = startMcpCommand(binary.bin, ['mcp', '--tools=all'], { cwd: world.repo, dataDir: world.refDir, env: { ENGRAM_DATA_DIR: world.refDir, ENGRAM_NO_UPDATE_CHECK: '1' } });
  const odin = startMcpCommand(process.execPath, ['--no-warnings', ODIN_BIN, 'mcp', '--tools=all'], { cwd: world.repo, dataDir: world.odinDir, env: { ODIN_DATA_DIR: world.odinDir } });
  closers.push(() => ref.close(), () => odin.close());
  await Promise.all([ref.initialize(), odin.initialize()]);
  const both = async (tool, args) => {
    const [a, b] = await Promise.all([ref.call(tool, args), odin.call(tool, args)]);
    assert.equal(b.isError, a.isError, `${tool}: ${a.text} / ${b.text}`);
    return [a, b];
  };
  await both('mem_session_start', { id: 'sesion-1' });
  for (const [title, content] of [
    ['Usar Redis para la caché', 'decidimos Redis como caché distribuida'],
    ['Redis como caché distribuida', 'la caché distribuida vive en Redis'],
    ['Caché local en memoria', 'una caché local en memoria del proceso'],
    ['Autenticación con tokens', 'los tokens de acceso expiran en una hora'],
    ['Tokens de acceso', 'el acceso con tokens se renueva con refresh'],
  ]) await both('mem_save', { title, content, type: 'decision', session_id: 'sesion-1' });
  ref.close();
  odin.close();
  for (const path of [join(world.refDir, 'engram.db'), join(world.odinDir, 'odin.db')]) {
    const db = new DatabaseSync(path, { timeout: 5000 });
    db.exec("UPDATE memory_relations SET created_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes'), updated_at = created_at");
    db.close();
  }
}

test('conflicts: list, show, stats y uso', { skip }, async () => {
  const w = newWorld('conflictos');
  await seedConflicts(w);
  w.same(['conflicts']);
  w.same(['conflicts', 'nada']);
  w.same(['conflicts', 'list']);
  w.same(['conflicts', 'list', '--project', 'conflictos']);
  w.same(['conflicts', 'list', '--all']);
  w.same(['conflicts', 'list', '--status', 'pending', '--limit', '2']);
  w.same(['conflicts', 'list', '--status', 'judged']);
  w.same(['conflicts', 'list', '--since', '2026-03-01T10:00:02Z']);
  w.same(['conflicts', 'list', '--since', 'ayer']);
  w.same(['conflicts', 'list', '--since', '2026-03-01']);
  w.same(['conflicts', 'list', '--since', '2026-13-01T00:00:00Z']);
  w.same(['conflicts', 'list', '--since', '2026-03-01T10:00:00']);
  w.same(['conflicts', 'list', '--limit', '501']);
  w.same(['conflicts', 'list', '--limit', 'x']);
  w.same(['conflicts', 'list', '--project', 'nada']);
  w.same(['conflicts', 'show', '1']);
  w.same(['conflicts', 'show', ' 2 ']);
  w.same(['conflicts', 'show', '999']);
  w.same(['conflicts', 'show', 'abc']);
  w.same(['conflicts', 'show']);
  w.same(['conflicts', 'stats']);
  w.same(['conflicts', 'stats', '--all']);
  w.same(['conflicts', 'stats', '--project', 'nada']);
});

test('conflicts: scan, deferred y prune', { skip }, async () => {
  const w = newWorld('escaneo');
  await seedConflicts(w);
  w.same(['conflicts', 'scan']);
  w.same(['conflicts', 'scan', '--apply']);
  w.same(['conflicts', 'scan', '--apply']);
  w.same(['conflicts', 'scan', '--all', '--dry-run']);
  w.same(['conflicts', 'scan', '--limit', '2']);
  w.same(['conflicts', 'scan', '--limit', '2', '--cursor', '2']);
  w.same(['conflicts', 'scan', '--limit', '0']);
  w.same(['conflicts', 'scan', '--limit', '101']);
  w.same(['conflicts', 'scan', '--limit']);
  w.same(['conflicts', 'scan', '--cursor', '-1']);
  w.same(['conflicts', 'scan', '--cursor']);
  w.same(['conflicts', 'scan', '--dry-run', '--apply']);
  w.same(['conflicts', 'scan', '--concurrency', '0']);
  w.same(['conflicts', 'scan', '--concurrency', '21']);
  w.same(['conflicts', 'scan', '--since', 'ayer']);
  w.same(['conflicts', 'scan', '--since', '2030-01-01T00:00:00Z']);
  w.same(['conflicts', 'scan', '--apply', '--max-insert', '1']);
  w.same(['conflicts', 'scan', '--semantic'], { env: { ENGRAM_AGENT_CLI: '' } });
  w.same(['conflicts', 'scan', '--project', 'nada']);
  w.same(['conflicts', 'stats']);

  // Cola de diferidos sembrada en ambos almacenes.
  for (const path of [join(w.refDir, 'engram.db'), join(w.odinDir, 'odin.db')]) {
    const db = new DatabaseSync(path, { timeout: 5000 });
    const insert = db.prepare(`INSERT INTO sync_apply_deferred (sync_id, entity, payload, target_key, remote_seq, entity_key, op, reason_code, project, scope_class, apply_status, retry_count, last_error, first_seen_at)
      VALUES (?, ?, ?, 'cloud:escaneo', ?, ?, ?, ?, 'escaneo', 'scoped', ?, ?, ?, ?)`);
    insert.run('def-1', 'relation', '{"sync_id":"rel-1","kind":"x"}', 1, 'rel-1', 'upsert', 'fk_missing', 'deferred', 2, 'espera', '2026-03-01 10:00:01');
    insert.run('def-2', 'observation', 'no es json', 2, 'obs-1', 'upsert', 'bad', 'dead', 5, 'roto', '2025-01-01 00:00:00');
    insert.run('def-3', 'observation', '[1,2]', 3, 'obs-2', 'delete', 'bad', 'dead', 5, 'roto', '2025-01-02 00:00:00');
    insert.run('def-4', 'session', 'null', 4, 'ses-1', 'upsert', '', 'dead', 1, null, '2026-03-02 00:00:00');
    insert.run('def-5', 'relation', '{}', 5, 'rel-5', 'upsert', 'x', 'deferred', 0, null, '2026-03-03 00:00:00');
    db.close();
  }
  w.same(['conflicts', 'deferred']);
  w.same(['conflicts', 'deferred', '--status', 'dead']);
  w.same(['conflicts', 'deferred', '--limit', '2']);
  w.same(['conflicts', 'deferred', '--inspect', 'def-1']);
  w.same(['conflicts', 'deferred', '--inspect', 'def-2']);
  w.same(['conflicts', 'deferred', '--inspect', 'def-3']);
  w.same(['conflicts', 'deferred', '--inspect', 'def-4']);
  w.same(['conflicts', 'deferred', '--inspect', 'def-5']);
  w.same(['conflicts', 'deferred', '--inspect', 'nada']);
  w.same(['conflicts', 'deferred', '--inspect', 'def-1', '--replay']);
  w.same(['conflicts', 'stats']);
  w.same(['conflicts', 'prune']);
  w.same(['conflicts', 'prune', '--max-age-days', '3000', '--max-per-scope', '1']);
  w.same(['conflicts', 'prune', '--max-age-days', '0']);
  w.same(['conflicts', 'prune', '--max-per-scope', 'x']);
  w.same(['conflicts', 'prune', '--max-age-days']);
  w.same(['conflicts', 'prune', '--bogus']);
  w.same(['conflicts', 'prune', '--dry-run', '--apply']);
  w.same(['conflicts', 'prune', '--apply']);
  w.same(['conflicts', 'deferred']);
});

test('instance-id, compatibility y migrate-copy', { skip }, async () => {
  const w = newWorld('admin');
  await seed(w);
  const ids = w.run(['instance-id']);
  assert.equal(ids.ref.status, 0);
  assert.equal(ids.odin.status, 0);
  assert.match(ids.ref.stdout, /^[0-9a-f]{32}\n$/);
  assert.match(ids.odin.stdout, /^[0-9a-f]{32}\n$/);
  assert.equal(w.run(['instance-id']).odin.stdout, ids.odin.stdout, 'es estable');

  const both = (build, options) => w.same({ ref: build(w.refDir, 'out-ref'), odin: build(w.odinDir, 'out-odin') }, options);
  both((dir) => ['compatibility', '--data-dir', dir, '--json']);
  both((dir) => ['compatibility', '--data-dir', dir]);
  both(() => ['compatibility', '--json']);
  both((dir) => ['compatibility', '--data-dir', dir, '--json', '--json']);
  both((dir) => ['compatibility', '--data-dir', dir, '--data-dir', dir, '--json']);
  both((dir) => ['compatibility', '--data-dir', `${dir}/`, '--json']);
  both((dir) => ['compatibility', '--data-dir', `${dir}/nada`, '--json']);
  both(() => ['compatibility', '--data-dir', 'relativa', '--json']);
  const fresh = join(w.dir, 'vacio');
  mkdirSync(fresh);
  w.same(['compatibility', '--data-dir', fresh, '--json']);
  writeFileSync(join(fresh, 'x'), 'x');
  w.same(['compatibility', '--data-dir', fresh, '--json']);

  const migrate = (dir, out, ...extra) => ['migrate-copy', '--data-dir', dir, '--output-dir', join(w.dir, out), '--confirm-quiescent', '--json', ...extra];
  both((dir, out) => migrate(dir, out));
  both((dir, out) => migrate(dir, out));
  both((dir) => ['migrate-copy', '--data-dir', dir]);
  both((dir, out) => migrate(dir, out, '--json'));
  both((dir, out) => migrate(dir, out, '--bogus'));
  both((dir) => ['migrate-copy', '--data-dir', dir, '--output-dir', '--json', '--confirm-quiescent']);
  both((dir) => ['migrate-copy', '--data-dir', 'relativa', '--output-dir', join(w.dir, 'x'), '--confirm-quiescent', '--json']);
  both((dir) => ['migrate-copy', '--data-dir', dir, '--output-dir', join(dir, 'dentro'), '--confirm-quiescent', '--json']);
  both((dir, out) => ['migrate-copy', '--data-dir', join(w.dir, 'no-existe'), '--output-dir', join(w.dir, out, 'x'), '--confirm-quiescent', '--json']);
  w.same(['migrate-copy', '--help']);
  w.same(['migrate-copy']);
  // Lo copiado es un almacén utilizable con los mismos datos.
  const copied = [join(w.dir, 'out-ref', 'engram.db'), join(w.dir, 'out-odin', 'odin.db')].map((path) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare('SELECT count(*) AS n FROM observations').get().n;
    } finally {
      db.close();
    }
  });
  assert.equal(copied[0], copied[1]);
});
