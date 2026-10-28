// Contraste diferencial de la API HTTP: las mismas peticiones sobre la referencia y sobre odin
// devuelven el mismo estado, las mismas cabeceras relevantes y el mismo JSON (con la identidad
// renombrada y lo que varía por construcción —fechas, identificadores— enmascarado).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBinary } from './engram-mcp.mjs';

const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';
const ODIN_BIN = fileURLToPath(new URL('../../bin/odin.js', import.meta.url));

let base;
const children = [];

before(() => {
  if (!binary) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-http-')));
});
after(() => {
  for (const child of children) child.kill('SIGKILL');
  if (base) rmSync(base, { recursive: true, force: true });
  binary?.cleanup();
});

const MASKS = [
  [/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<T>'],
  [/(obs|rel|prompt|ses)-[0-9a-f]{16}/g, '$1-X'],
  [/[0-9a-f]{32}/g, '<INSTANCE>'],
  [/odin-memory/g, 'odin'],
  [/engram-export\.json/g, 'odin-export.json'],
  [/\.engram/g, '.odin-memory'],
  [/ENGRAM_/g, 'ODIN_'],
  [/engram\.db/g, 'odin.db'],
  [/Engram/g, 'Odin'],
  [/engram/g, 'odin'],
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** Aplica las máscaras a todas las cadenas de un valor JSON. */
function maskValue(value, world) {
  if (typeof value === 'string') {
    // Los mensajes del decodificador de la referencia citan el tipo Go: se comparan sin él.
    let out = value.replace(/Go struct field \S+ of type \S+/g, 'Go struct field').replace(/Go value of type .*$/g, 'Go value');
    for (const dir of [world.refDir, world.odinDir]) out = out.split(dir).join('<DATA>');
    out = out.split(world.repo).join('<REPO>');
    for (const [pattern, replacement] of MASKS) out = out.replace(pattern, replacement);
    return out;
  }
  // El rango de bm25 difiere en las últimas cifras entre compilaciones de SQLite.
  if (typeof value === 'number' && !Number.isInteger(value)) return Number(value.toPrecision(10));
  if (Array.isArray(value)) return value.map((v) => maskValue(v, world));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskValue(v, world)]));
  return value;
}

async function waitHealthy(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`el servidor terminó antes de estar listo: ${child.stderrText}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // aún no escucha
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('el servidor no respondió a tiempo');
}

function startServer(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderrText = '';
  child.stderr.on('data', (d) => {
    child.stderrText += d;
  });
  children.push(child);
  return child;
}

let counter = 0;

/** Un par de servidores (referencia y odin) con almacenes vacíos y un repositorio compartido. */
async function newWorld(name, { refEnv = {}, odinEnv = {} } = {}) {
  counter += 1;
  const dir = join(base, `${name}-${counter}`);
  mkdirSync(dir);
  const repo = join(dir, name);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const world = { dir, repo, refDir: join(dir, 'ref-data'), odinDir: join(dir, 'odin-data') };
  const [refPort, odinPort] = [await freePort(), await freePort()];
  const refChild = startServer(binary.bin, ['serve', String(refPort)], { ENGRAM_DATA_DIR: world.refDir, ENGRAM_NO_UPDATE_CHECK: '1', HOME: dir, ...refEnv }, repo);
  const odinChild = startServer(process.execPath, ['--no-warnings', ODIN_BIN, 'serve', String(odinPort)], { ODIN_DATA_DIR: world.odinDir, HOME: dir, ...odinEnv }, repo);
  await Promise.all([waitHealthy(refPort, refChild), waitHealthy(odinPort, odinChild)]);
  world.close = () => {
    refChild.kill('SIGKILL');
    odinChild.kill('SIGKILL');
  };

  const send = async (port, method, path, body, headers) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, text, json, response };
  };

  /** Envía la misma petición a ambos y exige igual estado y cuerpo; devuelve ambos resultados. */
  world.same = async (method, path, requestBody, { headers = {}, only = null, ignore = [], normalize } = {}) => {
    const bodyFor = (side) => (typeof requestBody === 'function' ? requestBody(side) : requestBody);
    const body = bodyFor('ref');
    const [ref, odin] = await Promise.all([send(refPort, method, path, bodyFor('ref'), headers), send(odinPort, method, path, bodyFor('odin'), headers)]);
    const label = `${method} ${path}${body === undefined ? '' : ` ${typeof body === 'string' ? body : JSON.stringify(body)}`}`;
    assert.equal(odin.status, ref.status, `${label}: estado\n--- ref ${ref.text}\n--- odin ${odin.text}`);
    for (const header of ['content-type', 'allow', 'www-authenticate', 'content-disposition', 'cache-control']) {
      assert.equal(
        maskValue(odin.response.headers.get(header) ?? '', world),
        maskValue(ref.response.headers.get(header) ?? '', world),
        `${label}: cabecera ${header}`,
      );
    }
    if (ref.json === undefined) {
      assert.equal(odin.text, ref.text, `${label}: cuerpo`);
    } else {
      const shape = (r) => {
        let value = maskValue(r.json, world);
        for (const key of ignore) if (value && typeof value === 'object') delete value[key];
        if (normalize) value = normalize(value);
        return only ? only(value) : value;
      };
      assert.deepStrictEqual(shape(odin), shape(ref), `${label}: JSON\n--- ref ${ref.text}\n--- odin ${odin.text}`);
    }
    return { ref, odin };
  };
  world.ports = { ref: refPort, odin: odinPort };
  return world;
}

/** Siembra los dos almacenes con el mismo contenido y devuelve los ids. */
async function seed(w) {
  await w.same('POST', '/sessions', { id: 's1', project: 'demo', directory: w.repo });
  await w.same('POST', '/sessions', { id: 's2', project: 'demo', directory: w.repo });
  const saves = [
    { type: 'decision', title: 'Decisión de caché', content: 'usamos Redis como caché distribuida', session_id: 's1' },
    { type: 'manual', title: 'Tema versionado', content: 'primera versión del tema', topic_key: 'notas/versionado', session_id: 's1' },
    { type: 'preference', title: 'Preferencia de formato', content: 'tabulaciones de dos espacios para todo', scope: 'personal', session_id: 's1' },
    { type: 'bugfix', title: 'Bug del login', content: 'el login falla con tokens expirados', session_id: 's1' },
    { type: 'manual', title: 'Nota suelta', content: 'otra nota de la segunda sesión sobre Redis', session_id: 's2' },
    { type: 'manual', title: 'Para borrar', content: 'se borrará luego', session_id: 's2' },
  ];
  for (const s of saves) await w.same('POST', '/observations', { ...s, project: 'demo' });
  await w.same('POST', '/prompts', { session_id: 's1', content: 'primer prompt', project: 'demo' });
  await w.same('POST', '/prompts', { session_id: 's2', content: 'segundo prompt', project: 'demo' });
}

test('salud, rutas desconocidas y métodos no permitidos', { skip }, async () => {
  const w = await newWorld('basico');
  try {
    const { odin } = await w.same('GET', '/health', undefined, { ignore: ['version', 'service'] });
    assert.equal(odin.json.service, 'odin-memory');
    await w.same('GET', '/no-existe');
    await w.same('POST', '/health');
    await w.same('PUT', '/observations');
    await w.same('DELETE', '/search');
    await w.same('GET', '/sessions//end');
    await w.same('PATCH', '/sessions');
  } finally {
    w.close();
  }
});

test('sesiones: registro, lectura, cierre y errores', { skip }, async () => {
  const w = await newWorld('sesiones');
  try {
    await w.same('POST', '/sessions', { id: 'a', project: 'demo', directory: w.repo });
    await w.same('POST', '/sessions', { id: 'a', project: 'demo', directory: w.repo });
    await w.same('POST', '/sessions', { id: 'a', project: 'otro', directory: w.repo });
    await w.same('POST', '/sessions', { id: 'b', project: 'demo' });
    await w.same('POST', '/sessions', { project: 'demo' });
    await w.same('POST', '/sessions', { id: 'c' });
    await w.same('POST', '/sessions', {}, {});
    await w.same('POST', '/sessions', 'esto no es json');
    await w.same('POST', '/sessions', '');
    await w.same('POST', '/sessions', { id: 'd', project: 'demo', ownership_mode: 'raro' });
    await w.same('POST', '/sessions', { id: 'e', project: 'demo', ownership_mode: 'project_owned' });
    await w.same('POST', '/sessions', { id: 'f', project: 'demo', isolated: true, ownership_mode: 'project_owned' });
    await w.same('POST', '/sessions', { id: 'g', project: 'demo', isolated: true });
    await w.same('POST', '/sessions', { id: 'h', project: 'demo', directory: w.repo, isolated: true, ownership_mode: 'project_owned' });
    await w.same('POST', '/sessions', { id: 'i', project: 'demo', project_provenance: { source: 'inventada' } });
    await w.same('POST', '/sessions', { id: 'j', project: 'demo', project_provenance: { source: 'explicit_override', raw_project: 'Demo' } });
    await w.same('GET', '/sessions/j');
    await w.same('GET', '/sessions/a');
    await w.same('GET', '/sessions/no-existe');
    await w.same('POST', '/sessions/a/end', { summary: 'listo' });
    await w.same('POST', '/sessions/a/end', '');
    await w.same('POST', '/sessions', { id: 'a', project: 'demo', directory: w.repo });
    await w.same('POST', '/sessions', { id: 'a', project: 'demo', directory: w.repo, resume: true });
    await w.same('GET', '/sessions/recent?project=demo');
    await w.same('GET', '/sessions/recent?project=demo&limit=1');
    await w.same('GET', '/sessions/recent?project=nada');
    await w.same('GET', '/sessions/recent?project=');
    await w.same('GET', '/sessions/recent?project=a&project=b');
    await w.same('GET', '/sessions/recent?all_projects=true');
    await w.same('GET', '/sessions/recent?all_projects=true&project=demo');
    await w.same('GET', '/sessions/recent?all_projects=quizá');
    await w.same('DELETE', '/sessions/b');
    await w.same('DELETE', '/sessions/b');
  } finally {
    w.close();
  }
});

test('observaciones: guardar, leer, actualizar, fijar, borrar y errores', { skip }, async () => {
  const w = await newWorld('observaciones');
  try {
    await seed(w);
    await w.same('GET', '/observations/1');
    await w.same('GET', '/observations/999');
    await w.same('GET', '/observations/abc');
    await w.same('GET', '/observations/2?include_history=true');
    await w.same('PATCH', '/observations/2?expected_project=demo', { content: 'segunda versión del tema' });
    await w.same('PATCH', '/observations/2?expected_project=demo', { content: 'tercera versión del tema' });
    await w.same('GET', '/observations/2?include_history=true');
    await w.same('GET', '/observations/2?include_history=true&history_cursor=1');
    await w.same('GET', '/observations/2?include_history=true&history_cursor=-1');
    await w.same('GET', '/observations/2?include_history=true&history_cursor=1.5');
    await w.same('GET', '/observations/2?include_history=true&history_cursor=x');
    await w.same('GET', '/observations/2?include_history=true&history_cursor=1e0');
    await w.same('GET', '/observations/2?include_history=true&history_cursor=null');
    await w.same('PATCH', '/observations/1?expected_project=demo', {});
    await w.same('PATCH', '/observations/1', { title: 'sin esperado' });
    await w.same('PATCH', '/observations/1?expected_project=otro', { title: 'proyecto equivocado' });
    await w.same('PATCH', '/observations/1?expected_project=demo', { title: 'Título nuevo', type: 'architecture', scope: 'project' });
    await w.same('PATCH', '/observations/1?expected_project=demo', { find: 'Redis', replace: 'Valkey' });
    await w.same('PATCH', '/observations/1?expected_project=demo', { find: 'Redis' });
    await w.same('PATCH', '/observations/1?expected_project=demo', { find: 'x', replace: 'y', content: 'z' });
    await w.same('PATCH', '/observations/1?expected_project=demo', { project: 'otro' });
    await w.same('PATCH', '/observations/1?expected_project=demo', { title: '   ' });
    await w.same('PATCH', '/observations/1?expected_project=demo', { title: 5 });
    await w.same('PATCH', '/observations/999?expected_project=demo', { title: 'x' });
    await w.same('PATCH', '/observations/abc?expected_project=demo', { title: 'x' });
    await w.same('PUT', '/observations/3/pin');
    await w.same('PUT', '/observations/999/pin');
    await w.same('PUT', '/observations/0/pin');
    await w.same('PUT', '/observations/abc/pin');
    await w.same('DELETE', '/observations/3/pin');
    await w.same('GET', '/observations?project=demo&limit=3');
    await w.same('GET', '/observations?project=demo&sort=created_at:desc');
    await w.same('GET', '/observations?project=demo&sort=otro');
    await w.same('GET', '/observations/recent?project=demo&scope=personal');
    await w.same('GET', '/observations/recent?project=demo&scope=project&limit=2');
    await w.same('DELETE', '/observations/6?expected_project=demo');
    await w.same('DELETE', '/observations/6?expected_project=demo');
    await w.same('DELETE', '/observations/5');
    await w.same('DELETE', '/observations/5?expected_project=otro');
    await w.same('DELETE', '/observations/5?expected_project=demo&hard=true');
    await w.same('DELETE', '/observations/abc?expected_project=demo');
    await w.same('GET', '/review?project=demo');
    await w.same('POST', '/review/mark_reviewed?project=demo', { observation_id: 1 });
    await w.same('POST', '/review/mark_reviewed?project=demo', { id: 1 });
    await w.same('POST', '/review/mark_reviewed?project=demo', {});
    await w.same('POST', '/review/mark_reviewed?project=demo', { observation_id: 999 });
    await w.same('POST', '/review/mark_reviewed?project=demo', 'x');
    await w.same('GET', '/review?project=nada');
    await w.same('POST', '/topic-keys/suggest', { type: 'decision', title: 'Auth model', content: 'JWT con refresh' });
    await w.same('POST', '/topic-keys/suggest', { title: '  ' });
    await w.same('POST', '/topic-keys/suggest', '{"title":"a"}{"title":"b"}');
    await w.same('POST', '/topic-keys/suggest', 'no json');
    await w.same('POST', '/topic-keys/suggest', '');
  } finally {
    w.close();
  }
});

test('guardado: validaciones, operaciones idempotentes y captura de prompts', { skip }, async () => {
  const w = await newWorld('guardado');
  try {
    await w.same('POST', '/sessions', { id: 's1', project: 'demo', directory: w.repo });
    await w.same('POST', '/observations', { session_id: 's1', title: 'Con operación', content: 'contenido', project: 'demo', operation_id: 'op-1' });
    await w.same('POST', '/observations', { session_id: 's1', title: 'Con operación', content: 'contenido', project: 'demo', operation_id: 'op-1' });
    await w.same('POST', '/observations', { session_id: 's1', title: 'Otra cosa', content: 'distinto', project: 'demo', operation_id: 'op-1' });
    await w.same('GET', '/observations/save-result?operation_id=op-1');
    await w.same('GET', '/observations/save-result?operation_id=op-2');
    await w.same('GET', '/observations/save-result');
    await w.same('POST', '/observations', { session_id: 's1', title: 'Con prompt', content: 'contenido del prompt', project: 'demo', current_prompt: 'qué hacemos con la caché' });
    await w.same('POST', '/observations', { session_id: 's1', title: 'Sin prompt', content: 'contenido sin prompt', project: 'demo', current_prompt: 'no me captures', capture_prompt: false });
    await w.same('GET', '/prompts/recent?project=demo');
    await w.same('POST', '/observations', { session_id: 's1', title: '', content: 'x', project: 'demo' });
    await w.same('POST', '/observations', { session_id: 's1', title: '   ', content: 'x', project: 'demo' });
    await w.same('POST', '/observations', { session_id: 's1', title: 'x', content: '', project: 'demo' });
    await w.same('POST', '/observations', { title: 'x', content: 'y' });
    await w.same('POST', '/observations', { session_id: 'nueva', title: 'x', content: 'y', project: 'demo' });
    await w.same('POST', '/observations', { session_id: 's1', title: 'x', content: 'y', project: 'otro' });
    await w.same('POST', '/observations', { session_id: 's1', title: 'x', content: 'y', project_provenance: { source: 'rara' } });
    await w.same('POST', '/observations', { session_id: 's1', title: 'Privado', content: 'público <private>secreto</private> fin', project: 'demo' });
    await w.same('GET', '/observations/recent?project=demo&limit=1');
    await w.same('POST', '/observations', { session_id: 's1', title: 'Enorme', content: 'x'.repeat(50_010), project: 'demo' });
    await w.same('GET', '/observations/recent?project=demo&limit=1', undefined, { normalize: (v) => v.map((o) => ({ ...o, content: o.content.length })) });
    await w.same('POST', '/observations', 'no json');
    await w.same('POST', '/observations', { session_id: 5, title: 'x', content: 'y' });
    await w.same('POST', '/observations/passive', { session_id: 's1', project: 'demo', content: '## Key Learnings:\n- aprendimos algo útil sobre la caché de Redis\n- otra cosa distinta para recordar' });
    await w.same('POST', '/observations/passive', { session_id: 's1', project: 'demo', content: '## Key Learnings:\n- aprendimos algo útil sobre la caché de Redis' });
    await w.same('POST', '/observations/passive', { project: 'demo', content: 'x' });
    await w.same('POST', '/observations/passive', { session_id: 'nueva', project: 'demo', content: 'x' });
    await w.same('POST', '/observations/passive', 'nada');
  } finally {
    w.close();
  }
});

test('búsqueda, línea de tiempo y prompts', { skip }, async () => {
  const w = await newWorld('busqueda');
  try {
    await seed(w);
    await w.same('GET', '/search?q=Redis&project=demo');
    await w.same('GET', '/search?q=Redis&project=demo&limit=1');
    await w.same('GET', '/search?q=Redis&project=demo&response_format=compact');
    await w.same('GET', '/search?q=nadaquebuscar&project=demo&response_format=compact');
    await w.same('GET', '/search?q=Redis&project=demo&response_format=largo');
    await w.same('GET', '/search?q=Redis+cach%C3%A9&project=demo&match_mode=any');
    await w.same('GET', '/search?q=Redis+cach%C3%A9&project=demo&match_mode=all');
    await w.same('GET', '/search?q=Redis&project=demo&match_mode=raro');
    await w.same('GET', '/search?q=Redis&project=demo&type=decision');
    await w.same('GET', '/search?q=formato&project=demo&scope=personal');
    await w.same('GET', '/search?q=notas/versionado&project=demo');
    await w.same('GET', '/search?project=demo');
    await w.same('GET', '/search?q=&project=demo');
    await w.same('GET', '/search?q=Redis&all_projects=true');
    await w.same('GET', '/search?q=Redis&project=nada');
    await w.same('GET', '/search?q=%22');
    await w.same('GET', '/prompts/search?q=prompt&project=demo');
    await w.same('GET', '/prompts/search?q=prompt&project=demo&limit=1');
    await w.same('GET', '/prompts/search?project=demo');
    await w.same('GET', '/prompts/recent?project=demo&limit=1');
    await w.same('GET', '/timeline?observation_id=2&project=demo');
    await w.same('GET', '/timeline?observation_id=2&project=demo&before=1&after=1');
    await w.same('GET', '/timeline?observation_id=2&project=otro');
    await w.same('GET', '/timeline?observation_id=999&project=demo');
    await w.same('GET', '/timeline?observation_id=abc&project=demo');
    await w.same('GET', '/timeline?project=demo');
    await w.same('POST', '/prompts', { session_id: 's1', content: 'tercer prompt' });
    await w.same('POST', '/prompts', { session_id: 's1', content: '' });
    await w.same('POST', '/prompts', { content: 'sin sesión' });
    await w.same('POST', '/prompts', { session_id: 'nueva', content: 'x', project: 'demo' });
    await w.same('POST', '/prompts', { session_id: 's1', content: 'x', project: 'otro' });
    await w.same('POST', '/prompts', { session_id: 's1', content: 'con bandeja', source_inbox_id: 'inbox-1' });
    await w.same('POST', '/prompts', { session_id: 's1', content: 'con bandeja', source_inbox_id: 'inbox-1' });
    await w.same('DELETE', '/prompts/1');
    await w.same('DELETE', '/prompts/1');
    await w.same('DELETE', '/prompts/abc');
  } finally {
    w.close();
  }
});

test('contexto, estadísticas, proyectos y proyecto actual', { skip }, async () => {
  const w = await newWorld('contexto');
  try {
    await seed(w);
    await w.same('PUT', '/observations/1/pin');
    await w.same('GET', '/context?project=demo');
    await w.same('GET', '/context?project=demo&compact=true');
    await w.same('GET', '/context?project=demo&observations=2&prompts=1&sessions=1&pinned=1');
    await w.same('GET', '/context?project=demo&observations=-1');
    await w.same('GET', '/context?project=demo&prompts=-1&sessions=-1');
    await w.same('GET', '/context?project=demo&older_history=true');
    await w.same('GET', '/context?project=demo&max_bytes=200');
    await w.same('GET', '/context?project=demo&max_bytes=+300');
    await w.same('GET', '/context?project=demo&max_bytes=99999999999999999999');
    await w.same('GET', '/context?project=demo&max_bytes=abc');
    await w.same('GET', '/context?project=demo&observations=99999');
    await w.same('GET', '/context?project=demo&scope=personal');
    await w.same('GET', '/context?project=nada');
    await w.same('GET', '/context?all_projects=true');
    await w.same('GET', '/context/compaction?session_id=s1');
    await w.same('GET', '/context/compaction?session_id=nada');
    await w.same('GET', '/context/compaction');
    await w.same('GET', '/stats?project=demo');
    await w.same('GET', '/stats?all_projects=true');
    await w.same('GET', '/stats?project=nada');
    await w.same('GET', '/stats?project=');
    await w.same('GET', '/projects');
    await w.same('GET', `/project/current?cwd=${encodeURIComponent(w.repo)}`);
    await w.same('GET', '/project/current?cwd=/no/existe/nada');
    await w.same('GET', '/sync/status?project=demo');
    await w.same('GET', '/sync/status?all_projects=true');
    await w.same('GET', '/sync/status?project=nada');
  } finally {
    w.close();
  }
});

test('exportar e importar entre servidores', { skip }, async () => {
  const w = await newWorld('respaldo');
  try {
    await seed(w);
    const { ref, odin } = await w.same('GET', '/export?project=demo', undefined, { ignore: ['exported_at'] });
    await w.same('GET', '/export?all_projects=true', undefined, { ignore: ['exported_at'] });
    await w.same('GET', '/export?project=nada');
    // El export de cada lado se importa en el otro: formato compatible.
    const crossed = await Promise.all([
      fetch(`http://127.0.0.1:${w.ports.odin}/import`, { method: 'POST', body: ref.text }).then(async (r) => [r.status, await r.json()]),
      fetch(`http://127.0.0.1:${w.ports.ref}/import`, { method: 'POST', body: odin.text }).then(async (r) => [r.status, await r.json()]),
    ]);
    assert.deepStrictEqual(crossed[0], crossed[1]);
    await w.same('POST', '/import', ref.text);
    await w.same('POST', '/import', 'no json');
    await w.same('POST', '/import', '');
    // Un tipo que no corresponde se rechaza en ambos; el texto del error cita tipos propios de cada implementación.
    const bad = '{"version":"0.2.0","sessions":"mal"}';
    const statuses = await Promise.all(Object.values(w.ports).map((port) => fetch(`http://127.0.0.1:${port}/import`, { method: 'POST', body: bad }).then((r) => r.status)));
    assert.deepStrictEqual(statuses, [400, 400]);
  } finally {
    w.close();
  }
});

test('flujos compuestos: finalizar, consolidar, juzgar y comparar', { skip }, async () => {
  const w = await newWorld('flujos');
  try {
    await seed(w);
    await w.same('POST', '/sessions/s2/finalize', { project: 'demo', summary: 'resumen de cierre' });
    await w.same('POST', '/sessions/s2/finalize', { project: 'demo', summary: 'resumen de cierre' });
    await w.same('POST', '/sessions/s2/finalize', { project: 'otro', summary: 'x' });
    await w.same('POST', '/sessions/nada/finalize', { project: 'demo', summary: 'x' });
    await w.same('POST', '/sessions/s1/finalize', { project: 'demo' });
    await w.same('POST', '/sessions/s1/finalize', { project: 'demo', summary: 'x', extra: 1 });
    await w.same('POST', '/sessions/s1/finalize', '[]');
    await w.same('POST', '/sessions/s1/finalize', '{"project":"demo","summary":"x"}{}');
    await w.same('POST', '/sessions/s1/finalize', 'no json');
    const plan = { ids_to_delete: [4, 5], new_title: 'Consolidado', new_content: 'contenido unido', expected_project: 'demo' };
    const preview = await w.same('POST', '/observations/consolidate', plan);
    await w.same('POST', '/observations/consolidate', { ...plan, ids_to_delete: [4] });
    await w.same('POST', '/observations/consolidate', { ...plan, ids_to_delete: [4, 4] });
    await w.same('POST', '/observations/consolidate', { ...plan, ids_to_delete: [4, 999] });
    await w.same('POST', '/observations/consolidate', { ...plan, expected_project: 'otro' });
    await w.same('POST', '/observations/consolidate', { ...plan, confirm: true });
    await w.same('POST', '/observations/consolidate', { ...plan, bogus: 1 });
    await w.same('POST', '/observations/consolidate', { ...plan, confirm: true, fingerprint: 'mala' });
    await w.same('POST', '/observations/consolidate', (side) => ({ ...plan, confirm: true, fingerprint: preview[side].json.plan.fingerprint }));

    const created = await w.same('POST', '/observations', { session_id: 's1', type: 'decision', title: 'Usar Redis para la caché', content: 'decisión sobre Redis', project: 'demo' });
    assert.equal(created.odin.status, 201);
    const rel = await w.same('GET', '/conflicts?project=demo');
    await w.same('GET', '/conflicts?project=demo&status=pending');
    await w.same('GET', '/conflicts?project=demo&since=2020-01-01T00:00:00Z');
    await w.same('GET', '/conflicts?project=demo&since=ayer');
    await w.same('GET', '/conflicts?project=demo&limit=1&offset=0');
    await w.same('GET', '/conflicts?project=nada');
    await w.same('GET', '/conflicts/1');
    await w.same('GET', '/conflicts/999');
    await w.same('GET', '/conflicts/abc');
    await w.same('POST', '/conflicts/judge', { judgment_id: 'rel-inexistente', relation: 'related' });
    await w.same('POST', '/conflicts/judge', { relation: 'related' });
    await w.same('POST', '/conflicts/judge', { judgment_id: 'x' });
    await w.same('POST', '/conflicts/judge', { judgment_id: 'x', relation: 'related', confidence: 2 });
    await w.same('POST', '/conflicts/judge-many', { judgments: [{ judgment_id: 'x', relation: 'related' }, { judgment_id: 5 }, 'mal', { judgment_id: 'y', relation: 'rara' }] });
    await w.same('POST', '/conflicts/judge-many', { judgments: [] });
    await w.same('POST', '/conflicts/judge-many', { judgments: [{}], session_id: 5 });
    await w.same('POST', '/conflicts/compare', { memory_id_a: 1, memory_id_b: 2, relation: 'related', confidence: 0.9, reasoning: 'parecidas', model: 'm' });
    await w.same('POST', '/conflicts/compare', { memory_id_a: 1, memory_id_b: 999, relation: 'related', confidence: 0.9, reasoning: 'x' });
    await w.same('POST', '/conflicts/compare', { memory_id_a: 1, memory_id_b: 2, relation: 'related', reasoning: 'x' });
    await w.same('POST', '/conflicts/compare', { memory_id_a: 1, memory_id_b: 2, relation: 'rara', confidence: 0.9, reasoning: 'x' });
    await w.same('POST', '/conflicts/compare', {});
    assert.ok(rel.ref.json.total >= 0);
  } finally {
    w.close();
  }
});

test('sesiones de runtime', { skip }, async () => {
  const w = await newWorld('runtime');
  try {
    await w.same('POST', '/sessions', { id: 'raiz', project: 'demo', directory: w.repo });
    const body = { id: 'raiz', project: 'demo', directory: w.repo };
    await w.same('POST', '/runtime-sessions/resolve', body);
    await w.same('POST', '/runtime-sessions/resolve', { ...body, id: 'nada' });
    await w.same('POST', '/runtime-sessions/resolve', { ...body, project: 'otro' });
    await w.same('POST', '/runtime-sessions/resolve', { ...body, directory: '/otro/directorio' });
    await w.same('POST', '/runtime-sessions/resolve', { ...body, ownership_mode: 'raro' });
    await w.same('POST', '/runtime-sessions/resolve', { ...body, extra: 1 });
    await w.same('POST', '/runtime-sessions/resolve', { id: 'raiz', project: 'demo' });
    await w.same('POST', '/runtime-sessions/resolve', '{"id":"raiz"}{}');
    await w.same('POST', '/runtime-sessions/end', { ...body, summary: 'fin' });
    await w.same('POST', '/runtime-sessions/end', body);
    await w.same('POST', '/runtime-sessions/resolve', body);
  } finally {
    w.close();
  }
});

test('autenticación con ODIN_HTTP_TOKEN', { skip }, async () => {
  const w = await newWorld('auth', { refEnv: { ENGRAM_HTTP_TOKEN: 'secreto' }, odinEnv: { ODIN_HTTP_TOKEN: 'secreto' } });
  try {
    await seed(w);
    const bearer = (token) => ({ Authorization: `Bearer ${token}` });
    await w.same('GET', '/health', undefined, { ignore: ['version', 'service'] });
    await w.same('GET', '/search?q=Redis&project=demo');
    for (const [method, path, body] of [
      ['GET', '/export?project=demo'], ['POST', '/import', '{}'], ['DELETE', '/sessions/s2'], ['DELETE', '/observations/6?expected_project=demo'],
      ['DELETE', '/prompts/1'], ['POST', '/observations/consolidate', {}], ['POST', '/conflicts/judge-many', {}], ['POST', '/sessions/s1/finalize', {}],
    ]) {
      await w.same(method, path, body);
      await w.same(method, path, body, { headers: bearer('equivocado') });
      await w.same(method, path, body, { headers: { Authorization: 'Basic abc' } });
      await w.same(method, path, body, { headers: bearer('secreto') });
    }
    await w.same('GET', '/export?project=demo', undefined, { headers: bearer('secreto'), ignore: ['exported_at'] });
  } finally {
    w.close();
  }
});

test('proyecto detectado por el directorio del servidor y casos sin tipo ni proyecto', { skip }, async () => {
  const w = await newWorld('detecta');
  try {
    // El proyecto del repositorio coincide con el de las sesiones: no hay transición.
    await w.same('POST', '/sessions', { id: 's1', project: 'detecta', directory: w.repo });
    await w.same('POST', '/observations', { session_id: 's1', title: 'Sin tipo ni proyecto', content: 'contenido de prueba sobre Redis' });
    await w.same('POST', '/observations', { session_id: 's1', type: 'decision', title: 'Con tipo', content: 'otra decisión sobre Redis' });
    await w.same('GET', '/observations/recent');
    await w.same('GET', '/observations/1');
    await w.same('GET', '/search?q=Redis');
    await w.same('GET', '/search?q=Redis&scope=personal');
    await w.same('GET', '/context');
    await w.same('GET', '/stats');
    await w.same('GET', '/sessions/recent');
    await w.same('GET', '/prompts/recent');
    await w.same('GET', '/review');
    await w.same('GET', '/timeline?observation_id=1');
    await w.same('GET', '/conflicts');
    await w.same('GET', '/sync/status');
    await w.same('GET', `/project/current?cwd=${encodeURIComponent(w.repo)}`);
    await w.same('GET', '/project/current');
    await w.same('POST', '/prompts/capture-decision', undefined);
    await w.same('PATCH', '/observations/1?expected_project=detecta', { topic_key: 'Notas/Redis', scope: 'personal' });
    await w.same('GET', '/observations/1');
    await w.same('POST', '/observations', { session_id: 's1', title: 'Mismo tema', content: 'actualiza el tema', topic_key: 'notas/redis', scope: 'personal' });
    await w.same('GET', '/observations/recent?scope=personal');
    await w.same('GET', '/context?scope=personal');
    await w.same('GET', `/search?q=notas%2Fredis`);
  } finally {
    w.close();
  }
});

/** Arranca `serve --session-owned` y devuelve la línea de disponibilidad y el hijo. */
async function startOwned(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const deadline = Date.now() + 20_000;
  while (!out.includes('\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return { child, line: out.split('\n')[0], exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
}

test('serve --session-owned: línea de disponibilidad, autenticación total y parada al cerrar la entrada', { skip }, async () => {
  counter += 1;
  const dir = join(base, `owned-${counter}`);
  mkdirSync(dir);
  const token = 'ab'.repeat(32);
  const ref = await startOwned(binary.bin, ['serve', '--session-owned'], { ENGRAM_DATA_DIR: join(dir, 'ref'), ENGRAM_TOKEN: token, ENGRAM_NO_UPDATE_CHECK: '1', HOME: dir }, dir);
  const odin = await startOwned(process.execPath, ['--no-warnings', ODIN_BIN, 'serve', '--session-owned'], { ODIN_DATA_DIR: join(dir, 'odin'), ODIN_TOKEN: token, HOME: dir }, dir);
  const [r, o] = [JSON.parse(ref.line), JSON.parse(odin.line)];
  assert.deepEqual(Object.keys(o), Object.keys(r));
  assert.equal(r.protocol, 'engram-session-owned-v1');
  assert.equal(o.protocol, 'odin-session-owned-v1');
  for (const record of [r, o]) {
    assert.match(record.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(record.instance_id, /^[0-9a-f]{32}$/);
    assert.equal(typeof record.pid, 'number');
  }
  for (const [record, label] of [[r, 'ref'], [o, 'odin']]) {
    const anonymous = await fetch(`${record.endpoint}/health`);
    assert.equal(anonymous.status, 401, label);
    assert.equal(anonymous.headers.get('www-authenticate')?.replace(/engram|odin-memory/, 'x'), 'Bearer realm="x"', label);
    assert.deepEqual(await anonymous.json(), { error: 'authorization required' }, label);
    assert.equal((await fetch(`${record.endpoint}/health`, { headers: { Authorization: `Bearer ${token}` } })).status, 200, label);
    assert.equal((await fetch(`${record.endpoint}/nada`)).status, 401, label);
  }
  ref.child.stdin.end();
  odin.child.stdin.end();
  assert.equal(await ref.exited, 0);
  assert.equal(await odin.exited, 0);
});

test('serve --session-owned rechaza configuraciones inválidas igual que la referencia', { skip }, async () => {
  counter += 1;
  const dir = join(base, `owned-bad-${counter}`);
  mkdirSync(dir);
  const run = (command, args, env) => spawnSync(command, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir, ...env } });
  const cases = [
    [['serve', '--session-owned'], {}],
    [['serve', '--session-owned'], { TOKEN: 'corto' }],
    [['serve', '--session-owned', '9000'], { TOKEN: 'ab'.repeat(32) }],
    [['serve', '--session-owned'], { TOKEN: 'ab'.repeat(32), PORT: '9000' }],
    [['serve', '--session-owned'], { TOKEN: 'ab'.repeat(32), URL: 'http://x' }],
    [['serve', '--session-owned'], { TOKEN: 'ab'.repeat(32), SOCKET: '' }],
    [['serve', 'bogus'], {}],
    [['serve', '--socket'], {}],
    [['serve', '--socket', '/tmp/x.sock', '9000'], {}],
  ];
  for (const [args, vars] of cases) {
    const refEnv = Object.fromEntries(Object.entries(vars).map(([k, v]) => [`ENGRAM_${k}`, v]));
    const odinEnv = Object.fromEntries(Object.entries(vars).map(([k, v]) => [`ODIN_${k}`, v]));
    const ref = run(binary.bin, args, { ENGRAM_DATA_DIR: join(dir, 'ref'), ENGRAM_NO_UPDATE_CHECK: '1', ...refEnv });
    const odin = run(process.execPath, ['--no-warnings', ODIN_BIN, ...args], { ODIN_DATA_DIR: join(dir, 'odin'), ...odinEnv });
    const mask = (text) => text.replace(/ENGRAM_/g, 'ODIN_').replace(/engram/g, 'odin');
    assert.equal(odin.status, ref.status, args.join(' '));
    assert.equal(mask(odin.stderr), mask(ref.stderr), args.join(' '));
  }
});

test('conflictos: estadísticas, escaneo, diferidos y compatibilidad', { skip }, async () => {
  const w = await newWorld('conflictos');
  try {
    await w.same('POST', '/sessions', { id: 's1', project: 'demo', directory: w.repo });
    for (const [title, content] of [
      ['Usar Redis para la caché', 'decidimos Redis como caché distribuida'],
      ['Redis como caché distribuida', 'la caché distribuida vive en Redis'],
      ['Caché local en memoria', 'una caché local en memoria del proceso'],
      ['Tokens de acceso', 'el acceso con tokens se renueva con refresh'],
    ]) await w.same('POST', '/observations', { session_id: 's1', type: 'decision', title, content, project: 'demo' });
    await w.same('GET', '/conflicts/stats?project=demo');
    await w.same('POST', '/conflicts/scan?cwd=' + encodeURIComponent(w.repo), { project: 'demo' });
    await w.same('POST', '/conflicts/scan', { project: 'demo', apply: true });
    await w.same('POST', '/conflicts/scan', { project: 'demo', apply: true });
    await w.same('POST', '/conflicts/scan', { all_projects: true });
    await w.same('POST', '/conflicts/scan', { project: 'demo', limit: 2 });
    await w.same('POST', '/conflicts/scan', { project: 'demo', limit: 2, cursor: 2, apply: true, max_insert: 1 });
    await w.same('POST', '/conflicts/scan', { project: 'demo', limit: 0 });
    await w.same('POST', '/conflicts/scan', { project: 'demo', limit: 101 });
    await w.same('POST', '/conflicts/scan', { project: 'demo', cursor: -1 });
    await w.same('POST', '/conflicts/scan', { project: 'demo', since: 'ayer' });
    await w.same('POST', '/conflicts/scan', { project: 'demo', since: '2030-01-01T00:00:00Z' });
    await w.same('POST', '/conflicts/scan', { project: 'demo', all_projects: true });
    await w.same('POST', '/conflicts/scan', { project: 'nada' });
    await w.same('POST', '/conflicts/scan', { project: 'demo', semantic: true, concurrency: 0 });
    await w.same('POST', '/conflicts/scan', { project: 'demo', semantic: true, timeout_per_call_seconds: 601 });
    await w.same('POST', '/conflicts/scan', 'no json');
    await w.same('GET', '/conflicts/stats?project=demo');
    await w.same('GET', '/conflicts/stats');
    await w.same('GET', '/conflicts/stats?project=nada');
    // El escaneo semántico sin ejecutor configurado falla igual en estado; el texto nombra herramientas propias.
    const semantic = await Promise.all(Object.values(w.ports).map((port) => fetch(`http://127.0.0.1:${port}/conflicts/scan`, { method: 'POST', body: JSON.stringify({ project: 'demo', semantic: true }) }).then((r) => r.status)));
    assert.deepStrictEqual(semantic, [500, 500]);

    for (const path of [join(w.refDir, 'engram.db'), join(w.odinDir, 'odin.db')]) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path, { timeout: 5000 });
      const insert = db.prepare(`INSERT INTO sync_apply_deferred (sync_id, entity, payload, target_key, remote_seq, entity_key, op, reason_code, project, scope_class, apply_status, retry_count, last_error, first_seen_at)
        VALUES (?, ?, ?, 'cloud:demo', ?, ?, ?, ?, 'demo', 'scoped', ?, ?, ?, ?)`);
      insert.run('def-1', 'relation', '{"sync_id":"rel-1","kind":"x"}', 1, 'rel-1', 'upsert', 'fk_missing', 'deferred', 2, 'espera', '2026-03-01 10:00:01');
      insert.run('def-2', 'observation', 'no es json', 2, 'obs-1', 'upsert', 'bad', 'dead', 5, 'roto', '2025-01-01 00:00:00');
      insert.run('def-3', 'session', 'null', 4, 'ses-1', 'upsert', '', 'dead', 1, null, '2026-03-02 00:00:00');
      db.close();
    }
    await w.same('GET', '/conflicts/deferred');
    await w.same('GET', '/conflicts/deferred?status=dead');
    await w.same('GET', '/conflicts/deferred?limit=1&offset=1');
    await w.same('GET', '/conflicts/deferred?limit=9999');
    await w.same('GET', '/conflicts/stats?project=demo');

    const compatibility = await w.same('GET', '/compatibility', undefined, { ignore: ['runtime_id', 'instance_id'] });
    assert.equal(compatibility.odin.json.status, 'ready');
    assert.equal(compatibility.odin.response.headers.get('cache-control'), 'no-store');
  } finally {
    w.close();
  }
});

test('compatibilidad con ODIN_HTTP_TOKEN', { skip }, async () => {
  const w = await newWorld('compat-auth', { refEnv: { ENGRAM_HTTP_TOKEN: 's' }, odinEnv: { ODIN_HTTP_TOKEN: 's' } });
  try {
    await w.same('GET', '/compatibility');
    await w.same('GET', '/compatibility', undefined, { headers: { Authorization: 'Bearer s' }, ignore: ['runtime_id', 'instance_id'] });
  } finally {
    w.close();
  }
});

test('rescate de propiedad y reintento de diferidos por HTTP', { skip }, async () => {
  const w = await newWorld('rescate-http', { refEnv: { ENGRAM_HTTP_TOKEN: 's' }, odinEnv: { ODIN_HTTP_TOKEN: 's' } });
  try {
    const bearer = { Authorization: 'Bearer s' };
    await w.same('POST', '/sessions', { id: 's1', project: 'demo', directory: w.repo });
    await w.same('POST', '/observations', { session_id: 's1', title: 'Una', content: 'contenido uno', project: 'demo' }, {});
    await w.same('POST', '/observations', { session_id: 's1', title: 'Dos', content: 'contenido dos', project: 'demo' }, {});
    const { DatabaseSync } = await import('node:sqlite');
    for (const path of [join(w.refDir, 'engram.db'), join(w.odinDir, 'odin.db')]) {
      const db = new DatabaseSync(path, { timeout: 5000 });
      db.exec("UPDATE observations SET project = NULL WHERE id = 2");
      db.exec("UPDATE sessions SET project = ''");
      db.close();
    }
    const body = { target_project: 'demo', confirmed: true, observation_ids: [2], session_ids: ['s1'] };
    await w.same('POST', '/projects/rescue-ownership', body);
    await w.same('POST', '/projects/rescue-ownership', body, { headers: { Authorization: 'Bearer x' } });
    await w.same('POST', '/projects/rescue-ownership', { ...body, confirmed: false }, { headers: bearer });
    await w.same('POST', '/projects/rescue-ownership', { ...body, target_project: ' ' }, { headers: bearer });
    await w.same('POST', '/projects/rescue-ownership', { target_project: 'demo', confirmed: true }, { headers: bearer });
    await w.same('POST', '/projects/rescue-ownership', { ...body, observation_ids: [0] }, { headers: bearer });
    await w.same('POST', '/projects/rescue-ownership', 'no json', { headers: bearer });
    await w.same('POST', '/projects/rescue-ownership', { ...body, observation_ids: [999], session_ids: [] }, { headers: bearer });
    await w.same('POST', '/projects/rescue-ownership', { target_project: 'otro', confirmed: true, observation_ids: [1] }, { headers: bearer });
    await w.same('POST', '/projects/rescue-ownership', body, { headers: bearer });
    await w.same('POST', '/projects/migrate', body, { headers: bearer });
    await w.same('POST', '/projects/migrate', body);
    await w.same('GET', '/projects/migrate');
    await w.same('POST', '/projects/rescue-ownership', 'x'.repeat(9000), { headers: bearer });

    await w.same('POST', '/conflicts/deferred/replay', {});
    for (const path of [join(w.refDir, 'engram.db'), join(w.odinDir, 'odin.db')]) {
      const db = new DatabaseSync(path, { timeout: 5000 });
      db.exec(`INSERT INTO sync_apply_deferred (sync_id, entity, payload, target_key, entity_key, op, project, scope_class, apply_status)
        VALUES ('rel-0000000000000001', 'relation', '{"sync_id":"rel-0000000000000001","source_id":"obs-a","target_id":"obs-b","relation":"related","judgment_status":"judged","project":"demo"}', 'local', 'rel-0000000000000001', 'upsert', 'demo', 'scoped', 'deferred')`);
      db.close();
    }
    await w.same('POST', '/conflicts/deferred/replay', {});
    await w.same('POST', '/conflicts/deferred/replay', {});
    await w.same('GET', '/conflicts/deferred');
    await w.same('GET', '/conflicts/stats?project=demo');
  } finally {
    w.close();
  }
});

test('doctor y vínculo del llamador por HTTP', { skip }, async () => {
  const w = await newWorld('doctor-http');
  try {
    await seed(w);
    const wal = (value) => JSON.parse(JSON.stringify(value).replace(/"checkpoint_(log|busy)":\d+/g, '"checkpoint_$1":0').replace(/"checkpointed_frames":\d+/g, '"checkpointed_frames":0'));
    await w.same('GET', '/doctor', undefined, { normalize: wal });
    await w.same('GET', '/doctor?project=demo', undefined, { normalize: wal });
    await w.same('GET', '/doctor?project=nada');
    await w.same('GET', '/doctor?project=%20');
    await w.same('GET', '/doctor?check=unowned_session_project');
    await w.same('GET', '/doctor?check=nada');
    await w.same('GET', '/doctor?all_projects=true&check=unowned_session_project');
    await w.same('POST', '/doctor');
    const ok = { project: 'demo', runtime_session_id: 's1', effective_session_id: 's1', host_context: { append_entry_available: true, branch_available: true } };
    await w.same('POST', '/doctor/caller-binding', ok);
    await w.same('POST', '/doctor/caller-binding', { ...ok, runtime_session_id: 'nada', effective_session_id: 'nada' });
    await w.same('POST', '/doctor/caller-binding', { ...ok, effective_session_id: 's1:resume:2' });
    await w.same('POST', '/doctor/caller-binding', { ...ok, effective_session_id: 's1:resume:1' });
    await w.same('POST', '/doctor/caller-binding', { ...ok, project: 'otro' });
    await w.same('POST', '/doctor/caller-binding', { ...ok, host_context: { append_entry_available: true, branch_available: null } });
    await w.same('POST', '/doctor/caller-binding', { ...ok, host_context: undefined });
    await w.same('POST', '/doctor/caller-binding', { project: 'demo' });
    await w.same('POST', '/doctor/caller-binding', {});
    for (const bad of ['', 'no json', 'null', '[]', '{"extra":1}', '{"project":1}', '{"host_context":{"x":1}}', '{"host_context":5}', '{}{}', '{} x', '{"Project":"demo","RUNTIME_SESSION_ID":"s1","effective_session_id":"s1"}']) {
      await w.same('POST', '/doctor/caller-binding', bad);
    }
    await w.same('GET', '/doctor/caller-binding');
    const { ref, odin } = await w.same('GET', '/runtime-contract', undefined, { ignore: ['instance_id', 'contract_id', 'status', 'digest'] });
    assert.deepEqual(odin.json.operations.mem_doctor, ref.json.operations.mem_doctor);
  } finally {
    w.close();
  }
});
